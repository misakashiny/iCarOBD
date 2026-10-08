package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import com.icar.obd.data.AppLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * CAN 总线**被动探测**（`ATMA`）。
 *
 * ## 为什么需要它
 *
 * 标准 OBD 只暴露「ECU 愿意回答的 PID」。转向灯、车门、刹车灯这类信号是
 * **模块之间的广播帧**，没有对应的 PID —— 只能靠监听总线找。这是找它们的唯一办法。
 *
 * ## 与 PID 扫描器的分工
 *
 * | | 主动/被动 | 能看到什么 |
 * |---|---|---|
 * | `PidScanner` | 主动请求 `01 0C` | ECU 愿意回答的 PID |
 * | `CanSniffer` | 被动监听 `ATMA` | 总线上**全部**帧，含广播 |
 *
 * ## 防洪水（针对 v1.3.0 那次 113 万行 / 57.9MB）
 *
 * 1. **限时**：默认 10 秒硬上限，到点自动停（[DEFAULT_DURATION_MS]，可调 3~60 秒）
 * 2. **限速**：`CanFrame.Accumulator` 只记录**变化了的**数据，重复帧只累加计数
 * 3. **限条**：原始流有界（5000 条），超出丢最旧并计数
 * 4. **不逐帧写日志**：只写汇总 —— 这是当初那场事故的直接成因
 * 5. **行缓冲有上限**：没有 `\r` 的输出不会把内存撑爆
 *
 * ## 操作顺序（顺序错了会超时）
 *
 * ```text
 * 停轮询 → ATH1（**必须在开透传之前发**）→ 开透传 → ATMA（不等响应）
 *        → 采集 N 秒 → 发任意字符停 ATMA → 关透传 → ATH0 → 恢复轮询
 * ```
 *
 * `ATH1` 必须在前：一旦开了透传，它的响应也会走 `onRawChunk`，
 * `session.raw()` 就等不到 `>` 了，必然超时。
 *
 * ## 分段轮换扫描（v1.20.10，P12-S5）—— `rotate = true`
 *
 * 一次探测只能看到"这段时间里在说话"的 ID，而 `ATMA` 的采样率摊到几十个 ID 上
 * 就还原不出闪烁类信号（实测不过滤时约 77 帧/秒）。轮换的做法是
 * **逐段换掩码过滤器**：8 段 × 10 秒，每段都是全采样率，一轮约 90 秒，
 * 汇总成「整车 ID 清单」。
 *
 * - 段号 / 时长 / 合并语义全在 [SegmentRotation] 与 [RotationPlan]（**纯逻辑，有单测**）——
 *   **不要**把这些判定搬回这个 object：它持有 `Handler(Looper.getMainLooper())`，
 *   JVM 里一碰就抛 `Stub!`，搬进来就一条都测不到。
 * - 换段由 [uiTicker] 判（主线程），因为换段要动 `acc`，而 `acc` 同时被
 *   主线程的 `onChunk` 写 —— 同一个线程里天然串行。
 * - ⚠️ **收尾时最后一段要先结算**（[finish] 里的 `closeSegment`）：
 *   `uiTicker` 一停就没人取最后一段的统计了，症状是"最后一段凭空消失"。
 * - ⚠️ **29 位 ID 一段都扫不到**：掩码 `ATCM700` 只覆盖 11 位 ID 空间
 *   （`0x000`~`0x7FF`）。这是本方案的已知边界，不是 bug。
 */
object CanSniffer {

    enum class Phase { IDLE, PREPARING, CAPTURING, FINISHING, DONE, FAILED }

    data class Status(
        val phase: Phase,
        val elapsedMs: Long = 0L,
        val frameCount: Int = 0,
        val idCount: Int = 0,
        val dropped: Int = 0,
        val message: String = "",
        /**
         * 分段轮换的进度（v1.20.10）。null = 本次不是轮换扫描。
         *
         * 放进 [Status] 而不是让界面自己去问：状态行是**唯一**的刷新入口
         * （`CanSnifferActivity.refreshStatus`），多一个数据源就多一处
         * "进度行停了但状态还在刷"的机会。
         */
        val rotation: RotationPlan.Snapshot? = null,
        /** 轮换到目前一共收到多少个不同 ID（各段并集） */
        val rotatedIdCount: Int = 0
    )

    const val DEFAULT_DURATION_MS = 10_000L
    const val MIN_DURATION_MS = 3_000L
    const val MAX_DURATION_MS = 60_000L

    /**
     * 分段轮换扫描一轮的时长（v1.20.10）：8 段 × 10 秒 = **80 秒**。
     *
     * 含换段 AT 开销实车约 90 秒（规格 §1 决策 2）。这里给的是**采集时间**，
     * 换段命令是穿插在采集里发的（不等应答），所以不会额外拉长。
     */
    val ROTATE_DURATION_MS: Long get() = SegmentRotation.ROUND_MS

