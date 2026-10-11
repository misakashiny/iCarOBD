/* ==========================================================================
   png.js —— 极简 PNG 编码器 + 绘图原语
   --------------------------------------------------------------------------
   为什么要自己写：本机没有 canvas / sharp / PIL，而示例素材必须是**真的 PNG**
   （SVG 浏览器能显示，但 Android 的 ImageView 不认）。

   PNG 的结构其实很简单，zlib 是 Node 内置的，所以只差一个 CRC32 和几个
   绘图原语。整个文件不依赖任何第三方包。

   ## 抗锯齿靠**超采样**
   以 4 倍分辨率绘制再降采样 —— 比逐像素算覆盖率简单得多，效果也够好。
   ========================================================================== */
"use strict";

const zlib = require("zlib");

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/**
 * RGBA 缓冲 → PNG。
 * @param w,h 尺寸
 * @param rgba 长度 w*h*4 的 Buffer（RGBA，非预乘）
 */
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // color type: RGBA
  ihdr[10] = 0;     // compression
  ihdr[11] = 0;     // filter
  ihdr[12] = 0;     // interlace
  // 每行前面加一个 filter 字节（0 = None）
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- 颜色

/**
 * `#RRGGBB` 或 `[r,g,b]` 或 `[r,g,b,a]` → [r,g,b,a]
 *
 * ⚠️ **alpha 的单位是 0..255**（不是 0..1）。v2.87.0 起这里会把越界值**夹住**：
 * 以前 `[0,0,0,267]` 这种会一路传进 `_blend`，`sa = 267/255 = 1.047 > 1` ——
 * source-over 的 `sa + da*(1-sa)` 于是变成**减色**（越描越黑）。
 * 夹到 255 是唯一合理语义："比不透明更不透明"不存在。
 */
function color(c) {
  if (Array.isArray(c)) return [c[0], c[1], c[2], clampAlpha(c.length > 3 ? c[3] : 255)];
  if (typeof c === "string" && c[0] === "#") {
    const h = c.slice(1);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 255];
  }
  return [255, 255, 255, 255];
}

/** alpha 夹到 0..255（见 `color()` 的说明） */
function clampAlpha(a) {
  return a < 0 ? 0 : (a > 255 ? 255 : a);
}

/** 线性插值两个颜色 */
function mix(a, b, t) {
  const A = color(a), B = color(b);
  return [
    Math.round(A[0] + (B[0] - A[0]) * t),
    Math.round(A[1] + (B[1] - A[1]) * t),
    Math.round(A[2] + (B[2] - A[2]) * t),
    Math.round(A[3] + (B[3] - A[3]) * t),
  ];
}

// ---------------------------------------------------------------- 画布

const SS = 4;   // 超采样倍数

