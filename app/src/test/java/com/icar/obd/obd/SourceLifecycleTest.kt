package com.icar.obd.obd

import com.icar.obd.data.BuiltInPids
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.ArrayDeque
import kotlin.coroutines.CoroutineContext

/**
 * Original eight red tests from T-App-A1-P retained as correctness tests for T-App-A1-C.
 * Only the private engine dispatcher is replaced to deterministically step cancellation.
 * No Android transport is created or connected. These are desired behavior, not bug-as-pass tests.
 */
class SourceLifecycleTest {
    private val savedOverrides = HashMap(Store.enabledOverride)
    private val savedCustom = Store.customPids.toList()
    private val savedEnabled = BuiltInPids.all().associateWith { it.enabled }
    private val scopes = ArrayList<CoroutineScope>()
    private val engines = ArrayList<ObdEngine>()
    private val failures = ArrayList<Throwable>()
    private lateinit var dispatcher: StepDispatcher

    @Before fun setUp() {
        VehicleBus.Derived.resetTrip()
        VehicleBus.clear()
        dispatcher = StepDispatcher()
        Store.enabledOverride.clear()
        BuiltInPids.all().forEach { Store.enabledOverride[it.id] = false }
        Store.customPids.clear()
        Store.customPids.add(speed())
    }

    @After fun tearDown() {
        engines.forEach { it.stop() }
        scopes.forEach { it.cancel() }
        dispatcher.runReady()
        Store.enabledOverride.clear(); Store.enabledOverride.putAll(savedOverrides)
        Store.customPids.clear(); Store.customPids.addAll(savedCustom)
        savedEnabled.forEach { (pid, enabled) -> pid.enabled = enabled }
        VehicleBus.Derived.resetTrip()
        VehicleBus.clear()
    }

    private fun speed() = PidDefinition(id = "__lifecycle_speed", name = "source lifecycle speed", mode = "01", pid = "0D", formula = "A", intervalMs = 5000)

    private fun engine(transport: FakeTransport): Pair<ObdEngine, ElmSession> {
        val session = ElmSession(transport)
        val engine = ObdEngine(session)
        val scope = CoroutineScope(SupervisorJob() + dispatcher + CoroutineExceptionHandler { _, error -> failures.add(error) })
        // Explicit test scheduling seam: no copied loop/stop logic or changes to production sources.
        ObdEngine::class.java.getDeclaredField("scope").apply { isAccessible = true }.set(engine, scope)
        scopes.add(scope); engines.add(engine)
        return engine to session
    }

