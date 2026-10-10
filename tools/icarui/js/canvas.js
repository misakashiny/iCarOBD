/* ==========================================================================
   canvas.js —— 画布渲染与交互
   --------------------------------------------------------------------------
   坐标模型（大纲 §5）：
     节点坐标 0..360（每轴独立）→ 按 scaleMode 映射到「设计分辨率」的屏幕空间
       stretch：每轴独立拉伸（= v1 行为，默认）
       fit    ：等比，短边留黑边
       fill   ：等比，超出裁掉

   所以**画布的宽高比 = designW : designH**，设计者能直接看到会不会留黑边。

   交互：
     拖动移动 · 四角手柄缩放 · 上方圆柄旋转 · 空白拖动框选 · 多选整体移动
     吸附可关（关掉后停在任意坐标，但**边界夹取仍生效**）
     锁定的节点不响应拖动/缩放/旋转
   ========================================================================== */
"use strict";

(function () {
  const CANVAS = window.CANVAS;
  const STEP = window.STEP;
  const MIN_SIZE = window.MIN_SIZE;

  const cv = document.getElementById("cv");
  // ⚠️ 用 `let` 而不是 `const`：控件编辑器的**预览**要临时把绘制目标换成另一个画布，
  // 而所有绘制函数都闭包引用这个变量。换成 const 就没法复用了。
  let ctx = cv.getContext("2d");
  /** 临时切换绘制目标（只给 drawNodePreview 用）。返回原来的，调用方负责切回 */
  function swapContext(c) { const old = ctx; ctx = c; return old; }

  /** 画布状态（由 app.js 装配） */
  const S = {
    design: null,
    selection: [],        // 选中的节点 id
    snap: true,
    /**
     * **当前选中的子部件下标**（v2.32.0）。-1 = 没选部件（选的是整个仪表）。
     *
     * 放在全局状态里而不是节点上：它是**交互状态**（"我现在在编辑哪个部件"），
     * 不是设计数据，不该进设计文件。
     */
    selectedPart: -1,
  /**
   * **等比缩放锁**（v2.21.0）。默认 **true**。
   *
   * 为什么默认开：拖角手柄自由拉伸时，图片素材会**立刻变形** ——
   * 而绝大多数情况下用户只是想"放大一点"，不是想改比例。
   * 想自由拉伸时按住 **Alt** 或关掉属性面板里的「等比」即可。
   */
  aspectLock: true,
    /** 当前进入的分组路径（空 = 在画布层）。面包屑用它 */
    drillPath: [],
      /** 拖动时是否做**对齐吸附**（与网格吸附是两回事，可分别开关） */
      snapGuides: true,
      /** 当前显示的对齐参考线（拖动中才有，松手清掉） */
      snapLines: null,
    showGrid: true,
    /** 画布上的控件是否显示 PID id（顶栏 🏷 PID 切换） */
    showPid: false,
    previewValues: null,  // {pidId: value} 实时模拟注入的值
    /**
     * **弹簧池**（v2.81.0）：实时模拟时指针/弧/鼓的**位置**。
     *
     * ⚠️ 与 `previewValues` 的分工是**刻意的**：
     *   - `previewValues` 是**真值** —— 数字读数、条形、状态灯、阈值判定都读它
     *   - `simSprings` 是**机械位置** —— 只有"会动的金属件"（指针）读它
     *
     * 读数跟着弹簧走的话，一个 1234 的转速会被显示成 1187.4 这种"没意义的小数"，
     * 而阈值判定会**晚到**（弹簧到位需要时间）—— 那是错的，真车上报警是即时的。
     */
    simSprings: null,
    /** 属性让位仲裁（v2.81.0）。见 spring.js 的 `AnimArbiter` */
    anim: null,
    /**
     * **补间值**（v2.81.0）：由"作者编排的动画"写（比如开机自检扫表）。
     *
     * 与 `previewValues` 同一形状。让位标志指向 `"tween"` 时，指针读这里而不是弹簧 ——
     * 这就是参考实现里"主循环每帧覆写 rotation，把扫表压掉"那个坑的解药。
     */
    tweenValues: null,
    assetUrls: {},        // assetId -> objectURL（本机预览）
    thumbs: {},           // assetId -> dataURL（localStorage 缓存）
    drag: null,
    marquee: null,
    hoverHandle: -1,
  };
  window.CanvasState = S;

  // 弹簧池与让位仲裁**在这里建**（v2.81.0）：渲染层要读它们，
  // 而 app.js 比 canvas.js 晚加载。参数（k/c）由 app.js 从界面设置里灌进来。
  S.simSprings = new window.SpringBank();
  S.anim = new window.AnimArbiter();

  const HANDLE = 9;       // 手柄边长（屏幕 px）
  const ROT_OFFSET = 26;  // 旋转柄离顶边的距离

  // ================================================================ 坐标换算

  /** 设计分辨率 → 画布位图的缩放（画布位图宽高比 = designW:designH） */
  function designToCanvas() {
    const d = S.design;
    return { kx: cv.width / d.canvas.designW, ky: cv.height / d.canvas.designH };
  }

  /**
   * 节点坐标（0..360）→ 画布位图坐标的矩阵。
   *
   * 这是 scaleMode 唯一生效的地方 —— 节点坐标语义不变。
   */
  function nodeToCanvasMatrix() {
    const d = S.design;
    const W = cv.width, H = cv.height;
    const mode = d.canvas.scaleMode;
    if (mode === window.SCALE_FIT) {
      const k = Math.min(W / CANVAS, H / CANVAS);
      return { a: k, b: 0, c: 0, d: k, e: (W - CANVAS * k) / 2, f: (H - CANVAS * k) / 2 };
    }
    if (mode === window.SCALE_FILL) {
      const k = Math.max(W / CANVAS, H / CANVAS);
      return { a: k, b: 0, c: 0, d: k, e: (W - CANVAS * k) / 2, f: (H - CANVAS * k) / 2 };
    }
    // stretch：每轴独立
    return { a: W / CANVAS, b: 0, c: 0, d: H / CANVAS, e: 0, f: 0 };
  }
  window.nodeToCanvasMatrix = nodeToCanvasMatrix;

  /** 画布位图坐标 → 节点坐标（交互反算用） */
  function canvasToNode(px, py) {
    const inv = window.matInvert(nodeToCanvasMatrix());
    return window.matApply(inv, px, py);
  }
  window.canvasToNode = canvasToNode;

  /** 事件坐标 → 画布位图坐标 */
  function eventPos(ev) {
    const r = cv.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / r.width * cv.width,
      y: (ev.clientY - r.top) / r.height * cv.height,
    };
  }

  /** 节点坐标 → 屏幕 px 的尺度（用于把 MIN_SIZE 之类换成屏幕尺寸） */
  function nodeScale() {
    const m = nodeToCanvasMatrix();
    return Math.abs(m.a);
  }

  // ================================================================ 吸附

  /**
   * **对齐吸附**：拖动时吸附到其他节点的边/中心，以及画布的边/中线。
   *
   * ## 为什么阈值用**设备像素**换算
   * 画布可能被缩放（缩放到 50% 时 6 个画布单位只有 3 个屏幕像素，手感会"吸不住"）。
   * 所以阈值定义在**屏幕空间**，再除以缩放换算回画布单位 —— 这样任何缩放级别下
   * 手感一致。
   *
   * ## 三条候选线各是什么
   * 每个节点贡献 **左 / 中 / 右** 与 **上 / 中 / 下** 六条线；
   * 画布贡献 **0 / 中线 / 360** 六条。被拖动的节点也拿这三条去比，
   * 取**最近的一对**（不是逐个轴独立取，否则左边缘吸一个、右边缘吸另一个，会变形）。
   *
   * @returns {{dx:number, dy:number, guides:Array}} 吸附修正量 + 要画的参考线
   */
  function computeSnap(moving, others) {
    // ⚠️ 阈值要按**实际屏幕像素**算，不能写死成画布单位。
    //
    // 换算链：画布单位 → 画布位图像素（×zoom）→ CSS 像素（×cvRect.width/cv.width）。
    // 只除 zoom 是不够的：高分屏（devicePixelRatio 2）下位图被放大到 2 倍 CSS 尺寸，
    // 6 个画布单位实际有 12 个 CSS 像素，"吸附感"会变得很黏。
    const THRESH_CSS_PX = 6;
    const cvEl = document.getElementById("cv");
    const zoom = S.zoom || 1;
    let bitmapToCss = 1;
    if (cvEl && cvEl.width > 0) {
      const r = cvEl.getBoundingClientRect();
      if (r.width > 0) bitmapToCss = r.width / cvEl.width;
    }
    const th = THRESH_CSS_PX / Math.max(0.001, zoom * bitmapToCss);

    const xs = [], ys = [];
    // 画布自身的边与中线
    xs.push({ v: 0, from: "canvas" }, { v: CANVAS / 2, from: "canvas" }, { v: CANVAS, from: "canvas" });
    ys.push({ v: 0, from: "canvas" }, { v: CANVAS / 2, from: "canvas" }, { v: CANVAS, from: "canvas" });
    others.forEach(o => {
      xs.push({ v: o.x, from: o.id }, { v: o.x + o.w / 2, from: o.id }, { v: o.x + o.w, from: o.id });
      ys.push({ v: o.y, from: o.id }, { v: o.y + o.h / 2, from: o.id }, { v: o.y + o.h, from: o.id });
    });

    // 被拖动集合的**包围盒**（多个一起拖时按整体对齐，而不是各自吸各自的）
    const bx0 = Math.min.apply(null, moving.map(m => m.x));
    const by0 = Math.min.apply(null, moving.map(m => m.y));
    const bx1 = Math.max.apply(null, moving.map(m => m.x + m.w));
    const by1 = Math.max.apply(null, moving.map(m => m.y + m.h));

    function best(edges, cands) {
      let bd = null;
      edges.forEach(e => cands.forEach(c => {
        const d = c.v - e.v;
        if (Math.abs(d) <= th && (bd === null || Math.abs(d) < Math.abs(bd.d))) {
          bd = { d: d, at: c.v, from: c.from };
        }
      }));
      return bd;
    }
    const sx = best([{ v: bx0 }, { v: (bx0 + bx1) / 2 }, { v: bx1 }], xs);
    const sy = best([{ v: by0 }, { v: (by0 + by1) / 2 }, { v: by1 }], ys);

    const guides = [];
    if (sx) guides.push({ axis: "x", at: sx.at, from: sx.from });
    if (sy) guides.push({ axis: "y", at: sy.at, from: sy.from });
    return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0, guides: guides };
  }
  // 暴露出来**便于单测直接验证吸附逻辑** ——
  // 靠合成 PointerEvent 驱动拖动很脆（拿不到 pointerId / 指针捕获），
  // 测出来的失败往往分不清是"逻辑错"还是"事件没进去"
  window.computeSnap = computeSnap;

  function snapIf(v) {
    return S.snap ? Math.round(v / STEP) * STEP : v;
  }
  window.snapIf = snapIf;

  /** 移动：按需吸附，再夹进 0..360（**夹取永远生效**，与吸附开关无关） */
  function moveVal(orig, delta, size) {
    return clamp(snapIf(orig + delta), 0, Math.max(0, CANVAS - size));
  }
  /** 缩放：按需吸附，夹住最小尺寸与右下边界 */
  function resizeVal(orig, delta, pos) {
    return clamp(snapIf(orig + delta), MIN_SIZE, Math.max(MIN_SIZE, CANVAS - pos));
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  window.clamp = clamp;

  // ================================================================ 渲染

  /** 画布用色。每次 draw 刷新一次 —— 切主题后立刻生效 */
  let C = null;

  /**
   * **这一帧的解析视图**（v2.80.2 第 5 步，规格 §4）。
   *
   * 画布画的必须是 `window.resolveDesign(S.design)` 的输出 —— 与导出
   * （`model.js` 的 `toV2Json`）**同一个函数**。§4 那句话是踩过坑才写下的：
   * v2.49.0 时 `model.js` 自己拼 `themeColors`、而画布不读它，
   * 于是"切主题画布完全不变"。两处实现迟早分叉，症状就是
   * 「画布上看到的」和「导出后 App 看到的」不一样。
   *
   * ⚠️ **一帧只解析一次**（`draw()` 开头赋值）：
   *   · 性能：解析是深拷贝，每个绘制函数各自解析一遍是纯浪费
   *   · 更重要的是**一致性**：同一帧里两处拿到不同的视图，
   *     画面会撕裂（比如一半是新绑定值、一半是旧值）
   */
  let RD = null;

  /**
   * 当前生效的主题配色：**只认解析视图**。
   *
   * 兜底走 `window.currentTheme()`（老路径：内置主题 + `themeColorsOverride`），
   * 只在"解析视图没给出配色"时才会用到 —— 也就是**没主题、也没覆盖**的设计，
   * 那时 `currentTheme()` 返回的正好是内置 `neon`，与改动前的画布完全一致
   *（所以这条兜底不会让任何一份存量设计的画面变色）。
   */
  function themeColors() {
    if (RD && RD.themeColors) return RD.themeColors;
    return window.currentTheme ? window.currentTheme() : {};
  }

  function draw() {
    if (!S.design) return;
    // ---- 第 5 步：**渲染前走唯一入口**（§4）
    //
    // 把 bindings 的字面值、`text` 的 `$$` 反转义、模式解析出来的配色
    // 一次性算好；下面全部读这一份。
    // `S.design` 一个字都不改（解析结果只是"这一帧的视图"）——
    // 用户的编辑永远作用在 bindings / nodes 上，不会因为画一次就被写回。
    RD = window.resolveDesign ? window.resolveDesign(S.design) : null;
    C = window.readCanvasColors();
    const W = cv.width, H = cv.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // 画布外的区域（fit 模式的留边）用另一种底色，让"留黑边"一眼可见
    ctx.fillStyle = C.out;
    ctx.fillRect(0, 0, W, H);
    // ⚠️ **画布内 = 设计的背景，要跟设计主题**（v2.56.0）。
    //
    // 原来读的是 CSS 变量 `--cvIn`（工具自己的画布底色），
    // 所以切主题时**画布这一大片完全不变** —— 那是屏幕上面积最大的地方，
    // "主题没生效"的观感有一大半来自这里。
    //
    // 注意与上一行 `C.out`（画布外的留边）的区别：
    //   `C.out` 是**工具 UI 层**（"这里不是设计区"的提示），不跟主题；
    //   `C.in`  是**设计内容**（App 里的仪表背景就是它），跟主题。
    ctx.fillStyle = themeColors().background || C.in;
    const m0 = nodeToCanvasMatrix();
    ctx.fillRect(m0.e, m0.f, CANVAS * m0.a, CANVAS * m0.d);

    if (S.showGrid) drawGrid();

    // 背景图（设计级）
    drawBackground();

    // 节点树（按 z 升序 = 先画在下）
    //
    // ⚠️ 画的是**解析视图**里的 `nodes`（第 5 步），不是 `S.design.nodes`：
    // 绑定的字段（颜色 / 文字 / 圆角 / 透明度）只有解析后才生效。
    // 命中测试、选中框、面板仍然用 `S.design.nodes` —— 它们要改的是**真相**，
    // 而不是"这一帧看起来的样子"。
    const M = nodeToCanvasMatrix();
    drawList(RD ? RD.nodes : S.design.nodes, M);

    // 选择框与手柄（画在最上）
    drawSelection();

    // 框选矩形
    if (S.marquee) {
      const a = S.marquee;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = "#00D8FF";
      ctx.fillStyle = "rgba(0,216,255,0.12)";
      ctx.lineWidth = 1;
      const x = Math.min(a.x0, a.x1), y = Math.min(a.y0, a.y1);
      const w = Math.abs(a.x1 - a.x0), h = Math.abs(a.y1 - a.y0);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }

    // 对齐参考线
    //
    // 画在**屏幕坐标系**里（setTransform 已复位）—— 参考线要 1px 清晰，
    // 跟着画布缩放会变粗变虚。
    if (S.snapLines && S.snapLines.length) {
      const M = nodeToCanvasMatrix();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.lineWidth = 1;
      S.snapLines.forEach(g => {
        // 参考线贯穿整个画布，方便看清"和谁对齐了"
        if (g.axis === "x") {
          const px = Math.round(M.e + g.at * M.a) + 0.5;
          ctx.strokeStyle = g.from === "canvas" ? "#FFB020" : "#FF4DD2";
          ctx.beginPath();
          ctx.moveTo(px, Math.round(M.f) + 0.5);
          ctx.lineTo(px, Math.round(M.f + CANVAS * M.d) + 0.5);
          ctx.stroke();
        } else {
          const py = Math.round(M.f + g.at * M.d) + 0.5;
          ctx.strokeStyle = g.from === "canvas" ? "#FFB020" : "#FF4DD2";
          ctx.beginPath();
          ctx.moveTo(Math.round(M.e) + 0.5, py);
          ctx.lineTo(Math.round(M.e + CANVAS * M.a) + 0.5, py);
          ctx.stroke();
        }
      });
    }
  }
  window.draw = draw;

  /**
   * 选择变化时同步下钻路径。
   *
   * 场景：用户在控件树里点了**别的分组**里的节点 —— 面包屑必须跟着走，
   * 否则会出现"面包屑说在 A 组、实际选的是 B 组的控件"这种自相矛盾的状态。
   */
  window.syncDrillToSelection = function () {
    if (!S.design) return;
    const id = S.selection[0];
    if (!id) return;
    const chain = groupChainOf(id);
    const cur = (S.drillPath || []).join(",");
    const nxt = chain.map(g => g.id).join(",");
    if (cur !== nxt) { S.drillPath = chain.map(g => g.id); updateBreadcrumb(); }
  };

  function drawGrid() {
    const M = nodeToCanvasMatrix();
    ctx.setTransform(M.a, M.b, M.c, M.d, M.e, M.f);
    ctx.lineWidth = 1 / Math.max(0.001, M.a);
    ctx.strokeStyle = C.grid;
    for (let i = 0; i <= window.GRID; i++) {
      const p = i * STEP;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, CANVAS); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(CANVAS, p); ctx.stroke();
    }
    ctx.strokeStyle = C.gridAxis;
    ctx.beginPath(); ctx.moveTo(180, 0); ctx.lineTo(180, CANVAS); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 180); ctx.lineTo(CANVAS, 180); ctx.stroke();
  }

  function drawBackground() {
    const d = S.design;
    if (!d.background || !d.background.path) return;
    const img = S.bgImage;
    if (!img || !img.complete || !img.naturalWidth) return;
    const M = nodeToCanvasMatrix();
    const W = CANVAS * M.a, H = CANVAS * M.d;
    const fit = d.background.fit;

    // 显式尺寸（画布单位）：填了就按它画，铺法只决定**在这个框里**怎么放
    const bw = (d.background.w || 0) * M.a;
    const bh = (d.background.h || 0) * M.d;
    const boxW = bw > 0 ? bw : W;
    const boxH = bh > 0 ? bh : H;
    const boxX = M.e + (W - boxW) / 2;
    const boxY = M.f + (H - boxH) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(M.e, M.f, W, H);
    ctx.clip();
    if (fit === window.FIT_FIT) {
      const k = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
      const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
      ctx.drawImage(img, boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh);
    } else if (fit === window.FIT_CENTER) {
      ctx.drawImage(img, boxX + (boxW - img.naturalWidth) / 2, boxY + (boxH - img.naturalHeight) / 2);
    } else if (fit === window.FIT_TILE) {
      // 平铺：按原图尺寸重复。
      // ⚠️ 原图比框还大时平铺没意义（只看到一块），所以先缩到不超框再铺 ——
      // 这与 App 侧"先按屏幕尺寸缩放再平铺"是同一套规则（见 DesignFile.FIT_TILE 注释）。
      let tw = img.naturalWidth, th = img.naturalHeight;
      const maxK = Math.min(boxW / tw, boxH / th, 1);
      tw *= maxK; th *= maxK;
      const cols = Math.ceil(boxW / tw), rows = Math.ceil(boxH / th);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.drawImage(img, boxX + c * tw, boxY + r * th, tw, th);
        }
      }
    } else {
      // 铺满：填满框（框默认就是整块画布）
      const k = Math.max(boxW / img.naturalWidth, boxH / img.naturalHeight);
      const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
      ctx.drawImage(img, boxX + (boxW - dw) / 2, boxY + (boxH - dh) / 2, dw, dh);
    }
    ctx.restore();

    // 指定了尺寸时画个虚线框，让"背景被放在哪"看得见
    if (bw > 0 || bh > 0) {
      ctx.save();
      ctx.strokeStyle = "rgba(0,216,255,0.45)";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
      ctx.restore();
    }
  }

  /**
   * 把**单个节点**画到一个独立的小画布上（控件编辑器的预览用）。
   *
   * 复用同一套绘制代码（临时把绘制目标换成预览画布），所以预览与画布**一定一致** ——
   * 不另写一份"差不多的"绘制。这是 `ctx` 用 `let` 的唯一理由。
   */
  window.drawNodePreview = function (node, canvasEl) {
    if (!node || !canvasEl) return;
    const ctx2 = canvasEl.getContext("2d");
    const W = canvasEl.width, H = canvasEl.height;
    const C2 = window.readCanvasColors();
    const saved = swapContext(ctx2);
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = C2.out;
      ctx.fillRect(0, 0, W, H);
      const pad = 8;
      const k = Math.min((W - pad * 2) / Math.max(1, node.w), (H - pad * 2) / Math.max(1, node.h));
      const m = { a: k, b: 0, c: 0, d: k, e: (W - node.w * k) / 2, f: (H - node.h * k) / 2 };
      const dm = withDeviceRotation(m, node);
      drawNode(node, dm, m);
      if (node.children && node.children.length) drawList(node.children, dm);
    } finally {
      // ⚠️ 复位必须在 **swapContext 之前** —— 原来写在 finally 之后，
      // 那时 ctx 已经被换回**主画布**的 context，于是把主画布的变换重置成了单位阵。
      // 虽然每帧 draw() 会自己设变换（所以没炸），但这是实打实的写错对象。
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      swapContext(saved);
    }
  };

  /**
   * 在**设备空间**绕盒子中心施加旋转。
   *
   * ## 为什么旋转必须在这里加，而不是在 `localMatrix` 里（真 bug）
   *
   * `stretch` 缩放模式下，节点坐标 → 画布位图是**每轴独立**的（16:10 屏 2.183 × 1.364）。
   * 如果旋转写在节点空间（`画布矩阵 · … · R(θ)`），就成了"先旋转、再非等比拉伸" ——
   * 矩形被拉成**平行四边形**，而且内容尺度随角度变。实测：
   *
   * | 角度 | 外框 | 内容尺度 |
   * |---|---|---|
   * | 0° | 矩形 | 1.364 |
   * | 15° | 平行四边形（相邻边不垂直，cos=-0.237） | 1.433 |
   * | 45° | 平行四边形（对角线差 209px） | **1.820（+33%）** |
   *
   * 用户看到的正是"旋转时外框歪掉、控件还会变大"。
   *
   * **App 侧是"先排好版、再旋转"**（`view.rotation = θ` 转的是设备盒子），
   * 得到旋转矩形、尺寸恒定。所以这里也按那个顺序：
   * `T(设备中心) · R(θ) · T(-设备中心) · 盒子矩阵`。
   *
   * @param bm 盒子矩阵（节点局部 → 画布位图，**不含旋转**）
   * @param n  节点（取 rotation 与 w/h）
   */
  function withDeviceRotation(bm, n) {
    const deg = n.rotation || 0;
    if (!deg) return bm;
    const c = window.matApply(bm, n.w / 2, n.h / 2);
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const R = {
      a: cos, b: sin, c: -sin, d: cos,
      e: c.x - (cos * c.x - sin * c.y),
      f: c.y - (sin * c.x + cos * c.y),
    };
    return window.matMul(R, bm);
  }
  window.withDeviceRotation = withDeviceRotation;

  /**
   * 节点在**设备（画布位图）空间**的矩阵：盒子矩阵 + **逐层**在设备空间施加旋转。
   *
   * ⚠️ 必须**累积祖先的旋转**。第一版只施加了节点自己的旋转，
   * 结果是"把分组转了 40°，里面的子控件纹丝不动" —— 那分组旋转就没意义了。
   *
   * 施加顺序（从根往下，每层都在**设备空间**绕该层的盒子中心转）：
   * ```
   * m = 画布矩阵
   * for 每层 n（根 → 目标）:
   *     m = m · 盒子(n)          // 平移 + 缩放（不含旋转）
   *     m = R(n.旋转, 绕 m 下 n 的中心) · m
   * ```
   * 这样每层得到的是**旋转矩形**，不会因为画布非等比而被斜切。
   */
  function deviceMatrix(nodes, id) {
    const chain = window.chainOf(nodes, id);
    if (!chain) return null;
    let m = nodeToCanvasMatrix();
    for (let i = 0; i < chain.length; i++) {
      m = window.matMul(m, window.localMatrix(chain[i]));
      m = withDeviceRotation(m, chain[i]);
    }
    return m;
  }
  window.deviceMatrix = deviceMatrix;

  /** 设备空间下的四角（含旋转）。画选择框用 */
  function deviceCorners(id) {
    const m = deviceMatrix(S.design.nodes, id);
    const n = window.findNode(S.design.nodes, id);
    if (!m || !n) return null;
    return [
      window.matApply(m, 0, 0), window.matApply(m, n.w, 0),
      window.matApply(m, n.w, n.h), window.matApply(m, 0, n.h),
    ];
  }

  /** 设备空间下的轴对齐包围盒（含旋转） */
  function deviceBounds(id) {
    const c = deviceCorners(id);
    if (!c) return null;
    const xs = c.map(p => p.x), ys = c.map(p => p.y);
    return {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
    };
  }
  window.deviceBounds = deviceBounds;

  /**
   * 命中测试（**设备坐标**）。
   *
   * 为什么必须在设备空间：旋转是在设备空间施加的，所以在 0..360 空间里
   * 一个旋转过的控件**不是矩形**（是被斜切的四边形）。在节点空间做矩形判定
   * 会点错位置。设备空间里它就是标准矩形，反变换 + 范围判断即可。
   *
   * 从"最上面"往下找（同层 z 大者在上；子节点优先于父节点）。
   */
  function hitTestDevice(nodes, px, py) {
    let hit = null;
    function rec(list) {
      for (const n of window.sortByZ(list).reverse()) {
        if (!n.visible) continue;
        if (n.children && n.children.length) rec(n.children);
        if (hit) return;
        const m = deviceMatrix(nodes, n.id);
        if (!m) continue;
        const inv = window.matInvert(m);
        if (!inv) continue;
        const p = window.matApply(inv, px, py);
        if (p.x >= 0 && p.x <= n.w && p.y >= 0 && p.y <= n.h) { hit = n; return; }
      }
    }
    rec(nodes);
    return hit;
  }
  /** 兼容旧名字（外部脚本用过 `window.hitTest`），语义已改为设备坐标 */
  window.hitTest = hitTestDevice;
  window.hitTestDevice = hitTestDevice;

  /**
   * 递归画一层。
   *
   * @param list 节点数组
   * @param boxM 父级累积的矩阵（节点坐标 → 画布位图）。**含祖先的旋转** ——
   *             所以分组旋转时子控件会跟着转（这才是"打组"该有的样子）
   */
  function drawList(list, boxM) {
    window.sortByZ(list).forEach(n => {
      if (!n.visible) return;
      const bm = window.matMul(boxM, window.localMatrix(n));
      const dm = withDeviceRotation(bm, n);
      drawNode(n, dm, bm);
      // ⚠️ 传下去的是 `dm`（含本层旋转），不是 `bm`。
      // 第一版传了 bm，结果"分组转了、子控件不转"。
      if (n.children && n.children.length) drawList(n.children, dm);
    });
  }

  /**
   * 从（**可能非等比**的）矩阵里取出"等效等比"矩阵，用于画节点**内容**。
   *
   * ## 为什么必须有这一步（这是个真 bug，不是洁癖）
   *
   * `stretch` 缩放模式下，节点坐标 → 画布位图的矩阵是**每轴独立**的：
   * 16:10 画布上 `a = W/360 = 2.18` 而 `d = H/360 = 1.36`。
   * 直接拿这个矩阵画内容，结果是：
   *   - 文字被**横向拉伸 1.6 倍**（看着"分辨率不对劲、特别大"）
   *   - 圆变成椭圆
   *
   * 而 **App 侧并不是这样**：View 的盒子按每轴归一化（所以盒子确实非正方），
   * 但 `CircularGaugeView` 画圆用的是 `min(w, h) * 0.36` —— 圆还是圆。
   * 也就是说：**盒子会拉伸，内容不会**。
   *
   * 所以这里也照做：盒子用真实矩阵画，内容用 `min(sx, sy)` 的等比矩阵画。
   *
   * @param m 节点局部 → 画布位图的真实矩阵
   * @param w 节点宽（局部单位）
   * @param h 节点高（局部单位）
   */
  /**
 * **选中框 / 手柄 / 命中测试**统一用的矩阵（v2.25.0）。
 *
 * ## 为什么不能直接用 deviceMatrix
 *
 * 节点**内容**是用 [uniformMatrix] 画的（等比、居中）—— 因为 App 侧
 * 也是"盒子按每轴归一化，但内容用 min(w,h) 画"。
 *
 * 而 `deviceMatrix` 在 `stretch` 模式下是**每轴独立**的。两者差一个拉伸倍数：
 *
 * | 用例 | deviceMatrix 盒 | uniformMatrix 盒 |
 * |---|---|---|
 * | 200×200 表（16:10 画布） | 481×301 | **301×301** |
 * | 240×120 表 | 577×180 | **361×180** |
 *
 * 蓝色框按 deviceMatrix 画 → 比看得见的内容**宽 1.6 倍**（用户报的"边框偏大号"）。
 *
 * ## 统一之后还顺带修了一个手感问题
 *
 * 原来拖角手柄时，**内容会落后于手柄** —— 手柄移动 10px，内容只动 6.2px。
 * 统一到内容矩阵后两者 1:1 跟手。
 *
 * ⚠️ 图片节点例外：图片是按盒子拉伸画的（`drawImageNode` 用原始矩阵），
 * 所以它的框就该是原始盒子。
 */
