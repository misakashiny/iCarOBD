package com.icar.obd.data

/**
 * **灵动岛提示的样式**（v1.20.13）—— 用户原话：
 * 「灵动岛的通知我希望可以自定义样式」。
 *
 * ## 为什么是"有界"的一张表，而不是一个自由样式编辑器
 *
 * 自由样式（任意坐标 / 任意宽高 / 任意透明度 / 任意字号）在这个东西上**有害**：
 *
 *  1. 它悬在画布正上方，**任意坐标**意味着用户可以把它拖到正中间 ——
 *     那正是 v1.20.12 花了整整一版修掉的病（浮层盖住画布）。
 *  2. 它的存在意义是"4 秒内看清一句话"，**任意字号**能小到看不见、大到占半屏。
 *  3. 任意透明度会让它淡到读不出来，而用户会以为"提示坏了"。
 *
 * 所以这里只给**五组有限选项**：位置 3 / 尺寸 3 / 圆角 3 / 停留 3 / 配色 2 + 色板。
 * 每一组都有默认值，**默认值 = v1.20.12 的样子**（见 [POS_DEFAULT] 等），
 * 所以升级后观感**逐像素不变**（这一条有单测钉着：`IslandStyleTest`）。
 *
 * ## 为什么放在 `data/` 而不是 `ui/view/`
 *
 * 它要被 [Store.Settings] 引用（落盘），而 `data/` **不能反向依赖 `ui/`**（红线 4.1.7）。
 * 顺带一个好处：归一化 / 摘要 / 取值全是**纯函数**，JVM 单测直接覆盖
 * —— "旧配置缺字段兜默认"、"手改坏的 settings.json" 恰恰是最容易悄悄坏的地方
 * （与 [GestureActions] 同一条理由）。
 *
 * ## 与三条硬约束的关系（**没有一条被放松**）
 *
 * | 约束 | 本文件怎么保证 |
 * |---|---|
 * | ① 不盖住画布 | 位置只有"顶部三个水平档"，**没有纵向自由度**；`ui/view/IslandCapsuleView` 仍是 `WRAP_CONTENT` 浮层 |
 * | ② 不抢触摸 | 本文件不碰触摸；胶囊由 `IslandCapsuleView` 统一设 `isClickable=false` |
 * | ③ 与监听警示条错开 | 位置只改**水平**对齐，纵向永远由 `MonitorWarnBar.heightPx()` 的让位偏移决定 |
 */
object IslandStyle {

    // ================================================================ 位置

    /** 顶部居中（v1.20.12 的样子） */
    const val POS_CENTER = 0

    /** 顶部靠左 */
    const val POS_START = 1

    /** 顶部靠右 */
    const val POS_END = 2

    const val POS_COUNT = 3

    /** 与 [POS_CENTER] / [POS_START] / [POS_END] 一一对应（下标相同才是同一个位置） */
    val POS_NAMES = listOf("顶部居中", "顶部靠左", "顶部靠右")

    /** **默认 = v1.20.12 的样子**（顶部居中） */
    const val POS_DEFAULT = POS_CENTER

    // ================================================================ 尺寸

    const val SIZE_SMALL = 0
    const val SIZE_MEDIUM = 1
    const val SIZE_LARGE = 2
    const val SIZE_COUNT = 3

    val SIZE_NAMES = listOf("小", "中", "大")

    /** **默认 = v1.20.12 的样子**（13sp / 14dp / 7dp） */
    const val SIZE_DEFAULT = SIZE_MEDIUM

    /**
     * 每一档的**字号**（sp）、**横向内边距**（dp）、**纵向内边距**（dp）。
     *
     * 三个数组**下标一一对应**，长度必须都等于 [SIZE_COUNT]（有单测钉着）。
     * 拆成三个数组而不是一个 `data class` 列表：Spinner 的下标就是档位，
     * 多一层对象只会让"下标 ↔ 档位"多一处可以对不上的地方。
     */
    val SIZE_TEXT_SP = listOf(12f, 13f, 15f)
    val SIZE_PAD_H_DP = listOf(12, 14, 18)
    val SIZE_PAD_V_DP = listOf(6, 7, 9)

