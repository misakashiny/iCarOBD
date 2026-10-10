package com.icar.obd.data

import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.TextPaint
import org.json.JSONArray
import org.json.JSONObject

/**
 * 字体（`icar.ui/2` 的 `font` / `labelFont` 段）。
 *
 * ## 为什么是**枚举**而不是任意字体名
 *
 * PC 与 Android 的字体生态完全不同 —— 设计文件里写 `"Microsoft YaHei"`，
 * 推到设备上必然没有这个字体。所以两端约定一组**有限的字体族**，
 * 保证"电脑上选的"与"设备上渲染的"是同一种观感。
 *
 * 枚举由 `tools/verify-studio.js` 跨语言比对守着，改名/改顺序会立刻报错。
 *
 * ## 字段
 *
 * | 字段 | 说明 |
 * |---|---|
 * | `family` | `sans` / `serif` / `mono` / `condensed` |
 * | `size` | 字号，**画布单位**（0..360 那套），不是像素 |
 * | `weight` | 100..900，与 CSS 一致；≥700 视为粗体 |
 * | `italic` | 斜体 |
 * | `letterSpacing` | 字距，画布单位 |
 * | `align` | `left` / `center` / `right` |
 * | `color` | `#RRGGBB` |
 */
data class GaugeFont(
    val family: String = FAMILY_SANS,
    val size: Float = DEFAULT_SIZE,
    val weight: Int = 400,
    val italic: Boolean = false,
    val letterSpacing: Float = 0f,
    val align: String = ALIGN_LEFT,
    val color: Int = DEFAULT_COLOR
) {

    /** 有没有被显式设置过（等于默认值就算没设）。渲染时用它决定"自动字号"还是"用设置的字号" */
    val isDefault: Boolean
        get() = family == FAMILY_SANS && size == DEFAULT_SIZE && weight == 400 &&
            !italic && letterSpacing == 0f && align == ALIGN_LEFT && color == DEFAULT_COLOR

    val bold: Boolean get() = weight >= 700

    /** 映射到 Android 的字体族名 */
    val androidFamily: String
        get() = when (family) {
            FAMILY_SERIF -> "serif"
            FAMILY_MONO -> "monospace"
            FAMILY_CONDENSED -> "sans-serif-condensed"
            else -> "sans-serif"
        }

    /** 映射到 Typeface（粗体/斜体在这里落地） */
    fun typeface(): Typeface {
        val style = when {
            bold && italic -> Typeface.BOLD_ITALIC
            bold -> Typeface.BOLD
            italic -> Typeface.ITALIC
            else -> Typeface.NORMAL
        }
        return Typeface.create(androidFamily, style)
    }

    /**
     * 把字体应用到画笔。
     *
     * @param pxPerUnit 画布单位 → 像素的换算系数。**字号是画布单位**，
     *   所以必须乘这个系数才能得到正确的像素大小 —— 这也是为什么
     *   `size` 不能直接当 px 用（不同分辨率下观感会完全不一样）
     */
    fun applyTo(paint: Paint, pxPerUnit: Float, fallbackSizePx: Float = 0f) {
        paint.typeface = typeface()
        val px = if (isDefault && fallbackSizePx > 0f) fallbackSizePx else size * pxPerUnit
        paint.textSize = px.coerceAtLeast(1f)
        paint.color = color
        if (paint is TextPaint || paint is Paint) {
            // letterSpacing 是 em 单位，所以要除以字号
            paint.letterSpacing = if (paint.textSize > 0f) letterSpacing / size.coerceAtLeast(0.01f) else 0f
        }
    }

    /** 对齐 → Paint.Align */
    fun paintAlign(): Paint.Align = when (align) {
        ALIGN_CENTER -> Paint.Align.CENTER
        ALIGN_RIGHT -> Paint.Align.RIGHT
        else -> Paint.Align.LEFT
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("family", family)
        put("size", size.toDouble())
        put("weight", weight)
        put("italic", italic)
        put("letterSpacing", letterSpacing.toDouble())
        put("align", align)
        put("color", colorHex(color))
    }

    companion object {
        const val FAMILY_SANS = "sans"
        const val FAMILY_SERIF = "serif"
        const val FAMILY_MONO = "mono"
        const val FAMILY_CONDENSED = "condensed"

        const val ALIGN_LEFT = "left"
        const val ALIGN_CENTER = "center"
        const val ALIGN_RIGHT = "right"

        /**
         * 默认字号（**画布单位**）。
         *
         * ⚠️ 是 6 不是 16 —— 16 是"像素思维"的产物。画布只有 360 单位宽，
         * 一个 16 单位的字在 180 单位的表上占 8.9%，满屏都是字。
         * 6 单位 ≈ 表高的 3.3%，能看清但不抢戏。**必须与工具侧 FONT_DEFAULT.size 一致**。
         */
        const val DEFAULT_SIZE = 6f
        const val DEFAULT_COLOR = 0xFFE8EEF7.toInt()

        /** 与工具侧 `FONT_FAMILIES` 一致，**顺序与名字都不能改**（跨语言比对守着） */
        val FAMILIES = listOf(FAMILY_SANS, FAMILY_SERIF, FAMILY_MONO, FAMILY_CONDENSED)
        val FAMILY_NAMES = listOf("无衬线（默认）", "衬线", "等宽（数字对齐）", "窄体")

        /** 与工具侧 `FONT_WEIGHTS` 一致 */
        val WEIGHTS = listOf(400, 500, 700, 900)
        val WEIGHT_NAMES = listOf("常规", "中等", "加粗", "特粗")

        /** 与工具侧 `FONT_ALIGNS` 一致 */
        val ALIGNS = listOf(ALIGN_LEFT, ALIGN_CENTER, ALIGN_RIGHT)
        val ALIGN_NAMES = listOf("左对齐", "居中", "右对齐")

        fun familyName(f: String): String =
            FAMILY_NAMES.getOrElse(FAMILIES.indexOf(f)) { FAMILY_NAMES[0] }

        fun alignName(a: String): String =
            ALIGN_NAMES.getOrElse(ALIGNS.indexOf(a)) { ALIGN_NAMES[0] }

        private fun colorHex(c: Int): String = String.format("#%06X", 0xFFFFFF and c)

        /**
         * 解析字体段。**缺字段一律回落默认值，不报错** ——
         * 字体是"锦上添花"的属性，不该因为它拦下整个设计。
         * 但非法值给警告，否则用户改了没反应会以为工具坏了。
         */
        fun parse(o: JSONObject?, path: String, warnings: MutableList<String>): GaugeFont {
            if (o == null) return GaugeFont()

            var family = o.optString("family", FAMILY_SANS)
            if (family !in FAMILIES) {
                warnings.add("$path.family = $family 不认识（本版本认：${FAMILIES.joinToString(" / ")}）—— 已回落到 $FAMILY_SANS")
                family = FAMILY_SANS
            }
            var align = o.optString("align", ALIGN_LEFT)
            if (align !in ALIGNS) {
                warnings.add("$path.align = $align 不认识（本版本认：${ALIGNS.joinToString(" / ")}）—— 已回落到 $ALIGN_LEFT")
                align = ALIGN_LEFT
            }
            val rawSize = o.optDouble("size", DEFAULT_SIZE.toDouble()).toFloat()
            val size = if (rawSize > 0f && rawSize.isFinite()) rawSize else {
                warnings.add("$path.size = $rawSize 非法 —— 已回落到 $DEFAULT_SIZE")
                DEFAULT_SIZE
            }
            var weight = o.optInt("weight", 400)
            if (weight !in WEIGHTS) weight = 400

            val color = parseColor(o.optString("color", ""), path, warnings)

            return GaugeFont(
                family = family,
                size = size,
                weight = weight,
                italic = o.optBoolean("italic", false),
                letterSpacing = o.optDouble("letterSpacing", 0.0).toFloat()
                    .coerceIn(-10f, 50f),
                align = align,
                color = color
            )
        }

        /** `#RRGGBB` → Int。解析不了就回落默认色并警告 */
        fun parseColor(s: String, path: String, warnings: MutableList<String>): Int {
            if (s.isBlank()) return DEFAULT_COLOR
            return runCatching { Color.parseColor(s) }.getOrElse {
                warnings.add("$path.color = $s 不是合法颜色（要 #RRGGBB）—— 已用默认色")
                DEFAULT_COLOR
            }
        }
    }
}

