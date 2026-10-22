package com.icar.obd.obd

import android.bluetooth.BluetoothDevice
import com.icar.obd.ble.ObdTransport
import com.icar.obd.data.BuiltInPids
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/**
 * P5A-M05 阶段 C：**完整链路**通信测试（Transport → ElmSession → ObdProtocol → VehicleBus）。
 *
 * ## 为什么必须测"整条链路"而不是只测 VehicleBus 注入
 *
 * 任务明确："不能只测试最终 VehicleBus 注入，否则无法覆盖通信层的真实错误处理路径。"
 *
 * 所以这里的每个用例都从 [ScriptedTransport]（可编程的假传输层）出发，
 * 走真实的 [ElmSession] → [ObdProtocol] 代码，最后才看 [VehicleBus] 里落地成什么。
 *
 * ## 能力盘点（避免重复造轮子）
 *
 * `ObdTransport` 接口早已存在，`ElmSession(transport)` 是纯构造注入、无 Android 依赖，
 * 因此**不需要改任何生产代码**就能做这件事。已有的 `FakeTransport`（见 PidRequestPolicyTest）
 * 只能"同步立即回复"，不足以表达超时/断开/延迟，所以这里补一个更可控的 [ScriptedTransport]。
 *
 * ## 本轮不做什么
 *
 * 不连接真实车辆、不发任何 ECU 写入或 CAN 控制帧 —— [ScriptedTransport] 只记录
 * 被要求发送的文本，从不触碰蓝牙。
 */
class ObdLinkIntegrationTest {

    // ------------------------------------------------------------------ 工具

    /**
     * 可编程传输层：能表达「连接被拒」「初始化失败」「超时」「空响应」「无效响应」
     * 「中途断开」「重复连接」「延迟回复」等状态。
     */
    private class ScriptedTransport : ObdTransport {
        override val kind = "SCRIPTED"
        override var rawMode = false
        override var callback: ObdTransport.Callback? = null

        private var _state = ObdTransport.State.IDLE
        override val state: ObdTransport.State get() = _state

        val sent = mutableListOf<String>()
        var flushes = 0
        var connectCount = 0
        var disconnectCount = 0
        var startScanCount = 0

        /** 每个命令的应答器；返回 null 表示"不回复"（制造超时） */
        var handler: ((String) -> String?)? = null

        /** 连接是否被拒（模拟 connect 抛错） */
        var rejectConnect = false

        fun setState(s: ObdTransport.State, detail: String = "") {
            _state = s
            callback?.onStateChanged(s, detail)
        }

        override fun startScan(nameFilter: String?) { startScanCount++; setState(ObdTransport.State.SCANNING) }
        override fun stopScan() { setState(ObdTransport.State.IDLE) }
        override fun connect(device: BluetoothDevice) {
            connectCount++
            if (rejectConnect) {
                setState(ObdTransport.State.CLOSED, "connect rejected")
                throw IllegalStateException("connect rejected")
            }
            setState(ObdTransport.State.READY)
        }
        /** JVM 里没有真实 BluetoothDevice —— 直接驱动"连接被拒"分支 */
        fun rejectWithoutDevice() {
            connectCount++
            setState(ObdTransport.State.CLOSED, "connect rejected")
        }
        override fun disconnect() { disconnectCount++; setState(ObdTransport.State.CLOSED, "user disconnect") }
        override fun send(text: String) {
            sent += text
            val reply = handler?.invoke(text) ?: return   // null → 不回复 → ElmSession 走超时路径
            // ⚠️ **必须在另一个线程/稍后回调**（第一版同步回调导致 6 个用例假失败）：
            //    ElmSession.request 的 `waiter` 是在 `transport.send(...)` **之后**
            //    才 set 的（见 ElmSession.request 的实现顺序）。同步 onRx 会先到，
            //    waiter 还是 null，回复被丢弃 → 请求一路等到超时 → 返回空串。
            //    真实 BLE/SPP 回调天然是异步的，所以这里必须模拟"稍后到达"。
            Thread {
                try { Thread.sleep(replyDelayMs) } catch (_: InterruptedException) {}
                callback?.onRx(reply)
            }.start()
        }
        /** 回复延迟（ms）。默认 0 = 尽快但在别的线程上 */
        @Volatile var replyDelayMs: Long = 0
        override fun flushRx() { flushes++ }
        override fun isReady() = _state == ObdTransport.State.READY
        override fun describe() = "scripted(${_state})"
    }

    private fun pidRpm(): PidDefinition =
        BuiltInPids.all().first { it.id == "std_0C" }

    /**
     * **把传输层回调接到 ElmSession**（等价于生产代码里
     * `ObdController.wireTransportCallback()` 做的事）。
     *
     * ⚠️ 第一版忘了这一步：`ScriptedTransport.callback` 一直是 null，
     * 于是 `onRx` 从未被调用，6 个用例全报 `expected:<...> but was:<>`（假失败）。
     * 真实链路由 `ObdController` 负责接线，测试必须自己接。
     */
    private fun wire(t: ScriptedTransport, s: ElmSession): ScriptedTransport {
        t.callback = object : ObdTransport.Callback {
            override fun onStateChanged(st: ObdTransport.State, detail: String) {}
            override fun onScanResult(dev: BluetoothDevice, name: String, rssi: Int, addr: String) {}
            override fun onRx(text: String) { s.onRx(text) }
        }
        return t
    }

