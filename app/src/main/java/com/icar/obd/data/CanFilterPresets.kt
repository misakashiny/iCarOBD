package com.icar.obd.data

import com.icar.obd.obd.SegmentRotation

/**
 * **CAN 探测 · 过滤器预设**（v1.20.17）—— 纯数据 + 纯函数，JVM 单测覆盖。
 *
 * ## 为什么抽出来
 *
 * 规格 `docs/下一步-UI改进四项.md` §2：「优化 CAN 探测的过滤器预设、增加更多预设」——
 * 原来只有 4 个（`228` / `ATCM700+ATCF400` / `ATCM700+ATCF000` / `""`），
 * 而且**名字是 AT 语法**（`ATCM700+ATCF400`），用户根本看不出"选哪个能看见什么"。
 *
 * 而"选完之后实际会下发哪几条 AT 命令"这件事，写在 `ui/CanSnifferActivity` 里
 * 就**一条都测不到**（那边一碰 Android 就跑不了 JVM 单测）。所以：
 * - 预设表在这里（纯数据）；
 * - "过滤串 → 实际命令"的解析也在这里（纯函数），**与 `CanSniffer.start()` 同一套规则**。
 *
 * ## 三条显示纪律（规格 §2 明确点名）
 *
 * 1. **说人话**：标签是"能看见什么"（`0x400~0x4FF`），命令退到 `desc` 里做补充；
 * 2. **⚠️ 不许编"哪个灯在哪个段"** —— 本项目**从没实测过**各灯在哪个段，
 *    所以常用段的说明一律写「常见车身域（**未在本车实测**）」，一个灯都不点名；
 *    唯一实测确认过的是转向灯 `0x09A`（见 `docs/CAN-信号库与逆向框架.md`），
 *    那条单独一个预设，而且写明"本车实测"。
 * 3. **⚠️ `ATCF000` 是全总线、不是"第 0 段"** —— 这条必须在界面上写清
 *    （[FULL_BUS_NOTE]），否则用户会以为"第 0 段 ID 特别多"。
 */
object CanFilterPresets {

    /**
     * 一个预设。
     *
     * @param value 填进「过滤器」输入框的**原始串**（与手打完全同一种写法）。
     *   空串 = 不过滤；纯 hex = 单个 11 位 ID（会变成 `ATCRA<ID>`）；
     *   以 `AT` 开头 = 原样下发（`+` / `;` 分隔多条）。
     * @param label **人话**（"能看见什么"）。命令**不放在这里** —— 用户要的不是 AT 语法。
     * @param desc 选它之后那一行说明：能看到什么 + 命令 + 代价。
     */
    data class Preset(
        val value: String,
        val label: String,
        val desc: String,
    )

    /** 段长（一个 `ATCF<段>00` 覆盖 256 个 11 位 ID） */
    private const val SEGMENT_IDS = 256

    /**
     * 段预设的**唯一**生成器：`ATCM700+ATCF<段>00`，标签是它覆盖的 ID 范围。
     *
     * 掩码 `ATCM700` 与过滤 `ATCF<段>00` **必须成对**（见 `SegmentRotation` 的长注释）：
     * `ATCF000` 单独发是全总线，只有在掩码之下才等于"`0x0xx` 段"。
     * 这里生成的就是**成对**的那一串，用户点一下就两条一起发。
     */
    private fun segmentPreset(seg: Int): Preset {
        val lo = seg shl 8
        val hi = lo + SEGMENT_IDS - 1
        return Preset(
            value = segmentValue(seg),
            label = segmentLabel(seg),
            desc = segmentDesc(lo, hi)
        )
    }

    /**
     * 第 [seg] 段预设的 `value`（`ATCM700+ATCF<段>00`）。
     *
     * 公开出来是为了**测试能逐段点名**：段 0 的 value 与"全部 11 位 ID"那条
     * 预设逐字节相同（掩码之下的 `ATCF000` 就是第 0 段），
     * 所以按 value 反查标签会查到错的那一条（实测踩过）。
     */
    fun segmentValue(seg: Int): String =
        "${SegmentRotation.MASK_CMD}+${SegmentRotation.segmentFilter(seg)}"

