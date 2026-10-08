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
 * **双指手势映射**（v1.20.9）：方向判定 / 取值归一化 / 摘要文案 / 落盘。
 *
 * ## 为什么这批用例值得写
 *
 * 1. **方向判定在真机上验不了** —— `adb input swipe` 只能发**单指**，
 *    双指手势只能靠用户的手指。也就是说"上下左右判对了没有"**只能靠单测**。
 * 2. **旧配置的兜底是这一版最危险的一处**：v1.20.8 及以前的 `settings.json`
 *    根本没有这四个键，兜错了的表现是"升级之后手势全没了"——
 *    而那时用户只会说"新版有问题"，现场（旧配置）已经没了。
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
