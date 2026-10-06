package com.icar.obd.obd

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.bluetooth.BluetoothDevice
import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.icar.obd.R
import com.icar.obd.ble.BleTransport
import com.icar.obd.ble.ObdTransport
import com.icar.obd.ble.SppTransport
import com.icar.obd.ble.ObdTransport.Callback
import com.icar.obd.ble.ObdTransport.State
import com.icar.obd.data.AppLog
import com.icar.obd.data.AudioPlayer
import com.icar.obd.data.CsvRecorder
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.RuleAction
import com.icar.obd.data.Store
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * 全局控制器（单例门面）。
 *
 * 为什么用单例而不是 Binder：本应用是单进程，UI 生命周期短（切后台/旋屏都会重建），
 * 而 BLE 连接必须长活。把「传输 + 会话 + 引擎 + 规则」集中到一个进程级单例，
 * UI 只做「订阅 + 展示」，避免每次重建都重新连车。
 *
 * 数据流：
 *   BleTransport → ElmSession → ObdEngine → VehicleBus → { 仪表盘 / 规则引擎 / CSV }
 *
 * UI 只允许通过本类操作车辆侧，不允许直接 new BleTransport。
 */
object ObdController {

    /** UI 订阅接口。允许多个 Fragment 同时订阅（CopyOnWrite 保证线程安全）。 */
    interface Listener {
        fun onState(state: State, detail: String) {}
        fun onScanResult(dev: BluetoothDevice, name: String, rssi: Int, addr: String) {}
        fun onInitDone(result: ElmSession.InitResult) {}
        fun onInitStep(step: String) {}
        fun onAlert(msg: String) {}
    }

    private val listeners = CopyOnWriteArrayList<Listener>()

    fun addListener(l: Listener) { listeners.add(l) }
    fun removeListener(l: Listener) { listeners.remove(l) }

    private lateinit var ctx: Context
    private var ready = false

    lateinit var transport: ObdTransport
        private set
    lateinit var session: ElmSession
        private set
    lateinit var engine: ObdEngine
        private set
    lateinit var audio: AudioPlayer
        private set
    lateinit var csv: CsvRecorder
        private set
    /** G 值数据源（加速度计 / 车速差分）。OBD 总线上没有 G 传感器，必须另找来源 */
    lateinit var gForce: GForceSource
        private set

    val scanner: PidScanner get() = PidScanner(session)

    @Volatile
    var initResult: ElmSession.InitResult? = null
        private set

    @Volatile
    var connectedDeviceName: String = ""

    @Volatile
    var lastScanSummary: String = ""

    /** CSV 采样节流时间戳 */
    private var lastCsvTs: Long = 0L

    // ---- 自动重连状态 ----
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var reconnectAttempts = 0
    private var wasReady = false
    /** 用户主动断开时置位，避免自动重连把用户「粘」回车上 */
    @Volatile
    private var manualDisconnect = false
    /** 开机自动连成功之后，等 READY 自动跑一次初始化（只跑一次） */
    @Volatile
    private var autoInitPending = false

    /** 自动初始化是 suspend 的，需要一个作用域（不在主线程上跑，避免卡 UI） */
    private val autoScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    // 自动重连参数。注意：ObdController 是 object，不能在里面声明 companion object，
    // 因此直接用 const val（object 内允许）。
    private const val MAX_RECONNECT = 3
    private const val RECONNECT_DELAY_MS = 3000L
    /** [Store.settings.transportKind] 的取值：经典蓝牙 SPP */
    private const val KIND_SPP = "spp"
    fun init(context: Context) {
        if (ready) return
        ctx = context.applicationContext
        audio = AudioPlayer(ctx)
        csv = CsvRecorder(File(ctx.filesDir, "record"))
        audio.enabled = Store.settings.soundEnabled
        gForce = GForceSource(ctx)
        gForce.setMode(Store.settings.gForceMode)
        gForce.start()

        buildTransport()

        RuleEngine.actionHandler = ::handleAction
        RuleEngine.reload()
        // 记住「这台车真的能通」—— 只在**第一次解析出数值**时写盘一次。
        // 「开机自动连」拿它当门槛：光有地址不够，得确认以前真的收到过数据，
        // 否则点了连接却没读通的设备也会被记住，下次开机会白试一遍。
        VehicleBus.addValueListener { v ->
            if (v.ok && !Store.settings.everGotData) {
                Store.settings.everGotData = true
                Store.saveSettings()
                AppLog.i(
                    AppLog.M_SYS, "已记住这台车能通",
                    "addr=${Store.settings.lastDeviceAddress} · 下次启动将自动连接并初始化"
                )
            }
        }

        ready = true
        AppLog.i(AppLog.M_SYS, "ObdController 初始化完成")
    }

