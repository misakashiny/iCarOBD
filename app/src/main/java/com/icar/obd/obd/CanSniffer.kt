package com.icar.obd.obd

import com.icar.obd.data.AppLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/** 被动探测：一轮独占准备、采集、分段切换和收尾，停止可取消任何等待。 */
object CanSniffer {
    enum class Phase { IDLE, PREPARING, CAPTURING, FINISHING, DONE, FAILED }
    data class Status(
        val phase: Phase, val elapsedMs: Long = 0L, val frameCount: Int = 0,
        val idCount: Int = 0, val dropped: Int = 0, val message: String = "",
        val rotation: RotationPlan.Snapshot? = null, val rotatedIdCount: Int = 0,
        val runId: Long = 0L, val filter: String = "", val durationMs: Long = 0L,
        val completedSegments: Int = 0
    )
    const val DEFAULT_DURATION_MS = 10_000L
    const val MIN_DURATION_MS = 3_000L
    const val MAX_DURATION_MS = 60_000L
    val ROTATE_DURATION_MS: Long get() = SegmentRotation.ROUND_MS
    private const val CMD_TIMEOUT = 2500L
    private const val LINE_BUF_MAX = 8192
    private val lock = CanAdapterGate.lock
    internal var runtime: CanSnifferRuntime = AndroidCanSnifferRuntime()
    @Volatile var onUpdate: ((Status) -> Unit)? = null
    @Volatile var status = Status(Phase.IDLE)
        private set
    private class Run(
        val id: Long, val io: CanSnifferRuntime, val duration: Long,
        val filter: String, val commands: List<String>, val rotating: Boolean, val restorePolling: Boolean
    ) {
        lateinit var job: Job
        @Volatile var entered = false
        var stopped = false
        var accepting = false
        var monitoring = false
        var settingsChanged = false
        var filterApplied = false
        var startedAt = 0L
        var segmentAt = 0L
        var segment = 0
        var completedSegments = 0
        var hadCapture = false
        var lines = 0
        var loggedLines = 0
        var prompt: CompletableDeferred<Unit>? = null
        var terminalCause: String? = null
        val buffer = StringBuilder()
        val total = CanFrame.Accumulator()
        var segmentAcc = CanFrame.Accumulator()
    }
    private var serial = 0L
    @Volatile private var active: Run? = null
    private var result = CanFrame.Accumulator()
    private var lastRun: Map<Int, Set<String>> = emptyMap()
    private var baseline: Map<Int, Set<String>> = emptyMap()
    private var lastFilter = ""
    private var lastGoodId = 0L
    val running: Boolean get() = status.phase == Phase.PREPARING || status.phase == Phase.CAPTURING
    val busy: Boolean get() = active != null
    val hasBaseline: Boolean get() = synchronized(lock) {
        status.runId == lastGoodId && status.phase == Phase.DONE && baseline.isNotEmpty() && lastRun.isNotEmpty()
    }
    private fun publish(io: CanSnifferRuntime, value: Status) {
        status = value
        io.post(Runnable { if (status === value) onUpdate?.invoke(value) })
    }
    fun start(duration: Long = DEFAULT_DURATION_MS, filterHex: String = "", rotate: Boolean = false) {
        val parsed = CanReceiveFilter.parse(if (rotate) "" else filterHex)
        val io = runtime.capture()
        synchronized(lock) {
            if (busy) return
            val reason = when {
                parsed.error != null -> parsed.error
                CanAdapterGate.initializing -> "适配器正在初始化，请等它结束后再采集"
                CanAdapterGate.scanning -> "PID探测正在运行或收尾，请等它结束"
                io.monitorBusy -> "常驻监听正在准备、运行或收尾，请先停止并等收尾完成"
                !io.connected -> "适配器未连接，请先到「连接」页完成连接与初始化"
                else -> null
            }
            if (reason != null) { publish(io, Status(Phase.FAILED, message = reason)); return }
            val run = Run(++serial, io, if (rotate) ROTATE_DURATION_MS else duration.coerceIn(MIN_DURATION_MS, MAX_DURATION_MS),
                if (rotate) "分段轮换" else filterHex.trim(), parsed.commands, rotate, io.engineRunning)
            active = run
            result = run.total
            publish(io, state(run, Phase.PREPARING, "正在准备监听，轮询已暂停"))
            run.job = io.scope.launch(start = CoroutineStart.LAZY) {
                run.entered = true
                execute(run)
            }
            // IO任务排队期间取消时，协程体/finally不会执行；仍须走唯一收尾入口。
            run.job.invokeOnCompletion { cause ->
                if (!run.entered) run.io.scope.launch(NonCancellable) {
                    finish(run, if (run.stopped) null else cause?.message ?: "探测任务未开始就结束")
                }
            }
            if (run.restorePolling) io.stopPolling()
            run.job.start()
        }
    }
    private suspend fun check(run: Run) {
        currentCoroutineContext().ensureActive()
        check(active === run && !run.stopped) { "探测已停止" }
        check(run.io.connected) { "适配器已断开或连接已更换" }
    }
    private fun ok(response: String) = response.lineSequence().flatMap { it.split('\r', '>').asSequence() }
        .any { it.trim().equals("OK", true) }
    private suspend fun command(run: Run, value: String, required: Boolean = true) {
        var response = ""
        repeat(3) {
            check(run)
            response = run.io.raw(value, CMD_TIMEOUT)
            check(run)
            if (ok(response)) return
            run.io.wait(200)
        }
        AppLog.w(AppLog.M_OBD, "探测命令未生效", "$value -> ${response.trim().take(48)}")
        if (required) error("$value 连续3次没有回OK，本次探测未继续")
    }
    private suspend fun execute(run: Run) {
        var failure: String? = null
        try {
            check(run)
            run.io.send("\r")
            run.io.wait(300)
            for (value in listOf("ATH1", "ATS1", "ATL1")) {
                run.settingsChanged = true
                command(run, value, required = value != "ATL1")
            }
            val segments = if (run.rotating) SegmentRotation.SEGMENT_COUNT else 1
            for (segment in 0 until segments) {
                check(run)
                run.segment = segment
                synchronized(lock) {
                    publish(run.io, state(run, Phase.PREPARING,
                        if (run.rotating) "正在设置第${segment + 1}/8段接收范围" else "正在设置接收范围"))
                }
                val commands = if (run.rotating) SegmentRotation.segmentCommands(segment) else run.commands
                if (commands.isNotEmpty()) run.filterApplied = true
                commands.forEach { command(run, it) }
                check(run)
                synchronized(lock) {
                    run.buffer.setLength(0)
                    run.segmentAcc = CanFrame.Accumulator()
                    run.prompt = null
                    run.io.receiver = { chunk -> receive(run, segment, chunk) }
                    run.io.rawMode = true
                    run.monitoring = true
                    run.accepting = true
                    run.segmentAt = run.io.now()
                    if (!run.hadCapture) run.startedAt = run.segmentAt
                    run.hadCapture = true
                    run.io.send("ATMA\r")
                }
                val segmentMs = if (run.rotating) SegmentRotation.SEGMENT_MS else run.duration
                while (run.io.now() - run.segmentAt < segmentMs) {
                    check(run)
                    synchronized(lock) { publish(run.io, state(run, Phase.CAPTURING, "正在采集广播帧")) }
                    run.io.wait(minOf(500L, segmentMs - (run.io.now() - run.segmentAt)))
                }
                synchronized(lock) { run.completedSegments++ }
                interrupt(run)
            }
        } catch (cancelled: CancellationException) {
            if (!run.stopped) failure = run.terminalCause ?: "探测任务被取消"
        } catch (error: Throwable) {
            failure = error.message ?: "探测失败"
        } finally {
            withContext(NonCancellable) { finish(run, failure) }
        }
    }
    /** 确认提示符后才能发过滤命令；中断字符本身会被适配器丢弃。 */
    private suspend fun interrupt(run: Run) {
        if (!run.monitoring) return
        if (!run.io.connected) {
            run.monitoring = false
            run.io.rawMode = false
            run.io.receiver = null
            return
        }
        synchronized(lock) { run.accepting = false; run.prompt = CompletableDeferred() }
        run.io.send("\r")
        if (run.io.connected) withTimeout(CMD_TIMEOUT) { run.prompt!!.await() }
        run.monitoring = false
        run.io.rawMode = false
        run.io.receiver = null
        run.buffer.setLength(0)
        run.io.wait(200)
    }
    fun stop() {
        val run = synchronized(lock) {
            val run = active ?: return
            if (run.stopped) return
            run.stopped = true
            run.accepting = false
            run
        }
        run.job.cancel()
    }
    private fun receive(run: Run, segment: Int, chunk: String) = synchronized(lock) {
        if (active !== run || run.segment != segment) return@synchronized
        if ('>' in chunk) run.prompt?.complete(Unit)
        if (!run.accepting || run.stopped) return@synchronized
        run.buffer.append(chunk)
        var consumed = 0
        for (index in run.buffer.indices) {
            if (run.buffer[index] != '\r' && run.buffer[index] != '\n') continue
            val line = run.buffer.substring(consumed, index).trim()
            consumed = index + 1
            if (line.isEmpty()) continue
            run.lines++
            if (run.loggedLines++ < 12) AppLog.i(AppLog.M_OBD, "CAN原始行", line.take(140))
            CanFrame.parseLine(line)?.let { frame ->
                run.total.feed(frame, run.io.now())
                if (run.rotating) run.segmentAcc.feed(frame, run.io.now())
            }
        }
        if (consumed > 0) run.buffer.delete(0, consumed)
        if (run.buffer.length > LINE_BUF_MAX) run.buffer.setLength(0)
        if ('>' in chunk && run.prompt == null) {
            run.accepting = false
            run.terminalCause = "适配器已自行结束监听，本次采集没有完成"
            run.job.cancel()
        }
    }
    private suspend fun finish(run: Run, initialFailure: String?) {
        synchronized(lock) {
            run.accepting = false
            publish(run.io, state(run, Phase.FINISHING, "正在退出监听并恢复适配器，请稍候"))
        }
        var failure = initialFailure
        var healthy = run.io.connected
        try {
            interrupt(run)
            if (run.io.connected && run.settingsChanged) {
                if (run.filterApplied) healthy = run.io.reinitialize(startPolling = false)
                else for (cmd in listOf("ATH0", "ATS0", "ATL0")) {
                    healthy = ok(run.io.raw(cmd, CMD_TIMEOUT)) && healthy
                }
                val reply = run.io.raw("0100", CMD_TIMEOUT)
                healthy = (ObdProtocol.extractData(reply, 1, "00")?.size ?: 0) >= 4 && healthy
            }
        } catch (error: Throwable) {
            failure = failure ?: "监听退出或恢复失败：${error.message}"
            healthy = false
        } finally {
            run.io.rawMode = false
            run.io.receiver = null
        }
        synchronized(lock) {
            if (active !== run) return
            if (!healthy) failure = (failure?.plus("；") ?: "") + "链路未恢复，轮询保持暂停，请到连接页重新初始化"
            val frames = run.total.frameCount()
            if (failure == null && run.hadCapture && frames > 0) {
                val filterKey = if (run.rotating) "rotate" else run.commands.joinToString("+")
                baseline = if (filterKey == lastFilter) lastRun else emptyMap()
                lastRun = snapshotOf(run.total)
                lastFilter = filterKey
                lastGoodId = run.id
            }
            active = null
            if (healthy && run.restorePolling) run.io.startPolling()
            val message = failure ?: when {
                !run.hadCapture -> "已取消，本次没有开始采集"
                run.rotating && run.completedSegments < SegmentRotation.SEGMENT_COUNT ->
                    "提前结束，采到第${run.segment + 1}/${SegmentRotation.SEGMENT_COUNT}段；保留已收到的数据"
                run.stopped -> "已提前结束采集，保留已收到的数据"
                frames == 0 -> "采集结束，未收到有效帧；检查连接、车辆状态或扩大过滤范围"
                else -> "采集结束，共$frames 帧 / ${run.total.aggregates().size}个ID"
            }
            val finalState = state(run, if (failure == null) Phase.DONE else Phase.FAILED, message)
            runCatching { run.io.completed(finalState, run.total.aggregates(), run.total.aggregateCsv()) }
                .onFailure { AppLog.e(AppLog.M_OBD, "探测记录保存失败", it.message ?: "") }
            publish(run.io, finalState)
            AppLog.i(AppLog.M_OBD, "CAN探测结束", "run=${run.id} frames=$frames lines=${run.lines} 恢复=$healthy $message")
        }
    }
    private fun state(run: Run, phase: Phase, message: String): Status {
        val elapsed = if (run.hadCapture) (run.io.now() - run.startedAt).coerceAtLeast(0L) else 0L
        val segmentRemaining = if (run.hadCapture)
            (SegmentRotation.SEGMENT_MS - (run.io.now() - run.segmentAt)).coerceIn(0L, SegmentRotation.SEGMENT_MS)
            else SegmentRotation.SEGMENT_MS
        val rotation = if (run.rotating) RotationPlan.Snapshot(run.segment, SegmentRotation.SEGMENT_COUNT,
            segmentRemaining, (SegmentRotation.SEGMENT_COUNT - run.segment - 1) * SegmentRotation.SEGMENT_MS + segmentRemaining,
            run.completedSegments == SegmentRotation.SEGMENT_COUNT) else null
        val acc = if (run.rotating && phase == Phase.CAPTURING) run.segmentAcc else run.total
        return Status(phase, elapsed, acc.frameCount(), acc.aggregates().size, run.total.dropped, message, rotation,
            run.total.aggregates().size, run.id, run.filter, run.duration, run.completedSegments)
    }
    private fun snapshotOf(acc: CanFrame.Accumulator) = acc.aggregates().associate { it.canId to it.values.toSet() }
    fun snapshot(): Map<Int, Set<String>> = synchronized(lock) { snapshotOf(result) }
    fun diffAgainstBaseline(): List<CanDiff.BitChange> = synchronized(lock) {
        if (hasBaseline) CanDiff.diff(baseline, lastRun) else emptyList()
    }
    fun aggregates(): List<CanFrame.Aggregate> = synchronized(lock) { result.aggregates() }
    fun rawFrames(): List<CanFrame.RawFrame> = synchronized(lock) { result.rawFrames() }
    fun aggregateCsv(): String = synchronized(lock) { result.aggregateCsv() }
    fun rawCsv(): String = synchronized(lock) { result.rawCsv() }
    /** 清显示结果不清最后有效对照；忙时不能换累加器或解锁状态。 */
    fun reset(): Boolean = synchronized(lock) {
        if (busy) return false
        result = CanFrame.Accumulator()
        publish(runtime, Status(Phase.IDLE))
        true
    }
}
