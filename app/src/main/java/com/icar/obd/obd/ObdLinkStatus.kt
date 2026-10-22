package com.icar.obd.obd

import com.icar.obd.ble.ObdTransport

/**
 * P5A-M05 阶段 B：**用户可见的「现在到底什么状态」**聚合器。
 *
 * ## 为什么需要它
 *
 * 任务 §四：「蓝牙已连接不等于 OBD 已成功采样」。现在的真实情况是：
 *  - `transport.state == READY` 只说明**物理链路**通了
 *  - `engine.running` 只说明**轮询协程**在跑
 *  - `VehicleBus` 里可能有值，也可能全是过期值
 *
 * 这三件事必须**合起来看**才能回答用户的问题。而它们目前散落在三处，
 * 每个界面各自拼一遍，拼错就会出现「显示已连接但其实没有数据」。
 *
 * ## 设计约束（严格遵守任务要求）
 *
 * - **不建第二套状态机**：本类**只读**，不持有、不改写任何既有状态。
 *   它是一个纯函数式的「快照 → 结论」投影。
 * - **结论必须能追溯到具体输入**：每档都写明"因为什么被判成这样"。
 * - **模拟数据必须能被识别**：`simulated = true` 时界面上必须显眼标注。
 *
 * 之所以做成 `object` + 纯函数，是为了能在 JVM 单测里把
 * 「蓝牙已连但无数据」「数据全部过期」「模拟在跑」等组合逐个钉死，
 * 不需要真机、不需要 Android 环境。
 */
object ObdLinkStatus {

    /** 传输层状态（直接取 [ObdTransport.State]，不另立枚举） */
    enum class Link { IDLE, SCANNING, CONNECTING, DISCOVERING, READY, CLOSED }

    /**
     * 用户可见阶段。
     *
     * 顺序即"从最早期到最可用"，[rank] 用于比较。
     */
    enum class Phase(val label: String, val rank: Int) {
        /** 没开始 */
        IDLE("未连接", 0),
        /** 正在找设备 */
        SCANNING("正在搜索设备", 1),
        /** 正在建立链路 */
        CONNECTING("正在连接", 2),
        /** 链路通了，正在初始化 ELM327 */
        INITIALIZING("正在初始化适配器", 3),
        /** 已连接但还没拿到任何有效 PID */
        CONNECTED_NO_DATA("已连接，但还没有有效数据", 4),
        /** 正常采集 */
        SAMPLING("正在采集", 5),
        /** 有数据但全部过期 */
        STALE("数据已过期", 6),
        /** 连接超时 */
        TIMEOUT("连接超时", 7),
        /** 设备主动断开 */
        DEVICE_LOST("设备已断开", 8),
        /** 正在重新连接 */
        RECONNECTING("正在重新连接", 9),
        /** 权限不足 */
        NO_PERMISSION("缺少蓝牙权限", 10)
    }

    /**
     * 一次快照。**全部字段都是既有层的真实值**，不做推断性默认值。
     *
     * @param link            传输层状态（`transport.state`）
     * @param hasPermission   蓝牙权限是否具备
     * @param initStarted     是否已经开始初始化（`initialize()` 已被调用）
     * @param initOk          初始化结果是否成功（null = 还没结果）
     * @param engineRunning   轮询协程是否在跑
     * @param activePidCount  当前生效 PID 条数
     * @param freshPidCount   其中**未过期且有值**的条数（取自 VehicleBus 的 TTL 判定）
     * @param lastDataAtMs    最近一次有效数据的时间戳（0 = 从未）
     * @param nowMs           当前时间
     * @param simulated       当前数据是否来自 Debug 模拟源
     * @param lastError       最后一次错误原因（可为空）
     * @param reconnecting    是否处于自动重连过程中
     */
    data class Snapshot(
        val link: Link,
        val hasPermission: Boolean = true,
        val initStarted: Boolean = false,
        val initOk: Boolean? = null,
        val engineRunning: Boolean = false,
        val activePidCount: Int = 0,
        val freshPidCount: Int = 0,
        val lastDataAtMs: Long = 0L,
        val nowMs: Long = 0L,
        val simulated: Boolean = false,
        val lastError: String? = null,
        val reconnecting: Boolean = false
    )

    /** 判定结果：阶段 + 一句人话原因 + 是否"数据可信" */
    data class Verdict(
        val phase: Phase,
        /** 给用户看的一句话（必须解释**为什么**是这个状态） */
        val reason: String,
        /** 是否**可以当作实时数据看**（false 时界面必须显示 -- 或灰掉） */
        val dataLive: Boolean,
        /** 是否来自模拟源（true 时界面必须显眼标注「模拟数据」） */
        val simulated: Boolean
    )

    /**
     * 数据过期阈值：超过这么久没有新值，就不算"实时"。
     *
     * 取 5 秒：默认轮询间隔 120ms、TTL 默认 = 间隔×3（≥2s），
     * 5 秒足以覆盖一次退避（×4 → 480ms 间隔 ×3 = 1.44s）而不会误报。
     */
    const val STALE_AFTER_MS = 5_000L

