package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * PID 定义。
 *
 * 这是整个项目的核心数据模型：一条 PID 完整描述了
 * 「发什么请求 → 怎么从响应里取数据 → 用什么公式换算 → 单位/量程/报警阈值」。
 * 因此新增一种车辆数据永远不需要改 APK，只需要新增一条记录。
 */
data class PidDefinition(
    var id: String = UUID.randomUUID().toString(),
    var name: String = "",
    /** 协议族：CAN(ISO15765) / ISO9141 / KWP / J1850 ... 仅作备注与扫描过滤用 */
    var protocol: String = "CAN",
    /** OBD 模式：01 / 03 / 09 / 21 / 22 ... */
    var mode: String = "01",
    /** PID 号：01 模式为 2 位（0C），22 模式为 4 位（1234） */
    var pid: String = "0C",
    /** 换算公式，变量 A..Z 对应响应数据字节 */
    var formula: String = "A",
    var unit: String = "",
    var minVal: Float = 0f,
    var maxVal: Float = 100f,
    var warnLow: Float? = null,
    var warnHigh: Float? = null,
    var enabled: Boolean = true,
    var builtIn: Boolean = false,
    /** 单独轮询间隔（ms），0 = 跟随全局 */
    var intervalMs: Int = 0,
    /**
     * 多 ECU 响应时取第几个匹配（0 起）。
     *
     * 同一条 PID 可能有多个模块回复（发动机 / 变速箱 / 车身…），
     * 顺序由总线决定。选错会**读到别的模块的值**，而且现象上完全看不出 ——
     * 所以默认 0（= 旧行为：取第一个）。
     */
    var ecuIndex: Int = 0,
    /**
     * 轮询优先级：0=高 1=中 2=低。
     * **仅在 [intervalMs] = 0（跟随全局）时生效** —— 单独设了间隔就以它为准。
     */
    var priority: Int = PRIORITY_NORMAL,
    /** 覆盖自动生成的请求帧（罕见但保留能力） */
    var customRequest: String? = null,
    var group: String = "自定义",
    var note: String = ""
) {
    /** 显示的请求串，如 "22 12 34" */
    fun requestString(): String {
        customRequest?.takeIf { it.isNotBlank() }?.let { return normalize(it) }
        return normalize("$mode $pid")
    }

    fun modeInt(): Int = mode.trim().toIntOrNull(16) ?: 0x01
    fun pidBytes(): Int = pid.trim().replace(" ", "").length / 2

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("name", name); put("protocol", protocol)
        put("mode", mode); put("pid", pid); put("formula", formula)
        put("unit", unit); put("min", minVal.toDouble()); put("max", maxVal.toDouble())
        warnLow?.let { put("warnLow", it.toDouble()) }
        warnHigh?.let { put("warnHigh", it.toDouble()) }
        put("enabled", enabled); put("builtIn", builtIn)
        put("interval", intervalMs)
        put("ecuIndex", ecuIndex)
        put("priority", priority)
        customRequest?.let { put("customRequest", it) }
        put("group", group); put("note", note)
    }

    companion object {
        /** 轮询优先级 */
        const val PRIORITY_HIGH = 0
        const val PRIORITY_NORMAL = 1
        const val PRIORITY_LOW = 2

        /** 优先级 → 全局间隔的倍率。高优先级更快、低优先级更慢 */
        fun priorityScale(priority: Int): Float = when (priority) {
            PRIORITY_HIGH -> 0.5f
            PRIORITY_LOW -> 2.0f
            else -> 1.0f
        }

        fun priorityName(priority: Int): String = when (priority) {
            PRIORITY_HIGH -> "高"
            PRIORITY_LOW -> "低"
            else -> "中"
        }

        fun normalize(s: String): String =
            s.trim().replace(Regex("\\s+"), " ").uppercase()

        fun fromJson(o: JSONObject): PidDefinition = PidDefinition(
            id = o.optString("id", UUID.randomUUID().toString()),
            name = o.optString("name"),
            protocol = o.optString("protocol", "CAN"),
            mode = o.optString("mode", "01"),
            pid = o.optString("pid", ""),
            formula = o.optString("formula", "A"),
            unit = o.optString("unit", ""),
            minVal = o.optDouble("min", 0.0).toFloat(),
            maxVal = o.optDouble("max", 100.0).toFloat(),
            warnLow = if (o.has("warnLow")) o.optDouble("warnLow").toFloat() else null,
            warnHigh = if (o.has("warnHigh")) o.optDouble("warnHigh").toFloat() else null,
            enabled = o.optBoolean("enabled", true),
            builtIn = o.optBoolean("builtIn", false),
            intervalMs = o.optInt("interval", 0),
            ecuIndex = o.optInt("ecuIndex", 0),
            priority = o.optInt("priority", PRIORITY_NORMAL),
            customRequest = o.optString("customRequest", "").takeIf { it.isNotBlank() },
            group = o.optString("group", "自定义"),
            note = o.optString("note", "")
        )
    }
}

