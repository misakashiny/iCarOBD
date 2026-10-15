package com.icar.obd.data

/** 按真实运行状态控制操作，不用按钮旧文字判断模式。 */
object CanProbeUiState {
    data class Actions(val canStart: Boolean, val canStop: Boolean, val editSettings: Boolean,
        val clear: Boolean, val export: Boolean, val compare: Boolean, val monitor: Boolean)
    fun actions(phase: CanSnifferText.Phase, busy: Boolean, monitorActive: Boolean, monitorRunning: Boolean,
        connected: Boolean, filterValid: Boolean, hasFrames: Boolean, hasBaseline: Boolean,
        initializing: Boolean = false): Actions {
        val idle = !busy && !monitorActive && !initializing
        return Actions(idle && connected && filterValid,
            busy && phase in listOf(CanSnifferText.Phase.PREPARING, CanSnifferText.Phase.CAPTURING),
            idle, !busy && hasFrames, !busy && hasFrames, !busy && hasBaseline,
            !busy && !initializing && (monitorRunning || (!monitorActive && connected)))
    }
}
