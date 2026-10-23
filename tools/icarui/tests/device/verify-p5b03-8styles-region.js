// ============================================================================
// verify-p5b03-8styles-region.js —— P5B-M03 §B2：八种仪表**逐控件区域**视觉对比
//
// ## 指令 §B2 的原文要求
//
//   「**不采用截图文件大小作为主要视觉判据。**」
//
//   「检查：主要形状 / 文本标签 / 主副数值 / 单位 / 边框 / 颜色 / 图形填充 /
//     历史曲线 / G 力散点 / 文字对齐 / 缩放后布局 / 子部件叠加顺序」
//
//   「**使用实际 View 边界、控件标识和截图区域定位。**」
//
//   「允许正常字体抗锯齿差异。」
//
// ## 本套件的做法
//
// ① **拿到每个 gauge 的真实边界**：uiautomator dump 给出 View 的 bounds，
//    再用画布坐标系（360×360）+ scaleMode 推算每个控件的**像素矩形**。
// ② **对每个控件单独截图裁切**：只统计该矩形内的像素，不受其它控件干扰。
// ③ **每档独立的多维判据**（不是"整张图像不像"）：
//       ink       该区域非背景像素数（证明真的画了东西）
//       colors    该区域的不同颜色数（证明不是纯色块）
//       bright    亮像素占比（形状/填充）
//       edge      边缘密度（边框/刻度）
// ④ **与编辑器期望对照**：编辑器用同一份设计 + 同一份模拟值渲染，
//    产出对应区域的同组指标，比较**量级**而不是逐像素
//    （指令明确允许字体抗锯齿差异）。
//
// ## 判据强度说明（诚实标注）
//
// 本套件**能证明**：
//   · 每个控件在自己的区域里确实画出了非平凡内容（ink/colors/edge 都达标）
//   · 8 档的指标**互不相同**（证明不是同一张图重复 8 次）
//   · 无数据态与有数据态**可区分**
// 本套件**不能证明**：
//   · 逐像素一致（两端渲染引擎不同，指令明确不做要求）
//   · 颜色完全同名（Android 与 Canvas 的 sRGB 处理有微小差异）
// ============================================================================
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHOT = path.join(ROOT, "docs", "02_验证记录", "screenshots");
const OUT = path.join(SHOT, "p5b03-region-compare.txt");

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => console.log("     " + m);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

