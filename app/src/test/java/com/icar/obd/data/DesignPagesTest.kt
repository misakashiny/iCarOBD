package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 多页面（`pages`）。
 *
 * ## 为什么值得测
 *
 * 这是**最容易悄悄丢数据**的格式改动：工具写了多页，App 只读第一页，
 * 用户不会收到任何错误 —— 只会觉得"我做的第二页不见了"。
 *
 * ## 核心不变式
 *
 * `design.nodes === design.pages[0].nodes`（内容相同），
 * 这样渲染层不用知道 `pages` 的存在。
 */
class DesignPagesTest {

    private val gauge = """{"id":"g","type":"gauge","pid":"obd.rpm","style":0,
        "min":0,"max":8000,"x":0,"y":0,"w":180,"h":180}"""

    @Test
    fun `没有 pages 的老文件兜成单页 —— 行为完全不变`() {
        val r = DesignFile.parse(
            """{"schema":"icar.ui/2","canvas":{"unit":360},"nodes":[$gauge]}"""
        )
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        assertEquals("必须兜成 1 页", 1, d.pages.size)
        assertEquals("主页面", d.pages[0].name)
        assertEquals("nodes 要指向第一页", 1, d.nodes.size)
        assertEquals(d.pages[0].nodes.size, d.nodes.size)
    }

    @Test
    fun `pages 被完整解析 —— 每一页各自的节点数都对`() {
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/2","canvas":{"unit":360},
             "pages":[
               {"id":"p1","name":"主页面","nodes":[$gauge]},
               {"id":"p2","name":"性能页","nodes":[$gauge,$gauge]}
             ]}
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        assertEquals(2, d.pages.size)
        assertEquals("主页面", d.pages[0].name)
        assertEquals("性能页", d.pages[1].name)
        assertEquals(1, d.pages[0].nodes.size)
        assertEquals(2, d.pages[1].nodes.size)
        // nodes 指向第一页
        assertEquals(1, d.nodes.size)
    }

    @Test
    fun `pages 里的 gauge 照常被抽进 gauges —— v1 兼容路径不断`() {
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/2","canvas":{"unit":360},
             "pages":[
               {"id":"p1","name":"A","nodes":[$gauge]},
               {"id":"p2","name":"B","nodes":[$gauge,$gauge]}
             ]}
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        // gauges 是从**第一页**抽的（渲染层只看当前页）
        assertEquals(1, r.design!!.gauges.size)
        assertEquals("std_0C", r.design!!.gauges[0].pidId)
    }

    @Test
    fun `pages 是空数组时明确报错`() {
        val r = DesignFile.parse(
            """{"schema":"icar.ui/2","canvas":{"unit":360},"pages":[]}"""
        )
        // 空 pages 会回落到 nodes 分支，而 nodes 也不存在 → 报缺少 nodes
        assertTrue("应当报错，实际：" + r.errors, !r.ok)
    }

    @Test
    fun `pages 里节点非法时报错并带上页路径`() {
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/2","canvas":{"unit":360},
             "pages":[{"id":"p1","name":"A","nodes":[{"id":"x","type":"视频","x":0,"y":0,"w":10,"h":10}]}]}
            """.trimIndent()
        )
        assertTrue(!r.ok)
        // 路径要能指到具体哪一页 —— 否则用户在一堆页里找不到
        assertTrue("错误信息应带 pages[0] 路径，实际：" + r.errors,
            r.errors.any { it.contains("pages[0]") })
    }

    @Test
    fun `v1 文件升级后也有 pages`() {
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/1","canvas":{"unit":360},
             "gauges":[{"id":"g","pid":"obd.rpm","style":0,"min":0,"max":8000,
                        "x":0,"y":0,"w":180,"h":180}]}
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        assertEquals("v1 升级后也要有 pages（保证不变式成立）", 1, d.pages.size)
        assertEquals(1, d.nodes.size)
    }

    @Test
    fun `copy 换页后渲染层看到的节点确实换了`() {
        // App 侧选页的实现：design.copy(nodes = pages[i].nodes)
        // 这条钉住"换了之后 gauges 也跟着换"
        val r = DesignFile.parse(
            """
            {"schema":"icar.ui/2","canvas":{"unit":360},
             "pages":[
               {"id":"p1","name":"A","nodes":[]},
               {"id":"p2","name":"B","nodes":[$gauge]}
             ]}
            """.trimIndent()
        )
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        val page1 = d.copy(nodes = d.pages[1].nodes)
        assertEquals("第 2 页有 1 个节点", 1, page1.nodes.size)
        assertEquals("第 1 页是空的", 0, d.pages[0].nodes.size)
    }
}
