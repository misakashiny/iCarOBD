/* ==========================================================================
   gen-assets.js —— 生成示例素材
   --------------------------------------------------------------------------
   跑法：node tools/icarui/gen-assets.js

   产出：
     assets/<分类>/*.png     真的 PNG（用 png.js 自己编码）
     assets/builtin.js       **素材清单**（经典脚本，不是 JSON）

   ## 为什么清单是 .js 而不是 .json
   工具跑在 `file://` 下，`fetch` / `XHR` 被 CORS 挡住（已实测），
   所以读不了 .json。而**经典 `<script src>` 可以** —— 所以清单写成
   `window.BUILTIN_ASSETS = [...]` 这种形式。

   ## 为什么自己做素材而不是放第三方
   车标、仪表盘素材绝大多数不是自由许可。这里全部是**几何图形**：
   圆环、刻度、指针、简单图标 —— 谁都能用，也不涉及版权。
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const { Canvas } = require("./png.js");

const ROOT = __dirname;
const ASSETS = path.join(ROOT, "assets");

// ---------------------------------------------------------------- 配色（与工具/主题同调）

const CYAN = "#00D8FF";
const CYAN_DIM = "#0A7E9E";
const AMBER = "#FFB020";
const RED = "#FF4D4F";
const GREEN = "#39D98A";
const GREY = "#5F6E85";
const GREY_DARK = "#2A3547";
const GREY_MID = "#3A4A5E";
const WHITE = "#FFFFFF";
const INK = "#05070A";

const manifest = [];

/** 写一份素材 + 记进清单 */
function save(kind, name, canvas, note) {
  const dir = path.join(ASSETS, kind);
  fs.mkdirSync(dir, { recursive: true });
  const file = name + ".png";
  const png = canvas.toPng();
  fs.writeFileSync(path.join(dir, file), png);
  manifest.push({
    name: name,
    label: note || name,
    kind: kind,
    // **设计文件里写的**是相对路径（App 靠它找文件）
    path: "assets/" + kind + "/" + file,
    // **工具预览用的**是内嵌 data URL。
    //
    // ⚠️ 为什么必须内嵌：`file://` 下按 path 加载的图会**污染画布**
    // （Chrome 把每个本地文件当独立源），于是 `getImageData` / `toDataURL`
    // 全部抛 SecurityError —— **「导出 PNG」直接坏掉**。
    // data URL 是同源的，不污染。
    data: "data:image/png;base64," + png.toString("base64"),
    w: canvas.w,
    h: canvas.h,
  });
}

// ================================================================ 背景

function genBackgrounds() {
  // 碳纤维：斜向编织
  {
    const c = new Canvas(256, 256);
    c.fill(() => [10, 13, 18, 255]);
    const cell = 8;
    for (let y = 0; y < 256; y += cell) {
      for (let x = 0; x < 256; x += cell) {
        const odd = ((x / cell) + (y / cell)) % 2 === 0;
        c.rect(x, y, cell, cell, odd ? "#161C26" : "#1B2230");
        // 斜向高光
        c.line(x, y + cell, x + cell, y, 1.2, odd ? "#232C3A" : "#2A3546", 0.9);
      }
    }
    save("background", "carbon", c, "碳纤维");
  }

  // 细网格
  {
    const c = new Canvas(128, 128);
    c.fill(() => [8, 11, 15, 255]);
    for (let i = 0; i <= 128; i += 16) {
      c.rect(i, 0, 1, 128, "#1B2430");
      c.rect(0, i, 128, 1, "#1B2430");
    }
    for (let i = 0; i <= 128; i += 64) {
      c.rect(i, 0, 1, 128, "#26313F");
      c.rect(0, i, 128, 1, "#26313F");
    }
    save("background", "grid", c, "细网格");
  }

  // 六边形
  {
    const c = new Canvas(256, 256);
    c.fill(() => [10, 13, 19, 255]);
    const R = 22, dx = R * 1.5, dy = R * Math.sqrt(3);
    for (let col = -1; col * dx < 256 + R; col++) {
      for (let row = -1; row * dy < 256 + R; row++) {
        const cx = col * dx;
        const cy = row * dy + (col % 2 ? dy / 2 : 0);
        const pts = [];
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 180 * (60 * k - 30);
          pts.push([cx + Math.cos(a) * (R - 1), cy + Math.sin(a) * (R - 1)]);
        }
        for (let k = 0; k < 6; k++) {
          const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % 6];
          c.line(x0, y0, x1, y1, 1.4, "#1E2836");
        }
      }
    }
    save("background", "hex", c, "六边形");
  }

  // 径向渐变
  {
    const c = new Canvas(256, 256);
    c.fill((x, y) => {
      const d = Math.hypot(x - 128, y - 128) / 128;
      const t = Math.min(1, d);
      return [
        Math.round(18 + (6 - 18) * t),
        Math.round(26 + (9 - 26) * t),
        Math.round(38 + (14 - 38) * t),
        255,
      ];
    });
    save("background", "gradient", c, "径向渐变");
  }

  // 横向渐变（做长条背景）
  {
    const c = new Canvas(256, 64);
    c.fill((x) => {
      const t = x / 256;
      return [
        Math.round(12 + 18 * Math.sin(t * Math.PI)),
        Math.round(17 + 24 * Math.sin(t * Math.PI)),
        Math.round(25 + 34 * Math.sin(t * Math.PI)),
        255,
      ];
    });
    save("background", "fade-bar", c, "渐变长条");
  }
}

// ================================================================ 仪表盘

