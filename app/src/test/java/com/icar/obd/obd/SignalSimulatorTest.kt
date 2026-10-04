package com.icar.obd.obd

import com.icar.obd.data.PidDefinition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

/**
 * 模拟信号发生器的单元测试（第二轮迭代）。
 *
 * 波形求值 / 相位 / 取值都是纯函数，所以这里能把「波形对不对」完全钉死 ——
 * 不需要跑 UI，也不需要车。
 */
class SignalSimulatorTest {

    private val sim = SignalSimulator

    // ================================================================ 波形

    @Test
    fun `正弦在 0 与 1 2 处取中点 1 4 处到顶`() {
        assertEquals(0.5f, sim.waveAt(sim.WAVE_SINE, 0f), 1e-4f)
        assertEquals(1.0f, sim.waveAt(sim.WAVE_SINE, 0.25f), 1e-4f)
        assertEquals(0.5f, sim.waveAt(sim.WAVE_SINE, 0.5f), 1e-4f)
        assertEquals(0.0f, sim.waveAt(sim.WAVE_SINE, 0.75f), 1e-4f)
    }

    @Test
    fun `锯齿线性上升`() {
        assertEquals(0f, sim.waveAt(sim.WAVE_SAW, 0f), 1e-4f)
        assertEquals(0.5f, sim.waveAt(sim.WAVE_SAW, 0.5f), 1e-4f)
        assertEquals(0.9f, sim.waveAt(sim.WAVE_SAW, 0.9f), 1e-4f)
    }

    @Test
    fun `三角在中点到达峰值`() {
        assertEquals(0f, sim.waveAt(sim.WAVE_TRIANGLE, 0f), 1e-4f)
        assertEquals(0.5f, sim.waveAt(sim.WAVE_TRIANGLE, 0.25f), 1e-4f)
        assertEquals(1f, sim.waveAt(sim.WAVE_TRIANGLE, 0.5f), 1e-4f)
        assertEquals(0.5f, sim.waveAt(sim.WAVE_TRIANGLE, 0.75f), 1e-4f)
    }

    @Test
    fun `方波前半个周期为高`() {
        assertEquals(1f, sim.waveAt(sim.WAVE_SQUARE, 0f), 1e-4f)
        assertEquals(1f, sim.waveAt(sim.WAVE_SQUARE, 0.49f), 1e-4f)
        assertEquals(0f, sim.waveAt(sim.WAVE_SQUARE, 0.5f), 1e-4f)
        assertEquals(0f, sim.waveAt(sim.WAVE_SQUARE, 0.99f), 1e-4f)
    }

    @Test
    fun `恒定波形始终为 1`() {
        listOf(0f, 0.3f, 0.7f, 0.99f).forEach {
            assertEquals(1f, sim.waveAt(sim.WAVE_CONSTANT, it), 1e-4f)
        }
    }

    @Test
    fun `相位超过 1 会回绕 负数也能处理`() {
        assertEquals(0.25f, sim.waveAt(sim.WAVE_SAW, 1.25f), 1e-4f)
        assertEquals(0.25f, sim.waveAt(sim.WAVE_SAW, 2.25f), 1e-4f)
        assertEquals(0.75f, sim.waveAt(sim.WAVE_SAW, -0.25f), 1e-4f)
    }

    @Test
    fun `随机波形始终落在 0 到 1`() {
        repeat(300) {
            val v = sim.waveAt(sim.WAVE_RANDOM, 0f)
            assertTrue("v=$v", v in 0f..1f)
        }
    }

    // ================================================================ 相位

    @Test
    fun `相位按周期推进`() {
        assertEquals(0f, sim.phaseAt(1000L, 1000L, 10f), 1e-4f)
        assertEquals(0.5f, sim.phaseAt(6000L, 1000L, 10f), 1e-4f)
        assertEquals(0f, sim.phaseAt(11000L, 1000L, 10f), 1e-4f)
    }

    @Test
    fun `周期为 0 时被夹住 不产生 NaN 或 Inf`() {
        val v = sim.phaseAt(1000L, 0L, 0f)
        assertFalse("v=$v", v.isNaN())
        assertFalse("v=$v", v.isInfinite())
    }

    // ================================================================ 取值

