package com.icar.obd.ui.primitive

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.min

/**
 * P5B-M03 §D4：**基础图形**（Shape）Android 实现
 *
 * ## 身份
 *
 * Android 内部绘制组件，**未注册进正式主题格式**。
 *
 * ## 支持六种 kind（指令指定）
 *
 *   rect      矩形
 *   roundRect 圆角矩形
 *   circle    实心圆
 *   ring      圆环（空心圆）
 *   line      线段
 *   polyline  折线
 *
 * ## 基础属性
 *
 *   fillColor    填充色（透明 = 不填充）
 *   strokeColor  描边色（透明 = 不描边）
 *   strokeWidth  线宽
 *   cornerRadius 圆角半径（roundRect 用）
 *   rotation     旋转角（度，绕视图中心）
 *   alpha        整体透明度
 *
 * ## 「自由 Path 支持可以分开评估」（指令）
 *
 * 所以本类**不实现任意贝塞尔 Path** —— 那属于 [PathProgressView] 的职责。
 * 这里只做指令要求的基础图形，避免为了"全覆盖"而阻塞简单图形。
 */
class ShapePrimitiveView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    /** 图形种类 */
    var kind: String = KIND_RECT
        set(v) {
            field = if (v in KINDS) v else KIND_RECT   // 未知 kind → 回落矩形（不崩）
            invalidate()
        }

    var fillColor: Int = Color.parseColor("#3DD6FF")
        set(v) { field = v; invalidate() }

    var strokeColor: Int = Color.TRANSPARENT
        set(v) { field = v; invalidate() }

    var strokeWidth: Float = 0f
        set(v) { field = v.coerceAtLeast(0f); invalidate() }

    var cornerRadius: Float = 12f
        set(v) { field = v.coerceAtLeast(0f); invalidate() }

    var rotationDeg: Float = 0f
        set(v) { field = v; invalidate() }

    var viewAlpha: Int = 255
        set(v) { field = v.coerceIn(0, 255); invalidate() }

    /** 折线点（顺序为 x0,y0,x1,y1,...）—— 仅 [KIND_POLYLINE] 用 */
    var polyline: FloatArray = FloatArray(0)
        set(v) { field = v; invalidate() }

    /** 圆环内径比（0~1，仅 [KIND_RING] 用）*/
    var innerRatio: Float = 0.6f
        set(v) { field = v.coerceIn(0.05f, 0.95f); invalidate() }

    // ---------------------------------------------------------------- 绘制

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val path = Path()
    private val oval = RectF()

    /** 最近一次实际绘制的种类（未知 kind 会回落，测试要能看出来）*/
    var lastDrawnKind: String = KIND_RECT
        private set

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        fillPaint.color = fillColor
        fillPaint.alpha = viewAlpha
        strokePaint.color = strokeColor
        strokePaint.strokeWidth = strokeWidth
        strokePaint.alpha = viewAlpha

        canvas.save()
        if (rotationDeg != 0f) canvas.rotate(rotationDeg, w / 2f, h / 2f)

        val sw = strokeWidth / 2f
        val l = sw
        val t = sw
        val r = w - sw
        val b = h - sw

        when (kind) {
            KIND_RECT -> {
                lastDrawnKind = KIND_RECT
                canvas.drawRect(l, t, r, b, fillPaint)
                if (strokeWidth > 0f) canvas.drawRect(l, t, r, b, strokePaint)
            }
            KIND_ROUND_RECT -> {
                lastDrawnKind = KIND_ROUND_RECT
                // 圆角上限 = 短边一半（超出会被裁成胶囊，不能崩）
                val rad = cornerRadius.coerceIn(0f, min(w, h) / 2f)
                oval.set(l, t, r, b)
                canvas.drawRoundRect(oval, rad, rad, fillPaint)
                if (strokeWidth > 0f) canvas.drawRoundRect(oval, rad, rad, strokePaint)
            }
            KIND_CIRCLE -> {
                lastDrawnKind = KIND_CIRCLE
                val d = min(w, h) - strokeWidth
                oval.set(w / 2f - d / 2f, h / 2f - d / 2f, w / 2f + d / 2f, h / 2f + d / 2f)
                canvas.drawOval(oval, fillPaint)
                if (strokeWidth > 0f) canvas.drawOval(oval, strokePaint)
            }
            KIND_RING -> {
                lastDrawnKind = KIND_RING
                val outer = (min(w, h) - strokeWidth) / 2f
                val inner = (outer * innerRatio).coerceAtLeast(0f)
                val cx = w / 2f
                val cy = h / 2f
                path.reset()
                path.addCircle(cx, cy, outer, Path.Direction.CW)
                path.addCircle(cx, cy, inner, Path.Direction.CCW)
                path.fillType = Path.FillType.EVEN_ODD
                canvas.drawPath(path, fillPaint)
                if (strokeWidth > 0f) canvas.drawPath(path, strokePaint)
            }
            KIND_LINE -> {
                lastDrawnKind = KIND_LINE
                strokePaint.strokeCap = Paint.Cap.ROUND
                canvas.drawLine(l, b, r, t, strokePaint)
            }
            KIND_POLYLINE -> {
                lastDrawnKind = KIND_POLYLINE
                val n = polyline.size / 2
                if (n < 2) {
                    // 点数不够 → 不画（不崩）
                } else {
                    path.reset()
                    for (i in 0 until n) {
                        val x = (polyline[i * 2].coerceIn(0f, 1f)) * w
                        val y = (polyline[i * 2 + 1].coerceIn(0f, 1f)) * h
                        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                    }
                    strokePaint.strokeCap = Paint.Cap.ROUND
                    strokePaint.strokeJoin = Paint.Join.ROUND
                    canvas.drawPath(path, strokePaint)
                }
            }
            else -> {
                // 理论上进不来（setter 已回落），兜底也画矩形
                lastDrawnKind = KIND_RECT
                canvas.drawRect(l, t, r, b, fillPaint)
            }
        }

        canvas.restore()
    }

    companion object {
        const val KIND_RECT = "rect"
        const val KIND_ROUND_RECT = "roundRect"
        const val KIND_CIRCLE = "circle"
        const val KIND_RING = "ring"
        const val KIND_LINE = "line"
        const val KIND_POLYLINE = "polyline"

        val KINDS = listOf(KIND_RECT, KIND_ROUND_RECT, KIND_CIRCLE, KIND_RING, KIND_LINE, KIND_POLYLINE)

        /** 未知 kind 归一化（纯函数，可单测）*/
        fun normalizeKind(k: String): String = if (k in KINDS) k else KIND_RECT

        /** 圆角夹取（纯函数，可单测）*/
        fun clampCorner(radius: Float, w: Float, h: Float): Float =
            radius.coerceIn(0f, min(w, h) / 2f)
    }
}
