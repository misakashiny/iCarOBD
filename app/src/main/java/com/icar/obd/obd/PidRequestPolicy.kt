package com.icar.obd.obd

import com.icar.obd.data.PidDefinition

/** Safety boundary for user-configured reads. Internal adapter setup is not a PID. */
object PidRequestPolicy {
    private val readServices = setOf(0x01, 0x09, 0x21, 0x22)

    /** Immutable snapshot: later edits to a definition cannot change a checked send/header. */
    class ReadRequest internal constructor(val command: String, val header: String)
    data class Check(val request: ReadRequest?, val error: String?)

    fun check(pid: PidDefinition): Check {
        fun reject(reason: String) = Check(null, "请求安全拦截：$reason")
        if (!pid.source.equals("poll", true)) return reject("此来源不能主动请求")
        val declared = pid.mode.trim().toIntOrNull(16)
        if (declared !in readServices) return reject("Mode ${pid.mode} 不属于允许的读取模式")
        val original = pid.customRequest?.takeIf { it.isNotBlank() } ?: "${pid.mode} ${pid.pid}"
        if (hasControl(original)) return reject("请求含换行或控制字符")
        val command = PidDefinition.normalize(original)
        readError(command)?.let { return reject(it) }
        val actual = command.replace(" ", "").take(2).toInt(16)
        if (actual != declared) return reject("覆写请求的模式与声明Mode不一致")

        val header = pid.header.trim().uppercase()
        if (hasControl(pid.header)) return reject("模块头含控制字符")
        if (header.isNotEmpty()) {
            val value = header.toLongOrNull(16)
            val valid = header.all { it in "0123456789ABCDEF" } && when (header.length) {
                3 -> value != null && value <= 0x7FF
                8 -> value != null && value <= 0x1FFFFFFF
                else -> false
            }
            if (!valid) return reject("模块头必须为合法11位或29位CAN标识")
        }
        return Check(ReadRequest(command, header), null)
    }

    /** Final session defense. AT is reserved for the internal setup/monitor paths. */
    fun sessionError(command: String): String? {
        // Existing setup/headerSwitch commands include a trailing CR; trim that terminator.
        val tx = command.trim().uppercase()
        if (hasControl(tx)) return "会话命令含换行或控制字符"
        if (tx.startsWith("AT")) {
            return if (tx.length in 3..64 && tx.all { it in "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " }) null
            else "适配器命令格式不合法"
        }
        return readError(PidDefinition.normalize(tx))
    }

    private fun hasControl(text: String): Boolean = text.any { (it.code < 32 && it != '\t') || it.code == 127 }

    internal fun readError(command: String): String? {
        val hex = command.replace(" ", "")
        if (hex.length !in 4..64 || hex.length % 2 != 0 || hex.any { it !in "0123456789ABCDEF" }) {
            return "读取请求必须为完整的十六进制字节（含服务与PID）"
        }
        val service = hex.take(2).toInt(16)
        if (service !in readServices || ObdProtocol.isDangerous(hex.take(2))) {
            return "服务 ${hex.take(2)} 不属于允许的读取模式"
        }
        if (service == 0x22 && hex.length < 6) return "Mode22读取缺少两字节数据标识"
        return null
    }
}
