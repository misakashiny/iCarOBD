package com.icar.obd.obd

/**
 * **帧率闸**（v1.20.6，P10-5）—— 主线程的保命装置。
 *
 * ## 为什么需要它（这不是理论风险）
 *
 * [FrameMonitor] 的原始分片回调走**主线程**（传输层约定：回调在主线程）。
 * 单 ID 过滤器下每秒只有约 2~11 帧，毫无压力；但**信号跨多个 CAN ID 段**时
 * [FrameMonitor.filterPlan] 会退化成"不加过滤器"（一个 `ATCRA` 只能放行一个 ID，
 * 而掩码过滤一次只能覆盖一段）—— 于是**整条总线**的帧都灌进主线程切行，
 * 实测可达 **344 帧/秒**。
 *
 * 本项目**已经因为主线程堆积 ANR 过一次**（v1.18.4 日志页），所以这里不留侥幸。
 *
 * ## 三级处理（判据是**上一个完整窗口**的行数，不是本窗口）
 *
 * | 模式 | 触发 | 调用方该做什么 |
 * |---|---|---|
 * | [Mode.NORMAL] | ≤ [softLimit] 行/秒 | 照常解析（保留"各 ID 收到多少帧"的诊断） |
 * | [Mode.THROTTLED] | > [softLimit] | **先做廉价的 ID 预筛**，只放行监听中的 ID |
 * | [Mode.OVERLOAD] | > [hardLimit] | **整块丢弃**，连切行都不做 |
 *
 * ## 为什么用"上一个窗口"而不是"本窗口"
 *
 * 本窗口的行数要等窗口结束才知道 —— 那时 CPU 已经烧掉了。用上一个窗口做判据，
 * 相当于一个 1 秒的反馈延迟：突发流量的**第一个**窗口会全额处理，
 * 之后立刻收敛。这个代价是刻意的，换来的是判定逻辑**极简且可单测**。
 *
 * ## 迟滞（hysteresis）
 *
 * 退出限流的阈值是 `softLimit × 0.6` 而不是 `softLimit` 本身 ——
 * 否则流量在阈值上下抖动时会**每秒切换一次模式**，日志和提示都会跟着抖。
 *
 * ## 纯逻辑
 *
 * 时间由调用方传入，不碰 Handler / View / Store，所以能被 JVM 单测直接压
 * （见 `FrameRateGateTest`）。[FrameMonitor] 那个 object 在 JVM 里一碰就抛 `Stub!`
 * （`Handler(Looper.getMainLooper())` 是饿汉初始化），把判定抽出来才测得到。
 */
