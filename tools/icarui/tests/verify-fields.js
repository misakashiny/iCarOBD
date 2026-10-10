/* ==========================================================================
   verify-fields.js —— 字段级往返保真：工具**写出去**的每个字段，自己都读得回来吗？
   --------------------------------------------------------------------------
   ## 为什么需要这个套件（v2.83.0 新建，Round 1）

   这个仓库最贵的一类 bug 有固定形态：**序列化一侧写了、解析一侧漏了**。
   已发生过两次，而且两次都是"静默"的：

   | 事故 | 写 | 漏读 | 症状 |
   |---|---|---|---|
   | v1.20.16 | `model.js` 写 `statePid` | `validate.js` 不还原 `rawStatePid` | 指示灯**永远是暗的**，用户以为车没问题 |
   | v2.83.0 | `model.js` 写 `valueLabels` | `validate.js` **从不还原** | 挡位读数从 `P/R/N/1..6` 变回 `0..8`，再存一次就把映射表从文件里抹掉 |

   两次的检测方式都是"有人碰巧看见了"。这个套件把它变成**每次都会跑**的事实：

   1. **行为面** —— 把每个内置控件模板（122 个）与一个"全字段"节点
      走一遍 `toV2Json → parseDesign → toV2Json`，**逐字段深比**。
      少一个字段就红，不需要有人想到去查它。
   2. **结构面** —— 从源码里抽出 `nodeToJson` 写出的字段名与 `parseNode`
      还原的字段名，做集合差。行为面靠样例覆盖，结构面不靠样例 ——
      罕见分支上的字段也躲不过。

   跑法：node tools/icarui/tests/verify-fields.js
   （**纯 Node，不需要浏览器** —— 这些是纯函数）
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

// ================================================================ 沙箱

/** 当前正在装配的设计 —— `ensureBuiltinAsset` 桩要往里登记素材 */
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
  // ⚠️ `ensureBuiltinAsset` 真身在 panels.js（要 DOM），这里给一个**语义等价**的桩：
  //    按 path 去重、登记进 design.assets、返回 id。与 panels.js:1504 的行为一致。
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
  // 顺序与 index.html 一致（schema → model → validate → presets）
  ["schema.js", "model.js", "validate.js", "presets.js"].forEach(f => {
    vm.runInContext(read(path.join(STUDIO, "js", f)), sandbox, { filename: f });
  });
  return sandbox;
}

const W = loadTool();

// ================================================================ 工具

/** 键排序的深拷贝 —— 只比内容，不比键序（键序无意义，比了会出假失败） */
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

/** 逐字段列出两个对象（含 children 递归）的差异 */
function diffNode(a, b, p, out) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  keys.forEach(k => {
    if (k === "children") return;
    const va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
    if (canon(va) !== canon(vb)) {
      out.push(p + "." + k + "：写出=" + JSON.stringify(va) + "  读回=" + JSON.stringify(vb));
    }
  });
  const ca = (a && a.children) || [], cb = (b && b.children) || [];
  ca.forEach((c, i) => diffNode(c, cb[i], p + ".children[" + i + "]", out));
}

/** toV2Json → parseDesign → toV2Json */
function roundTrip(design) {
  const j1 = JSON.parse(W.toV2Json(design));
  const r = W.parseDesign(JSON.stringify(j1));
  const j2 = r.design ? JSON.parse(W.toV2Json(r.design)) : null;
  return { j1, r, j2 };
}

/** 用一批节点做一次往返，返回差异列表 */
function checkNodes(nodes, label, out) {
  const d = W.createDesign({ name: "t" });
  CUR = d;
  d.nodes = nodes;
  const { j1, r, j2 } = roundTrip(d);
  if (!r.design) { out.push(label + "：解析失败 " + JSON.stringify(r.errors)); return; }
  if (r.errors.length) { out.push(label + "：解析报错 " + JSON.stringify(r.errors)); return; }
  const before = j1.nodes, after = j2.nodes;
  if (before.length !== after.length) { out.push(label + "：节点数变了 " + before.length + " → " + after.length); return; }
  before.forEach((n, i) => diffNode(n, after[i], label + "[node" + i + "]", out));
}

// ================================================================ 1. 全字段节点

