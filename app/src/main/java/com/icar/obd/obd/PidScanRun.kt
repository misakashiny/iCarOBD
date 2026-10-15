package com.icar.obd.obd

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** One production owner survives activity rotation; its lease includes header restoration. */
internal class PidScanRun(private val runtime: PidScanRuntime,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob()+Dispatchers.IO)) {
    data class Snapshot(val busy: Boolean=false, val message: String="待开始",
        val cfg: PidScanner.Config?=null, val summary: PidScanner.Summary=PidScanner.Summary(PidScanner.State.READY),
        val hits: List<PidScanner.Hit> = emptyList())
    private val mutable=MutableStateFlow(Snapshot())
    val state: StateFlow<Snapshot> = mutable
    private class Run(val io: PidScanRuntime,val token: Any,val cfg: PidScanner.Config,
        val restorePolling: Boolean,val previousHeader: String) {
        lateinit var job: Job
        val scanner=PidScanner(io.session) { check(io.connected) { "适配器已断开或连接已更换" } }
        @Volatile var entered=false
    }
    @Volatile private var active: Run?=null
    fun start(cfg: PidScanner.Config) = synchronized(CanAdapterGate.lock) {
        PidScanner.validate(cfg)
        check(active==null) { "探测尚未收尾" }
        val io=runtime.capture()
        check(io.connected) { "适配器未连接，请先到连接页初始化" }
        val token=CanAdapterGate.beginPidScan { io.otherBusy } ?: error("适配器正在初始化、采集或监听，请等它结束")
        val restorePolling=io.engineRunning
        val run=try {
            if(restorePolling) io.stopPolling()
            Run(io,token,cfg,restorePolling,io.previousHeader)
        } catch(e: Exception) { CanAdapterGate.endPidScan(token); throw e }
        active=run
        mutable.value=Snapshot(true,"准备探测",cfg,PidScanner.Summary(PidScanner.State.SCANNING))
        run.job=scope.launch(start=CoroutineStart.LAZY) { run.entered=true; execute(run) }
        run.job.invokeOnCompletion { if(!run.entered) scope.launch(NonCancellable) { finish(run,"已停止",false) } }
        run.job.start()
    }
    fun stop() = synchronized(CanAdapterGate.lock) { active?.job?.cancel() }
    private suspend fun execute(run: Run) {
        var message="完成"
        var headerTouched=false
        try {
            currentCoroutineContext().ensureActive()
            check(run.io.connected) { "适配器已断开或连接已更换" }
            headerTouched=true // even a timeout may already have applied the sticky header
            check(ok(run.io.raw("ATSH "+run.cfg.header.trim().uppercase(),2000))) { "ECU请求头没有确认，探测未继续" }
            run.scanner.scan(run.cfg) { _,_,hit ->
                currentCoroutineContext().ensureActive()
                check(run.io.connected) { "适配器已断开或连接已更换" }
                val old=mutable.value
                val hits=if(hit==null) old.hits else old.hits.filterNot { it.mode==hit.mode && it.pid==hit.pid }+hit
                mutable.value=old.copy(message="正在探测",summary=run.scanner.summary,hits=hits)
            }
            message=when {
                run.scanner.summary.state==PidScanner.State.LIMIT -> "达到请求上限"
                run.scanner.summary.unknownBlocks>0 -> "完成，部分位图未探明"
                else -> "完成"
            }
        } catch (_: CancellationException) { message="已停止" }
        catch(e: Exception) { message="失败："+(e.message ?: "未知错误") }
        finally { withContext(NonCancellable) { finish(run,message,headerTouched) } }
    }
    private suspend fun finish(run: Run, original: String, touched: Boolean) {
        if(active !== run) return
        mutable.value=mutable.value.copy(message="正在收尾")
        var message=original
        var restored=true
        if(touched) {
            restored=run.io.connected && runCatching {
                withTimeout(2500) { ok(run.io.raw("ATSH "+if(run.restorePolling) ObdProtocol.DEFAULT_HEADER else run.previousHeader,2000)) }
            }.getOrDefault(false)
            if(!restored) message+="；请求头恢复未确认，轮询未恢复"
        }
        val s=run.scanner.summary
        val terminal=when {
            message.startsWith("失败") || !restored -> PidScanner.State.FAILED
            original=="已停止" -> PidScanner.State.STOPPED
            else -> s.state
        }
        var finished=mutable.value.copy(busy=false,message=message,summary=s.copy(state=terminal))
        synchronized(CanAdapterGate.lock) {
            if(active===run) {
                active=null; CanAdapterGate.endPidScan(run.token)
                if(run.restorePolling && restored && run.io.connected) {
                    runCatching { run.io.startPolling() }.onFailure { error ->
                        // Release/publish even when restarting the engine/CSV throws.
                        runCatching { run.io.stopPolling() }
                        finished=finished.copy(message=message+"；轮询恢复异常："+error.message,
                            summary=finished.summary.copy(state=PidScanner.State.FAILED))
                    }
                }
                mutable.value=finished
            }
        }
        run.io.completed(finished)
    }
    private fun ok(raw: String)=raw.split('\r','\n','>').any { it.trim().equals("OK",true) }
}

internal interface PidScanRuntime {
    fun capture(): PidScanRuntime=this
    val session: ElmSession
    val connected: Boolean
    val otherBusy: Boolean
    val engineRunning: Boolean
    val previousHeader: String
    suspend fun raw(command: String,timeoutMs: Long): String
    fun stopPolling()
    fun startPolling()
    fun completed(snapshot: PidScanRun.Snapshot) {}
}
