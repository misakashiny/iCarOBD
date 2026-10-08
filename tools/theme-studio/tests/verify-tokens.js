/* ==========================================================================
   verify-tokens.js —— 变量（tokens）/ 模式（modes）/ 绑定（bindings）的验证套件
   --------------------------------------------------------------------------
   规格：[`docs/下一步-变量模式与组件变体.md`](../../../docs/下一步-变量模式与组件变体.md)
         §3 格式 · §4 解析 · §5 漂移检测 · §9.2 测试点 T1~T8

   ## 为什么这套**不开浏览器**
   `schema.js` / `validate.js` 的这一部分是**纯逻辑**（没有 DOM、没有 canvas）——
   与 `verify-crosslang.js` 同一类做法：在 `vm` 沙箱里**加载真实的 js 文件**
   （不是复制一份常量），于是测的就是线上跑的那份代码。
   少一个 Edge 进程，也就少一类偶发失败（见大纲 §2.35）。

   ## 覆盖
   T1 等价性（迁移前 = 迁移后，逐字段）  T2 老文件行为不变（且**不写出新键**）
   T3 `$` 防线（normalizeFont 原样保留 + 颜色/数值的 `$` 报硬错误 + **`text` 的 `$` 只警告**
      + **`$$` 转义已取消**（规格 §十二.3）：`text` 是纯字面值）  T4 漂移（警告不是错误，且**以 bindings 为准**）
   T7 12 个内置变量与 THEME_COLOR_FIELDS 一一对应
   T8 `values` 只存差异（删掉覆盖回落 token.value）
   T5 / T6 / T9 属于后续步骤（撤销栈 / 属性面板 / 组件展开），本套件写不了。

   ## ⚠️ 反向验证（每节末尾）
   "检查永远不报" 和 "检查永远报" 一样没用。所以每处都先造**健康样本**证明不误报，
   再**故意破坏**证明它真的会报 —— 见大纲 §2.101「反向验证本身也会假通过」。
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STUDIO = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? "" : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));
}
/** 键序无关的深比较 —— 逐字段 + **键集合**都比（少一个键也算不一致） */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = {};
    Object.keys(v).sort().forEach(k => { o[k] = sortKeys(v[k]); });
    return o;
  }
  return v;
}
function deepEq(a, b, msg) {
  const ja = JSON.stringify(sortKeys(a)), jb = JSON.stringify(sortKeys(b));
  ok(ja === jb, msg + (ja === jb ? "" : `\n       实际 ${ja}\n       期望 ${jb}`));
}
/** 找一条包含全部关键词的文案 */
function hasLine(lines, ...needles) {
  return lines.some(l => needles.every(n => l.indexOf(n) >= 0));
}

// ================================================================ 0) 加载真实代码
//
// 顺序与 index.html 一致（schema → model → validate）。
function loadTool() {
  const sandbox = {
    console: console,
    JSON: JSON, Math: Math, Object: Object, Array: Array, String: String,
    Number: Number, Boolean: Boolean, Date: Date, Set: Set, Map: Map,
    isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => 0,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    localStorage: {
      _d: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() { }, remove() { }, toggle() { } }, appendChild() { }, addEventListener() { }, getContext: () => null }),
      addEventListener: () => { },
      readyState: "complete",
      querySelectorAll: () => [],
    },
    alert: () => { }, confirm: () => true,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  ["schema.js", "model.js", "validate.js"].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(STUDIO, "js", f), "utf8"), sandbox, { filename: f });
  });
  return sandbox;
}

const tool = loadTool();

// ================================================================ 样本

