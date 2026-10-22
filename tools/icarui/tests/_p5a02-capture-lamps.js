// P5A-M02 阶段 C：状态灯三态逐场景截图（导入已完成后的采集部分）
const path = require("path");
const fs = require("fs");
const ui = require("./_adbui.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

const SCENES = [
  ["normal", "p5a02-lamp-normal.png"],
  ["alarm", "p5a02-lamp-warn.png"],
  ["critical", "p5a02-lamp-critical.png"],
  ["disconnect", "p5a02-lamp-disconnect.png"],
  ["recover", "p5a02-lamp-recover.png"]
];

(async function () {
  await ui.gotoCanvas();
  await ui.sleep(2500);

  console.log("=== 逐场景：切换 → dump 总线 → 截图 ===");
  for (const [scenario, file] of SCENES) {
    ui.clearLog();
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", scenario, "--ei", "step", "5"]);
    await ui.sleep(2800);
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "dump", "1"]);
    await ui.sleep(1200);

    const bus = ui.sh(["logcat", "-d", "-s", "SimBus:I"]).split("\n")
      .map((x) => (/BUSD (std_0C|std_0D|std_05|std_42) /.test(x) ? x.replace(/^.*BUSD/, "BUSD").trim() : null))
      .filter(Boolean);
    const simLine = ui.sh(["logcat", "-d", "-s", "SimBus:I"]).split("\n")
      .map((x) => (/BUSD sim=/.test(x) ? x.replace(/^.*BUSD/, "BUSD").trim() : null))
      .filter(Boolean);

    const p = path.join(SHOT, file);
    const size = ui.screenshot(p);
    console.log("\n  " + scenario.padEnd(11) + size + " bytes → " + file);
    bus.forEach((b) => console.log("      " + b));
    simLine.forEach((b) => console.log("      " + b));
  }

  console.log("\n=== 模拟源日志（互斥 / 启用 / 关闭）===");
  const logs = ui.sh(["logcat", "-d", "-s", "SimPidSource:I", "SimPidSource:W"])
    .split("\n").filter((x) => x.trim());
  logs.slice(-10).forEach((l) => console.log("  " + l.replace(/^.*SimPidSource\s*:\s*/, "").trim()));

  console.log("\n=== 异常检查 ===");
  console.log("  前台: " + (ui.foreground() || "非App"));
  console.log("  FATAL: " + ui.fatalLogs().length);
  console.log("  App 存活: " + ui.appAlive());
})();
