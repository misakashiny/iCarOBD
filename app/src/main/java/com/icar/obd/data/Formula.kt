package com.icar.obd.data

/**
 * OBD 公式求值器。
 *
 * 支持用户手写的表达式，例如：
 *   ((A * 256) + B) * 0.1 - 40
 *   (A - 128) * 100 / 128
 *   bit(A, 7)
 *
 * 变量 A..Z 依次代表响应中的第 1..26 个数据字节。
 * 数字支持十进制、0x 十六进制、负数与小数。
 *
 * ## ⚠️ `bits(v,start,len)` 与 `bitsAt(起始位,长度,字节序,符号)` 不是一回事
 *
 * 这两个名字太像，**用错会解出别的信号的值，而现象上完全正常**。区别：
 *
 * | | 参数 | 能表达什么 |
 * |---|---|---|
 * | `bits(v,start,len)` | 第一个参数是**一个数值**（如 `A`、`be16(A,B)`） | 只能取**单字节内**的位段。跨字节取不到 —— 因为它的输入已经是一个数，不是整帧 |
 * | `bitsAt(s,l,o,g)` | 无"值"参数，**自己从整帧里按位序遍历** | Intel/Motorola × 任意位宽（≤64）× 有符号/无符号，**非字节对齐且跨字节也表达得了** |
 *
 * 具体说：`bits(A,6,4)` 在 A=0x03 时取不到跨到 B 的那两位（会返回 0），
 * 而 `bitsAt(6,4,0,0)` 会正确地从整帧的 bit6..bit9 取值。
 * **信号表生成的公式一律是 `bitsAt`**（见 `SignalTableCsv.formulaOf`）。
 */
object Formula {

    class FormulaException(msg: String) : RuntimeException(msg)

    /**
     * [check] 用的假数据长度。
     *
     * 原来是 26 字节（刚好够变量 A..Z）。但 `bitsAt` 的起始位可以落在更后面
     * （CAN FD 一帧最多 64 字节），26 字节会让**合法公式**被静态校验误判成"解到帧外"。
     * 取 64 = CAN FD 的上限。
     */
    private const val CHECK_BYTES = 64

    fun eval(expr: String, data: ByteArray): Double {
        val p = Parser(Lexer(expr).tokens(), data)
        val v = p.parseExpr()
        // tokens() 末尾总会补一个 END 哨兵，因此「表达式已解析完」的判据是
        // 「下一个 token 是 END」，而不是「下一个 token 为 null」。
        // 原写法 `p.peek() != null` 恒为真（哨兵不是 null），导致**任何合法表达式**
        // 都被判成「尾部有多余内容」而抛异常 —— 公式引擎整体不可用。
        val tail = p.peek()
        if (tail != null && tail.type != T.END) {
            throw FormulaException("表达式尾部有多余内容: ${tail.text.ifBlank { tail.type.name }}")
        }
        if (v.isNaN() || v.isInfinite()) throw FormulaException("结果非法: $v")
        return v
    }

    /** 静态校验：不传数据也能发现语法错误和未知变量 */
    fun check(expr: String): String? = try {
        eval(expr, ByteArray(CHECK_BYTES))
        null
    } catch (t: Throwable) {
        t.message ?: "语法错误"
    }

    // ---------- 位段：整帧按位序遍历（`bitsAt` 的实现）----------

    /**
     * 一个位段的**真实位序列**。
     *
     * @param startBit 起始位（DBC 位号：`字节号 × 8 + 字节内位号`）
     * @param len      长度（bit）
     * @param motorola `false` = Intel(LE) 小端；`true` = Motorola(BE) 大端
     * @return 每个信号位在帧里的线性位号（`字节号 × 8 + 字节内位号`），
     *         **顺序 = 从高位到低位**（Motorola）或**从低位到高位**（Intel）
     *
     * ## 为什么必须有这个函数（而不是拿 `startBit+len` 判越界）
     *
     * Motorola 是**锯齿位序**：位号在字节内从 7 递减到 0，减到 0 之后
     * 跳到**下一个字节的 bit7**。所以"起始位 18、长度 8"实际占
     * `b2.2 b2.1 b2.0 b3.7 b3.6 b3.5 b3.4 b3.3` ——
     * 线性判据 `18+8=26` 会以为要第 4 个字节，实际只用到第 3 个字节。
     *
     * 实测（2026-10-07 宝马参数总表）：按线性判据报了 2 条"越界"，
     * 重算真实位集后**都是误报**（`ST_OBD_CTFN_GRB` 实际只占 bit56~60、
     * `setMe_0xFC` 只占 bit24~31）。误报的代价是**把合法行拒掉**。
     *
     * @throws IllegalArgumentException 起始位为负或长度 ≤ 0（调用方应先校验）
     */
    fun bitSequence(startBit: Int, len: Int, motorola: Boolean): IntArray {
        require(startBit >= 0) { "起始位不能为负: $startBit" }
        require(len > 0) { "长度必须 ≥ 1: $len" }
        val out = IntArray(len)
        var byte = startBit / 8
        var bit = startBit % 8
        for (i in 0 until len) {
            out[i] = byte * 8 + bit
            if (motorola) {
                if (bit == 0) { bit = 7; byte++ } else bit--
            } else {
                if (bit == 7) { bit = 0; byte++ } else bit++
            }
        }
        return out
    }

