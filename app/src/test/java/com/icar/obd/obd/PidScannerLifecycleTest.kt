package com.icar.obd.obd

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

/** Runs the production scanner and session; transport never accesses a device. */
class PidScannerLifecycleTest {
    private fun fixture(reply: (String) -> String?): Pair<PidScanner, FakeTransport> {
        val transport = FakeTransport()
        val session = ElmSession(transport)
        transport.reply = { reply(transport.sent.last().trim())?.let(session::onRx) }
        return PidScanner(session) to transport
    }
    private fun cfg(mode: String = "01", from: Int = 0x0C, to: Int = from) = PidScanner.Config(
        mode, from, to, intervalMs = 30, timeoutMs = 200, retry = 0, useSupportedBitmap = false)

    @Test fun `mode21 really sends local identifier service21`() = runBlocking {
        val (s,t) = fixture { "61 0C 10" }
        val hits = s.scan(cfg("21")) { _,_,_ -> }
        assertEquals(listOf("21 0C\r"), t.sent)
        assertEquals("10", hits.single().dataHex)
    }
    @Test fun `mode23 is rejected before any transport IO`() = runBlocking {
        val (s,t) = fixture { "63 000C 10" }
        try { s.scan(cfg("23")) { _,_,_ -> }; fail("23 accepted") }
        catch (_: IllegalArgumentException) { }
        assertEquals(0,t.flushes); assertTrue(t.sent.isEmpty())
    }
    @Test fun `wrong identifier cannot be a hit and is retried`() = runBlocking {
        val (s,t) = fixture { "41 0D 55" }
        assertTrue(s.scan(cfg().copy(retry=1)) { _,_,_ -> }.isEmpty())
        assertEquals(2,t.sent.size)
    }
    @Test fun `request cap includes retries and learning samples`() = runBlocking {
        val (s,t) = fixture { "62 00 0C 10" }
        s.scan(cfg("22",12,14).copy(maxRequests=2,learnSamples=4,learnIntervalMs=30)) { _,_,_ -> }
        assertTrue("actual=${t.sent.size}", t.sent.size <= 2)
    }
    @Test fun `request cap also includes supported bitmap queries`() = runBlocking {
        val (s,t) = fixture { "41 ${it.takeLast(2)} FF FF FF FF" }
        s.scan(cfg(from=0,to=0xC0).copy(useSupportedBitmap=true,maxRequests=2)) { _,_,_ -> }
        assertTrue("actual=${t.sent.size}", t.sent.size <= 2)
    }
    @Test fun `valid empty support block does not trigger blind scanning`() = runBlocking {
        val (s,t) = fixture { "41 ${it.takeLast(2)} 00 00 00 00" }
        assertTrue(s.scan(cfg(from=1,to=2).copy(useSupportedBitmap=true)) { _,_,_ -> }.isEmpty())
        assertFalse(t.sent.any { it.trim() == "01 01" || it.trim() == "01 02" })
    }
    @Test fun `stop while awaiting answer interrupts retries and callbacks`() = runBlocking {
        val (s,t) = fixture { null }
        var callbacks=0
        val job=launch { s.scan(cfg().copy(retry=2)) { done,_,_ -> if(done>0) callbacks++ } }
        while(t.sent.isEmpty()) yield()
        s.cancel()
        withTimeout(1000) { job.join() }
        assertEquals(1,t.sent.size); assertEquals(0,callbacks)
    }
    @Test fun `invalid retry and timing are rejected before transport`() = runBlocking {
        val (s,t) = fixture { "41 0C 00" }
        try { s.scan(cfg().copy(retry=9,intervalMs=0)) { _,_,_ -> }; fail("invalid config accepted") }
        catch (_: IllegalArgumentException) { }
        assertTrue(t.sent.isEmpty())
    }
    @Test fun `invalid ranges and header cannot allocate or send`() = runBlocking {
        val (s,t)=fixture { "41 0C 01" }
        for(c in listOf(cfg().copy(from=-1),cfg().copy(to=Int.MAX_VALUE),cfg("21").copy(to=256),
            cfg("22").copy(to=65536),cfg().copy(header="7DF\rATZ"),cfg().copy(header="800"))) {
            try { s.scan(c) { _,_,_ -> }; fail("invalid config accepted") } catch (_: IllegalArgumentException) {}
        }
        assertTrue(t.sent.isEmpty())
    }
    @Test fun `partial bitmap failure does not hide later A4 and A6 or other ECU bits`() = runBlocking {
        val (s,t)=fixture {
            when(it) {
                "01 20" -> "NO DATA"
                "01 A0" -> "41 A0 10 00 00 00\r41 A0 04 00 00 00"
                "01 A4","01 A6" -> "41 ${it.takeLast(2)} 00"
                else -> "41 ${it.takeLast(2)} 00 00 00 00"
            }
        }
        val hits=s.scan(cfg(from=0,to=0xC0).copy(useSupportedBitmap=true)) { _,_,_ -> }
        assertEquals(listOf("A4","A6"),hits.map { it.pid })
        assertEquals(1,s.summary.unknownBlocks); assertTrue(t.sent.contains("01 C0\r"))
    }
    @Test fun `all retries share one hard budget and incomplete count stays incomplete`() = runBlocking {
        val (s,t)=fixture { "NO DATA" }
        s.scan(cfg(from=12,to=13).copy(retry=3,maxRequests=2)) { _,_,_ -> }
        assertEquals(2,t.sent.size); assertEquals(PidScanner.State.LIMIT,s.summary.state)
        assertEquals(0,s.summary.done); assertEquals(2,s.summary.total)
    }
    @Test fun `learning keeps initial zero in reference range and enforces spacing`() = runBlocking {
        val times=mutableListOf<Long>()
        val (s,t)=fixture { times+=System.nanoTime(); if(times.size==1) "62 00 0C 00" else "62 00 0C 10" }
        val hits=s.scan(cfg("22").copy(learnSamples=2,learnIntervalMs=30)) { _,_,_ -> }
        assertEquals(3,t.sent.size); assertEquals(0f,hits.single().learnedMin!!)
        assertEquals(16f,hits.single().learnedMax!!)
        assertTrue(times.zipWithNext().all { (a,b) -> b-a>=29_000_000 })
    }
    @Test fun `blacklist is canonicalized and limit report has true counters even with no hits`() = runBlocking {
        val (s,t)=fixture { "NO DATA" }
        s.scan(cfg(from=12,to=13).copy(blacklist=setOf("01:0c"),maxRequests=1,retry=1)) { _,_,_ -> }
        assertEquals(listOf("01 0D\r"),t.sent)
        val report=PidScanner.report(cfg(),emptyList(),emptyList(),"T",s.summary)
        assertTrue(report.contains("状态: LIMIT")); assertTrue(report.contains("请求=1/")); assertTrue(report.contains("命中: 0"))
    }
}
