package com.icar.obd.data

/**
 * PID 编辑器的「表单 → [PidDefinition]」纯逻辑（v1.20.8，S3）。
 *
 * ## 它解决的是什么问题
 *
 * v1.20.7（S1/S2）之后，一条监听型信号在数据模型上是齐的（`source` / `header` /
 * `invalidRaw` / `minDlc` / `ttlMs`），但**界面上一个都填不了** ——
 * 全 app 只有 2 条内置监听 PID，用户连第三条都造不出来，只能导出信号表模板、
 * 在 Excel 里填、再导回来。这个文件把"表单那一边"补齐。
 *
 * ## 为什么是纯函数、为什么放在 `data/`
 *
 * 三条理由，每一条都是本项目踩过的坑：
 *
 * 1. **`Activity` 里的校验在 JVM 单测里一条都测不到** —— 而这里要判的恰恰是
 *    "填错了但看起来正常"的那类东西（CAN ID 写错 → 帧永远不命中；
 *    帧长写小 → 短帧解出垃圾）。所以判定全部搬到不依赖 Android 的纯函数里，
 *    由 `PidDraftTest` 逐条钉住。这与 `PidModels.dlcTooShort` /
 *    `FrameRateGate` 被抽出来的理由是同一个。
 * 2. **`data/` 不能依赖 `ui/`，反过来可以** —— 于是放在这里，
 *    `PidEditorActivity` 直接调，不需要在 ui 层再抄一份。
 * 3. **校验只能有一份实现**：`save()` 与将来的任何入口都走 [build]，
 *    不存在"某个按钮忘了校验"。
 *
 * ## ⚠️ 两个字段的语义陷阱
 *
 * - [PidDefinition.header] 是**同一个字段、两种含义**：`source=poll` 时它是
 *   `AT SH <header>` 的**目标模块头**（`7E0`/`720`，留空 = 广播 `7DF`）；
 *   `source=monitor` 时它是**广播帧的 CAN ID**（`09A`）。界面上要按 source 换标签，
 *   否则用户会把 CAN ID 填进"模块头"里，然后得到一个永远不命中的监听条目。
 * - 监听型的 `mode`/`pid` **不是用户输入**：`mode` 固定 `MON`（`FrameMonitor`
 *   与 `SignalTableCsv` 都这么标），`pid` = `header`（`BuiltInPids` 里那两条
 *   内置转向灯也是这个形状）。所以界面上这两个输入框对监听型是**藏起来**的 ——
 *   让人填一个会被覆盖的值，比不显示它更糟。
 */
object PidDraft {

    // ---------------------------------------------------------------- 数据来源

    /** 主动请求（默认，= 旧行为） */
    const val SOURCE_POLL = "poll"

    /** 从广播帧里取值，由 `FrameMonitor` 常驻监听驱动 */
    const val SOURCE_MONITOR = "monitor"

    /** 监听型条目的 `mode` 标记（与 [BuiltInPids] / [SignalTableCsv] 一致） */
    const val MODE_MONITOR = "MON"

    /** 派生通道的 `mode` 标记（`BuiltInPids.calc` 用）—— 它没有 PID 号，要放行 */
    const val MODE_CALC = "CALC"

    /**
     * 下拉框的**值**。界面只拿它建 adapter，映射关系由 [sourceOf] / [sourceIndexOf] 负责 ——
     * 那两处是唯一会把"第几项"翻译成 `"poll"/"monitor"` 的地方。
     *
     * 为什么不直接 `listOf("poll","monitor")` 给 ArrayAdapter：那样下拉框里显示的是
     * 英文小写标识符，而用户看到的是"我要造一条监听型信号"这件事。
     */
    val SOURCE_VALUES = listOf(SOURCE_POLL, SOURCE_MONITOR)

    /** 下拉框的**显示文字**，下标与 [SOURCE_VALUES] 一一对应 */
    val SOURCE_LABELS = listOf("主动请求（轮询）", "监听广播帧（常驻监听）")

    /** 大小写不敏感：存量配置里可能写成 `"MONITOR"` */
    fun isMonitor(source: String): Boolean = source.trim().equals(SOURCE_MONITOR, true)

    /** `"monitor"` → 1；认不出来 → 0（主动请求，= 旧行为） */
    fun sourceIndexOf(source: String): Int =
        SOURCE_VALUES.indexOfFirst { it.equals(source.trim(), true) }.coerceAtLeast(0)

