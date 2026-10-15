package com.icar.obd.obd

import com.icar.obd.data.CanFilterPresets
import kotlinx.coroutines.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import kotlin.coroutines.resume
import kotlin.coroutines.CoroutineContext

/** 直接执行生产 CanSniffer start/stop/轮换/收尾，只有环境为可控假传输。 */
class CanSnifferLifecycleTest {
    private lateinit var io: SniffTestRuntime
    private lateinit var saved: CanSnifferRuntime
    @Before fun setup() {
        saved = CanSniffer.runtime
        io = SniffTestRuntime()
        CanSniffer.runtime = io
        CanSniffer.onUpdate = null
        CanSniffer.reset()
        for (name in listOf("baseline", "lastRun")) {
            CanSniffer::class.java.getDeclaredField(name).apply { isAccessible = true }.set(CanSniffer, emptyMap<Int, Set<String>>())
        }
        CanSniffer::class.java.getDeclaredField("lastFilter").apply { isAccessible = true }.set(CanSniffer, "")
    }
    @After fun teardown() {
        CanSniffer.onUpdate = null
        CanSniffer.stop(); io.advance(30000)
        io.scope.cancel()
        CanSniffer.reset()
        CanSniffer.runtime = saved
    }
    private fun capture(filter: String = "", rotate: Boolean = false) {
        CanSniffer.start(3000, filter, rotate); io.advance(350)
        assertEquals(CanSniffer.Phase.CAPTURING, CanSniffer.status.phase)
    }

