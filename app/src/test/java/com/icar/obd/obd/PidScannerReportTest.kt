package com.icar.obd.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 扫描结果导出的**报告格式**。
 *
 * 为什么值得单独测：这份文本是要**交给别人（或下一个智能体）读**的 ——
 * 格式"看起来对"但缺了字段，等于**白导一次**（用户拿到文件还得回去重扫）。
 * 而且它以前根本没有（只能去「日志」页导整份日志），是新加的出口。
 */
class PidScannerReportTest {

    private fun hit(
        pid: String = "0C",
        dataHex: String = "1A F8",
        formula: String = "((A*256)+B)/4",
        preview: Float? = 1726f,
        learnedMin: Float? = null,
        learnedMax: Float? = null,
        raw: String = "41 0C 1A F8"
    ) = PidScanner.Hit(
        mode = "01", pid = pid, request = "01$pid",
        raw = raw, dataHex = dataHex,
        suggestedFormula = formula, previewValue = preview,
        learnedMin = learnedMin, learnedMax = learnedMax
    )

    private val cfg = PidScanner.Config(
        mode = "01", from = 0x00, to = 0x60,
        intervalMs = 150, timeoutMs = 1500, retry = 1,
        blacklist = setOf("01:02"), useSupportedBitmap = true,
        maxRequests = 400, learnSamples = 0
    )

    @Test
    fun `报告带头部参数`() {
        val t = PidScanner.report(cfg, listOf(hit()), listOf("就绪"), "2026-10-06 01:00:00")
        assertTrue("要有标题", t.contains("PID 扫描结果"))
        assertTrue("要有时间", t.contains("时间: 2026-10-06 01:00:00"))
        assertTrue("要有模式", t.contains("模式: 01"))
        assertTrue("范围要按模式定宽度（01 是 2 位）", t.contains("范围: 00 ~ 60"))
        assertTrue("要有间隔", t.contains("间隔=150ms"))
        assertTrue("要有超时", t.contains("超时=1500ms"))
        assertTrue("要有黑名单", t.contains("黑名单: 01:02"))
        assertTrue("要有命中数", t.contains("命中: 1 条"))
    }

    @Test
    fun `每条命中都带齐可用字段`() {
        val t = PidScanner.report(cfg, listOf(hit()), emptyList(), "T")
        // 这几个字段是"拿去做下一步"的最低要求：少了哪个都得回去重扫
        assertTrue("PID", t.contains("Mode 01 PID 0C"))
        assertTrue("请求", t.contains("请求: 010C"))
        assertTrue("数据", t.contains("数据: 1A F8"))
        assertTrue("建议公式", t.contains("建议公式: ((A*256)+B)/4"))
        assertTrue("预览值", t.contains("预览值 1726.0"))
        assertTrue("原始响应", t.contains("原始: 41 0C 1A F8"))
    }

    @Test
    fun `学习量程只在有时才出现`() {
        val without = PidScanner.report(cfg, listOf(hit()), emptyList(), "T")
        assertFalse("没学就不要写这一行", without.contains("学习量程"))

        val with = PidScanner.report(
            cfg, listOf(hit(learnedMin = 0.8f, learnedMax = 4.2f)), emptyList(), "T"
        )
        assertTrue(with.contains("学习量程: 0.8 ~ 4.2"))
    }

    @Test
    fun `零命中也是一份完整报告`() {
        // 空结果同样要能导出 —— "扫了但没有"本身就是结论
        val t = PidScanner.report(cfg, emptyList(), listOf("开始扫描"), "T")
        assertTrue(t.contains("命中: 0 条"))
        assertTrue("界面日志要带上", t.contains("开始扫描"))
        assertTrue(t.contains("界面日志（1 条）"))
    }

    @Test
    fun `没有配置时不崩且不写模式行`() {
        val t = PidScanner.report(null, listOf(hit()), emptyList(), "T")
        assertFalse("没有 cfg 就不该编一个模式出来", t.contains("模式:"))
        assertTrue("但命中和标题照旧", t.contains("命中: 1 条"))
    }

    @Test
    fun `超长原始响应被截断`() {
        // 有的适配器会一次吐回一大串（多帧/重复帧），全写进去会把报告淹掉
        val long = "41 0C " + "AB ".repeat(200)
        val t = PidScanner.report(cfg, listOf(hit(raw = long)), emptyList(), "T")
        val rawLine = t.lines().first { it.trimStart().startsWith("原始:") }
        assertTrue("原始行要短于 140 字符（含前缀）：${rawLine.length}", rawLine.length < 140)
    }