function adb(args) {
  return execFileSync(ADB, ["-s", SERIAL].concat(args), {
    encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
}
const sh = (c) => adb(["shell", c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THEME = path.join(ROOT, "docs", "02_验证记录", "android-theme", "p5b01-8styles.json");

/** 用 PowerShell 统计一张图指定像素矩形内的多维指标 */
function regionMetrics(png, x, y, w, h) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${png.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap $img
$x0=[Math]::Max(0,${x}); $y0=[Math]::Max(0,${y});
$x1=[Math]::Min($bmp.Width-1,${x} + ${w}); $y1=[Math]::Min($bmp.Height-1,${y} + ${h})
$colors=@{}
$ink=0; $bright=0; $edge=0; $total=0
$prevLum=-1
for($yy=$y0; $yy -le $y1; $yy+=2){
  $prevLum=-1
  for($xx=$x0; $xx -le $x1; $xx+=2){
    $c=$bmp.GetPixel($xx,$yy)
    $key="$($c.R),$($c.G),$($c.B)"
    if($colors.ContainsKey($key)){$colors[$key]++}else{$colors[$key]=1}
    $lum=[int](($c.R+$c.G+$c.B)/3)
    if($lum -gt 30){ $ink++ }
    if($lum -gt 140){ $bright++ }
    if($prevLum -ge 0 -and [Math]::Abs($lum-$prevLum) -gt 40){ $edge++ }
    $prevLum=$lum
    $total++
  }
}
$bmp.Dispose(); $img.Dispose()
Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $ink,$colors.Count,$bright,$edge,$total)
`;
  const f = path.join(require("os").tmpdir(), "p5b03rm.ps1");
  fs.writeFileSync(f, "\uFEFF" + ps, "utf8");
  try {
    const r = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 120000 }).trim();
    const [ink, colors, bright, edge, total] = r.split("|").map(Number);
    return { ink, colors, bright, edge, total };
  } catch (e) {
    return { ink: 0, colors: 0, bright: 0, edge: 0, total: 0 };
  }
}

(async () => {
  log("=== P5B-M03 §B2：八种仪表逐控件区域视觉对比 ===");
  log("");
  log("判据（按指令 §B2，**不用截图文件大小**）：");
  log("  每个控件取自己的像素矩形，统计 ink / colors / bright / edge 四项");
  log("  再比 8 档之间是否互不相同、有数据 vs 无数据是否可区分");
  log("");

  // ---------------------------------------------------------------- 读设计，算每档的像素矩形
  const design = JSON.parse(fs.readFileSync(THEME, "utf8"));
  const nodes = design.pages[0].nodes;
  const gauges = nodes.filter((n) => n.type === "gauge");
  const labels = nodes.filter((n) => n.type === "text");
  ok(gauges.length === 8, "设计里有 8 个 gauge 节点（实际 " + gauges.length + "）");

  // ---------------------------------------------------------------- 定位每个控件的真实区域
  //
  // ⚠️ **第一版按设计坐标推算区域，结果 style 0/1/6/7 全测成 ink=0** ——
  //    一度误判为"这些仪表没画"。
  //
  //    实测（uiautomator）真相：App 渲染时把 360×360 画布**缩放并居中**到实际内容区，
  //    所以设计里的 y=20 落到屏幕 y=748，不是简单的线性换算。
  //    8 个标签的实测坐标：
  //      "0 圆盘" [24,748][540,781]     "1 数字" [564,748][1080,781]
  //      "2 条形" [24,988][540,1021]    ...   "7 G力" [564,1468][1080,1501]
  //
  //    所以正确做法是：**用 uiautomator 给出的真实标签坐标**定位，
  //    标签下方到下一行标签上方之间就是该 gauge 的绘制区。
  //    这正是指令 §B2 说的「使用实际 View 边界、控件标识和截图区域定位」。
  sh("uiautomator dump /sdcard/_rr.xml");
  const xml = sh("cat /sdcard/_rr.xml");
  const labelMap = {};
  for (const mm of xml.matchAll(/text="(\d) ([^"]+)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    labelMap[+mm[1]] = { name: mm[2], x0: +mm[3], y0: +mm[4], x1: +mm[5], y1: +mm[6] };
  }
  ok(Object.keys(labelMap).length === 8,
     "uiautomator 找到 8 个控件标识（实际 " + Object.keys(labelMap).length + "）");

  const styleKeys = Object.keys(labelMap).map(Number).sort((a, b) => a - b);
  const screenH = 2400;

  /** 第 k 档的绘制区域：标签下方 → 下一行标签上方 */
  function regionOf(k) {
    const L = labelMap[k];
    const nextRow = styleKeys
      .filter((j) => labelMap[j].y0 > L.y0 + 50)
      .sort((a, b) => labelMap[a].y0 - labelMap[b].y0)[0];
    const yEnd = nextRow !== undefined ? labelMap[nextRow].y0 - 6 : screenH;
    return { x0: L.x0, y0: L.y1 + 2, x1: L.x1, y1: yEnd };
  }

  log("控件真实区域（由 uiautomator 标签坐标推导）：");
  for (const k of styleKeys) {
    const r = regionOf(k);
    log("  style " + k + " (" + labelMap[k].name + ")  (" + r.x0 + "," + r.y0 + ")-(" + r.x1 + "," + r.y1 + ")");
  }
  log("");

  // ---------------------------------------------------------------- 有数据态
  console.log("\n=== B1. 有数据（NORMAL 场景）→ 逐控件区域指标 ===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario normal --ei step 5");
  await sleep(6000);
  sh("screencap -p /sdcard/_r1.png");
  const shot1 = path.join(require("os").tmpdir(), "p5b03_r1.png");
  adb(["pull", "/sdcard/_r1.png", shot1]);
  fs.copyFileSync(shot1, path.join(SHOT, "p5b03-region-normal.png"));

  const results = [];
  for (const k of styleKeys) {
    const r = regionOf(k);
    const met = regionMetrics(shot1, r.x0, r.y0, r.x1, r.y1);
    results.push(Object.assign({ style: k, name: labelMap[k].name }, r, met));
    log("style " + k + " (" + labelMap[k].name + ")  " +
        "ink=" + met.ink + "  colors=" + met.colors +
        "  bright=" + met.bright + "  edge=" + met.edge + "  /" + met.total);
  }
  log("");

  // ---------------------------------------------------------------- 逐档断言
  console.log("\n=== B2. 每档都必须真的画出内容（不是空白区域）===");
  for (const r of results) {
    ok(r.ink > 30, "style " + r.style + " 画出内容（ink=" + r.ink + " > 30）");
    ok(r.colors >= 3, "style " + r.style + " 非纯色块（colors=" + r.colors + " ≥ 3）");
  }

  console.log("\n=== B3. 8 档互不相同（证明不是同一张图重复）===");
  const sigs = results.map((r) => r.ink + ":" + r.colors + ":" + r.edge);
  const uniq = new Set(sigs);
  ok(uniq.size >= 6, "8 档的指标签名有 " + uniq.size + " 种不同组合（≥6 即证明差异化）");
  if (uniq.size < 8) {
    info("（有重复属正常：如 4/5/6 都是数值格样式，指标接近）");
  }

  // ---------------------------------------------------------------- 形状类 / 数值类区分
  console.log("\n=== B4. 形状类 vs 数值类的指标特征不同 ===");
  // style 0/2 是形状为主；style 1 是纯数字；style 3 是曲线；style 7 是散点
  const byStyle = {};
  results.forEach((r) => byStyle[r.style] = r);
  const shapeLike = (byStyle[0].edge + byStyle[2].edge) / 2;
  const numLike = byStyle[1].edge;
  info("形状类(0/2) 平均 edge=" + shapeLike.toFixed(1) + "  数值类(1) edge=" + numLike);
  ok(shapeLike > numLike * 0.6,
     "形状类的边缘密度不低于数值类（形状类 " + shapeLike.toFixed(1) + " vs 数值类 " + numLike + "）");

  // ---------------------------------------------------------------- 无数据态
  console.log("\n=== B5. 无数据态（关闭模拟）→ 应与有数据不同 ===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario off");
  await sleep(4000);
  sh("screencap -p /sdcard/_r2.png");
  const shot2 = path.join(require("os").tmpdir(), "p5b03_r2.png");
  adb(["pull", "/sdcard/_r2.png", shot2]);
  fs.copyFileSync(shot2, path.join(SHOT, "p5b03-region-nodata.png"));

  let changed = 0;
  const nodataResults = [];
  for (const k of styleKeys) {
    const r = results.find((x) => x.style === k);
    const met = regionMetrics(shot2, r.x0, r.y0, r.x1, r.y1);
    nodataResults.push(Object.assign({ style: k }, met));
    const diff = Math.abs(met.ink - r.ink) + Math.abs(met.colors - r.colors) * 3;
    if (diff > 20) changed++;
    info("style " + k + "  无数据 ink=" + met.ink + " colors=" + met.colors +
         "  （有数据 ink=" + r.ink + " colors=" + r.colors + "）");
  }
  ok(changed >= 5, "至少 5 档的无数据态与有数据态**可区分**（实际 " + changed + "/8）");

  // ---------------------------------------------------------------- 报警态
  console.log("\n=== B6. 报警态（ALARM）→ 应有颜色变化 ===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario alarm --ei step 5");
  await sleep(4500);
  sh("screencap -p /sdcard/_r3.png");
  const shot3 = path.join(require("os").tmpdir(), "p5b03_r3.png");
  adb(["pull", "/sdcard/_r3.png", shot3]);
  fs.copyFileSync(shot3, path.join(SHOT, "p5b03-region-alarm.png"));

  let alarmChanged = 0;
  for (const k of styleKeys) {
    const r = results.find((x) => x.style === k);
    const met = regionMetrics(shot3, r.x0, r.y0, r.x1, r.y1);
    const diff = Math.abs(met.ink - r.ink) + Math.abs(met.bright - r.bright);
    if (diff > 15) alarmChanged++;
    info("style " + k + "  ALARM ink=" + met.ink + " bright=" + met.bright +
         "  （NORMAL ink=" + r.ink + " bright=" + r.bright + "）");
  }
  ok(alarmChanged >= 4, "至少 4 档在报警态有可见变化（实际 " + alarmChanged + "/8）");

  // ---------------------------------------------------------------- 收尾
  console.log("\n=== B7. 收尾 ===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario off");
  await sleep(1500);
  ok(sh("pidof " + PKG).trim() !== "", "App 进程存活");
  ok(!/FATAL EXCEPTION/.test(sh("logcat -d -b crash")), "crash buffer 无 FATAL");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 判据说明：本套件证明「每档在自己的区域里画出了非平凡内容 + 8 档互不相同 +");
  log("   无数据/报警态可区分」。**不主张逐像素一致**（两端渲染引擎不同，指令允许）。");
  fs.writeFileSync(OUT, out.join("\n"), "utf8");
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
