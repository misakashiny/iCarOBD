package com.icar.obd.obd

import com.icar.obd.data.BuiltInPids
import com.icar.obd.data.Formula
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 派生通道：**里程积分**与**平均油耗**（`calc_km` / `calc_avg_l100`）。
 *
 * 这两个都是"不用等车、不用厂家 PID"就能做出来的通道（P9 方向 A 的副产品）——
 * 数据全部来自本项目内部：车速、燃油流量、时间。
 *
 * ⚠️ 这里最容易错的不是逻辑而是**单位**：
 * `L/h × 秒 / 3600 = L`，少除一个 3600 会让平均油耗差 3600 倍 ——
 * 而那种错**在真机上只会表现为"数字看着离谱"**，很难归因。
 */
class DerivedChannelsTest {

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
        // 油箱容量是 Store 上的全局状态，别泄漏给别的用例
        Store.settings.tankCapacityL = 50f
    }

    private fun put(id: String, v: Float) =
        VehicleBus.put(PidValue(id, v, "T", System.currentTimeMillis(), true))

    /**
     * 跑 [seconds] 秒、每次 [dt] 秒的积分，返回最后一次的 `calc_avg_l100`（没有则 null）。
     *
     * ⚠️ `integrateDistance` 的 `put` 是**回调参数**，它**不自己写总线** ——
     * 接线由引擎负责（`ObdEngine.loop` 里传的是 `VehicleBus.put`）。
     * 测试里必须同样把值写回总线，否则 `VehicleBus.value(...)` 永远是 null。
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

    // ---------------------------------------------------------------- 里程

    @Test
    fun `里程按车速积分`() {
        // 100 km/h 跑 36 秒 = 1.0 km
        drive(speedKmh = 100f, lh = 0f, seconds = 36f)
        val km = VehicleBus.value("calc_km")
        assertNotNull(km)
        assertEquals(1.0f, km!!, 0.02f)
    }

    @Test
    fun `里程过短时不出平均油耗`() {
        // 100 km/h 只跑 3.6 秒 = 0.1 km —— 不足 0.5 km，不该出值
        val avg = drive(speedKmh = 100f, lh = 8f, seconds = 3.6f)
        assertNull("短里程的除零/噪声必须挡住，宁可显示 --", avg)
    }

    // ---------------------------------------------------------------- 平均油耗

    @Test
    fun `平均油耗等于累计油量除以累计里程`() {
        // 100 km/h × 36 秒 = 1 km；8 L/h × 36 秒 = 0.08 L
        // → 0.08 / 1 × 100 = 8.0 L/100km
        val avg = drive(speedKmh = 100f, lh = 8f, seconds = 36f)
        assertNotNull("里程够了就该出值", avg)
        assertEquals(8.0f, avg!!, 0.2f)
    }

    @Test
    fun `单位换算不能少除 3600`() {
        // 这条是防"少除 3600"的：1 km 上按 8 L/h 跑 36 秒，
        // 若把 L/h 当成 L/s，算出来会是 28800 L/100km 而不是 8
        val avg = drive(speedKmh = 100f, lh = 8f, seconds = 36f)!!
        assertTrue("平均油耗不可能到几百：实测 $avg", avg < 100f)
    }

    @Test
    fun `怠速时平均油耗上升而不是乱跳`() {
        // 先跑 1 km（8 L/100km），再怠速 60 秒（0.8 L/h）
        drive(speedKmh = 100f, lh = 8f, seconds = 36f)
        val before = VehicleBus.value("calc_avg_l100")!!
        drive(speedKmh = 0f, lh = 0.8f, seconds = 60f)
        val after = VehicleBus.value("calc_avg_l100")!!
        // 怠速烧油不走路 → 平均油耗**应当上升**（这是正确行为，不是 bug）
        assertTrue("怠速后平均油耗应上升：$before → $after", after > before)
    }

    @Test
    fun `油量不会因为车速为 0 而停止累计`() {
        drive(speedKmh = 100f, lh = 8f, seconds = 36f)
        val l1 = VehicleBus.Derived.accLiters
        drive(speedKmh = 0f, lh = 6f, seconds = 60f)
        assertTrue("怠速也在烧油", VehicleBus.Derived.accLiters > l1)
    }

    // ---------------------------------------------------------------- 故障灯 MIL（标准 PID 01）

    @Test
    fun `MIL 公式取的是字节 A 的 bit7`() {
        // 实车 0101 的字节 A：bit7 = 故障灯，低 7 位 = 故障码条数
        assertEquals(0.0, Formula.eval("bit(A,7)", byteArrayOf(0x00)), 1e-6)
        assertEquals(1.0, Formula.eval("bit(A,7)", byteArrayOf(0x80.toByte())), 1e-6)
        // 0x83 = 故障灯亮 + 3 条故障码
        assertEquals(1.0, Formula.eval("bit(A,7)", byteArrayOf(0x83.toByte())), 1e-6)
        assertEquals(0.0, Formula.eval("bit(A,7)", byteArrayOf(0x03)), 1e-6)
    }

    @Test
    fun `故障灯是标准 PID 且阈值让它直接走成报警`() {
        val mil = BuiltInPids.all().firstOrNull { it.id == "std_01" }
        assertNotNull("std_01 必须存在（标准 PID，不用扫描器实测）", mil)
        mil!!
        assertEquals("01", mil.mode)
        assertEquals("01", mil.pid)
        assertTrue("必须是启用的，否则灯永远不亮", mil.enabled)
        // 0..1 的布尔量：warnHigh=0.5 → 值 1 走成 critical，指示灯的既有三态图直接可用
        assertEquals(0f, mil.minVal, 1e-6f)
        assertEquals(1f, mil.maxVal, 1e-6f)
        assertEquals(0.5f, mil.warnHigh!!, 1e-6f)
    }

    @Test
    fun `平均油耗是启用的派生通道`() {
        val avg = BuiltInPids.all().firstOrNull { it.id == "calc_avg_l100" }
        assertNotNull("calc_avg_l100 必须存在", avg)
        assertEquals("CALC", avg!!.mode)
        assertTrue(avg.enabled)
    }

    // ---------------------------------------------------------------- 续航里程

    @Test
    fun `续航里程按油量容量与平均油耗算`() {
        Store.settings.tankCapacityL = 60f
        put("std_2F", 50f)          // 半箱
        put("calc_avg_l100", 10f)   // 10 L/100km
        VehicleBus.Derived.computeAll { v -> out.add(v); VehicleBus.put(v) }

        val range = out.firstOrNull { it.pidId == "calc_range" }?.value
        assertNotNull("三个前提都齐了就该出值", range)
        // 60L × 50% = 30L；30 ÷ 10 × 100 = 300 km
        assertEquals(300f, range!!, 1f)
    }

    /**
     * **缺任何一个前提都不许猜。**
     *
     * 续航是用户拿来规划加油的 —— 猜一个会让它"看起来像真的但差很多"，
     * 比仪表显示 `--` 更危险。
     */
    @Test
    fun `缺任何一个前提都不出续航`() {
        Store.settings.tankCapacityL = 60f

        // ① 只有油量，没有平均油耗（还没跑够 0.5km）
        put("std_2F", 50f)
        VehicleBus.Derived.computeAll { out.add(it) }
        assertFalse("没有平均油耗时必须显式未知", out.first { it.pidId == "calc_range" }.ok)

        // ② 有油量也有油耗，但用户没填容量（0 = 关闭续航）
        out.clear()
        put("calc_avg_l100", 10f)
        Store.settings.tankCapacityL = 0f
        VehicleBus.Derived.computeAll { out.add(it) }
        assertFalse("容量为 0 应当关闭续航", out.first { it.pidId == "calc_range" }.ok)

        // ③ 容量有了，但车不支持油量（std_2F 缺失）
        out.clear()
        Store.settings.tankCapacityL = 60f
        VehicleBus.clear()
        put("calc_avg_l100", 10f)
        VehicleBus.Derived.computeAll { out.add(it) }
        assertFalse("没有油量时必须显式未知", out.first { it.pidId == "calc_range" }.ok)
    }

    @Test
    fun `续航里程被夹在上限内`() {
        Store.settings.tankCapacityL = 300f
        put("std_2F", 100f)
        // 0.5 L/100km 是作弊级的低油耗 → 理论 60000 km，必须被夹住
        put("calc_avg_l100", 0.5f)
        VehicleBus.Derived.computeAll { v -> out.add(v); VehicleBus.put(v) }
        val range = out.firstOrNull { it.pidId == "calc_range" }?.value
        assertNotNull(range)
        assertTrue("必须夹到 1200 以内：$range", range!! <= 1200f)
    }

    @Test
    fun `续航里程是启用的派生通道`() {
        val r = BuiltInPids.all().firstOrNull { it.id == "calc_range" }
        assertNotNull("calc_range 必须存在", r)
        assertEquals("CALC", r!!.mode)
        assertTrue(r.enabled)
    }

    // App-A1-D: run the real production callbacks and inspect the live bus.
    private fun compute() = VehicleBus.Derived.computeAll(VehicleBus::put)
    private fun invalidate(id: String) = VehicleBus.put(PidValue(id, Float.NaN, "T", System.currentTimeMillis(), false))
    private fun expire(id: String, v: Float) = VehicleBus.put(PidValue(id, v, "T", System.currentTimeMillis() - 5000, true, ttlMs = 1000))
    private fun unknown(id: String) {
        assertNull("$id cannot keep a previous valid readout", VehicleBus.value(id))
        assertFalse("$id must explicitly become invalid", VehicleBus.get(id)!!.ok)
    }
    private fun rangeInputs() { put("std_2F", 50f); put("calc_avg_l100", 10f); Store.settings.tankCapacityL = 50f }

    @Test fun `boost clears failed MAP and BARO and recovers`() {
        put("std_0B", 160f); put("std_33", 100f); compute()
        assertEquals(60f, VehicleBus.value("calc_boost")!!, 0f)
        invalidate("std_0B"); compute(); unknown("calc_boost")
        put("std_0B", 140f); compute()
        assertEquals(40f, VehicleBus.value("calc_boost")!!, 0f)
        invalidate("std_33"); compute(); unknown("calc_boost")
    }

    @Test fun `boost clears a TTL expired dependency`() {
        put("std_0B", 160f); put("std_33", 100f); compute()
        expire("std_33", 100f); compute(); unknown("calc_boost")
    }

    @Test fun `boost expiry is no later than earliest timed input`() {
        val now = System.currentTimeMillis()
        val map = PidValue("std_0B", 160f, "T", now - 1000, true, ttlMs = 60000)
        val baro = PidValue("std_33", 100f, "T", now - 2000, true, ttlMs = 50000)
        VehicleBus.put(map); VehicleBus.put(baro); compute()
        val boost = VehicleBus.get("calc_boost")!!
        assertTrue(boost.ok)
        assertTrue("derived output must carry upstream expiry", boost.ttlMs > 0)
        assertTrue(boost.ts + boost.ttlMs <= baro.ts + baro.ttlMs)
    }

    @Test fun `missing fuel clears fuel flow and instantaneous consumption`() {
        put("std_5E", 8f); put("std_0D", 80f); compute()
        assertEquals(10f, VehicleBus.value("calc_l100")!!, 0f)
        invalidate("std_5E"); compute()
        unknown("calc_lh"); unknown("calc_l100")
        put("std_5E", 4f); compute()
        assertEquals(5f, VehicleBus.value("calc_l100")!!, 0f)
    }

    @Test fun `speed loss clears instantaneous value without clearing valid fuel flow`() {
        put("std_5E", 8f); put("std_0D", 80f); compute()
        expire("std_0D", 80f); compute(); unknown("calc_l100")
        assertEquals(8f, VehicleBus.value("calc_lh")!!, 0f)
    }

    @Test fun `fuel flow and instantaneous output inherit selected input TTL`() {
        val source = PidValue("std_5E", 8f, "T", System.currentTimeMillis() - 1000, true, ttlMs = 60000)
        VehicleBus.put(source); put("std_0D", 80f); compute()
        for (id in listOf("calc_lh", "calc_l100")) {
            val v = VehicleBus.get(id)!!
            assertTrue(v.ttlMs > 0)
            assertTrue(v.ts + v.ttlMs <= source.ts + source.ttlMs)
        }
    }

    @Test fun `range capacity zero or negative invalidates old result and positive restores`() {
        rangeInputs(); compute()
        assertEquals(250f, VehicleBus.value("calc_range")!!, 0f)
        for (capacity in listOf(0f, -1f)) {
            Store.settings.tankCapacityL = capacity; compute(); unknown("calc_range")
        }
        Store.settings.tankCapacityL = 50f; compute()
        assertEquals(250f, VehicleBus.value("calc_range")!!, 0f)
    }

    @Test fun `range clears invalid average and expired fuel percentage`() {
        rangeInputs(); compute()
        invalidate("calc_avg_l100"); compute(); unknown("calc_range")
        put("calc_avg_l100", 10f); compute()
        expire("std_2F", 50f); compute(); unknown("calc_range")
    }

    @Test fun `range cannot outlive its fuel level dependency`() {
        rangeInputs()
        val level = PidValue("std_2F", 50f, "T", System.currentTimeMillis() - 1000, true, ttlMs = 60000)
        VehicleBus.put(level); compute()
        val range = VehicleBus.get("calc_range")!!
        assertTrue(range.ttlMs > 0)
        assertTrue(range.ts + range.ttlMs <= level.ts + level.ttlMs)
    }

    @Test fun `reset immediately publishes zero distance and clears average and range only`() {
        drive(100f, 8f, 36f)
        put("std_2F", 50f); put("calc_gx", 0.2f); compute()
        val speedHistory = VehicleBus.historyOf("std_0D")
        VehicleBus.Derived.resetTrip()
        assertEquals(0f, VehicleBus.value("calc_km")!!, 0f)
        assertEquals(0f, VehicleBus.Derived.accKm, 0f)
        assertEquals(0f, VehicleBus.Derived.accLiters, 0f)
        unknown("calc_avg_l100"); unknown("calc_range")
        assertEquals(100f, VehicleBus.value("std_0D")!!, 0f)
        assertEquals(50f, VehicleBus.value("std_2F")!!, 0f)
        assertEquals(0.2f, VehicleBus.value("calc_gx")!!, 0f)
        assertEquals(speedHistory, VehicleBus.historyOf("std_0D"))
    }

    @Test fun `short trip after reset does not resurrect last average`() {
        drive(100f, 8f, 36f)
        VehicleBus.Derived.resetTrip()
        drive(100f, 4f, 3f)
        unknown("calc_avg_l100")
        drive(100f, 4f, 36f)
        assertEquals(4f, VehicleBus.value("calc_avg_l100")!!, 0.01f)
    }

    @Test fun `repeated resets are idempotent and preserve unrelated values`() {
        drive(100f, 8f, 36f); put("unrelated", 123f)
        repeat(3) { VehicleBus.Derived.resetTrip() }
        assertEquals(0f, VehicleBus.value("calc_km")!!, 0f)
        assertEquals(123f, VehicleBus.value("unrelated")!!, 0f)
        unknown("calc_avg_l100"); unknown("calc_range")
    }

    @Test fun `missing speed preserves known totals but invalidates average and range`() {
        drive(100f, 8f, 36f); put("std_2F", 50f); compute()
        val km = VehicleBus.Derived.accKm; val liters = VehicleBus.Derived.accLiters
        invalidate("std_0D")
        VehicleBus.Derived.integrateDistance(1f, VehicleBus::put)
        assertEquals(km, VehicleBus.Derived.accKm, 0f)
        assertEquals(liters, VehicleBus.Derived.accLiters, 0f)
        assertEquals(km, VehicleBus.value("calc_km")!!, 0f)
        unknown("calc_avg_l100"); unknown("calc_range")
    }

    @Test fun `fuel gap cannot produce a false complete average after recovery`() {
        drive(100f, 8f, 36f)
        val liters = VehicleBus.Derived.accLiters
        expire("calc_lh", 8f)
        VehicleBus.Derived.integrateDistance(1f, VehicleBus::put)
        assertEquals(liters, VehicleBus.Derived.accLiters, 0f)
        unknown("calc_avg_l100")
        drive(100f, 8f, 36f); unknown("calc_avg_l100")
        VehicleBus.Derived.resetTrip()
        drive(100f, 8f, 36f)
        assertEquals(8f, VehicleBus.value("calc_avg_l100")!!, 0.01f)
    }

    @Test fun `invalid time intervals cannot alter totals or publish a valid average`() {
        for (dt in listOf(-1f, 0f, Float.NaN, Float.POSITIVE_INFINITY)) {
            VehicleBus.Derived.resetTrip(); drive(100f, 8f, 36f)
            val km = VehicleBus.Derived.accKm; val liters = VehicleBus.Derived.accLiters
            VehicleBus.Derived.integrateDistance(dt, VehicleBus::put)
            assertEquals(km, VehicleBus.Derived.accKm, 0f)
            assertEquals(liters, VehicleBus.Derived.accLiters, 0f)
            unknown("calc_avg_l100")
        }
    }

    @Test fun `non finite dependencies cannot create valid derived readings`() {
        put("std_0B", Float.POSITIVE_INFINITY); put("std_33", 100f)
        put("std_5E", Float.POSITIVE_INFINITY); put("std_0D", 80f)
        rangeInputs(); Store.settings.tankCapacityL = Float.POSITIVE_INFINITY
        compute()
        for (id in listOf("calc_boost", "calc_lh", "calc_l100", "calc_range")) unknown(id)
    }

    @Test fun `integrated average carries finite input expiry but cumulative distance does not`() {
        val now = System.currentTimeMillis()
        val fuel = PidValue("calc_lh", 8f, "T", now - 1000, true, ttlMs = 60000)
        VehicleBus.put(fuel); put("std_0D", 100f)
        repeat(36) { VehicleBus.Derived.integrateDistance(1f, VehicleBus::put) }
        val avg = VehicleBus.get("calc_avg_l100")!!
        assertTrue(avg.ok); assertTrue(avg.ttlMs > 0)
        assertTrue(avg.ts + avg.ttlMs <= fuel.ts + fuel.ttlMs)
        assertEquals(0, VehicleBus.get("calc_km")!!.ttlMs)
    }

    @Test fun `known zero fuel remains a valid integration input`() {
        drive(100f, 0f, 36f)
        assertEquals(0f, VehicleBus.Derived.accLiters, 0f)
        assertEquals(0f, VehicleBus.value("calc_avg_l100")!!, 0f)
    }
}
