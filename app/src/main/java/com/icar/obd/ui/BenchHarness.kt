package com.icar.obd.ui

import android.os.SystemClock
import android.view.Choreographer
import android.widget.FrameLayout
import com.icar.obd.data.GaugeItem
import com.icar.obd.ui.dash.DashboardBenchmark
import com.icar.obd.ui.view.BaseGaugeView
import com.icar.obd.ui.view.DrawStats
import com.icar.obd.ui.view.GaugeTheme
import com.icar.obd.ui.view.GaugeTicker
import com.icar.obd.ui.view.GaugeViewFactory

/**
 * 性能基准的**驱动端**：把 [DashboardBenchmark] 的定义变成真的 View，并让它们持续动。
 *
 * ## 它为什么必须自己驱动，不能靠模拟信号
 *
 * 用 `SignalSimulator` 灌总线也能让表动起来，但那样测的是
 * 「总线推送 → 渲染 → 绘制」整条链，而且推送只有 10Hz —— 中间会有大量
 * **没有重绘的帧**混进来，帧率数字被稀释，看不出绘制成本。
 *
 * 这里直接每帧调 `updateMulti()`，**保证每一帧都重绘**，
 * 测出来的就是纯粹的绘制开销。这正是文档 §2.4 要求的「不依赖数据源的基准」。
 *
 * ## ⚠️ 一个必须说清楚的细节：`GaugeTicker.request()` 是刻意的
 *
 * 缓动收敛后 `stepFrame()` 会返回 false，[GaugeTicker] 就把这个视图摘出动画集合、
 * 不再重绘。若照搬这个行为，基准会变成「动一会儿就停」——
 * 静止的帧不重绘，帧率自然好看，但**什么都没测到**。
 *
 * 所以每帧都重新 `request()` 一次，强制保持「每帧重绘」。
 * 这是**测量手段**，不是产品行为，别把它抄到正常渲染路径里。
 *
 * ## 关于真实观感
 *
 * 强制重绘保证的是「绘制成本测准了」，**不保证**缓动视觉上平滑。
 * 圆表的收敛阈值是半个像素（转速约 5.6 转），2 秒周期的正弦在峰顶附近
 * 每帧只变 0.66 转 —— 真实运行时指针在峰顶会**吸附住再跳一下**。
 * 这是缓动阈值本身的取舍，不在本次基准的测量范围内。
 */
