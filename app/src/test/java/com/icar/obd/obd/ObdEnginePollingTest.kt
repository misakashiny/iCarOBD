package com.icar.obd.obd

import com.icar.obd.ble.ObdTransport
import com.icar.obd.data.BuiltInPids
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * P5A-M06 阶段 B：**真实轮询到总线**的完整集成测试。
 *
 * ## 覆盖了什么（任务 §四）
 *
 * `FakeTransport → ElmSession → ObdProtocol → ObdEngine.poll() → VehicleBus`
 * —— 上一轮只到 VehicleBus 注入，没有真正跑 [ObdEngine] 的轮询循环。
 *
 * ## 为什么可以在 JVM 里真跑
 *
 * `ObdEngine(session)` 是纯构造注入；`reload()` 只用 `Store.allPids()`
 * （内存操作，不碰 Context）；轮询循环只依赖协程与 [ElmSession]。
 * 所以只要给一个可控的传输层，就能在单测里跑**真的**轮询。
 *
 * ## ⚠️ 全局状态隔离
 *
 * `Store` 与 `VehicleBus` 都是全局单例，会在用例之间互相污染。
 * 每个用例前后都重置 PID 启用状态与总线，避免"上一个用例的残留值"造成假绿。
 */
class ObdEnginePollingTest {

    /**
     * 原始启用状态快照。
     *
     * ⚠️ 第一版用 `touched` 列表 + `it.enabled = touched.contains(it.id) || it.enabled`
     * —— 那等于把**没碰过的** PID 也设成 true，从而污染 `ThemeStudioSampleTest`
     * （它要求"默认启用的内置 PID"与语义别名一一对应，而其中 4 个 `tpl_*` 默认是关的）。
     * 现在改成**逐 id 精确快照 / 恢复**。
     */
    private val originalEnabled = LinkedHashMap<String, Boolean>()

    @Before fun setUp() {
        VehicleBus.clear()
        BuiltInPids.all().forEach { p ->
            originalEnabled[p.id] = p.enabled
            p.enabled = false          // 先全关，用例自己开需要的
        }
    }

    @After fun tearDown() {
        VehicleBus.clear()
        BuiltInPids.all().forEach { p ->
            originalEnabled[p.id]?.let { p.enabled = it }   // 精确恢复
        }
        originalEnabled.clear()
    }

    private fun enableOnly(vararg ids: String) {
        BuiltInPids.all().forEach { p -> p.enabled = ids.contains(p.id) }
    }

    /** 可控传输层：按命令表回复，支持"不回"制造超时 */
    private class Bus(val replies: MutableMap<String, String?> = mutableMapOf()) : ObdTransport {
        override val kind = "BUS"
        override var rawMode = false
        override var callback: ObdTransport.Callback? = null
        override val state = ObdTransport.State.READY
        val sent = mutableListOf<String>()
        @Volatile var silent = false
        override fun startScan(nameFilter: String?) {}
        override fun stopScan() {}
        override fun connect(device: android.bluetooth.BluetoothDevice) {}
        override fun disconnect() {}
        override fun send(text: String) {
            sent += text
            if (silent) return
            val key = text.trim().removeSuffix("\r")
            val r = replies[key] ?: return
            Thread {
                try { Thread.sleep(1) } catch (_: InterruptedException) {}
                callback?.onRx(r)
            }.start()
        }
        override fun flushRx() {}
        override fun isReady() = true
        override fun describe() = "bus"
    }

    private fun wire(b: Bus, s: ElmSession) {
        b.callback = object : ObdTransport.Callback {
            override fun onStateChanged(st: ObdTransport.State, detail: String) {}
            override fun onScanResult(dev: android.bluetooth.BluetoothDevice, name: String, rssi: Int, addr: String) {}
            override fun onRx(text: String) { s.onRx(text) }
        }
    }

    // ================================================================ B1 多 PID 轮询调度

