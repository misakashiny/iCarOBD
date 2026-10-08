package com.icar.obd.data

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * **双指手势映射**（v1.20.9；v1.20.10 加「切上/下一个 tab」）：
 * 方向判定 / 取值归一化 / 摘要文案 / 落盘 / **循环切 tab 的边界**。
 *
 * ## 为什么这批用例值得写
 *
 * 1. **方向判定在真机上验不了** —— `adb input swipe` 只能发**单指**，
 *    双指手势只能靠用户的手指。也就是说"上下左右判对了没有"**只能靠单测**。
 * 2. **旧配置的兜底是这一版最危险的一处**：v1.20.8 及以前的 `settings.json`
 *    根本没有这四个键，兜错了的表现是"升级之后手势全没了"——
 *    而那时用户只会说"新版有问题"，现场（旧配置）已经没了。
 * 3. **循环边界**（v1.20.10）：最后一个 tab 的"下一个"要回到第一个、
 *    第一个的"上一个"要到最后一个。写错的表现是"在知识库页往上滑一下没反应"，
 *    而用户不会想到"这是最后一项" —— 他只会说"手势时灵时不灵"。
 *
 * `Store` 是单例且会落盘，所以每个用例前都指到临时目录（与 `DashCanvasTest` 同一套做法）。
 */
class GestureActionsTest {

    private lateinit var dir: File

    @Before
    fun setUp() {
        dir = Files.createTempDirectory("icarobd-gesture-test").toFile()
        AppLog.init(dir)
        Store.init(dir)
        Store.settings = Store.Settings()
    }

    @After
    fun tearDown() {
        // Windows 上目录删除会因为 AppLog 的常开写句柄而静默失败 —— 见 BackupTest 的同类处理
        runCatching { AppLog.shutdown() }
        repeat(3) { attempt ->
            dir.walkBottomUp().forEach { runCatching { it.delete() } }
            if (!dir.exists()) return
            if (attempt < 2) Thread.sleep(50L * (attempt + 1))
        }
        if (dir.exists()) dir.deleteOnExit()
    }

    // ================================================================ 出厂默认

    @Test
    fun `默认值保持升级前的手感：右滑呼出 左滑收起 上下翻画布`() {
        assertEquals(GestureActions.NAV_HIDE, GestureActions.DEFAULTS[GestureActions.SLOT_LEFT])
        assertEquals(GestureActions.NAV_SHOW, GestureActions.DEFAULTS[GestureActions.SLOT_RIGHT])
        assertEquals(GestureActions.CANVAS_NEXT, GestureActions.DEFAULTS[GestureActions.SLOT_UP])
        assertEquals(GestureActions.CANVAS_PREV, GestureActions.DEFAULTS[GestureActions.SLOT_DOWN])

        val s = Store.Settings()
        assertEquals(GestureActions.NAV_SHOW, s.gestureAt(GestureActions.SLOT_RIGHT))
        assertEquals(GestureActions.NAV_HIDE, s.gestureAt(GestureActions.SLOT_LEFT))
        assertEquals(GestureActions.CANVAS_NEXT, s.gestureAt(GestureActions.SLOT_UP))
        assertEquals(GestureActions.CANVAS_PREV, s.gestureAt(GestureActions.SLOT_DOWN))
    }

    @Test
    fun `动作 id 与动作名一一对应，数量一致`() {
        assertEquals(GestureActions.ACTION_IDS.size, GestureActions.ACTION_NAMES.size)
        assertEquals(GestureActions.SLOT_COUNT, GestureActions.SLOT_NAMES.size)
        assertEquals(GestureActions.SLOT_COUNT, GestureActions.DEFAULTS.size)
        // 每个默认值都必须是合法动作（写错一个字的后果是"手势永远不触发"）
        GestureActions.DEFAULTS.forEach {
            assertTrue("默认值 $it 不在可选动作里", GestureActions.ACTION_IDS.contains(it))
        }
    }

    // ============================================== v1.20.10 新增的两个动作

    @Test
    fun `可选动作是 7 个，且 id 与名都不重复`() {
        assertEquals(7, GestureActions.ACTION_IDS.size)
        assertEquals(7, GestureActions.ACTION_NAMES.size)
        assertEquals(GestureActions.ACTION_IDS.size, GestureActions.ACTION_IDS.distinct().size)
        assertEquals(GestureActions.ACTION_NAMES.size, GestureActions.ACTION_NAMES.distinct().size)
        // 中文名不许有空白项（Spinner 里会出现一个看不见的选项）
        GestureActions.ACTION_NAMES.forEach { assertTrue("动作名不该为空", it.isNotBlank()) }
    }

