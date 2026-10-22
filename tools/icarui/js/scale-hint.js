/* ==========================================================================
   scale-hint.js —— 缩放模式的**量化提示**（P5A-M03 阶段 C）
   ==========================================================================

   ## 它解决什么

   编辑器早就有 `canvas.scaleMode` 三档（拉伸/等比/等比铺满）和「画布尺寸」两个数，
   但**用户看不到后果**：选"拉伸"到底会歪多少？选"等比"会留多宽的边？
   只能导到手机上才发现。

   这个模块把后果**算出来给他看**：对当前设计分辨率 + 三种常见屏幕比例，
   算出「形变系数」与「留白比例」。

   ## 与 App 侧的口径必须一致

   Android 侧 `NodeTreeRenderer.computeViewport()`：

   ```kotlin
   SCALE_FIT  -> k = min(cw/360, ch/360)   → 两轴同 k（等比）
   SCALE_FILL -> k = max(cw/360, ch/360)   → 两轴同 k（等比，裁切）
   else       -> kx = cw/360, ky = ch/360  → 每轴独立（会形变）
   ```

   本文件对**每轴独立**的情形给出 `kx/ky` 比值作"形变系数"，
   对等比情形给 `1.0`（不变形）并算出留边宽度。

   ⚠️ 这里**只读设计数据、只做计算**，不改任何节点坐标或尺寸 ——
   任务要求「不因用户更换模式而改动节点位置或尺寸数据」。
   ========================================================================== */
"use strict";

(function () {
  /** 三种常见屏幕比例（任务要求：手机竖屏 / 平板横屏 / 车载宽屏） */
  window.SCREEN_PRESETS = [
    { id: "phone", name: "手机竖屏", w: 1080, h: 2400 },
    { id: "tablet", name: "平板横屏", w: 1600, h: 1000 },
    { id: "carwide", name: "车载宽屏", w: 1280, h: 600 },
  ];

  /**
   * 针对一个「设计分辨率 × 目标屏幕 × 缩放模式」算出后果。
   *
   * @param {number} mode 0=拉伸 1=等比 2=等比铺满
   * @param {number} dw 设计宽   @param {number} dh 设计高
   * @param {number} sw 屏幕宽   @param {number} sh 屏幕高
   * @returns {{kx:number,ky:number,distort:number,drawW:number,drawH:number,
   *            padX:number,padY:number,cropX:number,cropY:number}}
   *   `distort` = kx/ky（1 = 不变形；越远离 1 越歪）
   *   `padX/padY` = 等比时左右/上下留边（像素）
   *   `cropX/cropY` = 等比铺满时被裁掉的量（像素）
   */
  window.scaleModeStats = function (mode, dw, dh, sw, sh) {
    const W = Math.max(1, Number(dw) || 1);
    const H = Math.max(1, Number(dh) || 1);
    const SW = Math.max(1, Number(sw) || 1);
    const SH = Math.max(1, Number(sh) || 1);
    const m = Number(mode) || 0;

    if (m === 1) {                       // 等比（可能留边）
      const k = Math.min(SW / W, SH / H);
      const drawW = W * k, drawH = H * k;
      return {
        kx: k, ky: k, distort: 1, drawW: drawW, drawH: drawH,
        padX: Math.max(0, SW - drawW), padY: Math.max(0, SH - drawH),
        cropX: 0, cropY: 0,
      };
    }
    if (m === 2) {                       // 等比铺满（裁切）
      const k = Math.max(SW / W, SH / H);
      const drawW = W * k, drawH = H * k;
      return {
        kx: k, ky: k, distort: 1, drawW: drawW, drawH: drawH,
        padX: 0, padY: 0,
        cropX: Math.max(0, drawW - SW), cropY: Math.max(0, drawH - SH),
      };
    }
    // 拉伸（每轴独立）——旧主题的默认行为
    const kx = SW / W, ky = SH / H;
    return {
      kx: kx, ky: ky, distort: kx / ky, drawW: SW, drawH: SH,
      padX: 0, padY: 0, cropX: 0, cropY: 0,
    };
  };

  // 百分比，保留一位小数；null 时返回 ASCII 连字符占位
  // （守卫要求全角破折号必须成对，这里只是占位符，用半角避免误判）
  function pct(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    return (v * 100).toFixed(1) + "%";
  }

  /**
   * 一行人类可读的结论（用于提示面板）。
   *
   * 判据（与报告里的实测口径一致）：
   *   · 拉伸模式下 |distort-1| ≥ 15% → 明确提示"会明显变形"
   *   · 等比模式留边占短边 ≥ 10% → 提示"会留明显黑边"
   */
  window.scaleModeVerdict = function (mode, dw, dh, sw, sh) {
    const s = window.scaleModeStats(mode, dw, dh, sw, sh);
    const m = Number(mode) || 0;
    if (m === 0) {
      const dev = Math.abs(s.distort - 1);
      const word = dev < 0.05 ? "基本不变形" : dev < 0.15 ? "轻微变形" : "**明显变形**";
      const dir = s.distort > 1 ? "横向拉宽" : "纵向拉高";
      return {
        stats: s, level: dev < 0.05 ? "ok" : dev < 0.15 ? "warn" : "bad",
        text: "形变系数 " + s.distort.toFixed(3) + "（" + word + "，" + dir + " " + pct(dev) + "）",
      };
    }
    const padRatio = Math.max(s.padX / sw, s.padY / sh);
    if (m === 1) {
      const word = padRatio < 0.02 ? "几乎无留边" : padRatio < 0.10 ? "有少量留边" : "**留明显黑边**";
      return {
        stats: s, level: padRatio < 0.02 ? "ok" : padRatio < 0.10 ? "warn" : "bad",
        text: "不变形；" + word + "（" + (s.padX > 0 ? "左右 " + Math.round(s.padX) + "px" : "上下 " + Math.round(s.padY) + "px") + "）",
      };
    }
    const cropRatio = Math.max(s.cropX / sw, s.cropY / sh);
    return {
      stats: s, level: cropRatio > 0.02 ? "warn" : "ok",
      text: "不变形；裁掉 " + (s.cropX > 0 ? "左右 " + Math.round(s.cropX) + "px" : "上下 " + Math.round(s.cropY) + "px"),
    };
  };

  /** 当前设计（从 CanvasState 取）在三档屏幕下的提示表 */
  window.scaleModeTable = function () {
    const cv = (window.CanvasState && window.CanvasState.design && window.CanvasState.design.canvas) || {};
    const dw = Number(cv.designW) || 2560;
    const dh = Number(cv.designH) || 1600;
    const mode = Number(cv.scaleMode) || 0;
    return {
      designW: dw, designH: dh, mode: mode,
      rows: window.SCREEN_PRESETS.map(function (p) {
        const v = window.scaleModeVerdict(mode, dw, dh, p.w, p.h);
        return { id: p.id, name: p.name, screen: p.w + "×" + p.h, level: v.level, text: v.text, stats: v.stats };
      }),
    };
  };
})();
