package com.icar.obd.obd

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 轮询路径的**可观测性**与**不刷屏**。
 *
 * 背景：2026-10-05 的实车排障暴露两件事 ——
 *
 * 1. **协议搜索竞态**：`ATSP0` 下第一次真实请求才触发搜索，搜索期间立刻轮询
 *    会被打断（实车 5 次 `STOPPED`）。判据抽成了 [ObdProtocol.protocolLocked]。
 * 2. **成功路径不可见**：失败会大声记，成功一个字都不记，
 *    于是"到底有没有解析成数值"只能靠人肉读 TX/RX。
 *    补了日志之后，**必须钉住它的频率**。
 */
class ObdEngineLoggingTest {

    // ---------------------------------------------------- 协议锁定判据

    @Test
    fun `A0 表示协议还没定下来`() {
        // 实车原样：`0100` 触发搜索之前读到的就是 A0
        assertFalse(ObdProtocol.protocolLocked("A0"))
        assertFalse(ObdProtocol.protocolLocked("a0"))
        assertFalse(ObdProtocol.protocolLocked(" A0 "))
    }

    @Test
    fun `自动协商锁定后带协议号`() {
        // 实车原样：这台车自检出来是 A6（ISO 15765 CAN 11/500）
        assertTrue(ObdProtocol.protocolLocked("A6"))
        assertTrue(ObdProtocol.protocolLocked("A8"))
        assertTrue(ObdProtocol.protocolLocked("A3"))
    }

    @Test
    fun `用户显式指定协议时返回纯数字`() {
        assertTrue(ObdProtocol.protocolLocked("6"))
        assertTrue(ObdProtocol.protocolLocked("8"))
        // 但显式选"自动"（0）等于没定下来
        assertFalse(ObdProtocol.protocolLocked("0"))
    }

    @Test
    fun `空串与错误串都不算锁定`() {
        assertFalse(ObdProtocol.protocolLocked(""))
        assertFalse(ObdProtocol.protocolLocked("NO DATA"))
        assertFalse(ObdProtocol.protocolLocked("CAN ERROR"))
        assertFalse(ObdProtocol.protocolLocked("?"))
        // 超时返回空串，同样是"没读到"
        assertFalse(ObdProtocol.protocolLocked("   "))
    }

    // ---------------------------------------------------- 不刷屏（回归守卫）

    /**
     * **这条是防止有人把日志改回"刷屏"的。**
     *
     * v1.3.0 的事故：实车上 BLE 写入失败进入无限重试并逐次写日志，
     * 2 小时刷出 **113 万行 / 57.9MB**，把日志页一起拖崩。
     *
     * 当时的教训是"任何一处单点刷屏都可能重演"。
     * `AppLog` 的四条自我保护挡的是**异常路径**刷屏（重复消息抑制、文件上限、有界队列、批量派发）——
     * **正常路径的刷屏它挡不住**：每条读数都不一样，去重用不上。
     *
     * 所以轮询汇总的间隔必须钉住。10 秒是下限（= 每小时 360 行，仍然可忽略），
     * 现在的值是 30 秒。
     */
    @Test
    fun `轮询汇总必须是低频的`() {
        assertTrue(
            "轮询汇总间隔不得低于 10 秒 —— 正常路径刷屏 AppLog 的自我保护挡不住" +
                "（实测 SUMMARY_MS=${ObdEngine.SUMMARY_MS}）",
            ObdEngine.SUMMARY_MS >= 10_000L
        )
    }

    /**
     * **链路自检的阈值必须落在合理区间。**
     *
     * 背景（2026-10-06 实测）：v1.17.6 改成"`ok=false` 也启动轮询"之后，
     * **传输层还在、但写入一直被拒**的情况会无限空转 ——
     * 1 小时刷出 **902 条 E + 1691 条 W**（占整份日志 67%），而一条有效数据都没有。
     *
     * 阈值太小 → 误杀"刚连上还在协商"的正常情况（用户会看到莫名其妙的"已停止"）；
     * 太大 → 挡不住日志风暴，等于没加。
     */
    @Test
    fun `链路自检阈值既不能太激进也不能太宽松`() {
        assertTrue(
            "太小会误停正常协商：DEAD_LINK_REQUESTS=${ObdEngine.DEAD_LINK_REQUESTS}",
            ObdEngine.DEAD_LINK_REQUESTS >= 20
        )
        assertTrue(
            "太大挡不住日志风暴：DEAD_LINK_REQUESTS=${ObdEngine.DEAD_LINK_REQUESTS}",
            ObdEngine.DEAD_LINK_REQUESTS <= 200
        )
    }

    /**
     * **「本车不支持」的判定阈值必须落在合理区间**（P10-1）。
     *
     * 太小 → 单次偶发 `NO DATA`（会话刚建立、总线瞬时忙）就把好 PID 停掉；
     * 太大 → 那 5 条不支持的 PID 会一直占着总线刷日志，等于没做这个优化。
     */
    @Test
    fun `不支持判定的阈值不能太激进也不能太宽松`() {
        assertTrue(
            "太小会误判：UNSUPPORTED_STREAK=${ObdEngine.UNSUPPORTED_STREAK}",
            ObdEngine.UNSUPPORTED_STREAK >= 2
        )
        assertTrue(
            "太大挡不住噪音：UNSUPPORTED_STREAK=${ObdEngine.UNSUPPORTED_STREAK}",
            ObdEngine.UNSUPPORTED_STREAK <= 10
        )
    }
}
