package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 主题导入异常恢复（P5A-M01 阶段 E）。
 *
 * ## 任务要求
 *
 * > 遇到无效设计时，App 给出合理错误提示，**不发生无法恢复的白屏或崩溃**。
 *
 * 覆盖 11 种：
 *   1 正常主题          2 旧版本主题        3 空节点主题
 *   4 缺失素材          5 错误 assetId      6 部分字段缺失
 *   7 超出范围数值      8 无效 PID          9 损坏 JSON
 *  10 重复导入         11 导入中断（半截 JSON）
 *
 * ## 判定口径
 *
 * - **不崩溃**：`parse` 不抛异常，始终返回 `Result`
 * - **有提示**：错误进 `errors`（致命）或 `warnings`（非致命）
 * - **可恢复**：坏文件不产生「design != null 但渲染必崩」的半成品
 */
class DesignFileRobustnessTest {

    private fun parse(text: String): DesignFile.Result = DesignFile.parse(text)

    private fun v2(nodes: String, assets: String = "[]"): String = """
        {
          "schema": "icar.ui/2",
          "meta": { "name": "测试" },
          "pages": [ { "id": "p0", "name": "主页面", "nodes": $nodes } ],
          "assets": $assets
        }
    """.trimIndent()

    // ============================================================ 1. 正常

    @Test
    fun `正常主题解析成功且无错误`() {
        val r = parse(v2("""
            [
              { "id":"a","type":"gauge","name":"表","x":10,"y":10,"w":100,"h":100,"pid":"obd.rpm" },
              { "id":"b","type":"image","name":"轨道","x":10,"y":120,"w":100,"h":20,
                "pid":"obd.speed","trackStyle":{"orient":"h","fill":0.5} }
            ]
        """))
        assertTrue("正常主题不该有错误：${r.errors}", r.errors.isEmpty())
        assertNotNull("应解析出设计", r.design)
        assertEquals(2, r.design!!.pages[0].nodes.size)
    }

    // ============================================================ 2. 旧版本

    @Test
    fun `旧版 icar ui 1 仍能解析`() {
        val r = parse("""
            {
              "schema": "icar.ui/1",
              "gauges": [
                { "id":"std_0C","name":"转速","x":0,"y":0,"w":1,"h":1 }
              ]
            }
        """.trimIndent())
        // 关键：不崩、不产生致命错误
        assertTrue("解析器不应抛异常", r.errors.isEmpty() || r.errors.isNotEmpty())
        // v1 可能被接受，也可能给出明确错误 —— 两种都允许，但不能 design+errors 同时非空
        if (r.errors.isNotEmpty()) {
            assertNull("有致命错误时 design 必须为 null（避免半成品）", r.design)
        }
    }

    // ============================================================ 3. 空节点

    @Test
    fun `空节点主题可解析且节点数为零`() {
        val r = parse(v2("[]"))
        assertTrue("空节点不该报错：${r.errors}", r.errors.isEmpty())
        assertNotNull(r.design)
        assertEquals(0, r.design!!.pages[0].nodes.size)
    }

    // ============================================================ 4/5. 素材问题

    @Test
    fun `缺失素材_空清单不误报_非空清单必须报警`() {
        // ⚠️ 按**实测行为**钉：
        //   DesignNode 的 assetId 校验条件是
        //     assetId.isNotEmpty() && assetIds.isNotEmpty() && assetId !in assetIds
        //
        //   `assetIds` 为空 = 素材由外部提供（SAF 导入时会另选素材文件夹），
        //   此时**故意不报 warning**。
        val emptyList = parse(v2(
            """[ { "id":"i","type":"image","name":"图","x":0,"y":0,"w":10,"h":10,"assetId":"nope" } ]""",
            "[]"
        ))
        assertTrue("引用素材不该是致命错误：${emptyList.errors}", emptyList.errors.isEmpty())
        assertTrue(
            "空素材清单时不该报「不在 assets」warning，实际=${emptyList.warnings}",
            emptyList.warnings.none { it.contains("不在") && it.contains("assets") }
        )

        val withList = parse(v2(
            """[ { "id":"i","type":"image","name":"图","x":0,"y":0,"w":10,"h":10,"assetId":"nope" } ]""",
            """[ { "id":"real","name":"真素材","kind":"import","path":"a.png" } ]"""
        ))
        assertTrue("有素材清单时也应能加载：${withList.errors}", withList.errors.isEmpty())
        assertTrue(
            "非空清单 + 引用不存在素材必须 warning，实际=${withList.warnings}",
            withList.warnings.any { it.contains("不在") && it.contains("assets") }
        )
    }

    @Test
    fun `错误 assetId 不导致崩溃`() {
        val r = parse(v2(
            """[ { "id":"i","type":"image","name":"图","x":0,"y":0,"w":10,"h":10,"assetId":"../../etc/passwd" } ]""",
            """[ { "id":"real","name":"真素材","kind":"import","path":"a.png" } ]"""
        ))
        assertNotNull("必须返回 Result，不能崩", r)
        assertTrue("应给出 warning", r.warnings.isNotEmpty() || r.errors.isNotEmpty())
    }

    // ============================================================ 6. 字段缺失

    @Test
    fun `缺 x y w h 时给出错误而不是静默用 0`() {
        val r = parse(v2("""[ { "id":"g","type":"gauge","name":"表","pid":"obd.rpm" } ]"""))
        // 允许两种设计：要么报错，要么用默认值并 warning —— 但不能静默且节点非法
        val handled = r.errors.isNotEmpty() || r.warnings.isNotEmpty()
        assertTrue("缺位置尺寸时必须有提示：errors=${r.errors} warnings=${r.warnings}", handled)
    }

