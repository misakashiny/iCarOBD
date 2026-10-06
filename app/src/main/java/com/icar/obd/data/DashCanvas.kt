package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * **一套画布**（方案 A：多画布）。
 *
 * ## 为什么要有它
 *
 * 到 v1.19.26 为止，「仪表盘」是**全局唯一的一份**：`settings.dashType` 三选一
 * （普通 / 性能 / 自定义），自定义那套是全局的 `Store.customGauges`。
 * 于是「上班看日常、跑山看性能」只能靠**来回改配置** —— 而改一次要动
 * 类型 + 布局 + 主题 + 背景 + 设计文件，改回来又得再动一遍。
 *
 * 现在把这些**打包成一套可命名的画布**，横滑即可切换（见 `DashFragment` 的 ViewPager2）。
 *
 * ## 为什么每个字段都跟着画布走，而不是留在全局设置里
 *
 * 「一套画布」= 用户看到的**那一屏**。配色（[theme]）、背景图（[bgImagePath] 等）、
 * 多页面设计看到第几页（[pageIndex]）**都是那一屏的一部分** ——
 * 留成全局的话，切画布会出现「性能页顶着日常页的暖色底图」这种半套效果，
 * 比没有多画布更费解。
 *
 * 轮询间隔 / 音效这类**与画面无关**的开关仍然留在 `Store.Settings` 里，不跟着画布走。
 *
 * ## 与 `Settings` 里那几个字段的关系（重要）
 *
 * `Settings` 仍然保留 `dashType` / `gaugeTheme` / `designJson` / `bgImagePath` /
 * `dashPageIndex` 这些**旧字段**，它们现在的身份是
 * **「当前画布的实时副本」** —— 见 `Store.snapshotToActiveCanvas()` 与
 * `Store.loadActiveCanvas()`。
 *
 * 这样做是为了**不动那 100 多处调用点**：渲染、编辑器、主题编辑器照旧读写
 * `Store.settings.xxx`，落盘/切画布时由 Store 双向同步。
 * 反过来（把字段全搬到画布上、再给每个调用点换成转发属性）会让
 * 「漏改一处就静默读到过期值」成为可能，而副本方案里漏改只是"少存一次"，
 * 下一次 `saveSettings()` 就补上了。
 */
