package com.icar.obd.obd

import com.icar.obd.data.AppLog
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext

/**
 * PID 扫描器（**限流优先**，不是无脑遍历）。
 *
 * 为什么不能无脑扫：ECU 对每个未定义 PID 的响应可能是超时（约 1~2 秒），
 * 盲目扫 Mode 22 全地址空间会产生上万次请求，把总线打满、让其它模块通信延迟，
 * 极端情况下会写入故障码。
 *
 * 因此本实现强制具备：
 *  - **请求频率限制**（intervalMs，默认 150ms，两条请求之间强制间隔）
 *  - **单条超时**（timeoutMs）
 *  - **重试次数**（retry，默认 1，避免偶发丢包被误判为不支持）
 *  - **黑名单**（blacklist，命中的 PID 直接跳过）
 *  - **危险模式拦截**（Mode 02/03/04/06/08 等会改变 ECU 状态，默认拒绝）
 *  - **总量上限**（maxRequests，防止参数填错时跑出天文数字）
 *  - **Mode 01/09 先用支持位图**：只扫车厂声明支持的 PID，请求量可下降一个数量级
 *  - **主动取消**：随时 stop()，不会留下悬挂请求
 *
 * 使用前必须由 UI 收集用户确认（见 ScannerActivity）。
 */
class PidScanner(private val session: ElmSession) {

