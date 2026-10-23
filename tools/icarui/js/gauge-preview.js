// ============================================================================
// gauge-preview.js —— style 3/4/5/6/7 的编辑器预览（P5B-M01 阶段 B）
//
// ## 为什么要有这个文件
//
// 专题 86（用户盘点）与 P5B-M01 阶段 A 复核都确认：编辑器里 8 档 style
// **只有 0/1/2 与 Android 一致**，其余 5 档是简化或占位：
//
//   style 3 编辑器画装饰正弦波  ← Android 是真实历史折线（wantsHistory）
//   style 4 编辑器画"一条线+×2" ← Android 是**上下两个数值格**
//   style 5 编辑器画"十字线+×4" ← Android 是**2×2 四个数值格**
//   style 6 编辑器画"两条线+×3" ← Android 是**上大下分两格**
//   style 7 编辑器直接复用圆盘 ← Android 是**G 力散点 + 0.5G 参考圈 + 十字准线**
//
// ⚠️ 阶段 A 复核纠正了专题 86 的一处描述：4/5/6 在 App 侧**不是线**，
//    而是 `MultiValueGaugeView.drawCell()` 画的「标签 / 数值 / 单位」三行文字格。
//    所以这里必须画**数值格子**，画线仍然是错的。
//
// ## 设计约束
//
// · **不新增主题字段**，只读既有 `n.style` / `n.pid` / `n.extraPids` / `n.min/max` 等
// · **不复制第二套 Canvas 渲染**：直接用 canvas.js 暴露的 `ctx` / 主题 / 量程 / 报警色
// · style 0/1/2 完全不动（本文件不碰）
// · 值一律来自 `S.previewValues`（真值），没有就是"无数据"（显示 --），不编数
// ============================================================================
(function () {
  "use strict";

  // ---------------------------------------------------------------- 取画笔

  /** canvas.js 里的运行环境由 drawGaugeNode 通过 window.__gpCtx 传进来 */
  function env() {
    const e = window.__gpCtx;
    if (!e || !e.ctx) return null;
    return e;
  }

  // ---------------------------------------------------------------- 通用：数值格式化

  /**
   * 与 Android `BaseGaugeView.format()` 同语义：最多 1 位小数、去尾零。
   * 无数据（null）返回 "--"（与仪表"不假装有值"一致）。
   */
  function fmt(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "--";
    const r = Math.round(v * 10) / 10;
    return String(r);
  }

  /** 一个"数值格"：标签 / 数值 / 单位 三行，字号按格高自适应 */
  function drawCell(e, cx, top, cellH, label, valueText, unitText, color) {
    if (!(cellH > 1)) return;
    const ctx = e.ctx;
    const hasLabel = !!label;
    const hasUnit = !!unitText;

    // 与 Android TextFit 的比例同源：标签 0.19 / 数值 0.44 / 单位 0.17
    // 但这里再按"有没有标签/单位"重新分配，避免留白过多
    let labelR = hasLabel ? 0.19 : 0;
    let valueR = hasUnit ? 0.44 : 0.56;
    let unitR = hasUnit ? 0.17 : 0;
    const total = labelR + valueR + unitR;
    if (total > 0) { labelR /= total; valueR /= total; unitR /= total; }

    let y = top;
    const prevAlign = ctx.textAlign;
    const prevBaseline = ctx.textBaseline;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    if (hasLabel) {
      const lh = cellH * labelR;
      ctx.font = Math.max(6, lh * 0.62).toFixed(1) + "px " + e.fontFamily;
      ctx.fillStyle = e.colors.label;
      ctx.fillText(label, cx, y + lh / 2, e.maxTextW);
      y += lh;
    }
    const vh = cellH * valueR;
    ctx.font = "700 " + Math.max(8, vh * 0.72).toFixed(1) + "px " + e.fontFamily;
    ctx.fillStyle = color;
    ctx.fillText(valueText, cx, y + vh / 2, e.maxTextW);
    y += vh;
    if (hasUnit) {
      const uh = cellH * unitR;
      ctx.font = Math.max(5, uh * 0.62).toFixed(1) + "px " + e.fontFamily;
      ctx.fillStyle = e.colors.label;
      ctx.fillText(unitText, cx, y + uh / 2, e.maxTextW);
    }

    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBaseline;
  }

  /** 取某个 PID 的预览值（没有就是 null → 显示 --） */
  function valueOf(pid) {
    const vals = window.CanvasState && window.CanvasState.previewValues;
    if (!vals || !pid) return null;
    const v = vals[pid];
    return (typeof v === "number" && Number.isFinite(v)) ? v : null;
  }

  /** 某 PID 的显示名与单位（来自内置库） */
  function pidMeta(pid) {
    const d = window.BUILTIN_PIDS && window.BUILTIN_PIDS[pid];
    return { name: d ? d.name : (pid || "未绑定"), unit: d ? (d.unit || "") : "" };
  }

  /** 副参数 PID 列表（与 Android `extraValue(i)` 对应） */
  function extraPids(n) {
    const out = Array.isArray(n.extraPids) ? n.extraPids.slice(0, 3) : [];
    while (out.length < 3) out.push("");
    return out;
  }

  // ================================================================
  // style 3：LineChart —— **真实历史序列**（不再用装饰正弦波）
  // ================================================================
  //
  // Android: LineChartView.wantsHistory = true，由渲染层推
  // VehicleBus.historyOf(pid)；纵轴固定用 GaugeItem.minVal / maxVal。
  //
  // 编辑器对应：simStep 每帧把值推进 `S.history[pid]`（环形，上限 60），
  // 这里直接画。没有历史（模拟没开）时画一条**平的中线**并标注"无历史数据"，
  // 而不是画一条好看的假正弦波。
  function drawLine(e, n) {
    const ctx = e.ctx;
    const w = n.w, h = n.h;

    // 与 Android 的 padding 同量级（padL 大一些给纵轴刻度）
    const padL = Math.max(6, w * 0.10);
    const padR = Math.max(4, w * 0.04);
    const padT = Math.max(4, h * 0.08);
    const padB = Math.max(6, h * 0.12);
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, h - padT - padB);

    // 坐标轴
    ctx.strokeStyle = e.colors.track;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    const hist = (window.CanvasState && window.CanvasState.history && window.CanvasState.history[n.pid]) || [];
    const lo = Number.isFinite(n.min) ? n.min : 0;
    const hi = (Number.isFinite(n.max) && n.max > lo) ? n.max : lo + 100;

    if (hist.length < 2) {
      // 无历史：画中线 + 说明，**不编造曲线**
      const midY = padT + plotH / 2;
      ctx.strokeStyle = e.colors.dim;
      ctx.setLineDash && ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, midY);
      ctx.lineTo(padL + plotW, midY);
      ctx.stroke();
      ctx.setLineDash && ctx.setLineDash([]);
      const prevAlign = ctx.textAlign;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = Math.max(6, Math.min(h * 0.12, 13)).toFixed(1) + "px " + e.fontFamily;
      ctx.fillStyle = e.colors.dim;
      ctx.fillText("无历史数据", padL + plotW / 2, midY);
      ctx.textAlign = prevAlign;
      return;
    }

    // 折线 + 下方填充（与 Android fillPath 同构）
    const px = i => padL + plotW * (hist.length === 1 ? 0 : i / (hist.length - 1));
    const py = v => padT + plotH * (1 - Math.max(0, Math.min(1, (v - lo) / (hi - lo))));

    ctx.beginPath();
    ctx.moveTo(px(0), py(hist[0]));
    for (let i = 1; i < hist.length; i++) ctx.lineTo(px(i), py(hist[i]));

    // 填充（半透明）
    const linePathDone = () => { };
    ctx.save();
    ctx.lineTo(px(hist.length - 1), padT + plotH);
    ctx.lineTo(px(0), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = e.alpha(e.colors.accent, 0.18);
    ctx.fill();
    ctx.restore();

    // 重新描线（填充改了路径）
    ctx.beginPath();
    ctx.moveTo(px(0), py(hist[0]));
    for (let i = 1; i < hist.length; i++) ctx.lineTo(px(i), py(hist[i]));
    ctx.strokeStyle = e.colors.accent;
    ctx.lineWidth = Math.max(1, Math.min(w, h) * 0.022);
    ctx.stroke();

    // 纵轴上下限标注（Android 也画，帮助判断当前值在量程里的位置）
    const prevAlign = ctx.textAlign;
    const prevBase = ctx.textBaseline;
    ctx.textAlign = "right";
    ctx.textBaseline = "top";
    ctx.font = Math.max(5, Math.min(h * 0.09, 10)).toFixed(1) + "px " + e.fontFamily;
    ctx.fillStyle = e.colors.dim;
    ctx.fillText(fmt(hi), padL - 1, padT);
    ctx.textBaseline = "bottom";
    ctx.fillText(fmt(lo), padL - 1, padT + plotH);
    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBase;
  }

  // ================================================================
  // style 4 / 5 / 6：数值格（与 Android MultiValueGaugeView.drawCell 同构）
  // ================================================================

  /** 画一格（内部统一走 drawCell，值/色都从真值算） */
  function cell(e, cx, top, cellH, pid, isPrimary, n, maxTextW) {
    const meta = pidMeta(pid);
    const v = valueOf(pid);
    const color = isPrimary
      ? e.alertColor(n, v)
      : e.colors.value;
    drawCell(e, cx, top, cellH, meta.name, fmt(v), meta.unit, color, maxTextW);
  }

  /** style 4 DualStack：上下各占一半 */
  function drawDualStack(e, n) {
    const ctx = e.ctx;
    const w = n.w, h = n.h;
    const half = h / 2;

    // 分隔线（Android: drawLine(dp(8f), half, w - dp(8f), half)）
    ctx.strokeStyle = e.colors.track;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.min(8, w * 0.06), half);
    ctx.lineTo(w - Math.min(8, w * 0.06), half);
    ctx.stroke();

    const maxTextW = w * 0.92;
    cell(e, w / 2, 0, half, n.pid, true, n, maxTextW);
    cell(e, w / 2, half, half, extraPids(n)[0], false, n, maxTextW);
  }

  /** style 5 Quad：2×2 */
  function drawQuad(e, n) {
    const ctx = e.ctx;
    const w = n.w, h = n.h;
    const halfW = w / 2, halfH = h / 2;

    // 十字线（Android: 竖向从 dp(6f) 到 h-dp(6f)；横向同理）
    const inset = Math.min(6, Math.min(w, h) * 0.05);
    ctx.strokeStyle = e.colors.track;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(halfW, inset);
    ctx.lineTo(halfW, h - inset);
    ctx.moveTo(inset, halfH);
    ctx.lineTo(w - inset, halfH);
    ctx.stroke();

    const ex = extraPids(n);
    const maxTextW = halfW * 0.92;
    // 左上主参数，其余三格是副参数（与 Android 顺序一致）
    cell(e, halfW / 2, 0, halfH, n.pid, true, n, maxTextW);
    cell(e, halfW * 1.5, 0, halfH, ex[0], false, n, maxTextW);
    cell(e, halfW / 2, halfH, halfH, ex[1], false, n, maxTextW);
    cell(e, halfW * 1.5, halfH, halfH, ex[2], false, n, maxTextW);
  }

  /** style 6 SubDual：上 0.56 主参数（大），下分两格 */
  function drawSubDual(e, n) {
    const ctx = e.ctx;
    const w = n.w, h = n.h;
    const topH = h * 0.56;
    const botH = h - topH;

    const inset = Math.min(8, Math.min(w, h) * 0.06);
    const small = Math.min(4, inset * 0.6);
    ctx.strokeStyle = e.colors.track;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(inset, topH);
    ctx.lineTo(w - inset, topH);
    ctx.moveTo(w / 2, topH + small);
    ctx.lineTo(w / 2, h - small);
    ctx.stroke();

    const ex = extraPids(n);
    cell(e, w / 2, 0, topH, n.pid, true, n, w * 0.92);
    cell(e, w * 0.25, topH, botH, ex[0], false, n, w * 0.46);
    cell(e, w * 0.75, topH, botH, ex[1], false, n, w * 0.46);
  }

  // ================================================================
  // style 7：GForce —— 散点 + 0.5G 参考圈 + 十字准线
  // ================================================================
  //
  // Android GForceGaugeView：
  //   MAX_G = 1.5，圆半径 = min(w,h) * 0.36
  //   主参数 = 综合 G；副0 = 横向 G（→ x），副1 = 纵向 G（→ y，向上为正）
  //   画：外圈 + 0.5G 参考圈 + 十字准线 + 圆点 + 中央"综合 N g" + 左下横/右下纵
  function drawGForce(e, n) {
    const ctx = e.ctx;
    const w = n.w, h = n.h;
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) * 0.36;
    const MAX_G = 1.5;

    // 外圈
    ctx.strokeStyle = e.colors.track;
    ctx.lineWidth = Math.max(1, radius * 0.045);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 0.5G 参考圈
    ctx.strokeStyle = e.colors.tick || e.colors.dim;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (0.5 / MAX_G), 0, Math.PI * 2);
    ctx.stroke();

    // 十字准线
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // 点：副0 = 横 → x；副1 = 纵 → y（向上为正，所以 cy - ...）
    const ex = extraPids(n);
    const gxRaw = valueOf(ex[0]);
    const gyRaw = valueOf(ex[1]);
    const hasG = gxRaw !== null || gyRaw !== null;
    const gx = Math.max(-MAX_G, Math.min(MAX_G, gxRaw === null ? 0 : gxRaw));
    const gy = Math.max(-MAX_G, Math.min(MAX_G, gyRaw === null ? 0 : gyRaw));
    const px = cx + (gx / MAX_G) * radius;
    const py = cy - (gy / MAX_G) * radius;

    if (hasG) {
      const dotColor = e.alertColor(n, valueOf(n.pid));
      ctx.fillStyle = dotColor;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2.5, Math.min(w, h) * 0.032), 0, Math.PI * 2);
      ctx.fill();
    }

    // 中央综合 G
    const base = Math.min(w, h);
    const prevAlign = ctx.textAlign;
    const prevBase = ctx.textBaseline;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const gv = valueOf(n.pid);
    ctx.font = "700 " + (base * 0.11).toFixed(1) + "px " + e.fontFamily;
    ctx.fillStyle = e.alertColor(n, gv);
    const unitG = pidMeta(n.pid).unit || "g";
    ctx.fillText(gv === null ? "--" : fmt(gv) + " " + unitG, cx, cy + base * 0.02);

    ctx.font = (base * 0.055).toFixed(1) + "px " + e.fontFamily;
    ctx.fillStyle = e.colors.label;
    ctx.fillText("综合", cx, cy + base * 0.02 + base * 0.075);

    // 左下"横"、右下"纵"
    ctx.font = (base * 0.05).toFixed(1) + "px " + e.fontFamily;
    ctx.fillStyle = e.colors.dim;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("横 " + fmt(gxRaw), Math.min(6, w * 0.04), h - Math.min(6, h * 0.04));
    ctx.textAlign = "right";
    ctx.fillText("纵 " + fmt(gyRaw), w - Math.min(6, w * 0.04), h - Math.min(6, h * 0.04));

    ctx.textAlign = prevAlign;
    ctx.textBaseline = prevBase;
  }

  // ---------------------------------------------------------------- 导出

  /**
   * 由 canvas.js 的 `drawGaugeNode` 调用。
   * @returns {boolean} true = 已处理；false = 不认识（调用方回落原逻辑）
   */
  window.drawGaugeStylePreview = function (n, envCtx) {
    const style = n.style;
    if (style !== 3 && style !== 4 && style !== 5 && style !== 6 && style !== 7) return false;
    window.__gpCtx = envCtx;
    const e = env();
    if (!e) return false;
    try {
      if (style === 3) drawLine(e, n);
      else if (style === 4) drawDualStack(e, n);
      else if (style === 5) drawQuad(e, n);
      else if (style === 6) drawSubDual(e, n);
      else if (style === 7) drawGForce(e, n);
    } finally {
      window.__gpCtx = null;
    }
    return true;
  };

  // 供测试直接调用（不经 canvas.js）
  window.__gaugePreviewInternals = {
    fmt: fmt,
    drawLine: drawLine,
    drawDualStack: drawDualStack,
    drawQuad: drawQuad,
    drawSubDual: drawSubDual,
    drawGForce: drawGForce,
    drawCell: drawCell,
    pidMeta: pidMeta,
    extraPids: extraPids,
  };
})();
