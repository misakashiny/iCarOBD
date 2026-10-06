/* ==========================================================================
   schema.js —— 与 App 侧同源的常量
   --------------------------------------------------------------------------
   ⚠️ 这个文件里的每一条都必须和 app/src/main/java/com/icar/obd/ 下的定义对得上。
   对不上的后果是「编辑器说没问题、App 加载报错」—— 这正是本工具最该避免的事。

   核对来源：
     SCHEMA / CANVAS / MAX_* / PID_ALIASES / FIT_* / SCALE_*  ← data/DesignFile.kt
     内置 PID 量程                                            ← data/BuiltInPids.kt
     样式编号 / CARD_* / 节点类型                              ← data/PidModels.kt
     吸附步长 / 最小尺寸                                       ← data/DashLayout.kt Drag
     霓虹档位                                                 ← ui/view/NeonStyle.kt PRESETS
     状态名                                                   ← ui/view/AlertPulse.kt

   由 tools/verify-studio.js 逐条比对（跨语言），改这里必须同时改 Kotlin 侧。
   ========================================================================== */
"use strict";

window.SCHEMA_V1 = "icar.ui/1";
window.SCHEMA_V2 = "icar.ui/2";
window.SCHEMA = window.SCHEMA_V2;      // 本工具现在产出的版本

window.CANVAS = 360;

/** 一屏最多几个节点。v1 是 32 个仪表；树模型下放宽到 200（含图片/分组/文字） */
window.MAX_NODES = 200;
/** v1 的仪表上限，导出 v1 时用 */
window.MAX_GAUGES = 32;

/** 与 DashLayout.Drag 一致：GRID=24 → STEP=15，MIN_SIZE=30 */
window.GRID = 24;
window.STEP = window.CANVAS / window.GRID;   // 15
window.MIN_SIZE = 2 * window.STEP;           // 30

/** 节点类型。下标即语义，不要重排 */
window.NODE_GROUP = "group";
window.NODE_IMAGE = "image";
window.NODE_GAUGE = "gauge";
window.NODE_TEXT = "text";
window.NODE_TYPES = [
  { v: window.NODE_GAUGE, n: "仪表", icon: "◉" },
  { v: window.NODE_IMAGE, n: "图片", icon: "▣" },
  { v: window.NODE_TEXT, n: "文字", icon: "T" },
  { v: window.NODE_GROUP, n: "分组", icon: "▤" },
];

/** 仪表样式（与 PidModels.GaugeItem.STYLE_* 一致） */
window.STYLES = [
  { v: 0, n: "圆表" },
  { v: 1, n: "数字" },
  { v: 2, n: "条形" },
  { v: 3, n: "线型图" },
  { v: 4, n: "双数据上下" },
  { v: 5, n: "四数据" },
  { v: 6, n: "主子双数据" },
  { v: 7, n: "G力值" },
];

/** 霓虹档位（与 NeonStyle.PRESETS 一致，**名字是冻结契约**） */
window.NEON_PRESETS = ["关闭", "克制", "标准", "强烈", "夸张"];

/**
 * **仪表的子部件**（v2.12.0）。
 *
 * 一个仪表不再只能"选一种画法"，而是可以拆成几个**可替换的部件**：
 *
 *   dial   表盘   —— 底盘/圆环（通常是图片素材）
 *   ticks  刻度   —— 刻度环
 *   needle 指针   —— 会随数值转动的部件
 *   value  数值   —— 数字读数（用文字渲染，不是图片）
 *   decor  装饰   —— 任意叠加的图片
 *
 * 部件的绘制顺序 = **数组顺序**（先画的在下）。这与"图层"的直觉一致。
 */
window.PART_KINDS = [
  { v: "dial", n: "表盘", icon: "◯" },
  { v: "ticks", n: "刻度", icon: "⋮" },
  { v: "needle", n: "指针", icon: "➤" },
  { v: "value", n: "数值", icon: "7" },
  { v: "decor", n: "装饰", icon: "✦" },
];

/** 指针部件的默认扫描范围（度，0 = 正右，顺时针）。与经典表盘一致 */
window.PART_DEFAULT_SWEEP = { from: 135, to: 405 };

/** 一个部件的默认值。**缺字段回落这里**，两端必须一致 */
window.PART_DEFAULT = {
  kind: "decor",
  /**
   * **指针绑的 PID**（v2.17.0，多指针表用）。
   *
   * 空 = 用仪表节点自己的 `pid`（单指针表的老行为，完全不变）。
   * 设了就用它 —— 于是"转速 + 车速"这种双针表，两个 needle 各绑一个 PID。
   *
   * 量程也跟着走：绑了别的 PID 就用**那个 PID 的 min/max**，
   * 而不是仪表节点的 —— 否则车速（0~240）按转速（0~8000）的角度映射，指针几乎不动。
   */
  pid: "",
  rawPid: "",
  /**
   * **子部件**（v2.18.0）。
   *
   * 有子部件的部件相当于一个「组」：子部件的 x/y **相对父部件**，
   * 并**继承父的旋转**。于是可以做「指针上再挂个装饰/配重」。
   *
   * 空数组 = 没有子部件（老行为，完全不变）。
   */
  children: [],
  /**
   * **扫描范围跟随仪表**（v2.27.0）。
   *
   * 双针表的两个指针通常共用同一个 135°→405°。开着的话不用手填两遍，
   * 改仪表的 sweep 两个针一起变。
   *
   * 默认 false —— 老行为完全不变（各自独立）。
   */
  sweepFollow: false,
  assetId: "",
  x: 0, y: 0, w: 120, h: 120,
  alpha: 255,
  rotation: 0,
  pivotX: 0.5, pivotY: 0.5,
  sweepFrom: 135, sweepTo: 405,
};

