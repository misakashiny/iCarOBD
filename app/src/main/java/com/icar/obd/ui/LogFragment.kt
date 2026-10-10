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

        // ---- 跟随开关（v1.20.18）----
        //
        // 原来只有「暂停滚动」：用户滚上去看历史时，**每 250ms 被 [uiTick] 拽回底部**
        // （`rv.scrollToPosition(最后一行)`），根本看不了历史。
        // 现在滚离底部超过 [AUTO_PAUSE_ROWS] 行就自动暂停跟随，按钮文案跟着变。
        //
        // ⚠️ 监听器里**只读、不做任何事**：不滚动、不 notify、不 requestLayout。
        // 它和 250ms 的 [uiTick] 抢同一个 RecyclerView —— 一旦在这里动手就会互相打架
        // （v1.18.4 那个 ANR 就是"隐藏时还在往 RecyclerView 上堆 op"引起的）。
        rv.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                if (dy == 0 || paused) return          // 没有纵向位移 / 已经暂停 → 不做判断
                if (rowsBelowBottom() > AUTO_PAUSE_ROWS) setPaused(true)
            }
        })

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

        // 一个按钮，两种语义（v1.20.18）：
        //   跟随中 →「暂停滚动」= 停住不动，方便逐行看
        //   已暂停 →「回到底部」= 关掉 paused **并立刻**滚到最后一行
        // 为什么不另加一个「继续滚动」+ 一个「回到底部」：`paused = false` 之后
        // 下一拍 [uiTick]（≤250ms）本来就会 `scrollToPosition(最后一行)` ——
        // 两个按钮会是**同一个动作**，多一个只会让人犹豫按哪个。
        btnPause.setOnClickListener {
            if (paused) {
                setPaused(false)
                // 立刻回底，不等下一拍（点了就该有反馈）
                if (adapter.itemCount > 0) rv.scrollToPosition(adapter.itemCount - 1)
            } else {
                setPaused(true)
            }
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

        // 让按钮文案与 [paused] 对齐（视图被重建时 XML 里的默认文案可能已经过期）
        btnPause.text = if (paused) BTN_BACK_TO_BOTTOM else BTN_PAUSE

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

    /**
     * 跟随开关的**唯一状态就是 [paused]**（v1.20.18：不新增字段）。
     * 这里只负责「状态变了之后，把按钮文案和统计行跟上」。
     */
    private fun setPaused(v: Boolean) {
        if (paused == v) return
        paused = v
        btnPause.text = if (paused) BTN_BACK_TO_BOTTOM else BTN_PAUSE
        updateStats()
    }

    /**
     * 末尾那一行**下面还压着几行** —— 也就是「离底部有多远」，单位是**行**。
     * `0` = 最后一行可见（贴底）。
     *
     * ⚠️ 为什么不用 `computeVerticalScrollRange - Extent - Offset` 换算像素距离：
     * `LinearLayoutManager` 对**长列表**的 range 是**按已布局行的平均高度外推**出来的
     * 估计值，而日志行的行高并不相等（正文会折行）—— 3000 行时偏差足够大，
     * **贴着底也会被算成「还差几行」→ 一打开日志页就自动暂停，跟随功能直接失效**。
     * `findLastVisibleItemPosition()` 给的是精确行号，而且同样是**只读**
     * （不触发布局、不重排、不分配）。
     */
    private fun rowsBelowBottom(): Int {
        val lm = rv.layoutManager as? LinearLayoutManager ?: return 0
        val total = adapter.itemCount
        if (total == 0) return 0
        val last = lm.findLastVisibleItemPosition()
        if (last == RecyclerView.NO_POSITION) return 0
        return total - 1 - last
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

        /**
         * 滚离底部**超过这么多行** → 自动暂停跟随（v1.20.18）。
         *
         * 2 行是「明显是在往回看，而不是手指抖了一下」的最小值：
         * 1 行的话，轻微滑一下就暂停，跟随会显得很神经质。
         */
        const val AUTO_PAUSE_ROWS = 2

        /** 跟随中按钮的文案：点它 = 停住不动 */
        const val BTN_PAUSE = "暂停滚动"

        /** 已暂停时按钮的文案：点它 = 关掉 paused + 滚到最后一行 */
        const val BTN_BACK_TO_BOTTOM = "回到底部"
    }
}
