/**
 * gen-lamps.js —— 指示灯「每类一张自己的图」（v2.91.0）
 *
 * ## 为什么单开一个文件（以及为什么必须新增而不是改旧的）
 *
 * 体检实测（`stage/recon-v291.js`，v2.91.0）：
 *
 * ```
 * normal 去重：{"assets/warning/lamp-off.png": 19}     ← 19 个灯**全是同一张**
 * warn   去重：{"assets/warning/lamp-warn.png": 19}    ← 19 个灯**全是同一张**
 * critical 去重：19 个里 18 张不同（coolant-warn 被 lamp_coolant/lamp_temp 共用）
 * ```
 *
 * 也就是用户说的「**指示灯需要优化、而不是全部都是一个图**」——
 * 实测成立：**暗态与警告态 19 个灯逐像素完全一样**，只有严重态有区分。
 * 拖 5 个灯到画布上，平时看到的是**5 个一模一样的圆**，认不出哪个是哪个。
 *
 * ## 为什么新增素材而不是改 `lamp-off` / `lamp-warn` 的内容
 *
 * 那两张是**存量设计文件按路径引用的素材**（`assets/warning/lamp-off.png`）。
 * 改内容 = 改所有存量设计在设备上的样子（§2.41「素材路径是设计文件里的契约」）。
 * 所以：**旧的两张一个字都不动**，新增 57 张，把控件指向新的。
 *
 * ## 版权：全部是**代码画出来的几何形状**
 *
 * 形状依据 ISO 2575（道路车辆·操纵件指示器信号装置符号）的**常见语义**，
 * 但每一条都是本仓库用 `png.js` 的绘图原语画的**自己的几何图形**，
 * 没有下载任何第三方图片、也没有逐点复刻任何标准的官方图版。
 * 与 `gen-assets-more.js` 里那批警告灯同一条线（文件头有同样的声明）。
 *
 * ## 高清：192×192，是旧灯盘（64×64）的 **9 倍像素**
 *
 * 旧的三态灯盘是 **64×64**；严重态那批是 128×128。这里统一 **192×192**。
 * 更关键的是**画法**：所有形状都按逻辑空间 0..256 描述、乘 `k = S/256` 绘制，
 * 所以改 `S` 就能整体升分辨率 —— 不是把一张小图放大。
 *
 * ⚠️ **为什么不是 256**：256 实测 base64 合计 397.8 KB，会把内嵌总量顶到
 * **1196 KB / 上限 1200 KB**（余量 4 KB = 再加一个灯就红）。192 是
 * **1048 KB**，留 152 KB 余量；而 192 对"画布上 56 单位的灯"（典型显示约
 * 112 px）已经是 1.7 倍过采样，肉眼与 256 无差别。数字见
 * `stage/probe-lamps.js` 的实测输出。
 *
 * ## 体积预算（这条是硬约束，不是"顺手优化"）
 *
 * 内嵌 data URL 的总量有断言卡着：`verify-asset-audit.js` 的
 * `清单体积 < 1200 KB`（实测 v2.90.0 是 798 KB → 余量 402 KB）。
 * 发光层是体积大头（12 圈发光 = 14.9 KB/张，0 圈 = 3.6 KB/张，实测见
 * `stage/probe-lamp-size2.js`），所以三态的发光圈数**刻意不同**：
 *
 * | 状态 | 发光 | 实测体积 |
 * |---|---|---|
 * | normal（暗） | 无 | ~2.7 KB |
 * | warn（黄） | 1 圈 | ~4.1 KB |
 * | critical（红） | 1 圈 | ~5.0 KB |
 *
 * 57 张 ≈ 224 KB —— 在余量里。**加灯之前先算一遍这个账。**
 */

