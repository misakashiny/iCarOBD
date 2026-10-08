package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「这一帧解出来是什么」的单测（v1.20.8，S4）。
 *
 * ## 为什么每条"不可信"都要有用例
 *
 * S4 的全部价值在于**看得懂**，而它最容易变成的反面是**看起来像真的**：
 * 帧长不够时公式抛异常、`raw=FF` 解出 215℃、候选信号被当成已确认的显示在仪表上。
 * 三种情况的正确行为都是"**说不可信**"，而不是"给一个数字" ——
 * 所以每一条都要钉住：`value == null`、`ok == false`、`reason` 说得出原因。
 *
 * 判定复用运行时的 `dlcTooShort` / `hitsInvalidRaw`（同一对函数），
 * 于是不存在"探测页说够、运行时不收"这种互相打脸的现象。
 */
class SignalDecodeTest {

    /** 实车 09A 关灯帧：`00 00 00 00 88 00 03 00`（见 `stage/oncar-evidence/turn-signal-09A.md`） */
    private val offFrame = byteArrayOf(0, 0, 0, 0, 0x88.toByte(), 0, 3, 0)

    /** 实车 09A 左转帧：第 3 字节 = 04（bit2 置位） */
    private val leftFrame = byteArrayOf(0, 0, 0x04, 0, 0x88.toByte(), 0, 3, 0)

    /** 实车 09A 右转帧：第 3 字节 = 08（bit3 置位） */
    private val rightFrame = byteArrayOf(0, 0, 0x08, 0, 0x88.toByte(), 0, 3, 0)

    private fun monitorPid(
        name: String,
        formula: String,
        header: String = "09A",
        unit: String = "",
        enabled: Boolean = true,
        invalidRaw: Int? = null,
        minDlc: Int = 0
    ) = PidDefinition(
        id = "mon_$name", name = name, mode = "MON", pid = header, header = header,
        source = "monitor", formula = formula, unit = unit, minVal = 0f, maxVal = 1f,
        enabled = enabled, invalidRaw = invalidRaw, minDlc = minDlc
    )

    // ================================================================ 正常解码

    @Test
    fun `转向灯 —— 实车三帧解出 关 左 右`() {
        val left = monitorPid("左转向灯", "bit(C,2)")
        val right = monitorPid("右转向灯", "bit(C,3)")
        assertEquals(0.0, SignalDecode.decode(offFrame, left).value!!, 1e-9)
        assertEquals(0.0, SignalDecode.decode(offFrame, right).value!!, 1e-9)
        assertEquals(1.0, SignalDecode.decode(leftFrame, left).value!!, 1e-9)
        assertEquals(0.0, SignalDecode.decode(leftFrame, right).value!!, 1e-9)
        assertEquals(0.0, SignalDecode.decode(rightFrame, left).value!!, 1e-9)
        assertEquals(1.0, SignalDecode.decode(rightFrame, right).value!!, 1e-9)
    }

    @Test
    fun `信号表生成的 bitsAt 形态也能解`() {
        val p = monitorPid("左转向灯", "bitsAt(18,1,0,0)")
        assertEquals(1.0, SignalDecode.decode(leftFrame, p).value!!, 1e-9)
        assertEquals(0.0, SignalDecode.decode(offFrame, p).value!!, 1e-9)
        assertTrue(SignalDecode.decode(leftFrame, p).ok)
    }

    @Test
    fun `text 的格式 —— 值加单位 候选单独标出`() {
        val confirmed = monitorPid("油温", "bitsAt(0,8,0,0) - 40", unit = "℃")
        val warm = byteArrayOf(128.toByte())
        assertEquals("油温 88℃", SignalDecode.decode(warm, confirmed).text())

        val candidate = monitorPid("油温", "bitsAt(0,8,0,0) - 40", unit = "℃", enabled = false)
        assertEquals("油温 88℃（候选）", SignalDecode.decode(warm, candidate).text())
    }

    @Test
    fun `单位为空时不留下多余空格`() {
        val p = monitorPid("左转向灯", "bit(C,2)")
        assertEquals("左转向灯 1", SignalDecode.decode(leftFrame, p).text())
    }

    // ================================================================ 不可信

    @Test
    fun `DLC 不足 —— 不给值 说得出原因`() {
        // 帧只有 2 字节，而这条信号在第 3 字节上（实车同 ID 会有 4/8 字节两种帧）
        val p = monitorPid("左转向灯", "bitsAt(18,1,0,0)", minDlc = 8)
        val short = byteArrayOf(0, 0)
        val d = SignalDecode.decode(short, p)
        assertFalse(d.ok)
        assertNull("DLC 不足就**不给值** —— 编一个出来才是真的骗人", d.value)
        assertTrue("原因要看得见：${d.reason}", d.reason.contains("DLC 不足"))
        assertTrue(d.reason.contains("需要=8"))
        assertTrue(d.reason.contains("实际=2"))
        assertEquals("左转向灯 --（DLC 不足 需要=8 实际=2）", d.text())
    }

    @Test
    fun `命中无效原始值 —— 不给值 而不是解出一个像真的数字`() {
        // 水温 `bitsAt(0,8,0,0) - 40` 收到 FF → 物理值 215℃（看起来像真的！）
        val p = monitorPid("水温", "bitsAt(0,8,0,0) - 40", invalidRaw = 255)
        val d = SignalDecode.decode(byteArrayOf(0xFF.toByte()), p)
        assertFalse(d.ok)
        assertNull(d.value)
        assertTrue(d.reason.contains("无效原始值 255"))
        // 对照：不配 invalidRaw 时它就是 215（正是"被骗"的样子）
        val naive = monitorPid("水温", "bitsAt(0,8,0,0) - 40")
        assertEquals(215.0, SignalDecode.decode(byteArrayOf(0xFF.toByte()), naive).value!!, 1e-9)
    }