function genDashboards() {
  // 细圆环
  {
    const c = new Canvas(256, 256);
    c.ring(128, 128, 116, 3, CYAN_DIM);
    c.ring(128, 128, 104, 1, GREY_DARK);
    save("dashboard", "ring-thin", c, "细圆环");
  }
  // 粗圆环
  {
    const c = new Canvas(256, 256);
    c.ring(128, 128, 112, 14, "#141A23");
    c.ring(128, 128, 112, 2, GREY_MID);
    c.ring(128, 128, 98, 1, GREY_DARK);
    save("dashboard", "ring-thick", c, "粗圆环");
  }
  // 完整盘面：环 + 40 格刻度
  {
    const c = new Canvas(256, 256);
    c.ring(128, 128, 120, 2, GREY_DARK);
    c.ring(128, 128, 92, 1, GREY_DARK);
    for (let i = 0; i < 40; i++) {
      const a = Math.PI / 180 * (135 + 270 * i / 39);
      const major = i % 5 === 0;
      const r0 = 100, r1 = major ? 114 : 108;
      c.line(
        128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0,
        128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1,
        major ? 3 : 1.6, major ? "#8FA0B8" : GREY_MID
      );
    }
    save("dashboard", "dial-40", c, "盘面（40 格刻度）");
  }
  // 圆角方形底盘
  {
    const c = new Canvas(256, 256);
    c.roundRect(8, 8, 240, 240, 28, "#141A23");
    c.roundRect(8, 8, 240, 240, 28, "#0A0D12", 0.35);
    for (let i = 0; i < 4; i++) {
      const inset = 14 + i;
      c.roundRect(inset, inset, 256 - inset * 2, 256 - inset * 2, 22, i === 0 ? GREY_MID : GREY_DARK, 0.5);
    }
    save("dashboard", "plate-square", c, "方形底盘");
  }
}

// ================================================================ 指针

/** 指针画成竖直的，**枢轴在图片中心**（工具侧绕中心旋转） */
function genNeedles() {
  const W = 48, H = 192;
  const cx = W / 2, cy = H / 2;

  // 经典针
  {
    const c = new Canvas(W, H);
    c.poly([[cx - 3, cy + 24], [cx + 3, cy + 24], [cx + 1.2, cy - 84], [cx - 1.2, cy - 84]], "#E8EEF7");
    c.circle(cx, cy, 7, "#E8EEF7");
    c.circle(cx, cy, 3.5, INK);
    c.line(cx, cy + 24, cx, cy + 34, 3, RED);
    save("needle", "needle-classic", c, "经典指针");
  }
  // 刀锋
  {
    const c = new Canvas(W, H);
    c.poly([[cx - 2, cy], [cx + 2, cy], [cx + 5, cy - 86], [cx - 5, cy - 86]], CYAN);
    c.poly([[cx - 1, cy + 8], [cx + 1, cy + 8], [cx + 2.5, cy - 80], [cx - 2.5, cy - 80]], WHITE, 0.5);
    c.circle(cx, cy, 6, "#1B2430");
    c.circle(cx, cy, 2.5, CYAN);
    save("needle", "needle-blade", c, "刀锋指针");
  }
  // 箭头
  {
    const c = new Canvas(W, H);
    c.rect(cx - 2, cy - 70, 4, 70, "#E8EEF7");
    c.poly([[cx - 7, cy - 70], [cx + 7, cy - 70], [cx, cy - 88]], "#E8EEF7");
    c.circle(cx, cy, 8, "#1B2430");
    c.ring(cx, cy, 8, 1.6, CYAN_DIM);
    save("needle", "needle-arrow", c, "箭头指针");
  }
}

// ================================================================ 刻度

function genScales() {
  // 独立刻度环（透明底，叠在底盘上）
  {
    const c = new Canvas(256, 256);
    for (let i = 0; i < 60; i++) {
      const a = Math.PI / 180 * (135 + 270 * i / 59);
      const major = i % 5 === 0;
      const r0 = 108, r1 = major ? 120 : 114;
      c.line(
        128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0,
        128 + Math.cos(a) * r1, 128 + Math.sin(a) * r1,
        major ? 2.6 : 1.2, major ? "#C8D4E4" : GREY
      );
    }
    save("scale", "ticks-60", c, "刻度环（60 格）");
  }
  // 只留大刻度 + 数字位（留白，用户自己放文字）
  {
    const c = new Canvas(256, 256);
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI / 180 * (135 + 270 * i / 8);
      c.line(
        128 + Math.cos(a) * 104, 128 + Math.sin(a) * 104,
        128 + Math.cos(a) * 122, 128 + Math.sin(a) * 122,
        3, "#C8D4E4"
      );
    }
    save("scale", "ticks-major", c, "大刻度（9 格）");
  }
  // 水平刻度条（条形表用）
  {
    const c = new Canvas(256, 32);
    for (let i = 0; i <= 32; i++) {
      const x = i * 8;
      const major = i % 4 === 0;
      c.rect(x, major ? 6 : 12, major ? 1.6 : 1, major ? 20 : 10, major ? "#8FA0B8" : GREY_MID);
    }
    save("scale", "ticks-bar", c, "水平刻度条");
  }
}

// ================================================================ 图标