/** 规范化一个部件：补默认 + 夹住非法值。**解析与新建都走它** */
window.normalizePart = function (o, depth) {
  const p = Object.assign({}, window.PART_DEFAULT, o || {});
  if (!window.PART_KINDS.some(k => k.v === p.kind)) p.kind = "decor";
  p.assetId = String(p.assetId || "");
  // pid 内部存**解析后的 id**，rawPid 存用户写的别名（回显用）——
  // 与节点上的 pid/rawPid 是同一套约定
  // ⚠️ **只有指针**才解析 pid —— 表盘/刻度/装饰绑 PID 没有意义，
  // 而且会污染序列化（每个部件都多两个空字段）。实测被测试抓到过。
  // v2.27.0：**value 也能绑 PID** —— 双针表配两个数字读数是很自然的用法。
  // 表盘/刻度/装饰绑 PID 仍然没有意义。
  const canBind = (p.kind === "needle" || p.kind === "value");
  const rawPid = canBind ? String(p.rawPid || p.pid || "") : "";
  p.rawPid = rawPid;
  p.pid = rawPid ? window.resolvePid(rawPid) : "";
  p.x = Number(p.x) || 0;
  p.y = Number(p.y) || 0;
  p.w = Math.max(1, Number(p.w) || window.PART_DEFAULT.w);
  p.h = Math.max(1, Number(p.h) || window.PART_DEFAULT.h);
  p.alpha = Math.max(0, Math.min(255, Math.round(Number(p.alpha) === undefined ? 255 : Number(p.alpha))));
  p.rotation = Number(p.rotation) || 0;
  // pivot 是**相对自身**的 0..1，允许超出一点（有些指针的轴心在外）
  p.pivotX = Math.max(-1, Math.min(2, Number(p.pivotX) === undefined ? 0.5 : Number(p.pivotX)));
  p.pivotY = Math.max(-1, Math.min(2, Number(p.pivotY) === undefined ? 0.5 : Number(p.pivotY)));
  p.sweepFrom = Number(p.sweepFrom) === undefined ? 135 : Number(p.sweepFrom);
  p.sweepTo = Number(p.sweepTo) === undefined ? 405 : Number(p.sweepTo);
  if (!Number.isFinite(p.sweepFrom)) p.sweepFrom = 135;
  // ⚠️ **递归规范化子部件** —— 不递归的话嵌套层的字段不会被夹住，
  // 一个坏值能一路穿到绘制层。
  //
  // 深度上限 5：正常不会超过 2~3 层；设上限是防"手改文件成环"爆栈。
  //
  // ⚠️ 用**局部变量**存深度，不要在 map 回调里用 arguments ——
  // 那指向回调自己的参数，不是 normalizePart 的（第一版就是这么错的）。
  const d = Number(depth) || 0;
  p.children = (d >= 5) ? [] : (Array.isArray(p.children) ? p.children : [])
    .slice(0, 64)
    .map(function (c) { return window.normalizePart(c, d + 1); })
    .filter(Boolean);
  if (!Number.isFinite(p.sweepTo)) p.sweepTo = 405;
  return p;
};

/**
 * 一个部件该用哪个**值**与哪套**量程**。
 *
 * 绑了 pid 就用那个 PID 的值与量程；没绑就回落到仪表节点自己的。
 * 抽成函数是因为工具与 App 两端都要同一套判定 —— 各写一份迟早分叉。
 */
/**
 * 一个部件该用哪段**扫描范围**（v2.27.0）。
 *
 * `sweepFollow` 开着就用**仪表节点的** —— 双针表两个针共用同一个 135°→405°，
 * 不用手填两遍。关着就用部件自己的（老行为）。
 *
 * ⚠️ 与 [partValueRange] 分开：量程是"值→角度"的输入，扫描范围是"角度→画面"的输入。
 * 两者互不影响（绑了别的 PID 但想共用同一段弧，是完全合理的组合）。
 */
/**
 * 一个部件该用哪段**扫描范围**（v2.27.0）。
 *
 * `sweepFollow` 开着就跟着**第一个指针**走 —— 双针表的实际用法就是
 * "两根针共用一段弧"，改领头针两个一起变，不用手填两遍。
 *
 * 为什么不是"跟随仪表节点"：见 App 侧同样位置的注释（那本 View 拿不到节点，
 * 而且"跟随领头针"本来就更能表达用户的意图）。
 */
