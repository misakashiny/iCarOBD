package com.icar.obd.ui.view

import android.graphics.drawable.GradientDrawable
import com.icar.obd.data.Store
import org.json.JSONObject

/**
 * 仪表盘视觉主题。
 *
 * 主题只影响渲染颜色与几何参数，**不影响 PID、量程或采集频率** ——
 * 切换主题不会触及 OBD 数据链路。
 *
 * ## 为什么放在 `ui/view/` 而不是 `ui/dash/`
 *
 * 主题是「绘制所需的调色板 + 几何参数」，属于最底层的绘制契约。
 * [BaseGaugeView] 必须认识它，而 `ui/view/` 不应该反向依赖上层编排层 `ui/dash/`。
 * 依赖方向是 `ui/dash → ui/view`，单向且正确。
 *
 * ## 用户自建主题（v1.5.0）
 *
 * 内置三套是**只读默认值**；用户自建的存在
 * [Store.customThemeJson] 里（原始 JSON 字符串，见那里的注释说明为什么不是对象），
 * [all] / [of] 会把两边合起来看。自建主题的 `id` 从 [CUSTOM_ID_BASE] 起，避免撞内置。
 *
 * ## 辉光色不要写死
 *
 * 霓虹主题的扫弧、指针与中心环用多层渐变辉光，颜色必须由 [accent] / [accentHot]
 * 派生（见 `BaseGaugeView.glowColor`）。**不要在绘制代码里写死 RGB** ——
 * 早期把霓虹橙硬编码在 [CircularGaugeView] 里，只因当时只有 NEON 开 glow 才没暴露。
 */