/**
 * `icar.ui/2` 的**节点**（控件树的一个结点）。
 *
 * ## 与 [GaugeItem] 的关系
 *
 * `type == "gauge"` 的节点把仪表字段**直接放在自己身上**（与 v1 的 `GaugeItem` 同名同义），
 * 解析时复用 [GaugeItem.fromJson]。这样 v1 的 `gauges[]` 每一项都能**一对一**
 * 升级成 v2 的一个根节点，不需要字段映射表。
 *
 * ## 坐标语义（**必须与工具侧一致**，见 docs/主题设计大纲.md §2.3）
 *
 * - `x` / `y`：**相对父节点**的左上角，画布单位 0..360
 * - `rotation`：绕自身中心，**在设备空间施加**（先排好版、再旋转）
 * - `scale`：在 `w/h` 之上的额外倍率（绕中心）
 * - `z`：**同一父节点内**的绘制顺序，大者在上
 */
data class DesignNode(
    val id: String,
    val type: String,
    val name: String,
    val x: Float,
    val y: Float,
    val w: Float,
    val h: Float,
    val rotation: Float = 0f,
    val scale: Float = 1f,
    val alpha: Int = 255,
    val z: Int = 0,
    val locked: Boolean = false,
    val visible: Boolean = true,
    val children: List<DesignNode> = emptyList(),

    // ---- type == "gauge"：复用 GaugeItem 的全部字段
    val gauge: GaugeItem? = null,
    /**
     * **底框的细粒度覆盖**（透明度 / 圆角 / 显示）。
     *
     * `cardStyle` 是 4 个粗档位（跟随主题/无边框/透明/不画），
     * 表达不了"半透明 + 大圆角"。这个对象补上那一层。
     *
     * **优先级**：`card` 的字段覆盖 `cardStyle` 的对应项；缺的仍跟随主题。
     * 与工具侧 `resolveCard()` 同一套语义。
     */
    val card: CardOverride? = null,

    /**
     * **子部件**。非空时**不再走 style 的程序化画法**，完全按这里拼装。
     *
     * null / 空 = 用程序化画法（默认），所以存量设计行为完全不变。
     */
    val parts: List<GaugePart>? = null,
    /** 表上文字的字体（名字 / PID / 量程） */
    val labelFont: GaugeFont = GaugeFont(),
    val showLabel: Boolean = true,
    val showRange: Boolean = true,

    // ---- type == "image"
    val assetId: String = "",
    val statePid: String = "",

    /**
     * 状态阈值（**覆盖 PID 库的推断**）。null = 按 PID 库推断。
     *
     * 为什么要能覆盖：不同车/不同传感器的报警线本来就不一样，
     * 写死在 PID 库里用户改不了。
     */
    val stateWarn: Float? = null,
    val stateCritical: Float? = null,
    val states: Map<String, NodeState>? = null,

    // ---- type == "text"
    val text: String = "",
    val font: GaugeFont = GaugeFont()
) {
    val isGauge: Boolean get() = type == TYPE_GAUGE
    val isImage: Boolean get() = type == TYPE_IMAGE
    val isText: Boolean get() = type == TYPE_TEXT
    val isGroup: Boolean get() = type == TYPE_GROUP

    /** 按 z 升序（= 绘制顺序，小者先画在下） */
    fun sortedChildren(): List<DesignNode> = children.sortedBy { it.z }

    companion object {
        const val TYPE_GROUP = "group"
        const val TYPE_IMAGE = "image"
        const val TYPE_GAUGE = "gauge"
        const val TYPE_TEXT = "text"

        /** 与工具侧 `NODE_TYPES` 一致（跨语言比对守着） */
        val TYPES = listOf(TYPE_GAUGE, TYPE_IMAGE, TYPE_TEXT, TYPE_GROUP)
        val TYPE_NAMES = listOf("仪表", "图片", "文字", "分组")

        /** 一屏最多几个节点（与工具侧 `MAX_NODES` 一致） */
        const val MAX_NODES = 200

        /**
         * **分组嵌套的深度上限**（v1.20.19 加，与工具侧成对）。
         *
         * ## 为什么需要一个"看着多余"的上限
         *
         * [parse] 是**递归**的。没有上限时，一份手工构造（或损坏）的设计文件可以靠
         * 2 万层嵌套的 `group` 把调用栈打爆 —— 工具侧实测
         * `RangeError: Maximum call stack size exceeded`，而那个异常冒到
         * `jsonEdited` 的 setTimeout 里没人接，用户看到的是"粘了一份文件，什么都没发生"。
         *
         * App 侧原来是同一个递归结构、**没有闸门** —— 于是同一份文件
         * 「工具里报友好错误、App 上爆栈」。这就是这个常量存在的理由。
         *
         * 32 层远超任何真实设计（正常最多 4 层：页面 → 分组 → 卡片 → 文字），
         * 所以它只会拦住损坏/恶意文件，不会误伤。
         *
         * ⚠️⚠️ **必须与 `tools/icarui/js/schema.js` 的 `window.MAX_NODE_DEPTH`
         * 成对改** —— 单边改会造成新的跨语言分叉：同一份文件一边友好报错、一边爆栈。
         * `tools/icarui/tests/verify-crosslang.js` 里有一条断言把这两个常量钉在一起，
         * 漏改一边就跑不过。
         */
        const val MAX_NODE_DEPTH = 32

        /**
         * 会被"**非数字静默回落到默认值**"的数值字段清单（v1.20.20）。
         *
         * 用途：解析时逐个检查"这个字段写了值、但那不是数字" → 给一条**警告**。
         * 数值怎么回落**完全不变**（见 [DesignFile.warnNonNumeric] 的理由）。
         *
         * ⚠️ 这三张清单与工具侧 `tools/icarui/js/schema.js` 的
         * `window.NUMERIC_NODE_FIELDS` / `NUMERIC_PART_FIELDS` / `NUMERIC_GAUGE_FIELDS`
         * **必须逐条一致**，由 `tools/icarui/tests/verify-crosslang.js` 钉着。
         * 单边加字段 = 新的跨语言分叉（工具报了、App 没报）——
         * 那正是这个项目最恨的失效形态，所以让它变成**跑不过**而不是"看人记性"。
         */
        val NUMERIC_NODE_FIELDS = listOf("x", "y", "w", "h", "rotation", "scale", "alpha", "z")

        /** 见 [NUMERIC_NODE_FIELDS] */
        val NUMERIC_PART_FIELDS = listOf(
            "x", "y", "w", "h", "alpha", "rotation", "pivotX", "pivotY", "sweepFrom", "sweepTo"
        )

        /** 见 [NUMERIC_NODE_FIELDS] */
        val NUMERIC_GAUGE_FIELDS = listOf(
            "style", "min", "max", "warnLow", "warnHigh", "ringStyle", "ringSegments", "cardStyle"
        )

        fun typeName(t: String): String =
            TYPE_NAMES.getOrElse(TYPES.indexOf(t)) { t }

        /**
         * 解析一个节点。
         *
         * @param forceGauge v1 升级路径用：v1 的 `gauges[]` 里没有 `type` 字段，
         *   但每一项都必然是仪表
         * @param depth 当前嵌套层级（根 = 0）。**调用方不用传**，
         *   只有 `children` 的递归会传 `depth + 1` —— 见 [MAX_NODE_DEPTH]
         */
        fun parse(
            o: JSONObject,
            path: String,
            errors: MutableList<String>,
            warnings: MutableList<String>,
            assetIds: Set<String>,
            forceGauge: Boolean = false,
            depth: Int = 0
        ): DesignNode? {
            // ⚠️ **深度闸门必须在递归之前**（v1.20.19，与工具侧 `parseNode` 同一处判定）。
            //
            // 没有它时，2 万层嵌套的 `group` 会把调用栈打爆
            // （`StackOverflowError`）—— 而这个异常会一路冒到导入的调用方，
            // 那里没有 try/catch，用户看到的是"点了导入，App 直接闪退"。
            // 宁可报一条**看得懂**的硬错误。
            //
            // 判定写法与文案与 `tools/icarui/js/validate.js` 的
            // `if ((depth || 0) > window.MAX_NODE_DEPTH)` **逐条对齐**。
            if (depth > MAX_NODE_DEPTH) {
                errors.add(
                    "$path 的嵌套深度超过 $MAX_NODE_DEPTH 层 —— " +
                        "多半是文件损坏（正常设计不会超过 4 层：页面 → 分组 → 卡片 → 文字）"
                )
                return null
            }

            val type = if (forceGauge) TYPE_GAUGE else o.optString("type", TYPE_GAUGE)
            if (type !in TYPES) {
                errors.add("$path 的 type `$type` 不认识（本版本认：${TYPES.joinToString(" / ")}）")
                return null
            }

            val w = o.optDouble("w", 120.0).toFloat()
            val h = o.optDouble("h", 120.0).toFloat()
            if (w <= 0f || h <= 0f) {
                errors.add("$path 的尺寸非法：w=$w h=$h（必须为正）")
                return null
            }
            val scale = o.optDouble("scale", 1.0).toFloat()
            if (scale <= 0f) {
                errors.add("$path 的 scale=$scale 非法（必须为正）")
                return null
            }
            var alpha = o.optInt("alpha", 255)
            if (alpha < 0 || alpha > 255) {
                warnings.add("$path 的 alpha=$alpha 超出 0..255 —— 已夹住")
                alpha = alpha.coerceIn(0, 255)
            }

            // ⚠️ **"写了值但不是数字"要出声**（v1.20.20）。
            // `optDouble` / `optInt` 对非数字**静默回落**（`x="abc"` → 0），
            // 用户看到的现象是"我明明写了坐标，它跑到左上角去了"，
            // 而没有任何线索指向那一行。数值怎么回落完全不变，只补一条警告。
            DesignFile.warnNonNumeric(o, NUMERIC_NODE_FIELDS, path, warnings)

            // ---- 类型专属
            var gauge: GaugeItem? = null
            var card: CardOverride? = null
            var parts: List<GaugePart>? = null
            var labelFont = GaugeFont()
            var showLabel = true
            var showRange = true
            var assetId = ""
            var statePid = ""
            var stateWarn: Float? = null
            var stateCritical: Float? = null
            var states: Map<String, NodeState>? = null
            var text = ""
            var font = GaugeFont()

            when (type) {
                TYPE_GAUGE -> {
                    // 复用 v1 的 GaugeItem.fromJson（字段与语义完全一致），
                    // 但**校验信息带上 v2 的路径**（nodes[0].children[1] 这种）——
                    // 直接复用 DesignFile.parseGauge 的话消息里会写死 "gauges[i]"，
                    // 用户按报错找不到地方
                    val rawPid = o.optString("pid", "")
                    if (rawPid.isBlank()) {
                        errors.add("$path 缺少 `pid`（可以写语义名如 `obd.rpm`，或直接写 PID id 如 `std_0C`）")
                        return null
                    }
                    val pid = DesignFile.resolvePid(rawPid)
                    if (rawPid !in DesignFile.PID_ALIASES && BuiltInPids.all().none { it.id == pid }) {
                        warnings.add("$path 的 pid `$rawPid` 不在内置 PID 库里 —— 需要先在 App 里导入对应 PID")
                    }
                    // ⚠️⚠️ **必须把解析后的 pid 与 `unit` 一起注进去再交给 fromJson**。
                    //
                    // 这两个注入是**同一件事的两半** —— 都是"v1 路径做了、v2 忘了做"的岔口。
                    // 少任何一个，同一份设计的 `gauges[]` 在两条路上就会算出不同的数。
                    //
                    // ## `pid`：别名解析
                    //
                    // GaugeItem.fromJson 直接读 `pid` 字段、**不做别名解析** ——
                    // 不注入的话 `obd.rpm` 会原样变成 pidId，下游按 id 查表全部落空
                    // （查不到量程/单位/报警阈值）。这与工具侧 createNode 上踩过的是同一类坑。
                    //
                    // ## `unit`：坐标单位（v1.20.20 修）
                    //
                    // `GaugeItem.fromJson` 用**元素自己的 `unit` 字段**判断"这是旧格式
                    // （归一化 0..1，要 ×360）还是新格式"。而设计文件的单位声明在
                    // **`canvas.unit`** 上，节点里没有 —— 于是 v2 走这条路的每个坐标都被
                    // 又乘了一次 360：`x=30 w=180` → `x=10800 w=64800`。
                    //
                    // 症状是**导入确认框弹假警报**「超出画布右下角：右=75600」，
                    // 以及 `Store.customGauges` 被污染 —— 渲染走节点树所以**画面是对的**，
                    // 但「清除导入的设计文件」回退到 `customGauges` 那条路上，
                    // 整盘表会跑到屏幕外。**不在渲染路径上，在回退路径上**。
                    //
                    // v1 的 `DesignFile.parseGauge` 一直注入了这个字段（那里的注释
                    // 甚至写着"这个坑是单测抓出来的"）—— v2 这条路漏了。
                    // `DesignCoordUnitTest` 现在把两条路的 `gauges[]` 钉成逐字段相等。
                    val patched = JSONObject(o.toString())
                    patched.put("pid", pid)
                    patched.put("unit", GaugeItem.CANVAS.toInt())
                    val g = GaugeItem.fromJson(patched)
                    if (g.minVal >= g.maxVal) {
                        errors.add("$path（$pid）量程非法：min=${g.minVal} ≥ max=${g.maxVal}")
                        return null
                    }
                    // 与 `DesignFile.parseGauge` 的结尾**逐字对齐**：设计文件里的表
                    // 永远不是 v1.4.0 的网格配置。不置位的话 `fromJson` 会按"元素里
                    // 有没有 x/y/w/h"自行判断，而 `DashLayout.migrateFromGrid` 一旦
                    // 看到任何一条 `legacyGrid`，就会把**整张盘**的 x/y/w/h
                    // 按 2 列网格重算一遍。
                    gauge = g.also { it.legacyGrid = false }
                    // 仪表专属的数值字段（量程 / 样式 / 环 / 卡片档位）同样"非数字要出声"。
                    // 放在 fromJson **之后**：`min`/`max` 已经过一遍量程校验，
                    // 这条只是补充说明"你写的那个值没被用上"。
                    DesignFile.warnNonNumeric(o, NUMERIC_GAUGE_FIELDS, path, warnings)
                    parts = GaugePart.parseAll(o.optJSONArray("parts"), "$path.parts", errors, warnings, assetIds)
                    card = CardOverride.parse(o.optJSONObject("card"), "$path.card", warnings)
                    labelFont = GaugeFont.parse(o.optJSONObject("labelFont"), "$path.labelFont", warnings)
                    showLabel = o.optBoolean("showLabel", true)
                    showRange = o.optBoolean("showRange", true)
                }
                TYPE_IMAGE -> {
                    assetId = o.optString("assetId", "")
                    statePid = DesignFile.resolvePid(o.optString("statePid", ""))
                    stateWarn = optFloatOrNull(o, "stateWarn", "$path.stateWarn", warnings)
                    stateCritical = optFloatOrNull(o, "stateCritical", "$path.stateCritical", warnings)
                    states = NodeState.parseAll(o.optJSONObject("states"), path, warnings, assetIds)
                    if (assetId.isNotEmpty() && assetIds.isNotEmpty() && assetId !in assetIds) {
                        warnings.add("$path 引用的素材 `$assetId` 不在 `assets` 清单里 —— 请重新导入")
                    }
                }
                TYPE_TEXT -> {
                    text = o.optString("text", "文字")
                    font = GaugeFont.parse(o.optJSONObject("font"), "$path.font", warnings)
                }
            }

            // ---- 子节点
            val kids = ArrayList<DesignNode>()
            val arr = o.optJSONArray("children")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val c = arr.optJSONObject(i)
                    if (c == null) {
                        errors.add("$path.children[$i] 不是一个对象")
                        continue
                    }
                    parse(c, "$path.children[$i]", errors, warnings, assetIds, false, depth + 1)
                        ?.let { kids.add(it) }
                }
            }

            return DesignNode(
                id = o.optString("id", "").ifBlank { "n" + System.nanoTime() },
                type = type,
                name = o.optString("name", "").ifBlank { typeName(type) },
                x = o.optDouble("x", 0.0).toFloat(),
                y = o.optDouble("y", 0.0).toFloat(),
                w = w, h = h,
                rotation = o.optDouble("rotation", 0.0).toFloat(),
                scale = scale,
                alpha = alpha,
                z = o.optInt("z", 0),
                locked = o.optBoolean("locked", false),
                visible = o.optBoolean("visible", true),
                children = kids,
                gauge = gauge,
                card = card,
                parts = parts,
                labelFont = labelFont,
                showLabel = showLabel,
                showRange = showRange,
                assetId = assetId,
                statePid = statePid,
                stateWarn = stateWarn,
                stateCritical = stateCritical,
                states = states,
                text = text,
                font = font
            )
        }

        /**
         * 读一个可空的浮点字段。
         *
         * 缺字段 / null / 空串 / 非数字都返回 null（= 没设），**不报错** ——
         * 阈值是可选覆盖，不该因为它拦下整个设计。但非数字给一条警告，
         * 否则用户改了没反应会以为工具坏了。
         */
        private fun optFloatOrNull(
            o: JSONObject, key: String, path: String, warnings: MutableList<String>
        ): Float? {
            if (!o.has(key) || o.isNull(key)) return null
            val raw = o.optString(key, "").trim()
            if (raw.isEmpty()) return null
            val v = raw.toFloatOrNull()
            if (v == null) {
                warnings.add("$path = $raw 不是数字 —— 已忽略（改为按 PID 库推断）")
                return null
            }
            return v
        }

        /** 把一棵树展平（深度优先，父在前） */
        fun flatten(nodes: List<DesignNode>): List<DesignNode> {
            val out = ArrayList<DesignNode>()
            fun rec(list: List<DesignNode>) {
                for (n in list) {
                    out.add(n)
                    rec(n.children)
                }
            }
            rec(nodes)
            return out
        }

        /** 收集树里所有仪表节点（v1 兼容用：`DesignFile.gauges`） */
        fun collectGauges(nodes: List<DesignNode>): List<GaugeItem> =
            flatten(nodes).mapNotNull { it.gauge }
    }
}

