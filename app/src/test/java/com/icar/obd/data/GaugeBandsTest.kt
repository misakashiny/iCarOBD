package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 多段色带 `bands`（App 侧，v1.20.22）。
 *
 * ## 这个套件守的三件事（都**不报错**，所以必须机器钉）
 *
 * 1. **缺省 = 空 = 完全旧行为**。缺字段 / 空数组 / 全非法一律归一成空表，
 *    绘制走老路径（`warnHigh`）—— 老设计文件的观感与行为**逐像素不变**。
 * 2. **`bands` 不许碰报警判定**。报警源永远是 `warnLow`/`warnHigh`；
 *    让色带顺带改报警 = **静默改变存量设计的安全语义**
 *    （"给转速表加个红区参考"变成"这张表开始报警了"）。
 * 3. **老文件再存一次不会凭空多出 `bands` 键**（空表不写字段）——
 *    否则旧版本 App 打开新文件会看到一个它不认识的字段。
 *
 * 绘制本身（真机上分区画没画出来、颜色对不对）要真机像素验证 ——
 * 见 CHANGELOG v1.20.22 的装机实测。这里只钉**数据层**的判据。
 */
class GaugeBandsTest {

    // ---------------------------------------------------------------- 1. 缺省 = 旧行为

    @Test
    fun `缺省是空表`() {
        assertTrue(GaugeItem().bands.isEmpty())
        assertTrue(Bands.normalize(null, 0f, 100f).isEmpty())
        assertTrue(Bands.normalize(emptyList(), 0f, 100f).isEmpty())
    }

    /**
     * **旧文件（没有 `bands` 键）读出来是空表，回写时也不写这个键。**
     *
     * 这是"缺省 = 完全旧行为"的机器证明：老文件往返一次**一个字节都不该变**。
     */
    @Test
    fun `旧文件没有 bands 键时读成空表且回写不写字段`() {
        val old = JSONObject()
            .put("pid", "std_0C").put("min", 0).put("max", 8000)
            .put("warnHigh", 6500)
            .put("x", 0).put("y", 0).put("w", 120).put("h", 120)

        val item = GaugeItem.fromJson(old)
        assertTrue("旧文件读出来必须是空表", item.bands.isEmpty())

        val out = item.toJson()
        assertFalse("老文件再存一次**不许**凭空多出 bands 键", out.has("bands"))
    }

    /** 空表 / 全非法 都**不写字段** —— 与 `valueLabels` / `cardStyle` 同套路 */
    @Test
    fun `空表不写字段`() {
        assertNull(Bands.toJson(null))
        assertNull(Bands.toJson(emptyList()))
        assertNull("全非法的色带归一成空表后同样不写", Bands.toJson(Bands.normalize(
            listOf(GaugeBand(from = 50f, to = 10f)), 0f, 100f
        )))
    }

    // ---------------------------------------------------------------- 2. 逐段 / 往返

    @Test
    fun `色带 JSON 往返逐字段相同`() {
        val item = GaugeItem(pidId = "std_0C", minVal = 0f, maxVal = 8000f)
        item.bands = mutableListOf(
            GaugeBand(from = 6000f, to = 7000f, color = 0xFFFFB020.toInt(), alpha = null),
            GaugeBand(from = 7000f, to = 8000f, color = 0xFFFF4D4F.toInt(), alpha = 200)
        )

        val json = item.toJson()
        assertTrue(json.has("bands"))
        val arr = json.getJSONArray("bands")
        assertEquals("逐段写出（不是合成一段）", 2, arr.length())
        assertEquals("#FFB020", arr.getJSONObject(0).getString("color"))
        // ⚠️ 没写 alpha 的那段**不许**写出 alpha —— 否则"没写"往返一次会变成"写了"
        assertFalse("没写 alpha 就不写这个键", arr.getJSONObject(0).has("alpha"))
        assertEquals(200, arr.getJSONObject(1).getInt("alpha"))

        val back = GaugeItem.fromJson(json)
        assertEquals(2, back.bands.size)
        assertEquals(6000f, back.bands[0].from, 0.01f)
        assertEquals(7000f, back.bands[0].to, 0.01f)
        assertEquals(0xFFFFB020.toInt(), back.bands[0].color)
        assertNull("没写 alpha 读回来仍是 null（不是 255）", back.bands[0].alpha)
        assertEquals(200, back.bands[1].alpha)
    }

    /**
     * **没写颜色的段读回来 `color == null`**（不是兜底色）。
     *
     * 填默认值会让"没写"与"写了默认色"变成同一个东西 ——
     * 于是序列化时必须写出 color，文件里每个色带都多两个字段，
     * 而且往返一次"没写"会变成"写了"。
     */
    @Test
    fun `没写颜色的段读回来是 null 绘制时才回落兜底色`() {
        val arr = JSONArray().put(JSONObject().put("from", 10).put("to", 20))
        val parsed = Bands.parse(arr, 0f, 100f)
        assertEquals(1, parsed.size)
        assertNull("解析侧不许填默认色", parsed[0].color)
        assertEquals("绘制侧才回落", GaugeBand.DEFAULT_COLOR, GaugeBand.colorOf(parsed[0]))
    }