    /** 第 [seg] 段预设的标签（它覆盖的 ID 范围，`0x400~0x4FF`） */
    fun segmentLabel(seg: Int): String {
        val s = seg.coerceIn(0, SegmentRotation.SEGMENT_COUNT - 1)
        return "0x%03X~0x%03X".format(s shl 8, (s shl 8) + SEGMENT_IDS - 1)
    }

    /**
     * 段说明。
     *
     * ⚠️ **一个字都不许编**：本项目**没有实测过**各灯/各模块在哪个段，
     * 所以这里只有两类内容 —— ①这条命令覆盖的 ID 范围（算出来的，确定）；
     * ②"车身域常用段"这个**行业通说**，并明确标注"未在本车实测"。
     * 唯一实测的是转向灯 `0x09A`（在 `0x0xx` 段里），单独写在 [LEFT_TURN_DESC]。
     */
    private fun segmentDesc(lo: Int, hi: Int): String {
        val range = "0x%03X~0x%03X".format(lo, hi)
        val common = lo == 0x200 || lo == 0x400 || lo == 0x600
        val head = if (common) "常见车身域（未在本车实测）" else "一段 ID"
        return "$head：$range 这 $SEGMENT_IDS 个 11 位 ID 全采样率。" +
            "命令 ${SegmentRotation.MASK_CMD}+${SegmentRotation.segmentFilter(lo shr 8)}"
    }

    /** 全总线（`ATCF000`）那一条的说明 —— 规格 §2 点名要写清的一句 */
    const val FULL_BUS_NOTE =
        "⚠️ ATCF000 = 整条总线，不是「第 0 段」。单独的 ATCF000 会放行全部 11 位 ID" +
            "（帧数看着多，是因为它把整条总线的帧都收进来了）。" +
            "要只看 0x000~0x0FF，请用下面那条带掩码的 ATCM700+ATCF000。"

    /**
     * 转向灯那条的说明（**本项目唯一实测确认过 ID 的信号**）。
     *
     * 出处：`docs/CAN-信号库与逆向框架.md` + v1.19.8「转向灯找到了：`0x09A` 的低两位」。
     */
    const val LEFT_TURN_DESC =
        "本车实测确认过：转向灯在 0x09A（低两位），左转 = bit2。" +
            "单 ID 放行最省，采样率最高（实测 0.7 帧/秒 → 20 帧/秒）。命令 ATCRA228"

    /**
     * 预设表：**8 个段 + 3 个常用 + 不过滤 = 12 条**。
     *
     * 顺序是刻意的：**最常用的在最左边**（不过滤 → 转向灯 → 全总线 → 应答 → 8 段）。
     * 横向 chip 一屏放不下，用户第一眼看到的那几个应该是他最可能点的。
     */
    val ALL: List<Preset> = listOf(
        Preset(
            value = "",
            label = "不过滤（整条总线）",
            desc = "不看 ID、全部收下来。能看到最全的 ID 清单，代价是每个 ID 的采样率都很低" +
                "（实测约 77 帧/秒摊到 80 个 ID 上 = 每 ID 每秒 1 帧，闪烁类信号还原不出来）。" +
                "不下发任何过滤命令。"
        ),
        Preset(
            value = "228",
            label = "转向灯 0x09A（本车实测）",
            desc = LEFT_TURN_DESC
        ),
        Preset(
            value = "${SegmentRotation.MASK_CMD}+ATCF000",
            label = "全部 11 位 ID（高三位掩码）",
            desc = "ATCM700 只看 ID 的高三位，所以 0x000~0x7FF 全部放行 —— " +
                "等价于不过滤，但**只看 11 位 ID**（29 位 ID 会被掩码挡掉）。" +
                "命令 ${SegmentRotation.MASK_CMD}+ATCF000"
        ),
        Preset(
            value = "7E8",
            label = "OBD 应答 0x7E8",
            desc = "只看诊断应答（发动机 ECU 的回复）。看 OBD 请求有没有人回话时用它。" +
                "⚠️ 过滤期间正常轮询会收不到别的应答 —— 探测结束会自动清掉过滤器。" +
                "命令 ATCRA7E8"
        ),
    ) + (0 until SegmentRotation.SEGMENT_COUNT).map { segmentPreset(it) }

