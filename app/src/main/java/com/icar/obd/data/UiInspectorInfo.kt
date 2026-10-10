package com.icar.obd.data

/**
 * **控件检视器**的显示内容 —— 全部是纯函数（JVM 单测覆盖）。
 *
 * ## 为什么单独一份、为什么放在 `data/`
 *
 * 规格（`docs/下一步-控件检视器.md` §6）明确要求：
 * 「把"像素→dp/sp 换算"与"父链字符串拼装"抽成**纯函数**再测
 * （View 本身在 JVM 里碰不得，与 `FrameRateGate`/`CanvasRebuildPolicy` 同一套路）」。
 *
 * 所以这一份**只做字符串**：
 * - 输入是已经从 View 上读出来的**数值**（[InspectorSnapshot]）；
 * - 输出是面板上那一行行文本。
 *
 * 「读 View」那一半在 `ui/view/UiInspectorOverlay.kt`（那里必须碰 Android）。
 * 分界线的判据是：**这一段能不能在 JVM 单测里跑**。
 *
 * ## 三条显示纪律（都来自规格）
 *
 * 1. **拿不到就明说"（无）"，不要编**（§3）——
 *    `wrap_content` 的控件没有"声明的宽高"，那就显示**实测像素**并标注"实测"。
 * 2. **id 必须是资源名**（§5）—— 用户要拿它去 `UI样式与排版总表.md` 里搜 `文件:行`，
 *    给数字等于没给。拿不到资源名才是 [NO_ID]。
 * 3. **颜色/尺寸的格式固定**，不随调用方变 —— 否则复制出去的文本每次长得不一样。
 */
object UiInspectorInfo {

    /** 拿不到的信息一律显示这个，**不编**（规格 §3） */
    const val NONE = "（无）"

    /** 控件没有 id（`View.NO_ID`，或 id 存在但没有资源名） */
    const val NO_ID = "（无 id）"

    /** 这一下没点到任何控件（空白区 / 浮层自己） */
    const val NO_HIT = "（没点到控件）"

    /** 面板底部的固定提示（§5：让用户知道 id 拿去哪儿搜） */
    const val HINT_DOC = "搜这个 id 到 UI样式与排版总表.md"

    /** 仪表盘自绘区的提示（规格 §8：**必须给提示**，免得用户以为坏了） */
    const val HINT_SELF_DRAWN = "⚠ 这里是仪表盘自绘区：刻度/指针/数值不是控件，检视不到"

    /**
     * 操作提示（面板底部常驻）。
     *
     * v1.20.17：加上「清除」—— 面板上多了按钮，提示里不提它，
     * 用户就只会看见一个不知道干什么的小药丸。
     */
    const val HINT_OPS = "清除 = 只清面板内容 · 长按复制 · 拖动移动 · 右上角 × 关闭"

    // ------------------------------------------------------------ 清除（v1.20.17）

    /**
     * 面板上那个「清除」按钮的文案（v1.20.17，用户点名要的）。
     *
     * 用户原话：「检视器悬浮窗的按钮旁边加个按钮、按钮功能为 清除记录、
     * 按下后清除选中的记录」，并在 A/B/C 三个候选里**明确选了 B** ——
     * 面板只显示当前检视结果，按钮 = **清空面板内容**（回到占位）。
     *
     * ⚠️ 它**只清面板内容**：检视的开关（[TOGGLE_ON] / [TOGGLE_PAUSED]）一点不动，
     * 该接管还接管、该暂停还暂停。名字刻意用「清除」而不是「清空记录」——
     * 后者会让人以为在清日志/清数据。
     */
    const val CLEAR_LABEL = "清除"

    /** 「清除」按钮的 `contentDescription`（无障碍 / `uiautomator` 都要能认出它） */
    const val CLEAR_DESC = "清除面板内容（回到「点屏幕上任意控件查看信息」的占位）"

    /**
     * **占位态的标题** —— 面板刚挂上、以及点了「清除」之后，标题行显示的就是它。
     *
     * 与 [placeholderLines] 一样抽成常量：`show()` 与 `clearPanel()` 必须是
     * **同一份**占位内容，否则"清除后回到占位"这条判据就靠不住。
     */
    const val PLACEHOLDER_TITLE = "控件检视"

