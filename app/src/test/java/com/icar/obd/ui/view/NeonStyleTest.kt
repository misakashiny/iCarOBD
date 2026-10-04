package com.icar.obd.ui.view

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 霓虹档位的**名字是跨层契约**。
 *
 * `data/GaugeItem.neonPreset` 存的是字符串（`data/` 不能依赖 `ui/view/`，
 * 见 `ARCHITECTURE.md` §4.1.7），而解析成 [NeonStyle] 由本层做。
 * 于是档位名变成了**数据层与 UI 层之间的约定**：
 *
 *  - 设计文件 / `dash.json` 里写着 `"强烈"`；
 *  - 本层的 [NeonStyle.presetOf] 按名字查表。
 *
 * 一旦有人改了 [NeonStyle.PRESETS] 里的名字而没改存量配置，
 * `presetOf` 会**静默回落到"标准"** —— 用户的"夸张"霓虹就这么没了，
 * 而且没有任何报错。这个测试就是为了让这种改动**在编译期之后立刻失败**。
 */
class NeonStyleTest {

    /** 这些名字已经写进了文档（`docs/UI设计指南.md` §四）与存量配置文件，不能改 */
    private val frozenNames = listOf("关闭", "克制", "标准", "强烈", "夸张")

    @Test
    fun `档位名是冻结的契约`() {
        val actual = NeonStyle.PRESETS.map { it.first }
        assertEquals(
            "改了档位名会让存量 dash.json / design.json 静默回落到「标准」。若确实要改，请同时提供旧名到新名的迁移",
            frozenNames,
            actual
        )
    }

    @Test
    fun `每个冻结名字都能查到对应样式`() {
        frozenNames.forEach { name ->
            val s = NeonStyle.presetOf(name)
            assertTrue("$name 应当能查到真实样式", NeonStyle.PRESETS.any { it.first == name && it.second == s })
        }
    }

    @Test
    fun `关闭档位真的不画辉光`() {
        assertEquals(0, NeonStyle.presetOf("关闭").layersOr(9))
    }

    @Test
    fun `未知名字回落到标准而不是崩`() {
        // 存量配置里可能有已被删掉的档位名（历史上删过 Sky 主题相关的东西）
        assertEquals(NeonStyle.AUTO, NeonStyle.presetOf("这个档位不存在"))
        assertEquals(NeonStyle.AUTO, NeonStyle.presetOf(null))
    }

    @Test
    fun `档位名反查`() {
        assertEquals("标准", NeonStyle.presetNameOf(NeonStyle.AUTO))
        assertEquals("关闭", NeonStyle.presetNameOf(NeonStyle.OFF))
        assertEquals("标准", NeonStyle.presetNameOf(null))
        assertEquals(
            "自定义",
            NeonStyle.presetNameOf(NeonStyle(layers = 4, spreadRatio = 0.04f))
        )
    }

    @Test
    fun `层数上限被夹住`() {
        // 上限存在的意义是防止配置里写个 999 把 GPU 烧了
        assertEquals(NeonStyle.MAX_LAYERS, NeonStyle(layers = 999).layersOr(3))
        // 负数/0 都当作"没设"（0 是"按尺寸自适应"的既定语义），回落到自适应值
        assertEquals(3, NeonStyle(layers = 0).layersOr(3))
        assertEquals(3, NeonStyle(layers = -5).layersOr(3))
    }
}
