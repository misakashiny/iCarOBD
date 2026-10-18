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
  const DB_VERSION = 1;
  /** 草稿格式版本。改结构时 +1，旧草稿仍可按旧版本读取 */
  const DRAFT_SCHEMA_VERSION = 1;
  const STORE = "drafts";
  const META = "meta";

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

      const rec = {
        draftId: "draft_" + p.designId,
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
        complete: true,
      };

      return new Promise(function (resolve) {
        let tx;
        try {
          tx = db.transaction([STORE], "readwrite");
        } catch (e) {
          state.failures++;
          state.lastError = "transaction: " + e.message;
          resolve({ ok: false, reason: "transaction" });
          return;
        }
        try {
          tx.objectStore(STORE).put(rec);
        } catch (e) {
          state.failures++;
          state.lastError = "put: " + e.message;
          resolve({ ok: false, reason: "put" });
          return;
        }
        tx.oncomplete = function () {
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

  /** 删除草稿。**只在用户明确确认后调用** */
  function deleteDraft(draftId) {
    return open().then(function (db) {
      if (!db) return { ok: false, reason: "unavailable" };
      return new Promise(function (resolve) {
        let tx;
        try { tx = db.transaction([STORE], "readwrite"); } catch (e) { resolve({ ok: false }); return; }
        try { tx.objectStore(STORE).delete(draftId); } catch (e) { resolve({ ok: false }); return; }
        tx.oncomplete = function () { resolve({ ok: true }); };
        tx.onerror = function () { resolve({ ok: false }); };
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
    validateDraft: validateDraft,
    getStatus: getStatus,
    checksumOf: checksumOf,
    countNodes: countNodes,
    DB_NAME: DB_NAME,
    SCHEMA_VERSION: DRAFT_SCHEMA_VERSION,
    __clearAll: __clearAll,
  };
})();
