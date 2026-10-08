package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「PID 编辑器表单 → `PidDefinition`」的单测（v1.20.8，S3）。
 *
 * ## 为什么这一层必须测得这么细
 *
 * S3 补的是**当前最大的空白**：在它之前用户造不出监听型 PID（全 app 只有 2 条内置）。
 * 而"造出来的东西对不对"**从界面上完全看不出来**：
 *
 *  - `header` 写错一位 → 常驻监听一直在跑、这条永远没值，日志里只有各 ID 的收帧数；
 *  - `minDlc` 写小 → 短帧静默不出值（公式解到帧外会抛，`FrameMonitor` 吞掉）；
 *  - `ttlMs` 被悄悄换成默认值 → 用户以为"我设过 0"，实际 2 秒后就变 `--`。
 *
 * 这些**没有一条能靠肉眼发现**，所以每条规则都要有用例钉住。
 * 判定全部在纯函数 [PidDraft] 里，`Activity` 一行校验都不写 ——
 * 写在 Activity 里的话这些用例一条都跑不了（见 `PidModels.kt` 顶部同一段理由）。
 */
class PidDraftTest {

    // ---------------------------------------------------------------- 构造工具

    /** 一条"最小可用"的监听型表单：`0x09A` 的 bit18（= 左转向灯，实车确认过的那个位） */
    private fun monitorFields(vararg over: Pair<String, Any>): PidDraft.Fields {
        val m: Map<String, Any> = over.toMap()
        val base = PidDraft.Fields(
            name = "左转向灯",
            source = PidDraft.SOURCE_MONITOR,
            header = "09A",
            formula = "bitsAt(18,1,0,0)",
            minVal = "0",
            maxVal = "1",
            minDlc = "8",
            ttlMs = "2000"
        )
        return PidDraft.Fields(
            name = m["name"] as? String ?: base.name,
            protocol = m["protocol"] as? String ?: base.protocol,
            source = m["source"] as? String ?: base.source,
            header = m["header"] as? String ?: base.header,
            mode = m["mode"] as? String ?: base.mode,
            pid = m["pid"] as? String ?: base.pid,
            request = m["request"] as? String ?: base.request,
            formula = m["formula"] as? String ?: base.formula,
            unit = m["unit"] as? String ?: base.unit,
            minVal = m["minVal"] as? String ?: base.minVal,
            maxVal = m["maxVal"] as? String ?: base.maxVal,
            warnLow = m["warnLow"] as? String ?: base.warnLow,
            warnHigh = m["warnHigh"] as? String ?: base.warnHigh,
            group = m["group"] as? String ?: base.group,
            intervalMs = m["intervalMs"] as? String ?: base.intervalMs,
            priority = m["priority"] as? Int ?: base.priority,
            ecuIndex = m["ecuIndex"] as? String ?: base.ecuIndex,
            invalidRaw = m["invalidRaw"] as? String ?: base.invalidRaw,
            minDlc = m["minDlc"] as? String ?: base.minDlc,
            ttlMs = m["ttlMs"] as? String ?: base.ttlMs,
            note = m["note"] as? String ?: base.note,
            enabled = m["enabled"] as? Boolean ?: base.enabled
        )
    }

    /** 一条"最小可用"的主动请求型表单（Mode 22 / PID 1234） */
    private fun pollFields(vararg over: Pair<String, Any>): PidDraft.Fields {
        val base = arrayOf<Pair<String, Any>>(
            "source" to PidDraft.SOURCE_POLL,
            "header" to "",
            "mode" to "22",
            "pid" to "1234"
        )
        return monitorFields(*(base + over))
    }

    private fun build(f: PidDraft.Fields): PidDraft.Result = PidDraft.build(f, "test-id")

    private fun okPid(f: PidDraft.Fields): PidDefinition {
        val r = build(f)
        assertTrue("本应通过校验，却被拒：${r.errors.map { it.message }}", r.ok)
        return r.pid!!
    }

    private fun hardMessages(f: PidDraft.Fields): List<String> = build(f).errors.map { it.message }
    private fun softMessages(f: PidDraft.Fields): List<String> = build(f).warnings.map { it.message }

    // ================================================================ 往返

