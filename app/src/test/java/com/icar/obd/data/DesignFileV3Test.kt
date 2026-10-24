package com.icar.obd.data

import org.junit.Assert.*
import org.junit.Test

/**
 * P5B-M04 阶段 B：**`icar.ui/3` 解析与版本兼容**专项测试。
 *
 * ## 覆盖任务 §四 B1/B2/B3 的要求
 *
 * B1 格式规范：四基元的字段默认值、范围夹取、无效数据状态
 * B2 版本处理：v1/v2/v3 都能读；v2 不强制升 v3；v3 缺字段不丢失；未知 type 必须报错
 * B3 数据兼容：多页面、嵌套、PID 绑定、旧版本
 *
 * ## 判据原则
 *
 * 每条断言都打在**可观察的输出**上（design / errors / warnings / 字段值），
 * 不打在"调用了某个函数"上。
 */
class DesignFileV3Test {

    // ================================================================
    // 工具
    // ================================================================

    private fun v3(nodes: String, extra: String = "") = """
        {
          "schema": "icar.ui/3",
          "meta": { "name": "v3 测试" },
          "scaleMode": 0,
          "assets": [],$extra
          "pages": [ { "id": "p0", "name": "主页面", "nodes": [ $nodes ] } ]
        }
    """.trimIndent()

    private fun v2(nodes: String) = """
        {
          "schema": "icar.ui/2",
          "meta": { "name": "v2 测试" },
          "scaleMode": 0,
          "assets": [],
          "pages": [ { "id": "p0", "name": "主页面", "nodes": [ $nodes ] } ]
        }
    """.trimIndent()

    private fun v1() = """
        { "schema":"icar.ui/1", "meta":{"name":"v1"}, "gauges":[
          { "pid":"obd.rpm","style":0,"x":8,"y":8,"w":100,"h":80 }
        ] }
    """.trimIndent()

    private fun node(r: DesignFile.Result, i: Int = 0) = r.design!!.pages[0].nodes[i]

    // ================================================================
    // B2-1：三个版本都能读
    // ================================================================

    @Test
    fun `B2_v1 仍能读`() {
        val r = DesignFile.parse(v1())
        assertNotNull("v1 必须仍能读", r.design)
        assertTrue("v1 无错误（实际=${r.errors}）", r.errors.isEmpty())
        assertEquals(1, r.design!!.gauges.size)
    }

    @Test
    fun `B2_v2 仍能读且行为不变`() {
        val r = DesignFile.parse(v2("""{ "id":"g","type":"gauge","name":"表","x":8,"y":8,"w":100,"h":80,"pid":"obd.rpm" }"""))
        assertNotNull("v2 必须仍能读", r.design)
        assertTrue("v2 无错误（实际=${r.errors}）", r.errors.isEmpty())
        assertEquals("gauge", node(r).type)
        assertNull("v2 的 gauge 节点 prim 必须为 null（不引入 v3 字段）", node(r).prim)
    }

    @Test
    fun `B2_v3 能读且四种新节点都解析出来`() {
        val r = DesignFile.parse(v3("""
            { "id":"vt","type":"valueText","name":"数值","x":8,"y":8,"w":100,"h":40,"pid":"obd.speed" },
            { "id":"sh","type":"shape","name":"框","x":8,"y":60,"w":200,"h":60,"kind":"roundRect" },
            { "id":"sa","type":"segmentedArc","name":"环","x":8,"y":130,"w":130,"h":130,"pid":"obd.rpm" },
            { "id":"pp","type":"pathProgress","name":"曲线","x":150,"y":130,"w":200,"h":100,"pid":"obd.load",
              "points":[{"x":0,"y":1},{"x":0.5,"y":0.2},{"x":1,"y":0.1}] }
        """))
        assertNotNull("v3 必须能读（errors=${r.errors}）", r.design)
        assertTrue("v3 无错误", r.errors.isEmpty())
        val ns = r.design!!.pages[0].nodes
        assertEquals("4 个节点都在", 4, ns.size)
        listOf("valueText", "shape", "segmentedArc", "pathProgress").forEach { t ->
            assertTrue("包含 $t", ns.any { it.type == t })
        }
        ns.forEach { n ->
            assertNotNull("${n.type} 的 prim 不应为 null", n.prim)
        }
    }

    // ================================================================
    // B2-2：v2 里出现 v3 type 必须报错（不静默升级）
    // ================================================================

    @Test
    fun `B2_v2 主题里出现 v3 type 必须报错而不是静默接受`() {
        val r = DesignFile.parse(v2("""
            { "id":"k","type":"gauge","name":"表","x":8,"y":8,"w":100,"h":80,"pid":"obd.rpm" },
            { "id":"vt","type":"valueText","name":"数值","x":8,"y":100,"w":100,"h":40,"pid":"obd.speed" }
        """))
        println("v2+v3type errors=${r.errors}")
        assertTrue("必须报错（不能静默接受 v3 节点）", r.errors.isNotEmpty())
        assertTrue("错误应说明只有 v3 支持",
            r.errors.any { it.contains("valueText") && it.contains("icar.ui/3") })
    }

