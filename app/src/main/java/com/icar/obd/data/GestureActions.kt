package com.icar.obd.data

/**
 * **双指手势 → 动作** 的映射表（v1.20.9；v1.20.10 加「切上/下一个 tab」）。
 *
 * ## 为什么要有这一份
 *
 * v1.20.4 把「呼出导航 / 收起导航」**写死**在 `MainActivity.dispatchTouchEvent` 里，
 * 而且只有左右两个方向。用户要的是**可自定义**：4 个方向各选一个动作，
 * 上下两个方向是新加的（原先是空的）。
 *
 * ## 两个刻意的取舍
 *
 * 1. **动作只允许「导航类 + 翻页类」** —— 刻意**不给**"进入编辑态 / 全屏切换 / 跳指定页"。
 *    双指手势是**误触代价很高**的输入：它没有视觉落点、没有确认框、手指落点也不精确。
 *    编辑态会改盘面、全屏会藏掉导航栏、跳页会离开仪表盘 —— 这三件事误触的代价
 *    与"呼出导航"完全不对等，所以不进这张表。
 *    ⚠️ 「切上/下一个 tab」（v1.20.10）**不违反**这一条：它是在**相邻**页之间循环，
 *    不是"跳指定页"，而且它是用户点名要的。它的默认值是 [NONE]。
 * 2. **表只有一份，执行也只有一个地方**（`MainActivity` 查表执行）。
 *    设置页**只负责编辑这张表**。两处各写一套执行逻辑的后果不是"多几行"，
 *    而是"设置页显示的映射"与"真的执行的动作"慢慢分叉 —— 本项目因"两份权威"栽过三次。
 *
 * ## 为什么判定放在 `data/` 而不是 Fragment 里
 *
 * 方向判定（[slotOf]）、取值归一化（[normalize]）、摘要文案（[summary]）、
 * **相邻 tab 计算**（[adjacentTab]）全是**纯函数**，
 * 放这里才能被 JVM 单测覆盖。写进 Fragment 的话一条都测不到，而"旧配置缺字段"、
 * "手改坏的 JSON"、"循环边界"恰恰是最容易悄悄坏的地方。
 */
object GestureActions {

    // ---------------------------------------------------------------- 动作

    /** 什么都不做（**显式**的"无"，不是一个空字符串 —— 空串会与"缺字段"混起来） */
    const val NONE = "none"

    /** 呼出导航栏（等价于原来的"双指右滑"） */
    const val NAV_SHOW = "nav_show"

    /** 收起导航栏（等价于原来的"双指左滑"） */
    const val NAV_HIDE = "nav_hide"

    /** 切上一套画布（**只在仪表盘页有意义**，见 `MainActivity.runGesture`） */
    const val CANVAS_PREV = "canvas_prev"

    /** 切下一套画布（同上） */
    const val CANVAS_NEXT = "canvas_next"

    /**
     * 切到**上一个导航页**（v1.20.10）—— 在 6 个 tab 之间**循环**。
     *
     * ## 为什么这两个动作排在表尾
     *
     * [ACTION_IDS] 的下标同时被 `Store.Settings` 与设置页 Spinner 使用。
     * 追加在末尾，原有 5 个动作的下标**一个都不动** —— 一份旧的
     * `settings.json` 读回来仍然落在同一个动作上。
     */
    const val TAB_PREV = "tab_prev"

    /** 切到**下一个导航页**（同上，循环） */
    const val TAB_NEXT = "tab_next"

    /** 全部可选动作的 id，顺序 = 设置页对话框里的顺序 */
    val ACTION_IDS = listOf(NONE, NAV_SHOW, NAV_HIDE, CANVAS_PREV, CANVAS_NEXT, TAB_PREV, TAB_NEXT)

    /** 与 [ACTION_IDS] **一一对应**的动作名（下标相同才是同一个动作） */
    val ACTION_NAMES = listOf(
        "无", "呼出导航", "收起导航", "切上一套画布", "切下一套画布", "切上一个 tab", "切下一个 tab"
    )

    // ---------------------------------------------------------------- 手势槽位

    const val SLOT_LEFT = 0
    const val SLOT_RIGHT = 1
    const val SLOT_UP = 2
    const val SLOT_DOWN = 3
    const val SLOT_COUNT = 4

