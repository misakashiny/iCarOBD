package com.icar.obd.obd

import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * T-App-A1-M-P: production FrameMonitor start/receive/stop lifecycle red regressions.
 * The fake runtime only replaces Android transport, scheduling, and initialization;
 * FrameMonitor's production parser and publish path remain in use.
 */
class FrameMonitorLifecycleTest {
    private lateinit var runtime: FakeFrameMonitorRuntime
    private lateinit var scheduler: ImmediateFrameMonitorScheduler
    private val saved = Store.customPids.toList()
    private val savedOverrides = HashMap(Store.enabledOverride)

    @Before fun setUp() = runBlocking {
        runtime = FakeFrameMonitorRuntime()
        scheduler = ImmediateFrameMonitorScheduler()
        FrameMonitor.runtime = runtime
        FrameMonitor.scheduler = scheduler
        // 清空上一例可能残留的收尾状态。
        // stop() 的内部收尾跑在真实 IO 调度器上（delay 200+400ms），
        // 所以这里必须**等它真正结束**再开始本例，否则 start() 会因 busy=true
        // 直接返回，waitUntil 永远等不到 monitoring —— 那是夹具竞态，不是产品结论。
        settleStop()
        Store.customPids.clear()
        Store.enabledOverride.clear()
        Store.customPids += PidDefinition(
            id = "__monitor_lifecycle",
            name = "lifecycle monitor",
            source = "monitor",
            header = "09A",
            formula = "A",
            ttlMs = 1000,
            enabled = true
        )
        VehicleBus.clear()
    }

    @After fun tearDown() = runBlocking {
        settleStop()
        Store.customPids.clear(); Store.customPids.addAll(saved)
        Store.enabledOverride.clear(); Store.enabledOverride.putAll(savedOverrides)
        VehicleBus.clear()
    }

    /**
     * 停止监听并**等待收尾真正完成**。
     *
     * `FrameMonitor.active = running || busy`；`stop()` 把 `running=false`
     * 后仍会在 IO 协程里置 `busy=false`，期间 `start()` 会被 busy 守卫挡回。
     * 夹具必须等到 `!active`，否则相邻用例互相污染（这正是原第三例
     * "condition did not settle" 的来源）。
     */
    private suspend fun settleStop() {
        FrameMonitor.stop()
        repeat(300) {
            if (!FrameMonitor.active) return
            delay(10)
        }
        fail("FrameMonitor did not settle after stop")
    }

    @Test fun `production receive then stop invalidates monitor value`() = runBlocking {
        FrameMonitor.start()
        waitUntil { runtime.monitoring }
        assertTrue(FrameMonitor.running)
        runtime.emit("09A 2A 00 00 00 00 00 00 00\r")
        assertEquals(42f, VehicleBus.value("__monitor_lifecycle")!!, 0f)

        settleStop()

        // Desired contract: stopping this source must expire only its current value.
        assertFalse("monitor source value remained current after stop", VehicleBus.get("__monitor_lifecycle")!!.ok)
        assertEquals(listOf(42f), VehicleBus.historyOf("__monitor_lifecycle"))
    }

    @Test fun `old callback after fast reopen cannot publish into new run`() = runBlocking {
        FrameMonitor.start()
        waitUntil { runtime.monitoring }
        val oldCallback = runtime.listener ?: error("listener not installed")
        settleStop()
        FrameMonitor.start()
        waitUntil { runtime.monitoring }
        val before = VehicleBus.historyOf("__monitor_lifecycle")
        oldCallback("09A 63 00 00 00 00 00 00 00\r")
        assertEquals(before, VehicleBus.historyOf("__monitor_lifecycle"))
    }

    @Test fun `same pid from another source survives monitor stop`() = runBlocking {
        FrameMonitor.start()
        waitUntil { runtime.monitoring }
        runtime.emit("09A 2A 00 00 00 00 00 00 00\r")
        assertEquals(42f, VehicleBus.value("__monitor_lifecycle")!!, 0f)

        // 另一个来源接管同一个 PID（例如轮询回复）。它必须是"当前来源"。
        val other = VehicleBus.openSource(Any())
        VehicleBus.put(other, PidValue("__monitor_lifecycle", 99f, "other", System.currentTimeMillis(), true))
        assertEquals(99f, VehicleBus.value("__monitor_lifecycle")!!, 0f)

        settleStop()

        // 停止监听**不得**清掉其他来源接管的当前值：它仍应是 99 且 ok。
        val after = VehicleBus.get("__monitor_lifecycle")!!
        assertEquals("monitor stop must not clobber another source's current value", 99f, after.value, 0f)
        assertTrue("value owned by another source must stay current", after.ok)
    }

    private suspend fun waitUntil(predicate: () -> Boolean) {
        repeat(300) {
            if (predicate()) return
            delay(10)
        }
        fail("condition did not settle")
    }
}

private class FakeFrameMonitorRuntime : FrameMonitorRuntime {
    override val connected = true
    override var engineRunning = false
    override var rawMode = false
    override var rawChunkListener: ((String) -> Unit)? = null
    var monitoring = false
    val sent = mutableListOf<String>()
    val listener get() = rawChunkListener

    override fun send(text: String) {
        sent += text
        when (text) {
            "ATMA\r" -> monitoring = true
            "\r" -> monitoring = false
        }
    }

    override suspend fun raw(command: String, timeoutMs: Long): String = "OK"

    override suspend fun initializeWithoutPolling(): com.icar.obd.obd.ElmSession.InitResult =
        com.icar.obd.obd.ElmSession.InitResult(true, "", "", "", "", "", emptyList())

    override fun stopPolling() { engineRunning = false }
    override fun startPolling() { engineRunning = true }
    override fun runCycleOnce() = Unit
    override fun toast(message: String) = Unit

    fun emit(text: String) { rawChunkListener?.invoke(text) }
}

private class ImmediateFrameMonitorScheduler : FrameMonitorScheduler {
    override fun post(block: Runnable) { block.run() }
    override fun postDelayed(delayMs: Long, block: Runnable) { /* ticker is not needed by lifecycle assertions */ }
    override fun remove(block: Runnable) = Unit
}
