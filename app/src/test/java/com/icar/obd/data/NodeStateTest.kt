package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 状态系统（`states` / `statePid`）的数据层契约（v1.20.16）。
 *
 * ## 为什么单独一个测试类
 *
 * 这个类是**"灯会不会亮"的最后一环**：
 *  - 工具侧 `presets.js` 写错字段（写 `pid` 而不是 `statePid`）→ 灯永远暗；
 *  - App 侧 `NodeTreeRenderer.resolveState()` 只读 `statePid` → 空就直接 normal；
 *  - `DesignNode` 解析时若把 `statePid` 丢了 → 一样永远暗。
 *
 * 这三处**任何一处**错，症状都是同一个："用户以为车没问题"。
 * 工具侧由 `tests/verify-lamp-state.js` 全库扫描守着，这里守数据层这一环。
 */
class NodeStateTest {

    private fun states(json: String): Map<String, NodeState>? =
        NodeState.parseAll(JSONObject(json), "n1", mutableListOf(), emptySet())

    // ================================================================ 闪烁频率红线

    @Test
    fun `MIN_BLINK_MS 换算成频率不超过每秒三次 —— WCAG 2_3_1`() {
        // 标准原文："not ... more than three times in any one second period"
        val hz = 1000.0 / NodeState.MIN_BLINK_MS
        assertTrue(
            "MIN_BLINK_MS=${NodeState.MIN_BLINK_MS}ms → ${"%.2f".format(hz)} Hz，超 WCAG 2.3.1 的 3 Hz",
            hz <= 3.0
        )
    }

    @Test
    fun `文件里写了低于下限的闪烁周期 也必须抬到 400ms`() {
        // ⚠️ 这是**安全/合规**断言，不是"宽容解析"。
        // 设计文件可以是别人手写的、也可以是老版本工具导出的 ——
        // 里面写 100ms（10Hz）**不能照闪**。
        val s = states(
            """{"critical":{"assetId":"a","alpha":255,"blink":true,"blinkMs":100}}"""
        )!!
        assertEquals(NodeState.MIN_BLINK_MS, s["critical"]!!.blinkMs)
    }

    @Test
    fun `60ms 这个老下限不能再生效 —— 反证`() {
        // 修复前这里夹的是 coerceAtLeast(60)，即 16.7 Hz（比红线高 5 倍多）
        val s = states(
            """{"critical":{"assetId":"a","alpha":255,"blink":true,"blinkMs":60}}"""
        )!!
        assertTrue(
            "60ms 必须被抬到 ≥400ms，实际 ${s["critical"]!!.blinkMs}",
            s["critical"]!!.blinkMs >= NodeState.MIN_BLINK_MS
        )
    }

    @Test
    fun `合规的闪烁周期原样保留 —— 只抬下限 不改上限`() {
        val s = states(
            """{"critical":{"assetId":"a","alpha":255,"blink":true,"blinkMs":900}}"""
        )!!
        assertEquals(900, s["critical"]!!.blinkMs)
    }

    @Test
    fun `缺省 blinkMs 落在下限上 而不是 200`() {
        val s = states("""{"warn":{"assetId":"a","alpha":255,"blink":true}}""")!!
        assertEquals(NodeState.MIN_BLINK_MS, s["warn"]!!.blinkMs)
    }

    @Test
    fun `三个状态都受下限约束`() {
        val s = states(
            """
            {"normal":{"assetId":"a","alpha":255,"blink":false,"blinkMs":10},
             "warn":{"assetId":"b","alpha":255,"blink":true,"blinkMs":20},
             "critical":{"assetId":"c","alpha":255,"blink":true,"blinkMs":30}}
            """.trimIndent()
        )!!
        NodeState.NAMES.forEach { n ->
            assertEquals(
                "$n 的 blinkMs 没被抬到下限",
                NodeState.MIN_BLINK_MS, s[n]!!.blinkMs
            )
        }
    }

    // ================================================================ 解析正确性

    @Test
    fun `三个状态都读进来`() {
        val s = states(
            """
            {"normal":{"assetId":"off","alpha":120,"blink":false,"blinkMs":400},
             "warn":{"assetId":"warn","alpha":255,"blink":false,"blinkMs":400},
             "critical":{"assetId":"crit","alpha":255,"blink":true,"blinkMs":400}}
            """.trimIndent()
        )!!
        assertEquals(3, s.size)
        assertEquals("off", s["normal"]!!.assetId)
        assertEquals(120, s["normal"]!!.alpha)
        assertEquals(true, s["critical"]!!.blink)
    }

    @Test
    fun `alpha 被夹在 0 到 255`() {
        val s = states(
            """{"normal":{"assetId":"a","alpha":999,"blink":false,"blinkMs":400},
               "warn":{"assetId":"a","alpha":-5,"blink":false,"blinkMs":400}}"""
        )!!
        assertEquals(255, s["normal"]!!.alpha)
        assertEquals(0, s["warn"]!!.alpha)
    }

    @Test
    fun `没有 states 时返回 null 而不是空表`() {
        assertNull(NodeState.parseAll(null, "n1", mutableListOf(), emptySet()))
        // 空对象 → 一个状态都读不到 → null（不是空 map）
        assertNull(states("{}"))
    }

    @Test
    fun `引用了不在清单里的素材只给警告`() {
        val w = mutableListOf<String>()
        val s = NodeState.parseAll(
            JSONObject("""{"critical":{"assetId":"nope","alpha":255,"blink":true,"blinkMs":400}}"""),
            "n1", w, setOf("known")
        )
        assertNotNull(s)
        assertTrue("应当有一条素材缺失警告，实际 $w", w.any { it.contains("nope") })
    }

    @Test
    fun `素材清单为空时不报缺失警告 —— 无法判断就不乱说`() {
        val w = mutableListOf<String>()
        NodeState.parseAll(
            JSONObject("""{"critical":{"assetId":"whatever","alpha":255,"blink":true,"blinkMs":400}}"""),
            "n1", w, emptySet()
        )
        assertEquals(0, w.size)
    }
}
