package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * **预设音效清单的守卫**（v1.20.21）。
 *
 * 用户原话：「规则里增加更多的预设音效」。
 *
 * 这一版把音效从 4 个加到 **9 个**，并且第一次有了**选择入口**（编辑器的 🎵）。
 * 清单是 [SoundPresets.ALL]，而"到底有没有这个文件、文件能不能放、会不会把
 * APK 撑大"这三件事**光看代码看不出来** —— 所以逐条落到磁盘上量：
 *
 * | 断言 | 挡住的失效 |
 * |---|---|
 * | 每个 id 都有 `res/raw/<id>.wav` | 清单里写了一条、文件忘了生成（选了**静默不响**） |
 * | 每个文件是合法的 RIFF/WAVE PCM 16bit 单声道 | 生成脚本写坏头（SoundPool 拒载，同样静默） |
 * | 每个文件有**非零采样** | 生成出静音文件（"点了没声"，最难查） |
 * | 每个文件 ≤ 20 KB | APK 体积被音效悄悄撑大（目标写在需求里） |
 * | id 与 label 都不重名 | 两条预设显示成一模一样，用户选哪个都不知道 |
 * | label 说人话（不是 `sound1` / 不是 id 本身） | 用户原话「不要 sound1/sound2」 |
 * | 覆盖轻提示/警告/严重/成功/失败/叮咚 | 需求里点名的六类语义 |
 */
class SoundPresetsTest {

    // ---------------------------------------------------------------- 工具

    /**
     * 定位 `app/src/main/res/raw/`。
     *
     * 单测的工作目录在不同调用方式下不一样（Gradle 从 `app/` 跑、IDE 可能从工程根跑），
     * 而且本项目是用 ASCII 联接 `D:\icarobd` 跑的 —— 所以多试几个候选路径。
     *
     * ⚠️ **找不到就失败，不跳过**（v1.20.19 的教训：跳过 = 这条断言这一轮没跑）。
     */
    private fun rawDir(): File {
        val rel = "src/main/res/raw"
        val candidates = listOf(
            File(rel),
            File("../app/$rel"),
            File("app/$rel"),
            File(System.getProperty("user.dir"), rel),
            File(System.getProperty("user.dir"), "../app/$rel"),
        )
        return candidates.firstOrNull { it.isDirectory } ?: throw AssertionError(
            "找不到 res/raw 目录 —— 试过这些路径：\n" +
                candidates.joinToString("\n") { "  " + it.absolutePath } +
                "\n当前工作目录：${System.getProperty("user.dir")}\n" +
                "请在工程目录下运行 tools/run-tests.ps1。"
        )
    }

    /** 一个 wav 的头信息（只认本项目生成器产出的那种：16bit 单声道 PCM） */
    private data class Wav(
        val channels: Int,
        val sampleRate: Int,
        val bitsPerSample: Int,
        val audioFormat: Int,
        val dataBytes: Int,
        val fileBytes: Long
    ) {
        val durationMs: Double get() = dataBytes.toDouble() / (sampleRate * channels * bitsPerSample / 8) * 1000.0
    }

    private fun le16(b: ByteArray, o: Int) = (b[o].toInt() and 0xFF) or ((b[o + 1].toInt() and 0xFF) shl 8)
    private fun le32(b: ByteArray, o: Int) = le16(b, o) or (le16(b, o + 2) shl 16)
    private fun tag(b: ByteArray, o: Int) = String(b, o, 4, Charsets.US_ASCII)

    /** 解析 wav 头；不是合法 WAV 就抛断言错（**不是**返回 null —— 静默跳过是最坏的结果） */
    private fun parseWav(f: File): Wav {
        val b = f.readBytes()
        assertTrue("$f 太短（${b.size} 字节），不可能是 wav", b.size >= 44)
        assertEquals("$f 不是 RIFF 文件", "RIFF", tag(b, 0))
        assertEquals("$f 不是 WAVE", "WAVE", tag(b, 8))
        assertEquals("$f 的 fmt 段不对（本项目只生成 16 字节 fmt）", "fmt ", tag(b, 12))
        assertEquals("$f fmt 段长度不是 16", 16, le32(b, 16))
        assertEquals("$f data 段不在 36 偏移（本项目不写扩展块）", "data", tag(b, 36))
        return Wav(
            audioFormat = le16(b, 20),
            channels = le16(b, 22),
            sampleRate = le32(b, 24),
            bitsPerSample = le16(b, 34),
            dataBytes = le32(b, 40),
            fileBytes = f.length()
        )
    }

