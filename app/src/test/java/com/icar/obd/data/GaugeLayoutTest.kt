package com.icar.obd.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 仪表布局模型 + 旧配置迁移 + 预设布局的单元测试。
 *
 * 这一层特别值得测，因为：
 *  - 迁移只有一次机会（跑完就回写成新格式），错了老用户的布局就毁了；
 *  - 预设里的坐标是手写的，越界不会报错、只会「看不见那个表」。
 *
 * ## 坐标系
 *
 * v1.8.0 起坐标是**每轴 0..`GaugeItem.CANVAS`（360）**，不再用归一化 0..1。
 * 测试里统一用 [u] 把归一化值换算过去 —— 这样断言仍然读得懂
 * （`u(0.5f)` 一眼知道是「一半」），也不至于到处写 `180f`。
 */
class GaugeLayoutTest {

    /** 画布边长 */
    private val C = GaugeItem.CANVAS

    /** 归一化 0..1 → 画布单位 */
    private fun u(norm: Float) = norm * C

    private fun legacy(pid: String, style: Int, span: Int) =
        GaugeItem(pidId = pid, style = style, span = span).also { it.legacyGrid = true }

    // ================================================================ JSON 往返

    @Test
    fun `新格式 JSON 往返保留全部字段`() {
        val src = GaugeItem(
            pidId = "std_0C",
            extraPids = mutableListOf("std_0D", "std_04"),
            style = GaugeItem.STYLE_QUAD,
            minVal = 0f, maxVal = 8000f,
            warnLow = 1f, warnHigh = 6500f,
            color = 0xFF00FF00.toInt(),
            span = 2,
            x = u(0.25f), y = u(0.5f), w = u(0.5f), h = u(0.25f),
            role = GaugeItem.ROLE_SECONDARY,
            ringStyle = GaugeItem.RING_TICK,
            ringSegments = 60
        )
        val back = GaugeItem.fromJson(JSONObject(src.toJson().toString()))

        assertEquals("std_0C", back.pidId)
        assertEquals(listOf("std_0D", "std_04"), back.extraPids)
        assertEquals(GaugeItem.STYLE_QUAD, back.style)
        assertEquals(8000f, back.maxVal, 1e-6f)
        assertEquals(1f, back.warnLow!!, 1e-6f)
        assertEquals(6500f, back.warnHigh!!, 1e-6f)
        assertEquals(2, back.span)
        assertEquals(u(0.25f), back.x, 1e-4f)
        assertEquals(u(0.5f), back.y, 1e-4f)
        assertEquals(u(0.5f), back.w, 1e-4f)
        assertEquals(u(0.25f), back.h, 1e-4f)
        assertEquals(GaugeItem.ROLE_SECONDARY, back.role)
        assertEquals(GaugeItem.RING_TICK, back.ringStyle)
        assertEquals(60, back.ringSegments)
        assertFalse("新格式不应被标记为待迁移", back.legacyGrid)
    }

    @Test
    fun `旧格式 JSON（归一化坐标 无 unit 字段）自动乘 360`() {
        // v1.7.0 及以前存的是归一化 0..1，且没有 "unit" 字段
        val g = GaugeItem.fromJson(
            JSONObject("""{"pid":"std_0D","style":0,"x":0.5,"y":0.25,"w":0.5,"h":0.2}""")
        )
        assertFalse(g.legacyGrid)
        assertEquals(u(0.5f), g.x, 1e-4f)
        assertEquals(u(0.25f), g.y, 1e-4f)
        assertEquals(u(0.5f), g.w, 1e-4f)
        assertEquals(u(0.2f), g.h, 1e-4f)
    }

    @Test
    fun `带 unit 360 的 JSON 不再二次换算`() {
        val g = GaugeItem.fromJson(
            JSONObject("""{"pid":"std_0D","unit":360,"x":180,"y":90,"w":180,"h":72}""")
        )
        assertEquals(180f, g.x, 1e-4f)
        assertEquals(90f, g.y, 1e-4f)
        assertEquals(180f, g.w, 1e-4f)
        assertEquals(72f, g.h, 1e-4f)
    }

