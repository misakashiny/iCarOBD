package com.icar.obd.ui.view

/**
 * 霓虹效果的样式。**可全局设，也可单独指定给某一块表**。
 *
 * ## 为什么做成数据类
 *
 * 原来辉光是写死的（`palette.glow` 一个布尔 + 硬编码 4 层），
 * 想调只能改代码。现在它是一个值：
 *
 *  - [GaugeTheme.neon] 是**全局默认**
 *  - [com.icar.obd.data.GaugeItem.neon] 是**单块表的覆盖**（null = 跟随全局）
 *
 * 于是「给转速表强霓虹、给水温表不发光」这种诉求不需要写代码。
 *
 * ## 字段都是"乘数"而不是"像素"
 *
 * 因为同一套样式要同时适配手机小表和 10 寸平板大表。
 * 写死像素值必然在某一端难看 —— [spreadRatio] 按控件短边取比例就是这个原因。
 */
data class NeonStyle(
    /** 总开关。关掉就完全不画辉光（省性能最有效的一档） */
    val enabled: Boolean = true,

    /**
     * 辉光层数。**0 = 按控件尺寸自适应**（见 `NeonPainter.layersFor`）。
     *
     * 显式给值适合两种情况：小表想省性能（给 2）、大表想更夸张（给 10）。
     */
    val layers: Int = 0,

    /** 扩散宽度 = 控件短边 × 这个比例。越大辉光越"散" */
    val spreadRatio: Float = 0.035f,

    /** 辉光强度。乘在每层透明度上。1.0 = 标准，<1 更克制，>1 更张扬 */
    val intensity: Float = 1f,

    /** 是否给文字也加辉光（数字表很吃这个，但字多时会糊） */
    val textGlow: Boolean = true
) {
    /** 实际使用的层数。0 = 自适应 */
    fun layersOr(adaptive: Int): Int =
        if (!enabled) 0 else if (layers > 0) layers.coerceIn(1, MAX_LAYERS) else adaptive

    companion object {
        /** 层数硬上限。再多肉眼看不出差别，只是白烧 GPU */
        const val MAX_LAYERS = 12

        /** 关闭 */
        val OFF = NeonStyle(enabled = false)

        /** 跟随尺寸自适应（默认） */
        val AUTO = NeonStyle()

        /**
         * 预设档位。
         *
         * 名字刻意用**观感词**而不是数字 —— 用户调的是"要多亮"，
         * 不是"要几层"。具体层数是我们的事。
         */
        val PRESETS: List<Pair<String, NeonStyle>> = listOf(
            "关闭" to OFF,
            "克制" to NeonStyle(layers = 2, spreadRatio = 0.022f, intensity = 0.7f, textGlow = false),
            "标准" to AUTO,
            "强烈" to NeonStyle(layers = 8, spreadRatio = 0.055f, intensity = 1.25f),
            "夸张" to NeonStyle(layers = 11, spreadRatio = 0.075f, intensity = 1.5f)
        )

        /** 按名字找预设，找不到给标准 */
        fun presetOf(name: String?): NeonStyle =
            PRESETS.firstOrNull { it.first == name }?.second ?: AUTO

        /** 反查：这个样式对应哪个预设名（用于 UI 显示当前档位） */
        fun presetNameOf(style: NeonStyle?): String {
            if (style == null) return "标准"
            return PRESETS.firstOrNull { it.second == style }?.first ?: "自定义"
        }
    }
}