    @Test
    fun `两个新动作的默认值是「无」—— 升级不改变现有手感`() {
        // 这是本版最要紧的一条：v1.20.9 及以前根本没有这两个动作，
        // 升级后任何一个方向突然开始切页，用户只会认为"手势坏了"
        GestureActions.DEFAULTS.forEach {
            assertTrue("默认值 $it 里不该出现新动作", !GestureActions.isTabAction(it))
        }
        // 出厂默认的四个槽位，逐个再确认一遍
        for (slot in 0 until GestureActions.SLOT_COUNT) {
            val def = GestureActions.DEFAULTS[slot]
            assertTrue("槽位 $slot 的默认值 $def 不该是切 tab", !GestureActions.isTabAction(def))
        }
    }

    @Test
    fun `7 个动作全部往返：normalize 认得、actionName 有名、actionIndex 指得回自己`() {
        GestureActions.ACTION_IDS.forEachIndexed { i, id ->
            // 读回：认得的 id 必须原样保留（四个槽位都试）
            for (slot in 0 until GestureActions.SLOT_COUNT) {
                assertEquals("槽位 $slot 认不得 $id", id, GestureActions.normalize(slot, id))
            }
            // 名字与下标必须一一对上（Spinner 靠 actionIndex，摘要靠 actionName）
            assertEquals(GestureActions.ACTION_NAMES[i], GestureActions.actionName(id))
            assertEquals(i, GestureActions.actionIndex(id))
        }
    }

    @Test
    fun `切 tab 两个动作能被写进配置并原样读回来`() {
        Store.settings.setGestureAt(GestureActions.SLOT_LEFT, GestureActions.TAB_NEXT)
        Store.settings.setGestureAt(GestureActions.SLOT_RIGHT, GestureActions.TAB_PREV)
        assertEquals(GestureActions.TAB_NEXT, Store.settings.gestureAt(GestureActions.SLOT_LEFT))
        assertEquals(GestureActions.TAB_PREV, Store.settings.gestureAt(GestureActions.SLOT_RIGHT))

        // 落盘 → 读回，一个字段都不能丢（写出去的是归一化后的值）
        val json = Store.settingsToJson()
        assertEquals(GestureActions.TAB_NEXT, json.getString("gestureLeft"))
        assertEquals(GestureActions.TAB_PREV, json.getString("gestureRight"))
        Store.applySettingsJson(JSONObject(json.toString()))
        assertEquals(GestureActions.TAB_NEXT, Store.settings.gestureAt(GestureActions.SLOT_LEFT))
        assertEquals(GestureActions.TAB_PREV, Store.settings.gestureAt(GestureActions.SLOT_RIGHT))
    }

    @Test
    fun `旧配置缺新键时取默认值（仍然是旧的五个动作，不会是切 tab）`() {
        // 这条模拟的正是"从 v1.20.9 升上来"：键在、但值只可能是旧五选一
        val old = JSONObject()
            .put("gestureLeft", GestureActions.NAV_HIDE)
            .put("gestureRight", GestureActions.NAV_SHOW)
            .put("gestureUp", GestureActions.CANVAS_NEXT)
            .put("gestureDown", GestureActions.CANVAS_PREV)
        Store.applySettingsJson(old)
        for (slot in 0 until GestureActions.SLOT_COUNT) {
            assertTrue(
                "槽位 $slot 读出了切 tab 动作",
                !GestureActions.isTabAction(Store.settings.gestureAt(slot))
            )
        }
        // 更旧的配置（连四个键都没有）同样不许出现切 tab
        Store.applySettingsJson(JSONObject().put("sound", true))
        for (slot in 0 until GestureActions.SLOT_COUNT) {
            assertEquals(GestureActions.DEFAULTS[slot], Store.settings.gestureAt(slot))
        }
    }

    // ==================================================== 循环切 tab（v1.20.10）

    @Test
    fun `循环顺序是仪表盘 连接 PID 规则 日志 知识库`() {
        assertEquals(
            listOf("dash", "connect", "pid", "rule", "log", "knowledge"),
            GestureActions.TAB_TAGS
        )
    }