data class GaugeTheme(
    val id: Int,
    val title: String,
    val description: String,
    val background: Int,
    val surface: Int,
    val surfaceEdge: Int,
    val accent: Int,
    val accentHot: Int,
    val accentDim: Int,
    val track: Int,
    val tick: Int,
    val needle: Int,
    val value: Int,
    val label: Int,
    val dim: Int,
    val glow: Boolean,
    // ---------- v1.5.0：可自定义的几何参数 ----------
    /** 卡片圆角（dp） */
    val cardRadiusDp: Float = 18f,
    /** 卡片描边宽度（dp）。**0 = 无边框** */
    val cardStrokeDp: Float = 1f,
    /** 卡片不透明度 0..255。0 = 完全透明（只剩仪表本身，适合叠在背景图上） */
    val cardAlpha: Int = 255,
    /** 圆表量程弧 / 条形表主条的粗细（dp） */
    val strokeDp: Float = 9f,
    /** 圆表指针长度占半径的比例（0.2~1.0） */
    val needleLengthRatio: Float = 0.62f,
    /** 默认指针环样式（仪表自己没设时用它），取值见 `GaugeItem.RING_*` */
    val defaultRingStyle: Int = 0,
    /** 默认指针环段数 */
    val defaultRingSegments: Int = 40,
    /** 是否用户自建（内置为 false，用于 UI 上区分「可删/不可删」） */
    val custom: Boolean = false,
    /**
     * 全局霓虹样式。单块表可用 `GaugeItem.neonPreset` 覆盖。
     */
    val neon: NeonStyle = NeonStyle.AUTO,

    // ---------- v1.10.4：数值动画 ----------
    /**
     * 缓动曲线。取值见 [Easing.MODE_*]，名字见 [Easing.MODE_NAMES]。
     *
     * 默认「标准（指数）」—— 全程减速、收尾长，最不容易看出"跳变"。
     */
    val easingMode: Int = Easing.MODE_STANDARD,

    /**
     * 缓动时间常数（毫秒）。**越小越快**，一个 τ 走约 63%。
     *
     * 默认 120ms。⚠️ 别调太小：数据是 5Hz 推的（200ms 一次），
     * τ ≤ 45ms 时指针会在 200ms 内走完 98% 然后"趴"在目标上等下一次推送 ——
     * 看起来就是一格一格地跳，而不是"走"过去。详见 [BaseGaugeView.TAU_MS] 的注释。
     */
    val easingTauMs: Float = 120f,

    /**
     * 输入滤波时间常数（毫秒）。**0 = 不滤波**。
     *
     * 专门压**数据本身的抖动**（传感器噪声、量化误差），与缓动曲线解耦：
     *  - 想更稳 → 调大（代价是响应变慢）
     *  - 想更灵敏 → 调小
     *
     * 默认 90ms：能明显压掉单帧噪声，又不会让读数显得迟钝。
     */
    val valueSmoothingMs: Float = 90f
) {
    /**
     * 卡片背景。
     *
     * @param density 屏幕密度（dp → px）。默认 1 只为兼容旧调用点；
     *   渲染器应当传真实密度，否则高 dpi 设备上圆角与描边会明显偏细。
     */
    fun cardBackground(density: Float = 1f): GradientDrawable {
        val fill = intArrayOf(withAlpha(surface), withAlpha(background))
        return GradientDrawable(GradientDrawable.Orientation.TL_BR, fill).apply {
            cornerRadius = cardRadiusDp * density
            val w = cardStrokeDp * density
            // 0 = 无边框。另外 <0.5px 的描边画出来是虚的，不如不画
            if (w >= 0.5f) setStroke(Math.round(w).coerceAtLeast(1), withAlpha(surfaceEdge))
        }
    }

    /** 按 [cardAlpha] 叠透明度。255 时原样返回，省掉不必要的位运算 */
    private fun withAlpha(c: Int): Int =
        if (cardAlpha >= 255) c else (c and 0x00FFFFFF) or (cardAlpha.coerceIn(0, 255) shl 24)

    /**
     * 应用**单块表的卡片外观覆盖**（[com.icar.obd.data.GaugeItem.cardStyle]）。
     *
     * ## 为什么放在主题这一层
     *
     * 覆盖只改「卡片长什么样」这三个数，其余 20 个色值不变 —— 所以实现成
     * `copy(cardXxx = ...)` 而不是另起一套绘制路径。渲染器与编辑器共用它，
     * **保证所见即所得**（红线 §4.5.20：样式映射只能有一处）。
     *
     * @param style `GaugeItem.CARD_*`；`null` 或 [com.icar.obd.data.GaugeItem.CARD_THEME]
     *   返回自身（零开销）
     */
    fun withCardOverride(style: Int?): GaugeTheme = when (style) {
        null, com.icar.obd.data.GaugeItem.CARD_THEME -> this
        com.icar.obd.data.GaugeItem.CARD_NO_BORDER -> copy(cardStrokeDp = 0f)
        // 底色与描边都不要：只剩仪表本体，直接叠在背景图上
        com.icar.obd.data.GaugeItem.CARD_TRANSPARENT,
        com.icar.obd.data.GaugeItem.CARD_NONE -> copy(cardStrokeDp = 0f, cardAlpha = 0)
        // 未知取值（降级回来的新配置）回落到"跟随主题"，绝不崩
        else -> this
    }

    /**
     * 卡片背景；[style] 非空时先套用覆盖。
     *
     * 返回 `null` 表示**这块表不要卡片底**（[com.icar.obd.data.GaugeItem.CARD_NONE]）——
     * 调用方据此把 host 的背景设为 null，省掉一次 Drawable 分配与绘制。
     */
    fun cardBackgroundFor(style: Int?, density: Float): GradientDrawable? =
        if (style == com.icar.obd.data.GaugeItem.CARD_NONE) null
        else withCardOverride(style).cardBackground(density)

    /** 复制一份并换个身份，用于「另存为自定义主题」 */
    fun asCustom(newId: Int, newTitle: String): GaugeTheme =
        copy(id = newId, title = newTitle, custom = true)

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("title", title)
        put("description", description)
        put("background", background)
        put("surface", surface)
        put("surfaceEdge", surfaceEdge)
        put("accent", accent)
        put("accentHot", accentHot)
        put("accentDim", accentDim)
        put("track", track)
        put("tick", tick)
        put("needle", needle)
        put("value", value)
        put("label", label)
        put("dim", dim)
        put("glow", glow)
        put("cardRadiusDp", cardRadiusDp.toDouble())
        put("cardStrokeDp", cardStrokeDp.toDouble())
        put("cardAlpha", cardAlpha)
        put("strokeDp", strokeDp.toDouble())
        put("needleLengthRatio", needleLengthRatio.toDouble())
        put("defaultRingStyle", defaultRingStyle)
        put("defaultRingSegments", defaultRingSegments)
        // 数值动画（v1.10.4）。旧主题读到没有这几个字段 → 用默认值，行为与改造前一致
        put("easingMode", easingMode)
        put("easingTauMs", easingTauMs.toDouble())
        put("valueSmoothingMs", valueSmoothingMs.toDouble())
    }

    companion object {
        const val NEON = 0
        const val ICE = 1
        const val CLASSIC = 2

        /** 用户自建主题的 id 起点，避免与内置冲突 */
        const val CUSTOM_ID_BASE = 100

        /**
         * 内置主题的**稳定别名**（v1.10.3）。
         *
         * 设计文件 / `theme` 字段里写的是**名字**（`"neon"`）而不是数字 id ——
         * id 会随自建主题分配而变化（从 [CUSTOM_ID_BASE] 起递增），
         * 同一份设计文件在不同设备上 id 可能不同，**名字才是跨机器稳定的**。
         *
         * 放在 `GaugeTheme` 而不是 `DashFragment`：这是主题自己的属性，
         * 而且 `data/DesignFile.kt` 导出时也要用它（`data/` 不能依赖 `ui/`，
         * 所以由调用方把别名传进去）。
         */
        fun aliasOf(id: Int): String? = when (id) {
            NEON -> "neon"
            ICE -> "ice"
            CLASSIC -> "amber"
            else -> null
        }

        /** 按别名找主题。找不到返回 `null`（调用方决定是回落还是提示） */
        fun byAlias(alias: String): GaugeTheme? =
            all().firstOrNull { aliasOf(it.id) == alias }

        /**
         * 解析 `#RRGGBB` / `#AARRGGBB`。
         *
         * 刻意**不用 `android.graphics.Color.parseColor`**：那是 Android 桩，
         * JVM 单测里一调用就抛 `Stub!`，会让整个 `GaugeTheme` 没法测。
         * 这里只需要十六进制，纯 Kotlin 足够。
         */
        private fun c(hex: String): Int {
            val s = hex.removePrefix("#")
            val v = s.toLongOrNull(16) ?: 0L
            return when (s.length) {
                6 -> (0xFF000000L or v).toInt()
                8 -> v.toInt()
                else -> 0xFF000000.toInt()
            }
        }

        private val builtins = listOf(
            GaugeTheme(
                NEON, "霓虹赛道", "橙黄辉光，强调转速与性能感",
                c("#080A0E"), c("#17110D"), c("#553520"),
                c("#FF8A00"), c("#FFE45C"), c("#5B2B00"),
                c("#322820"), c("#725635"), c("#FFB000"),
                c("#FFF4DF"), c("#D8BFA0"), c("#806B57"), true
            ),
            GaugeTheme(
                ICE, "冰川科技", "冷青色 HUD，适合日常驾驶",
                c("#071018"), c("#0C1B28"), c("#1B4C62"),
                c("#28D7FF"), c("#B8F5FF"), c("#123D52"),
                c("#173343"), c("#4C8195"), c("#63E5FF"),
                c("#E7FAFF"), c("#9DC7D6"), c("#5E8493"), false
            ),
            GaugeTheme(
                CLASSIC, "经典琥珀", "低干扰琥珀字，夜间更克制",
                c("#0B0B09"), c("#181714"), c("#4A4530"),
                c("#E3A83B"), c("#FFD57A"), c("#4C3612"),
                c("#302D23"), c("#766B4D"), c("#E8B84F"),
                c("#FFF6DB"), c("#D5C8A3"), c("#847B61"), false
            )
        )

        /** 只含内置三套（UI 上判断「能不能删」用） */
        fun builtIns(): List<GaugeTheme> = builtins

        /** 内置 + 用户自建 */
        fun all(): List<GaugeTheme> = builtins + Store.customThemeJson.mapNotNull { parse(it) }

        fun of(id: Int): GaugeTheme = all().firstOrNull { it.id == id } ?: builtins.first()

        /**
         * **这份设计该用哪个主题**（v2.26.0）。
         *
         * ## 优先级：内嵌配色 > 设置里的主题 id
         *
         * 为什么优先内嵌：设计文件是**作品**，配色是作品的一部分。
         * 跟着设备当前主题走的话，同一份设计在两台机器上长得不一样。
         *
         * ## 为什么不担心"和用户自建主题冲突"
         *
         * 用户自建主题没有稳定别名（`aliasOf` 只认内置的三个），所以设计文件里的
         * `theme` 字段**本来就指不到自建主题** —它靠的是 `themeColors`。
         * 而 `themeColors` 存在时优先级最高，不会再去看设置。
         *
         * ## 每一步都可能失败，所以每一步都有回退
         *
         * ```
         * designJson 空 / 解析失败      → 设置里的主题
         * 没有 themeColors 字段         → 设置里的主题
         * themeColors 不是对象          → 设置里的主题（parse 会给 null）
         * themeColors 字段缺失/是坏值   → fromJson 逐字段回退到内置霓虹
         * ```
         *
         * **抽成纯函数是为了能测** —原来这段长在 `DashFragment.render()` 里，
         * Fragment 没法单测，于是"优先级到底对不对"一直没验证过。
         */
        fun resolveFor(designJson: String, settingsThemeId: Int): GaugeTheme {
            val embedded = designJson.takeIf { it.isNotBlank() }?.let { dj ->
                runCatching {
                    com.icar.obd.data.DesignFile.parse(dj).design?.themeColors
                }.getOrNull()
            }
            return embedded?.let { runCatching { fromJson(it) }.getOrNull() }
                ?: of(settingsThemeId)
        }

        /** 下一个可用的自建主题 id */
        fun nextCustomId(): Int =
            (all().filter { it.custom }.maxOfOrNull { it.id } ?: (CUSTOM_ID_BASE - 1)) + 1

        private fun parse(json: String): GaugeTheme? =
            runCatching { fromJson(JSONObject(json)) }.getOrNull()

        /** 从备份 / 持久化里读回。缺字段一律退回内置霓虹的对应值，不会崩。 */
        fun fromJson(o: JSONObject): GaugeTheme {
            val fallback = builtins.first()
            return GaugeTheme(
                id = o.optInt("id", CUSTOM_ID_BASE),
                title = o.optString("title", "自定义主题"),
                description = o.optString("description", ""),
                background = o.optInt("background", fallback.background),
                surface = o.optInt("surface", fallback.surface),
                surfaceEdge = o.optInt("surfaceEdge", fallback.surfaceEdge),
                accent = o.optInt("accent", fallback.accent),
                accentHot = o.optInt("accentHot", fallback.accentHot),
                accentDim = o.optInt("accentDim", fallback.accentDim),
                track = o.optInt("track", fallback.track),
                tick = o.optInt("tick", fallback.tick),
                needle = o.optInt("needle", fallback.needle),
                value = o.optInt("value", fallback.value),
                label = o.optInt("label", fallback.label),
                dim = o.optInt("dim", fallback.dim),
                glow = o.optBoolean("glow", false),
                cardRadiusDp = o.optDouble("cardRadiusDp", 18.0).toFloat(),
                cardStrokeDp = o.optDouble("cardStrokeDp", 1.0).toFloat(),
                cardAlpha = o.optInt("cardAlpha", 255),
                strokeDp = o.optDouble("strokeDp", 9.0).toFloat(),
                needleLengthRatio = o.optDouble("needleLengthRatio", 0.62).toFloat(),
                defaultRingStyle = o.optInt("defaultRingStyle", 0),
                defaultRingSegments = o.optInt("defaultRingSegments", 40),
                // 数值动画（v1.10.4）。旧主题没有这几个字段 → 用**新默认值**。
                // 这是刻意的：v1.10.4 的动画改善（τ 45→120ms + 输入滤波）正是
                // 想让所有存量主题都享受到，而不是"只有新建主题才变顺"。
                easingMode = o.optInt("easingMode", Easing.MODE_STANDARD),
                easingTauMs = o.optDouble("easingTauMs", 120.0).toFloat(),
                valueSmoothingMs = o.optDouble("valueSmoothingMs", 90.0).toFloat(),
                custom = true
            )
        }
    }
}
