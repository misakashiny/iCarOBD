package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet

/**
 * 双数据 + 上下：主参数在上、第一个副参数在下，各占一半高度。
 *
 * 与 [SubDualGaugeView] 的区别：本类**上下等分**（两行一样大），
 * SubDual 是「上大下小、下面两个并排」。
 */
class DualStackGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : MultiValueGaugeView(context, attrs, def) {

    private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val half = h / 2f
        // 上下两块之间画一条淡分隔线，否则两个数字容易看串行
        dividerPaint.color = cTrack
        dividerPaint.strokeWidth = dp(1f)
        canvas.drawLine(dp(8f), half, w - dp(8f), half, dividerPaint)

        drawCell(canvas, w / 2f, 0f, half, label(), primaryFormat(), unit(), -1)
        drawCell(
            canvas, w / 2f, half, half,
            extraLabel(0), extraFormat(0), extraUnit(0), 0
        )
    }
}
