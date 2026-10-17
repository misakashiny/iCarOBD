package com.icar.obd.ui.view

/**
 * **多值卡片里「标题 / 数值 / 单位」三行的垂直排版**（T11-TEXTFIT）。
 *
 * ## 为什么需要这个纯函数
 *
 * 原来排版直接写在 `MultiValueGaugeView.drawCell()` 里，用**字号的百分比**当行距：
 *
 * ```kotlin
 * val labelSize = cellH * 0.19f
 * val valueSize = cellH * 0.44f
 * canvas.drawText(label, cx, top + labelSize, labelPaint)          // 基线 = 字号
 * val valueBaseline = top + labelSize + valueSize * 1.02f          // 行距 ≈ 字号×1.02
 * ```
 *
 * 三个字号占比相加 `0.19+0.44+0.17 = 0.80 < 1`，**看着**放得下。
 * 但 `drawText` 的 y 是**基线不是顶部**，`labelSize` 当行距等于假设「行高 = 字号」。
 * 中文字形的 ascent 可达 `1.15×字号`，于是：
 *
 * ```
 * label 字形底部  = 0.19 + 0.25×0.19 = 0.2375 cellH
 * value 字形顶部  = 0.6388 − 1.15×0.44 = 0.1328 cellH
 *                   0.2375 > 0.1328 → 重叠
 * ```
 *
 * 这正是实屏看到的「电压 / 瞬时油耗小卡片标题与大数值重叠」
 * （`docs/03_历史归档/20261014_迭代清单_整理前.md:1682`）。
 *
 * ## 做法
 *
 * 用**真实字体度量**（[FontMetric]，由调用方从 `Paint.fontMetrics` 传入）
 * 算出每一行的字形矩形，按"字形底部 + 间隙 = 下一行字形顶部"反推基线。
 * 不依赖 `android.graphics` → 可以在 JVM 单测里跑。
 */
object TextFit {

    /**
     * 字体度量（对应 `Paint.FontMetrics` 的四个值，单位 px）。
     *
     * @param ascent  到基线**上方**的距离，**负数**（Android 约定）
     * @param descent 基线下方距离，正数
     */
    data class FontMetric(val ascent: Float, val descent: Float) {
        /** 字形实际高度（永远为正） */
        val glyphHeight: Float get() = descent - ascent
    }

    /** 一行文字排出来的竖直位置 */
    data class Line(
        /** 字号 */
        val size: Float,
        /** 传给 `canvas.drawText` 的基线 y */
        val baseline: Float,
        /** 字形矩形顶部 */
        val glyphTop: Float,
        /** 字形矩形底部 */
        val glyphBottom: Float,
    )

    /** 三行（或更少）排完后的整体结果 */
    data class Layout(
        val label: Line?,
        val value: Line,
        val unit: Line?,
        /** 所有行字形的最低点，用于判断是否越界 */
        val contentBottom: Float,
    ) {
        /** 所有非空行，按从上到下 */
        val lines: List<Line> get() = listOfNotNull(label, value, unit)
    }

    /** 相邻两行之间的最小间隙（相对于该行字号的比例） */
    const val GAP_RATIO = 0.06f

    /**
     * 三行的**目标字号占比**：标题 0.19 / 数值 0.44 / 单位 0.17（与旧实现一致）。
     *
     * ⚠️ 注意这三个数是**字号**占比，不是占位高度占比。
     * 真实占位 = 字号 × 字形高度倍数（中文约 1.4），
     * 所以三者累计占位 ≈ `1.12 × cellH` —— **本身就超了**，旧实现必然溢出。
     * [computeSizes] 会在放不下时同比例缩小，保证不溢出。
     */
    private const val LABEL_RATIO = 0.19f
    private const val VALUE_RATIO = 0.44f
    private const val UNIT_RATIO = 0.17f

