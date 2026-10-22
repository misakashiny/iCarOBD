// ============================================================================
// verify-p5a02-state-lamps.js —— P5A-M02 阶段 C：状态灯三态动态联调
//
// ## 判定口径（为什么不是"看状态变量"）
//
// 任务明确要求：**不能仅检查 JVM 层状态变量就宣布图片已经切换**。
// 所以这里直接解码模拟器截图，按**设计坐标**采样每个灯的区域，
// 用「主色」判断它画的是哪张图：
//
//   normal  素材 = 绿(#22C55E)  → G 明显高于 R
//   warn    素材 = 黄(#F59E0B)  → R 与 G 都高、B 低
//   critical素材 = 红(#EF4444)  → R 高、G 低
//   未知态（--）= 不画素材，画一个「--」文字 → 区域几乎无饱和色
//
// 三种主色在色相上分得很开，所以「主色判定」比逐个像素比更抗抗锯齿。
//
// ## 覆盖
//   C1 normal 场景            三态灯应显示 normal
//   C2 alarm(warn) 场景       跨过 warnHigh 的灯应变 warn
//   C3 critical 场景          应跨到 critical
//   C4 disconnect 场景        全部绑 PID 的灯应进入未知态
//   C5 recover 场景           应回到 normal
//   C6 低值报警灯（缺口）     电压 warnLow=11.8 越界但状态灯只判高值 → **不变**
//   C7 PID 不存在             永远未知态
//
// ⚠️ 与既有语义对齐：阈值来自 `NodeStateResolver.select`，不自行编造。
// ============================================================================
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

// ---------------------------------------------------------------- PNG 解码

function decodePNG(p) {
  const b = fs.readFileSync(p);
  let pos = 8, w = 0, h = 0;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const ty = b.toString("ascii", pos + 4, pos + 8);
    if (ty === "IHDR") { w = b.readUInt32BE(pos + 8); h = b.readUInt32BE(pos + 12); }
    if (ty === "IDAT") idat.push(b.slice(pos + 8, pos + 8 + len));
    if (ty === "IEND") break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  let rp = 0;
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
      else {
        const p2 = a + bb - c, pa = Math.abs(p2 - a), pb = Math.abs(p2 - bb), pc = Math.abs(p2 - c);
        v = cur + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c));
      }
      out[y * stride + x] = v & 255;
    }
    rp += stride;
  }
  return { w, h, px: out };
}

// ---------------------------------------------------------------- 几何映射
//
// 设计坐标 0..360 覆盖「画布区」：整屏宽 + 从顶栏下沿到底部。
// 顶栏比例与 M01 阶段 D 的 mapper 保持一致（H*0.053）。
const CANVAS_TOP_RATIO = 0.053;
function mapper(img) {
  const top = Math.round(img.h * CANVAS_TOP_RATIO);
  return (dx, dy) => [dx / 360 * img.w, top + dy / 360 * (img.h - top)];
}

// 主题中的元素（与 state-lamps/src/design.json 一致）
const ELEM = {
  g_speed:   { x: 130, y: 10,  w: 100, h: 80 },
  l_coolant: { x: 20,  y: 110, w: 70,  h: 60 },
  l_speed:   { x: 145, y: 110, w: 70,  h: 60 },
  l_volt_low:{ x: 270, y: 110, w: 70,  h: 60 },
  l_nopid:   { x: 20,  y: 190, w: 70,  h: 60 },
  l_rpm:     { x: 145, y: 190, w: 70,  h: 60 },
  l_load:    { x: 270, y: 190, w: 70,  h: 60 }
};

/** 采样区域的平均 RGB + 主色分类 */
function sample(img, e) {
  const mp = mapper(img);
  const [x0, y0] = mp(e.x, e.y);
  const [x1, y1] = mp(e.x + e.w, e.y + e.h);
  let n = 0, sr = 0, sg = 0, sb = 0;
  // 缩进 12% 避开边缘抗锯齿
  const dx = (x1 - x0) * 0.12, dy = (y1 - y0) * 0.12;
  for (let y = Math.ceil(y0 + dy); y < Math.floor(y1 - dy); y += 2) {
    for (let x = Math.ceil(x0 + dx); x < Math.floor(x1 - dx); x += 2) {
      if (y < 0 || y >= img.h || x < 0 || x >= img.w) continue;
      const i = (y * img.w + x) * 4;
      sr += img.px[i]; sg += img.px[i + 1]; sb += img.px[i + 2];
      n++;
    }
  }
  if (!n) return null;
  return { r: sr / n, g: sg / n, b: sb / n, n };
}

