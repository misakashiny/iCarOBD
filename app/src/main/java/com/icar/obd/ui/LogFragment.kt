package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.LogViewText
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.adapter.LogAdapter
import java.io.File

/**
 * 日志页。
 *
 * 这是「后续迭代」最依赖的页面：
 *  - 按模块过滤（BLE / OBD / SCAN / RULE / AUDIO）能快速定位是蓝牙、协议还是规则的问题
 *  - 按级别过滤（V/D/I/W/E）
 *  - 导出成文件后可以直接交给下一个智能体分析
 *
 * 日志同时异步落盘（files/log/obd-YYYYMMDD.log，保留 7 天），
 * 所以进程被杀也不丢。
 */
class LogFragment : Fragment() {

    private lateinit var adapter: LogAdapter
    private lateinit var rv: RecyclerView
    private lateinit var tvStats: TextView
    private lateinit var tvEmpty: TextView
    private lateinit var btnPause: MaterialButton

    /** 当前**级别过滤的字母**（`V`/`D`/`I`/`W`/`E`）—— 统计行与空态都要用它说话 */
    private var levelTag: String = "V"

    /** 当前模块过滤（[LogAdapter.ALL] = 不筛） */
    private var moduleFilter: String = LogAdapter.ALL

    private var paused = false
    private var unsubscribe: (() -> Unit)? = null

    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var uiScheduled = false
    private val uiTick = object : Runnable {
        override fun run() {
            uiScheduled = false
            if (!paused && adapter.itemCount > 0) rv.scrollToPosition(adapter.itemCount - 1)
            updateStats()
        }
    }

    private val levels = listOf("全部", "V", "D", "I", "W", "E")
    private val modules = listOf(
        LogAdapter.ALL, AppLog.M_SYS, AppLog.M_BLE, AppLog.M_OBD,
        AppLog.M_SCAN, AppLog.M_RULE, AppLog.M_AUDIO, AppLog.M_DATA, AppLog.M_UI
    )

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_log, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        adapter = LogAdapter()
        rv = view.findViewById(R.id.rvLogs)
        tvStats = view.findViewById(R.id.tvLogStats)
        tvEmpty = view.findViewById(R.id.tvLogEmpty)
        btnPause = view.findViewById(R.id.btnLogPause)

        // 不用 stackFromEnd：条目少时贴底会显得像空白 bug；
        // 改为「新条目到达时滚到最后一行」，条目少时自然顶部对齐。
        rv.layoutManager = LinearLayoutManager(requireContext())
        rv.adapter = adapter