    /** 普通 AT 命令的超时。`ATMA` 本身不等响应，用不到它 */
    private const val CMD_TIMEOUT = 2500L
    /** 收尾健康检查专用超时：ATMA 刚停时适配器还在吐积压缓冲，给宽一点 */
    private const val HEALTH_TIMEOUT = 2500L
    private const val UI_TICK_MS = 500L
    /** 行缓冲上限：万一输出里长时间没有换行，不能让它无限涨 */
    private const val LINE_BUF_MAX = 8192
    /** 原始行最多记几条进日志（诊断用：0 条 = 适配器根本没回字节） */
    private const val RAW_LOG_MAX = 12
    /** 结束时最多列几个 CAN ID 的汇总 */
    private const val AGG_LOG_MAX = 130

    private val main by lazy { Handler(Looper.getMainLooper()) }

    /** 收发命令要走 `session.raw()`（suspend），所以用协程而不是裸 Thread */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    var onUpdate: ((Status) -> Unit)? = null

    var status: Status = Status(Phase.IDLE)
        private set

    private var acc = CanFrame.Accumulator()
    private var startedAt = 0L
    private var durationMs = DEFAULT_DURATION_MS
    private var engineWasRunning = false

    // ---------------- 分段轮换扫描（v1.20.10，P12-S5）----------------
    //
    // 四块状态各有各的用途，**不能省任何一块**：
    //  ① `rotation`     —— "现在第几段"的判定（纯逻辑，见 SegmentRotation）
    //  ② `rotateIndex`  —— 已经**下发过命令**的那一段（-1 = 一条都还没发）
    //  ③ `segmentAccs`  —— 各段的聚合结果，收尾时合并成「整车 ID 清单」
    //  ④ `mergedAcc`    —— 跨段的并集（"已收多少 ID"这个进度靠它）
    //
    // ⚠️ ②与①必须分开：`rotation.indexAt(now)` 是"时间上该在第几段"，
    // 而命令是异步发出去的。混用一个变量时，一次被拖慢的 tick 会让
    // "该换段了"被误判成"已经换过了" —— 那一整段就白跑了。

    /** 本次是不是轮换扫描 */
    private var rotateMode = false

    /** 轮换状态机；只在 [rotateMode] 时非空 */
    private var rotation: RotationPlan? = null

    /** 已经下发过命令的段下标（-1 = 还没发过任何一段的） */
    private var rotateIndex = -1

    /** 各段的聚合（段下标 → 该段的聚合结果），收尾时合并 */
    private var segmentAccs = ArrayList<Pair<Int, List<CanFrame.Aggregate>>>()

    /** 各段的"帧数 / ID 数"（**必须在换段时立刻记**，不能收尾时再算 —— 那时 acc 已经换掉了） */
    private var segmentStats = ArrayList<SegmentRotation.SegmentStat>()

    /** 跨段并集：进度里的"已收多少 ID"、以及最终清单的来源 */
    private var mergedAcc = CanFrame.Accumulator()

    /** 轮换期间当前段的起始时刻（用来算"这一段收了多久"） */
    private var segmentStartedAt = 0L

    /** 本次探测是否真的设过 CAN 过滤器 —— 收尾要不要"重新初始化"取决于它 */
    @Volatile
    private var filterApplied = false
    /**
     * 上一次探测结束时的取值集合（CAN ID -> 出现过的不同 data）。
     * 用来做「对比基准」——判据见 [CanDiff]。
     */
    private var lastRun: Map<Int, Set<String>> = emptyMap()

    /** 再上一次，也就是差分里的**基准** */
    private var baseline: Map<Int, Set<String>> = emptyMap()
    /**
     * 收尾是否正在进行。
     *
     * 收尾里含一次「重新初始化」（要几秒钟），期间**绝不能开始新探测** ——
     * 否则它的 `ATZ`/`ATE0` 会和新的 `ATMA` 互相打架，
     * 结果是新探测只剩一两秒的数据（实车 2026-10-06：`frames=110` 而对得上的一次是 2728）。
     */
    @Volatile
    private var finishing = false
    private val lineBuf = StringBuilder()
    /** 收到的原始行总数 —— 与解析出的帧数对比，区分"没回"与"解不出" */
    private var lineCount = 0
    private var rawLogged = 0

    val running: Boolean
        get() = status.phase == Phase.PREPARING || status.phase == Phase.CAPTURING

    private val uiTicker = object : Runnable {
        override fun run() {
            if (status.phase != Phase.CAPTURING) return
            // ⚠️ 换段**必须在这里判**（而不是起一个独立的定时器）：
            // 换段要动 `acc`，而 `acc` 同时被主线程的 onChunk 写。
            // ticker 也在主线程 → 天然串行，不需要任何锁。
            // 独立定时器就变成两个线程抢同一个累加器了。
            advanceRotationIfDue()
            publish(
                status.copy(
                    elapsedMs = System.currentTimeMillis() - startedAt,
                    frameCount = acc.frameCount(),
                    idCount = acc.aggregates().size,
                    dropped = acc.dropped,
                    rotation = rotation?.snapshot(System.currentTimeMillis() - segmentStartedAt),
                    rotatedIdCount = if (rotateMode) mergedAcc.aggregates().size else 0
                )
            )
            main.postDelayed(this, UI_TICK_MS)
        }
    }

