package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **v1 与 v2 两条路必须算出同一份 `gauges[]`**（v1.20.20）。
 *
 * ## 这条测试治的是哪个病
 *
 * `DesignFile.parse` 有两条入口：
 *
 *  - **v1**：扁平 `gauges[]` → [DesignFile.parseGauge]
 *  - **v2**：节点树 `nodes[]` → [DesignNode.parse]（`type == "gauge"` 的分支）
 *
 * 两条路最终都要调 `GaugeItem.fromJson`。而 `fromJson` 靠元素自己的
 * **`unit` 字段**判断坐标单位：没有该字段 = 老配置的归一化 0..1，读到要 **×360**。
 * 设计文件的单位声明在 `canvas.unit` 上，元素里没有 —— 所以**两条路都必须注入**。
 *
 * v1 注入了（`parseGauge` 里那句 "这个坑是单测抓出来的"），v2 只注入了 `pid`。
 * 结果：一份 v2 设计里 `x=30 w=180` 的仪表节点，`gauges[0]` 拿到
 * `x=10800 w=64800` —— 于是导入确认框弹出假警报
 * 「超出画布右下角：右=75600」。
 *
 * ## 为什么原来没抓到
 *
 * `DesignFileTest.v2 的节点树能被解析且仪表照常抽出来` 那条断言的是
 * `assertEquals(0f, d.gauges[0].x)` —— **x=0 时 ×360 是个恒等变换**，
 * 所以那个 bug 在断言底下安然通过。这条测试特意用**非 0 且非 1**的坐标。
 */
class DesignCoordUnitTest {

    private fun v1(gauges: String) = """
        {
          "schema": "icar.ui/1",
          "canvas": {"unit":360},
          "gauges": [$gauges]
        }
    """.trimIndent()

    private fun v2(nodes: String) = """
        {
          "schema": "icar.ui/2",
          "canvas": {"unit":360},
          "nodes": [$nodes]
        }
    """.trimIndent()

    /**
     * 同一块表的两种写法。**必须逐字段相等** —— 这是 v1/v2 的等价契约。
     *
     * ⚠️ 坐标刻意取 `x=30 y=40 w=180 h=120`：
     * 都是非 0、非 1 的数，`×360` 一眼就能看出来（30→10800、180→64800）。
     */
    private val v1Gauge =
        """{"pid":"obd.rpm","style":0,"min":0,"max":8000,"x":30,"y":40,"w":180,"h":120}"""
    private val v2Gauge =
        """{"id":"n1","type":"gauge","pid":"obd.rpm","style":0,"min":0,"max":8000,"x":30,"y":40,"w":180,"h":120}"""

    @Test
    fun `v2 节点树的坐标不被乘 360`() {
        val r = DesignFile.parse(v2(v2Gauge))
        assertTrue(r.errors.toString(), r.ok)
        val g = r.design!!.gauges[0]
        assertEquals("x 被乘了 360", 30f, g.x, 1e-3f)
        assertEquals("y 被乘了 360", 40f, g.y, 1e-3f)
        assertEquals("w 被乘了 360", 180f, g.w, 1e-3f)
        assertEquals("h 被乘了 360", 120f, g.h, 1e-3f)
    }

    @Test
    fun `v1 与 v2 两条路算出的 gauges 逐字段一致`() {
        val a = DesignFile.parse(v1(v1Gauge)).design!!.gauges[0]
        val b = DesignFile.parse(v2(v2Gauge)).design!!.gauges[0]
        assertEquals("pidId", a.pidId, b.pidId)
        assertEquals("style", a.style, b.style)
        assertEquals("min", a.minVal, b.minVal, 1e-3f)
        assertEquals("max", a.maxVal, b.maxVal, 1e-3f)
        assertEquals("x", a.x, b.x, 1e-3f)
        assertEquals("y", a.y, b.y, 1e-3f)
        assertEquals("w", a.w, b.w, 1e-3f)
        assertEquals("h", a.h, b.h, 1e-3f)
        assertEquals("legacyGrid", a.legacyGrid, b.legacyGrid)
    }

    /**
     * 分组里的仪表同样不能被乘 360。
     *
     * 这条单独写是因为 `children` 走的是**递归**调用 —— 注入 `unit` 的修复
     * 如果在递归路径上漏掉（比如只在根节点分支里做），只有根节点是对的。
     */
    @Test
    fun `分组里的仪表坐标也不被乘 360`() {
        val nested = """
            {"id":"g1","type":"group","name":"组","x":0,"y":0,"w":200,"h":200,"z":1,
             "children":[
               {"id":"n1","type":"gauge","pid":"obd.speed","style":0,"min":0,"max":240,
                "x":30,"y":40,"w":180,"h":120}
             ]}
        """.trimIndent()
        val r = DesignFile.parse(v2(nested))
        assertTrue(r.errors.toString(), r.ok)
        val g = r.design!!.gauges[0]
        assertEquals(30f, g.x, 1e-3f)
        assertEquals(40f, g.y, 1e-3f)
        assertEquals(180f, g.w, 1e-3f)
        assertEquals(120f, g.h, 1e-3f)
    }

