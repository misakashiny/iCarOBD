/**
 * gen-assets-more.js —— 第三轮素材扩充（v2.20.0）
 *
 * ## 为什么单独一个文件
 *
 * `gen-assets.js` 已经 980 行。再往里堆两百个素材会变成没法读的一坨。
 * 这里只放**新增的生成器**，由 `gen-assets.js` 在写清单之前调用一次。
 *
 * ## 分类的依据
 *
 * 警告灯那一批按 **ISO 2575**（车用符号国际标准）的常见条目来做 ——
 * 这是仪表盘上最"必须认得出"的一类，画错了比没有更糟。
 *
 * ⚠️ **品牌类只做通用形状**（盾/圆环/星/翼/闪电…），**不做任何真实车标** ——
 * 这是项目从一开始就守住的线。
 *
 * ## 绘图 API（见 png.js）
 *
 *   rect(x,y,w,h,c,a)  roundRect(x,y,w,h,r,c,a)  circle(cx,cy,r,c,a)
 *   ring(cx,cy,r,thick,c,a)  arc(cx,cy,r,thick,a0,a1,c,a)   ← 角度制，0=正右，顺时针
 *   line(x0,y0,x1,y1,thick,c,a)   ← 圆头
 *   poly(pts,c,a)   fill((x,y)=>color)
 *
 * **没有文字绘制** —— 所以"数字刻度"这类只能用形状模拟（短横线 + 长横线）。
 */

