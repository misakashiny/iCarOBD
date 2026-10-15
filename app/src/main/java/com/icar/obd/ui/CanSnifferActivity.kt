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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.CanFilterPresets
import com.icar.obd.data.CanSnifferText
import com.icar.obd.data.CanProbeUiState
import com.icar.obd.obd.CanReceiveFilter
import com.icar.obd.obd.CanAdapterGate
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.SignalDecode
import com.icar.obd.data.SignalTableCsv
import com.icar.obd.data.Store
import com.icar.obd.obd.CanDiff
import com.icar.obd.obd.CanFrame
import com.icar.obd.obd.CanSniffer
import com.icar.obd.obd.FrameMonitor
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.SegmentRotation
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
 *
 * ## 解码显示（v1.20.8，S4 —— "看得懂"）
 *
 * 原来每一行只有 `数据: 00 00 04 00 88 00 03 00`。要从这串 hex 走到
 * "这是左转向灯"，用户得自己知道 `0x09A` 的 bit2、还得会读 Intel 位序。
 *
 * 现在：**拿已有的监听型 PID 的 `formula` 直接解帧**（规格 §2-S4 ——
 * 这就是这一步便宜的原因：一行数据模型都不用加），把物理值显示在 hex 下面。
 *
 * 三条刻意守住的规矩（每一条都对应一次"被骗"）：
 *  1. **未绑定 PID 的 ID 只显示原始 hex**，不编值、不猜；
 *  2. **候选（`enabled=false`）标出来**并压暗 —— 它没经过验证，
 *     不能和已确认的信号长得一样（规格 §1 决策 4）；
 *  3. **DLC 不足 / 命中无效原始值 / 公式解不出**时显示 `--` 加原因 ——
 *     判定复用 `PidDefinition.dlcTooShort` / `hitsInvalidRaw`，
 *     与运行时 `FrameMonitor` 是**同一对函数**（自己再写一遍就会"探测页说够、运行时不收"）。
 *
 * 顺带把**观察到的取值集合**也解一遍（聚合器本来就去重存了 ≤8 个）：
 * 只看"最后一帧"会重犯 `CanFrame.Aggregate.values` 那个已知坑 ——
 * 周期信号很容易正好停在暗相位（实车 09A 左转/右转两次的 last 都是 `00`）。
 */
class CanSnifferActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var tvRotate: TextView
    private lateinit var btnToggle: MaterialButton
    private lateinit var container: ViewGroup
    private lateinit var spDuration: Spinner
    private lateinit var cbRotate: android.widget.CheckBox
    private lateinit var etFilter: EditText
    private lateinit var btnMonitor: MaterialButton
    private lateinit var btnDiff: MaterialButton
    private lateinit var diffContainer: android.view.ViewGroup

    /** 过滤器框下面那行说明（v1.20.17）：这条预设能看到什么 + 实际下发的 AT 命令 */
    private lateinit var tvFilterStatus: TextView

    /** 全总线那条小字（v1.20.17）：`ATCF000` 不是"第 0 段" */
    private lateinit var tvFilterNote: TextView

    /**
     * 「监听型 PID 按 CAN ID 索引」—— S4 解码的查表入口。
     *
     * 每轮刷新都重建（而不是 onCreate 缓存一次）：用户完全可能
     * **先去 PID 页建一条、再回这一页探测**，缓存住的话那条新信号要等
     * Activity 重建才生效 —— 而症状正是"我明明建了，这里还是只显示 hex"。
     */
    private var decodeIndex: Map<Int, List<PidDefinition>> = emptyMap()

    private var rangesExpanded = false
    private var detailsExpanded = false
    private var lastDetailPhase: CanSniffer.Phase? = null
    private var updateListener: ((CanSniffer.Status) -> Unit)? = null
    private var monitorListener: ((Boolean) -> Unit)? = null
    private var lastEnvironmentState: String? = null
    private val uiTicker = object : Runnable {
        override fun run() {
            val state = "${ObdController.isConnected()}/${FrameMonitor.running}/${FrameMonitor.active}/${CanAdapterGate.initializing}"
            if (state != lastEnvironmentState) {
                lastEnvironmentState = state
                refreshStatus()
            }
            tvStatus.postDelayed(this, 1000L)
        }
    }

    private val durations = listOf(3, 5, 10, 20, 30, 60)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_can_sniffer)
        detailsExpanded = savedInstanceState?.getBoolean("sniff.details.expanded") ?: false
        lastDetailPhase = savedInstanceState?.getString("sniff.details.phase")?.let {
            runCatching { CanSniffer.Phase.valueOf(it) }.getOrNull()
        }

        tvStatus = findViewById(R.id.tvSniffStatus)
        tvRotate = findViewById(R.id.tvSniffRotate)
        btnToggle = findViewById(R.id.btnSniffToggle)
        container = findViewById(R.id.sniffResults)
        spDuration = findViewById(R.id.spSniffDuration)
        cbRotate = findViewById(R.id.cbSniffRotate)
        etFilter = findViewById(R.id.etSniffFilter)
        btnMonitor = findViewById(R.id.btnMonitorToggle)
        btnDiff = findViewById(R.id.btnSniffDiff)
        diffContainer = findViewById(R.id.sniffDiffs)
        tvFilterStatus = findViewById(R.id.tvSniffFilterStatus)
        tvFilterNote = findViewById(R.id.tvSniffFilterNote)
        // 全总线那条小字是**常量**（不是每次刷新算的）：它只在"可能被误读"时露出来，
        // 内容与 `CanFilterPresets` 里那条说明同一份 —— 两处各写一份迟早会不一致。
        tvFilterNote.text = CanFilterPresets.FULL_BUS_NOTE
        btnDiff.setOnClickListener { showDiff() }
        btnMonitor.setOnClickListener { toggleMonitor() }
        setupFilterPresets()
        setupWorkspace()
        // v1.20.17：手打过滤器时那一行说明要跟着变（"实际下发的 AT 命令"是这一页的判据之一）。
        // 加在 `setupFilterPresets()` 之后 —— 预设的点击回调自己会刷一次，两边不会打架。
        etFilter.addTextChangedListener(object : android.text.TextWatcher {
            override fun afterTextChanged(s: android.text.Editable?) = refreshFilterStatus()
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        refreshFilterStatus()
        // 分段轮换（v1.20.10）：勾上之后「采集」下拉框与「过滤器」输入框都不起作用 ——
        // 时长与过滤都由轮换自己决定。**置灰而不是隐藏**：隐藏会让人以为
        // 那两个控件消失了；置灰能看出"它还在，只是现在不归你管"。
        cbRotate.setOnCheckedChangeListener { _, checked ->
            refreshFilterStatus()
            refreshStatus()
        }
        monitorListener = { runOnUiThread { refreshStatus() } }
        FrameMonitor.onStateChanged = monitorListener

        spDuration.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            durations.map { "$it 秒" }
        )
        spDuration.setSelection(durations.indexOf(10).coerceAtLeast(0))

        btnToggle.setOnClickListener { toggle() }
        findViewById<MaterialButton>(R.id.btnSniffClear).setOnClickListener {
            if (!CanSniffer.reset()) ObdController.toast("请等本次探测收尾后再清空")
            diffContainer.removeAllViews()
            buildRows()
            refreshStatus()
        }
        findViewById<MaterialButton>(R.id.btnSniffExportAgg).setOnClickListener {
            export("can-observe-aggregate.csv", CanSniffer.aggregateCsv())
        }
        findViewById<MaterialButton>(R.id.btnSniffExportRaw).setOnClickListener {
            export("can-observe-raw.csv", CanSniffer.rawCsv())
        }
        // ---- 信号表（v1.20.7，S1）----
        // 入口刻意放在**探测页**：探测完就在这儿，不用再去设置页找。
        findViewById<MaterialButton>(R.id.btnSniffExportTemplate).setOnClickListener {
            export("can-signal-template.csv", SignalTableCsv.template(observedRows()))
        }
        findViewById<MaterialButton>(R.id.btnSniffImportSignal).setOnClickListener {
            // 不用限定 MIME：这份 CSV 可能被 Excel 存成 text/csv、application/vnd.ms-excel，
            // 甚至 application/octet-stream —— 限定类型的结果是"文件选不中"。
            openSignalTable.launch(arrayOf("*/*"))
        }

        // v1.19.22：探测**结束**时留档到「探测记录」。
        // 用"上一帧在跑、这一帧不跑了"来判定结束 —— 比在 toggle() 里记更可靠：
        // 探测也可能因为超时/出错自己停，那些路径同样该留档。
        var lastPhase: CanSniffer.Phase? = null
        updateListener = { st ->
            refreshStatus()
            buildRows()
            // 失败要**弹出来**（v1.20.6，P10-4）：状态行是一行 11sp 的暗色小字，
            // "准备失败，请重跑一次"埋在里头等于没说 —— 用户会继续对着空结果猜
            if (st.phase == CanSniffer.Phase.FAILED && lastPhase != CanSniffer.Phase.FAILED) {
                ObdController.toast(st.message.lineSequence().first())
            }
            lastPhase = st.phase

        }
        CanSniffer.onUpdate = updateListener
        refreshStatus()
        buildRows()
    }

    /** 状态行的**唯一**刷新入口（`FrameMonitor` 与 `CanSniffer` 两条状态都要反映到它） */
    private fun refreshStatus() {
        refreshDecodeIndex()
        // 解码汇总挂在状态行下面：它是**整页**的结论（这一页有多少 ID 能看懂），
        // 放进结果流里会被 `ColumnFlowLayout` 分栏切成半宽，看着像某一条的附注
        tvStatus.text = describe(CanSniffer.status)
        if (!ObdController.isConnected() && CanSniffer.status.phase == CanSniffer.Phase.IDLE) {
            tvStatus.text = "适配器未连接。先到「连接」页完成连接与初始化，再回这里采集。"
        }
        findViewById<TextView>(R.id.tvSniffResultMeta).text = decodeSummary().ifBlank {
            if (CanSniffer.aggregates().isEmpty()) "尚无采集结果" else "共 "+CanSniffer.aggregates().size+"个 ID"
        }
        refreshRotateLine()
        refreshActions()
    }

    /**
     * 轮换进度行（v1.20.10）。
     *
     * 为什么**必须有**：一轮轮换 80~90 秒，期间结果区几乎一片空白
     * （前几秒一个 ID 都没有）。不给进度的话，用户唯一能做的事就是怀疑它卡死了。
     *
     * 三段信息各对应一个疑问：
     *  - `第 3/8 段 0x200~0x2FF` → "它在动吗、动到哪了"
     *  - `还剩 6.4 秒`           → "还要等多久"
     *  - `已收 42 个 ID`         → "到底有没有收到东西"
     */
    private fun refreshRotateLine() {
        val r = CanSniffer.status.rotation
        if (r == null) {
            tvRotate.visibility = android.view.View.GONE
            return
        }
        tvRotate.visibility = android.view.View.VISIBLE
        val seg = SegmentRotation.segmentRange(r.index)
        tvRotate.text = if (CanSniffer.status.phase == CanSniffer.Phase.PREPARING) {
            "正在设置第 ${r.index + 1}/${r.count} 段 $seg · 已收 ${CanSniffer.status.rotatedIdCount} 个 ID"
        } else if (CanSniffer.status.phase in listOf(CanSniffer.Phase.DONE, CanSniffer.Phase.FAILED) && !r.done) {
            "本次已结束 · 完成 ${CanSniffer.status.completedSegments}/${r.count} 段 · 已收 ${CanSniffer.status.rotatedIdCount} 个 ID"
        } else if (r.done) {
            "轮换完成：$seg · 共 ${r.count} 段 · 已收 ${CanSniffer.status.rotatedIdCount} 个 ID"
        } else {
            "轮换中：${r.segmentLabel()} $seg · 本段还剩 ${"%.1f".format(r.remainingMs / 1000f)} 秒" +
                " · 剩余采集约 ${"%.0f".format(r.totalRemainingMs / 1000f)} 秒" +
                " · 已收 ${CanSniffer.status.rotatedIdCount} 个 ID"
        }
    }

    /** 重建「CAN ID → 监听型 PID」索引。见 [decodeIndex] 为什么每轮都重建 */
    private fun refreshDecodeIndex() {
        decodeIndex = SignalDecode.indexByHeader(Store.allPids())
    }

    /** 本页看到的 ID 里，有多少个绑定了监听型 PID（= 能显示物理值的那些） */
    private fun boundIdCount(): Int =
        CanSniffer.aggregates().count { decodeIndex.containsKey(it.canId) }

    /**
     * S4 的结果汇总（挂在状态行下面）。
     *
     * 「一个都没绑定」时**必须说清楚**：否则用户看到的是一屏 hex，
     * 而他刚在 PID 页建过监听型条目 —— 两件事对不上，就会去怀疑公式写错了。
     *
     * 文案本体在 [CanSnifferText.decodeSummary]：这里是普通 `TextView`，
     * Android 不解析 Markdown，所以那串字面双星号得从**文案里**去掉
     * （不能在界面层渲染，那等于另造一个渲染器）。
     */
    private fun decodeSummary(): String =
        CanSnifferText.decodeSummary(CanSniffer.aggregates().size, boundIdCount())

    /**
     * 解码明细（给「探测记录」留档用）。空 = 一个都没绑定。
     *
     * 格式刻意做成"每行一个 ID"：上车后一眼就能对着实物核对
     * （"我拨了左转，这里是不是从 0 变成 1"）。
     */
    override fun onDestroy() {
        super.onDestroy()
        tvStatus.removeCallbacks(uiTicker)
        if (CanSniffer.onUpdate === updateListener) CanSniffer.onUpdate = null
        if (FrameMonitor.onStateChanged === monitorListener) FrameMonitor.onStateChanged = null
        // 退出时不能把适配器留在监听模式 —— 那会让后续所有 AT 命令都收不到响应
        if (!isChangingConfigurations) CanSniffer.stop()
    }

    /**
     * 状态行文案。**只在这里做"取当前状态 + 映射"**，措辞本体在
     * [CanSnifferText.statusLine]（纯函数、有 JVM 回归）——
     * 这一行同样是普通 `TextView`，不带任何 Markdown 渲染。
     *
     * 映射成 [CanSnifferText.Status] 而不是把 `CanSniffer.Status` 传下去：
     * 那个类所在的文件带 `android.os.Handler`，纯函数一碰就跑不了 JVM 单测。
     */
    private fun describe(s: CanSniffer.Status): String = CanSnifferText.statusLine(
        CanSnifferText.Status(
            phase = when (s.phase) {
                CanSniffer.Phase.IDLE -> CanSnifferText.Phase.IDLE
                CanSniffer.Phase.PREPARING -> CanSnifferText.Phase.PREPARING
                CanSniffer.Phase.CAPTURING -> CanSnifferText.Phase.CAPTURING
                CanSniffer.Phase.FINISHING -> CanSnifferText.Phase.FINISHING
                CanSniffer.Phase.DONE -> CanSnifferText.Phase.DONE
                CanSniffer.Phase.FAILED -> CanSnifferText.Phase.FAILED
            },
            message = s.message,
            elapsedMs = s.elapsedMs,
            frameCount = s.frameCount,
            idCount = s.idCount,
            dropped = s.dropped,
            rotating = s.rotation != null,
            monitorRunning = FrameMonitor.running,
            rotateChecked = cbRotate.isChecked
        )
    )

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
        if (CanSniffer.busy || FrameMonitor.active) {
            ObdController.toast("请等当前监听或探测收尾完成")
            return
        }
        val sigs = FrameMonitor.signals()
        if (sigs.isEmpty()) {
            ObdController.toast("没有可用的监听型 PID —— 到「PID」页确认「左/右转向灯」是启用状态")
            return
        }
        if (!ObdController.isConnected()) {
            ObdController.toast("适配器未连接，常驻监听没有开启")
            refreshStatus()
            return
        }
        FrameMonitor.start()
        refreshStatus()
        if (!FrameMonitor.running) return
        ObdController.toast(
            "正在准备常驻监听：${sigs.joinToString("/") { it.name }}\n（轮询已暂停，退出前记得停掉它）"
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
        diffContainer.addView(label("与「上一次探测」相比，有 ${bits.size} 处位状态变化（★ = 优先核对的候选位）："))
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
     * 过滤预设（v1.19.22；**v1.20.17 补成一整组**）。
     *
     * ## 为什么需要
     *
     * 过滤器是"**能不能看清闪烁类信号**"的前提 ——
     * 实测过滤后单 ID 采样率从 0.7 帧/秒 提到 **20 帧/秒**。
     * 但它的写法（`ATCRA228` / `ATCM700+ATCF400`）**没人记得住**，
     * 于是这个关键能力实际上没人用。让人翻文档记语法，不如点一下。
     *
     * ## v1.20.17 改了什么（规格 `docs/下一步-UI改进四项.md` §2）
     *
     * - 预设 **4 → 12 个**：8 个段各一条 + 转向灯 + 全总线 + OBD 应答 + 不过滤；
     * - **名字说人话**：标签是"能看见什么"（`0x400~0x4FF` / `转向灯 0x09A（本车实测）`），
     *   AT 命令退到下面那行说明里（用户要的是"选哪个能看见什么"，不是 AT 语法）；
     * - **⚠️ 不编"哪个灯在哪个段"**：本项目**从没实测过**各灯在哪个段，
     *   常用段只写"常见车身域（未在本车实测）"（见 [CanFilterPresets]）；
     * - **⚠️ `ATCF000` 是全总线、不是"第 0 段"**：单独一行小字写清（[CanFilterPresets.FULL_BUS_NOTE]）；
     * - **选中后状态行显示实际下发的 AT 命令**（[refreshFilterStatus]）。
     *
     * 预设表与"过滤串 → 实际命令"的解析全在 [CanFilterPresets]（纯函数，JVM 单测覆盖）——
     * 写在 Activity 里就一条都测不到。
     */
    private fun setupFilterPresets() {
        val group = findViewById<com.google.android.material.chip.ChipGroup>(R.id.cgFilterPresets)
        val current = etFilter.text.toString().trim()
        CanFilterPresets.ALL.forEach { p ->
            val chip = com.google.android.material.chip.Chip(this).apply {
                text = p.label
                isCheckable = true
                // 当前值正好是某个预设 → 高亮它，让人一眼看到"现在用的是哪个"
                isChecked = current == p.value
                contentDescription = p.label + "：" + p.desc.replace('\n', ' ')
                setOnClickListener {
                    if (CanSniffer.busy || FrameMonitor.active) return@setOnClickListener
                    etFilter.setText(p.value)
                    etFilter.setSelection(p.value.length)
                    // 单选语义：点了新的就取消其他（ChipGroup 的 checkable 默认允许多选）
                    for (i in 0 until group.childCount) {
                        val c = group.getChildAt(i) as? com.google.android.material.chip.Chip
                        if (c !== this) c?.isChecked = false
                    }
                    refreshFilterStatus()
                }
            }
            chip.visibility = if (group.childCount >= 4) android.view.View.GONE else android.view.View.VISIBLE
            group.addView(chip)
        }
    }

    /**
     * 过滤器框下面那行说明的**唯一**刷新入口（v1.20.17）。
     *
     * 两种情形：
     * - **预设选中的** → 显示"这条能看到什么" + **实际下发的 AT 命令**（规格 §2 判据）；
     * - **手打的** → 只显示实际命令（**不编**说明：不知道用户想干什么）。
     *
     * ⚠️ 命令文本由 [CanFilterPresets.resolveCommands] 算出来，而它与
     * `CanSniffer.start()` 里真正下发的那段**同一套规则** —— 两处各写一份的话，
     * 界面会自信地显示一条根本没发出去的命令，比不显示还糟。
     */
    private fun refreshFilterStatus() {
        val text = etFilter.text.toString()
        val checked = CanReceiveFilter.parse(if (cbRotate.isChecked) "" else text)
        etFilter.error = checked.error
        tvFilterStatus.text = if (cbRotate.isChecked) "按8个11位ID范围依次采集；29位ID不在此模式范围内" else CanFilterPresets.describe(text)
        // ⚠️ `ATCF000` 是全总线、不是"第 0 段"（规格 §2 点名要写清）——
        // 在**可能被误读的那两种状态下**把它顶出来：不过滤、或选了全总线预设。
        // 其余状态这一行是 GONE（不占高度，也不留一行空白）。
        val f = text.trim().uppercase()
        val showNote = f.isEmpty() || f == "${SegmentRotation.MASK_CMD}+ATCF000"
        tvFilterNote.visibility = if (showNote) android.view.View.VISIBLE else android.view.View.GONE
        refreshActions()
    }

    private fun toggle() {
        if (CanSniffer.running) {
            CanSniffer.stop()
        } else {
            if (CanSniffer.busy || FrameMonitor.active) return
            if (!ObdController.isConnected()) {
                ObdController.toast("设备未就绪，请先到「连接」页完成初始化")
                return
            }
            val rotate = cbRotate.isChecked
            val sec = durations.getOrElse(spDuration.selectedItemPosition) { 10 }
            CanSniffer.start(
                duration = sec * 1000L,
                filterHex = etFilter.text.toString(),
                rotate = rotate
            )
            if (rotate && CanSniffer.running) {
                ObdController.toast(
                    "分段轮换开始：${SegmentRotation.SEGMENT_COUNT} 段 × " +
                        "${SegmentRotation.SEGMENT_MS / 1000} 秒\n" +
                        "期间轮询已暂停，进度看状态行下面那一行"
                )
            }
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /**
     * 结果区。
     *
     * ## 空态为什么不是一句"暂无数据"（v1.20.17，规格 §3）
     *
     * 原来空的时候只有一行"暂无数据。" —— 而"空"有**四种完全不同的原因**，
     * 用户的下一步动作也完全不同：
     *
     * | 现在是什么状态 | 为什么空 | 下一步 |
     * |---|---|---|
     * | 还没开始 | 没探测过 | 点「开始探测」 |
     * | 正在探测 | 还没收到帧 | 等一会儿 / 检查连接 |
     * | 探测结束 | 过滤器太窄 或 车没在说话 | 换「不过滤」再探一次 |
     * | 常驻监听在跑 | 单次探测要等它停 | 先停掉常驻监听 |
     *
     * 只写"暂无数据"的话，用户只能猜 —— 而猜错的代价是"以为模块坏了"。
     */
    private fun buildRows() {
        container.removeAllViews()
        refreshDecodeIndex()
        val search = findViewById<EditText>(R.id.etSniffSearch).text.toString().trim().uppercase().removePrefix("0X")
        val matched = CanSniffer.aggregates().filter { it.idHex().contains(search) || "%03X".format(it.canId).contains(search) }
        val list = when (findViewById<Spinner>(R.id.spSniffSort).selectedItemPosition) {
            1 -> matched.sortedWith(compareByDescending<CanFrame.Aggregate> { it.changed }.thenBy { it.canId })
            2 -> matched.sortedBy { it.canId }
            else -> matched.sortedByDescending { it.count }
        }
        if (list.isEmpty()) {
            container.addView(
                TextView(this).apply {
                    text = if (search.isNotEmpty()) "没有匹配这个 ID 的结果" else emptyHint()
                    setPadding(0, dp(16), 0, 0)
                    setTextColor(resources.getColor(R.color.text_secondary, theme))
                    textSize = 12f
                    setLineSpacing(dp(3).toFloat(), 1.15f)
                }
            )
            return
        }
        list.forEach { container.addView(row(it)) }
    }

    /** 空态那一行：**为什么空 + 下一步做什么**（规格 §3 的文案原则） */
    private fun emptyHint(): String {
        return when {
            CanSniffer.busy -> "正在等待有效广播帧，收到后会显示在这里。"
            FrameMonitor.active -> "常驻监听占用适配器，结束后才能单次采集。"
            CanSniffer.status.phase == CanSniffer.Phase.FAILED -> "本次未完成，原因见上方状态。处理后可以重新采集。"
            CanSniffer.status.phase == CanSniffer.Phase.DONE -> "本次没有收到有效帧。可扩大过滤范围并检查车辆状态。"
            else -> "这里会显示活跃ID和数据变化。先选范围，再开始采集。"
        }
    }

    /**
     * 一行 = 一个 CAN ID。
     *
     * 三行信息：ID 与帧率 / 原始数据与新鲜度 / **解出来的物理值**（S4）。
     * 解不出来就**什么都不加**（未绑定 PID 的 ID 只有前两行）——
     * 加一句"（无解码）"会把"这个 ID 本来就没绑信号"和"绑了但解不出"混成一件事。
     */
    private fun row(a: CanFrame.Aggregate): LinearLayout {
        val period = if (a.count > 1 && a.lastTs > a.firstTs) {
            val avg = (a.lastTs - a.firstTs).toFloat() / (a.count - 1)
            if (avg > 0f) "  周期≈${"%.0f".format(avg)}ms" else ""
        } else ""

        // 「距上次收到多久」是规格 §2-S4 明确要显示的一项：
        // 广播信号停发时，这一行是唯一能看出"它已经不在说话了"的地方
        val ageMs = (System.currentTimeMillis() - a.lastTs).coerceAtLeast(0)
        val age = if (a.lastTs > 0) " · 最后收到 ${"%.1f".format(ageMs / 1000f)} 秒前" else ""

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(resources.getColor(R.color.bg_surface2, theme)); cornerRadius=dp(12).toFloat()
            }
            addView(
                TextView(this@CanSnifferActivity).apply {
                    text = "${a.idHex()}${if (a.isExtended) " (29位)" else ""}   ×${a.count}$period"
                    textSize = 15f
                    setTypeface(typeface, android.graphics.Typeface.BOLD)
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                    )
                }
            )
            addView(
                TextView(this@CanSnifferActivity).apply {
                    text = "数据: ${a.lastData}   变化 ${a.changed} 次$age"
                    textSize = 13f
                    typeface = android.graphics.Typeface.MONOSPACE
                    gravity = Gravity.START
                    setTextColor(resources.getColor(R.color.text_dim, theme))
                }
            )
            // ---- S4：解出来的物理值 ----
            decodeLines(a).forEach { (line, color) ->
                addView(
                    TextView(this@CanSnifferActivity).apply {
                        text = line
                        textSize = 12f
                        setTextColor(color)
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                        )
                    }
                )
            }
        }
    }

    /**
     * 这个 ID 上**已有的监听型 PID** 解出来的值（v1.20.8，S4）。
     *
     * 返回 `(文本, 颜色)` 列表：
     *  - `→ 左转向灯 1`：已确认、解得出 —— 正常字色；
     *  - `→ 右转向灯 0（候选）`：`enabled=false`，压暗 + 标明候选；
     *  - `→ 油温 --（DLC 不足 需要=4 实际=2）`：**danger 色** —— 这条不可信。
     *
     * 另外把**观察到的取值集合**也解一遍（聚合器去重后 ≤8 个）：
     * 只看最后一帧会重犯 `Aggregate.values` 那个已知坑 ——
     * 周期信号很容易正好停在暗相位（实车 09A 左转/右转两次的 last 都是 `00`，分不出左右）。
     */
    private fun decodeLines(a: CanFrame.Aggregate): List<Pair<String, Int>> {
        val pids = decodeIndex[a.canId] ?: return emptyList()
        if (pids.isEmpty()) return emptyList()
        val out = ArrayList<Pair<String, Int>>(pids.size + 1)
        val last = SignalDecode.parseHexData(a.lastData)
        pids.forEach { p ->
            val d = SignalDecode.decode(last, p)
            out.add("  → " + d.text() to decodeColor(d))
            if (a.values.size >= 2) {
                // 去重后的"这条信号一共出现过哪几种值"（最多列 4 种，免得一屏放不下）
                val seen = LinkedHashSet<String>()
                a.values.forEach { v ->
                    if (seen.size < 4) seen.add(SignalDecode.decode(SignalDecode.parseHexData(v), p).text())
                }
                if (seen.size >= 2) {
                    out.add(
                        "     取值集合: " + seen.joinToString(" / ") to
                            resources.getColor(R.color.text_dim, theme)
                    )
                }
            }
        }
        return out
    }

    /** 可信度 → 颜色。**不可信用 danger 色**：这不是"样式"，是"别拿它当真值" */
    private fun decodeColor(d: SignalDecode.Decoded): Int = when {
        !d.ok -> resources.getColor(R.color.danger, theme)
        d.candidate -> resources.getColor(R.color.text_dim, theme)
        else -> resources.getColor(R.color.text_primary, theme)
    }

    private fun export(name: String, content: String) {
        if (content.isBlank() || CanSniffer.aggregates().isEmpty()) {
            ObdController.toast("还没有数据可导出")
            return
        }
        runCatching {
            val dir = File(getExternalFilesDir(null), "export").apply { mkdirs() }
            val f = File(dir, name)
            // `writeText` 默认 UTF-8；BOM 已经由内容自带（见 SignalTableCsv.BOM）
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

    // ================================================================ 信号表（S1）

    /** 把探测到的每个 ID 折成模板的一行：ID / DLC / 观察到的取值集合 */
    private fun observedRows(): List<SignalTableCsv.Observed> =
        CanSniffer.aggregates().map {
            SignalTableCsv.Observed(canId = it.canId, dlc = it.dlc(), values = it.values.toList())
        }

    /**
     * 选一个信号表 CSV（SAF，不需要存储权限 —— 与「导入设计文件」同一套）。
     *
     * ⚠️ 校验结果**必须显示出来**：静默拒绝会让人以为"导进去了但没生效"，
     * 然后去怀疑车/信号 —— 而真正的原因是那一行的 `字节序` 填错了。
     */
    private val openSignalTable = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val fileName = SafFile.displayName(this, uri, "信号表.csv")
        val text = runCatching {
            contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
        }.getOrNull()
        if (text.isNullOrBlank()) {
            ObdController.toast("读取文件失败（文件为空或没有读取权限）")
            return@registerForActivityResult
        }
        val res = runCatching { SignalTableCsv.parse(text) }.getOrElse {
            ObdController.toast("解析失败：${it.message}")
            return@registerForActivityResult
        }
        // 只有通过的条目才写库；**一次写完**（见 Store.upsertPids 为什么不能循环调）
        if (res.pids.isNotEmpty()) {
            Store.upsertPids(res.pids)
            ObdController.reloadPids()
        }
        AppLog.i(
            AppLog.M_UI, "信号表导入",
            "文件=$fileName 数据行=${res.totalRows} 收下=${res.accepted} " +
                "硬错误=${res.errors.size} 软警告=${res.warnings.size}"
        )
        showImportResult(fileName, res)
    }

    /**
     * 导入结果对话框。
     *
     * ⚠️⚠️ **不要用 `setMessage` + `setItems` 的组合**（规格 §7 陷阱 4，v1.20.1 实测）：
     * 两者同时用时**列表会整个消失**，只剩一行说明。这里只放一段正文。
     *
     * 正文由 [CanSnifferText.importResult] 拼（纯函数、有 JVM 回归）：
     * 对话框正文也是纯文本，原先那几处字面双星号会**原样显示给用户**。
     */
    private fun showImportResult(fileName: String, res: SignalTableCsv.Result) {
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle("信号表导入结果")
            .setMessage(CanSnifferText.importResult(fileName, res))
            .setPositiveButton("好", null)
            .show()
    }
    override fun onStart() {
        super.onStart()
        tvStatus.post(uiTicker)
    }
    override fun onStop() {
        tvStatus.removeCallbacks(uiTicker)
        super.onStop()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("sniff.details.expanded", detailsExpanded)
        outState.putString("sniff.details.phase", lastDetailPhase?.name)
    }
    private fun renderStatusDetails() {
        findViewById<android.view.View>(R.id.sniffStatusDetails).visibility =
            if (detailsExpanded) android.view.View.VISIBLE else android.view.View.GONE
        findViewById<MaterialButton>(R.id.btnSniffDetails).apply {
            text = if (detailsExpanded) "收起" else "详情"
            contentDescription = if (detailsExpanded) "收起采集详情" else "展开采集详情"
        }
    }
    private fun setupWorkspace() {
        val wide = resources.configuration.screenWidthDp >= 900
        val columns = findViewById<LinearLayout>(R.id.sniffColumns)
        columns.orientation = if (wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        findViewById<android.widget.ScrollView>(R.id.sniffSettingsScroll).layoutParams = LinearLayout.LayoutParams(
            if (wide) dp(360) else ViewGroup.LayoutParams.MATCH_PARENT,
            if (wide) ViewGroup.LayoutParams.MATCH_PARENT else dp(280))
        findViewById<android.widget.ScrollView>(R.id.sniffResultsScroll).layoutParams = LinearLayout.LayoutParams(
            if (wide) 0 else ViewGroup.LayoutParams.MATCH_PARENT,
            if (wide) ViewGroup.LayoutParams.MATCH_PARENT else 0, 1f).apply {
            if (wide) marginStart=dp(12) else topMargin=dp(12)
        }
        findViewById<MaterialButton>(R.id.btnSniffBack).setOnClickListener { finish() }
        findViewById<MaterialButton>(R.id.btnSniffDetails).setOnClickListener {
            detailsExpanded = !detailsExpanded
            renderStatusDetails()
        }
        renderStatusDetails()
        findViewById<TextView>(R.id.tvSniffHelp).text = CanSnifferText.HELP
        fun expansion(button: Int, body: Int, closed: String, opened: String) {
            findViewById<MaterialButton>(button).setOnClickListener {
                val view=findViewById<android.view.View>(body)
                val show=view.visibility!=android.view.View.VISIBLE
                view.visibility=if(show)android.view.View.VISIBLE else android.view.View.GONE
                (it as MaterialButton).text=if(show)opened else closed
            }
        }
        expansion(R.id.btnSniffTools,R.id.sniffToolsBody,"文件与常驻监听","收起文件与监听")
        expansion(R.id.btnSniffHelp,R.id.sniffHelpBody,"使用说明","收起说明")
        findViewById<MaterialButton>(R.id.btnSniffRanges).setOnClickListener {
            rangesExpanded=!rangesExpanded
            val group=findViewById<com.google.android.material.chip.ChipGroup>(R.id.cgFilterPresets)
            for(i in 4 until group.childCount)group.getChildAt(i).visibility=if(rangesExpanded)android.view.View.VISIBLE else android.view.View.GONE
            (it as MaterialButton).text=if(rangesExpanded)"收起ID范围" else "更多 ID 范围"
        }
        findViewById<com.icar.obd.ui.view.ColumnFlowLayout>(R.id.sniffFileActions).apply { twoColumnMinWidthDp=280; rowGapDp=8; columnGapDp=8 }
        findViewById<com.icar.obd.ui.view.ColumnFlowLayout>(R.id.sniffResults).apply { twoColumnMinWidthDp=680; rowGapDp=8 }
        val sort=findViewById<Spinner>(R.id.spSniffSort)
        sort.adapter=ArrayAdapter(this,android.R.layout.simple_spinner_dropdown_item,listOf("出现最多","变化最多","按 ID"))
        sort.onItemSelectedListener=object:android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p:android.widget.AdapterView<*>?,v:android.view.View?,pos:Int,id:Long){buildRows()}
            override fun onNothingSelected(p:android.widget.AdapterView<*>?){}
        }
        findViewById<EditText>(R.id.etSniffSearch).addTextChangedListener(object:android.text.TextWatcher {
            override fun afterTextChanged(s:android.text.Editable?){buildRows()}
            override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){}
            override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){}
        })
    }
    private fun refreshActions() {
        val st=CanSniffer.status
        if (st.phase == CanSniffer.Phase.FAILED && lastDetailPhase != CanSniffer.Phase.FAILED) {
            detailsExpanded = true
            renderStatusDetails()
        }
        lastDetailPhase = st.phase
        val phase=CanSnifferText.Phase.valueOf(st.phase.name)
        val connected=ObdController.isConnected()
        val hasFrames=CanSniffer.aggregates().isNotEmpty()
        val filterValid=cbRotate.isChecked || CanReceiveFilter.parse(etFilter.text.toString()).error==null
        val actions=CanProbeUiState.actions(phase,CanSniffer.busy,FrameMonitor.active,FrameMonitor.running,connected,filterValid,hasFrames,CanSniffer.hasBaseline,CanAdapterGate.initializing)
        btnToggle.text=when{actions.canStop->"停止本次采集";CanSniffer.busy->"正在收尾…";else->"开始采集"}
        btnToggle.isEnabled=actions.canStop || actions.canStart
        spDuration.isEnabled=actions.editSettings && !cbRotate.isChecked
        etFilter.isEnabled=actions.editSettings && !cbRotate.isChecked
        cbRotate.isEnabled=actions.editSettings
        val group=findViewById<com.google.android.material.chip.ChipGroup>(R.id.cgFilterPresets)
        for(i in 0 until group.childCount)group.getChildAt(i).isEnabled=actions.editSettings && !cbRotate.isChecked
        findViewById<MaterialButton>(R.id.btnSniffClear).isEnabled=actions.clear
        for(id in listOf(R.id.btnSniffExportAgg,R.id.btnSniffExportRaw,R.id.btnSniffExportTemplate))findViewById<MaterialButton>(id).isEnabled=actions.export
        findViewById<MaterialButton>(R.id.btnSniffImportSignal).isEnabled=actions.editSettings
        btnDiff.isEnabled=actions.compare
        btnMonitor.isEnabled=actions.monitor
        btnMonitor.text=if(FrameMonitor.running)"停止常驻监听" else if(FrameMonitor.active)"监听收尾中…" else "开启常驻监听"
        findViewById<TextView>(R.id.tvSniffMonitor).text=if(FrameMonitor.preparing)"正在准备常驻监听，轮询暂停" else if(FrameMonitor.active)"常驻监听占用适配器，轮询暂停" else "用已配置的广播信号更新仪表；开启时会暂停轮询"
        findViewById<TextView>(R.id.tvSniffConnection).apply {
            text = when (st.phase) {
                CanSniffer.Phase.PREPARING -> "准备监听 · 轮询暂停"
                CanSniffer.Phase.CAPTURING -> st.rotation?.let {
                    "第${it.index + 1}/${it.count}段 · ${st.frameCount}帧 · ${st.rotatedIdCount}个ID"
                } ?: "${st.elapsedMs / 1000}秒 · ${st.frameCount}帧 · ${st.idCount}个ID"
                CanSniffer.Phase.FINISHING -> "退出监听并恢复适配器"
                CanSniffer.Phase.DONE -> "${st.frameCount}帧 · ${st.idCount}个ID"
                CanSniffer.Phase.FAILED -> st.message
                CanSniffer.Phase.IDLE -> when {
                    CanAdapterGate.initializing -> "正在初始化适配器"
                    FrameMonitor.active -> "占用适配器 · 轮询暂停"
                    connected -> "适配器已连接"
                    else -> "适配器未连接，先到「连接」页连接"
                }
            }
            contentDescription = (if (connected) "适配器已连接。" else "适配器未连接。") + tvStatus.text
            setTextColor(resources.getColor(if(connected)R.color.ok else R.color.text_secondary,theme))
        }
        findViewById<TextView>(R.id.tvSniffPhase).apply {
            text=when(st.phase){CanSniffer.Phase.IDLE->if(CanAdapterGate.initializing)"初始化中" else if(FrameMonitor.preparing)"监听准备" else if(FrameMonitor.active)"监听中/收尾" else "待开始";CanSniffer.Phase.PREPARING->"准备中";CanSniffer.Phase.CAPTURING->"采集中";CanSniffer.Phase.FINISHING->"收尾中";CanSniffer.Phase.DONE->"已结束";CanSniffer.Phase.FAILED->"需要处理"}
            setTextColor(resources.getColor(if(st.phase==CanSniffer.Phase.FAILED)R.color.danger else R.color.text_primary,theme))
        }
        val progress=findViewById<com.google.android.material.progressindicator.LinearProgressIndicator>(R.id.sniffProgress)
        progress.visibility=if(CanSniffer.busy)android.view.View.VISIBLE else android.view.View.GONE
        progress.isIndeterminate=st.phase!=CanSniffer.Phase.CAPTURING
        if(!progress.isIndeterminate){
            val r=st.rotation
            val fraction=if(r!=null)(r.index*SegmentRotation.SEGMENT_MS+SegmentRotation.SEGMENT_MS-r.remainingMs).toFloat()/SegmentRotation.ROUND_MS
                else st.elapsedMs.toFloat()/st.durationMs.coerceAtLeast(1)
            progress.setProgressCompat((fraction*100).toInt().coerceIn(0,100),false)
        }
    }

}
