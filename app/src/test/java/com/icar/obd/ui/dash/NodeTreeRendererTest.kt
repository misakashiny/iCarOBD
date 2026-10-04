package com.icar.obd.ui.dash

import com.icar.obd.data.DesignFile
import com.icar.obd.data.GaugeItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [NodeTreeRenderer] 的**坐标换算**（v2 渲染里最纯、最容易算错的部分）。
 *
 * ## 为什么只测这一块
 *
 * 渲染的其余部分（建 View / 挂 ViewGroup / 变换）要真机或 Robolectric 才跑得起来，
 * 而**缩放模式的换算**是纯数学 —— 也正是"电脑上看到的"与"设备上看到的"会不会
 * 分叉的关键。三种模式各有一个容易错的地方：
 *
 * | 模式 | 容易错在哪 |
 * |---|---|
 * | `stretch` | 忘了它是**每轴独立**的（v1 行为，不能改成等比） |
 * | `fit` | 偏移算错 → 画面不居中；或用了 max 而不是 min |
 * | `fill` | 用了 min 而不是 max → 出现黑边（本该铺满） |
 *
 * 这些错了不会崩，只会"看起来不太对"，所以必须有断言钉住。
 */
class NodeTreeRendererTest {


    /** 造一个只带缩放模式的设计 */
    private fun design(scaleMode: Int) = DesignFile(
        name = "t", scaleMode = scaleMode,
        gauges = listOf(GaugeItem(pidId = "std_0C", w = 180f, h = 180f))
    )

    private val C = GaugeItem.CANVAS   // 360

    @Test
    fun `stretch 每轴独立 —— 这是 v1 的行为 不能改成等比`() {
        val vp = NodeTreeRenderer.computeViewport(DesignFile.SCALE_STRETCH, 720, 360)
        // 16:9 的容器：x 每单位 2px，y 每单位 1px
        assertEquals("x 轴", 2f, vp.pxX, 1e-4f)
        assertEquals("y 轴", 1f, vp.pxY, 1e-4f)
        assertEquals("stretch 没有偏移", 0f, vp.offX, 1e-4f)
        assertEquals("stretch 没有偏移", 0f, vp.offY, 1e-4f)
        // 一个 180×180 的方表 → 屏幕上变成 360×180 的矩形（**确实会变形**，这是设计如此）
        assertEquals(360f, 180f * vp.pxX, 1e-3f)
        assertEquals(180f, 180f * vp.pxY, 1e-3f)
    }

    @Test
    fun `fit 等比且居中 —— 短边留黑边`() {
        val vp = NodeTreeRenderer.computeViewport(DesignFile.SCALE_FIT, 720, 360)
        // k = min(720/360, 360/360) = 1
        assertEquals(1f, vp.pxX, 1e-4f)
        assertEquals(1f, vp.pxY, 1e-4f)
        // x 方向居中留边：(720 - 360*1)/2 = 180
        assertEquals("x 居中偏移", 180f, vp.offX, 1e-4f)
        assertEquals("y 不留边", 0f, vp.offY, 1e-4f)
        // 关键：等比 → 方表在屏幕上仍是方的
        assertEquals(180f * vp.pxX, 180f * vp.pxY, 1e-3f)
        // 内容整体落在容器内
        assertTrue(vp.x(0f) >= 0f)
        assertTrue(vp.x(C) <= 720f + 1e-3f)
    }

    @Test
    fun `fill 等比且铺满 —— 超出部分裁掉 不留黑边`() {
        val vp = NodeTreeRenderer.computeViewport(DesignFile.SCALE_FILL, 720, 360)
        // k = max(2, 1) = 2
        assertEquals(2f, vp.pxX, 1e-4f)
        assertEquals(2f, vp.pxY, 1e-4f)
        // 360*2 = 720 宽（正好铺满），360*2 = 720 高（超出 360 的容器 → 上下各裁 180）
        assertEquals("x 正好铺满", 0f, vp.offX, 1e-4f)
        assertEquals("y 上下各裁 180", -180f, vp.offY, 1e-4f)
        // 等比
        assertEquals(vp.pxX, vp.pxY, 1e-4f)
        // 铺满：内容覆盖整个容器（没有黑边）
        assertTrue("上边不露黑边", vp.y(0f) <= 0f)
        assertTrue("下边不露黑边", vp.y(C) >= 360f)
    }

    @Test
    fun `竖屏容器下 fit 与 fill 的选择相反`() {
        // 720×1440 竖屏：fit 用 min（=2），fill 用 max（=4）
        val fit = NodeTreeRenderer.computeViewport(DesignFile.SCALE_FIT, 720, 1440)
        val fill = NodeTreeRenderer.computeViewport(DesignFile.SCALE_FILL, 720, 1440)
        assertEquals(2f, fit.pxX, 1e-4f)
        assertEquals(4f, fill.pxX, 1e-4f)
        // fit 上下留边（y 方向），fill 左右裁掉
        assertTrue("fit 应当上下留边", fit.offY > 0f)
        assertTrue("fill 应当左右裁切（偏移为负）", fill.offX < 0f)
    }

    @Test
    fun `未知缩放模式回落到 stretch`() {
        // 将来加了新模式而这里忘了处理时，行为要与 v1 一致（每轴独立），
        // 而不是崩掉或变成等比 —— 等比会让存量设计突然留黑边
        val vp = NodeTreeRenderer.computeViewport(99, 720, 360)
        assertEquals(2f, vp.pxX, 1e-4f)
        assertEquals(1f, vp.pxY, 1e-4f)
    }

    @Test
    fun `换算只依赖 缩放模式 与 容器尺寸`() {
        // designW/designH 是给**编辑器**看目标屏幕形状用的，与渲染换算无关。
        //
        // 这一点现在由**签名本身**保证：computeViewport 只收 (scaleMode, cw, ch)，
        // 它**拿不到** designW/designH，也就无从依赖 —— 比"靠断言证明"更硬。
        // 这里钉住它确实是个纯函数：同样的入参 → 逐位相同的输出。
        val a = NodeTreeRenderer.computeViewport(DesignFile.SCALE_STRETCH, 720, 360)
        val b = NodeTreeRenderer.computeViewport(DesignFile.SCALE_STRETCH, 720, 360)
        assertEquals(a.pxX, b.pxX, 0f)
        assertEquals(a.pxY, b.pxY, 0f)
        assertEquals(a.offX, b.offX, 0f)
        assertEquals(a.offY, b.offY, 0f)
        // 容器尺寸**会**影响结果（这是它唯一的几何输入）
        val c = NodeTreeRenderer.computeViewport(DesignFile.SCALE_STRETCH, 1440, 720)
        assertEquals("容器翻倍 → 每单位像素也翻倍", a.pxX * 2f, c.pxX, 1e-4f)
    }
}
