package com.icar.obd.ui.view

import com.icar.obd.data.AppLog

/**
 * 绘制耗时统计。
 *
 * ## 为什么要在应用内量
 *
 * `dumpsys gfxinfo` 在这台设备上给不出可用数据（只有头部，没有帧统计）。
 * 而且它量的是**整帧**，分不清是哪个仪表贵 —— 优化时需要的是**每个控件**的耗时。
 *
 * ## 用法
 *
 * [BaseGaugeView] 的 `onDraw` 是 `final` 的，它包住子类的 `drawGauge` 并计时。
 * 这样**所有仪表自动被覆盖**，不用每个子类自己加。
 *
 * 累加是 `Long` 的简单加法，在 60fps 下开销可以忽略（纳秒级）。
 * 真正贵的是 `onDraw` 本身，不在这一层。
 */
object DrawStats {

    /** 单次统计窗口内的累加。key = 控件类名 */
    private val acc = HashMap<String, LongArray>()   // [count, totalNs, maxNs]

    /** 每秒结算一次，避免每帧都做除法/字符串 */
    private var windowStart = 0L

    /** 本窗口内**所有仪表**的绘制次数之和 = 帧数 × 仪表数（见 [Snapshot] 的说明） */
    private var windowFrames = 0L

    /** 窗口长度。5 秒够看出趋势，又不至于刷屏 */
    private const val WINDOW_MS = 5000L

    /**
     * 一次测量的结果。
     *
     * ## 为什么 `totalFrames` 要除以 `gaugeCount` 才是帧数
     *
     * [record] 是**每个仪表**在每次 `onDraw` 里各调一次，所以一次绘制循环里
     * 8 个仪表会记 8 次。`totalFrames` 记的是这个总和 ——
     * 除以同时在场的仪表数才是真正的帧数。
     *
     * 之所以不直接记帧数：这一层根本不知道"当前屏幕上有几个仪表"，
     * 硬要它知道就得让 `BaseGaugeView` 去注册/注销，反而把简单的事弄复杂。
     * 调用方（性能基准页）自己知道仪表数，除一下即可。
     */
    data class Snapshot(
        /** 窗口内总绘制次数（= 帧数 × 仪表数） */
        val totalFrames: Long,
        /** 窗口实际长度（毫秒） */
        val windowMs: Long,
        /** 所有仪表的**每帧**平均绘制耗时之和（微秒） */
        val avgFrameUs: Double,
        /** 最贵的单次绘制（微秒） */
        val peakUs: Double,
        /** 明细，已按平均耗时降序 */
        val rows: List<Row>
    ) {
        data class Row(val name: String, val count: Long, val avgUs: Double, val peakUs: Double)

        /** 帧率。仪表数为 0 时返回 0 */
        fun fps(gaugeCount: Int): Double {
            if (gaugeCount <= 0 || windowMs <= 0) return 0.0
            return totalFrames.toDouble() / gaugeCount / (windowMs / 1000.0)
        }

        /** 每帧绘制耗时（毫秒） */
        val frameMs: Double get() = avgFrameUs / 1000.0
    }

    @Synchronized
    fun record(name: String, ns: Long) {
        val a = acc.getOrPut(name) { LongArray(3) }
        a[0]++
        a[1] += ns
        if (ns > a[2]) a[2] = ns
        windowFrames++
    }

    /**
     * 读取当前窗口的统计**并清空**。
     *
     * 性能基准页用它取一段干净的测量区间：测前 `snapshot()` 丢掉热身数据，
     * 测后 `snapshot()` 拿到这一段的结果。
     */
    @Synchronized
    fun snapshot(): Snapshot {
        val now = android.os.SystemClock.uptimeMillis()
        val winMs = if (windowStart == 0L) 0L else (now - windowStart).coerceAtLeast(0L)
        val rows = acc.entries
            .map { (k, v) ->
                val n = v[0].coerceAtLeast(1)
                Snapshot.Row(k, v[0], v[1] / n / 1000.0, v[2] / 1000.0)
            }
            .sortedByDescending { it.avgUs }
        val snap = Snapshot(
            totalFrames = windowFrames,
            windowMs = winMs,
            avgFrameUs = rows.sumOf { it.avgUs },
            peakUs = rows.maxOfOrNull { it.peakUs } ?: 0.0,
            rows = rows
        )
        acc.clear()
        windowFrames = 0L
        windowStart = 0L
        return snap
    }

    /**
     * 每帧调一次。满一个窗口就结算并清空。
     *
     * 日志格式刻意做成**一眼能看出哪个贵**：`次数 / 平均 / 峰值`。
     */
    @Synchronized
    fun tick(nowMs: Long) {
        if (windowStart == 0L) {
            windowStart = nowMs
            return
        }
        if (nowMs - windowStart < WINDOW_MS) return
        if (acc.isEmpty()) {
            windowStart = nowMs
            windowFrames = 0L
            return
        }

        // 按平均耗时降序 —— 优化时先看最上面那个
        val rows = acc.entries
            .map { (k, v) ->
                val n = v[0].coerceAtLeast(1)
                Triple(k, v[1] / n / 1000.0, v[2] / 1000.0)   // 微秒
            }
            .sortedByDescending { it.second }

        val totalAvg = rows.sumOf { it.second }
        val sb = StringBuilder()
        sb.append("每帧绘制 %.1f ms（%d 类控件）| ".format(totalAvg / 1000.0))
        rows.take(5).forEach { (name, avgUs, maxUs) ->
            sb.append("%s 平均%.0fµs/峰值%.0fµs  ".format(name, avgUs, maxUs))
        }
        AppLog.i(AppLog.M_UI, "绘制耗时", sb.toString().trim())

        acc.clear()
        windowFrames = 0L
        windowStart = nowMs
    }

    @Synchronized
    fun reset() {
        acc.clear()
        windowFrames = 0L
        windowStart = 0L
    }
}