/** 一份最小但**完全合法**的 v2 设计（一个文字节点 + 一个仪表节点） */
function mkRoot(extra) {
  const root = {
    schema: "icar.ui/2",
    meta: { name: "变量测试" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    theme: "neon",
    nodes: [
      {
        id: "n1", type: "text", name: "标题", x: 10, y: 10, w: 120, h: 30,
        text: "转速",
        font: { family: "sans", size: 8, weight: 700, align: "center", color: "#FF8A00" },
      },
      {
        id: "n2", type: "gauge", name: "转速表", x: 10, y: 60, w: 180, h: 180,
        pid: "obd.rpm", style: 0, min: 0, max: 8000,
        card: { show: true, alpha: 200, radius: 12 },
        labelFont: { color: "#D8BFA0" },
      },
    ],
  };
  Object.keys(extra || {}).forEach(k => { root[k] = extra[k]; });
  return root;
}
const parse = root => tool.parseDesignRoot(JSON.parse(JSON.stringify(root)));
const nodeById = (d, id) => d.nodes.find(n => n.id === id);

// 12 个内置变量的字段名（**写死**，不从被测代码里取 —— 否则改名会一起"通过"）
const TWELVE = ["background", "surface", "surfaceEdge", "accent", "accentHot", "accentDim",
  "track", "tick", "needle", "value", "label", "dim"];
const FIFTEEN = TWELVE.concat(["glow", "title", "description"]);

(async () => {

  // ============================================================ 1) 常量与生成器（T7）
  console.log("=== 1. TOKEN_TYPES / 白名单 / 内置变量与模式 ===");

  eq(tool.TOKEN_TYPES.map(t => t.v).join(","), "color,number,string", "变量类型是 color / number / string");
  eq(tool.BINDABLE_FIELD_PATHS.join(","),
    "font.color,text,labelFont.color,card.radius,card.alpha",
    "可绑定白名单 = §3.6 的 5 处（一处不多、一处不少）");
  eq(tool.THEME_COLOR_FIELDS.map(f => f.k).join(","), TWELVE.join(","),
    "THEME_COLOR_FIELDS 仍是那 12 个（本套件的写死清单与实现一致）");

  // T7：12 个内置变量与 THEME_COLOR_FIELDS **一一对应**
  ["neon", "ice", "amber"].forEach(al => {
    const tk = tool.buildBuiltinTokens(al);
    eq(tk.length, 12, al + "：内置变量正好 12 个");
    eq(tk.map(t => t.builtin).join(","), TWELVE.join(","),
      al + "：内置变量的 builtin 与 THEME_COLOR_FIELDS **逐项同序对应**");
    eq(tk.map(t => t.id).join(","), TWELVE.map(k => "tk_" + k).join(","),
      al + "：内置变量的 id 由字段名推出来（tk_<字段>）");
    eq(tk.map(t => t.name).join(","), TWELVE.join(","), al + "：内置变量的名字 = 字段名");
    const bad = tk.filter(t => t.type !== "color" || t.value !== tool.GAUGE_THEMES[al][t.builtin]);
    eq(bad.length, 0, al + "：每个内置变量的类型都是 color、值等于该主题的同名字段");
  });
  // 三个主题的内置变量值互不相同（否则"换主题"这件事根本没发生）
  eq(tool.buildBuiltinTokens("neon").find(t => t.builtin === "accent").value,
    tool.GAUGE_THEMES.neon.accent, "neon 的 accent 默认值 = GAUGE_THEMES.neon.accent");

  // 没有主题 → **刻意**不生成（理由见 schema.js buildBuiltinTokens 的注释）
  eq(tool.buildBuiltinTokens("").length, 0, "没有主题时不生成内置变量（没有默认值可取）");
  eq(tool.buildBuiltinTokens("我的自定义主题").length, 0, "不是三个内置主题之一时同样不生成");
  eq(tool.buildBuiltinModes("").length, 0, "没有主题时不生成内置模式");

  const modes = tool.buildBuiltinModes("neon");
  eq(modes.length, 3, "内置模式 3 个");
  eq(modes.map(m => m.id).join(","), "m_neon,m_ice,m_amber", "内置模式的 id 是 m_<别名>（可改名、不可删的稳定标记）");
  eq(modes.map(m => m.name).join(","), "霓虹赛道,冰川科技,经典琥珀", "内置模式的名字来自 GAUGE_THEMES.title");
  eq(Object.keys(modes.find(m => m.id === "m_neon").values).length, 0,
    "当前主题那个模式的 values **是空的**（全部等于默认值 —— 只存差异）");
  // T8：只存差异
  //
  // ⚠️ 这里要**两个方向**都验，否则很容易写成一条永远成立的断言：
  //   · "相同的字段没写" —— 如果拿来比的两个主题**恰好一个字段都不同**，
  //     这条就退化成"0 个字段没写"的空断言（实测 neon vs ice 就是这样：12 个全不同）
  //   · 所以再补一条"不同的字段**都**写了"，用**数量相等**把它钉死
  const iceVals = modes.find(m => m.id === "m_ice").values;
  const iceDiff = TWELVE.filter(k => tool.GAUGE_THEMES.ice[k] !== tool.GAUGE_THEMES.neon[k]);
  const iceWrote = Object.keys(iceVals).filter(k => k.charAt(0) !== "@");
  eq(iceDiff.length, 12, "T8（前置）neon 与 ice 这 12 个颜色**全都不同** —— 所以不能拿它验「相同的字段没写」");
  eq(iceWrote.length, iceDiff.length, "T8：写进 values 的颜色键数 == 与默认值不同的字段数（" + iceDiff.length + " 个）");
  eq(iceDiff.filter(k => !Object.prototype.hasOwnProperty.call(iceVals, "tk_" + k)).length, 0,
    "T8：每一个不同的字段**都**写了");
  eq(TWELVE.filter(k => Object.prototype.hasOwnProperty.call(iceVals, "tk_" + k)
    && tool.GAUGE_THEMES.ice[k] === tool.GAUGE_THEMES.neon[k]).length, 0,
    "T8：一个与默认值相同的字段都没写");
  eq(iceVals["tk_accent"], tool.GAUGE_THEMES.ice.accent, "T8：与默认值不同的字段才写（tk_accent 写了）");
  eq(iceVals["@glow"], false, "T8：非颜色字段（glow）走 `@` 覆盖 —— neon 是 true、ice 是 false");

  // ============================================================ 2) T1 等价性
  console.log("\n=== 2. T1 等价性：迁移后导出的 themeColors 与迁移前逐字段相同 ===");

  // 老文件 = 只有 themeColors（没有 tokens / modes）。走**真实代码路径**：
  //   parseDesignRoot（算出 themeColorsOverride）→ toV2Json（今天导出的 themeColors）
  function legacyExport(themeId, override) {
    const root = mkRoot(override ? { theme: themeId, themeColors: Object.assign({}, tool.GAUGE_THEMES[themeId] || {}, override) } : { theme: themeId });
    const r = parse(root);
    if (r.errors.length) throw new Error("样本本身不合法：" + r.errors.join("；"));
    return { design: r.design, json: JSON.parse(tool.toV2Json(r.design)) };
  }
  /** 迁移一份老 design（就地把 tokens/modes/activeMode 装上去，模拟 §9.3） */
  function migrate(design) {
    const m = tool.migrateThemeToTokens(design.themeId, design.themeColorsOverride);
    design.tokens = m.tokens;
    design.modes = m.modes;
    design.activeMode = m.activeMode;
    return design;
  }

  const CASES = [
    ["neon", null, "主题 = neon，没有任何覆盖"],
    ["neon", { accent: "#FF0000" }, "只改主色"],
    ["neon", { accent: "#FF0000", track: "#101010" }, "改两个颜色"],
    ["neon", { glow: false }, "**只改非颜色字段 glow**（THEME_COLOR_FIELDS 里没有它）"],
    ["ice", { accent: "#123456", glow: true, title: "我的冰川" }, "改颜色 + 两个非颜色字段"],
    ["amber", { background: "#000000", dim: "#FFFFFF" }, "amber + 两个颜色"],
    ["neon", TWELVE.reduce((o, k) => (o[k] = "#010203", o), {}), "12 个颜色全改"],
    ["", { accent: "#FF0000" }, "**没有主题**（theme 缺失）—— 刻意不迁移，走老路径"],
    ["我的自定义主题", { accent: "#FF0000" }, "**未知主题** —— 同样走老路径"],
  ];

  CASES.forEach(([themeId, override, label]) => {
    const { design, json } = legacyExport(themeId, override);
    const before = json.themeColors || null;

    // (a) 迁移前：resolveDesign 必须与今天的导出**完全一致**（它此刻还没有变量系统）
    deepEq(tool.resolveDesign(design).themeColors || null, before, "T1a 迁移前 resolveDesign = 今天导出的 themeColors —— " + label);

    // (b) 迁移后：把 themeColorsOverride 收进模式，导出的 themeColors 必须**逐字段相同**
    const d2 = migrate(JSON.parse(JSON.stringify(design)));
    deepEq(tool.resolveDesign(d2).themeColors || null, before, "T1b 迁移后 resolveDesign = 迁移前的导出 —— " + label);
  });

  // 已知主题时必须是完整的 15 个字段（12 色 + glow + title + description）
  ["neon", "ice", "amber"].forEach(al => {
    const { design } = legacyExport(al, { accent: "#FF0000" });
    const tc = tool.resolveDesign(migrate(design)).themeColors;
    eq(Object.keys(tc).sort().join(","), FIFTEEN.slice().sort().join(","),
      al + "：迁移后的 themeColors 仍是完整 15 个字段（跨语言契约，§8.1）");
  });
  // 没有主题 + 有覆盖时，今天导出的就是**只有覆盖**（不带 12 色打底）—— 迁移后也必须如此
  const noTheme = legacyExport("", { accent: "#FF0000" });
  eq(Object.keys(noTheme.json.themeColors).join(","), "accent",
    "没主题时今天只导出用户覆盖的字段（这就是「不能给它兜底 neon」的原因）");
  deepEq(tool.resolveDesign(migrate(noTheme.design)).themeColors, { accent: "#FF0000" },
    "没主题的样本迁移后仍然只有 accent —— 一个字段都没多");

  // 切模式 = 换一整套配色（迁移后另外两个内置模式必须**逐字段等于**那个主题）
  {
    const { design } = legacyExport("neon", { accent: "#FF0000" });
    const d = migrate(design);
    deepEq(tool.resolveDesign(d).themeColors, Object.assign({}, tool.GAUGE_THEMES.neon, { accent: "#FF0000" }),
      "切模式：当前模式（neon + 用户覆盖）正确");
    d.activeMode = "m_ice";
    deepEq(tool.resolveDesign(d).themeColors, tool.GAUGE_THEMES.ice,
      "切到 m_ice → themeColors **逐字段等于** GAUGE_THEMES.ice（含 glow / title / description）");
    d.activeMode = "m_amber";
    deepEq(tool.resolveDesign(d).themeColors, tool.GAUGE_THEMES.amber, "切到 m_amber → 逐字段等于 GAUGE_THEMES.amber");
    d.activeMode = "m_neon";
    deepEq(tool.resolveDesign(d).themeColors, Object.assign({}, tool.GAUGE_THEMES.neon, { accent: "#FF0000" }),
      "切回来 → 用户改过的主色还在（覆盖没有丢）");
  }

  // ============================================================ 2b) 第 4 步：导出
  console.log("\n=== 2b. 第 4 步：序列化四个新键 + 导出走 resolveDesign（T1c / App 兼容硬断言） ===");

  /** 递归收集一棵节点树里所有 `type`（App 只认四种，见 §8） */
  function allTypes(list, acc) {
    (list || []).forEach(n => { if (n && typeof n === "object") { acc.push(n.type); allTypes(n.children, acc); } });
    return acc;
  }
  const FOUR_TYPES = "group,image,gauge,text";

  {
    // ---- T1c：**真正落盘的那条路**（`toV2Json`），不是 `resolveDesign`
    //
    // T1a/T1b 验的是解析函数；而"存量设计的配色会不会变"取决于**导出**。
    // 第 4 步把 `toV2Json` 接上 `resolveDesign` 之后，必须**逐字段还是那个值**。
    CASES.forEach(([themeId, override, label]) => {
      const { design, json } = legacyExport(themeId, override);
      const before = json.themeColors || null;
      const after = JSON.parse(tool.toV2Json(migrate(JSON.parse(JSON.stringify(design)))));
      deepEq(after.themeColors || null, before,
        "T1c 迁移后 **toV2Json 导出**的 themeColors 与迁移前逐字段相同 —— " + label);
    });
  }

  {
    // ---- 四个新键真的写出来了（且内容 = 内存里的那份）
    //
    // 样本是**健康的**：nodes 里的字面值已经等于 bindings 推出来的值（= 工具自己写过的文件）。
    // 漂移的情况在下面单独一段（"已按 bindings 重建"必须真的落到文件里）。
    const root = mkRoot({
      tokens: [
        { id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" },
        { id: "tk_t", name: "title", type: "string", value: "$100" },
        { id: "tk_r", name: "radius", type: "number", value: 24 },
      ],
      modes: [{ id: "m_neon", name: "霓虹赛道", values: { tk_accent: "#FF0000" } }],
      activeMode: "m_neon",
      bindings: { n1: { "font.color": "$accent", "text": "$title" }, n2: { "card.radius": "$radius" } },
    });
    root.nodes[0].font.color = "#FF0000";     // 与模式推出来的值一致
    root.nodes[0].text = "$100";              // 与 token 的值一致
    root.nodes[1].card.radius = 24;
    const r = parse(root);
    eq(r.errors.length, 0, "第 4 步样本：0 错误");
    eq(r.warnings.length, 0, "第 4 步样本：0 警告（健康文件不该被打扰）");
    const out = JSON.parse(tool.toV2Json(r.design));

    eq(Array.isArray(out.tokens) && out.tokens.length, 3, "第 4 步 `tokens` 写出来了（3 个）");
    deepEq(out.tokens[0], { id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" },
      "第 4 步 `tokens[0]` 逐字段与内存一致（含 `builtin` —— 它是「喂给 themeColors」的凭据）");
    eq(out.modes.length, 1, "第 4 步 `modes` 写出来了");
    eq(out.modes[0].values.tk_accent, "#FF0000", "第 4 步 `modes[].values` 只存差异，原样写出");
    eq(out.activeMode, "m_neon", "第 4 步 `activeMode` 写出来了");
    deepEq(out.bindings, { n1: { "font.color": "$accent", "text": "$title" }, n2: { "card.radius": "$radius" } },
      "第 4 步 `bindings` 写出来了（白名单字段 + `$` 引用，一条不多一条不少）");

    // ---- App 兼容硬断言（§8）：写出去的 `nodes` 必须是**字面值**
    eq(out.nodes[0].font.color, "#FF0000", "第 4 步 绑定字段在导出里是**字面值**（#FF0000，来自当前模式）");
    eq(out.nodes[1].card.radius, 24, "第 4 步 数字绑定字段同样是字面值（24）");
    const types = allTypes(out.nodes, []);
    eq(types.filter(t => FOUR_TYPES.split(",").indexOf(t) < 0).length, 0,
      "App 硬断言：导出的 `nodes` 里只有 group / image / gauge / text 四种 type（未知 type 会让 App 报硬错误）");
    const dollarFields = [];
    (function scan(list) {
      (list || []).forEach(n => {
        if (!n) return;
        ["font", "labelFont"].forEach(f => {
          if (n[f] && typeof n[f].color === "string" && n[f].color.charAt(0) === "$") dollarFields.push(n.id + "." + f + ".color");
        });
        if (n.card && typeof n.card.radius === "string" && n.card.radius.charAt(0) === "$") dollarFields.push(n.id + ".card.radius");
        scan(n.children);
      });
    })(out.nodes);
    eq(dollarFields.length, 0, "App 硬断言：导出的 `nodes` 里**没有** `$` 引用（App 会静默回落成默认色）");

    // ---- 完整 15 字段（跨语言契约，§8.1）
    eq(Object.keys(out.themeColors).sort().join(","), FIFTEEN.slice().sort().join(","),
      "第 4 步 导出的 `themeColors` 仍是完整 15 字段（12 色 + glow + title + description）");
    eq(out.themeColors.accent, "#FF0000", "第 4 步 模式里的覆盖进了 themeColors");
  }

  {
    // ---- 漂移（nodes 里是旧值）→ 导出的必须是**bindings 推出来的值**
    //
    // 这是"已按 bindings 重建"这句话的落盘证据：警告说了要重建，
    // 那就必须真的重建 —— 否则用户看到警告、改了 JSON、再存盘，
    // 文件里还是旧值，而 App 拿到的就是那个旧值（最要命的一类）。
    const root = mkRoot({
      tokens: [
        { id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" },
        { id: "tk_r", name: "radius", type: "number", value: 24 },
      ],
      modes: [{ id: "m_neon", name: "霓虹赛道", values: {} }],
      activeMode: "m_neon",
      bindings: { n1: { "font.color": "$accent" }, n2: { "card.radius": "$radius" } },
    });
    // mkRoot 里 n1.font.color = #FF8A00（正好等于变量值）、n2.card.radius = 12（不等于 24）
    const r = parse(root);
    eq(r.errors.length, 0, "第 4 步 漂移样本：0 错误（漂移只警告）");
    eq(r.warnings.length, 1, "第 4 步 漂移样本：恰好 1 条警告（card.radius）");
    const out = JSON.parse(tool.toV2Json(r.design));
    eq(out.nodes[1].card.radius, 24, "第 4 步 漂移：导出写的是 **bindings 的值（24）**，不是 nodes 里的旧值 12");
    eq(r.design.nodes[1].card.radius, 12, "第 4 步 漂移：原 design 没被改（视图 ≠ 真相）");
  }

  {
    // ---- 绑定来的 `$` 开头字符串：**原样写文件**（没有 `$$` 这回事）
    //
    // 规格 §9.1 第 4 步担心"写回文件会被下次打开当成引用，每存一次退一步"。
    // 这条把它变成**可测的事实**：导出 → 重新 parse → 0 错误 0 警告 + 值不变。
    // （不会退步的原因：`bindings` 同时写进文件 —— `checkDollarInNodes` 见到
    //   声明过的引用直接放过，漂移检测比的又是同一个字面值。）
    const root = mkRoot({
      tokens: [{ id: "tk_t", name: "title", type: "string", value: "$100" }],
      bindings: { n1: { "text": "$title" } },
    });
    const r = parse(root);
    const j1 = tool.toV2Json(r.design);
    const out1 = JSON.parse(j1);
    eq(out1.nodes[0].text, "$100",
      "第 4 步 绑定来的 `$100` **原样写文件**（`$$` 转义已取消 —— 写 `$$100` 设备上就会多一个 `$`）");
    eq(out1.bindings.n1.text, "$title", "第 4 步（前提）`bindings` 同时写了出去 —— 这才是「不会被当成引用」的原因");

    const r2 = parse(JSON.parse(j1));
    eq(r2.errors.length, 0, "第 4 步 往返：重新打开 **0 错误**");
    eq(r2.warnings.length, 0,
      "第 4 步 往返：**0 警告**（没有「每存一次退一步」—— 引用被 bindings 声明了）");
    eq(tool.resolveDesign(r2.design).nodes[0].text, "$100", "第 4 步 往返：画布显示值不变");
    const j2 = tool.toV2Json(r2.design);
    eq(j2 === j1, true, "第 4 步 往返：**文件 → 内存 → 文件 逐字节稳定**（第二次导出与第一次完全相同）");
  }

  {
    // ---- 反向：`$$100` 这种**字面内容**一个字都不许动（逐字节稳定，与上面形成对照）
    //
    // ⚠️ 取消转义之后 `$$100` 就是普通文本：**工具、导出、App 三边都是 `$$100`**。
    // 它多一条"看起来像引用"的警告 —— 这是取消转义要付的代价，如实钉住。
    const root = mkRoot();
    root.nodes[0].text = "$$100";
    const r = parse(root);
    eq(r.errors.length, 0, "第 4 步 `$$100` 样本：0 错误");
    eq(r.warnings.filter(w => w.indexOf("bindings 里没有这条") >= 0).length, 1,
      "第 4 步 `$$100` 样本：1 条警告（它确实以 `$` 开头）");
    const out = JSON.parse(tool.toV2Json(r.design));
    eq(out.nodes[0].text, "$$100", "第 4 步 `$$100` 原样写回（用户的文件内容一个字不动）");
    const j1 = tool.toV2Json(r.design);
    const j2 = tool.toV2Json(parse(JSON.parse(j1)).design);
    eq(j2 === j1, true, "第 4 步 `$$100`：文件 → 内存 → 文件 **逐字节稳定**");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$$100",
      "第 4 步（对照）画布上也是 `$$100` —— 画布 / 文件 / App **三边同一个串**");
  }

  {
    // ---- 多页：当前页的绑定值也必须落到 `pages[i].nodes`（任务 1 修的就是这里）
    const root = aliasRoot();
    delete root.bindings.n1["text"];
    const r = parse(root);
    const out = JSON.parse(tool.toV2Json(r.design));
    eq(Array.isArray(out.pages) && out.pages.length, 2, "第 4 步 多页设计写出了 `pages`（2 页）");
    eq(out.pages[0].nodes[0].font.color, "#FF8A00",
      "第 4 步 多页：**当前页** `pages[0].nodes` 里的绑定是字面值（任务 1 之前这里会写成旧值 #123456）");
    eq(out.pages[1].nodes[0].font.color, "#FF8A00", "第 4 步 多页：非当前页的绑定同样落盘");
    eq(allTypes(out.pages[0].nodes, []).filter(t => FOUR_TYPES.split(",").indexOf(t) < 0).length, 0,
      "App 硬断言：多页的 `pages[].nodes` 里也只有那四种 type");
  }

  // ============================================================ 3) T2 向后兼容
  console.log("\n=== 3. T2 老文件行为完全不变（没有变量系统时**不写出**新顶层键） ===");

  {
    const r = parse(mkRoot());
    eq(r.errors.length, 0, "T2 老文件解析：0 个错误");
    eq(r.warnings.length, 0, "T2 老文件解析：0 个警告（多一条都算打扰用户）");
    eq(JSON.stringify(r.design.tokens), "[]", "T2 老文件的 tokens 是空数组");
    eq(JSON.stringify(r.design.modes), "[]", "T2 老文件的 modes 是空数组");
    eq(r.design.activeMode, "", "T2 老文件的 activeMode 是空串");
    eq(JSON.stringify(r.design.bindings), "{}", "T2 老文件的 bindings 是空对象");

    // nodes 逐字节不变（没有 `$` 可字面化）
    deepEq(tool.resolveDesign(r.design).nodes, r.design.nodes, "T2 resolveDesign 后 nodes **逐字节相同**");

    // 最硬的一条：**没有变量系统的老文件不写出任何新顶层键**
    //（这才是"对 App 与存量文件零影响"的凭据：一存盘不会多出四段噪音）
    const out = JSON.parse(tool.toV2Json(r.design));
    ["tokens", "modes", "activeMode", "bindings"].forEach(k => {
      eq(Object.prototype.hasOwnProperty.call(out, k), false,
        "T2 没有变量系统 → 导出的 JSON 里没有 `" + k + "`（空的一律不写）");
    });
    // ⚠️ 第 4 步起，**有**变量系统就**要**写出（上面那条是"空的不写"，不是"永远不写"）。
    // 反向验证：如果这里仍然不写，第 4 步就等于没做 —— 用户编辑的 tokens 一存盘就没了。
    const d2 = migrate(JSON.parse(JSON.stringify(r.design)));
    eq(d2.tokens.length, 12, "（前置）迁移后内存里确实有 12 个变量");
    const out2 = JSON.parse(tool.toV2Json(d2));
    ["tokens", "modes", "activeMode"].forEach(k => {
      eq(Object.prototype.hasOwnProperty.call(out2, k), true,
        "T2 有变量系统 → 导出的 JSON 里**有** `" + k + "`（第 4 步：不写 = 用户的编辑存不下来）");
    });
    eq(out2.bindings, undefined, "T2 但 `bindings` 是空的 → 照旧不写（空的不写，与 tokens 同一条规则）");
    deepEq(out2.themeColors, out.themeColors, "T2 迁移前后 toV2Json 的 themeColors 也逐字段相同");
  }

  // ============================================================ 4) T3 `$` 防线
  console.log("\n=== 4. T3 `$` 防线（颜色/数值硬错误 + `text` 只警告；`$$` 转义已取消） ===");

  eq(tool.normalizeFont({ color: "$accent" }).color, "$accent",
    "T3 normalizeFont 对 `$accent` **原样保留**（不回落默认色）");
  eq(tool.normalizeFont({ color: "$tk1" }).color, "$tk1", "T3 按 id 的引用同样保留");
  eq(tool.normalizeFont({ color: "$$accent" }).color, "$$accent",
    "T3 **颜色**上的 `$$` 没有任何特殊含义 —— 原样保留（`$$` 转义已取消，见规格 §十二.3）");
  eq(tool.normalizeFont({ color: "#abc" }).color, tool.FONT_DEFAULT.color,
    "T3 真正非法的颜色**仍然**回落默认色（防线只放过 `$`，没有放宽其它）");
  eq(tool.normalizeFont({}).color, tool.FONT_DEFAULT.color, "T3 缺字段仍然回落默认色");
  eq(tool.normalizeFont({ color: "#FF8A00" }).color, "#FF8A00", "T3 合法颜色不受影响");

  // ---- `$$` 转义**已取消**（规格 §十二.3）：`text` 是纯字面值，判据只剩一条
  eq(typeof tool.unescapeTextDollar, "undefined",
    "T3 `unescapeTextDollar` **已删除**（`$$` 转义取消后它没有意义，留着会有人再调用它）");
  eq(typeof tool.isTextTokenRef, "undefined", "T3 `isTextTokenRef` 同样已删除（`text` 与颜色用同一条判据）");
  eq(typeof tool.TEXT_DOLLAR_ESCAPE, "undefined", "T3 `TEXT_DOLLAR_ESCAPE` 常量也已删除");
  eq(tool.isTokenRef("$$100"), true,
    "T3 `$$100` 也算「看起来像引用」（字符串以 `$` 开头）—— 在 `text` 上给警告、在颜色/数值上给硬错误");
  eq(tool.isTokenRef("$accent"), true, "T3 `$accent` 同样是引用语法");
  eq(tool.isTokenRef("转速"), false, "T3 不以 `$` 开头的文本不是引用（最常见的正常情况）");

  /**
   * 把 5 处白名单字段各写一个 `$` 引用（bindings 按需给）。
   *
   * ⚠️ 一份样本同时覆盖**两档**判据（v2.80.1）：
   *   · 4 个颜色/数值字段 → 硬错误（文件打不开）
   *   · `text`            → 警告（文件照常打开）
   * 所以下面的断言分成两组，**两组都要有** —— 只测一组就会漏掉另一档的回归。
   */
  function dollarRoot(withBindings) {
    const root = mkRoot({
      tokens: [{ id: "tk_a", name: "accent", type: "color", value: "#FF8A00" },
               { id: "tk_t", name: "title", type: "string", value: "转速" },
               { id: "tk_r", name: "radius", type: "number", value: 12 }],
      modes: [], activeMode: "",
    });
    root.nodes[0].font.color = "$accent";
    root.nodes[0].text = "$title";
    root.nodes[1].labelFont.color = "$accent";
    root.nodes[1].card.radius = "$radius";
    root.nodes[1].card.alpha = "$radius";
    if (withBindings) {
      root.bindings = {
        n1: { "font.color": "$accent", "text": "$title" },
        n2: { "labelFont.color": "$accent", "card.radius": "$radius", "card.alpha": "$radius" },
      };
    }
    return root;
  }

  {
    const r = parse(dollarRoot(false));
    eq(r.design, null, "T3 颜色/数值字段有 `$` 且没有 bindings → **解析失败**（硬错误）");
    eq(r.errors.length, 4, "T3 恰好 4 条硬错误（font.color / labelFont.color / card.radius / card.alpha）"
      + "—— 实测 " + r.errors.length + " 条");
    ["font.color", "labelFont.color", "card.radius", "card.alpha"].forEach(p => {
      ok(hasLine(r.errors, p, "引用不能写在 nodes 里"), "T3 报出了 " + p + " 的硬错误：" + p + " … 引用不能写在 nodes 里");
    });
    eq(r.errors.filter(e => e.indexOf(".text ") >= 0).length, 0,
      "T3 `text` 那一条**不在** errors 里（它降为警告了 —— 这是本次改动的全部目的）");
    ok(hasLine(r.errors, "bindings 里没有这条"), "T3 文案说明了原因是 bindings 里没有对应条目");
    // ⚠️ 反向：**不能**变成"已忽略 / 不是数字"这种软处理（那正是 §4.2 的静默陷阱）
    eq(hasLine(r.warnings, "不是数字 —— 已忽略"), false,
      "T3 card.radius 的 `$radius` **没有**被 parseCard 当成「不是数字」丢掉");
    eq(r.warnings.filter(w => w.indexOf("font") >= 0).length, 0, "T3 字体颜色也没有走「回落默认色」的软路径");
  }
  {
    // ---- `text` 上未绑定的 `$` → **警告**，文件照常打开（v2.80.1 的核心改动）
    //
    // 反向验证的另一半：**健康样本必须不误报**。`$100` 是正常内容，
    // 而 v2.80.0 的判据会让整个文件打不开 —— 那正是要治的病。
    const root = mkRoot();
    root.nodes[0].text = "$100";
    const r = parse(root);
    eq(r.errors.length, 0, "T3 `text` 里未绑定的 `$100` → **0 个错误**（不再拦文件）");
    eq(r.design === null, false, "T3 **文件照常打开**（硬错误 = 用户的文件打不开，是本项目最怕的失效方式）");
    ok(hasLine(r.warnings, "nodes[0].text 是 `$100`", "bindings 里没有这条"),
      "T3 报出了**警告**，且指出了位置与原因");
    ok(hasLine(r.warnings, "不用管这条"),
      "T3 警告给出**字面内容的出路**：什么都不用做（v2.80.2 起 `text` 就是字面值）");
    ok(hasLine(r.warnings, "如果是要", "绑定变量", "bindings 条目"),
      "T3 警告给出了**绑定的出路**：加 bindings 条目（只给一条出路等于没给）");
    eq(r.warnings.some(w => w.indexOf("$$") >= 0), false,
      "T3 ⚠️ 警告里**不许再出现 `$$`**（规格 §十二.3：那句话在教用户写出设备显示错的文件）");
    eq(r.design.nodes[0].text, "$100", "T3 解析后 design 里**原样保留** `$100`");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$100",
      "T3 没有绑定 → resolveDesign 也原样显示 `$100`（不猜用户意图）");
  }
  {
    // ---- `$$100` 现在是**普通字面文本**：显示 `$$100`（工具与设备一致），只给一条警告
    //
    // v2.80.1 它被当成"转义"（显示 `$100`、0 警告）；v2.80.2 取消转义后，
    // 它就是一个"看起来像引用"的普通串 —— 这也是**取消转义要付的代价**，
    // 如实钉住：多一条警告，但显示与设备一致（设备上本来就是 `$$100`）。
    const root = mkRoot();
    root.nodes[0].text = "$$100";
    const r = parse(root);
    eq(r.errors.length, 0, "T3 `$$100` → 0 错误");
    eq(r.design === null, false, "T3 `$$100` 不拦文件");
    eq(r.warnings.filter(w => w.indexOf("bindings 里没有这条") >= 0).length, 1,
      "T3 `$$100` → **1 条警告**（它确实以 `$` 开头；转义取消后这不再被豁免）");
    eq(r.design.nodes[0].text, "$$100", "T3 design 里保留原样 `$$100`");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$$100",
      "T3 画布/导出/App **三边都是 `$$100`**（没有任何一处会把它变成 `$100`）");
    eq(JSON.parse(tool.toV2Json(r.design)).nodes[0].text, "$$100",
      "T3 导出回文件仍然是 `$$100`（逐字节稳定）");
  }
  {
    // ---- 反向：颜色上的 `$$accent` 仍然是硬错误（颜色字段不可能有字面 `$`）
    const root = mkRoot();
    root.nodes[0].font.color = "$$accent";
    const r = parse(root);
    eq(r.design, null, "T3 颜色字段上的 `$$accent` **仍是硬错误**（颜色不可能有字面 `$`）");
    eq(r.errors.length, 1, "T3 恰好 1 条硬错误（实测 " + r.errors.length + " 条）");
    ok(hasLine(r.errors, "font.color", "引用不能写在 nodes 里"), "T3 报的正是 font.color");
  }
  {
    const r = parse(dollarRoot(true));
    eq(r.errors.length, 0, "T3 同样一份设计，bindings 里写全了 → **0 个错误**（引用合法）");
    eq(r.warnings.filter(w => w.indexOf("bindings 里没有这条") >= 0).length, 0,
      "T3 绑定写全了 → 「`$` 没有绑定」的警告**一条都不出现**（反向：不误报）");
    eq(r.design.nodes[0].font.color, "$accent", "T3 解析后 nodes 里仍然是引用串（字面化是 resolveDesign 的事）");
    eq(r.design.nodes[1].card.radius, "$radius", "T3 `card.radius` 的引用也原样留着");
    eq(r.design.nodes[0].text, "$title", "T3 `text` 的引用同样原样留着（解析不解引用）");
  }
  {
    // 反向验证：只把 n1 的绑定摘掉，错误必须**只**针对 n1
    const root = dollarRoot(true);
    delete root.bindings.n1["font.color"];
    const r = parse(root);
    eq(r.errors.length, 1, "T3 摘掉 n1.font.color 的绑定 → 恰好 1 条错误（不多不少）");
    ok(hasLine(r.errors, "font.color", "bindings 里没有这条"), "T3 报的正是被摘掉的那一条");
  }
  {
    // 反向验证：摘掉的是 **text** 的绑定 → 恰好 1 条**警告**，文件照常打开
    const root = dollarRoot(true);
    delete root.bindings.n1["text"];
    const r = parse(root);
    eq(r.errors.length, 0, "T3 摘掉 n1.text 的绑定 → **0 个错误**（与颜色字段形成对照）");
    eq(r.design === null, false, "T3 摘掉 n1.text 的绑定 → 文件照常打开");
    eq(r.warnings.filter(w => w.indexOf("bindings 里没有这条") >= 0).length, 1,
      "T3 恰好 1 条「没有绑定」的警告（不多不少）");
    ok(hasLine(r.warnings, "nodes[0].text", "bindings 里没有这条"), "T3 报的正是被摘掉的那一条");
  }
  {
    // ---- 漂移比较：`text` 现在**逐字比字面值**（转义取消后没有"显示值"这一层）
    const root = mkRoot({
      tokens: [{ id: "tk_t", name: "title", type: "string", value: "$100" }],
      bindings: { n1: { "text": "$title" } },
    });
    root.nodes[0].text = "$100";                 // 与变量值**逐字相同**
    const r = parse(root);
    eq(r.errors.length, 0, "T3 绑定 + 字面值一致：0 错误");
    eq(r.warnings.length, 0, "T3 值逐字相同 → **0 警告**（不误报漂移）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$100", "T3 绑定写值：`$100`");
  }
  {
    // 反向：**真的**不同（nodes 是 `$$100`，变量是 `$100`）→ 漂移必须照报
    //
    // v2.80.1 这一条是"不报"（因为显示值都被解成 `$100`）；转义取消后
    // 两者是**不同的字面值**，所以必须报 —— 这正是取消转义带来的行为变化，钉住它。
    const root = mkRoot({
      tokens: [{ id: "tk_t", name: "title", type: "string", value: "$100" }],
      bindings: { n1: { "text": "$title" } },
    });
    root.nodes[0].text = "$$100";
    const r = parse(root);
    eq(r.errors.length, 0, "T3 `$$100` vs 变量 `$100`：0 错误");
    ok(hasLine(r.warnings, "n1 的 text 在 nodes 里是 $$100", "已按 bindings 重建"),
      "T3 两个**字面值**不同 → 漂移照报（不再有「显示相同」这种豁免）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$100", "T3 以 bindings 为准");
  }
  {
    // 反向：变量是「转速」→ 漂移照报（与上面同一条判据，换个值再验一次）
    const root = mkRoot({
      tokens: [{ id: "tk_t", name: "title", type: "string", value: "转速" }],
      bindings: { n1: { "text": "$title" } },
    });
    root.nodes[0].text = "$$100";
    const r = parse(root);
    ok(hasLine(r.warnings, "n1 的 text 在 nodes 里是 $$100", "已按 bindings 重建"),
      "T3 值真的不同 → 漂移照报（反向验证：别把漂移一起放过了）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "转速", "T3 以 bindings 为准");
  }

  // ============================================================ 5) T4 漂移检测
  console.log("\n=== 5. T4 漂移检测：nodes 与 bindings 不一致 → **警告**（不是错误），以 bindings 为准 ===");

  function driftRoot(actualColor) {
    const root = mkRoot({
      tokens: [{ id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" }],
      modes: [{ id: "m_neon", name: "霓虹赛道", values: {} }],
      activeMode: "m_neon",
      bindings: { n1: { "font.color": "$accent" } },
    });
    root.nodes[0].font.color = actualColor;
    return root;
  }

  {
    const r = parse(driftRoot("#E8EEF7"));
    eq(r.errors.length, 0, "T4 漂移**不是**错误（手改 JSON 是合法用法）");
    eq(r.design === null, false, "T4 漂移不影响文件打开");
    ok(hasLine(r.warnings, "n1 的 font.color 在 nodes 里是 #E8EEF7", "但 bindings 指向 $accent", "（= #FF8A00）", "已按 bindings 重建"),
      "T4 警告文案与 §5 的表一致（含「已按 bindings 重建」）");
    // 以 bindings 为准
    eq(tool.resolveDesign(r.design).nodes[0].font.color, "#FF8A00",
      "T4 resolveDesign **以 bindings 为准**：nodes 里的 #E8EEF7 被换成 #FF8A00");
    eq(r.design.nodes[0].font.color, "#E8EEF7", "T4 原 design 没有被改动（解析结果只是视图）");
  }
  {
    const r = parse(driftRoot("#FF8A00"));
    eq(r.warnings.length, 0, "T4 值一致时**一条警告都没有**（反向验证：不误报）");
    eq(r.errors.length, 0, "T4 值一致时也没有错误");
  }
  {
    // bindings 指向不存在的变量 → **硬错误**（§5 的表）
    const root = mkRoot({
      tokens: [{ id: "tk_a", name: "accent", type: "color", value: "#FF8A00" }],
      bindings: { n1: { "font.color": "$nope" } },
    });
    const r = parse(root);
    eq(r.design, null, "T4 bindings 指向不存在的变量 → 解析失败");
    ok(hasLine(r.errors, "bindings.n1 引用了不存在的变量 $nope"),
      "T4 文案与 §5 的表一致：`bindings.n1 引用了不存在的变量 $nope`");
  }
  {
    // 数字字段的漂移（card.radius）—— 证明漂移检查不是只对颜色生效
    const root = mkRoot({
      tokens: [{ id: "tk_r", name: "radius", type: "number", value: 12 }],
      modes: [], activeMode: "",
      bindings: { n2: { "card.radius": "$radius" } },
    });
    root.nodes[1].card.radius = 30;
    const r = parse(root);
    eq(r.errors.length, 0, "T4 数字字段漂移同样只给警告");
    ok(hasLine(r.warnings, "n2 的 card.radius 在 nodes 里是 30", "（= 12）", "已按 bindings 重建"),
      "T4 数字字段的漂移文案正确");
    eq(tool.resolveDesign(r.design).nodes[1].card.radius, 12, "T4 数字字段同样以 bindings 为准");
  }

  // ============================================================ 6) T8 只存差异 + 模式回落
  console.log("\n=== 6. T8 `values` 只存差异（删掉覆盖 → 回落 token.value） ===");

  {
    const r = parse(mkRoot({
      tokens: [{ id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" }],
      modes: [
        { id: "m_neon", name: "霓虹赛道", values: { tk_accent: "#FF0000" } },
        { id: "m_ice", name: "冰川科技", values: {} },
      ],
      activeMode: "m_neon",
    }));
    eq(r.errors.length, 0, "T8 样本合法");
    eq(tool.resolveDesign(r.design).themeColors.accent, "#FF0000", "T8 模式覆盖生效");
    // 删掉这条覆盖 → 回落 token.value
    r.design.modes[0].values = {};
    eq(tool.resolveDesign(r.design).themeColors.accent, "#FF8A00",
      "T8 删掉模式的覆盖 → 回落到 token.value（#FF8A00）");
    // 切到没有覆盖的模式 → 同样回落
    r.design.activeMode = "m_ice";
    eq(tool.resolveDesign(r.design).themeColors.accent, "#FF8A00", "T8 切到空模式 → 同样回落默认值");
  }

  // ============================================================ 6b) 共享引用（任务 1）
  console.log("\n=== 6b. `nodes` 与 `pages[].nodes` 的共享引用：bindings 必须**两处都生效** ===");

  // 内存里的不变式（model.js createDesign / switchPage 维护）：
  //     design.nodes === design.pages[design.pageIndex].nodes
  // `deepCloneJson` 会把它拆成两份，于是 bindings 只落进其中一份 ——
  // 上一轮探针实测：d.nodes[0].font.color=#FF0000，pages[0].nodes[0].font.color=#123456。
  // 这条不变式是"多页面不用改几千处代码"的全部依据，所以**解析视图必须把它接回来**。
  function aliasRoot() {
    const t = (id, text) => ({
      id: id, type: "text", name: text, x: 10, y: 10, w: 120, h: 30,
      text: text, font: { family: "sans", size: 8, weight: 700, align: "center", color: "#123456" },
    });
    return {
      schema: "icar.ui/2",
      meta: { name: "别名" },
      canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
      theme: "neon",
      pages: [
        { id: "pg0", name: "主页面", nodes: [t("n1", "第一页")] },
        { id: "pg1", name: "第二页", nodes: [t("n9", "第二页")] },
      ],
      tokens: [
        { id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" },
        { id: "tk_t", name: "title", type: "string", value: "绑定来的" },
      ],
      modes: [{ id: "m_neon", name: "霓虹赛道", values: {} }],
      activeMode: "m_neon",
      bindings: { n1: { "font.color": "$accent", "text": "$title" }, n9: { "font.color": "$accent" } },
    };
  }

  {
    const r = parse(aliasRoot());
    eq(r.errors.length, 0, "6b 样本本身合法（0 错误）");
    // 解析出来的 design 满足不变式（**同一个数组引用**，不是"内容相同"）
    eq(r.design.nodes === r.design.pages[0].nodes, true,
      "6b 解析后的 design：`nodes` 与 `pages[0].nodes` 是**同一个数组**（不变式的前提）");
    eq(r.design.nodes === r.design.pages[1].nodes, false, "6b 第二页是**另一个**数组（不许被接成一份）");

    const v = tool.resolveDesign(r.design);
    // ① 引用也被接回来（不然 bindings 只写进一份）
    eq(v.nodes === v.pages[0].nodes, true,
      "6b **任务 1 的核心断言**：解析视图里 `nodes` 与 `pages[0].nodes` 仍是同一个数组");
    // ② 两处都拿到解析后的字面值
    eq(v.nodes[0].font.color, "#FF8A00", "6b `nodes[0].font.color` 被解析成字面值");
    eq(v.pages[0].nodes[0].font.color, "#FF8A00",
      "6b **`pages[0].nodes[0].font.color` 同样被解析**（上一轮就是这里漏了，探针实测是 #123456）");
    eq(v.pages[0].nodes[0].text, "绑定来的", "6b 同一份数组上的 `text` 绑定也生效");
    // ③ 第二页的节点在**它自己那份数组**上被解析（索引是全局的，不是只索引当前页）
    eq(v.pages[1].nodes[0].font.color, "#FF8A00", "6b 非当前页的节点同样按 bindings 字面化");
    // ④ 原 design 一个字都没改（视图 ≠ 真相）
    eq(r.design.nodes[0].font.color, "#123456", "6b 原 design 的 nodes 没被改动");
    eq(r.design.pages[0].nodes[0].font.color, "#123456", "6b 原 design 的 pages 也没被改动");
  }
  {
    // ---- 反向：别名一旦拆开（`app.js` 的 `newDesign` / `applyPreset` 就是这么干的：
    //      直接 `d.nodes = 新数组`，没有同步 `pages[0].nodes`），解析视图必须**以 nodes 为准**
    //
    // 为什么这条必须钉死：反过来让 pages 赢的话，新建 / 套预设之后 `resolveDesign`
    // 会返回**空节点树** —— 第 5 步把画布接上去之后，画布直接变白。
    const r = parse(aliasRoot());
    const stale = r.design.pages[0].nodes;               // 落后的那一份
    r.design.nodes = [{                                  // 模拟 applyPreset
      id: "n5", type: "text", name: "预设", x: 1, y: 2, w: 100, h: 20,
      text: "预设节点", font: { family: "sans", size: 8, weight: 700, align: "center", color: "#000000" },
    }];
    r.design.bindings = { n5: { "font.color": "$accent" } };

    const v = tool.resolveDesign(r.design);
    eq(v.nodes.length, 1, "6b 别名被拆开时：以 `nodes` 为准（不是落后空页）");
    eq(v.nodes[0].id, "n5", "6b 拿到的是新节点");
    eq(v.pages[0].nodes === v.nodes, true, "6b 解析视图把别名**修好了**（两处都是新那份）");
    eq(v.pages[0].nodes[0].font.color, "#FF8A00", "6b 新节点上的绑定生效（导出时不会再写成旧值）");
    eq(stale.length, 1, "6b（前置）原 design 里那份落后的 pages[0].nodes 确实还是旧的");
    eq(r.design.pages[0].nodes === stale, true, "6b 原 design 没被就地修改（只有视图被修好）");
  }
  {
    // ---- `$$$$100` 现在只是一个**普通字面串**（转义取消后没有任何一层会改写它）
    //
    // 这条以前钉的是"同一份数组只能反转义一次"（`$$$$100` → `$$$100`，解两次会变 `$$100`）。
    // 转义取消后那个坑不存在了，但**这条断言仍然值得留着**：它钉的是
    // "解析视图不碰 `text`" —— 哪天有人再加一层文本处理，这里会立刻红。
    const root = aliasRoot();
    root.pages[0].nodes[0].text = "$$$$100";
    delete root.bindings.n1["text"];                     // 别让绑定把 text 覆盖掉
    const r = parse(root);
    eq(r.errors.length, 0, "6b `$$$$100` 样本：0 错误");
    eq(tool.resolveDesign(r.design).pages[0].nodes[0].text, "$$$$100",
      "6b `$$$$100` **一个字符都不变**（`text` 是纯字面值，画布 / 导出 / App 三边一致）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$$$$100", "6b `nodes` 那一份同样原样");
  }
  {
    // ---- 容错：没有 `pages` 的 design（手搭的对象 / 老调用方）不许炸
    const r = parse(aliasRoot());
    delete r.design.pages;
    const v = tool.resolveDesign(r.design);
    eq(v.nodes[0].font.color, "#FF8A00", "6b 没有 `pages` 时照常解析 `nodes`（不抛异常）");
    eq(v.pages === undefined, true, "6b 没有 `pages` 时不凭空造一个出来（视图与输入同形）");
  }

  // ============================================================ 7) 坏输入不炸
  console.log("\n=== 7. 坏输入：报得出来、不炸、不写坏 themeColors ===");

  {
    const r = parse(mkRoot({ tokens: "不是数组" }));
    eq(r.design, null, "7 `tokens` 不是数组 → 硬错误");
    ok(hasLine(r.errors, "`tokens` 必须是数组"), "7 文案：`tokens` 必须是数组");
  }
  {
    const r = parse(mkRoot({ tokens: [{ name: "没有id", type: "color", value: "#FF8A00" }] }));
    eq(r.design, null, "7 变量缺 id → 硬错误（变量靠 id 被引用）");
    ok(hasLine(r.errors, "tokens[0] 缺少 `id`"), "7 文案指出了位置");
  }
  {
    const r = parse(mkRoot({ tokens: [{ id: "a", type: "color", value: "#FF8A00" }, { id: "a", type: "color", value: "#FF0000" }] }));
    ok(hasLine(r.errors, "tokens[1] 的 id `a` 与前面的变量重复"), "7 变量 id 重复 → 硬错误");
  }
  {
    const r = parse(mkRoot({ tokens: [{ id: "@bad", name: "x", type: "color", value: "#FF8A00" }] }));
    ok(hasLine(r.errors, "不能以 `@` 开头"), "7 变量 id 不许用 `@` 前缀（那是 modes 的保留前缀）");
  }
  {
    // 内置变量值被写坏 → **警告** + 解析时跳过（回落内置主题的同名色）→ themeColors 仍然合法
    const r = parse(mkRoot({
      tokens: [{ id: "tk_accent", name: "accent", type: "color", value: "#abc", builtin: "accent" }],
      modes: [], activeMode: "",
    }));
    eq(r.errors.length, 0, "7 内置变量值非法 → 不是硬错误（不拦文件）");
    ok(hasLine(r.warnings, "内置变量", "不是 `#RRGGBB`", "回落内置主题的同名色"), "7 警告说清了后果与处理");
    eq(tool.resolveDesign(r.design).themeColors.accent, tool.GAUGE_THEMES.neon.accent,
      "7 坏值被跳过 → themeColors.accent 回落到内置主题色（跨语言契约没被写坏）");
  }
  {
    const r = parse(mkRoot({
      tokens: [{ id: "tk_a", name: "accent", type: "color", value: "#FF8A00" }],
      modes: [{ id: "m1", name: "一号", values: { "tk_nope": "#FF0000", "@accent": "#000000", "tk_a": "#00FF00" } }],
      activeMode: "m1",
    }));
    ok(hasLine(r.warnings, "modes[0].values 里的 `tk_nope` 不是任何变量"), "7 modes 里不认识的变量 → 警告");
    ok(hasLine(r.warnings, "`accent` 不是已知的主题字段"), "7 `@` 覆盖了不认识的 themeColors 字段 → 警告");
    eq(r.errors.length, 0, "7 这些都不拦文件（模式里写错不影响 nodes）");
  }
  {
    const r = parse(mkRoot({
      tokens: [{ id: "tk_a", name: "accent", type: "color", value: "#FF8A00" }],
      modes: [{ id: "m1", name: "一号", values: {} }],
      activeMode: "m_nope",
    }));
    ok(hasLine(r.warnings, "`activeMode` = `m_nope` 在 `modes` 里找不到"), "7 activeMode 指向不存在的模式 → 警告");
  }
  {
    const r = parse(mkRoot({ bindings: { n1: { "pid": "$accent", "font.size": "$x", "font.color": "accent" } } }));
    ok(hasLine(r.warnings, "bindings.n1.pid 不在可绑定白名单里"), "7 白名单外的字段（pid）→ 警告 + 忽略");
    ok(hasLine(r.warnings, "bindings.n1.font.size 不在可绑定白名单里"), "7 白名单外的字段（font.size）→ 警告 + 忽略");
    ok(hasLine(r.warnings, "bindings.n1.font.color 的值 accent 不是变量引用"), "7 不是 `$` 开头的值 → 警告 + 忽略");
    eq(r.errors.length, 0, "7 白名单外的绑定不拦文件");
  }
  {
    const r = parse(mkRoot({ bindings: { n2: { "@component": "c1", "@variant": "v1" } } }));
    ok(hasLine(r.warnings, "是阶段 2 的组件血缘字段 —— 本版本不解析"), "7 阶段 2 的 @component/@variant → 如实警告（不静默收下）");
    eq(JSON.stringify(r.design.bindings), "{}", "7 阶段 2 字段没有进内存里的 bindings");
  }
  {
    const r = parse(mkRoot({ bindings: "不是对象" }));
    ok(hasLine(r.warnings, "`bindings` 必须是一个对象"), "7 `bindings` 不是对象 → 警告 + 忽略整段（不拦文件）");
    eq(r.errors.length, 0, "7 bindings 结构错不拦文件");
  }

  // ============================================================ 8) 反向验证总表
  console.log("\n=== 8. 反向验证：故意破坏 → 必须报（健康样本 → 必须不报） ===");

  {
    // 健康：字面值 + 一致的绑定
    const healthy = mkRoot({
      tokens: [{ id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" }],
      modes: [{ id: "m_neon", name: "霓虹赛道", values: {} }], activeMode: "m_neon",
      bindings: { n1: { "font.color": "$accent" } },
    });
    const h = parse(healthy);
    eq(h.errors.length, 0, "反向·健康样本：0 错误");
    eq(h.warnings.length, 0, "反向·健康样本：0 警告");

    // 破坏 1：把 `$` 写进 nodes（并删掉那条绑定）
    const broke1 = JSON.parse(JSON.stringify(healthy));
    broke1.nodes[0].font.color = "$accent";
    delete broke1.bindings.n1["font.color"];
    const b1 = parse(broke1);
    eq(b1.design, null, "反向·破坏 1（`$` 进了 nodes）：必须报**硬错误**并拒绝加载");
    ok(hasLine(b1.errors, "引用不能写在 nodes 里"), "反向·破坏 1：错误文案明确");

    // 破坏 2：让 nodes 与 bindings 漂移
    const broke2 = JSON.parse(JSON.stringify(healthy));
    broke2.nodes[0].font.color = "#123456";
    const b2 = parse(broke2);
    eq(b2.errors.length, 0, "反向·破坏 2（漂移）：**不是**错误");
    eq(b2.design === null, false, "反向·破坏 2：文件照常打开");
    ok(hasLine(b2.warnings, "已按 bindings 重建"), "反向·破坏 2：必须报**警告**");
    eq(tool.resolveDesign(b2.design).nodes[0].font.color, "#FF8A00", "反向·破坏 2：以 bindings 为准");

    // 破坏 3：把 `$` 写进 **text**（并删掉那条绑定）→ **警告**，文件必须照常打开
    const broke3 = JSON.parse(JSON.stringify(healthy));
    broke3.nodes[0].text = "$PID";
    const b3 = parse(broke3);
    eq(b3.errors.length, 0, "反向·破坏 3（`$` 进了 text）：**不是**错误");
    eq(b3.design === null, false, "反向·破坏 3：**文件照常打开**（与破坏 1 的颜色字段形成对照）");
    ok(hasLine(b3.warnings, "nodes[0].text 是 `$PID`", "bindings 里没有这条"), "反向·破坏 3：必须报**警告**");
    ok(hasLine(b3.warnings, "不用管这条"), "反向·破坏 3：警告说清「想显示字面内容就什么都不用做」");
    eq(b3.warnings.some(w => w.indexOf("$$") >= 0), false,
      "反向·破坏 3：⚠️ 文案里**不许再出现 `$$`**（那句话在教用户写出设备显示错的文件）");
    eq(tool.resolveDesign(b3.design).nodes[0].text, "$PID",
      "反向·破坏 3：**按原样显示 `$PID`**（不猜用户意图，也不改写）");

    // 健康对照：**真的**想绑定 → 加一条 bindings 条目，警告就不该有了
    //
    // （v2.80.1 这里对照的是"写成 `$$PID`"—— 那条路已取消：它会让设备显示 `$$PID`。）
    const broke3fixed = JSON.parse(JSON.stringify(healthy));
    broke3fixed.tokens = [{ id: "tk_p", name: "PID", type: "string", value: "$PID" }];
    broke3fixed.bindings = { n1: { "text": "$PID" } };
    const b3f = parse(broke3fixed);
    eq(b3f.errors.length, 0, "反向·破坏 3 的**正确写法**（加绑定）：0 错误");
    eq(b3f.warnings.filter(w => w.indexOf("bindings 里没有这条") >= 0).length, 0,
      "反向·破坏 3 的**正确写法**：0 条「没有绑定」警告");
    eq(tool.resolveDesign(b3f.design).nodes[0].text, "$PID",
      "反向·破坏 3 的**正确写法**：显示 `$PID`（绑定来的值）");
  }

  // ============================================================ 汇总
  console.log("\n" + "=".repeat(60));
  console.log("PASS=" + pass + "  FAIL=" + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log("\n套件自己崩了：" + (e && e.stack || e));
  console.log("PASS=" + pass + "  FAIL=" + (fail + 1));
  process.exit(1);
});
