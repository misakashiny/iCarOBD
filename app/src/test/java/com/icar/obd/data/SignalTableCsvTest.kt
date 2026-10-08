package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「信号表」CSV 的单元测试（v1.20.7，S1；规格 §3）。
 *
 * ## 为什么这一层必须测得这么细
 *
 * 信号表是**人在 Excel 里填**的，而填错的表现是"值解错了但看起来完全正常"：
 * 字节序填反 → 解出另一个信号的值；起始位差一位 → 解出相邻开关的状态。
 * 这些**没有任何一条能从界面上看出来**，所以每条硬错误/软警告都要有钉住它的用例。
 *
 * 另外两条来自规格 §7 的陷阱，专门有对应用例：
 *  - **判"解到帧外"不能用线性的 `起始位+长度`**（Motorola 是锯齿位序）；
 *  - **`最小/最大` 不是编码范围**（所以空白时按编码范围兜底，而不是拿它做掩码）。
 */
class SignalTableCsvTest {

    // ---------------------------------------------------------------- 构造工具

    /** 一份只有表头的空表（带 BOM，与真实导出的一致） */
    private fun table(vararg rows: String): String =
        SignalTableCsv.BOM + SignalTableCsv.COLUMNS.joinToString(",") + "\n" +
            rows.joinToString("\n") + "\n"

    /** 按**列名**拼一行；没给的列留空 */
    private fun rowOf(vararg cells: Pair<String, String>): String {
        val m = cells.toMap()
        return SignalTableCsv.COLUMNS.joinToString(",") { SignalTableCsv.escape(m[it] ?: "") }
    }

    /** 一条最小可用行（0x09A bit18，DLC=8 与实车一致），可用 `over` 覆盖任意列 */
    private fun validRow(vararg over: Pair<String, String>): String {
        val base = listOf(
            SignalTableCsv.C_ID_HEX to "0x09A",
            SignalTableCsv.C_ID_DEC to "154",
            SignalTableCsv.C_DLC to "8",
            SignalTableCsv.C_SIGNAL to "LeftTurn",
            SignalTableCsv.C_START to "18",
            SignalTableCsv.C_LEN to "1",
            SignalTableCsv.C_BYTE to "B2",
            SignalTableCsv.C_ORDER to "Intel(LE)",
            SignalTableCsv.C_SIGN to "unsigned",
            SignalTableCsv.C_FACTOR to "1",
            SignalTableCsv.C_OFFSET to "0",
            SignalTableCsv.C_MIN to "0",
            SignalTableCsv.C_MAX to "1",
            SignalTableCsv.C_CONFIDENCE to SignalTableCsv.CONF_CONFIRMED,
            SignalTableCsv.C_EVIDENCE to "2026-10-07 0x09A changed=13"
        )
        return rowOf(*(base + over.toList()).toTypedArray())
    }

    private fun parseOne(vararg over: Pair<String, String>): PidDefinition {
        val res = SignalTableCsv.parse(table(validRow(*over)))
        assertTrue("本该通过校验，却被拒：${res.problems.map { it.message }}", res.errors.isEmpty())
        return res.pids.single()
    }

    // ================================================================ 模板

    @Test
    fun `模板有 25 列中文表头且带 BOM`() {
        val t = SignalTableCsv.template(emptyList())
        assertTrue("模板必须带 BOM，否则 Excel 中文乱码", t.startsWith("\uFEFF"))
        val header = SignalTableCsv.stripBom(t).trim().split("\n")[0]
        assertEquals(SignalTableCsv.COLUMNS.joinToString(","), header)
        assertEquals("列数必须是 25", 25, header.split(",").size)
    }

