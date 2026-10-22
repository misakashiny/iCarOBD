// ============================================================================
// P5A-M02 阶段 D：生成「子部件（GaugeParts）数据绑定」测试素材 + 设计包
//
// ## 审计结论（决定这个主题怎么写）
//
// `DesignNode.GaugePart.parseAll`：
//   · **只有 `needle` 与 `value` 会解析 `pid`**，其余 kind 一律 `pid=""`
//     → 「带 PID 的子部件」只能做成指针或数字读数
//   · `children` 递归解析，深度上限 5；子部件 x/y 相对**父部件 pivot**
//   · `dial`/`ticks`/`needle`/`decor` 必须有 `assetId`，`value` 不用
//   · 支持 alpha / rotation / pivotX/Y / sweepFrom/To / sweepFollow
//
// ## 三个表的用途
//
//   gA 单针 + 数字：主 PID = 转速（验证「主 PID 对应值」）
//   gB 双针 + 双数字：指针各自绑 转速 / 车速（验证「子部件独立 PID」+ 量程各自跟随）
//   gC 单针(水温) + **嵌套子部件**（指针上挂一颗亮点，绕轴心转）
//      + 一个 rotation/alpha 变换过的装饰（验证变换与层级）
//
// 素材全部程序生成，仅测试用。
// ============================================================================
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { buildZip, crc32 } = require("./_zipwriter.js");

const OUT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "android-theme", "parts-gauge");
const SRC = path.join(OUT, "src");
const ASSETS = path.join(SRC, "assets");

// ---------------------------------------------------------------- PNG 基础

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const cb = Buffer.alloc(4);
  const c = zlib.crc32 ? zlib.crc32(Buffer.concat([tb, data])) : 0;
  cb.writeUInt32BE(c >>> 0, 0);
  return Buffer.concat([len, tb, data, cb]);
}

function encodeRGBA(w, h, px) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function canvas(w, h) {
  return { w, h, px: Buffer.alloc(w * h * 4, 0) };
}
function setPx(cv, x, y, r, g, b, a) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  cv.px[i] = r; cv.px[i + 1] = g; cv.px[i + 2] = b; cv.px[i + 3] = a === undefined ? 255 : a;
}

/** 表盘底：深色圆 + 亮色外环 */
function makeDial() {
  const S = 256;
  const cv = canvas(S, S);
  const c = S / 2 - 0.5, R = S / 2 - 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - c, y - c);
    if (d > R) continue;
    if (d > R - 6) setPx(cv, x, y, 78, 132, 200);          // 外环蓝
    else setPx(cv, x, y, 18, 22, 30);                       // 盘面深灰
  }
  return cv;
}

/** 刻度：12 条白色短线，绕成 135°..405° */
function makeTicks() {
  const S = 256;
  const cv = canvas(S, S);
  const c = S / 2 - 0.5, R = S / 2 - 14;
  for (let i = 0; i <= 12; i++) {
    const ang = (135 + (270 * i) / 12) * Math.PI / 180;
    for (let t = 0; t < 16; t++) {
      const r = R - t;
      for (let w = -2; w <= 2; w++) {
        const x = c + Math.cos(ang) * r - Math.sin(ang) * w;
        const y = c + Math.sin(ang) * r + Math.cos(ang) * w;
        setPx(cv, x, y, 235, 240, 250);
      }
    }
  }
  return cv;
}

/** 指针：水平长条（轴心在左侧 0.06 处），亮橙 */
function makeNeedle() {
  const W = 200, H = 20;
  const cv = canvas(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cy = Math.abs(y - (H / 2 - 0.5));
    if (cy > H / 2 - 2) continue;
    // 越靠尖越细
    const half = (H / 2 - 2) * (1 - Math.pow(x / W, 2.2));
    if (cy <= half) setPx(cv, x, y, 255, 140, 40);
  }
  // 轴心圆
  for (let y = 0; y < H; y++) for (let x = 0; x < 24; x++) {
    if (Math.hypot(x - 12, y - (H / 2 - 0.5)) <= 8) setPx(cv, x, y, 255, 220, 120);
  }
  return cv;
}

/** 装饰亮点（嵌套子部件用，颜色刻意与指针不同便于像素判定） */
function makeDot() {
  const S = 40;
  const cv = canvas(S, S);
  const c = S / 2 - 0.5;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - c, y - c);
    if (d <= 14) setPx(cv, x, y, 80, 240, 220);   // 青色
    if (d <= 6) setPx(cv, x, y, 255, 255, 255);
  }
  return cv;
}

