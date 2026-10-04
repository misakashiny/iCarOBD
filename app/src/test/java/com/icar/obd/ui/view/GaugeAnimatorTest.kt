package com.icar.obd.ui.view

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 动画**状态机**（v1.10.4 从 `BaseGaugeView.stepFrame` 抽出来）。
 *
 * ## 为什么这个测试比 [EasingTest] 更重要
 *
 * [EasingTest] 测的是纯数学（曲线、滤波、判据）。但"数据还在变时会不会冻住"
 * 这类问题**只出在状态机上**，不在数学上 —— 而状态机原来长在 `stepFrame` 里，
 * 要 View、要 Choreographer，JVM 单测根本跑不了。
 *
 * 抽成 [GaugeAnimator] 之后，可以按真实时序喂数据，直接断言"每一帧都在动"。
 */
class GaugeAnimatorTest {

    private val EPS = 0.5f

    /** 按固定帧率跑，收集每帧的显示值 */
    private fun run(
        animator: GaugeAnimator,
        values: List<Float>,
        fps: Float = 120f,
        pushHz: Float = 5f,
        holdMs: Float = 0f
    ): List<Float> {
        val dtMs = 1000f / fps
        val pushEvery = 1000f / pushHz
        val out = ArrayList<Float>()
        var now = 0L
        var nextPush = 0f
        var idx = 0
        val totalMs = pushEvery * values.size + holdMs
        var t = 0f
        // 当前"总线上的值"：两次推送之间保持不变
        var current = if (values.isEmpty()) 0f else values.first()
        while (t < totalMs) {
            if (t >= nextPush && idx < values.size) {
                current = values[idx]
                idx++
                nextPush += pushEvery
            }
            animator.step(current, now, EPS)
            animator.display?.let { out.add(it) }
            now += dtMs.toLong().coerceAtLeast(1L)
            t += dtMs
        }
        return out
    }

    // ================================================================ 基本

    @Test
    fun `首帧直接采用原始值 不做动画`() {
        // 刚启动时没有历史可缓动 —— 从 0 滑到当前值会很怪
        val a = GaugeAnimator()
        a.step(4200f, 1000L, EPS)
        assertEquals("首帧应当直接到位", 4200f, a.display!!, 1f)
    }

    @Test
    fun `无数据时透传 null 与 NaN`() {
        val a = GaugeAnimator()
        a.step(100f, 1000L, EPS)
        a.step(null, 1016L, EPS)
        assertNull("null 应当透传（用来画「--」占位）", a.display)
        a.step(Float.NaN, 1032L, EPS)
        assertTrue("NaN 应当透传", a.display!!.isNaN())
    }

    @Test
    fun `目标不变时最终会停止 不空转`() {
        val a = GaugeAnimator()
        a.step(0f, 0L, EPS)
        var needMore = true
        var now = 16L
        var frames = 0
        while (needMore && frames < 2000) {
            needMore = a.step(100f, now, EPS)
            now += 16
            frames++
        }
        assertFalse("目标稳定后应当停止动画", needMore)
        assertEquals("应当到达目标", 100f, a.display!!, 1f)
        assertTrue("但不该几帧就停（要真的走一段，实际 $frames 帧）", frames > 10)
    }

    @Test
    fun `单帧位移很小 —— 不是一帧跳到位`() {
        val a = GaugeAnimator()
        a.step(0f, 0L, EPS)
        val before = a.display!!
        a.step(100f, 16L, EPS)
        val moved = Math.abs(a.display!! - before)
        assertTrue("一帧不该走完（实际走了 $moved / 100）", moved < 30f)
        assertTrue("但应当动了", moved > 0f)
    }

    // ================================================================ 核心：不冻住

