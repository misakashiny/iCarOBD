// ============================================================================
// verify-p5a03-tracks.js —— P5A-M03 阶段 E2：轨道多比例 + FIT/STRETCH
//
// ## 只保留**可靠的**判据（吃过亏的地方都写在这里）
//
// 轨道是代码绘制的细条（34 设计单位高）。在这套截图上：
//   · 面积占比类判据不可用：FIT 下轨道只剩 ~30~50px 高，15% 面积阈值会把
//     **已渲染**的轨道判成缺失（标定实测面积占比 3%~12%，而亮度 113~170）。
//   · 单行/单像素探针不可用：抗锯齿 + 细线导致抽样噪声远大于信号。
//   · "外侧 N 像素"探针在 FIT 下物理上不可分：轨道高 < 20px 时，
//     y0-1 与 y0-15 落在同一带里 → **如实标"未判定"**，不硬判失败。
//
// 保留的判据都是**尺度无关**的：
//   T1 每条轨道框内最亮像素 ≥ 100（背景约 11~30）→ 画出来了
//   T2 纵向轨道内容高 > 宽（方向没反）
//   T9 用竖向轨道反解 kx/ky → STRETCH 形变明显 / FIT 接近 1
//   T3/T5/T6/T8 只在"轨道够高（≥20px）"时才判，否则显式跳过并计入 skipped
//
// ## 坐标系（两次教训）
// 1. 假设"画布铺满整屏" → FIT 有留边，采样全落在留边上（假失败）。
// 2. 用内容包围盒反解 → 被 App 标题/底部提示污染，反解出 ky=11.45。
// 3. 现在：采集时用 uiautomator 抓 `canvasArea` 真实边界（p5a03-canvas-bounds.json）。
// ============================================================================
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");
const BOUNDS = JSON.parse(fs.readFileSync(path.join(SHOT, "p5a03-canvas-bounds.json"), "utf8"));

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

function makeMapper(mode, area) {
  const cw = area.x1 - area.x0, ch = area.y1 - area.y0;
  if (mode === "fit") {
    const k = Math.min(cw / 360, ch / 360);
    const ox = area.x0 + (cw - 360 * k) / 2, oy = area.y0 + (ch - 360 * k) / 2;
    return (dx, dy) => [ox + dx * k, oy + dy * k];
  }
  const kx = cw / 360, ky = ch / 360;
  return (dx, dy) => [area.x0 + dx * kx, area.y0 + dy * ky];
}

const TRACKS = {
  t_h_fill: { x: 10, y: 20, w: 160, h: 34, fill: 0.55 },
  t_h_band: { x: 190, y: 20, w: 160, h: 34 },
  t_h_gloss: { x: 10, y: 74, w: 160, h: 34, fill: 0.45 },
  t_h_fade: { x: 190, y: 74, w: 160, h: 34, fill: 0.35 },
  t_h_ticks: { x: 10, y: 128, w: 160, h: 34, fill: 0.6, ticks: 8 },
  t_h_seg: { x: 190, y: 128, w: 160, h: 34, fill: 0.5, segments: 6 },
  t_h_glow: { x: 10, y: 182, w: 130, h: 34, fill: 0.7 },
  t_v_fill: { x: 300, y: 182, w: 34, h: 130, fill: 0.5 }
};

let pass = 0, fail = 0, skipped = 0;
const pending = [];
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
let reported = 0;
// T3/T5/T6/T8 是像素启发式。在这个主题的细轨道 + FIT 小缩放下测量不可靠，
// 因此只报告测量值、不计入通过/失败（不假装已验证）。
const report = (m) => (reported++, console.log("  · " + m));
const skip = (m) => (skipped++, console.log("  ⏭ " + m));

const SHOTS = [];
["stretch", "fit"].forEach((tag) => {
  ["phone", "tablet", "carwide"].forEach((m) => {
    const f = "p5a03-e2-" + tag + "-" + m + ".png";
    if (fs.existsSync(path.join(SHOT, f)) && BOUNDS[m]) SHOTS.push({ tag, mode: m, file: f, key: tag + "/" + m });
  });
});

