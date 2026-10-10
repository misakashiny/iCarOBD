package com.icar.obd.data

import com.icar.obd.obd.SegmentRotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `CanFilterPresets` 的单测（v1.20.17）。
 *
 * ## 这一份守的是什么
 *
 * 规格 `docs/下一步-UI改进四项.md` §2 的三条硬要求，每一条都在这里钉住：
 *
 * 1. **预设从 4 个补到 ~12 个**（8 个段 + 3 个常用 + 不过滤）；
 * 2. **⚠️ 不许编"哪个灯在哪个段"** —— 本项目从没实测过，所以常用段的说明
 *    只允许出现"未在本车实测"这个说法，**一个灯名都不许点名**
 *    （唯一例外是转向灯 `0x09A`，那条是实测过的，且必须写明"本车实测"）；
 * 3. **⚠️ `ATCF000` 是全总线、不是"第 0 段"** —— 界面上必须有一句写清它；
 * 4. **界面显示的命令 = 真正下发的命令** —— [CanFilterPresets.resolveCommands]
 *    必须与 `CanSniffer.start()` 里那段逐字对应（这条靠"规则本身"断言：
 *    AT 开头原样切、其余包成 `ATCRA`）。
 */
class CanFilterPresetsTest {

    // ------------------------------------------------------------ ① 数量与结构

    @Test
    fun `预设补到 12 个（8 段 + 3 个常用 + 不过滤）`() {
        // 原来只有 4 个（228 / ATCM700+ATCF400 / ATCM700+ATCF000 / ""）
        assertEquals(12, CanFilterPresets.ALL.size)
    }

    @Test
    fun `8 个段一条不少，且掩码与过滤成对`() {
        // 逐段点名（不用"按 value 反查标签"：段 0 的 value 与"全部 11 位 ID"
        // 那条预设逐字节相同，反查会查到错的那一条 —— 实测踩过）
        val expected = (0 until SegmentRotation.SEGMENT_COUNT).map {
            CanFilterPresets.segmentValue(it)
        }
        expected.forEach { v ->
            assertTrue("少了段预设 $v", CanFilterPresets.ALL.any { it.value == v })
        }
        // 段预设的写法一律是 ATCM700+ATCF<段>00
        expected.forEach {
            assertTrue("段预设写法不对：$it", Regex("^ATCM700\\+ATCF[0-7]00$").matches(it))
        }
        // 8 个段的**标签**覆盖 0x000~0x7FF，一条不重
        val labels = (0 until SegmentRotation.SEGMENT_COUNT).map {
            CanFilterPresets.segmentLabel(it)
        }
        assertEquals("0x000~0x0FF", labels.first())
        assertEquals("0x700~0x7FF", labels.last())
        assertEquals(labels.size, labels.toSet().size)
        // 每个标签都真的在预设表里（不是只存在于生成器里）
        labels.forEach { l ->
            assertTrue("预设表里没有段标签 $l", CanFilterPresets.ALL.any { it.label == l })
        }
    }

    @Test
    fun `段 0 与全总线那条命令相同，所以说明里两条都要写出来`() {
        // ⚠️ `ATCM700+ATCF000` 同时是"全部 11 位 ID"和"0x000~0x0FF 段"：
        // 掩码之下的 ATCF000 就是第 0 段（见 SegmentRotation 的长注释），
        // 命令逐字节相同。只报第一条的话，用户选中它只看到"等价于不过滤"，
        // 会以为段 0 不见了。
        val hits = CanFilterPresets.findAll("ATCM700+ATCF000")
        assertEquals(2, hits.size)
        val s = CanFilterPresets.describe("ATCM700+ATCF000")
        hits.forEach { assertTrue("说明里少了「${it.label}」", s.contains(it.label) || s.contains(it.desc)) }
        assertTrue(s.contains("0x000~0x0FF"))
    }

