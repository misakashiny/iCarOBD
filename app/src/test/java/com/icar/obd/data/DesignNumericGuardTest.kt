package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **`parts` 条数上限** 与 **"非数字静默回落"要出声**（v1.20.20）。
 *
 * 这两件事都属于"畸形/手改文件"这一类 —— 它们的共同点是
 * **错了不会报错，只会静默地做错事**，所以必须专门钉住。
 */
class DesignNumericGuardTest {

    private fun v2(node: String) = """
        {"schema":"icar.ui/2","meta":{"name":"t"},"canvas":{"unit":360},"nodes":[$node]}
    """.trimIndent()

    private fun gaugeNode(extra: String) =
        """{"id":"n1","type":"gauge","pid":"obd.rpm","min":0,"max":8000,"x":0,"y":0,"w":180,"h":180$extra}"""

    /** 造一个 `parts` 数组，长度 [n]，每项都是合法部件 */
    private fun parts(n: Int): String =
        (0 until n).joinToString(",", prefix = "[", postfix = "]") {
            """{"kind":"decor","assetId":"a1","x":0,"y":0,"w":10,"h":10}"""
        }

    // ================================================================ parts 条数上限

    @Test
    fun `parts 正好等于上限时通过`() {
        val r = DesignFile.parse(v2(gaugeNode(""","parts":${parts(GaugePart.MAX_PARTS)}""")))
        assertTrue(r.errors.toString(), r.ok)
        val n = DesignNode.flatten(r.design!!.nodes).first { it.isGauge }
        assertEquals(GaugePart.MAX_PARTS, n.parts!!.size)
    }

    @Test
    fun `parts 超过上限被拒绝`() {
        val over = GaugePart.MAX_PARTS + 1
        val r = DesignFile.parse(v2(gaugeNode(""","parts":${parts(over)}""")))
        assertFalse("超过上限必须拒绝，不能静默截断", r.ok)
        val e = r.errors.first { it.contains("parts") }
        assertTrue("错误要说清是哪个字段、上限多少，实际：$e", e.contains("$over") && e.contains("${GaugePart.MAX_PARTS}"))
    }

    /**
     * **畸形文件不能靠 `parts` 把内存打爆**。
     *
     * `MAX_NODES` 数的是节点树的 `children` —— `flatten` 根本不看 `parts`。
     * 所以这条单独守着：一个 100 万项的 `parts` 数组必须被**拒绝**，
     * 而不是被安静地全部读进内存。
     *
     * 这条能跑完本身就是证据（闸门在遍历之前）。
     */
    @Test
    fun `超大 parts 数组被拒绝而不是被读进内存`() {
        val huge = 200_000
        val r = DesignFile.parse(v2(gaugeNode(""","parts":${parts(huge)}""")))
        assertFalse(r.ok)
        assertTrue(r.errors.any { it.contains("上限") })
    }

    /** 嵌套的 `children` 用同一个上限（工具侧原来只夹了嵌套这一层） */
    @Test
    fun `嵌套的部件 children 也受上限约束`() {
        val inner = (0 until GaugePart.MAX_PARTS + 5).joinToString(",", "[", "]") {
            """{"kind":"decor","assetId":"a1"}"""
        }
        val node = gaugeNode(""","parts":[{"kind":"needle","assetId":"a1","children":$inner}]""")
        val r = DesignFile.parse(v2(node))
        assertFalse(r.ok)
        assertTrue(r.errors.toString(), r.errors.any { it.contains("children") && it.contains("上限") })
    }

    // ================================================================ 非数字：警告，但不拒收

