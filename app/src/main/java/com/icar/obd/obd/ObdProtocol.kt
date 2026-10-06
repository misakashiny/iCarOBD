package com.icar.obd.obd

import com.icar.obd.data.PidDefinition

/**
 * ELM327 / OBD-II 协议层：只负责「字节串 → 数据字节」与「数据字节 → 物理量」，
 * 不碰蓝牙、不碰 UI。
 */
object ObdProtocol {

    /** ELM327 返回的错误/状态关键字，出现即视为本条命令无有效数据 */
    private val ERROR_TOKENS = listOf(
        "STOPPED", "NO DATA", "ERROR", "UNABLE TO CONNECT", "BUS ERROR", "CAN ERROR",
        "<DATA ERROR", "NO RESPONSE", "FB ERROR", "BUFFER FULL", "LV RESET",
        "BUS BUSY", "ACT ALERT", "RX ERROR", "DATA ERROR", "UNABLE TO CONNECT"
    )

    private val NOISE_TOKENS = listOf("SEARCHING...", "SEARCHING…", ">", "\r", "\n")

    /** 初始化序列。顺序与内容经过常见 ELM327 兼容性取舍 */
    fun initSequence(protocol: Int): List<String> = buildList {
        add("ATZ")       // 复位
        add("ATE0")      // 关闭回显
        add("ATL0")      // 关闭换行
        add("ATS0")      // 关闭空格（不影响解析，但减少字节）
        add("ATH0")      // 关闭 CAN 头显示（减少数据量，解析仍兼容带头的响应）
        add("ATAT1")     // 自适应定时
        if (protocol > 0) add("ATSP$protocol") else add("ATSP0") // 0=自动
        // ⚠️ **不要在这里加 `ATCAF0`** —— 2026-10-05 的实车日志推翻了这个做法。
        //
        // `ATCAF0` 关掉 CAN 自动格式化后，ELM327 **发出的请求也不再补 PCI 字节**：
        // `01 11` 这种正常请求在 ECU 看来是**畸形帧**，回 NRC 0x13
        // （incorrectMessageLengthOrInvalidFormat）或干脆 NO DATA。
        //
        // 实车证据（IOS-Vlink + ELM327 v2.3，App v1.15.0）：
        // - 带 ATCAF0 的会话：`01 11` → `03 7F 11 13`，**70 秒 100% 失败**，
        //   所有 PID 进 30 秒冷却，总线负载保护把轮询降频到 3.375x
        // - CAF 保持默认（开）的会话：同一个 `01 11` → `41 11 28`，
        //   **立刻拿到真实数值**（水温 92℃ / 电压 14.4V / 负荷 23% / 节气门 15.7%）
        //
        // 复位（ATZ）后 ELM327 的默认值本来就是 CAF1，所以**删掉这行即可**。
        // 也不要改写成 `ATCAF1`：非 CAN 协议（ISO 9141 等）会回 `?`。
        //
        // 解析器**两种格式都兼容**（`matchData` 是扫描「响应模式 + PID」，
        // 带不带 PCI 前缀都能认），所以不需要为了解析而保留 CAF0。
        // 这条由 `ObdProtocolTest.初始化不得关闭 CAN 自动格式化` 守着。
    }.map { "$it\r" }

    /** 常用协议编号（ATSP n） */
    val PROTOCOLS = linkedMapOf(
        0 to "0 自动",
        1 to "1 SAE J1850 PWM",
        2 to "2 SAE J1850 VPW",
        3 to "3 ISO 9141-2",
        4 to "4 ISO 14230 KWP (5 baud)",
        5 to "5 ISO 14230 KWP (fast)",
        6 to "6 ISO 15765 CAN 11bit 500k",
        7 to "7 ISO 15765 CAN 29bit 500k",
        8 to "8 ISO 15765 CAN 11bit 250k",
        9 to "9 ISO 15765 CAN 29bit 250k",
        'A'.code to "A SAE J1939 CAN 29bit 250k"
    )