    @Test fun `stop during preparation never opens monitor later`() {
        CanSniffer.start(); CanSniffer.stop(); io.advance(4000)
        assertFalse(io.sent.contains("ATMA\r"))
        assertFalse(io.rawMode)
    }
    @Test fun `stop before IO worker enters still finishes and releases adapter`() {
        io.scope.cancel()
        val worker = QueuedDispatcher()
        io = SniffTestRuntime(worker)
        CanSniffer.runtime = io
        io.polling = true
        try {
            CanSniffer.start()
            assertTrue(CanSniffer.busy)
            CanSniffer.stop()
            worker.drain()
            assertFalse("cancelled queued coroutine must release active run", CanSniffer.busy)
            assertEquals(CanSniffer.Phase.DONE, CanSniffer.status.phase)
            assertTrue(io.polling)
            assertTrue(io.sent.isEmpty())
            assertTrue(io.commands.isEmpty())
            assertEquals(1, io.completedRecords.size)
        } finally {
            // 红回归中的挂起Run也必须隔离，不能连带污染下一条正式测试。
            if (CanSniffer.busy) {
                CanSniffer::class.java.getDeclaredField("active").apply { isAccessible = true }.set(CanSniffer, null)
                CanSniffer.reset()
            }
        }
    }
    @Test fun `clear during capture cannot discard active results or unlock phase`() {
        capture(); io.emit("09A 00 01\r")
        CanSniffer.reset()
        assertEquals(CanSniffer.Phase.CAPTURING, CanSniffer.status.phase)
        assertEquals(1, CanSniffer.aggregates().single().count)
    }
    @Test fun `unsafe adapter input is rejected before polling or sending`() {
        io.polling = true
        CanSniffer.start(filterHex = "ATZ+ATMA"); io.advance(1000)
        assertTrue(io.polling)
        assertTrue(io.sent.isEmpty()); assertTrue(io.commands.isEmpty())
    }
    @Test fun `rotation interrupts changes filter and reopens monitor for every segment`() {
        capture(rotate = true); io.advance(21000)
        assertTrue("must reopen after two segment changes", io.sent.count { it == "ATMA\r" } >= 3)
        assertTrue("filter commands must run outside monitor stream", io.commands.none { it.second })
    }
    @Test fun `filter rejection prevents misleading capture`() {
        io.replies["ATCRA09A"] = "?\r>"
        CanSniffer.start(filterHex = "09A"); io.advance(4000)
        assertEquals(CanSniffer.Phase.FAILED, CanSniffer.status.phase)
        assertFalse(io.sent.contains("ATMA\r"))
    }
    @Test fun `filter cleanup cannot start polling that was stopped before capture`() {
        capture("09A"); io.emit("09A 00\r")
        CanSniffer.stop(); io.advance(4000)
        assertFalse(io.polling)
        assertTrue(io.reinitializations.all { !it })
    }
    @Test fun `failed run retains last successful comparison baseline`() {
        capture(); io.emit("09A 00\r"); CanSniffer.stop(); io.advance(4000)
        io.replies["ATH1"] = "?\r>"
        CanSniffer.start(); io.advance(4000)
        assertEquals(CanSniffer.Phase.FAILED, CanSniffer.status.phase)
        io.replies.clear()
        capture(); io.emit("09A 00\r09A 04\r"); CanSniffer.stop(); io.advance(4000)
        assertTrue(CanSniffer.diffAgainstBaseline().any { it.canId == 0x09A && it.bitIndex == 2 })
    }
    @Test fun `historical turn preset really filters the ID printed on screen`() {
        val preset = CanFilterPresets.ALL.first { it.label.contains("转向灯") }
        assertEquals(listOf("ATCRA09A"), CanFilterPresets.resolveCommands(preset.value))
    }
    @Test fun `all standard IDs preset is distinct from segment zero`() {
        val all = CanFilterPresets.ALL.first { it.label.contains("全部 11") }
        assertEquals(listOf("ATCM000", "ATCF000"), CanFilterPresets.resolveCommands(all.value))
        assertNotEquals(all.value, CanFilterPresets.segmentValue(0))
    }
    @Test fun `late receiver from old capture cannot feed a new run`() {
        capture(); val old = io.receiver!!
        io.emit("09A 00\r"); CanSniffer.stop(); io.advance(4000)
        capture(); old("09A FF\r")
        assertTrue(CanSniffer.aggregates().isEmpty())
        io.emit("09A 01\r")
        assertEquals("01", CanSniffer.aggregates().single().lastData)
    }
    @Test fun `unhealthy cleanup stays paused and reports failure`() {
        io.polling = true; capture()
        io.replies["0100"] = "NO DATA\r>"
        CanSniffer.stop(); io.advance(4000)
        assertFalse(io.polling); assertEquals(CanSniffer.Phase.FAILED, CanSniffer.status.phase)
    }
    @Test fun `monitor preparation or cleanup blocks capture without IO`() {
        io.monitorBusy = true
        CanSniffer.start(); io.advance(5000)
        assertFalse(CanSniffer.busy)
        assertTrue(io.sent.isEmpty()); assertTrue(io.commands.isEmpty())
    }
    @Test fun `busy cleanup refuses restart and only releases when finished`() {
        capture(); CanSniffer.stop()
        val id = CanSniffer.status.runId
        CanSniffer.start(); CanSniffer.reset()
        assertTrue(CanSniffer.busy); assertEquals(id, CanSniffer.status.runId)
        io.advance(4000); assertFalse(CanSniffer.busy)
    }
    @Test fun `full rotation keeps real raw frames and marks exactly eight completed segments`() {
        io.onOpen = { segment -> io.emit("%03X 01\r".format((segment - 1) * 256 + 10)) }
        capture(rotate = true); io.advance(90000)
        assertEquals(8, io.sent.count { it == "ATMA\r" })
        assertEquals(8, CanSniffer.status.completedSegments)
        assertTrue(CanSniffer.status.rotation!!.done)
        assertEquals(8, CanSniffer.rawFrames().size)
        assertEquals(8, CanSniffer.aggregates().size)
        assertTrue(io.commands.none { it.second })
    }
    @Test fun `partial rotation cannot claim entire round completed`() {
        capture(rotate = true); io.emit("09A 00\r"); CanSniffer.stop(); io.advance(4000)
        assertFalse(CanSniffer.status.rotation!!.done)
        assertTrue(CanSniffer.status.message.contains("提前结束"))
    }
    @Test fun `terminal result is ready when completion listener runs and archived once`() {
        capture(); io.emit("09A 00\r"); CanSniffer.stop(); io.advance(4000)
        capture(); io.emit("09A 00\r09A 04\r")
        var differences = 0
        CanSniffer.onUpdate = { if (it.phase == CanSniffer.Phase.DONE) differences = CanSniffer.diffAgainstBaseline().size }
        CanSniffer.stop(); io.advance(4000)
        assertTrue(differences > 0)
        val id = CanSniffer.status.runId
        assertEquals(1, io.completedRecords.count { it.runId == id })
        CanSniffer.stop(); io.advance(1000)
        assertEquals(1, io.completedRecords.count { it.runId == id })
    }
    @Test fun `adapter ending monitor cannot remain falsely capturing`() {
        capture(); io.emit("09A 00\rBUFFER FULL\r>"); io.advance(4000)
        assertEquals(CanSniffer.Phase.FAILED, CanSniffer.status.phase)
        assertFalse(CanSniffer.busy); assertFalse(io.rawMode)
        assertTrue(CanSniffer.status.message.contains("自行结束"))
    }
    @Test fun `disconnect ends capture without resuming polling or sending to lost connection`() {
        io.polling = true; capture(); val sent = io.sent.size
        io.connected = false; io.advance(1000)
        assertEquals(CanSniffer.Phase.FAILED, CanSniffer.status.phase)
        assertFalse(io.polling); assertFalse(io.rawMode); assertNull(io.receiver)
        assertEquals(sent, io.sent.size)
    }
    @Test fun `active initialization prevents probe before any adapter send`() {
        val token = CanAdapterGate.beginInitialization { false }!!
        try {
            CanSniffer.start();io.advance(1000)
            assertFalse(CanSniffer.busy);assertTrue(io.sent.isEmpty());assertTrue(io.commands.isEmpty())
        } finally {CanAdapterGate.endInitialization(token)}
    }
    @Test fun `previous segment callback cannot pollute a later segment`() {
        capture(rotate = true);val first=io.receiver!!
        io.advance(10300)
        assertEquals(1,CanSniffer.status.rotation!!.index)
        first("09A FF\r")
        assertTrue(CanSniffer.aggregates().isEmpty())
        io.emit("10A 01\r")
        assertEquals(0x10A,CanSniffer.aggregates().single().canId)
    }
}