    /**
     * 从**整帧**里取一个位段（通用位段函数，见类注释里与 `bits` 的区别）。
     *
     * @param startBit 起始位（0 起；DBC 位号）
     * @param len      长度（bit），1..64
     * @param motorola `false` = Intel(LE)；`true` = Motorola(BE)
     * @param signed   `true` = 按 len 位**补码**解释
     * @throws FormulaException 位段解到帧外（**用真实位集判**，见 [bitSequence]）
     */
    fun bitsAt(data: ByteArray, startBit: Int, len: Int, motorola: Boolean, signed: Boolean): Long {
        if (startBit < 0) throw FormulaException("bitsAt 的起始位不能为负（收到 $startBit）")
        if (len <= 0) throw FormulaException("bitsAt 的长度必须 ≥ 1（收到 $len）")
        if (len > 64) throw FormulaException("bitsAt 的长度最多 64（收到 $len）")
        val seq = bitSequence(startBit, len, motorola)
        val maxByte = seq.max() / 8
        if (maxByte >= data.size) {
            // 刻意**抛异常**而不是补 0：补 0 会让"公式/帧长配错了"静默变成一个看似合理的值
            // —— 与"取超出数据长度的变量必须抛异常"是同一条设计原则。
            throw FormulaException(
                "bitsAt 解到帧外：起始位=$startBit 长度=$len 需要第 ${maxByte + 1} 字节，但只有 ${data.size} 字节"
            )
        }
        var v = 0L
        if (motorola) {
            // 大端：第一个位是最高位，依次左移拼进来
            for (b in seq) v = (v shl 1) or bitAt(data, b).toLong()
        } else {
            // 小端：第 i 个位是第 i 位
            for (i in seq.indices) v = v or (bitAt(data, seq[i]).toLong() shl i)
        }
        if (signed && len < 64) {
            val signBit = 1L shl (len - 1)
            if (v and signBit != 0L) v -= (1L shl len)
        }
        return v
    }

    private fun bitAt(data: ByteArray, linearBit: Int): Int =
        (data[linearBit / 8].toInt() shr (linearBit % 8)) and 1