    fun buildRequest(pid: PidDefinition): String = pid.requestString() + "\r"

    /** 广播头。标准 OBD 查询走它（厂家数据才需要 `AT SH` 到具体模块） */
    const val DEFAULT_HEADER = "7DF"

    /**
     * 目标模块头切换（`AT SH`）—— **需要切时才返回命令**，不需要返回 null。
     *
     * ## 为什么"切回"和"切过去"一样重要
     *
     * `AT SH` 是**粘性**的：设了 `7E0` 之后**后续所有请求**都发往发动机 ECU。
     * 所以"上一条 PID 用了 `760`、这一条是标准 PID"时**必须显式切回广播**，
     * 否则标准 PID 会被发到 ABS 模块 —— 现象是"这条读到别的模块的值"，
     * **从数值上完全看不出**（这正是本项目最怕的那类 bug）。
     *
     * 抽成纯函数是为了**可测**：这里最容易错的就是"切过去发了、切回来忘了发"。
     */
    fun headerSwitch(current: String, wanted: String): String? {
        val c = current.trim().uppercase().ifBlank { DEFAULT_HEADER }
        val w = wanted.trim().uppercase().ifBlank { DEFAULT_HEADER }
        return if (c == w) null else "ATSH$w\r"
    }

    /** 把一行原始响应转成 hex 字节数组（已剔除噪声与错误行） */
    fun hexBytes(raw: String): List<Int> {
        val s = raw.uppercase()
        val out = ArrayList<Int>()
        var i = 0
        while (i + 1 < s.length) {
            val c1 = s[i]; val c2 = s[i + 1]
            if (c1.isHex() && c2.isHex()) {
                out.add(Integer.parseInt("$c1$c2", 16))
                i += 2
            } else if (c1.isWhitespace() || c1 == ':' || c1 == ',' || c1 == '-') {
                i++
            } else {
                // 非 hex 字符，跳过（可能是 "SEARCHING..." 之类，已在 isError 中拦截）
                i++
            }
        }
        return out
    }

    private fun Char.isHex(): Boolean = this in '0'..'9' || this in 'A'..'F'

    fun isError(raw: String): Boolean {
        val s = raw.uppercase()
        if (s.isBlank()) return true
        if ("?" in s) return true
        return ERROR_TOKENS.any { s.contains(it) }
    }

    fun stripNoise(raw: String): String {
        var s = raw
        NOISE_TOKENS.forEach { s = s.replace(it, " ") }
        return s
    }

    /**
     * `ATDPN` 的返回是否表示**协议已锁定**（自动协商已完成）。
     *
     * ## 为什么需要这个判据
     *
     * `ATSP0`（自动）下，**第一次真实请求才会触发协议搜索**。搜索期间适配器回
     * `SEARCHING...`，此时若立刻开始轮询会**打断搜索**并拿到一串 `STOPPED` ——
     * 2026-10-05 的实车日志正是这样（5 次 `STOPPED`）。
     *
     * ## 取值含义
     *
     * | `ATDPN` | 含义 | 锁定？ |
     * |---|---|---|
     * | `A0` | 自动协商，**协议还没定下来** | ❌ |
     * | `A6` | 自动协商，已锁定到协议 6（ISO 15765 CAN 11/500） | ✅ |
     * | `6` | 用户显式指定了协议 6 | ✅ |
     *
     * 抽成纯函数是为了**可测** —— 判据写错的表现是"连接后头几秒全是 STOPPED"，
     * 那种现象在真机上很难归因。
     */
    fun protocolLocked(dpns: String): Boolean {
        val s = dpns.trim().uppercase()
        if (s.isEmpty() || isError(s)) return false
        // `A0` = 自动但协议未定；`0` = 显式选了"自动"，同样等于未定
        return s != "A0" && s != "0"
    }

