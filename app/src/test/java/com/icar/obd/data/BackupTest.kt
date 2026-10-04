package com.icar.obd.data

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 完整备份导出/导入的单元测试（v1.5.0 P4-7）。
 *
 * `Store` 与 `AppLog` 都是单例、且会落盘，所以每个用例前都要
 * 指到一个临时目录并清空内存状态，否则用例之间会互相污染。
 */
class BackupTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("icarobd-backup-test").toFile()
        AppLog.init(dir)
        Store.init(dir)
        reset()
    }

    @After
    fun tearDown() {
        // ⚠️ **`deleteRecursively()` 会静默失败，所以不用它**（v2.42.0）。
        //
        // 两个原因：
        //   1. 它**返回 false 但不抛异常** —— 静默失败（实测每次跑还是留 4 个目录）
        //   2. 内部**一旦某个文件删不掉，可能就整棵树放弃了** —— 而 Windows 上
        //      "某个文件句柄还没释放"是很常见的
        //
        // 改成自己走一遍：**从深到浅**逐个删（先删子项再删父目录），
        // 每个都 `runCatching` 吞掉失败、删完检查一次、不行就重试三轮
        // （给句柄一点释放时间）。
        // ⚠️ **必须先关掉 AppLog 的写句柄**（v2.42.0）。
        //
        // `AppLog` 为了性能保持一个**常开的 `BufferedWriter`**，
        // 它会占住目录里的日志文件 —— Windows 上文件删不掉，目录就删不掉。
        //
        // 这就是"10 个测试里稳定剩 4 个目录"的真正原因：
        // 只有真的写过日志的那几个测试才会把句柄打开。
        //
        // `clear()` 里也关，但那是**异步的**（走 IO 线程），赶不上这里。
        runCatching { com.icar.obd.data.AppLog.shutdown() }

        repeat(3) { attempt ->
            // walkBottomUp：深度优先、子项先于父项 —— 正好是删除需要的顺序
            dir.walkBottomUp().forEach { runCatching { it.delete() } }
            if (!dir.exists()) return
            if (attempt < 2) Thread.sleep(50L * (attempt + 1))
        }
        // 最后兜底：JVM 退出时再试一次（对**空**目录有效）
        if (dir.exists()) dir.deleteOnExit()
    }

    private fun reset() {
        Store.customPids.clear()
        Store.rules.clear()
        Store.customGauges.clear()
        Store.customThemeJson.clear()
        Store.enabledOverride.clear()
        Store.settings = Store.Settings()
    }

    private fun seed() {
        Store.customPids.add(
            PidDefinition(id = "p1", name = "测试PID", mode = "22", pid = "1234", formula = "A")
        )
        Store.enabledOverride["std_0C"] = false
        Store.rules.add(Rule(name = "测试规则"))
        Store.customGauges.add(
            GaugeItem(
                pidId = "std_0C",
                extraPids = mutableListOf("std_0D"),
                style = GaugeItem.STYLE_QUAD,
                x = 0.25f, y = 0.5f, w = 0.5f, h = 0.25f
            )
        )
        Store.customThemeJson.add("""{"id":100,"title":"我的主题"}""")
        Store.settings.gridCols = 8
        Store.settings.gridEnabled = true
        Store.settings.transportKind = "spp"
    }

    // ================================================================ 导出

    @Test
    fun `导出的备份带 app 与 format 标记且包含全部区段`() {
        val json = JSONObject(Backup.export())
        assertEquals(Backup.APP_TAG, json.getString("app"))
        assertEquals(Backup.FORMAT, json.getInt("format"))
        assertTrue(json.has("exportedAt"))
        listOf("pids", "enabled", "rules", "gauges", "themes", "settings").forEach {
            assertTrue("缺少区段 $it", json.has(it))
        }
    }

    @Test
    fun `摘要统计与实际条数一致`() {
        seed()
        val s = Backup.currentSummary()
        assertEquals(1, s.pids)
        assertEquals(1, s.rules)
        assertEquals(1, s.gauges)
        assertEquals(1, s.themes)
        assertEquals(1, s.enabledOverrides)
    }

    // ================================================================ 往返

    @Test
    fun `导出后导入应还原全部配置`() {
        seed()
        val json = Backup.export()

        reset()
        assertEquals(0, Store.customPids.size)

        val r = Backup.import(json)
        assertTrue(r.message, r.ok)

        assertEquals(1, Store.customPids.size)
        assertEquals("测试PID", Store.customPids[0].name)
        assertEquals("22", Store.customPids[0].mode)
        assertEquals(false, Store.enabledOverride["std_0C"])
        assertEquals(1, Store.rules.size)
        assertEquals("测试规则", Store.rules[0].name)

        assertEquals(1, Store.customGauges.size)
        assertEquals(0.25f, Store.customGauges[0].x, 1e-6f)
        assertEquals(0.5f, Store.customGauges[0].y, 1e-6f)
        assertEquals(GaugeItem.STYLE_QUAD, Store.customGauges[0].style)
        assertEquals(listOf("std_0D"), Store.customGauges[0].extraPids)

        assertEquals(1, Store.customThemeJson.size)
        assertTrue(Store.customThemeJson[0].contains("我的主题"))

        assertEquals(8, Store.settings.gridCols)
        assertTrue(Store.settings.gridEnabled)
        assertEquals("spp", Store.settings.transportKind)
    }

    @Test
    fun `导入是整体替换而不是合并`() {
        Store.rules.add(Rule(name = "备份里的"))
        val json = Backup.export()

        // 备份之后又加了一条，它不该在导入后存活
        Store.rules.add(Rule(name = "备份之后新增的"))
        assertEquals(2, Store.rules.size)

        val r = Backup.import(json)
        assertTrue(r.message, r.ok)
        assertEquals("导入应整体替换，不能把新增的留下", 1, Store.rules.size)
        assertEquals("备份里的", Store.rules[0].name)
    }

    // ================================================================ 拒绝

    @Test
    fun `拒绝非法 JSON`() {
        val r = Backup.import("这不是 JSON")
        assertFalse(r.ok)
        assertTrue(r.message.contains("JSON"))
    }

    @Test
    fun `拒绝非本 App 的备份`() {
        val r = Backup.import("""{"app":"OtherApp","format":1}""")
        assertFalse(r.ok)
        assertTrue(r.message, r.message.contains("iCarOBD"))
    }

    @Test
    fun `拒绝来自更新版本的备份`() {
        val r = Backup.import("""{"app":"iCarOBD","format":${Backup.FORMAT + 1}}""")
        assertFalse(r.ok)
        assertTrue(r.message, r.message.contains("更新"))
    }

    @Test
    fun `拒绝导入不会破坏现有配置`() {
        seed()
        Backup.import("垃圾数据")
        assertEquals("拒绝时不应动到已有数据", 1, Store.customPids.size)
        assertEquals(1, Store.rules.size)
    }

    // ================================================================ 兼容旧备份

    @Test
    fun `导入旧版只有 span 的布局会自动迁移成画布坐标`() {
        val legacy = """
            {"app":"iCarOBD","format":1,
             "gauges":[
               {"pid":"std_0D","style":0,"min":0,"max":240,"span":2},
               {"pid":"std_0C","style":1,"min":0,"max":8000,"span":2}
             ]}
        """.trimIndent()

        val C = GaugeItem.CANVAS
        val r = Backup.import(legacy)
        assertTrue(r.message, r.ok)
        assertEquals(2, Store.customGauges.size)

        val a = Store.customGauges[0]
        val b = Store.customGauges[1]
        assertEquals("整行", C, a.w, 1e-3f)
        assertEquals(0f, a.y, 1e-3f)
        assertTrue("第二条应在下方", b.y > C * 0.5f)
        assertEquals("迁移后应纵向铺满", C, maxOf(a.y + a.h, b.y + b.h), 1e-3f)
        assertFalse(a.legacyGrid)
    }

    @Test
    fun `缺省区段时按空处理而不是报错`() {
        val r = Backup.import("""{"app":"iCarOBD","format":1}""")
        assertTrue(r.message, r.ok)
        assertEquals(0, Store.customPids.size)
        assertEquals(0, Store.rules.size)
        assertEquals(0, Store.customGauges.size)
    }
}
