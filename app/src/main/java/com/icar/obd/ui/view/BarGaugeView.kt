package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet

/**
 * 横向条形表。信息密度最高，适合「一屏放多个次要指标」的场景。
 *
 * 布局：上行 = 名称（左）+ 数值单位（右），下行 = 进度条。
 * 字号与条高均按视图高度取比例，适配手机与平板两种尺度。
 */
class BarGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : BaseGaugeView(context, attrs, def) {

    private val barRect = RectF()
    private val barPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val markPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    private val labelPaint = newTextPaint(1f, cLabel)
    private val valuePaint = newTextPaint(1f, cValue, true)
    private val unitPaint = newTextPaint(1f, cLabel)

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        // 报警时主色往危险色推，并参与爆闪 —— 见 AlertPulse
        val main = alertMix(mainColor())
        val tint = alertTint()
        val flash = alertIntensity()
        // 字号基准同时受高度与宽度约束，防止极端长宽比下文字横向溢出
        val base = minOf(h, w * 0.5f)

        labelPaint.textSize = base * 0.23f
        valuePaint.textSize = base * 0.30f
        unitPaint.textSize = base * 0.19f
        labelPaint.color = cLabel
        unitPaint.color = cLabel

        val topBaseline = base * 0.33f

        // 上行文字
        labelPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(label(), dp(10f), topBaseline, labelPaint)

        val text = valueText()
        // 报警时数值也参与染色，但**不降低对比度**（读数在任何时刻都必须能看清）
        valuePaint.color = valueTextColor()
        valuePaint.textAlign = Paint.Align.RIGHT
        val unitText = unit()
        unitPaint.textAlign = Paint.Align.RIGHT
        val unitW = if (unitText.isEmpty()) 0f else unitPaint.measureText(unitText) + dp(3f)
        canvas.drawText(unitText, w - dp(10f), topBaseline, unitPaint)
        canvas.drawText(text, w - dp(10f) - unitW, topBaseline, valuePaint)

        // 进度条
        // 高度按视图比例算，再乘主题的 strokeDp 系数 ——
        // strokeDp=9（默认）时与旧版完全一致，调大就变粗
        val barH = (base * 0.13f * (palette.strokeDp / 9f)).coerceIn(dp(4f), dp(22f))
        val barY = h - barH - dp(8f)
        barRect.set(dp(10f), barY, w - dp(10f), barY + barH)
        neon.roundRect(canvas, barRect, barH / 2f, cTrack)

        // 用缓动后的显示值，避免 5Hz 数据到达时条长一跳一跳
        val r = shownRatio()
        if (r > 0f) {
            val saved = barRect.right
            barRect.right = dp(10f) + (w - dp(20f)) * r
            if (palette.glow) {
                val spread = neon.spreadFor(base).coerceAtMost(barH * 1.2f)
                neon.bloomRoundRect(canvas, barRect, barH / 2f, main, spread, neon.layersFor(base))
            }
            neon.roundRect(canvas, barRect, barH / 2f, main)
            barRect.right = saved
        }

        // 爆闪：整条轨道随节奏亮一下。这是"条形表也在报警"的视觉信号 ——
        // 只让数字变色不够醒目，条本身要动起来
        if (flash > 0.01f) {
            val flashColor = AlertPulse.alpha(cDanger, (180 * flash).toInt().coerceIn(0, 255))
            val saved = barRect.right
            barRect.right = dp(10f) + (w - dp(20f)) * r.coerceAtLeast(0.02f)
            neon.bloomRoundRect(
                canvas, barRect, barH / 2f, flashColor,
                barH * (0.5f + flash), 2 + (neon.layersFor(base) / 3)
            )
            barRect.right = saved
        }

        // 报警阈值刻度线，让用户一眼看到「离红线还有多远」。
        // 危险区的线在爆闪时一起变亮 —— 和圆表底轨的危险区呼应
        markPaint.strokeWidth = dp(1.5f)
        val span = item.maxVal - item.minVal
        item.warnHigh?.let { wh ->
            if (span > 0f && wh in item.minVal..item.maxVal) {
                val x = dp(10f) + (w - dp(20f)) * ((wh - item.minVal) / span)
                markPaint.color = if (tint > 0f) AlertPulse.mix(cDanger, 0xFFFF4040.toInt(), tint) else cDanger
                markPaint.strokeWidth = dp(1.5f + 1.5f * flash)
                canvas.drawLine(x, barY - dp(2f), x, barY + barH + dp(2f), markPaint)
                markPaint.strokeWidth = dp(1.5f)
            }
        }
        item.warnLow?.let { wl ->
            if (span > 0f && wl in item.minVal..item.maxVal) {
                val x = dp(10f) + (w - dp(20f)) * ((wl - item.minVal) / span)
                markPaint.color = cWarn
                canvas.drawLine(x, barY - dp(2f), x, barY + barH + dp(2f), markPaint)
            }
        }
    }

    /**
     * 半个像素的等价数值。
     *
     * 条形是**长度**的视觉，用相对比例（默认实现）会让尾巴拖很长 ——
     * 表现就是"快到位置了还在慢慢蹭"。折算成像素后，
     * 剩下不到半个像素就吸附，肉眼完全看不出跳变。
     */
    override val settleEpsilon: Float
        get() {
            val w = width.toFloat()
            val span = item.maxVal - item.minVal
            return if (w <= 0f || span <= 0f) super.settleEpsilon else span / w * 0.5f
        }

    /** 格式化缓存：文本只随 `value` 变（5Hz），不随缓动变（60fps） */
    private var cachedText: String = "--"
    private var cachedFor: Float = Float.NaN

    private fun valueText(): String {
        val v = value
        val key = v ?: Float.NaN
        if (key != cachedFor || cachedFor.isNaN() != key.isNaN()) {
            cachedFor = key
            cachedText = format(v)
        }
        return cachedText
    }
}
