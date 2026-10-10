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

    /** 操作提示（面板底部常驻） */
    const val HINT_OPS = "长按复制 · 拖动移动 · 右上角 × 关闭"

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
     */
    fun chainLine(names: List<String>): String {
        val clean = names.filter { it.isNotBlank() }
            .map { if (it.length > NAME_MAX) it.take(NAME_MAX - 1) + ELLIPSIS else it }
        if (clean.isEmpty()) return "层级 $NONE"
        var parts: List<String> =
            if (clean.size > 4) clean.take(2) + ELLIPSIS + clean.takeLast(2) else clean
        var body = parts.joinToString(SEP)
        while (parts.size > 2 && body.length > CHAIN_MAX) {
            // 丢掉头部一段；已经省略过的就多丢一段，免得出现 "… > …"
            var rest = parts.drop(1)
            while (rest.isNotEmpty() && rest.first() == ELLIPSIS) rest = rest.drop(1)
            parts = listOf(ELLIPSIS) + rest
            body = parts.joinToString(SEP)
        }
        // 兜底：只剩一两段还是超长（类名本身很长）—— 只能截字符串
        if (body.length > CHAIN_MAX) body = body.take(CHAIN_MAX - 1) + ELLIPSIS
        return "层级 $body"
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