    @Test
    fun `监听型往返 —— 字段一个都不许变`() {
        val src = PidDefinition(
            id = "mon_x", name = "变速箱油温", protocol = "CAN",
            mode = "MON", pid = "2C7", formula = "bitsAt(16,8,0,0) * 0.75 - 48",
            unit = "℃", minVal = -40f, maxVal = 200f, warnHigh = 120f,
            enabled = false, builtIn = false, intervalMs = 0,
            header = "2C7", source = "monitor",
            invalidRaw = 255, minDlc = 4, ttlMs = 2000,
            group = "监听型(信号表)", note = "信号表|报文名=OilTemp"
        )
        val back = okPid(PidDraft.of(src))
        assertEquals(src.name, back.name)
        assertEquals("monitor", back.source)
        assertEquals("MON", back.mode)
        assertEquals("2C7", back.header)
        assertEquals("2C7", back.pid)
        assertEquals(src.formula, back.formula)
        assertEquals(src.unit, back.unit)
        assertEquals(src.minVal, back.minVal)
        assertEquals(src.maxVal, back.maxVal)
        assertEquals(src.warnHigh, back.warnHigh)
        assertEquals(src.invalidRaw, back.invalidRaw)
        assertEquals(src.minDlc, back.minDlc)
        assertEquals(src.ttlMs, back.ttlMs)
        assertEquals(src.group, back.group)
        assertEquals(src.note, back.note)
        assertFalse("候选（enabled=false）必须原样保留", back.enabled)
        assertNull("监听型不该带请求帧", back.customRequest)
    }

    @Test
    fun `主动请求型往返 —— 含模块头与轮询参数`() {
        val src = PidDefinition(
            id = "p1", name = "机油压力", protocol = "CAN", mode = "22", pid = "2400",
            formula = "((A*256)+B)*0.01", unit = "Bar", minVal = 0f, maxVal = 10f,
            warnLow = 0.8f, enabled = true, intervalMs = 500, ecuIndex = 1,
            priority = PidDefinition.PRIORITY_LOW,
            header = "7E0", source = "poll", group = "厂家", note = "备注"
        )
        val back = okPid(PidDraft.of(src))
        assertEquals("poll", back.source)
        assertEquals("22", back.mode)
        assertEquals("2400", back.pid)
        assertEquals("7E0", back.header)
        assertEquals(500, back.intervalMs)
        assertEquals(1, back.ecuIndex)
        assertEquals(PidDefinition.PRIORITY_LOW, back.priority)
        assertEquals(0.8f, back.warnLow)
    }

    @Test
    fun `ttlMs 为 0 的存量条目 编辑一次不许被改成默认值`() {
        // ⚠️ 这是最容易犯的一个"改用户数据"的错：0 在 JSON 里与"没这个字段"不可区分
        // （toJson 默认值不写出去），若把 0 当成"空"，编辑一次内置转向灯
        // 就会把它变成 ttl=2000 —— 用户没改任何东西，行为却变了。
        val src = PidDefinition(
            id = "mon_turn_left", name = "左转向灯", mode = "MON", pid = "09A",
            header = "09A", source = "monitor", formula = "bit(C,2)",
            minVal = 0f, maxVal = 1f, ttlMs = 0
        )
        val back = okPid(PidDraft.of(src))
        assertEquals("0 必须原样保留", 0, back.ttlMs)
    }

    @Test
    fun `新建监听型 显示超时留空 按唯一权威的默认值 并说出来`() {
        val f = monitorFields("ttlMs" to "")
        val p = okPid(f)
        assertEquals(PidDefinition.DEFAULT_MONITOR_TTL_MS, p.ttlMs)
        assertTrue(
            "套了默认值就必须说出来：${softMessages(f)}",
            softMessages(f).any { it.contains("显示超时") }
        )
    }

    // ================================================================ header（两种含义）

    @Test
    fun `监听型没填 CAN ID 是硬错误`() {
        val msgs = hardMessages(monitorFields("header" to ""))
        assertTrue("没有 CAN ID 的监听条目永远不命中，必须拦下来：$msgs", msgs.any { it.contains("CAN ID") })
    }

    @Test
    fun `监听型 CAN ID 非法是硬错误`() {
        assertTrue(hardMessages(monitorFields("header" to "0xZZ")).any { it.contains("非法") })
        assertTrue(hardMessages(monitorFields("header" to "123456789")).any { it.contains("非法") })
    }

    @Test
    fun `监听型 CAN ID 会被规范化 小写与缺位都补齐`() {
        assertEquals("09A", okPid(monitorFields("header" to "9a")).header)
        assertEquals("09A", okPid(monitorFields("header" to "0x09a")).header)
        assertEquals("2C7", okPid(monitorFields("header" to "2c7")).header)
        // 29 位扩展帧要原样保留（补足 3 位只是对短 ID 的规则）
        assertEquals("18DAF110", okPid(monitorFields("header" to "18daf110")).header)
    }

