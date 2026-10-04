package com.icar.obd.obd

import com.icar.obd.data.PidDefinition
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `ObdProtocol` 的单元测试（迭代清单 P2-1）。
 *
 * 验收要求：**覆盖 `extractData` 的各种响应格式（含多帧、含 `NO DATA`、含错误码）**。
 *
 * 这些用例是纯函数测试，不依赖真车、不依赖 Android —— 正好补上
 * 「数据链路从未在车上跑通」时唯一能先做的事。
 */
class ObdProtocolTest {

    private fun pid(
        mode: String = "01",
        pid: String = "0C",
        formula: String = "((A*256)+B)/4"
    ) = PidDefinition(mode = mode, pid = pid, formula = formula)

    /** 提取数据字节并转成无符号 int 列表，便于断言 */
    private fun dataOf(raw: String, mode: Int = 1, pidHex: String = "0C"): List<Int>? =
        ObdProtocol.extractData(raw, mode, pidHex)?.map { it.toInt() and 0xFF }

    // ---------------------------------------------------------------- 基本响应

    @Test
    fun `标准响应 ATH0`() {
        assertEquals(listOf(0x1A, 0xF8), dataOf("41 0C 1A F8"))
    }

    @Test
    fun `带 CAN 头的响应 ATH1 也能解析`() {
        assertEquals(listOf(0x1A, 0xF8), dataOf("0C 41 0C 1A F8"))
    }

    @Test
    fun `SEARCHING 噪声被剔除且不会污染字节`() {
        // 若不先剔除 SEARCHING，"SE" 会被 hexBytes 当成一个 hex 字节解析出 0xEA
        assertEquals(listOf(0x1A, 0xF8), dataOf("SEARCHING...\r41 0C 1A F8"))
    }

    @Test
    fun `冒号与换行分隔也能解析`() {
        assertEquals(listOf(0x1A, 0xF8), dataOf("41:0C:1A:F8"))
        assertEquals(listOf(0x1A, 0xF8), dataOf("41 0C\r\n1A F8"))
    }

    @Test
    fun `响应模式与 PID 都对但后面没有数据字节时返回空数组`() {
        assertArrayEquals(ByteArray(0), ObdProtocol.extractData("41 0C", 1, "0C"))
    }

    @Test
    fun `响应里完全没有响应模式时返回 null`() {
        // 7F 01 12 是 OBD 否定响应
        assertNull(ObdProtocol.extractData("7F 01 12", 1, "0C"))
    }

    // ------------------------------------------------------- 错误码与 NO DATA

    @Test
    fun `NO DATA 返回 null`() {
        assertNull(ObdProtocol.extractData("NO DATA", 1, "0C"))
    }

    @Test
    fun `各种 ELM327 错误关键字都返回 null`() {
        listOf(
            "?", "ERROR", "UNABLE TO CONNECT", "BUS ERROR", "CAN ERROR",
            "NO RESPONSE", "BUFFER FULL", "STOPPED", "<DATA ERROR",
            "FB ERROR", "LV RESET", "BUS BUSY", "ACT ALERT", "RX ERROR", "DATA ERROR"
        ).forEach { assertNull("应判为错误: $it", ObdProtocol.extractData(it, 1, "0C")) }
    }

    @Test
    fun `空白响应返回 null`() {
        assertNull(ObdProtocol.extractData("", 1, "0C"))
        assertNull(ObdProtocol.extractData("   ", 1, "0C"))
    }

    @Test
    fun `isError 判定大小写不敏感`() {
        assertTrue(ObdProtocol.isError("NO DATA"))
        assertTrue(ObdProtocol.isError("no data"))
        assertTrue(ObdProtocol.isError("?"))
        assertTrue(ObdProtocol.isError(""))
        assertFalse(ObdProtocol.isError("41 0C 1A F8"))
    }

    // ---------------------------------------------------------------- 多帧

    @Test
    fun `ELM327 已重组的单帧 VIN 响应`() {
        // Mode 09 PID 02 = VIN
        assertEquals(
            listOf(0x01, 0x31, 0x47, 0x31, 0x4A, 0x43, 0x35, 0x34, 0x34, 0x34),
            dataOf("49 02 01 31 47 31 4A 43 35 34 34 34", mode = 9, pidHex = "02")
        )
    }

    @Test
    fun `带帧序号前缀的响应不走 ISO-TP 重组`() {
        // ELM327 的 "0:/1:" 是【帧序号前缀】格式，不是 ISO-TP PCI，两者别混
        val raw = "0: 49 02 01 31 47 31\r1: 4A 43 35 34 34 34"
        assertEquals(
            listOf(0x01, 0x31, 0x47, 0x31, 0x4A, 0x43, 0x35, 0x34, 0x34, 0x34),
            dataOf(raw, mode = 9, pidHex = "02")
        )
    }

    // ------------------------------------------------- ISO-TP 多帧重组（v1.5.0）

