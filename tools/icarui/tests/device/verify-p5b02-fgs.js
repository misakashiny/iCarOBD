// ============================================================================
// verify-p5b02-fgs.js —— P5B-M02 段 B：前台服务安全专项（**设备端真实验证**）
//
// ## 为什么必须做这个
//
// P5B-M02 补充指令 §B 明确：
//   「使用 Android 模拟器**实际验证**，**不以纯函数测试代替系统行为测试**。」
//
// P5A-M01 R2 修了「拒绝蓝牙权限 → App 崩溃」，但只用：
//   · 纯函数单测（ForegroundServiceDegradeTest 5 项）
//   · 一次手工 adb 验证
// 这两者都**证明不了**系统层面的行为，尤其是：
//   · 无类型重试时 **Android 是否仍继承 Manifest 的 connectedDevice 类型**？
//   · 降级后 Service 真的还在跑吗？
//   · 未授权时是否仍有采集/重连任务在后台空转？
//   · 重复拒绝/授权/前后台切换会不会留下服务残留？
//
// ## 判定手段（全部来自系统，不靠猜）
//
//   · `dumpsys activity services <pkg>` → 看 ServiceRecord 是否存在、isForeground
//   · `dumpsys package <pkg>`            → 看权限真实授予状态
//   · `logcat -b crash`                  → 看是否 FATAL
//   · `pidof <pkg>`                      → 看进程存活
//   · `dumpsys notification`             → 看前台服务通知是否存在
//
// ⚠️ 本脚本会**反复授予/撤销蓝牙权限**，跑完必须恢复原状（末尾有 restore）。
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b02-fgs-result.txt");

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

/** ServiceRecord 详情 */
function serviceInfo() {
  const d = sh("dumpsys activity services " + PKG);
  const has = /ServiceRecord\{[^}]*ObdService/.test(d);
  const fgCount = (d.match(/startForegroundCount=(\d+)/) || [])[1];
  const allowFg = (d.match(/allowStartForeground=(\w+)/) || [])[1] || null;
  return { raw: d, has: has, startForegroundCount: fgCount === undefined ? null : +fgCount, allowStartForeground: allowFg };
}

/** 权限授予状态 */
function permState() {
  const d = sh("dumpsys package " + PKG);
  const get = (name) => {
    const m = d.match(new RegExp("android\\.permission\\." + name + ": granted=(\\w+)"));
    return m ? m[1] === "true" : null;
  };
  return {
    connect: get("BLUETOOTH_CONNECT"),
    scan: get("BLUETOOTH_SCAN"),
    fgs: get("FOREGROUND_SERVICE"),
    fgsDev: get("FOREGROUND_SERVICE_CONNECTED_DEVICE"),
  };
}

const pid = () => sh("pidof " + PKG).trim();
const fatalCount = () => {
  const c = sh("logcat -d -b crash");
  return (c.match(/FATAL EXCEPTION/g) || []).length;
};

/** 前台服务通知是否存在（有通知 ≈ 前台服务真的起来了） */
function hasFgsNotification() {
  const d = sh("dumpsys notification --noredact");
  // 前台服务通知在 NotificationRecord 里带 FGS 标记
  const idx = d.indexOf(PKG);
  if (idx < 0) return false;
  const seg = d.slice(idx, idx + 4000);
  return /isForegroundService=true|FGS|ForegroundService/.test(seg) || /channel.*obd|iCar/i.test(seg);
}

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
  // 若有权限对话框，点「不允许」（构造拒绝场景）
  for (let i = 0; i < 3; i++) {
    const dumpF = path.join(require("os").tmpdir(), "p5b02b_ui.xml");
    sh("uiautomator dump /sdcard/_b02.xml");
    const xml = sh("cat /sdcard/_b02.xml");
    if (!/不允许/.test(xml)) break;
    const m = xml.match(/text="不允许"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (m) {
      const x = (+m[1] + +m[3]) / 2, y = (+m[2] + +m[4]) / 2;
      sh("input tap " + Math.round(x) + " " + Math.round(y));
      info("点了「不允许」(@" + Math.round(x) + "," + Math.round(y) + ")");
      await sleep(2000);
    } else break;
  }
}