    /**
     * **占位态**的内容 —— 面板刚挂上、以及点了「清除」之后，显示的就是这一行。
     *
     * 抽成纯函数而不是把内容散在 `UiInspectorOverlay.show()` / 清除回调两处：
     * 那正是"清除之后回到的占位"与"刚打开时的占位"**迟早不一致**的写法，
     * 而判据（规格 §1）要的恰恰是"清除后**回到占位**"。
     */
    fun placeholderLines(): List<String> = listOf("点屏幕上任意控件查看它的信息")

    // ------------------------------------------------------------ 检视开关（v1.20.15）

    /**
     * 面板上那个开关的文案：**开**（正在接管触摸）。
     *
     * 用户原话：「悬浮窗上面加个检视器的开关」。
     * 开关与右上角的 `×` **不是一回事**，别合并：
     * - **暂停** → 面板留着、触摸放行（能正常用 App，随时能恢复）；
     * - **`×`** → 彻底关闭 + 摘掉浮层（要恢复得去设置页）。
     */
    const val TOGGLE_ON = "检视 开"

    /** 面板上那个开关的文案：**暂停**（面板还在，但触摸已放行） */
    const val TOGGLE_PAUSED = "检视 暂停"

    /** 开关此刻该显示什么字。纯函数，单测覆盖 */
    fun toggleLabel(paused: Boolean): String = if (paused) TOGGLE_PAUSED else TOGGLE_ON

    /**
     * **此刻检视是否真的在接管触摸** = 开着 且 没暂停。
     *
     * 抽成纯函数而不是在两个类里各写一遍 `enabled && !paused`：
     * 这三处（宿主消费触摸 / 强制导航栏可见 / 面板要不要抢触摸）**必须同一个判据**，
     * 否则会出现"触摸已经放行了，但导航栏还被强行按住"这类半吊子状态。
     */
    fun inspecting(enabled: Boolean, paused: Boolean): Boolean = enabled && !paused

    /**
     * 面板**本体**要不要抢触摸。
     *
     * - 检视中（没暂停）→ `true`：面板要能拖动、长按复制（此时整屏触摸本来就被消费）；
     * - **暂停 → `false`**：面板只剩开关与 `×` 两小块可点，
     *   **其余部分一律不抢触摸** —— 否则会挡住画布横滑与编辑态拖拽
     *   （用户明确点名的约束）。
     */
    fun panelStealsTouch(paused: Boolean): Boolean = !paused

    /**
     * 暂停时面板底部的提示（说明"现在能正常用 App，怎么恢复"）。
     *
     * ⚠️ v1.20.17 修文案：原来写「点左上角「检视 暂停」恢复接管」——
     * 而那个药丸在**标题行右侧**（不是左上角），用户照着找会找错地方。
     * 现在只说"点那个药丸"，不再编方位。
     */
    const val HINT_PAUSED = "已暂停：触摸已放行，App 可以正常用；点「检视 暂停」恢复接管"

    // ------------------------------------------------------------ 数值换算

    /**
     * 一位小数，整数不写 `.0`（`12.0` → `12`，`12.5` → `12.5`）。
     *
     * 为什么不用 `String.format("%.1f")`：那会把 12dp 写成 `12.0`，
     * 而这一屏的每一行都有数字，多出来的 `.0` 全是噪声。
     */
    fun num(v: Float): String {
        if (v.isNaN() || v.isInfinite()) return NONE
        val r = Math.round(v * 10f) / 10f
        val i = r.toInt()
        return if (r == i.toFloat()) i.toString() else r.toString()
    }

    /**
     * 像素 → dp 文本（不带单位，单位由调用方那一行统一写）。
     *
     * ⚠️ `density <= 0` 时**退回像素并标出来**：宁可显示 `48px`，
     * 也不能拿一个 0 密度除出 `Infinity` 摆给用户看。
     */
    fun dp(px: Int, density: Float): String =
        if (density <= 0f) "${px}px" else num(px / density)

