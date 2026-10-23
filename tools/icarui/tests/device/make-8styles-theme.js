// ============================================================================
// make-8styles-theme.js —— 生成"8 档样式"跨端对比用主题（P5B-M01 阶段 C）
//
// 产出：docs/02_验证记录/android-theme/p5b01-8styles.json
//
// 为什么单独做一个主题：既有 android-theme/design.json 只有 1 个 gauge，
// 无法一次对比 8 档 style。这里放 8 个 gauge（style 0..7），
// 每个都绑能出值的 PID，方便在模拟器上一屏看全。
// ============================================================================
const fs = require("fs");
const path = require("path");

// __dirname = tools/icarui/tests/device → 上溯 4 层到仓库根
const OUT = path.join(__dirname, "..", "..", "..", "..", "docs", "02_验证记录", "android-theme", "p5b01-8styles.json");

// 8 个表盘：每个 style 一个，2 行 × 4 列排布（画布 360×360）
// style 4/5/6 是"数值格"，需要副参数 PID 才有意义
const NODES = [
  { style: 0, pid: "obd.rpm",      extra: [],                                   label: "0 圆盘" },
  { style: 1, pid: "obd.speed",    extra: [],                                   label: "1 数字" },
  { style: 2, pid: "obd.coolant",  extra: [],                                   label: "2 条形" },
  { style: 3, pid: "obd.rpm",      extra: [],                                   label: "3 折线" },
  { style: 4, pid: "obd.voltage",  extra: ["obd.throttle"],                     label: "4 双叠" },
  { style: 5, pid: "obd.rpm",      extra: ["obd.speed", "obd.coolant", "obd.load"], label: "5 四联" },
  { style: 6, pid: "obd.speed",    extra: ["obd.rpm", "obd.intake"],            label: "6 子双" },
  { style: 7, pid: "calc.gforce",  extra: ["calc.gx", "calc.gy"],               label: "7 G力" },
];

const W = 172, H = 72;   // 2 列 × 4 行，8 个一屏可见
const PAD = 8;
const ROW_GAP = 8;

const nodes = NODES.map(function (d, i) {
  const col = i % 2;
  const row = Math.floor(i / 2);
  const n = {
    id: "style" + d.style,
    type: "gauge",
    name: d.label,
    x: PAD + col * (W + PAD),
    y: 20 + row * (H + ROW_GAP),
    w: W, h: H,
    z: 10 + i,
    alpha: 255,
    rotation: 0,
    scale: 1,
    pid: d.pid,
    style: d.style,
    min: 0,
    max: 8000,
    warnHigh: 6500,
    warnLow: null,
    cardStyle: 0,
  };
  // 按 PID 设更合适的量程
  const RANGE = {
    "obd.rpm": [0, 8000], "obd.speed": [0, 260], "obd.coolant": [-40, 130],
    "obd.voltage": [0, 20], "obd.load": [0, 100], "obd.throttle": [0, 100],
    "obd.intake": [-40, 100], "calc.gforce": [0, 1.5], "calc.gx": [-1.5, 1.5],
    "calc.gy": [-1.5, 1.5],
  };
  if (RANGE[d.pid]) { n.min = RANGE[d.pid][0]; n.max = RANGE[d.pid][1]; }
  if (d.extra.length) n.extraPids = d.extra;
  return n;
});

// 每个表盘上方加一个文字标签（说明这是第几档）
const labels = NODES.map(function (d, i) {
  const col = i % 2;
  const row = Math.floor(i / 2);
  return {
    id: "label" + d.style,
    type: "text",
    x: PAD + col * (W + PAD),
    y: 20 + row * (H + ROW_GAP) - 12,
    w: W, h: 11,
    z: 30 + i,
    alpha: 255, rotation: 0, scale: 1,
    text: d.label,
    font: { size: 9, family: "sans", weight: 700, color: "#8FA0B8", align: "center" },
  };
});

const design = {
  schema: "icar.ui/2",
  meta: { name: "P5B-M01 八档样式对比", author: "P5B-M01", description: "style 0..7 各一个，用于跨端外观核对" },
  canvas: { unit: 360, designW: 360, designH: 360, scaleMode: 1, note: "每轴 0..360" },
  pages: [
    { name: "八档", nodes: labels.concat(nodes) },
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(design, null, 2), "utf8");
console.log("已生成 " + path.basename(OUT));
console.log("  节点数：" + design.pages[0].nodes.length + "（8 标签 + 8 表盘）");
NODES.forEach(function (d) { console.log("    style " + d.style + "  " + d.label.padEnd(8) + " pid=" + d.pid); });
