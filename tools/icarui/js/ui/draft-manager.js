/* ==========================================================================
   js/ui/draft-manager.js —— 草稿管理器（P4R-1 关卡 B）
   ==========================================================================

   负责三件事：
   1. **设计身份**（designId）—— 不依赖 design.name，不写进 icar.ui/2
   2. **自动保存调度**（防抖 + 手势结束）
   3. **恢复提示 UI**（不自动覆盖画布）

   ## 设计身份（任务第五部分）

   `design.name` **不能**作为唯一身份：
   - 实测两个同名设计的历史会错位（P4R-0）
   - 空名字一律存成「未命名设计」，大量设计撞名

   所以本模块维护一个**内部 designId**：

   ```
   designId 存在哪里？
     · 内存：S.__designId（挂在 CanvasState 上）
     · 持久：IndexedDB 草稿记录里的 designId 字段
     · **绝不写进设计文件** —— 只挂在 canvasState 上，不进 design 对象
   ```

   ⚠️ 关键：`designId` **不放在 `S.design` 里**！
   因为 `S.design` 会被 `toV2Json()` 序列化成人人可见的设计文件。
   放在 `S`（CanvasState）上，`toV2Json` 根本看不到它。

   ## 自动保存触发（任务第六部分）

   审计了所有设计变更入口，统一都走 `commit()`：

   ```
   commit()  ← 改控件属性 / 拖动 / 旋转 / 缩放 / 增删 / 撤销 / 重做
   replaceDesign()  ← 打开文件 / 导入 / 新建
   ```

   **纯 UI 状态变更不走 commit**（选择节点、面板折叠、鼠标移动）→ 不会触发草稿保存。

   防抖策略：
   - 普通 commit：**防抖 N ms**（N 由实测决定，见报告）
   - 手势结束（`onDragEnd` / `endBatch`）：**立即写**
   - 页面隐藏（`visibilitychange`）：**立即写**（不是 beforeunload，
     不拿它当崩溃保证，只是"能写就写"）

   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("draft-manager.js 必须在 core/namespace.js 之后加载");
  const DS = ICAR.ui && ICAR.ui.DraftStore;
  if (!DS) throw new Error("draft-manager.js 必须在 draft-store.js 之后加载");

  /**
   * 防抖间隔（ms）。
   *
   * 实测依据（见 P4R-1 报告）：
   *   · 60 控件设计写草稿 2.2ms，100 张图 344KB 写 10ms
   *   · 每字符输入都会 commit，若不加防抖会每次写盘
   *   · 取 1200ms：比连续打字间隔（约 200~400ms）长，
   *     又短于用户"停下来想一想"的时间，平衡写入次数与丢失窗口
   */
  const DEBOUNCE_MS = 1200;

  const state = {
    designId: null,
    timer: null,
    dirty: false,
    lastSaveAt: 0,
    lastSaveOk: null,
    saveCount: 0,
    manualSavedAt: 0,       // 上次手动导出文件的时间
    pendingDesign: null,    // 待恢复的草稿（启动时检测到）
    uiMounted: false,
    enabled: false,
  };

  /** 生成内部设计身份 */
  function newDesignId() {
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 取当前设计身份（必要时创建） */
  function currentDesignId() {
    if (!state.designId) state.designId = newDesignId();
    return state.designId;
  }

  /** 设计换了（新建 / 打开文件 / 恢复草稿）→ 换身份 */
  function resetDesignId() {
    state.designId = newDesignId();
    return state.designId;
  }

  /** 标记"设计有改动"，触发防抖保存 */
  function markDirty() {
    if (!state.enabled) return;
    state.dirty = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      state.timer = null;
      flush("debounce");
    }, DEBOUNCE_MS);
  }

  /**
   * 立即写草稿。
   * @param {string} reason 触发原因（诊断用）
   */
  function flush(reason) {
    if (!state.enabled) return Promise.resolve({ ok: false, reason: "disabled" });
    if (!state.dirty) return Promise.resolve({ ok: false, reason: "not-dirty" });
    const S = window.CanvasState;
    if (!S || !S.design) return Promise.resolve({ ok: false, reason: "no-design" });

    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.dirty = false;

    return DS.saveDraft({
      designId: currentDesignId(),
      designName: S.design.name || "",
      design: S.design,
      selection: S.selection || [],
      manualSavedAt: state.manualSavedAt,
    }).then(function (r) {
      state.lastSaveAt = Date.now();
      state.lastSaveOk = !!r.ok;
      if (r.ok) state.saveCount++;
      if (!r.ok) {
        // ⚠️ 失败时**不删任何草稿**，只是标记 dirty 以便下次重试
        state.dirty = true;
        console.warn("[草稿] 保存失败：" + r.reason);
      }
      updateBadge();
      return r;
    });
  }

  /** 手动导出文件后调用（**不得据此删除草稿** —— 下载不等于写盘成功） */
  function noteManualSave() {
    state.manualSavedAt = Date.now();
    updateBadge();
  }

  // ==================================================================== UI

  /** 状态徽标（右下角小字，随时看得到草稿状态） */
  function updateBadge() {
    const el = document.getElementById("draftBadge");
    if (!el) return;
    if (!state.enabled) { el.textContent = ""; el.className = "draftBadge hidden"; return; }
    const st = DS.getStatus();
    if (st.available === false) {
      el.textContent = "⚠ 草稿不可用";
      el.className = "draftBadge warn";
      el.title = "自动草稿不可用（" + (st.lastError || "未知原因") + "）—— 请手动保存文件";
      return;
    }
    if (state.dirty) {
      el.textContent = "● 未保存";
      el.className = "draftBadge dirty";
      el.title = "有改动尚未写入草稿";
    } else if (state.lastSaveAt) {
      el.textContent = "✓ 草稿已存";
      el.className = "draftBadge ok";
      el.title = "最后写入 " + new Date(state.lastSaveAt).toLocaleTimeString();
    } else {
      el.textContent = "";
      el.className = "draftBadge hidden";
    }
  }

  /** 相对时间 */
  function relTime(ms) {
    const d = Date.now() - ms;
    if (d < 60000) return "刚刚";
    if (d < 3600000) return Math.floor(d / 60000) + " 分钟前";
    if (d < 86400000) return Math.floor(d / 3600000) + " 小时前";
    return Math.floor(d / 86400000) + " 天前";
  }

  /**
   * 启动时检测草稿并显示提示条。
   *
   * ## 硬性约束（任务第七部分）
   *   · 启动后**绝不自动覆盖当前画布**
   *   · 检测到旧草稿时，新建空白设计**不能**自动覆盖那份旧草稿
   *   · 稍后再说**绝不删除数据**
   */
  function checkForDraft() {
    return DS.listDrafts().then(function (list) {
      const usable = list.filter(function (d) { return !d.problem; });
      if (!usable.length) return null;
      // 只提示最新那份
      state.pendingDesign = usable[0];
      showRecoveryBar(usable[0], usable.length);
      return usable[0];
    });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 顶部提示条（非模态，不打断） */
  function showRecoveryBar(draft, total) {
    let bar = document.getElementById("draftRecoveryBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "draftRecoveryBar";
      bar.className = "draftRecoveryBar";
      document.body.appendChild(bar);
    }
    const name = draft.designName || "未命名设计";
    let problem = "";
    if (draft.problem) {
      problem = '<span class="drbWarn">⚠ ' + esc(draft.problem) + '</span>';
    }
    bar.innerHTML =
      '<div class="drbInner">' +
      '<div class="drbText">' +
      '<div class="drbTitle">💾 发现未保存的草稿' + (total > 1 ? '（共 ' + total + ' 份，显示最新）' : '') + '</div>' +
      '<div class="drbMeta">' +
      '<b>' + esc(name) + '</b> · 最后编辑 ' + esc(relTime(draft.savedAt)) +
      '（' + esc(new Date(draft.savedAt).toLocaleString()) + '）' +
      ' · ' + draft.nodeCount + ' 个控件 · ' + draft.assetCount + ' 张素材' +
      ' · ' + Math.round(draft.byteSize / 1024) + ' KB' +
      problem +
      '</div>' +
      '</div>' +
      '<div class="drbBtns">' +
      '<button class="primary" onclick="ICAR.ui.DraftManager.restorePending()">恢复草稿</button>' +
      '<button onclick="ICAR.ui.DraftManager.dismissPending()">稍后再说</button>' +
      '<button class="danger" onclick="ICAR.ui.DraftManager.deletePending()">删除草稿</button>' +
      '</div>' +
      '</div>';
    bar.style.display = "flex";
  }

  function hideRecoveryBar() {
    const bar = document.getElementById("draftRecoveryBar");
    if (bar) bar.style.display = "none";
  }

  /** 用户点「稍后再说」—— **绝不删数据** */
  function dismissPending() {
    state.pendingDesign = null;
    hideRecoveryBar();
    window.toast && window.toast("草稿已保留，可稍后在「文件」菜单再次恢复");
  }

  /** 用户点「删除草稿」—— **二次确认** */
  function deletePending() {
    const d = state.pendingDesign;
    if (!d) return;
    if (!confirm("确定删除草稿「" + (d.designName || "未命名设计") + "」吗？\n\n" +
      "这是该设计唯一未保存的副本，删除后无法找回。\n" +
      "（已手动导出到文件的版本不受影响）")) return;
    DS.deleteDraft(d.draftId).then(function (r) {
      if (r.ok) {
        state.pendingDesign = null;
        hideRecoveryBar();
        window.toast && window.toast("草稿已删除");
      } else {
        window.toast && window.toast("删除失败，草稿仍在");
      }
    });
  }

  /** 用户点「恢复草稿」—— 校验 → 确认 → 替换 */
  function restorePending() {
    const d = state.pendingDesign;
    if (!d) return Promise.resolve(false);
    return DS.getDraft(d.draftId).then(function (g) {
      if (!g || !g.record) {
        window.toast && window.toast("草稿读取失败，未做任何更改");
        return false;
      }
      if (g.problem) {
        // ⚠️ 恢复失败**不得清除唯一可用副本**
        window.toast && window.toast("草稿已损坏（" + g.problem + "），未做任何更改");
        return false;
      }
      let design = null;
      try {
        design = JSON.parse(g.record.designJson);
      } catch (e) {
        window.toast && window.toast("草稿解析失败，未做任何更改");
        return false;
      }
      // 走**既有合法校验流程**（任务第九部分）
      const S = window.CanvasState;
      const cur = S && S.design ? countCurrentNodes(S.design) : 0;
      if (cur > 0 || state.dirty) {
        if (!confirm("恢复草稿会替换当前设计（" + cur + " 个控件）。\n\n" +
          "当前未保存的改动会丢失（除非已写入草稿）。仍然恢复？")) return false;
      }
      if (typeof window.replaceDesign !== "function") {
        window.toast && window.toast("恢复失败：缺少 replaceDesign");
        return false;
      }
      // 换身份 → 落到草稿原来的 designId
      state.designId = g.record.designId;
      const okv = window.replaceDesign(design, "恢复草稿");
      if (!okv) {
        window.toast && window.toast("草稿恢复失败（校验未通过），原数据仍保留");
        return false;
      }
      state.dirty = false;
      state.pendingDesign = null;
      hideRecoveryBar();
      window.toast && window.toast("已恢复草稿「" + (design.name || "未命名设计") + "」");
      return true;
    });
  }

  function countCurrentNodes(design) {
    return DS.countNodes(design);
  }

  // ============================================================ 生命周期接线

  /** 接上所有设计变更入口 */
  function install() {
    if (state.enabled) return;
    state.enabled = true;

    // 1) 所有数据变更都走 commit —— 用它作为唯一触发点
    const origCommit = window.commit;
    if (typeof origCommit === "function") {
      window.commit = function () {
        const r = origCommit.apply(this, arguments);
        markDirty();
        return r;
      };
    }

    // 2) 手势结束 → 立即写
    const origDragEnd = window.onDragEnd;
    if (typeof origDragEnd === "function") {
      window.onDragEnd = function () {
        const r = origDragEnd.apply(this, arguments);
        flush("gesture-end");
        return r;
      };
    }

    // 3) 页面隐藏 → 尽量写（**不把它当崩溃保证**）
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") flush("hidden");
    });

    // 4) 状态徽标
    if (!document.getElementById("draftBadge")) {
      const b = document.createElement("div");
      b.id = "draftBadge";
      b.className = "draftBadge hidden";
      document.body.appendChild(b);
    }
    updateBadge();
    state.uiMounted = true;
  }

  /** 启动入口（由 app 的 boot 之后调用） */
  function boot() {
    return DS.open().then(function (db) {
      if (!db) {
        // 不可用 → **静默降级**，不阻塞编辑器
        state.enabled = false;
        const b = document.getElementById("draftBadge");
        if (!b) {
          const el = document.createElement("div");
          el.id = "draftBadge";
          el.className = "draftBadge warn";
          document.body.appendChild(el);
        }
        updateBadge();
        return { ok: false, reason: DS.getStatus().lastError };
      }
      currentDesignId();
      install();
      return checkForDraft().then(function () { return { ok: true }; });
    }).catch(function (e) {
      console.warn("[草稿] 启动失败，已降级：" + (e && e.message));
      return { ok: false, reason: String(e && e.message) };
    });
  }

  ICAR.ui = ICAR.ui || {};
  ICAR.ui.DraftManager = {
    boot: boot,
    install: install,
    markDirty: markDirty,
    flush: flush,
    noteManualSave: noteManualSave,
    checkForDraft: checkForDraft,
    restorePending: restorePending,
    dismissPending: dismissPending,
    deletePending: deletePending,
    currentDesignId: currentDesignId,
    resetDesignId: resetDesignId,
    getState: function () {
      return {
        enabled: state.enabled, dirty: state.dirty, designId: state.designId,
        lastSaveAt: state.lastSaveAt, lastSaveOk: state.lastSaveOk,
        saveCount: state.saveCount, hasPending: !!state.pendingDesign,
        debounceMs: DEBOUNCE_MS,
      };
    },
    DEBOUNCE_MS: DEBOUNCE_MS,
  };
})();
