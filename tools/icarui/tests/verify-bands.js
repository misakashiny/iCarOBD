/* ==========================================================================
   verify-bands.js —— 多段色带 `bands`（v2.87.0，**只做工具侧**）
   --------------------------------------------------------------------------
   ## 为什么单开一个套件

   `bands` 是"往设计文件里加一个新字段"这类改动，而这类改动在本仓库
   有**两种固定的翻车形态**（都发生过）：

   1. **只写不读** —— `model.js` 写出去，`validate.js` 不还原。
      症状：保存再打开，字段**静默消失**，再保存一次就把它从文件里抹掉。
      （`statePid` v1.20.16、`valueLabels` v2.83.0 各踩过一次。）
   2. **缺省值改了旧行为** —— 新字段缺省时没有回落成"完全旧行为"，
      于是**存量设计**被悄悄改了样子。

   `bands` 还多一条**安全**语义要守：

   3. **它只管画出来的分区，绝不碰报警判定**（`warnLow`/`warnHigh`）。
      如果"给转速表加个红区参考"会顺带改报警，那是**静默改变存量设计的安全语义**。

   所以这个套件把上面三条都钉成断言 —— 而且全部是**纯 Node**（不需要浏览器）：
   `schema.js` / `model.js` / `validate.js` / `spring.js` / `presets.js` 都是纯函数，
   放进 vm 沙箱就能跑。

   ⚠️ **App 侧 v1.20.22 已落地**（`GaugeItem.bands` / `Bands` / 两个视图按段画）。
   落地时**同时**补上了 `verify-crosslang.js` 里那 4 个 `BAND_*` 常量的跨语言断言 ——
   v2.87.0 当时**故意没加**（App 侧还没有这些常量，加了必红）。
   本文件第 0 节那条断言现在**反过来**守着它：跨语言比对里**必须**有 `MAX_BANDS`，
   谁把那 4 条删了，这里就红。
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STUDIO = path.join(ROOT, "tools", "icarui");
const read = p => fs.readFileSync(p, "utf8");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? "" : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, msg + (Math.abs(a - b) <= tol ? "" : `（实际 ${a}，期望 ${b}±${tol}）`));
}

// ================================================================ 沙箱

let CUR = null;

function loadTool() {
  const sandbox = {
    console, JSON, Math, Object, Array, String, Number, Boolean, Date, Set, Map,
    isNaN, parseInt, parseFloat, isFinite,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => 0,
    setTimeout, clearTimeout,
    localStorage: {
      _d: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, classList: { add() { }, remove() { } }, appendChild() { }, addEventListener() { } }),
      addEventListener: () => { },
      readyState: "complete",
      querySelectorAll: () => [],
    },
    alert: () => { }, confirm: () => true,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.ensureBuiltinAsset = function (p) {
    if (!p) return "";
    if (!CUR) return "as_stub";
    if (!CUR.assets) CUR.assets = [];
    const ex = CUR.assets.find(x => x.path === p);
    if (ex) return ex.id;
    const id = "as_" + CUR.assets.length;
    CUR.assets.push({ id: id, name: p.split("/").pop(), kind: "builtin", path: p, w: 64, h: 64 });
    return id;
  };
  vm.createContext(sandbox);
  // 顺序与 index.html 一致（schema → model → validate → spring → presets）
  ["schema.js", "model.js", "validate.js", "spring.js", "presets.js"].forEach(f => {
    vm.runInContext(read(path.join(STUDIO, "js", f)), sandbox, { filename: f });
  });
  return sandbox;
}

const W = loadTool();
const D = v => JSON.stringify(v);

/** 键排序深拷贝 —— 只比内容，不比键序 */
function deep(o) {
  if (Array.isArray(o)) return o.map(deep);
  if (o && typeof o === "object") {
    const r = {};
    Object.keys(o).sort().forEach(k => { r[k] = deep(o[k]); });
    return r;
  }
  return o;
}
const canon = o => JSON.stringify(deep(o));

// ================================================================ 0. 常量

