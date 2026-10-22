package com.icar.obd.ui.view

import com.icar.obd.data.DesignFile
import com.icar.obd.data.GaugePart
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 子部件（GaugeParts）数据绑定（P5A-M02 阶段 D）。
 *
 * ## 审计出来的两条硬约束（决定了测试怎么写）
 *
 * 1. `GaugePart.parseAll` **只在 `needle` / `value` 上解析 `pid`**，
 *    其它 kind 一律 `pid=""` —— 所以「带 PID 的子部件」只能是这两种。
 * 2. 子部件 `x/y` 相对**父部件的 pivot**，`children` 递归解析、深度上限 5。
 *
 * 本类的断言全部对着这两条，不凭空假设。
 */
class GaugePartsValueBindingTest {

    // ---------------------------------------------------------------- 构造

    private fun p(
        kind: String,
        pid: String = "",
        assetId: String = "a1",
        children: List<GaugePart> = emptyList(),
        rotation: Float = 0f,
        alpha: Int = 255,
        pivotX: Float = 0.5f,
        pivotY: Float = 0.5f
    ) = GaugePart(
        kind = kind, pid = pid, assetId = assetId,
        x = 0f, y = 0f, w = 100f, h = 100f,
        rotation = rotation, alpha = alpha,
        pivotX = pivotX, pivotY = pivotY,
        children = children
    )

    private fun parseParts(json: String): List<GaugePart>? {
        val root = JSONObject(
            """
            {
              "schema": "icar.ui/2",
              "pages": [ { "id":"p0","name":"主页面","nodes":[
                { "id":"g","type":"gauge","name":"表","x":10,"y":10,"w":100,"h":100,
                  "pid":"obd.rpm","parts": $json }
              ] } ],
              "assets": [ { "id":"a1","name":"x","kind":"custom","path":"a1.png" },
                          { "id":"a2","name":"y","kind":"custom","path":"a2.png" } ]
            }
            """.trimIndent()
        )
        val r = DesignFile.parse(root)
        return r.design?.pages?.getOrNull(0)?.nodes?.getOrNull(0)?.parts
    }

    // ============================================================ neededPids

    @Test
    fun `neededPids 含主 PID 与各部件自己的 PID`() {
        val v = GaugePartValues("std_0C", listOf(
            p(GaugePart.KIND_NEEDLE, pid = "std_0C"),
            p(GaugePart.KIND_NEEDLE, pid = "std_0D"),
            p(GaugePart.KIND_VALUE, pid = "std_05")
        ))
        assertEquals(setOf("std_0C", "std_0D", "std_05"), v.neededPids)
    }

    @Test
    fun `neededPids 递归含嵌套子部件的 PID`() {
        val nested = p(GaugePart.KIND_DECOR, children = listOf(
            p(GaugePart.KIND_NEEDLE, pid = "std_42")            // 第 2 层
        ))
        val v = GaugePartValues("std_0C", listOf(
            p(GaugePart.KIND_NEEDLE, pid = "std_0C", children = listOf(
                p(GaugePart.KIND_DECOR, children = listOf(
                    p(GaugePart.KIND_DECOR, children = listOf(
                        p(GaugePart.KIND_NEEDLE, pid = "std_11")  // 第 4 层
                    ))
                ))
            )),
            nested
        ))
        assertTrue("应含主 PID", v.neededPids.contains("std_0C"))
        assertTrue("应含第 2 层 PID", v.neededPids.contains("std_42"))
        assertTrue("应含第 4 层 PID", v.neededPids.contains("std_11"))
    }

    @Test
    fun `主 PID 为空时只收部件自己的 PID`() {
        val v = GaugePartValues("", listOf(p(GaugePart.KIND_NEEDLE, pid = "std_0D")))
        assertEquals(setOf("std_0D"), v.neededPids)
    }

    // ============================================================ valueOf

