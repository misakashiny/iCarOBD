package com.icar.obd.ui.view

import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.drawable.Drawable

/**
 * 平铺背景（[com.icar.obd.data.DesignFile.FIT_TILE]）。
 *
 * ## 为什么不用 `BitmapDrawable` + `REPEAT`
 *
 * 直觉做法是 `BitmapDrawable.setTileModeXY(REPEAT, REPEAT)`。两个问题：
 *
 *  1. **它铺的是原图尺寸**。本项目加载背景时已经**下采样到 2048**
 *     （见 [DashboardBackground]），一张 2048 的图铺在 2560 宽的屏上
 *     只能看到 1~2 块 —— "平铺"完全看不出效果。
 *  2. `REPEAT` 与 `gravity` 组合在不同 API 上行为不一致。
 *
 * ## 所以这里显式做两件事
 *
 *  1. **先缩到不超出容器**（只缩不放，避免小图被拉糊）——
 *     与 PC 工具里 `drawBackground` 的平铺预览**同一套规则**
 *  2. 再用 [BitmapShader] 的 `REPEAT` 铺满
 *
 * 这套规则必须和工具侧一致，否则"电脑上看到的"与"设备上看到的"不一样。
 */
class TiledBackgroundDrawable(private val src: Bitmap) : Drawable() {

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val shader = BitmapShader(src, Shader.TileMode.REPEAT, Shader.TileMode.REPEAT)
    private val matrix = Matrix()
    private var lastW = 0
    private var lastH = 0

    init {
        paint.shader = shader
    }

    override fun onBoundsChange(bounds: Rect) {
        val w = bounds.width()
        val h = bounds.height()
        if (w <= 0 || h <= 0 || src.width <= 0 || src.height <= 0) return
        // 尺寸没变就不重算（onBoundsChange 在布局阶段会调很多次）
        if (w == lastW && h == lastH) return
        lastW = w
        lastH = h
        // 只缩不放：图比容器小就保持原始尺寸，那样平铺才看得见"块"
        val k = minOf(w.toFloat() / src.width, h.toFloat() / src.height, 1f)
        matrix.reset()
        matrix.setScale(k, k)
        shader.setLocalMatrix(matrix)
    }

    override fun draw(canvas: Canvas) {
        val b = bounds
        if (b.isEmpty) return
        canvas.drawRect(b, paint)
    }

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Drawable 的旧契约，必须实现但已不用", ReplaceWith("PixelFormat.TRANSLUCENT"))
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
