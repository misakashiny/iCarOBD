// P5A-M04 阶段 E：采集 FILL 模式的轨道几何 + 截图（补 M03 缺的第三种缩放模式）
const fs = require("fs");
const path = require("path");
const ui = require("./_adbui.js");
const { importTheme } = require("./_import2.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");
const META = path.join(SHOT, "p5a03-track-geometry.json");
const MODES = [
  { id: "phone", w: 1080, h: 2400, dpi: 420 },
  { id: "tablet", w: 1600, h: 1000, dpi: 240 },
  { id: "carwide", w: 1280, h: 600, dpi: 160 }
];

function trackRects() {
  ui.sh(["shell", "uiautomator", "dump", "/sdcard/_tv.xml"]);
  const xml = ui.sh(["shell", "cat", "/sdcard/_tv.xml"]);
  const re = /<node[^>]*class="android\.view\.View"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const r = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
    if (r.x1 - r.x0 >= 1000 && r.y1 - r.y0 >= 500) continue;
    out.push(r);
  }
  out.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  return out;
}
async function trackRectsFor(w, h) {
  let last = [];
  for (let i = 0; i < 6; i++) {
    last = trackRects();
    if (last.length) {
      const maxX = Math.max.apply(null, last.map((r) => r.x1));
      const maxY = Math.max.apply(null, last.map((r) => r.y1));
      if (maxX <= w && maxY <= h) return last;
    }
    await ui.sleep(2000);
  }
  return last;
}
async function setDisplay(w, h, dpi) {
  ui.sh(["shell", "wm", "size", w + "x" + h]);
  ui.sh(["shell", "wm", "density", String(dpi)]);
  await ui.sleep(5000);
  for (let i = 0; i < 20; i++) {
    if (ui.sh(["shell", "wm", "size"]).indexOf(w + "x" + h) >= 0) break;
    await ui.sleep(1500);
  }
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(6000);
}

(async () => {
  console.log("=== P5A-M04 阶段 E：FILL 模式轨道采集 ===");
  ui.sh(["shell", "wm", "size", "reset"]);
  ui.sh(["shell", "wm", "density", "reset"]);
  await ui.sleep(4000);
  await importTheme("tracks-fill.icarzip", "P5A-M03 轨道全能力（铺满裁切）");
  console.log("  ✅ 已加载 FILL 主题");

  const meta = fs.existsSync(META) ? JSON.parse(fs.readFileSync(META, "utf8")) : {};
  for (const m of MODES) {
    await setDisplay(m.w, m.h, m.dpi);
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
    await ui.sleep(3000);
    const rects = await trackRectsFor(m.w, m.h);
    const file = "p5a03-e2-fill-" + m.id + ".png";
    const size = ui.screenshot(path.join(SHOT, file));
    meta["fill/" + m.id] = { screen: [m.w, m.h], file: file, rects: rects };
    console.log("  fill/" + m.id.padEnd(10) + size + " bytes  矩形=" + rects.length +
      (rects.length ? "  首个=[" + rects[0].x0 + "," + rects[0].y0 + "]" : ""));
  }
  fs.writeFileSync(META, JSON.stringify(meta, null, 2), "utf8");
  ui.sh(["shell", "wm", "size", "reset"]);
  ui.sh(["shell", "wm", "density", "reset"]);
  await ui.sleep(4000);
  console.log("  已写几何；显示复位 " + ui.sh(["shell", "wm", "size"]).trim());
})();
