package com.icar.obd.obd

/**
 * **分段轮换扫描**（v1.20.10，P12-S5）—— 纯逻辑，可 JVM 单测。
 *
 * ## 为什么需要它
 *
 * 一次被动探测（`ATMA`）只能看到"这段时间里在说话"的 ID。**8 段全扫一遍**
 * 才谈得上"整车 ID 清单"，但 `ATMA` 是单流：不加过滤器时克隆版只漏出约
 * 77 帧/秒，摊到 80 个 ID 上就是**每个 ID 每秒 1 帧** —— 闪烁类信号根本还原不出来。
 *
 * 掩码过滤器（`ATCM700` + `ATCF<段>00`）一次覆盖 256 个 ID，**每段都是全采样率**，
 * 8 段就把 11 位 ID 空间（`0x000`~`0x7FF`）走了一遍。这就是"摸一遍"的做法。
 *
 * ## 为什么判定要抽出来（而不是写在 [CanSniffer] 里）
 *
 * `CanSniffer` 是 `object` 且持有 `Handler(Looper.getMainLooper())`，
 * **在 JVM 里一碰就抛 `Stub!`** —— 写在里面就一条都测不到。而这里全是纯算术：
 * "现在第几段 / 还剩多久 / 什么时候该换段"，**恰恰是最容易差一的地方**
 * （差一的表现是"最后一段只跑了 3 秒就结束了"，而现场日志已经翻篇了）。
 * 所以判定全部抽进了这个 object（命令/段范围/合并，全是纯函数）
 * 与 [RotationPlan]（时间 → 段号的状态机），**两边都能被 JVM 单测直接压**。
 * 与 [FrameRateGate] 是同一套理由。
 *
 * ## ⚠️ 段号看 `ATCF` 的**高三位**
 *
 * `ATCF000` 是 **11 位 ID 全通**（不是"`0x0xx` 段"）—— 实测确认过。
 * 掩码是 `ATCM700`（只看高三位），所以：
 *
 * | 段 | `ATCF` | 覆盖的 ID |
 * |---|---|---|
 * | 0 | `ATCF000` | `0x000`~`0x0FF` |
 * | 1 | `ATCF100` | `0x100`~`0x1FF` |
 * | … | … | … |
 * | 7 | `ATCF700` | `0x700`~`0x7FF` |
 *
 * 把 `ATCF000` 当成"第 0 段"来理解是**错的**（它放行整条总线，会得到一份
 * 帧数虚高的第 0 段），但在这张表里它是**对**的 —— 因为掩码 `ATCM700` 已经
 * 把范围收在 `0x000`~`0x7FF`，`ATCF000` 在掩码下就是"`0x0xx` 段"。
 * **掩码与过滤是一对，缺一不可。**
 *
 * ## ⚠️ 29 位 ID 不在覆盖范围里
 *
 * 掩码只覆盖 11 位 ID。总线上若有 29 位 ID（`0x18DAF110` 这种），
 * 它**一段都扫不到** —— 这是本方案的已知边界，见 [CanSniffer] 的说明。
 */
object SegmentRotation {

    /** 段数：8 段（`0x000`~`0x7FF`，每段 256 个 ID）。**规格 §1 决策 2 已定** */
    const val SEGMENT_COUNT = 8

    /**
     * 每段时长：10 秒。
     *
     * 10 秒能让 2.1 Hz 的信号采到约 20 帧、1 Hz 的采到 10 帧 —— 再短会漏掉慢周期报文。
     * 要更快得另做「快速 5 秒」模式（本版不做）。
     */
    const val SEGMENT_MS = 10_000L

    /** 掩码命令：只看 CAN ID 的高三位。**必须与 `ATCF<段>00` 成对发** */
    const val MASK_CMD = "ATCM700"

    /** 一轮的采集时长（8 × 10 秒 = 80 秒；含换段 AT 开销约 90 秒） */
    val ROUND_MS: Long get() = SEGMENT_COUNT * SEGMENT_MS

