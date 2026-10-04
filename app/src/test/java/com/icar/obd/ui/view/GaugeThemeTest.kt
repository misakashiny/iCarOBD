package com.icar.obd.ui.view

import com.icar.obd.data.AppLog
import com.icar.obd.data.Store
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.After
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * [GaugeTheme] 的单元测试（v1.5.0 P4-6 自定义主题）。
 *
 * 能测的前提是两件事：把 `Color.parseColor` 换成了纯 Kotlin 十六进制解析，
 * 以及 `AppLog` 的 Handler 改成了 lazy —— 否则一碰这些类就抛 `Stub!`。
 */
class GaugeThemeTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("icarobd-theme-test").toFile()
        AppLog.init(dir)
        Store.init(dir)
        Store.customThemeJson.clear()
    }
    /**
     * **必须清理临时目录**（v2.42.0）。
     *
     * 这个类有 36 个测试方法，每个都跑一次 `setUp` ——
     * **漏了 `@After` 就是每次跑泄漏 36 个目录**。
     *
     * 实测：`%TEMP%` 里堆了 **2454 个** `icarobd-theme-test*` 目录
     * （从 10/02 攒到 10/05）。`BackupTest` 有对应的 `@After`，所以它没这个问题。
     *
     * 注意：**进程被强杀时 `@After` 也不会跑** —— 那种残留清不掉，
     * 只能靠人工清 `%TEMP%\icarobd-*`。
     */
    @After
    fun tearDown() {
        dir.deleteRecursively()
    }

    @Test
    fun `内置三套主题 id 与顺序稳定`() {
        val b = GaugeTheme.builtIns()
        assertEquals(3, b.size)
        assertEquals(listOf(GaugeTheme.NEON, GaugeTheme.ICE, GaugeTheme.CLASSIC), b.map { it.id })
        assertTrue("内置主题不应标记为自建", b.none { it.custom })
    }

    @Test
    fun `十六进制颜色解析正确`() {
        val t = GaugeTheme.builtIns()[0]
        assertEquals(0xFF080A0E.toInt(), t.background)
        assertEquals(0xFFFF8A00.toInt(), t.accent)
    }

    @Test
    fun `JSON 往返保留全部字段`() {
        val src = GaugeTheme.builtIns()[1].asCustom(100, "我的冰川")
        val back = GaugeTheme.fromJson(JSONObject(src.toJson().toString()))

        assertEquals(100, back.id)
        assertEquals("我的冰川", back.title)
        assertEquals(src.description, back.description)
        assertEquals(src.background, back.background)
        assertEquals(src.accent, back.accent)
        assertEquals(src.accentHot, back.accentHot)
        assertEquals(src.dim, back.dim)
        assertEquals(src.glow, back.glow)
        assertEquals(src.cardRadiusDp, back.cardRadiusDp, 1e-6f)
        assertEquals(src.strokeDp, back.strokeDp, 1e-6f)
        assertEquals(src.needleLengthRatio, back.needleLengthRatio, 1e-6f)
        assertEquals(src.defaultRingStyle, back.defaultRingStyle)
        assertEquals(src.defaultRingSegments, back.defaultRingSegments)
        assertTrue("读回来的应标记为自建", back.custom)
    }

    @Test
    fun `自建主题会出现在 all 与 of 里`() {
        Store.customThemeJson.add(
            GaugeTheme.builtIns()[0].asCustom(100, "我的").toJson().toString()
        )
        assertEquals(4, GaugeTheme.all().size)
        assertTrue(GaugeTheme.all().any { it.id == 100 && it.title == "我的" })
        assertEquals("我的", GaugeTheme.of(100).title)
    }

    @Test
    fun `损坏的自建主题 JSON 被跳过而不是崩`() {
        Store.customThemeJson.add("{ 这不是 JSON")
        Store.customThemeJson.add(
            GaugeTheme.builtIns()[2].asCustom(101, "好的").toJson().toString()
        )
        val all = GaugeTheme.all()
        assertEquals("坏的那条应被跳过，好的仍可用", 4, all.size)
        assertTrue(all.any { it.title == "好的" })
    }

    @Test
    fun `未知 id 回落到内置第一套`() {
        assertEquals(GaugeTheme.NEON, GaugeTheme.of(9999).id)
    }

    @Test
    fun `nextCustomId 从 CUSTOM_ID_BASE 起且不重复`() {
        assertEquals(GaugeTheme.CUSTOM_ID_BASE, GaugeTheme.nextCustomId())
        Store.customThemeJson.add(
            GaugeTheme.builtIns()[0].asCustom(GaugeTheme.CUSTOM_ID_BASE, "a").toJson().toString()
        )
        assertEquals(GaugeTheme.CUSTOM_ID_BASE + 1, GaugeTheme.nextCustomId())
    }

    @Test
    fun `asCustom 只改 id 标题与标记 颜色不动`() {
        val src = GaugeTheme.builtIns()[0]
        val c = src.asCustom(200, "副本")
        assertEquals(200, c.id)
        assertEquals("副本", c.title)
        assertTrue(c.custom)
        assertEquals(src.accent, c.accent)
        assertEquals(src.background, c.background)
        assertEquals(src.glow, c.glow)
    }

    @Test
    fun `缺字段的 JSON 用兜底值而不是崩`() {
        val t = GaugeTheme.fromJson(JSONObject("""{"id":150,"title":"残缺"}"""))
        assertEquals(150, t.id)
        assertEquals("残缺", t.title)
        assertEquals(18f, t.cardRadiusDp, 1e-6f)
        assertEquals(9f, t.strokeDp, 1e-6f)
        assertEquals(0.62f, t.needleLengthRatio, 1e-6f)
    }

    // ------------------------------------------------- 无边框 / 透明卡片（第二轮迭代）

    @Test
    fun `无边框与透明卡片参数能 JSON 往返`() {
        val src = GaugeTheme.builtIns()[0].asCustom(120, "无边框")
            .copy(cardStrokeDp = 0f, cardAlpha = 0)
        val back = GaugeTheme.fromJson(JSONObject(src.toJson().toString()))
        assertEquals("0 = 无边框", 0f, back.cardStrokeDp, 1e-6f)
        assertEquals("0 = 完全透明", 0, back.cardAlpha)
    }

    @Test
    fun `旧主题缺新字段时保持有边框不透明`() {
        val t = GaugeTheme.fromJson(JSONObject("""{"id":130,"title":"旧格式"}"""))
        assertEquals("旧主题不能被悄悄改成无边框", 1f, t.cardStrokeDp, 1e-6f)
        assertEquals(255, t.cardAlpha)
    }

    @Test
    fun `asCustom 会带上无边框设置`() {
        val src = GaugeTheme.builtIns()[0].copy(cardStrokeDp = 0f, cardAlpha = 40)
        val c = src.asCustom(140, "副本")
        assertEquals(0f, c.cardStrokeDp, 1e-6f)
        assertEquals(40, c.cardAlpha)
    }

    // ================================================================ v1.10.2 单表覆盖

    @Test
    fun `跟随主题时返回自身不做任何改动`() {
        // 零开销路径：绝大多数表都不设覆盖，不该每次 render 都 copy 一份
        val t = GaugeTheme.builtIns()[0]
        assertTrue("null 应当返回同一个实例", t.withCardOverride(null) === t)
        assertTrue(
            "CARD_THEME 应当返回同一个实例",
            t.withCardOverride(com.icar.obd.data.GaugeItem.CARD_THEME) === t
        )
    }

    @Test
    fun `无边框只去描边保留底色`() {
        val t = GaugeTheme.builtIns()[0].copy(cardStrokeDp = 2f, cardAlpha = 200)
        val o = t.withCardOverride(com.icar.obd.data.GaugeItem.CARD_NO_BORDER)
        assertEquals("描边归零", 0f, o.cardStrokeDp, 1e-6f)
        assertEquals("底色必须保留 —— 否则和无边框是两回事", 200, o.cardAlpha)
    }

    @Test
    fun `完全透明同时去描边和底色`() {
        val t = GaugeTheme.builtIns()[0].copy(cardStrokeDp = 2f, cardAlpha = 200)
        val o = t.withCardOverride(com.icar.obd.data.GaugeItem.CARD_TRANSPARENT)
        assertEquals(0f, o.cardStrokeDp, 1e-6f)
        assertEquals(0, o.cardAlpha)
    }

    @Test
    fun `未知覆盖值回落到跟随主题而不是崩`() {
        // 降级回来的新配置：不能崩，也不能变成"无边框"
        val t = GaugeTheme.builtIns()[0].copy(cardStrokeDp = 3f)
        val o = t.withCardOverride(999)
        assertEquals(3f, o.cardStrokeDp, 1e-6f)
    }

    @Test
    fun `不画卡片的判定不需要 Android 桩`() {
        // ⚠️ `cardBackgroundFor` / `cardBackground` **没法在 JVM 单测里测** ——
        // 它们要 `GradientDrawable`，而 Android 框架类在单测里是抛 `Stub!` 的桩。
        // 所以这里只钉"能被纯 Kotlin 覆盖的那一半"：覆盖项 → 三个数值的映射。
        //
        // 「返回 null 让 host 背景留空」这条由实现保证，靠装机验证（DashRenderer）。
        val t = GaugeTheme.builtIns()[0].copy(cardStrokeDp = 1f, cardAlpha = 255)
        val none = t.withCardOverride(com.icar.obd.data.GaugeItem.CARD_NONE)
        assertEquals("CARD_NONE 应当和完全透明一样：无描边", 0f, none.cardStrokeDp, 1e-6f)
        assertEquals("CARD_NONE 应当和完全透明一样：全透明", 0, none.cardAlpha)
    }

    @Test
    fun `覆盖不会改动原主题对象`() {
        // data class copy 的语义保证；这条防的是将来有人改成可变字段
        val t = GaugeTheme.builtIns()[0].copy(cardStrokeDp = 3f, cardAlpha = 210)
        t.withCardOverride(com.icar.obd.data.GaugeItem.CARD_TRANSPARENT)
        assertEquals("原对象不能被改", 3f, t.cardStrokeDp, 1e-6f)
        assertEquals(210, t.cardAlpha)
    }

    // ================================================================ v1.10.3 主题别名

    @Test
    fun `内置主题的别名是冻结的契约`() {
        // 设计文件里写的是**名字**（"neon"）而不是数字 id ——
        // id 会随自建主题分配变化，名字才是跨机器稳定的。
        // 改这些字符串会让存量 design.json 找不到主题（静默保持当前主题）。
        assertEquals("neon", GaugeTheme.aliasOf(GaugeTheme.NEON))
        assertEquals("ice", GaugeTheme.aliasOf(GaugeTheme.ICE))
        assertEquals("amber", GaugeTheme.aliasOf(GaugeTheme.CLASSIC))
    }

    @Test
    fun `自建主题没有别名`() {
        // 自建主题在不同设备上 id 必然不同 → 不该有稳定别名。
        // 导出时遇到自建主题要留空（用当前主题），否则导入会报"主题不存在"
        assertEquals(null, GaugeTheme.aliasOf(GaugeTheme.CUSTOM_ID_BASE))
        assertEquals(null, GaugeTheme.aliasOf(GaugeTheme.CUSTOM_ID_BASE + 7))
    }

    @Test
    fun `别名能反查回同一个主题`() {
        listOf("neon", "ice", "amber").forEach { alias ->
            val t = GaugeTheme.byAlias(alias)
            assertTrue("$alias 应当能查到主题", t != null)
            assertEquals("反查回来必须是同一个", alias, GaugeTheme.aliasOf(t!!.id))
        }
    }

    @Test
    fun `未知别名返回 null 而不是崩`() {
        // 调用方（DashFragment.applyDesign）据此提示"主题不存在，已保持当前主题"
        assertEquals(null, GaugeTheme.byAlias("不存在的主题"))
        assertEquals(null, GaugeTheme.byAlias(""))
    }

    @Test
    fun `别名与内置主题一一对应`() {
        // 每个内置主题都该有别名 —— 漏一个，那份设计文件导出后主题就丢了
        GaugeTheme.builtIns().forEach { t ->
            assertTrue(
                "内置主题 ${t.title}（id=${t.id}）没有别名",
                GaugeTheme.aliasOf(t.id) != null
            )
        }
    }

    @Test
    fun `别名能写进设计文件并原样往返`() {
        // App 导出时写别名、导入时按别名查回主题 —— 这条把两端接起来。
        // 注意 `data/DesignFile.kt` **不能依赖本层**，所以别名是调用方
        // （DashFragment）传进去的；这里验证的正是那个约定成立。
        //
        // ⚠️ 必须给一块表：`gauges` 为空是硬错误（空设计文件本来就该被拒绝）。
        val g = com.icar.obd.data.GaugeItem(
            pidId = "std_0C", style = com.icar.obd.data.GaugeItem.STYLE_CIRCLE,
            minVal = 0f, maxVal = 8000f, x = 0f, y = 0f, w = 180f, h = 180f
        )
        GaugeTheme.builtIns().forEach { t ->
            val alias = GaugeTheme.aliasOf(t.id)!!
            val json = com.icar.obd.data.DesignFile(
                name = "往返", themeId = alias, gauges = listOf(g)
            ).toJson().toString()

            val parsed = com.icar.obd.data.DesignFile.parse(json)
            assertTrue(parsed.errors.toString(), parsed.ok)
            assertEquals("别名原样往返", alias, parsed.design!!.themeId)
            assertEquals(
                "按别名必须查回同一个主题",
                t.id, GaugeTheme.byAlias(parsed.design!!.themeId)!!.id
            )
        }
    }

    @Test
    fun `自建主题的 id 写进设计文件会被判定为主题不存在`() {
        // 这正是导出时必须留空的原因：自建主题 id 在不同设备上不同，
        // 写进文件后导入端按别名查不到 → 会提示「主题不存在，已保持当前主题」。
        val customId = GaugeTheme.CUSTOM_ID_BASE + 5
        assertEquals(null, GaugeTheme.aliasOf(customId))
        assertEquals(null, GaugeTheme.byAlias(customId.toString()))
    }

    // ================================================================ 主题优先级（v2.32.0）
    //
    // 这段逻辑原来长在 DashFragment.render() 里 —— Fragment 没法单测，
    // 所以「内嵌配色 vs 设置主题」谁优先**一直没验证过**。
    // 抽成 GaugeTheme.resolveFor 之后才能钉住。
    //
    // ⚠️ **刻意避开一类断言**：给颜色字段塞"类型不对的值"（比如字符串）时，
    // `org.json` 的 `optInt` 是"返回默认值"还是"抛异常"各实现不一致 ——
    // 我第一版就是按"返回默认值"写断言，红了两条才发现假设不对。
    // 这类边界靠"不崩就行"来守（见下面那条），不断言具体颜色。

    /** 造一份最小设计文件。themeColors 为 null 时不写这个字段。 */
    private fun dj(themeColors: String?): String {
        val tc = if (themeColors == null) "" else ",\"themeColors\":" + themeColors
        // ⚠️ **必须给一个节点**：`nodes` 为空时 parse 会报**错误**
        //（"`nodes` 是空的 —仪表盘上什么都不会显示"），
        // 那样就测不到"有 themeColors 时怎么走"了。
        val node = "{\"id\":\"g\",\"type\":\"gauge\",\"pid\":\"obd.rpm\"," +
            "\"min\":0,\"max\":8000,\"x\":0,\"y\":0,\"w\":100,\"h\":100}"
        return "{\"schema\":\"icar.ui/2\",\"canvas\":{\"unit\":360}" + tc + ",\"nodes\":[" + node + "]}"
    }

    @Test
    fun `parse 能把 themeColors 读出来（优先级的前提）`() {
        val json = dj("{\"accent\":777}")
        val r = com.icar.obd.data.DesignFile.parse(json)
        assertTrue("parse 不该有错：${r.errors}", r.ok)   // 这里 ok 必须为 true，否则后面几条测的是假路径
        val d = r.design
        assertTrue("design 不该为 null", d != null)
        assertTrue("themeColors 不该为 null，json=$json", d!!.themeColors != null)
        assertTrue("fromJson 不该抛：themeColors=${d.themeColors}",
            runCatching { GaugeTheme.fromJson(d.themeColors!!) }.isSuccess)
        assertEquals(777, GaugeTheme.fromJson(d.themeColors!!).accent)
    }

    @Test
    fun `设计文件为空 —— 用设置里的主题`() {
        assertEquals(GaugeTheme.ICE, GaugeTheme.resolveFor("", GaugeTheme.ICE).id)
    }

    @Test
    fun `设计文件没有 themeColors —— 用设置里的主题`() {
        assertEquals(GaugeTheme.CLASSIC, GaugeTheme.resolveFor(dj(null), GaugeTheme.CLASSIC).id)
    }

    @Test
    fun `有 themeColors —— 内嵌配色优先于设置里的主题`() {
        // 设置里明明是 CLASSIC，但设计文件带了 ICE 的色 → 应当用 ICE 的
        val ice = GaugeTheme.of(GaugeTheme.ICE)
        val json = dj("{\"background\":" + ice.background + ",\"accent\":" + ice.accent + "}")
        val t = GaugeTheme.resolveFor(json, GaugeTheme.CLASSIC)
        assertEquals("内嵌配色应当覆盖设置里的主题", ice.accent, t.accent)
        assertEquals(ice.background, t.background)
    }

    @Test
    fun `themeColors 只给一个字段 —— 那一个生效，其余退回内置霓虹`() {
        val t = GaugeTheme.resolveFor(dj("{\"accent\":12345}"), GaugeTheme.ICE)
        assertEquals(12345, t.accent)
        assertEquals(GaugeTheme.of(GaugeTheme.NEON).background, t.background)
    }

    @Test
    fun `themeColors 是字符串 —— 当成没有，退回设置主题`() {
        assertEquals(GaugeTheme.ICE, GaugeTheme.resolveFor(dj("\"不是对象\""), GaugeTheme.ICE).id)
    }

    @Test
    fun `themeColors 是数组 —— 也当成没有`() {
        assertEquals(GaugeTheme.CLASSIC, GaugeTheme.resolveFor(dj("[1,2,3]"), GaugeTheme.CLASSIC).id)
    }

    @Test
    fun `设计文件是坏 JSON —— 退回设置主题，不抛异常`() {
        assertEquals(GaugeTheme.ICE, GaugeTheme.resolveFor("{ 这不是 JSON", GaugeTheme.ICE).id)
    }

    @Test
    fun `themeColors 里字段类型不对 —— 不崩，且拿到一个可用主题`() {
        // 只守"不崩 + 可用"，**不断言具体颜色**（见文件头那段说明）
        val t = GaugeTheme.resolveFor(dj("{\"background\":\"#FF0000\",\"accent\":777}"), GaugeTheme.ICE)
        assertTrue("应当拿到主题标题", t.title.isNotEmpty())
        assertTrue("浮点字段应当有限", t.cardRadiusDp.isFinite())
    }

    @Test
    fun `内嵌配色与"不存在的主题 id"共存 —— 内嵌仍然优先`() {
        // 自建主题没有稳定别名，设计文件的 theme 字段指不到它；
        // 带 themeColors 时更不该去看设置。给一个越界的 settingsId 也一样。
        val ice = GaugeTheme.of(GaugeTheme.ICE)
        val json = dj("{\"accent\":" + ice.accent + "}")
        assertEquals(ice.accent, GaugeTheme.resolveFor(json, 9999).accent)
    }

    @Test
    fun `settingsId 越界且没有内嵌配色 —— 退回内置第一个（霓虹）`() {
        assertEquals(GaugeTheme.NEON, GaugeTheme.resolveFor(dj(null), 9999).id)
    }

}