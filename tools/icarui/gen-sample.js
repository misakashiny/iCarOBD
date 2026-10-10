/* ==========================================================================
   gen-sample.js —— 用工具**自己的代码**生成示例设计文件
   --------------------------------------------------------------------------
   为什么不手写 JSON：手写的示例很容易与解析器脱节（改了字段忘了改示例），
   而示例恰恰是"格式长什么样"的权威示范。这里直接调工具的 createNode /
   toV2Json，产出的东西**一定**能被工具自己解析。

   产出两份：
     sample.json     —— **v1**，App 当前版本能直接读（Kotlin 测试要求 0 错误 0 警告）
     sample-v2.json  —— **v2**，展示图片 / 状态系统 / 分组 / 变换（阶段 2 后 App 才能读）

   跑法：node tools/icarui/gen-sample.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const STUDIO = __dirname;

function loadTool() {
  const sandbox = {
    console, JSON, Math, Object, Array, String, Number, Boolean, Date, Set, Map,
    isNaN, parseInt, parseFloat,
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
    document: { getElementById: () => null, createElement: () => ({ style: {}, appendChild() { }, addEventListener() { }, getContext: () => null }), addEventListener: () => { }, readyState: "complete" },
    setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame: () => 0,
    performance: { now: () => 0 },
    alert: () => { }, confirm: () => true,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  ["schema.js", "model.js", "validate.js", "presets.js"].forEach(f => {
    vm.runInContext(fs.readFileSync(path.join(STUDIO, "js", f), "utf8"), sandbox, { filename: f });
  });
  return sandbox;
}

const T = loadTool();

/** 建一份"展示 v2 全部能力"的设计 */
function buildV2() {
  const d = T.createDesign({
    name: "示例主题 · v2 全能力",
    author: "iCarOBD",
    description: "演示控件树 / 图片 / 状态系统 / 旋转 / 分组 / 设计分辨率。素材图片需自行放到 assets/ 下。",
    designW: 2560,
    designH: 1600,
    scaleMode: T.SCALE_STRETCH,
    themeId: "neon",
  });

  // 素材清单（示例里给两个占位，用户把自己的图放进去即可）
  d.assets = [
    { id: "as_bg", name: "碳纤维底.png", kind: "background", path: "assets/carbon.png", w: 2560, h: 1600, bytes: 0 },
    { id: "as_needle", name: "指针.png", kind: "needle", path: "assets/needle.png", w: 64, h: 240, bytes: 0 },
    { id: "as_lamp_off", name: "故障灯-灭.png", kind: "warning", path: "assets/lamp_off.png", w: 64, h: 64, bytes: 0 },
    { id: "as_lamp_warn", name: "故障灯-警告.png", kind: "warning", path: "assets/lamp_warn.png", w: 64, h: 64, bytes: 0 },
    { id: "as_lamp_crit", name: "故障灯-严重.png", kind: "warning", path: "assets/lamp_crit.png", w: 64, h: 64, bytes: 0 },
  ];
  d.background = { path: "assets/carbon.png", fit: T.FIT_FILL };

  const nodes = [];

  // 1) 背景图（铺满，层级最底）
  nodes.push(T.createNode(T.NODE_IMAGE, {
    name: "背景图", assetId: "as_bg", x: 0, y: 0, w: 360, h: 360, z: 0, alpha: 255,
  }));

  // 2) 转速：分组包住表盘 + 一个旋转过的指针图（演示分组变换与图片叠加）
  const rpmGroup = T.createNode(T.NODE_GROUP, {
    name: "转速组", x: 8, y: 8, w: 200, h: 200, z: 10,
  });
  rpmGroup.children.push(T.createNode(T.NODE_GAUGE, {
    name: "转速表盘", pid: "obd.rpm", style: 0, min: 0, max: 8000,
    warnHigh: 6500, x: 0, y: 0, w: 200, h: 200, z: 0, ringStyle: 1, ringSegments: 40,
    neonPreset: "强烈",
  }));
  rpmGroup.children.push(T.createNode(T.NODE_IMAGE, {
    name: "指针", assetId: "as_needle", x: 88, y: 20, w: 24, h: 80,
    // 旋转 30° + 放大 1.15× —— 示例必须**真的演示**这两个能力，
    // 否则"支持旋转/缩放"这句话在示例里看不出来
    rotation: 30, scale: 1.15, alpha: 230, z: 1,
  }));
  nodes.push(rpmGroup);

  // 3) 车速：数字样式，轻微旋转（演示"指针不能斜着装"这个限制被解除）
  nodes.push(T.createNode(T.NODE_GAUGE, {
    name: "车速", pid: "obd.speed", style: 1, min: 0, max: 260, warnHigh: 120,
    x: 212, y: 8, w: 140, h: 92, z: 11, cardStyle: 1,
  }));

  // 4) 水温：条形 + 半透明（演示 alpha）
  nodes.push(T.createNode(T.NODE_GAUGE, {
    name: "水温", pid: "obd.coolant", style: 2, min: -40, max: 215,
    warnLow: 60, warnHigh: 105, x: 212, y: 104, w: 140, h: 48, z: 11, alpha: 200,
  }));

  // 5) 状态灯组：三个灯，各自用状态系统
  const lampGroup = T.createNode(T.NODE_GROUP, {
    name: "警告灯组", x: 8, y: 216, w: 200, h: 60, z: 12,
  });
  const lamps = [
    ["发动机故障灯", "obd.coolant", 0],
    ["机油压力灯", "obd.rpm", 68],
    ["电池灯", "obd.voltage", 136],
  ];
  lamps.forEach(([name, pid, x], i) => {
    const n = T.createNode(T.NODE_IMAGE, {
      name: name, assetId: "as_lamp_off", statePid: pid,
      x: x, y: 8, w: 44, h: 44, z: i,
    });
    n.states = {
      normal: { assetId: "as_lamp_off", alpha: 77, blink: false, blinkMs: 200 },
      warn: { assetId: "as_lamp_warn", alpha: 255, blink: false, blinkMs: 200 },
      critical: { assetId: "as_lamp_crit", alpha: 255, blink: true, blinkMs: 200 },
    };
    lampGroup.children.push(n);
  });
  nodes.push(lampGroup);

  // 6) 静态文字（演示 text 节点）
  nodes.push(T.createNode(T.NODE_TEXT, {
    name: "标题", text: "iCar OBD", x: 212, y: 300, w: 140, h: 24,
    fontSize: 20, color: "#00D8FF", bold: true, z: 13,
  }));

  // 7) 锁定的装饰线（演示 locked：位置固定，不会被误拖）
  nodes.push(T.createNode(T.NODE_TEXT, {
    name: "装饰线（已锁定）", text: "———————————", x: 212, y: 328, w: 140, h: 18,
    fontSize: 14, color: "#2A3547", locked: true, z: 13,
  }));

  // 8) 旋转的分组（演示"成组变换"：整个分组倾斜 12°，子节点跟着转）
  const badge = T.createNode(T.NODE_GROUP, {
    name: "旋转徽标组", x: 300, y: 300, w: 52, h: 52,
    rotation: 12, z: 14,
  });
  badge.children.push(T.createNode(T.NODE_TEXT, {
    name: "徽标文字", text: "OBD", x: 0, y: 0, w: 52, h: 52,
    fontSize: 16, color: "#7C5CFF", bold: true, z: 0,
  }));
  nodes.push(badge);

  d.nodes = nodes;
  return d;
}

