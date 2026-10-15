package com.icar.obd.obd

import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import org.junit.After
import org.junit.Before
import org.junit.Assert.*
import org.junit.Test

/** Executes the production start/ticker/stop, without Android or a copied simulator. */
class SignalSimulatorLifecycleTest {
    private val sim=SignalSimulator
    private lateinit var previous: SignalSimulatorRuntime
    private lateinit var io: FakeSimulatorRuntime
    @Before fun setup() {
        previous=sim.runtime; io=FakeSimulatorRuntime()
        sim.runtime=io; sim.stop(); sim.rebuildFromPids(); VehicleBus.clear()
    }
    @After fun cleanup() { sim.stop(); sim.rebuildFromPids(); sim.runtime=previous; VehicleBus.clear() }
    private fun channel(id: String="__sim",value: Float=10f)=SignalSimulator.Channel(id,
        wave=SignalSimulator.WAVE_CONSTANT,min=value,max=value,noise=0f)
    private fun start(ch: SignalSimulator.Channel=channel()): Runnable {
        sim.update(ch); sim.start(); return io.queue.first().also { io.fire(it) }
    }
    @Test fun `actual stop invalidates current zero and preserves history`() {
        start(channel(value=0f)); assertEquals(0f,VehicleBus.value("__sim")!!,0f)
        val before=VehicleBus.historyOf("__sim")
        sim.stop(); sim.stop()
        assertNull(VehicleBus.value("__sim")); assertFalse(VehicleBus.get("__sim")!!.ok)
        assertFalse(VehicleBus.snapshot().getValue("__sim").ok)
        assertEquals(before,VehicleBus.historyOf("__sim"))
    }
    @Test fun `old ticker cannot borrow a new running flag or reschedule itself`() {
        val old=start(); sim.stop(); sim.update(channel(value=20f)); sim.start()
        val fresh=io.queue.first(); io.fire(fresh)
        val history=VehicleBus.historyOf("__sim")
        val queued=io.queue.toList()
        io.fire(old)
        assertEquals(history,VehicleBus.historyOf("__sim")); assertEquals(queued,io.queue)
        assertEquals(20f,VehicleBus.value("__sim")!!,0f)
    }
    @Test fun `same raw text from another source survives simulation stop`() {
        start(); VehicleBus.put(PidValue("__sim",42f,"sim",io.clock,true))
        VehicleBus.put(PidValue("calc_gx",0.5f,"sensor",io.clock,true))
        sim.stop()
        assertEquals(42f,VehicleBus.value("__sim")!!,0f)
        assertEquals(0.5f,VehicleBus.value("calc_gx")!!,0f)
    }
    @Test fun `all G channels belong to the same stopped simulator`() {
        listOf("calc_gx","calc_gy","calc_gforce").forEach { sim.update(sim.autoChannel(PidDefinition(id=it)).copy(noise=0f)) }
        sim.start(); io.fire(io.queue.first()); sim.stop()
        listOf("calc_gx","calc_gy","calc_gforce").forEach { assertNull(it,VehicleBus.value(it)); assertFalse(VehicleBus.get(it)!!.ok) }
    }
    @Test fun `active but silent simulation has a finite expiry`() {
        io.clock=System.currentTimeMillis()-5000
        start()
        assertTrue(sim.running); assertNull(VehicleBus.value("__sim"))
        assertTrue(VehicleBus.get("__sim")!!.ttlMs>=1000)
        assertEquals(listOf(10f),VehicleBus.historyOf("__sim"))
    }
    @Test fun `positive configured TTL wins over simulator default`() {
        io.definitions=listOf(PidDefinition(id="__sim",ttlMs=5000))
        start()
        assertEquals(5000,VehicleBus.get("__sim")!!.ttlMs)
    }
    @Test fun `stop from value callback prevents remainder of the current tick`() {
        sim.update(channel("a",1f)); sim.update(channel("b",2f))
        val remove=VehicleBus.addValueListener { if(it.pidId=="a" && it.ok) sim.stop() }
        try { sim.start(); io.fire(io.queue.first()); assertNull(VehicleBus.value("a")); assertNull(VehicleBus.get("b")); assertTrue(io.queue.isEmpty()) }
        finally { remove() }
    }
    @Test fun `nonfinite samples are unknown and never enter history`() {
        start(channel(value=Float.NaN))
        assertNull(VehicleBus.value("__sim")); assertFalse(VehicleBus.get("__sim")!!.ok)
        assertTrue(VehicleBus.historyOf("__sim").isEmpty())
    }
    @Test fun `pending ticker after stop cannot publish or extend history`() {
        sim.update(channel()); sim.start(); val old=io.queue.first()
        sim.stop(); io.fire(old)
        assertNull(VehicleBus.get("__sim")); assertTrue(VehicleBus.historyOf("__sim").isEmpty())
        assertTrue(io.queue.isEmpty()); assertFalse(sim.running)
    }
    @Test fun `stopping and restarting inside notification rejects the old remainder`() {
        sim.update(channel("a",1f)); sim.update(channel("b",2f))
        var switched=false
        val remove=VehicleBus.addValueListener {
            if(!switched && it.pidId=="a" && it.ok) {
                switched=true; sim.stop(); sim.update(channel("b",99f)); sim.start()
            }
        }
        try {
            sim.start(); io.fire(io.queue.first())
            assertTrue(sim.running); assertNull(VehicleBus.get("b")); assertEquals(1,io.queue.size)
            io.fire(io.queue.first()); assertEquals(99f,VehicleBus.value("b")!!,0f)
            assertEquals(listOf(99f),VehicleBus.historyOf("b"))
        } finally { remove() }
    }
    @Test fun `simulation stop leaves accumulated trip and unrelated history intact`() {
        VehicleBus.Derived.resetTrip()
        VehicleBus.Derived.integrateDistance(60f) { VehicleBus.put(it) }
        val distance=VehicleBus.Derived.accKm
        val liters=VehicleBus.Derived.accLiters
        val history=VehicleBus.historyOf("calc_km")
        start(); sim.stop()
        assertEquals(distance,VehicleBus.Derived.accKm,0f)
        assertEquals(liters,VehicleBus.Derived.accLiters,0f)
        assertEquals(history,VehicleBus.historyOf("calc_km"))
        assertEquals(distance,VehicleBus.value("calc_km")!!,0f)
        VehicleBus.Derived.resetTrip()
    }
}

internal class FakeSimulatorRuntime: SignalSimulatorRuntime {
    var clock=System.currentTimeMillis()+1000
    var definitions=emptyList<PidDefinition>()
    val queue=mutableListOf<Runnable>()
    override fun now()=clock
    override fun pids()=definitions
    override fun post(task: Runnable,delayMs: Long) { queue+=task }
    override fun remove(task: Runnable) { queue.removeAll { it===task } }
    fun fire(task: Runnable) { queue.removeAll { it===task }; task.run() }
}