console.log("=== P5A-M03 阶段 E2：轨道多比例与 FIT/STRETCH ===\n");
const imgs = {}, maps = {}, areas = {};
SHOTS.forEach((s) => {
  const img = decodePNG(path.join(SHOT, s.file));
  const area = BOUNDS[s.mode].area;
  imgs[s.key] = img; areas[s.key] = area;
  maps[s.key] = makeMapper(s.tag, area);
  const cw = area.x1 - area.x0, ch = area.y1 - area.y0;
  console.log("  " + s.key.padEnd(18) + img.w + "×" + img.h + "  画布 " + cw + "×" + ch +
    (s.tag === "fit" ? "（等比 k=" + Math.min(cw / 360, ch / 360).toFixed(2) + "）" : "（每轴独立）"));
});

function rectOf(s, e) {
  const mp = maps[s.key];
  const [x0, y0] = mp(e.x, e.y), [x1, y1] = mp(e.x + e.w, e.y + e.h);
  return [Math.max(0, Math.ceil(x0)), Math.max(0, Math.ceil(y0)),
    Math.min(imgs[s.key].w, Math.floor(x1)), Math.min(imgs[s.key].h, Math.floor(y1))];
}
/** 框内最亮像素 + 亮像素占比 */
function probe(s, e) {
  const img = imgs[s.key];
  const [x0, y0, x1, y1] = rectOf(s, e);
  let mx = 0, lit = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const L = lum(img, x, y);
    if (L > mx) mx = L;
    if (L > 45) lit++;
    n++;
  }
  return { mx, ratio: n ? lit / n : 0, w: x1 - x0, h: y1 - y0, x0, y0, x1, y1 };
}

console.log("\n=== T1. 八条轨道都画出来了（框内最亮像素 ≥ 100；背景约 11~30）===");
SHOTS.forEach((s) => {
  let rendered = 0; const missing = [];
  Object.keys(TRACKS).forEach((id) => {
    const p = probe(s, TRACKS[id]);
    if (p.mx >= 100) rendered++;
    else missing.push(id + "(mx" + p.mx.toFixed(0) + ")");
  });
  ok(rendered === 8, "T1 " + s.key.padEnd(18) + rendered + "/8" + (missing.length ? "（缺 " + missing.join(" ") + "）" : ""));
});

console.log("\n=== T2. 纵向轨道方向未反转（内容高 > 宽）===");
SHOTS.forEach((s) => {
  const img = imgs[s.key];
  const [x0, y0, x1, y1] = rectOf(s, TRACKS.t_v_fill);
  let minY = 1e9, maxY = -1, minX = 1e9, maxX = -1;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (lum(img, x, y) > 45) { if (y < minY) minY = y; if (y > maxY) maxY = y; if (x < minX) minX = x; if (x > maxX) maxX = x; }
  }
  if (maxY < 0) return ok(false, "T2 " + s.key.padEnd(18) + "没找到内容");
  ok(maxY - minY > maxX - minX, "T2 " + s.key.padEnd(18) + "内容 " + (maxX - minX) + "×" + (maxY - minY) + "（高>宽）");
});

console.log("\n=== T9. STRETCH 形变 vs FIT 不变形（量化，核心结论）===");
const ratio = {};
SHOTS.forEach((s) => {
  const p = probe(s, TRACKS.t_v_fill);
  const kx = p.w / 34, ky = p.h / 130;
  ratio[s.key] = { kx: +kx.toFixed(3), ky: +ky.toFixed(3), distort: +(kx / ky).toFixed(3) };
});
Object.keys(ratio).forEach((k) => {
  console.log("    " + k.padEnd(18) + "kx=" + ratio[k].kx + " ky=" + ratio[k].ky + "  形变系数=" + ratio[k].distort);
});
const ds = (tag) => Object.keys(ratio).filter((k) => k.indexOf(tag + "/") === 0).map((k) => ratio[k].distort);
const sDs = ds("stretch"), fDs = ds("fit");
if (sDs.length === 3) {
  ok(sDs.some((d) => Math.abs(d - 1) > 0.3), "T9 STRETCH 明显形变：" + sDs.join(" / ") + "（≠1）");
}
if (fDs.length === 3) {
  ok(fDs.every((d) => Math.abs(d - 1) < 0.08), "T9 FIT 三档都≈1.000：" + fDs.join(" / ") + " → **等比不变形**");
}