    /**
     * 第 [segment] 段的 `ATCF` 命令（含掩码，**两条一起返回**）。
     *
     * 每次换段都重发掩码是刻意的：`ATCM`/`ATCF` 在有些克隆版上会被
     * `ATMA` 的启停冲掉，重发一次的代价是一条 AT 命令，而漏发的代价是
     * **整整一段收到的是全总线数据**（帧数虚高、ID 混段，事后完全看不出来）。
     */
    fun segmentCommands(segment: Int): List<String> {
        val s = segment.coerceIn(0, SEGMENT_COUNT - 1)
        return listOf(MASK_CMD, "ATCF%03X".format(s shl 8))
    }

    /** 第 [segment] 段的过滤值（如 `ATCF000`），日志与界面用 */
    fun segmentFilter(segment: Int): String =
        "ATCF%03X".format(segment.coerceIn(0, SEGMENT_COUNT - 1) shl 8)

    /** 第 [segment] 段覆盖的 ID 范围（如 `0x000~0x0FF`），给人看 */
    fun segmentRange(segment: Int): String {
        val s = segment.coerceIn(0, SEGMENT_COUNT - 1)
        return "0x%03X~0x%03X".format(s shl 8, (s shl 8) + 0xFF)
    }

    /** 这一段的短标签（`第 3/8 段 0x200~0x2FF`），界面与日志共用 */
    fun label(segment: Int): String {
        val s = segment.coerceIn(0, SEGMENT_COUNT - 1)
        return "第 ${s + 1}/$SEGMENT_COUNT 段 ${segmentRange(s)}"
    }

    /** 一段的统计（[merge] 的输入） */
    data class SegmentStat(
        val segment: Int,
        val frameCount: Int,
        val idCount: Int
    )

    /**
     * 把多段的聚合结果**合并成一份「整车 ID 清单」**。
     *
     * ## 为什么不能"把各段的值喂进一个新累加器"了事
     *
     * `Aggregate.values` 是**去重**的（有界 8 个）。想靠它重建每一帧是不可能的：
     * 一段里 `01 → 02 → 01` 出现 3 帧，`values` 只有两个元素 ——
     * 照它喂出来 `count` 会变成 2（真值是 3）。
     * 而 `count` 正是"这条 ID 有多吵"的判据，少算了它，整车清单的排序就不可信。
     *
     * 所以 `count` / `changed` 是**算出来的**（见 [mergedChanged]），
     * 只有 `values` / `lastData` / `maxDlc` / 时间戳这类"取值层面"的东西
     * 才交给累加器去管（那边有界去重与时间戳的语义正好是我们想要的）。
     *
     * ## `changed` 为什么是"各段之和 + 段间边界"
     *
     * 每一段的累加器都从零开始，所以它记的 `changed` 是**段内**变化次数
     * （含该段第一帧那一次）。跨段的那个边界没人记：
     * **上一段的最后一帧 → 这一段的第一帧**，两者不同就是一次真实变化。
     *
     * 不补这一下的后果不是"数字小一点"，而是"按 changed 排序"那张表会
     * **把跨段跳动的信号埋掉** —— 而那正是我们最想找的东西。
     *
     * ## 为什么用 [CanFrame.Accumulator] 而不是自己写 Map 合并
     *
     * `values` 的有界去重、`maxDlc` 取最大、`firstTs/lastTs` 的维护、
     * 以及 `aggregateCsv()` 这些下游入口 —— 复用它就没有第二份实现会跟它分叉。
     */
    fun merge(
        perSegment: List<Pair<Int, List<CanFrame.Aggregate>>>,
        into: CanFrame.Accumulator
    ): CanFrame.Accumulator {
        // 先按段号排序：调用方给的是"采集顺序"，而合并的语义是"先来的在前"，
        // 顺序反了会把段间边界算反（表现是 changed 差几次，很难看出来）
        val ordered = perSegment.sortedBy { it.first }
        // ---- ① 取值层面：交给累加器（它负责有界去重 / maxDlc / 时间戳）----
        ordered.forEach { (_, list) ->
            list.sortedBy { it.firstTs }.forEach { a ->
                // 按**观察顺序**喂取值：Aggregate.values 是 LinkedHashSet，
                // 顺序就是"这个值第一次出现的顺序"
                a.values.forEach { v ->
                    into.feed(CanFrame.Frame(a.canId, parseHex(v)), a.firstTs)
                }
                if (a.count > 0) {
                    // 再喂一次"最后一帧的值"，把 lastData / lastTs 摆到正确的位置
                    // （只喂一次，不是补 count —— count 由下面 ② 直接设）
                    into.feedRepeated(
                        CanFrame.Frame(a.canId, parseHex(a.lastData)), a.lastTs, 1
                    )
                }
            }
        }
        // ---- ② 计数层面：count / changed 直接按算术结果设回去 ----
        //
        // ⚠️ 必须放在最后，而且**每个 ID 只设一次**：`feed` 会把 count/changed
        // 累成"不同值个数"那种错数，这里一次性覆盖成正确值；
        // 分两次设的话后一次会把前一次**覆盖掉**（不是相加）。
        val totalCount = HashMap<Int, Int>()
        val totalChanged = HashMap<Int, Int>()
        ordered.forEach { (_, list) ->
            list.forEach { a ->
                totalCount[a.canId] = (totalCount[a.canId] ?: 0) + a.count
                totalChanged[a.canId] = (totalChanged[a.canId] ?: 0) +
                    a.changed + boundaryChange(list, a)
            }
        }
        totalCount.forEach { (id, n) ->
            into.setCounts(id, n, totalChanged[id] ?: 0)
        }
        return into
    }

