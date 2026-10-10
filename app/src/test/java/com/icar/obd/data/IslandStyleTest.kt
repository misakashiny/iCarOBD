package com.icar.obd.data

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
 * **灵动岛样式**（v1.20.13）：出厂默认 / 归一化 / 落盘 / 手改坏的配置。
 *
 * ## 为什么这批用例值得写（三条都是"真机上验不了"或"只有这里能验"）
 *
 * 1. **"默认值 = 现在的样子"是一条硬约束**（用户要求"升级不改变观感"），
 *    而"样子"是像素级的：位置、字号、内边距、圆角、配色、停留时长六个数。
 *    真机上只能"看着差不多"，只有这里能逐个数断言。
 * 2. **旧配置里根本没有这七个键**（v1.20.12 及以前的 `settings.json`）。
 *    兜错了的表现是"升级之后提示跑到别处去了"—— 而那时现场（旧配置）已经没了。
 * 3. **手改坏的 `settings.json`**：档位越界、停留时长写 `999999`、
 *    颜色写全透明（= 胶囊看不见，用户会以为"提示坏了"）。这些分支在界面上点不出来。
 *
 * `Store` 是单例且会落盘，所以每个用例前都指到临时目录（与 `GestureActionsTest` 同一套做法）。
 */
class IslandStyleTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("icarobd-island-test").toFile()
        AppLog.init(dir)
        Store.init(dir)
        Store.settings = Store.Settings()
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

    // ================================================================ 出厂默认 = 旧观感

    /**
     * **这一条是整批用例里最重要的**：六个数就是 v1.20.12 写死在 `IslandNotice` 里的样子。
     * 任何一个被改动，升级后用户的灵动岛就"长得不一样了"。
     */
    @Test
    fun `默认样式就是 v1_20_12 的样子`() {
        val s = Store.Settings().islandStyle()
        assertEquals(IslandStyle.POS_CENTER, s.pos)
        assertEquals(IslandStyle.SIZE_MEDIUM, s.size)
        assertEquals(IslandStyle.CORNER_LARGE, s.corner)
        assertEquals(4000L, s.holdMs)
        // v1.20.12：setPadding(dp(14), dp(7), dp(14), dp(7)) + textSize = 13f
        assertEquals(13f, s.textSp, 0f)
        assertEquals(14, s.padHdp)
        assertEquals(7, s.padVdp)
        // v1.20.12：cornerRadius = dp(18)
        assertEquals(18, s.cornerDp)
        // v1.20.12：CAPSULE_BG / 白字 / 琥珀 +N
        assertEquals(0xF01A1F27.toInt(), s.bg)
        assertEquals(0xFFFFFFFF.toInt(), s.fg)
        assertEquals(0xFFFFD400.toInt(), s.accent)
    }

    @Test
    fun `默认摘要一眼能看出是出厂值`() {
        assertEquals(
            "当前：顶部居中 · 中 · 圆角大（胶囊） · 4 秒 · 跟随主题",
            Store.Settings().islandSummary()
        )
    }

    // ================================================================ 归一化

    @Test
    fun `越界档位落回默认值而不是夹到边界`() {
        // 夹到边界的话，一份手改坏的 settings.json 会把提示**静默挪到靠右**
        // —— 用户完全不知道为什么
        assertEquals(IslandStyle.POS_DEFAULT, IslandStyle.normalizePos(99))
        assertEquals(IslandStyle.POS_DEFAULT, IslandStyle.normalizePos(-3))
        assertEquals(IslandStyle.SIZE_DEFAULT, IslandStyle.normalizeSize(7))
        assertEquals(IslandStyle.CORNER_DEFAULT, IslandStyle.normalizeCorner(-1))
        assertEquals(IslandStyle.COLOR_MODE_DEFAULT, IslandStyle.normalizeColorMode(42))
        // 合法值原样保留
        assertEquals(IslandStyle.POS_END, IslandStyle.normalizePos(IslandStyle.POS_END))
        assertEquals(IslandStyle.SIZE_SMALL, IslandStyle.normalizeSize(IslandStyle.SIZE_SMALL))
    }

    @Test
    fun `停留时长必须在候选里`() {
        assertEquals(2000, IslandStyle.normalizeHoldMs(2000))
        assertEquals(6000, IslandStyle.normalizeHoldMs(6000))
        // 手改一个 999999 会让提示赖在画布上不走 —— 必须兜回默认
        assertEquals(IslandStyle.HOLD_DEFAULT_MS, IslandStyle.normalizeHoldMs(999999))
        assertEquals(IslandStyle.HOLD_DEFAULT_MS, IslandStyle.normalizeHoldMs(0))
    }

    @Test
    fun `全透明的颜色落回兜底值`() {
        // alpha == 0 = 胶囊看不见，用户会以为"提示坏了"，不是"我设成全透明了"
        assertEquals(IslandStyle.THEME_BG, IslandStyle.normalizeColor(0x00FFFFFF, IslandStyle.THEME_BG))
        assertEquals(IslandStyle.THEME_FG, IslandStyle.normalizeColor(0x00000000, IslandStyle.THEME_FG))
        // 半透明是**有意的**样式选择，原样保留
        assertEquals(0x80FF0000.toInt(), IslandStyle.normalizeColor(0x80FF0000.toInt(), IslandStyle.THEME_BG))
    }

    @Test
    fun `跟随主题时忽略自定义色`() {
        val s = IslandStyle.spec(
            pos = IslandStyle.POS_END, size = IslandStyle.SIZE_LARGE, corner = IslandStyle.CORNER_SMALL,
            holdMs = 6000, colorMode = IslandStyle.COLOR_THEME,
            bg = 0xFF00FF00.toInt(), fg = 0xFF0000FF.toInt(),
        )
        assertEquals(IslandStyle.THEME_BG, s.bg)
        assertEquals(IslandStyle.THEME_FG, s.fg)
        assertEquals(IslandStyle.THEME_ACCENT, s.accent)
    }

    @Test
    fun `自定义配色下 +N 跟正文色`() {
        // 底色可能是白的/琥珀的，固定的强调黄在白底上读不出来 ——
        // 而"还有别的告警"这件事不能丢
        val s = IslandStyle.spec(
            pos = 0, size = 0, corner = 0, holdMs = 2000,
            colorMode = IslandStyle.COLOR_CUSTOM,
            bg = 0xF0FFFFFF.toInt(), fg = 0xFF000000.toInt(),
        )
        assertEquals(0xF0FFFFFF.toInt(), s.bg)
        assertEquals(0xFF000000.toInt(), s.fg)
        assertEquals(0xFF000000.toInt(), s.accent)
    }

    @Test
    fun `尺寸三档与档位表一一对应`() {
        assertEquals(IslandStyle.SIZE_COUNT, IslandStyle.SIZE_NAMES.size)
        assertEquals(IslandStyle.SIZE_COUNT, IslandStyle.SIZE_TEXT_SP.size)
        assertEquals(IslandStyle.SIZE_COUNT, IslandStyle.SIZE_PAD_H_DP.size)
        assertEquals(IslandStyle.SIZE_COUNT, IslandStyle.SIZE_PAD_V_DP.size)
        assertEquals(IslandStyle.POS_COUNT, IslandStyle.POS_NAMES.size)
        assertEquals(IslandStyle.CORNER_COUNT, IslandStyle.CORNER_NAMES.size)
        assertEquals(IslandStyle.CORNER_COUNT, IslandStyle.CORNER_RADIUS_DP.size)
        assertEquals(IslandStyle.COLOR_COUNT, IslandStyle.COLOR_MODE_NAMES.size)
        assertEquals(IslandStyle.HOLD_CHOICES_MS.size, IslandStyle.HOLD_NAMES.size)
        // 字号/内边距必须**单调递增** —— 否则"大"看起来比"中"还小
        assertTrue(IslandStyle.SIZE_TEXT_SP[0] < IslandStyle.SIZE_TEXT_SP[1])
        assertTrue(IslandStyle.SIZE_TEXT_SP[1] < IslandStyle.SIZE_TEXT_SP[2])
        assertTrue(IslandStyle.SIZE_PAD_H_DP[0] < IslandStyle.SIZE_PAD_H_DP[1])
        assertTrue(IslandStyle.SIZE_PAD_H_DP[1] < IslandStyle.SIZE_PAD_H_DP[2])
        assertTrue(IslandStyle.CORNER_RADIUS_DP[0] < IslandStyle.CORNER_RADIUS_DP[1])
        assertTrue(IslandStyle.CORNER_RADIUS_DP[1] < IslandStyle.CORNER_RADIUS_DP[2])
        // 圆角"大"就是 v1.20.12 那个 18dp（矮胶囊上被夹成"全圆角"）
        assertEquals(18, IslandStyle.CORNER_RADIUS_DP[IslandStyle.CORNER_DEFAULT])
    }

    @Test
    fun `色板与色名一一对应`() {
        assertEquals(IslandStyle.BG_PRESETS.size, IslandStyle.BG_PRESET_NAMES.size)
        assertEquals(IslandStyle.FG_PRESETS.size, IslandStyle.FG_PRESET_NAMES.size)
        // 第一个色块必须就是"跟随主题"那个值 —— 用户想"自定义成默认色"时能一眼找到
        assertEquals(IslandStyle.THEME_BG, IslandStyle.BG_PRESETS[0])
        assertEquals(IslandStyle.THEME_FG, IslandStyle.FG_PRESETS[0])
        // 色板里不许出现全透明（选了就等于把胶囊藏了）
        assertTrue(IslandStyle.BG_PRESETS.all { ((it ushr 24) and 0xFF) != 0 })
        assertTrue(IslandStyle.FG_PRESETS.all { ((it ushr 24) and 0xFF) != 0 })
    }

    @Test
    fun `停留时长的下标映射`() {
        assertEquals(0, IslandStyle.holdIndex(2000))
        assertEquals(1, IslandStyle.holdIndex(4000))
        assertEquals(2, IslandStyle.holdIndex(6000))
        assertEquals("认不得的落到默认那一档", 1, IslandStyle.holdIndex(12345))
    }

    // ================================================================ 落盘

    @Test
    fun `改完样式能落盘再读回来`() {
        Store.settings.islandPos = IslandStyle.POS_START
        Store.settings.islandSize = IslandStyle.SIZE_LARGE
        Store.settings.islandCorner = IslandStyle.CORNER_SMALL
        Store.settings.islandHoldMs = 6000
        Store.settings.islandColorMode = IslandStyle.COLOR_CUSTOM
        Store.settings.islandBgColor = 0xF0FFFFFF.toInt()
        Store.settings.islandFgColor = 0xFF000000.toInt()
        Store.saveSettings()

        Store.load()
        assertEquals(IslandStyle.POS_START, Store.settings.islandPos)
        assertEquals(IslandStyle.SIZE_LARGE, Store.settings.islandSize)
        assertEquals(IslandStyle.CORNER_SMALL, Store.settings.islandCorner)
        assertEquals(6000, Store.settings.islandHoldMs)
        assertEquals(IslandStyle.COLOR_CUSTOM, Store.settings.islandColorMode)
        assertEquals(0xF0FFFFFF.toInt(), Store.settings.islandBgColor)
        assertEquals(0xFF000000.toInt(), Store.settings.islandFgColor)
        val s = Store.settings.islandStyle()
        assertEquals(0xF0FFFFFF.toInt(), s.bg)
        assertEquals(0xFF000000.toInt(), s.fg)
    }

    @Test
    fun `settingsToJson 里必须有这七个键`() {
        // 加设置项只改一半（只改 apply 或只改 toJson）是这一页最容易犯的错，
        // 而症状是"改完重启就没了" —— 见 FILE_MAP 的红线
        val o = Store.settingsToJson()
        for (k in listOf("islandPos", "islandSize", "islandCorner", "islandHold", "islandColorMode", "islandBg", "islandFg")) {
            assertTrue("settingsToJson 少了 $k", o.has(k))
        }
    }

    /**
     * **旧配置（v1.20.12 及以前）里没有这七个键** —— 升级后必须还是原来的样子。
     *
     * 这是这一版最危险的一处：兜错了的表现是"升级之后提示跑到别处 / 变大变小"，
     * 而那时用户的旧配置已经被覆盖掉了。
     */
    @Test
    fun `旧配置缺字段时取默认值`() {
        Store.applySettingsJson(JSONObject().put("sound", true).put("pollInterval", 120))
        val s = Store.settings.islandStyle()
        assertEquals(IslandStyle.POS_CENTER, s.pos)
        assertEquals(IslandStyle.SIZE_MEDIUM, s.size)
        assertEquals(IslandStyle.CORNER_LARGE, s.corner)
        assertEquals(4000L, s.holdMs)
        assertEquals(0xF01A1F27.toInt(), s.bg)
        assertEquals(0xFFFFFFFF.toInt(), s.fg)
        assertEquals(13f, s.textSp, 0f)
        assertEquals(14, s.padHdp)
        assertEquals(7, s.padVdp)
        assertEquals(18, s.cornerDp)
    }

    @Test
    fun `手改坏的配置在读取时就被夹住`() {
        Store.applySettingsJson(
            JSONObject()
                .put("islandPos", 99)
                .put("islandSize", -7)
                .put("islandCorner", 12345)
                .put("islandHold", 999999)
                .put("islandColorMode", 88)
                .put("islandBg", 0x00FFFFFF)
                .put("islandFg", 0x00000000)
        )
        val s = Store.settings.islandStyle()
        assertEquals(IslandStyle.POS_DEFAULT, s.pos)
        assertEquals(IslandStyle.SIZE_DEFAULT, s.size)
        assertEquals(IslandStyle.CORNER_DEFAULT, s.corner)
        assertEquals(IslandStyle.HOLD_DEFAULT_MS.toLong(), s.holdMs)
        assertEquals(IslandStyle.THEME_BG, s.bg)
        assertEquals(IslandStyle.THEME_FG, s.fg)
        // 落盘出去的也必须是合法值（不然坏值会被"洗白"成正常配置传下去）
        assertEquals(IslandStyle.POS_DEFAULT, Store.settingsToJson().optInt("islandPos"))
        assertEquals(IslandStyle.HOLD_DEFAULT_MS, Store.settingsToJson().optInt("islandHold"))
    }

    // ================================================================ 摘要与色值

    @Test
    fun `摘要跟着设置变`() {
        Store.settings.islandPos = IslandStyle.POS_END
        Store.settings.islandSize = IslandStyle.SIZE_SMALL
        Store.settings.islandCorner = IslandStyle.CORNER_MEDIUM
        Store.settings.islandHoldMs = 2000
        Store.settings.islandColorMode = IslandStyle.COLOR_CUSTOM
        assertEquals(
            "当前：顶部靠右 · 小 · 圆角中 · 2 秒 · 自定义",
            Store.settings.islandSummary()
        )
    }

    @Test
    fun `色值解析与格式化`() {
        assertEquals("#1A1F27", IslandStyle.hexOf(0xF01A1F27.toInt()))
        assertEquals(0xFFFFFFFF.toInt(), IslandStyle.parseHex("#FFFFFF"))
        assertEquals(0xFF1A1F27.toInt(), IslandStyle.parseHex("1A1F27"))
        assertEquals(0x801A1F27.toInt(), IslandStyle.parseHex("#801A1F27"))
        assertEquals("六位一律补成不透明", 0xFFFFFFFF.toInt(), IslandStyle.parseHex("#ffffff"))
        // 认不出来的必须返回 null —— 调用方会提示用户，而不是静默用个黑
        assertNull(IslandStyle.parseHex(""))
        assertNull(IslandStyle.parseHex("#12"))
        assertNull(IslandStyle.parseHex("不是颜色"))
        assertNull(IslandStyle.parseHex(null))
        assertNotNull(IslandStyle.parseHex(IslandStyle.hexOf(IslandStyle.THEME_BG)))
    }

    @Test
    fun `摘要与说明文案里不许出现 Markdown 星号`() {
        // TextView 不渲染 Markdown，写 ** 用户看到的就是带星号的原文
        // （v1.20.11 在知识库页踩过：144 个 ** 原样显示）
        assertFalse(Store.Settings().islandSummary().contains("**"))
        assertFalse(IslandStyle.POS_NAMES.any { it.contains("**") })
        assertFalse(IslandStyle.SIZE_NAMES.any { it.contains("**") })
        assertFalse(IslandStyle.CORNER_NAMES.any { it.contains("**") })
        assertFalse(IslandStyle.HOLD_NAMES.any { it.contains("**") })
        assertFalse(IslandStyle.COLOR_MODE_NAMES.any { it.contains("**") })
    }
}
