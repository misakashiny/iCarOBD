package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet

/**
 * 多数据显示视图的公共基类。
 *
 * 它只负责两件事：**缓存画笔** + **画一个数值单元**（标签 / 数值 / 单位）。
 * 子类只决定单元怎么摆：上下、2×2、还是主大副小。
 *
 * 数值来源与红线：所有值都是渲染层通过
 * [updateMulti] 推过来的，本类**不去读总线**（红线 4.1.5）。
 */
abstract class MultiValueGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : BaseGaugeView(context, attrs, def) {

    protected val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        isFakeBoldText = true
    }
    protected val labelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
    protected val unitPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }

    /**
     * 画一个数值单元。
     *
     * @param cx    单元水平中心
     * @param top   单元顶部 y
     * @param cellH 单元可用高度（字号按它取比例，所以大格子自然是大字）
     * @param extraIndex 副参数序号（0 起）；`-1` = 这是主参数。
     *   **报警判定与配色统一走基类**，本类不再自己判 `warn` ——
     *   否则主参数用 [alertLevel]、副参数用各自的 `warnLow/warnHigh`，
     *   两套概念又在这里分叉（v1.10.1 重构掉的正是这个）
     */
    protected fun drawCell(
        canvas: Canvas,
        cx: Float,
        top: Float,
        cellH: Float,
        label: String,
        valueText: String,
        unitText: String,
        extraIndex: Int
    ) {
        if (cellH <= 0f) return

        // ⚠️ T11-TEXTFIT：**按真实字形高度排版，不再用"字号当行距"**。
        //
        // 旧写法 `baseline = top + labelSize` 等于假设「行高 = 字号」，
        // 但中文字形 ascent 可达 1.15×字号，导致标题底部越过数值顶部 ——
        // 就是实屏那个「电压/瞬时油耗小卡片标题与大数值重叠」
        // （docs/03_历史归档/20261014_迭代清单_整理前.md:1682）。
        //
        // 另外三个字号占比 0.19/0.44/0.17 相加 0.80 < 1 **看着**够，
        // 但真实占位要乘字形高度倍数（中文 ≈1.4）→ 1.12 > 1，本身就会溢出。
        // [TextFit.computeSizes] 会在放不下时整体等比缩小。
        val hasLabel = label.isNotBlank()
        val hasUnit = unitText.isNotBlank()
        val metricFor: (Float) -> TextFit.FontMetric = { size ->
            // 三行共用同一套字体，按字号缩放度量即可（Paint 的 textSize 变了它才变）
            measureAt(size)
        }
        val (labelSize, valueSize, unitSize) = TextFit.computeSizes(cellH, hasLabel, hasUnit, metricFor)

        val lay = TextFit.layout(
            top = top, cellH = cellH,
            labelSize = labelSize, valueSize = valueSize, unitSize = unitSize,
            hasLabel = hasLabel, hasUnit = hasUnit,
            labelMetric = metricFor(labelSize),
            valueMetric = metricFor(valueSize),
            unitMetric = metricFor(unitSize),
        )

        lay.label?.let { line ->
            labelPaint.textSize = line.size
            labelPaint.color = cLabel
            canvas.drawText(label, cx, line.baseline, labelPaint)
        }

        val v = lay.value
        valuePaint.textSize = v.size
        valuePaint.color = if (extraIndex < 0) valueTextColor() else extraTextColor(extraIndex)
        neonText(canvas, valueText, cx, v.baseline, valuePaint, valuePaint.color, valuePaint.textSize)

        lay.unit?.let { line ->
            unitPaint.textSize = line.size
            unitPaint.color = cLabel
            canvas.drawText(unitText, cx, line.baseline, unitPaint)
        }
    }

    /**
     * 取"字号为 [size] 时"的字体度量。
     *
     * 三行共用同一套字体（`labelPaint`/`valuePaint`/`unitPaint` 的 typeface 一致），
     * 所以只要拿到某个字号的 Metrics，按 size 比例缩放即可 ——
     * 不必为了测量去改三个 Paint 的 `textSize`（那会在测得过程中影响绘制状态）。
     *
     * 用 `descent - ascent` 的**相对值**缩放：`Paint.FontMetrics` 随 textSize 线性变化。
     */
    private fun measureAt(size: Float): TextFit.FontMetric {
        val probe = labelPaint.textSize
        if (probe <= 0f) return TextFit.estimateMetric(size)
        val fm = labelPaint.fontMetrics
        val k = size / probe
        return TextFit.FontMetric(ascent = fm.ascent * k, descent = fm.descent * k)
    }
}
