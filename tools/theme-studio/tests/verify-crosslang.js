/* ==========================================================================
   verify-studio.js —— 跨语言一致性检查
   --------------------------------------------------------------------------
   **做法**：直接加载工具的真实 js 文件（在沙箱里跑），并从 Kotlin 源码里
   **解析出常量**，逐条比对。不是"看一眼觉得一样"。

   为什么必须存在：编辑器和 App 是两套实现，一旦分叉，症状是
   「编辑器说没问题、App 加载报错」—— 那是这个项目最该避免的一类 bug。

   跑法：node tools/verify-studio.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ⚠️ 本文件在 tools/theme-studio/tests/ 下，要**上跳三级**才到仓库根。
// 第一版放在 tools/ 下时是 ".."，搬进 tests/ 后必须同步改 —— 否则读不到 Kotlin 源码。
const ROOT = path.resolve(__dirname, "..", "..", "..");
const STUDIO = path.join(ROOT, "tools", "theme-studio");
const KOTLIN = path.join(ROOT, "app", "src", "main", "java", "com", "icar", "obd");

let pass = 0, fail = 0;
const notes = [];
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? "" : `（工具 ${JSON.stringify(a)} vs App ${JSON.stringify(b)}）`));
}
function note(msg) { notes.push(msg); }

function read(p) { return fs.readFileSync(p, "utf8"); }

// ================================================================ 1) 加载工具

/** 在沙箱里加载工具的 js（IIFE + window.X = ...），拿到它真实的常量与函数 */
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
    // 浏览器桩：只提供工具真正用到的那几个
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
  // 顺序与 index.html 一致（schema → model → validate）
  ["schema.js", "model.js", "validate.js"].forEach(f => {
    vm.runInContext(read(path.join(STUDIO, "js", f)), sandbox, { filename: f });
  });
  return sandbox;
}

const tool = loadTool();

// ================================================================ 2) 解析 Kotlin

const designFileKt = read(path.join(KOTLIN, "data", "DesignFile.kt"));
const builtInKt = read(path.join(KOTLIN, "data", "BuiltInPids.kt"));
const pidModelsKt = read(path.join(KOTLIN, "data", "PidModels.kt"));
const dashLayoutKt = read(path.join(KOTLIN, "data", "DashLayout.kt"));
const valueLabelsKt = read(path.join(KOTLIN, "data", "ValueLabels.kt"));

/**
 * 取 Kotlin 的字符串常量。
 * ⚠️ 必须带 `m` 标志：不带的话 `$` 只匹配整个文件末尾，永远取不到值
 * （第一版就栽在这里，报了一堆"App null"的假失败）。
 */
function kotlinConst(src, name) {
  const m = new RegExp("const val " + name + "\\s*=\\s*\"([^\"]+)\"", "m").exec(src);
  return m ? m[1].trim() : null;
}

/** 取 Kotlin 的数值常量（允许 360f 这种带后缀的） */
function kotlinConstAny(src, name) {
  const m = new RegExp("const val " + name + "\\s*=\\s*(-?[\\d.]+)f?", "m").exec(src);
  return m ? Number(m[1]) : null;
}

/**
 * 取 Kotlin 里用**表达式**定义的常量（如 `MIN_SIZE = 2 * STEP`）。
 * 只认 `数字 * 名字` 这一种形式 —— 够用，且不做通用表达式求值（那容易悄悄算错）。
 */
function kotlinConstExpr(src, name, resolve) {
  const m = new RegExp("const val " + name + "\\s*=\\s*(\\d+)\\s*\\*\\s*(\\w+)", "m").exec(src);
  if (!m) return null;
  const base = resolve(m[2]);
  return base === null || base === undefined ? null : Number(m[1]) * base;
}

/** 从 PID_ALIASES 的 mapOf(...) 块里抽别名 */
function parseKotlinAliases(src) {
  const i = src.indexOf("val PID_ALIASES");
  if (i < 0) return null;
  const j = src.indexOf("mapOf(", i);
  let depth = 0, end = -1;
  for (let k = src.indexOf("(", j); k < src.length; k++) {
    if (src[k] === "(") depth++;
    else if (src[k] === ")") { depth--; if (depth === 0) { end = k; break; } }
  }
  const body = src.slice(j, end);
  const out = {};
  const re = /"([^"]+)"\s+to\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2];
  return out;
}

