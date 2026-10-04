package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 仪表的**子部件**（`parts`）。
 *
 * ## 为什么角度公式必须单独钉住
 *
 * `angleFor` 是"值 → 指针角度"的**唯一入口**，工具侧也有一份（`partAngle`）。
 * 两边一旦不一致，就会出现"电脑上指针指着 3000 转、设备上指着 2800"——
 * 用户只会觉得**数据不准**，而不会想到是布局换算的问题。
 */
class GaugePartsTest {

    private fun parse(parts: String) = DesignFile.parse(
        """
        {"schema":"icar.ui/2","canvas":{"unit":360},
         "assets":[{"id":"as1","name":"盘","kind":"dashboard","path":"assets/x.png","w":256,"h":256}],
         "nodes":[{"id":"g","type":"gauge","pid":"obd.rpm","style":0,"min":0,"max":8000,
                   "x":0,"y":0,"w":200,"h":200, "parts":$parts}]}
        """.trimIndent()
    )

    private fun gaugeOf(r: DesignFile.Result) =
        DesignNode.flatten(r.design!!.nodes).first { it.isGauge }

    // ================================================================ 角度

    @Test
    fun `指针角度 值等于下限时在起始角`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 135f, sweepTo = 405f)
        assertEquals(135f, p.angleFor(0f, 0f, 100f), 1e-3f)
    }

    @Test
    fun `指针角度 值等于上限时在结束角`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 135f, sweepTo = 405f)
        assertEquals(405f, p.angleFor(100f, 0f, 100f), 1e-3f)
    }

    @Test
    fun `指针角度 中点正好扫过一半`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 135f, sweepTo = 405f)
        assertEquals("135 + 270/2 = 270", 270f, p.angleFor(50f, 0f, 100f), 1e-3f)
    }

    @Test
    fun `超范围的值被夹住 —— 不会转过头`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 135f, sweepTo = 405f)
        assertEquals("超上限夹在结束角", 405f, p.angleFor(150f, 0f, 100f), 1e-3f)
        assertEquals("低于下限夹在起始角", 135f, p.angleFor(-50f, 0f, 100f), 1e-3f)
    }

    @Test
    fun `静态 rotation 叠加在扫描角上`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, rotation = 90f, sweepFrom = 135f, sweepTo = 405f)
        assertEquals("135 + 90", 225f, p.angleFor(0f, 0f, 100f), 1e-3f)
    }

    @Test
    fun `量程为 0 不产生 NaN`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 135f, sweepTo = 405f)
        val a = p.angleFor(50f, 50f, 50f)
        assertTrue("量程 0 时不能是 NaN（除零保护）", a.isFinite())
        assertEquals(135f, a, 1e-3f)
    }

    @Test
    fun `反向扫描也支持`() {
        val p = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 405f, sweepTo = 135f)
        assertEquals(405f, p.angleFor(0f, 0f, 100f), 1e-3f)
        assertEquals(135f, p.angleFor(100f, 0f, 100f), 1e-3f)
    }

    // ================================================================ 解析

    @Test
    fun `parts 被完整解析`() {
        val r = parse("""[
            {"kind":"dial","assetId":"as1","x":0,"y":0,"w":200,"h":200},
            {"kind":"needle","assetId":"as1","x":76,"y":4,"w":48,"h":192,
             "pivotX":0.5,"pivotY":0.9,"sweepFrom":135,"sweepTo":405},
            {"kind":"value","x":70,"y":80,"w":60,"h":40}
        ]""".trimIndent())
        assertTrue(r.errors.toString(), r.ok)
        val g = gaugeOf(r)
        assertEquals(3, g.parts!!.size)
        assertEquals(GaugePart.KIND_DIAL, g.parts!![0].kind)
        assertEquals(0.9f, g.parts!![1].pivotY, 1e-3f)
        assertEquals(GaugePart.KIND_VALUE, g.parts!![2].kind)
    }

    @Test
    fun `没有 parts 时是 null —— 走程序化画法`() {
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/2","canvas":{"unit":360},
             "nodes":[{"id":"g","type":"gauge","pid":"obd.rpm","style":0,"min":0,"max":8000,
                       "x":0,"y":0,"w":200,"h":200}]}
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        assertNull("没有 parts 必须是 null（存量设计行为不变）", gaugeOf(r).parts)
    }

    @Test
    fun `空 parts 数组也是 null`() {
        val r = parse("[]")
        assertTrue(r.errors.toString(), r.ok)
        assertNull(gaugeOf(r).parts)
    }

    @Test
    fun `未知部件种类回落到 decor 并给警告`() {
        val r = parse("""[{"kind":"视频","assetId":"as1"}]""")
        assertTrue(r.errors.toString(), r.ok)
        assertEquals(GaugePart.KIND_DECOR, gaugeOf(r).parts!![0].kind)
        assertTrue("应当有「不认识」的警告：" + r.warnings,
            r.warnings.any { it.contains("不认识") })
    }

    @Test
    fun `部件没选素材时给警告 —— 否则用户对着空白猜`() {
        val r = parse("""[{"kind":"dial"}]""")
        assertTrue("没素材不是硬错误（设计仍可用）", r.ok)
        assertTrue("应当有「没有选素材」的警告：" + r.warnings,
            r.warnings.any { it.contains("没有选素材") })
    }

    @Test
    fun `value 部件不需要素材 不给警告`() {
        val r = parse("""[{"kind":"value","x":0,"y":0,"w":60,"h":40}]""")
        assertTrue(r.errors.toString(), r.ok)
        assertTrue("数值部件不该因为没素材被警告：" + r.warnings,
            r.warnings.none { it.contains("没有选素材") })
    }

    @Test
    fun `引用不存在的素材时给警告`() {
        val r = parse("""[{"kind":"dial","assetId":"不存在的素材"}]""")
        assertTrue(r.errors.toString(), r.ok)
        assertTrue("应当提示素材不在清单里：" + r.warnings,
            r.warnings.any { it.contains("不在 assets 清单里") })
    }

    @Test
    fun `非法尺寸被夹住`() {
        val r = parse("""[{"kind":"dial","assetId":"as1","w":-5,"h":0,"alpha":999,"pivotX":9}]""")
        assertTrue(r.errors.toString(), r.ok)
        val p = gaugeOf(r).parts!![0]
        assertEquals("负宽度夹到 1", 1f, p.w, 1e-3f)
        assertEquals("零高度夹到 1", 1f, p.h, 1e-3f)
        assertEquals("透明度夹到 255", 255, p.alpha)
        assertEquals("pivot 夹到上限 2", 2f, p.pivotX, 1e-3f)
    }

    // ================================================================ 子部件嵌套（v2.18.0）

    @Test
    fun `子部件嵌套解析 —— 二层也能读到`() {
        val r = parse("""[
            {"kind":"needle","assetId":"as1","children":[
                {"kind":"decor","assetId":"as2","x":-10,"y":-10,"w":20,"h":20},
                {"kind":"decor","assetId":"as3","children":[{"kind":"decor","assetId":"as4"}]}
            ]}
        ]""".trimIndent())
        assertTrue(r.errors.toString(), r.ok)
        val p0 = gaugeOf(r).parts!![0]
        assertEquals(2, p0.children.size)
        assertEquals(1, p0.children[1].children.size)
        assertEquals(-10f, p0.children[0].x, 1e-3f)
        assertEquals("as4", p0.children[1].children[0].assetId)
    }

    @Test
    fun `没有 children 字段时是空表 —— 老文件行为不变`() {
        val r = parse("""[{"kind":"dial","assetId":"as1"}]""")
        assertTrue(r.errors.toString(), r.ok)
        assertTrue(gaugeOf(r).parts!![0].children.isEmpty())
    }

    @Test
    fun `超深嵌套被夹住 —— 不爆栈`() {
        // 手改文件写出 12 层深，解析不该崩（深度上限 5）
        val sb = StringBuilder()
        repeat(12) { sb.append("""{"kind":"decor","assetId":"as1","children":[""") }
        sb.append("""{"kind":"decor","assetId":"as1"}""")
        repeat(12) { sb.append("]}") }
        val r = parse("[$sb]")
        assertTrue("超深结构不该产生错误：${r.errors}", r.ok)
        // 数一下实际深度
        var d = 0
        var cur: GaugePart? = gaugeOf(r).parts!![0]
        while (cur != null && cur.children.isNotEmpty()) { d++; cur = cur.children[0] }
        assertTrue("深度应被夹到 <= 5，实际 $d", d <= 5)
    }

    // ================================================================ 多指针表（v2.17.0）

    @Test
    fun `指针可以各绑一个 PID`() {
        val r = parse("""[
            {"kind":"needle","assetId":"as1","rawPid":"obd.rpm"},
            {"kind":"needle","assetId":"as1","rawPid":"obd.speed"}
        ]""".trimIndent())
        assertTrue(r.errors.toString(), r.ok)
        val parts = gaugeOf(r).parts!!
        assertEquals("std_0C", parts[0].pid)
        assertEquals("std_0D", parts[1].pid)
    }

    @Test
    fun `没绑 PID 的指针回落成空 —— 用仪表自己的`() {
        val r = parse("""[{"kind":"needle","assetId":"as1"}]""")
        assertTrue(r.errors.toString(), r.ok)
        assertEquals("", gaugeOf(r).parts!![0].pid)
    }

    @Test
    fun `非指针部件不解析 PID —— 表盘绑 PID 没有意义`() {
        // 这条是实测抓到的：第一版 normalizePart / parseAll 没按 kind 判断，
        // 于是 dial 也能带 pid，序列化里每个部件都多两个字段。
        val r = parse("""[{"kind":"dial","assetId":"as1","rawPid":"obd.speed"}]""")
        assertTrue(r.errors.toString(), r.ok)
        assertEquals("表盘不该有 pid", "", gaugeOf(r).parts!![0].pid)
    }

    @Test
    fun `双针表的角度各自按自己的量程算`() {
        // 绑了 PID 就用**那个 PID 的量程** —— 否则车速（0~240）按转速（0~8000）
        // 的角度映射，指针几乎不动。
        val rpm = GaugePart(kind = GaugePart.KIND_NEEDLE, sweepFrom = 135f, sweepTo = 405f)
        val spd = GaugePart(kind = GaugePart.KIND_NEEDLE, pid = "std_0D",
            sweepFrom = 135f, sweepTo = 405f)
        val a1 = rpm.angleFor(4000f, 0f, 8000f)
        val a2 = spd.angleFor(120f, 0f, 260f)
        assertTrue("两个指针的角度应当不同（$a1 vs $a2）", Math.abs(a1 - a2) > 1f)
        assertEquals("转速 4000/8000 = 中点", 270f, a1, 1e-2f)
    }

    @Test
    fun `与工具侧常量一致 —— 5 种部件`() {
        assertEquals(5, GaugePart.KINDS.size)
        assertEquals(
            listOf("dial", "ticks", "needle", "value", "decor"),
            GaugePart.KINDS
        )
    }
}
