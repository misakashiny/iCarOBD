// G4 单独复验：导入损坏 JSON 后**立刻**读界面（不先关对话框）
const ui = require("./_adbui.js");
(async () => {
  ui.clearLog();
  await ui.launchApp();
  await ui.dismissDialogs();
  let items = await ui.gotoSettings();
  const imp = ui.find(items, "导入画布");
  if (!imp) { console.log("❌ 找不到导入画布"); process.exit(1); }
  ui.tap(imp.cx, imp.cy);
  await ui.sleep(4500);

  items = ui.dumpUI();
  let f = ui.find(items, "bad-broken.json");
  if (!f) {
    const dl = ui.find(items, "下载");
    if (dl) { ui.tap(dl.cx, dl.cy); await ui.sleep(3000); items = ui.dumpUI(); f = ui.find(items, "bad-broken.json"); }
  }
  if (!f) { console.log("❌ SAF 里找不到 bad-broken.json"); process.exit(1); }
  ui.tap(f.cx, f.cy);
  await ui.sleep(4500);

  items = ui.dumpUI();
  console.log("=== 导入后的界面（" + items.length + " 控件）===");
  items.forEach((i) => console.log("  " + JSON.stringify(i.label.slice(0, 120))));

  const hasTitle = items.some((i) => /导入设计(文件|包)/.test(i.label));
  const errRe = /错误|无法|不支持|语法|失败|损坏/;
  const errItem = items.find((i) => errRe.test(i.label));
  const fatal = ui.fatalLogs();

  console.log("");
  console.log((hasTitle ? "❌ 弹了导入确认框（不该）" : "✅ 未弹确认框 → 拒绝加载"));
  console.log((errItem ? "✅ 有错误提示: " + errItem.label : "❌ 无错误提示"));
  console.log("FATAL=" + fatal.length + "  前台=" + (ui.foreground() || "非App"));
  console.log("PASS=" + ((!hasTitle && errItem && fatal.length === 0) ? 1 : 0) +
    " FAIL=" + ((!hasTitle && errItem && fatal.length === 0) ? 0 : 1));

  // 收尾：关对话框 + 回画布
  const okBtn = ui.find(items, "确定") || ui.find(items, "知道了");
  if (okBtn) { ui.tap(okBtn.cx, okBtn.cy); await ui.sleep(1200); }
  await ui.gotoCanvas();
})();