    @Test
    fun `下一个 tab 依次走完六个页并回到第一个`() {
        val expected = listOf("connect", "pid", "rule", "log", "knowledge", "dash")
        var cur = GestureActions.TAB_TAGS.first()
        expected.forEach { want ->
            cur = GestureActions.adjacentTab(GestureActions.TAB_NEXT, cur)
                ?: error("从 $cur 找不到下一个")
            assertEquals(want, cur)
        }
    }

    @Test
    fun `上一个 tab 依次倒着走完六个页并回到最后一个`() {
        val expected = listOf("knowledge", "log", "rule", "pid", "connect", "dash")
        var cur = GestureActions.TAB_TAGS.first()
        expected.forEach { want ->
            cur = GestureActions.adjacentTab(GestureActions.TAB_PREV, cur)
                ?: error("从 $cur 找不到上一个")
            assertEquals(want, cur)
        }
    }

    @Test
    fun `循环边界：最后一个的下一个是第一个、第一个的上一个是最后一个`() {
        val last = GestureActions.TAB_TAGS.last()
        val first = GestureActions.TAB_TAGS.first()
        assertEquals(first, GestureActions.adjacentTab(GestureActions.TAB_NEXT, last))
        assertEquals(last, GestureActions.adjacentTab(GestureActions.TAB_PREV, first))
        // 位移形式也要一致（MainActivity 走的是 actionId 那个重载，两条路都得对）
        assertEquals(first, GestureActions.adjacentTab(last, 1))
        assertEquals(last, GestureActions.adjacentTab(first, -1))
    }

    @Test
    fun `六个 tab 各走一步都落在表内，且不会原地不动`() {
        GestureActions.TAB_TAGS.forEach { t ->
            val next = GestureActions.adjacentTab(GestureActions.TAB_NEXT, t)
            val prev = GestureActions.adjacentTab(GestureActions.TAB_PREV, t)
            assertTrue("$t 的下一个不在表里", GestureActions.TAB_TAGS.contains(next))
            assertTrue("$t 的上一个不在表里", GestureActions.TAB_TAGS.contains(prev))
            // 原地不动 = 用户划了一下什么都没发生
            assertTrue("$t 的下一个还是自己", next != t)
            assertTrue("$t 的上一个还是自己", prev != t)
            // 上一步再下一步必须回到原点（往返）
            assertEquals(t, GestureActions.adjacentTab(GestureActions.TAB_NEXT, prev))
            assertEquals(t, GestureActions.adjacentTab(GestureActions.TAB_PREV, next))
        }
    }

    @Test
    fun `认不得的当前页与非法位移都返回 null，不落回第一个`() {
        // 落回第一个 = 一次手势把用户从任何页面拽到仪表盘，那是"跳页"
        assertEquals(null, GestureActions.adjacentTab(GestureActions.TAB_NEXT, ""))
        assertEquals(null, GestureActions.adjacentTab(GestureActions.TAB_NEXT, null))
        assertEquals(null, GestureActions.adjacentTab(GestureActions.TAB_NEXT, "dashboard"))
        assertEquals(null, GestureActions.adjacentTab(GestureActions.TAB_NEXT, "dash "))
        assertEquals(null, GestureActions.adjacentTab("", "dash"))
        assertEquals(null, GestureActions.adjacentTab("tab_prevv", "dash"))
        assertEquals(null, GestureActions.adjacentTab(GestureActions.NAV_SHOW, "dash"))
        // 位移形式只认 ±1
        assertEquals(null, GestureActions.adjacentTab("dash", 0))
        assertEquals(null, GestureActions.adjacentTab("dash", 2))
        assertEquals(null, GestureActions.adjacentTab("dash", -3))
    }

    @Test
    fun `isTabAction 只认那两个，其余一律 false`() {
        assertTrue(GestureActions.isTabAction(GestureActions.TAB_NEXT))
        assertTrue(GestureActions.isTabAction(GestureActions.TAB_PREV))
        listOf(
            GestureActions.NONE, GestureActions.NAV_SHOW, GestureActions.NAV_HIDE,
            GestureActions.CANVAS_PREV, GestureActions.CANVAS_NEXT
        ).forEach { assertTrue("$it 不该被当成切 tab", !GestureActions.isTabAction(it)) }
        assertTrue(!GestureActions.isTabAction(null))
        assertTrue(!GestureActions.isTabAction("乱写的"))
    }

