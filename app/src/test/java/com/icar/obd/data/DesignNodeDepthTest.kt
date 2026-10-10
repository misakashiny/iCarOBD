package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **嵌套深度上限**的回归测试（v1.20.19）。
 *
 * ## 守的是什么
 *
 * [DesignNode.parse] 是**递归**的。工具侧（`tools/icarui/js/validate.js`）在 v2.83.0
 * 加了 `window.MAX_NODE_DEPTH = 32` 这道闸门，理由是：2 万层嵌套的 `group` 会把调用栈
 * 打爆（`RangeError: Maximum call stack size exceeded`），而那个异常冒到
 * `jsonEdited` 的 setTimeout 里**没人接** —— 用户看到的是"粘了一份文件，什么都没发生"。
 *
 * 当时 **App 侧是同一个递归结构、没有闸门** —— 同一份文件：工具里报一条看得懂的错误，
 * App 上直接崩。所以两侧必须**同一个数**，`tools/icarui/tests/verify-crosslang.js`
 * 会逐条比对这两个常量，改一边漏一边就红。
 *
 * ## 为什么既要"手工搭 JSONObject 树"又要"喂字符串"
 *
 * `DesignFile.parse(text)` 里 `JSONObject(text)` 那一句**被 `runCatching` 包着**：
 * 太深的文本会让 JSON 解析器自己抛 `StackOverflowError`，然后被吞成一条
 * "JSON 语法错误" —— 也就是说**光喂字符串，没有闸门也能"不崩"**。
 * 只测字符串的话，这组用例在没有闸门时照样绿，正是本项目最恨的
 * "看起来在守、其实没守"。
 *
 * 所以两条路都测，各守一件事：
 *  · `parse(root: JSONObject)` —— 公开重载、**没有那层 catch**，真正会走进
 *    [DesignNode.parse] 递归的那条路（[DesignPack] 也用 `JSONObject` 入口）。
 *    它负责**钉住闸门本身**：没闸门时这里会抛 StackOverflowError。
 *  · `parse(text)` —— 用户导入/粘贴一份文件的真实入口。它负责钉住
 *    "**真实路径不崩**"（崩不崩与 JSON 解析器自己的递归深度有关，
 *    所以这一条不断言错误文案是闸门那条）。
 */
class DesignNodeDepthTest {

    /**
     * 迭代构造一条 `depth` 层的 group 链，包成一份合法的 `icar.ui/2` 设计。
     *
     * ⚠️ **必须迭代构造**：用递归搭树的话，爆栈的是测试自己 ——
     * 那就成了"测试因为自己的原因红"，与产品代码无关，什么也证明不了。
     */
    private fun deepTree(depth: Int): JSONObject {
        var inner: JSONObject? = null
        for (level in depth - 1 downTo 0) {
            val o = JSONObject()
            o.put("type", "group")
            o.put("w", 60)
            o.put("h", 60)
            if (inner != null) o.put("children", JSONArray().put(inner))
            inner = o
        }
        val root = JSONObject()
        root.put("schema", "icar.ui/2")
        root.put("nodes", JSONArray().put(inner))
        return root
    }

    /** 同样深度的**文本**形态（走 `parse(text)` 那条真实导入路径） */
    private fun deepText(depth: Int): String {
        val sb = StringBuilder()
        sb.append("{\"schema\":\"icar.ui/2\",\"nodes\":[")
        repeat(depth) { sb.append("{\"type\":\"group\",\"w\":60,\"h\":60,\"children\":[") }
        sb.append("{\"type\":\"text\",\"w\":60,\"h\":60,\"text\":\"底\"}")
        repeat(depth) { sb.append("]}") }
        sb.append("]}")
        return sb.toString()
    }

    // ================================================================ 上限本身

    @Test
    fun `上限是 32，与工具侧同一个数`() {
        // 这个数字**必须与 tools/icarui/js/schema.js 的 window.MAX_NODE_DEPTH 相等**。
        // 单边改会让同一份文件在两边表现不同（一边友好报错、一边爆栈）——
        // verify-crosslang.js 里有一条断言把两个常量钉在一起。
        org.junit.Assert.assertEquals(32, DesignNode.MAX_NODE_DEPTH)
    }

