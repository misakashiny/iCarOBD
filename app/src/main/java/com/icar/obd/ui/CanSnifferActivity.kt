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
import com.icar.obd.data.ProbeLog
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

    private val durations = listOf(3, 5, 10, 20, 30, 60)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_can_sniffer)

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
            spDuration.isEnabled = !checked
            etFilter.isEnabled = !checked
            refreshStatus()
        }
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
                val rot = CanSniffer.status.rotation
                val filter = if (rot != null) {
                    // 轮换的"过滤器"不是用户填的那个 —— 它逐段下发掩码+段过滤。
                    // 记下段数与各段范围，否则事后完全看不出这趟是全扫
                    "分段轮换(${rot.count}段×${SegmentRotation.SEGMENT_MS / 1000}秒 " +
                        "${SegmentRotation.segmentRange(0)}…${SegmentRotation.segmentRange(rot.count - 1)})"
                } else {
                    etFilter.text.toString().trim().ifBlank { "（不过滤）" }
                }
                // 明细 = 聚合结果（按 ID 的帧数），这正是事后要看的；
                // 截断到 60 行，免得一次几万个 ID 把记录撑爆
                // ⚠️ v1.19.23：原来截断到 60 行 —— 而一次探测看到几百个 ID 很正常，
                // 用户反馈"记录得太少了"。聚合结果本身就是**蒸馏过的**（每个 ID 一行，
                // 不是每帧一行），整份存下来不会失控；真要每帧明细，CAN 页还有「导出原始」。
                val agg = runCatching { CanSniffer.aggregateCsv() }.getOrDefault("")
                // S4：解码结果也一起留档。
                // 为什么值得占这几行：**这是上车验证"解码到底对不对"的唯一物证** ——
                // 界面上的值刷过去就没了，而探测记录能事后回看（AppLog 第二天就换文件）。
                val dec = decodeReport()
                ProbeLog.add(
                    ProbeLog.KIND_CAN,
                    "过滤器 $filter · ${describe(st)}" + if (dec.isBlank()) "" else " · 解码 ${boundIdCount()} 个 ID",
                    agg + dec
                )
                if (dec.isNotBlank()) AppLog.i(AppLog.M_OBD, "CAN 解码汇总", dec.replace('\n', ' '))
            }
            wasRunning = CanSniffer.running
        }
        refreshStatus()
        buildRows()
    }

    /** 状态行的**唯一**刷新入口（`FrameMonitor` 与 `CanSniffer` 两条状态都要反映到它） */
    private fun refreshStatus() {
        refreshDecodeIndex()
        // 解码汇总挂在状态行下面：它是**整页**的结论（这一页有多少 ID 能看懂），
        // 放进结果流里会被 `ColumnFlowLayout` 分栏切成半宽，看着像某一条的附注
        val sum = decodeSummary()
        tvStatus.text = describe(CanSniffer.status) + if (sum.isBlank()) "" else "\n$sum"
        refreshRotateLine()
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
        tvRotate.text = if (r.done) {
            "轮换完成：$seg · 共 ${r.count} 段 · 已收 ${CanSniffer.status.rotatedIdCount} 个 ID"
        } else {
            "轮换中：${r.segmentLabel()} $seg · 本段还剩 ${"%.1f".format(r.remainingMs / 1000f)} 秒" +
                " · 整轮还剩 ${"%.0f".format(r.totalRemainingMs / 1000f)} 秒" +
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
     */
    private fun decodeSummary(): String {
        val list = CanSniffer.aggregates()
        if (list.isEmpty()) return ""
        val bound = boundIdCount()
        return if (bound == 0) {
            "解码：${list.size} 个 ID 里**没有一个**绑定了监听型 PID —— 只能显示原始 hex（不猜值）。" +
                "要解出物理值，到「PID」页新建一条、数据来源选「监听广播帧」。"
        } else {
            "解码：${list.size} 个 ID 里有 $bound 个绑定了监听型 PID，下面直接显示物理值；" +
                "其余只显示原始 hex。标「候选」的是 enabled=false，**没经过验证**。"
        }
    }

    /**
     * 解码明细（给「探测记录」留档用）。空 = 一个都没绑定。
     *
     * 格式刻意做成"每行一个 ID"：上车后一眼就能对着实物核对
     * （"我拨了左转，这里是不是从 0 变成 1"）。
     */
    private fun decodeReport(): String {
        val list = CanSniffer.aggregates()
        val bound = list.filter { decodeIndex.containsKey(it.canId) }
        if (bound.isEmpty()) return ""
        val sb = StringBuilder("\n\n=== 解码（监听型 PID）===\n")
        bound.forEach { a ->
            val pids = decodeIndex[a.canId] ?: return@forEach
            val last = SignalDecode.parseHexData(a.lastData)
            sb.append(String.format("0x%03X", a.canId)).append(" → ")
                .append(pids.joinToString(" / ") { SignalDecode.decode(last, it).text() })
                .append('\n')
            if (a.values.size >= 2) {
                sb.append("    观察到的取值: ").append(a.values.joinToString(" | ")).append('\n')
            }
        }
        sb.append("（未绑定的 ID 只显示原始 hex —— 不猜值）\n")
        return sb.toString()
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
            } else if (cbRotate.isChecked) {
                // 勾了轮换但还没开始 → 说清它要多久、会发生什么，
                // 别让用户以为"和普通探测一样 10 秒"
                "分段轮换扫描：${SegmentRotation.SEGMENT_COUNT} 段 × " +
                    "${SegmentRotation.SEGMENT_MS / 1000} 秒 = 约 ${CanSniffer.ROTATE_DURATION_MS / 1000} 秒。\n" +
                    "自动逐段下发 ${SegmentRotation.MASK_CMD} + ${SegmentRotation.segmentFilter(0)}…" +
                    "${SegmentRotation.segmentFilter(SegmentRotation.SEGMENT_COUNT - 1)}，" +
                    "汇总成「整车 ID 清单」。\n" +
                    "⚠️ 29 位 ID 不在掩码覆盖范围内，本模式看不到。"
            } else {
                "未开始。探测期间会暂停轮询（转速/水温这些会冻结），并临时打开 ATH1（带 CAN 头）。\n" +
                    "只记录**变化了的**数据，重复帧只计数 —— 防止总线流量把内存和存储撑爆。\n" +
                    "点上面的「开始探测」开始；先点一行预设缩范围，采样率会高得多。"
            }
        CanSniffer.Phase.PREPARING -> s.message
        CanSniffer.Phase.CAPTURING ->
            if (s.rotation != null) {
                // 轮换时**不要**在这里重复段号/剩余时间 —— 那是进度行的活
                "轮换监听中… ${s.elapsedMs / 1000}s · ${s.frameCount} 帧（本段） / ${s.idCount} 个 ID（本段）" +
                    if (s.dropped > 0) " · 原始流已丢弃 ${s.dropped} 条" else ""
            } else {
                "监听中… ${s.elapsedMs / 1000}s · ${s.frameCount} 帧 / ${s.idCount} 个 ID" +
                    if (s.dropped > 0) " · 原始流已丢弃 ${s.dropped} 条" else ""
            }
        CanSniffer.Phase.FINISHING -> s.message
        CanSniffer.Phase.DONE -> s.message +
            "\n按出现次数排序。次数高但「变化次数」低的 ID 通常是周期性心跳。" +
            "要对上实物（如拨一下转向灯），用下面的「对比基准（找位）」：连跑两次再点它。"
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
        tvFilterStatus.text = CanFilterPresets.describe(text)
        // ⚠️ `ATCF000` 是全总线、不是"第 0 段"（规格 §2 点名要写清）——
        // 在**可能被误读的那两种状态下**把它顶出来：不过滤、或选了全总线预设。
        // 其余状态这一行是 GONE（不占高度，也不留一行空白）。
        val f = text.trim().uppercase()
        val showNote = f.isEmpty() || f == "${SegmentRotation.MASK_CMD}+ATCF000"
        tvFilterNote.visibility = if (showNote) android.view.View.VISIBLE else android.view.View.GONE
    }

    private fun toggle() {
        if (CanSniffer.running) {
            CanSniffer.stop()
        } else {
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
        val list = CanSniffer.aggregates()
        if (list.isEmpty()) {
            container.addView(
                TextView(this).apply {
                    text = emptyHint()
                    setPadding(0, dp(16), 0, 0)
                    setTextColor(resources.getColor(R.color.text_dim, theme))
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
        val s = CanSniffer.status
        return when {
            CanSniffer.running -> "探测进行中，还没有收到帧。\n" +
                "车没在总线上说话（或这个过滤器把话都挡掉了）时会一直是这样。" +
                "等本趟跑完，如果仍是空的，换成「不过滤（整条总线）」再探一次。"

            s.phase == CanSniffer.Phase.FAILED ->
                "这一趟探测失败了，所以没有结果。\n" +
                    "原因见上面状态行；确认适配器还连着之后，点「开始探测」重来一次。"

            FrameMonitor.running ->
                "常驻监听正在跑，单次探测要等它停掉之后才能开始。\n" +
                    "点上面的「停止常驻监听」，再点「开始探测」。"

            s.phase == CanSniffer.Phase.DONE ->
                "这一趟一个帧都没收到。\n" +
                    "最可能的原因：过滤器太窄（这个 ID 本车根本没人发）。" +
                    "换成「不过滤（整条总线）」再探一次，能看到全部在说话的 ID。"

            else -> "还没探测过。\n" +
                "点上面的「开始探测」；想先缩范围就点一行预设（每条都写着能看到什么）。"
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
                    text = "数据: ${a.lastData}   变化 ${a.changed} 次$age"
                    textSize = 11f
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
     */
    private fun showImportResult(fileName: String, res: SignalTableCsv.Result) {
        val sb = StringBuilder()
        sb.append("文件：").append(fileName).append('\n')
        sb.append("数据行 ").append(res.totalRows)
            .append(" · 收下 ").append(res.accepted)
            .append(" · 硬错误 ").append(res.errors.size)
            .append(" · 软警告 ").append(res.warnings.size).append('\n')
        if (res.accepted == 0) {
            sb.append("\n**一条都没通过**，PID 列表没有任何变化。\n")
        }
        val section = { title: String, list: List<SignalTableCsv.Problem>, max: Int ->
            if (list.isNotEmpty()) {
                sb.append('\n').append(title).append("（").append(list.size).append("）\n")
                list.take(max).forEach {
                    sb.append("第 ").append(it.row).append(" 行：").append(it.message).append('\n')
                }
                if (list.size > max) sb.append("… 还有 ").append(list.size - max).append(" 条\n")
            }
        }
        section("硬错误 · 这些行被拒绝", res.errors, 12)
        section("软警告 · 已收下，请核对", res.warnings, 8)
        if (res.accepted > 0) {
            sb.append('\n').append("已写入 PID 列表（监听型）。")
            sb.append(
                if (res.pids.any { it.enabled })
                    "「已确认」的条目已启用 —— 到本页开「常驻监听」就能取到值。"
                else
                    "这些条目都是「候选」→ **未启用**，要在「PID」页手动打开。"
            )
        }
        com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setTitle("信号表导入结果")
            .setMessage(sb.toString())
            .setPositiveButton("好", null)
            .show()
    }
}