// ---------------------------------------------------------------- 规则引擎模型

enum class CompareOp(val symbol: String, val label: String) {
    GT(">", "大于"), GE(">=", "大于等于"), LT("<", "小于"), LE("<=", "小于等于"),
    EQ("==", "等于"), NE("!=", "不等于"), CHANGED("~", "发生变化");

    fun test(v: Float, t: Float, prev: Float?): Boolean = when (this) {
        GT -> v > t; GE -> v >= t; LT -> v < t; LE -> v <= t
        EQ -> v == t; NE -> v != t
        CHANGED -> prev != null && v != prev
    }

    companion object {
        fun fromSymbol(s: String): CompareOp = entries.firstOrNull { it.symbol == s } ?: GT
    }
}

data class RuleCondition(
    var sourceId: String = "",
    var op: String = CompareOp.GT.symbol,
    var threshold: Float = 0f
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("source", sourceId); put("op", op); put("threshold", threshold.toDouble())
    }

    companion object {
        fun fromJson(o: JSONObject) = RuleCondition(
            o.optString("source"), o.optString("op", ">"),
            o.optDouble("threshold", 0.0).toFloat()
        )
    }
}

/**
 * 动作。用 type + 三个字符串参数表达，便于 JSON 持久化与以后扩展。
 * type: sound / toast / log / gauge / vibrate / notify
 */
data class RuleAction(
    var type: String = "toast",
    var p1: String = "",
    var p2: String = "",
    var p3: String = ""
) {
    fun describe(): String = when (type) {
        "sound" -> "播放音效 ${p1}"
        "toast" -> "弹出提示「$p1」"
        "log" -> "记录日志「$p1」"
        "gauge" -> "仪表 ${if (p1.isBlank()) "当前" else p1} 变色 $p2"
        "vibrate" -> "振动 ${p1}ms"
        "notify" -> "通知「$p1」"
        else -> type
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("type", type); put("p1", p1); put("p2", p2); put("p3", p3)
    }

    companion object {
        fun fromJson(o: JSONObject) = RuleAction(
            o.optString("type", "toast"), o.optString("p1"), o.optString("p2"), o.optString("p3")
        )
    }
}

data class Rule(
    var id: String = UUID.randomUUID().toString(),
    var name: String = "",
    var enabled: Boolean = true,
    /** 多条件组合方式：AND / OR */
    var logic: String = "AND",
    var conditions: MutableList<RuleCondition> = mutableListOf(),
    /** 条件需持续满足的时长（ms） */
    var durationMs: Long = 0,
    var actions: MutableList<RuleAction> = mutableListOf(),
    /** 触发后的冷却时间，避免报警刷屏 */
    var cooldownMs: Long = 5000
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id); put("name", name); put("enabled", enabled); put("logic", logic)
        put("conditions", JSONArray().apply { conditions.forEach { put(it.toJson()) } })
        put("duration", durationMs)
        put("actions", JSONArray().apply { actions.forEach { put(it.toJson()) } })
        put("cooldown", cooldownMs)
    }

    companion object {
        fun fromJson(o: JSONObject): Rule {
            val conds = mutableListOf<RuleCondition>()
            val ca = o.optJSONArray("conditions")
            if (ca != null) for (i in 0 until ca.length()) conds.add(RuleCondition.fromJson(ca.getJSONObject(i)))
            val acts = mutableListOf<RuleAction>()
            val aa = o.optJSONArray("actions")
            if (aa != null) for (i in 0 until aa.length()) acts.add(RuleAction.fromJson(aa.getJSONObject(i)))
            return Rule(
                id = o.optString("id", UUID.randomUUID().toString()),
                name = o.optString("name"),
                enabled = o.optBoolean("enabled", true),
                logic = o.optString("logic", "AND"),
                conditions = conds,
                durationMs = o.optLong("duration", 0),
                actions = acts,
                cooldownMs = o.optLong("cooldown", 5000)
            )
        }
    }
}

// ---------------------------------------------------------------- 自定义仪表盘