    /**
     * 按单元格高度算出三行字号，**保证字形总高 + 间隙不超过 cellH**。
     *
     * 旧实现三个占比相加 0.80 < 1 看着够，但那是"字号之和"；
     * 实际占位要乘字形高度倍数（中文 ≈ 1.4），得到 1.12 > 1 → 向下溢出。
     * 这里按真实度量算出总占位，超出就整体等比缩小 ——
     * 比例关系（标题小、数值大）保持不变，只是整体变小一点。
     *
     * @return 三行字号（label, value, unit）
     */
    fun computeSizes(
        cellH: Float,
        hasLabel: Boolean,
        hasUnit: Boolean,
        metricFor: (Float) -> FontMetric,
    ): Triple<Float, Float, Float> {
        // 先按原始占比算字号
        var ls = cellH * LABEL_RATIO
        var vs = cellH * VALUE_RATIO
        var us = cellH * UNIT_RATIO

        // 算这批字号实际要占多高
        var need = 0f
        var count = 0
        if (hasLabel) { need += metricFor(ls).glyphHeight; count++ }
        need += metricFor(vs).glyphHeight; count++
        if (hasUnit) { need += metricFor(us).glyphHeight; count++ }
        // 行间隙（每两行一个）
        if (count > 1) need += (count - 1) * (vs * GAP_RATIO)

        if (need > cellH && need > 0f) {
            val k = cellH / need
            ls *= k; vs *= k; us *= k
        }
        return Triple(ls, vs, us)
    }

    /**
     * 计算三行的基线。
     *
     * 顺序固定为 **标题 → 数值 → 单位**（与原来一致）。
     * 某一行为空（文本为空白）时不占位 —— 这样"没有单位"的卡片不会白留一条空行。
     *
     * @param top        单元格顶部 y
     * @param cellH      单元格高度
     * @param labelSize  标题字号
     * @param valueSize  数值字号
     * @param unitSize   单位字号
     * @param hasLabel   标题是否有内容
     * @param hasUnit    单位是否有内容
     * @param labelMetric 标题字体度量（null = 用字号估算，见 [estimateMetric]）
     */
    fun layout(
        top: Float,
        cellH: Float,
        labelSize: Float,
        valueSize: Float,
        unitSize: Float,
        hasLabel: Boolean,
        hasUnit: Boolean,
        labelMetric: FontMetric? = null,
        valueMetric: FontMetric? = null,
        unitMetric: FontMetric? = null,
    ): Layout {
        // 每行的度量：没传就用字号估算（这样纯函数在没有字体时也能给出合理结果）
        val lm = labelMetric ?: estimateMetric(labelSize)
        val vm = valueMetric ?: estimateMetric(valueSize)
        val um = unitMetric ?: estimateMetric(unitSize)

        val lines = ArrayList<Line>(3)

        // ⚠️ 关键：**从顶部开始按"字形"往下排**，而不是按基线。
        // 每行的字形顶部 = 上一行字形底部 + 间隙；基线 = 字形顶部 - ascent。
        var cursor = top
        var prevSize = valueSize // 间隙基准：用较大的那一行字号，不至于挤

        fun place(size: Float, m: FontMetric): Line {
            val gap = if (lines.isEmpty()) 0f else minOf(prevSize, size) * GAP_RATIO
            val glyphTop = cursor + gap
            val baseline = glyphTop - m.ascent // ascent 是负数，所以是加
            val glyphBottom = baseline + m.descent
            val line = Line(size, baseline, glyphTop, glyphBottom)
            lines.add(line)
            cursor = glyphBottom
            prevSize = size
            return line
        }

        val labelLine = if (hasLabel) place(labelSize, lm) else null
        val valueLine = place(valueSize, vm)
        val unitLine = if (hasUnit) place(unitSize, um) else null

        return Layout(
            label = labelLine,
            value = valueLine,
            unit = unitLine,
            contentBottom = cursor,
        )
    }

    /**
     * 没有真实字体时的度量估算。
     *
     * 取 **ascent = -1.0×size、descent = 0.25×size**：
     * 比拉丁字体（约 -0.75/0.25）保守，覆盖中文字形的实际高度，
     * 宁可多留一点空隙也不要重叠。
     */
    fun estimateMetric(size: Float): FontMetric = FontMetric(ascent = -size, descent = size * 0.25f)

    /** 两行之间是否重叠（用于测试与自检；正常布局应为 false） */
    fun overlaps(a: Line, b: Line): Boolean = a.glyphBottom > b.glyphTop
}