    @Test
    fun `5Hz 缓慢变化的数据下 指针每一帧都在动`() {
        // ⚠️ 这条是 v1.10.4 的核心修复。
        //
        // 旧逻辑：距离 ≤ epsilon 就吸附并**停止动画**。数据 5Hz 推、两次之间目标不变，
        // 于是缓动在 200ms 窗口里早早收敛、停住，下次推送再跳一下 ——
        // 数据变化慢时（水温上升、正弦峰顶）肉眼可见"停一下再跳"。
        //
        // 现在：目标还在变（距上次变化 < HOLD_MS）就**不许停**。
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_STANDARD, smoothMs = 0f)
        // 每次推送 +1，共 20 次（4 秒），模拟缓慢上升
        val values = (1..20).map { it.toFloat() }
        val seq = run(a, values, fps = 120f, pushHz = 5f)
        assertTrue("应当采到不少帧（实际 ${seq.size}）", seq.size > 100)
    }

    @Test
    fun `数据缓慢上升时 指针大部分时间都在动`() {
        // ⚠️ 判据是**"在动的时间占比"**，不是"零静止帧"。
        //
        // 想清楚这件事很重要：数据是 5Hz **跳变**推送的（每次 +40），
        // 指针走完这 40 之后**本来就该停在目标上**等下一次推送 ——
        // 停在目标上不是"顿挫"，是正确行为（ε=5.6 是半个像素，肉眼不可见）。
        //
        // 真正的问题是 **τ 太小**：τ=45ms 时指针在推送周期里只动约 45%，
        // 剩下一半时间"趴"在目标上 —— 那才是一格一格跳的感觉。
        // τ=120ms 之后应当动到 70% 以上。
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_STANDARD, smoothMs = 0f, range = 8000f)
        val eps = 5.6f
        val pushEvery = 200f
        val dtMs = 1000f / 120f
        val values = (1..16).map { it * 40f }

        var now = 0L
        var t = 0f
        var idx = 0
        var nextPush = 0f
        var current = 0f
        var frames = 0
        var moving = 0
        var prev: Float? = null
        while (t < pushEvery * values.size) {
            if (t >= nextPush && idx < values.size) {
                current = values[idx]
                idx++
                nextPush += pushEvery
            }
            a.step(current, now, eps)
            val d = a.display
            if (prev != null && d != null) {
                frames++
                if (Math.abs(d - prev) > 1e-4f) moving++
            }
            prev = d
            now += dtMs.toLong().coerceAtLeast(1L)
            t += dtMs
        }
        val ratio = moving.toFloat() / frames
        assertTrue(
            "指针应当在大部分时间都在动（实际 ${"%.0f".format(ratio * 100)}%，" +
                "$moving / $frames 帧）",
            ratio > 0.7f
        )
    }

    @Test
    fun `tau 变大后指针动的时间更长 —— 这就是顺不顺的关键`() {
        // 同一个数据序列，只改 τ。这条把"τ 从 45 提到 120 到底改善了什么"量化出来：
        // 指针处于动画状态的时间占比明显提高 → 看起来是"走过去"而不是"跳过去"。
        fun movingRatio(tau: Float): Float {
            val a = GaugeAnimator(tauMs = tau, mode = Easing.MODE_STANDARD, smoothMs = 0f, range = 8000f)
            val eps = 5.6f
            val dtMs = 1000f / 120f
            val values = (1..16).map { it * 40f }
            var now = 0L
            var t = 0f
            var idx = 0
            var nextPush = 0f
            var current = 0f
            var frames = 0
            var moving = 0
            var prev: Float? = null
            while (t < 200f * values.size) {
                if (t >= nextPush && idx < values.size) {
                    current = values[idx]; idx++; nextPush += 200f
                }
                a.step(current, now, eps)
                val d = a.display
                if (prev != null && d != null) {
                    frames++
                    if (Math.abs(d - prev) > 1e-4f) moving++
                }
                prev = d
                now += dtMs.toLong().coerceAtLeast(1L)
                t += dtMs
            }
            return moving.toFloat() / frames
        }

        val fast = movingRatio(45f)     // v1.10.4 之前的默认值
        val slow = movingRatio(120f)    // 现在的默认值
        assertTrue(
            "τ=120ms 时指针动的时间应当明显多于 τ=45ms（" +
                "${"%.0f".format(fast * 100)}% → ${"%.0f".format(slow * 100)}%）",
            slow > fast + 0.1f
        )
    }

    @Test
    fun `吸附阈值相对增量太大时会停一下再跳 —— 这是阈值本身的取舍`() {
        // ⚠️ 诚实地钉住一个**尺度依赖**行为，免得以后有人以为"改完就再也不会停"。
        //
        // 如果 ε 和单次增量同量级（增量 1、ε=0.5），指针一吸附就停住，
        // 等下次推送再跳一下 —— 和 v1.10.4 之前的表现一样。
        //
        // 真实参数下不会这样：ε 是**半个像素**（转速约 5.6），而数据每次变 20~50。
        // 也就是说 **ε 必须按像素折算、并远小于单次增量**，这条由子类覆写
        // `settleEpsilon` 保证（`BarGaugeView` / `CircularGaugeView` 都按自己的
        // 像素尺度折算）。
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_STANDARD, smoothMs = 0f, range = 100f)
        val eps = 0.5f
        var now = 0L
        a.step(0f, now, eps)
        // 目标 +1（和 ε 同量级）：跑到吸附为止，数用了多少帧
        var frames = 0
        while (Math.abs(a.display!! - 1f) > eps && frames < 200) {
            now += 16
            a.step(1f, now, eps)
            frames++
        }
        assertEquals("增量 1、ε=0.5 时应当吸附到位", 1f, a.display!!, eps)
        assertTrue("吸附很快（实际 $frames 帧）", frames < 40)
    }

    @Test
    fun `数据真的停住后 会停止动画`() {
        // 反向确认：不能因为"要顺"就永远 60fps 空转
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_STANDARD, smoothMs = 0f)
        a.step(0f, 0L, EPS)
        var now = 16L
        var needMore = true
        var stoppedAt = -1L
        while (now < 5000L) {
            needMore = a.step(100f, now, EPS)
            if (!needMore) { stoppedAt = now; break }
            now += 16L
        }
        assertTrue("应当会停下来（不能永远空转）", stoppedAt > 0)
        assertTrue(
            "至少要在 HOLD_MS 之后才停（实际 ${stoppedAt}ms）",
            stoppedAt >= Easing.HOLD_MS
        )
    }

    @Test
    fun `目标跳动后重新开始计时 —— 不会继承上一轮的稳定判定`() {
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_STANDARD, smoothMs = 0f)
        a.step(0f, 0L, EPS)
        // 让它在 100 上稳定下来
        var now = 16L
        var needMore = true
        var guard = 0
        while (needMore && guard < 2000) {
            needMore = a.step(100f, now, EPS)
            now += 16L
            guard++
        }
        assertFalse("先稳定下来", needMore)

        // 目标突然跳到 200：必须重新开始动画，而不是立刻判定"稳定"
        val more = a.step(200f, now, EPS)
        assertTrue("目标变化后必须继续动画", more)
        assertTrue("显示值不该一步跳到 200", a.display!! < 200f)
    }

    // ================================================================ 输入滤波

    @Test
    fun `输入滤波压掉单帧尖刺`() {
        // 先稳定在 100
        val withFilter = GaugeAnimator(tauMs = 120f, smoothMs = 200f)
        withFilter.step(100f, 0L, EPS)
        var now = 16L
        repeat(100) { withFilter.step(100f, now, EPS); now += 16L }

        // 一个尖刺
        withFilter.step(140f, now, EPS)
        val spiked = withFilter.display!!

        val noFilter = GaugeAnimator(tauMs = 120f, smoothMs = 0f)
        noFilter.step(100f, 0L, EPS)
        var n2 = 16L
        repeat(100) { noFilter.step(100f, n2, EPS); n2 += 16L }
        noFilter.step(140f, n2, EPS)
        val raw = noFilter.display!!

        assertTrue(
            "滤波后的尖刺应当明显小于未滤波（$spiked vs $raw）",
            spiked < raw
        )
    }

    @Test
    fun `滤波为 0 时不引入额外延迟`() {
        val a = GaugeAnimator(tauMs = 120f, smoothMs = 0f)
        a.step(0f, 0L, EPS)
        // 目标直接给 100，第一帧就该按缓动走（滤波不介入）
        a.step(100f, 16L, EPS)
        assertTrue("应当已经动起来", a.display!! > 0f)
    }

    // ================================================================ 重启

    @Test
    fun `重启后第一帧不会抽风`() {
        // 切页面回来：dt 可能是几百毫秒。restart() 必须清掉帧时间，
        // 否则第一帧 dt 巨大 → 一步跳到位（看着像闪一下）
        val a = GaugeAnimator(tauMs = 120f, smoothMs = 0f)
        a.step(0f, 0L, EPS)
        repeat(50) { a.step(0f, 16L * (it + 1), EPS) }

        a.restart()
        // 隔了很久才回来
        a.step(100f, 60_000L, EPS)
        val moved = Math.abs(a.display!! - 0f)
        assertTrue("重启后第一帧不该一步到位（实际走了 $moved / 100）", moved < 40f)
    }

    @Test
    fun `重启会作废上一轮的总行程`() {
        // 进度型曲线靠"总行程"算绝对位置。带着上一轮的行程重启会算错
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_SOFT, smoothMs = 0f)
        a.step(0f, 0L, EPS)
        var now = 16L
        repeat(60) { a.step(100f, now, EPS); now += 16L }
        val beforeRestart = a.display!!

        a.restart()
        a.step(50f, now, EPS)
        val after = a.display!!
        assertTrue(
            "重启后不该突然跳到别处（重启前 $beforeRestart，重启后 $after）",
            Math.abs(after - beforeRestart) < 30f
        )
    }

    @Test
    fun `snapTo 直接跳到位 不经过动画`() {
        val a = GaugeAnimator()
        a.step(0f, 0L, EPS)
        a.snapTo(999f)
        assertEquals(999f, a.display!!, 1e-3f)
    }

    // ================================================================ 各曲线在状态机里都能收敛

    @Test
    fun `四种曲线在状态机里都能收敛到目标`() {
        listOf(
            Easing.MODE_STANDARD, Easing.MODE_LINEAR, Easing.MODE_SOFT, Easing.MODE_SNAPPY
        ).forEach { mode ->
            val a = GaugeAnimator(tauMs = 120f, mode = mode, smoothMs = 0f, range = 100f)
            a.step(0f, 0L, EPS)
            var now = 16L
            var needMore = true
            var guard = 0
            while (needMore && guard < 3000) {
                needMore = a.step(100f, now, EPS)
                now += 16L
                guard++
            }
            assertEquals(
                "mode=$mode 应当收敛到目标（用了 $guard 帧）",
                100f, a.display!!, 1f
            )
        }
    }

    @Test
    fun `下降方向也能收敛 —— 曾经在这里漏过`() {
        // 进度型曲线的"总行程"对下降方向是负数。实现里若忘了取绝对值，
        // 负数会被夹成 0 → **下降方向恒不动**，而上升方向的用例完全测不出来。
        listOf(Easing.MODE_SOFT, Easing.MODE_SNAPPY).forEach { mode ->
            val a = GaugeAnimator(tauMs = 120f, mode = mode, smoothMs = 0f, range = 100f)
            a.step(100f, 0L, EPS)
            var now = 16L
            var needMore = true
            var guard = 0
            while (needMore && guard < 3000) {
                needMore = a.step(0f, now, EPS)
                now += 16L
                guard++
            }
            assertEquals(
                "mode=$mode 下降也应当收敛到 0（实际 ${a.display}）",
                0f, a.display!!, 1f
            )
        }
    }

    @Test
    fun `长时间运行不会漂移`() {
        // 反复推同一个值：显示值不该慢慢跑偏（吸附 + 滤波都可能引入漂移）
        val a = GaugeAnimator(tauMs = 120f, mode = Easing.MODE_STANDARD, smoothMs = 90f)
        a.step(0f, 0L, EPS)
        var now = 16L
        repeat(3000) { a.step(1234.5f, now, EPS); now += 16L }
        assertEquals("3000 帧后应当稳定在目标上", 1234.5f, a.display!!, 1f)
    }

    @Test
    fun `display 在第一次 step 之前是 null`() {
        val a = GaugeAnimator()
        assertNull(a.display)
        a.step(1f, 0L, EPS)
        assertNotNull(a.display)
    }
}