/**
 * v1 示例：**App 当前版本能直接读**，也是 `ThemeStudioSampleTest` 的验收对象。
 *
 * ⚠️ 这份内容被 Kotlin 测试逐条断言（名称、6 块表、每块的 pid/style/坐标/
 * cardStyle/ringStyle/量程/阈值、以及"恰好一条背景警告"）。
 * 改这里**必须同时看** `app/src/test/java/com/icar/obd/data/ThemeStudioSampleTest.kt`，
 * 否则单测会挂 —— 而那不是测试太严，是这个文件本来就是"格式示范"。
 *
 * 关键数值（抄自 PidModels.kt / DesignFile.kt）：
 *   STYLE_CIRCLE=0 STYLE_DIGITAL=1 STYLE_BAR=2
 *   RING_NONE=0 RING_TICK=1
 *   CARD_THEME=0 CARD_NO_BORDER=1 CARD_TRANSPARENT=2 CARD_NONE=3
 *   FIT_FILL=0 FIT_FIT=1 FIT_CENTER=2
 */
function buildV1() {
  const gauges = [
    // 大盘：不画卡片 + 指针环 + 强烈霓虹
    {
      pid: "obd.rpm", style: 0, min: 0, max: 8000, warnHigh: 6500,
      x: 0, y: 0, w: 240, h: 240,
      ringStyle: 1, ringSegments: 40, neonPreset: "强烈", cardStyle: 2,
    },
    // 车速：数字样式，跟随主题卡片
    { pid: "obd.speed", style: 1, min: 0, max: 260, warnHigh: 120, x: 240, y: 0, w: 120, h: 120 },
    // 电压：带**下限**报警（v1.10.1 起下限也进 alertLevel）
    {
      pid: "obd.voltage", style: 0, min: 0, max: 20, warnLow: 11.8, warnHigh: 15.2,
      x: 240, y: 120, w: 120, h: 120,
    },
    // 水温：条形 + 上下限
    {
      pid: "obd.coolant", style: 2, min: -40, max: 215, warnLow: 60, warnHigh: 105,
      x: 0, y: 240, w: 180, h: 60,
    },
    // 节气门：条形
    { pid: "obd.throttle", style: 2, min: 0, max: 100, x: 180, y: 240, w: 180, h: 60 },
    // 负荷：数字 + 无边框卡片
    { pid: "obd.load", style: 1, min: 0, max: 100, x: 240, y: 240, w: 120, h: 120, cardStyle: 1 },
  ];
  return {
    schema: T.SCHEMA_V1,
    meta: {
      name: "赛道模式",
      author: "iCarOBD",
      description: "示例：混合盘面（圆表 + 数字 + 条形），带指针环、霓虹档位与卡片外框覆盖。",
    },
    theme: "neon",
    canvas: { unit: T.CANVAS, note: "每轴 0..360。x/y 是左上角，w/h 是尺寸" },
    // 路径是**设备上**的，开发机上不存在 → App 会给一条警告（这正是要验证的行为）
    background: { path: "/sdcard/icar-bg/carbon.png", fit: T.FIT_FILL },
    gauges: gauges,
  };
}

// ---- 写出 + 自校验（产出必须能被自己解析，否则不写文件）
function write(name, text) {
  const r = T.parseDesign(text);
  if (r.errors.length) {
    console.error("❌ " + name + " 自校验失败：");
    r.errors.forEach(e => console.error("   " + e));
    process.exit(1);
  }
  const p = path.join(STUDIO, name);
  fs.writeFileSync(p, text + "\n", "utf8");
  const n = name === "sample.json" ? r.design.nodes.length
    : T.flatten(r.design.nodes).length;
  console.log("✅ " + name + "  " + text.length + " 字节  " +
    (name === "sample.json" ? r.design.nodes.length + " 个仪表" : n + " 个节点") +
    "  警告 " + r.warnings.length + " 条");
  r.warnings.forEach(w => console.log("     ⚠️ " + w));
}

console.log("生成示例文件（用工具自己的代码，保证可解析）\n");
write("sample.json", JSON.stringify(buildV1(), null, 2));
write("sample-v2.json", T.toV2Json(buildV2()));
console.log("\n完成。");