console.log("=== 1. 全字段节点往返（每个类型把 schema 认的字段都填上）===");
{
  const out = [];
  const d0 = W.createDesign({ name: "sink" });
  CUR = d0;

  const gauge = W.createNode(W.NODE_GAUGE, {});
  Object.assign(gauge, {
    pid: "obd.rpm", rawPid: "obd.rpm", style: 3, min: 0, max: 8000,
    warnLow: 500, warnHigh: 6500, extraPids: ["obd.coolant", "obd.volt"],
    ringStyle: 1, ringSegments: 60, neonPreset: "强烈", cardStyle: 2,
    valueLabels: ["P", "R", "N", "D"], showLabel: false, showRange: false,
    rotation: 30, scale: 1.5, alpha: 200, locked: true, visible: false,
    parts: [W.normalizePart({ kind: "dial", assetId: "", x: 0, y: 0, w: 100, h: 100 })],
    card: { show: true, alpha: 128, radius: 12 },
    labelFont: W.normalizeFont({ family: "mono", size: 24, bold: true, color: "#FF0000" }),
  });

  const img = W.createNode(W.NODE_IMAGE, {});
  Object.assign(img, {
    assetId: "", statePid: "obd.rpm", rawStatePid: "obd.rpm",
    stateWarn: 6000, stateCritical: 7000, rotation: 15,
    states: {
      normal: { assetId: "", alpha: 120, blink: false, blinkMs: 400 },
      warn: { assetId: "", alpha: 255, blink: true, blinkMs: 400 },
      critical: { assetId: "", alpha: 255, blink: true, blinkMs: 400 },
    },
  });

  const txt = W.createNode(W.NODE_TEXT, {});
  Object.assign(txt, {
    text: "你好", rotation: -10, alpha: 77,
    font: W.normalizeFont({ family: "serif", size: 18, italic: true, color: "#00FF00" }),
  });

  const grp = W.createNode(W.NODE_GROUP, {});
  grp.rotation = 45;
  grp.children = [txt];

  checkNodes([gauge, img, grp], "sink", out);

  // 顶层段也要往返（背景 / 主题覆盖 / 画布 / 元信息）
  const d = W.createDesign({ name: "top" });
  CUR = d;
  d.nodes = [W.createNode(W.NODE_GAUGE, { pid: "obd.rpm" })];
  d.background = { path: "/sdcard/bg.png", fit: 2, w: 100, h: 50 };
  d.themeColorsOverride = { accent: "#123456" };
  const { j1, j2, r } = roundTrip(d);
  if (!r.design) out.push("顶层：解析失败 " + JSON.stringify(r.errors));
  else ["background", "themeColorsOverride", "theme", "canvas", "meta"].forEach(k => {
    if (canon(j1[k]) !== canon(j2[k])) out.push("顶层 " + k + "：写出=" + JSON.stringify(j1[k]) + "  读回=" + JSON.stringify(j2[k]));
  });

  if (out.length) out.forEach(s => console.log("       ↳ " + s));
  ok(out.length === 0, `全字段节点 + 顶层段往返逐字段一致（差异 ${out.length} 处）`);
}

// ================================================================ 2. 全部内置控件模板

console.log("\n=== 2. 122 个内置控件模板逐个往返 ===");
{
  const CTRLS = W.BUILTIN_CONTROLS || [];
  ok(CTRLS.length > 0, `读到 ${CTRLS.length} 个内置控件模板`);
  const bad = [];
  CTRLS.forEach(c => {
    const d = W.createDesign({ name: "t" });
    CUR = d;
    let node;
    try {
      node = W.instantiateControl(typeof c.make === "function" ? c.make() : c, { x: 0, y: 0 });
    } catch (e) {
      bad.push(c.key + "：实例化抛错 " + e.message);
      return;
    }
    const out = [];
    checkNodes([node], c.key, out);
    out.forEach(s => bad.push(s));
  });
  if (bad.length) bad.slice(0, 25).forEach(s => console.log("       ↳ " + s));
  if (bad.length > 25) console.log(`       ↳ …还有 ${bad.length - 25} 条`);
  ok(bad.length === 0, `全部 ${CTRLS.length} 个模板往返逐字段一致（不保真 ${bad.length} 处）`);
}

// ================================================================ 3. 具名回归：valueLabels

