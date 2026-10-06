package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `valueLabels`（数值 → 文字映射表，P9「非数值 PID 模型」方向 A）。
 *
 * 这一层的价值全在**边界**上：正常查表一眼就对，出问题的是
 * "差一格""空表当没设""旧文件读出来是空"这几类**不报错**的情况。
 */
class ValueLabelsTest {

    private val gears = listOf("P", "R", "N", "1", "2", "3", "4", "5", "6")

    // ---------------------------------------------------------------- 查表

    @Test
    fun `正常查表`() {
        assertEquals("P", ValueLabels.labelFor(gears, 0f))
        assertEquals("N", ValueLabels.labelFor(gears, 2f))
        assertEquals("6", ValueLabels.labelFor(gears, 8f))
    }

    @Test
    fun `没有映射表时返回 null 让调用方回落数字`() {
        assertNull(ValueLabels.labelFor(null, 3f))
        assertNull(ValueLabels.labelFor(emptyList(), 3f))
        // ⚠️ 全空串的表 = 用户清空了文本框 = 等于没设。
        // 不能返回 ""，否则读数变成一个空白 —— 那比显示数字更糟
        assertNull(ValueLabels.labelFor(listOf("", "", ""), 1f))
    }

    @Test
    fun `值是 null 或 NaN 时返回 null`() {
        assertNull(ValueLabels.labelFor(gears, null))
        assertNull(ValueLabels.labelFor(gears, Float.NaN))
    }

    /**
     * **这条是本模块最该守的用例。**
     *
     * `4.999` 是"第 5 挡"。用 `toInt()` 会截成 4 —— 指针已经指到第 5 挡的位置，
     * 读数却写 4。**两者都不报错**，只有盯着看才发现"差一格"。
     */
    @Test
    fun `用 round 而不是 toInt`() {
        // 索引对照：0=P 1=R 2=N 3="1" 4="2" 5="3" …
        assertEquals("2", ValueLabels.labelFor(gears, 4.4f))      // round=4 → 索引 4 = "2"
        // ↓ 这一条就是本用例的存在理由：round 给 5 → "3"，而 toInt() 会给 4 → "2"
        assertEquals("3", ValueLabels.labelFor(gears, 4.999f))
        assertEquals("3", ValueLabels.labelFor(gears, 4.5f))      // 半格向上（Java Math.round 语义）
        assertEquals("P", ValueLabels.labelFor(gears, -0.6f))     // round=-1 → 夹到 0
    }

    @Test
    fun `越界夹到两端而不是不显示`() {
        assertEquals("P", ValueLabels.labelFor(gears, -5f))
        assertEquals("6", ValueLabels.labelFor(gears, 99f))
    }

    @Test
    fun `单元素表对任何值都返回那一项`() {
        assertEquals("OK", ValueLabels.labelFor(listOf("OK"), 0f))
        assertEquals("OK", ValueLabels.labelFor(listOf("OK"), 7f))
    }

    // ---------------------------------------------------------------- 可用性

    @Test
    fun `isUsable 判据是至少一项非空`() {
        assertFalse(ValueLabels.isUsable(null))
        assertFalse(ValueLabels.isUsable(emptyList()))
        assertFalse(ValueLabels.isUsable(listOf("", "")))
        assertTrue(ValueLabels.isUsable(listOf("", "N")))
    }

    // ---------------------------------------------------------------- 解析

    @Test
    fun `解析数组并截断到上限`() {
        assertEquals(gears, ValueLabels.parse(JSONArray(gears)))
        assertTrue(ValueLabels.parse(null).isEmpty())
        assertTrue(ValueLabels.parse(JSONArray()).isEmpty())

        val huge = JSONArray()
        for (i in 0 until ValueLabels.MAX + 10) huge.put("v$i")
        assertEquals(ValueLabels.MAX, ValueLabels.parse(huge).size)
    }

    @Test
    fun `空表不写字段`() {
        assertNull(ValueLabels.toJson(null))
        assertNull(ValueLabels.toJson(emptyList()))
        assertNull(ValueLabels.toJson(listOf("", "")))
        assertEquals(3, ValueLabels.toJson(listOf("P", "R", "N"))!!.length())
    }

    // ---------------------------------------------------------------- 与 GaugeItem 的接线

    @Test
    fun `GaugeItem 往返保留映射表`() {
        val item = GaugeItem(pidId = "obd.gear", minVal = 0f, maxVal = 8f)
        item.valueLabels = gears.toMutableList()

        val back = GaugeItem.fromJson(item.toJson())
        assertEquals(gears, back.valueLabels)
    }

    /**
     * **旧文件兼容**：没有 `valueLabels` 字段时读出来是空表，
     * 而且回写时**不写这个字段** —— 否则旧版本 App 打开新文件会看到
     * 一个它不认识的字段（虽然现在不会报错，但没必要制造差异）。
     */
    @Test
    fun `旧文件没有该字段时读成空表且回写不写字段`() {
        val old = JSONObject()
            .put("pid", "std_0C").put("min", 0).put("max", 8000)
            .put("x", 0).put("y", 0).put("w", 120).put("h", 120)

        val item = GaugeItem.fromJson(old)
        assertTrue(item.valueLabels.isEmpty())
        assertFalse(item.toJson().has("valueLabels"))
    }

    /** 有映射表时才写字段，且能原样读回（含空串项 —— 空串是"这一格不显示名字"） */
    @Test
    fun `映射表带空串项也能往返`() {
        val item = GaugeItem(pidId = "obd.gear", minVal = 0f, maxVal = 8f)
        item.valueLabels = mutableListOf("P", "R", "", "1")

        val json = item.toJson()
        assertTrue(json.has("valueLabels"))
        assertEquals(listOf("P", "R", "", "1"), GaugeItem.fromJson(json).valueLabels)
    }
}
