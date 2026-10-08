package com.icar.obd.obd

import com.icar.obd.data.SignalTableCsv
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CAN 帧解析与聚合的单元测试（第二轮迭代 P6-6）。
 *
 * 这一层值得测，因为它是**防洪水**的第一道闸门：
 * `ATMA` 一秒能出上千帧，聚合/有界逻辑写错就会重演 v1.3.0 的内存与日志事故。
 */
class CanFrameTest {

    private fun frame(id: Int, vararg d: Int) = CanFrame.Frame(id, d.toList())

    // ================================================================ 解析

    @Test
    fun `解析 11 位 ID 的帧`() {
        val f = CanFrame.parseLine("7E8 10 14 49 02 01 31 47 31")
        assertNotNull(f)
        assertEquals(0x7E8, f!!.canId)
        assertEquals(listOf(0x10, 0x14, 0x49, 0x02, 0x01, 0x31, 0x47, 0x31), f.data)
        assertFalse(f.isExtended)
    }

    @Test
    fun `解析 29 位 ID 的帧`() {
        val f = CanFrame.parseLine("18DAF110 10 14 49 02")
        assertNotNull(f)
        assertEquals(0x18DAF110, f!!.canId)
        assertTrue(f.isExtended)
    }

    @Test
    fun `大小写与多余空白都能容忍`() {
        val f = CanFrame.parseLine("  7e8   10  14  ")
        assertNotNull(f)
        assertEquals(0x7E8, f!!.canId)
        assertEquals(listOf(0x10, 0x14), f.data)
    }

    @Test
    fun `噪声行解析为 null`() {
        assertNull(CanFrame.parseLine("SEARCHING..."))
        assertNull(CanFrame.parseLine(""))
        assertNull(CanFrame.parseLine("   "))
        assertNull(CanFrame.parseLine(">"))
        assertNull(CanFrame.parseLine("NO DATA"))
    }

    @Test
    fun `只有 ID 没有数据时返回 null`() {
        assertNull(CanFrame.parseLine("7E8"))
    }

    @Test
    fun `非法的数据 token 被跳过但不影响其它字节`() {
        val f = CanFrame.parseLine("7E8 10 ZZ 14")
        assertNotNull(f)
        assertEquals(listOf(0x10, 0x14), f!!.data)
    }

    @Test
    fun `ID 长度不合法时返回 null`() {
        assertNull(CanFrame.parseLine("7E 10 14"))       // 2 位太短
        assertNull(CanFrame.parseLine("123456789 10"))   // 9 位太长
    }

    // ================================================================ 聚合

    @Test
    fun `相同 ID 累加计数 数据不变时 changed 不涨`() {
        val acc = CanFrame.Accumulator()
        repeat(5) { acc.feed(frame(0x7E8, 0x10, 0x14), 1000L + it) }
        val a = acc.aggregates().single()
        assertEquals(5, a.count)
        assertEquals("数据一直没变，changed 应为 1（首次）", 1, a.changed)
        assertEquals("10 14", a.lastData)
    }