    @Test
    fun `valueOf 绑了 pid 就用它 没绑回落到主 PID`() {
        val needleA = p(GaugePart.KIND_NEEDLE, pid = "std_0C")
        val needleB = p(GaugePart.KIND_NEEDLE, pid = "std_0D")
        val plain = p(GaugePart.KIND_NEEDLE, pid = "")
        val v = GaugePartValues("std_0C", listOf(needleA, needleB, plain))
        v.replace(mapOf("std_0C" to 1234f, "std_0D" to 88f))

        assertEquals(1234f, v.valueOf(needleA)!!, 0.01f)
        assertEquals("子部件独立 PID 应取自己的值", 88f, v.valueOf(needleB)!!, 0.01f)
        assertEquals("没绑 pid 应回落主 PID", 1234f, v.valueOf(plain)!!, 0.01f)
    }

    @Test
    fun `replace 只保留 neededPids 里的值`() {
        val v = GaugePartValues("std_0C", listOf(p(GaugePart.KIND_NEEDLE, pid = "std_0D")))
        v.replace(mapOf("std_0C" to 1f, "std_0D" to 2f, "std_99" to 3f))
        assertEquals(1f, v.valueOf(p(GaugePart.KIND_NEEDLE, pid = "std_0C"))!!, 0.01f)
        assertEquals(2f, v.valueOf(p(GaugePart.KIND_NEEDLE, pid = "std_0D"))!!, 0.01f)
        assertNull("不相干的 PID 不该留在表里",
            v.valueOf(p(GaugePart.KIND_NEEDLE, pid = "std_99")))
    }

    @Test
    fun `数据断开 replace 空表后 valueOf 变 null（指针应隐藏）`() {
        val needle = p(GaugePart.KIND_NEEDLE, pid = "std_0C")
        val v = GaugePartValues("std_0C", listOf(needle))
        v.replace(mapOf("std_0C" to 3000f))
        assertNotNull(v.valueOf(needle))
        v.replace(emptyMap())
        assertNull("来源不可用后必须给 null —— 渲染层据此不画指针", v.valueOf(needle))
    }

    @Test
    fun `NaN 值被当作不可用`() {
        val needle = p(GaugePart.KIND_NEEDLE, pid = "std_0C")
        val v = GaugePartValues("std_0C", listOf(needle))
        v.replace(mapOf("std_0C" to Float.NaN))
        assertNull(v.valueOf(needle))
    }

    // ============================================================ 解析

    @Test
    fun `只有 needle 与 value 保留 pid`() {
        val parts = parseParts("""
            [
              { "kind":"needle","assetId":"a1","pid":"obd.rpm","x":0,"y":0,"w":100,"h":10 },
              { "kind":"value","pid":"obd.speed","x":0,"y":80,"w":80,"h":20 },
              { "kind":"dial","assetId":"a1","pid":"obd.coolant","x":0,"y":0,"w":100,"h":100 },
              { "kind":"ticks","assetId":"a2","pid":"obd.load","x":0,"y":0,"w":100,"h":100 },
              { "kind":"decor","assetId":"a2","pid":"obd.throttle","x":0,"y":0,"w":10,"h":10 }
            ]
        """)
        assertNotNull(parts)
        val byKind = parts!!.groupBy { it.kind }
        assertEquals("std_0C", byKind["needle"]!![0].pid)
        assertEquals("std_0D", byKind["value"]!![0].pid)
        assertEquals("dial 不该保留 pid", "", byKind["dial"]!![0].pid)
        assertEquals("ticks 不该保留 pid", "", byKind["ticks"]!![0].pid)
        assertEquals("decor 不该保留 pid", "", byKind["decor"]!![0].pid)
    }

    @Test
    fun `别名解析成内置 PID id`() {
        val parts = parseParts("""
            [ { "kind":"needle","assetId":"a1","pid":"obd.coolant","x":0,"y":0,"w":100,"h":10 } ]
        """)
        assertEquals("std_05", parts!![0].pid)
    }

    @Test
    fun `直接写 PID id 也认`() {
        val parts = parseParts("""
            [ { "kind":"needle","assetId":"a1","pid":"std_11","x":0,"y":0,"w":100,"h":10 } ]
        """)
        assertEquals("std_11", parts!![0].pid)
    }

