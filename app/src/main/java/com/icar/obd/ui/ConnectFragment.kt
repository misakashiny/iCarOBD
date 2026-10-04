package com.icar.obd.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Spinner
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.ble.ObdTransport
import com.icar.obd.ble.ObdTransport.State
import com.icar.obd.data.AppLog
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.ObdProtocol
import com.icar.obd.obd.VehicleBus
import com.icar.obd.ui.adapter.DeviceAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 连接页：扫描 → 连接 → 初始化 → 运行选项。
 *
 * 初始化流程是**串行且耗时**的（ATZ 复位 + 探测 0100，通常 2~5 秒），
 * 因此放在 lifecycleScope + Dispatchers.IO，并且全程把每一步写进日志，
 * 失败时可以直接在「日志」页看到卡在哪一条 AT 命令。
 */
class ConnectFragment : Fragment(), ObdController.Listener {

    private lateinit var dot: View
    private lateinit var tvState: TextView
    private lateinit var tvHz: TextView
    private lateinit var tvInitInfo: TextView
    private lateinit var tvInitSteps: TextView
    private lateinit var tvBusInfo: TextView
    private lateinit var tvDeviceHint: TextView
    private lateinit var spProtocol: Spinner
    private lateinit var spTransport: Spinner
    private lateinit var spGForce: Spinner
    private lateinit var btnScan: MaterialButton
    private lateinit var btnStopScan: MaterialButton
    private lateinit var btnInit: MaterialButton
    private lateinit var btnDisconnect: MaterialButton
    private lateinit var deviceAdapter: DeviceAdapter

    private val main = Handler(Looper.getMainLooper())
    private var ticker: Runnable? = null
    private val steps = ArrayList<String>()

    private val protocolKeys = ObdProtocol.PROTOCOLS.keys.toList()
    private val protocolLabels = ObdProtocol.PROTOCOLS.values.toList()

    /** 传输方式选项。上层只认 ObdTransport 接口，所以这里只是一组字符串。 */
    private val transportKeys = listOf("ble", "spp")
    private val transportLabels = listOf("BLE（iCar Pro 2S）", "经典蓝牙 SPP（iCar Pro BT3.0）")

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_connect, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        dot = view.findViewById(R.id.connDot)
        tvState = view.findViewById(R.id.tvConnState)
        tvHz = view.findViewById(R.id.tvConnHz)
        tvInitInfo = view.findViewById(R.id.tvInitInfo)
        tvInitSteps = view.findViewById(R.id.tvInitSteps)
        tvBusInfo = view.findViewById(R.id.tvBusInfo)
        tvDeviceHint = view.findViewById(R.id.tvDeviceHint)
        spProtocol = view.findViewById(R.id.spProtocol)
        spTransport = view.findViewById(R.id.spTransport)
        spGForce = view.findViewById(R.id.spGForce)
        btnScan = view.findViewById(R.id.btnScan)
        btnStopScan = view.findViewById(R.id.btnStopScan)
        btnInit = view.findViewById(R.id.btnInit)
        btnDisconnect = view.findViewById(R.id.btnDisconnect)

        deviceAdapter = DeviceAdapter { dev -> connect(dev) }
        view.findViewById<RecyclerView>(R.id.rvDevices).apply {
            layoutManager = LinearLayoutManager(requireContext())
            adapter = deviceAdapter
        }

        spProtocol.adapter = ArrayAdapter(
            requireContext(), android.R.layout.simple_spinner_dropdown_item, protocolLabels
        )
        val savedIdx = protocolKeys.indexOf(Store.settings.protocol).coerceAtLeast(0)
        spProtocol.setSelection(savedIdx)

        // 传输方式：先设选项再挂监听，避免初始化时误触发一次切换
        spTransport.adapter = ArrayAdapter(
            requireContext(), android.R.layout.simple_spinner_dropdown_item, transportLabels
        )
        spTransport.setSelection(
            transportKeys.indexOf(Store.settings.transportKind).coerceAtLeast(0)
        )
        spTransport.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                val kind = transportKeys.getOrElse(pos) { "ble" }
                if (kind != Store.settings.transportKind) {
                    deviceAdapter.clear()
                    ObdController.setTransportKind(kind)
                }
                updateTransportHint()
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        updateTransportHint()