/**
 * 仪表项。
 *
 * ## 两种布局模式
 * - **自由画布（v1.5.0 起）**：[x] / [y] / [w] / [h] 是**归一化 0..1 坐标**
 *   （相对画布宽高，y 向下）。归一化的好处是与分辨率、横竖屏都无关 ——
 *   同一份配置在手机竖屏与平板横屏上都成立，不需要为每个方向存一套。
 * - **旧的 span 网格**：只有 [span] 的配置来自 v1.4.0 及以前。
 *   [fromJson] 读到这种配置会把 [legacyGrid] 置位，由
 *   [DashLayout.migrateFromGrid] 一次性转成归一化坐标。
 *
 * ## [style] 取值
 * 0 圆表 · 1 数字 · 2 条形 · 3 线型图 · 4 双数据上下 · 5 四数据 · 6 主+子双数据 · 7 G力值
 *
 * 多数据显示类（4/5/6）用 [pidId] 当主参数、[extraPids] 当副参数。
 */
data class GaugeItem(
    var pidId: String = "",
    /** 副参数（多数据显示用）；主参数是 [pidId] */
    var extraPids: MutableList<String> = mutableListOf(),
    var style: Int = STYLE_CIRCLE,
    var minVal: Float = 0f,
    var maxVal: Float = 100f,
    var warnLow: Float? = null,
    var warnHigh: Float? = null,
    var color: Int = -1,
    /** 旧网格模式的跨列数（保留兼容；迁移后不再参与渲染） */
    var span: Int = 1,
    // ---------- 自由画布：每轴 0..CANVAS（= 归一化 × 360）----------
    var x: Float = 0f,
    var y: Float = 0f,
    var w: Float = CANVAS,
    var h: Float = CANVAS * 0.25f,
    /** 数据层级：0=主参数 1=子参数。只影响默认布局与视觉权重，不影响采集 */
    var role: Int = ROLE_PRIMARY,
    /** 指针环样式：0=无 1=外圈刻度线段 */
    var ringStyle: Int = RING_NONE,
    /** 指针环细分段数（[RING_TICK] 用） */
    var ringSegments: Int = 40,
    /**
     * **霓虹预设名**（"关闭"/"克制"/"标准"/"强烈"/"夸张"）。
     *
     * `null` = 跟随主题的全局设置。
     *
     * ⚠️ 这里存的是**字符串**而不是 `NeonStyle` 对象 ——
     * `data/` 层不能依赖 `ui/view/`（红线：分层只能自上而下）。
     * 解析成样式由 ui 层做。
     */
    var neonPreset: String? = null,

    /**
     * **卡片外观覆盖**（v1.10.2）。取值见 `CARD_*` 常量，`null` = 跟随主题。
     *
     * ## 为什么需要「每块表单独控制」
     *
     * 主题级的 `cardStrokeDp` / `cardAlpha` 只能一刀切。但真实盘面常常是
     * **混合**的：大转速表想完全透明露出背景图，旁边四个小数字表却需要卡片底
     * 才读得清。一刀切必然牺牲一边。
     *
     * ## 为什么是枚举而不是三个数值
     *
     * 存 `radius/stroke/alpha` 三个数会让 JSON 变胖，而且用户真正要选的只有
     * 三种观感。枚举既够用，又**不会和主题的字段语义打架** ——
     * 否则「用户改了主题的圆角，覆盖项里的圆角要不要跟着变」永远说不清。
     *
     * 存 `Int?` 而不是枚举类型：`data/` 层保持原始类型、ui 层负责解释，
     * 与 [neonPreset] 用字符串是同一个理由（分层只能自上而下）。
     */
    var cardStyle: Int? = null
) {
    /**
     * 由 [fromJson] 置位：这条来自 v1.4.0 及以前「只有 span」的配置，需要跑一次布局迁移。
     * **不序列化**（迁移后立刻回写成新格式）。
     */
    var legacyGrid: Boolean = false

    /**
     * 本条仪表涉及的全部 PID：主参数 + 副参数。
     * 渲染层用它一次性取齐数值，避免每个 View 各自去查总线。
     */
    fun allPidIds(): List<String> = buildList {
        if (pidId.isNotBlank()) add(pidId)
        extraPids.forEach { if (it.isNotBlank()) add(it) }
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("pid", pidId)
        put("extraPids", JSONArray().apply { extraPids.forEach { put(it) } })
        put("style", style)
        put("min", minVal.toDouble()); put("max", maxVal.toDouble())
        warnLow?.let { put("warnLow", it.toDouble()) }
        warnHigh?.let { put("warnHigh", it.toDouble()) }
        put("color", color)
        put("span", span)
        // 坐标系版本标记：旧文件没有这个字段，读到就当作「归一化 0..1」，需要 ×CANVAS
        put("unit", CANVAS.toInt())
        put("x", x.toDouble()); put("y", y.toDouble())
        put("w", w.toDouble()); put("h", h.toDouble())
        put("role", role)
        put("ringStyle", ringStyle)
        put("ringSegments", ringSegments)
        // null 不写进去：旧版本读到没有这个字段就是"跟随主题"，语义一致
        neonPreset?.let { put("neonPreset", it) }
        cardStyle?.let { put("cardStyle", it) }
    }

    companion object {
        /**
         * 参考画布边长（单位）。所有 `x/y/w/h` 都在**每轴 0..CANVAS** 的坐标系里
         * —— 也就是「归一化 × 360」。
         *
         * ## 为什么不是 Sky Gauge 那种「360×360 正方形绝对坐标」
         *
         * 他们的屏幕是固定的 360×360 圆屏，而我们的画布宽高比随设备变
         * （平板横屏 2360×1261、竖屏 1600×2041）。
         * **每轴独立 0..360** 既拿到了可读性（`x = 180` 就是水平居中），
         * 又保住了跨方向自适应。
         *
         * 对**正方形**的 Sky Gauge 画布，两者是**等价的** ——
         * 所以将来导入他们的主题时，映射是恒等变换，不需要额外换算。
         */
        const val CANVAS = 360f

        const val STYLE_CIRCLE = 0
        const val STYLE_DIGITAL = 1
        const val STYLE_BAR = 2
        const val STYLE_LINE = 3
        const val STYLE_DUAL_STACK = 4
        const val STYLE_QUAD = 5
        const val STYLE_SUB_DUAL = 6
        const val STYLE_GFORCE = 7

        const val ROLE_PRIMARY = 0
        const val ROLE_SECONDARY = 1

        const val RING_NONE = 0
        const val RING_TICK = 1

        // ---- 卡片外观覆盖（GaugeItem.cardStyle）----
        /** 跟随主题（= `cardStyle` 为 null 时的行为） */
        const val CARD_THEME = 0
        /** 无边框：去掉描边，保留卡片底色 */
        const val CARD_NO_BORDER = 1
        /** 完全透明卡片：底色与描边都不要，仪表直接叠在背景上 */
        const val CARD_TRANSPARENT = 2
        /** 不画卡片：连圆角矩形都不建（与 [CARD_TRANSPARENT] 观感相同，但少一次 Drawable 分配） */
        const val CARD_NONE = 3

        /** 覆盖项的中文名。下标与 `CARD_*` 对应，供 UI 直接当下拉框选项 */
        val CARD_NAMES = listOf("跟随主题", "无边框", "完全透明卡片", "不画卡片")

        /** 把 `CARD_*` 解释成中文名；未知值回落到「跟随主题」 */
        fun cardName(style: Int?): String =
            CARD_NAMES.getOrElse(style ?: CARD_THEME) { CARD_NAMES[CARD_THEME] }

        fun fromJson(o: JSONObject): GaugeItem {
            val hasLayout = o.has("x") && o.has("y") && o.has("w") && o.has("h")
            // 旧文件没有 "unit" 字段 —— 那时存的是归一化 0..1，读到要 ×CANVAS。
            // 新文件写的是 360，系数为 1。
            val k = if (o.optInt("unit", 0) == CANVAS.toInt()) 1f else CANVAS
            val extras = mutableListOf<String>()
            o.optJSONArray("extraPids")?.let { a ->
                for (i in 0 until a.length()) extras.add(a.optString(i))
            }
            return GaugeItem(
                pidId = o.optString("pid"),
                extraPids = extras,
                style = o.optInt("style", STYLE_CIRCLE),
                minVal = o.optDouble("min", 0.0).toFloat(),
                maxVal = o.optDouble("max", 100.0).toFloat(),
                warnLow = if (o.has("warnLow")) o.optDouble("warnLow").toFloat() else null,
                warnHigh = if (o.has("warnHigh")) o.optDouble("warnHigh").toFloat() else null,
                color = o.optInt("color", -1),
                span = o.optInt("span", 1),
                x = o.optDouble("x", 0.0).toFloat() * k,
                y = o.optDouble("y", 0.0).toFloat() * k,
                w = o.optDouble("w", 1.0).toFloat() * k,
                h = o.optDouble("h", 0.25).toFloat() * k,
                role = o.optInt("role", ROLE_PRIMARY),
                ringStyle = o.optInt("ringStyle", RING_NONE),
                ringSegments = o.optInt("ringSegments", 40),
                neonPreset = o.optString("neonPreset", "").takeIf { it.isNotBlank() },
                // 旧文件没有这个字段 → null = 跟随主题（与旧行为完全一致，无需迁移）
                cardStyle = if (o.has("cardStyle")) o.optInt("cardStyle", CARD_THEME) else null
            ).also { it.legacyGrid = !hasLayout }
        }
    }
}

// ---------------------------------------------------------------- 运行时数据

data class PidValue(
    val pidId: String,
    val value: Float,
    val rawHex: String,
    val ts: Long,
    val ok: Boolean,
    val error: String? = null
)