    @Test
    fun `无效原始值比的是位段本身 不是物理值`() {
        // 原始值 128、物理值 88：bitsAt 形态下 invalidRaw=128 应当命中
        // （拿物理值 88 去比就**永远不命中** —— 那正是 rawBits 存在的理由）
        val hit = monitorPid("水温", "bitsAt(0,8,0,0) - 40", invalidRaw = 128)
        assertFalse(SignalDecode.decode(byteArrayOf(128.toByte()), hit).ok)
        assertNull(SignalDecode.decode(byteArrayOf(128.toByte()), hit).value)

        // 手写公式（非 bitsAt 形态）回落到"拿求值结果比" —— **宁可漏判也不误判**。
        // 于是：填 88（物理值）命中，填 128（原始值）不命中。
        // 这一对断言把"回落语义"钉死，免得将来有人以为它对所有公式都按原始值比。
        val manualHit = monitorPid("水温", "A-40", invalidRaw = 88)
        assertFalse(SignalDecode.decode(byteArrayOf(128.toByte()), manualHit).ok)
        val manualMiss = monitorPid("水温", "A-40", invalidRaw = 128)
        assertTrue(SignalDecode.decode(byteArrayOf(128.toByte()), manualMiss).ok)
    }

    @Test
    fun `公式解到帧外 —— 不给值 也不抛`() {
        val p = monitorPid("左转向灯", "bitsAt(16,8,0,0)")
        val d = SignalDecode.decode(byteArrayOf(1, 2), p)
        assertFalse(d.ok)
        assertNull(d.value)
        assertTrue("要能看出是解不出：${d.reason}", d.reason.contains("解不出"))
    }

    @Test
    fun `候选 + 不可信 两种标记都要在`() {
        val p = monitorPid("油温", "bitsAt(16,8,0,0)", enabled = false)
        val d = SignalDecode.decode(byteArrayOf(1, 2), p)
        assertTrue(d.candidate)
        assertFalse(d.ok)
        assertTrue(d.text().contains("候选"))
        assertTrue(d.text().contains("解不出"))
    }

    // ================================================================ 索引

    @Test
    fun `按 CAN ID 建索引 —— 只收监听型 候选也要进来`() {
        val pids = listOf(
            monitorPid("左转向灯", "bit(C,2)", header = "09A"),
            monitorPid("右转向灯", "bit(C,3)", header = "09A", enabled = false),
            // 主动请求型：header 是模块头，不是 CAN ID —— 绝不能进索引
            PidDefinition(id = "p1", name = "油温", source = "poll", mode = "22", pid = "1234", header = "7E0"),
            // 监听型但 header 非法：跳过，而不是抛
            PidDefinition(id = "bad", name = "坏的", source = "monitor", header = "ZZZ", formula = "A"),
            // 监听型但没公式：跳过
            PidDefinition(id = "nof", name = "没公式", source = "monitor", header = "2C7", formula = " ")
        )
        val idx = SignalDecode.indexByHeader(pids)
        assertEquals(setOf(0x09A), idx.keys)
        assertEquals(2, idx[0x09A]!!.size)
        assertTrue("候选（enabled=false）必须能被看到，否则界面上就只剩 hex 了", idx[0x09A]!!.any { !it.enabled })
    }

    @Test
    fun `header 为空时退到 pid —— 存量配置里有只填了 pid 的`() {
        val p = PidDefinition(
            id = "x", name = "只填了 pid", source = "monitor", header = "",
            pid = "09A", formula = "bit(C,2)"
        )
        assertEquals(setOf(0x09A), SignalDecode.indexByHeader(listOf(p)).keys)
    }

    @Test
    fun `decodeAll 保留全部结论 包括候选与解不出的`() {
        val pids = listOf(
            monitorPid("左转向灯", "bit(C,2)"),
            monitorPid("坏公式", "bitsAt(64,8,0,0)")
        )
        val out = SignalDecode.decodeAll(leftFrame, pids)
        assertEquals(2, out.size)
        assertTrue(out[0].ok)
        assertFalse(out[1].ok)
    }

    // ================================================================ 小工具

    @Test
    fun `十六进制串还原成字节`() {
        assertEquals(8, SignalDecode.parseHexData("00 00 04 00 88 00 03 00").size)
        assertEquals(4, SignalDecode.parseHexData("00 00 04 00")[2].toInt())
        // 非法 token 跳过（总线上会夹杂 SEARCHING... 这类噪声）
        assertEquals(2, SignalDecode.parseHexData("00 ZZ 04").size)
        assertEquals(0, SignalDecode.parseHexData("").size)
    }

    @Test
    fun `读数格式 —— 整数不带小数点 小数最多 3 位且去尾零`() {
        assertEquals("88", SignalDecode.fmtValue(88.0))
        assertEquals("0", SignalDecode.fmtValue(0.0))
        assertEquals("-40", SignalDecode.fmtValue(-40.0))
        assertEquals("88.5", SignalDecode.fmtValue(88.5))
        assertEquals("0.25", SignalDecode.fmtValue(0.25))
        assertEquals("0.333", SignalDecode.fmtValue(1.0 / 3.0))
        assertEquals("?", SignalDecode.fmtValue(Double.NaN))
    }
}
