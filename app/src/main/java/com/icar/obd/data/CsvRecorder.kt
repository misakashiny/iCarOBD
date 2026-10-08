package com.icar.obd.data

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * CSV 行车数据记录器。
 *
 * 目的：把总线上的真实数据留档，方便离线复盘「某个 PID 到底有没有数据 / 变化范围是多少」。
 * 与 [AppLog] 的区别：AppLog 记事件与报文，CSV 记数值序列（可用 Excel / pandas 直接画图）。
 *
 * 写盘策略：单文件按启动时间命名，1Hz 采样，避免高频写盘拖慢轮询。
 */
class CsvRecorder(private val baseDir: File) {

    private val io = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "csv-io").apply { isDaemon = true }
    }

    @Volatile
    private var file: File? = null

    @Volatile
    var enabled: Boolean = false
        private set

    /** 当前列顺序（pidId），启动后固定，保证同一文件列对齐 */
    private var columns: List<String> = emptyList()

    private var headerWritten = false

    fun start(pidIds: List<String>) {
        if (pidIds.isEmpty()) {
            AppLog.w(AppLog.M_DATA, "CSV 未启动：没有启用的 PID")
            return
        }
        val dir = File(baseDir, "csv").apply { mkdirs() }
        val name = "obd-${SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())}.csv"
        file = File(dir, name)
        columns = pidIds
        headerWritten = false
        enabled = true
        AppLog.i(AppLog.M_DATA, "CSV 记录开始", "file=${file?.absolutePath} cols=${columns.size}")
    }

    fun stop() {
        if (!enabled) return
        enabled = false
        AppLog.i(AppLog.M_DATA, "CSV 记录停止", "file=${file?.name}")
    }

    /** 采样一行。values 缺列时写空，保证列对齐。 */
    fun append(snapshot: Map<String, PidValue>, extra: Map<String, String> = emptyMap()) {
        if (!enabled) return
        val f = file ?: return
        val cols = columns
        io.execute {
            try {
                if (!headerWritten) {
                    val sb = StringBuilder("ts,time")
                    cols.forEach { sb.append(',').append(csvEscape(Store.findPid(it)?.name ?: it)) }
                    extra.keys.forEach { sb.append(',').append(csvEscape(it)) }
                    sb.append('\n')
                    // ⚠️⚠️ **BOM 必须写在文件最前面**（v1.20.7 修，规格 §7 陷阱 3）。
                    //
                    // 表头用的是 **PID 的中文名**，而 Windows Excel 打开一份**没有 BOM**
                    // 的 UTF-8 CSV 时会按**系统 ANSI（中文机器上=GBK）**解码 →
                    // 整行表头乱码。这不是"显示难看"，是**表头认不出来**（列名全成了问号）。
                    //
                    // `EF BB BF` 这三个字节就是"这是 UTF-8"的声明。
                    // 写入位置必须是**文件第一个字节** —— 所以只在写表头这一次加，
                    // 后面每行的 appendText 都不加（加到中间会变成正文里的乱码字符）。
                    f.appendText(SignalTableCsv.withBom(sb.toString()))
                    headerWritten = true
                }
                val now = System.currentTimeMillis()
                val sb = StringBuilder()
                sb.append(now).append(',')
                    .append(SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date(now)))
                cols.forEach { id ->
                    val v = snapshot[id]
                    sb.append(',')
                    if (v != null && v.ok) sb.append(fmt(v.value)) else sb.append("")
                }
                extra.forEach { (_, v) -> sb.append(',').append(csvEscape(v)) }
                sb.append('\n')
                f.appendText(sb.toString())
            } catch (t: Throwable) {
                // 记录失败不能再抛，避免拖垮轮询线程
                AppLog.e(AppLog.M_DATA, "CSV 写入失败", t.message ?: "")
            }
        }
    }

    private fun fmt(v: Float): String =
        if (v.isNaN() || v.isInfinite()) "" else String.format(Locale.US, "%.3f", v)

    private fun csvEscape(s: String): String =
        if (s.any { it == ',' || it == '"' || it == '\n' }) "\"" + s.replace("\"", "\"\"") + "\"" else s

    fun files(): List<File> {
        val dir = File(baseDir, "csv")
        return (dir.listFiles { f -> f.name.endsWith(".csv") } ?: emptyArray())
            .sortedByDescending { it.lastModified() }
    }
}