console.log("\n=== 3. 具名回归：数值映射表 valueLabels ===");
{
  // (a) 挡位控件自带的映射表 —— 它就是被发现漏读的那一个
  const gear = (W.BUILTIN_CONTROLS || []).find(c => c.key === "g_gear");
  ok(!!gear, "控件库里有「挡位」(g_gear)");
  if (gear) {
    const d = W.createDesign({ name: "t" });
    CUR = d;
    const n = W.instantiateControl(gear.make(), { x: 0, y: 0 });
    d.nodes = [n];
    const { j2, r } = roundTrip(d);
    eq(r.errors.length, 0, "挡位往返 0 错误");
    eq(JSON.stringify(j2 && j2.nodes[0].valueLabels), JSON.stringify(n.valueLabels),
      "挡位的 valueLabels 往返不丢（" + JSON.stringify(n.valueLabels) + "）");
    const back = r.design && r.design.nodes[0];
    ok(!!back && Array.isArray(back.valueLabels) && back.valueLabels.length === n.valueLabels.length,
      "解析回来的节点上真的有 valueLabels 数组（面板输入框才不会是空的）");
  }

  // (b) 语义：空表 / 全空串 / 越界 / 非整数 —— 与 Kotlin ValueLabels.kt 同源
  eq(W.normalizeValueLabels(undefined), null, "没写 valueLabels → null（不是 undefined）");
  eq(W.normalizeValueLabels([]), null, "空数组 → null");
  eq(W.normalizeValueLabels(["", ""]), null, "全空串 → null（等于没设）");
  eq(JSON.stringify(W.normalizeValueLabels(["a", "", ""])), '["a"]', "去掉尾部空项");
  eq(W.valueLabelFor(["P", "R", "N"], 1.4), "R", "round(1.4)=1 → R");
  eq(W.valueLabelFor(["P", "R", "N"], 4.999), "N", "4.999 夹到末项（**不是截断成 R**）");
  eq(W.valueLabelFor(["P", "R", "N"], -3), "P", "负数夹到 0");
  eq(W.valueLabelFor(null, 1), null, "没有映射表 → null（回落数字格式化）");
  eq(W.valueLabelFor(["P"], null), null, "值是 null → null");

  // (c) 往返之后 valueLabelFor 查表结果一致（行为面，不只字段面）
  const d = W.createDesign({ name: "t" });
  CUR = d;
  const g = W.createNode(W.NODE_GAUGE, { pid: "obd.rpm" });
  g.valueLabels = ["P", "R", "N", "1", "2", "3", "4", "5", "6"];
  d.nodes = [g];
  const { r } = roundTrip(d);
  const before = W.valueLabelFor(g.valueLabels, 3);
  const after = W.valueLabelFor(r.design && r.design.nodes[0].valueLabels, 3);
  eq(after, before, "往返后查表结果一致（" + before + "）");
}

// ================================================================ 4. 结构面：写 / 读 集合差

console.log("\n=== 4. 结构面：nodeToJson 写出的字段，parseNode 是否都还原 ===");
{
  const model = read(path.join(STUDIO, "js", "model.js"));
  const validate = read(path.join(STUDIO, "js", "validate.js"));

  /** 取一段源码里 `obj.FIELD =` 与对象字面量 `FIELD:` 的键（只认字面字段名） */
  function fieldsIn(src, from, to, obj) {
    const i = src.indexOf(from), j = src.indexOf(to, i + 1);
    if (i < 0) throw new Error("源码里找不到标记：" + from);
    // ⚠️ **结束标记找不到时必须炸**，不能退化成"切到文件末尾" ——
    // 那样会把后面 parseParts / parseStates 的字段也算进来，
    // 读集合变成一个超集，检查就**永远通过**了（假阴性，比不检查更糟）。
    if (j < 0) throw new Error("源码里找不到结束标记：" + to);
    const body = src.slice(i, j);
    const set = new Set();
    const re = new RegExp("\\b" + obj + "\\.([A-Za-z_$][\\w$]*)\\s*=", "g");
    let m;
    while ((m = re.exec(body))) set.add(m[1]);
    for (const m of body.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g)) set.add(m[1]);
    return set;
  }

  const written = fieldsIn(model, "function nodeToJson(", "window.nodeToJson =", "o");
  const readBack = fieldsIn(validate, "function parseNode(", "function parseParts(", "node");

  // 故意允许"写了但不单独还原"的字段，每一条都要写清理由。
  // 现在**是空的** —— 也就是说 35 个字段全部双向对齐。
  // 以后真要放行，必须在这里写清为什么，不能一句"暂时忽略"。
  const ALLOW = new Map([]);

  const missing = [...written].filter(f => !readBack.has(f) && !ALLOW.has(f));
  if (missing.length) console.log("       ↳ 写了但没还原：" + missing.join(", "));
  ok(missing.length === 0,
    `nodeToJson 写出的 ${written.size} 个字段，parseNode 都有对应还原（缺 ${missing.length} 个）`);
  // ⚠️ 这一节**反向验证过**：把 `js/validate.js` 换回 v2.82.0（修复前）的版本，
  //    它精确报出 `valueLabels` 一个；修复后报 0 个。
  //    "检查打印了错误"和"检查真的会失败"是两件事 —— 必须植入一次错误验一次。
  ALLOW.forEach((why, f) => console.log("       ℹ️ 已放行 " + f + "：" + why));
  console.log("       （写出 " + [...written].sort().join(",") + "）");
}

console.log("\n" + "=".repeat(60));
console.log("PASS=" + pass + "  FAIL=" + fail);
process.exit(fail === 0 ? 0 : 1);