    /**
     * 到时候就换段（v1.20.10）。**只由主线程调用**（[uiTicker]）。
     *
     * ## 为什么用 `elapsed` 算，而不是累加段号
     *
     * 见 [SegmentRotation] 的说明：累加式漏一次 tick 就永久偏移。
     * 这里只做"把已经欠下的段命令补齐"，段号本身完全由时间决定。
     *
     * ## 为什么不等 `ATCF` 的应答
     *
     * 这一段本来就只有 10 秒，每条命令等一次 `OK` 会花掉 0.5~1 秒 ——
     * 8 段就是 8 秒（一轮的 10%）。而 `ATCM700`/`ATCF` 是否被接受，
     * **下一段的 ID 分布自己会说话**（这正是每段都要记日志的原因）。
     */
    private fun advanceRotationIfDue() {
        val rot = rotation ?: return
        if (status.phase != Phase.CAPTURING) return
        val elapsed = System.currentTimeMillis() - segmentStartedAt
        val due = rot.segmentsToAdvance(elapsed, rotateIndex)
        if (due.isEmpty()) return
        for (seg in due) {
            closeSegment(seg)
            val cmds = SegmentRotation.segmentCommands(seg)
            for (c in cmds) {
                // 只发不等应答：换段命令是 AT 层，适配器会照做
                runCatching { ObdController.transport.send("$c\r") }
            }
            rotateIndex = seg
            AppLog.i(
                AppLog.M_OBD, "轮换换段",
                "第 ${seg + 1}/${rot.count} 段 ${SegmentRotation.segmentRange(seg)} " +
                    "命令=${cmds.joinToString("+")} 距本轮开始=${elapsed}ms"
            )
        }
    }

    /**
     * 结束当前段：**先记账、再换累加器**（v1.20.10）。
     *
     * ## 为什么统计必须在换段那一刻取
     *
     * `acc.frameCount()` / `acc.aggregates()` 是**当前**累加器的数 ——
     * 等收尾时再回头算，那时 `acc` 早就换成别的段了（表现是"每段的帧数
     * 都是最后一段的数"，而日志看起来完全正常）。
     *
     * ## 为什么 `lineBuf` 也要清
     *
     * 换段时缓冲区里可能压着**半行**（`ATMA` 的输出不保证按行切分）。
     * 不清的话，上一段的半行会和下一段的第一块拼成一行 ——
     * 拼出来的 ID 属于哪一段都说不清，而且它**可能解析成功**，
     * 于是那份数据是脏的却看不出来。
     */
    private fun closeSegment(seg: Int) {
        val frames = acc.frameCount()
        val ids = acc.aggregates().size
        val count = rotation?.count ?: SegmentRotation.SEGMENT_COUNT
        segmentStats.add(SegmentRotation.SegmentStat(seg, frames, ids))
        // 空段也记（日志要能看出"这一段一帧都没有"），但**不进合并列表** ——
        // 空列表进去只是白跑一趟循环
        if (ids > 0) segmentAccs.add(seg to acc.aggregates())
        AppLog.i(
            AppLog.M_OBD, "轮换段结束",
            "第 ${seg + 1}/$count 段 ${SegmentRotation.segmentRange(seg)} 帧=$frames ID=$ids"
        )
        acc = CanFrame.Accumulator()
        lineBuf.setLength(0)
    }

    /**
     * 把各段合并成「整车 ID 清单」（v1.20.10）。收尾时调一次。
     *
     * 合并语义（含**段间边界**的补记）在 [SegmentRotation.merge] —— 那里有单测。
     */
    private fun mergeSegments() {
        if (segmentAccs.isEmpty()) return
        val merged = SegmentRotation.merge(segmentAccs, mergedAcc)
        acc = merged
        AppLog.i(
            AppLog.M_OBD, "轮换合并",
            "段数=${segmentStats.size} 合计帧=${merged.frameCount()} " +
                "整车ID=${merged.aggregates().size} " +
                "各段[" + segmentStats.joinToString(" ") {
                    "${it.segment + 1}:${it.frameCount}帧/${it.idCount}ID"
                } + "]"
        )
    }

    private val autoStop = Runnable { finish("到时自动停止") }

    private fun publish(s: Status) {
        status = s
        onUpdate?.invoke(s)
    }

    // ================================================================ 开始

