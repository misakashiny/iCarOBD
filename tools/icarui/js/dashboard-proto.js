// ============================================================================
// dashboard-proto.js —— P5B-M01 阶段 F：两套组合仪表示例**原型**
//
// ## 这是原型，不是正式主题
//
// 与阶段 E 同样原则：不写入 `icar.ui/2`、不注册节点类型、不走 canvas.js 渲染。
// 只在 `window.DashboardProto.draw(canvas, which, values)` 被显式调用时绘制。
//
// ## 两套示例
//
//   示例 A（参考图 3）赛车分段圆环：
//     深色背景 / 大型分段圆弧转速表 / 粉色点亮段 / 灰白未点亮段 /
//     圆弧周围转速数字 / 中央 RPM 读数 / 左右四组温度压力数值条 /
//     前景可叠加透明赛车素材（原型用占位形状）
//
//   示例 B（参考图 4）综合车辆数据屏：
//     深蓝灰背景 / 顶部红色贝塞尔曲线 / 曲线内浅青动态填充 / 顶部 RPM 刻度 /
//     右侧 RPM 数字 / 中央大车速 / 右侧大挡位 / 中间水温油温压力 Lambda /
//     底部 BOOST 信息
//
// ## 数据来源必须诚实（任务 §七 明确要求）
//
// 每个数值都标注来源：
//   'obd'  = **现有 OBD PID 可驱动**（车速、转速、水温、节气门、进气温度…）
//   'calc' = 派生计算（综合 G、平均油耗…）
//   'can'  = **需要专用 CAN/DBC 信号，当前车上读不到**（油温、油压、Lambda、BOOST）
//
// 不允许假装所有数据都已能从车辆读取 —— 见 `DataSource` 表。
// ============================================================================
(function () {
  "use strict";

  const D = 180 / Math.PI;
  const AP = () => window.AdvancedPrimitives;

  // ================================================================
  // 数据来源表 —— 诚实标注每个字段能不能从车上读到
  // ================================================================
  const DataSource = {
    // --- 现有 OBD-II 标准 PID 就能读
    rpm:        { src: "obd",   pid: "obd.rpm",       label: "转速",   note: "Mode 01 PID 0C" },
    speed:      { src: "obd",   pid: "obd.speed",     label: "车速",   note: "Mode 01 PID 0D" },
    coolant:    { src: "obd",   pid: "obd.coolant",   label: "水温",   note: "Mode 01 PID 05" },
    throttle:   { src: "obd",   pid: "obd.throttle",  label: "节气门", note: "Mode 01 PID 11" },
    intakeTemp: { src: "obd",   pid: "obd.intake",    label: "进气温度", note: "Mode 01 PID 0F" },
    load:       { src: "obd",   pid: "obd.load",      label: "负荷",   note: "Mode 01 PID 04" },

    // --- 派生计算（不直接来自车辆）
    gforce:     { src: "calc",  pid: "calc.gforce",   label: "综合G",  note: "加速度计 / 车速差分" },
    gear:       { src: "calc",  pid: "calc.gear",     label: "挡位",   note: "转速/车速比推算" },
    avgFuel:    { src: "calc",  pid: "calc.avg_l100", label: "平均油耗", note: "累计用油 ÷ 累计里程" },

    // --- 需要专用 CAN / DBC（当前读不到）
    oilTemp:    { src: "can",   pid: null, label: "油温",   note: "需车厂 CAN/DBC，OBD-II 无标准 PID" },
    oilPress:   { src: "can",   pid: null, label: "油压",   note: "需车厂 CAN/DBC" },
    boost:      { src: "can",   pid: null, label: "BOOST",  note: "需 MAP 传感器或车厂 CAN/DBC" },
    lambda:     { src: "can",   pid: null, label: "Lambda", note: "宽域氧传感器通常不在标准 OBD 里" },
    fuelPress:  { src: "can",   pid: null, label: "燃油压力", note: "需车厂 CAN/DBC" },
  };

  /** 取一个值；'can' 来源永远返回 null（当前读不到，不编数） */
  function val(values, key) {
    const meta = DataSource[key];
    if (!meta) return null;
    if (meta.src === "can") return null;       // ⚠️ 读不到就是读不到，不假装
    const v = values && values[key];
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }

  /** 读数文本；null → 明确的"无信号"而不是 0 */
  function readText(values, key, decimals) {
    const meta = DataSource[key];
    const v = val(values, key);
    if (v === null) {
      return meta && meta.src === "can" ? "无信号" : "--";
    }
    const dec = decimals === undefined ? 0 : decimals;
    let t = v.toFixed(dec);
    if (dec > 0) t = t.replace(/0+$/, "").replace(/\.$/, "");
    return t;
  }

  function bg(ctx, w, h, top, bottom) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // ================================================================
  // 示例 A：赛车分段圆环（参考图 3）
  // ================================================================
  function drawRaceArc(ctx, w, h, values) {
    const I = AP()._internals;

    // 深色背景
    bg(ctx, w, h, "#0A0C10", "#05070A");

    const cx = w * 0.5;
    const cy = h * 0.52;
    const radius = Math.min(w, h) * 0.30;
    const thickness = radius * 0.16;

    const rpm = val(values, "rpm");
    const maxRpm = 8000;
    const progress = rpm === null ? 0 : Math.max(0, Math.min(1, rpm / maxRpm));

    // ---- 大型分段圆弧转速表（粉色点亮 / 灰白未点亮 / 末段红）
    AP().draw(ctx, "segmentedArc", {
      cx: cx, cy: cy, radius: radius,
      startAngle: 135, sweepAngle: 270,
      segmentCount: 36, gapAngle: 1.6,
      thickness: thickness,
      progress: progress,
      activeColor: "#FF3D7F",
      inactiveColor: "#4A5058",
      colorStops: [
        { at: 0, color: "#FF3D7F" },
        { at: 0.72, color: "#FF3D7F" },
        { at: 0.80, color: "#FFB020" },
        { at: 0.90, color: "#FF2D3D" },
      ],
    });

    // ---- 圆弧周围的转速数字（大刻度：0/2/4/6/8）
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = (radius * 0.115).toFixed(1) + "px sans-serif";
    for (let i = 0; i <= 8; i += 2) {
      const t = i / 8;
      const a = (135 + 270 * t) / D;
      const tickR = radius + thickness * 1.55;
      const tx = cx + Math.cos(a) * tickR;
      const ty = cy + Math.sin(a) * tickR;
      ctx.fillStyle = t >= 0.9 ? "#FF2D3D" : "#8A9099";
      ctx.fillText(String(i), tx, ty);
    }
    ctx.restore();

    // ---- 中央 RPM 读数
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 " + (radius * 0.52).toFixed(1) + "px sans-serif";
    ctx.fillStyle = progress >= 0.9 ? "#FF2D3D" : "#FFFFFF";
    ctx.fillText(readText(values, "rpm"), cx, cy - radius * 0.02);
    ctx.font = (radius * 0.16).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#7D848D";
    ctx.fillText("RPM", cx, cy + radius * 0.30);
    ctx.restore();

    // ---- 左右四组温度 / 压力数值条
    // ⚠️ 这里用 DataSource 区分：水温/进气温度是 obd，油温/油压是 can（读不到）
    const bars = [
      { key: "coolant",  max: 120, side: -1, row: 0 },
      { key: "oilTemp",  max: 150, side: -1, row: 1 },
      { key: "oilPress", max: 8,   side: 1,  row: 0 },
      { key: "intakeTemp", max: 80, side: 1, row: 1 },
    ];
    bars.forEach(function (b) {
      const bx = b.side < 0 ? w * 0.04 : w * 0.70;
      const by = h * (0.26 + b.row * 0.30);
      const bw = w * 0.26;
      const bh = Math.max(6, h * 0.035);

      const meta = DataSource[b.key];
      const v = val(values, b.key);

      // 底板
      ctx.fillStyle = "#1A1E24";
      I.drawShape(ctx, { kind: "roundRect", x: bx, y: by, w: bw, h: bh, r: bh / 2, fill: "#1A1E24" });

      // 进度（读不到就不填，保持空条）
      if (v !== null) {
        const ratio = Math.max(0, Math.min(1, v / b.max));
        I.drawShape(ctx, {
          kind: "roundRect", x: bx, y: by, w: Math.max(bh, bw * ratio), h: bh, r: bh / 2,
          fill: b.key === "oilTemp" || b.key === "oilPress" ? "#FFB020" : "#3DD6FF",
        });
      }

      // 标签 + 读数
      ctx.save();
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.font = (h * 0.026).toFixed(1) + "px sans-serif";
      ctx.fillStyle = "#6F7681";
      ctx.fillText(meta.label, bx, by - h * 0.012);

      ctx.textAlign = "right";
      ctx.font = "700 " + (h * 0.032).toFixed(1) + "px sans-serif";
      ctx.fillStyle = v === null ? "#555B63" : "#E6EBF2";
      ctx.fillText(readText(values, b.key, b.max > 20 ? 0 : 1), bx + bw, by - h * 0.012);
      ctx.restore();
    });

    // ---- 前景可叠加透明赛车素材（原型用占位：一条斜向轮廓）
    ctx.save();
    ctx.globalAlpha = 0.10;
    I.drawShape(ctx, {
      kind: "polyline", closed: true,
      points: [
        { x: w * 0.30, y: h * 0.86 }, { x: w * 0.42, y: h * 0.74 },
        { x: w * 0.62, y: h * 0.74 }, { x: w * 0.72, y: h * 0.86 },
      ],
      fill: "#FFFFFF",
    });
    ctx.restore();
    ctx.save();
    ctx.textAlign = "center";
    ctx.font = (h * 0.020).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#3A4048";
    ctx.fillText("（此处预留透明赛车素材层）", cx, h * 0.94);
    ctx.restore();
  }

  // ================================================================
  // 示例 B：综合车辆数据屏（参考图 4）
  // ================================================================
  function drawDataScreen(ctx, w, h, values) {
    const I = AP()._internals;

    // 深蓝灰背景
    bg(ctx, w, h, "#121A24", "#0B1118");

    // ---- 顶部红色贝塞尔曲线 + 曲线内浅青动态填充
    const curvePts = [
      { x: w * 0.03, y: h * 0.30 },
      { x: w * 0.18, y: h * 0.10 },
      { x: w * 0.42, y: h * 0.06 },
      { x: w * 0.66, y: h * 0.05 },
      { x: w * 0.86, y: h * 0.045 },
    ];
    const rpm = val(values, "rpm");
    const rpmProgress = rpm === null ? 0 : Math.max(0, Math.min(1, rpm / 8000));

    // 底部曲线（未达部分，暗红）
    AP().draw(ctx, "pathProgress", {
      points: curvePts, curve: "smooth", progress: 1,
      thickness: Math.max(1.5, h * 0.006),
      baseColor: "#5A1A22", fillColor: "#5A1A22", glow: false,
    });
    // 已达部分（红色 + 浅青填充）
    AP().draw(ctx, "pathProgress", {
      points: curvePts, curve: "smooth", progress: rpmProgress,
      thickness: Math.max(2, h * 0.008),
      baseColor: "#5A1A22", fillColor: "#FF2D3D", glow: true,
      fillArea: true, fillBottom: h * 0.34, fillAlpha: 0.20,
    });
    // 浅青内填充（单独描一条更低的填充区，体现"曲线内部浅青色"）
    AP().draw(ctx, "pathProgress", {
      points: curvePts, curve: "smooth", progress: rpmProgress,
      thickness: 0.5,
      baseColor: "rgba(0,0,0,0)", fillColor: "#3DD6FF",
      fillArea: true, fillBottom: h * 0.33, fillAlpha: 0.14,
    });

    // ---- 顶部 RPM 刻度
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = (h * 0.022).toFixed(1) + "px sans-serif";
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const tx = w * 0.03 + (w * 0.83) * t;
      const ty = h * 0.36;
      ctx.fillStyle = "#4A5563";
      ctx.fillRect(tx - 0.5, ty - h * 0.012, 1, h * 0.012);
      ctx.fillStyle = t >= 0.9 ? "#FF2D3D" : "#5C6773";
      ctx.fillText(String(i), tx, ty);
    }
    ctx.restore();

    // ---- 右侧 RPM 数字
    ctx.save();
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "700 " + (h * 0.055).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#FF2D3D";
    ctx.fillText(readText(values, "rpm"), w * 0.95, h * 0.50);
    ctx.font = (h * 0.020).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#6F7681";
    ctx.fillText("RPM", w * 0.95, h * 0.56);
    ctx.restore();

    // ---- 中央大车速
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 " + (h * 0.20).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#F2F7FF";
    ctx.fillText(readText(values, "speed"), w * 0.40, h * 0.55);
    ctx.font = (h * 0.030).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#7D8894";
    ctx.fillText("km/h", w * 0.40, h * 0.66);
    ctx.restore();

    // ---- 右侧大挡位（calc 来源）
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const gearV = val(values, "gear");
    ctx.font = "700 " + (h * 0.13).toFixed(1) + "px sans-serif";
    ctx.fillStyle = gearV === null ? "#4A5563" : "#3DD6FF";
    ctx.fillText(gearV === null ? "--" : String(Math.round(gearV)), w * 0.84, h * 0.55);
    ctx.font = (h * 0.020).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#6F7681";
    ctx.fillText("挡位", w * 0.84, h * 0.64);
    ctx.restore();

    // ---- 中间四个数值：水温（obd）/ 油温（can）/ 压力（can）/ Lambda（can）
    const mids = [
      { key: "coolant",   label: "水温",    unit: "℃", dec: 0 },
      { key: "oilTemp",   label: "油温",    unit: "℃", dec: 0 },
      { key: "oilPress",  label: "油压",    unit: "bar", dec: 1 },
      { key: "lambda",    label: "Lambda",  unit: "",  dec: 2 },
    ];
    mids.forEach(function (m, i) {
      const mx = w * (0.18 + i * 0.16);
      const my = h * 0.78;
      const meta = DataSource[m.key];
      const v = val(values, m.key);
      const unreadable = meta.src === "can";

      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = (h * 0.020).toFixed(1) + "px sans-serif";
      ctx.fillStyle = "#5C6773";
      ctx.fillText(m.label, mx, my);

      ctx.font = "700 " + (h * 0.040).toFixed(1) + "px sans-serif";
      ctx.fillStyle = v === null ? (unreadable ? "#3E4A57" : "#5C6773") : "#DCE6F2";
      ctx.fillText(readText(values, m.key, m.dec), mx, my + h * 0.055);

      if (m.unit) {
        ctx.font = (h * 0.017).toFixed(1) + "px sans-serif";
        ctx.fillStyle = "#4E5A67";
        ctx.fillText(m.unit, mx, my + h * 0.095);
      }
      // 读不到的标"无信号"（不假装是 0）
      if (unreadable) {
        ctx.font = (h * 0.014).toFixed(1) + "px sans-serif";
        ctx.fillStyle = "#8A5A2B";
        ctx.fillText("需 CAN/DBC", mx, my + h * 0.125);
      }
      ctx.restore();
    });

    // ---- 底部 BOOST（can 来源，读不到）
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.font = (h * 0.020).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#5C6773";
    ctx.fillText("BOOST", w * 0.04, h * 0.94);
    ctx.font = "700 " + (h * 0.034).toFixed(1) + "px sans-serif";
    const boostV = val(values, "boost");
    ctx.fillStyle = boostV === null ? "#3E4A57" : "#3DD6FF";
    ctx.fillText(boostV === null ? "无信号" : (boostV.toFixed(2) + " bar"), w * 0.13, h * 0.94);
    ctx.font = (h * 0.014).toFixed(1) + "px sans-serif";
    ctx.fillStyle = "#8A5A2B";
    if (boostV === null) ctx.fillText("（需 MAP 传感器或车厂 CAN/DBC）", w * 0.30, h * 0.94);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 导出

  window.DashboardProto = {
    PROTO: true,
    WHICH: ["raceArc", "dataScreen"],
    DataSource: DataSource,

    /** 只画，不返回数据 */
    draw: function (ctx, which, values, w, h) {
      w = w || 360; h = h || 360;
      ctx.save();
      if (which === "raceArc") drawRaceArc(ctx, w, h, values || {});
      else if (which === "dataScreen") drawDataScreen(ctx, w, h, values || {});
      else { ctx.restore(); return false; }
      ctx.restore();
      return true;
    },

    /** 返回"哪些字段能从车上读到"的清单（供报告与 UI 标注使用） */
    dataAvailability: function (values) {
      const out = {};
      Object.keys(DataSource).forEach(function (k) {
        const meta = DataSource[k];
        out[k] = {
          src: meta.src,
          label: meta.label,
          note: meta.note,
          readable: meta.src !== "can",
          hasValue: val(values, k) !== null,
        };
      });
      return out;
    },

    _internals: { drawRaceArc: drawRaceArc, drawDataScreen: drawDataScreen, val: val, readText: readText },
  };
})();
