package com.icar.obd.ui.dash

import com.icar.obd.data.GaugeItem
import com.icar.obd.data.PidDefinition
import kotlin.math.PI
import kotlin.math.sin

/**
 * 性能基准的**纯逻辑**：画什么、摆在哪、每帧给什么值。
 *
 * ## 为什么需要这个东西
 *
 * 「9 层霓虹辉光能不能在 8 个仪表下守住 60fps」从 v1.9.0 起**一直没量准**
 * （见 `docs/下一步-主题工具与仪表盘重构.md` §2.4）。之前两次尝试都失败：
 *
 *  - `dumpsys gfxinfo` 在这台设备上只给头部、没有帧统计；
 *  - 用真实数据测时仪表**根本没在动** —— 静止的 View 不重绘，测出来的"帧率"
 *    是屏幕刷新率，和绘制成本无关。
 *
 * 所以要有一个**不依赖数据源**的基准：自己给 8 个表灌连续变化的假值，
 * 逼它们每帧都重绘，再读 [com.icar.obd.ui.view.DrawStats] 的真实耗时。
 *
 * ## 为什么是纯函数
 *
 * 这个文件不碰 View、不碰 Store、不碰总线 —— 排布和取值都能单测。
 * 「8 个格子有没有重叠、值会不会越界」这类错误在真机上只表现为
 * 「某个表看着怪」，靠肉眼很难发现；抽出来测才是划算的。
 *
 * 依赖方向：`ui/dash → data`，单向（与 [DashRenderer] 一致）。
 */
object DashboardBenchmark {

    /** 4 列 × 2 行 = 8 个仪表，平板横屏下正好铺满 */
    const val COLS = 4
    const val ROWS = 2

    /** 常规表数。文档 §2.4 的原始问题就是「8 个仪表下守不守得住」 */
    const val GAUGES = 8

    /**
     * 极限压力表数（4×3）。
     *
     * 为什么要有这一段：只测 8 个的话，万一刚好擦线，结论就只是
     * 「这一种排布没事」。**加 50% 负载再看斜率**，才知道是「还有余量」
     * 还是「刚好压线」—— 而这两者的维护含义完全不同。
     */
    const val STRESS_GAUGES = 12

    /** 格子之间的缝（画布单位）。360/4 = 90，留 3 单位缝刚好不粘在一起 */
    const val GAP = 3f

    /**
     * 假值的正弦周期（秒）。
     *
     * 取 2 秒是权衡：太慢则每帧变化量小，缓动会提前「吸附」而看不出动画；
     * 太快则仪表一直在追赶，测的是追赶而不是稳态绘制。
     * 2 秒在 60fps 下每帧约变量程的 0.08%，指针始终在动。
     */
    const val PERIOD_SEC = 2f

    /** 每个表一个内置 PID，量程/单位取真实值，这样画出来的东西和真机一致 */
    val pids: List<PidDefinition> = listOf(
        PidDefinition(
            id = "bench_rpm", name = "转速", mode = "01", pid = "0C", formula = "((A*256)+B)/4",
            unit = "rpm", minVal = 0f, maxVal = 8000f, warnHigh = 6500f, builtIn = true
        ),
        PidDefinition(
            id = "bench_speed", name = "车速", mode = "01", pid = "0D", formula = "A",
            unit = "km/h", minVal = 0f, maxVal = 240f, warnHigh = 120f, builtIn = true
        ),
        PidDefinition(
            id = "bench_coolant", name = "水温", mode = "01", pid = "05", formula = "A-40",
            unit = "°C", minVal = -40f, maxVal = 150f, warnHigh = 105f, builtIn = true
        ),
        PidDefinition(
            id = "bench_volt", name = "电压", mode = "01", pid = "42", formula = "((A*256)+B)/1000",
            unit = "V", minVal = 0f, maxVal = 20f, warnLow = 11.5f, builtIn = true
        ),
        PidDefinition(
            id = "bench_intake", name = "进气温度", mode = "01", pid = "0F", formula = "A-40",
            unit = "°C", minVal = -40f, maxVal = 100f, builtIn = true
        ),
        PidDefinition(
            id = "bench_throttle", name = "节气门", mode = "01", pid = "11", formula = "A*100/255",
            unit = "%", minVal = 0f, maxVal = 100f, builtIn = true
        ),
        PidDefinition(
            id = "bench_load", name = "发动机负荷", mode = "01", pid = "04", formula = "A*100/255",
            unit = "%", minVal = 0f, maxVal = 100f, builtIn = true
        ),
        PidDefinition(
            id = "bench_oil", name = "机油温度", mode = "01", pid = "5C", formula = "A-40",
            unit = "°C", minVal = -40f, maxVal = 210f, warnHigh = 130f, builtIn = true
        )
    )

