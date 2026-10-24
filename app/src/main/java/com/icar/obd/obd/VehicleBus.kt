package com.icar.obd.obd

import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.IdentityHashMap

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
    private val sourceLock = Any()
    private val sources = IdentityHashMap<Any, Source>()
    private val currentOwners = HashMap<String, Source>()
    private var nextEpoch = 0L

    /** 内存内的采集代际；不进入 PID/配置/设计 JSON，也不依赖 rawHex。 */
    internal class Source internal constructor(val owner: Any, val epoch: Long) {
        internal var closed = false
    }

    internal fun openSource(owner: Any): Source {
        val changed = ArrayList<PidValue>()
        val source = synchronized(sourceLock) {
            sources[owner]?.let { closeLocked(it, changed) }
            Source(owner, ++nextEpoch).also { sources[owner] = it }
        }
        notifyValues(changed)
        return source
    }

    internal fun sourceActive(source: Source): Boolean = synchronized(sourceLock) {
        !source.closed && sources[source.owner] === source
    }

    internal fun closeSource(source: Source) {
        val changed = ArrayList<PidValue>()
        synchronized(sourceLock) { closeLocked(source, changed) }
        notifyValues(changed)
    }

    private fun closeLocked(source: Source, changed: MutableList<PidValue>) {
        if (source.closed) return
        source.closed = true
        if (sources[source.owner] === source) sources.remove(source.owner)
        val iterator = currentOwners.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.value !== source) continue
            iterator.remove()
            values[entry.key]?.takeIf { it.ok }?.let { old ->
                old.copy(ok = false, error = "采集来源已停止").also {
                    values[entry.key] = it
                    changed.add(it)
                }
            }
        }
    }

    /** 关闭与发布同锁；已关闭的请求不能写当前值、历史或通知。累计里程可保留。 */
    internal fun put(source: Source, v: PidValue, retainOnClose: Boolean = false): Boolean {
        synchronized(sourceLock) {
            if (source.closed || sources[source.owner] !== source) return false
            if (retainOnClose) currentOwners.remove(v.pidId) else currentOwners[v.pidId] = source
            storeLocked(v)
        }
        notifyValues(listOf(v))
        return true
    }

    /** 每秒采样数，用于 UI 显示总线健康度 */
    @Volatile
    var sampleHz: Float = 0f

    @Volatile
    var lastError: String = ""

    fun put(v: PidValue) {
        synchronized(sourceLock) {
            // 旧调用者已成为该 PID 的当前来源，旧轮询关闭时不能再失效它。
            currentOwners.remove(v.pidId)
            storeLocked(v)
        }
        notifyValues(listOf(v))
    }

    private fun storeLocked(v: PidValue) {
        values[v.pidId] = v
        // 只有真实到达的值才进历史：否则线型图会被失败/NaN 打断成锯齿
        if (v.ok) pushHistory(v.pidId, v.value)
    }

    private fun notifyValues(changed: List<PidValue>) {
        changed.forEach { v -> valueListeners.forEach { runCatching { it(v) } } }
    }

    /**
     * **新鲜度判定（v1.20.7，S2）—— 取值入口的唯一权威。**
     *
     * ## 为什么放在这里
     *
     * 广播信号停发时**没人会来清掉总线里的最后一个值**。不在取值时判，
     * 仪表就会一直挂着"最后一次收到的那一个数字"，看起来和实时一样 ——
     * 这正是用户说的"被过期值骗"。
     *
     * ## 为什么"变成 `ok=false`"就够了（下游零改动，已核实）
     *
     * `VehicleBus.value()` 与 `DashRenderer` **都是 `ok` 才给值**：
     *  - 仪表 → 显示 `--`
     *  - 规则引擎（[com.icar.obd.obd.RuleEngine] 用 `snapshot()`/`value()`）→ 不误触发
     *  - CSV（`ObdController` 用 `snapshot()`）→ 记空
     *
     * 所以只要**三个入口都过这一关**，下游一行都不用改。`get()` / `value()` /
     * `snapshot()` 是全部入口 —— 漏掉任何一个都会留下一条"看得见旧值"的路。
     *
     * @param now 由调用方传入：一次快照里所有值用**同一个时刻**，
     *            免得遍历过程中时间在走，出现"同一次快照里两个值判据不同"
     */
    private fun fresh(v: PidValue, now: Long): PidValue {
        if (!v.ok || v.ttlMs <= 0) return v
        val age = now - v.ts
        return if (age <= v.ttlMs) v
        else v.copy(ok = false, error = "值已过期 ${age}ms > ttl ${v.ttlMs}ms")
    }

    fun get(id: String): PidValue? = values[id]?.let { fresh(it, System.currentTimeMillis()) }

    fun value(id: String): Float? = get(id)?.takeIf { it.ok }?.value

    fun snapshot(): Map<String, PidValue> {
        val now = System.currentTimeMillis()
        val out = HashMap<String, PidValue>(values.size)
        values.forEach { (k, v) -> out[k] = fresh(v, now) }
        return out
    }

    fun clear() {
        synchronized(sourceLock) {
            values.clear()
            currentOwners.clear()
            history.clear()
        }
        sampleHz = 0f
    }

    fun addValueListener(l: (PidValue) -> Unit): () -> Unit {
        valueListeners.add(l)
        // P5B-M05 阶段 H1：订阅计数（Debug 用）
        synchronized(listenerCountLock) { valueListenerAdds++ }
        return {
            valueListeners.remove(l)
            synchronized(listenerCountLock) { valueListenerRemoves++ }
        }
    }

    fun addEventListener(l: (String) -> Unit): () -> Unit {
        eventListeners.add(l)
        synchronized(listenerCountLock) { eventListenerAdds++ }
        return {
            eventListeners.remove(l)
            synchronized(listenerCountLock) { eventListenerRemoves++ }
        }
    }

    // ================================================================
    // P5B-M05 阶段 H1：**订阅数量统计**（任务 §十 H1 明确要求）
    //
    // ## 为什么需要它
    //
    // P5B-M04 用「5 轮主题切换后 Java 堆 −5,024K」作为监听器的证据 ——
    // 那是**间接**推断：堆下降只能说明"没有明显暴涨"，
    // 而**一个泄漏的监听器比一次 GC 释放的对象还小**，完全看不出来。
    //
    // 指令原话：「不能仅因为一次 GC 后 Heap 减少就判断不存在泄漏。」
    //
    // ## 做法：数"活着"的
    //
    // 不去数"加了几次减了几次"（那只证明调用配对），而是直接读
    // `valueListeners.size` —— 那是**当前真正还持有引用的闭包数**。
    //
    // 判据：建 Renderer → >0；销毁 → **精确回到 0**。
    // ================================================================

    private val listenerCountLock = Any()
    private var valueListenerAdds = 0
    private var valueListenerRemoves = 0
    private var eventListenerAdds = 0
    private var eventListenerRemoves = 0

    /** **当前存活的**值监听器数量（不是净增量）*/
    fun liveValueListenerCount(): Int = valueListeners.size

    /** 当前存活的事件监听器数量 */
    fun liveEventListenerCount(): Int = eventListeners.size

    /**
     * 订阅计数快照（给 Debug 探针/日志用）。
     *
     * @return `live` 当前存活数；`added`/`removed` 累计；`balanced` 是否配平
     */
    fun listenerStats(): Map<String, Int> = synchronized(listenerCountLock) {
        mapOf(
            "liveValue" to valueListeners.size,
            "liveEvent" to eventListeners.size,
            "valueAdded" to valueListenerAdds,
            "valueRemoved" to valueListenerRemoves,
            "eventAdded" to eventListenerAdds,
            "eventRemoved" to eventListenerRemoves,
        )
    }

    /** 订阅计数重置（仅供测试，避免跨用例累计）*/
    fun resetListenerStatsForTest() {
        synchronized(listenerCountLock) {
            valueListenerAdds = 0
            valueListenerRemoves = 0
            eventListenerAdds = 0
            eventListenerRemoves = 0
        }
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
        /**
         * 汽油密度，单位 **kg/L**。
         *
         * 0.745 kg/L（≈ 0.745 g/cm³）是汽油在常温下的常见值，随标号与温度有 ±2% 波动。
         * 用它做的是"质量流量 → 体积流量"的换算，属于估算：
         * 真正权威的是车直接给的 `015E`，本系数只用于车不支持 `01 5E` 时的 MAF 推算。
         */
        private const val GAS_DENSITY = 0.745

        /**
         * MAF `g/s` → 燃油 `L/h` 的换算系数。
         *
         * 推导（注意 0.745 是 kg/L，分子分母都按 g 算）：
         * ```
         * MAF[g/s] ÷ 745[g/L] = [L/s]
         * [L/s] × 3600[s/h]   = [L/h]
         * ⇒ 系数 = 3600 / 745 = 3.6 / 0.745
         * ```
         * 两种写法数学等价（分子分母同乘 1000）。
         *
         * 物理恒等式（不依赖具体密度取值）：**MAF = 745 g/s 时恰好 1 L/s = 3600 L/h**。
         * `FuelRateUnitRangeTest` 用这条交叉验证，防止有人改了密度却忘了改 3.6。
         */
        private const val G_S_TO_L_H = 3.6 / GAS_DENSITY

        /**
         * 燃油流量的**物理上界**（L/h），用于识别解析异常。
         *
         * 取 **3276.75** —— PID `01 5E` 的标准满量程：
         * 编码 `((256*A + B) / 20)`，`A=B=0xFF` 时 `65535 / 20 = 3276.75 L/h`。
         *
         * ⚠️ 曾经这里用的是写死的 **100**，没有任何依据 —— 而大排量全油门时
         * MAF 200 g/s 就≈966 L/h，中等排量提速 30 g/s 也≈145 L/h。
         * 越过 100 会被当成坏数据丢掉，进而把 `tripComplete` 永久置 false，
         * 用户表现为"平均油耗跑着跑着变成 `--` 再也不回来"（T-App-A2-MAF0）。
         */
        private const val FUEL_RATE_MAX_LH = 3276.75f

        // 累计项缺过一段数据就不能再冒充完整行程平均；只有重置可重新开始。
        private var tripComplete = true

        private fun input(readings: Map<String, PidValue>, id: String): PidValue? =
            readings[id]?.takeIf { it.ok && it.value.isFinite() }

        /** 输出不能比任一有 TTL 的输入活得更久；未知值仍通知订阅者清掉旧读数。 */
        private fun publish(
            put: (PidValue) -> Unit, id: String, result: Float?, now: Long,
            dependencies: List<PidValue> = emptyList()
        ) {
            val remaining = dependencies.filter { it.ttlMs > 0 }.minOfOrNull {
                it.ttlMs.toLong() - (now - it.ts).coerceAtLeast(0L)
            }
            val ok = result != null && result.isFinite() && (remaining == null || remaining > 0)
            put(PidValue(id, if (ok) result!! else Float.NaN, "calc", now, ok,
                error = if (ok) null else "派生输入无效或行程数据不完整",
                ttlMs = if (ok) (remaining ?: 0L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt() else 0))
        }

        private fun invalidateAverage(put: (PidValue) -> Unit, now: Long) {
            publish(put, "calc_avg_l100", null, now)
            publish(put, "calc_range", null, now)
        }

        fun computeAll(put: (PidValue) -> Unit) {
            val now = System.currentTimeMillis()
            val readings = snapshot()
            val maf = input(readings, "std_10")
            val speed = input(readings, "std_0D")
            val fuelRate = input(readings, "std_5E")
            val map = input(readings, "std_0B")
            val baro = input(readings, "std_33")

            // 燃油流量 L/h：优先用 015E，否则由 MAF 推算
            //
            // ⚠️⚠️ **不能写 `takeIf { it.value > 0f }`**（T-App-A2-MAF0 修的就是这个）。
            //
            // `input()` 的语义是 `ok && isFinite` —— **0 是合法值**。
            // 再加一个 `> 0` 的阈值等于把"车真的没在烧油"（滑行/断火/断油）
            // 当成"没有读数"，后果分两档：
            //
            //   1. MAF 也没有 → `calc_lh` 变成未知 → 仪表显示 `--`（本该显示 0）
            //   2. MAF 有值     → **改用 MAF 推算，凭空造出一个油耗**，
            //      而车上明明有更权威的 `015E=0` → 累计用油虚增，用户无从察觉
            //
            // MAF 的 `> 0.5f` 是同类问题：`0 g/s` 进气 ⇔ `0 L/h` 燃油，是有效读数。
            //
            // 判据统一为：**只要 `input()` 认为有效（ok 且有限）就用它，包括 0**。
            // "失效"与"0"是两件事 —— 失效由 `ok=false` 表达，不该靠数值阈值猜测。
            val fuelSource = fuelRate ?: maf
            val lh = when (fuelSource) {
                null -> null
                fuelRate -> fuelSource.value
                else -> (fuelSource.value * G_S_TO_L_H).toFloat()
            }
            val fuelDependencies = listOfNotNull(fuelSource)
            publish(put, "calc_lh", lh, now, fuelDependencies)

            // 瞬时油耗 L/100km：需要车速 > 3km/h，否则怠速油耗无意义
            val instantaneous = if (lh != null && lh.isFinite() && speed != null) {
                (if (speed.value < 3f) 0f else lh / speed.value * 100f).coerceIn(0f, 99f)
            } else null
            publish(put, "calc_l100", instantaneous, now, fuelDependencies + listOfNotNull(speed))

            // 增压压力 = MAP - 大气压
            publish(put, "calc_boost", if (map != null && baro != null) map.value - baro.value else null,
                now, listOfNotNull(map, baro))

            // 续航里程 = 油量% × 油箱容量 ÷ 平均油耗 × 100
            //
            // ⚠️ **三个前提缺一不可**：油量（`std_2F`，部分车不支持）、
            // 油箱容量（用户设置）、平均油耗（要跑够 0.5km 才有）。
            // 缺任何一个都**明确标未知** —— 猜一个会让续航"看起来像真的但差很多"，
            // 比仪表显示 `--` 更糟（用户会按它规划加油）。
            val fuelPct = input(readings, "std_2F")
            val avgL100 = input(readings, "calc_avg_l100")
            val tank = Store.settings.tankCapacityL
            val range = if (fuelPct != null && avgL100 != null && avgL100.value > 0.1f && tank.isFinite() && tank > 0f) {
                val liters = fuelPct.value.coerceIn(0f, 100f) / 100f * tank
                (liters / avgL100.value * 100f).coerceIn(0f, 1200f)
            } else null
            publish(put, "calc_range", range, now, listOfNotNull(fuelPct, avgL100))
        }

        /**
         * 行程积分：里程（车速积分）+ **平均油耗**（油量积分 ÷ 里程）。引擎每轮调用一次。
         *
         * ## 为什么平均油耗放在这里而不是 [computeAll]
         *
         * 它需要 `dt` 才能把「L/h」积成「L」，而 `computeAll` 没有 dt（它算的是瞬时量）。
         * 放在同一个 `dt` 里也让**里程与油量的时间基准一致** ——
         * 两边用不同的 dt，平均油耗会慢慢漂。
         */
        fun integrateDistance(dtSeconds: Float, put: (PidValue) -> Unit) {
            val now = System.currentTimeMillis()
            val readings = snapshot()
            val speed = input(readings, "std_0D")
            if (!dtSeconds.isFinite() || dtSeconds <= 0f || speed == null || speed.value !in 0f..400f) {
                tripComplete = false
                invalidateAverage(put, now)
                return
            }
            val km = accKm + if (speed.value >= 0.5f) speed.value * dtSeconds / 3600f else 0f
            if (!km.isFinite()) {
                tripComplete = false
                invalidateAverage(put, now)
                return
            }
            accKm = km
            publish(put, "calc_km", km, now)

            // 油量积分：L/h × 小时 = L。`calc_lh` 要么来自 015E，要么由 MAF 推算
            //
            // ⚠️⚠️ **上界不能用 100**（T-App-A2-MAF0 修的就是这个）。
            //
            // 原来写的是 `takeIf { it.value in 0f..100f }`，但 PID 5E 的标准满量程是
            // **3276.75 L/h**（`((256A+B)/20)`）。真实场景轻松越过 100：
            //   · 大排量全油门：MAF 200 g/s ≈ 966 L/h
            //   · 中等排量提速：MAF 30 g/s ≈ 145 L/h
            //
            // 被丢掉的后果不是"这一次不算"，而是 `tripComplete = false` ——
            // **整个行程的平均油耗从此永久失效**，只能靠 `resetTrip()` 恢复。
            // 用户看到的现象是"跑着跑着平均油耗变成 `--` 了，再也不回来"。
            //
            // 现在按 **PID 5E 的物理满量程**卡上界：超出才说明解析异常，宁可让行程失效
            // 也不要把坏数据积进去。下界仍是 0（负油耗不可能）。
            val fuel = input(readings, "calc_lh")?.takeIf { it.value in 0f..FUEL_RATE_MAX_LH }
            val liters = fuel?.let { accLiters + it.value * dtSeconds / 3600f }
            if (liters != null && liters.isFinite()) accLiters = liters else tripComplete = false

            // ⚠️ **里程太短时不出值**：0.2km 上用了 0.05L 会算出 25L/100km 这种噪声，
            // 一上路就显示"25 个油"比先显示 `--` 更糟。
            if (tripComplete && km >= MIN_AVG_KM) {
                publish(put, "calc_avg_l100", (accLiters / km * 100f).coerceIn(0f, 99f),
                    now, listOfNotNull(speed, fuel))
            } else invalidateAverage(put, now)
        }

        /** 累计里程（km）—— 同时就是「本次行程」的里程 */
        @Volatile
        var accKm: Float = 0f
            private set

        /** 累计用油（L）。与 [accKm] 同一时间基准 */
        @Volatile
        var accLiters: Float = 0f
            private set

        /**
         * 清零行程累计（里程 + 用油）。
         *
         * 两者**必须一起清** —— 只清里程会让平均油耗瞬间跳到天上
         * （分子还是老的累计油量，分母变 0）。
         */
        fun resetTrip() {
            accKm = 0f
            accLiters = 0f
            tripComplete = true
            val now = System.currentTimeMillis()
            publish(VehicleBus::put, "calc_km", 0f, now)
            invalidateAverage(VehicleBus::put, now)
        }

        /** 平均油耗至少要有这么长的里程才出值（避免短里程噪声） */
        private const val MIN_AVG_KM = 0.5f
    }
}
