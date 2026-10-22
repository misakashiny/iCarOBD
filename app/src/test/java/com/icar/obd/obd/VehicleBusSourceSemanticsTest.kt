package com.icar.obd.obd

import com.icar.obd.data.PidValue
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * 数据来源归属语义（P5A-M02 阶段 B1）。
 *
 * ## 为什么要有这个类
 *
 * P5A-M01 用 `VehicleBus.put(v)`（无来源版本）注入模拟值。
 * 那个方法内部会 `currentOwners.remove(pidId)` —— 把该 PID 从「谁在采」表里摘掉。
 * 后果是**真实采集关闭时无法把它标记失效**，于是会留下一个「看起来是实时」的
 * 陈旧值。这正是 [VehicleBus] 注释里写的「被过期值骗」那类问题。
 *
 * 本类把这些语义逐条钉死，作为「模拟源必须走 `openSource` + `put(source,v)`」
 * 这个设计决定的证据。它不是推测，是跑出来的。
 */
class VehicleBusSourceSemanticsTest {

    private val PID = "std_0D"

    @Before
    fun reset() {
        VehicleBus.clear()
    }

    @After
    fun tearDown() {
        VehicleBus.clear()
    }

    private fun pv(id: String = PID, v: Float = 60f, ok: Boolean = true) =
        PidValue(id, v, "", System.currentTimeMillis(), ok, null, ttlMs = 0)

    // ============================================================ 归属语义

    @Test
    fun `put(source,v) 建立归属 关闭来源时值被标失效`() {
        val src = VehicleBus.openSource(Any())
        assertTrue(VehicleBus.put(src, pv(v = 60f)))
        assertEquals(60f, VehicleBus.value(PID))

        VehicleBus.closeSource(src)

        // 关键：值还在（历史/累计可留），但已不可用
        val after = VehicleBus.get(PID)
        assertNotNull("关闭来源后 PidValue 应保留（供 UI 判断原因）", after)
        assertFalse("关闭来源后必须 ok=false", after!!.ok)
        assertNull("value() 必须给 null，仪表才会显示 --", VehicleBus.value(PID))
        assertEquals("采集来源已停止", after.error)
    }

    @Test
    fun `put(v) 会摘掉归属 之后再关来源也失效不了`() {
        // 真实采集写入
        val real = VehicleBus.openSource("real")
        assertTrue(VehicleBus.put(real, pv(v = 60f)))
        assertEquals(60f, VehicleBus.value(PID))

        // 模拟值用无来源版本覆盖 —— 它会把 currentOwners 摘掉
        VehicleBus.put(pv(v = 99f))
        assertEquals(99f, VehicleBus.value(PID))

        // 现在关掉真实来源：因为归属已被摘掉，这里**不会**把值标失效
        VehicleBus.closeSource(real)

        val after = VehicleBus.get(PID)
        assertNotNull(after)
        assertTrue(
            "⚠️ 这是 put(v) 的已知副作用：值仍 ok=true，下游以为还在实时采样",
            after!!.ok
        )
        assertEquals(99f, VehicleBus.value(PID))
    }

    @Test
    fun `同一 owner 重复 openSource 会关闭旧来源`() {
        val owner = Any()
        val a = VehicleBus.openSource(owner)
        assertTrue(VehicleBus.put(a, pv(v = 10f)))

        val b = VehicleBus.openSource(owner)   // 旧来源被自动关闭
        assertFalse("旧来源应失效", VehicleBus.sourceActive(a))
        assertTrue("新来源应有效", VehicleBus.sourceActive(b))

        // 旧来源写不进去
        assertFalse(VehicleBus.put(a, pv(v = 20f)))
        // 新来源可以
        assertTrue(VehicleBus.put(b, pv(v = 30f)))
        assertEquals(30f, VehicleBus.value(PID))
    }

    @Test
    fun `已关闭的来源写入被拒绝`() {
        val src = VehicleBus.openSource(Any())
        VehicleBus.closeSource(src)
        assertFalse(VehicleBus.put(src, pv(v = 42f)))
        assertNull(VehicleBus.value(PID))
    }

