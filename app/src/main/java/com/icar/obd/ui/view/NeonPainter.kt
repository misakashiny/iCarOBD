package com.icar.obd.ui.view

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF

/**
 * 共用的**霓虹辉光**绘制层。
 *
 * ## 为什么抽出来
 *
 * 原来只有 [CircularGaugeView] 有辉光，而且是写死的 4 层循环。
 * 数字、条形、折线都不发光 —— 整个仪表盘看起来是"一个霓虹表 + 一堆素控件"，不统一。
 * 现在所有仪表共用同一套原语，视觉才是一套设计。
 *
 * ## 性能（**这是这个类存在的第二个理由**）
 *
 * 辉光靠"叠多层宽线"实现，**层数是唯一有效的开销旋钮**：
 * 每一层都是一次 `drawArc`/`drawLine`，覆盖面积随描边宽度线性增长。
 *
 * 所以层数**按控件尺寸自适应**（见 [layersFor]）——
 * 小控件上叠 10 层既看不出效果又白花钱。实测 327 万像素的屏上，
 * 8 个表各叠 10 层是压不进 60fps 预算的。
 *
 * ## 不分配对象
 *
 * 所有 [Paint] 都是复用的，`onDraw` 里**不 new 任何东西**。
 * 60fps 下每次分配都会给 GC 压力，表现就是周期性掉帧。
 */
