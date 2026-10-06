package com.icar.obd.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.icar.obd.data.AppLog
import com.icar.obd.ble.ObdTransport.Callback
import com.icar.obd.ble.ObdTransport.State
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * BLE 传输层。只负责「把字节送出去 / 把字节收回来」，不理解 OBD 语义。
 *
 * Vgate iCar Pro 2S 这类设备在 BLE 上就是一个串口透传（UART over GATT），
 * 但不同批次的服务/特征 UUID、以及**写类型**都不一致，所以这里的策略是：
 *
 *   1. **先转储整张 GATT 表**（[dumpGattTable]）—— 把「猜」变成「看」。
 *      实车排查时这张表是唯一可靠的依据，务必先看它。
 *   2. 已知 UUID 组合优先，但**必须通过属性校验**（有 write 属性才算写特征、
 *      有 notify/indicate 才算通知特征）。历史上这里只比对 UUID 不看属性，
 *      导致把通知特征当成写特征用，`writeCharacteristic` 永远返回 false。
 *   3. 写类型自适应：优先 `WRITE_TYPE_NO_RESPONSE`（透传模块几乎都只支持它），
 *      失败自动切到 `WRITE_TYPE_DEFAULT` 再试。
 *   4. 写入失败**有界重试且不刷屏** —— 早期版本每次失败都写一条日志并无限重排，
 *      实车上 2 小时刷了 113 万行日志（57MB），把日志页也一起拖崩了。
 */
class BleTransport(private val ctx: Context) : ObdTransport {

    override val kind: String get() = "BLE"

    override var callback: Callback? = null

    override var rawMode: Boolean = false

    private val main = Handler(Looper.getMainLooper())
    private val btManager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? get() = btManager.adapter

    @Volatile
    override var state: State = State.IDLE
        private set

    private var gatt: BluetoothGatt? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    private var notifyChar: BluetoothGattCharacteristic? = null

    @Volatile
    var serviceUuid: String = ""
        private set
    @Volatile
    var writeUuid: String = ""
        private set
    @Volatile
    var notifyUuid: String = ""
        private set

    /** 当前实际使用的写类型，便于日志与排障 */
    @Volatile
    var writeTypeUsed: String = "-"
        private set

    /** 累计写失败次数（UI 可据此提示用户换特征） */
    @Volatile
    var writeFailureCount: Int = 0
        private set

    /**
     * [rxBuf] 的互斥锁。
     *
     * ⚠️ **必须加锁**：`rxBuf` 会被**两个线程**碰 ——
     *  - BLE 回调线程：`onCharacteristicChanged` → [onRawBytes]（`append` / `delete`）
     *  - 轮询协程（`Dispatchers.IO`）：`ElmSession.request` → [flushRx]（`setLength`）
     *
     * `StringBuilder` **不是线程安全的**。并发的 `append` / `delete` / `setLength`
     * 会丢更新、把内部 `count` 改坏；随后 `setLength(0)` 读到**负数长度**，
     * `Arrays.fill` 抛 `ArrayIndexOutOfBoundsException` → **进程 FATAL**。
     *
     * 2026-10-06 实车首次复现：GATT 竞态修好、真数据开始流之后 **16 秒**就崩
     * （`BleTransport.kt:603` → `Array index out of range: -24`）。
     * 之前从来没崩过，是因为**一个字节都收不到** —— 那个问题把这个问题盖住了。
     *
     * 协议层「一问一答」**不等于字节层单线程**，所以锁必须加在这一层。
     */
    private val rxLock = Any()
    private val rxBuf = StringBuilder()
    private val writeQueue = ConcurrentLinkedQueue<Chunk>()
    @Volatile private var writePending = false
    @Volatile private var mtu = 20
    /** 优先使用 write-without-response；失败后自动翻转 */
    @Volatile private var preferNoResponse = true
    /** 保证同一时刻最多只有一个待执行的重试任务，避免重试风暴 */
    @Volatile private var retryScheduled = false
    /** 限流：写失败日志最多每 5 秒一条 */
    @Volatile private var lastWriteFailLog = 0L

