// ============================================================================
// P5A-M03 阶段 F：数据源互斥加固复核（设备实测）
//
// 覆盖任务 §8 的九项：
//   F1 模拟默认关闭（新进程起来时没有模拟来源）
//   F2 显式开启生效
//   F3 停止模拟 → 来源失效（BUSD ok=0）
//   F4 真实采集启动时模拟自动退让（看门狗）
//   F5 看门狗 2 秒窗口：退让前观察是否有异常（记录窗口长度，不谎称零风险）
//   F6 Activity 前后台切换后状态仍一致
//   F7 重复广播（同一场景连发 10 次）不崩、状态不飘
//   F8 进程重启后模拟回到"关闭"（默认关闭）
//   F9 非法场景请求被拒且不崩
//
// ⚠️ 本脚本只在**模拟器 + Debug 包**上验证，不涉及任何真实适配器/车辆，
//    也不发送任何 CAN/ECU 写入。因此**不能**据此声称真实 OBD 与模拟永不冲突。
// ============================================================================
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const DEV = process.env.ADB_DEVICE || "emulator-5554";

function sh(a, t) {
  try { return execFileSync(ADB, ["-s", DEV].concat(a), { encoding: "utf8", timeout: t || 60000, maxBuffer: 16 * 1024 * 1024 }); }
  catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bc = (extra) => sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM"].concat(extra || []));
const alive = () => sh(["shell", "ps", "-A"]).indexOf("com.icar.obd") >= 0;
function busDump() {
  sh(["logcat", "-c"]);
  bc(["--es", "dump", "1"]);
  const out = sh(["logcat", "-d", "-s", "SimBus:I"]);
  const rows = [];
  out.split("\n").forEach((l) => {
    const m = /BUSD (\S+) ok=(-?\d+) v=(\S+) err=(.*?) name=(.*)$/.exec(l.trim());
    if (m) rows.push({ pid: m[1], ok: +m[2], v: m[3], err: m[4].trim(), name: m[5].trim() });
  });
  return rows;
}
function simState() {
  sh(["logcat", "-c"]);
  bc(["--es", "scenario", "dump_state_never_matches"]);
  const out = sh(["logcat", "-d", "-s", "SimControl:I SimPidSource:I"]);
  return out;
}
const fatal = () => sh(["logcat", "-d", "-s", "AndroidRuntime:E"]).split("\n").filter((x) => /FATAL/.test(x)).length;

let pass = 0, fail = 0, note = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => (note++, console.log("  · " + m));

(async function () {
  console.log("=== P5A-M03 阶段 F：数据源互斥加固 ===\n");

  // ---------- F8 先做：进程重启后应为"关闭" ----------
  console.log("--- F8. 进程重启后模拟默认关闭 ---");
  sh(["shell", "am", "force-stop", "com.icar.obd"]);
  await sleep(2000);
  sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await sleep(10000);
  const fresh = busDump();
  // ⚠️ 重启后"0 条"是**正确**结果：BUSD 只在总线里有值时才打印，
  //    没有任何来源供数 → 一条都不会有。所以这里把打印条数当信息，不当断言。
  info("F8 重启后总线打印条数：" + fresh.length + "（0 = 没有任何来源供数，即默认关闭）");
  ok(fresh.every((r) => r.ok === 0),
    "F8 重启后**没有任何来源在供数**（" + fresh.length + " 条，全部 ok=0 或为空）→ 默认关闭");

  // ---------- F2 显式开启 ----------
  console.log("\n--- F2. 显式开启生效 ---");
  bc(["--es", "scenario", "normal", "--ei", "step", "5"]);
  await sleep(3000);
  const on = busDump();
  ok(on.some((r) => r.ok === 1), "F2 开启后有 PID ok=1（" + on.filter((r) => r.ok === 1).length + " 个）");
  info("样例：" + on.slice(0, 3).map((r) => r.pid + "=" + r.v).join("  "));

  // ---------- F7 重复广播 ----------
  console.log("\n--- F7. 重复广播 10 次不崩、状态不飘 ---");
  for (let i = 0; i < 10; i++) { bc(["--es", "scenario", "accel", "--ei", "step", "3"]); await sleep(250); }
  await sleep(2500);
  const dup = busDump();
  ok(alive(), "F7 连发 10 次后进程仍存活");
  ok(dup.some((r) => r.ok === 1), "F7 状态仍为「在供数」（没被连发打乱）");
  ok(fatal() === 0, "F7 0 FATAL");

  // ---------- F9 非法场景 ----------
  console.log("\n--- F9. 非法场景被拒且不崩 ---");
  bc(["--es", "scenario", "definitely_not_a_scenario"]);
  await sleep(2000);
  ok(alive(), "F9 非法场景后进程仍存活");
  const afterBad = busDump();
  info("非法场景后仍 ok=1 的 PID 数：" + afterBad.filter((r) => r.ok === 1).length + "（原状态保持不变属正确）");
  ok(fatal() === 0, "F9 0 FATAL");

  // ---------- F6 前后台 ----------
  console.log("\n--- F6. 前后台切换 ---");
  sh(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await sleep(4000);
  sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await sleep(6000);
  const bg = busDump();
  ok(alive(), "F6 回前台后进程存活");
  info("回前台后 ok=1 的 PID：" + bg.filter((r) => r.ok === 1).length + "（不要求仍为 1，只要求状态自洽）");
  ok(bg.length >= 3, "F6 前后台切换后总线仍可读");

  // ---------- F3 停止模拟 → 失效 ----------
  console.log("\n--- F3. 停止模拟 → 来源失效 ---");
  bc(["--es", "scenario", "off"]);
  await sleep(3000);
  const off = busDump();
  ok(off.every((r) => r.ok === 0), "F3 关闭后全部 ok=0（" + off.length + " 条）");
  const withErr = off.filter((r) => /采集来源已停止/.test(r.err));
  ok(withErr.length >= 3, "F3 失效原因是「采集来源已停止」（" + withErr.length + " 条）");

  // ---------- F4/F5 看门狗退让 ----------
  console.log("\n--- F4/F5. 真实轮询起来时模拟退让（看门狗 2 秒窗口）---");
  bc(["--es", "scenario", "normal", "--ei", "step", "5"]);
  await sleep(2500);
  const before = busDump();
  ok(before.some((r) => r.ok === 1), "F4 模拟先处于供数状态");

  // 通过界面的「连接 → 模拟信号」按钮之外的路径主动 startPolling 不好直接触发，
  // 这里用**模拟信号页的开关**反向验证：打开既有模拟界面会 start SignalSimulator，
  // 关掉后若真实轮询未连则不应恢复。
  // ⚠️ 无真实适配器 → 无法真正启动 engine。因此**F4/F5 只能验证"窗口存在且被记录"**，
  //    不能验证"退让真的发生"。这里如实打印结论。
  sh(["logcat", "-c"]);
  await sleep(2500);
  const wd = sh(["logcat", "-d", "-s", "SimPidSource:I SimPidSource:W"]);
  const yielded = /真实轮询已启动，模拟自动退让/.test(wd);
  if (yielded) {
    ok(true, "F5 观察到看门狗退让日志");
  } else {
    info("F5 未观察到退让（预期：模拟器无真实适配器，engine 起不来）→ **该路径本轮未验证**");
  }
  info("看门狗常量 WATCHDOG_MS=2000：并发窗口最长 2 秒（不是 0），此风险**未消除**，仅被缩小");

  // ---------- 收尾：关掉模拟，别把环境留在模拟态 ----------
  bc(["--es", "scenario", "off"]);
  await sleep(1500);
  ok(fatal() === 0, "全程 0 FATAL");

  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail + " 仅说明=" + note);
  console.log("  ⚠ 本结果**只**证明模拟器 + Debug 包下的行为；");
  console.log("     不证明真实 OBD 与模拟信号「绝对不会冲突」（无真实适配器可验）。");
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
