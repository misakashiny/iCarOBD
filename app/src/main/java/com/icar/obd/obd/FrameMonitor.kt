package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import com.icar.obd.data.AppLog
import com.icar.obd.data.Formula
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * **常驻监听通道**（v1.19.9）—— 把**广播帧**变成虚拟 PID。
 *
 * ## 为什么需要它
 *
 * 转向灯这类信号只出现在周期广播帧里（实车确认是 CAN `0x09A`），
 * **不能像 PID 那样主动请求**：ELM327 只会应答它愿意答的请求，
 * 而 `0x09A` 是别的模块自己在总线上喊的。
 *
 * ## 怎么做的
 *
 * 1. 取出所有 `source == "monitor"` 的 PID（见 [PidDefinition.source]）；
 * 2. 停掉轮询，装 CAN 过滤器（尽量窄），开 `ATMA` 监听；
 * 3. 每收到一帧，按 `header`（= CAN ID）匹配，用那条 PID 的 **`formula`** 求值
 *    （公式语言原样复用，所以 `bit(C,2)` 直接就能写）；
 * 4. 求出来的值照常 `VehicleBus.put(...)` —— 于是**规则引擎、仪表、CSV
 *    一行下游代码都不用改**。
 *
 * ## ⚠️ 代价：监听期间**轮询暂停**
 *
 * ELM327 是半双工的，`ATMA` 期间不能同时收发请求。所以这是一个**模式切换**，
 * 不是"顺便多收一点"。开着监听时，转速/水温那些标准 PID 会**冻结在最后一个值**。
 *
 * ## ⚠️ 退出时必须重新初始化
 *
 * 过滤器会连带挡住正常 OBD 的应答（正常请求回 `7E8`，过滤器只放行 `0x09A`）。
 * `ATAR`/`ATCM000`/`ATCF000` 三条都回 `OK` 却**清不掉**（实车踩过两次），
 * 唯一确定有效的是 `ATZ` 全复位 —— 所以 [stop] 里直接跑一次 [ObdController.initializeAndStart]。
 *
 * ## ⚠️ 帧率闸（v1.20.6，P10-5）—— 别把这段删掉
 *
 * 单 ID 过滤器下每秒只有 2~11 帧，毫无压力。但**信号跨多个 ID 段**时
 * [filterPlan] 会退化成"不加过滤器"，于是整条总线的帧（实测 **344 帧/秒**）
 * 全都要在**主线程**上切行 —— 本项目已经因为主线程堆积 ANR 过一次（v1.18.4）。
 *
 * 所以 [onChunk] 有三道闸（见 [FrameRateGate]）：正常 / 限流（按 ID 预筛）/ 过载（整块丢）。
 * 判定逻辑抽在 [FrameRateGate] 里是为了**能被 JVM 单测压**（这个 object 本身测不了，
 * `Handler(Looper.getMainLooper())` 是饿汉初始化，JVM 里一碰就抛 `Stub!`）。
 */
object FrameMonitor {

    private const val CMD_TIMEOUT = 2500L
    private const val LINE_BUF_MAX = 8192
    private const val LOG_INTERVAL_MS = 5000L

    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lineBuf = StringBuilder()

    /**
     * 行缓冲里**已经扫过**的位置（v1.20.6）。
     *
     * 原来每取一行都从下标 0 重新扫 `\r`/`\n` —— 一个分片里有 k 行时就是
     * O(k × 长度)。这是主线程热路径（见 [FrameRateGate] 的说明），
     * 记一个游标就不重复扫了。
     */
    private var scanFrom = 0

    /**
     * **帧率闸**（v1.20.6，P10-5）。判定逻辑在 [FrameRateGate] 里（纯逻辑、可单测）。
     */
    private val gate = FrameRateGate()

    /**
     * 预筛用的行首 ID 集合（大写）。
     *
     * 只在限流模式用 —— 见 [matchesMonitoredId] 为什么它不可能漏掉该收的帧。
     */
    private var acceptIds: List<String> = emptyList()

    /** 上一次因为帧率闸提示过用户没有（每次开启监听只提示一次，免得刷屏） */
    private var gateWarned = false
    private var lastWarnMode = FrameRateGate.Mode.NORMAL

    @Volatile
    var running = false
        private set

    /** 正在收尾（重新初始化）—— 期间不接受新的启动/探测 */
    @Volatile
    private var busy = false

    @Volatile
    /**
     * 缓存「PID + 解析好的 CAN ID」。
     *
     * ⚠️ **必须提前解析成数值**，不能留字符串后面比 —— 见 [feedLine] 里的说明。
     */
    private var cached: List<Pair<PidDefinition, Int>> = emptyList()