/** 从 BuiltInPids 的 std(...) / calc(...) 调用里抽量程与阈值 */
function parseKotlinPids(src) {
  const out = {};
  // std("0C", "名字", "公式", "单位", min, max, [warnLow = Xf,] [warnHigh = Yf,] ...)
  const re = /std\(\s*"([0-9A-Fa-f]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(-?[\d.]+)f\s*,\s*(-?[\d.]+)f([^)]*)\)/g;
  let m;
  while ((m = re.exec(src))) {
    const tail = m[7] || "";
    const wl = /warnLow\s*=\s*(-?[\d.]+)f/.exec(tail);
    const wh = /warnHigh\s*=\s*(-?[\d.]+)f/.exec(tail);
    out["std_" + m[1].toUpperCase()] = {
      name: m[2], unit: m[4], formula: m[3],
      min: Number(m[5]), max: Number(m[6]),
      warnLow: wl ? Number(wl[1]) : null,
      warnHigh: wh ? Number(wh[1]) : null,
    };
  }
  // calc("key", "名字", "单位", min, max, [warnHigh = Xf,])
  const re2 = /calc\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*(-?[\d.]+)f\s*,\s*(-?[\d.]+)f([^)]*)\)/g;
  while ((m = re2.exec(src))) {
    const wh = /warnHigh\s*=\s*(-?[\d.]+)f/.exec(m[6] || "");
    out[m[1]] = {
      name: m[2], unit: m[3], formula: "A",   // calc 的公式固定是 A
      min: Number(m[4]), max: Number(m[5]),
      warnLow: null,
      warnHigh: wh ? Number(wh[1]) : null,
    };
  }
  return out;
}

/**
 * 从 BuiltInPids 的 `MANUFACTURER_TEMPLATES` 里抽厂家模板（v2.67.0 新增）。
 *
 * ## 为什么之前漏了
 *
 * `parseKotlinPids` 只认 `std(...)` / `calc(...)` —— 而厂家模板写的是
 * **完整的 `PidDefinition(...)`**（因为字段不一样：protocol / mode / pid / enabled）。
 *
 * 后果：工具侧 `BUILTIN_PIDS` 里的 `tpl_*` 永远被报成"App 侧没有" ——
 * 而那是**测试的覆盖缺口**，不是真的不对称。
 *
 * ⚠️ 这个缺口会让两侧的模板**慢慢漂移**（一边改了量程，测试不红）。
 */
function parseKotlinTemplates(src) {
  const out = {};
  // PidDefinition(
  //     id = "tpl_xxx", name = "...", protocol = "CAN", mode = "22", pid = "1234",
  //     formula = "...", unit = "...", minVal = -40f, maxVal = 180f,
  //     warnLow = Xf, warnHigh = Yf, enabled = false, ...
  // )
  // ⚠️ **不能跨条目**（v2.67.0 踩过）。
  //
  // 第一版写的是 `[\s\S]*?`，结果 `std()` 辅助函数里的那个 `PidDefinition(`（`id = "std_$pid"`）
  // 会一路懒匹配到**第一个真实的 minVal**（在 tpl_oilPressure 里）——
  // 那个匹配的 id 是 `std_$pid`（被 `^tpl_` 过滤掉），而 **tpl_oilPressure 被吃掉了**。
  //
  // 症状：报"工具里多出 tpl_oilPressure"，看起来像 App 侧漏加，其实是**解析器漏读**。
  //
  // 修法：用负向先行断言，确保 `id = "..."` 到 `minVal` 之间**不再出现 `PidDefinition(`**。
  const re = /PidDefinition\(\s*id\s*=\s*"([^"]+)"(?:(?!PidDefinition\()[\s\S])*?minVal\s*=\s*(-?[\d.]+)f\s*,\s*maxVal\s*=\s*(-?[\d.]+)f((?:(?!PidDefinition\()[\s\S])*?)\)\s*,/g;
  let m;
  while ((m = re.exec(src))) {
    const id = m[1];
    if (!/^tpl_/.test(id)) continue;
    const body = m[0];
    const nm = /name\s*=\s*"([^"]*)"/.exec(body);
    const un = /unit\s*=\s*"([^"]*)"/.exec(body);
    const fm = /formula\s*=\s*"([^"]*)"/.exec(body);
    const wl = /warnLow\s*=\s*(-?[\d.]+)f/.exec(body);
    const wh = /warnHigh\s*=\s*(-?[\d.]+)f/.exec(body);
    out[id] = {
      name: nm ? nm[1] : "",
      unit: un ? un[1] : "",
      formula: fm ? fm[1] : "",
      min: Number(m[2]), max: Number(m[3]),
      warnLow: wl ? Number(wl[1]) : null,
      warnHigh: wh ? Number(wh[1]) : null,
    };
  }
  return out;
}

// ================================================================ 3) 常量比对

