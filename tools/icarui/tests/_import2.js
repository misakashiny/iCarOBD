// 可靠导入：直接复用 M03 验证过的那条流程（force-stop → start → 左滑到设置 → SAF → 导入 → 核对设计名）
const path = require("path");
const ui = require("./_adbui.js");

function loadedName() {
  const s = ui.sh(["shell", "run-as", "com.icar.obd", "cat",
    "/data/data/com.icar.obd/files/config/settings.json"]);
  try { return JSON.parse(JSON.parse(s.replace(/^\uFEFF/, "")).designJson).name; } catch (e) { return ""; }
}

async function ensureSettings() {
  // ⚠️ P5A-M04 实测：这个 App 的「右滑」是**呼出导航**，不是翻页。
  //    第一版先右滑 2 次再左滑，反而把状态搞乱（一直停在只有「默认」标签的画布页）。
  //    正确做法：**只左滑**，一次就能从画布页进设置页。
  for (let round = 0; round < 3; round++) {
    let it = ui.dumpUI();
    if (ui.find(it, "导入画布")) return it;
    for (let k = 0; k < 4; k++) {
      ui.swipeL(1200);
      await ui.sleep(1100);
      it = ui.dumpUI();
      if (ui.find(it, "导入画布")) return it;
    }
    // 还不行就重启一次（UI 可能没渲染完）
    ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
    await ui.sleep(1500);
    ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
    await ui.sleep(10000);
  }
  return ui.dumpUI();
}

async function importTheme(zip, expectName) {
  ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
  await ui.sleep(1500);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(10000);
  const it0 = await ensureSettings();
  const imp = ui.find(it0, "导入画布");
  if (!imp) throw new Error("进不了设置页（当前：" + it0.map((x) => x.label.slice(0, 12)).join("|") + "）");
  ui.tap(imp.cx, imp.cy);
  await ui.sleep(4500);
  let it = ui.dumpUI();
  let f = ui.find(it, zip);
  if (!f) {
    const dl = ui.find(it, "下载");
    if (dl) { ui.tap(dl.cx, dl.cy); await ui.sleep(3000); it = ui.dumpUI(); f = ui.find(it, zip); }
  }
  if (!f) throw new Error("SAF 找不到 " + zip);
  ui.tap(f.cx, f.cy);
  await ui.sleep(4500);
  it = ui.dumpUI();
  const btn = ui.find(it, "导入", { last: true });
  if (!btn) throw new Error("无导入确认框");
  ui.tap(btn.cx, btn.cy);
  await ui.sleep(6500);
  const got = loadedName();
  if (got !== expectName) throw new Error("设计名不符 got=" + got);
  // 回画布页（右滑）
  for (let k = 0; k < 4; k++) {
    const cur = ui.dumpUI();
    if (!ui.find(cur, "导入画布")) break;
    ui.swipeR(1200);
    await ui.sleep(900);
  }
  await ui.sleep(1500);
  return true;
}

module.exports = { importTheme, loadedName, ensureSettings };
