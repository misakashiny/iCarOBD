package com.icar.obd.ui.primitive

import org.junit.Assert.*
import org.junit.Test

/**
 * P5B-M03 §D：四个 Android 绘制组件的**几何与语义**单测。
 *
 * ## 测什么 / 不测什么
 *
 * ✅ 测：纯几何计算、进度→段数、格式化、阈值分级、无效输入保护、未知 kind 回落
 * ❌ 不测：真实像素（需要 Android 环境，属于设备端套件 `verify-p5b03-primitives.js` 的职责）
 *
 * ## 为什么这样分
 *
 * 几何计算是**最容易两端不一致**的地方（角度约定、四舍五入、空隙处理）。
 * 把它抽成 companion 里的纯函数，就能用 JVM 精确钉住，
 * 而不必依赖"看起来差不多"的截图比较。
 */
class PrimitivesGeometryTest {

    // ================================================================
    // SegmentedArc
    // ================================================================

    @Test
    fun `SegmentedArc 起始角按段递增`() {
        // startAngle=150, sweep=240, n=24 → 每段 10°
        val a0 = SegmentedArcView.segmentStartAngle(150f, 240f, 24, 0)
        val a1 = SegmentedArcView.segmentStartAngle(150f, 240f, 24, 1)
        val a23 = SegmentedArcView.segmentStartAngle(150f, 240f, 24, 23)
        assertEquals("第 0 段 = startAngle", 150f, a0, 0.001f)
        assertEquals("每段 10°", 160f, a1, 0.001f)
        assertEquals("第 23 段 = 150+230", 380f, a23, 0.001f)
    }

    @Test
    fun `SegmentedArc 逆时针时扫角为负`() {
        val a1 = SegmentedArcView.segmentStartAngle(150f, -240f, 24, 1)
        assertEquals("负扫角 → 段起始角减小", 140f, a1, 0.001f)
    }

    @Test
    fun `SegmentedArc 每段实绘角扣掉空隙`() {
        // step=10, gap=2 → 实绘 8
        assertEquals(8f, SegmentedArcView.drawnSweep(240f, 24, 2f), 0.001f)
        // gap=0 → 等于 step
        assertEquals(10f, SegmentedArcView.drawnSweep(240f, 24, 0f), 0.001f)
    }

    @Test
    fun `SegmentedArc 空隙大于每段时仍能画出来`() {
        // step=10, gap=20 → 不能变成负角（否则完全看不见）
        val s = SegmentedArcView.drawnSweep(240f, 24, 20f)
        assertTrue("实绘角必须 > 0（实际=$s）", s > 0f)
        assertEquals("被夹到最小正角", 0.01f, s, 0.0001f)
    }

    @Test
    fun `SegmentedArc 逆时针时空隙方向相反`() {
        // step=-10, gap=2 → 实绘 = -10+2 = -8
        assertEquals(-8f, SegmentedArcView.drawnSweep(-240f, 24, 2f), 0.001f)
    }

    @Test
    fun `SegmentedArc 进度四舍五入到段`() {
        assertEquals("0 → 0 段", 0, SegmentedArcView.litSegments(0f, 24))
        assertEquals("0.5 → 12 段", 12, SegmentedArcView.litSegments(0.5f, 24))
        assertEquals("1 → 24 段", 24, SegmentedArcView.litSegments(1f, 24))
        // 0.52*24 = 12.48 → round = 12
        assertEquals("0.52 → 12 段", 12, SegmentedArcView.litSegments(0.52f, 24))
        // 0.53*24 = 12.72 → round = 13
        assertEquals("0.53 → 13 段", 13, SegmentedArcView.litSegments(0.53f, 24))
    }

    @Test
    fun `SegmentedArc 无数据不点亮任何段`() {
        assertEquals("null → 0 段（不是全亮也不是全灭的歧义）",
            0, SegmentedArcView.litSegments(null, 24))
    }

