package com.icar.obd.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **知识库 / 使用手册的结构守卫**（v1.20.11）。
 *
 * ## 为什么这一批用例值得写
 *
 * 这一页的正文是"文档性质的代码" —— 它**没有编译期约束**，改起来很快，
 * 但也正因为如此，有三件事会**静默坏掉**（页面看起来完全正常，只是内容错了）：
 *
 * 1. **`TAG_MAP` 是按节索引挂标签的**（见 [KnowledgeFragment.TAG_MAP] 的注释）。
 *    在 [KnowledgeFragment.SECTIONS] 中间插一节而忘了改映射 →
 *    点「CAN」筛出来的是别的节。v1.20.11 就是一次"中间插节"：
 *    原有的收尾节从索引 12 挪到了 18 —— 这类改动**必须有东西钉住**。
 * 2. **正文里写 Markdown 标记会原样显示**：这一页是 `TextView.text = 字符串`，
 *    不做渲染。v1.20.2 的第一版正文里全是 `**粗体**`，用户在平板上看到的是
 *    "**受轮询节奏限制**"（星号原样显示）。这条**踩过一次，不能再踩**。
 * 3. **标签词表与映射会分叉**：`TAGS` 里多写一个、`TAG_MAP` 里少挂一个，
 *    表现都是"某个 chip 点下去永远是 0 节"。
 *
 * 这三条都**没有别的守门人**（没有编译错误、没有运行时异常、真机上也看不出），
 * 所以只能靠这里。
 */
class KnowledgeFragmentTest {

    private val sections get() = KnowledgeFragment.SECTIONS
    private val tagMap get() = KnowledgeFragment.TAG_MAP
    private val tags get() = KnowledgeFragment.TAGS

    // ---------------------------------------------------------------- 索引对齐

    /**
     * **索引必须连续覆盖全部节**。
     *
     * 只写 `mapOf(0 to …, 5 to …)` 这种"漏了几个索引"的写法不会报错，
     * 但漏掉的那一节**没有任何标签** → 点任何标签都筛不出它，
     * 而"全部"里它明明在。这是最难被发现的一种。
     */
    @Test
    fun `每一节都有标签且索引连续`() {
        assertEquals(
            "TAG_MAP 的条目数必须等于节数（漏一条 = 那一节没有任何标签）",
            sections.size, tagMap.size
        )
        for (i in sections.indices) {
            assertTrue(
                "第 $i 节「${sections[i].title}」在 TAG_MAP 里没有条目 —— 中间插节时要顺手改映射",
                tagMap.containsKey(i)
            )
        }
        assertEquals(
            "TAG_MAP 的索引必须正好是 0..${sections.size - 1}",
            (0 until sections.size).toList(),
            tagMap.keys.sorted()
        )
    }

    /** 映射里不许指向不存在的节（多写一条 = 那次改动只改了一半） */
    @Test
    fun `标签映射不指向不存在的节`() {
        tagMap.keys.forEach { idx ->
            assertTrue("TAG_MAP 里的索引 $idx 超出了节数 ${sections.size}", idx in sections.indices)
        }
    }

    // ---------------------------------------------------------------- 标签词表

    /** 映射里用的标签**必须都在词表里**（否则那个 chip 根本不会出现） */
    @Test
    fun `映射里的标签都在词表里`() {
        tagMap.forEach { (idx, list) ->
            assertTrue("第 $idx 节的标签不能为空", list.isNotEmpty())
            list.forEach { t ->
                assertTrue(
                    "第 $idx 节用了词表里没有的标签「$t」—— 它不会出现在标签条上，等于白挂",
                    tags.contains(t)
                )
            }
        }
    }

    /** 词表里不许有**死标签**（一个节都没挂 = 点下去永远 0 节） */
    @Test
    fun `词表里没有死标签`() {
        val used = tagMap.values.flatten().toSet()
        tags.forEach { t ->
            assertTrue(
                "标签「$t」没有任何一节在用它 —— 点它只会显示 0 节",
                used.contains(t)
            )
        }
    }

    /**
     * 标签条不能撑爆。
     *
     * v1.20.11 之前是 8 个（+「全部」），这一版加到 11 个（+「全部」= 12 个 chip）。
     * 上限写在这里是为了让"下次再加标签"必须**先想一下**：
     * 标签条是一屏内要一眼扫完的东西，两行以上就没人看了。
     */
    @Test
    fun `标签数量在上限内`() {
        assertTrue(
            "标签词表 ${tags.size} 个（+「全部」= ${tags.size + 1} 个 chip）—— 上限 11 个，" +
                "再加会让标签条占两行以上，那时「筛选手册」这个动作本身就不如「看清标签」重要了",
            tags.size <= 11
        )
        assertTrue("至少要有「全部」之外的一个标签", tags.isNotEmpty())
    }

    /** 标签不许重复（重复的 chip 无法区分，而且点哪个都筛同一批） */
    @Test
    fun `标签词表没有重复项`() {
        assertEquals("标签词表里有重复项", tags.size, tags.toSet().size)
    }

