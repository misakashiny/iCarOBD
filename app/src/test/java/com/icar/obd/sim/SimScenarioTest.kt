package com.icar.obd.sim

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 模拟数据源单元测试（P5A-M01 阶段 G）。
 *
 * ## 测什么
 *
 * 1. **确定性** —— 同一 tick 必须产出同一组值（自动化测试才敢断言具体数字）
 * 2. **场景语义** —— 加速该升、减速该降、报警该越阈值、暖机该升温
 * 3. **边界** —— 不出负值、不越量程
 * 4. **断开 / 空值 / 缺失** 三种「无数据」语义互不相同
 *
 * ## 为什么能纯 JVM 跑
 *
 * `SimScenario.values()` 是纯函数（不碰 Android API、不碰 VehicleBus），
 * 所以不需要 Robolectric。
 */
class SimScenarioTest {

    private fun vals(s: SimScenario, tick: Int, extra: List<String> = emptyList()) =
        SimScenario.values(s, tick, extra)

    // ============================================================ 确定性

    @Test
    fun `同一 tick 一定产出同一组值`() {
        SimScenario.values().forEach { s ->
            val a = vals(s, 37)
            val b = vals(s, 37)
            assertEquals("场景 ${s.id} 在 tick=37 两次调用结果不一致", a, b)
        }
    }

    @Test
    fun `不同 tick 的值会变化（NUMR 场景至少一个 PID 有差异）`() {
        val a = vals(SimScenario.MULTI, 0)
        val b = vals(SimScenario.MULTI, 9)
        assertNotEqualsAny(a, b, "MULTI 场景 tick 0 与 9 完全一样，说明值没在变")
    }

    private fun assertNotEqualsAny(
        a: Map<String, Float?>,
        b: Map<String, Float?>,
        msg: String
    ) {
        val same = a.all { (k, v) -> b[k] == v }
        assertFalse(msg, same)
    }

    // ============================================================ 正常场景

    @Test
    fun `正常运行场景覆盖六个核心 PID`() {
        val v = vals(SimScenario.NORMAL, 0)
        listOf(
            SimScenario.PID_SPEED, SimScenario.PID_RPM, SimScenario.PID_COOLANT,
            SimScenario.PID_VOLTAGE, SimScenario.PID_LOAD, SimScenario.PID_THROTTLE
        ).forEach { assertNotNull("NORMAL 缺少 $it", v[it]) }
    }

    @Test
    fun `正常运行值落在内置 PID 的合理区间`() {
        val v = vals(SimScenario.NORMAL, 10)
        assertInRange(v, SimScenario.PID_SPEED, 0f, 260f)
        assertInRange(v, SimScenario.PID_RPM, 0f, 8000f)
        assertInRange(v, SimScenario.PID_COOLANT, -40f, 215f)
        assertInRange(v, SimScenario.PID_VOLTAGE, 0f, 20f)
        assertInRange(v, SimScenario.PID_LOAD, 0f, 100f)
        assertInRange(v, SimScenario.PID_THROTTLE, 0f, 100f)
    }

    // ============================================================ 加速 / 减速

    @Test
    fun `加速场景车速与转速单调上升`() {
        val v0 = vals(SimScenario.ACCEL, 0)
        val v30 = vals(SimScenario.ACCEL, 30)
        val v60 = vals(SimScenario.ACCEL, 60)
        // 用容差避开正弦抖动（±1.5 / ±120）
        assertTrue(
            "车速未上升：${v0[SimScenario.PID_SPEED]} → ${v60[SimScenario.PID_SPEED]}",
            v60[SimScenario.PID_SPEED]!! > v0[SimScenario.PID_SPEED]!!
        )
        assertTrue(
            "转速未上升：${v0[SimScenario.PID_RPM]} → ${v60[SimScenario.PID_RPM]}",
            v60[SimScenario.PID_RPM]!! > v30[SimScenario.PID_RPM]!!
        )
        // 负荷也要跟着涨
        assertTrue(v60[SimScenario.PID_LOAD]!! > v0[SimScenario.PID_LOAD]!!)
    }

    @Test
    fun `减速场景车速与转速单调下降`() {
        val v0 = vals(SimScenario.DECEL, 0)
        val v60 = vals(SimScenario.DECEL, 60)
        assertTrue(
            "车速未下降：${v0[SimScenario.PID_SPEED]} → ${v60[SimScenario.PID_SPEED]}",
            v60[SimScenario.PID_SPEED]!! < v0[SimScenario.PID_SPEED]!!
        )
        assertTrue(
            "转速未下降：${v0[SimScenario.PID_RPM]} → ${v60[SimScenario.PID_RPM]}",
            v60[SimScenario.PID_RPM]!! < v0[SimScenario.PID_RPM]!!
        )
    }