console.log("\n=== 1. 基础常量 ===");
{
  const kSchema = kotlinConst(designFileKt, "SCHEMA");
  eq(tool.SCHEMA_V1, kSchema, "v1 schema 字符串");
  // CANVAS 定义在 PidModels.kt（不在 DesignFile.kt）
  const kCanvas = kotlinConstAny(pidModelsKt, "CANVAS");
  eq(tool.CANVAS, kCanvas, "画布单位 CANVAS（PidModels.kt）");
  eq(tool.MAX_GAUGES, kotlinConstAny(designFileKt, "MAX_GAUGES"), "v1 仪表上限 MAX_GAUGES");

  // DashLayout.Drag：GRID / STEP / MIN_SIZE
  const grid = kotlinConstAny(dashLayoutKt, "GRID");
  eq(tool.GRID, grid, "网格 GRID");
  const kStep = kotlinConstAny(dashLayoutKt, "STEP");
  if (kStep !== null) eq(tool.STEP, kStep, "吸附步长 STEP（DashLayout.kt 直接写的数值）");
  else eq(tool.STEP, tool.CANVAS / tool.GRID, "吸附步长 STEP = CANVAS / GRID（Kotlin 侧是表达式）");

  const minSize = kotlinConstExpr(dashLayoutKt, "MIN_SIZE", n =>
    n === "STEP" ? tool.STEP : kotlinConstAny(dashLayoutKt, n));
  if (minSize !== null) eq(tool.MIN_SIZE, minSize, "最小尺寸 MIN_SIZE（Kotlin 侧 = 2 * STEP）");
  else note("DashLayout.kt 的 MIN_SIZE 不是「数字 * 名字」形式，工具侧的 30 未做跨语言校验");

  // P9「非数值 PID 模型」方向 A：数值 → 文字映射表的上限
  eq(tool.VALUE_LABELS_MAX, kotlinConstAny(valueLabelsKt, "MAX"),
    "映射表上限 VALUE_LABELS_MAX（ValueLabels.kt）");
}

console.log("\n=== 2. PID 别名表 ===");
{
  const kAliases = parseKotlinAliases(designFileKt);
  const tAliases = tool.PID_ALIASES;
  ok(kAliases && Object.keys(kAliases).length > 0,
    `从 DesignFile.kt 解析到 ${kAliases ? Object.keys(kAliases).length : 0} 条别名`);
  const tk = Object.keys(tAliases), kk = Object.keys(kAliases);
  eq(tk.length, kk.length, "别名条数一致");

  const onlyTool = tk.filter(k => !(k in kAliases));
  const onlyKotlin = kk.filter(k => !(k in tAliases));
  ok(onlyTool.length === 0, "没有工具独有、App 不认的别名" +
    (onlyTool.length ? "：缺 " + onlyTool.join(", ") : ""));
  ok(onlyKotlin.length === 0, "没有 App 有、工具漏掉的别名" +
    (onlyKotlin.length ? "：缺 " + onlyKotlin.join(", ") : ""));

  let mismatch = 0;
  const bad = [];
  kk.forEach(k => {
    if (tAliases[k] !== kAliases[k]) { mismatch++; bad.push(`${k}: 工具→${tAliases[k]} App→${kAliases[k]}`); }
  });
  ok(mismatch === 0, "每条别名的目标 PID 都一致" + (bad.length ? "：" + bad.slice(0, 5).join("; ") : ""));
}

console.log("\n=== 3. 内置 PID 量程与报警阈值 ===");
{
  const kPids = Object.assign({}, parseKotlinPids(builtInKt), parseKotlinTemplates(builtInKt));
  const tPids = tool.BUILTIN_PIDS;
  ok(Object.keys(kPids).length > 0,
    `从 BuiltInPids.kt 解析到 ${Object.keys(kPids).length} 个 PID`);

  const bad = [];
  let checked = 0;
  Object.keys(kPids).forEach(id => {
    const k = kPids[id], t = tPids[id];
    if (!t) { bad.push(id + ": 工具里没有"); return; }
    checked++;
    const f = (v) => (v === null || v === undefined) ? null : Math.round(v * 1000) / 1000;
    if (f(t.min) !== f(k.min)) bad.push(`${id} min 工具${t.min} App${k.min}`);
    if (f(t.max) !== f(k.max)) bad.push(`${id} max 工具${t.max} App${k.max}`);
    if (f(t.warnHigh) !== f(k.warnHigh)) bad.push(`${id} warnHigh 工具${t.warnHigh} App${k.warnHigh}`);
    if (f(t.warnLow) !== f(k.warnLow)) bad.push(`${id} warnLow 工具${t.warnLow} App${k.warnLow}`);
    // ⚠️ **名字和单位也要比**（v2.68.0 加）。
    //
    // 之前只比量程/阈值 —— 于是"两边名字不一样"这种漂移测不出来，
    // 而后果很直接：**用户在设计器里看到的名字，和 App 里显示的不一样**。
    //
    // 单位同理：单位错了数值就是错的（0.1 vs 0.01 差 10 倍）。
    // 归一化：去空格 + 全角括号转半角（工具侧历史上有两种写法）
    const norm = s => String(s === undefined || s === null ? "" : s)
      .replace(/\s+/g, "").replace(/（/g, "(").replace(/）/g, ")");
    if (norm(t.name) !== norm(k.name)) bad.push(`${id} 名字 工具「${t.name}」App「${k.name}」`);
    if (norm(t.unit) !== norm(k.unit)) bad.push(`${id} 单位 工具「${t.unit}」App「${k.unit}」`);
    // ⚠️ **公式比不了 —— 工具侧的 PID 表没有 formula 字段**（v2.69.0 查明）。
    //
    // 试过加这条比对，结果是：
    //
    //   ❌ std_0C 公式 工具「undefined」App「((A*256)+B)/4」
    //
    // 全部 36 条都报 —— 因为 `window.BUILTIN_PIDS` 的条目只有
    // `name / unit / min / max / warnLow / warnHigh / g`，**没有 formula**。
    //
    // **这不是 bug，是分工**：工具只做**预览**（画控件、看量程），
    // 公式只在 App 侧跑（`BuiltInPids.kt` 的 `formula` 字段）。
    //
    // 想让公式也进跨语言校验的话，得**先给工具的 PID 表加上 formula** ——
    // 那是个独立任务（36 条数据 + 工具侧可能要显示它），
    // 不是"顺手加一行断言"能做到的。**记在 CHANGELOG 的下次优化建议里。**
  });
  ok(bad.length === 0,
    `${checked} 个 PID 的量程 / 阈值 / 名字 / 单位全部一致` + (bad.length ? "：" + bad.slice(0, 6).join("; ") : ""));

  const onlyTool = Object.keys(tPids).filter(k => !(k in kPids));
  if (onlyTool.length) note(`工具里多出 ${onlyTool.length} 个 PID（App 侧没有）：${onlyTool.slice(0, 6).join(", ")}`);
}

