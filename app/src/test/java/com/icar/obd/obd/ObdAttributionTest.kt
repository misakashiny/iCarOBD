package com.icar.obd.obd

import com.icar.obd.data.BuiltInPids
import org.junit.Assert.*
import org.junit.Test

/**
 * P5A-M06 阶段 A：**OBD 响应归属安全**（正向 + 负向）。
 *
 * ## 背景：本轮实证确认的数据归属缺陷
 *
 * `ObdProtocol.matchData()` 有一条从 v1.15.0 就在的**兜底分支**：
 * 「响应模式字节对得上、但 PID 字节对不上」时，把 respMode 之后的**全部字节**当数据返回。
 *
 * 探针实测（`ObdAttributionProbeTest`）6 个用例**全部 ok=true**：
 *
 *   41 00 BE 3F 80   → 当车速   = 0.0 km/h     （位图被当数据）
 *   41 0D 1A F8      → 当转速   = 838.5 rpm
 *   41 0C 1A F8      → 当车速   = 12.0 km/h
 *   41 05 7B         → 当转速   = 350.75 rpm
 *   41 00 BE 3F A8 13→ 当水温   = -40.0 ℃
 *   41 20 00 00 00 00→ 当车速   = 32.0 km/h
 *
 * 这正是任务 §三 的验收红线：**不能让无法可靠归属的响应悄悄生成另一个 PID 的有效值**。
 *
 * ## 兼容性调查结论（为什么可以删）
 *
 * 既有测试的注释说兜底是为了「请求 01 0D 却收到 01 00 的**支持位图响应**」。
 * 但查调用方后确认：**位图有自己的正当通道** ——
 * `PidScanner` / `ElmSession` / `CanSniffer` 都是用
 * `extractData(reply, 1, "00")` 显式请求 `01 00`，走的是**精确匹配**，不依赖兜底。
 *
 * 所以兜底**没有任何正当用途**，它唯一的实际效果是把"请求 A 收到 B"变成假数据。
 * 按任务要求「不得仅因旧测试通过就继续容忍错误归属」→ 删除。
 *
 * ## 本文件钉住的行为
 *
 * 正向（必须仍然工作）：PID 对得上 → 正常解析、位图显式请求、多帧、多 ECU、Mode 22、带 Header。
 * 负向（必须拒绝）：PID 对不上 → **不产生值**（并给出明确原因，供排障）。
 */
class ObdAttributionTest {

    private fun pid(id: String) = BuiltInPids.all().first { it.id == id }
    private fun data(token: String, mode: Int, pidHex: String, ecu: Int = 0): List<Int>? =
        ObdProtocol.extractData(token, mode, pidHex, ecu)?.map { it.toInt() and 0xFF }

    // ================================================================ 正向：必须仍然工作

    @Test
    fun `A1 请求 PID 与响应 PID 正确匹配`() {
        // 转速 41 0C 1A F8 → A=0x1A B=0xF8 → 0x1AF8/4 = 1726
        val r = ObdProtocol.parse("41 0C 1A F8", pid("std_0C"))
        assertTrue(r.ok)
        assertEquals(1726f, r.value!!, 0.5f)
        assertEquals(listOf(0x1A, 0xF8), data("41 0C 1A F8", 1, "0C"))
    }

    @Test
    fun `A2 车速精确匹配`() {
        assertEquals(listOf(0x3C), data("41 0D 3C", 1, "0D"))
        val r = ObdProtocol.parse("41 0D 3C", pid("std_0D"))
        assertTrue(r.ok)
        assertEquals(60f, r.value!!, 0.1f)
    }

    @Test
    fun `A7 多帧响应仍能重组`() {
        // ISO-TP 多帧：首帧 "10 0A" = 长度 10 字节，随后 2 个连续帧（各 7 字节）
        // 载荷：41 0C 1A F8 00 00 00 00 00 00（10 字节，PID=0C）
        val raw = "10 0A 41 0C 1A F8 00 00 00\r21 00 00 00 00 00 00 00"
        val got = data(raw, 1, "0C")
        assertNotNull("多帧应能重组出数据", got)
        // 重组后前两字节必须是转速数据 A=0x1A B=0xF8
        assertEquals(listOf(0x1A, 0xF8), got!!.take(2))
    }

    @Test
    fun `A7b ELM327 已重组的单帧 VIN 响应`() {
        // 09 02 的 VIN：ELM327 自己重组好之后是一行
        val got = data("49 02 01 31 47 31 4A 43 35 34 34 34", 9, "02")
        assertEquals(listOf(0x01, 0x31, 0x47, 0x31, 0x4A, 0x43, 0x35, 0x34, 0x34, 0x34), got)
    }