    @Test
    fun `旧格式 JSON（只有 span 没有坐标）被标记为待迁移`() {
        val g = GaugeItem.fromJson(JSONObject("""{"pid":"std_0D","style":0,"min":0,"max":240,"span":2}"""))
        assertTrue(g.legacyGrid)
        assertEquals(2, g.span)
        assertEquals(240f, g.maxVal, 1e-6f)
    }

    @Test
    fun `缺失的可选字段用默认值`() {
        val g = GaugeItem.fromJson(JSONObject("""{"pid":"std_0C"}"""))
        assertEquals(GaugeItem.STYLE_CIRCLE, g.style)
        assertEquals(100f, g.maxVal, 1e-6f)
        assertNull(g.warnLow)
        assertNull(g.warnHigh)
        assertTrue(g.extraPids.isEmpty())
        assertEquals(GaugeItem.ROLE_PRIMARY, g.role)
        assertEquals(GaugeItem.RING_NONE, g.ringStyle)
        assertEquals(40, g.ringSegments)
    }

    // ================================================================ 迁移

    @Test
    fun `两条 span2 迁移为上下两个整宽`() {
        val items = mutableListOf(
            legacy("a", GaugeItem.STYLE_CIRCLE, 2),
            legacy("b", GaugeItem.STYLE_CIRCLE, 2)
        )
        assertTrue(DashLayout.migrateFromGrid(items))

        assertEquals(0f, items[0].x, 1e-4f)
        assertEquals(0f, items[0].y, 1e-4f)
        assertEquals(C, items[0].w, 1e-4f)
        assertEquals(u(0.5f), items[0].h, 1e-4f)

        assertEquals(0f, items[1].x, 1e-4f)
        assertEquals(u(0.5f), items[1].y, 1e-4f)
        assertEquals(C, items[1].w, 1e-4f)
        assertEquals(u(0.5f), items[1].h, 1e-4f)

        assertFalse("迁移后应清除标记", items[0].legacyGrid)
    }

    @Test
    fun `四条 span1 迁移为 2x2 网格`() {
        val items = mutableListOf(
            legacy("a", GaugeItem.STYLE_BAR, 1),
            legacy("b", GaugeItem.STYLE_BAR, 1),
            legacy("c", GaugeItem.STYLE_BAR, 1),
            legacy("d", GaugeItem.STYLE_BAR, 1)
        )
        assertTrue(DashLayout.migrateFromGrid(items))

        assertEquals(0f, items[0].x, 1e-4f)
        assertEquals(0f, items[0].y, 1e-4f)
        assertEquals(u(0.5f), items[0].w, 1e-4f)

        assertEquals(u(0.5f), items[1].x, 1e-4f)
        assertEquals(0f, items[1].y, 1e-4f)

        assertEquals(0f, items[2].x, 1e-4f)
        assertEquals(u(0.5f), items[2].y, 1e-4f)

        assertEquals(u(0.5f), items[3].x, 1e-4f)
        assertEquals(u(0.5f), items[3].y, 1e-4f)
    }

    @Test
    fun `行高按该行最高样式占比`() {
        // 第一行：圆表(186) + 数字(92) → 行高按 186；第二行：两条条形(54)
        val items = mutableListOf(
            legacy("a", GaugeItem.STYLE_CIRCLE, 1),
            legacy("b", GaugeItem.STYLE_DIGITAL, 1),
            legacy("c", GaugeItem.STYLE_BAR, 1),
            legacy("d", GaugeItem.STYLE_BAR, 1)
        )
        DashLayout.migrateFromGrid(items)
        val total = 186f + 54f
        assertEquals(u(186f / total), items[0].h, 1e-3f)
        assertEquals(u(186f / total), items[1].h, 1e-3f)
        assertEquals(u(54f / total), items[2].h, 1e-3f)
        assertEquals(u(186f / total), items[2].y, 1e-3f)
    }

