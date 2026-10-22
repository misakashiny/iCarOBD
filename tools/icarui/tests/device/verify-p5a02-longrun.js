// ============================================================================
// P5A-M02 阶段 F：长时间运行性能与稳定性（>=10 分钟）
//
// ## 任务明确要求
//
// > 「不能仅因 60 秒内存增长低于某个宽松阈值就断言不存在内存泄漏。」
//
// 所以本脚本的做法是：
//   · 每 30 秒采一次 PSS / Java heap（共 20+ 个点）
//   · 拟合**斜率**（MB/分钟）
//   · 分三段比较（前 1/3、中 1/3、后 1/3 的平均），看是**继续上升**还是**趋于平台**
//   · 结论写成「实测趋势」，不用一句"没超阈值"糊过去
//
// ## 压力内容（循环，每 2 秒一档）
//
//   normal → accel → decel → warmup → alarm → critical → multi → disconnect → recover
//   每 2 分钟：横滑到设置页再回来（页面切换）
//   每 4 分钟：断开 3 秒再恢复（反复断连）
//
// ## 产物
//
//   docs/02_验证记录/screenshots/perf-baseline-p5a02.json
// ============================================================================
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const DEV = process.env.ADB_DEVICE || "emulator-5554";
const OUT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots",
  "perf-baseline-p5a02.json");

const DURATION_MS = 11 * 60 * 1000;   // 11 分钟（>10 分钟要求）
const SCENES = ["normal", "accel", "decel", "warmup", "alarm", "critical", "multi", "disconnect", "recover"];

