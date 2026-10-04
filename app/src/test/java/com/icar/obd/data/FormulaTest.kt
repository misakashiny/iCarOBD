package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `Formula` 的单元测试（迭代清单 P2-1）。
 *
 * 覆盖三件事：
 *  1. **文档里公开承诺的公式模板**（README / HANDOVER §5 的模板表）必须真的能算对；
 *  2. 语法错误必须**抛异常**而不是静默返回一个看似合理的值；
 *  3. `check()` 作为编辑器保存前的静态校验，判据要可观测。
 */
class FormulaTest {

    private fun eval(expr: String, vararg bytes: Int): Double =
        Formula.eval(expr, ByteArray(bytes.size) { bytes[it].toByte() })

    // ---------------------------------------------------------------- 文档模板

    @Test
    fun `单字节直读`() {
        assertEquals(58.0, eval("A", 0x3A), 1e-9)
    }

    @Test
    fun `双字节大端`() {
        assertEquals(15090.0, eval("(A*256)+B", 0x3A, 0xF2), 1e-9)
    }

    @Test
    fun `双字节大端乘0_1再减40`() {
        assertEquals(1469.0, eval("((A*256)+B)*0.1-40", 0x3A, 0xF2), 1e-9)
    }

    @Test
    fun `温度减40偏置`() {
        assertEquals(50.0, eval("A-40", 90), 1e-9)
    }

    @Test
    fun `百分比`() {
        assertEquals(100.0, eval("A*100/255", 255), 1e-9)
        assertEquals(0.0, eval("A*100/255", 0), 1e-9)
    }

    @Test
    fun `燃油修正以128为中心`() {
        assertEquals(0.0, eval("(A-128)*100/128", 128), 1e-9)
        assertEquals(-100.0, eval("(A-128)*100/128", 0), 1e-9)
        assertEquals(99.21875, eval("(A-128)*100/128", 255), 1e-9)
    }

    @Test
    fun `开关量取位`() {
        assertEquals(1.0, eval("bit(A,0)", 1), 1e-9)
        assertEquals(0.0, eval("bit(A,0)", 2), 1e-9)
        assertEquals(1.0, eval("bit(A,1)", 2), 1e-9)
        assertEquals(1.0, eval("bit(A,7)", 0x80), 1e-9)
    }

    @Test
    fun `signed 把字节当8位有符号数`() {
        assertEquals(-14.0, eval("signed(A)", 0xF2), 1e-9)
        assertEquals(127.0, eval("signed(A)", 127), 1e-9)
        assertEquals(-128.0, eval("signed(A)", 128), 1e-9)
    }

    @Test
    fun `有符号双字节大端`() {
        // 0xFF 0xFE -> -1*256 + 254 = -2
        assertEquals(-2.0, eval("signed(A)*256+B", 0xFF, 0xFE), 1e-9)
    }

    @Test
    fun `转速公式端到端`() {
        // 41 0C 1A F8 -> A=0x1A B=0xF8 -> 1726 rpm
        assertEquals(1726.0, eval("((A*256)+B)/4", 0x1A, 0xF8), 1e-9)
    }

    // ------------------------------------------------- 十六进制字面量（曾不可用）

    @Test
    fun `十六进制字面量`() {
        // 文档承诺支持 0xFF，但 v1.3.0 及以前该分支永远不可达（'0' 被 number() 先吃掉），
        // 会报「未知标识符 'xFF'」。见 CHANGELOG v1.3.1。
        assertEquals(255.0, eval("0xFF"), 1e-9)
        assertEquals(255.0, eval("0Xff"), 1e-9)
        assertEquals(0.0, eval("0x0"), 1e-9)
        assertEquals(254.0, eval("0xFF-1"), 1e-9)
        assertEquals(17.0, eval("A+0x10", 0x01), 1e-9)
    }