    @Test
    fun `摘要文案认得出两个新动作`() {
        val map = listOf(
            GestureActions.TAB_NEXT,  // 左滑
            GestureActions.TAB_PREV,  // 右滑
            GestureActions.NONE,      // 上滑
            GestureActions.NONE       // 下滑
        )
        assertEquals("当前：左滑下一个 tab · 右滑上一个 tab · 其余无", GestureActions.summary(map))
    }

    // ================================================================ 方向判定

    @Test
    fun `四个方向各自判到正确的槽位`() {
        val t = 48f
        assertEquals(GestureActions.SLOT_RIGHT, GestureActions.slotOf(60f, 0f, t))
        assertEquals(GestureActions.SLOT_LEFT, GestureActions.slotOf(-60f, 0f, t))
        // ⚠️ 屏幕坐标系：**正 dy 是向下**
        assertEquals(GestureActions.SLOT_DOWN, GestureActions.slotOf(0f, 60f, t))
        assertEquals(GestureActions.SLOT_UP, GestureActions.slotOf(0f, -60f, t))
    }

    @Test
    fun `没到阈值不触发 —— 返回 -1 而不是某个槽位`() {
        assertEquals(-1, GestureActions.slotOf(10f, 0f, 48f))
        assertEquals(-1, GestureActions.slotOf(-10f, 0f, 48f))
        assertEquals(-1, GestureActions.slotOf(0f, 47f, 48f))
        assertEquals(-1, GestureActions.slotOf(0f, 0f, 48f))
        // 阈值 <= 0 一律不触发（防止 dp 换算拿到 0 时"轻轻一碰就切画布"）
        assertEquals(-1, GestureActions.slotOf(999f, 0f, 0f))
        assertEquals(-1, GestureActions.slotOf(999f, 0f, -5f))
    }

    @Test
    fun `斜着划按主轴判，不会因为横向先到阈值就当成横滑`() {
        // dx=70 dy=200：纵向是主轴 → 下滑（不是"右滑"）
        assertEquals(GestureActions.SLOT_DOWN, GestureActions.slotOf(70f, 200f, 48f))
        // dx=200 dy=70：横向是主轴 → 右滑
        assertEquals(GestureActions.SLOT_RIGHT, GestureActions.slotOf(200f, 70f, 48f))
        // 主轴没到阈值、副轴也没到 → 不触发
        assertEquals(-1, GestureActions.slotOf(20f, 30f, 48f))
    }

    // ================================================================ 归一化

    @Test
    fun `认得的值原样保留`() {
        GestureActions.ACTION_IDS.forEach { id ->
            assertEquals(id, GestureActions.normalize(GestureActions.SLOT_RIGHT, id))
        }
    }

    @Test
    fun `认不得的值落回该槽位的默认值，而不是落回无`() {
        // 这一条是"升级不改变已有手感"的判据：旧配置根本没这四个键
        assertEquals(
            GestureActions.NAV_SHOW,
            GestureActions.normalize(GestureActions.SLOT_RIGHT, null)
        )
        assertEquals(
            GestureActions.NAV_SHOW,
            GestureActions.normalize(GestureActions.SLOT_RIGHT, "")
        )
        assertEquals(
            GestureActions.NAV_SHOW,
            GestureActions.normalize(GestureActions.SLOT_RIGHT, "   ")
        )
        assertEquals(
            GestureActions.NAV_SHOW,
            GestureActions.normalize(GestureActions.SLOT_RIGHT, "nav_shwo")
        )
        // 越界的槽位下标也不能崩（读一份手改坏的配置时）
        assertEquals(GestureActions.NONE, GestureActions.normalize(99, "none"))
    }

    @Test
    fun `动作名与下标：认不得的当无`() {
        assertEquals("呼出导航", GestureActions.actionName(GestureActions.NAV_SHOW))
        assertEquals("无", GestureActions.actionName("不存在的动作"))
        assertEquals(0, GestureActions.actionIndex("不存在的动作"))
        assertEquals(
            GestureActions.ACTION_IDS.indexOf(GestureActions.CANVAS_NEXT),
            GestureActions.actionIndex(GestureActions.CANVAS_NEXT)
        )
    }

    // ================================================================ 摘要文案

    @Test
    fun `摘要文案与需求给的例子一致`() {
        val map = listOf(
            GestureActions.NAV_HIDE,    // 左滑
            GestureActions.NAV_SHOW,    // 右滑
            GestureActions.CANVAS_NEXT, // 上滑
            GestureActions.NONE         // 下滑
        )
        assertEquals("当前：左滑收起导航 · 右滑呼出导航 · 上滑下一套画布 · 其余无",
            GestureActions.summary(map))
    }

