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
 * **T-App-A2-MAF0：油耗派生链的合法 0 值语义**。
 *
 * ## 守的是什么
 *
 * `VehicleBus.Derived.computeAll()` 原来这样选燃油流量来源：
 *
 * ```kotlin
 * val fuelSource = fuelRate?.takeIf { it.value > 0f } ?: maf?.takeIf { it.value > 0.5f }
 * ```
 *
 * 而 `input()` 的语义是 `readings[id]?.takeIf { it.ok && it.value.isFinite() }` ——
 * **0 是合法值**。两个 `takeIf { > 阈值 }` 把**合法 0** 当成"没有值"丢掉。
 *
 * ## 三种真实场景（都不是臆造）
 *
 * | 场景 | 物理含义 | 缺陷后果 |
 * |---|---|---|
 * | `015E = 0` | 滑行/熄火/断油，车真的没在烧油 | 落到 `null` → 显示 `--` |
 * | `015E = 0` 且 `MAF` 有值 | 同上（015E 是权威读数） | **改用 MAF 推算，凭空造出油耗**，累计用油虚增 |
 * | `MAF = 0` | 柴油/电动化滑行 | 落到 `null` → `--` |
 *
 * 第二行最严重：用户看到的是一个"看起来很正常"的油耗数字，
 * 但它来自进气量推算，而车上明明有更权威的 `015E=0`。
 *
 * ## 本类同时守"不回归"
 *
 * 修 0 值语义**不能**把"015E 不可用时用 MAF 推算"这条既有能力弄坏 ——
 * 那是 `calc_lh` 作为"超集通道"存在的基础（车不支持 `01 5E` 时的唯一来源）。
 */
class FuelRateZeroValueTest {

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

    /** 放一条"有效"的读数（ok=true，值可以是 0） */
    private fun put(id: String, v: Float) =
        VehicleBus.put(PidValue(id, v, "T", System.currentTimeMillis(), true))

    /** 放一条"已失效"的读数（ok=false），模拟超时/断线后的陈旧值 */
    private fun putStale(id: String, v: Float) =
        VehicleBus.put(PidValue(id, v, "T", System.currentTimeMillis(), false))

    /** 跑一次派生计算，取指定 id 的输出 */
    private fun derive(id: String): PidValue? {
        out.clear()
        VehicleBus.Derived.computeAll { v -> out.add(v) }
        return out.firstOrNull { it.pidId == id }
    }

    // ================================================================ 缺陷本身

    /**
     * 场景 1：车上 `015E` 明确报告 **0**（滑行断油），MAF 不可用。
     *
     * 期望 `calc_lh` 是**有效的 0**，而不是未知。
     * 修复前：`takeIf { it.value > 0f }` 把 0 丢掉 → 落到 null → 未知。
     */
    @Test
    fun `015E 合法零且无 MAF 时 calc_lh 必须是有效的 0`() {
        put("std_5E", 0f)
        val lh = derive("calc_lh")
        assertNotNull("calc_lh 应该有输出", lh)
        assertTrue(
            "015E=0 是真实读数（车没在烧油），calc_lh 必须是有效值而不是未知",
            lh!!.ok
        )
        assertEquals("有效值必须正好是 0", 0f, lh.value, 1e-6f)
    }

    /**
     * 场景 2：`015E = 0`（权威读数）且 `MAF` 有值。
     *
     * 期望以 **015E 优先**，`calc_lh = 0`。
     * 修复前：丢掉 0 → 回落到 MAF 推算 → 得出一个**根本不存在的油耗**。
     *
     * 这条是本卡最重要的用例：它守的是"累计用油虚增"这个用户察觉不到的错误。
     */
    @Test
    fun `015E 为零时不得改用 MAF 推算造出油耗`() {
        put("std_5E", 0f)
        put("std_10", 3f) // 3 g/s ≈ 8.4 L/h（按项目换算系数）
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertTrue("015E 有效时必须给出有效值", lh!!.ok)
        assertEquals(
            "015E=0 是权威读数，必须优先于 MAF 推算；" +
                "用 MAF 推算会凭空造出一个油耗，导致累计用油虚增",
            0f, lh.value, 1e-6f
        )
    }

    /**
     * 场景 3：只有 `MAF = 0`（无 015E）—— 柴油/电动化滑行。
     *
     * 期望 `calc_lh = 0`（0 g/s 进气 ⇔ 0 燃油）。
     * 修复前：`takeIf { it.value > 0.5f }` 把 0 丢掉 → null → 未知。
     */
    @Test
    fun `MAF 合法零且无 015E 时 calc_lh 必须是有效的 0`() {
        put("std_10", 0f)
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertTrue("MAF=0 是有效读数，推算结果应是有效 0", lh!!.ok)
        assertEquals(0f, lh.value, 1e-6f)
    }

    // ================================================================ 不回归

    /**
     * **既有能力不能坏**：`015E` 完全不可用（没有这条读数）时，
     * 仍要用 MAF 推算 —— 这是车不支持 `01 5E` 时的唯一燃油流量来源。
     */
    @Test
    fun `015E 不可用时仍按 MAF 推算`() {
        put("std_10", 3f)
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertTrue("MAF 有效时应推算出有效值", lh!!.ok)
        assertTrue("MAF=3g/s 推算出的 L/h 应大于 0（实际 ${lh.value}）", lh.value > 0f)
    }

    /**
     * `015E` 存在但已失效（`ok=false`，如超时/断线）时，**不能**把它当成 0。
     *
     * 这与"合法的 0"是两件事：失效表示"不知道"，未知就不该被当作 0 参与计算，
     * 否则会给出一个"车没在烧油"的假结论。此时仍应回落到 MAF。
     */
    @Test
    fun `015E 失效时视为不可用并回落到 MAF`() {
        putStale("std_5E", 0f)
        put("std_10", 3f)
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertTrue("失效的 015E 不该被当成 0，应回落 MAF", lh!!.ok)
        assertTrue("应使用 MAF 推算值（实际 ${lh.value}）", lh.value > 0f)
    }

    /** 两者都不可用时，`calc_lh` 保持未知 —— 不能凭空造 0。 */
    @Test
    fun `015E 与 MAF 都不可用时 calc_lh 保持未知`() {
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertFalse("没有任何来源时必须未知，不能默认成 0", lh!!.ok)
    }

    /** 非有限值（NaN/Infinity）必须当成不可用，不能被当成"有效 0"或参与计算。 */
    @Test
    fun `015E 为非有限值时视为不可用`() {
        put("std_5E", Float.NaN)
        put("std_10", 3f)
        val lh = derive("calc_lh")
        assertNotNull(lh)
        assertTrue("NaN 的 015E 不可用，应回落 MAF", lh!!.ok)
        assertTrue(lh.value > 0f)
    }

    // ================================================================ 下游一致性

    /**
     * 0 值必须能**流到下游**：`calc_l100`（瞬时 L/100km）在低速时应为 0 而不是未知。
     *
     * 这条保证修复不是只改了 `calc_lh` 一处，下游也跟着正确。
     */
    @Test
    fun `015E 为零时下游瞬时油耗是有效的 0`() {
        put("std_5E", 0f)
        put("std_0D", 60f) // 车速 60 km/h（> 3，不触发低速归零分支）
        val l100 = derive("calc_l100")
        assertNotNull(l100)
        assertTrue("calc_lh=0 时瞬时油耗应是有效 0，不是未知", l100!!.ok)
        assertEquals(0f, l100.value, 1e-6f)
    }
}
