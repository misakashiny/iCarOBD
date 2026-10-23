// ============================================================================
// P5B-M03 §C：旧版主题兼容性 —— 实验数据生成
//
// 生成 4 份测试主题：
//   old-compat-1-unknown.json   含 1 个未知 type（segmentedArc）
//   old-compat-2-mixed.json     已知 + 未知混合（验证"部分丢失"）
//   old-compat-3-allnew.json    全是未知 type（验证"整份空白"）
//   old-compat-4-alarm.json     未知节点带报警语义（验证指令 §C2 特别提醒的
//                               「动态数值和报警组件缺失」）
//
// 每份都用**合法的 icar.ui/2**，只是加了旧版不认识的 type。
// 这样能精确测出：旧版是"跳过"还是"整份失败"。
// ============================================================================
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");

const mk = (id, type, x, y, w, h, extra) => Object.assign({
  id, type, name: type + "-" + id, x, y, w, h, rotation: 0, scale: 1, alpha: 255, z: 0,
  locked: false, visible: true, children: [],
}, extra || {});

const wrap = (name, nodes) => ({
  schema: "icar.ui/2",
  meta: { name, author: "P5B-M03 compat test", version: 1 },
  scaleMode: 0,
  assets: [],
  pages: [{ id: "p0", name: "主页面", nodes }],
});

// ---- 1. 单未知 type
const t1 = wrap("旧版兼容-单个未知节点", [
  mk("known1", "gauge", 8, 8, 160, 80, { pid: "obd.rpm", style: 0 }),
  // 未知 type：segmentedArc（P5B-M01 原型里的基元名）
  mk("unknown1", "segmentedArc", 8, 96, 160, 80, {
    pid: "obd.rpm", radius: 60, segmentCount: 36, startAngle: 135, sweepAngle: 270,
  }),
  mk("known2", "gauge", 176, 8, 160, 80, { pid: "obd.speed", style: 1 }),
]);
fs.writeFileSync(path.join(DIR, "old-compat-1-unknown.json"), JSON.stringify(t1, null, 2), "utf8");

// ---- 2. 已知 + 未知混合（最关键：验证部分丢失）
const t2 = wrap("旧版兼容-混合", [
  mk("k-gauge", "gauge", 8, 8, 112, 72, { pid: "obd.rpm", style: 0 }),
  mk("k-text", "text", 8, 88, 112, 20, { text: "已知文字", font: { size: 14 } }),
  mk("k-image", "image", 128, 8, 80, 80, {}),
  // 4 个未知 type —— 旧版应该全部静默丢弃
  mk("u-path", "pathProgress", 128, 96, 112, 72, { pid: "obd.load", points: [] }),
  mk("u-value", "valueText", 8, 116, 112, 40, { pid: "obd.coolant" }),
  mk("u-shape", "shape", 8, 164, 112, 60, { kind: "roundRect" }),
  mk("u-track", "track2", 128, 176, 112, 48, { pid: "obd.speed" }),
]);
fs.writeFileSync(path.join(DIR, "old-compat-2-mixed.json"), JSON.stringify(t2, null, 2), "utf8");

// ---- 3. 全是未知 type（验证整份空白）
const t3 = wrap("旧版兼容-全未知", [
  mk("a", "segmentedArc", 8, 8, 160, 80, { pid: "obd.rpm" }),
  mk("b", "pathProgress", 8, 96, 160, 80, { pid: "obd.load" }),
  mk("c", "valueText", 176, 8, 160, 80, { pid: "obd.coolant" }),
  mk("d", "shape", 176, 96, 160, 80, { kind: "circle" }),
]);
fs.writeFileSync(path.join(DIR, "old-compat-3-allnew.json"), JSON.stringify(t3, null, 2), "utf8");

// ---- 4. 未知节点带报警语义（指令 §C2 特别提醒）
const t4 = wrap("旧版兼容-未知报警组件", [
  mk("ok-gauge", "gauge", 8, 8, 160, 80, { pid: "obd.rpm", style: 0 }),
  // 这个节点在**新版**里应该是个会变红/闪的报警数值
  // 旧版不认识 → 静默丢弃 → **用户看不到任何报警**
  mk("alarm-unknown", "valueText", 8, 96, 160, 60, {
    pid: "obd.coolant",
    warnHigh: 100,
    criticalHigh: 110,
    // 模拟数据会让水温到 115（ALARM 场景）→ 新版应显示红色
    _expectNewVersion: "红色报警数值 115",
  }),
]);
fs.writeFileSync(path.join(DIR, "old-compat-4-alarm.json"), JSON.stringify(t4, null, 2), "utf8");

console.log("已生成 4 份兼容性测试主题：");
for (const f of ["old-compat-1-unknown.json", "old-compat-2-mixed.json", "old-compat-3-allnew.json", "old-compat-4-alarm.json"]) {
  const j = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  const nodes = j.pages[0].nodes;
  const known = nodes.filter((n) => ["gauge", "image", "text", "group"].includes(n.type)).length;
  const unknown = nodes.length - known;
  console.log("  " + f.padEnd(30) + " 节点 " + nodes.length + "（已知 " + known + " / 未知 " + unknown + "）");
}
