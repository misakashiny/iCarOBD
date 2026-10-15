package com.icar.obd.ui.view

import com.icar.obd.data.BuiltInPids
import com.icar.obd.data.DesignFile
import com.icar.obd.data.DesignNode
import com.icar.obd.data.GaugePart
import com.icar.obd.data.PidValue
import com.icar.obd.obd.VehicleBus
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

/** Uses the actual browser factory export, checked byte-for-byte by verify-data-bindings.js. */
class NewControlDataBindingTest {
    @Before fun setUp() = VehicleBus.clear()
    @After fun tearDown() = VehicleBus.clear()

    private fun fixture(): String {
        val relative = "tools/icarui/tests/fixtures/next-bound-design.json"
        val file = listOf(File(relative), File("../$relative"), File("../../$relative"))
            .firstOrNull { it.isFile } ?: error("Missing production export fixture: $relative")
        return file.readText()
    }

    private fun parse(text: String): DesignFile {
        val result = DesignFile.parse(text)
        assertTrue("App parser errors: ${result.errors}", result.errors.isEmpty())
        return requireNotNull(result.design)
    }

    private fun put(id: String, value: Float, ok: Boolean = true, stale: Boolean = false) {
        VehicleBus.put(PidValue(id, value, "binding-test", System.currentTimeMillis() - if (stale) 5000 else 0, ok, ttlMs = 1000))
    }

    @Test fun `all fifteen factory exports resolve to enabled real data sources`() {
        val design = parse(fixture())
        val ids = listOf("std_0D", "std_0C", "std_05", "std_42", "std_2F")
        val units = listOf("km/h", "rpm", "℃", "V", "%")
        assertEquals(15, design.nodes.size)
        assertEquals(15, design.gauges.size)
        design.nodes.forEachIndexed { index, group ->
            assertEquals(DesignNode.TYPE_GROUP, group.type)
            val gauges = DesignNode.collectGauges(group.children)
            assertEquals(1, gauges.size)
            val item = gauges.single()
            assertEquals(ids[index / 3], item.pidId)
            val definition = BuiltInPids.STANDARD.single { it.id == item.pidId }
            assertTrue(definition.enabled)
            assertEquals(units[index / 3], definition.unit)
            assertEquals(definition.minVal, item.minVal, 0f)
            assertEquals(definition.maxVal, item.maxVal, 0f)
            assertEquals(if (index % 3 == 2) 1 else 0, item.style)
            assertEquals(listOf(item.pidId), item.allPidIds())
        }
    }

    @Test fun `nested new gauges read their own bus values and clear failed or stale sources`() {
        val design = parse(fixture())
        val samples = mapOf("std_0D" to 83f, "std_0C" to 2450f, "std_05" to 92f, "std_42" to 13.8f, "std_2F" to 44f)
        samples.forEach { (id, value) -> put(id, value) }
        design.gauges.forEach { item ->
            val values = item.allPidIds().map { VehicleBus.value(it)?.takeIf { v -> v.isFinite() } }
            assertEquals(samples.getValue(item.pidId), values.single()!!, 0f)
        }
        put("std_42", 13.8f, stale = true)
        put("std_0D", 83f, ok = false)
        assertNull(VehicleBus.value("std_42"))
        assertNull(VehicleBus.value("std_0D"))
        assertEquals(2450f, VehicleBus.value("std_0C")!!, 0f)
        VehicleBus.clear()
        design.gauges.forEach { assertNull(VehicleBus.value(it.pidId)) }
    }

    @Test fun `App save and parse preserves every nested binding`() {
        val design = parse(fixture())
        val again = parse(design.toJson().toString())
        assertEquals(design.gauges.map { it.pidId }, again.gauges.map { it.pidId })
    }

    @Test fun `changed semantic source reaches the App using the changed id`() {
        val json = JSONObject(fixture())
        json.getJSONArray("nodes").getJSONObject(0).getJSONArray("children").getJSONObject(1).put("pid", "obd.voltage")
        val item = parse(json.toString()).gauges.first()
        assertEquals("std_42", item.pidId)
        put("std_0D", 88f); put("std_42", 13.8f)
        assertEquals(13.8f, VehicleBus.value(item.pidId)!!, 0f)
    }

    @Test fun `part snapshots include sources inside nested parts`() {
        val parts = listOf(GaugePart(kind = GaugePart.KIND_DECOR, children = listOf(
            GaugePart(kind = GaugePart.KIND_NEEDLE, pid = "std_0D"),
            GaugePart(kind = GaugePart.KIND_DECOR, children = listOf(GaugePart(kind = GaugePart.KIND_VALUE, pid = "std_42")))
        )))
        assertEquals(setOf("std_0C", "std_0D", "std_42"), GaugePartValues("std_0C", parts).neededPids)
    }

    @Test fun `complete snapshots remove disappeared sources instead of keeping last values`() {
        val primary = GaugePart(kind = GaugePart.KIND_VALUE)
        val other = GaugePart(kind = GaugePart.KIND_VALUE, pid = "std_42")
        val state = GaugePartValues("std_0D", listOf(primary, other))
        assertNull(state.valueOf(primary))
        assertTrue(state.replace(mapOf("std_0D" to 88f, "std_42" to 13.8f)))
        assertEquals(88f, state.valueOf(primary)!!, 0f)
        assertEquals(13.8f, state.valueOf(other)!!, 0f)
        assertTrue(state.replace(mapOf("std_0D" to 0f)))
        assertEquals("0", GaugePartValues.format(state.valueOf(primary)))
        assertEquals("--", GaugePartValues.format(state.valueOf(other)))
        assertTrue(state.replace(emptyMap()))
        assertEquals("--", GaugePartValues.format(state.valueOf(primary)))
        assertFalse(state.replace(emptyMap()))
    }

    @Test fun `stale bus snapshot actually clears the composed value state and recovery works`() {
        val part = GaugePart(kind = GaugePart.KIND_VALUE, pid = "std_42")
        val state = GaugePartValues("std_0C", listOf(part))
        fun push() { state.replace(state.neededPids.mapNotNull { id -> VehicleBus.value(id)?.let { id to it } }.toMap()) }
        put("std_42", 13.8f); push()
        assertEquals("13.8", GaugePartValues.format(state.valueOf(part)))
        put("std_42", 13.8f, stale = true); push()
        assertEquals("--", GaugePartValues.format(state.valueOf(part)))
        put("std_42", 14.1f); push()
        assertEquals("14.1", GaugePartValues.format(state.valueOf(part)))
    }

    @Test fun `invalid or unrelated samples cannot revive a composed readout`() {
        val part = GaugePart(kind = GaugePart.KIND_VALUE)
        val state = GaugePartValues("std_42", listOf(part))
        state.replace(mapOf("std_42" to 13.8f))
        for (value in listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY)) {
            state.replace(mapOf("std_42" to value, "std_0D" to 88f))
            assertNull(state.valueOf(part))
            assertEquals("--", GaugePartValues.format(value))
        }
    }
}
