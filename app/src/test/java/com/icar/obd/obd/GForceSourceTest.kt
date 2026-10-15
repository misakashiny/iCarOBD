package com.icar.obd.obd

import com.icar.obd.data.PidValue
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [GForceSource] 车速差分路径（`MODE_SPEED`）的**持久回归测试**（T2）。
 *
 * ## 它验证的是**真实生产路径**，不是复制出来的算法
 *
 * 每一个期望值都来自 `GForceSource.onCycle(now)` **真实跑出来的** `calc_gx` / `calc_gy` /
 * `calc_gforce`。测试只做两件事：
 *
 * 1. 往 [VehicleBus] 写 `std_0D`（车速）—— 生产里由 OBD 轮询写入；
 * 2. 通过反射写 `mode` / `lastSpeed` / `lastTs` / `fx` 这些**输入状态**，
 *    然后用**受控时钟** `onCycle(now)` 推进一拍。
 *
 * 算法本身（限幅、`SPEED_ALPHA` 滤波、除 G）**一行都没有在测试里复刻** ——
 * 期望值用的是 §T1-R2-3 的逐拍递推公式，它来自算法定义，不是来自实现拷贝。
 *
 * ## Android Context 的隔离范围（TASK.md 要求明确）
 *
 * `GForceSource(ctx)` 的构造函数会 `ctx.getSystemService(...)`，JVM 单测里没有 `Context`，
 * 所以用 `sun.misc.Unsafe.allocateInstance` **绕过构造函数**分配实例。
 * 这样做的**前提是安全的**：`onCycle()` 只读 [VehicleBus] 和自己的字段，**从不碰 `ctx`**
 * （`ctx` 只在构造、`startSensor` / `stopSensor` 里用到）。
 *
 * **隔离边界**：本测试类只分配 `mode = MODE_SPEED` 的实例；**从不注册传感器**、
 * 从不调用 `onSensorChanged`、从不触碰 [VehicleBus] 之外的单例。
 * 每个用例前后都 `VehicleBus.clear()`，不留状态给别的用例。
 *
 * ## 单位约定（本测试锁定的语义）
 *
 * - `fx` / `fy` 内部**一律 m/s²**（与字段注释 `:78` 一致）；
 * - 限幅对象是 m/s²：`±MAX_G × G`；
 * - **只有 `emit` 出口除一次 G**。
 *
 * 参考：`STATUS.md` 的 §T1-R2-2 / §T1-R2-3 / §T1-R2-8b（探针源码）。
 * ⚠️ 不采用历史 §7 那套「先写 lastTs 再用另一次 `currentTimeMillis()` 反推 dt」的脚手架。
 */
class GForceSourceTest {

    private companion object {
        /** `GForceSource.G` */
        const val G = 9.80665f

        /** `GForceSource.SPEED_ALPHA` */
        const val SPEED_ALPHA = 0.30f

        /** `GForceSource.MAX_G` */
        const val MAX_G = 2f

        /** `GForceSource.MODE_SPEED` */
        const val MODE_SPEED = 2

        /** `GForceSource.MODE_OFF` */
        const val MODE_OFF = 0

        /**
         * 零初态、Δv = +36 km/h、dt = 1.000 s 的首拍期望值：
         * `0.30 × ((36/3.6)/1) / 9.80665 = 0.30591485 G`。
         */
        const val FIRST_36KMH_1S_G = 0.30591485f

        /** 受控时钟起点；每拍 +1000 ms ⇒ dt 精确为 1.000 s。 */
        const val T0 = 1_000_000L
    }

    private lateinit var src: Any

    /**
     * `sun.misc.Unsafe` 实例，按 `Any` 持有。
     *
     * ⚠️ **类型必须写 `Any`**（2026-10-11 T2-R 实测）：把类型写成 `sun.misc.Unsafe` 会让 Kotlin
     * 在**编译期**解析这个类名 —— 本工程 `compileDebugUnitTestKotlin` 的 classpath 下
     * `sun.misc.Unsafe` **不是可见类型**，直接报 `Unresolved reference 'sun'` 编译失败。
     * 走反射取实例（`Class.forName`）则只在**运行时**需要它，这才是能编过的写法。
     * 代价只是 `alloc()` 里 `invoke` 的返回值被推断成 `Any?`，编译期给一条
     * `Java type mismatch` 警告 —— **警告不影响结果**，用 `!!` 收窄。
     */
    private val unsafe: Any by lazy {
        val c = Class.forName("sun.misc.Unsafe")
        c.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    }

