package com.icar.obd.obd

import com.icar.obd.data.AppLog
import com.icar.obd.data.CompareOp
import com.icar.obd.data.PidValue
import com.icar.obd.data.Rule
import com.icar.obd.data.RuleAction
import com.icar.obd.data.RuleCondition
import com.icar.obd.data.Store
import java.util.concurrent.ConcurrentHashMap

/**
 * 规则引擎：车辆数据 → 事件。
 *
 * 「转向灯音效」不是写死的功能，而是这个引擎的一条默认规则：
 *
 *   WHEN 左转向信号 == 1  THEN PlaySound("tick_left")  cooldown=500ms
 *
 * 同理可表达：高水温报警、电压异常、超速提醒……
 * 规则全部来自 [Store.rules]（JSON 持久化），因此新增告警不需要改代码。
 *
 * 触发语义（重要）：
 *  - 条件成立并**持续** durationMs 后触发；
 *  - 触发后进入 cooldownMs 冷却；冷却结束后若条件仍成立，会**再次触发**。
 *    这是转向灯「一秒一闪」所需的行为（不是边沿触发）。
 *  - CHANGED 操作符为边沿语义，用于「值一变化就响一声」的场景。
 *
 * 上述时序判定已抽到纯逻辑 [TriggerGate]，便于单元测试
 * （`app/src/test/java/com/icar/obd/obd/TriggerGateTest.kt`）。
 */
object RuleEngine {

    /** 仪表变色覆盖：pidId → ARGB。由仪表渲染层读取，为空表示用默认色。 */
    private val colorOverride = ConcurrentHashMap<String, Int>()

    /** 「持续成立 + 冷却后重复触发」的时序闸门 */
    private val gate = TriggerGate()

    private val prevValues = HashMap<String, Float>()

    /** 规则触发时的动作执行器，由 ObdController 注入（需要 Context 做提示音/振动/通知） */
    var actionHandler: ((Rule, RuleAction) -> Unit)? = null

    @Volatile
    var activeRules: List<Rule> = emptyList()
        private set

    fun reload() {
        activeRules = Store.rules.filter { it.enabled }
        AppLog.i(AppLog.M_RULE, "规则已加载", "count=${activeRules.size}")
    }

    fun colorOf(pidId: String): Int? = colorOverride[pidId]

    /** -1 表示恢复默认色（移除覆盖） */
    fun setColor(pidId: String, argb: Int) {
        if (pidId.isBlank()) return
        if (argb == -1) colorOverride.remove(pidId) else colorOverride[pidId] = argb
    }

    fun clearColors() = colorOverride.clear()

    fun reset() {
        gate.clear(); prevValues.clear(); colorOverride.clear()
    }

    /**
     * 评估一轮。由 [ObdEngine] 在每轮轮询后调用。
     *
     * 用同一份快照评估所有规则，保证同一次评估内数据一致；
     * 快照同时用于更新「上一次的值」，使 CHANGED 语义稳定。
     */
    fun evaluate() {
        if (activeRules.isEmpty()) return
        val snapshot: Map<String, PidValue> = VehicleBus.snapshot()
        val now = System.currentTimeMillis()

        for (rule in activeRules) {
            if (rule.conditions.isEmpty()) continue

            val results = rule.conditions.map { cond ->
                val cur = snapshot[cond.sourceId]?.takeIf { it.ok }?.value
                if (cur == null) false
                else CompareOp.fromSymbol(cond.op).test(cur, cond.threshold, prevValues[cond.sourceId])
            }

            val satisfied = if (rule.logic.equals("OR", true)) results.any { it } else results.all { it }

            if (!satisfied) {
                gate.onUnsatisfied(rule.id)
                continue
            }

            if (!gate.shouldFire(rule.id, now, rule.durationMs, rule.cooldownMs)) continue

            AppLog.i(AppLog.M_RULE, "规则触发", "name=${rule.name} actions=${rule.actions.size}")
            rule.actions.forEach { a ->
                runCatching { actionHandler?.invoke(rule, a) }
                    .onFailure { AppLog.e(AppLog.M_RULE, "动作执行异常", "rule=${rule.name} type=${a.type} ${it.message}") }
            }
        }

        // 更新上一轮的值（供下一轮 CHANGED 判断）
        prevValues.clear()
        snapshot.forEach { (k, v) -> if (v.ok) prevValues[k] = v.value }
    }

    /** 供规则编辑器「试跑」用：对给定规则做一次静态判定，返回是否成立 */
    fun testRuleOnce(rule: Rule): Boolean {
        if (rule.conditions.isEmpty()) return false
        val results = rule.conditions.map { c ->
            val v = VehicleBus.value(c.sourceId)
            v != null && CompareOp.fromSymbol(c.op).test(v, c.threshold, prevValues[c.sourceId])
        }
        return if (rule.logic.equals("OR", true)) results.any { it } else results.all { it }
    }

    /** 条件描述，UI 与日志共用 */
    fun describeCondition(c: RuleCondition): String {
        val name = Store.findPid(c.sourceId)?.name ?: c.sourceId.ifBlank { "(未选)" }
        val unit = Store.findPid(c.sourceId)?.unit ?: ""
        val op = CompareOp.fromSymbol(c.op)
        return if (op == CompareOp.CHANGED) "$name 发生变化"
        else "$name ${op.symbol} ${fmt(c.threshold)}$unit"
    }

    fun describeRule(r: Rule): String {
        if (r.conditions.isEmpty()) return "(无条件)"
        val joiner = if (r.logic.equals("OR", true)) " 或 " else " 且 "
        val condText = r.conditions.joinToString(joiner) { describeCondition(it) }
        val dur = if (r.durationMs > 0) " 持续${r.durationMs / 1000}秒" else ""
        val actText = r.actions.joinToString("，") { it.describe() }
        return "当 $condText$dur → $actText"
    }

    private fun fmt(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else String.format("%.2f", f)
}

/**
 * 触发闸门：把「条件持续成立 durationMs 后触发，此后每 cooldownMs 可再次触发」
 * 的时序判定抽成**不依赖 Android** 的纯逻辑，从而可以单元测试。
 *
 * 语义要点（与 [RuleEngine] 的文档一致，改动前请先看 TriggerGateTest）：
 *  - 这是**重复触发**语义，不是边沿触发 —— 转向灯「一秒一闪」依赖它；
 *  - 条件一旦不成立，持续计时立即清零（下次成立要重新计满 durationMs）；
 *  - `durationMs = 0` 表示条件一成立即可触发。
 */
internal class TriggerGate {

    private val trueSince = HashMap<String, Long>()
    private val lastFire = HashMap<String, Long>()

    /** 条件不成立时调用：清除持续计时 */
    fun onUnsatisfied(id: String) {
        trueSince.remove(id)
    }

    /**
     * 条件成立时调用。
     * @return true 表示本次应当触发（内部已记录触发时刻，调用方无需再处理冷却）
     */
    fun shouldFire(id: String, now: Long, durationMs: Long, cooldownMs: Long): Boolean {
        val since = trueSince.getOrPut(id) { now }
        if (now - since < durationMs) return false

        val last = lastFire[id] ?: 0L
        if (now - last < cooldownMs) return false

        lastFire[id] = now
        return true
    }

    fun clear() {
        trueSince.clear(); lastFire.clear()
    }
}
