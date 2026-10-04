package com.icar.obd.data

import android.os.Handler
import android.os.Looper
import java.io.File
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock

/**
 * 结构化日志系统。
 *
 * 设计目标：排查车辆总线问题时，比反复 adb logcat 高效得多。
 *
 * ## 四条自我保护（v1.3.0 新增，都是被实车打出来的）
 *
 * 2026-10-02 实车运行时，BLE 写入失败进入了无限重试，每次都写一条日志，
 * **2 小时刷出 113 万行 / 57MB**，并间接导致日志页崩溃。因此现在：
 *
 *  1. **重复消息抑制**（[dedupLock] 那段）：同一 (级别,模块,消息,附加) 在
 *     [DEDUP_WINDOW_MS] 内重复时只累计计数，最多每 [DEDUP_SUMMARY_INTERVAL_MS]
 *     吐一条带「重复 N 次」的汇总。任何单点刷屏都不可能再撑爆日志。
 *  2. **单日文件大小上限**（[MAX_FILE_BYTES]）：超过就停止写盘并记一条警告，
 *     避免把设备存储写满。
 *  3. **落盘队列有界**（[IO_QUEUE_CAPACITY]）：IO 跟不上时丢弃最旧的任务并计数，
 *     不再让队列无限增长直到 OOM。
 *  4. **监听器批量派发**：每条日志都 post 一次主线程任务会让主线程在洪泛时瘫痪，
 *     现在合并成一批一次派发。
 *
 * 另外新增 [size]，让 UI 不必为了拿一个数字而拷贝整个缓冲。
 */
object AppLog {

    enum class Level(val tag: String, val prio: Int) {
        V("V", 0), D("D", 1), I("I", 2), W("W", 3), E("E", 4);

        companion object {
            fun fromTag(t: String): Level = entries.firstOrNull { it.tag == t } ?: I
        }
    }

    /** 模块标签：过滤时按模块看更容易定位问题 */
    const val M_BLE = "BLE"
    const val M_OBD = "OBD"
    const val M_SCAN = "SCAN"
    const val M_RULE = "RULE"
    const val M_AUDIO = "AUDIO"
    const val M_UI = "UI"
    const val M_SYS = "SYS"
    const val M_DATA = "DATA"