    /**
     * 按 [Store.settings.transportKind] 创建传输层，并把
     * transport → session → engine 与回调一起接好。
     *
     * **传输方式的选择只发生在这里**：上层（[ElmSession] / [ObdEngine]）只认
     * [ObdTransport] 接口，所以新增一种链路（SPP、以后的 WiFi/TCP）都不需要改它们。
     */
    private fun buildTransport() {
        transport = if (Store.settings.transportKind == KIND_SPP) SppTransport(ctx) else BleTransport(ctx)
        session = ElmSession(transport)
        engine = ObdEngine(session)
        // 每轮轮询后：先跑规则（要实时），CSV 限流到 1Hz（避免高频写盘拖慢总线）
        engine.onCycle = { onEngineCycle() }
        wireTransportCallback()
        AppLog.i(AppLog.M_SYS, "传输层已就绪", "kind=${transport.kind} ${transport.describe()}")
    }

    private fun wireTransportCallback() {
        transport.callback = object : Callback {
            override fun onStateChanged(s: State, detail: String) {
                AppLog.d(AppLog.M_BLE, "状态变更", "${s.name} $detail")
                listeners.forEach { runCatching { it.onState(s, detail) } }

                if (s == State.READY) {
                    wasReady = true
                    reconnectAttempts = 0
                    // 开机自动连成功 → 自动初始化（只做一次）
                    if (autoInitPending) {
                        autoInitPending = false
                        AppLog.i(AppLog.M_BLE, "自动连接成功，开始自动初始化", "")
                        autoScope.launch {
                            runCatching { initializeAndStart() }
                                .onFailure { AppLog.e(AppLog.M_OBD, "自动初始化异常", it.message ?: "") }
                        }
                    }
                }
                if (s == State.CLOSED) {
                    engine.stop()
                    RuleEngine.clearColors()
                    scheduleReconnectIfNeeded()
                }
            }

            override fun onScanResult(dev: BluetoothDevice, name: String, rssi: Int, addr: String) {
                listeners.forEach { runCatching { it.onScanResult(dev, name, rssi, addr) } }
            }

            override fun onRx(text: String) {
                session.onRx(text)
            }

            override fun onRawChunk(text: String) {
                // 透传模式（CAN 探测）专用。**刻意不经过 session、也不写日志** ——
                // ATMA 一秒上千帧，逐帧写日志就是 v1.3.0 那场事故的翻版。
                rawChunkListener?.invoke(text)
            }
        }
    }

    /**
     * 透传模式下的原始分片回调。
     *
     * 只有 [CanSniffer] 会挂它。挂上之前请先 `transport.rawMode = true`，
     * 否则走的是 `onRx` 那条切帧路径。
     */
    var rawChunkListener: ((String) -> Unit)? = null

    /**
     * 手动跑一次「轮询周期收尾」：G 值推进 + **规则评估** + CSV 落盘。
     *
     * ⚠️⚠️ **监听通道必须调它**（v1.19.12）。
     *
     * 规则引擎是被**轮询周期**驱动的：`engine.onCycle` 到 `onEngineCycle` 到
     * `RuleEngine.evaluate()`。而 `ATMA` 监听期间轮询引擎是**停的**，
     * 那个回调根本不会触发 —— 于是 `VehicleBus` 里明明有值，
     * 规则却**一次都没被评估过**。
     *
     * 实车 2026-10-06 就卡在这里：`命中=114`（值确实喂进去了）但一点声音都没有。
     * 这一类"数据到了、但没人消费"的 bug，光看数据侧**完全看不出来**。
     */
    fun runCycleOnce() = onEngineCycle()