    @Test
    fun `加速场景不产出负值`() {
        (0..120 step 7).forEach { t ->
            val v = vals(SimScenario.ACCEL, t)
            assertTrue("tick=$t 车速为负", v[SimScenario.PID_SPEED]!! >= 0f)
            assertTrue("tick=$t 转速为负", v[SimScenario.PID_RPM]!! >= 0f)
        }
    }

    // ============================================================ 暖机

    @Test
    fun `暖机场景水温从低到高并跨过低阈值`() {
        val cold = vals(SimScenario.WARMUP, 0)[SimScenario.PID_COOLANT]!!
        val hot = vals(SimScenario.WARMUP, 120)[SimScenario.PID_COOLANT]!!
        assertTrue("初始水温应低于 warnLow(60)，实际 $cold", cold < 60f)
        assertTrue("结束水温应高于 warnLow(60)，实际 $hot", hot > 60f)
        assertTrue("水温未上升：$cold → $hot", hot > cold)
    }

    // ============================================================ 报警场景

    @Test
    fun `报警场景所有值越过内置阈值`() {
        val v = vals(SimScenario.ALARM, 20)
        // warnHigh = 120
        assertTrue("车速应 > 120", v[SimScenario.PID_SPEED]!! > 120f)
        // warnHigh = 6500
        assertTrue("转速应 > 6500", v[SimScenario.PID_RPM]!! > 6500f)
        // warnHigh = 105
        assertTrue("水温应 > 105", v[SimScenario.PID_COOLANT]!! > 105f)
        // warnLow = 11.8
        assertTrue("电压应 < 11.8", v[SimScenario.PID_VOLTAGE]!! < 11.8f)
    }

    @Test
    fun `报警场景仍在量程内（不越界）`() {
        val v = vals(SimScenario.ALARM, 20)
        assertInRange(v, SimScenario.PID_SPEED, 0f, 260f)
        assertInRange(v, SimScenario.PID_RPM, 0f, 8000f)
        assertInRange(v, SimScenario.PID_COOLANT, -40f, 215f)
        assertInRange(v, SimScenario.PID_VOLTAGE, 0f, 20f)
    }

    // ---- P5A-M02：ALARM(warn) 与 CRITICAL 必须落在正确档位 ----
    //
    // 阈值来自 `NodeStateResolver.select`（**既有语义，不得自行编造**）：
    //   warnAt     = stateWarn ?: pid.warnHigh
    //   criticalAt = stateCritical ?: warnAt + (pid.maxVal - warnAt) * 0.5
    //
    //   车速：warn 120 → critical 120 + (260-120)*0.5 = 190
    //   转速：warn 6500 → critical 6500 + (8000-6500)*0.5 = 7250
    //   水温：warn 105 → critical 105 + (215-105)*0.5 = 160

    @Test
    fun `ALARM 落在 warn 档 不越过 critical`() {
        val v = vals(SimScenario.ALARM, 20)
        // 车速：应 >=120 且 <190
        assertTrue("车速 ${v[SimScenario.PID_SPEED]} 应 >= 120", v[SimScenario.PID_SPEED]!! >= 120f)
        assertTrue("车速 ${v[SimScenario.PID_SPEED]} 应 < 190（否则会变 critical）",
            v[SimScenario.PID_SPEED]!! < 190f)
        // 转速：应 >=6500 且 <7250
        assertTrue("转速 ${v[SimScenario.PID_RPM]} 应 >= 6500", v[SimScenario.PID_RPM]!! >= 6500f)
        assertTrue("转速 ${v[SimScenario.PID_RPM]} 应 < 7250", v[SimScenario.PID_RPM]!! < 7250f)
        // 水温：应 >=105 且 <160
        assertTrue("水温 ${v[SimScenario.PID_COOLANT]} 应 >= 105", v[SimScenario.PID_COOLANT]!! >= 105f)
        assertTrue("水温 ${v[SimScenario.PID_COOLANT]} 应 < 160", v[SimScenario.PID_COOLANT]!! < 160f)
    }

    @Test
    fun `CRITICAL 越过 critical 档`() {
        val v = vals(SimScenario.CRITICAL, 20)
        assertTrue("车速应 >= 190（critical）", v[SimScenario.PID_SPEED]!! >= 190f)
        assertTrue("转速应 >= 7250（critical）", v[SimScenario.PID_RPM]!! >= 7250f)
        assertTrue("水温应 >= 160（critical）", v[SimScenario.PID_COOLANT]!! >= 160f)
    }

    @Test
    fun `CRITICAL 仍在量程内`() {
        val v = vals(SimScenario.CRITICAL, 20)
        assertInRange(v, SimScenario.PID_SPEED, 0f, 260f)
        assertInRange(v, SimScenario.PID_RPM, 0f, 8000f)
        assertInRange(v, SimScenario.PID_COOLANT, -40f, 215f)
        assertInRange(v, SimScenario.PID_VOLTAGE, 0f, 20f)
    }