class BenchHarness(
    private val container: FrameLayout,
    private val theme: GaugeTheme
) {

    private class Cell(val view: BaseGaugeView, val host: FrameLayout)

    private val cells = ArrayList<Cell>()
    private var running = false
    private var frames = 0L
    private var startMs = 0L

    /** 预热结束的时刻。在此之前帧照跑、但不计数（见 [start] 的说明） */
    private var warmupUntilMs = 0L

    /** 预热结束的时刻（= 测量起点）。UI 用它算总时长 */
    var measuredFromMs = 0L
        private set

    // ---- 逐帧间隔统计（判断"有没有掉帧"的**真正判据**）----
    //
    // 为什么不能只看 DrawStats：
    // Android 开了硬件加速后，`onDraw` 只是把绘制指令**记录**进 DisplayList，
    // 真正的光栅化在**渲染线程**上做。所以 DrawStats 的 0.3ms 是"记录耗时"，
    // 不是"绘制成本" —— 拿它下结论会得出过于乐观的答案。
    //
    // 帧间隔不同：它是主线程 + 渲染线程 + 合成器整条链路的最终结果。
    // 帧间隔稳定等于刷新周期（120Hz → 8.33ms）就说明**没有掉帧**，
    // 不管中间哪一环花了多少。
    private var lastFrameNs = 0L
    private var frameIntervals = LongArray(MAX_SAMPLES)
    private var intervalCount = 0

    // ---- 流畅度统计（v1.10.4）----
    //
    // 帧率与掉帧只说明"画得动"，不说明"动得顺"。用户抱怨的"一格一格跳"
    // 是**指针在部分帧上没有位移**（缓动提前收敛 / 吸附太早）。
    // 所以这里直接统计"有多少帧的显示值真的变了" —— 那才是"顺不顺"的判据。
    private var lastSeenDisplay = Float.NaN
    private var motionFrames = 0L

    private val frameCallback = object : Choreographer.FrameCallback {
        override fun doFrame(frameTimeNanos: Long) {
            if (!running) return
            val nowMs = frameTimeNanos / 1_000_000

            // 预热期内照常驱动动画（把首帧的一次性开销付掉），但不计数
            val warming = nowMs < warmupUntilMs
            if (!warming) {
                if (frames == 0L) {
                    // 预热刚结束：此刻才开始计时，并把预热期间的统计丢掉
                    startMs = SystemClock.uptimeMillis()
                    measuredFromMs = startMs
                    lastFrameNs = 0L
                    intervalCount = 0
                    lastSeenDisplay = Float.NaN
                    motionFrames = 0L
                    DrawStats.reset()
                }
                frames++
                // 帧间隔用 vsync 时间戳算，**不用 uptimeMillis** ——
                // 后者在掉帧时会让动画"追赶"，测出来的间隔会失真
                if (lastFrameNs != 0L && intervalCount < MAX_SAMPLES) {
                    frameIntervals[intervalCount++] = frameTimeNanos - lastFrameNs
                }
                lastFrameNs = frameTimeNanos
            }

            cells.forEachIndexed { i, c ->
                c.view.updateMulti(DashboardBenchmark.valuesAt(i, nowMs), null)
                // 见类注释：强制留在动画集合里，否则收敛后就停止重绘了
                GaugeTicker.request(c.view)
            }

            // 流畅度：以第一块表为准，统计"显示值真的变了"的帧
            if (!warming) {
                val shown = cells.firstOrNull()?.view?.shownValueForBench()
                if (shown != null) {
                    if (!lastSeenDisplay.isNaN() && shown != lastSeenDisplay) motionFrames++
                    lastSeenDisplay = shown
                }
            }

            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    val gaugeCount: Int get() = cells.size

    /** 当前在动画中的仪表数。持续动画时应当等于 [gaugeCount] */
    fun animatingCount(): Int = cells.count { it.view.isAnimating }

    /**
     * 按 [DashboardBenchmark.gaugeList] 建视图。重复调用会先清空。
     *
     * @param count 表数。8 = 常规，[DashboardBenchmark.STRESS_GAUGES] = 极限压力
     * @param neonPreset 霓虹档位名；`null` = 跟随主题全局
     */
    fun build(count: Int = DashboardBenchmark.GAUGES, neonPreset: String? = null) {
        stop()
        cells.forEach { container.removeView(it.host) }
        cells.clear()

        val ctx = container.context
        val density = ctx.resources.displayMetrics.density
        val cw = container.width
        val ch = container.height
        if (cw <= 0 || ch <= 0) return

        // 表数决定网格：12 个表用 4×3，否则最后一行会溢到画布外
        val rows = if (count > DashboardBenchmark.COLS * DashboardBenchmark.ROWS) 3 else DashboardBenchmark.ROWS

        DashboardBenchmark.gaugeList(count, DashboardBenchmark.COLS, rows).forEachIndexed { i, base ->
            // 霓虹档位是**每条仪表自己的覆盖**（null = 跟随主题全局）。
            // 基准要对比不同档位，所以在这里显式写进去。
            val item = if (neonPreset == null) base else GaugeItem(
                pidId = base.pidId, extraPids = base.extraPids, style = base.style,
                minVal = base.minVal, maxVal = base.maxVal,
                warnLow = base.warnLow, warnHigh = base.warnHigh,
                x = base.x, y = base.y, w = base.w, h = base.h,
                neonPreset = neonPreset
            )
            val host = FrameLayout(ctx).apply {
                background = theme.cardBackground(density)
                val pad = (density * 4).toInt()
                setPadding(pad, pad, pad, pad)
            }
            val view = GaugeViewFactory.create(ctx, item.style)
            view.bind(item, DashboardBenchmark.pids[i % DashboardBenchmark.pids.size], theme, emptyList())
            host.addView(
                view,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )

            // 与 DashRenderer 完全同一套换算，保证基准里的格子尺寸 = 真机的格子尺寸
            val wpx = (item.w / GaugeItem.CANVAS * cw).toInt().coerceAtLeast(1)
            val hpx = (item.h / GaugeItem.CANVAS * ch).toInt().coerceAtLeast(1)
            val lp = FrameLayout.LayoutParams(wpx, hpx).apply {
                leftMargin = (item.x / GaugeItem.CANVAS * cw).toInt()
                topMargin = (item.y / GaugeItem.CANVAS * ch).toInt()
            }
            container.addView(host, lp)
            cells.add(Cell(view, host))
        }
    }

    /**
     * 开始持续动画并计时。会先清空 [DrawStats] 的窗口，避免混进上一段的数据。
     *
     * ## 为什么必须有预热
     *
     * 第一版没有预热，测出来的「单次峰值」是 **11393µs** ——
     * 那个数出现在**重建视图后的第一帧**：`Paint` 首次光栅化、字体度量、
     * 路径 tessellation 都在那一帧付掉。它是真实存在的成本，但**不是稳态成本**，
     * 混在平均值里会让「霓虹贵不贵」这个结论偏向悲观。
     *
     * 所以先跑 [WARMUP_MS] 毫秒把一次性开销付掉，再 `reset()` 才开始计数。
     * 预热的帧数不计入 [frameCount]，测出来的就是干净的稳态。
     */
    fun start() {
        if (running || cells.isEmpty()) return
        DrawStats.reset()
        frames = 0L
        intervalCount = 0
        lastFrameNs = 0L
        running = true
        warmupUntilMs = SystemClock.uptimeMillis() + WARMUP_MS
        // 这两个都在预热结束的那一帧才真正确定（见 doFrame）
        startMs = warmupUntilMs
        measuredFromMs = 0L
        Choreographer.getInstance().postFrameCallback(frameCallback)
    }

    fun stop() {
        if (!running) return
        running = false
        Choreographer.getInstance().removeFrameCallback(frameCallback)
    }

    val isRunning: Boolean get() = running

    /** 预热是否已结束。UI 可以据此提示「预热中…」 */
    fun isWarmedUp(): Boolean = SystemClock.uptimeMillis() >= warmupUntilMs

    /** 实测帧率 = 自绘帧数 / 经过时间（不含预热） */
    fun measuredFps(): Double {
        val dt = SystemClock.uptimeMillis() - startMs
        if (dt <= 0L || frames == 0L) return 0.0
        return frames.toDouble() / (dt / 1000.0)
    }

    /**
     * 自绘帧数（不含预热帧）。可与 [DrawStats] 的 `totalFrames / gaugeCount`
     * 交叉核对 —— 两者对不上说明有别的 View 也在画（那这次测量就不可信了）。
     */
    fun frameCount(): Long = frames

    /**
     * 帧间隔统计 —— **这才是"守不守得住"的判据**。
     *
     * @param jankMs 超过这个间隔就算掉了一帧。默认按 60fps 的 16.7ms 算；
     *   屏幕是 120Hz 时应传 8.3ms，否则"掉一半帧"都测不出来。
     */
    fun frameStats(jankMs: Double = FRAME_BUDGET_MS): FrameStats {
        if (intervalCount == 0) return FrameStats(0, 0.0, 0.0, 0.0, 0, 0.0)
        val sorted = LongArray(intervalCount) { frameIntervals[it] }
        sorted.sort()
        val n = sorted.size
        var sum = 0L
        var over = 0
        for (i in 0 until n) {
            sum += sorted[i]
            if (sorted[i] / 1e6 > jankMs) over++
        }
        return FrameStats(
            count = n,
            avgMs = sum.toDouble() / n / 1e6,
            p99Ms = sorted[((n - 1) * 99 / 100)].toDouble() / 1e6,
            maxMs = sorted[n - 1].toDouble() / 1e6,
            overBudget = over,
            overBudgetPct = over.toDouble() / n * 100.0
        )
    }

    /** 一段测量里的帧间隔分布 */
    data class FrameStats(
        val count: Int,
        val avgMs: Double,
        val p99Ms: Double,
        val maxMs: Double,
        /** 超过预算的帧数（掉帧） */
        val overBudget: Int,
        val overBudgetPct: Double
    ) {
        /** 有没有掉帧。0 次才算守住 */
        val clean: Boolean get() = overBudget == 0

        fun oneLine(jankMs: Double): String =
            "帧间隔 平均%.2fms p99=%.2fms 最大%.2fms | 超 %.1fms 的帧 %d/%d（%.1f%%）"
                .format(avgMs, p99Ms, maxMs, jankMs, overBudget, count, overBudgetPct)
    }

    /**
     * 流畅度（v1.10.4）。
     *
     * 帧率与掉帧只说明"画得动"，**不说明"动得顺"** ——
     * 用户抱怨的"一格一格跳"是"指针在部分帧上没有位移"。
     * 所以这里直接数"显示值真的变了"的帧占比。
     */
    fun motionRatio(): Double {
        if (frames <= 0L) return 0.0
        return motionFrames.toDouble() / frames
    }

    /** 实测帧数（不含预热），[motionRatio] 的分母 */
    val motionFramesTotal: Long get() = frames

    /** 显示值真的变了的帧数 */
    val motionFramesMoved: Long get() = motionFrames

    companion object {
        /** 60fps 下每帧 16.7ms —— 判定「守得住」的基准线 */
        const val FRAME_BUDGET_MS = 16.7

        /** 每段测量时长（秒）。文档 §2.4 建议 10 秒 */
        const val SEGMENT_SEC = 10

        /**
         * 预热时长（毫秒）。1.5 秒 ≈ 90 帧，足够把首帧的一次性开销摊掉，
         * 又不至于让整轮测量拖得太久。
         */
        const val WARMUP_MS = 1500L

        /** 帧间隔采样上限。10 秒 @120Hz ≈ 1200 帧，留一倍余量 */
        const val MAX_SAMPLES = 4096
    }
}
