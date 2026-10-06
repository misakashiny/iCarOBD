package com.icar.obd.obd

/**
 * 两次 CAN 探测的**逐位差分** —— 用来"找位"。
 *
 * ## 它解决的是什么问题
 *
 * 广播帧里的信号（转向灯、车门、刹车…）没有名字，只有一个 CAN ID 和一串字节。
 * 想找出"开门"到底是哪一位，唯一的办法是**做对照实验**：
 * 关门探一次、开门再探一次，然后看**哪一位的状态变了**。
 *
 * 这件事原先是我在电脑上手工做的（转向灯 `0x09A` 就是这么找出来的），
 * 但每找一个信号就要一个人工环节 —— 这个类把判据固化成可测的代码。
 *
 * ## 判据（不是"比两个值相不相等"）
 *
 * 单次采样会**撞相位**：转向灯 1.4 Hz，采到"亮"还是"暗"是掷硬币。
 * 所以不能拿两次的某个值去 XOR（那会把相位差异当成信号）。
 *
 * 正确的做法是把一次探测里该 ID 出现过的**所有不同取值**收进来，
 * 折算成**每一位**的状态：
 *
 * | 状态 | 含义 |
 * |---|---|
 * | `CONST0` | 这次探测里它**一直是 0** |
 * | `CONST1` | 一直是 1 |
 * | `VARIES` | **在 0/1 之间跳过** —— 说明这次操作让它动了 |
 *
 * 然后比两次的**状态**：某一位从 `CONST0` 变成 `VARIES`，
 * 就是"这次操作把它拨动了" —— **与采样相位无关**。
 *
 * ## 局限（必须说清楚）
 *
 * - 每个 ID 最多保留 8 个不同取值（见 `CanFrame.Aggregate.values`）。
 *   变化很稀疏的位可能刚好没被采到，会被误判成 `CONST`。
 *   **所以差分结果是"候选"，不是"结论"** —— 加为监听型 PID 之后
 *   在真实操作下再看一次取值变化日志才算确认。
 * - 只比**两次都出现过**的 ID：某个 ID 只在一次里出现，
 *   多半是低频事件帧（网络管理等），不报（否则每对实验都会被它淹没）。
 */
object CanDiff {

    /** 某一位在**一次探测之内**的表现 */
    enum class BitState {
        CONST0, CONST1, VARIES;

        val label: String
            get() = when (this) {
                CONST0 -> "恒0"
                CONST1 -> "恒1"
                VARIES -> "在变"
            }
    }

    /**
     * 一处位差异。
     *
     * @param from 基准那次的状态
     * @param to 本次的状态
     */
    data class BitChange(
        val canId: Int,
        val byteIndex: Int,
        val bitIndex: Int,
        val from: BitState,
        val to: BitState,
    ) {
        /** 直接能填进监听型 PID 的公式（`A B C…` = 数据第 1..n 字节） */
        fun formula(): String = "bit(${('A' + byteIndex)},$bitIndex)"

        fun canIdHex(): String = "%03X".format(canId)

        /** 建议的 PID 名，用户可以在「PID」页改 */
        fun suggestName(): String = "监听 ${canIdHex()}.b$byteIndex.$bitIndex"

        /** 建议的 PID id（同一处再加一次会**覆盖**而不是堆积） */
        fun suggestId(): String = "mon_${canIdHex()}_${byteIndex}_$bitIndex"

        fun describe(): String =
            "${canIdHex()} 第${byteIndex + 1}字节 bit$bitIndex：${from.label} -> ${to.label}"

        /** 是不是"这次操作把它拨动了"（最有价值的那一类） */
        fun isPrimary(): Boolean =
            (from == BitState.CONST0 || from == BitState.CONST1) && to == BitState.VARIES
    }

    /** 解析 `"00 00 04 00 88 00 03 00"`；容忍多余空格与大小写 */
    fun parseData(s: String): IntArray? {
        val parts = s.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (parts.isEmpty()) return null
        val out = IntArray(parts.size)
        for (i in parts.indices) {
            val v = parts[i].toIntOrNull(16) ?: return null
            if (v !in 0..0xFF) return null
            out[i] = v
        }
        return out
    }

    /**
     * 把一个 ID 出现过的**所有不同取值**折算成每一位的状态。
     *
     * @param values 该 ID 出现过的不同 data 串
     * @return 按 `(字节, 位)` 展开的状态表（空 = 解析不出来）
     */
    fun bitStates(values: Collection<String>): List<BitState>? {
        val rows = values.mapNotNull { parseData(it) }
        if (rows.isEmpty()) return null
        val n = rows.first().size
        if (rows.any { it.size != n }) return null
        val out = ArrayList<BitState>(n * 8)
        for (b in 0 until n) {
            for (k in 0..7) {
                var ones = 0
                for (r in rows) if ((r[b] shr k) and 1 == 1) ones++
                out.add(
                    when {
                        ones == 0 -> BitState.CONST0
                        ones == rows.size -> BitState.CONST1
                        else -> BitState.VARIES
                    }
                )
            }
        }
        return out
    }

    /**
     * 差分。
     *
     * @return 状态发生了变化的位；**"恒定 -> 在变"排在最前**（那才是这次操作引起的）
     */
    fun diff(
        baseline: Map<Int, Collection<String>>,
        current: Map<Int, Collection<String>>,
    ): List<BitChange> {
        val out = ArrayList<BitChange>()
        for ((canId, curValues) in current) {
            val baseValues = baseline[canId] ?: continue
            val base = bitStates(baseValues) ?: continue
            val cur = bitStates(curValues) ?: continue
            val n = minOf(base.size, cur.size)
            for (i in 0 until n) {
                if (base[i] == cur[i]) continue
                out.add(
                    BitChange(
                        canId = canId,
                        byteIndex = i / 8,
                        bitIndex = i % 8,
                        from = base[i],
                        to = cur[i],
                    )
                )
            }
        }
        return out.sortedWith(
            compareByDescending<BitChange> { it.isPrimary() }
                .thenBy { it.canId }
                .thenBy { it.byteIndex }
                .thenBy { it.bitIndex }
        )
    }
}
