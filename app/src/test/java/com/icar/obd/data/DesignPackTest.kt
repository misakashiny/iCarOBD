package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * **设计包（`.icarzip`）的解开与校验**（v1.20.9，App 侧）。
 *
 * ## 为什么这批用例是这一版的重点
 *
 * 包导入治的是"表盘只剩空卡片"那个病（见 [DesignPack] 的类注释）。它做错的方式
 * **全都不报错**：CRC 没核 → 个别素材加载不到；路径穿越没防 → 写到别的目录；
 * 缺素材静默跳过 → 用户以为导成功了、结果一半卡片是空的。
 * 这几条**只有单测能穷举**（真机上没法造出"包里少一个文件"这种现场）。
 *
 * ## 为什么要自己造 store-only zip
 *
 * 工具侧导出的就是**不压缩**的 zip（`tools/theme-studio/js/zip.js`）。
 * 用 `ZipOutputStream` 的 `STORED` 形态造出来，与它同一种结构 ——
 * 用默认的 deflate 造的话，"store 条目读得对不对"这一条就永远验不到。
 */
class DesignPackTest {

    private lateinit var root: File

    @Before
    fun setUp() {
        root = Files.createTempDirectory("icarobd-pack-test").toFile()
    }

    @After
    fun tearDown() {
        repeat(3) {
            root.walkBottomUp().forEach { f -> runCatching { f.delete() } }
            if (!root.exists()) return
            Thread.sleep(30)
        }
        if (root.exists()) root.deleteOnExit()
    }

    private fun dest(name: String = "design/${System.nanoTime()}"): File = File(root, name)

    // ================================================================ 造包

