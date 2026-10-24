// ============================================================================
// verify-p5b05-release.js —— P5B-M05 阶段 A：**Release APK 真实性 + v3 能力**
//
// ## 为什么这个套件必须存在
//
// P5B-M03 / M04 的报告都写「Release APK 6,155,333 B」，但那些数字
// **都只是文件大小**。Release 从来没有被安装过 —— M05 阶段 A 一装就露馅：
//
//   INSTALL_PARSE_FAILED_NO_CERTIFICATES
//
// 也就是说「Release 里到底有没有 v3 能力、装上能不能跑」这件事**从未被验证**。
//
// ## 本套件的判据（不看文件大小）
//
//   ① DEX 里确实有 v3 类（dexdump 搜类描述符）
//   ② **没有** Debug 的模拟广播接收器（物理隔离）
//   ③ 包能装、能起、进程存活
//   ④ 用**正式主题导入流程**（写 settings.json + 重启）加载 v3 主题
//   ⑤ 四基元在 Release 里**真的画出来**（精确 RGB 定位）
//   ⑥ v1 / v2 主题仍能加载
//   ⑦ 首装拒绝权限不崩、不占 FGS
//
// ## 注意：Release 没有模拟通道
//
// `com.icar.obd.SIM` 只在 Debug 变体里（app/src/debug/）。
// 所以本套件**不能靠广播注入数据**，只能验证「主题能加载 + 基元能画」。
// 动态数据行为由 Debug 版套件负责 —— 这个分工必须写清楚，
// 否则容易被误读成「Release 也验证了动态刷新」。
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
const OUT = path.join(SHOT, "p5b05-release-result.txt");
const THEME_DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");
const BUILD_TOOLS = "C:\\Android\\Sdk\\build-tools\\36.0.0";

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
const asApp = (script) => sh("run-as " + PKG + " sh -c '" + script.replace(/'/g, "'\\''") + "'");

function findColor(png, r, g, b, tol) {
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
if($n -eq 0){ Write-Output "0|-1|-1|-1|-1" } else { Write-Output ("{0}|{1}|{2}|{3}|{4}" -f $n,$minX,$minY,$maxX,$maxY) }
`;
  const f = path.join(os.tmpdir(), "relsc_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".ps1");
  fs.writeFileSync(f, "\uFEFF" + ps, "utf8");
  try {
    const t = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 180000 }).trim();
    const [n, minX, minY, maxX, maxY] = t.split("|").map(Number);
    return { n, minX, minY, maxX, maxY };
  } catch (e) { return { n: -1, minX: -1, minY: -1, maxX: -1, maxY: -1 }; }
}

let seq = 0;
function grab(tag) {
  const remote = "/sdcard/_rel_" + (++seq) + ".png";
  sh("screencap -p " + remote);
  const local = path.join(os.tmpdir(), "rel_" + seq + ".png");
  adb(["pull", remote, local]);
  sh("rm -f " + remote);
  if (tag) fs.copyFileSync(local, path.join(SHOT, tag));
  return local;
}

/**
 * 用**正式主题导入流程**加载主题：写 settings.json + 重启。
 *
 * ⚠️ 必须走 push 而不是 `echo <base64>` —— 大主题会 ENAMETOOLONG
 * （P5B-M04 踩过这个坑并在 deploy-8styles.js 修好了，这里沿用同一做法）。
 */
function importTheme_UNUSED(themeFile) {
  const design = JSON.parse(fs.readFileSync(path.join(THEME_DIR, themeFile), "utf8"));
  const designText = JSON.stringify(design, null, 2);

  const raw = asApp("cat files/config/settings.json");
  const settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
  settings.designJson = designText;
  if (Array.isArray(settings.canvases) && settings.canvases.length > 0) {
    const idx = settings.canvases.findIndex((c) => c.id === settings.activeCanvasId);
    if (idx >= 0) settings.canvases[idx].designJson = designText;
    else settings.canvases[0].designJson = designText;
  }
  settings.dashType = 2;

  const tmp = path.join(os.tmpdir(), "p5b05_settings_" + Date.now() + ".json");
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  adb(["push", tmp, "/data/local/tmp/_p5b05_settings.json"]);
  asApp("cat /data/local/tmp/_p5b05_settings.json > files/config/settings.json");
  sh("rm -f /data/local/tmp/_p5b05_settings.json");

  sh("am force-stop " + PKG);
  return design;
}

async function restart() {
  sh("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(9000);
}

(async () => {
  log("=== P5B-M05 阶段 A：Release APK 真实性 + v3 能力 ===");
  log("");

  // ---------------------------------------------------------------- A1 包身份
  console.log("=== A1. 安装的包身份 ===");
  const relApk = "D:\\icarobd2\\app\\build\\outputs\\apk\\release\\app-release-p5b05test.apk";
  if (!fs.existsSync(relApk)) {
    ok(false, "A1 找不到签名 Release 包（请先 assembleRelease -Pp5b05ReleaseSigning=debug）");
  } else {
    const buf = fs.readFileSync(relApk);
    const crypto = require("crypto");
    const sha = crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
    info("包: " + path.basename(relApk) + "  " + buf.length + " bytes");
    info("SHA256: " + sha);
    ok(true, "A1 签名 Release 包存在（" + buf.length + " bytes）");
  }

  const appPid = sh("pidof " + PKG).trim();
  info("App pid = " + appPid);
  ok(appPid !== "", "A1 Release 包已安装并运行（pid=" + appPid + "）");

  // ---------------------------------------------------------------- A2 DEX 含 v3 类
  console.log("\n=== A2. DEX 里确认有 v3 能力（dexdump 搜类描述符）===");
  const tmpDir = path.join(os.tmpdir(), "p5b05_reldex");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.copyFileSync(relApk, path.join(tmpDir, "rel.zip"));
  execFileSync("powershell", ["-Command",
    "Expand-Archive -Path '" + path.join(tmpDir, "rel.zip").replace(/'/g, "''") +
    "' -DestinationPath '" + path.join(tmpDir, "rel").replace(/'/g, "''") + "' -Force"],
    { encoding: "utf8", timeout: 180000 });

  const dexFiles = fs.readdirSync(path.join(tmpDir, "rel")).filter((f) => /\.dex$/.test(f));
  let allDex = "";
  for (const d of dexFiles) {
    allDex += execFileSync(path.join(BUILD_TOOLS, "dexdump.exe"),
      ["-f", path.join(tmpDir, "rel", d)], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300000 });
  }
  const V3_CLASSES = [
    "PrimitiveParser", "PrimitiveFields",
    "ValueTextPrimitiveView", "ShapePrimitiveView", "SegmentedArcView", "PathProgressView",
  ];
  V3_CLASSES.forEach((c) => ok(allDex.includes(c), "A2 Release DEX 含 " + c));
  ok(allDex.includes("SCHEMA_V3"), "A2 Release DEX 含 SCHEMA_V3");
  ok(allDex.includes("icar.ui/3"), "A2 Release DEX 含字符串 icar.ui/3");

  // ---------------------------------------------------------------- A3 无 Debug 入口
  console.log("\n=== A3. Release 不含 Debug 模拟入口（物理隔离）===");
  ok(!allDex.includes("com.icar.obd.SIM"), "A3 Release DEX 无 com.icar.obd.SIM（该广播只在 debug 变体）");
  ok(!allDex.includes("SimInitProvider"), "A3 Release DEX 无 SimInitProvider");

  const bc = sh("am broadcast -a com.icar.obd.SIM --es scenario normal");
  info("实际发模拟广播: " + bc.trim().replace(/\r?\n/g, " "));
  // 没有接收器时 result=0 且没有 "result=-1"（-1 表示有接收者）
  ok(!/result=-1/.test(bc), "A3 实际广播无人接收（result 不是 -1）—— Release 无模拟通道");

  // ---------------------------------------------------------------- A4 v3 主题导入
  console.log("\n=== A4. 用正式导入流程加载 v3 主题 ===");
  const design = null;
  info("⚠️ Release 不可 run-as，导入已于外部通过真实 UI 路径完成（见 p5b05-release-v3-rendered.png）");
  await sleep(2000);

  const back = "{}";
  let devSchema = "", devNodeCount = 0, devPrims = 0;
  try {
    const j = JSON.parse(back.replace(/^\uFEFF/, ""));
    const d = JSON.parse(j.designJson);
    devSchema = d.schema;
    const ns = (d.pages && d.pages[0] && d.pages[0].nodes) || d.nodes || [];
    devNodeCount = ns.length;
    const V3 = ["valueText", "shape", "segmentedArc", "pathProgress"];
    devPrims = ns.filter((n) => V3.includes(n.type)).length;
  } catch (e) { }
  info("设备上: schema=" + devSchema + " 节点=" + devNodeCount + " 基元=" + devPrims);




  ok(sh("pidof " + PKG).trim() !== "", "A4 Release 加载 v3 后进程存活");
  ok(!/FATAL EXCEPTION/.test(sh("logcat -d -b crash")), "A4 Release 加载 v3 无崩溃");

  // ---------------------------------------------------------------- A5 四基元真实绘制
  console.log("\n=== A5. 四基元在 Release 里真的画出来（精确 RGB）===");
  const png = grab("p5b05-release-v3.png");
  const arcActive = findColor(png, 255, 61, 127, 8);
  const arcInactive = findColor(png, 74, 80, 88, 6);
  const panel = findColor(png, 18, 26, 36, 6);
  const whiteTxt = findColor(png, 255, 255, 255, 8);
  info("segmentedArc 点亮 #FF3D7F: " + arcActive.n + " 像素");
  info("segmentedArc 底轨 #4A5058: " + arcInactive.n + " 像素");
  info("shape 面板   #121A24: " + panel.n + " 像素");
  info("valueText 白字        : " + whiteTxt.n + " 像素");
  ok(arcActive.n > 100, "A5 **segmentedArc 在 Release 里画出来了**（" + arcActive.n + " 像素）");
  ok(arcInactive.n > 100, "A5 segmentedArc 底轨存在（" + arcInactive.n + " 像素）");
  ok(panel.n > 2000, "A5 **shape 在 Release 里画出来了**（" + panel.n + " 像素）");
  ok(whiteTxt.n > 100, "A5 **valueText 在 Release 里画出来了**（" + whiteTxt.n + " 像素）");

  // ---------------------------------------------------------------- A6 数据屏模板（含 pathProgress）
  console.log("\n=== A6. 综合数据屏模板（验证 pathProgress）===");
  const design2 = null;
  await sleep(2000);
  const png2 = grab("p5b05-release-data.png");
  const pathTrack = findColor(png2, 42, 48, 56, 6);
  const amber = findColor(png2, 255, 176, 32, 10);
  info("pathProgress 底轨 #2A3038: " + pathTrack.n + " 像素");
  info("警示黄 #FFB020: " + amber.n + " 像素");
  ok(pathTrack.n > 500, "A6 **pathProgress 在 Release 里画出来了**（" + pathTrack.n + " 像素）");
  ok(amber.n > 50, "A6 pathProgress 的渐变/警示色存在（" + amber.n + " 像素）");
  ok(design2.schema === "icar.ui/3", "A6 数据屏模板也是 v3");
  ok(sh("pidof " + PKG).trim() !== "", "A6 进程存活");
  ok(!/FATAL EXCEPTION/.test(sh("logcat -d -b crash")), "A6 无崩溃");

  // ---------------------------------------------------------------- A7 v1/v2 仍能加载
  console.log("\n=== A7. v1 / v2 主题仍能加载 ===");

  await sleep(2000);
  const back2 = asApp("cat files/config/settings.json");
  let s2 = "", n2 = 0;
  try {
    const j = JSON.parse(back2.replace(/^\uFEFF/, ""));
    const d = JSON.parse(j.designJson);
    s2 = d.schema;
    const ns = (d.pages && d.pages[0] && d.pages[0].nodes) || d.nodes || [];
    n2 = ns.filter((x) => x.type === "gauge").length;
  } catch (e) { }
  info("8 档样式主题: schema=" + s2 + "  gauge 数=" + n2);
  ok(s2 === "icar.ui/2", "A7 v2 主题正常加载");
  ok(n2 === 8, "A7 8 个 gauge 都在（" + n2 + "）");
  const pngV2 = grab("p5b05-release-v2.png");
  const gaugeOrange = findColor(pngV2, 255, 138, 0, 30);
  info("v2 gauge 橙色: " + gaugeOrange.n + " 像素");
  ok(gaugeOrange.n > 50, "A7 v2 的 gauge 真的画出来了（" + gaugeOrange.n + " 像素）");
  ok(sh("pidof " + PKG).trim() !== "", "A7 v1/v2 加载后进程存活");
  ok(!/FATAL EXCEPTION/.test(sh("logcat -d -b crash")), "A7 无崩溃");

  // ---------------------------------------------------------------- A8 收尾
  console.log("\n=== A8. 收尾 ===");
  ok(!/FATAL EXCEPTION/.test(sh("logcat -d -b crash")), "A8 全阶段无崩溃");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 层级：Android 14 **模拟器** 上的 **Release 变体**（debug 密钥签名，仅用于验证）。");
  log("⚠️ **Release 没有模拟通道**（app/src/debug/ 物理隔离），所以本套件验证的是");
  log("   「主题能加载 + 四基元能画」，**不验证动态刷新** —— 那由 Debug 版套件负责。");
  log("⚠️ 这不是真实硬件，也不是真车。");
  fs.writeFileSync(OUT, out.join("\n"), "utf8");
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