    /** 像素 → sp 文本（同上，sp 用 `scaledDensity`，与字号是同一套换算） */
    fun sp(px: Float, scaledDensity: Float): String =
        if (scaledDensity <= 0f) "${num(px)}px" else num(px / scaledDensity)

    /** `#RRGGBB`（不透明）/ `#AARRGGBB`（带透明度）。不透明时不写 `FF` —— 短的那半够用 */
    fun colorHex(argb: Int): String {
        val a = (argb ushr 24) and 0xFF
        val rgb = argb and 0xFFFFFF
        return if (a == 0xFF) "#%06X".format(java.util.Locale.US, rgb)
        else "#%02X%06X".format(java.util.Locale.US, a, rgb)
    }

    /**
     * `LayoutParams` 里声明的宽/高 → 人话。
     *
     * `MATCH_PARENT = -1` / `WRAP_CONTENT = -2` 是 `ViewGroup.LayoutParams` 的常量值；
     * 这里刻意用**字面量**而不是 import `android.view.ViewGroup` ——
     * `data/` 层不碰 Android 类型，这一份才跑得进 JVM 单测。
     */
    fun specName(v: Int, density: Float): String = when {
        v == -1 -> "MATCH_PARENT"
        v == -2 -> "WRAP_CONTENT"
        v >= 0 -> "${dp(v, density)}dp"
        else -> NONE
    }

    // ------------------------------------------------------------ 单行

    /** 第 1 行：类型（简单类名） */
    fun typeLine(simpleName: String): String =
        simpleName.ifBlank { NONE }

    /** 第 2 行：id 的**资源名**（规格 §5 的命根子）。`null`/空 → [NO_ID] */
    fun idLine(entry: String?): String =
        if (entry.isNullOrBlank()) NO_ID else entry

    /**
     * 尺寸行。
     *
     * ⚠️ 规格 §3：「`wrap_content` 控件没有固定宽高 → 显示实测像素值并标注"实测"」。
     * 所以只有在**宽高都声明成固定 dp** 时才写"（声明）"，其余一律"（实测）"
     * 并把声明的值也摆出来 —— 用户看到 `48dp` 却不知道为什么这么宽时，
     * 答案就是后面那句 `声明 WRAP_CONTENT`。
     */
    fun sizeLine(
        wPx: Int, hPx: Int, density: Float, declaredW: Int, declaredH: Int
    ): String {
        val base = "尺寸 ${dp(wPx, density)}×${dp(hPx, density)}dp"
        val fixed = declaredW >= 0 && declaredH >= 0
        return if (fixed) "$base（声明）"
        else "$base（实测；声明 ${specName(declaredW, density)} × ${specName(declaredH, density)}）"
    }

    /**
     * 四边数值（**左/上/右/下**，与 `setPadding(l, t, r, b)` 一致 —— 换个顺序没人看得出来）。
     * 单独一个函数是因为「尺寸」那一行要把边距接在同一行里（规格 §3 的示意就是这样）。
     */
    fun quad(l: Int, t: Int, r: Int, b: Int, density: Float): String =
        "${dp(l, density)}/${dp(t, density)}/${dp(r, density)}/${dp(b, density)}"

    /** 四边数值行（边距 / 内边距共用） */
    fun boxLine(label: String, l: Int, t: Int, r: Int, b: Int, density: Float): String =
        "$label ${quad(l, t, r, b, density)}"

    /**
     * 字号 + 文字色。
     *
     * 非 `TextView` 的控件**也要出这一行**（显示"（无）"）——
     * 少一行会让人以为"面板漏了"，而"（无）"明确说的是"这个控件没有字号"。
     */
    fun textLine(textSizePx: Float?, colorArgb: Int?, scaledDensity: Float): String {
        val size = if (textSizePx == null) NONE else "${sp(textSizePx, scaledDensity)}sp"
        val color = if (colorArgb == null) NONE else colorHex(colorArgb)
        return "字号 $size  色 $color"
    }

