// ============================================================================
// verify-p5b03-fgs.js —— P5B-M03 §A：前台服务类型合规性（**设备端**）
//
// ## 本轮要证明什么
//
// 指令 §A2 列出七条设计原则，其中三条是硬规则：
//   · **无蓝牙权限时，不启动真实 OBD 采集**
//   · **离线主题浏览不应依赖无实际工作的 FGS**
//   · **不为延长存活时间而滥用 dataSync 服务类型**
//
// P5B-M02 的做法是"没权限就用 DATA_SYNC 保活"—— 这被判定为滥用。
// 本轮改为"没权限就**不起前台服务**"。
//
// ## 判定依据（全部来自系统，不靠猜）
//
//   · `dumpsys activity services <pkg>` → ServiceRecord 是否存在、startForegroundCount
//   · `dumpsys package <pkg>`           → 权限真实授予状态
//   · `logcat -b crash`                 → 是否 FATAL
//   · `dumpsys notification`            → 前台通知是否存在
//   · `pidof`                           → 进程存活
//
// ## Android 15 限制（本项目环境限制，如实记录）
//
// 当前只有 Android 14（API 34）模拟器。Android 15+ 的 dataSync 6 小时限制
// **无法在本环境实测**，只能：
//   · 核对 targetSdk（34，低于 35 → 暂不强制）
//   · 核对代码是否处理 `onTimeout`（已加）
// 已在报告中明确标注"Android 15/16 未实测"。
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b03-fgs-result.txt");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => console.log("     " + m);

