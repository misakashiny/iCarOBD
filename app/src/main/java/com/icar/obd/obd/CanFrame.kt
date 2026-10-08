package com.icar.obd.obd

import com.icar.obd.data.SignalTableCsv

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

        /**
         * 观察到的**最长帧**的字节数（v1.20.7）。
         *
         * 为什么不是"最后一帧的长度"：同一个 ID 可能既有 4 字节帧又有 8 字节帧
         * （多路复用/分段），而信号表模板的 `DLC` 列要预填的是**能放下这条信号的那种帧**。
         * 取最后一帧会让模板的 DLC 随机偏小 → 导入时被"解到帧外"的硬错误拒掉，
         * 而用户填的其实是对的。取最大值才是"这个 ID 最多能看到几个字节"。
         */
        var maxDlc: Int = 0

        val isExtended: Boolean get() = canId > 0x7FF
        fun idHex(): String = String.format("%X", canId)

        /**
         * 观察到帧的数据字节数（**最长的那一帧**）。
         *
         * 「导出信号表模板」的 `DLC` 列靠它预填 —— 那正是 §7 陷阱 2 里说的
         * "别拿 `最小/最大` 当编码范围"的替代品：**帧长只能从帧本身读**。
         */
        fun dlc(): Int = maxDlc
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
            if (f.data.size > a.maxDlc) a.maxDlc = f.data.size
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

        /**
         * 直接设某个 CAN ID 的 `count` / `changed`（v1.20.10，分段轮换的合并用）。
         *
         * ## 为什么需要"直接设"而不是"喂够帧数"
         *
         * `Aggregate.values` 是**去重**的（有界 8 个），拿它重建每一帧是不可能的：
         * 一段里 `01 → 02 → 01` 出现 3 帧、`values` 只有两个元素 ——
         * 照它喂出来 `count` 会变成 2（真值 3）。而 `count` 正是
         * "这条 ID 有多吵"的判据，少算了它整车清单的排序就不可信。
         *
         * ## 为什么在这里而不是让调用方改 `Aggregate`
         *
         * `Aggregate` 的 `count` / `changed` 是 `var`，但它是**聚合器的内部状态**；
         * 让外面随手改会让"谁能改这两个数"变成一件说不清的事。
         * 收在这里，语义就一句话：**这是"合并多段结果"的专用入口**。
         *
         * @param count 该 ID 的总帧数
         * @param changed 该 ID 的总变化次数（**含跨段边界那一次**，由调用方算好）
         */
        fun setCounts(canId: Int, count: Int, changed: Int) {
            val a = agg[canId] ?: return
            a.count = count
            a.changed = changed
        }

        /**
         * 把**同一个值**重复喂 [times] 次（v1.20.10，分段轮换的合并用）。
         *
         * 为什么不循环调 [feed]：`feed` 每次都走 `dataHex()` 建字符串 + 查 `values`，
         * 而这里要补的是"这条 ID 在这一段里又出现了 N 次" —— 值确定相同，
         * 那些活全是白做的。轮换合并时 N 可能上千（8 段 × 每段几百帧）。
         *
         * 语义与 `repeat(times) { feed(f, now) }` **完全一致**：
         * `count` 累加、`changed` 只在值真的变了时 +1（这里值相同，所以对
         * "已经在 `values` 里的值"它一次都不会加）、`values` 只加一次、
         * `raw` 不追加（与 `feed` 一样：原始流只留**解析出的**帧，
         * 而这里补的是聚合计数，不是新观测）。
         *
         * ⚠️ 判据写成 `hex != a.lastData`（**不是** `a.lastData.isEmpty()`）：
         * `Aggregate.lastData` 的初值是空串，所以**第一帧永远算一次变化** ——
         * 这正是 `feed` 的行为，两边必须逐字一致，否则合并出来的 `changed`
         * 会比单段跑出来的少一次。
         */
        fun feedRepeated(f: Frame, now: Long, times: Int) {
            if (times <= 0) return
            val a = agg.getOrPut(f.canId) { Aggregate(f.canId, firstTs = now) }
            val hex = f.dataHex()
            if (hex != a.lastData) {
                a.changed++
                a.lastData = hex
            }
            a.count += times
            a.lastTs = now
            if (f.data.size > a.maxDlc) a.maxDlc = f.data.size
            if (a.values.size < 8 || a.values.contains(hex)) a.values.add(hex)
        }

        fun aggregates(): List<Aggregate> =
            agg.values.sortedByDescending { it.count }

        fun rawFrames(): List<RawFrame> = raw.toList()

        fun frameCount(): Int = agg.values.sumOf { it.count }

        fun clear() {
            agg.clear(); raw.clear(); dropped = 0
        }

        /**
         * 聚合 CSV（= 导出「观察表」）：一眼看出哪些 ID 在周期性广播。
         *
         * v1.20.7（S1）三处改动：
         *  - **中文表头** —— 这份文件是给人看的（Excel 里），英文列名没必要；
         *  - **`报文ID(dec)` 冗余列** —— 信号表要的是十进制 ID，而 `报文ID(hex)` 里
         *    `9A` / `09A` 两种写法都能出现；把两个都印出来，人抄哪一列都不会错；
         *  - **UTF-8 BOM** —— 没有它 Windows Excel 按 ANSI 打开，中文表头乱码
         *    （见 [SignalTableCsv.BOM]）。
         */
        fun aggregateCsv(): String = buildString {
            append(SignalTableCsv.BOM)
            append("报文ID(hex),报文ID(dec),29位ID,帧数,变化次数,最后数据,首次时间(ms),最后时间(ms)\n")
            aggregates().forEach { a ->
                append('"').append(a.idHex()).append('"').append(',')
                append(a.canId).append(',')
                append(if (a.isExtended) 1 else 0).append(',')
                append(a.count).append(',')
                append(a.changed).append(',')
                append(SignalTableCsv.escape(a.lastData)).append(',')
                append(a.firstTs).append(',')
                append(a.lastTs).append('\n')
            }
        }

        /** 原始帧 CSV（= 导出「观察表 · 原始帧」）：信息全，但文件大得多 */
        fun rawCsv(): String = buildString {
            append(SignalTableCsv.BOM)
            append("时间戳(ms),报文ID(hex),报文ID(dec),29位ID,DLC,数据\n")
            raw.forEach { r ->
                append(r.ts).append(',')
                append('"').append(r.frame.idHex()).append('"').append(',')
                append(r.frame.canId).append(',')
                append(if (r.frame.isExtended) 1 else 0).append(',')
                append(r.frame.data.size).append(',')
                append(SignalTableCsv.escape(r.frame.dataHex())).append('\n')
            }
        }
    }
}
