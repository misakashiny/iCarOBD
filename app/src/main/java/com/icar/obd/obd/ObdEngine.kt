package com.icar.obd.obd

import com.icar.obd.data.AppLog
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * 轮询引擎：把「启用的 PID 列表」变成「车辆总线上持续更新的数值流」。
 *
 * 设计要点（这些点决定了它能否在真实车上长时间稳定运行）：
 *  1. **单请求串行**：ELM327 是半双工串口，任何并发请求都会互相污染响应。
 *  2. **按 PID 独立周期**：RPM/车速这类要快，水温/油温这类可以慢，避免总线被打满。
 *  3. **失败退避**：某条 PID 连续失败 N 次后进入冷却，不再每轮都占用总线。
 *  4. **可中断**：stop() 立即取消，不留下悬挂的串口请求。
 */
class ObdEngine(private val session: ElmSession) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    /** 当前生效的 PID 列表（已过滤掉 CALC 派生通道与未启用项） */
    @Volatile
    var activePids: List<PidDefinition> = emptyList()
        private set

    @Volatile
    var running: Boolean = false
        private set

    /** 每条 PID 的失败计数与冷却截止时间 */
    private val failStreak = ConcurrentHashMap<String, Int>()
    private val cooldownUntil = ConcurrentHashMap<String, Long>()

    private val nextDue = ConcurrentHashMap<String, Long>()

    /** 统计窗口 */
    private var sampleCount = 0L
    private var windowStart = 0L

    // ---- 总线负载保护 ----
    /** 最近若干次请求的成功与否，用于估算失败率 */
    private val recentResults = ArrayDeque<Boolean>()

    /** 当前整体降频倍率（1.0 = 不降频） */
    @Volatile
    private var backoff = 1f

    /** 每轮结束后的回调（供规则引擎 / CSV 记录器挂钩），在 IO 线程调用 */
    var onCycle: (() -> Unit)? = null

    companion object {
        /** 连续失败多少次进入冷却 */
        private const val MAX_FAIL = 4
        /** 冷却时长 */
        private const val COOLDOWN_MS = 30_000L
        /** 单条请求的最短超时 */
        private const val MIN_TIMEOUT = 600L
        /** 轮询间隔下限（ms）。再快只会把总线打满，拿不到更多有效数据 */
        private const val MIN_INTERVAL_MS = 30
        /** 负载保护窗口：看最近多少次请求 */
        private const val LOAD_WINDOW = 30
        /** 失败率超过这个比例就整体降频 */
        private const val LOAD_FAIL_RATIO = 0.5f
        /** 每次降频 / 恢复的步进 */
        private const val BACKOFF_STEP = 1.5f
        /** 降频上限 */
        private const val BACKOFF_MAX = 4f
    }

    /**
     * 总线负载保护。
     *
     * 动机：车况差 / 适配器质量差 / 协议没协商对时，请求会大面积超时。
     * 这时**继续按原频率猛发只会让情况更糟**（总线被占满，连原本能通的请求也超时）。
     * 这里按最近 [LOAD_WINDOW] 次的失败率整体降频，恢复后再自动还原。
     *
     * 注意它**不替代**单条 PID 的失败冷却（[cooldownUntil]）：那是「这条 PID 不行，先别问它」，
     * 这里是「整条链路都不太对，大家都慢一点」。
     */
    private fun noteResult(ok: Boolean) {
        synchronized(recentResults) {
            recentResults.addLast(ok)
            while (recentResults.size > LOAD_WINDOW) recentResults.removeFirst()
            if (recentResults.size < LOAD_WINDOW) return

            val failRatio = recentResults.count { !it }.toFloat() / recentResults.size
            if (failRatio >= LOAD_FAIL_RATIO) {
                val next = (backoff * BACKOFF_STEP).coerceAtMost(BACKOFF_MAX)
                if (next != backoff) {
                    backoff = next
                    AppLog.w(
                        AppLog.M_OBD, "总线负载保护：整体降频",
                        "失败率=${(failRatio * 100).toInt()}% 倍率=${backoff}x"
                    )
                }
                recentResults.clear()
            } else if (failRatio <= 0.1f && backoff > 1f) {
                backoff = (backoff / BACKOFF_STEP).coerceAtLeast(1f)
                AppLog.i(AppLog.M_OBD, "总线负载恢复", "倍率=${backoff}x")
                recentResults.clear()
            }
        }
    }

    fun reload() {
        val all = Store.allPids().filter { it.enabled && !it.mode.equals("CALC", true) }
        activePids = all
        nextDue.keys.retainAll(all.map { it.id }.toSet())
        AppLog.i(AppLog.M_OBD, "轮询列表已刷新", "count=${all.size} ids=${all.joinToString(",") { it.id }}")
    }

    fun start() {
        if (running) return
        reload()
        if (activePids.isEmpty()) {
            AppLog.w(AppLog.M_OBD, "无启用的 PID，轮询未启动")
            return
        }
        running = true
        windowStart = System.currentTimeMillis()
        sampleCount = 0
        job = scope.launch { loop() }
        AppLog.i(AppLog.M_OBD, "轮询启动", "interval=${Store.settings.pollIntervalMs}ms")
    }

    fun stop() {
        if (!running) return
        running = false
        job?.cancel()
        job = null
        VehicleBus.sampleHz = 0f
        AppLog.i(AppLog.M_OBD, "轮询停止")
    }

    private suspend fun loop() {
        var lastIntegrate = System.currentTimeMillis()
        while (scope.isActive && running) {
            val now = System.currentTimeMillis()
            val due = activePids.filter { pid ->
                (nextDue[pid.id] ?: 0L) <= now && (cooldownUntil[pid.id] ?: 0L) <= now
            }
            if (due.isEmpty()) {
                delay(20)
                continue
            }

            for (pid in due) {
                if (!running || !scope.isActive) return
                // 单独设了间隔就以它为准；否则用「全局间隔 × 优先级倍率」，再乘负载保护倍率
                val base = if (pid.intervalMs > 0) {
                    pid.intervalMs
                } else {
                    (Store.settings.pollIntervalMs * PidDefinition.priorityScale(pid.priority)).toInt()
                }
                val interval = (base * backoff).toInt().coerceAtLeast(MIN_INTERVAL_MS).toLong()
                nextDue[pid.id] = System.currentTimeMillis() + interval

                val timeout = (interval * 2).coerceAtLeast(MIN_TIMEOUT)
                val raw = session.request(pid.requestString(), timeout)
                val res = ObdProtocol.parse(raw, pid)
                noteResult(res.ok)

                // 先把值取到局部变量再判空 —— `res.value` 是**跨模块**的 `var` 属性，
                // Kotlin 不允许对它做智能转换（`Smart cast to 'Float' is impossible`）。
                // 这不是新问题，只是 data/ 重新编译时才会暴露出来。
                val value = res.value
                if (res.ok && value != null) {
                    failStreak.remove(pid.id)
                    VehicleBus.put(PidValue(pid.id, value, res.data.toHex(), System.currentTimeMillis(), true))
                    sampleCount++
                } else {
                    val n = (failStreak[pid.id] ?: 0) + 1
                    failStreak[pid.id] = n
                    VehicleBus.put(
                        PidValue(pid.id, Float.NaN, "", System.currentTimeMillis(), false, res.error)
                    )
                    if (n >= MAX_FAIL) {
                        cooldownUntil[pid.id] = System.currentTimeMillis() + COOLDOWN_MS
                        AppLog.w(
                            AppLog.M_OBD, "PID 连续失败进入冷却",
                            "id=${pid.id} name=${pid.name} n=$n cooldown=${COOLDOWN_MS}ms err=${res.error}"
                        )
                    }
                }
            }

            // 派生通道（瞬时油耗 / 燃油流量 / 增压等）每轮重算
            VehicleBus.Derived.computeAll { VehicleBus.put(it) }

            // 里程积分：用真实经过时间，避免调度抖动累积误差
            val t = System.currentTimeMillis()
            val dt = (t - lastIntegrate) / 1000f
            if (dt > 0.05f) {
                VehicleBus.Derived.integrateDistance(dt) { VehicleBus.put(it) }
                lastIntegrate = t
            }

            // 每秒刷新一次采样率，作为「总线健康度」指标
            if (t - windowStart >= 1000) {
                VehicleBus.sampleHz = sampleCount * 1000f / (t - windowStart)
                sampleCount = 0
                windowStart = t
            }

            runCatching { onCycle?.invoke() }
                .onFailure { AppLog.e(AppLog.M_OBD, "轮询回调异常", it.message ?: "") }
        }
    }

    private fun ByteArray.toHex(): String =
        joinToString(" ") { String.format("%02X", it.toInt() and 0xFF) }
}
