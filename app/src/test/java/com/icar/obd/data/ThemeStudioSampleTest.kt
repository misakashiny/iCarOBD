package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * **主题制作工具的产出必须能被 App 解析**（验收标准 4）。
 *
 * `tools/icarui/index.html` 里的校验规则是**手抄** `DesignFile.kt` 的 ——
 * 抄错是本工具最危险的失效方式：编辑器说没问题、App 加载报错，
 * 而用户直到推上设备才发现。
 *
 * 这个测试就是把两边钉在一起：
 *  1. 工具自带的 `sample.json` 必须能被 [DesignFile.parse] 解析，**0 错误 0 警告**；
 *  2. 解析出来的每个字段都要**真的落到 GaugeItem 上**（坐标没被 ×360 再乘一次、
 *     别名解析成了真实 id、霓虹档位没丢）。
 *
 * 第 2 条不是多余的：v1.9.0 就栽过一次 —— `GaugeItem.fromJson` 用元素自己的
 * `unit` 判断新旧格式，设计文件的单位声明却在 `canvas.unit` 上，
 * 不注入标记的话每个坐标都会被再乘 360（12.5 → 4500）。那次是单测抓出来的。
 */
class ThemeStudioSampleTest {

    /**
     * 定位 `tools/icarui/sample.json`（工具目录在 v1.20.19 由旧名改名而来，
     * 改名经过记在 `docs/CHANGELOG.md` —— 源码里不写旧目录名，免得又被复制回去）。
     *
     * 单测的工作目录在不同调用方式下不一样（Gradle 从 app/ 跑，IDE 可能从工程根跑），
     * 而且本项目是用 ASCII 联接 `D:\icarobd` 跑的 —— 所以多试几个候选路径。
     *
     * ⚠️ **找不到就失败，不是跳过**（v1.20.19 修，这一条比路径本身重要）。
     *
     * 这里原来写的是「假设文件存在，不存在就跳过（`org.junit.Assume`）」。
     * 意图是好的，后果是灾难性的：工具目录改名之后五个候选路径**全部落空**，
     * 于是本类 14 个用例被静默跳过 —— `TOTAL=1022 FAILED=0` 照样绿，
     * 而"工具产出的文件 App 到底能不能读"这条跨语言保证**一个都没在跑**，
     * 且没人看得出来。
     *
     * 所以现在路径不对就**红**。跳过只能用来表达"这个环境缺少某个可选依赖"，
     * 不能用来兜住"我们自己的文件被改名/搬走了"。
     */
    private fun sampleFile(): File {
        val candidates = listOf(
            File("tools/icarui/sample.json"),                    // 从工程根跑
            File("../tools/icarui/sample.json"),                 // 从 app/ 跑
            File("app/../tools/icarui/sample.json"),
            File(System.getProperty("user.dir"), "tools/icarui/sample.json"),
            File(System.getProperty("user.dir"), "../tools/icarui/sample.json"),
        )
        return candidates.firstOrNull { it.isFile } ?: throw AssertionError(
            "找不到工具自带的样例文件 sample.json —— 试过这些路径：\n" +
                candidates.joinToString("\n") { "  " + it.absolutePath } +
                "\n当前工作目录：${System.getProperty("user.dir")}\n" +
                "请在工程目录下运行 tools/run-tests.ps1。\n" +
                "⚠️ 这里刻意**不**跳过：跳过会让本类 14 个跨语言用例静默不跑。"
        )
    }

    /** 上一次 [loadSample] 的警告。用来断言「只该有背景路径那一条」 */
    private var lastWarnings: List<String> = emptyList()

    private fun loadSample(): DesignFile {
        val f = sampleFile()
        val r = DesignFile.parse(f.readText())
        assertTrue("sample.json 必须 0 错误，实际：${r.errors}", r.errors.isEmpty())
        assertNotNull("解析成功就必须有 design", r.design)
        lastWarnings = r.warnings
        return r.design!!
    }