    /** 造一个 **store-only** zip（与工具侧导出同一种结构） */
    private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z ->
            for ((name, data) in entries) {
                val e = ZipEntry(name)
                e.method = ZipEntry.STORED
                e.size = data.size.toLong()
                e.compressedSize = data.size.toLong()
                val c = CRC32()
                c.update(data)
                e.crc = c.value
                z.putNextEntry(e)
                z.write(data)
                z.closeEntry()
            }
        }
        return bos.toByteArray()
    }

    private fun crcOf(b: ByteArray): Long = CRC32().apply { update(b) }.value

    /** 与工具侧 `pack.js` 的 `buildPackage` 写出的 manifest 同形 */
    private fun manifest(
        assets: List<Triple<String, ByteArray, List<String>>>,
        missing: List<Pair<String, String>> = emptyList(),
        format: String = DesignPack.PACK_FORMAT,
        designName: String = "测试设计",
    ): ByteArray {
        val arr = JSONArray()
        assets.forEach { (path, bytes, refs) ->
            arr.put(
                JSONObject()
                    .put("path", path)
                    .put("assetId", "a_$path")
                    .put("refs", JSONArray(refs))
                    .put("bytes", bytes.size)
                    .put("crc32", crcOf(bytes))
                    .put("w", 64)
                    .put("h", 64)
            )
        }
        val miss = JSONArray()
        missing.forEach { (p, r) -> miss.put(JSONObject().put("path", p).put("reason", r)) }
        val o = JSONObject()
            .put("format", format)
            .put("designSchema", "icar.ui/2")
            .put(
                "design", JSONObject()
                    .put("name", designName)
                    .put("author", "")
                    .put("theme", "neon")
            )
            .put("exportedAt", "2026-10-08T12:00:00.000Z")
            .put("entry", DesignPack.DESIGN_ENTRY)
            .put("assets", arr)
            .put("missing", miss)
            .put("counts", JSONObject().put("assets", assets.size).put("missing", missing.size))
        return o.toString(2).toByteArray(Charsets.UTF_8)
    }

    private val designJson =
        """{"schema":"icar.ui/2","name":"测试设计","nodes":[],"assets":[]}""".toByteArray(Charsets.UTF_8)

    private fun unpack(zipBytes: ByteArray, into: File = dest()): DesignPack.Result =
        DesignPack.unpack(ByteArrayInputStream(zipBytes), into)

    private fun failProblems(r: DesignPack.Result): List<String> {
        assertTrue("期望拒收，实际成功了", r is DesignPack.Result.Fail)
        return (r as DesignPack.Result.Fail).problems
    }

    private fun ok(r: DesignPack.Result): DesignPack.Result.Ok {
        assertTrue(
            "期望成功，实际问题：" +
                (r as? DesignPack.Result.Fail)?.problems?.joinToString(" / "),
            r is DesignPack.Result.Ok
        )
        return r as DesignPack.Result.Ok
    }

    // ================================================================ 文件头识别

    @Test
    fun `文件头识别：zip 认得出，JSON 不误判`() {
        assertTrue(DesignPack.isZipHead(byteArrayOf(0x50, 0x4B, 0x03, 0x04)))
        assertTrue(DesignPack.isZipHead(byteArrayOf(0x50, 0x4B, 0x05, 0x06)))  // 空归档
        assertFalse(DesignPack.isZipHead("{\"schema\":\"icar.ui/2\"}".toByteArray()))
        assertFalse(DesignPack.isZipHead(byteArrayOf(0x50, 0x4B)))              // 太短
        assertFalse(DesignPack.isZipHead(ByteArray(0)))
        assertFalse(DesignPack.isZipHead(byteArrayOf(0x50, 0x4B, 0x01, 0x02)))  // 不是合法签名
    }

    // ================================================================ 路径穿越

    @Test
    fun `safeEntryName 拒绝穿越与绝对路径`() {
        assertNull(DesignPack.safeEntryName("../evil.png"))
        assertNull(DesignPack.safeEntryName("assets/../../evil.png"))
        assertNull(DesignPack.safeEntryName(".."))
        assertNull(DesignPack.safeEntryName("/etc/passwd"))
        assertNull(DesignPack.safeEntryName("C:/windows/x.png"))
        // 反斜杠要先归一化再判 —— 否则 `..\..\x` 会绕过检查
        assertNull(DesignPack.safeEntryName("..\\..\\evil.png"))
        assertNull(DesignPack.safeEntryName(""))
        assertNull(DesignPack.safeEntryName("   "))
    }

    @Test
    fun `safeEntryName 归一化正常路径`() {
        assertEquals("assets/a.png", DesignPack.safeEntryName("assets/a.png"))
        assertEquals("assets/a.png", DesignPack.safeEntryName("./assets/a.png"))
        assertEquals("assets/a.png", DesignPack.safeEntryName("assets//a.png"))
        assertEquals("assets/a.png", DesignPack.safeEntryName("assets\\a.png"))
        assertEquals("design.json", DesignPack.safeEntryName("design.json"))
        // 中文与空格要原样保留（素材路径里真的有中文目录）
        assertEquals("assets/背景 图/carbon.png", DesignPack.safeEntryName("assets/背景 图/carbon.png"))
    }

    @Test
    fun `包里有穿越条目时整个包拒收，且一个文件都没写到目标目录外`() {
        val out = File(root, "evil.txt")
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "../evil.txt" to "被写出来了".toByteArray(),
            DesignPack.MANIFEST_ENTRY to manifest(emptyList()),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("不安全") && it.contains("../evil.txt") })
        assertFalse("穿越条目被写出去了！", out.exists())
    }

    @Test
    fun `拒收时不留半个目录`() {
        val d = dest("half")
        val a = "assets/a.png".toByteArray()
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "assets/a.png" to a,
            DesignPack.MANIFEST_ENTRY to manifest(
                listOf(Triple("assets/a.png", a, listOf("node"))),
                format = "icar.pack/9",   // 版本不对 → 拒收
            ),
        )
        failProblems(unpack(bytes, d))
        assertFalse("拒收之后还留着解压目录：${d.absolutePath}", d.exists())
    }

    // ================================================================ 正常路径

    @Test
    fun `正常包能解开：设计文件拿到、素材按原路径落盘`() {
        val png = ByteArray(64) { (it * 3).toByte() }
        val bg = "背景".toByteArray()
        val d = dest()
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "assets/表盘/carbon.png" to png,
            "assets/bg.png" to bg,
            DesignPack.MANIFEST_ENTRY to manifest(
                listOf(
                    Triple("assets/表盘/carbon.png", png, listOf("node", "part")),
                    Triple("assets/bg.png", bg, listOf("background")),
                )
            ),
        )
        val r = ok(unpack(bytes, d))
        assertEquals(d.absolutePath, r.dir.absolutePath)
        assertEquals(4, r.extractedFiles)
        assertEquals(2, r.manifest.assets.size)
        assertEquals("测试设计", r.manifest.designName)
        assertTrue(r.designJson.contains("icar.ui/2"))
        assertTrue(r.warnings.isEmpty())
        // ⚠️ 包内路径 = 设计里的相对路径 → 解压后目录结构天然一致，
        // 所以 designBaseDir 直接指 r.dir 就能按原样解析（不需要任何路径映射）
        assertTrue(File(d, "assets/表盘/carbon.png").isFile)
        assertEquals(64L, File(d, "assets/表盘/carbon.png").length())
        assertTrue(File(d, "assets/bg.png").isFile)
    }

    @Test
    fun `manifest 读得懂工具写的字段`() {
        val a = "abc".toByteArray()
        val m = DesignPack.parseManifest(
            manifest(
                listOf(Triple("assets/a.png", a, listOf("node", "background"))),
                missing = listOf("assets/gone.png" to "读不到字节"),
                designName = "阿特兹仪表",
            ).toString(Charsets.UTF_8)
        )
        assertEquals(DesignPack.PACK_FORMAT, m.format)
        assertEquals("icar.ui/2", m.designSchema)
        assertEquals("阿特兹仪表", m.designName)
        assertEquals(1, m.assets.size)
        assertEquals("assets/a.png", m.assets[0].path)
        assertEquals(3L, m.assets[0].bytes)
        assertEquals(crcOf(a), m.assets[0].crc32)
        assertEquals(listOf("node", "background"), m.assets[0].refs)
        assertEquals(1, m.missing.size)
        assertEquals("assets/gone.png", m.missing[0].path)
        assertEquals("读不到字节", m.missing[0].reason)
    }

    // ================================================================ 校验：不静默

    @Test
    fun `CRC32 不符要明确报错，并说清是哪个文件`() {
        val real = "真正的字节".toByteArray()
        val other = "另外的字节".toByteArray()
        // 清单里记的是 other 的 CRC，包里放的却是 real —— 模拟"包内文件损坏"
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "assets/a.png" to real,
            DesignPack.MANIFEST_ENTRY to manifest(listOf(Triple("assets/a.png", other, listOf("node")))),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("CRC32") && it.contains("assets/a.png") })
        // 十六进制报出来 —— 十进制看不出来对不对
        assertTrue(problems.toString(), problems.any { it.contains("%08x".format(crcOf(other))) })
    }

    @Test
    fun `字节数不符要明确报错`() {
        val real = "12345".toByteArray()
        val claimed = "1234567890".toByteArray()
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "assets/a.png" to real,
            DesignPack.MANIFEST_ENTRY to manifest(listOf(Triple("assets/a.png", claimed, listOf("node")))),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("字节数不符") && it.contains("assets/a.png") })
    }

    @Test
    fun `清单里有、包里没有的素材要报缺失`() {
        val gone = "缺的".toByteArray()
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            DesignPack.MANIFEST_ENTRY to manifest(listOf(Triple("assets/missing.png", gone, listOf("node")))),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("素材缺失") && it.contains("assets/missing.png") })
    }

    @Test
    fun `格式版本不对要拒收并说出认哪个版本`() {
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            DesignPack.MANIFEST_ENTRY to manifest(emptyList(), format = "icar.pack/2"),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("icar.pack/2") && it.contains(DesignPack.PACK_FORMAT) })
    }

    @Test
    fun `没有 manifest 就不是设计包`() {
        val bytes = zip(DesignPack.DESIGN_ENTRY to designJson, "assets/a.png" to "x".toByteArray())
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("manifest.json") })
    }

    @Test
    fun `没有设计文件条目也要说清`() {
        val bytes = zip(
            DesignPack.MANIFEST_ENTRY to manifest(emptyList()),
            "assets/a.png" to "x".toByteArray(),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("design.json") })
    }

    @Test
    fun `manifest 是坏 JSON 时报解析失败而不是崩`() {
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            DesignPack.MANIFEST_ENTRY to "{ 这不是 JSON".toByteArray(),
        )
        val problems = failProblems(unpack(bytes))
        assertTrue(problems.toString(), problems.any { it.contains("解析失败") })
    }

    @Test
    fun `根本不是 zip 时被拒收而不是崩`() {
        // 注意：`ZipInputStream` 对"没有 LOCSIG"的输入**不抛异常**，直接返回"没有条目"。
        // 所以这里会走到"没有 manifest.json"那一条 —— 这正是要给用户看的话。
        val problems = failProblems(unpack("我不是 zip".toByteArray()))
        assertTrue(problems.toString(), problems.isNotEmpty())
        assertTrue(
            problems.toString(),
            problems.any { it.contains("manifest.json") || it.contains("解压失败") }
        )
    }

    // ================================================================ 放行但要说出来

    @Test
    fun `工具导出时就缺的素材：放行，但逐条列成警告`() {
        val a = "有的".toByteArray()
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "assets/a.png" to a,
            DesignPack.MANIFEST_ENTRY to manifest(
                listOf(Triple("assets/a.png", a, listOf("node"))),
                missing = listOf("assets/gone1.png" to "读不到字节", "assets/gone2.png" to "缩略图太小"),
            ),
        )
        val r = ok(unpack(bytes))
        assertEquals(1, r.warnings.size)
        assertTrue(r.warnings[0], r.warnings[0].contains("assets/gone1.png"))
        assertTrue(r.warnings[0], r.warnings[0].contains("assets/gone2.png"))
        // 素材本身还是解出来了
        assertTrue(File(r.dir, "assets/a.png").isFile)
    }

    @Test
    fun `包里多出不在清单里的文件：放行，但要说出来`() {
        val a = "有的".toByteArray()
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            "assets/a.png" to a,
            "assets/多余.png" to "多".toByteArray(),
            DesignPack.MANIFEST_ENTRY to manifest(listOf(Triple("assets/a.png", a, listOf("node")))),
        )
        val r = ok(unpack(bytes))
        assertTrue(r.warnings.toString(), r.warnings.any { it.contains("assets/多余.png") })
    }

    @Test
    fun `清单里一个素材都没有的包也能解开（纯控件设计）`() {
        val bytes = zip(
            DesignPack.DESIGN_ENTRY to designJson,
            DesignPack.MANIFEST_ENTRY to manifest(emptyList()),
        )
        val r = ok(unpack(bytes))
        assertTrue(r.manifest.assets.isEmpty())
        assertEquals(2, r.extractedFiles)
        assertNotNull(r.designJson)
    }
}
