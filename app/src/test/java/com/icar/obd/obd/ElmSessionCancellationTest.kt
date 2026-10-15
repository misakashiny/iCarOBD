package com.icar.obd.obd

import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test

class ElmSessionCancellationTest {
    @Test fun `external cancellation stays cancellation and mutex is reusable`() = runBlocking {
        val t=FakeTransport(); val s=ElmSession(t)
        var returned=false
        val job=launch { s.raw("01 0C",5000); returned=true }
        while(t.sent.isEmpty()) yield()
        job.cancelAndJoin()
        assertFalse(returned)
        t.reply={ s.onRx("41 0D 00") }
        assertEquals("41 0D 00",withTimeout(1000) { s.raw("01 0D",200) })
    }
    @Test fun `timeout is empty rather than cancelling caller`() = runBlocking {
        assertEquals("",ElmSession(FakeTransport()).raw("01 0C",10))
        assertTrue(currentCoroutineContext().isActive)
    }
    @Test fun `send failure cleans waiter and allows next request`() = runBlocking {
        val t=FakeTransport(); val s=ElmSession(t)
        t.reply={ throw IllegalStateException("fake send failure") }
        try { s.raw("01 0C",200); fail("send failure was swallowed") }
        catch (e: IllegalStateException) { assertEquals("fake send failure",e.message) }
        s.onRx("old")
        t.reply={ s.onRx("41 0D 00") }
        assertEquals("41 0D 00",s.raw("01 0D",200))
    }
}