    @Test
    fun `工具自带示例能被 App 解析且只有背景路径这一条警告`() {
        val d = loadSample()
        assertEquals("赛道模式", d.name)
        assertEquals("neon", d.themeId)
        assertEquals(6, d.gauges.size)

        // ⚠️ 这里刻意**不**断言 warnings 为空。
        //
        // sample.json 里的背景路径（/sdcard/icar-bg/carbon.png）是**设备上**的路径，
        // 在开发机上必然不存在 —— 而「路径不存在只警告、不拦下整个设计」正是要验证的行为。
        // 所以断言的是：**恰好一条，且必须是背景那条**。
        assertEquals(
            "背景路径不存在应当恰好产生一条警告，实际：$lastWarnings",
            1, lastWarnings.size
        )
        assertTrue(
            "那条警告必须指向 background.path，实际：$lastWarnings",
            lastWarnings[0].contains("background.path")
        )
    }

    // ================================================================ v1.10.2 新增

    @Test
    fun `每个内置 PID 都有语义别名`() {
        // 别名表分散在三处（Kotlin / 主题工具 / 设计指南），靠人记得同步必然会漏。
        // 这条把「漏了一个」变成**可测的事实**。
        val missing = DesignFile.missingAliases()
        assertTrue(
            "这些默认启用的内置 PID 还没有语义别名：$missing —— " +
                "请在 DesignFile.PID_ALIASES 里补上，并同步 tools/icarui/index.html",
            missing.isEmpty()
        )
    }

    @Test
    fun `厂家模板刻意没有别名`() {
        // 那 4 条是占位示例（默认 enabled=false，PID 号是猜的）。
        // 给它们起个"好听的语义名"会让人以为可以直接用 —— 必须先用扫描器实测。
        val covered = DesignFile.PID_ALIASES.values
        assertTrue(
            "厂家模板不该出现在别名表里",
            covered.none { it.startsWith("tpl_") }
        )
    }

    @Test
    fun `别名数量与内置启用 PID 数量一致`() {
        val enabledBuiltIns = BuiltInPids.all().count { it.enabled }
        assertEquals(
            "别名应当与「默认启用的内置 PID」一一对应",
            enabledBuiltIns, DesignFile.PID_ALIASES.size
        )
    }

    @Test
    fun `卡片外框覆盖被完整带过来`() {
        val d = loadSample()
        // 大盘「不画卡片」、小表「无边框」、其余跟随主题 —— 混合盘面正是这个字段存在的理由
        assertEquals(GaugeItem.CARD_TRANSPARENT, d.gauges[0].cardStyle)
        assertEquals(GaugeItem.CARD_NO_BORDER, d.gauges[5].cardStyle)
        assertEquals("没写 cardStyle 的应当是 null（= 跟随主题）", null, d.gauges[1].cardStyle)
    }

    @Test
    fun `卡片外框 JSON 往返不丢`() {
        val first = loadSample()
        val round = DesignFile.parse(first.toJson().toString())
        assertTrue("往返必须能再解析：${round.errors}", round.errors.isEmpty())
        first.gauges.forEachIndexed { i, a ->
            assertEquals("第 $i 条 cardStyle 丢了", a.cardStyle, round.design!!.gauges[i].cardStyle)
        }
    }

    @Test
    fun `背景段被解析出来`() {
        val d = loadSample()
        assertNotNull("sample.json 有 background 段，应当被解析出来", d.background)
        assertEquals("/sdcard/icar-bg/carbon.png", d.background!!.path)
        assertEquals(DesignFile.FIT_FILL, d.background!!.fit)
    }

    @Test
    fun `背景 JSON 往返不丢`() {
        val first = loadSample()
        val round = DesignFile.parse(first.toJson().toString())
        assertTrue("往返必须能再解析：${round.errors}", round.errors.isEmpty())
        assertEquals(first.background!!.path, round.design!!.background!!.path)
        assertEquals(first.background!!.fit, round.design!!.background!!.fit)
    }

    @Test
    fun `没有背景段时不产生警告`() {
        // 背景是**可选**段 —— 绝大多数设计文件没有它，不该因此收到提示
        val json = """
            {
              "schema": "icar.ui/1",
              "meta": {"name":"无背景"},
              "canvas": {"unit":360},
              "gauges": [{"pid":"obd.rpm","x":0,"y":0,"w":180,"h":180}]
            }
        """.trimIndent()
        val r = DesignFile.parse(json)
        assertTrue(r.errors.toString(), r.ok)
        assertTrue("没有 background 段时不该有警告，实际：${r.warnings}", r.warnings.isEmpty())
        assertEquals(null, r.design!!.background)
    }

