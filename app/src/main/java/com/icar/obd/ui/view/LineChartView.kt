package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet

/**
 * 线型图：把主参数的**最近历史**画成折线 + 半透明面积。
 *
 * 历史来自 [com.icar.obd.obd.VehicleBus.historyOf]，由渲染层通过 [updateHistory]
 * 推给本视图（见 [wantsHistory]）—— 视图**不去读总线**，保持红线 4.1.5。
 *
 * 纵轴固定用仪表自己的量程（[com.icar.obd.data.GaugeItem.minVal] / `maxVal`），
 * 不做自动缩放：固定量程才能一眼看出「这段是高了还是低了」，
 * 自动缩放会让一条平线看起来也在剧烈波动。
 */
class LineChartView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : BaseGaugeView(context, attrs, def) {

    override val wantsHistory: Boolean get() = true

    private var history: List<Float> = emptyList()

    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val axisPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val linePath = Path()
    private val fillPath = Path()

    private var valuePaint: Paint? = null
    private var labelPaint: Paint? = null
    private var hintPaint: Paint? = null

    override fun updateHistory(history: List<Float>) {
        if (history == this.history) return
        this.history = history
        invalidate()
    }

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val padL = dp(10f)
        val padR = dp(10f)
        val padT = dp(24f)
        val padB = dp(10f)
        val plotW = (w - padL - padR).coerceAtLeast(1f)
        val plotH = (h - padT - padB).coerceAtLeast(1f)

        val base = minOf(w, h)
        val vp = valuePaint ?: newTextPaint(1f, cValue, true).also { valuePaint = it }
        val lp = labelPaint ?: newTextPaint(1f, cLabel).also { labelPaint = it }
        val hp = hintPaint ?: newTextPaint(1f, cDim).also { hintPaint = it }
        vp.textSize = base * 0.13f
        lp.textSize = base * 0.075f
        hp.textSize = base * 0.065f

        // 顶部一行：左标签，右当前值
        lp.textAlign = Paint.Align.LEFT
        lp.color = cLabel
        canvas.drawText(label(), padL, dp(14f), lp)

        vp.textAlign = Paint.Align.RIGHT
        vp.color = valueTextColor()
        neonText(canvas, "${format(value)} ${unit()}".trim(), w - padR, dp(15f), vp, vp.color, dp(14f))

        // 坐标轴：左竖线 + 底横线
        axisPaint.color = cTrack
        axisPaint.strokeWidth = dp(1f)
        canvas.drawLine(padL, padT, padL, padT + plotH, axisPaint)
        canvas.drawLine(padL, padT + plotH, padL + plotW, padT + plotH, axisPaint)

        if (history.size < 2) {
            hp.textAlign = Paint.Align.CENTER
            hp.color = cDim
            canvas.drawText("等待数据…", w / 2f, padT + plotH / 2f, hp)
            hp.textAlign = Paint.Align.CENTER
            return
        }

        val lo = item.minVal
        val hi = item.maxVal
        val span = (hi - lo).let { if (it <= 0f) 1f else it }
        val n = history.size

        linePath.reset()
        history.forEachIndexed { i, v ->
            val x = padL + plotW * i / (n - 1).toFloat()
            val y = padT + plotH * (1f - ((v - lo) / span).coerceIn(0f, 1f))
            if (i == 0) linePath.moveTo(x, y) else linePath.lineTo(x, y)
        }

        val main = mainColor()

        // 面积填充（同色低透明度），趋势更容易读
        fillPath.set(linePath)
        fillPath.lineTo(padL + plotW, padT + plotH)
        fillPath.lineTo(padL, padT + plotH)
        fillPath.close()
        fillPaint.color = glowColor(main, 40)
        canvas.drawPath(fillPath, fillPaint)

        linePaint.color = main
        linePaint.strokeWidth = dp(2f)
        // 辉光层先铺（P7-8）—— 必须在实线**之前**，否则光会盖住线。
        // 用 plotH 当尺寸基准：辉光的层数与扩散跟"图有多高"相关，
        // 而不是跟控件宽度（宽表上的线不会因为宽就变得更亮）。
        neonPath(canvas, linePath, linePaint, linePaint.color, linePaint.strokeWidth,
            palette.glow, plotH)
        canvas.drawPath(linePath, linePaint)

        // 末端点：强调「当前值在哪」
        val lastY = padT + plotH * (1f - ((history.last() - lo) / span).coerceIn(0f, 1f))
        linePaint.style = Paint.Style.FILL
        linePaint.color = main
        canvas.drawCircle(padL + plotW, lastY, dp(3f), linePaint)
        linePaint.style = Paint.Style.STROKE
    }
}
