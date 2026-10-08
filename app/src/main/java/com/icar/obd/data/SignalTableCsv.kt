package com.icar.obd.data

/**
 * 「信号表」CSV 的**唯一**生成/解析实现（规格 `下一步-CAN信号库实现规格.md` §3）。
 *
 * ## 它解决的是什么问题
 *
 * CAN 探测只能给出「哪个 ID 在说话、取值集合是什么」—— **原始材料**。
 * 把它变成「这一位是左转」这种**结论**，需要人来判断；而判断要看着 Excel 做。
 * 这个文件就是那两端的桥：
 *
 * ```
 * 探测 → 导出 25 列模板（每个 ID 一行，预填 ID/DLC/取值集合）
 *      → 人在 Excel 里填「起始位 18、长度 1、Intel、unsigned」
 *      → 导回 app → 物化成 PidDefinition(source=monitor) → 仪表/规则/CSV 照旧能用
 * ```
 *
 * ## 为什么是**纯函数**
 *
 * 解析与校验是"错了也看不出来"的那类逻辑：位序算错 → 解出别的信号的值，
 * 而现象上完全正常。所以全部做成**不依赖 Android 的纯函数**，
 * 由 `SignalTableCsvTest` 逐条钉住（塞进 Activity 就一条都测不了）。
 *
 * ## 为什么**不引入独立的信号库文件**（规格 §1 决策 3）
 *
 * 信号表只在**导入/导出**时出现，导入即物化成 `PidDefinition`；
 * 运行时**只有 `PidDefinition` 一个权威**。本项目因为"两份权威"栽过三次
 * （`designJson` vs `customGauges` / `tpl_left_turn` 改名 / `原类型` 假日志），
 * **电脑上那个 CSV 才是编辑权威**，app 里不留副本。
 *
 * ## ⚠️ 三个必须记住的坑（规格 §7）
 *
 * 1. **判"解到帧外"不能用线性的 `起始位+长度`**。Motorola 是**锯齿位序**：
 *    起始位 18、长度 8 实际占 bit18..11（同一字节内向下）与 bit23..20（下一字节），
 *    线性的 `18+8=26` 会算成"要第 4 字节"而实际只要第 3 字节 —— 实测在宝马参数表上
 *    因此报过 2 条**越界误报**。这里一律用 [Formula.bitSequence] 算**真实位集**。
 * 2. **`最小/最大` 不是编码范围**。实测 48 行的 `最大` ≠ `2^长度-1`
 *    （`Counter_*` 写 14、`Checksum_*` 写 0、1 位的 `AccOn` 写 255）。
 *    **做掩码只能用 `长度(bit)`**；这两列只当显示量程。
 * 3. **CSV 不带 BOM 会让 Windows Excel 按 ANSI 打开 → 中文表头乱码**。
 *    BOM 只在这里定义一次（[BOM] / [withBom]），三处写 CSV 的地方都引用它。
 */
object SignalTableCsv {

    // ---------------------------------------------------------------- 列名

    /**
     * UTF-8 BOM（`EF BB BF`）。
     *
     * **只在这里定义一次**：本项目有三处写 CSV（行车记录 [CsvRecorder]、
     * 探测观察表 `CanFrame`、这里的信号表），各写一遍必然分叉 ——
     * 而 `CsvRecorder` 恰恰就是因为漏了它，让 Excel 里的中文表头一直是乱码。
     */
    const val BOM = "\uFEFF"

    /** 给一段 CSV 正文加上 BOM（写成文件时的**唯一**正确姿势） */
    fun withBom(body: String): String = BOM + body

    /** 去掉开头的 BOM（读回来的文件要剥掉，否则第一列列名匹配不上） */
    fun stripBom(s: String): String = if (s.startsWith(BOM)) s.substring(1) else s