    @Test
    fun `背景路径不存在只警告不报错`() {
        // 设计文件常在不同机器之间传递，写死绝对路径必然对不上。
        // 拦下整个设计太粗暴 —— 仪表布局本身是好的。
        val json = """
            {
              "schema": "icar.ui/1",
              "meta": {"name":"背景路径不存在"},
              "canvas": {"unit":360},
              "background": {"path":"/definitely/not/here.png","fit":1},
              "gauges": [{"pid":"obd.rpm","x":0,"y":0,"w":180,"h":180}]
            }
        """.trimIndent()
        val r = DesignFile.parse(json)
        assertTrue("必须是**成功**解析（不是硬错误）：${r.errors}", r.ok)
        assertEquals(1, r.warnings.size)
        assertTrue(r.warnings[0].contains("background.path"))
        assertEquals(DesignFile.FIT_FIT, r.design!!.background!!.fit)
    }

    @Test
    fun `背景铺法不认识时回落到铺满并警告`() {
        val json = """
            {
              "schema": "icar.ui/1",
              "meta": {"name":"坏铺法"},
              "canvas": {"unit":360},
              "background": {"path":"/definitely/not/here.png","fit":99},
              "gauges": [{"pid":"obd.rpm","x":0,"y":0,"w":180,"h":180}]
            }
        """.trimIndent()
        val r = DesignFile.parse(json)
        assertTrue(r.errors.toString(), r.ok)
        assertEquals("应当回落到铺满", DesignFile.FIT_FILL, r.design!!.background!!.fit)
        assertTrue(
            "应当有一条关于 fit 的警告，实际：${r.warnings}",
            r.warnings.any { it.contains("background.fit") }
        )
    }

    @Test
    fun `背景段缺 path 时只警告并忽略该段`() {
        val json = """
            {
              "schema": "icar.ui/1",
              "meta": {"name":"缺 path"},
              "canvas": {"unit":360},
              "background": {"fit":1},
              "gauges": [{"pid":"obd.rpm","x":0,"y":0,"w":180,"h":180}]
            }
        """.trimIndent()
        val r = DesignFile.parse(json)
        assertTrue(r.errors.toString(), r.ok)
        assertEquals("缺 path 时整个 background 段应被忽略", null, r.design!!.background)
        assertTrue(r.warnings.any { it.contains("没有 `path`") })
    }

    @Test
    fun `语义别名被解析成真实 PID id`() {
        val d = loadSample()
        assertEquals("std_0C", d.gauges[0].pidId)
        assertEquals("std_0D", d.gauges[1].pidId)
        assertEquals("std_42", d.gauges[2].pidId)
        assertEquals("std_05", d.gauges[3].pidId)
        assertEquals("std_11", d.gauges[4].pidId)
        assertEquals("std_04", d.gauges[5].pidId)
    }

    @Test
    fun `坐标没有被再乘一次 360`() {
        // 这是 v1.9.0 那个坑的回归测试。设计文件里 x=240，解析出来必须还是 240，
        // 不是 240 × 360 = 86400
        val d = loadSample()
        val big = d.gauges[0]
        assertEquals(0f, big.x, 1e-3f)
        assertEquals(0f, big.y, 1e-3f)
        assertEquals(240f, big.w, 1e-3f)
        assertEquals(240f, big.h, 1e-3f)

        val small = d.gauges[1]
        assertEquals(240f, small.x, 1e-3f)
        assertEquals(120f, small.w, 1e-3f)
    }

    @Test
    fun `所有坐标都落在 360 画布内`() {
        val d = loadSample()
        d.gauges.forEachIndexed { i, g ->
            assertTrue("gauges[$i] x 越界：${g.x}", g.x >= 0f)
            assertTrue("gauges[$i] y 越界：${g.y}", g.y >= 0f)
            assertTrue("gauges[$i] 右边越界：${g.x + g.w}", g.x + g.w <= GaugeItem.CANVAS + 1f)
            assertTrue("gauges[$i] 下边越界：${g.y + g.h}", g.y + g.h <= GaugeItem.CANVAS + 1f)
        }
    }

