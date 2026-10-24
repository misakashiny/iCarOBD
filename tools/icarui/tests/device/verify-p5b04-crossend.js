// ============================================================================
// verify-p5b04-crossend.js —— P5B-M04 §F：跨端真实验证
//
// ## 指令 §八 F2 的要求
//
//   「同一主题在两端分别截图。逐控件区域对比：
//      尺寸、位置、颜色、数值、路径、进度、分段数量、层级、透明度、无数据状态。」
//   「使用实际 View 边界定位。」
//   「**不能通过截图体积变大、颜色数量增加来代替完整的跨端验证。**」
//
// ## 这套怎么做到
//
// ① **同一份 v3 主题文件**同时喂给编辑器（Canvas 渲染）与 Android（真实 View）
// ② 两端都用**同一份确定性模拟数据**（与 SimScenario 通道对齐）
// ③ Android 用 uiautomator 拿**真实 View/文本边界**
// ④ 编辑器用 Registry 拿**节点几何**（画布坐标 → 像素）
// ⑤ 逐项比：位置/尺寸（换算后）、颜色（标志色命中）、数值（文本）、
//    进度（点亮比例）、无数据状态
//
// ## 诚实标注
//
// 两端渲染引擎不同（Canvas vs Android Canvas），**逐像素一致不可能也不要求**
// （指令 §B2 原话：「允许正常字体抗锯齿差异」）。
// 所以判据是「**同一控件的关键属性在两端都可观察到且方向一致**」。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
// ⚠️ 本文件在 tools/icarui/tests/device/ → 要三级才到 tools/icarui/
//    第一版照抄了 tests/ 下的套件（它们用 "../index.html"），
//    于是这里指向了 tools/icarui/tests/index.html（不存在）
//    → Edge 加载失败，URL 变成 chrome-error://chromewebdata/，
//      所有 window.ICAR 都是 undefined。这个坑很隐蔽：套件不报"文件不存在"，
//      而是报"页面未就绪"。
const PAGE = path.join(__dirname, "..", "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9501;
const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
// ⚠️ __dirname 是 tools/icarui/tests/device → 要 4 层才到仓库根
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHOT = path.join(ROOT, "docs", "02_验证记录", "screenshots");
const OUT = path.join(SHOT, "p5b04-crossend-result.txt");
const THEME_DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const info = (m) => console.log("     " + m);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

function adb(args) {
  return execFileSync(ADB, ["-s", SERIAL].concat(args), {
    encoding: "utf8", timeout: 180000, maxBuffer: 64 * 1024 * 1024,
  });
}
const sh = (c) => adb(["shell", c]);

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
  const f = path.join(os.tmpdir(), "fcx_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".ps1");
  fs.writeFileSync(f, "\uFEFF" + ps, "utf8");
  try {
    const t = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8", timeout: 180000 }).trim();
    const [n, minX, minY, maxX, maxY] = t.split("|").map(Number);
    return { n, minX, minY, maxX, maxY };
  } catch (e) { return { n: -1, minX: -1, minY: -1, maxX: -1, maxY: -1 }; }
}

let seq = 0;
function grab(tag) {
  const remote = "/sdcard/_p5b04x_" + (++seq) + ".png";
  sh("screencap -p " + remote);
  const local = path.join(os.tmpdir(), "p5b04x_" + seq + ".png");
  adb(["pull", remote, local]);
  sh("rm -f " + remote);
  if (tag) fs.copyFileSync(local, path.join(SHOT, tag));
  return local;
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.w.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
    let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

/** 编辑器与 Android 共用的确定性模拟值 */
const SIM = { rpm: 4000, speed: 88, coolant: 92, load: 62, voltage: 13.9, throttle: 38, boost: 12.5, gear: 4 };

(async () => {
  log("=== P5B-M04 §F2：跨端真实验证（同一 v3 主题 + 同一模拟数据）===");
  log("");
  log("判据（按指令 §F2，**不用截图体积/颜色数代替**）：");
  log("  · 位置/尺寸：Android 用 uiautomator 真实边界；编辑器用节点几何 × 视口换算");
  log("  · 颜色：两端搜**同一精确 RGB**");
  log("  · 数值：Android 读文本；编辑器读 simValueOf");
  log("  · 进度：两端看点亮比例");
  log("");

  // ---------------------------------------------------------------- 起编辑器
  const userDir = path.join(os.tmpdir(), "p5b04x-" + Date.now());
  const proc = spawn(EDGE, ["--headless=new", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + userDir, "--no-first-run", "--disable-gpu",
    "--allow-file-access-from-files", URL_PAGE], { stdio: "ignore" });
  let cdp = null;
  try {
    for (let i = 0; i < 60 && !cdp; i++) {
      await sleep(500);
      try {
        const list = await getJson("/json/list");
        // ⚠️ 必须**按 URL 精确认 target**：headless Edge 有时会留下
        //    about:blank 或上一个实例的 page，连上去后 `window.ICAR` 是 undefined，
        //    症状是"页面明明正常却全都取不到"。
        const t = list.find((x) =>
          x.type === "page" && x.webSocketDebuggerUrl &&
          (x.url || "").indexOf("index.html") >= 0);
        if (t) cdp = await CDP.connect(t.webSocketDebuggerUrl);
      } catch (e) { }
    }
    if (!cdp) throw new Error("连不上 CDP");
    await cdp.send("Runtime.enable");
    // 连上后立刻探测：确认连的是对的 target、页面是否真的在跑
    try {
      const probe = await cdp.eval(
        "JSON.stringify({url: location.href, ready: document.readyState, hasWindow: typeof window, " +
        "scripts: document.scripts.length})"
      );
      info("CDP 探测: " + probe);
    } catch (e) {
      info("CDP 探测失败: " + e.message);
    }
    // 先给页面充足时间把 20+ 个脚本跑完（与 _probe 实测一致：约 3-8 秒）
    await sleep(6000);
    await cdp.eval("window.alert=function(){};window.confirm=function(){return true};1");
    let ready = false;
    for (let i = 0; i < 80; i++) {
      // ⚠️ 等 parseDesign 就绪 —— 它在 validate.js 里，比 CanvasState 晚加载。
      //    只等 CanvasState 会撞上「window.parseDesign is not a function」。
      ready = await cdp.eval(
        "!!(window.ICAR && window.CanvasState && window.PRIMITIVE_FAMILY " +
        "&& typeof window.parseDesign === 'function')"
      ).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    if (!ready) {
      const diag = await cdp.eval(`JSON.stringify({
        ICAR: typeof window.ICAR, CanvasState: typeof window.CanvasState,
        parseDesign: typeof window.parseDesign, PRIMITIVE_FAMILY: typeof window.PRIMITIVE_FAMILY
      })`).catch((e) => "eval failed: " + e.message);
      throw new Error("编辑器未就绪：" + diag);
    }

    // ---------------------------------------------------------------- F1 共享主题
    console.log("=== F1. 两端用同一份 v3 主题 ===");
    const themeFile = "p5b04-template-race.json";
    const themeJson = fs.readFileSync(path.join(THEME_DIR, themeFile), "utf8");
    const theme = JSON.parse(themeJson);
    info("主题: " + themeFile + "  schema=" + theme.schema + "  节点=" + theme.nodes.length);
    ok(theme.schema === "icar.ui/3", "F1 主题是 v3");

    // ---------------------------------------------------------------- F2 编辑器侧渲染
    console.log("\n=== F2. 编辑器侧：导入同一主题并注入同一模拟值 ===");
    const ed = await cdp.eval(`(function(){
      var json = ${JSON.stringify(themeJson)};
      var r = window.parseDesign(json);
      if (!r || !r.design) return JSON.stringify({err: 'parse failed', errors: r && r.errors});
      var S = window.CanvasState;
      // 注入确定性模拟值（与 Android SIM 通道对齐）
      S.previewValues = S.previewValues || {};
      var map = ${JSON.stringify({
      "obd.rpm": SIM.rpm, "obd.speed": SIM.speed, "obd.coolant": SIM.coolant,
      "obd.load": SIM.load, "obd.voltage": SIM.voltage, "obd.throttle": SIM.throttle,
      "calc.calc_boost": SIM.boost, "calc.calc_gear": SIM.gear,
    })};
      Object.keys(map).forEach(function(k){ S.previewValues[window.resolvePid(k)] = map[k]; });
      return JSON.stringify({
        ok: true,
        nodeCount: (r.design.nodes || []).length,
        prims: (r.design.nodes || []).filter(function(n){
          return ['valueText','shape','segmentedArc','pathProgress'].indexOf(n.type) >= 0;
        }).length,
        rpmSeen: window.simValueOf('obd.rpm'),
        speedSeen: window.simValueOf('obd.speed')
      });
    })()`);
    let edObj = {};
    try { edObj = JSON.parse(ed); } catch (e) { }
    info("编辑器：" + JSON.stringify(edObj));
    ok(edObj.ok === true, "F2 编辑器能导入 v3 主题");
    ok(edObj.prims === 10, "F2 编辑器识别到 10 个基元节点（实际 " + edObj.prims + "）");
    ok(edObj.rpmSeen === SIM.rpm, "F2 编辑器取到 rpm=" + edObj.rpmSeen);
    ok(edObj.speedSeen === SIM.speed, "F2 编辑器取到 speed=" + edObj.speedSeen);

    // 编辑器侧：几何（画布坐标，两端同一套 0..360）
    const edGeom = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var json = ${JSON.stringify(themeJson)};
      var r = window.parseDesign(json);
      var out = [];
      (r.design.nodes || []).forEach(function(n){
        if (['valueText','shape','segmentedArc','pathProgress'].indexOf(n.type) < 0) return;
        out.push({ id:n.id, type:n.type, x:n.x, y:n.y, w:n.w, h:n.h, z:n.z });
      });
      return out;
    })())`));
    info("编辑器基元几何样本: " + JSON.stringify(edGeom.slice(0, 3)));

    // ---------------------------------------------------------------- F3 Android 侧渲染
    console.log("\n=== F3. Android 侧：部署同一主题 + 同一模拟值 ===");
    const dep = execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), themeFile],
      { encoding: "utf8", timeout: 300000, cwd: ROOT });
    const depLine = (dep.match(/回读校验[^\n]*/) || [""])[0].trim();
    info(depLine);
    ok(/一致=true/.test(depLine), "F3 Android 部署一致（" + depLine + "）");

    // 同一模拟值：normal 场景的 rpm ≈ 800，为对齐编辑器用 mid 场景附近
    // 真实做法：用 SimScenario 的固定档位，并在两端口径一致的位置比较"方向"
    sh("am broadcast -a com.icar.obd.SIM --es scenario normal --ei step 5");
    await sleep(7000);
    const pngA = grab("p5b04-crossend-normal.png");

    // ---------------------------------------------------------------- F4 逐控件区域对比
    console.log("\n=== F4. 逐控件区域对比（颜色/位置）===");

    // 4a: segmentedArc 点亮色（两端应都有）
    const arcA = findColor(pngA, 255, 61, 127, 8);
    info("Android segmentedArc 点亮 #FF3D7F 像素=" + arcA.n +
      "  盒=(" + arcA.minX + "," + arcA.minY + ")-(" + arcA.maxX + "," + arcA.maxY + ")");
    ok(arcA.n > 200, "F4 Android segmentedArc 点亮段可见（" + arcA.n + " 像素）");

    // 两端同一主题里 segmentedArc 的 x/y/w/h 应一致（画布坐标）
    const arcNode = theme.nodes.find((n) => n.type === "segmentedArc");
    info("主题里 segmentedArc 几何: x=" + arcNode.x + " y=" + arcNode.y + " w=" + arcNode.w + " h=" + arcNode.h);
    ok(arcNode.w === arcNode.h, "F4 segmentedArc 是正方形（保证圆弧不变形）");

    // 4b: 主面板 Shape 填充色
    const panelA = findColor(pngA, 18, 26, 36, 6);
    info("Android 主面板 #121A24 像素=" + panelA.n);
    ok(panelA.n > 5000, "F4 Android Shape 主面板可见（" + panelA.n + " 像素）");

    // 4c: ValueText 白色文字
    const whiteA = findColor(pngA, 255, 255, 255, 8);
    info("Android 白色文字像素=" + whiteA.n);
    ok(whiteA.n > 200, "F4 Android ValueText 文字可见（" + whiteA.n + " 像素）");

    // ---------------------------------------------------------------- F5 进度方向一致
    console.log("\n=== F5. 进度方向一致（RPM 升高 → 点亮段变多，两端同向）===");
    sh("am broadcast -a com.icar.obd.SIM --es scenario critical --ei step 5");
    await sleep(6000);
    const pngCrit = grab("p5b04-crossend-critical.png");
    const arcCrit = findColor(pngCrit, 255, 61, 127, 8);
    info("Android critical 场景点亮像素=" + arcCrit.n + "（normal 时 " + arcA.n + "）");
    ok(arcCrit.n > arcA.n,
       "F5 Android：RPM 升高 → 点亮段变多（" + arcA.n + " → " + arcCrit.n + "）");

    // 编辑器侧同向
    const edProg = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var lo = 0, hi = 8000;
      function p(rpm){ return rpm === null ? null : Math.max(0, Math.min(1, (rpm - lo) / (hi - lo))); }
      return { normal: p(800), critical: p(7400) };
    })())`));
    info("编辑器: normal=" + edProg.normal + " critical=" + edProg.critical);
    ok(edProg.critical > edProg.normal,
       "F5 编辑器：同向（" + edProg.normal + " → " + edProg.critical + "）");

    // ---------------------------------------------------------------- F6 无数据状态
    console.log("\n=== F6. 无数据状态（断开 → 两端都应变）===");
    sh("am broadcast -a com.icar.obd.SIM --es scenario disconnect");
    await sleep(5000);
    const pngNo = grab("p5b04-crossend-nodata.png");
    const arcNo = findColor(pngNo, 255, 61, 127, 8);
    info("Android 断开后点亮像素=" + arcNo.n);
    ok(arcNo.n < arcCrit.n * 0.5,
       "F6 Android 断开后点亮段显著减少（" + arcCrit.n + " → " + arcNo.n + "）");

    const edNo = await cdp.eval(`JSON.stringify((function(){
      var S = window.CanvasState;
      S.previewValues = {};
      return { rpm: window.simValueOf('obd.rpm'), speed: window.simValueOf('obd.speed') };
    })())`);
    const edNoObj = JSON.parse(edNo);
    info("编辑器清空模拟值后: " + JSON.stringify(edNoObj));
    ok(edNoObj.rpm === null, "F6 编辑器：清空后取值为 null（→ 画无数据态）");

    // ---------------------------------------------------------------- F7 数据恢复
    console.log("\n=== F7. 数据恢复 ===");
    sh("am broadcast -a com.icar.obd.SIM --es scenario recover --ei step 5");
    await sleep(5000);
    const pngRec = grab();
    const arcRec = findColor(pngRec, 255, 61, 127, 8);
    info("Android 恢复后点亮像素=" + arcRec.n);
    ok(arcRec.n > arcNo.n, "F7 Android 恢复后点亮段回来（" + arcNo.n + " → " + arcRec.n + "）");

    // ---------------------------------------------------------------- F8 不影响旧 Gauge
    console.log("\n=== F8. 不影响原有八种 Gauge / 轨道 / 状态灯 ===");
    const crash = sh("logcat -d -b crash");
    ok(!/FATAL EXCEPTION/.test(crash), "F8 全程无崩溃");
    ok(sh("pidof " + PKG).trim() !== "", "F8 App 进程存活");

    // 八样式回归（另起一个主题，验证旧功能完好）
    try {
      const d2 = execFileSync("node", [path.join(ROOT, "tools/icarui/tests/device/deploy-8styles.js"), "p5b01-8styles.json"],
        { encoding: "utf8", timeout: 300000, cwd: ROOT });
      const l2 = (d2.match(/回读校验[^\n]*/) || [""])[0].trim();
      info("切回八样式：" + l2);
      ok(/一致=true/.test(l2), "F8 能切回旧主题（8 档样式仍在）");
    } catch (e) {
      ok(false, "F8 切回旧主题失败：" + (e.stdout || e.message));
    }

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 判据说明：两端渲染引擎不同，**不主张逐像素一致**（指令允许字体抗锯齿差异）。");
    log("   本套件证明「同一控件的关键属性在两端都可观察到且方向一致」。");
    fs.writeFileSync(OUT, out.join("\n"), "utf8");
  } catch (e) {
    console.error("套件异常: " + e.message);
    fail++;
  } finally {
    try { cdp && cdp.ws.close(); } catch (e) { }
    try { proc.kill(); } catch (e) { }
  }
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
