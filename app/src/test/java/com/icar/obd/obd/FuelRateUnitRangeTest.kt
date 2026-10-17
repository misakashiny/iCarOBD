package com.icar.obd.obd

import com.icar.obd.data.PidValue
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * **T-App-A2-MAF0（第二项）：油耗派生链的单位与取值范围**。
 *
 * 这一组守的是问题清单 `App-A2` 里"单位/物理量正确性"那半句。
 * 与 `FuelRateZeroValueTest`（守 0 值语义）分开：那个守"0 是不是有效"，
 * 这个守"有值的那些数对不对、会不会被错误地丢掉"。
 *
 * ## 本类钉住的三件事
 *
 * 1. **换算系数** g/s → L/h。项目取 `3.6 / GAS_DENSITY(0.745)`，
 *    物理上等于 `3600 / 745`，即「MAF[g/s] ÷ 745[g/L] × 3600[s/h]」。
 *    这里用**独立的推导**（不读被测常数）交叉验证，防止有人改密度却忘了改 3.6。
 *
 * 2. **积分时不得丢弃合法的高油耗**。`integrateDistance` 原来写
 *    `takeIf { it.value in 0f..100f }` —— 但 PID 5E 的标准满量程是
 *    **3276.75 L/h**，大排量车全油门时 `calc_lh` 轻易超过 100（MAF 200 g/s ≈ 966 L/h）。
 *    一旦被丢，`tripComplete` 被永久置 false，**整个行程的平均油耗再也出不来**
 *    （只能靠 `resetTrip()` 恢复）。
 *
 * 3. **量纲链**：L/h → L（积分）、L/h 与 km/h → L/100km。少除 3600 会差 3600 倍。
 */
class FuelRateUnitRangeTest {

    private val out = ArrayList<PidValue>()

    @Before
    fun setUp() {
        VehicleBus.clear()
        VehicleBus.Derived.resetTrip()
        out.clear()
    }

    @After
    fun tearDown() {
        VehicleBus.Derived.resetTrip()
        VehicleBus.clear()
    }

    private fun put(id: String, v: Float) =
        VehicleBus.put(PidValue(id, v, "T", System.currentTimeMillis(), true))

    private fun derive(id: String): PidValue? {
        out.clear()
        VehicleBus.Derived.computeAll { v -> out.add(v) }
        return out.firstOrNull { it.pidId == id }
    }

    /**
     * 跑若干次积分，返回最后一次有效的 `calc_avg_l100`（拿不到就 null）。
     *
     * 与 `DerivedChannelsTest.drive` 同一套做法：`integrateDistance` 的 `put`
     * 是**回调参数**，接线由引擎负责，测试里必须把值写回总线。
     */
    private fun drive(speedKmh: Float, lh: Float, seconds: Float, dt: Float = 1f): Float? {
        put("std_0D", speedKmh)
        put("calc_lh", lh)
        var avg: Float? = null
        var elapsed = 0f
        while (elapsed < seconds) {
            out.clear()
            VehicleBus.Derived.integrateDistance(dt) { v -> out.add(v); VehicleBus.put(v) }
            out.firstOrNull { it.pidId == "calc_avg_l100" && it.ok }?.let { avg = it.value }
            elapsed += dt
        }
        return avg
    }

    // ================================================================ 1. 换算系数

    /**
     * **用独立推导验证 g/s → L/h 系数**。
     *
     * 不读被测常量，而是按物理定义算：
     * `L/h = MAF[g/s] ÷ 745[g/L] × 3600[s/h]`。
     *
     * 反推被测实现：给出 `MAF = 745 g/s` 时，1 秒内恰好流过 1 升，
     * 即 **3600 L/h**。这是一个不依赖任何常数取值的物理恒等式。
     */
    @Test
    fun `MAF 745g-s 应换算出 3600 L-h`() {
        put("std_10", 745f) // 745 g/s ÷ 745 g/L = 1 L/s = 3600 L/h
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertTrue("应给出有效值", lh!!.ok)
        assertEquals(
            "MAF=745g/s ⇔ 1L/s ⇔ 3600L/h。偏差说明 GAS_DENSITY 或 3.6 被改过而另一处没跟着改",
            3600f, lh.value, /* 浮点容差 */ 0.5f
        )
    }

    /** 同上，用另一半量程再验一次，避免"凑巧在某个点相等"。 */
    @Test
    fun `MAF 745g-s 的一半应换算出 1800 L-h`() {
        put("std_10", 372.5f)
        val lh = derive("calc_lh")!!
        assertTrue(lh.ok)
        assertEquals(1800f, lh.value, 0.5f)
    }

    /** 015E 是**直接读数**，不经过任何换算 —— 单位已经是 L/h，必须原样透传。 */
    @Test
    fun `015E 读数原样透传不做换算`() {
        put("std_5E", 8.5f)
        val lh = derive("calc_lh")!!
        assertTrue(lh.ok)
        assertEquals("015E 本身就是 L/h，不能再乘换算系数", 8.5f, lh.value, 1e-6f)
    }