        // G 值来源：OBD 总线上没有 G 传感器，必须由用户显式选一个来源
        val gForceLabels = listOf("关闭", "加速度计（真实 G，含横向）", "车速差分（仅纵向）")
        spGForce.adapter = ArrayAdapter(
            requireContext(), android.R.layout.simple_spinner_dropdown_item, gForceLabels
        )
        spGForce.setSelection(Store.settings.gForceMode.coerceIn(0, gForceLabels.lastIndex))
        spGForce.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                if (pos == Store.settings.gForceMode) return
                ObdController.toast("G 值来源：${ObdController.setGForceMode(pos)}")
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }

        // 无车调试入口：往数据总线灌合成波形，让仪表盘动起来
        view.findViewById<MaterialButton>(R.id.btnSimulator).setOnClickListener {
            startActivity(
                android.content.Intent(requireContext(), SimulatorActivity::class.java)
            )
        }

        // CAN 被动探测：找广播帧（转向灯/车门/刹车这类没有标准 PID 的信号）
        view.findViewById<MaterialButton>(R.id.btnCanSniffer).setOnClickListener {
            startActivity(
                android.content.Intent(requireContext(), CanSnifferActivity::class.java)
            )
        }

        // 性能基准：8 个表每帧强制重绘，测霓虹辉光的真实绘制成本
        // （文档 §2.4 反复推迟的那件事 —— 量不出来就没法判断该不该重构渲染层）
        view.findViewById<MaterialButton>(R.id.btnBench).setOnClickListener {
            startActivity(
                android.content.Intent(requireContext(), BenchActivity::class.java)
            )
        }

        // 仪表盘引擎切换：**已放弃 LVGL，这里隐藏开关**（见 docs/LVGL-放弃记录.md）。
        //
        // 为什么不直接删代码：LVGL 那套（cpp/lvgl_bridge.cpp + neon_gauge + LvglDashView）
        // 还留着作为"已放弃的实验"，删它要动 14.4 MB vendored 源码和 CMake，
        // 属于独立的一次动作。先把入口关掉，保证用户拿到的只有 Android 自绘。
        val btnEngine = view.findViewById<MaterialButton>(R.id.btnDashEngine)
        btnEngine.visibility = View.GONE

        btnScan.setOnClickListener {
            deviceAdapter.clear()
            tvDeviceHint.text = "正在扫描…"
            ObdController.startScan()
        }
        btnStopScan.setOnClickListener {
            ObdController.stopScan()
            tvDeviceHint.text = "已停止扫描"
        }
        btnInit.setOnClickListener { doInit() }
        btnDisconnect.setOnClickListener { ObdController.disconnect() }

        bindSwitches(view)
        applyInitResult(ObdController.initResult)
        refresh()
    }

    private fun bindSwitches(view: View) {
        val swSound = view.findViewById<MaterialSwitch>(R.id.swSound)
        val swCsv = view.findViewById<MaterialSwitch>(R.id.swCsv)
        val swMirror = view.findViewById<MaterialSwitch>(R.id.swMirror)
        val swScreenOn = view.findViewById<MaterialSwitch>(R.id.swScreenOn)

        swSound.isChecked = Store.settings.soundEnabled
        swCsv.isChecked = Store.settings.csvEnabled
        swMirror.isChecked = Store.settings.mirrorLogcat
        swScreenOn.isChecked = Store.settings.keepScreenOn

        swSound.setOnCheckedChangeListener { _, c ->
            Store.settings.soundEnabled = c; Store.saveSettings()
            ObdController.audio.enabled = c
        }
        swCsv.setOnCheckedChangeListener { _, c ->
            Store.settings.csvEnabled = c; Store.saveSettings()
            if (c) {
                if (ObdController.engine.running) {
                    ObdController.csv.start(ObdController.engine.activePids.map { it.id })
                } else {
                    ObdController.toast("轮询未启动，连上后自动开始记录")
                }
            } else {
                ObdController.csv.stop()
            }
        }
        swMirror.setOnCheckedChangeListener { _, c ->
            Store.settings.mirrorLogcat = c; Store.saveSettings()
            AppLog.mirrorToLogcat = c
        }
        swScreenOn.setOnCheckedChangeListener { _, c ->
            Store.settings.keepScreenOn = c; Store.saveSettings()
            activity?.let { a ->
                if (c) a.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else a.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        ObdController.addListener(this)
        startTicker()
    }

    override fun onPause() {
        super.onPause()
        ObdController.removeListener(this)
        stopTicker()
    }

    private fun startTicker() {
        stopTicker()
        val r = object : Runnable {
            override fun run() {
                refresh()
                main.postDelayed(this, 800)
            }
        }
        ticker = r
        main.postDelayed(r, 800)
    }

    private fun stopTicker() {
        ticker?.let { main.removeCallbacks(it) }
        ticker = null
    }

    /** 扫描提示随传输方式变化 —— BLE 与 SPP 的设备名与发现速度都不一样 */
    private fun updateTransportHint() {
        if (!isAdded) return
        tvDeviceHint.text = if (Store.settings.transportKind == "spp") {
            "SPP：经典蓝牙发现较慢（约 10~15 秒），扫到后点右侧「连接」"
        } else {
            "BLE：Vgate iCar Pro 2S 通常显示为 iOS-Vlink / V-LINK / Vgate 前缀"
        }
    }

    private fun refresh() {
        if (!isAdded) return
        val state = ObdController.transport.state
        tvState.text = buildString {
            append(ObdController.stateName())
            val n = ObdController.connectedDeviceName
            if (n.isNotBlank()) append(" · ").append(n)
        }
        dot.setBackgroundResource(
            when (state) {
                State.READY -> R.drawable.dot_online
                State.CONNECTING, State.DISCOVERING,
                State.SCANNING -> R.drawable.dot_warn
                else -> R.drawable.dot_offline
            }
        )
        tvHz.text = String.format("%.1f Hz", VehicleBus.sampleHz)

        val snap = VehicleBus.snapshot()
        val ok = snap.count { it.value.ok }
        tvBusInfo.text = String.format("采样率 %.1f Hz / 成功通道 %d / 总通道 %d", VehicleBus.sampleHz, ok, snap.size)

        btnInit.isEnabled = state == State.READY
        btnStopScan.isEnabled = state == State.SCANNING
        btnScan.isEnabled = state != State.SCANNING
    }

    private fun connect(dev: android.bluetooth.BluetoothDevice) {
        AppLog.i(AppLog.M_UI, "用户选择设备")
        ObdController.connect(dev)
        tvDeviceHint.text = "已发起连接，等待服务发现…"
    }

    private fun doInit() {
        val idx = spProtocol.selectedItemPosition.coerceIn(0, protocolKeys.size - 1)
        Store.settings.protocol = protocolKeys[idx]
        Store.saveSettings()

        steps.clear()
        tvInitSteps.text = ""
        btnInit.isEnabled = false
        tvInitInfo.text = "初始化中，请稍候…"

        viewLifecycleOwner.lifecycleScope.launch {
            val r = withContext(Dispatchers.IO) {
                ObdController.initializeAndStart()
            }
            applyInitResult(r)
            if (r.ok) {
                ObdController.toast("初始化成功：${r.protocolName.ifBlank { r.protocolNumber }}")
            } else {
                ObdController.toast("初始化未通过，请查看日志")
            }
        }
    }

    private fun applyInitResult(r: ElmSessionInit?) {
        if (r == null) {
            if (tvInitInfo.text.isNullOrBlank()) tvInitInfo.text = "尚未初始化"
            return
        }
        tvInitInfo.text = buildString {
            append("结果: ").append(if (r.ok) "通过" else "未通过").append('\n')
            append("ELM 版本: ").append(r.version.ifBlank { "-" }).append('\n')
            append("协议: ").append(r.protocolNumber).append(" / ").append(r.protocolName).append('\n')
            append("电瓶电压: ").append(r.voltage.ifBlank { "-" }).append('\n')
            append("0100 探测: ").append(r.probeRaw.take(60).ifBlank { "-" })
        }
        tvInitSteps.text = r.steps.joinToString("\n") { "· ${it.first} → ${it.second.take(28)}" }
    }

    // ------------------------------------------------------------ 回调

    override fun onState(state: State, detail: String) {
        view?.post { refresh() }
    }

    override fun onScanResult(dev: android.bluetooth.BluetoothDevice, name: String, rssi: Int, addr: String) {
        view?.post {
            deviceAdapter.add(dev, name, rssi)
            tvDeviceHint.text = "发现 ${deviceAdapter.size()} 个设备"
        }
    }

    override fun onInitStep(step: String) {
        view?.post {
            steps.add(step)
            tvInitSteps.text = steps.takeLast(8).joinToString("\n") { "· $it" }
        }
    }

    override fun onInitDone(result: ElmSessionInit) {
        view?.post { applyInitResult(result) }
    }
}

/** 类型别名，避免在 Fragment 里到处写全限定名（typealias 必须放在文件顶层） */
private typealias ElmSessionInit = com.icar.obd.obd.ElmSession.InitResult