    /**
     * `getResourceName` 的长名字 → 短名字。
     *
     * `Resources.getResourceName` 返回的是 `com.icar.obd:drawable/bg_input`，
     * 而全项目（包括 `UI样式与排版总表.md`）写的都是 `@drawable/bg_input` ——
     * 两种写法摆在一起会让人以为"面板给的资源名是错的"。
     * 认不出来的形态**原样返回**（不猜）。
     */
    fun shortResName(full: String?): String? {
        if (full.isNullOrBlank()) return null
        val slash = full.indexOf('/')
        if (slash <= 0) return full
        val type = full.substring(0, slash).substringAfterLast(':')
        val name = full.substring(slash + 1)
        if (type.isBlank() || name.isBlank()) return full
        return "@$type/$name"
    }

    /**
     * 背景。
     *
     * `getResourceName` **可能拿不到**（`ColorDrawable`、代码 new 出来的
     * `GradientDrawable`、`MaterialButton` 自己的背景等）——
     * 那时退化成**类名**（`GradientDrawable`），比"（无）"有用得多：
     * 至少能看出"这个背景是代码画的，不是 drawable 资源"。
     */
    fun backgroundLine(resName: String?, className: String?): String {
        val short = shortResName(resName)
        return when {
            short != null -> "背景 $short"
            !className.isNullOrBlank() -> "背景 $className（无资源名）"
            else -> "背景 $NONE"
        }
    }

    /** 可见性 + 可用。`0/4/8` = `View.VISIBLE/INVISIBLE/GONE`（字面量，同 [specName] 的理由） */
    fun stateLine(visibility: Int, enabled: Boolean): String {
        val vis = when (visibility) {
            0 -> "VISIBLE"
            4 -> "INVISIBLE"
            8 -> "GONE"
            else -> "#$visibility"
        }
        return "可见 $vis  可用 $enabled"
    }

    /** 单个类名最长显示多少字符（`MaterialTextView` 16 个字符，20 够用） */
    private const val NAME_MAX = 20

    /** 父链最大字符数。超了就从中间截 —— 面板是浮窗，撑宽了会盖住画布 */
    private const val CHAIN_MAX = 56

    /** 省略号（父链与类名截断共用） */
    private const val ELLIPSIS = "…"

    /** 父链分隔符 */
    private const val SEP = " > "

    /**
     * 父链：**从根到该控件**的类名路径（规格 §3 的"层级"）。
     *
     * ## 两条截断规则，都是"保住尾部"
     *
     * 1. **层数多**（>4）→ 中间省略：`A > B > … > Y > Z`；
     * 2. **还是太长** → 从**头部**按整段丢（`… > Y > Z`），最少留最后 2 段。
     *
     * 为什么都保尾部：尾部 = **最近的父容器**，那才是"这个控件挂在哪"的答案。
     * 实测踩过：第一版从尾巴砍，结果最有用的一段显示成 `… > M…`
     * （`MaterialTextView` 被砍成 `M…`），等于什么都没说。
     *
     * ## 🔴 v1.20.15 修：这里曾经是**死循环**（v1.20.14 的 ANR 根因）
     *
     * 旧写法是一个 `while (parts.size > 2 && body.length > CHAIN_MAX)` 循环，
     * 每轮做 `rest = parts.drop(1)` → 去掉开头的省略号 → `parts = [省略号] + rest`。
     * **第一轮之后 `parts` 的头部就是省略号**，于是 `drop(1)` 恰好只丢掉那个**标记**，
     * 紧接着 `listOf(ELLIPSIS) + rest` 又把它原样加回来 —— `parts` 与 `body`
     * 成为**不动点**：只要第一轮之后长度仍 > [CHAIN_MAX]，`while` 就**永不退出**。
     *
     * 触发窗口很窄但真实存在：链折叠成 5 段后
     * `|c1| + |c_{n-2}| + |c_{n-1}| > 42`（即长度 59 > 56）就进得去。
     * 实测在「连接」页点中一个 `MaterialButton`（父链里有
     * `ContentFrameLayout / LinearLayout / AppCompatImageView / MaterialButton`）就命中，
     * 主线程 100% CPU 卡在 `dispatchTouchEvent` 里 → InputDispatcher 等 5 秒 →
     * `am_anr: ... Waited 5000ms for MotionEvent(action=DOWN)`。
     * （栈：`chainLine → render → renderBody → inspect → consumeForInspector → dispatchTouchEvent`）
     *
     * **修法**：收敛条件从"字符串长度"改成 **`dropCount` 单调递增**的 `for` 循环 ——
     * 轮数上界 `clean.size + 1`，**结构上不可能不终止**，不再依赖"每轮真的变短"。
     * 回归测试见 `UiInspectorInfoTest.父链超长时不会死循环`（带 `timeout`）。
     */
    fun chainLine(names: List<String>): String {
        val clean = names.filter { it.isNotBlank() }
            .map { if (it.length > NAME_MAX) it.take(NAME_MAX - 1) + ELLIPSIS else it }
        if (clean.isEmpty()) return "层级 $NONE"
        // ⚠️ 这里的 for 是**有界**的：轮数 = clean.size + 1。
        // 千万别再改回"按字符串长度 while 收敛"—— 那正是死循环的来源。
        var body = chainBody(clean, 0)
        for (dropCount in 1..clean.size) {
            if (body.length <= CHAIN_MAX) break
            body = chainBody(clean, dropCount)
        }
        // 兜底：只剩一两段还是超长（类名本身很长）—— 只能截字符串
        if (body.length > CHAIN_MAX) body = body.take(CHAIN_MAX - 1) + ELLIPSIS
        return "层级 $body"
    }