/**
 * **仪表的一个子部件**（v2.12.0）。
 *
 * 一个仪表不再只能"选一种画法"，而是可以拆成几个可替换的部件：
 * 表盘 / 刻度 / 指针 / 数值 / 装饰。
 *
 * 绘制顺序 = **列表顺序**（先画的在下）。
 *
 * @param kind   见 [KIND_DIAL] / [KIND_TICKS] / [KIND_NEEDLE] / [KIND_VALUE] / [KIND_DECOR]
 * @param assetId 素材 id（[KIND_VALUE] 不用）
 * @param x/y/w/h **画布单位**（与节点同级）
 * @param pivotX/pivotY 旋转中心，**相对自身** 0..1。指针素材的轴心基本不在图片中心，
 *   所以这个必须能单独设 —— 设 0.5/0.5 会让指针绕图片中心转，看起来是歪的
 * @param sweepFrom/sweepTo 指针的扫描范围（度，0 = 正右，顺时针）
 */
data class GaugePart(
    val kind: String = KIND_DECOR,

    /**
     * **指针绑的 PID**（v2.17.0，多指针表）。
     *
     * 空 = 用仪表节点自己的 [DesignNode.gauge] 的 pid（单指针表的老行为，完全不变）。
     * 设了就用它 —— "转速 + 车速"双针表靠这个。
     *
     * 量程也跟着走：绑了别的 PID 就用**那个 PID 的 min/max**，否则车速（0~240）
     * 按转速（0~8000）的角度映射，指针几乎不动。
     */
    val pid: String = "",

    /**
     * **子部件**（v2.18.0）。
     *
     * 有子部件的部件相当于一个「组」：子部件的 x/y 相对**父部件的 pivot**，
     * 并**继承父的旋转**。
     *
     * 为什么以 pivot 为原点：嵌套的典型用法是「指针上挂个装饰/配重」——
     * 装饰要跟着指针**绕轴心转**。以 pivot 为原点，子部件写 (0,0) 就正好在轴心上。
     *
     * 空 = 没有子部件（老行为，完全不变）。
     */
    val children: List<GaugePart> = emptyList(),

    /**
     * **扫描范围跟随仪表**（v2.27.0）。
     *
     * 双针表的两个指针通常共用同一个 135°→405° —开着就不用各自填。
     * 默认 false（老行为完全不变）。
     */
    val sweepFollow: Boolean = false,
    val assetId: String = "",
    val x: Float = 0f,
    val y: Float = 0f,
    val w: Float = 120f,
    val h: Float = 120f,
    val alpha: Int = 255,
    val rotation: Float = 0f,
    val pivotX: Float = 0.5f,
    val pivotY: Float = 0.5f,
    val sweepFrom: Float = 135f,
    val sweepTo: Float = 405f
) {
    /**
     * 给定值下的角度。
     *
     * ⚠️ `min`/`max` 传的应该是**这个部件自己的量程**（绑了 pid 就用那个 PID 的），
     * 不是仪表节点的 —— 见 [pid]。
     *
     * **必须与工具侧 partAngle() 逐字一致** —— 否则"电脑上指针指着 3000 转、
     * 设备上指着 2800"这种偏差，用户只会觉得"数据不准"。
     */
    fun angleFor(value: Float, min: Float, max: Float, fromOverride: Float? = null, toOverride: Float? = null): Float {
        val span = max - min
        val t = if (span > 0f) ((value - min) / span).coerceIn(0f, 1f) else 0f
        return rotation + (fromOverride ?: sweepFrom) + ((toOverride ?: sweepTo) - (fromOverride ?: sweepFrom)) * t
    }

    companion object {
        const val KIND_DIAL = "dial"
        const val KIND_TICKS = "ticks"
        const val KIND_NEEDLE = "needle"
        const val KIND_VALUE = "value"
        const val KIND_DECOR = "decor"

        /** 与工具侧 PART_KINDS 一致（跨语言比对守着） */
        val KINDS = listOf(KIND_DIAL, KIND_TICKS, KIND_NEEDLE, KIND_VALUE, KIND_DECOR)
        val KIND_NAMES = listOf("表盘", "刻度", "指针", "数值", "装饰")

        /**
         * **一个 `parts` 数组最多几项**（v1.20.20 加，与工具侧成对）。
         *
         * ## 为什么 `MAX_NODES` 挡不住它
         *
         * `parts` 是**数组**，而 [DesignNode.MAX_NODES] 数的是节点树的 `children` ——
         * [DesignNode.flatten] 走的是 `DesignNode.children`，**根本不看 `parts`**。
         * 于是一份畸形文件可以在一块表上挂 100 万个部件，每个部件再挂 100 万个子部件
         * （深度上限 5）—— `MAX_NODES=200` 一点忙都帮不上，内存直接被打爆。
         *
         * ## 为什么是 64
         *
         * 这个数**不是新拍的**：工具侧 `normalizePart` 里本来就有一句
         * `.slice(0, 64)` 在夹嵌套的 `children` —— 只是写在函数体里、没有名字，
         * 而且**只夹了嵌套那一层，顶层 `parts` 是无限的**。抽成常量之后
         * 顶层与嵌套用同一个数，两边也能逐字对齐。
         *
         * 真实设计的部件数是个位数（表盘/刻度/指针/数值/装饰），64 只会拦住畸形文件。
         *
         * ⚠️ **必须与 `tools/icarui/js/schema.js` 的 `window.MAX_PARTS` 成对改** ——
         * `tools/icarui/tests/verify-crosslang.js` 钉着这两个常量，漏改一边就跑不过。
         */
        const val MAX_PARTS = 64

        fun parseAll(
            arr: org.json.JSONArray?, path: String,
            errors: MutableList<String>,
            warnings: MutableList<String>, assetIds: Set<String>,
            depth: Int = 0
        ): List<GaugePart>? {
            if (arr == null || arr.length() == 0) return null
            // ⚠️ **先截断、后报错**（顺序要紧）。
            //
            // 反过来先遍历完整个数组、内存已经爆了才报错 —— 闸门就白加了。
            // 与工具侧 `parseParts` 同一个顺序。
            if (arr.length() > MAX_PARTS) {
                errors.add(
                    "$path 有 ${arr.length()} 项，超过上限 $MAX_PARTS" +
                        "（正常设计是个位数：表盘 / 刻度 / 指针 / 数值 / 装饰）"
                )
            }
            val n = minOf(arr.length(), MAX_PARTS)
            val out = ArrayList<GaugePart>(n)
            for (i in 0 until n) {
                val o = arr.optJSONObject(i) ?: continue
                // "写了值但不是数字"要出声（数值怎么回落完全不变）
                DesignFile.warnNonNumeric(o, DesignNode.NUMERIC_PART_FIELDS, "$path[$i]", warnings)
                var kind = o.optString("kind", KIND_DECOR)
                if (kind !in KINDS) {
                    warnings.add("$path[$i].kind = $kind 不认识（本版本认：${KINDS.joinToString(" / ")}）—— 已回落到 $KIND_DECOR")
                    kind = KIND_DECOR
                }
                val aid = o.optString("assetId", "")
                if (kind != KIND_VALUE && aid.isEmpty()) {
                    warnings.add("$path[$i]（$kind）没有选素材 —— 这一层画不出来")
                }
                if (aid.isNotEmpty() && assetIds.isNotEmpty() && aid !in assetIds) {
                    warnings.add("$path[$i] 引用的素材 `$aid` 不在 assets 清单里")
                }
                out.add(
                    GaugePart(
                        kind = kind,
                        // v2.27.0：value 也能绑 PID（双针表配两个数字读数）
                        pid = if (kind == KIND_NEEDLE || kind == KIND_VALUE)
                            DesignFile.resolvePid(o.optString("rawPid", o.optString("pid", "")))
                        else "",
                        assetId = aid,
                        x = o.optDouble("x", 0.0).toFloat(),
                        y = o.optDouble("y", 0.0).toFloat(),
                        w = o.optDouble("w", 120.0).toFloat().coerceAtLeast(1f),
                        h = o.optDouble("h", 120.0).toFloat().coerceAtLeast(1f),
                        alpha = o.optInt("alpha", 255).coerceIn(0, 255),
                        rotation = o.optDouble("rotation", 0.0).toFloat(),
                        pivotX = o.optDouble("pivotX", 0.5).toFloat().coerceIn(-1f, 2f),
                        pivotY = o.optDouble("pivotY", 0.5).toFloat().coerceIn(-1f, 2f),
                        sweepFrom = o.optDouble("sweepFrom", 135.0).toFloat(),
                        sweepTo = o.optDouble("sweepTo", 405.0).toFloat(),
                        // ⚠️ **递归解析子部件**，深度上限 5 —— 与工具侧一致，
                        // 防手改文件写出超深结构。
                        sweepFollow = o.optBoolean("sweepFollow", false),
                        children = if (depth >= 5) emptyList()
                        else parseAll(
                            o.optJSONArray("children"), "$path[$i].children",
                            errors, warnings, assetIds, depth + 1
                        ) ?: emptyList()
                    )
                )
            }
            return out.ifEmpty { null }
        }
    }
}

