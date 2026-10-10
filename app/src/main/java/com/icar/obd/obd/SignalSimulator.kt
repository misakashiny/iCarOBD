package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import com.icar.obd.data.AppLog
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import kotlin.math.PI
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * 模拟信号发生器：往 [VehicleBus] 灌合成波形，**没有车也能调试仪表控件**。
 *
 * ## 为什么需要它
 *
 * 到 v1.5.0 为止，实车数据链路一次都没跑通（BLE 写入修复未复验）。
 * 结果是「仪表长什么样、动画顺不顺、报警色对不对」这些**纯显示问题**，
 * 每次都要等到能上车才能看 —— 调试成本极高。
 * 这个工具把「显示层调试」与「总线调试」彻底解耦。
 *
 * ## 两种模式
 *
 * 1. **自动**：按 PID 类型给一个「像真的」波形（车速正弦、转速锯齿、水温缓慢上升…）。
 *    一键开演，不需要逐条配。
 * 2. **手动**：逐通道覆盖波形 / 周期 / 幅值 / 噪声，用于精细调试单个控件。
 *    在自动模式下调过某条，那条就转成手动。
 *
 * ## 与真实轮询的关系
 *
 * 开启时会**停掉 [ObdEngine]**（由 UI 负责），否则合成值会和真实值交替写入总线，
 * 画面会来回跳。这与「PID 连续采样」停引擎是同一个理由。
 *
 * ## 可测性
 *
 * [waveAt] / [valueOf] / [phaseAt] 都是纯函数，[tick] 接受注入的时间戳 ——
 * 所以波形正确性完全可以用单测钉住，不需要跑 UI。
 */
object SignalSimulator {

    // ---- 波形 ----
    const val WAVE_SINE = 0
    const val WAVE_TRIANGLE = 1
    const val WAVE_SAW = 2
    const val WAVE_SQUARE = 3
    const val WAVE_RAMP = 4
    const val WAVE_RANDOM = 5
    const val WAVE_CONSTANT = 6

    val WAVE_NAMES = listOf("正弦", "三角", "锯齿", "方波", "斜坡", "随机", "恒定")

    /** 推送到总线的频率。10Hz 足够看清动画，又不会把 UI 压垮 */
    private const val TICK_MS = 100L

    /** 合成数据的来源标记 */
    const val SRC = "sim"

    /** 快速演示模式的周期（秒）。3 秒扫完全程，肉眼能跟上 */
    const val DEMO_PERIOD_SEC = 3f

    /**
     * 单个通道的合成配置。
     *
     * 注意 [min] / [max] 是**合成值的范围**，不是仪表的显示量程 ——
     * 目的是产出「物理上说得通」的数，而不是把量程拉满。
     */
    data class Channel(
        val pidId: String,
        var enabled: Boolean = true,
        var wave: Int = WAVE_SINE,
        /** 一个完整周期多少秒 */
        var periodSec: Float = 20f,
        var min: Float = 0f,
        var max: Float = 100f,
        /** 噪声幅度，按 (max-min) 的比例算 */
        var noise: Float = 0.02f
    ) {
        /**
         * 归一化后的**下界 / 上界**：`min`/`max` 谁小谁当下界。
         *
         * ⚠️ v1.20.18 起 [valueOf] 只认这两个（不再直接读 `min`/`max`）——
         * 理由见 [valueOf] 的注释：空 range 崩溃就是直接读 `min`/`max` 造成的。
         */
        val lo: Float get() = minOf(min, max)
        val hi: Float get() = maxOf(min, max)

        /**
         * 归一化副本：把**写反的量程摆正**（`min` 取小、`max` 取大）。
         * 本来就正的返回**自身**（不产生垃圾 —— 这条会被高频调用）。
         */
        fun normalized(): Channel = if (min <= max) this else copy(min = max, max = min)

        /**
         * 改下界，**不允许越过上界**（越过了就取上界）。
         *
         * UI 的 ± 档位走这里 —— 单靠"把每一端夹在 PID 量程里"是不够的：
         * 两端各自合法，合起来仍然可能是空的（v1.20.18 那个崩溃）。
         */
        fun withMin(v: Float): Channel {
            val n = normalized()
            return n.copy(min = if (v <= n.max) v else n.max)
        }

        /** 改上界，**不允许低于下界** */
        fun withMax(v: Float): Channel {
            val n = normalized()
            return n.copy(max = if (v >= n.min) v else n.min)
        }
    }

