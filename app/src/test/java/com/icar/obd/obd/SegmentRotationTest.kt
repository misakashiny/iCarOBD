package com.icar.obd.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **分段轮换扫描**（v1.20.10，P12-S5）：段号计算 / 轮换状态机 / 合并语义。
 *
 * ## 为什么这一批用例是它唯一的守门人
 *
 * `CanSniffer` 是 `object` 且持有 `Handler(Looper.getMainLooper())`，
 * **在 JVM 里一碰就抛 `Stub!`** —— 轮换的判定逻辑写在里面就一条都测不到。
 * 所以判定全部抽进了 [SegmentRotation] 与 [SegmentRotation] 状态机，
 * 这里逐条压。与 `FrameRateGateTest` 是同一套理由。
 *
 * ## 三条最容易悄悄坏的
 *
 * 1. **段号差一**（`ATCF000` 到底是第 0 段还是全总线）——
 *    错的表现是"第 0 段 ID 特别多"，看起来像"0x0xx 段就是热闹"，很难怀疑到命令上；
 * 2. **循环边界**（最后一段的下一个）—— 错的表现是"最后一段只跑了 3 秒就结束了"；
 * 3. **段间边界的变化次数**（合并时少记一次）——
 *    错的表现是"按 changed 排序"那张表把跨段跳动的信号埋掉，
 *    而那**正是我们要找的东西**。
 */
class SegmentRotationTest {

    private fun frame(id: Int, vararg d: Int) = CanFrame.Frame(id, d.toList())

    /** 造一个"某 ID 出现 count 次、其中变了若干次"的聚合（直接喂给累加器，最接近真实） */
    private fun aggOf(vararg frames: CanFrame.Frame): CanFrame.Accumulator {
        val a = CanFrame.Accumulator()
        frames.forEachIndexed { i, f -> a.feed(f, 1000L + i * 100L) }
        return a
    }

    // ============================================================ 段与命令

    @Test
    fun `段数是 8、每段 10 秒、一轮 80 秒`() {
        assertEquals(8, SegmentRotation.SEGMENT_COUNT)
        assertEquals(10_000L, SegmentRotation.SEGMENT_MS)
        assertEquals(80_000L, SegmentRotation.ROUND_MS)
    }

    @Test
    fun `段号看 ATCF 的高三位：000 100 … 700`() {
        val expect = listOf("ATCF000", "ATCF100", "ATCF200", "ATCF300",
            "ATCF400", "ATCF500", "ATCF600", "ATCF700")
        expect.forEachIndexed { i, want ->
            assertEquals("第 $i 段的过滤命令", want, SegmentRotation.segmentFilter(i))
        }
    }

    @Test
    fun `每段的命令是掩码 + 过滤两条，缺一不可`() {
        for (seg in 0 until SegmentRotation.SEGMENT_COUNT) {
            val cmds = SegmentRotation.segmentCommands(seg)
            assertEquals("第 $seg 段应该是两条命令", 2, cmds.size)
            // ⚠️ 只发 ATCF 不发 ATCM：ATCF000 放行的是**整条总线**（不是第 0 段），
            //    帧数会虚高、ID 会混段，而日志上完全看不出来
            assertEquals("ATCM700", cmds[0])
            assertEquals(SegmentRotation.segmentFilter(seg), cmds[1])
        }
    }

    @Test
    fun `越界段号被夹住，不会生成畸形命令`() {
        assertEquals("ATCF000", SegmentRotation.segmentFilter(-1))
        assertEquals("ATCF700", SegmentRotation.segmentFilter(99))
        assertEquals("ATCM700", SegmentRotation.segmentCommands(-5)[0])
        assertEquals("ATCF700", SegmentRotation.segmentCommands(1000)[1])
    }

    @Test
    fun `每段覆盖 256 个 ID，且 8 段首尾相接铺满 0x000~0x7FF`() {
        assertEquals("0x000~0x0FF", SegmentRotation.segmentRange(0))
        assertEquals("0x700~0x7FF", SegmentRotation.segmentRange(7))
        for (seg in 0 until SegmentRotation.SEGMENT_COUNT) {
            val lo = seg shl 8
            val hi = lo + 0xFF
            assertEquals("0x%03X~0x%03X".format(lo, hi), SegmentRotation.segmentRange(seg))
            if (seg > 0) {
                // 上一段的末 +1 必须是这一段的首（中间不能有洞，也不能重叠）
                assertEquals(lo, ((seg - 1) shl 8) + 0x100)
            }
        }
    }

