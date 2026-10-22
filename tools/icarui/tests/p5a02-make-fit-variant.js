// ============================================================================
// P5A-M02 阶段 E：从 parts-gauge 生成「等比缩放（FIT）」对照设计包
//
// ⚠️ **scaleMode 必须放在 `canvas` 对象里** ——
//    `DesignFile.parse` 用的是 `canvas?.optInt("scaleMode", SCALE_STRETCH)`，
//    写在顶层会被静默忽略（第一版就踩了：包导进去了、仍是 STRETCH）。
// ============================================================================
const fs = require("fs");
const path = require("path");
const { buildZip } = require("./_zipwriter.js");

const BASE = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "android-theme", "parts-gauge");
const SRC = path.join(BASE, "src");
const OUT = path.join(BASE, "fit-src");

const d = JSON.parse(fs.readFileSync(path.join(SRC, "design.json"), "utf8"));
d.canvas = Object.assign({}, d.canvas || {}, { unit: 360, scaleMode: 1 });  // 1 = SCALE_FIT
delete d.scaleMode;                                                          // 顶层那个是无效的，删掉免误导
d.name = "P5A-M02 子部件（等比缩放）";
if (d.meta) d.meta.name = d.name;

fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
fs.writeFileSync(path.join(OUT, "design.json"), JSON.stringify(d, null, 2), "utf8");

const m = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
m.designName = d.name;
if (m.design) m.design.name = d.name;
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(m, null, 2), "utf8");

d.assets.forEach(function (a) {
  const dst = path.join(OUT, a.path);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(SRC, a.path), dst);
});

const names = ["design.json", "manifest.json"].concat(d.assets.map((a) => a.path));
const zip = buildZip(names.map((n) => ({ name: n, data: fs.readFileSync(path.join(OUT, n)) })));
fs.writeFileSync(path.join(BASE, "parts-gauge-fit.icarzip"), zip);

console.log("FIT 包: " + zip.length + " bytes");
console.log("canvas 段: " + JSON.stringify(d.canvas));
console.log("设计名: " + d.name);
