// ============================================================================
// P5A-M06 阶段 D：连接页**实际**验证（模拟器）
//
// ## 前两轮为什么卡住
//
// M04/M05 都卡在"AVD 到不了 ConnectFragment"。本轮审计 `MainActivity` 找到真正原因：
// **仪表盘页会自动收起导航**（`applySystemStatusBar("dash")` → `setRailVisible(false)`），
// 而收起方式是把 `navView` 平移出屏幕 + alpha→0 + 最终 `GONE` ——
// 所以 uiautomator 永远找不到它。
//
// 呼出导航的既有手势有两条（MainActivity L661/L699）：
//   ① 双指右滑   ② **双击**（间隔 <400ms、位移 <24dp）
// 选② —— `adb shell input tap` 两次即可，不依赖多指模拟。
//
// **不是产品缺陷，是"沉浸式导航可收起"的有意设计。**
//
// ## 本脚本验证什么
//
// 任务 §六 要求的 9 种状态里，能在模拟器上真实触发的：
//   未连接 / 已连接但无有效 PID / 正常采集 / 模拟数据运行 / 数据过期
// 不能真实触发的（无适配器）：正在连接 / 初始化中 / 连接失败
// 权限不足：可以撤销权限制造（`pm revoke`），但会影响后续用例 → 放最后
// ============================================================================
const fs = require("fs");
const path = require("path");
const ui = require("../_adbui.js");
const SHOT = path.join(__dirname, "..", "..", "..", "..", "docs", "02_验证记录", "screenshots");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

async function revealNav() {
  const s = ui.sh(["shell", "wm", "size"]).trim();
  const m = s.match(/(\d+)x(\d+)/);
  const w = m ? +m[1] : 1080, h = m ? +m[2] : 2400;
  const x = Math.round(w / 2), y = Math.round(h / 2);
  ui.sh(["shell", "input", "tap", String(x), String(y)]);
  await ui.sleep(120);
  ui.sh(["shell", "input", "tap", String(x), String(y)]);
  await ui.sleep(1000);
}

async function openConnectPage() {
  ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
  await ui.sleep(1500);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(10000);
  await revealNav();
  let it = ui.dumpUI();
  const nav = ui.find(it, "连接");
  if (!nav) throw new Error("呼出导航后仍找不到「连接」");
  ui.tap(nav.cx, nav.cy);
  await ui.sleep(2500);
  return ui.dumpUI();
}

/** 读连接页当前显示的「阶段」与「原因」 */
function readPhase(it) {
  const labels = it.map((x) => x.label).filter(Boolean);
  const phases = [
    "未连接", "正在搜索设备", "正在连接", "正在初始化适配器",
    "已连接，但还没有有效数据", "正在采集", "数据已过期",
    "连接超时", "设备已断开", "正在重新连接", "缺少蓝牙权限"
  ];
  // 阶段：**精确等于**某一档的那一行（不能是"未连接：还没有开始搜索设备"这种带原因的整句）
  const phase = labels.find((l) => phases.includes(l.trim()));
  // 原因：阶段那一行的下一行（UI 是"阶段 / 原因"上下两行），
  // 或者任何含原因关键词、且不等于阶段本身的长句
  let reason = null;
  const idx = labels.findIndex((l) => l.trim() === phase);
  if (idx >= 0 && idx + 1 < labels.length) {
    const next = labels[idx + 1].trim();
    // 下一行不能是下一个区块的标题
    if (!/^\d+\. |运行设置|仪表盘|连接$|PID$|规则$|日志$|知识库$/.test(next)) reason = next;
  }
  if (!reason) {
    reason = labels.find((l) =>
      l.length > 6 && l !== phase &&
      /未开始搜索|正在搜索蓝牙|正在连接设备|正在初始化|已连接并在轮询|条 PID|最近一次有效数据|适配器|模拟数据|缺少蓝牙权限|无有效值/.test(l)
    );
  }
  return { phase, reason, labels };
}