    /** 与槽位下标一一对应的手势名（设置页与日志都用它，不许再写第二份） */
    val SLOT_NAMES = listOf("双指左滑", "双指右滑", "双指上滑", "双指下滑")

    /**
     * 出厂默认值。
     *
     * **左右保持 v1.20.4 的既有手感**（右滑呼出、左滑收起）—— 升级不该改变用户已经
     * 练熟的动作；上下是本次新增，给"翻页"（比"再去点一下导航栏"顺手得多）。
     *
     * ⚠️ **两个新动作（切上一个/下一个 tab）刻意不在这里** —— 它们的默认值是
     * [NONE]。v1.20.10 之前**根本没有这两个动作**，所以"升级后某个方向突然开始切页"
     * 是最不能接受的一种变化（用户会以为手势坏了）。**新动作的默认值必须是「无」**，
     * 这一条有单测钉着（`GestureActionsTest`）。
     */
    val DEFAULTS = listOf(NAV_HIDE, NAV_SHOW, CANVAS_NEXT, CANVAS_PREV)

    // ---------------------------------------------------------------- 导航页顺序

    /**
     * 6 个导航页的 **tag**，顺序 = 底部导航栏里的顺序（= 循环顺序）。
     *
     * ## 为什么是 tag 而不是 `R.id.nav_*`
     *
     * `R.id` 是 UI 层的东西，而这一份在 `data/` 里 —— `data/` 不能反向依赖
     * `ui/`（分层红线）。tag 是字符串，两边都能用：`MainActivity.switchTo`
     * 的 `itemId → tag` 映射与这里的 tag 对得上，于是**循环切页直接复用
     * `switchTo`**，不需要另写一套页面切换。
     *
     * ## ⚠️ 顺序只有这一处
     *
     * 菜单 XML（`res/menu/bottom_nav.xml`）是"导航栏长什么样"的权威，
     * 这里是"循环切页按什么顺序"的权威 —— 两者必须一致，改一处要同时改另一处。
     * 刻意**不在 `MainActivity` 里再写一遍**：`GestureActions.adjacentTab` 是纯函数，
     * 写进 Activity 就一条都测不到，而"循环边界"恰恰是最容易写错的地方
     * （最后一个的"下一个"要回到第一个）。
     */
    val TAB_TAGS = listOf("dash", "connect", "pid", "rule", "log", "knowledge")

    // ---------------------------------------------------------------- 纯函数

    /**
     * 把一次双指位移判成一个手势槽位。
     *
     * @param dx 双指**中点**的横向位移（正 = 向右）
     * @param dy 双指**中点**的纵向位移（正 = 向下，屏幕坐标系）
     * @param threshold 触发阈值（dp 换算后的像素）。传 <= 0 一律不触发
     * @return 槽位下标；**没有达到阈值返回 -1**（不是 SLOT_* 里的任何一个）
     *
     * 先比主轴（`|dx|` 与 `|dy|` 谁大）再比阈值：反过来判的话，一次"斜着划"
     * 会先满足横向阈值而被当成横滑 —— 而斜划在双指里非常常见（两根手指不可能完全同步）。
     */
    fun slotOf(dx: Float, dy: Float, threshold: Float): Int {
        if (threshold <= 0f) return -1
        return if (kotlin.math.abs(dx) >= kotlin.math.abs(dy)) {
            when {
                dx >= threshold -> SLOT_RIGHT
                dx <= -threshold -> SLOT_LEFT
                else -> -1
            }
        } else {
            when {
                dy >= threshold -> SLOT_DOWN
                dy <= -threshold -> SLOT_UP
                else -> -1
            }
        }
    }

    /**
     * 取值归一化：**认得的 id 原样返回，认不得的落回该槽位的默认值**。
     *
     * 为什么不落回 [NONE]：旧配置（v1.20.8 及以前）**根本没有这四个键**，
     * 用户升级后第一次双指右滑必须还是"呼出导航"。落回 NONE 的话，
     * 表现为"升级之后手势全没了" —— 那正是这一版要避免的事。
     */
    fun normalize(slot: Int, id: String?): String {
        val v = id?.trim().orEmpty()
        if (ACTION_IDS.contains(v)) return v
        return DEFAULTS[slot.coerceIn(0, SLOT_COUNT - 1)]
    }