    @Test
    fun `取值线性映射到 min 到 max`() {
        val ch = SignalSimulator.Channel("x", wave = sim.WAVE_SAW, min = 10f, max = 20f, noise = 0f)
        assertEquals(10f, sim.valueOf(ch, 0f), 1e-4f)
        assertEquals(15f, sim.valueOf(ch, 0.5f), 1e-4f)
        assertEquals("相位 1.0 会回绕成 0", 10f, sim.valueOf(ch, 1f), 1e-4f)
    }

    @Test
    fun `噪声不会让值跑出 min 到 max`() {
        val ch = SignalSimulator.Channel("x", wave = sim.WAVE_SINE, min = 0f, max = 1f, noise = 5f)
        repeat(300) { i ->
            val v = sim.valueOf(ch, i / 300f)
            assertTrue("v=$v 越界", v in 0f..1f)
        }
    }

    @Test
    fun `无噪声时输出是确定的`() {
        val ch = SignalSimulator.Channel("x", wave = sim.WAVE_SAW, min = 0f, max = 100f, noise = 0f)
        assertEquals(sim.valueOf(ch, 0.3f), sim.valueOf(ch, 0.3f), 1e-6f)
    }

    // ================================================================ 自动配置

    @Test
    fun `转速用锯齿且区间落在怠速到红线内`() {
        val ch = sim.autoChannel(PidDefinition(id = "std_0C"))
        assertEquals("锯齿能看出换挡回落", sim.WAVE_SAW, ch.wave)
        assertTrue("min=${ch.min}", ch.min in 500f..2000f)
        assertTrue("max=${ch.max}", ch.max in 2000f..7000f)
    }

    @Test
    fun `车速用正弦 水温用斜坡`() {
        assertEquals(sim.WAVE_SINE, sim.autoChannel(PidDefinition(id = "std_0D")).wave)
        assertEquals("斜坡能看出冷车到热车", sim.WAVE_RAMP, sim.autoChannel(PidDefinition(id = "std_05")).wave)
    }

    @Test
    fun `未知 PID 回落到它自己量程的中段`() {
        val ch = sim.autoChannel(PidDefinition(id = "custom_1", minVal = 0f, maxVal = 1000f))
        assertTrue("不能顶到量程两端 min=${ch.min}", ch.min > 0f)
        assertTrue("不能顶到量程两端 max=${ch.max}", ch.max < 1000f)
    }

    @Test
    fun `零量程的 PID 也不会算出 NaN`() {
        val ch = sim.autoChannel(PidDefinition(id = "weird", minVal = 5f, maxVal = 5f))
        assertFalse(ch.min.isNaN()); assertFalse(ch.max.isNaN())
        assertTrue(ch.max > ch.min)
    }

    @Test
    fun `每条自动通道的 min 都小于 max`() {
        listOf(
            "std_0C", "std_0D", "std_05", "std_42", "std_04", "std_11", "std_0F", "std_5C",
            "calc_boost", "calc_gx", "calc_gy", "calc_gforce"
        ).forEach { id ->
            val ch = sim.autoChannel(PidDefinition(id = id))
            assertTrue("$id: min=${ch.min} max=${ch.max}", ch.min < ch.max)
        }
    }

    // ================================================================ 派生 PID 与 G 值（修正）

    @Test
    fun `派生 PID 也能生成自动通道`() {
        // 早期版本把 CALC（派生）PID 过滤掉了，导致「G力值」预设在模拟模式下整块是死的
        listOf("calc_gx", "calc_gy", "calc_gforce").forEach { id ->
            val ch = sim.autoChannel(PidDefinition(id = id))
            assertTrue("$id 应可用", ch.min < ch.max)
        }
    }

    @Test
    fun `电压摆幅足够大 不至于看起来像固定值`() {
        // 0~20V 的表上只摆 0.9V，肉眼就是「没动」
        val v = sim.autoChannel(PidDefinition(id = "std_42"))
        assertTrue("摆幅 ${v.max - v.min}V 太小", v.max - v.min >= 2f)
    }

    @Test
    fun `温度类周期不至于长到看不出变化`() {
        // 60~120 秒的斜坡在 10 秒观察窗里几乎不动
        listOf("std_05", "std_0F", "std_5C").forEach { id ->
            val ch = sim.autoChannel(PidDefinition(id = id))
            assertTrue("$id 周期 ${ch.periodSec}s 太长", ch.periodSec <= 50f)
        }
    }

