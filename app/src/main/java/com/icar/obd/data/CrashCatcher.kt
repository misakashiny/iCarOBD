package com.icar.obd.data

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 全局崩溃捕获。
 *
 * ## 为什么需要它
 *
 * 用户报告"运行几秒后闪退"，但 `adb logcat -b crash` 里**什么都没有** ——
 * 说明要么是 native 崩溃，要么是日志被系统刷掉了。**复现不出来就没法修。**
 *
 * 所以先解决"看不见"的问题：把未捕获异常**同步写到文件**。
 *
 * ## 为什么不走 [AppLog]
 *
 * `AppLog` 通过 Handler 投递到主线程写文件。**崩溃时主线程可能已经死了**，
 * 那条日志就永远写不出去 —— 恰恰是最需要它的时候。
 * 这里直接同步写，不依赖任何线程。
 *
 * ## 为什么不用 `Thread.setDefaultUncaughtExceptionHandler` 吞掉异常
 *
 * 记完必须**交还给系统默认处理器**，否则进程会卡在异常状态不退，
 * 用户看到的是"卡死"而不是"闪退"，更难排查。
 */
object CrashCatcher {

    private const val FILE_NAME = "last-crash.log"

    /** 崩溃文件的绝对路径，装好后由 UI 层展示给用户 */
    var lastCrashPath: String? = null
        private set

    private var installed = false

    /**
     * 在 `Application.onCreate` 里调一次。
     *
     * @param ctx 用 `applicationContext`，别传 Activity（会泄漏）
     */
    fun install(ctx: Context) {
        if (installed) return
        installed = true
        val app = ctx.applicationContext
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            runCatching { writeCrash(app, thread, e) }
            // 交还给系统：否则进程不会正常退出，用户看到的是"卡死"
            prev?.uncaughtException(thread, e)
        }
    }

    /** 上次崩溃的内容（给 UI 用）。没有返回 null */
    fun lastCrash(ctx: Context): String? {
        val f = File(ctx.filesDir, FILE_NAME)
        if (!f.exists()) return null
        return runCatching { f.readText() }.getOrNull()
    }

    fun clear(ctx: Context) {
        runCatching { File(ctx.filesDir, FILE_NAME).delete() }
        lastCrashPath = null
    }

    private fun writeCrash(app: Context, thread: Thread, e: Throwable) {
        val sw = StringWriter()
        e.printStackTrace(PrintWriter(sw))
        val ts = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(Date())

        val sb = StringBuilder()
        sb.append("时间: ").append(ts).append('\n')
        sb.append("线程: ").append(thread.name).append('\n')
        sb.append("异常: ").append(e.javaClass.name).append('\n')
        sb.append("消息: ").append(e.message ?: "(无)").append('\n')
        sb.append("──────── 堆栈 ────────\n")
        sb.append(sw.toString())

        // 直接同步写：崩溃路径上不能依赖 Handler / 主线程
        val f = File(app.filesDir, FILE_NAME)
        f.writeText(sb.toString())
        lastCrashPath = f.absolutePath
    }
}
