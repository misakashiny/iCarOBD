package com.icar.obd.ui.view

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 缓动函数（v1.9.0 改成**时间基准**）。
 *
 * 这里钉的是三件事，都是"放进 `onDraw` 就没法验证"的：
 *  1. 会不会永远追不上（收敛性）
 *  2. **换帧率会不会变快变慢**（时间基准的核心价值）
 *  3. 会不会过冲（指针冲过目标再弹回来，很难看）
 */
class GaugeEasingTest {

    /** 按固定帧率跑 [durationMs]，返回最终值 */
    private fun run(from: Float, target: Float, durationMs: Float, fps: Float): Float {
        val dt = 1000f / fps
        var v = from
        var t = 0f
        while (t < durationMs) {
            v = BaseGaugeView.nextDisplay(v, target, dt)
            t += dt
        }
        return v
    }

    // ================================================================ 收敛

    @Test
    fun `持续逼近目标`() {
        // ⚠️ 时长从 300ms 提到 500ms：τ 从 45ms 变成 120ms（v1.10.4），
        // 300ms 只走 91.8% —— 那是**刻意的**（留余量给下一次 5Hz 推送），
        // 不是没收敛。3τ=360ms 之后才算收住。
        val v = run(0f, 100f, 500f, 60f)
        assertEquals("500ms 后应基本到位", 100f, v, 1.5f)
    }

    @Test
    fun `一步不跳到位 —— 要能看出动画`() {
        val v = BaseGaugeView.nextDisplay(0f, 100f, 16.7f)
        assertTrue("一帧只应走一部分，实际 $v", v > 0f && v < 60f)
    }

    @Test
    fun `单调逼近 不过冲`() {
        var v = 0f
        repeat(60) {
            val next = BaseGaugeView.nextDisplay(v, 100f, 16.7f)
            assertTrue("过冲了：$v → $next", next >= v && next <= 100f)
            v = next
        }
    }

    @Test
    fun `下降方向同样单调不过冲`() {
        var v = 100f
        repeat(60) {
            val next = BaseGaugeView.nextDisplay(v, 0f, 16.7f)
            assertTrue("过冲了：$v → $next", next <= v && next >= 0f)
            v = next
        }
    }

    @Test
    fun `dt 为 0 或负数时不动`() {
        assertEquals(10f, BaseGaugeView.nextDisplay(10f, 100f, 0f), 1e-6f)
        assertEquals(10f, BaseGaugeView.nextDisplay(10f, 100f, -5f), 1e-6f)
    }

    @Test
    fun `dt 异常大时被夹住 不会一步跳到位`() {
        // 切页面回来时 dt 可能是几百毫秒；不夹住的话缓动会"瞬移"，看着像闪一下
        val v = BaseGaugeView.nextDisplay(0f, 100f, 5000f)
        assertTrue("dt=5000ms 也不该一步到位，实际 $v", v < 100f)
    }

    // ================================================================ 时间基准（核心）

    @Test
    fun `相同墙钟时间内 不同帧率结果接近`() {
        // 这是改成时间基准的**唯一理由**：这台平板能跑 120Hz，
        // 按帧缓动的话动效会快一倍，和 60Hz 设备观感完全不同。
        //
        // ⚠️ v1.10.4 把容差从 2f 收紧到 1f —— 因为修掉了一个实质缺陷：
        // 指数逼近写成**增量积分**时，60Hz 与 120Hz 在同样 250ms 后
        // 差 **20 个百分点**（55.5 vs 35.0）。修法是把每帧混合系数按参考帧长
        // 归一化（见 `Easing.REF_FRAME_MS`）。收紧容差正是为了钉住这个修复。
        val at60 = run(0f, 100f, 250f, 60f)
        val at120 = run(0f, 100f, 250f, 120f)
        assertEquals("60Hz 与 120Hz 在同样 250ms 后应当几乎一致", at60, at120, 1f)
    }

    @Test
    fun `30Hz 与 144Hz 也接近`() {
        val at30 = run(0f, 100f, 250f, 30f)
        val at144 = run(0f, 100f, 250f, 144f)
        assertEquals("低帧率也不该明显落后", at30, at144, 2f)
    }

    @Test
    fun `时间常数符合预期 —— 一个 tau 走约 63百分之`() {
        val v = run(0f, 100f, BaseGaugeView.TAU_MS, 240f)
        assertEquals("一个时间常数应走约 63.2%", 63.2f, v, 2f)
    }

    @Test
    fun `3 个 tau 内能走完 95百分之`() {
        // ⚠️ 这条**改过**（v1.10.4）。
        //
        // 原来是「200ms 内走完 95%」—— 那是按 τ=45ms 算的，为了让缓动
        // 在 5Hz 推送窗口（200ms）内收住。但那个"收住"正是问题所在：
        // 指针在一个周期内就**趴**在目标上了，下次推送再跳一下。
        //
        // 现在改成「3τ 内收住」（τ=120ms → 360ms），留一点余量给下一次推送，
        // 指针全程在动。代价是到位慢一点 —— 仪表读数本来就不需要瞬时响应。
        val v = run(0f, 100f, BaseGaugeView.TAU_MS * 3f, 120f)
        assertTrue("3τ 后应 ≥95%，实际 $v", v >= 95f)
    }

    @Test
    fun `一个 5Hz 推送周期内不会走完 —— 留余量给下一次推送`() {
        // 这是"过渡而不是跳变"的关键：200ms 内**不能**基本到位，
        // 否则指针会在周期末尾静止，看起来一格一格地跳
        val v = run(0f, 100f, 200f, 120f)
        assertTrue("200ms 内不该走完（实际 $v%）", v < 92f)
        assertTrue("但也不能太慢（实际 $v%）", v > 60f)
    }

    // ================================================================ 收敛判据

    @Test
    fun `settled 用绝对阈值`() {
        assertTrue(BaseGaugeView.settled(100f, 100f, 0.5f))
        assertTrue(BaseGaugeView.settled(99.7f, 100f, 0.5f))
        assertFalse(BaseGaugeView.settled(99f, 100f, 0.5f))
    }

    @Test
    fun `绝对阈值在大数值上也能收住 —— 相对比例的毛病`() {
        // 转速量程 8000：相对千分之一 = 8 转，换算成条形是 0.1% 宽度，
        // 但**指针会肉眼可见地"爬"**。像素级阈值能收住
        val eps = 0.5f
        assertTrue("离目标 0.4 就该吸附", BaseGaugeView.settled(7999.6f, 8000f, eps))
        assertFalse("离目标 5 不该吸附", BaseGaugeView.settled(7995f, 8000f, eps))
    }

    @Test
    fun `时间常数是正数`() {
        assertTrue("τ 必须为正，否则缓动方向会反", BaseGaugeView.TAU_MS > 0f)
    }
}
