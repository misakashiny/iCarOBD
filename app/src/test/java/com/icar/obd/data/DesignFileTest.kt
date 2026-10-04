package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 设计文件解析与校验（v1.9.0）。
 *
 * 这个格式的**一半价值在校验**：手写 JSON 一定会写错，
 * 而"推到设备上发现没显示"是最低效的调试方式。
 * 所以这里重点测**错误信息是否可定位**，而不只是"能不能解析"。
 */
class DesignFileTest {

    private fun json(gauges: String, schema: String = "icar.ui/1", canvas: String = "\"unit\":360") = """
        {
          "schema": "$schema",
          "meta": {"name":"测试盘","author":"me"},
          "canvas": {$canvas},
          "gauges": [$gauges]
        }
    """.trimIndent()

    private val okGauge = """{"pid":"obd.rpm","style":0,"min":0,"max":8000,"x":0,"y":0,"w":180,"h":180}"""

    // ================================================================ 正常路径

    @Test
    fun `最小可用设计能解析`() {
        val r = DesignFile.parse(json(okGauge))
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        assertEquals("测试盘", d.name)
        assertEquals("me", d.author)
        assertEquals(1, d.gauges.size)
    }

    @Test
    fun `语义别名解析成真实 PID id`() {
        val d = DesignFile.parse(json(okGauge)).design!!
        assertEquals("std_0C", d.gauges[0].pidId)
    }

    @Test
    fun `直接写 PID id 也接受`() {
        val d = DesignFile.parse(json("""{"pid":"std_0D","x":0,"y":0,"w":180,"h":180}""")).design!!
        assertEquals("std_0D", d.gauges[0].pidId)
    }

    @Test
    fun `坐标原样保留 —— 不做任何换算`() {
        val d = DesignFile.parse(
            json("""{"pid":"obd.rpm","x":12.5,"y":34,"w":100,"h":50}""")
        ).design!!
        val g = d.gauges[0]
        assertEquals(12.5f, g.x, 1e-3f)
        assertEquals(34f, g.y, 1e-3f)
        assertEquals(100f, g.w, 1e-3f)
        assertEquals(50f, g.h, 1e-3f)
    }

    @Test
    fun `JSON 往返保留字段`() {
        val src = DesignFile(
            name = "n", author = "a", description = "d", themeId = "neon",
            gauges = listOf(GaugeItem(pidId = "std_0C", style = GaugeItem.STYLE_BAR, neonPreset = "强烈"))
        )
        val back = DesignFile.parse(src.toJson().toString()).design!!
        assertEquals("n", back.name)
        assertEquals("neon", back.themeId)
        assertEquals("std_0C", back.gauges[0].pidId)
        assertEquals(GaugeItem.STYLE_BAR, back.gauges[0].style)
        assertEquals("强烈", back.gauges[0].neonPreset)
    }

    // ================================================================ 硬错误

    @Test
    fun `JSON 语法错误给出可读提示`() {
        val r = DesignFile.parse("{ 这不是 JSON }")
        assertFalse(r.ok)
        assertTrue(r.errors[0], r.errors[0].contains("JSON 语法错误"))
    }

    @Test
    fun `缺少 schema 被拒绝`() {
        val r = DesignFile.parse("""{"gauges":[{"pid":"std_0C"}]}""")
        assertFalse(r.ok)
        assertTrue(r.errors[0], r.errors[0].contains("schema"))
    }

    @Test
    fun `不认识的 schema 被明确拒绝 —— 不能静默按旧规则画`() {
        // ⚠️ 这条原来拿 "icar.ui/2" 当反例。v2 现在是**受支持**的（节点树），
        // 所以反例换成一个真正不存在的版本 —— 否则这条测试会随格式演进而失效。
        val r = DesignFile.parse(json(okGauge, schema = "icar.ui/9"))
        assertFalse(r.ok)
        assertTrue(r.errors[0], r.errors[0].contains("不支持"))
    }

