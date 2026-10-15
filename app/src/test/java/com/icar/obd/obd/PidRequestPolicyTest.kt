package com.icar.obd.obd

import android.bluetooth.BluetoothDevice
import com.icar.obd.ble.ObdTransport
import com.icar.obd.data.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PidRequestPolicyTest {
    private fun pid(mode: String = "01", request: String? = null, header: String = "") =
        PidDefinition(mode = mode, pid = if (mode == "22") "1234" else "0C",
            customRequest = request, header = header)

    @Test fun `normal existing read modes and request formats are accepted`() {
        for ((mode, request) in listOf("01" to "010C", "09" to "09 02", "21" to "21 01", "22" to "22 12 34")) {
            assertNotNull("$mode/$request", PidRequestPolicy.check(pid(mode, request)).request)
        }
        assertEquals("01 0C", PidRequestPolicy.check(pid("1", "1 0C")).request!!.command)
    }

    @Test fun `all built in active request definitions remain compatible`() {
        BuiltInPids.all().filter { it.mode != "CALC" && it.source != "monitor" }.forEach {
            assertNotNull("${it.id}: ${PidRequestPolicy.check(it).error}", PidRequestPolicy.check(it).request)
        }
    }

    @Test fun `all existing dangerous modes and unknown services are denied`() {
        (ObdProtocol.DANGEROUS_MODES + setOf("00", "2E", "2F", "31", "3E", "85", "FF")).forEach {
            assertNull(it, PidRequestPolicy.check(pid(it, "$it 00")).request)
            assertNotNull(it, PidRequestPolicy.sessionError("$it 00"))
        }
    }

    @Test fun `normal declaration cannot hide dangerous custom request`() {
        for (request in listOf("04", "04 00", "0400", "2E 12 34 00", "31 01 FF 00")) {
            assertNull(request, PidRequestPolicy.check(pid(request = request)).request)
        }
    }

    @Test fun `adapter commands are forbidden as user PID overrides`() {
        listOf("ATZ", "AT SH 7E0", "ATMA", "ATRV", "AT CAF 0").forEach {
            assertNull(it, PidRequestPolicy.check(pid(request = it)).request)
        }
    }

    @Test fun `overridden read service must match the declared service`() {
        assertNull(PidRequestPolicy.check(pid(request = "22 12 34")).request)
    }

    @Test fun `malformed partial unicode and multiple commands are rejected`() {
        listOf("", "01", "010", "01 ZZ", "0x01 0C", "０１ ０Ｃ", "01 0C\r04", "01 0C\nATZ", "01 0C\u0000", "01 0C;04", "01 " + "00".repeat(40)).forEach { request ->
            // Empty customRequest falls back to the stored definition by legacy contract.
            val p = pid(request = request).also { if (request.isEmpty()) it.pid = "" }
            assertNull("request=$request", PidRequestPolicy.check(p).request)
        }
        assertNull(PidRequestPolicy.check(pid("22", "22 12")).request)
    }

    @Test fun `monitor derived and unknown source cannot actively send`() {
        listOf("monitor", "sim", "unknown").forEach {
            assertNull(PidRequestPolicy.check(pid().apply { source = it }).request)
        }
        assertNull(PidRequestPolicy.check(pid("CALC")).request)
    }

    @Test fun `CAN headers are validated before any adapter write`() {
        listOf("", "7DF", "7e0", "000007E0", "18DAF110", "1FFFFFFF").forEach {
            assertNotNull(it, PidRequestPolicy.check(pid(header = it)).request)
        }
        listOf("800", "20000000", "7E0\rATZ", "7E0;ATZ", "0x7E0", "ZZZ", "FFFFFFFF", "7E").forEach {
            assertNull(it, PidRequestPolicy.check(pid(header = it)).request)
        }
    }

    @Test fun `checked request captures definition rather than following later edits`() {
        val p = pid(header = "7E0")
        val checked = PidRequestPolicy.check(p).request!!
        p.customRequest = "04"; p.header = "7E0\rATZ"; p.mode = "04"
        assertEquals("01 0C", checked.command)
        assertEquals("7E0", checked.header)
        assertNull(PidRequestPolicy.check(p).request)
    }

    @Test fun `internal initialization and existing protocol probes remain permitted`() {
        (ObdProtocol.initSequence(0) + ObdProtocol.initSequence(6) + listOf("ATI", "ATDPN", "ATDP", "ATRV", "ATH1", "ATS1", "ATL1", "ATCF09A", "ATCM7FF", "0100", "01 0C", "ATSH7E0\r")).forEach {
            assertNull(it, PidRequestPolicy.sessionError(it))
        }
        assertNotNull(PidRequestPolicy.sessionError("ATZ\r04"))
    }

    @Test fun `actual session refuses invalid user PID before flush and send`() = runBlocking {
        val transport = FakeTransport()
        val session = ElmSession(transport)
        for (p in listOf(pid(request = "04"), pid(request = "ATZ"), pid(header = "7E0\rATZ"))) {
            try {
                session.requestPid(p, 50)
                fail("unsafe user PID was accepted")
            } catch (_: IllegalArgumentException) {}
        }
        assertEquals(0, transport.flushes)
        assertTrue(transport.sent.isEmpty())
    }

    @Test fun `actual raw session also refuses unsafe diagnostic services before IO`() = runBlocking {
        val transport = FakeTransport()
        val session = ElmSession(transport)
        for (cmd in listOf("04", "04 00", "2E 12 34 00", "01 0C\r04")) {
            try { session.raw(cmd, 50); fail(cmd) } catch (_: IllegalArgumentException) {}
        }
        assertTrue(transport.sent.isEmpty())
        assertEquals(0, transport.flushes)
    }

    @Test fun `an internally constructed PID token cannot borrow the adapter command path`() = runBlocking {
        val transport = FakeTransport()
        try {
            ElmSession(transport).requestPid(PidRequestPolicy.ReadRequest("ATZ", ""), 50)
            fail("typed PID path accepted AT")
        } catch (_: IllegalArgumentException) {}
        assertTrue(transport.sent.isEmpty())
        assertEquals(0, transport.flushes)
    }

    @Test fun `actual session reads a valid checked PID and still sends internal setup`() = runBlocking {
        val transport = FakeTransport()
        val session = ElmSession(transport)
        transport.reply = { session.onRx("OK") }
        assertEquals("OK", session.requestPid(pid(), 50))
        assertEquals("OK", session.raw("ATZ\r", 50))
        assertEquals(listOf("01 0C\r", "ATZ\r"), transport.sent)
    }

    @Test fun `JSON import shape cannot conceal custom request danger`() = runBlocking {
        val p = PidDefinition.fromJson(JSONObject("""{"mode":"01","pid":"0C","enabled":true,"customRequest":"04"}"""))
        val transport = FakeTransport()
        try { ElmSession(transport).requestPid(p); fail("import bypass") } catch (_: IllegalArgumentException) {}
        assertTrue(p.enabled)
        assertEquals("04", p.customRequest)
        assertTrue(transport.sent.isEmpty())
    }
}

/** Does not construct, discover or connect any Android Bluetooth adapter. */
internal class FakeTransport : ObdTransport {
    override val kind = "TEST"
    override var rawMode = false
    override var callback: ObdTransport.Callback? = null
    override val state = ObdTransport.State.READY
    val sent = mutableListOf<String>()
    var flushes = 0
    var reply: (() -> Unit)? = null
    override fun startScan(nameFilter: String?) = error("No hardware access in tests")
    override fun stopScan() {}
    override fun connect(device: BluetoothDevice) = error("No hardware access in tests")
    override fun disconnect() {}
    override fun send(text: String) { sent += text; reply?.invoke() }
    override fun flushRx() { flushes++ }
    override fun isReady() = true
    override fun describe() = "fake"
}
