// ============================================================================
// make-m04-templates.js —— P5B-M04 §E：用四种**真基元**生成两套 v3 主题模板
//
// ## 指令 §七 的要求
//
// 模板 A：赛车分段转速仪表
//   SegmentedArc RPM 分段环 / ValueText 主转速 / 车速数字 / 水温 / BOOST /
//   电压 / 自定义背景 Shape / 可替换透明汽车素材 / 报警颜色 / 无数据状态
//
// 模板 B：综合车辆数据屏
//   PathProgress 顶部曲线进度 / RPM 数值 / 大号车速 / 挡位 / 水温 /
//   机油温度 / BOOST / Lambda 可用性提示 / 机油压力可用性提示
//
// 「**所有动态部分必须是真实控件节点，而不是整张静态图片。**」
//
// ## 数据来源五类状态（与 P5B-M01 阶段 E 纠错一致）
//
//   obd           标准 PID，一定能读
//   obd-optional  标准有定义，但车型可能不实现（如机油温度 5C）
//   calc          由其它 PID 派生（如 BOOST）
//   not-impl      标准有定义，App 未实现（如 Lambda）
//   can-only      标准就没有，需厂商 CAN/DBC（如机油压力）
//
// ## 「对于尚未确认车辆支持的 PID，应显示"支持性未确认"或"无数据"，
//     不得直接宣称本车不支持」（指令 §七）
//
// 所以 `valueText` 的 `noDataColor` 统一用灰色，且**不写**"本车不支持"这
// 类断言性文案 —— 只显示 `--`。措辞留给 App 的可用性提示层。
// ============================================================================
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");

// ---------------------------------------------------------------- 公共调色板
const C = {
  bgDeep: "#0B1118",
  panel: "#121A24",
  panelEdge: "#243040",
  text: "#FFFFFF",
  textDim: "#7D848D",
  accentPink: "#FF3D7F",
  accentCyan: "#3DD6FF",
  accentAmber: "#FFB020",
  accentRed: "#FF2D3D",
  trackOff: "#4A5058",
  pathOff: "#2A3038",
};

let idSeq = 0;
const nid = (p) => p + "_" + (++idSeq);

/** 通用节点骨架 */
function node(type, props) {
  return Object.assign({
    id: nid(type),
    type: type,
    name: props.name || type,
    x: 0, y: 0, w: 100, h: 100,
    rotation: 0, scale: 1, alpha: 255, z: 0,
  }, props);
}

/** 背景形状 */
function bgRect(name, x, y, w, h, fill, stroke, radius, z) {
  return node("shape", {
    name, x, y, w, h, z: z || 0,
    kind: radius > 0 ? "roundRect" : "rect",
    fill, stroke: stroke || "none", strokeWidth: stroke ? 1.5 : 0,
    cornerRadius: radius || 0,
  });
}

/** 分段圆环 */
function arc(name, props) {
  return node("segmentedArc", Object.assign({
    name, x: 0, y: 0, w: 130, h: 130,
    minVal: 0, maxVal: 8000,
    startAngle: 150, sweepAngle: 240,
    segmentCount: 24, gapAngle: 2, thickness: 8,
    activeColor: C.accentPink, inactiveColor: C.trackOff, noDataColor: C.accentRed,
    radiusRatio: 0.42,
  }, props));
}

/** 动态数值 */
function valueText(name, props) {
  return node("valueText", Object.assign({
    name, x: 0, y: 0, w: 80, h: 30,
    decimals: 0, size: 24, unitSize: 10, align: 1,
    color: C.text, warnColor: C.accentAmber, criticalColor: C.accentRed,
    noDataColor: C.textDim,
  }, props));
}

/** 曲线进度 */
function pathProgress(name, props) {
  return node("pathProgress", Object.assign({
    name, x: 0, y: 0, w: 340, h: 90,
    minVal: 0, maxVal: 100, curve: 0, thickness: 3,
    activeColor: C.accentCyan, inactiveColor: C.pathOff,
    gradientTo: "#00E5FF", fill: false, forward: true,
    points: [
      { x: 0, y: 0.95 }, { x: 0.18, y: 0.42 }, { x: 0.42, y: 0.14 },
      { x: 0.68, y: 0.08 }, { x: 1, y: 0.05 },
    ],
  }, props));
}

/**
 * 可用性提示文本。
 *
 * ⚠️ **不是控件**：它是 `text` 节点（v2 已有的类型），内容写死为
 * 「支持性未确认」这类中性措辞。动态数据缺值时由 valueText 自己显示 `--`。
 *
 * 为什么不直接用 valueText：指令要求「不得直接宣称本车不支持」。
 * 而 valueText 在无数据时只说 `--`，不解释原因。
 * 加一行静态说明让用户知道**这一格为什么可能是空**，比空着好。
 */
function hint(name, text, props) {
  return node("text", Object.assign({
    name, text, x: 0, y: 0, w: 90, h: 14,
    z: 5,
  }, props));
}