/**
 * 按平均色判「画的是哪张图」。
 *
 * 三张合成图的实测均色（截图采样值）：
 *   normal   88,212,133   R<G，绿占优
 *   warn    247,180,67    R 最大，但 G 也高 → **G/R ≈ 0.73**
 *   critical243,114,114   R 最大，G 低   → **G/R ≈ 0.47**
 *
 * ⚠️ 第一版只判「R 明显大于 G/B」就把黄也算成红了 —— 黄的红分量本来就最大。
 *    真正区分黄/红的是**绿分量占红分量的比例**：黄 ≈0.73、红 ≈0.47，
 *    取 0.60 为界。
 */
function classify(s) {
  if (!s) return "none";
  const { r, g, b } = s;
  const maxv = Math.max(r, g, b), minv = Math.min(r, g, b);
  const sat = maxv === 0 ? 0 : (maxv - minv) / maxv;
  // 暗淡/无饱和 → 未知态（--）或空白
  if (maxv < 60 || sat < 0.18) return "unknown";
  if (g >= r && g >= b) return "normal";            // 绿占优
  if (r >= g && r >= b) {
    const gr = r > 0 ? g / r : 0;
    return gr >= 0.60 ? "warn" : "critical";        // 黄 vs 红
  }
  return "other";
}

// ---------------------------------------------------------------- 断言框架

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

const FILES = {
  normal: "p5a02-lamp-normal.png",
  warn: "p5a02-lamp-warn.png",
  critical: "p5a02-lamp-critical.png",
  disconnect: "p5a02-lamp-disconnect.png",
  recover: "p5a02-lamp-recover.png"
};

console.log("=== P5A-M02 阶段 C：状态灯三态动态联调 ===\n");

const imgs = {}, states = {};
Object.keys(FILES).forEach((k) => {
  const p = path.join(SHOT, FILES[k]);
  if (!fs.existsSync(p)) { console.log("  ⚠ 缺截图 " + FILES[k]); return; }
  imgs[k] = decodePNG(p);
  states[k] = {};
  Object.keys(ELEM).forEach((id) => { states[k][id] = classify(sample(imgs[k], ELEM[id])); });
  console.log("  " + k.padEnd(11) + imgs[k].w + "×" + imgs[k].h + "  " + FILES[k]);
});

if (!imgs.normal) { console.log("\nFATAL 缺 normal 截图"); process.exit(1); }

// ---- 打印分类矩阵（证据，便于人工复核）
console.log("\n=== 主色判定矩阵（证据）===");
const ids = Object.keys(ELEM);
console.log("  " + "元素".padEnd(12) + Object.keys(imgs).map((k) => k.padEnd(11)).join(""));
ids.forEach((id) => {
  const row = Object.keys(imgs).map((k) => (states[k][id] || "-").padEnd(11)).join("");
  console.log("  " + id.padEnd(12) + row);
});

// ---- 采样均值（诊断用，失败时要能看出"其实画了什么色"）
console.log("\n=== 各场景采样均色（R,G,B）===");
Object.keys(imgs).forEach((k) => {
  const cells = ids.map((id) => {
    const s = sample(imgs[k], ELEM[id]);
    return id + "=" + (s ? Math.round(s.r) + "," + Math.round(s.g) + "," + Math.round(s.b) : "-");
  });
  console.log("  " + k.padEnd(11) + cells.join("  "));
});

// ============================================================ C1
console.log("\n=== C1. normal 场景：三态灯显示 normal（绿）===");
["l_coolant", "l_speed", "l_rpm", "l_load"].forEach((id) => {
  ok(states.normal[id] === "normal", "C1 " + id.padEnd(10) + " = " + states.normal[id] + "（期望 normal）");
});

// ============================================================ C2
console.log("\n=== C2. alarm（warn 档）：跨 warnHigh 的灯变 warn（黄）===");
["l_coolant", "l_speed", "l_rpm"].forEach((id) => {
  ok(states.warn[id] === "warn", "C2 " + id.padEnd(10) + " = " + states.warn[id] + "（期望 warn）");
});
// 负荷 95 < max 100 但 warnHigh 不存在 → 应保持 normal
ok(states.warn.l_load === "normal",
  "C2 l_load（无 warnHigh）= " + states.warn.l_load + "（期望仍为 normal）");

