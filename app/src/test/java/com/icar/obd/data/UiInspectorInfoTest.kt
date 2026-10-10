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

    // ------------------------------------------------------------ 父链：死循环回归（v1.20.15 ANR）

    /**
     * 🔴 **这一条是 v1.20.14 那个卡死级 ANR 的回归测试**（不是"顺手加的一条"）。
     *
     * ## 故障现场（真机 7e7d7bb4 / Android 13，`logcat` 原文）
     *
     * ```
     * I am_anr: [0,15409,com.icar.obd,... Input dispatching timed out
     *            (... Waited 5000ms for MotionEvent(action=DOWN))]
     * W MIUIScout App: at com.icar.obd.data.UiInspectorInfo.chainLine(UiInspectorInfo.kt:226)
     *                  at ...UiInspectorInfo.render(UiInspectorInfo.kt:324)
     *                  at ...UiInspectorInfo.renderBody(UiInspectorInfo.kt:342)
     *                  at ...UiInspectorOverlay.inspect(UiInspectorOverlay.kt:190)
     *                  at ...MainActivity.consumeForInspector(MainActivity.kt:904)
     *                  at ...MainActivity.dispatchTouchEvent(MainActivity.kt:631)
     * ```
     *
     * ## 旧实现为什么会死循环
     *
     * `while (parts.size > 2 && body.length > CHAIN_MAX)` 每轮
     * `rest = parts.drop(1)` → 去掉开头省略号 → `parts = [省略号] + rest`。
     * 第一轮之后 `parts` 的头**就是省略号**，`drop(1)` 只丢掉那个标记，
     * 下一行又原样加回来 —— `parts`/`body` 是**不动点**，长度永远 > 56 → **永不退出**。
     *
     * ## 为什么必须带 `timeout`
     *
     * 死循环在 JVM 单测里的表现不是"断言失败"，而是**整个测试进程挂住**
     * （Gradle 看起来像卡死，不报错）—— 没有 timeout 的话这条用例会把
     * `run-tests.ps1` 变成"跑不完"，那比失败更难查。
     * `timeout` 一超时就是 `TestTimedOutException` → **失败**，这才是能报警的形态。
     *
     * ## 这条输入是**算出来的**，不是抄来的
     *
     * 折叠成 5 段后 `|c1| + |c_{n-2}| + |c_{n-1}| > 42` 就进死循环。
     * 下面这串：`LinearLayout`(12) + `AppCompatImageView`(19) + `MaterialButton`(14) = 45 > 42
     * → 第一轮之后 59 > 56 → 旧实现必挂。
     */
    @Test(timeout = 5000)
    fun `父链超长时不会死循环`() {
        val line = UiInspectorInfo.chainLine(
            listOf(
                "ContentFrameLayout", "LinearLayout", "FrameLayout", "AppCompatImageView",
                "LinearLayout", "MaterialButton",
            )
        )
        assertTrue("必须收敛：$line", line.length <= 3 + 60)
        assertTrue("尾部（最近的父容器）必须完整：$line", line.endsWith("MaterialButton"))
    }

    /**
     * 同类输入的**穷举**版本：任意长度、任意类名，都不许转不出来。
     *
     * 上面那条只覆盖"算出来的那一个点"，这一条覆盖一整片 ——
     * 因为死循环的触发条件是**长度算术**，靠人眼看是看不全的。
     */
    @Test(timeout = 10000)
    fun `任意父链都不许死循环`() {
        val names = listOf(
            "ContentFrameLayout", "FrameLayout", "LinearLayout", "NestedScrollView",
            "RecyclerView", "AppCompatImageView", "MaterialButton", "TextView",
            "ViewPager", "CoordinatorLayout", "ConstraintLayout", "SwitchCompat",
        )
        var cases = 0
        for (n in 1..names.size) {
            // 只取前 n 个 + 各种"长尾巴"，保证既有超长也有超短
            for (tail in 0..2) {
                val chain = names.take(n) + List(tail) { "VeryLongWidgetClassName" }
                val line = UiInspectorInfo.chainLine(chain)
                cases++
                assertTrue("长度必须收敛（n=$n tail=$tail）：$line", line.length <= 3 + 60)
                assertFalse("不许出现两个连着的省略号：$line", line.contains("… > …"))
                assertTrue("前缀固定：$line", line.startsWith("层级 "))
            }
        }
        assertTrue("至少得跑几十种组合，实际 $cases", cases >= 30)
    }

    /**
     * 超长链的**形状**契约（不是"能跑完就行"）：
     * 从头部整段丢，**最近两层永远完整**，且只留一个省略号标记。
     */
    @Test(timeout = 5000)
    fun `超长父链丢头部，只留一个省略号`() {
        val line = UiInspectorInfo.chainLine(
            listOf(
                "ContentFrameLayout", "LinearLayout", "FrameLayout", "AppCompatImageView",
                "LinearLayout", "MaterialButton",
            )
        )
        assertEquals("层级 … > LinearLayout > MaterialButton", line)
    }

    // ------------------------------------------------------------ 检视开关（v1.20.15）

    @Test
    fun `面板开关的文案跟着状态走`() {
        assertEquals("检视 开", UiInspectorInfo.toggleLabel(false))
        assertEquals("检视 暂停", UiInspectorInfo.toggleLabel(true))
    }

    @Test
    fun `只有开着且没暂停才算接管触摸`() {
        // 关着 → 不接管（无论暂停与否）
        assertFalse(UiInspectorInfo.inspecting(enabled = false, paused = false))
        assertFalse(UiInspectorInfo.inspecting(enabled = false, paused = true))
        // 开着 + 没暂停 → 接管（v1.20.14 的默认行为，8 条判据依赖它）
        assertTrue(UiInspectorInfo.inspecting(enabled = true, paused = false))
        // 开着 + 暂停 → **放行**（用户要的"暂停时触摸恢复正常，但面板仍在"）
        assertFalse(UiInspectorInfo.inspecting(enabled = true, paused = true))
    }

    @Test
    fun `暂停时面板本体不抢触摸`() {
        // 用户明确要求：只让开关与 × 那一小块可点，面板其余部分不许抢触摸，
        // 否则会挡住画布横滑与编辑手势。
        assertTrue(UiInspectorInfo.panelStealsTouch(paused = false))
        assertFalse(UiInspectorInfo.panelStealsTouch(paused = true))
    }

    // ------------------------------------------------------------ 清除（v1.20.17）

    @Test
    fun `清除按钮的文案是人话，且不是清日志`() {
        assertEquals("清除", UiInspectorInfo.CLEAR_LABEL)
        // 无障碍文本里要说清"只清面板内容"—— uiautomator 与读屏都靠它
        assertTrue(UiInspectorInfo.CLEAR_DESC.contains("清除面板内容"))
        // 刻意不叫"清空记录"：那个名字会被读成"清日志/清数据"
        assertFalse(UiInspectorInfo.CLEAR_LABEL.contains("记录"))
    }

    @Test
    fun `占位态的内容与标题是唯一的，供 show 与清除共用`() {
        // 判据（规格 §1）：清除后要**回到占位** —— 那"占位"必须是同一份，
        // 所以抽成 placeholderLines() 而不是在两处各写一遍字面量
        assertEquals(listOf("点屏幕上任意控件查看它的信息"), UiInspectorInfo.placeholderLines())
        assertEquals("控件检视", UiInspectorInfo.PLACEHOLDER_TITLE)
    }

    @Test
    fun `占位提示里带着下一步做什么`() {
        // 规格 §3：空态要说清"为什么空 + 下一步做什么"——
        // 这里"空"= 还没点过控件，下一步 = 点屏幕上任意控件
        val line = UiInspectorInfo.placeholderLines().joinToString(" ")
        assertTrue(line.contains("点屏幕上任意控件"))
    }

    @Test
    fun `操作提示里提到了清除按钮`() {
        // 面板上多了一个小药丸，提示里不提它，用户只会看见一个不知道干什么的按钮
        assertTrue(UiInspectorInfo.HINT_OPS.contains("清除"))
        assertTrue(UiInspectorInfo.HINT_OPS.contains("只清面板内容"))
    }

    @Test
    fun `暂停提示不再编方位（药丸不在左上角）`() {
        // v1.20.17 修文案：那个药丸在标题行**右侧**，原来写"左上角"会让人找错地方
        assertTrue(UiInspectorInfo.HINT_PAUSED.contains("检视 暂停"))
        assertFalse(UiInspectorInfo.HINT_PAUSED.contains("左上角"))
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
