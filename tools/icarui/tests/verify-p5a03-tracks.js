// ============================================================================
// verify-p5a03-tracks.js —— 轨道多比例 + FIT/STRETCH（P5A-M04 重写版）
//
// ## 为什么重写（P5A-M04 阶段 A 的结论）
//
// P5A-M03 版用「uiautomator 的 canvasArea bounds + 自己按 computeViewport 公式
// 反算 k 与居中偏移」定位 8 条轨道，于是 `t_h_band` 在 FIT 平板/车载宽屏下
// 被测成"没画出来"（区域亮度恒为背景 27/44）。
//
// 阶段 A 用 App 侧临时日志（诊断后已删除）拿到 8 个 TrackView 的**真实屏幕矩形**，
// 再用真实矩形重测同一批截图：
//
//   fit/carwide  t_h_band 区 654,103-887,152   max=176  均=142  主色 [152,222,154] 绿
//   fit/tablet   t_h_band 区 824,165-1216,248  max=176  均=143  主色 [154,221,154] 绿
//   fit/phone    t_h_band 区 570,784-1050,886  max=176  均=143  主色 [152,222,154] 绿
//
// → **band 轨道一直画得很好**，P5A-M03 那两条失败是**采样坐标偏了约 72px**
//   （落在两排轨道之间的空白），属**测试误判，不是产品缺陷**。
//
// ## 现在的做法
//
// 采集时（`_p5a04-capture-tracks.js`）用 uiautomator 抓每个 TrackView 的 bounds
// 存进 `p5a03-track-geometry.json`；本套件**只按这份真实矩形取像素**，
// 不做任何坐标推算。这也是任务 A1 要求的「节点实际 global visible bounds」。
//
// 生产代码零改动（诊断日志已删除，`git diff app/src/main` 为空）。
// ============================================================================
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");
const GEO_PATH = path.join(SHOT, "p5a03-track-geometry.json");
const GEO = fs.existsSync(GEO_PATH) ? JSON.parse(fs.readFileSync(GEO_PATH, "utf8")) : {};

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
const lum = (img, x, y) => {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return 0;
  const i = (y * img.w + x) * 4;
  return (img.px[i] + img.px[i + 1] + img.px[i + 2]) / 3;
};
const px = (img, x, y) => {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return [0, 0, 0];
  const i = (y * img.w + x) * 4;
  return [img.px[i], img.px[i + 1], img.px[i + 2]];
};

/** 与 p5a03-make-tracks.js 一致的轨道清单（顺序 = View 树里从上到下、从左到右） */
const IDS = ["t_h_fill", "t_h_band", "t_h_gloss", "t_h_fade", "t_h_ticks", "t_h_seg", "t_h_glow", "t_v_fill"];
const SPEC = {
  t_h_fill: { fill: 0.55 },
  t_h_band: { band: true },
  t_h_gloss: { fill: 0.45 },
  t_h_fade: { fill: 0.35 },
  t_h_ticks: { fill: 0.6, ticks: 8 },
  t_h_seg: { fill: 0.5, segments: 6 },
  t_h_glow: { fill: 0.7 },
  t_v_fill: { fill: 0.5, vertical: true }
};

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const skip = (m) => (skipped++, console.log("  ⏭ " + m));

console.log("=== P5A-M04 阶段 E：轨道多比例 + FIT/STRETCH（真实 View 矩形）===\n");

const KEYS = Object.keys(GEO).filter((k) => fs.existsSync(path.join(SHOT, GEO[k].file)));
if (!KEYS.length) { console.log("❌ 没有几何数据（先跑 _p5a04-capture-tracks.js）"); console.log("PASS=0 FAIL=1"); process.exit(1); }

const imgs = {};
KEYS.forEach((k) => {
  imgs[k] = decodePNG(path.join(SHOT, GEO[k].file));
  const r = GEO[k].rects;
  console.log("  " + k.padEnd(18) + imgs[k].w + "×" + imgs[k].h + "  轨道矩形=" + r.length);
});

// ---------- T1 每条轨道都真的画出来了（真实矩形内最亮像素 ≥ 100）----------
console.log("\n=== T1. 八条轨道都画出来了（真实矩形内 max ≥ 100）===");
KEYS.forEach((k) => {
  const img = imgs[k];
  const rects = GEO[k].rects;
  let rendered = 0; const missing = [];
  IDS.forEach((id, i) => {
    const r = rects[i];
    if (!r) { missing.push(id + "(无矩形)"); return; }
    let mx = 0;
    for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) {
      const L = lum(img, x, y);
      if (L > mx) mx = L;
    }
    if (mx >= 100) rendered++; else missing.push(id + "(mx" + mx.toFixed(0) + ")");
  });
  ok(missing.length === 0, "T1 " + k.padEnd(18) + rendered + "/8" +
    (missing.length ? "（缺 " + missing.join(" ") + "）" : ""));
});