    /**
     * 主线程派发器。**必须是 lazy** —— 与 `AppLog` 同一个理由：
     * JVM 单测里没有 Looper，写成字段初始化会让整个 object 一碰就抛 `Stub!`，
     * 于是 [waveAt] / [valueOf] 这些纯函数也跟着没法测了。
     * （这个坑在本项目已经踩过两次，改代码时留意。）
     */
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val channels = LinkedHashMap<String, Channel>()

    @Volatile
    var running: Boolean = false
        private set

    private var startTs = 0L

    private val ticker = object : Runnable {
        override fun run() {
            if (!running) return
            // ⚠️ 兜底（v1.20.18）：**任何**意外异常都不该让模拟永久停摆。
            //
            // 真实教训（2026-10-11 01:31:12）：`valueOf` 抛出后，
            // 下一行的 `postDelayed` 根本执行不到 —— 模拟直接死掉，
            // 而且异常在主线程上没人接 → 进程被系统重启。
            // 根因已在 [valueOf] 里结构性修掉（量程归一）；
            // 这一层只保证「将来再出别的意外，也只是少一拍，不是停摆」。
            runCatching { tick(System.currentTimeMillis()) }.onFailure {
                AppLog.e(
                    AppLog.M_OBD, "模拟信号 tick 异常（已跳过本拍）",
                    it.message ?: it.javaClass.simpleName
                )
            }
            main.postDelayed(this, TICK_MS)
        }
    }

    // ================================================================ 纯函数

    /**
     * 波形求值。
     * @param phase 相位，会被取小数部分（0..1）
     * @return 归一化 0..1
     */
    fun waveAt(wave: Int, phase: Float): Float {
        val p = phase - Math.floor(phase.toDouble()).toFloat()   // 保证落在 0..1（含负数）
        return when (wave) {
            WAVE_SINE -> ((sin(p * 2.0 * PI).toFloat() + 1f) / 2f)
            WAVE_TRIANGLE -> if (p < 0.5f) p * 2f else (1f - p) * 2f
            WAVE_SAW -> p
            WAVE_SQUARE -> if (p < 0.5f) 1f else 0f
            WAVE_RAMP -> p
            WAVE_RANDOM -> Random.nextFloat()
            else -> 1f
        }
    }

    /** 由时间戳算相位：`(经过秒数 / 周期) % 1` */
    fun phaseAt(now: Long, startTs: Long, periodSec: Float): Float {
        val period = periodSec.coerceAtLeast(0.5f)
        return (((now - startTs) / 1000f) / period) % 1f
    }