    @Test
    fun `坐标写了非数字 —— 给警告但不拒收`() {
        val r = DesignFile.parse(v2(gaugeNode("").replace(""""x":0""", """"x":"abc"""")))
        assertTrue("存量文件不能被拒收：${r.errors}", r.ok)
        val w = r.warnings.firstOrNull { it.contains("x") && it.contains("不是数字") }
        assertTrue("必须有一条指向 x 的警告，实际：${r.warnings}", w != null)
        // 数值行为完全不变：仍然回落到默认值 0
        assertEquals(0f, r.design!!.gauges[0].x, 1e-3f)
    }

    /**
     * **数字字符串不算非数字**。
     *
     * `OptJsonBehaviorTest` 实测过：`optDouble` 对 `"123"` 会**解析成 123**。
     * 所以警告它就成了假警报 —— 而假警报的代价是用户学会无视整个警告列表。
     */
    @Test
    fun `数字字符串不产生警告且照常生效`() {
        val r = DesignFile.parse(v2(gaugeNode("").replace(""""x":0""", """"x":"30"""")))
        assertTrue(r.errors.toString(), r.ok)
        assertFalse("数字字符串不该被警告：${r.warnings}", r.warnings.any { it.contains("不是数字") })
        assertEquals(30f, r.design!!.gauges[0].x, 1e-3f)
    }

    /** 布尔 / 对象这类"看着像值、其实不是数字"的也要出声 */
    @Test
    fun `布尔与对象也会被警告`() {
        val r = DesignFile.parse(v2(gaugeNode(""","rotation":true,"scale":{}""")))
        assertTrue(r.errors.toString(), r.ok)
        assertTrue(r.warnings.any { it.contains("rotation") && it.contains("不是数字") })
        assertTrue(r.warnings.any { it.contains("scale") && it.contains("不是数字") })
    }

    /** 缺字段 / null 都**不算**非数字（"没设"和"写错了"是两回事） */
    @Test
    fun `缺字段与 null 不产生警告`() {
        val r = DesignFile.parse(v2(gaugeNode(""","rotation":null""")))
        assertTrue(r.errors.toString(), r.ok)
        assertFalse("null 是'没设'，不是'写错了'：${r.warnings}", r.warnings.any { it.contains("不是数字") })
    }

    /** 仪表专属字段（量程等）同样要出声 */
    @Test
    fun `量程写了非数字也要出声`() {
        val r = DesignFile.parse(v2(gaugeNode("").replace(""""max":8000""", """"max":"八千"""")))
        // max 回落 100，min 是 0 → 量程合法，不该被拒收
        assertTrue(r.errors.toString(), r.ok)
        assertTrue(
            "必须有一条指向 max 的警告，实际：${r.warnings}",
            r.warnings.any { it.contains("max") && it.contains("不是数字") }
        )
    }

    /** 部件字段（pivot / sweep 等）也要出声 */
    @Test
    fun `部件里的非数字字段也要出声`() {
        val node = gaugeNode(""","parts":[{"kind":"needle","assetId":"a1","pivotX":"中间"}]""")
        val r = DesignFile.parse(v2(node))
        assertTrue(r.errors.toString(), r.ok)
        assertTrue(
            "必须有一条指向 parts[0].pivotX 的警告，实际：${r.warnings}",
            r.warnings.any { it.contains("parts[0].pivotX") && it.contains("不是数字") }
        )
    }

    // ================================================================ v1 / v2 一致

    /**
     * **同一条问题在 v1 与 v2 两条路上必须给出同一条警告。**
     *
     * 这是 v1.20.20 那个 `unit` 岔口的同族防线：只修一边 = 用户换个 schema
     * 就看不到那条提示了。`verify-crosslang.js` 钉的是"字段清单一致"，
     * 这条钉的是"清单真的被两条路都用上了"。
     */
    @Test
    fun `v1 与 v2 对同一个非数字字段给出同一条警告`() {
        val v1 = DesignFile.parse(
            """{"schema":"icar.ui/1","meta":{"name":"t"},"canvas":{"unit":360},
               "gauges":[{"pid":"obd.rpm","min":0,"max":8000,"x":0,"y":0,"w":180,"h":180,"style":"圆表"}]}"""
        )
        val v2 = DesignFile.parse(v2(gaugeNode(""","style":"圆表"""")))
        assertTrue(v1.errors.toString(), v1.ok)
        assertTrue(v2.errors.toString(), v2.ok)
        val w1 = v1.warnings.first { it.contains("style") && it.contains("不是数字") }
        val w2 = v2.warnings.first { it.contains("style") && it.contains("不是数字") }
        // 路径前缀不同（gauges[0] vs nodes[0]），但"问题描述"必须逐字一致
        assertEquals(w1.substringAfter("style"), w2.substringAfter("style"))
    }

    // ================================================================ 字段清单本身

    /**
     * 清单不能是空的 —— 空的清单会让上面所有断言**静默通过**。
     *
     * 这正是本仓库最恨的失效形态：改了名字之后"测试还是绿的"。
     */
    @Test
    fun `三张数值字段清单都非空且无重复`() {
        listOf(
            "NUMERIC_NODE_FIELDS" to DesignNode.NUMERIC_NODE_FIELDS,
            "NUMERIC_PART_FIELDS" to DesignNode.NUMERIC_PART_FIELDS,
            "NUMERIC_GAUGE_FIELDS" to DesignNode.NUMERIC_GAUGE_FIELDS
        ).forEach { (name, list) ->
            assertTrue("$name 不该是空的", list.isNotEmpty())
            assertEquals("$name 不该有重复项", list.size, list.toSet().size)
        }
    }

    /** 清单里的字段确实都是"写了非数字会回落"的字段（抽查几个关键位） */
    @Test
    fun `关键字段都在清单里`() {
        listOf("x", "y", "w", "h").forEach {
            assertTrue("节点清单缺 $it", it in DesignNode.NUMERIC_NODE_FIELDS)
        }
        listOf("pivotX", "pivotY", "sweepFrom", "sweepTo").forEach {
            assertTrue("部件清单缺 $it", it in DesignNode.NUMERIC_PART_FIELDS)
        }
        listOf("min", "max", "style").forEach {
            assertTrue("仪表清单缺 $it", it in DesignNode.NUMERIC_GAUGE_FIELDS)
        }
    }

    /** `scalarText` 的渲染：字符串要带引号（否则看不出"写成了字符串"） */
    @Test
    fun `scalarText 把字符串加上引号`() {
        assertEquals("\"abc\"", DesignFile.scalarText("abc"))
        assertEquals("null", DesignFile.scalarText(null))
        assertEquals("true", DesignFile.scalarText(true))
        assertEquals("数组", DesignFile.scalarText(org.json.JSONArray("[1]")))
        assertEquals("对象", DesignFile.scalarText(JSONObject("{}")))
    }
}