window.partSweep = function (part, allParts) {
  const p = window.normalizePart(part);
  if (p.sweepFollow && Array.isArray(allParts)) {
    const lead = allParts.map(window.normalizePart)
      .find(function (q) { return q.kind === "needle"; });
    if (lead) return [lead.sweepFrom, lead.sweepTo];
  }
  return [p.sweepFrom, p.sweepTo];
};

window.partValueRange = function (part, gauge, values) {
  const p = window.normalizePart(part);
  const v = values || {};
  if (p.pid) {
    const info = window.BUILTIN_PIDS[p.pid];
    const min = info ? info.min : 0;
    const max = info ? info.max : 100;
    const raw = v[p.pid];
    return { value: (raw === null || raw === undefined) ? min : raw, min: min, max: max };
  }
  const raw = gauge && gauge.pid ? v[gauge.pid] : null;
  const gmin = gauge ? gauge.min : 0;
  const gmax = gauge ? gauge.max : 100;
  return { value: (raw === null || raw === undefined) ? gmin : raw, min: gmin, max: gmax };
};

/** 指针在给定值下的角度 */
window.partAngle = function (part, value, min, max) {
  const p = window.normalizePart(part);
  const span = max - min;
  const t = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0;
  return p.rotation + p.sweepFrom + (p.sweepTo - p.sweepFrom) * t;
};

/** 卡片外框覆盖（与 PidModels.CARD_* 一致） */
window.CARD_NAMES = ["跟随主题", "无边框", "完全透明卡片", "不画卡片"];

/**
 * **底框的细粒度覆盖**（v2.6.0）。
 *
 * `cardStyle` 是 4 个粗档位（跟随主题/无边框/透明/不画），
 * 但它没法表达"半透明 + 大圆角"这种需求。所以再加一个对象：
 *
 * ```json
 * "card": { "show": true, "alpha": 190, "radius": 12 }
 * ```
 *
 * - `show`   false = 不画底框（等价于 cardStyle=3）
 * - `alpha`  0..255，null = 跟随主题
 * - `radius` 圆角半径，**画布单位**（不是像素），null = 跟随主题
 *
 * **优先级**：`card` 存在就压过 `cardStyle` 的对应项；缺的字段仍跟随主题。
 */
window.CARD_DEFAULT = { show: true, alpha: null, radius: null };

/** 解析一个节点的底框配置：card 覆盖 cardStyle，cardStyle 覆盖主题 */
window.resolveCard = function (n) {
  const style = (n.cardStyle === null || n.cardStyle === undefined) ? 0 : n.cardStyle;
  const c = Object.assign({}, window.CARD_DEFAULT, n.card || {});
  // cardStyle 的粗档位先落地
  let show = true;
  if (style === 2 || style === 3) show = false;   // 完全透明 / 不画卡片 → 不画底
  // card.show 再压一层（显式写了就听它的）
  if (n.card && typeof n.card.show === "boolean") show = n.card.show;
  return {
    show: show,
    alpha: (c.alpha === null || c.alpha === undefined) ? null : Math.max(0, Math.min(255, Math.round(c.alpha))),
    radius: (c.radius === null || c.radius === undefined) ? null : Math.max(0, Math.min(120, Number(c.radius) || 0)),
    style: style,
  };
};

/** 背景铺法（与 DesignFile.FIT_* 一致，**数量与顺序都不能错**） */
window.FIT_FILL = 0;
window.FIT_FIT = 1;
window.FIT_CENTER = 2;
window.FIT_TILE = 3;
window.FIT_NAMES = ["铺满（裁切）", "完整显示（可能留边）", "居中原始大小", "平铺"];

/**
 * 画布缩放模式（与 DesignFile.SCALE_* 一致）。
 *
 * ⚠️ **默认必须是 stretch** —— 那是 v1 的行为（每轴独立归一化）。
 * 改成 fit 会让存量设计的观感变化（留黑边），用户会以为是 bug。
 */
window.SCALE_STRETCH = 0;
window.SCALE_FIT = 1;
window.SCALE_FILL = 2;
window.SCALE_MODES = [
  { v: 0, n: "拉伸（每轴独立，v1 行为）", d: "自动铺满，但宽高比变了会变形" },
  { v: 1, n: "等比适应（留黑边）", d: "不变形；宽高比不同时短边留边" },
  { v: 2, n: "等比铺满（裁切）", d: "不变形；超出部分裁掉，适合背景图" },
];

/**
 * 字体族（与 App 侧 GaugeFont.FAMILIES 一致，**名字与顺序都不能错**）。
 *
 * 为什么用有限的枚举而不是任意字体名：
 *  1. PC 与 Android 的字体生态完全不同，写 `"Microsoft YaHei"` 到设备上必然没有
 *  2. 枚举能保证"电脑上选的"与"设备上渲染的"是同一种观感
 *  3. 跨语言比对脚本可以逐条核对
 *
 * 对应的 Android Typeface：
 *   sans      → Typeface.SANS_SERIF
 *   serif     → Typeface.SERIF
 *   mono      → Typeface.MONOSPACE
 *   condensed → Typeface.create("sans-serif-condensed", ...)
 */
