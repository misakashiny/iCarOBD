package com.icar.obd.ui.dash

import com.icar.obd.data.DesignNode
import com.icar.obd.data.NodeState
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.obd.VehicleBus
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class NodeStateResolverTest {
    private val normal = NodeState("normal", alpha = 180)
    private val warn = NodeState("warn", blink = true, blinkMs = 60)
    private val critical = NodeState("critical", blink = true, blinkMs = 800)
    private val states = mapOf("normal" to normal, "warn" to warn, "critical" to critical)
    private val node = DesignNode("lamp", "image", "Lamp", 0f, 0f, 30f, 30f,
        statePid = "signal", stateWarn = 50f, stateCritical = 80f)

    @After fun cleanBus() = VehicleBus.clear()

    private fun frame(
        value: Float?, node: DesignNode = this.node, skins: Map<String, NodeState> = states,
        def: PidDefinition? = null, now: Long = 0
    ) = NodeStateResolver.resolve(node, skins, { value }, { def }, now)

    private fun unknown(result: NodeStateResolver.Frame) {
        assertTrue("Bound unavailable data must not select a safe skin", result.unknown)
        assertNull(result.state)
        assertEquals(1f, result.alpha, 0f)
    }

    @Test fun `missing bound value is unknown`() = unknown(frame(null))
    @Test fun `NaN is unknown`() = unknown(frame(Float.NaN))
    @Test fun `infinite values are unknown`() {
        unknown(frame(Float.POSITIVE_INFINITY)); unknown(frame(Float.NEGATIVE_INFINITY))
    }

    @Test fun `failed bus reading enters production resolver as unknown`() {
        VehicleBus.put(PidValue("signal", 0f, "T", System.currentTimeMillis(), false))
        unknown(NodeStateResolver.resolve(node, states, VehicleBus::value, { null }, 0))
    }

    @Test fun `expired bus reading enters production resolver as unknown`() {
        VehicleBus.put(PidValue("signal", 0f, "T", System.currentTimeMillis(), true, ttlMs = 1000))
        assertSame(normal, NodeStateResolver.resolve(node, states, VehicleBus::value, { null }, 0).state)
        VehicleBus.put(PidValue("signal", 0f, "T", System.currentTimeMillis() - 5000, true, ttlMs = 1000))
        unknown(NodeStateResolver.resolve(node, states, VehicleBus::value, { null }, 0))
        VehicleBus.put(PidValue("signal", 90f, "T", System.currentTimeMillis(), true, ttlMs = 1000))
        assertSame(critical, NodeStateResolver.resolve(node, states, VehicleBus::value, { null }, 0).state)
    }

    @Test fun `no binding is static and never queries a value or definition`() {
        val result = NodeStateResolver.resolve(node.copy(statePid = ""), states,
            { error("Static image must not read data") }, { error("Static image must not read PID library") }, 0)
        assertFalse(result.unknown); assertSame(normal, result.state)
    }

    @Test fun `normal valid value uses normal skin`() {
        assertSame(normal, frame(49f).state); assertFalse(frame(49f).unknown)
    }

    @Test fun `warning boundary is inclusive`() {
        assertSame(warn, frame(50f).state); assertSame(warn, frame(79f).state)
    }

    @Test fun `critical boundary takes priority`() {
        assertSame(critical, frame(80f).state); assertSame(critical, frame(100f).state)
    }

    @Test fun `explicit thresholds override library`() {
        val def = PidDefinition(id = "signal", warnHigh = 10f, maxVal = 30f)
        assertSame(normal, frame(20f, def = def).state)
        assertSame(warn, frame(60f, def = def).state)
        assertSame(critical, frame(90f, def = def).state)
    }

    @Test fun `library warning and midpoint critical remain supported`() {
        val n = node.copy(stateWarn = null, stateCritical = null)
        val def = PidDefinition(id = "signal", warnHigh = 40f, maxVal = 100f)
        assertSame(normal, frame(39f, n, def = def).state)
        assertSame(warn, frame(40f, n, def = def).state)
        assertSame(critical, frame(70f, n, def = def).state)
    }

    @Test fun `no warning threshold stays normal only with valid data`() {
        val n = node.copy(stateWarn = null, stateCritical = null)
        assertSame(normal, frame(90f, n).state)
        unknown(frame(null, n))
    }

    @Test fun `critical without skin falls back warning then normal`() {
        assertSame(warn, frame(90f, skins = states - "critical").state)
        assertSame(normal, frame(90f, skins = mapOf("normal" to normal)).state)
    }

    @Test fun `missing warning skin falls back normal`() {
        assertSame(normal, frame(60f, skins = states - "warn").state)
    }

    @Test fun `no selected skin is not confused with missing data`() {
        val result = frame(0f, node.copy(alpha = 127), skins = mapOf("warn" to warn))
        assertNull(result.state); assertFalse(result.unknown)
        assertEquals(127 / 255f, result.alpha, 0f)
        unknown(frame(null, skins = emptyMap()))
    }

    @Test fun `minimum blink period remains enforced`() {
        assertEquals(1f, frame(60f, now = 399).alpha, 0f)
        assertEquals(0f, frame(60f, now = 400).alpha, 0f)
        assertEquals(1f, frame(60f, now = 800).alpha, 0f)
    }

    @Test fun `configured longer blink period and alpha clamping remain enforced`() {
        assertEquals(1f, frame(90f, now = 799).alpha, 0f)
        assertEquals(0f, frame(90f, now = 800).alpha, 0f)
        assertEquals(1f, frame(0f, skins = mapOf("normal" to normal.copy(alpha = 400))).alpha, 0f)
        assertEquals(0f, frame(0f, skins = mapOf("normal" to normal.copy(alpha = -1))).alpha, 0f)
    }

    @Test fun `every prior level dispatches unknown and can recover`() {
        for (value in listOf(0f, 60f, 90f)) {
            var shown = ""
            val showUnknown = { shown = "unknown" }
            val showKnown: (NodeState?, Float) -> Unit = { s, _ -> shown = s?.assetId ?: "base" }
            frame(value).apply(showUnknown, showKnown)
            assertEquals(frame(value).state!!.assetId, shown)
            frame(null, now = 400).apply(showUnknown, showKnown)
            assertEquals("Old skin must not survive an unavailable tick", "unknown", shown)
            frame(0f).apply(showUnknown, showKnown)
            assertEquals("normal", shown)
            frame(90f).apply(showUnknown, showKnown)
            assertEquals("critical", shown)
        }
    }

    @Test fun `recovered warning follows current phase not old unknown alpha`() {
        unknown(frame(null, now = 400))
        assertEquals(0f, frame(60f, now = 400).alpha, 0f)
        assertEquals(1f, frame(60f, now = 800).alpha, 0f)
    }

    @Test fun `runtime unknown does not add a shared state name`() {
        assertEquals(listOf("normal", "warn", "critical"), NodeState.NAMES)
    }
}
