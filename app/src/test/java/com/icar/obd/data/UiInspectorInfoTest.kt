package com.icar.obd.data

import com.icar.obd.data.UiInspectorInfo.InspectorSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **控件检视器**的显示内容单测（规格 `docs/下一步-控件检视器.md` §6）。
 *
 * ## 为什么只测 `data/UiInspectorInfo`
 *
 * View 在 JVM 里碰不得（`android.jar` 是抛 `Stub!` 的桩），所以规格要求
 * 「把"像素→dp/sp 换算"与"父链字符串拼装"抽成**纯函数**再测」。
 * 于是可测的部分全在 [UiInspectorInfo]，而"读 View"那一半
 * （`ui/view/UiInspectorOverlay.snapshotOf`）只能装机验 —— 这一点在报告里如实写明。
 *
 * ## 这一组用例真正在守什么
 *
 * 1. **格式不许漂**：面板上每一行都是用户要抄走的，改一个字符就是"文档与界面对不上"；
 * 2. **"拿不到就说（无），不要编"**（规格 §3）—— 尤其是 `wrap_content` 控件
 *    必须标"实测"，不能拿一个 0 冒充"声明的尺寸"；
 * 3. **id 必须是资源名**（规格 §5）—— 数字对用户毫无用处；
 * 4. **落盘纪律**：检视开关**不许**进 `settings.json`（见 `UiInspectorOverlay.enabled`）。
 */
class UiInspectorInfoTest {

    // ------------------------------------------------------------ 数值换算

    @Test
    fun `整数不写小数点，小数保留一位`() {
        assertEquals("12", UiInspectorInfo.num(12.0f))
        assertEquals("12.5", UiInspectorInfo.num(12.5f))
        assertEquals("0", UiInspectorInfo.num(0f))
        assertEquals("-4", UiInspectorInfo.num(-4f))
    }

    @Test
    fun `非法浮点不产生 NaN 字样`() {
        // 面板上出现 "NaN" 就是"编了一个数字"，宁可写（无）
        assertEquals(UiInspectorInfo.NONE, UiInspectorInfo.num(Float.NaN))
        assertEquals(UiInspectorInfo.NONE, UiInspectorInfo.num(Float.POSITIVE_INFINITY))
    }

    @Test
    fun `像素转 dp 用 density`() {
        assertEquals("12", UiInspectorInfo.dp(24, 2f))
        assertEquals("12.5", UiInspectorInfo.dp(25, 2f))
        assertEquals("24", UiInspectorInfo.dp(24, 1f))
    }

    @Test
    fun `密度拿不到时退回像素并标出 px`() {
        // 宁可显示 "24px"，也不能拿 0 密度除出 Infinity 摆给用户看
        assertEquals("24px", UiInspectorInfo.dp(24, 0f))
        assertEquals("24px", UiInspectorInfo.dp(24, -1f))
    }

    @Test
    fun `像素转 sp 用 scaledDensity`() {
        assertEquals("14", UiInspectorInfo.sp(28f, 2f))
        assertEquals("14", UiInspectorInfo.sp(14f, 1f))
    }

    @Test
    fun `颜色不透明时不写 FF`() {
        assertEquals("#E8EEF7", UiInspectorInfo.colorHex(0xFFE8EEF7.toInt()))
        assertEquals("#000000", UiInspectorInfo.colorHex(0xFF000000.toInt()))
        // 带透明度才写满 8 位 —— 半透明色少写两位就读不出"它是半透明的"
        assertEquals("#80FF0000", UiInspectorInfo.colorHex(0x80FF0000.toInt()))
    }

    @Test
    fun `声明宽高的三种形态`() {
        assertEquals("MATCH_PARENT", UiInspectorInfo.specName(-1, 2f))
        assertEquals("WRAP_CONTENT", UiInspectorInfo.specName(-2, 2f))
        assertEquals("40dp", UiInspectorInfo.specName(80, 2f))
    }

