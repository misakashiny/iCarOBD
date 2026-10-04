package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * **设计文件**：在电脑上编辑、由 App 加载的 UI 描述。
 *
 * ## 为什么要有它
 *
 * 现在调布局只有两条路：在平板上用手指拖（慢、且看不清全貌），
 * 或者改代码（要重新编译装机）。**都不适合做设计。**
 *
 * 这个格式让设计变成"编辑一个 JSON 文件"：
 *
 * ```
 * PC: 写 design.json  →  校验（有明确报错）  →  推到设备  →  App 加载
 * ```
 *
 * ## 与已被删除的 Sky Gauge 格式的关键区别
 *
 * Sky Gauge 是**别人的格式**，我们要做一层转换，表达力还受限于他们的词汇表
 * （只有 6 个数据源、3 种元素）。这个格式是**我们自己的**：
 *
 *  - **直接复用 [GaugeItem] 的 JSON** —— 不引入任何新的渲染代码，
 *    能表达的东西 = App 能画的东西，一一对应，没有转换损耗
 *  - **画布单位就是 App 的单位**（每轴 0..360），所见即所得
 *  - **语义化 PID 别名**（`obd.rpm` 而不是 `std_0C`），设计可跨车复用
 *
 * ## 校验是这个格式的一半价值
 *
 * 手写 JSON 一定会写错。所以 [parse] **不抛异常**，而是返回**可读的错误列表**
 * （带字段路径）。PC 上改完先跑校验，比推到设备上看"怎么没显示"高效得多。
 */