    @Test fun `stopping actual poll engine makes its last current value unavailable`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 53\r>") }
        engine.start(); dispatcher.runNext()
        assertEquals(83f, VehicleBus.value("__lifecycle_speed")!!, 0f)
        engine.stop(); dispatcher.runReady()
        assertNull("poll stop must invalidate its last current value", VehicleBus.value("__lifecycle_speed"))
    }

    @Test fun `actual poll engine publishes a finite freshness deadline`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 53\r>") }
        engine.start(); dispatcher.runNext()
        val value = VehicleBus.get("__lifecycle_speed")!!
        assertTrue("a silent live source must eventually expire, not ttl=0", value.ttlMs > 0)
    }

    @Test fun `cancelled old request must not overwrite a newer source value`() {
        val transport = FakeTransport()
        val (engine, _) = engine(transport)
        engine.start(); dispatcher.runNext()
        assertEquals(listOf("01 0D\r"), transport.sent)
        engine.stop()
        // Engine cancellation is queued. A different source writes before its old job resumes.
        VehicleBus.put(PidValue("__lifecycle_speed", 42f, "sim-new-source", System.currentTimeMillis(), true))
        dispatcher.runReady()
        assertEquals("old cancellation must not invalidate newer source", 42f, VehicleBus.value("__lifecycle_speed") ?: Float.NaN, 0f)
    }

    @Test fun `rapid restart must not let cancelled job send another old PID`() {
        Store.customPids.add(PidDefinition(id = "__old_second", mode = "01", pid = "05", formula = "A-40", intervalMs = 5000))
        val transport = FakeTransport()
        val (engine, _) = engine(transport)
        engine.start(); dispatcher.runNext()
        engine.stop()
        Store.customPids.clear()
        Store.customPids.add(PidDefinition(id = "__new_session", mode = "01", pid = "42", formula = "((A*256)+B)/1000", intervalMs = 5000))
        engine.start()
        dispatcher.runReady()
        assertFalse("old cancelled job must not borrow new running=true", transport.sent.contains("01 05\r"))
    }

    @Test fun `unexpected send failure must end the actual engine lifecycle`() {
        val transport = FakeTransport()
        val (engine, _) = engine(transport)
        transport.reply = { throw IllegalStateException("injected send failure") }
        engine.start(); dispatcher.runNext()
        assertEquals(1, failures.size)
        assertFalse("completed failed job cannot still claim running", engine.running)
    }

    @Test fun `stopping poll must preserve newer foreign value and other sources`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 53\r>") }
        engine.start(); dispatcher.runNext()
        VehicleBus.put(PidValue("__lifecycle_speed", 42f, "sim-new-source", System.currentTimeMillis(), true))
        VehicleBus.put(PidValue("calc_gx", 0.3f, "sensor", System.currentTimeMillis(), true))
        engine.stop(); dispatcher.runReady()
        assertEquals(42f, VehicleBus.value("__lifecycle_speed")!!, 0f)
        assertEquals(0.3f, VehicleBus.value("calc_gx")!!, 0f)
    }

    @Test fun `poll stop must preserve intentional historical samples`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 53\r>") }
        engine.start(); dispatcher.runNext()
        val history = VehicleBus.historyOf("__lifecycle_speed")
        assertEquals(listOf(83f), history)
        engine.stop(); dispatcher.runReady()
        assertEquals(history, VehicleBus.historyOf("__lifecycle_speed"))
    }

    @Test fun `finite legacy TTL expires on read while retaining raw history`() {
        VehicleBus.put(PidValue("__expired", 12f, "monitor", System.currentTimeMillis() - 5000, true, ttlMs = 1000))
        assertNull(VehicleBus.value("__expired"))
        assertEquals(listOf(12f), VehicleBus.historyOf("__expired"))
    }

    @Test fun `old finally cannot stop or clear newly started engine job`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        engine.start(); dispatcher.runNext(); engine.stop()
        transport.reply = { session.onRx("41 0D 00\r>") }
        engine.start(); dispatcher.runReady()
        assertTrue(engine.running)
        assertEquals(0f, VehicleBus.value("__lifecycle_speed")!!, 0f)
    }

    @Test fun `successful actual response honors configured TTL`() {
        Store.customPids.single().ttlMs = 77
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 00\r>") }
        engine.start(); dispatcher.runNext()
        assertEquals(77, VehicleBus.get("__lifecycle_speed")!!.ttlMs)
    }

    @Test fun `listener restart during stop cannot cancel new job`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 53\r>") }
        engine.start(); dispatcher.runNext()
        val remove = VehicleBus.addValueListener {
            if (it.pidId == "__lifecycle_speed" && !it.ok) engine.start()
        }
        try {
            engine.stop(); dispatcher.runReady()
            assertTrue(engine.running)
            assertEquals(83f, VehicleBus.value("__lifecycle_speed")!!, 0f)
        } finally { remove() }
    }

    @Test fun `failure after successful response invalidates that epoch value`() {
        Store.customPids.add(PidDefinition(id = "__failed_second", mode = "01", pid = "05", formula = "A-40"))
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = {
            if (transport.sent.last() == "01 0D\r") session.onRx("41 0D 53\r>")
            else throw IllegalStateException("injected second send failure")
        }
        engine.start(); dispatcher.runNext()
        assertEquals(listOf(83f), VehicleBus.historyOf("__lifecycle_speed"))
        assertNull(VehicleBus.value("__lifecycle_speed"))
        assertFalse(engine.running); assertEquals(1, failures.size)
    }

    @Test fun `job cancellation during derived listener must not run onCycle`() {
        val transport = FakeTransport()
        val (engine, session) = engine(transport)
        transport.reply = { session.onRx("41 0D 53\r>") }
        var cycles = 0
        engine.onCycle = { cycles++ }
        val remove = VehicleBus.addValueListener {
            if (it.pidId == "calc_lh") {
                val job = ObdEngine::class.java.getDeclaredField("job").apply { isAccessible = true }.get(engine) as Job
                job.cancel()
            }
        }
        try {
            engine.start(); dispatcher.runNext()
            assertEquals(0, cycles)
            assertFalse(engine.running)
            assertNull(VehicleBus.value("__lifecycle_speed"))
        } finally { remove() }
    }
}

/** No blocking send or real transport latency: advance real coroutine continuations by hand. */
private class StepDispatcher : CoroutineDispatcher() {
    private val queue = ArrayDeque<Runnable>()
    override fun dispatch(context: CoroutineContext, block: Runnable) { synchronized(queue) { queue.addLast(block) } }
    fun runNext() {
        val block = synchronized(queue) { queue.pollFirst() } ?: error("No scheduled continuation")
        block.run()
    }
    fun runReady() {
        repeat(64) {
            val block = synchronized(queue) { queue.pollFirst() } ?: return
            block.run()
        }
        error("source test dispatcher did not settle within 64 steps")
    }
}
