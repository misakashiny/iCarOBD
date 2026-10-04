package com.icar.obd.obd

import com.icar.obd.ble.ObdTransport
import com.icar.obd.data.AppLog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import java.util.concurrent.atomic.AtomicReference

/**
 * ELM327 会话层：把「一问一答」的串口语义封装成 suspend 调用。
 *
 * 约定：传输侧每收到一个 '>' 就是一帧完整响应（各 [ObdTransport] 实现已按此切分），
 * 因此一次 request 对应一次 onRx 回调。
 */
class ElmSession(private val transport: ObdTransport) {

    private val mutex = Mutex()
    private val waiter = AtomicReference<CompletableDeferred<String>?>(null)

    @Volatile
    var lastTx: String = ""
        private set
    @Volatile
    var lastRx: String = ""
        private set

    /** 由 BleTransport 回调线程调用 */
    fun onRx(frame: String) {
        lastRx = frame
        waiter.get()?.complete(frame)
    }

    /**
     * 发送一条命令并等待响应。
     * @return 响应文本；超时返回空串（调用方按「无响应」处理）
     */
    suspend fun request(cmd: String, timeoutMs: Long = 2000): String = mutex.withLock {
        val d = CompletableDeferred<String>()
        waiter.set(d)
        transport.flushRx()
        val tx = cmd.trim()
        lastTx = tx
        AppLog.v(AppLog.M_OBD, "TX", tx)
        transport.send(tx + "\r")
        try {
            val r = withTimeout(timeoutMs) { d.await() }
            AppLog.v(AppLog.M_OBD, "RX", r)
            r
        } catch (e: TimeoutCancellationException) {
            AppLog.w(AppLog.M_OBD, "超时无响应", "cmd=$tx timeout=${timeoutMs}ms")
            ""
        } catch (t: Throwable) {
            AppLog.e(AppLog.M_OBD, "请求异常", "cmd=$tx ${t.message}")
            ""
        } finally {
            waiter.set(null)
        }
    }

    /**
     * 初始化 ELM327。
     * @return 初始化结果描述（含探测到的协议）
     */
    suspend fun initialize(protocol: Int, onStep: ((String) -> Unit)? = null): InitResult {
        AppLog.i(AppLog.M_OBD, "开始初始化 ELM327", "protocol=$protocol")
        val steps = ArrayList<Pair<String, String>>()
        for (cmd in ObdProtocol.initSequence(protocol)) {
            val c = cmd.trim()
            val r = request(c, 3000)
            steps.add(c to r)
            onStep?.invoke("$c → ${r.take(60)}")
            if (c == "ATZ") {
                // 复位后 ELM 会重启，给它一点时间
                kotlinx.coroutines.delay(600)
            }
        }
        val idn = request("ATI", 2000)
        val protoNum = request("ATDPN", 2000)
        val protoName = request("ATDP", 2000)
        val voltage = request("ATRV", 2000)

        // 用 0100 探测：能返回位图说明总线通了
        val probe = request("0100", 4000)
        val ok = !ObdProtocol.isError(probe) && probe.isNotBlank()
        AppLog.i(
            AppLog.M_OBD, "初始化完成",
            "ok=$ok idn=$idn proto=$protoNum/$protoName volt=$voltage"
        )
        return InitResult(ok, idn.trim(), protoNum.trim(), protoName.trim(), voltage.trim(), probe.trim(), steps)
    }

    data class InitResult(
        val ok: Boolean,
        val version: String,
        val protocolNumber: String,
        val protocolName: String,
        val voltage: String,
        val probeRaw: String,
        val steps: List<Pair<String, String>>
    )

    /** 读取电瓶电压（ATRV），不依赖总线 */
    suspend fun readVoltage(): String = request("ATRV", 1500).trim()

    /** 执行一条原始命令（编辑器/扫描器用），返回原始响应 */
    suspend fun raw(cmd: String, timeoutMs: Long = 2000): String = request(cmd, timeoutMs)
}
