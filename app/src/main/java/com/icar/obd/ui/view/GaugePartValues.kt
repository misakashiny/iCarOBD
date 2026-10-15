package com.icar.obd.ui.view

import com.icar.obd.data.GaugePart
import java.util.Locale

/** Current snapshot for composed gauges. The renderer supplies values; no bus access here. */
class GaugePartValues(private val primaryId: String, parts: List<GaugePart>) {
    val neededPids: Set<String> = buildSet {
        if (primaryId.isNotBlank()) add(primaryId)
        fun collect(list: List<GaugePart>) {
            list.forEach { p ->
                if (p.pid.isNotBlank()) add(p.pid)
                collect(p.children)
            }
        }
        collect(parts)
    }

    private var values: Map<String, Float> = emptyMap()

    /** Replace the whole snapshot, including an empty one when all sources are unavailable. */
    fun replace(current: Map<String, Float>): Boolean {
        val next = current.filter { (id, value) -> id in neededPids && value.isFinite() }
        if (values == next) return false
        values = next
        return true
    }

    fun valueOf(part: GaugePart): Float? = values[part.pid.ifBlank { primaryId }]

    companion object {
        fun format(value: Float?): String = when {
            value == null || !value.isFinite() -> "--"
            value == value.toInt().toFloat() -> value.toInt().toString()
            else -> String.format(Locale.US, "%.1f", value)
        }
    }
}
