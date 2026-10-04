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
        val maxBlock = if (mode == "09") 0x40 else 0x60
        var block = 0
        while (block <= maxBlock) {
            if (cancelled) break
            val baseHex = block.toString(16).uppercase().padStart(2, '0')
            val req = "$mode $baseHex"
            val raw = requestWithRetry(req, cfg.copy(retry = 1, timeoutMs = 2500))
            delay(cfg.intervalMs)

            val modeInt = mode.toIntOrNull(16) ?: break
            val data = ObdProtocol.extractData(raw, modeInt, baseHex) ?: break
            if (data.size < 4) break

            var anyMore = false
            for (i in 0 until 32) {
                val byteIdx = i / 8
                val bit = 7 - (i % 8)
                if ((data[byteIdx].toInt() shr bit) and 1 == 1) {
                    out.add(block + i)
                    anyMore = true
                }
            }
            // 位图约定：最后一位置 1 表示「还有下一块」
            val nextBit = (data[3].toInt() and 0x01) == 1
            if (!anyMore || !nextBit) break
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
