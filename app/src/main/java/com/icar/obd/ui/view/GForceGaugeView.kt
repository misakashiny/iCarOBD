package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet

/**
 * G力值：把横向/纵向加速度画成圆内的一个点，中心显示综合 G 值。
 *
 * 数据约定（见 [com.icar.obd.data.DashLayout.gForce]）：
 *  - 主参数 [value] = 综合 G 值（`calc_gforce`）
 *  - 副参数 0 = 横向 G（`calc_gx`），副参数 1 = 纵向 G（`calc_gy`）
 *
 * 圆边界对应 [MAX_G]。点越靠边说明瞬时加速度越大 —— 转弯时横向拖出去、
 * 急加速/刹车时纵向上下跑，一眼能看出驾驶风格。
 */
class GForceGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : BaseGaugeView(context, attrs, def) {

    companion object {
        /** 圆边界对应的 G 值。1.5G 已覆盖绝大多数民用车工况 */
        const val MAX_G = 1.5f
    }

    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private var valuePaint: Paint? = null
    private var labelPaint: Paint? = null
    private var axisPaint: Paint? = null

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val cx = w / 2f
        val cy = h / 2f
        val radius = minOf(w, h) * 0.36f

        // 外圈
        ringPaint.color = cTrack
        ringPaint.strokeWidth = dp(2f)
        canvas.drawCircle(cx, cy, radius, ringPaint)

        // 0.5G 参考圈 + 十字准线
        ringPaint.color = cTick
        ringPaint.strokeWidth = dp(1f)
        canvas.drawCircle(cx, cy, radius * (0.5f / MAX_G), ringPaint)
        neonLine(canvas, cx - radius, cy, cx + radius, cy, ringPaint.color, ringPaint.strokeWidth, palette.glow, radius)
        neonLine(canvas, cx, cy - radius, cx, cy + radius, ringPaint.color, ringPaint.strokeWidth, palette.glow, radius)

        // 点：横向 → x 轴，纵向 → y 轴（向上为正，即加速向上）
        val gx = (extraValue(0) ?: 0f).coerceIn(-MAX_G, MAX_G)
        val gy = (extraValue(1) ?: 0f).coerceIn(-MAX_G, MAX_G)
        val px = cx + gx / MAX_G * radius
        val py = cy - gy / MAX_G * radius

        if (palette.glow) {
            // 辉光跟随报警色，而不是固定的主题强调色 —— 否则报警时
            // 会看到"红点 + 青色光圈"，像是画错了
            dotPaint.color = glowColor(alertColor(), 70)
            // 光晕球（P7-8）。半径给得比实心球大一点，让辉光有地方扩散
        }
        dotPaint.color = alertColor()
        canvas.drawCircle(px, py, dp(6f), dotPaint)

        // 文字
        val base = minOf(w, h)
        val vp = valuePaint ?: newTextPaint(1f, cValue, true).also { valuePaint = it }
        val lp = labelPaint ?: newTextPaint(1f, cLabel).also { labelPaint = it }
        val ap = axisPaint ?: newTextPaint(1f, cDim).also { axisPaint = it }
        vp.textSize = base * 0.11f
        lp.textSize = base * 0.055f
        ap.textSize = base * 0.05f

        vp.color = valueTextColor()
        val valueBaseline = cy + vp.textSize * 0.35f
        canvas.drawText("${format(value)} ${unit()}".trim(), cx, valueBaseline, vp)

        lp.color = cLabel
        canvas.drawText("综合", cx, valueBaseline + lp.textSize * 1.3f, lp)

        ap.color = cDim
        ap.textAlign = Paint.Align.LEFT
        canvas.drawText("横 ${extraFormat(0)}", dp(6f), h - dp(6f), ap)
        ap.textAlign = Paint.Align.RIGHT
        canvas.drawText("纵 ${extraFormat(1)}", w - dp(6f), h - dp(6f), ap)
        ap.textAlign = Paint.Align.CENTER
    }
}
