package com.icar.obd.obd

import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** 实际 Bus 原子归属、锁外回调、有限期限及行程保护，不构造 Android 传输。 */
class VehicleBusSourceTest {
    private val sources = ArrayList<VehicleBus.Source>()
    @Before fun setup() { VehicleBus.Derived.resetTrip(); VehicleBus.clear() }
    @After fun teardown() {
        sources.forEach(VehicleBus::closeSource)
        VehicleBus.Derived.resetTrip(); VehicleBus.clear()
    }
    private fun source(owner: Any = Any()) = VehicleBus.openSource(owner).also { sources.add(it) }
    private fun value(id: String = "__source", v: Float = 12f, ts: Long = System.currentTimeMillis(), ttl: Int = 0) =
        PidValue(id, v, "same raw", ts, true, ttlMs = ttl)

    @Test fun `closing A leaves the current same PID from B alive`() {
        val a = source(); val b = source()
        VehicleBus.put(a, value(v = 1f)); VehicleBus.put(b, value(v = 2f))
        VehicleBus.closeSource(a)
        assertEquals(2f, VehicleBus.value("__source")!!, 0f)
        VehicleBus.closeSource(b)
        assertNull(VehicleBus.value("__source"))
        assertEquals(listOf(1f, 2f), VehicleBus.historyOf("__source"))
    }
    @Test fun `legacy overwrite detaches old ownership regardless of raw`() {
        val a = source()
        VehicleBus.put(a, value(v = 1f)); VehicleBus.put(value(v = 0f))
        VehicleBus.closeSource(a)
        assertEquals(0f, VehicleBus.value("__source")!!, 0f)
    }
    @Test fun `same owner restart closes old epoch and old close cannot end new epoch`() {
        val owner = Any(); val a = source(owner)
        VehicleBus.put(a, value(v = 1f))
        val b = source(owner)
        assertNull(VehicleBus.value("__source"))
        assertFalse(VehicleBus.put(a, value(v = 99f)))
        VehicleBus.put(b, value(v = 2f)); VehicleBus.closeSource(a)
        assertTrue(VehicleBus.sourceActive(b))
        assertEquals(2f, VehicleBus.value("__source")!!, 0f)
    }
    @Test fun `closed source rejects late values before history and listeners`() {
        val a = source(); val events = ArrayList<PidValue>()
        val remove = VehicleBus.addValueListener { events.add(it) }
        try {
            VehicleBus.put(a, value()); VehicleBus.closeSource(a)
            assertFalse(VehicleBus.put(a, value(v = 99f)))
            VehicleBus.closeSource(a)
            assertEquals(2, events.size)
            assertFalse(events.last().ok)
            assertEquals(listOf(12f), VehicleBus.historyOf("__source"))
            assertFalse(VehicleBus.get("__source")!!.ok)
            assertFalse(VehicleBus.snapshot().getValue("__source").ok)
        } finally { remove() }
    }
    @Test fun `close notifications run outside source lock and permit another writer`() {
        val a = source(); val b = source()
        VehicleBus.put(a, value())
        val finished = CountDownLatch(1)
        val completedInsideCallback = AtomicBoolean(false)
        val remove = VehicleBus.addValueListener {
            if (!it.ok && it.pidId == "__source") {
                val writer = Thread { VehicleBus.put(b, value(v = 42f)); finished.countDown() }
                writer.start()
                // listener exceptions are intentionally swallowed by Bus; assert outside it.
                completedInsideCallback.set(finished.await(2, TimeUnit.SECONDS))
            }
        }
        try {
            VehicleBus.closeSource(a)
            assertTrue("callback must not hold the source lock", completedInsideCallback.get())
            assertEquals(0L, finished.count)
            assertEquals(42f, VehicleBus.value("__source")!!, 0f)
        } finally { remove() }
    }
    @Test fun `concurrent close and put cannot leave a live value after close returns`() {
        repeat(40) { index ->
            val a = source(); val id = "__race_$index"
            val gate = CountDownLatch(1); val done = CountDownLatch(2)
            val accepted = AtomicBoolean(false)
            val writer = Thread { gate.await(); accepted.set(VehicleBus.put(a, value(id))); done.countDown() }
            val closer = Thread { gate.await(); VehicleBus.closeSource(a); done.countDown() }
            writer.start(); closer.start(); gate.countDown()
            assertTrue(done.await(3, TimeUnit.SECONDS))
            assertNull(VehicleBus.value(id)); assertFalse(VehicleBus.sourceActive(a))
            assertEquals(if (accepted.get()) listOf(12f) else emptyList<Float>(), VehicleBus.historyOf(id))
            assertFalse(VehicleBus.put(a, value(id, 99f)))
        }
    }
    @Test fun `source close expires instantaneous outputs without erasing accumulated trip`() {
        val a = source()
        VehicleBus.put(a, value("std_0D", 60f)); VehicleBus.put(a, value("std_5E", 6f))
        VehicleBus.Derived.computeAll { VehicleBus.put(a, it) }
        VehicleBus.Derived.integrateDistance(60f) { VehicleBus.put(a, it, retainOnClose = it.pidId == "calc_km") }
        assertEquals(1f, VehicleBus.Derived.accKm, 0.0001f)
        val liters = VehicleBus.Derived.accLiters
        assertNotNull(VehicleBus.value("calc_l100"))
        VehicleBus.closeSource(a)
        assertNull(VehicleBus.value("calc_lh")); assertNull(VehicleBus.value("calc_l100"))
        assertEquals(1f, VehicleBus.value("calc_km")!!, 0.0001f)
        assertEquals(1f, VehicleBus.Derived.accKm, 0.0001f)
        assertEquals(liters, VehicleBus.Derived.accLiters, 0f)
        assertEquals(listOf(60f), VehicleBus.historyOf("std_0D"))
    }
    @Test fun `late derived publisher cannot revive closed output`() {
        val a = source()
        val delayed: (PidValue) -> Unit = { VehicleBus.put(a, it) }
        VehicleBus.put(a, value("std_0D", 60f)); VehicleBus.put(a, value("std_5E", 6f))
        VehicleBus.Derived.computeAll(delayed)
        val before = VehicleBus.historyOf("calc_l100")
        VehicleBus.closeSource(a)
        VehicleBus.put(value("std_0D", 80f)); VehicleBus.put(value("std_5E", 8f))
        VehicleBus.Derived.computeAll(delayed)
        assertNull(VehicleBus.value("calc_l100"))
        assertEquals(before, VehicleBus.historyOf("calc_l100"))
    }
    @Test fun `finite source TTL expires through every reader and retains history`() {
        val a = source()
        VehicleBus.put(a, value(ts = System.currentTimeMillis() - 5000, ttl = 2000))
        assertNull(VehicleBus.value("__source")); assertFalse(VehicleBus.get("__source")!!.ok)
        assertFalse(VehicleBus.snapshot().getValue("__source").ok)
        assertEquals(listOf(12f), VehicleBus.historyOf("__source"))
    }
    @Test fun `non finite values never enter history and close still invalidates current`() {
        val a = source()
        VehicleBus.put(a, value(v = Float.NaN)); VehicleBus.put(a, value(v = Float.POSITIVE_INFINITY))
        assertTrue(VehicleBus.historyOf("__source").isEmpty())
        VehicleBus.closeSource(a); assertNull(VehicleBus.value("__source"))
    }
    @Test fun `explicit positive TTL wins and runtime zero has finite minimum`() {
        assertEquals(17, PollFreshness.ttl(17, 5000L))
        assertEquals(2000, PollFreshness.ttl(0, 30L))
        assertEquals(15000, PollFreshness.ttl(0, 5000L))
        assertEquals(2000, PollFreshness.ttl(-1, -1L))
    }
    @Test fun `priority and backoff affect effective interval and TTL`() {
        val p = PidDefinition(priority = PidDefinition.PRIORITY_LOW)
        val interval = PollFreshness.interval(p, 1000, 4f)
        assertEquals(8000L, interval); assertEquals(24000, PollFreshness.ttl(0, interval))
        p.priority = PidDefinition.PRIORITY_HIGH
        assertEquals(500L, PollFreshness.interval(p, 1000, 1f))
        p.intervalMs = 600
        assertEquals(2400L, PollFreshness.interval(p, 1000, 4f))
    }
    @Test fun `interval and TTL cannot overflow or become unlimited`() {
        assertEquals(Int.MAX_VALUE, PollFreshness.ttl(0, Long.MAX_VALUE))
        val p = PidDefinition(priority = PidDefinition.PRIORITY_LOW)
        assertEquals(Int.MAX_VALUE.toLong(), PollFreshness.interval(p, Int.MAX_VALUE, 4f))
        assertEquals(30L, PollFreshness.interval(p, Int.MIN_VALUE, Float.NaN))
        assertEquals(200L, PollFreshness.interval(p, 100, Float.POSITIVE_INFINITY))
    }
}
