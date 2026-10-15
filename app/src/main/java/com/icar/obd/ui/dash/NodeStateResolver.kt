package com.icar.obd.ui.dash

import com.icar.obd.data.DesignNode
import com.icar.obd.data.NodeState
import com.icar.obd.data.PidDefinition

/** Image state selection and tick phase, shared by the renderer and JVM regressions. */
internal object NodeStateResolver {
    const val UNKNOWN_TEXT = "--"

    fun unknownDescription(name: String) = "$name 数据未知"
    data class Frame(val state: NodeState?, val unknown: Boolean, val alpha: Float) {
        fun apply(onUnknown: () -> Unit, onKnown: (NodeState?, Float) -> Unit) {
            if (unknown) onUnknown() else onKnown(state, alpha)
        }
    }

    fun resolve(
        node: DesignNode, states: Map<String, NodeState>, valueOf: (String) -> Float?,
        definitionOf: (String) -> PidDefinition?, nowMs: Long
    ): Frame {
        val value = if (node.statePid.isBlank()) null else valueOf(node.statePid)
        if (node.statePid.isNotBlank() && (value == null || !value.isFinite())) {
            return Frame(null, true, 1f)
        }
        val state = select(node, states, value, definitionOf)
        val period = state?.blinkMs?.coerceAtLeast(NodeState.MIN_BLINK_MS)?.toLong() ?: 1L
        val on = state?.blink != true || (nowMs / period) % 2L == 0L
        return Frame(state, false, if (on) ((state?.alpha ?: node.alpha) / 255f).coerceIn(0f, 1f) else 0f)
    }

    private fun select(
        node: DesignNode, states: Map<String, NodeState>, value: Float?,
        definitionOf: (String) -> PidDefinition?
    ): NodeState? {
        val pid = node.statePid
        if (pid.isBlank()) return states[NodeState.STATE_NORMAL]
        if (value == null) return states[NodeState.STATE_NORMAL]
        val def = definitionOf(pid)
        val warnAt = node.stateWarn ?: def?.warnHigh ?: return states[NodeState.STATE_NORMAL]
        val max = def?.maxVal ?: 100f
        val criticalAt = node.stateCritical ?: if (max > warnAt) warnAt + (max - warnAt) * 0.5f else null
        return when {
            criticalAt != null && value >= criticalAt -> states[NodeState.STATE_CRITICAL]
                ?: states[NodeState.STATE_WARN] ?: states[NodeState.STATE_NORMAL]
            value >= warnAt -> states[NodeState.STATE_WARN] ?: states[NodeState.STATE_NORMAL]
            else -> states[NodeState.STATE_NORMAL]
        }
    }
}