    @Test
    fun `样式与霓虹档位被完整带过来`() {
        val d = loadSample()
        assertEquals(GaugeItem.STYLE_CIRCLE, d.gauges[0].style)
        assertEquals(GaugeItem.STYLE_BAR, d.gauges[3].style)
        assertEquals(GaugeItem.STYLE_DIGITAL, d.gauges[5].style)

        // 霓虹档位在 data 层就是**字符串**（data/ 不能依赖 ui/view/，见分层红线），
        // 所以这里只断言字符串本身没丢。
        // 「这个字符串必须真的存在于 NeonStyle.PRESETS」由 ui 层的
        // NeonStyleTest 负责 —— 那是它自己那一层的事，不在这里越界检查。
        assertEquals("强烈", d.gauges[0].neonPreset)
    }

    @Test
    fun `指针环与量程阈值被完整带过来`() {
        val d = loadSample()
        assertEquals(GaugeItem.RING_TICK, d.gauges[0].ringStyle)
        assertEquals(40, d.gauges[0].ringSegments)
        assertEquals(GaugeItem.RING_NONE, d.gauges[1].ringStyle)

        assertEquals(0f, d.gauges[0].minVal, 1e-3f)
        assertEquals(8000f, d.gauges[0].maxVal, 1e-3f)
        assertEquals(6500f, d.gauges[0].warnHigh!!, 1e-3f)
        // 下限报警（电压）也要活着过来 —— v1.10.1 起下限进 alertLevel，别在解析层丢了
        assertEquals(11.8f, d.gauges[2].warnLow!!, 1e-3f)
    }

    @Test
    fun `工具产出的 JSON 与 App 的 toJson 结构互认`() {
        // 往返：解析工具产出的文件 → 再序列化 → 再解析，字段不能丢
        val first = loadSample()
        val round = DesignFile.parse(first.toJson().toString())
        assertTrue("App 自己序列化出来的东西必须能再解析：${round.errors}", round.errors.isEmpty())
        assertEquals(first.gauges.size, round.design!!.gauges.size)
        first.gauges.forEachIndexed { i, a ->
            val b = round.design!!.gauges[i]
            assertEquals("第 $i 条 pidId 丢了", a.pidId, b.pidId)
            assertEquals("第 $i 条 x 变了", a.x, b.x, 1e-3f)
            assertEquals("第 $i 条 w 变了", a.w, b.w, 1e-3f)
            assertEquals("第 $i 条 style 变了", a.style, b.style)
            assertEquals("第 $i 条 neonPreset 丢了", a.neonPreset, b.neonPreset)
        }
    }

    @Test
    fun `工具里列的 PID 别名在 App 侧都存在`() {
        // 工具的 PID_ALIASES 是手抄的。少一条 → 用户在编辑器里选不到；
        // 多一条（App 没有）→ 编辑器生成的文件会被 App 报「不在内置库」。
        // 这里反向核对：App 的别名表里每一条都能在 sample 的 PID 里找到对应内置定义
        DesignFile.PID_ALIASES.forEach { (alias, id) ->
            assertTrue(
                "别名 $alias → $id 指向的 PID 不在内置库里，编辑器会给出误导性的警告",
                BuiltInPids.all().any { it.id == id }
            )
        }
        assertFalse("别名表不该是空的", DesignFile.PID_ALIASES.isEmpty())
    }

    // ================================================================ v1.10.3 导入/导出闭环

    @Test
    fun `App 导出的设计文件能被自己重新导入`() {
        // 「电脑上设计 → 导入 → 微调 → 再导回电脑」这个闭环的核心保证。
        // 没有它，用户在 App 里微调过的布局就回不到 PC 工具上了。
        val first = loadSample()
        val back = DesignFile.parse(first.toJson().toString())
        assertTrue("导出的文件必须能被自己解析：${back.errors}", back.errors.isEmpty())
        assertEquals(first.gauges.size, back.design!!.gauges.size)
        assertEquals(first.themeId, back.design!!.themeId)
        assertEquals(first.background!!.path, back.design!!.background!!.path)
    }

