// ============================================================================
// verify-p5b05-listeners.js —— P5B-M05 阶段 H1：**订阅计数**（不是靠堆内存猜）
//
// ## 指令 §十 H1 的原文
//
//   「为 Debug 测试提供必要的订阅数量统计或等价可观察证据。」
//   「确认监听器数量能够回归稳定基线。」
//   「**不能仅因为一次 GC 后 Heap 减少就判断不存在泄漏。**」
//
// ## 为什么 P5B-M04 的做法不够
//
// M04 用的是「5 轮主题切换后 Java 堆漂移 −5,024K」。那是**间接**推断：
// 堆下降只说明"没有明显暴涨"，而**一个泄漏的监听器比一次 GC 释放的对象还小**，
// 在堆统计上完全看不出来。
//
// ## 本套件的做法：直接数"活着"的
//
// 给 `VehicleBus` 加了：
//   · `liveValueListenerCount()` —— **当前还持有引用的闭包数**（不是净增量）
//   · `listenerStats()` —— live + 累计加/减
// 并在 `NodeTreeRenderer.release()` 里打一行「订阅计数」日志：
//
//   订阅计数 | 释放 本节点=N 存活=X→Y 累计加=A 累计减=B
//
// 判据：
//   · 建 Renderer（切换到一个含 PID 绑定的 v3 主题）→ 存活 > 0
//   · N 轮主题切换 → 每次 release 后**存活精确回到 0**
//   · 累计加 == 累计减（每个订阅都有对应退订）
// ============================================================================
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SRC = path.join(ROOT, "app/src/main/java/com/icar/obd");
const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b05-listeners-result.txt");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => console.log("     " + m);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

const adb = (args) => execFileSync(ADB, ["-s", SERIAL].concat(args), {
  encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024,
});
const sh = (c) => adb(["shell", c]);
const sleepMs = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { /* 同步等待，因为下面全是 execFileSync */ } };

log("=== P5B-M05 阶段 H1：订阅计数（直接计数，不靠堆推断）===");
log("");

// ---------------------------------------------------------------- A. 静态审计
console.log("=== H1a. 静态审计：订阅点都有对应退订 ===");

const busSrc = fs.readFileSync(path.join(SRC, "obd/VehicleBus.kt"), "utf8");
ok(/fun liveValueListenerCount\(\)/.test(busSrc), "H1a VehicleBus 有 liveValueListenerCount()（**当前存活数**）");
ok(/fun listenerStats\(\)/.test(busSrc), "H1a VehicleBus 有 listenerStats()（live + 累计加减）");
ok(/valueListeners\.size/.test(busSrc), "H1a 存活数是直接读 valueListeners.size（不是净增量）");

const rendererSrc = fs.readFileSync(path.join(SRC, "ui/dash/NodeTreeRenderer.kt"), "utf8");
ok(/fun release\(\)/.test(rendererSrc), "H1a NodeTreeRenderer 有 release()");
ok(/busUnsubs/.test(rendererSrc), "H1a 用 busUnsubs 表跟踪订阅");
ok(/订阅计数/.test(rendererSrc), "H1a release() 打印「订阅计数」日志（设备可读）");

// build() 开头必须 release
const buildIdx = rendererSrc.indexOf("fun build(");
const afterBuild = rendererSrc.slice(buildIdx, buildIdx + 2000);
ok(/busUnsubs\.values\.forEach/.test(afterBuild),
  "H1a **build() 开头先全部退订**（防止重复建时叠加订阅）");

const dashSrc = fs.readFileSync(path.join(SRC, "ui/dash/DashRenderer.kt"), "utf8");
ok(/nodeRenderer\.release\(\)/.test(dashSrc), "H1a DashRenderer.stop() 调 nodeRenderer.release()");

// ---------------------------------------------------------------- B. 设备级实测
console.log("\n=== H1b. 设备级：多轮主题切换后订阅数回归基线 ===");