    /**
     * ISO 14229 的 NRC（否定响应码）说明。**查不到就给十六进制，不要编一个**。
     *
     * 为什么要这张表：ECU 说"不行"和"没人回答"是**完全不同的两件事**，
     * 但在改之前它们都被归成 `无有效响应` —— 2026-10-05 的实车日志里
     * 29 条否定响应全被吞掉，否则 `NRC 0x13` 当场就能定位到"请求畸形"。
     */
    private val NRC_NAMES = mapOf(
        0x10 to "一般拒绝",
        0x11 to "该服务不支持",
        0x12 to "该子功能不支持",
        0x13 to "报文长度或格式错误",
        0x21 to "ECU 忙，稍后重试",
        0x22 to "当前条件不满足",
        0x24 to "请求序列错误",
        0x31 to "请求超出范围",
        0x33 to "安全访问被拒",
        0x35 to "点火开关未打开",
        0x78 to "响应挂起（ECU 还在处理）",
        0x7E to "当前会话不支持该子功能",
        0x7F to "当前会话不支持该服务"
    )

    /**
     * 从响应里识别**否定响应** `7F <服务> <NRC>`，返回可读原因；没有就返回 null。
     *
     * ## 格式
     *
     * ISO 14229 的否定响应就是 3 个字节：`7F <请求的服务> <NRC>` ——
     * **不回声 PID**。所以这里只能报"哪个服务被拒 + 什么原因"。
     *
     * ## 判据（为什么不会误报）
     *
     * 这个方法**只在 `extractData` 已经失败之后才被调用** ——
     * 也就是说"这条响应里没有我们要的肯定响应"。此时串里的 `7F xx yy`
     * 几乎只可能是否定响应。`NO DATA` / `CAN ERROR` 这类串里没有十六进制，
     * 扫不出东西，仍然回落成 `无有效响应`。
     *
     * ⚠️ 实测有个反直觉的例子（2026-10-05）：请求 `01 11`，ECU 却回
     * `7F 11 13` —— **服务字节是 0x11 而不是 0x01**。因为当时开了 `ATCAF0`，
     * 发出的帧没有 PCI 字节，ECU 把第一个数据字节 `01` 当成了长度、
     * 把 `11` 当成了服务。**这个"服务对不上"本身就是畸形请求的指纹**，
     * 所以这里**如实报出 ECU 说的服务号**，不做纠正。
     */
    fun negativeReason(raw: String): String? {
        val bytes = hexBytes(stripNoise(raw))
        for (i in 0..(bytes.size - 3)) {
            if (bytes[i] != 0x7F) continue
            val svc = bytes[i + 1]
            val nrc = bytes[i + 2]
            if (svc == 0 || nrc == 0) continue
            val name = NRC_NAMES[nrc]
            return if (name != null) {
                "ECU 拒绝 | 服务=0x%02X NRC=0x%02X %s".format(svc, nrc, name)
            } else {
                "ECU 拒绝 | 服务=0x%02X NRC=0x%02X（未知 NRC）".format(svc, nrc)
            }
        }
        return null
    }