console.log("\n=== 4. 样式 / 卡片 / 铺法 / 霓虹档位 ===");
{
  // 样式编号：PidModels.GaugeItem 的 STYLE_* 常量个数
  const styleConsts = (pidModelsKt.match(/const val STYLE_\w+\s*=\s*\d+/g) || []);
  eq(tool.STYLES.length, styleConsts.length, "仪表样式数量");

  const cardConsts = (pidModelsKt.match(/const val CARD_\w+\s*=\s*\d+/g) || []);
  eq(tool.CARD_NAMES.length, cardConsts.length, "卡片外框选项数量（含「跟随主题」）");

  const fitConsts = (designFileKt.match(/const val FIT_\w+\s*=\s*\d+/g) || []);
  eq(tool.FIT_NAMES.length, fitConsts.length, "背景铺法数量");

  // 霓虹档位：名字是**冻结契约**，逐字比对。
  // Kotlin 侧写成 `"关闭" to OFF,` / `"标准" to AUTO,` / `"强烈" to NeonStyle(...)`
  const neonKt = read(path.join(KOTLIN, "ui", "view", "NeonStyle.kt"));
  const names = [];
  {
    const i = neonKt.indexOf("val PRESETS");
    const j = neonKt.indexOf("listOf(", i);
    const end = neonKt.indexOf("\n    )", j);
    const body = neonKt.slice(j, end > 0 ? end : j + 2000);
    const re = /"([^"]+)"\s+to\s+(?:OFF|AUTO|NeonStyle\()/g;
    let m; while ((m = re.exec(body))) names.push(m[1]);
  }
  ok(names.length > 0, `从 NeonStyle.kt 解析到 ${names.length} 个档位名`);
  eq(tool.NEON_PRESETS.length, names.length, "霓虹档位数量");
  eq(JSON.stringify(tool.NEON_PRESETS), JSON.stringify(names),
    "霓虹档位名与顺序逐字一致（这是跨层冻结契约）");
}

// ================================================================ 4) 行为比对（v1）

