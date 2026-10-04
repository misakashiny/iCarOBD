package com.icar.obd.ui.dash

import com.icar.obd.data.GaugeItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [DashboardBenchmark] 的纯逻辑测试。
 *
 * 这些断言的价值在于：排布和取值写错时，**真机上只表现为"某个表看着怪"**，
 * 靠肉眼几乎不可能发现 —— 而它们恰恰决定了测量结果可不可比
 * （格子重叠 → 互相遮挡 → 耗时偏小；值越界 → 指针顶死 → 动画停摆）。
 */
class DashboardBenchmarkTest {

    @Test
    fun `格子铺满画布且不重叠`() {
        val n = DashboardBenchmark.COLS * DashboardBenchmark.ROWS
        assertEquals("默认排布必须是 8 个（4×2）", 8, n)

        val rects = (0 until n).map { DashboardBenchmark.cellRect(it) }
        rects.forEach { r ->
            val (x, y, w, h) = listOf(r[0], r[1], r[2], r[3])
            assertTrue("x 不能为负", x >= 0f)
            assertTrue("y 不能为负", y >= 0f)
            assertTrue("右边界不能越界：x+w=${x + w}", x + w <= GaugeItem.CANVAS)
            assertTrue("下边界不能越界：y+h=${y + h}", y + h <= GaugeItem.CANVAS)
            assertTrue("尺寸必须为正", w > 0f && h > 0f)
        }

        // 两两不重叠 —— 重叠会让两个表互相遮挡，绘制成本凭空变低
        for (i in rects.indices) {
            for (j in i + 1 until rects.size) {
                val a = rects[i]; val b = rects[j]
                val overlapX = a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
                val overlapY = a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
                assertFalse("格子 $i 与 $j 重叠了", overlapX && overlapY)
            }
        }
    }

    @Test
    fun `格子尺寸完全一致`() {
        // 尺寸不一致会让"8 个表"的测量里混进几个特别大/小的表，数字没法横向比较
        val rects = (0 until 8).map { DashboardBenchmark.cellRect(it) }
        val w0 = rects[0][2]
        val h0 = rects[0][3]
        rects.forEachIndexed { i, r ->
            assertEquals("第 $i 个格子的宽应与第 0 个一致", w0, r[2], 1e-4f)
            assertEquals("第 $i 个格子的高应与第 0 个一致", h0, r[3], 1e-4f)
        }
    }

    @Test
    fun `仪表数量与 PID 数量一致且都绑定了有效 PID`() {
        val gauges = DashboardBenchmark.gauges
        assertEquals(8, gauges.size)
        assertEquals(DashboardBenchmark.pids.size, gauges.size)

        val ids = gauges.map { it.pidId }
        assertEquals("pidId 不能重复", ids.size, ids.toSet().size)
        gauges.forEachIndexed { i, g ->
            assertTrue("第 $i 条必须绑到真实 PID 定义", g.pidId == DashboardBenchmark.pids[i].id)
            assertTrue("量程必须合法（min < max）", g.minVal < g.maxVal)
        }
    }

    @Test
    fun `量程与 PID 定义一致`() {
        // 量程不一致 → 指针弧长/刻度密度不同 → 耗时不可比
        DashboardBenchmark.gauges.forEachIndexed { i, g ->
            val p = DashboardBenchmark.pids[i]
            assertEquals(p.minVal, g.minVal, 1e-4f)
            assertEquals(p.maxVal, g.maxVal, 1e-4f)
            assertEquals(p.warnHigh, g.warnHigh)
            assertEquals(p.warnLow, g.warnLow)
        }
    }

    @Test
    fun `假值始终落在量程内且不是 NaN`() {
        val gauges = DashboardBenchmark.gauges
        // 扫两个完整周期，步长取一个 60Hz 帧（16ms）
        var t = 0L
        while (t < (DashboardBenchmark.PERIOD_SEC * 2000).toLong()) {
            gauges.forEachIndexed { i, g ->
                val v = DashboardBenchmark.valueAt(i, t)
                assertFalse("t=$t index=$i 出现了 NaN", v.isNaN())
                assertTrue("t=$t index=$i 值 $v 低于 min ${g.minVal}", v >= g.minVal - 1e-3f)
                assertTrue("t=$t index=$i 值 $v 高于 max ${g.maxVal}", v <= g.maxVal + 1e-3f)
            }
            t += 16
        }
    }