console.log("=== 0. 常量（两侧在 verify-crosslang.js 里逐条钉住）===");
eq(W.MAX_BANDS, 8, "`MAX_BANDS` = 8（段数上限）");
eq(W.BAND_DEFAULT_COLOR, "#FF4D4F", "`BAND_DEFAULT_COLOR` = `#FF4D4F`（与老红区同一个红）");
eq(W.BAND_ALPHA_MIN, 0, "`BAND_ALPHA_MIN` = 0");
eq(W.BAND_ALPHA_MAX, 255, "`BAND_ALPHA_MAX` = 255（与节点 `alpha` / `card.alpha` 同一套口径）");
// ⚠️ 这一条**反过来**守着 v2.87.0 留下的尾巴（CHANGELOG「App 侧待办」第 2 条）：
// 工具侧当时**故意没加**跨语言断言（App 侧还没有这些常量，加了必红）。
// App 侧落地（v1.20.22）之后，`verify-crosslang.js` **必须**补上那 4 个常量 ——
// 所以这里从"还没有 MAX_BANDS"翻成"必须有"，防止那条断言又被谁顺手删掉。
const crossSrc = read(path.join(STUDIO, "tests", "verify-crosslang.js"));
ok(crossSrc.indexOf("MAX_BANDS") >= 0,
  "**跨语言比对里已经有 `MAX_BANDS`**（App 侧 v1.20.22 落地后必须补，不许再欠着）");
ok(crossSrc.indexOf("BAND_DEFAULT_COLOR") >= 0 && crossSrc.indexOf("BAND_ALPHA_MIN") >= 0 &&
  crossSrc.indexOf("BAND_ALPHA_MAX") >= 0,
  "跨语言比对里 4 个 `BAND_*` 常量都钉住了（少一个就是新的跨语言分叉）");
ok(/App 侧待办|App 侧做完|App 侧落地/.test(read(path.join(STUDIO, "CHANGELOG.md"))),
  "CHANGELOG 里记着「App 侧待办」（补 crosslang 断言那条尾巴没丢）");

// ================================================================ 1. normalizeBands

console.log("\n=== 1. normalizeBands：夹量程 / 丢空段 / 上限 / 颜色 / alpha ===");
{
  const nb = W.normalizeBands;

  eq(nb(null, 0, 100), null, "`null` → `null`");
  eq(nb(undefined, 0, 100), null, "`undefined` → `null`");
  eq(nb([], 0, 100), null, "空数组 → `null`（**不是 `[]`** —— 空就是「没有色带」）");
  eq(nb("abc", 0, 100), null, "不是数组 → `null`（设计文件里什么都可能是）");

  // 夹量程
  const clamp1 = nb([{ from: -500, to: 9000 }], 0, 8000);
  eq(clamp1.length, 1, "一段合法的留下");
  eq(clamp1[0].from, 0, "  `from = -500` 夹到量程下限 0");
  eq(clamp1[0].to, 8000, "  `to = 9000` 夹到量程上限 8000");
  eq(clamp1[0].color, null, "  没写颜色 → `null`（**不填默认色**，否则「没写」会变成「写了」）");
  eq(clamp1[0].alpha, null, "  没写 alpha → `null`（绘制时按 255）");

  // 丢空段 / 反向段
  eq(nb([{ from: 50, to: 50 }], 0, 100), null, "`from === to`（空段）→ 丢掉");
  eq(nb([{ from: 80, to: 20 }], 0, 100), null, "`from > to`（反向段）→ 丢掉");
  eq(nb([{ from: 10, to: 20 }, { from: 90, to: 10 }], 0, 100).length, 1, "一好一坏 → 只留好的那个");
  eq(nb([{ from: "a", to: "b" }], 0, 100), null, "`from`/`to` 不是数字 → 丢掉");
  eq(nb([null, 1, "x", []], 0, 100), null, "不是对象的项 → 丢掉");
  // 夹量程之后变成空段的也要丢（比如整段在量程外）
  eq(nb([{ from: 200, to: 300 }], 0, 100), null, "整段在量程外 → 夹成空段 → 丢掉（不画半截）");
  eq(nb([{ from: -300, to: -200 }], 0, 100), null, "整段在量程下限之外 → 同样丢掉");

  // 上限
  const many = [];
  for (let i = 0; i < 12; i++) many.push({ from: i * 5, to: i * 5 + 4 });
  eq(nb(many, 0, 100).length, W.MAX_BANDS, "12 段 → 截到 `MAX_BANDS` = " + W.MAX_BANDS + " 段");
  eq(nb(many, 0, 100)[0].from, 0, "  截断保留**前面**的段（不是后面）");

  // 颜色：只认 #RRGGBB
  eq(nb([{ from: 0, to: 1, color: "#39d98a" }], 0, 100)[0].color, "#39d98a", "`#39d98a`（小写）认");
  eq(nb([{ from: 0, to: 1, color: "#39D98A" }], 0, 100)[0].color, "#39D98A", "`#39D98A`（大写）认");
  eq(nb([{ from: 0, to: 1, color: "red" }], 0, 100)[0].color, null, "`red`（颜色名）**不认** → `null`");
  eq(nb([{ from: 0, to: 1, color: "#FFF" }], 0, 100)[0].color, null, "`#FFF`（三位缩写）**不认** → `null`");
  eq(nb([{ from: 0, to: 1, color: "rgb(1,2,3)" }], 0, 100)[0].color, null, "`rgb(...)` **不认** → `null`");
  eq(nb([{ from: 0, to: 1, color: "#GGGGGG" }], 0, 100)[0].color, null, "非十六进制字符 → `null`");

  // alpha
  eq(nb([{ from: 0, to: 1, alpha: 300 }], 0, 100)[0].alpha, 255, "alpha=300 夹到 255");
  eq(nb([{ from: 0, to: 1, alpha: -5 }], 0, 100)[0].alpha, 0, "alpha=-5 夹到 0");
  eq(nb([{ from: 0, to: 1, alpha: 128.6 }], 0, 100)[0].alpha, 129, "alpha 取整（128.6 → 129）");
  eq(nb([{ from: 0, to: 1, alpha: null }], 0, 100)[0].alpha, null, "alpha=null → `null`（= 按 255 画）");
  eq(nb([{ from: 0, to: 1, alpha: "x" }], 0, 100)[0].alpha, null, "alpha 不是数字 → `null`");

  // 顺序
  const order = nb([{ from: 70, to: 80 }, { from: 10, to: 20 }, { from: 40, to: 50 }], 0, 100);
  eq(order.map(z => z.from).join(","), "70,10,40", "**段的顺序不变**（不排序 —— 画叠色带时顺序就是层序）");

  // 缺省 min/max
  eq(nb([{ from: -50, to: 500 }])[0].to, 100, "不传 min/max 时按 0..100 夹（与 DIAL_DEFAULT 一致）");
}