    /**
     * 试听一个音效（规则编辑器用）。
     *
     * `force = true` 绕过音效总开关 —— 见 [AudioPlayer.play] 的说明。
     */
    fun previewSound(name: String, volume: Float = 1f, rate: Float = 1f) {
        audio.play(
            name.ifBlank { "beep" },
            volume.coerceIn(0f, 1f),
            rate.coerceIn(0.5f, 2f),
            force = true
        )
        AppLog.i(AppLog.M_AUDIO, "试听音效", "name=$name volume=$volume rate=$rate")
    }

    private fun onEngineCycle() {
        // 车速差分模式的纵向 G 要靠每轮轮询推进
        gForce.onCycle()
        RuleEngine.evaluate()
        val now = System.currentTimeMillis()
        if (csv.enabled && now - lastCsvTs >= 1000L) {
            lastCsvTs = now
            csv.append(VehicleBus.snapshot())
        }
    }

    /**
     * 切换 G 值来源（关闭 / 加速度计 / 车速差分），立即生效。
     * @return 实际生效的说明文案，供 UI 提示（加速度计不可用时要说清楚）
     */
    fun setGForceMode(mode: Int): String {
        Store.settings.gForceMode = mode
        Store.saveSettings()
        if (::gForce.isInitialized) {
            gForce.setMode(mode)
            gForce.start()
        }
        val name = if (::gForce.isInitialized) gForce.modeName(mode) else "未初始化"
        val hint = when {
            mode == GForceSource.MODE_SENSOR && !(::gForce.isInitialized && gForce.available) ->
                "$name（本机无此传感器，G 值不会更新）"
            else -> name
        }
        AppLog.i(AppLog.M_DATA, "G 值来源", "mode=$mode $hint")
        return hint
    }

    /**
     * 切换传输方式（BLE ↔ 经典蓝牙 SPP），**立即生效**。
     *
     * 会断开当前链路并重建 transport / session / engine。
     * 之所以能这么简单，是因为上层只依赖 [ObdTransport] 接口。
     */
    fun setTransportKind(kind: String) {
        if (!ready) return
        if (kind == Store.settings.transportKind) return
        Store.settings.transportKind = kind
        Store.saveSettings()
        AppLog.i(AppLog.M_SYS, "切换传输方式", "kind=$kind")

        engine.stop()
        // 先置位，避免旧链路关闭时触发自动重连
        manualDisconnect = true
        runCatching { (transport as? SppTransport)?.close() }
        runCatching { transport.disconnect() }
        wasReady = false
        reconnectAttempts = 0

        buildTransport()
        manualDisconnect = false
        toast("已切换到 ${transport.kind}，请重新扫描并连接")
    }

    // ---------------------------------------------------------------- 连接

    @SuppressLint("MissingPermission")
    fun startScan() {
        AppLog.i(AppLog.M_BLE, "开始扫描")
        transport.startScan(null)
    }

    fun stopScan() = transport.stopScan()

    @SuppressLint("MissingPermission")
    fun connect(device: BluetoothDevice) {
        manualDisconnect = false
        reconnectAttempts = 0
        connectedDeviceName = runCatching { device.name }.getOrNull() ?: device.address
        Store.settings.lastDeviceAddress = device.address
        Store.settings.lastDeviceName = connectedDeviceName
        Store.saveSettings()
        transport.connect(device)
    }

    /** 用上次记住的地址重连（自动重连用） */
    @SuppressLint("MissingPermission")
    fun reconnectLast(): Boolean {
        val addr = Store.settings.lastDeviceAddress
        if (addr.isBlank()) return false
        val adapter = runCatching {
            (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as android.bluetooth.BluetoothManager).adapter
        }.getOrNull() ?: return false
        val dev = runCatching { adapter.getRemoteDevice(addr) }.getOrNull() ?: return false
        AppLog.i(AppLog.M_BLE, "尝试重连上次设备", "addr=$addr")
        transport.connect(dev)
        return true
    }