/**
 * 画布。**所有坐标都用逻辑像素**（超采样在内部处理）。
 *
 * 混合用标准的 source-over（非预乘），alpha 直接存 RGBA。
 */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.W = w * SS;
    this.H = h * SS;
    this.buf = Buffer.alloc(this.W * this.H * 4, 0);
  }

  /** 在**超采样**坐标系里混一个像素 */
  _blend(x, y, rgba, a) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return;
    const i = (y * this.W + x) * 4;
    const sa = (rgba[3] / 255) * a;
    if (sa <= 0) return;
    const da = this.buf[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let c = 0; c < 3; c++) {
      const sc = rgba[c], dc = this.buf[i + c];
      this.buf[i + c] = Math.round((sc * sa + dc * da * (1 - sa)) / oa);
    }
    this.buf[i + 3] = Math.round(oa * 255);
  }

  /**
   * 逻辑坐标画一个矩形。
   *
   * ⚠️ **负宽高会被归一化**（v2.87.0 修）。原来是
   * `for (py = y0; py < y1; py++)` —— 负高直接**空转**，
   * 一声不响地什么都不画。实测代价：`gen-assets-more.js` 的四个角标里
   * 三个传了负宽高，**只有 `corner-br` 因为"负负得正"画出来了**
   * （见 CHANGELOG v2.87.0「四个角标只亮一个」）。
   *
   * 归一化而不是抛错：`rect(x, y, -w, -h)` 的意图是显然的（从 (x,y) 往左上画），
   * 让它画出来比让它炸掉有用；而"静默空转"是**唯一不可接受的**那种。
   */
  rect(x, y, w, h, c, alpha) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const col = color(c);
    const a = (alpha === undefined ? 1 : alpha) * (col[3] / 255);
    const x0 = Math.round(x * SS), y0 = Math.round(y * SS);
    const x1 = Math.round((x + w) * SS), y1 = Math.round((y + h) * SS);
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this._blend(px, py, col, a);
  }

  /** 圆角矩形 */
  roundRect(x, y, w, h, r, c, alpha) {
    const rr = Math.min(r, w / 2, h / 2);
    this.rect(x + rr, y, w - rr * 2, h, c, alpha);
    this.rect(x, y + rr, w, h - rr * 2, c, alpha);
    [[x + rr, y + rr], [x + w - rr, y + rr], [x + rr, y + h - rr], [x + w - rr, y + h - rr]]
      .forEach(([cx, cy]) => this.circle(cx, cy, rr, c, alpha));
  }

  /** 实心圆 */
  circle(cx, cy, r, c, alpha) {
    const col = color(c);
    const a = (alpha === undefined ? 1 : alpha) * (col[3] / 255);
    const R = r * SS, CX = cx * SS, CY = cy * SS;
    const x0 = Math.max(0, Math.floor(CX - R)), x1 = Math.min(this.W - 1, Math.ceil(CX + R));
    const y0 = Math.max(0, Math.floor(CY - R)), y1 = Math.min(this.H - 1, Math.ceil(CY + R));
    const R2 = R * R;
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - CY;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - CX;
        if (dx * dx + dy * dy <= R2) this._blend(px, py, col, a);
      }
    }
  }

  /** 圆环（描边圆） */
  ring(cx, cy, r, thick, c, alpha) {
    const col = color(c);
    const a = (alpha === undefined ? 1 : alpha) * (col[3] / 255);
    const R = r * SS, T = thick * SS / 2, CX = cx * SS, CY = cy * SS;
    const rIn = R - T, rOut = R + T;
    const x0 = Math.max(0, Math.floor(CX - rOut)), x1 = Math.min(this.W - 1, Math.ceil(CX + rOut));
    const y0 = Math.max(0, Math.floor(CY - rOut)), y1 = Math.min(this.H - 1, Math.ceil(CY + rOut));
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - CY;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - CX;
        const d2 = dx * dx + dy * dy;
        if (d2 <= rOut * rOut && d2 >= rIn * rIn) this._blend(px, py, col, a);
      }
    }
  }

  /** 圆弧（角度制，0 = 正右，顺时针） */
  arc(cx, cy, r, thick, a0, a1, c, alpha) {
    const col = color(c);
    const al = (alpha === undefined ? 1 : alpha) * (col[3] / 255);
    const R = r * SS, T = Math.max(1, thick * SS / 2), CX = cx * SS, CY = cy * SS;
    const rIn = R - T, rOut = R + T;
    const steps = Math.max(24, Math.round(Math.abs(a1 - a0) * 1.2));
    for (let i = 0; i <= steps; i++) {
      const ang = (a0 + (a1 - a0) * i / steps) * Math.PI / 180;
      const px = CX + Math.cos(ang) * R, py = CY + Math.sin(ang) * R;
      this.circle(px / SS, py / SS, T / SS, col, al);
    }
  }

  /** 线段（圆头） */
  line(x0, y0, x1, y1, thick, c, alpha) {
    const col = color(c);
    const al = (alpha === undefined ? 1 : alpha) * (col[3] / 255);
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len * SS));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thick / 2, col, al);
    }
  }

  /** 多边形（实心）。pts = [[x,y], ...] */
  poly(pts, c, alpha) {
    const col = color(c);
    const a = (alpha === undefined ? 1 : alpha) * (col[3] / 255);
    const P = pts.map(([x, y]) => [x * SS, y * SS]);
    let minY = Infinity, maxY = -Infinity;
    P.forEach(([, y]) => { minY = Math.min(minY, y); maxY = Math.max(maxY, y); });
    minY = Math.max(0, Math.floor(minY));
    maxY = Math.min(this.H - 1, Math.ceil(maxY));
    for (let py = minY; py <= maxY; py++) {
      const yc = py + 0.5;
      const xs = [];
      for (let i = 0; i < P.length; i++) {
        const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          xs.push(ax + (yc - ay) / (by - ay) * (bx - ax));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.floor(xs[k])), x1 = Math.min(this.W - 1, Math.ceil(xs[k + 1]));
        for (let px = x0; px <= x1; px++) this._blend(px, py, col, a);
      }
    }
  }

  /**
   * 每个像素按回调决定颜色（做纹理/渐变用）。回调返回 `[r,g,b]` 或 `[r,g,b,a]`，
   * **alpha 的刻度是 0..255**。
   *
   * ## ⚠️ 一个必须知道的历史行为（v2.87.0 记下，未改）
   *
   * 这里把 `r[3]` **又 `/255` 当倍率**传给了 `_blend`，而 `_blend` 内部还会
   * `rgba[3]/255` 一次 —— 同一个 alpha **除了两遍**，于是有效不透明度是
   * `(a/255)²`：
   *
   *   - `a = 255` → `sa = 1` ✅ —— 所以"全不透明"的素材一直是好的，**问题被掩盖了**
   *   - `a = 1`（按 0..1 写）→ `sa ≈ 1.5e-5` → `Math.round` **归零** → **整张全透明**
   *   - `a = 128` → `sa = 0.25`（不是 0.5）
   *
   * 实测代价：`gen-assets-more.js` 有 6 处按 0..1 写 → 4 个素材 **0 个不透明像素**、
   * 2 个渐变轨道**丢了渐变层**（CHANGELOG v2.87.0）。调用点已全部改成 ×255。
   *
   * **为什么不在这里直接改成线性**（v2.88.0 **拍板：保持现状，不改**）：
   *
   * 改了会动到 `decor/underline.png` 的渐隐曲线（平方 → 线性），
   * 而那张图**不在"已证明是坏的"名单里** —— 更重要的是：**所有**走过 `fill()`
   * 的存量素材的不透明度会一起变（`(a/255)²` → `a/255`），
   * 那是"批量改素材内容"，代价远大于收益。
   *
   * 所以这是一个**已知怪癖 + 有守卫**的形态，不是待修的 bug：
   *   · **已知**：`fill()` 的有效不透明度 = `(a/255)²`，写 128 出来是 64；
   *   · **有守卫 ①**：整层最大 alpha < 2 时**大声警告**（见下）——
   *     拦的是"按 0..1 写 → 整张全透明"这个真会出事的形态；
   *   · **有守卫 ②**：`tests/verify-asset-gen.js` 把"生成器跑起来不许有这个警告"
   *     和"`fillAlpha(128)` 必须等于 64"都钉成了断言 ——
   *     谁哪天把这里改成线性，**那条断言会红**，提醒他"underline.png 等
   *     存量素材要一起处理"。
   *
   * 要做那件事得单独拍板（CHANGELOG v2.88.0 有记录）。
   *
   * **但下一次不会再有"静默归零"**：这一层里**最不透明的像素**都不到 2/255 时，
   * 这里会**大声警告**（整层几乎全透明 = 几乎只可能是按 0..1 写了）——
   * `tests/verify-asset-gen.js` 把"生成器跑起来不许有这个警告"钉成了断言。
   *
   * ⚠️ 判据用"整层最大 alpha"而不是"某个像素 < 1"：渐变**合法地**会淡到接近 0
   * （`divider-gradient` 的最后一列 alpha ≈ 0.99），逐像素判会误报。
   */
  fill(fn) {
    let maxA = -1;
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        const r = fn(x / SS, y / SS);
        if (!r) continue;
        const a = r.length > 3 ? r[3] : 255;
        if (a > maxA) maxA = a;
        this._blend(x, y, color(r), a / 255);
      }
    }
    if (maxA >= 0 && maxA < 2) {
      console.warn('⚠️ png.js fill(): 这一层最不透明的像素 alpha 只有 ' + maxA +
        ' —— 整层几乎全透明。alpha 的单位是 **0..255**（0..1 的写法会渲染成整张全透明）。见 CHANGELOG v2.87.0');
    }
  }

  /** 降采样到逻辑尺寸并编码 */
  toPng() {
    const out = Buffer.alloc(this.w * this.h * 4);
    const n = SS * SS;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * this.W + (x * SS + sx)) * 4;
            const pa = this.buf[i + 3] / 255;
            // 按 alpha 加权求平均（避免边缘发黑）
            r += this.buf[i] * pa; g += this.buf[i + 1] * pa; b += this.buf[i + 2] * pa;
            a += pa;
          }
        }
        const o = (y * this.w + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
          out[o + 3] = Math.round(a / n * 255);
        }
      }
    }
    return encodePng(this.w, this.h, out);
  }
}


