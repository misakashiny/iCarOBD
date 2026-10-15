package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `CanSnifferText` 的单测（v1.20.22）。
 *
 * 盯住两件事：
 * 1. **普通 TextView / 对话框正文里不再出现字面 Markdown 星号** ——
 *    Android 不解析 Markdown，`**未绑定**` 就是给用户看一串星号；
 * 2. **去掉星号时安全含义一个字都不能丢**：未绑定只显示原始 hex 不猜值、
 *    候选没经过验证、重复帧只计数、全部未通过则 PID 列表没有任何变化。
 *
 * ⚠️ 断言刻意写成 `contains` 而不是整串 `assertEquals`：文案允许继续润色，
 * 但**这几句关键含义和"不含星号"必须一直在**。反之，谁把星号加回来，
 * 第一个断言就会红。
 */
class CanSnifferTextTest {

    /** 所有本次触及的展示文案都不许含 Markdown 粗体标记 */
    private fun assertNoMarkdown(s: String, where: String) {
        assertFalse("$where 不应含字面 Markdown 星号：$s", s.contains("**"))
        assertFalse("$where 不应含单个星号：$s", s.contains("*"))
    }

    // ------------------------------------------------------- 状态行：空 / 未开始

    @Test
    fun `未开始且未勾轮换时说明重复帧只计数`() {
        val s = CanSnifferText.statusLine(CanSnifferText.Status(CanSnifferText.Phase.IDLE))
        assertNoMarkdown(s, "IDLE 状态行")
        assertTrue(s.startsWith("未开始。"))
        // 「重复帧只计数」是这一页的性能/语义前提，不能因为去星号被删掉
        assertTrue(s.contains("重复帧只计数"))
        assertTrue(s.contains("暂停轮询"))
    }

    @Test
    fun `常驻监听开着时说的是轮询让位而不是未开始`() {
        val s = CanSnifferText.statusLine(
            CanSnifferText.Status(CanSnifferText.Phase.IDLE, monitorRunning = true)
        )
        assertNoMarkdown(s, "IDLE + 常驻监听 状态行")
        assertTrue(s.startsWith(CanSnifferText.MONITOR_PAUSED_TEXT))
        assertTrue(s.contains("常驻监听在跑"))
    }

    @Test
    fun `勾了轮换但还没开始时报出轮换时长`() {
        val s = CanSnifferText.statusLine(
            CanSnifferText.Status(CanSnifferText.Phase.IDLE, rotateChecked = true)
        )
        assertNoMarkdown(s, "IDLE + 轮换 状态行")
        assertTrue(s.contains("分段轮换扫描：8 段"))
        assertTrue(s.contains("约 80 秒"))
        assertTrue(s.contains("ATCM700"))
    }

    // ------------------------------------------------- 状态行：监听中 / 结束 / 失败

    @Test
    fun `监听中按是否轮换给出两套帧计数`() {
        val plain = CanSnifferText.statusLine(
            CanSnifferText.Status(
                CanSnifferText.Phase.CAPTURING, elapsedMs = 4_200, frameCount = 137,
                idCount = 12, dropped = 0
            )
        )
        assertNoMarkdown(plain, "CAPTURING 状态行")
        assertEquals("监听中… 4s · 137 帧 / 12 个 ID", plain)

        val rotating = CanSnifferText.statusLine(
            CanSnifferText.Status(
                CanSnifferText.Phase.CAPTURING, elapsedMs = 4_200, frameCount = 137,
                idCount = 12, rotating = true
            )
        )
        assertNoMarkdown(rotating, "CAPTURING + 轮换 状态行")
        assertTrue(rotating.startsWith("轮换监听中… 4s · 137 帧（本段） / 12 个 ID（本段）"))
    }

    @Test
    fun `丢弃计数只在真丢了的时候出现`() {
        val none = CanSnifferText.statusLine(
            CanSnifferText.Status(CanSnifferText.Phase.CAPTURING, dropped = 0)
        )
        assertFalse(none.contains("已丢弃"))
        val some = CanSnifferText.statusLine(
            CanSnifferText.Status(CanSnifferText.Phase.CAPTURING, dropped = 9)
        )
        assertTrue(some.contains("原始流已丢弃 9 条"))
    }

    @Test
    fun `失败与准备阶段原样转述底层消息`() {
        val failed = CanSnifferText.statusLine(
            CanSnifferText.Status(CanSnifferText.Phase.FAILED, message = "适配器没有响应")
        )
        assertEquals("适配器没有响应", failed)
        val done = CanSnifferText.statusLine(
            CanSnifferText.Status(CanSnifferText.Phase.DONE, message = "探测结束。")
        )
        assertTrue(done.startsWith("探测结束。"))
        assertTrue(done.contains("对比上次采集"))
        assertNoMarkdown(done, "DONE 状态行")
    }