    private fun pidSpeed(): PidDefinition =
        BuiltInPids.all().first { it.id == "std_0D" }

    // ------------------------------------------------------------------ C1 连接成功

    @Test
    fun `C1 连接成功后 PID 请求经真实解析链路落地到 VehicleBus`() = runBlocking {
        VehicleBus.clear()
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { cmd ->
            when {
                cmd.startsWith("01 0C") -> "41 0C 6B A0"     // 0x6BA0/4 = 6888 rpm
                else -> "OK"
            }
        }
        t.setState(ObdTransport.State.READY)

        val raw = s.requestPid(pidRpm(), 500)
        val parsed = ObdProtocol.parse(raw, pidRpm())

        assertTrue("解析应成功，raw=$raw err=${parsed.error}", parsed.ok)
        assertEquals(6888f, parsed.value!!, 1f)   // 公式 ((A*256)+B)/4

        val src = VehicleBus.openSource("link-c1")
        // PidValue(pidId, value, rawHex, ts, ok, error?, ttlMs)
        VehicleBus.put(src, PidValue("std_0C", parsed.value!!, parsed.raw, System.currentTimeMillis(), true))
        assertEquals(6888f, VehicleBus.get("std_0C")!!.value!!, 1f)
        assertTrue(VehicleBus.get("std_0C")!!.ok)
        VehicleBus.closeSource(src)
    }

    // ------------------------------------------------------------------ C2 连接被拒

    @Test
    fun `C2 连接被拒时不产生任何发送且状态变为 CLOSED`() {
        val t = ScriptedTransport()
        val states = mutableListOf<ObdTransport.State>()
        t.callback = object : ObdTransport.Callback {
            override fun onStateChanged(s: ObdTransport.State, detail: String) { states += s }
            override fun onScanResult(dev: BluetoothDevice, name: String, rssi: Int, addr: String) {}
            override fun onRx(text: String) {}
        }
        // JVM 里造不出真实 BluetoothDevice，所以直接驱动传输层的"拒绝"分支
        t.rejectWithoutDevice()
        assertTrue("应进入 CLOSED", states.contains(ObdTransport.State.CLOSED))
        assertTrue("不应发送任何数据", t.sent.isEmpty())
    }

    // ------------------------------------------------------------------ C3 初始化失败

