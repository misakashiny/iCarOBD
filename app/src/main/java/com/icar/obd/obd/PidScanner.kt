package com.icar.obd.obd

import com.icar.obd.data.AppLog
import kotlinx.coroutines.*
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
 *  - **危险模式拦截**（本工具仅允许 01/09/21/22，其他服务拒绝）
 *  - **总量上限**（maxRequests，防止参数填错时跑出天文数字）
 *  - **Mode 01/09 先用支持位图**：只扫车厂声明支持的 PID，请求量可下降一个数量级
 *  - **主动取消**：随时 stop()，不会留下悬挂请求
 *
 * 使用前必须由 UI 收集用户确认（见 ScannerActivity）。
 */
class PidScanner(private val session: ElmSession, private val beforeRequest: () -> Unit = {}) {

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
            timestamp: String,
            summary: Summary? = null
        ): String {
            val sb = StringBuilder()
            sb.append("iCar OBD · PID 扫描结果\n")
            sb.append("时间: $timestamp\n")
            if (cfg != null) {
                val width = width(cfg.mode)
                sb.append("模式: ${cfg.mode}  ECU: ${cfg.header}\n")
                sb.append("范围: ${hex(cfg.from, width)} ~ ${hex(cfg.to, width)}\n")
                sb.append("参数: 间隔=${cfg.intervalMs}ms 超时=${cfg.timeoutMs}ms 重试=${cfg.retry}")
                    .append(" 上限=${cfg.maxRequests} 学习采样=${cfg.learnSamples}")
                    .append(" 支持位图=${cfg.useSupportedBitmap}\n")
                if (cfg.blacklist.isNotEmpty()) {
                    sb.append("黑名单: ${cfg.blacklist.joinToString(",")}\n")
                }
            }
            summary?.let { sb.append("状态: ${it.state} 请求=${it.requests}/${cfg?.maxRequests} PID=${it.done}/${it.total} 未探明位图块=${it.unknownBlocks}\n") }
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
                    sb.append("    学习量程: ${h.learnedMin ?: "-"} ~ ${h.learnedMax ?: "-"}（仅采样参考，不是物理量程）\n")
                }
                sb.append("    原始: ${h.raw.take(120)}\n")
            }
            sb.append("\n── 界面日志（${logLines.size} 条）──\n")
            logLines.forEach { sb.append(it).append("\n") }
            return sb.toString()
        }

        fun width(mode: String): Int = if(mode.trim().uppercase()=="22") 4 else 2
        fun validate(cfg: Config) {
            val mode=cfg.mode.trim().uppercase()
            require(mode in setOf("01","09","21","22")) { "本工具不允许 Mode $mode" }
            val max=if(mode=="22") 65535 else 255
            require(cfg.from in 0..max && cfg.to in cfg.from..max) { "PID范围应为 0..${max.toString(16).uppercase()}，起点不能大于终点" }
            require(cfg.intervalMs in 30..10_000 && cfg.timeoutMs in 200..10_000) { "间隔30–10000ms，超时200–10000ms" }
            require(cfg.retry in 0..3 && cfg.maxRequests in 1..2000 && cfg.learnSamples in 0..20 && cfg.learnIntervalMs in 30..10_000) { "重试0–3，请求上限1–2000，额外采样0–20" }
            val header=cfg.header.trim().uppercase()
            require(header.matches(Regex("[0-9A-F]{3}|[0-9A-F]{8}")) && header.toLong(16) <= if(header.length==3) 0x7FF else 0x1FFFFFFF) { "ECU请求头需为3位或8位合法CAN ID" }
            require(cfg.blacklist.all { it.trim().uppercase().matches(Regex("$mode:[0-9A-F]{${width(mode)}}")) }) { "排除项需用 $mode:PID 格式，与当前模式一致" }
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
        val learnIntervalMs: Long = 300,
        /** CAN request target; scanner restores the previous adapter header on exit. */
        val header: String = "7DF"
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
        val learnedMax: Float? = null,
        val header: String = "7DF"
    )

    enum class State { READY, SCANNING, DONE, STOPPED, LIMIT, FAILED }
    data class Summary(val state: State, val requests: Int = 0, val done: Int = 0,
        val total: Int = 0, val unknownBlocks: Int = 0)
    @Volatile var summary = Summary(State.READY)
        private set
    @Volatile private var job: Job? = null
    private val lock = Any()
    private class BudgetReached : RuntimeException()

    fun cancel() { synchronized(lock) { job?.cancel() } }

    suspend fun scan(cfg: Config, onProgress: suspend (Int, Int, Hit?) -> Unit): List<Hit> {
        validate(cfg)
        val owner = coroutineContext[Job] ?: error("扫描需要协程任务")
        synchronized(lock) { check(job == null) { "已有探测正在运行" }; job=owner }
        summary=Summary(State.SCANNING)
        val hits=ArrayList<Hit>()
        val mode=cfg.mode.trim().uppercase()
        val width=width(mode)
        val blacklist=cfg.blacklist.map { it.trim().uppercase() }.toSet()
        var lastRequestEnd: Long? = null
        fun publishCount(requests: Int = summary.requests, done: Int = summary.done,
            total: Int = summary.total, unknown: Int = summary.unknownBlocks) {
            summary=summary.copy(requests=requests,done=done,total=total,unknownBlocks=unknown)
        }
        suspend fun request(pid: String, spacing: Long=cfg.intervalMs): Pair<String,List<ByteArray>> {
            var raw=""
            repeat(cfg.retry+1) {
                coroutineContext.ensureActive()
                if (summary.requests >= cfg.maxRequests) throw BudgetReached()
                lastRequestEnd?.let { last ->
                    val remaining=spacing-(System.nanoTime()-last)/1_000_000
                    if(remaining>0) delay(remaining)
                }
                coroutineContext.ensureActive()
                beforeRequest()
                publishCount(requests=summary.requests+1)
                raw=session.requestPid(PidRequestPolicy.ReadRequest("$mode $pid",cfg.header),cfg.timeoutMs)
                lastRequestEnd=System.nanoTime()
                coroutineContext.ensureActive()
                val data=PidScanResponse.data(raw,mode,pid)
                if(data.isNotEmpty()) return raw to data
            }
            return raw to emptyList()
        }
        try {
            var candidates=(cfg.from..cfg.to).toList()
            if(cfg.useSupportedBitmap && mode in setOf("01","09")) {
                val supported=sortedSetOf<Int>()
                // Query every relevant block. Never let one ECU's continuation bit
                // hide another ECU, or turn a missing block into "not supported".
                val lastBlock=maxOf(maxSupportBlock(mode),((cfg.to.coerceAtLeast(1)-1)/32)*32)
                for(block in 0..lastBlock step 32) {
                    val (_, replies)=request(hex(block,2))
                    val valid=replies.filter { it.size == 4 }
                    if(valid.isEmpty()) publishCount(unknown=summary.unknownBlocks+1)
                    valid.forEach { supported.addAll(decodeSupportBitmap(block,it)) }
                }
                candidates=supported.filter { it in cfg.from..cfg.to }
            }
            candidates=candidates.filter { "$mode:${hex(it,width)}" !in blacklist }
            publishCount(total=candidates.size)
            onProgress(0,candidates.size,null)
            for(pid in candidates) {
                val pidHex=hex(pid,width)
                val (raw,replies)=request(pidHex)
                coroutineContext.ensureActive()
                val data=replies.firstOrNull()
                var hit=data?.let { parseHit(mode,pidHex,raw,it,cfg.header) }
                // Keep the initial sample and earlier hits even if learning exhausts
                // the budget. No extra callback or request is allowed after stop.
                if(hit != null) {
                    hits.add(hit)
                    publishCount(done=summary.done+1)
                    onProgress(summary.done,summary.total,hit)
                    val values=mutableListOf<Float>()
                    hit.previewValue?.takeIf { it.isFinite() }?.let(values::add)
                    repeat(cfg.learnSamples) {
                        val (_,sample)=request(pidHex,maxOf(cfg.intervalMs,cfg.learnIntervalMs))
                        sample.firstOrNull()?.let { bytes ->
                            runCatching { com.icar.obd.data.Formula.eval(hit!!.suggestedFormula,bytes).toFloat() }
                                .getOrNull()?.takeIf { it.isFinite() }?.let(values::add)
                        }
                    }
                    if(cfg.learnSamples>0 && values.isNotEmpty()) {
                        hit=hit.copy(learnedMin=values.minOrNull(),learnedMax=values.maxOrNull())
                        hits[hits.lastIndex]=hit
                        onProgress(summary.done,summary.total,hit)
                    }
                } else {
                    publishCount(done=summary.done+1)
                    onProgress(summary.done,summary.total,null)
                }
            }
            summary=summary.copy(state=State.DONE)
        } catch (_: BudgetReached) {
            summary=summary.copy(state=State.LIMIT)
        } catch (e: CancellationException) {
            summary=summary.copy(state=State.STOPPED)
            throw e
        } catch (e: Exception) {
            summary=summary.copy(state=State.FAILED)
            throw e
        } finally {
            synchronized(lock) { if(job === owner) job=null }
        }
        return hits
    }

    private fun parseHit(mode: String, pid: String, raw: String, data: ByteArray, header: String): Hit {
        val formula=when(data.size) { 1->"A"; 2->"(A*256)+B"; 3->"(A*65536)+(B*256)+C"; else->"(A*256)+B" }
        val value=runCatching { com.icar.obd.data.Formula.eval(formula,data).toFloat() }
            .getOrNull()?.takeIf { it.isFinite() }
        return Hit(mode,pid,"$mode $pid",raw.trim(),data.joinToString(" ") { "%02X".format(it.toInt() and 255) },formula,value,header=header)
    }

    private fun hex(v: Int,w: Int)=v.toString(16).uppercase().padStart(w,'0')

    /** 生成扫描用黑名单默认值：已知会返回大量数据但无意义的地址段 */
    fun defaultBlacklist(mode: String): Set<String> {
        val m = mode.uppercase()
        return if (m == "01") {
            // 03/07 等是 DTC 相关，不属于实时数据
            setOf("01:02", "01:03", "01:07", "01:0A")
        } else emptySet()
    }
}