    /**
     * 开始一次探测。
     *
     * @param duration 采集时长（单段模式用）。**轮换模式下被忽略** ——
     *   轮换的时长由 [SegmentRotation.ROUND_MS] 决定（8 段 × 10 秒），
     *   让人填"每段几秒"只会多一个能填错的地方。
     * @param filterHex 过滤器。**轮换模式下被忽略** —— 轮换自己逐段下发
     *   `ATCM700` + `ATCF<段>00`（见 [SegmentRotation.segmentCommands]）。
     * @param rotate true = 分段轮换扫描（v1.20.10，P12-S5）
     */
    fun start(
        duration: Long = DEFAULT_DURATION_MS,
        filterHex: String = "",
        rotate: Boolean = false
    ) {
        if (running) return
        if (FrameMonitor.running) {
            publish(Status(Phase.FAILED, message = "常驻监听正在运行 —— 先把它停掉再做单次探测"))
            return
        }
        if (finishing) {
            publish(Status(Phase.FAILED, message = "上一次探测还在收尾（正在重新初始化），请等状态行出现结果再试"))
            return
        }
        if (!ObdController.isConnected()) {
            publish(Status(Phase.FAILED, message = "设备未就绪，请先到「连接」页完成初始化"))
            return
        }
        rotateMode = rotate
        rotation = if (rotate) RotationPlan() else null
        durationMs = if (rotate) ROTATE_DURATION_MS
        else duration.coerceIn(MIN_DURATION_MS, MAX_DURATION_MS)
        // 把上一次的结果提升为"基准"：于是"关门探一次、开门探一次"之后，
        // 直接就能对比出是哪一位在动（这是找广播信号位唯一靠谱的办法）
        baseline = lastRun
        lastRun = emptyMap()
        acc = CanFrame.Accumulator()
        lineBuf.setLength(0)
        lineCount = 0
        rawLogged = 0
        // ---- 轮换状态清零（每趟都要清：不清的话上一趟的段号会被继承，
        //      表现是"第二趟从第 5 段开始"，而日志看起来完全正常）----
        rotateIndex = -1
        segmentAccs = ArrayList()
        segmentStats = ArrayList()
        mergedAcc = CanFrame.Accumulator()
        segmentStartedAt = 0L

        // 1) 停轮询：探测期间自己发的请求会污染观测结果
        engineWasRunning = ObdController.engine.running
        if (engineWasRunning) ObdController.engine.stop()

        publish(Status(Phase.PREPARING, message = "正在切到监听模式…"))
        AppLog.i(
            AppLog.M_OBD, "CAN 探测开始",
            "duration=${durationMs}ms kind=${ObdController.transport.kind} " +
                "filter=" + if (rotate) {
                    "分段轮换(${SegmentRotation.SEGMENT_COUNT}段)"
                } else {
                    filterHex.trim().ifBlank { "(无)" }
                }
        )

        scope.launch {
            runCatching {
                // 2) ATH1 才能看到帧来自哪个模块；**ATS1 打开空格**。
                //    两个都必须在开透传之前发。
                //
                // ⚠️ **ATS1 不是可选的**（v1.18.9 修）：初始化序列里有 `ATS0`（关空格），
                // 而 `ATMA` 输出的帧是 `7E8 06 41 0C 1A F8` 这种**空格分隔**的形状。
                // 关了空格就变成 `7E80641 0C1AF8` 一长串，`CanFrame.parseLine` 按空格切
                // token 时只切出一个 → **全部丢弃**。
                //
                // 实车 2026-10-06 正是这样：`lines=2598 parsedFrames=0` ——
                // 总线数据一直在流，只是被解析器扔了。日志里 `CAN 原始行` 一眼能看出
                // 那些行其实是完整的帧（`0FD630090001E002830` = 0FD + 8 字节）。
                // ⚠️ **每条 AT 的应答必须记进日志**（v1.19.1）。
                //
                // 实车 2026-10-06 出现过：三次探测的 AT 序列**逐字相同**，
                // 但其中两次回来的行里**没有 CAN ID**（`parsedFrames=0`），
                // 一次就正常（`parsedFrames=839`）。没有应答日志时，
                // 完全无法区分"适配器没接受 ATH1"与"接受了但输出被冲烂"。
                //
                // 三个都发：
                //  - `ATH1` 带 CAN 头 —— 没有它 `parseLine` 连 ID 都切不出来
                //  - `ATS1` 开空格   —— 没有它整帧是一长串十六进制，切不出 token
                //  - `ATL1` 开换行   —— 只靠 `\r` 断行在**过载丢字节**时更容易粘行
                // ⚠️ **先排空上一次 ATMA 的残余输出**（v1.19.6）。
                //
                // 实车 2026-10-06 两次踩到：ATMA 停止后适配器还会吐一大段缓冲，
                // 若不排空，**第一条 AT 的应答会读到上一次的残余** ——
                // 日志里表现为 `ATH1 -> STOPPED` / `ATH1 -> NO DATA`。
                // 后果不是"少一条命令"，而是**整趟探测作废**：
                // `ATH1` 没生效 → 回来的行里没有 CAN ID → `parseLine` 切不出 token
                // → `lines=3700 parsedFrames=0`（数据一直在流，只是全被扔掉）。
                runCatching { ObdController.transport.send("\r") }
                delay(300)

                // 关键命令带**重试**，只认 `OK`。
                //
                // ⚠️⚠️ **重试都失败时这趟必须作废**（v1.20.6，P10-4）。
                //
                // 原来三次都不 OK 只写一条 E 日志然后**照跑** —— 结果是
                // `ATH1 -> NO DATA` → 回来的行里没有 CAN ID → `lines=3700 parsedFrames=0`，
                // 界面上给出一份**空结果**让人猜"是不是车上没信号 / 是不是适配器不行"。
                // 实车 2026-10-06 反复踩到，每次都白花一趟时间。
                //
                // 为什么这两条是**致命**的（而不是只警告）：
                //  - `ATH1`（带 CAN 头）没有 → `CanFrame.parseLine` 连 ID 都切不出来 → 0 帧；
                //  - `ATS1`（开空格）没有 → 整帧是一长串十六进制，切不出 token → 0 帧。
                //    这是 v1.18.9 修过的同一个坑（初始化序列里的 `ATS0` 会把它关掉）。
                // 两者任一失效，**这趟的产出必然是 0 帧** —— 继续跑只会给出误导性的空结果。
                // `ATL1` 只是"更容易粘行"的稳健性设置，失败仍然继续（有 `\r` 兜底）。
                val fatal = ArrayList<String>()
                for (c in listOf("ATH1", "ATS1", "ATL1")) {
                    var resp = ""
                    for (attempt in 1..3) {
                        resp = runCatching { ObdController.session.raw(c, CMD_TIMEOUT) }.getOrNull() ?: ""
                        if (resp.contains("OK")) break
                        delay(200)
                    }
                    AppLog.i(AppLog.M_OBD, "探测准备", "$c -> ${resp.trim().take(48)}")
                    if (!resp.contains("OK")) {
                        if (c == "ATL1") {
                            AppLog.w(
                                AppLog.M_OBD, "探测准备未生效",
                                "$c 连试 3 次都不是 OK（'${resp.trim().take(30)}'）—— 继续，但过载时更容易粘行"
                            )
                        } else {
                            fatal.add(c)
                            AppLog.e(
                                AppLog.M_OBD, "探测准备失败",
                                "$c 连试 3 次都不是 OK（'${resp.trim().take(30)}'）—— 这趟没有 CAN ID，判定无效"
                            )
                        }
                    }
                }
                if (fatal.isNotEmpty()) {
                    // 收尾要做的两件事：把轮询还回去 + 说清"重跑一次"。
                    // ⚠️ 不走 `finish()` —— 它含一次健康检查与 ATZ 重初始化，
                    // 而这趟**根本没开过透传**（rawMode 一直是 false），没有什么要复原的。
                    main.post {
                        if (engineWasRunning) ObdController.engine.start()
                        publish(
                            Status(
                                Phase.FAILED,
                                message = "准备失败，请重跑一次（${fatal.joinToString(" / ")} 连续 3 次没有回 OK）\n" +
                                    "这趟的帧里不会有 CAN ID，继续跑只会得到一份空结果。"
                            )
                        )
                    }
                    return@launch
                }
            }.onFailure {
                main.post { finish("启动失败：${it.message}") }
                return@launch
            }
                // 5) CAN 接收过滤器（v1.19.3）—— **这是"能不能看清闪烁类信号"的关键。**
                //
                // 不过滤时克隆版只漏出约 77 帧/秒，摊到 80 个 ID 上就是**每个 ID 每秒 1 帧**；
                // 而转向灯约 1.4 Hz，在这个采样密度下**还原不出来**（实车 2026-10-06 四组
                // 对照实验全部无效，根因就在这里）。过滤到少数几个 ID 之后，
                // 同样的带宽全给它们，采样率立刻够用。
                //
                // ⚠️ **过滤器会连带挡住正常 OBD 的应答**（正常请求回 `7E8`，
                //    而过滤器只放行指定 ID）—— 实车踩过：探针设了 `ATCRA228` 之后，
                //    紧接着 11 条 `01 xx` 全部「超时无响应」，看起来像链路死了。
                //    所以 `finish()` 里**必须**清掉（`ATAR`）。
                val filt = filterHex.trim()
                if (rotate) {
                    // ---- 分段轮换（v1.20.10，P12-S5）----
                    //
                    // ⚠️ 掩码 + 过滤**必须成对**：
                    //  - `ATCM700` 只看 CAN ID 的高三位；
                    //  - `ATCF<段>00` 放行那三位等于段号的那 256 个 ID。
                    //
                    // ⚠️⚠️ **`ATCF000` 是全总线，不是"0x0xx 段"**（规格 §7 陷阱 2 的同类坑）。
                    // 单独发 `ATCF000` 会放行整条总线（帧数虚高、ID 混段）；
                    // 在 `ATCM700` 掩码之下它才等于"第 0 段"。
                    // 所以 `segmentCommands(0)` 返回的是**两条**，不能只发后一条。
                    //
                    // 第一段在这里发（其余段由 [uiTicker] 到时下发）；
                    // 不发的话第 0 段会跑在全总线上 —— 那正是最容易被误读成
                    // "第 0 段 ID 特别多"的一种假象。
                    filterApplied = true
                    for (c in SegmentRotation.segmentCommands(0)) {
                        val rr = runCatching { ObdController.session.raw(c, CMD_TIMEOUT) }.getOrNull()
                        AppLog.i(AppLog.M_OBD, "探测准备", "$c -> ${(rr ?: "<异常>").trim().take(48)}")
                    }
                    rotateIndex = 0
                } else if (filt.isNotBlank()) {
                    // 两种写法（v1.19.4）：
                    //   `228`               -> 单个 ID，发 `ATCRA228`
                    //   `ATCM700+ATCF400`   -> 原样发多条 AT（掩码过滤**一整段**，如 0x400~0x4FF）
                    //
                    // 掩码版是效率关键：`ATCRA` 一次只放行**一个** ID，而候选有约 80 个；
                    // 掩码版一趟覆盖 256 个 ID，16 趟就能扫完整个总线，且每趟都是全采样率。
                    // 实车已确认克隆版接受这两条命令：`ATCRA228 -> OK`、`ATCM700 -> OK`。
                    val cmds = if (filt.startsWith("AT", ignoreCase = true)) {
                        filt.split('+', ';').map { it.trim() }.filter { it.isNotEmpty() }
                    } else {
                        listOf("ATCRA${filt.uppercase()}")
                    }
                    filterApplied = true
                    for (c in cmds) {
                        val rr = runCatching { ObdController.session.raw(c, CMD_TIMEOUT) }.getOrNull()
                        AppLog.i(AppLog.M_OBD, "探测准备", "$c -> ${(rr ?: "<异常>").trim().take(48)}")
                    }
                }


            // 3) 开透传，再发 ATMA —— 它是持续流，不能等响应
            ObdController.rawChunkListener = { chunk -> onChunk(chunk) }
            ObdController.transport.rawMode = true
            runCatching { ObdController.transport.send("ATMA\r") }

            startedAt = System.currentTimeMillis()
            // 轮换：第 0 段的计时从**真正开始采集**那一刻起（不是从 start() 起）——
            // 用 start() 起算的话，"准备"花掉的 1~2 秒会算进第 0 段，
            // 于是第 0 段实际只采了 8 秒，而日志写着 10 秒
            segmentStartedAt = startedAt
            main.post {
                publish(Status(Phase.CAPTURING, message = "监听中…"))
                main.postDelayed(uiTicker, UI_TICK_MS)
                main.postDelayed(autoStop, durationMs)
            }
        }
    }