module.exports = function (ctx) {
  const { save, Canvas, C } = ctx;
  const { CYAN, CYAN_DIM, AMBER, RED, GREEN, GREY, GREY_DARK, GREY_MID, WHITE, INK } = C;

  // ---------------------------------------------------------------- 小工具

  /** 极坐标点 */
  const P = (cx, cy, r, deg) => [
    cx + Math.cos((deg * Math.PI) / 180) * r,
    cy + Math.sin((deg * Math.PI) / 180) * r,
  ];

  /** 正多边形顶点 */
  function ngon(cx, cy, r, n, rot) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(P(cx, cy, r, (rot || -90) + (360 / n) * i));
    return out;
  }

  /** 环形排布的短刻度（刻度盘最常用的一种画法） */
  function radialTicks(c, cx, cy, r, count, len, thick, color, alpha, a0, a1, skipEvery) {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : i / (count - 1);
      const ang = a0 + (a1 - a0) * t;
      const major = skipEvery ? i % skipEvery === 0 : false;
      const L = major ? len * 1.8 : len;
      const p0 = P(cx, cy, r, ang);
      const p1 = P(cx, cy, r - L, ang);
      c.line(p0[0], p0[1], p1[0], p1[1], major ? thick * 1.5 : thick, color, alpha);
    }
  }

  /** 圆角胶囊（横条/竖条轨道都用它） */
  function capsule(c, x, y, w, h, color, alpha) {
    const r = Math.min(w, h) / 2;
    c.roundRect(x, y, w, h, r, color, alpha);
  }

  // ================================================================ 警告灯（ISO 2575 常见条目）
  function genWarnings3() {
    const S = 128, cx = 64, cy = 64;

    // --- 制动类
    {
      const c = new Canvas(S, S);
      c.ring(cx, cy, 42, 5, RED, 0.95);
      c.line(46, 46, 82, 82, 4, RED, 0.9);
      c.line(82, 46, 46, 82, 4, RED, 0.9);
      c.line(38, 64, 90, 64, 5, RED, 0.95);
      save("warning", "brake", c, "制动系统（圆圈+感叹号，ISO 2575）");
    }
    {
      const c = new Canvas(S, S);
      c.ring(cx, cy, 40, 5, RED, 0.9);
      c.ring(cx, cy, 24, 5, RED, 0.9);
      c.line(64, 40, 64, 72, 5, RED, 0.9);
      c.line(64, 84, 64, 90, 5, RED, 0.9);
      save("warning", "brake-pad", c, "刹车片磨损（外圈+内圈+竖线）");
    }
    {
      const c = new Canvas(S, S);
      c.ring(cx, cy, 40, 5, RED, 0.9);
      // 括号包住的 P —— 电子手刹
      c.arc(cx, cy, 30, 5, 130, 230, RED, 0.9);
      c.line(60, 44, 60, 84, 6, RED, 0.9);
      c.arc(60, 52, 12, 5, -90, 90, RED, 0.9);
      save("warning", "parking-brake", c, "电子手刹（圆圈+括号+P）");
    }

    // --- 安全类
    {
      const c = new Canvas(S, S);
      // 安全气囊：坐着的人 + 前方的气囊球
      c.circle(46, 34, 11, RED, 0.9);
      c.line(46, 45, 46, 78, 7, RED, 0.9);
      c.line(46, 56, 30, 72, 6, RED, 0.9);
      c.line(46, 56, 62, 70, 6, RED, 0.9);
      c.line(46, 78, 32, 98, 6, RED, 0.9);
      c.circle(88, 62, 16, RED, 0.9);
      save("warning", "airbag", c, "安全气囊（人形+气囊）");
    }
    {
      const c = new Canvas(S, S);
      // 安全带：斜带 + 扣
      c.line(36, 96, 92, 34, 9, RED, 0.9);
      c.roundRect(30, 88, 16, 20, 4, RED, 0.9);
      c.circle(96, 34, 8, RED, 0.9);
      save("warning", "seatbelt", c, "安全带未系");
    }
    {
      const c = new Canvas(S, S);
      c.ring(cx, cy, 40, 5, AMBER, 0.95);
      // 打滑：车 + 波浪
      c.poly([[44, 62], [84, 62], [78, 50], [50, 50]], AMBER, 0.9);
      c.line(34, 74, 46, 74, 5, AMBER, 0.9);
      c.line(52, 74, 76, 74, 5, AMBER, 0.9);
      c.line(82, 74, 94, 74, 5, AMBER, 0.9);
      c.line(34, 86, 50, 86, 5, AMBER, 0.9);
      c.line(56, 86, 94, 86, 5, AMBER, 0.9);
      save("warning", "traction", c, "牵引力控制 / 打滑");
    }
    {
      const c = new Canvas(S, S);
      // 车道偏离：两条车道线 + 车
      c.line(34, 30, 22, 98, 6, AMBER, 0.9);
      c.line(94, 30, 106, 98, 6, AMBER, 0.9);
      c.poly([[54, 60], [74, 60], [70, 48], [58, 48]], AMBER, 0.9);
      c.line(50, 68, 78, 68, 5, AMBER, 0.9);
      save("warning", "lane-keep", c, "车道保持辅助");
    }
    {
      const c = new Canvas(S, S);
      // 盲区：车 + 两侧弧
      c.poly([[50, 58], [78, 58], [74, 46], [54, 46]], AMBER, 0.9);
      c.line(46, 66, 82, 66, 5, AMBER, 0.9);
      c.arc(64, 56, 34, 4, 150, 210, AMBER, 0.8);
      c.arc(64, 56, 46, 4, 155, 205, AMBER, 0.6);
      save("warning", "blind-spot", c, "盲区监测");
    }
    {
      const c = new Canvas(S, S);
      // 碰撞预警：车 + 前方放射
      c.poly([[48, 66], [80, 66], [76, 54], [52, 54]], RED, 0.9);
      c.line(44, 74, 84, 74, 5, RED, 0.9);
      c.line(64, 44, 64, 30, 5, RED, 0.85);
      c.line(44, 48, 34, 38, 5, RED, 0.85);
      c.line(84, 48, 94, 38, 5, RED, 0.85);
      save("warning", "collision", c, "前碰撞预警");
    }

    // --- 动力 / 排放类
    {
      const c = new Canvas(S, S);
      // 预热塞（柴油）
      c.line(40, 42, 88, 42, 6, AMBER, 0.95);
      c.line(48, 42, 44, 74, 6, AMBER, 0.95);
      c.line(64, 42, 60, 74, 6, AMBER, 0.95);
      c.line(80, 42, 76, 74, 6, AMBER, 0.95);
      c.line(36, 88, 92, 88, 6, AMBER, 0.95);
      save("warning", "glow-plug", c, "预热塞（柴油）");
    }
    {
      const c = new Canvas(S, S);
      // 排气/颗粒捕集器：罐体 + 点阵
      c.roundRect(34, 48, 60, 32, 8, AMBER, 0.9);
      for (let i = 0; i < 4; i++) c.circle(46 + i * 12, 64, 3, INK, 0.8);
      c.line(28, 56, 34, 56, 5, AMBER, 0.9);
      c.line(94, 72, 100, 72, 5, AMBER, 0.9);
      save("warning", "dpf", c, "颗粒捕集器（DPF）");
    }
    {
      const c = new Canvas(S, S);
      // 油水分离器：水滴 + 罐
      c.poly([[64, 34], [82, 60], [46, 60]], CYAN, 0.9);
      c.roundRect(38, 70, 52, 26, 6, AMBER, 0.9);
      c.line(30, 83, 38, 83, 5, AMBER, 0.9);
      save("warning", "water-in-fuel", c, "燃油滤清器含水");
    }
    {
      const c = new Canvas(S, S);
      // 变速箱过热：齿轮 + 温度计
      c.ring(52, 60, 20, 6, RED, 0.9);
      for (let i = 0; i < 8; i++) {
        const p0 = P(52, 60, 20, i * 45), p1 = P(52, 60, 28, i * 45);
        c.line(p0[0], p0[1], p1[0], p1[1], 5, RED, 0.9);
      }
      c.roundRect(86, 34, 10, 44, 5, RED, 0.9);
      c.circle(91, 84, 9, RED, 0.9);
      save("warning", "transmission", c, "变速箱过热 / 故障");
    }
    {
      const c = new Canvas(S, S);
      // 转向助力：方向盘 + 感叹号
      c.ring(cx, cy, 36, 6, RED, 0.9);
      c.circle(cx, cy, 10, RED, 0.9);
      c.line(28, 64, 44, 64, 6, RED, 0.9);
      c.line(84, 64, 100, 64, 6, RED, 0.9);
      c.line(64, 74, 64, 96, 6, RED, 0.9);
      save("warning", "steering", c, "转向助力故障");
    }

    // --- 电气 / 充电
    {
      const c = new Canvas(S, S);
      // 高压电池
      c.roundRect(30, 44, 68, 40, 6, AMBER, 0.9);
      c.rect(98, 56, 8, 16, AMBER, 0.9);
      c.poly([[56, 50], [46, 68], [60, 68], [52, 86], [76, 62], [62, 62], [70, 50]], RED, 0.95);
      save("warning", "ev-battery", c, "高压电池 / 电量低");
    }
    {
      const c = new Canvas(S, S);
      // 充电枪
      c.roundRect(40, 40, 34, 52, 8, GREEN, 0.9);
      c.line(74, 56, 92, 56, 7, GREEN, 0.9);
      c.line(92, 56, 92, 88, 7, GREEN, 0.9);
      c.line(52, 92, 62, 92, 6, GREEN, 0.9);
      save("warning", "charge-cable", c, "充电枪已连接");
    }

    // --- 灯光指示
    {
      const c = new Canvas(S, S);
      c.arc(cx, 74, 34, 6, 200, 340, GREEN, 0.95);
      for (let i = 0; i < 5; i++) {
        const p0 = P(cx, 74, 34, 206 + i * 32), p1 = P(cx, 74, 54, 206 + i * 32);
        c.line(p0[0], p0[1], p1[0], p1[1], 5, GREEN, 0.9);
      }
      save("warning", "low-beam", c, "近光灯（光线向下）");
    }
    {
      const c = new Canvas(S, S);
      c.arc(cx, 66, 34, 6, 200, 340, CYAN, 0.95);
      for (let i = 0; i < 5; i++) {
        const p0 = P(cx, 66, 34, 206 + i * 32), p1 = P(cx, 66, 58, 206 + i * 32);
        c.line(p0[0], p0[1], p1[0], p1[1], 5, CYAN, 0.9);
      }
      save("warning", "high-beam", c, "远光灯（光线平直）");
    }
    {
      const c = new Canvas(S, S);
      // 示宽灯：两个背对的半圆
      c.arc(46, 64, 22, 6, 90, 270, GREEN, 0.95);
      c.arc(82, 64, 22, 6, -90, 90, GREEN, 0.95);
      save("warning", "position-light", c, "示宽灯");
    }
    {
      const c = new Canvas(S, S);
      c.arc(cx, 74, 34, 6, 200, 340, AMBER, 0.95);
      for (let i = 0; i < 4; i++) {
        const p0 = P(cx, 74, 34, 214 + i * 38), p1 = P(cx, 74, 50, 214 + i * 38);
        c.line(p0[0], p0[1], p1[0], p1[1], 5, AMBER, 0.9);
      }
      c.line(34, 92, 94, 92, 5, AMBER, 0.7);
      save("warning", "rear-fog", c, "后雾灯");
    }

    // --- 智能驾驶
    {
      const c = new Canvas(S, S);
      // 自适应巡航：车 + 前车 + 距离弧
      c.poly([[40, 84], [64, 84], [60, 70], [44, 70]], CYAN, 0.9);
      c.line(36, 92, 68, 92, 5, CYAN, 0.9);
      c.poly([[72, 52], [96, 52], [92, 38], [76, 38]], CYAN, 0.9);
      c.arc(64, 64, 30, 4, -60, 60, CYAN, 0.55);
      save("warning", "adaptive-cruise", c, "自适应巡航");
    }
    {
      const c = new Canvas(S, S);
      // 限速：圆圈 + 斜杠（无文字，用刻度表示）
      c.ring(cx, cy, 42, 7, RED, 0.95);
      for (let i = 0; i < 12; i++) {
        const p0 = P(cx, cy, 32, i * 30), p1 = P(cx, cy, 26, i * 30);
        c.line(p0[0], p0[1], p1[0], p1[1], 4, WHITE, 0.85);
      }
      save("warning", "speed-limit", c, "限速提示（无数字版）");
    }

    // --- 车身 / 便利
    {
      const c = new Canvas(S, S);
      // 胎压：轮胎截面 + 感叹号
      c.arc(cx, 76, 32, 9, 190, 350, AMBER, 0.9);
      c.line(32, 76, 96, 76, 6, AMBER, 0.7);
      c.line(64, 30, 64, 50, 5, AMBER, 0.9);
      c.circle(64, 58, 4, AMBER, 0.9);
      save("warning", "tpms", c, "胎压监测");
    }
    {
      const c = new Canvas(S, S);
      // 玻璃水
      c.poly([[50, 42], [78, 42], [84, 96], [44, 96]], CYAN, 0.85);
      c.line(64, 42, 64, 26, 5, CYAN, 0.9);
      c.line(56, 26, 72, 26, 5, CYAN, 0.9);
      c.line(52, 66, 76, 66, 4, INK, 0.5);
      save("warning", "washer", c, "玻璃水不足");
    }
    {
      const c = new Canvas(S, S);
      // 钥匙 / 防盗
      c.circle(46, 64, 16, AMBER, 0.9);
      c.rect(60, 58, 40, 12, AMBER, 0.9);
      c.rect(84, 70, 8, 12, AMBER, 0.9);
      c.rect(96, 70, 8, 10, AMBER, 0.9);
      save("warning", "immobilizer", c, "防盗 / 钥匙识别");
    }
    {
      const c = new Canvas(S, S);
      // 保养扳手
      c.arc(50, 48, 22, 10, 30, 200, AMBER, 0.9);
      c.line(60, 62, 96, 98, 11, AMBER, 0.9);
      c.circle(46, 44, 8, INK, 0.85);
      save("warning", "service", c, "保养到期");
    }
    {
      const c = new Canvas(S, S);
      // 发动机舱盖未关
      c.line(28, 78, 100, 78, 6, RED, 0.9);
      c.line(36, 78, 64, 40, 6, RED, 0.9);
      c.line(64, 40, 96, 62, 6, RED, 0.9);
      c.line(64, 40, 64, 62, 5, RED, 0.6);
      save("warning", "hood", c, "发动机舱盖未关");
    }
    {
      const c = new Canvas(S, S);
      // 后备箱未关
      c.line(28, 70, 100, 70, 6, RED, 0.9);
      c.line(36, 70, 64, 34, 6, RED, 0.9);
      c.line(64, 34, 96, 56, 6, RED, 0.9);
      c.circle(64, 84, 9, RED, 0.85);
      save("warning", "trunk", c, "后备箱未关");
    }
    {
      const c = new Canvas(S, S);
      // 拖车 / 挂车
      c.roundRect(30, 52, 44, 30, 6, AMBER, 0.9);
      c.circle(40, 90, 10, AMBER, 0.9);
      c.circle(66, 90, 10, AMBER, 0.9);
      c.line(74, 66, 96, 66, 6, AMBER, 0.9);
      c.circle(100, 66, 8, AMBER, 0.9);
      save("warning", "trailer", c, "挂车 / 拖车");
    }
    {
      const c = new Canvas(S, S);
      // 座椅加热
      c.roundRect(38, 44, 34, 48, 8, AMBER, 0.85);
      c.roundRect(38, 92, 34, 14, 6, AMBER, 0.85);
      for (let i = 0; i < 3; i++) {
        const x = 84 + i * 10;
        c.line(x, 46, x - 6, 62, 5, RED, 0.9);
        c.line(x - 6, 62, x, 78, 5, RED, 0.9);
        c.line(x, 78, x - 6, 94, 5, RED, 0.9);
      }
      save("warning", "seat-heat", c, "座椅加热");
    }
  }

  // ================================================================ 通用图标（第三批）
  function genIcons3() {
    const S = 128, cx = 64, cy = 64;

    const mk = (name, note, draw) => {
      const c = new Canvas(S, S);
      draw(c, cx, cy);
      save("icon", name, c, note);
    };

    // --- 仪表相关（画在圆环里，直接能当小表用）
    const dial = (name, note, inner) => mk(name, note, (c, x, y) => {
      c.ring(x, y, 44, 5, CYAN_DIM, 0.9);
      c.arc(x, y, 44, 5, 135, 405, CYAN, 0.75);
      radialTicks(c, x, y, 38, 9, 7, 3, GREY, 0.8, 135, 405, 2);
      inner(c, x, y);
    });

    dial("gauge-temp", "水温小表", (c, x, y) => {
      c.line(x, y + 8, x, y - 16, 5, CYAN, 0.95);
      c.circle(x, y + 12, 7, CYAN, 0.95);
      c.line(x - 14, y - 6, x - 6, y + 2, 4, CYAN, 0.8);
      c.line(x + 14, y - 6, x + 6, y + 2, 4, CYAN, 0.8);
    });
    dial("gauge-volt", "电压小表", (c, x, y) => {
      c.poly([[x + 6, y - 20], [x - 10, y + 2], [x + 1, y + 2], [x - 6, y + 20], [x + 12, y - 4], [x + 1, y - 4]], AMBER, 0.95);
    });
    dial("gauge-boost", "涡轮压力小表", (c, x, y) => {
      c.arc(x, y + 6, 16, 6, 180, 360, CYAN, 0.95);
      c.line(x - 16, y + 6, x + 16, y + 6, 4, CYAN, 0.7);
      c.circle(x, y + 6, 4, CYAN, 0.95);
    });
    dial("gauge-afr", "空燃比小表", (c, x, y) => {
      c.circle(x, y, 15, CYAN, 0.9);
      c.circle(x, y, 7, INK, 0.85);
      c.line(x + 15, y, x + 24, y - 8, 4, CYAN, 0.9);
    });
    dial("gauge-fuel", "油量小表", (c, x, y) => {
      c.roundRect(x - 9, y - 16, 18, 26, 4, CYAN, 0.9);
      c.rect(x - 3, y - 21, 6, 6, CYAN, 0.9);
      c.rect(x - 6, y - 12, 12, 10, CYAN, 0.55);
    });

    // --- 行程 / 统计
    mk("trip-a", "行程 A", (c, x, y) => {
      c.roundRect(x - 26, y - 20, 52, 40, 6, CYAN, 0.85);
      c.rect(x - 18, y - 8, 36, 5, INK, 0.7);
      c.rect(x - 18, y + 2, 22, 5, INK, 0.5);
      c.circle(x + 20, y + 14, 5, AMBER, 0.9);
    });
    mk("timer", "计时器", (c, x, y) => {
      c.ring(x, y + 4, 28, 5, CYAN, 0.9);
      c.line(x, y + 4, x, y - 14, 5, CYAN, 0.95);
      c.line(x, y + 4, x + 14, y + 10, 4, CYAN, 0.8);
      c.rect(x - 8, y - 34, 16, 6, CYAN, 0.9);
    });
    mk("range-bars", "续航（电池+格数）", (c, x, y) => {
      c.roundRect(x - 28, y - 14, 44, 28, 5, CYAN, 0.85);
      c.rect(x + 16, y - 6, 8, 12, CYAN, 0.85);
      c.rect(x - 22, y - 8, 22, 16, GREEN, 0.7);
      c.line(x + 24, y - 26, x + 24, y - 16, 4, CYAN, 0.8);
    });
    mk("avg-speed", "平均车速", (c, x, y) => {
      c.arc(x, y, 34, 6, 180, 360, CYAN, 0.9);
      c.line(x, y, x + 18, y - 18, 5, AMBER, 0.95);
      c.circle(x, y, 6, CYAN, 0.9);
    });

    // --- 连接 / 通讯
    mk("gps", "GPS", (c, x, y) => {
      c.ring(x, y, 30, 5, CYAN, 0.9);
      c.line(x - 30, y, x + 30, y, 4, CYAN, 0.6);
      c.line(x, y - 30, x, y + 30, 4, CYAN, 0.6);
      c.ring(x, y, 14, 4, CYAN, 0.8);
      c.circle(x, y, 5, AMBER, 0.95);
    });
    mk("bluetooth", "蓝牙", (c, x, y) => {
      c.line(x, y - 30, x, y + 30, 6, CYAN, 0.95);
      c.line(x, y - 30, x + 20, y - 12, 6, CYAN, 0.95);
      c.line(x + 20, y - 12, x - 14, y + 12, 6, CYAN, 0.95);
      c.line(x, y + 30, x + 20, y + 12, 6, CYAN, 0.95);
      c.line(x + 20, y + 12, x - 14, y - 12, 6, CYAN, 0.95);
    });
    mk("wifi", "Wi-Fi", (c, x, y) => {
      for (let i = 1; i <= 3; i++) c.arc(x, y + 24, i * 14, 5, 205, 335, CYAN, 0.9 - i * 0.12);
      c.circle(x, y + 24, 6, CYAN, 0.95);
    });
    mk("usb", "USB", (c, x, y) => {
      c.roundRect(x - 30, y - 8, 60, 26, 5, CYAN, 0.85);
      c.rect(x - 22, y + 18, 10, 12, CYAN, 0.85);
      c.line(x - 18, y - 8, x - 18, y - 22, 5, CYAN, 0.9);
      c.circle(x - 18, y - 24, 5, CYAN, 0.9);
    });

    // --- 车身
    mk("door-open", "车门未关", (c, x, y) => {
      c.line(x - 28, y + 30, x + 24, y + 30, 6, AMBER, 0.9);
      c.line(x - 28, y + 30, x - 28, y - 26, 6, AMBER, 0.9);
      c.poly([[x - 24, y - 24], [x + 26, y - 34], [x + 26, y + 22], [x - 24, y + 26]], AMBER, 0.55);
      c.circle(x + 16, y - 2, 4, AMBER, 0.95);
    });
    mk("wiper", "雨刷", (c, x, y) => {
      c.line(x - 26, y + 26, x + 10, y - 24, 6, CYAN, 0.9);
      c.line(x + 10, y - 24, x + 20, y + 4, 5, CYAN, 0.8);
      c.circle(x - 26, y + 26, 6, CYAN, 0.9);
      c.arc(x, y + 26, 40, 3, 200, 340, CYAN, 0.4);
    });
    mk("mirror", "后视镜", (c, x, y) => {
      c.roundRect(x - 28, y - 18, 44, 30, 6, CYAN, 0.85);
      c.line(x + 16, y - 3, x + 28, y - 3, 5, CYAN, 0.85);
      c.line(x + 28, y - 3, x + 28, y + 22, 5, CYAN, 0.85);
      c.circle(x + 28, y + 24, 5, CYAN, 0.85);
    });
    mk("ac", "空调", (c, x, y) => {
      c.circle(x, y, 8, CYAN, 0.95);
      for (let i = 0; i < 6; i++) {
        const p0 = P(x, y, 14, i * 60), p1 = P(x, y, 34, i * 60);
        c.line(p0[0], p0[1], p1[0], p1[1], 5, CYAN, 0.9);
        const p2 = P(x, y, 30, i * 60 + 25);
        c.line(p1[0], p1[1], p2[0], p2[1], 4, CYAN, 0.7);
      }
    });
    mk("defrost", "除霜", (c, x, y) => {
      c.arc(x, y + 12, 34, 6, 200, 340, CYAN, 0.9);
      for (let i = 0; i < 3; i++) {
        const bx = x - 20 + i * 20;
        c.line(bx, y - 6, bx - 6, y - 26, 5, RED, 0.85);
        c.line(bx - 6, y - 26, bx, y - 44, 5, RED, 0.85);
      }
    });

    // --- 多媒体
    mk("music", "音乐", (c, x, y) => {
      c.circle(x - 16, y + 18, 11, CYAN, 0.9);
      c.circle(x + 18, y + 8, 11, CYAN, 0.9);
      c.line(x - 5, y + 18, x - 5, y - 30, 6, CYAN, 0.9);
      c.line(x + 29, y + 8, x + 29, y - 38, 6, CYAN, 0.9);
      c.line(x - 5, y - 30, x + 29, y - 38, 6, CYAN, 0.9);
    });
    mk("nav", "导航", (c, x, y) => {
      c.poly([[x, y - 36], [x + 26, y + 30], [x, y + 14], [x - 26, y + 30]], CYAN, 0.92);
    });
    mk("phone", "电话", (c, x, y) => {
      c.roundRect(x - 16, y - 34, 32, 68, 8, CYAN, 0.88);
      c.rect(x - 11, y - 26, 22, 44, INK, 0.7);
      c.circle(x, y + 25, 5, CYAN, 0.9);
    });
    mk("settings", "设置", (c, x, y) => {
      c.ring(x, y, 16, 7, CYAN, 0.9);
      for (let i = 0; i < 8; i++) {
        const p0 = P(x, y, 22, i * 45), p1 = P(x, y, 34, i * 45);
        c.line(p0[0], p0[1], p1[0], p1[1], 9, CYAN, 0.9);
      }
      c.circle(x, y, 6, INK, 0.85);
    });

    // --- 数据 / 状态
    mk("check", "正常 / 通过", (c, x, y) => {
      c.ring(x, y, 40, 5, GREEN, 0.9);
      c.line(x - 18, y + 2, x - 4, y + 18, 7, GREEN, 0.95);
      c.line(x - 4, y + 18, x + 22, y - 18, 7, GREEN, 0.95);
    });
    mk("cross", "故障 / 失败", (c, x, y) => {
      c.ring(x, y, 40, 5, RED, 0.9);
      c.line(x - 16, y - 16, x + 16, y + 16, 7, RED, 0.95);
      c.line(x + 16, y - 16, x - 16, y + 16, 7, RED, 0.95);
    });
    mk("alert", "警告", (c, x, y) => {
      c.poly([[x, y - 38], [x + 38, y + 30], [x - 38, y + 30]], AMBER, 0.9);
      c.line(x, y - 16, x, y + 8, 7, INK, 0.9);
      c.circle(x, y + 20, 5, INK, 0.9);
    });
    mk("info", "信息", (c, x, y) => {
      c.circle(x, y, 38, CYAN, 0.88);
      c.circle(x, y - 20, 6, INK, 0.9);
      c.rect(x - 5, y - 8, 10, 30, INK, 0.9);
    });
    mk("signal", "信号强度", (c, x, y) => {
      for (let i = 0; i < 4; i++) {
        const h = 12 + i * 12;
        c.roundRect(x - 30 + i * 18, y + 30 - h, 11, h, 3, i < 3 ? CYAN : GREY_MID, i < 3 ? 0.9 : 0.6);
      }
    });
    mk("battery-level", "电量条", (c, x, y) => {
      c.roundRect(x - 40, y - 18, 72, 36, 6, CYAN, 0.85);
      c.rect(x + 32, y - 8, 8, 16, CYAN, 0.85);
      for (let i = 0; i < 4; i++) c.rect(x - 34 + i * 16, y - 12, 12, 24, i < 3 ? GREEN : GREY_MID, i < 3 ? 0.8 : 0.4);
    });
  }

  // ================================================================ 转向 / 灯光指示（第三批）
  function genTurn3() {
    const S = 128, cx = 64, cy = 64;
    const arrow = (name, note, dir, color) => {
      const c = new Canvas(S, S);
      const s = dir; // -1 左 / +1 右
      const pts = [
        [cx + s * 44, cy], [cx + s * 6, cy - 30], [cx + s * 6, cy - 12],
        [cx - s * 40, cy - 12], [cx - s * 40, cy + 12], [cx + s * 6, cy + 12], [cx + s * 6, cy + 30],
      ];
      c.poly(pts, color, 0.95);
      save("turn", name, c, note);
    };
    arrow("turn-left-solid", "左转（实心·旧色，建议用琥珀版）", -1, GREEN);
    arrow("turn-right-solid", "右转（实心·旧色，建议用琥珀版）", 1, GREEN);

    {
      const c = new Canvas(S, S);
      // 空心左转
      c.arc(cx, cy, 40, 5, 130, 230, GREEN, 0.9);
      c.line(cx - 4, cy - 26, cx - 4, cy + 26, 6, GREEN, 0.9);
      c.line(cx - 4, cy, cx - 40, cy, 6, GREEN, 0.9);
      c.poly([[cx - 40, cy], [cx - 24, cy - 14], [cx - 24, cy + 14]], GREEN, 0.95);
      save("turn", "turn-left-outline", c, "左转（空心·旧色，建议用琥珀版）");
    }
    {
      const c = new Canvas(S, S);
      c.arc(cx, cy, 40, 5, -50, 50, GREEN, 0.9);
      c.line(cx + 4, cy - 26, cx + 4, cy + 26, 6, GREEN, 0.9);
      c.line(cx + 4, cy, cx + 40, cy, 6, GREEN, 0.9);
      c.poly([[cx + 40, cy], [cx + 24, cy - 14], [cx + 24, cy + 14]], GREEN, 0.95);
      save("turn", "turn-right-outline", c, "右转（空心·旧色，建议用琥珀版）");
    }
    {
      const c = new Canvas(S, S);
      // 双闪：两个箭头
      const tri = (s) => c.poly([
        [cx + s * 36, cy], [cx + s * 12, cy - 22], [cx + s * 12, cy - 8],
        [cx - s * 20, cy - 8], [cx - s * 20, cy + 8], [cx + s * 12, cy + 8], [cx + s * 12, cy + 22],
      ], GREEN, 0.9);
      tri(-1); tri(1);
      save("turn", "hazard-solid", c, "双闪（两个箭头）");
    }
    {
      const c = new Canvas(S, S);
      // 倒车灯
      c.roundRect(30, 48, 68, 34, 8, WHITE, 0.9);
      c.poly([[56, 74], [56, 56], [76, 65]], WHITE, 0.95);
      save("turn", "reverse", c, "倒车灯");
    }
    {
      const c = new Canvas(S, S);
      // 日行灯
      c.roundRect(28, 52, 72, 24, 10, WHITE, 0.85);
      c.line(40, 64, 88, 64, 8, WHITE, 0.95);
      save("turn", "drl", c, "日间行车灯");
    }
    {
      const c = new Canvas(S, S);
      // 刹车灯
      c.roundRect(28, 50, 72, 28, 8, RED, 0.9);
      c.line(38, 64, 90, 64, 8, RED, 0.6);
      save("turn", "brake-light", c, "刹车灯");
    }
    {
      const c = new Canvas(S, S);
      // 危险三角
      c.poly([[cx, cy - 38], [cx + 40, cy + 30], [cx - 40, cy + 30]], RED, 0.92);
      c.line(cx, cy - 16, cx, cy + 6, 7, INK, 0.9);
      c.circle(cx, cy + 18, 5, INK, 0.9);
      save("turn", "hazard-triangle", c, "危险警告三角");
    }
    // ---- 第二批（v2.40.0）：turn 只有 12 个，是现在最薄的分类
    //
    // ⚠️ 现有那批箭头用的是 GREEN。**真实转向灯是琥珀色（AMBER）** ——
    // 绿色在观感上像"日行灯"。所以这批以 AMBER 为主，
    // 让做主题的人有正确的默认选项（原来的绿色版本保留，不删）。
    arrow("turn-left-amber", "左转（琥珀，实心）", -1, AMBER);
    arrow("turn-right-amber", "右转（琥珀，实心）", 1, AMBER);

    // 带外圈闪烁环 —— 转向灯在工作时是"闪"的，静态主题里用环表达
    [-1, 1].forEach(function (s) {
      const c = new Canvas(S, S);
      const pts = [
        [cx + s * 40, cy], [cx + s * 6, cy - 26], [cx + s * 6, cy - 10],
        [cx - s * 34, cy - 10], [cx - s * 34, cy + 10], [cx + s * 6, cy + 10], [cx + s * 6, cy + 26],
      ];
      c.arc(cx, cy, 52, 4, 0, 360, AMBER, 0.35);
      c.poly(pts, AMBER, 0.95);
      save("turn", s < 0 ? "turn-left-blink" : "turn-right-blink", c,
        (s < 0 ? "左转" : "右转") + "（带闪烁环）");
    });

    // 双箭头（并线 / 变道提示）
    [-1, 1].forEach(function (s) {
      const c = new Canvas(S, S);
      [0, 1].forEach(function (k) {
        const off = k * 26;
        c.poly([
          [cx + s * (40 - off), cy], [cx + s * (16 - off), cy - 16], [cx + s * (16 - off), cy - 6],
          [cx - s * (22 - off), cy - 6], [cx - s * (22 - off), cy + 6],
          [cx + s * (16 - off), cy + 6], [cx + s * (16 - off), cy + 16],
        ], AMBER, 0.9);
      });
      save("turn", s < 0 ? "turn-left-double" : "turn-right-double", c,
        (s < 0 ? "左转" : "右转") + "（双箭头）");
    });

    // ---- 其它灯具（原来只有 drl / brake-light / reverse）
    {
      const c = new Canvas(S, S);
      // 前雾灯：光束向下斜射 + 波浪线（ISO 2575 的通用形状）
      c.line(cx - 34, cy - 16, cx + 34, cy - 16, 7, AMBER, 0.9);
      for (let i = -2; i <= 2; i++) {
        c.line(cx + i * 14, cy - 6, cx + i * 14, cy + 20, 5, AMBER, 0.9);
        c.arc(cx + i * 14, cy + 22, 7, 4, 180, 360, AMBER, 0.9);
      }
      save("turn", "fog-front", c, "前雾灯");
    }
    {
      const c = new Canvas(S, S);
      // 后雾灯：光束水平 + 右侧竖线（与"前雾灯朝下"区分开）
      c.line(cx - 30, cy, cx + 18, cy, 7, RED, 0.9);
      for (let i = -1; i <= 1; i++) {
        c.line(cx - 30, cy + i * 16, cx + 18, cy + i * 16, 5, RED, 0.9);
      }
      c.line(cx + 30, cy - 26, cx + 30, cy + 26, 6, RED, 0.9);
      save("turn", "fog-rear", c, "后雾灯");
    }
    {
      const c = new Canvas(S, S);
      // 远光：水平光束 + 斜线（近光是斜向下的，远光是平的）
      c.line(cx - 34, cy, cx + 22, cy, 6, CYAN, 0.95);
      for (let i = -2; i <= 2; i++) c.line(cx - 20 + i * 3, cy + i * 11, cx + 30, cy + i * 11, 4, CYAN, 0.9);
      save("turn", "high-beam", c, "远光");
    }
    {
      const c = new Canvas(S, S);
      // 示宽灯：左右两个小方块 + 中间的横向连接
      c.rect(cx - 42, cy - 10, 20, 20, AMBER, 0.95);
      c.rect(cx + 22, cy - 10, 20, 20, AMBER, 0.95);
      c.line(cx - 22, cy, cx + 22, cy, 6, AMBER, 0.7);
      save("turn", "position-light", c, "示宽灯");
    }
    {
      const c = new Canvas(S, S);
      // 双闪（空心双三角，与实心的 hazard-solid 配对）
      [[-1, 0.9], [1, 0.55]].forEach(function (q) {
        const s = q[0], al = q[1];
        const o = s * 18;
        c.poly([[cx + o, cy - 32], [cx + o + 26, cy + 18], [cx + o - 26, cy + 18]], AMBER, al * 0.25);
        c.line(cx + o - 26, cy + 18, cx + o, cy - 32, 5, AMBER, al);
        c.line(cx + o, cy - 32, cx + o + 26, cy + 18, 5, AMBER, al);
        c.line(cx + o + 26, cy + 18, cx + o - 26, cy + 18, 5, AMBER, al);
      });
      save("turn", "hazard-outline", c, "双闪（空心）");
    }
  }

  // ================================================================ 指针（第三批）
  function genNeedles3() {
    // 指针统一 48×192，轴心在下方 1/2 处（与既有约定一致）
    const W = 48, H = 192;
    const mk = (name, note, draw) => {
      const c = new Canvas(W, H);
      draw(c, W / 2);
      save("needle", name, c, note);
    };

    mk("needle-hair", "细针", (c, x) => {
      c.line(x, 188, x, 14, 4, AMBER, 0.95);
      c.poly([[x, 8], [x - 8, 26], [x + 8, 26]], AMBER, 0.95);
    });
    mk("needle-fat", "粗针", (c, x) => {
      c.poly([[x, 10], [x - 11, 176], [x + 11, 176]], AMBER, 0.92);
    });
    mk("needle-long", "长针（占满）", (c, x) => {
      c.poly([[x, 4], [x - 6, 190], [x + 6, 190]], AMBER, 0.9);
    });
    mk("needle-chevron", "人字针", (c, x) => {
      c.line(x, 186, x, 30, 6, AMBER, 0.95);
      c.line(x - 12, 52, x, 30, 6, AMBER, 0.95);
      c.line(x + 12, 52, x, 30, 6, AMBER, 0.95);
    });
    mk("needle-taper", "锥形针", (c, x) => {
      c.poly([[x, 6], [x - 9, 186], [x + 9, 186]], AMBER, 0.9);
      c.circle(x, 172, 12, AMBER, 0.95);
    });
    mk("needle-glow", "发光针", (c, x) => {
      c.line(x, 186, x, 16, 16, AMBER, 0.18);
      c.line(x, 186, x, 16, 9, AMBER, 0.4);
      c.line(x, 186, x, 16, 5, AMBER, 0.98);
      c.circle(x, 18, 7, WHITE, 0.95);
    });
    mk("needle-carbon", "碳纤维针", (c, x) => {
      c.poly([[x, 10], [x - 8, 184], [x + 8, 184]], GREY_DARK, 0.95);
      for (let i = 0; i < 14; i++) {
        const y = 24 + i * 11;
        c.line(x - 7, y, x + 7, y - 5, 2, GREY_MID, 0.7);
      }
      c.poly([[x, 10], [x - 8, 184], [x + 8, 184]], AMBER, 0.25);
    });
    mk("needle-red", "红色针", (c, x) => {
      c.poly([[x, 10], [x - 8, 184], [x + 8, 184]], RED, 0.95);
      c.circle(x, 168, 11, RED, 0.98);
      c.circle(x, 168, 5, INK, 0.7);
    });
    mk("needle-white", "白色针", (c, x) => {
      c.poly([[x, 10], [x - 7, 184], [x + 7, 184]], WHITE, 0.95);
      c.circle(x, 168, 10, WHITE, 0.98);
    });
    mk("needle-dot-tip", "圆头针", (c, x) => {
      c.line(x, 182, x, 24, 7, AMBER, 0.95);
      c.circle(x, 20, 11, AMBER, 0.98);
      c.circle(x, 20, 5, WHITE, 0.9);
    });
    mk("needle-blade-l", "长刀锋", (c, x) => {
      c.poly([[x - 2, 6], [x + 5, 180], [x - 7, 180]], AMBER, 0.92);
      c.circle(x, 172, 9, AMBER, 0.95);
    });
    mk("needle-twin", "双叉针", (c, x) => {
      c.line(x - 9, 184, x - 5, 20, 6, AMBER, 0.92);
      c.line(x + 9, 184, x + 5, 20, 6, AMBER, 0.92);
      c.line(x - 5, 20, x + 5, 20, 5, AMBER, 0.92);
    });
    mk("needle-arc", "弧形针", (c, x) => {
      c.arc(x, 170, 150, 6, 268, 272, AMBER, 0.95);
      c.circle(x, 20, 8, AMBER, 0.98);
      c.circle(x, 170, 12, AMBER, 0.95);
    });
    mk("needle-cap", "轴心盖", (c, x) => {
      c.circle(x, 96, 22, GREY_DARK, 0.95);
      c.circle(x, 96, 16, GREY_MID, 0.9);
      c.circle(x, 96, 8, INK, 0.85);
      c.ring(x, 96, 22, 3, AMBER, 0.5);
    });
  }

  // ================================================================ 刻度（第三批）
  function genScales3() {
    const S = 256, cx = 128, cy = 128;
    const mk = (name, note, draw) => {
      const c = new Canvas(S, S);
      draw(c, cx, cy);
      save("scale", name, c, note);
    };

    // 不同密度的径向刻度
    [30, 45, 90, 120].forEach((n) => {
      mk("ticks-" + n + "f", n + " 格径向刻度", (c, x, y) => {
        radialTicks(c, x, y, 118, n, 10, 3, GREY, 0.85, 135, 405, 0);
      });
    });
    mk("ticks-major-minor", "主次刻度（每 5 格加长）", (c, x, y) => {
      radialTicks(c, x, y, 118, 51, 9, 3, GREY, 0.75, 135, 405, 5);
    });
    mk("ticks-arc-outer", "外侧弧形刻度", (c, x, y) => {
      c.arc(x, y, 118, 3, 135, 405, GREY, 0.55);
      radialTicks(c, x, y, 112, 25, 12, 4, CYAN, 0.9, 135, 405, 5);
    });
    mk("ticks-arc-inner", "内侧弧形刻度", (c, x, y) => {
      c.arc(x, y, 82, 3, 135, 405, GREY, 0.55);
      radialTicks(c, x, y, 92, 25, 12, 4, CYAN, 0.9, 135, 405, 5);
    });
    mk("ticks-radial-glow", "发光刻度", (c, x, y) => {
      radialTicks(c, x, y, 120, 21, 18, 12, CYAN, 0.14, 135, 405, 5);
      radialTicks(c, x, y, 120, 21, 14, 5, CYAN, 0.95, 135, 405, 5);
    });
    mk("ticks-band", "带状刻度（红区示意）", (c, x, y) => {
      c.arc(x, y, 108, 22, 135, 300, GREY, 0.35);
      c.arc(x, y, 108, 22, 300, 360, RED, 0.6);
      c.arc(x, y, 108, 22, 360, 405, GREY, 0.35);
    });
    mk("ticks-gradient", "渐变刻度", (c, x, y) => {
      radialTicks(c, x, y, 116, 41, 12, 5, CYAN, 0.9, 135, 405, 0);
      radialTicks(c, x, y, 116, 41, 12, 5, AMBER, 0.35, 300, 405, 0);
    });
    mk("ticks-segment-20", "20 段分段弧", (c, x, y) => {
      for (let i = 0; i < 20; i++) {
        const a0 = 135 + (270 / 20) * i + 2, a1 = 135 + (270 / 20) * (i + 1) - 2;
        c.arc(x, y, 110, 16, a0, a1, i >= 15 ? RED : CYAN, i >= 15 ? 0.7 : 0.8);
      }
    });
    mk("ticks-segment-40", "40 段分段弧", (c, x, y) => {
      for (let i = 0; i < 40; i++) {
        const a0 = 135 + (270 / 40) * i + 1.2, a1 = 135 + (270 / 40) * (i + 1) - 1.2;
        c.arc(x, y, 110, 14, a0, a1, CYAN, 0.85);
      }
    });
    mk("ticks-dot-arc", "点阵弧刻度", (c, x, y) => {
      for (let i = 0; i < 31; i++) {
        const p = P(x, y, 112, 135 + (270 / 30) * i);
        c.circle(p[0], p[1], i % 5 === 0 ? 6 : 3, i % 5 === 0 ? AMBER : GREY, 0.9);
      }
    });
    mk("ticks-bar-h", "水平条刻度", (c, x, y) => {
      for (let i = 0; i <= 20; i++) {
        const bx = 24 + i * 10.4;
        c.rect(bx, i % 5 === 0 ? 40 : 56, 3, i % 5 === 0 ? 48 : 32, GREY, 0.85);
      }
    });
    mk("ticks-bar-v", "垂直条刻度", (c, x, y) => {
      for (let i = 0; i <= 20; i++) {
        const by = 232 - i * 10.4;
        c.rect(i % 5 === 0 ? 40 : 56, by, i % 5 === 0 ? 48 : 32, 3, GREY, 0.85);
      }
    });
    mk("ticks-corner", "角部刻度", (c, x, y) => {
      c.arc(x, y, 116, 4, 135, 405, GREY, 0.5);
      c.arc(x, y, 104, 4, 135, 405, GREY, 0.35);
      radialTicks(c, x, y, 116, 13, 16, 5, CYAN, 0.9, 135, 405, 4);
    });
  }

  // ================================================================ 表盘（第三批）
  function genDashboards3() {
    const S = 256, cx = 128, cy = 128;
    const mk = (name, note, draw) => {
      const c = new Canvas(S, S);
      draw(c, cx, cy);
      save("dashboard", name, c, note);
    };

    mk("dial-full", "整圆表盘", (c, x, y) => {
      c.circle(x, y, 124, GREY_DARK, 0.95);
      c.ring(x, y, 124, 4, GREY_MID, 0.9);
      c.ring(x, y, 106, 3, CYAN_DIM, 0.6);
    });
    mk("dial-270", "270° 表盘（下方开口）", (c, x, y) => {
      c.arc(x, y, 118, 28, 135, 405, GREY_DARK, 0.95);
      c.arc(x, y, 118, 4, 135, 405, GREY_MID, 0.9);
    });
    mk("dial-180", "180° 半圆表盘", (c, x, y) => {
      c.arc(x, y, 118, 30, 180, 360, GREY_DARK, 0.95);
      c.arc(x, y, 118, 4, 180, 360, GREY_MID, 0.9);
      c.rect(24, y + 10, 208, 6, GREY_MID, 0.7);
    });
    mk("dial-120", "120° 弧表盘", (c, x, y) => {
      c.arc(x, y + 40, 100, 26, 210, 330, GREY_DARK, 0.95);
      c.arc(x, y + 40, 100, 4, 210, 330, GREY_MID, 0.9);
    });
    mk("dial-octagon", "八边形表盘", (c, x, y) => {
      c.poly(ngon(x, y, 122, 8, -112.5), GREY_DARK, 0.95);
      c.poly(ngon(x, y, 122, 8, -112.5), GREY_MID, 0.12);
      c.ring(x, y, 100, 3, CYAN_DIM, 0.5);
    });
    mk("dial-capsule", "胶囊表盘", (c, x, y) => {
      c.roundRect(24, 68, 208, 120, 60, GREY_DARK, 0.95);
      c.roundRect(24, 68, 208, 120, 60, GREY_MID, 0.14);
    });
    mk("dial-split", "左右分体表盘", (c, x, y) => {
      c.arc(x - 60, y, 58, 26, 100, 260, GREY_DARK, 0.95);
      c.arc(x + 60, y, 58, 26, -80, 80, GREY_DARK, 0.95);
      c.ring(x - 60, y, 58, 3, GREY_MID, 0.8);
      c.ring(x + 60, y, 58, 3, GREY_MID, 0.8);
    });
    mk("dial-twin", "双联表盘", (c, x, y) => {
      c.circle(x - 62, y, 60, GREY_DARK, 0.95);
      c.circle(x + 62, y, 60, GREY_DARK, 0.95);
      c.ring(x - 62, y, 60, 4, GREY_MID, 0.85);
      c.ring(x + 62, y, 60, 4, GREY_MID, 0.85);
    });
    mk("dial-triple", "三联表盘", (c, x, y) => {
      [-78, 0, 78].forEach((dx, i) => {
        c.circle(x + dx, y, i === 1 ? 62 : 46, GREY_DARK, 0.95);
        c.ring(x + dx, y, i === 1 ? 62 : 46, 4, GREY_MID, 0.85);
      });
    });
    mk("dial-open-bottom", "底部开窗表盘", (c, x, y) => {
      c.arc(x, y, 120, 30, 200, 340, GREY_DARK, 0.95);
      c.arc(x, y, 120, 30, 20, 160, GREY_DARK, 0.95);
      c.rect(98, 176, 60, 46, GREY_DARK, 0.95);
      c.ring(x, y, 96, 3, CYAN_DIM, 0.45);
    });
    mk("dial-ring-double", "双环表盘", (c, x, y) => {
      c.ring(x, y, 120, 6, GREY_MID, 0.9);
      c.ring(x, y, 96, 4, CYAN_DIM, 0.6);
      c.circle(x, y, 88, GREY_DARK, 0.5);
    });
    mk("dial-ring-triple", "三环表盘", (c, x, y) => {
      c.ring(x, y, 122, 5, GREY_MID, 0.9);
      c.ring(x, y, 100, 4, CYAN_DIM, 0.55);
      c.ring(x, y, 78, 3, GREY_MID, 0.45);
    });
    mk("dial-carbon", "碳纤维表盘", (c, x, y) => {
      c.circle(x, y, 124, GREY_DARK, 0.98);
      for (let i = 0; i < 200; i++) {
        const px = (i * 37) % 248, py = (i * 71) % 248;
        if (Math.hypot(px - x, py - y) < 122) c.line(px, py, px + 8, py - 8, 2, GREY_MID, 0.35);
      }
      c.ring(x, y, 122, 4, GREY_MID, 0.9);
    });
    mk("dial-notch", "带缺口表盘", (c, x, y) => {
      c.arc(x, y, 118, 28, 138, 402, GREY_DARK, 0.95);
      c.arc(x, y, 118, 28, 0, 0.1, GREY_DARK, 0.95);
      c.ring(x, y, 104, 3, CYAN_DIM, 0.5);
    });
    mk("dial-square-round", "圆角方表盘", (c, x, y) => {
      c.roundRect(14, 14, 228, 228, 34, GREY_DARK, 0.95);
      c.roundRect(14, 14, 228, 228, 34, GREY_MID, 0.13);
      c.roundRect(34, 34, 188, 188, 24, INK, 0.35);
    });
  }

  // ================================================================ 品牌 / 徽标（**通用形状，非真实车标**）
  function genBrand3() {
    const S = 128, cx = 64, cy = 64;
    const mk = (name, note, draw) => {
      const c = new Canvas(S, S);
      draw(c, cx, cy);
      save("brand", name, c, note);
    };

    mk("roundel", "圆环徽标", (c, x, y) => {
      c.circle(x, y, 52, GREY_DARK, 0.95);
      c.ring(x, y, 52, 6, CYAN_DIM, 0.9);
      c.ring(x, y, 34, 4, CYAN, 0.75);
      c.circle(x, y, 14, CYAN, 0.9);
    });
    mk("shield-2", "盾形徽标（带分割）", (c, x, y) => {
      const pts = [];
      for (let i = 0; i <= 32; i++) {
        const a = Math.PI * (1 + i / 32);
        pts.push([x + Math.cos(a) * 50, y - 14 + Math.sin(a) * 44]);
      }
      pts.push([x, y + 56]);
      c.poly(pts, GREY_DARK, 0.95);
      c.poly(pts.map(([px, py]) => [x + (px - x) * 0.84, y + (py - y) * 0.84]), CYAN_DIM, 0.85);
      c.rect(x - 3, y - 52, 6, 100, INK, 0.5);
    });
    mk("hexagon-badge", "六角徽标", (c, x, y) => {
      c.poly(ngon(x, y, 54, 6, -90), GREY_DARK, 0.95);
      c.poly(ngon(x, y, 46, 6, -90), CYAN_DIM, 0.8);
      c.poly(ngon(x, y, 26, 6, -90), CYAN, 0.85);
    });
    mk("star-5", "五角星", (c, x, y) => {
      const pts = [];
      for (let i = 0; i < 10; i++) pts.push(P(x, y, i % 2 ? 22 : 54, -90 + i * 36));
      c.poly(pts, AMBER, 0.95);
    });
    mk("star-8", "八角星", (c, x, y) => {
      const pts = [];
      for (let i = 0; i < 16; i++) pts.push(P(x, y, i % 2 ? 20 : 54, -90 + i * 22.5));
      c.poly(pts, CYAN, 0.92);
    });
    mk("lightning-badge", "闪电徽标", (c, x, y) => {
      c.poly(ngon(x, y, 54, 6, -90), GREY_DARK, 0.95);
      c.poly([[x + 12, y - 40], [x - 20, y + 6], [x - 2, y + 6], [x - 12, y + 42], [x + 22, y - 8], [x + 4, y - 8]], AMBER, 0.98);
    });
    mk("diamond", "菱形徽标", (c, x, y) => {
      c.poly(ngon(x, y, 54, 4, -90), GREY_DARK, 0.95);
      c.poly(ngon(x, y, 44, 4, -90), CYAN_DIM, 0.8);
      c.poly(ngon(x, y, 20, 4, -90), CYAN, 0.9);
    });
    mk("wing-l", "左翼（可镜像拼成对）", (c, x, y) => {
      const pts = [[x + 44, y], [x - 10, y - 26], [x - 44, y - 30], [x - 30, y - 6], [x - 46, y + 4], [x - 22, y + 10], [x - 34, y + 26], [x + 6, y + 16], [x + 44, y + 12]];
      c.poly(pts, CYAN_DIM, 0.9);
      c.poly(pts.map(([px, py]) => [x + (px - x) * 0.82, y + (py - y) * 0.82]), CYAN, 0.75);
    });
    mk("wing-r", "右翼（可镜像拼成对）", (c, x, y) => {
      const pts = [[x - 44, y], [x + 10, y - 26], [x + 44, y - 30], [x + 30, y - 6], [x + 46, y + 4], [x + 22, y + 10], [x + 34, y + 26], [x - 6, y + 16], [x - 44, y + 12]];
      c.poly(pts, CYAN_DIM, 0.9);
      c.poly(pts.map(([px, py]) => [x + (px - x) * 0.82, y + (py - y) * 0.82]), CYAN, 0.75);
    });
    mk("crest", "冠冕徽标", (c, x, y) => {
      c.poly([[x - 46, y + 26], [x - 46, y - 12], [x - 24, y + 6], [x, y - 28], [x + 24, y + 6], [x + 46, y - 12], [x + 46, y + 26]], AMBER, 0.92);
      c.rect(x - 46, y + 32, 92, 8, AMBER, 0.85);
      c.circle(x, y - 34, 7, AMBER, 0.95);
    });
    mk("laurel", "月桂环", (c, x, y) => {
      for (let s = -1; s <= 1; s += 2) {
        for (let i = 0; i < 7; i++) {
          const a = 200 + i * 22;
          const p = P(x, y + 10, 46, s > 0 ? -a : a - 180);
          c.poly([[p[0], p[1]], [p[0] + s * 12, p[1] - 10], [p[0] + s * 4, p[1] + 6]], AMBER, 0.9);
        }
      }
      c.circle(x, y - 6, 18, CYAN, 0.85);
    });
    mk("gear-crest", "齿轮徽标", (c, x, y) => {
      c.ring(x, y, 40, 12, GREY_MID, 0.9);
      for (let i = 0; i < 10; i++) {
        const p0 = P(x, y, 42, i * 36), p1 = P(x, y, 54, i * 36);
        c.line(p0[0], p0[1], p1[0], p1[1], 11, GREY_MID, 0.9);
      }
      c.circle(x, y, 24, GREY_DARK, 0.95);
      c.circle(x, y, 12, CYAN, 0.9);
    });
    mk("plate-badge", "铭牌底（放文字用）", (c, x, y) => {
      c.roundRect(8, 42, 112, 44, 8, GREY_DARK, 0.95);
      c.roundRect(8, 42, 112, 44, 8, GREY_MID, 0.2);
      c.line(18, 64, 110, 64, 3, CYAN_DIM, 0.6);
    });
  }

  // ================================================================ 条形表轨道 / 填充（新分类 bar）
  function genBars() {
    const mk = (name, note, w, h, draw) => {
      const c = new Canvas(w, h);
      draw(c, w, h);
      save("bar", name, c, note);
    };

    mk("track-h", "水平轨道", 256, 24, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.95);
      capsule(c, 2, 2, w - 4, h - 4, GREY_MID, 0.25);
    });
    mk("track-v", "垂直轨道", 24, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.95);
      capsule(c, 2, 2, w - 4, h - 4, GREY_MID, 0.25);
    });
    mk("fill-h", "水平填充", 256, 24, (c, w, h) => {
      capsule(c, 0, 0, w, h, CYAN, 0.92);
      capsule(c, 3, 3, w - 6, h * 0.35, WHITE, 0.25);
    });
    mk("fill-v", "垂直填充", 24, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, CYAN, 0.92);
      capsule(c, 3, 3, w * 0.35, h - 6, WHITE, 0.25);
    });
    mk("track-glow-h", "发光轨道（水平）", 256, 28, (c, w, h) => {
      capsule(c, 0, 4, w, h - 8, CYAN, 0.16);
      capsule(c, 0, 8, w, h - 16, CYAN, 0.35);
      capsule(c, 0, 11, w, h - 22, CYAN, 0.95);
    });
    mk("track-glow-v", "发光轨道（垂直）", 28, 256, (c, w, h) => {
      capsule(c, 4, 0, w - 8, h, CYAN, 0.16);
      capsule(c, 8, 0, w - 16, h, CYAN, 0.35);
      capsule(c, 11, 0, w - 22, h, CYAN, 0.95);
    });
    mk("track-dashed-h", "虚线轨道（水平）", 256, 24, (c, w, h) => {
      for (let i = 0; i < 16; i++) capsule(c, i * 16 + 2, 4, 11, h - 8, GREY_MID, 0.8);
    });
    mk("track-dashed-v", "虚线轨道（垂直）", 24, 256, (c, w, h) => {
      for (let i = 0; i < 16; i++) capsule(c, 4, i * 16 + 2, w - 8, 11, GREY_MID, 0.8);
    });
    mk("track-gradient-h", "渐变轨道（水平）", 256, 24, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.95);
      c.fill((x, y) => (y > 2 && y < h - 2 ? [0, 216, 255, 0.10 + 0.5 * (x / w)] : null));
    });
    mk("track-gradient-v", "渐变轨道（垂直）", 24, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.95);
      c.fill((x, y) => (x > 2 && x < w - 2 ? [0, 216, 255, 0.10 + 0.5 * (y / h)] : null));
    });
    mk("marker-h", "标记点（水平）", 12, 32, (c, w, h) => {
      c.roundRect(0, 0, w, h, 4, WHITE, 0.95);
      c.roundRect(2, 2, w - 4, h - 4, 3, CYAN, 0.9);
    });
    mk("marker-v", "标记点（垂直）", 32, 12, (c, w, h) => {
      c.roundRect(0, 0, w, h, 4, WHITE, 0.95);
      c.roundRect(2, 2, w - 4, h - 4, 3, CYAN, 0.9);
    });
    mk("segment-10-h", "10 段条（水平）", 256, 24, (c, w, h) => {
      for (let i = 0; i < 10; i++) capsule(c, i * 25.6 + 2, 2, 21.6, h - 4, i < 7 ? CYAN : RED, i < 7 ? 0.85 : 0.75);
    });
    mk("segment-10-v", "10 段条（垂直）", 24, 256, (c, w, h) => {
      for (let i = 0; i < 10; i++) capsule(c, 2, i * 25.6 + 2, w - 4, 21.6, i < 7 ? CYAN : RED, i < 7 ? 0.85 : 0.75);
    });
    mk("segment-20-h", "20 段条（水平）", 256, 20, (c, w, h) => {
      for (let i = 0; i < 20; i++) capsule(c, i * 12.8 + 1.5, 2, 9.8, h - 4, CYAN, 0.8);
    });
    mk("segment-20-v", "20 段条（垂直）", 20, 256, (c, w, h) => {
      for (let i = 0; i < 20; i++) capsule(c, 2, i * 12.8 + 1.5, w - 4, 9.8, CYAN, 0.8);
    });
    // ---- 第二批（v2.39.0）：bar 只有 16 个，与它 6 个控件的用量不匹配
    mk("track-thin-h", "细轨道（水平）", 256, 10, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.9);
      capsule(c, 1, 1, w - 2, h - 2, GREY_MID, 0.3);
    });
    mk("track-thin-v", "细轨道（垂直）", 10, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.9);
      capsule(c, 1, 1, w - 2, h - 2, GREY_MID, 0.3);
    });
    mk("track-thick-h", "粗轨道（水平）", 256, 44, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.95);
      capsule(c, 3, 3, w - 6, h - 6, INK, 0.75);
      capsule(c, 3, 3, w - 6, h - 6, GREY_MID, 0.2);
    });
    mk("track-thick-v", "粗轨道（垂直）", 44, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_DARK, 0.95);
      capsule(c, 3, 3, w - 6, h - 6, INK, 0.75);
      capsule(c, 3, 3, w - 6, h - 6, GREY_MID, 0.2);
    });
    mk("fill-glow-h", "发光填充（水平）", 256, 24, (c, w, h) => {
      capsule(c, 0, 0, w, h, CYAN, 0.18);
      capsule(c, 0, 3, w, h - 6, CYAN, 0.45);
      capsule(c, 0, 6, w, h - 12, CYAN, 0.95);
      capsule(c, 4, 8, w - 8, 4, WHITE, 0.35);
    });
    mk("fill-glow-v", "发光填充（垂直）", 24, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, CYAN, 0.18);
      capsule(c, 3, 0, w - 6, h, CYAN, 0.45);
      capsule(c, 6, 0, w - 12, h, CYAN, 0.95);
      capsule(c, 8, 4, 4, h - 8, WHITE, 0.35);
    });
    mk("track-inset-h", "内凹轨道（水平）", 256, 24, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_MID, 0.35);
      capsule(c, 3, 3, w - 6, h - 6, INK, 0.9);
    });
    mk("track-inset-v", "内凹轨道（垂直）", 24, 256, (c, w, h) => {
      capsule(c, 0, 0, w, h, GREY_MID, 0.35);
      capsule(c, 3, 3, w - 6, h - 6, INK, 0.9);
    });
    mk("track-ticks-h", "带刻度轨道（水平）", 256, 32, (c, w, h) => {
      capsule(c, 0, 8, w, 16, GREY_DARK, 0.9);
      for (let i = 0; i < 21; i++) {
        const long = i % 5 === 0;
        c.rect(i * 12.6, 0, 2, long ? 10 : 6, long ? CYAN : GREY_MID, long ? 0.9 : 0.6);
      }
    });
    mk("track-ticks-v", "带刻度轨道（垂直）", 32, 256, (c, w, h) => {
      capsule(c, 8, 0, 16, h, GREY_DARK, 0.9);
      for (let i = 0; i < 21; i++) {
        const long = i % 5 === 0;
        c.rect(0, i * 12.6, long ? 10 : 6, 2, long ? CYAN : GREY_MID, long ? 0.9 : 0.6);
      }
    });
    mk("segment-5-h", "5 段（水平）", 256, 24, (c, w, h) => {
      for (let i = 0; i < 5; i++) capsule(c, i * 52 + 2, 2, 46, h - 4, GREY_MID, 0.85);
    });
    mk("segment-5-v", "5 段（垂直）", 24, 256, (c, w, h) => {
      for (let i = 0; i < 5; i++) capsule(c, 2, i * 52 + 2, w - 4, 46, GREY_MID, 0.85);
    });
    mk("marker-glow-h", "发光游标（水平）", 16, 40, (c, w, h) => {
      capsule(c, 0, 0, w, h, CYAN, 0.2);
      capsule(c, 3, 4, w - 6, h - 8, CYAN, 0.5);
      capsule(c, 6, 8, w - 12, h - 16, CYAN, 1);
    });
    mk("marker-glow-v", "发光游标（垂直）", 40, 16, (c, w, h) => {
      capsule(c, 0, 0, w, h, CYAN, 0.2);
      capsule(c, 4, 3, w - 8, h - 6, CYAN, 0.5);
      capsule(c, 8, 6, w - 16, h - 12, CYAN, 1);
    });
    mk("fill-gradient-h", "渐变填充（水平）", 256, 24, (c, w, h) => {
      for (let i = 0; i < 32; i++) c.rect(i * 8, 0, 8, h, CYAN, 0.25 + i * 0.023);
      capsule(c, 4, 4, w - 8, 5, WHITE, 0.22);
    });
    mk("fill-gradient-v", "渐变填充（垂直）", 24, 256, (c, w, h) => {
      for (let i = 0; i < 32; i++) c.rect(0, i * 8, w, 8, CYAN, 0.25 + i * 0.023);
      capsule(c, 4, 4, 5, h - 8, WHITE, 0.22);
    });
  }

  // ================================================================ 面板 / 卡片边框（新分类 frame）
  function genFrames() {
    const S = 256;
    const mk = (name, note, draw) => {
      const c = new Canvas(S, S);
      draw(c);
      save("frame", name, c, note);
    };

    mk("frame-simple", "细边框", (c) => {
      c.roundRect(4, 4, 248, 248, 14, GREY_MID, 0.75);
      c.roundRect(8, 8, 240, 240, 12, INK, 0.55);
    });
    mk("frame-double", "双线边框", (c) => {
      c.roundRect(4, 4, 248, 248, 14, GREY_MID, 0.8);
      c.roundRect(14, 14, 228, 228, 10, GREY_MID, 0.45);
    });
    mk("frame-dashed", "虚线边框", (c) => {
      for (let i = 0; i < 26; i++) {
        c.rect(8 + i * 9.5, 4, 6, 4, GREY_MID, 0.8);
        c.rect(8 + i * 9.5, 248, 6, 4, GREY_MID, 0.8);
        c.rect(4, 8 + i * 9.5, 4, 6, GREY_MID, 0.8);
        c.rect(248, 8 + i * 9.5, 4, 6, GREY_MID, 0.8);
      }
    });
    mk("frame-glow", "发光边框", (c) => {
      c.roundRect(2, 2, 252, 252, 16, CYAN, 0.12);
      c.roundRect(6, 6, 244, 244, 14, CYAN, 0.3);
      c.roundRect(11, 11, 234, 234, 12, CYAN, 0.9);
    });
    mk("frame-corners", "四角标记", (c) => {
      const L = 44, T = 5;
      [[6, 6, 1, 1], [250, 6, -1, 1], [6, 250, 1, -1], [250, 250, -1, -1]].forEach(([x, y, sx, sy]) => {
        c.rect(x, y, L * sx, T * sy, CYAN, 0.9);
        c.rect(x, y, T * sx, L * sy, CYAN, 0.9);
      });
    });
    mk("panel-round", "圆角面板", (c) => {
      c.roundRect(6, 6, 244, 244, 20, GREY_DARK, 0.96);
      c.roundRect(6, 6, 244, 244, 20, GREY_MID, 0.16);
    });
    mk("panel-square", "直角面板", (c) => {
      c.rect(6, 6, 244, 244, GREY_DARK, 0.96);
      c.rect(6, 6, 244, 3, GREY_MID, 0.5);
      c.rect(6, 247, 244, 3, GREY_MID, 0.5);
    });
    mk("panel-notch", "带缺口面板", (c) => {
      c.roundRect(6, 6, 244, 244, 16, GREY_DARK, 0.96);
      c.poly([[104, 6], [152, 6], [140, 34], [116, 34]], GREY_MID, 0.7);
    });
    mk("panel-header", "带标题栏面板", (c) => {
      c.roundRect(6, 6, 244, 244, 16, GREY_DARK, 0.96);
      c.roundRect(6, 6, 244, 46, 16, GREY_MID, 0.35);
      c.rect(6, 40, 244, 12, GREY_DARK, 0.9);
      c.line(26, 29, 120, 29, 4, CYAN, 0.8);
    });
    mk("panel-split", "左右分割面板", (c) => {
      c.roundRect(6, 6, 244, 244, 16, GREY_DARK, 0.96);
      c.rect(126, 18, 3, 220, GREY_MID, 0.6);
    });
    mk("frame-carbon", "碳纹边框", (c) => {
      c.roundRect(4, 4, 248, 248, 14, GREY_DARK, 0.98);
      for (let i = 0; i < 160; i++) {
        const px = (i * 53) % 240 + 8, py = (i * 97) % 240 + 8;
        const edge = px < 24 || px > 232 || py < 24 || py > 232;
        if (edge) c.line(px, py, px + 10, py - 10, 3, GREY_MID, 0.4);
      }
      c.roundRect(24, 24, 208, 208, 8, INK, 0.4);
    });
    // ---- 第二批（v2.38.0）：frame 类原来只有 11 个，是最薄的分类
    mk("panel-footer", "带状态栏面板", (c) => {
      c.roundRect(6, 6, 244, 244, 16, GREY_DARK, 0.96);
      c.roundRect(6, 204, 244, 46, 16, GREY_MID, 0.3);
      c.rect(6, 210, 244, 12, GREY_DARK, 0.9);
      c.line(26, 232, 150, 232, 4, CYAN, 0.6);
    });
    mk("panel-tabbed", "带页签面板", (c) => {
      c.roundRect(6, 34, 244, 216, 14, GREY_DARK, 0.96);
      [[14, 108], [114, 108], [214, 108]].forEach(([x, w], i) => {
        c.roundRect(x, 12, w, 30, 8, GREY_MID, i === 0 ? 0.75 : 0.28);
        c.line(x + 16, 27, x + w - 16, 27, 3, i === 0 ? CYAN : GREY_MID, i === 0 ? 0.9 : 0.5);
      });
    });
    mk("panel-inset", "内凹面板", (c) => {
      c.roundRect(2, 2, 252, 252, 18, GREY_MID, 0.22);
      c.roundRect(10, 10, 236, 236, 14, INK, 0.96);
      c.roundRect(10, 10, 236, 236, 14, GREY_MID, 0.14);
    });
    mk("panel-sidebar", "左侧栏面板", (c) => {
      c.roundRect(6, 6, 244, 244, 14, GREY_DARK, 0.96);
      c.roundRect(6, 6, 58, 244, 14, GREY_MID, 0.28);
      c.rect(58, 20, 6, 216, GREY_DARK, 0.9);
      for (let i = 0; i < 4; i++) c.line(20, 44 + i * 46, 50, 44 + i * 46, 4, CYAN, i === 0 ? 0.85 : 0.35);
    });
    mk("frame-hex", "六角边框", (c) => {
      c.poly([[64, 4], [192, 4], [252, 128], [192, 252], [64, 252], [4, 128]], GREY_MID, 0.85);
      c.poly([[70, 14], [186, 14], [241, 128], [186, 242], [70, 242], [15, 128]], INK, 0.85);
      c.poly([[76, 24], [180, 24], [230, 128], [180, 232], [76, 232], [26, 128]], GREY_MID, 0.3);
    });
    mk("frame-cut", "切角边框", (c) => {
      const K = 34;
      const pts = [[K, 4], [256 - K, 4], [252, K], [252, 256 - K], [256 - K, 252], [K, 252], [4, 256 - K], [4, K]];
      c.poly(pts, GREY_MID, 0.85);
      const K2 = 44;
      const pts2 = [[K2, 20], [256 - K2, 20], [236, K2], [236, 256 - K2], [256 - K2, 236], [K2, 236], [20, 256 - K2], [20, K2]];
      c.poly(pts2, GREY_MID, 0.28);
    });
    mk("frame-tick", "带刻度边框", (c) => {
      c.roundRect(26, 26, 204, 204, 10, GREY_MID, 0.5);
      c.roundRect(30, 30, 196, 196, 8, INK, 0.9);
      for (let i = 0; i < 24; i++) {
        const long = i % 6 === 0;
        c.rect(26 + i * 8.6, 14, 4, long ? 12 : 7, long ? CYAN : GREY_MID, long ? 0.9 : 0.55);
        c.rect(26 + i * 8.6, 230, 4, long ? 12 : 7, long ? CYAN : GREY_MID, long ? 0.9 : 0.55);
        c.rect(14, 26 + i * 8.6, long ? 12 : 7, 4, long ? CYAN : GREY_MID, long ? 0.9 : 0.55);
        c.rect(230, 26 + i * 8.6, long ? 12 : 7, 4, long ? CYAN : GREY_MID, long ? 0.9 : 0.55);
      }
    });
    mk("frame-double-glow", "双层发光边框", (c) => {
      c.roundRect(0, 0, 256, 256, 20, CYAN, 0.08);
      c.roundRect(6, 6, 244, 244, 18, CYAN, 0.22);
      c.roundRect(13, 13, 230, 230, 14, CYAN, 0.7);
      c.roundRect(20, 20, 216, 216, 11, INK, 0.7);
    });
    mk("frame-bracket", "四角括号", (c) => {
      const L = 56, T = 4, O = 12;
      [[O, O, 1, 1], [256 - O, O, -1, 1], [O, 256 - O, 1, -1], [256 - O, 256 - O, -1, -1]].forEach(([x, y, sx, sy]) => {
        c.rect(x - (sx < 0 ? L : 0), y - (sy < 0 ? T : 0), L, T, CYAN, 0.9);
        c.rect(x - (sx < 0 ? T : 0), y - (sy < 0 ? L : 0), T, L, CYAN, 0.9);
      });
    });
  }

  // ================================================================ 装饰（第三批）
  function genDecor3() {
    const S = 128;
    const mk = (name, note, draw) => {
      const c = new Canvas(S, S);
      draw(c, 64, 64);
      save("decor", name, c, note);
    };

    // 四角
    [["corner-tl", 1, 1], ["corner-tr", -1, 1], ["corner-bl", 1, -1], ["corner-br", -1, -1]].forEach(([n, sx, sy]) => {
      mk(n, "角标（" + n.slice(7).toUpperCase() + "）", (c, x, y) => {
        const ox = x + sx * 56, oy = y + sy * 56;
        c.rect(ox, oy, -sx * 40, -sy * 6, CYAN, 0.9);
        c.rect(ox, oy, -sx * 6, -sy * 40, CYAN, 0.9);
        c.rect(ox - sx * 12, oy - sy * 12, -sx * 26, -sy * 3, CYAN, 0.45);
      });
    });

    mk("divider-v", "竖分隔线", (c, x, y) => {
      c.rect(x - 2, 8, 4, 112, GREY_MID, 0.8);
      c.circle(x, 8, 4, CYAN, 0.9);
      c.circle(x, 120, 4, CYAN, 0.9);
    });
    mk("divider-h", "横分隔线", (c, x, y) => {
      c.rect(8, y - 2, 112, 4, GREY_MID, 0.8);
      c.circle(8, y, 4, CYAN, 0.9);
      c.circle(120, y, 4, CYAN, 0.9);
    });
    mk("divider-gradient", "渐变分隔线", (c, x, y) => {
      c.fill((px, py) => {
        if (Math.abs(py - y) > 2 || px < 8 || px > 120) return null;
        const t = Math.abs(px - 64) / 56;
        return [0, 216, 255, 0.9 * (1 - t)];
      });
    });
    mk("chevron", "雪佛龙箭头", (c, x, y) => {
      c.line(x - 22, y - 18, x, y + 4, 8, CYAN, 0.9);
      c.line(x, y + 4, x + 22, y - 18, 8, CYAN, 0.9);
    });
    mk("chevron-double", "双雪佛龙", (c, x, y) => {
      [-14, 14].forEach((dy) => {
        c.line(x - 22, y - 18 + dy, x, y + 4 + dy, 7, CYAN, 0.85);
        c.line(x, y + 4 + dy, x + 22, y - 18 + dy, 7, CYAN, 0.85);
      });
    });
    mk("arrow-up", "上箭头", (c, x, y) => {
      c.poly([[x, y - 34], [x + 26, y + 6], [x + 9, y + 6], [x + 9, y + 34], [x - 9, y + 34], [x - 9, y + 6], [x - 26, y + 6]], CYAN, 0.92);
    });
    mk("arrow-down", "下箭头", (c, x, y) => {
      c.poly([[x, y + 34], [x - 26, y - 6], [x - 9, y - 6], [x - 9, y - 34], [x + 9, y - 34], [x + 9, y - 6], [x + 26, y - 6]], CYAN, 0.92);
    });
    mk("arrow-left", "左箭头", (c, x, y) => {
      c.poly([[x - 34, y], [x + 6, y - 26], [x + 6, y - 9], [x + 34, y - 9], [x + 34, y + 9], [x + 6, y + 9], [x + 6, y + 26]], CYAN, 0.92);
    });
    mk("rivet", "铆钉", (c, x, y) => {
      c.circle(x, y, 16, GREY_MID, 0.9);
      c.circle(x, y, 10, GREY_DARK, 0.95);
      c.arc(x, y, 12, 3, 200, 340, WHITE, 0.35);
    });
    mk("screw", "螺丝", (c, x, y) => {
      c.circle(x, y, 17, GREY_MID, 0.92);
      c.circle(x, y, 12, GREY_DARK, 0.9);
      c.line(x - 9, y - 9, x + 9, y + 9, 5, GREY_MID, 0.95);
    });
    mk("glow-cyan", "青色光晕", (c, x, y) => {
      for (let i = 10; i >= 1; i--) c.circle(x, y, i * 5.5, CYAN, 0.05);
      c.circle(x, y, 12, CYAN, 0.35);
    });
    mk("glow-red", "红色光晕", (c, x, y) => {
      for (let i = 10; i >= 1; i--) c.circle(x, y, i * 5.5, RED, 0.05);
      c.circle(x, y, 12, RED, 0.35);
    });
    mk("glow-green", "绿色光晕", (c, x, y) => {
      for (let i = 10; i >= 1; i--) c.circle(x, y, i * 5.5, GREEN, 0.05);
      c.circle(x, y, 12, GREEN, 0.35);
    });
    mk("glow-ring", "发光圆环", (c, x, y) => {
      for (let i = 5; i >= 1; i--) c.ring(x, y, 40, i * 5, CYAN, 0.06);
      c.ring(x, y, 40, 4, CYAN, 0.85);
    });
    mk("stripes-diag", "斜纹块", (c, x, y) => {
      c.rect(8, 8, 112, 112, GREY_DARK, 0.9);
      for (let i = -6; i < 14; i++) {
        c.line(8 + i * 14, 120, 8 + i * 14 + 60, 8, 7, GREY_MID, 0.45);
      }
    });
    mk("stripes-h", "横纹块", (c, x, y) => {
      for (let i = 0; i < 12; i++) c.rect(8, 8 + i * 10, 112, 5, GREY_MID, i % 2 ? 0.4 : 0.7);
    });
    mk("dots-grid", "点阵块", (c, x, y) => {
      for (let r = 0; r < 8; r++) for (let q = 0; q < 8; q++) c.circle(16 + q * 14, 16 + r * 14, 3, GREY_MID, 0.75);
    });
    mk("hex-grid", "六角网格", (c, x, y) => {
      for (let r = 0; r < 5; r++) {
        for (let q = 0; q < 5; q++) {
          const hx = 20 + q * 24 + (r % 2 ? 12 : 0), hy = 18 + r * 21;
          if (hx < 120) c.poly(ngon(hx, hy, 10, 6, -90), CYAN_DIM, 0.5);
        }
      }
    });
    mk("carbon-block", "碳纤维块", (c, x, y) => {
      c.rect(8, 8, 112, 112, GREY_DARK, 0.96);
      for (let i = 0; i < 90; i++) {
        const px = (i * 41) % 104 + 12, py = (i * 67) % 104 + 12;
        c.line(px, py, px + 9, py - 9, 3, GREY_MID, 0.35);
      }
    });
    mk("hazard-stripe-v", "竖危险条纹", (c, x, y) => {
      c.rect(28, 8, 72, 112, AMBER, 0.9);
      for (let i = 0; i < 8; i++) c.poly([[28 + i * 12, 120], [28 + i * 12 + 8, 120], [28 + i * 12 + 8 + 20, 8], [28 + i * 12 + 20, 8]], INK, 0.55);
    });
    mk("plate-blank", "空白铭牌", (c, x, y) => {
      c.roundRect(10, 44, 108, 40, 6, GREY_DARK, 0.95);
      c.roundRect(10, 44, 108, 40, 6, GREY_MID, 0.25);
      c.rect(16, 50, 96, 2, CYAN, 0.5);
      c.rect(16, 76, 96, 2, CYAN, 0.5);
    });
    mk("bracket-tr", "右上括号", (c, x, y) => {
      c.rect(96, 12, 20, 5, CYAN, 0.9);
      c.rect(111, 12, 5, 34, CYAN, 0.9);
    });
    mk("bracket-bl", "左下括号", (c, x, y) => {
      c.rect(12, 111, 20, 5, CYAN, 0.9);
      c.rect(12, 82, 5, 34, CYAN, 0.9);
    });
  }

  // ================================================================ 背景（第三批）
  function genBackgrounds3() {
    const mk = (name, note, draw) => {
      const c = new Canvas(256, 256);
      draw(c);
      save("background", name, c, note);
    };

    mk("carbon-coarse", "粗碳纹", (c) => {
      c.rect(0, 0, 256, 256, GREY_DARK, 1);
      for (let i = 0; i < 700; i++) {
        const px = (i * 47) % 256, py = (i * 89) % 256;
        c.line(px, py, px + 14, py - 14, 5, GREY_MID, 0.3);
      }
    });
    mk("brushed-dark", "深色拉丝", (c) => {
      c.rect(0, 0, 256, 256, "#0E131A", 1);
      for (let y = 0; y < 256; y += 2) {
        const a = 0.05 + 0.10 * Math.abs(Math.sin(y * 0.7));
        c.rect(0, y, 256, 1, GREY, a);
      }
    });
    mk("grid-fine", "细网格", (c) => {
      c.rect(0, 0, 256, 256, INK, 1);
      for (let i = 0; i <= 32; i++) {
        c.rect(i * 8, 0, 1, 256, GREY, 0.16);
        c.rect(0, i * 8, 256, 1, GREY, 0.16);
      }
    });
    mk("grid-coarse", "粗网格", (c) => {
      c.rect(0, 0, 256, 256, INK, 1);
      for (let i = 0; i <= 8; i++) {
        c.rect(i * 32, 0, 2, 256, GREY, 0.32);
        c.rect(0, i * 32, 256, 2, GREY, 0.32);
      }
    });
    mk("dots-dark", "深色点阵", (c) => {
      c.rect(0, 0, 256, 256, INK, 1);
      for (let y = 8; y < 256; y += 16) for (let x = 8; x < 256; x += 16) c.circle(x, y, 2, GREY, 0.4);
    });
    mk("gradient-v", "纵向渐变", (c) => {
      c.fill((x, y) => {
        const t = y / 256;
        return [6 + t * 14, 10 + t * 20, 16 + t * 28, 1];
      });
    });
    mk("gradient-radial", "径向渐变", (c) => {
      c.fill((x, y) => {
        const d = Math.min(1, Math.hypot(x - 128, y - 128) / 150);
        return [4 + d * 12, 8 + d * 18, 14 + d * 26, 1];
      });
    });
    mk("hex-dark", "深色六角纹", (c) => {
      c.rect(0, 0, 256, 256, INK, 1);
      for (let r = 0; r < 9; r++) {
        for (let q = 0; q < 9; q++) {
          const hx = 16 + q * 30 + (r % 2 ? 15 : 0), hy = 14 + r * 26;
          if (hx < 260) c.poly(ngon(hx, hy, 13, 6, -90), GREY_MID, 0.22);
        }
      }
    });
    mk("noise-dark", "深色噪点", (c) => {
      c.rect(0, 0, 256, 256, "#0A0E14", 1);
      for (let i = 0; i < 3000; i++) {
        const px = (i * 131) % 256, py = (i * 197) % 256;
        c.circle(px, py, 1, WHITE, 0.05 + (i % 5) * 0.015);
      }
    });
    mk("stripes-dark", "深色斜纹", (c) => {
      c.rect(0, 0, 256, 256, INK, 1);
      for (let i = -10; i < 30; i++) c.line(i * 18, 256, i * 18 + 128, 0, 8, GREY, 0.12);
    });
    mk("waves", "波纹", (c) => {
      c.rect(0, 0, 256, 256, "#070B11", 1);
      for (let k = 0; k < 8; k++) {
        const pts = [];
        for (let i = 0; i <= 64; i++) {
          const x = i * 4;
          pts.push([x, 32 + k * 28 + Math.sin(i * 0.35 + k) * 9]);
        }
        for (let i = 0; i < pts.length - 1; i++) c.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 2, CYAN, 0.16);
      }
    });
    mk("mesh", "网格线框", (c) => {
      c.rect(0, 0, 256, 256, "#060A10", 1);
      for (let i = 0; i <= 12; i++) {
        c.line(i * 21.3, 0, 128, 128, 1, CYAN, 0.10);
        c.line(i * 21.3, 256, 128, 128, 1, CYAN, 0.10);
        c.line(0, i * 21.3, 128, 128, 1, CYAN, 0.10);
        c.line(256, i * 21.3, 128, 128, 1, CYAN, 0.10);
      }
    });
    mk("vignette", "暗角", (c) => {
      c.fill((x, y) => {
        const d = Math.hypot(x - 128, y - 128) / 181;
        return [0, 0, 0, Math.max(0, d * d * 1.2 - 0.15)];
      });
    });
    mk("scanlines-dark", "扫描线（深）", (c) => {
      c.rect(0, 0, 256, 256, "#05080C", 1);
      for (let y = 0; y < 256; y += 3) c.rect(0, y, 256, 1, CYAN, 0.07);
    });
  }

  // ================================================================ 数字刻度（v2.23.0，用点阵字库）
  //
  // 这一批以前**做不出来** —— png.js 不能画文字，刻度盘上只能画短横线。
  // 加了 5×7 点阵字库之后才有这些。
  function genNumberScales() {
    const { drawText, textWidth } = ctx;

    // ---- 单个大数字块（用户可以把它们摆成任何数字）
    // 5×7 点阵放大 8 倍 = 40×56，是车机上"大号读数"的典型尺寸
    [
      ["0","0"],["1","1"],["2","2"],["3","3"],["4","4"],
      ["5","5"],["6","6"],["7","7"],["8","8"],["9","9"],
      [".","点"],["-","负号"],["%","百分号"],
    ].forEach(function (pair) {
      const ch = pair[0], label = pair[1];
      const SC = 8;
      const w = textWidth(ch, SC) + 4, h = 7 * SC + 4;
      const c = new Canvas(w, h);
      drawText(c, 2, 2, ch, CYAN, SC, 1);
      save("scale", "digit-" + (ch === "." ? "dot" : ch === "-" ? "minus" : ch === "%" ? "pct" : ch),
        c, "数字块 " + label + "（点阵，可拼任意数字）");
    });

    // ---- 径向数字刻度：刻度线 + 数字（刻度盘最常用的那种）
    function arcNums(name, note, count, maxLabel, radius, numRadius, scale) {
      const S = 256, cx = 128, cy = 128;
      const c = new Canvas(S, S);
      const A0 = 135, A1 = 405;
      // 刻度线
      for (let i = 0; i < count; i++) {
        const t2 = count === 1 ? 0 : i / (count - 1);
        const ang = A0 + (A1 - A0) * t2;
        const major = i % Math.max(1, Math.round((count - 1) / maxLabel)) === 0;
        const p0 = P(cx, cy, radius, ang);
        const p1 = P(cx, cy, radius - (major ? 20 : 10), ang);
        c.line(p0[0], p0[1], p1[0], p1[1], major ? 5 : 3, major ? CYAN : GREY, major ? 0.95 : 0.7);
      }
      // 数字
      const step = Math.max(1, Math.round((count - 1) / maxLabel));
      for (let i = 0; i <= maxLabel; i++) {
        const t2 = (i * step) / (count - 1);
        const ang = A0 + (A1 - A0) * t2;
        const label = String(i);
        const tw = textWidth(label, scale);
        const p = P(cx, cy, numRadius, ang);
        // 数字要**沿弧摆正**：以数字中心为原点，把点阵逐像素画上去
        drawText(c, p[0] - tw / 2, p[1] - (7 * scale) / 2, label, WHITE, scale, 1);
      }
      save("scale", name, c, note);
    }
    arcNums("nums-arc-9", "数字刻度弧 0~8（径向）", 41, 8, 116, 92, 2);
    arcNums("nums-arc-11", "数字刻度弧 0~10（径向）", 51, 10, 116, 90, 2);
    arcNums("nums-arc-5", "数字刻度弧 0~4（大数字）", 21, 4, 116, 88, 3);

    // ---- 横向数字行（条形表/表头用）
    [["0,1,2,3,4,5", "nums-row-6"], ["0,2,4,6,8,10", "nums-row-even"],
     ["0,10,20,30,40,50", "nums-row-tens"]].forEach(function (pair) {
      const nums = pair[0].split(",");
      const SC = 3;
      const gap = 12;
      const total = nums.reduce(function (s, n) { return s + textWidth(n, SC); }, 0) + gap * (nums.length - 1);
      const w = Math.max(64, total + 16), h = 7 * SC + 12;
      const c = new Canvas(w, h);
      let x = 8;
      nums.forEach(function (n) {
        drawText(c, x, 6, n, CYAN, SC, 1);
        x += textWidth(n, SC) + gap;
      });
      save("scale", pair[1], c, "横向数字行 " + nums.join("/"));
    });

    // ---- 纵向数字列（垂直条形表用）
    [["0,2,4,6,8", "nums-col-5"], ["0,25,50,75,100", "nums-col-pct"]].forEach(function (pair) {
      const nums = pair[0].split(",");
      const SC = 3;
      const lh = 7 * SC + 14;
      const w = 8 + Math.max.apply(null, nums.map(function (n) { return textWidth(n, SC); })) + 8;
      const c = new Canvas(w, lh * nums.length + 8);
      nums.forEach(function (n, i) {
        drawText(c, 8, 4 + i * lh, n, CYAN, SC, 1);
      });
      save("scale", pair[1], c, "纵向数字列 " + nums.join("/"));
    });

    // ---- 单位文字（做成素材，省得用户手摆）
    [["RPM", "unit-rpm"], ["km/h", "unit-kmh"], ["km", "unit-km"],
     ["°C", "unit-c"], ["V", "unit-v"], ["A", "unit-a"], ["%", "unit-pct"],
     ["bar", "unit-bar"], ["L/100km", "unit-l100"], ["x1000", "unit-x1000"]].forEach(function (pair) {
      const SC = 2;
      const w = textWidth(pair[0], SC) + 8, h = 7 * SC + 6;
      const c = new Canvas(w, h);
      drawText(c, 4, 3, pair[0], GREY, SC, 1);
      save("scale", pair[1], c, "单位 " + pair[0]);
    });
  }
  return {
    genWarnings3, genIcons3, genTurn3, genNeedles3,
    genScales3, genDashboards3, genBrand3,
    genBars, genFrames, genDecor3, genBackgrounds3, genNumberScales,
  };
};