    // ---------------------------------------------------------------- 清单本身

    @Test
    fun `预设列表不为空且比 v1_20_20 更多`() {
        // v1.20.20 及以前只有 tick_left / tick_right / warn / beep 四个
        assertTrue("预设不能少于 4 个（原有四个是底线）", SoundPresets.ALL.size >= 4)
        assertTrue("这一版的目标是「更多预设音效」，实际只有 ${SoundPresets.ALL.size} 个",
            SoundPresets.ALL.size >= 9)
    }

    @Test
    fun `预设 id 不重名`() {
        val dup = SoundPresets.ALL.groupBy { it.id }.filter { it.value.size > 1 }.keys
        assertTrue("这些 id 重名：$dup（后一条会盖掉前一条）", dup.isEmpty())
    }

    @Test
    fun `预设显示名不重名`() {
        val dup = SoundPresets.ALL.groupBy { it.label }.filter { it.value.size > 1 }.keys
        assertTrue("这些显示名重名：$dup（用户在列表里分不出哪条是哪条）", dup.isEmpty())
    }

    @Test
    fun `id 只含小写字母与下划线`() {
        // Android 的 res/raw 文件名规则：`R.raw.<id>` 必须能作为标识符
        val bad = SoundPresets.ALL.map { it.id }.filterNot { it.matches(Regex("[a-z][a-z0-9_]*")) }
        assertTrue("这些 id 不能作为资源名：$bad", bad.isEmpty())
    }

    @Test
    fun `显示名说人话`() {
        // 用户原话：「让名字说人话（不要 sound1/sound2）」
        val bad = SoundPresets.ALL.filter { p ->
            p.label.isBlank() ||
                p.label == p.id ||
                Regex("^sound\\d*$", RegexOption.IGNORE_CASE).matches(p.label) ||
                Regex("^(preset|tone|audio)[-_]?\\d+$", RegexOption.IGNORE_CASE).matches(p.label)
        }
        assertTrue(
            "这些显示名是机器名（用户看不懂）：${bad.map { "${it.id}→${it.label}" }}",
            bad.isEmpty()
        )
        // 反过来：名字里得有中文（这个 App 的用户界面全是中文）
        val noCjk = SoundPresets.ALL.filterNot { p -> p.label.any { it.code in 0x4E00..0x9FFF } }
        assertTrue("这些显示名里一个中文字都没有：${noCjk.map { it.label }}", noCjk.isEmpty())
    }

    @Test
    fun `覆盖需求点名的六类语义`() {
        val all = SoundPresets.ALL.joinToString(" ") { "${it.label} ${it.category} ${it.hint}" }
        listOf("轻提示", "警告", "严重", "成功", "失败", "叮咚").forEach { kw ->
            assertTrue("预设里缺少「$kw」这一类语义", all.contains(kw))
        }
    }

    @Test
    fun `每个预设都有分类与说明`() {
        SoundPresets.ALL.forEach { p ->
            assertTrue("${p.id} 没有分类", p.category.isNotBlank())
            assertTrue("${p.id} 没有说明", p.hint.isNotBlank())
        }
    }

    // ---------------------------------------------------------------- 查表

    @Test
    fun `byId 大小写与首尾空白容错`() {
        assertEquals("ding", SoundPresets.byId("  DING ")?.id)
        assertEquals("轻提示「叮」", SoundPresets.labelOf("ding"))
        assertNull("不是预设时必须返回 null（调用方据此回退显示原始 id）", SoundPresets.byId("myBlip"))
        assertNull(SoundPresets.byId(""))
        assertNull(SoundPresets.byId("   "))
        assertNull(SoundPresets.labelOf("content://media/external/audio/1"))
    }

    @Test
    fun `ids 与 ALL 一致且不重名`() {
        assertEquals(SoundPresets.ALL.size, SoundPresets.ids.size)
        assertEquals(SoundPresets.ids.size, SoundPresets.ids.toSet().size)
    }

    @Test
    fun `分组不丢条目`() {
        val n = SoundPresets.grouped().sumOf { it.second.size }
        assertEquals("分组后条目数变了", SoundPresets.ALL.size, n)
    }

    // ---------------------------------------------------------------- 磁盘上的文件