    @Test
    fun `快速切换来源时旧来源的写入不会复活`() {
        val owner = Any()
        val s1 = VehicleBus.openSource(owner)
        VehicleBus.put(s1, pv(v = 11f))

        val s2 = VehicleBus.openSource(owner)   // s1 淘汰
        VehicleBus.put(s2, pv(v = 22f))

        // s1 的迟到写入必须被拒绝（epoch 检查）
        assertFalse(VehicleBus.put(s1, pv(v = 33f)))
        assertEquals("旧来源复活 = 数据闪烁", 22f, VehicleBus.value(PID))

        // s2 正常关闭后值失效
        VehicleBus.closeSource(s2)
        assertNull(VehicleBus.value(PID))
    }

    @Test
    fun `两个不同来源同时写同一 PID 后者归属后者`() {
        val a = VehicleBus.openSource("a")
        val b = VehicleBus.openSource("b")
        VehicleBus.put(a, pv(v = 50f))
        assertEquals(50f, VehicleBus.value(PID))
        VehicleBus.put(b, pv(v = 70f))
        assertEquals(70f, VehicleBus.value(PID))

        // 关闭 b（当前归属）→ 值失效
        VehicleBus.closeSource(b)
        assertNull("最后写入者关闭后应失效", VehicleBus.value(PID))

        // a 仍可写回
        assertTrue(VehicleBus.put(a, pv(v = 55f)))
        assertEquals(55f, VehicleBus.value(PID))
    }

    @Test
    fun `关闭非归属来源不影响当前值`() {
        val a = VehicleBus.openSource("a")
        val b = VehicleBus.openSource("b")
        VehicleBus.put(b, pv(v = 80f))

        VehicleBus.closeSource(a)          // a 从没写过这个 PID
        assertEquals("未写过的来源关闭不该动值", 80f, VehicleBus.value(PID))
        assertTrue(VehicleBus.get(PID)!!.ok)
    }

    // ============================================================ 失效语义

    @Test
    fun `关闭来源只失效它自己写过的 PID`() {
        val a = VehicleBus.openSource("a")
        val b = VehicleBus.openSource("b")
        VehicleBus.put(a, pv("std_0D", 60f))
        VehicleBus.put(b, pv("std_0C", 800f))

        VehicleBus.closeSource(a)

        assertNull("a 写过的应失效", VehicleBus.value("std_0D"))
        assertEquals("b 写过的不受影响", 800f, VehicleBus.value("std_0C"))
    }

    @Test
    fun `TTL 过期后 value 返回 null 但值仍可读到`() {
        val src = VehicleBus.openSource(Any())
        val old = PidValue(PID, 60f, "", System.currentTimeMillis() - 5000, true, null, ttlMs = 1000)
        VehicleBus.put(src, old)

        assertNull("超过 TTL 应视作过期", VehicleBus.value(PID))
        val g = VehicleBus.get(PID)
        assertNotNull(g)
        assertFalse(g!!.ok)
        assertTrue("错误信息应说明过期", g.error!!.contains("过期"))
    }

    @Test
    fun `ttlMs 为 0 表示不判过期`() {
        val src = VehicleBus.openSource(Any())
        val old = PidValue(PID, 60f, "", System.currentTimeMillis() - 60_000, true, null, ttlMs = 0)
        VehicleBus.put(src, old)
        assertEquals("ttlMs=0 时不做新鲜度判定", 60f, VehicleBus.value(PID))
    }

    @Test
    fun `ok=false 的值不写入历史`() {
        val src = VehicleBus.openSource(Any())
        VehicleBus.put(src, pv(v = 60f))
        VehicleBus.put(src, pv(v = 0f, ok = false))
        val h = VehicleBus.historyOf(PID)
        assertTrue("失败值不该进历史（线型图会被打断）", h.none { it == 0f })
    }

    // ============================================================ 并发

    @Test
    fun `重复 openSource 与 closeSource 不泄漏不崩溃`() {
        val owner = Any()
        repeat(200) {
            val s = VehicleBus.openSource(owner)
            VehicleBus.put(s, pv(v = it.toFloat()))
            VehicleBus.closeSource(s)
        }
        // 最后一次 close 之后应为失效
        assertNull(VehicleBus.value(PID))
    }

    @Test
    fun `多线程同时写不同 PID 不丢值`() {
        val src = VehicleBus.openSource(Any())
        val ids = (0 until 8).map { "t_$it" }
        val threads = ids.map { id ->
            Thread {
                repeat(200) { k -> VehicleBus.put(src, PidValue(id, k.toFloat(), "", System.currentTimeMillis(), true, null, 0)) }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        ids.forEach { id ->
            assertNotNull("$id 应有值", VehicleBus.value(id))
        }
        VehicleBus.closeSource(src)
    }
}