    /**
     * **开机自动连**（v1.19.2）。
     *
     * 四个条件全满足才做，避免出现「用户不想连却一直被连回来」：
     *   1) 以前**真的收到过数据**（[Store.settings] 的 `everGotData`）
     *   2) 设置里开着 `autoReconnect`
     *   3) 有上次记住的地址
     *   4) 不是用户主动断开
     *
     * 连上之后由 `onStateChanged` 的 READY 分支自动跑一次 [initializeAndStart] ——
     * ELM327 的 AT 设置**掉电即失**（拔适配器、车断电就回出厂态），
     * 所以每次上车基本都得重新初始化一遍。
     *
     * ⚠️ 冷启动连不上**不会**进重连循环：`scheduleReconnectIfNeeded` 要求 `wasReady`，
     * 而冷启动失败时它还是 false。所以不会对着连不通的适配器反复重试。
     *
     * @return 是否真的发起了连接
     */
    @SuppressLint("MissingPermission")
    fun autoStartIfPossible(): Boolean {
        if (manualDisconnect) return false
        if (autoInitPending) return false          // 已经在自动连了，别重复发起
        if (isConnected()) return false            // 已经连上了（服务可能先起来过）
        if (!Store.settings.autoReconnect) return false
        if (!Store.settings.everGotData) return false
        if (Store.settings.lastDeviceAddress.isBlank()) return false
        AppLog.i(
            AppLog.M_SYS, "开机自动连接",
            "addr=${Store.settings.lastDeviceAddress} name=${Store.settings.lastDeviceName}"
        )
        autoInitPending = true
        val ok = reconnectLast()
        if (!ok) {
            autoInitPending = false
            AppLog.w(AppLog.M_SYS, "开机自动连接失败", "没有可用地址或蓝牙不可用")
        }
        return ok
    }

    fun disconnect() {
        manualDisconnect = true
        engine.stop()
        transport.disconnect()
    }

    /**
     * 意外断开后的自动重连。
     *
     * 触发条件全部满足才重连，避免出现「用户想断开却一直被连回来」的体验：
     *   1) 之前确实连上过（wasReady）
     *   2) 设置里开启了 autoReconnect
     *   3) 不是用户主动点断开（manualDisconnect）
     *   4) 重试次数未超上限（MAX_RECONNECT）
     *
     * 行车中 BLE 偶发掉线是常态，这个机制比手动重连实用得多。
     */
    private fun scheduleReconnectIfNeeded() {
        if (manualDisconnect) {
            AppLog.i(AppLog.M_BLE, "用户主动断开，不自动重连")
            return
        }
        if (!wasReady) return
        wasReady = false
        if (!Store.settings.autoReconnect) return
        if (Store.settings.lastDeviceAddress.isBlank()) return
        if (reconnectAttempts >= MAX_RECONNECT) {
            AppLog.w(AppLog.M_BLE, "自动重连已达上限，放弃", "attempts=$reconnectAttempts")
            reconnectAttempts = 0
            return
        }
        reconnectAttempts++
        AppLog.w(
            AppLog.M_BLE, "计划自动重连",
            "第 $reconnectAttempts/$MAX_RECONNECT 次，${RECONNECT_DELAY_MS}ms 后"
        )
        mainHandler.postDelayed({
            if (manualDisconnect) return@postDelayed
            val ok = reconnectLast()
            if (!ok) AppLog.w(AppLog.M_BLE, "自动重连失败：没有可用地址")
        }, RECONNECT_DELAY_MS)
    }

