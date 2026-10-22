// P5A-M04 A1：抓 TrackView 的屏幕全局矩形（唯一可靠的采样依据）
const ui = require("./_adbui.js");
const set = (process.argv[2] || "carwide");
const SIZES = {
  phone: { w: 1080, h: 2400, dpi: 420 },
  tablet: { w: 1600, h: 1000, dpi: 240 },
  carwide: { w: 1280, h: 600, dpi: 160 }
};
const s = SIZES[set];
(async () => {
  console.log("=== " + set + " (" + s.w + "x" + s.h + ") ===");
  ui.sh(["shell", "wm", "size", s.w + "x" + s.h]);
  ui.sh(["shell", "wm", "density", String(s.dpi)]);
  await ui.sleep(5000);
  ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(9000);
  await ui.gotoCanvas();
  await ui.sleep(2000);
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
  await ui.sleep(3000);
  ui.sh(["logcat", "-c"]);
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "accel", "--ei", "step", "3"]);
  await ui.sleep(3500);
  const out = ui.sh(["logcat", "-d", "-s", "P5A04Track:D"]);
  const lines = out.split("\n").filter((l) => l.indexOf("GEO ") >= 0);
  const seen = new Set();
  lines.forEach((l) => {
    const b = l.slice(l.indexOf("GEO "));
    if (!seen.has(b)) { seen.add(b); console.log("  " + b); }
  });
  console.log("  唯一=" + seen.size);
})();