    @Test
    fun `十六进制缺少数字时给出明确错误而不是崩溃`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("0x") }
        assertTrue(e.message!!, e.message!!.contains("十六进制缺少数字"))
    }

    @Test
    fun `以0开头的十进制仍是十进制`() {
        assertEquals(1.0, eval("01"), 1e-9)
        assertEquals(0.5, eval("0.5"), 1e-9)
    }

    // ---------------------------------------------------------------- 运算与优先级

    @Test
    fun `优先级与结合性`() {
        assertEquals(14.0, eval("2+3*4"), 1e-9)
        assertEquals(20.0, eval("(2+3)*4"), 1e-9)
        assertEquals(1024.0, eval("2^10"), 1e-9)
        assertEquals(1.0, eval("7%3"), 1e-9)
        assertEquals(2.5, eval("5/2"), 1e-9)
        assertEquals(1000.0, eval("1e3"), 1e-9)
        assertEquals(0.5, eval(".5"), 1e-9)
        assertEquals(5.0, eval("+5"), 1e-9)
        assertEquals(-5.0, eval("-5"), 1e-9)
    }

    @Test
    fun `一元负号作用于幂的结果`() {
        assertEquals(-4.0, eval("-2^2"), 1e-9)
    }

    @Test
    fun `变量大小写不敏感`() {
        assertEquals(eval("A", 0x3A), eval("a", 0x3A), 1e-9)
    }

    @Test
    fun `空白被忽略`() {
        assertEquals(14.0, eval("  2  +  3  *  4  "), 1e-9)
    }

    // ---------------------------------------------------------------- 函数

    @Test
    fun `全部内置函数`() {
        assertEquals(1.0, eval("min(3,1,2)"), 1e-9)
        assertEquals(3.0, eval("max(3,1,2)"), 1e-9)
        assertEquals(5.0, eval("abs(-5)"), 1e-9)
        assertEquals(3.0, eval("round(2.5)"), 1e-9)
        assertEquals(2.0, eval("floor(2.9)"), 1e-9)
        assertEquals(3.0, eval("ceil(2.1)"), 1e-9)
        assertEquals(3.0, eval("sqrt(9)"), 1e-9)
    }

    @Test
    fun `函数名大小写不敏感`() {
        assertEquals(1.0, eval("MIN(3,1,2)"), 1e-9)
    }

    @Test
    fun `函数参数可以是表达式`() {
        assertEquals(7.0, eval("max(1+2, 3+4)"), 1e-9)
    }

    // ---------------------------------------------------------------- 错误处理

    @Test
    fun `除零抛异常`() {
        assertThrows(Formula.FormulaException::class.java) { eval("1/0") }
    }

    @Test
    fun `模零抛异常`() {
        assertThrows(Formula.FormulaException::class.java) { eval("1%0") }
    }

    @Test
    fun `取超出数据长度的变量必须抛异常而不是返回0`() {
        // 刻意设计：避免「公式写错但静默算出一个看似合理的值」
        val e = assertThrows(Formula.FormulaException::class.java) { Formula.eval("C", ByteArray(2)) }
        assertTrue(e.message!!, e.message!!.contains("取不到"))
    }

    @Test
    fun `尾部有多余内容抛异常`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("1 2") }
        assertTrue(e.message!!, e.message!!.contains("多余内容"))
    }

    @Test
    fun `未知函数抛异常并提示可用函数`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("foo(1)") }
        assertTrue(e.message!!, e.message!!.contains("未知函数"))
    }

    @Test
    fun `多字符标识符报错`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("AB") }
        assertTrue(e.message!!, e.message!!.contains("变量只能是一位"))
    }

    @Test
    fun `结果非法时抛异常`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("sqrt(-1)") }
        assertTrue(e.message!!, e.message!!.contains("结果非法"))
    }

    @Test
    fun `空表达式抛异常`() {
        assertThrows(Formula.FormulaException::class.java) { eval("") }
    }

    @Test
    fun `缺右括号抛异常`() {
        assertThrows(Formula.FormulaException::class.java) { eval("(1+2") }
    }

    @Test
    fun `表达式不完整抛异常`() {
        assertThrows(Formula.FormulaException::class.java) { eval("1+") }
    }

    @Test
    fun `无法识别的字符抛异常`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("A # 1", 1) }
        assertTrue(e.message!!, e.message!!.contains("无法识别的字符"))
    }

    // ---------------------------------------------------------------- check()

    @Test
    fun `check 对合法表达式返回 null`() {
        assertNull(Formula.check("((A*256)+B)/4"))
        assertNull(Formula.check("(A-128)*100/128"))
        assertNull(Formula.check("bit(A,3)"))
        assertNull(Formula.check("0xFF"))
        assertNull(Formula.check("signed(A)*256+B"))
    }

    @Test
    fun `check 对非法表达式返回可读文案`() {
        assertNotNull(Formula.check("1/"))
        assertNotNull(Formula.check("AB"))
        assertNotNull(Formula.check("0x"))
        assertNotNull(Formula.check("foo(1)"))
    }

    @Test
    fun `check 用26字节零数据因此不会把越界变量误报为错误`() {
        assertNull(Formula.check("Z"))
        assertNull(Formula.check("A+B+C+D+E+F+G+H+I+J+K+L+M+N+O+P+Q+R+S+T+U+V+W+X+Y+Z"))
    }

    // ------------------------------------------------- 编码函数（v1.5.0 新增）

    @Test
    fun `be16 与 le16 是相反的字节序`() {
        assertEquals(0x3AF2.toDouble(), eval("be16(A,B)", 0x3A, 0xF2), 1e-9)
        assertEquals(0xF23A.toDouble(), eval("le16(A,B)", 0x3A, 0xF2), 1e-9)
    }

    @Test
    fun `be16 等价于手写大端公式`() {
        assertEquals(eval("(A*256)+B", 0x1A, 0xF8), eval("be16(A,B)", 0x1A, 0xF8), 1e-9)
    }

    @Test
    fun `s16 有符号 16 位`() {
        assertEquals(0.0, eval("s16(A,B)", 0x00, 0x00), 1e-9)
        assertEquals(32767.0, eval("s16(A,B)", 0x7F, 0xFF), 1e-9)
        assertEquals(-1.0, eval("s16(A,B)", 0xFF, 0xFF), 1e-9)
        assertEquals(-32768.0, eval("s16(A,B)", 0x80, 0x00), 1e-9)
    }

    @Test
    fun `s16 等价于手写有符号双字节`() {
        assertEquals(eval("signed(A)*256+B", 0xFF, 0xFE), eval("s16(A,B)", 0xFF, 0xFE), 1e-9)
    }

    @Test
    fun `bits 取任意位段`() {
        // 0xB6 = 0b1011_0110
        assertEquals(0.0, eval("bits(A,0,1)", 0xB6), 1e-9)
        assertEquals(1.0, eval("bits(A,1,1)", 0xB6), 1e-9)
        assertEquals(3.0, eval("bits(A,1,2)", 0xB6), 1e-9)
        assertEquals(0xB6.toDouble(), eval("bits(A,0,8)", 0xB6), 1e-9)
        assertEquals(11.0, eval("bits(A,4,4)", 0xB6), 1e-9)
    }

    @Test
    fun `bits 在单比特上与 bit 一致`() {
        for (n in 0..7) {
            assertEquals(
                "第 $n 位",
                eval("bit(A,$n)", 0xB6),
                eval("bits(A,$n,1)", 0xB6),
                1e-9
            )
        }
    }

    @Test
    fun `map 取最接近的 key`() {
        // 挡位表：0→0, 1→1, 2→2, 8→-1（倒挡）
        val expr = "map(A, 0,0, 1,1, 2,2, 8,-1)"
        assertEquals(0.0, eval(expr, 0), 1e-9)
        assertEquals(1.0, eval(expr, 1), 1e-9)
        assertEquals(-1.0, eval(expr, 8), 1e-9)
        assertEquals("带噪声时取最近：3 最接近 2", 2.0, eval(expr, 3), 1e-9)
        assertEquals("7 最接近 8", -1.0, eval(expr, 7), 1e-9)
    }

    @Test
    fun `map 参数不成对时报错`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("map(A, 1,2, 3)", 1) }
        assertTrue(e.message!!, e.message!!.contains("成对"))
    }

    @Test
    fun `map 参数太少时报错`() {
        val e = assertThrows(Formula.FormulaException::class.java) { eval("map(A)", 1) }
        assertTrue(e.message!!, e.message!!.contains("至少"))
    }

    @Test
    fun `check 认识全部新函数`() {
        assertNull(Formula.check("be16(A,B)"))
        assertNull(Formula.check("le16(A,B)"))
        assertNull(Formula.check("s16(A,B)"))
        assertNull(Formula.check("bits(A,2,3)"))
        assertNull(Formula.check("map(A, 1,10, 2,20)"))
    }
}
