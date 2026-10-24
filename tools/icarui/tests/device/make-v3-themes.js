// P5B-M04 阶段 A1/A2：生成 v3 测试文件 + 旧版解析实测数据准备
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");

// 一个完整的 v3 主题：含四种新节点 + 旧节点
const v3 = {
  schema: "icar.ui/3",
  meta: { name: "P5B-M04 v3 兼容测试", author: "P5B-M04", version: 1 },
  scaleMode: 0,
  assets: [],
  pages: [{
    id: "p0",
    name: "主页面",
    nodes: [
      // 旧节点（应在新版正常、旧版正常）
      { id: "g1", type: "gauge", name: "旧圆盘", x: 8, y: 8, w: 100, h: 80, pid: "obd.rpm", style: 0 },
      // 四种新节点
      {
        id: "vt1", type: "valueText", name: "车速", x: 120, y: 8, w: 100, h: 40,
        pid: "obd.speed", decimals: 0, unit: "km/h", align: 1,
      },
      {
        id: "sh1", type: "shape", name: "底框", x: 8, y: 100, w: 200, h: 60,
        kind: "roundRect", fillColor: "#1B2430", strokeColor: "#3DD6FF", strokeWidth: 2, cornerRadius: 12,
      },
      {
        id: "sa1", type: "segmentedArc", name: "转速环", x: 220, y: 100, w: 130, h: 130,
        pid: "obd.rpm", minVal: 0, maxVal: 8000,
        startAngle: 135, sweepAngle: 270, segmentCount: 36, gapAngle: 1.6, thickness: 10,
      },
      {
        id: "pp1", type: "pathProgress", name: "曲线", x: 8, y: 240, w: 340, h: 100,
        pid: "obd.load",
        points: [{ x: 0, y: 1 }, { x: 0.25, y: 0.3 }, { x: 0.6, y: 0.1 }, { x: 1, y: 0.05 }],
        curve: 0, thickness: 4, gradientTo: "#00E5FF",
      },
    ],
  }],
};

// 一个最小 v3（只有 schema 不同）
const v3min = {
  schema: "icar.ui/3",
  meta: { name: "minimal v3" },
  pages: [{ id: "p0", name: "主页面", nodes: [
    { id: "g", type: "gauge", name: "表", x: 8, y: 8, w: 100, h: 80, pid: "obd.rpm" },
  ] }],
};

fs.writeFileSync(path.join(DIR, "v3-full.json"), JSON.stringify(v3, null, 2), "utf8");
fs.writeFileSync(path.join(DIR, "v3-minimal.json"), JSON.stringify(v3min, null, 2), "utf8");

console.log("已生成 v3 测试主题：");
for (const f of ["v3-full.json", "v3-minimal.json"]) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  const nodes = j.pages[0].nodes;
  const byType = {};
  nodes.forEach((n) => byType[n.type] = (byType[n.type] || 0) + 1);
  console.log("  " + f.padEnd(18) + " schema=" + j.schema + "  节点 " + nodes.length + "  " + JSON.stringify(byType));
}