window.FONT_FAMILIES = [
  { v: "sans", n: "无衬线（默认）", css: "'Segoe UI','Microsoft YaHei',sans-serif", android: "sans-serif" },
  { v: "serif", n: "衬线", css: "Georgia,'Times New Roman',serif", android: "serif" },
  { v: "mono", n: "等宽（数字对齐）", css: "Consolas,'Cascadia Mono',monospace", android: "monospace" },
  { v: "condensed", n: "窄体", css: "'Segoe UI',sans-serif", android: "sans-serif-condensed" },
];

/** 字重。数值与 CSS font-weight 一致，App 侧映射到 Typeface.BOLD / NORMAL */
window.FONT_WEIGHTS = [
  { v: 400, n: "常规" },
  { v: 500, n: "中等" },
  { v: 700, n: "加粗" },
  { v: 900, n: "特粗" },
];

/** 水平对齐 */
window.FONT_ALIGNS = [
  { v: "left", n: "左对齐", canvas: "left", android: "LEFT" },
  { v: "center", n: "居中", canvas: "center", android: "CENTER" },
  { v: "right", n: "右对齐", canvas: "right", android: "RIGHT" },
];

/** 字体对象的默认值。缺字段时的回落，**两端必须一致** */
window.FONT_DEFAULT = {
  family: "sans",
  // ⚠️ 默认字号是 **6**（画布单位），不是 16。
  // 16 是"像素思维"的产物 —— 而画布只有 360 单位宽，
  // 一个 16 单位的字在 180 单位的表上占 8.9%，满屏都是字，看着头疼。
  // 6 单位 ≈ 表高的 3.3%，是"能看清但不抢戏"的量级。
  size: 6,
  weight: 400,
  italic: false,
  letterSpacing: 0,
  align: "left",
  color: "#E8EEF7",
};

/** 按 family 取 CSS font-family 串 */
window.fontCss = function (fam) {
  const f = window.FONT_FAMILIES.find(x => x.v === fam);
  return (f || window.FONT_FAMILIES[0]).css;
};

/** 拼出 canvas 的 font 简写（"italic 700 16px ..."） */
window.fontShort = function (f, sizeOverride) {
  const o = Object.assign({}, window.FONT_DEFAULT, f || {});
  const size = sizeOverride !== undefined ? sizeOverride : o.size;
  const bold = (o.weight || 400) >= 700;
  return (o.italic ? "italic " : "") + (bold ? "bold " : "") +
    Math.max(1, size) + "px " + window.fontCss(o.family);
};

/** 规范化一个字体对象：补齐缺省 + 夹住非法值。**解析与新建都走它** */
window.normalizeFont = function (f) {
  const o = Object.assign({}, window.FONT_DEFAULT, f || {});
  if (!window.FONT_FAMILIES.some(x => x.v === o.family)) o.family = window.FONT_DEFAULT.family;
  if (!window.FONT_ALIGNS.some(x => x.v === o.align)) o.align = window.FONT_DEFAULT.align;
  // ⚠️ 非法字号（≤0 / NaN）**回落到默认值**，而不是夹到 1 ——
  // 夹到 1 的结果是"字看不见"，用户会以为控件丢了；回落 16 至少看得见、能改回来
  const sz = Number(o.size);
  o.size = (Number.isFinite(sz) && sz > 0) ? sz : window.FONT_DEFAULT.size;
  o.weight = [100, 200, 300, 400, 500, 600, 700, 800, 900].indexOf(Number(o.weight)) >= 0
    ? Number(o.weight) : window.FONT_DEFAULT.weight;
  o.italic = !!o.italic;
  o.letterSpacing = Math.max(-10, Math.min(50, Number(o.letterSpacing) || 0));
  if (typeof o.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(o.color)) o.color = window.FONT_DEFAULT.color;
  return o;
};

/**
 * **三个内置仪表主题的配色**（与 ui/view/GaugeTheme.kt 的 `builtins` 一致）。
 *
 * ## 为什么工具要知道颜色
 *
 * 设计文件原来只存主题**名字**（`"theme": "neon"`）—— 换台机器 / 用户删了自建主题，
 * 配色就丢了。P8-5 要求把配色**内嵌进设计文件**，所以工具必须知道它们。
 *
 * ## 字段名与 GaugeTheme.toJson 逐字一致
 *
 * 这样 App 侧可以直接 `GaugeTheme.fromJson(design.themeColors)`，
 * 不需要任何映射表。
 *
 * ⚠️ **这是跨语言契约** —— `verify-crosslang.js` 会逐条核对，
 * 改了这里不改 Kotlin（或反过来）会立刻报错。
 */