function genIcons() {
  const S = 64;
  // 油量：加油机
  {
    const c = new Canvas(S, S);
    c.roundRect(16, 10, 22, 42, 3, "#E8EEF7");
    c.rect(19, 14, 16, 12, INK);
    c.rect(19, 30, 16, 3, INK);
    c.line(38, 16, 46, 22, 3, "#E8EEF7");
    c.rect(44, 22, 4, 22, "#E8EEF7");
    c.line(44, 44, 40, 50, 3, "#E8EEF7");
    save("icon", "fuel", c, "油量");
  }
  // 温度：温度计
  {
    const c = new Canvas(S, S);
    c.rect(28, 8, 8, 34, "#E8EEF7");
    c.circle(32, 48, 10, "#E8EEF7");
    c.rect(30, 14, 4, 30, RED);
    c.circle(32, 48, 6, RED);
    save("icon", "temp", c, "温度");
  }
  // 电池
  {
    const c = new Canvas(S, S);
    c.roundRect(10, 20, 40, 24, 3, "#E8EEF7");
    c.rect(50, 27, 5, 10, "#E8EEF7");
    c.rect(14, 24, 20, 16, "#2FD47A");
    save("icon", "battery", c, "电池");
  }
  // 机油壶
  {
    const c = new Canvas(S, S);
    c.roundRect(14, 26, 34, 26, 4, "#E8EEF7");
    c.poly([[18, 26], [34, 26], [30, 16], [22, 16]], "#E8EEF7");
    c.rect(30, 10, 14, 5, "#E8EEF7");
    c.circle(31, 39, 7, INK);
    save("icon", "oil", c, "机油");
  }
  // 表盘
  {
    const c = new Canvas(S, S);
    c.ring(32, 32, 22, 4, "#E8EEF7");
    c.line(32, 32, 32, 16, 3.5, CYAN);
    c.line(32, 32, 42, 36, 2.5, GREY);
    c.circle(32, 32, 3.5, "#E8EEF7");
    save("icon", "gauge", c, "表盘");
  }
  // 车速
  {
    const c = new Canvas(S, S);
    c.arc(32, 40, 22, 4, 180, 360, "#E8EEF7");
    c.line(32, 40, 20, 24, 3.5, CYAN);
    c.circle(32, 40, 3.5, "#E8EEF7");
    save("icon", "speed", c, "车速");
  }
}

// ================================================================ 转向灯

function genTurn() {
  const S = 64;
  const arrow = (c, dir) => {
    const m = dir === "left" ? -1 : 1;
    const cx = 32;
    c.poly([
      [cx + m * 20, 20], [cx + m * 20, 44], [cx - m * 6, 44],
      [cx - m * 6, 52], [cx - m * 24, 32], [cx - m * 6, 12], [cx - m * 6, 20],
    ], "#2FD47A");
  };
  { const c = new Canvas(S, S); arrow(c, "left"); save("turn", "turn-left", c, "左转向"); }
  { const c = new Canvas(S, S); arrow(c, "right"); save("turn", "turn-right", c, "右转向"); }
  // 双闪
  {
    const c = new Canvas(S, S);
    arrow(c, "left");
    arrow(c, "right");
    save("turn", "hazard", c, "双闪");
  }
}

// ================================================================ 警告灯

function genWarnings() {
  const S = 64;
  // 三态圆灯：正常（暗）/ 警告（琥珀）/ 严重（红）
  const lamp = (col, glow, ringCol) => {
    const c = new Canvas(S, S);
    if (glow) {
      for (let i = 10; i >= 1; i--) c.circle(32, 32, 18 + i * 1.6, col, 0.045);
    }
    c.circle(32, 32, 18, ringCol);
    c.circle(32, 32, 15, col);
    c.circle(28, 26, 5, WHITE, 0.35);
    return c;
  };
  save("warning", "lamp-off", lamp("#1B2430", false, GREY_DARK), "灯·正常");
  save("warning", "lamp-warn", lamp(AMBER, true, "#7A5410"), "灯·警告");
  save("warning", "lamp-crit", lamp(RED, true, "#7A1D1F"), "灯·严重");

  // 发动机轮廓
  {
    const c = new Canvas(S, S);
    c.poly([[14, 26], [24, 26], [28, 20], [40, 20], [40, 26], [50, 26],
            [50, 44], [14, 44]], "#FFB020");
    c.rect(20, 30, 8, 8, INK);
    c.rect(34, 30, 8, 8, INK);
    c.rect(46, 30, 8, 6, "#FFB020");
    save("warning", "engine", c, "发动机");
  }
  // 电池报警
  {
    const c = new Canvas(S, S);
    c.roundRect(8, 22, 40, 22, 3, RED);
    c.rect(48, 28, 5, 10, RED);
    c.line(20, 28, 30, 38, 3, INK);
    c.line(30, 28, 20, 38, 3, INK);
    save("warning", "battery-warn", c, "电池报警");
  }
  // 机油报警
  {
    const c = new Canvas(S, S);
    c.roundRect(14, 26, 34, 26, 4, RED);
    c.poly([[18, 26], [34, 26], [30, 16], [22, 16]], RED);
    c.rect(30, 10, 14, 5, RED);
    c.line(24, 34, 38, 44, 3, INK);
    c.line(38, 34, 24, 44, 3, INK);
    save("warning", "oil-warn", c, "机油报警");
  }
}

// ================================================================ 品牌（通用盾形）

function genBrand() {
  const c = new Canvas(128, 128);
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    // 上半圆 + 下半收尖，做成盾形
    const a = Math.PI * (1 + t);
    pts.push([64 + Math.cos(a) * 46, 46 + Math.sin(a) * 40]);
  }
  pts.push([64, 112]);
  c.poly(pts, "#1B2430");
  c.poly(pts.map(([x, y]) => [64 + (x - 64) * 0.86, 64 + (y - 64) * 0.86]), CYAN_DIM);
  c.rect(60, 40, 8, 40, "#0A0D12");
  c.rect(48, 52, 32, 8, "#0A0D12");
  save("brand", "shield", c, "通用盾形（非任何车标）");
}