    /** 各 CAN ID 收到多少帧（诊断用：确认过滤器到底放行了谁） */
    private val idCounts = HashMap<Int, Int>()
    /** 每种信号已记录过几条"取值变化"（有界，防日志洪水） */
    private val changeLogged = HashMap<String, Int>()

    /** 上一次的取值，用来判断"变了没有" */
    private val lastVals = HashMap<String, Float>()

    @Volatile
    private var frames = 0L

    @Volatile
    private var hits = 0L

    private var engineWasRunning = false

    /** 开始/停止后回调（给 UI 改按钮文案） */
    var onStateChanged: ((Boolean) -> Unit)? = null

    /** `"09A"` / `"0x09A"` / `"9a"` 都能解析 */
    fun parseCanId(s: String): Int? = s.trim()
        .removePrefix("0x").removePrefix("0X")
        .takeIf { it.isNotEmpty() }
        ?.toIntOrNull(16)

    /** 可用的监听信号：启用 + `source=monitor` + `header` 是合法 CAN ID + 有公式 */
    fun signals(): List<PidDefinition> = Store.allPids().filter {
        it.enabled && it.source.equals("monitor", true) &&
            parseCanId(it.header) != null && it.formula.isNotBlank()
    }

    /**
     * 过滤器方案。**优先用单 ID 的 `ATCRA`**：
     * 只看 `0x09A` 时，流里每秒只剩约 2.5 帧，
     * 而按段过滤（`ATCM700`+`ATCF000`）会放进整段 `0x0xx`（约 344 帧/秒）——
     * 那些帧全都要在主线程上切行、解析，纯属浪费。
     */
    private fun filterPlan(sigs: List<PidDefinition>): List<String>? {
        val ids = sigs.mapNotNull { parseCanId(it.header) }.distinct()
        if (ids.isEmpty()) return null
        if (ids.size == 1) return listOf("ATCRA%03X".format(ids.first()))
        val blocks = ids.map { it and 0x700 }.distinct()
        if (blocks.size == 1) return listOf("ATCM700", "ATCF%03X".format(blocks.first()))
        // 跨段 = 加不了过滤器（一个 `ATCRA` 只能放行一个 ID，掩码一次只能覆盖一段）。
        // 于是整条总线的帧都会灌进主线程 —— 这正是 P10-5 那个 ANR 风险。
        // 这里**主动说一句**，别让用户事后从"信号偶尔跳一下"去猜；
        // 真到了 344 帧/秒，[gate] 还会再介入一次（预筛 / 丢帧）。
        AppLog.w(AppLog.M_OBD, "监听信号跨多个 ID 段，本次不加过滤器", "ids=$ids")
        ObdController.toast(
            "监听信号跨了 ${blocks.size} 个 ID 段，加不了 CAN 过滤器。\n" +
                "帧率高时会自动按监听 ID 预筛；若信号断续，请拆成两次监听。"
        )
        return null
    }

    fun start() {
        if (running) return
        if (busy) {
            AppLog.w(AppLog.M_OBD, "监听通道还在收尾，稍后再试", "")
            return
        }
        if (CanSniffer.running) {
            AppLog.w(AppLog.M_OBD, "单次探测正在跑，无法开启常驻监听", "")
            return
        }
        if (!ObdController.isConnected()) {
            AppLog.w(AppLog.M_OBD, "设备未就绪，无法开启常驻监听", "")
            return
        }
        val sigs = signals()
        if (sigs.isEmpty()) {
            AppLog.e(
                AppLog.M_OBD, "没有可用的监听信号",
                "需要有 source=monitor、header 填 CAN ID、且已启用的 PID"
            )
            return
        }
        // 提前把 header 解析成数值（`"09A"` -> 0x09A），后面按数值比
        cached = sigs.mapNotNull { s -> parseCanId(s.header)?.let { s to it } }
        // 预筛集合（`09A` / `9A` 两种写法都收 —— 见 acceptIdsOf 的说明）
        acceptIds = FrameRateGate.acceptIdsOf(cached.map { it.second })
        idCounts.clear()
        changeLogged.clear()
        lastVals.clear()
        frames = 0
        hits = 0
        lineBuf.setLength(0)
        scanFrom = 0
        gate.reset()
        gateWarned = false
        lastWarnMode = FrameRateGate.Mode.NORMAL
        running = true
        engineWasRunning = ObdController.engine.running
        if (engineWasRunning) ObdController.engine.stop()
        val plan = filterPlan(sigs)
        AppLog.i(
            AppLog.M_OBD, "监听通道启动",
            "信号=${sigs.joinToString(",") { it.id }} 过滤=${plan?.joinToString("+") ?: "无"}"
        )
        scope.launch {
            runCatching {
                // 先排空上一次的残余输出：ATMA 停止后适配器还会吐一段缓冲，
                // 不排空的话第一条 AT 的应答会读到残余（实车踩过）
                ObdController.transport.send("\r")
                delay(300)
                for (c in listOf("ATH1", "ATS1", "ATL1")) {
                    var resp = ""
                    for (a in 1..3) {
                        resp = runCatching { ObdController.session.raw(c, CMD_TIMEOUT) }.getOrNull() ?: ""
                        if (resp.contains("OK")) break
                        delay(200)
                    }
                    AppLog.i(AppLog.M_OBD, "监听准备", "$c -> ${resp.trim().take(48)}")
                }
                plan?.forEach { c ->
                    val r = runCatching { ObdController.session.raw(c, CMD_TIMEOUT) }.getOrNull()
                    AppLog.i(AppLog.M_OBD, "监听准备", "$c -> ${(r ?: "<异常>").trim().take(48)}")
                }
            }
            ObdController.rawChunkListener = { onChunk(it) }
            ObdController.transport.rawMode = true
            runCatching { ObdController.transport.send("ATMA\r") }
            main.post { onStateChanged?.invoke(true) }
            main.postDelayed(ticker, LOG_INTERVAL_MS)
        }
    }

