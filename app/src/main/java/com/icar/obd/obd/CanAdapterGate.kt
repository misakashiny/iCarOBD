package com.icar.obd.obd

/** 准备/收尾与轮询启动的短临界区；不跨任何串口等待持锁。 */
internal object CanAdapterGate {
    val lock = Any()
    private var initialization: Any? = null
    private var pidScan: Any? = null
    val scanning: Boolean get() = synchronized(lock) { pidScan != null }
    fun beginPidScan(blocked: () -> Boolean): Any? = synchronized(lock) {
        if(initialization != null || pidScan != null || blocked()) null
        else Any().also { pidScan=it }
    }
    fun endPidScan(token: Any) = synchronized(lock) { if(pidScan === token) pidScan=null }
    val initializing: Boolean get() = synchronized(lock) { initialization != null }
    fun beginInitialization(blocked: () -> Boolean): Any? = synchronized(lock) {
        if (initialization != null || pidScan != null || blocked()) null
        else Any().also { initialization = it }
    }
    fun endInitialization(token: Any) = synchronized(lock) {
        if (initialization === token) initialization = null
    }
}
