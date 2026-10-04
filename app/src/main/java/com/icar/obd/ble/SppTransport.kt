package com.icar.obd.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.icar.obd.data.AppLog
import com.icar.obd.ble.ObdTransport.Callback
import com.icar.obd.ble.ObdTransport.State
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * 经典蓝牙 SPP（RFCOMM）传输层。
 *
 * ## 为什么需要它
 *
 * Vgate iCar Pro 有几个变体：`iCar Pro 2S` 是 **BLE 4.0**（走 [BleTransport]），
 * 而 **`iCar Pro BT3.0` 是经典蓝牙 SPP**。后者在 BLE 扫描里**根本不会出现**，
 * 表现为「扫不到设备」；或者连上了但 GATT 表里没有任何可写特征。
 *
 * ## 与 BLE 的关键差异（都体现在下面的实现里）
 *
 * | | BLE（[BleTransport]） | SPP（本类） |
 * |---|---|---|
 * | 扫描 | `BluetoothLeScanner` 回调 | `startDiscovery()` + `ACTION_FOUND` 广播 |
 * | 连接 | `connectGatt` + 服务发现 + 写特征 | `createRfcommSocketToServiceRecord` + `socket.connect()` |
 * | 传输 | 按 MTU 分片写特征 | 直接往 `OutputStream` 写 |
 * | 阻塞性 | 全异步 | **`connect()` / `read()` 都是阻塞调用** → 必须放后台线程 |
 * | 中间态 | 有 `DISCOVERING`（发现服务） | 无，连上即 `READY` |
 *
 * 上层（[com.icar.obd.obd.ElmSession]）只依赖 [ObdTransport]，所以切换传输方式
 * 不需要改任何上层代码。
 *
 * ## 沿用的两条红线
 *
 * - **发送必须非阻塞**：`send()` 只入队，真正的 `write()` 在 `spp-io` 线程做。
 * - **失败必须有界且不刷屏**：写失败按 5 秒限流记日志，队列超限直接清空，
 *   绝不重演实车上「无限重试 + 逐次写日志刷出 113 万行」的事故。
 */
class SppTransport(private val ctx: Context) : ObdTransport {

    override val kind: String get() = "SPP"

    override var rawMode: Boolean = false

    override var callback: Callback? = null

    @Volatile
    override var state: State = State.IDLE
        private set

    private val main = Handler(Looper.getMainLooper())
    private val btManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? get() = btManager.adapter

