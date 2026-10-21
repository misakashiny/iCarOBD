package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `DesignNode` 层的 `trackStyle` 分派行为（P4F-M02 阶段 C）。
 *
 * ## 这组测试治的是什么
 *
 * `NodeTreeRenderer.buildNode()` 的分派规则是：
 *
 * ```kotlin
 * node.isImage && node.trackStyle != null -> buildTrack(node)
 * node.isImage -> buildImage(node)
 * ```
 *
 * 也就是说：
 * - **有 trackStyle** → 代码绘制轨道
 * - **没有 trackStyle** → 贴底图（旧行为，逐像素不变）
 *
 * 如果解析层把 `trackStyle` 错误地解析成非 null（例如空对象 `{}` 也产生对象），
 * 那么**所有普通图片都会 suddenly 变成「空白轨道」** —— 这是灾难性的回归。
 *
 * 本测试锁死这条分派语义。
 *
 * ⚠️ **不验证绘制结果**。`buildImage()` / `buildTrack()` 需要 Android View 栈，
 * 纯 JVM 测不了。真机验收见 `P4F-GUI-004`。
 */
class DesignNodeTrackDispatchTest {

    private fun parseNode(json: String): DesignNode? {
        val o = JSONObject(json)
        val node = DesignNode.parse(o, "nodes[0]", mutableListOf(), mutableListOf(), emptySet())
        return node
    }

    // ============ 一、普通图片：trackStyle 必须为 null ============

    @Test
    fun `plain image has null trackStyle`() {
        val n = parseNode(
            """
            {"id":"img1","type":"image","name":"图","x":0,"y":0,"w":100,"h":100,
             "assetId":"a1"}
            """.trimIndent()
        )
        assertNotNull(n)
        n!!
        assertTrue("是 image 节点", n.isImage)
        assertNull("**普通图片的 trackStyle 必须为 null**（否则会走轨道分支）", n.trackStyle)
    }

    @Test
    fun `plain image without trackStyle key stays null`() {
        // 老设计文件根本没有 trackStyle 字段
        val n = parseNode(
            """
            {"id":"old","type":"image","name":"旧图","x":10,"y":10,"w":50,"h":50}
            """.trimIndent()
        )
        n!!
        assertNull("**老文件（无 trackStyle）必须保持 null**", n.trackStyle)
    }

    @Test
    fun `explicit null trackStyle stays null`() {
        val n = parseNode(
            """
            {"id":"n1","type":"image","name":"图","x":0,"y":0,"w":10,"h":10,
             "trackStyle":null}
            """.trimIndent()
        )
        n!!
        assertNull("显式 null 仍是 null", n.trackStyle)
    }

    // ============ 二、轨道：trackStyle 非 null ============

    @Test
    fun `image with trackStyle gets parsed`() {
        val n = parseNode(
            """
            {"id":"t1","type":"image","name":"轨道","x":0,"y":0,"w":240,"h":16,
             "trackStyle":{"orient":"h","radius":8,"glow":true,"ticks":5,"fill":0.5}}
            """.trimIndent()
        )
        assertNotNull(n)
        n!!
        assertTrue(n.isImage)
        assertNotNull("**有 trackStyle 时应解析出对象**", n.trackStyle)
        n.trackStyle!!
        assertEquals("h", n.trackStyle!!.orient)
        assertEquals(8f, n.trackStyle!!.radius!!, 0.001f)
        assertTrue(n.trackStyle!!.glow)
        assertEquals(5, n.trackStyle!!.ticks)
        assertEquals(0.5f, n.trackStyle!!.fill!!, 0.001f)
    }

    @Test
    fun `image with empty trackStyle object still gets object`() {
        // 注意：空对象 {} 会产生一个**全默认的 TrackStyle**，
        // 因此该节点会走轨道分支（画一条默认轨道）。
        // 这是 P4F-M01 的既定语义 —— 编辑器不会导出空对象，
        // 但解析层不拒绝它（宽容解析）。
        val n = parseNode(
            """
            {"id":"t2","type":"image","name":"空轨道","x":0,"y":0,"w":100,"h":10,
             "trackStyle":{}}
            """.trimIndent()
        )
        n!!
        assertNotNull("空对象产生默认 TrackStyle", n.trackStyle)
        assertEquals("h", n.trackStyle!!.orient)
        assertNull(n.trackStyle!!.radius)
    }

    // ============ 三、其它节点类型不受影响 ============

    @Test
    fun `gauge node has null trackStyle`() {
        val n = parseNode(
            """
            {"id":"g1","type":"gauge","name":"表","x":0,"y":0,"w":100,"h":100,
             "pid":"std_0C","unit":360,"style":0,"min":0,"max":8000}
            """.trimIndent()
        )
        n!!
        assertTrue(n.isGauge)
        assertNull("仪表不应有 trackStyle", n.trackStyle)
    }

    @Test
    fun `text node has null trackStyle`() {
        val n = parseNode(
            """
            {"id":"tx1","type":"text","name":"字","x":0,"y":0,"w":100,"h":20,
             "text":"hello"}
            """.trimIndent()
        )
        n!!
        assertTrue(n.isText)
        assertNull(n.trackStyle)
    }

    @Test
    fun `group node has null trackStyle`() {
        val n = parseNode(
            """
            {"id":"gr1","type":"group","name":"组","x":0,"y":0,"w":100,"h":100}
            """.trimIndent()
        )
        n!!
        assertTrue(n.isGroup)
        assertNull(n.trackStyle)
    }

    // ============ 四、分派判据（模拟 NodeTreeRenderer 的 when 分支）============

    @Test
    fun `dispatch predicate distinguishes track from plain image`() {
        fun shouldUseTrack(node: DesignNode) = node.isImage && node.trackStyle != null

        val plain = parseNode(
            """{"id":"p","type":"image","name":"普通","x":0,"y":0,"w":10,"h":10}"""
        )!!
        val track = parseNode(
            """
            {"id":"t","type":"image","name":"轨道","x":0,"y":0,"w":10,"h":10,
             "trackStyle":{"orient":"v"}}
            """.trimIndent()
        )!!
        val lamp = parseNode(
            """
            {"id":"l","type":"image","name":"灯","x":0,"y":0,"w":10,"h":10,
             "assetId":"a","states":{"normal":{"assetId":"a"}}}
            """.trimIndent()
        )!!

        assertFalse("普通图片 → buildImage（贴底图）", shouldUseTrack(plain))
        assertTrue("带 trackStyle → buildTrack（代码绘制）", shouldUseTrack(track))
        assertFalse("状态灯（无 trackStyle）→ buildImage", shouldUseTrack(lamp))
    }

    // ============ 五、状态灯与轨道可共存但互不干扰 ============

    @Test
    fun `state lamp keeps states independent from trackStyle`() {
        val n = parseNode(
            """
            {"id":"both","type":"image","name":"混合","x":0,"y":0,"w":10,"h":10,
             "assetId":"a",
             "states":{"normal":{"assetId":"a"},"warn":{"assetId":"b"}}}
            """.trimIndent()
        )
        n!!
        assertNotNull("状态灯有 states", n.states)
        assertNull("状态灯不应有 trackStyle", n.trackStyle)
        assertEquals(2, n.states!!.size)
    }
}
