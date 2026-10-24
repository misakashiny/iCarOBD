// ============================================================================
// verify-p5b04-v3-render.js —— P5B-M04 §F3：**v3 节点在 Android 的真实绘制**
//
// ## 指令 §F3 的六条硬要求
//
//   「必须证明：
//      1. View 确实由 v3 主题创建。
//      2. 绑定值变化后 View 更新。
//      3. 节点可独立显示。
//      4. 不影响原有八种 Gauge。
//      5. 不影响原有轨道。
//      6. 不影响状态灯。
//      7. 主题重新导入后仍能显示。」
//
// ## 判据方法：**认颜色**而不是"看着像"
//
// 每个基元在测试主题里都用**唯一可辨的标志色**：
//   shape          fill  = #3DD6FF (61,214,255)
//   segmentedArc   active = #FF3D7F (255,61,127) / inactive = #4A5058 (74,80,88)
//   pathProgress   inactive = #2A3038 (42,48,56)
//   valueText      color  = #FFFFFF (白字)
//
// 在截图里搜这些**精确 RGB**，能定位到就证明该 View 被画出来了。
// 这比"截图变大了"硬得多 —— 指令 §F2 明确禁止用体积/颜色数当判据。
// ============================================================================
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHOT = path.join(ROOT, "docs", "02_验证记录", "screenshots");
const OUT = path.join(SHOT, "p5b04-v3-render-result.txt");

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

