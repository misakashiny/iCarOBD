package com.icar.obd.ui.view

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import com.icar.obd.data.IslandStyle

/**
 * **灵动岛胶囊本体**（v1.20.13 抽出）。
 *
 * ## 为什么要单独一个类
 *
 * v1.20.12 时它只是 `IslandNotice.build()` 里的十行匿名代码。这一版加了五组样式，
 * 于是"设内边距 / 设字号 / 设颜色 / 设圆角"这套动作**出现了第二个使用者**：
 * 设置页对话框里的**实时预览**。两处各写一遍的后果不是"多几十行"，而是
 * "预览里看到的样子和真弹出来的不一样" —— 而用户正是照着预览做决定的。
 *
 * 所以：**样式 → View 的映射只有这一处**（红线 4.5：样式→View 映射只能一处）。
 *
 * ## 三条硬约束在这里怎么落地
 *
 * | 约束 | 代码 |
 * |---|---|
 * | ① 不盖住画布 | 这里**不设任何尺寸**（`IslandNotice` 用 `WRAP_CONTENT` 挂它）；它只画自己那一小块 |
 * | ② 不抢触摸 | 构造里 `isClickable = false` / `isFocusable = false`，**子 TextView 也一样**（连展开时也不可点） |
 * | ③ 与监听警示条错开 | 不在这里 —— 纵向偏移由 `IslandNotice.setTopOffsetPx` 负责（本类不知道警示条存在） |
 */
class IslandCapsuleView(ctx: Context) : LinearLayout(ctx) {

    private val tvText: TextView
    private val tvCount: TextView

    /**
     * 背景 drawable **只建一次**，之后原地改它的 `cornerRadius` / 颜色。
     *
     * 为什么不每次 `background = GradientDrawable()`：那会 `invalidate` 整棵子树，
     * 而 `show()` 是在规则高频触发时被调的（转向灯那条规则每 450ms 一次）。
     * 复用同一个 drawable 时，只有**样式真的变了**才会走到这里（见 `IslandNotice.applied`）。
     */
    private val bgDrawable = GradientDrawable()

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        background = bgDrawable
        elevation = dp(8).toFloat()
        // ⚠️ 约束 ②：整条胶囊（含子 View）都不可点 —— 它悬在画布正上方，
        // 能点就会吃掉 ViewPager2 横滑 / 双击呼出导航的一部分手势
        isClickable = false
        isFocusable = false
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES

        tvText = TextView(ctx).apply {
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            isClickable = false
            isFocusable = false
        }
        tvCount = TextView(ctx).apply {
            isClickable = false
            isFocusable = false
            visibility = View.GONE
        }
        addView(tvText)
        addView(tvCount)
    }

    /**
     * 把一条**已解析**的样式应用到这条胶囊上。
     *
     * 幂等：同样的 [IslandStyle.Spec] 调两次结果一样。调用方负责"变了才调"。
     */
    fun applySpec(s: IslandStyle.Spec) {
        setPadding(dp(s.padHdp), dp(s.padVdp), dp(s.padHdp), dp(s.padVdp))
        tvText.textSize = s.textSp
        tvText.setTextColor(s.fg)
        // `+N` 比正文小 2sp，但不小于 10sp（再小在车机上读不出来）
        tvCount.textSize = (s.textSp - 2f).coerceAtLeast(10f)
        tvCount.setTextColor(s.accent)
        tvCount.setPadding(dp(8), 0, 0, 0)
        bgDrawable.shape = GradientDrawable.RECTANGLE
        bgDrawable.cornerRadius = dp(s.cornerDp).toFloat()
        bgDrawable.setColor(s.bg)
        bgDrawable.setStroke(dp(1), IslandStyle.STROKE)
        invalidate()
    }

    /**
     * 换文案与 `+N`。
     *
     * @param pending 展示期间又来了几条**不同**的消息（0 = 不显示 `+N`）
     */
    fun setContent(text: String, pending: Int) {
        tvText.text = text
        tvCount.text = if (pending > 0) "+$pending" else ""
        tvCount.visibility = if (pending > 0) View.VISIBLE else View.GONE
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun dp(v: Float): Int = (v * resources.displayMetrics.density).toInt()
}
