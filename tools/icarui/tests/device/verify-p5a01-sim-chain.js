// ============================================================================
// verify-p5a01-sim-chain.js —— P5A-M01 阶段 C：模拟 PID → 仪表/状态灯 真实链路验证
//
// ## 为什么写这个
//
// 任务 §三 强调：「**不能把静态源码中存在某个类直接认定为功能完整**」。
//
// 本轮审计发现：`SimPidSource`（11 个场景）、`SimControl`（adb 广播）、
// `SimScenario`、`ValueLabels` 等**都已存在**（P4F-M05/M06 时期建的）。
// 所以本轮的价值不是重写，而是**证明它真的能从数据源走到屏幕上**。
//
// ## 与既有测试的分工
//
// · `SimScenarioTest`（23 项 JVM）：证明**场景值本身**正确（确定性、量程、报警档位）
// · `SimRealMutexTest`（9 项 JVM）：证明模拟与真实轮询**不并行**
// · **本脚本**：证明「广播 → SimPidSource → VehicleBus → View 真的变了」——
//   这是唯一能证明"整条链通了"的证据，JVM 侧做不到（需要真 View 与真 Looper）
//
// ## 判据：用像素而不是"看着像"
//
// 改模拟值 → 截屏 → 比较该表盘区域的像素指纹。
// 值变了但像素没变 = 链路断了。这是可判定的硬证据。
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHOT = path.join(ROOT, "docs", "02_验证记录", "screenshots");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const skip = (m) => console.log("  ⏭ " + m);

