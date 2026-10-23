// ============================================================================
// advanced-primitives-proto.js —— P5B-M01 阶段 E：高级仪表基元**隔离原型**
//
// ## 这是原型，不是正式功能
//
// 任务明确：「优先制作**不进入正式主题格式**的技术原型」「不得把未经批准的新字段
// 写入正式 `icar.ui/2`」「**不得把原型测试通过等同于正式 Android 控件已交付**」。
//
// 所以本文件：
//   · **不被 canvas.js 引用**，不参与任何主题的渲染
//   · 不注册任何 schema / 属性面板字段
//   · 只能通过 `window.AdvancedPrimitives.draw(canvas, kind, params)` 主动调用
//   · 全部是纯函数（给定 canvas 与参数就画），便于单元测试与后续移植
//
// ## 为什么先做这四个
//
// 现有 8 档 style 都是**封闭皮肤**（圆盘/数字/条形/折线/数值格/G力）。
// 要做 STORYDash 那种组合仪表，需要的是**可组合的基元**：
//
//   SegmentedArc  分段圆弧进度  ← 赛车转速环 / 分段油门环 / 分区报警环
//   PathProgress  沿路径进度    ← 贝塞尔曲线填充（参考图 4 的顶部曲线）
//   ValueText     动态数值文本  ← 独立读数（带单位/精度/阈值色）
//   Shape         基础图形      ← 底板/分割线/装饰
//
// 这四个都不需要新持久化字段就能表达 —— 它们可以完全由**参数**驱动，
// 这为将来的组合模板留出空间，而不必无限加 `gauge.style=8,9,10...`。
// ============================================================================
(function () {
  "use strict";

  const D = 180 / Math.PI;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function num(v, def) { const n = Number(v); return Number.isFinite(n) ? n : def; }

  /** 十六进制 → rgba 字符串（原型内部用，避免依赖外部实现） */
  function rgba(hex, a) {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ""));
    if (!m) return hex;
    const v = parseInt(m[1], 16);
    return "rgba(" + ((v >> 16) & 255) + "," + ((v >> 8) & 255) + "," + (v & 255) + "," + a + ")";
  }

  function colorAt(stops, t) {
    // stops: [{at:0..1, color:"#RRGGBB"}]
    if (!stops || !stops.length) return "#FFFFFF";
    const s = stops.slice().sort((a, b) => a.at - b.at);
    if (t <= s[0].at) return s[0].color;
    if (t >= s[s.length - 1].at) return s[s.length - 1].color;
    for (let i = 0; i < s.length - 1; i++) {
      const a = s[i], b = s[i + 1];
      if (t >= a.at && t <= b.at) {
        const k = (t - a.at) / Math.max(1e-9, b.at - a.at);
        const av = parseInt(a.color.slice(1), 16), bv = parseInt(b.color.slice(1), 16);
        const r = Math.round(((av >> 16) & 255) * (1 - k) + ((bv >> 16) & 255) * k);
        const g = Math.round(((av >> 8) & 255) * (1 - k) + ((bv >> 8) & 255) * k);
        const bl = Math.round((av & 255) * (1 - k) + (bv & 255) * k);
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
      }
    }
    return s[s.length - 1].color;
  }

  // ================================================================
  // E1. SegmentedArc —— 分段圆弧进度
  // ================================================================
  //
  // 参数（全部可选，有合理默认）：
  //   cx, cy, radius     圆心与半径
  //   startAngle         起始角（度，0 = 3 点钟方向，顺时针）
  //   sweepAngle         总扫过角度（度，可为负 = 逆时针）
  //   segmentCount       分段数（如 32）
  //   gapAngle           段间空隙（度，如 2）
  //   thickness          线宽（px）
  //   progress           0..1，点亮比例
  //   activeColor        点亮色
  //   inactiveColor      未点亮色
  //   colorStops         可选：[{at:0..1,color}] 覆盖 activeColor，做分区渐变
  //   cap                线帽 'butt' | 'round'
  //
  // 为什么这样设计：赛车转速环要"一段一段亮"（不是连续弧）+ 末段变红（分区）；
  // 分段油门环要均匀分段；分区报警环要按 stops 上色。一套参数覆盖三种。
  function drawSegmentedArc(ctx, p) {
    const cx = num(p.cx, 0), cy = num(p.cy, 0);
    const radius = Math.max(1, num(p.radius, 50));
    const start = num(p.startAngle, 150);
    const sweep = num(p.sweepAngle, 240);
    const segments = Math.max(1, Math.round(num(p.segmentCount, 24)));
    const gap = Math.max(0, num(p.gapAngle, 2));
    const thickness = Math.max(1, num(p.thickness, radius * 0.18));
    const progress = clamp(num(p.progress, 0), 0, 1);
    const activeColor = p.activeColor || "#FF3D7F";
    const inactiveColor = p.inactiveColor || "#3A4048";
    const stops = p.colorStops || null;

    // 每段占的角度（含空隙）
    const stepTotal = sweep / segments;
    const segSweep = stepTotal - gap;
    if (segSweep <= 0) return;

    ctx.save();
    ctx.lineWidth = thickness;
    ctx.lineCap = p.cap || "butt";

    const lit = progress * segments;

    for (let i = 0; i < segments; i++) {
      const a0 = (start + i * stepTotal) / D;
      const a1 = (start + i * stepTotal + segSweep) / D;

      // 这一段被点亮了多少：0 = 全灭，1 = 全亮，中间 = 部分
      const litAmount = clamp(lit - i, 0, 1);

      // 未点亮底色
      ctx.strokeStyle = inactiveColor;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a1);
      ctx.stroke();

      if (litAmount > 0) {
        const t = (i + 0.5) / segments;
        const c = stops ? colorAt(stops, t) : activeColor;
        ctx.strokeStyle = c;
        ctx.beginPath();
        // 部分点亮：从 a0 画到 a0 + segSweep*litAmount
        ctx.arc(cx, cy, radius, a0, a0 + (a1 - a0) * litAmount);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** 返回分段让出的角度信息，便于测试/排障 */
  function segmentedArcLayout(p) {
    const radius = Math.max(1, num(p.radius, 50));
    const sweep = num(p.sweepAngle, 240);
    const segments = Math.max(1, Math.round(num(p.segmentCount, 24)));
    const gap = Math.max(0, num(p.gapAngle, 2));
    const stepTotal = sweep / segments;
    const segSweep = stepTotal - gap;
    const progress = clamp(num(p.progress, 0), 0, 1);
    return {
      radius: radius, segments: segments, stepTotal: stepTotal, segSweep: segSweep,
      litSegments: progress * segments,
      totalArcDeg: sweep,
      /** 实际画出来的弧总角度（扣掉空隙） */
      drawnArcDeg: segSweep * segments,
    };
  }

  // ================================================================
  // E2. PathProgress —— 沿自由路径前进
  // ================================================================
  //
  // 参数：
  //   w, h         画布区域
  //   points       [{x, y}] 控制点（2 个 = 直线，≥3 = 平滑曲线）
  //   curve        'linear' | 'smooth'（默认 smooth，用 Catmull-Rom → 三次贝塞尔）
  //   progress     0..1
  //   thickness    线宽
  //   baseColor    底层路径色
  //   fillColor    进度色（或 fillStops）
  //   glow         是否加发光
  //
  // ## 两端如何保持一致（这是原型要回答的关键问题）
  //
  // Android 侧有 `PathMeasure`：能直接取「路径总长」并按长度截断。
  // Windows/Canvas 侧**没有** PathMeasure —— 所以原型用**统一采样法**：
  //   把路径按固定点数（默认 200）采样成折线，用累计弦长近似路径长度，
  //   再按进度截断。两端用**同一采样密度**即可得到一致的进度位置。
  //
  // 这不是完美等价（弧长 vs 弦长），但差值随采样数增大而收敛；
  // 原型阶段用它验证"能不能沿曲线做进度"，正式接入时再决定：
  //   Android 用 PathMeasure，编辑器用**同一采样表**（把采样点写进设计数据或按算法复现）。
  const SAMPLE_N = 200;

  /** Catmull-Rom 插值成密集采样点（Windows 侧没有 PathMeasure 的替代方案） */
  function samplePath(points, curve, n) {
    const N = Math.max(2, Math.round(num(n, SAMPLE_N)));
    const pts = (points || []).filter((q) => q && Number.isFinite(Number(q.x)) && Number.isFinite(Number(q.y)))
      .map((q) => ({ x: Number(q.x), y: Number(q.y) }));
    if (pts.length < 2) return pts;
    if (curve === "linear") {
      // 线性：在每段上均分
      const out = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1) * (pts.length - 1);
        const k = Math.min(pts.length - 2, Math.floor(t));
        const f = t - k;
        out.push({ x: pts[k].x + (pts[k + 1].x - pts[k].x) * f, y: pts[k].y + (pts[k + 1].y - pts[k].y) * f });
      }
      return out;
    }
    // smooth：Catmull-Rom
    const out = [];
    const get = (i) => pts[clamp(i, 0, pts.length - 1)];
    const segCount = pts.length - 1;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1) * segCount;
      const k = Math.min(segCount - 1, Math.floor(t));
      const f = t - k;
      const p0 = get(k - 1), p1 = get(k), p2 = get(k + 1), p3 = get(k + 2);
      const f2 = f * f, f3 = f2 * f;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * f + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * f2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * f3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * f + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * f2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * f3),
      });
    }
    return out;
  }

  /** 累计弦长表 */
  function pathLengths(sampled) {
    const cum = [0];
    for (let i = 1; i < sampled.length; i++) {
      const dx = sampled[i].x - sampled[i - 1].x;
      const dy = sampled[i].y - sampled[i - 1].y;
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    return cum;
  }

  /** 按进度截断采样点（返回子折线） */
  function clipByProgress(sampled, cum, progress) {
    if (!sampled.length) return [];
    const total = cum[cum.length - 1];
    if (total <= 0) return [sampled[0]];
    const target = clamp(progress, 0, 1) * total;
    const out = [sampled[0]];
    for (let i = 1; i < sampled.length; i++) {
      if (cum[i] <= target) { out.push(sampled[i]); continue; }
      // 在 i-1 与 i 之间插值
      const segLen = cum[i] - cum[i - 1];
      const f = segLen > 0 ? (target - cum[i - 1]) / segLen : 0;
      out.push({
        x: sampled[i - 1].x + (sampled[i].x - sampled[i - 1].x) * f,
        y: sampled[i - 1].y + (sampled[i].y - sampled[i - 1].y) * f,
      });
      break;
    }
    return out;
  }

  function drawPathProgress(ctx, p) {
    const sampled = samplePath(p.points, p.curve || "smooth", p.sampleN);
    if (sampled.length < 2) return;
    const cum = pathLengths(sampled);
    const thickness = Math.max(0.5, num(p.thickness, 2));

    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    // 底层路径
    ctx.beginPath();
    ctx.moveTo(sampled[0].x, sampled[0].y);
    for (let i = 1; i < sampled.length; i++) ctx.lineTo(sampled[i].x, sampled[i].y);
    ctx.strokeStyle = p.baseColor || "#3A4048";
    ctx.lineWidth = thickness;
    ctx.stroke();

    // 进度段
    const prog = clipByProgress(sampled, cum, num(p.progress, 0));
    if (prog.length >= 2) {
      if (p.glow) {
        ctx.save();
        ctx.shadowBlur = thickness * 3;
        ctx.shadowColor = p.fillColor || "#4EA8FF";
      }
      ctx.beginPath();
      ctx.moveTo(prog[0].x, prog[0].y);
      for (let i = 1; i < prog.length; i++) ctx.lineTo(prog[i].x, prog[i].y);
      ctx.strokeStyle = p.fillColor || "#4EA8FF";
      ctx.lineWidth = thickness;
      ctx.stroke();
      if (p.glow) ctx.restore();
    }

    // 填充（可选：沿路径下方的面积）
    if (p.fillArea) {
      ctx.beginPath();
      ctx.moveTo(prog[0].x, prog[0].y);
      for (let i = 1; i < prog.length; i++) ctx.lineTo(prog[i].x, prog[i].y);
      const bottom = num(p.fillBottom, num(p.h, 0));
      ctx.lineTo(prog[prog.length - 1].x, bottom);
      ctx.lineTo(prog[0].x, bottom);
      ctx.closePath();
      ctx.fillStyle = rgba(p.fillColor || "#4EA8FF", num(p.fillAlpha, 0.25));
      ctx.fill();
    }

    // 端点（动态端点）
    if (prog.length) {
      const end = prog[prog.length - 1];
      ctx.beginPath();
      ctx.arc(end.x, end.y, thickness * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = p.fillColor || "#4EA8FF";
      ctx.fill();
    }
    ctx.restore();
  }

  /** 路径度量（供测试与两端一致性核对） */
  function pathProgressMetrics(p) {
    const sampled = samplePath(p.points, p.curve || "smooth", p.sampleN);
    const cum = pathLengths(sampled);
    const total = cum.length ? cum[cum.length - 1] : 0;
    const prog = clipByProgress(sampled, cum, num(p.progress, 0));
    const progCum = pathLengths(prog);
    return {
      samples: sampled.length,
      totalLength: total,
      clippedLength: progCum.length ? progCum[progCum.length - 1] : 0,
      endPoint: prog.length ? prog[prog.length - 1] : null,
    };
  }

  // ================================================================
  // E3. ValueText —— 独立动态数值文本
  // ================================================================
  //
  // 参数：
  //   x, y         基线位置
  //   value        数值（null → 占位）
  //   unit         单位
  //   decimals     小数位数（默认 1）
  //   prefix/suffix 前后缀
  //   placeholder  无数据占位（默认 "--"）
  //   size         字号
  //   family       字体
  //   align        'left'|'center'|'right'
  //   color        正常色
  //   warnHigh / warnLow / criticalHigh   阈值色
  //   warnColor / criticalColor
  //
  // 为什么单独做：现在要显示一个"独立读数"只能塞进 style 1（数字表）或 4/5/6（数值格），
  // 那两个都带固定布局。组合仪表需要"任意位置的单个数"。
  function drawValueText(ctx, p) {
    const v = (p.value === null || p.value === undefined || !Number.isFinite(Number(p.value)))
      ? null : Number(p.value);

    let text;
    if (v === null) {
      text = p.placeholder === undefined ? "--" : String(p.placeholder);
    } else {
      const dec = clamp(Math.round(num(p.decimals, 1)), 0, 6);
      text = v.toFixed(dec);
      // 去尾零（与 App BaseGaugeView.format 同语义）
      if (dec > 0 && text.indexOf(".") >= 0) text = text.replace(/0+$/, "").replace(/\.$/, "");
      if (p.prefix) text = String(p.prefix) + text;
      if (p.suffix) text = text + String(p.suffix);
    }

    let color = p.color || "#FFFFFF";
    if (v !== null) {
      const crit = Number(p.criticalHigh);
      const warnH = Number(p.warnHigh);
      const warnL = Number(p.warnLow);
      if (Number.isFinite(crit) && v >= crit) color = p.criticalColor || "#FF4D4F";
      else if (Number.isFinite(warnH) && v >= warnH) color = p.warnColor || "#FFB020";
      else if (Number.isFinite(warnL) && v <= warnL) color = p.warnColor || "#FFB020";
    }

    ctx.save();
    const size = Math.max(4, num(p.size, 14));
    ctx.font = (p.weight ? p.weight + " " : "") + size.toFixed(1) + "px " + (p.family || "sans-serif");
    ctx.textAlign = p.align || "left";
    ctx.textBaseline = p.baseline || "alphabetic";
    ctx.fillStyle = color;
    ctx.fillText(text, num(p.x, 0), num(p.y, 0));

    // 单位（小一号、跟随）
    if (p.unit && v !== null) {
      const uw = ctx.measureText(text).width;
      ctx.font = (size * 0.55).toFixed(1) + "px " + (p.family || "sans-serif");
      ctx.fillStyle = p.unitColor || rgba(color, 0.75);
      const anchorX = num(p.x, 0);
      let ux = anchorX + uw + size * 0.15;
      if ((p.align || "left") === "center") ux = anchorX + uw / 2 + size * 0.15;
      ctx.fillText(String(p.unit), ux, num(p.y, 0));
    }
    ctx.restore();
    return text;
  }

  // ================================================================
  // E4. Shape —— 基础图形基元
  // ================================================================
  //
  // 支持的 kind：
  //   'rect'       矩形
  //   'roundRect'  圆角矩形
  //   'circle'     圆 / 环
  //   'line'       线段
  //   'polyline'   折线
  //   'path'       任意路径（points 采样）
  //
  // 优先复用现有渲染工具：圆角矩形直接复制 canvas.js `roundRect` 的同一套 arcTo 逻辑
  // （原型独立文件不能引用 canvas.js 的内部函数，所以这里保持等价实现，
  //  正式接入时应把 `roundRect` 提到公共模块共用一份）。
  function drawShape(ctx, p) {
    const kind = p.kind || "rect";
    ctx.save();
    if (p.fill) ctx.fillStyle = p.fill;
    if (p.stroke) {
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = Math.max(0.5, num(p.strokeWidth, 1));
    }

    if (kind === "circle" || kind === "ring") {
      const cx = num(p.cx, 0), cy = num(p.cy, 0), r = Math.max(0.5, num(p.r, 10));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (kind === "circle" && p.fill) ctx.fill();
      if (p.stroke) ctx.stroke();
    } else if (kind === "line") {
      ctx.beginPath();
      ctx.moveTo(num(p.x1, 0), num(p.y1, 0));
      ctx.lineTo(num(p.x2, 0), num(p.y2, 0));
      if (p.stroke) ctx.stroke();
    } else if (kind === "polyline" || kind === "path") {
      const pts = (p.points || []).filter((q) => q && Number.isFinite(Number(q.x)));
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(Number(pts[0].x), Number(pts[0].y));
        for (let i = 1; i < pts.length; i++) ctx.lineTo(Number(pts[i].x), Number(pts[i].y));
        if (p.closed) ctx.closePath();
        if (p.fill) ctx.fill();
        if (p.stroke) ctx.stroke();
      }
    } else {
      // rect / roundRect
      const x = num(p.x, 0), y = num(p.y, 0);
      const w = Math.max(0, num(p.w, 10)), h = Math.max(0, num(p.h, 10));
      const r = Math.max(0, Math.min(num(p.r, 0), w / 2, h / 2));
      ctx.beginPath();
      if (r > 0) {
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      } else {
        ctx.rect(x, y, w, h);
      }
      if (p.fill) ctx.fill();
      if (p.stroke) ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 导出

  window.AdvancedPrimitives = {
    /** 原型标识：明确告诉调用方"这不是正式节点类型" */
    PROTO: true,
    KINDS: ["segmentedArc", "pathProgress", "valueText", "shape"],

    draw: function (ctx, kind, params) {
      if (kind === "segmentedArc") return drawSegmentedArc(ctx, params || {});
      if (kind === "pathProgress") return drawPathProgress(ctx, params || {});
      if (kind === "valueText") return drawValueText(ctx, params || {});
      if (kind === "shape") return drawShape(ctx, params || {});
      return null;
    },

    // 便于测试的内部函数
    _internals: {
      clamp: clamp, rgba: rgba, colorAt: colorAt,
      drawSegmentedArc: drawSegmentedArc, segmentedArcLayout: segmentedArcLayout,
      samplePath: samplePath, pathLengths: pathLengths, clipByProgress: clipByProgress,
      drawPathProgress: drawPathProgress, pathProgressMetrics: pathProgressMetrics,
      drawValueText: drawValueText, drawShape: drawShape,
      SAMPLE_N: SAMPLE_N,
    },
  };
})();
