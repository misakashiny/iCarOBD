package com.icar.obd.data

/**
 * **PID 重复判定**（v1.20.12）。
 *
 * 用户原话：「检查 PID 页面、将重复多余的清除掉」。
 * 这一版把"什么叫重复"从**感觉**变成**判据**，而且是可单测的纯逻辑
 * （不碰 View / Store，见 `app/src/test/.../PidDedupTest.kt`）。
 *
 * ## 判据分两类，因为两类 PID 的"身份"不一样
 *
 * | 类别 | 身份由什么决定 | 为什么 |
 * |---|---|---|
 * | **请求型**（`source != "monitor"`、`mode != "MON"`） | `mode + pid + 公式` | 同一个请求（如 `01 05`）配同一个公式，解出来的就是同一个量 |
 * | **监听型**（`source == "monitor"` / `mode == "MON"`） | `报文 ID + 位段指纹` | 监听型**没有请求**，身份就是"从哪一帧的哪几个位取" |
 *
 * ⚠️ 监听型**不能**和请求型互判：一个是被动听广播、一个是主动问 ECU，
 * 即使名字一样也**不是**同一个数据来源（取不到值的时机完全不同）。
 *
 * ## 位段指纹：`bit(C,2)` 与 `bitsAt(18,1,0,0)` 必须判成同一个
 *
 * 这是本项目**真实踩到过的重复**：设备上有一条手搓的 `TestMonitor09A`，
 * 公式 `bitsAt(18,1,0,0)`；而内置的「左转向灯」是 `bit(C,2)`。
 * 两条文字完全不同，但：
 *
 * ```
 * bit(C,2)         C = 第 3 个字节 → 字节号 2；帧内线性位 = 2*8 + 2 = 18，长度 1
 * bitsAt(18,1,0,0) 起始位就是线性位 18，长度 1，Intel，无符号
 * ```
 *
 * → **同一个位**。所以指纹要先把 `bit` / `bits` / `signed` 都换算成
 * "帧内起始位 + 长度 + 字节序 + 符号"，再比较（换算规则见
 * [Formula.bitSequence] 与类注释：`A..Z` 依次是第 1..26 个数据字节）。
 */
object PidDedup {

    /** 一条"和别的条目指同一个物理量"的 PID */
    data class Duplicate(
        /** 重复的那一条（应当被清掉的候选） */
        val pid: PidDefinition,
        /** 它重复了谁（保留的那一条） */
        val shadowedBy: PidDefinition,
        /** 给人看的判据（会显示在确认对话框里） */
        val reason: String
    )

    // ---------------------------------------------------------------- 位段指纹

    private val RE_BITS_AT = Regex("""^bitsAt\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)""")
    private val RE_BIT = Regex("""^bit\(\s*([A-Za-z])\s*,\s*(\d+)\s*\)""")
    private val RE_BITS = Regex("""^bits\(\s*([A-Za-z])\s*,\s*(\d+)\s*,\s*(\d+)\s*\)""")
    private val RE_SIGNED = Regex("""^signed\(\s*([A-Za-z])\s*\)""")

    /** 字节变量 `A..Z` → 字节号 `0..25`。不是单个字母就返回 -1 */
    private fun byteOf(c: Char): Int {
        val u = c.uppercaseChar()
        return if (u in 'A'..'Z') u - 'A' else -1
    }

    /**
     * 位段指纹：`起始位:长度:字节序:符号|公式剩余部分`。
     *
     * 认不出来的公式返回 `null` —— **返回 null 就一律判"不重复"**：
     * 宁可漏报，也不能把两条不同的信号说成重复（那会导致误删真数据）。
     */
    fun bitFingerprint(formula: String): String? {
        val f = formula.trim()
        val head: String
        val tail: String
        when {
            RE_BITS_AT.containsMatchIn(f) -> {
                val m = RE_BITS_AT.find(f)!!
                head = "${m.groupValues[1]}:${m.groupValues[2]}:" +
                    "${m.groupValues[3]}:${m.groupValues[4]}"
                tail = f.substring(m.range.last + 1)
            }
            RE_BIT.containsMatchIn(f) -> {
                val m = RE_BIT.find(f)!!
                val b = byteOf(m.groupValues[1][0])
                if (b < 0) return null
                head = "${b * 8 + m.groupValues[2].toInt()}:1:0:0"
                tail = f.substring(m.range.last + 1)
            }
            RE_BITS.containsMatchIn(f) -> {
                val m = RE_BITS.find(f)!!
                val b = byteOf(m.groupValues[1][0])
                if (b < 0) return null
                head = "${b * 8 + m.groupValues[2].toInt()}:${m.groupValues[3]}:0:0"
                tail = f.substring(m.range.last + 1)
            }
            RE_SIGNED.containsMatchIn(f) -> {
                val m = RE_SIGNED.find(f)!!
                val b = byteOf(m.groupValues[1][0])
                if (b < 0) return null
                head = "${b * 8}:8:0:1"
                tail = f.substring(m.range.last + 1)
            }
            else -> return null
        }
        // 系数/偏移也是信号身份的一部分：同一位上 `*0.1` 与 `*1` 是两个量
        return head + "|" + tail.replace(Regex("\\s+"), "")
    }

    // ---------------------------------------------------------------- 判据