    // ---------------------------------------------------------------- 手册那一类

    /**
     * **手册必须能被一个标签整类筛出来**（用户要求："加一个类目：软件使用手册"）。
     *
     * 这条同时钉住"手册各节一个都不能漏挂 `使用手册`"——
     * 漏挂的表现是"点使用手册少看到一节"，而那是最难被发现的缺失。
     */
    @Test
    fun `手册各节都带使用手册标签`() {
        val manualTag = "使用手册"
        assertTrue("标签词表里必须有「$manualTag」", tags.contains(manualTag))

        val manual = sections.withIndex().filter { (i, _) ->
            tagMap[i]?.contains(manualTag) == true
        }
        assertEquals("手册应该是 12 节（手册 1~12）", 12, manual.size)

        manual.forEachIndexed { n, (_, s) ->
            assertTrue(
                "手册第 ${n + 1} 节标题应以「手册 ${n + 1} · 」开头，实际是「${s.title}」" +
                    "（手册按「用户第一次用会卡在哪」排序，编号必须连续）",
                s.title.startsWith("手册 ${n + 1} · ")
            )
        }
    }

    /**
     * 手册各节都要有「前置 / 步骤 / 判据 / 没成功怎么办」四栏 —— 缺哪栏就是没写完。
     *
     * ⚠️ 「步骤」只查到前缀：手册 4 把步骤栏拆成「步骤 A · 日常使用」与
     * 「步骤 B · 自己造一条监听型 PID」两段（那一条本来就分两件事）。
     * 查完整的「【步骤】」会把它误判成"缺一栏" —— 第一版就是这么写的，
     * 被这条用例自己抓到了。
     */
    @Test
    fun `手册各节都有前置步骤判据与排障`() {
        val manualTag = "使用手册"
        sections.withIndex()
            .filter { (i, _) -> tagMap[i]?.contains(manualTag) == true }
            .forEach { (_, s) ->
                listOf("【前置】", "【步骤", "【判据", "【没成功怎么办】").forEach { mark ->
                    assertTrue(
                        "「${s.title}」缺 $mark 一栏 —— 手册的写法是四栏固定" +
                            "（排障那一栏才是真正省时间的东西）",
                        s.body.contains(mark)
                    )
                }
            }
    }

    /** 知识那一类不许混进手册标签（否则"点使用手册"会看到原理讲解） */
    @Test
    fun `知识各节不带使用手册标签`() {
        val manualTag = "使用手册"
        sections.withIndex()
            .filter { (i, _) -> tagMap[i]?.contains(manualTag) != true }
            .forEach { (i, s) ->
                assertTrue(
                    "第 $i 节「${s.title}」被当成知识节了，但它看起来像手册",
                    !s.title.startsWith("手册 ")
                )
            }
    }

    // ---------------------------------------------------------------- 正文格式

    /**
     * **正文里不许出现 Markdown 标记**（v1.20.11 全量清理过）。
     *
     * 这一页不做渲染：`TextView.text = 字符串`，`LinkMovementMethod` 只处理链接。
     * 所以 `**粗体**` 会原样显示星号、反引号也会原样显示 ——
     * v1.20.2 的第一版就踩了这个坑，用户在平板上看到的是 "**受轮询节奏限制**"。
     *
     * ⚠️ 只查**成对**的 `**`：正文里有单个 `*` 是**正常的**
     * （公式里的乘号，如 `A * 0.1 - 48`）。
     */
    @Test
    fun `正文里没有Markdown标记`() {
        sections.forEach { s ->
            assertTrue(
                "「${s.title}」的正文里有 `**`（粗体）—— 这一页不渲染 Markdown，" +
                    "用户在平板上会看到原样的星号。改用纯文本 + 编号 + ·",
                !s.body.contains("**")
            )
            assertTrue(
                "「${s.title}」的正文里有反引号 —— 这一页不渲染 Markdown，会原样显示",
                !s.body.contains("`")
            )
        }
    }

    /** 标题与正文都不能为空，标题不能重复（重复的标题在搜索结果里分不清） */
    @Test
    fun `标题与正文都非空且标题不重复`() {
        sections.forEachIndexed { i, s ->
            assertTrue("第 $i 节标题为空", s.title.isNotBlank())
            assertTrue("第 $i 节「${s.title}」正文为空", s.body.isNotBlank())
        }
        val dup = sections.groupBy { it.title }.filterValues { it.size > 1 }.keys
        assertTrue("标题重复：$dup", dup.isEmpty())
    }

    /**
     * 正文里的缩进只能用**全角空格**（`　`）或普通空格，不许用 Tab。
     *
     * Tab 在 `trimIndent()` 里不参与"公共缩进"的计算，会算出一个诡异的前缀
     * —— 表现是"整段文字左边多出一截空白"，而代码里完全看不出来。
     */
    @Test
    fun `正文里没有Tab缩进`() {
        sections.forEach { s ->
            assertTrue("「${s.title}」的正文里有 Tab 字符", !s.body.contains('\t'))
        }
    }
}