    @Test
    fun `监听型的 pid 恒等于 CAN ID 用户填的 mode_pid 一律被忽略`() {
        // 界面上这两个框对监听型是藏起来的；这里钉住"就算被填了也不算数"，
        // 免得将来有人把隐藏改成显示之后，条目形状悄悄分叉
        val p = okPid(monitorFields("header" to "09A", "mode" to "22", "pid" to "FFFF"))
        assertEquals("MON", p.mode)
        assertEquals("09A", p.pid)
        assertNull(p.customRequest)
    }

    @Test
    fun `主动请求型的 header 是模块头 留空表示广播`() {
        assertNull(okPid(pollFields()).header?.takeIf { it.isNotBlank() })
        assertEquals("7E0", okPid(pollFields("header" to "7e0")).header)
        assertTrue(hardMessages(pollFields("header" to "XYZ")).any { it.contains("模块头") })
    }

    // ================================================================ 主动请求型的校验

    @Test
    fun `主动请求型 PID 为空是硬错误`() {
        assertTrue(hardMessages(pollFields("pid" to "")).any { it.contains("PID") })
    }

    @Test
    fun `主动请求型 PID 奇数位十六进制是硬错误`() {
        // v1.18.6 实车踩过：`1A4` 被 ELM327 当三个 nibble，帧畸形 → 全部 NO DATA
        assertTrue(hardMessages(pollFields("pid" to "123")).any { it.contains("偶数") })
        assertTrue(build(pollFields("pid" to "1234")).ok)
        assertTrue("可带空格", build(pollFields("pid" to "12 34")).ok)
    }

    @Test
    fun `主动请求型 PID 含非十六进制只是软警告 免得挡住派生通道另存副本`() {
        val f = pollFields("mode" to "CALC", "pid" to "calc_l100")
        val r = build(f)
        assertTrue("派生通道（mode=CALC）必须能另存副本：${r.errors.map { it.message }}", r.ok)
        assertTrue("非 CALC 时要说一句", softMessages(pollFields("pid" to "zz")).any { it.contains("非十六进制") })
    }

    @Test
    fun `Mode 非十六进制是硬错误 但 CALC 放行`() {
        assertTrue(hardMessages(pollFields("mode" to "22G")).any { it.contains("Mode") })
        assertTrue(build(pollFields("mode" to "CALC", "pid" to "calc_x")).ok)
    }

    // ================================================================ 数值字段边界

    @Test
    fun `名称与公式不能为空`() {
        assertTrue(hardMessages(monitorFields("name" to "  ")).any { it.contains("名称") })
        assertTrue(hardMessages(monitorFields("formula" to "A +")).any { it.contains("公式") })
        assertTrue(hardMessages(monitorFields("formula" to "bitsAt(0,8,0,0")).any { it.contains("公式") })
    }

    @Test
    fun `公式留空按 A 处理 —— 与旧行为一致`() {
        assertEquals("A", okPid(pollFields("formula" to "")).formula)
    }

    @Test
    fun `最小值最大值填了非数字要说出来 不许静默变 0`() {
        // 老写法 `toFloatOrNull() ?: 0f`：用户把 -40 打成 -4O（字母 O）会**看到 0 而不是报错**
        assertTrue(hardMessages(monitorFields("minVal" to "-4O")).any { it.contains("最小值") })
        assertTrue(hardMessages(monitorFields("maxVal" to "abc")).any { it.contains("最大值") })
        assertTrue(hardMessages(monitorFields("minVal" to "10", "maxVal" to "1")).any { it.contains("大于") })
    }

    @Test
    fun `最小帧长边界`() {
        assertTrue(hardMessages(monitorFields("minDlc" to "-1")).any { it.contains("最小帧长") })
        assertTrue(hardMessages(monitorFields("minDlc" to "65")).any { it.contains("最小帧长") })
        assertTrue(hardMessages(monitorFields("minDlc" to "8.5")).any { it.contains("最小帧长") })
        assertEquals(8, okPid(monitorFields("minDlc" to "8")).minDlc)
        assertEquals(0, okPid(monitorFields("minDlc" to "")).minDlc)
    }

    @Test
    fun `最小帧长为 0 时 按公式的真实位集给出建议`() {
        // bitsAt(18,1,…) 落在第 3 字节 → 至少要 3 字节
        val msgs = softMessages(monitorFields("minDlc" to ""))
        assertTrue("应当建议 3：$msgs", msgs.any { it.contains("建议填 3") })
        // 填了但比需要的还小 → 也要说
        assertTrue(softMessages(monitorFields("minDlc" to "2")).any { it.contains("还小") })
        // 够了就别啰嗦
        assertFalse(softMessages(monitorFields("minDlc" to "3")).any { it.contains("最小帧长") })
    }

