package com.icar.obd.obd

import android.os.Handler
import android.os.Looper

/** Narrow runtime boundary for FrameMonitor production lifecycle tests. */
internal interface FrameMonitorRuntime {
    val connected: Boolean
    val engineRunning: Boolean
    var rawMode: Boolean
    var rawChunkListener: ((String) -> Unit)?
    fun send(text: String)
    suspend fun raw(command: String, timeoutMs: Long): String
    suspend fun initializeWithoutPolling(): ElmSession.InitResult?
    fun stopPolling()
    fun startPolling()
    fun runCycleOnce()
    fun toast(message: String)
}

internal interface FrameMonitorScheduler {
    fun post(block: Runnable)
    fun postDelayed(delayMs: Long, block: Runnable)
    fun remove(block: Runnable)
}

internal object AndroidFrameMonitorRuntime : FrameMonitorRuntime {
    override val connected: Boolean get() = ObdController.isConnected()
    override val engineRunning: Boolean get() = ObdController.engine.running
    override var rawMode: Boolean
        get() = ObdController.transport.rawMode
        set(value) { ObdController.transport.rawMode = value }
    override var rawChunkListener: ((String) -> Unit)?
        get() = ObdController.rawChunkListener
        set(value) { ObdController.rawChunkListener = value }
    override fun send(text: String) { ObdController.transport.send(text) }
    override suspend fun raw(command: String, timeoutMs: Long): String = ObdController.session.raw(command, timeoutMs)
    override suspend fun initializeWithoutPolling(): ElmSession.InitResult =
        ObdController.initializeAndStart(startPolling = false)
    override fun stopPolling() { ObdController.engine.stop() }
    override fun startPolling() { ObdController.startPolling() }
    override fun runCycleOnce() { ObdController.runCycleOnce() }
    override fun toast(message: String) { ObdController.toast(message) }
}

internal class AndroidFrameMonitorScheduler : FrameMonitorScheduler {
    private val handler = Handler(Looper.getMainLooper())
    override fun post(block: Runnable) { handler.post(block) }
    override fun postDelayed(delayMs: Long, block: Runnable) { handler.postDelayed(block, delayMs) }
    override fun remove(block: Runnable) { handler.removeCallbacks(block) }
}
