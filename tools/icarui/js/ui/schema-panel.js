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
      '<span class="pbCount">' + (schema ? "轨道" : "无") + "</span>";
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
    return SP.SchemaRenderer.mount(body, schema, { readonly: false });
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

      let val = t.type === "checkbox" ? t.checked : t.value;
      const r = SP.PropertyValidator.coerce(field, val);
      if (!r.ok) {
        t.classList.add("spInvalid");
        t.title = r.error || "输入无效";
        return;          // ⚠️ 非法输入**不写入模型**
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

      if (field.type === "boolean" || field.type === "enum") {
        SP.PropertyUpdate.setOnce(node, path, r.value);
        editingPath = null;
        refresh();
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
    refresh: refresh,
    onSelectionChanged: onSelectionChanged,
    /** 测试用 */
    supportedFields: function () { return SUPPORTED_EDIT.slice(); },
    /** 测试用：模拟"正在编辑某个字段"（refresh 时跳过它，保住光标与输入值） */
    __setEditing: function (path) { editingPath = path; },
    currentFamily: function () { return currentFamily; },
    __view: function () { return view; },
    __editingPath: function () { return editingPath; },
  };
})();