function selectionMatrix(n, m) {
  if (!m) return null;
  if (!n) return m;
  return n.type === window.NODE_IMAGE ? m : uniformMatrix(m, n.w, n.h);
}
window.selectionMatrix = selectionMatrix;

function uniformMatrix(m, w, h) {
    const sx = Math.hypot(m.a, m.b);      // 第一列长度 = x 方向每单位多少像素
    const sy = Math.hypot(m.c, m.d);      // 第二列长度 = y 方向每单位多少像素
    const k = Math.min(sx, sy);           // 取小的 —— 与 App 的 min(w,h) 一致
    const rot = Math.atan2(m.b, m.a);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    // 盒子中心在设备空间的位置
    const cx = m.a * (w / 2) + m.c * (h / 2) + m.e;
    const cy = m.b * (w / 2) + m.d * (h / 2) + m.f;
    // T(cx,cy) · R · S(k) · T(-w/2,-h/2)
    return {
      a: cos * k, b: sin * k,
      c: -sin * k, d: cos * k,
      e: cx - (cos * k * (w / 2) - sin * k * (h / 2)),
      f: cy - (sin * k * (w / 2) + cos * k * (h / 2)),
    };
  }
  window.uniformMatrix = uniformMatrix;

  /**
   * 画一个节点。
   *
   * @param m  设备矩阵（**含**设备空间旋转）
   * @param bm 盒子矩阵（不含旋转）—— 只有分组虚线框需要它来判断"盒子被拉伸成什么样"
   *
   * 盒子/图片用设备矩阵（要如实显示拉伸与旋转），仪表/文字用等比矩阵（要不变形）。
   */
  function drawNode(n, m, bm) {
    // 图片：按盒子拉伸（相当于 ImageView 的 FIT_XY，背景图就该铺满）
    const isImage = n.type === window.NODE_IMAGE;
    const cm = isImage ? m : uniformMatrix(m, n.w, n.h);

    ctx.save();
    ctx.setTransform(cm.a, cm.b, cm.c, cm.d, cm.e, cm.f);
    ctx.globalAlpha = (n.alpha === undefined ? 255 : n.alpha) / 255;

    if (n.type === window.NODE_GAUGE) drawGaugeNode(n);
    else if (isImage) drawImageNode(n);
    else if (n.type === window.NODE_TEXT) drawTextNode(n);
    // 分组：**不画任何东西**。
    //
    // 第一版给分组画了个紫色虚线框，用户明确说"不需要紫色的虚线" ——
    // 它平时挡视线（分组是逻辑容器，不是可见元素），选中时已经有青色选择框了。
    // 想知道分组范围/层级，看**控件树**。

    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }

  /**
   * 字号按**控件尺寸成比例**，而不是固定 11px。
   *
   * 固定字号在 90 单位的小表上是 12%（显得巨大），在 240 单位的大表上只有 4.6%。
   * 按 `min(w,h)` 折算后大小表观感一致。
   */
  function fontFor(n, ratio, minPx, maxPx) {
    const base = Math.min(Math.abs(n.w), Math.abs(n.h));
    return clamp(base * ratio, minPx, maxPx);
  }
  window.fontFor = fontFor;

  function drawImageNode(n) {
    // 状态系统：先解析当前该显示哪个状态（预览用模拟值，没有就用 normal）
    const st = resolveState(n);
    const assetId = st && st.assetId ? st.assetId : n.assetId;
    const url = S.assetUrls[assetId] || S.thumbs[assetId];
    if (url && S.imgCache[url] && S.imgCache[url].complete && S.imgCache[url].naturalWidth) {
      ctx.drawImage(S.imgCache[url], 0, 0, n.w, n.h);
    } else {
      // 没有素材：画占位框 + 名字，让设计者知道这里该有图
      ctx.fillStyle = "rgba(124,92,255,0.14)";
      ctx.fillRect(0, 0, n.w, n.h);
      ctx.strokeStyle = "rgba(124,92,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(0.5, 0.5, n.w - 1, n.h - 1);
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(n.w, n.h);
      ctx.moveTo(n.w, 0); ctx.lineTo(0, n.h);
      ctx.stroke();
      ctx.fillStyle = "#B9A8FF";
      ctx.font = fontFor(n, 0.16, 7, 28) + "px " + window.fontCss("sans");
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(clipText(n.name, n.w * 0.9), n.w / 2, n.h / 2);
    }
    // 状态系统：右上角标出**当前是哪个状态**
    //
    // 只在**实时模拟开着**时才写状态名 —— 平时摆位置时那行字纯属挡视线。
    // 但那个小圆点一直在（一眼看出这个控件有没有状态系统）。
    if (n.states) {
      const name = resolveStateName(n);
      ctx.fillStyle = st && st.blink ? "#FF4D4F" : "#FFB020";
      ctx.beginPath();
      ctx.arc(n.w - 6, 6, 4, 0, Math.PI * 2);
      ctx.fill();
      if (S.previewValues) {
        const label = (window.STATE_NAMES.find(x => x.v === name) || {}).n || name;
        const fs3 = fontFor(n, 0.11, 6, 16);
        ctx.font = fs3 + "px " + window.fontCss("sans");
        ctx.textAlign = "right"; ctx.textBaseline = "top";
        ctx.fillStyle = st && st.blink ? "#FF4D4F" : "#FFB020";
        ctx.fillText(label, n.w - 12, 2);
      }
    }
  }

  /**
   * 文字控件。字体来自 `n.font`（family / size / weight / italic /
   * letterSpacing / align / color），用 `fontShort` 拼 canvas 的 font 简写。
   *
   * 对齐直接映射 canvas 的 textAlign。暂不支持换行（单行）。
   */
  function drawTextNode(n) {
    const f = window.normalizeFont(n.font);
    // ⚠️ **没显式设色时用主题的 label**（v2.58.0）。
    //
    // `f` 是 `Object.assign({}, FONT_DEFAULT, part.font)` ——
    // 用户没设色时 `f.color` 就是 `FONT_DEFAULT.color`（**写死的**），
    // 于是拼装表的文字**不跟主题**。
    //
    // 判据与 `drawGaugeLabel` 完全一致：等于默认值就视为"没设过"。
    ctx.fillStyle = (f.color && f.color !== window.FONT_DEFAULT.color)
      ? f.color
      : (themeColors().label || f.color);
    ctx.font = window.fontShort(f);
    ctx.textAlign = f.align;
    ctx.textBaseline = "middle";
    const x = f.align === "center" ? n.w / 2 : (f.align === "right" ? n.w : 0);
    if (f.letterSpacing) {
      drawSpaced(n.text, x, n.h / 2, f);       // 有字距时逐字画
    } else {
      ctx.fillText(clipText(n.text, n.w), x, n.h / 2);
    }
  }

  /**
   * 逐字画以实现字距。
   *
   * 为什么不用 `ctx.letterSpacing`：那是较新的 API（Chrome 99+），
   * 而本工具要求"双击即用"，不能假设用户浏览器够新。逐字画在所有浏览器都一样。
   */
  function drawSpaced(text, x, y, f) {
    const chars = String(text).split("");
    const total = chars.reduce((s, c) => s + ctx.measureText(c).width + f.letterSpacing, 0) - f.letterSpacing;
    let cx = f.align === "center" ? x - total / 2 : (f.align === "right" ? x - total : x);
    const prev = ctx.textAlign;
    ctx.textAlign = "left";
    chars.forEach(c => {
      ctx.fillText(c, cx, y);
      cx += ctx.measureText(c).width + f.letterSpacing;
    });
    ctx.textAlign = prev;
  }

  /** 仪表节点：示意画法（位置与比例准，细节不追求与 App 一致） */
  /**
   * 画表上的文字：名字 / PID / 量程 / 右下角的样式标签。
   *
   * 抽出来是因为**两条绘制路径都要它**：程序化画法（按 style）与
   * 部件拼装（按 parts）。复制一份迟早分叉。
   */
  function drawGaugeLabel(n, label, unit, style, card) {
    // 主题色（v2.57.0）：标签 / 刻度 / 数值的颜色跟着设计主题走。
    //
    // v2.50.0 试过接这 4 处，当时 `verify-font` 红了 2 条，误判成"标签色导致"。
    // 真相是**指纹太稀疏**（v2.55.0 已修：步长 331→97、四通道）。
    //
    // v2.80.2：改读 [themeColors]（= 解析视图里的 `themeColors`）——
    // 模式 / 变量改出来的配色必须立刻反映到画布上，与导出同一份来源。
    const T = themeColors();
      // 标签与量程
      // ⚠️ 字号按控件尺寸成比例（固定 11px 在 90 单位的小表上占 12%，显得巨大）
      // 字体来自 `n.labelFont`；**没设过就用"按控件尺寸成比例"的自动字号**
      // （固定 11px 在 90 单位的小表上占 12%，显得巨大）。
      const lf = window.normalizeFont(n.labelFont);
      const autoLabel = !n.labelFont;
      const fl = autoLabel ? fontFor(n, 0.085, 6, 20) : lf.size;
      const fs2 = autoLabel ? fontFor(n, 0.065, 5, 15) : lf.size * 0.78;
      const pad = Math.max(2, Math.min(n.w, n.h) * 0.03);
      ctx.fillStyle = lf.color !== window.FONT_DEFAULT.color ? lf.color : T.label;
      ctx.textAlign = lf.align; ctx.textBaseline = "top";
      ctx.font = window.fontShort(lf, fl);
      const lx = lf.align === "center" ? n.w / 2 : (lf.align === "right" ? n.w - pad : pad);
      if (n.showLabel !== false) ctx.fillText(clipText(label, n.w - pad * 2), lx, pad);
  
      // PID id（可开关，见 app.js 的 togglePidLabel）——
      // 做主题时常要确认"这个表绑的是哪个 PID"，但摆位置时那行字挡视线。
      //
      // ⚠️ 显示**语义别名**（`obd.coolant`）而不是解析后的 id（`std_05`）——
      // 别名才是用户在设计文件里写的东西，一眼能对上；`std_05` 还得去查表。
      // 没有别名（厂家模板等）时回落到 id。
      if (S.showPid && n.pid && n.showLabel !== false) {
        ctx.fillStyle = T.dim;
        ctx.font = window.fontShort(lf, fs2 * 0.92);
        ctx.textBaseline = "top";
        ctx.fillText(clipText(pidLabelOf(n), n.w - pad * 2), lx, pad + fl * 1.25);
      }
  
      if (n.showRange !== false) {
        ctx.textAlign = "right"; ctx.fillStyle = T.dim;
        ctx.font = fs2 + "px " + window.fontCss("mono");
        ctx.textBaseline = "top";
        ctx.fillText(window.r2(n.min) + "~" + window.r2(n.max) + unit, n.w - pad, pad);
      }
      ctx.fillStyle = T.dim;
      ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.font = fs2 + "px " + window.fontCss("sans");
      const tag = style.n + (card === 0 ? "" : " · " + window.CARD_NAMES[card]);
      ctx.fillText(clipText(tag, n.w - pad * 2), pad, n.h - pad);
  }

  /**
    // ⚠️ **标签的颜色暂时不用主题色**（v2.50.0）。
    //
    // 试过把 `C.text` → `T.label`、`C.textFaint` → `T.dim`，
    // 结果是 `verify-font` 里「改字距 → 画布变了」「改斜体 → 画布变了」两条红：
    //
    //   改对齐 / 改颜色 **仍然通过** —— 说明标签**画出来了**，
    //   只是那两处改动的像素差异**落到了测试指纹的阈值以下**。
    //
    // 原因是主题的 `label`(#D8BFA0) 比工具原来的 `text` 暗，对比度下降，
    // 抗锯齿差异变小 —— **接线是对的，是测试的指纹不够灵敏**。
    //
    // 正确顺序：先把 `verify-font` 的指纹做灵敏（别用 alpha>20 + 抽样），
    // 再接标签色。否则等于"为了过测试而不接主题"。
   * **按子部件绘制仪表**（v2.12.0）。
   *
   * 绘制顺序 = **数组顺序**（先画的在下）。
   *
   * 指针的角度由**当前值**驱动；没有实时数据时用 min ——
   * 与程序化画法一致，不会出现"指针悬在半空"。
   */
  /**
   * **按子部件绘制仪表**（v2.12.0；v2.18.0 支持嵌套）。
   *
   * ## 坐标系（嵌套的关键）
   *
   * 顶层部件的 x/y 相对**仪表节点**；子部件的 x/y 相对**父部件的 pivot**。
   *
   * 为什么用 pivot 而不是父的左上角：嵌套的典型用法是"指针上挂个装饰/配重" ——
   * 装饰要跟着指针**绕轴心转**。以 pivot 为原点，子部件写 (0,0) 就正好在轴心上，
   * 符合直觉；以左上角为原点的话，每加一个装饰都要手算 pivot 的偏移。
   *
   * 子部件**继承父的旋转**（因为父的 rotate 在 ctx 里，子在自己的坐标系里画）。
   *
   * ## 绘制顺序
   *
   * 数组顺序 = 绘制顺序（先画的在下）；**父先画、子后画** ——
   * 装饰盖在主体之上才符合预期。
   */
  /**
   * 点在**哪个子部件**上（返回下标，-1 = 没中）。
   *
   * ⚠️ **从后往前**判 —— 绘制顺序是数组顺序（后面的画在上面），
   * 所以最上面那个应该先被命中，才与视觉一致。
   *
   * 用「轴心 + 尺寸」构成的矩形近似。旋转过的部件不精确（真正的形状是旋转矩形），
   * 但做"拖哪个"的判定足够 —— 要精确的话得做逆变换，而收益只有几个像素。
   */
  function hitPart(n, lx, ly) {
    if (!n.parts || !n.parts.length) return -1;
    for (let i = n.parts.length - 1; i >= 0; i--) {
      const p = window.normalizePart(n.parts[i]);
      if (p.alpha <= 0) continue;
      if (lx >= p.x && lx <= p.x + p.w && ly >= p.y && ly <= p.y + p.h) return i;
    }
    return -1;
  }
  window.hitPart = hitPart;

  // ================================================================ 弹簧 / 盘面（v2.81.0）

  /**
   * 指针该画在**哪个值**上 —— 两套系统仲裁的**唯一**落地点。
   *
   * 优先级：
   *   1. 让位标志被 `"tween"` 占着 → 用补间写的值（作者编排的动画，如自检扫表）
   *   2. 实时模拟开着 → 用弹簧的**当前位置**（不是真值 —— 真值每 16ms 硬跳一次）
   *   3. 其它 → 真值（摆位置 / 拖属性面板的数值时，指针必须**立刻**到位）
   *
   * ⚠️ 为什么实时数据走弹簧、而**读数与状态灯不走**：
   * 弹簧到位需要时间，读数和报警判定跟着它走就是"晚到"，
   * 而真车上报警是即时的 —— 那属于**把预览做得和真车不一样**，不是美化。
   */
  function needleValue(pid, raw) {
    if (S.anim && !S.anim.allows("sim")) {
      const tv = S.tweenValues || {};
      if (pid && tv[pid] !== undefined) return tv[pid];
    }
    const b = S.simSprings;
    if (!b || !b.active) return raw;
    return b.peek(pid, raw);
  }
  window.needleValue = needleValue;

  /**
   * **盘面缓存**：按**签名**存，量程 / 单位 / 红区 / 半径变了签名就变 → 自动重建。
   *
   * 为什么要缓存：盘面（刻度 + 数字 + 红区）是"算出来的"，
   * 每帧重算 30~50 根刻度纯属浪费；但它又**必须**跟着量程变。
   * 签名就是这个矛盾的解：算一次、存起来、输入一变就换一份新的。
   *
   * 为什么要**限量**：拖属性面板的数字输入框时，每敲一个键就是一个新签名
   * （`8000` → `8` / `80` / `800` / `8000` 四个签名），不设上限会一直涨。
   * 超了就丢最早的那条（Map 的迭代顺序 = 插入顺序）。
   */
  const dialCache = new Map();
  const DIAL_CACHE_MAX = 32;

  function dialFaceFor(opts) {
    const sig = window.dialSig(opts);
    const hit = dialCache.get(sig);
    if (hit) return hit;
    const face = window.buildDial(opts);
    if (dialCache.size >= DIAL_CACHE_MAX) {
      dialCache.delete(dialCache.keys().next().value);
    }
    dialCache.set(sig, face);
    return face;
  }
  window.dialFaceFor = dialFaceFor;
  /** 缓存里现在有几块盘面（测试用） */
  window.dialCacheSize = function () { return dialCache.size; };
  window.dialCacheClear = function () { dialCache.clear(); };

  /**
   * 仪表节点的**程序化盘面**参数（style 0 / 7）。
   *
   * 全部来自节点字段 —— 没有一个是写死的：
   *   `min` / `max` → 刻度与数字；`warnLow` / `warnHigh` → 红区；PID → 单位
   *
   * 红区**两段**都支持：水温表 `warnLow = 60`（低于 60 也不正常 ——
   * 冷机或节温器卡开），`warnHigh = 105`。参考实现只有一个 `redlineFrom`，
   * 对"越高越危险"的表够用，对温度/电压这种**两端都不正常**的量不够。
   */
  function gaugeDialOpts(n, r, unit) {
    const redlines = [];
    if (n.warnLow !== null && n.warnLow !== undefined) redlines.push({ from: n.min, to: n.warnLow });
    if (n.warnHigh !== null && n.warnHigh !== undefined) redlines.push({ from: n.warnHigh, to: n.max });
    return {
      cx: n.w / 2, cy: n.h / 2, r: r,
      start: 135, sweep: 270,
      min: n.min, max: n.max,
      minor: 4,
      redlines: redlines,
      unit: unit || "",
    };
  }
  window.gaugeDialOpts = gaugeDialOpts;

  function drawGaugeParts(n) {
    const values = S.previewValues || {};
    n.parts.forEach(function (p) {
      drawPartTree(n, window.normalizePart(p), values, 0);
    });
  }

  /**
   * 递归画一个部件及其子树。
   *
   * @param depth 嵌套深度。上限 5 —— 与 normalizePart 的上限一致，
   *   防手改文件写出超深结构把栈打爆。
   */
  function drawPartTree(n, part, values, depth) {
    if (depth > 5) return;
    // **每个部件各算各的值与量程**（多指针表：两个 needle 各绑一个 PID）
    const vr = window.partValueRange(part, n, values);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * (part.alpha / 255);

    // 数值部件用**文字**画，不是图片 —— 它要跟着数据变
    if (part.kind === "value") {
      const f = window.normalizeFont(n.labelFont);
      ctx.fillStyle = f.color;
      ctx.font = window.fontShort(f, f.size);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(window.r2(vr.value), part.x + part.w / 2, part.y + part.h / 2);
      ctx.globalAlpha = prevAlpha;
      return;
    }

    // 指针的角度由值驱动；其余部件用静态 rotation
    // 扫描范围可能"跟随仪表"（v2.27.0）—— 先解析出来再算角度
    const sw = window.partSweep(part, n.parts);
    // ⚠️ 指针用**弹簧位置**，其余部件用静态 rotation（v2.81.0）。
    // `vr.value` 是真值 —— 读数（kind === "value"）必须用它，指针不能。
    // 弹簧按 **PID** 分（同一物理量的两根针当然一起动），与 partValueRange 同口径：
    // 部件自己绑了 PID 就用它，否则跟随仪表节点。
    const needleV = part.kind === "needle"
      ? needleValue(part.pid || n.pid, vr.value)
      : vr.value;
    const ang = part.kind === "needle"
      ? window.partAngle(Object.assign({}, part, { sweepFrom: sw[0], sweepTo: sw[1] }),
          needleV, vr.min, vr.max)
      : part.rotation;
    // 旋转中心 = 部件自身的 pivot（相对自身 0..1）——
    // 指针素材的轴心通常不在图片中心，所以必须能单独设
    const cx = part.x + part.w * part.pivotX;
    const cy = part.y + part.h * part.pivotY;

    ctx.save();
    ctx.translate(cx, cy);
    if (ang) ctx.rotate(ang * Math.PI / 180);

    const bmp = assetBitmap(part.assetId);
    if (bmp) ctx.drawImage(bmp, -part.w * part.pivotX, -part.h * part.pivotY, part.w, part.h);

    // 子部件在**父的 pivot 坐标系**里，继承父的旋转
    if (part.children && part.children.length) {
      part.children.forEach(function (c) {
        drawPartTree(n, window.normalizePart(c), values, depth + 1);
      });
    }

    ctx.restore();
    ctx.globalAlpha = prevAlpha;
  }

  /** 取素材位图（走画布统一的缓存，与图片控件共用） */
  function assetBitmap(assetId) {
    const a = (S.design.assets || []).find(x => x.id === assetId);
    if (!a) return null;
    const url = a.data || a.path;
    const img = S.imgCache[url];
    return (img && img.complete && img.naturalWidth) ? img : null;
  }
  // 导出：panels.js 定新节点尺寸时要拿原始宽高（按比例缩放）
  window.assetBitmap = assetBitmap;

  /**
   * 数字仪表显示**几位**：按量程上限的位数定（`0~8000` → 4 位，`0~260` → 3 位）。
   *
   * 为什么要由量程定而不是由当前值定：位数一变，每个数字的**宽度**就变，
   * 整个读数会左右跳 —— 那是"表在抖"，不是"数字在滚"。
   */
  function digitCountFor(n) {
    const m = Math.abs(Math.round(n.max));
    return Math.max(2, Math.min(6, String(m).length));
  }

  /**
   * **数字鼓**（v2.81.0）：每一位一条竖排条带，最低位跟着小数滚。
   *
   * 三个坑（`spring.js` 的 `drumSlot` 里有完整推导，这里只留结论）：
   *
   *   1. **步长按行数算**：10 行时一行 = 10%，20 行时一行 = 5%（`yPercent` 口径）。
   *      本实现直接用像素（`rowH`），并把百分比口径也一并算出来，
   *      避免"改了行数忘了改步长"——参考实现就是这么把数字显示成 2 倍的。
   *   2. **位置每帧现算**，不缓存：缓存值在动画被打断时失真
   *      （参考实现症状："重播后锁死 888"）。
   *   3. **只向前滚**：9 → 0 继续往前，不依赖 `onComplete` 回位。
   *      位置只由值决定，所以中途改值/打断都不会留下错位的条带。
   *
   * 前导零不画（`12` 不显示成 `012`），但**格子位置固定**（按量程位数排布），
   * 这样数字变长变短时整块读数不会左右跳。
   */
  function drawDigitDrum(n, value, cx, cy, fontPx) {
    const neg = value < 0;
    const rowH = fontPx * 1.16;
    const digits = digitCountFor(n);
    const d = window.drumDigits(Math.abs(value), { rowH: rowH, digits: digits });
    const dw = Math.max(1, ctx.measureText("0").width);
    const cells = d.digits + (neg ? 1 : 0);
    const total = dw * cells;
    const x0 = cx - total / 2 + dw / 2 + (neg ? dw : 0);
    const prevAlign = ctx.textAlign, prevBase = ctx.textBaseline;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (neg) ctx.fillText("-", x0 - dw, cy);
    // 前导零不画：只画"当前值真正用到的"那几位（格子位置不动）
    const shown = String(Math.floor(Math.abs(value))).length;
    const from = Math.max(0, d.digits - shown);
    for (let i = from; i < d.digits; i++) {
      const s = d.slots[i];
      const x = x0 + dw * i;
      ctx.save();
      // 每位一个裁剪格：条带上下滚时不能溢出到邻位（否则会看到"重影"）
      ctx.beginPath();
      ctx.rect(x - dw * 0.62, cy - fontPx * 0.78, dw * 1.24, fontPx * 1.56);
      ctx.clip();
      // ⚠️ 位置 = 基准线 + **这一位自己的**偏移（digitDy / nextDigitDy），
      //    不是条带位移 offsetPx —— 那还要加上 row·rowH（见 drumSlot.rowDy）
      ctx.fillText(String(s.digit), x, cy + s.digitDy);
      ctx.fillText(String(s.nextDigit), x, cy + s.nextDigitDy);
      ctx.restore();
    }
    ctx.textAlign = prevAlign; ctx.textBaseline = prevBase;
    return d;
  }
  window.drawDigitDrum = drawDigitDrum;
  window.digitCountFor = digitCountFor;

  function drawGaugeNode(n) {
    // ⚠️ 主题色必须**在这里取一次**（v2.49.0）。
    // 之前这里全是硬编码 `#00D8FF`，所以切主题画布毫无反应。
    // v2.80.2：改读 [themeColors]（解析视图的那一份），理由同 drawGaugeLabel。
    const T = themeColors();

    const info = window.BUILTIN_PIDS[n.pid];
    const label = info ? info.name : (n.rawPid || n.pid || "未绑定");
    const unit = info ? info.unit : "";
    const style = window.STYLES.find(s => s.v === n.style) || window.STYLES[0];
    // **有子部件就按部件拼装** —— 用户明确说了「我要自己拼」，
    // 就别再叠一层程序化画法。没有部件时下面那套照旧（行为完全不变）。
    if (n.parts && n.parts.length) {
      drawGaugeParts(n);
      drawGaugeLabel(n, label, unit, style,
        (n.cardStyle === null || n.cardStyle === undefined) ? 0 : n.cardStyle);
      return;
    }

    // 底框：card 覆盖 cardStyle，cardStyle 覆盖主题（见 resolveCard）
    const card = window.resolveCard(n);
    if (card.show) {
      // 圆角默认按控件尺寸折算（6 是给 120 单位表的量级），显式设了就听显式的
      const radius = card.radius !== null
        ? card.radius
        : Math.max(2, Math.min(24, Math.min(n.w, n.h) * 0.05));
      // 透明度：card.alpha 优先，否则用主题的默认卡片不透明度
      const prevAlpha = ctx.globalAlpha;
      if (card.alpha !== null) ctx.globalAlpha = prevAlpha * (card.alpha / 255);
      ctx.fillStyle = T.surface;
      roundRect(1, 1, n.w - 2, n.h - 2, radius);
      ctx.fill();
      // cardStyle=1（无边框）只去描边，保留底色
      if (card.style !== 1) {
        ctx.strokeStyle = T.surfaceEdge;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.globalAlpha = prevAlpha;
    }
    const cx = n.w / 2, cy = n.h / 2;

    // 预览值：实时模拟开着就用它，否则用一个固定示意值
    const pv = S.previewValues && S.previewValues[n.pid] !== undefined
      ? S.previewValues[n.pid] : null;
    const ratio = pv !== null && n.max > n.min
      ? clamp((pv - n.min) / (n.max - n.min), 0, 1) : 0.62;
    /**
     * **机械值**（v2.81.0）：会动的东西（指针 / 盘面进度弧 / 数字鼓）用它。
     *
     * 与 `pv` 的差别就是"弹簧"：`pv` 是真值（每 16ms 硬跳一次），
     * `mech` 是弹簧当前的位置。⚠️ `pv` 为 null（模拟关着）时 `mech` 也可能有值 ——
     * 那是**补间**（自检扫表）在写，正是它该生效的时候。
     */
    const mech = needleValue(n.pid, pv);
    const ratioMech = (mech !== null && mech !== undefined && n.max > n.min)
      ? clamp((mech - n.min) / (n.max - n.min), 0, 1) : ratio;

    if (n.style === 0 || n.style === 7) {
      const r = Math.min(n.w, n.h) * 0.36;
      // ---- 0) **盘面**：刻度 / 数字 / 红区全部由节点字段算出来。
      //      量程、单位、红区一变签名就变 → `dialFaceFor` 自动重建一块新的。
      const face = dialFaceFor(gaugeDialOpts(n, r, unit));
      const a0 = face.arc.angFrom * Math.PI / 180;
      const a1 = face.arc.angTo * Math.PI / 180;

      // ---- 1) 底弧（轨道）
      ctx.strokeStyle = T.track;
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();

      // ---- 2) 刻度：大格长、小格短，一律**朝内**画
      //      （朝外会和 `ringStyle === 1` 的外圈段环撞在一起）
      //      颜色用主题的 `tick`（主题里专门有一档给刻度，比 dim 更亮一点）；
      //      老主题万一没这个字段就回落到 dim
      const tickColor = T.tick || T.dim;
      ctx.lineWidth = Math.max(1, r * 0.035);
      face.ticks.forEach(function (t) {
        const aa = t.ang * Math.PI / 180;
        const rr0 = r * 0.92;
        const rr1 = t.major ? r * 0.78 : r * 0.85;
        ctx.strokeStyle = t.major ? tickColor : T.track;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(aa) * rr0, cy + Math.sin(aa) * rr0);
        ctx.lineTo(cx + Math.cos(aa) * rr1, cy + Math.sin(aa) * rr1);
        ctx.stroke();
      });

      // ---- 3) 刻度数字。挤了就**隔一个画一个** —— 自动选步长会给出 13~14 个大格，
      //      全画会在 270° 的弧上糊成一片（真表遇到这种情况也是隔一个标一个）
      const fsTick = Math.max(5, r * 0.17);
      const labelR = r * 0.62;
      const stride = window.dialLabelStride(face, fsTick, labelR);
      ctx.fillStyle = tickColor;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = fsTick + "px " + window.fontCss("mono");
      face.labels.forEach(function (l, i) {
        if (i % stride !== 0) return;
        const aa = l.ang * Math.PI / 180;
        ctx.fillText(l.text, cx + Math.cos(aa) * labelR, cy + Math.sin(aa) * labelR);
      });

      // ---- 4) 红区：画在**填充之上** —— 报警区任何时刻都该看得见
      //      （画在下面会被进度弧盖住，值一进红区就"看不见红"了）
      face.redlines.forEach(function (z) {
        ctx.strokeStyle = "#FF4D4F";
        ctx.lineWidth = Math.max(1.5, r * 0.12);
        ctx.beginPath();
        ctx.arc(cx, cy, r, z.angFrom * Math.PI / 180, z.angTo * Math.PI / 180);
        ctx.stroke();
      });

      // ---- 5) 进度弧：**路径恒定，进度只改一个标量**（stroke-dashoffset）
      //
      // 参考实现（SVG）用 `strokeDasharray = len; strokeDashoffset = len × (1 - 进度)`。
      // canvas 的对应物是 `setLineDash([len])` + `lineDashOffset`，语义完全一致。
      //
      // ⚠️ 为什么不"按比例重画一段短弧"（原来的做法）：
      //   ① 每帧都要重新构造一遍路径；
      //   ② 弧的两端（抗锯齿）每帧都在动，数值抖动时看着像在"呼吸"；
      //   ③ 进度不再是一个**可插值的标量** —— 想给它做弹簧/补间都无从下手。
      ctx.strokeStyle = T.accent;
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      window.applyArcProgress(ctx, face.arc.len, ratioMech);
      ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
      window.clearArcProgress(ctx);

      // ---- 6) 指针（红细线）
      const a = a0 + (a1 - a0) * ratioMech;
      ctx.strokeStyle = "#FF4D4F";
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85); ctx.stroke();
      if (n.ringStyle === 1) {
        ctx.strokeStyle = T.dim; ctx.lineWidth = 1;
        const seg = Math.max(8, Math.min(120, n.ringSegments || 40));
        for (let i = 0; i < seg; i++) {
          const t = i / seg, aa = Math.PI * 0.75 + Math.PI * 1.5 * t, rr = r * 1.18;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr);
          ctx.lineTo(cx + Math.cos(aa) * (rr + r * 0.08), cy + Math.sin(aa) * (rr + r * 0.08));
          ctx.stroke();
        }
      }
    } else if (n.style === 1) {
      ctx.fillStyle = T.value;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const fsNum = Math.max(8, Math.min(n.h * 0.44, n.w * 0.30));
      ctx.font = "bold " + fsNum + "px Consolas, monospace";
      // 有映射表就显示名字（挡位 P/R/N/1..6），否则显示数字。
      // ⚠️ 判定走 window.valueLabelFor —— 与 Kotlin 侧 ValueLabels 同一套语义，
      // 工具里看到的就是设备上会看到的（不要在这里另写一遍取整逻辑）
      const lbl = window.valueLabelFor(n.valueLabels, pv);
      if (lbl !== null) {
        // 映射表里的每个状态是一个**词**（P / R / N / 1…6），数字鼓对它没有意义
        ctx.fillText(lbl, cx, cy);
      } else if (mech === null || mech === undefined) {
        ctx.fillText("123", cx, cy);
      } else {
        // **数字鼓**（v2.81.0）：每位一条竖排条带，最低位跟着小数滚。
        // 三个坑（行数变了步长就变 / 位置必须现算 / 只向前滚）见 spring.js 的 drumSlot
        drawDigitDrum(n, mech, cx, cy, fsNum);
      }
    } else if (n.style === 2) {
      const bh = Math.max(3, n.h * 0.20);
      const bx = n.w * 0.06, bw = n.w * 0.88, by = n.h * 0.62;
      ctx.fillStyle = T.track; roundRect(bx, by, bw, bh, bh / 2); ctx.fill();
      ctx.fillStyle = T.accent; roundRect(bx, by, bw * ratio, bh, bh / 2); ctx.fill();
    } else if (n.style === 3) {
      ctx.strokeStyle = T.accent; ctx.lineWidth = 1.5;
      ctx.beginPath();
      const N = 16;
      for (let i = 0; i < N; i++) {
        const px = n.w * 0.08 + n.w * 0.84 * i / (N - 1);
        const py = n.h * 0.80 - n.h * 0.6 * (0.5 + 0.45 * Math.sin(i * 0.8 + (S.simPhase || 0)));
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      const cells = n.style === 4 ? 2 : (n.style === 5 ? 4 : 3);
      ctx.strokeStyle = T.track; ctx.lineWidth = 1;
      if (cells === 2) {
        ctx.beginPath(); ctx.moveTo(4, cy); ctx.lineTo(n.w - 4, cy); ctx.stroke();
      } else if (cells === 4) {
        ctx.beginPath();
        ctx.moveTo(cx, 4); ctx.lineTo(cx, n.h - 4);
        ctx.moveTo(4, cy); ctx.lineTo(n.w - 4, cy);
        ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(4, n.h * 0.5); ctx.lineTo(n.w - 4, n.h * 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx, n.h * 0.5); ctx.lineTo(cx, n.h - 4); ctx.stroke();
      }
      ctx.fillStyle = T.dim;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = fontFor(n, 0.09, 7, 18) + "px sans-serif";
      ctx.fillText("×" + cells, cx, cy);
    }

    // 标签 / PID / 量程 —— 抽成独立函数，因为**部件路径也要画它**
    //
    // ⚠️ 传的是 `card.style`（**粗档位数字**），不是 `card` 对象本身（v2.81.0 修）。
    // `resolveCard()` 返回的是 `{show, alpha, radius, style}` 对象，而
    // `drawGaugeLabel` 里要拿它去查 `CARD_NAMES[card]` —— 传对象查不到，
    // 于是右下角那行标签一直印着 **"数字 · undefined"**（存量 bug，实测截图确认）。
    // 部件路径（上面第 1179 行）本来就是传数字，所以两条路径的标签不一致。
    drawGaugeLabel(n, label, unit, style, card.style);
  }

  /**
   * 画布上显示的 PID 文本：优先**语义别名**（`obd.coolant`），没有才用 id。
   *
   * 别名是用户在设计文件里写的东西，一眼能对上；`std_05` 还得去查表。
   * 厂家模板（`tpl_*`）没有别名，就显示 id。
   */
  function pidLabelOf(n) {
    if (!n.pid) return "";
    return window.ALIAS_OF[n.pid] || n.pid;
  }
  window.pidLabelOf = pidLabelOf;

  function clipText(text, maxW) {
    if (!text) return "";
    if (ctx.measureText(text).width <= maxW) return text;
    let s = String(text);
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * 状态解析（大纲 §4.2）。预览用模拟值；没有就回落 normal。
   *
   * ⚠️ App 侧用 `AlertPulse` 的**迟滞**判定；工具里只做无迟滞的简单比较
   * （预览不需要迟滞，而且迟滞会让"改阈值立刻看到效果"变难）。
   * 这条差异记在「与 App 规则的差异」页里。
   */
  /**
   * 当前状态**名**（normal / warn / critical）。
   *
   * 与 [resolveState] 分开是为了让"可视化调试"能拿到名字 ——
   * 只返回对象的话调用方还得反查是哪个键。
   */
  function resolveStateName(n) {
    if (!n.states) return null;
    const pv = S.previewValues && n.statePid ? S.previewValues[n.statePid] : null;
    if (pv === null || pv === undefined || !n.statePid) return window.STATE_NORMAL;
    const info = window.BUILTIN_PIDS[n.statePid];
    // **显式阈值优先**，没设才从 PID 库推断 ——
    // 不同车/不同传感器的报警线本来就不一样，写死在库里不合理
    const warnAt = (n.stateWarn !== null && n.stateWarn !== undefined)
      ? n.stateWarn
      : ((info && info.warnHigh) || null);
    if (warnAt === null) return window.STATE_NORMAL;
    const max = info ? info.max : 100;
    const critAt = (n.stateCritical !== null && n.stateCritical !== undefined)
      ? n.stateCritical
      : (max > warnAt ? warnAt + (max - warnAt) * 0.5 : null);
    if (critAt !== null && pv >= critAt) return window.STATE_CRITICAL;
    if (pv >= warnAt) return window.STATE_WARN;
    return window.STATE_NORMAL;
  }
  window.resolveStateName = resolveStateName;

  /**
   * 取当前状态对应的那一条 `states` 记录。
   *
   * ## ⚠️ 回退链必须与 App 的 `NodeTreeRenderer.resolveState` **逐级一致**
   *
   * App 的写法是：
   * ```kotlin
   * critAt != null && v >= critAt -> c.states[CRITICAL] ?: c.states[WARN] ?: c.states[NORMAL]
   * v >= warnAt                   -> c.states[WARN]     ?: c.states[NORMAL]
   * else                          -> c.states[NORMAL]
   * ```
   *
   * 原来这里只有 `n.states[name] || n.states[normal]` —— **少了中间那一级 warn**。
   * 后果（v2.83.0 实测，Round 6）：一份只填了 `normal`/`warn`、没有 `critical` 键的
   * 设计（老文件、或手改过 JSON），数值超过危险线时
   * **工具预览显示 `normal` 的图，真机显示 `warn` 的图**。
   * 用户会以为"危险态没接上"（预览里灯根本没变），而车上却是黄灯。
   *
   * 这正是本仓库最贵的那类 bug 的形态（状态灯 + 两边不一致），所以这里**照抄** App。
   */
  function resolveState(n) {
    if (!n.states) return null;
    // 阈值判定统一走 resolveStateName —— 两处各写一遍迟早分叉
    const name = resolveStateName(n) || window.STATE_NORMAL;
    const order = name === window.STATE_CRITICAL
      ? [window.STATE_CRITICAL, window.STATE_WARN, window.STATE_NORMAL]
      : (name === window.STATE_WARN
        ? [window.STATE_WARN, window.STATE_NORMAL]
        : [window.STATE_NORMAL]);
    for (let i = 0; i < order.length; i++) {
      if (n.states[order[i]]) return n.states[order[i]];
    }
    return null;
  }
  window.resolveState = resolveState;

  // ================================================================ 选择框与手柄

  /**
   * 手柄位置。
   *
   * ## ⚠️ 偏移必须**按轴分别折算**（这里踩过一次）
   *
   * 手柄在屏幕上应当离角点**固定像素距离**。但如果用一个统一的节点单位偏移
   * （比如都除以 x 轴尺度），再经**非等比**矩阵变换，屏幕上 x 与 y 的距离就不同了 ——
   * 结果是"右下角图标"实际落在一个偏斜的位置上，点不中。
   *
   * 所以按 `sx` / `sy` 分别算偏移，保证设备空间里两轴距离一致。
   *
   * @param n 节点
   * @param m 该节点的**真实**世界矩阵（节点局部 → 画布位图）
   */
  function handlePositions(n, m) {
    // ⚠️ 不要再乘 n.scale —— 传入的矩阵（worldMatrix / deviceMatrix）
    // 累积的 localMatrix 里**已经含** scale。之前乘了能互相抵消（偏移最后
    // 会被矩阵乘回去），但读起来像是双重缩放，容易改错。
    const sx = m ? Math.hypot(m.a, m.b) : nodeScale();
    const sy = m ? Math.hypot(m.c, m.d) : nodeScale();
    const offX = ROT_OFFSET / Math.max(0.2, sx);
    const offY = ROT_OFFSET / Math.max(0.2, sy);
    return {
      corners: [
        { x: 0, y: 0 }, { x: n.w, y: 0 }, { x: n.w, y: n.h }, { x: 0, y: n.h },
      ],
      rotate: { x: n.w / 2, y: -offY },
      rotateBR: { x: n.w + offX * 0.72, y: n.h + offY * 0.72 },
      offX: offX, offY: offY,
    };
  }

  /**
   * 画出子部件的外框（v2.32.0）。
   *
   * ⚠️ 线宽要**除以设备尺度** —— 这个函数在节点的局部坐标系里画，
   * 不除的话缩放/拉伸模式下框会粗得糊成一片。
   */
  function drawPartOutlines(n, m) {
    if (!n.parts || !n.parts.length) return;
    const sc = Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
    if (!(sc > 0)) return;
    const sel = (S.selectedPart === undefined) ? -1 : S.selectedPart;
    n.parts.forEach(function (raw, i) {
      const p = window.normalizePart(raw);
      if (p.alpha <= 0) return;
      const on = (i === sel);
      ctx.strokeStyle = on ? "#FFB020" : "rgba(0,216,255,0.35)";
      ctx.lineWidth = (on ? 2 : 1) / sc;
      ctx.setLineDash(on ? [] : [4 / sc, 3 / sc]);
      ctx.strokeRect(p.x, p.y, p.w, p.h);
      ctx.setLineDash([]);
    });
  }

  function drawSelection() {
    // 多选：画整体外框
    if (S.selection.length > 1) {
      // 多选外框用**设备空间**的包围盒（含旋转），这样它包住的正是你看到的东西
      const bs = S.selection.map(id => deviceBounds(id)).filter(Boolean);
      if (bs.length) {
        const x0 = Math.min(...bs.map(b => b.x)), y0 = Math.min(...bs.map(b => b.y));
        const x1 = Math.max(...bs.map(b => b.x + b.w)), y1 = Math.max(...bs.map(b => b.y + b.h));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.strokeStyle = "#00D8FF";
        ctx.setLineDash([7, 5]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
        ctx.setLineDash([]);
      }
    }
    // 单选：画四角手柄 + 旋转柄
    S.selection.forEach((id, idx) => {
      const rawM = deviceMatrix(S.design.nodes, id);
      if (!rawM) return;
      const n = window.findNode(S.design.nodes, id);
      if (!n) return;
      // 用**内容矩阵**画框 —— 否则 stretch 模式下框比控件宽 1.6 倍
      const m = selectionMatrix(n, rawM);
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      const sc = Math.min(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
      const hs = HANDLE / Math.max(0.001, sc);
      ctx.strokeStyle = "#00D8FF";
      ctx.lineWidth = 1.5 / Math.max(0.001, sc);
      ctx.strokeRect(0, 0, n.w, n.h);

      if (S.selection.length === 1) {
        // **子部件框**（v2.32.0）：带 parts 的仪表选中时，把每个部件的外框画出来 ——
        // 否则用户根本不知道"这里能拖"（原来只能靠属性面板填数字）。
        //
        // 当前选中的那个用实线 + 亮色，其余虚线 + 暗色。
        drawPartOutlines(n, m);
        // 锁定：手柄画成灰色，并且不可拖
        const locked = !!n.locked;
        const acc = locked ? C.textDim : "#00D8FF";
        ctx.fillStyle = acc;
        [[0, 0], [n.w, 0], [n.w, n.h], [0, n.h]].forEach(p => {
          ctx.fillRect(p[0] - hs / 2, p[1] - hs / 2, hs, hs);
        });

        const hp = handlePositions(n, m);

        // ---- 顶边中点的旋转柄（常规做法）
        ctx.strokeStyle = acc;
        ctx.beginPath();
        ctx.moveTo(n.w / 2, 0); ctx.lineTo(hp.rotate.x, hp.rotate.y); ctx.stroke();
        ctx.fillStyle = locked ? C.textDim : "#FFB020";
        ctx.beginPath(); ctx.arc(hp.rotate.x, hp.rotate.y, hs * 0.55, 0, Math.PI * 2); ctx.fill();

        // ---- 右下角外侧的旋转小图标（用户要求）
        // 画成一个带 ↻ 的实心圆，比小方块更好认
        const br = hp.rotateBR;
        ctx.strokeStyle = acc;
        ctx.beginPath();
        ctx.moveTo(n.w, n.h); ctx.lineTo(br.x, br.y); ctx.stroke();
        ctx.fillStyle = locked ? C.textDim : "#FFB020";
        ctx.beginPath(); ctx.arc(br.x, br.y, hs * 0.85, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#1A1206";
        ctx.font = "bold " + (hs * 1.15) + "px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("↻", br.x, br.y + hs * 0.06);
      }

      // 多选时给每个也标一个小序号
      if (S.selection.length > 1) {
        ctx.fillStyle = "#00D8FF";
        ctx.font = (14 / Math.max(0.001, Math.abs(m.a))) + "px sans-serif";
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText("#" + (idx + 1), 3, 3);
      }
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ================================================================ 交互

  /** 命中哪个手柄：0..3 角 / 4 顶部旋转柄 / 5 右下角旋转图标 / -1 无 */
  function hitHandle(n, localPt, realM) {
    // 判定半径也按轴分别折算，保证屏幕上是个正圆
    const sx = realM ? Math.hypot(realM.a, realM.b) : nodeScale();
    const sy = realM ? Math.hypot(realM.c, realM.d) : nodeScale();
    const hsx = HANDLE / Math.max(0.001, sx);
    const hsy = HANDLE / Math.max(0.001, sy);
    const hp = handlePositions(n, realM);
    // 右下角图标先判（判定半径大一点，好点中）
    if (Math.hypot((localPt.x - hp.rotateBR.x) / hsx, (localPt.y - hp.rotateBR.y) / hsy) <= 1.1) return 5;
    if (Math.hypot((localPt.x - hp.rotate.x) / hsx, (localPt.y - hp.rotate.y) / hsy) <= 0.9) return 4;
    const pts = [[0, 0], [n.w, 0], [n.w, n.h], [0, n.h]];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(localPt.x - pts[i][0]) <= hsx / 2 && Math.abs(localPt.y - pts[i][1]) <= hsy / 2) return i;
    }
    return -1;
  }

  /**
   * 屏幕点 → 节点的本地坐标（反变换）。同时返回该节点的**真实**矩阵。
   *
   * ⚠️ 返回的 `realM` 必须是**节点局部 → 画布位图**的矩阵（= 画布矩阵 × 世界矩阵），
   * **不是** `wm.m`（那个是"节点局部 → 0..360 坐标空间"）。
   *
   * 这里混过一次，症状很隐蔽：手柄偏移 `ROT_OFFSET` 是**屏幕像素**，要除以设备尺度
   * 才能换成节点单位。用错矩阵时 `sx/sy` 变成 1（而不是 2.18/1.36），偏移就算成
   * 26 节点单位而不是 11.9 —— 手柄画在屏幕上是对的，但**点不中**（差 1.25 倍）。
   *
   * 本地坐标本身在哪个空间都行（反变换回去即可），只有矩阵必须与
   * [handlePositions] 的期望一致。
   */
  function toLocal(n, canvasPt) {
    // 与画框/手柄用**同一个**矩阵 —— 否则"看得见的框"与"点得中的区域"不一致
    const m = selectionMatrix(n, deviceMatrix(S.design.nodes, n.id));
    if (!m) return null;
    const inv = window.matInvert(m);
    if (!inv) return null;
    const p = window.matApply(inv, canvasPt.x, canvasPt.y);
    p.realM = m;
    return p;
  }

  // 暴露给测试/诊断用（几何是这里最容易算错的部分，必须能直接量）
  //
  // 这几个包装器存在的理由：手柄命中涉及**三个坐标空间**（节点局部 / 0..360 /
  // 画布位图），混用一次就会"画得对但点不中"。有了它们，测试可以直接比对
  // "画出来的手柄位置"与"判定用的手柄位置"是不是同一个。
  window.handlePositionsFor = function (id) {
    const rawM = deviceMatrix(S.design.nodes, id);
    if (!rawM) return null;
    const n = window.findNode(S.design.nodes, id);
    const m = selectionMatrix(n, rawM);
    return { hp: handlePositions(n, m), node: n, real: m };
  };
  window.hitHandleFor = function (id, canvasX, canvasY) {
    const n = window.findNode(S.design.nodes, id);
    if (!n) return null;
    const m = selectionMatrix(n, deviceMatrix(S.design.nodes, id));
    if (!m) return null;
    const inv = window.matInvert(m);
    if (!inv) return null;
    const lp = window.matApply(inv, canvasX, canvasY);
    return { handle: hitHandle(n, lp, m), local: lp, real: m };
  };
  /** 走 pointerdown 的**同一条**路径（同一个 toLocal），用于比对两条路径是否一致 */
  window.toLocalFor = function (id, canvasX, canvasY) {
    const n = window.findNode(S.design.nodes, id);
    if (!n) return null;
    const lp = toLocal(n, { x: canvasX, y: canvasY });
    if (!lp) return null;
    return {
      lp: lp, realM: lp.realM,
      handle: hitHandle(n, lp, lp.realM),
      realScale: [Math.hypot(lp.realM.a, lp.realM.b), Math.hypot(lp.realM.c, lp.realM.d)],
    };
  };

  /** 命中的节点所属的**最外层分组**（没有就返回 null）。单击选它，双击下钻 */
  // ================================================================ 组的进入 / 退出

  /**
   * 节点所属的**分组链**（从外到内）。
   *
   * 原来双击只是"选中里面那个叶子"，没有**持久的进入状态** ——
   * 用户不知道自己现在在哪一层，也没有明确的"退出"动作。
   */
  function groupChainOf(id) {
    const chain = window.chainOf(S.design.nodes, id) || [];
    return chain.slice(0, -1).filter(a => a.type === window.NODE_GROUP);
  }
  window.groupChainOf = groupChainOf;

  /** 进入某个分组（depth = 进入几层；0 = 回到画布） */
  window.drillTo = function (depth) {
    const id = S.selection[0];
    const chain = id ? groupChainOf(id) : (S.drillPath || []).map(g => ({ id: g }));
    S.drillPath = chain.slice(0, Math.max(0, depth)).map(g => g.id);
    updateBreadcrumb();
    draw();
    if (window.onSelectionChanged) window.onSelectionChanged();
  };

  /** 退出一层。已经在画布层就返回 false（让调用方知道没得退） */
  window.drillExit = function () {
    const cur = S.drillPath || [];
    if (!cur.length) return false;
    window.drillTo(cur.length - 1);
    return true;
  };

  /** 刷新面包屑。**画布层不显示**（没意义还占地方） */
  function updateBreadcrumb() {
    const bar = document.getElementById("breadcrumb");
    if (!bar) return;
    const path = S.drillPath || [];
    if (!path.length) { bar.style.display = "none"; bar.innerHTML = ""; return; }
    bar.style.display = "flex";
    let h = '<span class="bcSeg bcRoot" onclick="drillTo(0)" title="回到画布（也可以按 Esc）">画布</span>';
    path.forEach((g, i) => {
      const n = window.findNode(S.design.nodes, g);
      h += '<span class="bcArrow">›</span>' +
        '<span class="bcSeg' + (i === path.length - 1 ? " bcCur" : "") + '"' +
        ' onclick="drillTo(' + (i + 1) + ')" title="' + window.esc(n ? n.name : g) + '">' +
        window.esc(n ? n.name : g) + '</span>';
    });
    h += '<span class="bcHint">拖动只会动这一层</span>' +
      '<span class="bcExit" onclick="drillExit()" title="退出一层（Esc）">退出 ✕</span>';
    bar.innerHTML = h;
  }
  window.updateBreadcrumb = updateBreadcrumb;

  function outermostGroup(id) {
    const chain = window.chainOf(S.design.nodes, id) || [];
    const groups = chain.slice(0, -1).filter(a => a.type === window.NODE_GROUP);
    return groups.length ? groups[0] : null;
  }
  window.outermostGroup = outermostGroup;

  cv.addEventListener("pointerdown", ev => {
    if (!S.design) return;
    cv.setPointerCapture(ev.pointerId);
    const cp = eventPos(ev);                    // 设备（画布位图）坐标
    const np = canvasToNode(cp.x, cp.y);        // 0..360 坐标（移动量用这个）

    // 1) 先判手柄（只在单选时）。**在设备空间判**，旋转过的控件也能点中
    if (S.selection.length === 1) {
      const n = window.findNode(S.design.nodes, S.selection[0]);
      if (n && !n.locked) {
        const lp = toLocal(n, cp);
        if (lp) {
          const h = hitHandle(n, lp, lp.realM);
          if (h >= 0) {
            // 旋转中心取**设备空间**的盒子中心（与 App 的 view.rotation 一致）
            const center = window.matApply(lp.realM, n.w / 2, n.h / 2);
            S.drag = {
              mode: (h === 4 || h === 5) ? "rotate" : "resize",
              corner: h,
              id: n.id,
              startNode: np,
              orig: { x: n.x, y: n.y, w: n.w, h: n.h, rotation: n.rotation },
              // ⚠️ 分组缩放时要把尺寸变化**按比例摊到子控件**上，
              // 否则"拖动组的角，组框变了、里面的表纹丝不动"（实测确认过）。
              // 这里记下子控件的原始几何，每帧从原始值重算（避免逐帧累积误差）。
              origKids: (n.type === window.NODE_GROUP && n.children.length)
                ? n.children.map(c => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }))
                : null,
              center: center,
              startAngle: Math.atan2(cp.y - center.y, cp.x - center.x) * 180 / Math.PI,
            };
            return;
          }
        }
      }
    }

    // 1.5) 子部件：选中的是**带 parts 的仪表**时，点中某个部件就直接拖它（v2.32.0）
    //
    // 为什么放在手柄判定之后、节点命中之前：
    //   · 手柄要先判（否则拖角手柄会被当成拖部件）
    //   · 节点命中之后判的话，点部件会被当成"选中整个仪表"→ 变成 move
    if (S.selection.length === 1) {
      const n1 = window.findNode(S.design.nodes, S.selection[0]);
      if (n1 && n1.parts && n1.parts.length && !n1.locked) {
        const lp1 = toLocal(n1, cp);
        if (lp1) {
          const pi = hitPart(n1, lp1.x, lp1.y);
          if (pi >= 0) {
            const pp = window.normalizePart(n1.parts[pi]);
            S.drag = {
              mode: "part",
              id: n1.id,
              partIndex: pi,
              startNode: np,
              orig: { x: pp.x, y: pp.y },
            };
            if (window.onSelectionChanged) window.onSelectionChanged();
            // ⚠️ **必须在 onSelectionChanged 之后设** ——
            // 它内部会 `S.selectedPart = -1`（换选中对象时清部件选择），
            // 放在它之前会被当场擦掉（实测：拖拽模式是 part，但部件没选中）。
            S.selectedPart = pi;
            return;
          }
          // 点在仪表里但不在任何部件上 → 清掉部件选择（但继续走节点命中）
          S.selectedPart = -1;
        }
      }
    }

    // 2) 命中节点 → 选中（Shift 加选）
    let hit = window.hitTest(S.design.nodes, cp.x, cp.y);
    if (hit) {
      // ⚠️ 点在分组**内部**时，单击选中的是**整个分组** ——
      // 用户要的就是"组合之后拖动为同时拖动"。若直接选子控件，拖动只会动那一个，
      // 分组就形同虚设。
      //
      // 想选组里的某个子控件：**双击**下钻（通用约定），或在控件树里点那一行。
      const top = outermostGroup(hit.id);
      if (top) hit = top;
    }
    if (hit) {
      if (ev.shiftKey) {
        const i = S.selection.indexOf(hit.id);
        if (i >= 0) S.selection.splice(i, 1); else S.selection.push(hit.id);
      } else if (S.selection.indexOf(hit.id) < 0) {
        S.selection = [hit.id];
      }
      if (window.onSelectionChanged) window.onSelectionChanged();

      // 3) 拖动（锁定的不动）
      if (!hit.locked) {
        const movable = S.selection
          .map(id => window.findNode(S.design.nodes, id))
          .filter(n => n && !n.locked)
          .map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
        if (movable.length) {
          S.drag = { mode: "move", startNode: np, items: movable };
        }
      }
      return;
    }

    // 4) 空白 → 框选
    if (!ev.shiftKey) S.selection = [];
    if (window.onSelectionChanged) window.onSelectionChanged();
    S.marquee = { x0: cp.x, y0: cp.y, x1: cp.x, y1: cp.y };
    S.drag = { mode: "marquee" };
  });

  cv.addEventListener("pointermove", ev => {
    if (!S.design) return;
    const cp = eventPos(ev);

    // 光标提示：悬停手柄时给 resize 光标
    if (!S.drag) {
      let cur = "default";
      if (S.selection.length === 1) {
        const n = window.findNode(S.design.nodes, S.selection[0]);
        if (n && !n.locked) {
          const lp = toLocal(n, cp);
          if (lp) {
            const h = hitHandle(n, lp, lp.realM);
            if (h === 4 || h === 5) cur = "grab";
            else if (h >= 0) cur = (h === 0 || h === 2) ? "nwse-resize" : "nesw-resize";
          }
        }
      }
      cv.style.cursor = cur;
      return;
    }

    const d = S.drag;
    if (d.mode === "marquee") {
      S.marquee.x1 = cp.x; S.marquee.y1 = cp.y;
      draw();
      return;
    }

    const np = canvasToNode(cp.x, cp.y);
    // 子部件拖动（v2.32.0）
    //
    // 部件的 x/y 是**节点局部单位**（与节点 w/h 同级），而 np 是 0..360 空间 ——
    // 两者在这里恰好同尺度（都是设计坐标），所以位移直接可用。
    // 若以后引入"节点内独立缩放"，这里要改成用 lp 的增量。
    if (d.mode === "part") {
      const pn = window.findNode(S.design.nodes, d.id);
      if (pn && pn.parts && pn.parts[d.partIndex]) {
        const pdx = np.x - d.startNode.x, pdy = np.y - d.startNode.y;
        const pp = window.normalizePart(pn.parts[d.partIndex]);
        pp.x = Math.round((d.orig.x + pdx) * 10) / 10;
        pp.y = Math.round((d.orig.y + pdy) * 10) / 10;
        pn.parts[d.partIndex] = pp;
        window.onNodeChanged && window.onNodeChanged("part");
      }
    }

    if (d.mode === "move") {
      let dx = np.x - d.startNode.x, dy = np.y - d.startNode.y;
      d.items.forEach(it => {
        const n = window.findNode(S.design.nodes, it.id);
        if (!n) return;
        n.x = moveVal(it.x, dx, n.w);
        n.y = moveVal(it.y, dy, n.h);
      });

      // 对齐吸附：**在网格吸附之后**再做 —— 网格是"整数格"，对齐是"跟别的控件齐"，
      // 后者优先级更高（用户更在意"和旁边那个一样高"）
      if (S.snapGuides !== false) {
        const ids = {};
        d.items.forEach(it => { ids[it.id] = true; });
        const others = window.flatten(S.design.nodes)
          .filter(n => !ids[n.id] && n.visible !== false)
          .map(n => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
        const cur = d.items.map(it => {
          const n = window.findNode(S.design.nodes, it.id);
          return { id: it.id, x: n.x, y: n.y, w: n.w, h: n.h };
        });
        const s = computeSnap(cur, others);
        if (s.dx || s.dy) {
          d.items.forEach(it => {
            const n = window.findNode(S.design.nodes, it.id);
            if (!n) return;
            n.x = clamp(n.x + s.dx, 0, Math.max(0, CANVAS - n.w));
            n.y = clamp(n.y + s.dy, 0, Math.max(0, CANVAS - n.h));
          });
        }
        S.snapLines = s.guides;
      }
      window.onNodeChanged && window.onNodeChanged("move");
    } else if (d.mode === "resize") {
      const n = window.findNode(S.design.nodes, d.id);
      if (!n) return;
      const dx = np.x - d.startNode.x, dy = np.y - d.startNode.y;
      const o = d.orig;
      const c = d.corner;
      // 四角分别处理：左上改 x/y 与 w/h，右下只改 w/h
      //
      // ---- 等比锁（v2.21.0）
      //
      // 先按自由拉伸算出 w/h，再按比例修正其中一个 ——
      // 用「**相对变化更大的那一轴**」驱动另一边：
      // 否则鼠标横向拖一点、纵向拖很多时，尺寸跟不上手（感觉"拖不动"）。
      //
      // **按住 Alt 临时解锁**（与 Photoshop / Figma 的习惯一致）。
      // ⚠️ **组不锁**：组是**布局容器** —— 用户经常需要把它拉宽或拉高来重排，
      // 锁住比例会让"想把一行拉宽一点"变成"整块等比放大"，很反直觉。
      // 图片/表/文字这些"有固有形状"的才锁。
      const lockOn = (S.aspectLock !== false) && !ev.altKey &&
        n.type !== window.NODE_GROUP;
      const ar = o.h > 0.01 ? o.w / o.h : 1;
      const applyLock = (w, h) => {
        if (!lockOn || ar <= 0.001) return [w, h];
        const rw = o.w > 0.01 ? w / o.w : 1;
        const rh = o.h > 0.01 ? h / o.h : 1;
        if (Math.abs(rw - 1) >= Math.abs(rh - 1)) return [w, w / ar];
        return [h * ar, h];
      };

      if (c === 0) {
        const w0 = resizeVal(o.w, -dx, 0), h0 = resizeVal(o.h, -dy, 0);
        const r = applyLock(w0, h0);
        n.x = clamp(o.x + (o.w - r[0]), 0, CANVAS);
        n.y = clamp(o.y + (o.h - r[1]), 0, CANVAS);
        n.w = r[0]; n.h = r[1];
      } else if (c === 1) {
        const w0 = resizeVal(o.w, dx, o.x), h0 = resizeVal(o.h, -dy, 0);
        const r = applyLock(w0, h0);
        n.w = r[0];
        n.y = clamp(o.y + (o.h - r[1]), 0, CANVAS);
        n.h = r[1];
      } else if (c === 2) {
        const w0 = resizeVal(o.w, dx, o.x), h0 = resizeVal(o.h, dy, o.y);
        const r = applyLock(w0, h0);
        n.w = r[0]; n.h = r[1];
      } else {
        const w0 = resizeVal(o.w, -dx, 0), h0 = resizeVal(o.h, dy, o.y);
        const r = applyLock(w0, h0);
        n.x = clamp(o.x + (o.w - r[0]), 0, CANVAS);
        n.w = r[0];
        n.h = r[1];
      }

      // ---- 分组：把尺寸变化**按比例摊到子控件**，实现"打组后一起缩放"
      //
      // ⚠️ 每帧都从 `d.origKids`（拖动开始时的快照）重算，不要在上一次结果上再乘 ——
      // 那样会逐帧累积误差、越拖越偏。
      //
      // ⚠️ 这段是 v2.21.0 加等比锁时**被误删过一次**（按行替换时把区间切多了），
      // 症状是"组能缩放，但里面的控件纹丝不动"。测试当场抓到。
      if (d.origKids && o.w > 0.01 && o.h > 0.01) {
        const sx = n.w / o.w, sy = n.h / o.h;
        d.origKids.forEach(ok => {
          const c2 = window.findNode(S.design.nodes, ok.id);
          if (!c2) return;
          c2.x = ok.x * sx;
          c2.y = ok.y * sy;
          c2.w = Math.max(1, ok.w * sx);
          c2.h = Math.max(1, ok.h * sy);
        });
      }
      // ⚠️ 通知外部（属性面板 / 控件树）刷新 —— 这也是 v2.21.0 按行替换时被误删的，
      // 症状是"拖动缩放时右边的宽高数字不跟着变"。
      window.onNodeChanged && window.onNodeChanged("resize");
    } else if (d.mode === "rotate") {
      const n = window.findNode(S.design.nodes, d.id);
      if (!n) return;
      // ⚠️ 角度必须用**设备坐标**算 —— 旋转中心 `d.center` 是设备空间的盒子中心，
      // 混用 0..360 坐标会让角度在非等比缩放下偏掉（转 45° 实际转出别的角度）
      const ang = Math.atan2(cp.y - d.center.y, cp.x - d.center.x) * 180 / Math.PI;
      let delta = ang - d.startAngle;
      if (ev.shiftKey) delta = Math.round(delta / 15) * 15;   // Shift = 15° 步进
      let r = d.orig.rotation + delta;
      r = ((r % 360) + 360) % 360;
      n.rotation = Math.round(r * 10) / 10;
      window.onNodeChanged && window.onNodeChanged("rotate");
    }
    draw();
  });

  cv.addEventListener("pointerup", ev => {
    const d = S.drag;
    S.drag = null;
    // 参考线只在拖动过程中有意义，松手必须清掉 —— 否则会一直留在画布上
    S.snapLines = null;
    if (d && d.mode === "marquee" && S.marquee) {
      // 框选：**设备空间**里比中心点（这样旋转过的控件也框得准）
      const m = S.marquee;
      const a = { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1) };
      const b = { x: Math.max(m.x0, m.x1), y: Math.max(m.y0, m.y1) };
      const picked = [];
      window.walk(S.design.nodes, n => {
        if (!n.visible) return;
        const wb = deviceBounds(n.id);
        if (!wb) return;
        const cx = wb.x + wb.w / 2, cy = wb.y + wb.h / 2;
        if (cx >= a.x && cx <= b.x && cy >= a.y && cy <= b.y) picked.push(n.id);
      });
      S.selection = picked;
      if (window.onSelectionChanged) window.onSelectionChanged();
    }
    S.marquee = null;
    if (window.onDragEnd) window.onDragEnd();
    draw();
  });

  // ================================================================ 双击下钻

  /**
   * 双击进入分组，选中**最里面**那个控件。
   *
   * 为什么需要它：单击选整个分组（"打组后一起拖动"的前提），
   * 但总得有个办法在画布上直接选中组里的某个子控件 ——
   * 双击是通用约定（Figma / Sketch / PPT 都是这个）。
   * 另一个入口是控件树（点那一行）。
   */
  cv.addEventListener("dblclick", ev => {
    if (!S.design) return;
    const cp = eventPos(ev);
    const hit = window.hitTest(S.design.nodes, cp.x, cp.y);
    if (!hit) return;
    // 已经是叶子节点（不在任何分组里）→ 不改变选择
    const chain = groupChainOf(hit.id);
    if (!chain.length) {
      // 不在任何分组里 → 双击等于"回到画布层"
      if ((S.drillPath || []).length) { S.drillPath = []; updateBreadcrumb(); draw(); }
      return;
    }
    S.drillPath = chain.map(g => g.id);
    S.selection = [hit.id];
    updateBreadcrumb();
    if (window.onSelectionChanged) window.onSelectionChanged();
    draw();
    if (window.toast) {
      const n = window.findNode(S.design.nodes, hit.id);
      const g = chain[chain.length - 1];
      window.toast("已进入「" + g.name + "」，选中「" + (n ? n.name : hit.id) + "」（Esc 退出）");
    }
  });

  // ================================================================ 滚轮缩放选中控件

  /**
   * 滚轮缩放**选中的控件**（不是缩放画布视图）。
   *
   * 为什么绑在"选中"上：不选中时滚轮的含义不明确（缩放谁？）。
   * 选中了才动，符合"像软件一样"的预期。
   *
   * ## 两个容易写错的地方
   *
   * 1. **增量必须扛得住吸附**。第一版用 `STEP * 0.5 = 7.5`，结果
   *    `180 + 7.5 = 187.5` 被 `snapIf` 四舍五入回 **180** —— 下滚完全不缩小。
   *    现在：吸附开着时一格 = 一个完整网格（STEP），关掉时用 5% 平滑增量。
   *
   * 2. **手势要能结束**。滚轮没有"松开"事件，所以用一个短延时收尾；
   *    否则"滚一下 → 干别的 → 再滚"会被合并成同一步撤销。
   */
  let wheelEndTimer = null;

  cv.addEventListener("wheel", ev => {
    if (!S.design) return;
    if (S.selection.length === 0) return;          // 没选中就交给页面滚动
    ev.preventDefault();
    const dir = ev.deltaY > 0 ? -1 : 1;            // 上滚放大

    // ⚠️ **缩放期间跳过整块面板重建**（v2.83.0，Round 4）。
    //
    // `commit()` 会调 `refreshAll()`，而里面的 `renderPanels()` 要重建
    // 整个素材库 + 控件树 + 控制库。实测（60 个控件的设计）：
    //
    //   renderPanels  8.78 ms   ← 滚轮缩放时**一个字都不会变**
    //   draw          1.06 ms
    //   toV2Json      0.23 ms
    //   一次滚轮事件  17.8 ms   → 一次 30 事件的手势 **601 ms**（实测）
    //
    // 滚轮只改选中控件的 w/h，面板里会跟着变的只有属性面板的宽高数字 ——
    // 那个由下面的 `renderProps()` 单独负责。收尾时（停手 350ms）再补一次完整刷新。
    S.suppressPanelRender = true;
    try {
      window.commit(() => {
        S.selection.forEach(id => {
          const n = window.findNode(S.design.nodes, id);
          if (!n || n.locked) return;
          const ar = n.h > 0 ? n.w / n.h : 1;
          const base = Math.min(Math.abs(n.w), Math.abs(n.h));
          // 吸附开着：一格一个网格（能真的移动）；关掉：5% 平滑
          const inc = S.snap
            ? (ev.shiftKey ? window.STEP * 2 : window.STEP)
            : Math.max(1, base * (ev.shiftKey ? 0.10 : 0.05));
          let nw = n.w + inc * dir;
          let nh = nw / ar;
          nw = clamp(S.snap ? snapIf(nw) : nw, window.MIN_SIZE, CANVAS * 2);
          nh = clamp(S.snap ? snapIf(nh) : nh, window.MIN_SIZE, CANVAS * 2);
          n.w = Math.round(nw * 100) / 100;
          n.h = Math.round(nh * 100) / 100;
        });
      }, "滚轮缩放", "wheel");
    } finally {
      S.suppressPanelRender = false;
    }

    // 手势收尾：停手 350ms 后结束合并，下次滚动是新的一步
    clearTimeout(wheelEndTimer);
    wheelEndTimer = setTimeout(() => {
      if (window.onDragEnd) window.onDragEnd();
      // 缩放期间被跳过的整块面板重建，在收尾时**补一次**（v2.83.0，Round 4）
      if (window.refreshAll) window.refreshAll();
    }, 350);

    draw();
    if (window.renderProps) window.renderProps();
  }, { passive: false });

  // ================================================================ 右键菜单

  const menuEl = document.getElementById("ctxMenu");

  function hideMenu() {
    if (menuEl) menuEl.classList.remove("show");
  }
  window.hideCtxMenu = hideMenu;

  /**
   * 右键菜单。**像软件一样**：在画布上右键出菜单，动作随选中项变化。
   *
   * 菜单项定义成数据（而不是拼 HTML 字符串），这样：
   *   - 每一项都能带禁用条件（比如没选中时"删除"变灰）
   *   - 加项只改数组，不改渲染逻辑
   */
  function ctxItemsFor(hasSel, multi) {
    const n = (!multi && hasSel) ? window.findNode(S.design.nodes, S.selection[0]) : null;
    const locked = n ? !!n.locked : false;
    const items = [];
    const A = (label, ic, fn, opts) => items.push(Object.assign({ label, ic, fn }, opts || {}));

    if (hasSel) {
      A("复制", "⧉", () => window.dupSelected(), { k: "Ctrl+D" });
      A("删除", "🗑", () => window.delSelected(), { k: "Del", danger: true });
      // ---- 编辑控件（用户要求：右键就能改，改完可存素材库/导出）
      if (!multi) {
        A("编辑控件…", "✎", () => window.openControlEditor(S.selection[0]),
          { k: "F2", note: "打开控件编辑器：改属性、实时预览、可保存到素材库或导出 JSON" });
      }
      items.push({ sep: true });
      // ---- 打组 / 取消组合
      const gchk = window.groupCheck(S.design.nodes, S.selection);
      A("打组", "▤", () => window.groupSelected(), {
        k: "Ctrl+G", disabled: !gchk.ok,
        note: gchk.ok ? "把选中的 " + gchk.count + " 个控件合成一组，之后一起拖动" : gchk.reason,
      });
      const anyGroup = S.selection.some(id => window.isGroup(S.design.nodes, id));
      A("取消组合", "▢", () => window.ungroupSelected(), {
        k: "Ctrl+Shift+G", disabled: !anyGroup,
        note: anyGroup ? "还原成独立控件，位置不变" : "选中的不是分组",
      });
      items.push({ sep: true });
      A("置顶", "⬆", () => window.layerCmd("front"));
      A("上移一层", "↑", () => window.layerCmd("up"));
      A("下移一层", "↓", () => window.layerCmd("down"));
      A("置底", "⬇", () => window.layerCmd("back"));
      items.push({ sep: true });
      if (!multi) {
        A(locked ? "解锁" : "锁定", locked ? "🔓" : "🔒", () => window.toggleLock(),
          { note: locked ? "解锁后可拖动" : "锁定后不可拖动/缩放/旋转" });
        A(n && n.visible ? "隐藏" : "显示", n && n.visible ? "🚫" : "👁", () => window.toggleVisible());
        items.push({ sep: true });
        A("旋转 +15°", "↻", () => rotateBy(15));
        A("旋转 −15°", "↺", () => rotateBy(-15));
        A("旋转归零", "⟲", () => rotateTo(0), { disabled: n && Math.abs(n.rotation || 0) < 0.01 });
        A("缩放归 1×", "⇱", () => scaleTo(1), { disabled: n && Math.abs((n.scale || 1) - 1) < 0.001 });
      }
      if (multi) {
        items.push({ sep: true });
        A("左对齐", "⇤", () => window.alignSel("left"));
        A("水平居中", "⇹", () => window.alignSel("hcenter"));
        A("右对齐", "⇥", () => window.alignSel("right"));
        A("顶对齐", "⤒", () => window.alignSel("top"));
        A("垂直居中", "⇳", () => window.alignSel("vcenter"));
        A("底对齐", "⤓", () => window.alignSel("bottom"));
        items.push({ sep: true });
        A("水平等距", "≡", () => window.distributeSel("h"));
        A("垂直等距", "⋮", () => window.distributeSel("v"));
        A("全部锁定", "🔒", () => window.lockSel(true));
        A("全部解锁", "🔓", () => window.lockSel(false));
      }
    } else {
      A("全选", "▣", () => {
        S.selection = window.flatten(S.design.nodes).map(x => x.id);
        if (window.onSelectionChanged) window.onSelectionChanged();
      }, { k: "Ctrl+A" });
      A("从预设新建…", "✧", () => {
        document.querySelector('[onclick*="togglePanel(\'preset\')"]');
        window.togglePanel && expandPreset();
      });
    }
    items.push({ sep: true });
    A("取消选择", "✕", () => {
      S.selection = [];
      if (window.onSelectionChanged) window.onSelectionChanged();
    }, { k: "Esc", disabled: !hasSel });
    return items;
  }

  function expandPreset() {
    // 让"从预设新建"真的展开面板（否则点了没反应，看着像坏了）
    const body = document.getElementById("body-preset");
    if (body && body.style.display === "none") window.togglePanel("preset");
  }

  function rotateBy(d) {
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (!n) return;
        n.rotation = ((n.rotation || 0) + d) % 360;
        if (n.rotation < 0) n.rotation += 360;
      });
    }, "旋转 " + d + "°");
  }
  function rotateTo(v) {
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (n) n.rotation = v;
      });
    }, "旋转归零");
  }
  function scaleTo(v) {
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (n) n.scale = v;
      });
    }, "缩放归 1×");
  }
  window.rotateBy = rotateBy;
  window.rotateTo = rotateTo;
  window.scaleTo = scaleTo;

  function showMenu(clientX, clientY) {
    if (!menuEl) return;
    const hasSel = S.selection.length > 0;
    const multi = S.selection.length > 1;
    const items = ctxItemsFor(hasSel, multi);

    menuEl.innerHTML = "";
    // 标题：一眼看出在操作谁
    const title = document.createElement("div");
    title.className = "ctxTitle";
    if (multi) title.textContent = "已选 " + S.selection.length + " 个控件";
    else if (hasSel) {
      const n = window.findNode(S.design.nodes, S.selection[0]);
      title.textContent = n ? (n.name + "　·　" + (window.NODE_TYPES.find(t => t.v === n.type) || {}).n) : "（已失效）";
    } else {
      title.textContent = "画布";
    }
    menuEl.appendChild(title);

    items.forEach(it => {
      if (it.sep) {
        const s = document.createElement("div");
        s.className = "ctxSep";
        menuEl.appendChild(s);
        return;
      }
      const d = document.createElement("div");
      d.className = "ctxItem" + (it.disabled ? " disabled" : "");
      d.innerHTML = '<span class="ic">' + (it.ic || "") + "</span><span>" + window.esc(it.label) + "</span>" +
        (it.k ? '<span class="k">' + it.k + "</span>" : "");
      if (it.note) d.title = it.note;
      if (!it.disabled) {
        d.onclick = () => { hideMenu(); it.fn(); };
      }
      menuEl.appendChild(d);
    });

    // 先显示再量尺寸，避免超出窗口
    menuEl.classList.add("show");
    const r = menuEl.getBoundingClientRect();
    let x = clientX, y = clientY;
    if (x + r.width > window.innerWidth - 6) x = window.innerWidth - r.width - 6;
    if (y + r.height > window.innerHeight - 6) y = window.innerHeight - r.height - 6;
    menuEl.style.left = Math.max(4, x) + "px";
    menuEl.style.top = Math.max(4, y) + "px";
  }
  window.showCtxMenu = showMenu;

  cv.addEventListener("contextmenu", ev => {
    ev.preventDefault();
    if (!S.design) return;
    // 右键在某个控件上：先选中它（和大多数软件一致）
    const cp = eventPos(ev);
    const np = canvasToNode(cp.x, cp.y);
    const hit = window.hitTest(S.design.nodes, cp.x, cp.y);
    if (hit && S.selection.indexOf(hit.id) < 0) {
      S.selection = [hit.id];
      if (window.onSelectionChanged) window.onSelectionChanged();
    }
    showMenu(ev.clientX, ev.clientY);
  });

  // 点别处 / 按 Esc 关掉菜单
  document.addEventListener("pointerdown", ev => {
    if (menuEl && menuEl.classList.contains("show") && !menuEl.contains(ev.target)) hideMenu();
  }, true);
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") hideMenu();
  });
  window.addEventListener("blur", hideMenu);

  // ================================================================ 尺寸

  /**
   * 按容器可用空间算画布显示尺寸。
   *
   * ⚠️ **宽高比 = designW : designH** —— 设计者能直接看到目标屏幕的形状，
   * 以及 scaleMode 会不会留黑边。
   */
  function applyCanvasSize() {
    if (!S.design) return;
    const wrap = cv.parentElement;
    const availW = Math.max(0, wrap.clientWidth - 16);
    const availH = Math.max(0, wrap.clientHeight - 16);
    const ar = S.design.canvas.designW / S.design.canvas.designH;

    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    w = Math.max(160, Math.round(w));
    h = Math.max(120, Math.round(h));

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    const bw = Math.min(2048, Math.round(w * dpr));
    const bh = Math.min(2048, Math.round(h * dpr));
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }

    draw();
    const lbl = document.getElementById("canvasSizeLabel");
    if (lbl) {
      lbl.textContent = S.design.canvas.designW + "×" + S.design.canvas.designH +
        " → " + w + "×" + h;
    }
  }
  window.applyCanvasSize = applyCanvasSize;

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyCanvasSize, 100);
  });
  if (typeof ResizeObserver !== "undefined") {
    try {
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(applyCanvasSize, 50);
      }).observe(cv.parentElement);
    } catch (e) { /* 靠 resize 兜底 */ }
  }

  /** 图片缓存：URL → Image（避免每帧新建） */
  S.imgCache = {};
  window.loadAssetImage = function (assetId, url) {
    if (!url) return;
    S.assetUrls[assetId] = url;
    if (!S.imgCache[url]) {
      const img = new Image();
      // ⚠️ 图片是**异步**解码的。onload 里只重绘主画布是不够的 ——
      // 控件编辑器的预览也要重绘，否则"从控件库新建控件 → 立刻打开编辑器"
      // 会一直显示**紫色占位 X**（素材刚登记、位图还没解码）。
      // 实测：40 个内置控件里有 16 个中招（全是带素材的）。
      img.onload = () => {
        draw();
        if (window.redrawEditorPreview) window.redrawEditorPreview();
      };
      img.src = url;
      S.imgCache[url] = img;
    }
  };
})();