// ================================================================ 2. 往返保真

console.log("\n=== 2. 往返：写出去 → 读回来，`bands` 逐字段相同 ===");
{
  const d = W.createDesign({ name: "bands" });
  CUR = d;

  const BANDS = [
    { from: 0, to: 15, color: "#FF4D4F", alpha: 255 },
    { from: 15, to: 30, color: "#FFB020" },            // 没写 alpha
    { from: 30, to: 100 },                              // 颜色/alpha 都没写
  ];
  const n = W.createNode(W.NODE_GAUGE, { name: "油量", pid: "obd.fuel_level", style: 2, min: 0, max: 100, bands: BANDS });
  d.nodes = [n];

  const j1 = JSON.parse(W.toV2Json(d));
  const g1 = j1.nodes[0];
  ok(Array.isArray(g1.bands), "**`bands` 写进了 v2 JSON**（非空才写）");
  eq(g1.bands.length, 3, "  三段都在");
  eq(canon(g1.bands[0]), canon({ from: 0, to: 15, color: "#FF4D4F", alpha: 255 }), "  第一段逐字段：from/to/color/alpha");
  eq(g1.bands[1].alpha, undefined, "  **没写 alpha 的段不写出 `alpha`**（否则「没写」会变成「写了」）");
  eq(g1.bands[2].color, undefined, "  **没写颜色的段不写出 `color`**");

  const r = W.parseDesign(JSON.stringify(j1));
  eq(r.errors.length, 0, "解析 0 错误");
  const j2 = JSON.parse(W.toV2Json(r.design));
  eq(canon(j1.nodes[0].bands), canon(j2.nodes[0].bands),
    "**往返之后 `bands` 逐字段相同**（含「没写」的那两段）");
  eq(r.design.nodes[0].bands.length, 3, "  内存里也是 3 段");

  // ---- 空 / 缺省：**不写出**
  const d2 = W.createDesign({ name: "empty" });
  CUR = d2;
  const n2 = W.createNode(W.NODE_GAUGE, { name: "无带", pid: "obd.rpm", min: 0, max: 8000 });
  d2.nodes = [n2];
  const j3 = JSON.parse(W.toV2Json(d2));
  ok(!("bands" in j3.nodes[0]), "**没有色带 → JSON 里没有 `bands` 键**（不是 `[]`、不是 `null`）");
  eq(n2.bands, null, "  内存里是 `null`（不是 `[]`）");
  // 显式给空数组也一样
  const n3 = W.createNode(W.NODE_GAUGE, { min: 0, max: 100, bands: [] });
  eq(n3.bands, null, "显式给空数组 → 归一成 `null`");
  const n4 = W.createNode(W.NODE_GAUGE, { min: 0, max: 100, bands: [{ from: 5, to: 5 }] });
  eq(n4.bands, null, "全是非法段 → 归一成 `null`");

  // ---- 老文件（根本没有 bands 字段）解析后再序列化，**不许冒出 bands**
  const legacy = {
    schema: W.SCHEMA_V2,
    meta: { name: "老文件" },
    nodes: [{ type: "gauge", id: "n1", name: "转速", pid: "obd.rpm", x: 0, y: 0, w: 120, h: 120, min: 0, max: 8000, warnHigh: 6500 }],
  };
  const rl = W.parseDesign(JSON.stringify(legacy));
  eq(rl.errors.length, 0, "老文件解析 0 错误");
  eq(rl.design.nodes[0].bands, null, "  老文件的 `bands` 是 `null`（= 完全旧行为）");
  eq(rl.design.nodes[0].warnHigh, 6500, "  `warnHigh` 原样保留");
  const jl = JSON.parse(W.toV2Json(rl.design));
  ok(!("bands" in jl.nodes[0]), "**老文件再存一次也不会凭空多出 `bands` 键**");

  // ---- v1 导出 / 导入也要带上（v1 的导入走的是同一个 parseNode）
  const v1 = JSON.parse(W.toV1Json(d).json);
  ok(Array.isArray(v1.gauges[0].bands), "**v1 导出也写 `bands`**（App 侧以后能读）");
  eq(v1.gauges[0].bands.length, 3, "  v1 里也是 3 段");
  const rv1 = W.parseDesign(JSON.stringify(v1));
  eq(rv1.errors.length, 0, "v1 文件解析 0 错误（自动升级成 v2）");
  eq(canon(rv1.design.nodes[0].bands), canon(BANDS.map(b => ({
    from: b.from, to: b.to, color: b.color === undefined ? null : b.color,
    alpha: b.alpha === undefined ? null : b.alpha,
  }))), "**v1 往返之后 `bands` 逐字段相同**（没有「只写不读」）");
}