    @Test
    fun `段的短标签给人看得懂`() {
        assertEquals("第 1/8 段 0x000~0x0FF", SegmentRotation.label(0))
        assertEquals("第 8/8 段 0x700~0x7FF", SegmentRotation.label(7))
    }

    // ============================================================ 状态机

    @Test
    fun `时间落在哪一段就是哪一段`() {
        val r = RotationPlan()
        assertEquals(0, r.indexAt(0))
        assertEquals(0, r.indexAt(1))
        assertEquals(0, r.indexAt(9_999))
        assertEquals(1, r.indexAt(10_000))
        assertEquals(1, r.indexAt(19_999))
        assertEquals(7, r.indexAt(70_000))
        assertEquals(7, r.indexAt(79_999))
        // ⚠️ 一轮跑完之后**仍然是最后一段**（不是 0，也不是越界）——
        //    收尾日志要报"最后一段收到了多少帧"，那时 elapsed 已经超过 totalMs 了
        assertEquals(7, r.indexAt(80_000))
        assertEquals(7, r.indexAt(999_999))
        // 负的时间不该崩（时钟回拨 / 传错参数）
        assertEquals(0, r.indexAt(-1))
    }

    @Test
    fun `一轮跑完的判据`() {
        val r = RotationPlan()
        assertFalse(r.isDone(79_999))
        assertTrue(r.isDone(80_000))
        assertTrue(r.isDone(80_001))
        assertFalse(r.isDone(-1))
    }

    @Test
    fun `本段剩余与整轮剩余都是倒计时`() {
        val r = RotationPlan()
        val s0 = r.snapshot(3_000)
        assertEquals(0, s0.index)
        assertEquals(8, s0.count)
        assertEquals(7_000L, s0.remainingMs)
        assertEquals(77_000L, s0.totalRemainingMs)
        assertFalse(s0.done)

        // 段边界上：本段剩余 = 整整一段（不是 0）
        assertEquals(10_000L, r.snapshot(10_000).remainingMs)
        assertEquals(1, r.snapshot(10_000).index)

        // 跑完之后剩余都是 0，而且**不报负数**
        val end = r.snapshot(80_000)
        assertTrue(end.done)
        assertEquals(0L, end.remainingMs)
        assertEquals(0L, end.totalRemainingMs)
        assertEquals(7, end.index)

        // 负的时间按"刚开始"算（时钟回拨 / 传错参数时不该报负数、也不该说跑完了）
        val neg = r.snapshot(-1)
        assertFalse(neg.done)
        assertEquals(0, neg.index)
        assertEquals(10_000L, neg.remainingMs)
        assertEquals(80_000L, neg.totalRemainingMs)

        // 单调不增（界面上是个倒计时，中间跳回去会让人以为出错了）
        var last = Long.MAX_VALUE
        for (t in 0..80_000L step 500L) {
            val v = r.snapshot(t).totalRemainingMs
            assertTrue("t=$t 的整轮剩余涨了：$last -> $v", v <= last)
            last = v
        }
    }

    @Test
    fun `一轮要下发 8 次命令：从 0 到 7`() {
        val r = RotationPlan()
        val sent = ArrayList<Int>()
        var last = -1
        for (t in 0..80_000L step 500L) {
            r.segmentsToAdvance(t, last).forEach { sent.add(it); last = it }
        }
        assertEquals((0 until 8).toList(), sent)
    }

    @Test
    fun `被拖慢的一拍会把欠下的段补上，不跳段`() {
        val r = RotationPlan()
        // 上一拍在 5 秒（第 0 段），这一拍直接被拖到 35 秒（第 3 段）
        assertEquals(listOf(1, 2, 3), r.segmentsToAdvance(35_000, 0))
        // 从没发过命令（-1）→ 只补第 0 段
        assertEquals(listOf(0), r.segmentsToAdvance(0, -1))
        assertEquals(listOf(0), r.segmentsToAdvance(5_000, -1))
    }