    @Test
    fun `每个预设音效文件都存在`() {
        val dir = rawDir()
        val missing = SoundPresets.ALL.map { "${it.id}.wav" }.filterNot { File(dir, it).isFile }
        assertTrue(
            "这些预设的 wav 不在 $dir 里：$missing —— 跑 `python tools/gen_sounds.py` 重新生成",
            missing.isEmpty()
        )
    }

    @Test
    fun `每个 wav 都能被解码且不是静音`() {
        val dir = rawDir()
        SoundPresets.ALL.forEach { p ->
            val f = File(dir, "${p.id}.wav")
            val w = parseWav(f)
            assertEquals("${p.id} 不是 PCM（SoundPool 只认 PCM/OGG）", 1, w.audioFormat)
            assertEquals("${p.id} 不是单声道", 1, w.channels)
            assertEquals("${p.id} 不是 16bit", 16, w.bitsPerSample)
            assertTrue("${p.id} 采样率异常：${w.sampleRate}", w.sampleRate in 8000..48000)
            assertTrue("${p.id} 时长为 0", w.durationMs > 10.0)
            assertTrue("${p.id} 声明的数据长度超过文件本身", w.dataBytes + 44 <= w.fileBytes)

            // 「能被解码」的实质判据：真有非零采样。
            // 全零的 wav 头完全合法、SoundPool 也照收 —— 表现是"点了没声"，
            // 是这一整类故障里最难查的一种。
            val data = f.readBytes()
            val nonZero = (44 until minOf(data.size, 44 + 4096))
                .any { data[it] != 0.toByte() }
            assertTrue("${p.id} 前 4KB 全是零 —— 像是生成了静音文件", nonZero)
        }
    }

    @Test
    fun `每个音效不超过 20 KB`() {
        // 需求里的硬约束：APK 约 7 MB，音效不许把它撑大。
        // 22050Hz / 16bit / 单声道 = 44 字节/毫秒 → 时长 ≤ 440ms 自然满足。
        val dir = rawDir()
        val tooBig = SoundPresets.ALL.map { File(dir, "${it.id}.wav") }
            .filter { it.length() > 20 * 1024 }
            .map { "${it.name}=${it.length()}B" }
        assertTrue("这些音效超过 20 KB：$tooBig —— 缩短时长或降低采样率后重跑 gen_sounds.py", tooBig.isEmpty())
    }

    @Test
    fun `音效总体积没有暴涨`() {
        // 单个 ≤ 20KB 还不够：9 个一起也能堆出 180KB。给整包一个上限，
        // 免得"每次加一条都合理"最后把 APK 顶过构建守卫的 8 MB 阈值。
        val dir = rawDir()
        val total = SoundPresets.ALL.sumOf { File(dir, "${it.id}.wav").length() }
        assertTrue(
            "预设音效合计 ${total / 1024} KB，超过 130 KB 的预算 —— " +
                "加音效时请同时删掉不用的，或缩短时长",
            total <= 130 * 1024
        )
    }

    @Test
    fun `res raw 里没有游离的 wav`() {
        // 反向：磁盘上有、清单里没有 —— 多半是改名后忘了同步，
        // 或者删了预设但没删文件（白占 APK 体积）
        val dir = rawDir()
        val known = SoundPresets.ALL.map { "${it.id}.wav" }.toSet()
        val orphan = (dir.listFiles() ?: emptyArray())
            .filter { it.isFile && it.name.endsWith(".wav") && it.name !in known }
            .map { it.name }
        assertTrue("res/raw 里这些 wav 不在预设清单里（白占体积或忘了登记）：$orphan", orphan.isEmpty())
    }

    @Test
    fun `每个预设的 resId 都不同`() {
        // 两条预设指向同一个资源 = 用户选了 A 听到 B（而且从名字上看不出来）
        val ids = SoundPresets.ALL.map { it.resId }
        assertEquals("有预设共用同一个 res 资源", ids.size, ids.toSet().size)
        assertFalse("resId 全 0 —— R 类没被正确加载，用例的判据不成立", ids.all { it == 0 })
    }

    @Test
    fun `描述里显示的是人话而不是机器名`() {
        // 端到端一条：规则描述那一行（用户在规则列表里读到的）必须是人话
        val d = RuleAction("sound", "dingdong").describe()
        assertEquals("播放音效 叮咚（双音）", d)
        assertNotNull(d)
    }
}