    // ================================================================ 2. 高油耗不被丢弃

    /**
     * **合法的高油耗不能被积分丢弃**。
     *
     * 150 L/h 完全正当：MAF 约 31 g/s（中等排量偏高负载），
     * 远小于 PID 5E 标准满量程 3276.75 L/h。
     *
     * 修复前：`takeIf { it.value in 0f..100f }` 把它当非法丢掉
     * → `tripComplete = false` → 平均油耗永久失效。
     *
     * ⚠️ 注意断言 **99 而不是 125**：`calc_avg_l100` 的输出有
     * `coerceIn(0f, 99f)` 上界 —— 那是**刻意的仪表显示上限**（99 = 两位数码管满格），
     * 与本卡修的"输入侧丢弃"是两件事。这里只验证**积分真的发生了**：
     * 若积分被丢弃，结果是 `null`（行程失效）而不是 99。
     */
    @Test
    fun `150 L-h 的高油耗必须参与积分而不是让行程失效`() {
        val avg = drive(speedKmh = 120f, lh = 150f, seconds = 60f)
        assertNotNull(
            "150 L/h 是合法油耗（远低于 PID 5E 满量程 3276.75），" +
                "不该被范围判据丢掉并导致整个行程平均油耗失效",
            avg
        )
        // 150/120*100 = 125，被输出上界 99 截断 —— 截断属显示层，不影响"积分已发生"这一事实
        assertEquals("积分确实发生了（有值），且被显示上界夹到 99", 99f, avg!!, 0.5f)
    }

    /** 3276.75 L/h 是 PID 5E 的理论满量程，到这一档（114 g/s 级别不可能）也应能参与。 */
    @Test
    fun `接近 PID 5E 满量程的油耗仍应被接受`() {
        val avg = drive(speedKmh = 100f, lh = 3276f, seconds = 30f)
        assertNotNull("接近满量程的合法读数不该被丢弃", avg)
    }

    /** 极端但**非物理**的值（如 MAF 算出 5000 L/h）应视为坏数据，不得污染累计。 */
    @Test
    fun `超出物理范围的油耗视为坏数据并让行程失效`() {
        val avg = drive(speedKmh = 100f, lh = 5000f, seconds = 30f)
        // 5000 L/h 远超 PID 5E 满量程 3276.75，属于解析异常，宁可失效也不要污染平均油耗
        assertEquals("超范围值不该产出平均油耗", null, avg)
    }

    // ================================================================ 3. 量纲链

    /**
     * **L/h 积分成 L 必须除 3600**（秒 → 小时）。
     *
     * 8 L/h 跑 3600 秒（=1 小时）应消耗 8 L；配 100 km 里程 → 8 L/100km。
     * 少除 3600 会得到 28800 L，平均油耗爆表 —— 这类错在真车上只表现为"数字看着离谱"。
     */
    @Test
    fun `一小时 8L-h 跑 100km 的平均油耗是 8L-100km`() {
        put("std_0D", 100f)      // 100 km/h
        put("calc_lh", 8f)       // 8 L/h
        put("calc_km", 0f)
        var elapsed = 0f
        while (elapsed < 3600f) { // 跑满 1 小时
            out.clear()
            VehicleBus.Derived.integrateDistance(1f) { v -> out.add(v); VehicleBus.put(v) }
            elapsed += 1f
        }
        // 100 km/h × 1 h = 100 km；8 L/h × 1 h = 8 L → 8 L/100km
        val km = VehicleBus.value("calc_km")
        assertNotNull(km)
        assertEquals("里程积分", 100f, km!!, 0.5f)
        val avg = VehicleBus.value("calc_avg_l100")
        assertNotNull("平均油耗应出值", avg)
        assertEquals("8 L/h ÷ 100 km/h × 100 = 8 L/100km", 8f, avg!!, 0.20f)
    }

    /**
     * **瞬时油耗量纲**：`calc_lh[L/h] ÷ speed[km/h] × 100` 得到 L/100km。
     *
     * 8 L/h @ 80 km/h → 10 L/100km。若漏乘 100 会得到 0.1（量级差 100 倍）。
     */
    @Test
    fun `瞬时油耗量纲 L-h 除 km-h 乘 100`() {
        put("std_5E", 8f)
        put("std_0D", 80f)
        val l100 = derive("calc_l100")!!
        assertTrue(l100.ok)
        assertEquals("8 L/h ÷ 80 km/h × 100 = 10 L/100km", 10f, l100.value, 1e-3f)
    }

    /** 怠速/低速时瞬时油耗无意义，应归零而不是给出巨大数值。 */
    @Test
    fun `车速低于 3km-h 时瞬时油耗归零`() {
        put("std_5E", 3f)
        put("std_0D", 1f) // 1 km/h < 3
        val l100 = derive("calc_l100")!!
        assertTrue(l100.ok)
        assertEquals("低速时按定义归零，不能拿 3/1*100=300 这种噪声当真", 0f, l100.value, 1e-6f)
    }
}
