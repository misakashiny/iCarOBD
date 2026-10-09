package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [PidDedup] 的用例（v1.20.12）。
 *
 * 守的是任务里那句「**删除用户数据要极度谨慎**」：
 * 判重复宁可漏报也不能误报 —— 误报的代价是**删掉一条真信号**，
 * 而且它可能是某个仪表/规则唯一的来源。
 *
 * 另一条线是**设备上真实存在的那条重复**：
 * 手搓的 `TestMonitor09A`（`bitsAt(18,1,0,0)`）与内置「左转向灯」（`bit(C,2)`）
 * 文字完全不同，却是同一个位 —— 这一组用例就是钉住它必须被判出来。
 */
class PidDedupTest {

    private fun poll(
        id: String, name: String = id, mode: String = "01", pid: String = "05",
        formula: String = "A-40", builtIn: Boolean = false, group: String = "自定义"
    ) = PidDefinition(
        id = id, name = name, mode = mode, pid = pid, formula = formula,
        unit = "℃", minVal = 0f, maxVal = 200f, builtIn = builtIn, group = group
    )

    private fun mon(
        id: String, name: String = id, header: String = "09A",
        formula: String = "bit(C,2)", builtIn: Boolean = false
    ) = PidDefinition(
        id = id, name = name, protocol = "CAN", mode = "MON", pid = header,
        source = "monitor", header = header, formula = formula,
        unit = "", minVal = 0f, maxVal = 1f, builtIn = builtIn,
        group = if (builtIn) "监听型(实车确认)" else "自定义"
    )

    // ---------------------------------------------------------------- 位段指纹

    @Test
    fun `bit 与 bitsAt 指向同一位时指纹相同 —— 这就是设备上那条重复`() {
        // 实测：手搓的 TestMonitor09A 用 bitsAt(18,1,0,0)，内置左转向灯用 bit(C,2)
        // C 是第 3 个字节 → 字节号 2 → 帧内线性位 2*8+2 = 18，长度 1
        assertEquals(PidDedup.bitFingerprint("bit(C,2)"), PidDedup.bitFingerprint("bitsAt(18,1,0,0)"))
    }

    @Test
    fun `bit 的其它位也对得上`() {
        assertEquals(PidDedup.bitFingerprint("bit(C,3)"), PidDedup.bitFingerprint("bitsAt(19,1,0,0)"))
        assertEquals(PidDedup.bitFingerprint("bit(A,7)"), PidDedup.bitFingerprint("bitsAt(7,1,0,0)"))
        assertEquals(PidDedup.bitFingerprint("bit(A,0)"), PidDedup.bitFingerprint("bitsAt(0,1,0,0)"))
    }

    @Test
    fun `不同位指纹不同`() {
        assertFalse(PidDedup.bitFingerprint("bit(C,2)") == PidDedup.bitFingerprint("bit(C,3)"))
    }

    @Test
    fun `bits 多位的起始位换算正确`() {
        assertEquals(PidDedup.bitFingerprint("bits(A,6,4)"), PidDedup.bitFingerprint("bitsAt(6,4,0,0)"))
        assertEquals(PidDedup.bitFingerprint("bits(B,0,8)"), PidDedup.bitFingerprint("bitsAt(8,8,0,0)"))
    }

    @Test
    fun `signed 单字节等价于 bitsAt 八位有符号`() {
        assertEquals(PidDedup.bitFingerprint("signed(A)"), PidDedup.bitFingerprint("bitsAt(0,8,0,1)"))
    }

    @Test
    fun `系数与偏移算进指纹 —— 同一位不同缩放是两个量`() {
        assertFalse(
            PidDedup.bitFingerprint("bitsAt(0,8,0,0) * 0.1") ==
                PidDedup.bitFingerprint("bitsAt(0,8,0,0)")
        )
        assertEquals(
            PidDedup.bitFingerprint("bitsAt(0,8,0,0) * 0.1"),
            PidDedup.bitFingerprint("bitsAt( 0 , 8 , 0 , 0 )  *  0.1")
        )
    }

    @Test
    fun `认不出的公式返回 null —— 宁可漏报也不能误判`() {
        // 认不出来就必须判"不重复"：把两条不同的信号说成重复会导致误删真数据
        assertNull(PidDedup.bitFingerprint("((A*256)+B)/4"))
        assertNull(PidDedup.bitFingerprint("A-40"))
        assertNull(PidDedup.bitFingerprint(""))
        assertNull(PidDedup.bitFingerprint("bit(1,2)"))     // 第一个参数不是字节变量
    }

    // ---------------------------------------------------------------- isSameSignal

