package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 背景的 **w / h**（设计尺寸，画布单位）。
 *
 * ## 为什么值得单独测
 *
 * 这两个字段工具侧早就在写，而 App 侧**一直忽略** —— 于是"电脑上缩在中间的一张图"
 * 推到设备上就变成全屏拉伸。这类"字段写了没人读"的缺陷不会崩、不会报错，
 * 只会**看起来不太对**，所以必须有断言钉住它真的被读到了。
 */
class BackgroundSizeTest {

    private fun parse(bg: String) = DesignFile.parse(
        """
        {
          "schema": "icar.ui/1",
          "canvas": {"unit": 360},
          "background": $bg,
          "gauges": [{"id":"g","pid":"obd.rpm","style":0,"min":0,"max":8000,
                      "x":0,"y":0,"w":180,"h":180}]
        }
        """.trimIndent()
    )

    @Test
    fun `w 与 h 被读进来`() {
        val r = parse("""{"path":"/sdcard/bg.png","fit":0,"w":200,"h":120}""")
        assertTrue(r.errors.toString(), r.ok)
        val bg = r.design!!.background!!
        assertEquals("/sdcard/bg.png", bg.path)
        assertEquals(200, bg.w)
        assertEquals(120, bg.h)
    }

    @Test
    fun `缺 w h 时是 0 —— 表示铺满 不是报错`() {
        // 0 是"没指定"的约定值，渲染层据此回落铺满。
        // **不能**把它当非法值报错 —— 存量文件全都没有这两个字段。
        val r = parse("""{"path":"/sdcard/bg.png","fit":1}""")
        assertTrue(r.errors.toString(), r.ok)
        assertEquals(0, r.design!!.background!!.w)
        assertEquals(0, r.design!!.background!!.h)
    }

    @Test
    fun `只有宽没有高时也当没指定`() {
        // 渲染层要求 w 和 h **都 > 0** 才走定位路径 —— 单边有值无法确定矩形。
        // 这条钉住解析层不会自作主张补一个默认高。
        val r = parse("""{"path":"/sdcard/bg.png","w":200}""")
        assertTrue(r.errors.toString(), r.ok)
        assertEquals(200, r.design!!.background!!.w)
        assertEquals(0, r.design!!.background!!.h)
    }

    @Test
    fun `没有 background 段时是 null`() {
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/1","canvas":{"unit":360},
             "gauges":[{"id":"g","pid":"obd.rpm","style":0,"min":0,"max":8000,
                        "x":0,"y":0,"w":180,"h":180}]}
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        assertNull(r.design!!.background)
    }

    @Test
    fun `toJson 往返保留 w 与 h`() {
        val r = parse("""{"path":"/sdcard/bg.png","fit":3,"w":360,"h":90}""")
        assertTrue(r.errors.toString(), r.ok)
        val back = DesignFile.parse(r.design!!.toJson().toString())
        assertTrue(back.errors.toString(), back.ok)
        val bg = back.design!!.background!!
        assertEquals(360, bg.w)
        assertEquals(90, bg.h)
        assertEquals(DesignFile.FIT_TILE, bg.fit)
    }

    @Test
    fun `v2 的 nodes 文件里背景尺寸也能读到`() {
        val r = DesignFile.parse(
            """
            {
              "schema": "icar.ui/2",
              "canvas": {"unit": 360, "scaleMode": 1},
              "background": {"path": "assets/背景/carbon.png", "fit": 0, "w": 256, "h": 256},
              "nodes": [{"id":"g","type":"gauge","pid":"obd.rpm","style":0,
                         "min":0,"max":8000,"x":0,"y":0,"w":180,"h":180}]
            }
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        val bg = r.design!!.background!!
        assertEquals(256, bg.w)
        assertEquals("相对路径也要原样保留（App 侧拼 designBaseDir）", "assets/背景/carbon.png", bg.path)
    }
}