    companion object {
        /**
         * 把一次扫描拼成**自包含的文本报告**（参数 + 命中明细 + 界面日志）。
         *
         * 抽成纯函数是为了**可测**：格式这种东西最容易"看起来对"，
         * 而它是要交给别人（或下一个智能体）读的 —— **缺字段就是白导一次**。
         *
         * @param timestamp 由调用方传入。纯函数不碰系统时间，测试才能断言确定的内容。
         */
        fun report(
            cfg: Config?,
            hits: List<Hit>,
            logLines: List<String>,
            timestamp: String
        ): String {
            val sb = StringBuilder()
            sb.append("iCar OBD · PID 扫描结果\n")
            sb.append("时间: $timestamp\n")
            if (cfg != null) {
                val width = if (cfg.mode == "01" || cfg.mode == "02" || cfg.mode == "09") 2 else 4
                sb.append("模式: ${cfg.mode}\n")
                sb.append("范围: ${hex(cfg.from, width)} ~ ${hex(cfg.to, width)}\n")
                sb.append("参数: 间隔=${cfg.intervalMs}ms 超时=${cfg.timeoutMs}ms 重试=${cfg.retry}")
                    .append(" 上限=${cfg.maxRequests} 学习采样=${cfg.learnSamples}")
                    .append(" 支持位图=${cfg.useSupportedBitmap}\n")
                if (cfg.blacklist.isNotEmpty()) {
                    sb.append("黑名单: ${cfg.blacklist.joinToString(",")}\n")
                }
            }
            sb.append("命中: ${hits.size} 条\n\n")
            sb.append("── 命中明细 ──\n")
            hits.forEachIndexed { i, h ->
                sb.append("[${i + 1}] Mode ${h.mode} PID ${h.pid}\n")
                sb.append("    请求: ${h.request}\n")
                sb.append("    数据: ${h.dataHex}\n")
                sb.append("    建议公式: ${h.suggestedFormula}")
                h.previewValue?.let { sb.append("  （预览值 $it，仅供参考）") }
                sb.append("\n")
                if (h.learnedMin != null || h.learnedMax != null) {
                    sb.append("    学习量程: ${h.learnedMin ?: "-"} ~ ${h.learnedMax ?: "-"}\n")
                }
                sb.append("    原始: ${h.raw.take(120)}\n")
            }
            sb.append("\n── 界面日志（${logLines.size} 条）──\n")
            logLines.forEach { sb.append(it).append("\n") }
            return sb.toString()
        }

        private fun hex(v: Int, w: Int) = v.toString(16).uppercase().padStart(w, '0')

        /**
         * 支持位图链的**最后一个块**。
         *
         * 位图链是 `01 00 → 01 20 → 01 40 → 01 60 → 01 80 → 01 A0 → 01 C0`。
         *
         * ⚠️ **必须是 `0xC0`**（v1.18.0 修，原来写 `0x60`）——
         * **挡位 `01 A4` 和总里程 `01 A6` 正好在 A1~C0 段**，
         * 停在 0x60 就永远枚举不到它们。
         *
         * 这个教训来自一个独立验证过的马自达项目：它把挡位当成"只有 Mode 22 才有"，
         * 其实一直在标准空间的 `01 A4` 里。
         *
         * Mode 09 的块语义不同（02/04/06/08…），维持 0x40。
         */
        fun maxSupportBlock(mode: String): Int = if (mode == "09") 0x40 else 0xC0

        /**
         * 把一个支持位图块（4 字节）解成 **PID 集合**。纯函数，便于单测钉住。
         *
         * ## ⚠️ 第一位对应的是 `block + 1`，不是 `block`（v1.18.7 修）
         *
         * `01 00` 响应的**最高位**代表 PID **`01`**，依次到 `20` ——
         * 也就是「块内第 i 位 → PID `block + 1 + i`」。
         *
         * 原实现写的是 `block + i`，**整条链每个块都少加 1**，于是扫描器
         * 去问的是"每个被声明支持的前一个 PID"：
         *
         * | 位图位 | 应用算出的 i | 应用去问 | 真正的 PID |
         * |---|---|---|---|
         * | `A8` b7,b5,b3 | 16,18,20 | `01 10` `01 12` `01 14` | `01 11` `01 13` `01 15` |
         * | `13` b4,b1,b0 | 27,30,31 | `01 1B` `01 1E` `01 1F` | `01 1C` `01 1F` `01 20` |
         * | `14`（A0 块） | 3,5 | `01 A3` `01 A5` | **`01 A4` `01 A6`** |
         *
         * 实车对照（2026-10-06 阿特兹）：扫描窗口里扫描器实际发出的正是
         * `01 00` `01 12` `01 1B` `01 1E` —— 与"少加 1"的预测**逐字吻合**。
         *
         * 后果有两个，而且都很能骗人：
         *  - **车厂声明了的 PID 没被问**（`11`/`13`/`15`/`1C`）→ 看起来像"车不支持"
         *  - **去问的那个 PID 碰巧也能答**（`10`/`12`/`1B`）→ 看起来像"位图漏报"
         *
         * 所以 v1.18.4 里"支持位图在漏报 11/21/A6"那条结论是**错的** ——
         * 位图没漏，是枚举偏了一位。
         */
        fun decodeSupportBitmap(block: Int, data: ByteArray): Set<Int> {
            val out = HashSet<Int>()
            for (i in 0 until 32) {
                val byteIdx = i / 8
                if (byteIdx >= data.size) break
                val bit = 7 - (i % 8)
                if ((data[byteIdx].toInt() shr bit) and 1 == 1) out.add(block + 1 + i)
            }
            return out
        }
    }

    data class Config(
        /** OBD 模式：01 / 09 / 21 / 22 ... */
        val mode: String = "01",
        /** 起始 PID（十进制） */
        val from: Int = 0x00,
        /** 结束 PID（十进制，含） */
        val to: Int = 0x60,
        /** 两条请求之间的强制间隔（限流） */
        val intervalMs: Long = 150,
        /** 单条请求超时 */
        val timeoutMs: Long = 1500,
        /** 失败重试次数（总尝试 = retry + 1） */
        val retry: Int = 1,
        /** 黑名单，元素形如 "01:0C"（大写） */
        val blacklist: Set<String> = emptySet(),
        /** Mode 01/09 是否先用支持位图收敛范围 */
        val useSupportedBitmap: Boolean = true,
        /** 请求总数上限 */
        val maxRequests: Int = 400,
        /** 命中后额外采样次数，用于学习 min/max（0 = 关闭，默认关闭以省总线） */
        val learnSamples: Int = 0,
        /** 学习采样的间隔 */
        val learnIntervalMs: Long = 300
    )