    @Test
    fun `CRITICAL 的数值严格高于 ALARM`() {
        val a = vals(SimScenario.ALARM, 20)
        val c = vals(SimScenario.CRITICAL, 20)
        assertTrue("车速", c[SimScenario.PID_SPEED]!! > a[SimScenario.PID_SPEED]!!)
        assertTrue("转速", c[SimScenario.PID_RPM]!! > a[SimScenario.PID_RPM]!!)
        assertTrue("水温", c[SimScenario.PID_COOLANT]!! > a[SimScenario.PID_COOLANT]!!)
    }

    // ============================================================ 三种「无数据」语义

    @Test
    fun `断开场景不产出任何值`() {
        assertTrue(vals(SimScenario.DISCONNECT, 0).isEmpty())
    }

    @Test
    fun `空值场景特定 PID 为 null 其余有值`() {
        val v = vals(SimScenario.NULL_PID, 5)
        assertTrue("转速应为 null", v.containsKey(SimScenario.PID_RPM))
        assertNull("转速应为 null", v[SimScenario.PID_RPM])
        assertNull("水温应为 null", v[SimScenario.PID_COOLANT])
        assertNotNull("车速应有值", v[SimScenario.PID_SPEED])
        assertNotNull("电压应有值", v[SimScenario.PID_VOLTAGE])
    }

    @Test
    fun `缺失场景只写两个 PID`() {
        val v = vals(SimScenario.MISSING_PID, 5)
        assertEquals("MISSING_PID 应只写 2 个 PID", 2, v.size)
        assertNotNull(v[SimScenario.PID_SPEED])
        assertNotNull(v[SimScenario.PID_VOLTAGE])
    }

    @Test
    fun `三种无数据语义互不相同`() {
        val disc = vals(SimScenario.DISCONNECT, 0)
        val nulls = vals(SimScenario.NULL_PID, 0)
        val miss = vals(SimScenario.MISSING_PID, 0)
        assertTrue("断开应完全空", disc.isEmpty())
        assertTrue("空值场景应有键但值为 null", nulls.values.any { it == null })
        assertTrue("缺失场景不应有 null 值", miss.values.none { it == null })
    }

    // ============================================================ 多 PID

    @Test
    fun `多 PID 场景同时更新至少五个通道`() {
        val v = vals(SimScenario.MULTI, 12)
        assertTrue("MULTI 应至少 5 个 PID，实际 ${v.size}", v.size >= 5)
        assertTrue("所有值都应有内容", v.values.all { it != null })
    }

    @Test
    fun `多 PID 场景各通道用不同周期变化`() {
        val a = vals(SimScenario.MULTI, 0)
        val b = vals(SimScenario.MULTI, 6)
        val changed = a.count { (k, v) -> b[k] != v }
        assertTrue("tick 0→6 应有多个通道变化，实际 $changed", changed >= 3)
    }

    // ============================================================ 自定义 PID

    @Test
    fun `自定义 PID 会被写入且可预测`() {
        val custom = listOf("my_pid_a", "my_pid_b")
        val v = vals(SimScenario.NORMAL, 10, custom)
        assertEquals("自定义 PID a 应为 (10*3)%100=30", 30f, v["my_pid_a"])
        assertEquals("自定义 PID b 应为 (10*4)%100=40", 40f, v["my_pid_b"])
    }

    @Test
    fun `自定义 PID 不覆盖内置 PID`() {
        val v = vals(SimScenario.NORMAL, 0, listOf(SimScenario.PID_SPEED))
        // 内置车速 ≈ 60（带抖动），不应被自定义锯齿值覆盖
        val speed = v[SimScenario.PID_SPEED]!!
        assertTrue("内置车速被自定义逻辑覆盖了，实际 $speed", speed > 50f)
    }

    // ============================================================ 恢复

    @Test
    fun `恢复场景立刻给出正常值`() {
        val v = vals(SimScenario.RECOVER, 0)
        assertNotNull("恢复后车速应有值", v[SimScenario.PID_SPEED])
        assertNotNull("恢复后转速应有值", v[SimScenario.PID_RPM])
        assertTrue("恢复后车速应在正常区间", v[SimScenario.PID_SPEED]!! in 40f..80f)
    }

    // ============================================================ 辅助

    private fun assertInRange(v: Map<String, Float?>, pid: String, lo: Float, hi: Float) {
        val x = v[pid] ?: throw AssertionError("$pid 无值")
        assertTrue("$pid=$x 超出 [$lo, $hi]", x >= lo && x <= hi)
    }
}
