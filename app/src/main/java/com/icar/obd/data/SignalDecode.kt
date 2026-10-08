package com.icar.obd.data

/**
 * 「这一帧解出来是什么」—— 把探测页的 hex 变成人看得懂的话（v1.20.8，S4）。
 *
 * ## 为什么需要它
 *
 * CAN 探测页原来只显示 `数据: 00 00 04 00 88 00 03 00   变化 13 次`。
 * 用户的目标是「**看得懂**」，而"这一位在跳"离"这是左转向灯"还差一次人工换算：
 * 得自己知道 `0x09A` 的 bit2、还得会读 Intel 位序。
 *
 * 这一层把它补上：`0x09A → 左转向灯 1`、`0x2C7 → 油温 88℃（候选）`。
 *
 * ## 为什么便宜（规格 §2-S4 原话：**不需要新数据模型**）
 *
 * 解帧要的全部东西，**已有的监听型 PID 里都有**：`header` 是 CAN ID、
 * `formula` 是解码式（信号表导入的条目一律是 `bitsAt(...)` 形态）。
 * 所以这里只是"拿已有的公式跑一遍帧"，一行数据模型都不用加。
 *
 * ## 三条不许违反的规矩
 *
 * 1. **解不出来就说解不出来，绝不编一个值**。未绑定 PID 的 ID 由调用方显示原始 hex；
 *    绑定了但 DLC 不够 / 命中无效原始值 / 公式失败时，[Decoded.value] 是 `null`，
 *    界面显示 `--` 加原因 —— **"看起来像真的"是这个项目最贵的一类 bug**。
 * 2. **可信度必须标出来**：`enabled=false` 的条目是**候选**（没经过验证），
 *    不能和已确认的信号长得一样（规格 §1 决策 4 的同一个理由）。
 * 3. **判定只有一份实现**：DLC 守卫用 [dlcTooShort]、无效值用 [hitsInvalidRaw] ——
 *    与运行时 `FrameMonitor` 调的是**同一对函数**。自己再写一遍"帧长够不够"，
 *    就会出现"探测页说够、运行时不收"这种互相打脸的现象。
 *
 * 纯函数、不依赖 Android：`SignalDecodeTest` 直接压边界（塞进 Activity 就一条都测不到）。
 */
object SignalDecode {

    /**
     * 一条监听型 PID 对一帧的解码结论。
     *
     * @param value     物理值。`null` = **不可信 / 解不出来**（界面显示 `--`）
     * @param candidate `true` = 候选（`enabled=false`，没验证过）
     * @param ok        `false` = 这条结论不可信（原因见 [reason]）
     * @param reason    不可信的原因；`ok=true` 时为空
     */
    data class Decoded(
        val pidId: String,
        val name: String,
        val unit: String,
        val value: Double?,
        val candidate: Boolean,
        val ok: Boolean,
        val reason: String = ""
    ) {
        /**
         * 探测页那一行的正文：`油温 88℃（候选）` / `左转向灯 --（DLC 不足 需要=4 实际=2）`。
         *
         * 候选与不可信**可以同时出现**（一条没验证过的候选信号，帧又不够长）——
         * 两种信息都要留着，别让一个盖掉另一个。
         */
        fun text(): String = buildString {
            append(name)
            if (ok && value != null) {
                append(' ').append(fmtValue(value))
                if (unit.isNotBlank()) append(unit)
            } else {
                append(" --")
            }
            if (!ok && reason.isNotBlank()) append("（").append(reason).append("）")
            if (candidate) append("（候选）")
        }
    }