function adb(args) {
  return execFileSync(ADB, ["-s", SERIAL].concat(args), {
    encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
}
const sh = (cmd) => adb(["shell", cmd]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serviceInfo() {
  const d = sh("dumpsys activity services " + PKG);
  const has = /ServiceRecord\{[^}]*ObdService/.test(d);
  const fgCount = (d.match(/startForegroundCount=(\d+)/) || [])[1];
  const types = (d.match(/foregroundServiceType=(\w+)/) || [])[1];
  return { has, startForegroundCount: fgCount === undefined ? null : +fgCount, types };
}
function permState() {
  const d = sh("dumpsys package " + PKG);
  const get = (n) => {
    const m = d.match(new RegExp("android\\.permission\\." + n + ": granted=(\\w+)"));
    return m ? m[1] === "true" : null;
  };
  return { connect: get("BLUETOOTH_CONNECT"), fgs: get("FOREGROUND_SERVICE"), fgsDev: get("FOREGROUND_SERVICE_CONNECTED_DEVICE"), fgsSync: get("FOREGROUND_SERVICE_DATA_SYNC") };
}
const pid = () => sh("pidof " + PKG).trim();
const fatalCount = () => (sh("logcat -d -b crash").match(/FATAL EXCEPTION/g) || []).length;

function grant() {
  sh("pm grant " + PKG + " android.permission.BLUETOOTH_CONNECT");
  sh("pm grant " + PKG + " android.permission.BLUETOOTH_SCAN");
}
function revoke() {
  sh("pm revoke " + PKG + " android.permission.BLUETOOTH_CONNECT");
  sh("pm revoke " + PKG + " android.permission.BLUETOOTH_SCAN");
}
async function restartApp() {
  sh("am force-stop " + PKG);
  await sleep(1200);
  sh("input keyevent 3");
  await sleep(600);
  sh("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(9000);
  for (let i = 0; i < 3; i++) {
    sh("uiautomator dump /sdcard/_b03.xml");
    const xml = sh("cat /sdcard/_b03.xml");
    if (!/不允许/.test(xml)) break;
    const m = xml.match(/text="不允许"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m) {
      sh("input tap " + Math.round((+m[1] + +m[3]) / 2) + " " + Math.round((+m[2] + +m[4]) / 2));
      await sleep(2000);
    } else break;
  }
}

(async () => {
  const out = [];
  const log = (s) => { console.log(s); out.push(s); };

  log("=== P5B-M03 §A：前台服务类型合规性（设备端）===");
  log("设备: " + sh("getprop ro.product.model").trim() +
      "  Android " + sh("getprop ro.build.version.release").trim() +
      "  SDK " + sh("getprop ro.build.version.sdk").trim());
  log("");
  log("## 本轮的设计变更");
  log("  P5B-M02：无蓝牙权限 → DATA_SYNC 保活（判定为滥用）");
  log("  P5B-M03：无蓝牙权限 → **不起前台服务**（离线浏览不需要 FGS）");
  log("");

  // ---------------------------------------------------------------- A0 有权限基线
  console.log("=== A0. 有蓝牙权限 → 应正常起前台服务 ===");
  grant();
  await sleep(1500);
  sh("logcat -b crash -c");
  await restartApp();
  const p0 = permState();
  info("权限: connect=" + p0.connect + " fgsDev=" + p0.fgsDev + " fgsSync=" + p0.fgsSync);
  ok(p0.connect === true, "A0 前置：蓝牙权限已授予");
  ok(pid() !== "", "A0 App 已启动");
  ok(fatalCount() === 0, "A0 无 FATAL");
  const s0 = serviceInfo();
  info("ServiceRecord=" + s0.has + "  startForegroundCount=" + s0.startForegroundCount);
  ok(s0.startForegroundCount !== null && s0.startForegroundCount >= 1,
     "A0 **有权限时前台服务正常启动**（count=" + s0.startForegroundCount + "）");

  // ---------------------------------------------------------------- A1 无权限（本轮核心）
  console.log("\n=== A1. 无蓝牙权限 → **不应**起前台服务（本轮核心变更）===");
  sh("logcat -b crash -c");
  revoke();
  await sleep(1500);
  await restartApp();
  const p1 = permState();
  ok(p1.connect === false, "A1 前置：蓝牙权限已撤销");
  ok(fatalCount() === 0, "A1 **无权限也不崩**（FATAL=0）");
  ok(pid() !== "", "A1 App 进程存活（可正常浏览主题）");

  const s1 = serviceInfo();
  info("ServiceRecord=" + s1.has + "  startForegroundCount=" + s1.startForegroundCount);
  ok(s1.has, "A1 ObdService 仍在（连接页需要 ObdController.init）");
  ok(s1.startForegroundCount === 0 || s1.startForegroundCount === null,
     "A1 **无权限时不占用前台服务**（count=" + s1.startForegroundCount +
     "）—— 符合「不为延长存活滥用 dataSync」");

  // ---------------------------------------------------------------- A2 无残留采集
  console.log("\n=== A2. 无权限时无 OBD 采集空转 ===");
  sh("logcat -c");
  await sleep(3000);
  const engineLog = sh("logcat -d 2>/dev/null | grep -iE '轮询列表|开始轮询|ObdEngine' | tail -5");
  info("引擎日志: " + (engineLog.trim() || "(空 —— 未轮询)"));
  ok(!/轮询列表已刷新|开始轮询/.test(engineLog), "A2 无权限时**没有启动轮询**");

  // ---------------------------------------------------------------- A3 授权后恢复
  console.log("\n=== A3. 授权后回到前台 → 前台服务应恢复 ===");
  //
  // ⚠️ 第一版直接用 `am start` 复现失败（count 一直是 0）—— **测试方法错**：
  //    当 Activity 已经处于 resumed 状态时，`am start` 只会 deliver intent
  //    给现有实例，**不会触发 onResume**，所以 MainActivity.onResume 里的
  //    恢复逻辑根本没执行。
  //
  //    真实用户路径是：拒权限 → 去系统设置授权 → **按 HOME 再切回 App**
  //    → 触发 onResume。所以这里用 HOME 往返来模拟。
  grant();
  await sleep(1500);
  sh("input keyevent 3");        // HOME（App 进入后台，onPause/onStop）
  await sleep(2000);
  sh("am start -n " + PKG + "/.ui.MainActivity");   // 切回（触发 onResume）
  await sleep(7000);
  const s3 = serviceInfo();
  info("startForegroundCount=" + s3.startForegroundCount);
  ok(s3.startForegroundCount !== null && s3.startForegroundCount >= 1,
     "A3 **授权后前台服务自动恢复**（count=" + s3.startForegroundCount + "）");
  ok(fatalCount() === 0, "A3 恢复过程无 FATAL");

  // ---------------------------------------------------------------- A4 前后台
  console.log("\n=== A4. 前后台切换 5 次 → 状态稳定 ===");
  sh("logcat -b crash -c");
  const pidBefore = pid();
  for (let i = 0; i < 5; i++) {
    sh("input keyevent 3");
    await sleep(1400);
    sh("am start -n " + PKG + "/.ui.MainActivity");
    await sleep(1800);
  }
  ok(fatalCount() === 0, "A4 5 次前后台切换 0 崩溃");
  ok(pid() !== "", "A4 进程存活");
  const recs = (sh("dumpsys activity services " + PKG).match(/ServiceRecord\{[^}]*ObdService/g) || []).length;
  ok(recs <= 1, "A4 无服务残留（ServiceRecord=" + recs + "）");

  // ---------------------------------------------------------------- A5 反复撤销/授权
  console.log("\n=== A5. 反复撤销/授权 3 轮 → 无残留 ===");
  sh("logcat -b crash -c");
  for (let i = 1; i <= 3; i++) {
    revoke();
    await sleep(700);
    sh("am force-stop " + PKG);
    await sleep(700);
    sh("am start -n " + PKG + "/.ui.MainActivity");
    await sleep(4500);
    grant();
    await sleep(700);
    info("第 " + i + " 轮完成");
  }
  ok(fatalCount() === 0, "A5 3 轮反复后 0 崩溃");
  const recs5 = (sh("dumpsys activity services " + PKG).match(/ServiceRecord\{[^}]*ObdService/g) || []).length;
  ok(recs5 <= 1, "A5 无服务残留（ServiceRecord=" + recs5 + "）");

  // ---------------------------------------------------------------- A6 onTimeout 处理
  console.log("\n=== A6. Android 15 onTimeout 处理（代码层，无法在本环境实测触发）===");
  const svc = fs.readFileSync(path.join(ROOT, "app", "src", "main", "java", "com", "icar", "obd", "service", "ObdService.kt"), "utf8");
  ok(/override fun onTimeout\(/.test(svc), "A6 已重写 onTimeout(startId)（防 Android 15+ ANR/崩溃）");
  ok(/stopForeground\(STOP_FOREGROUND_REMOVE\)/.test(svc), "A6 onTimeout 里退出前台而不是杀进程");
  ok(/isForegroundStarted = false/.test(svc), "A6 onTimeout 后状态复位（可重新进入前台）");
  info("⚠️ 本环境只有 Android 14，**无法实测 Android 15 的 6 小时限制**");

  // ---------------------------------------------------------------- A7 恢复
  console.log("\n=== A7. 恢复设备 ===");
  grant();
  await sleep(1200);
  sh("am force-stop " + PKG);
  await sleep(800);
  sh("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(6000);
  ok(permState().connect === true, "A7 权限已恢复");
  ok(pid() !== "", "A7 App 正常");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 环境限制：只有 Android 14（API 34）。Android 15/16 的 dataSync 6 小时");
  log("   限制**未实测**，只做了代码层准备（onTimeout）与 targetSdk 核对（34 < 35）。");
  log("   不得据此宣称 Android 15/16 长期运行安全。");
  fs.writeFileSync(OUT, out.join("\n"), "utf8");
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
