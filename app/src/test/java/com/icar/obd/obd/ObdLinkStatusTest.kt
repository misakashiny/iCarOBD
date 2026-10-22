package com.icar.obd.obd

import org.junit.Assert.*
import org.junit.Test

/**
 * P5A-M05 阶段 B/H：连接状态聚合的 JVM 单测。
 *
 * 覆盖任务 §四 要求的全部状态，以及三个**最容易骗人**的陷阱：
 *  1. 蓝牙已连接 ≠ OBD 已成功采样
 *  2. PID 数据过期不能仍显示为实时
 *  3. 模拟数据必须有明显标识
 */
class ObdLinkStatusTest {

    private val now = 1_700_000_000_000L

    private fun snap(
        link: ObdLinkStatus.Link = ObdLinkStatus.Link.READY,
        hasPermission: Boolean = true,
        initStarted: Boolean = true,
        initOk: Boolean? = true,
        engineRunning: Boolean = true,
        active: Int = 5,
        fresh: Int = 5,
        lastDataAt: Long = now,
        simulated: Boolean = false,
        lastError: String? = null,
        reconnecting: Boolean = false
    ) = ObdLinkStatus.Snapshot(
        link = link, hasPermission = hasPermission, initStarted = initStarted, initOk = initOk,
        engineRunning = engineRunning, activePidCount = active, freshPidCount = fresh,
        lastDataAtMs = lastDataAt, nowMs = now, simulated = simulated,
        lastError = lastError, reconnecting = reconnecting
    )

    // ---------------------------------------------------------------- 12 种状态