    // ------------------------------------------------------------- 解码汇总

    @Test
    fun `还没有结果时解码汇总整段不显示`() {
        assertEquals("", CanSnifferText.decodeSummary(idCount = 0, boundIdCount = 0))
    }

    @Test
    fun `一个都没绑定必须说清只显示原始 hex 且不猜值`() {
        val s = CanSnifferText.decodeSummary(idCount = 7, boundIdCount = 0)
        assertNoMarkdown(s, "解码汇总（未绑定）")
        assertTrue(s.contains("7 个 ID，尚未绑定监听型PID"))
        assertTrue(s.contains("只显示原始 hex"))
        assertTrue(s.contains("不猜值"))
    }

    @Test
    fun `已绑定时报出绑定个数并保留候选未验证的提醒`() {
        val s = CanSnifferText.decodeSummary(idCount = 9, boundIdCount = 3)
        assertNoMarkdown(s, "解码汇总（已绑定）")
        assertTrue(s.contains("9 个 ID，其中3 个已绑定监听型PID"))
        assertTrue(s.contains("显示解码值"))
        // 「候选」不是可信值：enabled=false 的条目必须继续被标成没经过验证
        assertTrue(s.contains("候选未启用"))
        assertTrue(s.contains("没经过验证"))
    }

    // --------------------------------------------------------- 导入结果对话框

    private fun pid(enabled: Boolean, id: String = "p1") =
        PidDefinition(id = id, name = "左转向灯", mode = "22", pid = "1234", formula = "A", enabled = enabled)

    private fun result(
        pids: List<PidDefinition> = emptyList(),
        problems: List<SignalTableCsv.Problem> = emptyList(),
        totalRows: Int = 0
    ) = SignalTableCsv.Result(pids = pids, problems = problems, totalRows = totalRows)

    @Test
    fun `全部未通过时明说 PID 列表没有任何变化`() {
        val s = CanSnifferText.importResult(
            "信号表.csv",
            result(
                totalRows = 2,
                problems = listOf(
                    SignalTableCsv.Problem(2, "起始位不是数字", hard = true),
                    SignalTableCsv.Problem(3, "单位为空", hard = false)
                )
            )
        )
        assertNoMarkdown(s, "导入结果（全失败）")
        assertTrue(s.contains("文件：信号表.csv"))
        assertTrue(s.contains("数据行 2 · 收下 0 · 硬错误 1 · 软警告 1"))
        assertTrue(s.contains("一条都没通过，PID 列表没有任何变化。"))
        assertTrue(s.contains("硬错误 · 这些行被拒绝（1）"))
        assertTrue(s.contains("第 2 行：起始位不是数字"))
        assertTrue(s.contains("软警告 · 已收下，请核对（1）"))
        // 没有收下任何条目时不该出现"已写入"的话
        assertFalse(s.contains("已写入 PID 列表"))
    }

    @Test
    fun `收下的全是候选时要明说未启用`() {
        val s = CanSnifferText.importResult(
            "信号表.csv",
            result(pids = listOf(pid(enabled = false)), totalRows = 1)
        )
        assertNoMarkdown(s, "导入结果（全候选）")
        assertTrue(s.contains("数据行 1 · 收下 1 · 硬错误 0 · 软警告 0"))
        assertTrue(s.contains("已写入 PID 列表（监听型）。"))
        assertTrue(s.contains("这些条目都是「候选」→ 「未启用」"))
        assertTrue(s.contains("要在「PID」页手动打开"))
        // 候选不是可信值：不能出现"就能取到值了"这种说法
        assertFalse(s.contains("就能取到值"))
    }

    @Test
    fun `有已确认条目时才说开常驻监听就能取到值`() {
        val s = CanSnifferText.importResult(
            "信号表.csv",
            result(pids = listOf(pid(enabled = true)), totalRows = 1)
        )
        assertNoMarkdown(s, "导入结果（已启用）")
        assertTrue(s.contains("「已确认」的条目已启用"))
        assertTrue(s.contains("就能取到值"))
        assertFalse(s.contains("未启用"))
    }

    @Test
    fun `超出上限的问题条目折叠成还有几条`() {
        val hard = (1..15).map { SignalTableCsv.Problem(it, "坏行$it", hard = true) }
        val s = CanSnifferText.importResult("大表.csv", result(totalRows = 15, problems = hard))
        assertNoMarkdown(s, "导入结果（问题超上限）")
        // 最多列 12 条硬错误，其余折成一行
        assertTrue(s.contains("第 12 行：坏行12"))
        assertFalse(s.contains("第 13 行：坏行13"))
        assertTrue(s.contains("… 还有 3 条"))
    }
}