    /** 连接与写入用的单线程池（`connect()` / `write()` 都会阻塞，不能放主线程） */
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "spp-io").apply { isDaemon = true }
    }

    /** 读循环**单独起线程**：它长期占用线程，不能塞进 io 池，否则后续写/断开会排队等它 */
    private var readThread: Thread? = null

    private var socket: BluetoothSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null

    @Volatile
    private var reading = false

    /** rxBuf 会被读线程与调用线程（flushRx）同时访问，必须加锁 */
    private val rxLock = Any()
    private val rxBuf = StringBuilder()

    private val writeQueue = ConcurrentLinkedQueue<ByteArray>()

    @Volatile
    private var writePending = false

    @Volatile
    private var writeFailureCount = 0

    @Volatile
    private var lastWriteFailLog = 0L

    @Volatile
    private var receiverRegistered = false

    @Volatile
    var connectedAddress: String = ""
        private set

    private fun setState(s: State, detail: String = "") {
        state = s
        main.post { callback?.onStateChanged(s, detail) }
    }

    // ---------------------------------------------------------------- 扫描

    private val discoveryReceiver = object : BroadcastReceiver() {
        @Suppress("DEPRECATION")
        override fun onReceive(c: Context?, intent: Intent?) {
            when (intent?.action) {
                BluetoothDevice.ACTION_FOUND -> {
                    val d = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE)
                        ?: return
                    val rssi = intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE).toInt()
                    val name = runCatching { d.name }.getOrNull() ?: "(未知)"
                    main.post { callback?.onScanResult(d, name, rssi, d.address) }
                }
                BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                    AppLog.i(AppLog.M_BLE, "SPP 发现结束")
                    if (state == State.SCANNING) setState(State.IDLE, "发现结束")
                }
            }
        }
    }

    @SuppressLint("MissingPermission")
    override fun startScan(nameFilter: String?) {
        val a = adapter
        if (a == null) {
            AppLog.e(AppLog.M_BLE, "SPP 扫描失败：蓝牙不可用")
            setState(State.IDLE, "蓝牙不可用")
            return
        }
        if (!a.isEnabled) {
            AppLog.e(AppLog.M_BLE, "SPP 扫描失败：蓝牙未开启")
            setState(State.IDLE, "蓝牙未开启")
            return
        }
        if (!receiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(BluetoothDevice.ACTION_FOUND)
                addAction(BluetoothAdapter.ACTION_DISCOVERY_STARTED)
                addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
            }
            // 用 ContextCompat 显式声明 NOT_EXPORTED：targetSdk 34 下必须表态
            runCatching {
                ContextCompat.registerReceiver(
                    ctx, discoveryReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED
                )
            }.onSuccess { receiverRegistered = true }
                .onFailure { AppLog.e(AppLog.M_BLE, "SPP 注册发现广播失败", it.message ?: "") }
        }
        runCatching { if (a.isDiscovering) a.cancelDiscovery() }
        val started = runCatching { a.startDiscovery() }.getOrDefault(false)
        if (!started) {
            AppLog.e(AppLog.M_BLE, "SPP 启动经典蓝牙发现失败")
            setState(State.IDLE, "启动发现失败")
            return
        }
        setState(State.SCANNING, "正在发现经典蓝牙设备…")
        AppLog.i(AppLog.M_BLE, "SPP 开始扫描（经典蓝牙发现）")
    }

    @SuppressLint("MissingPermission")
    override fun stopScan() {
        runCatching { adapter?.cancelDiscovery() }
        if (receiverRegistered) {
            runCatching { ctx.unregisterReceiver(discoveryReceiver) }
            receiverRegistered = false
        }
        if (state == State.SCANNING) setState(State.IDLE, "已停止扫描")
    }

    // ---------------------------------------------------------------- 连接

    @SuppressLint("MissingPermission")
    override fun connect(device: BluetoothDevice) {
        stopScan()
        connectedAddress = device.address
        setState(State.CONNECTING, "连接 ${device.address}（RFCOMM）")
        AppLog.i(
            AppLog.M_BLE, "SPP 发起连接",
            "addr=${device.address} name=${runCatching { device.name }.getOrNull()}"
        )
        io.execute {
            var s: BluetoothSocket? = null
            try {
                // 经典蓝牙发现与 connect 互斥，必须先取消，否则 connect 极容易失败
                runCatching { adapter?.cancelDiscovery() }
                s = device.createRfcommSocketToServiceRecord(SPP_UUID)
                s.connect()
                socket = s
                input = s.inputStream
                output = s.outputStream
                writePending = false
                AppLog.i(AppLog.M_BLE, "SPP 已连接", "addr=${device.address}")
                setState(State.READY, "已就绪（SPP）")
                startReadLoop(s)
            } catch (t: Throwable) {
                AppLog.e(
                    AppLog.M_BLE, "SPP 连接失败",
                    "addr=${device.address} ${t.javaClass.simpleName}: ${t.message}"
                )
                runCatching { s?.close() }
                socket = null; input = null; output = null
                setState(State.CLOSED, "SPP 连接失败：${t.message ?: "未知错误"}")
            }
        }
    }

    /** 读循环：阻塞在 `read()` 上，所以跑在独立线程而不是 io 池里 */
    private fun startReadLoop(s: BluetoothSocket) {
        reading = true
        val t = Thread({
            val buf = ByteArray(READ_BUF)
            val inp = input
            while (reading && inp != null) {
                val n = try {
                    inp.read(buf)
                } catch (e: Throwable) {
                    if (reading) AppLog.w(AppLog.M_BLE, "SPP 读取中断", e.message ?: "")
                    break
                }
                if (n <= 0) break
                onRawBytes(buf.copyOf(n))
            }
            reading = false
            // 读循环退出即链路已断（用户主动断开时 state 已不是 READY，不重复报）
            if (state == State.READY) {
                AppLog.w(AppLog.M_BLE, "SPP 链路已断开")
                cleanup()
                setState(State.CLOSED, "已断开（SPP）")
            }
        }, "spp-read").apply { isDaemon = true }
        readThread = t
        t.start()
    }

    // ---------------------------------------------------------------- 收发

    override fun send(text: String) {
        writeQueue.add(text.toByteArray(Charsets.US_ASCII))
        pump()
    }

    private fun pump() {
        if (writePending) return
        if (state != State.READY) return
        val out = output ?: return
        val item = writeQueue.poll() ?: return
        writePending = true
        io.execute {
            try {
                out.write(item)
                out.flush()
                writePending = false
                pump()
            } catch (t: Throwable) {
                writePending = false
                writeFailureCount++
                logWriteFailureThrottled("SPP 写入失败：${t.message}")
                if (writeQueue.size > WRITE_QUEUE_MAX) {
                    writeQueue.clear()
                    AppLog.e(
                        AppLog.M_BLE, "SPP 写入持续失败，已清空发送队列",
                        "累计失败=$writeFailureCount"
                    )
                }
            }
        }
    }

    private fun logWriteFailureThrottled(msg: String) {
        val now = System.currentTimeMillis()
        if (now - lastWriteFailLog >= WRITE_FAIL_LOG_INTERVAL_MS) {
            lastWriteFailLog = now
            AppLog.w(AppLog.M_BLE, msg, "写失败累计=$writeFailureCount addr=$connectedAddress")
        }
    }

    /** 收到原始字节。正常按 `>` 切帧；[rawMode] 打开时原样透传（`ATMA` 用） */
    private fun onRawBytes(bytes: ByteArray) {
        val s = String(bytes, Charsets.US_ASCII)
        if (rawMode) {
            // 透传：不切帧。ATMA 是持续流，按 '>' 等永远等不到边界
            if (s.isNotEmpty()) main.post { callback?.onRawChunk(s) }
            return
        }
        val frames = ArrayList<String>()
        synchronized(rxLock) {
            rxBuf.append(s)
            var idx: Int
            while (rxBuf.indexOf(">").also { idx = it } >= 0) {
                val frame = rxBuf.substring(0, idx)
                rxBuf.delete(0, idx + 1)
                val cleaned = frame.replace("\r", " ").replace("\n", " ").trim()
                if (cleaned.isNotEmpty()) frames.add(cleaned)
            }
        }
        // 回调放到锁外，避免持锁 post 造成阻塞
        for (f in frames) {
            AppLog.v(AppLog.M_BLE, "SPP RX", f)
            main.post { callback?.onRx(f) }
        }
    }

    override fun flushRx() {
        synchronized(rxLock) { rxBuf.setLength(0) }
    }

    override fun isReady(): Boolean {
        val s = socket ?: return false
        return state == State.READY && s.isConnected && output != null
    }

    override fun describe(): String =
        "rfcomm addr=${connectedAddress.ifBlank { "-" }} " +
            "socket=${if (socket?.isConnected == true) "connected" else "closed"} " +
            "写失败=$writeFailureCount"

    // ---------------------------------------------------------------- 断开

    @SuppressLint("MissingPermission")
    override fun disconnect() {
        reading = false
        runCatching { adapter?.cancelDiscovery() }
        io.execute {
            cleanup()
            setState(State.CLOSED, "已断开（SPP）")
        }
    }

    /** 释放 socket / 流 / 缓冲。可重复调用。 */
    private fun cleanup() {
        reading = false
        runCatching { input?.close() }
        runCatching { output?.close() }
        runCatching { socket?.close() }
        input = null; output = null; socket = null
        writeQueue.clear()
        writePending = false
        flushRx()
    }

    /** 彻底关闭（含注销广播接收器）。退出应用或切换传输方式时调用。 */
    fun close() {
        stopScan()
        disconnect()
    }

    companion object {
        /** 标准 SPP（串口）服务 UUID —— 所有 ELM327 经典蓝牙适配器都用它 */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

        private const val READ_BUF = 1024
        /** 发送队列上限，超过说明链路已坏，直接清空而不是无限堆积 */
        private const val WRITE_QUEUE_MAX = 64
        /** 写失败日志限流间隔（沿用 BLE 侧的策略，避免刷屏） */
        private const val WRITE_FAIL_LOG_INTERVAL_MS = 5000L
    }
}
