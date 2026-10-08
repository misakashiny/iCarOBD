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
    private lateinit var btnToggle: MaterialButton
    private lateinit var container: ViewGroup
    private lateinit var spDuration: Spinner
    private lateinit var etFilter: EditText
    private lateinit var btnMonitor: MaterialButton
    private lateinit var btnDiff: MaterialButton
    private lateinit var diffContainer: android.view.ViewGroup

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
                val filter = etFilter.text.toString().trim().ifBlank { "（不过滤）" }
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
        refreshDecodeIndex()
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