    /**
     * 取出表达式**开头**那个 `bitsAt(起始位,长度,字节序,符号)` 的四个字面量参数。
     *
     * @return `[起始位, 长度, 字节序(0/1), 符号(0/1)]`；不是 `bitsAt(...)` 形态、
     *         参数不是字面量（变量/嵌套调用）、参数个数 < 2、或参数本身非法时返回 `null`
     *
     * ## 为什么把它单独抽出来（v1.20.8，S3）
     *
     * 有**两处**需要这四个数，而且**必须得到同一个答案**：
     *  - [rawBits]：取位段的原始值，给 `PidDefinition.invalidRaw` 比；
     *  - `PidDraft.suggestedMinDlc`：按**真实位集**推算"这条信号至少要几个字节"，
     *    在 PID 编辑器里给用户建议 `minDlc`。
     *
     * 抄成两份的后果不是"多几行代码"，而是**编辑器算出的建议帧长与实际解码用的位段不一致** ——
     * 那正是本项目最怕的那类错："值解错了但看起来完全正常"。
     *
     * ## 只认信号表生成的那种形态
     *
     * 表达式必须以 `bitsAt(数字,数字,数字,数字)` 开头（后面的 `* f ± o` 随便）。
     * 其它形态（`bit(C,2)`、`A-40`、`be16(A,B)`）返回 `null` ——
     * 调用方一律回落到保守做法，**宁可漏判也不误判**。
     */
    fun bitsAtArgs(expr: String): IntArray? {
        val toks = try {
            Lexer(expr).tokens()
        } catch (t: Throwable) {
            return null
        }
        var i = 0
        val f = toks.getOrNull(i++) ?: return null
        if (f.type != T.FUNC || f.text != "bitsat") return null
        if (toks.getOrNull(i++)?.type != T.LP) return null
        val nums = ArrayList<Double>(4)
        while (true) {
            val t = toks.getOrNull(i++) ?: return null
            if (t.type == T.RP) break
            if (t.type == T.COMMA) continue
            // 参数必须是字面量：变量/嵌套调用会让"原始值"变得没有定义
            if (t.type != T.NUM) return null
            if (nums.size >= 4) return null
            nums.add(t.num)
        }
        if (nums.size < 2) return null
        val start = nums[0].toInt()
        val len = nums[1].toInt()
        if (start < 0 || len <= 0) return null
        val motorola = nums.getOrNull(2)?.toInt()?.let { it != 0 } ?: false
        val signed = nums.getOrNull(3)?.toInt()?.let { it != 0 } ?: false
        return intArrayOf(start, len, if (motorola) 1 else 0, if (signed) 1 else 0)
    }

    /**
     * 取表达式里 **`bitsAt(...)` 那一段的原始值**（未乘因子、未加偏移）。
     *
     * ## 为什么需要它
     *
     * `PidDefinition.invalidRaw`（无效原始值）比的是**原始值**，不是物理值：
     * 一条 `bitsAt(0,8,0,0) * 0.25 - 48` 的水温信号，`invalidRaw=255` 指的是
     * **位段本身**等于 255，而不是"算完等于 255"（算完是 15.75）。
     * 拿物理值去比会**误杀合法值**。
     *
     * ## 只认信号表生成的那种形态
     *
     * 形态判定与参数解析**全部在 [bitsAtArgs] 里**（单一权威）；这里只负责求值。
     * 其它形态返回 `null` —— 此时调用方回落到"拿公式求值结果比"，
     * **宁可漏判也不误判**。
     */
    fun rawBits(expr: String, data: ByteArray): Long? {
        val a = bitsAtArgs(expr) ?: return null
        return try {
            bitsAt(data, a[0], a[1], a[2] != 0, a[3] != 0)
        } catch (t: Throwable) {
            null
        }
    }


    // ---------- 词法 ----------

    private enum class T { NUM, VAR, OP, LP, RP, COMMA, FUNC, END }

    private data class Tok(val type: T, val text: String, val num: Double = 0.0)

    private class Lexer(private val s: String) {
        private var i = 0

        fun tokens(): List<Tok> {
            val out = ArrayList<Tok>()
            while (true) {
                skipWs()
                if (i >= s.length) break
                val c = s[i]
                when {
                    // 十六进制必须先判：'0' 也是数字，若先走 number()，0xFF 会被切成
                    // "0" + 未知标识符 "xFF"。该分支此前永远不可达（文档却宣称支持 0xFF）。
                    c == '0' && i + 1 < s.length && (s[i + 1] == 'x' || s[i + 1] == 'X') -> out.add(hex())
                    c.isDigit() || (c == '.' && i + 1 < s.length && s[i + 1].isDigit()) -> out.add(number())
                    c.isLetter() -> out.add(word())
                    c == '(' -> { out.add(Tok(T.LP, "(")); i++ }
                    c == ')' -> { out.add(Tok(T.RP, ")")); i++ }
                    c == ',' -> { out.add(Tok(T.COMMA, ",")); i++ }
                    c in "+-*/%^" -> { out.add(Tok(T.OP, c.toString())); i++ }
                    else -> throw FormulaException("无法识别的字符 '$c' @$i")
                }
            }
            out.add(Tok(T.END, ""))
            return out
        }

        private fun skipWs() { while (i < s.length && s[i].isWhitespace()) i++ }

        private fun number(): Tok {
            val st = i
            while (i < s.length && (s[i].isDigit() || s[i] == '.')) i++
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
                i++
                if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
                while (i < s.length && s[i].isDigit()) i++
            }
            val t = s.substring(st, i)
            return Tok(T.NUM, t, t.toDoubleOrNull() ?: throw FormulaException("数字格式错误: $t"))
        }