// ============================================================================
// 5×7 点阵字库（v2.23.0）
//
// ## 为什么需要它
//
// 刻度盘上的数字（0/1/2…）**只能用图片画** —— png.js 原本不能绘制文字，
// 于是"数字刻度"这类素材做不出来，只能画短横线代替。
//
// ## 为什么是 5×7
//
// 车机仪表上的刻度数字很小（通常 8~14px 高）。5×7 是能同时容纳
// **数字 + 常用大写字母**的最小尺寸，而且笔画粗（整像素），缩到 8px 仍然认得出。
//
// 更大的字（比如 8×12）在小尺寸下反而糊 —— 笔画细、抗锯齿后发灰。
//
// ## 编码
//
// 每个字形 7 行，每行 5 位，用 5 个字符 '.'/'#' 表示（可读，便于手改）。
// 行序从上到下；列序从左到右。
// ============================================================================

const FONT_5x7 = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "/": ["....#", "...#.", "...#.", "..#..", ".#...", ".#...", "#...."],
  "%": ["##..#", "##.#.", "..#..", ".#...", "#..##", "..#.#", ".#..#"],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "°": ["##...", "#.#..", "##...", ".....", ".....", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  // ⚠️ **Z 曾经被我删掉过**（v2.34.0 修）：加小写时的替换锚点就是 `Z: [...]` 那一行，
  // 而它以 `};` 结尾 —— 替换整个锚点等于把 Z 一起删了。
  // 影响：任何含 Z 的文字（比如 "Hz"）渲染成空格，而且**不会报错**。
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],

  // ---- 小写（v2.27.0）。5×7 里小写很难做，所以这是**简化形**：
  // 笔画对齐到同一基线，只保留可辨认的核心特征（比如 a 上有个小突起）。
  // 不追求字形漂亮，追求"缩到 8px 还认得出"。
  a: [".....", ".....", ".###.", "....#", ".####", "#...#", ".####"],
  b: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "####."],
  c: [".....", ".....", ".###.", "#....", "#....", "#....", ".###."],
  d: ["....#", "....#", ".####", "#...#", "#...#", "#...#", ".####"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
  f: ["..##.", ".#...", "####.", ".#...", ".#...", ".#...", ".#..."],
  g: [".....", ".####", "#...#", "#...#", ".####", "....#", ".###."],
  h: ["#....", "#....", "####.", "#...#", "#...#", "#...#", "#...#"],
  i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
  j: ["...#.", ".....", "..##.", "...#.", "...#.", "#..#.", ".##.."],
  k: ["#....", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  l: [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#...#", "#...#"],
  n: [".....", ".....", "####.", "#...#", "#...#", "#...#", "#...#"],
  o: [".....", ".....", ".###.", "#...#", "#...#", "#...#", ".###."],
  p: [".....", "####.", "#...#", "#...#", "####.", "#....", "#...."],
  q: [".....", ".####", "#...#", "#...#", ".####", "....#", "....#"],
  r: [".....", ".....", "#.##.", "##..#", "#....", "#....", "#...."],
  s: [".....", ".....", ".####", "#....", ".###.", "....#", "####."],
  t: [".#...", ".#...", "####.", ".#...", ".#...", ".#..#", "..##."],
  u: [".....", ".....", "#...#", "#...#", "#...#", "#..##", ".##.#"],
  v: [".....", ".....", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  w: [".....", ".....", "#...#", "#...#", "#.#.#", "##.##", "#...#"],
  x: [".....", ".....", "#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  y: [".....", "#...#", "#...#", "#...#", ".####", "....#", ".###."],
  z: [".....", ".....", "#####", "...#.", "..#..", ".#...", "#####"],
};

/** 字形的像素宽/高（含 1px 字距由调用方决定） */
const GLYPH_W = 5, GLYPH_H = 7;

/**
 * 给 Canvas 加**文字绘制**。
 *
 * @param x,y   左上角（不是基线 —— 点阵字体没有基线概念，用左上角更直观）
 * @param text  要画的字符串（不认识的字符画成空格，不报错）
 * @param c     颜色
 * @param scale 整数放大倍数。**必须是整数** —— 非整数会让点阵糊掉，
 *              那就失去了点阵字体的意义（要模糊的用系统字体去）
 * @param gap   字距（像素，未乘 scale）
 */
function drawText(canvas, x, y, text, c, scale, gap) {
  const s = Math.max(1, Math.round(scale || 1));
  const g = gap === undefined ? 1 : gap;
  let cx = x;
  for (const ch of String(text)) {
    const gl = FONT_5x7[ch] || FONT_5x7[ch.toUpperCase()] || FONT_5x7[" "];
    for (let r = 0; r < GLYPH_H; r++) {
      const row = gl[r];
      for (let q = 0; q < GLYPH_W; q++) {
        if (row[q] === "#") {
          canvas.rect(cx + q * s, y + r * s, s, s, c);
        }
      }
    }
    cx += (GLYPH_W + g) * s;
  }
  return cx - x;   // 返回绘制宽度，便于居中
}

/** 一段文字按给定 scale 的像素宽度 */
function textWidth(text, scale, gap) {
  const s = Math.max(1, Math.round(scale || 1));
  const g = gap === undefined ? 1 : gap;
  const n = String(text).length;
  return n > 0 ? (n * (GLYPH_W + g) - g) * s : 0;
}

module.exports = { Canvas, encodePng, color, mix, FONT_5x7, GLYPH_W, GLYPH_H, drawText, textWidth };
