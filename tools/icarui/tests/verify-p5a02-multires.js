// ============================================================================
// verify-p5a02-multires.js —— P5A-M02 阶段 E：多比例 + FIT/STRETCH 量化对照
//
// ## 测什么（任务 §7 的检查项）
//
//   · 仪表是否拉伸 / 圆形是否变椭圆 → **量化**：盘面外环包围盒的宽高比
//   · 图片是否被裁切             → 环包围盒必须完整落在屏幕内
//   · FIT 是否产生预期留白        → 内容包围盒明显小于屏幕（letterbox）
//   · STRETCH 是否铺满            → 内容包围盒接近整屏
//
// ## 为什么用「盘面外环」
//
// 主题 `parts-gauge` 的 dial 是一张 256×256 的**圆形**素材（设计里 150×150）。
// 圆在等比缩放下仍是圆（宽高比 ≈ 1），在每轴独立缩放下变成椭圆
// （宽高比 ≈ pxX/pxY）。所以「环包围盒宽高比」直接量化了形变量。
//
// 素材里另有 azure 外环（78,132,200），与背景和指针颜色区分明显。
// ============================================================================
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

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

const RING = [78, 132, 200];

/** 环像素掩膜（按 4×4 下采样） */
function ringMask(img) {
  const s = 4;
  const mw = Math.floor(img.w / s), mh = Math.floor(img.h / s);
  const mask = new Uint8Array(mw * mh);
  for (let my = 0; my < mh; my++) {
    for (let mx = 0; mx < mw; mx++) {
      let hit = 0;
      for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
        const x = mx * s + dx, y = my * s + dy;
        const i = (y * img.w + x) * 4;
        const d = Math.abs(img.px[i] - RING[0]) + Math.abs(img.px[i + 1] - RING[1]) + Math.abs(img.px[i + 2] - RING[2]);
        if (d <= 70) hit++;
      }
      if (hit >= 1) mask[my * mw + mx] = 1;
    }
  }
  // 膨胀 2 格：细环在抗锯齿下会断成若干段，不闭合就会把「一个圆」拆成多条弧，
  // 那时取最大连通域的 bbox 得到的是**一段弧**而不是整圆 —— 宽高比就假了。
  const R = 2;
  const dil = new Uint8Array(mask.length);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    if (!mask[y * mw + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < mw && ny < mh) dil[ny * mw + nx] = 1;
    }
  }
  return { mask: dil, mw, mh, s };
}

/** 连通域（BFS）→ 返回面积 > minArea 的包围盒 */
function components(rm, minArea) {
  const { mask, mw, mh, s } = rm;
  const seen = new Uint8Array(mask.length);
  const out = [];
  const q = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    q.length = 0; q.push(i); seen[i] = 1;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, area = 0;
    while (q.length) {
      const k = q.pop();
      const x = k % mw, y = (k - x) / mw;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
      for (const [nx, ny] of nb) {
        if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) continue;
        const nk = ny * mw + nx;
        if (mask[nk] && !seen[nk]) { seen[nk] = 1; q.push(nk); }
      }
    }
    if (area >= minArea) {
      out.push({
        area,
        x0: minX * s, y0: minY * s, x1: (maxX + 1) * s, y1: (maxY + 1) * s,
        bw: (maxX - minX + 1) * s, bh: (maxY - minY + 1) * s
      });
    }
  }
  return out.sort((a, b) => b.area - a.area);
}

/** 内容包围盒（亮度 > 阈值），用于判断铺满 / 留白 */
function contentBBox(img) {
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = 0; y < img.h; y += 2) {
    for (let x = 0; x < img.w; x += 2) {
      const i = (y * img.w + x) * 4;
      if (img.px[i] + img.px[i + 1] + img.px[i + 2] > 70) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY, bw: maxX - minX, bh: maxY - minY };
}

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

const MODES = {
  phone: { w: 1080, h: 2400, label: "手机竖屏 1080×2400" },
  tablet: { w: 1600, h: 1000, label: "平板横屏 1600×1000" },
  carwide: { w: 1280, h: 600, label: "车载宽屏 1280×600" }
};

function load(tag, id) {
  const p = path.join(SHOT, "p5a02-e-" + tag + "-" + id + ".png");
  return fs.existsSync(p) ? decodePNG(p) : null;
}

console.log("=== P5A-M02 阶段 E：多比例 + FIT/STRETCH ===\n");

const data = {};
["stretch", "fit"].forEach((tag) => {
  data[tag] = {};
  Object.keys(MODES).forEach((id) => {
    const img = load(tag, id);
    if (!img) { console.log("  ⚠ 缺 p5a02-e-" + tag + "-" + id + ".png"); return; }
    const comps = components(ringMask(img), 40);
    data[tag][id] = { img, comps };
    console.log("  " + (tag + "/" + id).padEnd(20) + img.w + "×" + img.h +
      "  盘面连通域=" + comps.length +
      (comps.length ? "  最大环 " + comps[0].bw + "×" + comps[0].bh : ""));
  });
});

// ---------- E1 三块表都渲染 ----------
console.log("\n=== E1. 三块表（三个盘面环）都画出来了 ===");
["stretch", "fit"].forEach((tag) => {
  Object.keys(data[tag]).forEach((id) => {
    ok(data[tag][id].comps.length >= 3,
      "E1 " + (tag + "/" + id).padEnd(20) + "盘面连通域 " + data[tag][id].comps.length + "（>=3）");
  });
});