    data class Hit(
        val mode: String,
        val pid: String,
        val request: String,
        val raw: String,
        val dataHex: String,
        /** 依据数据长度的建议公式，供编辑器预填 */
        val suggestedFormula: String,
        /** 用建议公式算出的值（仅供参考，不保证物理意义正确） */
        val previewValue: Float?,
        /** 学习采样得到的最小值（learnSamples > 0 时有效） */
        val learnedMin: Float? = null,
        val learnedMax: Float? = null
    )

    @Volatile
    private var cancelled = false

    fun cancel() {
        cancelled = true
        AppLog.i(AppLog.M_SCAN, "扫描被取消")
    }

    /**
     * 执行扫描。
     * @param onProgress (已完成数, 总数, 最新命中) —— 在调用协程里回调
     */
    suspend fun scan(
        cfg: Config,
        onProgress: suspend (done: Int, total: Int, hit: Hit?) -> Unit
    ): List<Hit> {
        cancelled = false
        val mode = cfg.mode.trim().uppercase()

        if (ObdProtocol.isDangerous(mode)) {
            AppLog.e(AppLog.M_SCAN, "拒绝扫描危险模式", "mode=$mode")
            throw IllegalArgumentException("模式 $mode 会改变 ECU 状态，已拒绝扫描")
        }

        val width = if (mode == "01" || mode == "02" || mode == "09") 2 else 4
        val base = if (mode == "01" || mode == "09") mode else "22"

        // ---- 1) 候选集合 ----
        var candidates: List<Int> = (cfg.from..cfg.to).toList()

        if (cfg.useSupportedBitmap && (mode == "01" || mode == "09")) {
            val supported = querySupportedPids(mode, cfg)
            if (supported.isNotEmpty()) {
                val inRange = supported.filter { it in cfg.from..cfg.to }
                AppLog.i(
                    AppLog.M_SCAN, "支持位图收敛扫描范围",
                    "mode=$mode supported=${supported.size} inRange=${inRange.size}"
                )
                candidates = inRange
            } else {
                AppLog.w(AppLog.M_SCAN, "支持位图无结果，退回范围扫描", "mode=$mode")
            }
        }

        // 黑名单过滤
        val filtered = candidates.filter { pid ->
            val key = "$base:${pid.toString(16).uppercase().padStart(width, '0')}"
            key !in cfg.blacklist
        }
        val skipped = candidates.size - filtered.size
        if (skipped > 0) AppLog.i(AppLog.M_SCAN, "黑名单跳过", "count=$skipped")

        val total = filtered.size.coerceAtMost(cfg.maxRequests)
        if (filtered.size > cfg.maxRequests) {
            AppLog.w(
                AppLog.M_SCAN, "候选数超过上限，已截断",
                "candidates=${filtered.size} max=${cfg.maxRequests}"
            )
        }

        AppLog.i(
            AppLog.M_SCAN, "开始扫描",
            "mode=$mode from=${hex(cfg.from, width)} to=${hex(cfg.to, width)} total=$total " +
                "interval=${cfg.intervalMs}ms timeout=${cfg.timeoutMs}ms retry=${cfg.retry}"
        )

        val hits = ArrayList<Hit>()
        var done = 0

        for (pid in filtered.take(total)) {
            if (cancelled || !coroutineContext.isActive) break

            val pidHex = pid.toString(16).uppercase().padStart(width, '0')
            val req = "$base $pidHex"
            val key = "$base:$pidHex"

            val raw = requestWithRetry(req, cfg)
            done++

            val hit = parseHit(mode, pidHex, req, raw)
            if (hit != null) {
                val learned = if (cfg.learnSamples > 0) learnRange(req, hit, cfg) else null
                val finalHit = if (learned != null) {
                    hit.copy(learnedMin = learned.first, learnedMax = learned.second)
                } else hit
                hits.add(finalHit)
                AppLog.i(
                    AppLog.M_SCAN, "命中",
                    "req=$req raw=${raw.take(60)} data=${finalHit.dataHex} " +
                        (if (learned != null) "min=${learned.first} max=${learned.second}" else "")
                )
                onProgress(done, total, finalHit)
            } else {
                onProgress(done, total, null)
            }

            // 限流：这里是整个扫描器「不伤总线」的核心
            delay(cfg.intervalMs)
        }

        AppLog.i(AppLog.M_SCAN, "扫描结束", "mode=$mode done=$done hits=${hits.size} cancelled=$cancelled")
        return hits
    }