    /**
     * 由快照得结论。**判定顺序即优先级**，每一步都写明理由。
     */
    fun evaluate(s: Snapshot): Verdict {
        // ① 权限 —— 没有权限时后面都无从谈起
        if (!s.hasPermission) {
            return Verdict(Phase.NO_PERMISSION, "缺少蓝牙权限，无法搜索或连接适配器", false, s.simulated)
        }

        // ② 模拟数据优先播报（用户必须知道"这不是真车数据"）
        if (s.simulated) {
            val live = s.freshPidCount > 0
            return Verdict(
                if (live) Phase.SAMPLING else Phase.CONNECTED_NO_DATA,
                if (live) "模拟数据运行中（不是真实车辆数据）" else "模拟源已开启，但还没有产出数值",
                live, true
            )
        }

        // ③ 链路层状态
        when (s.link) {
            Link.IDLE -> return Verdict(Phase.IDLE, "未连接：还没有开始搜索设备", false, false)
            Link.SCANNING -> return Verdict(Phase.SCANNING, "正在搜索蓝牙设备", false, false)
            Link.CONNECTING -> return Verdict(Phase.CONNECTING, "正在连接设备", false, false)
            Link.DISCOVERING -> return Verdict(Phase.CONNECTING, "正在连接设备并发现服务", false, false)
            Link.CLOSED -> return Verdict(
                Phase.DEVICE_LOST,
                s.lastError ?: "设备已断开",
                false, false
            )
            Link.READY -> Unit   // 继续往下判
        }

        // ④ 重连中（链路可能已 READY，但业务上在恢复）
        if (s.reconnecting) {
            return Verdict(Phase.RECONNECTING, "正在重新连接", false, false)
        }

        // ⑤ 初始化
        if (!s.initStarted) {
            return Verdict(Phase.INITIALIZING, "链路已通，正在准备初始化适配器", false, false)
        }
        if (s.initOk == null) {
            return Verdict(Phase.INITIALIZING, "正在初始化适配器", false, false)
        }
        if (s.initOk == false) {
            return Verdict(
                Phase.TIMEOUT,
                s.lastError ?: "适配器初始化失败（未响应或协议不支持）",
                false, false
            )
        }

        // ⑥ 到这里：链路通、初始化成功 → 看有没有数据
        //    关键：**蓝牙已连接 ≠ OBD 已成功采样**
        val hasFresh = s.freshPidCount > 0
        if (hasFresh) {
            // 再判一次时间新鲜度：TTL 判定和"最近多久没更新"是两回事
            val age = if (s.lastDataAtMs > 0 && s.nowMs >= s.lastDataAtMs) s.nowMs - s.lastDataAtMs else Long.MAX_VALUE
            if (age > STALE_AFTER_MS) {
                return Verdict(
                    Phase.STALE,
                    "数据已过期（最近一次有效数据在 ${age / 1000} 秒前）",
                    false, false
                )
            }
            return Verdict(
                Phase.SAMPLING,
                "正在采集：${s.freshPidCount}/${s.activePidCount} 条 PID 有有效值",
                true, false
            )
        }

        // ⑦ 通了但没数据：这是最容易骗人的状态，必须说清楚
        if (!s.engineRunning) {
            return Verdict(Phase.CONNECTED_NO_DATA, "已连接，但轮询尚未启动", false, false)
        }
        if (s.activePidCount == 0) {
            return Verdict(Phase.CONNECTED_NO_DATA, "已连接，但没有启用任何 PID", false, false)
        }
        return Verdict(
            Phase.CONNECTED_NO_DATA,
            s.lastError ?: "已连接并在轮询，但 ${s.activePidCount} 条 PID 都还没有有效值",
            false, false
        )
    }

    /**
     * 诊断摘要（阶段 E）。
     *
     * 只用传入的信息，**不读全局状态**，便于测试与脱敏审查。
     * 设备地址/VIN 由调用方决定是否传入 —— 本方法不主动采集可识别信息。
     */
    fun diagnose(
        s: Snapshot,
        transportKind: String = "",
        deviceLabel: String = "",
        okPidCount: Int = -1,
        failPidCount: Int = -1,
        lastPollMs: Long = -1L
    ): String {
        val v = evaluate(s)
        val sb = StringBuilder()
        sb.append("阶段: ").append(v.phase.label)
        if (v.phase.rank >= 0) sb.append("（").append(v.reason).append("）")
        sb.append('\n')
        sb.append("数据来源: ").append(if (s.simulated) "**模拟数据**（非真实车辆）" else "真实 OBD")
        if (transportKind.isNotEmpty()) sb.append(" / ").append(transportKind)
        if (deviceLabel.isNotEmpty()) sb.append(" / ").append(deviceLabel)
        sb.append('\n')
        sb.append("最近有效数据: ").append(
            if (s.lastDataAtMs <= 0) "从未"
            else {
                val age = if (s.nowMs >= s.lastDataAtMs) (s.nowMs - s.lastDataAtMs) / 1000 else 0
                "${age} 秒前"
            }
        ).append('\n')
        sb.append("PID: 生效 ").append(s.activePidCount).append(" / 有值 ").append(s.freshPidCount)
        if (okPidCount >= 0) sb.append(" / 成功 ").append(okPidCount)
        if (failPidCount >= 0) sb.append(" / 失败 ").append(failPidCount)
        sb.append('\n')
        if (lastPollMs >= 0) sb.append("上轮轮询耗时: ").append(lastPollMs).append(" ms\n")
        sb.append("最后错误: ").append(s.lastError ?: "无")
        return sb.toString()
    }
}