    /**
     * [GAUGES] 条仪表定义，按 [COLS]×[ROWS] 铺满整块画布。
     *
     * 每条的 `minVal/maxVal` 取自 [pids]，与真机一致 ——
     * 否则量程不同，指针的弧长、刻度密度都会变，测出来的耗时也就不可比。
     */
    val gauges: List<GaugeItem>
        get() = gaugeList(GAUGES, COLS, ROWS)

    /**
     * 按指定数量与网格建仪表定义。
     *
     * PID 不够时**循环取**（12 个表用 8 条 PID）—— 基准只关心"画多少块"，
     * 不关心数据是不是重复的。循环而不是报错，是为了让压力段能随手改表数。
     */
    fun gaugeList(count: Int, cols: Int = COLS, rows: Int = ROWS): List<GaugeItem> =
        (0 until count).map { i ->
            val p = pids[i % pids.size]
            val r = cellRect(i, cols, rows)
            GaugeItem(
                pidId = p.id,
                style = GaugeItem.STYLE_CIRCLE,
                minVal = p.minVal,
                maxVal = p.maxVal,
                warnLow = p.warnLow,
                warnHigh = p.warnHigh,
                x = r[0], y = r[1], w = r[2], h = r[3]
            )
        }

    /**
     * 第 [index] 个格子的 `[x, y, w, h]`（画布单位，每轴 0..[GaugeItem.CANVAS]）。
     *
     * 行优先：`index = row * cols + col`。最后一行不足时**不拉伸补满** ——
     * 保持格子尺寸一致，否则「8 个表」的测量里会混进几个特别大的表，数字没法比。
     */
    fun cellRect(index: Int, cols: Int = COLS, rows: Int = ROWS): FloatArray {
        val c = cols.coerceAtLeast(1)
        val r = rows.coerceAtLeast(1)
        val col = index % c
        val row = (index / c) % r
        val cw = GaugeItem.CANVAS / c
        val chh = GaugeItem.CANVAS / r
        return floatArrayOf(
            col * cw + GAP, row * chh + GAP,
            cw - GAP * 2f, chh - GAP * 2f
        )
    }

    /**
     * 第 [index] 条表在时刻 [nowMs] 的值。
     *
     * 用 `sin` 而不是锯齿/方波：正弦**处处连续**，没有跳变。
     * 锯齿每周期会跳回起点，那一下会额外触发一次全量重绘，把峰值耗时拉高，
     * 测出来的就不是稳态成本了。
     *
     * 相位错开（每条差 1/8 周期）是为了让各表**不同步** ——
     * 全部同相位的话它们会在同一帧一起到达峰值，峰值耗时会叠加，
     * 而真机上仪表本来就是各走各的。
     */
    fun valueAt(index: Int, nowMs: Long): Float {
        val p = pids[index % pids.size]
        val phase = (nowMs / 1000.0) / PERIOD_SEC + index / pids.size.toDouble()
        val n = (sin(phase * 2.0 * PI) + 1.0) / 2.0          // 0..1
        return (p.minVal + (p.maxVal - p.minVal) * n).toFloat()
    }

    /**
     * 一次测量的完整取值：主参数 + 副参数。
     *
     * 基准里不给副参数（[GaugeItem.extraPids] 为空），但接口保持一致，
     * 将来要测「多数据显示」那几种样式时不用改调用方。
     */
    fun valuesAt(index: Int, nowMs: Long): List<Float?> = listOf(valueAt(index, nowMs))
}