    /**
     * 初始化 ELM327 并在成功后启动轮询。
     * 这个方法是 suspend 的，必须由 UI 在协程里调用。
     */
    suspend fun initializeAndStart(onStep: (String) -> Unit = {}): ElmSession.InitResult {
        val r = session.initialize(Store.settings.protocol) { step ->
            AppLog.d(AppLog.M_OBD, "初始化步骤", step)
            listeners.forEach { runCatching { it.onInitStep(step) } }
            onStep(step)
        }
        initResult = r
        listeners.forEach { runCatching { it.onInitDone(r) } }
        if (r.ok) {
            startPolling()
        } else {
            AppLog.e(AppLog.M_OBD, "初始化未通过（0100 无有效响应）", "probe=${r.probeRaw.take(80)}")
            // ⚠️ **未通过也照常启动轮询**（v1.17.6 改，之前是直接不启动）。
            //
            // 为什么改：v1.17.2 把 `ok` 的判据**加严**成"`0100` 真的解析出 4 字节位图"，
            // 假阴性的概率随之变高 —— 而"ok=false 就完全不轮询"会把假阴性放大成
            // **"明明能通却什么都不做"**。实车会话 B 就是 `ok=false` 却有真实数据。
            //
            // 现在照常轮询：真不通时由**总线负载保护**自动降频，
            // 30 秒后的「轮询汇总」会明说「有值 0/N」—— 比静默不动**更容易看出问题**。
            AppLog.w(
                AppLog.M_OBD, "初始化未通过，但仍启动轮询",
                "看 30 秒后的「轮询汇总 | 有值 N/M」判断链路到底通不通"
            )
            startPolling()
        }
        return r
    }

    fun startPolling() {
        if (engine.running) return
        engine.start()
        if (Store.settings.csvEnabled && !csv.enabled) {
            csv.start(engine.activePids.map { it.id })
        }
    }

    fun stopPolling() {
        engine.stop()
        csv.stop()
    }

    fun reloadPids() {
        val wasRunning = engine.running
        if (wasRunning) engine.stop()
        engine.reload()
        if (wasRunning) engine.start()
    }

    fun reloadRules() = RuleEngine.reload()

    // ------------------------------------------------ 「本车不支持」的查询与重启用（P10-1）

    /**
     * 该 PID 是否已被判定为「**本车不支持**」（ECU 连续明确回绝后已退出轮询）。
     *
     * UI 用它把列表项**标灰**。判据见 [ObdProtocol.isUnsupportedEvidence] ——
     * **超时/总线错不算**，所以这个集合里不会有"链路不好"误伤的 PID。
     */
    fun isUnsupported(pidId: String): Boolean = engine.unsupportedPids.contains(pidId)

    /**
     * 手动把一条被判定为「本车不支持」的 PID **重新纳入轮询**。
     *
     * 判定依据是"ECU 连续 N 次明确回绝"，但车况会变（换适配器 / 换车 / 上次总线正忙），
     * **判定错一次就不让用户改，等于把 App 写死**。
     *
     * @return true = 之前确实被标记过，已重启用
     */
    fun reEnablePid(pidId: String): Boolean = engine.reEnable(pidId)

    /** 当前被判定为「本车不支持」的 PID 条数（给界面做汇总提示用） */
    fun unsupportedCount(): Int = engine.unsupportedPids.size

    // ---------------------------------------------------------------- 规则动作

