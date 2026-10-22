// P5A-M03：可靠地导入一个 .icarzip，并**确认真的换上了**（按设计名核对）
const path = require("path");
const ui = require("./_adbui.js");

const NAME = process.argv[2] || "state-lamps-blink.icarzip";
const EXPECT = process.argv[3] || "P5A-M03 状态灯闪烁测试";

(async function () {
  console.log("=== 导入 " + NAME + " ===");
  // 1) 强制回到 MainActivity
  ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
  await ui.sleep(1500);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(10000);
  console.log("  前台: " + (ui.foreground() || "非App"));

  // 2) 推包
  const local = path.join(__dirname, "..", "..", "..", "..", "..",
    "docs", "02_验证记录", "android-theme", "state-lamps", NAME);
  ui.sh(["push", local, "/sdcard/Download/" + NAME]);

  // 3) 到设置页
  let it = await ui.gotoSettings();
  if (!ui.find(it, "导入画布")) {
    console.log("  ⚠ 进不了设置页，前台=" + (ui.foreground() || "?"));
    process.exit(1);
  }
  const imp = ui.find(it, "导入画布");
  ui.tap(imp.cx, imp.cy);
  await ui.sleep(4500);

  // 4) SAF 选文件
  it = ui.dumpUI();
  let f = ui.find(it, NAME);
  if (!f) {
    const dl = ui.find(it, "下载");
    if (dl) { ui.tap(dl.cx, dl.cy); await ui.sleep(3000); it = ui.dumpUI(); f = ui.find(it, NAME); }
  }
  if (!f) {
    const vis = it.filter((i) => /\.(json|icarzip)$/.test(i.label)).map((i) => i.label);
    console.log("  ❌ SAF 里找不到（可见: " + vis.join(", ") + "）");
    process.exit(1);
  }
  ui.tap(f.cx, f.cy);
  await ui.sleep(4500);

  // 5) 确认对话框
  it = ui.dumpUI();
  const title = it.find((i) => /导入设计(文件|包)/.test(i.label));
  if (!title) {
    const err = it.find((i) => /错误|无法|不支持|语法/.test(i.label));
    console.log("  ❌ 没弹确认框（" + (err ? err.label : "原因未知") + "）");
    process.exit(1);
  }
  const btn = ui.find(it, "导入", { last: true });
  if (!btn) { console.log("  ❌ 找不到导入按钮"); process.exit(1); }
  ui.tap(btn.cx, btn.cy);
  await ui.sleep(6000);

  // 6) 核对设计名
  const s = ui.sh(["shell", "run-as", "com.icar.obd", "cat", "/data/data/com.icar.obd/files/config/settings.json"]);
  let name = "?", lamps = -1;
  try {
    const j = JSON.parse(s.replace(/^\uFEFF/, ""));
    const d = JSON.parse(j.designJson);
    name = d.name;
    lamps = (d.pages[0].nodes || []).filter((n) => n.states).length;
  } catch (e) { /* 忽略 */ }
  console.log("  已加载设计: " + name + "（状态灯 " + lamps + " 个）");
  if (name !== EXPECT) {
    console.log("  ❌ 设计名不符，期望: " + EXPECT);
    process.exit(1);
  }
  console.log("PASS=1 FAIL=0");
  process.exit(0);
})();