    @Test
    fun `假值确实在变而不是常量`() {
        // 常量会让缓动瞬间收敛 → 视图不再重绘 → 测出来的帧率虚高
        val samples = (0 until 40).map { DashboardBenchmark.valueAt(0, it * 16L) }
        assertTrue("值必须有变化", samples.toSet().size > 10)
    }

    @Test
    fun `各条仪表相位错开`() {
        // 同相位的话 8 个表会在同一帧一起到峰值，峰值叠加，
        // 而真机上仪表本来就各走各的 —— 测出来的峰值会偏悲观
        val t = 250L
        val values = DashboardBenchmark.pids.indices.map { DashboardBenchmark.valueAt(it, t) }
        assertTrue("8 条表的同一时刻取值不应全部相同", values.toSet().size > 1)
    }

    @Test
    fun `valuesAt 返回主参数且不含副参数`() {
        val v = DashboardBenchmark.valuesAt(0, 0L)
        assertEquals(1, v.size)
        assertEquals(DashboardBenchmark.valueAt(0, 0L), v[0]!!, 1e-4f)
    }

    @Test
    fun `非法行列数不会算出负尺寸`() {
        // 防御性：调用方将来可能传别的列数。cols/rows 会被夹到至少 1，
        // 尺寸必须仍是正数（负尺寸会让 FrameLayout 直接抛异常）
        val r = DashboardBenchmark.cellRect(0, cols = 0, rows = 0)
        assertTrue("宽度必须为正，实际 ${r[2]}", r[2] > 0f)
        assertTrue("高度必须为正，实际 ${r[3]}", r[3] > 0f)
    }

    // ================================================================ 极限压力段

    @Test
    fun `压力段表数多于 PID 数时循环取 PID 而不是越界`() {
        // 12 个表只有 8 条 PID —— 必须循环，否则 gaugeList 会抛越界
        val list = DashboardBenchmark.gaugeList(DashboardBenchmark.STRESS_GAUGES, 4, 3)
        assertEquals(DashboardBenchmark.STRESS_GAUGES, list.size)
        list.forEach { g -> assertTrue("每条都要绑到真实 PID 定义", g.pidId.isNotBlank()) }
        (0 until list.size).forEach { i ->
            val v = DashboardBenchmark.valueAt(i, 1234L)
            assertFalse("压力段第 $i 条取到 NaN", v.isNaN())
        }
    }

    @Test
    fun `压力段 12 个格子铺满且不重叠`() {
        val rects = (0 until DashboardBenchmark.STRESS_GAUGES)
            .map { DashboardBenchmark.cellRect(it, 4, 3) }
        rects.forEach { r ->
            assertTrue("x 不能为负", r[0] >= 0f)
            assertTrue("y 不能为负", r[1] >= 0f)
            assertTrue("右边越界：${r[0] + r[2]}", r[0] + r[2] <= GaugeItem.CANVAS)
            assertTrue("下边越界：${r[1] + r[3]}", r[1] + r[3] <= GaugeItem.CANVAS)
        }
        for (i in rects.indices) {
            for (j in i + 1 until rects.size) {
                val a = rects[i]; val b = rects[j]
                val ox = a[0] < b[0] + b[2] && b[0] < a[0] + a[2]
                val oy = a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
                assertFalse("压力段格子 $i 与 $j 重叠", ox && oy)
            }
        }
    }

    @Test
    fun `压力段表数比常规段多 50%`() {
        // 「加 50% 负载看斜率」是这个段存在的理由，改了数字这条就不成立了
        assertEquals(
            (DashboardBenchmark.GAUGES * 1.5).toInt(),
            DashboardBenchmark.STRESS_GAUGES
        )
    }
}