    /** 是不是"被动听广播"的监听型（没有请求，身份 = 报文 ID + 位段） */
    fun isMonitor(p: PidDefinition): Boolean =
        p.source.equals("monitor", ignoreCase = true) || p.mode.equals("MON", ignoreCase = true)

    private fun normFormula(f: String) = f.trim().replace(Regex("\\s+"), "")

    /** 报文 ID 比较：忽略大小写与前导 `0x` */
    private fun normHeader(h: String) =
        h.trim().removePrefix("0x").removePrefix("0X").uppercase()

    /**
     * 两条 PID 是否指**同一个物理量**。
     *
     * 只在"同类"之间比（见类注释的表格）。派生通道（`mode=CALC`）不参与 ——
     * 它是本地算出来的，没有"请求"也没有"报文"，同不同看 id 就够了。
     */
    fun isSameSignal(a: PidDefinition, b: PidDefinition): Boolean {
        if (a.id == b.id) return false          // 同一条，不算"重复"
        if (a.mode.equals("CALC", true) || b.mode.equals("CALC", true)) return false

        val ma = isMonitor(a)
        val mb = isMonitor(b)
        if (ma != mb) return false              // 监听型 vs 请求型：数据来源不同，不算重复
        if (ma) {
            if (normHeader(a.header) != normHeader(b.header)) return false
            if (normHeader(a.header).isEmpty()) return false
            val fa = bitFingerprint(a.formula) ?: return false
            val fb = bitFingerprint(b.formula) ?: return false
            return fa == fb
        }
        // 请求型：同一个请求 + 同一个公式
        return a.mode.equals(b.mode, true) &&
            a.pid.equals(b.pid, true) &&
            normFormula(a.formula) == normFormula(b.formula)
    }

    /**
     * 在整份 PID 表里找出重复条目。
     *
     * ## 规则
     *
     * - **内置之间不判重复**：内置表是刻意设计的（例如 `std_5E 燃油消耗率` 与
     *   `calc_lh 燃油流量` 同单位，但前者是**输入**、后者是**派生输出**），
     *   而且内置条目**永远不给用户删**。把它们报成"重复"只会诱导误删。
     * - **保留先出现的那一条**：`allPids()` 的顺序是「内置 → 自定义」，
     *   所以内置总是赢；两条都是自定义时，先建的赢。
     * - 认不出位段的监听型公式**不判重复**（宁漏勿错，见 [bitFingerprint]）。
     */
    fun findDuplicates(all: List<PidDefinition>): List<Duplicate> {
        val out = ArrayList<Duplicate>()
        for (i in all.indices) {
            for (j in i + 1 until all.size) {
                val keep = all[i]
                val dup = all[j]
                if (keep.builtIn && dup.builtIn) continue     // 内置之间不判
                if (!isSameSignal(keep, dup)) continue
                out.add(Duplicate(dup, keep, describe(keep, dup)))
            }
        }
        return out
    }

    private fun describe(keep: PidDefinition, dup: PidDefinition): String =
        if (isMonitor(keep)) {
            "与「${keep.name}」同报文 ${normHeader(keep.header)} 同一位段"
        } else {
            "与「${keep.name}」同请求 ${keep.mode} ${keep.pid}、同公式"
        }

    // ---------------------------------------------------------------- 安全闸

    /**
     * 这个 id 是否**被别的地方引用**（仪表 / 规则）。
     *
     * ⚠️ 被引用的**一律不删**：删了仪表会变空、规则会永远不成立 ——
     * 这正是任务里那条"不能动 Store 里已有配置的 id 引用"。
     */
    fun isReferenced(
        id: String,
        gaugePidIds: Collection<String>,
        ruleSourceIds: Collection<String>
    ): Boolean = id in gaugePidIds || id in ruleSourceIds

    /**
     * 从重复清单里筛出**可以安全清理**的那些：重复 且 没被任何仪表/规则引用。
     *
     * 返回的每一条都可以放心 `Store.deletePid` —— 调用方仍然应当先把
     * 清单显示给用户确认（本项目最忌"静默改用户数据"）。
     */
    fun removable(
        duplicates: List<Duplicate>,
        gaugePidIds: Collection<String>,
        ruleSourceIds: Collection<String>
    ): List<Duplicate> =
        duplicates.filter { !isReferenced(it.pid.id, gaugePidIds, ruleSourceIds) }

    /** 汇总一句给对话框/Toast 用的话 */
    fun summary(duplicates: List<Duplicate>): String =
        duplicates.joinToString("\n") { "· ${it.pid.name} —— ${it.reason}" }

    /**
     * 确认对话框的正文。
     *
     * ⚠️ **纯文本，不许出现 Markdown 标记**：这一页是 `TextView` 直接显示字符串，
     * 不做任何渲染 —— 写 `**同一个信号**` 用户看到的就是带星号的原文。
     * v1.20.11 刚在知识库那一页踩过同一个坑（144 个 `**` 原样显示给用户），
     * 所以这里把它抽成纯函数并**用单测钉住**（见 `PidDedupTest`）。
     */
    fun confirmMessage(duplicates: List<Duplicate>): String =
        "下面这些条目和已有的条目指的是同一个信号，" +
            "而且没有被任何仪表或规则引用：\n\n" +
            summary(duplicates) +
            "\n\n删除后它们从列表里消失（内置条目一律不动）。"
}