class NeonPainter {

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }

    /**
     * 当前样式。由 [BaseGaugeView.onDraw] 每帧设好 ——
     * 这样各子类不用自己传参，样式又能按表覆盖。
     */
    var style: NeonStyle = NeonStyle.AUTO

    /** 辉光最外层的透明度上限。太高会糊成一片，看不出"层" */
    private val outerAlpha = 110

    /**
     * 按控件边长决定辉光层数。
     *
     * 阈值是量出来的取舍：小表上 4 层和 10 层**肉眼无差别**，但开销差 2.5 倍。
     */
    fun layersFor(sizePx: Float): Int {
        val adaptive = when {
            sizePx < 160f -> 3
            sizePx < 300f -> 5
            sizePx < 520f -> 7
            else -> 9
        }
        return style.layersOr(adaptive)
    }

    /** 辉光最外层的额外宽度（相对描边）。按尺寸给，小表不需要大范围扩散 */
    fun spreadFor(sizePx: Float): Float =
        (sizePx * style.spreadRatio).coerceIn(1f, 60f)

    // ---------------------------------------------------------------- 弧

    /**
     * 画带辉光的弧。
     *
     * @param rect      弧的外接矩形（**不含辉光**；辉光会向外扩，调用方要预留边距）
     * @param maxSpread 最外层比 [strokePx] 宽多少
     */
    fun bloomArc(
        canvas: Canvas, rect: RectF, start: Float, sweep: Float,
        color: Int, strokePx: Float, maxSpread: Float, layers: Int
    ) {
        if (sweep == 0f || strokePx <= 0f) return
        paint.style = Paint.Style.STROKE
        // 由外向内：外层最宽最淡，内层最窄最亮 —— 叠起来才是"从暗到亮"的渐变
        for (i in layers downTo 1) {
            val t = i.toFloat() / layers
            paint.color = AlertPulse.alpha(color, ((outerAlpha * (1f - t) + 10f) * style.intensity).toInt().coerceIn(0, 255))
            paint.strokeWidth = strokePx + maxSpread * t
            canvas.drawArc(rect, start, sweep, false, paint)
        }
    }

    /** 不发光的一段弧（底轨、危险区底色等） */
    fun arc(canvas: Canvas, rect: RectF, start: Float, sweep: Float, color: Int, strokePx: Float) {
        paint.style = Paint.Style.STROKE
        paint.color = color
        paint.strokeWidth = strokePx
        canvas.drawArc(rect, start, sweep, false, paint)
    }

    // ---------------------------------------------------------------- 线

    fun bloomLine(
        canvas: Canvas, x1: Float, y1: Float, x2: Float, y2: Float,
        color: Int, strokePx: Float, maxSpread: Float, layers: Int
    ) {
        paint.style = Paint.Style.STROKE
        for (i in layers downTo 1) {
            val t = i.toFloat() / layers
            paint.color = AlertPulse.alpha(color, ((outerAlpha * (1f - t) + 10f) * style.intensity).toInt().coerceIn(0, 255))
            paint.strokeWidth = strokePx + maxSpread * t
            canvas.drawLine(x1, y1, x2, y2, paint)
        }
    }

    fun line(
        canvas: Canvas, x1: Float, y1: Float, x2: Float, y2: Float,
        color: Int, strokePx: Float
    ) {
        paint.style = Paint.Style.STROKE
        paint.color = color
        paint.strokeWidth = strokePx
        canvas.drawLine(x1, y1, x2, y2, paint)
    }

    // ---------------------------------------------------------------- 圆角矩形

    /** 不发光的一块圆角矩形（轨道、底色） */
    fun roundRect(
        canvas: Canvas, rect: RectF, r: Float, color: Int
    ) {
        paint.style = Paint.Style.FILL
        paint.color = color
        canvas.drawRoundRect(rect, r, r, paint)
    }

    /**
     * 带辉光的圆角矩形 —— 条形表的主体。
     *
     * 用描边逐层加宽来模拟外发光：比 `BlurMaskFilter` 可控，
     * 而且**在硬件加速下可用**（`BlurMaskFilter` 对硬件层支持有限）。
     */
    fun bloomRoundRect(
        canvas: Canvas, rect: RectF, r: Float, color: Int,
        maxSpread: Float, layers: Int
    ) {
        paint.style = Paint.Style.STROKE
        for (i in layers downTo 1) {
            val t = i.toFloat() / layers
            paint.color = AlertPulse.alpha(color, ((outerAlpha * (1f - t) + 8f) * style.intensity).toInt().coerceIn(0, 255))
            paint.strokeWidth = maxSpread * t * 2f
            canvas.drawRoundRect(rect, r, r, paint)
        }
    }

    // ---------------------------------------------------------------- 圆

    fun bloomCircle(
        canvas: Canvas, cx: Float, cy: Float, r: Float,
        color: Int, maxSpread: Float, layers: Int
    ) {
        paint.style = Paint.Style.FILL
        for (i in layers downTo 1) {
            val t = i.toFloat() / layers
            paint.color = AlertPulse.alpha(color, ((outerAlpha * (1f - t) + 10f) * style.intensity).toInt().coerceIn(0, 255))
            canvas.drawCircle(cx, cy, r + maxSpread * t, paint)
        }
    }

    // ---------------------------------------------------------------- 文字

    /**
     * 文字辉光：同一段文字画几遍，由外向内逐步收紧透明度。
     *
     * 比 `setShadowLayer` 可控 —— 后者在硬件加速下对大字号的模糊半径有限制，
     * 而且没法按主题派生颜色。
     */
    fun glowText(
        canvas: Canvas, text: String, x: Float, y: Float,
        textPaint: Paint, color: Int, layers: Int, spreadPx: Float
    ) {
        if (layers <= 0 || !style.textGlow) return
        val saved = textPaint.color
        val savedStyle = textPaint.style
        textPaint.style = Paint.Style.STROKE
        textPaint.strokeWidth = spreadPx * 0.5f
        for (i in layers downTo 1) {
            val t = i.toFloat() / layers
            textPaint.color = AlertPulse.alpha(color, (outerAlpha * (1f - t)).toInt())
            textPaint.strokeWidth = spreadPx * t
            canvas.drawText(text, x, y, textPaint)
        }
        textPaint.style = savedStyle
        textPaint.color = saved
    }

    /** 释放内部 Paint 引用（View 从窗口摘除时调，帮助 GC） */
    fun recycle() {
        paint.reset()
    }
}
