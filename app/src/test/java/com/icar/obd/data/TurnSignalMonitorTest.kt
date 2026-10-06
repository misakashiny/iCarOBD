package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 转向灯监听位 —— 用**实车抓到的原始 data** 做回归（2026-10-06 确认）。
 *
 * CAN `0x09A` 第 3 字节（`A B C…` 里的 `C`）：bit2 = 左转，bit3 = 右转。
 * 这组字节是从实车日志里逐字抄下来的，不是构造的 —— 所以它同时锁住了
 * 「位选得对不对」和「`bit()` 的下标是 0-based」这两件事。
 */
class TurnSignalMonitorTest {

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    private val off = bytes(0x00, 0x00, 0x00, 0x00, 0x88, 0x00, 0x03, 0x00)
    private val left = bytes(0x00, 0x00, 0x04, 0x00, 0x88, 0x00, 0x03, 0x00)
    private val right = bytes(0x00, 0x00, 0x08, 0x00, 0x88, 0x00, 0x03, 0x00)
    private val hazard = bytes(0x00, 0x00, 0x0C, 0x00, 0x88, 0x00, 0x03, 0x00)

    @Test
    fun 左转只置bit2() {
        assertEquals(0.0, Formula.eval("bit(C,2)", off), 1e-6)
        assertEquals(1.0, Formula.eval("bit(C,2)", left), 1e-6)
        assertEquals(0.0, Formula.eval("bit(C,2)", right), 1e-6)
    }

    @Test
    fun 右转只置bit3() {
        assertEquals(0.0, Formula.eval("bit(C,3)", off), 1e-6)
        assertEquals(0.0, Formula.eval("bit(C,3)", left), 1e-6)
        assertEquals(1.0, Formula.eval("bit(C,3)", right), 1e-6)
    }

    @Test
    fun 双闪两位同时置位() {
        assertEquals(1.0, Formula.eval("bit(C,2)", hazard), 1e-6)
        assertEquals(1.0, Formula.eval("bit(C,3)", hazard), 1e-6)
    }
}