    const val C_ID_HEX = "报文ID(hex)"
    const val C_ID_DEC = "报文ID(dec)"
    const val C_MSG_NAME = "报文名"
    const val C_DLC = "DLC"
    const val C_TX_NODE = "发送节点"
    const val C_SIGNAL = "信号名"
    const val C_START = "起始位"
    const val C_LEN = "长度(bit)"
    const val C_BYTE = "字节"
    const val C_ORDER = "字节序"
    const val C_SIGN = "符号"
    const val C_FACTOR = "因子"
    const val C_OFFSET = "偏移"
    const val C_MIN = "最小"
    const val C_MAX = "最大"
    const val C_UNIT = "单位"
    const val C_RX_NODE = "接收节点"
    const val C_CONFIDENCE = "可信度"
    const val C_EVIDENCE = "证据"
    const val C_INVALID_RAW = "无效原始值"
    const val C_TTL = "显示超时(ms)"
    const val C_PERIOD = "周期(ms)"
    const val C_VALUE_TABLE = "值表"
    const val C_MUX = "多路复用条件"
    const val C_VALUES = "观察到的取值集合"

    /**
     * 25 列，**顺序即导出顺序**。前 17 列沿用宝马参数总表的列名与顺序
     * （便于和网络资料互通），后 8 列是本项目补的。
     *
     * ⚠️ 导入时按**列名**匹配而不是按位置 —— 人在 Excel 里插一列、删一列、
     * 调换顺序都不该让导入错位（错位的后果是"值解错了但看起来正常"）。
     */
    val COLUMNS: List<String> = listOf(
        C_ID_HEX, C_ID_DEC, C_MSG_NAME, C_DLC, C_TX_NODE, C_SIGNAL,
        C_START, C_LEN, C_BYTE, C_ORDER, C_SIGN, C_FACTOR, C_OFFSET,
        C_MIN, C_MAX, C_UNIT, C_RX_NODE, C_CONFIDENCE, C_EVIDENCE,
        C_INVALID_RAW, C_TTL, C_PERIOD, C_VALUE_TABLE, C_MUX, C_VALUES
    )

    /** 列名 → 下标。用查表而不是硬编码下标，改列顺序时不会静默错位 */
    private val IDX: Map<String, Int> = COLUMNS.withIndex().associate { (i, n) -> n to i }

    /** 信号表里"确认"与"候选"两个词，导出与导入共用同一套判据 */
    const val CONF_CONFIRMED = "已确认"
    const val CONF_CANDIDATE = "候选"

    /** 字节序：0 = Intel(小端) / 1 = Motorola(大端)。与 [Formula.bitsAt] 的参数一致 */
    const val ORDER_INTEL = 0
    const val ORDER_MOTOROLA = 1

    /** 符号：0 = unsigned / 1 = signed。与 [Formula.bitsAt] 的参数一致 */
    const val SIGN_UNSIGNED = 0
    const val SIGN_SIGNED = 1

    // ---------------------------------------------------------------- 生成模板

    /**
     * 模板的一行输入：一个**观察到的** CAN ID。
     *
     * 为什么不直接收 `CanFrame.Aggregate`：那个类在 `obd/` 包里，而本文件在 `data/`。
     * `data/` 不能反向依赖 `obd/`（分层红线），所以这里只要三个原始值，
     * 由 ui 层把 `Aggregate` 映射过来。
     */
    data class Observed(val canId: Int, val dlc: Int, val values: List<String>)

    /**
     * 生成「信号表模板」：**每个观察到的 CAN ID 一行**，预填
     * `报文ID(hex)` / `报文ID(dec)` / `DLC` / `观察到的取值集合`，其余留空。
     *
     * 第 25 列是模板的**核心价值**：它把 `turn-signal-09A.md` 里那个人工判据
     * （"操作开关 → 看取值集合变了哪一位"）印在表里，人就不用自己翻 hex。
     *
     * 带 BOM（见 [BOM]）。
     */
    fun template(observed: List<Observed>): String {
        val sb = StringBuilder(BOM)
        sb.append(COLUMNS.joinToString(",") { escape(it) }).append('\n')
        // 按 ID 升序：导出结果稳定，两次探测的模板能直接 diff
        observed.sortedBy { it.canId }.forEach { o ->
            val cells = MutableList(COLUMNS.size) { "" }
            cells[IDX.getValue(C_ID_HEX)] = hexId(o.canId)
            cells[IDX.getValue(C_ID_DEC)] = o.canId.toString()
            if (o.dlc > 0) cells[IDX.getValue(C_DLC)] = o.dlc.toString()
            cells[IDX.getValue(C_VALUES)] = o.values.joinToString(" | ")
            sb.append(cells.joinToString(",") { escape(it) }).append('\n')
        }
        return sb.toString()
    }