data class DesignFile(
    val name: String = "未命名设计",
    val author: String = "",
    val description: String = "",
    /** 主题 id（对应 `GaugeTheme`）。空 = 用当前主题 */
    val themeId: String = "",

    // 内嵌的主题配色（P8-5）。
    //
    // 设计文件原来只存主题**名字** —— 换台机器 / 用户删了自建主题，配色就丢了。
    // 现在把颜色一起写进文件，字段名与 GaugeTheme.toJson 逐字一致，
    // 所以渲染时可以直接 GaugeTheme.fromJson(it)，不需要映射表。
    //
    // null = 老文件（按名字查主题，行为与以前完全一致）。
    //
    // 注意：这里只存 JSONObject，不依赖 ui/ —— fromJson 的调用在渲染层。
    val themeColors: org.json.JSONObject? = null,
    /**
     * 背景图片（v1.10.2）。`null` = 不设背景，用主题纯色。
     *
     * 只存**路径**，不内嵌图片数据 —— 设计文件是给人读、给 diff 看的，
     * 塞一段 base64 会让它变成不可读的二进制块。图片本身由 App 侧
     * 「风格 → 选择背景图片」导入到私有目录（`files/bg/`）。
     */
    val background: Background? = null,
    /**
     * **v2 的节点树**（`icar.ui/2` 的 `nodes`）。
     *
     * v1 文件会被自动升级：每个 gauge 变成一棵只有一个根节点的树。
     * 所以这个字段 v1/v2 都有内容，渲染层可以统一按它走。
     */
    /**
     * 素材清单（v2 的 `assets[]`）。图片节点按 [DesignNode.assetId] 引用它。
     *
     * `path` 通常是**相对路径**（`assets/背景/carbon.png`），
     * 要拼上 [Store.settings.designBaseDir] 才能读到 —— 见 NodeTreeRenderer.resolveAssetPath。
     */
    val assets: List<Asset> = emptyList(),
    val nodes: List<DesignNode> = emptyList(),

    /**
     * **多页面**。
     *
     * 工具侧可以建多页，每页有各自的一组控件。
     * [nodes] 始终等于 **当前选中页** 的节点（见 [Store.settings.dashPageIndex]），
     * 这样渲染层不用知道 pages 的存在。
     */
    val pages: List<DesignPage> = emptyList(),
    /** 设计分辨率（v2 才有；v1 用默认值） */
    val designW: Int = 2560,
    val designH: Int = 1600,
    /** 缩放模式，见 SCALE_STRETCH / SCALE_FIT / SCALE_FILL */
    val scaleMode: Int = SCALE_STRETCH,
    /**
     * 展平后的**仪表**列表（v1 兼容）。
     *
     * 从 nodes 里把所有 gauge 节点抽出来 —— 这样：
     *  - 现有渲染器与全部单测（都按 gauges 写）不用改
     *  - **v1 文件的行为完全不变**
     */
    val gauges: List<GaugeItem> = emptyList()
) {

    /**
     * 背景图片的引用与铺法。
     *
     * [fit] 的取值与 `Store.Settings.bgFit` 一一对应（`data/` 层不依赖 Android，
     * 所以用 Int 常量而不是 `BitmapDrawable` 的 gravity）。
     */
    /**
     * 一页（多页面里的一个）。
     *
     * @param id   稳定标识（跨机器保持，用于记住"上次看的是哪页"）
     * @param name 显示名（用户可改）
     */
    data class DesignPage(
        val id: String,
        val name: String,
        val nodes: List<DesignNode> = emptyList()
    )

    /**
     * 一份素材（图片）。
     *
     * 只存**引用**不内嵌图片：内嵌会让设计文件变成几 MB 的不可读二进制块，
     * 而且设计文件本来就该是能直接看、直接改的 JSON。
     */
    data class Asset(
        val id: String,
        val name: String,
        val kind: String = "custom",
        val path: String = "",
        val w: Int = 0,
        val h: Int = 0
    )

    data class Background(
        val path: String,
        /** 铺法：见 [FIT_FILL] / [FIT_FIT] / [FIT_CENTER] / [FIT_TILE] */
        val fit: Int = FIT_FILL,
        /**
         * 背景在设计里的尺寸（**画布单位**，0 = 铺满）。
         *
         * 工具侧允许给背景指定 w/h —— 「这张底图只占中间一块」。
         * 不读它的话，电脑上缩在中间的图推到设备上会变成全屏拉伸。
         */
        val w: Int = 0,
        val h: Int = 0
    )

    /** 校验/解析结果。[errors] 为空才算成功 */
    data class Result(
        val design: DesignFile?,
        val errors: List<String>,
        /** 非致命提示：能加载，但效果可能不是设计者想要的 */
        val warnings: List<String> = emptyList()
    ) {
        val ok: Boolean get() = design != null && errors.isEmpty()
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("schema", SCHEMA)
        put("meta", JSONObject().apply {
            put("name", name)
            put("author", author)
            put("description", description)
        })
        put("canvas", JSONObject().apply {
            // 明确写出来：设计者一眼知道坐标是 0..360，不是像素也不是 0..1
            put("unit", GaugeItem.CANVAS.toInt())
            put("note", "每轴 0..360。x/y 是左上角，w/h 是尺寸")
        })
        if (themeId.isNotBlank()) put("theme", themeId)
        background?.takeIf { it.path.isNotBlank() }?.let { b ->
            put("background", JSONObject().apply {
                put("path", b.path)
                put("fit", b.fit)
                put("w", background!!.w)
                put("h", background!!.h)
                put("fitName", fitName(b.fit))
            })
        }
        put("gauges", JSONArray().apply { gauges.forEach { put(it.toJson()) } })
    }

    companion object {
        /** 格式标识。改结构时递增主版本，旧版本会被明确拒绝而不是静默画错 */
        const val SCHEMA = "icar.ui/1"

        /**
         * v2 的 schema 名。**App 同时认 v1 与 v2**：
         *  - v1：扁平的 gauges[]，自动升级成节点树
         *  - v2：节点树 nodes[]（图片 / 分组 / 文字 / 旋转 / 状态系统）
         *
         * ⚠️ **写出去时仍然写 v1**（见 toJson）。原因：v2 的图片/分组/文字
         * 渲染还没做，导出 v2 会产出"App 自己读得进但画不出来"的文件。
         * 等渲染补齐再切到 v2 导出。
         */
        const val SCHEMA_V2 = "icar.ui/2"

        /** 缩放模式：每轴独立拉伸（= v1 行为，默认） */
        const val SCALE_STRETCH = 0
        /** 等比缩放，短边留黑边 */
        const val SCALE_FIT = 1
        /** 等比铺满，超出裁切 */
        const val SCALE_FILL = 2
        val SCALE_NAMES = listOf("拉伸（每轴独立，v1 行为）", "等比适应（留黑边）", "等比铺满（裁切）")

        /** 一屏最多几块表。超过多半是写错了（比如循环里少了个边界） */
        const val MAX_GAUGES = 32

        // ---- 背景铺法（与 Store.Settings.bgFit 同源）----
        /** 铺满：裁掉溢出部分（默认，不会留黑边） */
        const val FIT_FILL = 0
        /** 完整显示：可能留黑边，但图不会丢内容 */
        const val FIT_FIT = 1
        /** 居中原始大小：1:1 像素，适合精确对位的设计稿 */
        const val FIT_CENTER = 2

    /**
     * 平铺（tile）：按原图尺寸重复铺满，像贴瓷砖。
     *
     * ⚠️ 与其它三种不同，它**需要图片本身足够小**才有意义 ——
     * 已下采样到 2048 的大图平铺只会看到 1~2 块。
     * 所以渲染侧要先按屏幕尺寸缩放再平铺（见 DashFragment 的背景 Drawable）。
     */
    const val FIT_TILE = 3

        val FIT_NAMES = listOf("铺满（裁切）", "完整显示（可能留边）", "居中原始大小", "平铺")

        /** 把铺法解释成中文名；未知值回落到「铺满」 */
        fun fitName(fit: Int): String = FIT_NAMES.getOrElse(fit) { FIT_NAMES[FIT_FILL] }

        /**
         * 语义化 PID 别名。
         *
         * 设计文件里写 `obd.rpm` 而不是 `std_0C` —— 前者一眼知道是什么，
         * 后者要去翻 PID 表。**这是"能在电脑上做设计"的前提之一。**
         *
         * 也接受直接写 PID id（`std_0C`），两条路都通。
         *
         * ## 覆盖范围（v1.10.2 补全）
         *
         * **每一个默认启用的内置 PID 都有别名** —— 由 `ThemeStudioSampleTest`
         * 的 `每个内置 PID 都有语义别名` 用例守着，漏一个就失败。
         *
         * 刻意**不给** `MANUFACTURER_TEMPLATES`（`tpl_*`）别名：那 4 条是
         * 占位示例（默认 `enabled=false`，PID 号是猜的）。给它们起个
         * "好听的语义名"反而会让人以为可以直接用 —— 必须先用扫描器实测。
         *
         * ⚠️ **改这张表必须同时改 `tools/theme-studio/index.html` 的
         * `PID_ALIASES` 与 `BUILTIN_PIDS`**，否则 PC 端编辑器会给出误导性的警告。
         */
        val PID_ALIASES: Map<String, String> = mapOf(
            // ---- 标准 OBD（std_*）：全部 20 条 ----
            "obd.rpm" to "std_0C",
            "obd.speed" to "std_0D",
            "obd.coolant" to "std_05",
            "obd.load" to "std_04",
            "obd.intake" to "std_0F",
            "obd.maf" to "std_10",
            "obd.stft" to "std_06",
            "obd.ltft" to "std_07",
            "obd.fuel_rate" to "std_5E",
            "obd.map" to "std_0B",
            "obd.fuel_level" to "std_2F",
            "obd.ambient" to "std_46",
            "obd.oil_temp" to "std_5C",
            "obd.baro" to "std_33",
            "obd.timing_advance" to "std_0E",
            "obd.throttle" to "std_11",
            "obd.pedal_d" to "std_49",
            "obd.run_time" to "std_1F",
            "obd.mil_distance" to "std_21",
            "obd.voltage" to "std_42",
            // ---- 派生（calc_*）：全部 7 条 ----
            "calc.l100" to "calc_l100",
            "calc.fuel_hourly" to "calc_lh",
            "calc.boost" to "calc_boost",
            "calc.trip" to "calc_km",
            "calc.gforce" to "calc_gforce",
            "calc.gx" to "calc_gx",
            "calc.gy" to "calc_gy",
        )

        /**
         * 别名表**没覆盖到**的、默认启用的内置 PID。
         *
         * 抽成函数是为了让「补别名时漏了一条」变成**可测的事实**，
         * 而不是靠人记得同步三处（Kotlin 别名表 / 主题工具 / 设计指南）。
         *
         * @return 缺失的 PID id（空 = 完整）
         */
        fun missingAliases(): List<String> {
            val covered = PID_ALIASES.values.toSet()
            return BuiltInPids.all()
                .filter { it.enabled }        // 厂家模板默认关闭，刻意不要求
                .map { it.id }
                .filterNot { it in covered }
        }

        /** 把别名解析成真实 PID id。已经是 id 就原样返回 */
        fun resolvePid(name: String): String = PID_ALIASES[name] ?: name

        /**
         * 解析并校验。
         *
         * **不抛异常**：所有问题都进 [Result.errors]，带上字段路径，
         * 让设计者能直接定位到 JSON 里的哪一行。
         */
        fun parse(text: String): Result {
            val root = runCatching { JSONObject(text) }.getOrElse {
                return Result(null, listOf("JSON 语法错误：${it.message}"))
            }
            return parse(root)
        }

        fun parse(root: JSONObject): Result {
            val errors = ArrayList<String>()
            val warnings = ArrayList<String>()

            // ---- schema
            val schema = root.optString("schema", "")
            val isV2 = schema == SCHEMA_V2
            if (schema.isBlank()) {
                errors.add("缺少 `schema` 字段。应当写 \"$SCHEMA\" 或 \"$SCHEMA_V2\"")
            } else if (schema != SCHEMA && !isV2) {
                // 不兼容就明确拒绝 —— 静默按旧规则画会让人以为是渲染 bug
                errors.add("不支持的 schema：`$schema`（本版本认 `$SCHEMA` 与 `$SCHEMA_V2`）")
            }

            // ---- meta
            val meta = root.optJSONObject("meta")
            if (meta == null) warnings.add("没有 `meta` 段（不影响渲染，但建议写上名字方便识别）")

            // ---- canvas
            val canvas = root.optJSONObject("canvas")
            val unit = canvas?.optInt("unit", 0) ?: 0
            if (unit != 0 && unit != GaugeItem.CANVAS.toInt()) {
                errors.add(
                    "canvas.unit = $unit，但本版本只支持 ${GaugeItem.CANVAS.toInt()}。" +
                        "如果你按像素设计的，请换算：`坐标 / 屏宽 * 360`"
                )
            }

            // ---- background（v1.10.2，可选）
            val bg = parseBackground(root.optJSONObject("background"), warnings)

            // ---- gauges
            // ---- 素材清单（只有 v2 有；v1 没有素材概念）
            var assets: List<Asset> = emptyList()

            // ---- 多页面（可选）。有 pages 就读 pages，否则 nodes 当单页。
            // **向后兼容**：没有 pages 的老文件（含全部 v1 升级来的）行为完全不变。
            val pgArr = root.optJSONArray("pages")
            var pages: List<DesignPage> = emptyList()
            val hasPages = isV2 && pgArr != null && pgArr.length() > 0

            val nodes: List<DesignNode>
            if (hasPages) {
                val assetIds = parseAssetIds(root.optJSONArray("assets"))
                assets = parseAssets(root.optJSONArray("assets"), warnings)
                val list = ArrayList<DesignPage>(pgArr.length())
                for (p in 0 until pgArr.length()) {
                    val pg = pgArr.optJSONObject(p)
                    if (pg == null) {
                        errors.add("pages[$p] 不是一个对象")
                        continue
                    }
                    list.add(
                        DesignPage(
                            id = pg.optString("id", "pg$p"),
                            name = pg.optString("name", "页面 ${p + 1}"),
                            nodes = parseNodeArray(
                                pg.optJSONArray("nodes"), "pages[$p].nodes", errors, warnings, assetIds, allowEmpty = true
                            )
                        )
                    )
                }
                if (list.isEmpty()) {
                    errors.add("pages 是空的 —— 仪表盘上什么都不会显示")
                    nodes = emptyList()      // 上面已经报错了，这里只是让编译通过
                } else {
                    pages = list
                    nodes = list[0].nodes      // **nodes 指向第一页**，渲染层不用知道 pages
                }
            } else if (isV2) {
                val arr = root.optJSONArray("nodes")
                if (arr == null) {
                    errors.add("缺少 `nodes` 数组")
                    return Result(null, errors, warnings)
                }
                if (arr.length() == 0) errors.add("`nodes` 是空的 —— 仪表盘上什么都不会显示")
                val assetIds = parseAssetIds(root.optJSONArray("assets"))
                assets = parseAssets(root.optJSONArray("assets"), warnings)
                val out = ArrayList<DesignNode>(arr.length())
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i)
                    if (o == null) {
                        errors.add("nodes[$i] 不是一个对象")
                        continue
                    }
                    DesignNode.parse(o, "nodes[$i]", errors, warnings, assetIds)?.let { out.add(it) }
                }
                val total = DesignNode.flatten(out).size
                if (total > DesignNode.MAX_NODES) {
                    errors.add("`nodes` 展开后有 $total 个节点，超过上限 ${DesignNode.MAX_NODES}")
                }
                nodes = out
            } else {
                // v1 → v2：每一项**一对一**变成一个 gauge 根节点（z 用下标保绘制顺序）
                val arr = root.optJSONArray("gauges")
                if (arr == null) {
                    errors.add("缺少 `gauges` 数组")
                    return Result(null, errors, warnings)
                }
                if (arr.length() == 0) errors.add("`gauges` 是空的 —— 仪表盘上什么都不会显示")
                if (arr.length() > MAX_GAUGES) {
                    errors.add("`gauges` 有 ${arr.length()} 项，超过上限 $MAX_GAUGES")
                }
                val out = ArrayList<DesignNode>(arr.length())
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i)
                    if (o == null) {
                        errors.add("gauges[$i] 不是一个对象")
                        continue
                    }
                    val g = parseGauge(o, i, errors, warnings)
                    out.add(
                        DesignNode(
                            id = "v1_$i", type = DesignNode.TYPE_GAUGE, name = "仪表 $i",
                            x = g.x, y = g.y, w = g.w, h = g.h, z = i, gauge = g
                        )
                    )
                }
                nodes = out
            }

            // 展平成仪表列表 —— 现有渲染器与全部单测都按它写，v1 行为完全不变
            val gauges = DesignNode.collectGauges(nodes)

            // ---- 布局自检：越界不会报错、只会"看不见那块表"，所以必须主动查
            gauges.forEachIndexed { i, g ->
                if (g.x < 0f || g.y < 0f) {
                    warnings.add("gauges[$i]（${g.pidId}）坐标为负：x=${g.x} y=${g.y}，会被画到屏幕外")
                }
                if (g.x + g.w > GaugeItem.CANVAS + 1f || g.y + g.h > GaugeItem.CANVAS + 1f) {
                    warnings.add(
                        "gauges[$i]（${g.pidId}）超出画布右下角：" +
                            "右=${"%.0f".format(g.x + g.w)} 下=${"%.0f".format(g.y + g.h)}（上限 ${GaugeItem.CANVAS.toInt()}）"
                    )
                }
                if (g.w < 10f || g.h < 10f) {
                    warnings.add("gauges[$i]（${g.pidId}）尺寸过小（${"%.0f".format(g.w)}×${"%.0f".format(g.h)}），几乎看不见")
                }
                if (g.minVal >= g.maxVal) {
                    errors.add("gauges[$i]（${g.pidId}）量程非法：min=${g.minVal} ≥ max=${g.maxVal}")
                }
            }

            if (errors.isNotEmpty()) return Result(null, errors, warnings)

            // pages 兜底：v1 升级路径与"只有 nodes"的老文件都没有 pages，
            // 补一个单页 —— 保证 `pages` 永远非空，渲染层与 Store 都不用判空。
            if (pages.isEmpty()) pages = listOf(DesignPage("pg0", "主页面", nodes))

            val d = DesignFile(
                name = meta?.optString("name", "")?.takeIf { it.isNotBlank() } ?: "未命名设计",
                author = meta?.optString("author", "") ?: "",
                description = meta?.optString("description", "") ?: "",
                themeId = root.optString("theme", ""),
                themeColors = root.optJSONObject("themeColors"),
                background = bg,
                assets = assets,
                nodes = nodes,
                pages = pages,
                designW = canvas?.optInt("designW", 2560) ?: 2560,
                designH = canvas?.optInt("designH", 1600) ?: 1600,
                scaleMode = canvas?.optInt("scaleMode", SCALE_STRETCH) ?: SCALE_STRETCH,
                gauges = gauges
            )
            return Result(d, emptyList(), warnings)
        }

        /**
         * 背景段解析（可选）。
         *
         * ## 只存路径，不内嵌图片
         *
         * 设计文件要能被人读、被 diff 看。塞 base64 会让它变成不可读的二进制块，
         * 而且每次改一个坐标都要重写几 MB。图片由 App 侧「风格 → 选择背景图片」
         * 导入到 `files/bg/`。
         *
         * ## 路径不存在**只警告不报错**
         *
         * 设计文件常在不同设备/机器之间传递，写死一个本机绝对路径必然对不上。
         * 拦下整个设计文件太粗暴 —— 仪表布局本身是好的，只是背景要重新选一张。
         */
        private fun parseBackground(
            o: JSONObject?, warnings: MutableList<String>
        ): Background? {
            if (o == null) return null
            val path = o.optString("path", "").trim()
            if (path.isEmpty()) {
                warnings.add("`background` 段没有 `path` —— 已忽略该段（不影响仪表布局）")
                return null
            }
            val fit = o.optInt("fit", FIT_FILL)
            val w = o.optInt("w", 0)
            val h = o.optInt("h", 0)
            if (fit !in FIT_NAMES.indices) {
                warnings.add(
                    "background.fit = $fit 不认识（本版本只认 0..${FIT_NAMES.lastIndex}：" +
                        "${FIT_NAMES.joinToString(" / ")}）—— 已回落到「${FIT_NAMES[FIT_FILL]}」"
                )
                return Background(path, FIT_FILL)
            }
            // 绝对路径在本机不存在是常态，只提示
            if (!java.io.File(path).isFile) {
                warnings.add(
                    "background.path 指向的文件在本机不存在：`$path` —— " +
                        "请用「风格 → 选择背景图片」重新选一张（仪表布局不受影响）"
                )
            }
            return Background(path, fit, w, h)
        }

        /**
         * 解析一个节点数组。
         *
         * 抽出来是因为 `nodes` 与 `pages[i].nodes` 走同一套逻辑 ——
         * 复制一份迟早分叉（错误文案会不一致）。
         */
        /**
         * @param allowEmpty 空数组算不算错误。
         *
         *   - 顶层 `nodes` / `gauges`：**算错误** —— 一个空仪表盘没有意义，
         *     明确报出来比让用户对着黑屏猜要好
         *   - `pages[i].nodes`：**不算** —— 多页设计里某一页还没填是正常的，
         *     报错会让"新建一页"立刻变成非法状态
         */
        private fun parseNodeArray(
            arr: JSONArray?, path: String,
            errors: MutableList<String>, warnings: MutableList<String>,
    assetIds: Set<String>, allowEmpty: Boolean = false
        ): List<DesignNode> {
            if (arr == null) return emptyList()
            if (arr.length() == 0 && !allowEmpty) errors.add("`$path` 是空的 —— 仪表盘上什么都不会显示")
            val out = ArrayList<DesignNode>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i)
                if (o == null) {
                    errors.add("$path[$i] 不是一个对象")
                    continue
                }
                DesignNode.parse(o, "$path[$i]", errors, warnings, assetIds)?.let { out.add(it) }
            }
            val total = DesignNode.flatten(out).size
            if (total > DesignNode.MAX_NODES) {
                errors.add("`$path` 展开后有 $total 个节点，超过上限 ${DesignNode.MAX_NODES}")
            }
            return out
        }

        /** 单块表的解析。PID 别名在这里落地 */
        /**
         * 解析 `assets[]`。
         *
         * `path` 为空只**警告**不报错 —— 素材清单缺路径不影响布局，
         * 只是那个图片节点会画不出来。设计文件常跨机器传，拦下整个设计太粗暴。
         */
        private fun parseAssets(arr: JSONArray?, warnings: MutableList<String>): List<Asset> {
            if (arr == null) return emptyList()
            val out = ArrayList<Asset>(arr.length())
            val seen = HashSet<String>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val id = o.optString("id", "")
                if (id.isBlank()) {
                    warnings.add("assets[$i] 缺少 `id` —— 已忽略该项")
                    continue
                }
                if (!seen.add(id)) {
                    warnings.add("assets[$i] 的 id `$id` 重复 —— 已忽略重复项")
                    continue
                }
                val path = o.optString("path", "")
                if (path.isBlank()) warnings.add("assets[$i]（$id）没有 `path` —— 该素材画不出来")
                out.add(
                    Asset(
                        id = id,
                        name = o.optString("name", id),
                        kind = o.optString("kind", "custom"),
                        path = path,
                        w = o.optInt("w", 0),
                        h = o.optInt("h", 0)
                    )
                )
            }
            return out
        }

        /**
         * 收集 `assets[]` 里的素材 id。
         *
         * 用途：图片节点引用了一个不在清单里的素材时给**警告**（不是硬错误）——
         * 设计文件常跨机器传，素材可能还没拷过来。
         */
        private fun parseAssetIds(arr: JSONArray?): Set<String> {
            if (arr == null) return emptySet()
            val out = HashSet<String>()
            for (i in 0 until arr.length()) {
                val a = arr.optJSONObject(i) ?: continue
                val id = a.optString("id", "")
                if (id.isNotBlank()) out.add(id)
            }
            return out
        }

        private fun parseGauge(
            o: JSONObject, i: Int, errors: MutableList<String>, warnings: MutableList<String>
        ): GaugeItem {
            val rawPid = o.optString("pid", "")
            if (rawPid.isBlank()) {
                errors.add("gauges[$i] 缺少 `pid`（可以写语义名如 `obd.rpm`，或直接写 PID id 如 `std_0C`）")
            }
            val pid = resolvePid(rawPid)
            if (rawPid.isNotBlank() && !PID_ALIASES.containsKey(rawPid) && BuiltInPids.all().none { it.id == pid }) {
                warnings.add("gauges[$i] 的 pid `$rawPid` 不在内置 PID 库里 —— 需要先在 App 里导入对应 PID")
            }

            // ⚠️ **必须注入 unit 标记再交给 fromJson**。
            //
            // `GaugeItem.fromJson` 会用元素自己的 `unit` 字段判断"这是旧格式（归一化）还是新格式"，
            // 没有该字段就 ×360（旧配置迁移）。而设计文件的单位声明在 **canvas.unit** 上，
            // 元素里没有 —— 不注入的话每个坐标都会被再乘一次 360（12.5 → 4500）。
            // 这个坑是单测抓出来的。
            val normalized = JSONObject(o.toString()).apply {
                put("unit", GaugeItem.CANVAS.toInt())
            }
            val g = GaugeItem.fromJson(normalized)
            // fromJson 认的是解析后的 id；别名在这里替换回去
            return g.copy(pidId = pid).also { it.legacyGrid = false }
        }
    }
}