    // ================================================================ 圆角

    const val CORNER_SMALL = 0
    const val CORNER_MEDIUM = 1
    const val CORNER_LARGE = 2
    const val CORNER_COUNT = 3

    val CORNER_NAMES = listOf("小", "中", "大（胶囊）")

    /** **默认 = v1.20.12 的样子**（18dp → 矮胶囊上被夹成"全圆角"） */
    const val CORNER_DEFAULT = CORNER_LARGE

    /**
     * 每一档的圆角半径（dp）：6 / 12 / 18。
     *
     * ⚠️ `GradientDrawable` 会把半径**夹到高度的一半**，所以 18dp 在默认尺寸上
     * 渲染出来就是"全圆角胶囊" —— 与 v1.20.12 写死的那个 18dp **完全一致**。
     * 换成"999dp 表示胶囊"反而会让"中"和"大"看起来一模一样（都被夹到同一处），
     * 所以三档给三个**真的不同**的半径。
     */
    val CORNER_RADIUS_DP = listOf(6, 12, 18)

    // ================================================================ 停留时长

    /** 可选停留时长（毫秒）。**给选项而不是让用户敲数字** —— 它直接决定提示赖多久 */
    val HOLD_CHOICES_MS = listOf(2000, 4000, 6000)

    val HOLD_NAMES = listOf("2 秒", "4 秒", "6 秒")

    /** **默认 = v1.20.12 的样子**（4 秒，与 `IslandStateMachine.HOLD_MS` 同值） */
    const val HOLD_DEFAULT_MS = 4000

    // ================================================================ 配色

    /** 跟随主题（默认） */
    const val COLOR_THEME = 0

    /** 自定义背景色 + 文字色 */
    const val COLOR_CUSTOM = 1

    const val COLOR_COUNT = 2

    /**
     * 与 [COLOR_THEME] / [COLOR_CUSTOM] 一一对应。
     *
     * 刻意**不带「（默认）」后缀** —— 这一份同时被设置页那一行小字用
     * （`当前：… · 跟随主题`），带上后缀那行字会又长又难扫。
     * "哪一档是默认"由对话框的字段标签说（见 `showIslandDialog`）。
     */
    val COLOR_MODE_NAMES = listOf("跟随主题", "自定义")

    /** **默认 = v1.20.12 的样子**（跟随主题） */
    const val COLOR_MODE_DEFAULT = COLOR_THEME

    /**
     * 「跟随主题」解析出来的**底色** —— 就是 v1.20.12 写死在 `IslandNotice` 里的那个值。
     *
     * ## 为什么它是常量而不是从 `GaugeTheme` 派生
     *
     * 用户的要求里有一条硬约束：**默认值 = 现在的样子（升级不改变观感）**。
     * 从画布主题派生（例如取当前主题的 `surface` / `background`）会**改变**
     * 升级后的观感 —— 两者不能同时成立。
     *
     * 所以这一版的做法是：**"跟随主题" = App 自己的深色浮层配色**（与
     * `MonitorWarnBar` 同一取向：深底 + 亮字，阳光下看得清）。
     * 以后真要接主题 token，**只改这一个函数**（[spec]）就够了。
     */
    const val THEME_BG = 0xF01A1F27.toInt()

    /** 「跟随主题」解析出来的**正文颜色** */
    const val THEME_FG = 0xFFFFFFFF.toInt()

    /** 「跟随主题」时 `+N` 计数的强调色（沿用 v1.20.12 的琥珀） */
    const val THEME_ACCENT = 0xFFFFD400.toInt()

    /** 胶囊描边：极淡的一道白边，让它在浅色背景图上也有轮廓（沿用 v1.20.12） */
    const val STROKE = 0x33FFFFFF