    /** 当前累积器的结果折成「CAN ID -> 出现过的不同 data」 */
    fun snapshot(): Map<Int, Set<String>> =
        acc.aggregates().associate { it.canId to it.values.toSet() }

    /**
     * 与**基准**的逐位差分。基准 = 上一次探测，当前 = 本次探测。
     *
     * 所以正确用法是**连跑两次**（关门 / 开门），第二次收尾后才有结果。
     */
    fun diffAgainstBaseline(): List<CanDiff.BitChange> =
        if (baseline.isEmpty() || lastRun.isEmpty()) emptyList()
        else CanDiff.diff(baseline, lastRun)

    fun stop() {
        if (running) finish("手动停止")
    }

    // ================================================================ 收数据

    private fun onChunk(chunk: String) {
        if (status.phase != Phase.CAPTURING && status.phase != Phase.PREPARING) return
        synchronized(lineBuf) {
            lineBuf.append(chunk)
            var cut = indexOfBreak()
            while (cut >= 0) {
                val line = lineBuf.substring(0, cut)
                lineBuf.delete(0, cut + 1)
                if (line.isNotBlank()) {
                    val t = line.trim()
                    lineCount++
                    // ⚠️ **有界地**记原始行（最多 RAW_LOG_MAX 条）。
                    // 没有它就无法区分「适配器一个字节都没回」（ATMA 不被支持）
                    // 与「回了但解析不出帧」—— 实车 frames=0 时正卡在这个岔路口。
                    if (rawLogged < RAW_LOG_MAX) {
                        AppLog.i(AppLog.M_OBD, "CAN 原始行", t.take(140))
                        rawLogged++
                    }
                    acc.feedLine(t, System.currentTimeMillis())
                }
                cut = indexOfBreak()
            }
            if (lineBuf.length > LINE_BUF_MAX) lineBuf.setLength(0)
        }
    }

