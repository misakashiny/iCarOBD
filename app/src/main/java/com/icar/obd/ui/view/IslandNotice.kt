package com.icar.obd.ui.view

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.icar.obd.data.IslandStyle
import com.icar.obd.data.Store

/**
 * **灵动岛式悬浮提示**（v1.20.12；v1.20.13 起样式可自定义）—— 规则提示用。
 *
 * 用户原话：「增加个悬浮窗通知、类似于灵动岛那种效果、用于规则的一些提示或啥的」，
 * 以及 v1.20.13 的「灵动岛的通知我希望可以自定义样式」。
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
 * - 规则触发时**展开**显示文案，停留 [IslandStyle.Spec.holdMs] 后**淡出收起**；
 * - 展开期间又来了别的提示 → 换文案并显示 `+N`（语义见 [IslandStateMachine]）。
 *
 * ## ⚠️ 三条硬约束（都是踩过的坑）—— v1.20.13 加样式**没有放松任何一条**
 *
 * ### ① 绝对不能盖住画布 —— 用**浮层**，不改任何布局
 *
 * 挂在 `android.R.id.content` 上（与 [MonitorWarnBar] 同一个宿主），
 * `WRAP_CONTENT × WRAP_CONTENT`：
 * **只占它自己那一小块**。在 `activity_main.xml` 里加一行会让 `pageContainer` 变矮
 * → 画布尺寸变化 → 表盘重排（v1.20.4 的教训），而那正是 v1.20.12 那个
 * 「规则 toast 一弹画布全没了」的**触发条件**（见 `DashRenderer.relayout` 的注释）。
 *
 * ### ② 不抢触摸
 *
 * 胶囊 `isClickable = false` / `isFocusable = false`（见 [IslandCapsuleView]），
 * **连展开时也不可点**。理由：它悬在画布正上方，`ViewPager2` 的横滑、
 * 双击呼出导航、拖表盘都从这一带过。一个能点的浮层会把这些手势吃掉一部分
 * —— 而"手势偶尔不灵"是最难查的一类问题。
 * 它几秒后自己消失，不需要用户点。
 *
 * ### ③ 与 [MonitorWarnBar] 错开，不叠在一起
 *
 * 监听警示条也在顶部、且是 `MATCH_PARENT` 宽。两者同时出现会**叠成两行糊在一起**，
 * 所以这里接受一个 [setTopOffsetPx]：警示条在时往下让一行。
 * 谁在上谁在下是固定的（警示条在上）—— 它是**常驻状态**，灵动岛是**瞬时事件**。
 *
 * ⚠️ **位置改成靠左 / 靠右时这条依然成立**：位置只改**水平**对齐
 * （`Gravity.START` / `CENTER_HORIZONTAL` / `END`），纵向**永远**是
 * `topOffsetPx + TOP_MARGIN_DP` —— 也就是永远在警示条下面那一行。
 *
 * ## 样式从哪来
 *
 * 每次 [show] 都从 `Store.settings.islandStyle()` 现读一次（[IslandStyle.Spec]）。
 * 这样用户在设置页改完，**下一条提示立刻是新样式**，不需要重启也不需要额外接线。
 * 只有"和上次不一样"时才真的去改 View 属性（[applied]）——
 * 转向灯那种每 450ms 触发一次的规则不会每次都动一遍布局。
 */
class IslandNotice(private val ctx: Context) {

    private val main = Handler(Looper.getMainLooper())
    private val machine = IslandStateMachine()

    private var capsule: IslandCapsuleView? = null
    private var host: ViewGroup? = null

    /** 顶部让位（像素）。监听警示条可见时由 [setTopOffsetPx] 设成它的高度 */
    private var topOffsetPx = 0

    /** 当前水平对齐档位（[IslandStyle.POS_*]）；[layoutParams] 用它算 gravity 与边距 */
    private var pos = IslandStyle.POS_DEFAULT