    @Test
    fun `v2 的节点树能被解析且仪表照常抽出来`() {
        // v2 是「节点树」，v1 是「扁平 gauges」。App 两个都认。
        // 这条钉住：v2 文件里 type=gauge 的节点，仪表字段要完整落到 gauges 上。
        val v2 = """
            {
              "schema": "icar.ui/2",
              "canvas": {"unit":360,"designW":2560,"designH":1600,"scaleMode":1},
              "nodes": [
                {
                  "id":"g1","type":"group","name":"转速组","x":0,"y":0,"w":200,"h":200,"z":1,
                  "children": [
                    {"id":"n1","type":"gauge","name":"转速","pid":"obd.rpm",
                     "style":0,"min":0,"max":8000,"warnHigh":6500,
                     "x":0,"y":0,"w":200,"h":200,"z":0,
                     "labelFont":{"family":"mono","size":12,"weight":700,"align":"center"}}
                  ]
                },
                {"id":"n2","type":"image","name":"底图","x":0,"y":0,"w":360,"h":360,"z":0,"alpha":128}
              ]
            }
        """.trimIndent()
        val r = DesignFile.parse(v2)
        assertTrue("v2 必须能被解析：${r.errors}", r.ok)
        val d = r.design!!
        assertEquals(2560, d.designW)
        assertEquals(1600, d.designH)
        assertEquals(DesignFile.SCALE_FIT, d.scaleMode)
        // 节点树完整（1 个分组 + 2 个根节点 = 3 个节点）
        assertEquals(3, DesignNode.flatten(d.nodes).size)
        // 仪表被抽出来（v1 兼容路径）
        assertEquals(1, d.gauges.size)
        assertEquals("std_0C", d.gauges[0].pidId)
        assertEquals(8000f, d.gauges[0].maxVal, 1e-3f)
        // 分组里的仪表坐标是**相对父节点**的，抽出来时保持原样（不做换算）
        assertEquals(0f, d.gauges[0].x, 1e-3f)
        // 字体读进来了
        val gn = DesignNode.flatten(d.nodes).first { it.isGauge }
        assertEquals(GaugeFont.FAMILY_MONO, gn.labelFont.family)
        assertEquals(12f, gn.labelFont.size, 1e-3f)
        assertEquals(700, gn.labelFont.weight)
        assertEquals(GaugeFont.ALIGN_CENTER, gn.labelFont.align)
        // 图片节点的 alpha 也读进来了
        val img = DesignNode.flatten(d.nodes).first { it.isImage }
        assertEquals(128, img.alpha)
    }

    @Test
    fun `v2 里未知节点类型被拒绝`() {
        val v2 = """{"schema":"icar.ui/2","canvas":{"unit":360},
            "nodes":[{"id":"x","type":"视频","x":0,"y":0,"w":10,"h":10}]}""".trimIndent()
        val r = DesignFile.parse(v2)
        assertFalse(r.ok)
        assertTrue(r.errors.toString(), r.errors.any { it.contains("type") })
    }

    @Test
    fun `v1 文件被升级成节点树 但 gauges 行为不变`() {
        // v1 → v2 是**恒等升级**：每个 gauge 变成一个根节点，坐标不动、顺序不动
        val r = DesignFile.parse(json(okGauge, schema = "icar.ui/1"))
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        assertEquals("v1 文件也应当有节点树", 1, d.nodes.size)
        assertTrue(d.nodes[0].isGauge)
        assertEquals("v1 升级后 gauges 照常可用", 1, d.gauges.size)
        assertEquals(d.nodes[0].gauge!!.pidId, d.gauges[0].pidId)
    }

    @Test
    fun `canvas unit 不对时报错并给出换算提示`() {
        val r = DesignFile.parse(json(okGauge, canvas = "\"unit\":1600"))
        assertFalse(r.ok)
        val e = r.errors.first { it.contains("unit") }
        assertTrue("错误信息应当告诉设计者怎么换算，实际：$e", e.contains("360"))
    }

    @Test
    fun `缺少 gauges 被拒绝`() {
        val r = DesignFile.parse("""{"schema":"icar.ui/1"}""")
        assertFalse(r.ok)
        assertTrue(r.errors[0], r.errors[0].contains("gauges"))
    }