/**
 * 底框覆盖（v2.6.0）。
 *
 * 三个字段都是**可空**：null = 跟随主题。全为 null 时上层应该把整个对象当不存在。
 *
 * @param show   false = 不画底框
 * @param alpha  0..255
 * @param radius 圆角半径，**画布单位**（不是像素）
 */
data class CardOverride(
    val show: Boolean? = null,
    val alpha: Int? = null,
    val radius: Float? = null
) {
    /** 三个都没设 → 当作没有覆盖 */
    val isEmpty: Boolean get() = show == null && alpha == null && radius == null

    companion object {
        fun parse(o: JSONObject?, path: String, warnings: MutableList<String>): CardOverride? {
            if (o == null) return null
            var show: Boolean? = null
            var alpha: Int? = null
            var radius: Float? = null
            if (o.has("show")) show = o.optBoolean("show", true)
            if (o.has("alpha")) {
                val a = o.optInt("alpha", 255)
                if (a < 0 || a > 255) warnings.add("$path.alpha = $a 超出 0..255 —— 已夹住")
                alpha = a.coerceIn(0, 255)
            }
            if (o.has("radius")) {
                val r = o.optDouble("radius", 0.0).toFloat()
                if (r < 0f) warnings.add("$path.radius = $r 为负 —— 已夹到 0")
                radius = r.coerceIn(0f, 120f)
            }
            val c = CardOverride(show, alpha, radius)
            return if (c.isEmpty) null else c
        }
    }
}