    private fun indexOfBreak(): Int {
        for (i in lineBuf.indices) {
            val c = lineBuf[i]
            if (c == '\r' || c == '\n') return i
        }
        return -1
    }

    // ================================================================ 收尾

    private fun finish(reason: String) {

        // 重入保护：到时自动停止与手动停止会**先后各触发一次**，

        // 以前会跑两遍收尾（两遍重新初始化叠在一起，日志里能看到两条「探测结束」）。

        if (finishing) {

            AppLog.w(AppLog.M_OBD, "忽略重复的收尾", "reason=$reason")

            return

        }

        finishing = true
        // ⚠️ **最后一段要先结算**（v1.20.10）：`uiTicker` 只在 CAPTURING 时跑，
        // 而它一停，"最后一段的帧数/ID 数"就再也没人去取了 ——
        // 表现是整车清单里**少了最后一段**（`0x700` 那一整段凭空消失），
        // 而日志上看起来一切正常。这里在切 phase 之前先结账。
        //
        // 刻意**不调 `advanceRotationIfDue()`**：那会往适配器补发 AT 命令，
        // 而此刻正是"停 ATMA + 重新初始化"最不能被打扰的窗口。
        if (rotateMode && status.phase == Phase.CAPTURING) {
            if (rotateIndex >= 0) closeSegment(rotateIndex)
            mergeSegments()
        }
        main.removeCallbacks(uiTicker)
        main.removeCallbacks(autoStop)
        publish(status.copy(phase = Phase.FINISHING, message = "正在收尾…"))

        scope.launch {
            // 4) 停 ATMA：向适配器发任意字符即可中断监听
            runCatching { ObdController.transport.send("\r") }
            delay(200)
            ObdController.transport.rawMode = false
            ObdController.rawChunkListener = null
            // 让 ATMA 的积压输出先吐完，否则后面命令的应答会被埋在里头
            delay(400)
            // ⚠️⚠️ **CAN 过滤器必须清掉** —— 忘了清就表现为「链路突然全是超时」，
            // 而且**从界面上完全看不出原因**（实车 2026-10-06 踩过两次）。
            //
            // 试过但**没用**的三条（都回 `OK`，却清不掉）：
            //   `ATAR`（Automatic Receive）、`ATCM000`、`ATCF000`
            // 实车证据：三条都 OK 之后，紧接着 12 条 `01 xx` 仍然**全部超时**。
            // 原因是 AT 命令由适配器内部处理，而 `01 xx` 要等 CAN 应答 —— 正好被过滤器挡住，
            // 所以"命令成功"和"过滤真的关了"是两件事。
            //
            // **唯一确定有效的是 `ATZ` 全复位**（也是「连接」页初始化的第一步）。
            // 所以：**用过过滤器就直接重新初始化一次**，把状态一次性搞定。
            if (filterApplied) {
                filterApplied = false
                val r = runCatching { ObdController.initializeAndStart() }.getOrNull()
                AppLog.i(
                    AppLog.M_OBD, "探测收尾重新初始化",
                    "本次用过 CAN 过滤器，靠 ATZ 全复位清理（ok=${r?.ok}）"
                )
            } else {
                // 没用过滤器：只还原显示设置
                runCatching { ObdController.session.raw("ATH0", CMD_TIMEOUT) }
                runCatching { ObdController.session.raw("ATS0", CMD_TIMEOUT) }
                runCatching { ObdController.session.raw("ATL0", CMD_TIMEOUT) }
            }

            // **健康检查排到最后**，而且给足超时。
            // 早先把它排在前面是错的：ATMA 刚停时适配器还在吐积压的缓冲，
            // 应答会被埋在里头 —— 实车 2026-10-06 就是这样让健康检查误报"无应答"的
            // （日志里能看到 `0100` 之后紧跟着一长串监视输出、末尾才是 `STOPPED`）。
            delay(300)
            val hc = runCatching { ObdController.session.raw("0100", HEALTH_TIMEOUT) }.getOrNull() ?: ""
            val healthy = hc.contains("4100")
            AppLog.i(
                AppLog.M_OBD, "探测收尾健康检查",
                if (healthy) "0100 有应答，链路正常" else "⚠️ 0100 无有效应答（'${hc.trim().take(40)}'）"
            )
            if (!healthy) {
                AppLog.e(
                    AppLog.M_OBD, "链路可能没恢复",
                    "请到「连接」页重新初始化一次（ATZ 会复位一切）"
                )
            }

            // 5) 恢复轮询
            if (engineWasRunning) ObdController.engine.start()

            val frames = acc.frameCount()
            val ids = acc.aggregates().size
            // 轮换的收尾话术要说清"这是一份整车清单"——否则用户会以为
            // 它和单次探测是一回事（单次探测只是"这段时间里在说话的 ID"）
            val msg = if (rotateMode) {
                "$reason · 分段轮换完成（${SegmentRotation.SEGMENT_COUNT} 段 × " +
                    "${SegmentRotation.SEGMENT_MS / 1000} 秒）\n" +
                    "整车 ID 清单：$ids 个 ID / $frames 帧。" +
                    "下面按出现次数排序，**按变化次数**排的那一份更值得看。"
            } else {
                "$reason · 共 $frames 帧 / $ids 个 ID"
            }
            main.post {
                publish(
                    Status(
                        Phase.DONE,
                        elapsedMs = System.currentTimeMillis() - startedAt,
                        frameCount = frames,
                        idCount = ids,
                        dropped = acc.dropped,
                        message = msg,
                        rotation = rotation?.snapshot(System.currentTimeMillis() - segmentStartedAt),
                        rotatedIdCount = if (rotateMode) ids else 0
                    )
                )
            }
            // 只写汇总，**绝不逐帧写日志**
            AppLog.i(
                AppLog.M_OBD, "CAN 探测结束",
                "frames=$frames ids=$ids dropped=${acc.dropped} reason=$reason" +
                    if (rotateMode) " 模式=分段轮换 段数=${segmentStats.size}" else ""
            )
            // ---- 与基准的逐位差分（v1.19.14）----
            // 判据见 [CanDiff]：**某一位从"恒定"变成"在变"，就是这次操作把它拨动的**。
            // 用"状态"比而不是"两个值 XOR"，是因为单次采样会撞相位
            // （转向灯 1.4 Hz，采到亮还是暗是掷硬币）。
            lastRun = snapshot()
            val bits = diffAgainstBaseline()
            if (bits.isEmpty()) {
                AppLog.i(AppLog.M_OBD, "CAN 差分", "与基准无差异（或还没连跑两次）")
            } else {
                AppLog.i(AppLog.M_OBD, "CAN 差分", "共 ${bits.size} 处，下面是前 20 处")
                bits.take(20).forEach { b ->
                    AppLog.i(
                        AppLog.M_OBD, "CAN 差分位",
                        b.describe() + " 公式=" + b.formula() +
                            (if (b.isPrimary()) "   <== 这次操作引起的" else "")
                    )
                }
            }

            // 收尾彻底结束，可以开始下一次了
            finishing = false
            AppLog.i(AppLog.M_OBD, "CAN 探测原始行", "lines=$lineCount parsedFrames=$frames")
            // 把 ID 汇总也写进日志 —— 否则想知道"探到了什么"只能导出 CSV 再传文件
            val aggs = acc.aggregates()
            aggs.take(AGG_LOG_MAX).forEach { a ->
                AppLog.i(
                    AppLog.M_OBD, "CAN ID",
                    "id=${a.idHex()}${if (a.isExtended) "(29位)" else ""} " +
                        "count=${a.count} changed=${a.changed} last=${a.lastData}"
                )
            }
            if (aggs.size > AGG_LOG_MAX) {
                AppLog.i(AppLog.M_OBD, "CAN ID", "（还有 ${aggs.size - AGG_LOG_MAX} 个未列出）")
            }
            // 再按「变化次数」排一次。
            // 闪烁类信号（转向灯）的特征是 **count 不高但 changed ≈ 闪烁次数 × 2** ——
            // 按 count 排序会把它埋在一堆高频心跳帧后面，按 changed 排才浮得上来。
            // 关灯那一次它应当几乎不变（changed ≈ 1）。
            // **每个 ID 出现过的不同 data 值**（v1.19.8）。
            // 这是分辨"跳动的到底是哪一位"的唯一手段：`last` 只是最后一帧，
            // 周期信号很容易正好停在暗相位（实车 09A 左转/右转两次的 last 都是 00）。
            aggs.filter { it.values.size >= 2 }.forEach { a ->
                AppLog.i(
                    AppLog.M_OBD, "CAN 取值集合",
                    "id=${a.idHex()} count=${a.count} 不同值=${a.values.size} " +
                        "[" + a.values.joinToString(" | ") + "]"
                )
            }
            AppLog.i(AppLog.M_OBD, "CAN changed 排序", "top 20")
            aggs.sortedByDescending { it.changed }.take(20).forEach { a ->
                AppLog.i(
                    AppLog.M_OBD, "CAN ID(changed)",
                    "id=${a.idHex()} count=${a.count} changed=${a.changed} last=${a.lastData}"
                )
            }
        }
    }