    @Test
    fun `同请求同公式算重复`() {
        val a = poll("x1", mode = "01", pid = "05", formula = "A-40")
        val b = poll("x2", mode = "01", pid = "05", formula = "A-40")
        assertTrue(PidDedup.isSameSignal(a, b))
    }

    @Test
    fun `同请求但公式不同不算重复 —— 那是对同一响应的两种解释`() {
        val a = poll("x1", mode = "01", pid = "05", formula = "A-40")
        val b = poll("x2", mode = "01", pid = "05", formula = "A")
        assertFalse(PidDedup.isSameSignal(a, b))
    }

    @Test
    fun `公式只差空白仍算重复`() {
        val a = poll("x1", mode = "01", pid = "05", formula = "A-40")
        val b = poll("x2", mode = "01", pid = "05", formula = "A - 40")
        assertTrue(PidDedup.isSameSignal(a, b))
    }

    @Test
    fun `不同请求不算重复`() {
        val a = poll("x1", mode = "01", pid = "05")
        val b = poll("x2", mode = "01", pid = "0C")
        assertFalse(PidDedup.isSameSignal(a, b))
    }

    @Test
    fun `监听型同报文同一位算重复 —— 设备上那条真重复`() {
        val builtin = mon("mon_turn_left", "左转向灯", "09A", "bit(C,2)", builtIn = true)
        val user = mon("0cb7ad46", "TestMonitor09A", "09A", "bitsAt(18,1,0,0)")
        assertTrue(PidDedup.isSameSignal(builtin, user))
    }

    @Test
    fun `监听型同报文不同位不算重复`() {
        val l = mon("a", "左", "09A", "bit(C,2)")
        val r = mon("b", "右", "09A", "bit(C,3)")
        assertFalse(PidDedup.isSameSignal(l, r))
    }

    @Test
    fun `监听型不同报文不算重复`() {
        val a = mon("a", "x", "09A", "bit(C,2)")
        val b = mon("b", "y", "12A", "bit(C,2)")
        assertFalse(PidDedup.isSameSignal(a, b))
    }

    @Test
    fun `监听型与请求型不互判 —— 数据来源根本不同`() {
        // 一个是主动问 ECU、一个是被动听广播，取到值的时机完全不同
        val m = mon("a", "转向灯", "09A", "bit(C,2)")
        val p = poll("b", "转向灯", mode = "01", pid = "09A", formula = "bit(C,2)")
        assertFalse(PidDedup.isSameSignal(m, p))
    }

    @Test
    fun `派生通道不参与判重`() {
        val a = PidDefinition(id = "calc_lh", name = "燃油流量", mode = "CALC", pid = "calc_lh",
            formula = "A", unit = "L/h", builtIn = true)
        val b = PidDefinition(id = "calc_l100", name = "瞬时油耗", mode = "CALC", pid = "calc_l100",
            formula = "A", unit = "L/100km", builtIn = true)
        assertFalse(PidDedup.isSameSignal(a, b))
    }

    @Test
    fun `同一条自己不算重复`() {
        val a = poll("x1")
        assertFalse(PidDedup.isSameSignal(a, a))
    }

    // ---------------------------------------------------------------- findDuplicates

    @Test
    fun `内置之间不判重复 —— 内置表是刻意设计的，且永远不给用户删`() {
        // std_5E 燃油消耗率(L/h) 与 calc_lh 燃油流量(L/h) 同单位，
        // 但前者是输入、后者是派生输出；把它们报成重复只会诱导误删
        val a = poll("std_5E", "燃油消耗率", mode = "01", pid = "5E", formula = "((A*256)+B)*0.05",
            builtIn = true, group = "标准 OBD")
        val b = PidDefinition(id = "calc_lh", name = "燃油流量", mode = "CALC", pid = "calc_lh",
            formula = "A", unit = "L/h", builtIn = true)
        assertTrue(PidDedup.findDuplicates(listOf(a, b)).isEmpty())
    }

    @Test
    fun `内置之间即使真的同请求同公式也不判 —— 不许诱导删内置`() {
        val a = poll("std_05", "冷却液温度", "01", "05", "A-40", builtIn = true)
        val b = poll("std_05b", "水温", "01", "05", "A-40", builtIn = true)
        assertTrue(PidDedup.findDuplicates(listOf(a, b)).isEmpty())
    }

    @Test
    fun `自定义撞内置要判出来，且保留内置`() {
        val builtin = poll("std_05", "冷却液温度", "01", "05", "A-40", builtIn = true)
        val custom = poll("uuid-1", "水温(我自己加的)", "01", "05", "A-40")
        val dups = PidDedup.findDuplicates(listOf(builtin, custom))
        assertEquals(1, dups.size)
        assertEquals("uuid-1", dups[0].pid.id)
        assertEquals("std_05", dups[0].shadowedBy.id)
    }