    /** 动作 id → 中文名（认不得的当"无"，与 [normalize] 的兜底口径一致） */
    fun actionName(id: String?): String {
        val i = ACTION_IDS.indexOf(id?.trim().orEmpty())
        return if (i < 0) ACTION_NAMES[0] else ACTION_NAMES[i]
    }

    /** 动作 id → 在 [ACTION_IDS] 里的下标（给 Spinner 用；认不得的当"无"） */
    fun actionIndex(id: String?): Int =
        ACTION_IDS.indexOf(id?.trim().orEmpty()).let { if (it < 0) 0 else it }

    /** 槽位下标 → 短手势名（摘要文案里用，如 `双指右滑` → `右滑`） */
    fun shortSlotName(slot: Int): String =
        SLOT_NAMES[slot.coerceIn(0, SLOT_COUNT - 1)].removePrefix("双指")

    /**
     * 按顺序走到相邻的下一个 tag，**循环**（v1.20.10）。
     *
     * ## 循环边界（这一版最该被钉住的地方）
     *
     * - 最后一个 tag 的 [TAB_NEXT] → **第一个**；
     * - 第一个 tag 的 [TAB_PREV] → **最后一个**。
     *
     * 不循环的实现（`index + delta` 直接取）在边界上会返回 null，
     * 表现为"在知识库页往上滑一下什么都没发生" —— 而用户会以为手势坏了，
     * 不会想到"这是最后一项"。所以这里一律 `floorMod` 回绕。
     *
     * ## 认不得的输入一律返回 null（**不是**落回第一个）
     *
     * `current` 可能是空串（还没切过页）或一个手改坏的 tag。落回第一个的话，
     * 一次手势会**把用户从任何页面拽到仪表盘** —— 那是"跳页"，正是这张表
     * 刻意不给的能力。返回 null 让调用方自己决定（现在的做法：什么都不做并记日志）。
     *
     * @param actionId 只认 [TAB_PREV] / [TAB_NEXT]，其余一律 null
     */
    fun adjacentTab(actionId: String, current: String?): String? {
        val delta = when (actionId) {
            TAB_NEXT -> 1
            TAB_PREV -> -1
            else -> return null
        }
        return adjacentTab(current, delta)
    }

    /** [adjacentTab] 的位移形式（+1 = 下一个，-1 = 上一个；其余值不认） */
    fun adjacentTab(current: String?, delta: Int): String? {
        if (delta != 1 && delta != -1) return null
        val i = TAB_TAGS.indexOf(current)
        if (i < 0) return null
        val n = TAB_TAGS.size
        return TAB_TAGS[Math.floorMod(i + delta, n)]
    }

    /** 这个动作是不是"切 tab"类（`MainActivity` 用它决定走哪条分支） */
    fun isTabAction(actionId: String?): Boolean =
        actionId == TAB_PREV || actionId == TAB_NEXT

    /**
     * 当前映射的**一句话总结**（设置页那一行就用它）。
     *
     * 例：`当前：右滑呼出导航 · 上滑下一套画布 · 其余无`
     *
     * 只列**有动作**的手势（4 个都列出来会又长又难扫），末尾按需补一句"其余无"。
     * 刻意**不在这里**做省略号截断 —— 截断会让用户以为某个手势没配上。
     */
    fun summary(map: List<String>): String {
        val on = ArrayList<String>()
        var anyNone = false
        for (slot in 0 until SLOT_COUNT) {
            val id = normalize(slot, map.getOrNull(slot))
            if (id == NONE) {
                anyNone = true
                continue
            }
            on += shortSlotName(slot) + shortAction(id)
        }
        if (on.isEmpty()) return "当前：四个手势都是「无」（仪表盘上仍可双击呼出导航）"
        return "当前：" + on.joinToString(" · ") + if (anyNone) " · 其余无" else ""
    }

    /** 摘要里用的**短动作名**：与 [ACTION_NAMES] 是同一件事的两种长度 */
    private fun shortAction(id: String): String = when (id) {
        NAV_SHOW -> "呼出导航"
        NAV_HIDE -> "收起导航"
        CANVAS_PREV -> "上一套画布"
        CANVAS_NEXT -> "下一套画布"
        TAB_PREV -> "上一个 tab"
        TAB_NEXT -> "下一个 tab"
        else -> "无"
    }
}