console.log("\n=== 4b. 字体枚举（v2 新增，跨语言契约）===");
{
  const nodeKt = read(path.join(KOTLIN, "data", "DesignNode.kt"));

  /**
   * 取 Kotlin 里 `val X = listOf(A, B, ...)` 的**常量引用列表**并解析成值。
   *
   * ⚠️ 不能直接抓字符串字面量：DesignNode.kt 写的是
   * `listOf(FAMILY_SANS, FAMILY_SERIF, ...)` —— 引用常量。
   * 第一版按字面量抓，抓到 0 个，报了 7 条假失败。
   */
  function kotlinConstList(src, listName) {
    const m = new RegExp("val " + listName + " = listOf\\(([^)]*)\\)").exec(src);
    if (!m) return [];
    return m[1].split(",").map(s => s.trim()).filter(Boolean).map(name => {
      if (/^\d+$/.test(name)) return Number(name);
      if (/^"/.test(name)) return name.replace(/"/g, "");
      // 常量引用：去 const val 里找它的值
      const c = new RegExp("const val " + name + " = \"([^\"]+)\"").exec(src);
      if (c) return c[1];
      const n = new RegExp("const val " + name + " = (\\d+)").exec(src);
      return n ? Number(n[1]) : name;
    });
  }

  // 字体族
  const kFams = kotlinConstList(nodeKt, "FAMILIES");
  ok(kFams.length > 0, `从 DesignNode.kt 解析到 ${kFams.length} 个字体族`);
  eq(JSON.stringify(tool.FONT_FAMILIES.map(x => x.v)), JSON.stringify(kFams),
    "字体族的**名字与顺序**逐条一致");

  // 字重
  const kWeights = kotlinConstList(nodeKt, "WEIGHTS");
  ok(kWeights.length > 0, `解析到 ${kWeights.length} 档字重`);
  eq(JSON.stringify(tool.FONT_WEIGHTS.map(x => x.v)), JSON.stringify(kWeights),
    "字重档位一致");

  // 对齐
  const kAligns = kotlinConstList(nodeKt, "ALIGNS");
  ok(kAligns.length > 0, `解析到 ${kAligns.length} 种对齐`);
  eq(JSON.stringify(tool.FONT_ALIGNS.map(x => x.v)), JSON.stringify(kAligns),
    "对齐方式一致");

  // 默认值
  const kDefSize = /const val DEFAULT_SIZE = ([\d.]+)f/.exec(nodeKt);
  if (kDefSize) eq(tool.FONT_DEFAULT.size, Number(kDefSize[1]), "默认字号一致");
  const kDefColor = /const val DEFAULT_COLOR = 0x([0-9A-Fa-f]+)/.exec(nodeKt);
  if (kDefColor) {
    eq(tool.FONT_DEFAULT.color.toUpperCase(), "#" + kDefColor[1].slice(2).toUpperCase(), "默认字色一致");
  }

  // 节点类型
  const kTypes = kotlinConstList(nodeKt, "TYPES");
  ok(kTypes.length > 0, `解析到 ${kTypes.length} 种节点类型`);
  eq(JSON.stringify(tool.NODE_TYPES.map(x => x.v)), JSON.stringify(kTypes),
    "节点类型的名字与顺序一致");

  // 状态名
  const kStates = kotlinConstList(nodeKt, "NAMES");
  if (kStates.length) {
    eq(JSON.stringify(tool.STATE_NAMES.map(x => x.v)), JSON.stringify(kStates), "状态名一致");
  }

  // 节点上限
  const kMax = /const val MAX_NODES = (\d+)/.exec(nodeKt);
  if (kMax) eq(tool.MAX_NODES, Number(kMax[1]), "节点上限一致");

  // 缩放模式
  const dfKt = read(path.join(KOTLIN, "data", "DesignFile.kt"));
  const kScales = ["SCALE_STRETCH", "SCALE_FIT", "SCALE_FILL"]
    .map(n => { const m = new RegExp("const val " + n + " = (\\d+)").exec(dfKt); return m ? Number(m[1]) : null; });
  eq(JSON.stringify(tool.SCALE_MODES.map(x => x.v)), JSON.stringify(kScales), "缩放模式编号一致");
}

console.log("\n=== 5. v1 校验行为（错误 / 警告文案对齐）===");
{
  const v1ok = JSON.stringify({
    schema: "icar.ui/1",
    meta: { name: "t" },
    gauges: [{ pid: "obd.rpm", x: 0, y: 0, w: 100, h: 100, min: 0, max: 8000 }],
  });
  const r1 = tool.validateText(v1ok);
  eq(r1.errors.length, 0, "合法 v1 文件 0 错误");
  ok(r1.warnings.some(w => /自动升级成 v2/.test(w)), "v1 文件会提示「已自动升级成 v2」");

  const cases = [
    ["缺少 schema", JSON.stringify({ gauges: [] }), /缺少 `schema`/],
    ["schema 不认识", JSON.stringify({ schema: "icar.ui/9", gauges: [] }), /不支持的 schema/],
    ["缺 gauges", JSON.stringify({ schema: "icar.ui/1" }), /缺少 `gauges` 数组/],
    ["空 gauges", JSON.stringify({ schema: "icar.ui/1", gauges: [] }), /`gauges` 是空的/],
    ["缺 pid", JSON.stringify({ schema: "icar.ui/1", gauges: [{ x: 0, y: 0, w: 10, h: 10 }] }), /缺少 `pid`/],
    ["min≥max", JSON.stringify({
      schema: "icar.ui/1",
      gauges: [{ pid: "obd.rpm", x: 0, y: 0, w: 10, h: 10, min: 100, max: 100 }],
    }), /量程非法/],
    // unit 必须在 canvas 里；顶层写 unit 不生效（v1 格式如此）
    ["unit 不对", JSON.stringify({
      schema: "icar.ui/1", canvas: { unit: 100 },
      gauges: [{ pid: "obd.rpm", x: 0, y: 0, w: 10, h: 10, min: 0, max: 100 }],
    }), /unit/],
  ];
  cases.forEach(([name, text, re]) => {
    const r = tool.validateText(text);
    const hit = r.errors.some(e => re.test(e));
    ok(hit, `v1 报错文案匹配「${name}」` + (hit ? "" : " —— 实际：" + JSON.stringify(r.errors)));
  });

  // 越界：v1 查所有，v2 只查根
  const v1oob = JSON.stringify({
    schema: "icar.ui/1",
    gauges: [{ pid: "obd.rpm", x: 300, y: 0, w: 100, h: 100, min: 0, max: 100 }],
  });
  const r2 = tool.validateText(v1oob);
  ok(r2.warnings.some(w => /超出画布/.test(w)), "v1 越界会警告");

  const v2oob = JSON.stringify({
    schema: "icar.ui/2",
    canvas: { unit: 360 },
    nodes: [{
      id: "a", type: "group", name: "g", x: 0, y: 0, w: 200, h: 200,
      children: [{ id: "b", type: "gauge", name: "内", pid: "obd.rpm", x: 150, y: 0, w: 100, h: 100, min: 0, max: 100 }],
    }],
  });
  const r3 = tool.validateText(v2oob);
  ok(!r3.warnings.some(w => /超出画布/.test(w)),
    "v2 子节点溢出父级**不**警告（子坐标相对父节点，这是正常设计）");
}