    @Test
    fun `空的 gauges 被拒绝`() {
        val r = DesignFile.parse(json(""))
        assertFalse(r.ok)
        assertTrue(r.errors.any { it.contains("空") })
    }

    @Test
    fun `缺少 pid 被拒绝且提示两种写法`() {
        val r = DesignFile.parse(json("""{"x":0,"y":0,"w":180,"h":180}"""))
        assertFalse(r.ok)
        val e = r.errors.first { it.contains("pid") }
        assertTrue("应提示可以写语义名或 id，实际：$e", e.contains("obd.") && e.contains("std_"))
    }

    @Test
    fun `量程非法被拒绝`() {
        val r = DesignFile.parse(json("""{"pid":"obd.rpm","min":8000,"max":0,"x":0,"y":0,"w":180,"h":180}"""))
        assertFalse(r.ok)
        assertTrue(r.errors.any { it.contains("量程") })
    }

    @Test
    fun `仪表过多被拒绝`() {
        val many = (0 until 40).joinToString(",") { okGauge }
        val r = DesignFile.parse(json(many))
        assertFalse(r.ok)
        assertTrue(r.errors.any { it.contains("上限") })
    }

    // ================================================================ 软警告（能加载但有问题）

    @Test
    fun `超出画布只警告不拒绝`() {
        // 越界不会报错、只会"看不见那块表" —— 所以必须主动提示，
        // 但不该拦下整个设计（可能只是故意让它露一半）
        val r = DesignFile.parse(json("""{"pid":"obd.rpm","x":300,"y":0,"w":180,"h":180}"""))
        assertTrue("应当能加载", r.ok)
        assertTrue("但必须警告越界", r.warnings.any { it.contains("超出画布") })
    }

    @Test
    fun `坐标为负会警告`() {
        val r = DesignFile.parse(json("""{"pid":"obd.rpm","x":-10,"y":0,"w":180,"h":180}"""))
        assertTrue(r.ok)
        assertTrue(r.warnings.any { it.contains("负") })
    }

    @Test
    fun `尺寸过小会警告`() {
        val r = DesignFile.parse(json("""{"pid":"obd.rpm","x":0,"y":0,"w":3,"h":3}"""))
        assertTrue(r.ok)
        assertTrue(r.warnings.any { it.contains("过小") })
    }

    @Test
    fun `未知 pid 只警告 —— 可能是用户自定义 PID`() {
        val r = DesignFile.parse(json("""{"pid":"std_FF","x":0,"y":0,"w":180,"h":180}"""))
        assertTrue("不该拦下 —— 自定义 PID 是合法场景", r.ok)
        assertTrue(r.warnings.any { it.contains("不在内置 PID 库") })
    }

    @Test
    fun `没有 meta 只警告`() {
        val r = DesignFile.parse(
            """{"schema":"icar.ui/1","canvas":{"unit":360},
               "gauges":[{"pid":"std_0C","x":0,"y":0,"w":180,"h":180}]}"""
        )
        assertTrue(r.ok)
        assertTrue(r.warnings.any { it.contains("meta") })
    }

    // ================================================================ 别名表

    @Test
    fun `所有别名都指向真实存在的内置 PID`() {
        val known = BuiltInPids.all().map { it.id }.toSet()
        DesignFile.PID_ALIASES.forEach { (alias, id) ->
            assertTrue("别名 $alias → $id 不在内置 PID 库里", id in known)
        }
    }

    @Test
    fun `别名解析幂等`() {
        assertEquals("std_0C", DesignFile.resolvePid(DesignFile.resolvePid("obd.rpm")))
        assertEquals("自定义id", DesignFile.resolvePid("自定义id"))
    }

    @Test
    fun `别名表本身没有重复目标`() {
        val ids = DesignFile.PID_ALIASES.values.toList()
        assertEquals("两个别名不该指向同一个 PID（设计者会困惑）", ids.size, ids.toSet().size)
    }
}