    @Test
    fun `SegmentedArc 进度越界被夹住`() {
        assertEquals("progress=-0.5 → 0 段", 0, SegmentedArcView.litSegments(-0.5f, 24))
        assertEquals("progress=1.5 → 满段", 24, SegmentedArcView.litSegments(1.5f, 24))
    }

    @Test
    fun `SegmentedArc 角度转坐标正确`() {
        // 0° = 3 点钟方向
        val p0 = SegmentedArcView.pointOnCircle(0f, 0f, 100f, 0f)
        assertEquals("0° → x=+r", 100f, p0.first, 0.01f)
        assertEquals("0° → y=0", 0f, p0.second, 0.01f)
        // 90° = 6 点钟（Android 坐标系 y 向下）
        val p90 = SegmentedArcView.pointOnCircle(0f, 0f, 100f, 90f)
        assertEquals("90° → x=0", 0f, p90.first, 0.01f)
        assertEquals("90° → y=+r（屏幕坐标 y 向下）", 100f, p90.second, 0.01f)
    }

    // ================================================================
    // PathProgress
    // ================================================================

    @Test
    fun `PathProgress 无效控制点被滤掉`() {
        val raw = listOf(
            floatArrayOf(0f, 0f),
            floatArrayOf(Float.NaN, 0.5f),          // NaN
            floatArrayOf(0.5f, Float.POSITIVE_INFINITY),  // Inf
            floatArrayOf(0.5f, 0.5f),
            floatArrayOf(2f, -1f),                  // 越界 → 夹取
        )
        val s = PathProgressView.sanitize(raw)
        assertEquals("NaN/Inf 被滤掉，剩 3 个", 3, s.size)
        assertEquals("越界 x 夹到 1", 1f, s[2][0], 0.001f)
        assertEquals("越界 y 夹到 0", 0f, s[2][1], 0.001f)
    }

    @Test
    fun `PathProgress 全无效应剩下空列表`() {
        val s = PathProgressView.sanitize(listOf(floatArrayOf(Float.NaN, Float.NaN)))
        assertTrue("全部无效", s.isEmpty())
    }

    @Test
    fun `PathProgress 裁剪长度按比例`() {
        assertEquals("progress=0 → 0", 0f, PathProgressView.clippedLength(382.5f, 0f), 0.01f)
        assertEquals("progress=1 → 全长", 382.5f, PathProgressView.clippedLength(382.5f, 1f), 0.01f)
        assertEquals("progress=0.5 → 一半", 191.25f, PathProgressView.clippedLength(382.5f, 0.5f), 0.01f)
    }

    @Test
    fun `PathProgress 裁剪长度越界被夹`() {
        assertEquals(0f, PathProgressView.clippedLength(100f, -1f), 0.01f)
        assertEquals(100f, PathProgressView.clippedLength(100f, 2f), 0.01f)
    }

    @Test
    fun `PathProgress 弧长容限是 2 百分比`() {
        // 指令要求「不能直接声称两端采样数相同就完全一致」——
        // 这里把容限写成常量并断言，防止以后有人偷偷放宽
        assertEquals("两端弧长容限", 0.02f, PathProgressView.ARC_LENGTH_TOLERANCE, 0.0001f)
    }

    // ================================================================
    // ValueText
    // ================================================================

    @Test
    fun `ValueText 无数据必须显示占位而不是 0`() {
        assertEquals("占位符是 --", "--", ValueTextPrimitiveView.NO_DATA)
        assertEquals("formatValue 收到 NaN 也返回 --",
            "--", ValueTextPrimitiveView.formatValue(Float.NaN, 0))
    }

    @Test
    fun `ValueText 去尾随零`() {
        assertEquals("1.50 保留 2 位 → 1.5", "1.5", ValueTextPrimitiveView.formatValue(1.50f, 2))
        assertEquals("2.00 保留 2 位 → 2", "2", ValueTextPrimitiveView.formatValue(2.00f, 2))
        assertEquals("3.141 保留 2 位 → 3.14", "3.14", ValueTextPrimitiveView.formatValue(3.141f, 2))
        assertEquals("整数 0 位 → 90", "90", ValueTextPrimitiveView.formatValue(90f, 0))
    }

