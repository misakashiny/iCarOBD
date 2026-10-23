package com.icar.obd.ui.primitive

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

/**
 * P5B-M03 §D1：**分段圆环**（SegmentedArc）Android 实现
 *
 * ## 身份
 *
 * **Android 内部绘制组件，未注册进正式主题格式**。
 * 指令 §D5 明确：「正式主题解析和导出未授权之前，不直接注册未定稿的持久化新节点」。
 * 所以本类：
 *   · 在 `ui.primitive` 隔离包里，不被 `GaugeViewFactory` 引用
 *   · 不参与 `DesignFile` 解析
 *   · **不改变 style 0~7 的任何语义**
 *
 * ## 几何约定（与编辑器原型 [advanced-primitives-proto.js] 一致）
 *
 *   startAngle   起始角（**度**，0 = 3 点钟方向，顺时针为正）
 *   sweepAngle   总扫过角度（度，**可为负 = 逆时针**）
 *   segmentCount 分段数
 *   gapAngle     段间空隙（度）
 *   thickness    线宽（px）
 *
 * 这套约定与 `Canvas.arc` 相同（Android 的 0° 也是 3 点钟、正角度顺时针），
 * 所以**不需要角度换算**，两边可以直接用同一份参数。
 *
 * ## 进度语义
 *
 *   progress ∈ [0,1] —— 按**段数**四舍五入点亮，不是连续裁切
 *   （分段圆环的视觉特征就是"一格一格跳"，连续裁切会变成普通圆弧）
 *
 * ## 分区颜色
 *
 * [zoneColors] 非空时，第 i 段用 `zoneColors[i * size / n]`
 * —— 与编辑器原型相同的"按段索引取色"规则，保证两端一致。
 */