    /**
     * 跨段的那一次边界变化：**上一段的最后一帧 → 这一段的第一帧**。
     *
     * 两者不同就是一次真实变化（各段的累加器都记不到它 —— 每段都是从零开始的）。
     * 同一个 ID 在一段里只算一次（同一个 ID 在同一段里只会有一条 [CanFrame.Aggregate]）。
     *
     * ⚠️ 返回的是 0 或 1：`Aggregate.values` 只保留了**去重后**的取值，
     * 拿不到"这一段第一帧"的精确位置 —— 用 `values.first()` 当它的近似
     * （第一个出现的取值就是第一帧的取值，除非这一段 >8 种取值）。
     */
    private fun boundaryChange(list: List<CanFrame.Aggregate>, a: CanFrame.Aggregate): Int {
        val first = a.values.firstOrNull() ?: return 0
        val prev = list.lastOrNull { it.canId == a.canId && it.firstTs < a.firstTs } ?: return 0
        return if (prev.lastData != first) 1 else 0
    }

    /**
     * `"00 00 04 00 88"` → 字节列表；解不出返回空列表。
     *
     * 与 `CanFrame.Frame.dataHex()` 是**互为逆**的一对（那边 join，这边 split）。
     * 解不出的（手改坏的聚合、空串）返回空列表 —— `feed` 会把 DLC 记成 0，
     * 比崩掉好。
     */
    private fun parseHex(hex: String): List<Int> =
        hex.trim().split(Regex("\\s+"))
            .filter { it.length == 2 }
            .mapNotNull { it.toIntOrNull(16) }
}