window.GAUGE_THEMES = {
  neon: {
    title: "霓虹赛道", description: "橙黄辉光，强调转速与性能感",
    background: "#080A0E", surface: "#17110D", surfaceEdge: "#553520",
    accent: "#FF8A00", accentHot: "#FFE45C", accentDim: "#5B2B00",
    track: "#322820", tick: "#725635", needle: "#FFB000",
    value: "#FFF4DF", label: "#D8BFA0", dim: "#806B57",
    glow: true,
  },
  ice: {
    title: "冰川科技", description: "冷青色 HUD，适合日常驾驶",
    background: "#071018", surface: "#0C1B28", surfaceEdge: "#1B4C62",
    accent: "#28D7FF", accentHot: "#B8F5FF", accentDim: "#123D52",
    track: "#173343", tick: "#4C8195", needle: "#63E5FF",
    value: "#E7FAFF", label: "#9DC7D6", dim: "#5E8493",
    glow: false,
  },
  amber: {
    title: "经典琥珀", description: "低干扰琥珀字，夜间更克制",
    background: "#0B0B09", surface: "#181714", surfaceEdge: "#4A4530",
    accent: "#E3A83B", accentHot: "#FFD57A", accentDim: "#4C3612",
    track: "#302D23", tick: "#766B4D", needle: "#E8B84F",
    value: "#FFF6DB", label: "#D5C8A3", dim: "#847B61",
    glow: false,
  },
}
/**
 * **设计当前生效的主题配色**（v2.49.0）。
 *
 * 之前只有 `model.js` 在**序列化**时拼这个（写进设计文件的 `themeColors`），
 * 而**画布从来不读它** —— 所以切主题时画布上的控件**完全没有变化**，
 * 用户看到的还是工具自己那套 UI 配色。
 *
 * 规则与 `model.js` 的序列化**完全一致**：内置打底 + 用户覆盖。
 * 两处必须同源，否则"画布上看到的"和"导出后 App 看到的"会不一样。
 */
window.currentTheme = function () {
  const S = window.CanvasState || {};
  const d = S.design || {};
  const base = window.GAUGE_THEMES[d.themeId] || window.GAUGE_THEMES.neon;
  return Object.assign({}, base, d.themeColorsOverride || {});
};;

/** 主题别名列表（与 GaugeTheme.aliasOf 一致） */
window.THEME_ALIASES = ["neon", "ice", "amber"];

/**
 * **主题里哪些字段可以在工具里改**（v2.31.0）。
 *
 * 只列颜色 —— 浮点/布尔那些（圆角、缓动 τ、发光开关）影响的是"手感"，
 * 不是"配色"，混在一起做一个界面会让它变成一锅粥。
 *
 * `n` 是中文标签（UI 上用），顺序 = 编辑器的显示顺序。
 */
window.THEME_COLOR_FIELDS = [
  { k: "background", n: "背景" },
  { k: "surface",    n: "卡片底" },
  { k: "surfaceEdge",n: "卡片边" },
  { k: "accent",     n: "主色" },
  { k: "accentHot",  n: "高亮色" },
  { k: "accentDim",  n: "暗主色" },
  { k: "track",      n: "轨道" },
  { k: "tick",       n: "刻度" },
  { k: "needle",     n: "指针" },
  { k: "value",      n: "数值" },
  { k: "label",      n: "标签" },
  { k: "dim",        n: "次要文字" },
];

/** 状态名（与 AlertPulse.NONE/WARN/CRITICAL/WARN_LOW 对应） */
window.STATE_NORMAL = "normal";
window.STATE_WARN = "warn";
window.STATE_CRITICAL = "critical";
window.STATE_NAMES = [
  { v: window.STATE_NORMAL, n: "正常" },
  { v: window.STATE_WARN, n: "警告" },
  { v: window.STATE_CRITICAL, n: "严重" },
];

/**
 * 素材分类。**只是标签**，不预置任何图片 —— 车标等素材版权不属于本项目，
 * 用户自己导入（见 docs/主题设计大纲.md §3.2）。
 */
/**
 * **内置的 10 个素材分类**（出厂顺序）。
 *
 * ⚠️ 这是**常量**，不要直接拿它渲染 —— 用户能排序、能加新分类，
 * 所以渲染一律走 [assetKindList]。
 *
 * 保留这个名字是因为它是"出厂值"，`resetPanelLayout` 之类的重置操作用得到。
 */
window.DEFAULT_ASSET_KINDS = [
  { v: "background", n: "背景", icon: "📁" },
  { v: "dashboard", n: "仪表盘", icon: "📁" },
  { v: "needle", n: "指针", icon: "📁" },
  { v: "scale", n: "刻度", icon: "📁" },
  { v: "icon", n: "图标", icon: "📁" },
  { v: "turn", n: "转向灯", icon: "📁" },
  { v: "warning", n: "警告灯", icon: "📁" },
  { v: "brand", n: "汽车品牌", icon: "📁" },
  { v: "decor", n: "装饰", icon: "📁" },
  // v2.20.0 新增两类：条形表的轨道/填充、面板卡片边框。
  // 放在 custom 之前 —— "自定义"永远是最后一类（用户的收纳筐）。
  { v: "bar", n: "条形轨道", icon: "📊" },
  { v: "frame", n: "面板边框", icon: "🖼" },
  { v: "custom", n: "自定义", icon: "📁" },
];
/**
 * 用户的分类配置：**顺序** + **自定义分类**。
 *
 * 持久化在 localStorage（与面板高度同一套做法）。
 * 内置分类被删掉时只是"不显示"，不丢素材 —— 素材按 kind 分组，
 * 分类没了它们会落到「未分类」里（见 assetKindOf）。
 */