    // ================================================================
    // B1：四种节点的字段解析
    // ================================================================

    @Test
    fun `B1_valueText 默认值与范围夹取`() {
        val r = DesignFile.parse(v3("""
            { "id":"vt","type":"valueText","name":"数值","x":0,"y":0,"w":100,"h":40,"pid":"obd.speed",
              "decimals":99, "size":9999, "align":42 }
        """))
        assertNotNull(r.design)
        val p = node(r).prim!!
        assertEquals("decimals 夹到 3", 3, p.decimals)
        assertEquals("size 夹到 200", 200f, p.size, 0.01f)
        assertEquals("align 夹到 2", 2, p.align)
    }

    @Test
    fun `B1_valueText 阈值与颜色`() {
        val r = DesignFile.parse(v3("""
            { "id":"vt","type":"valueText","x":0,"y":0,"w":100,"h":40,"pid":"obd.coolant",
              "warnHigh":100, "criticalHigh":110,
              "color":"#112233", "warnColor":"#FFAA00", "criticalColor":"#FF0000" }
        """))
        val p = node(r).prim!!
        assertEquals(100f, p.warnHigh!!, 0.01f)
        assertEquals(110f, p.criticalHigh!!, 0.01f)
        assertEquals("color 解析", 0xFF112233.toInt(), p.color)
        assertEquals("warnColor 解析", 0xFFFFAA00.toInt(), p.warnColor)
    }

    @Test
    fun `B1_valueText 无阈值时 warnHigh 为 null`() {
        val r = DesignFile.parse(v3("""{ "id":"vt","type":"valueText","x":0,"y":0,"w":100,"h":40 }"""))
        val p = node(r).prim!!
        assertNull("没写 warnHigh → null（不是 0）", p.warnHigh)
        assertNull("没写 criticalHigh → null", p.criticalHigh)
    }

    @Test
    fun `B1_shape 六种 kind 与未知回落`() {
        for (k in ShapeKind.ALL) {
            val r = DesignFile.parse(v3("""{ "id":"s","type":"shape","x":0,"y":0,"w":100,"h":60,"kind":"$k" }"""))
            assertNotNull("kind=$k 应能解析", r.design)
            assertEquals("kind=$k 保留", k, node(r).prim!!.kind)
        }
        val bad = DesignFile.parse(v3("""{ "id":"s","type":"shape","x":0,"y":0,"w":100,"h":60,"kind":"hexagon" }"""))
        assertNotNull("未知 kind 不崩", bad.design)
        assertEquals("未知 kind 回落 rect", "rect", node(bad).prim!!.kind)
        assertTrue("未知 kind 应有 warning", bad.warnings.any { it.contains("hexagon") })
    }

    @Test
    fun `B1_shape 圆角超限被夹取`() {
        val r = DesignFile.parse(v3("""
            { "id":"s","type":"shape","x":0,"y":0,"w":100,"h":40,"kind":"roundRect","cornerRadius":999 }
        """))
        val p = node(r).prim!!
        assertEquals("圆角夹到短边一半(=20)", 20f, p.cornerRadius, 0.01f)
        assertTrue("应记录 warning", r.warnings.any { it.contains("cornerRadius") })
    }

    @Test
    fun `B1_segmentedArc 字段与量程校验`() {
        val r = DesignFile.parse(v3("""
            { "id":"sa","type":"segmentedArc","x":0,"y":0,"w":130,"h":130,"pid":"obd.rpm",
              "minVal":0,"maxVal":8000, "startAngle":135,"sweepAngle":270,
              "segmentCount":36,"gapAngle":1.6,"thickness":10 }
        """))
        val p = node(r).prim!!
        assertEquals(0f, p.minVal, 0.01f)
        assertEquals(8000f, p.maxVal, 0.01f)
        assertEquals(135f, p.startAngle, 0.01f)
        assertEquals(270f, p.sweepAngle, 0.01f)
        assertEquals(36, p.segmentCount)
        assertEquals(1.6f, p.gapAngle, 0.01f)
        assertEquals(10f, p.thickness, 0.01f)
    }

    @Test
    fun `B1_segmentedArc 量程非法必须报错`() {
        val r = DesignFile.parse(v3("""
            { "id":"sa","type":"segmentedArc","x":0,"y":0,"w":100,"h":100,"minVal":100,"maxVal":10 }
        """))
        assertTrue("量程 min>=max 必须报错", r.errors.isNotEmpty())
        assertTrue("错误说明量程", r.errors.any { it.contains("量程") })
    }