// ================================================================ 5) v2 行为

console.log("\n=== 6. v2 节点树 ===");
{
  const mk = (o) => JSON.stringify(Object.assign({
    schema: "icar.ui/2", canvas: { unit: 360 },
  }, o));

  const r1 = tool.parseDesign(mk({ nodes: [{ id: "n1", type: "image", name: "图", x: 0, y: 0, w: 50, h: 50, assetId: "as1", alpha: 128, rotation: 30, z: 5, locked: true }] }));
  eq(r1.errors.length, 0, "合法 v2 节点 0 错误");
  ok(r1.design && r1.design.nodes[0].rotation === 30, "rotation 正确读入");
  ok(r1.design && r1.design.nodes[0].locked === true, "locked 正确读入");
  ok(r1.design && r1.design.nodes[0].alpha === 128, "alpha 正确读入");

  const r2 = tool.parseDesign(mk({ nodes: [{ id: "n1", type: "图片", x: 0, y: 0, w: 10, h: 10 }] }));
  ok(r2.errors.some(e => /type/.test(e)), "未知节点 type 报错");

  const r3 = tool.parseDesign(mk({ nodes: [] }));
  ok(r3.errors.some(e => /nodes.*是空的/.test(e)), "空 nodes 报错");

  const r4 = tool.parseDesign(mk({
    nodes: [{ id: "n1", type: "image", x: 0, y: 0, w: 10, h: 10, alpha: 999 }],
  }));
  ok(r4.warnings.some(w => /alpha/.test(w)), "alpha 越界给警告并夹住");
  ok(r4.design && r4.design.nodes[0].alpha === 255, "alpha 被夹到 255");

  const r5 = tool.parseDesign(mk({
    nodes: [{ id: "n1", type: "image", x: 0, y: 0, w: 10, h: 10, scale: 0 }],
  }));
  ok(r5.errors.some(e => /scale/.test(e)), "scale ≤ 0 报错");

  // 状态系统
  const r6 = tool.parseDesign(mk({
    assets: [{ id: "as1", name: "a", kind: "icon", path: "assets/a.png" }],
    nodes: [{
      id: "n1", type: "image", x: 0, y: 0, w: 20, h: 20, statePid: "obd.coolant",
      states: {
        normal: { assetId: "as1", alpha: 77 },
        critical: { assetId: "as1", alpha: 255, blink: true, blinkMs: 150 },
      },
    }],
  }));
  eq(r6.errors.length, 0, "带状态系统的节点 0 错误");
  ok(r6.design && r6.design.nodes[0].states.critical.blink === true, "状态的 blink 正确读入");
  ok(r6.design && r6.design.nodes[0].states.critical.blinkMs === 150, "状态的 blinkMs 正确读入");
  ok(r6.design && r6.design.nodes[0].states.normal.alpha === 77, "状态的 alpha 正确读入");

  // 引用不存在的素材 → 只警告
  const r7 = tool.parseDesign(mk({
    nodes: [{ id: "n1", type: "image", x: 0, y: 0, w: 20, h: 20, assetId: "nope" }],
  }));
  ok(r7.warnings.some(w => /不在 `assets` 清单/.test(w)), "引用不存在的素材只给警告");
  eq(r7.errors.length, 0, "引用不存在的素材不是硬错误");

  // 往返
  const src = mk({
    canvas: { unit: 360, designW: 1920, designH: 1080, scaleMode: 1 },
    assets: [{ id: "as1", name: "a", kind: "decor", path: "assets/a.png", w: 100, h: 50 }],
    nodes: [
      { id: "g1", type: "group", name: "组", x: 10, y: 10, w: 200, h: 200, rotation: 15, z: 2, children: [
        { id: "c1", type: "gauge", name: "表", pid: "obd.rpm", style: 0, min: 0, max: 8000, x: 0, y: 0, w: 100, h: 100 },
      ] },
      { id: "i1", type: "image", name: "图", x: 5, y: 5, w: 40, h: 40, assetId: "as1", alpha: 200, z: 1 },
      { id: "t1", type: "text", name: "字", x: 0, y: 300, w: 200, h: 30, text: "hello", fontSize: 20 },
    ],
  });
  const p1 = tool.parseDesign(src);
  eq(p1.errors.length, 0, "综合 v2 文件 0 错误");
  const out = tool.toV2Json(p1.design);
  const p2 = tool.parseDesign(out);
  eq(p2.errors.length, 0, "往返后 0 错误");
  eq(tool.flatten(p2.design.nodes).length, tool.flatten(p1.design.nodes).length, "往返节点数一致");
  eq(p2.design.canvas.scaleMode, 1, "往返保留 scaleMode");
  eq(p2.design.canvas.designW, 1920, "往返保留 designW");
  eq(p2.design.assets.length, 1, "往返保留 assets");
  // ⚠️ 不能假设 nodes[0] 还是那个 group —— toV2Json 会**按 z 排序**写出，
  // 而这个文件里 text(z=0) < image(z=1) < group(z=2)。按 id 找才可靠。
  const gBack = p2.design.nodes.find(n => n.id === "g1");
  ok(gBack && gBack.rotation === 15, "往返保留 group 的 rotation（按 id 查找）");
  ok(gBack && gBack.children.length === 1, "往返保留 group 的子节点数");
  // ⚠️ 别名会被**解析成 PID id**（`obd.rpm` → `std_0C`），这是 App 期望的行为：
  // App 侧 GaugeItem.pidId 存的就是 id。原始别名留在 rawPid 里供编辑器回显。
  ok(gBack && gBack.children[0].pid === "std_0C",
    "别名被解析成 PID id（obd.rpm → std_0C）");
  ok(gBack && gBack.children[0].rawPid === "obd.rpm",
    "原始别名保留在 rawPid 里（编辑器回显用）");
  // z 排序也是行为契约：写出的顺序 = 绘制顺序
  const order = JSON.parse(out).nodes.map(n => n.id);
  eq(JSON.stringify(order), JSON.stringify(["t1", "i1", "g1"]),
    "写出的节点顺序按 z 升序（= 绘制顺序，便于人读）");
}