    /**
     * 从响应中提取数据字节。
     *
     * ## 两条路径
     *
     * 1. **ISO-TP 多帧重组**（v1.5.0 新增）：长响应（>7 字节，如 Mode 09 的 VIN）
     *    在 CAN 上必然分帧。关掉 CAF 后 ELM327 会**逐帧输出**（每帧一行），
     *    这里按行切成帧后重组，再去匹配「响应模式 + PID」。
     * 2. **单帧**：原逻辑。找到 `(mode+0x40)` 紧跟 PID 字节的位置，其后全部视为数据。
     *    既能处理 ATH0（裸响应）也能处理 ATH1（带 CAN 头）。
     *
     * 多帧路径只在**每一行都是干净的十六进制**时才尝试，避免把 `SEARCHING...`
     * 这类噪声行误当成帧（那会算出完全错误的数值）。
     */
    fun extractData(raw: String, mode: Int, pidHex: String, ecuIndex: Int = 0): ByteArray? {
        if (isError(raw)) return null

        val pidNibbles = pidHex.uppercase().replace(Regex("[^0-9A-F]"), "")
        if (pidNibbles.length < 2 || pidNibbles.length % 2 != 0) return null
        val pidList = pidNibbles.chunked(2).map { Integer.parseInt(it, 16) }
        val occ = ecuIndex.coerceAtLeast(0)
        val respMode = (mode + 0x40) and 0xFF
        val lines = raw.split('\r', '\n').map { it.trim() }.filter { it.isNotEmpty() }

        // A) 「帧序号前缀」格式（`0: 49 02 …` / `1: 4A 43 …`）：
        //    这些行属于**同一条**响应，先拍平再匹配
        if (lines.size >= 2 && lines.any { FRAME_INDEX_PREFIX.containsMatchIn(it) }) {
            val bytes = hexBytes(stripNoise(raw))
            if (bytes.isEmpty()) return null
            return matchData(bytes, mode, pidList, occ)
        }

        // B) 多帧 ISO-TP：每行都是干净十六进制。一旦重组成功就**只用重组结果** ——
        //    拿多帧原始数据去走单帧路径只会解出垃圾。
        if (lines.size >= 2 && lines.all { isCleanHexLine(it) }) {
            val frames = lines.map { hexBytes(it) }.filter { it.isNotEmpty() }
            if (frames.size >= 2) {
                reassembleIsoTp(frames)?.let { payload ->
                    return matchData(payload, mode, pidList, occ)
                }
            }
        }

        // C) 多行 = **多个模块各自回复**（多 ECU）。判据是「每一行都以响应模式开头」——
        //    这样才不会把「一条响应被换行拆开」（如 `41 0C` + `1A F8`）误判成两个模块。
        if (lines.size >= 2) {
            val perLine = lines.map { line ->
                val b = hexBytes(line)
                if (b.isEmpty() || b[0] != respMode) null else matchData(b, mode, pidList, 0)
            }
            if (perLine.all { it != null }) return perLine.getOrNull(occ)
        }

        // D) 单行（也是旧行为）
        val bytes = hexBytes(stripNoise(raw))
        if (bytes.isEmpty()) return null
        return matchData(bytes, mode, pidList, occ)
    }

    /** ELM327 的「帧序号前缀」，如 `0: ` / `1: `。用于区分「同一条响应的多帧」与「多 ECU 回复」 */
    private val FRAME_INDEX_PREFIX = Regex("^\\s*[0-9A-Fa-f]\\s*:")

    /** 一行里只有十六进制与空白才算「干净的帧行」 */
    private fun isCleanHexLine(s: String): Boolean {
        val t = s.trim()
        return t.isNotEmpty() && t.all { it.isWhitespace() || it.isHex() }
    }

    /**
     * 在字节序列里定位「响应模式 + PID」，其后全部视为数据。
     *
     * @param occurrence 取第几个匹配（0 起）。同一 PID 多个 ECU 回复时用来选定模块。
     *   要第 N 个却不够 N 个时返回 null —— **不能退回兜底**，那等于把别的模块的值当答案。
     */
    private fun matchData(
        bytes: List<Int>, mode: Int, pidList: List<Int>, occurrence: Int
    ): ByteArray? {
        val respMode = (mode + 0x40) and 0xFF
        var seen = 0
        for (i in bytes.indices) {
            if (bytes[i] != respMode) continue
            if (i + pidList.size >= bytes.size) continue
            var match = true
            for (k in pidList.indices) {
                if (bytes[i + 1 + k] != pidList[k]) { match = false; break }
            }
            if (!match) continue
            if (seen < occurrence) { seen++; continue }
            val start = i + 1 + pidList.size
            if (start >= bytes.size) return ByteArray(0)
            return bytes.subList(start, bytes.size).map { it.toByte() }.toByteArray()
        }

        if (occurrence > 0) return null

        // 兜底：响应模式对但 PID 对不上（部分 ECU 会回 "41 00 ..." 之类的位图响应）
        val idx = bytes.indexOf(respMode)
        if (idx >= 0 && idx + 1 < bytes.size) {
            return bytes.subList(idx + 1, bytes.size).map { it.toByte() }.toByteArray()
        }
        return null
    }