    @Test
    fun `模板每个观察到的 ID 一行 预填 ID-DLC-取值集合 其余留空`() {
        val t = SignalTableCsv.stripBom(
            SignalTableCsv.template(
                listOf(
                    SignalTableCsv.Observed(0x09A, 8, listOf("00 00 04 00 88 00 03 00", "00 00 08 00 88 00 03 00")),
                    SignalTableCsv.Observed(0x2C7, 4, listOf("01 02 03 04"))
                )
            )
        )
        val lines = t.trim().split("\n")
        assertEquals(3, lines.size)   // 表头 + 2 行

        val cells = SignalTableCsv.splitRows(t).drop(1)
        val idx = SignalTableCsv.COLUMNS.withIndex().associate { (i, n) -> n to i }
        // 按 ID 升序：0x09A 在前
        assertEquals("0x09A", cells[0][idx.getValue(SignalTableCsv.C_ID_HEX)])
        assertEquals("154", cells[0][idx.getValue(SignalTableCsv.C_ID_DEC)])
        assertEquals("8", cells[0][idx.getValue(SignalTableCsv.C_DLC)])
        assertTrue(
            "取值集合是模板的核心价值",
            cells[0][idx.getValue(SignalTableCsv.C_VALUES)].contains("00 00 04 00 88 00 03 00")
        )
        // 其余留空 —— 尤其 信号名/起始位/字节序，这些是**人**要填的
        assertEquals("", cells[0][idx.getValue(SignalTableCsv.C_SIGNAL)])
        assertEquals("", cells[0][idx.getValue(SignalTableCsv.C_START)])
        assertEquals("", cells[0][idx.getValue(SignalTableCsv.C_ORDER)])

        assertEquals("0x2C7", cells[1][idx.getValue(SignalTableCsv.C_ID_HEX)])
        assertEquals("711", cells[1][idx.getValue(SignalTableCsv.C_ID_DEC)])
    }

    @Test
    fun `模板的取值集合列含逗号时不会把行拆错`() {
        // 第 25 列的值是 hex（含空格不含逗号），但真出现逗号也必须能读回来
        val t = SignalTableCsv.template(listOf(SignalTableCsv.Observed(0x100, 2, listOf("01,02"))))
        val cells = SignalTableCsv.splitRows(t)
        assertEquals(2, cells.size)
        assertEquals(SignalTableCsv.COLUMNS.size, cells[1].size)
        assertEquals("01,02", cells[1][SignalTableCsv.COLUMNS.indexOf(SignalTableCsv.C_VALUES)])
    }

    // ================================================================ 往返

    @Test
    fun `一行最小信号能变成监听型 PID`() {
        val p = parseOne()
        assertEquals("mon_09A_LeftTurn", p.id)
        assertEquals("LeftTurn", p.name)
        assertEquals("monitor", p.source)
        assertEquals("MON", p.mode)
        assertEquals("09A", p.header)
        assertEquals("09A", p.pid)
        assertEquals("bitsAt(18,1,0,0)", p.formula)
        assertEquals("原始值就是位段本身 → 解码只要 3 个字节", 3, p.minDlc)
        assertEquals("信号表默认 2 秒新鲜度", 2000, p.ttlMs)
        assertNull("没填无效原始值 → 不判断", p.invalidRaw)
        assertTrue("可信度=已确认 → 启用", p.enabled)
        assertFalse(p.builtIn)
    }

    @Test
    fun `因子与偏移进公式 并保证是 bitsAt 形态`() {
        val p = parseOne(
            SignalTableCsv.C_FACTOR to "0.25",
            SignalTableCsv.C_OFFSET to "-48"
        )
        assertEquals("bitsAt(18,1,0,0) * 0.25 - 48", p.formula)
        // ⚠️ 公式必须能被解析（生成与求值不能分叉）
        assertNull(Formula.check(p.formula))
    }

    @Test
    fun `候选条目不启用 已确认条目启用`() {
        assertFalse(parseOne(SignalTableCsv.C_CONFIDENCE to SignalTableCsv.CONF_CANDIDATE).enabled)
        assertTrue(parseOne(SignalTableCsv.C_CONFIDENCE to SignalTableCsv.CONF_CONFIRMED).enabled)
    }

    @Test
    fun `无效原始值与显示超时进字段`() {
        val p = parseOne(SignalTableCsv.C_INVALID_RAW to "255", SignalTableCsv.C_TTL to "500")
        assertEquals(255, p.invalidRaw)
        assertEquals(500, p.ttlMs)
    }

    @Test
    fun `空白最小最大按编码范围兜底 而不是 0到255`() {
        // 规格 §7 陷阱 2：这两列是**显示量程**，不是编码范围。
        // 空白时给 0..(2^len-1) 比给 0..255 少一点误导（1 位的转向灯就是 0..1）
        val p = parseOne(SignalTableCsv.C_MIN to "", SignalTableCsv.C_MAX to "")
        assertEquals(0f, p.minVal, 1e-6f)
        assertEquals(1f, p.maxVal, 1e-6f)

        val signed8 = parseOne(
            SignalTableCsv.C_START to "0", SignalTableCsv.C_LEN to "8",
            SignalTableCsv.C_BYTE to "B0", SignalTableCsv.C_SIGN to "signed",
            SignalTableCsv.C_MIN to "", SignalTableCsv.C_MAX to ""
        )
        assertEquals(-128f, signed8.minVal, 1e-6f)
        assertEquals(127f, signed8.maxVal, 1e-6f)
    }

