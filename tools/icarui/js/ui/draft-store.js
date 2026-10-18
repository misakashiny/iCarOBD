/* ==========================================================================
   js/ui/draft-store.js —— 自动恢复草稿存储（P4R-1）
   ==========================================================================

   ## 这个模块解决什么问题

   P4R-0 审计确认：**设计没有自动保存，刷新/关闭/崩溃后全部丢失**。
   唯一持久化路径是手动 `saveFile()` → 浏览器下载 `.json`。

   本模块提供一条**独立于手动保存**的草稿通道：
   - 手动保存：保持原样（`saveFile()` 下载文件）
   - 自动草稿：IndexedDB 里留一份"未保存的改动"

   ## 为什么用 IndexedDB 而不是 localStorage

   | 项 | localStorage | IndexedDB |
   |---|---|---|
   | 容量 | 约 5 MB | **约 10.7 GB**（实测 quota）|
   | 写入 | **同步阻塞**（P4P-1B 实测 10.2ms）| **异步** |
   | 事务 | 无 | **有原子事务** |

   设计里内嵌了 base64 图片，5 张素材就是 518 KB（P4R-0 实测），localStorage 完全不够。

   ## ⚠️ 为什么必须保存完整 asset.data（不能只存 path）

   P4R-0 曾建议"草稿剥离 data 只存 path"。**P4R-1 实测证明这是错的**：

   | 素材来源 | 刷新后 path 还有效吗 |
   |---|---|
   | 内置图片 `assets/xx.png` | ✅ 有效 |
   | **用户拖入的图片** | ❌ **失效**（见下）|

   用户拖入图片时若用的是 `URL.createObjectURL()`，得到的是 `blob:null/xxxx`。
   **实测：刷新后 `fetch(blobUrl)` 直接 `Failed to fetch`** —— 这个 URL 只活在
   创建它的那个文档里。除非我们同时存下 `data`（dataURL），否则图片**永久丢失**。

   所以本模块**完整保存 `design.assets`（含 `data`）**。
   任务第二部分明确要求："如果图片只有 asset.data 可以恢复，则必须把它保存到 IndexedDB。"

   ## 数据结构

   ```
   数据库  icar-studio-drafts      （版本 1）
   ├── store "drafts"   keyPath: "draftId"
   │     {
   │       draftId,          // 内部草稿 ID
   │       designId,          // 内部设计身份（≠ design.name）
   │       designName,        // 仅用于显示
   │       savedAt,           // 最后编辑时间（ms）
   │       schemaVersion,     // 草稿格式版本
   │       designJson,        // 完整设计（JSON 字符串，含 assets.data）
   │       selection,         // 当前选择（可选）
   │       nodeCount,         // 显示用
   │       assetCount,        // 显示用
   │       byteSize,          // 显示用
   │       checksum,          // designJson 的简单校验和
   │       complete,          // ★ 完成标记：false = 未提交完（不可恢复）
   │     }
   └── store "meta"     keyPath: "key"
         { key: "lastDesignId", value }   // 当前会话的设计身份
   ```

   ## 原子性

   单条 `put` 就是一次原子事务 —— 要么整条写进去，要么完全没写。
   另外还有 `complete` 标记双保险：只有 `complete === true` 的记录才算"可恢复"。

   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("draft-store.js 必须在 core/namespace.js 之后加载");

  const DB_NAME = "icar-studio-drafts";
  // P4R-2A：新增 tombstones object store，需要触发一次 IndexedDB schema upgrade。
  const DB_VERSION = 2;
  /** 草稿格式版本。改结构时 +1，旧草稿仍可按旧版本读取 */
  const DRAFT_SCHEMA_VERSION = 1;
  const STORE = "drafts";
  /**
   * 持久化删除墓碑（P4R-2A）。
   *
   * ## 为什么需要持久化
   *
   * P4R-1.1/1.2 用的是**内存**墓碑（60 秒 TTL）。P4R-2A 关卡 A 实测：
   *
   *   A 删除草稿 → 墓碑生效（立刻写入被拒）✅
   *   B 等待 65 秒（墓碑过期）→ B 保存 → **草稿复活**（rev=100）❌
   *
   * 也就是「已删除的草稿会在 60 秒后被另一个标签页复活」。
   * 任务第八部分明确：**不能只靠增加内存 TTL**，必须持久化。
   *
   * ## 怎么存
   *
   * 与草稿同一个数据库、同一个版本，**增加一个 object store**。
   * 升级逻辑是 `if (!contains) createObjectStore`，所以旧库能平滑加上。
   *
   * ## 生命周期
   *
   * 墓碑**永久有效**（不设 TTL）—— 删除就是删除。
   * 只有用户显式"恢复/重新新建"同一身份时才清除。
   */
  const TOMB_STORE = "tombstones";
  const META = "meta";

  /**
   * 本编辑会话 ID（P4R-1.2）。
   *
   * 每个标签页/每次页面加载生成一个，用来识别"这次写入来自哪个会话"。
   * 它不参与冲突判定（判定靠 lastKnownRevision），只用于诊断与提示。
   */
  const SESSION_ID = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** 运行时状态（供 getStatus 与 UI 显示） */
  const state = {
    available: null,        // null = 未探测；true/false
    lastError: null,        // 最近一次失败原因
    lastWriteAt: 0,
    lastWriteBytes: 0,
    writes: 0,
    failures: 0,
    openDb: null,
    openPromise: null,
    conflicts: 0,
    sessionId: SESSION_ID,
  };


  /** 简单校验和（不是加密哈希，只用来发现截断/篡改） */
  function checksumOf(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16);
  }

  /**
   * 打开数据库（幂等，可并发调用）。
   * @returns {Promise<IDBDatabase|null>} 不可用时返回 null（**不抛异常**）
   */
  function open() {
    if (state.openDb) return Promise.resolve(state.openDb);
    if (state.openPromise) return state.openPromise;

    state.openPromise = new Promise(function (resolve) {
      // IndexedDB 在某些环境（隐私模式 / file:// 的旧内核 / 被策略禁用）
      // 可能整个不存在。**不能因此让编辑器起不来** —— 降级为 null。
      if (typeof indexedDB === "undefined" || !indexedDB) {
        state.available = false;
        state.lastError = "IndexedDB 不可用";
        resolve(null);
        return;
      }
      let settled = false;
      const settle = function (v) {
        if (settled) return;
        settled = true;
        state.openPromise = null;
        resolve(v);
      };

      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        state.available = false;
        state.lastError = (e && e.name) + ": " + (e && e.message);
        settle(null);
        return;
      }

      // 超时保护：某些环境 open 永不回调（实测过别的数据库会这样）
      const timer = setTimeout(function () {
        state.available = false;
        state.lastError = "IndexedDB 打开超时";
        settle(null);
      }, 6000);

      req.onupgradeneeded = function (ev) {
        const db = ev.target.result;
        try {
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: "draftId" });
          }
          if (!db.objectStoreNames.contains(META)) {
            db.createObjectStore(META, { keyPath: "key" });
          }
          // P4R-2A：持久化删除墓碑
          if (!db.objectStoreNames.contains(TOMB_STORE)) {
            db.createObjectStore(TOMB_STORE, { keyPath: "draftId" });
          }
        } catch (e) { /* 已存在 */ }
      };
      req.onsuccess = function (ev) {
        clearTimeout(timer);
        state.available = true;
        state.lastError = null;
        state.openDb = ev.target.result;
        // 连接被其它标签页升级版本时关闭，避免阻塞
        state.openDb.onversionchange = function () {
          try { state.openDb.close(); } catch (e) {}
          state.openDb = null;
        };
        settle(state.openDb);
      };
      req.onerror = function (ev) {
        clearTimeout(timer);
        state.available = false;
        state.lastError = (ev.target.error && ev.target.error.name) || "open error";
        settle(null);
      };
      req.onblocked = function () {
        clearTimeout(timer);
        state.available = false;
        state.lastError = "IndexedDB 被其它标签页阻塞";
        settle(null);
      };
    });
    return state.openPromise;
  }

  /** 判断一条草稿记录是否结构完好 */
  function draftProblem(rec) {
    if (!rec || typeof rec !== "object") return "不是对象";
    if (!rec.draftId) return "缺少 draftId";
    if (!rec.designId) return "缺少 designId";
    // ★ 完成标记：**未完成的记录绝不当作可恢复**
    if (rec.complete !== true) return "未完成写入";
    if (typeof rec.designJson !== "string" || !rec.designJson) return "缺少设计主体";
    if (rec.checksum && checksumOf(rec.designJson) !== rec.checksum) return "校验和不符（数据被截断或损坏）";
    let d = null;
    try { d = JSON.parse(rec.designJson); } catch (e) { return "设计主体不是合法 JSON"; }
    if (!d || typeof d !== "object" || Array.isArray(d)) return "设计主体不是对象";
    if (!Array.isArray(d.nodes)) return "设计缺少 nodes 数组";
    if (d.pages != null && !Array.isArray(d.pages)) return "设计 pages 不是数组";
    return null;
  }

  /**
   * 保存一份草稿（单事务原子写入）。
   *
   * @param {object} payload
   *   { designId, designName, design (对象), selection, manualSavedAt }
   * @returns {Promise<{ok:boolean, reason?:string, bytes?:number}>}
   */
  function saveDraft(payload) {
    return open().then(function (db) {
      if (!db) return { ok: false, reason: "unavailable" };
      const p = payload || {};
      if (!p.design || !p.designId) return { ok: false, reason: "bad-payload" };

      let designJson;
      try {
        designJson = JSON.stringify(p.design);
      } catch (e) {
        state.failures++;
        state.lastError = "序列化失败: " + e.message;
        return { ok: false, reason: "serialize" };
      }

      const draftId = "draft_" + p.designId;
      // ⚠️ 已删除的草稿不允许被复活（P4R-1.1 内存墓碑 → P4R-2A 持久墓碑）
      //
      // P4R-2A 实测：只用内存墓碑（60s TTL）时，另一个标签页在 65 秒后写入
      // **仍能把已删除的草稿复活**。现在墓碑同时持久化到 IndexedDB，
      // 且检查发生在**同一个写事务之前**（下面还有一道事务内检查）。
      if (isTombstoned(draftId)) {
        return { ok: false, reason: "tombstoned" };
      }

      // ============================================ P4R-1.2 乐观并发控制
      //
      // ## 为什么光有"单调 revision 比较"不够
      //
      // 旧逻辑：`库里 revision > 本次 revision` 就放弃写入。
      // 这只能防"旧盖新"，**防不住两个标签页各自 ++ 到同一个数字**：
      //
      //   标签页 A：见到 rev=5 → 生成 rev=6 → 写入
      //   标签页 B：见到 rev=5 → 生成 rev=6 → 写入（**覆盖 A，无提示**）
      //
      // 两者 rev 相同，比较不成立，于是"后写的赢"且无人知道。
      //
      // ## 现在怎么做：compare-and-swap
      //
      // 调用方传 `lastKnownRevision`（它上次成功读到/写入的版本）。
      // 在**同一个事务里**读出库中当前 revision，必须**严格等于**它才允许写。
      //   · `lastKnownRevision === null` → 首次写入，库里必须没有记录
      //   · 不等 → 返回 `{ ok:false, reason:"conflict", currentRevision }`
      //
      // 这样"两个标签页各自 ++ 到 6"的情况会**明确失败**，而不是静默覆盖。
      const lastKnown = (p.lastKnownRevision === undefined) ? null : p.lastKnownRevision;

      const rec = {
        draftId: draftId,
        designId: p.designId,
        designName: String(p.designName || ""),
        savedAt: Date.now(),
        schemaVersion: DRAFT_SCHEMA_VERSION,
        designJson: designJson,
        selection: Array.isArray(p.selection) ? p.selection.slice(0, 200) : [],
        nodeCount: countNodes(p.design),
        assetCount: (p.design.assets || []).length,
        byteSize: designJson.length,
        checksum: checksumOf(designJson),
        manualSavedAt: p.manualSavedAt || 0,
        /**
         * 单调递增的编辑版本号（P4R-1.1）。
         *
         * 用来判断"这次写入的内容是不是比库里更新"。
         * 写入方（DraftManager）每次 markDirty 时 ++revision。
         * 读取方（恢复 / 多标签页）可以据此判断草稿新旧。
         */
        revision: p.revision || 0,
        complete: true,
      };

      return new Promise(function (resolve) {
        let tx;
        try {
          // 草稿 + 墓碑都进同一事务（查墓碑与写草稿原子）
          tx = db.transaction([STORE, TOMB_STORE], "readwrite");
        } catch (e) {
          state.failures++;
          state.lastError = "transaction: " + e.message;
          resolve({ ok: false, reason: "transaction" });
          return;
        }

        // ==================================================== P4R-1.1 版本保护
        //
        // ## 防的是"旧写入覆盖新草稿"
        //
        // 写入是**异步**的。可能出现：
        //   ① 发起写（rev=3，内容 A）
        //   ② 用户又编辑（rev=4，内容 B）
        //   ③ 发起写（rev=4，内容 B）
        //   ④ **③ 先完成，① 后完成** → 库里变成了内容 A（旧）
        //
        // 修法：**同一个读改写事务里**先读出库里现有记录的 revision，
        // 如果它的 revision **大于**本次要写的，就**放弃写入**。
        // 因为 IndexedDB 事务是串行的，这个检查是原子的。
        let rejectReason = null;
        let currentRevision = null;
        try {
          const store = tx.objectStore(STORE);

          // ⚠️ P4R-2A：**同一个事务里**先查持久墓碑。
          //    与下面的 revision 检查在同一个 readwrite 事务内，
          //    所以「查墓碑」和「写草稿」之间不可能被别的标签页插入删除。
          const tombReq = tx.objectStore(TOMB_STORE).get(draftId);
          tombReq.onsuccess = function () {
            if (tombReq.result) {
              rejectReason = "tombstoned";
              return;
            }
            proceedWithPut();
          };
          tombReq.onerror = function () { proceedWithPut(); };

          function proceedWithPut() {
          const curReq = store.get(draftId);
          curReq.onsuccess = function () {
            const cur = curReq.result;
            const exists = !!(cur && cur.complete === true);
            currentRevision = exists && typeof cur.revision === "number" ? cur.revision : null;

            // ============ 乐观并发控制：compare-and-swap ============
            //
            // 期望值必须**严格等于**库中当前值：
            //   · 库里有记录 → 期望必须等于它的 revision
            //   · 库里没记录 → 期望必须是 null（首次写入）
            //
            // 不等 → 说明有人在我们观察之后改过 → **明确失败**，不覆盖。
            if (exists) {
              if (lastKnown !== null && lastKnown !== currentRevision) {
                rejectReason = "conflict";
                return;
              }
              // 调用方以为"这是新草稿"（lastKnown=null），但库里已经有记录
              // → 说明身份撞了（或记录被别处创建）→ **一律冲突**，不覆盖。
              //
              // ⚠️ 早期版本用 p.expectNew 放行「另存为独立草稿」，
              //    结果同一个新身份第二次写也能成功，等于没保护 —— 已去掉这个例外。
              if (lastKnown === null) {
                rejectReason = "conflict";
                return;
              }
            } else {
              // 库里没有，但调用方以为有 → 冲突（可能被别处删了）
              if (lastKnown !== null) {
                rejectReason = "conflict";
                return;
              }
            }

            try {
              store.put(rec);
            } catch (e) {
              state.failures++;
              state.lastError = "put: " + e.message;
              rejectReason = "put";
            }
          };
          curReq.onerror = function () {
            // 读失败 → 保守：不写（宁可本次失败，也不要覆盖别人的数据）
            rejectReason = "read-failed";
          };
          }
        } catch (e) {
          state.failures++;
          state.lastError = "put: " + e.message;
          resolve({ ok: false, reason: "put" });
          return;
        }

        tx.oncomplete = function () {
          if (rejectReason === "conflict") {
            // ⚠️ **明确冲突**：不覆盖、不删除本地内容，交给上层提示用户
            state.conflicts++;
            resolve({
              ok: false,
              reason: "conflict",
              currentRevision: currentRevision,
              expectedRevision: lastKnown,
              sessionId: SESSION_ID,
            });
            return;
          }
          if (rejectReason) {
            resolve({ ok: false, reason: rejectReason, currentRevision: currentRevision });
            return;
          }
          state.writes++;
          state.lastWriteAt = rec.savedAt;
          state.lastWriteBytes = rec.byteSize;
          state.lastError = null;
          resolve({ ok: true, bytes: rec.byteSize, savedAt: rec.savedAt });
        };
        // ⚠️ 失败时**不删除已有草稿** —— 旧的可能是最后一份有效副本
        tx.onerror = function (ev) {
          state.failures++;
          state.lastError = (ev.target.error && ev.target.error.name) || "write error";
          resolve({ ok: false, reason: state.lastError });
        };
        tx.onabort = function () {
          state.failures++;
          state.lastError = "aborted";
          resolve({ ok: false, reason: "aborted" });
        };
      });
    });
  }

  /** 数节点（含子节点） */
  function countNodes(design) {
    let n = 0;
    const walk = function (list) {
      if (!Array.isArray(list)) return;
      for (let i = 0; i < list.length; i++) {
        n++;
        if (list[i] && Array.isArray(list[i].children)) walk(list[i].children);
      }
    };
    walk(design && design.nodes);
    if (design && Array.isArray(design.pages)) {
      for (let i = 0; i < design.pages.length; i++) walk(design.pages[i] && design.pages[i].nodes);
    }
    return n;
  }

  /** 取单条草稿（含校验） */
  function getDraft(draftId) {
    return open().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        let tx;
        try { tx = db.transaction([STORE], "readonly"); } catch (e) { resolve(null); return; }
        const req = tx.objectStore(STORE).get(draftId);
        req.onsuccess = function () {
          const rec = req.result || null;
          if (!rec) { resolve(null); return; }
          const bad = draftProblem(rec);
          resolve({ record: rec, problem: bad });
        };
        req.onerror = function () { resolve(null); };
      });
    });
  }

  /** 列出全部草稿（按时间倒序），带问题标记 */
  function listDrafts() {
    return open().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        let tx;
        try { tx = db.transaction([STORE], "readonly"); } catch (e) { resolve([]); return; }
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () {
          const list = (req.result || []).map(function (rec) {
            return {
              draftId: rec.draftId,
              designId: rec.designId,
              designName: rec.designName,
              savedAt: rec.savedAt,
              nodeCount: rec.nodeCount,
              assetCount: rec.assetCount,
              byteSize: rec.byteSize,
              schemaVersion: rec.schemaVersion,
              manualSavedAt: rec.manualSavedAt || 0,
              // P4R-1.1：列表也要带 revision —— 判断草稿新旧 / 验证写入顺序都要它
              revision: typeof rec.revision === "number" ? rec.revision : 0,
              complete: rec.complete === true,
              problem: draftProblem(rec),
            };
          });
          list.sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
          resolve(list);
        };
        req.onerror = function () { resolve([]); };
      });
    });
  }

  /**
   * 已删除草稿的"墓碑"（P4R-1.1）。
   *
   * ## 防的是什么
   *
   * 用户删掉草稿后，如果**还有一个写入正在飞行中**（IndexedDB 事务尚未完成），
   * 它完成后会把这条记录**重新创建出来** —— 用户看到"删了又回来"。
   *
   * 做法：删除时把 draftId 记进墓碑表（带时间戳）；`saveDraft` 前先查墓碑，
   * 命中就**拒绝写入**。墓碑有 TTL，避免无限增长。
   *
   * ⚠️ 只在内存里 —— 刷新后墓碑没了，但刷新后也不会有飞行中的写入。
   */
  const tombstones = new Map();      // draftId -> 删除时间
  const TOMBSTONE_TTL = 60 * 1000;   // 60 秒

  function isTombstoned(draftId) {
    const t = tombstones.get(draftId);
    if (!t) return false;
    if (Date.now() - t > TOMBSTONE_TTL) { tombstones.delete(draftId); return false; }
    return true;
  }

  /**
   * 删除草稿。**只在用户明确确认后调用**。
   *
   * P4R-2A：墓碑**同时写内存与 IndexedDB**，且在**同一个事务里**完成
   * 「删除草稿 + 写墓碑」—— 要么都成功，要么都不做。
   * 这样即使另一个标签页在 60 秒后（甚至重启后）尝试写入，也会被持久墓碑拦住。
   */
  function deleteDraft(draftId) {
    return open().then(function (db) {
      if (!db) return { ok: false, reason: "unavailable" };
      // ⚠️ 先立内存墓碑，立刻挡住飞行中的写入
      tombstones.set(draftId, Date.now());
      return new Promise(function (resolve) {
        let tx;
        try {
          // 两个 store 进**同一个事务** → 原子
          tx = db.transaction([STORE, TOMB_STORE], "readwrite");
        } catch (e) {
          resolve({ ok: false, reason: "transaction" });
          return;
        }
        try {
          tx.objectStore(STORE).delete(draftId);
          tx.objectStore(TOMB_STORE).put({
            draftId: draftId,
            deletedAt: Date.now(),
            sessionId: SESSION_ID,
            reason: "user-delete",
          });
        } catch (e) {
          resolve({ ok: false, reason: "delete" });
          return;
        }
        tx.oncomplete = function () { resolve({ ok: true, persisted: true }); };
        tx.onerror = function () { resolve({ ok: false, reason: "delete" }); };
        tx.onabort = function () { resolve({ ok: false, reason: "aborted" }); };
      });
    });
  }

  /**
   * 查询持久墓碑（P4R-2A）。
   *
   * 内存墓碑命中 → 立刻返回 true（快路径）。
   * 否则查 IndexedDB 的 `tombstones` store。
   */
  function isPersistentlyDeleted(draftId) {
    if (isTombstoned(draftId)) return Promise.resolve(true);
    return open().then(function (db) {
      if (!db) return false;                 // 库不可用 → 内存墓碑已尽力
      return new Promise(function (resolve) {
        let tx;
        try { tx = db.transaction([TOMB_STORE], "readonly"); }
        catch (e) { resolve(false); return; }
        const req = tx.objectStore(TOMB_STORE).get(draftId);
        req.onsuccess = function () { resolve(!!req.result); };
        req.onerror = function () { resolve(false); };
      });
    });
  }

  /**
   * 校验草稿的记录（对外提供，便于 UI 与测试复用同一判据）。
   * @returns {string|null} null = 可用
   */
  function validateDraft(rec) {
    return draftProblem(rec);
  }

  /** 当前状态（供 UI / 诊断读取） */
  function getStatus() {
    return {
      available: state.available,
      lastError: state.lastError,
      lastWriteAt: state.lastWriteAt,
      lastWriteBytes: state.lastWriteBytes,
      writes: state.writes,
      failures: state.failures,
      schemaVersion: DRAFT_SCHEMA_VERSION,
      dbName: DB_NAME,
      sessionId: SESSION_ID,
      conflicts: state.conflicts,
    };
  }

  /** 测试钩子：清空全部草稿（**测试专用**） */
  function __clearAll() {
    return open().then(function (db) {
      if (!db) return { ok: false };
      return new Promise(function (resolve) {
        try {
          const tx = db.transaction([STORE], "readwrite");
          tx.objectStore(STORE).clear();
          tx.oncomplete = function () { resolve({ ok: true }); };
          tx.onerror = function () { resolve({ ok: false }); };
        } catch (e) { resolve({ ok: false }); }
      });
    });
  }

  ICAR.ui = ICAR.ui || {};
  ICAR.ui.DraftStore = {
    open: open,
    saveDraft: saveDraft,
    getDraft: getDraft,
    listDrafts: listDrafts,
    deleteDraft: deleteDraft,
    isPersistentlyDeleted: isPersistentlyDeleted,
    validateDraft: validateDraft,
    getStatus: getStatus,
    checksumOf: checksumOf,
    countNodes: countNodes,
    DB_NAME: DB_NAME,
    SCHEMA_VERSION: DRAFT_SCHEMA_VERSION,
    SESSION_ID: SESSION_ID,
    getConflicts: function () { return state.conflicts; },
    __clearAll: __clearAll,
    /** 测试钩子：查墓碑 / 清墓碑 */
    __isTombstoned: isTombstoned,
    __clearTombstones: function () { tombstones.clear(); },
  };
})();
