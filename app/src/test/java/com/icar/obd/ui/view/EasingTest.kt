package com.icar.obd.ui.view

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 数值动画的三层纯逻辑（v1.10.4）：**输入滤波 + 缓动曲线 + 收敛判据**。
 *
 * 这里钉的都是"放进 `onDraw` 就没法验证"的东西：
 *  - 会不会永远追不上（收敛性）
 *  - 会不会过冲（指针冲过目标再弹回来，很难看）
 *  - 换帧率会不会变快变慢（时间基准）
 *  - **数据还在变时会不会提前冻住**（v1.10.4 修的那个"停一下再跳"）
 *  - 输入抖动被压掉多少
 */
class EasingTest {

    /** 所有曲线模式。新增模式必须也满足下面这组通用约束 */
    private val allModes = listOf(
        Easing.MODE_STANDARD, Easing.MODE_LINEAR, Easing.MODE_SOFT, Easing.MODE_SNAPPY
    )

    /**
     * 跑固定墙钟时间，返回最终值。
     *
     * ⚠️ **必须模拟调用方的状态**：按帧推进 `elapsedMs`，并在目标变化时
     * 固定"总行程"（`journeyStart` / `journeyDist`）。
     *
     * 进度型曲线（柔和 / 干脆）靠这两样才能算绝对位置 ——
     * 不传的话进度恒为 0、或者退化成"剩余距离 × 速度"的衰减路径，
     * 后者**永远到不了目标**（这个坑第一版就踩了，实测停在 64.76%）。
     */
    private fun run(
        from: Float, target: Float, durationMs: Float, fps: Float,
        tau: Float = 120f, mode: Int = Easing.MODE_STANDARD, range: Float = 100f
    ): Float {
        val dt = 1000f / fps
        var v = from
        var elapsed = 0f
        var t = 0f
        // 起点固定为初始值；行程固定为初始差（这个用例里目标不变）
        val journeyStart = from
        val journeyDist = target - from
        while (t < durationMs) {
            v = Easing.step(v, target, dt, tau, mode, range, elapsed, journeyStart, journeyDist)
            elapsed += dt
            t += dt
        }
        return v
    }

    // ================================================================ 通用约束（所有曲线）

    @Test
    fun `所有曲线都单调逼近 不过冲`() {
        // ⚠️ 必须按帧推进 elapsedMs，并固定"总行程"：
        // 进度型曲线靠这两样算绝对位置。缺了会退化成衰减路径（到不了目标）。
        val dt = 16.7f
        allModes.forEach { mode ->
            var up = 0f
            var el = 0f
            val jsUp = 0f
            val jdUp = 100f
            repeat(200) {
                val next = Easing.step(up, 100f, dt, 120f, mode, 100f, el, jsUp, jdUp)
                assertTrue("$mode 上升方向过冲：$up → $next", next >= up && next <= 100f)
                up = next
                el += dt
            }
            assertEquals("$mode 应当收敛到目标", 100f, up, 0.5f)

            var down = 100f
            el = 0f
            // 下降：起点 100，行程 = 目标 − 起点 = −100（**符号必须对**）
            val jsDown = 100f
            val jdDown = -100f
            repeat(200) {
                val next = Easing.step(down, 0f, dt, 120f, mode, 100f, el, jsDown, jdDown)
                assertTrue("$mode 下降方向过冲：$down → $next", next <= down && next >= 0f)
                down = next
                el += dt
            }
            assertEquals("$mode 下降也应当收敛", 0f, down, 0.5f)
        }
    }

    @Test
    fun `所有曲线最终都收敛到目标`() {
        allModes.forEach { mode ->
            val v = run(0f, 100f, 3000f, 60f, mode = mode)
            assertEquals("$mode 3 秒后应到位", 100f, v, 0.5f)
        }
    }

    @Test
    fun `所有曲线换帧率结果接近`() {
        // 时间基准的核心价值：这台平板能跑 120Hz，别的设备 60Hz。
        // ⚠️ 容差 1f 是**收紧过的** —— 修掉两个帧率相关缺陷之后实测差 < 1：
        //   1. 指数逼近的增量积分漂移（见 `Easing.REF_FRAME_MS`）
        //   2. 进度型曲线把曲线参数当"每帧进度"用（见 `Easing.progressSpeed`）
        // 原来这两处会让 60Hz 与 120Hz 在同样 250ms 后差 20 个百分点。
        allModes.forEach { mode ->
            val at60 = run(0f, 100f, 250f, 60f, mode = mode)
            val at120 = run(0f, 100f, 250f, 120f, mode = mode)
            assertEquals("$mode 60Hz 与 120Hz 在同样 250ms 后应当接近", at60, at120, 1f)
        }
    }

