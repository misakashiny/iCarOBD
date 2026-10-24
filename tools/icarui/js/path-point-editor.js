/* ==========================================================================
   js/path-point-editor.js —— P5B-M05 阶段 D：PathProgress 画布控制点编辑器
   ==========================================================================

   ## 目标（任务 §六 D1）

   用户能**直接用鼠标设计一条曲线路径**，而不是逐个手写归一化坐标。

   ## 为什么单独成文件

   `canvas.js` 已经 3000+ 行。控制点编辑是一块**内聚的新能力**（自己的状态机、
   自己的命中测试、自己的绘制），塞进去会让本来就难读的主循环更难读。
   更重要的是：它需要能**单独测试**（阶段 D 的验收要逐项打）。

   ## 坐标安全（任务 §六 D2）—— 本文件最要紧的部分

   路径点存的是**归一化坐标 0..1**（相对节点自身的 w/h）。
   从鼠标位置换算过去要穿过 5 层变换：

      屏幕像素
        → 画布设备坐标（减去画布偏移、除以 zoom）      ← [screenToCanvas]
        → 节点局部坐标（**逆**世界矩阵：平移/旋转/缩放）  ← [canvasToLocal]
        → 归一化 0..1（除以 w/h）

   **任何一层算错，拖动就会"跳"**。所以：
     · 一律用 `DOMMatrix.inverse()` 求逆，不手推公式
     · 每一层都有对应的正向/反向函数，测试里成对验证（往返一致）
     · 拖动时**用拖动开始的那个矩阵**，不在过程中重算（避免自反馈）

   ## 与现有机制的关系

   复用（不重写）：
     · `window.deviceMatrix(nodes, id)` —— 拿节点的世界矩阵（累积祖先链）
     · `HANDLE` 尺寸概念、虚线/实线的视觉语言
     · `pushHistory` / Undo 合并（一次拖动 = 一条历史）

   新增：
     · 控制点的命中（`hitPathPoint`）
     · 拖拽状态机（`beginDrag` / `moveDrag` / `endDrag`）
     · 控制点与路径的叠加绘制（`drawOverlay`）
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("path-point-editor.js 必须在 core/namespace.js 之后加载");

  /** 控制点用到的常量 —— 与 canvas.js 的 HANDLE 同一量级（9px） */
  const PT_R = 5.5;          // 控制点半径（设备 px）
  const PT_HIT_R = 11;       // 命中半径（比视觉大一圈，好点）
  const PT_MAX = 64;         // 与 v3 契约一致：每条路径最多 64 点
  const PT_MIN = 2;          // 少于 2 点不成立（Android 侧也这么判）

  /** 编辑态显示什么 */
  const STYLE = {
    ptFill: "#FFB020",
    ptStroke: "#20140A",
    ptFirst: "#39D98A",      // 首点：绿
    ptLast: "#FF4DD2",       // 末点：粉
    line: "rgba(255,176,32,0.9)",
    segment: "rgba(0,216,255,0.35)",
  };

  // ================================================================
  // 坐标换算（D2 的核心）
  // ================================================================

  // ================================================================
  // 坐标约定（**与 canvas.js 的 eventPos 一致**）
  //
  // 编辑器里有两层"像素"：
  //   · 屏幕 CSS 像素（ev.clientX）
  //   · **画布位图坐标**（canvas.js 的 eventPos：乘了 cv.width / rect.width，
  //     也就是把 devicePixelRatio 也折进去了）
  //
  // `path-point-editor` 一律用**画布位图坐标**。原因：
  //   · canvas.js 的 pointerdown/move 已经算好了 `cp`，直接传进来最省事
  //   · 节点的世界矩阵（deviceMatrix）输出的也是位图坐标 —— 两者同一空间
  //
  // ⚠️ 第一版假设传入的是"屏幕 CSS 像素（相对 canvas 元素）"，用
  //    `__canvasRect()` 去减偏移 —— 而那个函数**根本不存在**（被
  //    verify-p4fm03-input-undefined 这个守卫抓到了）。
  //    更糟的是我用 `typeof x === "function"` 兜底，让它静默退化成 `{left:0,top:0}`
  //    —— 在 1x 缩放下碰巧对，在高 DPI 下会整体偏移。
  // ================================================================

  /**
   * 画布**位图坐标** → 节点局部坐标链上的"画布空间"。
   *
   * 画布位图坐标空间里，节点的世界矩阵直接可用，所以这里只做
   * 位图坐标 → 画布空间（去掉平移/缩放已经由矩阵包含）。
   *
   * 注：`CanvasState.zoom/panX/panY` 是**视图层**的缩放平移，
   * `deviceMatrix` 已经把 `nodeToCanvasMatrix()` 折进去了，
   * 所以这里**不再重复施加** zoom/pan —— 重复施加是拖动"跳"的经典原因。
   *
   * @param {number} sx 画布位图 x
   * @param {number} sy 画布位图 y
   */
  function screenToCanvas(sx, sy) {
    // 位图坐标与 deviceMatrix 输出空间一致 → 直接透传
    return { x: sx, y: sy };
  }

  /** 取 canvas 元素（用于把位图坐标换回屏幕坐标给 DOM 层）*/
  function canvasEl() {
    return document.getElementById("cv");
  }

  /**
   * 画布设备坐标 → 节点**局部**坐标（逆世界矩阵）。
   *
   * 节点局部坐标原点 = 节点左上角，单位 = 画布单位。
   * 世界矩阵包含：页面偏移 → 节点 x/y → 旋转(绕中心) → 缩放。
   *
   * `DOMMatrix.inverse()` 求逆 —— **不手推公式**：
   * 手推旋转 + 缩放 + 平移的组合极容易漏项，而一旦漏了，
   * 拖动会表现为"点往一个方向偏，转过的节点偏得更多"。
   */
  function canvasToLocal(nodeId, cx, cy) {
    const m = matrixOf(nodeId);
    if (!m) return null;
    const inv = new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]).inverse();
    const p = inv.transformPoint(new DOMPoint(cx, cy));
    return { x: p.x, y: p.y };
  }

  /**
   * 拿节点的**世界矩阵**（累积了父容器与自身的平移/旋转/缩放）。
   *
   * ## ⚠️ 这里踩过一个坑
   *
   * 第一版写的是 `window.selectionMatrix(node)` —— 那个函数要**两个**参数
   * `(node, m)`，只传一个时 `m` 为 undefined，直接 `return null`。
   * 现象是：`normToScreen` 全返回 null，**所有控制点都拖不动**，
   * 而且不报错（因为内部到处是 `if (!m) return null`）。
   *
   * 正确入口是 `window.deviceMatrix(nodes, id)`：它内部走 `chainOf`
   * 累积祖先链，正是任务 §D2 要求处理的「父容器变换」。
   */
  function matrixOf(nodeId) {
    if (typeof window.deviceMatrix !== "function") return null;
    const S = window.CanvasState;
    if (!S || !S.design) return null;
    return window.deviceMatrix(S.design.nodes, nodeId);
  }

  /** 节点局部坐标 → 画布设备坐标（正向，用于测试往返） */
  function localToCanvas(nodeId, lx, ly) {
    const m = matrixOf(nodeId);
    if (!m) return null;
    const p = new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]).transformPoint(new DOMPoint(lx, ly));
    return { x: p.x, y: p.y };
  }

  /** 局部坐标 → 归一化 0..1（相对节点 w/h） */
  function localToNorm(node, lx, ly) {
    const w = Math.abs(node.w) || 1;
    const h = Math.abs(node.h) || 1;
    return { x: lx / w, y: ly / h };
  }

  /** 归一化 0..1 → 局部坐标 */
  function normToLocal(node, nx, ny) {
    const w = Math.abs(node.w) || 1;
    const h = Math.abs(node.h) || 1;
    return { x: nx * w, y: ny * h };
  }

  /**
   * 归一化 → **画布位图坐标**（与 `moveDrag` / `hitPathPoint` 同一空间）。
   *
   * 不再换算成"屏幕 CSS 像素"：那需要 canvas 的 getBoundingClientRect，
   * 而位图坐标已经够用（命中与拖动的入参也都是位图坐标）。
   */
  function normToScreen(nodeId, nx, ny) {
    const node = getNode(nodeId);
    if (!node) return null;
    const l = normToLocal(node, nx, ny);
    return localToCanvas(nodeId, l.x, l.y);
  }

  // ================================================================
  // 节点与路径
  // ================================================================

  function getNode(id) {
    const S = window.CanvasState;
    if (!S || !S.design) return null;
    const list = S.design.nodes || [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
      if (list[i].children) {
        const found = findIn(list[i].children, id);
        if (found) return found;
      }
    }
    return null;
  }
  function findIn(list, id) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
      if (list[i].children) {
        const f = findIn(list[i].children, id);
        if (f) return f;
      }
    }
    return null;
  }

  /** 当前选中的 PathProgress 节点（没有则 null）*/
  function selectedPathNode() {
    const S = window.CanvasState;
    if (!S || !S.selection || S.selection.length !== 1) return null;
    const n = getNode(S.selection[0]);
    if (!n || n.type !== "pathProgress") return null;
    if (n.locked) return null;
    return n;
  }

  /** 保证节点有合法的 points 数组 */
  function pointsOf(n) {
    if (!Array.isArray(n.points) || n.points.length === 0) {
      // 默认一条水平曲线（与控件预设一致）
      n.points = [
        { x: 0, y: 1 }, { x: 0.25, y: 0.35 },
        { x: 0.6, y: 0.12 }, { x: 1, y: 0.05 },
      ];
    }
    return n.points;
  }

  // ================================================================
  // 命中（D1 第 1、2 条）
  // ================================================================

  /**
   * 在**屏幕坐标**下命中某个控制点。
   *
   * @returns {{index:number}|null}
   */
  /**
   * 在**画布位图坐标**下命中某个控制点。
   *
   * @param {object} node
   * @param {number} px 画布位图 x（canvas.js 的 `cp.x`）
   * @param {number} py
   * @returns {{index:number}|null}
   */
  function hitPathPoint(node, px, py) {
    if (!node) return null;
    const pts = pointsOf(node);
    let best = -1;
    let bestD = PT_HIT_R;
    for (let i = 0; i < pts.length; i++) {
      const sp = normToScreen(node.id, pts[i].x, pts[i].y);
      if (!sp) continue;
      const d = Math.hypot(sp.x - px, sp.y - py);
      if (d <= bestD) { bestD = d; best = i; }
    }
    return best >= 0 ? { index: best } : null;
  }

  // ================================================================
  // 拖动（D2 + D3）
  // ================================================================

  /**
   * 拖动状态。
   *
   * ⚠️ **不保存矩阵快照** —— 拖动过程中节点 w/h 不变，
   * 所以矩阵也不变；每帧重算反而引入自反馈（节点可能在拖动中被改）。
   * 但**保存拖动开始时的 points 深拷贝**，用于 Esc 取消。
   */
  const drag = {
    active: false,
    nodeId: "",
    index: -1,
    startPoints: null,
    moved: false,
    /** 拖动开始时的归一化坐标（用于判断是否真的动了）*/
    startNorm: null,
  };

  window.PathPointEditor = {
    PT_MAX: PT_MAX,
    PT_MIN: PT_MIN,

    /** 现在是否处于路径点编辑态（选中了可编辑的 PathProgress）*/
    isActive: function () {
      return !!selectedPathNode();
    },

    /** 当前编辑的节点（没有则 null）*/
    currentNode: function () {
      return selectedPathNode();
    },

    /** 当前节点是否处于拖动中 */
    isDragging: function () {
      return drag.active;
    },

    screenToCanvas: screenToCanvas,
    canvasToLocal: canvasToLocal,
    localToCanvas: localToCanvas,
    localToNorm: localToNorm,
    normToLocal: normToLocal,
    normToScreen: normToScreen,
    pointsOf: pointsOf,

    /**
     * 开始拖动一个控制点。
     *
     * @param {string} nodeId
     * @param {number} index
     * @returns {boolean} 是否成功开始
     */
    beginDrag: function (nodeId, index) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return false;
      const pts = pointsOf(n);
      if (index < 0 || index >= pts.length) return false;
      drag.active = true;
      drag.nodeId = nodeId;
      drag.index = index;
      drag.moved = false;
      drag.startNorm = { x: pts[index].x, y: pts[index].y };
      // 深拷贝用于取消
      drag.startPoints = pts.map(function (p) { return { x: p.x, y: p.y }; });
      return true;
    },

    /**
     * 拖动到屏幕坐标（sx, sy 相对 canvas 元素）。
     *
     * @returns {{x:number,y:number}|null} 新的归一化坐标
     */
    moveDrag: function (sx, sy) {
      if (!drag.active) return null;
      const n = getNode(drag.nodeId);
      if (!n) return null;
      const cv = screenToCanvas(sx, sy);
      const lp = canvasToLocal(drag.nodeId, cv.x, cv.y);
      if (!lp) return null;
      const nn = localToNorm(n, lp.x, lp.y);
      // 全程夹在 0..1（路径点不允许跑到节点外面）
      const x = Math.max(0, Math.min(1, nn.x));
      const y = Math.max(0, Math.min(1, nn.y));
      const pts = pointsOf(n);
      // 有意义的位移才算"动过"（阈值 0.2%，避免抖动也提交历史）
      if (Math.abs(x - drag.startNorm.x) > 0.002 || Math.abs(y - drag.startNorm.y) > 0.002) {
        drag.moved = true;
      }
      pts[drag.index] = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
      return pts[drag.index];
    },

    /**
     * 结束拖动。
     *
     * ## D3：**一次完整拖动 = 一条历史**
     *
     * 拖动过程中**不** push 历史（否则每移动一像素就是一条快照），
     * 只在结束时 push 一次。这与 canvas.js 里拖节点的做法一致。
     *
     * @returns {{changed:boolean}}
     */
    endDrag: function () {
      const changed = drag.active && drag.moved;
      if (drag.active && changed) pushHistory("移动路径点");
      drag.active = false;
      drag.nodeId = "";
      drag.index = -1;
      drag.startPoints = null;
      drag.startNorm = null;
      return { changed: changed };
    },

    /** 取消拖动并恢复（D3：能恢复编辑前状态）*/
    cancelDrag: function () {
      if (!drag.active) return false;
      const n = getNode(drag.nodeId);
      if (n && drag.startPoints) {
        n.points = drag.startPoints;
      }
      drag.active = false;
      drag.nodeId = "";
      drag.index = -1;
      drag.startPoints = null;
      drag.startNorm = null;
      return true;
    },

    /**
     * 添加控制点（D1 第 3 条）。
     *
     * 插入位置：**离点击处最近的那一段中间**（不是一律追加到末尾）——
     * 追加到末尾会让用户"在中间插一个点"的操作变成"末尾多点"，
     * 曲线形状完全变了。
     *
     * @param {string} nodeId
     * @param {number} sx 屏幕 x（相对 canvas）
     * @param {number} sy
     * @returns {{index:number}|{error:string}}
     */
    addPointAt: function (nodeId, sx, sy) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return { error: "不可编辑" };
      const pts = pointsOf(n);
      if (pts.length >= PT_MAX) {
        return { error: "最多 " + PT_MAX + " 个控制点（当前已是上限）" };
      }
      const cv = screenToCanvas(sx, sy);
      const lp = canvasToLocal(nodeId, cv.x, cv.y);
      if (!lp) return { error: "坐标换算失败" };
      const nn = localToNorm(n, lp.x, lp.y);

      // 找最近的一段（在归一化空间算，避免非等比 w/h 时判断错）
      let bestSeg = pts.length - 1;
      let bestD = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(nn, pts[i], pts[i + 1]);
        if (d < bestD) { bestD = d; bestSeg = i; }
      }
      const x = Math.max(0, Math.min(1, nn.x));
      const y = Math.max(0, Math.min(1, nn.y));
      const idx = bestSeg + 1;
      pts.splice(idx, 0, { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 });
      pushHistory("添加路径点");
      return { index: idx };
    },

    /** 删除控制点（D1 第 4 条）。保底 2 点。*/
    removePoint: function (nodeId, index) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return { error: "不可编辑" };
      const pts = pointsOf(n);
      if (pts.length <= PT_MIN) {
        return { error: "至少要保留 " + PT_MIN + " 个控制点" };
      }
      if (index < 0 || index >= pts.length) return { error: "索引越界" };
      pts.splice(index, 1);
      pushHistory("删除路径点");
      return { ok: true, remaining: pts.length };
    },

    /**
     * 调整控制点顺序（D1 第 5 条）。
     *
     * 路径是有方向的：第 0 个点是起点。上移/下移改变的是**绘制顺序**。
     */
    movePoint: function (nodeId, from, to) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return { error: "不可编辑" };
      const pts = pointsOf(n);
      if (from < 0 || from >= pts.length || to < 0 || to >= pts.length) {
        return { error: "索引越界" };
      }
      if (from === to) return { ok: true, moved: false };
      const [p] = pts.splice(from, 1);
      pts.splice(to, 0, p);
      pushHistory("调整路径点顺序");
      return { ok: true, moved: true, from: from, to: to };
    },

    /** 平滑 / 折线切换（D1 第 6 条）*/
    toggleCurve: function (nodeId) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return { error: "不可编辑" };
      n.curve = (n.curve === 1) ? 0 : 1;
      pushHistory("切换曲线类型");
      return { curve: n.curve };
    },

    /** 路径方向切换（D1 第 8 条）*/
    toggleForward: function (nodeId) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return { error: "不可编辑" };
      n.forward = (n.forward === false);
      pushHistory("切换进度方向");
      return { forward: n.forward };
    },

    /** 整条路径反转（点序倒过来）*/
    reversePoints: function (nodeId) {
      const n = getNode(nodeId);
      if (!n || n.type !== "pathProgress" || n.locked) return { error: "不可编辑" };
      const pts = pointsOf(n);
      pts.reverse();
      pushHistory("反转路径点序");
      return { ok: true, count: pts.length };
    },

    /**
     * 叠加绘制：曲线 + 控制点 + 首末标记（D1 第 1、7 条，D5 预览）。
     *
     * ⚠️ 在**设备坐标**里画（不在节点局部坐标）——
     * 控制点的大小必须**不随节点缩放变化**，否则缩小到 10% 时点小得点不中。
     */
    drawOverlay: function (ctx, node, m) {
      if (!node || node.type !== "pathProgress" || !m) return;
      if (window.CanvasState && window.CanvasState.selection &&
          window.CanvasState.selection.indexOf(node.id) < 0) return;
      const pts = pointsOf(node);
      if (pts.length < 1) return;

      // 归一化点 → 设备坐标
      const dev = pts.map(function (p) {
        const l = normToLocal(node, p.x, p.y);
        const q = new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]).transformPoint(new DOMPoint(l.x, l.y));
        return { x: q.x, y: q.y };
      });

      ctx.save();
      // ---- 连线（虚线，表示控制顺序）
      ctx.strokeStyle = STYLE.segment;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      dev.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.stroke();
      ctx.setLineDash([]);

      // ---- 控制点
      dev.forEach(function (p, i) {
        const isFirst = i === 0;
        const isLast = i === dev.length - 1;
        const isHot = drag.active && drag.nodeId === node.id && drag.index === i;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isHot ? PT_R + 2 : PT_R, 0, Math.PI * 2);
        ctx.fillStyle = isFirst ? STYLE.ptFirst : (isLast ? STYLE.ptLast : STYLE.ptFill);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = STYLE.ptStroke;
        ctx.stroke();
        // 序号（点多了能看出顺序）
        if (dev.length <= 12) {
          ctx.fillStyle = "#20140A";
          ctx.font = "bold 8px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i), p.x, p.y + 0.5);
        }
      });
      ctx.restore();
    },

    /** 对外暴露给测试的状态快照 */
    debugState: function () {
      return {
        active: !!selectedPathNode(),
        dragging: drag.active,
        dragIndex: drag.index,
        dragMoved: drag.moved,
      };
    },
  };

  /**
   * 记录一条历史。
   *
   * ## ⚠️ 真实入口是 `window.commit(fn, label)`，不是 `pushHistory`
   *
   * 第一版写的是 `if (typeof window.pushHistory === "function") pushHistory(...)` ——
   * 那个函数**不存在**，`typeof` 检查让整段**静默跳过**：
   * 功能看起来都对（点改成了），但撤销栈里什么都没有。
   *
   * 这是个很典型的"防御性检查掩盖真问题"——`typeof` 守卫本来是为了兼容，
   * 结果把"调了一个不存在的 API"这个错误藏起来了。
   * 现在改成：找不到 `commit` 就**明确报一次警告**，而不是永远静默。
   *
   * `window.commit(fn, label)` 的语义是「先执行 fn、再给结果拍快照」，
   * 所以这里传一个空函数（改动已经做完了）。
   */
  let warnedNoCommit = false;
  function pushHistory(label) {
    if (typeof window.commit === "function") {
      window.commit(function () { }, label);
      return true;
    }
    if (!warnedNoCommit) {
      warnedNoCommit = true;
      if (window.console && console.warn) {
        console.warn("[PathPointEditor] 找不到 window.commit —— 路径点编辑不会进撤销栈");
      }
    }
    return false;
  }

  /** 点到线段的距离（归一化空间）*/
  function distToSegment(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 <= 1e-12) return Math.hypot(wx, wy);
    let t = (wx * vx + wy * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
  }
})();