    // ---------------------------------------------------------------- 内部

    private suspend fun requestWithRetry(req: String, cfg: Config): String {
        var last = ""
        repeat(cfg.retry + 1) { attempt ->
            last = session.raw(req, cfg.timeoutMs)
            if (!ObdProtocol.isError(last) && ObdProtocol.hexBytes(ObdProtocol.stripNoise(last)).isNotEmpty()) {
                return last
            }
            if (attempt < cfg.retry) delay(cfg.intervalMs)
        }
        return last
    }

    private fun parseHit(mode: String, pidHex: String, req: String, raw: String): Hit? {
        if (ObdProtocol.isError(raw)) return null
        val modeInt = mode.toIntOrNull(16) ?: return null
        val data = ObdProtocol.extractData(raw, modeInt, pidHex) ?: return null
        if (data.isEmpty()) return null

        val hex = data.joinToString(" ") { String.format("%02X", it.toInt() and 0xFF) }
        val formula = suggestFormula(data.size)
        val preview = runCatching {
            com.icar.obd.data.Formula.eval(formula, data).toFloat()
        }.getOrNull()

        return Hit(mode, pidHex, req, raw.trim(), hex, formula, preview)
    }

    /** 依据数据字节数给一个「最可能」的骨架公式，用户必须自行判断物理含义 */
    private fun suggestFormula(n: Int): String = when (n) {
        0 -> ""
        1 -> "A"
        2 -> "(A*256)+B"
        3 -> "(A*65536)+(B*256)+C"
        else -> "(A*256)+B"
    }

    private suspend fun learnRange(req: String, hit: Hit, cfg: Config): Pair<Float, Float>? {
        var min = Float.MAX_VALUE
        var max = -Float.MAX_VALUE
        var ok = 0
        repeat(cfg.learnSamples) {
            if (cancelled) return@repeat
            delay(cfg.learnIntervalMs)
            val raw = requestWithRetry(req, cfg)
            val data = ObdProtocol.extractData(
                raw, hit.mode.toIntOrNull(16) ?: return@repeat, hit.pid
            ) ?: return@repeat
            if (data.isEmpty()) return@repeat
            val v = runCatching { com.icar.obd.data.Formula.eval(hit.suggestedFormula, data).toFloat() }
                .getOrNull() ?: return@repeat
            min = kotlin.math.min(min, v); max = kotlin.math.max(max, v); ok++
        }
        return if (ok > 0) min to max else null
    }