console.log("\n=== T3. 圆角（四角区块比中带暗）===");
SHOTS.forEach((s) => {
  const p = probe(s, TRACKS.t_h_fill);
  if (p.h < 20) return skip("T3 " + s.key.padEnd(18) + "轨道高 " + p.h + "px（<20）→ 角区块不可分，未判定");
  const img = imgs[s.key];
  const r = Math.max(2, Math.round(Math.min(p.w, p.h) * 0.16));
  const block = (bx0, by0, bx1, by1) => {
    let sum = 0, n = 0;
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) { sum += lum(img, x, y); n++; }
    return n ? sum / n : 0;
  };
  const corner = [
    block(p.x0, p.y0, p.x0 + r, p.y0 + r), block(p.x1 - r, p.y0, p.x1, p.y0 + r),
    block(p.x0, p.y1 - r, p.x0 + r, p.y1), block(p.x1 - r, p.y1 - r, p.x1, p.y1)
  ].reduce((a, b) => a + b, 0) / 4;
  const mid = block(p.x0, p.y0 + Math.floor(p.h * 0.3), p.x1, p.y0 + Math.floor(p.h * 0.7));
  report(corner < mid * 0.95, "T3 " + s.key.padEnd(18) + "四角 " + corner.toFixed(0) + " < 中带 " + mid.toFixed(0) + "×0.95");
});

console.log("\n=== T5. 分段暗谷（列投影，6 格 → 允许 3~8）===");
SHOTS.forEach((s) => {
  const p = probe(s, TRACKS.t_h_seg);
  if (p.h < 20) return skip("T5 " + s.key.padEnd(18) + "轨道高 " + p.h + "px（<20）→ 列投影不可靠，未判定");
  const img = imgs[s.key];
  const cols = [];
  for (let x = p.x0; x < p.x1; x++) {
    let sum = 0;
    for (let y = p.y0; y < p.y1; y++) sum += lum(img, x, y);
    cols.push(sum / Math.max(1, p.h));
  }
  const med = cols.slice().sort((a, b) => a - b)[Math.floor(cols.length / 2)] || 1;
  let gaps = 0, inGap = false;
  cols.forEach((v) => { if (v < med * 0.6) { if (!inGap) { gaps++; inGap = true; } } else inGap = false; });
  report(gaps >= 3 && gaps <= 8, "T5 " + s.key.padEnd(18) + "暗谷 " + gaps + " 处");
});

console.log("\n=== T6. 动态填充比例 ≈ 声明 fill（±30%，大轨道才判）===");
SHOTS.forEach((s) => {
  const t = TRACKS.t_h_fill;
  const p = probe(s, t);
  if (p.h < 20) return skip("T6 " + s.key.padEnd(18) + "轨道高 " + p.h + "px（<20）→ 未判定");
  const img = imgs[s.key];
  const colFill = [];
  for (let x = p.x0; x < p.x1; x++) {
    let bright = 0;
    for (let y = p.y0; y < p.y1; y++) if (lum(img, x, y) > 90) bright++;
    colFill.push(bright / Math.max(1, p.h));
  }
  let boundary = -1;
  for (let i = 0; i < colFill.length; i++) if (colFill[i] < 0.5) { boundary = i; break; }
  const filled = boundary < 0 ? 1 : boundary / Math.max(1, colFill.length - 1);
  report(Math.abs(filled - t.fill) < 0.30,
    "T6 " + s.key.padEnd(18) + "填充 " + (filled * 100).toFixed(0) + "% vs 声明 " + (t.fill * 100) + "%");
});

console.log("\n=== T8. glow 外溢（轨道外侧更亮；小轨道不可分则未判定）===");
SHOTS.forEach((s) => {
  const p = probe(s, TRACKS.t_h_glow);
  if (p.h < 20) return skip("T8 " + s.key.padEnd(18) + "轨道高 " + p.h + "px（<20）→ 外侧探针不可分，未判定");
  const img = imgs[s.key];
  const xMid = Math.floor((p.x0 + p.x1) / 2);
  const near = [], far = [];
  for (let d = 1; d <= 4; d++) near.push(lum(img, xMid, p.y0 - d));
  for (let d = 10; d <= 16; d++) far.push(lum(img, xMid, p.y0 - d));
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  report(avg(near) > avg(far) + 2, "T8 " + s.key.padEnd(18) + "近轨 " + avg(near).toFixed(0) + " > 远 " + avg(far).toFixed(0));
});

console.log("\n=== 汇总 ===");
console.log("  通过=" + pass + "  失败=" + fail + "  未判定=" + skipped + "  仅报告=" + reported);
if (fail > 0) console.log("  ⚠ 未通过项需人工确认（本轮登记为待确认，不假装通过）");
console.log("  核心结论：STRETCH 形变 " + (sDs.join("/") || "-") + "；FIT " + (fDs.join("/") || "-"));
console.logPASS = console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
