package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import com.icar.obd.ble.ObdTransport

/** 探测的窄环境接口；测试执行同一生产流程，不连接 Android/蓝牙。 */
internal interface CanSnifferRuntime {
    fun capture(): CanSnifferRuntime = this
    val scope: CoroutineScope
    val connected: Boolean
    val kind: String
    val monitorBusy: Boolean
    val engineRunning: Boolean
    var rawMode: Boolean
    var receiver: ((String) -> Unit)?
    fun send(text: String)
    suspend fun raw(command: String, timeoutMs: Long): String
    suspend fun reinitialize(startPolling: Boolean = true): Boolean
    fun startPolling()
    fun stopPolling()
    fun post(task: Runnable, delayMs: Long = 0L)
    fun remove(task: Runnable)
    fun now(): Long
    suspend fun wait(ms: Long)
    fun completed(status: CanSniffer.Status, aggregates: List<CanFrame.Aggregate>, csv: String) {}
}

internal class AndroidCanSnifferRuntime(
    private val pinnedTransport: ObdTransport? = null,
    private val pinnedSession: ElmSession? = null,
    private val pinnedEngine: ObdEngine? = null,
    override val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
) : CanSnifferRuntime {
    private val main by lazy { Handler(Looper.getMainLooper()) }
    private val transport get() = pinnedTransport ?: ObdController.transport
    private val session get() = pinnedSession ?: ObdController.session
    private val engine get() = pinnedEngine ?: ObdController.engine
    private var installedReceiver: ((String) -> Unit)? = null
    override fun capture() = AndroidCanSnifferRuntime(transport, session, engine, scope)
    override val connected get() = transport === ObdController.transport && transport.state == ObdTransport.State.READY
    override val kind get() = transport.kind
    override val monitorBusy get() = FrameMonitor.active
    override val engineRunning get() = engine.running
    override var rawMode: Boolean
        get() = transport.rawMode
        set(value) { transport.rawMode = value }
    override var receiver: ((String) -> Unit)?
        get() = installedReceiver
        set(value) {
            if (value == null) {
                if (ObdController.rawChunkListener === installedReceiver) ObdController.rawChunkListener = null
                installedReceiver = null
            } else if (transport === ObdController.transport) {
                installedReceiver = value
                ObdController.rawChunkListener = value
            }
        }
    override fun send(text: String) = transport.send(text)
    override suspend fun raw(command: String, timeoutMs: Long): String {
        check(connected) { "适配器已断开或连接已更换" }
        return session.raw(command, timeoutMs)
    }
    override suspend fun reinitialize(startPolling: Boolean): Boolean {
        check(connected) { "适配器已断开或连接已更换" }
        return ObdController.initializeAndStart(startPolling = startPolling).ok && connected
    }
    override fun startPolling() { if (connected) ObdController.startPolling() }
    override fun stopPolling() = engine.stop()
    override fun post(task: Runnable, delayMs: Long) { main.postDelayed(task, delayMs) }
    override fun remove(task: Runnable) { main.removeCallbacks(task) }
    override fun now() = System.currentTimeMillis()
    override suspend fun wait(ms: Long) = delay(ms)
    override fun completed(status: CanSniffer.Status, aggregates: List<CanFrame.Aggregate>, csv: String) {
        main.post {
            runCatching {
                com.icar.obd.data.ProbeLog.add(com.icar.obd.data.ProbeLog.KIND_CAN,
            "过滤器 ${status.filter.ifBlank { "不过滤" }} · ${status.message} · ${status.frameCount}帧/${status.idCount}ID",
            csv + com.icar.obd.data.CanProbeRecord.decode(aggregates, com.icar.obd.data.Store.allPids()))
            }.onFailure { com.icar.obd.data.AppLog.e(com.icar.obd.data.AppLog.M_OBD, "探测记录保存失败", it.message ?: "") }
        }
    }
}