// ================================================================ 3. 不许改报警语义

console.log("\n=== 3. `bands` 只管画分区：不许碰报警判定 ===");
{
  const d = W.createDesign({ name: "alarm" });
  CUR = d;

  // 只给 bands，不给阈值
  const a = W.createNode(W.NODE_GAUGE, { pid: "obd.rpm", min: 0, max: 8000, bands: [{ from: 6000, to: 8000, color: "#FF4D4F" }] });
  eq(a.warnLow, null, "**只加色带 → `warnLow` 仍然是 `null`**（没有被顺带设上）");
  eq(a.warnHigh, null, "**只加色带 → `warnHigh` 仍然是 `null`**（报警判定没被改）");

  // 给了阈值 + 色带，两个字段各自独立
  const b = W.createNode(W.NODE_GAUGE, {
    pid: "obd.rpm", min: 0, max: 8000, warnHigh: 6500,
    bands: [{ from: 7000, to: 8000, color: "#FFB020" }],
  });
  eq(b.warnHigh, 6500, "**色带边界 ≠ 报警阈值**：`warnHigh` 仍是 6500，色带从 7000 起");
  eq(b.bands[0].from, 7000, "  色带起点仍是 7000");

  // 序列化之后两个字段都在，互不影响
  d.nodes = [b];
  const j = JSON.parse(W.toV2Json(d)).nodes[0];
  eq(j.warnHigh, 6500, "写出去：`warnHigh` = 6500");
  eq(j.bands[0].from, 7000, "写出去：`bands[0].from` = 7000");
  const back = W.parseDesign(JSON.stringify({ schema: W.SCHEMA_V2, meta: { name: "x" }, nodes: [j] }));
  eq(back.design.nodes[0].warnHigh, 6500, "读回来：`warnHigh` = 6500（色带没把它带跑）");
}

// ================================================================ 4. 校验：警告而不是硬错误

