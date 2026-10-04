package com.icar.obd.ui.view

import android.content.Context
import com.icar.obd.data.GaugeItem

/**
 * 仪表样式 → View 的**唯一映射处**。
 *
 * 抽出来的原因：渲染器（[com.icar.obd.ui.dash.DashRenderer]）与拖拽编辑器
 * （[DashCanvasEditorView]）都要按 `style` 建视图。分两处写必然分叉 ——
 * 「编辑器里看到的样式和实际渲染出来的不一样」是最难查的一类 bug。
 *
 * 依赖方向：`ui/dash → ui/view`，单向且正确。
 */
object GaugeViewFactory {

    fun create(ctx: Context, style: Int): BaseGaugeView = when (style) {
        GaugeItem.STYLE_CIRCLE -> CircularGaugeView(ctx)
        GaugeItem.STYLE_DIGITAL -> DigitalGaugeView(ctx)
        GaugeItem.STYLE_BAR -> BarGaugeView(ctx)
        GaugeItem.STYLE_LINE -> LineChartView(ctx)
        GaugeItem.STYLE_DUAL_STACK -> DualStackGaugeView(ctx)
        GaugeItem.STYLE_QUAD -> QuadGaugeView(ctx)
        GaugeItem.STYLE_SUB_DUAL -> SubDualGaugeView(ctx)
        GaugeItem.STYLE_GFORCE -> GForceGaugeView(ctx)
        // 未知 style（比如降级回来的旧配置）回落到数字表，绝不崩
        else -> DigitalGaugeView(ctx)
    }
}