    @Test
    fun `报文名进 group 其余列进 note 的固定格式`() {
        val p = parseOne(
            SignalTableCsv.C_MSG_NAME to "TurnSignals",
            SignalTableCsv.C_PERIOD to "100",
            SignalTableCsv.C_TX_NODE to "FRMFA",
            SignalTableCsv.C_RX_NODE to "XXX",
            SignalTableCsv.C_VALUE_TABLE to "0:关,1:开",
            SignalTableCsv.C_MUX to "ST_SW_LEV_RPM=2"
        )
        assertEquals("TurnSignals", p.group)
        assertEquals(
            "信号表|报文名=TurnSignals|DLC=8|周期=100|发送=FRMFA|接收=XXX|值表=0:关,1:开|" +
                "复用=ST_SW_LEV_RPM=2|证据=2026-10-07 0x09A changed=13",
            p.note
        )
    }

    @Test
    fun `note 只写非空项 不产生噪音`() {
        val p = parseOne(
            SignalTableCsv.C_MSG_NAME to "",
            SignalTableCsv.C_EVIDENCE to "",
            SignalTableCsv.C_DLC to "8"
        )
        assertEquals("信号表|DLC=8", p.note)
    }

    @Test
    fun `报文ID 去 0x 大写并补足 3 位`() {
        assertEquals("09A", SignalTableCsv.normalizeId("0x09a"))
        assertEquals("09A", SignalTableCsv.normalizeId("9a"))
        assertEquals("7E8", SignalTableCsv.normalizeId(" 0X7e8 "))
        assertEquals("18DAF110", SignalTableCsv.normalizeId("18daf110"))
        assertNull(SignalTableCsv.normalizeId(""))
        assertNull(SignalTableCsv.normalizeId("0xZZ"))
        assertNull(SignalTableCsv.normalizeId("123456789"))   // 9 位太长
    }

    // ================================================================ 硬错误（整行拒绝）

    private fun errorsOf(vararg over: Pair<String, String>): List<String> =
        SignalTableCsv.parse(table(validRow(*over))).errors.map { it.message }

    @Test
    fun `硬错误 报文ID 非法`() {
        val es = errorsOf(SignalTableCsv.C_ID_HEX to "0xZZZ")
        assertEquals(1, es.size)
        assertTrue(es[0], es[0].contains("报文ID(hex) 非法"))
    }

    @Test
    fun `硬错误 信号名为空`() {
        assertTrue(errorsOf(SignalTableCsv.C_SIGNAL to "").any { it.contains("信号名 为空") })
    }

    @Test
    fun `硬错误 起始位不是数字或为负`() {
        assertTrue(errorsOf(SignalTableCsv.C_START to "十八").any { it.contains("起始位 不是数字") })
        assertTrue(errorsOf(SignalTableCsv.C_START to "-1").any { it.contains("起始位 不能为负") })
    }

    @Test
    fun `起始位 0 是合法的`() {
        // ⚠️ 规格 §3.4 字面写的是「起始位 ≤0 是硬错误」，但 0 是**帧首字节的最低位**，
        // 按字面实现会把合法行拒掉。这里按意图实现（只有负值才是硬错误），
        // 所以这条用例必须钉住 —— 否则下一个人会"照规格改回去"。
        val p = parseOne(SignalTableCsv.C_START to "0", SignalTableCsv.C_BYTE to "B0")
        assertEquals("bitsAt(0,1,0,0)", p.formula)
    }

    @Test
    fun `硬错误 长度非数或越界`() {
        assertTrue(errorsOf(SignalTableCsv.C_LEN to "x").any { it.contains("长度(bit) 不是数字") })
        assertTrue(errorsOf(SignalTableCsv.C_LEN to "0").any { it.contains("长度(bit) 必须在 1..32") })
        assertTrue(errorsOf(SignalTableCsv.C_LEN to "33").any { it.contains("长度(bit) 必须在 1..32") })
    }