    @Test
    fun `迁移结果始终落在画布内且铺满`() {
        val items = mutableListOf(
            legacy("a", GaugeItem.STYLE_CIRCLE, 2),
            legacy("b", GaugeItem.STYLE_BAR, 1),
            legacy("c", GaugeItem.STYLE_BAR, 1),
            legacy("d", GaugeItem.STYLE_DIGITAL, 2)
        )
        DashLayout.migrateFromGrid(items)

        items.forEach {
            assertTrue("x 越界 ${it.x}", it.x >= 0f && it.x <= C)
            assertTrue("y 越界 ${it.y}", it.y >= 0f && it.y <= C)
            assertTrue("w 非正", it.w > 0f)
            assertTrue("h 非正", it.h > 0f)
            assertTrue("右边界越界 ${it.x + it.w}", it.x + it.w <= C + 1e-3f)
            assertTrue("下边界越界 ${it.y + it.h}", it.y + it.h <= C + 1e-3f)
        }
        // 纵向应当正好铺满
        assertEquals(C, items.maxOf { it.y + it.h }, 1e-3f)
        // 第一行横向也应当铺满
        val topRow = items.filter { it.y < 1e-3f }
        assertEquals(C, topRow.sumOf { it.w.toDouble() }.toFloat(), 1e-3f)
    }

    @Test
    fun `没有待迁移项时不做任何改动`() {
        val items = mutableListOf(GaugeItem(pidId = "a", x = u(0.1f), y = u(0.2f), w = u(0.3f), h = u(0.4f)))
        assertFalse(DashLayout.migrateFromGrid(items))
        assertEquals(u(0.1f), items[0].x, 1e-4f)
        assertEquals(u(0.2f), items[0].y, 1e-4f)
        assertEquals(u(0.3f), items[0].w, 1e-4f)
        assertEquals(u(0.4f), items[0].h, 1e-4f)
    }

    @Test
    fun `空列表迁移不崩`() {
        val items = mutableListOf<GaugeItem>()
        assertFalse(DashLayout.migrateFromGrid(items))
    }

    // ================================================================ 预设

    @Test
    fun `七个预设都存在且非空`() {
        val ps = DashLayout.presets()
        assertEquals(7, ps.size)
        assertEquals(
            listOf("normal", "perf", "line", "dual", "quad", "subdual", "gforce"),
            ps.map { it.id }
        )
        ps.forEach { assertTrue("预设 ${it.id} 不应为空", it.build().isNotEmpty()) }
    }

    @Test
    fun `预设坐标全部落在画布内且纵向铺满`() {
        DashLayout.presets().forEach { p ->
            val items = p.build()
            items.forEach { g ->
                assertTrue("${p.id}: x 越界 ${g.x}", g.x >= -1e-2f && g.x <= C + 1e-2f)
                assertTrue("${p.id}: y 越界 ${g.y}", g.y >= -1e-2f && g.y <= C + 1e-2f)
                assertTrue("${p.id}: w 非正", g.w > 0f)
                assertTrue("${p.id}: h 非正", g.h > 0f)
                assertTrue("${p.id}: 右边界越界 ${g.x + g.w}", g.x + g.w <= C + 1e-2f)
                assertTrue("${p.id}: 下边界越界 ${g.y + g.h}", g.y + g.h <= C + 1e-2f)
            }
            assertEquals("${p.id} 应纵向铺满", C, items.maxOf { it.y + it.h }, 1e-2f)
        }
    }

    @Test
    fun `预设引用的 PID 都真实存在`() {
        val known = BuiltInPids.all().map { it.id }.toSet()
        DashLayout.presets().forEach { p ->
            p.build().forEach { g ->
                assertTrue("${p.id}: 主参数 ${g.pidId} 不在 PID 库里", g.pidId in known)
                g.extraPids.forEach { e ->
                    assertTrue("${p.id}: 副参数 $e 不在 PID 库里", e in known)
                }
            }
        }
    }

    @Test
    fun `预设量程取自 PID 库而不是写死`() {
        val rpm = BuiltInPids.all().first { it.id == "std_0C" }
        val gauge = DashLayout.perf().first { it.pidId == "std_0C" }
        assertEquals(rpm.maxVal, gauge.maxVal, 1e-6f)
        assertEquals(rpm.warnHigh!!, gauge.warnHigh!!, 1e-6f)
    }

