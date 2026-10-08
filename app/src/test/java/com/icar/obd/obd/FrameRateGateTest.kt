package com.icar.obd.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 帧率闸（v1.20.6，P10-5）—— 监听通道的**主线程保命装置**。
 *
 * ## 为什么这批用例值得写
 *
 * 它要防的是**已经发生过一次的事故类型**：主线程堆积 → ANR（v1.18.4）。
 * 而它自己的失败方式很隐蔽 —— 闸门太松等于没有（ANR 照旧），
 * 太紧则是"转向灯偶尔不响"（用户只会说"有时候灵有时候不灵"）。
 * 两种都不会在编译期或"随手点两下"里暴露出来，所以必须把判据钉死。
 *
 * 时间由调用方传入（见 [FrameRateGate] 的类注释），所以这里可以精确造场景。
 */
class FrameRateGateTest {

    /** 在一个窗口里灌 n 行：先 evaluate 一次（可能滚动窗口），再逐行计数 */
    private fun window(g: FrameRateGate, nowMs: Long, lines: Int): FrameRateGate.Mode {
        val m = g.evaluate(nowMs)
        repeat(lines) { g.countLine() }
        return m
    }

    @Test
    fun `正常帧率一直是 NORMAL`() {
        val g = FrameRateGate()
        // 单 ID 过滤器下的真实水平是 2~11 行/秒
        repeat(10) { w ->
            val m = window(g, 1000L + w * 1000L, 11)
            assertEquals("第 $w 个窗口不该被限流", FrameRateGate.Mode.NORMAL, m)
        }
        assertEquals(11, g.lastWindowLines)
        assertEquals(0L, g.skipped)
    }

    @Test
    fun `超过软上限的下一秒进入限流`() {
        val g = FrameRateGate()
        // 软上限与硬上限之间（150 < 200 ≤ 240）：只限流，不丢帧
        assertEquals(FrameRateGate.Mode.NORMAL, window(g, 1000L, 200))
        // 判据是**上一个窗口**：所以下一批才开始限流
        assertEquals(FrameRateGate.Mode.THROTTLED, g.evaluate(2000L))
        assertEquals(200, g.lastWindowLines)
    }

    @Test
    fun `实车满速总线 344 帧每秒会直接进过载`() {
        // 这个数字不是编的：不过滤时实车实测 344 帧/秒（见 P10-5）
        val g = FrameRateGate()
        window(g, 1000L, 344)
        assertEquals(FrameRateGate.Mode.OVERLOAD, g.evaluate(2000L))
    }

    @Test
    fun `超过硬上限的下一秒进入过载`() {
        val g = FrameRateGate()
        window(g, 1000L, FrameRateGate.DEFAULT_HARD_LIMIT + 1)
        assertEquals(FrameRateGate.Mode.OVERLOAD, g.evaluate(2000L))
    }

    @Test
    fun `退出限流有迟滞_不会在阈值上下每秒抖动`() {
        val g = FrameRateGate()
        val soft = FrameRateGate.DEFAULT_SOFT_LIMIT
        // 先冲上去
        window(g, 1000L, soft + 50)
        assertEquals(FrameRateGate.Mode.THROTTLED, g.evaluate(2000L))

        // 降到 soft 的 60%~100% 之间：**仍然限流**（没有迟滞的话这里会跳回 NORMAL）
        window(g, 2000L, soft * 8 / 10)
        assertEquals(
            "迟滞就是为了这个区间：没有它，流量在阈值上下抖动会每秒切换一次模式",
            FrameRateGate.Mode.THROTTLED, g.evaluate(3000L)
        )

        // 降到 60% 以下才恢复
        window(g, 3000L, soft / 2)
        assertEquals(FrameRateGate.Mode.NORMAL, g.evaluate(4000L))
    }

    @Test
    fun `同一个窗口内反复求值不会重复滚动`() {
        val g = FrameRateGate()
        window(g, 1000L, 200)              // 先攒 200 行（> soft）
        // 同一窗口内再求值：不能提前把 200 行算成"上一个窗口"
        assertEquals(FrameRateGate.Mode.NORMAL, g.evaluate(1500L))
        g.countLine()
        // 窗口真的到点之后才生效，且计数含那额外一行
        assertEquals(FrameRateGate.Mode.THROTTLED, g.evaluate(2000L))
        assertEquals(201, g.lastWindowLines)
    }