    /** Mode 09 PID 02（VIN）的多帧响应：首帧声明总长 0x14 = 20 字节 */
    private val vinFrames = listOf(
        "10 14 49 02 01 31 47 31",
        "21 4A 43 35 34 34 34 52",
        "22 37 32 35 32 33 36 36"
    )

    /** 重组后剥掉 "49 02" 剩下的数据（首字节 0x01 是「数据项个数」） */
    private val vinData = listOf(
        0x01, 0x31, 0x47, 0x31, 0x4A, 0x43, 0x35, 0x34, 0x34, 0x34,
        0x52, 0x37, 0x32, 0x35, 0x32, 0x33, 0x36, 0x36
    )

    @Test
    fun `ISO-TP 多帧重组 ATH0 带空格`() {
        assertEquals(vinData, dataOf(vinFrames.joinToString("\r"), mode = 9, pidHex = "02"))
    }

    @Test
    fun `ISO-TP 多帧重组 ATS0 无空格`() {
        val raw = vinFrames.joinToString("\r") { it.replace(" ", "") }
        assertEquals(vinData, dataOf(raw, mode = 9, pidHex = "02"))
    }

    @Test
    fun `ISO-TP 多帧重组 带 29 位 CAN 头`() {
        val raw = vinFrames.joinToString("\r") { "18DAF110 $it" }
        assertEquals(vinData, dataOf(raw, mode = 9, pidHex = "02"))
    }

    @Test
    fun `ISO-TP 序号不连续时不重组出完整载荷`() {
        // 第二帧序号应为 21，这里故意给 23
        val raw = listOf(vinFrames[0], "23 4A 43 35 34 34 34 52", vinFrames[2]).joinToString("\r")
        assertNotEquals("序号断了就不该重组出完整 VIN", vinData, dataOf(raw, mode = 9, pidHex = "02"))
    }

    @Test
    fun `SEARCHING 噪声行不会被误当成多帧`() {
        // 若把噪声行也当帧解析，"SE" 会被 hexBytes 解成 0xEA，可能凑出假的首帧
        assertEquals(listOf(0x1A, 0xF8), dataOf("SEARCHING...\r41 0C 1A F8", mode = 1, pidHex = "0C"))
    }

    @Test
    fun `reassembleIsoTp 对单帧返回 null`() {
        assertNull(ObdProtocol.reassembleIsoTp(listOf(listOf(0x41, 0x0C, 0x1A, 0xF8))))
    }

    @Test
    fun `reassembleIsoTp 对缺续帧返回 null`() {
        assertNull(ObdProtocol.reassembleIsoTp(listOf(listOf(0x10, 0x14, 0x49, 0x02, 0x01))))
    }

    @Test
    fun `reassembleIsoTp 空列表返回 null`() {
        assertNull(ObdProtocol.reassembleIsoTp(emptyList()))
    }

    // ------------------------------------------------- 多 ECU 响应选择（v1.5.0）

    private fun pick(raw: String, ecu: Int): List<Int>? =
        ObdProtocol.extractData(raw, 1, "0C", ecu)?.map { it.toInt() and 0xFF }

    @Test
    fun `多 ECU 响应可以按序号选择`() {
        // 同一 PID 两个模块回复：发动机 1A F8，另一个 1B 00
        val raw = "41 0C 1A F8\r41 0C 1B 00"
        assertEquals(listOf(0x1A, 0xF8), pick(raw, 0))
        assertEquals(listOf(0x1B, 0x00), pick(raw, 1))
    }

    @Test
    fun `要第 N 个但不够 N 个时返回 null 而不是退回第一个`() {
        // 退回第一个等于把别的模块的值当答案 —— 比「没数据」危险得多
        assertNull(pick("41 0C 1A F8", 3))
    }

    @Test
    fun `负数 ecuIndex 视为第一个`() {
        val raw = "41 0C 1A F8\r41 0C 1B 00"
        assertEquals(listOf(0x1A, 0xF8), pick(raw, -5))
    }

    @Test
    fun `ecuIndex 不影响单 ECU 的正常解析`() {
        assertEquals(listOf(0x1A, 0xF8), pick("41 0C 1A F8", 0))
    }

    // ---------------------------------------------------------------- 兜底分支

    @Test
    fun `响应模式匹配但 PID 对不上时走兜底分支`() {
        // 例：请求 01 0D（车速）却收到 01 00 的支持位图响应
        assertEquals(
            listOf(0x00, 0xBE, 0x3F, 0x80),
            dataOf("41 00 BE 3F 80", mode = 1, pidHex = "0D")
        )
    }

    @Test
    fun `Mode 22 四字节 PID 也能匹配`() {
        // 请求 22 12 34 → 响应 62 12 34 3A F2
        assertEquals(listOf(0x3A, 0xF2), dataOf("62 12 34 3A F2", mode = 0x22, pidHex = "1234"))
    }

    // ---------------------------------------------------------------- 完整解析