console.log("\n=== 4. validate：越界 / 超段数 / 坏颜色 给**警告**不给硬错误 ===");
{
  const mk = (bands) => JSON.stringify({
    schema: W.SCHEMA_V2, meta: { name: "t" },
    nodes: [{ type: "gauge", id: "n1", name: "转速", pid: "obd.rpm", x: 0, y: 0, w: 120, h: 120, min: 0, max: 8000, bands: bands }],
  });
  const bandWarns = r => r.warnings.filter(w => /bands/.test(w));

  // 合法：一条警告都不该有
  const good = W.parseDesign(mk([{ from: 6000, to: 8000, color: "#FF4D4F", alpha: 200 }]));
  eq(good.errors.length, 0, "合法色带：0 错误");
  eq(bandWarns(good).length, 0, "合法色带：0 条色带警告");
  eq(good.design.nodes[0].bands.length, 1, "  段还在");

  // 越界 → 警告 + 夹住（**不是**错误）
  const over = W.parseDesign(mk([{ from: -100, to: 9000 }]));
  eq(over.errors.length, 0, "越界色带：**0 硬错误**（拒收存量文件代价太大）");
  eq(bandWarns(over).length, 1, "越界色带：1 条警告");
  ok(/量程/.test(bandWarns(over)[0]), "  警告文本说清了「超出量程」：" + bandWarns(over)[0].slice(0, 60));
  eq(over.design.nodes[0].bands[0].from, 0, "  已经被夹到量程下限");
  eq(over.design.nodes[0].bands[0].to, 8000, "  已经被夹到量程上限");

  // 超段数 → 警告
  const many = [];
  for (let i = 0; i < 10; i++) many.push({ from: i * 100, to: i * 100 + 90 });
  const overN = W.parseDesign(mk(many));
  eq(overN.errors.length, 0, "超段数：0 硬错误");
  eq(overN.design.nodes[0].bands.length, W.MAX_BANDS, "  只保留 " + W.MAX_BANDS + " 段");
  ok(bandWarns(overN).some(w => /超过上限/.test(w)), "  有「超过上限」的警告：" + bandWarns(overN).find(w => /超过上限/.test(w)).slice(0, 70));

  // 坏颜色 → 警告
  const badC = W.parseDesign(mk([{ from: 0, to: 100, color: "red" }]));
  eq(badC.errors.length, 0, "坏颜色：0 硬错误");
  ok(bandWarns(badC).some(w => /#RRGGBB/.test(w)), "  有「不是 #RRGGBB」的警告");
  eq(badC.design.nodes[0].bands[0].color, null, "  颜色归一成 `null`（绘制时回落到默认红）");

  // 空段 → 警告
  const empty = W.parseDesign(mk([{ from: 100, to: 100 }]));
  eq(empty.errors.length, 0, "空段：0 硬错误");
  ok(bandWarns(empty).some(w => /丢掉/.test(w)), "  有「被丢掉」的警告");
  eq(empty.design.nodes[0].bands, null, "  全丢光了 → `null`");
}

// ================================================================ 5. 盘面签名与分区

console.log("\n=== 5. spring.js：`dialSig` 必须把颜色/透明度算进签名 ===");
{
  const base = { min: 0, max: 8000, redlines: [{ from: 6000, to: 8000 }] };
  const red = { min: 0, max: 8000, redlines: [{ from: 6000, to: 8000, color: "#FF4D4F" }] };
  const amber = { min: 0, max: 8000, redlines: [{ from: 6000, to: 8000, color: "#FFB020" }] };
  const dim = { min: 0, max: 8000, redlines: [{ from: 6000, to: 8000, color: "#FF4D4F", alpha: 120 }] };

  ok(W.dialSig(red) !== W.dialSig(amber),
    "**只改颜色 → 签名变**（原来只算 from-to，改颜色会命中旧盘面缓存 =「改了颜色画布没反应」）");
  ok(W.dialSig(red) !== W.dialSig(dim),
    "**只改透明度 → 签名变**");
  ok(W.dialSig(base) !== W.dialSig(red),
    "没写颜色 vs 写了颜色 → 签名也不同（`undefined` 与具体值不能撞）");
  ok(W.dialSig(red) !== W.dialSig({ min: 0, max: 8000, redlines: [{ from: 6000, to: 7999, color: "#FF4D4F" }] }),
    "改 from/to → 签名变（老行为没退化）");
  eq(W.dialSig(red), W.dialSig({ min: 0, max: 8000, redlines: [{ from: 6000, to: 8000, color: "#FF4D4F" }] }),
    "同样的输入 → 同样的签名（签名本身是稳定的）");

  // dialRedlines 带颜色，但**没写的段不带这两个键**
  const rl = W.dialRedlines({ min: 0, max: 100, redlines: [{ from: 10, to: 20, color: "#39D98A", alpha: 128 }, { from: 30, to: 40 }] });
  eq(rl.length, 2, "两段都留下");
  eq(rl[0].color, "#39D98A", "带颜色的段：color 跟着走");
  eq(rl[0].alpha, 128, "带 alpha 的段：alpha 跟着走");
  eq(Object.keys(rl[1]).sort().join(","), "from,to", "**没写的段只有 from/to**（老调用点的产物逐字段不变）");
  eq(canon(rl[0]), canon({ from: 10, to: 20, color: "#39D98A", alpha: 128 }), "  段对象就是这四个字段");

  // 老调用点（redlineFrom）产物**不许变**
  const legacy = W.dialRedlines({ min: 0, max: 8000, redlineFrom: 6500 });
  eq(legacy.length, 1, "老调用点：1 段");
  eq(Object.keys(legacy[0]).sort().join(","), "from,to", "**老调用点产物仍然只有 from/to**（向后兼容）");

  // buildDial 把颜色带进盘面对象
  const face = W.buildDial({ min: 0, max: 8000, redlines: [{ from: 6000, to: 8000, color: "#FFB020", alpha: 200 }] });
  eq(face.redlines.length, 1, "buildDial：1 段分区");
  eq(face.redlines[0].color, "#FFB020", "  盘面对象带 color");
  eq(face.redlines[0].alpha, 200, "  盘面对象带 alpha");
  near(face.redlines[0].angFrom, 337.5, 0.01, "  angFrom 照旧算出来（val2ang(6000)）");
  const faceOld = W.buildDial({ min: 0, max: 8000, redlineFrom: 6500 });
  eq(Object.keys(faceOld.redlines[0]).sort().join(","), "angFrom,angTo,from,to",
    "  **老调用点的盘面对象仍然只有那四个键**（没有凭空多出 color/alpha）");
}

// ================================================================ 6. 色带在**真实控件**上的落地
//
// ## v2.91.0：这一节原来测的是两个样板（`g_rpmband` / `g_fuelband`）
//
// 那两个控件**已按用户要求从控件库删除**（连同 `g_speed_d` / `g_soc` 共 4 个）。
// 删掉的是"库里的样板"，**`bands` 能力本身一点没动** —— 所以这一节改成
// 直接测**能力**：从控件库拖一个真表出来、按用户会走的那条路给它配色带，
// 再走一遍序列化往返。
//
// ⚠️ 为什么不是"删掉这几条断言"：那样 `bands` 在**控件路径**上就没有守卫了
// （第 3~5 节测的是纯函数）。删断言还会让本套件的断言数掉下去、基线要跟着降，
// 而"降基线"正是这份基线想防的事（见 expected-counts.json 的 why）。
// 所以：**断言条数保持 11 条**，测的东西换成"真控件 + 色带"。

console.log("\n=== 6. 色带在真实控件上的落地（v2.91.0 换掉已删的样板）===");
{
  const byKey = {};
  W.BUILTIN_CONTROLS.forEach(c => { byKey[c.key] = c; });

  // 用户点名删掉的 4 个控件**必须真的不在了**（这条是"删除"这件事的守卫）
  ["g_speed_d", "g_soc", "g_rpmband", "g_fuelband"].forEach(k => {
    ok(!byKey[k], "已删控件 `" + k + "` **不在控件库里**（v2.91.0 用户点名删除）");
  });

  // 能力还在：拖一个真表出来，配上与"转速红区表"同样的两段
  const ctrl = byKey["g_rpm"];
  ok(!!ctrl, "控件库里有 `g_rpm`（转速表）—— 色带要在**真控件**上验证");
  const d = W.createDesign({ name: "tpl" });
  CUR = d;
  const rn = ctrl.make();
  // ⚠️ 报警阈值**必须显式带上** —— 原样板的定义里写死了 `warnHigh: 6500`，
  // 而控件库里的 `g_rpm` 模板**不带** `warnHigh`（它走"从 PID 库推断"）。
  // 这一节测的是"色带与报警阈值是两件事"，所以把阈值显式钉上。
  rn.warnHigh = 6500;
  rn.bands = [
    { from: 6000, to: 7000, color: "#FFB020" },
    { from: 7000, to: 8000, color: "#FF4D4F" },
  ];
  const rn2 = W.createNode(W.NODE_GAUGE, rn);
  eq(rn2.bands.length, 2, "真控件 + 2 段色带（黄 6000~7000 / 红 7000~8000）");
  eq(canon(rn2.bands), canon([
    { from: 6000, to: 7000, color: "#FFB020", alpha: null },
    { from: 7000, to: 8000, color: "#FF4D4F", alpha: null },
  ]), "  两段逐字段对得上");
  eq(rn2.warnHigh, 6500, "  **报警阈值仍然是 6500**（与色带边界 6000/7000 是两回事）");
  eq(rn2.style, 0, "  样式 0（指针盘）");
  eq(rn2.min + "," + rn2.max, "0,8000", "  量程 0~8000");

  // 条形表 + 三段（原「油量绿黄红条」的形状），换到 `g_fuel` 上
  const fuelCtrl = byKey["g_fuel"];
  ok(!!fuelCtrl, "控件库里有 `g_fuel`（油量）");
  const fn = fuelCtrl.make();
  fn.style = 2;
  fn.bands = [
    { from: 0, to: 15, color: "#FF4D4F" },
    { from: 15, to: 30, color: "#FFB020" },
    { from: 30, to: 100, color: "#39D98A" },
  ];
  const fn2 = W.createNode(W.NODE_GAUGE, fn);
  eq(fn2.bands.length, 3, "条形表：3 段色带（红 / 黄 / 绿）");
  eq(canon(fn2.bands), canon([
    { from: 0, to: 15, color: "#FF4D4F", alpha: null },
    { from: 15, to: 30, color: "#FFB020", alpha: null },
    { from: 30, to: 100, color: "#39D98A", alpha: null },
  ]), "  三段逐字段对得上（低油量红、中间黄、高绿）");
  eq(fn2.style, 2, "  样式 2（条形表 —— 色带按比例画在轨道上）");

  // 走一遍往返，段不许丢
  d.nodes = [rn2, fn2];
  const rt = W.parseDesign(W.toV2Json(d));
  eq(rt.errors.length, 0, "两个表一起往返：0 错误");
  eq(canon(rt.design.nodes[0].bands), canon(rn2.bands), "  转速表的色带往返不变");
  eq(canon(rt.design.nodes[1].bands), canon(fn2.bands), "  条形表的色带往返不变");
}

// ================================================================ 7. 面板接线

console.log("\n=== 7. 属性面板接线（静态检查：函数与按钮真的存在）===");
{
  const panels = read(path.join(STUDIO, "js", "panels.js"));
  const app = read(path.join(STUDIO, "js", "app.js"));
  ["setBandField", "addBand", "delBand", "clearBands", "bandsFromWarn"].forEach(fn => {
    ok(app.indexOf("window." + fn + " = function") > 0, `\`window.${fn}\` 有实现（app.js）`);
  });
  ok(panels.indexOf("function bandFields") > 0, "面板里有 `bandFields`（色带列表编辑区）");
  ["setBandField", "addBand", "delBand", "clearBands", "bandsFromWarn"].forEach(fn => {
    ok(panels.indexOf(fn + "(") > 0, `  面板上有按钮/输入框接到 \`${fn}\``);
  });
  // 归一化的唯一入口
  ok(app.indexOf("window.normalizeBands(next") > 0,
    "所有色带写入都过 `normalizeBands`（不让「内存里合法、文件里非法」的状态存在）");
  // 绘制侧
  const canvas = read(path.join(STUDIO, "js", "canvas.js"));
  ok(canvas.indexOf("window.BAND_DEFAULT_COLOR") > 0, "绘制侧按段取色（回落 `BAND_DEFAULT_COLOR`）");
  ok(/n\.style === 2[\s\S]{0,1200}normalizeBands/.test(canvas),
    "**style 2（条形表）会画分区**（修前根本不画）");
  ok(/redlines\.forEach[\s\S]{0,600}zoneAlpha/.test(canvas), "盘面的分区也用 `zoneAlpha`（按段透明度）");
}

// ================================================================ 收尾

console.log("\n" + "=".repeat(60));
console.log("PASS=" + pass + "  FAIL=" + fail);
process.exit(fail === 0 ? 0 : 1);