    @Test
    fun `同一段里反复评估只下发一次`() {
        val r = RotationPlan()
        assertTrue(r.segmentsToAdvance(0, 0).isEmpty())
        assertTrue(r.segmentsToAdvance(9_999, 0).isEmpty())
        assertEquals(listOf(1), r.segmentsToAdvance(10_000, 0))
        assertTrue(r.segmentsToAdvance(19_999, 1).isEmpty())
    }

    @Test
    fun `一轮跑完后不再下发任何段`() {
        val r = RotationPlan()
        assertTrue(r.segmentsToAdvance(80_000, 7).isEmpty())
        assertTrue(r.segmentsToAdvance(999_999, 7).isEmpty())
        // 段号不会涨过最后一段
        assertEquals(listOf(7), r.segmentsToAdvance(999_999, 6))
    }

    @Test
    fun `段数与时长的构造参数可调（测试与小轮换用），非法值直接拒绝`() {
        val r = RotationPlan(count = 2, segmentMs = 1_000)
        assertEquals(2_000L, r.totalMs)
        assertEquals(0, r.indexAt(999))
        assertEquals(1, r.indexAt(1_000))
        assertEquals(listOf(1), r.segmentsToAdvance(1_000, 0))
        assertEquals("第 1/2 段", r.snapshot(0).segmentLabel())

        // 段数/时长必须 >= 1：0 段会让 indexAt 除零，负时长会让段号倒退
        assertThrows { RotationPlan(count = 0, segmentMs = 1_000) }
        assertThrows { RotationPlan(count = 8, segmentMs = 0) }
        assertThrows { RotationPlan(count = 8, segmentMs = -1) }
    }

