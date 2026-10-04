package com.icar.obd.data

/**
 * 仪表盘布局：**内置布局** + **预设布局** + **旧配置迁移**。
 *
 * ## 为什么放在 `data/` 而不是 `ui/dash/`
 *
 * 这里只有纯数据变换（`List<GaugeItem>` → `List<GaugeItem>`），没有任何 Android UI 依赖；
 * 而且 [Store] 在加载 `dash.json` 时就要调用迁移 —— 若把本文件放进 `ui/dash/`，
 * 就会变成 `data → ui` 的反向依赖，违反分层红线。
 *
 * ## 坐标约定
 *
 * 所有布局用**归一化坐标** `x/y/w/h ∈ [0,1]`（相对画布宽高，y 向下）。
 * 这样同一份配置在手机竖屏与平板横屏上都成立，不必为每个方向存一套。
 *
 * ## 量程从哪来
 *
 * 预设里的量程/报警值**一律从 [BuiltInPids] 取**（见 [fromPid]），不写死数字 ——
 * 否则以后改了 PID 库的量程，预设就会和它不一致。
 */
object DashLayout {

    // ================================================================ 预设

    data class Preset(
        val id: String,
        val title: String,
        val description: String,
        val build: () -> List<GaugeItem>
    )

    /** 全部预设布局。UI 直接遍历它生成选择列表。 */
    fun presets(): List<Preset> = listOf(
        Preset("normal", "普通驾驶", "车速圆表 + 转速数字 + 四条日常指标") { normal() },
        Preset("perf", "性能模式", "转速圆表 + 车速数字 + 动力相关四联") { perf() },
        Preset("line", "线型图", "四条趋势曲线，看变化而不是看瞬时值") { line() },
        Preset("dual", "双数据 + 上下", "两张大卡，每张上下两个数值") { dualStack() },
        Preset("quad", "四数据显示", "两张大卡，每张 2×2 四个数值") { quad() },
        Preset("subdual", "主 + 子双数据", "主参数大号显示，子参数并排小号") { subDual() },
        Preset("gforce", "G力值", "G 值大表 + 四个参考指标") { gForce() }
    )

    fun byId(id: String): List<GaugeItem>? =
        presets().firstOrNull { it.id == id }?.build?.invoke()

    // ---------------------------------------------------------- 内置三种

    fun normal(): List<GaugeItem> = listOf(
        fromPid("std_0D", GaugeItem.STYLE_CIRCLE, 0f, 0f, 0.5f, 0.40f),
        fromPid("std_0C", GaugeItem.STYLE_DIGITAL, 0.5f, 0f, 0.5f, 0.40f),
        fromPid("std_05", GaugeItem.STYLE_BAR, 0f, 0.40f, 0.5f, 0.20f),
        fromPid("std_42", GaugeItem.STYLE_BAR, 0.5f, 0.40f, 0.5f, 0.20f),
        fromPid("calc_l100", GaugeItem.STYLE_BAR, 0f, 0.60f, 0.5f, 0.20f),
        fromPid("std_04", GaugeItem.STYLE_BAR, 0.5f, 0.60f, 0.5f, 0.20f),
        fromPid("std_0F", GaugeItem.STYLE_BAR, 0f, 0.80f, 0.5f, 0.20f),
        fromPid("std_5C", GaugeItem.STYLE_BAR, 0.5f, 0.80f, 0.5f, 0.20f)
    )

    fun perf(): List<GaugeItem> = listOf(
        fromPid("std_0C", GaugeItem.STYLE_CIRCLE, 0f, 0f, 0.5f, 0.40f),
        fromPid("std_0D", GaugeItem.STYLE_DIGITAL, 0.5f, 0f, 0.5f, 0.40f),
        fromPid("std_11", GaugeItem.STYLE_BAR, 0f, 0.40f, 0.5f, 0.20f),
        fromPid("std_04", GaugeItem.STYLE_BAR, 0.5f, 0.40f, 0.5f, 0.20f),
        fromPid("std_0F", GaugeItem.STYLE_BAR, 0f, 0.60f, 0.5f, 0.20f),
        fromPid("std_05", GaugeItem.STYLE_BAR, 0.5f, 0.60f, 0.5f, 0.20f),
        fromPid("calc_boost", GaugeItem.STYLE_BAR, 0f, 0.80f, 0.5f, 0.20f),
        fromPid("std_10", GaugeItem.STYLE_BAR, 0.5f, 0.80f, 0.5f, 0.20f)
    )

    // ---------------------------------------------------------- 新预设

