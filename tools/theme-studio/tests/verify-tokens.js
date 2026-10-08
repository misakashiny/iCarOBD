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
      + **`$$` 转义**）  T4 漂移（警告不是错误，且**以 bindings 为准**）
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

  // ============================================================ 3) T2 向后兼容
  console.log("\n=== 3. T2 老文件行为完全不变（且**不写出**新顶层键） ===");

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

    // 最硬的一条：**不写出任何新顶层键**（这才是"App 侧一行都不用改"的凭据）
    const out = JSON.parse(tool.toV2Json(r.design));
    ["tokens", "modes", "activeMode", "bindings"].forEach(k => {
      eq(Object.prototype.hasOwnProperty.call(out, k), false, "T2 导出的 JSON 里没有 `" + k + "`（第 4 步才写）");
    });
    // 即使内存里的 design **有**变量系统，本轮也照样不写出（第 4 步刻意不做）
    const d2 = migrate(JSON.parse(JSON.stringify(r.design)));
    eq(d2.tokens.length, 12, "（前置）迁移后内存里确实有 12 个变量");
    const out2 = JSON.parse(tool.toV2Json(d2));
    eq(Object.prototype.hasOwnProperty.call(out2, "tokens"), false,
      "T2 即便 design 里有 tokens，本轮也**不写出** —— 对 App 与存量文件零影响");
    deepEq(out2.themeColors, out.themeColors, "T2 迁移前后 toV2Json 的 themeColors 也逐字段相同");
  }

  // ============================================================ 4) T3 `$` 防线
  console.log("\n=== 4. T3 `$` 防线（颜色/数值硬错误 + `text` 警告 + `$$` 转义） ===");

  eq(tool.normalizeFont({ color: "$accent" }).color, "$accent",
    "T3 normalizeFont 对 `$accent` **原样保留**（不回落默认色）");
  eq(tool.normalizeFont({ color: "$tk1" }).color, "$tk1", "T3 按 id 的引用同样保留");
  eq(tool.normalizeFont({ color: "$$accent" }).color, "$$accent",
    "T3 **颜色**上的 `$$` 不是转义 —— 原样保留（转义只在 `text` 上识别）");
  eq(tool.normalizeFont({ color: "#abc" }).color, tool.FONT_DEFAULT.color,
    "T3 真正非法的颜色**仍然**回落默认色（防线只放过 `$`，没有放宽其它）");
  eq(tool.normalizeFont({}).color, tool.FONT_DEFAULT.color, "T3 缺字段仍然回落默认色");
  eq(tool.normalizeFont({ color: "#FF8A00" }).color, "#FF8A00", "T3 合法颜色不受影响");

  // ---- `$$` 转义助手（纯函数，先把规则本身钉死，后面才谈"校验怎么用")
  eq(tool.unescapeTextDollar("$$100"), "$100", "T3 `$$100` → `$100`（开头的 `$$` 是一个字面 `$`）");
  eq(tool.unescapeTextDollar("$$"), "$", "T3 `$$` → `$`");
  eq(tool.unescapeTextDollar("$$$100"), "$$100",
    "T3 `$$$100` → `$$100`（只认最开头那一对，**不做二次解释**）");
  eq(tool.unescapeTextDollar("$100"), "$100", "T3 单个 `$` **不是**转义（仍是引用语法）");
  eq(tool.unescapeTextDollar("a$$b"), "a$$b", "T3 **不在开头**的 `$$` 不转义");
  eq(tool.unescapeTextDollar("转速"), "转速", "T3 没有 `$` 的文本原样返回");
  eq(tool.unescapeTextDollar(123), 123, "T3 非字符串原样返回（不炸）");
  eq(tool.isTextTokenRef("$accent"), true, "T3 `$accent` 在 `text` 上仍是引用");
  eq(tool.isTextTokenRef("$$100"), false, "T3 `$$100` 在 `text` 上**不是**引用（它是转义）");
  eq(tool.isTokenRef("$$100"), true,
    "T3 但 [isTokenRef] 的判据没变 —— `$$100` 在**颜色/数值**上仍然算引用（只放过 `text`）");

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
    ok(hasLine(r.warnings, "请写成 `$$100`"),
      "T3 警告给出了**字面 `$` 的出路**：写成 `$$100`（把用户原来的串原样带上，直接抄）");
    ok(hasLine(r.warnings, "如果是要绑定变量", "bindings 条目"),
      "T3 警告给出了**绑定的出路**：加 bindings 条目（只给一条出路等于没给）");
    ok(hasLine(r.warnings, "文件照常打开"), "T3 警告明确告诉用户「文件照常打开」（不吓人）");
    eq(r.design.nodes[0].text, "$100", "T3 解析后 design 里**原样保留** `$100`（不解开、不改写）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$100",
      "T3 没有绑定 → resolveDesign 也原样显示 `$100`（不猜用户意图）");
  }
  {
    // ---- `$$` 转义：`$$100` → `$100`，而且**不该有警告**（它是合法的字面 `$`）
    const root = mkRoot();
    root.nodes[0].text = "$$100";
    const r = parse(root);
    eq(r.errors.length, 0, "T3 `$$100` → 0 错误");
    eq(r.warnings.length, 0, "T3 `$$100` → **0 警告**（它是转义，不是「忘了加绑定」）");
    eq(r.design.nodes[0].text, "$$100", "T3 design 里保留文件里的原样 `$$100`（存盘必须逐字节稳定）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$100", "T3 resolveDesign 解开成 `$100`（画布显示这个）");
    eq(JSON.parse(tool.toV2Json(r.design)).nodes[0].text, "$$100",
      "T3 导出回文件仍然是 `$$100` —— 「存一次退一步」的坑不存在");
  }
  {
    const root = mkRoot();
    root.nodes[0].text = "$$";
    const r = parse(root);
    eq(r.errors.length, 0, "T3 单独一个 `$$` → 0 错误");
    eq(r.warnings.length, 0, "T3 `$$` 也不警告");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$", "T3 `$$` → `$`");
  }
  {
    // ---- 反向：转义**只**在 `text` 上。颜色上的 `$$` 仍然是硬错误
    const root = mkRoot();
    root.nodes[0].font.color = "$$accent";
    const r = parse(root);
    eq(r.design, null, "T3 颜色字段上的 `$$accent` **仍是硬错误**（颜色不可能有字面 `$`，`$$` 在那里没意义）");
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
    // ---- 漂移比较用**显示值**：nodes 里 `$$100` 与变量值 `$100` 显示相同 → **不报漂移**
    const root = mkRoot({
      tokens: [{ id: "tk_t", name: "title", type: "string", value: "$100" }],
      bindings: { n1: { "text": "$title" } },
    });
    root.nodes[0].text = "$$100";
    const r = parse(root);
    eq(r.errors.length, 0, "T3 转义 + 绑定：0 错误");
    eq(r.warnings.length, 0,
      "T3 `$$100` 与变量值 `$100` **显示完全相同** → 不报漂移（假警告比不报更伤：用户会去改一个本来对的地方）");
    eq(tool.resolveDesign(r.design).nodes[0].text, "$100",
      "T3 解析后 text = `$100`（转义解开 + 绑定写值，两条路结果一致）");
  }
  {
    // 反向：**真的**不同（`$$100` 显示 `$100`，变量是「转速」）→ 漂移必须照报
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
    ok(hasLine(b3.warnings, "请写成 `$$PID`"), "反向·破坏 3：警告给出 `$$` 转义这条出路");

    // 健康对照：同样想显示字面 `$`，**用转义写** → 一条警告都不该有
    const broke3fixed = JSON.parse(JSON.stringify(broke3));
    broke3fixed.nodes[0].text = "$$PID";
    const b3f = parse(broke3fixed);
    eq(b3f.errors.length, 0, "反向·破坏 3 的**正确写法**：0 错误");
    eq(b3f.warnings.length, 0, "反向·破坏 3 的**正确写法**：0 警告（转义是合法内容，不该被打扰）");
    eq(tool.resolveDesign(b3f.design).nodes[0].text, "$PID", "反向·破坏 3 的**正确写法**：显示 `$PID`");
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
