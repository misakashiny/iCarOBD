package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `LogViewText` 的单测（v1.20.17）。
 *
 * 规格 `docs/下一步-UI改进四项.md` §3 的文案原则：**空态要说清"为什么空 + 下一步做什么"**。
 * 日志页的"空"有三种完全不同的原因，用户的下一步动作完全不同 ——
 * 这一份把"哪种情形该说什么"钉住，免得以后改文案时又退化回"暂无数据"。
 */
class LogViewTextTest {

    // ------------------------------------------------------------ 统计行

    @Test
    fun `没有过滤器时统计行只有两个数字`() {
        assertEquals(
            "显示 128 条 · 缓冲 3000 条",
            LogViewText.statsLine(128, 3000, LogViewText.LEVEL_ALL, LogViewText.ALL)
        )
    }

    @Test
    fun `有过滤器时把过滤条件写在后面`() {
        // 两个数字不相等是常态（过滤器在起作用）—— 不写清条件，
        // 用户看到"显示 12 条"会以为日志丢了
        val s = LogViewText.statsLine(12, 3000, LogViewText.levelFilterText("W"), "OBD")
        assertTrue(s.startsWith("显示 12 条 · 缓冲 3000 条（"))
        assertTrue(s.contains("只显示 W 及以上（警告与错误）"))
        assertTrue(s.contains("只看 OBD 模块"))
    }

    @Test
    fun `只筛模块时不写级别`() {
        val s = LogViewText.statsLine(5, 100, LogViewText.levelFilterText("V"), "BLE")
        assertTrue(s.contains("只看 BLE 模块"))
        assertFalse(s.contains("只显示"))
    }

    // ------------------------------------------------------------ 级别描述

    @Test
    fun `级别描述说清是及以上，不是只等于`() {
        // ⚠️ 判据是 prio >= 选中级别：选 W 时 E 也会显示。
        // 下拉框只写一个字母的话，用户会奇怪"为什么选了 W 还有 E"
        assertTrue(LogViewText.levelFilterText("W").contains("及以上"))
        assertTrue(LogViewText.levelFilterText("W").contains("错误"))
        assertTrue(LogViewText.levelFilterText("E").contains("只有"))
        assertEquals(LogViewText.LEVEL_ALL, LogViewText.levelFilterText("全部"))
    }

    @Test
    fun `每个级别字母都有描述`() {
        listOf("V", "D", "I", "W", "E").forEach {
            assertTrue("级别 $it 没有描述", LogViewText.levelFilterText(it).isNotBlank())
        }
    }

    // ------------------------------------------------------------ 空态

    @Test
    fun `缓冲区空时说清日志什么时候才会有`() {
        val s = LogViewText.emptyHint(0, "V", LogViewText.ALL)
        assertTrue(s.contains("还没有日志"))
        // "下一步做什么"：告诉他日志是自然产生的，不用去找开关
        assertTrue(s.contains("App 一用就会写"))
        assertFalse(s.contains("暂无数据"))
    }

    @Test
    fun `被模块筛掉时点名是哪个模块在挡`() {
        val s = LogViewText.emptyHint(3000, "V", "OBD")
        assertTrue(s.contains("模块筛的是「OBD」"))
        assertTrue(s.contains("3000"))
        // "下一步做什么"：把两个下拉框调回全部
        assertTrue(s.contains("全部"))
    }

    @Test
    fun `被级别筛掉时点名是哪个级别在挡`() {
        val s = LogViewText.emptyHint(3000, "E", LogViewText.ALL)
        assertTrue(s.contains("级别筛的是「E 错误」"))
        assertTrue(s.contains("全部"))
    }

    @Test
    fun `两种过滤同时开着时先说是模块（模块更常见）`() {
        val s = LogViewText.emptyHint(10, "E", "SCAN")
        assertTrue(s.contains("SCAN"))
    }

    @Test
    fun `空态绝不出现暂无数据这种空话`() {
        // 规格 §3 的原话："不要只写暂无数据"
        listOf(
            LogViewText.emptyHint(0, "V", LogViewText.ALL),
            LogViewText.emptyHint(100, "V", "OBD"),
            LogViewText.emptyHint(100, "W", LogViewText.ALL),
        ).forEach {
            assertFalse(it, it.contains("暂无数据"))
            assertTrue(it, it.contains("\n"))  // 两行：为什么空 / 下一步
        }
    }
}