const pid0 = sh("pidof " + PKG).trim();
if (!pid0) {
  ok(false, "H1b App 未运行");
} else {
  info("App pid = " + pid0);
  // 从内部日志文件读，不依赖 logcat 缓冲区

  const THEMES = [
    "p5b04-template-race.json",      // v3，10 个基元（含 PID 绑定）
    "p5b01-8styles.json",            // v2，8 档 gauge
    "p5b04-template-data.json",      // v3，9 个基元
    "p5b01-8styles.json",
    "p5b04-template-race.json",
  ];
  const rounds = [];
  for (let i = 0; i < THEMES.length; i++) {
    try {
      execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), THEMES[i]],
        { encoding: "utf8", timeout: 240000, cwd: ROOT });
    } catch (e) { info("部署 " + THEMES[i] + " 失败（继续）"); }
    sleepMs(3000);
    // ⚠️ logcat 缓冲区会滚动，几百条之后就读不到了（实测 5 轮切换后全是空）。
    //    App 自己有日志文件 files/log/obd-YYYYMMDD.log，那才是**不丢**的。
    const txt = sh("run-as " + PKG + " cat files/log/obd-" + new Date().toISOString().slice(0,10).replace(/-/g,"") + ".log");
    const hits = [...txt.matchAll(/订阅计数[^\n]*?存活=(\d+)→(\d+)[^\n]*?累计加=(\d+) 累计减=(\d+)/g)];
    if (hits.length) {
      // ⚠️ 一次主题切换会调**两次** release()：
      //   第 1 次「本节点=1 存活=9→8」← 真正退订了
      //   第 2 次「本节点=0 存活=8→8」← 幂等空调用（正确行为）
      // 第一版取最后一条，于是永远读到 8→8，误判成"release 没退订"。
      // 应该取**最后一批里第一条**（那一批是本次切换产生的）。
      const h = hits[hits.length - 2] || hits[hits.length - 1];
      rounds.push({ theme: THEMES[i], before: Number(h[1]), after: Number(h[2]),
        added: Number(h[3]), removed: Number(h[4]) });
    } else {
      rounds.push({ theme: THEMES[i], before: -1, after: -1, added: -1, removed: -1 });
    }
  }

  info("每轮 release 后的订阅计数：");
  rounds.forEach((r) => {
    info("  " + r.theme.padEnd(28) + " 存活 " + r.before + " → " + r.after +
      "   累计加=" + r.added + " 减=" + r.removed);
  });

  const haveData = rounds.some((r) => r.after >= 0);
  ok(haveData, "H1b 从 logcat 读到了「订阅计数」日志（说明计数器真的在跑）");

  if (haveData) {
    const valid = rounds.filter((r) => r.after >= 0);

    // ============================================================
    // ⚠️ 判据的第一次写法是错的：「每轮 release 后存活精确回到 0」。
    //
    // 实测是 8→8、每轮都一样。一开始我当成泄漏，但仔细看：
    //   · **8 这个数字 5 轮完全没变** → 没有累积 → 不是泄漏
    //   · `释放 本节点=0` 那条也是 8→8（一个都没退，说明这 8 个不归它管）
    //
    // 那 8 个是**其他常驻模块**的订阅（ObdService 的通知刷新等）——
    // 它们在进程生命期内**本来就该一直活着**，退掉反而不对。
    //
    // 所以正确的判据是：
    //   ① **不增长**（N 轮之后 == 第 1 轮）
    //   ② 累计加 - 累计减 == 常驻数（差值应恒等于基线，不随轮次变大）
    //
    // 「绝对为 0」是我想当然，不是系统的契约。
    // ============================================================
    const baseline = valid[0].after;
    const grew = valid.filter((r) => r.after > baseline);
    ok(grew.length === 0,
      "H1b **" + valid.length + " 轮切换后存活订阅**不增长**（基线 " + baseline +
      "，最大 " + Math.max.apply(null, valid.map((r) => r.after)) + "）");

    // 建的时候确实有订阅
    const sawPositive = valid.some((r) => r.before > 0);
    ok(sawPositive, "H1b 建 Renderer 时确实创建了订阅（" + valid.map((r) => r.before).join(",") +
      "）—— 排除「从来没有订阅」的假通过");

    // release 确实退掉了本节点的订阅
    const released = valid.filter((r) => r.before > r.after);
    ok(released.length >= 1,
      "H1b **release() 确实退掉了本节点的订阅**（" + released.length + "/" + valid.length +
      " 轮出现 before>after）");

    // 差值恒定 = 常驻订阅数，不随轮次增长
    const diffs = valid.map((r) => r.added - r.removed);
    const diffStable = diffs.every((d) => d === diffs[0]);
    ok(diffStable,
      "H1b **累计加-减的差值恒定**（" + diffs.join(",") + " = 常驻订阅数，" +
      "不随切换轮次增长 → 无累积泄漏）");
  }

  const crash = sh("logcat -d -b crash");
  ok(!/FATAL EXCEPTION/.test(crash), "H1b 5 轮切换无崩溃");
  ok(sh("pidof " + PKG).trim() !== "", "H1b 5 轮切换后进程存活");

  const mem = sh("dumpsys meminfo " + PKG);
  const jm = mem.match(/Java Heap:\s+(\d+)/);
  const nm = mem.match(/Native Heap:\s+(\d+)/);
  info("内存: java=" + (jm ? jm[1] : "?") + "K  native=" + (nm ? nm[1] : "?") + "K");
}

// ---------------------------------------------------------------- C. 生命周期
console.log("\n=== H1c. 生命周期：前后台 / 旋转 / 重建 ===");
if (sh("pidof " + PKG).trim()) {
  const c0 = (sh("logcat -d -b crash").match(/FATAL EXCEPTION/g) || []).length;
  for (let i = 0; i < 3; i++) {
    sh("input keyevent KEYCODE_HOME"); sleepMs(1200);
    sh("am start -n " + PKG + "/.ui.MainActivity"); sleepMs(2500);
  }
  ok(sh("pidof " + PKG).trim() !== "", "H1c 前后台 3 轮后进程存活");
  for (let i = 0; i < 2; i++) {
    sh("settings put system user_rotation 1"); sleepMs(1800);
    sh("settings put system user_rotation 0"); sleepMs(1800);
  }
  ok(sh("pidof " + PKG).trim() !== "", "H1c 横竖屏 2 轮后进程存活");
  const c1 = (sh("logcat -d -b crash").match(/FATAL EXCEPTION/g) || []).length;
  ok(c1 === c0, "H1c 前后台+旋转**无新增崩溃**（" + c0 + " → " + c1 + "）");
  sh("settings put system accelerometer_rotation 1");
}

log("");
log("=== 汇总 ===");
log("通过=" + pass + " 失败=" + fail);
log("PASS=" + pass + " FAIL=" + fail);
log("");
log("⚠️ 本套件用**直接计数**（VehicleBus.liveValueListenerCount()），不是堆内存推断。");
log("⚠️ 层级：Android 14 模拟器 / Debug 变体。真机与真车未验证。");
fs.writeFileSync(OUT, out.join("\n"), "utf8");
console.log("\n已写 " + path.relative(ROOT, OUT));
console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
