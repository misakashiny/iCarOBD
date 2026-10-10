package com.icar.obd.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * **燃油两条 PID 的合并**（v1.20.13）—— 用户拍板「燃油可以合并」。
 *
 * ## 这一批守的是四条硬判据（任务里写死的）
 *
 * | 判据 | 对应用例 |
 * |---|---|
 * | 列表里只出现一条 | [filterForList 把 std_5E 收起来] |
 * | 数值语义不变（车支持 `01 5E` 就用它，不支持就算出来） | [calc_lh 是超集通道] + [合并只动显示层] |
 * | 平均油耗 / 续航仍正常 | [派生引用一个都没动] |
 * | 老配置的仪表不变空 | [被引用的 id 仍然能查到] + [编辑器里当前绑定的那条必须保留] |
 *
 * ## 为什么必须用单测钉住
 *
 * 合并的**实现方式**（"保留 id 只在列表里不显示"）本身没有编译期保证：
 * 谁把 `PidMerge.filterForList` 顺手用到 `Store.allPids()` 上（或写进 `ObdEngine`），
 * 表现就是"`01 5E` 再也不轮询了"—— 而那时 `calc_lh` 由 MAF 推算，
 * **数值看起来还是对的**，只有对比真实油耗才看得出来。这种错必须在这里拦住。
 */
class PidMergeTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("icarobd-pidmerge-test").toFile()
        AppLog.init(dir)
        Store.init(dir)
        Store.settings = Store.Settings()
        Store.customPids.clear()
        Store.enabledOverride.clear()
        Store.customGauges.clear()
        Store.rules.clear()
    }

    @After
    fun tearDown() {
        runCatching { AppLog.shutdown() }
        repeat(3) { attempt ->
            dir.walkBottomUp().forEach { runCatching { it.delete() } }
            if (!dir.exists()) return
            if (attempt < 2) Thread.sleep(50L * (attempt + 1))
        }
        if (dir.exists()) dir.deleteOnExit()
    }

    private fun pid(id: String): PidDefinition =
        BuiltInPids.all().firstOrNull { it.id == id } ?: error("内置表里没有 $id")

    // ================================================================ 关系（先读代码，不猜）

    /**
     * 这两条**不是**同一个东西：`std_5E` 是输入（Mode 01 `5E`），
     * `calc_lh` 是派生输出（`mode=CALC`）。同单位、同一个量，但数据来源不同 ——
     * 所以"删掉一条"是错的，只能"列表不重复显示"。
     */
    @Test
    fun `两条是输入与派生输出的关系`() {
        val raw = pid(PidMerge.FOLDED_ID)
        val calc = pid(PidMerge.KEEP_ID)
        assertEquals("01", raw.mode)
        assertEquals("5E", raw.pid)
        assertEquals("L/h", raw.unit)
        assertEquals("CALC", calc.mode)
        assertEquals("L/h", calc.unit)
        // 留下的是派生输出（超集），收起来的是输入
        assertEquals(PidMerge.KEEP_ID, calc.id)
        assertEquals(PidMerge.FOLDED_ID, raw.id)
        assertTrue("两条都必须是内置条目", raw.builtIn && calc.builtIn)
    }

    /**
     * `calc_lh` 是**超集通道**：`VehicleBus.Derived.computeAll` 里
     * `std_5E` 优先、MAF 兜底，两者都写进 `calc_lh`。
     *
     * 这条用例守的是"为什么留下的是它"—— 换掉 [PidMerge.KEEP_ID] 就会红。
     */
    @Test
    fun `calc_lh 是超集通道`() {
        assertEquals("calc_lh", PidMerge.KEEP_ID)
        assertEquals("std_5E", PidMerge.FOLDED_ID)
        // 车支持 01 5E → 取它（>0 时优先）
        com.icar.obd.obd.VehicleBus.clear()
        try {
            com.icar.obd.obd.VehicleBus.put(
                PidValue("std_5E", 7.5f, "T", System.currentTimeMillis(), true)
            )
            com.icar.obd.obd.VehicleBus.put(
                PidValue("std_10", 100f, "T", System.currentTimeMillis(), true)
            )
            val out = ArrayList<PidValue>()
            com.icar.obd.obd.VehicleBus.Derived.computeAll { out.add(it) }
            val lh = out.firstOrNull { it.pidId == "calc_lh" }
            assertNotNull("派生通道必须给出 calc_lh", lh)
            assertEquals("车支持 01 5E 时必须直接用它", 7.5f, lh!!.value, 1e-4f)

            // 车不支持 01 5E（没有值）→ 由 MAF 推算，calc_lh 仍然有值
            com.icar.obd.obd.VehicleBus.clear()
            com.icar.obd.obd.VehicleBus.put(
                PidValue("std_10", 100f, "T", System.currentTimeMillis(), true)
            )
            val out2 = ArrayList<PidValue>()
            com.icar.obd.obd.VehicleBus.Derived.computeAll { out2.add(it) }
            val lh2 = out2.firstOrNull { it.pidId == "calc_lh" }
            assertNotNull("不支持 01 5E 时也必须算出来（这就是留下 calc_lh 的理由）", lh2)
            assertTrue("MAF 推算值应当 > 0", lh2!!.value > 0f)
        } finally {
            com.icar.obd.obd.VehicleBus.clear()
        }
    }

    // ================================================================ 过滤

    @Test
    fun `filterForList 把 std_5E 收起来`() {
        val all = BuiltInPids.all()
        val shown = PidMerge.filterForList(all)
        assertEquals("只该少一条", all.size - 1, shown.size)
        assertFalse("列表里不该再有 std_5E", shown.any { it.id == PidMerge.FOLDED_ID })
        assertTrue("留下的是 calc_lh", shown.any { it.id == PidMerge.KEEP_ID })
        // 顺序不能乱（内置 → 派生 → 厂家模板 → 自定义）
        assertEquals(all.filter { it.id != PidMerge.FOLDED_ID }.map { it.id }, shown.map { it.id })
    }

    @Test
    fun `没有可折叠条目时原样返回同一个实例`() {
        // 不白拷一份 —— 这个函数在每次刷新列表时都会被调
        val list = listOf(pid("std_0C"), pid("std_0D"))
        assertSame(list, PidMerge.filterForList(list))
    }

    @Test
    fun `keep 里的 id 一律保留`() {
        val all = BuiltInPids.all()
        val shown = PidMerge.filterForList(all, setOf(PidMerge.FOLDED_ID))
        assertEquals("当前绑定的那条必须留着，否则编辑器会把它静默改成 0 号", all.size, shown.size)
        assertTrue(shown.any { it.id == PidMerge.FOLDED_ID })
    }

    /**
     * **最要命的一条**：编辑器（仪表 / 规则）里 `indexOfFirst` 找不到当前绑定的 id 时，
     * spinner 会停在 0 号（发动机转速），点一下「确定」就把它**静默改成转速表**。
     * 所以"当前绑定"必须传进 `keep`。
     */
    @Test
    fun `编辑器里当前绑定的 std_5E 不会被静默改成 0 号`() {
        val all = BuiltInPids.all()
        val filtered = PidMerge.filterForList(all, setOf("std_5E"))
        val idx = filtered.indexOfFirst { it.id == "std_5E" }
        assertTrue("必须找得到", idx >= 0)
        assertEquals("std_5E", filtered[idx].id)
        // 不传 keep 的话正是这个陷阱：
        val without = PidMerge.filterForList(all)
        assertEquals(-1, without.indexOfFirst { it.id == "std_5E" })
        assertEquals("std_0C", without[0].id)   // ← 0 号是发动机转速
    }

    // ================================================================ 引用完整性

    @Test
    fun `合并只动显示层：allPids 里两条都还在`() {
        // 这是"数值语义不变"的根：轮询 / 派生 / 模拟器读的都是 allPids()
        val ids = Store.allPids().map { it.id }
        assertTrue("std_5E 必须还在（否则 01 5E 不再轮询）", ids.contains("std_5E"))
        assertTrue("calc_lh 必须还在", ids.contains("calc_lh"))
    }

    @Test
    fun `被引用的 id 仍然能查到`() {
        // 老配置的仪表 / 规则绑着这两个 id 之一时，findPid 必须还找得到 ——
        // 否则仪表会变空、规则永远不成立
        assertNotNull(Store.findPid("std_5E"))
        assertNotNull(Store.findPid("calc_lh"))
        assertNotNull(BuiltInPids.all().firstOrNull { it.id == "std_5E" })
    }

    @Test
    fun `设计文件的两个别名都还能解析`() {
        // DesignFile 的别名表里 obd.fuel_rate → std_5E、calc.fuel_hourly → calc_lh
        // 两个都在用，所以两个 id 一个都不能删
        assertNotNull(Store.findPid("std_5E"))
        assertNotNull(Store.findPid("calc_lh"))
    }

    @Test
    fun `合并不会被当成重复去清掉`() {
        // PidDedup 刻意不判内置之间的重复；清理动作也只删自定义
        val dups = PidDedup.findDuplicates(Store.allPids())
        assertFalse(
            "内置条目一条都不该出现在可清理清单里",
            dups.any { it.pid.builtIn || it.shadowedBy.builtIn }
        )
        assertTrue(Store.cleanupDuplicatePids().isEmpty())
        assertNotNull(Store.findPid("std_5E"))
        assertNotNull(Store.findPid("calc_lh"))
    }

    @Test
    fun `平均油耗与续航读的还是 calc_lh`() {
        // 派生链：std_5E → calc_lh → calc_l100 / calc_avg_l100 → calc_range。
        // 这一条是**端到端**的：它同时钉住"合并没有换掉派生链的输入 id"
        // 与"平均油耗 / 续航仍正常"（任务里的第二条判据）。
        com.icar.obd.obd.VehicleBus.clear()
        com.icar.obd.obd.VehicleBus.Derived.resetTrip()
        try {
            Store.settings.tankCapacityL = 50f
            val now = System.currentTimeMillis()
            com.icar.obd.obd.VehicleBus.put(PidValue("std_0D", 100f, "T", now, true))
            com.icar.obd.obd.VehicleBus.put(PidValue("std_5E", 8f, "T", now, true))
            com.icar.obd.obd.VehicleBus.put(PidValue("std_2F", 50f, "T", now, true))
            // ⚠️ 必须把派生结果**写回总线** —— 引擎就是这么接的
            // （`ObdEngine` 传的是 `VehicleBus::put`），不写回的话
            // `integrateDistance` 读不到 `calc_lh`
            com.icar.obd.obd.VehicleBus.Derived.computeAll { com.icar.obd.obd.VehicleBus.put(it) }

            val lh = com.icar.obd.obd.VehicleBus.value("calc_lh")
            assertNotNull("派生通道必须给出 calc_lh", lh)
            assertEquals(8f, lh!!, 1e-3f)

            val l100 = com.icar.obd.obd.VehicleBus.value("calc_l100")
            assertNotNull("瞬时油耗必须还在算", l100)
            assertEquals(8f, l100!!, 1e-3f)   // 8 L/h @100km/h = 8 L/100km

            // 100 km/h 跑 60 秒 = 1.6667 km；8 L/h × 60s = 0.1333 L → 8 L/100km
            repeat(60) {
                com.icar.obd.obd.VehicleBus.Derived.integrateDistance(1f) {
                    com.icar.obd.obd.VehicleBus.put(it)
                }
            }
            val avg = com.icar.obd.obd.VehicleBus.value("calc_avg_l100")
            assertNotNull("平均油耗必须还在算", avg)
            assertEquals(8f, avg!!, 0.2f)

            // 续航 = 油量% × 油箱容量 ÷ 平均油耗 × 100 = 50% × 50L ÷ 8 × 100 = 312.5km
            com.icar.obd.obd.VehicleBus.Derived.computeAll { com.icar.obd.obd.VehicleBus.put(it) }
            val range = com.icar.obd.obd.VehicleBus.value("calc_range")
            assertNotNull("续航必须还在算", range)
            assertEquals(312.5f, range!!, 1f)
        } finally {
            com.icar.obd.obd.VehicleBus.clear()
            com.icar.obd.obd.VehicleBus.Derived.resetTrip()
            Store.settings.tankCapacityL = 50f
        }
    }

    // ================================================================ 文案

    @Test
    fun `说明文案是纯文本且说清了另一条去哪了`() {
        val note = PidMerge.mergeNote()
        assertFalse("TextView 不渲染 Markdown，星号会原样显示", note.contains("**"))
        assertTrue("要说清是哪一条被合并了", note.contains("5E"))
        assertFalse(note.isBlank())
        assertFalse(PidMerge.describe().contains("**"))
        assertTrue(PidMerge.describe().contains(PidMerge.FOLDED_ID))
        assertTrue(PidMerge.describe().contains(PidMerge.KEEP_ID))
    }

    @Test
    fun `isFolded 的边界`() {
        assertTrue(PidMerge.isFolded("std_5E"))
        assertFalse(PidMerge.isFolded("calc_lh"))
        assertFalse(PidMerge.isFolded("std_0C"))
        assertFalse(PidMerge.isFolded(null))
        assertFalse(PidMerge.isFolded(""))
    }
}
