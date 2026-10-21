package com.icar.obd.sim

import com.icar.obd.data.PidValue
import com.icar.obd.obd.VehicleBus
import kotlin.math.abs
import kotlin.math.sin

/**
 * 离线 PID 模拟数据源（P5A-M01 阶段 B）。
 *
 * ## 这是干什么的
 *
 * 没有 OBD 适配器、没有车的时候，用它驱动**真实的**数据链路：
 *
 * ```
 * SimPidSource ──VehicleBus.put()──> values ──> DashRenderer / NodeTreeRenderer
 *                                             / RuleEngine / 状态灯 / 仪表
 * ```
 *
 * ## 为什么不建立第二套渲染通道
 *
 * `VehicleBus` 的项目注释写得很明确：
 *
 * > 这是「数据层」与「渲染层」之间的唯一接口：
 * > 引擎往里写，仪表盘/规则引擎/日志器从里读。
 *
 * 所以模拟源**只往总线写**，下游一行代码都不用改 ——
 * 「模拟能跑」与「真机能跑」走同一条路，模拟才有意义。
 *
 * ## 为什么用 `put(v)` 而不是 `openSource()/put(source, v)`
 *
 * `openSource` / `closeSource` / `put(source, v)` 都是 `internal`。
 * 本项目 `app/src/debug/` 与 `app/src/main/` 属于**不同编译单元**，
 * 读不到 `internal`。而本轮的红线是「**不修改生产代码**」，所以不为了
 * 测试去放宽 `VehicleBus` 的可见性。
 *
 * 用公开的 `VehicleBus.put(v)`：
 *
 * - 它走 `storeLocked()` + `notifyValues()` —— **和真实数据完全同一条下游**
 * - 它把该 PID 从 `currentOwners` 摘掉，语义是「这是个无归属的值」
 *
 * 「断开」由 [SimPidSource] 自己实现：不发新值，并把每个写过的 PID
 * 补发一条 `ok = false` 的 `PidValue`。`VehicleBus.value()` / `snapshot()`
 * 都只看 `ok`，所以仪表会显示 `--`、规则引擎不会误触发 ——
 * 与真实链路断开时的下游表现**一致**（真实链路靠 `closeSource` 做同一件事）。
 *
 * ## 隔离（重要）
 *
 * - 本文件位于 `app/src/debug/` —— **Release 变体根本不会编译它**
 * - 不修改 `VehicleBus` / `ObdEngine` / `DashRenderer` 任何一行
 * - 不写 `Store`、不写 CSV、不写任何持久化
 * - 默认关闭，需显式 `enable()`（或 adb 广播）
 *
 * ## 可重复
 *
 * 场景的值由**确定性函数**生成（`tick` 序号 + 固定公式），
 * 不用 `Random`，所以自动化测试可以断言具体数值。
 */
object SimPidSource {

    /** 模拟源是否启用。默认关闭，需显式 `enable()` */
    @Volatile
    var enabled: Boolean = false
        private set

    /** 当前场景 */
    @Volatile
    var scenario: SimScenario = SimScenario.NORMAL
        private set

    /** 已发出的 tick 数（自动化测试可读） */
    @Volatile
    var tick: Int = 0
        private set

    /** 最近一次成功写入的值（自动化测试可读） */
    private val lastWritten = LinkedHashMap<String, Float>()

    /** 已经写过的全部 PID（断开时要逐个补发 ok=false） */
    private val writtenPids = LinkedHashSet<String>()

    /** 额外的自定义 PID */
    private var extraPids: List<String> = emptyList()

    // ============================================================ 生命周期

    /** 打开模拟源并立刻产出第一个 tick */
    fun enable(s: SimScenario = SimScenario.NORMAL, extra: List<String> = emptyList()) {
        // ⚠️ P5A-M01 修：**不清空 writtenPids**。
        // 切到 DISCONNECT 时 SimControl 会先 enable() 再 setScenario(DISCONNECT)，
        // 若这里清空了 writtenPids，markAllStale 就遍历空集合 → 一个 PID 都不标失效
        // → 仪表继续挂着旧值（实测 BUSD 全是 ok=1，UI 不回落）。
        //
        // writtenPids 的语义应该是「本进程写过的全部 PID」，
        // 只有显式 disable() 或进程重启才清。
        scenario = s
        extraPids = extra
        tick = 0
        lastWritten.clear()
        enabled = true
        emit()
    }

