// ============================================================================
// P5A-M03 阶段 E1：状态灯**闪烁**验证
//
// ## 为什么不能靠单张截图
//
// 闪烁的本质是"同一块区域在两个状态间来回切"。单张截图只能证明"此刻它在"
// 或"此刻它不在"，无法区分「在闪」与「根本不显示」。
//
// 所以这里做**定时连续采样**：
//   · 在 warn 场景下连拍 N 张（间隔 < 半个闪烁周期）
//   · 对同一个灯的区域算「素材像素占比」，得到一条时间序列
//   · 判据：序列里必须同时出现"明显高"和"明显低"两组值，且**变化 ≥ 2 次**
//     （证明它真的在开-关之间来回，而不是恒定或抖动一次）
//
// ## 覆盖
//   E1-a  warn 档闪烁（blinkMs=400）           → 序列有开有关
//   E1-b  critical 档闪烁（只给 l_coolant 开）  → 该灯闪、其它灯不闪
//   E1-c  非闪烁灯（l_speed 的 critical）       → 序列**恒定**（对照组）
//   E1-d  断开 → 全部进未知态（不画素材），不闪
//   E1-e  恢复 → 回到正常（不闪）
//   E1-f  切到后台再回前台，闪烁恢复（不卡死、不停在"关"那半拍）
// ============================================================================
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const DEV = process.env.ADB_DEVICE || "emulator-5554";
const SHOT = path.join(__dirname, "..", "..", "..", "..", "docs", "02_验证记录", "screenshots");
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });
const REMOTE = "/sdcard/_p5a03.png";

function sh(a, t) {
  try { return execFileSync(ADB, ["-s", DEV].concat(a), { encoding: "utf8", timeout: t || 60000, maxBuffer: 32 * 1024 * 1024 }); }
  catch (e) { return (e.stdout || "") + (e.stderr || ""); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tap = (x, y) => sh(["shell", "input", "tap", String(x), String(y)]);
const swipeL = () => sh(["shell", "input", "swipe", "1000", "1200", "100", "1200", "200"]);
const swipeR = () => sh(["shell", "input", "swipe", "100", "1200", "1000", "1200", "200"]);
function fg() {
  const d = sh(["shell", "dumpsys", "activity", "activities"]);
  return /topResumedActivity=[^\n]*?com\.icar\.obd/.test(d);
}
function dumpUI() {
  sh(["shell", "uiautomator", "dump", "/sdcard/_p5a03ui.xml"]);
  const xml = sh(["shell", "cat", "/sdcard/_p5a03ui.xml"]);
  const out = []; const re = /text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g; let m;
  while ((m = re.exec(xml)) !== null) {
    if (!m[1]) continue;
    out.push({ label: m[1], cx: Math.round((+m[2] + +m[4]) / 2), cy: Math.round((+m[3] + +m[5]) / 2) });
  }
  return out;
}
const find = (it, s) => it.find((i) => i.label.indexOf(s) >= 0) || null;

/**
 * **确保停在 MainActivity**（P5A-M03 踩到的坑）。
 *
 * 症状：跑到一半前台变成了 `.ui.RuleEditorActivity`，此后所有横滑都在规则编辑器里
 * 乱点，截图里根本没有画布 —— 而"区域彩色占比"一直恒为 0.011，
 * 看起来像"闪烁失效"，其实是**根本没在看画布**。
 *
 * 所以每次切场景/采样前都先确认前台，必要时 force-stop 重进。
 */
function ensureMain(label) {
  const d = sh(["shell", "dumpsys", "activity", "activities"]);
  if (/topResumedActivity=[^\n]*com\.icar\.obd\/\.ui\.MainActivity/.test(d)) return true;
  console.log("  ⚠ 前台不是 MainActivity（" + label + "）→ force-stop 重进");
  sh(["shell", "am", "force-stop", "com.icar.obd"]);
  sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  return true;
}

// ---------------------------------------------------------------- PNG 解码
function decodePNG(p) {
  const b = fs.readFileSync(p);
  let pos = 8, w = 0, h = 0; const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), ty = b.toString("ascii", pos + 4, pos + 8);
    if (ty === "IHDR") { w = b.readUInt32BE(pos + 8); h = b.readUInt32BE(pos + 12); }
    if (ty === "IDAT") idat.push(b.slice(pos + 8, pos + 8 + len));
    if (ty === "IEND") break; pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp; const out = Buffer.alloc(w * h * 4); let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const bb = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (f === 0) v = cur; else if (f === 1) v = cur + a; else if (f === 2) v = cur + bb;
      else if (f === 3) v = cur + Math.floor((a + bb) / 2);
      else { const p2 = a + bb - c, pa = Math.abs(p2 - a), pb = Math.abs(p2 - bb), pc = Math.abs(p2 - c); v = cur + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c)); }
      out[y * stride + x] = v & 255;
    }
    rp += stride;
  }
  return { w, h, px: out };
}