    @Test
    fun `多条命中按顺序编号`() {
        val t = PidScanner.report(
            cfg, listOf(hit(pid = "0C"), hit(pid = "0D")), emptyList(), "T"
        )
        assertTrue(t.contains("[1] Mode 01 PID 0C"))
        assertTrue(t.contains("[2] Mode 01 PID 0D"))
    }

    @Test
    fun `模式 22 的范围用四位十六进制`() {
        // 01/09 是 2 位 PID，21/22/23 是 4 位 —— 宽度错了用户对不上扫描范围
        val c22 = cfg.copy(mode = "22", from = 0x1100, to = 0x11FF)
        val t = PidScanner.report(c22, emptyList(), emptyList(), "T")
        assertTrue(t.contains("范围: 1100 ~ 11FF"))
    }

    @Test
    fun `界面日志按行完整写出`() {
        val logs = listOf("第一行", "第二行", "第三行")
        val t = PidScanner.report(cfg, emptyList(), logs, "T")
        logs.forEach { assertTrue("缺了日志行：$it", t.contains(it)) }
        assertEquals(3, t.lines().count { it in logs })
    }

    /**
     * **位图链必须覆盖到 `01 C0`。**
     *
     * 这条是 v1.18.0 修的一个实质缺口：原来 `maxBlock = 0x60`，
     * 扫描器**永远枚举不到 A1~C0 段** —— 而**挡位 `01 A4`、总里程 `01 A6`
     * 恰好就在那一层**。用户拿着扫描器扫一辈子也发现不了它们。
     *
     * 教训来自一个独立验证过的马自达项目：它把挡位当成"只有 Mode 22 才有"，
     * 其实一直在标准空间的 `01 A4` 里。
     */
    @Test
    fun `位图链必须走到 01 C0 而不是停在 01 60`() {
        assertEquals("挡位 A4 / 总里程 A6 在 A1~C0 段", 0xC0, PidScanner.maxSupportBlock("01"))
        assertEquals("Mode 22 同样要能走到底", 0xC0, PidScanner.maxSupportBlock("22"))
        // Mode 09 的块语义不同（02/04/06/08…），维持原样
        assertEquals(0x40, PidScanner.maxSupportBlock("09"))
    }
    // ------------------------------------------------- 支持位图的位序（v1.18.7）

    /**
     * 位图块的第一位是 `block + 1`，不是 `block`。
     *
     * 用**实车抓到的真实字节**（2026-10-06 阿特兹 `01 00` 两个模块取并集），
     * 因为 off-by-one 这类错误"看起来完全正常"：它只会让扫描器去问
     * 每个被声明支持的前一个 PID，而那个 PID 往往**也**能答 ——
     * 既不报错也没有异常，只是**结果整体错位**。
     */
    @Test
    fun `位图块第一位对应 block 加一`() {
        val pids = PidScanner.decodeSupportBitmap(
            0x00, byteArrayOf(0xFE.toByte(), 0x3F.toByte(), 0xA8.toByte(), 0x13.toByte())
        )
        assertTrue("最高位必须映射到 01", pids.contains(0x01))
        assertFalse("绝不能映射出 00", pids.contains(0x00))
        // 0xA8 = b7,b5,b3 -> 11 / 13 / 15（而不是 10 / 12 / 14）
        assertTrue(pids.contains(0x11))
        assertTrue(pids.contains(0x13))
        assertTrue(pids.contains(0x15))
        // 0x3F 的 b0 就是 PID 0x10，所以 10 确实被声明（旧实现去问的却是 0F）
        assertTrue(pids.contains(0x10))
        assertFalse("08 没被声明（0xFE 的 b0 是 0）", pids.contains(0x08))
        assertFalse("12 没被声明（0xA8 的 b6 是 0）", pids.contains(0x12))
        // 0x13 = b4,b1,b0 -> 1C / 1F / 20
        assertTrue(pids.contains(0x1C))
        assertTrue(pids.contains(0x1F))
        assertTrue(pids.contains(0x20))
    }

    @Test
    fun `A0 块解出 A4 与 A6 挡位与总里程`() {
        // 实车 01 A0 两个模块取并集：14 00 00 00 -> 0x14 = b4,b2
        val pids = PidScanner.decodeSupportBitmap(
            0xA0, byteArrayOf(0x14.toByte(), 0x00.toByte(), 0x00.toByte(), 0x00.toByte())
        )
        assertEquals("车厂确实声明了 A4（挡位）与 A6（总里程）", setOf(0xA4, 0xA6), pids)
    }

}