    /**
     * 从头部丢掉 [dropCount] 段之后的父链文本（**不含** `层级 ` 前缀）。
     *
     * - `dropCount == 0` 且层数 > 4 → `A > B > … > Y > Z`（中间省略）；
     * - `dropCount > 0` → `… > Y > Z`（头部省略，**最近两层永远完整**）。
     *
     * 纯函数、无循环 —— 这是 [chainLine] 能"结构上有界"的关键。
     */
    private fun chainBody(clean: List<String>, dropCount: Int): String {
        val n = clean.size
        val head = clean.subList(dropCount.coerceIn(0, n), n)
        if (head.isEmpty()) return ELLIPSIS
        val parts: List<String> = when {
            dropCount == 0 && n > 4 ->
                listOf(clean[0], clean[1], ELLIPSIS, clean[n - 2], clean[n - 1])
            dropCount == 0 -> head
            head.size <= 2 -> listOf(ELLIPSIS) + head
            else -> listOf(ELLIPSIS, head[head.size - 2], head[head.size - 1])
        }
        return parts.joinToString(SEP)
    }

    /** 可选行：值为 `null`/空 → **整行不出现**（不写"（无）"，因为它是加分项不是必填项） */
    fun optLine(label: String, value: String?): String? =
        if (value.isNullOrBlank()) null else "$label $value"

    /** 浮点可选值（`layout_weight`） */
    fun optNumLine(label: String, value: Float?): String? =
        if (value == null || value == 0f) null else "$label ${num(value)}"

    // ------------------------------------------------------------ 整体

    /**
     * 面板要显示的全部信息。**已经是从 View 上读出来的数值** ——
     * 这一份的存在让"面板到底显示什么"能在 JVM 里断言（见 `UiInspectorInfoTest`）。
     *
     * `List<Int>` 而不是 `IntArray`：`data class` 的 `equals` 对数组是引用比较，
     * 单测里会比不出来。
     */
    data class InspectorSnapshot(
        /** 简单类名，如 `Button` */
        val typeName: String,
        /** id 的**资源名**；没有就是 `null` → 显示 [NO_ID] */
        val idEntry: String? = null,
        /** 实测宽（像素） */
        val widthPx: Int = 0,
        /** 实测高（像素） */
        val heightPx: Int = 0,
        /** `LayoutParams.width`（-1 MATCH_PARENT / -2 WRAP_CONTENT / ≥0 像素） */
        val declaredW: Int = -2,
        val declaredH: Int = -2,
        /** 四边 margin（左/上/右/下，像素）。不是 MarginLayoutParams 时给全 0 */
        val margin: List<Int> = listOf(0, 0, 0, 0),
        /** 四边 padding（左/上/右/下，像素） */
        val padding: List<Int> = listOf(0, 0, 0, 0),
        /** 非 `TextView` → `null` */
        val textSizePx: Float? = null,
        /** 非 `TextView` → `null` */
        val textColor: Int? = null,
        val bgResName: String? = null,
        val bgClassName: String? = null,
        /** 0/4/8 = VISIBLE/INVISIBLE/GONE */
        val visibility: Int = 0,
        val enabled: Boolean = true,
        /** 从根到该控件的简单类名路径 */
        val chain: List<String> = emptyList(),
        /** `LinearLayout.LayoutParams.weight`；不是线性布局的子控件 → `null` */
        val weight: Float? = null,
        /** 已解码的 gravity 文本（解码在 UI 层，见类注释） */
        val gravityText: String? = null,
        /** 限宽容器的像素上限（`MaxWidth*`）；不是限宽容器 → `null` */
        val maxWidthPx: Int? = null,
        /** 是不是仪表盘的自绘区（`BaseGaugeView` 等）—— 见 [HINT_SELF_DRAWN] */
        val selfDrawn: Boolean = false,
        val density: Float = 1f,
        val scaledDensity: Float = 1f,
    )

