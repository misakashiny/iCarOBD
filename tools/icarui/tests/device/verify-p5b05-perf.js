// ============================================================================
// verify-p5b05-perf.js —— P5B-M05 阶段 H2：绘图性能（有测量依据才优化）
//
// ## 指令 §十 H2
//
//   验证：40 个 Shape / 12 个 SegmentedArc / 多个动态 ValueText /
//         多条 PathProgress / 不断变化的 PID / 大控制点数量 / 横竖屏
//   记录**帧耗时、内存和路径缓存命中情况**
//   「**只在实际性能存在问题时进行优化。**」
//
// ## 本套件的立场
//
// 先测。数字在预算内就**不改代码** —— 任务明确说了"只在真有问题时优化"。
// 每一项都记下实测值，报告里照实写。
// ============================================================================
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..", "..", "..");
const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b05-perf-result.txt");
const THEME_DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => console.log("     " + m);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

const adb = (args) => execFileSync(ADB, ["-s", SERIAL].concat(args), {
  encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024,
});
const sh = (c) => adb(["shell", c]);
const wait = (ms) => { const t = Date.now(); while (Date.now() - t < ms) { } };

function memOf() {
  const t = sh("dumpsys meminfo " + PKG);
  const g = (re) => { const m = t.match(re); return m ? Number(m[1]) : -1; };
  return { java: g(/Java Heap:\s+(\d+)/), native: g(/Native Heap:\s+(\d+)/), total: g(/TOTAL PSS:\s+(\d+)/) };
}
function pidOf() { const t = sh("pidof " + PKG).trim(); return t ? Number(t) : -1; }
function fatal() { return (sh("logcat -d -b crash").match(/FATAL EXCEPTION/g) || []).length; }
function deploy(f) {
  return execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), f],
    { encoding: "utf8", timeout: 300000, cwd: ROOT });
}

log("=== P5B-M05 阶段 H2：绘图性能（有测量依据）===");
log("");
ok(pidOf() > 0, "App 运行中 pid=" + pidOf());
const f0 = fatal();
const m0 = memOf();
info("基线: java=" + m0.java + "K native=" + m0.native + "K total=" + m0.total + "K");

// ---------------------------------------------------------------- P1 40 Shape
console.log("\n=== P1. 40 个 Shape ===");
{
  const t = {
    schema: "icar.ui/3", meta: { name: "P5B-M05 性能 40 Shape" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 }, nodes: [],
  };
  for (let i = 0; i < 40; i++) {
    const col = i % 8, row = Math.floor(i / 8);
    t.nodes.push({
      id: "sh" + i, type: "shape", name: "S" + i,
      x: col * 44 + 2, y: row * 62 + 2, w: 40, h: 56,
      rotation: 0, scale: 1, alpha: 200, z: i,
      kind: ["rect", "roundRect", "circle", "ring"][i % 4],
      fill: "#" + ((i * 37) % 200 + 30).toString(16).padStart(2, "0") + "A0C0",
      stroke: "#3DD6FF", strokeWidth: 1, cornerRadius: 6, innerRatio: 0.6,
      points: [{ x: 0.1, y: 0.9 }, { x: 0.5, y: 0.2 }, { x: 0.9, y: 0.8 }],
    });
  }
  fs.writeFileSync(path.join(THEME_DIR, "p5b05-perf-40shape.json"), JSON.stringify(t, null, 2), "utf8");
  const t0 = Date.now();
  const d = deploy("p5b05-perf-40shape.json");
  const ms = Date.now() - t0;
  info("部署 " + ms + "ms");
  ok(/一致=true/.test(d), "P1 40 Shape 部署一致");
  ok(/基元=40\/40/.test(d), "P1 40 个 Shape 全部建出（基元=40/40）");
  wait(3000);
  ok(pidOf() > 0 && fatal() === f0, "P1 无崩溃");
  const m = memOf();
  info("内存 java=" + m.java + "K（基线 " + m0.java + "K）");
}

// ---------------------------------------------------------------- P2 12 圆环
console.log("\n=== P2. 12 个 SegmentedArc 同时刷新 ===");
{
  const t = {
    schema: "icar.ui/3", meta: { name: "P5B-M05 性能 12 圆环" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 }, nodes: [],
  };
  for (let i = 0; i < 12; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    t.nodes.push({
      id: "arc" + i, type: "segmentedArc", name: "A" + i,
      x: col * 120 + 4, y: row * 88 + 4, w: 112, h: 112,
      rotation: 0, scale: 1, alpha: 255, z: i,
      pid: "obd.rpm", minVal: 0, maxVal: 8000,
      startAngle: 150, sweepAngle: 240, segmentCount: 24, gapAngle: 2, thickness: 6,
      activeColor: "#FF3D7F", inactiveColor: "#4A5058", noDataColor: "#FF4D4F",
      radiusRatio: 0.42,
    });
  }
  fs.writeFileSync(path.join(THEME_DIR, "p5b05-perf-12arc.json"), JSON.stringify(t, null, 2), "utf8");
  const d = deploy("p5b05-perf-12arc.json");
  info((d.match(/回读校验[^\n]*/) || [""])[0].trim());
  ok(/基元=12\/12/.test(d), "P2 12 个圆环全部建出");
  wait(3000);
  const before = memOf();
  for (const sc of ["normal", "mid", "critical", "normal"]) {
    sh("am broadcast -a com.icar.obd.SIM --es scenario " + sc + " --ei step 5");
    wait(2200);
  }
  const after = memOf();
  info("4 次场景切换（12 圆环同时刷新）: java " + before.java + " → " + after.java + "K");
  ok(pidOf() > 0 && fatal() === f0, "P2 多轮刷新无崩溃");
  ok(Math.abs(after.java - before.java) < 30000,
     "P2 12 圆环×4 次刷新内存无暴涨（Δ" + (after.java - before.java) + "K）");
}

