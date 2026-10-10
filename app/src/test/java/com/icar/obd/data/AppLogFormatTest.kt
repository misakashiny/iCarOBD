package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 日志行的**列对齐**（v1.20.18）。
 *
 * ## 为什么值得钉
 *
 * 日志是拿来**肉眼扫列**的：同一列上「时间戳 / 级别 / 正文」对齐时，
 * 一眼就能看出「这一片全是 E」「这一片都是 BLE」。原来模块列宽度在跳
 * （`UI` 2 位 vs `AUDIO` 5 位），每换一个模块，后面整行就横移 3 个字符，
 * 屏幕上一半的行是错位的 —— 越看越费劲。
 *
 * 这里钉的是**结构**而不是某一条具体文本：断言的是**列下标**，
 * 所以换时间戳、换时区、加模块都不会让它变成"过时的测试"。
 *
 * ⚠️ 时间戳用固定 `ts`，但**不断言它的字面值** —— `SimpleDateFormat` 走的是
 * 机器默认时区，写死时间字符串会让测试在别的机器上挂掉。
 */
class AppLogFormatTest {

    /** 固定时间戳：格式稳定，与机器时区无关的断言才成立 */
    private val ts = 1_700_000_000_000L

    private fun line(
        module: String,
        level: AppLog.Level = AppLog.Level.I,
        msg: String = "正文"
    ): String = AppLog.Entry(ts, module, level, msg).format()

    /**
     * 正文的起始下标：
     * `[` + 时间戳(12) + `]` + `[` + 模块(5) + `]` + `[` + 级别(1) + `]` + 空格
     */
    private val msgStart = 1 + 12 + 1 + 1 + AppLog.MODULE_WIDTH + 1 + 1 + 1 + 1 + 1

    @Test
    fun `时间戳与级别定长 模块列左对齐补到 5 位`() {
        val ui = line(AppLog.M_UI)
        val audio = line(AppLog.M_AUDIO)

        assertEquals("UI 要补到 5 位（左对齐）", "[UI   ]", ui.substring(14, 21))
        assertEquals("AUDIO 正好 5 位", "[AUDIO]", audio.substring(14, 21))

        assertEquals("时间戳恒为 12 位", 12, ui.substring(1, 13).length)
        assertTrue(
            "时间戳必须是 HH:mm:ss.SSS：'${ui.substring(1, 13)}'",
            Regex("""\d{2}:\d{2}:\d{2}\.\d{3}""").matches(ui.substring(1, 13))
        )
    }

    @Test
    fun `任意内置模块下正文起始列恒定`() {
        listOf(
            AppLog.M_UI, AppLog.M_BLE, AppLog.M_OBD, AppLog.M_SCAN,
            AppLog.M_RULE, AppLog.M_AUDIO, AppLog.M_SYS, AppLog.M_DATA
        ).forEach { m ->
            val l = line(m)
            assertEquals("模块 $m 的正文起始列", msgStart, l.indexOf("正文"))
            assertEquals("模块 $m 的行长", msgStart + 2, l.length)
        }
    }

    @Test
    fun `单字符到五字符的模块都落在同一列`() {
        listOf("A", "AB", "ABC", "ABCD", "ABCDE").forEach { m ->
            assertEquals("模块「$m」的正文起始列", msgStart, line(m).indexOf("正文"))
        }
    }

    @Test
    fun `五个级别下级别列与正文列都不动`() {
        AppLog.Level.entries.forEach { lv ->
            val l = line(AppLog.M_UI, lv)
            assertEquals("级别 ${lv.tag} 的起始列", 22, l.indexOf(lv.tag, 21))
            assertEquals("级别 ${lv.tag} 的正文起始列", msgStart, l.indexOf("正文"))
        }
    }

    @Test
    fun `extra 不影响正文起始列`() {
        val l = AppLog.Entry(ts, AppLog.M_UI, AppLog.Level.W, "正文", "附加").format()
        assertEquals(msgStart, l.indexOf("正文"))
        assertTrue("extra 仍以「 | 」接在末尾：$l", l.endsWith(" | 附加"))
    }

    @Test
    fun `超过 5 位的模块不截断 只影响这一行自己的对齐`() {
        val l = line("AUDIOX")
        assertTrue("模块名不能被格式吃掉：$l", l.contains("[AUDIOX]"))
        assertEquals("超宽模块必然右移一位", msgStart + 1, l.indexOf("正文"))
    }

    @Test
    fun `补位不进 equals 与 copy 语义`() {
        val a = AppLog.Entry(ts, AppLog.M_UI, AppLog.Level.I, "x")
        val b = AppLog.Entry(ts, AppLog.M_UI, AppLog.Level.I, "x")
        assertEquals("同内容必须相等（补位列是体属性，不进 equals）", a, b)
        assertEquals("copy 后仍要对齐", msgStart, a.copy().format().indexOf("x"))
    }
}