    @Test
    fun `所有曲线一帧都不跳到位 —— 要能看出动画`() {
        // 进度型曲线在进度 0 处速度为 0（柔和）或最大（干脆），所以两种都传 elapsed=0
        allModes.forEach { mode ->
            val v = Easing.step(0f, 100f, 16.7f, 120f, mode, 100f, 0f)
            assertTrue("$mode 一帧就跑了 $v，看不出动画", v >= 0f && v < 90f)
        }
        // 至少要有曲线在第一帧就动起来（否则"一帧不跳到位"是空断言）
        val moving = allModes.count { Easing.step(0f, 100f, 16.7f, 120f, it, 100f, 0f) > 0f }
        assertTrue("应当有曲线第一帧就动（实际 $moving 种）", moving >= 2)
    }

    @Test
    fun `dt 为 0 或负数时不动`() {
        allModes.forEach { mode ->
            assertEquals("$mode", 10f, Easing.step(10f, 100f, 0f, 120f, mode, 100f), 1e-6f)
            assertEquals("$mode", 10f, Easing.step(10f, 100f, -5f, 120f, mode, 100f), 1e-6f)
        }
    }

    @Test
    fun `dt 异常大时被夹住 不会瞬移`() {
        allModes.forEach { mode ->
            val v = Easing.step(0f, 100f, 5000f, 120f, mode, 100f)
            assertTrue("$mode dt=5000ms 也不该一步到位，实际 $v", v < 100f)
        }
    }

    @Test
    fun `目标与当前相同时原样返回`() {
        allModes.forEach { mode ->
            assertEquals("$mode", 42f, Easing.step(42f, 42f, 16.7f, 120f, mode, 100f), 1e-6f)
        }
    }

    @Test
    fun `未知曲线模式回落到标准而不是崩`() {
        val std = Easing.step(0f, 100f, 16.7f, 120f, Easing.MODE_STANDARD, 100f)
        val unknown = Easing.step(0f, 100f, 16.7f, 120f, 999, 100f)
        assertEquals(std, unknown, 1e-6f)
    }

    // ================================================================ 各曲线的特征

    @Test
    fun `标准曲线一个 tau 走约 63百分之`() {
        val v = run(0f, 100f, 120f, 480f, tau = 120f)
        assertEquals("一个时间常数应走约 63.2%", 63.2f, v, 2f)
    }

    @Test
    fun `线性曲线匀速前进`() {
        // 每帧位移应基本相同（这正是"线性"的定义）
        //
        // ⚠️ 用 τ=1000 让整段路走 10 帧也走不完 —— 否则**最后一帧会因为夹取而变短**
        // （那是"不过冲"的正确行为，但会破坏"每步一致"这个断言）。
        var v = 0f
        val steps = mutableListOf<Float>()
        repeat(10) {
            val next = Easing.step(v, 1000f, 16.7f, 1000f, Easing.MODE_LINEAR, 1000f)
            steps.add(next - v)
            v = next
        }
        val first = steps.first()
        steps.forEach {
            assertEquals("线性模式每帧位移应当一致", first, it, 0.01f)
        }
        assertTrue("位移应当为正", first > 0f)
        assertTrue("十帧还没走完（这样每步才都不受夹取影响），实际 $v", v < 1000f)
    }

    @Test
    fun `线性曲线最后一帧会因为夹取而变短 —— 不过冲的代价`() {
        // 上面那条为了测"匀速"刻意避开了夹取。这条**正面钉住夹取行为**：
        // 走完总行程所需帧数之后，最后一帧必然短于前面各帧，否则就会过冲。
        val tau = 120f
        val range = 1000f
        val dt = 16.7f
        val perFrame = range / tau * dt          // ≈139.17
        val framesToFinish = Math.ceil((range / perFrame).toDouble()).toInt()

        var v = 0f
        val deltas = mutableListOf<Float>()
        repeat(framesToFinish) {
            val next = Easing.step(v, range, dt, tau, Easing.MODE_LINEAR, range)
            deltas.add(next - v)
            v = next
        }
        assertEquals("走完就应当正好到量程", range, v, 0.01f)
        assertTrue(
            "最后一帧应当短于常规步长（${deltas.last()} vs $perFrame）",
            deltas.last() < perFrame
        )
        assertTrue("但前几帧应当是常规步长", deltas.first() >= perFrame - 0.01f)
    }

