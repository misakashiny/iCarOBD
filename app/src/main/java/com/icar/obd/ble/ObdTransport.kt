package com.icar.obd.ble

import android.bluetooth.BluetoothDevice

/**
 * 传输层抽象。
 *
 * 目的：让「字节怎么送出去 / 怎么收回来」与「OBD 语义」彻底解耦，使得换一种物理链路
 * （BLE GATT ↔ 经典蓝牙 SPP ↔ 将来的 WiFi/TCP）只需**新增一个实现**，
 * [com.icar.obd.obd.ElmSession] 与 [com.icar.obd.obd.ObdController] 一行都不用改。
 *
 * 所有实现都必须满足下面这几条约定，否则上层会出错：
 *
 *  1. **收到一帧完整响应就回调一次 [Callback.onRx]**。ELM327 以 `>` 作提示符，
 *     各实现都按它切帧；上层假定「一次 onRx = 一条完整响应」。
 *  2. [send] 必须**非阻塞**：把数据排进队列即可返回，不能阻塞调用线程
 *     （调用方是轮询协程，阻塞会把整个轮询拖住）。
 *  3. 状态严格按 [State] 流转，且只有 [State.READY] 之后才允许发送数据。
 *  4. [Callback] 的回调**必须在主线程**执行（UI 直接消费，不再自己切线程）。
 *  5. 断开或异常时必须清理内部接收缓冲，避免下次连接读到上一轮的残留字节。
 *
 * 为什么接口里会出现 `BluetoothDevice`：BLE 与 SPP 在 Android 上共用同一套蓝牙设备
 * 对象（只是连接方式不同），沿用它可以让 UI 的扫描列表代码零改动。
 * 将来若要接 WiFi/TCP，再把它换成中立的设备描述符。
 */
interface ObdTransport {

    enum class State { IDLE, SCANNING, CONNECTING, DISCOVERING, READY, CLOSED }

    interface Callback {
        fun onStateChanged(s: State, detail: String)
        fun onScanResult(dev: BluetoothDevice, name: String, rssi: Int, addr: String)
        fun onRx(text: String)

        /**
         * 透传模式下的**原始分片**（未按 `>` 切帧）。
         *
         * 默认空实现 —— 只有 CAN 总线探测用得上它，其余调用方不用关心。
         */
        fun onRawChunk(text: String) {}
    }

    /** 传输方式名，用于 UI 与日志（`"BLE"` / `"SPP"`） */
    val kind: String

    /**
     * 透传模式：收到的字节**不按 `>` 切帧**，而是原样回调 [Callback.onRawChunk]。
     *
     * 为什么需要它：`ATMA`（CAN 总线监听）是**持续流**，不逐行发 `>`。
     * 按约定 1 的切帧逻辑永远等不到帧边界，只能一直攒在缓冲里 —— 什么也拿不到。
     * 打开这个开关就绕过切帧；关闭后**完全恢复原有行为**。
     *
     * 注意：打开期间 [Callback.onRx] 不会被调用，[flushRx] 也失去意义。
     */
    var rawMode: Boolean

    var callback: Callback?

    val state: State

    /** 开始扫描。BLE 走 GATT 扫描，SPP 走经典蓝牙发现；[nameFilter] 可为空表示不过滤 */
    fun startScan(nameFilter: String?)

    fun stopScan()

    fun connect(device: BluetoothDevice)

    fun disconnect()

    /** 非阻塞发送：把文本排进发送队列（实现内部按 MTU/分片自行处理） */
    fun send(text: String)

    /** 丢弃接收缓冲里尚未成帧的残留字节 */
    fun flushRx()

    fun isReady(): Boolean

    /** 排障摘要，写日志用（BLE 带服务/特征/写类型，SPP 带通道信息） */
    fun describe(): String
}