    /** 线型图：四条趋势曲线铺满一屏 */
    fun line(): List<GaugeItem> = listOf(
        fromPid("std_0C", GaugeItem.STYLE_LINE, 0f, 0f, 1f, 0.25f),
        fromPid("std_0D", GaugeItem.STYLE_LINE, 0f, 0.25f, 1f, 0.25f),
        fromPid("std_04", GaugeItem.STYLE_LINE, 0f, 0.50f, 1f, 0.25f),
        fromPid("std_05", GaugeItem.STYLE_LINE, 0f, 0.75f, 1f, 0.25f)
    )

    /** 双数据 + 上下：两张大卡，每张上主下副 */
    fun dualStack(): List<GaugeItem> = listOf(
        fromPid("std_0C", GaugeItem.STYLE_DUAL_STACK, 0f, 0f, 1f, 0.5f, extras = listOf("std_0D")),
        fromPid("std_05", GaugeItem.STYLE_DUAL_STACK, 0f, 0.5f, 1f, 0.5f, extras = listOf("std_42"))
    )

    /** 四数据显示：两张大卡，每张 2×2 */
    fun quad(): List<GaugeItem> = listOf(
        fromPid(
            "std_0C", GaugeItem.STYLE_QUAD, 0f, 0f, 1f, 0.5f,
            extras = listOf("std_0D", "std_05", "std_42")
        ),
        fromPid(
            "std_04", GaugeItem.STYLE_QUAD, 0f, 0.5f, 1f, 0.5f,
            extras = listOf("std_11", "std_0F", "std_5C")
        )
    )

    /** 主 + 子双数据：主参数大号，两个子参数并排小号 */
    fun subDual(): List<GaugeItem> = listOf(
        fromPid(
            "std_0C", GaugeItem.STYLE_SUB_DUAL, 0f, 0f, 1f, 0.5f,
            extras = listOf("std_0D", "std_04")
        ),
        fromPid(
            "std_05", GaugeItem.STYLE_SUB_DUAL, 0f, 0.5f, 1f, 0.5f,
            extras = listOf("std_0F", "std_5C")
        )
    )

    /** G力值：G 值大表 + 四个参考指标。大表用 [GaugeItem.STYLE_GFORCE]，副参数是横/纵分量。 */
    fun gForce(): List<GaugeItem> = listOf(
        fromPid(
            "calc_gforce", GaugeItem.STYLE_GFORCE, 0f, 0f, 1f, 0.60f,
            extras = listOf("calc_gx", "calc_gy")
        ),
        fromPid("std_0D", GaugeItem.STYLE_DIGITAL, 0f, 0.60f, 0.5f, 0.20f),
        fromPid("std_04", GaugeItem.STYLE_BAR, 0.5f, 0.60f, 0.5f, 0.20f),
        fromPid("std_0C", GaugeItem.STYLE_BAR, 0f, 0.80f, 0.5f, 0.20f),
        fromPid("std_05", GaugeItem.STYLE_BAR, 0.5f, 0.80f, 0.5f, 0.20f)
    )

    // ================================================================ 迁移

    /** 旧版网格是 2 列（竖屏语义），迁移时按它还原 */
    private const val LEGACY_COLS = 2

    /**
     * 把 v1.4.0 及以前「只有 span」的网格配置转成归一化自由坐标。
     *
     * 还原规则与旧 [com.icar.obd.ui.dash.DashRenderer] 一致：
     *  - `span=2` 占满一行，`span=1` 占半行；
     *  - 行高 = 该行内最高样式的自然高度占比（圆表 186 / 数字 92 / 条形 54 dp）。
     *
     * 就地修改 [items]，返回是否真的改动了任何一条。
     */
    fun migrateFromGrid(items: MutableList<GaugeItem>): Boolean {
        if (items.none { it.legacyGrid }) return false

        // 1) 先按 2 列网格算出每条的行列
        val placed = ArrayList<Triple<GaugeItem, Int, Int>>()
        var row = 0
        var col = 0
        for (it in items) {
            val span = it.span.coerceIn(1, LEGACY_COLS)
            if (col + span > LEGACY_COLS) { col = 0; row++ }
            placed.add(Triple(it, row, col))
            col += span
            if (col >= LEGACY_COLS) { col = 0; row++ }
        }
        val rowCount = if (col > 0) row + 1 else row
        if (rowCount <= 0) return false

        // 2) 行高按该行最高的样式权重
        val rowWeight = FloatArray(rowCount)
        placed.forEach { (item, r, _) ->
            rowWeight[r] = maxOf(rowWeight[r], naturalWeight(item.style))
        }
        val total = rowWeight.sum().let { if (it <= 0f) 1f else it }

        // 3) 累加出每行的 y，并按 span 定 x/w
        val rowTop = FloatArray(rowCount)
        var acc = 0f
        for (r in 0 until rowCount) {
            rowTop[r] = acc
            acc += rowWeight[r] / total
        }
        placed.forEach { (item, r, c) ->
            val span = item.span.coerceIn(1, LEGACY_COLS)
            val k = GaugeItem.CANVAS
            item.x = c.toFloat() / LEGACY_COLS * k
            item.y = rowTop[r] * k
            item.w = span.toFloat() / LEGACY_COLS * k
            item.h = rowWeight[r] / total * k
            item.legacyGrid = false
        }
        return true
    }

