package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet

/**
 * 四数据显示：2×2 排布 —— 主参数在左上，三个副参数依次填满其余三格。
 *
 * 单元格尺寸小，所以 [drawCell] 的字号按格高取比例，
 * 在平板上被放大后不会出现「大格子小字」。
 */
class QuadGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : MultiValueGaugeView(context, attrs, def) {

    private val dividerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val halfW = w / 2f
        val halfH = h / 2f

        dividerPaint.color = cTrack
        dividerPaint.strokeWidth = dp(1f)
        canvas.drawLine(halfW, dp(6f), halfW, h - dp(6f), dividerPaint)
        canvas.drawLine(dp(6f), halfH, w - dp(6f), halfH, dividerPaint)

        // 左上：主参数
        drawCell(canvas, halfW / 2f, 0f, halfH, label(), primaryFormat(), unit(), -1)
        // 右上 / 左下 / 右下：副参数
        drawCell(canvas, halfW * 1.5f, 0f, halfH, extraLabel(0), extraFormat(0), extraUnit(0), 0)
        drawCell(canvas, halfW / 2f, halfH, halfH, extraLabel(1), extraFormat(1), extraUnit(1), 1)
        drawCell(canvas, halfW * 1.5f, halfH, halfH, extraLabel(2), extraFormat(2), extraUnit(2), 2)
    }
}