(async () => {
  const out = [];
  const log = (s) => { console.log(s); out.push(s); };

  // ---------------------------------------------------------------- D1 未连接
  console.log("=== D1. 未连接 ===");
  let it = await openConnectPage();
  let p = readPhase(it);
  log("  阶段=" + (p.phase || "(无)") + "  原因=" + (p.reason || "(无)"));
  ok(p.phase === "未连接", "D1 连接页显示「未连接」");
  ok(!!p.reason && /还没有开始搜索/.test(p.reason), "D1 原因说明「还没有开始搜索设备」，实际=" + p.reason);
  ui.screenshot(path.join(SHOT, "p5a06-d1-idle.png"));

  // ---------------------------------------------------------------- D2 模拟数据运行
  console.log("\n=== D2. 模拟数据运行（必须显眼标注不是真车）===");
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
  await ui.sleep(4500);
  it = ui.dumpUI();
  p = readPhase(it);
  log("  阶段=" + (p.phase || "(无)") + "  原因=" + (p.reason || "(无)"));
  const hasSimWord = p.labels.some((l) => l.indexOf("模拟") >= 0);
  ok(hasSimWord, "D2 页面上出现「模拟」字样（不冒充真车）");
  const simLabel = p.labels.find((l) => l.indexOf("模拟") >= 0);
  log("  模拟标识: " + (simLabel || "(无)").slice(0, 70));
  ui.screenshot(path.join(SHOT, "p5a06-d2-simulated.png"));

  // ---------------------------------------------------------------- D3 正常采集（模拟供数）
  console.log("\n=== D3. 有数据时显示「正在采集」或「已连接但无有效数据」===");
  ok(
    p.phase === "正在采集" || p.phase === "已连接，但还没有有效数据",
    "D3 阶段为「" + p.phase + "」（模拟供数下二者都合理）"
  );

  // ---------------------------------------------------------------- D4 模拟关闭 → 回到无数据
  console.log("\n=== D4. 关闭模拟后不留假数据 ===");
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "off"]);
  await ui.sleep(3500);
  it = ui.dumpUI();
  p = readPhase(it);
  log("  阶段=" + (p.phase || "(无)") + "  原因=" + (p.reason || "(无)"));
  ok(p.phase !== "正在采集", "D4 关闭模拟后不再显示「正在采集」");
  ui.screenshot(path.join(SHOT, "p5a06-d4-sim-off.png"));

  // ---------------------------------------------------------------- D5 权限撤销
  console.log("\n=== D5. 缺少蓝牙权限 ===");
  //
  // ⚠️ 本环境无法稳定验证，如实记录（不伪造通过）：
  //    adb shell pm revoke 会把系统「应用信息」页推到前台，与随后的 App 启动互相竞争；
  //    即使点掉一次权限对话框，App 主动请求权限时会再弹一次，两次轮询之间容易被系统页抢占。
  //
  //    但「权限不足」这条产品逻辑本身已被 23 条 JVM 断言覆盖：
  //      ObdLinkStatusTest B11（缺权限 → NO_PERMISSION，dataLive=false）
  //      ObdLinkStatusTest T4 （权限优先级最高，即使链路 READY 也不冒充可用）
  //    Android 端 ConnectFragment.hasBluetoothPermission() 只是把这个值喂给聚合器。
  log("  ⏭ D5 未在设备端验证：pm revoke 会把系统「应用信息」页推到前台并与 App 启动竞争，");
  log("     权限对话框二次弹出难以稳定点掉。产品逻辑由 ObdLinkStatusTest B11/T4 覆盖。");

  // ---------------------------------------------------------------- D6 页面切换与重进

  // ---------------------------------------------------------------- D6 页面切换与重进
  console.log("\n=== D6. 切到其它页再回连接页，状态不漂移 ===");
  it = await openConnectPage().catch(() => ui.dumpUI());
  let before = readPhase(it).phase;
  // 页面可能还没渲染完 → 再读一次
  for (let r = 0; r < 3 && !before; r++) { await ui.sleep(1500); before = readPhase(ui.dumpUI()).phase; }
  // 双击收起/呼出再切仪表盘
  await revealNav();
  it = ui.dumpUI();
  const dash = ui.find(it, "仪表盘");
  if (dash) { ui.tap(dash.cx, dash.cy); await ui.sleep(2000); }
  it = await openConnectPage().catch(() => ui.dumpUI());
  let after = readPhase(it).phase;
  for (let r = 0; r < 3 && !after; r++) { await ui.sleep(1500); after = readPhase(ui.dumpUI()).phase; }
  log("  切页前=" + before + "  切回后=" + after);
  ok(!!before && before === after, "D6 页面来回切换后阶段一致（" + before + " → " + after + "）");

  fs.writeFileSync(path.join(SHOT, "p5a06-connect-verify.txt"), out.join("\n"), "utf8");
  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