    /**
     * 底色候选（有界调色板，对话框里就是这一排色块）。
     *
     * 与 [BG_PRESET_NAMES] **下标一一对应**（有单测钉着）。
     * 第一个就是「跟随主题」那个值 —— 用户想"自定义成默认色"时能一眼找到它。
     */
    val BG_PRESETS = intArrayOf(
        THEME_BG,                    // 深色胶囊（= 跟随主题）
        0xF0000000.toInt(),          // 纯黑
        0xF0141A23.toInt(),          // 卡片
        0xF01C2430.toInt(),          // 卡片次级
        0xF0B3261E.toInt(),          // 警示红（与监听警示条同色）
        0xF0FFB020.toInt(),          // 琥珀
        0xF0FFFFFF.toInt(),          // 白
        0xF04DA3FF.toInt(),          // 信息蓝
    )

    val BG_PRESET_NAMES = listOf("深色胶囊", "纯黑", "卡片", "卡片次级", "警示红", "琥珀", "白", "信息蓝")

    /** 文字色候选（有界调色板），与 [FG_PRESET_NAMES] 下标一一对应 */
    val FG_PRESETS = intArrayOf(
        THEME_FG,                    // 白
        0xFF000000.toInt(),          // 黑
        0xFFFFD400.toInt(),          // 黄
        0xFF00D8FF.toInt(),          // 青
    )

    val FG_PRESET_NAMES = listOf("白", "黑", "黄", "青")

    // ================================================================ 归一化（纯函数）

    /** 认得的档位原样返回，**认不得的落回默认值**（不是夹到边界 —— 见类注释） */
    fun normalizePos(v: Int): Int = if (v in 0 until POS_COUNT) v else POS_DEFAULT

    fun normalizeSize(v: Int): Int = if (v in 0 until SIZE_COUNT) v else SIZE_DEFAULT

    fun normalizeCorner(v: Int): Int = if (v in 0 until CORNER_COUNT) v else CORNER_DEFAULT

    fun normalizeColorMode(v: Int): Int = if (v in 0 until COLOR_COUNT) v else COLOR_MODE_DEFAULT

    /** 停留时长：**必须在候选里**，否则落回默认（手改坏的 `999999` 不该让它赖着不走） */
    fun normalizeHoldMs(v: Int): Int = if (HOLD_CHOICES_MS.contains(v)) v else HOLD_DEFAULT_MS

    /**
     * 颜色归一化。
     *
     * **全透明（alpha == 0）一律落回兜底值** —— 它等于"这个胶囊看不见"，
     * 而用户看到的表现是"提示坏了"，不是"我设成全透明了"。
     * 其余取值（含半透明）原样保留：那是**有意的**样式选择。
     */
    fun normalizeColor(v: Int, fallback: Int): Int =
        if (((v ushr 24) and 0xFF) == 0) fallback else v

    // ================================================================ 解析结果

    /**
     * 一条**已经解析好**的样式：UI 层照着设属性，**不再做任何判断**。
     *
     * 为什么要有这一层：`IslandNotice` 每次弹提示都要判断一遍"位置是几号、字号多少、
     * 用哪个颜色"，判断散在 View 代码里就一条都测不到。这里全部收进 [spec]，
     * 于是"默认值等于 v1.20.12 的样子"这种事**可以在 JVM 里断言**。
     */
    data class Spec(
        val pos: Int,
        val size: Int,
        val corner: Int,
        /** 停留时长（毫秒） */
        val holdMs: Long,
        /** 胶囊底色（已解析：跟随主题 → [THEME_BG]） */
        val bg: Int,
        /** 正文颜色（已解析：跟随主题 → [THEME_FG]） */
        val fg: Int,
        /** `+N` 的颜色（跟随主题 → [THEME_ACCENT]；自定义 → 跟正文色） */
        val accent: Int,
    ) {
        val textSp: Float get() = SIZE_TEXT_SP[size]
        val padHdp: Int get() = SIZE_PAD_H_DP[size]
        val padVdp: Int get() = SIZE_PAD_V_DP[size]
        val cornerDp: Int get() = CORNER_RADIUS_DP[corner]
    }