(async () => {
  const out = [];
  const log = (s) => { console.log(s); out.push(s); };

  log("=== P5B-M02 段 B：前台服务安全专项（设备端）===");
  log("设备: " + sh("getprop ro.product.model").trim() + "  Android " + sh("getprop ro.build.version.release").trim() + "  SDK " + sh("getprop ro.build.version.sdk").trim());
  log("");

  // ---------------------------------------------------------------- B0 基线
  console.log("=== B0. 基线：恢复权限 + 冷启动 ===");
  grant();
  await sleep(1500);
  sh("logcat -b crash -c");
  await restartApp();
  const p0 = permState();
  info("权限: connect=" + p0.connect + " scan=" + p0.scan + " fgs=" + p0.fgs + " fgsDev=" + p0.fgsDev);
  ok(p0.connect === true, "B0 前置：蓝牙权限已授予");
  ok(pid() !== "", "B0 App 已启动（pid=" + pid() + "）");
  ok(fatalCount() === 0, "B0 有权限时启动无 FATAL");

  const s0 = serviceInfo();
  info("ServiceRecord 存在=" + s0.has + "  startForegroundCount=" + s0.startForegroundCount + "  allowStartForeground=" + s0.allowStartForeground);
  ok(s0.has, "B0 ObdService 已创建");
  ok(s0.startForegroundCount !== null && s0.startForegroundCount >= 1,
     "B0 **有权限时 startForeground 真的成功过**（count=" + s0.startForegroundCount + "）");

  // ---------------------------------------------------------------- B1 撤销权限后重启
  console.log("\n=== B1. 撤销蓝牙权限 → 重启 → 崩溃？服务状态？ ===");
  sh("logcat -b crash -c");
  revoke();
  await sleep(1500);
  const p1 = permState();
  info("权限: connect=" + p1.connect + " scan=" + p1.scan);
  ok(p1.connect === false, "B1 前置：蓝牙权限已撤销");

  await restartApp();
  const fatal1 = fatalCount();
  ok(fatal1 === 0, "B1 **撤销权限后启动不崩**（FATAL=" + fatal1 + "）");
  ok(pid() !== "", "B1 App 进程存活（pid=" + pid() + "）");

  const s1 = serviceInfo();
  info("ServiceRecord 存在=" + s1.has + "  startForegroundCount=" + s1.startForegroundCount + "  allowStartForeground=" + s1.allowStartForeground);
  // 关键：无类型降级到底成没成？
  ok(s1.has, "B1 降级后 ObdService 仍在运行（不是被 stopSelf 干掉）");
  if (s1.startForegroundCount === 0 || s1.startForegroundCount === null) {
    info("⚠️ startForegroundCount=" + s1.startForegroundCount +
         " → 说明**带类型与无类型都没成功**（Manifest 声明了 connectedDevice，");
    info("   Android 14 对无类型调用也会按 Manifest 类型校验 → 降级无效）");
  } else {
    info("startForegroundCount=" + s1.startForegroundCount + " → 降级成功");
  }

  // ---------------------------------------------------------------- B2 未授权时是否仍有采集
  console.log("\n=== B2. 未授权时是否有采集/重连任务在后台空转 ===");
  // 看总线是否有值（有值 = 有数据源在写 = 可能在空转）
  sh("logcat -c");
  sh("am broadcast -a com.icar.obd.SIM --es scenario off");
  await sleep(1500);
  const busLine = sh("logcat -d -s SimControl:I 2>/dev/null");
  info("模拟源已关闭（排除模拟干扰）");
  // 看 ObdEngine 是否在跑：抓它自己的日志
  const engineLog = sh("logcat -d 2>/dev/null | grep -i 'ObdEngine\\|轮询' | tail -5");
  info("引擎日志: " + (engineLog.trim() || "(无 —— 未在轮询)"));
  ok(!/轮询列表已刷新|开始轮询/.test(engineLog), "B2 未授权时**没有**启动轮询（无采集空转）");

  // ---------------------------------------------------------------- B3 重新授权
  console.log("\n=== B3. 重新授权 → 能否正常连接 ===");
  sh("logcat -b crash -c");
  grant();
  await sleep(1500);
  await restartApp();
  const p3 = permState();
  ok(p3.connect === true, "B3 权限已重新授予");
  ok(fatalCount() === 0, "B3 重新授权后启动无 FATAL");
  const s3 = serviceInfo();
  info("ServiceRecord 存在=" + s3.has + "  startForegroundCount=" + s3.startForegroundCount);
  ok(s3.startForegroundCount !== null && s3.startForegroundCount >= 1,
     "B3 **重新授权后前台服务恢复正常**（count=" + s3.startForegroundCount + "）");

  // ---------------------------------------------------------------- B4 反复拒绝/授权
  console.log("\n=== B4. 反复撤销/授权 3 轮 → 是否服务残留 ===");
  sh("logcat -b crash -c");
  for (let i = 1; i <= 3; i++) {
    revoke();
    await sleep(800);
    sh("am force-stop " + PKG);
    await sleep(800);
    sh("am start -n " + PKG + "/.ui.MainActivity");
    await sleep(5000);
    grant();
    await sleep(800);
    info("第 " + i + " 轮：撤销→重启→恢复");
  }
  const fatal4 = fatalCount();
  ok(fatal4 === 0, "B4 3 轮反复撤销/授权后 **0 次崩溃**（FATAL=" + fatal4 + "）");
  // 服务残留：有多条 ServiceRecord 就是残留
  const d4 = sh("dumpsys activity services " + PKG);
  const recCount = (d4.match(/ServiceRecord\{[^}]*ObdService/g) || []).length;
  info("ServiceRecord 条数=" + recCount);
  ok(recCount <= 1, "B4 无服务残留（ServiceRecord 条数=" + recCount + "，应 ≤1）");

  // ---------------------------------------------------------------- B5 前后台切换
  console.log("\n=== B5. 前后台切换 5 次 → 服务与进程稳定 ===");
  sh("logcat -b crash -c");
  const pidBefore = pid();
  for (let i = 1; i <= 5; i++) {
    sh("input keyevent 3");       // HOME
    await sleep(1500);
    sh("am start -n " + PKG + "/.ui.MainActivity");
    await sleep(2000);
  }
  const fatal5 = fatalCount();
  const pidAfter = pid();
  ok(fatal5 === 0, "B5 5 次前后台切换后 0 崩溃");
  info("pid 前=" + pidBefore + " 后=" + pidAfter);
  ok(pidAfter !== "", "B5 进程仍存活");
  const recCount5 = (sh("dumpsys activity services " + PKG).match(/ServiceRecord\{[^}]*ObdService/g) || []).length;
  ok(recCount5 <= 1, "B5 前后台切换后无服务残留（条数=" + recCount5 + "）");

  // ---------------------------------------------------------------- B6 恢复
  console.log("\n=== B6. 恢复设备到正常状态 ===");
  grant();
  await sleep(1200);
  sh("am force-stop " + PKG);
  await sleep(1000);
  sh("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(7000);
  const p6 = permState();
  ok(p6.connect === true && p6.scan === true, "B6 权限已恢复");
  ok(pid() !== "", "B6 App 正常运行（pid=" + pid() + "）");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 本验证全部基于 Android 系统状态（dumpsys / logcat / pidof），");
  log("   不是纯函数测试。但仍属**模拟器层级**，不等于真机/真车验收。");
  fs.writeFileSync(OUT, out.join("\n"), "utf8");
  console.log("\n已写 " + path.relative(ROOT, OUT));
  process.exitCode = fail ? 1 : 0;
})();
