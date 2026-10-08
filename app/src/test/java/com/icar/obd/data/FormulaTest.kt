package com.icar.obd.data

import org.junit.Assert.assertArrayEquals
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
    fun `check 用足量零数据因此不会把越界变量误报为错误`() {
        assertNull(Formula.check("Z"))
        assertNull(Formula.check("A+B+C+D+E+F+G+H+I+J+K+L+M+N+O+P+Q+R+S+T+U+V+W+X+Y+Z"))
        // 假数据是 64 字节（CAN FD 上限）：起始位落在 26 字节之外的 bitsAt 也必须算合法
        assertNull(Formula.check("bitsAt(200,8,0,0)"))
        // 504 = 第 64 字节（下标 63）的第 0 位，8 位刚好用完最后一个字节
        assertNull(Formula.check("bitsAt(504,8,0,0)"))
        assertNotNull("超出 64 字节才该报错", Formula.check("bitsAt(512,8,0,0)"))
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
        assertNull(Formula.check("bitsAt(18,1,0,0)"))
        assertNull(Formula.check("map(A, 1,10, 2,20)"))
    }

    // ============================================ 通用位段 bitsAt（v1.20.7，S1 规格 §3.5）
    //
    // `bitsAt(起始位,长度,字节序,符号)` —— 字节序 0=Intel(LE) / 1=Motorola(BE)，
    // 符号 0=unsigned / 1=signed。
    //
    // ⚠️ 它和 `bits(v,start,len)` **名字太像但不是一回事**（见 `Formula` 的类注释）：
    // `bits` 的输入是**一个数值**，所以只能取单字节内的位段；
    // `bitsAt` 自己拿**整帧**按位序遍历，跨字节 + 非对齐 + Motorola 都表达得了。
    // 下面第一组用例专门把两者的差别钉住。

    @Test
    fun `bitsAt 与 bits 的区别：bits 取不到跨字节的位`() {
        // 0xC3 0x03：bit6..bit9 一共 4 位
        //   bit6,7 = 1,1（0xC3 的高两位）；bit8,9 = 1,1（0x03 的低两位）
        //   Intel 小端拼起来 = 1 + 2 + 4 + 8 = 15
        assertEquals("整帧按位序：15", 15.0, eval("bitsAt(6,4,0,0)", 0xC3, 0x03), 1e-9)
        // `bits(A,6,4)` 只能在 A 这一个字节内右移，跨到 B 的那两位**永远取不到**
        assertEquals("单字节内右移：3", 3.0, eval("bits(A,6,4)", 0xC3, 0x03), 1e-9)
    }

    @Test
    fun `bitsAt Intel 单字节与对齐`() {
        assertEquals(0xB6.toDouble(), eval("bitsAt(0,8,0,0)", 0xB6), 1e-9)
        assertEquals(11.0, eval("bitsAt(4,4,0,0)", 0xB6), 1e-9)
        assertEquals(0.0, eval("bitsAt(0,1,0,0)", 0xB6), 1e-9)
        assertEquals(1.0, eval("bitsAt(1,1,0,0)", 0xB6), 1e-9)
    }

    @Test
    fun `bitsAt Intel 跨字节按小端拼接`() {
        // 0xAB 0xCD，取 bit4..bit11：
        //   0xAB = 1010_1011 → bit4..7 = 0,1,0,1 → 值的低 4 位 = 0b1010 = 0xA
        //   0xCD = 1100_1101 → bit8..11（= 该字节的 bit0..3）= 1,0,1,1 → 值的高 4 位 = 0xD
        assertEquals(0xDA.toDouble(), eval("bitsAt(4,8,0,0)", 0xAB, 0xCD), 1e-9)
        // 16 位对齐跨字节 = 小端读法
        assertEquals(0xCDAB.toDouble(), eval("bitsAt(0,16,0,0)", 0xAB, 0xCD), 1e-9)
    }

    @Test
    fun `bitsAt Motorola 单字节内是高位在前`() {
        // 起始位 7 = 该字节的最高位，锯齿位序下就是整字节本身
        assertEquals(0xB6.toDouble(), eval("bitsAt(7,8,1,0)", 0xB6), 1e-9)
        // 起始位 4、长度 4 → bit4,3,2,1 → 0xB6=1011_0110 的 bit4..1 = 1011 = 0xB
        assertEquals(0xB.toDouble(), eval("bitsAt(4,4,1,0)", 0xB6), 1e-9)
    }

    @Test
    fun `bitsAt Motorola 跨字节是锯齿位序`() {
        // 起始位 2、长度 8：b0.2 b0.1 b0.0 b1.7 b1.6 b1.5 b1.4 b1.3
        //   byte0 = 0x03 = 0000_0011 → bit2=0 bit1=1 bit0=1
        //   byte1 = 0xB0 = 1011_0000 → bit7=1 bit6=0 bit5=1 bit4=1 bit3=0
        //   从高位到低位拼：0 1 1 1 0 1 1 0 = 0x76
        assertEquals(0x76.toDouble(), eval("bitsAt(2,8,1,0)", 0x03, 0xB0), 1e-9)
        // 大端 16 位对齐 = 大端读法
        assertEquals(0xABCD.toDouble(), eval("bitsAt(7,16,1,0)", 0xAB, 0xCD), 1e-9)
    }

    @Test
    fun `bitsAt signed 按补码解释`() {
        assertEquals(255.0, eval("bitsAt(0,8,0,0)", 0xFF), 1e-9)
        assertEquals(-1.0, eval("bitsAt(0,8,0,1)", 0xFF), 1e-9)
        assertEquals(-128.0, eval("bitsAt(0,8,0,1)", 0x80), 1e-9)
        assertEquals(127.0, eval("bitsAt(0,8,0,1)", 0x7F), 1e-9)
        assertEquals(-2.0, eval("bitsAt(7,16,1,1)", 0xFF, 0xFE), 1e-9)
        // 非字节对齐的有符号位段：bit2..bit5 取 4 位，值 0b1111 = -1
        assertEquals(-1.0, eval("bitsAt(2,4,0,1)", 0b0011_1100), 1e-9)
    }

    @Test
    fun `bitsAt 因子与偏移按普通算术接在后面`() {
        // 信号表生成的形态：bitsAt(...) * 0.25 - 48
        assertEquals(255.0 * 0.25 - 48, eval("bitsAt(0,8,0,0) * 0.25 - 48", 0xFF), 1e-9)
        // 与 bit() 等价：1 位信号
        assertEquals(eval("bit(C,2)", 0, 0, 4), eval("bitsAt(18,1,0,0)", 0, 0, 4), 1e-9)
    }

    @Test
    fun `bitsAt 解到帧外必须抛异常而不是补零`() {
        // 补 0 会让"公式/帧长配错了"静默变成一个看似合理的值
        val e = assertThrows(Formula.FormulaException::class.java) { eval("bitsAt(16,8,0,0)", 0x01, 0x02) }
        assertTrue(e.message!!, e.message!!.contains("解到帧外"))
        assertThrows(Formula.FormulaException::class.java) { eval("bitsAt(7,8,0,0)") }
    }

    @Test
    fun `bitsAt 的参数非法时给出可读错误`() {
        assertThrows(Formula.FormulaException::class.java) { eval("bitsAt(0,0,0,0)", 0x01) }
        assertThrows(Formula.FormulaException::class.java) { eval("bitsAt(-1,8,0,0)", 0x01) }
        assertThrows(Formula.FormulaException::class.java) { eval("bitsAt(0,65,0,0)", 0x01) }
    }

    @Test
    fun `bitSequence 展开真实位序`() {
        // Intel：起始位向高位递增，跨字节时字节号 +1、字节内位号回 0
        assertArrayEquals(intArrayOf(6, 7, 8, 9), Formula.bitSequence(6, 4, motorola = false))
        assertArrayEquals(intArrayOf(18), Formula.bitSequence(18, 1, motorola = false))
        // Motorola：字节内 7→0 递减，减到 0 后跳到**下一个字节的 bit7**（锯齿）
        assertArrayEquals(intArrayOf(2, 1, 0, 15), Formula.bitSequence(2, 4, motorola = true))
        // 实测案例：起始位 60、长度 5 → 只占第 8 字节（b7.4..b7.0），
        // 线性的 60+5=65 会误报"要第 9 字节"
        assertArrayEquals(intArrayOf(60, 59, 58, 57, 56), Formula.bitSequence(60, 5, motorola = true))
    }

    @Test
    fun `bitSequence 拒绝非法参数`() {
        assertThrows(IllegalArgumentException::class.java) { Formula.bitSequence(-1, 4, false) }
        assertThrows(IllegalArgumentException::class.java) { Formula.bitSequence(0, 0, false) }
    }

    // ------------------------------------------- rawBits：取位段的"原始值"

    @Test
    fun `rawBits 取的是位段本身 不是乘完因子之后的物理值`() {
        // 这正是 invalidRaw（无效原始值）要比的东西：
        // `bitsAt(0,8,0,0) * 0.25 - 48` 的原始值是 255，物理值是 15.75。
        // 拿物理值去比 255 会**永远不命中**，拿位段比才对。
        assertEquals(255L, Formula.rawBits("bitsAt(0,8,0,0) * 0.25 - 48", byteArrayOf(0xFF.toByte())))
        assertEquals(255L, Formula.rawBits("bitsAt(0,8,0,0)", byteArrayOf(0xFF.toByte())))
        assertEquals(15.75, Formula.eval("bitsAt(0,8,0,0) * 0.25 - 48", byteArrayOf(0xFF.toByte())), 1e-9)
    }

    @Test
    fun `rawBits 对非 bitsAt 形态返回 null`() {
        // 宁可漏判也不误判：手写公式的"原始值"没有定义
        assertNull(Formula.rawBits("bit(C,2)", byteArrayOf(0, 0, 4)))
        assertNull(Formula.rawBits("A-40", byteArrayOf(0xFF.toByte())))
        assertNull(Formula.rawBits("be16(A,B)", byteArrayOf(1, 2)))
        assertNull(Formula.rawBits("bits(A,0,8)", byteArrayOf(1)))
        // 参数不是字面量（变量/嵌套）也不行
        assertNull(Formula.rawBits("bitsAt(A,8,0,0)", byteArrayOf(1)))
        assertNull(Formula.rawBits("", byteArrayOf(1)))
    }

    @Test
    fun `rawBits 支持 2 个参数的最小形态 并尊重字节序与符号`() {
        assertEquals(0x76L, Formula.rawBits("bitsAt(2,8,1,0)", byteArrayOf(0x03, 0xB0.toByte())))
        assertEquals(-1L, Formula.rawBits("bitsAt(0,8,0,1)", byteArrayOf(0xFF.toByte())))
        assertEquals(255L, Formula.rawBits("bitsAt(0,8)", byteArrayOf(0xFF.toByte())))
    }

    @Test
    fun `rawBits 解到帧外时返回 null 而不是抛`() {
        assertNull(Formula.rawBits("bitsAt(16,8,0,0)", byteArrayOf(1, 2)))
    }
}