    /**
     * 通道在给定相位的输出值（含噪声，夹在量程内）。
     *
     * ## ⚠️ 为什么用 [Channel.lo] / [Channel.hi]，而不是 `ch.min` / `ch.max`（v1.20.18 修）
     *
     * 2026-10-11 01:31:12 平板实机崩溃（`files/last-crash.log`，设备 7e7d7bb4）：
     * ```
     * java.lang.IllegalArgumentException: Cannot coerce value to an empty range:
     *   maximum 120.5 is less than minimum 122.0
     *   at com.icar.obd.obd.SignalSimulator.valueOf(SignalSimulator.kt:136)
     *   at com.icar.obd.obd.SignalSimulator.tick(SignalSimulator.kt:300)
     *   at com.icar.obd.obd.SignalSimulator$ticker$1.run(SignalSimulator.kt:99)
     * ```
     *
     * **根因**：`min` / `max` 是**两个各自独立的可变量**，而 UI 的 ± 档位
     * （`SimulatorActivity.rangeSide`）只把每一端夹在 **PID 的量程**里，
     * 从不看另一端 —— 于是 `min` 能**合法地**越过 `max`。
     * 实测那条是「冷却液温度」（PID 量程 -40~215，步进 = 255/20 = 12.75，
     * 自动通道起点 20~95）：「最大」按 + 两次 = **120.5**，
     * 「最小」按 + 八次 = **122.0** —— 两端各自都在量程内，合起来是空区间，
     * `coerceIn(122.0, 120.5)` 直接抛。
     *
     * 异常抛在主线程且**没人接** → 进程被杀（App 于 01:31:13 重启，日志有
     * 「===== iCar OBD 启动 =====」），而且 `ticker` 里 `postDelayed` 那行
     * 根本执行不到 → **模拟永久停摆**。
     *
     * 现在**先归一**（[Channel.lo] ≤ [Channel.hi] 恒成立）→
     * 空 range **结构上不可能**出现。量程写反时的语义是
     * 「同一个区间，只是声明写反了」，产出值仍然落在两端之间。
     */
    fun valueOf(ch: Channel, phase: Float): Float {
        val n = waveAt(ch.wave, phase)
        val lo = ch.lo
        val hi = ch.hi
        // 先夹一次再叠噪声：极端量程（±Float.MAX_VALUE）下 (hi-lo) 会溢出成 Inf，
        // 若让 Inf 直接去加 jitter 会得到 NaN —— 夹过之后 base 一定是有限值。
        val base = (lo + (hi - lo) * n).coerceIn(lo, hi)
        if (ch.noise <= 0f) return base
        val jitter = (Random.nextFloat() - 0.5f) * 2f * ch.noise * (hi - lo)
        return (base + jitter).coerceIn(lo, hi)
    }

    /**
     * 量程档位步进（`SimulatorActivity` 的 ± 用）。
     *
     * **两端先归一再夹** —— 于是「PID 量程被写反」（导入的 JSON、手改的配置）
     * 也不会在这里抛空 range（与 [valueOf] 同一个根因）。
     *
     * @param value 当前值
     * @param delta 步进量（可正可负）
     * @param pidMin / [pidMax] PID 的显示量程（写反了也没关系）
     */
    fun stepRange(value: Float, delta: Float, pidMin: Float, pidMax: Float): Float {
        val lo = minOf(pidMin, pidMax)
        val hi = maxOf(pidMin, pidMax)
        return (value + delta).coerceIn(lo, hi)
    }

    // ================================================================ 自动配置

    /**
     * 按 PID 给一个「像真的」默认波形。
     *
     * 内置几条特意做得有辨识度：转速用锯齿（模拟换挡回落）、水温用斜坡（冷车到热车）、
     * 电压用小幅正弦（发电机波动）—— 这样一眼就能看出仪表有没有正确响应。
     */
    fun autoChannel(p: PidDefinition): Channel = when (p.id) {
        "std_0C" -> Channel(p.id, wave = WAVE_SAW, periodSec = 12f, min = 800f, max = 3500f, noise = 0.02f)
        "std_0D" -> Channel(p.id, wave = WAVE_SINE, periodSec = 40f, min = 0f, max = 120f, noise = 0.01f)
        // 温度类周期刻意缩短：60~120 秒的斜坡在 10 秒观察窗里几乎不动，看起来像「没数据」
        "std_05" -> Channel(p.id, wave = WAVE_RAMP, periodSec = 40f, min = 20f, max = 95f, noise = 0.004f)
        // 电压要占满量程的可观比例，否则 0~20V 表上 0.9V 的摆幅看着就是不动
        "std_42" -> Channel(p.id, wave = WAVE_SINE, periodSec = 6f, min = 11.8f, max = 14.8f, noise = 0.006f)
        "std_04" -> Channel(p.id, wave = WAVE_SINE, periodSec = 15f, min = 15f, max = 70f, noise = 0.05f)
        "std_11" -> Channel(p.id, wave = WAVE_SINE, periodSec = 15f, min = 5f, max = 60f, noise = 0.05f)
        "std_0F" -> Channel(p.id, wave = WAVE_RAMP, periodSec = 50f, min = 20f, max = 45f, noise = 0.01f)
        "std_5C" -> Channel(p.id, wave = WAVE_RAMP, periodSec = 45f, min = 30f, max = 100f, noise = 0.01f)
        "calc_boost" -> Channel(p.id, wave = WAVE_SAW, periodSec = 10f, min = -60f, max = 80f, noise = 0.04f)
        // G 值三件套：gx / gy 同周期，[tick] 里会给 gy 加 90° 相位差，轨迹是个圆
        "calc_gx" -> Channel(p.id, wave = WAVE_SINE, periodSec = 8f, min = -1.2f, max = 1.2f, noise = 0.01f)
        "calc_gy" -> Channel(p.id, wave = WAVE_SINE, periodSec = 8f, min = -1.2f, max = 1.2f, noise = 0.01f)
        "calc_gforce" -> Channel(p.id, wave = WAVE_SINE, periodSec = 8f, min = 0f, max = 1.5f, noise = 0f)
        // 通用兜底：用 PID 自己的量程收窄到中间 80%，至少不会顶到表盘两端
        else -> {
            val span = (p.maxVal - p.minVal).let { if (it <= 0f) 100f else it }
            Channel(
                p.id,
                wave = WAVE_SINE,
                periodSec = 20f,
                min = p.minVal + span * 0.1f,
                max = p.minVal + span * 0.9f,
                noise = 0.02f
            )
        }
    }

