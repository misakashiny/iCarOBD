package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.util.AttributeSet
import android.view.View
import com.icar.obd.obd.SignalSimulator

/**
 * 波形缩略图 —— 一眼看出这个通道是正弦 / 方波 / 锯齿…
 *
 * ## 为什么需要它
 *
 * 原来选波形是一个 `Spinner` 下拉，7 个选项藏在里面，**选完还是不知道"这波形长什么样"**。
 * 得切到仪表盘、等一个周期、看指针怎么动 —— 反馈链条太长，这是这个页面最不友好的地方。
 *
 * ## 关键设计：**复用生成器的同一个函数**
 *
 * 采样用的是 [SignalSimulator.waveAt] —— 也就是真正灌进总线的那个函数。
 * 所以缩略图**不可能和实际输出脱节**：改了波形算法，预览自动跟着变。
 * 如果这里自己写一套画法，迟早会出现"预览是正弦、实际是方波"这种鬼故事。
 */
class WaveThumbView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : View(context, attrs, def) {

    private var wave: Int = SignalSimulator.WAVE_SINE
    private var lineColor: Int = 0xFF28D7FF.toInt()
    private var dimColor: Int = 0x33FFFFFF

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 2.5f
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val path = Path()

    /** 采样点。**预分配**，`onDraw` 里不 new */
    private val ys = FloatArray(POINTS)

    fun setWave(w: Int) {
        if (w == wave) return
        wave = w
        invalidate()
    }

    fun setColors(line: Int, dim: Int) {
        lineColor = line
        dimColor = dim
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val padY = paint.strokeWidth
        val usable = h - padY * 2f

        // 采样一个完整周期
        for (i in 0 until POINTS) {
            val phase = i.toFloat() / (POINTS - 1)
            val v = SignalSimulator.waveAt(wave, phase).coerceIn(0f, 1f)
            // 波形值 0..1 → 屏幕 y（0 在底部）
            ys[i] = padY + usable * (1f - v)
        }

        // 中线：给"恒定"这种平波一个参照，否则看不出它是一条直线
        paint.color = dimColor
        paint.strokeWidth = 1f
        canvas.drawLine(0f, h / 2f, w, h / 2f, paint)

        // 波形
        paint.color = lineColor
        paint.strokeWidth = 2.5f
        path.rewind()
        path.moveTo(0f, ys[0])
        for (i in 1 until POINTS) {
            path.lineTo(w * i / (POINTS - 1), ys[i])
        }
        canvas.drawPath(path, paint)
    }

    private companion object {
        /** 采样点数。60 足够平滑，再多也看不出来 */
        const val POINTS = 60
    }
}
