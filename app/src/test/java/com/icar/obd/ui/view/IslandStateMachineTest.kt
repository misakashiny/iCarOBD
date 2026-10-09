package com.icar.obd.ui.view

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [IslandStateMachine] 的用例（v1.20.12）。
 *
 * 这一组守的是「灵动岛什么时候展开 / 收起 / 换文案」——
 * 全部发生在时间轴上，放进 `Handler` / `onDraw` 就没法验了，
 * 所以抽成纯逻辑在这里钉住（与 `AlertPulseTest`、`FrameRateGateTest` 同一条约定）。
 */
class IslandStateMachineTest {

    private val HOLD = 4000L

    @Test
    fun `初始是隐藏的`() {
        val m = IslandStateMachine(HOLD)
        assertFalse(m.current.visible)
        assertEquals("", m.current.text)
    }

    @Test
    fun `来一条就展开`() {
        val m = IslandStateMachine(HOLD)
        val s = m.onMessage("水温 105℃ 过高", 1000L)
        assertTrue(s.visible)
        assertEquals("水温 105℃ 过高", s.text)
        assertEquals(0, s.pending)
        assertEquals(1000L + HOLD, s.untilMs)
    }

    @Test
    fun `空白文案不弹空胶囊`() {
        val m = IslandStateMachine(HOLD)
        assertFalse(m.onMessage("   ", 0L).visible)
        assertFalse(m.onMessage("", 0L).visible)
    }

    @Test
    fun `到点自动收起`() {
        val m = IslandStateMachine(HOLD)
        m.onMessage("水温过高", 0L)
        assertTrue(m.onTick(HOLD - 1).visible)     // 还差 1ms
        assertFalse(m.onTick(HOLD).visible)        // 到点
        assertEquals("", m.current.text)
    }

    @Test
    fun `同一条重复触发只续期 —— 不会闪、也不会把 +N 刷到几百`() {
        // 这是转向灯那类规则的真实形态：每 450ms 触发一次
        val m = IslandStateMachine(HOLD)
        m.onMessage("左转向灯", 0L)
        var now = 0L
        repeat(20) {
            now += 450
            val s = m.onMessage("左转向灯", now)
            assertTrue("第 $it 次不该收起", s.visible)
            assertEquals("同一条不该累加 +N", 0, s.pending)
            assertEquals(now + HOLD, s.untilMs)
        }
    }

    @Test
    fun `不同的提示会换文案并累加 +N`() {
        val m = IslandStateMachine(HOLD)
        m.onMessage("水温 105℃ 过高", 0L)
        val s2 = m.onMessage("电压 11.2V 偏低", 100L)
        assertEquals("电压 11.2V 偏低", s2.text)
        assertEquals(1, s2.pending)
        val s3 = m.onMessage("车速 130km/h", 200L)
        assertEquals("车速 130km/h", s3.text)
        assertEquals(2, s3.pending)
        // 换文案会续期：最新那条也要看满 4 秒
        assertEquals(200L + HOLD, s3.untilMs)
    }

    @Test
    fun `收起之后再来的算全新一条 —— pending 归零`() {
        val m = IslandStateMachine(HOLD)
        m.onMessage("A", 0L)
        m.onMessage("B", 10L)                     // pending=1
        assertFalse(m.onTick(HOLD + 100).visible) // 已收起
        val s = m.onMessage("C", HOLD + 200)
        assertTrue(s.visible)
        assertEquals("C", s.text)
        assertEquals(0, s.pending)
    }

    @Test
    fun `reset 立刻回到隐藏`() {
        val m = IslandStateMachine(HOLD)
        m.onMessage("A", 0L)
        m.onMessage("B", 1L)
        m.reset()
        assertFalse(m.current.visible)
        assertEquals("", m.current.text)
        assertEquals(0, m.current.pending)
    }

    @Test
    fun `未展开时 tick 不会把它变成可见`() {
        val m = IslandStateMachine(HOLD)
        assertFalse(m.onTick(999999L).visible)
    }

    @Test
    fun `文案首尾空白会被去掉`() {
        val m = IslandStateMachine(HOLD)
        assertEquals("水温过高", m.onMessage("  水温过高  ", 0L).text)
    }

    @Test
    fun `去掉空白后相同的算同一条`() {
        val m = IslandStateMachine(HOLD)
        m.onMessage("水温过高", 0L)
        val s = m.onMessage("  水温过高  ", 100L)
        assertEquals(0, s.pending)                 // 不该被当成"另一件事"
    }

    @Test
    fun `停留时长与告警条一致 —— 4 秒`() {
        assertEquals(4000L, IslandStateMachine.HOLD_MS)
    }
}
