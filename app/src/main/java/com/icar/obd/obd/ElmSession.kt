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

    private companion object {
        /** 等自动协议锁定：最多探几次 `ATDPN` */
        const val PROTO_LOCK_TRIES = 6

        /** 两次探测之间的间隔（ms）。6 × 700 ≈ 4.2 秒上限 —— 够慢，也不会让用户以为卡死 */
        const val PROTO_LOCK_DELAY_MS = 700L
    }

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

        // ---- 探测 1：`0100` 能不能**解析出位图**
        //
        // ⚠️ 不能只判"响应里没有错误关键字" —— 2026-10-05 实车日志里，
        // 带 `ATCAF0` 的会话 `0100` 回了 `SEARCHING... 064100981A800300`（没有错误关键字），
        // 于是 ok=true，**但之后每条 PID 都失败**（请求缺 PCI 字节 → ECU 回 NRC 0x13）。
        // 现在要求**真的解析出 4 字节位图**才算通。
        val probe = request("0100", 4000)
        val probeBytes = ObdProtocol.extractData(probe, 1, "00")
        val ok = probeBytes != null && probeBytes.size >= 4
        AppLog.i(
            AppLog.M_OBD, "初始化完成",
            "ok=$ok（**只代表 0100 有响应，不代表后续轮询可用**）" +
                " idn=$idn proto=$protoNum/$protoName volt=$voltage"
        )

        // ---- 等协议锁定（自动协商时）
        //
        // `ATSP0`（自动）下，**第一次真实请求才会触发协议搜索**，搜索期间适配器回
        // `SEARCHING...`。此时立刻开始轮询会**打断搜索**，拿到一串 `STOPPED` ——
        // 2026-10-05 的实车日志正是这样（`0100` 的响应里带 `SEARCHING...`，之后 5 次 `STOPPED`）。
        if (protocol == 0) waitForProtocolLock()

        // ---- 探测 2：再试一个**轮询真正会用的** PID（`01 0C` 转速，OBD-II 强制支持）
        //
        // 为什么必须有这一步：**「0100 通过」≠「轮询可用」** —— 上面那次实车故障正是如此，
        // 而当时的日志里没有任何一行能指出这件事。
        //
        // 只报警告、**不改 ok**：某些车/某些状态下某个 PID 确实可能不回，
        // 算成"初始化失败"会误伤（而且 ok=false 会让轮询根本不启动）。
        val realProbe = request("01 0C", 4000)
        if (ok && ObdProtocol.extractData(realProbe, 1, "0C") == null) {
            val neg = ObdProtocol.negativeReason(realProbe)
            AppLog.w(
                AppLog.M_OBD, "探测通过但真实 PID 无响应",
                "01 0C → ${realProbe.trim().take(60)} | " + (neg
                    ?: "既没有肯定响应也没有否定响应 —— 请求可能没被 ECU 接受（检查 ATCAF / 协议设置）")
            )
        }

        return InitResult(ok, idn.trim(), protoNum.trim(), protoName.trim(), voltage.trim(), probe.trim(), steps)
    }

    /**
     * 等**自动协议搜索**结束。
     *
     * ## 判据为什么用 `ATDPN`
     *
     * ELM327 的 `ATDPN` 返回"当前协议号"，自动协商时前面带一个 `A`：
     *
     * | 返回 | 含义 |
     * |---|---|
     * | `A0` | 自动协商，**协议还没定下来** |
     * | `A6` | 自动协商，已锁定到协议 6（ISO 15765 CAN 11/500） |
     * | `6` | 用户显式指定了协议 6 |
     *
     * 所以"**不是 `A0`**"就是"搜索完成"的可观测判据 ——
     * 比"响应里还有没有 `SEARCHING...`"可靠：后者要重发一条真实请求，
     * 而那正是会打断搜索的动作。
     *
     * 超时不报错、只警告：协议没锁定时**未必**什么都拿不到
     * （实车会话 B 就是在没锁定的状态下偶然拿到了数据），
     * 拦住不让轮询反而更糟。
     *
     * @return 最后一次读到的 `ATDPN`
     */
    private suspend fun waitForProtocolLock(): String {
        var last = ""
        repeat(PROTO_LOCK_TRIES) {
            last = request("ATDPN", 2000).trim()
            if (ObdProtocol.protocolLocked(last)) {
                AppLog.i(AppLog.M_OBD, "协议已锁定", "ATDPN=$last（自动搜索已完成）")
                return last
            }
            kotlinx.coroutines.delay(PROTO_LOCK_DELAY_MS)
        }
        AppLog.w(
            AppLog.M_OBD, "协议未锁定（超时）",
            "ATDPN=$last 尝试=${PROTO_LOCK_TRIES}次 —— 轮询可能拿到 SEARCHING/STOPPED"
        )
        return last
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