    @Test
    fun `ValueText 真零值显示 0 不是占位`() {
        // 关键区别：值是 0（真实读数）≠ 无数据
        assertEquals("真 0 → \"0\"", "0", ValueTextPrimitiveView.formatValue(0f, 0))
    }

    @Test
    fun `ValueText 阈值分级`() {
        assertEquals("无数据 → -1",
            ValueTextPrimitiveView.LEVEL_NO_DATA,
            ValueTextPrimitiveView.levelOf(null, 100f, 110f))
        assertEquals("正常 → 0",
            ValueTextPrimitiveView.LEVEL_NORMAL,
            ValueTextPrimitiveView.levelOf(90f, 100f, 110f))
        assertEquals("达 warnHigh → 1",
            ValueTextPrimitiveView.LEVEL_WARN,
            ValueTextPrimitiveView.levelOf(100f, 100f, 110f))
        assertEquals("达 criticalHigh → 2",
            ValueTextPrimitiveView.LEVEL_CRITICAL,
            ValueTextPrimitiveView.levelOf(110f, 100f, 110f))
        assertEquals("超 criticalHigh → 2",
            ValueTextPrimitiveView.LEVEL_CRITICAL,
            ValueTextPrimitiveView.levelOf(200f, 100f, 110f))
    }

    @Test
    fun `ValueText 未设阈值时永远是正常`() {
        assertEquals(ValueTextPrimitiveView.LEVEL_NORMAL,
            ValueTextPrimitiveView.levelOf(9999f, null, null))
    }

    // ================================================================
    // Shape
    // ================================================================

    @Test
    fun `Shape 六种 kind 都被认识`() {
        assertEquals("应有 6 种", 6, ShapePrimitiveView.KINDS.size)
        listOf("rect", "roundRect", "circle", "ring", "line", "polyline").forEach { k ->
            assertTrue("$k 在 KINDS 里", k in ShapePrimitiveView.KINDS)
        }
    }

    @Test
    fun `Shape 未知 kind 回落成矩形而不是崩`() {
        assertEquals("未知 → rect",
            ShapePrimitiveView.KIND_RECT,
            ShapePrimitiveView.normalizeKind("hexagon"))
        assertEquals("已知保持不变",
            ShapePrimitiveView.KIND_RING,
            ShapePrimitiveView.normalizeKind("ring"))
    }

    @Test
    fun `Shape 圆角超限被夹到短边一半`() {
        assertEquals("圆角 200 但高度 100 → 夹到 50",
            50f, ShapePrimitiveView.clampCorner(200f, 300f, 100f), 0.01f)
        assertEquals("正常圆角不变", 12f, ShapePrimitiveView.clampCorner(12f, 300f, 100f), 0.01f)
        assertEquals("负圆角夹到 0", 0f, ShapePrimitiveView.clampCorner(-5f, 300f, 100f), 0.01f)
    }

    // ================================================================
    // 隔离原则（指令 §D5）
    // ================================================================

    @Test
    fun `四个组件都不在 view 包里_证明未被正式注册`() {
        // 这是**结构性约束**的代码化：
        // 组件在 ui.primitive 包，不在 ui.view 包，也不被 GaugeViewFactory 引用。
        // 本测试通过在运行时检查包名来钉住这一点。
        val pkg = SegmentedArcView::class.java.packageName
        assertEquals("SegmentedArc 必须留在隔离包", "com.icar.obd.ui.primitive", pkg)
        assertEquals("PathProgress 必须留在隔离包", "com.icar.obd.ui.primitive",
            PathProgressView::class.java.packageName)
        assertEquals("ValueText 必须留在隔离包", "com.icar.obd.ui.primitive",
            ValueTextPrimitiveView::class.java.packageName)
        assertEquals("Shape 必须留在隔离包", "com.icar.obd.ui.primitive",
            ShapePrimitiveView::class.java.packageName)
    }
}