    /** `0x09A` 形态：至少 3 位十六进制（29 位 ID 更长，原样输出） */
    fun hexId(canId: Int): String = "0x%03X".format(canId)

    /**
     * 规范化 `报文ID(hex)`：去 `0x` → 大写 → **补足 3 位**。
     *
     * @return 规范化后的串；非法（空 / 非十六进制 / 超过 8 位 / 超 29 位范围）返回 null
     */
    fun normalizeId(raw: String): String? {
        val h = raw.trim().removePrefix("0x").removePrefix("0X").trim()
        if (h.isEmpty() || h.length > 8) return null
        if (!h.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        val up = h.uppercase()
        val padded = if (up.length < 3) up.padStart(3, '0') else up
        // 11 位标准帧最大 0x7FF，29 位扩展帧最大 0x1FFFFFFF
        val v = padded.toLongOrNull(16) ?: return null
        if (v > 0x1FFFFFFFL) return null
        return padded
    }

    // ---------------------------------------------------------------- 解析

    /** 一条校验结论。`hard=true` = 硬错误（整行拒绝），`false` = 软警告（照收但提示） */
    data class Problem(val row: Int, val message: String, val hard: Boolean)

    /**
     * 导入结果。
     *
     * @param pids     通过校验、可以写进 `Store` 的监听型 PID
     * @param problems 全部结论（按行号升序）。**汇总一定要显示给用户** ——
     *                 静默拒绝会让人以为"导进去了但没生效"
     * @param totalRows 数据行数（不含表头），用来算"收了几行/拒了几行"
     */
    data class Result(
        val pids: List<PidDefinition>,
        val problems: List<Problem>,
        val totalRows: Int
    ) {
        val errors: List<Problem> get() = problems.filter { it.hard }
        val warnings: List<Problem> get() = problems.filter { !it.hard }
        val accepted: Int get() = pids.size
    }

    /**
     * 解析并校验一份信号表 CSV。
     *
     * 硬错误（**整行拒绝**，规格 §3.4）：`报文ID(hex)` 非法 / `信号名` 空 /
     * `起始位` 非数或 <0 / `长度` 非数或不在 1..32 / `字节序`·`符号` 不认识 /
     * `因子` 非数或 = 0 / **按字节序算真实位集后超出 `DLC*8`** / `最小 > 最大`。
     *
     * 软警告（照收但提示）：`报文ID(dec)` 与 hex 不一致 / `字节` 列与 `起始位` 不符 /
     * `无效原始值 ≥ 2^长度` / 同一报文内**位重叠** / 带 `多路复用条件` / `单位`·`证据` 空。
     *
     * 重复导入按 `(报文ID, 信号名)` **覆盖**（PID id 由这两者确定性推出），
     * 否则每导一次 PID 列表翻一倍。
     */
    fun parse(text: String): Result {
        val problems = ArrayList<Problem>()
        val rows = splitRows(text)
        if (rows.isEmpty()) {
            return Result(emptyList(), listOf(Problem(0, "文件是空的", true)), 0)
        }

        // ---- 表头：按**列名**定位，容忍增删列与调换顺序 ----
        var headerRow = -1
        for (i in rows.indices) {
            if (rows[i].any { it.trim() == C_ID_HEX }) { headerRow = i; break }
        }
        if (headerRow < 0) {
            return Result(
                emptyList(),
                listOf(
                    Problem(
                        1,
                        "找不到表头：第一行应当包含「$C_ID_HEX」。请用 app 导出的「信号表模板」填，不要自己另建一张表",
                        true
                    )
                ),
                0
            )
        }
        val col = HashMap<String, Int>()
        rows[headerRow].forEachIndexed { i, n -> col.putIfAbsent(n.trim(), i) }

        // ---- 逐行 ----
        val out = LinkedHashMap<String, PidDefinition>()   // key = (CAN ID, 信号名)
        /** 每个 CAN ID 已被占用的**真实位号**，用于位重叠检测 */
        val usedBits = HashMap<Int, MutableSet<Int>>()
        var total = 0

        for (i in headerRow + 1 until rows.size) {
            val row = rows[i]
            if (row.all { it.isBlank() }) continue          // Excel 常见的尾随空行
            val line = i + 1                                // 给人看的 1 起行号
            val get = { name: String -> col[name]?.let { row.getOrNull(it)?.trim() ?: "" } ?: "" }

            val idRaw = get(C_ID_HEX)
            if (idRaw.isBlank()) {
                problems.add(Problem(line, "报文ID(hex) 为空 —— 整行跳过", true))
                continue
            }
            total++

            val errors = ArrayList<String>()
            val warns = ArrayList<String>()

            val header = normalizeId(idRaw)
            if (header == null) {
                problems.add(Problem(line, "报文ID(hex) 非法：「$idRaw」（应形如 0x09A）", true))
                continue
            }
            val canId = header.toInt(16)

            val name = get(C_SIGNAL)
            if (name.isBlank()) errors.add("信号名 为空")

            val start = get(C_START).toIntOrNull()
            if (start == null) {
                errors.add("起始位 不是数字（收到「${get(C_START)}」）")
            } else if (start < 0) {
                // ⚠️ 规格 §3.4 写的是「起始位 ≤0 是硬错误」，但**起始位 0 是合法的**
                // （帧首字节的最低位）。按字面实现会把合法行全部拒掉，
                // 所以这里按**意图**实现：只有负值才算硬错误。见 CHANGELOG 遗留。
                errors.add("起始位 不能为负（收到 $start）")
            }

            val len = get(C_LEN).toIntOrNull()
            if (len == null) {
                errors.add("长度(bit) 不是数字（收到「${get(C_LEN)}」）")
            } else if (len !in 1..32) {
                errors.add("长度(bit) 必须在 1..32（收到 $len）")
            }

            val order = parseOrder(get(C_ORDER))
            if (order == null) {
                errors.add("字节序 不认识：「${get(C_ORDER)}」（应填 Intel(LE) 或 Motorola(BE)）")
            }
            val sign = parseSign(get(C_SIGN))
            if (sign == null) {
                errors.add("符号 不认识：「${get(C_SIGN)}」（应填 unsigned 或 signed）")
            }

            val factorRaw = get(C_FACTOR)
            val factor = if (factorRaw.isBlank()) 1.0 else factorRaw.toDoubleOrNull()
            if (factor == null) {
                errors.add("因子 不是数字（收到「$factorRaw」）")
            } else if (factor == 0.0) {
                errors.add("因子 不能为 0（那样整条信号恒为偏移值，是无意义的）")
            }

            val offsetRaw = get(C_OFFSET)
            val offset = if (offsetRaw.isBlank()) 0.0 else offsetRaw.toDoubleOrNull()
            if (offset == null) errors.add("偏移 不是数字（收到「$offsetRaw」）")

            val minRaw = get(C_MIN)
            val maxRaw = get(C_MAX)
            val minNum = if (minRaw.isBlank()) null else minRaw.toDoubleOrNull()
            val maxNum = if (maxRaw.isBlank()) null else maxRaw.toDoubleOrNull()
            if (minRaw.isNotBlank() && minNum == null) errors.add("最小 不是数字（收到「$minRaw」）")
            if (maxRaw.isNotBlank() && maxNum == null) errors.add("最大 不是数字（收到「$maxRaw」）")

            if (errors.isNotEmpty()) {
                errors.forEach { problems.add(Problem(line, it, true)) }
                continue
            }
            // 到这里 start/len/order/sign/factor/offset 都合法（上面已过滤 null）
            val st = start!!
            val ln = len!!
            val od = order!!
            val sg = sign!!
            val fc = factor!!
            val of = offset!!

            // ⚠️ 空白时用**编码范围**兜底，不用 0..255：这两列是显示量程，
            // 而 0..255 对一条 1 位信号是纯粹的误导（规格 §7 陷阱 2 已说明它们不是编码范围）。
            val minV: Double = minNum
                ?: if (sg == SIGN_SIGNED) -(1L shl (ln - 1)).toDouble() else 0.0
            val maxV: Double = maxNum
                ?: if (sg == SIGN_SIGNED) ((1L shl (ln - 1)) - 1).toDouble()
                else ((1L shl ln) - 1).toDouble()
            if (minV > maxV) {
                problems.add(Problem(line, "最小($minV) 大于 最大($maxV)", true))
                continue
            }

            // ---- 真实位集：判"解到帧外"与"位重叠"都用它（**不能用线性的 起始位+长度**）----
            val bits = Formula.bitSequence(st, ln, od == ORDER_MOTOROLA)
            val maxByte = bits.max() / 8            // 0 起字节号
            val needDlc = maxByte + 1

            val dlc = get(C_DLC).toIntOrNull()?.takeIf { it > 0 }
            if (dlc == null) {
                warns.add("DLC 空或非法 —— 本行**未做帧长校验**，导入后由 minDlc=$needDlc 在运行时兜底")
            } else if (needDlc > dlc) {
                problems.add(
                    Problem(
                        line,
                        "信号解到帧外：起始位=$st 长度=$ln（$od）真实位集最高到第 $needDlc 字节，" +
                            "而 DLC=$dlc —— 这行按字面填错了（注意 Motorola 是锯齿位序，不能按 起始位+长度 算）",
                        true
                    )
                )
                continue
            }

            // ---- 软警告 ----
            val decRaw = get(C_ID_DEC)
            if (decRaw.isNotBlank()) {
                val dec = decRaw.toIntOrNull()
                if (dec == null || dec != canId) {
                    warns.add("报文ID(dec)=「$decRaw」与 hex=$header（= $canId）不一致")
                }
            }
            val byteRaw = get(C_BYTE)
            if (byteRaw.isNotBlank() && !byteRaw.equals("B${st / 8}", ignoreCase = true)) {
                warns.add("字节=「$byteRaw」与 起始位=$st 不符（起始位 $st 落在 B${st / 8}，0 起）")
            }
            val ivRaw = get(C_INVALID_RAW)
            val invalidRaw = if (ivRaw.isBlank()) null else ivRaw.toIntOrNull()
            if (ivRaw.isNotBlank() && invalidRaw == null) {
                warns.add("无效原始值「$ivRaw」不是整数 —— 已忽略（不做无效值判断）")
            }
            if (invalidRaw != null && ln < 63 && invalidRaw.toLong() >= (1L shl ln)) {
                warns.add("无效原始值 $invalidRaw ≥ 2^$ln（超出 $ln 位能表示的范围）—— 多半填错了")
            }
            val mux = get(C_MUX)
            if (mux.isNotBlank()) {
                warns.add("带 多路复用条件「$mux」—— 本版**不判断选择位**，这条值可能是无效的")
            }
            if (get(C_UNIT).isBlank()) warns.add("单位 为空")
            if (get(C_EVIDENCE).isBlank()) warns.add("证据 为空")

            val confRaw = get(C_CONFIDENCE)
            val confirmed = when {
                confRaw.isBlank() -> {
                    warns.add("可信度 为空 —— 按「$CONF_CANDIDATE」处理（不启用，免得没验证的值显示在仪表上）")
                    false
                }
                confRaw == CONF_CONFIRMED || confRaw == "确认" -> true
                confRaw == CONF_CANDIDATE || confRaw == "候选值" -> false
                else -> {
                    warns.add("可信度 不认识：「$confRaw」—— 按「$CONF_CANDIDATE」处理")
                    false
                }
            }

            // 位重叠：同一报文内两条信号占了同一位 → 值一定有一方是错的
            val used = usedBits.getOrPut(canId) { HashSet() }
            val clash = bits.filter { !used.add(it) }
            if (clash.isNotEmpty()) {
                warns.add(
                    "与同一报文($header)的其它信号**位重叠**：" +
                        clash.joinToString(" ") { "b${it / 8}.${it % 8}" }
                )
            }

            val ttlRaw = get(C_TTL)
            // 规格 §3.1 列 21：可选，**默认 2000**。
            // 注意 `PidDefinition.ttlMs` 的字段默认是 0（不判断）—— 那是为了旧配置零迁移；
            // 信号表是新导入的广播信号，"停发 2 秒还挂着最后一个值"正是要被消掉的那种骗人。
            val ttl = if (ttlRaw.isBlank()) 2000 else ttlRaw.toIntOrNull()
            if (ttlRaw.isNotBlank() && ttl == null) warns.add("显示超时「$ttlRaw」不是整数 —— 按默认 2000ms")

            warns.forEach { problems.add(Problem(line, it, false)) }

            val pid = PidDefinition(
                id = pidId(header, name),
                name = name,
                protocol = "CAN",
                mode = "MON",
                pid = header,
                formula = formulaOf(st, ln, od, sg, fc, of),
                unit = get(C_UNIT),
                minVal = minV.toFloat(),
                maxVal = maxV.toFloat(),
                enabled = confirmed,
                builtIn = false,
                header = header,
                source = "monitor",
                invalidRaw = invalidRaw,
                minDlc = needDlc,
                ttlMs = ttl ?: 2000,
                group = get(C_MSG_NAME).ifBlank { "监听型(信号表)" },
                note = noteOf(
                    msgName = get(C_MSG_NAME),
                    dlc = dlc,
                    period = get(C_PERIOD),
                    txNode = get(C_TX_NODE),
                    rxNode = get(C_RX_NODE),
                    valueTable = get(C_VALUE_TABLE),
                    mux = mux,
                    evidence = get(C_EVIDENCE)
                )
            )
            // 按 (报文ID, 信号名) 覆盖：同名的后一行赢（文件里重复时以最后一行为准）
            out[pid.id] = pid
        }

        return Result(out.values.toList(), problems, total)
    }

    /** 由 (CAN ID, 信号名) **确定性**推出 PID id —— 于是重复导入是覆盖而不是翻倍 */
    fun pidId(headerHex: String, signalName: String): String =
        "mon_" + headerHex + "_" + signalName.trim().replace(Regex("[\\s,;|/\\\\]+"), "_")

    /**
     * 生成公式（规格 §3.5）。
     *
     * 形态固定：`bitsAt(起始位,长度,字节序,符号)`，因子/偏移非 1/0 时接 `* f` / `± o`。
     *
     * ⚠️ **必须是这个形态**：[Formula.rawBits] 靠它取"原始值"来比 `invalidRaw`
     * （原始值 ≠ 物理值：`bitsAt(…)*0.25-48` 的原始值是位段本身，不是乘完的结果）。
     */
    fun formulaOf(start: Int, len: Int, order: Int, sign: Int, factor: Double, offset: Double): String {
        val sb = StringBuilder("bitsAt(")
            .append(start).append(',').append(len).append(',')
            .append(order).append(',').append(sign).append(')')
        if (factor != 1.0) sb.append(" * ").append(num(factor))
        if (offset != 0.0) sb.append(if (offset < 0) " - " else " + ").append(num(Math.abs(offset)))
        return sb.toString()
    }

    /** 整数值不带 `.0`（`0.25` 保持 `0.25`），让公式短且可读 */
    private fun num(d: Double): String =
        if (!d.isNaN() && !d.isInfinite() && d == Math.floor(d) && Math.abs(d) < 1e15) {
            d.toLong().toString()
        } else {
            d.toString()
        }

    /**
     * `note` 的固定格式（规格 §3.3）：只记录、**不参与运行时**的列都塞在这里。
     *
     * ```
     * 信号表|报文名=TurnSignals|DLC=2|周期=100|发送=FRMFA|接收=XXX|值表=0:关,1:开|复用=…|证据=…
     * ```
     *
     * - 前缀 `信号表|` 标记"这条来自信号表"，将来要再导出时能认出来；
     * - **只写非空项**，免得一堆 `周期=` 噪音；
     * - `note` 本来就是自由文本，解析失败不报错。
     */
    fun noteOf(
        msgName: String,
        dlc: Int?,
        period: String,
        txNode: String,
        rxNode: String,
        valueTable: String,
        mux: String,
        evidence: String
    ): String {
        val parts = ArrayList<String>(8)
        if (msgName.isNotBlank()) parts.add("报文名=$msgName")
        if (dlc != null) parts.add("DLC=$dlc")
        if (period.isNotBlank()) parts.add("周期=$period")
        if (txNode.isNotBlank()) parts.add("发送=$txNode")
        if (rxNode.isNotBlank()) parts.add("接收=$rxNode")
        if (valueTable.isNotBlank()) parts.add("值表=$valueTable")
        if (mux.isNotBlank()) parts.add("复用=$mux")
        if (evidence.isNotBlank()) parts.add("证据=$evidence")
        return "信号表|" + parts.joinToString("|")
    }

    /** 字节序：认得 `Intel(LE)` / `Intel` / `LE` / `0`，以及 Motorola 的各种写法 */
    fun parseOrder(s: String): Int? {
        val t = s.trim().lowercase()
        return when {
            t.isEmpty() -> null
            t.startsWith("intel") || t == "le" || t == "0" || t.contains("小端") -> ORDER_INTEL
            t.startsWith("motorola") || t == "be" || t == "1" || t.contains("大端") -> ORDER_MOTOROLA
            else -> null
        }
    }

    /** 符号：认得 `unsigned` / `无符号` / `0`，以及 signed 的各种写法 */
    fun parseSign(s: String): Int? {
        val t = s.trim().lowercase()
        return when {
            t.isEmpty() -> null
            t.startsWith("unsigned") || t == "无符号" || t == "u" || t == "0" -> SIGN_UNSIGNED
            t.startsWith("signed") || t == "有符号" || t == "s" || t == "1" -> SIGN_SIGNED
            else -> null
        }
    }

    // ---------------------------------------------------------------- CSV 底层

    /** RFC4180 转义：含逗号/引号/换行的字段要整体加引号，内部引号翻倍 */
    fun escape(s: String): String =
        if (s.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) {
            "\"" + s.replace("\"", "\"\"") + "\""
        } else {
            s
        }

    /**
     * 拆 CSV 成行列。
     *
     * 自己写而不是 `split(",")`：字段里可能有引号包裹的逗号（第 23 列「值表」
     * 就是 `0:关,1:开` 这种），一刀切会**静默错位** —— 那正是"值解错了但看起来正常"。
     *
     * 引号内的换行与回车原样保留；引号外的 `\r`（CRLF 的 CR）丢掉。
     */
    fun splitRows(text: String): List<List<String>> {
        val s = stripBom(text)
        val rows = ArrayList<List<String>>()
        var row = ArrayList<String>()
        val sb = StringBuilder()
        var inQuotes = false
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                inQuotes -> when {
                    c == '"' && i + 1 < s.length && s[i + 1] == '"' -> { sb.append('"'); i++ }
                    c == '"' -> inQuotes = false
                    else -> sb.append(c)
                }
                c == '"' -> inQuotes = true
                c == ',' -> { row.add(sb.toString()); sb.setLength(0) }
                c == '\n' -> {
                    row.add(sb.toString()); sb.setLength(0)
                    rows.add(row); row = ArrayList()
                }
                c == '\r' -> { /* CRLF 的 CR：丢掉 */ }
                else -> sb.append(c)
            }
            i++
        }
        if (sb.isNotEmpty() || row.isNotEmpty()) {
            row.add(sb.toString())
            rows.add(row)
        }
        return rows
    }
}