    /**
     * Mode 01/09 支持位图：0100/0120/0140/0160 各返回 4 字节 = 32 个 PID 的支持位。
     * 只在位为 1 时继续扫描，这是把请求量从 ~96 次降到 ~30 次的关键。
     */
    private suspend fun querySupportedPids(mode: String, cfg: Config): Set<Int> {
        val out = HashSet<Int>()
        // ⚠️ **必须走到 `01 C0`，不能停在 `01 60`**（v1.18.0 修）。
        //
        // 位图链是 `01 00 → 01 20 → 01 40 → 01 60 → 01 80 → 01 A0 → 01 C0`。
        // 原来 `maxBlock = 0x60`，于是**永远枚举不到 A1~C0 段** ——
        // 而**挡位 `01 A4` 和总里程 `01 A6` 恰好就在那一层**。
        //
        // 这条是从一个独立验证过的马自达项目学到的（drewid74/2024-nd3-mazda-obdii），
        // 它的原话值得抄在这里：
        //   "A Mode 22 NACK means that module address is dead, **not** that the
        //    signal is unavailable... Always probe 01 00 → … → 01 C0 and enumerate
        //    what the car actually advertises **before** concluding anything is out of scope."
        // 那个项目自己也栽过：挡位被当成"Mode 22 才有"，其实一直在 `01 A4` 里。
        val maxBlock = maxSupportBlock(mode)
        val modeInt = mode.toIntOrNull(16) ?: return out
        var block = 0
        while (block <= maxBlock) {
            if (cancelled) break
            val baseHex = block.toString(16).uppercase().padStart(2, '0')
            val req = "$mode $baseHex"
            val raw = requestWithRetry(req, cfg.copy(retry = 1, timeoutMs = 2500))
            delay(cfg.intervalMs)

            // ⚠️⚠️ **必须取所有 ECU 的应答取并集，且不能用某一家的下一块位提前退出。**
            //
            // 2026-10-06 实车抓到（阿特兹 · 小米平板 5）：
            // 这台车对每个位图块回**两份应答**（两个模块），而它们对
            // 「还有下一块」（byte3 的 bit0）**判断是相反的**：
            //
            //     01 40 -> 41 40 FE D0 8C 81   ← 模块1：0x81，bit0=1，「还有」
            //              41 40 C0 80 00 00   ← 模块2：0x00，bit0=0，「没有了」
            //
            // 而这两份的**先后顺序会在两次运行之间变**：
            //
            //     11:56  01 40 -> FE D0 8C 81 先到 → 继续 → supported=57（含 A1~C0）
            //     12:34  01 40 -> C0 80 00 00 先到 → 断在 0x40 → supported=16
            //
            // 于是「这台车支持什么」**取决于哪个模块的应答先到**。12:34 那次
            // `0x61`~`0xC0` 整段不可见 —— 而**挡位 `A4`、总里程 `A6` 就在那一段**。
            // v1.18.0 把 `maxBlock` 从 `0x60` 提到 `0xC0` 只治了「上限」，没治这个提前退出。
            //
            // 代价极小：mode 01 全链只有 7 个请求（00/20/40/60/80/A0/C0）。
            // **确定性比省两三个请求重要。**
            var anyResponded = false
            val seen = HashSet<Int>()
            var ecu = 0
            // 实车见过 2 个模块应答；给到 4 留余量。不足时 extractData 返回 null，循环即止
            while (ecu < 4) {
                val data = ObdProtocol.extractData(raw, modeInt, baseHex, ecu) ?: break
                // 只有前 4 字节是这一块的位图；别把后一个模块的字节也算进来
                if (data.size < 4) break
                anyResponded = true
                // ⚠️ 走纯函数解位图：块内第 i 位对应 PID `block + 1 + i`
                //（原来这里写 `block + i`，整条链少加 1 —— 见 decodeSupportBitmap 的说明）
                seen.addAll(decodeSupportBitmap(block, data.copyOf(4)))
                ecu++
            }
            val added = seen.size
            out.addAll(seen)
            // 这一块**一个应答都没有** → 后面几块也不会有
            if (!anyResponded) break
            if (added > 0) {
                AppLog.d(AppLog.M_SCAN, "位图块", "block=$baseHex ecu=${ecu} PIDs=$added")
            }
            block += 0x20
        }
        return out
    }

    private fun hex(v: Int, width: Int) = v.toString(16).uppercase().padStart(width, '0')

    /** 生成扫描用黑名单默认值：已知会返回大量数据但无意义的地址段 */
    fun defaultBlacklist(mode: String): Set<String> {
        val m = mode.uppercase()
        return if (m == "01") {
            // 03/07 等是 DTC 相关，不属于实时数据
            setOf("01:02", "01:03", "01:07", "01:0A")
        } else emptySet()
    }
}
