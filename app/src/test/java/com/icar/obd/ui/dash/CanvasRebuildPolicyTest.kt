package com.icar.obd.ui.dash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [CanvasRebuildPolicy] 的用例（v1.20.12）。
 *
 * 这一组守的是那个 P0：**规则 toast 一弹、整个画布不见**。
 * 根因是"在 layout 期间 addView"→ 8 块表落成 0×0；
 * 而 [DashRenderer] 那一侧没法在 JVM 里测（一碰 View 就是 `Stub!`），
 * 所以把"什么时候重建 / 什么时候算坏 / 要不要补"抽成纯判定，在这里钉住。
 */
class CanvasRebuildPolicyTest {

    // ---------------------------------------------------------------- needsRebuild

    @Test
    fun `没渲染过就不重建`() {
        // 首次布局（0,0 → W,H）会走到 relayout，但那时还没有任何规格。
        // 不挡的话会把"没有规格"当成"规格是空的"，闪一下空态提示并打出误导性日志（v1.20.1 的坑）
        assertFalse(CanvasRebuildPolicy.needsRebuild(false, 1080, 2272, 0, 0))
        assertFalse(CanvasRebuildPolicy.needsRebuild(false, 1080, 2272, 1080, 2272))
    }

    @Test
    fun `尺寸没变就不重建`() {
        assertFalse(CanvasRebuildPolicy.needsRebuild(true, 1080, 2272, 1080, 2272))
    }

    @Test
    fun `高度变了要重建 —— 这就是告警条出现时的那一次`() {
        // 规则动作 toast → 告警条 VISIBLE → pager 2272 → 2164
        assertTrue(CanvasRebuildPolicy.needsRebuild(true, 1080, 2164, 1080, 2272))
    }

    @Test
    fun `告警条收起时也要重建`() {
        assertTrue(CanvasRebuildPolicy.needsRebuild(true, 1080, 2272, 1080, 2164))
    }

    @Test
    fun `宽度变了要重建`() {
        assertTrue(CanvasRebuildPolicy.needsRebuild(true, 1600, 2272, 1080, 2272))
    }

    @Test
    fun `旋转这类两轴同时变要重建`() {
        assertTrue(CanvasRebuildPolicy.needsRebuild(true, 2560, 1600, 1600, 2560))
    }

    // ---------------------------------------------------------------- zeroSizedCount

    @Test
    fun `全部正常时 0 尺寸数为 0`() {
        val sizes = listOf(526 to 894, 526 to 894, 526 to 440, 526 to 440)
        assertEquals(0, CanvasRebuildPolicy.zeroSizedCount(sizes))
    }

    @Test
    fun `layout 期间 addView 的指纹 —— 全部 0x0`() {
        // 实测（logcat）：容器 1080x2164，8 块表全是 0x0@0,0。
        // 屏幕上 99.96% 是一片纯背景色，而 childCount 和日志都"正常"
        val sizes = List(8) { 0 to 0 }
        assertEquals(8, CanvasRebuildPolicy.zeroSizedCount(sizes))
    }

    @Test
    fun `只有宽为 0 也算坏`() {
        assertEquals(1, CanvasRebuildPolicy.zeroSizedCount(listOf(0 to 894, 526 to 894)))
    }

    @Test
    fun `只有高为 0 也算坏`() {
        assertEquals(1, CanvasRebuildPolicy.zeroSizedCount(listOf(526 to 0, 526 to 894)))
    }

    @Test
    fun `负尺寸也算坏`() {
        assertEquals(1, CanvasRebuildPolicy.zeroSizedCount(listOf(-1 to 894)))
    }

    @Test
    fun `1x1 不算坏 —— 那是配置写错，不是画布不见`() {
        // render() 对宽高都有 coerceAtLeast(1)：1x1 说明 item.w/h 配成了 0，
        // 补重建解决不了它，反而会把日志刷满
        assertEquals(0, CanvasRebuildPolicy.zeroSizedCount(listOf(1 to 1)))
    }

    @Test
    fun `空列表是 0 而不是崩`() {
        assertEquals(0, CanvasRebuildPolicy.zeroSizedCount(emptyList()))
    }

    // ---------------------------------------------------------------- shouldHeal

    @Test
    fun `有 0 尺寸且没补过就补一次`() {
        assertTrue(CanvasRebuildPolicy.shouldHeal(zeroSized = 3, total = 8, healed = false))
    }

    @Test
    fun `补过一次就不再补 —— 否则死循环`() {
        assertFalse(CanvasRebuildPolicy.shouldHeal(zeroSized = 3, total = 8, healed = true))
    }

    @Test
    fun `没有坏块就不补`() {
        assertFalse(CanvasRebuildPolicy.shouldHeal(zeroSized = 0, total = 8, healed = false))
    }

    @Test
    fun `一块表都没有时不补 —— 空画布不是这个 bug`() {
        // 没有任何仪表时 container 里只有参考线覆盖层，total=0。
        // 那可能是"这一套画布就是空的"，补重建没有意义
        assertFalse(CanvasRebuildPolicy.shouldHeal(zeroSized = 0, total = 0, healed = false))
    }
}