    @Test
    fun `硬错误 字节序与符号不认识`() {
        assertTrue(errorsOf(SignalTableCsv.C_ORDER to "中间端").any { it.contains("字节序 不认识") })
        assertTrue(errorsOf(SignalTableCsv.C_SIGN to "float").any { it.contains("符号 不认识") })
    }

    @Test
    fun `硬错误 因子为零或非数`() {
        assertTrue(errorsOf(SignalTableCsv.C_FACTOR to "0").any { it.contains("因子 不能为 0") })
        assertTrue(errorsOf(SignalTableCsv.C_FACTOR to "abc").any { it.contains("因子 不是数字") })
    }

    @Test
    fun `硬错误 最小大于最大`() {
        assertTrue(
            errorsOf(
                SignalTableCsv.C_MIN to "10", SignalTableCsv.C_MAX to "1"
            ).any { it.contains("大于 最大") }
        )
    }

    @Test
    fun `硬错误 解到帧外 用真实位集而不是线性的起始位加长度`() {
        // 0x09A 真实帧是 8 字节，bit18 要第 3 字节 —— DLC=2 时确实解不到
        val es = errorsOf(SignalTableCsv.C_DLC to "2")
        assertEquals(1, es.size)
        assertTrue(es[0], es[0].contains("解到帧外"))
    }

    @Test
    fun `Motorola 不按线性的起始位加长度判越界`() {
        // ⚠️ 规格 §7 陷阱 1 的真实案例：`setMe_0xFC` 起始位 31、长度 8，
        // 线性的 31+8=39 → 会算成"要第 5 字节"，而 Motorola 锯齿位序下
        // 这 8 位**全在第 4 字节内**（b3.7 → b3.0）。DLC=4 必须通过。
        val res = SignalTableCsv.parse(
            table(
                validRow(
                    SignalTableCsv.C_START to "31",
                    SignalTableCsv.C_LEN to "8",
                    SignalTableCsv.C_BYTE to "B3",
                    SignalTableCsv.C_ORDER to "Motorola(BE)",
                    SignalTableCsv.C_DLC to "4"
                )
            )
        )
        assertTrue("线性的 31+8 会误报越界，真实位集不会：${res.errors.map { it.message }}", res.errors.isEmpty())
        assertEquals(4, res.pids.single().minDlc)
        assertEquals("bitsAt(31,8,1,0)", res.pids.single().formula)

        // 反过来：DLC=3 是真的解不到，必须拒绝
        val bad = SignalTableCsv.parse(
            table(
                validRow(
                    SignalTableCsv.C_START to "31", SignalTableCsv.C_LEN to "8",
                    SignalTableCsv.C_BYTE to "B3", SignalTableCsv.C_ORDER to "Motorola(BE)",
                    SignalTableCsv.C_DLC to "3"
                )
            )
        )
        assertTrue(bad.errors.any { it.message.contains("解到帧外") })
    }

    @Test
    fun `Motorola 起始位 60 长度 5 只占第 8 字节 不越界`() {
        // 另一个实测案例：`ST_OBD_CTFN_GRB` 实际只占 bit56~60。
        // 起始位 60 是 b7.4，向下 5 位 = b7.4..b7.0 → 全在第 8 字节
        val res = SignalTableCsv.parse(
            table(
                validRow(
                    SignalTableCsv.C_START to "60", SignalTableCsv.C_LEN to "5",
                    SignalTableCsv.C_BYTE to "B7", SignalTableCsv.C_ORDER to "Motorola(BE)",
                    SignalTableCsv.C_DLC to "8"
                )
            )
        )
        assertTrue(res.errors.map { it.message }.toString(), res.errors.isEmpty())
        assertEquals(8, res.pids.single().minDlc)
    }

    // ================================================================ 软警告（照收但提示）

    private fun warnsOf(vararg over: Pair<String, String>): List<String> =
        SignalTableCsv.parse(table(validRow(*over))).warnings.map { it.message }

    @Test
    fun `软警告 报文ID dec 与 hex 不一致`() {
        assertTrue(warnsOf(SignalTableCsv.C_ID_DEC to "999").any { it.contains("不一致") })
    }

    @Test
    fun `软警告 字节列与起始位不符`() {
        assertTrue(warnsOf(SignalTableCsv.C_BYTE to "B5").any { it.contains("不符") })
    }

