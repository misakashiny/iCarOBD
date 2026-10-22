// ============================================================================
// P5A-M04 阶段 A：轨道多比例采集（**用真实 View 矩形**，不再自己算映射）
//
// ## 为什么要重写（A1 结论）
//
// P5A-M03 的判定用「uiautomator 的 canvasArea bounds + 自己按 computeViewport 公式算 k
// 和居中偏移」来定位 8 条轨道。实测证明这个做法**偏了约 72px**：
//
//   App 日志给出的真实屏幕矩形（FIT 车载宽屏 1280×600）：
//     t_h_band  gvis = 655,31 - 907,84
//   M03 的采样框：
//     t_h_band  x[655,888] y[103,153]     ← y 整段落在第二排空白处
//
// 于是 `t_h_band` 被"测成没画出来"，其实是**测错了地方**。
// 真实原因：`canvasArea` 的 bounds 含额外 padding，且画布垂直居中于
// **可用高度 567px**（600 - 33 状态栏），不是 M03 假设的 526px。
//
// ## 现在的做法
//
// 每条轨道在 App 里都是独立的 `android.view.View`（TrackView），
// uiautomator 能直接读到它的 `bounds` —— **这就是"节点实际 global visible bounds"**
// （任务 A1 要求核对的那一项）。采集时把 8 个矩形一起落盘，
// 判定时**直接按矩形取像素**，不再做任何坐标推算。
//
// 零侵入：不需要在正式包里加日志或调试代码。
// ============================================================================
const fs = require("fs");
const path = require("path");
const ui = require("./_adbui.js");
// 导入走 M03 验证过的那条可靠流程（force-stop → 反复找设置页 → SAF → 核对设计名）
const { importTheme } = require("./_import2.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");
const META = path.join(SHOT, "p5a03-track-geometry.json");

const MODES = [
  { id: "phone", w: 1080, h: 2400, dpi: 420 },
  { id: "tablet", w: 1600, h: 1000, dpi: 240 },
  { id: "carwide", w: 1280, h: 600, dpi: 160 }
];

/** 抓画布区下所有 TrackView（android.view.View）的屏幕矩形，按 (top,left) 排序 */
function trackRects() {
  ui.sh(["shell", "uiautomator", "dump", "/sdcard/_tv.xml"]);
  const xml = ui.sh(["shell", "cat", "/sdcard/_tv.xml"]);
  // TrackView 在 uiautomator 里表现为 class="android.view.View"，且**没有 text/desc**
  const re = /<node[^>]*class="android\.view\.View"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const r = { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] };
    // 过滤掉整个画布那个大 View（等于全屏容器）
    if (r.x1 - r.x0 >= 1000 && r.y1 - r.y0 >= 500) continue;
    out.push(r);
  }
  // 按 top 再按 left 排序 → 与设计里 8 条轨道的 (y,x) 顺序一致
  out.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  return out;
}

async function setDisplay(w, h, dpi) {
  ui.sh(["shell", "wm", "size", w + "x" + h]);
  ui.sh(["shell", "wm", "density", String(dpi)]);
  await ui.sleep(5000);
  // 等 wm size 真正生效（否则后续 uiautomator 抓到的还是上一档的布局）
  for (let i = 0; i < 20; i++) {
    const cur = ui.sh(["shell", "wm", "size"]);
    if (cur.indexOf(w + "x" + h) >= 0) break;
    await ui.sleep(1500);
  }
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(6000);
}

/**
 * 抓 8 条轨道的真实矩形，并**校验它们确实落在本档屏幕内**。
 *
 * ⚠️ P5A-M04 踩到：切到 1280×600 后立刻抓 uiautomator，拿到的仍是上一档
 * （1600×1000）的布局 —— 矩形 maxY=881 > 600，与截图对不上，判定全错。
 * 这里加一道硬校验：越界就等一会儿重抓，最多 6 次。
 */
async function trackRectsFor(w, h) {
  let last = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    last = trackRects();
    if (last.length) {
      const maxX = Math.max.apply(null, last.map((r) => r.x1));
      const maxY = Math.max.apply(null, last.map((r) => r.y1));
      if (maxX <= w && maxY <= h) return last;
    }
    await ui.sleep(2000);
  }
  console.log("    ⚠ 矩形仍与屏幕不符（首个=" + JSON.stringify(last[0]) + "，屏幕 " + w + "×" + h + "）");
  return last;
}

(async function () {
  console.log("=== P5A-M04 阶段 A：轨道采集（真实 View 矩形）===\n");
  const names = {
    stretch: "P5A-M03 轨道全能力（拉伸）",
    fit: "P5A-M03 轨道全能力（等比）"
  };
  const meta = {};

  for (const tag of ["stretch", "fit"]) {
    console.log("--- 导入 " + tag + " ---");
    // ⚠️ 必须先复位显示：上一轮 setDisplay 会把屏幕留在 1280×600，
    // 在这个尺寸下进设置页的 UI 布局与竖屏不同，导航会失败（实测卡在"只有默认标签"）。
    ui.sh(["shell", "wm", "size", "reset"]);
    ui.sh(["shell", "wm", "density", "reset"]);
    await ui.sleep(4000);
    try {
      await importTheme("tracks-" + tag + ".icarzip", names[tag]);
      console.log("  ✅ 已加载 " + names[tag]);
    } catch (e) { console.log("  ❌ " + e.message); continue; }

    for (const m of MODES) {
      await setDisplay(m.w, m.h, m.dpi);
      ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
      await ui.sleep(3000);
      const rects = await trackRectsFor(m.w, m.h);
      const file = "p5a03-e2-" + tag + "-" + m.id + ".png";
      const size = ui.screenshot(path.join(SHOT, file));
      meta[tag + "/" + m.id] = { screen: [m.w, m.h], file: file, rects: rects };
      console.log("  " + (tag + "/" + m.id).padEnd(18) + size + " bytes  轨道矩形=" + rects.length +
        (rects.length ? "  首个=[" + rects[0].x0 + "," + rects[0].y0 + "][" + rects[0].x1 + "," + rects[0].y1 + "]" : ""));
    }
  }

  fs.writeFileSync(META, JSON.stringify(meta, null, 2), "utf8");
  console.log("\n已写 " + path.relative(process.cwd(), META));
  ui.sh(["shell", "wm", "size", "reset"]);
  ui.sh(["shell", "wm", "density", "reset"]);
  await ui.sleep(4000);
  console.log("显示已复位：" + ui.sh(["shell", "wm", "size"]).trim());
})();
