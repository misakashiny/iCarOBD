package com.icar.obd.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 探测记录（v1.19.22）：把「PID 探测」与「CAN 探测」的结果**留档**。
 *
 * ## 为什么需要它
 *
 * 两种探测的结果本来都只进 [AppLog] —— 而那是**当天全模块的流水**，
 * 一次上车能刷几千行。想事后回看"上次扫出来哪几条"，
 * 得在几万行里捞，而且**第二天日志就换文件了**。
 *
 * 这里存的是**结论**：一次探测一条记录（时间 / 类型 / 标题 / 明细），
 * 最多留 [MAX_ENTRIES] 条，超出丢最旧的。
 *
 * ## 为什么用 JSON 数组而不是 JSONL
 *
 * 记录条数少（上限 200），整份读写的开销可以忽略；
 * 而 JSON 数组能直接复用项目里既有的 `JSONArray` 读写套路，少一套解析。
 * **追加时读-改-写整份**，所以 [add] 不能在极高频路径上调 ——
 * 它只该在一次探测**结束时**调一次。
 */
object ProbeLog {

    /** 保留条数上限。够翻一段时间，又不至于让文件无限长 */
    const val MAX_ENTRIES = 200

    const val KIND_PID = "pid"
    const val KIND_CAN = "can"

    /** 一条探测记录 */
    data class Entry(
        val time: Long,
        /** [KIND_PID] 或 [KIND_CAN] */
        val kind: String,
        /** 一行摘要（列表里显示的） */
        val title: String,
        /** 明细（点开看；通常是探测报告全文） */
        val detail: String
    ) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("time", time); put("kind", kind); put("title", title); put("detail", detail)
        }

        companion object {
            fun fromJson(o: JSONObject) = Entry(
                o.optLong("time"), o.optString("kind"), o.optString("title"), o.optString("detail")
            )
        }
    }

    private var ctx: Context? = null
    private val entries = ArrayList<Entry>()

    fun init(context: Context) {
        ctx = context.applicationContext
        load()
    }

    private fun file(): File? = ctx?.let { File(File(it.filesDir, "config").apply { mkdirs() }, "probe-log.json") }

    private fun load() {
        entries.clear()
        val f = file() ?: return
        if (!f.exists()) return
        runCatching {
            val arr = JSONArray(f.readText())
            for (i in 0 until arr.length()) entries.add(Entry.fromJson(arr.getJSONObject(i)))
        }.onFailure { AppLog.w(AppLog.M_SYS, "探测记录读取失败", it.message ?: "") }
    }

    private fun save() {
        val f = file() ?: return
        runCatching {
            f.writeText(JSONArray().apply { entries.forEach { put(it.toJson()) } }.toString())
        }.onFailure { AppLog.w(AppLog.M_SYS, "探测记录写入失败", it.message ?: "") }
    }

    /**
     * 追加一条（**最新的在最前**，方便列表直接从上往下读）。
     *
     * 只该在一次探测**结束时**调 —— 内部是读-改-写整份文件。
     */
    fun add(kind: String, title: String, detail: String) {
        entries.add(0, Entry(System.currentTimeMillis(), kind, title, detail))
        while (entries.size > MAX_ENTRIES) entries.removeAt(entries.size - 1)
        save()
        AppLog.i(AppLog.M_SYS, "已记入探测记录", "kind=$kind title=$title 共${entries.size}条")
    }

    fun all(): List<Entry> = entries.toList()

    fun clear() {
        entries.clear()
        save()
        AppLog.i(AppLog.M_SYS, "探测记录已清空")
    }

    fun count(): Int = entries.size
}
