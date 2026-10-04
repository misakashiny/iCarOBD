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
        val labelSize = cellH * 0.19f
        val valueSize = cellH * 0.44f
        val unitSize = cellH * 0.17f

        labelPaint.textSize = labelSize
        labelPaint.color = cLabel
        canvas.drawText(label, cx, top + labelSize, labelPaint)

        valuePaint.textSize = valueSize
        valuePaint.color = if (extraIndex < 0) valueTextColor() else extraTextColor(extraIndex)
        val valueBaseline = top + labelSize + valueSize * 1.02f
        neonText(canvas, valueText, cx, valueBaseline, valuePaint, valuePaint.color, valuePaint.textSize)

        if (unitText.isNotBlank()) {
            unitPaint.textSize = unitSize
            unitPaint.color = cLabel
            canvas.drawText(unitText, cx, valueBaseline + unitSize * 1.2f, unitPaint)
        }
    }
}