window.assetKindOrder = window.DEFAULT_ASSET_KINDS.map(function (k) { return k.v; });
window.customAssetKinds = [];

/**
 * **显示名覆盖**（v2.29.0）：`{ "background": "我的背景" }`。
 *
 * 为什么单独一张表，而不是直接改 `DEFAULT_ASSET_KINDS[i].n`：
 *   · `v`（标识）是**设计文件里的契约**，绝不能跟着显示名变 ——
 *     老设计文件写的是 `"kind":"background"`，改了 v 素材就落到"未分类"了
 *   · 内置分类的 `n` 是出厂值，改了就分不清"用户改过没有"
 *   · 恢复出厂名 = 清空这张表，一行搞定
 */
window.assetKindNames = {};

/**
 * **有效的分类列表**（渲染一律用这个，不要用 DEFAULT_ASSET_KINDS）。
 *
 * 组成 = 用户顺序里仍存在的内置分类 + 用户新建的分类。
 */
window.assetKindList = function () {
  const byV = {};
  window.DEFAULT_ASSET_KINDS.forEach(function (k) { byV[k.v] = k; });
  window.customAssetKinds.forEach(function (k) { byV[k.v] = k; });
  const out = [];
  window.assetKindOrder.forEach(function (v) { if (byV[v]) out.push(byV[v]); });
  // 兜底：出厂有、但用户的顺序表里漏掉的（比如旧版本升上来）
  window.DEFAULT_ASSET_KINDS.forEach(function (k) {
    if (out.indexOf(k) < 0 && window.assetKindOrder.indexOf(k.v) < 0) out.push(k);
  });
  return out;
};

/** 分类名（找不到时原样返回 v —— 宁可显示个丑名字，也不要显示 undefined） */
window.assetKindName = function (v) {
  // 显示名覆盖优先（v2.29.0）—— 用户改过名字就用改过的
  if (window.assetKindNames[v]) return window.assetKindNames[v];
  const k = window.assetKindList().find(function (x) { return x.v === v; });
  return k ? k.n : (v || "未分类");
};

/** 这个分类是不是用户新建的（决定能不能删） */
window.isCustomAssetKind = function (v) {
  return window.customAssetKinds.some(function (k) { return k.v === v; });
};


/** 与 DesignFile.PID_ALIASES 完全一致（37 条：25 标准 + 9 派生 + 1 控件-facing + 2 监听） */
window.PID_ALIASES = {
  // ---- 标准 OBD（std_*）：全部 20 条 ----
  "obd.rpm": "std_0C",
  "obd.speed": "std_0D",
  "obd.coolant": "std_05",
  "obd.load": "std_04",
  "obd.intake": "std_0F",
  "obd.maf": "std_10",
  "obd.stft": "std_06",
  "obd.ltft": "std_07",
  "obd.fuel_rate": "std_5E",
  "obd.map": "std_0B",
  "obd.fuel_level": "std_2F",
  "obd.ambient": "std_46",
  "obd.oil_temp": "std_5C",
  "obd.baro": "std_33",
  "obd.timing_advance": "std_0E",
  "obd.throttle": "std_11",
  "obd.pedal_d": "std_49",
  "obd.run_time": "std_1F",
  "obd.mil_distance": "std_21",
  "obd.voltage": "std_42",
  // 故障灯（MIL）—— **标准 PID 01**，不需要扫描器实测。控件 lamp_engine 绑的就是它
  "obd.engineFault": "std_01",
  // 总里程 —— **标准 PID A6**（J1979-2 的 A1~C0 段）。控件 g_odo 绑的就是它
  "obd.odo": "std_A6",
  // ---- 派生（calc_*）：全部 7 条 ----
  "calc.l100": "calc_l100",
  "calc.fuel_hourly": "calc_lh",
  "calc.boost": "calc_boost",
  "calc.trip": "calc_km",
  "calc.gforce": "calc_gforce",
  "calc.gx": "calc_gx",
  "calc.gy": "calc_gy",
  // 平均油耗（累计用油 ÷ 累计里程）—— 纯本项目的派生，不用等车
  "calc.avg_l100": "calc_avg_l100",
  // 续航里程 —— 需要「油箱容量」设置，但同样不用等车
  "calc.range": "calc_range",
  // ---- 控件-facing 的别名（v2.62.0）
  //
  // ⚠️ **为什么同一个 PID 有两个名字**：
  // 控件模板里写的是这一套（`obd.gforce`），而上面的规范名是另一套（`calc.gforce`）。
  // 实测 40 个绑 PID 的控件里 **28 个绑的是不存在的名字** ——
  // 而 `make()` 查不到就用 0~100 兜底，**静默退化成普通数字表**。
  //
  // 修法：**把控件用的名字也加成别名**，指向同一个 PID。
  // 不删旧名（存量设计文件里用的是旧名）。
  //
  // ⚠️ 必须与 app/.../data/DesignFile.kt 的 `val PID_ALIASES` **逐条一致**，
  // verify-crosslang.js 会比对。
  // 燃油压力（第 ⑨ 项新增）
  "obd.fuelPressure": "std_0A",
  // 燃油轨压力（第 ⑨ 项新增）
  "obd.railPressure": "std_22",
  // 氧传感器电压（第 ⑨ 项新增）
  "obd.o2voltage": "std_14",
  // ---- 监听型（mon_*）：2026-10-06 实车确认 ----
  // CAN 0x09A 第 3 字节 bit2 = 左转、bit3 = 右转
  "can.turn_left": "mon_turn_left",
  "can.turn_right": "mon_turn_right",};