// ================================================================ 6) 示例文件

console.log("\n=== 7. 示例文件必须能被自己解析 ===");
{
  const p1 = path.join(STUDIO, "sample.json");
  const p2 = path.join(STUDIO, "sample-v2.json");

  ok(fs.existsSync(p1), "sample.json 存在（v1，App 当前能读）");
  if (fs.existsSync(p1)) {
    const txt = read(p1);
    const r = tool.parseDesign(txt);
    eq(r.errors.length, 0, "sample.json 解析 0 错误");
    const j = JSON.parse(txt);
    eq(j.schema, "icar.ui/1", "sample.json 是 v1（App 只认 v1）");
    eq(r.design.nodes.length, 6, "sample.json 有 6 块表");
    // 它被 ThemeStudioSampleTest 逐条断言，这里只核对最容易手抄错的几条
    eq(r.design.name, "赛道模式", "sample.json 的 name 与 Kotlin 测试期望一致");
    eq(r.design.themeId, "neon", "sample.json 的 theme 与 Kotlin 测试期望一致");
    eq(r.design.background.path, "/sdcard/icar-bg/carbon.png",
      "sample.json 的背景路径与 Kotlin 测试期望一致");
  }

  ok(fs.existsSync(p2), "sample-v2.json 存在（v2，展示图片/状态/分组/变换）");
  if (fs.existsSync(p2)) {
    const txt = read(p2);
    const r = tool.parseDesign(txt);
    eq(r.errors.length, 0, "sample-v2.json 解析 0 错误");
    eq(JSON.parse(txt).schema, "icar.ui/2", "sample-v2.json 是 v2");
    ok(r.design.nodes.length > 0, `sample-v2.json 有 ${r.design.nodes.length} 个根节点`);
    const all = tool.flatten(r.design.nodes);
    const types = {};
    all.forEach(n => { types[n.type] = (types[n.type] || 0) + 1; });
    ok((types.image || 0) >= 1, `含图片节点 ${types.image || 0} 个`);
    ok((types.group || 0) >= 1, `含分组节点 ${types.group || 0} 个`);
    ok((types.gauge || 0) >= 1, `含仪表节点 ${types.gauge || 0} 个`);
    ok((types.text || 0) >= 1, `含文字节点 ${types.text || 0} 个`);
    const withStates = all.filter(n => n.states);
    ok(withStates.length >= 1, `含启用状态系统的节点 ${withStates.length} 个`);
    const rotated = all.filter(n => Math.abs(n.rotation) > 0.01);
    const locked = all.filter(n => n.locked);
    const scaled = all.filter(n => Math.abs((n.scale || 1) - 1) > 0.001);
    ok(rotated.length + locked.length + scaled.length >= 1,
      `含旋转/锁定/缩放等变换（旋转 ${rotated.length} · 锁定 ${locked.length} · 缩放 ${scaled.length}）`);
    eq(r.design.assets.length, 5, "素材清单 5 项");
  }

  // 生成器存在且能复现（示例是"格式示范"，必须可复现而不是手抄）
  ok(fs.existsSync(path.join(STUDIO, "gen-sample.js")),
    "gen-sample.js 存在（示例由工具自己的代码生成，避免手抄脱节）");
}