    @Test
    fun `B1 未连接`() {
        val v = ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.IDLE, initStarted = false, initOk = null, fresh = 0))
        assertEquals(ObdLinkStatus.Phase.IDLE, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B2 正在搜索设备`() {
        val v = ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.SCANNING, initStarted = false, initOk = null, fresh = 0))
        assertEquals(ObdLinkStatus.Phase.SCANNING, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B3 正在连接与发现服务`() {
        assertEquals(
            ObdLinkStatus.Phase.CONNECTING,
            ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.CONNECTING, initStarted = false, initOk = null, fresh = 0)).phase
        )
        assertEquals(
            ObdLinkStatus.Phase.CONNECTING,
            ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.DISCOVERING, initStarted = false, initOk = null, fresh = 0)).phase
        )
    }

    @Test
    fun `B4 已连接但正在初始化适配器`() {
        val v = ObdLinkStatus.evaluate(snap(initStarted = true, initOk = null, fresh = 0))
        assertEquals(ObdLinkStatus.Phase.INITIALIZING, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B5 已连接但尚无有效 PID`() {
        val v = ObdLinkStatus.evaluate(snap(fresh = 0, lastDataAt = 0))
        assertEquals(ObdLinkStatus.Phase.CONNECTED_NO_DATA, v.phase)
        assertFalse("已连接不等于有数据", v.dataLive)
        assertTrue("原因必须说清楚", v.reason.contains("还没有有效值") || v.reason.contains("没有有效值"))
    }

    @Test
    fun `B6 正在采集`() {
        val v = ObdLinkStatus.evaluate(snap())
        assertEquals(ObdLinkStatus.Phase.SAMPLING, v.phase)
        assertTrue(v.dataLive)
        assertTrue("应报出有值条数", v.reason.contains("5/5"))
    }

    @Test
    fun `B7 连接超时（初始化失败）`() {
        val v = ObdLinkStatus.evaluate(snap(initOk = false, fresh = 0, lastError = "适配器无响应"))
        assertEquals(ObdLinkStatus.Phase.TIMEOUT, v.phase)
        assertEquals("适配器无响应", v.reason)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B8 设备主动断开`() {
        val v = ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.CLOSED, fresh = 0, lastError = "连接被对端关闭"))
        assertEquals(ObdLinkStatus.Phase.DEVICE_LOST, v.phase)
        assertEquals("连接被对端关闭", v.reason)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B9 数据过期不能仍显示为实时`() {
        // TTL 判定还认为"有值"（fresh>0），但最近一次更新已经是 30 秒前
        val v = ObdLinkStatus.evaluate(snap(fresh = 3, lastDataAt = now - 30_000))
        assertEquals(ObdLinkStatus.Phase.STALE, v.phase)
        assertFalse("过期数据绝不能当实时", v.dataLive)
        assertTrue("要告诉用户多久没更新", v.reason.contains("秒前"))
    }

    @Test
    fun `B9b 刚过阈值才算过期，未过阈值仍是采集`() {
        // 4.9 秒 < 5 秒阈值 → 仍然实时
        assertEquals(
            ObdLinkStatus.Phase.SAMPLING,
            ObdLinkStatus.evaluate(snap(fresh = 3, lastDataAt = now - 4_900)).phase
        )
        // 5.1 秒 > 阈值 → 过期
        assertEquals(
            ObdLinkStatus.Phase.STALE,
            ObdLinkStatus.evaluate(snap(fresh = 3, lastDataAt = now - 5_100)).phase
        )
    }

    @Test
    fun `B10 正在重新连接`() {
        val v = ObdLinkStatus.evaluate(snap(reconnecting = true, fresh = 0))
        assertEquals(ObdLinkStatus.Phase.RECONNECTING, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B11 权限不足`() {
        val v = ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.IDLE, hasPermission = false, fresh = 0))
        assertEquals(ObdLinkStatus.Phase.NO_PERMISSION, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `B12 模拟数据运行中必须明显标识`() {
        val v = ObdLinkStatus.evaluate(snap(simulated = true, fresh = 4))
        assertTrue("simulated 必须为 true", v.simulated)
        assertTrue("必须说明这不是真车数据", v.reason.contains("模拟"))
        assertTrue(v.reason.contains("不是真实车辆") || v.reason.contains("非真实"))
    }

    @Test
    fun `B12b 模拟源开着但没产出也要如实说`() {
        val v = ObdLinkStatus.evaluate(snap(simulated = true, fresh = 0))
        assertTrue(v.simulated)
        assertEquals(ObdLinkStatus.Phase.CONNECTED_NO_DATA, v.phase)
        assertFalse(v.dataLive)
    }

    // ---------------------------------------------------------------- 关键陷阱

    @Test
    fun `T1 蓝牙 READY 但初始化没成功 不算可用`() {
        // 这是最容易骗人的：链路 READY，但 initOk=false
        val v = ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.READY, initOk = false, fresh = 0))
        assertNotEquals("不能因为链路 READY 就报采集", ObdLinkStatus.Phase.SAMPLING, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `T2 蓝牙 READY 且初始化成功 但轮询没启动 明确说出来`() {
        val v = ObdLinkStatus.evaluate(snap(engineRunning = false, fresh = 0, lastDataAt = 0))
        assertEquals(ObdLinkStatus.Phase.CONNECTED_NO_DATA, v.phase)
        assertTrue(v.reason.contains("轮询尚未启动"))
    }

    @Test
    fun `T3 没有启用任何 PID 时不会说正在采集`() {
        val v = ObdLinkStatus.evaluate(snap(active = 0, fresh = 0, lastDataAt = 0))
        assertEquals(ObdLinkStatus.Phase.CONNECTED_NO_DATA, v.phase)
        assertTrue(v.reason.contains("没有启用"))
    }

    @Test
    fun `T4 权限优先级最高（即使链路 READY 也不冒充可用）`() {
        val v = ObdLinkStatus.evaluate(snap(hasPermission = false, fresh = 5))
        assertEquals(ObdLinkStatus.Phase.NO_PERMISSION, v.phase)
        assertFalse(v.dataLive)
    }

    @Test
    fun `T5 模拟标识优先于链路状态（避免把模拟当真实）`() {
        // 模拟在跑，同时链路是 CLOSED —— 仍必须告诉用户"这是模拟数据"
        val v = ObdLinkStatus.evaluate(snap(link = ObdLinkStatus.Link.CLOSED, simulated = true, fresh = 2))
        assertTrue(v.simulated)
        assertTrue(v.reason.contains("模拟"))
    }

    // ---------------------------------------------------------------- 阶段 E 诊断摘要

    @Test
    fun `E1 诊断摘要包含阶段 来源 最近数据 PID 计数 最后错误`() {
        val s = snap(fresh = 3, active = 5, lastDataAt = now - 2_000, lastError = "某条 PID 超时")
        val d = ObdLinkStatus.diagnose(
            s, transportKind = "BLE", deviceLabel = "OBD-II",
            okPidCount = 3, failPidCount = 2, lastPollMs = 180
        )
        assertTrue(d.contains("阶段:"))
        assertTrue(d.contains("正在采集"))
        assertTrue(d.contains("真实 OBD"))
        assertTrue(d.contains("BLE"))
        assertTrue(d.contains("2 秒前"))
        assertTrue(d.contains("生效 5"))
        assertTrue(d.contains("有值 3"))
        assertTrue(d.contains("成功 3"))
        assertTrue(d.contains("失败 2"))
        assertTrue(d.contains("180 ms"))
        assertTrue(d.contains("某条 PID 超时"))
    }

    @Test
    fun `E2 从未有过数据时明确写从未`() {
        val d = ObdLinkStatus.diagnose(snap(fresh = 0, lastDataAt = 0), okPidCount = 0, failPidCount = 5)
        assertTrue(d.contains("从未"))
    }

    @Test
    fun `E3 模拟数据在诊断里必须显眼标注`() {
        val d = ObdLinkStatus.diagnose(snap(simulated = true, fresh = 3))
        assertTrue(d.contains("模拟数据"))
        assertTrue(d.contains("非真实车辆"))
    }

    @Test
    fun `E4 诊断摘要不含任何设备地址或 VIN 形态的自动采集`() {
        // 本方法只输出调用方传进来的字段；不传设备地址就不会出现
        val d = ObdLinkStatus.diagnose(snap())
        assertFalse("不应自动带出 MAC 地址", Regex("[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}").containsMatchIn(d))
        assertFalse("不应自动带出 VIN", Regex("\\b[A-HJ-NPR-Z0-9]{17}\\b").containsMatchIn(d))
    }
}
