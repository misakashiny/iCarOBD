package com.icar.obd.sim

import android.util.Log
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.SignalSimulator

/**
 * 离线 PID 模拟数据源（P5A-M02 阶段 B 重构版）。
 *
 * ## 为什么要重写（P5A-M01 版的问题）
 *
 * M01 版用 `VehicleBus.put(v)`（**无来源版本**）注入。那个方法内部会
 *
 * ```kotlin
 * currentOwners.remove(v.pidId)   // 把该 PID 从「谁在采」表里摘掉
 * ```
 *
 * 后果（实测见 `VehicleBusSourceSemanticsTest`）：
 *
 * 1. 模拟值**无法被正确失效** —— 真实采集关闭时 `closeSource` 找不到归属，
 *    于是留下一个 `ok=true` 的陈旧值，仪表继续显示「像实时」的数字。
 * 2. 归属被摘掉之后，`openSource` 的 epoch 保护对这条 PID 失效。
 *
 * ## 现在怎么做
 *
 * **复用项目自 v1.5.0 就有的 [SignalSimulator]**（`openSource` + `put(source,v)`），
 * 本类只负责两件事：
 *
 * 1. **场景 → 通道配置**：把 `normal/accel/alarm/...` 翻译成
 *    `SignalSimulator.Channel`（常量波形 = 固定值）。
 * 2. **严格互斥**：开模拟前先停真实轮询，关模拟后按需恢复；
 *    运行期有看门狗，一旦发现真实轮询起来了就**自动退让**。
 *
 * 这样归属语义、失效语义、TTL 全部由既有机制保证，**生产代码零改动**。
 *
 * ## 与真实 OBD 的关系（严格互斥，默认关闭）
 *
 * - 默认**不启用**，必须显式 `enable()` 或 adb 广播
 * - 启用时先 `ObdController.engine.stop()`
 * - 关闭时 `SignalSimulator.stop()` → `closeSource` → 所有模拟值变
 *   `ok=false, error="采集来源已停止"`，仪表回落 `--`
 * - 若之前真实轮询在跑，关闭后自动 `startPolling()` 恢复
 * - 看门狗每 2 秒检查：`enabled && engine.running` → 自动 `disable()`
 *
 * ## 隔离
 *
 * 本文件在 `app/src/debug/` —— Release 变体不编译。生产代码一行未改。
 */
object SimPidSource {

    private const val TAG = "SimPidSource"

    /** 看门狗间隔：真实轮询起来后最多这么久模拟就退让 */
    private const val WATCHDOG_MS = 2000L

    @Volatile
    var enabled: Boolean = false
        private set

    @Volatile
    var scenario: SimScenario = SimScenario.NORMAL
        private set

    @Volatile
    var tick: Int = 0
        private set

    /** 开模拟之前真实轮询是否在跑（关闭时按需恢复） */
    @Volatile
    private var engineWasRunning = false

    /** 上一次互斥退让的原因（供 UI / 日志查询） */
    @Volatile
    var lastYieldReason: String = ""
        private set

    private var watchdog: Runnable? = null
    private var watchdogHandler: android.os.Handler? = null
    private var extraPids: List<String> = emptyList()

    // ============================================================ 生命周期

    /**
     * 启用模拟。
     *
     * @return 是否真的起来了（拿不到可用 PID 时会返回 false）
     */
    fun enable(s: SimScenario = SimScenario.NORMAL, extra: List<String> = emptyList()): Boolean {
        scenario = s
        extraPids = extra
        tick = 0
        lastYieldReason = ""

        // ---- 1. 严格互斥：先停真实轮询，否则两个来源会交替写同一 PID、画面来回跳 ----
        engineWasRunning = runCatching { ObdController.engine.running }.getOrDefault(false)
        if (engineWasRunning) {
            runCatching { ObdController.engine.stop() }
                .onFailure { Log.w(TAG, "停真实轮询失败", it) }
            Log.i(TAG, "互斥：已停止真实轮询，改由模拟源供数")
        }

        // ---- 2. 按当前启用的 PID 重建通道 ----
        SignalSimulator.rebuildFromPids()

        // ---- 3. 应用场景（写通道配置）----
        applyScenario(s)

        // ---- 4. 启动（内部 openSource + put(source,v)）----
        SignalSimulator.start()
        enabled = SignalSimulator.running
        if (enabled) {
            startWatchdog()
            Log.i(TAG, "模拟已启用：${s.id} 通道=${SignalSimulator.channels().size}")
        } else {
            // 起不来就别把真实轮询也停着
            restoreEngineIfNeeded()
            Log.w(TAG, "模拟未启动（没有可用 PID？）")
        }
        return enabled
    }

    /**
     * 关闭模拟。
     *
     * `SignalSimulator.stop()` 内部 `VehicleBus.closeSource()` 会把本来源写过的
     * 每个 PID 标成 `ok=false, error="采集来源已停止"` ——
     * 这正是「停止模拟时清理自身注入的数据状态」。
     */
    fun disable() {
        stopWatchdog()
        SignalSimulator.stop()
        enabled = false
        restoreEngineIfNeeded()
        Log.i(TAG, "模拟已关闭")
    }

