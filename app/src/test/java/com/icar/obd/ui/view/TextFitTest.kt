package com.icar.obd.ui.view

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **T11-TEXTFIT：小卡片标题与数值不得重叠**。
 *
 * ## 这个测试守的是什么
 *
 * 实屏确认过的问题（`docs/03_历史归档/20261014_迭代清单_整理前.md:1682`）：
 * 「电压 / 瞬时油耗小卡片标题与大数值重叠」。
 *
 * 原实现用**字号百分比当行距**（`baseline = top + labelSize`），等于假设
 * 「行高 = 字号」。中文字形 ascent 可达 `1.15×字号`，于是标题的底部越过了数值的顶部。
 *
 * 这里用**字形矩形**（真实 ascent/descent）判断重叠 —— 这是用户真正看得见的东西，
 * 而不是"字号加起来小于 1"这种看起来对的间接指标。
 */
class TextFitTest {

    /** 拉丁字体的典型度量（Android 默认 sans 大致如此） */
    private val latin = TextFit.FontMetric(ascent = -0.93f, descent = 0.24f)

    /** 中文字体的实际度量（比拉丁高，正是这次重叠的原因） */
    private val cjk = TextFit.FontMetric(ascent = -1.15f, descent = 0.25f)

    /** 用给定度量按 size 缩放一份 */
    private fun metricOf(base: TextFit.FontMetric, size: Float) =
        TextFit.FontMetric(ascent = base.ascent * size, descent = base.descent * size)

    /**
     * 原实现的排版（**照抄旧代码**），用于证明它确实会重叠 —— 这是"先证红"的证据。
     *
     * 旧代码（`MultiValueGaugeView.drawCell`）：
     * ```
     * labelSize = cellH * 0.19
     * valueSize = cellH * 0.44
     * drawText(label, cx, top + labelSize)
     * valueBaseline = top + labelSize + valueSize * 1.02
     * ```
     */
    private fun legacyLayout(top: Float, cellH: Float, m: TextFit.FontMetric): Pair<Float, Float> {
        val labelSize = cellH * 0.19f
        val valueSize = cellH * 0.44f
        val labelBaseline = top + labelSize
        val valueBaseline = top + labelSize + valueSize * 1.02f
        val labelBottom = labelBaseline + m.descent * labelSize
        val valueTop = valueBaseline + m.ascent * valueSize
        return labelBottom to valueTop
    }

    // ================================================================ 先证红：旧实现确实重叠

    /**
     * **证明旧实现会重叠**（中文度量下）。
     *
     * 这条不是修完代码该有的断言，而是**缺陷的存在性证明**：
     * 如果有人以为"字号总和 < 1 就没事"，这条会告诉他不是。
     */
    @Test
    fun `旧实现按中文度量会重叠_缺陷存在性证明`() {
        val (labelBottom, valueTop) = legacyLayout(top = 0f, cellH = 100f, m = cjk)
        assertTrue(
            "旧实现（baseline = top + labelSize）在中文下 labelBottom=$labelBottom 应越过 valueTop=$valueTop",
            labelBottom > valueTop
        )
    }

    /**
     * **旧实现在拉丁度量下也重叠**（只是量小，肉眼不明显）。
     *
     * ⚠️ 这条断言我最初写反了：一开始以为"拉丁没事、中文才叠"。
     * 实测 `labelBottom=23.56 > valueTop=22.96` —— 拉丁同样越界，只是幅度小。
     * 保留这条是为了记住：**问题是普遍的，不是中文特有**。
     */
    @Test
    fun `旧实现按拉丁度量同样重叠_只是幅度小`() {
        val (labelBottom, valueTop) = legacyLayout(top = 0f, cellH = 100f, m = latin)
        assertTrue(
            "拉丁下也会越界（$labelBottom > $valueTop），只是幅度小所以肉眼不明显",
            labelBottom > valueTop
        )
        // 中文的重叠幅度更大 —— 这才是用户先看到中文卡片出问题的原因
        val (cjkBottom, cjkTop) = legacyLayout(top = 0f, cellH = 100f, m = cjk)
        assertTrue(
            "中文重叠量应大于拉丁: ${cjkBottom - cjkTop} > ${labelBottom - valueTop}",
            (cjkBottom - cjkTop) > (labelBottom - valueTop)
        )
    }

