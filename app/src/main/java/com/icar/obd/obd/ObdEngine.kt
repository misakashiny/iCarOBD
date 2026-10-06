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

    // ---------------------------------------------------------------- 可观测性
    //
    // 背景：2026-10-05 的实车排障发现 **App 从不记录成功的数值** ——
    // 失败会大声记，成功一个字都不记。于是"到底有没有解析成数值"
    // 从日志里看不出来，只能靠人肉读 TX/RX。
    //
    // ⚠️ 但**不能每条都记**（见 [SUMMARY_MS]）。所以只做两件事：
    //   1. 每条 PID **第一次**成功时报一行（上限 = PID 条数，约 20 行）
    //   2. 每 [SUMMARY_MS] 报一行**汇总**（有值几个 + 当前读数）

    /** 已经报过「首次拿到数值」的 PID。每条只报一次，避免刷屏 */
    private val reportedFirst = ConcurrentHashMap.newKeySet<String>()

    /** 最近一次成功的数值（汇总用）。键是 pid id */
    private val lastValues = ConcurrentHashMap<String, Float>()

    /** 上次汇总时间 */
    private var lastSummaryAt = 0L

    /** 距上次成功已经发了多少次请求（链路自检用，见 [DEAD_LINK_REQUESTS]） */
    private var requestsSinceSuccess = 0

    /** 当前生效的 CAN 模块头（`AT SH` 是粘性的，必须自己记账，见 [ObdProtocol.headerSwitch]） */
    private var currentHeader = ObdProtocol.DEFAULT_HEADER

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

        /**
         * 「轮询汇总」的间隔（ms）。
         *
         * ⚠️ **必须是低频**：轮询是 ~8Hz × 20 条 PID，**每条都记一行会重演
         * v1.3.0 那场事故**（2 小时刷出 113 万行 / 57.9MB，把日志页一起拖崩）。
         * `AppLog` 的四条自我保护挡的是"异常路径刷屏"，
         * **正常路径的刷屏它挡不住**（每条内容都不一样，去重用不上）。
         *
         * 30 秒 = 每小时 120 行，可忽略。
         *
         * 故意**不是 private**：有一条用例钉着"这个间隔不许调小"
         * （见 `ObdEngineLoggingTest`），否则下一个想"看得更勤"的人会把它改成 1 秒。
         */
        const val SUMMARY_MS = 30_000L

        /**
         * 连续这么多次请求**一次都没成功**，就判定链路不可用并停掉轮询。
         *
         * 为什么需要（2026-10-06 实测）：v1.17.6 改成"`ok=false` 也启动轮询"之后，
         * **传输层还在、但写不进去**的情况会一直空转 ——
         * 1 小时刷出 **902 条 E + 1691 条 W**（占整份日志 67%），而**一条有效数据都没有**。
         *
         * 60 次 ≈ 3 轮（每轮约 20 条 PID）× 120ms ≈ 十几秒，
         * 够长到不会误杀"刚连上还在协商"的正常情况，也够短到不让日志爆掉。
         *
         * 故意**不是 private**：有用例钉着它的合理区间（见 `ObdEngineLoggingTest`）。
         */
        const val DEAD_LINK_REQUESTS = 60
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
        // 排除两类：`CALC`（计算派生）与 `monitor`（监听型，由 FrameMonitor 喂值）。
        // 监听型要是进了轮询列表，会对着一个**只存在于广播帧里**的地址发请求，
        // 每次都超时 —— 既污染总线，又让「轮询汇总」的"有值 N/M"变难看。
        val all = Store.allPids().filter {
            it.enabled && !it.mode.equals("CALC", true) && !it.source.equals("monitor", true)
        }
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
        // 每轮重新统计「首次拿到数值」：否则第二次连接时第一行永远不出现
        reportedFirst.clear()
        lastValues.clear()
        lastSummaryAt = System.currentTimeMillis()
        requestsSinceSuccess = 0
        // 复位模块头记账：新一轮轮询开始时，适配器实际停在哪个头是未知的 ——
        // 记成默认广播，第一条需要别的头的 PID 就会自动切过去
        currentHeader = ObdProtocol.DEFAULT_HEADER
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
                // 模块头切换（v1.18.2）：`AT SH` 是**粘性**的 ——
                // 厂家 PID 切到 `7E0`/`760` 之后，**标准 PID 必须显式切回广播**，
                // 否则它会被发到那个模块去，读到别的模块的值而**看不出来**。
                ObdProtocol.headerSwitch(currentHeader, pid.header)?.let { cmd ->
                    currentHeader = pid.header.trim().uppercase()
                        .ifBlank { ObdProtocol.DEFAULT_HEADER }
                    session.request(cmd, MIN_TIMEOUT)
                }
                val raw = session.request(pid.requestString(), timeout)
                val res = ObdProtocol.parse(raw, pid)
                noteResult(res.ok)

                // 先把值取到局部变量再判空 —— `res.value` 是**跨模块**的 `var` 属性，
                // Kotlin 不允许对它做智能转换（`Smart cast to 'Float' is impossible`）。
                // 这不是新问题，只是 data/ 重新编译时才会暴露出来。
                val value = res.value
                if (res.ok && value != null) {
                    failStreak.remove(pid.id)
                    requestsSinceSuccess = 0
                    VehicleBus.put(PidValue(pid.id, value, res.data.toHex(), System.currentTimeMillis(), true))
                    sampleCount++
                    lastValues[pid.id] = value
                    // 每条 PID 只报**第一次**成功 —— 上限就是 PID 条数（约 20 行），
                    // 但足以回答"这条链路到底出没出过数"
                    if (reportedFirst.add(pid.id)) {
                        AppLog.i(
                            AppLog.M_OBD, "首次拿到数值",
                            "id=${pid.id} name=${pid.name} value=${fmtValue(value)}${pid.unit}"
                        )
                    }
                } else {
                    val n = (failStreak[pid.id] ?: 0) + 1
                    failStreak[pid.id] = n
                    requestsSinceSuccess++
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

            // ---- 链路自检：连续 N 次请求**一次都没成功** → 停掉轮询
            //
            // 为什么要有这一步：v1.17.6 改成"`ok=false` 也启动轮询"是为了不让**假阴性**
            // 把整条路堵死，但那只在"链路真的通"的前提下成立。
            // **传输层还在、写不进去**时（实测 2026-10-06）会一直空转刷日志。
            // 停掉比空转好：日志干净了，用户也能从"已停止"这条直接明白链路有问题。
            if (requestsSinceSuccess >= DEAD_LINK_REQUESTS) {
                AppLog.w(
                    AppLog.M_OBD,
                    "连续 $DEAD_LINK_REQUESTS 次请求无一成功，已停止轮询",
                    "链路可能不可用（适配器未上电 / 写入被拒 / 协议不对）。" +
                        "修好后重新点「初始化 ELM327」"
                )
                running = false
                return
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

            // 周期汇总：**有值几个 + 当前读数**。
            //
            // 这一行是"数据到底通没通"最直接的判据 —— 失败路径本来就一直在报，
            // 缺的正是**成功路径的可见性**（2026-10-05 排障时卡住的地方）。
            // 低频是刻意的，见 [SUMMARY_MS]。
            if (t - lastSummaryAt >= SUMMARY_MS) {
                lastSummaryAt = t
                val parts = activePids.mapNotNull { p ->
                    lastValues[p.id]?.let { "${p.name}=${fmtValue(it)}${p.unit}" }
                }
                if (parts.isEmpty()) {
                    AppLog.w(
                        AppLog.M_OBD, "轮询汇总",
                        "有值 0/${activePids.size} —— 一条都没成功过（原因看上面的失败行）"
                    )
                } else {
                    AppLog.i(
                        AppLog.M_OBD, "轮询汇总",
                        "有值 ${parts.size}/${activePids.size} | ${parts.joinToString(" ")}"
                    )
                }
            }

            runCatching { onCycle?.invoke() }
                .onFailure { AppLog.e(AppLog.M_OBD, "轮询回调异常", it.message ?: "") }
        }
    }

    private fun ByteArray.toHex(): String =
        joinToString(" ") { String.format("%02X", it.toInt() and 0xFF) }

    /** 汇总用的紧凑数值格式：整数不拖小数点，非有限值给 `--` */
    private fun fmtValue(v: Float): String = when {
        !v.isFinite() -> "--"
        v == v.toInt().toFloat() -> v.toInt().toString()
        else -> String.format("%.1f", v)
    }
}