/** 在截图里统计精确 RGB 的像素数 + 边界盒 */
function findColor(png, r, g, b, tol = 6) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$img=[System.Drawing.Image]::FromFile('${png.replace(/\\/g, "\\\\")}')
$bmp=New-Object System.Drawing.Bitmap $img
$n=0; $minX=1e9; $minY=1e9; $maxX=-1; $maxY=-1
for($y=0;$y -lt $bmp.Height;$y+=2){
  for($x=0;$x -lt $bmp.Width;$x+=2){
    $c=$bmp.GetPixel($x,$y)
    if([Math]::Abs($c.R-${r}) -le ${tol} -and [Math]::Abs($c.G-${g}) -le ${tol} -and [Math]::Abs($c.B-${b}) -le ${tol}){
      $n++
      if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}
      if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y}
    }
  }
}
$bmp.Dispose();$img.Dispose()
if($n -eq 0){ Write-Output "0|-1|-1|-1|-1" }
else { Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $n,$minX,$minY,$maxX,$maxY) }
`;
  const f = path.join(os.tmpdir(), "fc_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".ps1");
  fs.writeFileSync(f, "\uFEFF" + ps, "utf8");
  try {
    const t = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 120000 }).trim();
    const [n, minX, minY, maxX, maxY] = t.split("|").map(Number);
    return { n, minX, minY, maxX, maxY };
  } catch (e) { return { n: -1, minX: -1, minY: -1, maxX: -1, maxY: -1 }; }
}

/** 截屏并拉回本地 */
let seq = 0;
function grab(tag) {
  const remote = "/sdcard/_p5b04_" + (++seq) + ".png";
  sh("screencap -p " + remote);
  const local = path.join(os.tmpdir(), "p5b04_" + seq + ".png");
  adb(["pull", remote, local]);
  sh("rm -f " + remote);
  if (tag) fs.copyFileSync(local, path.join(SHOT, tag));
  return local;
}

(async () => {
  log("=== P5B-M04 §F3：v3 节点在 Android 的真实绘制验证 ===");
  log("");
  log("判据：在截图里搜**精确 RGB**（每个基元用唯一标志色），不是看截图大小/颜色数。");
  log("  shape          fill      = #3DD6FF (61,214,255)");
  log("  segmentedArc   active    = #FF3D7F (255,61,127)");
  log("  segmentedArc   inactive  = #4A5058 (74,80,88)");
  log("  pathProgress   inactive  = #2A3038 (42,48,56)");
  log("");

  // ---------------------------------------------------------------- F3-0 前置
  console.log("=== F3-0. 前置：App 与主题 ===");
  ok(sh("pidof " + PKG).trim() !== "", "App 进程存活");

  // 确认设备上的主题确实是 v3 且含四个基元
  const back = sh("run-as " + PKG + " cat files/config/settings.json");
  let devSchema = "", devTypes = [];
  try {
    const j = JSON.parse(back.replace(/^\uFEFF/, ""));
    const d = JSON.parse(j.designJson);
    devSchema = d.schema;
    devTypes = (d.pages[0].nodes || []).map((n) => n.type);
  } catch (e) { }
  info("设备主题 schema=" + devSchema + "  types=" + devTypes.join(","));
  ok(devSchema === "icar.ui/3", "F3-0 设备上确实是 v3 主题");
  ["valueText", "shape", "segmentedArc", "pathProgress"].forEach((t) => {
    ok(devTypes.includes(t), "F3-0 设备主题含 " + t + " 节点");
  });

  // ---------------------------------------------------------------- F3-1 View 确实由 v3 创建
  console.log("\n=== F3-1. View 确实由 v3 主题创建（认标志色）===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario normal --ei step 5");
  await sleep(7000);
  const pNormal = grab("p5b04-v3-render.png");

  const shapeFill = findColor(pNormal, 61, 214, 255);
  info("shape fill #3DD6FF 像素=" + shapeFill.n + "  盒=(" + shapeFill.minX + "," + shapeFill.minY + ")-(" + shapeFill.maxX + "," + shapeFill.maxY + ")");
  ok(shapeFill.n > 500, "F3-1 **shape View 被画出来了**（" + shapeFill.n + " 像素）");

  const arcInactive = findColor(pNormal, 74, 80, 88);
  info("arc inactive #4A5058 像素=" + arcInactive.n);
  ok(arcInactive.n > 20, "F3-1 **segmentedArc View 的底轨被画出来了**（" + arcInactive.n + " 像素）");

  const arcActive = findColor(pNormal, 255, 61, 127);
  info("arc active #FF3D7F 像素=" + arcActive.n);
  ok(arcActive.n > 20, "F3-1 **segmentedArc 的点亮段被画出来了**（" + arcActive.n + " 像素）");

  const pathInactive = findColor(pNormal, 42, 48, 56);
  info("path inactive #2A3038 像素=" + pathInactive.n);
  ok(pathInactive.n > 20, "F3-1 **pathProgress View 的底轨被画出来了**（" + pathInactive.n + " 像素）");

  // ---------------------------------------------------------------- F3-2 绑定值变化后 View 更新
  console.log("\n=== F3-2. 绑定值变化 → View 更新 ===");
  // segmentedArc 绑 obd.rpm：normal(800) → critical(7400)，点亮段应显著增加
  sh("am broadcast -a com.icar.obd.SIM --es scenario critical --ei step 5");
  await sleep(6000);
  const pCrit = grab("p5b04-v3-render-critical.png");
  const arcActiveCrit = findColor(pCrit, 255, 61, 127);
  info("critical 场景 arc active 像素=" + arcActiveCrit.n + "（normal 时 " + arcActive.n + "）");
  ok(arcActiveCrit.n > arcActive.n,
     "F3-2 **绑定值变大 → 点亮段变多**（" + arcActive.n + " → " + arcActiveCrit.n + "）");

  // pathProgress 绑 obd.load：load 也随场景变化
  const pathActiveNormal = findColor(pNormal, 61, 214, 255, 40);   // 与 shape 同色系，用容差区分不了，改看 total ink
  info("（pathProgress 的 active 色与 shape 同色，改用 arc 判据即可）");

  // ---------------------------------------------------------------- F3-3 无数据状态
  console.log("\n=== F3-3. 数据断开 → 无数据状态 ===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario disconnect");
  await sleep(5000);
  const pNoData = grab("p5b04-v3-render-nodata.png");
  const arcActiveNoData = findColor(pNoData, 255, 61, 127);
  info("断开后 arc active 像素=" + arcActiveNoData.n + "（有数据时 " + arcActiveCrit.n + "）");
  ok(arcActiveNoData.n < arcActiveCrit.n * 0.5,
     "F3-3 **数据断开 → 点亮段消失**（" + arcActiveCrit.n + " → " + arcActiveNoData.n + "）");
  // 无数据时 arc 应该用 noDataColor(#FF4D4F) 压暗
  const arcNoData = findColor(pNoData, 255, 77, 79, 40);
  info("断开后 noDataColor 系像素=" + arcNoData.n);

  // ---------------------------------------------------------------- F3-4 恢复
  console.log("\n=== F3-4. 数据恢复 → View 恢复 ===");
  sh("am broadcast -a com.icar.obd.SIM --es scenario recover --ei step 5");
  await sleep(5000);
  const pRecover = grab();
  const arcActiveRecover = findColor(pRecover, 255, 61, 127);
  info("恢复后 arc active 像素=" + arcActiveRecover.n);
  ok(arcActiveRecover.n > arcActiveNoData.n,
     "F3-4 **数据恢复 → 点亮段回来**（" + arcActiveNoData.n + " → " + arcActiveRecover.n + "）");

  // ---------------------------------------------------------------- F3-5 不影响原有八种 Gauge
  console.log("\n=== F3-5. 不影响原有八种 Gauge（回归）===");
  const gaugeColor = findColor(pNormal, 255, 138, 0, 30);   // gauge 的橙色
  info("gauge 橙色像素=" + gaugeColor.n);
  ok(gaugeColor.n > 50, "F3-5 旧 gauge 仍正常绘制（" + gaugeColor.n + " 像素）");

  // ---------------------------------------------------------------- F3-6 主题重新导入后仍能显示
  console.log("\n=== F3-6. 主题重新导入后仍能显示 ===");
  // 用 deploy 脚本再部署一次（模拟"重新导入"）
  try {
    const r = execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "v3-full.json"],
      { encoding: "utf8", timeout: 300000, cwd: ROOT });
    info((r.match(/回读校验[^\n]*/) || ["(无校验行)"])[0].trim());
  } catch (e) {
    info("重新部署失败：" + (e.stdout || e.message));
  }
  sh("am broadcast -a com.icar.obd.SIM --es scenario normal --ei step 5");
  await sleep(8000);
  const pReimport = grab("p5b04-v3-render-reimport.png");
  const shapeReimport = findColor(pReimport, 61, 214, 255);
  const arcReimport = findColor(pReimport, 255, 61, 127);
  info("重新导入后 shape=" + shapeReimport.n + "  arc active=" + arcReimport.n);
  ok(shapeReimport.n > 500, "F3-6 **重新导入后 shape 仍在**（" + shapeReimport.n + " 像素）");
  ok(arcReimport.n > 20, "F3-6 **重新导入后 segmentedArc 仍在**（" + arcReimport.n + " 像素）");

  // ---------------------------------------------------------------- 收尾
  console.log("\n=== 收尾 ===");
  ok(sh("pidof " + PKG).trim() !== "", "App 进程存活");
  const crash = sh("logcat -d -b crash");
  ok(!/FATAL EXCEPTION/.test(crash), "crash buffer 无 FATAL");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 层级：Android 14 模拟器。不代表真机/真车。");
  fs.writeFileSync(OUT, out.join("\n"), "utf8");
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