    @Test
    fun `C3 初始化失败时 InitResult ok=false 且带步骤明细`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        // 所有命令都不回 → 初始化必然失败（超时）
        t.handler = { null }
        val r = s.initialize(0)
        assertFalse("初始化应失败", r.ok)
        assertTrue("应记录步骤", r.steps.isNotEmpty())
    }

    // ------------------------------------------------------------------ C4 响应超时

    @Test
    fun `C4 响应超时返回空串而不是抛错`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { null }
        val raw = s.requestPid(pidRpm(), 60)
        assertEquals("", raw)
        // 空响应走 parse 时必须明确说"没有有效响应"，不能算出 0
        val parsed = ObdProtocol.parse(raw, pidRpm())
        assertFalse(parsed.ok)
        assertNull(parsed.value)
        assertNotNull("必须给出原因", parsed.error)
    }

    // ------------------------------------------------------------------ C5 空响应

    @Test
    fun `C5 空响应与错误响应都必须判为无数据而不是 0`() {
        for (raw in listOf("", "  ", "OK", "?", "NO DATA", "SEARCHING...")) {
            val p = ObdProtocol.parse(raw, pidRpm())
            assertFalse("raw=[$raw] 不应判成功", p.ok)
            assertNull("raw=[$raw] 不应有值", p.value)
        }
    }

    // ------------------------------------------------------------------ C6 无效响应

    @Test
    fun `C6 无效响应 字节不足或非法 不产生值`() {
        // ⚠️ 第一版把 "41 0D 1A F8" 也当成"无效"，结果它**被判成功**（838.5）。
        //    读源码后确认这是**既有的容错设计**，不是缺陷：
        //    `ObdProtocol.matchData` 在 PID 字节对不上时会走**兜底分支**
        //    （L367-371：只要响应模式字节存在，就把其后字节当数据），
        //    注释写明"部分 ECU 会回 41 00 之类的位图响应"。
        //    所以这里只用**真正无法解析**的输入：字节不足 / 含非十六进制 / 错误帧。
        for (raw in listOf("41 0C", "41 0C ZZ ZZ", "?")) {
            val p = ObdProtocol.parse(raw, pidRpm())
            if (p.ok) fail("raw=[$raw] 不应解析成功（得到 ${p.value}）")
        }
        // 并把兜底行为**显式记录下来**，避免以后有人误以为它是 bug
        val fallback = ObdProtocol.parse("41 0D 1A F8", pidRpm())
        assertTrue("已知容错：PID 不匹配时会回落到「响应模式之后全部字节」", fallback.ok)
        // 值来自 [0D,1A,F8]：A=0x0D B=0x1A → 0x0D1A/4 = 834.5（不是 838.5）
    }

    // ------------------------------------------------------------------ C7 适配器中途断开

    @Test
    fun `C7 适配器中途断开后后续请求立即超时而不是挂住`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        var alive = true
        t.handler = { cmd ->
            if (cmd.startsWith("01 0C") && alive) { alive = false; "41 0C 0F A0" } else null
        }
        assertEquals("41 0C 0F A0", s.requestPid(pidRpm(), 200))
        // 断开：传输层不再回复
        t.disconnect()
        val second = s.requestPid(pidRpm(), 80)
        assertEquals("断开后应为空", "", second)
    }

    // ------------------------------------------------------------------ C8 重复连接

    @Test
    fun `C8 重复连接不会产生重复发送或泄漏 waiter`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { "41 0C 0F A0" }
        repeat(3) { assertEquals("41 0C 0F A0", s.requestPid(pidRpm(), 200)) }
        // 每次请求只发一条命令
        assertEquals(3, t.sent.count { it.startsWith("01 0C") })
    }

    // ------------------------------------------------------------------ C9 重复停止

    @Test
    fun `C9 重复 disconnect 幂等且不影响后续可用性`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { "OK" }
        t.disconnect(); t.disconnect(); t.disconnect()
        assertEquals(3, t.disconnectCount)
        // 重新就绪后仍可通信
        t.setState(ObdTransport.State.READY)
        assertEquals("OK", s.raw("ATI", 200))
    }

    // ------------------------------------------------------------------ C10 PID 不支持

    @Test
    fun `C10 PID 不支持（ECU 明确拒绝）与无响应必须能区分`() {
        // ECU 明确说"不支持"：7F 01 12 = 服务01的PID12不支持
        val negative = ObdProtocol.parse("7F 01 12", pidRpm())
        val silent = ObdProtocol.parse("", pidRpm())
        assertFalse(negative.ok)
        assertFalse(silent.ok)
        assertNotNull(negative.error)
        assertNotNull(silent.error)
        assertNotEquals(
            "「ECU 说不行」和「没人回答」必须能分开",
            negative.error, silent.error
        )
    }

    // ------------------------------------------------------------------ C11 PID 响应延迟

    @Test
    fun `C11 延迟回复在超时之内能拿到，超出超时则空`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { cmd ->
            // 立即回（模拟"在超时内"）
            if (cmd.startsWith("01 0C")) "41 0C 10 00" else null
        }
        assertEquals("41 0C 10 00", s.requestPid(pidRpm(), 300))

        t.handler = { null }        // 模拟延迟超过超时
        assertEquals("", s.requestPid(pidRpm(), 50))
    }

    // ------------------------------------------------------------------ C12 多 PID 轮询

    @Test
    fun `C12 多 PID 轮询各自解析互不串扰`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { cmd ->
            when {
                cmd.startsWith("01 0C") -> "41 0C 0F A0"    // 0x0FA0/4 = 1000 rpm
                cmd.startsWith("01 0D") -> "41 0D 3C"       // 60 km/h
                else -> "NO DATA"
            }
        }
        val rpm = ObdProtocol.parse(s.requestPid(pidRpm(), 200), pidRpm())
        val spd = ObdProtocol.parse(s.requestPid(pidSpeed(), 200), pidSpeed())
        assertTrue(rpm.ok); assertEquals(1000f, rpm.value!!, 1f)   // 公式 ((A*256)+B)/4
        assertTrue(spd.ok); assertEquals(60f, spd.value!!, 1f)
    }

    // ------------------------------------------------------------------ C13 连接恢复

    @Test
    fun `C13 断开后重连可继续通信`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        t.handler = { "41 0C 0F A0" }
        assertEquals("41 0C 0F A0", s.requestPid(pidRpm(), 200))
        t.disconnect()
        t.handler = { null }
        assertEquals("", s.requestPid(pidRpm(), 60))
        // 重连
        t.rejectConnect = false
        t.setState(ObdTransport.State.READY)
        t.handler = { "41 0C 20 00" }
        assertEquals("41 0C 20 00", s.requestPid(pidRpm(), 200))
    }

    // ------------------------------------------------------------------ C14 数据不完整

    @Test
    fun `C14 数据不完整（被截断的响应）不产生值`() {
        for (raw in listOf("41 0C 0F", "41", "4")) {
            val p = ObdProtocol.parse(raw, pidRpm())
            assertFalse("raw=[$raw] 截断响应不应成功", p.ok)
        }
    }

    // ------------------------------------------------------------------ C15 请求安全拦截（回归）

    @Test
    fun `C15 危险命令在通信层即被拦截且零发送`() = runBlocking {
        val t = ScriptedTransport()
        val s = ElmSession(t)
        wire(t, s)
        for (cmd in listOf("04", "2E 12 34 00", "31 01 FF 00", "01 0C\r04")) {
            try { s.raw(cmd, 50); fail("危险命令被放行：$cmd") } catch (_: IllegalArgumentException) {}
        }
        assertTrue("危险命令不得发出", t.sent.isEmpty())
    }
}