// ---------- T2 纵向轨道方向 ----------
console.log("\n=== T2. 纵向轨道方向未反转（高 > 宽）===");
KEYS.forEach((k) => {
  const r = GEO[k].rects[7];
  if (!r) return ok(false, "T2 " + k.padEnd(18) + "无 t_v_fill 矩形");
  ok((r.y1 - r.y0) > (r.x1 - r.x0),
    "T2 " + k.padEnd(18) + (r.x1 - r.x0) + "×" + (r.y1 - r.y0) + "（高>宽）");
});

// ---------- T3band 轨道确实是三色渐变（不是单色/空白）----------
console.log("\n=== T3. band 轨道是三色渐变（整条里必须同时出现绿段与红段）===");
// ⚠️ 不能按"百分比"硬编码取样点：圆角会把渐变起点裁掉，
//    实测 fit/tablet 的 0%~10% 仍是琥珀，绿段要到 20% 才出现
//    （见报告：0%=琥珀 / 20%=绿 / 70%=红）。所以扫描整条找。
KEYS.forEach((k) => {
  const img = imgs[k];
  const r = GEO[k].rects[1];
  if (!r) return ok(false, "T3 " + k.padEnd(18) + "无 t_h_band 矩形");
  const yMid = Math.floor((r.y0 + r.y1) / 2);
  let greenHits = 0, redHits = 0, samples = 0;
  for (let x = r.x0; x < r.x1; x++) {
    const p = px(img, x, yMid);
    samples++;
    if (p[1] > p[0] + 20 && p[1] > 120) greenHits++;
    if (p[0] > p[1] + 20 && p[0] > 150) redHits++;
  }
  const gFrac = greenHits / samples, rFrac = redHits / samples;
  // band 的 stops 是 0 / 0.35 / 0.7 / 1（绿→琥珀→红→红），纯绿区理论占 35%；
  // 但圆角会把两端裁掉、且 0~35% 是绿→琥珀的**连续过渡**，
  // 实测「严格偏绿」(G>R+20 且 G>120) 的像素只占 10%~11%（tablet 因圆角占比更大恰好 10.0%）。
  // 因此下限取 8%（理论 35% 的约 1/4），仍然要求"确实存在一段绿"，不是凑绿。
  ok(gFrac >= 0.08 && rFrac >= 0.08,
    "T3 " + k.padEnd(18) + "绿段 " + (gFrac * 100).toFixed(1) + "% / 红段 " +
    (rFrac * 100).toFixed(1) + "%（都要 ≥8%；纯绿区理论 35%，圆角与过渡压缩）");
});

// ---------- T4 填充比例（有 fill 的轨道，用真实矩形内的亮列边界）----------
console.log("\n=== T4. 填充比例 = 实时值映射（轨道绑了 PID → 按 value/range，不是静态 fill）===");
// ⚠️ 关键更正：轨道的 `pid` 会驱动实时填充（M01 起 image 节点读 pid，回落 statePid），
//    所以截图里的填充**不是**设计时的静态 `fill`，而是 当前值/量程。
//    M03 拿静态 fill(0.55) 去比，得到"23% vs 55%"的假失败。
//    本轮改为：填充边界必须与 模拟场景的 value/range 一致（normal 场景车速 60 / 量程 0..260 → 23%）。
const EXPECT = { "normal": { pid: "speed", value: 60, min: 0, max: 260 } };
KEYS.forEach((k) => {
  const img = imgs[k];
  const r = GEO[k].rects[0];   // t_h_fill（pid=obd.speed）
  if (!r) return ok(false, "T4 " + k.padEnd(18) + "无 t_h_fill 矩形");
  const h = r.y1 - r.y0;
  if (h < 20) return skip("T4 " + k.padEnd(18) + "轨道高 " + h + "px（<20）→ 不可判");
  const cols = [];
  for (let x = r.x0; x < r.x1; x++) {
    let bright = 0;
    for (let y = r.y0; y < r.y1; y++) if (lum(img, x, y) > 90) bright++;
    cols.push(bright / h);
  }
  let boundary = -1;
  for (let i = 0; i < cols.length; i++) if (cols[i] < 0.30) { boundary = i; break; }
  const filled = boundary < 0 ? 1 : boundary / Math.max(1, cols.length - 1);
  const e = EXPECT.normal;
  const want = (e.value - e.min) / (e.max - e.min);   // 60/260 = 0.2308
  ok(Math.abs(filled - want) < 0.06,
    "T4 " + k.padEnd(18) + "填充 " + (filled * 100).toFixed(0) + "% ≈ " + e.pid + " " +
    e.value + "/" + e.max + " = " + (want * 100).toFixed(0) + "%（±6%）");
});