    @Test
    fun `Motorola 的建议帧长按真实位集算 不能用线性的 起始位加长度`() {
        // bitsAt(2,4,1,0)：Motorola 锯齿位序 → bit2 bit1 bit0 bit15 → 占到第 2 字节
        assertEquals(2, PidDraft.suggestedMinDlc("bitsAt(2,4,1,0)"))
        // 同一字节内往下走：起始位 6、长度 4 → 只占第 1 字节
        assertEquals(1, PidDraft.suggestedMinDlc("bitsAt(6,4,1,0)"))
        // 实测案例（规格 §7 陷阱 1）：起始位 60、长度 5 → 只占第 8 字节；
        // 线性判据 60+5=65 会算成"要第 9 字节"（实测在宝马参数表上误报过 2 条）
        assertEquals(8, PidDraft.suggestedMinDlc("bitsAt(60,5,1,0)"))
        assertEquals(3, PidDraft.suggestedMinDlc("bitsAt(18,1,0,0)"))
        assertEquals(2, PidDraft.suggestedMinDlc("bitsAt(8,8,0,0)"))
        assertNull("非 bitsAt 形态不给建议（宁可不说，也别给错）", PidDraft.suggestedMinDlc("bit(C,2)"))
        assertNull(PidDraft.suggestedMinDlc("A-40"))
    }

    @Test
    fun `无效原始值边界`() {
        assertTrue(hardMessages(monitorFields("invalidRaw" to "-1")).any { it.contains("无效原始值") })
        assertTrue(hardMessages(monitorFields("invalidRaw" to "FF")).any { it.contains("无效原始值") })
        assertEquals(255, okPid(monitorFields("invalidRaw" to "255", "formula" to "bitsAt(0,8,0,0)")).invalidRaw)
        assertNull(okPid(monitorFields("invalidRaw" to "")).invalidRaw)
    }

    @Test
    fun `无效原始值超出位宽只是软警告 照收`() {
        // 1 位信号填 255：多半填错了，但不该拒绝整条（可能是多路复用下的写法）
        val f = monitorFields("invalidRaw" to "255", "formula" to "bitsAt(18,1,0,0)")
        assertTrue(build(f).ok)
        assertTrue(softMessages(f).any { it.contains("2^1") })
    }

    @Test
    fun `显示超时边界`() {
        assertTrue(hardMessages(monitorFields("ttlMs" to "-5")).any { it.contains("显示超时") })
        assertTrue(hardMessages(monitorFields("ttlMs" to "2s")).any { it.contains("显示超时") })
        assertEquals(0, okPid(monitorFields("ttlMs" to "0")).ttlMs)
        assertEquals(500, okPid(monitorFields("ttlMs" to "500")).ttlMs)
    }

    @Test
    fun `轮询间隔与多 ECU 序号边界`() {
        assertTrue(hardMessages(pollFields("intervalMs" to "-1")).any { it.contains("轮询间隔") })
        assertTrue(hardMessages(pollFields("ecuIndex" to "x")).any { it.contains("多 ECU") })
        assertEquals(0, okPid(pollFields("intervalMs" to "")).intervalMs)
    }

    // ================================================================ 下拉框映射

    @Test
    fun `来源下拉框的 值 与 显示文字 一一对应`() {
        assertEquals(PidDraft.SOURCE_VALUES.size, PidDraft.SOURCE_LABELS.size)
        assertEquals(0, PidDraft.sourceIndexOf("poll"))
        assertEquals(1, PidDraft.sourceIndexOf("MONITOR"))
        assertEquals("monitor", PidDraft.sourceOf(1))
        // 认不出来 → 主动请求（= 旧行为），绝不抛
        assertEquals(0, PidDraft.sourceIndexOf("???"))
        assertEquals("poll", PidDraft.sourceOf(99))
        assertTrue(PidDraft.isMonitor(" monitor "))
        assertFalse(PidDraft.isMonitor("poll"))
    }

    @Test
    fun `候选（未启用）原样落进 enabled`() {
        assertFalse(okPid(monitorFields("enabled" to false)).enabled)
        assertTrue(okPid(monitorFields("enabled" to true)).enabled)
    }

    @Test
    fun `整数不带小数点`() {
        assertEquals("0", PidDraft.fmtNum(0f))
        assertEquals("100", PidDraft.fmtNum(100f))
        assertEquals("-40", PidDraft.fmtNum(-40f))
        assertEquals("0.25", PidDraft.fmtNum(0.25f))
    }

    @Test
    fun `有硬错误时不给 pid —— 调用方不可能不小心存下去`() {
        val r = build(monitorFields("header" to ""))
        assertNull(r.pid)
        assertFalse(r.ok)
        assertNotNull(r.errors.firstOrNull())
    }
}
