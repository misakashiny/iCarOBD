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
 */
object Formula {

    class FormulaException(msg: String) : RuntimeException(msg)

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
        eval(expr, ByteArray(26))
        null
    } catch (t: Throwable) {
        t.message ?: "语法错误"
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
                "map" -> mapLookup(args)
                else -> throw FormulaException(
                    "未知函数 '$name'（可用: min max abs round floor ceil sqrt " +
                        "bit signed be16 le16 s16 bits map）"
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
