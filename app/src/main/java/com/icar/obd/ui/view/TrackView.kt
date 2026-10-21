package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import com.icar.obd.data.TrackStyle

/**
 * 条形轨道绘制（P4F-M01 / TRACK-APP-001）。
 *
 * ## 为什么需要这个 View
 *
 * ICarUI 编辑器里 `type == "image"` 且带 `trackStyle` 的节点是**代码绘制的
 * 条形轨道**（28 个 track 控件）。此前 Android 端完全忽略这个字段，
 * 一律 `buildImage()` 贴底图 —— 用户在 Windows 上调好的圆角/渐变/刻度/色带
 * 在平板上完全看不到。
 *
 * ## 与工具侧的语义对齐
 *
 * 逐条对齐 `tools/icarui/js/canvas.js` 的 `drawTrackNode()`：
 *
 * | 步骤 | 顺序 | 说明 |
 * |---|---|---|
 * | 1 | 发光 | 在轨道下方画更大的圆角块（alpha 0.45）|
 * | 2 | 底色 | 三段色带 > 内凹 > gloss 渐变 > 纯色 |
 * | 3 | fade 叠加 | 沿长边淡出（叠加，不替换底色）|
 * | 4 | 分段 | 等分格，间隙 = 短边 × 0.14 |
 * | 5 | 刻度 | 长边短横线，长度 = 短边 × 0.34 |
 * | 6 | 填充 | 从起点画到 fill 比例 + 顶面高光 |
 * | 7 | 描边 | 1px 白色 10% |
 *
 * ## 兼容性
 *
 * · **纯新增 View**，不改任何既有绘制类
 * · `trackStyle == null` 时不会被创建（调用方回落 `buildImage()`）
 * · 颜色为 null 时回落主题色，与工具侧一致
 * · 无每帧动画，只在 `setTrack()` / 尺寸变化时重绘 → 性能影响可忽略
 */
class TrackView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : View(context, attrs, def) {

    private var track: TrackStyle? = null