    private fun restoreEngineIfNeeded() {
        val restore = engineWasRunning
        engineWasRunning = false
        if (restore) {
            runCatching {
                if (ObdController.isConnected()) ObdController.startPolling()
            }.onFailure { Log.w(TAG, "恢复真实轮询失败", it) }
        }
    }

    /**
     * 切换场景。
     *
     * `DISCONNECT` 语义就是「数据断开」= 关掉模拟来源（触发正确失效）；
     * 其它场景若当前没在跑，会重新起一个来源。
     */
    fun setScenario(s: SimScenario) {
        scenario = s
        if (s == SimScenario.DISCONNECT) {
            if (enabled) {
                // 只关来源，不恢复真实轮询 —— 断开就是要看到"没数据"
                SignalSimulator.stop()
                enabled = false
            }
            return
        }
        if (!SignalSimulator.running) {
            SignalSimulator.start()
            enabled = SignalSimulator.running
            if (enabled) startWatchdog()
        }
        applyScenario(s)
    }

    /**
     * 强制补 N 拍（自动化测试用来让画面立刻刷新一次）。
     *
     * 常量波形下数值不变，但会重新 `publish` 一轮 → UI 立即重绘，
     * 不用干等 10Hz 定时器。
     */
    fun step(n: Int = 1) {
        repeat(n.coerceIn(0, 200)) {
            tick++
            runCatching { SignalSimulator.tick(System.currentTimeMillis()) }
        }
    }

    // ============================================================ 场景 → 通道

    /**
     * 把场景翻译成通道配置。
     *
     * 用 `WAVE_CONSTANT` + `min == max == 目标值` 得到**固定输出**：
     * `waveAt(CONSTANT) == 1f` → `base = lo + (hi-lo)*1 = hi = 目标值`。
     *
     * 场景没给的 PID 一律**禁用通道**（不发布），再 `stop + start`
     * 让它们保持「未知」—— 这正是 `NULL_PID` / `MISSING_PID` 要的语义。
     */
    private fun applyScenario(s: SimScenario) {
        val wanted = SimScenario.values(s, tick, extraPids)
        val all = SignalSimulator.channels()
        if (all.isEmpty()) return

        all.forEach { ch ->
            val v = wanted[ch.pidId]
            if (v == null || v.isNaN()) {
                // 本场景不给这个 PID 值 → 禁用（不发布）
                ch.enabled = false
                SignalSimulator.update(ch)
            } else {
                ch.enabled = true
                ch.wave = SignalSimulator.WAVE_CONSTANT
                ch.periodSec = 1f
                ch.min = v
                ch.max = v
                ch.noise = 0f
                SignalSimulator.update(ch)
            }
        }

        // NULL_PID / MISSING_PID：必须重建来源，才能让「之前有值、现在没有」的 PID 失效
        if (s == SimScenario.NULL_PID || s == SimScenario.MISSING_PID) {
            SignalSimulator.stop()
            SignalSimulator.start()
            enabled = SignalSimulator.running
        }
    }

    // ============================================================ 看门狗

    /**
     * 真实轮询一旦起来，模拟必须**立刻退让**。
     *
     * 为什么要它：`ObdController.startPolling()` 可能被别的界面（连设备、切页面、
     * 重新启用 PID）调起。那时如果模拟还在写，两个来源会交替覆盖同一个 PID，
     * 表现为仪表数字来回跳 —— 用户会以为仪表坏了。
     */
    private fun startWatchdog() {
        stopWatchdog()
        val h = android.os.Handler(android.os.Looper.getMainLooper())
        watchdogHandler = h
        val r = object : Runnable {
            override fun run() {
                if (!enabled) return
                val realRunning = runCatching { ObdController.engine.running }.getOrDefault(false)
                if (realRunning) {
                    lastYieldReason = "真实轮询已启动，模拟自动退让"
                    Log.w(TAG, lastYieldReason)
                    disable()
                    return
                }
                h.postDelayed(this, WATCHDOG_MS)
            }
        }
        watchdog = r
        h.postDelayed(r, WATCHDOG_MS)
    }

    private fun stopWatchdog() {
        watchdog?.let { watchdogHandler?.removeCallbacks(it) }
        watchdog = null
        watchdogHandler = null
    }

    // ============================================================ 供测试 / UI

    /** 是否是「模拟数据」状态（UI 用来显示 SIMULATED 标记） */
    fun isSimulated(): Boolean = enabled

    /** 当前是否有真实轮询在跑（互斥显示用） */
    fun realPollingActive(): Boolean =
        runCatching { ObdController.engine.running }.getOrDefault(false)

    /** 一行摘要，用于 Debug 面板 / logcat */
    fun statusText(): String {
        if (!enabled) return "SIM 关闭"
        val chans = SignalSimulator.channels().filter { it.enabled }
        val preview = chans.take(4).joinToString(", ") { "${it.pidId}=${fmt(it.max)}" }
        return "SIM ${scenario.label} 通道=${chans.size}  $preview"
    }

    private fun fmt(f: Float): String =
        if (kotlin.math.abs(f - Math.round(f)) < 0.01f) Math.round(f).toString()
        else String.format(java.util.Locale.US, "%.1f", f)
}
