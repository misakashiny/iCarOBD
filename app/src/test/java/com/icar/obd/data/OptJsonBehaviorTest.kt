package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * org.json 的 `opt*` 遇到错误类型时的**真实行为**（v2.35.0）。
 *
 * ## 为什么要单独测这个
 *
 * `GaugeTheme.fromJson` 用 `optInt` / `optDouble` 逐字段回退。写主题优先级的
 * 测试时有两条红了，我当时判断是「`optInt` 对字符串的行为与假设不符」，
 * 还把这个结论写进了 CHANGELOG。
 *
 * **那个判断是错的。** 后来量清楚才发现真正原因是**测试 JSON 的 `nodes` 是空的**，
 * `DesignFile.parse` 把它判为错误，于是 `design` 拿不到，**根本没进入被测代码**。
 *
 * 所以这里把 `opt*` 的行为逐条钉住，以后不用再猜。
 *
 * ## 实测结论（下表由下面的断言逐条守住）
 *
 * | 输入类型 | optInt | optDouble | optString | optBoolean |
 * |---|---|---|---|---|
 * | 数字 | 该数字 | 该数字 | 数字转的字符串 | 默认值 |
 * | 非数字字符串 | **默认值（不抛）** | **默认值** | 该字符串 | **默认值** |
 * | **数字字符串** | **解析成数字** | **解析成数字** | 该字符串 | 默认值 |
 * | 布尔 | 默认值 | 默认值 | "true"/"false" | 该布尔 |
 * | 对象 / 数组 / null / 缺失 | 默认值 | 默认值 | 默认值 | 默认值 |
 * | 浮点数 | **截断**（1.5 变 1） | 该浮点 | | |
 *
 * ## 两条容易踩的
 *
 * 1. **不会抛异常**。所以 `fromJson` 里那些 `optInt` 不需要 try/catch，
 *    坏字段**静默**变成默认值。这是好事（设计文件坏一个字段不会整体打不开），
 *    但也意味着**坏字段不会有任何提示**。
 * 2. **数字字符串会被解析**。手改设计文件时写 `"accent": "255"` 是**生效**的，
 *    而写 `"accent": "#FF0000"` 是**静默忽略**。两者看起来一样「不对」，行为却不同。
 *
 * 注意：这是**实测**，不是文档抄来的。换 API level 或换 JSON 实现时要重跑。
 */
class OptJsonBehaviorTest {

    private val j = JSONObject(
        """{"num":7,"str":"abc","numStr":"123","bool":true,"obj":{},"arr":[1],"nul":null,"float":1.5}"""
    )

    // ---------------------------------------------------------------- optInt
    @Test fun `optInt 数字 取该数字`() = assertEquals(7, j.optInt("num", -1))
    @Test fun `optInt 非数字字符串 取默认值且不抛`() = assertEquals(-1, j.optInt("str", -1))
    @Test fun `optInt 数字字符串 会解析`() = assertEquals(123, j.optInt("numStr", -1))
    @Test fun `optInt 布尔 取默认值`() = assertEquals(-1, j.optInt("bool", -1))
    @Test fun `optInt 对象 取默认值`() = assertEquals(-1, j.optInt("obj", -1))
    @Test fun `optInt 数组 取默认值`() = assertEquals(-1, j.optInt("arr", -1))
    @Test fun `optInt null 取默认值`() = assertEquals(-1, j.optInt("nul", -1))
    @Test fun `optInt 缺失 取默认值`() = assertEquals(-1, j.optInt("nope", -1))
    @Test fun `optInt 浮点 会截断`() = assertEquals(1, j.optInt("float", -1))

    // ---------------------------------------------------------------- optDouble
    @Test fun `optDouble 数字 取该数字`() = assertEquals(7.0, j.optDouble("num", -1.0), 1e-9)
    @Test fun `optDouble 非数字字符串 取默认值`() = assertEquals(-1.0, j.optDouble("str", -1.0), 1e-9)
    @Test fun `optDouble 数字字符串 会解析`() = assertEquals(123.0, j.optDouble("numStr", -1.0), 1e-9)
    @Test fun `optDouble 布尔 取默认值`() = assertEquals(-1.0, j.optDouble("bool", -1.0), 1e-9)
    @Test fun `optDouble 缺失 取默认值`() = assertEquals(-1.0, j.optDouble("nope", -1.0), 1e-9)

    // ---------------------------------------------------------------- optString / optBoolean
    @Test fun `optString 数字 转成字符串`() = assertEquals("7", j.optString("num", "D"))
    @Test fun `optString 缺失 取默认值`() = assertEquals("D", j.optString("nope", "D"))
    @Test fun `optBoolean 数字 取默认值`() = assertEquals(false, j.optBoolean("num", false))
    @Test fun `optBoolean 非布尔字符串 取默认值`() = assertEquals(false, j.optBoolean("str", false))
    @Test fun `optBoolean 布尔 取该布尔`() = assertEquals(true, j.optBoolean("bool", false))

    /**
     * **一堆坏字段也不会抛**，这是 `GaugeTheme.fromJson` 敢直接用 `opt*` 的前提。
     *
     * 也是「设计文件坏一个字段不会整体打不开」的原因。
     */
    @Test fun `一堆坏字段也不抛 fromJson 才敢直接用 opt`() {
        val bad = JSONObject("""{"background":"#FF0000","accent":"不是数字","track":{},"glow":"yes"}""")
        val t = com.icar.obd.ui.view.GaugeTheme.fromJson(bad)
        assertEquals(
            "坏的 background 应当静默退回内置霓虹的值",
            com.icar.obd.ui.view.GaugeTheme.of(com.icar.obd.ui.view.GaugeTheme.NEON).background,
            t.background
        )
    }
}