class SegmentedArcView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    // ---------------------------------------------------------------- 参数

    /** 起始角（度，0 = 3 点钟，顺时针为正）*/
    var startAngle: Float = 150f
        set(v) { field = v; invalidate() }

    /** 总扫角（度，负 = 逆时针）*/
    var sweepAngle: Float = 240f
        set(v) { field = v; invalidate() }

    /** 分段数 */
    var segmentCount: Int = 24
        set(v) { field = v.coerceAtLeast(1); invalidate() }

    /** 段间空隙（度）*/
    var gapAngle: Float = 2f
        set(v) { field = v.coerceAtLeast(0f); invalidate() }

    /** 线宽（px）*/
    var thickness: Float = 12f
        set(v) { field = v.coerceAtLeast(0.5f); invalidate() }

    /** 进度 [0,1]；null = 无数据 */
    var progress: Float? = null
        set(v) { field = v?.coerceIn(0f, 1f); invalidate() }

    /** 已点亮颜色 */
    var activeColor: Int = Color.parseColor("#FF3D7F")
        set(v) { field = v; invalidate() }

    /** 未点亮颜色 */
    var inactiveColor: Int = Color.parseColor("#4A5058")
        set(v) { field = v; invalidate() }

    /** 无数据时整体颜色 */
    var noDataColor: Int = Color.parseColor("#FF4D4F")
        set(v) { field = v; invalidate() }

    /** 分区颜色（按段索引取色）；空 = 不分色 */
    var zoneColors: IntArray = IntArray(0)
        set(v) { field = v; arcPaint.pathEffect = null; invalidate() }

    /** 圆环半径占 `min(w,h)` 的比例 */
    var radiusRatio: Float = 0.42f
        set(v) { field = v; invalidate() }

    // ---------------------------------------------------------------- 绘制

    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.BUTT
    }
    private val oval = RectF()
    private val segPath = Path()

    /** 上一帧算出的几何（供测试与调试读取，避免测试去猜）*/
    var lastGeometry: Geometry? = null
        private set

    data class Geometry(
        val centerX: Float,
        val centerY: Float,
        val radius: Float,
        val litSegments: Int,
        val totalSegments: Int,
        val segSweep: Float,
    )

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val cx = w / 2f
        val cy = h / 2f
        val radius = min(w, h) * radiusRatio.coerceIn(0.05f, 0.5f)
        val n = segmentCount.coerceAtLeast(1)

        // 每段占的角度（含空隙）
        val step = if (n > 0) sweepAngle / n else sweepAngle
        // 实际画的弧角 = 每段角 - 空隙（但不能 <= 0）
        val segSweep = if (step >= 0f) (step - gapAngle) else (step + gapAngle)
        // 空隙不能吃掉整段
        val drawnSweep = if (step >= 0f) segSweep.coerceAtLeast(0.01f) else segSweep.coerceAtMost(-0.01f)

        val p = progress
        val lit = if (p == null) 0 else Math.round(p * n).coerceIn(0, n)
        lastGeometry = Geometry(cx, cy, radius, lit, n, drawnSweep)

        arcPaint.strokeWidth = thickness
        oval.set(cx - radius, cy - radius, cx + radius, cy + radius)

        // 无数据：整圈都用 noDataColor 的暗色画，且**不点亮任何段**
        val isNoData = p == null

        for (i in 0 until n) {
            val segStart = startAngle + step * i
            val isLit = !isNoData && i < lit
            arcPaint.color = when {
                isNoData -> dim(noDataColor, 0.45f)
                isLit && zoneColors.isNotEmpty() -> zoneColors[(i * zoneColors.size) / n]
                isLit -> activeColor
                else -> inactiveColor
            }
            segPath.reset()
            segPath.addArc(oval, segStart, drawnSweep)
            canvas.drawPath(segPath, arcPaint)
        }
    }

    /** 按比例压暗一个颜色（用于无数据态）*/
    private fun dim(color: Int, k: Float): Int {
        val a = Color.alpha(color)
        val r = (Color.red(color) * k).toInt().coerceIn(0, 255)
        val g = (Color.green(color) * k).toInt().coerceIn(0, 255)
        val b = (Color.blue(color) * k).toInt().coerceIn(0, 255)
        return Color.argb(a, r, g, b)
    }

    // ---------------------------------------------------------------- 纯几何（可单测）

    companion object {
        /**
         * 计算第 [i] 段的起始角（度）。
         *
         * 抽成纯函数是为了 JVM 单测能直接验证，不必造 View。
         */
        fun segmentStartAngle(startAngle: Float, sweepAngle: Float, segmentCount: Int, i: Int): Float {
            val n = segmentCount.coerceAtLeast(1)
            return startAngle + (sweepAngle / n) * i
        }

        /**
         * 根据段数与空隙算每段实际绘制的角（度）。
         *
         * 保证不会因为空隙 >= 每段角而画不出来。
         */
        fun drawnSweep(sweepAngle: Float, segmentCount: Int, gapAngle: Float): Float {
            val n = segmentCount.coerceAtLeast(1)
            val step = sweepAngle / n
            val s = if (step >= 0f) step - gapAngle else step + gapAngle
            return if (step >= 0f) s.coerceAtLeast(0.01f) else s.coerceAtMost(-0.01f)
        }

        /**
         * 进度 → 点亮段数。
         *
         * **四舍五入**而不是向下取整：progress=0.5、n=24 时应亮 12 段（不是 12 也不是 11 的歧义）。
         * 与编辑器原型 `Math.round(progress * n)` 完全一致。
         */
        fun litSegments(progress: Float?, segmentCount: Int): Int {
            val n = segmentCount.coerceAtLeast(1)
            if (progress == null) return 0
            return Math.round(progress.coerceIn(0f, 1f) * n).coerceIn(0, n).toInt()
        }

        /** 在第 [i] 段上、极角 [angleDeg] 处的点坐标（测试与刻度用）*/
        fun pointOnCircle(cx: Float, cy: Float, radius: Float, angleDeg: Float): Pair<Float, Float> {
            val rad = Math.toRadians(angleDeg.toDouble())
            return Pair(
                cx + (radius * cos(rad)).toFloat(),
                cy + (radius * sin(rad)).toFloat(),
            )
        }
    }
}
