package com.icar.obd.ui.dash

import com.icar.obd.data.DashLayout
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.Store

/**
 * 仪表盘规格分发。
 *
 * 三种内置布局是「写死的默认值」，不是「写死的功能」——
 * 它们同样用 [GaugeItem] 表达，因此和用户自定义仪表走完全相同的渲染路径。
 *
 * **布局内容本身定义在 [DashLayout]**（`data/` 层），这里只做「类型 → 列表」的分发。
 * 这样做的原因：布局是纯数据变换，且 [Store] 加载配置时要调用布局迁移，
 * 若把内容写在这里会形成 `data → ui` 的反向依赖。
 *
 * 想改内置布局？改 [DashLayout] 即可，不需要动渲染层。
 */
object DashSpec {

    const val NORMAL = 0
    const val PERF = 1
    const val CUSTOM = 2

    fun title(type: Int): String = when (type) {
        NORMAL -> "普通驾驶"
        PERF -> "性能模式"
        else -> "自定义仪表"
    }

    fun build(type: Int): List<GaugeItem> = when (type) {
        NORMAL -> DashLayout.normal()
        PERF -> DashLayout.perf()
        else -> Store.customGauges.toList()
    }
}