    // ================================================================ 不误伤

    @Test
    fun `33 层以内照常解析 —— 上限不误伤正常设计`() {
        // 层级 0..32 = 33 层，最深的那层正好**等于**上限，必须放行。
        // 正常设计最多 4 层（页面 → 分组 → 卡片 → 文字），这个上限离它很远。
        val r = DesignFile.parse(deepTree(33))
        assertTrue("33 层（0..32）应当仍然合法，实际错误：${r.errors}", r.ok)
    }

    // ================================================================ 闸门

    @Test
    fun `34 层触发上限 —— 报友好错误而不是崩`() {
        // 第 33 层（0 起算）超限。工具侧是同一处判定：
        // `if ((depth || 0) > window.MAX_NODE_DEPTH)`。
        val r = DesignFile.parse(deepTree(34))
        assertFalse("超深必须被拒绝（不能当成正常设计画出来）", r.ok)
        assertTrue(
            "错误里必须说清是「嵌套深度超过 32 层」，实际：${r.errors}",
            r.errors.any { it.contains("嵌套深度超过 32 层") }
        )
    }

    @Test
    fun `20000 层嵌套 —— 不爆栈，只报一条看得懂的错误`() {
        // 这是工具侧实测过会 `RangeError` 的那个深度。
        // ⚠️ 走 `parse(root)`：这条路上没有 runCatching 兜底，
        //    没有闸门时这里抛的就是 StackOverflowError（= 用例红）。
        val r = DesignFile.parse(deepTree(20000))
        assertFalse("20000 层必须被拒绝", r.ok)
        assertTrue(
            "必须是深度错误，不能是别的：${r.errors}",
            r.errors.any { it.contains("嵌套深度超过 32 层") }
        )
        // 闸门一挡就回头，所以只该有一条 —— 报 20000 条错误本身就是新的失效
        org.junit.Assert.assertEquals(
            "超深只该报一条（报两万条 = 日志/UI 被刷爆）：${r.errors}", 1, r.errors.size
        )
    }

    @Test
    fun `20000 层的 JSON 文本不崩 —— 真实导入路径`() {
        // 用户导入一份文件走的就是 parse(text)。
        // 这里**不断言**错误文案：太深的文本可能在 JSON 解析器那一层就先爆栈，
        // 而那一层被 runCatching 兜着，于是报的是"JSON 语法错误"。
        // 这一条守的是**「不管哪一层挡住，用户都不会看到崩溃」**。
        val r = DesignFile.parse(deepText(20000))
        assertFalse("20000 层的文本必须被拒绝", r.ok)
        assertTrue("必须给出可读的错误，实际：${r.errors}", r.errors.isNotEmpty())
        assertTrue(
            "错误文案不能是空的/null：${r.errors}",
            r.errors.all { it.isNotBlank() }
        )
    }

    @Test
    fun `合法设计仍然解析成功 —— 闸门不能把正常文件也拦下`() {
        // 反向对照：一份 4 层（页面 → 分组 → 卡片 → 文字）的普通设计必须照常通过。
        // 没有这一条，"把闸门写成永远报错"也能让上面几条全绿。
        val json = """
            {
              "schema": "icar.ui/2",
              "nodes": [{
                "type": "group", "w": 360, "h": 360,
                "children": [{
                  "type": "group", "w": 180, "h": 180,
                  "children": [{
                    "type": "gauge", "pid": "obd.rpm", "x": 0, "y": 0, "w": 180, "h": 180,
                    "children": [{"type": "text", "w": 60, "h": 20, "text": "转速"}]
                  }]
                }]
              }]
            }
        """.trimIndent()
        val r = DesignFile.parse(json)
        assertTrue("正常 4 层设计必须通过，实际错误：${r.errors}", r.ok)
        org.junit.Assert.assertEquals(1, r.design!!.gauges.size)
    }
}