    /** 与旧渲染器的自然高度保持同比例（圆表 186 / 数字 92 / 条形 54 dp） */
    private fun naturalWeight(style: Int): Float = when (style) {
        GaugeItem.STYLE_CIRCLE -> 186f
        GaugeItem.STYLE_DIGITAL -> 92f
        GaugeItem.STYLE_LINE -> 120f
        GaugeItem.STYLE_DUAL_STACK -> 110f
        GaugeItem.STYLE_QUAD -> 110f
        GaugeItem.STYLE_SUB_DUAL -> 110f
        GaugeItem.STYLE_GFORCE -> 200f
        else -> 54f
    }

    // ================================================================ 拖拽数学

    /**
     * 拖拽编辑器的坐标运算。
     *
     * 抽成**纯函数**是为了能单测：吸附与夹取的边界（贴边、拖出画布、缩到最小）
     * 是最容易写出 off-by-one 的地方，而在 UI 里手测很难覆盖全。
     */
    object Drag {
        /** 吸附网格：画布分成 24 份。既能排整齐，又不至于只能落在少数几个位置 */
        const val GRID = 24

        /** 网格步长（**画布单位**，不是归一化）= 360 / 24 = 15 */
        const val STEP = GaugeItem.CANVAS / GRID

        /** 最小尺寸 = 2 格（刻意取网格整数倍，避免夹取后落在网格外） */
        const val MIN_SIZE = 2 * STEP

        fun snap(v: Float): Float = Math.round(v / STEP) * STEP

        /**
         * 可开关的吸附（v1.10.2）。
         *
         * `on = false` 时**原样返回** —— 用于「自由摆放」：想微调 3 个单位
         * 却被吸到 15 的倍数上，是拖拽编辑器最常见的抱怨。
         */
        fun snapIf(on: Boolean, v: Float): Float = if (on) snap(v) else v

        /**
         * 移动：先按需吸附，再夹进画布。
         *
         * ⚠️ **夹取永远生效，与吸附开关无关** —— 关掉的是"对齐网格"，
         * 不是"允许拖出画布"。把仪表拖到看不见的地方没有任何用途。
         */
        fun moveIf(on: Boolean, orig: Float, delta: Float, size: Float): Float =
            snapIf(on, orig + delta).coerceIn(0f, (GaugeItem.CANVAS - size).coerceAtLeast(0f))

        /** 缩放：先按需吸附，再夹住下界与右/下边界 */
        fun resizeIf(on: Boolean, orig: Float, delta: Float, pos: Float): Float =
            snapIf(on, orig + delta)
                .coerceIn(MIN_SIZE, (GaugeItem.CANVAS - pos).coerceAtLeast(MIN_SIZE))

        /** 移动：先吸附，再夹进画布（不能拖出边界） */
        fun move(orig: Float, delta: Float, size: Float): Float =
            moveIf(true, orig, delta, size)

        /** 缩放：先吸附，再夹住下界与右/下边界 */
        fun resize(orig: Float, delta: Float, pos: Float): Float =
            resizeIf(true, orig, delta, pos)
    }

    // ================================================================ 工具

    /**
     * 按 PID id 建一条仪表，**量程与报警值自动取自 PID 库**。
     * 找不到该 id 时退化为 0..100，不会崩。
     *
     * ⚠️ `x/y/w/h` 参数是**归一化 0..1** —— 预设里这样写可读性好，
     * 出口统一 ×[GaugeItem.CANVAS] 转成画布单位。
     */
    private fun fromPid(
        pidId: String,
        style: Int,
        x: Float, y: Float, w: Float, h: Float,
        role: Int = GaugeItem.ROLE_PRIMARY,
        extras: List<String> = emptyList(),
        ring: Int = GaugeItem.RING_NONE
    ): GaugeItem {
        val p = BuiltInPids.all().firstOrNull { it.id == pidId }
        val k = GaugeItem.CANVAS
        return GaugeItem(
            pidId = pidId,
            extraPids = extras.toMutableList(),
            style = style,
            minVal = p?.minVal ?: 0f,
            maxVal = p?.maxVal ?: 100f,
            warnLow = p?.warnLow,
            warnHigh = p?.warnHigh,
            x = x * k, y = y * k, w = w * k, h = h * k,
            role = role,
            ringStyle = ring
        )
    }
}