    /**
     * 按 `value` 找预设（界面用它把"现在用的是哪个"标出来）；找不到返回 `null`。
     *
     * ⚠️ 有**两个**预设的 value 是同一串（"全部 11 位 ID" 与段 0 —— 它们的命令
     * 逐字节相同，见 [describe] 的说明），所以这里返回的是**第一个**。
     * 要全部命中用 [findAll]。
     */
    fun find(value: String): Preset? = ALL.firstOrNull { it.value == value.trim() }

    /**
     * 按 `value` 找出**全部**命中的预设。
     *
     * 为什么会有多个：`ATCM700+ATCF000` 同时是"全部 11 位 ID（高三位掩码）"
     * 和"0x000~0x0FF 段"—— **命令完全一样**（掩码之下的 `ATCF000` 就是第 0 段，
     * 见 [SegmentRotation] 的长注释）。所以说明里两条都要写出来，
     * 否则选中那一条时用户只看到"等价于不过滤"，会以为段 0 不见了。
     */
    fun findAll(value: String): List<Preset> = ALL.filter { it.value == value.trim() }

    /**
     * **过滤器串 → 实际会下发的 AT 命令**。
     *
     * ## 为什么必须与 `CanSniffer.start()` 完全同一套规则
     *
     * 界面要显示"实际下发的 AT 命令"（规格 §2 判据），而真正下发的是
     * `CanSniffer.start()` 里那一段。两处各写一份 = 迟早不一致 ——
     * 那时界面会**自信地显示一条根本没发出去的命令**，比不显示还糟。
     *
     * 规则（与 `CanSniffer.start()` 逐字对应）：
     * - 空 → 空列表（不过滤，一条命令都不发）；
     * - 以 `AT` 开头（不分大小写）→ 按 `+` / `;` 切成多条，原样发；
     * - 其余 → 当成单个 11 位 ID，**转大写**后发 `ATCRA<ID>`。
     */
    fun resolveCommands(filter: String): List<String> {
        val f = filter.trim()
        if (f.isEmpty()) return emptyList()
        return if (f.startsWith("AT", ignoreCase = true)) {
            f.split('+', ';').map { it.trim() }.filter { it.isNotEmpty() }
        } else {
            listOf("ATCRA${f.uppercase()}")
        }
    }

    /**
     * 过滤器框下面那一行**状态说明**（规格 §2 判据："选中后状态行显示实际下发的 AT 命令"）。
     *
     * 三种情形都写清楚"会发生什么"，而不是只甩一串命令：
     * - 空 → 明说"一条过滤命令都不发"，并说清代价（采样率摊薄）；
     * - 命中预设 → 预设说明 + 实际命令；
     * - 手打 → 只报实际命令（**不编**说明：不知道用户想干什么）。
     */
    fun describe(filter: String): String {
        val cmds = resolveCommands(filter)
        val presets = findAll(filter)
        val cmdText = if (cmds.isEmpty()) {
            "不下发过滤命令（整条总线）"
        } else {
            "下发 " + cmds.joinToString(" → ")
        }
        // 命中多个预设时**全列出来**（`ATCM700+ATCF000` 既是全总线又是段 0，
        // 命令逐字节相同）—— 只报第一个会让人以为另一条不见了
        return if (presets.isNotEmpty()) {
            presets.joinToString("\n") { it.desc } + "\n" + cmdText
        } else {
            cmdText
        }
    }
}