    // ---------------------------------------------------------------- 3. 不许碰报警语义

    /**
     * **这一条是这个套件存在的理由。**
     *
     * 只给一个原本不报警的表加 `bands`，`warnLow`/`warnHigh` **必须仍然是 null**。
     * 一旦有人图省事写成"有 bands 就从第一段推报警阈值"，
     * 存量设计的安全语义就被**静默**改了 —— 表开始闪，而文件里什么都没写。
     */
    @Test
    fun `只加 bands 时 warnLow 和 warnHigh 仍然是 null`() {
        val o = JSONObject()
            .put("pid", "std_0C").put("min", 0).put("max", 8000)
            .put("x", 0).put("y", 0).put("w", 120).put("h", 120)
            .put(
                "bands", JSONArray()
                    .put(JSONObject().put("from", 6000).put("to", 7000).put("color", "#FFB020"))
                    .put(JSONObject().put("from", 7000).put("to", 8000).put("color", "#FF4D4F"))
            )

        val item = GaugeItem.fromJson(o)
        assertEquals("色带读进来了", 2, item.bands.size)
        assertNull("bands 不许顺带设 warnLow", item.warnLow)
        assertNull("bands 不许顺带设 warnHigh", item.warnHigh)

        // 回写也不许凭空长出报警阈值
        val out = item.toJson()
        assertFalse(out.has("warnLow"))
        assertFalse(out.has("warnHigh"))
    }

    /**
     * 色带边界与报警阈值**是两件事** —— 样板 `g_rpmband` 就是这样：
     * 黄区 6000~7000 + 红区 7000~8000，而 `warnHigh` 仍然是 **6500**。
     * 若谁把两者绑起来，这条会红。
     */
    @Test
    fun `色带边界与报警阈值可以不一致`() {
        val o = JSONObject()
            .put("pid", "std_0C").put("min", 0).put("max", 8000).put("warnHigh", 6500)
            .put("x", 0).put("y", 0).put("w", 120).put("h", 120)
            .put(
                "bands", JSONArray()
                    .put(JSONObject().put("from", 6000).put("to", 7000).put("color", "#FFB020"))
                    .put(JSONObject().put("from", 7000).put("to", 8000).put("color", "#FF4D4F"))
            )

        val item = GaugeItem.fromJson(o)
        assertEquals(6500f, item.warnHigh!!, 0.01f)
        assertEquals(6000f, item.bands[0].from, 0.01f)
        assertEquals(7000f, item.bands[1].from, 0.01f)
    }

    // ---------------------------------------------------------------- 4. 边界：夹量程 / 丢空段 / 上限 / 坏颜色

    @Test
    fun `越界的段夹到量程`() {
        val out = Bands.normalize(
            listOf(GaugeBand(from = -500f, to = 9000f)), 0f, 8000f
        )
        assertEquals(1, out.size)
        assertEquals(0f, out[0].from, 0.01f)
        assertEquals(8000f, out[0].to, 0.01f)
    }

    @Test
    fun `from 大于等于 to 的段丢掉`() {
        assertTrue(Bands.normalize(listOf(GaugeBand(from = 50f, to = 50f)), 0f, 100f).isEmpty())
        assertTrue(Bands.normalize(listOf(GaugeBand(from = 80f, to = 20f)), 0f, 100f).isEmpty())
        // 只丢坏的那一段，好的留下
        val out = Bands.normalize(
            listOf(GaugeBand(from = 80f, to = 20f), GaugeBand(from = 10f, to = 20f)), 0f, 100f
        )
        assertEquals(1, out.size)
        assertEquals(10f, out[0].from, 0.01f)
    }

    @Test
    fun `超过 MAX_BANDS 的段丢掉尾巴`() {
        val many = (0 until 12).map { GaugeBand(from = it * 5f, to = it * 5f + 4f) }
        val out = Bands.normalize(many, 0f, 100f)
        assertEquals(GaugeBand.MAX_BANDS, out.size)
        assertEquals(8, GaugeBand.MAX_BANDS)
    }

    @Test
    fun `坏颜色读成 null 不崩`() {
        assertNull(Bands.parseColor(null))
        assertNull(Bands.parseColor(""))
        assertNull(Bands.parseColor("red"))
        assertNull(Bands.parseColor("#FFF"))          // 三位简写不认（工具侧同口径）
        assertNull(Bands.parseColor("#GGGGGG"))       // 不是十六进制
        assertNull(Bands.parseColor("#FF4D4F00"))     // 八位（带 alpha）不认
        assertNull(Bands.parseColor("FF4D4F"))        // 少了 #
        assertEquals(0xFFFF4D4F.toInt(), Bands.parseColor("#FF4D4F"))
        assertEquals(0xFFFF4D4F.toInt(), Bands.parseColor("#ff4d4f"))  // 大小写都认
    }