// ================================================================ 装饰

function genDecor() {
  // 水平线
  { const c = new Canvas(256, 8); c.rect(0, 3, 256, 2, CYAN_DIM); save("decor", "line-h", c, "水平线"); }
  // 垂直线
  { const c = new Canvas(8, 256); c.rect(3, 0, 2, 256, CYAN_DIM); save("decor", "line-v", c, "垂直线"); }
  // 四角装饰（一个角，旋转复用）
  {
    const c = new Canvas(64, 64);
    c.line(2, 30, 2, 2, 3, CYAN);
    c.line(2, 2, 30, 2, 3, CYAN);
    c.line(10, 22, 10, 10, 1.5, CYAN_DIM);
    c.line(10, 10, 22, 10, 1.5, CYAN_DIM);
    save("decor", "corner", c, "角标");
  }
  // 径向光晕
  {
    const c = new Canvas(256, 256);
    for (let i = 60; i >= 1; i--) {
      c.circle(128, 128, i * 2, CYAN, 0.012);
    }
    save("decor", "glow", c, "光晕");
  }
  // 点阵
  {
    const c = new Canvas(64, 64);
    for (let y = 8; y < 64; y += 16) {
      for (let x = 8; x < 64; x += 16) c.circle(x, y, 1.6, GREY);
    }
    save("decor", "dots", c, "点阵");
  }
  // 斜纹警示条
  {
    const c = new Canvas(64, 32);
    c.rect(0, 0, 64, 32, "#1B2430");
    for (let i = -32; i < 64; i += 12) {
      c.poly([[i, 32], [i + 6, 32], [i + 6 + 32, 0], [i + 32, 0]], AMBER, 0.8);
    }
    save("decor", "hazard-stripe", c, "斜纹条");
  }
  // 分隔弧（表盘下方的装饰弧）
  {
    const c = new Canvas(256, 64);
    c.arc(128, 8, 118, 2, 20, 160, CYAN_DIM);
    save("decor", "arc-bottom", c, "装饰弧");
  }
}

// ================================================================ 更多背景

function genBackgrounds2() {
  // 拉丝金属：细密横向纹理 + 竖向高光
  {
    const c = new Canvas(256, 256);
    c.fill((x, y) => {
      const n = Math.sin(y * 1.7) * 6 + Math.sin(y * 0.31) * 9 + Math.sin(x * 0.05) * 4;
      const v = 26 + n;
      return [Math.round(v), Math.round(v + 3), Math.round(v + 8), 255];
    });
    for (let i = 0; i < 40; i++) {
      const y = Math.random() * 256;
      c.rect(0, y, 256, 0.6, "#4A5568", 0.25);
    }
    save("background", "brushed-metal", c, "拉丝金属");
  }
  // 碳纤维（细密版）
  {
    const c = new Canvas(128, 128);
    c.fill(() => [9, 12, 17, 255]);
    const cell = 4;
    for (let y = 0; y < 128; y += cell) for (let x = 0; x < 128; x += cell) {
      const odd = ((x / cell) + (y / cell)) % 2 === 0;
      c.rect(x, y, cell, cell, odd ? "#141A24" : "#1A2230");
    }
    save("background", "carbon-fine", c, "碳纤维（细）");
  }
  // 斜纹
  {
    const c = new Canvas(64, 64);
    c.fill(() => [11, 14, 20, 255]);
    for (let i = -64; i < 128; i += 8) {
      c.poly([[i, 64], [i + 3, 64], [i + 3 + 64, 0], [i + 64, 0]], "#1C2634", 0.9);
    }
    save("background", "diagonal", c, "斜纹");
  }
  // 噪点
  {
    const c = new Canvas(128, 128);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; return seed / 0x7FFFFFFF; };
    c.fill(() => {
      const v = 10 + Math.round(rnd() * 14);
      return [v, v + 3, v + 8, 255];
    });
    save("background", "noise", c, "噪点");
  }
  // 雷达网格（同心圆 + 十字）
  {
    const c = new Canvas(256, 256);
    c.fill(() => [8, 11, 16, 255]);
    for (let r = 24; r <= 128; r += 26) c.ring(128, 128, r, 1, "#1E2A38");
    c.rect(128, 0, 1, 256, "#1E2A38");
    c.rect(0, 128, 256, 1, "#1E2A38");
    for (let a = 0; a < 360; a += 45) {
      const r = a * Math.PI / 180;
      c.line(128, 128, 128 + Math.cos(r) * 128, 128 + Math.sin(r) * 128, 1, "#1A2432");
    }
    save("background", "radar", c, "雷达网格");
  }
  // 竖条渐变（做侧边栏背景）
  {
    const c = new Canvas(64, 256);
    c.fill((x, y) => {
      const v = 14 + Math.round(10 * Math.sin(y / 256 * Math.PI));
      return [v, v + 4, v + 10, 255];
    });
    save("background", "fade-side", c, "竖向渐变");
  }
}

// ================================================================ 更多仪表盘