    @Test
    fun `线性曲线不会走过头`() {
        // 速度乘以 dt 可能超过剩余距离 —— 必须夹住
        val v = Easing.step(99f, 100f, 100f, 10f, Easing.MODE_LINEAR, 1000f)
        assertTrue("线性模式不能冲过目标，实际 $v", v <= 100f)
    }

    @Test
    fun `柔和曲线中段最快 起步与收尾都慢`() {
        // ease-in-out 的特征：速度先增后减，峰值在中段（进度 0.5 附近）
        // ⚠️ 必须传 elapsedMs + 固定总行程 —— 进度型曲线靠这两样算绝对位置
        val tau = 100f              // 总时长 = 2τ = 200ms
        val dt = 10f
        var v = 0f
        var elapsed = 0f
        val speeds = mutableListOf<Float>()
        // ⚠️ 跑**正好**总时长：跑满 20 帧时 elapsed 最后是 190ms，
        // 曲线(190/200)=0.9925 → 停在 99.275，不是 100。
        // 多跑一帧才到 100（那时进度 1.0）。所以这里跑 21 帧再断言到位。
        repeat(21) {
            val next = Easing.step(v, 100f, dt, tau, Easing.MODE_SOFT, 100f, elapsed, 0f, 100f)
            speeds.add(next - v)
            v = next
            elapsed += dt
        }
        val peakIdx = speeds.indexOf(speeds.max())
        assertTrue(
            "速度峰值应落在中段（实际第 $peakIdx 帧 / 共 21 帧，速度=$speeds）",
            peakIdx in 7..13
        )
        assertTrue("起步应当明显慢于峰值（首帧 ${speeds.first()} vs 峰值 ${speeds[peakIdx]}）",
            speeds.first() < speeds[peakIdx] * 0.5f)
        assertTrue("收尾也应当慢下来（末帧 ${speeds.last()}）",
            speeds.last() < speeds[peakIdx] * 0.5f)
        assertEquals("总时长走完应当正好到位", 100f, v, 0.01f)
    }

    @Test
    fun `进度型曲线走满总时长时恰好到位 —— 绝对位置的核心保证`() {
        // 这是"绝对位置"机制相对"增量"机制的关键优势：
        // 曲线(1) = 1，所以进度到 1 时**精确**落在目标上，不会有残差
        val tau = 120f
        val duration = tau * 2f
        listOf(Easing.MODE_SOFT, Easing.MODE_SNAPPY).forEach { mode ->
            val v = Easing.step(
                0f, 100f, duration, tau, mode, 100f,
                elapsedMs = duration,          // 进度正好 1
                journeyStart = 0f, journeyDist = 100f
            )
            assertEquals("$mode 在进度 1 处应当精确到位", 100f, v, 0.01f)
        }
    }

    @Test
    fun `干脆曲线起步最快 之后单调变慢`() {
        val tau = 100f
        val dt = 10f
        var v = 0f
        var elapsed = 0f
        val speeds = mutableListOf<Float>()
        repeat(18) {
            val next = Easing.step(v, 100f, dt, tau, Easing.MODE_SNAPPY, 100f, elapsed, 0f, 100f)
            speeds.add(next - v)
            v = next
            elapsed += dt
        }
        // ⚠️ 第 0 帧位移为 0：曲线(0)=0 → 位置还在起点。这是**正确**的
        // （曲线从起点开始），所以从第 1 帧起检查单调性。
        assertEquals("进度 0 处不该动", 0f, speeds.first(), 1e-4f)

        for (i in 2 until speeds.size) {
            assertTrue(
                "ease-out 应当单调变慢：第 ${i - 1} 帧 ${speeds[i - 1]} → 第 $i 帧 ${speeds[i]}",
                speeds[i] <= speeds[i - 1] + 1e-3f
            )
        }
        assertTrue(
            "第 1 帧应当最快（${speeds[1]}），末帧应当最慢（${speeds.last()}）",
            speeds[1] > speeds.last()
        )
    }

