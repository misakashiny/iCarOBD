package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `TrackStyle` 解析行为测试（P4F-M02 阶段 C）。
 *
 * ## 这组测试治的是什么
 *
 * P4F-M01 给 Android 加了 `trackStyle` 解析与 `TrackView` 绘制，
 * 但当时只有「JVM 全量回归通过」—— 那只说明**没弄坏别的**，
 * **完全没有验证 `TrackStyle.parse()` 本身的行为**。
 *
 * 本测试针对的是**解析层的行为**：
 *
 * | 关注点 | 验证方式 |
 * |---|---|
 * | 完整字段解析 | 给全 11 个字段，逐字段断言 |
 * | 缺字段 | 只给部分字段，其余应取默认值 |
 * | 非法值 | 给 `radius=999`、`gradient="xxx"` 等，应夹取或降级 |
 * | 边界值 | 0、负数、超大值 |
 * | 缺 trackStyle | 应返回 null（旧图片分支不受影响） |
 *
 * ⚠️ **本测试不验证 Canvas 绘制结果**。`TrackView.onDraw()` 需要
 * Android 图形栈，纯 JVM 测试无法覆盖 —— 那部分由
 * `P4F-GUI-004` 的真机人工验收负责。**不得声称本测试证明了绘制正确。**
 *
 * 字段语义与工具侧 `normalizeTrackStyle()` 逐条对齐
 * （见 `tools/icarui/js/schema.js`）。
 */
class TrackStyleParseTest {

    // ============ 一、完整解析 ============

    @Test
    fun `full object parses every field`() {
        val o = JSONObject(
            """
            {
              "orient": "v",
              "radius": 12,
              "inset": true,
              "glow": true,
              "band": true,
              "gradient": "fade",
              "segments": 8,
              "ticks": 6,
              "fill": 0.75,
              "color": "#112233",
              "accent": "#AABBCC"
            }
            """.trimIndent()
        )
        val t = TrackStyle.parse(o)
        assertNotNull("完整对象应解析成功", t)
        t!!
        assertEquals("v", t.orient)
        assertTrue("垂直方向", t.isVertical)
        assertEquals(12f, t.radius!!, 0.001f)
        assertTrue(t.inset)
        assertTrue(t.glow)
        assertTrue(t.band)
        assertEquals("fade", t.gradient)
        assertEquals(8, t.segments)
        assertEquals(6, t.ticks)
        assertEquals(0.75f, t.fill!!, 0.001f)
        assertEquals("#112233", t.color)
        assertEquals("#AABBCC", t.accent)
    }

    // ============ 二、缺字段取默认值 ============

    @Test
    fun `missing trackStyle returns null`() {
        // 旧图片分支的关键保证：没有 trackStyle 时必须是 null
        assertNull(TrackStyle.parse(null))
    }

    @Test
    fun `empty object yields defaults`() {
        val t = TrackStyle.parse(JSONObject("{}"))
        assertNotNull("空对象仍应产生 TrackStyle（字段全默认）", t)
        t!!
        assertEquals("h", t.orient)
        assertFalse(t.isVertical)
        assertNull("radius 缺省为 null（= 取短边一半）", t.radius)
        assertFalse(t.inset)
        assertFalse(t.glow)
        assertFalse(t.band)
        assertNull(t.gradient)
        assertEquals(0, t.segments)
        assertEquals(0, t.ticks)
        assertNull(t.fill)
        assertNull(t.color)
        assertNull(t.accent)
    }

    @Test
    fun `partial object only overrides given fields`() {
        val t = TrackStyle.parse(JSONObject("""{"orient":"v","segments":4}"""))
        t!!
        assertEquals("v", t.orient)
        assertEquals(4, t.segments)
        // 其余保持默认
        assertNull(t.radius)
        assertEquals(0, t.ticks)
        assertFalse(t.glow)
    }

    // ============ 三、radius 边界 ============

    @Test
    fun `radius is clamped to 0 MAX`() {
        assertEquals(0f, TrackStyle.parse(JSONObject("""{"radius":-5}"""))!!.radius!!, 0.001f)
        assertEquals(64f, TrackStyle.parse(JSONObject("""{"radius":999}"""))!!.radius!!, 0.001f)
        assertEquals(30f, TrackStyle.parse(JSONObject("""{"radius":30}"""))!!.radius!!, 0.001f)
    }

    @Test
    fun `radius null stays null`() {
        assertNull(TrackStyle.parse(JSONObject("""{"radius":null}"""))!!.radius)
    }

    // ============ 四、gradient 枚举 ============