    // ------------------------------------------------------------ 尺寸 / 边距

    @Test
    fun `宽高都声明成固定值时才写声明`() {
        assertEquals(
            "尺寸 120×40dp（声明）",
            UiInspectorInfo.sizeLine(240, 80, 2f, 240, 80)
        )
    }

    @Test
    fun `wrap_content 的控件标实测并把声明值摆出来`() {
        // 规格 §3：wrap_content 没有固定宽高 → 显示实测像素并标注"实测"
        assertEquals(
            "尺寸 120×40dp（实测；声明 WRAP_CONTENT × 40dp）",
            UiInspectorInfo.sizeLine(240, 80, 2f, -2, 80)
        )
        assertEquals(
            "尺寸 120×40dp（实测；声明 MATCH_PARENT × WRAP_CONTENT）",
            UiInspectorInfo.sizeLine(240, 80, 2f, -1, -2)
        )
    }

    @Test
    fun `四边数值顺序是左上右下`() {
        assertEquals("8/8/0/0", UiInspectorInfo.quad(16, 16, 0, 0, 2f))
        assertEquals("边距 8/8/0/0", UiInspectorInfo.boxLine("边距", 16, 16, 0, 0, 2f))
        assertEquals(
            "内边距 12/12/12/12",
            UiInspectorInfo.boxLine("内边距", 24, 24, 24, 24, 2f)
        )
    }

    // ------------------------------------------------------------ 字号 / 背景 / 状态

    @Test
    fun `字号行同时给出 sp 与颜色`() {
        assertEquals(
            "字号 14sp  色 #E8EEF7",
            UiInspectorInfo.textLine(28f, 0xFFE8EEF7.toInt(), 2f)
        )
    }

    @Test
    fun `非文本控件也要出字号行，明说无`() {
        // 少一行会让人以为"面板漏了"；（无）明确说的是"这个控件没有字号"
        assertEquals("字号 （无）  色 （无）", UiInspectorInfo.textLine(null, null, 2f))
    }

    @Test
    fun `背景优先给资源名，其次类名，最后才是无`() {
        assertEquals(
            "背景 @drawable/bg_input",
            UiInspectorInfo.backgroundLine("com.icar.obd:drawable/bg_input", "GradientDrawable")
        )
        assertEquals(
            "背景 GradientDrawable（无资源名）",
            UiInspectorInfo.backgroundLine(null, "GradientDrawable")
        )
        assertEquals("背景 （无）", UiInspectorInfo.backgroundLine(null, null))
    }

    @Test
    fun `资源名长名字缩成 @类型-名字`() {
        assertEquals(
            "@drawable/bg_card",
            UiInspectorInfo.shortResName("com.icar.obd:drawable/bg_card")
        )
        assertEquals(
            "@color/text_primary",
            UiInspectorInfo.shortResName("com.icar.obd:color/text_primary")
        )
        // 认不出来的形态原样返回（不猜）
        assertEquals("whatever", UiInspectorInfo.shortResName("whatever"))
        assertNull(UiInspectorInfo.shortResName(null))
        assertNull(UiInspectorInfo.shortResName(""))
    }

    @Test
    fun `可见性的三个值`() {
        assertEquals("可见 VISIBLE  可用 true", UiInspectorInfo.stateLine(0, true))
        assertEquals("可见 INVISIBLE  可用 false", UiInspectorInfo.stateLine(4, false))
        assertEquals("可见 GONE  可用 true", UiInspectorInfo.stateLine(8, true))
    }

    // ------------------------------------------------------------ 父链

    @Test
    fun `父链从根到该控件`() {
        assertEquals(
            "层级 LinearLayout > ScrollView > Button",
            UiInspectorInfo.chainLine(listOf("LinearLayout", "ScrollView", "Button"))
        )
    }

    @Test
    fun `父链深了从中间省略，保留最近两层`() {
        // 尾巴（最近两层）才是判断"这是谁的子控件"最需要的，所以砍中间
        assertEquals(
            "层级 A > B > … > D > E",
            UiInspectorInfo.chainLine(listOf("A", "B", "C", "D", "E"))
        )
    }