    @Test
    fun `alpha 夹到 0 到 255 并取整`() {
        val a = Bands.normalize(
            listOf(
                GaugeBand(from = 0f, to = 10f, alpha = -20),
                GaugeBand(from = 10f, to = 20f, alpha = 999),
                GaugeBand(from = 20f, to = 30f, alpha = 200)
            ), 0f, 100f
        )
        assertEquals(0, a[0].alpha)
        assertEquals(255, a[1].alpha)
        assertEquals(200, a[2].alpha)
        assertEquals(0, GaugeBand.alphaOf(a[0]))
        assertEquals(255, GaugeBand.alphaOf(a[1]))
    }

    /** 没写 alpha 的段绘制时按 255（= 不透明）—— 与老红区逐像素一致 */
    @Test
    fun `没写 alpha 按 255 画`() {
        assertEquals(255, GaugeBand.alphaOf(GaugeBand(from = 0f, to = 1f)))
    }

    // ---------------------------------------------------------------- 5. 脏数据不许崩

    /**
     * 设计文件里**什么都可能是**：段不是对象、from 是字符串、数组里混着 null。
     * 任何一条都不许抛异常 —— 导入一份坏文件不该让 App 崩。
     */
    @Test
    fun `脏数据不崩且坏段被丢掉`() {
        val arr = JSONArray()
            .put("我不是对象")
            .put("也不是对象")
            .put(JSONObject().put("from", "abc").put("to", 50))       // from 不是数字
            .put(JSONObject().put("to", 50))                          // 缺 from
            .put(JSONObject().put("from", 10).put("to", "xyz"))       // to 不是数字
            .put(JSONObject().put("from", 10).put("to", 20))          // ✅ 只有这段是好的

        val out = Bands.parse(arr, 0f, 100f)
        assertEquals("只有那一段好的留下", 1, out.size)
        assertEquals(10f, out[0].from, 0.01f)
        assertEquals(20f, out[0].to, 0.01f)
    }

    /** 量程写反了（手改文件就能造出来）不许抛异常 —— `coerceIn` 会抛，所以刻意用 `minOf(maxOf(...))` */
    @Test
    fun `量程反了不抛异常`() {
        val out = Bands.normalize(listOf(GaugeBand(from = 10f, to = 90f)), 100f, 0f)
        assertTrue("量程反了 → 一段都留不下，但不崩", out.isEmpty())
    }

    @Test
    fun `NaN 与无穷的段丢掉`() {
        val out = Bands.normalize(
            listOf(
                GaugeBand(from = Float.NaN, to = 50f),
                GaugeBand(from = 10f, to = Float.NaN),
                GaugeBand(from = Float.NEGATIVE_INFINITY, to = Float.POSITIVE_INFINITY)
            ), 0f, 100f
        )
        // 三段全丢：NaN / 无穷都不是"量程上的值"，夹取对它没有意义
        // （与工具侧 `Number.isFinite` 同一个判据）
        assertTrue(out.isEmpty())
    }

    /** 量程非法（min ≥ max）的表：任何段都留不下，但也不崩 */
    @Test
    fun `零量程表上色带全被丢掉`() {
        val o = JSONObject()
            .put("pid", "std_0C").put("min", 100).put("max", 100)
            .put("x", 0).put("y", 0).put("w", 120).put("h", 120)
            .put("bands", JSONArray().put(JSONObject().put("from", 0).put("to", 200)))

        val item = GaugeItem.fromJson(o)
        assertTrue(item.bands.isEmpty())
        assertFalse(item.toJson().has("bands"))
    }

    // ---------------------------------------------------------------- 6. 颜色序列化

    @Test
    fun `颜色序列化成大写六位`() {
        assertEquals("#FF4D4F", Bands.hex(0xFFFF4D4F.toInt()))
        assertEquals("#00FF00", Bands.hex(0x8000FF00.toInt()))  // alpha 通道被丢掉
    }

    @Test
    fun `BAND 常量与工具侧同一套口径`() {
        assertEquals(8, GaugeItem.MAX_BANDS)
        assertEquals(0, GaugeItem.BAND_ALPHA_MIN)
        assertEquals(255, GaugeItem.BAND_ALPHA_MAX)
        // 兜底色必须与老红区**同一个红**（`R.color.danger` = #FFFF4D4F），
        // 否则"没写颜色"的色带在车上会是另一个红 —— 而它不报错
        assertEquals(0xFFFF4D4F.toInt(), GaugeItem.BAND_DEFAULT_COLOR)
        assertEquals("#FF4D4F", Bands.hex(GaugeItem.BAND_DEFAULT_COLOR))
    }
}
