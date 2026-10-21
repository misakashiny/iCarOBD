/* ==========================================================================
   js/registry/controls/track-family.js —— P3D 代码轨道族（28 条）
   ==========================================================================

   ## 范围

   `cd_*` 系列 **28 条**（代码绘制轨道）。
   ⚠️ **不含 `bar_*`** —— 那是图片轨道（另一种实现），本阶段明令禁止迁移。

   ## 参数化设计

   28 条不是 28 份实现，而是 **9 个参数的组合**：

   | 参数 | 取值 | 影响的 key |
   |---|---|---|
   | `orient` | `h` / `v` | 每条都有（14 组 × 2） |
   | `radius` | `null` / 数字 | 决定圆角；缺省 = 短边一半（胶囊） |
   | `inset` | `true` | `cd_trackinset*` |
   | `gradient` | `null` / `"gloss"` / `"fade"` | `cd_trackgrad*` / `cd_trackfade*` |
   | `glow` | `true` | `cd_trackglow*` / `cd_fillglow*` / `cd_cursor*` |
   | `segments` | `0` / `5` / `10` / `20` | `cd_seg*` |
   | `ticks` | `0` / `10` | `cd_trackticks*` |
   | `band` | `true` | `cd_band3*` |
   | `fill` | `null` / `0.62` / `1` | `cd_fill*` / `cd_marker*` / `cd_cursor*` |

   **共享工厂** `buildTrack(d, props)` 一处实现，28 条只写参数 ——
   但每条 key 的**具体默认行为**（尺寸、z、trackStyle 各字段）逐字段照抄旧实现。

   ## ⚠️ 全部 28 条都是 NODE_IMAGE

   实测确认（`_tg.js` 抓取时统计）：**28/28 都是 `NODE_IMAGE`**。

   所以它们**全部**受 `panels.js` 的 `prepareBuiltinImages` 包装影响：
   `w` 会被按画布宽高比缩放（`240 × 1600/2560 = 150`）。

   Golden 里看到的 `150x16` 就是**包装后**的值 —— 这是正确行为。
   P3C-2 已把 bridge 调用移到 `panels.js` 之后，本族自动受益。

   ## `assetId` 留空

   旧实现显式传 `assetId: ""` 且注释说明：
   > `drawTrackNode` 不会去读它（`trackStyle` 非空就整个走代码画）

   迁移必须保持 `assetId: ""` —— 一旦填了就会走图片分支，轨道就不再是代码画的。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("track-family.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("track-family.js 必须在 control-registry.js 之后加载");

  /** 28 条的参数表（逐字段照抄 presets.js:570-606） */
  const DEFS = [
    // ---- 基础
    { key: "cd_trackh", name: "代码轨道(水平)", orient: "h", w: 240, h: 16 },
    { key: "cd_trackv", name: "代码轨道(垂直)", orient: "v", w: 16,  h: 240 },
    // ---- 渐变：gloss = 沿短边明暗；fade = 沿长边淡出
    { key: "cd_trackgradh", name: "代码渐变轨道(水平)", orient: "h", gradient: "gloss", w: 240, h: 16 },
    { key: "cd_trackgradv", name: "代码渐变轨道(垂直)", orient: "v", gradient: "gloss", w: 16,  h: 240 },
    { key: "cd_trackfadeh", name: "代码淡出轨道(水平)", orient: "h", gradient: "fade",  w: 240, h: 16 },
    { key: "cd_trackfadev", name: "代码淡出轨道(垂直)", orient: "v", gradient: "fade",  w: 16,  h: 240 },
    // ---- 内凹
    { key: "cd_trackinseth", name: "代码内凹轨道(水平)", orient: "h", inset: true, w: 240, h: 16 },
    { key: "cd_trackinsetv", name: "代码内凹轨道(垂直)", orient: "v", inset: true, w: 16,  h: 240 },
    // ---- 发光
    { key: "cd_trackglowh", name: "代码发光轨道(水平)", orient: "h", glow: true, w: 240, h: 20 },
    { key: "cd_trackglowv", name: "代码发光轨道(垂直)", orient: "v", glow: true, w: 20,  h: 240 },
    // ---- 带刻度
    { key: "cd_trackticksh", name: "代码带刻度轨道(水平)", orient: "h", ticks: 10, w: 240, h: 24 },
    { key: "cd_trackticksv", name: "代码带刻度轨道(垂直)", orient: "v", ticks: 10, w: 24,  h: 240 },
    // ---- 分段
    { key: "cd_seg5h",  name: "代码 5 段条(水平)",  orient: "h", segments: 5,  w: 240, h: 20 },
    { key: "cd_seg5v",  name: "代码 5 段条(垂直)",  orient: "v", segments: 5,  w: 20,  h: 240 },
    { key: "cd_seg10h", name: "代码 10 段条(水平)", orient: "h", segments: 10, w: 240, h: 18 },
    { key: "cd_seg10v", name: "代码 10 段条(垂直)", orient: "v", segments: 10, w: 18,  h: 240 },
    { key: "cd_seg20h", name: "代码 20 段条(水平)", orient: "h", segments: 20, w: 240, h: 18 },
    { key: "cd_seg20v", name: "代码 20 段条(垂直)", orient: "v", segments: 20, w: 18,  h: 240 },
    // ---- 三段色带（静态阈值参考，与仪表 bands 不是一回事）
    { key: "cd_band3h", name: "代码三段色带(水平)", orient: "h", band: true, w: 240, h: 18 },
    { key: "cd_band3v", name: "代码三段色带(垂直)", orient: "v", band: true, w: 18,  h: 240 },
    // ---- 填充
    { key: "cd_fillh",     name: "代码填充条(水平)",     orient: "h", fill: 0.62, w: 240, h: 16 },
    { key: "cd_fillv",     name: "代码填充条(垂直)",     orient: "v", fill: 0.62, w: 16,  h: 240 },
    { key: "cd_fillglowh", name: "代码发光填充条(水平)", orient: "h", glow: true, fill: 0.62, w: 240, h: 18 },
    { key: "cd_fillglowv", name: "代码发光填充条(垂直)", orient: "v", glow: true, fill: 0.62, w: 18,  h: 240 },
    // ---- 阈值标记 / 游标（半径 2 的窄条当"那条线"用）
    { key: "cd_markerh", name: "代码阈值标记(水平)", orient: "h", fill: 1, radius: 2, w: 12, h: 32 },
    { key: "cd_markerv", name: "代码标记(垂直)",     orient: "v", fill: 1, radius: 2, w: 32, h: 12 },
    { key: "cd_cursorh", name: "代码发光游标(水平)", orient: "h", glow: true, fill: 1, radius: 2, w: 16, h: 40 },
    { key: "cd_cursorv", name: "代码游标(垂直)",     orient: "v", glow: true, fill: 1, radius: 2, w: 40, h: 16 },
  ];

  // 修正：markerv / cursorv 的旧 name 需要与源码逐字一致
  // （源码 L604：name: "代码阈值标记(垂直)"；L606：name: "代码发光游标(垂直)"）
  DEFS.forEach(function (d) {
    if (d.key === "cd_markerv") d.name = "代码阈值标记(垂直)";
    if (d.key === "cd_cursorv") d.name = "代码发光游标(垂直)";
  });

  /** 库显示名（`c.name`）与库图标（`c.icon`）—— 与旧实现一致 */
  const LIB_ICON = "▬";

  /**
   * **共享工厂**：把参数转成 trackStyle 并建节点。
   *
   * ⚠️ 逐字段照抄旧实现：
   *   radius: d.radius === undefined ? null : d.radius
   *   inset/gradient/glow/segments/ticks/band/fill 的缺省值一个都不能改
   *
   * ⚠️ `assetId: ""` 必须保留 —— 填了就走图片分支，不再是代码轨道。
   */
  function buildTrack(d, props) {
    const p = props || {};
    const ts = {
      orient: p.orient === undefined ? d.orient : p.orient,
      radius: p.radius === undefined ? (d.radius === undefined ? null : d.radius) : p.radius,
      inset: p.inset === undefined ? !!d.inset : !!p.inset,
      gradient: p.gradient === undefined ? (d.gradient || null) : p.gradient,
      glow: p.glow === undefined ? !!d.glow : !!p.glow,
      segments: p.segments === undefined ? (d.segments || 0) : p.segments,
      ticks: p.ticks === undefined ? (d.ticks || 0) : p.ticks,
      band: p.band === undefined ? !!d.band : !!p.band,
      fill: p.fill === undefined ? (d.fill === undefined ? null : d.fill) : p.fill,
    };

    const node = window.createNode(window.NODE_IMAGE, {
      name: p.name === undefined ? d.name : p.name,
      assetId: "",                       // ← 必须留空（走代码画）
      x: p.x === undefined ? 40 : p.x,
      y: p.y === undefined ? 40 : p.y,
      w: p.w === undefined ? d.w : p.w,
      h: p.h === undefined ? d.h : p.h,
      z: p.z === undefined ? 97 : p.z,   // ← 旧实现 z=97，不是 99
      trackStyle: ts,
    });
    node.__controlKey = d.key;
    return node;
  }

  /** 属性 Schema */
  function trackSchema() {
    return [
      { key: "trackStyle.orient", label: "方向", type: "enum", values: ["h", "v"], group: "轨道" },
      { key: "trackStyle.radius", label: "圆角", type: "number", group: "轨道", min: 0, max: 64 },
      { key: "trackStyle.inset", label: "内凹", type: "boolean", group: "轨道" },
      { key: "trackStyle.gradient", label: "渐变", type: "enum", values: [null, "gloss", "fade"], group: "轨道" },
      { key: "trackStyle.glow", label: "发光", type: "boolean", group: "轨道" },
      { key: "trackStyle.segments", label: "分段数", type: "number", group: "轨道", min: 0 },
      { key: "trackStyle.ticks", label: "刻度数", type: "number", group: "轨道", min: 0 },
      { key: "trackStyle.band", label: "三段色带", type: "boolean", group: "轨道" },
      { key: "trackStyle.fill", label: "填充比例", type: "number", group: "轨道", min: 0, max: 1 },
      { key: "w", label: "宽度", type: "number", group: "变换", min: 1 },
      { key: "h", label: "高度", type: "number", group: "变换", min: 1 },
    ];
  }

  /** 数据槽：轨道**不绑数据**（它是视觉元素，填充比例由用户设的 fill 决定） */
  function slotsOf() {
    return [];
  }

  /**
   * 轨道校验。
   *
   * ⚠️ **不校验"轨道是否绑了数据"** —— 旧行为是纯视觉元素，
   *    `fill` 是用户设的比例，不做动态绑定。加这条校验会让 28 条全部报错。
   *
   * ⚠️ **不校验 `assetId` 为空** —— 旧行为就是空（走代码画）。
   *    给它报错等于否认既有设计。
   */
  function trackValidate(node) {
    const issues = [];
    if (!node) return [{ level: "error", code: "no-node", message: "节点为空" }];

    const ts = node.trackStyle;
    if (!ts) {
      issues.push({
        level: "warn", code: "no-track-style",
        message: "没有 trackStyle，这条会按普通图片渲染（画 assetId 那张图）",
      });
      return issues;
    }

    if (ts.orient !== "h" && ts.orient !== "v") {
      issues.push({ level: "error", code: "bad-orient",
        message: "方向必须是 h 或 v（当前 " + ts.orient + "）" });
    }
    if (ts.segments !== undefined && ts.segments !== null && ts.segments < 0) {
      issues.push({ level: "error", code: "bad-segments", message: "分段数不能为负" });
    }
    if (ts.ticks !== undefined && ts.ticks !== null && ts.ticks < 0) {
      issues.push({ level: "error", code: "bad-ticks", message: "刻度数不能为负" });
    }
    if (ts.fill !== undefined && ts.fill !== null &&
        (ts.fill < 0 || ts.fill > 1)) {
      issues.push({ level: "warn", code: "fill-out-of-range",
        message: "填充比例应在 0~1（当前 " + ts.fill + "）" });
    }
    if (node.w <= 0 || node.h <= 0) {
      issues.push({ level: "warn", code: "zero-size", message: "轨道尺寸为 0，画布上不可见" });
    }
    return issues;
  }

  let registered = 0;
  let skipped = 0;

  DEFS.forEach(function (d) {
    if (Reg.has(d.key)) { skipped++; return; }

    Reg.define({
      key: d.key,
      legacyKey: d.key,
      name: d.name,
      category: "轨道",
      icon: LIB_ICON,
      priority: 50,

      defaults: { orient: d.orient, w: d.w, h: d.h, x: 40, y: 40, z: 97 },

      build(props) {
        return buildTrack(d, props);
      },

      schema: trackSchema(),
      slots: slotsOf(),
      render: { mode: "track", adapter: "drawTrackNode" },
      validate: trackValidate,
    });
    registered++;
  });

  ICAR.registry.trackFamily = { registered: registered, skipped: skipped, total: DEFS.length };
})();
