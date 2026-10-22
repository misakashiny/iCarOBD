// P5A-M02 阶段 D：导入子部件主题 → 各场景截图
const path = require("path");
const ui = require("./_adbui.js");
const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

const SCENES = [
  ["normal", "p5a02-parts-normal.png"],
  ["accel", "p5a02-parts-accel.png"],
  ["decel", "p5a02-parts-decel.png"],
  ["alarm", "p5a02-parts-warn.png"],
  ["critical", "p5a02-parts-critical.png"],
  ["disconnect", "p5a02-parts-disconnect.png"],
  ["recover", "p5a02-parts-recover.png"]
];

(async function () {
  ui.clearLog();
  console.log("=== 导入子部件主题 ===");
  const r = await ui.importFile("parts-gauge.icarzip");
  console.log("  结果: " + (r.ok ? "成功" : "失败") + "  标题: " + (r.title || "-"));
  console.log("  详情: " + (r.detail || "").slice(0, 260));
  if (!r.ok) process.exit(1);

  await ui.gotoCanvas();
  await ui.sleep(2500);

  // 确认导入成功（设置页文本）
  const items = await ui.gotoSettings();
  const recent = ui.find(items, "最近导入");
  console.log("  " + (recent ? recent.label : "(未找到最近导入)"));
  await ui.gotoCanvas();
  await ui.sleep(2000);

  console.log("\n=== 逐场景截图 ===");
  for (const [scenario, file] of SCENES) {
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", scenario, "--ei", "step", "5"]);
    await ui.sleep(2800);
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "dump", "1"]);
    await ui.sleep(1000);
    const bus = ui.sh(["logcat", "-d", "-s", "SimBus:I"]).split("\n")
      .map((x) => (/BUSD (std_0C|std_0D|std_05) /.test(x) ? x.replace(/^.*BUSD/, "BUSD").trim() : null))
      .filter(Boolean).slice(-3);
    const size = ui.screenshot(path.join(SHOT, file));
    console.log("  " + scenario.padEnd(11) + size + " bytes → " + file);
    bus.forEach((b) => console.log("      " + b));
  }

  console.log("\n=== 异常检查 ===");
  console.log("  前台: " + (ui.foreground() || "非App"));
  console.log("  FATAL: " + ui.fatalLogs().length);
  console.log("  设计报告（素材加载失败数）:");
  const rep = ui.sh(["logcat", "-d", "-s", "NodeTree:I", "DashRenderer:I"]).split("\n")
    .filter((x) => x.trim()).slice(-8);
  rep.forEach((l) => console.log("    " + l.trim().slice(0, 150)));
})();
