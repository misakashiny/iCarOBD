package com.icar.obd.ui.view

import android.content.Context
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import com.icar.obd.obd.FrameMonitor

/**
 * **常驻监听警示条**（v1.20.6，P10-3）—— 屏幕上唯一一条"轮询已暂停"的提示。
 *
 * ## 为什么必须有它
 *
 * ELM327 是**半双工**的：`ATMA` 监听期间不能同时收发请求，所以开常驻监听
 * 是一个**模式切换** —— 转速/水温会**冻结在最后一个值**（见 [FrameMonitor] 的类注释）。
 *
 * 而界面上原来**完全看不出来**：仪表还在那儿、数值还在，只是不动了。
 * 用户（和上车的我们自己）会把"转速卡在 745"当成数据链路坏了去查半天。
 *
 * ## 为什么挂在 Activity 的 content 上，而不是改 activity_main.xml
 *
 * 与 `MainActivity.updateSimBar()` 同一条理由：它要**跨页面存活**
 * （用户可能先回仪表盘、再去 PID 页），而且它必须**不改变任何布局** ——
 * 在 `activity_main.xml` 里加一行会让 `pageContainer` 变矮，
 * 画布尺寸跟着变 → 表盘重排 + 闪一下（这正是 v1.20.4 把导航栏改成悬浮的原因）。
 *
 * 所以：**浮在上面、不占布局**。代价是盖住内容顶部约 24dp，
 * 但这只在监听期间出现，且"看见警示"比"看见那 24dp"重要得多。
 *
 * ## 单一权威
 *
 * 文案与判定都在这里一处 —— 判据是 `FrameMonitor.running`
 * （轮询是否暂停由它决定，UI 不再自己判断一遍）。
 */
class MonitorWarnBar(private val ctx: Context) {

    private var bar: TextView? = null
    private var host: ViewGroup? = null

    /**
     * 按当前状态挂上 / 摘掉警示条。**可以每秒调一次**（幂等，不会重复添加）。
     */
    fun sync(h: ViewGroup) {
        // 宿主变了（旋转重建 / 换 Activity）→ 旧的那条已经随着旧 content 一起没了，
        // 必须重新建。不比一下的话会"重建之后警示条再也不出现"。
        if (host !== h) {
            bar = null
            host = h
        }
        if (FrameMonitor.running) show(h) else hide(h)
    }

    private fun show(h: ViewGroup) {
        if (bar != null) return
        val v = TextView(ctx).apply {
            text = TEXT
            textSize = 12f
            setTextColor(0xFFFFFFFF.toInt())
            gravity = Gravity.CENTER
            val p = dp(8)
            setPadding(p, dp(4), p, dp(4))
            // 警示色（Material 的 error 深色档）。**用深色底 + 白字**而不是亮黄底：
            // 车机在阳光下看，亮底白字会糊成一团
            setBackgroundColor(0xF0B3261E.toInt())
            elevation = dp(6).toFloat()
            contentDescription = TEXT
        }
        h.addView(
            v,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP
            )
        )
        bar = v
    }

    private fun hide(h: ViewGroup) {
        bar?.let { runCatching { h.removeView(it) } }
        bar = null
    }

    private fun dp(v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    companion object {
        /**
         * 警示文案。**跨页面共用一句**（MainActivity 的浮条与 CAN 探测页的状态行都用它），
         * 两处各写一遍必然会分叉成"一处说了、一处没说"。
         */
        const val TEXT = "监听中 · 轮询已暂停（转速/水温冻结）"
    }
}