    @Test
    fun `进度型曲线不传 elapsedMs 时进度从 0 起算`() {
        // elapsedMs 默认 -1 = "刚变化"。此时进度 0：
        //  - 柔和（ease-in-out）曲线(0) = 0 → 位置还在起点，不动
        //  - 干脆（ease-out）曲线(0) = 0 → 同样不动
        // 这是**正确**的（曲线从起点开始），但要显式钉住，
        // 否则以后有人改成"默认按一帧算"会悄悄改掉手感。
        val soft = Easing.step(0f, 100f, 16.7f, 120f, Easing.MODE_SOFT, 100f, -1f, 0f, 100f)
        assertEquals("进度 0 处位移比例应为 0", 0f, soft, 1e-4f)
        val snappy = Easing.step(0f, 100f, 16.7f, 120f, Easing.MODE_SNAPPY, 100f, -1f, 0f, 100f)
        assertEquals("进度 0 处位移比例同样应为 0", 0f, snappy, 1e-4f)
    }

    @Test
    fun `进度型曲线在总时长之后会到位`() {
        // 总时长 = 2τ。跑 3τ 应当**正好到位**（这是绝对位置机制的核心保证）
        allModes.filter { it == Easing.MODE_SOFT || it == Easing.MODE_SNAPPY }.forEach { mode ->
            val v = run(0f, 100f, 360f, 120f, tau = 120f, mode = mode)
            assertEquals("$mode 3τ 后应当正好到位", 100f, v, 0.5f)
        }
    }

    @Test
    fun `进度型曲线缺总行程时也能收敛 —— 兜底路径不许空转`() {
        // ⚠️ 兜底路径（调用方没给 journeyStart/journeyDist）**必须能收敛**。
        //
        // 我第一版把曲线写成"每帧位移 = 剩余距离 × 曲线速度 × dt/时长"，
        // 剩余距离逐帧缩小 → 位移逐帧衰减 → **永远到不了目标**（实测停在 64.76%），
        // 而那会让动画永远空转（`needsMoreFrames` 一直为真）。
        // 现在兜底改成"进度 ≥ 1 时直接落到目标"，这条钉住它。
        val tau = 120f
        val duration = tau * 2f
        listOf(Easing.MODE_SOFT, Easing.MODE_SNAPPY).forEach { mode ->
            var v = 0f
            var elapsed = 0f
            val dt = 16.667f
            var frames = 0
            // 不传 journey*，走兜底路径
            while (frames < 200) {
                v = Easing.step(v, 100f, dt, tau, mode, 100f, elapsed)
                elapsed += dt
                frames++
                if (Math.abs(v - 100f) < 0.5f) break
            }
            assertEquals(
                "$mode 兜底路径也应当收敛到目标（用了 $frames 帧）",
                100f, v, 0.5f
            )
            assertTrue("不该跑太久（实际 $frames 帧）", frames < 60)
        }
    }

    @Test
    fun `进度型曲线给了总行程时曲线形状正确`() {
        // 与上一条对照：给了总行程走的是正常路径，位移必须**先增后减**
        // （兜底路径是线性的，没有形状 —— 这正是为什么要固定总行程）
        val tau = 100f
        val dt = 10f
        var v = 0f
        var elapsed = 0f
        val speeds = mutableListOf<Float>()
        repeat(20) {
            val next = Easing.step(v, 100f, dt, tau, Easing.MODE_SOFT, 100f, elapsed, 0f, 100f)
            speeds.add(next - v)
            v = next
            elapsed += dt
        }
        val peak = speeds.indexOf(speeds.max())
        assertTrue("给了总行程时曲线应当有形状（峰值在中段，实际第 $peak 帧）", peak in 7..12)
    }

    @Test
    fun `不同曲线在同一时刻给出不同结果 —— 说明真的在换曲线`() {
        // 取一个进度型曲线已经"走起来"的时刻（elapsed=100ms，总时长 240ms）
        val a = Easing.step(0f, 100f, 50f, 120f, Easing.MODE_STANDARD, 100f, 100f, 0f, 100f)
        val b = Easing.step(0f, 100f, 50f, 120f, Easing.MODE_LINEAR, 100f, 100f, 0f, 100f)
        val c = Easing.step(0f, 100f, 50f, 120f, Easing.MODE_SOFT, 100f, 100f, 0f, 100f)
        val d = Easing.step(0f, 100f, 50f, 120f, Easing.MODE_SNAPPY, 100f, 100f, 0f, 100f)
        val set = setOf(a, b, c, d)
        assertEquals(
            "四种曲线不该给出同一个值（实际 standard=$a linear=$b soft=$c snappy=$d）",
            4, set.size
        )
    }

    @Test
    fun `tau 越大越慢`() {
        val fast = Easing.step(0f, 100f, 50f, 50f, Easing.MODE_STANDARD, 100f)
        val slow = Easing.step(0f, 100f, 50f, 300f, Easing.MODE_STANDARD, 100f)
        assertTrue("τ 大应当走得更少（fast=$fast slow=$slow）", slow < fast)
    }

