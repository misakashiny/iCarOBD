package com.icar.obd.data
import com.icar.obd.obd.CanFrame

/** 终态记录独立于Activity，退出或旋转不会提前留一份未完成结果。 */
object CanProbeRecord {
    fun decode(aggregates: List<CanFrame.Aggregate>, pids: List<PidDefinition>): String {
        val index = SignalDecode.indexByHeader(pids)
        val bound = aggregates.filter { index.containsKey(it.canId) }
        if (bound.isEmpty()) return ""
        return buildString {
            append("\n\n=== 解码（监听型PID）===\n")
            bound.forEach { a ->
                append("0x%03X → ".format(a.canId))
                append(index.getValue(a.canId).joinToString(" / ") {
                    SignalDecode.decode(SignalDecode.parseHexData(a.lastData), it).text()
                }); append('\n')
                if (a.values.size >= 2) append("    观察到的取值: ").append(a.values.joinToString(" | ")).append('\n')
            }
            append("（未绑定ID只显示原始hex，不猜值；候选须继续验证）\n")
        }
    }
}