/** 角标装饰（验证 rotation / alpha） */
function makeCorner() {
  const S = 48;
  const cv = canvas(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (x < 8 || y < 8) setPx(cv, x, y, 210, 80, 220);   // 紫色 L 形
    else if (x > S - 9 || y > S - 9) setPx(cv, x, y, 210, 80, 220);
  }
  return cv;
}

// ---------------------------------------------------------------- 设计文件

function part(kind, aid, x, y, w, h, extra) {
  const o = { kind, assetId: aid, x, y, w, h };
  if (extra) Object.assign(o, extra);
  return o;
}

function gaugeNode(id, name, x, y, w, h, pid, parts, extra) {
  const o = {
    id, type: "gauge", name, pid, x, y, w, h,
    label: name, unit: "",
    cardStyle: 0, neonPreset: 0, ringStyle: 0, ringSegments: 1,
    showLabel: false, showRange: false,
    parts
  };
  if (extra) Object.assign(o, extra);
  return o;
}

// PID 的真实量程（与 BuiltInPids 一致）。
//
// ⚠️ **必须写到 gauge 节点上**：`GaugePartsView.valueRangeOf()` 对
// 「指针没显式绑 pid」的情况用**节点自己的 min/max**（GaugeItem.fromJson
// 默认 0..100）。转速 800 已经 ≥100 → 指针会被钉在端点不动。
// 这是文档化的既有语义（"没绑就回落仪表节点自己的"），不是缺陷；
// 但用 parts 拼表时漏写量程是个很容易踩的坑，已登记为工具侧改进建议。
const RANGE = {
  "obd.rpm": { min: 0, max: 8000 },
  "obd.speed": { min: 0, max: 260 },
  "obd.coolant": { min: -40, max: 215 }
};

function buildDesign() {
  // ---- gA：单针 + 数字（主 PID = 转速）
  const gA = gaugeNode("gA", "单针表", 10, 20, 150, 150, "obd.rpm", [
    part("dial", "a_dial", 0, 0, 150, 150),
    part("ticks", "a_ticks", 0, 0, 150, 150),
    part("needle", "a_needle", 75, 75, 130, 13,
      { pivotX: 0.06, pivotY: 0.5, sweepFrom: 135, sweepTo: 405 }),
    part("value", "", 25, 95, 100, 34, { pid: "obd.rpm" })
  ], RANGE["obd.rpm"]);

  // ---- gB：双针 + 双数字（指针各自绑 转速 / 车速）
  const gB = gaugeNode("gB", "双针表", 200, 20, 150, 150, "obd.rpm", [
    part("dial", "a_dial", 0, 0, 150, 150),
    part("ticks", "a_ticks", 0, 0, 150, 150),
    // 针1：转速（长）
    part("needle", "a_needle", 75, 75, 130, 13,
      { pid: "obd.rpm", pivotX: 0.06, pivotY: 0.42, sweepFrom: 135, sweepTo: 405 }),
    // 针2：车速（短，绑另一个 PID，量程自动跟随 std_0D）
    part("needle", "a_needle", 75, 75, 96, 10,
      { pid: "obd.speed", pivotX: 0.06, pivotY: 0.58, sweepFrom: 135, sweepTo: 405 }),
    part("value", "", 5, 100, 90, 26, { pid: "obd.rpm" }),
    part("value", "", 85, 100, 60, 26, { pid: "obd.speed" })
  ], RANGE["obd.rpm"]);

  // ---- gC：单针(水温) + 嵌套子部件（指针上挂亮点）+ 变换装饰
  const gC = gaugeNode("gC", "嵌套表", 105, 200, 150, 150, "obd.coolant", [
    part("dial", "a_dial", 0, 0, 150, 150),
    part("ticks", "a_ticks", 0, 0, 150, 150),
    part("needle", "a_needle", 75, 75, 120, 12, {
      pid: "obd.coolant", pivotX: 0.06, pivotY: 0.5,
      // 嵌套：子部件以父 pivot 为原点 → (0,0) = 轴心
      children: [
        part("decor", "a_dot", -12, -12, 24, 24, { alpha: 255 }),
        // 再嵌一层：亮点外侧再挂一个角标（验证 3 层）
        part("decor", "a_corner", 40, -8, 16, 16, { rotation: 45, alpha: 200 })
      ]
    }),
    // 独立变换装饰：旋转 30° + 半透明
    part("decor", "a_corner", 2, 2, 22, 22, { rotation: 30, alpha: 150 }),
    part("value", "", 35, 100, 80, 30, { pid: "obd.coolant" })
  ], RANGE["obd.coolant"]);

  return {
    schema: "icar.ui/2",
    meta: {
      name: "P5A-M02 子部件数据绑定测试",
      author: "P5A-M02 自动化",
      description: "dial/ticks/needle/value/decor + 子部件独立 PID + 嵌套 children + 变换"
    },
    name: "P5A-M02 子部件数据绑定测试",
    author: "P5A-M02 自动化",
    description: "dial/ticks/needle/value/decor + 子部件独立 PID + 嵌套 children + 变换",
    themeId: "",
    pages: [{ id: "pg0", name: "主页面", nodes: [gA, gB, gC] }],
    pageIndex: 0,
    assets: [
      { id: "a_dial", name: "盘面", kind: "custom", path: "assets/dial.png", w: 256, h: 256 },
      { id: "a_ticks", name: "刻度", kind: "custom", path: "assets/ticks.png", w: 256, h: 256 },
      { id: "a_needle", name: "指针", kind: "custom", path: "assets/needle.png", w: 200, h: 20 },
      { id: "a_dot", name: "亮点", kind: "custom", path: "assets/dot.png", w: 40, h: 40 },
      { id: "a_corner", name: "角标", kind: "custom", path: "assets/corner.png", w: 48, h: 48 }
    ],
    canvases: []
  };
}

