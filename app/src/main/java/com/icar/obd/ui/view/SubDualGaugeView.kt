package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet

/**
 * 主 + 子双数据：主参数占上半（大号），两个子参数在下半并排（小号）。
 *
 * 这是「主参数/子参数」两级数据概念最直接的体现：
 * 主参数（转速/水温…）一眼可读，子参数（进气温度/机油温度…）退到次要位置。
 */
class SubDualGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : MultiValueGaugeView(context, attrs, def) {

    private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val topH = h * 0.56f
        val botH = h - topH

        dividerPaint.color = cTrack
        dividerPaint.strokeWidth = dp(1f)
        canvas.drawLine(dp(8f), topH, w - dp(8f), topH, dividerPaint)
        canvas.drawLine(w / 2f, topH + dp(4f), w / 2f, h - dp(4f), dividerPaint)

        drawCell(canvas, w / 2f, 0f, topH, label(), primaryFormat(), unit(), -1)
        drawCell(canvas, w * 0.25f, topH, botH, extraLabel(0), extraFormat(0), extraUnit(0), 0)
        drawCell(canvas, w * 0.75f, topH, botH, extraLabel(1), extraFormat(1), extraUnit(1), 1)
    }
}