    @Test
    fun `父链太长时从头部丢，尾部永远完整`() {
        // 实测踩过：第一版从**尾巴**砍，结果最有用的一段显示成 "… > M…"
        // （MaterialTextView 被砍成 M…），等于什么都没说
        val line = UiInspectorInfo.chainLine(
            listOf(
                "ContentFrameLayout", "FrameLayout", "LinearLayout", "NestedScrollView",
                "LinearLayout", "LinearLayout", "MaterialTextView"
            )
        )
        assertTrue("尾部必须完整：$line", line.endsWith("MaterialTextView"))
        assertTrue("超长要省略：$line", line.contains("…"))
        assertTrue("长度要收敛：${line.length}", line.length <= 60)
        assertFalse("不该出现两个连着的省略号：$line", line.contains("… > …"))
    }

    @Test
    fun `父链为空时明说无`() {
        assertEquals("层级 （无）", UiInspectorInfo.chainLine(emptyList()))
        assertEquals("层级 （无）", UiInspectorInfo.chainLine(listOf("", "  ")))
    }

    @Test
    fun `超长类名本身会被截断`() {
        val long = "VeryLongClassName".repeat(5)
        val line = UiInspectorInfo.chainLine(listOf(long))
        assertTrue("必须截断", line.length < long.length + 3)
        assertTrue("截断要留省略号", line.endsWith("…"))
        assertTrue(line.startsWith("层级 "))
    }

    // ------------------------------------------------------------ 可选行

    @Test
    fun `可选行没值就整行不出现`() {
        assertNull(UiInspectorInfo.optLine("权重", null))
        assertNull(UiInspectorInfo.optLine("权重", ""))
        assertEquals("gravity center_v", UiInspectorInfo.optLine("gravity", "center_v"))
    }

    @Test
    fun `权重为零不出现`() {
        // 0 是 LinearLayout.LayoutParams 的默认值 —— 每个子控件都写"权重 0"只是噪声
        assertNull(UiInspectorInfo.optNumLine("权重", 0f))
        assertNull(UiInspectorInfo.optNumLine("权重", null))
        assertEquals("权重 1", UiInspectorInfo.optNumLine("权重", 1f))
        assertEquals("权重 1.5", UiInspectorInfo.optNumLine("权重", 1.5f))
    }

    // ------------------------------------------------------------ id（规格 §5）

    @Test
    fun `没有 id 时明说无 id`() {
        assertEquals(UiInspectorInfo.NO_ID, UiInspectorInfo.idLine(null))
        assertEquals(UiInspectorInfo.NO_ID, UiInspectorInfo.idLine(""))
        assertEquals(UiInspectorInfo.NO_ID, UiInspectorInfo.idLine("   "))
    }

    @Test
    fun `有 id 时给资源名而不是数字`() {
        // 规格 §5：用户拿这个 id 去 UI样式与排版总表.md 里搜 文件:行 —— 数字搜不到任何东西
        assertEquals("btnGestures", UiInspectorInfo.idLine("btnGestures"))
    }

    // ------------------------------------------------------------ 整体渲染

    /** 规格 §3 的那张示意图，逐行落成用例 */
    private fun sample() = InspectorSnapshot(
        typeName = "Button",
        idEntry = "btnGestures",
        widthPx = 240,
        heightPx = 80,
        declaredW = 240,
        declaredH = 80,
        margin = listOf(16, 16, 0, 0),
        padding = listOf(24, 24, 24, 24),
        textSizePx = 28f,
        textColor = 0xFFE8EEF7.toInt(),
        bgResName = "com.icar.obd:drawable/bg_input",
        bgClassName = "GradientDrawable",
        visibility = 0,
        enabled = true,
        chain = listOf("LinearLayout", "ScrollView", "Button"),
        density = 2f,
        scaledDensity = 2f,
    )