// ============================================================ C3
console.log("\n=== C3. critical 场景：跨 critical 阈值的灯变 critical（红）===");
["l_coolant", "l_speed", "l_rpm"].forEach((id) => {
  ok(states.critical[id] === "critical", "C3 " + id.padEnd(10) + " = " + states.critical[id] + "（期望 critical）");
});

// ============================================================ C4
console.log("\n=== C4. disconnect 场景：绑 PID 的灯进入未知态（不画素材）===");
["l_coolant", "l_speed", "l_rpm", "l_load"].forEach((id) => {
  ok(states.disconnect[id] === "unknown",
    "C4 " + id.padEnd(10) + " = " + states.disconnect[id] + "（期望 unknown）");
});

// ============================================================ C5
console.log("\n=== C5. recover 场景：回到 normal ===");
["l_coolant", "l_speed", "l_rpm", "l_load"].forEach((id) => {
  ok(states.recover[id] === "normal", "C5 " + id.padEnd(10) + " = " + states.recover[id] + "（期望 normal）");
});

// ============================================================ C6（缺口）
console.log("\n=== C6. 低值报警灯（既有缺口，如实记录）===");
console.log("     电压 warnLow=11.8：alarm 场景值 11.03 已低于阈值");
console.log("     但 NodeStateResolver.select 只判 `value >= warnAt`（高值），不判低值");
ok(states.warn.l_volt_low === "normal",
  "C6 l_volt_low = " + states.warn.l_volt_low +
  "（**预期不变**：低值报警未被支持，登记为缺口）");

// ============================================================ C7
console.log("\n=== C7. PID 不存在的灯：始终未知态 ===");
Object.keys(imgs).forEach((k) => {
  ok(states[k].l_nopid === "unknown",
    "C7 [" + k.padEnd(10) + "] l_nopid = " + states[k].l_nopid + "（期望 unknown）");
});

// ============================================================ C8
console.log("\n=== C8. 同屏参考仪表确实在动（证明不是整体静止）===");
function regionDiff(a, b, e) {
  const A = imgs[a], B = imgs[b];
  if (!A || !B) return 0;
  const mp = mapper(A);
  const [x0, y0] = mp(e.x, e.y), [x1, y1] = mp(e.x + e.w, e.y + e.h);
  let n = 0, diff = 0;
  for (let y = Math.ceil(y0); y < Math.min(A.h, Math.floor(y1)); y += 2) {
    for (let x = Math.ceil(x0); x < Math.min(A.w, Math.floor(x1)); x += 2) {
      const i = (y * A.w + x) * 4;
      const d = Math.abs(A.px[i] - B.px[i]) + Math.abs(A.px[i + 1] - B.px[i + 1]) + Math.abs(A.px[i + 2] - B.px[i + 2]);
      n++; if (d > 18) diff++;
    }
  }
  return n ? diff / n : 0;
}
const gDiff = regionDiff("normal", "critical", ELEM.g_speed);
ok(gDiff > 0.01, "C8 参考仪表 normal↔critical 差异 " + (gDiff * 100).toFixed(1) + "%（>1% 说明画布在响应）");

// ============================================================ C9
console.log("\n=== C9. 六灯在同场景内不是同一张图（多灯独立更新）===");
// critical 场景下：三个高值灯红，l_load 仍 normal 绿，l_volt_low 仍 normal 绿 → 至少两种主色
const critStates = new Set([states.critical.l_coolant, states.critical.l_speed, states.critical.l_rpm,
  states.critical.l_load, states.critical.l_volt_low]);
ok(critStates.size >= 2,
  "C9 critical 场景存在 " + critStates.size + " 种灯色（" + [...critStates].join("/") + "）→ 多灯独立");

console.log("\n=== 汇总 ===");
console.log("  通过=" + pass + " 失败=" + fail);
console.log("  本套件证明：不同 PID 值的灯在模拟器上**真的换图**（像素证据）");
console.log("  已知缺口：低值报警（warnLow）未支持 —— 见 C6，登记技术债");
console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
