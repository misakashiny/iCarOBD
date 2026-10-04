package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 数据模型里与规则/公式直接相关的纯逻辑（迭代清单 P2-1）。
 *
 * **范围说明**：`toJson` / `fromJson` 依赖 `org.json`（Android 框架类，JVM 单测里是
 * 会抛 `Stub!` 的桩），因此 JSON 往返与旧配置迁移**不在本文件覆盖范围内**，
 * 需要 Robolectric 或仪器测试才能覆盖。这里只测不依赖 Android 的部分。
 */
class PidModelsTest {

    // ---------------------------------------------------------------- CompareOp

    @Test
    fun `六种比较操作符`() {
        assertTrue(CompareOp.GT.test(10f, 5f, null))
        assertFalse(CompareOp.GT.test(5f, 5f, null))

        assertTrue(CompareOp.GE.test(5f, 5f, null))
        assertFalse(CompareOp.GE.test(4f, 5f, null))

        assertTrue(CompareOp.LT.test(4f, 5f, null))
        assertFalse(CompareOp.LT.test(5f, 5f, null))

        assertTrue(CompareOp.LE.test(5f, 5f, null))
        assertFalse(CompareOp.LE.test(6f, 5f, null))

        assertTrue(CompareOp.EQ.test(5f, 5f, null))
        assertFalse(CompareOp.EQ.test(5f, 6f, null))

        assertTrue(CompareOp.NE.test(5f, 6f, null))
        assertFalse(CompareOp.NE.test(5f, 5f, null))
    }

    @Test
    fun `CHANGED 是边沿语义 没有上一帧时不触发`() {
        // 这条很关键：转向灯若用 CHANGED，就要「值一变响一声」而不是「持续响」
        assertFalse("没有上一帧时不应判定为变化", CompareOp.CHANGED.test(1f, 0f, null))
        assertFalse(CompareOp.CHANGED.test(1f, 0f, 1f))
        assertTrue(CompareOp.CHANGED.test(2f, 0f, 1f))
    }

    @Test
    fun `fromSymbol 解析已知符号 未知符号回落 GT`() {
        assertEquals(CompareOp.GT, CompareOp.fromSymbol(">"))
        assertEquals(CompareOp.GE, CompareOp.fromSymbol(">="))
        assertEquals(CompareOp.LT, CompareOp.fromSymbol("<"))
        assertEquals(CompareOp.LE, CompareOp.fromSymbol("<="))
        assertEquals(CompareOp.EQ, CompareOp.fromSymbol("=="))
        assertEquals(CompareOp.NE, CompareOp.fromSymbol("!="))
        assertEquals(CompareOp.CHANGED, CompareOp.fromSymbol("~"))
        assertEquals(CompareOp.GT, CompareOp.fromSymbol("???"))
        assertEquals(CompareOp.GT, CompareOp.fromSymbol(""))
    }

    // ---------------------------------------------------------------- RuleAction

    @Test
    fun `RuleAction describe 覆盖全部六种动作`() {
        assertEquals("播放音效 tick_left", RuleAction("sound", "tick_left").describe())
        assertEquals("弹出提示「水温过高」", RuleAction("toast", "水温过高").describe())
        assertEquals("记录日志「x」", RuleAction("log", "x").describe())
        assertEquals("仪表 p1 变色 red", RuleAction("gauge", "p1", "red").describe())
        assertEquals("仪表 当前 变色 red", RuleAction("gauge", "", "red").describe())
        assertEquals("振动 200ms", RuleAction("vibrate", "200").describe())
        assertEquals("通知「hi」", RuleAction("notify", "hi").describe())
    }

    @Test
    fun `RuleAction 未知类型原样返回`() {
        assertEquals("weird", RuleAction("weird").describe())
    }

    // ---------------------------------------------------------------- PidDefinition

    @Test
    fun `normalize 压空白并大写`() {
        assertEquals("01 0C", PidDefinition.normalize("  01   0c "))
        assertEquals("22 12 34", PidDefinition.normalize("22\t12\n34"))
    }

    @Test
    fun `requestString 由 mode 与 pid 拼成`() {
        assertEquals("01 0C", PidDefinition(mode = "01", pid = "0C").requestString())
        assertEquals("22 1234", PidDefinition(mode = "22", pid = "1234").requestString())
    }