    // ================================================================ 新实现：不重叠

    /** 中文三行齐全时不重叠 —— 核心用例。 */
    @Test
    fun `中文三行不重叠`() {
        val lay = layout(cellH = 100f, base = cjk)
        assertNoOverlap(lay)
    }

    /** 拉丁三行同样不重叠（不能为修中文而把英文弄坏）。 */
    @Test
    fun `拉丁三行不重叠`() {
        val lay = layout(cellH = 100f, base = latin)
        assertNoOverlap(lay)
    }

    /**
     * **各种宽高/字号组合都不重叠**。
     *
     * 用户的设计各异，卡片可能很高（大表）也可能很扁（状态条），
     * 所以按比例扫一遍而不是只测一个尺寸。
     */
    @Test
    fun `多种单元格高度下都不重叠`() {
        for (cellH in listOf(40f, 60f, 80f, 100f, 150f, 200f, 400f)) {
            val lay = layout(cellH = cellH, base = cjk)
            assertNoOverlap(lay, "cellH=$cellH")
        }
    }

    /** 极端：超大与超小单元格。小到 20px 也不能重叠（否则肉眼就是一团）。 */
    @Test
    fun `极端单元格高度下都不重叠`() {
        for (cellH in listOf(12f, 20f, 800f)) {
            assertNoOverlap(layout(cellH = cellH, base = cjk), "cellH=$cellH")
        }
    }

    // ================================================================ 边界

    /** 没有单位：不占位，数值就是最后一行。 */
    @Test
    fun `没有单位时不占位`() {
        val lay = layout(cellH = 100f, base = cjk, hasUnit = false)
        assertNull("没有单位就不该产生 unit 行", lay.unit)
        assertNoOverlap(lay)
    }

    /** 没有标题：不占位，数值从顶部开始。 */
    @Test
    fun `没有标题时不占位`() {
        val lay = layout(cellH = 100f, base = cjk, hasLabel = false)
        assertNull("没有标题就不该产生 label 行", lay.label)
        assertNoOverlap(lay)
    }

    /** 只有数值：一行，且从顶部紧贴开始，不浪费垂直空间。 */
    @Test
    fun `只有数值时从顶部开始`() {
        val lay = layout(cellH = 100f, base = cjk, hasLabel = false, hasUnit = false)
        assertNull(lay.label)
        assertNull(lay.unit)
        // 唯一的行应该正好从 top 开始（不留首行间隙）
        assertEquals("首行字形顶部应等于 top，不该白留空隙", 0f, lay.value.glyphTop, 1e-4f)
    }

    /** 内容不越出单元格（contentBottom 不超过 top + cellH）。 */
    @Test
    fun `内容不越出单元格`() {
        for (cellH in listOf(60f, 100f, 200f)) {
            val lay = layout(cellH = cellH, base = cjk)
            assertTrue(
                "cellH=$cellH 时内容底部 ${lay.contentBottom} 越出了 $cellH",
                lay.contentBottom <= cellH + 1e-3f
            )
        }
    }

    /**
     * **字号必须在放不下时整体缩小**。
     *
     * 旧实现三个占比相加 0.80 < 1 看着够，但那是"字号之和"；
     * 真实占位要乘字形高度倍数（中文 ≈1.4）→ 1.12 > 1，**必然向下溢出**。
     * 这条守的是"缩小"这个补偿动作确实发生了。
     */
    @Test
    fun `字号在放不下时整体缩小`() {
        val cellH = 100f
        val metricFor: (Float) -> TextFit.FontMetric = { metricOf(cjk, it) }
        val (ls, vs, us) = TextFit.computeSizes(cellH, true, true, metricFor)
        // 原始占比会是 19/44/17
        assertTrue("必须被缩小（原始 valueSize 应为 44，实际 $vs）", vs < cellH * 0.44f)
        // 比例关系必须保持不变：标题小、数值大、单位最小
        assertTrue("标题应小于数值", ls < vs)
        assertTrue("单位应小于数值", us < vs)
        assertEquals("标题:数值 的比例应保持 0.19:0.44", 0.19f / 0.44f, ls / vs, 1e-3f)
    }