    @Test
    fun `G 值走圆轨迹 且 gforce 由 gx gy 算出`() {
        VehicleBus.clear()
        sim.update(sim.autoChannel(PidDefinition(id = "calc_gx")).copy(noise = 0f))
        sim.update(sim.autoChannel(PidDefinition(id = "calc_gy")).copy(noise = 0f))
        sim.update(sim.autoChannel(PidDefinition(id = "calc_gforce")).copy(noise = 0f))
        sim.setStartForTest(0L)

        // gx = 1.2·sin(2πp)，gy = 1.2·cos(2πp) → 半径恒定的圆
        val radius = 1.2f
        var bothPositive = false
        for (t in 0L..7000L step 1000L) {
            sim.tick(t)
            val x = VehicleBus.value("calc_gx")!!
            val y = VehicleBus.value("calc_gy")!!
            val g = VehicleBus.value("calc_gforce")!!
            assertEquals("t=$t: gforce 必须由 gx/gy 算出", sqrt(x * x + y * y), g, 1e-3f)
            assertEquals("t=$t: 圆轨迹半径应恒定", radius, g, 0.02f)
            if (x > 0f && y > 0f) bothPositive = true
        }
        assertTrue("应出现 gx/gy 同为正（圆周第一象限）", bothPositive)
    }

    @Test
    fun `普通通道照常独立发波形`() {
        VehicleBus.clear()
        sim.update(sim.autoChannel(PidDefinition(id = "std_0C")).copy(noise = 0f))
        sim.setStartForTest(0L)
        sim.tick(0L)
        val v0 = VehicleBus.value("std_0C")!!
        sim.tick(3000L)
        val v1 = VehicleBus.value("std_0C")!!
        assertTrue("转速应在变：$v0 → $v1", v0 != v1)
    }

    // ================================================================ 快速演示

    @Test
    fun `快速演示用满量程`() {
        val p = PidDefinition(id = "std_0C", minVal = 0f, maxVal = 8000f)
        val ch = sim.demoChannel(p)
        assertEquals("必须用 PID 的满量程，否则看不全表盘", 0f, ch.min, 1e-3f)
        assertEquals(8000f, ch.max, 1e-3f)
    }

    @Test
    fun `快速演示周期很短`() {
        val ch = sim.demoChannel(PidDefinition(id = "std_0C", minVal = 0f, maxVal = 8000f))
        assertEquals(sim.DEMO_PERIOD_SEC, ch.periodSec, 1e-3f)
        assertTrue("周期必须远短于自动模式，否则还是看不出在动", ch.periodSec <= 5f)
    }

    @Test
    fun `快速演示去掉噪声 便于看清刻度`() {
        assertEquals(0f, sim.demoChannel(PidDefinition(id = "std_0C")).noise, 1e-6f)
    }

    @Test
    fun `快速演示里 G 值保持正弦 否则圆轨迹会变方块`() {
        assertEquals(sim.WAVE_SINE, sim.demoChannel(PidDefinition(id = "calc_gx")).wave)
        assertEquals(sim.WAVE_SINE, sim.demoChannel(PidDefinition(id = "calc_gy")).wave)
    }

    @Test
    fun `快速演示里 G 合力从 0 起 不是负的`() {
        val ch = sim.demoChannel(PidDefinition(id = "calc_gforce", minVal = -2f, maxVal = 2f))
        assertEquals("合力不能是负的", 0f, ch.min, 1e-3f)
        assertTrue(ch.max > 0f)
    }

    @Test
    fun `快速演示在三秒内扫完全程`() {
        VehicleBus.clear()
        sim.update(sim.demoChannel(PidDefinition(id = "std_0C", minVal = 0f, maxVal = 8000f)))
        sim.setStartForTest(0L)
        val seen = HashSet<Int>()
        for (t in 0L..3000L step 250L) {
            sim.tick(t)
            seen.add((VehicleBus.value("std_0C")!! / 500f).toInt())
        }
        assertTrue("3 秒内应扫过多个区段，实际 ${seen.size} 段", seen.size >= 5)
    }
}