    // ================================================================ 输入滤波

    @Test
    fun `滤波时间常数为 0 时原样返回`() {
        assertEquals("0 = 不滤波，零开销路径", 77f, Easing.smooth(10f, 77f, 16.7f, 0f), 1e-6f)
    }

    @Test
    fun `首帧直接采用原始值`() {
        // prev 为 null（刚启动）时没有历史可滤，直接用原值
        assertEquals(42f, Easing.smooth(null, 42f, 16.7f, 90f), 1e-6f)
    }

    @Test
    fun `滤波压掉抖动 —— 单帧尖刺只影响到一部分`() {
        val smoothMs = 200f
        val steady = 100f
        // 一个 20 的尖刺
        val out = Easing.smooth(steady, 120f, 16.7f, smoothMs)
        assertTrue("尖刺应当被压掉大半（实际走到 $out）", out < steady + 20f * 0.2f)
        assertTrue("但方向要对（应当往上）", out > steady)
    }

    @Test
    fun `滤波是时间基准的 —— 帧率无关`() {
        // 同样 200ms，60Hz 与 120Hz 结果应当接近
        var a = 0f
        var b = 0f
        repeat(12) { a = Easing.smooth(a, 100f, 16.7f, 150f) }
        repeat(24) { b = Easing.smooth(b, 100f, 8.33f, 150f) }
        assertEquals("滤波也必须帧率无关", a, b, 1.5f)
    }

    @Test
    fun `滤波最终会追上原始值`() {
        var v = 0f
        repeat(400) { v = Easing.smooth(v, 100f, 16.7f, 90f) }
        assertEquals("持续给同一个值，最终应当完全追上", 100f, v, 0.5f)
    }

    @Test
    fun `滤波时间常数越大越稳`() {
        val light = Easing.smooth(100f, 200f, 16.7f, 30f)
        val heavy = Easing.smooth(100f, 200f, 16.7f, 400f)
        assertTrue("τ 大应当更保守（light=$light heavy=$heavy）", heavy < light)
    }

    // ================================================================ 收敛判据（v1.10.4 核心修复）

    @Test
    fun `距离还远时必须继续动画`() {
        assertTrue(Easing.needsMoreFrames(dist = 10f, epsilon = 0.5f, sinceTargetChangeMs = 5000L))
    }

    @Test
    fun `数据还在变时 即使已经很近也要继续动画`() {
        // ⚠️ 这是 v1.10.4 修的那个 bug 的核心断言。
        //
        // 数据 5Hz 推，两次推送之间目标不变。旧逻辑只要距离 ≤ epsilon 就停止动画 ——
        // 于是指针早早"趴"在目标上，下次推送再跳一下，看起来一格一格的。
        assertTrue(
            "目标 100ms 前才变过 → 必须继续动画，不能冻住",
            Easing.needsMoreFrames(dist = 0.1f, epsilon = 0.5f, sinceTargetChangeMs = 100L)
        )
        assertTrue(
            "目标 599ms 前变过（还没到 HOLD_MS）→ 仍要继续",
            Easing.needsMoreFrames(dist = 0.0f, epsilon = 0.5f, sinceTargetChangeMs = 599L)
        )
    }

    @Test
    fun `数据稳定下来之后才允许停止`() {
        assertFalse(
            "目标已经 ${Easing.HOLD_MS}ms 没变了，且距离在阈值内 → 可以停，不必空转",
            Easing.needsMoreFrames(dist = 0.1f, epsilon = 0.5f, sinceTargetChangeMs = Easing.HOLD_MS)
        )
        assertFalse(
            "更久之后当然也能停",
            Easing.needsMoreFrames(dist = 0.0f, epsilon = 0.5f, sinceTargetChangeMs = 5000L)
        )
    }

    @Test
    fun `HOLD_MS 至少覆盖两个推送周期`() {
        // 5Hz 推送 = 200ms 一次。HOLD_MS 太短的话，在两次推送之间就会误判"数据停了"
        assertTrue("HOLD_MS 应 ≥ 400ms（两个 5Hz 周期），实际 ${Easing.HOLD_MS}",
            Easing.HOLD_MS >= 400L)
    }