/**
 * 轮换状态机（v1.20.10）—— **时间由调用方传入**，不碰 Handler / View / Store。
 *
 * ## 为什么"现在第几段"是算出来的，而不是累加出来的
 *
 * 累加式（每段结束 `index++`）一旦漏掉一次 tick 就**永久偏移** ——
 * 而 ticker 是 500ms 一次的主线程回调，被 GC 或一次重布局拖慢非常正常。
 * 算出来的形式（`elapsed / segmentMs`）**天然自愈**：慢一拍只是换段晚半秒，
 * 段序与段数不会错位。
 *
 * ## 一轮跑完怎么办
 *
 * [isDone] 变 true 之后 [snapshot] 仍然报最后一段（不是越界崩、也不是回到第 0 段）——
 * 收尾时还要用它写日志（"最后一段收到了多少帧"）。
 *
 * ## ⚠️ 为什么叫 `RotationPlan` 而不是 `SegmentRotation.Something`
 *
 * `SegmentRotation` 已经是个 `object`，**同名再声明一个 `class` 会整个把
 * object 的作用域弄坏**（Kotlin 报 `Redeclaration`，然后 object 里所有成员
 * 都变成 `Unresolved reference`）—— 而报错会跑到**调用方**去，很难看出根因。
 *
 * @param count 段数（默认 8；测试传小值）
 * @param segmentMs 每段时长（默认 10 秒；测试传小值）
 */
class RotationPlan(
    val count: Int = SegmentRotation.SEGMENT_COUNT,
    val segmentMs: Long = SegmentRotation.SEGMENT_MS
) {

    /** 一段的状态快照（`CanSniffer.Status` 与界面进度行都用它） */
    data class Snapshot(
        /** 段下标，0 起。一轮跑完后仍是**最后一段**，不是 0 */
        val index: Int,
        /** 段数 */
        val count: Int,
        /** 本段还剩多少毫秒。已跑完一轮时为 0 */
        val remainingMs: Long,
        /** 整轮还剩多少毫秒。已跑完一轮时为 0 */
        val totalRemainingMs: Long,
        /** 一轮是不是跑完了 */
        val done: Boolean
    ) {
        /** `第 3/8 段` */
        fun segmentLabel(): String = "第 ${index + 1}/$count 段"
    }

    init {
        require(count >= 1) { "段数必须 >= 1（传了 $count）" }
        require(segmentMs >= 1) { "每段时长必须 >= 1ms（传了 $segmentMs）" }
    }

    /** 一轮的总时长 */
    val totalMs: Long get() = count * segmentMs

    /** 当前是第几段（0 起）。一轮跑完后返回**最后一段** */
    fun indexAt(elapsedMs: Long): Int {
        val e = elapsedMs.coerceAtLeast(0L)
        if (e >= totalMs) return count - 1
        return (e / segmentMs).toInt()
    }

    fun isDone(elapsedMs: Long): Boolean = elapsedMs.coerceAtLeast(0L) >= totalMs

    /**
     * 到 [elapsedMs] 为止，**是不是又该换段了**（并且换过几次）。
     *
     * @param lastIndex 上次已经下发过命令的那一段（首次传 -1）
     * @return 需要下发的段下标列表（按顺序，空 = 不用换）。
     *
     * 一次返回**列表**而不是单个下标：ticker 被拖慢 1.5 秒、或一轮只设了 2 段时，
     * 一次 tick 可能跨过好几个段界。逐段补发命令的代价是几条 AT，
     * 而跳过一段的代价是**那一段的 ID 一个都没收到**（而日志上看起来一切正常）。
     */
    fun segmentsToAdvance(elapsedMs: Long, lastIndex: Int): List<Int> {
        val target = indexAt(elapsedMs)
        if (target <= lastIndex) return emptyList()
        return ((lastIndex + 1)..target).toList()
    }

    /** [elapsedMs] 时刻的完整快照 */
    fun snapshot(elapsedMs: Long): Snapshot {
        val e = elapsedMs.coerceAtLeast(0L)
        val done = e >= totalMs
        val idx = indexAt(e)
        val inSeg = if (done) segmentMs else (e - idx.toLong() * segmentMs).coerceIn(0L, segmentMs)
        val remaining = if (done) 0L else (segmentMs - inSeg).coerceAtLeast(0L)
        return Snapshot(
            index = idx,
            count = count,
            remainingMs = remaining,
            totalRemainingMs = (totalMs - e).coerceAtLeast(0L),
            done = done
        )
    }
}