    @Test
    fun `两条都是自定义时保留先出现的`() {
        val first = poll("c1", "水温A", "01", "05", "A-40")
        val second = poll("c2", "水温B", "01", "05", "A-40")
        val dups = PidDedup.findDuplicates(listOf(first, second))
        assertEquals(1, dups.size)
        assertEquals("c2", dups[0].pid.id)
        assertEquals("c1", dups[0].shadowedBy.id)
    }

    @Test
    fun `设备上的那条重复能被完整判出来`() {
        val all = listOf(
            mon("mon_turn_left", "左转向灯", "09A", "bit(C,2)", builtIn = true),
            mon("mon_turn_right", "右转向灯", "09A", "bit(C,3)", builtIn = true),
            mon("0cb7ad46-d120-4b1d-8952-9462a9f71414", "TestMonitor09A", "09A", "bitsAt(18,1,0,0)")
        )
        val dups = PidDedup.findDuplicates(all)
        assertEquals(1, dups.size)
        assertEquals("TestMonitor09A", dups[0].pid.name)
        assertEquals("左转向灯", dups[0].shadowedBy.name)
        assertTrue(dups[0].reason.contains("09A"))
    }

    @Test
    fun `认不出公式的监听型不会被误判`() {
        val builtin = mon("a", "左转向灯", "09A", "bit(C,2)", builtIn = true)
        val weird = mon("b", "某个怪公式", "09A", "((A*256)+B)/4")
        assertTrue(PidDedup.findDuplicates(listOf(builtin, weird)).isEmpty())
    }

    // ---------------------------------------------------------------- 安全闸

    @Test
    fun `被仪表引用的重复条目不清理 —— 删了仪表会变空`() {
        val dup = PidDedup.Duplicate(poll("c1"), poll("std_05", builtIn = true), "同请求")
        assertTrue(PidDedup.isReferenced("c1", listOf("c1"), emptyList()))
        assertTrue(PidDedup.removable(listOf(dup), listOf("c1"), emptyList()).isEmpty())
    }

    @Test
    fun `被规则引用的重复条目不清理 —— 删了规则永远不成立`() {
        val dup = PidDedup.Duplicate(poll("c1"), poll("std_05", builtIn = true), "同请求")
        assertTrue(PidDedup.isReferenced("c1", emptyList(), listOf("c1")))
        assertTrue(PidDedup.removable(listOf(dup), emptyList(), listOf("c1")).isEmpty())
    }

    @Test
    fun `没被引用的重复条目可以清理`() {
        val dup = PidDedup.Duplicate(poll("c1"), poll("std_05", builtIn = true), "同请求")
        val ok = PidDedup.removable(listOf(dup), listOf("std_05", "std_0C"), listOf("mon_turn_left"))
        assertEquals(1, ok.size)
        assertEquals("c1", ok[0].pid.id)
    }

    @Test
    fun `汇总文案逐条带理由`() {
        val dup = PidDedup.Duplicate(
            mon("u1", "TestMonitor09A", "09A", "bitsAt(18,1,0,0)"),
            mon("mon_turn_left", "左转向灯", "09A", "bit(C,2)", builtIn = true),
            "与「左转向灯」同报文 09A 同一位段"
        )
        val s = PidDedup.summary(listOf(dup))
        assertTrue(s.contains("TestMonitor09A"))
        assertTrue(s.contains("左转向灯"))
    }

    @Test
    fun `确认框正文不许出现 Markdown 标记 —— 这一页不做渲染`() {
        // v1.20.11 刚在知识库那一页踩过：`**粗体**` 原样显示给用户（144 个）。
        // 我第一版就把它写进了这个对话框，装机 dump 里一眼看到 `指**同一个信号**`。
        val dup = PidDedup.Duplicate(
            mon("u1", "TestMonitor09A", "09A", "bitsAt(18,1,0,0)"),
            mon("mon_turn_left", "左转向灯", "09A", "bit(C,2)", builtIn = true),
            "与「左转向灯」同报文 09A 同一位段"
        )
        val msg = PidDedup.confirmMessage(listOf(dup))
        assertFalse("正文里出现了 Markdown 星号：$msg", msg.contains("**"))
        assertFalse("正文里出现了反引号：$msg", msg.contains("`"))
        // 但该有的信息一条都不能少
        assertTrue(msg.contains("TestMonitor09A"))
        assertTrue(msg.contains("左转向灯"))
        assertTrue(msg.contains("同一个信号"))
    }
}