    @Test
    fun `嵌套 children 不丢失且保留各自的 pid`() {
        val parts = parseParts("""
            [ { "kind":"needle","assetId":"a1","pid":"obd.rpm","x":0,"y":0,"w":100,"h":10,
                "children":[
                  { "kind":"decor","assetId":"a2","x":-5,"y":-5,"w":10,"h":10 },
                  { "kind":"needle","assetId":"a1","pid":"obd.speed","x":5,"y":5,"w":40,"h":6,
                    "children":[
                      { "kind":"decor","assetId":"a2","x":0,"y":0,"w":8,"h":8 }
                    ] }
                ] } ]
        """)
        val needle = parts!![0]
        assertEquals(2, needle.children.size)
        assertEquals("第 2 层 needle 的 pid 要在", "std_0D", needle.children[1].pid)
        assertEquals("第 3 层仍应在", 1, needle.children[1].children.size)
    }

    @Test
    fun `rotation alpha pivot 被保留`() {
        val parts = parseParts("""
            [ { "kind":"needle","assetId":"a1","pid":"obd.rpm","x":0,"y":0,"w":100,"h":10,
                "rotation":30,"alpha":150,"pivotX":0.06,"pivotY":0.5 } ]
        """)
        val n = parts!![0]
        assertEquals(30f, n.rotation, 0.01f)
        assertEquals(150, n.alpha)
        assertEquals(0.06f, n.pivotX, 0.001f)
        assertEquals(0.5f, n.pivotY, 0.001f)
    }

    @Test
    fun `alpha 被夹在合法区间内`() {
        val parts = parseParts("""
            [ { "kind":"decor","assetId":"a1","x":0,"y":0,"w":10,"h":10,"alpha":9999 } ]
        """)
        assertEquals(255, parts!![0].alpha)
    }

    @Test
    fun `超过深度的嵌套被截断但不崩`() {
        // 造 8 层
        var inner = """{ "kind":"decor","assetId":"a1","x":0,"y":0,"w":4,"h":4 }"""
        repeat(8) {
            inner = """{ "kind":"decor","assetId":"a1","x":0,"y":0,"w":10,"h":10,"children":[$inner] }"""
        }
        val parts = parseParts("[$inner]")
        assertNotNull("深嵌套不能崩", parts)
        // 数最大深度
        var d = 0
        var cur = parts!!.firstOrNull()
        while (cur != null) { d++; cur = cur.children.firstOrNull() }
        assertTrue("深度应被截断（实际 $d，上限 5+1）", d <= 6)
    }

    // ============================================================ 角度

    @Test
    fun `不同 PID 的指针在同一时刻角度不同`() {
        val needleRpm = p(GaugePart.KIND_NEEDLE, pid = "std_0C")
        val needleSpeed = p(GaugePart.KIND_NEEDLE, pid = "std_0D")
        val v = GaugePartValues("std_0C", listOf(needleRpm, needleSpeed))
        v.replace(mapOf("std_0C" to 4000f, "std_0D" to 120f))

        // 默认 sweep 是 135..405（270° 跨度）
        //   转速 4000/8000 = 半程 → 135 + 270*0.5 = 270
        //   车速 120/260 ≈ 0.4615   → 135 + 270*0.4615 ≈ 259.6
        val aRpm = needleRpm.angleFor(v.valueOf(needleRpm)!!, 0f, 8000f)
        val aSpeed = needleSpeed.angleFor(v.valueOf(needleSpeed)!!, 0f, 260f)

        assertTrue("转速半程角应落在扫描区间内（实际 $aRpm）", aRpm >= 135f && aRpm <= 405f)
        assertEquals("半程应落在 270°", 270f, aRpm, 0.01f)
        assertTrue("车速角度应落在扫描区间内（实际 $aSpeed）", aSpeed >= 135f && aSpeed <= 405f)
        assertTrue(
            "两个指针角度不同（否则双针表重叠成一根，实际 $aRpm vs $aSpeed）",
            Math.abs(aRpm - aSpeed) > 1f
        )
    }

    @Test
    fun `量程不同时同一数值的角度不同（证明量程跟着 PID 走）`() {
        val n = p(GaugePart.KIND_NEEDLE)
        // 同一个数值 120：按转速量程几乎贴底，按车速量程接近半程
        val asRpm = n.angleFor(120f, 0f, 8000f)
        val asSpeed = n.angleFor(120f, 0f, 260f)
        assertTrue("按转速量程应接近起点（实际 $asRpm）", asRpm < 160f)
        assertTrue("按车速量程应接近半程（实际 $asSpeed）", asSpeed > 240f)
    }
}
