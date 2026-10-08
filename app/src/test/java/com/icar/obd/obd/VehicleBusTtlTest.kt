package com.icar.obd.obd

import com.icar.obd.data.PidValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * **新鲜度（ttl）** 的单元测试（v1.20.7，S2）。
 *
 * ## 为什么这一条要单独钉住
 *
 * 广播信号停发时**没人会来清掉总线里的最后一个值** —— 不判超时，
 * 仪表就会一直挂着"最后一次收到的那一个数字"，看起来和实时一样。
 * 这正是用户说的"被过期值骗"。
 *
 * ## 为什么"变成 `ok=false`"就够了（下游零改动）
 *
 * `VehicleBus.value()` 与 `DashRenderer` **都是 `ok` 才给值**：
 *  - 仪表 → `--`
 *  - 规则引擎 → 用 `snapshot()` / `value()` → 不误触发
 *  - CSV → `ObdController` 用 `snapshot()` → 记空
 *
 * 所以**三个入口（get / value / snapshot）必须全部过同一关** ——
 * 漏掉任何一个都会留下一条"看得见旧值"的路。下面每个入口都有用例。
 *
 * `VehicleBus` 是单例，测试之间会互相污染，所以每个用例前 [VehicleBus.clear]。
 */
class VehicleBusTtlTest {

    @Before
    fun setUp() {
        VehicleBus.clear()
    }

    private fun put(id: String, v: Float, ts: Long, ttl: Int) =
        VehicleBus.put(PidValue(id, v, "raw", ts, true, ttlMs = ttl))

    private fun stale(id: String, ttl: Int = 2000, v: Float = 1f) =
        put(id, v, System.currentTimeMillis() - 5000, ttl)

    @Test
    fun `ttl 为 0 时永不超时（旧行为）`() {
        put("x", 1f, System.currentTimeMillis() - 3_600_000, 0)
        assertTrue(VehicleBus.get("x")!!.ok)
        assertEquals(1f, VehicleBus.value("x")!!, 1e-6f)
        assertTrue(VehicleBus.snapshot().getValue("x").ok)
    }

    @Test
    fun `未超时的值照常给`() {
        put("x", 1f, System.currentTimeMillis() - 500, 2000)
        assertTrue(VehicleBus.get("x")!!.ok)
        assertEquals(1f, VehicleBus.value("x")!!, 1e-6f)
    }

    @Test
    fun `超时后 get 返回 ok=false 的副本 且保留原始时间戳`() {
        val ts = System.currentTimeMillis() - 5000
        put("x", 1f, ts, 2000)
        val v = VehicleBus.get("x")!!
        assertFalse(v.ok)
        assertTrue("要说清为什么没值：${v.error}", v.error!!.contains("过期"))
        assertEquals("时间戳不能被改写，否则看不出到底多旧", ts, v.ts)
        assertEquals(1f, v.value, 1e-6f)
    }

    @Test
    fun `超时后 value 返回 null —— 仪表显示 --`() {
        stale("x")
        assertNull(VehicleBus.value("x"))
    }

    @Test
    fun `超时后 snapshot 里也是 ok=false —— 规则不误触发 且 CSV 记空`() {
        val now = System.currentTimeMillis()
        put("fresh", 1f, now, 2000)
        put("stale", 2f, now - 5000, 2000)
        val snap = VehicleBus.snapshot()
        assertTrue(snap.getValue("fresh").ok)
        assertFalse("规则引擎按 snapshot 判条件、CSV 按 snapshot 记数", snap.getValue("stale").ok)
    }

    @Test
    fun `超时判定只发生在读取时 不写回总线`() {
        val ts = System.currentTimeMillis() - 5000
        put("x", 1f, ts, 2000)
        VehicleBus.get("x")
        VehicleBus.value("x")
        VehicleBus.snapshot()
        // 原始记录（时间戳与值）不该被读取动作改写：否则"多久没更新"就永远算不出来
        assertEquals(ts, VehicleBus.get("x")!!.ts)
        assertEquals(1f, VehicleBus.get("x")!!.value, 1e-6f)
    }

    @Test
    fun `失败的值不会被 ttl 逻辑翻成成功`() {
        VehicleBus.put(PidValue("x", 0f, "", System.currentTimeMillis(), false, "超时无响应", ttlMs = 2000))
        val v = VehicleBus.get("x")!!
        assertFalse(v.ok)
        assertEquals("原本的错误原因要保留，不能被覆盖成'过期'", "超时无响应", v.error)
    }

    @Test
    fun `每个通道各判各的 ttl`() {
        val now = System.currentTimeMillis()
        put("short", 1f, now - 1500, 1000)
        put("long", 2f, now - 1500, 3000)
        assertNull("ttl=1000 已经过期", VehicleBus.value("short"))
        assertEquals(2f, VehicleBus.value("long")!!, 1e-6f)
    }
}