    private fun assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (e: IllegalArgumentException) {
            return
        }
        throw AssertionError("期望抛 IllegalArgumentException，但没有")
    }

    // ============================================================ 合并

    @Test
    fun `合并把各段的 count 加起来，段内重复帧不算变化`() {
        // 段 0：ID 0x100 出现 3 次、值一直不变 → count=3 changed=1（第一帧算一次）
        val s0 = aggOf(frame(0x100, 1, 2), frame(0x100, 1, 2), frame(0x100, 1, 2))
        // 段 1：同一个 ID 出现 2 次、值也不变 → count=2 changed=1
        val s1 = aggOf(frame(0x100, 1, 2), frame(0x100, 1, 2))

        val merged = SegmentRotation.merge(
            listOf(0 to s0.aggregates(), 1 to s1.aggregates()),
            CanFrame.Accumulator()
        )
        val a = merged.aggregates().single()
        assertEquals(0x100, a.canId)
        assertEquals("count 必须是 3+2", 5, a.count)
        // 段间首尾同值 → **不额外算变化**。两段各 1 次（各自的第一帧）
        assertEquals(2, a.changed)
        assertEquals("01 02", a.lastData)
        assertEquals(2, a.maxDlc)
    }

    @Test
    fun `段间值不同时补记一次变化 —— 否则跨段跳动的信号会被埋掉`() {
        // 段 0 停在 01 00，段 1 从 02 00 开始 —— 这就是一次真实变化
        val s0 = aggOf(frame(0x09A, 1, 0), frame(0x09A, 1, 0))
        val s1 = aggOf(frame(0x09A, 2, 0), frame(0x09A, 2, 0))
        val merged = SegmentRotation.merge(
            listOf(0 to s0.aggregates(), 1 to s1.aggregates()),
            CanFrame.Accumulator()
        )
        val a = merged.aggregates().single()
        assertEquals(4, a.count)
        // 段0 第一帧 1 次 + 段1 第一帧 1 次（与段0 末值不同 → 边界也算）+ 段1 内 0 次
        assertEquals("段间边界必须补一次变化", 2, a.changed)
        assertEquals("02 00", a.lastData)
    }

    @Test
    fun `段内多次变化在合并后仍然数得出来`() {
        // 段 0：01 → 02 → 01（changed=3：第一帧 + 两次变化）
        val s0 = aggOf(frame(0x2C7, 1), frame(0x2C7, 2), frame(0x2C7, 1))
        val merged = SegmentRotation.merge(listOf(0 to s0.aggregates()), CanFrame.Accumulator())
        val a = merged.aggregates().single()
        assertEquals(3, a.count)
        assertEquals(3, a.changed)
        assertEquals("01", a.lastData)
        // 取值集合必须三种都在（`lastData` 只是最后一帧，看不出它跳过）
        assertEquals(setOf("01", "02"), a.values.toSet())
    }

    @Test
    fun `不同 ID 各归各的，不会串到一起`() {
        val s0 = aggOf(frame(0x100, 1), frame(0x200, 2))
        val s1 = aggOf(frame(0x100, 1), frame(0x700, 3))
        val merged = SegmentRotation.merge(
            listOf(0 to s0.aggregates(), 1 to s1.aggregates()),
            CanFrame.Accumulator()
        )
        val byId = merged.aggregates().associateBy { it.canId }
        assertEquals(3, byId.size)
        assertEquals(2, byId.getValue(0x100).count)
        assertEquals(1, byId.getValue(0x200).count)
        assertEquals(1, byId.getValue(0x700).count)
    }

    @Test
    fun `合并顺序按段号，传进来的顺序反了也不影响结果`() {
        val s0 = aggOf(frame(0x09A, 1, 0), frame(0x09A, 1, 0))
        val s1 = aggOf(frame(0x09A, 2, 0), frame(0x09A, 2, 0))
        // 故意倒着传
        val merged = SegmentRotation.merge(
            listOf(1 to s1.aggregates(), 0 to s0.aggregates()),
            CanFrame.Accumulator()
        )
        val a = merged.aggregates().single()
        assertEquals(4, a.count)
        assertEquals(2, a.changed)
        assertEquals("02 00", a.lastData)
    }

    @Test
    fun `空段不参与合并、也不会崩`() {
        val empty = CanFrame.Accumulator().aggregates()
        assertTrue(empty.isEmpty())
        val merged = SegmentRotation.merge(listOf(3 to empty), CanFrame.Accumulator())
        assertTrue(merged.aggregates().isEmpty())
        assertEquals(0, merged.frameCount())
        // 完全空的一轮
        assertTrue(SegmentRotation.merge(emptyList(), CanFrame.Accumulator()).aggregates().isEmpty())
    }

    @Test
    fun `合并结果能直接导出观察表（下游零改动）`() {
        val s0 = aggOf(frame(0x100, 1, 2), frame(0x100, 1, 3))
        val s1 = aggOf(frame(0x200, 9))
        val merged = SegmentRotation.merge(
            listOf(0 to s0.aggregates(), 1 to s1.aggregates()),
            CanFrame.Accumulator()
        )
        // 导出走的就是这两个入口 —— 轮换的结果不该需要另一套导出
        val csv = merged.aggregateCsv()
        assertTrue(csv.contains("报文ID(hex)"))
        assertTrue(csv.contains("100"))
        assertTrue(csv.contains("200"))
        assertEquals(3, merged.frameCount())
        // 原始帧流也照常可用（轮换结果与单次探测走同一条导出路径）
        assertTrue(merged.rawFrames().isNotEmpty())
    }

    @Test
    fun `合并结果是收尾时 acc 指向的那个累加器（下游零改动）`() {
        // 收尾时 `CanSniffer` 把 `acc` 指向合并结果，于是
        // `aggregates()` / `aggregateCsv()` / 「导出信号表模板」全都照旧能用
        val into = CanFrame.Accumulator()
        val s0 = aggOf(frame(0x100, 1), frame(0x100, 1))
        val s1 = aggOf(frame(0x200, 2), frame(0x100, 1))
        SegmentRotation.merge(listOf(0 to s0.aggregates(), 1 to s1.aggregates()), into)
        assertEquals(2, into.aggregates().size)
        assertEquals(4, into.frameCount())
        val byId = into.aggregates().associateBy { it.canId }
        assertEquals(3, byId.getValue(0x100).count)
        assertEquals(1, byId.getValue(0x200).count)
        // 导出入口也照旧（这就是"下游零改动"的意思）
        assertTrue(into.aggregateCsv().contains("报文ID(hex)"))
    }
}