    @Test
    fun `软警告 无效原始值超出长度能表示的范围`() {
        // 1 位信号写 255：多半是把别的信号的无效值抄过来了
        assertTrue(warnsOf(SignalTableCsv.C_INVALID_RAW to "255").any { it.contains("2^1") })
    }

    @Test
    fun `软警告 同一报文内位重叠`() {
        val res = SignalTableCsv.parse(
            table(
                validRow(SignalTableCsv.C_SIGNAL to "A", SignalTableCsv.C_START to "18"),
                validRow(SignalTableCsv.C_SIGNAL to "B", SignalTableCsv.C_START to "18")
            )
        )
        assertTrue(res.warnings.any { it.message.contains("位重叠") })
        assertEquals("位重叠是软警告，两行都要收下", 2, res.pids.size)
    }

    @Test
    fun `同一报文内不重叠时没有位重叠警告`() {
        val res = SignalTableCsv.parse(
            table(
                validRow(SignalTableCsv.C_SIGNAL to "A", SignalTableCsv.C_START to "18"),
                validRow(SignalTableCsv.C_SIGNAL to "B", SignalTableCsv.C_START to "19")
            )
        )
        assertFalse(res.warnings.any { it.message.contains("位重叠") })
    }

    @Test
    fun `软警告 多路复用条件 单位与证据为空`() {
        val ws = warnsOf(SignalTableCsv.C_MUX to "ST_SW_LEV_RPM=2", SignalTableCsv.C_UNIT to "")
        assertTrue(ws.any { it.contains("多路复用") })
        assertTrue(ws.any { it.contains("单位 为空") })
    }

    @Test
    fun `软警告 DLC 空时跳过帧长校验`() {
        val res = SignalTableCsv.parse(table(validRow(SignalTableCsv.C_DLC to "")))
        assertTrue(res.errors.isEmpty())
        assertTrue(res.warnings.any { it.message.contains("未做帧长校验") })
        assertEquals("运行时有 minDlc 兜底", 3, res.pids.single().minDlc)
    }

    // ================================================================ 覆盖 / 表头

    @Test
    fun `重复导入按报文与信号名覆盖 不新增`() {
        val res = SignalTableCsv.parse(
            table(
                validRow(SignalTableCsv.C_SIGNAL to "LeftTurn", SignalTableCsv.C_START to "18"),
                validRow(SignalTableCsv.C_SIGNAL to "LeftTurn", SignalTableCsv.C_START to "19")
            )
        )
        assertEquals("同 (报文ID, 信号名) 只留一条，否则每导一次列表翻一倍", 1, res.pids.size)
        assertEquals("bitsAt(19,1,0,0)", res.pids.single().formula)
        assertEquals(2, res.totalRows)
    }

    @Test
    fun `同名信号在不同报文下是两条`() {
        val res = SignalTableCsv.parse(
            table(
                validRow(SignalTableCsv.C_SIGNAL to "On", SignalTableCsv.C_ID_HEX to "0x100", SignalTableCsv.C_ID_DEC to "256", SignalTableCsv.C_DLC to "8"),
                validRow(SignalTableCsv.C_SIGNAL to "On", SignalTableCsv.C_ID_HEX to "0x200", SignalTableCsv.C_ID_DEC to "512", SignalTableCsv.C_DLC to "8")
            )
        )
        assertEquals(2, res.pids.size)
    }

    @Test
    fun `没有表头时明确报错 而不是猜列序`() {
        val res = SignalTableCsv.parse("1,2,3\n4,5,6\n")
        assertEquals(1, res.errors.size)
        assertTrue(res.errors[0].message.contains("找不到表头"))
        assertTrue(res.pids.isEmpty())
    }

    @Test
    fun `空文件报错而不是静默成功`() {
        assertTrue(SignalTableCsv.parse("").errors.isNotEmpty())
    }

