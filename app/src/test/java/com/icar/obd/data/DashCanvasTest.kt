package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * 多画布（方案 A，v1.20.0）：数据模型 + **旧配置迁移** + 切/增/删/排序。
 *
 * ## 为什么这批用例值得写
 *
 * 迁移是这一次改动里**唯一会动到用户既有配置**的地方。它错了的表现不是崩溃，
 * 而是"升级之后盘面变了 / 设置被重置"—— 那种问题用户只会说"你们版本有问题"，
 * 而现场（旧配置）已经没了，查不回来。
 *
 * 所以这里钉住三件事：
 *  1. 旧配置迁移出来的第一套画布**取值与升级前完全一致**；
 *  2. 迁移**只发生一次**（每次启动都迁一遍会不断产生新画布）；
 *  3. 各套画布的内容**互不串台**（切来切去不丢、不覆盖）。
 *
 * `Store` 是单例且会落盘，所以每个用例前都指到临时目录（与 `BackupTest` 同一套做法）。
 */
class DashCanvasTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("icarobd-canvas-test").toFile()
        AppLog.init(dir)
        Store.init(dir)
    }

    @After
    fun tearDown() {
        // Windows 上目录删除会因为 AppLog 的常开写句柄而静默失败 —— 见 BackupTest 的同类处理
        runCatching { AppLog.shutdown() }
        repeat(3) { attempt ->
            dir.walkBottomUp().forEach { runCatching { it.delete() } }
            if (!dir.exists()) return
            if (attempt < 2) Thread.sleep(50L * (attempt + 1))
        }
        if (dir.exists()) dir.deleteOnExit()
    }

    // ================================================================ 数据模型

    @Test
    fun `画布 JSON 往返保留全部字段`() {
        val c = DashCanvas(
            name = "跑山",
            type = DashCanvas.TYPE_CUSTOM,
            theme = 2,
            pageIndex = 1,
            bgImagePath = "/sdcard/bg.png",
            bgW = 120, bgH = 80, bgFit = 1, scaleMode = 2,
            designJson = """{"schema":"icar.ui/2"}""",
        )
        c.gauges.add(
            GaugeItem(pidId = "std_0C", style = GaugeItem.STYLE_QUAD, x = 10f, y = 20f, w = 30f, h = 40f)
        )

        val back = DashCanvas.fromJson(JSONObject(c.toJson().toString()))
        assertEquals(c.id, back.id)
        assertEquals("跑山", back.name)
        assertEquals(DashCanvas.TYPE_CUSTOM, back.type)
        assertEquals(2, back.theme)
        assertEquals(1, back.pageIndex)
        assertEquals("/sdcard/bg.png", back.bgImagePath)
        assertEquals(120, back.bgW)
        assertEquals(80, back.bgH)
        assertEquals(1, back.bgFit)
        assertEquals(2, back.scaleMode)
        assertEquals(c.designJson, back.designJson)
        assertEquals(1, back.gauges.size)
        assertEquals(10f, back.gauges[0].x, 1e-6f)
        assertEquals(GaugeItem.STYLE_QUAD, back.gauges[0].style)
    }

    @Test
    fun `没有设计文件时不写 designJson 键`() {
        // 空串不写 → 旧版本读到"没有这个键"就是"没有设计文件"，语义一致
        assertFalse(DashCanvas().toJson().has("designJson"))
    }

    @Test
    fun `画布数组里的坏条目被跳过而不是整体失败`() {
        val a = JSONArray().apply {
            put(DashCanvas(name = "好的").toJson())
            put("这不是对象")
            put(DashCanvas(name = "也好的").toJson())
        }
        val list = DashCanvas.listFromJson(a)
        assertEquals("坏一条不该让整份配置读不出来", 2, list.size)
        assertEquals(listOf("好的", "也好的"), list.map { it.name })
    }

    @Test
    fun `画布名兜底与裁剪`() {
        assertEquals(DashCanvas.DEFAULT_NAME, DashCanvas.sanitizeName(null))
        assertEquals(DashCanvas.DEFAULT_NAME, DashCanvas.sanitizeName("   "))
        assertEquals("跑山", DashCanvas.sanitizeName("  跑山  "))
        assertEquals("超长名字要截断", 24, DashCanvas.sanitizeName("x".repeat(50)).length)
    }

    @Test
    fun `类型名越界回落到第一项而不是抛异常`() {
        assertEquals("普通驾驶", DashCanvas.typeName(99))
        assertEquals("普通驾驶", DashCanvas.typeName(-1))
        assertEquals("性能模式", DashCanvas.typeName(DashCanvas.TYPE_PERF))
    }

    // ================================================================ 旧配置迁移

    /** 写一份 v1.19.x 的配置（settings.json 没有 canvases，扁平表在 dash.json 里） */
    private fun writeLegacyConfig() {
        File(dir, "dash.json").writeText(
            """{"gauges":[{"pid":"std_0C","style":2,"min":0,"max":8000,"unit":360,
               "x":0,"y":0,"w":180,"h":90}]}""".trimIndent()
        )
        File(dir, "settings.json").writeText(
            """{"dashType":2,"gaugeTheme":1,"pollInterval":200,
               "designJson":"{\"schema\":\"icar.ui/2\"}",
               "bgImage":"/sdcard/old.png","bgW":100,"bgH":50,"bgFit":1,
               "dashScaleMode":2,"dashPageIndex":3}""".trimIndent()
        )
    }

    @Test
    fun `旧配置迁移成一套画布且取值完全不变`() {
        writeLegacyConfig()
        Store.load()

        assertEquals("旧配置只该迁出一套画布", 1, Store.settings.canvases.size)
        val c = Store.activeCanvas()
        assertEquals(DashCanvas.DEFAULT_NAME, c.name)
        assertEquals(2, c.type)
        assertEquals(1, c.theme)
        assertEquals(3, c.pageIndex)
        assertEquals("/sdcard/old.png", c.bgImagePath)
        assertEquals(100, c.bgW)
        assertEquals(50, c.bgH)
        assertEquals(1, c.bgFit)
        assertEquals(2, c.scaleMode)
        assertEquals(1, c.gauges.size)

        // 实时字段与画布一致（渲染、编辑器读的都是它们）
        assertEquals(2, Store.settings.dashType)
        assertEquals(1, Store.settings.gaugeTheme)
        assertEquals(3, Store.settings.dashPageIndex)
        assertEquals(1, Store.customGauges.size)
        // 与画面无关的全局设置不能被迁移碰掉
        assertEquals(200, Store.settings.pollIntervalMs)

        // 已落盘：下次启动不会再迁一遍
        val saved = JSONObject(File(dir, "settings.json").readText())
        assertEquals(1, saved.getJSONArray("canvases").length())
        assertEquals(c.id, saved.getString("activeCanvasId"))
    }

    @Test
    fun `迁移只发生一次`() {
        writeLegacyConfig()
        Store.load()
        val firstId = Store.activeCanvas().id

        Store.load()
        assertEquals(1, Store.settings.canvases.size)
        assertEquals("再加载一次不该又造一套画布", firstId, Store.activeCanvas().id)
    }

    @Test
    fun `有画布时旧 dash 文件不再覆盖画布内容`() {
        // 先造一份新格式配置
        Store.load()
        Store.customGauges.clear()
        Store.customGauges.add(GaugeItem(pidId = "std_0C"))
        Store.saveDash()

        // 再改 dash.json（模拟降级用过旧版、又升回来留下的残留）
        File(dir, "dash.json").writeText(
            """{"gauges":[{"pid":"std_0D","style":0,"min":0,"max":240,"unit":360,
               "x":0,"y":0,"w":360,"h":90}]}""".trimIndent()
        )
        Store.load()

        assertEquals(1, Store.settings.canvases.size)
        assertEquals(
            "画布才是权威，dash.json 只是旧格式镜像",
            "std_0C", Store.customGauges[0].pidId
        )
    }

    @Test
    fun `activeCanvasId 悬空时自愈到第一套`() {
        Store.load()
        val first = Store.settings.canvases.first().id
        Store.settings.activeCanvasId = "不存在的id"
        assertEquals(first, Store.activeCanvas().id)
        assertEquals("悬空 id 应该被改写而不是每次都重算", first, Store.settings.activeCanvasId)
    }

    // ================================================================ 增 / 删 / 切 / 排序

    @Test
    fun `切换画布时各套内容互不串台`() {
        Store.load()
        val a = Store.activeCanvas()
        Store.customGauges.clear()
        Store.customGauges.add(GaugeItem(pidId = "std_0C"))
        Store.settings.gaugeTheme = 1
        Store.saveSettings()

        val b = Store.addCanvas("第二套", DashCanvas.TYPE_CUSTOM)
        assertNotNull(b)
        assertEquals(2, Store.settings.canvases.size)
        assertEquals("新增后应自动切过去（否则用户会以为按钮没生效）", b!!.id, Store.settings.activeCanvasId)
        assertEquals(0, Store.customGauges.size)
        assertEquals("第一套要保住自己的表", 1, a.gauges.size)

        Store.customGauges.add(GaugeItem(pidId = "std_0D"))
        Store.settings.gaugeTheme = 2
        Store.saveSettings()

        assertTrue(Store.switchCanvas(a.id))
        assertEquals(1, Store.customGauges.size)
        assertEquals("std_0C", Store.customGauges[0].pidId)
        assertEquals(1, Store.settings.gaugeTheme)

        assertTrue(Store.switchCanvas(b.id))
        assertEquals(1, Store.customGauges.size)
        assertEquals("std_0D", Store.customGauges[0].pidId)
        assertEquals(2, Store.settings.gaugeTheme)
    }

    @Test
    fun `最后一套画布删不掉`() {
        Store.load()
        assertEquals(1, Store.settings.canvases.size)
        assertFalse(Store.removeCanvas(Store.activeCanvas().id))
        assertEquals("删空之后横滑没有页、customGauges 没有归属", 1, Store.settings.canvases.size)
    }

    @Test
    fun `删掉当前画布后落到邻居`() {
        Store.load()
        val a = Store.activeCanvas()
        val b = Store.addCanvas("B", DashCanvas.TYPE_CUSTOM)!!
        val c = Store.addCanvas("C", DashCanvas.TYPE_CUSTOM)!!
        assertEquals(c.id, Store.settings.activeCanvasId)

        assertTrue(Store.removeCanvas(c.id))
        assertEquals(2, Store.settings.canvases.size)
        assertEquals("删的是最后一套 → 落到新的最后一套", b.id, Store.settings.activeCanvasId)

        assertTrue(Store.removeCanvas(b.id))
        assertEquals(a.id, Store.settings.activeCanvasId)
    }

    @Test
    fun `画布数量到上限后加不进去`() {
        Store.load()
        repeat(DashCanvas.MAX_CANVASES - 1) {
            assertNotNull(Store.addCanvas("第${it + 2}套", DashCanvas.TYPE_CUSTOM))
        }
        assertEquals(DashCanvas.MAX_CANVASES, Store.settings.canvases.size)
        assertNull(Store.addCanvas("多出来的", DashCanvas.TYPE_CUSTOM))
        assertEquals(DashCanvas.MAX_CANVASES, Store.settings.canvases.size)
    }

    @Test
    fun `排序只动顺序不动当前画布`() {
        Store.load()
        val a = Store.activeCanvas()
        val b = Store.addCanvas("B", DashCanvas.TYPE_CUSTOM)!!
        assertTrue(Store.moveCanvas(0, 1))
        assertEquals(listOf(b.id, a.id), Store.settings.canvases.map { it.id })
        assertEquals("当前画布不该因为别人换位置而变", b.id, Store.settings.activeCanvasId)
    }

    @Test
    fun `改名会被兜底成默认名`() {
        Store.load()
        val c = Store.activeCanvas()
        assertTrue(Store.renameCanvas(c.id, "   "))
        assertEquals(DashCanvas.DEFAULT_NAME, c.name)
    }

    // ================================================================ 画布名浮标（v1.20.1）

    @Test
    fun `浮标位置的常量与名字表一一对应`() {
        // 名字表要能被 UI 直接当单选项用 —— 少一项就会静默丢一个角
        assertEquals(DashCanvas.NAME_POS_HIDDEN + 1, DashCanvas.NAME_POS_NAMES.size)
        assertEquals("左上角", DashCanvas.namePosName(DashCanvas.NAME_POS_TOP_START))
        assertEquals("右下角", DashCanvas.namePosName(DashCanvas.NAME_POS_BOTTOM_END))
        assertEquals("隐藏", DashCanvas.namePosName(DashCanvas.NAME_POS_HIDDEN))
    }

    @Test
    fun `浮标位置名越界回落到左上角`() {
        assertEquals("左上角", DashCanvas.namePosName(99))
        assertEquals("左上角", DashCanvas.namePosName(-1))
    }

    @Test
    fun `画布名浮标位置能往返设置文件`() {
        Store.load()
        Store.settings.canvasNamePos = DashCanvas.NAME_POS_BOTTOM_END
        Store.saveSettings()

        Store.load()
        assertEquals(
            "加设置项必须同时改 settingsToJson 与 applySettingsJson（见 FILE_MAP 的红线）",
            DashCanvas.NAME_POS_BOTTOM_END, Store.settings.canvasNamePos
        )
    }

    @Test
    fun `越界的浮标位置在读取时被夹住`() {
        // 手改坏的 settings.json 不该让渲染层落到未知的 Gravity 分支
        File(dir, "settings.json").writeText("""{"canvasNamePos":99}""")
        Store.load()
        assertEquals(DashCanvas.NAME_POS_HIDDEN, Store.settings.canvasNamePos)
    }

    @Test
    fun `浮标位置是全局的_切画布不变`() {
        Store.load()
        Store.settings.canvasNamePos = DashCanvas.NAME_POS_TOP_END
        Store.saveSettings()

        val b = Store.addCanvas("第二套", DashCanvas.TYPE_CUSTOM)!!
        assertEquals("新增画布不该动全局显示偏好", DashCanvas.NAME_POS_TOP_END, Store.settings.canvasNamePos)

        assertTrue(Store.switchCanvas(Store.settings.canvases.first().id))
        assertEquals("切回第一套也不该变", DashCanvas.NAME_POS_TOP_END, Store.settings.canvasNamePos)
        assertEquals(b.id, Store.settings.canvases.last().id)
    }

    // ================================================================ 备份往返

    @Test
    fun `备份往返保留全部画布与当前画布`() {
        Store.load()
        val a = Store.activeCanvas()
        Store.renameCanvas(a.id, "第一套")
        Store.addCanvas("第二套", DashCanvas.TYPE_PERF)
        Store.addCanvas("第三套", DashCanvas.TYPE_CUSTOM)
        val activeBefore = Store.settings.activeCanvasId
        val json = Backup.export()

        // 抹掉内存里的画布（saveSettings 会让它自愈出一套空的，这是有意的兜底）
        Store.settings.canvases.clear()
        Store.settings.activeCanvasId = ""
        Store.saveSettings()

        val r = Backup.import(json)
        assertTrue(r.message, r.ok)
        assertEquals(3, Store.settings.canvases.size)
        assertEquals(
            listOf("第一套", "第二套", "第三套"),
            Store.settings.canvases.map { it.name }
        )
        assertEquals("当前画布也要还原", activeBefore, Store.settings.activeCanvasId)
        assertEquals(DashCanvas.TYPE_PERF, Store.settings.canvases[1].type)
    }

    // ================================================================ 最近一次导入（v1.20.6）

    /**
     * 这三条用例守的是**同一类事故**：设置项加进 `Settings` 却漏了
     * `settingsToJson` / `applySettingsJson` 的某一半 ——
     * 表现是"导入完看得见，重启就没了"，而且**不会报任何错**。
     */
    @Test
    fun `最近一次导入能往返设置文件`() {
        Store.load()
        Store.settings.lastImportName = "未命名设计-v1.json"
        Store.settings.lastImportGauges = 5
        Store.settings.lastImportAt = 1_760_000_000_000L
        Store.saveSettings()

        Store.load()
        assertEquals("加设置项必须同时改 settingsToJson 与 applySettingsJson", "未命名设计-v1.json", Store.settings.lastImportName)
        assertEquals(5, Store.settings.lastImportGauges)
        assertEquals(1_760_000_000_000L, Store.settings.lastImportAt)
    }

    @Test
    fun `旧配置没有导入字段时是空记录而不是假时间`() {
        // 老设备的 settings.json 里根本没有这三个键 —— 兜一个"当前时间"会让
        // 设置页显示一条**从没发生过的**导入记录（比空更糟：用户会以为导进去了）
        File(dir, "settings.json").writeText("""{"pollInterval":150}""")
        Store.load()
        assertEquals("", Store.settings.lastImportName)
        assertEquals(0, Store.settings.lastImportGauges)
        assertEquals(0L, Store.settings.lastImportAt)
        assertEquals("没导入过 → 摘要必须是空串", "", Store.settings.lastImportSummary())
    }

    @Test
    fun `导入摘要的格式是文件名加块表加时间`() {
        val s = Store.Settings()
        s.lastImportName = "未命名设计-v1.json"
        s.lastImportGauges = 5
        s.lastImportAt = 1_760_000_000_000L
        val line = s.lastImportSummary()
        assertTrue("要有文件名：$line", line.startsWith("未命名设计-v1.json · 5 块表 · "))
        // 时间是 `MM-dd HH:mm`。不校验具体值 —— 时区会让它随机器变
        val ts = line.substringAfterLast("· ")
        assertTrue("时间要是 MM-dd HH:mm，实际是「$ts」", Regex("\\d{2}-\\d{2} \\d{2}:\\d{2}").matches(ts))
    }

    @Test
    fun `导入摘要缺文件名时兜底为未命名设计`() {
        val s = Store.Settings()
        s.lastImportGauges = 3
        s.lastImportAt = 1_760_000_000_000L
        assertTrue(s.lastImportSummary().startsWith("未命名设计 · 3 块表 · "))
    }
}