    // ================================================================ 结果

    fun aggregates(): List<CanFrame.Aggregate> = acc.aggregates()

    fun rawFrames(): List<CanFrame.RawFrame> = acc.rawFrames()

    /** 聚合 CSV：一眼看出哪些 ID 在周期性广播 */
    fun aggregateCsv(): String = acc.aggregateCsv()

    /** 原始帧 CSV：信息全，文件大得多 */
    fun rawCsv(): String = acc.rawCsv()

    /** 清空上次结果（不清就一直是上一轮的数据） */
    fun reset() {
        // ⚠️ 这里**不**动 baseline/lastRun：清空只是把"当前这一轮"扔掉。
        // 若在两次对照之间按了清空就把基准也换掉，"对比基准"会失效。
        // （基准的提升只发生在 start() 里。）
        acc = CanFrame.Accumulator()
        // 轮换的账也一起清：不清的话下一次单段探测的 DONE 状态里
        // 会带着上一轮轮换的进度快照（界面显示"第 3/8 段"而本次根本不是轮换）
        rotateMode = false
        rotation = null
        rotateIndex = -1
        segmentAccs = ArrayList()
        segmentStats = ArrayList()
        mergedAcc = CanFrame.Accumulator()
        publish(Status(Phase.IDLE))
    }
}
