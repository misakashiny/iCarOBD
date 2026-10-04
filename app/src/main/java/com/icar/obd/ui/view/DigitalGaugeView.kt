package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet

/**
 * 数字大屏。适合「一眼要看清」的主指标（车速 / 转速）。
 * 底部保留一条极细进度条，用于表达量程位置，不抢主数值的视觉。
 *
 * 所有字号按视图高度取比例，因此在手机与（被放大后的）平板上观感一致。
 */
class DigitalGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : BaseGaugeView(context, attrs, def) {

    private val barRect = RectF()
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private val valuePaint = newTextPaint(1f, cValue, true)
    private val unitPaint = newTextPaint(1f, cLabel)
    private val labelPaint = newTextPaint(1f, cLabel)
    private val rangePaint = newTextPaint(1f, cDim)

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val main = mainColor()

        // 字号基准取「高度」与「宽度×0.42」的较小值。
        // 只按高度取会在横屏宽格子里爆炸（格子又宽又高时高度很大，
        // 数值与单位会横向溢出）；只按宽度取则在竖屏高格子里过小。
        val base = minOf(h, w * 0.42f)

        labelPaint.textSize = base * 0.16f
        rangePaint.textSize = base * 0.12f
        unitPaint.textSize = base * 0.19f
        labelPaint.color = cLabel
        rangePaint.color = cDim
        unitPaint.color = cLabel

        // 标签（左上）
        labelPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(label(), dp(10f), base * 0.20f + dp(6f), labelPaint)

        // 量程（右上）
        rangePaint.textAlign = Paint.Align.RIGHT
        canvas.drawText(
            "${trim(item.minVal)}~${trim(item.maxVal)}${unit()}",
            w - dp(10f), base * 0.20f + dp(6f), rangePaint
        )

        // 主数值：先按基准取字号，再按可用宽度收缩，避免长数字溢出
        val text = format(value)
        val unitText = unit()
        val reserved = if (unitText.isEmpty()) 0f else unitPaint.measureText(unitText) + dp(6f)
        val maxW = w - dp(20f) - reserved
        var ts = base * 0.44f
        valuePaint.textSize = ts
        val minTs = base * 0.14f
        while (valuePaint.measureText(text) > maxW && ts > minTs) {
            ts -= base * 0.02f
            valuePaint.textSize = ts
        }
        // 数值发光（P7-8）。颜色走 valueTextColor() —— 报警时是红的，
        // 辉光要跟着一起变色，否则"数字红了但光还是橙的"。
        val vColor = valueTextColor()
        valuePaint.color = vColor

        // 数值块整体垂直居中（h*0.52 + 半字高 ≈ 视觉中心，与竖屏原版一致）
        val baseline = h * 0.52f + ts * 0.35f
        valuePaint.textAlign = Paint.Align.CENTER
        // 用 neonText 而不是裸 drawText —— 辉光开关关掉时它退化成普通绘制，零开销
        neonText(canvas, text, w / 2f, baseline, valuePaint, vColor, ts)

        // 单位跟随数值右侧
        unitPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(
            unitText, w / 2f + valuePaint.measureText(text) / 2f + dp(6f), baseline, unitPaint
        )

        // 底部细进度条
        val barH = (base * 0.045f).coerceIn(dp(3f), dp(8f))
        val barY = h - barH - dp(10f)
        barRect.set(dp(10f), barY, w - dp(10f), barY + barH)
        barPaint.color = cTrack
        canvas.drawRoundRect(barRect, barH / 2f, barH / 2f, barPaint)
        // 用 shownRatio() 而不是 ratio(value)：底部进度条也要参与缓动，
        // 否则它是**跳变**的，和圆表/条形表的平滑观感不统一
        // （这一行是 docs/动画实现.md 记了很久的那个不一致，v1.10.1 修掉）
        val r = shownRatio()
        if (r > 0f) {
            barRect.right = dp(10f) + (w - dp(20f)) * r
            // 发光进度条：辉光颜色用 main（与圆表/条形表同一套观感）
            neonBar(canvas, barRect, barH / 2f, main, palette.glow, base)
        }
    }

    private fun trim(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else String.format("%.1f", f)
}