// ---------------------------------------------------------------- 主流程

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });

  const files = {
    "dial.png": makeDial(),
    "ticks.png": makeTicks(),
    "needle.png": makeNeedle(),
    "dot.png": makeDot(),
    "corner.png": makeCorner()
  };
  const bytes = {};
  Object.keys(files).forEach((n) => {
    const cv = files[n];
    const buf = encodeRGBA(cv.w, cv.h, cv.px);
    fs.writeFileSync(path.join(ASSETS, n), buf);
    bytes[n] = buf;
    console.log("  " + n.padEnd(12) + cv.w + "×" + cv.h + "  " + buf.length + " bytes");
  });

  const design = buildDesign();
  fs.writeFileSync(path.join(SRC, "design.json"), JSON.stringify(design, null, 2), "utf8");

  // manifest：refs 收集所有引用该素材的节点 id（部件也算）
  const refs = {};
  design.assets.forEach((a) => { refs[a.id] = []; });
  function collect(nodes, nodeId, out) {
    nodes.forEach((p) => {
      if (p.assetId && out[p.assetId] && out[p.assetId].indexOf(nodeId) < 0) out[p.assetId].push(nodeId);
      if (p.children) collect(p.children, nodeId, out);
    });
  }
  design.pages[0].nodes.forEach((n) => {
    if (n.assetId && refs[n.assetId]) refs[n.assetId].push(n.id);
    if (n.parts) collect(n.parts, n.id, refs);
  });

  const manifest = {
    format: "icar.pack/1",
    designSchema: "icar.ui/2",
    designName: design.name,
    exportedAt: new Date().toISOString(),
    design: { name: design.name, schema: "icar.ui/2" },
    assets: design.assets.map((a) => {
      const n = a.path.replace("assets/", "");
      return {
        path: a.path, assetId: a.id, refs: refs[a.id],
        bytes: bytes[n].length, crc32: crc32(bytes[n]), w: a.w, h: a.h
      };
    }),
    missing: []
  };
  fs.writeFileSync(path.join(SRC, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const entries = [
    { name: "design.json", data: fs.readFileSync(path.join(SRC, "design.json")) },
    { name: "manifest.json", data: fs.readFileSync(path.join(SRC, "manifest.json")) }
  ].concat(design.assets.map((a) => ({
    name: a.path,
    data: fs.readFileSync(path.join(SRC, a.path))
  })));
  const zip = buildZip(entries);
  fs.writeFileSync(path.join(OUT, "parts-gauge.icarzip"), zip);

  const partCount = design.pages[0].nodes.reduce((s, n) => s + (n.parts ? n.parts.length : 0), 0);
  console.log("");
  console.log("表数: " + design.pages[0].nodes.length + "  顶层部件: " + partCount);
  console.log("设计包: " + zip.length + " bytes → parts-gauge.icarzip");
}

main();
