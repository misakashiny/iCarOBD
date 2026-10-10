package com.icar.obd.data

/**
 * **日志页的文案**（v1.20.17）—— 纯函数，JVM 单测覆盖。
 *
 * ## 为什么单独一份
 *
 * 规格 `docs/下一步-UI改进四项.md` §3 要求文案**说清"为什么空 + 下一步做什么"**。
 * 而日志页的空态有**三种完全不同的原因**（还没产生 / 级别筛掉了 / 模块筛掉了），
 * 用户的下一步动作完全不同 —— 只写一句"暂无数据"等于让他自己猜。
 *
 * 把这些判断抽成纯函数有两条好处：
 * 1. 能在 JVM 里断言"哪种情形该说什么话"（`ui/LogFragment` 一碰 Android 就跑不了）；
 * 2. ⚠️ **性能红线**（规格 §4）：日志页在极端突发时已知会丢显示，
 *    所以这里**只有字符串拼接、没有任何集合拷贝**，
 *    调用点也必须放在"每 250ms 一次"的那条刷新路径上（不是每条日志）。
 */
object LogViewText {

    /** 日志页的"全部"（模块筛选项的默认值，与 `LogAdapter.ALL` 同一个词） */
    const val ALL = "全部"

    /**
     * 统计行：`显示 128 条 · 缓冲 3000 条 · 只显示 I 及以上`。
     *
     * ## 为什么把"缓冲"也写出来（原来就写，v1.20.17 说得更清楚）
     *
     * 两个数字**不相等**是常态（过滤器在起作用），而用户看到"显示 12 条"却
     * 不知道缓冲区里其实有 3000 条时，会以为日志丢了。
     *
     * @param shown 当前列表里显示的条数（`LogAdapter.count()`）
     * @param buffered 内存缓冲总条数（`AppLog.size()`）
     * @param levelText 级别过滤的中文描述（见 [levelFilterText]）
     * @param module 模块过滤（[ALL] = 不筛）
     */
    fun statsLine(shown: Int, buffered: Int, levelText: String, module: String): String {
        val base = "显示 $shown 条 · 缓冲 $buffered 条"
        val filters = ArrayList<String>(2)
        // ⚠️ 判据是"级别没在筛"，而不是"levelText 等于 LEVEL_ALL"：
        // [levelFilterText] 对 V 返回的是"全部（V 及以上）"—— 用 `!=` 比会把
        // 这句也当成过滤条件写进括号里（实测踩过：统计行变成
        // "只显示 全部（V 及以上）"），而 V 本来就是"什么都不挡"。
        if (levelText.isNotBlank() && !levelText.startsWith(LEVEL_ALL)) {
            filters += "只显示 $levelText"
        }
        if (module != ALL) filters += "只看 $module 模块"
        return if (filters.isEmpty()) base else base + "（" + filters.joinToString("、") + "）"
    }

    /** 级别过滤在统计行里显示的词（"全部"= 不筛） */
    const val LEVEL_ALL = "全部"

    /**
     * 级别过滤的中文描述。
     *
     * ⚠️ 判据是 `prio >= 选中级别`（不是"等于"）—— 选 `W` 时 `E` 也显示。
     * 原来的下拉框只写 `W`，用户会以为"选了 W 就只看 W"，然后奇怪为什么 `E` 还在。
     */
    fun levelFilterText(tag: String): String = when (tag) {
        "V" -> "全部（V 及以上）"
        "D" -> "D 及以上（调试）"
        "I" -> "I 及以上（常规）"
        "W" -> "W 及以上（警告与错误）"
        "E" -> "只有 E（错误）"
        else -> LEVEL_ALL
    }

    /**
     * 空态：**为什么空 + 下一步做什么**（规格 §3）。
     *
     * 三种情形（按"用户最可能做错的顺序"排）：
     * 1. **缓冲区里有、但被筛掉了** → 告诉他改哪个下拉框（最常见的一种，
     *    因为默认级别是 `V`，而模块默认是"全部"，所以最常见的是模块筛）；
     * 2. **缓冲区本来就是空的** → 说明日志什么时候才会有（App 一用就会写）；
     * 3. 都不匹配（理论到不了）→ 给一句万能的话，**不编**原因。
     */
    fun emptyHint(buffered: Int, levelTag: String, module: String): String {
        if (buffered > 0) {
            val why = if (module != ALL) {
                "模块筛的是「$module」，而缓冲区里那 $buffered 条都不是这个模块"
            } else if (levelTag != "V") {
                "级别筛的是「${levelTextShort(levelTag)}」，低级别的条目被挡住了"
            } else {
                "当前筛选条件把它们都挡住了"
            }
            return "这里没有可显示的行 —— $why。\n" +
                "把上面两个下拉框都调回「全部」就能看到全部 $buffered 条。"
        }
        return "还没有日志。\n" +
            "App 一用就会写（连接适配器、开轮询、跑规则都会留痕）；" +
            "刚清空过、或刚装完还没连过车时，这里就是空的。"
    }

    /** 下拉框里那一个字母 → 短说明（空态里用，不重复 [levelFilterText] 的整句） */
    private fun levelTextShort(tag: String): String = when (tag) {
        "V" -> "V 详细"
        "D" -> "D 调试"
        "I" -> "I 常规"
        "W" -> "W 警告"
        "E" -> "E 错误"
        else -> tag
    }
}