data class DashCanvas(
    /** 稳定 id。**排序靠 JSON 数组的下标，不靠它** —— 它只用来跨会话认人 */
    var id: String = UUID.randomUUID().toString(),

    /** 用户可见的名字。空名会被 [sanitizeName] 兜成 [DEFAULT_NAME] */
    var name: String = DEFAULT_NAME,

    /** 布局类型，取值见 [TYPE_NORMAL] / [TYPE_PERF] / [TYPE_CUSTOM] */
    var type: Int = TYPE_NORMAL,

    /**
     * 自定义布局的仪表列表。
     *
     * ⚠️ 与 `Store.customGauges` 是**两份数据**（不是同一个 List 实例）：
     * `customGauges` 是"当前画布"的实时工作区，落盘时浅拷进这里。
     * 浅拷意味着两边的 `GaugeItem` **是同一批对象** —— 与
     * `DashCanvasEditorView` 的就地编辑约定一致（拖完不用重建）。
     */
    var gauges: MutableList<GaugeItem> = mutableListOf(),

    /** 导入的 v2 设计文件**原文**（空 = 用 [gauges] 的扁平表） */
    var designJson: String = "",

    /** 配色（`GaugeTheme` 的 id）。0 = 霓虹，与出厂默认一致 */
    var theme: Int = 0,

    /** 多页面设计看第几页（越界由渲染层夹住） */
    var pageIndex: Int = 0,

    /** 背景图片绝对路径（空 = 主题纯色） */
    var bgImagePath: String = "",

    /** 背景在设计里的尺寸（画布单位，0 = 铺满） */
    var bgW: Int = 0,
    var bgH: Int = 0,

    /** 背景铺法，取值与 `DesignFile.FIT_*` 同源 */
    var bgFit: Int = 0,

    /** 缩放模式，取值与 `DesignFile.SCALE_*` 同源 */
    var scaleMode: Int = 0,
) {

    /** 仪表条数（列表 / 设置页显示用；设计文件与扁平表不叠加，取两者较大的那个口径） */
    fun gaugeCount(): Int = if (designJson.isNotBlank()) {
        runCatching { DesignFile.parse(designJson).design?.gauges?.size ?: gauges.size }
            .getOrDefault(gauges.size)
    } else {
        gauges.size
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("type", type)
        put("theme", theme)
        put("pageIndex", pageIndex)
        put("bgImage", bgImagePath)
        put("bgW", bgW)
        put("bgH", bgH)
        put("bgFit", bgFit)
        put("scaleMode", scaleMode)
        // 空串不写：旧版本读到"没有这个键"就是"没有设计文件"，语义一致
        if (designJson.isNotBlank()) put("designJson", designJson)
        put("gauges", JSONArray().apply { gauges.forEach { put(it.toJson()) } })
    }

    companion object {

        /** 第一套画布的名字 —— 由旧配置迁移出来的那一套 */
        const val DEFAULT_NAME = "默认"

        /**
         * 画布数量上限。
         *
         * 不是技术限制，是**可用性限制**：每套画布占 ViewPager2 的一页，
         * 页数一多，横滑找一个盘面要滑很久 —— 而"多套画布"的初衷是少改配置，
         * 不是无限分屏。8 套足够覆盖「日常 / 性能 / 长途 / 越野 / 调试…」。
         */
        const val MAX_CANVASES = 8

        // ---------- 画布名浮标的位置 ----------
        //
        // ⚠️ 这是**全局显示偏好**（存在 `Settings.canvasNamePos`），
        // **不是每套画布各自的属性** —— 否则横滑时小字会在四个角之间乱跳。
        //
        // 为什么是"四个角 + 隐藏"而不是自由拖拽（v1.20.1）：
        //  1. 车上这块屏**只会设一次**，四角足够覆盖所有实际诉求；
        //  2. 自由拖拽要和「横滑翻页」抢同一个手势（拖浮标 vs 翻页），
        //     而"为了挪两个字把翻页手势搞坏"是明显不划算的交易；
        //  3. 自由坐标会落到「编辑」按钮底下/贴边 —— 又得再加一套避让规则。
        // 真需要任意位置时，正确做法是"长按浮标进入移动态"（那时不翻页），
        // 而不是让它在正常浏览时就能拖。

        const val NAME_POS_TOP_START = 0
        const val NAME_POS_TOP_END = 1
        const val NAME_POS_BOTTOM_START = 2
        const val NAME_POS_BOTTOM_END = 3
        const val NAME_POS_HIDDEN = 4

        /** 下标与 `NAME_POS_*` 一一对应，供 UI 直接当单选项 */
        val NAME_POS_NAMES = listOf("左上角", "右上角", "左下角", "右下角", "隐藏")

        /** 把 `NAME_POS_*` 解释成中文名；未知取值回落到左上角（不抛异常） */
        fun namePosName(pos: Int): String =
            NAME_POS_NAMES.getOrElse(pos) { NAME_POS_NAMES[NAME_POS_TOP_START] }

        const val TYPE_NORMAL = 0
        const val TYPE_PERF = 1
        const val TYPE_CUSTOM = 2

        val TYPE_NAMES = listOf("普通驾驶", "性能模式", "自定义仪表")

        /** 类型中文名；未知取值回落到第一项（不抛异常） */
        fun typeName(type: Int): String = TYPE_NAMES.getOrElse(type) { TYPE_NAMES[TYPE_NORMAL] }

        /**
         * 把用户输入的名字整理成可用的名字。
         *
         * 空名会让画布在列表里**看不见**（一行空白），比报错更难查，
         * 所以这里直接兜底而不是校验失败。
         */
        fun sanitizeName(raw: String?): String {
            val t = raw?.trim().orEmpty()
            return if (t.isEmpty()) DEFAULT_NAME else t.take(24)
        }

        fun fromJson(o: JSONObject): DashCanvas {
            val gauges = mutableListOf<GaugeItem>()
            o.optJSONArray("gauges")?.let { a ->
                for (i in 0 until a.length()) gauges.add(GaugeItem.fromJson(a.getJSONObject(i)))
            }
            return DashCanvas(
                id = o.optString("id").takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString(),
                name = sanitizeName(o.optString("name")),
                type = o.optInt("type", TYPE_NORMAL).coerceIn(TYPE_NORMAL, TYPE_CUSTOM),
                gauges = gauges,
                designJson = o.optString("designJson", ""),
                theme = o.optInt("theme", 0),
                pageIndex = o.optInt("pageIndex", 0),
                bgImagePath = o.optString("bgImage", ""),
                bgW = o.optInt("bgW", 0),
                bgH = o.optInt("bgH", 0),
                bgFit = o.optInt("bgFit", 0),
                scaleMode = o.optInt("scaleMode", 0),
            )
        }

        /** 解析画布数组；坏条目**跳过而不是整体失败** —— 少一套画布好过整个盘面读不出来 */
        fun listFromJson(a: JSONArray?): MutableList<DashCanvas> {
            val out = mutableListOf<DashCanvas>()
            if (a == null) return out
            for (i in 0 until a.length()) {
                runCatching { out.add(fromJson(a.getJSONObject(i))) }
            }
            return out
        }
    }
}