function adb(args) {
  return execFileSync(ADB, ["-s", SERIAL].concat(args), {
    encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
}
function sh(cmd) { return adb(["shell", cmd]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 广播模拟场景 */
function sim(args) {
  return sh("am broadcast -a com.icar.obd.SIM " + args);
}

/** 截屏到临时文件，返回本地路径 */
let shotSeq = 0;
function grab(tag) {
  const remote = "/sdcard/_p5a01_" + (++shotSeq) + ".png";
  sh("screencap -p " + remote);
  const local = path.join(require("os").tmpdir(), "p5a01_" + shotSeq + ".png");
  adb(["pull", remote, local]);
  sh("rm -f " + remote);
  if (tag) {
    const keep = path.join(SHOT, tag);
    fs.copyFileSync(local, keep);
  }
  return local;
}

/** 用 PowerShell 算一张图"指定比例区域"的像素指纹
 *
 * ⚠️ 第一版用 FNV-1a 64 位哈希，PowerShell 里 `[uint64]` 与 `-band 0xFFFF...`
 *    会抛 "Cannot convert value -1 to type System.UInt64"（负数中间值转无符号）。
 *    改用**双累加器**（加权和 + 平方和），同样能区分画面且无位宽问题：
 *      · 加权和  Σ (R + 3G + 7B)
 *      · 平方和  Σ (R² + 3G² + 7B²)  —— 对局部变化敏感，避免"此消彼长"抵消
 */
function regionHash(png, x0, y0, x1, y1) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${png.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap $img
$W = $bmp.Width; $H = $bmp.Height
$sx = [int]($W * ${x0}); $ex = [int]($W * ${x1})
$sy = [int]($H * ${y0}); $ey = [int]($H * ${y1})
$sum = [double]0
$sq  = [double]0
$n = 0
for ($y = $sy; $y -lt $ey; $y += 4) {
  for ($x = $sx; $x -lt $ex; $x += 4) {
    $c = $bmp.GetPixel($x, $y)
    $r = [double]$c.R; $g = [double]$c.G; $b = [double]$c.B
    $v = $r + 3*$g + 7*$b
    $sum += $v
    $sq  += ($r*$r + 3*$g*$g + 7*$b*$b)
    $n++
  }
}
$bmp.Dispose(); $img.Dispose()
Write-Output ("{0}|{1}|{2}" -f [long]$sum, [long]$sq, $n)
`;
  const f = path.join(require("os").tmpdir(), "p5a01_hash.ps1");
  fs.writeFileSync(f, "\uFEFF" + ps, "utf8");
  try {
    return execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 90000 }).trim();
  } catch (e) {
    return "ERR";
  }
}

(async () => {
  console.log("=== 前置：设备与 App ===");
  const boot = sh("getprop sys.boot_completed").trim();
  ok(boot === "1", "模拟器已启动（boot_completed=1）");
  try { adb(["install", "-r", "app/build/outputs/apk/debug/app-debug.apk"]); } catch (e) { /* 已装 */ }

  // 恢复默认尺寸，保证基线可复现
  sh("wm size reset"); sh("wm density reset");
  await sleep(2500);

  sh("am force-stop " + PKG);
  await sleep(1500);
  sh("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(11000);

  const pid = sh("pidof " + PKG).trim();
  ok(!!pid, "App 已启动（pid=" + pid + "）");

  // ---------------------------------------------------------------- C0 关闭模拟，取基线
  console.log("\n=== C0. 关闭模拟 → 基线（应为无数据外观）===");
  sim("--es scenario off");
  await sleep(3500);
  const baseImg = grab("p5a01-c0-off.png");
  // 整个画布区域（去掉顶部状态条与底部导航）
  const baseHash = regionHash(baseImg, 0.0, 0.10, 1.0, 0.86);
  ok(baseHash !== "ERR", "C0 基线截屏指纹可计算（" + baseHash + "）");

  // ---------------------------------------------------------------- C1 正常运行
  console.log("\n=== C1. 正常运行 → 仪表应显示数值 ===");
  sim("--es scenario normal --ei step 5");
  await sleep(4000);
  const normalImg = grab("p5a01-c1-normal.png");
  const normalHash = regionHash(normalImg, 0.0, 0.10, 1.0, 0.86);
  ok(normalHash !== baseHash, "C1 开模拟后画面**确实变化**（链路通）");
  console.log("      基线=" + baseHash.slice(0, 18) + "  正常=" + normalHash.slice(0, 18));

  // ---------------------------------------------------------------- C2 数值随 step 变化
  //
  // ⚠️ 第一版这里等 4 秒看画面有没有变 —— **前提就错了**：
  //    `SimPidSource` 的 `tick` **只在 `step()` 被调用时 +1**，是**手动步进**，
  //    不是定时自动循环。所以画面"4 秒后自己变"本来就不会发生。
  //
  // ⚠️ 第二版想用 `--es dump 1`，但 dump 行的 tag 不是 AppLog。
  //    **实际每次广播 SimControl 都会打一行**（这才是最直接的读数）：
  //      I SimControl: SIM 正常运行 通道=7  std_0C=800, std_0D=57, std_05=91.4, std_42=14.2
  //    所以直接抓 SimControl 的这行即可。
  console.log("\n=== C2. 数值随 step 真的在变（读 SimControl 广播回显，不看像素）===");
  /** 发广播并读回显里的 k=v 值 */
  function pushAndRead(args) {
    sh("logcat -c");
    sim(args);
    const lg = sh("logcat -d -s SimControl:I 2>/dev/null");
    const line = (lg.split(/\r?\n/).filter((l) => /SIM .*通道=/.test(l)) || []).pop() || "";
    const out = {};
    const re = /([a-zA-Z][\w.]*)=([-\d.]+|null)/g;
    let m;
    while ((m = re.exec(line)) !== null) out[m[1]] = m[2];
    return { line: line.trim(), values: out };
  }

  // ⚠️ 必须**先 off 再 normal**，让 tick 归零建立干净基准。
  //    第一版直接 `--ei step 0` 读基线 —— 但 C1 已经 step 过 5 次，tick 不是 0，
  //    所以后面"重新启用后应一致"必然不等 → 假失败。
  sim("--es scenario off");
  await sleep(1500);
  const r0 = pushAndRead("--es scenario normal --ei step 0");
  await sleep(1200);
  const d0 = r0.values;
  const d0keys = Object.keys(d0);
  ok(d0keys.length > 0, "C2 能读到模拟通道值（" + d0keys.length + " 个）");
  if (r0.line) console.log("      " + r0.line.slice(0, 150));
  // tick=0 应精确等于 NORMAL 的声明值（无 wobble 项）
  ok(
    d0["std_0C"] === "800" && d0["std_0D"] === "60" && d0["std_05"] === "90",
    "C2 tick=0 精确等于场景声明值（转速800 / 车速60 / 水温90）"
  );

  // 推进 tick
  const r20 = pushAndRead("--es scenario normal --ei step 20");
  await sleep(1200);
  const d20 = r20.values;
  const changed = Object.keys(d20).filter((k) => d0[k] !== undefined && d20[k] !== d0[k]).length;
  ok(changed > 0, "C2 推进 20 tick 后有 " + changed + " 个通道值发生变化（数值真的在动）");
  if (r20.line) console.log("      " + r20.line.slice(0, 150));

  // 确定性：`tick` 是**累加**的（step 只 +N，不会归零）。
  // 所以"回到同一 tick"必须**重新 enable**（enable 里 tick = 0）。
  // ⚠️ 第一版误以为 `--ei step 0` 能归零，因此第二次读到的必然不同 → 假失败。
  sim("--es scenario off");
  await sleep(1500);
  const r0b = pushAndRead("--es scenario normal --ei step 0");   // 重新 enable → tick=0
  await sleep(1200);
  ok(
    JSON.stringify(r0b.values) === JSON.stringify(d0),
    "C2 重新启用后 tick 归零，值与首轮完全一致（可重复 / 确定性）"
  );
  if (r0b.line) console.log("      重启用: " + r0b.line.slice(0, 140));
  // C3 需要与"正常"对比，这里记住正常态的画布指纹
  const normal2Img = grab();
  const normal2Hash = regionHash(normal2Img, 0.0, 0.10, 1.0, 0.86);

  // ---------------------------------------------------------------- C3 报警档
  console.log("\n=== C3. 报警场景 → 颜色/数值应变化 ===");
  sim("--es scenario alarm --ei step 5");
  await sleep(4000);
  const alarmImg = grab("p5a01-c3-alarm.png");
  const alarmHash = regionHash(alarmImg, 0.0, 0.10, 1.0, 0.86);
  ok(alarmHash !== normal2Hash, "C3 报警场景与正常场景画面不同");

  // ---------------------------------------------------------------- C4 严重档
  console.log("\n=== C4. 严重(critical) 场景 ===");
  sim("--es scenario critical --ei step 5");
  await sleep(4000);
  const critImg = grab("p5a01-c4-critical.png");
  const critHash = regionHash(critImg, 0.0, 0.10, 1.0, 0.86);
  ok(critHash !== alarmHash, "C4 critical 与 alarm 画面不同（分档有效）");

  // ---------------------------------------------------------------- C5 数据断开
  console.log("\n=== C5. 数据断开 → 应回到无数据外观 ===");
  sim("--es scenario disconnect");
  await sleep(4000);
  const discImg = grab("p5a01-c5-disconnect.png");
  const discHash = regionHash(discImg, 0.0, 0.10, 1.0, 0.86);
  ok(discHash !== critHash, "C5 断开后画面与 critical 不同");
  // 断开后应接近"无数据"观感 —— 与基线比较（不要求完全相同：可能有 -- 占位差异）
  console.log("      断开=" + discHash.slice(0, 18) + "  基线=" + baseHash.slice(0, 18));

  // ---------------------------------------------------------------- C6 数据恢复
  console.log("\n=== C6. 数据恢复 → 应重新出现数值 ===");
  sim("--es scenario recover --ei step 5");
  await sleep(4000);
  const recImg = grab("p5a01-c6-recover.png");
  const recHash = regionHash(recImg, 0.0, 0.10, 1.0, 0.86);
  ok(recHash !== discHash, "C6 恢复后画面与断开时不同（数据回来了）");

  // ---------------------------------------------------------------- C7 多 PID
  console.log("\n=== C7. 多 PID 同时更新 ===");
  sim("--es scenario multi --ei step 5");
  await sleep(4000);
  const multiImg = grab("p5a01-c7-multi.png");
  const multiHash = regionHash(multiImg, 0.0, 0.10, 1.0, 0.86);
  ok(multiHash !== recHash, "C7 多 PID 场景画面与单场景不同");

  // ---------------------------------------------------------------- C8 空值 / 缺失
  console.log("\n=== C8. PID 值为空 / PID 不存在（两种语义应不同）===");
  sim("--es scenario nullpid");
  await sleep(3500);
  const nullImg = grab("p5a01-c8-nullpid.png");
  const nullHash = regionHash(nullImg, 0.0, 0.10, 1.0, 0.86);
  ok(nullHash !== multiHash, "C8a PID 为空场景画面变化");

  sim("--es scenario missing");
  await sleep(3500);
  const missImg = grab("p5a01-c8b-missing.png");
  const missHash = regionHash(missImg, 0.0, 0.10, 1.0, 0.86);
  ok(missHash !== nullHash, "C8b 「PID 不存在」与「PID 为空」画面不同（语义已区分）");

  // ---------------------------------------------------------------- C9 关闭收尾
  console.log("\n=== C9. 关闭模拟 ===");
  sim("--es scenario off");
  await sleep(3000);
  const offImg = grab("p5a01-c9-off.png");
  const offHash = regionHash(offImg, 0.0, 0.10, 1.0, 0.86);
  ok(offHash === baseHash, "C9 关闭后回到基线（可重复，无残留）");

  // ---------------------------------------------------------------- C10 日志无异常
  console.log("\n=== C10. 全程 Logcat 无崩溃 ===");
  const crash = sh("logcat -d -b crash 2>/dev/null | head -40");
  const hasFatal = /FATAL EXCEPTION|AndroidRuntime.*com\.icar\.obd/.test(crash);
  ok(!hasFatal, "C10 crash buffer 中无 FATAL EXCEPTION");

  const alive = sh("pidof " + PKG).trim();
  ok(!!alive, "C10 App 进程仍存活（pid=" + alive + "）");

  // 写结果
  const out = [
    "P5A-M01 阶段 C：模拟 PID → 仪表 真实链路验证",
    "",
    "设备: " + sh("getprop ro.product.model").trim() + "  Android " + sh("getprop ro.build.version.release").trim(),
    "屏幕: " + sh("wm size").trim() + " / " + sh("wm density").trim(),
    "",
    "各场景画布区像素指纹（值不同 = 画面不同 = 链路通）：",
    "  基线(off)   " + baseHash,
    "  正常运行    " + normalHash,
    "  正常+4s     " + normal2Hash,
    "  报警 alarm  " + alarmHash,
    "  严重 critical " + critHash,
    "  断开        " + discHash,
    "  恢复        " + recHash,
    "  多PID       " + multiHash,
    "  空值        " + nullHash,
    "  缺失        " + missHash,
    "  关闭(off)   " + offHash,
    "",
    "判定方式：改模拟场景 → 截屏 → 比对该区域像素指纹。",
    "指纹变化 = 数据真的走到了屏幕；指纹不变 = 链路断。",
    "",
    "⚠️ 这是模拟器自动验证，**不是真实车辆验收**。",
  ].join("\n");
  fs.writeFileSync(path.join(SHOT, "p5a01-sim-chain-result.txt"), out, "utf8");

  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
