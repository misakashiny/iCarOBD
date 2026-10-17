package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T-UI-EXPORT-03：导出文件名生成。
 *
 * 只测纯逻辑部分（文件名）；写盘走 MediaStore，需要真实 Context，
 * 由真机验证覆盖。
 */
class DesignExporterFilesTest {

    @Test fun `基本命名含画布名与时间戳`() {
        val n = DesignExporterFiles.fileName("画布 2", "20261017-224500")
        assertEquals("ICarOBD_画布 2_20261017-224500.json", n)
    }

    @Test fun `空画布名只留 ICarOBD 前缀`() {
        assertEquals(
            "ICarOBD_20261017-224500.json",
            DesignExporterFiles.fileName("", "20261017-224500")
        )
        assertEquals(
            "ICarOBD_20261017-224500.json",
            DesignExporterFiles.fileName("   ", "20261017-224500")
        )
    }

    /**
     * **文件系统非法字符必须被替换** —— 否则文件在某些文件管理器/传输工具里
     * 会出现"创建了但看不到"，或者传到电脑后名字被截断。
     */
    @Test fun `非法字符被替换成下划线`() {
        val n = DesignExporterFiles.fileName("""a/b\c:d*e?f"g<h>i|j""", "20261017-224500")
        for (bad in listOf('/', '\\', ':', '*', '?', '"', '<', '>', '|')) {
            assertFalse("不能含非法字符 $bad：$n", n.contains(bad))
        }
        assertTrue(n.startsWith("ICarOBD_a_b_c_d_e_f_g_h_i_j_"))
    }

    @Test fun `控制字符被替换`() {
        val n = DesignExporterFiles.fileName("a\u0001b\u001Fc", "20261017-224500")
        assertFalse("不能含控制字符：$n", n.contains('\u0001'))
        assertFalse("不能含控制字符：$n", n.contains('\u001F'))
    }

    @Test fun `首尾空白与点被去掉`() {
        // Windows 上文件名以点结尾会创建失败
        val n = DesignExporterFiles.fileName("  ..盘面..  ", "20261017-224500")
        assertTrue("不能以点开头结尾：$n", n.startsWith("ICarOBD_盘面"))
        assertFalse("不能以点结尾：$n", n.removeSuffix(".json").endsWith("."))
    }

    @Test fun `超长画布名被截断`() {
        val longName = "表".repeat(200)
        val n = DesignExporterFiles.fileName(longName, "20261017-224500")
        // 前缀 ICarOBD_ + 最多 40 字 + _时间戳.json
        assertTrue("文件名过长：${n.length}", n.length < 80)
        assertTrue(n.endsWith(".json"))
    }

    @Test fun `时间戳为空时用 unknown 占位`() {
        val n = DesignExporterFiles.fileName("盘面", "")
        assertEquals("ICarOBD_盘面_unknown.json", n)
    }

    /**
     * **同一画布不同时刻必须得到不同文件名** —— 这是"多次导出不互相覆盖"的根本保证。
     * 只写固定的 `design.json` 会把上一次冲掉。
     */
    @Test fun `不同时间戳产生不同文件名`() {
        val a = DesignExporterFiles.fileName("盘面", "20261017-224500")
        val b = DesignExporterFiles.fileName("盘面", "20261017-224501")
        assertTrue("同一画布不同时刻必须不重名：$a vs $b", a != b)
    }

    @Test fun `子目录与 MIME 常量固定`() {
        assertEquals("ICarOBD", DesignExporterFiles.SUB_DIR)
        assertEquals("application/json", DesignExporterFiles.MIME_JSON)
    }
}
