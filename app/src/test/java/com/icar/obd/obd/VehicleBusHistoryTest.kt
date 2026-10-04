package com.icar.obd.obd

import com.icar.obd.data.PidValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [VehicleBus] 历史缓冲的单元测试（线型图的数据来源）。
 *
 * 这一段值得测，因为它有两个**不会报错、只会画错**的风险：
 *  - 无界增长（长时间行车把内存吃光）；
 *  - 把 NaN / 失败值也记进历史（曲线被打断成锯齿）。
 *
 * `VehicleBus` 是单例，测试之间会互相污染，所以每个用例前 [VehicleBus.clear]。
 */
class VehicleBusHistoryTest {

    @Before
    fun setUp() {
        VehicleBus.clear()
    }

    private fun put(id: String, v: Float, ok: Boolean = true) =
        VehicleBus.put(PidValue(id, v, "", 0L, ok))

    @Test
    fun `put 会按时间顺序写入历史`() {
        put("x", 1f)
        put("x", 2f)
        put("x", 3f)
        assertEquals(listOf(1f, 2f, 3f), VehicleBus.historyOf("x"))
    }

    @Test
    fun `失败值不进历史`() {
        put("x", 1f)
        put("x", 999f, ok = false)
        put("x", 2f)
        assertEquals(listOf(1f, 2f), VehicleBus.historyOf("x"))
    }

    @Test
    fun `NaN 与无穷即使 ok 也不进历史`() {
        put("x", Float.NaN)
        put("x", Float.POSITIVE_INFINITY)
        put("x", Float.NEGATIVE_INFINITY)
        assertTrue(VehicleBus.historyOf("x").isEmpty())
    }

    @Test
    fun `历史有界 超出丢最旧`() {
        val n = VehicleBus.HISTORY_SIZE + 20
        for (i in 0 until n) put("x", i.toFloat())

        val h = VehicleBus.historyOf("x")
        assertEquals("长度必须被夹在 HISTORY_SIZE", VehicleBus.HISTORY_SIZE, h.size)
        assertEquals("最旧的应被丢弃", (n - VehicleBus.HISTORY_SIZE).toFloat(), h.first(), 1e-6f)
        assertEquals("最新的应是最后一个", (n - 1).toFloat(), h.last(), 1e-6f)
    }

    @Test
    fun `不同通道的历史互不干扰`() {
        put("a", 1f)
        put("b", 2f)
        put("a", 3f)
        assertEquals(listOf(1f, 3f), VehicleBus.historyOf("a"))
        assertEquals(listOf(2f), VehicleBus.historyOf("b"))
    }

    @Test
    fun `没记录过的通道返回空列表而不是 null`() {
        assertTrue(VehicleBus.historyOf("never").isEmpty())
    }

    @Test
    fun `clear 会同时清掉数值与历史`() {
        put("x", 1f)
        VehicleBus.clear()
        assertTrue(VehicleBus.historyOf("x").isEmpty())
        assertEquals(null, VehicleBus.get("x"))
    }

    @Test
    fun `返回的是快照 外部修改不影响内部`() {
        put("x", 1f)
        val h = VehicleBus.historyOf("x") as MutableList<Float>
        h.add(999f)
        assertEquals("快照被改不应污染总线", listOf(1f), VehicleBus.historyOf("x"))
    }
}
