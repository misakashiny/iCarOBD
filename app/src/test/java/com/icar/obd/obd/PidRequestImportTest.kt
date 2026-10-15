package com.icar.obd.obd

import com.icar.obd.data.*
import org.junit.*
import org.junit.Rule as JUnitRule
import org.junit.Assert.*
import org.junit.rules.TemporaryFolder

class PidRequestImportTest {
    @get:JUnitRule val temporary = TemporaryFolder()
    private lateinit var settings: Store.Settings
    private lateinit var pids: List<PidDefinition>
    private lateinit var gauges: List<GaugeItem>
    private lateinit var rules: List<com.icar.obd.data.Rule>
    private lateinit var themes: List<String>
    private lateinit var enabled: Map<String, Boolean>
    private lateinit var builtInEnabled: List<Pair<PidDefinition, Boolean>>
    private val directoryField = Store::class.java.getDeclaredField("dir").apply { isAccessible = true }
    private var previousDirectory: Any? = null

    @Before fun setup() {
        previousDirectory = directoryField.get(Store)
        settings = Store.settings; pids = Store.customPids.toList()
        gauges = Store.customGauges.toList(); rules = Store.rules.toList()
        themes = Store.customThemeJson.toList(); enabled = Store.enabledOverride.toMap()
        builtInEnabled = BuiltInPids.all().map { it to it.enabled }
        Store.init(temporary.root)
        BuiltInPids.all().forEach { Store.enabledOverride[it.id] = false }
        VehicleBus.clear()
    }

    @After fun restore() {
        Store.settings = settings
        Store.customPids.clear(); Store.customPids.addAll(pids)
        Store.customGauges.clear(); Store.customGauges.addAll(gauges)
        Store.rules.clear(); Store.rules.addAll(rules)
        Store.customThemeJson.clear(); Store.customThemeJson.addAll(themes)
        Store.enabledOverride.clear(); Store.enabledOverride.putAll(enabled)
        builtInEnabled.forEach { (p, on) -> p.enabled = on }
        directoryField.set(Store, previousDirectory)
        VehicleBus.clear()
    }

    @Test fun `real Store import preserves unsafe definition but engine sends nothing`() {
        assertEquals(1, Store.importPidsJson("""[{"name":"unsafe","mode":"01","pid":"0C","header":"7E0","customRequest":"04","enabled":true}]"""))
        val p = Store.customPids.single()
        val originalId = p.id
        val transport = FakeTransport()
        val engine = ObdEngine(ElmSession(transport))
        engine.start()
        assertFalse(engine.running)
        assertTrue(engine.activePids.isEmpty())
        assertTrue(transport.sent.isEmpty())
        assertTrue(p.enabled)
        assertEquals(originalId, Store.customPids.single().id)
        assertFalse(VehicleBus.get(p.id)!!.ok)
        assertTrue(VehicleBus.get(p.id)!!.error!!.contains("安全拦截"))
    }

    @Test fun `real Backup round trip does not make unsafe imported request executable`() {
        val p = PidDefinition(id = "retain-id", mode = "01", pid = "0C", customRequest = "ATZ")
        Store.customPids.add(p)
        val backup = Backup.export()
        Store.customPids.clear()
        assertTrue(Backup.import(backup).ok)
        assertEquals("retain-id", Store.customPids.single().id)
        val transport = FakeTransport()
        val engine = ObdEngine(ElmSession(transport))
        engine.start()
        assertFalse(engine.running)
        assertTrue(transport.sent.isEmpty())
        assertEquals("ATZ", Store.customPids.single().customRequest)
    }

    @Test fun `repairing configuration re includes the same user PID without disabling it`() {
        val p = PidDefinition(id = "repair-id", customRequest = "04")
        Store.customPids.add(p)
        val engine = ObdEngine(ElmSession(FakeTransport()))
        engine.reload()
        assertFalse(engine.activePids.any { it.id == p.id })
        p.customRequest = "01 0C"
        engine.reload()
        assertTrue(engine.activePids.any { it.id == "repair-id" })
        assertTrue(p.enabled)
    }
}