module.exports = function (ctx) {
  const { save, Canvas, C } = ctx;
  const { CYAN, AMBER, RED, GREY, GREY_DARK, WHITE } = C;

  /**
   * 分辨率。**改这一个数就能整体升/降清晰度** ——
   * 下面所有坐标都是 0..256 的逻辑空间，乘 `k` 落到画布上。
   *
   * ⚠️ 改它之前先看文件头的「体积预算」：256 会把内嵌总量顶到 1196/1200 KB。
   */
  const S = 192;

  /**
   * 三态的配色。
   *
   * `glyph` 是图形本身的颜色 —— 它画在色盘上，所以**必须和 `plate` 拉开对比**。
   * ⚠️ v2.91.0 实测踩到过一次：第一版 warn/crit 的 `glyph` 是 `#241605` / `#2A0606`
   * （深棕/深红），和盘色的亮度差只有 ~40，"车门"那个图形几乎看不见
   * （像素体检报出来它的墨迹只剩 201 px，而同类图形都是 2000+）。
   * 现在 warn/crit 用 `#1A1004` / `#1A0404`，亮度差 ~90。
   */
  const STATE = {
    normal:   { plate: "#1B2430", ring: GREY_DARK, glyph: "#93A3B7", glow: 0, glowA: 0 },
    warn:     { plate: AMBER,     ring: "#7A5410", glyph: "#1A1004", glow: 1, glowA: 0.06 * 255 },
    critical: { plate: RED,       ring: "#7A1D1F", glyph: "#1A0404", glow: 1, glowA: 0.05 * 255 },
  };

  // ---------------------------------------------------------------- 19 个图形
  //
  // 每个函数收一个 `g`（已按 S 缩放好的绘图上下文）和颜色。
  // 坐标一律写在 **256 的逻辑空间**里，中心 (128,128)，图形落在 r≈76 以内
  // —— 外面留出 92 的盘边，不会压到圆环上。
  //
  // ⚠️ 这里**没有文字绘制能力**（见 gen-assets-more.js 文件头）：
  // 所以 ABS / ESP / P 这类"带字母"的标准符号只能用**几何形状**近似。
  // 每个字母都是笔画拼的，不是字体。

  const GLYPHS = {
    /** 水温：温度计（球 + 管 + 液柱） */
    coolant: function (g, col) {
      g.roundRect(112, 54, 32, 96, 16, col);
      g.line(128, 70, 128, 132, 12, col);
      g.circle(128, 168, 26, col);
      g.line(88, 60, 108, 60, 8, col);
      g.line(88, 82, 104, 82, 8, col);
      g.line(88, 104, 108, 104, 8, col);
    },
    /** 机油：油壶（壶身 + 壶嘴 + 提手 + 滴） */
    oil: function (g, col) {
      g.roundRect(76, 108, 96, 68, 12, col);
      g.poly([[172, 122], [198, 112], [198, 132], [172, 142]], col);
      g.line(96, 108, 112, 88, 12, col);
      g.line(112, 88, 148, 88, 12, col);
      g.line(148, 88, 156, 108, 12, col);
      g.circle(96, 148, 12, "#05070A");
      g.line(76, 176, 58, 192, 9, col);
      g.line(172, 176, 190, 192, 9, col);
    },
    /** 电池：壳体 + 极柱 + 正负号 */
    battery: function (g, col) {
      g.roundRect(60, 100, 136, 68, 10, col);
      g.rect(80, 88, 30, 12, col);
      g.rect(146, 88, 30, 12, col);
      g.line(86, 124, 112, 124, 9, "#05070A");
      g.line(99, 111, 99, 137, 9, "#05070A");
      g.line(144, 124, 170, 124, 9, "#05070A");
    },
    /** 制动：圆环 + 感叹号（ISO 2575 最常见的制动符号形态） */
    brake: function (g, col) {
      g.ring(128, 128, 74, 13, col);
      g.line(128, 84, 128, 142, 16, col);
      g.circle(128, 172, 10, col);
      g.line(76, 60, 108, 92, 8, col);
      g.line(180, 60, 148, 92, 8, col);
    },
    /** 刹车片：外圈 + 内圈 + 磨损指示 */
    pad: function (g, col) {
      g.ring(128, 128, 74, 12, col);
      g.ring(128, 128, 46, 12, col);
      g.line(128, 84, 128, 128, 13, col);
      g.line(128, 156, 128, 172, 13, col);
    },
    /** 胎压：轮胎断面 + 胎面花纹 */
    tpms: function (g, col) {
      g.ring(128, 128, 62, 18, col);
      g.ring(128, 128, 34, 9, col);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        g.line(128 + Math.cos(a) * 62, 128 + Math.sin(a) * 62,
               128 + Math.cos(a) * 76, 128 + Math.sin(a) * 76, 8, col);
      }
      g.line(128, 188, 128, 204, 9, col);
      g.circle(128, 208, 6, col);
    },
    /** 气囊：坐着的人 + 前方的气囊球 */
    airbag: function (g, col) {
      g.circle(94, 84, 20, col);
      g.line(94, 104, 94, 162, 13, col);
      g.line(94, 122, 66, 152, 12, col);
      g.line(94, 122, 122, 146, 12, col);
      g.line(94, 162, 66, 196, 12, col);
      g.circle(174, 132, 32, col);
      g.line(174, 100, 174, 78, 8, col);
      g.line(146, 106, 132, 90, 8, col);
      g.line(202, 106, 216, 90, 8, col);
    },
    /** 安全带：斜带 + 锁扣 */
    seatbelt: function (g, col) {
      g.line(74, 190, 186, 68, 18, col);
      g.roundRect(62, 178, 34, 42, 8, col);
      g.circle(196, 66, 16, col);
      g.line(96, 104, 128, 104, 9, col);
    },
    /** ABS：环形 + 字母笔画 */
    abs: function (g, col) {
      g.ring(128, 128, 76, 12, col);
      // A
      g.line(78, 158, 92, 100, 9, col);
      g.line(92, 100, 106, 158, 9, col);
      g.line(84, 138, 100, 138, 8, col);
      // B
      g.line(116, 100, 116, 158, 9, col);
      g.line(116, 100, 130, 100, 8, col);
      g.line(130, 100, 130, 128, 8, col);
      g.line(116, 128, 130, 128, 8, col);
      g.line(130, 128, 130, 158, 8, col);
      g.line(116, 158, 130, 158, 8, col);
      // S
      g.line(164, 100, 142, 100, 8, col);
      g.line(142, 100, 142, 128, 8, col);
      g.line(142, 128, 164, 128, 8, col);
      g.line(164, 128, 164, 158, 8, col);
      g.line(164, 158, 142, 158, 8, col);
    },
    /** ESP：车 + 打滑波 + 感叹号 */
    esp: function (g, col) {
      g.poly([[64, 132], [128, 132], [116, 108], [76, 108]], col);
      g.line(54, 148, 84, 148, 10, col);
      g.line(94, 148, 120, 148, 10, col);
      g.line(54, 172, 88, 172, 10, col);
      g.line(98, 172, 128, 172, 10, col);
      g.line(170, 92, 170, 148, 15, col);
      g.circle(170, 172, 10, col);
    },
    /** 发动机：机体轮廓 + 缸盖 */
    engine: function (g, col) {
      g.poly([[66, 112], [98, 112], [110, 88], [152, 88], [152, 112], [192, 112],
              [192, 176], [66, 176]], col);
      g.rect(86, 124, 26, 26, "#05070A");
      g.rect(134, 124, 26, 26, "#05070A");
      g.rect(172, 124, 24, 20, "#05070A");
    },
    /** 燃油：油泵（立柱 + 泵体 + 油滴） */
    fuel: function (g, col) {
      g.roundRect(84, 96, 70, 92, 12, col);
      g.line(154, 110, 178, 110, 10, col);
      g.line(178, 110, 178, 158, 10, col);
      g.roundRect(160, 150, 36, 40, 10, col);
      g.line(96, 74, 142, 74, 10, col);
      g.line(119, 74, 119, 96, 10, col);
    },
    /** 车门未关：车身侧视 + 开着的门 */
    door: function (g, col) {
      g.roundRect(60, 62, 118, 130, 12, col);
      g.rect(78, 80, 82, 46, "#05070A");
      g.line(178, 58, 204, 196, 14, col);
      g.line(204, 196, 222, 186, 12, col);
    },
    /** 玻璃水：挡风玻璃 + 喷水 */
    washer: function (g, col) {
      g.poly([[74, 138], [182, 138], [168, 194], [88, 194]], col);
      g.line(74, 138, 182, 138, 10, col);
      g.line(72, 106, 96, 118, 8, col);
      g.line(66, 88, 88, 104, 8, col);
      g.line(70, 70, 84, 92, 8, col);
      g.circle(100, 118, 6, col);
      g.circle(86, 100, 5, col);
    },
    /** 保养：扳手 + 提示标 */
    service: function (g, col) {
      g.line(92, 100, 148, 156, 22, col);
      g.ring(164, 172, 24, 14, col);
      g.ring(78, 86, 24, 14, col);
      g.line(84, 84, 72, 72, 12, col);
    },
    /** 车道辅助：两条车道线 + 中间的车 */
    lane: function (g, col) {
      g.line(72, 66, 48, 190, 12, col);
      g.line(184, 66, 208, 190, 12, col);
      g.poly([[104, 136], [152, 136], [142, 112], [114, 112]], col);
      g.line(96, 152, 160, 152, 10, col);
      g.circle(108, 160, 7, col);
      g.circle(148, 160, 7, col);
    },
    /** 碰撞预警：车 + 前方放射线 */
    collision: function (g, col) {
      g.poly([[86, 150], [170, 150], [158, 124], [98, 124]], col);
      g.line(76, 168, 180, 168, 10, col);
      g.line(128, 106, 128, 76, 10, col);
      g.line(96, 112, 76, 88, 10, col);
      g.line(160, 112, 180, 88, 10, col);
      g.circle(128, 62, 8, col);
    },
    /** 远光：灯体 + 平直光线 */
    highbeam: function (g, col) {
      g.arc(104, 128, 42, 26, -76, 76, col);
      g.line(104, 88, 190, 88, 10, col);
      g.line(104, 128, 196, 128, 10, col);
      g.line(104, 168, 190, 168, 10, col);
    },
  };

  /** 19 个灯：控件 key 尾 → 图形名 + 中文（label 用） */
  const LAMPS = [
    ["coolant", "coolant", "水温灯"],
    ["oil", "oil", "机油灯"],
    ["batt", "battery", "电池灯"],
    ["brake", "brake", "制动灯"],
    ["pad", "pad", "刹车片"],
    ["tpms", "tpms", "胎压灯"],
    ["airbag", "airbag", "气囊灯"],
    ["belt", "seatbelt", "安全带灯"],
    ["abs", "abs", "ABS 灯"],
    ["esp", "esp", "ESP 灯"],
    ["engine", "engine", "发动机灯"],
    ["fuel", "fuel", "燃油报警"],
    ["door", "door", "车门未关"],
    ["washer", "washer", "玻璃水"],
    ["service", "service", "保养提示"],
    ["temp", "coolant", "水温报警"],
    ["charge", "battery", "充电提示"],
    ["lane", "lane", "车道辅助"],
    ["collision", "collision", "碰撞预警"],
  ];

  /**
   * 画**盘面**（不含图形）。单独抽出来是为了能被测：
   * 「图形到底画没画上去」只能靠"同一块盘 + 不带图形"的对照图算出来
   * —— 从成品图上按颜色猜，在图形与盘色接近时会**静默漏判**
   * （v2.91.0 实测踩到：`door` 的 warn 态被漏判成"只有 201 个墨迹像素"）。
   */
  function drawPlate(state) {
    const cfg = STATE[state];
    const k = S / 256;
    const c = new Canvas(S, S);
    const cx = 128 * k, cy = 128 * k;
    // 发光：**画在盘面下面**，所以是外圈的一层层淡色
    for (let i = cfg.glow; i >= 1; i--) {
      c.circle(cx, cy, (92 + i * 8) * k, cfg.plate, cfg.glowA);
    }
    c.circle(cx, cy, 92 * k, cfg.ring);
    c.circle(cx, cy, 78 * k, cfg.plate);
    // 左上高光：让暗态也有"这是颗灯"的体积感（旧 lamp-off 就是这么画的）
    c.circle(cx - 30 * k, cy - 34 * k, 22 * k, WHITE, 0.16 * 255);
    return c;
  }

  /**
   * 把逻辑 0..256 坐标的图形画到画布上。
   *
   * `T(x,y) → [x,y]` 是**逻辑空间内的变换**（缩放 + 居中），默认不变换。
   * 把它抽成参数是为了让"量包围盒"和"按量出来的结果再画"走**同一条代码路径**
   * —— 两条路径分叉的话，量出来的缩放和实际画出来的就不是一回事了。
   */
  function paintGlyphWith(c, glyphName, col, T, scale) {
    const glyph = GLYPHS[glyphName];
    if (!glyph) throw new Error("gen-lamps: 没有这个图形 `" + glyphName + "`");
    const k = S / 256;
    const s = scale === undefined ? 1 : scale;
    const M = T || function (x, y) { return [x, y]; };
    const P = function (x, y) { const p = M(x, y); return [p[0] * k, p[1] * k]; };
    glyph({
      rect: function (x, y, w, h, cc) { const p = P(x, y); c.rect(p[0], p[1], w * s * k, h * s * k, cc === undefined ? col : cc); },
      roundRect: function (x, y, w, h, r, cc) { const p = P(x, y); c.roundRect(p[0], p[1], w * s * k, h * s * k, r * s * k, cc === undefined ? col : cc); },
      circle: function (x, y, r, cc) { const p = P(x, y); c.circle(p[0], p[1], r * s * k, cc === undefined ? col : cc); },
      ring: function (x, y, r, t, cc) { const p = P(x, y); c.ring(p[0], p[1], r * s * k, t * s * k, cc === undefined ? col : cc); },
      arc: function (x, y, r, t, a0, a1, cc) { const p = P(x, y); c.arc(p[0], p[1], r * s * k, t * s * k, a0, a1, cc === undefined ? col : cc); },
      line: function (x0, y0, x1, y1, t, cc) {
        const a = P(x0, y0), b = P(x1, y1);
        c.line(a[0], a[1], b[0], b[1], t * s * k, cc === undefined ? col : cc);
      },
      poly: function (pts, cc) { c.poly(pts.map(function (p) { const q = P(p[0], p[1]); return [q[0], q[1]]; }), cc === undefined ? col : cc); },
    }, col);
    return c;
  }

  /** 不变换地画（量包围盒时用这个） */
  function paintGlyph(c, glyphName, col) { return paintGlyphWith(c, glyphName, col, null, 1); }

  /**
   * 图形的**安全半径**（逻辑坐标）。
   *
   * 盘面半径是 78；图形必须落在 74 以内 —— 留 4 的逻辑余量给抗锯齿。
   *
   * ⚠️ 判据是**半径**不是"方框"：先按包围盒缩到方框里，再检查最远点 ——
   * 一个 148×148 的方框，四个角到中心是 104.6，仍然在盘外。
   * v2.91.0 第一版就是只按方框缩，结果 `door` 还是 91.6。
   */
  const FIT_R = 74;

  /**
   * 把每个图形**量一遍**，算出缩放与居中偏移。
   *
   * ## 为什么必须自动量，而不是"画的时候小心点"
   *
   * v2.91.0 实测：19 个图形里 **14 个画到了盘外** —— 最离谱的 `door`
   * 逻辑半径到了 **117**（盘半径才 78），`belt` 110、`airbag`/`oil` 100。
   * 这些数字**光看代码看不出来**：`line(178,58,204,196)` 的端点半径是 110，
   * 而那还要再加上 7 的逻辑线宽。靠人眼估必然漏，所以改成**机器量**。
   *
   * ## 两步：先居中，再按**最远点**缩
   *
   * 1. 量出包围盒 → 算出"把包围盒中心挪到 (128,128)"的偏移；
   * 2. 在**居中之后**的坐标系里量**最远像素半径** `R` → 缩放 = `74 / R`。
   *
   * 第 2 步不能省（也不能用包围盒对角线代替）：图形是不规则的，
   * 只有真的量每一个像素才知道最远点在哪。
   */
  const FIT = (function measureGlyphs() {
    const out = {};
    Object.keys(GLYPHS).forEach(function (name) {
      const k = S / 256;
      const c = new Canvas(S, S);
      paintGlyph(c, name, "#FF00FF");            // 只为拿包围盒，颜色随便
      const img = decodeOwnPng(c);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        if (img.rgba[(y * img.w + x) * 4 + 3] < 8) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 < x0) { out[name] = { scale: 1, dx: 0, dy: 0, r0: 0, empty: true }; return; }
      const cxPx = (x0 + x1 + 1) / 2, cyPx = (y0 + y1 + 1) / 2;
      // 第 2 步：以「居中后」的中心量最远像素
      let rMax = 0;
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
        if (img.rgba[(y * img.w + x) * 4 + 3] < 8) continue;
        const r = Math.hypot(x + 0.5 - cxPx, y + 0.5 - cyPx) / k;
        if (r > rMax) rMax = r;
      }
      const scale = Math.min(FIT_R / rMax, 1.0);
      out[name] = {
        scale: scale, dx: 128 - cxPx / k, dy: 128 - cyPx / k,
        r0: rMax, bw: Math.round((x1 - x0 + 1) / k), bh: Math.round((y1 - y0 + 1) / k),
        empty: false,
      };
    });
    return out;
  })();

  /**
   * 极简 PNG 解码（只认**自家编码器**的产物：8bit RGBA、filter=0）。
   * 只给 `measureGlyphs` 用 —— 这里刻意不引 `tests/_common.js`
   * （生成器不该依赖测试目录）。
   */
  function decodeOwnPng(canvas) {
    const zlib = require("zlib");
    const buf = canvas.toPng();
    let p = 8, w = 0, h = 0;
    const idat = [];
    while (p + 12 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.toString("ascii", p + 4, p + 8);
      if (type === "IHDR") { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); }
      if (type === "IDAT") idat.push(buf.slice(p + 8, p + 8 + len));
      p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * 4 + 1;
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) raw.copy(rgba, y * w * 4, y * stride + 1, y * stride + 1 + w * 4);
    return { w: w, h: h, rgba: rgba };
  }

  /** 按 `FIT` 把图形缩放 + 居中后画上去 */
  function paintGlyphFitted(c, glyphName, col) {
    const f = FIT[glyphName];
    if (!f || f.scale === 1) return paintGlyph(c, glyphName, col);
    const T = function (x, y) {
      return [128 + (x - 128) * f.scale + f.dx * f.scale, 128 + (y - 128) * f.scale + f.dy * f.scale];
    };
    return paintGlyphWith(c, glyphName, col, T, f.scale);
  }

  /**
   * 画一张灯。`state` 是 `STATE` 里的键，`glyphName` 是 `GLYPHS` 里的键。
   *
   * 盘面本身**三态同形**（同心圆 + 高光），变的只有颜色与发光 ——
   * 这正是"灯亮没亮"要看的东西。图形负责"这是哪个灯"。
   */
  function drawLamp(state, glyphName) {
    const c = drawPlate(state);
    return paintGlyphFitted(c, glyphName, STATE[state].glyph);
  }

  /**
   * 生成全部 19×3 张。
   *
   * 命名：`assets/warning/lamp-<key>-<state>.png`
   * （旧的三张 `lamp-off` / `lamp-warn` / `lamp-crit` **一个字都不动**）
   */
  function genLamps() {
    let n = 0;
    LAMPS.forEach(function (row) {
      const key = row[0], glyphName = row[1], label = row[2];
      ["normal", "warn", "critical"].forEach(function (state) {
        const suffix = state === "normal" ? "off" : (state === "warn" ? "warn" : "crit");
        const zh = state === "normal" ? "暗" : (state === "warn" ? "警告" : "严重");
        save("warning", "lamp-" + key + "-" + suffix,
          drawLamp(state, glyphName), label + "·" + zh + "（ISO 2575 语义，" + S + "×" + S + " 代码绘制）");
        n++;
      });
    });
    return n;
  }

  return {
    genLamps: genLamps, LAMPS: LAMPS, GLYPHS: GLYPHS, STATE: STATE, S: S,
    FIT_R: FIT_R,
    // 测试用：盘面 / 图形 / 适配参数的**分开**入口（见 `drawPlate` 的说明）
    drawPlate: drawPlate, drawLamp: drawLamp, FIT: FIT,
  };
};
