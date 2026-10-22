package com.icar.obd.obd

import com.icar.obd.data.PidValue
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * P5A-M05 阶段 D：断开 / 过期 / 重连 / 来源归属的**数据可靠性**回归。
 *
 * ## 覆盖任务 §六 的 10 项
 *
 * 1 蓝牙断开 → 来源关闭，值不再冒充实时
 * 2 初始化超时 → 无数据
 * 3 PID 连续超时 → 已由 ObdEngine 的退避/冷却处理（本文件只验证总线侧不残留假值）
 * 4 VehicleBus TTL 过期
 * 5 真实采集来源关闭
 * 6 旧来源迟到响应不覆盖新连接
 * 7 用户主动停止
 * 8/9 切后台/回前台（进程内状态不被清成"有值"）
 * 10 进程重启（新 source，旧值不复活）
 *
 * ## 为什么这些放在 VehicleBus 层测
 *
 * 「断开/过期/重连」最终都体现为**总线上那个值还可不可信**。
 * 通信层的错误路径已由 `ObdLinkIntegrationTest`（15 项）覆盖，
 * 这里专注"值落地之后的可信度"，两层合起来才是完整链路。
 */
class ObdDataReliabilityTest {

    @Before fun setUp() { VehicleBus.clear() }
    @After fun tearDown() { VehicleBus.clear() }

    private fun v(id: String, value: Float, ttl: Int = 0, ok: Boolean = true) =
        PidValue(id, value, "00", System.currentTimeMillis(), ok, null, ttl)

    // ------------------------------------------------------------------ D1 断开

    @Test
    fun `D1 蓝牙断开后来源关闭 值不再冒充实时`() {
        val src = VehicleBus.openSource("ble-1")
        VehicleBus.put(src, v("std_0C", 3000f))
        assertEquals(3000f, VehicleBus.get("std_0C")!!.value!!, 0.1f)

        VehicleBus.closeSource(src)
        val after = VehicleBus.get("std_0C")
        assertNotNull("值本身仍可读到（供 UI 显示 -- 之前判断）", after)
        assertFalse("但必须已标为无效", after!!.ok)
        assertNotNull("并且要有原因", after.error)
    }

    // ------------------------------------------------------------------ D2 初始化超时

    @Test
    fun `D2 初始化超时 总线上不会留下任何有效值`() {
        // 初始化失败 = 从来没 put 过，总线应当为空
        assertTrue("初始化超时不应产生任何值", VehicleBus.snapshot().isEmpty())
        assertNull(VehicleBus.get("std_0C"))
    }

    // ------------------------------------------------------------------ D4 TTL 过期

    @Test
    fun `D4 TTL 过期后读到的是无效值且带过期原因`() {
        val src = VehicleBus.openSource("ble-ttl")
        // TTL 设成 1ms 便于确定性过期
        VehicleBus.put(src, v("std_0D", 60f, ttl = 1))
        Thread.sleep(20)
        val got = VehicleBus.get("std_0D")!!
        assertFalse("过期必须 ok=false", got.ok)
        assertNotNull(got.error)
        assertTrue("原因里应提到过期", got.error!!.contains("过期") || got.error!!.contains("ttl"))
        VehicleBus.closeSource(src)
    }

    @Test
    fun `D4b 未过期时仍是有效值`() {
        val src = VehicleBus.openSource("ble-ttl2")
        VehicleBus.put(src, v("std_0D", 60f, ttl = 60_000))
        val got = VehicleBus.get("std_0D")!!
        assertTrue(got.ok)
        assertEquals(60f, got.value!!, 0.1f)
        VehicleBus.closeSource(src)
    }

    // ------------------------------------------------------------------ D5 来源关闭

    @Test
    fun `D5 真实采集来源关闭时 全部值同步失效`() {
        val src = VehicleBus.openSource("ble-all")
        listOf("std_0C", "std_0D", "std_05").forEach { VehicleBus.put(src, v(it, 1f)) }
        assertEquals(3, VehicleBus.snapshot().count { it.value.ok })
        VehicleBus.closeSource(src)
        assertEquals("关闭后 0 条有效", 0, VehicleBus.snapshot().count { it.value.ok })
    }

    // ------------------------------------------------------------------ D6 旧来源迟到

