package com.icar.obd.obd

/** 用户接收过滤输入的唯一校验；只允许接收过滤命令，不允许任意适配器操作。 */
object CanReceiveFilter {
    data class Result(val commands: List<String>, val error: String? = null)
    fun parse(text: String): Result {
        val value = text.trim().uppercase()
        if (value.isEmpty()) return Result(emptyList())
        if (value.any { it == '\r' || it == '\n' || it.code > 127 }) return bad()
        fun id(hex: String): Boolean =
            (hex.length == 3 || hex.length == 8) && hex.all { it in '0'..'9' || it in 'A'..'F' } &&
                (hex.toLongOrNull(16) ?: Long.MAX_VALUE) <= if (hex.length == 3) 0x7FF else 0x1FFFFFFF
        if (id(value)) return Result(listOf("ATCRA$value"))
        val parts = value.split('+', ';').map { it.trim().replace(" ", "") }
        if (parts.any { it.isEmpty() }) return bad()
        if (parts.size == 1 && parts[0].startsWith("ATCRA") && id(parts[0].removePrefix("ATCRA"))) {
            return Result(parts)
        }
        if (parts.size == 2 && parts[0].startsWith("ATCM") && parts[1].startsWith("ATCF")) {
            val mask = parts[0].removePrefix("ATCM"); val filter = parts[1].removePrefix("ATCF")
            if (mask.length == filter.length && id(mask) && id(filter)) return Result(parts)
        }
        return bad()
    }
    private fun bad() = Result(emptyList(), "过滤器无效：填3位或8位CAN ID，或ATCM掩码+ATCF过滤值")
}