// 与 state-lamps 主题一致的灯位（设计坐标 0..360）
const ELEM = {
  l_coolant: { x: 20, y: 110, w: 70, h: 60 },
  l_speed: { x: 145, y: 110, w: 70, h: 60 },
  l_volt_low: { x: 270, y: 110, w: 70, h: 60 },
  l_nopid: { x: 20, y: 190, w: 70, h: 60 },
  l_rpm: { x: 145, y: 190, w: 70, h: 60 },
  l_load: { x: 270, y: 190, w: 70, h: 60 }
};
function mapper(img) {
  const top = Math.round(img.h * 0.053);
  return (dx, dy) => [dx / 360 * img.w, top + dy / 360 * (img.h - top)];
}
/** 灯区域内「饱和彩色像素」占比（画了素材就高，alpha=0/未知态就接近 0） */
function litRatio(img, e) {
  const mp = mapper(img);
  const [x0, y0] = mp(e.x, e.y);
  const [x1, y1] = mp(e.x + e.w, e.y + e.h);
  let n = 0, lit = 0;
  for (let y = Math.ceil(y0); y < Math.min(img.h, Math.floor(y1)); y += 2) {
    for (let x = Math.ceil(x0); x < Math.min(img.w, Math.floor(x1)); x += 2) {
      const i = (y * img.w + x) * 4;
      const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (mx > 60 && sat > 0.18) lit++;
      n++;
    }
  }
  return n ? lit / n : 0;
}

async function shoot(tag) {
  sh(["shell", "screencap", "-p", REMOTE]);
  const p = path.join(SHOT, tag);
  sh(["pull", REMOTE, p]);
  if (!fs.existsSync(p)) return null;
  return decodePNG(p);
}
async function broadcast(scene, step) {
  sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", scene,
    "--ei", "step", String(step || 3)]);
}
async function broadcastOnCanvas(scene, step) {
  ensureMain("broadcast " + scene);
  await sleep(1200);
  await gotoCanvas();
  await sleep(1200);
  await broadcast(scene, step);
}
async function gotoSettings() {
  let it = dumpUI();
  for (let i = 0; i < 6; i++) {
    if (find(it, "导入画布")) return it;
    swipeL(); await sleep(700); it = dumpUI();
  }
  return it;
}
async function gotoCanvas() {
  for (let i = 0; i < 6; i++) {
    const it = dumpUI();
    if (!find(it, "导入画布")) return it;
    swipeR(); await sleep(700);
  }
  return dumpUI();
}

/** 连续采样某个灯的区域占比，返回序列 */
async function sampleSeries(label, elemId, count, intervalMs, prefix) {
  const series = [];
  for (let i = 0; i < count; i++) {
    const img = await shoot((prefix || "p5a03-blink") + "-" + label + "-" + i + ".png");
    if (img) series.push(+litRatio(img, ELEM[elemId]).toFixed(4));
    await sleep(intervalMs);
  }
  return series;
}
/** 序列里"高低两组"是否都存在，且跨越 ≥2 次 */
function analyze(series) {
  // ⚠️ 样本不足必须单独标出来：否则"没采到图"会被"没在闪"的断言当成通过
  if (series.length < 4) return { ok: false, sampled: false, why: "样本不足（" + series.length + " 张）" };
  const sampledAtLeast = true;
  const mx = Math.max.apply(null, series), mn = Math.min.apply(null, series);
  const span = mx - mn;
  // ⚠️ 这里必须带 `sampled: true` —— 否则"恒定不闪"会被 E1-c/E1-e 的
  //    `a.sampled && !a.ok` 判成失败（第一版漏了，把"正确地不闪"报成了 bug）。
  if (span < 0.05) return { ok: false, sampled: true, why: "区间太窄 " + span.toFixed(3) + "（没在闪）", mx, mn };
  const mid = (mx + mn) / 2;
  let crossings = 0, prev = series[0] > mid;
  series.forEach((v) => { const cur = v > mid; if (cur !== prev) { crossings++; prev = cur; } });
  return { ok: crossings >= 2, sampled: true, why: "跨越 " + crossings + " 次（需 ≥2）", mx, mn, crossings };
}

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