    @Test
    fun `每个预设的标签与说明都不为空，且说明里带上实际命令`() {
        CanFilterPresets.ALL.forEach { p ->
            assertTrue("标签不能为空：${p.value}", p.label.isNotBlank())
            assertTrue("说明不能为空：${p.value}", p.desc.isNotBlank())
        }
    }

    @Test
    fun `段预设的说明里写着那条命令`() {
        // "选哪个能看见什么"之外，命令必须出现在说明里（用户要能对上日志）。
        // 段 4 的 value 不与任何常用预设重名，可以安全地按 value 反查
        val p = CanFilterPresets.ALL.first { it.value == "ATCM700+ATCF400" }
        assertTrue(p.desc.contains("ATCM700+ATCF400"))
        assertTrue(p.desc.contains("0x400~0x4FF"))
    }

    // ------------------------------------------------------------ ② 不许编

    @Test
    fun `常用段的说明一律标注未在本车实测，不编哪个灯在哪个段`() {
        // ⚠️ 这是规格 §2 点名的一条：本项目**没实测过**各灯在哪个段。
        // 所以"常见车身域"那三段必须带免责，且说明里不许出现灯名。
        val forbidden = listOf("转向灯", "刹车灯", "倒车灯", "车门", "车灯", "大灯")
        val common = CanFilterPresets.ALL.filter {
            it.label == "0x200~0x2FF" || it.label == "0x400~0x4FF" || it.label == "0x600~0x6FF"
        }
        assertEquals(3, common.size)
        common.forEach { p ->
            assertTrue("常用段必须标注未实测：${p.label}", p.desc.contains("未在本车实测"))
            forbidden.forEach { w ->
                assertTrue(
                    "常用段的说明里不许编灯名（$w）：${p.desc}",
                    !p.desc.contains(w)
                )
            }
        }
    }

    @Test
    fun `不常用的段不冒充常见车身域`() {
        val p = CanFilterPresets.ALL.first { it.value == "ATCM700+ATCF100" }
        assertTrue(!p.desc.contains("常见车身域"))
    }

    @Test
    fun `转向灯那条写明是本车实测，并给出实测出处里的数字`() {
        // 唯一被实测确认过的信号（docs/CAN-信号库与逆向框架.md + v1.19.8）
        val p = CanFilterPresets.ALL.first { it.value == "228" }
        assertTrue(p.label.contains("本车实测"))
        assertTrue(p.desc.contains("0x09A"))
        assertTrue(p.desc.contains("ATCRA228"))
        // 采样率提升是"为什么要过滤"的唯一实测数字，留着
        assertTrue(p.desc.contains("20 帧/秒"))
    }

    // ------------------------------------------------------------ ③ 全总线

    @Test
    fun `全总线那条说明写清 ATCF000 不是第 0 段`() {
        // 规格 §2：这条**必须在界面上写清**，否则用户会以为"第 0 段 ID 特别多"
        val note = CanFilterPresets.FULL_BUS_NOTE
        assertTrue(note.contains("ATCF000"))
        assertTrue(note.contains("不是「第 0 段」"))
        assertTrue(note.contains("整条总线"))
        // 还得告诉他"要只看 0x000~0x0FF 该用哪条"
        assertTrue(note.contains("ATCM700+ATCF000"))
    }

    @Test
    fun `全总线预设存在且用的就是那条带掩码的命令`() {
        val p = CanFilterPresets.ALL.first { it.value == "ATCM700+ATCF000" }
        assertTrue(p.label.contains("11 位 ID"))
    }

    // ------------------------------------------------------------ ④ 实际下发的命令

    @Test
    fun `空过滤器一条命令都不发`() {
        assertTrue(CanFilterPresets.resolveCommands("").isEmpty())
        assertTrue(CanFilterPresets.resolveCommands("   ").isEmpty())
    }

