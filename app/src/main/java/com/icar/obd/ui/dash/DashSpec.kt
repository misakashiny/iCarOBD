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

    /**
     * 这次渲染该不该用**导入的设计文件**（v2 节点树）？
     *
     * ## 为什么抽成纯函数
     *
     * 这条规则错过一次，而且错得很难查（v1.17.7）：
     * 原来 `designJson` **无条件优先**，于是导入过一次设计文件之后，
     * 「普通 / 性能」也被它劫持 —— 用户切页签**看不到任何变化**，
     * 报的是"普通性能自定义都不显示表盘"。
     *
     * 实测根因：一份上一轮设备测试残留的 v2 设计（2 个节点）
     * 压住了套用预设写进 `customGauges` 的 8 个表。
     *
     * 正确语义：**只有「自定义」页签才可能用设计文件** ——
     * 普通 / 性能是内置布局，它们跟"导入过什么"无关。
     *
     * 抽出来是为了能单测：`render()` 在 Fragment 里，测不了；
     * 而"哪一层优先"恰恰是**最该钉住**的部分。
     */
    fun useDesignFile(type: Int, designJson: String): Boolean =
        type == CUSTOM && designJson.isNotBlank()
}
