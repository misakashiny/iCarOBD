/* ==========================================================================
   js/ui/schema-panel.js —— Schema 属性面板接入（P4A 第四/五/六部分）
   ==========================================================================

   ## 与旧面板的关系

   **并行，不替换。**
   - 旧 `#props` 面板原样保留（所有控件都能用它改全部属性）
   - 新增 `#schemaProps` 只接管**代码轨道**，且只开放 4 个字段

   任务要求"不得因为开启新面板而删除旧属性编辑能力" —— 所以两个面板同时存在，
   轨道节点在**两个面板里都能编辑**。

   ## 增量刷新（任务第六部分）

   原 `panels.js` 的做法是 `renderProps()` 整个 `innerHTML` 重建，
   于是：输入框失焦、光标跳位、滑块拖动被截断。

   本面板的做法：
   1. **只建一次 DOM**（`mount`），之后 `update()` 只改值
   2. 正在编辑的输入框**跳过更新**（`skipPath`），光标不跳
   3. 滑块拖动期间用 `PropertyUpdate.beginLive/setLive/endLive`，
      **一次连续拖动只产生一条撤销记录**
   4. 切换节点时**只更新值**，不重建 DOM

   ## 不破坏旧面板

   本文件**不修改** `panels.js` 的任何函数，只在选中变化后追加自己的更新。
   `suppressPanelRender` 等旧补丁**一律不动**。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR || !ICAR.ui || !ICAR.ui.schemaProps) {
    throw new Error("schema-panel.js 必须加载在 schema-props.js 之后");
  }

  const SP = ICAR.ui.schemaProps;
  const SUPPORTED_EDIT = ["trackStyle.orient", "trackStyle.segments", "trackStyle.glow", "trackStyle.fill"];

  let view = null;          // { root, inputs }
  let currentId = null;     // 当前挂载的节点 id
  let currentFamily = null; // "track" | null
  let editingPath = null;   // 正在编辑的输入框路径（update 时跳过）

  function el(id) { return document.getElementById(id); }

  /** 取当前选中的单个节点 */
  function selectedNode() {
    const S = window.CanvasState;
    if (!S || !S.design || !S.selection || S.selection.length !== 1) return null;
    return SP.__findNodeById(S.selection[0]);
  }

  /** 渲染外壳（含标题与"未选中"占位） */
  function renderShell(container, node, schema) {
    container.innerHTML = "";
    const head = document.createElement("div");
    head.className = "panelBar";
    head.innerHTML = '<span class="pbTitle">属性（Schema 试点）</span>' +
      '<span class="pbCount">' + (schema ? (schema.family === "text" ? "文字"
        : schema.family === "gauge" ? "仪表"
        : schema.family === "imageState" ? "状态灯"
        : schema.family === "image" ? "图片"
        : schema.family === "container" ? "容器" : "轨道") : "无") + "</span>";
    container.appendChild(head);

    if (!schema) {
      const p = document.createElement("div");
      p.className = "spEmpty";
      p.textContent = node
        ? "该控件暂未接入 Schema 面板（继续用下方旧面板编辑）"
        : "未选中控件，或选中了多个";
      container.appendChild(p);
      return null;
    }

    const body = document.createElement("div");
    body.className = "spBody";
    container.appendChild(body);
    const view = SP.SchemaRenderer.mount(body, schema, { readonly: false });

    // ---- P4E-03 批次 C：仪表族的「按 PID 库回填」动作 ----
    //
    // 旧面板有这个按钮（gaugeFields 末尾 → applyPidDefaults）。
    // 本面板原来**没有按钮机制**（字段列表由 SchemaRenderer 按 fields 渲染）。
    // 这里加一个**最小动作区**，直接调用既有的 `window.applyPidDefaults()` ——
    // 不复制任何 PID 默认参数库（任务要求），也不改 SchemaRenderer。
    if (schema && schema.family === "gauge") {
      container.appendChild(buildGaugeActions());
    }
    return view;
  }

  /**
   * 仪表族的动作按钮区（P4E-03）。
   *
   * ⚠️ 只做"调用既有函数 + 刷新面板"，业务逻辑全在 `applyPidDefaults` 里：
   *    · 它自己走 `window.commit(...)` → **撤销栈自动有一条记录**（可 Undo/Redo）
   *    · 它只改 min/max/warnLow/warnHigh 四个字段，**不碰外观**
   *    · PID 不在内置库时它会 alert 提示，不静默改数据
   */
  function buildGaugeActions() {
    const wrap = document.createElement("div");
    wrap.className = "spActions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spActionBtn";
    btn.textContent = "按 PID 库回填量程与阈值";
    btn.title = "把 min / max / warnLow / warnHigh 换成该 PID 在内置库里的默认值";
    btn.addEventListener("click", function () {
      // 复用既有实现 —— 不复制一套默认参数
      if (typeof window.applyPidDefaults !== "function") return;
      window.applyPidDefaults();
      // 回填后同步刷新面板与画布（任务要求）
      refresh(true);
      if (window.refreshAll) window.refreshAll();
    });
    wrap.appendChild(btn);
    return wrap;
  }

  /**
   * 主刷新入口。**幂等**，可以频繁调用。
   *
   * @param {boolean} [force] 强制重建 DOM（仅在切换面板类型时需要）
   */
  function refresh(force) {
    const box = el("schemaProps");
    if (!box) return;
    const node = selectedNode();
    const schema = node ? SP.SchemaResolver.resolve(node) : null;
    const family = schema ? schema.family : null;
    const nodeChanged = !node || node.id !== currentId;
    const familyChanged = family !== currentFamily;

    if (force || !view || familyChanged || (!node && currentId)) {
      view = renderShell(box, node, schema);
      currentId = node ? node.id : null;
      currentFamily = family;
      editingPath = null;
    }

    if (!view || !node) return;

    // 切节点时先清掉正在编辑的状态，避免把上一个节点的值带过来
    if (nodeChanged) editingPath = null;

    // ⚠️ 只更新值，不重建 DOM
    SP.SchemaRenderer.update(view, node, editingPath);
    currentId = node.id;
  }

  // ============================================================ 事件绑定

  // ============================================================ 文本输入事务（P4B）

  /** 中文输入法组合状态 —— 组合期间**不得提交**，否则拼音字母会被当成最终文字 */
  let composingPath = null;

  /** Escape 取消：记下"开始编辑前的值"，Escape 时还原 */
  let escSnapshot = null;   // { path, nodeId, value }

  function bindTextTransactions(box) {
    // ① 组合开始（中文输入法）
    box.addEventListener("compositionstart", function (ev) {
      const path = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-path");
      if (!path) return;
      composingPath = path;
      // 记下组合前的值，给 Escape 用
      const node = selectedNode();
      if (node) {
        escSnapshot = { path: path, nodeId: node.id,
          value: SP.PropertyAccessor.get(node, path) };
      }
    }, true);

    // ② 组合中 —— 明确不提交（只是把状态标住；input 事件里会跳过）
    box.addEventListener("compositionupdate", function (ev) {
      const path = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-path");
      if (path) composingPath = path;
    }, true);

    // ③ 组合结束 —— 这时才是真正的最终文字，提交一次
    box.addEventListener("compositionend", function (ev) {
      const t = ev.target;
      const path = t && t.getAttribute && t.getAttribute("data-path");
      composingPath = null;
      if (!path) return;
      const node = selectedNode();
      if (!node) return;
      const field = findField(path);
      if (!field) return;
      const r = SP.PropertyValidator.coerce(field, t.value);
      if (!r.ok) {
        t.classList.add("spInvalid");
        t.title = r.error || "输入无效";
        return;
      }
      t.classList.remove("spInvalid");
      t.title = "";
      editingPath = path;
      SP.PropertyUpdate.beginLive(node, path);
      SP.PropertyUpdate.setLive(node, path, r.value);
    }, true);

    // ④ Escape：取消本次编辑，还原到开始前的值
    box.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      const t = ev.target;
      const path = t && t.getAttribute && t.getAttribute("data-path");
      if (!path) return;
      ev.preventDefault();
      cancelEditing(path);
    }, true);
  }

  /**
   * 取消当前编辑（Escape）。
   *
   * 语义：把输入框与模型都还原到**开始编辑前**的值，且**不产生撤销记录**。
   * 若此前有 live 事务在跑，先把它丢弃（不回填模型）。
   */
  function cancelEditing(path) {
    const node = selectedNode();
    const box = el("schemaProps");

    // 丢弃未提交的 live 事务（不压实）
    SP.PropertyUpdate.abortLive && SP.PropertyUpdate.abortLive();

    if (node && escSnapshot && escSnapshot.nodeId === node.id && escSnapshot.path === path) {
      SP.PropertyAccessor.set(node, path, escSnapshot.value);
      if (window.requestDraw) window.requestDraw();
      else if (window.draw) window.draw();
    }
    escSnapshot = null;
    composingPath = null;
    editingPath = null;

    // 把输入框的值也拨回去
    if (box && node) {
      const inp = findInput(path);
      if (inp) {
        const v = SP.PropertyAccessor.get(node, path);
        const f = findField(path);
        if (f && f.type === "enum") {
          inp.value = v === null ? "__null__" : String(v);
        } else if (f && f.type === "boolean") {
          inp.checked = !!v;
        } else {
          inp.value = v === null || v === undefined ? "" : String(v);
        }
        inp.classList.remove("spInvalid");
        inp.title = "";
      }
    }
  }

  function findInput(path) {
    const box = el("schemaProps");
    if (!box) return null;
    const all = box.querySelectorAll("input,select");
    for (let i = 0; i < all.length; i++) {
      if (all[i].getAttribute("data-path") === path) return all[i];
    }
    return null;
  }
  function bindEvents() {
    const box = el("schemaProps");
    if (!box) return;

    // 用事件委托，避免每次重渲染都要重绑
    box.addEventListener("input", function (ev) {
      const t = ev.target;
      const path = t.getAttribute && t.getAttribute("data-path");
      if (!path) return;
      const node = selectedNode();
      if (!node) return;
      const field = findField(path);
      if (!field) return;

      // ⚠️ 中文输入法组合期间**不提交** —— 否则拼音字母会先被当成最终文字写入模型
      if (composingPath === path) return;

      let val = t.type === "checkbox" ? t.checked : t.value;
      const r = SP.PropertyValidator.coerce(field, val);
      if (!r.ok) {
        t.classList.add("spInvalid");
        t.title = r.error || "输入无效";
        return;          // ⚠️ 非法输入**不写入模型**
      }
      // 快照由 focusin 记录（见 bindEvents）；这里只在缺失时兜底，
      // 且**绝不覆盖** focusin 记下的那个值 —— 否则 Escape 会还原到"半途值"。
      if (!escSnapshot || escSnapshot.nodeId !== node.id || escSnapshot.path !== path) {
        escSnapshot = { path: path, nodeId: node.id, value: SP.PropertyAccessor.get(node, path) };
      }
      t.classList.remove("spInvalid");
      t.title = "";

      editingPath = path;
      // 连续输入：用 live 事务，收尾时只压一条
      SP.PropertyUpdate.beginLive(node, path);
      SP.PropertyUpdate.setLive(node, path, r.value);
    });

    box.addEventListener("change", function (ev) {
      const t = ev.target;
      const path = t.getAttribute && t.getAttribute("data-path");
      if (!path) return;
      const node = selectedNode();
      if (!node) return;
      const field = findField(path);
      if (!field) return;

      // select / checkbox 的 change 才是"定了"
      const val = t.type === "checkbox" ? t.checked : t.value;
      const r = SP.PropertyValidator.coerce(field, val);
      if (!r.ok) {
        t.classList.add("spInvalid");
        t.title = r.error || "输入无效";
        return;
      }
      t.classList.remove("spInvalid");
      t.title = "";

      if (field.type === "boolean" || field.type === "enum" || field.type === "asset") {
        SP.PropertyUpdate.setOnce(node, path, r.value);
        editingPath = null;
        refresh();
        // ⚠️ P4F-03：素材切换后**必须重绘**，否则画布还显示旧素材。
        //
        // refresh() 只重建属性面板；画布要等 refreshAll() 里的既有链路：
        //   syncAssetImages() 按**新 assetId** 重新解析图片并更新绘图缓存，
        //   P4R-FIX-01 的「原图优先于缩略图」逻辑也走这条链路。
        //
        // 这里**只触发既有刷新**：不碰 asset.data、不改 IndexedDB、不动持久化政策。
        if (field.type === "asset" && window.refreshAll) window.refreshAll();
      } else {
        // 数值/text：change 表示失焦或回车 —— 收尾 live 事务
        SP.PropertyUpdate.endLive(node, path);
        editingPath = null;
        if (window.refreshAll) window.refreshAll();
        else refresh();
      }
    });

    box.addEventListener("blur", function (ev) {
      const t = ev.target;
      const path = t.getAttribute && t.getAttribute("data-path");
      if (!path) return;
      if (editingPath === path) {
        const node = selectedNode();
        if (node) SP.PropertyUpdate.endLive(node, path);
        editingPath = null;
        refresh();
      }
    }, true);

    // ① 聚焦即记录"开始编辑前的值" —— Escape 要靠它还原。
    //    放在 focus 而不是首次 input：用户可能聚焦后什么都没敲就按 Escape。
    box.addEventListener("focusin", function (ev) {
      const t = ev.target;
      const path = t && t.getAttribute && t.getAttribute("data-path");
      if (!path) return;
      const node = selectedNode();
      if (!node) return;
      escSnapshot = { path: path, nodeId: node.id,
        value: SP.PropertyAccessor.get(node, path) };
    }, true);

    // P4B：文本输入事务（IME / Escape）
    bindTextTransactions(box);
  }

  /** 从当前 schema 里找字段声明 */
  function findField(path) {
    if (!view) return null;
    const it = view.inputs[path];
    return it ? it.field : null;
  }

  // ============================================================ 接线

  /**
   * 选中变化时调用。
   *
   * ⚠️ 不改 `panels.js` 的 `renderProps()` —— 由 `app.js` 的选中回调
   *    在**旧面板渲染完之后**追加调用本函数。
   */
  function onSelectionChanged() {
    refresh(false);
  }

  function init() {
    bindEvents();
    refresh(true);
  }

  ICAR.ui.SchemaPanel = {
    init: init,
    /**
     * 对外暴露的 refresh —— **出错时记录而不吞掉**（P4B.1）。
     *
     * 内部真实现是 `refresh`；这里包一层把异常转成可观察状态后**继续抛出**，
     * 由调用方（refreshAll）决定是否记录/降级。
     */
    refresh: function () {
      try {
        refresh();
        window.__ICAR_SCHEMA_ERROR = null;
        window.__ICAR_SCHEMA_ERROR_COUNT = 0;
      } catch (e) {
        // ⚠️ P4C 修正（第八部分第 1 项）：**不在这里计数**。
        //
        // 原来这里也 +1 并写 __ICAR_SCHEMA_ERROR，而 refreshAll 外层**又**记一次
        // → 同一次逻辑故障被算成 2 次，排查时会误以为发生了两次独立故障。
        //
        // 现在：这里只**打标记**（说明异常来自面板内部），交给外层统一计数。
        // 堆栈信息不会丢 —— 外层的 recordSchemaError 记的是同一个 e。
        if (e && typeof e === "object") {
          try { e.__icarSchemaOrigin = "SchemaPanel.refresh"; } catch (err) { /* 冻结对象忽略 */ }
        }
        throw e;
      }
    },
    __refreshRaw: refresh,
    onSelectionChanged: onSelectionChanged,
    /** 测试用 */
    supportedFields: function () { return SUPPORTED_EDIT.slice(); },
    /** 取消当前编辑（Escape 语义） */
    cancelEditing: cancelEditing,
    /** 测试用：是否处于 IME 组合中 */
    __composing: function () { return composingPath; },
    /** 测试用：模拟"正在编辑某个字段"（refresh 时跳过它，保住光标与输入值） */
    __setEditing: function (path) { editingPath = path; },
    currentFamily: function () { return currentFamily; },
    __view: function () { return view; },
    __editingPath: function () { return editingPath; },
  };
})();