    /**
     * 用当前启用的 PID 重建通道表（保留已有的手动改动）。
     *
     * **包含 CALC（派生）PID** —— 它们是算出来的、不是总线上问出来的，
     * 但仪表盘上照样要显示。早期版本把它们过滤掉了，结果「G力值」预设
     * 在模拟模式下**整块是死的**。
     */
    fun rebuildFromPids() {
        val enabled = Store.allPids().filter { it.enabled }
        val keep = channels.toMap()
        channels.clear()
        enabled.forEach { p ->
            // ⚠️ 保留的手动通道也要**过一遍归一**（v1.20.18）：
            //    UI 的 ± 直接改的是对象本身，写反的量程会随 `keep` 活到下一轮。
            channels[p.id] = (keep[p.id] ?: autoChannel(p)).normalized()
        }
        AppLog.i(AppLog.M_OBD, "模拟信号通道已重建", "count=${channels.size}")
    }

    // ================================================================ 控制

    fun channels(): List<Channel> = channels.values.toList()

    fun channel(pidId: String): Channel? = channels[pidId]

    fun update(ch: Channel) {
        // 归一后入表：进来的通道量程写反也不会把坏区间带进 tick（v1.20.18）
        channels[ch.pidId] = ch.normalized()
    }

    /** 把某条通道恢复成自动配置 */
    fun resetToAuto(pidId: String) {
        Store.findPid(pidId)?.let { channels[pidId] = autoChannel(it).normalized() }
    }

    /**
     * 「快速演示」：所有通道改成**短周期 + 满量程**的来回扫描。
     *
     * ## 为什么需要它
     *
     * [autoChannel] 的参数是按「**像真车**」调的 —— 水温 40 秒才升完、车速 40 秒一个来回。
     * 那是为了看数据像不像真的，但拿来**调试仪表**就完全不合适：
     * 指针半天不动一点，「没啥感觉」，量程对不对、报警色会不会切、动画顺不顺都看不出来。
     *
     * 这个模式把周期压到 [DEMO_PERIOD_SEC] 秒、量程拉到 PID 的**满量程**，
     * 让每个表在几秒内扫完全程 —— 专门用来回答「这个表到底会不会动、动得对不对」。
     *
     * G 值三件套保持正弦（换成三角就不是圆了，轨迹会变成方块）。
     */
    fun applyDemoPreset() {
        Store.allPids().filter { it.enabled }.forEach { p ->
            channels[p.id] = demoChannel(p).normalized()
        }
        AppLog.i(AppLog.M_OBD, "模拟信号已切到快速演示", "channels=${channels.size} period=${DEMO_PERIOD_SEC}s")
    }