function sh(a, t) {
  try {
    return execFileSync(ADB, ["-s", DEV].concat(a), {
      encoding: "utf8", timeout: t || 60000, maxBuffer: 16 * 1024 * 1024
    });
  } catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mem() {
  const d = sh(["shell", "dumpsys", "meminfo", "com.icar.obd"]);
  const pss = /TOTAL\s+(\d+)/.exec(d);
  const java = /Java Heap:\s+(\d+)/.exec(d);
  const nat = /Native Heap:\s+(\d+)/.exec(d);
  return {
    pssKB: pss ? +pss[1] : null,
    javaKB: java ? +java[1] : null,
    nativeKB: nat ? +nat[1] : null
  };
}
function gfx() {
  const d = sh(["shell", "dumpsys", "gfxinfo", "com.icar.obd"]);
  const tf = /Total frames rendered:\s*(\d+)/.exec(d);
  const jf = /Janky frames \([\d.]+ms\):\s*(\d+) \(([\d.]+)%\)/.exec(d);
  const p = (re) => { const m = re.exec(d); return m ? +m[1] : null; };
  return {
    totalFrames: tf ? +tf[1] : null,
    jankyPct: jf ? +jf[2] : null,
    p50: p(/(?:50th percentile:\s*)(\d+)ms/),
    p90: p(/(?:90th percentile:\s*)(\d+)ms/),
    p99: p(/(?:99th percentile:\s*)(\d+)ms/)
  };
}
const fatal = () => sh(["logcat", "-d", "-s", "AndroidRuntime:E"]).split("\n").filter((x) => /FATAL/.test(x)).length;
const anr = () => sh(["logcat", "-d"]).split("\n").filter((x) => /ANR in com\.icar\.obd/.test(x)).length;
const alive = () => sh(["shell", "ps", "-A"]).indexOf("com.icar.obd") >= 0;
function fg() {
  const d = sh(["shell", "dumpsys", "activity", "activities"]);
  return /topResumedActivity=[^\n]*?com\.icar\.obd/.test(d);
}

function linearSlope(points) {  // points: [{t(min), y(MB)}]
  const n = points.length;
  if (n < 2) return 0;
  const sx = points.reduce((s, p) => s + p.t, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.t * p.t, 0);
  const sxy = points.reduce((s, p) => s + p.t * p.y, 0);
  const den = n * sxx - sx * sx;
  return den === 0 ? 0 : (n * sxy - sx * sy) / den;
}

(async function () {
  console.log("=== P5A-M02 阶段 F：长跑 " + (DURATION_MS / 60000) + " 分钟 ===\n");

  // 就绪检查
  sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await sleep(8000);
  sh(["logcat", "-c"]);
  // 起始状态：正常场景
  sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "5"]);
  await sleep(2000);
  sh(["shell", "dumpsys", "gfxinfo", "com.icar.obd", "reset"]);

  const t0 = Date.now();
  const samples = [];
  let i = 0, lastPageSwitch = 0, lastReconnect = 0;
  let maxPss = 0, minPss = 1e9;

  while (Date.now() - t0 < DURATION_MS) {
    const elapsedMin = (Date.now() - t0) / 60000;

    // ---- 每 2 秒切一档场景 ----
    const scene = SCENES[i % SCENES.length];
    sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", scene, "--ei", "step", "3"]);
    i++;

    // ---- 每 2 分钟：页面切换（设置页 → 画布）----
    if (elapsedMin - lastPageSwitch >= 2) {
      lastPageSwitch = elapsedMin;
      sh(["shell", "input", "swipe", "1000", "1200", "100", "1200", "200"]);
      await sleep(1200);
      sh(["shell", "input", "swipe", "150", "1200", "1000", "1200", "200"]);
      await sleep(1200);
    }
    // ---- 每 4 分钟：额外反复断连 ----
    if (elapsedMin - lastReconnect >= 4) {
      lastReconnect = elapsedMin;
      for (let k = 0; k < 3; k++) {
        sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "disconnect"]);
        await sleep(1000);
        sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "recover", "--ei", "step", "3"]);
        await sleep(1000);
      }
    }

    // ---- 每 30 秒采内存 ----
    if (i % 15 === 0) {
      const m = mem();
      if (m.pssKB) {
        const pssMB = m.pssKB / 1024;
        maxPss = Math.max(maxPss, pssMB); minPss = Math.min(minPss, pssMB);
        samples.push({ t: +elapsedMin.toFixed(2), pssMB: +pssMB.toFixed(2), javaMB: +(m.javaKB / 1024).toFixed(2) });
        console.log("  t=" + elapsedMin.toFixed(1) + "min  PSS=" + pssMB.toFixed(1) +
          "MB  Java=" + (m.javaKB / 1024).toFixed(1) + "MB  scene=" + scene +
          "  存活=" + (alive() ? "Y" : "N"));
      }
    }
    await sleep(2000);
  }

  // ---- 末态采集 ----
  const endMem = mem();
  const g = gfx();
  const fatals = fatal();
  const anrs = anr();

  // ---- 趋势分析 ----
  const slope = linearSlope(samples.map((s) => ({ t: s.t, y: s.pssMB })));
  const third = Math.floor(samples.length / 3) || 1;
  const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
  const seg1 = avg(samples.slice(0, third).map((s) => s.pssMB));
  const seg3 = avg(samples.slice(-third).map((s) => s.pssMB));
  const plateau = seg3 <= seg1 + 2.0;   // 后段不比前段多 2MB 以上 → 视为平台

  const result = {
    generatedAt: new Date().toISOString().replace("Z", "+08:00"),
    device: DEV,
    durationMin: +(DURATION_MS / 60000).toFixed(1),
    samples,
    summary: {
      startPssMB: samples.length ? samples[0].pssMB : null,
      endPssMB: +(endMem.pssKB / 1024).toFixed(2),
      maxPssMB: +maxPss.toFixed(2),
      minPssMB: +minPss.toFixed(2),
      growthMB: samples.length ? +(samples[samples.length - 1].pssMB - samples[0].pssMB).toFixed(2) : null,
      slopeMBPerMin: +slope.toFixed(3),
      seg1AvgMB: +seg1.toFixed(2),
      seg3AvgMB: +seg3.toFixed(2),
      plateau,
      gfx: g,
      fatals,
      anrs,
      alive: alive(),
      foreground: fg()
    }
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");

  let pass = 0, fail = 0;
  const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

  console.log("\n=== 结果 ===");
  console.log("  采样点=" + samples.length + "  时长=" + (DURATION_MS / 60000) + "min");
  console.log("  PSS: 起 " + result.summary.startPssMB + " → 末 " + result.summary.endPssMB +
    " MB（max " + result.summary.maxPssMB + " / min " + result.summary.minPssMB + "）");
  console.log("  斜率=" + result.summary.slopeMBPerMin + " MB/min");
  console.log("  分段均值: 前1/3=" + result.summary.seg1AvgMB + "  后1/3=" + result.summary.seg3AvgMB +
    " → " + (plateau ? "**趋于平台**" : "**仍在上升**"));
  console.log("  帧: total=" + g.totalFrames + " janky=" + g.jankyPct + "% P50=" + g.p50 +
    "ms P90=" + g.p90 + "ms P99=" + g.p99 + "ms");
  console.log("  FATAL=" + fatals + "  ANR=" + anrs + "  存活=" + result.summary.alive +
    "  前台=" + result.summary.foreground);

  console.log("");
  ok(fatals === 0, "F1 全程 0 FATAL");
  ok(anrs === 0, "F2 全程 0 ANR");
  ok(result.summary.alive, "F3 结束时进程仍存活");
  ok(result.summary.foreground, "F4 结束时仍在前台（没被系统杀掉/踢出）");
  ok(Math.abs(result.summary.growthMB) < 60, "F5 PSS 增长 " + result.summary.growthMB + " MB（粗阈值 60MB，仅兜底）");
  ok(plateau || slope < 0.5,
    "F6 内存趋势：" + (plateau ? "后段趋平台（seg3-seg1=" + (seg3 - seg1).toFixed(2) + "MB）"
      : "斜率 " + slope.toFixed(2) + " MB/min < 0.5"));

  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("  基线已存: " + path.relative(process.cwd(), OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