function genDashboards2() {
  // 半圆盘（180° 弧）
  {
    const c = new Canvas(256, 128);
    c.arc(128, 122, 108, 3, 180, 360, CYAN_DIM);
    c.arc(128, 122, 96, 1, 180, 360, GREY_DARK);
    save("dashboard", "dial-half", c, "半圆盘");
  }
  // 双环
  {
    const c = new Canvas(256, 256);
    c.ring(128, 128, 116, 2, GREY_MID);
    c.ring(128, 128, 84, 1.5, GREY_DARK);
    c.ring(128, 128, 52, 1, GREY_DARK);
    save("dashboard", "dial-dual-ring", c, "双环盘");
  }
  // 六边形盘
  {
    const c = new Canvas(256, 256);
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k - 90);
      pts.push([128 + Math.cos(a) * 118, 128 + Math.sin(a) * 118]);
    }
    for (let k = 0; k < 6; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[(k + 1) % 6];
      c.line(x0, y0, x1, y1, 2.5, GREY_MID);
    }
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k - 90);
      c.line(128, 128, 128 + Math.cos(a) * 118, 128 + Math.sin(a) * 118, 1, GREY_DARK);
    }
    save("dashboard", "dial-hex", c, "六边形盘");
  }
  // 窄条底盘（条形表用）
  {
    const c = new Canvas(256, 64);
    c.roundRect(2, 2, 252, 60, 8, "#141A23");
    c.roundRect(6, 6, 244, 52, 6, "#0A0D12", 0.4);
    save("dashboard", "plate-bar", c, "条形底盘");
  }
  // 网格底盘（四数据用）
  {
    const c = new Canvas(256, 256);
    c.roundRect(4, 4, 248, 248, 12, "#141A23");
    c.rect(128, 12, 1, 232, GREY_DARK);
    c.rect(12, 128, 232, 1, GREY_DARK);
    for (let i = 0; i < 4; i++) {
      const x = (i % 2) * 128, y = Math.floor(i / 2) * 128;
      c.roundRect(x + 12, y + 12, 104, 104, 8, "#0E131B");
    }
    save("dashboard", "plate-grid4", c, "四格底盘");
  }
}

// ================================================================ 更多指针

function genNeedles2() {
  const W = 48, H = 192, cx = W / 2, cy = H / 2;
  // 短粗针
  {
    const c = new Canvas(W, H);
    c.poly([[cx - 4, cy + 10], [cx + 4, cy + 10], [cx + 2.5, cy - 46], [cx - 2.5, cy - 46]], AMBER);
    c.circle(cx, cy, 7, "#1B2430");
    c.ring(cx, cy, 7, 1.5, AMBER);
    save("needle", "needle-short", c, "短粗指针");
  }
  // 光点针（细线 + 头部圆点）
  {
    const c = new Canvas(W, H);
    c.line(cx, cy, cx, cy - 78, 2, "#E8EEF7", 0.85);
    c.circle(cx, cy - 82, 6, CYAN);
    for (let i = 6; i >= 1; i--) c.circle(cx, cy - 82, 6 + i * 1.4, CYAN, 0.05);
    c.circle(cx, cy, 5, "#1B2430");
    c.circle(cx, cy, 2, CYAN);
    save("needle", "needle-dot", c, "光点指针");
  }
  // 飞机针（细长带尾翼）
  {
    const c = new Canvas(W, H);
    c.rect(cx - 1.2, cy - 84, 2.4, 84, "#E8EEF7");
    c.poly([[cx - 9, cy + 14], [cx + 9, cy + 14], [cx, cy + 34]], "#E8EEF7");
    c.circle(cx, cy, 6, "#1B2430");
    save("needle", "needle-plane", c, "飞机指针");
  }
  // 进度弧针（不是针，是"从起点到当前值"的弧 —— 电动车常用）
  {
    const c = new Canvas(256, 256);
    c.arc(128, 128, 108, 14, 135, 405, "#1B2430");
    save("needle", "arc-track", c, "进度弧底轨");
  }
}

// ================================================================ 更多刻度

function genScales2() {
  // 内圈刻度
  {
    const c = new Canvas(256, 256);
    for (let i = 0; i < 40; i++) {
      const a = Math.PI / 180 * (135 + 270 * i / 39);
      const major = i % 5 === 0;
      c.line(128 + Math.cos(a) * 78, 128 + Math.sin(a) * 78,
             128 + Math.cos(a) * (major ? 90 : 84), 128 + Math.sin(a) * (major ? 90 : 84),
             major ? 2.4 : 1.1, major ? "#8FA0B8" : GREY_MID);
    }
    save("scale", "ticks-inner", c, "内圈刻度");
  }
  // 双圈刻度
  {
    const c = new Canvas(256, 256);
    for (let i = 0; i < 60; i++) {
      const a = Math.PI / 180 * (135 + 270 * i / 59);
      const major = i % 5 === 0;
      c.line(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100,
             128 + Math.cos(a) * (major ? 122 : 114), 128 + Math.sin(a) * (major ? 122 : 114),
             major ? 2.4 : 1, major ? "#C8D4E4" : GREY);
      c.line(128 + Math.cos(a) * 74, 128 + Math.sin(a) * 74,
             128 + Math.cos(a) * 80, 128 + Math.sin(a) * 80, 1, GREY_MID);
    }
    save("scale", "ticks-dual", c, "双圈刻度");
  }
  // 垂直刻度（竖条表）
  {
    const c = new Canvas(32, 256);
    for (let i = 0; i <= 32; i++) {
      const y = 255 - i * 8;
      const major = i % 4 === 0;
      c.rect(major ? 6 : 12, y, major ? 20 : 10, major ? 1.6 : 1, major ? "#8FA0B8" : GREY_MID);
    }
    save("scale", "ticks-vertical", c, "垂直刻度");
  }
  // 圆点刻度
  {
    const c = new Canvas(256, 256);
    for (let i = 0; i < 24; i++) {
      const a = Math.PI / 180 * (135 + 270 * i / 23);
      c.circle(128 + Math.cos(a) * 112, 128 + Math.sin(a) * 112, i % 3 === 0 ? 3.2 : 1.8,
               i % 3 === 0 ? CYAN : GREY);
    }
    save("scale", "ticks-dots", c, "圆点刻度");
  }
}