    /**
     * **假警报必须消失**：`x=30 w=180` 完全在画布内（30+180=210 ≤ 360）。
     *
     * 修复前这里会多出一条「超出画布右下角：右=75600」——
     * 它的代价不只是难看：用户会学会无视整个警告列表，而这一版恰恰要靠
     * 这个列表说清"缺了哪个素材"。
     */
    @Test
    fun `v2 正常坐标不产生越界假警报`() {
        val r = DesignFile.parse(v2(v2Gauge))
        assertTrue(r.errors.toString(), r.ok)
        assertFalse(
            "不该有越界警告，实际：${r.warnings}",
            r.warnings.any { it.contains("超出画布") }
        )
    }

    /**
     * **v1 与 v2 的越界判定必须同进同退**。
     *
     * 真正的越界（x=300 w=180 → 480 > 360）两条路都要报；
     * 修复前 v2 会因为 ×360 而**对每一块表都报**，把真警报淹掉。
     */
    @Test
    fun `真越界两条路都报 且文案一致`() {
        // 300 + 180 = 480 > 360，是真越界（不是 ×360 造出来的）
        val a = DesignFile.parse(
            v1("""{"pid":"obd.rpm","x":300,"y":0,"w":180,"h":180}""")
        )
        val b = DesignFile.parse(
            v2("""{"id":"n1","type":"gauge","pid":"obd.rpm","x":300,"y":0,"w":180,"h":180}""")
        )
        assertTrue("v1 应当能加载：${a.errors}", a.ok)
        assertTrue("v2 应当能加载：${b.errors}", b.ok)
        val wa = a.warnings.first { it.contains("超出画布") }
        val wb = b.warnings.first { it.contains("超出画布") }
        // 文案里的数字必须一致（路径前缀可以不同：`gauges[0]` vs 节点路径）
        assertEquals(wa.substringAfter("超出画布"), wb.substringAfter("超出画布"))
    }

    /**
     * `legacyGrid` 是**同一个岔口的第二根枝**。
     *
     * v1 的 `parseGauge` 结尾显式 `.also { it.legacyGrid = false }` ——
     * "设计文件里的表永远不是旧网格配置"。v2 原来没有这一句，
     * 于是 `GaugeItem.fromJson` 会按"元素里有没有 x/y/w/h"自行置位。
     *
     * 置位的后果不是"少画一块表"：`DashLayout.migrateFromGrid` 一旦看到
     * 任何一条 `legacyGrid`，就会把**整张盘**的 x/y/w/h 按 2 列网格重算一遍。
     */
    @Test
    fun `v2 抽出的仪表不是旧网格配置`() {
        val b = DesignFile.parse(v2(v2Gauge)).design!!.gauges[0]
        assertFalse("v2 设计里的表不该被当成 v1.4.0 的网格配置", b.legacyGrid)
        val a = DesignFile.parse(v1(v1Gauge)).design!!.gauges[0]
        assertEquals(a.legacyGrid, b.legacyGrid)
    }

    /**
     * **多页面**（`pages[i].nodes`）走的是另一条 `parseNodeArray` 入口。
     *
     * 同一个 bug 的第三种入口 —— 修 `unit` 时如果只改了顶层 `nodes` 分支，
     * 多页面设计会照旧 ×360。这条把它钉住。
     */
    @Test
    fun `多页面设计里的仪表坐标也不被乘 360`() {
        val multi = """
            {
              "schema":"icar.ui/2","canvas":{"unit":360},
              "pages":[
                {"id":"pg0","name":"主页面","nodes":[$v2Gauge]},
                {"id":"pg1","name":"第二页","nodes":[$v2Gauge]}
              ]
            }
        """.trimIndent()
        val r = DesignFile.parse(multi)
        assertTrue(r.errors.toString(), r.ok)
        val d = r.design!!
        assertEquals(2, d.pages.size)
        assertEquals(1, d.gauges.size)
        assertEquals(30f, d.gauges[0].x, 1e-3f)
        assertEquals(180f, d.gauges[0].w, 1e-3f)
        // 每一页的节点坐标同样正确
        d.pages.forEach { p ->
            val n = DesignNode.flatten(p.nodes).first { it.isGauge }
            assertEquals(30f, n.x, 1e-3f)
            assertEquals(180f, n.w, 1e-3f)
        }
    }

    /**
     * 节点自身的 x/y/w/h 与抽出的 `gauge` 必须**说的是同一件事**。
     *
     * 渲染走节点树、`Store.customGauges` 走 `gauges[]` —— 两者对不上时，
     * 画面是对的、而「清除导入的设计文件」之后整盘表会跑到屏幕外
     * （这正是这个 bug 的真实危害：它不在渲染路径上，在**回退路径**上）。
     */
    @Test
    fun `节点几何与抽出的 gauge 几何一致`() {
        val d = DesignFile.parse(v2(v2Gauge)).design!!
        val n = DesignNode.flatten(d.nodes).first { it.isGauge }
        val g = d.gauges[0]
        assertEquals(n.x, g.x, 1e-3f)
        assertEquals(n.y, g.y, 1e-3f)
        assertEquals(n.w, g.w, 1e-3f)
        assertEquals(n.h, g.h, 1e-3f)
    }
}