    @Test
    fun `列顺序被打乱也能按列名读对`() {
        // 人在 Excel 里插一列/调换顺序不该让导入错位（错位 = 值解错但看起来正常）
        val cols = SignalTableCsv.COLUMNS.reversed()
        val cells = mapOf(
            SignalTableCsv.C_ID_HEX to "0x100", SignalTableCsv.C_ID_DEC to "256",
            SignalTableCsv.C_DLC to "8", SignalTableCsv.C_SIGNAL to "X",
            SignalTableCsv.C_START to "8", SignalTableCsv.C_LEN to "8",
            SignalTableCsv.C_ORDER to "Intel(LE)", SignalTableCsv.C_SIGN to "unsigned",
            SignalTableCsv.C_FACTOR to "1", SignalTableCsv.C_OFFSET to "0",
            SignalTableCsv.C_CONFIDENCE to SignalTableCsv.CONF_CONFIRMED
        )
        val text = cols.joinToString(",") + "\n" +
            cols.joinToString(",") { SignalTableCsv.escape(cells[it] ?: "") } + "\n"
        val res = SignalTableCsv.parse(text)
        assertTrue(res.errors.map { it.message }.toString(), res.errors.isEmpty())
        assertEquals("bitsAt(8,8,0,0)", res.pids.single().formula)
        assertEquals("100", res.pids.single().header)
    }

    @Test
    fun `多余的空行被跳过 不计入数据行`() {
        val res = SignalTableCsv.parse(table(validRow(), "", "", ""))
        assertEquals(1, res.totalRows)
        assertEquals(1, res.pids.size)
    }

    @Test
    fun `CRLF 与 BOM 都能读`() {
        val text = SignalTableCsv.BOM +
            SignalTableCsv.COLUMNS.joinToString(",") + "\r\n" + validRow() + "\r\n"
        val res = SignalTableCsv.parse(text)
        assertTrue(res.errors.map { it.message }.toString(), res.errors.isEmpty())
        assertEquals(1, res.pids.size)
    }

    // ================================================================ CSV 底层

    @Test
    fun `splitRows 处理引号内的逗号与双引号`() {
        val rows = SignalTableCsv.splitRows("a,\"b,c\",\"d\"\"e\"\n1,2,3\n")
        assertEquals(2, rows.size)
        assertEquals(listOf("a", "b,c", "d\"e"), rows[0])
        assertEquals(listOf("1", "2", "3"), rows[1])
    }

    @Test
    fun `escape 只在该加引号时才加`() {
        assertEquals("abc", SignalTableCsv.escape("abc"))
        assertEquals("\"a,b\"", SignalTableCsv.escape("a,b"))
        assertEquals("\"a\"\"b\"", SignalTableCsv.escape("a\"b"))
    }

    @Test
    fun `字节序与符号的别名`() {
        assertEquals(SignalTableCsv.ORDER_INTEL, SignalTableCsv.parseOrder("Intel(LE)")!!)
        assertEquals(SignalTableCsv.ORDER_INTEL, SignalTableCsv.parseOrder("intel")!!)
        assertEquals(SignalTableCsv.ORDER_MOTOROLA, SignalTableCsv.parseOrder("Motorola(BE)")!!)
        assertEquals(SignalTableCsv.ORDER_MOTOROLA, SignalTableCsv.parseOrder("大端")!!)
        assertNull(SignalTableCsv.parseOrder(""))
        assertNull(SignalTableCsv.parseOrder("x"))

        assertEquals(SignalTableCsv.SIGN_UNSIGNED, SignalTableCsv.parseSign("unsigned")!!)
        assertEquals(SignalTableCsv.SIGN_SIGNED, SignalTableCsv.parseSign("有符号")!!)
        assertNull(SignalTableCsv.parseSign(""))
        assertNull(SignalTableCsv.parseSign("x"))
    }

    @Test
    fun `公式生成在因子偏移为默认值时最短`() {
        assertEquals("bitsAt(18,1,0,0)", SignalTableCsv.formulaOf(18, 1, 0, 0, 1.0, 0.0))
        assertEquals("bitsAt(0,16,1,1) * 0.1 + 5", SignalTableCsv.formulaOf(0, 16, 1, 1, 0.1, 5.0))
        assertEquals("bitsAt(0,8,0,0) * 0.5", SignalTableCsv.formulaOf(0, 8, 0, 0, 0.5, 0.0))
    }

    @Test
    fun `生成的公式都能被公式引擎接受`() {
        for (order in listOf(0, 1)) {
            for (sign in listOf(0, 1)) {
                val f = SignalTableCsv.formulaOf(0, 16, order, sign, 0.25, -48.0)
                assertNull("$f 应该合法", Formula.check(f))
            }
        }
        assertNotNull(Formula.check("bitsAt(18,1,0,0"))
    }
}
