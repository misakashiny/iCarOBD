package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.Store

/** Queue/clock/config seam; post always queues, never runs the task inline. */
internal interface SignalSimulatorRuntime {
    fun now(): Long
    fun pids(): List<PidDefinition>
    fun post(task: Runnable,delayMs: Long=0)
    fun remove(task: Runnable)
}
internal class AndroidSignalSimulatorRuntime: SignalSimulatorRuntime {
    private val main by lazy { Handler(Looper.getMainLooper()) }
    override fun now()=System.currentTimeMillis()
    override fun pids()=Store.allPids()
    override fun post(task: Runnable,delayMs: Long) { main.postDelayed(task,delayMs) }
    override fun remove(task: Runnable) { main.removeCallbacks(task) }
}