// ============================================================================
// 模板 A：赛车分段转速仪表
// ============================================================================

function buildRaceDash() {
  const N = [];

  // ---- 背景（自定义 Shape，不是静态图片）
  N.push(bgRect("背景", 0, 0, 360, 360, C.bgDeep, "none", 0, 0));
  // 中央六边形感受的装饰框（圆角矩形 + 描边）
  N.push(bgRect("主面板", 70, 60, 220, 220, C.panel, C.panelEdge, 24, 1));

  // ---- RPM 分段环（核心）
  N.push(arc("转速环", {
    x: 95, y: 70, w: 170, h: 170, z: 2,
    pid: "obd.rpm", minVal: 0, maxVal: 8000,
    startAngle: 135, sweepAngle: 270,
    segmentCount: 36, gapAngle: 1.6, thickness: 10,
    activeColor: C.accentPink, inactiveColor: C.trackOff, noDataColor: C.accentRed,
    radiusRatio: 0.44,
    zoneColors: [
      { at: 0, color: C.accentPink },
      { at: 0.72, color: C.accentPink },
      { at: 0.82, color: C.accentAmber },
      { at: 0.92, color: C.accentRed },
    ],
  }));

  // ---- 中央主转速
  N.push(valueText("RPM", {
    x: 130, y: 130, w: 100, h: 44, z: 3,
    pid: "obd.rpm", decimals: 0, size: 34, unitSize: 11, unit: "RPM",
    color: C.text, warnHigh: 6500, criticalHigh: 7200,
    warnColor: C.accentAmber, criticalColor: C.accentRed,
  }));

  // ---- 车速（大号）
  N.push(valueText("车速", {
    x: 130, y: 178, w: 100, h: 36, z: 3,
    pid: "obd.speed", decimals: 0, size: 28, unitSize: 11, unit: "km/h",
    color: C.accentCyan,
  }));
  N.push(hint("车速标签", "SPEED", { x: 145, y: 214, w: 70, h: 12, z: 3 }));

  // ---- 四组副参数（左右各两格）
  const subs = [
    { key: "coolant", label: "水温", pid: "obd.coolant", unit: "°C", x: 16, y: 108, w: 78,
      warnHigh: 105, criticalHigh: 115 },
    { key: "boost", label: "BOOST", pid: "calc.calc_boost", unit: "kPa", x: 16, y: 168, w: 78,
      decimals: 1 },
    { key: "volt", label: "电压", pid: "obd.voltage", unit: "V", x: 266, y: 108, w: 78,
      decimals: 1 },
    { key: "throttle", label: "节气门", pid: "obd.throttle", unit: "%", x: 266, y: 168, w: 78 },
  ];
  subs.forEach((s) => {
    N.push(valueText(s.label, {
      x: s.x, y: s.y, w: s.w, h: 26, z: 4,
      pid: s.pid, unit: s.unit,
      decimals: s.decimals || 0, size: 19, unitSize: 9,
      warnHigh: s.warnHigh, criticalHigh: s.criticalHigh,
    }));
    N.push(hint(s.label + "标签", s.label, {
      x: s.x, y: s.y + 26, w: s.w, h: 12, z: 4,
    }));
  });

  // ---- 底部装饰条（Shape）
  N.push(bgRect("底部装饰", 16, 306, 328, 3, C.accentPink, "none", 0, 2));

  // ---- 可替换透明汽车素材位（image 节点，assetId 留空由用户填充）
  N.push(node("image", {
    id: nid("img"), name: "汽车素材（可替换）",
    x: 140, y: 250, w: 80, h: 46, z: 6,
    assetId: "", rotation: 0, scale: 1, alpha: 255,
  }));

  return N;
}

// ============================================================================
// 模板 B：综合车辆数据屏
// ============================================================================

