package com.icar.obd.ui.dash

import com.icar.obd.data.DashCanvas
import com.icar.obd.data.DashLayout
import com.icar.obd.data.GaugeItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「哪一层布局优先」的规则（v1.17.7 修的那个 bug）。
 *
 * ## 背景：用户报的是"普通性能自定义都不显示表盘"
 *
 * 实测根因：`designJson` 原来**无条件优先**，于是一份**上一轮设备测试残留的
 * v2 设计**（2 个节点）压住了套用预设写进 `customGauges` 的 8 个表 ——
 * 用户在界面上切「普通 / 性能 / 自定义」，**看不到任何变化**。
 *
 * 这条规则在 `render()`（Fragment）里，测不了；所以抽成 [DashSpec.useDesignFile]。
 * **"哪一层优先"恰恰是最该钉住的部分** —— 错了的表现是"点了没反应"，最难查。
 */
class DashSpecTest {

    private val design = """{"schema":"icar.ui/2","pages":[]}"""

    @Test
    fun `普通与性能不受导入的设计文件影响`() {
        // 这两个是**内置布局**，跟"导入过什么"无关。
        // 被劫持的表现就是用户报的那句："切了页签什么都没变"
        assertFalse(DashSpec.useDesignFile(DashSpec.NORMAL, design))
        assertFalse(DashSpec.useDesignFile(DashSpec.PERF, design))
    }

    @Test
    fun `自定义有设计文件时用设计文件`() {
        assertTrue(DashSpec.useDesignFile(DashSpec.CUSTOM, design))
    }

    @Test
    fun `自定义没有设计文件时回落到扁平表`() {
        // 没有导入过 → 用 Store.customGauges（预设 / 手改的那批）
        assertFalse(DashSpec.useDesignFile(DashSpec.CUSTOM, ""))
        // 全空白也算没有（清除设计文件就是把它设成空串）
        assertFalse(DashSpec.useDesignFile(DashSpec.CUSTOM, "   "))
        assertFalse(DashSpec.useDesignFile(DashSpec.CUSTOM, "\n\t"))
    }

    @Test
    fun `越界类型不崩溃也不误用设计文件`() {
        // `dashType` 在 DashFragment 里已被 coerceIn(0,2) 夹住，这里是兜底：
        // 任何非 CUSTOM 的值都不该去用导入的设计文件
        assertFalse(DashSpec.useDesignFile(99, design))
        assertFalse(DashSpec.useDesignFile(-1, design))
    }

    // ---------------------------------------------------------------- 多画布（v1.20.0）

    /**
     * 横滑时每一页要渲染**自己那一套**。
     *
     * 用 `DashSpec.build(type)`（读 `Store.customGauges` = 当前画布）的话，
     * 所有页都会显示同一个盘面 —— 滑过去看起来像"没切换"，
     * 而设置页却说切了，是最难查的一类不一致。
     */
    @Test
    fun `每一页按自己那一套取规格`() {
        // 普通 / 性能 = 内置布局：**画布里就算有表也不该用它**
        // （否则迁移过来的"普通"画布会突然显示用户很久以前的自定义表）
        val normal = DashCanvas(name = "n", type = DashSpec.NORMAL)
        normal.gauges.add(GaugeItem(pidId = "std_0C"))
        assertEquals(DashLayout.normal().size, DashSpec.buildFor(normal).size)

        val perf = DashCanvas(name = "p", type = DashSpec.PERF)
        perf.gauges.add(GaugeItem(pidId = "std_0C"))
        assertEquals(DashLayout.perf().size, DashSpec.buildFor(perf).size)

        // 自定义 = 画布自己的表
        val custom = DashCanvas(name = "c", type = DashSpec.CUSTOM)
        custom.gauges.add(GaugeItem(pidId = "std_0C"))
        custom.gauges.add(GaugeItem(pidId = "std_0D"))
        assertEquals(2, DashSpec.buildFor(custom).size)
    }
}