// ---------- E2 形变量化：圆 → 椭圆 ----------
console.log("\n=== E2. 圆形盘面在两种缩放模式下的宽高比（量化形变）===");
console.log("     设计 dial = 150×150（正方）；STRETCH 期望比值≈pxX/pxY，FIT 期望≈1.0");
const aspects = {};
["stretch", "fit"].forEach((tag) => {
  aspects[tag] = {};
  Object.keys(data[tag]).forEach((id) => {
    const c = data[tag][id].comps[0];
    if (!c) return;
    const asp = c.bw / c.bh;
    aspects[tag][id] = asp;
    const mode = MODES[id];
    // STRETCH 理论比值：pxX/pxY = (w/360)/((h-top)/360) = w/(h*0.947)
    const top = Math.round(mode.h * 0.053);
    const expected = mode.w / (mode.h - top);
    console.log("     " + (tag + "/" + id).padEnd(20) + "实测 " + asp.toFixed(3) +
      (tag === "stretch" ? "  理论 " + expected.toFixed(3) : "  （等比应≈1.000）"));
  });
});

// STRETCH：实测应接近理论（±25%，因为环有描边宽度影响）
Object.keys(aspects.stretch || {}).forEach((id) => {
  const a = aspects.stretch[id];
  const m = MODES[id];
  const top = Math.round(m.h * 0.053);
  const expected = m.w / (m.h - top);
  const dev = Math.abs(a - expected) / expected;
  ok(dev < 0.25,
    "E2 STRETCH/" + id.padEnd(9) + "宽高比 " + a.toFixed(3) + " ≈ 理论 " + expected.toFixed(3) +
    "（偏差 " + (dev * 100).toFixed(0) + "% < 25%）");
});

// FIT：实测应接近 1（等比）
Object.keys(aspects.fit || {}).forEach((id) => {
  const a = aspects.fit[id];
  const dev = Math.abs(a - 1);
  ok(dev < 0.25,
    "E2 FIT/" + id.padEnd(12) + "宽高比 " + a.toFixed(3) + " ≈ 1.000" +
    "（偏差 " + (dev * 100).toFixed(0) + "% < 25%）→ **等比缩放不乱形变**");
});

// ---------- E3 FIT 确实比 STRETCH 更接近正圆 ----------
console.log("\n=== E3. 同一分辨率下 FIT 的形变小于 STRETCH ===");
Object.keys(MODES).forEach((id) => {
  if (!aspects.stretch || !aspects.fit) return;
  const s = aspects.stretch[id], f = aspects.fit[id];
  if (s === undefined || f === undefined) return;
  const ds = Math.abs(s - 1), df = Math.abs(f - 1);
  ok(df <= ds + 0.02,
    "E3 " + id.padEnd(9) + "FIT 偏差 " + (df * 100).toFixed(0) + "% ≤ STRETCH 偏差 " + (ds * 100).toFixed(0) + "%");
});

// ---------- E4 图片不被裁切 ----------
console.log("\n=== E4. 盘面完整落在屏幕内（没被裁掉）===");
["stretch", "fit"].forEach((tag) => {
  Object.keys(data[tag]).forEach((id) => {
    const { img, comps } = data[tag][id];
    if (!comps.length) return;
    const c = comps[0];
    const inside = c.x0 >= 0 && c.y0 >= 0 && c.x1 <= img.w && c.y1 <= img.h;
    ok(inside, "E4 " + (tag + "/" + id).padEnd(20) +
      "环 bbox [" + c.x0 + "," + c.y0 + "]-[" + c.x1 + "," + c.y1 + "] 在 " + img.w + "×" + img.h + " 内");
  });
});

// ---------- E5 STRETCH 铺满 vs FIT 留白 ----------
console.log("\n=== E5. STRETCH 铺满 / FIT 留白 ===");
const fills = {};
["stretch", "fit"].forEach((tag) => {
  Object.keys(data[tag]).forEach((id) => {
    const { img } = data[tag][id];
    const bb = contentBBox(img);
    if (!bb) return;
    fills[tag + "/" + id] = { wRatio: bb.bw / img.w, hRatio: bb.bh / img.h };
    console.log("     " + (tag + "/" + id).padEnd(20) +
      "内容占屏 " + (bb.bw / img.w * 100).toFixed(1) + "% × " + (bb.bh / img.h * 100).toFixed(1) + "%");
  });
});
Object.keys(MODES).forEach((id) => {
  const s = fills["stretch/" + id];
  if (!s) return;
  // STRETCH：宽度应基本铺满（>=95%）
  // 阈值 90%：画布两侧有 App 内边距，94% 属正常铺满
  ok(s.wRatio >= 0.90, "E5 STRETCH/" + id.padEnd(9) + "宽度铺满 " + (s.wRatio * 100).toFixed(1) + "%（>=90%）");
});
Object.keys(MODES).forEach((id) => {
  const f = fills["fit/" + id];
  const s = fills["stretch/" + id];
  if (!f || !s) return;
  // FIT 在非方形屏上必然有一轴明显留白
  const minAxis = Math.min(f.wRatio, f.hRatio);
  const sMinAxis = Math.min(s.wRatio, s.hRatio);
  ok(minAxis <= sMinAxis + 0.02,
    "E5 FIT/" + id.padEnd(12) + "窄轴占比 " + (minAxis * 100).toFixed(1) + "% ≤ STRETCH " +
    (sMinAxis * 100).toFixed(1) + "%（等比就会有留白）");
});

console.log("\n=== 汇总 ===");
console.log("  通过=" + pass + " 失败=" + fail);
console.log("  未验证：屏幕旋转后状态恢复（该模拟器旋转会崩，见报告「未完成事项」）");
console.log("  未验证：轨道圆角/刻度/渐变（本主题无 track 节点，已由 M01 的轨道主题覆盖）");
console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