class FrameRateGate(
    private val softLimit: Int = DEFAULT_SOFT_LIMIT,
    private val hardLimit: Int = DEFAULT_HARD_LIMIT,
    private val windowMs: Long = DEFAULT_WINDOW_MS
) {

    enum class Mode { NORMAL, THROTTLED, OVERLOAD }

    /** 当前模式。**每个分片调用一次 [evaluate]**，不要在逐行循环里反复取 */
    var mode: Mode = Mode.NORMAL
        private set

    /** 上一个完整窗口收到的行数（诊断用：这就是"帧率"） */
    var lastWindowLines: Int = 0
        private set

    /** 被 ID 预筛丢掉的行数（限流中，不匹配监听 ID） */
    var skipped: Long = 0L
        private set

    /** 被整块丢掉的行数（过载，连切行都没做） */
    var droppedOverload: Long = 0L
        private set

    private var windowStart = 0L
    private var lines = 0
    private var throttled = false

    /**
     * 评估当前窗口，返回**这一批分片**该按哪种模式处理。
     *
     * 调用方拿到结果后，对每一行调 [countLine]（O(1)），
     * 限流/过载时再调 [noteSkipped] / [noteChunkDropped] 记账。
     */
    fun evaluate(nowMs: Long): Mode {
        if (nowMs - windowStart >= windowMs) {
            lastWindowLines = lines
            lines = 0
            windowStart = nowMs
            // 迟滞：进限流的阈值是 softLimit，退出是它的 60%
            throttled = if (throttled) lastWindowLines > softLimit * EXIT_NUM / EXIT_DEN
            else lastWindowLines > softLimit
        }
        mode = when {
            lastWindowLines > hardLimit -> Mode.OVERLOAD
            throttled -> Mode.THROTTLED
            else -> Mode.NORMAL
        }
        return mode
    }

    /** 记一行（**必须每行都记**，否则帧率算不准） */
    fun countLine() {
        lines++
    }

    /** 限流中丢掉一行（ID 不在监听集合里） */
    fun noteSkipped() {
        skipped++
    }

    /** 过载时整块丢掉（[n] = 这一块里大概有多少行 —— 用字符数估也行，只用于展示） */
    fun noteChunkDropped(n: Int) {
        droppedOverload += n
    }

    /** 停掉监听时清空统计（模式也回到 NORMAL —— 下次开监听重新判定） */
    fun reset() {
        windowStart = 0L
        lines = 0
        lastWindowLines = 0
        throttled = false
        mode = Mode.NORMAL
        skipped = 0L
        droppedOverload = 0L
    }

    /** 一行诊断文本（进日志 / 提示用户） */
    fun describe(): String = when (mode) {
        Mode.NORMAL -> "帧率正常（${lastWindowLines} 行/秒）"
        Mode.THROTTLED ->
            "帧率过高（${lastWindowLines} 行/秒）→ 已按监听 ID 预筛，" +
                "跳过 ${skipped} 行"
        Mode.OVERLOAD ->
            "帧率严重过高（${lastWindowLines} 行/秒）→ 已丢弃 ${droppedOverload} 行，" +
                "信号会断续 —— 请把监听拆成两次（每次只放一个 ID 段）"
    }

    companion object {
        /**
         * 超过它就做 ID 预筛并提示用户。
         *
         * 150 是刻意取低的：单 ID 过滤器下真实帧率只有 2~11 行/秒，
         * 而"不过滤"的实车实测是 **344 行/秒** —— 中间有两个数量级的空档，
         * 阈值放在这里既不会误伤正常情况，又能在退化发生时**立刻**介入。
         */
        const val DEFAULT_SOFT_LIMIT = 150

        /**
         * 超过它就整块丢弃。
         *
         * 取 [DEFAULT_SOFT_LIMIT] 的 1.6 倍：预筛之后仍然这么高，
         * 说明**监听中的 ID 自己就很吵**（例如把 `7E8` 这种应答 ID 加进了监听），
         * 那时只能硬丢 —— 宁可信号断续，也不能 ANR。
         */
        const val DEFAULT_HARD_LIMIT = 240

        const val DEFAULT_WINDOW_MS = 1000L

        private const val EXIT_NUM = 6
        private const val EXIT_DEN = 10

        /**
         * 预筛用的行首 ID 集合（**大写**）。
         *
         * 收两种写法：`%X`（`9A`）与 `%03X`（`09A`）。
         * 实测适配器（`ATH1`）打的是 3 位，而 `CanFrame.parseLine` 也要求
         * ID token 长度 3~8 —— 也就是说 2 位那种写法**解析器自己就会丢**。
         * 这里仍然收着它，是为了万一以后放宽解析规则时，
         * **预筛不会变成新的瓶颈**（多放行一行只是多解析一次，不会漏数据）。
         */
        fun acceptIdsOf(canIds: List<Int>): List<String> =
            canIds.flatMap { listOf("%X".format(it), "%03X".format(it)) }
                .map { it.uppercase() }
                .distinct()

        /**
         * 行首的十六进制 token 是否等于 [acceptIds] 里的某一个。
         *
         * ## 安全性（这条比性能重要）
         *
         * `CanFrame.parseLine` 取的 ID **就是行首那段十六进制**（长度 3~8），
         * 而 `FrameMonitor.feedLine` 只在 `canId == 监听 ID` 时才处理。
         * 所以"行首不等于任何监听 ID"的行**无论怎么解析都不会命中** ——
         * 丢掉它与"解析完再丢掉"结果一致。`FrameRateGateTest` 钉住了这条性质。
         *
         * ## 零分配
         *
         * 这是每秒可能被调几百次的**主线程**路径：不 `substring`、不 `split`、
         * 不建临时对象（每行分配一个字符串就是在给 GC 添活）。
         *
         * [acceptIds] 为空时返回 **true**（不筛）—— 没有监听 ID 是异常状态，
         * 那时宁可全解析，也不能把唯一的证据筛掉。
         */
        fun leadingIdMatches(line: String, acceptIds: List<String>): Boolean {
            if (acceptIds.isEmpty()) return true
            var i = 0
            while (i < line.length && line[i].isWhitespace()) i++
            val start = i
            while (i < line.length && isHex(line[i])) i++
            val len = i - start
            if (len == 0) return false
            for (id in acceptIds) {
                if (id.length != len) continue
                var hit = true
                for (k in 0 until len) {
                    val c = line[start + k]
                    if (c != id[k] && c.uppercaseChar() != id[k]) {
                        hit = false
                        break
                    }
                }
                if (hit) return true
            }
            return false
        }

        private fun isHex(c: Char): Boolean =
            c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'
    }
}
