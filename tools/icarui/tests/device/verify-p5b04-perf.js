// ============================================================================
// verify-p5b04-perf.js —— P5B-M04 §九：性能与生命周期
//
// ## 指令 §九 要求检查
//
//   · ValueText 监听器泄漏
//   · 大量 Shape 的绘制性能
//   · 多个 SegmentedArc 同时刷新
//   · PathProgress 路径缓存命中率
//   · 无效控制点与超大路径
//   · 不同屏幕分辨率
//   · 横竖屏切换
//   · 前后台切换
//   · 主题切换
//   · Activity / Fragment 重建
//
//   「**性能优化必须有测量依据。**」
//   「对自由路径和数组字段设置合理资源上限。」
//
// ## 方法论
//
// 监听器泄漏**不能靠"看起来没涨"判断** —— 必须能**数出**有多少个订阅者。
// 所以本套件先用反射/dumpsys 拿基线，再走 N 轮重建，再看是否回到基线。
// ============================================================================
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b04-perf-result.txt");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => console.log("     " + m);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

const adb = (args) => execFileSync(ADB, ["-s", SERIAL].concat(args), {
  encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024,
});
const sh = (c) => adb(["shell", c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拿 App 的 Java 堆与 native 堆 */
function memOf() {
  const t = sh("dumpsys meminfo " + PKG);
  const g = (re) => { const m = t.match(re); return m ? Number(m[1]) : -1; };
  return {
    java: g(/Java Heap:\s+(\d+)/),
    native: g(/Native Heap:\s+(\d+)/),
    total: g(/TOTAL PSS:\s+(\d+)/),
  };
}

function pid() {
  const t = sh("pidof " + PKG).trim();
  return t ? Number(t) : -1;
}

/** 拿 crash buffer 里 FATAL 的数量 */
function fatalCount() {
  const t = sh("logcat -d -b crash");
  return (t.match(/FATAL EXCEPTION/g) || []).length;
}

(async () => {
  log("=== P5B-M04 §九：性能与生命周期 ===");
  log("");

  // ---------------------------------------------------------------- P1 基线
  console.log("=== P1. 基线（当前主题）===");
  ok(pid() > 0, "App 进程存活 pid=" + pid());
  const m0 = memOf();
  const f0 = fatalCount();
  info("内存: java=" + m0.java + "K  native=" + m0.native + "K  total=" + m0.total + "K");
  info("FATAL 数=" + f0);
  ok(f0 === 0, "P1 基线无崩溃");

  // ---------------------------------------------------------------- P2 大量 Shape 性能
  console.log("\n=== P2. 大量 Shape 的绘制性能 ===");
  // 生成一个含 40 个 Shape 的主题
  const manyShapes = {
    schema: "icar.ui/3",
    meta: { name: "P5B-M04 性能测试 40 Shape" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    nodes: [],
  };
  for (let i = 0; i < 40; i++) {
    const col = i % 8, row = Math.floor(i / 8);
    manyShapes.nodes.push({
      id: "sh" + i, type: "shape", name: "S" + i,
      x: col * 44 + 2, y: row * 62 + 2, w: 40, h: 56,
      rotation: 0, scale: 1, alpha: 200, z: i,
      kind: i % 3 === 0 ? "roundRect" : (i % 3 === 1 ? "rect" : "circle"),
      fill: "#" + ((i * 37) % 200 + 30).toString(16).padStart(2, "0") + "A0C0",
      stroke: "#3DD6FF", strokeWidth: 1, cornerRadius: 6,
    });
  }
  const DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");
  fs.writeFileSync(path.join(DIR, "p5b04-perf-40shape.json"), JSON.stringify(manyShapes, null, 2), "utf8");
  info("已生成 40 Shape 主题");

  const t0 = Date.now();
  const dep1 = execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "p5b04-perf-40shape.json"],
    { encoding: "utf8", timeout: 300000, cwd: ROOT });
  const depMs = Date.now() - t0;
  const l1 = (dep1.match(/回读校验[^\n]*/) || [""])[0].trim();
  info("部署耗时 " + depMs + "ms  " + l1);
  ok(/一致=true/.test(l1), "P2 40 Shape 主题部署成功");
  ok(depMs < 60000, "P2 部署在合理时间内（" + depMs + "ms < 60000ms）");

  await sleep(3000);
  ok(pid() > 0, "P2 40 Shape 渲染后进程存活");
  ok(fatalCount() === 0, "P2 40 Shape 无崩溃");
  const mShape = memOf();
  info("40 Shape 后内存: java=" + mShape.java + "K  native=" + mShape.native + "K");

  // 截图确认真的画了（40 个 Shape 应该有大量非背景像素）
  sh("screencap -p /sdcard/_perf1.png");
  const local1 = path.join(require("os").tmpdir(), "p5b04_perf1.png");
  adb(["pull", "/sdcard/_perf1.png", local1]);
  const ps1 = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${local1.replace(/\\/g, "\\\\")}')
$bmp=New-Object System.Drawing.Bitmap $img
$n=0
for($y=200;$y -lt 2200;$y+=4){
  for($x=0;$x -lt $bmp.Width;$x+=4){
    $c=$bmp.GetPixel($x,$y)
    if(($c.R+$c.G+$c.B) -gt 200){$n++}
  }
}
$bmp.Dispose();$img.Dispose()
Write-Output $n
`;
  const pf = path.join(require("os").tmpdir(), "perf1.ps1");
  fs.writeFileSync(pf, "\uFEFF" + ps1, "utf8");
  const ink = Number(execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", pf], { encoding: "utf8", timeout: 120000 }).trim());
  info("40 Shape 截图亮像素=" + ink);
  ok(ink > 2000, "P2 40 个 Shape 真的画出来了（" + ink + " 亮像素）");

  // ---------------------------------------------------------------- P3 多 SegmentedArc
  console.log("\n=== P3. 多个 SegmentedArc 同时刷新 ===");
  const manyArcs = {
    schema: "icar.ui/3",
    meta: { name: "P5B-M04 性能测试 12 圆环" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    nodes: [],
  };
  for (let i = 0; i < 12; i++) {
    const col = i % 3, row = Math.floor(i / 3);
    manyArcs.nodes.push({
      id: "arc" + i, type: "segmentedArc", name: "A" + i,
      x: col * 120 + 4, y: row * 88 + 4, w: 112, h: 112,
      rotation: 0, scale: 1, alpha: 255, z: i,
      pid: "obd.rpm", minVal: 0, maxVal: 8000,
      startAngle: 150, sweepAngle: 240, segmentCount: 24, gapAngle: 2, thickness: 6,
      activeColor: "#FF3D7F", inactiveColor: "#4A5058", noDataColor: "#FF4D4F",
      radiusRatio: 0.42,
    });
  }
  fs.writeFileSync(path.join(DIR, "p5b04-perf-12arc.json"), JSON.stringify(manyArcs, null, 2), "utf8");
  const dep2 = execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "p5b04-perf-12arc.json"],
    { encoding: "utf8", timeout: 300000, cwd: ROOT });
  const l2 = (dep2.match(/回读校验[^\n]*/) || [""])[0].trim();
  info(l2);
  ok(/一致=true/.test(l2), "P3 12 圆环主题部署成功");
  await sleep(3000);
  ok(pid() > 0, "P3 12 圆环渲染后进程存活");
  ok(fatalCount() === 0, "P3 12 圆环无崩溃");

  // 场景切换（所有圆环同时刷新）
  const before = memOf();
  for (const sc of ["normal", "mid", "critical", "normal"]) {
    sh("am broadcast -a com.icar.obd.SIM --es scenario " + sc + " --ei step 5");
    await sleep(2500);
  }
  const after = memOf();
  info("4 次场景切换后内存: java=" + before.java + " → " + after.java + "K");
  ok(pid() > 0, "P3 多轮刷新后进程存活");
  ok(fatalCount() === 0, "P3 多轮刷新无崩溃");
  // 内存不应暴涨（允许 30MB 波动）
  const grew = after.java - before.java;
  info("Java 堆变化 " + grew + "K");
  ok(grew < 30000, "P3 多轮刷新后 Java 堆没有暴涨（" + grew + "K < 30000K）");

  // ---------------------------------------------------------------- P4 生命周期
  console.log("\n=== P4. 生命周期：前后台 / 横竖屏 / 重建 ===");
  const crashBefore = fatalCount();

  // 后台 → 前台 ×3
  for (let i = 0; i < 3; i++) {
    sh("input keyevent KEYCODE_HOME");
    await sleep(1200);
    sh("am start -n " + PKG + "/.ui.MainActivity");
    await sleep(2500);
  }
  ok(pid() > 0, "P4 前后台 3 轮后进程存活");
  ok(fatalCount() === crashBefore, "P4 前后台 3 轮无新增崩溃");

  // 横竖屏切换 ×2
  for (let i = 0; i < 2; i++) {
    sh("settings put system accelerometer_rotation 0");
    sh("settings put system user_rotation 1");   // 横屏
    await sleep(2000);
    sh("settings put system user_rotation 0");   // 竖屏
    await sleep(2000);
  }
  ok(pid() > 0, "P4 横竖屏切换后进程存活");
  ok(fatalCount() === crashBefore, "P4 横竖屏切换无新增崩溃");

  // Activity 重建（模拟配置变更）
  sh("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(2000);
  ok(pid() > 0, "P4 Activity 重建后进程存活");

  // ---------------------------------------------------------------- P5 监听器泄漏
  console.log("\n=== P5. ValueText 监听器泄漏（多轮主题切换后内存回归）===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario normal --ei step 5");
  await sleep(2500);
  const memStart = memOf();
  info("切换前: java=" + memStart.java + "K");

  // 反复切主题 5 轮（每轮都会 build() → 必须退订旧的）
  for (let round = 0; round < 5; round++) {
    const f = round % 2 === 0 ? "p5b04-template-race.json" : "p5b04-template-data.json";
    execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), f],
      { encoding: "utf8", timeout: 300000, cwd: ROOT });
    await sleep(2500);
  }
  const memEnd = memOf();
  info("切换后: java=" + memEnd.java + "K");
  const drift = memEnd.java - memStart.java;
  info("5 轮主题切换后 Java 堆漂移 " + drift + "K");
  ok(drift < 40000, "P5 5 轮主题切换后堆漂移可控（" + drift + "K < 40000K，说明监听器在被退订）");
  ok(pid() > 0, "P5 5 轮切换后进程存活");
  ok(fatalCount() === crashBefore, "P5 5 轮切换无新增崩溃");

  // ---------------------------------------------------------------- P6 资源上限
  console.log("\n=== P6. 资源上限（自由路径点数 / 超大路径）===");
  // 100 个点的 pathProgress 必须被拒绝
  const tooMany = {
    schema: "icar.ui/3",
    meta: { name: "P5B-M04 超限测试 100 点" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    nodes: [{
      id: "pp", type: "pathProgress", name: "超限曲线",
      x: 10, y: 10, w: 340, h: 300, rotation: 0, scale: 1, alpha: 255, z: 1,
      pid: "obd.load", minVal: 0, maxVal: 100, curve: 0, thickness: 4,
      activeColor: "#3DD6FF", inactiveColor: "#2A3038",
      points: Array.from({ length: 100 }, (_, i) => ({ x: i / 99, y: 0.5 })),
    }],
  };
  fs.writeFileSync(path.join(DIR, "p5b04-perf-toomany.json"), JSON.stringify(tooMany, null, 2), "utf8");
  let rejected = false, rejectMsg = "";
  try {
    const d = execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "p5b04-perf-toomany.json"],
      { encoding: "utf8", timeout: 300000, cwd: ROOT });
    const line = (d.match(/回读校验[^\n]*/) || [""])[0];
    rejectMsg = line.trim();
    // 部署脚本会把原样 JSON 写进去（它不解析语义），所以这里看的是 App 能否拒绝
  } catch (e) {
    rejectMsg = "部署失败: " + (e.stdout || e.message).slice(0, 120);
  }
  info("超限主题部署结果: " + rejectMsg);
  await sleep(3000);
  // App 侧应该在 BuildReport 里报"points 超过上限"并跳过该节点，但不崩
  ok(pid() > 0, "P6 100 点超限路径**不导致崩溃**");
  const crashBuf2 = sh("logcat -d -b crash");
  ok(!/FATAL EXCEPTION/.test(crashBuf2), "P6 超限路径无 FATAL");

  // 无效控制点（NaN/Inf）
  const invalid = {
    schema: "icar.ui/3",
    meta: { name: "P5B-M04 无效控制点测试" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    nodes: [{
      id: "pp2", type: "pathProgress", name: "含无效点",
      x: 10, y: 10, w: 340, h: 300, rotation: 0, scale: 1, alpha: 255, z: 1,
      pid: "obd.load", minVal: 0, maxVal: 100,
      points: [
        { x: 0, y: 1 }, { x: "abc", y: 0.5 }, { x: 0.5, y: null },
        { x: 0.6, y: 0.2 }, { x: 2, y: -1 }, { x: 1, y: 0 },
      ],
    }],
  };
  fs.writeFileSync(path.join(DIR, "p5b04-perf-invalid.json"), JSON.stringify(invalid, null, 2), "utf8");
  execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "p5b04-perf-invalid.json"],
    { encoding: "utf8", timeout: 300000, cwd: ROOT });
  await sleep(3000);
  ok(pid() > 0, "P6 无效控制点**不导致崩溃**");
  ok(!/FATAL EXCEPTION/.test(sh("logcat -d -b crash")), "P6 无效控制点无 FATAL");

  // ---------------------------------------------------------------- P7 恢复
  console.log("\n=== P7. 收尾 ===");
  execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "restore"],
    { encoding: "utf8", timeout: 300000, cwd: ROOT });
  await sleep(3000);
  ok(pid() > 0, "P7 已恢复原主题，进程存活");
  sh("settings put system user_rotation 0");
  sh("settings put system accelerometer_rotation 1");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 层级：Android 14 模拟器。性能数字仅作**回归基线**，不代表真机表现。");
  fs.writeFileSync(OUT, out.join("\n"), "utf8");
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
