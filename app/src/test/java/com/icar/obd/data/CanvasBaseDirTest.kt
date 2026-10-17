package com.icar.obd.data

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * **T-App-A5-BASEDIR：多画布素材基目录并存**。
 *
 * ## 守的是什么
 *
 * 素材基目录 `designBaseDir` 原先是 **`Settings` 上的全局单值**，而画布是**多套的**
 * （`DashCanvas.MAX_CANVASES = 8`），且 `DashCanvas` 自己没有 baseDir 字段。
 *
 * 后果：给「画布 1」导入素材（`designBaseDir` 指向它的私有目录）后切到「画布 2」，
 * `switchCanvas()` 不碰 `designBaseDir` —— 画布 2 的相对路径素材**全部解析失败**。
 * 用户看到的是"切过去之后盘面是空的、背景没了"。
 *
 * ## 本类钉住的五条
 *
 * 1. 每套画布各自保存/恢复自己的基目录
 * 2. 两套画布来回切换互不覆盖
 * 3. 旧配置（只有全局值、画布无该字段）迁移后行为不变
 * 4. 画布无基目录时行为与改动前一致（不崩、不凭空造路径）
 * 5. 空值不能覆盖已有有效值
 */
class CanvasBaseDirTest {

    private lateinit var saved: Store.Settings

    @Before
    fun setUp() {
        // Settings 是全局单例的字段集合，测完必须还原，不能泻漏给别的用例
        saved = Store.settings.copy()
        Store.settings.canvases.clear()
        Store.settings.activeCanvasId = ""
        Store.settings.designBaseDir = ""
    }

    @After
    fun tearDown() {
        Store.settings.canvases.clear()
        Store.settings.canvases.addAll(saved.canvases)
        Store.settings.activeCanvasId = saved.activeCanvasId
        Store.settings.designBaseDir = saved.designBaseDir
    }

    /** 造一套带指定基目录的画布并加进列表 */
    private fun addCanvas(name: String, baseDir: String): DashCanvas {
        val c = DashCanvas(name = name, type = DashCanvas.TYPE_CUSTOM)
        c.designBaseDir = baseDir
        Store.settings.canvases.add(c)
        if (Store.settings.activeCanvasId.isBlank()) Store.settings.activeCanvasId = c.id
        return c
    }

    // ================================================================ 1. 各自保存

    /**
     * **切换画布后，全局 `designBaseDir` 必须等于目标画布自己的值。**
     *
     * 修复前：`switchCanvas` 完全不碰 `designBaseDir`，切过去还是上一套的目录。
     */
    @Test
    fun `切换画布后 designBaseDir 跟随目标画布`() {
        val a = addCanvas("画布1", "/data/a")
        val b = addCanvas("画布2", "/data/b")

        Store.switchCanvas(b.id)
        assertEquals(
            "切到画布2 后，基目录必须是画布2 自己的 —— 否则它的素材全找不到",
            "/data/b", Store.settings.designBaseDir
        )

        Store.switchCanvas(a.id)
        assertEquals("/data/a", Store.settings.designBaseDir)
    }

    /** 两套画布的基目录**互不覆盖**：来回切多次仍各自正确。 */
    @Test
    fun `两套画布来回切换互不覆盖`() {
        val a = addCanvas("画布1", "/data/dirA")
        val b = addCanvas("画布2", "/data/dirB")

        repeat(3) {
            Store.switchCanvas(b.id)
            assertEquals("第 $it 轮切到 B", "/data/dirB", Store.settings.designBaseDir)
            Store.switchCanvas(a.id)
            assertEquals("第 $it 轮切到 A", "/data/dirA", Store.settings.designBaseDir)
        }
        // 画布自身保存的值不能被切换过程改写
        assertEquals("/data/dirA", Store.settings.canvases.first { it.id == a.id }.designBaseDir)
        assertEquals("/data/dirB", Store.settings.canvases.first { it.id == b.id }.designBaseDir)
    }