    @Test
    fun `跳过与丢弃分别记账`() {
        val g = FrameRateGate()
        window(g, 1000L, 300)
        g.evaluate(2000L)
        repeat(7) { g.noteSkipped() }
        g.noteChunkDropped(128)
        assertEquals(7L, g.skipped)
        assertEquals(128L, g.droppedOverload)
    }

    @Test
    fun `reset 回到正常并清空统计`() {
        val g = FrameRateGate()
        window(g, 1000L, 500)
        assertEquals(FrameRateGate.Mode.OVERLOAD, g.evaluate(2000L))
        g.noteSkipped()
        g.noteChunkDropped(10)

        g.reset()
        assertEquals(FrameRateGate.Mode.NORMAL, g.mode)
        assertEquals(0, g.lastWindowLines)
        assertEquals(0L, g.skipped)
        assertEquals(0L, g.droppedOverload)
        // 重新开监听后不该还带着上一趟的"过载"记忆
        assertEquals(FrameRateGate.Mode.NORMAL, window(g, 9999L, 5))
    }

    @Test
    fun `过载时的提示必须说清怎么办`() {
        val g = FrameRateGate()
        window(g, 1000L, FrameRateGate.DEFAULT_HARD_LIMIT + 1)
        g.evaluate(2000L)
        val d = g.describe()
        assertTrue("要给出可执行的建议：$d", d.contains("拆成两次"))
        assertTrue("要说清当前帧率：$d", d.contains("行/秒"))
    }

    // ================================================================ 预筛（安全性）

    /**
     * 这一条是**安全性质**，比性能重要：预筛允许丢的行，必须恰好是
     * "解析出来也不可能命中"的行。否则表现就是"转向灯有时候不响"。
     */
    @Test
    fun `预筛放行所有解析后能命中的行`() {
        val ids = listOf(0x09A, 0x4C1, 0x7E8)
        val accept = FrameRateGate.acceptIdsOf(ids)
        listOf(
            "09A 8 00 00 00 00 00 00 00",
            "09a 8 00 00 00 00 00 00 00",
            "  09A 8 00 00 00 00 00 00 00",
            "4C1 2 01 02",
            "7E8 06 41 0C 1A F8 00 00"
        ).forEach { line ->
            val f = CanFrame.parseLine(line)
            assertNotNull("这条行本身要能解析：$line", f)
            assertTrue("解析出来的 ID 该在监听集合里：$line", ids.contains(f!!.canId))
            assertTrue("解析出来命中了监听 ID，预筛却把它丢了：$line", FrameRateGate.leadingIdMatches(line, accept))
        }
    }

    @Test
    fun `两位十六进制的行解析器自己就不接受_预筛收它只是不让自己成为新瓶颈`() {
        // `CanFrame.parseLine` 要求 ID token 长度 3~8 —— 2 位的行它自己就会丢掉。
        // 预筛仍然把 `9A` 收进集合：万一以后放宽解析规则，预筛不会变成新的瓶颈。
        assertNull(CanFrame.parseLine("9A 8 00 00 00 00 00 00 00"))
        assertTrue(
            FrameRateGate.leadingIdMatches(
                "9A 8 00 00 00 00 00 00 00",
                FrameRateGate.acceptIdsOf(listOf(0x09A))
            )
        )
    }

    @Test
    fun `预筛丢掉的是解析后也命不中的行`() {
        val accept = FrameRateGate.acceptIdsOf(listOf(0x09A))
        listOf(
            "2C7 8 00 11 22 33 44 55 66",
            "18DAF110 8 00 11 22 33 44 55 66",   // 29 位 ID
            "SEARCHING...",
            ">",
            "NO DATA",
            "0FD630090001E002830"                 // 粘行（无空格）：parseLine 同样解不出
        ).forEach { line ->
            val f = CanFrame.parseLine(line)
            assertTrue(
                "这些行不该被放行：$line（parseLine=$f）",
                !FrameRateGate.leadingIdMatches(line, accept)
            )
            if (f != null) assertFalse("解析出来了就说明它命中了监听 ID", f.canId == 0x09A)
        }
    }

    @Test
    fun `预筛集合为空时不筛`() {
        // 没有监听 ID 是异常状态 —— 那时宁可全解析，也不能把唯一的证据筛掉
        assertTrue(FrameRateGate.leadingIdMatches("2C7 8 00 11", emptyList()))
    }

    @Test
    fun `预筛集合同时收两位与三位的写法`() {
        val accept = FrameRateGate.acceptIdsOf(listOf(0x09A))
        assertTrue(accept.contains("9A"))
        assertTrue(accept.contains("09A"))
        assertEquals("不该有重复", accept.size, accept.distinct().size)
    }
}