// ================================================================ 更多图标

function genIcons2() {
  const S2 = 64;
  const mk = (name, label, fn) => { const c = new Canvas(S2, S2); fn(c); save("icon", name, c, label); };

  mk("turbo", "涡轮", c => {
    c.ring(32, 32, 18, 3, "#E8EEF7");
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i);
      c.line(32, 32, 32 + Math.cos(a) * 16, 32 + Math.sin(a) * 16, 2.5, "#E8EEF7");
    }
    c.circle(32, 32, 4, CYAN);
  });
  mk("gear", "变速箱", c => {
    c.ring(32, 32, 16, 3, "#E8EEF7");
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 180 * (45 * i);
      c.rect(32 + Math.cos(a) * 18 - 3, 32 + Math.sin(a) * 18 - 3, 6, 6, "#E8EEF7");
    }
    c.circle(32, 32, 5, INK);
  });
  mk("odo", "里程", c => {
    c.roundRect(8, 20, 48, 24, 3, "#E8EEF7");
    c.rect(12, 24, 40, 16, INK);
    for (let i = 0; i < 5; i++) c.rect(14 + i * 8, 27, 4, 10, "#E8EEF7");
  });
  mk("cruise", "定速巡航", c => {
    c.ring(32, 32, 18, 3, "#2FD47A");
    c.line(32, 20, 32, 34, 3, "#2FD47A");
    c.line(32, 34, 40, 40, 3, "#2FD47A");
    c.circle(32, 32, 3, "#2FD47A");
  });
  mk("tpms", "胎压", c => {
    c.arc(32, 36, 18, 7, 200, 340, "#E8EEF7");
    c.rect(24, 14, 16, 12, "#E8EEF7");
    c.rect(28, 16, 8, 8, INK);
  });
  mk("door", "车门", c => {
    c.roundRect(18, 14, 28, 36, 3, "#E8EEF7");
    c.rect(22, 18, 20, 14, INK);
    c.circle(42, 34, 3, INK);
  });
  mk("belt", "安全带", c => {
    c.poly([[20, 12], [30, 12], [44, 52], [34, 52]], "#E8EEF7");
    c.rect(24, 28, 18, 5, RED);
  });
  mk("beam", "远光", c => {
    c.circle(24, 32, 10, "#4DA3FF");
    for (let i = 0; i < 4; i++) c.line(38, 22 + i * 7, 56, 18 + i * 9, 2, "#4DA3FF", 0.7);
  });
  mk("fog", "雾灯", c => {
    c.circle(24, 32, 10, "#7ED957");
    for (let i = 0; i < 3; i++) c.line(36, 26 + i * 6, 52, 24 + i * 8, 2, "#7ED957", 0.6);
    for (let i = 0; i < 3; i++) c.line(36, 38 + i * 4, 52, 44 + i * 4, 1.6, "#7ED957", 0.4);
  });
  mk("esp", "ESP", c => {
    c.ring(32, 32, 17, 3, "#FFB020");
    c.poly([[22, 34], [30, 24], [30, 31], [42, 30], [34, 40], [34, 33]], "#FFB020");
  });
  mk("abs", "ABS", c => {
    c.ring(32, 32, 18, 3, "#FFB020");
    c.circle(32, 32, 12, INK);
    c.font = "";
    c.rect(20, 29, 24, 6, "#FFB020");
    c.rect(22, 22, 4, 20, "#FFB020");
    c.rect(38, 22, 4, 20, "#FFB020");
  });
  mk("awd", "四驱", c => {
    c.ring(18, 32, 8, 3, "#E8EEF7");
    c.ring(46, 32, 8, 3, "#E8EEF7");
    c.line(26, 32, 38, 32, 3, "#E8EEF7");
    c.line(32, 26, 32, 38, 3, "#E8EEF7");
  });
  mk("range", "续航", c => {
    c.roundRect(12, 22, 34, 20, 3, "#2FD47A");
    c.rect(46, 28, 5, 8, "#2FD47A");
    c.rect(16, 26, 12, 12, INK);
  });
  mk("clock", "时钟", c => {
    c.ring(32, 32, 18, 3, "#E8EEF7");
    c.line(32, 32, 32, 20, 3, "#E8EEF7");
    c.line(32, 32, 42, 36, 2.4, CYAN);
    c.circle(32, 32, 2.6, "#E8EEF7");
  });
}

// ================================================================ 更多警告灯

