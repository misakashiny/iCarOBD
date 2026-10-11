package com.icar.obd.data

/**
 * 规则动作的**可视出口**。
 *
 * ## 为什么要有这张表（v1.20.21）
 *
 * 用户原话：「还有弹出提示的时候是**两个弹出提示**、我只需要灵动岛的版本」。
 *
 * 查下来是 `ObdController.handleAction` 的 `"toast"` 分支**同时**调了两处：
 *
 * ```kotlin
 * "toast" -> {
 *     AppLog.i(AppLog.M_RULE, "提示", msg)
 *     toast(msg)              // ← ① 系统 Toast（ObdController.toast → Toast.makeText）
 *     emitAlert("⚠ $msg")     // ← ② 灵动岛（MainActivity.onAlert → IslandNotice.show）
 * }
 * ```
 *
 * 两个都**真的弹**（不是"隐藏了一个"），所以屏幕上出现两处提示。
 * 这是这个项目**第四次**栽在"同一个概念有两份权威"上
 * （前三次：规则提示两处、`statePid` 两处、`designBaseDir` 两处）。
 *
 * ## 约定（硬约束）
 *
 * **一个动作恰好一个可视出口。** 出口由 [channelsFor] **单点决定**，
 * `ObdController` 只负责按它投递 —— 这样"再多弹一个"就不可能悄悄发生：
 * 想加出口就得改这张表，而表上有单测钉着（见 `RuleAlertRoutingTest`）。
 *
 * ⚠️ **不要**在 `handleAction` 里直接写 `toast(...)` / `notifyRule(...)`。
 * 规则提示走灵动岛；系统 Toast **只给编辑器用**（保存成功、校验失败……），
 * 那些是"操作反馈"，不是"规则提示"，两者混在一起正是这次的坑。
 */
enum class AlertChannel {

    /** 灵动岛悬浮胶囊（`ui/view/IslandNotice.kt`）—— **规则提示的唯一可视出口** */
    ISLAND,

    /**
     * 系统 Toast（`ObdController.toast`）。
     *
     * ⚠️ **规则动作一个都不用它**。常量留着是有用的：单测靠它断言
     * "没有任何动作类型同时走灵动岛和系统 Toast" —— 那正是这次的故障形态。
     */
    SYSTEM_TOAST,

    /** 系统通知栏（`notify` 动作 → `ObdController.notifyRule`） */
    SYSTEM_NOTIFICATION
}

/**
 * 动作类型 → 可视出口的**唯一映射**。
 *
 * 纯逻辑（不碰 Android），所以能直接在 JVM 单测里跑 —— 而"一次弹两个"这种
 * 故障**只有在这种层面上才测得出来**：真机上看现象只能看出"弹了两次"，
 * 看不出是谁弹的。
 */
object RuleAlertRouting {

    /** 灵动岛文案前缀。规则提示统一带这个标记（"这是一条提示"） */
    const val ISLAND_PREFIX = "⚠ "

    /**
     * 编辑器「▶ 预览」在用户**没填内容**时用的示例文案。
     *
     * 为什么要有它：规则动作的 `p1` 允许留空（运行时回退到规则名），
     * 而"留空 + 点预览"什么都不弹的话，用户会以为按钮坏了。
     */
    const val DEFAULT_PREVIEW = "示例提示：规则提示长这样"

    /**
     * 这个动作类型会往哪些可视出口投递。
     *
     * ⚠️ 返回值长度 **≤ 1** 是硬约定（有单测）。空列表 = 没有可视出口
     * （`log` 只写日志、`gauge` 只改仪表颜色、`vibrate` 只振动、
     * `sound` 只有声音）。
     */
    fun channelsFor(actionType: String): List<AlertChannel> =
        when (actionType.trim().lowercase()) {
            "toast" -> listOf(AlertChannel.ISLAND)
            "notify" -> listOf(AlertChannel.SYSTEM_NOTIFICATION)
            else -> emptyList()
        }

    fun usesIsland(actionType: String): Boolean =
        channelsFor(actionType).contains(AlertChannel.ISLAND)

    /**
     * ⚠️ 这条**必须恒为 false**（对任何动作类型）。
     *
     * 它存在的唯一理由是让"规则提示又去弹系统 Toast"变成一条**会红的断言**
     * —— v1.20.20 及以前这里是真的，于是用户看到两个提示。
     */
    fun usesSystemToast(actionType: String): Boolean =
        channelsFor(actionType).contains(AlertChannel.SYSTEM_TOAST)

    /** 灵动岛显示文案。规则路径与编辑器预览**共用**，否则预览就不是"所见即所得" */
    fun islandText(msg: String): String = ISLAND_PREFIX + msg

    /**
     * 动作的提示文案：`p1` 为空时回退到规则名。
     *
     * 抽出来是为了让**运行时**与**编辑器预览**用同一条回退规则
     * （各写一份的话，预览里看到的和真弹出来的会是两句不同的话）。
     */
    fun messageOf(p1: String, ruleName: String): String = p1.ifBlank { ruleName }

    /** 编辑器预览文案：`p1` 与规则名都为空时给 [DEFAULT_PREVIEW] */
    fun previewText(p1: String, ruleName: String): String =
        messageOf(p1, ruleName).ifBlank { DEFAULT_PREVIEW }
}