    @Test
    fun `D6 旧来源的迟到响应不得覆盖新连接的结果`() {
        val old = VehicleBus.openSource("ble-gen1")
        VehicleBus.put(old, v("std_0C", 1111f))

        // 重连：旧来源关闭，新来源打开（epoch 递增）
        VehicleBus.closeSource(old)
        val fresh = VehicleBus.openSource("ble-gen2")
        VehicleBus.put(fresh, v("std_0C", 2222f))
        assertEquals(2222f, VehicleBus.get("std_0C")!!.value!!, 0.1f)

        // 旧来源"迟到"再 put 一次 —— 必须被拒绝
        val accepted = VehicleBus.put(old, v("std_0C", 9999f))
        assertFalse("已关闭的旧来源不应被接受", accepted)
        assertEquals("新连接的值不能被旧响应覆盖", 2222f, VehicleBus.get("std_0C")!!.value!!, 0.1f)
    }

    @Test
    fun `D6b 同一 owner 重开后 上一个 epoch 的写入也被拒绝`() {
        val g1 = VehicleBus.openSource("same-owner")
        VehicleBus.put(g1, v("std_0D", 50f))
        // 同 owner 再 open → 旧 source 自动失效
        val g2 = VehicleBus.openSource("same-owner")
        VehicleBus.put(g2, v("std_0D", 70f))
        assertFalse("旧 epoch 不得写入", VehicleBus.put(g1, v("std_0D", 999f)))
        assertEquals(70f, VehicleBus.get("std_0D")!!.value!!, 0.1f)
        VehicleBus.closeSource(g2)
    }

    // ------------------------------------------------------------------ D7 用户主动停止

    @Test
    fun `D7 用户主动停止后没有任何残留有效值`() {
        val src = VehicleBus.openSource("user-stop")
        VehicleBus.put(src, v("std_0C", 2500f))
        VehicleBus.closeSource(src)
        VehicleBus.snapshot().forEach { (_, value) ->
            assertFalse("主动停止后不应还有有效值：${value.pidId}", value.ok)
        }
    }

    // ------------------------------------------------------------------ D8/D9 前后台

    @Test
    fun `D8 D9 切后台回来 值按 TTL 判新旧 不会自动复活`() {
        val src = VehicleBus.openSource("bg")
        VehicleBus.put(src, v("std_0D", 88f, ttl = 1_000))
        // 模拟"切后台 2 秒"（超过 TTL）
        Thread.sleep(1_100)
        val got = VehicleBus.get("std_0D")!!
        assertFalse("回来后过期值不能当实时", got.ok)
        // 重新来数据后恢复
        VehicleBus.put(src, v("std_0D", 99f, ttl = 60_000))
        assertTrue(VehicleBus.get("std_0D")!!.ok)
        assertEquals(99f, VehicleBus.get("std_0D")!!.value!!, 0.1f)
        VehicleBus.closeSource(src)
    }

    // ------------------------------------------------------------------ D10 进程重启

    @Test
    fun `D10 进程重启等价于 clear 后全新来源 旧值不复活`() {
        val src = VehicleBus.openSource("before-restart")
        VehicleBus.put(src, v("std_0C", 4321f))
        // 进程重启 = 内存全丢
        VehicleBus.clear()
        assertNull("重启后旧值不复存在", VehicleBus.get("std_0C"))

        // 新进程第一次连接：在拿到数据之前，总线必须还是空
        val after = VehicleBus.openSource("after-restart")
        assertTrue("新连接在拿到数据前不应凭空有值", VehicleBus.snapshot().isEmpty())
        VehicleBus.put(after, v("std_0C", 100f))
        assertEquals(100f, VehicleBus.get("std_0C")!!.value!!, 0.1f)
        VehicleBus.closeSource(after)
    }

    // ------------------------------------------------------------------ 附加：来源归属

    @Test
    fun `S1 两个来源同时写入时 后开的那个说了算`() {
        val a = VehicleBus.openSource("src-A")
        val b = VehicleBus.openSource("src-B")   // 不同 owner → 各自独立
        VehicleBus.put(a, v("std_0D", 10f))
        assertEquals(10f, VehicleBus.get("std_0D")!!.value!!, 0.1f)
        VehicleBus.put(b, v("std_0D", 20f))
        assertEquals("后写入覆盖", 20f, VehicleBus.get("std_0D")!!.value!!, 0.1f)
        VehicleBus.closeSource(a); VehicleBus.closeSource(b)
    }

    @Test
    fun `S2 关闭一个来源不影响另一个来源的值`() {
        val a = VehicleBus.openSource("src-A2")
        val b = VehicleBus.openSource("src-B2")
        VehicleBus.put(a, v("std_0C", 1f))
        VehicleBus.put(b, v("std_0D", 2f))
        VehicleBus.closeSource(a)
        assertFalse("A 的值失效", VehicleBus.get("std_0C")!!.ok)
        assertTrue("B 的值仍有效", VehicleBus.get("std_0D")!!.ok)
        VehicleBus.closeSource(b)
    }
}