function genWarnings2() {
  const S3 = 64;
  const mk = (name, label, fn) => { const c = new Canvas(S3, S3); fn(c); save("warning", name, c, label); };

  mk("tpms-warn", "胎压报警", c => {
    c.arc(32, 38, 17, 6, 200, 340, AMBER);
    c.rect(25, 16, 14, 11, AMBER);
    c.line(32, 30, 32, 38, 3, AMBER);
    c.circle(32, 44, 3, AMBER);
  });
  mk("door-warn", "车门未关", c => {
    c.roundRect(16, 12, 32, 40, 3, RED);
    c.rect(20, 16, 24, 16, INK);
    c.circle(44, 36, 3.5, INK);
  });
  mk("belt-warn", "未系安全带", c => {
    c.circle(32, 22, 8, RED);
    c.poly([[18, 52], [46, 52], [40, 32], [24, 32]], RED);
    c.poly([[26, 34], [34, 34], [44, 50], [36, 50]], INK);
  });
  mk("beam-warn", "远光", c => {
    c.circle(22, 32, 11, "#4DA3FF");
    for (let i = 0; i < 4; i++) c.line(38, 20 + i * 8, 58, 16 + i * 10, 2.4, "#4DA3FF", 0.8);
  });
  mk("fog-warn", "雾灯", c => {
    c.circle(22, 32, 11, "#7ED957");
    for (let i = 0; i < 3; i++) c.line(36, 26 + i * 6, 54, 24 + i * 8, 2.4, "#7ED957", 0.7);
  });
  mk("esp-warn", "ESP", c => {
    c.ring(32, 32, 20, 3, AMBER);
    c.poly([[20, 36], [30, 22], [30, 31], [44, 29], [34, 42], [34, 33]], AMBER);
  });
  mk("abs-warn", "ABS", c => {
    c.ring(32, 32, 20, 3, AMBER);
    c.circle(32, 32, 14, INK);
    c.rect(20, 29, 24, 6, AMBER);
    c.rect(22, 20, 4, 24, AMBER);
    c.rect(38, 20, 4, 24, AMBER);
  });
  mk("coolant-warn", "水温高", c => {
    c.rect(26, 10, 12, 32, RED);
    c.circle(32, 48, 12, RED);
    c.rect(29, 16, 6, 28, INK);
    for (let i = 0; i < 3; i++) c.line(44, 14 + i * 8, 56, 10 + i * 10, 2.4, RED, 0.8);
  });
  mk("oil-low", "机油压力低", c => {
    c.roundRect(12, 28, 34, 24, 4, RED);
    c.poly([[16, 28], [32, 28], [28, 18], [20, 18]], RED);
    c.rect(28, 12, 14, 5, RED);
    c.circle(30, 40, 6, INK);
  });
  mk("fuel-low", "燃油低", c => {
    c.roundRect(14, 10, 24, 44, 3, AMBER);
    c.rect(17, 14, 18, 16, INK);
    c.rect(17, 34, 18, 3, INK);
    c.line(40, 18, 48, 24, 3, AMBER);
    c.rect(46, 24, 4, 22, AMBER);
  });
  mk("trans-warn", "变速箱", c => {
    c.ring(32, 32, 17, 3, RED);
    c.rect(28, 12, 8, 20, RED);
    c.circle(32, 46, 3.5, RED);
  });
  mk("steer-warn", "转向助力", c => {
    c.ring(32, 32, 18, 4, RED);
    c.rect(30, 16, 4, 32, RED);
    c.rect(16, 30, 32, 4, RED);
  });
}

// ================================================================ 更多装饰

function genDecor2() {
  // 圆点阵
  {
    const c = new Canvas(64, 64);
    for (let y = 8; y < 64; y += 12) for (let x = 8; x < 64; x += 12) c.circle(x, y, 1.2, GREY);
    save("decor", "dots-fine", c, "细点阵");
  }
  // 斜线组
  {
    const c = new Canvas(64, 64);
    for (let i = -64; i < 128; i += 6) c.line(i, 64, i + 64, 0, 1, CYAN_DIM, 0.6);
    save("decor", "hatch", c, "斜线组");
  }
  // 进度条底轨（水平）
  {
    const c = new Canvas(256, 16);
    c.roundRect(0, 4, 256, 8, 4, "#1B2430");
    c.roundRect(1, 5, 254, 6, 3, "#0E131B", 0.6);
    save("decor", "track-bar", c, "条底轨");
  }
  // 进度弧底轨
  {
    const c = new Canvas(256, 256);
    c.arc(128, 128, 110, 12, 135, 405, "#1B2430");
    save("decor", "track-arc", c, "弧底轨");
  }
  // 箭头（指向右）
  {
    const c = new Canvas(64, 32);
    c.poly([[4, 8], [40, 8], [40, 2], [60, 16], [40, 30], [40, 24], [4, 24]], CYAN, 0.9);
    save("decor", "arrow-r", c, "箭头");
  }
  // 括号框（左上角）
  {
    const c = new Canvas(64, 64);
    c.line(4, 28, 4, 4, 3, CYAN);
    c.line(4, 4, 28, 4, 3, CYAN);
    save("decor", "bracket-tl", c, "括号（左上）");
  }
  // 标题下划线（渐变）
  {
    const c = new Canvas(256, 8);
    c.fill((x) => {
      const a = Math.max(0, 1 - x / 200);
      return [0, 216, 255, Math.round(255 * a)];
    });
    save("decor", "underline", c, "渐隐下划线");
  }
  // 分隔点线
  {
    const c = new Canvas(256, 8);
    for (let x = 4; x < 256; x += 12) c.circle(x, 4, 1.4, GREY);
    save("decor", "divider-dots", c, "点线分隔");
  }
  // 圆角边框
  {
    const c = new Canvas(256, 256);
    c.roundRect(4, 4, 248, 248, 16, "#00D8FF", 0.5);
    c.roundRect(10, 10, 236, 236, 12, "#00D8FF", 0.25);
    save("decor", "frame-round", c, "圆角边框");
  }
  // 角标（四角一起）
  {
    const c = new Canvas(256, 256);
    const L = 34;
    [[4, 4, 1, 1], [252, 4, -1, 1], [4, 252, 1, -1], [252, 252, -1, -1]].forEach(([x, y, sx, sy]) => {
      c.line(x, y + sy * L, x, y, 3, CYAN);
      c.line(x, y, x + sx * L, y, 3, CYAN);
    });
    save("decor", "frame-corners", c, "四角标");
  }
  // 光晕（暖色，做警告底）
  {
    const c = new Canvas(256, 256);
    for (let i = 60; i >= 1; i--) c.circle(128, 128, i * 2, AMBER, 0.010);
    save("decor", "glow-amber", c, "光晕（暖）");
  }
  // 扫描线
  {
    const c = new Canvas(256, 256);
    for (let y = 0; y < 256; y += 4) c.rect(0, y, 256, 1, CYAN, 0.06);
    save("decor", "scanlines", c, "扫描线");
  }
}

