package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T-UI-EXPORT-02：App 导出设计文件的两条分支。
 *
 * ## 守的是什么
 *
 * 导出原来固定走 `DesignFile.toJson()` —— 那个序列化器**只写 v1 的 `gauges`**，
 * v2 的 `nodes` / `assets` / `parts` / `states` / 字体 / 旋转 / 图层全丢。
 * 于是"在电脑上设计 → 导入设备 → 回电脑继续改"这条闭环对 v2 设计是断的。
 *
 * 这组用例钉住两件事：
 *  1. 有 v2 原文时**原文直出**（而且真的含 `parts` 与 `anim`）
 *  2. 没有原文时**行为与改动前完全一致**（仍走 v1，不悄悄改变老画布的输出）
 */
class DesignExporterTest {

    /** 一份最小的合法 v2 设计，带子部件与装饰动画 */
    private val v2Design = """
        {
          "schema": "icar.ui/2",
          "meta": { "name": "导出测试" },
          "canvas": { "unit": 360, "designW": 2560, "designH": 1600, "scaleMode": 0 },
          "theme": "neon",
          "assets": [],
          "nodes": [
            {
              "id": "g1", "type": "gauge", "name": "转速",
              "x": 0, "y": 0, "w": 180, "h": 180,
              "pid": "obd.rpm", "style": 0, "min": 0, "max": 8000,
              "parts": [
                {
                  "kind": "decor", "x": 0, "y": 0, "w": 180, "h": 180,
                  "anim": { "kind": "spin", "periodMs": 6000, "phase": 0, "amplitude": 1 }
                },
                { "kind": "value", "x": 55, "y": 118, "w": 70, "h": 30 }
              ]
            }
          ]
        }
    """.trimIndent()

    /** v1 画布：用扁平的 gauges */
    private fun v1Design() = DesignFile(
        name = "v1 画布",
        gauges = listOf(GaugeItem(pidId = "std_0C", style = GaugeItem.STYLE_CIRCLE, minVal = 0f, maxVal = 8000f))
    )

    // ================================================================ 判据

    @Test fun `v2 原文被判定为可直出`() {
        assertTrue(DesignExporter.isReusableV2(v2Design))
    }

    @Test fun `空原文不可直出`() {
        assertFalse(DesignExporter.isReusableV2(""))
        assertFalse(DesignExporter.isReusableV2("   "))
    }

    @Test fun `v1 原文不可直出`() {
        val v1 = """{"schema":"icar.ui/1","gauges":[]}"""
        assertFalse("v1 必须走回落到 toJson 的老路径", DesignExporter.isReusableV2(v1))
    }

    @Test fun `坏 JSON 不可直出而且不抛`() {
        assertFalse(DesignExporter.isReusableV2("{ 这不是 json"))
        assertFalse(DesignExporter.isReusableV2("null"))
        assertFalse(DesignExporter.isReusableV2("[]"))
    }

    /**
     * **只在字段里出现 `icar.ui/2` 不算 v2**。
     *
     * 这条是防"用 `contains("icar.ui/2")` 判断"的偷懒写法 —— 那份原文的
     * 顶层 schema 其实是 v1，直出会让 App 读到一份自相矛盾的文件。
     */
    @Test fun `schema 不是 v2 时即使正文含该串也不直出`() {
        val tricky = """{"schema":"icar.ui/1","meta":{"name":"icar.ui/2"},"gauges":[]}"""
        assertFalse(DesignExporter.isReusableV2(tricky))
    }

    // ================================================================ 直出分支

    @Test fun `v2 画布导出的是原文本身`() {
        val out = DesignExporter.build(v2Design, v1Design())
        assertEquals("有 v2 原文时必须一字不改地直出", v2Design, out)
    }

    @Test fun `导出的 v2 文本保留 parts 与 anim`() {
        val out = DesignExporter.build(v2Design, v1Design())
        assertTrue("parts 不能丢（这正是本卡要修的问题）", out.contains("\"parts\""))
        assertTrue("anim 不能丢", out.contains("\"anim\""))
        assertTrue(out.contains("\"spin\""))
        assertTrue("periodMs 不能丢", out.contains("6000"))
    }

    /**
     * 原文直出必须**逐字节**可再解析回同样的节点数与部件数 ——
     * 光断言"字符串包含 parts"只能证明文本没丢，证明不了结构还对。
     */
    @Test fun `直出的文本能被重新解析且结构完整`() {
        val out = DesignExporter.build(v2Design, v1Design())
        val parsed = DesignFile.parse(out)
        assertTrue("导出的文件必须能解析（错误：${parsed.errors}）", parsed.errors.isEmpty())
        val nodes = parsed.design!!.nodes
        assertEquals("节点数", 1, nodes.size)
        val parts = nodes!!.first().parts
        assertEquals("部件数", 2, parts!!.size)
        val anim = parts[0].anim
        assertEquals("动画种类", PartAnim.KIND_SPIN, anim!!.kind)
        assertEquals("动画周期", 6000, anim.periodMs)
        assertEquals("第二个部件是 value", GaugePart.KIND_VALUE, parts[1].kind)
    }

    // ================================================================ 回落分支

    @Test fun `没有原文时走 v1 序列化且行为不变`() {
        val d = v1Design()
        val out = DesignExporter.build("", d)
        assertEquals("无原文必须与改动前完全一致", d.toJson().toString(2), out)
        assertTrue("v1 输出带 schema", out.contains("\"schema\""))
    }

    @Test fun `v1 原文时也走回落路径`() {
        val d = v1Design()
        val v1Raw = """{"schema":"icar.ui/1","gauges":[]}"""
        val out = DesignExporter.build(v1Raw, d)
        assertEquals(d.toJson().toString(2), out)
    }

    @Test fun `坏原文不会被直出而是安全回落`() {
        val d = v1Design()
        val out = DesignExporter.build("{ 坏 json", d)
        assertEquals("坏原文必须回落到 v1 序列化，不能把坏文本导出去", d.toJson().toString(2), out)
    }
}
