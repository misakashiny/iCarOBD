package com.icar.obd.ui.view

import android.content.Context
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * **灵动岛式悬浮提示**（v1.20.12）—— 规则提示用。
 *
 * 用户原话：「增加个悬浮窗通知、类似于灵动岛那种效果、用于规则的一些提示或啥的」。
 *
 * ## 形态
 *
 * ```
 *         ╭──────────────────────────────╮
 *         │  ⚠ 水温 105℃ 过高        +2  │      ← 顶部居中，小胶囊
 *         ╰──────────────────────────────╯
 * ```
 *
 * - **平时完全隐藏**（不是"留一个缩小的小点"）；
 * - 规则触发时**展开**显示文案，停留 [IslandStateMachine.HOLD_MS] 后**淡出收起**；
 * - 展开期间又来了别的提示 → 换文案并显示 `+N`（语义见 [IslandStateMachine]）。
 *
 * ## ⚠️ 三条硬约束（都是踩过的坑）
 *
 * ### ① 绝对不能盖住画布 —— 用**浮层**，不改任何布局
 *
 * 挂在 `android.R.id.content` 上（与 [MonitorWarnBar] 同一个宿主），
 * `WRAP_CONTENT × WRAP_CONTENT` + `Gravity.TOP|CENTER_HORIZONTAL`：
 * **只占它自己那一小块**。在 `activity_main.xml` 里加一行会让 `pageContainer` 变矮
 * → 画布尺寸变化 → 表盘重排（v1.20.4 的教训），而那正是 v1.20.12 那个
 * 「规则 toast 一弹画布全没了」的**触发条件**（见 `DashRenderer.relayout` 的注释）。
 *
 * ### ② 不抢触摸
 *
 * 胶囊 `isClickable = false` / `isFocusable = false`，**连展开时也不可点**。
 * 理由：它悬在画布正上方，`ViewPager2` 的横滑、双击呼出导航、拖表盘都从这一带过。
 * 一个能点的浮层会把这些手势吃掉一部分 —— 而"手势偶尔不灵"是最难查的一类问题。
 * 它 4 秒后自己消失，不需要用户点。
 *
 * ### ③ 与 [MonitorWarnBar] 错开，不叠在一起
 *
 * 监听警示条也在顶部、且是 `MATCH_PARENT` 宽。两者同时出现会**叠成两行糊在一起**，
 * 所以这里接受一个 [setTopOffsetPx]：警示条在时往下让一行。
 * 谁在上谁在下是固定的（警示条在上）—— 它是**常驻状态**，灵动岛是**瞬时事件**。
 */
class IslandNotice(private val ctx: Context) {

    private val main = Handler(Looper.getMainLooper())
    private val machine = IslandStateMachine()

    private var capsule: LinearLayout? = null
    private var tvText: TextView? = null
    private var tvCount: TextView? = null
    private var host: ViewGroup? = null

    /** 顶部让位（像素）。监听警示条可见时由 [setTopOffsetPx] 设成它的高度 */
    private var topOffsetPx = 0

    private val ticker = object : Runnable {
        override fun run() {
            val snap = machine.onTick(SystemClock.uptimeMillis())
            if (!snap.visible) {
                hideCapsule()
                return
            }
            main.postDelayed(this, TICK_MS)
        }
    }

    /**
     * 宿主变了（旋转重建 / 换 Activity）→ 旧胶囊随着旧 content 一起没了，必须重建。
     * 与 [MonitorWarnBar.sync] 同一条理由。
     */
    fun attach(h: ViewGroup) {
        if (host !== h) {
            capsule = null
            tvText = null
            tvCount = null
            host = h
        }
    }

    /** 让位给顶部常驻的监听警示条（像素）。0 = 没有警示条，直接贴顶 */
    fun setTopOffsetPx(px: Int) {
        if (px == topOffsetPx) return
        topOffsetPx = px
        capsule?.let { c ->
            (c.layoutParams as? FrameLayout.LayoutParams)?.let { lp ->
                lp.topMargin = px + dp(TOP_MARGIN_DP)
                c.layoutParams = lp
            }
        }
    }