    /** 主题回落的两个色（由渲染器注入，避免依赖 GaugeView 体系） */
    private var themeTrackColor: Int = Color.parseColor("#2A3441")
    private var themeAccentColor: Int = Color.parseColor("#4EA8FF")

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f
        color = Color.argb(26, 255, 255, 255)   // rgba(255,255,255,0.10)
    }
    private val rect = RectF()
    private val clipPath = Path()

    fun setTrack(t: TrackStyle?) {
        track = t
        invalidate()
    }

    fun setThemeColors(trackColor: Int, accentColor: Int) {
        themeTrackColor = trackColor
        themeAccentColor = accentColor
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val t = track ?: return
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val vertical = t.isVertical
        val short = minOf(w, h)
        val radius = t.radius ?: (short / 2f)

        // 颜色：null -> 主题
        val trackColor = parseColor(t.color) ?: themeTrackColor
        val accent = parseColor(t.accent) ?: themeAccentColor

        // ---- 1. 发光（先画，在轨道下面）
        if (t.glow) {
            fillPaint.shader = null
            fillPaint.style = Paint.Style.FILL
            fillPaint.alpha = (255 * 0.45f).toInt()
            fillPaint.color = accent
            rect.set(-3f, -3f, w + 3f, h + 3f)
            canvas.drawRoundRect(rect, radius + 3f, radius + 3f, fillPaint)
            fillPaint.alpha = 255
        }

        // ---- 2. 底色
        fillPaint.style = Paint.Style.FILL
        fillPaint.alpha = 255
        when {
            t.band -> {
                // 三段语义色：绿(安全)/黄(注意)/红(危险) —— 与工具侧完全一致
                val stops = floatArrayOf(0f, 0.35f, 0.7f, 1f)
                val colors = intArrayOf(
                    Color.parseColor("#39D98A"),
                    Color.parseColor("#FFB020"),
                    Color.parseColor("#FF4D4F"),
                    Color.parseColor("#FF4D4F")
                )
                val g = if (vertical) {
                    LinearGradient(0f, 0f, 0f, h, colors, stops, Shader.TileMode.CLAMP)
                } else {
                    LinearGradient(0f, 0f, w, 0f, colors, stops, Shader.TileMode.CLAMP)
                }
                fillPaint.shader = g
            }
            t.inset -> {
                fillPaint.shader = crossGradient(0f, 0f, w, h, vertical,
                    Color.argb(140, 0, 0, 0),        // rgba(0,0,0,0.55)
                    Color.argb(26, 255, 255, 255))   // rgba(255,255,255,0.10)
            }
            t.gradient == "gloss" -> {
                fillPaint.shader = null
                fillPaint.color = trackColor
                rect.set(0f, 0f, w, h)
                canvas.drawRoundRect(rect, radius, radius, fillPaint)
                fillPaint.shader = crossGradient(0f, 0f, w, h, vertical,
                    Color.argb(41, 255, 255, 255),   // rgba(255,255,255,0.16)
                    Color.argb(77, 0, 0, 0))         // rgba(0,0,0,0.30)
            }
            else -> {
                fillPaint.shader = null
                fillPaint.color = trackColor
            }
        }
        rect.set(0f, 0f, w, h)
        canvas.drawRoundRect(rect, radius, radius, fillPaint)

        // ---- 3. fade 叠加（沿长边淡出，**叠加**在底色上）
        if (t.gradient == "fade") {
            val mid = Color.argb(26, 255, 255, 255)
            val clear = Color.argb(0, 255, 255, 255)
            fillPaint.shader = if (vertical) {
                LinearGradient(0f, 0f, 0f, h, clear, mid, Shader.TileMode.CLAMP)
            } else {
                LinearGradient(0f, 0f, w, 0f, clear, mid, Shader.TileMode.CLAMP)
            }
            // 两端透明、中间亮 —— 用三停渐变才与 canvas 的 0/0.5/1 一致
            fillPaint.shader = if (vertical) {
                LinearGradient(0f, 0f, 0f, h,
                    intArrayOf(clear, mid, clear), floatArrayOf(0f, 0.5f, 1f),
                    Shader.TileMode.CLAMP)
            } else {
                LinearGradient(0f, 0f, w, 0f,
                    intArrayOf(clear, mid, clear), floatArrayOf(0f, 0.5f, 1f),
                    Shader.TileMode.CLAMP)
            }
            rect.set(0f, 0f, w, h)
            canvas.drawRoundRect(rect, radius, radius, fillPaint)
        }

        // ---- 4. 分段
        fillPaint.shader = null
        if (t.segments > 1) {
            val gap = maxOf(1f, short * 0.14f)
            val total = if (vertical) h else w
            val step = total / t.segments
            fillPaint.color = Color.argb(115, 0, 0, 0)   // rgba(0,0,0,0.45)
            for (i in 1 until t.segments) {
                val p = i * step - gap / 2f
                if (vertical) canvas.drawRect(0f, p, w, p + gap, fillPaint)
                else canvas.drawRect(p, 0f, p + gap, h, fillPaint)
            }
        }

        // ---- 5. 刻度
        if (t.ticks > 0) {
            fillPaint.color = Color.argb(140, 255, 255, 255)   // rgba(255,255,255,0.55)
            val total = if (vertical) h else w
            val step = total / t.ticks
            val len = short * 0.34f
            val thick = maxOf(1f, short * 0.05f)
            for (i in 0 until t.ticks) {
                val p = (i + 0.5f) * step
                if (vertical) canvas.drawRect(0f, p, len, p + thick, fillPaint)
                else canvas.drawRect(p, 0f, p + thick, len, fillPaint)
            }
        }

        // ---- 6. 填充
        val f = t.fill
        if (f != null) {
            val ff = f.coerceIn(0f, 1f)
            val fw = if (vertical) w else w * ff
            val fh = if (vertical) h * ff else h
            if (fw > 0.5f && fh > 0.5f) {
                clipPath.reset()
                rect.set(0f, 0f, w, h)
                clipPath.addRoundRect(rect, radius, radius, Path.Direction.CW)
                canvas.save()
                canvas.clipPath(clipPath)

                fillPaint.shader = null
                fillPaint.color = accent
                rect.set(0f, 0f, fw, fh)
                canvas.drawRoundRect(rect, radius, radius, fillPaint)

                // 顶面高光（沿短边、只占 32%）
                fillPaint.color = Color.argb(56, 255, 255, 255)   // rgba(255,255,255,0.22)
                if (vertical) canvas.drawRect(0f, 0f, fw * 0.32f, fh, fillPaint)
                else canvas.drawRect(0f, 0f, fw, fh * 0.32f, fillPaint)

                canvas.restore()
            }
        }

        // ---- 7. 描边
        rect.set(0.5f, 0.5f, w - 0.5f, h - 0.5f)
        canvas.drawRoundRect(rect, maxOf(0f, radius - 0.5f), maxOf(0f, radius - 0.5f), strokePaint)
    }

    /**
     * 沿短边的渐变（对水平轨道是上下、对垂直轨道是左右）——
     * 与工具侧 `crossGrad()` 同义。
     */
    private fun crossGradient(
        x: Float, y: Float, w: Float, h: Float, vertical: Boolean, c0: Int, c1: Int
    ): Shader = if (vertical) {
        LinearGradient(x, y, x + w, y, c0, c1, Shader.TileMode.CLAMP)
    } else {
        LinearGradient(x, y, x, y + h, c0, c1, Shader.TileMode.CLAMP)
    }

    private fun parseColor(hex: String?): Int? {
        if (hex == null || hex.length != 7 || hex[0] != '#') return null
        return try {
            Color.parseColor(hex)
        } catch (e: IllegalArgumentException) {
            null
        }
    }
}