        val spLevel = view.findViewById<Spinner>(R.id.spLevel)
        val spModule = view.findViewById<Spinner>(R.id.spModule)
        spLevel.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, levels)
        spModule.adapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_dropdown_item, modules)

        spLevel.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                levelTag = levels.getOrElse(pos) { "V" }
                adapter.setLevel(if (pos == 0) AppLog.Level.V else AppLog.Level.fromTag(levelTag))
                updateStats()
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        spModule.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                moduleFilter = modules.getOrElse(pos) { LogAdapter.ALL }
                adapter.setModule(moduleFilter)
                updateStats()
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }

        btnPause.setOnClickListener {
            paused = !paused
            btnPause.text = if (paused) "继续滚动" else "暂停滚动"
        }

        view.findViewById<MaterialButton>(R.id.btnLogClear).setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setTitle("清空日志")
                .setMessage("将清空内存缓冲与当天日志文件。已归档的历史文件不受影响。")
                .setPositiveButton("清空") { _, _ ->
                    AppLog.clear()
                    adapter.clear()
                    updateStats()
                }
                .setNegativeButton("取消", null)
                .show()
        }

        view.findViewById<MaterialButton>(R.id.btnLogExport).setOnClickListener { exportLog() }

        // v1.20.3：知识库入口从这一页**撤掉了** —— 用户要求做成导航栏的独立 tab
        // （见 MainActivity.createFragment 的 "knowledge"）。同一个功能不留两个入口。

        adapter.submitAll(AppLog.snapshot())
        if (adapter.itemCount > 0) rv.scrollToPosition(adapter.itemCount - 1)
        updateStats()
    }
    override fun onResume() {
        super.onResume()
        unsubscribe = AppLog.addListener { e ->
            // ⚠️ 隐藏时**绝不能**碰 RecyclerView（v1.18.4 修 —— 实车 ANR 的根因）。
            //
            // 本 App 切页用的是 `hide()`/`show()` 而不是 `replace()`，而 **`hide()`
            // 不会触发 `onPause()`**：这一页被切走之后监听器仍然挂着，而 RecyclerView
            // 的 View 已经是 **GONE**。GONE 的 RecyclerView 不会跑 layout，于是每一次
            // `notifyItemInserted` / `notifyItemRemoved` 都堆进 `AdapterHelper` 的待处理
            // 队列里，**永远不被消费**。
            //
            // 实车实测（2026-10-06，阿特兹怠速）：
            //   11:57:03 打开日志页 → 11:57:07 切走（只看了 3.4 秒）
            //   隐藏 8 分 59 秒 × ~47 条/秒 ≈ **2.5 万个待处理 op**
            //   12:06:07 再切回来 → 第一次 layout 一次性回放全部 op
            //   → 主线程卡死 5 秒 → `am_anr: Input dispatching timed out
            //     (Waited 5001ms for MotionEvent(action=DOWN))` → 系统 SIGKILL
            //
            // 隐藏期间不更新；切回来时由 [onHiddenChanged] 用一次 `submitAll` 补齐。
            if (isHidden) return@addListener
            adapter.add(e)
            // 合并刷新：洪泛时每条都滚一次 + 刷新统计会把主线程打满，
            // 这里改成「最多每 UI_REFRESH_MS 刷新一次」
            requestUiRefresh()
        }
    }

    /**
     * 切页（hide/show）时同步一次。
     *
     * 隐藏期间监听器被上面的 `isHidden` 短路了，adapter 会落后于缓冲；
     * 回来时用**一次** `submitAll`（整表替换，只发一次 `notifyDataSetChanged`）补齐，
     * 而不是把隐藏期间积累的两万多个 op 一次性喂给 RecyclerView。
     */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!::adapter.isInitialized) return
        if (hidden) {
            // 看不见的时候别动 RecyclerView
            main.removeCallbacks(uiTick)
            uiScheduled = false
        } else {
            adapter.submitAll(AppLog.snapshot())
            if (!paused && adapter.itemCount > 0) rv.scrollToPosition(adapter.itemCount - 1)
            updateStats()
        }
    }

    override fun onPause() {
        super.onPause()
        unsubscribe?.invoke()
        unsubscribe = null
        main.removeCallbacks(uiTick)
        uiScheduled = false
    }

    private fun requestUiRefresh() {
        if (uiScheduled) return
        uiScheduled = true
        main.postDelayed(uiTick, UI_REFRESH_MS)
    }

    private fun updateStats() {
        // 用 AppLog.size() 而不是 snapshot().size —— 后者每次都要拷贝整个缓冲，
        // 早期版本在每条日志到达时都调用一次，洪泛时是致命的
        tvStats.text = LogViewText.statsLine(
            shown = adapter.count(),
            buffered = AppLog.size(),
            levelText = LogViewText.levelFilterText(levelTag),
            module = moduleFilter
        ) + if (paused) "  · 已暂停滚动" else ""
        // 空态：**为什么空 + 下一步做什么**（规格 §3）。
        // ⚠️ 只在这里做可见性翻转 —— 这一段挂在每 250ms 的合并刷新路径上，
        // 不是每条日志都跑（性能红线，见 LogViewText 的说明）。
        val empty = adapter.count() == 0
        tvEmpty.visibility = if (empty) View.VISIBLE else View.GONE
        if (empty) {
            tvEmpty.text = LogViewText.emptyHint(AppLog.size(), levelTag, moduleFilter)
        }
    }

    private fun exportLog() {
        runCatching {
            val dir = File(requireContext().getExternalFilesDir(null), "export").apply { mkdirs() }
            val f = File(dir, "log-${System.currentTimeMillis()}.txt")
            f.writeText(AppLog.exportText())
            val uri = androidx.core.content.FileProvider.getUriForFile(
                requireContext(), "${requireContext().packageName}.fileprovider", f
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, "导出日志"))
            f
        }.onSuccess {
            ObdController.toast("已导出 ${it.name}（${it.length() / 1024} KB）")
            AppLog.i(AppLog.M_UI, "日志已导出", it.absolutePath)
        }.onFailure {
            ObdController.toast("导出失败：${it.message}")
        }
    }

    private companion object {
        /** 日志页 UI 合并刷新间隔：洪泛时最多每 250ms 重排一次 */
        const val UI_REFRESH_MS = 250L
    }
}