    /**
     * 把 [InspectorSnapshot] 渲染成面板上的行。
     *
     * 顺序与规格 §3 的示意**逐行对应**：
     * ```
     * Button
     * btnGestures
     * 尺寸 120×40dp  边距 8/8/0/0
     * 内边距 12/12/12/12
     * 字号 14sp  色 #E8EEF7
     * 背景 @drawable/bg_input
     * 可见 VISIBLE  可用 true
     * 层级 LinearLayout > Scroll…
     * ```
     * 可选行（权重 / gravity / 限宽）插在"层级"**之前** —— 它们是"这个控件怎么被摆放的"，
     * 与父链是同一类信息，放一起才读得顺。
     */
    fun render(s: InspectorSnapshot): List<String> {
        val out = ArrayList<String>(12)
        out += typeLine(s.typeName)
        out += idLine(s.idEntry)
        val m = pad4(s.margin)
        val p = pad4(s.padding)
        out += sizeLine(s.widthPx, s.heightPx, s.density, s.declaredW, s.declaredH) +
            "  边距 " + quad(m[0], m[1], m[2], m[3], s.density)
        out += boxLine("内边距", p[0], p[1], p[2], p[3], s.density)
        out += textLine(s.textSizePx, s.textColor, s.scaledDensity)
        out += backgroundLine(s.bgResName, s.bgClassName)
        out += stateLine(s.visibility, s.enabled)
        optNumLine("权重", s.weight)?.let { out += it }
        optLine("gravity", s.gravityText)?.let { out += it }
        s.maxWidthPx?.takeIf { it > 0 }?.let { out += "限宽 ${dp(it, s.density)}dp" }
        out += chainLine(s.chain)
        if (s.selfDrawn) out += HINT_SELF_DRAWN
        return out
    }

    /** 四边数组兜底成 4 项（拿不到 margin 的控件给全 0，而不是少几个数） */
    private fun pad4(v: List<Int>): List<Int> =
        if (v.size >= 4) v else listOf(
            v.getOrElse(0) { 0 }, v.getOrElse(1) { 0 }, v.getOrElse(2) { 0 }, v.getOrElse(3) { 0 }
        )

    /**
     * [render] 去掉前两行（类型 / id）。
     *
     * 面板把这两行**单独排版**（类型进标题行、id 进黄色那行），正文只要剩下的。
     * 抽成函数而不是让面板自己 `drop(2)`：`render` 的行序一旦调整，
     * 面板会跟着错位，而"面板显示的内容"与"单测断言的内容"必须**永远同一份**。
     */
    fun renderBody(s: InspectorSnapshot): List<String> = render(s).drop(2)

    /**
     * 长按复制到剪贴板的文本。
     *
     * 前面加一行"这是什么"的头，是因为粘给作者时**上下文会丢** ——
     * 一串裸的 `Button / btnGestures / 尺寸…` 看不出是从哪个版本、哪个页面复制的。
     */
    fun clipboardText(lines: List<String>, header: String = ""): String {
        val body = lines.joinToString("\n")
        return if (header.isBlank()) body else "$header\n$body"
    }
}
