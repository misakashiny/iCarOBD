package com.icar.obd.obd

/**
 * CAN 帧的解析与聚合 —— **纯逻辑，可单测**。
 *
 * ## 它和 PID 扫描器不是一回事
 *
 * - **PID 扫描器**是主动请求：发 `01 0C` → 等响应。只能发现「ECU 愿意回答的 PID」。
 * - **CAN 探测**是被动监听：`ATMA` 让 ELM327 把总线上所有帧倒出来，能看到**广播帧**。
 *   转向灯、车门、刹车这类信号**不在标准 OBD 里**，只能靠它找。
 *
 * ## 防洪水是这一层的核心职责
 *
 * v1.3.0 在实车上因为「写失败 → 无限重试 → 逐次写日志」刷出过 **113 万行 / 57.9MB**。
 * `ATMA` 一秒能出上千帧，如果每帧都进日志/内存，会是同一场事故的翻版。所以：
 *  - 聚合层**只记录变化了的数据**，重复帧只累加计数；
 *  - 原始流**有界**（超出丢最旧并计数），不会无限增长；
 *  - 上层**绝不逐帧写日志**，只写汇总。
 */
object CanFrame {

    /** 一帧：CAN ID + 数据字节 */
    data class Frame(val canId: Int, val data: List<Int>) {
        val isExtended: Boolean get() = canId > 0x7FF
        fun idHex(): String = String.format("%X", canId)
        fun dataHex(): String = data.joinToString(" ") { String.format("%02X", it) }
    }

    /** 带时间戳的原始帧 */
    data class RawFrame(val ts: Long, val frame: Frame)

    /** 按 CAN ID 聚合出来的统计 */
    data class Aggregate(
        val canId: Int,
        var count: Int = 0,
        /** 数据变化过几次 —— 周期性广播但数据不变的 ID，这个值会很小 */
        var changed: Int = 0,
        var lastData: String = "",
        var firstTs: Long = 0,
        var lastTs: Long = 0
    ) {
        /**
         * 出现过的**不同 data 值**（有界，最多 8 个）。
         *
         * 为什么必须有它：聚合里的 `lastData` 只是**最后一帧**的值，
         * 而周期信号很可能正好停在"暗"相位 —— 于是
         * "开灯时 byte2 跳到 04 还是 08"这种问题**光看 last 答不了**。
         * 实车 2026-10-06 就卡在这里：`09A` 已知跟着转向灯跳，
         * 但左转、右转两次的 last 都是 `00`，分不出左右。
         *
         * 放在**类体**而不是构造参数里：可变集合不该参与 `data class` 的
         * `equals`/`hashCode`/`copy`。
         */
        val values: LinkedHashSet<String> = LinkedHashSet()

        val isExtended: Boolean get() = canId > 0x7FF
        fun idHex(): String = String.format("%X", canId)
    }

    /**
     * 解析一行 `ATH1` 输出。
     *
     * 形如：
     * ```
     * 7E8 10 14 49 02 01 31 47 31        ← 11 位 ID
     * 18DAF110 10 14 49 02 01 31 47 31   ← 29 位 ID
     * ```
     * 第一个 token 是 CAN ID（3~8 个十六进制位），其余是数据字节。
     *
     * @return 解析失败返回 null（`ATMA` 会夹杂 `SEARCHING...`、空行、`>` 等噪声）
     */
    fun parseLine(line: String): Frame? {
        val toks = line.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (toks.size < 2) return null
        val idTok = toks[0]
        if (idTok.length !in 3..8) return null
        // 必须整串都是十六进制，否则可能是 "SEARCHING..." 之类
        if (!idTok.all { it.isHexDigit() }) return null
        val id = idTok.toIntOrNull(16) ?: return null
        val data = ArrayList<Int>(toks.size - 1)
        for (i in 1 until toks.size) {
            val t = toks[i]
            if (t.length != 2 || !t.all { it.isHexDigit() }) continue
            data.add(t.toIntOrNull(16) ?: continue)
        }
        if (data.isEmpty()) return null
        return Frame(id, data)
    }

    private fun Char.isHexDigit(): Boolean =
        this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'

    /**
     * 聚合器。
     *
     * @param maxRaw 原始流上限。超出丢最旧并计入 [dropped] ——
     *   10 秒的 `ATMA` 在高流量总线上可能上万帧，不设上限就是内存泄漏。
     */
    class Accumulator(private val maxRaw: Int = 5000) {

        private val agg = LinkedHashMap<Int, Aggregate>()
        private val raw = ArrayList<RawFrame>()

        var dropped: Int = 0
            private set

        /** 喂一帧。重复帧只累加计数，**不追加原始流** */
        fun feed(f: Frame, now: Long) {
            val a = agg.getOrPut(f.canId) { Aggregate(f.canId, firstTs = now) }
            a.count++
            a.lastTs = now
            val hex = f.dataHex()
            if (hex != a.lastData) {
                a.changed++
                a.lastData = hex
            }
            // 记录不同取值（有界 8 个，防内存膨胀）
            if (a.values.size < 8 || a.values.contains(hex)) a.values.add(hex)
            if (raw.size < maxRaw) raw.add(RawFrame(now, f)) else dropped++
        }

        fun feedLine(line: String, now: Long): Boolean {
            val f = parseLine(line) ?: return false
            feed(f, now)
            return true
        }

        fun aggregates(): List<Aggregate> =
            agg.values.sortedByDescending { it.count }

        fun rawFrames(): List<RawFrame> = raw.toList()

        fun frameCount(): Int = agg.values.sumOf { it.count }

        fun clear() {
            agg.clear(); raw.clear(); dropped = 0
        }

        /** 聚合 CSV：一眼看出哪些 ID 在周期性广播 */
        fun aggregateCsv(): String = buildString {
            append("canId,isExtended,count,changed,lastData,firstTs,lastTs\n")
            aggregates().forEach { a ->
                append(a.idHex()).append(',')
                append(if (a.isExtended) 1 else 0).append(',')
                append(a.count).append(',')
                append(a.changed).append(',')
                append('"').append(a.lastData).append('"').append(',')
                append(a.firstTs).append(',')
                append(a.lastTs).append('\n')
            }
        }

        /** 原始帧 CSV：信息全，但文件大得多 */
        fun rawCsv(): String = buildString {
            append("ts,canId,isExtended,dlc,data\n")
            raw.forEach { r ->
                append(r.ts).append(',')
                append(r.frame.idHex()).append(',')
                append(if (r.frame.isExtended) 1 else 0).append(',')
                append(r.frame.data.size).append(',')
                append('"').append(r.frame.dataHex()).append('"').append('\n')
            }
        }
    }
}
