// ============================================================================
// P5A-M02 阶段 E：多屏幕比例 + FIT/STRETCH 对照采集
//
// 用法： node p5a02-capture-multires.js <tag>
//   tag = stretch | fit
//
// 流程：切 wm size → 回到画布 → 等布局 → 截图（每档）
// 测完由调用方负责把 wm size/density 复位。
// ============================================================================
const path = require("path");
const ui = require("./_adbui.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");
const TAG = process.argv[2] || "stretch";

// 三档显示环境：{标签, w, h, dpi}
const MODES = [
  { id: "phone", w: 1080, h: 2400, dpi: 420, label: "手机竖屏" },
  { id: "tablet", w: 1600, h: 1000, dpi: 240, label: "平板横屏" },
  { id: "carwide", w: 1280, h: 600, dpi: 160, label: "车载宽屏" }
];

async function setDisplay(w, h, dpi) {
  ui.sh(["shell", "wm", "size", `${w}x${h}`]);
  ui.sh(["shell", "wm", "density", String(dpi)]);
  await ui.sleep(5000);
  // 等设备回来
  for (let i = 0; i < 20; i++) {
    const d = ui.sh(["shell", "wm", "size"]);
    if (d.indexOf(`${w}x${h}`) >= 0) break;
    await ui.sleep(1500);
  }
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(6000);
}

(async function () {
  console.log("=== 阶段 E 采集 tag=" + TAG + " ===\n");
  for (const m of MODES) {
    console.log("--- " + m.label + " " + m.w + "×" + m.h + " @" + m.dpi + " ---");
    await setDisplay(m.w, m.h, m.dpi);
    // ⚠️ 必须切回画布页：am start 只把 App 拉到前台，**不会**把 pager 拨回去
    await ui.gotoCanvas();
    await ui.sleep(1500);
    // 保持模拟数据在跑（否则断开态没有指针）
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
    await ui.sleep(2500);
    const file = "p5a02-e-" + TAG + "-" + m.id + ".png";
    const size = ui.screenshot(path.join(SHOT, file));
    const sz = ui.sh(["shell", "wm", "size"]).trim();
    const dn = ui.sh(["shell", "wm", "density"]).trim();
    console.log("  " + size + " bytes → " + file);
    console.log("  " + sz + " / " + dn);
    console.log("  前台=" + (ui.foreground() || "非App") + "  FATAL=" + ui.fatalLogs().length);
  }
  console.log("\n完成（请复位 wm size / density）");
})();