    /**
     * 显示一条提示。**可以随时调**（规则动作里就是直接调它）。
     *
     * @param text 文案。空白忽略（不弹一个空胶囊）
     */
    fun show(text: String) {
        if (text.isBlank()) return
        val h = host ?: return
        val before = machine.current
        val snap = machine.onMessage(text, SystemClock.uptimeMillis())
        if (!snap.visible) return

        val c = capsule ?: build().also { capsule = it; h.addView(it, layoutParams()) }
        tvText?.text = text
        // 只有"文案变了"才重播入场动画：同一条规则每几百毫秒触发一次时，
        // 重播动画会变成一直闪（见 IslandStateMachine 的表格）
        val textChanged = before.text != snap.text
        if (c.visibility != View.VISIBLE || textChanged) {
            c.animate().cancel()
            c.visibility = View.VISIBLE
            c.alpha = 0f
            c.scaleX = 0.82f
            c.scaleY = 0.82f
            c.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(ENTER_MS).start()
        }
        tvCount?.text = if (snap.pending > 0) "+${snap.pending}" else ""
        tvCount?.visibility = if (snap.pending > 0) View.VISIBLE else View.GONE

        main.removeCallbacks(ticker)
        main.postDelayed(ticker, TICK_MS)
    }

    /** 立刻收起并停掉节拍（Activity 销毁 / 切页时调） */
    fun dismissNow() {
        main.removeCallbacks(ticker)
        machine.reset()
        hideCapsule()
    }

    private fun hideCapsule() {
        val c = capsule ?: return
        if (c.visibility != View.VISIBLE) return
        c.animate().cancel()
        c.animate().alpha(0f).scaleX(0.9f).scaleY(0.9f)
            .setDuration(EXIT_MS)
            .withEndAction { if (machine.current.visible.not()) c.visibility = View.GONE }
            .start()
    }

    private fun build(): LinearLayout {
        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14), dp(7), dp(14), dp(7))
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(18).toFloat()      // 全圆角 = 胶囊
                setColor(CAPSULE_BG)
                setStroke(dp(1), CAPSULE_STROKE)
            }
            elevation = dp(8).toFloat()
            // ⚠️ 约束 ②：不抢触摸。整条胶囊（含子 View）都不可点
            isClickable = false
            isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        val txt = TextView(ctx).apply {
            textSize = 13f
            setTextColor(0xFFFFFFFF.toInt())
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            isClickable = false
            isFocusable = false
        }
        val cnt = TextView(ctx).apply {
            textSize = 11f
            setTextColor(0xFFFFD400.toInt())
            setPadding(dp(8), 0, 0, 0)
            isClickable = false
            isFocusable = false
            visibility = View.GONE
        }
        row.addView(txt)
        row.addView(cnt)
        tvText = txt
        tvCount = cnt
        return row
    }

    private fun layoutParams() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        Gravity.TOP or Gravity.CENTER_HORIZONTAL
    ).apply { topMargin = topOffsetPx + dp(TOP_MARGIN_DP) }

    private fun dp(v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    companion object {
        /** 胶囊底色：接近黑的高不透明度，白字在阳光下也看得清（与警示条同一取向） */
        private const val CAPSULE_BG = 0xF01A1F27.toInt()
        private const val CAPSULE_STROKE = 0x33FFFFFF

        /** 贴顶留白（dp）。太小会贴到状态栏，太大又离画布中心太远 */
        private const val TOP_MARGIN_DP = 10

        private const val ENTER_MS = 180L
        private const val EXIT_MS = 220L

        /** 收起判定的节拍。50ms 足够准（4 秒 ± 50ms），又不至于每秒 20 次唤醒 */
        private const val TICK_MS = 50L
    }
}