    @Test
    fun `多数据显示类预设确实带了副参数`() {
        assertTrue(DashLayout.dualStack().all { it.extraPids.size == 1 })
        assertTrue(DashLayout.quad().all { it.extraPids.size == 3 })
        assertTrue(DashLayout.subDual().all { it.extraPids.size == 2 })
        val gf = DashLayout.gForce().first { it.style == GaugeItem.STYLE_GFORCE }
        assertEquals(listOf("calc_gx", "calc_gy"), gf.extraPids)
    }

    @Test
    fun `未知预设 id 返回 null`() {
        assertNull(DashLayout.byId("nope"))
        assertNotNull(DashLayout.byId("gforce"))
    }

    // ================================================================ allPidIds

    @Test
    fun `allPidIds 主参数在前 副参数在后`() {
        val g = GaugeItem(pidId = "a", extraPids = mutableListOf("b", "c"))
        assertEquals(listOf("a", "b", "c"), g.allPidIds())
    }

    @Test
    fun `allPidIds 过滤空串`() {
        val g = GaugeItem(pidId = "", extraPids = mutableListOf("", "b", ""))
        assertEquals(listOf("b"), g.allPidIds())
    }

    @Test
    fun `allPidIds 无副参数时只有主参数`() {
        assertEquals(listOf("std_0C"), GaugeItem(pidId = "std_0C").allPidIds())
    }

    // ================================================================ 拖拽数学
    //
    // 注意：Drag 现在工作在**画布单位**里（0..360），网格步长 15。
    // 下面仍用 u(...) 写归一化的意图，读起来直观。

    private fun onGrid(v: Float): Boolean =
        Math.abs(v / DashLayout.Drag.STEP - Math.round(v / DashLayout.Drag.STEP)) < 1e-3f

    @Test
    fun `snap 吸附到最近的网格`() {
        assertEquals(0f, DashLayout.Drag.snap(u(0.01f)), 1e-3f)
        assertEquals(DashLayout.Drag.STEP, DashLayout.Drag.snap(u(0.05f)), 1e-3f)
        assertEquals(u(0.5f), DashLayout.Drag.snap(u(0.5f)), 1e-3f)
        assertEquals(C, DashLayout.Drag.snap(u(0.999f)), 1e-3f)
    }

    @Test
    fun `move 不能拖出左边界`() {
        assertEquals(0f, DashLayout.Drag.move(u(0.1f), -u(0.5f), u(0.25f)), 1e-3f)
    }

    @Test
    fun `move 不能拖出右边界`() {
        // w=0.25 → x 最大 0.75
        assertEquals(u(0.75f), DashLayout.Drag.move(u(0.5f), u(0.9f), u(0.25f)), 1e-3f)
    }

    @Test
    fun `反复拖动后始终不出界`() {
        // 步长必须大于半格（7.5 单位），否则吸附会把位移吃掉、原地不动
        var x = u(0.37f)
        repeat(30) {
            x = DashLayout.Drag.move(x, u(0.06f), u(0.2f))
            assertTrue("x 越界 $x", x >= -1e-3f && x <= u(0.8f) + 1e-3f)
            // 贴边被夹取时允许不在网格上（边界值 C-size 本身不一定是网格整数倍）；
            // 中间位置必须严格吸附
            if (x > 1e-3f && x < u(0.8f) - 1e-3f) {
                assertTrue("x=$x 不在网格上", onGrid(x))
            }
        }
        assertEquals("反复右拖应最终贴住右边界", u(0.8f), x, 1e-3f)
    }

    @Test
    fun `resize 不能小于最小尺寸`() {
        assertEquals(DashLayout.Drag.MIN_SIZE, DashLayout.Drag.resize(u(0.3f), -u(0.9f), 0f), 1e-3f)
    }