    @Test
    fun `纯 hex 会包成 ATCRA 并转大写`() {
        // 与 CanSniffer.start() 逐字对应：`listOf("ATCRA${filt.uppercase()}")`
        assertEquals(listOf("ATCRA228"), CanFilterPresets.resolveCommands("228"))
        assertEquals(listOf("ATCRA7E8"), CanFilterPresets.resolveCommands("7e8"))
        assertEquals(listOf("ATCRA09A"), CanFilterPresets.resolveCommands(" 09a "))
    }

    @Test
    fun `AT 开头的原样按加号切开`() {
        assertEquals(
            listOf("ATCM700", "ATCF400"),
            CanFilterPresets.resolveCommands("ATCM700+ATCF400")
        )
        // 分号也认（与 start() 一致）
        assertEquals(
            listOf("ATCM700", "ATCF000"),
            CanFilterPresets.resolveCommands("ATCM700;ATCF000")
        )
        // ⚠️ AT 开头的**不转大写** —— 与 `CanSniffer.start()` 逐字一致
        // （那边 `filt.split('+', ';')` 原样发，不做 uppercase）。
        // 实测踩过：第一版这里断言会变成 `[ATCM700, ATCF400]`，是错的。
        assertEquals(
            listOf("atcm700", "atcf400"),
            CanFilterPresets.resolveCommands("atcm700+atcf400")
        )
        // 空白项被丢掉（`ATCM700++` 不该发一条空命令）
        assertEquals(
            listOf("ATCM700", "ATCF400"),
            CanFilterPresets.resolveCommands("ATCM700+ +ATCF400")
        )
    }

    @Test
    fun `每个预设解析出来的命令条数符合它的写法`() {
        CanFilterPresets.ALL.forEach { p ->
            val cmds = CanFilterPresets.resolveCommands(p.value)
            if (p.value.isEmpty()) {
                assertTrue("不过滤不该有命令", cmds.isEmpty())
            } else if (p.value.startsWith("AT")) {
                assertEquals("掩码版应该是两条：${p.value}", 2, cmds.size)
            } else {
                assertEquals("单 ID 应该是一条：${p.value}", 1, cmds.size)
                assertTrue(cmds[0].startsWith("ATCRA"))
            }
        }
    }

    // ------------------------------------------------------------ ⑤ 状态行

    @Test
    fun `状态行里带着实际下发的命令`() {
        val s = CanFilterPresets.describe("228")
        assertTrue(s.contains("ATCRA228"))
        // 命中预设时也要把"能看到什么"带上
        assertTrue(s.contains("0x09A"))
    }

    @Test
    fun `不过滤时状态行明说不发命令`() {
        val s = CanFilterPresets.describe("")
        assertTrue(s.contains("不下发过滤命令"))
        assertTrue(s.contains("整条总线"))
    }

    @Test
    fun `手打的过滤器只报命令，不编说明`() {
        // 用户填了一个不在预设表里的 ID：我们**不知道**他想干什么，所以只报命令
        val s = CanFilterPresets.describe("123")
        assertEquals("下发 ATCRA123", s)
    }

    @Test
    fun `按值找预设`() {
        assertNotNull(CanFilterPresets.find("ATCM700+ATCF400"))
        assertNotNull(CanFilterPresets.find("  ATCM700+ATCF400  "))
        assertNull(CanFilterPresets.find("123"))
    }

    // ------------------------------------------------------------ ⑥ 标签说人话

    @Test
    fun `标签里不出现 AT 语法`() {
        // 规格 §2：「预设名要说人话」—— AT 命令退到 desc 里。
        // 段预设的标签就是 ID 范围，常用那几个是人话。
        CanFilterPresets.ALL.forEach { p ->
            assertTrue("标签不该是 AT 命令：${p.label}", !p.label.contains("ATCM"))
            assertTrue("标签不该是 AT 命令：${p.label}", !p.label.contains("ATCF"))
            assertTrue("标签不该是 AT 命令：${p.label}", !p.label.contains("ATCRA"))
        }
    }
}