    /**
     * 关闭模拟源。
     *
     * 对每个写过值的 PID 补发一条 `ok = false` ——
     * 下游（仪表 / 状态灯 / 规则引擎）会像真实链路断开那样回落。
     */
    fun disable() {
        enabled = false
        markAllStale("模拟已关闭")
        // 真正的关闭才清历史（下次 enable 从干净状态开始）
        writtenPids.clear()
        lastWritten.clear()
    }

    /** 切换场景（保持连续性） */
    fun setScenario(s: SimScenario) {
        val wasDisconnected = scenario == SimScenario.DISCONNECT
        scenario = s
        if (s == SimScenario.DISCONNECT) {
            enabled = false          // 断开 = 不再产出
            markAllStale("模拟：数据断开")
        } else {
            if (wasDisconnected || !enabled) {
                enabled = true
            }
            emit()
        }
    }

    /**
     * 立刻把「当前场景不再产出」的 PID 标为失效。
     *
     * 场景切换后（例如 accel → normal），上个场景写过但本场景不写的 PID
     * （如 MISSING_PID 只剩两个）会保留旧值。这个方法把它们清掉，
     * 语义与「真实链路里那个 PID 停了」一致。
     */
    private fun staleUnproduced() {
        val produced = SimScenario.values(scenario, tick, extraPids).keys
        val now = System.currentTimeMillis()
        writtenPids.filter { it !in produced }.forEach { pid ->
            val last = lastWritten[pid] ?: 0f
            VehicleBus.put(PidValue(pid, last, "", now, false, "模拟：本场景不产出", ttlMs = 0))
        }
    }

    /**
     * 推进 n 个 tick 并写值。
     *
     * 自动化测试可以直接调 `step(n)` 精确控制步数 —— 不用等真实定时器。
     */
    fun step(n: Int = 1) {
        if (!enabled) return
        repeat(n) {
            tick++
            emit()
        }
    }

    // ============================================================ 产出

    private fun emit() {
        if (!enabled) return
        val now = System.currentTimeMillis()

        SimScenario.values(scenario, tick, extraPids).forEach { (pidId, value) ->
            if (value == null) {
                // 「值为空」场景：写 ok=false，下游显示 --
                VehicleBus.put(PidValue(pidId, 0f, "", now, false, "sim:null", ttlMs = 0))
                writtenPids.add(pidId)
            } else {
                // ttlMs = 0 → VehicleBus.fresh() 不做过期判定。
                // 模拟值不会「自己过期」，生命周期由场景显式控制。
                VehicleBus.put(PidValue(pidId, value, "", now, true, null, ttlMs = 0))
                lastWritten[pidId] = value
                writtenPids.add(pidId)
            }
        }

        // 把「本场景不再产出」的 PID 标失效（accel → normal 之类切换时）
        staleUnproduced()
    }

    /**
     * 把所有写过的 PID 标为失效（不发 ok=true）。
     *
     * ⚠️ P5A-M01 修：必须遍历 [writtenPids]（**历史写过的全部**），
     * 只遍历 [lastWritten]（**当前场景写过的**）会漏掉上一个场景的 PID ——
     * 那些 PID 会一直挂着旧值，UI 不回落。
     */
    private fun markAllStale(reason: String) {
        val now = System.currentTimeMillis()
        // 先算一份快照，避免遍历时被并发修改
        val targets = writtenPids.toList()
        targets.forEach { pid ->
            val last = lastWritten[pid] ?: 0f
            VehicleBus.put(PidValue(pid, last, "", now, false, reason, ttlMs = 0))
        }
        // **不清空** lastWritten：断开后若同一 PID 再恢复，还知道它上次是多少
        // （UI 那一侧只看 ok，不看具体值）
    }

    // ============================================================ 供测试 / UI 读取

    /** 最近一次写入的值（只读快照） */
    fun snapshotWritten(): Map<String, Float> = LinkedHashMap(lastWritten)

    /** 是否是「模拟数据」状态（UI 用来显示 SIMULATED 标记） */
    fun isSimulated(): Boolean = enabled

    /** 一行摘要，用于 Debug 面板 / logcat */
    fun statusText(): String {
        if (!enabled) return "SIM 关闭"
        val w = lastWritten.entries.take(4).joinToString(", ") { "${it.key}=${fmt(it.value)}" }
        return "SIM ${scenario.label} tick=$tick  $w"
    }

    private fun fmt(f: Float): String =
        if (abs(f - Math.round(f)) < 0.01f) Math.round(f).toString()
        else String.format(java.util.Locale.US, "%.1f", f)

    /** 供场景函数使用的小工具（保留在 object 内便于单测直接调） */
    internal fun wobbleForTest(t: Int, period: Int, amp: Float): Float =
        sin(2.0 * Math.PI * t / period).toFloat() * amp
}