    @Test
    fun `resize 不能超出画布右边界`() {
        // pos=0.5 → w 最大 0.5
        assertEquals(u(0.5f), DashLayout.Drag.resize(u(0.3f), u(0.9f), u(0.5f)), 1e-3f)
    }

    @Test
    fun `反复缩放后始终不小于最小尺寸`() {
        var w = u(0.4f)
        repeat(30) {
            w = DashLayout.Drag.resize(w, -u(0.05f), u(0.1f))
            assertTrue("w 太小 $w", w >= DashLayout.Drag.MIN_SIZE - 1e-3f)
            assertTrue("w 越界 $w", w <= u(0.9f) + 1e-3f)
            // 最小尺寸是网格整数倍，所以夹到下界也仍在网格上
            assertTrue("w=$w 不在网格上", onGrid(w))
        }
        assertEquals("反复缩小应最终停在最小尺寸", DashLayout.Drag.MIN_SIZE, w, 1e-3f)
    }

    @Test
    fun `最小尺寸本身就在网格上`() {
        assertTrue("MIN_SIZE 必须是网格整数倍，否则夹取后会落在网格外", onGrid(DashLayout.Drag.MIN_SIZE))
    }

    @Test
    fun `网格步长与画布单位自洽`() {
        assertEquals("360 / 24 应为 15，不能有浮点误差", 15f, DashLayout.Drag.STEP, 1e-6f)
        assertEquals("最小尺寸应为 2 格", 30f, DashLayout.Drag.MIN_SIZE, 1e-6f)
    }

    // ================================================================ 吸附开关（v1.10.2）

    @Test
    fun `关掉吸附后可以停在任意坐标`() {
        // 想微调 3 个单位却被吸到 15 的倍数上，是拖拽编辑器最常见的抱怨
        assertEquals("关掉吸附必须原样返回", 7f, DashLayout.Drag.snapIf(false, 7f), 1e-6f)
        // 开着吸附：7 离 0（差 7）比离 15（差 8）更近 → 吸到 0
        assertEquals("开着吸附吸到最近的网格", 0f, DashLayout.Drag.snapIf(true, 7f), 1e-6f)
        assertEquals("8 离 15 更近 → 吸到 15", 15f, DashLayout.Drag.snapIf(true, 8f), 1e-6f)
    }

    @Test
    fun `关掉吸附后移动仍不能拖出画布`() {
        // ⚠️ 这是关键：开关关掉的是「对齐网格」，不是「允许拖出画布」。
        // 把仪表拖到看不见的地方没有任何用途。
        val size = 100f
        assertEquals(
            "左边仍要夹住",
            0f, DashLayout.Drag.moveIf(false, 7f, -50f, size), 1e-6f
        )
        assertEquals(
            "右边仍要夹住（360 - 100 = 260）",
            260f, DashLayout.Drag.moveIf(false, 200f, 200f, size), 1e-6f
        )
    }

    @Test
    fun `关掉吸附后缩放仍受最小尺寸与边界约束`() {
        assertEquals(
            "不能小于 MIN_SIZE",
            DashLayout.Drag.MIN_SIZE,
            DashLayout.Drag.resizeIf(false, 40f, -100f, 0f), 1e-6f
        )
        assertEquals(
            "不能超出右边界（pos=300 → 最大 60）",
            60f, DashLayout.Drag.resizeIf(false, 40f, 100f, 300f), 1e-6f
        )
    }

    @Test
    fun `吸附开着时 moveIf 与 move 完全等价`() {
        // 保证引入开关没有悄悄改掉既有手感
        val cases = listOf(
            Triple(0f, 0f, 100f), Triple(7f, 23f, 100f), Triple(200f, -300f, 100f)
        )
        cases.forEach { (orig, delta, size) ->
            assertEquals(
                DashLayout.Drag.move(orig, delta, size),
                DashLayout.Drag.moveIf(true, orig, delta, size),
                1e-6f
            )
        }
    }

    @Test
    fun `默认仪表就是普通驾驶预设`() {
        assertEquals(
            DashLayout.normal().map { it.pidId },
            Defaults.defaultGauges().map { it.pidId }
        )
    }
}
