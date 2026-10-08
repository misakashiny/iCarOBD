package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.ProbeLog
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.Store
import com.icar.obd.obd.CanDiff
import com.icar.obd.obd.CanFrame
import com.icar.obd.obd.CanSniffer
import com.icar.obd.obd.FrameMonitor
import com.icar.obd.obd.ObdController
import java.io.File

/**
 * CAN 总线被动探测界面。
 *
 * 与 PID 扫描器的区别：扫描器**主动请求**（只能发现 ECU 愿答的 PID），
 * 这里**被动监听**（`ATMA`），能看到广播帧。
 *
 * ⚠️ 2026-10-06 实车更正：转向灯/刹车这类车身信号**并不是"只能这样找"**。
 * 克隆版在满速总线上只漏出约 77 帧/秒（摊到 80 个 ID 上 = 每 ID 1 帧/秒），
 * 闪烁类信号根本还原不出来；而**主动请求 Mode 22 时的采样率由我们自己定**（见 PID 扫描器）。
 * 本页现在的正确用法是配合**CAN 过滤器**（`ATCRA`）缩窄观察范围之后的定点观察。
 */
class CanSnifferActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var btnToggle: MaterialButton
    private lateinit var container: ViewGroup
    private lateinit var spDuration: Spinner
    private lateinit var etFilter: EditText
    private lateinit var btnMonitor: MaterialButton
    private lateinit var btnDiff: MaterialButton
    private lateinit var diffContainer: android.view.ViewGroup

    private val durations = listOf(3, 5, 10, 20, 30, 60)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_can_sniffer)

        tvStatus = findViewById(R.id.tvSniffStatus)
        btnToggle = findViewById(R.id.btnSniffToggle)
        container = findViewById(R.id.sniffResults)
        spDuration = findViewById(R.id.spSniffDuration)
        etFilter = findViewById(R.id.etSniffFilter)
        btnMonitor = findViewById(R.id.btnMonitorToggle)
        btnDiff = findViewById(R.id.btnSniffDiff)
        diffContainer = findViewById(R.id.sniffDiffs)
        btnDiff.setOnClickListener { showDiff() }
        btnMonitor.setOnClickListener { toggleMonitor() }
        setupFilterPresets()
        FrameMonitor.onStateChanged = { on ->
            runOnUiThread {
                btnMonitor.text = if (on) "停止常驻监听" else "开启常驻监听（转向灯）"
                // 状态行也要跟着刷新：常驻监听开着时它显示的是**轮询已暂停**的警示
                // （P10-3），不是"未开始" —— 否则同一屏上两个说法互相打架
                refreshStatus()
            }
        }

        spDuration.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            durations.map { "$it 秒" }
        )
        spDuration.setSelection(durations.indexOf(10).coerceAtLeast(0))

        btnToggle.setOnClickListener { toggle() }
        findViewById<MaterialButton>(R.id.btnSniffClear).setOnClickListener {
            CanSniffer.reset()
            buildRows()
        }
        findViewById<MaterialButton>(R.id.btnSniffExportAgg).setOnClickListener {
            export("can-aggregate.csv", CanSniffer.aggregateCsv())
        }
        findViewById<MaterialButton>(R.id.btnSniffExportRaw).setOnClickListener {
            export("can-raw.csv", CanSniffer.rawCsv())
        }

        // v1.19.22：探测**结束**时留档到「探测记录」。
        // 用"上一帧在跑、这一帧不跑了"来判定结束 —— 比在 toggle() 里记更可靠：
        // 探测也可能因为超时/出错自己停，那些路径同样该留档。
        var wasRunning = false
        var lastPhase: CanSniffer.Phase? = null
        CanSniffer.onUpdate = { st ->
            refreshStatus()
            btnToggle.text = if (CanSniffer.running) "停止探测" else "开始探测"
            buildRows()
            // 失败要**弹出来**（v1.20.6，P10-4）：状态行是一行 11sp 的暗色小字，
            // "准备失败，请重跑一次"埋在里头等于没说 —— 用户会继续对着空结果猜
            if (st.phase == CanSniffer.Phase.FAILED && lastPhase != CanSniffer.Phase.FAILED) {
                ObdController.toast(st.message.lineSequence().first())
            }
            lastPhase = st.phase
            if (wasRunning && !CanSniffer.running) {
                val filter = etFilter.text.toString().trim().ifBlank { "（不过滤）" }
                // 明细 = 聚合结果（按 ID 的帧数），这正是事后要看的；
                // 截断到 60 行，免得一次几万个 ID 把记录撑爆
                // ⚠️ v1.19.23：原来截断到 60 行 —— 而一次探测看到几百个 ID 很正常，
                // 用户反馈"记录得太少了"。聚合结果本身就是**蒸馏过的**（每个 ID 一行，
                // 不是每帧一行），整份存下来不会失控；真要每帧明细，CAN 页还有「导出原始」。
                val agg = runCatching { CanSniffer.aggregateCsv() }.getOrDefault("")
                ProbeLog.add(ProbeLog.KIND_CAN, "过滤器 $filter · ${describe(st)}", agg)
            }
            wasRunning = CanSniffer.running
        }
        refreshStatus()
        buildRows()
    }

    /** 状态行的**唯一**刷新入口（`FrameMonitor` 与 `CanSniffer` 两条状态都要反映到它） */
    private fun refreshStatus() {
        tvStatus.text = describe(CanSniffer.status)
    }

    override fun onDestroy() {
        super.onDestroy()
        CanSniffer.onUpdate = null
        // 退出时不能把适配器留在监听模式 —— 那会让后续所有 AT 命令都收不到响应
        CanSniffer.stop()
    }

    private fun describe(s: CanSniffer.Status): String = when (s.phase) {
        CanSniffer.Phase.IDLE ->
            // 常驻监听开着时，这一页最该说的话是"轮询已经让位了"（P10-3）——
            // 原来的"未开始…"会让人以为监听也没在跑（实际上正在跑，只是没在探测）
            if (FrameMonitor.running) {
                com.icar.obd.ui.view.MonitorWarnBar.TEXT +
                    "\n常驻监听在跑，单次探测要等它停掉之后才能开始。"
            } else {
                "未开始。探测期间会暂停轮询引擎，并临时打开 ATH1（带 CAN 头）。\n" +
                    "只记录**变化了的**数据，重复帧只计数 —— 防止总线流量把内存和存储撑爆。"
            }
        CanSniffer.Phase.PREPARING -> s.message
        CanSniffer.Phase.CAPTURING ->
            "监听中… ${s.elapsedMs / 1000}s · ${s.frameCount} 帧 / ${s.idCount} 个 ID" +
                if (s.dropped > 0) " · 原始流已丢弃 ${s.dropped} 条" else ""
        CanSniffer.Phase.FINISHING -> s.message
        CanSniffer.Phase.DONE -> s.message + "\n按出现次数排序。次数高但「变化次数」低的 ID 通常是周期性心跳。"
        CanSniffer.Phase.FAILED -> s.message
    }
    /**
     * 常驻监听开关。
     *
     * 这是**模式切换**，不是"顺便多收一点"：ELM327 是半双工的，
     * `ATMA` 监听期间没法同时发请求 —— 所以开了它，转速/水温那些标准 PID 会冻结。
     */
    private fun toggleMonitor() {
        if (FrameMonitor.running) {
            FrameMonitor.stop()
            btnMonitor.text = "开启常驻监听（转向灯）"
            refreshStatus()
            return
        }
        if (CanSniffer.running) {
            ObdController.toast("单次探测正在跑，先停掉它")
            return
        }
        val sigs = FrameMonitor.signals()
        if (sigs.isEmpty()) {
            ObdController.toast("没有可用的监听型 PID —— 到「PID」页确认「左/右转向灯」是启用状态")
            return
        }
        FrameMonitor.start()
        btnMonitor.text = "停止常驻监听"
        refreshStatus()
        ObdController.toast(
            "已开启常驻监听：${sigs.joinToString("/") { it.name }}\n（轮询已暂停，退出前记得停掉它）"
        )
    }

    /**
     * 「对比基准」：把**上一次探测**当基准，列出状态发生变化的位。
     *
     * 正确用法是**连跑两次**：关门探一次、开门探一次 —— 第二次之后点这里。
     * 判据见 [CanDiff]：从"恒定"变成"在变"的位，就是这次操作拨动的。
     */
    private fun showDiff() {
        diffContainer.removeAllViews()
        val bits = CanSniffer.diffAgainstBaseline()
        if (bits.isEmpty()) {
            ObdController.toast("没有差异 —— 要先连跑两次探测（如：关门一次 / 开门一次）")
            return
        }
        fun label(t: String) = TextView(this).apply {
            text = t
            setTextColor(resources.getColor(R.color.text_dim, theme))
            textSize = 11f
            setPadding(0, dp(8), 0, dp(2))
        }
        diffContainer.addView(label("与「上一次探测」相比，有 ${bits.size} 处位状态变化（★ = 这次操作引起的）："))
        bits.forEach { b ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(0, dp(2), 0, dp(2))
            }
            row.addView(
                TextView(this).apply {
                    text = (if (b.isPrimary()) "★ " else "  ") + b.describe()
                    textSize = 12f
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                }
            )
            row.addView(
                MaterialButton(this).apply {
                    text = "加为监听"
                    textSize = 11f
                    minWidth = 0
                    setPadding(dp(6), 0, dp(6), 0)
                    setOnClickListener { addMonitorPid(b) }
                }
            )
            diffContainer.addView(row)
        }
    }

    /**
     * 把一处差分直接变成**监听型 PID** —— 于是它立刻能用在下拉框、仪表和规则里。
     *
     * 用固定的 [CanDiff.BitChange.suggestId]，所以对同一处再加一次是**覆盖**
     * 而不是堆积重复条目。
     */
    private fun addMonitorPid(b: CanDiff.BitChange) {
        val p = PidDefinition(
            id = b.suggestId(),
            name = b.suggestName(),
            protocol = "CAN",
            mode = "MON",
            pid = b.canIdHex(),
            source = "monitor",
            header = b.canIdHex(),
            formula = b.formula(),
            unit = "",
            minVal = 0f,
            maxVal = 1f,
            enabled = true,
            builtIn = false,
            group = "监听型(实车确认)",
            note = "由「CAN 探测 · 对比基准」生成：" + b.describe()
        )
        Store.upsertPid(p)
        ObdController.reloadPids()
        ObdController.toast("已加为监听型 PID：${p.name}\n可在「PID」页改名，或直接绑到规则")
    }

    /**
     * 过滤预设（v1.19.22）：点一下把输入框填好。
     *
     * ## 为什么需要
     *
     * 过滤器是"**能不能看清闪烁类信号**"的前提 ——
     * 实测过滤后单 ID 采样率从 0.7 帧/秒 提到 **20 帧/秒**。
     * 但它的写法（`ATCRA228` / `ATCM700+ATCF400`）**没人记得住**，
     * 于是这个关键能力实际上没人用。让人翻文档记语法，不如点一下。
     *
     * 预设选的是**实际会用到的场景**，不是穷举语法。
     */
    private fun setupFilterPresets() {
        val group = findViewById<com.google.android.material.chip.ChipGroup>(R.id.cgFilterPresets)
        val presets = listOf(
            "228" to "左转向灯",
            "ATCM700+ATCF400" to "0x400~0x4FF",
            "ATCM700+ATCF000" to "全部 11 位 ID",
            "7E8" to "OBD 应答",
            "" to "不过滤"
        )
        val current = etFilter.text.toString().trim()
        presets.forEach { (value, label) ->
            val chip = com.google.android.material.chip.Chip(this).apply {
                text = label
                isCheckable = true
                // 当前值正好是某个预设 → 高亮它，让人一眼看到"现在用的是哪个"
                isChecked = current == value
                setOnClickListener {
                    etFilter.setText(value)
                    etFilter.setSelection(value.length)
                    // 单选语义：点了新的就取消其他（ChipGroup 的 checkable 默认允许多选）
                    for (i in 0 until group.childCount) {
                        val c = group.getChildAt(i) as? com.google.android.material.chip.Chip
                        if (c !== this) c?.isChecked = false
                    }
                }
            }
            group.addView(chip)
        }
    }

    private fun toggle() {
        if (CanSniffer.running) {
            CanSniffer.stop()
        } else {
            if (!ObdController.isConnected()) {
                ObdController.toast("设备未就绪，请先到「连接」页完成初始化")
                return
            }
            val sec = durations.getOrElse(spDuration.selectedItemPosition) { 10 }
            CanSniffer.start(sec * 1000L, etFilter.text.toString())
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun buildRows() {
        container.removeAllViews()
        val list = CanSniffer.aggregates()
        if (list.isEmpty()) {
            container.addView(
                TextView(this).apply {
                    text = "暂无数据。"
                    setPadding(0, dp(16), 0, 0)
                    setTextColor(resources.getColor(R.color.text_dim, theme))
                }
            )
            return
        }
        list.forEach { container.addView(row(it)) }
    }

    private fun row(a: CanFrame.Aggregate): LinearLayout {
        val period = if (a.count > 1 && a.lastTs > a.firstTs) {
            val avg = (a.lastTs - a.firstTs).toFloat() / (a.count - 1)
            if (avg > 0f) "  周期≈${"%.0f".format(avg)}ms" else ""
        } else ""

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(6), 0, dp(6))
            addView(
                TextView(this@CanSnifferActivity).apply {
                    text = "${a.idHex()}${if (a.isExtended) " (29位)" else ""}   ×${a.count}$period"
                    textSize = 13f
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                }
            )
            addView(
                TextView(this@CanSnifferActivity).apply {
                    text = "数据: ${a.lastData}   变化 ${a.changed} 次"
                    textSize = 11f
                    gravity = Gravity.START
                    setTextColor(resources.getColor(R.color.text_dim, theme))
                }
            )
        }
    }

    private fun export(name: String, content: String) {
        if (content.isBlank() || CanSniffer.aggregates().isEmpty()) {
            ObdController.toast("还没有数据可导出")
            return
        }
        runCatching {
            val dir = File(getExternalFilesDir(null), "export").apply { mkdirs() }
            val f = File(dir, name)
            f.writeText(content)
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/csv"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, "导出探测数据"))
            f
        }.onSuccess {
            ObdController.toast("已导出：${it.name}")
            AppLog.i(AppLog.M_UI, "CAN 探测数据已导出", "file=${it.name} size=${it.length() / 1024}KB")
        }.onFailure {
            ObdController.toast("导出失败：${it.message}")
        }
    }
}