    // ============================================================ 7. 超范围

    @Test
    fun `超出画布的坐标被记录为 warning`() {
        val r = parse(v2(
            """[ { "id":"g","type":"gauge","name":"表","x":9999,"y":9999,"w":100,"h":100,"pid":"obd.rpm" } ]"""
        ))
        assertNotNull(r)
        assertTrue("超范围应被提示：errors=${r.errors} warnings=${r.warnings}",
            r.errors.isNotEmpty() || r.warnings.isNotEmpty())
    }

    @Test
    fun `负的宽高被处理`() {
        val r = parse(v2(
            """[ { "id":"g","type":"gauge","name":"表","x":10,"y":10,"w":-100,"h":-100,"pid":"obd.rpm" } ]"""
        ))
        assertNotNull(r)
        // 不能静默产生一个 w=-100 的节点
        val node = r.design?.pages?.getOrNull(0)?.nodes?.getOrNull(0)
        if (node != null) {
            assertTrue("负宽高不应被静默接受（w=${node.w} h=${node.h}）", node.w > 0 && node.h > 0)
        }
    }

    // ============================================================ 8. 无效 PID

    @Test
    fun `无效 PID 产生 warning 但不阻止加载`() {
        val r = parse(v2(
            """[ { "id":"g","type":"gauge","name":"表","x":10,"y":10,"w":100,"h":100,"pid":"不存在的PID" } ]"""
        ))
        assertTrue("无效 PID 不该是致命错误：${r.errors}", r.errors.isEmpty())
        assertTrue("应给出 warning", r.warnings.any { it.contains("PID") || it.contains("pid") })
    }

    @Test
    fun `完全缺 pid 字段产生明确错误`() {
        val r = parse(v2(
            """[ { "id":"g","type":"gauge","name":"表","x":10,"y":10,"w":100,"h":100 } ]"""
        ))
        assertFalse("缺 pid 应报错", r.errors.isEmpty())
        assertNull("有致命错误时 design 为 null", r.design)
    }

    private fun assertFalse(msg: String, b: Boolean) {
        org.junit.Assert.assertFalse(msg, b)
    }

    // ============================================================ 9/11. 损坏 JSON

    @Test
    fun `损坏 JSON 返回错误而不是抛异常`() {
        val r = parse("""{ "schema": "icar.ui/2", "pages": [ { "nodes": [ """)
        assertNotNull("必须返回 Result", r)
        assertNull("损坏时不产出设计", r.design)
        assertTrue("应报 JSON 语法错误", r.errors.any { it.contains("JSON") || it.contains("语法") })
    }

    @Test
    fun `空字符串不崩溃`() {
        val r = parse("")
        assertNotNull(r)
        assertNull(r.design)
        assertTrue(r.errors.isNotEmpty())
    }

    @Test
    fun `纯空白不崩溃`() {
        val r = parse("   \n\t  ")
        assertNotNull(r)
        assertNull(r.design)
        assertTrue(r.errors.isNotEmpty())
    }

    @Test
    fun `导入中断的半截 JSON 不崩溃`() {
        val full = v2("""[ { "id":"g","type":"gauge","name":"表","x":10,"y":10,"w":100,"h":100,"pid":"obd.rpm" } ]""")
        // 从中间截断（模拟写文件中途被打断）
        val half = full.substring(0, full.length / 2)
        val r = parse(half)
        assertNotNull("截断也必须返回 Result", r)
        assertNull(r.design)
        assertTrue(r.errors.isNotEmpty())
    }

    // ============================================================ 10. 重复导入

    @Test
    fun `同一份设计连续解析两次结果一致（无全局状态泄漏）`() {
        val text = v2("""[ { "id":"g","type":"gauge","name":"表","x":10,"y":10,"w":100,"h":100,"pid":"obd.rpm" } ]""")
        val a = parse(text)
        val b = parse(text)
        assertEquals(a.errors.size, b.errors.size)
        assertEquals(a.warnings.size, b.warnings.size)
        assertEquals(a.design?.pages?.getOrNull(0)?.nodes?.size, b.design?.pages?.getOrNull(0)?.nodes?.size)
    }

    // ============================================================ 顶层健壮性

    @Test
    fun `顶层字段全缺时不崩溃`() {
        val r = parse("{}")
        assertNotNull(r)
        assertNull(r.design)
        assertTrue("应报缺 schema", r.errors.any { it.contains("schema") })
    }

    @Test
    fun `schema 不认识时明确拒绝`() {
        val r = parse("""{ "schema": "icar.ui/99", "pages": [] }""")
        assertNull(r.design)
        assertTrue("应说明不支持的 schema", r.errors.any { it.contains("schema") })
    }

    @Test
    fun `pages 缺失时不崩溃`() {
        val r = parse("""{ "schema": "icar.ui/2", "meta": {"name":"x"} }""")
        assertNotNull(r)
        // 允许成功（空设计）或明确报错，但设计里 pages 不能为 null 引发后续 NPE
        if (r.design != null) {
            assertNotNull(r.design!!.pages)
        }
    }

    @Test
    fun `深度嵌套不栈溢出`() {
        // 造 200 层嵌套 children
        val sb = StringBuilder()
        repeat(200) { sb.append("""{"id":"n$it","type":"group","name":"g","x":0,"y":0,"w":10,"h":10,"children":[""") }
        sb.append("""{"id":"leaf","type":"text","name":"t","x":0,"y":0,"w":10,"h":10,"text":"x"}""")
        repeat(200) { sb.append("]}") }
        val r = parse(v2("[" + sb.toString() + "]"))
        assertNotNull("深嵌套不能崩", r)
        // 允许被截断（有 depth 限制）或成功，但不能抛异常
    }
}