// ================================================================ 主流程

console.log("生成示例素材（自写 PNG 编码器，无第三方依赖）\n");
genBackgrounds();
genDashboards();
genNeedles();
genScales();
genIcons();
genTurn();
genWarnings();
genBrand();
genDecor();
genBackgrounds2();
genDashboards2();
genNeedles2();
genScales2();
genIcons2();
genWarnings2();
genDecor2();

// ---- 第三轮扩充（v2.20.0）。放在**单独文件**里 —— 这个文件已经 980 行，
// 再堆两百个素材会变成没法读的一坨。
const more = require("./gen-assets-more.js")({
  save, Canvas,
  C: { CYAN, CYAN_DIM, AMBER, RED, GREEN, GREY, GREY_DARK, GREY_MID, WHITE, INK },
  // 点阵字库（v2.23.0）—— 数字刻度素材要用它
  drawText: require("./png.js").drawText,
  textWidth: require("./png.js").textWidth,
  GLYPH_W: require("./png.js").GLYPH_W,
  GLYPH_H: require("./png.js").GLYPH_H,
});
more.genWarnings3();
more.genIcons3();
more.genTurn3();
more.genNeedles3();
more.genScales3();
more.genDashboards3();
more.genBrand3();
more.genBars();
more.genFrames();
more.genDecor3();
more.genBackgrounds3();
more.genNumberScales();

// ---- 清单写成**经典脚本**（file:// 下 fetch 被挡，但 <script src> 可以）
const js =
  "/* 由 gen-assets.js 生成 —— 不要手改 */\n" +
  "/* 清单写成 .js 而不是 .json：工具跑在 file:// 下，fetch/XHR 被 CORS 挡住，\n" +
  "   而经典 <script src> 可以。 */\n" +
  "window.BUILTIN_ASSETS = " + JSON.stringify(manifest, null, 2) + ";\n";
fs.writeFileSync(path.join(ASSETS, "builtin.js"), js, "utf8");

// ---- 拆成「索引 + 各分类数据」（v2.24.0）
//
// ## 为什么要拆
//
// 319 个素材内嵌 data URL 后清单是 **770 KB**，而且还会继续长。
// 一次全量加载意味着**在拿到任何一条元数据之前**要等整个文件解析完。
//
// ## 拆法
//
//   builtin-index.js       只含元数据（path/name/label/kind/w/h）—— 很小
//   builtin-data-<分类>.js 该分类的 data URL
//
// `builtin-index.js` 先定义 `window.BUILTIN_ASSETS`（没有 data），
// 各分类文件再**把 data 补进已有的条目**（同一个对象，不是重建）。
//
// 于是 UI 可以**先渲染出全部缩略图位置与名字**，图片数据随后到 ——
// 而不是白屏等 770 KB 解析完。
//
// ⚠️ 仍然全部是经典 `<script src>`：`file://` 下 fetch/XHR 被 CORS 挡，
// 只有经典脚本能加载本地文件。
const meta = manifest.map(m => ({
  name: m.name, label: m.label, kind: m.kind, path: m.path, w: m.w, h: m.h,
}));
const idxJs =
  "/* 由 gen-assets.js 生成 —— 不要手改 */\n" +
  "/* 素材索引（元数据，不含 data URL）。data 由 builtin-data-*.js 补进来。 */\n" +
  "window.BUILTIN_ASSETS = " + JSON.stringify(meta) + ";\n";
fs.writeFileSync(path.join(ASSETS, "builtin-index.js"), idxJs, "utf8");

const byKindSplit = {};
manifest.forEach(m => { (byKindSplit[m.kind] = byKindSplit[m.kind] || []).push(m); });
Object.keys(byKindSplit).forEach(k => {
  const part = {};
  byKindSplit[k].forEach(m => { part[m.path] = m.data; });
  const partJs =
    "/* 由 gen-assets.js 生成 —— 不要手改 */\n" +
    "/* " + k + " 分类的素材 data URL（" + byKindSplit[k].length + " 个）*/\n" +
    "(function () {\n" +
    "  var P = " + JSON.stringify(part) + ";\n" +
    "  (window.BUILTIN_ASSETS || []).forEach(function (a) {\n" +
    "    if (P[a.path]) a.data = P[a.path];\n" +
    "  });\n" +
    "  window.BUILTIN_DATA_KINDS = (window.BUILTIN_DATA_KINDS || []);\n" +
    "  window.BUILTIN_DATA_KINDS.push(" + JSON.stringify(k) + ");\n" +
    "})();\n";
  fs.writeFileSync(path.join(ASSETS, "builtin-data-" + k + ".js"), partJs, "utf8");
});
console.log("拆出：builtin-index.js + " + Object.keys(byKindSplit).length + " 个分类数据文件");

// ---- 统计
const byKind = {};
manifest.forEach(m => { byKind[m.kind] = (byKind[m.kind] || 0) + 1; });
Object.keys(byKind).sort().forEach(k => console.log("  " + k.padEnd(12) + byKind[k] + " 个"));
console.log("\n共 " + manifest.length + " 个素材");
console.log("清单：assets/builtin.js（" + js.length + " 字节）");
