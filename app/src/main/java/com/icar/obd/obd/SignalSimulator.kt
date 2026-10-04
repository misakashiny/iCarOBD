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
    )

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
            tick(System.currentTimeMillis())
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

    /** 通道在给定相位的输出值（含噪声，夹在 min..max） */
    fun valueOf(ch: Channel, phase: Float): Float {
        val n = waveAt(ch.wave, phase)
        val base = ch.min + (ch.max - ch.min) * n
        if (ch.noise <= 0f) return base.coerceIn(ch.min, ch.max)
        val jitter = (Random.nextFloat() - 0.5f) * 2f * ch.noise * (ch.max - ch.min)
        return (base + jitter).coerceIn(ch.min, ch.max)
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
            channels[p.id] = keep[p.id] ?: autoChannel(p)
        }
        AppLog.i(AppLog.M_OBD, "模拟信号通道已重建", "count=${channels.size}")
    }

    // ================================================================ 控制

    fun channels(): List<Channel> = channels.values.toList()

    fun channel(pidId: String): Channel? = channels[pidId]

    fun update(ch: Channel) {
        channels[ch.pidId] = ch
    }

    /** 把某条通道恢复成自动配置 */
    fun resetToAuto(pidId: String) {
        Store.findPid(pidId)?.let { channels[pidId] = autoChannel(it) }
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
            channels[p.id] = demoChannel(p)
        }
        AppLog.i(AppLog.M_OBD, "模拟信号已切到快速演示", "channels=${channels.size} period=${DEMO_PERIOD_SEC}s")
    }

    /**
     * 快速演示下单条通道的配置。**抽成纯函数以便单测** ——
     * 「满量程」「短周期」这两条是这个模式存在的理由，写错了它就没意义了。
     */
    fun demoChannel(p: PidDefinition): Channel {
        val isG = p.id == "calc_gx" || p.id == "calc_gy" || p.id == "calc_gforce"
        val span = (p.maxVal - p.minVal).let { if (it <= 0f) 100f else it }
        // G 值必须保持正弦，换成三角轨迹就从圆变成方块了
        val wave = if (isG) WAVE_SINE else WAVE_TRIANGLE
        return if (p.id == "calc_gforce") {
            // 合力不能是负的，量程从 0 起
            Channel(p.id, wave = wave, periodSec = DEMO_PERIOD_SEC, min = 0f, max = span, noise = 0f)
        } else {
            Channel(
                p.id, wave = wave, periodSec = DEMO_PERIOD_SEC,
                min = p.minVal, max = p.maxVal, noise = 0f
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