    @Test
    fun `吸附只消除尾巴 不决定要不要继续`() {
        assertTrue("够近就该吸附", Easing.shouldSnap(0.3f, 0.5f))
        assertFalse("还远就不吸附", Easing.shouldSnap(5f, 0.5f))
        // 吸附与"继续动画"是两件事：够近 + 数据还在动 → 吸附但继续
        assertTrue(Easing.shouldSnap(0.3f, 0.5f))
        assertTrue(Easing.needsMoreFrames(0.3f, 0.5f, 50L))
    }

    // ================================================================ 回归：模拟真实的 5Hz 推送

    @Test
    fun `5Hz 数据推送下 指针每一帧都在动 —— 不再停一下再跳`() {
        // 模拟真实场景：目标每 200ms 变一次、缓慢上升（像水温上升 / 正弦峰顶）。
        // 旧逻辑会在两次推送之间判定"已收敛"→ 停止动画 → 下次推送再跳一下。
        val fps = 120f
        val dt = 1000f / fps
        val pushMs = 200f                 // 5Hz
        val epsilon = 0.5f
        val tau = 120f
        val range = 8000f

        var display = 0f
        var target = 0f
        var now = 0f
        var nextPush = pushMs
        var lastTargetChange = 0f
        var stoppedFrames = 0            // 判定"可以停止"的帧数 —— 目标一直在变，应当是 0
        var maxFrameJump = 0f            // 单帧最大位移，用来确认不是"一帧跳到位"

        while (now < 4000f) {
            if (now >= nextPush) {
                target += 1.0f           // 每次推送只涨 1（慢变，最容易暴露"冻住"）
                lastTargetChange = now
                nextPush += pushMs
            }
            val from = display
            val next = Easing.step(from, target, dt, tau, Easing.MODE_STANDARD, range)
            val dist = Math.abs(target - from)
            display = if (Easing.shouldSnap(dist, epsilon)) target else next

            if (!Easing.needsMoreFrames(Math.abs(target - display), epsilon, (now - lastTargetChange).toLong())) {
                stoppedFrames++
            }
            maxFrameJump = Math.max(maxFrameJump, Math.abs(display - from))
            now += dt
        }

        assertEquals(
            "目标一直在缓慢变化，就不该出现「判定可停止」的帧（实际 $stoppedFrames 帧）",
            0, stoppedFrames
        )
        assertTrue("最终应当追到目标附近", Math.abs(display - target) < 3f)
        assertTrue(
            "单帧位移应当很小（不是一帧跳到位，实际 $maxFrameJump）",
            maxFrameJump < 1f
        )
    }

    @Test
    fun `目标真的停住后 会停止动画 不空转`() {
        // 反向确认：不能因为"要顺"就永远 60fps 空转
        var display = 0f
        val target = 100f
        var now = 0L
        val dt = 8.33f
        var stoppedAt = -1L
        var t = 0f
        var lastTargetChange = 0L
        while (t < 5000f) {
            val next = Easing.step(display, target, dt, 120f, Easing.MODE_STANDARD, 100f)
            val dist = Math.abs(target - display)
            display = if (Easing.shouldSnap(dist, 0.5f)) target else next
            val needMore = Easing.needsMoreFrames(
                Math.abs(target - display), 0.5f, now - lastTargetChange
            )
            if (!needMore) { stoppedAt = now; break }
            now += dt.toLong().coerceAtLeast(1L)
            t += dt
        }
        assertTrue("应当会停下来（不能永远空转）", stoppedAt >= 0)
        assertTrue("但至少要在 HOLD_MS 之后才停（实际 ${stoppedAt}ms）", stoppedAt >= Easing.HOLD_MS)
    }

    // ================================================================ 曲线名

    @Test
    fun `曲线名数量与模式数量一致`() {
        assertEquals("MODE_NAMES 必须覆盖全部模式", 4, Easing.MODE_NAMES.size)
        allModes.forEach { m ->
            assertNotEquals("模式 $m 没有名字", "", Easing.modeName(m))
        }
    }

    @Test
    fun `未知模式名回落到标准`() {
        assertEquals(Easing.MODE_NAMES[Easing.MODE_STANDARD], Easing.modeName(999))
        assertEquals(Easing.MODE_NAMES[Easing.MODE_STANDARD], Easing.modeName(-1))
    }

    @Test
    fun `曲线名是冻结的契约`() {
        // 名字存进主题 JSON —— 改了会让存量主题显示成"标准"（静默回落）
        assertEquals(
            listOf("标准（指数）", "线性（匀速）", "柔和（缓入缓出）", "干脆（缓出）"),
            Easing.MODE_NAMES
        )
    }
}