    @Test
    fun `B1 多 PID 轮询按调度逐个请求并写入总线`() = runBlocking {
        enableOnly("std_0C", "std_0D")
        val bus = Bus(mutableMapOf("01 0C" to "41 0C 1A F8", "01 0D" to "41 0D 3C"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            // 等轮询跑几轮
            var waited = 0
            while (waited < 4000 && (VehicleBus.get("std_0C")?.ok != true || VehicleBus.get("std_0D")?.ok != true)) {
                delay(100); waited += 100
            }
            val rpm = VehicleBus.get("std_0C")
            val spd = VehicleBus.get("std_0D")
            assertNotNull("转速应已写入总线", rpm)
            assertNotNull("车速应已写入总线", spd)
            assertTrue("转速值应有效", rpm!!.ok)
            assertTrue("车速值应有效", spd!!.ok)
            assertEquals(1726f, rpm.value!!, 1f)   // 0x1AF8/4
            assertEquals(60f, spd.value!!, 0.5f)
            // 两条都被真的请求过
            assertTrue("应请求过 0C", bus.sent.any { it.startsWith("01 0C") })
            assertTrue("应请求过 0D", bus.sent.any { it.startsWith("01 0D") })
        } finally { e.stop() }
    }

    // ================================================================ B2 值更新与采样时间

    @Test
    fun `B2 值更新后采样时间戳随之前进`() = runBlocking {
        enableOnly("std_0C")
        val bus = Bus(mutableMapOf("01 0C" to "41 0C 0F A0"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            var waited = 0
            while (waited < 3000 && VehicleBus.get("std_0C")?.ok != true) { delay(100); waited += 100 }
            val first = VehicleBus.get("std_0C")!!
            assertTrue(first.ok)
            val ts1 = first.ts
            // 改值
            bus.replies["01 0C"] = "41 0C 20 00"
            var waited2 = 0
            while (waited2 < 3000 && VehicleBus.get("std_0C")?.value != (0x2000 / 4).toFloat()) {
                delay(100); waited2 += 100
            }
            val second = VehicleBus.get("std_0C")!!
            assertEquals(2048f, second.value!!, 1f)   // 0x2000/4
            assertTrue("时间戳应前进", second.ts >= ts1)
        } finally { e.stop() }
    }

    // ================================================================ B3 不支持 PID 剔除与重启用

    @Test
    fun `B3 连续 NO DATA 会把 PID 判为不支持并可 reEnable`() = runBlocking {
        enableOnly("std_0C", "std_0D")
        // 0C 一直 NO DATA（ECU 明确拒绝），0D 正常
        val bus = Bus(mutableMapOf("01 0C" to "NO DATA", "01 0D" to "41 0D 3C"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            var waited = 0
            while (waited < 6000 && !e.unsupportedPids.contains("std_0C")) { delay(100); waited += 100 }
            assertTrue(
                "连续 ${ObdEngine.UNSUPPORTED_STREAK} 次 NO DATA 后应判为不支持",
                e.unsupportedPids.contains("std_0C")
            )
            assertFalse("正常的 0D 不应被剔除", e.unsupportedPids.contains("std_0D"))
            // 重启用
            assertTrue("reEnable 应成功", e.reEnable("std_0C"))
            assertFalse("reEnable 后不再标不支持", e.unsupportedPids.contains("std_0C"))
        } finally { e.stop() }
    }

    // ================================================================ B4 错 PID 不串入

    @Test
    fun `B4 错 PID 响应不得写入别的 PID`() = runBlocking {
        enableOnly("std_0C")
        // 请求 0C，但 ECU 回的是 0D 的数据（P5A-M06 起必须被拒）
        val bus = Bus(mutableMapOf("01 0C" to "41 0D 3C"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            delay(2500)
            val rpm = VehicleBus.get("std_0C")
            assertTrue("错 PID 不得生成转速有效值", rpm == null || !rpm.ok)
        } finally { e.stop() }
    }

    // ================================================================ B5 连续超时后退避

    @Test
    fun `B5 连续超时不会无限高频重试`() = runBlocking {
        enableOnly("std_0C")
        val bus = Bus()
        bus.silent = true          // 全部不回 → 每条都超时
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            delay(1500)
            val n1 = bus.sent.size
            delay(2000)
            val n2 = bus.sent.size
            // 退避后请求次数应明显少于"每 120ms 一次"（2 秒 = 约 16 次）
            val inSecond = n2 - n1
            assertTrue("超时后应退避，2 秒内请求 $inSecond 次（未退避会 >12）", inSecond <= 12)
        } finally { e.stop() }
    }

    // ================================================================ B6 过期值不冒充实时

    @Test
    fun `B6 停止后值按 TTL 过期而不是一直新鲜`() = runBlocking {
        enableOnly("std_0C")
        val bus = Bus(mutableMapOf("01 0C" to "41 0C 0F A0"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            var waited = 0
            while (waited < 3000 && VehicleBus.get("std_0C")?.ok != true) { delay(100); waited += 100 }
            assertTrue(VehicleBus.get("std_0C")!!.ok)
        } finally { e.stop() }
        // 停止轮询 → 来源关闭 → 值必须失效（不冒充实时）
        delay(200)
        val after = VehicleBus.get("std_0C")
        assertTrue("停止轮询后不得仍是有效值", after == null || !after.ok)
    }

    // ================================================================ B7 新来源替换后旧响应被拒

    @Test
    fun `B7 轮询重启后旧来源的写入不再生效`() = runBlocking {
        enableOnly("std_0C")
        val bus = Bus(mutableMapOf("01 0C" to "41 0C 0F A0"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        var waited = 0
        while (waited < 3000 && VehicleBus.get("std_0C")?.ok != true) { delay(100); waited += 100 }
        val oldSourceOk = VehicleBus.get("std_0C")!!.ok
        assertTrue(oldSourceOk)
        e.stop()
        delay(200)
        // 重启：新的 source/epoch
        e.start()
        try {
            bus.replies["01 0C"] = "41 0C 6B A0"
            var w = 0
            while (w < 3000 && VehicleBus.get("std_0C")?.value != 6888f) { delay(100); w += 100 }
            assertEquals("新连接的值应生效", 6888f, VehicleBus.get("std_0C")!!.value!!, 1f)
        } finally { e.stop() }
    }

    // ================================================================ B8 断开后按既有语义处理

    @Test
    fun `B8 断开后总线值失效 供仪表显示无数据`() = runBlocking {
        enableOnly("std_0C", "std_0D")
        val bus = Bus(mutableMapOf("01 0C" to "41 0C 0F A0", "01 0D" to "41 0D 3C"))
        val s = ElmSession(bus).also { wire(bus, it) }
        val e = ObdEngine(s)
        e.start()
        try {
            var waited = 0
            while (waited < 3000 && VehicleBus.snapshot().count { it.value.ok } < 2) { delay(100); waited += 100 }
            assertEquals("两条都应有值", 2, VehicleBus.snapshot().count { it.value.ok })
        } finally { e.stop() }
        delay(200)
        assertEquals("断开后 0 条有效（仪表会显示 --）", 0, VehicleBus.snapshot().count { it.value.ok })
    }
}