(async function () {
  console.log("=== P5A-M03 阶段 E1：状态灯闪烁 ===\n");

  // ---- 前置：必须是「P5A-M03 状态灯闪烁测试」这把主题 ----
  //
  // ⚠️ 第一版这里自己走 SAF 导入，但导航漂到了 RuleEditorActivity，
  //    结果**根本没换上主题**，采到的是上一把（parts-gauge）的画面 ——
  //    区域占比恒为 0.074 却看起来像"闪烁失效"。
  //    现在：导入交给 tools/icarui/tests/_import_pack.js，本脚本只**核对设计名**。
  const settingsJson = sh(["shell", "run-as", "com.icar.obd", "cat",
    "/data/data/com.icar.obd/files/config/settings.json"]);
  let designName = "?", lampCount = 0;
  try {
    const j = JSON.parse(settingsJson.replace(/^\uFEFF/, ""));
    const dd = JSON.parse(j.designJson);
    designName = dd.name;
    lampCount = (dd.pages[0].nodes || []).filter((n) => n.states).length;
  } catch (e) { /* 留空 */ }
  console.log("  当前设计: " + designName + "（状态灯 " + lampCount + " 个）");
  if (designName.indexOf("状态灯闪烁") < 0) {
    console.log("  ❌ 当前加载的不是闪烁测试主题 —— 先跑：");
    console.log("     node tools/icarui/tests/_import_pack.js state-lamps-blink.icarzip \"P5A-M03 状态灯闪烁测试\"");
    console.log("PASS=0 FAIL=1");
    process.exit(1);
  }
  ok(lampCount >= 6, "前置：主题就位（" + lampCount + " 个状态灯）");


  await sleep(1500);
  await gotoSettings();
  await gotoCanvas();
  await sleep(2500);

  // ---- E1-a warn 档闪烁 ----
  console.log("\n--- E1-a. warn 档闪烁（blinkMs=400）---");
  await broadcastOnCanvas("alarm", 5);
  await sleep(3000);
  // 400ms 周期 = 每 200ms 翻转一次；采样间隔 150ms、取 20 点
  const sA = await sampleSeries("warn", "l_coolant", 20, 150, "p5a03-blink-warn");
  const aA = analyze(sA);
  console.log("    序列=" + sA.join(", "));
  ok(aA.ok, "E1-a l_coolant 在 warn 档闪烁：" + aA.why + "，区间 " +
    (aA.mn !== undefined ? aA.mn.toFixed(3) + "~" + aA.mx.toFixed(3) : "-"));

  // ---- E1-b/E1-c critical：只有一个灯闪，另一个作为对照 ----
  console.log("\n--- E1-b/c. critical 档：l_coolant 闪、l_speed 不闪（对照）---");
  await broadcastOnCanvas("critical", 5);
  await sleep(3000);
  const sB = await sampleSeries("crit-coolant", "l_coolant", 20, 150, "p5a03-blink-critA");
  const aB = analyze(sB);
  console.log("    l_coolant 序列=" + sB.join(", "));
  ok(aB.ok, "E1-b l_coolant（critical，blink=true）在闪：" + aB.why);

  const sC = await sampleSeries("crit-speed", "l_speed", 12, 150, "p5a03-blink-critB");
  const aC = analyze(sC);
  console.log("    l_speed   序列=" + sC.join(", "));
  ok(aC.sampled && !aC.ok, "E1-c l_speed（critical，blink=false）**不闪**：" + aC.why +
    (aC.sampled ? "，区间 " + aC.mn.toFixed(3) + "~" + aC.mx.toFixed(3) : ""));

  // ---- E1-d 断开：全部未知，不画素材 ----
  console.log("\n--- E1-d. 断开：全部进入未知态（不画素材、不闪）---");
  await broadcastOnCanvas("disconnect");
  await sleep(3000);
  const sD = await sampleSeries("disc", "l_coolant", 10, 150, "p5a03-blink-disc");
  const maxD = sD.length ? Math.max.apply(null, sD) : NaN;
  console.log("    序列=" + sD.join(", "));
  ok(sD.length >= 4 && maxD < 0.02, "E1-d 断开后区域彩色占比恒低（" + sD.length + " 张，max " +
    (isFinite(maxD) ? maxD.toFixed(3) : "-") + " < 0.02）→ 未知态不画素材");

  // ---- E1-e 恢复：回到正常（不闪）----
  console.log("\n--- E1-e. 恢复：回到正常，不闪 ---");
  await broadcastOnCanvas("recover", 5);
  await sleep(3000);
  const sE = await sampleSeries("rec", "l_coolant", 12, 150, "p5a03-blink-rec");
  const aE = analyze(sE);
  console.log("    序列=" + sE.join(", "));
  ok(aE.sampled && !aE.ok, "E1-e 恢复后不闪（" + aE.why + "）");
  ok(Math.min.apply(null, sE) > 0.3, "E1-e 恢复后素材确实画出来了（min " +
    Math.min.apply(null, sE).toFixed(3) + " > 0.3）");

  // ---- E1-f 前后台切换后闪烁仍正常 ----
  console.log("\n--- E1-f. 切后台再回前台，闪烁恢复 ---");
  await broadcastOnCanvas("critical", 5);
  await sleep(2500);
  sh(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await sleep(3500);
  sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await sleep(6000);
  await gotoCanvas();
  await sleep(2000);
  await broadcastOnCanvas("critical", 5);
  await sleep(2500);
  const sF = await sampleSeries("resume", "l_coolant", 18, 150, "p5a03-blink-resume");
  const aF = analyze(sF);
  console.log("    序列=" + sF.join(", "));
  ok(aF.ok, "E1-f 回前台后仍在闪（" + aF.why + "）→ 没卡在「关」那半拍");
  ok(fg(), "E1-f 仍在前台");

  // ---- 资源检查 ----
  console.log("\n--- 资源与异常 ---");
  const fatals = sh(["logcat", "-d", "-s", "AndroidRuntime:E"]).split("\n").filter((x) => /FATAL/.test(x)).length;
  ok(fatals === 0, "全程 0 FATAL");

  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
