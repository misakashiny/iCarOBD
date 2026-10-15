package com.icar.obd.data

import com.icar.obd.obd.SegmentRotation
import com.icar.obd.obd.CanReceiveFilter

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
 * 3. **过滤值必须结合掩码解释** —— 这条必须在界面上写清
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
     * 公开出来是为了**测试能逐段点名**：段 0 使用700掩码，全总线使用000掩码，
     * 两条预设不得重名（掩码之下的 `ATCF000` 就是第 0 段），
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
        val note = if (common) "（常见车身域，未在本车实测）" else ""
        return "$range，收这一段的11位ID$note。命令 ${SegmentRotation.MASK_CMD}+${SegmentRotation.segmentFilter(lo shr 8)}"
    }

    /** 全总线（`ATCF000`）那一条的说明 —— 规格 §2 点名要写清的一句 */
    const val FULL_BUS_NOTE =
        "整条总线不是「第 0 段」。ATCM000+ATCF000收全部11位ID；ATCM700+ATCF000只收0x000~0x0FF。"

    /**
     * 转向灯那条的说明（**本项目唯一实测确认过 ID 的信号**）。
     *
     * 出处：`docs/CAN-信号库与逆向框架.md` + v1.19.8「转向灯找到了：`0x09A` 的低两位」。
     */
    const val LEFT_TURN_DESC =
        "历史本车实测记录：0x09A曾用于转向灯排查，采样率曾到20 帧/秒；新车需重新确认。只收0x09A，命令 ATCRA09A。"

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
            desc = "接收整条总线的全部ID，适合首次排查；活跃ID多时采样率会下降。不下发过滤命令。"
        ),
        Preset(
            value = "09A",
            label = "转向灯 0x09A（本车实测）",
            desc = LEFT_TURN_DESC
        ),
        Preset(
            value = "ATCM000+ATCF000",
            label = "全部 11 位 ID",
            desc = "接收全部标准ID，适合先找活跃ID。命令 ATCM000+ATCF000；29位信号请用不过滤或8位ID。"
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
     * ⚠️ 现在预设value唯一；返回与输入匹配的第一条。
     * 要全部命中用 [findAll]。
     */
    fun find(value: String): Preset? = ALL.firstOrNull { it.value == value.trim() }

    /** 以实际输入值找到预设；段0和全部11位已经使用不同掩码。 */
    fun findAll(value: String): List<Preset> = ALL.filter { it.value == value.trim() }

    /** 共用严格接收过滤校验，非法输入返回空命令，describe明确显示原因。 */
    fun resolveCommands(filter: String): List<String> = CanReceiveFilter.parse(filter).commands

    /**
     * 过滤器框下面那一行**状态说明**（规格 §2 判据："选中后状态行显示实际下发的 AT 命令"）。
     *
     * 三种情形都写清楚"会发生什么"，而不是只甩一串命令：
     * - 空 → 明说"一条过滤命令都不发"，并说清代价（采样率摊薄）；
     * - 命中预设 → 预设说明 + 实际命令；
     * - 手打 → 只报实际命令（**不编**说明：不知道用户想干什么）。
     */
    fun describe(filter: String): String {
        val checked = CanReceiveFilter.parse(filter)
        if (checked.error != null) return checked.error
        val cmds = checked.commands
        val presets = findAll(filter)
        val cmdText = if (cmds.isEmpty()) {
            "不下发过滤命令（整条总线）"
        } else {
            "下发 " + cmds.joinToString(" → ")
        }
        // 命中多个预设时**全列出来**（`ATCM700+ATCF000` 既是全总线又是段 0，
        // 命令逐字节相同）—— 只报第一个会让人以为另一条不见了
        return if (presets.isNotEmpty()) {
            presets.joinToString("\n") { it.desc }
        } else {
            cmdText
        }
    }
}
