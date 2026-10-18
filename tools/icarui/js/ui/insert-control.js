/* ==========================================================================
   js/ui/insert-control.js —— 统一插入适配层（P4A）
   ==========================================================================

   ## 为什么要这一层

   控件"加进画布"这件事，编辑器里有 **3 个入口**：

   | 入口 | 触发 | 原实现 |
   |---|---|---|
   | 拖拽 | `drop` 事件（`panels.js`） | `c.make()` → `dropControlAt()` |
   | 双击/点击（新库） | `CatalogPanel.addToCanvas()` | **坏的**（见下） |
   | 单击（旧库） | 旧面板的按钮 | 各写各的 |

   三个入口各写各的，于是**尺寸语义与成功判定不一致**。P4A 核验时实测到：

   * **拖拽**：`w = 150`（`make()` 已过 `prepareBuiltinImages`，按画布宽高比缩放）→ 正确
   * **双击添加**：**完全失败**，静默返回 false（`addNode` 参数个数写错，见下）
   * `Registry.build()`：`w = 240`（原始设计尺寸，**不经过**画布适配）

   ## 这个模块做什么

   把"控件 → 画布节点"的语义**收成一处**，三个入口都走它，保证：

   1. **尺寸语义统一**：一律经过 `prepareBuiltinImages`，且**只过一次**
   2. **成功判定统一**：返回节点对象或 `null`，不再靠布尔值猜
   3. **不改变 `Registry.build()` 的底层契约**：它仍返回原始设计尺寸（240），
      适配在这一层做 —— 这是任务要求的"修插入适配层，不改底层创建契约"

   ## 与 `Registry.build()` 的分工

   ```
   Control.byLegacyKey(k).build()   → 原始设计尺寸（240）  ← 控件定义语义
                │
                ▼  ICAR.ui.insertControl(k)   ← 本层
   prepareBuiltinImages(node, false) → 画布适配尺寸（150）  ← 拖进画布语义
                │
                ▼
   design.nodes.push(node) + commit + selection
   ```
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("insert-control.js 必须在 core/namespace.js 之后加载");

  /**
   * 把控件 key 实例化成一个**已适配画布**的节点，但不加入设计。
   *
   * @param {string} key     BUILTIN_CONTROLS 的 key
   * @param {Object} [opts]  { x, y, w, h, props, applyCanvasFit }
   * @returns {Object|null}  节点；找不到控件时 null
   */
  function instantiate(key, opts) {
    const o = opts || {};
    const entry = (window.BUILTIN_CONTROLS || []).find(function (c) {
      return c && c.key === key;
    });
    if (!entry) return null;

    // ⚠️ 用 entry.make()（= Registry.build + prepareBuiltinImages 包装），
    //    与拖拽路径**完全同一条**。不要调 Control.build() 然后自己再包一次 ——
    //    那样一旦包装逻辑变动就会两条路径分叉（P3C-2 的教训）。
    let node = entry.make();
    if (!node) return null;

    // 调用方显式给了尺寸/位置就覆盖（例如按落点定位）
    if (o.x !== undefined) node.x = o.x;
    if (o.y !== undefined) node.y = o.y;
    if (o.w !== undefined) node.w = o.w;
    if (o.h !== undefined) node.h = o.h;

    return node;
  }

  /**
   * 把控件加入当前设计（含撤销事务与选中）。
   *
   * 三个入口共用这一个函数。
   *
   * @param {string} key
   * @param {Object} [opts] { x, y, w, h, select, source }
   * @returns {Object|null} 新建的节点；失败 null
   */
  function insertControl(key, opts) {
    const o = opts || {};
    const node = instantiate(key, o);
    if (!node) return null;

    const S = window.CanvasState;
    if (!S || !S.design) return null;

    const label = "添加：" + (node.name || key);
    const doPush = function () {
      // ⚠️ 必须传完整参数：addNode(nodes, node, parentId)
      if (typeof window.addNode === "function") {
        window.addNode(S.design.nodes, node);
      } else {
        S.design.nodes.push(node);
      }
      if (o.select !== false) S.selection = [node.id];
    };

    if (typeof window.commit === "function") {
      window.commit(doPush, label);
    } else {
      doPush();
    }
    return node;
  }

  ICAR.ui = ICAR.ui || {};
  ICAR.ui.insertControl = insertControl;
  ICAR.ui.instantiateControl = instantiate;
  // 兼容：老代码可能想直接拿
  if (window.insertControl === undefined) window.insertControl = insertControl;
})();