    @Test
    fun `面板内容与规格示意图逐行一致`() {
        assertEquals(
            listOf(
                "Button",
                "btnGestures",
                "尺寸 120×40dp（声明）  边距 8/8/0/0",
                "内边距 12/12/12/12",
                "字号 14sp  色 #E8EEF7",
                "背景 @drawable/bg_input",
                "可见 VISIBLE  可用 true",
                "层级 LinearLayout > ScrollView > Button",
            ),
            UiInspectorInfo.render(sample())
        )
    }

    @Test
    fun `正文是整体渲染去掉前两行`() {
        // 面板把类型放标题行、id 放黄色行，正文只要剩下的 ——
        // 抽成函数是为了让"面板显示的"与"单测断言的"永远同一份
        val all = UiInspectorInfo.render(sample())
        assertEquals(all.drop(2), UiInspectorInfo.renderBody(sample()))
    }

    @Test
    fun `可选行插在层级之前`() {
        val s = sample().copy(weight = 1f, gravityText = "center_v", maxWidthPx = 1440)
        val lines = UiInspectorInfo.render(s)
        val iWeight = lines.indexOf("权重 1")
        val iGravity = lines.indexOf("gravity center_v")
        val iMax = lines.indexOf("限宽 720dp")
        val iChain = lines.indexOfFirst { it.startsWith("层级 ") }
        assertTrue("权重行要在", iWeight > 0)
        assertTrue("gravity 行要在", iGravity > 0)
        assertTrue("限宽行要在", iMax > 0)
        assertTrue("三行都要在层级之前", iWeight < iChain && iGravity < iChain && iMax < iChain)
    }

    @Test
    fun `没有可选值时一行都不多`() {
        val lines = UiInspectorInfo.render(sample())
        assertEquals("没有 weight/gravity/限宽 时不许冒出额外行", 8, lines.size)
    }

    @Test
    fun `仪表盘自绘区必须给出提示`() {
        // 规格 §8：不让用户以为"点了表盘没反应 = 坏了"
        val lines = UiInspectorInfo.render(sample().copy(typeName = "CircularGaugeView", selfDrawn = true))
        assertTrue(lines.contains(UiInspectorInfo.HINT_SELF_DRAWN))
        assertEquals("提示加在最后一行", UiInspectorInfo.HINT_SELF_DRAWN, lines.last())
    }

    @Test
    fun `四边数组缺项时兜成 0 而不是少几个数`() {
        val s = sample().copy(margin = listOf(16), padding = emptyList())
        val lines = UiInspectorInfo.render(s)
        assertTrue(lines[2].endsWith("边距 8/0/0/0"))
        assertTrue(lines[3].startsWith("内边距 0/0/0/0"))
    }

    // ------------------------------------------------------------ 剪贴板

    @Test
    fun `剪贴板文本带版本头`() {
        val text = UiInspectorInfo.clipboardText(listOf("Button", "btnGestures"), "控件检视 · 1.20.14")
        assertEquals("控件检视 · 1.20.14\nButton\nbtnGestures", text)
    }

    @Test
    fun `剪贴板没头时不留下空行`() {
        assertEquals("A\nB", UiInspectorInfo.clipboardText(listOf("A", "B")))
    }

    // ------------------------------------------------------------ 落盘纪律

    @Test
    fun `检视开关不许进 settings_json`() {
        // ⚠️ 这条守的是"装完就点不动"那个灾难：
        // 开关一开，App 就把全部触摸消费掉；若它跟着 settings.json 活到下次启动，
        // 用户打开 App 会点哪儿都没反应，只能以为"装坏了"。
        // 所以状态在 UiInspectorOverlay.enabled（进程内），**不在** Store.Settings。
        val json = Store.settingsToJson()
        assertFalse(
            "settings.json 里不许出现检视开关",
            json.keys().asSequence().any { it.contains("inspector", ignoreCase = true) }
        )
    }
}
