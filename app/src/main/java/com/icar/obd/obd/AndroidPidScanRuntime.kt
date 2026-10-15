package com.icar.obd.obd

import com.icar.obd.ble.ObdTransport
import com.icar.obd.data.ProbeLog

internal class AndroidPidScanRuntime(private val pinnedTransport: ObdTransport?=null,
    private val pinnedSession: ElmSession?=null, private val pinnedEngine: ObdEngine?=null): PidScanRuntime {
    private val transport get()=pinnedTransport ?: ObdController.transport
    override val session get()=pinnedSession ?: ObdController.session
    private val engine get()=pinnedEngine ?: ObdController.engine
    override fun capture()=AndroidPidScanRuntime(transport,session,engine)
    override val connected get()=transport === ObdController.transport && transport.state==ObdTransport.State.READY
    override val otherBusy get()=CanSniffer.busy || FrameMonitor.active
    override val engineRunning get()=engine.running
    override val previousHeader get()=engine.requestHeader
    override suspend fun raw(command: String,timeoutMs: Long): String {
        check(connected) { "适配器已断开或连接已更换" }
        return session.raw(command,timeoutMs)
    }
    override fun stopPolling()=engine.stop()
    override fun startPolling() { if(connected) ObdController.startPolling() }
    override fun completed(snapshot: PidScanRun.Snapshot) {
        runCatching { ProbeLog.add(ProbeLog.KIND_PID,"Mode ${snapshot.cfg?.mode} ${snapshot.message} · ${snapshot.hits.size}条",
            PidScanner.report(snapshot.cfg,snapshot.hits,listOf(snapshot.message),java.util.Date().toString(),snapshot.summary)) }
    }
}
