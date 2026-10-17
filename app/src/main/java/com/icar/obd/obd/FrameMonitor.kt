package com.icar.obd.obd

import android.os.Handler
import android.os.Looper
import com.icar.obd.data.AppLog
import com.icar.obd.data.Formula
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidValue
import com.icar.obd.data.Store
import com.icar.obd.data.dlcTooShort
import com.icar.obd.data.hitsInvalidRaw
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Job
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

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

    /**
     * 监听来源的 owner 标识（T-App-A1-M-P）。
     *
     * 用固定单例而不是 `this`：`FrameMonitor` 本身是 object，语义上就只有一个
     * 监听通道。`VehicleBus.openSource(owner)` 对同一 owner 会**自动关闭旧来源**
     * 并分配递增 epoch，这正是"同一通道的新一轮取代旧一轮"需要的语义。
     */
    private val MONITOR_SOURCE_OWNER = Any()

    @Volatile
    internal lateinit var runtime: FrameMonitorRuntime
    @Volatile
    internal lateinit var scheduler: FrameMonitorScheduler

    private fun ensureRuntime() {
        if (!::runtime.isInitialized) runtime = AndroidFrameMonitorRuntime
        if (!::scheduler.isInitialized) scheduler = AndroidFrameMonitorScheduler()
    }
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

    /**
     * 关闭本轮监听专属来源（T-App-A1-M-P）。
     *
     * **幂等**：重复调用无副作用。**只失效本来源拥有的 PID**：
     * [VehicleBus.closeSource] 会把它们置 `ok=false`（未知），保留历史与累计，
     * 并且跳过已被其他来源接管的 PID —— 所以"同 PID 被别的源覆盖后再停监听"
     * 不会误清别人的值。
     *
     * 本轮目标来源与 `running`/`epoch` 解耦：无论在准备失败、断连还是正常
     * [stop] 里调用，都只关"当前挂着的那个"，不会关到更新的那一轮。
     */
    private fun closeMonitorSource() {
        val s = monitorSource ?: return
        monitorSource = null
        runCatching { VehicleBus.closeSource(s) }.onFailure {
            AppLog.w(AppLog.M_OBD, "关闭监听来源失败", it.message ?: "")
        }
    }

    @Volatile
    var running = false
        private set

    /**
     * 本轮监听的**专属来源**（T-App-A1-M-P）。
     *
     * ## 为什么需要它
     *
     * 原来 [feedLine] 走的是无来源的 [VehicleBus.put] —— 那个重载会
     * `currentOwners.remove(v.pidId)`，等于宣告"这个 PID 现在没人拥有"。
     * 于是 [stop] 时没有任何东西可以把监听 PID 置为"未知"，它就一直挂着
     * 最后一次收到的值，**看起来和实时一样**。这正是用户说的"停源失效"。
     *
     * 现在改为：本轮 start 打开一个专属 Source 并绑定本轮 [epoch]，
     * [feedLine] 用 `put(source, …)` 发布；[stop] 与准备失败/断连路径在
     * 同一收尾边界 [closeMonitorSource] 关闭它 —— 关闭会把**本来源的当前值**
     * 置 `ok=false`（history/累计保留），且**不触碰其他来源**的同 PID。
     *
     * 代际保护：新一轮 start 先开新 Source 再**关闭旧的那个**；
     * 旧 Source 的 close 只会失效它自己拥有的 PID，不会结束新 Source。
     */
    @Volatile
    private var monitorSource: VehicleBus.Source? = null

    /** 正在收尾（重新初始化）—— 期间不接受新的启动/探测 */
    @Volatile
    private var busy = false
    val active: Boolean get() = running || busy
    val preparing: Boolean get() = running && busy
    private var preparation: Job? = null
    @Volatile private var epoch = 0L

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
        runtime.toast(
            "监听信号跨了 ${blocks.size} 个 ID 段，加不了 CAN 过滤器。\n" +
                "帧率高时会自动按监听 ID 预筛；若信号断续，请拆成两次监听。"
        )
        return null
    }

    fun start() {
        ensureRuntime()
        synchronized(CanAdapterGate.lock) {
            if (CanAdapterGate.initializing || CanAdapterGate.scanning) {
                AppLog.w(AppLog.M_OBD, "适配器正在初始化，常驻监听没有开启", "")
                return
            }
            if (running) return
            if (busy) {
                AppLog.w(AppLog.M_OBD, "监听通道还在收尾，稍后再试", "")
                return
            }
            if (CanSniffer.busy) {
                AppLog.w(AppLog.M_OBD, "单次探测正在跑，无法开启常驻监听", "")
                return
            }
            if (!runtime.connected) {
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
            busy = true
            val generation = ++epoch
            // ---- 监听专属来源（T-App-A1-M-P）----
            // 先开新一轮来源，再关掉残留的旧来源：这样"快速重开"时旧来源的
            // close 只会失效它自己那一轮发布过的 PID，不会结束刚开的新来源。
            val previous = monitorSource
            monitorSource = VehicleBus.openSource(MONITOR_SOURCE_OWNER)
            if (previous != null) {
                runCatching { VehicleBus.closeSource(previous) }.onFailure {
                    AppLog.w(AppLog.M_OBD, "关闭上一轮监听来源失败", it.message ?: "")
                }
            }
            engineWasRunning = runtime.engineRunning
            if (engineWasRunning) runtime.stopPolling()
            val plan = filterPlan(sigs)
            AppLog.i(
                AppLog.M_OBD, "监听通道启动",
                "信号=${sigs.joinToString(",") { it.id }} 过滤=${plan?.joinToString("+") ?: "无"}"
            )
            preparation = scope.launch {
                runCatching {
                    currentCoroutineContext().ensureActive()
                    if (!running || epoch != generation) return@launch
                    // 先排空上一次的残余输出：ATMA 停止后适配器还会吐一段缓冲，
                    // 不排空的话第一条 AT 的应答会读到残余（实车踩过）
                    runtime.send("\r")
                    delay(300)
                    for (c in listOf("ATH1", "ATS1", "ATL1")) {
                        currentCoroutineContext().ensureActive()
                        if (!running || epoch != generation) return@launch
                        var resp = ""
                        for (a in 1..3) {
                            resp = runCatching { runtime.raw(c, CMD_TIMEOUT) }.getOrNull() ?: ""
                            currentCoroutineContext().ensureActive()
                            if (!running || epoch != generation) return@launch
                            if (resp.contains("OK")) break
                            delay(200)
                        }
                        AppLog.i(AppLog.M_OBD, "监听准备", "$c -> ${resp.trim().take(48)}")
                        if (c != "ATL1" && !resp.contains("OK")) error("$c 未生效，常驻监听没有开启")
                    }
                    plan?.forEach { c ->
                        val r = runCatching { runtime.raw(c, CMD_TIMEOUT) }.getOrNull()
                        currentCoroutineContext().ensureActive()
                        if (!running || epoch != generation) return@launch
                        AppLog.i(AppLog.M_OBD, "监听准备", "$c -> ${(r ?: "<异常>").trim().take(48)}")
                        if (r?.contains("OK") != true) error("$c 未生效，常驻监听没有开启")
                    }
                }.onFailure { error ->
                    if (error !is CancellationException) {
                        AppLog.e(AppLog.M_OBD, "常驻监听准备失败", error.message ?: "")
                        // 准备失败也必须释放本来源：此时尚未进接收，但来源已开，
                        // 不关就会让"开过又失败"的残留 owner 继续挂着。
                        closeMonitorSource()
                        scheduler.post(Runnable { if (running && epoch == generation) stop() })
                    }
                    return@launch
                }
                val workerContext = currentCoroutineContext()
                synchronized(CanAdapterGate.lock) {
                    workerContext.ensureActive()
                    if (!running || epoch != generation) return@launch
                    if (!runtime.connected) {
                        scheduler.post(Runnable { if (running && epoch == generation) stop() })
                        return@launch
                    }
                    runtime.rawChunkListener = { if (running && epoch == generation) onChunk(it) }
                    runtime.rawMode = true
                    runCatching { runtime.send("ATMA\r") }.onFailure {
                        scheduler.post(Runnable { if (running && epoch == generation) stop() })
                        return@launch
                    }
                    busy = false
                    scheduler.post(Runnable { if (running && epoch == generation) onStateChanged?.invoke(true) })
                    scheduler.postDelayed(LOG_INTERVAL_MS, ticker)
                }
            }
        }
    }

    fun stop() {
        if (!::runtime.isInitialized || !::scheduler.isInitialized) return
        val stoppingEpoch = synchronized(CanAdapterGate.lock) {
            if (!running) {
                // 已经不在运行：可能是上一轮收尾中，也可能是准备阶段失败后
                // 由外部重复调用。此处仍要兜底关闭尚未释放的来源，
                // 避免"没 running 但来源还挂着"而让监听 PID 停在当前值。
                closeMonitorSource()
                return
            }
            running = false
            busy = true
            preparation?.cancel()
            preparation = null
            ++epoch
        }
        scheduler.remove(ticker)
        scope.launch {
            if (!runtime.connected) {
                runtime.rawMode = false
                runtime.rawChunkListener = null
                // 断连收尾同样要关闭监听来源：否则监听 PID 会挂着最后一次的值。
                closeMonitorSource()
                busy = false
                scheduler.post(Runnable { if (epoch == stoppingEpoch && !running) onStateChanged?.invoke(false) })
                return@launch
            }
            runCatching { runtime.send("\r") }
            delay(200)
            runtime.rawMode = false
            runtime.rawChunkListener = null
            // 让 ATMA 的积压输出吐完，否则重新初始化的 AT 应答会被埋在里头
            delay(400)
            busy = true
            val r = runCatching { runtime.initializeWithoutPolling() }.getOrNull()
            // 监听专属来源在此统一关闭（正常停 / 准备失败 / 断连都走这条路）。
            // 必须在 rawMode=false 与回调摘除之后 —— 先断流再失效，避免收尾期间
            // 还有晚到帧把值写回去。
            closeMonitorSource()

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
            synchronized(CanAdapterGate.lock) {
                busy = false
                scheduler.post(Runnable { if (epoch == stoppingEpoch && !running) onStateChanged?.invoke(false) })
                if (engineWasRunning && r?.ok == true && runtime.connected) runtime.startPolling()
            }
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
            scheduler.postDelayed(LOG_INTERVAL_MS, this)
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
        if (!running) return
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
        runtime.toast(
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
        val dlc = f.data.size
        val arr = ByteArray(dlc) { (f.data[it] and 0xFF).toByte() }
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
            // ---- ① DLC 守卫（v1.20.7，S2）----
            //
            // 帧比 minDlc 短 → **不解析**。不检查的后果不是"少一个值"，
            // 而是按错位的字节解出一个**看起来很像真的**数字。
            // 判定抽在 `PidDefinition.dlcTooShort` 里（纯函数，可单测）——
            // 这个 object 在 JVM 里一碰就抛 `Stub!`，写在里面就测不到。
            if (p.dlcTooShort(dlc)) {
                // 日志洪水由 AppLog 的重复抑制兜底（同一句 2 秒内只累计计数）。
                // 消息里带信号名 → 不同信号各自成一条，不会互相盖掉。
                AppLog.w(
                    AppLog.M_OBD,
                    "信号跳过 | 原因=DLC不足 需要=${p.minDlc} 实际=$dlc",
                    "信号=${p.name}(${p.id}) 报文=${f.idHex()}"
                )
                continue
            }
            val v = runCatching { Formula.eval(p.formula, arr) }.getOrNull() ?: continue
            val fv = v.toFloat()
            // ---- ② 无效原始值（v1.20.7，S2）----
            //
            // ⚠️ `rawBits` **只在真的配了 invalidRaw 时才解析公式文本** ——
            // 它在主线程热路径上（344 帧/秒那种场面），不能白花一次词法分析。
            val bad = if (p.invalidRaw == null) false
            else p.hitsInvalidRaw(Formula.rawBits(p.formula, arr), v)
            // 命中无效值 → `ok=false`。下游（仪表/规则/CSV）都是 `ok` 才给值，
            // 所以显示 `--`、规则不误触发、CSV 记空 —— **下游零改动**。
            //
            // ---- 来源化发布（T-App-A1-M-P）----
            // 必须走带 Source 的重载。无来源的 `VehicleBus.put(v)` 会把当前来源
            // 标记清掉，导致 stop 时没有任何东西能把该 PID 置为未知 —— 那就是
            // "停源失效"红用例的根因。已关闭的来源会让 put 返回 false 并丢弃，
            // 这正是我们要的：收尾之后到达的晚到帧不得再写当前值/历史。
            val src = monitorSource
            if (src == null || !VehicleBus.put(src, PidValue(p.id, fv, raw, now, !bad, ttlMs = p.ttlMs))) {
                // 收尾竞态：来源已关闭（或正在被替换）—— 本轮这帧不再发布。
                // 不增加告警日志（热路径，且属于正常竞态）。
                continue
            }
            hits++
            matched = true
            // 取值变化时记一条（每种信号最多 20 条）——
            // 这是"位到底有没有在跳"的**直接证据**，比"有没有听到声音"硬得多
            val cnt = changeLogged[p.id] ?: 0
            if (bad) {
                // 无效值要单独说清楚：不然日志里只有一个"看起来很正常"的数字，
                // 而仪表却显示 `--`，两边对不上会让人以为是仪表坏了
                if (cnt < 20) {
                    changeLogged[p.id] = cnt + 1
                    AppLog.w(
                        AppLog.M_OBD, "信号命中无效原始值",
                        "${p.name}(${p.id}) raw=${Formula.rawBits(p.formula, arr)} = invalidRaw(${p.invalidRaw}) → 视为无效"
                    )
                }
            } else if (cnt < 20 && lastVals[p.id] != fv) {
                changeLogged[p.id] = cnt + 1
                lastVals[p.id] = fv
                AppLog.i(AppLog.M_OBD, "监听信号变化", "${p.name}(${p.id}) = $fv")
            }
        }
        // ⚠️ **必须自己跑一次轮询周期**：`ATMA` 期间轮询引擎是停的，
        // `engine.onCycle` 不触发 -> `RuleEngine.evaluate()` 永远不会被调用 ->
        // `VehicleBus` 里有值但**规则一条都不响**（实车 2026-10-06：命中=114 却没声音）。
        if (matched) runtime.runCycleOnce()
    }
}