    @Test
    fun `A8 多 ECU 同时响应可按序号选择`() {
        val raw = "41 0C 1A F8\r41 0C 1B 00"
        assertEquals(listOf(0x1A, 0xF8), data(raw, 1, "0C", 0))
        assertEquals(listOf(0x1B, 0x00), data(raw, 1, "0C", 1))
    }

    @Test
    fun `A9 带 CAN Header 与无 Header 都能解析`() {
        // 无 header
        assertEquals(listOf(0x1A, 0xF8), data("41 0C 1A F8", 1, "0C"))
        // 带 header（CAN 11bit 头在最前）
        val withHeader = data("7E8 41 0C 1A F8", 1, "0C")
        assertNotNull(withHeader)
        assertEquals(listOf(0x1A, 0xF8), withHeader)
    }

    @Test
    fun `A12 位图响应在显式请求 01 00 时正常工作`() {
        // 这是 PidScanner 的正当用途：请求 01 00 → 41 00 BE 3F 80
        assertEquals(listOf(0xBE, 0x3F, 0x80), data("41 00 BE 3F 80", 1, "00"))
        // 不支持位图
        assertEquals(listOf(0x00, 0x00, 0x00, 0x00), data("41 20 00 00 00 00", 1, "20"))
    }

    @Test
    fun `A12b Mode 22 四字节 PID 仍正常`() {
        assertEquals(listOf(0x3A, 0xF2), data("62 12 34 3A F2", 0x22, "1234"))
    }

    // ================================================================ 负向：必须拒绝（本轮修复）

    @Test
    fun `A2N 请求 010C 收到 41 0D 必须不产生值`() {
        val r = ObdProtocol.parse("41 0D 1A F8", pid("std_0C"))
        assertFalse("错 PID 不得生成转速值", r.ok)
        assertNull(r.value)
        assertNotNull("必须给出原因", r.error)
    }

    @Test
    fun `A3N 请求 010D 收到 41 0C 必须不产生值`() {
        val r = ObdProtocol.parse("41 0C 1A F8", pid("std_0D"))
        assertFalse("错 PID 不得生成车速值", r.ok)
        assertNull(r.value)
    }

    @Test
    fun `A3N2 位图响应不得被当车速`() {
        val r = ObdProtocol.parse("41 00 BE 3F 80", pid("std_0D"))
        assertFalse("位图不得冒充车速", r.ok)
        assertNull(r.value)
    }

    @Test
    fun `A4N 错误服务模式必须拒绝`() {
        // 请求 Mode 01，收到 Mode 02 的响应（42 = 0x01+0x41）
        val r = ObdProtocol.parse("42 0C 1A F8", pid("std_0C"))
        assertFalse("服务模式不符不得成功", r.ok)
        assertNull(r.value)
    }

    @Test
    fun `A5N 响应缺失 PID 字节必须拒绝`() {
        // 41 后面直接跟数据，没有 PID 字节
        for (raw in listOf("41 1A F8", "41 00", "41")) {
            val r = ObdProtocol.parse(raw, pid("std_0C"))
            assertFalse("raw=[$raw] 缺 PID 字节不得成功", r.ok)
        }
    }

    @Test
    fun `A6N 报文截断必须拒绝`() {
        for (raw in listOf("41 0C", "41 0C 1A", "4")) {
            val r = ObdProtocol.parse(raw, pid("std_0C"))
            assertFalse("raw=[$raw] 截断不得成功", r.ok)
            assertNull(r.value)
        }
    }

    @Test
    fun `A10N NO DATA SEARCHING 问号 必须拒绝`() {
        for (raw in listOf("NO DATA", "SEARCHING...", "?", "", "  ", "OK", "STOPPED", "UNABLE TO CONNECT", "BUS INIT: ...ERROR")) {
            val r = ObdProtocol.parse(raw, pid("std_0C"))
            assertFalse("raw=[$raw] 不得成功", r.ok)
            assertNull(r.value)
        }
    }

    @Test
    fun `A11N 延迟响应混入下一条请求 不得被当成新请求的结果`() {
        // 场景：先请求 0C（延迟未回），再请求 0D，此时 0C 的响应"追上来"
        // 通信层（ElmSession）每帧只配给当前 waiter，所以这里模拟"0D 的读取拿到 0C 的帧"
        val r = ObdProtocol.parse("41 0C 1A F8", pid("std_0D"))
        assertFalse("迟到的 0C 响应不得被当成 0D 的值", r.ok)
        assertNull(r.value)
    }

    @Test
    fun `A13 错误归属必须给出可排障的原因`() {
        val r = ObdProtocol.parse("41 0D 1A F8", pid("std_0C"))
        assertFalse(r.ok)
        // 原因里应当能看出"收到的不是这个 PID"
        val err = r.error ?: ""
        assertTrue("原因应说明 PID 不匹配，实际=[$err]", err.contains("PID") || err.contains("不匹配") || err.contains("无有效"))
    }
}