    fun stop() {
        if (!running) return
        running = false
        main.removeCallbacks(ticker)
        scope.launch {
            runCatching { ObdController.transport.send("\r") }
            delay(200)
            ObdController.transport.rawMode = false
            ObdController.rawChunkListener = null
            // 让 ATMA 的积压输出吐完，否则重新初始化的 AT 应答会被埋在里头
            delay(400)
            busy = true
            val r = runCatching { ObdController.initializeAndStart() }.getOrNull()
            busy = false
            val f = frames
            val h = hits
            val g = gate.describe()
            cached = emptyList()
            acceptIds = emptyList()
            gate.reset()
            AppLog.i(
                AppLog.M_OBD, "监听通道停止",
                "帧=$f 命中=$h 重新初始化 ok=${r?.ok} | 帧率闸：$g"
            )
            main.post { onStateChanged?.invoke(false) }
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            if (!running) return
            // 带上"各 CAN ID 各收到多少帧" —— 这是在实车上判断
            // 「过滤器到底生效没有」的唯一直接证据
            val top = idCounts.entries.sortedByDescending { it.value }.take(6)
                .joinToString(" ") { "%X=%d".format(it.key, it.value) }
            AppLog.i(
                AppLog.M_OBD, "监听通道",
                "帧=$frames 命中=$hits 信号=${cached.size} 各ID[$top] | ${gate.describe()}"
            )
            main.postDelayed(this, LOG_INTERVAL_MS)
        }
    }

    /**
     * 接收原始分片。**这个方法跑在主线程上**（传输层约定：回调在主线程），
     * 所以它是整个监听通道的**性能咽喉** —— 每一次改动都要先想清楚
     * "344 帧/秒时这里会怎样"（见 [FrameRateGate] 与 P10-5）。
     *
     * ## 三道闸（v1.20.6）
     *
     * 1. **过载**：连切行都不做，整块丢掉（`lineBuf` 里压着的半行也清掉 ——
     *    半行本来也解不出帧，留着只会把下一块拼成畸形行）；
     * 2. **限流**：先做**廉价的**行首 ID 预筛，只把监听中的 ID 送进解析路径；
     * 3. **正常**：照旧全量解析（保留"各 ID 收到多少帧"的诊断）。
     *
     * ## 切行的两处优化（同一件事：别做无谓的搬移与重扫）
     *
     * - 用 [scanFrom] 游标记住扫到哪，不再每取一行都从下标 0 重扫；
     * - 行**攒到最后一次性 `delete`**，而不是每行都 `delete(0, br+1)`
     *   （后者每行都要搬一次整个缓冲区）。
     */
    private fun onChunk(chunk: String) {
        val now = System.currentTimeMillis()
        val m = gate.evaluate(now)
        if (m == FrameRateGate.Mode.OVERLOAD) {
            gate.noteChunkDropped(chunk.length)
            lineBuf.setLength(0)
            scanFrom = 0
            warnGate(m)
            return
        }
        lineBuf.append(chunk)
        if (lineBuf.length > LINE_BUF_MAX) {
            lineBuf.setLength(0)
            scanFrom = 0
        }
        var cut = indexOfBreak(scanFrom)
        if (cut < 0) {
            // 整块没有换行：下次从**末尾**继续扫，别把这段再扫一遍
            scanFrom = lineBuf.length
            warnGate(m)
            return
        }
        var consumed = 0
        while (cut >= 0) {
            val line = lineBuf.substring(consumed, cut).trim()
            consumed = cut + 1
            if (line.isNotEmpty()) {
                gate.countLine()
                if (m == FrameRateGate.Mode.THROTTLED && !matchesMonitoredId(line)) {
                    gate.noteSkipped()
                } else {
                    feedLine(line)
                }
            }
            cut = indexOfBreak(consumed)
        }
        // 一次性把消费掉的前缀搬走（见上面第 2 条优化）
        lineBuf.delete(0, consumed)
        scanFrom = lineBuf.length
        warnGate(m)
    }