/** 内置 PID 库（id → 名称/单位/量程/报警阈值/分组）。抄自 data/BuiltInPids.kt */
window.BUILTIN_PIDS = {
  "std_0C": { name: "发动机转速", unit: "rpm", min: 0, max: 8000, warnHigh: 6500, g: "标准 OBD" },
  "std_0D": { name: "车速", unit: "km/h", min: 0, max: 260, warnHigh: 120, g: "标准 OBD" },
  "std_05": { name: "冷却液温度", unit: "℃", min: -40, max: 215, warnLow: 60, warnHigh: 105, g: "标准 OBD" },
  "std_42": { name: "控制模块电压", unit: "V", min: 0, max: 20, warnLow: 11.8, warnHigh: 15.2, g: "标准 OBD" },
  "std_04": { name: "发动机负荷", unit: "%", min: 0, max: 100, g: "标准 OBD" },
  "std_11": { name: "节气门开度", unit: "%", min: 0, max: 100, g: "标准 OBD" },
  "std_0F": { name: "进气温度", unit: "℃", min: -40, max: 215, warnHigh: 70, g: "标准 OBD" },
  "std_10": { name: "空气流量 MAF", unit: "g/s", min: 0, max: 655, g: "标准 OBD" },
  "std_06": { name: "短期燃油修正 STFT", unit: "%", min: -100, max: 100, warnLow: -15, warnHigh: 15, g: "标准 OBD" },
  "std_07": { name: "长期燃油修正 LTFT", unit: "%", min: -100, max: 100, warnLow: -15, warnHigh: 15, g: "标准 OBD" },
  "std_5E": { name: "燃油消耗率", unit: "L/h", min: 0, max: 100, g: "标准 OBD" },
  // 燃油泵供油压力
  "std_0A": { name: "燃油压力", unit: "kPa", min: 0, max: 765, g: "标准 OBD" },
  // 相对进气歧管的轨压
  "std_22": { name: "燃油轨压力", unit: "kPa", min: 0, max: 5178, g: "标准 OBD" },
  // B1S1；在 0.1~0.9V 之间来回跳是正常的
  "std_14": { name: "氧传感器电压", unit: "V", min: 0, max: 1.275, warnLow: 0.1, warnHigh: 0.9, g: "标准 OBD" },
  "std_0B": { name: "进气歧管压力 MAP", unit: "kPa", min: 0, max: 255, g: "标准 OBD" },
  "std_2F": { name: "燃油液位", unit: "%", min: 0, max: 100, warnLow: 15, g: "标准 OBD" },
  "std_46": { name: "环境温度", unit: "℃", min: -40, max: 215, g: "标准 OBD" },
  "std_5C": { name: "机油温度", unit: "℃", min: -40, max: 215, warnHigh: 130, g: "标准 OBD" },
  "std_33": { name: "大气压力", unit: "kPa", min: 0, max: 255, g: "标准 OBD" },
  "std_0E": { name: "点火提前角", unit: "°", min: -64, max: 63, g: "标准 OBD" },
  "std_49": { name: "油门踏板位置 D", unit: "%", min: 0, max: 100, g: "标准 OBD" },
  "std_1F": { name: "启动后运行时间", unit: "s", min: 0, max: 65535, g: "标准 OBD" },
  "std_21": { name: "故障灯后里程", unit: "km", min: 0, max: 65535, g: "标准 OBD" },
  // 故障灯 MIL：**布尔**。0=正常 1=故障灯亮；warnHigh=0.5 让值 1 直接走成 critical，
  // 指示灯的既有三态图就能用（**不需要 valueLabels**，见 docs/主题设计大纲.md §2.110）
  "std_01": { name: "故障灯状态 MIL", unit: "", min: 0, max: 1, warnHigh: 0.5, g: "标准 OBD" },
  // 总里程：**标准 PID A6**（J1979-2 的 A1~C0 段），不是厂家地址。
  // 公式来自独立验证过的马自达项目（与真实里程表核对过）
  "std_A6": { name: "总里程", unit: "km", min: 0, max: 999999, g: "标准 OBD" },
  "calc_l100": { name: "瞬时油耗", unit: "L/100km", min: 0, max: 40, warnHigh: 15, g: "派生（算出来的）" },
  "calc_lh": { name: "燃油流量", unit: "L/h", min: 0, max: 60, g: "派生（算出来的）" },
  "calc_boost": { name: "增压压力", unit: "kPa", min: -100, max: 300, g: "派生（算出来的）" },
  "calc_km": { name: "本次里程", unit: "km", min: 0, max: 9999, g: "派生（算出来的）" },
  "calc_avg_l100": { name: "平均油耗", unit: "L/100km", min: 0, max: 40, warnHigh: 15, g: "派生（算出来的）" },
  "calc_range": { name: "续航里程", unit: "km", min: 0, max: 1200, g: "派生（算出来的）" },
  "calc_gforce": { name: "综合G值", unit: "G", min: 0, max: 2, g: "派生（算出来的）" },
  "calc_gx": { name: "横向G值", unit: "G", min: -2, max: 2, g: "派生（算出来的）" },
  "calc_gy": { name: "纵向G值", unit: "G", min: -2, max: 2, g: "派生（算出来的）" },
  // ---- 厂家模板（默认关闭，**刻意不给别名**：PID 号是猜的，必须先用扫描器实测）----
  "tpl_oilPressure": { name: "示例-机油压力", unit: "Bar", min: 0, max: 10, warnLow: 0.8, g: "厂家模板（未验证）" },
  "tpl_afr": { name: "示例-空燃比 AFR", unit: ":1", min: 10, max: 20, warnLow: 11, g: "厂家模板（未验证）" },
  "tpl_atf": { name: "示例-变速箱油温 ATF", unit: "℃", min: -40, max: 180, warnHigh: 120, g: "厂家模板（未验证）" },
  // 实车确认：CAN 0x09A 第 3 字节 bit2。需开启常驻监听才更新
  "mon_turn_left": { name: "左转向灯", unit: "", min: 0, max: 1, g: "监听型（实车确认）" },
  // 同上，bit3
  "mon_turn_right": { name: "右转向灯", unit: "", min: 0, max: 1, g: "监听型（实车确认）" },
  "tpl_steer_angle": { name: "示例-方向盘转角", unit: "°", min: -720, max: 720, g: "厂家模板（未验证）" },
};

