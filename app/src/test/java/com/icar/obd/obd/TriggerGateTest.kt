package com.icar.obd.obd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `RuleEngine` 触发时序的单元测试（迭代清单 P2-1）。
 *
 * 这是全项目最容易误解的一段语义：**重复触发**，不是边沿触发。
 * 转向灯「一秒一闪」正是靠「条件持续为真 → 触发 → 冷却 → 仍为真则再触发」实现的。
 *
 * 之所以能这样测：v1.3.1 把这段时序判定从 `RuleEngine.evaluate()`（依赖
 * `VehicleBus` / `AppLog` / `Store`，JVM 下不可用）抽成了纯逻辑 [TriggerGate]。
 *
 * 时间基准用真实 `currentTimeMillis()` 量级：`lastFire` 缺省值是 `0L`
 * （即「从未触发」被当作 1970 年触发过），这是刻意的原实现语义，不要用
 * 小数字当 now，否则会踩到那个隐含假设。
 */
class TriggerGateTest {

    private val t0 = 1_700_000_000_000L

    @Test
    fun `duration 未满不触发`() {
        val g = TriggerGate()
        assertFalse(g.shouldFire("r", t0, durationMs = 500, cooldownMs = 0))
        assertFalse(g.shouldFire("r", t0 + 400, durationMs = 500, cooldownMs = 0))
        assertTrue(g.shouldFire("r", t0 + 500, durationMs = 500, cooldownMs = 0))
    }

    @Test
    fun `duration 为 0 时条件一成立即触发`() {
        val g = TriggerGate()
        assertTrue(g.shouldFire("r", t0, durationMs = 0, cooldownMs = 0))
    }

    @Test
    fun `冷却期内不重复触发 冷却结束后再次触发`() {
        // 这条就是「转向灯音效」的行为：450ms 冷却 = 一秒闪两次
        val g = TriggerGate()
        assertTrue(g.shouldFire("r", t0, durationMs = 0, cooldownMs = 450))
        assertFalse(g.shouldFire("r", t0 + 200, durationMs = 0, cooldownMs = 450))
        assertFalse(g.shouldFire("r", t0 + 449, durationMs = 0, cooldownMs = 450))
        assertTrue("冷却结束且条件仍成立时应再次触发", g.shouldFire("r", t0 + 450, durationMs = 0, cooldownMs = 450))
        // 继续按周期重复
        assertFalse(g.shouldFire("r", t0 + 700, durationMs = 0, cooldownMs = 450))
        assertTrue(g.shouldFire("r", t0 + 900, durationMs = 0, cooldownMs = 450))
    }

    @Test
    fun `条件中断后持续计时清零 必须重新计满 duration`() {
        val g = TriggerGate()
        assertFalse(g.shouldFire("r", t0, durationMs = 1000, cooldownMs = 0))
        assertFalse(g.shouldFire("r", t0 + 900, durationMs = 1000, cooldownMs = 0))

        g.onUnsatisfied("r")   // 条件一度不成立

        assertFalse("重新计时，不能沿用之前的 900ms", g.shouldFire("r", t0 + 1000, durationMs = 1000, cooldownMs = 0))
        assertFalse(g.shouldFire("r", t0 + 1900, durationMs = 1000, cooldownMs = 0))
        assertTrue(g.shouldFire("r", t0 + 2000, durationMs = 1000, cooldownMs = 0))
    }

    @Test
    fun `持续成立期间反复调用不会提前触发`() {
        val g = TriggerGate()
        assertFalse(g.shouldFire("r", t0, durationMs = 300, cooldownMs = 0))
        assertFalse(g.shouldFire("r", t0 + 100, durationMs = 300, cooldownMs = 0))
        assertFalse(g.shouldFire("r", t0 + 200, durationMs = 300, cooldownMs = 0))
        assertTrue(g.shouldFire("r", t0 + 300, durationMs = 300, cooldownMs = 0))
    }

    @Test
    fun `多条规则的状态互不干扰`() {
        val g = TriggerGate()
        assertTrue(g.shouldFire("a", t0, durationMs = 0, cooldownMs = 0))
        assertFalse(g.shouldFire("b", t0, durationMs = 1000, cooldownMs = 0))
        assertTrue(g.shouldFire("a", t0 + 100, durationMs = 0, cooldownMs = 0))
        assertTrue(g.shouldFire("b", t0 + 1000, durationMs = 1000, cooldownMs = 0))
    }

    @Test
    fun `clear 会同时清掉持续计时与冷却`() {
        val g = TriggerGate()
        assertFalse(g.shouldFire("r", t0, durationMs = 1000, cooldownMs = 0))
        assertTrue(g.shouldFire("r", t0 + 1000, durationMs = 1000, cooldownMs = 0))

        g.clear()

        assertTrue("冷却被清掉，立即可再触发", g.shouldFire("r", t0 + 1000, durationMs = 0, cooldownMs = 450))
    }

    @Test
    fun `duration 与 cooldown 同时生效时先满足 duration 再受 cooldown 限制`() {
        val g = TriggerGate()
        assertFalse(g.shouldFire("r", t0, durationMs = 200, cooldownMs = 1000))
        assertTrue(g.shouldFire("r", t0 + 200, durationMs = 200, cooldownMs = 1000))
        assertFalse(g.shouldFire("r", t0 + 900, durationMs = 200, cooldownMs = 1000))
        assertTrue(g.shouldFire("r", t0 + 1200, durationMs = 200, cooldownMs = 1000))
    }
}