    /**
     * 把「落盘的原始取值」解析成 [Spec]。
     *
     * ⚠️ 每一个入参都过一遍归一化 —— 调用方可能给的是**手改坏的 `settings.json`**，
     * 也可能是"旧配置里根本没有这个键"（`optInt` 的兜底值）。两种情况在这里合流。
     */
    fun spec(
        pos: Int,
        size: Int,
        corner: Int,
        holdMs: Int,
        colorMode: Int,
        bg: Int,
        fg: Int,
    ): Spec {
        val custom = normalizeColorMode(colorMode) == COLOR_CUSTOM
        val fgColor = if (custom) normalizeColor(fg, THEME_FG) else THEME_FG
        return Spec(
            pos = normalizePos(pos),
            size = normalizeSize(size),
            corner = normalizeCorner(corner),
            holdMs = normalizeHoldMs(holdMs).toLong(),
            bg = if (custom) normalizeColor(bg, THEME_BG) else THEME_BG,
            fg = fgColor,
            // 自定义模式下 `+N` **也跟正文色**：底色可能是浅色（白/琥珀），
            // 固定的强调黄在白底上读不出来 —— 而"还有别的"这件事不能丢
            accent = if (custom) fgColor else THEME_ACCENT,
        )
    }

    // ================================================================ 摘要

    /** 停留时长 → 在 [HOLD_CHOICES_MS] 里的下标（给 Spinner 用；认不得的当默认档） */
    fun holdIndex(v: Int): Int =
        HOLD_CHOICES_MS.indexOf(normalizeHoldMs(v)).let { if (it < 0) HOLD_CHOICES_MS.indexOf(HOLD_DEFAULT_MS) else it }

    /**
     * 设置页那一行「当前：…」。
     *
     * 例：`当前：顶部居中 · 中 · 圆角大（胶囊） · 4 秒 · 跟随主题`
     *
     * 与 [GestureActions.summary] 同一条理由：改完设置之后，界面上得有一眼能看到的
     * 痕迹（否则用户只能靠"再触发一条规则看看"来确认）。
     */
    fun summary(pos: Int, size: Int, corner: Int, holdMs: Int, colorMode: Int): String =
        "当前：" +
            POS_NAMES[normalizePos(pos)] + " · " +
            SIZE_NAMES[normalizeSize(size)] + " · " +
            "圆角" + CORNER_NAMES[normalizeCorner(corner)] + " · " +
            HOLD_NAMES[holdIndex(holdMs)] + " · " +
            COLOR_MODE_NAMES[normalizeColorMode(colorMode)]

    /** `#RRGGBB`（对话框里的色值提示用；与 `ThemeEditorActivity.hexOf` 同一格式） */
    fun hexOf(color: Int): String = String.format("#%06X", color and 0xFFFFFF)

    /**
     * `#RRGGBB` / `#AARRGGBB` → ARGB。**认不出来返回 null**（调用方负责提示用户）。
     *
     * 纯函数放这里而不是 Fragment 里：`ThemeEditorActivity` 有一份**一模一样**的私有实现，
     * 但那是 Activity 的私有方法、测不到。这一段（解析 + 全透明兜底）恰恰是
     * "用户手打一个色值"最容易出错的地方，所以放进 `data/` 让 JVM 单测覆盖。
     *
     * 6 位一律按**不透明**补 `FF`（用户打 `#FFFFFF` 想要的就是白色，
     * 补成 `00FFFFFF` 会得到一个看不见的胶囊）。
     */
    fun parseHex(s: String?): Int? {
        val t = s?.trim()?.removePrefix("#") ?: return null
        if (t.isEmpty()) return null
        val v = t.toLongOrNull(16) ?: return null
        return when (t.length) {
            6 -> (0xFF000000L or v).toInt()
            8 -> v.toInt()
            else -> null
        }
    }
}