    @Test
    fun `parse 转速`() {
        val r = ObdProtocol.parse("41 0C 1A F8", pid(pid = "0C", formula = "((A*256)+B)/4"))
        assertTrue(r.ok)
        assertEquals(1726f, r.value!!, 1e-3f)
        assertNull(r.error)
        assertArrayEquals(byteArrayOf(0x1A, 0xF8.toByte()), r.data)
    }

    @Test
    fun `parse 车速`() {
        val r = ObdProtocol.parse("41 0D 3C", pid(pid = "0D", formula = "A"))
        assertTrue(r.ok)
        assertEquals(60f, r.value!!, 1e-3f)
    }

    @Test
    fun `parse 冷却液温度`() {
        val r = ObdProtocol.parse("41 05 7B", pid(pid = "05", formula = "A-40"))
        assertTrue(r.ok)
        assertEquals(83f, r.value!!, 1e-3f)
    }

    @Test
    fun `parse NO DATA 时 ok 为 false 并给出原因`() {
        val r = ObdProtocol.parse("NO DATA", pid())
        assertFalse(r.ok)
        assertNull(r.value)
        assertEquals("无有效响应", r.error)
    }

    @Test
    fun `parse 响应无数据字节`() {
        val r = ObdProtocol.parse("41 0C", pid())
        assertFalse(r.ok)
        assertEquals("响应无数据字节", r.error)
    }

    @Test
    fun `parse 公式错误时 ok 为 false 并回传公式错误文案`() {
        val r = ObdProtocol.parse("41 0C 1A F8", pid(formula = "1/0"))
        assertFalse(r.ok)
        assertNull(r.value)
        assertTrue(r.error!!, r.error!!.startsWith("公式错误"))
    }

    @Test
    fun `parse 公式取不到数据字节时报公式错误而不是崩溃`() {
        val r = ObdProtocol.parse("41 0C 1A", pid(formula = "A+B"))
        assertFalse(r.ok)
        assertTrue(r.error!!, r.error!!.startsWith("公式错误"))
    }

    // ---------------------------------------------------------------- 请求构造

    @Test
    fun `请求串构造`() {
        assertEquals("01 0C", pid(pid = "0C").requestString())
        assertEquals("22 1234", pid(mode = "22", pid = "1234").requestString())
        assertEquals("01 0C\r", ObdProtocol.buildRequest(pid(pid = "0C")))
    }

    @Test
    fun `modeInt 按十六进制解析且非法值回落 01`() {
        assertEquals(0x22, pid(mode = "22").modeInt())
        assertEquals(0x09, pid(mode = "09").modeInt())
        assertEquals(0x01, pid(mode = "zz").modeInt())
    }

    // ---------------------------------------------------------------- 初始化序列

    @Test
    fun `初始化序列以 CR 结尾并包含协议选择`() {
        val seq = ObdProtocol.initSequence(6)
        assertTrue(seq.all { it.endsWith("\r") })
        assertEquals("ATZ\r", seq.first())
        assertTrue(seq.contains("ATSP6\r"))
        assertEquals("ATCAF0\r", seq.last())
    }

    @Test
    fun `协议 0 表示自动协商`() {
        assertTrue(ObdProtocol.initSequence(0).contains("ATSP0\r"))
    }

    // ---------------------------------------------------- 扫描器安全闸门（红线 4.1.4）

    @Test
    fun `危险模式全部被拦截`() {
        listOf("02", "03", "04", "05", "06", "07", "08", "10", "11", "12", "13", "14").forEach {
            assertTrue("应拦截 mode $it", ObdProtocol.isDangerous(it))
        }
    }

    @Test
    fun `安全模式放行`() {
        listOf("01", "09", "21", "22").forEach {
            assertFalse("不应拦截 mode $it", ObdProtocol.isDangerous(it))
        }
    }

    @Test
    fun `危险模式判定兼容前导零与空白`() {
        assertTrue(ObdProtocol.isDangerous("4"))
        assertTrue(ObdProtocol.isDangerous("04"))
        assertTrue(ObdProtocol.isDangerous(" 04 "))
        assertFalse(ObdProtocol.isDangerous("1"))
        assertFalse(ObdProtocol.isDangerous("01"))
    }

    @Test
    fun `清故障码 mode 04 必须被拦下`() {
        // 红线 4.1.4：Mode 04 会清除故障码，误触可能丢失历史故障信息
        assertTrue(ObdProtocol.isDangerous("04"))
    }

    @Test
    fun `scanCandidates 宽度按模式决定`() {
        assertEquals(listOf("00", "01", "02", "03"), ObdProtocol.scanCandidates("01", 0, 3))
        assertEquals(
            listOf("1100", "1101", "1102"),
            ObdProtocol.scanCandidates("22", 0x1100, 0x1102)
        )
        assertEquals(listOf("0000"), ObdProtocol.scanCandidates("21", 0, 0))
    }
}