    @Test
    fun `四个都配上时不补其余无`() {
        val map = listOf(
            GestureActions.NAV_HIDE, GestureActions.NAV_SHOW,
            GestureActions.CANVAS_NEXT, GestureActions.CANVAS_PREV
        )
        val s = GestureActions.summary(map)
        assertEquals(false, s.contains("其余无"))
        assertTrue(s.contains("下滑上一套画布"))
    }

    @Test
    fun `四个都是无时给出另一句，并提醒双击兜底还在`() {
        val map = List(GestureActions.SLOT_COUNT) { GestureActions.NONE }
        val s = GestureActions.summary(map)
        assertTrue(s, s.contains("都是「无」"))
        assertTrue(s, s.contains("双击"))
    }

    // ================================================================ 落盘

    @Test
    fun `旧配置缺这四个键时取默认值`() {
        // v1.20.8 的 settings.json：没有 gesture* 这四个键
        val old = JSONObject()
            .put("sound", true)
            .put("pollInterval", 120)
            .put("canvasNamePos", 0)
        Store.applySettingsJson(old)
        assertEquals(GestureActions.NAV_SHOW, Store.settings.gestureAt(GestureActions.SLOT_RIGHT))
        assertEquals(GestureActions.NAV_HIDE, Store.settings.gestureAt(GestureActions.SLOT_LEFT))
        assertEquals(GestureActions.CANVAS_NEXT, Store.settings.gestureAt(GestureActions.SLOT_UP))
        assertEquals(GestureActions.CANVAS_PREV, Store.settings.gestureAt(GestureActions.SLOT_DOWN))
    }

    @Test
    fun `存下来的映射读回来一模一样，并且真的写进了 JSON`() {
        Store.settings.setGestureAt(GestureActions.SLOT_UP, GestureActions.NAV_SHOW)
        Store.settings.setGestureAt(GestureActions.SLOT_DOWN, GestureActions.NONE)
        Store.settings.setGestureAt(GestureActions.SLOT_LEFT, GestureActions.CANVAS_PREV)

        val json = Store.settingsToJson()
        assertEquals(GestureActions.NAV_SHOW, json.getString("gestureUp"))
        assertEquals(GestureActions.NONE, json.getString("gestureDown"))
        assertEquals(GestureActions.CANVAS_PREV, json.getString("gestureLeft"))
        assertEquals(GestureActions.NAV_SHOW, json.getString("gestureRight"))

        Store.applySettingsJson(JSONObject(json.toString()))
        assertEquals(GestureActions.NAV_SHOW, Store.settings.gestureAt(GestureActions.SLOT_UP))
        assertEquals(GestureActions.NONE, Store.settings.gestureAt(GestureActions.SLOT_DOWN))
        assertEquals(GestureActions.CANVAS_PREV, Store.settings.gestureAt(GestureActions.SLOT_LEFT))
    }

    @Test
    fun `手改坏的映射落回默认，不会让手势失效`() {
        val bad = JSONObject()
            .put("gestureRight", 12345)          // 类型都不对
            .put("gestureLeft", "left_slide")    // 名字写错
            .put("gestureUp", JSONObject.NULL)   // 显式 null
        Store.applySettingsJson(bad)
        assertEquals(GestureActions.NAV_SHOW, Store.settings.gestureAt(GestureActions.SLOT_RIGHT))
        assertEquals(GestureActions.NAV_HIDE, Store.settings.gestureAt(GestureActions.SLOT_LEFT))
        assertEquals(GestureActions.CANVAS_NEXT, Store.settings.gestureAt(GestureActions.SLOT_UP))
    }

    @Test
    fun `setGestureAt 写进去的一定是合法 id`() {
        Store.settings.setGestureAt(GestureActions.SLOT_RIGHT, "乱写的")
        assertEquals(GestureActions.NAV_SHOW, Store.settings.gestureRight)
        assertTrue(GestureActions.ACTION_IDS.contains(Store.settings.gestureRight))
    }

    @Test
    fun `设置页那一行的文案由 Settings 一处给出`() {
        val s = Store.Settings()
        assertEquals(GestureActions.summary(
            listOf(s.gestureLeft, s.gestureRight, s.gestureUp, s.gestureDown)
        ), s.gestureSummary())
        assertTrue(s.gestureSummary().startsWith("当前："))
    }
}