    @Test
    fun `customRequest 覆盖自动请求并同样规范化`() {
        val p = PidDefinition(mode = "01", pid = "0C", customRequest = "01 0d")
        assertEquals("01 0D", p.requestString())
    }

    @Test
    fun `空白 customRequest 视为未设置`() {
        assertEquals("01 0C", PidDefinition(mode = "01", pid = "0C", customRequest = "   ").requestString())
    }

    @Test
    fun `modeInt 按十六进制解析`() {
        assertEquals(0x22, PidDefinition(mode = "22").modeInt())
        assertEquals(0x09, PidDefinition(mode = "09").modeInt())
        assertEquals(0x01, PidDefinition(mode = "zz").modeInt())
    }

    @Test
    fun `pidBytes 计算 PID 占几个字节`() {
        assertEquals(1, PidDefinition(pid = "0C").pidBytes())
        assertEquals(2, PidDefinition(pid = "1234").pidBytes())
    }

    @Test
    fun `PidDefinition 默认值稳定`() {
        // 这些默认值被内置 PID、编辑器与旧配置迁移依赖，改动要同步 CHANGELOG
        val p = PidDefinition()
        assertEquals("01", p.mode)
        assertEquals("0C", p.pid)
        assertEquals("A", p.formula)
        assertEquals("CAN", p.protocol)
        assertEquals(0, p.intervalMs)
        assertTrue(p.enabled)
        assertFalse(p.builtIn)
    }

    // ------------------------------------------------- 多 ECU 与优先级（v1.5.0）

    @Test
    fun `ecuIndex 默认 0 且优先级默认中`() {
        val p = PidDefinition()
        assertEquals("默认取第一个 ECU 的响应（= 旧行为）", 0, p.ecuIndex)
        assertEquals(PidDefinition.PRIORITY_NORMAL, p.priority)
    }

    @Test
    fun `优先级倍率：高更快 低更慢 未知按中`() {
        assertEquals(0.5f, PidDefinition.priorityScale(PidDefinition.PRIORITY_HIGH), 1e-6f)
        assertEquals(1.0f, PidDefinition.priorityScale(PidDefinition.PRIORITY_NORMAL), 1e-6f)
        assertEquals(2.0f, PidDefinition.priorityScale(PidDefinition.PRIORITY_LOW), 1e-6f)
        assertEquals("未知取值应退回中，不能变成 0（那会把总线打满）",
            1.0f, PidDefinition.priorityScale(99), 1e-6f)
    }

    @Test
    fun `优先级名称`() {
        assertEquals("高", PidDefinition.priorityName(PidDefinition.PRIORITY_HIGH))
        assertEquals("中", PidDefinition.priorityName(PidDefinition.PRIORITY_NORMAL))
        assertEquals("低", PidDefinition.priorityName(PidDefinition.PRIORITY_LOW))
    }

    @Test
    fun `PidDefinition JSON 往返保留 ecuIndex 与 priority`() {
        val src = PidDefinition(
            id = "x", name = "n",
            ecuIndex = 2, priority = PidDefinition.PRIORITY_LOW
        )
        val back = PidDefinition.fromJson(org.json.JSONObject(src.toJson().toString()))
        assertEquals(2, back.ecuIndex)
        assertEquals(PidDefinition.PRIORITY_LOW, back.priority)
    }

    // ---------------------------------------------------------------- Rule 默认值

    @Test
    fun `Rule 默认值与转向灯规则依赖的语义一致`() {
        val r = Rule()
        assertEquals("AND", r.logic)
        assertEquals(0L, r.durationMs)
        assertEquals(5000L, r.cooldownMs)   // 默认冷却 5 秒，避免报警刷屏
        assertTrue(r.enabled)
        assertTrue(r.conditions.isEmpty())
        assertTrue(r.actions.isEmpty())
    }

    // ---------------------------------------------------------------- GaugeItem

    @Test
    fun `GaugeItem 默认半宽与圆形样式`() {
        val g = GaugeItem()
        assertEquals(0, g.style)
        assertEquals(1, g.span)
        assertEquals(-1, g.color)
        assertEquals(0f, g.minVal, 1e-6f)
        assertEquals(100f, g.maxVal, 1e-6f)
    }
}