private class QueuedDispatcher : CoroutineDispatcher() {
    private val queue = ArrayDeque<Runnable>()
    override fun dispatch(context: CoroutineContext, block: Runnable) { queue.addLast(block) }
    fun drain() {
        repeat(1000) {
            if (queue.isEmpty()) return
            queue.removeFirst().run()
        }
        error("queued CAN worker did not settle")
    }
}

private class SniffTestRuntime(dispatcher: CoroutineDispatcher = Dispatchers.Unconfined) : CanSnifferRuntime {
    override val scope = CoroutineScope(SupervisorJob() + dispatcher)
    override var connected = true
    override val kind = "fake"
    override var monitorBusy = false
    var polling = false
    override val engineRunning get() = polling
    override var rawMode = false
    override var receiver: ((String) -> Unit)? = null
    val sent = ArrayList<String>()
    val commands = ArrayList<Pair<String, Boolean>>()
    val replies = HashMap<String, String>()
    val reinitializations = ArrayList<Boolean>()
    val completedRecords = ArrayList<CanSniffer.Status>()
    override fun completed(status: CanSniffer.Status, aggregates: List<CanFrame.Aggregate>, csv: String) {
        assertFalse(CanSniffer.busy)
        assertTrue(status.phase in listOf(CanSniffer.Phase.DONE,CanSniffer.Phase.FAILED))
        completedRecords.add(status)
    }
    private var monitoring = false
    var onOpen: ((Int) -> Unit)? = null
    private var openCount = 0
    private var clock = 1_000_000L
    private data class Timer(val task: Runnable, val at: Long)
    private val timers = ArrayList<Timer>()
    override fun send(text: String) {
        sent.add(text)
        if (text == "ATMA\r") { monitoring = true; onOpen?.invoke(++openCount) }
        else if (monitoring) { monitoring = false; receiver?.invoke("STOPPED\r>") }
        else if (text == "\r") receiver?.invoke(">")
    }
    override suspend fun raw(command: String, timeoutMs: Long): String {
        commands.add(command to monitoring)
        return replies[command] ?: if (command == "0100") "41 00 BE 3E A8 13\r>" else "OK\r>"
    }
    override suspend fun reinitialize(startPolling: Boolean): Boolean {
        reinitializations.add(startPolling)
        if (startPolling) polling = true
        return true
    }
    override fun startPolling() { polling = true }
    override fun stopPolling() { polling = false }
    override fun post(task: Runnable, delayMs: Long) { timers.add(Timer(task, clock + delayMs)) }
    override fun remove(task: Runnable) { timers.removeAll { it.task === task } }
    override fun now() = clock
    override suspend fun wait(ms: Long) = suspendCancellableCoroutine<Unit> { continuation ->
        val task = Runnable { if (continuation.isActive) continuation.resume(Unit) }
        post(task, ms); continuation.invokeOnCancellation { remove(task) }
    }
    fun emit(chunk: String) { receiver?.invoke(chunk) }
    fun advance(ms: Long) {
        val target = clock + ms
        repeat(10000) {
            val next = timers.filter { it.at <= target }.minByOrNull { it.at }
                ?: run { clock = target; return }
            timers.remove(next); clock = next.at; next.task.run()
        }
        error("CAN test scheduler did not settle")
    }
}