        private fun hex(): Tok {
            val st = i
            i += 2
            // 括号是必需的：原写法 `i < s.length && a || b || c` 中 && 优先级高于 ||，
            // 当 i 走到串尾后仍会对 s[i] 求值，抛 StringIndexOutOfBoundsException。
            while (i < s.length && (s[i] in '0'..'9' || s[i] in 'a'..'f' || s[i] in 'A'..'F')) i++
            val t = s.substring(st + 2, i)
            if (t.isEmpty()) throw FormulaException("十六进制缺少数字: ${s.substring(st)}")
            return Tok(T.NUM, "0x$t", t.toLongOrNull(16)?.toDouble() ?: throw FormulaException("十六进制错误: $t"))
        }

        private fun word(): Tok {
            val st = i
            // 标识符允许含数字 —— 函数名里有数字（be16 / le16 / s16），
            // 只认字母会把 "be16" 切成 "be" + "16"，直接报「未知标识符 'be'」。
            while (i < s.length && (s[i].isLetter() || s[i].isDigit())) i++
            val w = s.substring(st, i)
            skipWs()
            return if (i < s.length && s[i] == '(') {
                Tok(T.FUNC, w.lowercase())
            } else {
                if (w.length != 1) throw FormulaException("未知标识符 '$w'（变量只能是一位的 A-Z）")
                Tok(T.VAR, w.uppercase())
            }
        }
    }

    // ---------- 语法 ----------

    private class Parser(private val t: List<Tok>, private val data: ByteArray) {
        private var p = 0
        fun peek(): Tok? = t.getOrNull(p)
        private fun next(): Tok = t[p++]

        fun parseExpr(): Double {
            var v = parseTerm()
            while (true) {
                val k = peek() ?: break
                if (k.type != T.OP || (k.text != "+" && k.text != "-")) break
                next()
                v = if (k.text == "+") v + parseTerm() else v - parseTerm()
            }
            return v
        }

        private fun parseTerm(): Double {
            var v = parseUnary()
            while (true) {
                val k = peek() ?: break
                if (k.type != T.OP || k.text !in listOf("*", "/", "%")) break
                next()
                val r = parseUnary()
                v = when (k.text) {
                    "*" -> v * r
                    "/" -> if (r == 0.0) throw FormulaException("除零") else v / r
                    else -> if (r == 0.0) throw FormulaException("模零") else v % r
                }
            }
            return v
        }

        private fun parseUnary(): Double {
            val k = peek() ?: throw FormulaException("表达式不完整")
            return when {
                k.type == T.OP && k.text == "-" -> { next(); -parseUnary() }
                k.type == T.OP && k.text == "+" -> { next(); parseUnary() }
                else -> parsePower()
            }
        }

        private fun parsePower(): Double {
            val base = parsePrimary()
            val k = peek()
            if (k != null && k.type == T.OP && k.text == "^") {
                next()
                return Math.pow(base, parseUnary())
            }
            return base
        }

        private fun parsePrimary(): Double {
            val k = next()
            return when (k.type) {
                T.NUM -> k.num
                T.VAR -> {
                    val idx = k.text[0] - 'A'
                    if (idx !in data.indices) throw FormulaException("数据只有 ${data.size} 字节，取不到 ${k.text}")
                    (data[idx].toInt() and 0xFF).toDouble()
                }
                T.LP -> { val v = parseExpr(); expect(T.RP, "缺右括号"); v }
                T.FUNC -> call(k.text)
                else -> throw FormulaException("意外的 '${k.text}'")
            }
        }

        private fun expect(type: T, msg: String) {
            val k = next()
            if (k.type != type) throw FormulaException(msg)
        }

        private fun call(name: String): Double {
            // parsePrimary 已经消费了 FUNC token，左括号还留在流里，必须先吃掉。
            // 否则下面的 parseExpr() 会把 "(...)" 当成一个括号表达式整体解析掉，
            // 最后在 expect(RP) 处抛「函数 xxx 缺右括号」—— 所有函数调用都会失败。
            expect(T.LP, "函数 $name 缺左括号")
            val args = ArrayList<Double>()
            if (peek()?.type != T.RP) {
                while (true) { args.add(parseExpr()); if (peek()?.type == T.COMMA) next() else break }
            }
            expect(T.RP, "函数 $name 缺右括号")
            return when (name) {
                "min" -> args.minOrNull() ?: 0.0
                "max" -> args.maxOrNull() ?: 0.0
                "abs" -> Math.abs(args.firstOrNull() ?: 0.0)
                "round" -> Math.round(args.firstOrNull() ?: 0.0).toDouble()
                "floor" -> Math.floor(args.firstOrNull() ?: 0.0)
                "ceil" -> Math.ceil(args.firstOrNull() ?: 0.0)
                "sqrt" -> Math.sqrt(args.firstOrNull() ?: 0.0)
                "bit" -> {
                    val v = (args.getOrNull(0) ?: 0.0).toLong()
                    val n = (args.getOrNull(1) ?: 0.0).toInt()
                    if (((v shr n) and 1L) != 0L) 1.0 else 0.0
                }
                "signed" -> { // 把 A 当 8 位有符号数
                    val v = (args.getOrNull(0) ?: 0.0).toInt() and 0xFF
                    (if (v > 127) v - 256 else v).toDouble()
                }
                // ---- 多字节 / 位段 / 查表：厂家 PID 的常见编码，省得每次手写 ----
                "be16" -> bytes16(args, bigEndian = true).toDouble()
                "le16" -> bytes16(args, bigEndian = false).toDouble()
                "s16" -> {
                    val v = bytes16(args, bigEndian = true)
                    (if (v > 32767L) v - 65536L else v).toDouble()
                }
                "bits" -> {
                    val v = (args.getOrNull(0) ?: 0.0).toLong()
                    val start = (args.getOrNull(1) ?: 0.0).toInt().coerceIn(0, 63)
                    val len = (args.getOrNull(2) ?: 1.0).toInt().coerceIn(1, 64 - start)
                    val mask = if (len >= 64) -1L else (1L shl len) - 1L
                    ((v shr start) and mask).toDouble()
                }
                // ⚠️ 与上面的 `bits` **不是一回事**：`bits` 的输入是一个数值（只能单字节内），
                // 而 `bitsAt` 自己拿整帧按位序遍历，所以跨字节 + 非对齐 + Motorola 都表达得了。
                // 详见类注释里的对照表 —— 用错的表现是"解出别的信号的值，看起来却很正常"。
                "bitsat" -> {
                    val start = (args.getOrNull(0) ?: 0.0).toInt()
                    val len = (args.getOrNull(1) ?: 0.0).toInt()
                    val motorola = (args.getOrNull(2) ?: 0.0).toInt() != 0
                    val signed = (args.getOrNull(3) ?: 0.0).toInt() != 0
                    // 限定 Formula. 前缀：Parser 是**嵌套类**，对 object 成员不做隐式解析
                    Formula.bitsAt(data, start, len, motorola, signed).toDouble()
                }
                "map" -> mapLookup(args)
                else -> throw FormulaException(
                    "未知函数 '$name'（可用: min max abs round floor ceil sqrt " +
                        "bit signed be16 le16 s16 bits bitsAt map）"
                )
            }
        }

        /** `be16(A,B)` 大端 / `le16(A,B)` 小端：两字节拼成 16 位 */
        private fun bytes16(args: List<Double>, bigEndian: Boolean): Long {
            val a = (args.getOrNull(0) ?: 0.0).toLong() and 0xFF
            val b = (args.getOrNull(1) ?: 0.0).toLong() and 0xFF
            return if (bigEndian) (a shl 8) or b else (b shl 8) or a
        }

        /**
         * `map(值, key0, value0, key1, value1, ...)`：查表映射。
         *
         * 取**最接近**的 key，而不是要求精确相等 —— 厂家信号常带噪声或量化误差，
         * 精确匹配会大量落到兜底值上。用于挡位、状态字这类离散量。
         */
        private fun mapLookup(args: List<Double>): Double {
            if (args.size < 3) {
                throw FormulaException("map 至少需要 3 个参数：map(值, key, value, ...)")
            }
            if ((args.size - 1) % 2 != 0) {
                throw FormulaException("map 的 key/value 必须成对：map(值, k1,v1, k2,v2, ...)")
            }
            val x = args[0]
            var bestVal = 0.0
            var bestDist = Double.MAX_VALUE
            var i = 1
            while (i + 1 < args.size) {
                val d = Math.abs(args[i] - x)
                if (d < bestDist) {
                    bestDist = d
                    bestVal = args[i + 1]
                }
                i += 2
            }
            return bestVal
        }
    }
}
