// 采集 canvasArea 的真实屏幕边界（供轨道像素判定裁掉 App chrome）
const fs = require("fs");
const path = require("path");
const ui = require("./_adbui.js");

const OUT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots",
  "p5a03-canvas-bounds.json");

function canvasArea() {
  ui.sh(["shell", "uiautomator", "dump", "/sdcard/_cb.xml"]);
  const xml = ui.sh(["shell", "cat", "/sdcard/_cb.xml"]);
  const m = /resource-id="com\.icar\.obd:id\/canvasArea"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  if (!m) return null;
  return { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
}
function canvasRoot() {
  const xml = ui.sh(["shell", "cat", "/sdcard/_cb.xml"]);
  const m = /resource-id="com\.icar\.obd:id\/canvasRoot"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(xml);
  if (!m) return null;
  return { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
}

const result = {};
const sizes = [
  { id: "phone", w: 1080, h: 2400, dpi: 420 },
  { id: "tablet", w: 1600, h: 1000, dpi: 240 },
  { id: "carwide", w: 1280, h: 600, dpi: 160 }
];
(async () => {
  for (const s of sizes) {
    ui.sh(["shell", "wm", "size", s.w + "x" + s.h]);
    ui.sh(["shell", "wm", "density", String(s.dpi)]);
    await ui.sleep(5000);
    ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
    await ui.sleep(6000);
    await ui.gotoCanvas();
    await ui.sleep(1500);
    ui.sh(["shell", "uiautomator", "dump", "/sdcard/_cb.xml"]);
    result[s.id] = { area: canvasArea(), root: canvasRoot(), wm: s };
    console.log("  " + s.id.padEnd(9) + JSON.stringify(result[s.id]));
  }
  ui.sh(["shell", "wm", "size", "reset"]);
  ui.sh(["shell", "wm", "density", "reset"]);
  await ui.sleep(3500);
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
  console.log("\n已写 " + OUT);
  console.log("显示已复位：" + ui.sh(["shell", "wm", "size"]).trim());
})();
