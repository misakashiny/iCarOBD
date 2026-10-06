package com.icar.obd.data

/**
 * 出厂默认内容：默认规则 + 默认自定义仪表。
 *
 * 只在「首次启动 / 用户把列表删空」时写入，之后完全由用户掌控。
 * 默认规则的存在是为了让「转向灯音效」这类需求开箱即用——
 * 它是一条普通规则，用户可以在规则编辑器里改阈值、改音效、删掉。
 */
object Defaults {

    /**
     * 默认自定义仪表盘布局。
     * 定义在 [DashLayout]（归一化自由坐标），这里只做转发 ——
     * 避免「同一套布局在三个地方各写一份」这种以后必然分叉的写法。
     */
    fun defaultGauges(): List<GaugeItem> = DashLayout.normal()

    /**
     * 默认规则。
     *
     * ⚠️ 转向灯那两条依赖 `mon_turn_left` / `mon_turn_right` —— 它们是**监听型** PID
     * （`source = "monitor"`，读 CAN 广播帧 `0x09A`，见 `BuiltInPids`）。
     * 2026-10-06 实车确认后，这两条已经**不再是占位模板**，默认就启用；
     * 但它们的值只有到「CAN 探测」页**开启常驻监听**时才会更新
     * （ELM327 半双工，`ATMA` 监听期间轮询必须让位）。
     */
    fun defaultRules(): List<Rule> = listOf(
        Rule(
            name = "左转向灯音效",
            logic = "AND",
            conditions = mutableListOf(RuleCondition("mon_turn_left", "==", 1f)),
            durationMs = 0,
            // 500ms 冷却 = 条件持续成立时每 0.5 秒响一次，接近实车转向灯节奏
            cooldownMs = 450,
            actions = mutableListOf(RuleAction("sound", "tick_left"))
        ),
        Rule(
            name = "右转向灯音效",
            logic = "AND",
            conditions = mutableListOf(RuleCondition("mon_turn_right", "==", 1f)),
            durationMs = 0,
            cooldownMs = 450,
            actions = mutableListOf(RuleAction("sound", "tick_right"))
        ),
        Rule(
            name = "高水温告警",
            logic = "AND",
            conditions = mutableListOf(RuleCondition("std_05", ">", 105f)),
            durationMs = 3000,
            cooldownMs = 15000,
            actions = mutableListOf(
                RuleAction("sound", "warn"),
                RuleAction("toast", "冷却液温度过高"),
                RuleAction("log", "冷却液温度 > 105℃"),
                RuleAction("gauge", "std_05", "red")
            )
        ),
        Rule(
            name = "电压异常告警",
            logic = "AND",
            conditions = mutableListOf(RuleCondition("std_42", "<", 11.8f)),
            durationMs = 3000,
            cooldownMs = 20000,
            actions = mutableListOf(
                RuleAction("toast", "电瓶电压偏低"),
                RuleAction("sound", "beep"),
                RuleAction("gauge", "std_42", "red")
            )
        ),
        Rule(
            name = "超速提醒",
            logic = "AND",
            conditions = mutableListOf(RuleCondition("std_0D", ">", 120f)),
            durationMs = 5000,
            cooldownMs = 30000,
            actions = mutableListOf(
                RuleAction("toast", "车速超过 120 km/h"),
                RuleAction("log", "超速")
            )
        )
    )

    /** 首次启动时补齐默认内容；已有数据则不动 */
    fun seedIfEmpty() {
        var changed = false
        if (Store.rules.isEmpty()) {
            Store.rules.addAll(defaultRules())
            Store.saveRules()
            changed = true
            AppLog.i(AppLog.M_SYS, "写入默认规则", "count=${Store.rules.size}")
        }
        if (Store.customGauges.isEmpty()) {
            Store.customGauges.addAll(defaultGauges())
            Store.saveDash()
            changed = true
            AppLog.i(AppLog.M_SYS, "写入默认自定义仪表", "count=${Store.customGauges.size}")
        }
        if (changed) AppLog.i(AppLog.M_SYS, "默认内容已初始化")
    }
}