    /** 越界 → [SOURCE_POLL]（= 旧行为），绝不抛 */
    fun sourceOf(index: Int): String = SOURCE_VALUES.getOrElse(index) { SOURCE_POLL }

    // ---------------------------------------------------------------- 表单与结论

    /**
     * 表单里的**原始文本**。
     *
     * 刻意全部用 `String`（而不是 `Float`/`Int`）：用户正在打字时 `""`、`"-"`、
     * `"1.2.3"` 都是中间状态，先把"能不能解析"和"数值合不合法"分开判，
     * 才能给出"哪个框填错了"这种**指得出地方**的提示。
     */
    data class Fields(
        val name: String = "",
        val protocol: String = "CAN",
        val source: String = SOURCE_POLL,
        /** `poll` = 目标模块头（`AT SH`）；`monitor` = CAN ID。见类注释的陷阱 */
        val header: String = "",
        val mode: String = "22",
        val pid: String = "",
        /** 实际请求帧（可覆盖自动生成的那个）。监听型不用它 */
        val request: String = "",
        val formula: String = "A",
        val unit: String = "",
        val minVal: String = "",
        val maxVal: String = "",
        val warnLow: String = "",
        val warnHigh: String = "",
        val group: String = "自定义",
        val intervalMs: String = "0",
        val priority: Int = PidDefinition.PRIORITY_NORMAL,
        val ecuIndex: String = "0",
        val invalidRaw: String = "",
        val minDlc: String = "",
        val ttlMs: String = "",
        val note: String = "",
        val enabled: Boolean = true
    )

    /** 出问题的字段。界面用它决定要不要把某个输入框标红（当前只用于提示文案） */
    enum class Field {
        NAME, HEADER, MODE, PID, FORMULA, RANGE, INTERVAL, ECU, INVALID_RAW, MIN_DLC, TTL, OTHER
    }

    /**
     * 一条校验结论。
     *
     * @param hard `true` = **硬错误**（拒绝保存）；`false` = 软警告（照存，但要说出来）
     */
    data class Issue(val field: Field, val message: String, val hard: Boolean = true)

    /**
     * @param pid    `null` = 有硬错误，不能保存
     * @param issues 全部结论，硬错误在前
     */
    data class Result(val pid: PidDefinition?, val issues: List<Issue>) {
        val errors: List<Issue> get() = issues.filter { it.hard }
        val warnings: List<Issue> get() = issues.filter { !it.hard }
        val ok: Boolean get() = pid != null
    }

    // ---------------------------------------------------------------- 载入

    /**
     * 已有 PID → 表单。**与 [build] 严格往返**（同一条 PID 走一圈回来字段不变）。
     *
     * ⚠️ `ttlMs` 这里**原样写出来**（含 `"0"`），而不是"0 就当空"：
     * 0 在 JSON 里与"没这个字段"不可区分（[PidDefinition.toJson] 默认值不写出去），
     * 若把它当成空，编辑一次存量条目就会把它悄悄改成默认 2000 ——
     * 那是**改用户数据**，不是补默认值。空值只出现在"新建"那条路上。
     */
    fun of(p: PidDefinition): Fields = Fields(
        name = p.name,
        protocol = p.protocol,
        source = if (isMonitor(p.source)) SOURCE_MONITOR else SOURCE_POLL,
        // 监听型：header 空时退到 pid（内置转向灯两者相同；信号表导入的也相同）
        header = p.header.ifBlank { if (isMonitor(p.source)) p.pid else "" },
        mode = p.mode,
        pid = p.pid,
        request = p.customRequest ?: p.requestString(),
        formula = p.formula,
        unit = p.unit,
        minVal = fmtNum(p.minVal),
        maxVal = fmtNum(p.maxVal),
        warnLow = p.warnLow?.let { fmtNum(it) } ?: "",
        warnHigh = p.warnHigh?.let { fmtNum(it) } ?: "",
        group = p.group,
        intervalMs = p.intervalMs.toString(),
        priority = p.priority.coerceIn(PidDefinition.PRIORITY_HIGH, PidDefinition.PRIORITY_LOW),
        ecuIndex = p.ecuIndex.toString(),
        invalidRaw = p.invalidRaw?.toString() ?: "",
        minDlc = p.minDlc.toString(),
        ttlMs = p.ttlMs.toString(),
        note = p.note,
        enabled = p.enabled
    )

