package com.icar.obd.obd

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class PidScanRunTest {
    private class Runtime: PidScanRuntime {
        val transport=FakeTransport()
        override val session=ElmSession(transport)
        override var connected=true
        override var otherBusy=false
        override var engineRunning=true
        override val previousHeader="7E0"
        val commands=mutableListOf<String>()
        var stopCount=0
        var startCount=0
        var completed=0
        var restoreOK=true
        var pending=false
        var resumeThrows=false
        init { transport.reply={ if(!pending) session.onRx("62 00 0C 00") } }
        override suspend fun raw(command: String,timeoutMs: Long): String {
            commands+=command
            assertTrue(CanAdapterGate.scanning)
            return if(command=="ATSH 7DF" && !restoreOK) "?" else "OK"
        }
        override fun stopPolling() { stopCount++; engineRunning=false }
        override fun startPolling() { startCount++; engineRunning=true; if(resumeThrows) error("fake resume failure") }
        override fun completed(snapshot: PidScanRun.Snapshot) { completed++ }
    }
    private val cfg=PidScanner.Config("22",12,12,30,200,0,useSupportedBitmap=false,header="7E1")
    private suspend fun awaitDone(run: PidScanRun) { withTimeout(2500) { while(run.state.value.busy) delay(5) } }
    @Test fun `production owner pauses restores and releases only its lease`() = runBlocking {
        val io=Runtime(); val run=PidScanRun(io,this)
        run.start(cfg); awaitDone(run)
        assertEquals(1,io.stopCount); assertEquals(1,io.startCount)
        assertEquals(listOf("ATSH 7E1","ATSH 7DF"),io.commands)
        assertEquals(1,run.state.value.hits.size); assertEquals(1,io.completed)
        assertFalse(CanAdapterGate.scanning)
    }
    @Test fun `idle engine stays idle and its prior header is restored`() = runBlocking {
        val io=Runtime().apply { engineRunning=false }; val run=PidScanRun(io,this)
        run.start(cfg); awaitDone(run)
        assertEquals(0,io.stopCount); assertEquals(0,io.startCount)
        assertEquals("ATSH 7E0",io.commands.last())
    }
    @Test fun `stop cancels pending session without further PID sends and does restore`() = runBlocking {
        val io=Runtime().apply { pending=true }; val run=PidScanRun(io,this)
        run.start(cfg.copy(retry=3))
        while(io.transport.sent.isEmpty()) yield()
        run.stop(); awaitDone(run)
        assertEquals(1,io.transport.sent.size); assertTrue(run.state.value.hits.isEmpty())
        assertEquals(PidScanner.State.STOPPED,run.state.value.summary.state)
        assertEquals(1,io.startCount); assertFalse(CanAdapterGate.scanning)
    }
    @Test fun `stopping before dispatch still releases lease without setup traffic`() = runBlocking {
        val io=Runtime(); val run=PidScanRun(io,this)
        run.start(cfg); run.stop(); awaitDone(run)
        assertTrue(io.commands.isEmpty()); assertTrue(io.transport.sent.isEmpty())
        assertFalse(CanAdapterGate.scanning); assertEquals(PidScanner.State.STOPPED,run.state.value.summary.state)
    }
    @Test fun `failed restoration never resumes polling`() = runBlocking {
        val io=Runtime().apply { restoreOK=false }; val run=PidScanRun(io,this)
        run.start(cfg); awaitDone(run)
        assertEquals(0,io.startCount); assertEquals(PidScanner.State.FAILED,run.state.value.summary.state)
        assertTrue(run.state.value.message.contains("轮询未恢复"))
    }
    @Test fun `polling restart exception still publishes terminal state and releases scan`() = runBlocking {
        val io=Runtime().apply { resumeThrows=true }
        val isolated=CoroutineScope(coroutineContext+SupervisorJob()+CoroutineExceptionHandler { _,_ -> })
        try {
            val run=PidScanRun(io,isolated)
            run.start(cfg); awaitDone(run)
            assertFalse(CanAdapterGate.scanning); assertFalse(io.engineRunning)
            assertEquals(PidScanner.State.FAILED,run.state.value.summary.state)
            assertEquals(1,io.completed)
        } finally { isolated.cancel() }
    }
    @Test fun `other adapter mode and init reject start before IO`() = runBlocking {
        val io=Runtime().apply { otherBusy=true }; val run=PidScanRun(io,this)
        try { run.start(cfg); fail("busy accepted") } catch (_: IllegalStateException) {}
        io.otherBusy=false
        val init=CanAdapterGate.beginInitialization { false }!!
        try { run.start(cfg); fail("init accepted") } catch (_: IllegalStateException) {}
        finally { CanAdapterGate.endInitialization(init) }
        assertTrue(io.commands.isEmpty()); assertTrue(io.transport.sent.isEmpty())
    }
    @Test fun `active scan blocks initialization and another scan`() = runBlocking {
        val io=Runtime().apply { pending=true }; val run=PidScanRun(io,this)
        run.start(cfg)
        assertNull(CanAdapterGate.beginInitialization { false })
        assertNull(CanAdapterGate.beginPidScan { false })
        run.stop(); awaitDone(run)
    }
    @Test fun `disconnection releases lease without restoring onto another session`() = runBlocking {
        val io=Runtime().apply { pending=true }; val run=PidScanRun(io,this)
        run.start(cfg)
        while(io.transport.sent.isEmpty()) yield()
        io.connected=false; run.stop(); awaitDone(run)
        assertEquals(listOf("ATSH 7E1"),io.commands); assertEquals(0,io.startCount)
        assertFalse(CanAdapterGate.scanning)
    }
}