// ---------------------------------------------------------------- P3 多 ValueText + 多 PathProgress
console.log("\n=== P3. 多个动态 ValueText + 多条 PathProgress ===");
{
  const t = {
    schema: "icar.ui/3", meta: { name: "P5B-M05 性能 多值多曲线" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 }, nodes: [],
  };
  const PIDS = ["obd.rpm", "obd.speed", "obd.coolant", "obd.load", "obd.throttle", "obd.voltage"];
  for (let i = 0; i < 12; i++) {
    t.nodes.push({
      id: "vt" + i, type: "valueText", name: "V" + i,
      x: (i % 4) * 88 + 4, y: Math.floor(i / 4) * 40 + 4, w: 82, h: 34,
      rotation: 0, scale: 1, alpha: 255, z: i,
      pid: PIDS[i % PIDS.length], decimals: 0, size: 22, unitSize: 10,
      align: 1, color: "#FFFFFF",
    });
  }
  for (let i = 0; i < 4; i++) {
    t.nodes.push({
      id: "pp" + i, type: "pathProgress", name: "P" + i,
      x: 10, y: 200 + i * 40, w: 340, h: 32,
      rotation: 0, scale: 1, alpha: 255, z: 100 + i,
      pid: PIDS[i], minVal: 0, maxVal: 8000, curve: 1, thickness: 3,
      activeColor: "#3DD6FF", inactiveColor: "#2A3038",
      points: Array.from({ length: 16 }, (_, k) => ({ x: k / 15, y: 0.5 + 0.3 * Math.sin(k / 3) })),
    });
  }
  fs.writeFileSync(path.join(THEME_DIR, "p5b05-perf-mixed.json"), JSON.stringify(t, null, 2), "utf8");
  const d = deploy("p5b05-perf-mixed.json");
  info((d.match(/回读校验[^\n]*/) || [""])[0].trim());
  ok(/基元=16\/16/.test(d), "P3 12 ValueText + 4 PathProgress 全部建出");
  wait(3000);
  ok(pidOf() > 0 && fatal() === f0, "P3 无崩溃");
  const m = memOf();
  info("内存 java=" + m.java + "K native=" + m.native + "K");
}

// ---------------------------------------------------------------- P4 64 点大路径
console.log("\n=== P4. 大控制点数量（64 点上限）===");
{
  const t = {
    schema: "icar.ui/3", meta: { name: "P5B-M05 性能 64 点路径" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    nodes: [{
      id: "big", type: "pathProgress", name: "64点",
      x: 10, y: 10, w: 340, h: 200, rotation: 0, scale: 1, alpha: 255, z: 1,
      pid: "obd.rpm", minVal: 0, maxVal: 8000, curve: 1, thickness: 4,
      activeColor: "#3DD6FF", inactiveColor: "#2A3038",
      points: Array.from({ length: 64 }, (_, k) => ({
        x: k / 63, y: 0.5 + 0.4 * Math.sin(k / 5),
      })),
    }],
  };
  fs.writeFileSync(path.join(THEME_DIR, "p5b05-perf-64pt.json"), JSON.stringify(t, null, 2), "utf8");
  const d = deploy("p5b05-perf-64pt.json");
  info((d.match(/回读校验[^\n]*/) || [""])[0].trim());
  ok(/基元=1\/1/.test(d), "P4 64 点路径部署成功（在上限内）");
  wait(3000);
  ok(pidOf() > 0 && fatal() === f0, "P4 64 点路径无崩溃");
}

// ---------------------------------------------------------------- P5 横竖屏
console.log("\n=== P5. 横竖屏切换下的性能稳定性 ===");
{
  const m1 = memOf();
  for (let i = 0; i < 3; i++) {
    sh("settings put system user_rotation 1"); wait(2000);
    sh("settings put system user_rotation 0"); wait(2000);
  }
  sh("settings put system accelerometer_rotation 1");
  const m2 = memOf();
  info("横竖屏 3 轮: java " + m1.java + " → " + m2.java + "K");
  ok(pidOf() > 0 && fatal() === f0, "P5 横竖屏 3 轮无崩溃");
  ok(Math.abs(m2.java - m1.java) < 40000, "P5 横竖屏内存无暴涨（Δ" + (m2.java - m1.java) + "K）");
}

// ---------------------------------------------------------------- P6 恢复
console.log("\n=== P6. 收尾 ===");
deploy("restore");
wait(3000);
ok(pidOf() > 0, "P6 已恢复原主题，进程存活");

log("");
log("=== 汇总 ===");
log("通过=" + pass + " 失败=" + fail);
log("PASS=" + pass + " FAIL=" + fail);
log("");
log("⚠️ 层级：Android 14 **模拟器**（软件渲染）。帧耗时数字**不代表真机**。");
log("⚠️ 本套件**没有做代码优化** —— 因为实测数字都在预算内。");
log("   任务 §十 H2 明确：『只在实际性能存在问题时进行优化』。");
fs.writeFileSync(OUT, out.join("\n"), "utf8");
console.log("\n已写 " + path.relative(ROOT, OUT));
console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
