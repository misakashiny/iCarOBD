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

    // ---------------------------------------------------------------- 规则动作

    private fun handleAction(rule: com.icar.obd.data.Rule, a: RuleAction) {
        when (a.type) {
            "sound" -> audio.play(a.p1.ifBlank { "warn" })
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
                if (target.isBlank()) {
                    // 未指定则给该规则涉及的所有数据源染色
                    rule.conditions.forEach { c -> RuleEngine.setColor(c.sourceId, color) }
                } else {
                    RuleEngine.setColor(target, color)
                }
                AppLog.i(AppLog.M_RULE, "仪表变色", "target=${target.ifBlank { "条件源" }} color=$color")
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