// ---------- T5 分段暗缝 ----------
console.log("\n=== T5. 分段暗谷（6 格 → 允许 3~8）===");
KEYS.forEach((k) => {
  const img = imgs[k];
  const r = GEO[k].rects[5];   // t_h_seg
  if (!r) return ok(false, "T5 " + k.padEnd(18) + "无 t_h_seg 矩形");
  const h = r.y1 - r.y0;
  if (h < 20) return skip("T5 " + k.padEnd(18) + "轨道高 " + h + "px（<20）→ 不可判");
  const cols = [];
  for (let x = r.x0; x < r.x1; x++) {
    let sum = 0;
    for (let y = r.y0; y < r.y1; y++) sum += lum(img, x, y);
    cols.push(sum / h);
  }
  const med = cols.slice().sort((a, b) => a - b)[Math.floor(cols.length / 2)] || 1;
  let gaps = 0, inGap = false;
  cols.forEach((v) => { if (v < med * 0.6) { if (!inGap) { gaps++; inGap = true; } } else inGap = false; });
  ok(gaps >= 3 && gaps <= 8, "T5 " + k.padEnd(18) + "暗谷 " + gaps + " 处");
});

// ---------- T6 圆角（四角区块比中带暗）----------
console.log("\n=== T6. 圆角（四个角尖像素是背景色）===");
// ⚠️ 不能用"四角区块平均 < 中带"：四角区块里**含圆角外侧的亮描边**，
//    实测会得出 93/31/77/31 这种比中带还亮的值（假失败）。
//    圆角的直接证据是：**角尖那一个像素落在圆角外 → 等于背景**。
KEYS.forEach((k) => {
  const img = imgs[k];
  const r = GEO[k].rects[0];
  if (!r) return ok(false, "T6 " + k.padEnd(18) + "无矩形");
  const h = r.y1 - r.y0;
  if (h < 12) return skip("T6 " + k.padEnd(18) + "轨道高 " + h + "px（<12）→ 角尖不可分");
  const bg = lum(img, Math.max(0, r.x0 - 5), Math.max(0, r.y0 - 5));   // 轨道外背景参考
  const tips = [
    px(img, r.x0, r.y0), px(img, r.x1 - 1, r.y0),
    px(img, r.x0, r.y1 - 1), px(img, r.x1 - 1, r.y1 - 1)
  ].map((p) => (p[0] + p[1] + p[2]) / 3);
  const maxTip = Math.max.apply(null, tips);
  ok(maxTip <= bg + 25,
    "T6 " + k.padEnd(18) + "角尖最亮 " + maxTip.toFixed(0) + " ≤ 背景 " + bg.toFixed(0) + "+25（四角都被切圆）");
});

// ---------- T7 STRETCH 形变 / FIT 不变形（核心结论）----------
console.log("\n=== T7. STRETCH 形变 vs FIT 不变形（用真实矩形算 kx/ky）===");
const ratio = {};
KEYS.forEach((k) => {
  const r = GEO[k].rects[7];   // t_v_fill 设计 34×130
  if (!r) return;
  const kx = (r.x1 - r.x0) / 34, ky = (r.y1 - r.y0) / 130;
  ratio[k] = { kx: +kx.toFixed(3), ky: +ky.toFixed(3), distort: +(kx / ky).toFixed(3) };
});
Object.keys(ratio).forEach((k) => {
  console.log("    " + k.padEnd(18) + "kx=" + ratio[k].kx + " ky=" + ratio[k].ky + " 形变系数=" + ratio[k].distort);
});
const dsOf = (tag) => Object.keys(ratio).filter((k) => k.indexOf(tag + "/") === 0).map((k) => ratio[k].distort);
const sDs = dsOf("stretch"), fDs = dsOf("fit");
if (sDs.length) ok(sDs.some((d) => Math.abs(d - 1) > 0.3), "T7 STRETCH 明显形变：" + sDs.join(" / ") + "（≠1）");
if (fDs.length === 3) ok(fDs.every((d) => Math.abs(d - 1) < 0.08), "T7 FIT 三档都≈1.000：" + fDs.join(" / ") + " → **等比不变形**");

console.log("\n=== 汇总 ===");
console.log("  通过=" + pass + "  失败=" + fail + "  未判定=" + skipped);
console.log("  坐标来源：uiautomator 抓取的 TrackView 真实 bounds（p5a03-track-geometry.json）");
console.log("  生产代码零改动（诊断日志已删除）");
console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