    // ---------------------------------------------------------------- 构建 + 校验

    /**
     * 表单 → [PidDefinition]，并给出全部校验结论。
     *
     * @param id      条目 id（编辑时沿用原 id；新建时由调用方给 UUID）
     * @param builtIn 内置条目标记（编辑器对内置条目走"另存为副本"那条路）
     */
    fun build(f: Fields, id: String, builtIn: Boolean = false): Result {
        val issues = ArrayList<Issue>()
        val monitor = isMonitor(f.source)

        // ---- 名称 ----
        val name = f.name.trim()
        if (name.isEmpty()) issues.add(Issue(Field.NAME, "名称 不能为空"))

        // ---- 公式 ----
        // 空 → "A"：这是**既有行为**（老版本 collect() 就是这么兜的），不改它，
        // 否则存量条目的公式会在保存时被换成别的东西。
        val formula = f.formula.trim().ifBlank { "A" }
        Formula.check(formula)?.let { issues.add(Issue(Field.FORMULA, "公式语法错误：$it")) }

        // ---- header：两种含义，两套规则（见类注释的陷阱）----
        var header = f.header.trim()
        if (monitor) {
            if (header.isEmpty()) {
                issues.add(Issue(Field.HEADER, "监听型必须填 CAN ID（如 09A）—— 没有它这条永远不命中"))
            } else {
                val n = SignalTableCsv.normalizeId(header)
                if (n == null) {
                    issues.add(Issue(Field.HEADER, "CAN ID 非法：「$header」（十六进制，如 09A / 2C7）"))
                } else {
                    header = n
                }
            }
        } else if (header.isNotEmpty()) {
            val n = SignalTableCsv.normalizeId(header)
            if (n == null) {
                issues.add(Issue(Field.HEADER, "模块头 非法：「$header」（十六进制，如 7E0；留空 = 广播 7DF）"))
            } else {
                header = n
            }
        }

        // ---- mode / pid ----
        val mode: String
        val pid: String
        if (monitor) {
            // 监听型不接受用户输入：mode 固定 MON、pid = CAN ID。
            // 与 `BuiltInPids` 的两条转向灯、`SignalTableCsv` 导入的条目形状完全一致。
            mode = MODE_MONITOR
            pid = header
        } else {
            mode = f.mode.trim().ifBlank { "01" }
            val modeHex = mode.toIntOrNull(16) != null
            if (!modeHex && !mode.equals(MODE_CALC, true)) {
                issues.add(Issue(Field.MODE, "Mode 必须是十六进制（收到「$mode」）"))
            }
            pid = f.pid.trim()
            val compact = pid.replace(" ", "")
            val derived = mode.equals(MODE_CALC, true)
            if (compact.isEmpty()) {
                issues.add(Issue(Field.PID, "主动请求型必须填 PID"))
            } else if (compact.all { isHexDigit(it) }) {
                // 十六进制才检查位数：`1A4` 这种**奇数 nibble** 会被 ELM327 当成畸形帧
                // （v1.18.6 踩过：用户在 Mode 里填 `1` → 发出 `1 A4` → 全部 NO DATA）
                if (compact.length % 2 != 0) {
                    issues.add(Issue(Field.PID, "PID 的十六进制位数必须是偶数（收到「$pid」）"))
                }
            } else if (!derived) {
                // 派生通道（mode=CALC）的 pid 是 key（`calc_l100`），本来就非十六进制 —— 放行。
                // 其它情况只**警告**：这里放行是为了不破坏"派生通道另存副本"这条既有路径。
                issues.add(
                    Issue(
                        Field.PID,
                        "PID 含非十六进制字符（「$pid」）—— 只有派生通道（mode=CALC）才这样，" +
                            "主动请求会发不出去",
                        hard = false
                    )
                )
            }
        }

        // ---- 数值字段：**解析失败要说出来**，不再 `?: 0f` 静默兜底 ----
        // 老写法 `etMin.text.toFloatOrNull() ?: 0f` 会让用户把 `-40` 打成 `-4O`（字母 O）
        // 之后**看到 0 而不是报错** —— 那正是"被错值骗"的入口。
        val minV = numOr(f.minVal, 0f, "最小值", Field.RANGE, issues)
        val maxV = numOr(f.maxVal, 100f, "最大值", Field.RANGE, issues)
        if (minV != null && maxV != null && minV > maxV) {
            issues.add(Issue(Field.RANGE, "最小值(${fmtNum(minV)}) 大于 最大值(${fmtNum(maxV)})"))
        }
        val warnLow = numOrNull(f.warnLow, "报警下限", Field.RANGE, issues)
        val warnHigh = numOrNull(f.warnHigh, "报警上限", Field.RANGE, issues)

        val interval = intOr(f.intervalMs, 0, "轮询间隔", Field.INTERVAL, issues)
        if (interval != null && interval < 0) {
            issues.add(Issue(Field.INTERVAL, "轮询间隔 不能为负（收到 $interval）"))
        }
        val ecu = intOr(f.ecuIndex, 0, "多 ECU 序号", Field.ECU, issues)
        if (ecu != null && ecu < 0) {
            issues.add(Issue(Field.ECU, "多 ECU 序号 不能为负（收到 $ecu）"))
        }

        // ---- 无效原始值 ----
        val ivRaw = f.invalidRaw.trim()
        var invalidRaw: Int? = null
        if (ivRaw.isNotEmpty()) {
            val v = ivRaw.toIntOrNull()
            when {
                v == null -> issues.add(Issue(Field.INVALID_RAW, "无效原始值 不是整数（收到「$ivRaw」）"))
                v < 0 -> issues.add(Issue(Field.INVALID_RAW, "无效原始值 不能为负（收到 $v）"))
                else -> invalidRaw = v
            }
        }

        // ---- 最小帧长 ----
        val mdRaw = f.minDlc.trim()
        var minDlc = 0
        if (mdRaw.isNotEmpty()) {
            val v = mdRaw.toIntOrNull()
            when {
                v == null -> issues.add(Issue(Field.MIN_DLC, "最小帧长 不是整数（收到「$mdRaw」）"))
                v < 0 -> issues.add(Issue(Field.MIN_DLC, "最小帧长 不能为负（收到 $v）"))
                v > 64 -> issues.add(Issue(Field.MIN_DLC, "最小帧长 最大 64 字节（收到 $v）"))
                else -> minDlc = v
            }
        }

        // ---- 显示超时 ----
        val ttlRaw = f.ttlMs.trim()
        var ttlMs = 0
        if (ttlRaw.isEmpty()) {
            if (monitor) {
                // 空 = 用**唯一权威**的那个默认值（信号表导入也用它），并把这件事说出来
                ttlMs = PidDefinition.DEFAULT_MONITOR_TTL_MS
                issues.add(
                    Issue(
                        Field.TTL,
                        "显示超时 为空 → 按默认 ${ttlMs}ms：广播停发这么久之后值自动变 --" +
                            "（填 0 = 不判断，那会让仪表一直挂着最后一个数字）",
                        hard = false
                    )
                )
            }
        } else {
            val v = ttlRaw.toIntOrNull()
            when {
                v == null -> issues.add(Issue(Field.TTL, "显示超时 不是整数（收到「$ttlRaw」）"))
                v < 0 -> issues.add(Issue(Field.TTL, "显示超时 不能为负（收到 $v）"))
                else -> ttlMs = v
            }
        }

        // ---- 位段相关的软警告（只在能算出真实位集时给）----
        val args = Formula.bitsAtArgs(formula)
        if (args != null) {
            val start = args[0]
            val len = args[1]
            val need = needBytes(start, len, args[2] != 0)
            if (invalidRaw != null && len < 63 && invalidRaw.toLong() >= (1L shl len)) {
                issues.add(
                    Issue(
                        Field.INVALID_RAW,
                        "无效原始值 $invalidRaw ≥ 2^$len（超出 $len 位能表示的范围）—— 多半填错了",
                        hard = false
                    )
                )
            }
            if (need != null && monitor) {
                if (minDlc == 0) {
                    // minDlc=0 = 运行时不查帧长。后果不是"少一个值"，而是**短帧静默不出值**：
                    // 公式解到帧外会抛异常、`FrameMonitor` 吞掉它，日志里连"DLC不足"都没有。
                    // 填上它，日志才会说清"为什么这条没值"。
                    val why = if (mdRaw.isEmpty()) "最小帧长 为空" else "最小帧长 填了 0"
                    issues.add(
                        Issue(
                            Field.MIN_DLC,
                            "$why → 运行时不查帧长，短帧会**静默不出值**（日志里也看不出原因）；" +
                                "按公式的真实位集建议填 $need",
                            hard = false
                        )
                    )
                } else if (minDlc < need) {
                    issues.add(
                        Issue(
                            Field.MIN_DLC,
                            "最小帧长 $minDlc 比公式需要的 $need 还小 —— 更短的帧仍会解到帧外",
                            hard = false
                        )
                    )
                }
            }
        }

        // ---- 组装 ----
        // 有硬错误就不给 pid（调用方不可能"不小心存下去"）
        if (issues.any { it.hard }) return Result(null, issues)

        val request = f.request.trim()
        val out = PidDefinition(
            id = id,
            name = name,
            protocol = f.protocol.trim().ifBlank { "CAN" },
            mode = mode,
            pid = pid,
            formula = formula,
            unit = f.unit.trim(),
            minVal = minV ?: 0f,
            maxVal = maxV ?: 100f,
            warnLow = warnLow,
            warnHigh = warnHigh,
            enabled = f.enabled,
            builtIn = builtIn,
            intervalMs = interval ?: 0,
            ecuIndex = ecu ?: 0,
            header = header,
            source = if (monitor) SOURCE_MONITOR else SOURCE_POLL,
            invalidRaw = invalidRaw,
            minDlc = minDlc,
            ttlMs = ttlMs,
            priority = f.priority.coerceIn(PidDefinition.PRIORITY_HIGH, PidDefinition.PRIORITY_LOW),
            // 监听型没有"请求帧"这回事：硬塞一个 `MON 09A` 进去，
            // 将来谁读到它都会以为这条能主动请求。
            customRequest = if (monitor) null
            else request.ifBlank { PidDefinition.normalize("$mode $pid") },
            group = f.group.trim().ifBlank { "自定义" },
            note = f.note.trim()
        )
        return Result(out, issues)
    }

