package com.icar.obd.data

import org.junit.Assert.*
import org.junit.Test

/**
 * T-UI-HUD-01 原型：`GaugePart.anim` 的解析与语义。
 *
 * 这些用例只钉**数据层**契约（解析、夹取、缺省），不涉及 Android 绘制。
 * 渲染路径由真机观感 + 性能基准覆盖（见 docs/02_验证记录/20261017_HUD动效原型.md）。
 */
class PartAnimTest {

    private fun node(partsJson: String): DesignFile.Result =
        DesignFile.parse(
            """
            {
              "schema": "icar.ui/2",
              "meta": { "name": "t" },
              "canvas": { "unit": 360 },
              "nodes": [
                {
                  "id": "g1", "type": "gauge", "name": "g",
                  "x": 0, "y": 0, "w": 180, "h": 180,
                  "pid": "std_0C", "style": 0, "min": 0, "max": 8000,
                  "parts": $partsJson
                }
              ]
            }
            """.trimIndent()
        )

    @Test fun `part without anim has null anim and keeps old behaviour`() {
        val r = node("""[{ "kind": "decor", "x": 0, "y": 0, "w": 100, "h": 100 }]""")
        val parts = r.design!!.nodes!!.first().parts!!
        assertNull("缺省 anim 必须是 null（存量设计逐像素不变）", parts[0].anim)
    }

    @Test fun `anim parses all four kinds`() {
        for (k in PartAnim.KINDS) {
            val r = node("""[{ "kind": "decor", "w": 100, "h": 100, "anim": { "kind": "$k" } }]""")
            val a = r.design!!.nodes!!.first().parts!![0].anim
            assertNotNull("kind=$k 应当解析出 anim", a)
            assertEquals(k, a!!.kind)
        }
    }

    @Test fun `unknown anim kind falls back to pulse with a warning`() {
        val r = node("""[{ "kind": "decor", "w": 100, "h": 100, "anim": { "kind": "teleport" } }]""")
        val a = r.design!!.nodes!!.first().parts!![0].anim!!
        assertEquals(PartAnim.KIND_PULSE, a.kind)
        assertTrue(
            "未知 kind 必须有警告",
            r.warnings.any { it.contains("teleport") }
        )
    }

    @Test fun `blink speed is clamped to WCAG floor`() {
        val r = node("""[{ "kind": "decor", "w": 100, "h": 100, "anim": { "kind": "pulse", "periodMs": 60 } }]""")
        val a = r.design!!.nodes!!.first().parts!![0].anim!!
        assertEquals(
            "过快周期必须夹到 MIN_PERIOD_MS（WCAG 2.3.1：每秒不超过 3 次）",
            PartAnim.MIN_PERIOD_MS, a.periodMs
        )
        assertTrue("夹取必须出声", r.warnings.any { it.contains("periodMs") })
    }

    @Test fun `cycle is periodic and stays in 0 to 1`() {
        val a = PartAnim(kind = PartAnim.KIND_PULSE, periodMs = 1000, phase = 0f)
        for (t in listOf(0L, 1L, 250L, 999L, 1000L, 1500L, 123456789L)) {
            val u = a.cycle(t)
            assertTrue("cycle($t) = $u 越界", u >= 0f && u < 1f)
        }
        // 同周期同相位 → 同值
        assertEquals(a.cycle(1000L), a.cycle(2000L), 1e-6f)
    }

    @Test fun `phase offset shifts the cycle`() {
        val base = PartAnim(periodMs = 1000, phase = 0f)
        val shifted = PartAnim(periodMs = 1000, phase = 0.5f)
        assertEquals(0.5f, shifted.cycle(0L), 1e-6f)
        assertEquals(
            (base.cycle(0L) + 0.5f) % 1f,
            shifted.cycle(0L),
            1e-6f
        )
    }

    /**
     * **已知缺口**（非本卡引入）：`DesignNode.toJson()` 目前**不写回 `parts`** ——
     * `parts` 只在 `GaugePart.parseAll` 里被读，全项目没有对应的写出路径。
     *
     * 所以「解析 → toJson → 再解析」会丢掉 parts（连带 anim）。
     * 本用例**钉住这个现状**，避免将来有人误以为往返是无损的；
     * 真正修复（把 parts 写回 JSON）属于工具侧/序列化改造，超出本原型白名单。
     */
    @Test fun `parts are not written back to json (known gap)`() {
        val src = node("""[{ "kind": "decor", "w": 100, "h": 100, "anim": { "kind": "spin", "periodMs": 3000, "amplitude": 2 } }]""")
        val design = src.design!!
        // 解析阶段 anim 在（本卡新增能力）
        val parsedAnim = design.nodes!!.first().parts!![0].anim!!
        assertEquals(PartAnim.KIND_SPIN, parsedAnim.kind)
        assertEquals(3000, parsedAnim.periodMs)

        // 但 toJson 不写 parts → 往返后丢失（既有缺口，非本卡回归）
        val back = DesignFile.parse(design.toJson().toString()).design!!
        assertTrue(
            "toJson 当前不写回 parts —— 若本断言失败说明已补上写出路径，应同时移除本用例并补往返测试",
            back.nodes!!.first().parts.isNullOrEmpty()
        )
    }
}
