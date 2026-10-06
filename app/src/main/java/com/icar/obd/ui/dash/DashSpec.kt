package com.icar.obd.ui.dash

import com.icar.obd.data.DashCanvas
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

    /**
     * 类型常量。
     *
     * **权威定义在 [DashCanvas]**（画布住在 `data/` 层）——
     * 这里只是给 ui 层留一组顺手的别名。两边各写一份 0/1/2 迟早会分叉，
     * 而分叉的后果是"切到性能页显示的是普通布局"这种静默错误。
     */
    const val NORMAL = DashCanvas.TYPE_NORMAL
    const val PERF = DashCanvas.TYPE_PERF
    const val CUSTOM = DashCanvas.TYPE_CUSTOM

    fun title(type: Int): String = DashCanvas.typeName(type)

    fun build(type: Int): List<GaugeItem> = when (type) {
        NORMAL -> DashLayout.normal()
        PERF -> DashLayout.perf()
        else -> Store.customGauges.toList()
    }

    /**
     * **某一套画布**要渲染的仪表列表。
     *
     * ## 为什么不直接用 [build]
     *
     * [build] 读的是**当前画布**（`Store.customGauges`）。横滑时每一页要渲染
     * **自己那一套** —— 用 `build` 的话所有页都会显示当前画布的盘面，
     * 滑过去看起来像"没切换"（而设置页又说切了，最难查的一类不一致）。
     *
     * ## 语义与旧版一致
     *
     * 普通 / 性能 = 内置布局（与画布里的 [DashCanvas.gauges] 无关），
     * 自定义 = 画布自己的表。这正是 v1.19.x 里 `dashType` 三选一的语义，
     * 迁移过来**不会改变用户看到的画面** —— 也因此，
     * 内置布局的画布要拖拽编辑必须先转成自定义（见 `DashCanvasPageFragment`）。
     */
    fun buildFor(canvas: DashCanvas): List<GaugeItem> = when (canvas.type) {
        NORMAL -> DashLayout.normal()
        PERF -> DashLayout.perf()
        else -> canvas.gauges.toList()
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