/**
 * 图片节点的**状态**（`icar.ui/2` 的状态系统）。
 *
 * 一个故障灯在真车上有三种外观（正常/警告/严重）。用状态系统，
 * **位置、尺寸、层级只写一次**，三张图共用。
 */
data class NodeState(
    val assetId: String = "",
    val alpha: Int = 255,
    val blink: Boolean = false,
    val blinkMs: Int = 200
) {
    companion object {
        const val STATE_NORMAL = "normal"
        const val STATE_WARN = "warn"
        const val STATE_CRITICAL = "critical"

        /**
         * **闪烁周期的下限**（毫秒）。与工具侧 `window.MIN_BLINK_MS` 同源，
         * 由 `tools/icarui/tests/verify-crosslang.js` 逐条比对守着。
         *
         * ## 依据：WCAG 2.3.1 Three Flashes or Below Threshold（Level A）
         *
         * 标准原文：*"Web pages do not contain anything that flashes more than
         * three times in any one second period..."* —— 即 **≤3 Hz**。
         * 400ms 一个周期 = **2.5 Hz**，留出余量（采样/掉帧不会把它顶过 3 Hz）。
         *
         * ⚠️ 修复前这里夹的是 **60ms = 16.7 Hz**，比红线高 5 倍多。
         * 放在**数据层**而不是 UI 层：这是**设计文件的契约**
         * （"文件里写了 100ms 也不许照闪"），工具侧同一个数字。
         */
        const val MIN_BLINK_MS = 400

        /** 与工具侧 `STATE_NAMES` 一致 */
        val NAMES = listOf(STATE_NORMAL, STATE_WARN, STATE_CRITICAL)
        val DISPLAY_NAMES = listOf("正常", "警告", "严重")

        fun parseAll(
            o: JSONObject?,
            path: String,
            warnings: MutableList<String>,
            assetIds: Set<String>
        ): Map<String, NodeState>? {
            if (o == null) return null
            val out = LinkedHashMap<String, NodeState>()
            for (name in NAMES) {
                val s = o.optJSONObject(name) ?: continue
                val aid = s.optString("assetId", "")
                if (aid.isNotEmpty() && assetIds.isNotEmpty() && aid !in assetIds) {
                    warnings.add("$path.states.$name 引用的素材 `$aid` 不在 `assets` 清单里")
                }
                out[name] = NodeState(
                    assetId = aid,
                    alpha = s.optInt("alpha", 255).coerceIn(0, 255),
                    blink = s.optBoolean("blink", false),
                    // WCAG 2.3.1：闪烁每秒不超过三次。文件里写了更小的值也**不能照闪**
                    blinkMs = s.optInt("blinkMs", MIN_BLINK_MS).coerceAtLeast(MIN_BLINK_MS)
                )
            }
            return out.ifEmpty { null }
        }
    }
}