    @Test
    fun `B1_pathProgress 点数超上限必须拒绝而不是截断`() {
        val pts = (0 until 100).joinToString(",") { """{"x":${it / 100.0},"y":0.5}""" }
        val r = DesignFile.parse(v3("""
            { "id":"pp","type":"pathProgress","x":0,"y":0,"w":200,"h":100,"points":[$pts] }
        """))
        println("超上限 errors=${r.errors}")
        assertTrue("超过 64 点必须报错（不静默截断）", r.errors.isNotEmpty())
        assertTrue("错误说明上限", r.errors.any { it.contains("64") })
    }

    @Test
    fun `B1_pathProgress 无效控制点被滤掉`() {
        val r = DesignFile.parse(v3("""
            { "id":"pp","type":"pathProgress","x":0,"y":0,"w":200,"h":100,"points":[
              {"x":0,"y":1},{"x":0.5,"y":0.2},{"x":1,"y":0.1}
            ] }
        """))
        assertNotNull("应能解析（errors=${r.errors}）", r.design)
        val p = node(r).prim!!
        assertEquals("3 个点", 3, p.points.size)
        assertEquals(0f, p.points[0][0], 0.001f)
        assertEquals(1f, p.points[0][1], 0.001f)
    }

    @Test
    fun `B1_pathProgress 点数不足必须报错`() {
        val r = DesignFile.parse(v3("""
            { "id":"pp","type":"pathProgress","x":0,"y":0,"w":200,"h":100,"points":[{"x":0,"y":0}] }
        """))
        assertTrue("少于 2 点必须报错", r.errors.isNotEmpty())
    }

    // ================================================================
    // B3：多页面 / 嵌套 / PID 绑定
    // ================================================================

    @Test
    fun `B3_多页面里 v3 节点都能解析`() {
        val json = """
        {
          "schema": "icar.ui/3",
          "meta": { "name": "多页面 v3" },
          "pages": [
            { "id":"p0","name":"页1","nodes":[
              { "id":"a","type":"valueText","x":0,"y":0,"w":100,"h":40,"pid":"obd.rpm" } ] },
            { "id":"p1","name":"页2","nodes":[
              { "id":"b","type":"shape","x":0,"y":0,"w":100,"h":40,"kind":"circle" } ] }
          ]
        }
        """.trimIndent()
        val r = DesignFile.parse(json)
        assertNotNull("多页面 v3 应能解析（errors=${r.errors}）", r.design)
        assertEquals("2 页", 2, r.design!!.pages.size)
        assertEquals("valueText", r.design!!.pages[0].nodes[0].type)
        assertEquals("shape", r.design!!.pages[1].nodes[0].type)
    }

    @Test
    fun `B3_嵌套分组里的 v3 节点`() {
        val r = DesignFile.parse(v3("""
            { "id":"g","type":"group","name":"组","x":0,"y":0,"w":300,"h":300,"children":[
              { "id":"vt","type":"valueText","x":10,"y":10,"w":100,"h":40,"pid":"obd.rpm" },
              { "id":"sh","type":"shape","x":10,"y":60,"w":100,"h":40,"kind":"roundRect" }
            ] }
        """))
        assertNotNull("嵌套 v3 应能解析（errors=${r.errors}）", r.design)
        val g = node(r)
        assertEquals("group", g.type)
        assertEquals("2 个子节点", 2, g.children.size)
        assertEquals("valueText", g.children[0].type)
        assertEquals("shape", g.children[1].type)
        assertNotNull("子节点的 prim 也有值", g.children[0].prim)
    }

    @Test
    fun `B3_PID 别名被解析成 id`() {
        val r = DesignFile.parse(v3("""{ "id":"sa","type":"segmentedArc","x":0,"y":0,"w":100,"h":100,"pid":"obd.rpm" }"""))
        val p = node(r).prim!!
        assertTrue("obd.rpm 应被解析成内置 id（实际=${p.pid}）", p.pid.isNotEmpty())
        assertNotEquals("不应保留别名原样", "obd.rpm", p.pid)
    }

    // ================================================================
    // 隔离：v3 不改 v2 语义
    // ================================================================

    @Test
    fun `隔离_v2 的 TYPES 仍是 4 种`() {
        assertEquals("v1/v2 认的类型必须仍是 4 种", 4, DesignNode.TYPES_V2.size)
        assertEquals(
            listOf("gauge", "image", "text", "group"),
            DesignNode.TYPES_V2
        )
    }

    @Test
    fun `隔离_v3 专属类型恰好 4 种`() {
        assertEquals(4, DesignNode.TYPES_V3_ONLY.size)
        assertEquals(
            listOf("valueText", "shape", "segmentedArc", "pathProgress"),
            DesignNode.TYPES_V3_ONLY
        )
        DesignNode.TYPES_V3_ONLY.forEach {
            assertTrue("$it 应被识别为 v3 专属", DesignNode.isV3OnlyType(it))
        }
        DesignNode.TYPES_V2.forEach {
            assertFalse("$it 不应被识别为 v3 专属", DesignNode.isV3OnlyType(it))
        }
    }
}
