package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 从**参考图还原出来的表盘草稿**能不能真的被解析（v1.20.7）。
 *
 * ## 为什么要有这条
 *
 * 图片还原出来的设计最危险的失败方式是「**看起来完全合理，但 App 解析不了**」——
 * 画布一片空白，日志一个字都没有（这个项目为此查过两轮）。
 * 所以草稿必须**过一遍真解析器**：硬错误必须为 0、PID 必须都在库里、
 * 坐标不能越界。这三条对上了，才敢交给人去微调。
 *
 * 坐标来源：2560x1280 参考图的 64x32 亮像素密度图（每格 40x40px）。
 * 画布是**每轴** 0..360，所以 2:1 图上的正圆 w ≈ h/2。
 */
class DesignDraftFromImageTest {

    /** 与 `stage/design-draft-cyan.json` 保持一致（改那边记得同步这里） */
    private val draft = """
    {
      "schema": "icar.ui/1",
      "meta": { "name": "青色霓虹（由图片还原 · 草稿）", "author": "AI 像素分析", "description": "" },
      "canvas": { "unit": 360, "note": "每轴 0..360" },
      "theme": "neon",
      "gauges": [
        { "pid": "std_0C", "style": 0, "min": 0, "max": 8000, "x": 22, "y": 79, "w": 112, "h": 225, "warnHigh": 6500, "ringStyle": 1 },
        { "pid": "std_05", "style": 0, "min": -40, "max": 215, "x": 225, "y": 79, "w": 90, "h": 225, "warnLow": 60, "warnHigh": 105 },
        { "pid": "std_0D", "style": 1, "min": 0, "max": 260, "x": 157, "y": 157, "w": 79, "h": 79 },
        { "pid": "std_A6", "style": 1, "min": 0, "max": 999999, "x": 157, "y": 236, "w": 79, "h": 67 },
        { "pid": "std_0B", "style": 2, "min": 0, "max": 250, "x": 22, "y": 305, "w": 112, "h": 50, "warnHigh": 200 },
        { "pid": "std_42", "style": 1, "min": 0, "max": 20, "x": 140, "y": 305, "w": 60, "h": 50, "warnLow": 11.8, "warnHigh": 15.2 },
        { "pid": "std_0F", "style": 1, "min": -40, "max": 100, "x": 206, "y": 305, "w": 60, "h": 50, "warnHigh": 60 }
      ]
    }
    """.trimIndent()

    @Test
    fun `图片还原的草稿必须解析通过且坐标不越界`() {
        val r = DesignFile.parse(draft)
        assertTrue("解析报了硬错误：${r.errors}", r.errors.isEmpty())
        val d = r.design
        requireNotNull(d) { "parse 没返回 design（errors=${r.errors}）" }
        assertEquals("表数不对", 7, d.gauges.size)

        // 每个 PID 都必须在内置库里 —— 否则 DashRenderer 会**静默过滤掉**它，
        // 表现就是"画布上少一块、没有任何提示"
        d.gauges.forEach { g ->
            assertTrue("PID 库里没有 ${g.pidId}（这个节点会被静默丢掉）", Store.findPid(g.pidId) != null)
        }

        // 坐标不能越界（画布每轴 0..360）
        d.gauges.forEach { g ->
            assertTrue("x+w 越界：${g.pidId} ${g.x}+${g.w}", g.x + g.w <= GaugeItem.CANVAS + 1f)
            assertTrue("y+h 越界：${g.pidId} ${g.y}+${g.h}", g.y + g.h <= GaugeItem.CANVAS + 1f)
            assertTrue("w/h 必须为正：${g.pidId}", g.w > 0f && g.h > 0f)
        }
    }
}