    private fun alloc(cls: Class<*>): Any =
        Class.forName("sun.misc.Unsafe").getMethod("allocateInstance", Class::class.java)
            .invoke(unsafe, cls)!!

    private fun field(name: String) =
        src.javaClass.getDeclaredField(name).apply { isAccessible = true }

    /** 用 `Unsafe` 绕过需要 `Context` 的构造函数，只反射写 `mode`（不碰传感器）。 */
    private fun newSource(mode: Int = MODE_SPEED): Any {
        val s = alloc(GForceSource::class.java)
        s.javaClass.getDeclaredField("mode").apply { isAccessible = true }.setInt(s, mode)
        return s
    }

    @Before
    fun setUp() {
        VehicleBus.clear()
        src = newSource()
    }

    @After
    fun tearDown() {
        // TASK.md：每项测试后清理 VehicleBus，避免派生通道泄漏给别的用例
        VehicleBus.clear()
    }

    // ------------------------------------------------------------------ 驱动辅助

    private fun putSpeed(kmh: Float) {
        VehicleBus.put(PidValue("std_0D", kmh, "gforce-test", System.currentTimeMillis(), true))
    }

    private fun gy(): Float? = VehicleBus.value("calc_gy")
    private fun gx(): Float? = VehicleBus.value("calc_gx")
    private fun gforce(): Float? = VehicleBus.value("calc_gforce")

    /**
     * 跑**一拍真实生产周期**：`onCycle(now)`。
     *
     * 受控时钟是 TASK.md §2 规定的最小接口 —— 同一个 `now` 既算 `dt` 又写回 `lastTs`，
     * 所以 `dt` 完全确定，不需要从时钟反推。
     *
     * @param prevTs 上一拍的时间戳（生产里由上一拍 `onCycle` 写回）。零初态指的是
     *   `fx`/`fy` 为 0，**不是** `lastTs` 为 0 —— `lastTs == 0L` 时生产代码直接跳过。
     */
    private fun cycle(speedKmh: Float, prevSpeedKmh: Float, prevTs: Long, now: Long) {
        putSpeed(speedKmh)
        field("lastSpeed").set(src, prevSpeedKmh)
        field("lastTs").setLong(src, prevTs)
        src.javaClass.getMethod("onCycle", Long::class.javaPrimitiveType!!).invoke(src, now)
    }

    /** 该拍代码**实际使用**的 dt：读回它自己写进去的 `lastTs`，与 `now` 相减。 */
    private fun lastTs(): Long = field("lastTs").getLong(src)

    /**
     * 反射读回一个字段。
     *
     * ⚠️ **字段类型不一样**（2026-10-11 T2-R 更正）：
     * - `fx` / `fy` 是**非空 `Float`**（Kotlin 基本类型 → JVM 原始 `float`），`get()` 返回**装箱的 `java.lang.Float`**，
     *   但 `getFloat()` **可以**读原始字段；
     * - 只有 `lastSpeed` 是 `Float?`（Kotlin 可空基本类型 → **装箱的 `java.lang.Float`**），
     *   读它**必须**用 `get()`。
     *
     * 所以这里统一走 `get()` + `as Float?`：对原始 `float` 字段，反射会先装箱，这条路径两种字段都能用。
     */
    private fun floatField(name: String): Float? = field(name).get(src) as Float?

    /**
     * 生产里真实使用的调用形态（`ObdController.kt:246` 的 `gForce.onCycle()`）。
     *
     * `onCycle` 带默认参数后 Kotlin **不会**生成真正的无参重载，编译器把
     * `onCycle()` 编成对合成方法 `onCycle$default(src, 0L, 1, null)` 的调用 ——
     * 所以这里也走那条合成方法，**与生产完全同一条代码路径**（走默认时钟）。
     */
    private fun cycleNoArg() {
        src.javaClass.getMethod(
            "onCycle\$default",
            GForceSource::class.java, Long::class.javaPrimitiveType!!,
            Int::class.javaPrimitiveType!!, Any::class.java
        ).invoke(null, src, 0L, 1, null)
    }

