package com.icar.obd.obd

import com.icar.obd.data.PidValue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 车辆数据总线。
 *
 * 这是「数据层」与「渲染层」之间的唯一接口：
 * 引擎往里写，仪表盘/规则引擎/日志器从里读。
 * 渲染层不认识 BLE，也不认识 ELM327。
 */
object VehicleBus {

    /** 单值变更回调（高频，UI 按 pidId 分发，避免整体刷新） */
    private val valueListeners = CopyOnWriteArrayList<(PidValue) -> Unit>()

    /** 连接/状态类回调 */
    private val eventListeners = CopyOnWriteArrayList<(String) -> Unit>()

    private val values = ConcurrentHashMap<String, PidValue>()

    /** 每秒采样数，用于 UI 显示总线健康度 */
    @Volatile
    var sampleHz: Float = 0f

    @Volatile
    var lastError: String = ""

    fun put(v: PidValue) {
        values[v.pidId] = v
        // 只有真实到达的值才进历史：否则线型图会被失败/NaN 打断成锯齿
        if (v.ok) pushHistory(v.pidId, v.value)
        valueListeners.forEach { runCatching { it(v) } }
    }

    fun get(id: String): PidValue? = values[id]

    fun value(id: String): Float? = values[id]?.takeIf { it.ok }?.value

    fun snapshot(): Map<String, PidValue> = HashMap(values)

    fun clear() {
        values.clear()
        history.clear()
        sampleHz = 0f
    }

    fun addValueListener(l: (PidValue) -> Unit): () -> Unit {
        valueListeners.add(l)
        return { valueListeners.remove(l) }
    }

    fun addEventListener(l: (String) -> Unit): () -> Unit {
        eventListeners.add(l)
        return { eventListeners.remove(l) }
    }

    fun emit(msg: String) {
        eventListeners.forEach { runCatching { it(msg) } }
    }

    // ------------------------------------------------------------ 历史缓冲

    /** 每个通道保留的最近采样点数。5Hz × 150 ≈ 30 秒的曲线 */
    const val HISTORY_SIZE = 150

    private val history = ConcurrentHashMap<String, ArrayDeque<Float>>()

    /**
     * 记录一次采样，供线型图读取。
     *
     * 刻意做成**有界环形**（超出丢最旧）：长时间行车不能无限增长。
     * 内存代价：150 个 Float × 通道数，可忽略。
     */
    private fun pushHistory(id: String, v: Float) {
        if (v.isNaN() || v.isInfinite()) return
        val dq = history.getOrPut(id) { ArrayDeque(HISTORY_SIZE) }
        synchronized(dq) {
            if (dq.size >= HISTORY_SIZE) dq.removeFirst()
            dq.addLast(v)
        }
    }

    /** 最近的历史采样（旧 → 新）。没有数据时返回空列表，调用方不必判空。 */
    fun historyOf(id: String): List<Float> {
        val dq = history[id] ?: return emptyList()
        synchronized(dq) { return ArrayList(dq) }
    }

    // ------------------------------------------------------------ 派生通道

    /**
     * 由其它通道实时计算的量。
     * 汽油密度取 0.745 kg/L，因此 g/s → L/h 的系数为 3.6/0.745 ≈ 4.83。
     */
    object Derived {
        private const val GAS_DENSITY = 0.745
        private const val G_S_TO_L_H = 3.6 / GAS_DENSITY

        fun computeAll(put: (PidValue) -> Unit) {
            val now = System.currentTimeMillis()
            val maf = value("std_10")
            val speed = value("std_0D")
            val fuelRate = value("std_5E")
            val map = value("std_0B")
            val baro = value("std_33")

            // 燃油流量 L/h：优先用 015E，否则由 MAF 推算
            val lh: Float? = when {
                fuelRate != null && fuelRate > 0f -> fuelRate
                maf != null && maf > 0.5f -> (maf * G_S_TO_L_H).toFloat()
                else -> null
            }
            if (lh != null) put(PidValue("calc_lh", lh, "calc", now, true))

            // 瞬时油耗 L/100km：需要车速 > 3km/h，否则怠速油耗无意义
            if (lh != null && speed != null) {
                val v = if (speed < 3f) 0f else (lh / speed * 100f)
                put(PidValue("calc_l100", v.coerceIn(0f, 99f), "calc", now, true))
            }

            // 增压压力 = MAP - 大气压
            if (map != null && baro != null) {
                put(PidValue("calc_boost", map - baro, "calc", now, true))
            }
        }

        /** 里程积分（km），由车速积分得到，引擎每轮调用一次 */
        fun integrateDistance(dtSeconds: Float, put: (PidValue) -> Unit) {
            val speed = value("std_0D") ?: return
            var km = accKm
            if (speed in 0.5f..400f) km += speed * dtSeconds / 3600f
            accKm = km
            put(PidValue("calc_km", km, "calc", System.currentTimeMillis(), true))
        }

        @Volatile
        var accKm: Float = 0f
            private set
    }
}
