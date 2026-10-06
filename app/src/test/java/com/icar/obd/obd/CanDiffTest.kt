package com.icar.obd.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 逐位差分 —— 用**实车抓到的原始 data** 做回归（2026-10-06 确认）。
 *
 * 这组字节是从实车日志里逐字抄下来的（CAN `0x09A`：关灯 / 左转 / 右转）。
 * 差分必须**只**报出那一位 —— `0x09A` 其余 7 个字节在三种状态下完全不变，
 * 所以"多报"和"漏报"都会被抓到。
 */
class CanDiffTest {

    private val off = "00 00 00 00 88 00 03 00"
    private val left = "00 00 04 00 88 00 03 00"
    private val right = "00 00 08 00 88 00 03 00"

    private fun snap(vararg v: String) = mapOf(0x09A to v.toSet())

    @Test
    fun 关灯到左转只报bit2() {
        val d = CanDiff.diff(snap(off), snap(off, left))
        assertEquals(1, d.size)
        assertEquals(0x09A, d[0].canId)
        assertEquals(2, d[0].byteIndex)
        assertEquals(2, d[0].bitIndex)
        assertEquals(CanDiff.BitState.CONST0, d[0].from)
        assertEquals(CanDiff.BitState.VARIES, d[0].to)
        assertTrue(d[0].isPrimary())
        assertEquals("bit(C,2)", d[0].formula())
    }

    @Test
    fun 关灯到右转只报bit3() {
        val d = CanDiff.diff(snap(off), snap(off, right))
        assertEquals(1, d.size)
        assertEquals(3, d[0].bitIndex)
        assertEquals("bit(C,3)", d[0].formula())
    }

    @Test
    fun 两趟都没动就没有差异() {
        assertEquals(0, CanDiff.diff(snap(off), snap(off)).size)
    }

    @Test
    fun 只在一次里出现的ID不报() {
        val a = mapOf(0x09A to setOf(off))
        val b = mapOf(0x09A to setOf(off), 0x4EC to setOf("00 00 00 09 00 00 00 00"))
        assertEquals(0, CanDiff.diff(a, b).size)
    }

    @Test
    fun 位状态表按字节和位展开() {
        val states = CanDiff.bitStates(setOf(off, left))!!
        assertEquals(64, states.size)
        assertEquals(CanDiff.BitState.VARIES, states[2 * 8 + 2])
        assertEquals(CanDiff.BitState.CONST0, states[2 * 8 + 3])
    }
}