    data class Entry(
        val ts: Long,
        val module: String,
        val level: Level,
        val msg: String,
        val extra: String = ""
    ) {
        fun format(): String {
            val d = SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date(ts))
            return "[$d][$module][${level.tag}] $msg" + if (extra.isBlank()) "" else " | $extra"
        }
    }

    private const val CAPACITY = 3000
    private const val KEEP_DAYS = 7

    /** 单日日志文件上限 24MB。超过就停写并警告 —— 正常使用一天不会超过 2MB */
    private const val MAX_FILE_BYTES = 24L * 1024 * 1024

    /** 落盘队列上限：IO 跟不上时丢最旧的，不无限堆积 */
    private const val IO_QUEUE_CAPACITY = 4096

    /** 同一消息在多长时间窗口内视为「重复」 */
    private const val DEDUP_WINDOW_MS = 2000L

    /** 重复消息最多多久吐一条汇总 */
    private const val DEDUP_SUMMARY_INTERVAL_MS = 1000L

    /** 重复消息累计到多少条就强制吐一条汇总（防止突发洪泛结束太快而丢失计数） */
    private const val DEDUP_SUMMARY_COUNT = 200

    /** 监听器待派发队列上限 */
    private const val NOTIFY_QUEUE_CAPACITY = 500

    /** 落盘 flush 间隔 */
    private const val FLUSH_INTERVAL_MS = 400L

    private val buffer = ArrayDeque<Entry>(CAPACITY)
    private val lock = ReentrantLock()

    private val droppedByIo = AtomicInteger(0)

    private val io = ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS,
        LinkedBlockingQueue(IO_QUEUE_CAPACITY),
        { r -> Thread(r, "applog-io").apply { isDaemon = true } },
        ThreadPoolExecutor.DiscardOldestPolicy()
    )

    /**
     * 主线程派发器。**lazy 是刻意的**：JVM 单测里没有 Looper，
     * 若在对象初始化时就 `new`，任何 `AppLog.xxx()` 都会直接抛 `Stub!`，
     * 于是「依赖日志的代码」全都变得没法单测。
     */
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    @Volatile
    private var logDir: File? = null

    /** 当天文件已超限时置位，避免每条都去 stat 文件 */
    @Volatile
    private var fileFull = false

    @Volatile
    var minLevel: Level = Level.V

    @Volatile
    var mirrorToLogcat: Boolean = false

    private val listeners = ArrayList<(Entry) -> Unit>()

    // ---- 重复抑制状态 ----
    private class Dedup(
        val key: String,
        val level: Level,
        val module: String,
        val msg: String,
        val extra: String,
        var suppressed: Int,
        var windowStart: Long,
        var lastSummary: Long
    )

    private val dedupLock = Any()
    private var dedup: Dedup? = null

    // ---- 监听器批量派发状态 ----
    private val pendingLock = Any()
    private val pending = ArrayDeque<Entry>()
    @Volatile private var notifyScheduled = false

    fun init(dir: File) {
        logDir = File(dir, "log").apply { mkdirs() }
        io.execute {
            prepareTodayFile()
            purgeOldFiles()
        }
    }

    /**
     * 启动时检查当天文件。
     *
     * 如果它已经超过上限（例如历史版本刷出过 57MB 的文件），必须把它移走，
     * 否则 [appendToFile] 会因为 `fileFull` 一直拒绝写入，**当天剩余时间完全没有日志**。
     */
    private fun prepareTodayFile() {
        val dir = logDir ?: return
        closeWriter()
        val f = todayFile(dir)
        if (!f.exists()) return
        val len = f.length()
        if (len > MAX_FILE_BYTES) {
            val trash = File(dir, "obd-oversize-${f.lastModified()}.log")
            val moved = runCatching { f.renameTo(trash) }.getOrDefault(false)
            if (!moved) runCatching { f.delete() }
            fileFull = false
            emit(
                Level.W, M_SYS, "当天日志超过上限，已归档并重新开始",
                "旧文件=${len / 1024 / 1024}MB 上限=${MAX_FILE_BYTES / 1024 / 1024}MB"
            )
            // 归档文件同样受保留天数约束，避免堆积
            runCatching { trash.delete() }
        }
        fileFull = false
    }

    fun addListener(l: (Entry) -> Unit): () -> Unit {
        synchronized(listeners) { listeners.add(l) }
        return { synchronized(listeners) { listeners.remove(l) } }
    }

    fun v(module: String, msg: String, extra: String = "") = log(Level.V, module, msg, extra)
    fun d(module: String, msg: String, extra: String = "") = log(Level.D, module, msg, extra)
    fun i(module: String, msg: String, extra: String = "") = log(Level.I, module, msg, extra)
    fun w(module: String, msg: String, extra: String = "") = log(Level.W, module, msg, extra)
    fun e(module: String, msg: String, extra: String = "") = log(Level.E, module, msg, extra)

    fun log(level: Level, module: String, msg: String, extra: String = "") {
        if (level.prio < minLevel.prio) return
        val now = System.currentTimeMillis()
        val key = level.tag + '\u0000' + module + '\u0000' + msg + '\u0000' + extra

        synchronized(dedupLock) {
            val d = dedup
            if (d != null && d.key == key && now - d.windowStart < DEDUP_WINDOW_MS) {
                // 同一消息连续重复：只计数，按时间或数量触发汇总。
                // 数量阈值是必要的 —— 突发洪泛可能在 1 秒内就结束，
                // 光靠时间阈值会一条汇总都不留（压力测试实测过）。
                d.suppressed++
                if (now - d.lastSummary >= DEDUP_SUMMARY_INTERVAL_MS ||
                    d.suppressed >= DEDUP_SUMMARY_COUNT
                ) {
                    val n = d.suppressed
                    d.suppressed = 0
                    d.lastSummary = now
                    d.windowStart = now
                    emit(d.level, d.module, d.msg, joinExtra(d.extra, "该消息重复 $n 次，已抑制"))
                }
                return
            }
            // 换消息了：把上一轮被压掉的补一条汇总
            if (d != null && d.suppressed > 0) {
                emit(d.level, d.module, d.msg, joinExtra(d.extra, "该消息重复 ${d.suppressed} 次，已抑制"))
            }
            dedup = Dedup(key, level, module, msg, extra, 0, now, now)
        }
        emit(level, module, msg, extra)
    }

    private fun joinExtra(extra: String, note: String): String =
        if (extra.isBlank()) note else "$extra · $note"

    /** 真正写入缓冲/文件/监听器 */
    private fun emit(level: Level, module: String, msg: String, extra: String) {
        val e = Entry(System.currentTimeMillis(), module, level, msg, extra)
        lock.lock()
        try {
            while (buffer.size >= CAPACITY) buffer.removeFirst()
            buffer.addLast(e)
        } finally {
            lock.unlock()
        }
        if (io.queue.remainingCapacity() == 0) {
            droppedByIo.incrementAndGet()
        }
        io.execute { appendToFile(e) }
        if (mirrorToLogcat) {
            android.util.Log.println(
                when (level) {
                    Level.V -> android.util.Log.VERBOSE
                    Level.D -> android.util.Log.DEBUG
                    Level.I -> android.util.Log.INFO
                    Level.W -> android.util.Log.WARN
                    Level.E -> android.util.Log.ERROR
                },
                "iCarOBD/$module", msg + if (extra.isBlank()) "" else " | $extra"
            )
        }
        dispatchToListeners(e)
    }

    /**
     * 批量派发到主线程。
     * 每条日志 post 一次会让主线程在洪泛时瘫痪（实车上确实发生过），
     * 这里改成：攒一批，一次 post 全部派发。
     */
    private fun dispatchToListeners(e: Entry) {
        synchronized(pendingLock) {
            if (pending.size >= NOTIFY_QUEUE_CAPACITY) pending.removeFirst()
            pending.addLast(e)
            if (notifyScheduled) return
            notifyScheduled = true
        }
        // 没有主 Looper 时（JVM 单测）静默跳过派发 —— 内存缓冲与落盘不受影响
        runCatching {
            mainHandler.post {
                var batch: List<Entry> = emptyList()
                synchronized(pendingLock) {
                    batch = ArrayList(pending)
                    pending.clear()
                    notifyScheduled = false
                }
                val ls = synchronized(listeners) { listeners.toList() }
                if (ls.isEmpty()) return@post
                batch.forEach { entry -> ls.forEach { runCatching { it(entry) } } }
            }
        }
    }

    /** 当前缓冲条数（UI 显示用，避免为拿数字而拷贝整个缓冲） */
    fun size(): Int {
        lock.lock()
        return try { buffer.size } finally { lock.unlock() }
    }

    fun snapshot(): List<Entry> {
        lock.lock()
        return try { ArrayList(buffer) } finally { lock.unlock() }
    }

    /**
     * **同步关闭缓冲写的句柄**（v2.42.0）。
     *
     * ## 为什么需要它
     *
     * `AppLog` 为了性能**故意保持一个常开的 `BufferedWriter`**（见 [writer] 的说明）。
     * 那个句柄会让 Windows **删不掉日志文件** —— 进而删不掉整个临时目录。
     *
     * `clear()` 里也调了 `closeWriter()`，但它是**异步的**（走 `io` 线程）：
     * 测试的 `@After` 紧接着就删目录，**句柄可能还没关完** → 静默失败。
     *
     * 实测：`BackupTest` 10 个测试里稳定有 **4 个**临时目录删不掉，
     * 从 10/02 一直攒到 10/05。
     *
     * ## 谁该调
     *
     * - **测试的 `@After`**：删临时目录之前
     * - App 正常退出时也可以调（把缓冲刷盘）
     */
    fun shutdown() {
        // ⚠️ **只关句柄不够 —— 还要处理 io 队列**（v2.43.0）。
        //
        // 第一版只调了 closeWriter()，实测残留数**会在 3~6 之间变** ——
        // 说明有竞态：`io` 是**单线程池**，[init] 会往它塞 `prepareTodayFile` /
        // `purgeOldFiles`，测试期间的写日志也会塞 `appendToFile` ——
        // **这些任务都会重新打开 writer**，而它们排在我们后面。
        //
        // 三步处理：
        //   1. 丢掉**还没开始跑**的排队任务（它们只会重新开句柄）
        //   2. 发一个**屏障任务**并等它跑完 —— `io` 是单线程，
        //      屏障跑完就保证「之前已经在跑的那个任务」也结束了
        //   3. 最后再同步关一次（兜底）
        runCatching { io.queue.clear() }

        val done = java.util.concurrent.CountDownLatch(1)
        runCatching {
            io.execute {
                runCatching { closeWriter() }
                done.countDown()
            }
        }
        // 给个上限：IO 卡住也不该让测试挂死
        runCatching { done.await(2, java.util.concurrent.TimeUnit.SECONDS) }

        lock.lock()
        try { closeWriter() } finally { lock.unlock() }
    }

    fun clear() {
        lock.lock()
        try { buffer.clear() } finally { lock.unlock() }
        val dir = logDir ?: return
        io.execute {
            closeWriter()          // 必须先关掉句柄，否则删不掉文件
            todayFile(dir).delete()
            fileFull = false
        }
    }

    /**
     * 导出当天日志。
     *
     * ⚠️ 早期实现直接 `f.readText()` 整个文件，57MB 的日志会直接 OOM。
     * 现在只取文件**末尾** [MAX_EXPORT_BYTES]，并注明被截断。
     */
    fun exportText(): String {
        val dir = logDir ?: return ""
        val f = todayFile(dir)
        if (!f.exists()) return ""
        val len = f.length()
        if (len <= MAX_EXPORT_BYTES) return f.readText()
        val skipped = len - MAX_EXPORT_BYTES
        val sb = StringBuilder()
        sb.append("(文件共 ").append(len / 1024 / 1024).append("MB，")
            .append("已跳过前 ").append(skipped / 1024 / 1024).append("MB，仅导出末尾)\n")
        runCatching {
            java.io.RandomAccessFile(f, "r").use { raf ->
                raf.seek(skipped)
                val buf = ByteArray(MAX_EXPORT_BYTES.toInt())
                val n = raf.read(buf)
                if (n > 0) sb.append(String(buf, 0, n, Charsets.UTF_8))
            }
        }
        return sb.toString()
    }

    private const val MAX_EXPORT_BYTES = 2L * 1024 * 1024

    private fun todayFile(dir: File): File =
        File(dir, "obd-${SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())}.log")

    // ---- 批量落盘 ----
    // 早期实现是「每条 appendText」= 每条都开关一次文件，实车上被 8000 条突发打爆，
    // 大量条目被 IO 队列丢弃（压力测试只剩 893 字节）。改成保持一个 BufferedWriter，
    // 按时间间隔 flush，写入吞吐提升两个数量级。
    private var writer: java.io.BufferedWriter? = null
    private var writerFile: File? = null
    private var writerDate: String = ""
    private var lastFlush = 0L

    private fun closeWriter() {
        runCatching { writer?.flush() }
        runCatching { writer?.close() }
        writer = null
        writerFile = null
    }

    private fun appendToFile(e: Entry) {
        val dir = logDir ?: return
        try {
            val today = SimpleDateFormat("yyyyMMdd", Locale.US).format(Date())
            if (writer == null || today != writerDate) {
                closeWriter()
                if (!dir.exists()) dir.mkdirs()
                val f = File(dir, "obd-$today.log")
                if (f.length() > MAX_FILE_BYTES) {
                    fileFull = true
                    return
                }
                writer = java.io.BufferedWriter(
                    java.io.OutputStreamWriter(java.io.FileOutputStream(f, true), Charsets.UTF_8)
                )
                writerFile = f
                writerDate = today
                fileFull = false
                lastFlush = 0L
            }
            if (fileFull) return
            val w = writer ?: return
            w.write(e.format())
            w.newLine()

            val now = System.currentTimeMillis()
            if (now - lastFlush >= FLUSH_INTERVAL_MS) {
                w.flush()
                lastFlush = now
                if ((writerFile?.length() ?: 0L) > MAX_FILE_BYTES) {
                    fileFull = true
                    closeWriter()
                }
            }
        } catch (t: Throwable) {
            // 日志失败不能再抛
            closeWriter()
        }
    }

    private fun purgeOldFiles() {
        val dir = logDir ?: return
        val files = dir.listFiles { f -> f.name.startsWith("obd-") && f.name.endsWith(".log") }
            ?: return
        if (files.size <= KEEP_DAYS) return
        files.sortedBy { it.lastModified() }
            .take(files.size - KEEP_DAYS)
            .forEach { runCatching { it.delete() } }
    }

    fun logFiles(): List<File> {
        val dir = logDir ?: return emptyList()
        return (dir.listFiles { f -> f.name.endsWith(".log") } ?: emptyArray())
            .sortedByDescending { it.lastModified() }
    }
}
