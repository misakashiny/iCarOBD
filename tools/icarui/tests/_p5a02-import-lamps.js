// P5A-M02 阶段 C：把状态灯三态测试包导入模拟器，并逐场景截图
const path = require("path");
const fs = require("fs");
const ui = require("./_adbui.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

(async function () {
  console.log("=== 导入状态灯三态测试包 ===\n");
  ui.clearLog();

  const r = await ui.importFile("state-lamps.icarzip");
  console.log("  导入结果: " + (r.ok ? "成功" : "失败"));
  console.log("  详情: " + (r.detail || "(无)"));
  console.log("  前台: " + (ui.foreground() || "非 App"));
  console.log("  FATAL: " + ui.fatalLogs().length);

  if (!r.ok) process.exit(1);

  // 回画布页
  await ui.gotoCanvas();
  await ui.sleep(2500);

  // 确认设计真的加载了（日志里应有导入记录）
  const logs = ui.logTag("SimControl") + ui.logTag("SimPidSource");
  console.log("  模拟日志: " + (logs.trim() ? logs.trim().split("\n").length + " 行" : "(暂无)"));

  // 场景序列：normal → alarm(warn) → critical → disconnect → recover
  const scenes = [
    ["normal", "p5a02-lamp-normal.png"],
    ["alarm", "p5a02-lamp-warn.png"],
    ["critical", "p5a02-lamp-critical.png"],
    ["disconnect", "p5a02-lamp-disconnect.png"],
    ["recover", "p5a02-lamp-recover.png"]
  ];

  console.log("\n=== 逐场景切换并截图 ===");
  for (const [scenario, file] of scenes) {
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", scenario, "--ei", "step", "5"]);
    await ui.sleep(3000);
    // 打印总线值作为同时刻证据
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "dump", "1"]);
    await ui.sleep(1200);
    const bus = ui.sh(["logcat", "-d", "-s", "SimBus:I"]).split("\n")
      .filter((x) => /BUSD (std_0C|std_0D|std_05|std_42) /.test(x)).slice(-4);
    const p = path.join(SHOT, file);
    const size = ui.screenshot(p);
    console.log("  " + scenario.padEnd(11) + size + " bytes → " + file);
    bus.forEach((b) => console.log("      " + b.replace(/^.*BUSD/, "BUSD").trim()));
  }

  console.log("\n=== 互斥验证：模拟开启时真实轮询应为停止 ===");
  const st = ui.sh(["logcat", "-d", "-s", "SimPidSource:I", "SimPidSource:W"])
    .split("\n").filter((x) => x.trim());
  st.slice(-6).forEach((l) => console.log("  " + l.replace(/^.*SimPidSource/, "SimPidSource").trim()));

  console.log("\n完成。");
})();
