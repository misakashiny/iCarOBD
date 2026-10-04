package com.icar.obd.ui.view

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * **霓虹接入的契约测试**（P7-8）。
 *
 * ## 为什么用"读源码"的方式测
 *
 * 霓虹是**纯绘制**，要 Robolectric 或真机才能验证像素。但真正容易出的问题不是
 * "画得对不对"，而是**"新加了一种仪表，忘了给它接霓虹"** ——
 * 那种仪表在霓虹主题下是哑的，而且**没有任何测试会失败**。
 *
 * 所以这里检查一个静态事实：每个仪表视图都必须**至少调用一次霓虹绘制**。
 * 这不是像素级验证，但能挡住"新样式忘了接"这一类遗漏。
 *
 * > 这个套路和 `ThemeStudioSampleTest`（读工具产出的 JSON）一样：
 * > 用源码本身当被测对象。
 */
class NeonCoverageTest {

    private fun viewDir(): File {
        // 单测的工作目录是模块根（app/），源码在 src/main/java/...
        val candidates = listOf(
            File("src/main/java/com/icar/obd/ui/view"),
            File("app/src/main/java/com/icar/obd/ui/view"),
        )
        return candidates.firstOrNull { it.isDirectory }
            ?: error("找不到 view 源码目录，试过：${candidates.map { it.absolutePath }}")
    }

    /** 画霓虹的调用形态：共用助手 或 直接调 NeonPainter */
    private val NEON_CALL = Regex(
        "neon(Bar|Text|Line|Dot|Path)\\s*\\(|" +
            "neon\\.(arc|line|roundRect|circle|glowText|bloomArc|bloomLine|bloomRoundRect|bloomCircle)\\s*\\("
    )

    /** 8 种样式对应的视图。**新增样式时要同步加进来** */
    private val VIEWS = listOf(
        "CircularGaugeView.kt",
        "BarGaugeView.kt",
        "DigitalGaugeView.kt",
        "LineChartView.kt",
        "MultiValueGaugeView.kt",
        "GForceGaugeView.kt",
    )

    @Test
    fun `每个仪表视图都接了霓虹`() {
        val dir = viewDir()
        val missing = VIEWS.filter { name ->
            val f = File(dir, name)
            !f.isFile || !NEON_CALL.containsMatchIn(f.readText())
        }
        assertTrue(
            "这些视图**一次霓虹都没调用** —— 它们在霓虹主题下会是哑的：$missing\n" +
                "（如果是有意不接，把它从 NeonCoverageTest.VIEWS 里去掉并说明原因）",
            missing.isEmpty()
        )
    }

    @Test
    fun `霓虹助手都定义在 BaseGaugeView 里 —— 不是各视图各写一份`() {
        val dir = viewDir()
        val base = File(dir, "BaseGaugeView.kt")
        assertTrue("BaseGaugeView.kt 不存在", base.isFile)
        val text = base.readText()
        listOf("neonBar", "neonText", "neonLine", "neonDot", "neonPath").forEach { fn ->
            assertTrue(
                "BaseGaugeView 里没有 $fn —— 各视图会各写一份辉光循环，迟早分叉",
                Regex("protected fun $fn\\s*\\(").containsMatchIn(text)
            )
        }
    }

    @Test
    fun `霓虹关掉时助手要直接跳过 —— 不能白算`() {
        val dir = viewDir()
        val text = File(dir, "BaseGaugeView.kt").readText()
        // neonBar / neonLine / neonDot 的辉光都包在 `if (on)` 里；
        // neonText 包在 `if (palette.glow)` 里。
        // 这条钉住"关掉 = 零额外绘制"这个承诺。
        assertTrue(
            "neonBar 没有 if (on) 守卫 —— 关掉霓虹后仍会做多层绘制",
            Regex("fun neonBar[\\s\\S]{0,400}?if \\(on\\)").containsMatchIn(text)
        )
        assertTrue(
            "neonText 没有 palette.glow 守卫",
            Regex("fun neonText[\\s\\S]{0,500}?if \\(palette\\.glow\\)").containsMatchIn(text)
        )
        assertTrue(
            "neonPath 没有提前 return 守卫",
            Regex("fun neonPath[\\s\\S]{0,400}?if \\(!on\\) return").containsMatchIn(text)
        )
    }

    @Test
    fun `多值三兄弟委托给 MultiValueGaugeView —— 不需要各自接霓虹`() {
        val dir = viewDir()
        listOf("DualStackGaugeView.kt", "QuadGaugeView.kt", "SubDualGaugeView.kt").forEach { name ->
            val f = File(dir, name)
            assertTrue("$name 不存在", f.isFile)
            assertTrue(
                "$name 应当委托给 MultiValueGaugeView（否则它得自己接霓虹）",
                f.readText().contains("MultiValueGaugeView")
            )
        }
    }
}
