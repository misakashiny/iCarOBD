// ============================================================================
// P5A-M03 阶段 E2：轨道跨端适配（3 种屏幕比例 × FIT/STRETCH）
//
// 采集：对每种比例、每种 scaleMode，导入对应包 → 截图 → 存 PNG。
// 判定交给 verify-p5a03-tracks.js（离线像素分析，进浏览器基线）。
//
// 用法：node _p5a03-capture-tracks.js
// ============================================================================
const path = require("path");
const ui = require("./_adbui.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

const MODES = [
  { id: "phone", w: 1080, h: 2400, dpi: 420 },
  { id: "tablet", w: 1600, h: 1000, dpi: 240 },
  { id: "carwide", w: 1280, h: 600, dpi: 160 }
];

async function setDisplay(w, h, dpi) {
  ui.sh(["shell", "wm", "size", w + "x" + h]);
  ui.sh(["shell", "wm", "density", String(dpi)]);
  await ui.sleep(5000);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(6000);
}

async function importTheme(zipName, expectedName) {
  ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
  await ui.sleep(1500);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(9000);
  let it = await ui.gotoSettings();
  const imp = ui.find(it, "导入画布");
  if (!imp) throw new Error("进不了设置页");
  ui.tap(imp.cx, imp.cy);
  await ui.sleep(4500);
  it = ui.dumpUI();
  let f = ui.find(it, zipName);
  if (!f) {
    const dl = ui.find(it, "下载");
    if (dl) { ui.tap(dl.cx, dl.cy); await ui.sleep(3000); it = ui.dumpUI(); f = ui.find(it, zipName); }
  }
  if (!f) throw new Error("SAF 找不到 " + zipName);
  ui.tap(f.cx, f.cy);
  await ui.sleep(4500);
  it = ui.dumpUI();
  const btn = ui.find(it, "导入", { last: true });
  if (!btn) throw new Error("无导入确认框");
  ui.tap(btn.cx, btn.cy);
  await ui.sleep(6000);
  // 核对设计名
  const s = ui.sh(["shell", "run-as", "com.icar.obd", "cat", "/data/data/com.icar.obd/files/config/settings.json"]);
  let name = "";
  try { name = JSON.parse(JSON.parse(s.replace(/^\uFEFF/, "")).designJson).name; } catch (e) {}
  if (name !== expectedName) throw new Error("设计名不符：got=" + name + " want=" + expectedName);
  await ui.gotoCanvas();
  await ui.sleep(2000);
}

(async function () {
  console.log("=== P5A-M03 阶段 E2：轨道多比例采集 ===\n");
  const names = {
    stretch: "P5A-M03 轨道全能力（拉伸）",
    fit: "P5A-M03 轨道全能力（等比）"
  };
  for (const tag of ["stretch", "fit"]) {
    console.log("--- 导入 " + tag + " ---");
    try {
      await importTheme("tracks-" + tag + ".icarzip", names[tag]);
      console.log("  ✅ 已加载 " + names[tag]);
    } catch (e) { console.log("  ❌ " + e.message); continue; }

    for (const m of MODES) {
      await setDisplay(m.w, m.h, m.dpi);
      ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
      await ui.sleep(2800);
      const file = "p5a03-e2-" + tag + "-" + m.id + ".png";
      const size = ui.screenshot(path.join(SHOT, file));
      console.log("  " + (tag + "/" + m.id).padEnd(18) + size + " bytes → " + file);
    }
  }
  // 复位
  ui.sh(["shell", "wm", "size", "reset"]);
  ui.sh(["shell", "wm", "density", "reset"]);
  await ui.sleep(4000);
  console.log("\n显示已复位：" + ui.sh(["shell", "wm", "size"]).trim());
})();