// ================================================================ 7) 已知缺口

console.log("\n=== 8. 已知缺口（显式报告，不假装一致）===");
{
  const kSchema = kotlinConst(designFileKt, "SCHEMA");
  eq(kSchema, "icar.ui/1", "App 当前只认 v1（DesignFile.SCHEMA）");
  ok(tool.SCHEMA_V2 === "icar.ui/2", "工具产出 v2");
  // 这条备注原来写的是"App 还不认识 v2"。现在 App 已经能**解析** v2 了，\n  // 剩下的只是**渲染**没跟上 —— 说明必须跟着改，否则会误导下一个接手的人。

  // 这条断言原来是「确认还没开始阶段 2」。现在阶段 2 已经开始了（App 能读 v2），
  // 所以反过来钉住：**v2 分支必须存在**，而且 SCHEMA_V2 常量要和工具一致。
  const hasV2 = /icar\.ui\/2/.test(designFileKt);
  ok(hasV2, "DesignFile.kt 里有 v2 分支（App 能读节点树）");
  const kSchemaV2 = kotlinConst(designFileKt, "SCHEMA_V2");
  eq(tool.SCHEMA_V2, kSchemaV2, "v2 schema 字符串一致");
  // 这条备注原来写的是"App 还不认识 v2"，后来改成"能解析但渲染没跟上"，
  // 现在 **App 侧渲染也做完了**（v2.5.0）—— 说明又该改了。
  // 教训：这类"进度备注"必须跟着版本走，否则读的人会以为功能还没做。
  note("App 侧 v2 **解析与渲染都已完成**（v1.11.0 / v1.12.0）：节点树 / 图片 / 分组 / 文字 / " +
    "旋转 / 图层顺序 / 缩放模式 / 状态系统 / 子部件 / 多页面。见主题设计大纲 §七。");
}

// ================================================================ 8) 内置主题配色（P8-5）

console.log("\n=== 8. 内置主题配色（P8-5 内嵌配色的跨语言契约）===");
{
  // 工具侧 GAUGE_THEMES 的颜色字段必须与 GaugeTheme.kt 的 builtins 逐条一致。
  // 不一致的后果：工具内嵌的配色推到设备上"颜色不对"，而且很难查 ——
  // 文件里写着 #FF8A00，设备上却是别的。
  const themeKt = read(path.join(KOTLIN, "ui", "view", "GaugeTheme.kt"));
  const bIdx = themeKt.indexOf("private val builtins = listOf(");
  const bEnd = themeKt.indexOf("fun builtIns()", bIdx);
  const body = themeKt.slice(bIdx, bEnd);
  const groups = body.split("GaugeTheme(").slice(1);
  eq(groups.length, 3, "Kotlin builtins 有 3 套主题");

  const FIELDS = ["background", "surface", "surfaceEdge",
    "accent", "accentHot", "accentDim",
    "track", "tick", "needle", "value", "label", "dim"];
  const ALIASES = ["neon", "ice", "amber"];

  groups.forEach((g, gi) => {
    const colors = (g.match(/c\("#[0-9A-Fa-f]{6}"\)/g) || [])
      .map(s => s.replace(/c\("|"\)/g, "").toUpperCase());
    const tool0 = tool.GAUGE_THEMES[ALIASES[gi]];
    if (!tool0) { ok(false, "工具里缺少主题 " + ALIASES[gi]); return; }
    ok(colors.length >= 12, ALIASES[gi] + "：Kotlin 解析到 " + colors.length + " 个颜色");
    let bad = 0;
    FIELDS.forEach((f, fi) => {
      const k = (colors[fi] || "").toUpperCase();
      const tv = String(tool0[f] || "").toUpperCase();
      if (k !== tv) { bad++; console.log("       " + ALIASES[gi] + "." + f + "：Kotlin " + k + " ≠ 工具 " + tv); }
    });
    ok(bad === 0, ALIASES[gi] + "：12 个颜色字段逐条一致");
  });

  const glowKt = (body.match(/,\s*(true|false)\s*\)/g) || []).map(s => s.replace(/[,\s)]/g, ""));
  ALIASES.forEach((al, k) => {
    if (glowKt[k] === undefined) return;
    eq(String(tool.GAUGE_THEMES[al].glow), glowKt[k], al + "：glow 标志一致");
  });

  const aliasKt = (themeKt.match(/-> "(neon|ice|amber)"/g) || []).map(s => s.replace(/-> |"/g, ""));
  eq(JSON.stringify(tool.THEME_ALIASES), JSON.stringify(aliasKt), "主题别名列表一致");
}

// ================================================================ 汇总

console.log("\n" + "=".repeat(60));
if (notes.length) {
  console.log("备注：");
  notes.forEach(n => console.log("  · " + n));
  console.log("");
}
console.log("PASS=" + pass + "  FAIL=" + fail);
process.exit(fail === 0 ? 0 : 1);