    /**
     * 快速演示下单条通道的配置。**抽成纯函数以便单测** ——
     * 「满量程」「短周期」这两条是这个模式存在的理由，写错了它就没意义了。
     */
    fun demoChannel(p: PidDefinition): Channel {
        val isG = p.id == "calc_gx" || p.id == "calc_gy" || p.id == "calc_gforce"
        // ⚠️ 量程**先归一**（v1.20.18）：PID 的 min/max 写反时（从 JSON 导入的配置
        // 没有 PidDraft 那层校验）不能让通道跟着反 —— 那是空 range 崩溃的另一条入口。
        val lo = minOf(p.minVal, p.maxVal)
        val hi = maxOf(p.minVal, p.maxVal)
        val span = (hi - lo).let { if (it <= 0f) 100f else it }
        // G 值必须保持正弦，换成三角轨迹就从圆变成方块了
        val wave = if (isG) WAVE_SINE else WAVE_TRIANGLE
        return if (p.id == "calc_gforce") {
            // 合力不能是负的，量程从 0 起
            Channel(p.id, wave = wave, periodSec = DEMO_PERIOD_SEC, min = 0f, max = span, noise = 0f)
        } else {
            Channel(
                p.id, wave = wave, periodSec = DEMO_PERIOD_SEC,
                min = lo, max = hi, noise = 0f
            )
        }
    }

    fun start() {
        if (running) return
        if (channels.isEmpty()) rebuildFromPids()
        if (channels.isEmpty()) {
            AppLog.w(AppLog.M_OBD, "模拟信号未启动：没有启用的 PID")
            return
        }
        startTs = System.currentTimeMillis()
        running = true
        main.post(ticker)
        AppLog.i(AppLog.M_OBD, "模拟信号已开启", "count=${channels.size} tick=${TICK_MS}ms")
    }

    fun stop() {
        if (!running) return
        running = false
        main.removeCallbacks(ticker)
        AppLog.i(AppLog.M_OBD, "模拟信号已停止")
    }

    /**
     * 推一轮合成值。
     * @param now 注入时间戳（便于单测；生产环境传 `System.currentTimeMillis()`）
     */
    fun tick(now: Long) {
        // G 值三件套特殊处理：gx / gy 用**同周期、相位差 90°** 的正弦，
        // 轨迹画出来是一个圆 —— 这正是真车绕桩时 G-G 图的形态，比三个通道各自
        // 独立发波形有辨识度得多。而且 gforce 必须由 gx/gy 算出来，
        // 否则「圆上的点」和「大小」对不上，一眼就看出是假的。
        val gx = channels["calc_gx"]
        val gy = channels["calc_gy"]
        val gf = channels["calc_gforce"]
        if (gx != null && gy != null && gx.enabled && gy.enabled) {
            val p = phaseAt(now, startTs, gx.periodSec)
            val x = valueOf(gx, p)
            val y = valueOf(gy, p + 0.25f)
            VehicleBus.put(PidValue(gx.pidId, x, SRC, now, true))
            VehicleBus.put(PidValue(gy.pidId, y, SRC, now, true))
            if (gf != null && gf.enabled) {
                VehicleBus.put(PidValue(gf.pidId, sqrt(x * x + y * y), SRC, now, true))
            }
        }

        channels.values.forEach { ch ->
            if (!ch.enabled) return@forEach
            // 这三条已在上面按圆轨迹处理过，不要再用独立波形覆盖
            if (ch.pidId == "calc_gx" || ch.pidId == "calc_gy" || ch.pidId == "calc_gforce") {
                return@forEach
            }
            val phase = phaseAt(now, startTs, ch.periodSec)
            VehicleBus.put(PidValue(ch.pidId, valueOf(ch, phase), SRC, now, true))
        }
    }

    /** 仅供单测：直接设起点 */
    internal fun setStartForTest(ts: Long) {
        startTs = ts
    }
}