    @Test
    fun `数据变化会累加 changed`() {
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x7E8, 0x10), 1L)
        acc.feed(frame(0x7E8, 0x11), 2L)
        acc.feed(frame(0x7E8, 0x11), 3L)
        acc.feed(frame(0x7E8, 0x12), 4L)
        val a = acc.aggregates().single()
        assertEquals(4, a.count)
        assertEquals(3, a.changed)
        assertEquals("12", a.lastData)
    }

    @Test
    fun `不同 ID 分开聚合 并按次数从多到少排序`() {
        val acc = CanFrame.Accumulator()
        repeat(3) { acc.feed(frame(0x100, 0x01), 1L) }
        repeat(7) { acc.feed(frame(0x200, 0x02), 1L) }
        val list = acc.aggregates()
        assertEquals(2, list.size)
        assertEquals("次数多的排前面", 0x200, list[0].canId)
        assertEquals(0x100, list[1].canId)
    }

    @Test
    fun `原始流有界 超出丢最旧并计数`() {
        val acc = CanFrame.Accumulator(maxRaw = 10)
        repeat(25) { acc.feed(frame(0x7E8, it), it.toLong()) }
        assertEquals(10, acc.rawFrames().size)
        assertEquals("超出部分要计数", 15, acc.dropped)
        assertEquals("聚合计数不受原始流上限影响", 25, acc.aggregates().single().count)
    }

    @Test
    fun `时间戳记录首末`() {
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x7E8, 0x01), 100L)
        acc.feed(frame(0x7E8, 0x02), 300L)
        val a = acc.aggregates().single()
        assertEquals(100L, a.firstTs)
        assertEquals(300L, a.lastTs)
    }

    @Test
    fun `feedLine 解析失败返回 false 且不改变状态`() {
        val acc = CanFrame.Accumulator()
        assertFalse(acc.feedLine("SEARCHING...", 1L))
        assertTrue(acc.aggregates().isEmpty())
        assertTrue(acc.feedLine("7E8 10 14", 2L))
        assertEquals(1, acc.aggregates().size)
    }

    @Test
    fun `clear 清空全部状态`() {
        val acc = CanFrame.Accumulator(maxRaw = 5)
        repeat(10) { acc.feed(frame(0x7E8, it), it.toLong()) }
        acc.clear()
        assertTrue(acc.aggregates().isEmpty())
        assertTrue(acc.rawFrames().isEmpty())
        assertEquals(0, acc.dropped)
        assertEquals(0, acc.frameCount())
    }

    // ================================================================ CSV
    //
    // v1.20.7（S1）：观察表 CSV 改成**中文表头 + BOM + `报文ID(dec)` 冗余列**。
    // 这三条都要钉住 —— 尤其是 BOM：漏了它 Excel 打开就是中文乱码，
    // 而那在设备上**看不出来**（文件照样能导出、能打开）。

    @Test
    fun `观察表 CSV 带 UTF-8 BOM`() {
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x7E8, 0x10, 0x14), 100L)
        assertTrue("聚合表缺 BOM：Excel 里中文表头会乱码", acc.aggregateCsv().startsWith("\uFEFF"))
        assertTrue("原始帧表缺 BOM", acc.rawCsv().startsWith("\uFEFF"))
    }

    @Test
    fun `聚合 CSV 有中文表头且行数与 ID 数一致`() {
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x7E8, 0x10, 0x14), 100L)
        acc.feed(frame(0x100, 0x01), 200L)
        val lines = SignalTableCsv.stripBom(acc.aggregateCsv()).trim().split("\n")
        assertEquals(
            "报文ID(hex),报文ID(dec),29位ID,帧数,变化次数,最后数据,首次时间(ms),最后时间(ms)",
            lines[0]
        )
        assertEquals(3, lines.size)
        assertTrue("实际: ${lines[1]}", lines[1].startsWith("\"7E8\",2024,0,1,1,10 14,100,100"))
    }

    @Test
    fun `原始帧 CSV 有中文表头且行数与原始帧数一致`() {
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x7E8, 0x10), 100L)
        acc.feed(frame(0x7E8, 0x10), 200L)
        val lines = SignalTableCsv.stripBom(acc.rawCsv()).trim().split("\n")
        assertEquals("时间戳(ms),报文ID(hex),报文ID(dec),29位ID,DLC,数据", lines[0])
        assertEquals(3, lines.size)
        assertEquals("100,\"7E8\",2024,0,1,10", lines[1])
    }

    @Test
    fun `29 位 ID 在 CSV 里标记为 extended`() {
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x18DAF110, 0x10), 1L)
        assertTrue(acc.aggregateCsv().contains("\"18DAF110\",${0x18DAF110},1,"))
        assertTrue(acc.rawCsv().contains(",\"18DAF110\",${0x18DAF110},1,"))
    }

    @Test
    fun `聚合记录最长帧长度 供模板预填 DLC`() {
        // 同一个 ID 可能既有 4 字节帧又有 8 字节帧；模板要预填**能放下信号的那种**
        val acc = CanFrame.Accumulator()
        acc.feed(frame(0x09A, 0x00, 0x00, 0x00, 0x00, 0x88, 0x00, 0x03, 0x00), 1L)
        acc.feed(frame(0x09A, 0x00, 0x00, 0x00, 0x00), 2L)
        assertEquals("要取最长的那一帧，不能取最后一帧", 8, acc.aggregates().single().dlc())
    }
}
