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

    @Before fun setUp() {
        runtime = FakeFrameMonitorRuntime()
        scheduler = ImmediateFrameMonitorScheduler()
        FrameMonitor.runtime = runtime
        FrameMonitor.scheduler = scheduler
        FrameMonitor.stop()
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
        FrameMonitor.stop()
        delay(20)
        Store.customPids.clear(); Store.customPids.addAll(saved)
        Store.enabledOverride.clear(); Store.enabledOverride.putAll(savedOverrides)
        VehicleBus.clear()
    }

    @Test fun `production receive then stop invalidates monitor value`() = runBlocking {
        FrameMonitor.start()
        waitUntil { runtime.monitoring }
        assertTrue(FrameMonitor.running)
        runtime.emit("09A 2A 00 00 00 00 00 00 00\r")
        assertEquals(42f, VehicleBus.value("__monitor_lifecycle")!!, 0f)

        FrameMonitor.stop()
        waitUntil { !FrameMonitor.active }

        // Desired contract: stopping this source must expire only its current value.
        assertFalse("monitor source value remained current after stop", VehicleBus.get("__monitor_lifecycle")!!.ok)
        assertEquals(listOf(42f), VehicleBus.historyOf("__monitor_lifecycle"))
    }

    @Test fun `old callback after fast reopen cannot publish into new run`() = runBlocking {
        FrameMonitor.start()
        waitUntil { runtime.monitoring }
        val oldCallback = runtime.listener ?: error("listener not installed")
        FrameMonitor.stop()
        waitUntil { !FrameMonitor.active }
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
        val other = VehicleBus.openSource(Any())
        VehicleBus.put(other, PidValue("__monitor_lifecycle", 99f, "other", System.currentTimeMillis(), true))
        FrameMonitor.stop()
        waitUntil { !FrameMonitor.active }
        assertEquals(99f, VehicleBus.value("__monitor_lifecycle")!!, 0f)
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