    /**
     * ISO-TP 多帧重组。
     *
     * 帧格式（CAN）：
     * - **首帧 FF**：第 1 字节高 4 位 = `1`，低 4 位 + 第 2 字节 = 总长度（12 位）
     * - **续帧 CF**：第 1 字节高 4 位 = `2`，低 4 位 = 序号（从 1 递增）
     *
     * PCI 的位置取决于是否带 CAN 头（`ATH1` 时前面有 3 或 4 字节），
     * 所以依次试偏移 0 / 3 / 4 —— 三种都失败才认为「不是多帧」。
     *
     * @return 重组后的**净载荷**（含「响应模式 + PID」），失败返回 null
     */
    fun reassembleIsoTp(frames: List<List<Int>>): List<Int>? {
        for (off in intArrayOf(0, 3, 4)) {
            reassembleAt(frames, off)?.let { return it }
        }
        return null
    }

    private fun reassembleAt(frames: List<List<Int>>, off: Int): List<Int>? {
        val first = frames.firstOrNull() ?: return null
        if (first.size <= off + 1) return null
        if (((first[off] shr 4) and 0x0F) != 0x1) return null

        val total = ((first[off] and 0x0F) shl 8) or first[off + 1]
        if (total <= 0) return null

        val out = ArrayList<Int>(total)
        for (i in (off + 2) until first.size) {
            if (out.size >= total) break
            out.add(first[i])
        }

        var expect = 1
        for (k in 1 until frames.size) {
            val f = frames[k]
            if (f.size <= off) break
            if (((f[off] shr 4) and 0x0F) != 0x2) break      // 不是续帧 → 停
            if ((f[off] and 0x0F) != (expect and 0x0F)) break // 序号不连续 → 停
            expect++
            for (i in (off + 1) until f.size) {
                if (out.size >= total) break
                out.add(f[i])
            }
            if (out.size >= total) break
        }

        return if (out.size >= total) out.subList(0, total) else null
    }

    /** 完整解析：响应 → 物理量 */
    fun parse(raw: String, pid: PidDefinition): ParseResult {
        val data = extractData(raw, pid.modeInt(), pid.pid, pid.ecuIndex)
            // 取不到肯定响应时，先问一句"ECU 是不是明确拒绝了？" ——
            // "ECU 说不行"和"没人回答"必须能分开，否则排障只能靠猜
            ?: return ParseResult(
                false, null, ByteArray(0), raw.trim(),
                negativeReason(raw) ?: "无有效响应"
            )
        if (data.isEmpty()) return ParseResult(false, null, data, raw.trim(), "响应无数据字节")
        return try {
            val v = com.icar.obd.data.Formula.eval(pid.formula, data)
            ParseResult(true, v.toFloat(), data, raw.trim(), null)
        } catch (t: Throwable) {
            ParseResult(false, null, data, raw.trim(), "公式错误: ${t.message}")
        }
    }

    data class ParseResult(
        val ok: Boolean,
        val value: Float?,
        val data: ByteArray,
        val raw: String,
        val error: String?
    )

    /** 生成 PID 扫描用的候选列表 */
    fun scanCandidates(mode: String, from: Int, to: Int): List<String> {
        val width = if (mode == "01" || mode == "02" || mode == "09") 2 else 4
        return (from..to).map { it.toString(16).uppercase().padStart(width, '0') }
    }

    /** 会改变 ECU 状态或可能造成风险的模式，扫瞄器默认拒绝 */
    val DANGEROUS_MODES = setOf("02", "03", "04", "05", "06", "07", "08", "10", "11", "12", "13", "14")

    fun isDangerous(mode: String): Boolean = mode.uppercase().trim().trimStart('0').let {
        it in DANGEROUS_MODES || DANGEROUS_MODES.contains(it.padStart(2, '0'))
    }
}