    /**
     * **改基目录后要落回当前画布**（`snapshotToActiveCanvas`）。
     *
     * 与 `designJson`/`bgImagePath` 等字段同一套对称约定：
     * 实时字段改了，切走时要存取到自己名下，否则下次回来还是旧值。
     */
    @Test
    fun `改后的基目录会落回当前画布`() {
        val a = addCanvas("画布1", "")
        val b = addCanvas("画布2", "/data/b")

        Store.settings.designBaseDir = "/data/new-for-a"
        Store.switchCanvas(b.id) // 触发 snapshot

        assertEquals(
            "切走时当前画布应记住新基目录",
            "/data/new-for-a", Store.settings.canvases.first { it.id == a.id }.designBaseDir
        )
    }

    // ================================================================ 2. 旧配置迁移

    /**
     * **旧配置迁移**：老版本只有全局 `designBaseDir`，画布上没有这个字段。
     * 加载后首套画布应继承全局值，行为与改动前一致。
     */
    @Test
    fun `旧配置的全局基目录迁移到首套画布`() {
        val c = DashCanvas(name = "旧画布", type = DashCanvas.TYPE_CUSTOM)
        // 模拟旧配置：画布上没有 designBaseDir（默认空），全局有值
        assertEquals("前提：画布默认无基目录", "", c.designBaseDir)
        Store.settings.canvases.add(c)
        Store.settings.activeCanvasId = c.id
        Store.settings.designBaseDir = "/legacy/base"

        Store.migrateLegacyBaseDir()

        assertEquals(
            "老配置的全局基目录必须迁到首套画布，否则升级后素材全丢",
            "/legacy/base", c.designBaseDir
        )
        assertEquals("全局值保持不变", "/legacy/base", Store.settings.designBaseDir)
    }

    /** 已经有画布自带基目录时，**不能**被旧全局值覆盖。 */
    @Test
    fun `迁移不覆盖画布已有的基目录`() {
        val a = addCanvas("画布1", "/already/set/a")
        val b = addCanvas("画布2", "/already/set/b")
        Store.settings.designBaseDir = "/legacy"

        Store.migrateLegacyBaseDir()

        assertEquals("已有值不能被全局旧值覆盖", "/already/set/a", a.designBaseDir)
        assertEquals("/already/set/b", b.designBaseDir)
    }

    // ================================================================ 3. 空值不覆盖

    /**
     * **空基目录不能覆盖已有有效值。**
     *
     * 场景：画布 2 从没导入过素材（基目录为空），切过去时若直接把空值写进全局，
     * 会让某些仍引用旧路径的派生状态失效；更重要的是切回画布 1 时不能被清空。
     */
    @Test
    fun `切到无基目录的画布再切回来值仍在`() {
        val a = addCanvas("画布1", "/data/a")
        val b = addCanvas("画布2", "") // 没有素材

        Store.switchCanvas(b.id)
        assertEquals("切到无素材画布时基目录为空是合理的", "", Store.settings.designBaseDir)

        Store.switchCanvas(a.id)
        assertEquals("切回来必须恢复画布1 的基目录", "/data/a", Store.settings.designBaseDir)
    }

    // ================================================================ 4. 序列化往返

    /** 基目录必须能存进 `dash.json` 并读回 —— 否则重启 App 就丢。 */
    @Test
    fun `基目录在画布 JSON 往返中保留`() {
        val c = DashCanvas(name = "带素材", type = DashCanvas.TYPE_CUSTOM)
        c.designBaseDir = "/data/x/assets-base"

        val json = c.toJson()
        assertTrue("toJson 必须写出 designBaseDir", json.has("designBaseDir"))

        val back = DashCanvas.fromJson(json)
        assertEquals("往返后基目录应一致", "/data/x/assets-base", back.designBaseDir)
    }

    /** 空基目录**不写进 JSON**，避免老文件一存盘就多一行噪音（与 designJson 同一约定）。 */
    @Test
    fun `空基目录不写进画布 JSON`() {
        val c = DashCanvas(name = "无素材", type = DashCanvas.TYPE_CUSTOM)
        val json = c.toJson()
        assertFalse(
            "空值不该写出 —— 否则每个老画布一存盘就多一行噪音",
            json.has("designBaseDir")
        )
    }
}
