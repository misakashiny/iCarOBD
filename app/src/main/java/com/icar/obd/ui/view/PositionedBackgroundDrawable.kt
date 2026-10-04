package com.icar.obd.ui.view

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable

/**
 * 把背景图画在**指定矩形**里，而不是铺满整个 View。
 *
 * ## 为什么需要它
 *
 * 工具侧的设计文件里，背景可以带 `w` / `h`（**画布单位**）——
 * 表示"这张底图在设计里只占这么大一块"。之前 App 侧**完全忽略**这两个字段，
 * 一律铺满整屏，于是"电脑上缩在中间的一张图"推到设备上就变成了全屏拉伸。
 *
 * ## 为什么不用 BitmapDrawable + setBounds
 *
 * View 会在每次布局时调 `Drawable.setBounds(0, 0, viewW, viewH)` 把边界覆盖掉，
 * 所以"固定位置"这件事在 BitmapDrawable 上做不到 —— 必须自己忽略传进来的 bounds。
 *
 * @param left/top/width/height 目标矩形（**像素**，已由调用方换算好）
 */
class PositionedBackgroundDrawable(
    private val bmp: Bitmap,
    private val left: Int,
    private val top: Int,
    private val width: Int,
    private val height: Int
) : Drawable() {

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val dst = Rect(left, top, left + width.coerceAtLeast(1), top + height.coerceAtLeast(1))

    override fun draw(canvas: Canvas) {
        // ⚠️ 故意**不用** getBounds() —— 那会被 View 覆盖成整个 View 的大小
        canvas.drawBitmap(bmp, null, dst, paint)
    }

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha.coerceIn(0, 255)
        invalidateSelf()
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