function buildDataScreen() {
  const N = [];

  N.push(bgRect("背景", 0, 0, 360, 360, C.bgDeep, "none", 0, 0));

  // ---- 顶部曲线进度（PathProgress 核心）
  N.push(pathProgress("顶部曲线", {
    x: 10, y: 8, w: 340, h: 80, z: 1,
    pid: "obd.rpm", minVal: 0, maxVal: 8000,
    thickness: 3.5, gradientTo: "#00E5FF", fill: true, fillColor: "#1A00C8FF",
  }));

  // ---- 顶部 RPM 数字（曲线旁）
  N.push(valueText("RPM", {
    x: 240, y: 8, w: 100, h: 40, z: 2,
    pid: "obd.rpm", decimals: 0, size: 26, unitSize: 10, unit: "RPM",
    align: 2, color: C.text, warnHigh: 6500, criticalHigh: 7200,
    warnColor: C.accentAmber, criticalColor: C.accentRed,
  }));
  N.push(hint("RPM标签", "转速", { x: 240, y: 46, w: 100, h: 12, align: 2, z: 2 }));

  // ---- 中央大车速
  N.push(valueText("车速", {
    x: 20, y: 96, w: 160, h: 56, z: 2,
    pid: "obd.speed", decimals: 0, size: 46, unitSize: 14, unit: "km/h",
    align: 0, color: C.text,
  }));
  N.push(hint("车速标签", "SPEED", { x: 20, y: 150, w: 100, h: 12, align: 0, z: 2 }));

  // ---- 右侧大挡位
  N.push(valueText("挡位", {
    x: 220, y: 96, w: 120, h: 56, z: 2,
    pid: "calc.calc_gear", decimals: 0, size: 44, unitSize: 12, unit: "",
    align: 2, color: C.accentCyan,
    valueLabels: null,
  }));
  N.push(hint("挡位标签", "GEAR", { x: 240, y: 150, w: 100, h: 12, align: 2, z: 2 }));

  // ---- 中部三格：水温 / 机油温度 / BOOST
  const mid = [
    { name: "水温", pid: "obd.coolant", unit: "°C", x: 20, warnHigh: 105, criticalHigh: 115,
      note: null },
    { name: "机油温度", pid: "obd.oil_temp", unit: "°C", x: 135, warnHigh: 120, criticalHigh: 140,
      note: "支持性未确认" },
    { name: "BOOST", pid: "calc.calc_boost", unit: "kPa", x: 250, decimals: 1,
      note: null },
  ];
  mid.forEach((m) => {
    N.push(valueText(m.name, {
      x: m.x, y: 186, w: 90, h: 34, z: 2,
      pid: m.pid, unit: m.unit, decimals: m.decimals || 0,
      size: 24, unitSize: 10,
      warnHigh: m.warnHigh, criticalHigh: m.criticalHigh,
    }));
    N.push(hint(m.name + "标签", m.name, { x: m.x, y: 218, w: 90, h: 12, z: 2 }));
    if (m.note) {
      // 「不得直接宣称本车不支持」→ 用中性的"支持性未确认"
      N.push(hint(m.name + "提示", m.note, { x: m.x, y: 230, w: 90, h: 10, z: 2 }));
    }
  });

  // ---- 底部两格：Lambda 可用性 / 机油压力可用性
  //
  // ⚠️ 这两项**没有标准可读数**：
  //   · Lambda   标准有（01 24-2B），但 App 未实现 → 只能显示提示
  //   · 机油压力 标准就没有（需厂商 CAN/DBC）→ 只能显示提示
  // 所以右下角用**说明文字**而不是 valueText（后者会显示 `--` 让人以为"只是没数据"）。
  N.push(hint("Lambda提示一", "Lambda", { x: 20, y: 258, w: 90, h: 14, z: 2 }));
  N.push(hint("Lambda提示二", "暂未实现", { x: 20, y: 274, w: 90, h: 12, z: 2 }));

  N.push(hint("油压提示一", "机油压力", { x: 250, y: 258, w: 90, h: 14, z: 2 }));
  N.push(hint("油压提示二", "需 CAN/DBC", { x: 250, y: 274, w: 90, h: 12, z: 2 }));

  // ---- 底部进度条（第二个 PathProgress，验证多实例）
  N.push(pathProgress("底部进度", {
    x: 20, y: 300, w: 320, h: 44, z: 1,
    pid: "obd.load", minVal: 0, maxVal: 100,
    thickness: 4, activeColor: C.accentAmber, gradientTo: "#FF8A00",
    fill: false,
    points: [
      { x: 0, y: 0.9 }, { x: 0.3, y: 0.45 }, { x: 0.62, y: 0.2 }, { x: 1, y: 0.3 },
    ],
  }));

  return N;
}

// ============================================================================
// 输出
// ============================================================================

function wrap(name, nodes) {
  return {
    schema: "icar.ui/3",
    meta: { name: name, author: "P5B-M04", description: "用四种 v3 高级基元构建的可编辑模板" },
    canvas: {
      unit: 360, designW: 2560, designH: 1600, scaleMode: 0,
      note: "每轴 0..360。x/y 是左上角（相对父节点），w/h 是尺寸；rotation 绕自身中心",
    },
    nodes: nodes,
  };
}

const race = wrap("P5B-M04 模板A 赛车转速", buildRaceDash());
idSeq = 0;
const data = wrap("P5B-M04 模板B 综合数据屏", buildDataScreen());

fs.writeFileSync(path.join(DIR, "p5b04-template-race.json"), JSON.stringify(race, null, 2), "utf8");
fs.writeFileSync(path.join(DIR, "p5b04-template-data.json"), JSON.stringify(data, null, 2), "utf8");

for (const [f, o] of [["p5b04-template-race.json", race], ["p5b04-template-data.json", data]]) {
  const byType = {};
  o.nodes.forEach((n) => { byType[n.type] = (byType[n.type] || 0) + 1; });
  const prims = ["valueText", "shape", "segmentedArc", "pathProgress"]
    .reduce((a, t) => a + (byType[t] || 0), 0);
  console.log("  " + f.padEnd(30) + " schema=" + o.schema + "  节点 " + o.nodes.length +
    "  基元 " + prims + "  " + JSON.stringify(byType));
}
