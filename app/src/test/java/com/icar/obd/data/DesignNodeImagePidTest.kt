package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * \`DesignNode\` 的 image 节点 PID 绑定解析（P5A-M01 阶段 C）。
 *
 * ## 背景
 *
 * 修之前：\`TYPE_IMAGE\` 分支**只读 \`statePid\`**，轨道节点写的 \`pid\` 被丢掉
 * → \`TrackView\` 拿不到要绑哪个 PID → 轨道永远画成设计时的静态比例。
 *
 * 修之后：**先读 \`pid\`，读不到再读 \`statePid\`**。两者语义都是
 * 「这个 image 节点绑哪个 PID」，共用一个字段，不新增字段、不改契约。
 *
 * 本测试钉住这个回落顺序 —— 老设计（只写 statePid）必须继续有效。
 */
class DesignNodeImagePidTest {

    private fun parse(nodeJson: String): DesignNode? {
        val root = org.json.JSONObject(
            """
            {
              "schema": "icar.ui/2",
              "pages": [
                { "id": "p0", "name": "主页面", "nodes": [ $nodeJson ] }
              ],
              "assets": []
            }
            """.trimIndent()
        )
        val r = DesignFile.parse(root)
        return r.design?.pages?.getOrNull(0)?.nodes?.getOrNull(0)
    }

    @Test
    fun `轨道节点写 pid 时能被解析到 statePid`() {
        val n = parse(
            """
            {
              "id": "t1", "type": "image", "name": "车速条",
              "x": 10, "y": 10, "w": 100, "h": 20,
              "pid": "obd.speed",
              "trackStyle": { "orient": "h", "fill": 0.5 }
            }
            """.trimIndent()
        )
        assertEquals("std_0D", n?.statePid)
    }

    @Test
    fun `老设计只写 statePid 仍然有效`() {
        val n = parse(
            """
            {
              "id": "l1", "type": "image", "name": "水温灯",
              "x": 10, "y": 10, "w": 40, "h": 40,
              "statePid": "obd.coolant"
            }
            """.trimIndent()
        )
        assertEquals("std_05", n?.statePid)
    }

    @Test
    fun `pid 优先于 statePid`() {
        val n = parse(
            """
            {
              "id": "t2", "type": "image", "name": "轨道",
              "x": 10, "y": 10, "w": 100, "h": 20,
              "pid": "obd.rpm",
              "statePid": "obd.coolant",
              "trackStyle": { "orient": "h", "fill": 0.3 }
            }
            """.trimIndent()
        )
        assertEquals("std_0C", n?.statePid)
    }

    @Test
    fun `都不写时为空字符串`() {
        val n = parse(
            """
            {
              "id": "t3", "type": "image", "name": "无绑定",
              "x": 10, "y": 10, "w": 100, "h": 20,
              "trackStyle": { "orient": "h", "fill": 0.3 }
            }
            """.trimIndent()
        )
        assertEquals("", n?.statePid)
    }

    @Test
    fun `直接写 PID id 也认`() {
        val n = parse(
            """
            {
              "id": "t4", "type": "image", "name": "轨道",
              "x": 10, "y": 10, "w": 100, "h": 20,
              "pid": "std_11",
              "trackStyle": { "orient": "h", "fill": 0.3 }
            }
            """.trimIndent()
        )
        assertEquals("std_11", n?.statePid)
    }

    @Test
    fun `trackStyle 缺失时 trackStyle 为 null（回落普通图片）`() {
        val n = parse(
            """
            {
              "id": "i1", "type": "image", "name": "普通图",
              "x": 10, "y": 10, "w": 100, "h": 100,
              "pid": "obd.speed"
            }
            """.trimIndent()
        )
        assertNull(n?.trackStyle)
        assertEquals("std_0D", n?.statePid)
    }
}