    /**
     * 行首是不是监听中的 CAN ID（**廉价预筛**）。判定在 [FrameRateGate.leadingIdMatches]。
     *
     * ## 为什么它**不可能漏掉**该收的帧
     *
     * `CanFrame.parseLine` 取的 ID 就是行首那段十六进制（长度 3~8），
     * 而 [feedLine] 只在 `cid == f.canId` 时才处理。
     * 所以"行首不等于任何监听 ID"的行，**无论怎么解析都不会命中** ——
     * 预筛丢掉它，与"解析完再丢掉"结果完全一致，只是省掉了最贵的那一步
     * （`Regex("\\s+")` 切分 + 逐 token 解析 + 公式求值）。
     */
    private fun matchesMonitoredId(line: String): Boolean =
        FrameRateGate.leadingIdMatches(line, acceptIds)

    /**
     * 帧率闸介入 / 恢复时的**一次性**提示。
     *
     * 只在模式**变化**时动作（否则每个分片都会写一条日志 —— 那就是 v1.3.0
     * 那场"113 万行日志"事故的翻版）。Toast 每次开启监听最多一条。
     */
    private fun warnGate(m: FrameRateGate.Mode) {
        if (m == lastWarnMode) return
        lastWarnMode = m
        if (m == FrameRateGate.Mode.NORMAL) {
            AppLog.i(AppLog.M_OBD, "监听帧率恢复", gate.describe())
            return
        }
        AppLog.w(AppLog.M_OBD, "监听帧率过高，已介入", gate.describe())
        if (gateWarned) return
        gateWarned = true
        ObdController.toast(
            if (m == FrameRateGate.Mode.OVERLOAD) {
                "监听帧率过高（信号跨多个 ID 段，加不了过滤器）——\n" +
                    "已开始丢帧。请把监听拆成两次，每次只放一个 ID 段"
            } else {
                "监听帧率过高：已自动按监听 ID 预筛。\n若信号仍然断续，请把监听拆成两次"
            }
        )
    }

    private fun indexOfBreak(from: Int): Int {
        for (i in from until lineBuf.length) {
            val c = lineBuf[i]
            if (c == '\r' || c == '\n') return i
        }
        return -1
    }

    private fun feedLine(line: String) {
        val f = CanFrame.parseLine(line) ?: return
        frames++
        val arr = ByteArray(f.data.size) { (f.data[it] and 0xFF).toByte() }
        val raw = f.data.joinToString(" ") { "%02X".format(it and 0xFF) }
        val now = System.currentTimeMillis()
        idCounts[f.canId] = (idCounts[f.canId] ?: 0) + 1
        var matched = false
        for ((p, cid) in cached) {
            // ⚠️⚠️ **按数值比，不能比字符串。**
            // `Frame.idHex()` 用的是 `%X`：0x09A 出来是 `"9A"` 而不是 `"09A"`，
            // 而配置里习惯写 `"09A"` —— 字符串直接比会**永远不命中**，
            // 且表现为"帧一直在进、命中一直是 0"，极难看出问题。
            // 实车 2026-10-06 就是这样：`帧=581 命中=0`。
            if (cid != f.canId) continue
            val v = runCatching { Formula.eval(p.formula, arr) }.getOrNull() ?: continue
            val fv = v.toFloat()
            VehicleBus.put(PidValue(p.id, fv, raw, now, true))
            hits++
            matched = true
            // 取值变化时记一条（每种信号最多 20 条）——
            // 这是"位到底有没有在跳"的**直接证据**，比"有没有听到声音"硬得多
            val cnt = changeLogged[p.id] ?: 0
            if (cnt < 20 && lastVals[p.id] != fv) {
                changeLogged[p.id] = cnt + 1
                lastVals[p.id] = fv
                AppLog.i(AppLog.M_OBD, "监听信号变化", "${p.name}(${p.id}) = $fv")
            }
        }
        // ⚠️ **必须自己跑一次轮询周期**：`ATMA` 期间轮询引擎是停的，
        // `engine.onCycle` 不触发 -> `RuleEngine.evaluate()` 永远不会被调用 ->
        // `VehicleBus` 里有值但**规则一条都不响**（实车 2026-10-06：命中=114 却没声音）。
        if (matched) ObdController.runCycleOnce()
    }
}