    /**
     * 按 `bitsAt(...)` 的**真实位集**推算"至少要几个字节"。
     *
     * ⚠️ **不能用线性的 `起始位/8 + 长度/8`**：Motorola 是锯齿位序
     * （规格 §7 陷阱 1，实测在宝马参数表上因此误报过 2 条"越界"）。
     * 这里直接复用 [Formula.bitSequence] —— 与 `SignalTableCsv` 判越界、
     * 与运行时解码用的是**同一份**位序逻辑。
     *
     * @return 需要的字节数；公式不是 `bitsAt` 形态、或参数非法时返回 `null`
     */
    fun suggestedMinDlc(formula: String): Int? {
        val a = Formula.bitsAtArgs(formula) ?: return null
        return needBytes(a[0], a[1], a[2] != 0)
    }

    private fun needBytes(start: Int, len: Int, motorola: Boolean): Int? = try {
        val seq = Formula.bitSequence(start, len, motorola)
        seq.max() / 8 + 1
    } catch (t: Throwable) {
        null
    }

    // ---------------------------------------------------------------- 小工具

    /** 整数不带 `.0`（`0.25` 保持 `0.25`）—— 与 `SignalTableCsv` 的写法保持一致 */
    fun fmtNum(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else f.toString()

    private fun isHexDigit(c: Char): Boolean =
        c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

    /**
     * 解析一个可选浮点。
     *
     * @return 空串 → `null`（调用方用默认值）；**填了但不是数字 → `null` 且记一条硬错误**
     */
    private fun numOrNull(raw: String, label: String, field: Field, out: MutableList<Issue>): Float? {
        val t = raw.trim()
        if (t.isEmpty()) return null
        val v = t.toFloatOrNull()
        if (v == null) {
            out.add(Issue(field, "$label 不是数字（收到「$t」）"))
            return null
        }
        return v
    }

    /** 空串 → [def]；填了但非法 → `null`（硬错误已经记下） */
    private fun numOr(raw: String, def: Float, label: String, field: Field, out: MutableList<Issue>): Float? =
        numOrNull(raw, label, field, out) ?: if (raw.isBlank()) def else null

    private fun intOr(raw: String, def: Int, label: String, field: Field, out: MutableList<Issue>): Int? {
        val t = raw.trim()
        if (t.isEmpty()) return def
        val v = t.toIntOrNull()
        if (v == null) {
            out.add(Issue(field, "$label 不是整数（收到「$t」）"))
            return null
        }
        return v
    }
}
