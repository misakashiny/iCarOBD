// ============================================================================
// P5A-M03 阶段 E2：轨道跨端适配测试主题（含圆角/刻度/渐变/发光/分段/纵向）
//
// 复用 `designdata-bind.json` 的做法（全部**代码绘制**，不依赖素材），
// 但把轨道的各种能力都铺开，方便逐项看：
//
//   t_h_fill   横向 填充 + 圆角 + 高光
//   t_h_band   横向 三段色带（band）
//   t_h_gloss  横向 gloss 渐变（沿短边明暗）
//   t_h_fade   横向 fade 渐变（沿长边淡出）
//   t_v_fill   纵向 填充（验证方向/圆角）
//   t_h_ticks  横向 刻度 8 段
//   t_h_seg    横向 分段 6 格
//   t_h_glow   横向 发光 + 内凹
//
// 产出两把（仅 scaleMode 不同）：tracks-stretch.icarzip / tracks-fit.icarzip
// ============================================================================
const fs = require("fs");
const path = require("path");
const { buildZip, crc32 } = require("./_zipwriter.js");

const BASE = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "android-theme", "tracks");

function track(id, name, pid, orient, x, y, w, h, extra) {
  const o = {
    id, type: "image", name, pid, x, y, w, h,
    trackStyle: Object.assign({
      orient: orient, radius: 12, band: false, gradient: null,
      inset: false, glow: false, ticks: 0, segments: 0, fill: null
    }, extra || {})
  };
  return o;
}

function buildDesign(name, scaleMode) {
  const nodes = [
    // ---- 第一排：三种填充/色带（横向）----
    track("t_h_fill", "横填充", "obd.speed", "h", 10, 20, 160, 34, { fill: 0.55 }),
    track("t_h_band", "横色带", "obd.rpm", "h", 190, 20, 160, 34, { band: true }),

    // ---- 第二排：两种渐变 ----
    track("t_h_gloss", "横 gloss", "obd.load", "h", 10, 74, 160, 34, { fill: 0.45, gradient: "gloss" }),
    track("t_h_fade", "横 fade", "obd.throttle", "h", 190, 74, 160, 34, { fill: 0.35, gradient: "fade" }),

    // ---- 第三排：刻度 / 分段（横向）----
    track("t_h_ticks", "横刻度", "obd.coolant", "h", 10, 128, 160, 34, { fill: 0.6, ticks: 8 }),
    track("t_h_seg", "横分段", "obd.speed", "h", 190, 128, 160, 34, { fill: 0.5, segments: 6 }),

    // ---- 第四排：发光+内凹（横向）与纵向 ----
    track("t_h_glow", "横发光", "obd.rpm", "h", 10, 182, 130, 34, { fill: 0.7, glow: true, inset: true }),
    track("t_v_fill", "纵向填充", "obd.coolant", "v", 300, 182, 34, 130, { fill: 0.5, radius: 16 })
  ];

  return {
    schema: "icar.ui/2",
    meta: {
      name: name, author: "P5A-M03 自动化",
      description: "代码绘制轨道全能力：填充/色带/渐变/刻度/分段/发光/纵向"
    },
    name: name,
    author: "P5A-M03 自动化",
    description: "代码绘制轨道全能力：填充/色带/渐变/刻度/分段/发光/纵向",
    themeId: "",
    canvas: { unit: 360, scaleMode: scaleMode },
    pages: [{ id: "pg0", name: "主页面", nodes: nodes }],
    pageIndex: 0,
    assets: [],
    canvases: []
  };
}

function pack(tag, name, scaleMode) {
  const dir = path.join(BASE, tag + "-src");
  fs.mkdirSync(dir, { recursive: true });
  const d = buildDesign(name, scaleMode);
  const designText = JSON.stringify(d, null, 2);
  fs.writeFileSync(path.join(dir, "design.json"), designText, "utf8");
  const designBuf = Buffer.from(designText, "utf8");
  const manifest = {
    format: "icar.pack/1",
    designSchema: "icar.ui/2",
    designName: name,
    exportedAt: new Date().toISOString(),
    design: { name: name, schema: "icar.ui/2" },
    assets: [],
    missing: []
  };
  const manText = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(dir, "manifest.json"), manText, "utf8");
  const zip = buildZip([
    { name: "design.json", data: designBuf },
    { name: "manifest.json", data: Buffer.from(manText, "utf8") }
  ]);
  const out = path.join(BASE, "tracks-" + tag + ".icarzip");
  fs.writeFileSync(out, zip);
  console.log("  tracks-" + tag + ".icarzip  " + zip.length + " bytes  scaleMode=" + scaleMode +
    "  节点=" + d.pages[0].nodes.length);
}

fs.mkdirSync(BASE, { recursive: true });
pack("stretch", "P5A-M03 轨道全能力（拉伸）", 0);
pack("fit", "P5A-M03 轨道全能力（等比）", 1);
console.log("\n轨道清单：");
buildDesign("x", 0).pages[0].nodes.forEach((n) => {
  const t = n.trackStyle;
  console.log("  " + n.id.padEnd(11) + " " + t.orient + "  " +
    [t.fill !== null ? "fill=" + t.fill : "", t.band ? "band" : "", t.gradient || "",
     t.ticks ? "ticks=" + t.ticks : "", t.segments ? "seg=" + t.segments : "",
     t.glow ? "glow" : "", t.inset ? "inset" : "", "r=" + t.radius]
      .filter(Boolean).join(" "));
});