    /** 放得下时**不该**无谓缩小 —— 小卡片不能因为保守而字变小。 */
    @Test
    fun `放得下时不缩小`() {
        val cellH = 100f
        // 一个"很矮"的字形：ascent=-0.3, descent=0.1（总高 0.4 倍字号）
        val tiny = TextFit.FontMetric(ascent = -0.3f, descent = 0.1f)
        val metricFor: (Float) -> TextFit.FontMetric = { metricOf(tiny, it) }
        val (ls, vs, us) = TextFit.computeSizes(cellH, true, true, metricFor)
        assertEquals("放得下时不该改字号", cellH * 0.19f, ls, 1e-3f)
        assertEquals(cellH * 0.44f, vs, 1e-3f)
        assertEquals(cellH * 0.17f, us, 1e-3f)
    }

    // ================================================================ 度量与集成

    /** 没有真实字体时必须给出保守估算（ascent 至少覆盖中文字形高度）。 */
    @Test
    fun `估算度量对中文足够保守`() {
        val est = TextFit.estimateMetric(100f)
        assertTrue(
            "估算的 ascent 应至少 1.0×字号，否则中文会被算矮而重叠",
            -est.ascent >= 100f
        )
        assertTrue("descent 应为正", est.descent > 0f)
        assertEquals("字形高度 = descent - ascent", 125f, est.glyphHeight, 1e-3f)
    }

    /** 传入真实 FontMetric 时应被采纳（不被估算覆盖）。 */
    @Test
    fun `真实度量优先于估算`() {
        val size = 44f
        val real = TextFit.FontMetric(ascent = -size * 2f, descent = size * 0.1f)
        val lay = TextFit.layout(
            top = 0f, cellH = 200f,
            labelSize = size, valueSize = size, unitSize = size,
            hasLabel = true, hasUnit = true,
            labelMetric = real, valueMetric = real, unitMetric = real,
        )
        // 字形高 = 2.1*size；若用了估算(1.25*size)间距会明显不同
        val lh = lay.value.glyphBottom - lay.value.glyphTop
        assertEquals("应采用传入的真实度量", 2.1f * size, lh, 1e-2f)
    }

    /** `overlaps` 自检工具本身要正确（否则测试会误报绿）。 */
    @Test
    fun `overlaps 判定正确`() {
        val a = TextFit.Line(10f, 0f, 0f, 10f)
        val b = TextFit.Line(10f, 20f, 15f, 25f)
        assertFalse("a 底 10 < b 顶 15，不该判为重叠", TextFit.overlaps(a, b))
        val c = TextFit.Line(10f, 20f, 5f, 15f)
        assertTrue("a 底 10 > c 顶 5，应判为重叠", TextFit.overlaps(a, c))
    }

    // ---------------------------------------------------------------- helpers

    private fun layout(
        cellH: Float,
        base: TextFit.FontMetric,
        hasLabel: Boolean = true,
        hasUnit: Boolean = true,
    ): TextFit.Layout {
        // 单位字号下 base 的度量就是"1 字号对应的高宽"，按字号缩放即可
        val metricFor: (Float) -> TextFit.FontMetric = { size -> metricOf(base, size) }
        val (labelSize, valueSize, unitSize) =
            TextFit.computeSizes(cellH, hasLabel, hasUnit, metricFor)
        return TextFit.layout(
            top = 0f, cellH = cellH,
            labelSize = labelSize, valueSize = valueSize, unitSize = unitSize,
            hasLabel = hasLabel, hasUnit = hasUnit,
            labelMetric = metricFor(labelSize),
            valueMetric = metricFor(valueSize),
            unitMetric = metricFor(unitSize),
        )
    }

    private fun assertNoOverlap(lay: TextFit.Layout, tag: String = "") {
        val lines = lay.lines
        assertTrue("${tag} 应至少一行", lines.isNotEmpty())
        for (i in 0 until lines.size - 1) {
            assertFalse(
                "${tag} 第 $i 行(底 ${lines[i].glyphBottom})与第 ${i + 1} 行(顶 ${lines[i + 1].glyphTop})重叠",
                TextFit.overlaps(lines[i], lines[i + 1])
            )
        }
    }
}