    /**
     * 解一条信号。
     *
     * 顺序刻意与运行时 `FrameMonitor.feedLine` 一致（DLC → 求值 → 无效原始值），
     * 否则会出现"探测页显示了一个值，而仪表上是 `--`"。
     */
    fun decode(frame: ByteArray, pid: PidDefinition): Decoded {
        val candidate = !pid.enabled
        // ① DLC 守卫（与运行时同一个判定，见类注释第 3 条）
        if (pid.dlcTooShort(frame.size)) {
            return Decoded(
                pid.id, pid.name, pid.unit, null, candidate, false,
                "DLC 不足 需要=${pid.minDlc} 实际=${frame.size}"
            )
        }
        // ② 求值。解到帧外 / 语法错 / 除零都在这里被抓住 —— 抓不住就变成"编一个值"
        val v = try {
            Formula.eval(pid.formula, frame)
        } catch (t: Throwable) {
            return Decoded(
                pid.id, pid.name, pid.unit, null, candidate, false,
                "解不出（${t.message ?: "公式错误"}）"
            )
        }
        // ③ 无效原始值：与运行时同一个判定（`rawBits` 拿的是位段本身，不是物理值）
        if (pid.invalidRaw != null && pid.hitsInvalidRaw(Formula.rawBits(pid.formula, frame), v)) {
            return Decoded(
                pid.id, pid.name, pid.unit, null, candidate, false,
                "命中无效原始值 ${pid.invalidRaw}"
            )
        }
        return Decoded(pid.id, pid.name, pid.unit, v, candidate, true)
    }

    /**
     * 一帧 + 这个 ID 上绑定的全部监听型 PID。
     *
     * 返回**全部**结论（包括候选、包括解不出来的）——
     * 调用方要能看到"这条 ID 上有个候选信号，但它不可信"，而不是被静默过滤掉。
     */
    fun decodeAll(frame: ByteArray, pids: List<PidDefinition>): List<Decoded> =
        pids.map { decode(frame, it) }

    /**
     * `header` → 该 CAN ID 上绑定的监听型 PID。
     *
     * 一次建索引、逐帧查表，而不是每帧线性扫全部 PID ——
     * 与 `FrameRateGate.acceptIdsOf` 同一个理由：不过滤时每秒几百帧，
     * "每个 ID 扫 90 条 PID"是纯粹的浪费。
     *
     * ⚠️ **候选（`enabled=false`）也要进来**：S4 的价值之一就是把候选标出来，
     * 按 `enabled` 过滤会让它们彻底看不见（那就又回到"只能看 hex"了）。
     */
    fun indexByHeader(pids: List<PidDefinition>): Map<Int, List<PidDefinition>> {
        val out = HashMap<Int, MutableList<PidDefinition>>()
        pids.forEach { p ->
            if (!isMonitor(p.source)) return@forEach
            if (p.formula.isBlank()) return@forEach
            // header 空时退到 pid：内置转向灯两条字段相同；存量配置里可能有只填了 pid 的
            val id = SignalTableCsv.normalizeId(p.header.ifBlank { p.pid })?.toIntOrNull(16)
                ?: return@forEach
            out.getOrPut(id) { ArrayList() }.add(p)
        }
        return out
    }

    /**
     * `"00 00 04 00 88 00 03 00"` → 字节数组。
     *
     * 探测页的聚合结果里，数据是以**十六进制串**保存的（`CanFrame.Aggregate.lastData`
     * 与 `values`），所以解帧前要还原回字节。非法 token 直接跳过
     * （`CanFrame.parseLine` 也是这么处理的）—— 这里的目标是"能解就解"，
     * 而不是对总线上的噪声报警。
     */
    fun parseHexData(s: String): ByteArray {
        val parts = s.trim().split(Regex("\\s+")).filter { it.length == 2 && it.all { c -> isHex(c) } }
        return ByteArray(parts.size) { i -> parts[i].toInt(16).toByte() }
    }

    private fun isMonitor(source: String): Boolean = source.trim().equals("monitor", true)

    private fun isHex(c: Char): Boolean =
        c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

    /**
     * 读数的显示格式：整数不带小数点，小数最多 3 位且**去掉尾随零**。
     *
     * 为什么不是 `String.format("%.3f")`：`88` 会显示成 `88.000`，
     * 而这条 ID 上多数是整数信号（开关位、挡位）—— 一屏 `0.000 / 1.000`
     * 比 `0 / 1` 难读得多，而读数难读就等于"看不懂"。
     */
    fun fmtValue(v: Double): String {
        if (v.isNaN() || v.isInfinite()) return "?"
        if (v == Math.floor(v) && Math.abs(v) < 1e15) return v.toLong().toString()
        val r = Math.round(v * 1000.0) / 1000.0
        return r.toString().trimEnd('0').trimEnd('.')
    }
}
