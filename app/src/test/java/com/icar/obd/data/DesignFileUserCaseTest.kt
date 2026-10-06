package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 用**用户实际给的失败文件**当用例（v1.20.4）。
 *
 * 背景：用户报"画布还是不会显示控件"。那份 `未命名设计-v1.json` 逐条看都合法
 * （`icar.ui/1`、无素材、5 个 PID 全是内置、坐标在 0..360 内），本该正常渲染。
 * 而设备上的配置显示**两套画布都还是 8 个表、designJson 全空** ——
 * 说明导入**根本没生效**。
 *
 * 这个用例就是把"解析这一步到底过不过"钉住：如果 `parse` 报了错，
 * 失败信息里会直接列出错误文案（那就是用户看到的那个对话框）。
 */
class DesignFileUserCaseTest {

    /** 用户附件原文（一字不改，只去掉缩进） */
    private val userFile = """
    {
      "schema": "icar.ui/1",
      "meta": { "name": "未命名设计", "author": "", "description": "" },
      "canvas": { "unit": 360, "note": "每轴 0..360。x/y 是左上角，w/h 是尺寸" },
      "gauges": [
        { "pid": "std_0C", "style": 0, "min": 0, "max": 8000, "x": 0, "y": 45, "w": 180, "h": 180, "warnHigh": 6500, "ringStyle": 1 },
        { "pid": "std_0D", "style": 0, "min": 0, "max": 260, "x": 180, "y": 0, "w": 90, "h": 90, "warnHigh": 120 },
        { "pid": "std_05", "style": 0, "min": -40, "max": 215, "x": 270, "y": 0, "w": 90, "h": 90, "warnLow": 60, "warnHigh": 105 },
        { "pid": "std_42", "style": 0, "min": 0, "max": 20, "x": 180, "y": 90, "w": 90, "h": 90, "warnLow": 11.8, "warnHigh": 15.2 },
        { "pid": "std_11", "style": 0, "min": 0, "max": 100, "x": 270, "y": 90, "w": 90, "h": 90 }
      ]
    }
    """.trimIndent()

    @Test
    fun `用户那份失败文件必须解析通过且坐标不被放大`() {
        val r = DesignFile.parse(userFile)

        // 1) 不能有硬错误 —— 有的话用户看到的就是"设计文件有错误"对话框，什么都不会导入
        assertTrue("解析报了硬错误：${r.errors}", r.errors.isEmpty())

        val d = r.design
        requireNotNull(d) { "parse 没有返回 file（errors=${r.errors}）" }
        assertEquals(5, d.gauges.size)

        // 2) 坐标必须留在 0..360 —— 没注入 unit 标记的话会 ×360，
        //    表盘会跑到 y=16200 那种地方（= 屏幕外，画布看起来就是空的）
        val g0 = d.gauges[0]
        assertEquals("x 被放大了", 0f, g0.x, 0.01f)
        assertEquals("y 被放大了", 45f, g0.y, 0.01f)
        assertEquals("w 被放大了", 180f, g0.w, 0.01f)
        assertEquals("h 被放大了", 180f, g0.h, 0.01f)

        // 3) 5 个 PID 都必须能在内置库里查到（查不到会被 DashRenderer 静默过滤掉）
        d.gauges.forEach { g ->
            assertTrue("PID 库里没有 ${g.pidId}", Store.findPid(g.pidId) != null)
        }
    }
}
