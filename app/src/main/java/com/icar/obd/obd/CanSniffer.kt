package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import com.icar.obd.data.AppLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * CAN 总线**被动探测**（`ATMA`）。
 *
 * ## 为什么需要它
 *
 * 标准 OBD 只暴露「ECU 愿意回答的 PID」。转向灯、车门、刹车灯这类信号是
 * **模块之间的广播帧**，没有对应的 PID —— 只能靠监听总线找。这是找它们的唯一办法。
 *
 * ## 与 PID 扫描器的分工
 *
 * | | 主动/被动 | 能看到什么 |
 * |---|---|---|
 * | `PidScanner` | 主动请求 `01 0C` | ECU 愿意回答的 PID |
 * | `CanSniffer` | 被动监听 `ATMA` | 总线上**全部**帧，含广播 |
 *
 * ## 防洪水（针对 v1.3.0 那次 113 万行 / 57.9MB）
 *
 * 1. **限时**：默认 10 秒硬上限，到点自动停（[DEFAULT_DURATION_MS]，可调 3~60 秒）
 * 2. **限速**：`CanFrame.Accumulator` 只记录**变化了的**数据，重复帧只累加计数
 * 3. **限条**：原始流有界（5000 条），超出丢最旧并计数
 * 4. **不逐帧写日志**：只写汇总 —— 这是当初那场事故的直接成因
 * 5. **行缓冲有上限**：没有 `\r` 的输出不会把内存撑爆
 *
 * ## 操作顺序（顺序错了会超时）
 *
 * ```text
 * 停轮询 → ATH1（**必须在开透传之前发**）→ 开透传 → ATMA（不等响应）
 *        → 采集 N 秒 → 发任意字符停 ATMA → 关透传 → ATH0 → 恢复轮询
 * ```
 *
 * `ATH1` 必须在前：一旦开了透传，它的响应也会走 `onRawChunk`，
 * `session.raw()` 就等不到 `>` 了，必然超时。
 */
object CanSniffer {

    enum class Phase { IDLE, PREPARING, CAPTURING, FINISHING, DONE, FAILED }

    data class Status(
        val phase: Phase,
        val elapsedMs: Long = 0L,
        val frameCount: Int = 0,
        val idCount: Int = 0,
        val dropped: Int = 0,
        val message: String = ""
    )

    const val DEFAULT_DURATION_MS = 10_000L
    const val MIN_DURATION_MS = 3_000L
    const val MAX_DURATION_MS = 60_000L

    /** 普通 AT 命令的超时。`ATMA` 本身不等响应，用不到它 */
    private const val CMD_TIMEOUT = 2500L
    private const val UI_TICK_MS = 500L
    /** 行缓冲上限：万一输出里长时间没有换行，不能让它无限涨 */
    private const val LINE_BUF_MAX = 8192

    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** 收发命令要走 `session.raw()`（suspend），所以用协程而不是裸 Thread */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    var onUpdate: ((Status) -> Unit)? = null

    var status: Status = Status(Phase.IDLE)
        private set

    private var acc = CanFrame.Accumulator()
    private var startedAt = 0L
    private var durationMs = DEFAULT_DURATION_MS
    private var engineWasRunning = false
    private val lineBuf = StringBuilder()

    val running: Boolean
        get() = status.phase == Phase.PREPARING || status.phase == Phase.CAPTURING

    private val uiTicker = object : Runnable {
        override fun run() {
            if (status.phase != Phase.CAPTURING) return
            publish(
                status.copy(
                    elapsedMs = System.currentTimeMillis() - startedAt,
                    frameCount = acc.frameCount(),
                    idCount = acc.aggregates().size,
                    dropped = acc.dropped
                )
            )
            main.postDelayed(this, UI_TICK_MS)
        }
    }

    private val autoStop = Runnable { finish("到时自动停止") }

    private fun publish(s: Status) {
        status = s
        onUpdate?.invoke(s)
    }

    // ================================================================ 开始