    /** 上一次**真的应用**到胶囊上的样式；与当前设置相同就跳过整套属性设置 */
    private var applied: IslandStyle.Spec? = null

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
            host = h
            // 新胶囊是新的 View，样式必须重新应用一遍
            applied = null
        }
    }

    /**
     * 让位给顶部常驻的监听警示条（像素）。0 = 没有警示条，直接贴顶。
     *
     * ⚠️ 只动**纵向**偏移，不动水平对齐 —— 位置档位由 [pos] 单独负责。
     */
    fun setTopOffsetPx(px: Int) {
        if (px == topOffsetPx) return
        topOffsetPx = px
        capsule?.let { it.layoutParams = layoutParams() }
    }

    /**
     * 显示一条提示。**可以随时调**（规则动作里就是直接调它）。
     *
     * @param text 文案。空白忽略（不弹一个空胶囊）
     */
    fun show(text: String) {
        if (text.isBlank()) return
        val h = host ?: return

        // 样式现读：设置页改完下一条就生效，不需要任何"通知显示层"的接线
        val spec = Store.settings.islandStyle()
        // 停留时长进了设置（v1.20.13）—— 状态机是可变的，不重建
        //（重建会把"正在显示的那条"一起丢掉，表现是"改完时长后提示闪一下"）
        machine.holdMs = spec.holdMs

        val before = machine.current
        val snap = machine.onMessage(text, SystemClock.uptimeMillis())
        if (!snap.visible) return

        val c = capsule ?: IslandCapsuleView(ctx).also {
            capsule = it
            pos = spec.pos
            h.addView(it, layoutParams())
        }
        val prev = applied
        if (prev != spec) {
            pos = spec.pos
            c.applySpec(spec)
            // 只有**水平档位**变了才动 layoutParams：它等于一次 requestLayout，
            // 而"每条提示都重排一次"正是 v1.20.12 那个 P0 的同类动作
            if (prev == null || prev.pos != spec.pos) c.layoutParams = layoutParams()
            applied = spec
        }
        c.setContent(text, snap.pending)

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

    /**
     * 浮层的 LayoutParams。
     *
     * - **纵向**：`topOffsetPx + TOP_MARGIN_DP` —— 永远在监听警示条下面一行
     *   （约束 ③，三个位置档位都一样）；
     * - **横向**：按 [pos] 选 `START` / `CENTER_HORIZONTAL` / `END`，
     *   靠边时留 [SIDE_MARGIN_DP] 的边距（贴着屏幕边看着像被裁掉了一块）。
     *
     * ⚠️ 尺寸永远是 `WRAP_CONTENT`（约束 ①）—— 这里**不许**出现任何具体宽高。
     */
    private fun layoutParams(): FrameLayout.LayoutParams {
        val lp = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            when (pos) {
                IslandStyle.POS_START -> Gravity.TOP or Gravity.START
                IslandStyle.POS_END -> Gravity.TOP or Gravity.END
                else -> Gravity.TOP or Gravity.CENTER_HORIZONTAL
            }
        )
        lp.topMargin = topOffsetPx + dp(TOP_MARGIN_DP)
        when (pos) {
            IslandStyle.POS_START -> lp.marginStart = dp(SIDE_MARGIN_DP)
            IslandStyle.POS_END -> lp.marginEnd = dp(SIDE_MARGIN_DP)
        }
        return lp
    }

    private fun dp(v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    companion object {
        /** 贴顶留白（dp）。太小会贴到状态栏，太大又离画布中心太远 */
        private const val TOP_MARGIN_DP = 10

        /** 靠左 / 靠右时的屏幕边距（dp）。**刻意不是 0** —— 贴边看着像被裁掉一块 */
        private const val SIDE_MARGIN_DP = 10

        private const val ENTER_MS = 180L
        private const val EXIT_MS = 220L

        /** 收起判定的节拍。50ms 足够准（4 秒 ± 50ms），又不至于每秒 20 次唤醒 */
        private const val TICK_MS = 50L
    }
}