/** 别名反查：PID id → 首选语义名（显示用） */
window.ALIAS_OF = {};
for (const [alias, id] of Object.entries(window.PID_ALIASES)) {
  if (!(id in window.ALIAS_OF)) window.ALIAS_OF[id] = alias;
}

/** 把别名解析成真实 PID id。已经是 id 就原样返回（与 DesignFile.resolvePid 一致） */
window.resolvePid = function (name) {
  return window.PID_ALIASES[name] || name;
};

/** 颜色：按样式给个区分色（控件树/列表里的小色块） */
window.styleColor = function (s) {
  return ["#00D8FF", "#7C5CFF", "#2FD47A", "#FFB020", "#FF8A65", "#4DA3FF", "#26C6DA", "#FF4D4F"][s]
    || "#5F6E85";
};

/* ==========================================================================
   数值 → 文字 的映射表（`valueLabels`，P9「非数值 PID 模型」方向 A）

   ⚠️ **必须与 app/.../data/ValueLabels.kt 逐字一致**（verify-crosslang.js 比对）。

   要解决的是：PID 是 `min~max` 的**连续数值**，但挡位（P/R/N/1..6）、
   驾驶模式这类数据**不是数**。方向 A 让值仍然是一个数，**只有读数文本**
   查这张表 —— 数据模型、告警阈值、动画、指针角度全部照旧按数值走。

   注意：**布尔（指示灯亮/灭）不需要这张表** —— `min=0, max=1, warnHigh=0.5`
   就能驱动既有的三态图。需要映射的只有**枚举**。
   ========================================================================== */

/** 最多几项映射（与 Kotlin 侧 `ValueLabels.MAX` 一致） */
window.VALUE_LABELS_MAX = 32;

/**
 * 查表。**没有映射表时返回 null**，调用方回落到数字格式化。
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 空表 / 全空串 | null（等于没设 —— 用户清空文本框会留下 `["",""]`） |
 * | 值是 null / NaN | null |
 * | `round(value)` 越界 | **夹到 0..size-1** |
 *
 * ⚠️ **用 `Math.round` 而不是 `|0` / `Math.trunc`**：`4.999` 是"第 5 挡"，
 * 截断会写成 4 —— 指针指在 5 挡、读数写 4，**两者都不报错**。
 */
window.valueLabelFor = function (labels, value) {
  if (!window.valueLabelsUsable(labels)) return null;
  if (value === null || value === undefined || typeof value !== "number" || !isFinite(value)) return null;
  let i = Math.round(value);
  if (i < 0) i = 0;
  if (i > labels.length - 1) i = labels.length - 1;
  return labels[i];
};

/** 有没有**可用**的映射表（至少一项非空，而不是"数组非空"） */
window.valueLabelsUsable = function (labels) {
  if (!labels || !labels.length) return false;
  for (let i = 0; i < labels.length; i++) if (labels[i]) return true;
  return false;
};

/** 规范化：只留字符串、截断到上限、去掉尾部空项（空表返回 null） */
window.normalizeValueLabels = function (arr) {
  if (!arr || !arr.length) return null;
  const out = [];
  for (let i = 0; i < arr.length && i < window.VALUE_LABELS_MAX; i++) {
    out.push(arr[i] === null || arr[i] === undefined ? "" : String(arr[i]));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.length ? out : null;
};