    fun start(duration: Long = DEFAULT_DURATION_MS) {
        if (running) return
        if (!ObdController.isConnected()) {
            publish(Status(Phase.FAILED, message = "设备未就绪，请先到「连接」页完成初始化"))
            return
        }
        durationMs = duration.coerceIn(MIN_DURATION_MS, MAX_DURATION_MS)
        acc = CanFrame.Accumulator()
        lineBuf.setLength(0)

        // 1) 停轮询：探测期间自己发的请求会污染观测结果
        engineWasRunning = ObdController.engine.running
        if (engineWasRunning) ObdController.engine.stop()

        publish(Status(Phase.PREPARING, message = "正在切到监听模式…"))
        AppLog.i(
            AppLog.M_OBD, "CAN 探测开始",
            "duration=${durationMs}ms kind=${ObdController.transport.kind}"
        )

        scope.launch {
            runCatching {
                // 2) ATH1 才能看到帧来自哪个模块。**必须在开透传之前发**
                ObdController.session.raw("ATH1", CMD_TIMEOUT)
            }.onFailure {
                main.post { finish("启动失败：${it.message}") }
                return@launch
            }

            // 3) 开透传，再发 ATMA —— 它是持续流，不能等响应
            ObdController.rawChunkListener = { chunk -> onChunk(chunk) }
            ObdController.transport.rawMode = true
            runCatching { ObdController.transport.send("ATMA\r") }

            startedAt = System.currentTimeMillis()
            main.post {
                publish(Status(Phase.CAPTURING, message = "监听中…"))
                main.postDelayed(uiTicker, UI_TICK_MS)
                main.postDelayed(autoStop, durationMs)
            }
        }
    }

    fun stop() {
        if (running) finish("手动停止")
    }

    // ================================================================ 收数据

    private fun onChunk(chunk: String) {
        if (status.phase != Phase.CAPTURING && status.phase != Phase.PREPARING) return
        synchronized(lineBuf) {
            lineBuf.append(chunk)
            var cut = indexOfBreak()
            while (cut >= 0) {
                val line = lineBuf.substring(0, cut)
                lineBuf.delete(0, cut + 1)
                if (line.isNotBlank()) {
                    acc.feedLine(line.trim(), System.currentTimeMillis())
                }
                cut = indexOfBreak()
            }
            if (lineBuf.length > LINE_BUF_MAX) lineBuf.setLength(0)
        }
    }

    private fun indexOfBreak(): Int {
        for (i in lineBuf.indices) {
            val c = lineBuf[i]
            if (c == '\r' || c == '\n') return i
        }
        return -1
    }

    // ================================================================ 收尾

    private fun finish(reason: String) {
        main.removeCallbacks(uiTicker)
        main.removeCallbacks(autoStop)
        publish(status.copy(phase = Phase.FINISHING, message = "正在收尾…"))

        scope.launch {
            // 4) 停 ATMA：向适配器发任意字符即可中断监听
            runCatching { ObdController.transport.send("\r") }
            delay(200)
            ObdController.transport.rawMode = false
            ObdController.rawChunkListener = null
            runCatching { ObdController.session.raw("ATH0", CMD_TIMEOUT) }

            // 5) 恢复轮询
            if (engineWasRunning) ObdController.engine.start()

            val frames = acc.frameCount()
            val ids = acc.aggregates().size
            main.post {
                publish(
                    Status(
                        Phase.DONE,
                        elapsedMs = System.currentTimeMillis() - startedAt,
                        frameCount = frames,
                        idCount = ids,
                        dropped = acc.dropped,
                        message = "$reason · 共 $frames 帧 / $ids 个 ID"
                    )
                )
            }
            // 只写汇总，**绝不逐帧写日志**
            AppLog.i(
                AppLog.M_OBD, "CAN 探测结束",
                "frames=$frames ids=$ids dropped=${acc.dropped} reason=$reason"
            )
        }
    }

    // ================================================================ 结果

    fun aggregates(): List<CanFrame.Aggregate> = acc.aggregates()

    fun rawFrames(): List<CanFrame.RawFrame> = acc.rawFrames()

    /** 聚合 CSV：一眼看出哪些 ID 在周期性广播 */
    fun aggregateCsv(): String = acc.aggregateCsv()

    /** 原始帧 CSV：信息全，文件大得多 */
    fun rawCsv(): String = acc.rawCsv()

    /** 清空上次结果（不清就一直是上一轮的数据） */
    fun reset() {
        acc = CanFrame.Accumulator()
        publish(Status(Phase.IDLE))
    }
}