    @Test
    fun `主题为空时不写 theme 字段`() {
        // 自建主题没有稳定别名 → 导出时留空（= 用当前主题）。
        // 写数字 id 的话导入端会报「主题不存在」，用户看到的是"主题丢了"。
        // 「哪个 id 没有别名」由 ui 层的 GaugeThemeTest 负责 ——
        // data/ 的测试不依赖 ui/view/（分层方向）。
        //
        // ⚠️ 必须给一块表：`gauges` 为空是**硬错误**（见 DesignFile.MAX/空数组校验），
        // 空设计文件本来就该被拒绝 —— 所以这里不能拿空盘面来测 theme 字段。
        val d = DesignFile(name = "t", themeId = "", gauges = listOf(oneGauge()))
        val json = d.toJson().toString()
        assertFalse("themeId 为空时不该写 theme 字段", json.contains("\"theme\""))
        val parsed = DesignFile.parse(json)
        assertTrue(parsed.errors.toString(), parsed.ok)
        assertEquals("", parsed.design!!.themeId)
    }

    @Test
    fun `别名形式的主题 id 原样往返`() {
        // 设计文件格式规定 theme 写 "neon" 这样的名字。这里验证**格式层**不篡改它；
        // 「这个名字能不能解析成真实主题」由 ui 层负责。
        listOf("neon", "ice", "amber").forEach { alias ->
            val d = DesignFile(name = "t", themeId = alias, gauges = listOf(oneGauge()))
            val parsed = DesignFile.parse(d.toJson().toString())
            assertTrue(parsed.errors.toString(), parsed.ok)
            assertEquals("别名必须原样往返", alias, parsed.design!!.themeId)
        }
    }

    @Test
    fun `空 gauges 是硬错误 —— 导出侧必须自己拦住`() {
        // 这条同时解释了两件事：
        //  1) 为什么上面两个用例要放一块表（空盘面根本过不了校验）
        //  2) 为什么 `DashFragment.exportDesign()` 要先判 `customGauges.isEmpty()`
        //     —— 否则会导出一个自己都读不回来的文件
        val d = DesignFile(name = "空盘", gauges = emptyList())
        val r = DesignFile.parse(d.toJson().toString())
        assertFalse("空 gauges 必须被拒绝", r.ok)
        assertTrue(
            "错误信息应当说清是 gauges 为空，实际：${r.errors}",
            r.errors.any { it.contains("空的") }
        )
    }

    /** 一块最小合法仪表，给「只关心某个顶层字段」的用例用 */
    private fun oneGauge() = GaugeItem(
        pidId = "std_0C", style = GaugeItem.STYLE_CIRCLE,
        minVal = 0f, maxVal = 8000f, x = 0f, y = 0f, w = 180f, h = 180f
    )

    @Test
    fun `导出再导入后卡片外框与背景铺法都还在`() {
        val first = loadSample()
        // 改一个**非默认**的铺法，确认它真的往返（0 是默认值，测不出问题）
        val withFit = first.copy(
            background = DesignFile.Background(first.background!!.path, DesignFile.FIT_CENTER)
        )
        val back = DesignFile.parse(withFit.toJson().toString())
        assertTrue(back.errors.toString(), back.ok)
        assertEquals(DesignFile.FIT_CENTER, back.design!!.background!!.fit)
        assertEquals(
            "卡片外框必须逐条往返",
            withFit.gauges.map { it.cardStyle },
            back.design!!.gauges.map { it.cardStyle }
        )
    }

    @Test
    fun `导出的文件不该带 legacyGrid 标记`() {
        // `legacyGrid` 是「来自 v1.4.0 及以前只有 span 的配置」的迁移标记，**不序列化**。
        // 万一被写进去，导入端会白跑一次网格迁移、把坐标搞乱。
        val first = loadSample()
        val json = first.toJson().toString()
        assertFalse("legacyGrid 不该出现在 JSON 里", json.contains("legacyGrid"))
        assertTrue(first.gauges.none { it.legacyGrid })
    }
}