    /**
     * 「开通知」这个 GATT 操作是否已经发起过。
     *
     * `onMtuChanged` 和 MTU 兜底**都会调** `enableNotifyIfNeeded` —— 只能做一次，
     * 否则又会变成两个 GATT 操作撞车（那正是 v1.18.1 修的病）。
     */
    @Volatile private var notifyStarted = false

    /**
     * 描述符写（CCCD）还在等回调。
     *
     * ⚠️ **这是判据本身，不能拿 `state == DISCOVERING` 代替** ——
     * `onMtuChanged` 会先把 state 推到 READY，于是原来那个兜底**永远不触发**（v1.18.1 修）。
     */
    @Volatile private var cccdPending = false

    /** 本次连接是否已经因为「CCCD 回调丢失」重连过（防止重连风暴） */
    @Volatile private var cccdRetried = false

    private class Chunk(val bytes: ByteArray, var attempts: Int = 0)

    private fun setState(s: State, detail: String = "") {
        state = s
        main.post { callback?.onStateChanged(s, detail) }
    }

    // ------------------------------------------------------------ 扫描

    private val scanCb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val d = result.device ?: return
            val name = runCatching { d.name }.getOrNull() ?: "(未知)"
            main.post { callback?.onScanResult(d, name, result.rssi, d.address) }
        }

        override fun onScanFailed(errorCode: Int) {
            AppLog.e(AppLog.M_BLE, "扫描失败", "code=$errorCode")
            setState(State.IDLE, "扫描失败 code=$errorCode")
        }
    }

    @SuppressLint("MissingPermission")
    override fun startScan(nameFilter: String?) {
        val scanner = adapter?.bluetoothLeScanner
        if (scanner == null) {
            AppLog.e(AppLog.M_BLE, "蓝牙不可用")
            setState(State.IDLE, "蓝牙不可用")
            return
        }
        val filters = ArrayList<ScanFilter>()
        val st = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .setReportDelay(0)
            .build()
        runCatching { scanner.stopScan(scanCb) }
        scanner.startScan(filters, st, scanCb)
        setState(State.SCANNING, "正在扫描…")
        AppLog.i(AppLog.M_BLE, "开始扫描 BLE 设备")
    }

    @SuppressLint("MissingPermission")
    override fun stopScan() {
        runCatching { adapter?.bluetoothLeScanner?.stopScan(scanCb) }
        if (state == State.SCANNING) setState(State.IDLE, "已停止扫描")
    }

    // ------------------------------------------------------------ 连接

    @SuppressLint("MissingPermission")
    override fun connect(device: BluetoothDevice) {
        stopScan()
        setState(State.CONNECTING, "连接 ${device.address}")
        AppLog.i(AppLog.M_BLE, "发起连接", "addr=${device.address} name=${runCatching { device.name }.getOrNull()}")
        gatt = device.connectGatt(ctx, false, gattCb, BluetoothDevice.TRANSPORT_LE)
    }

    private val gattCb = object : BluetoothGattCallback() {

        @SuppressLint("MissingPermission")
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                AppLog.i(AppLog.M_BLE, "GATT 已连接", "status=$status")
                setState(State.DISCOVERING, "发现服务中…")
                runCatching { g.discoverServices() }
                    .onFailure { AppLog.e(AppLog.M_BLE, "discoverServices 失败", it.message ?: "") }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                AppLog.w(AppLog.M_BLE, "GATT 断开", "status=$status")
                synchronized(rxLock) { rxBuf.setLength(0) }
                writeQueue.clear()
                writePending = false
                retryScheduled = false
                runCatching { g.close() }
                gatt = null
                setState(State.CLOSED, "已断开 status=$status")
            }
        }

        @SuppressLint("MissingPermission")
        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            AppLog.i(AppLog.M_BLE, "服务发现完成", "status=$status")
            // 每次服务发现都重置这三个标志：重连会重新走一遍发现，
            // 不复位的话第二次连接会以为"通知已经开过了"而跳过（v1.18.1）
            notifyStarted = false
            cccdPending = false
            cccdRetried = false
            if (status != BluetoothGatt.GATT_SUCCESS) {
                AppLog.e(AppLog.M_BLE, "服务发现失败", "status=$status")
                setState(State.CLOSED, "服务发现失败 status=$status")
                return
            }
            // 先把整张表写进日志 —— 实车排查时这是唯一可靠的依据
            dumpGattTable()

            val found = probeCharacteristics(g)
            if (!found) {
                AppLog.e(AppLog.M_BLE, "未找到可用的 notify/write 特征")
                setState(State.CLOSED, "未找到可通信特征")
                return
            }
            AppLog.i(AppLog.M_BLE, "选定服务", "svc=$serviceUuid")
            AppLog.i(
                AppLog.M_BLE, "选定特征",
                "write=$writeUuid(${props(writeChar?.properties ?: 0)}) " +
                    "notify=$notifyUuid(${props(notifyChar?.properties ?: 0)})"
            )
            // ⚠️ **两个 GATT 操作不能背靠背发**（v1.18.1 修 —— 这是"写不进去"的真凶）。
            //
            // Android 的硬约束：同一连接**同时只允许一个未完成操作**。
            // 原来这里是 `requestMtu(512)` 紧接着 `enableNotify()`（里面 writeDescriptor），
            // **12ms 内发两个** → 描述符写被丢弃、`onDescriptorWrite` 永远不来 →
            // 栈上挂着未完成操作 → **之后每一次 `writeCharacteristic()` 都返回 false**。
            //
            // 实测（2026-10-06）：`已写 CCCD` 打了、`MTU 协商` 回来了、
            // **`CCCD 写入完成` 没有** → 之后 900+ 条"写入被拒"、一条数据都没有。
            // 而 10-03 那次成功的日志里 `CCCD 写入完成 | status=0` 是**有**的 ——
            // **竞态，时中时不中**。这就是"改了很多版还是不行"的根因。
            //
            // 修法：**先协商 MTU，在 `onMtuChanged` 里再开通知**（串行化）。
            // MTU 不回调时也有兜底，但兜底走的是**同一个** `enableNotifyIfNeeded`。
            runCatching { g.requestMtu(512) }
            main.postDelayed({ enableNotifyIfNeeded(g) }, MTU_FALLBACK_MS)
        }

        override fun onMtuChanged(g: BluetoothGatt, m: Int, status: Int) {
            mtu = (m - 3).coerceIn(20, 512)
            AppLog.i(AppLog.M_BLE, "MTU 协商", "mtu=$m payload=$mtu status=$status")
            // MTU 这个 GATT 操作已经结束 → **现在才可以发下一个**（开通知）
            enableNotifyIfNeeded(g)
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            val bytes = c.value ?: return
            onRawBytes(bytes)
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            writePending = false
            if (status != BluetoothGatt.GATT_SUCCESS) {
                // 写回调报错：说明这个写类型不被接受，翻转后重试
                preferNoResponse = !preferNoResponse
                logWriteFailureThrottled("写回调 status=$status，切换写类型重试")
            }
            pump()
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            AppLog.d(AppLog.M_BLE, "CCCD 写入完成", "status=$status")
            cccdPending = false
            if (state != State.READY) setState(State.READY, "已就绪")
            pump()
        }
    }

    // ------------------------------------------------------------ 特征探测

    /**
     * 已知 UUID 组合：(服务, **通知**, **写**)。
     *
     * ⚠️ 最后一条（Vgate iCar Pro 2S / IOS-Vlink 用的 18F0）**原来写反了** ——
     * 2026-10-05 实车日志里的 GATT 表是：
     *
     * ```
     * SVC 000018f0
     *   CHR 00002af0 | props=NI   ← 通知
     *   CHR 00002af1 | props=WnW  ← 写
     * ```
     *
     * 写反的后果不是"连不上"，而是**每次连接都走一遍属性配对兜底**，
     * 并打一条 `已知 UUID 属性不符，改用属性配对` 的 W 日志 ——
     * 兜底是对的，但表本身错了会让人以为"这个适配器不标准"。
     */
    private val KNOWN = listOf(
        Triple("0000fff0-0000-1000-8000-00805f9b34fb", "0000fff1-0000-1000-8000-00805f9b34fb", "0000fff2-0000-1000-8000-00805f9b34fb"),
        Triple("6e400001-b5a3-f393-e0a9-e50e24dcca9e", "6e400003-b5a3-f393-e0a9-e50e24dcca9e", "6e400002-b5a3-f393-e0a9-e50e24dcca9e"),
        Triple("0000ffe0-0000-1000-8000-00805f9b34fb", "0000ffe1-0000-1000-8000-00805f9b34fb", "0000ffe1-0000-1000-8000-00805f9b34fb"),
        // 通知 2AF0 / 写 2AF1（实车 GATT 表实测；属性校验仍然会兜住反过来的适配器）
        Triple("000018f0-0000-1000-8000-00805f9b34fb", "00002af0-0000-1000-8000-00805f9b34fb", "00002af1-0000-1000-8000-00805f9b34fb")
    )

    private fun u(s: String) = UUID.fromString(s)

    private fun hasWrite(c: BluetoothGattCharacteristic): Boolean =
        c.properties and (BluetoothGattCharacteristic.PROPERTY_WRITE or
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0

    private fun hasNotify(c: BluetoothGattCharacteristic): Boolean =
        c.properties and (BluetoothGattCharacteristic.PROPERTY_NOTIFY or
            BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0

    /** 属性位解码，日志里一眼能看懂 */
    private fun props(p: Int): String {
        val sb = StringBuilder()
        if (p and BluetoothGattCharacteristic.PROPERTY_BROADCAST != 0) sb.append("B")
        if (p and BluetoothGattCharacteristic.PROPERTY_READ != 0) sb.append("R")
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) sb.append("Wn")
        if (p and BluetoothGattCharacteristic.PROPERTY_WRITE != 0) sb.append("W")
        if (p and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) sb.append("N")
        if (p and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) sb.append("I")
        return if (sb.isEmpty()) "none(0x${Integer.toHexString(p)})" else sb.toString()
    }

    /**
     * 把整张 GATT 表写进日志。
     *
     * 这是实车排障最重要的一步：不同批次的 ELM327 BLE 模块服务/特征/属性都不一样，
     * 光看「连上了」没法判断该往哪个特征写、用什么写类型。
     */
    @SuppressLint("MissingPermission")
    fun dumpGattTable() {
        val g = gatt ?: run {
            AppLog.w(AppLog.M_BLE, "GATT 表不可用（未连接）")
            return
        }
        val services = g.services ?: return
        AppLog.i(AppLog.M_BLE, "===== GATT 表开始 =====", "服务数=${services.size}")
        services.forEach { s ->
            AppLog.i(AppLog.M_BLE, "SVC ${s.uuid}")
            s.characteristics.forEach { c ->
                AppLog.i(
                    AppLog.M_BLE, "  CHR ${c.uuid}",
                    "props=${props(c.properties)} writeType=${c.writeType} " +
                        "dsc=${c.descriptors.size}"
                )
                c.descriptors.forEach { d ->
                    AppLog.i(AppLog.M_BLE, "      DSC ${d.uuid}", "perm=${d.permissions}")
                }
            }
        }
        AppLog.i(AppLog.M_BLE, "===== GATT 表结束 =====")
    }

    @SuppressLint("MissingPermission")
    private fun probeCharacteristics(g: BluetoothGatt): Boolean {
        val services = g.services ?: return false

        // 1) 已知组合：UUID 命中 **且属性校验通过**
        for ((svc, nfy, wrt) in KNOWN) {
            val s = services.firstOrNull { it.uuid == u(svc) } ?: continue
            val n = s.characteristics.firstOrNull { it.uuid == u(nfy) }
            val w = s.characteristics.firstOrNull { it.uuid == u(wrt) }

            if (n != null && w != null && hasNotify(n) && hasWrite(w)) {
                select(s.uuid.toString(), n, w)
                return true
            }

            // UUID 命中但属性不符 —— 这正是历史上写不出去的原因，必须显式记下来
            if (n != null || w != null) {
                AppLog.w(
                    AppLog.M_BLE, "已知 UUID 属性不符，改用属性配对",
                    "svc=$svc notify=${n?.let { props(it.properties) } ?: "无"} " +
                        "write=${w?.let { props(it.properties) } ?: "无"}"
                )
            }
            // 同一个服务内按属性重新配对
            val n2 = s.characteristics.firstOrNull { hasNotify(it) }
            val w2 = s.characteristics.firstOrNull { hasWrite(it) }
            if (n2 != null && w2 != null) {
                select(s.uuid.toString(), n2, w2)
                return true
            }
        }

        // 2) 通用探测：同一服务内具备 notify + write 的组合，选服务 UUID 排序靠前的
        var best: Triple<BluetoothGattCharacteristic, BluetoothGattCharacteristic, String>? = null
        for (s in services) {
            val n = s.characteristics.firstOrNull { hasNotify(it) } ?: continue
            val w = s.characteristics.firstOrNull { hasWrite(it) } ?: continue
            val cand = Triple(n, w, s.uuid.toString())
            if (best == null || cand.third < best!!.third) best = cand
        }
        if (best != null) {
            select(best.third, best.first, best.second)
            AppLog.w(AppLog.M_BLE, "未命中已知 UUID，使用通用探测结果")
            return true
        }
        return false
    }

    private fun select(svc: String, n: BluetoothGattCharacteristic, w: BluetoothGattCharacteristic) {
        serviceUuid = svc
        notifyChar = n
        writeChar = w
        notifyUuid = n.uuid.toString()
        writeUuid = w.uuid.toString()
        // 透传模块几乎都只支持 write-without-response，先按它来
        preferNoResponse = w.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
    }

    /** 手动切换特征（UI 探测列表用） */
    @SuppressLint("MissingPermission")
    fun useCharacteristic(svc: UUID, notify: UUID, write: UUID): Boolean {
        val g = gatt ?: return false
        val s = g.services.firstOrNull { it.uuid == svc } ?: return false
        val n = s.characteristics.firstOrNull { it.uuid == notify } ?: return false
        val w = s.characteristics.firstOrNull { it.uuid == write } ?: return false
        notifyChar?.let { runCatching { g.setCharacteristicNotification(it, false) } }
        select(svc.toString(), n, w)
        enableNotify(g)
        return true
    }

    /**
     * 开通知 —— **只做一次**，且必须在 MTU 操作结束之后调（v1.18.1）。
     *
     * 为什么要有这个包装：`onMtuChanged`（正常路径）与 MTU 超时兜底（异常路径）
     * 都会走到这里，两个都发 `writeDescriptor` 就又变成 GATT 操作撞车。
     */
    @SuppressLint("MissingPermission")
    private fun enableNotifyIfNeeded(g: BluetoothGatt) {
        if (notifyStarted) return
        notifyStarted = true
        enableNotify(g)
    }

    @SuppressLint("MissingPermission")
    private fun enableNotify(g: BluetoothGatt) {
        val c = notifyChar ?: return
        runCatching { g.setCharacteristicNotification(c, true) }
            .onFailure { AppLog.e(AppLog.M_BLE, "开启通知失败", it.message ?: "") }

        // 标准 CCCD 优先；找不到就用该特征上任意一个描述符兜底
        // （有些模块的 CCCD 不是 0x2902，但功能等价）
        val std = c.getDescriptor(u("00002902-0000-1000-8000-00805f9b34fb"))
        val cccd = std ?: c.descriptors.firstOrNull()
        if (cccd != null) {
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            val ok = runCatching { g.writeDescriptor(cccd) }.getOrDefault(false)
            if (ok) {
                AppLog.i(AppLog.M_BLE, "已写 CCCD", "uuid=${cccd.uuid} 标准=${std != null}")
                cccdPending = true
                main.postDelayed({
                    // ⚠️ 判据是 `cccdPending`，**不是 `state == DISCOVERING`**（v1.18.1 修）。
                    // 后者会被 `onMtuChanged` 先推成 READY，于是这个兜底**永远不触发** ——
                    // 描述符回调丢了、App 照样宣布"已就绪"，然后开始疯狂写入、全部被拒。
                    if (!cccdPending) return@postDelayed
                    cccdPending = false
                    AppLog.e(
                        AppLog.M_BLE, "CCCD 回调丢失 —— GATT 栈已卡死",
                        "后续 writeCharacteristic 会全部被拒（实测一次刷了 900+ 条）。" +
                            if (cccdRetried) "已重连过一次，不再自动重试 —— 请手动断开重连"
                            else "自动重连一次"
                    )
                    if (!cccdRetried) {
                        cccdRetried = true
                        // 栈上挂着未完成的描述符写，继续写毫无意义 —— 断开，走既有的自动重连
                        runCatching { g.disconnect() }
                    } else {
                        // 兜不住也得让上层能跑（有些固件确实不回调，但通知是通的）
                        setState(State.READY, "已就绪（CCCD 未确认）")
                        pump()
                    }
                }, CCCD_TIMEOUT_MS)
                return
            }
            AppLog.w(AppLog.M_BLE, "写 CCCD 失败", "uuid=${cccd.uuid}")
        } else {
            AppLog.w(
                AppLog.M_BLE, "该通知特征没有任何描述符",
                "仅靠 setCharacteristicNotification 尝试收数据；若收不到请检查 GATT 表"
            )
        }
        if (state != State.READY) setState(State.READY, "已就绪")
        pump()
    }

    // ------------------------------------------------------------ 收发

    override fun send(text: String) {
        val all = text.toByteArray(Charsets.US_ASCII)
        var off = 0
        while (off < all.size) {
            val len = mtu.coerceAtMost(all.size - off)
            writeQueue.add(Chunk(all.copyOfRange(off, off + len)))
            off += len
        }
        pump()
    }

    /**
     * 写失败的日志**必须节流**（W 与 E 共用同一把闸）。
     *
     * 为什么：轮询是 ~8Hz，写失败时每条请求都走一遍
     * 「被拒 → 换写类型重试 → 放弃」，一次就产生 2~3 行。
     * **没接适配器时空转一小时能刷出上千行** —— 实测 2026-10-06：
     * 1 小时 **902 条 E + 191 条 W**，占整份日志 **67%**，而其中**一条有效数据都没有**。
     * 这正是 v1.3.0 那场 57MB 事故的同一个机制（"单点刷屏"）。
     *
     * ⚠️ `AppLog` 自带的重复抑制**在这里帮不上忙**：extra 里有「写失败累计=N」，
     * 每次都不同 → 去重键不同 → 抑制不了。**节流只能在调用点做。**
     */
    private fun logWriteFailureThrottled(msg: String, extra: String? = null, isError: Boolean = false) {
        val now = System.currentTimeMillis()
        if (now - lastWriteFailLog < WRITE_FAIL_LOG_INTERVAL_MS) return
        lastWriteFailLog = now
        val e = extra ?: "写失败累计=$writeFailureCount 特征=$writeUuid 类型=$writeTypeUsed"
        if (isError) AppLog.e(AppLog.M_BLE, msg, e) else AppLog.w(AppLog.M_BLE, msg, e)
    }

    @SuppressLint("MissingPermission")
    private fun pump() {
        if (writePending) return
        if (state != State.READY && state != State.DISCOVERING) return
        val g = gatt ?: return
        val c = writeChar ?: return
        val item = writeQueue.poll() ?: return
        writePending = true

        val canNoResp = c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0
        val canResp = c.properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0
        val type = when {
            preferNoResponse && canNoResp -> BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            !preferNoResponse && canResp -> BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            canNoResp -> BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            canResp -> BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            else -> BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        }
        writeTypeUsed = when (type) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE -> "NO_RESPONSE"
            else -> "DEFAULT"
        }

        c.writeType = type
        c.value = item.bytes
        val ok = runCatching { g.writeCharacteristic(c) }.getOrDefault(false)
        if (ok) {
            // 卡死保护：2s 没回调就继续泵
            main.postDelayed({
                if (writePending) { writePending = false; pump() }
            }, 2000)
            return
        }

        // ---- 写失败 ----
        writePending = false
        writeFailureCount++
        item.attempts++

        // 第一次失败：换另一种写类型再试（这是最常见的失败原因）
        if (item.attempts == 1) {
            preferNoResponse = !preferNoResponse
            logWriteFailureThrottled("写入被拒，切换写类型重试")
        }

        if (item.attempts < WRITE_MAX_ATTEMPTS) {
            writeQueue.add(item)
            scheduleRetry()
        } else {
            // 超过上限：丢弃这一片，并清空队列，避免永久堵死。
            writeQueue.clear()
            // ⚠️ 这条以前是**不节流的** —— 902 条 E 就是它刷出来的（见 logWriteFailureThrottled）
            logWriteFailureThrottled(
                "BLE 写入持续失败，已放弃本次数据",
                "特征=$writeUuid 属性=${props(c.properties)} 已试=$WRITE_MAX_ATTEMPTS 次 " +
                    "累计=$writeFailureCount",
                isError = true
            )
        }
    }

    /** 重试去抖：同一时刻只允许一个待执行的重试，避免实车上出现重试风暴 */
    private fun scheduleRetry() {
        if (retryScheduled) return
        retryScheduled = true
        main.postDelayed({
            retryScheduled = false
            pump()
        }, WRITE_RETRY_DELAY_MS)
    }

    /** 收到原始字节。正常按 `>` 切帧；[rawMode] 打开时原样透传（`ATMA` 用） */
    private fun onRawBytes(bytes: ByteArray) {
        val s = String(bytes, Charsets.US_ASCII)
        if (rawMode) {
            // 透传：不切帧。ATMA 是持续流，按 '>' 等永远等不到边界
            if (s.isNotEmpty()) main.post { callback?.onRawChunk(s) }
            return
        }
        // ⚠️ 整段切帧都在锁里：`append` / `indexOf` / `delete` 必须**原子**，
        // 否则与 [flushRx]（轮询协程）并发时会把 StringBuilder 的内部计数改坏。
        // 锁内只做内存操作 —— 日志与回调先收集、出锁后再发，尽量缩短持锁时间。
        val frames = ArrayList<String>(2)
        synchronized(rxLock) {
            rxBuf.append(s)
            var idx = rxBuf.indexOf(">")
            while (idx >= 0) {
                val frame = rxBuf.substring(0, idx)
                rxBuf.delete(0, idx + 1)
                val cleaned = frame.replace("\r", " ").replace("\n", " ").trim()
                if (cleaned.isNotEmpty()) frames.add(cleaned)
                idx = rxBuf.indexOf(">")
            }
        }
        for (cleaned in frames) {
            AppLog.v(AppLog.M_BLE, "RX", cleaned)
            main.post { callback?.onRx(cleaned) }
        }
    }

    /**
     * 清空接收缓冲（每条命令发出前调用，丢掉上一条的残留）。
     *
     * ⚠️ 本方法跑在**轮询协程**（`ElmSession.request`），而写入 `rxBuf` 的
     * [onRawBytes] 跑在 **BLE 回调线程** —— 两者必须走同一把锁（见 [rxLock]）。
     */
    override fun flushRx() { synchronized(rxLock) { rxBuf.setLength(0) } }

    @SuppressLint("MissingPermission")
    override fun disconnect() {
        runCatching { gatt?.disconnect() }
    }

    @SuppressLint("MissingPermission")
    fun close() {
        runCatching { gatt?.close() }
        gatt = null
        setState(State.CLOSED, "已关闭")
    }

    override fun isReady(): Boolean = state == State.READY && gatt != null && writeChar != null

    /** 排障摘要（写日志用）：一眼看到选中的服务/特征/写类型/失败次数 */
    override fun describe(): String =
        "svc=${serviceUuid.ifBlank { "-" }} write=${writeUuid.ifBlank { "-" }}" +
            "($writeTypeUsed) notify=${notifyUuid.ifBlank { "-" }} 写失败=$writeFailureCount"

    companion object {
        /** 单个数据片最多尝试次数，超过就丢弃（不再无限重排） */
        private const val WRITE_MAX_ATTEMPTS = 5
        /** 重试间隔 */
        private const val WRITE_RETRY_DELAY_MS = 60L
        /** 写失败日志限流间隔 */
        private const val WRITE_FAIL_LOG_INTERVAL_MS = 5000L

    /**
     * MTU 请求的兜底等待。到点还没 `onMtuChanged` 就自己去开通知。
     *
     * ⚠️ 兜底走的是**同一个** `enableNotifyIfNeeded` —— 不能另发一次 `writeDescriptor`，
     * 那又会变成两个 GATT 操作撞车（v1.18.1 修的病）。
     */
    private const val MTU_FALLBACK_MS = 1500L

    /**
     * 描述符写（CCCD）等回调的上限。
     *
     * 描述符写正常 <100ms 就回。**2 秒还不回，基本可以判定 GATT 栈卡住了** ——
     * 此时继续 `writeCharacteristic` 只会全部返回 false（实测一次刷 900+ 条），
     * 所以这里要**主动断开重连**，而不是假装"已就绪"继续跑。
     */
    private const val CCCD_TIMEOUT_MS = 2000L
    }
}