    @Test
    fun `gradient accepts only fade and gloss`() {
        assertEquals("fade", TrackStyle.parse(JSONObject("""{"gradient":"fade"}"""))!!.gradient)
        assertEquals("gloss", TrackStyle.parse(JSONObject("""{"gradient":"gloss"}"""))!!.gradient)
        // 非法值 -> null（跟随主题），**不静默改成别的**
        assertNull(TrackStyle.parse(JSONObject("""{"gradient":"xxx"}"""))!!.gradient)
        assertNull(TrackStyle.parse(JSONObject("""{"gradient":""}"""))!!.gradient)
        assertNull(TrackStyle.parse(JSONObject("""{"gradient":null}"""))!!.gradient)
    }

    // ============ 五、segments / ticks 上限 ============

    @Test
    fun `segments and ticks clamp to 64`() {
        assertEquals(64, TrackStyle.parse(JSONObject("""{"segments":9999}"""))!!.segments)
        assertEquals(64, TrackStyle.parse(JSONObject("""{"ticks":9999}"""))!!.ticks)
        assertEquals(0, TrackStyle.parse(JSONObject("""{"segments":-3}"""))!!.segments)
        assertEquals(0, TrackStyle.parse(JSONObject("""{"ticks":0}"""))!!.ticks)
        assertEquals(10, TrackStyle.parse(JSONObject("""{"segments":10.7}"""))!!.segments)
    }

    // ============ 六、fill 范围 ============

    @Test
    fun `fill clamps into zero to one`() {
        assertEquals(1f, TrackStyle.parse(JSONObject("""{"fill":5}"""))!!.fill!!, 0.001f)
        assertEquals(0f, TrackStyle.parse(JSONObject("""{"fill":-1}"""))!!.fill!!, 0.001f)
        assertEquals(0.5f, TrackStyle.parse(JSONObject("""{"fill":0.5}"""))!!.fill!!, 0.001f)
        assertNull("fill=null 表示不画填充", TrackStyle.parse(JSONObject("""{"fill":null}"""))!!.fill)
    }

    // ============ 七、颜色只认 #RRGGBB ============

    @Test
    fun `color accepts only hex6`() {
        assertEquals("#FF0000", TrackStyle.parse(JSONObject("""{"color":"#FF0000"}"""))!!.color)
        // 不认的写法 -> null（跟随主题），不静默改成默认色
        assertNull(TrackStyle.parse(JSONObject("""{"color":"red"}"""))!!.color)
        assertNull(TrackStyle.parse(JSONObject("""{"color":"#F00"}"""))!!.color)
        assertNull(TrackStyle.parse(JSONObject("""{"color":""}"""))!!.color)
        assertNull(TrackStyle.parse(JSONObject("""{"color":null}"""))!!.color)
    }

    // ============ 八、布尔字段 ============

    @Test
    fun `boolean flags parse correctly`() {
        val t = TrackStyle.parse(JSONObject("""{"inset":true,"glow":true,"band":true}"""))
        t!!
        assertTrue(t.inset)
        assertTrue(t.glow)
        assertTrue(t.band)

        val f = TrackStyle.parse(JSONObject("""{"inset":false,"glow":false,"band":false}"""))
        f!!
        assertFalse(f.inset)
        assertFalse(f.glow)
        assertFalse(f.band)
    }

    // ============ 九、orient ============

    @Test
    fun `orient only accepts v`() {
        assertEquals("v", TrackStyle.parse(JSONObject("""{"orient":"v"}"""))!!.orient)
        assertEquals("h", TrackStyle.parse(JSONObject("""{"orient":"h"}"""))!!.orient)
        // 非法值回落 h
        assertEquals("h", TrackStyle.parse(JSONObject("""{"orient":"diagonal"}"""))!!.orient)
        assertEquals("h", TrackStyle.parse(JSONObject("""{"orient":""}"""))!!.orient)
    }

    // ============ 十、常量与工具侧一致 ============

    @Test
    fun `constants match tool side`() {
        // 与 tools/icarui/js/schema.js 的 MAX_TRACK_SEGMENTS / MAX_TRACK_TICKS 一致
        assertEquals(64, TrackStyle.MAX_SEGMENTS)
        assertEquals(64, TrackStyle.MAX_TICKS)
        assertEquals(64f, TrackStyle.MAX_RADIUS, 0.001f)
    }

    // ============ 十一、组合：真实设计文件片段 ============

    @Test
    fun `realistic design snippet parses`() {
        // 模拟 ICarUI 导出的真实 trackStyle
        val o = JSONObject(
            """
            {
              "orient": "h",
              "radius": 8,
              "inset": false,
              "glow": false,
              "band": false,
              "gradient": null,
              "segments": 0,
              "ticks": 0,
              "fill": null,
              "color": null,
              "accent": null
            }
            """.trimIndent()
        )
        val t = TrackStyle.parse(o)
        assertNotNull(t)
        t!!
        assertEquals("h", t.orient)
        assertEquals(8f, t.radius!!, 0.001f)
        assertFalse(t.glow)
        assertNull(t.gradient)
        assertNull(t.fill)
    }
}
