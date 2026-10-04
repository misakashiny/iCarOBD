package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.View

/**
 * 参考线覆盖层：在仪表画布上画**均匀的线段网格**，用于对齐与排版参考。
 *
 * 它总是作为画布的**第一个子 View**（在 z 序最底），所以不会盖住任何仪表。
 * 关闭时 [onDraw] 直接返回，不产生任何绘制开销。
 *
 * 三个可调参数都来自 [com.icar.obd.data.Store.Settings]：
 *  - [cols] / [rows]：密度（分几列几行）
 *  - [style]：线段样式（实线 / 虚线 / 点线）
 *  - [color]：颜色（由当前主题派生，保证换主题不串色）
 */
class DashGridOverlayView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : View(context, attrs, def) {

    companion object {
        const val STYLE_SOLID = 0
        const val STYLE_DASH = 1
        const val STYLE_DOT = 2

        /** 密度上限。再多就成实心色块了，没有参考价值 */
        const val MAX_DIVISIONS = 24
    }

    /** 注意：不能叫 `enabled` —— 会和 [View.setEnabled] 撞 JVM 签名（Accidental override） */
    var linesEnabled: Boolean = false
        set(v) { if (field != v) { field = v; invalidate() } }

    var cols: Int = 6
        set(v) { val c = v.coerceIn(1, MAX_DIVISIONS); if (field != c) { field = c; invalidate() } }

    var rows: Int = 4
        set(v) { val c = v.coerceIn(1, MAX_DIVISIONS); if (field != c) { field = c; invalidate() } }

    var style: Int = STYLE_DASH
        set(v) { if (field != v) { field = v; invalidate() } }

    var color: Int = 0x33FFFFFF
        set(v) { if (field != v) { field = v; invalidate() } }

    var strokeDp: Float = 1f
        set(v) { if (field != v) { field = v; invalidate() } }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val path = Path()

    override fun onDraw(canvas: Canvas) {
        if (!linesEnabled) return
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val density = resources.displayMetrics.density
        paint.color = color
        paint.strokeWidth = strokeDp * density
        paint.pathEffect = when (style) {
            STYLE_DASH -> DashPathEffect(floatArrayOf(6f * density, 6f * density), 0f)
            STYLE_DOT -> DashPathEffect(floatArrayOf(1.5f * density, 5f * density), 0f)
            else -> null
        }
        paint.strokeCap = if (style == STYLE_DOT) Paint.Cap.ROUND else Paint.Cap.BUTT

        path.reset()
        // 竖线（含左右边界）：cols 段 → cols+1 条线
        for (i in 0..cols) {
            val x = w * i / cols
            path.moveTo(x, 0f)
            path.lineTo(x, h)
        }
        // 横线（含上下边界）
        for (j in 0..rows) {
            val y = h * j / rows
            path.moveTo(0f, y)
            path.lineTo(w, y)
        }
        canvas.drawPath(path, paint)
    }
}
