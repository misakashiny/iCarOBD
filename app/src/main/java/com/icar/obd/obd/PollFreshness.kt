package com.icar.obd.obd

import com.icar.obd.data.PidDefinition

/** 只用于轮询运行时，不改变 DTO/旧来源 ttl=0 的兼容语义。 */
internal object PollFreshness {
    fun interval(pid: PidDefinition, globalMs: Int, backoff: Float): Long {
        val base = if (pid.intervalMs > 0) pid.intervalMs.toDouble()
            else globalMs.toDouble() * PidDefinition.priorityScale(pid.priority)
        val factor = if (backoff.isFinite() && backoff >= 1f) backoff.toDouble() else 1.0
        return (base * factor).coerceIn(30.0, Int.MAX_VALUE.toDouble()).toLong()
    }

    fun ttl(configuredMs: Int, intervalMs: Long): Int {
        if (configuredMs > 0) return configuredMs
        // 先夹到 Int 上界再乘，任何 Long 输入都不会溢出或变成无限 TTL。
        return (intervalMs.coerceIn(0L, Int.MAX_VALUE.toLong()) * 3L)
            .coerceIn(2000L, Int.MAX_VALUE.toLong()).toInt()
    }
}