    private fun handleAction(rule: com.icar.obd.data.Rule, a: RuleAction) {
        when (a.type) {
            // p1 = 音效名；p2 = 播放速率（0.5~2.0）；p3 = 音量（0~1）。
            // 用三个自由字符串参数而不是加字段：RuleAction 本来就是
            // "type + p1/p2/p3" 的通用形状，**存量 JSON 不用迁移**。
            "sound" -> audio.play(
                a.p1.ifBlank { "warn" },
                volume = a.p3.toFloatOrNull() ?: 1f,
                rate = a.p2.toFloatOrNull() ?: 1f
            )
            "toast" -> {
                val msg = a.p1.ifBlank { rule.name }
                AppLog.i(AppLog.M_RULE, "提示", msg)
                toast(msg)
                emitAlert("⚠ $msg")
            }
            "log" -> AppLog.i(AppLog.M_RULE, a.p1.ifBlank { rule.name })
            "gauge" -> {
                val color = parseColor(a.p2)
                val target = a.p1
                val targets = if (target.isBlank()) rule.conditions.map { it.sourceId } else listOf(target)
                targets.forEach { RuleEngine.setColor(it, color) }
                AppLog.i(AppLog.M_RULE, "仪表变色", "target=${target.ifBlank { "条件源" }} color=$color")

                // p3 = **N 秒后自动恢复**（v1.19.18）。空 = 一直保持到别的规则改它。
                //
                // 为什么需要它：变色规则最常用的写法是"超温变红"，而"恢复正常后变回来"
                // 得**另配一条规则**去 reset —— 很容易忘了配，
                // 于是仪表**永远红着**，看起来像 App 坏了。
                //
                // 用 p3 而不是新加 p4：动作行只有三个输入框，p4 用户填不了。
                val restoreSec = a.p3.trim().toFloatOrNull()
                if (restoreSec != null && restoreSec > 0f) {
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        targets.forEach { RuleEngine.setColor(it, -1) }
                        AppLog.i(
                            AppLog.M_RULE, "仪表变色已自动恢复",
                            "targets=${targets.joinToString(",")} 延时=${restoreSec}s"
                        )
                    }, (restoreSec * 1000f).toLong())
                }
            }
            "vibrate" -> vibrate(a.p1.toLongOrNull() ?: 300L)
            "notify" -> notifyRule(a.p1.ifBlank { rule.name })
            else -> AppLog.w(AppLog.M_RULE, "未知动作类型", a.type)
        }
    }

    fun emitAlert(msg: String) {
        VehicleBus.emit(msg)
        listeners.forEach { runCatching { it.onAlert(msg) } }
    }

    fun toast(msg: String) {
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            runCatching { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show() }
        }
    }

    private fun parseColor(spec: String): Int {
        val s = spec.trim()
        if (s.isEmpty()) return 0xFFFF4D4F.toInt()
        return when (s.lowercase()) {
            "red", "红" -> 0xFFFF4D4F.toInt()
            "green", "绿" -> 0xFF2FD47A.toInt()
            "yellow", "黄" -> 0xFFFFD400.toInt()
            "orange", "橙" -> 0xFFFF8A00.toInt()
            "blue", "蓝" -> 0xFF4DA3FF.toInt()
            "cyan", "青" -> 0xFF00D8FF.toInt()
            "purple", "紫" -> 0xFF7C5CFF.toInt()
            "white", "白" -> 0xFFFFFFFF.toInt()
            "reset", "恢复" -> -1
            else -> runCatching { android.graphics.Color.parseColor(s) }.getOrDefault(0xFFFF4D4F.toInt())
        }
    }

    @SuppressLint("MissingPermission")
    private fun vibrate(ms: Long) {
        runCatching {
            val vib = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vib.vibrate(VibrationEffect.createOneShot(ms.coerceIn(20, 2000), VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                @Suppress("DEPRECATION")
                vib.vibrate(ms.coerceIn(20, 2000))
            }
        }
    }

    private fun notifyRule(text: String) {
        ensureChannel()
        val n = NotificationCompat.Builder(ctx, CH_RULE)
            .setSmallIcon(R.drawable.ic_nav_rule)
            .setContentTitle("车辆告警")
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(text.hashCode(), n) }
    }

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CH_RULE) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CH_RULE, "车辆告警", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        if (nm.getNotificationChannel(CH_SERVICE) == null) {
            nm.createNotificationChannel(
                NotificationChannel(CH_SERVICE, "OBD 连接", NotificationManager.IMPORTANCE_LOW)
            )
        }
    }

    const val CH_RULE = "icar_rule"
    const val CH_SERVICE = "icar_service"

    // ---------------------------------------------------------------- 便捷查询

    fun pidsForDashboard(): List<PidDefinition> = Store.allPids().filter { it.enabled }

    fun isConnected(): Boolean = transport.isReady()

    fun stateName(): String = when (transport.state) {
        State.IDLE -> "空闲"
        State.SCANNING -> "扫描中"
        State.CONNECTING -> "连接中"
        State.DISCOVERING -> "发现服务"
        State.READY -> "已就绪"
        State.CLOSED -> "已断开"
    }
}