    /** 单拍限幅后的输入（m/s²→G 之前就钳位，单位语义就是本测试要锁的东西）。 */
    private fun clampedGFor(deltaKmh: Float, dt: Float): Float =
        (((deltaKmh / 3.6f) / dt) / G).coerceIn(-MAX_G, MAX_G)

    // ================================================================ ① 零初态首拍

    @Test
    fun `首拍 零初态 正 36 kmh 1 s 应为 0_30591485 G`() {
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 1000L)

        assertEquals("dt 必须精确 1.000 s（受控时钟）", 1.000f, (lastTs() - T0) / 1000f, 1e-9f)
        assertEquals(
            "零初态首拍 +36 km/h / 1 s 应 = 0.30591485 G",
            FIRST_36KMH_1S_G, gy()!!, 1e-5f
        )
    }

    @Test
    fun `首拍 零初态 负 36 kmh 1 s 应为 负 0_30591485 G`() {
        cycle(speedKmh = 100f, prevSpeedKmh = 136f, prevTs = T0, now = T0 + 1000L)

        assertEquals(
            "零初态首拍 -36 km/h / 1 s 应 = -0.30591485 G（对称性）",
            -FIRST_36KMH_1S_G, gy()!!, 1e-5f
        )
    }

    // ================================================================ ② 限幅

    @Test
    fun `正限幅首拍应为 0_6 G 且原始输入确实超限`() {
        val raw = ((180f / 3.6f) / 1f) / G          // = 5.0986 G，远超 MAX_G
        assertTrue("这条用例的前提：原始输入 $raw G 必须超过 MAX_G=$MAX_G", raw > MAX_G)

        cycle(speedKmh = 180f, prevSpeedKmh = 0f, prevTs = T0, now = T0 + 1000L)

        assertEquals(
            "限幅后输入 = MAX_G = 2 G；首拍 = 0.30 × 2 = 0.6 G",
            0.6f, gy()!!, 1e-5f
        )
    }

    @Test
    fun `负限幅首拍应为 负 0_6 G`() {
        cycle(speedKmh = 0f, prevSpeedKmh = 180f, prevTs = T0, now = T0 + 1000L)

        assertEquals("负向限幅后输入 = -2 G；首拍 = -0.6 G", -0.6f, gy()!!, 1e-5f)
    }

    /**
     * 持续限幅输入的**逐拍递推**验证，正负两向共用同一条生产路径。
     *
     * 每拍 `Δv` 恒为 `sign × 180 km/h`（`dt = 1 s`）⇒ 原始输入 `sign × 5.0986 G` 远超 `MAX_G`，
     * 所以每拍都被限到 `sign × 2 G`。期望值按 `STATUS §T1-R2-3` 的逐拍递推公式算：
     * `f_n = f_{n-1} + (sign × MAX_G − f_{n-1}) × SPEED_ALPHA`，首拍 `0.30 × (±2) = ±0.6 G`，
     * 第 2 拍 `±0.6 + (±2 ∓ 0.6) × 0.3 = ±1.02 G`，60 拍后收敛到 `±2 G`。
     *
     * ⚠️ **必须驱动真实 `onCycle`**：实测值一律取自 `VehicleBus` 的 `calc_gy`，
     * 测试里没有复刻限幅/滤波/换算。
     *
     * @param sign `+1f` = 加速（正限幅），`-1f` = 减速（负限幅）
     */
    private fun assertSustainedClampSteadyState(sign: Float) {
        val deltaKmh = sign * 180f          // 每拍的车速变化（+180 = 加速，-180 = 减速）
        val prevKmh = if (sign > 0f) 0f else 180f
        val nextKmh = if (sign > 0f) 180f else 0f
        val clampedG = sign * MAX_G         // 限幅后的输入 = ±2 G
        val firstG = sign * 0.6f            // 首拍 = 0.30 × ±2
        val secondG = sign * 1.02f          // 第 2 拍 = ±0.6 + (±2 ∓ 0.6) × 0.3
        val tag = if (sign > 0f) "正向（加速）" else "负向（减速）"

        var expected = 0f
        var prevNow = T0
        var measured = 0f
        repeat(60) { i ->
            val now = prevNow + 1000L
            cycle(speedKmh = nextKmh, prevSpeedKmh = prevKmh, prevTs = prevNow, now = now)
            prevNow = now
            expected += (clampedG - expected) * SPEED_ALPHA
            measured = gy()!!
            if (i == 0) assertEquals("$tag 第 1 拍 = ${firstG} G", firstG, measured, 1e-5f)
            if (i == 1) assertEquals("$tag 第 2 拍 = ${secondG} G", secondG, measured, 1e-5f)
            assertEquals("$tag 第 ${i + 1} 拍逐拍递推", expected, measured, 1e-5f)
        }
        assertEquals("$tag 稳态必须收敛到 ${clampedG} G（不是 ${firstG} G）", clampedG, measured, 1e-4f)
        // 纯纵向：横向必须恒为 0；合成值必须非负且 = |gy|
        assertEquals("$tag calc_gx 必须恒为 0（车速路径无横向）", 0f, gx()!!, 0f)
        assertTrue("$tag calc_gforce 必须非负（实测 ${gforce()!!}）", gforce()!! >= 0f)
        assertEquals(
            "$tag calc_gforce 必须 = |calc_gy|",
            kotlin.math.abs(measured), gforce()!!, 1e-6f
        )
    }

    @Test
    fun `持续限幅输入稳态应到 2 G 而不是 0_6 G`() {
        assertSustainedClampSteadyState(sign = 1f)
    }

    /**
     * 负向对称用例（**2026-10-11 T2-R 补**）。
     *
     * 规划方复核指出：上一轮的持续用例**只输入 +180 km/h 并断言 +2 G**，
     * **负向 −2 G 稳态完全未覆盖** —— 而负向要额外走一遍
     * `coerceIn(-MAX_G*G, MAX_G*G)` 的下界、`gforce = sqrt(gx²+gy²)` 的符号路径。
     * 本用例与正向用例共用同一条断言逻辑（[assertSustainedClampSteadyState]），
     * 覆盖：**零初态首拍 −0.6 G**、**多拍逐拍递推**、**稳态 −2 G**、
     * **`gforce` 非负且纯纵向 = `abs(gy)`**。
     */
    @Test
    fun `持续负向限幅输入稳态应到 负 2 G 而不是 负 0_6 G`() {
        assertSustainedClampSteadyState(sign = -1f)
    }

    // ================================================================ ③ 单次跳变后衰减

    @Test
    fun `单次跳变后恒速 应逐拍按 0_7 衰减`() {
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 1000L)
        assertEquals("跳变首拍", FIRST_36KMH_1S_G, gy()!!, 1e-5f)

        var prevNow = T0 + 1000L
        var expected = FIRST_36KMH_1S_G
        for (i in 2..8) {
            val now = prevNow + 1000L
            // 车速恒定 ⇒ Δv = 0 ⇒ 输入回 0
            cycle(speedKmh = 136f, prevSpeedKmh = 136f, prevTs = prevNow, now = now)
            prevNow = now
            expected *= 0.7f
            assertEquals("第 $i 拍应按 0.70 衰减", expected, gy()!!, 1e-5f)
        }
    }

    // ================================================================ ④ 变化 dt 逐拍递推

    @Test
    fun `变化 dt 下应按各拍实际 dt 逐拍递推`() {
        val offsets = longArrayOf(1001L, 1032L, 1063L, 1094L, 1125L)
        val dts = ArrayList<Float>(offsets.size)
        val measured = ArrayList<Float>(offsets.size)

        var prevNow = T0
        for (o in offsets) {
            val now = prevNow + o
            cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = prevNow, now = now)
            assertEquals("该拍 lastTs 必须写回本次传入的 now", now, lastTs())
            dts.add((now - prevNow) / 1000f)      // 该拍代码实际使用的 dt
            prevNow = now
            measured.add(gy()!!)
        }

        // 期望：每拍用**该拍自己的** dt 算该拍的限幅输入，再逐拍递推
        var expected = 0f
        for (i in offsets.indices) {
            expected += (clampedGFor(36f, dts[i]) - expected) * SPEED_ALPHA
            assertEquals(
                "第 ${i + 1} 拍（dt=${dts[i]}）应按该拍 dt 递推",
                expected, measured[i], 1e-5f
            )
        }

        // 反向检查：拿「最后一拍 dt 代表全部历史」会算出不同的结果（说明本用例真的能区分）
        var wrong = 0f
        repeat(offsets.size) { wrong += (clampedGFor(36f, dts.last()) - wrong) * SPEED_ALPHA }
        assertTrue(
            "「最后一拍 dt 代表全部历史」= $wrong 必须与实测 ${measured.last()} 不同，否则用例没有区分力",
            kotlin.math.abs(wrong - measured.last()) > 1e-4f
        )
    }

    // ================================================================ ⑤ gx 既有语义

    @Test
    fun `车速路径的 gx 应随残留 fx 衰减并最终收敛到 0`() {
        field("fx").set(src, 9.80665f)     // 模拟从传感器路径切过来时的残留 fx（m/s²）

        var prevNow = T0
        var expectedFx = 9.80665f
        for (i in 1..5) {
            val now = prevNow + 1000L
            cycle(speedKmh = 100f, prevSpeedKmh = 100f, prevTs = prevNow, now = now)
            prevNow = now
            expectedFx += (0f - expectedFx) * SPEED_ALPHA
            assertEquals("第 $i 拍 fx 应按 SPEED_ALPHA 衰减", expectedFx, floatField("fx")!!, 1e-4f)
            // 车速路径横向无从得知，但**残留的 fx 仍会被 emit 出去**（既有语义，未改动）：
            // calc_gx 必须等于 fx / G，也就是按 0.7 逐拍衰减。
            assertEquals(
                "第 $i 拍 calc_gx 应 = fx / G（残留按 0.7 衰减）",
                expectedFx / G, gx()!!, 1e-5f
            )
        }

        // 继续跑到收敛：gx 必须真的回到 0（0.7^55 ≈ 2.9e-9，远低于 1e-6）
        repeat(50) {
            val now = prevNow + 1000L
            cycle(speedKmh = 100f, prevSpeedKmh = 100f, prevTs = prevNow, now = now)
            prevNow = now
        }
        assertEquals("残留 fx 最终应收敛到 0", 0f, floatField("fx")!!, 1e-6f)
        assertEquals("收敛后 calc_gx = 0", 0f, gx()!!, 1e-6f)
    }

    @Test
    fun `车速路径零初态时 gx 应恒为 0`() {
        // 从零初态开始（fx = 0）：纯纵向，横向必须始终是 0
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 1000L)
        assertEquals("零初态下 calc_gx 必须是 0", 0f, gx()!!, 0f)
        assertEquals("零初态下 calc_gy 应是纯纵向值", FIRST_36KMH_1S_G, gy()!!, 1e-5f)
    }

    // ================================================================ ⑥ gforce 非负 + 纯纵向

    @Test
    fun `gforce 应非负且等于纯纵向路径的 abs gy`() {
        cycle(speedKmh = 100f, prevSpeedKmh = 136f, prevTs = T0, now = T0 + 1000L)   // 负向
        val gy1 = gy()!!
        val gf1 = gforce()!!
        assertTrue("calc_gy 应为负（减速）", gy1 < 0f)
        assertTrue("calc_gforce 必须非负（实测 $gf1）", gf1 >= 0f)
        assertEquals("纯纵向路径 calc_gforce = |calc_gy|", kotlin.math.abs(gy1), gf1, 1e-6f)

        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0 + 1000L, now = T0 + 2000L)   // 正向
        val gy2 = gy()!!
        val gf2 = gforce()!!
        assertTrue("calc_gy 应为正（加速）", gy2 > 0f)
        assertTrue("calc_gforce 必须非负（实测 $gf2）", gf2 >= 0f)
        assertEquals("纯纵向路径 calc_gforce = |calc_gy|", kotlin.math.abs(gy2), gf2, 1e-6f)
    }

    // ================================================================ ⑦ 时钟改动的边界回归

    @Test
    fun `首次采样 无历史车速 应不产生任何派生通道`() {
        putSpeed(136f)
        // 不写 lastSpeed / lastTs：就是生产里第一次跑 onCycle 的状态
        cycleNoArg()

        assertNull("首次采样没有 dt 基准，不应输出 calc_gx", VehicleBus.get("calc_gx"))
        assertNull("首次采样不应输出 calc_gy", VehicleBus.get("calc_gy"))
        assertNull("首次采样不应输出 calc_gforce", VehicleBus.get("calc_gforce"))
        assertEquals("但必须记下这次采样，供下一拍用", 136f, floatField("lastSpeed")!!, 0f)
        assertTrue("lastTs 必须被写回（下一拍才能算 dt）", field("lastTs").getLong(src) > 0L)
    }

    @Test
    fun `dt 超出 0_05 到 5 秒窗口时 应跳过输出但照常写回时间戳`() {
        // (a) dt 过大：20 s
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 20_000L)
        assertNull("dt=20 s 超出窗口，不应输出 calc_gy", VehicleBus.get("calc_gy"))
        assertEquals("超窗也要写回 lastTs", T0 + 20_000L, field("lastTs").getLong(src))
        assertEquals("超窗也要记下车速", 136f, floatField("lastSpeed")!!, 0f)

        // (b) dt 过小：10 ms
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 10L)
        assertNull("dt=0.01 s 低于下限，不应输出 calc_gy", VehicleBus.get("calc_gy"))
        assertEquals("低于下限也要写回 lastTs", T0 + 10L, field("lastTs").getLong(src))

        // (c) 边界内：dt = 0.05 s 恰好是下限，应输出
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 50L)
        val expected = SPEED_ALPHA * clampedGFor(36f, 0.05f)
        assertEquals("dt=0.05 s 恰在下限内，应输出", expected, gy()!!, 1e-5f)

        // (d) 边界内：dt = 5 s 恰好是上限，应输出（换干净实例，避免上一拍滤波残留）
        VehicleBus.clear()
        src = newSource()
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 5_000L)
        val expected5 = SPEED_ALPHA * clampedGFor(36f, 5f)
        assertEquals("dt=5 s 恰在上限内，应输出", expected5, gy()!!, 1e-5f)
    }

    @Test
    fun `无参 onCycle 的生产调用应保持默认时钟行为`() {
        // 生产调用（ObdController.kt:246 的 gForce.onCycle()）必须仍然可用，
        // 并且真的走 System.currentTimeMillis()（不是被写死成 0 或某个常量）。
        //
        // ⚠️ 这里**不硬编码** dt：默认时钟的 dt 受调用开销影响（实测约 1.000 ~ 1.02 s）。
        // 判据改成：代码自己写回的 lastTs 必须落在本测试前后两次取时钟之间 ——
        // 这证明它读的确实是真实系统时钟，而不是注入值。
        putSpeed(136f)
        field("lastSpeed").set(src, 100f)
        val before = System.currentTimeMillis()
        field("lastTs").set(src, before - 1000L)

        cycleNoArg()

        val after = System.currentTimeMillis()
        val writtenTs = lastTs()
        println("[T2-noarg] before=$before after=$after writtenTs=$writtenTs gy=${gy()}")
        assertTrue(
            "onCycle() 默认时钟必须写回真实系统时钟（writtenTs=$writtenTs，应在 [$before, $after] 内）",
            writtenTs in before..after
        )

        val measured = gy()
        assertTrue("无参调用必须仍然输出 calc_gy（实测 $measured）", measured != null)
        val dt = (writtenTs - (before - 1000L)) / 1000f
        val expected = SPEED_ALPHA * clampedGFor(36f, dt)
        assertEquals("默认时钟 dt=$dt，首拍应=$expected", expected, measured!!, 1e-5f)
    }

    @Test
    fun `非车速模式 不应写入任何派生通道`() {
        VehicleBus.clear()
        src = newSource(MODE_OFF)

        putSpeed(136f)
        cycleNoArg()
        cycle(speedKmh = 136f, prevSpeedKmh = 100f, prevTs = T0, now = T0 + 1000L)

        assertNull("MODE_OFF 下不应输出 calc_gy", VehicleBus.get("calc_gy"))
        assertNull("MODE_OFF 下不应输出 calc_gforce", VehicleBus.get("calc_gforce"))
    }
}
