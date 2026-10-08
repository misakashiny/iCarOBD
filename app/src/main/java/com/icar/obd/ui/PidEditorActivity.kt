package com.icar.obd.ui

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidDraft
import com.icar.obd.data.Store
import com.icar.obd.obd.FrameMonitor
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.ObdProtocol
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * 自定义 PID 编辑器 —— **本项目的核心**。
 *
 * 它存在的唯一理由：以后拿到阿特兹的厂家 CAN/PID 资料时，
 * 不用改一行代码、不用重新编译 APK，就能让新数据出现在仪表盘上。
 *
 * 标准工作流（务必按这个顺序，能省掉大量试错）：
 *   1. 用 PID 扫描器扫出真实地址（或从资料里查到 Mode/PID）
 *   2. 在这里填入 Mode / PID / 公式
 *   3. 点「发送测试请求」，看 RX 原始响应与解析结果
 *   4. 对不上就改公式，反复测到正确
 *   5. 保存 → 回列表启用 → 到仪表盘编辑里加上它
 *
 * 测试区会同时显示 TX / RX / 数据字节（A=.. B=..）——
 * 这三个信息足够反推出绝大多数厂家的编码方式。
 *
 * ## 两类条目（v1.20.8，S3）
 *
 * 「数据来源」分两种，**表单会跟着变形**：
 *
 * | | `poll`（主动请求） | `monitor`（监听广播帧） |
 * |---|---|---|
 * | 要填 | Mode / PID / 请求帧 | **CAN ID**（`header`） |
 * | 不要填 | —— | Mode / PID / 请求帧 / 轮询间隔 / 优先级 / 多 ECU |
 * | 取到值的条件 | 轮询引擎在跑 | 到「CAN 探测」页开**常驻监听** |
 *
 * 监听型是本轮补上的最大空白：在它出现之前，全 app 只有 2 条内置监听 PID，
 * 用户**造不出第三条**，只能"导出信号表 → Excel 填 → 导回来"。
 *
 * ⚠️ **表单 → 数据模型 的全部解析与校验都在 `data/PidDraft.kt` 里**（纯函数、可单测）。
 * 这个 Activity 只负责"把控件里的字读出来"和"把结论显示出来" ——
 * 校验逻辑写在 Activity 里的话，JVM 单测一条都碰不到，而这里要判的恰恰是
 * "填错了但看起来正常"的那类东西（CAN ID 写错 → 帧永远不命中）。
 */
class PidEditorActivity : AppCompatActivity() {

    private lateinit var etName: EditText
    private lateinit var spProtocol: Spinner
    /** 数据来源（v1.20.8，S3）：`poll` / `monitor`。见 [PidDraft.SOURCE_VALUES] */
    private lateinit var spSource: Spinner
    /** `poll` = 目标模块头（`AT SH`）；`monitor` = CAN ID。标签随来源变，见 [applySourceUi] */
    private lateinit var etHeader: EditText
    private lateinit var tvHeaderLabel: TextView
    private lateinit var tvHeaderHint: TextView
    private lateinit var etMode: EditText
    private lateinit var etPid: EditText
    private lateinit var etRequest: EditText
    private lateinit var etFormula: EditText
    private lateinit var etUnit: EditText
    private lateinit var etMin: EditText
    private lateinit var etMax: EditText
    private lateinit var etWarnLow: EditText
    private lateinit var etWarnHigh: EditText
    private lateinit var etGroup: EditText
    private lateinit var etInterval: EditText
    private lateinit var spPriority: android.widget.Spinner
    private lateinit var etEcuIndex: EditText
    /** 无效原始值（S2 的字段，S3 接到界面上） */
    private lateinit var etInvalidRaw: EditText
    /** 最小帧长（同上） */
    private lateinit var etMinDlc: EditText
    /** 显示超时（同上；只对监听型有意义） */
    private lateinit var etTtl: EditText
    private lateinit var tvSignalHint: TextView
    private lateinit var etNote: EditText
    private lateinit var swEnabled: MaterialSwitch
    private lateinit var tvTx: TextView
    private lateinit var tvRx: TextView

    /** 连续采样进行中 */
    private var sampling = false

    /** 采样总时长与间隔。10 秒 @2Hz ≈ 20 个点，够看取值范围又不至于占着总线太久 */
    private val sampleDurationMs = 10_000L
    private val sampleIntervalMs = 500L
    private lateinit var tvBytes: TextView
    private lateinit var tvResult: TextView
    private lateinit var scrollRoot: android.widget.ScrollView

    /**
     * 结果行的**正常**颜色（从布局里读一次，不写死）。
     *
     * 校验失败时把它染成警示色、成功时染回来 —— 写死颜色的话，
     * 以后改 `MonoBox` 样式就会出现"正常状态也是红的"。
     */
    private var resultColor = 0

    private var editing: PidDefinition? = null
    private var isBuiltIn = false

    private val protocols = listOf("CAN", "ISO9141", "KWP", "J1850", "其他")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pid_editor)

        etName = findViewById(R.id.etName)
        spProtocol = findViewById(R.id.spProtocol)
        spSource = findViewById(R.id.spSource)
        etHeader = findViewById(R.id.etHeader)
        tvHeaderLabel = findViewById(R.id.tvHeaderLabel)
        tvHeaderHint = findViewById(R.id.tvHeaderHint)
        etMode = findViewById(R.id.etMode)
        etPid = findViewById(R.id.etPid)
        etRequest = findViewById(R.id.etRequest)
        etFormula = findViewById(R.id.etFormula)
        etUnit = findViewById(R.id.etUnit)
        etMin = findViewById(R.id.etMin)
        etMax = findViewById(R.id.etMax)
        etWarnLow = findViewById(R.id.etWarnLow)
        etWarnHigh = findViewById(R.id.etWarnHigh)
        etGroup = findViewById(R.id.etGroup)
        etInterval = findViewById(R.id.etInterval)
        spPriority = findViewById(R.id.spPriority)
        etEcuIndex = findViewById(R.id.etEcuIndex)
        etInvalidRaw = findViewById(R.id.etInvalidRaw)
        etMinDlc = findViewById(R.id.etMinDlc)
        etTtl = findViewById(R.id.etTtl)
        tvSignalHint = findViewById(R.id.tvSignalHint)
        // 顺序必须与 PidDefinition.PRIORITY_HIGH / NORMAL / LOW 一致
        spPriority.adapter = android.widget.ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            listOf("高（间隔 ×0.5）", "中（跟随全局）", "低（间隔 ×2）")
        )
        // 新增 PID 的默认值：中。**不能留 0（高）** —— 那会让新加的通道默认双倍频率，
        // 悄悄加大总线负载。bind() 会用 PID 自己的值覆盖它。
        spPriority.setSelection(PidDefinition.PRIORITY_NORMAL)
        etEcuIndex.setText("0")
        etNote = findViewById(R.id.etNote)
        swEnabled = findViewById(R.id.swEnabled)
        tvTx = findViewById(R.id.tvTx)
        tvRx = findViewById(R.id.tvRx)
        tvBytes = findViewById(R.id.tvBytes)
        tvResult = findViewById(R.id.tvResult)
        scrollRoot = findViewById(R.id.scrollRoot)
        resultColor = tvResult.currentTextColor

        spProtocol.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, protocols
        )

        // 数据来源：**显示文字与值分开**（`SOURCE_VALUES` / `SOURCE_LABELS` 一一对应）。
        // 直接把 "poll"/"monitor" 丢给 adapter 的话，下拉框里是两个英文标识符，
        // 而用户心里想的是"我要造一条监听型信号"。
        spSource.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, PidDraft.SOURCE_LABELS
        )
        spSource.setSelection(PidDraft.sourceIndexOf(PidDraft.SOURCE_POLL))
        spSource.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(
                parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long
            ) = applySourceUi()

            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
        }

        val id = intent.getStringExtra(EXTRA_ID)
        val prefill = intent.getStringExtra(EXTRA_PREFILL)
        if (id != null) {
            editing = Store.findPid(id)
            editing?.let { load(it) }
        } else if (prefill != null) {
            // 由扫描器「存为 PID」传入：预填 Mode/PID/公式
            applyPrefill(prefill)
        } else {
            // 新建：给一套合理默认值
            etMode.setText("22")
            etPid.setText("")
            etFormula.setText("(A*256)+B")
            etMin.setText("0")
            etMax.setText("100")
            etGroup.setText("自定义")
            etInterval.setText("0")
            etRequest.setText("")
            swEnabled.isChecked = true
        }

        // 表单形态**必须在预填之后**再刷一次：预填可能来自监听型条目，
        // 而 spinner 的 onItemSelected 只在"选中项变化"时触发。
        applySourceUi()

        bindAutoRequest()
        bindFormulaTemplates()

        findViewById<MaterialButton>(R.id.btnTest).setOnClickListener { runTest() }
        findViewById<MaterialButton>(R.id.btnSample).setOnClickListener { runSample() }
        findViewById<MaterialButton>(R.id.btnSave).setOnClickListener { save() }
        findViewById<MaterialButton>(R.id.btnDelete).setOnClickListener { confirmDelete() }

        title = if (editing == null) "新增 PID" else "编辑 PID"
    }

    // ------------------------------------------------------------ 表单形态

    /** 当前下拉框选的是不是监听型（**唯一**的判据，别在别处再写一次） */
    private fun currentIsMonitor(): Boolean =
        PidDraft.isMonitor(PidDraft.sourceOf(spSource.selectedItemPosition))

    /**
     * 按「数据来源」把**不适用的字段藏掉**（v1.20.8，S3）。
     *
     * ## 为什么是藏，不是禁用
     *
     * 禁用只让控件变灰，占位还在 —— 一屏"灰掉的框"仍然会让人以为"是不是哪里没设对"。
     * 监听型真正需要填的只有：名称 / CAN ID / 公式 / 三个校验参数，
     * 其余（Mode、PID、请求帧、轮询间隔、优先级、多 ECU）**填了没人读**，
     * 留着它们的唯一效果是让人以为"填小一点值就更新得快"。
     *
     * ⚠️ **隐藏不等于清空**：`EditText` 里的字仍在，`PidDraft` 照旧读得到。
     * 于是编辑一条存量条目、切来切去看一眼、再保存，**不会把原来的值弄丢**。
     *
     * ⚠️ 两个测试按钮**刻意不禁用**：监听型点它们会走 [fail] 说出
     * "广播帧不能主动请求，到 CAN 探测页开常驻监听"。
     * 一个点不动的死按钮，用户就学不到这句话。
     */
    private fun applySourceUi() {
        val monitor = currentIsMonitor()
        findViewById<View>(R.id.rowModePid).visibility = if (monitor) View.GONE else View.VISIBLE
        findViewById<View>(R.id.rowRequest).visibility = if (monitor) View.GONE else View.VISIBLE
        findViewById<View>(R.id.colInterval).visibility = if (monitor) View.GONE else View.VISIBLE
        findViewById<View>(R.id.rowPriorityEcu).visibility = if (monitor) View.GONE else View.VISIBLE
        // 显示超时只对监听型有意义：主动请求型每次轮询都拿到新值，没有"过期"这回事
        findViewById<View>(R.id.colTtl).visibility = if (monitor) View.VISIBLE else View.GONE

        // header 是同一个字段、两种含义 —— 标签必须跟着来源变，
        // 否则用户会把 CAN ID 填进"模块头"里，然后得到一条永远不命中的监听条目
        tvHeaderLabel.text = if (monitor) {
            "CAN ID（广播帧的报文 ID）"
        } else {
            "CAN 目标模块头（AT SH，留空 = 广播 7DF）"
        }
        etHeader.hint = if (monitor) "09A" else "7E0"
        tvHeaderHint.text = if (monitor) {
            "如 09A / 2C7。填错的表现是「常驻监听在跑、这条一直没有值」——" +
                "日志里只有各 ID 的收帧数，看不出是 ID 写错了。"
        } else {
            "厂家数据基本都在具体模块里（发动机 7E0、仪表 720…）。" +
                "⚠️ AT SH 是粘性的，本项目在请求之间会自动切回广播。"
        }

        swEnabled.text = if (monitor) "启用（参与常驻监听）" else "启用（参与轮询）"
        tvSignalHint.text = if (monitor) {
            "无效原始值：位段本身等于它就视为无效（仪表显示 --）。" +
                "最小帧长：帧更短就不解析，并记一条「DLC不足」。" +
                "显示超时：广播停发这么久之后值自动变 --（留空按 ${PidDefinition.DEFAULT_MONITOR_TTL_MS}ms）。"
        } else {
            "这三项对主动请求型一般用不到（帧长由 ECU 决定）—— 留空即等于旧行为。" +
                "其中「显示超时」只对监听型有意义，所以这里不显示它。"
        }

        findViewById<MaterialButton>(R.id.btnTest).text =
            if (monitor) "发送测试请求（监听型不可用）" else "发送测试请求"
        // 采样按钮的文案是状态相关的，别在采样中把它改掉
        if (!sampling) {
            findViewById<MaterialButton>(R.id.btnSample).text =
                if (monitor) "连续采样（监听型不可用）" else "连续采样（标定量程）"
        }
    }

    // ------------------------------------------------------------ 载入 / 预填

    /**
     * 已有条目 → 表单。
     *
     * 字段的搬运全部交给 [PidDraft.of] —— 尤其是 `ttlMs`：
     * "0 在 JSON 里与没这个字段不可区分"，若在这里把它当成空，
     * 编辑一次存量条目就会把它悄悄改成默认值（那是**改用户数据**）。
     */
    private fun load(p: PidDefinition) {
        isBuiltIn = p.builtIn
        val f = PidDraft.of(p)
        etName.setText(f.name)
        spProtocol.setSelection(protocols.indexOf(f.protocol).coerceAtLeast(0))
        spSource.setSelection(PidDraft.sourceIndexOf(f.source))
        etHeader.setText(f.header)
        etMode.setText(f.mode)
        etPid.setText(f.pid)
        etRequest.setText(f.request)
        etFormula.setText(f.formula)
        etUnit.setText(f.unit)
        etMin.setText(f.minVal)
        etMax.setText(f.maxVal)
        etWarnLow.setText(f.warnLow)
        etWarnHigh.setText(f.warnHigh)
        etGroup.setText(f.group)
        etInterval.setText(f.intervalMs)
        spPriority.setSelection(f.priority)
        etEcuIndex.setText(f.ecuIndex)
        etInvalidRaw.setText(f.invalidRaw)
        etMinDlc.setText(f.minDlc)
        etTtl.setText(f.ttlMs)
        etNote.setText(f.note)
        swEnabled.isChecked = Store.isEnabled(p.id)

        if (isBuiltIn) {
            etGroup.setText("自定义")
            tvResult.text = "内置条目：保存会创建一条自定义副本（不影响内置库）"
            // 内置条目不可删除，按钮直接隐藏，避免点了才被拒绝
            findViewById<MaterialButton>(R.id.btnDelete).visibility = android.view.View.GONE
        }
    }

    private fun applyPrefill(json: String) {
        runCatching {
            val o = org.json.JSONObject(json)
            etName.setText(o.optString("name"))
            etMode.setText(o.optString("mode", "22"))
            etPid.setText(o.optString("pid"))
            etFormula.setText(o.optString("formula", "A"))
            etUnit.setText(o.optString("unit"))
            etMin.setText(o.optString("min", "0"))
            etMax.setText(o.optString("max", "100"))
            etGroup.setText("扫描结果")
            etInterval.setText("0")
            swEnabled.isChecked = false
            tvResult.text = "已按扫描结果预填，请点「发送测试请求」确认后再启用"
        }.onFailure {
            AppLog.w(AppLog.M_UI, "预填失败", it.message ?: "")
        }
    }

    // ------------------------------------------------------------ 交互

    /** Mode / PID 变化时自动同步请求串，除非用户手动改过请求框 */
    private fun bindAutoRequest() {
        val w = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (etRequest.hasFocus()) return
                val mode = etMode.text.toString().trim()
                val pid = etPid.text.toString().trim()
                if (mode.isBlank() || pid.isBlank()) return
                val auto = PidDefinition.normalize("$mode $pid")
                if (etRequest.text.toString() != auto) etRequest.setText(auto)
            }
        }
        etMode.addTextChangedListener(w)
        etPid.addTextChangedListener(w)
    }

    private fun bindFormulaTemplates() {
        val map = mapOf(
            R.id.btnTpl1 to "A",
            R.id.btnTpl2 to "(A*256)+B",
            R.id.btnTpl3 to "(A-128)*100/128",
            R.id.btnTpl4 to "A-40",
            R.id.btnTpl5 to "bit(A,0)",
            // 监听型的通用位段函数（v1.20.8，S3）。给一个**能直接改数字用**的样板，
            // 而不是只写个函数名 —— 参数顺序（起始位,长度,字节序,符号）是最容易记错的地方。
            R.id.btnTplBitsAt to "bitsAt(18,1,0,0)"
        )
        map.forEach { (id, f) ->
            findViewById<MaterialButton>(id).setOnClickListener { etFormula.setText(f) }
        }
    }

    // ------------------------------------------------------------ 表单 → 结论

    /**
     * 把控件里的字读出来，交给 [PidDraft.build]。
     *
     * ⚠️ **校验只有这一份实现**：测试、采样、保存三个按钮全走这里。
     * 以前每个按钮各写一遍 `if (p.pid.isBlank())`，于是"保存"那条路上的校验
     * 与"测试"那条路慢慢分叉了（一个 Toast、一个 fail，措辞也不一样）。
     */
    private fun evaluate(): PidDraft.Result {
        val f = PidDraft.Fields(
            name = etName.text.toString(),
            protocol = spProtocol.selectedItem?.toString() ?: "CAN",
            source = PidDraft.sourceOf(spSource.selectedItemPosition),
            header = etHeader.text.toString(),
            mode = etMode.text.toString(),
            pid = etPid.text.toString(),
            request = etRequest.text.toString(),
            formula = etFormula.text.toString(),
            unit = etUnit.text.toString(),
            minVal = etMin.text.toString(),
            maxVal = etMax.text.toString(),
            warnLow = etWarnLow.text.toString(),
            warnHigh = etWarnHigh.text.toString(),
            group = etGroup.text.toString(),
            intervalMs = etInterval.text.toString(),
            priority = spPriority.selectedItemPosition.coerceIn(0, 2),
            ecuIndex = etEcuIndex.text.toString(),
            invalidRaw = etInvalidRaw.text.toString(),
            minDlc = etMinDlc.text.toString(),
            ttlMs = etTtl.text.toString(),
            note = etNote.text.toString(),
            enabled = swEnabled.isChecked
        )
        return PidDraft.build(f, editing?.id ?: UUID.randomUUID().toString())
    }

    /**
     * 把 [PidDraft] 的硬错误变成**看得见**的失败（v1.20.6 那套三样：Toast + 警示色 + 滚到可见，
     * 见 [fail] 的说明）。
     *
     * 多条错误一起列出来（而不是只说第一条）：表单有 20 多个框，
     * 一次只说一个的话，用户要来回点五次才知道自己错在哪。
     */
    private fun failIssues(r: PidDraft.Result, prefix: String) {
        val head = r.errors.firstOrNull()?.message ?: "表单有问题"
        val row = buildString {
            append(prefix).append(": 校验未通过（").append(r.errors.size).append(" 项）")
            r.errors.take(5).forEach { append('\n').append("· ").append(it.message) }
            if (r.errors.size > 5) append("\n… 还有 ").append(r.errors.size - 5).append(" 项")
        }
        fail(row, head)
    }

    // ------------------------------------------------------------ 测试

    private fun runTest() {
        // 来源先判：监听型"不能主动请求"这件事与"表单填得对不对"无关，
        // 先说出来，用户才不会被"CAN ID 没填"这种次要错误带偏
        if (currentIsMonitor()) {
            fail(
                "解析结果: 这是监听型 PID（广播帧），不能主动请求 —— 到「CAN 探测」页开启常驻监听",
                "监听型 PID 不能主动请求，请到「CAN 探测」页开启常驻监听"
            )
            return
        }
        val r = evaluate()
        if (!r.ok) {
            failIssues(r, "解析结果")
            return
        }
        val p = r.pid!!
        if (!ObdController.isConnected()) {
            fail("解析结果: 设备未就绪，请先到「连接」页完成初始化", "设备未就绪，请先到「连接」页完成初始化")
            return
        }
        // 公式的静态检查已经在 `PidDraft.build` 里做过（它调 `Formula.check`），
        // 所以这里不再重复 —— 重复的后果是两处措辞慢慢分叉。

        tvTx.text = "TX: ${p.requestString()}（发送中…）"
        tvRx.text = "RX: -"
        tvBytes.text = "数据字节: -"
        tvResult.setTextColor(resultColor)
        tvResult.text = "解析结果: -"

        lifecycleScope.launch {
            val out = withContext(Dispatchers.IO) {
                val raw = ObdController.session.raw(p.requestString(), 3000)
                val parsed = ObdProtocol.parse(raw, p)
                Triple(raw, parsed, p)
            }
            val (raw, parsed, pid) = out
            tvTx.text = "TX: ${pid.requestString()}"
            tvRx.text = "RX: ${raw.ifBlank { "(超时无响应)" }}"
            if (parsed.data.isNotEmpty()) {
                tvBytes.text = "数据字节: " + parsed.data.mapIndexed { i, b ->
                    "${('A' + i)}=" + String.format("%02X", b.toInt() and 0xFF)
                }.joinToString("  ")
            } else {
                tvBytes.text = "数据字节: (无)"
            }
            tvResult.text = if (parsed.ok && parsed.value != null) {
                String.format("解析结果: %.3f %s", parsed.value, pid.unit)
            } else {
                "解析结果: 失败 —— ${parsed.error ?: "未知"}"
            }
            AppLog.i(
                AppLog.M_UI, "PID 测试",
                "req=${pid.requestString()} raw=${raw.take(60)} ok=${parsed.ok} err=${parsed.error}"
            )
        }
    }

    // ------------------------------------------------------------ 连续采样标定

    /**
     * 连续采样，用来**标定量程与报警阈值**。
     *
     * 单次「发送测试请求」只能告诉你「现在是多少」；而要填对 `min` / `max` / `warnHigh`，
     * 需要知道这个量在真实工况下的**取值范围** —— 否则只能靠猜，或者另开 CSV 再回 Excel 算。
     *
     * 两个刻意的设计：
     *  1. **采样期间停掉轮询引擎** —— 否则两边抢同一条半双工串口，采样值会互相污染。
     *  2. **再点一次即停止**，且有硬上限时长，不会变成「忘了关的后台任务」。
     */
    private fun runSample() {
        if (currentIsMonitor()) {
            fail(
                "解析结果: 这是监听型 PID（广播帧），不能主动请求 —— 到「CAN 探测」页开启常驻监听",
                "监听型 PID 不能主动请求，请到「CAN 探测」页开启常驻监听"
            )
            return
        }
        val r = evaluate()
        if (!r.ok) {
            failIssues(r, "采样")
            return
        }
        val p = r.pid!!
        if (!ObdController.isConnected()) {
            fail("采样: 设备未就绪，请先到「连接」页完成初始化", "设备未就绪，请先到「连接」页完成初始化")
            return
        }

        val btnSample = findViewById<MaterialButton>(R.id.btnSample)
        if (sampling) {
            sampling = false
            btnSample.text = "连续采样（标定量程）"
            return
        }

        tvResult.setTextColor(resultColor)
        sampling = true
        btnSample.text = "停止采样"
        val wasRunning = ObdController.engine.running
        if (wasRunning) ObdController.engine.stop()

        lifecycleScope.launch {
            val values = ArrayList<Float>()
            var fails = 0
            val started = System.currentTimeMillis()
            while (sampling && System.currentTimeMillis() - started < sampleDurationMs) {
                val parsed = withContext(Dispatchers.IO) {
                    ObdProtocol.parse(ObdController.session.raw(p.requestString(), 3000), p)
                }
                if (parsed.ok && parsed.value != null) values.add(parsed.value!!) else fails++
                tvResult.text = String.format(
                    "采样中… 有效 %d / 失败 %d · 已用 %.0f 秒（再点一次停止）",
                    values.size, fails, (System.currentTimeMillis() - started) / 1000f
                )
                delay(sampleIntervalMs)
            }

            sampling = false
            btnSample.text = "连续采样（标定量程）"
            if (wasRunning) ObdController.engine.start()

            tvResult.text = if (values.isEmpty()) {
                "采样结果: 全程失败（$fails 次）—— 检查 PID 号 / 协议 / 点火开关是否 ON"
            } else {
                String.format(
                    "采样结果（有效 %d / 失败 %d）\n最小 %.3f   最大 %.3f   均值 %.3f %s\n建议量程: %.0f ~ %.0f",
                    values.size, fails, values.min(), values.max(), values.average(), p.unit,
                    Math.floor(values.min().toDouble()), Math.ceil(values.max().toDouble())
                )
            }
            AppLog.i(
                AppLog.M_UI, "PID 连续采样",
                "req=${p.requestString()} ok=${values.size} fail=$fails"
            )
        }
    }

    // ------------------------------------------------------------ 保存 / 删除

    private fun save() {
        val r = evaluate()
        if (!r.ok) {
            failIssues(r, "保存")
            return
        }
        val p = r.pid!!

        if (isBuiltIn) {
            // 内置条目不改动，生成自定义副本，并把内置项关掉避免重复轮询
            val copy = p.copy(
                id = UUID.randomUUID().toString(),
                name = p.name + "(副本)",
                builtIn = false,
                group = "自定义"
            )
            Store.upsertPid(copy)
            editing?.let { Store.setEnabled(it.id, false) }
            ObdController.toast("已保存为自定义副本，内置条目已关闭")
            AppLog.i(AppLog.M_UI, "内置 PID 复制为自定义", "name=${copy.name}")
        } else {
            Store.upsertPid(p)
            Store.setEnabled(p.id, p.enabled)
            // 软警告也要说出来：最常见的一条是"显示超时留空 → 按默认 2000ms"，
            // 不说的话用户不知道自己刚被套了一个默认值
            val warn = r.warnings.firstOrNull()?.message
            ObdController.toast(if (warn != null) "已保存；提示：$warn" else "已保存")
            AppLog.i(
                AppLog.M_UI, "PID 已保存",
                "name=${p.name} source=${p.source} header=${p.header} " +
                    "minDlc=${p.minDlc} invalidRaw=${p.invalidRaw} ttl=${p.ttlMs} " +
                    "enabled=${p.enabled}"
            )
        }
        // 常驻监听把信号列表缓存在 `start()` 那一刻：正在跑的时候新存的条目**不会生效**。
        // 不说的话，用户会以为"保存了但没反应 = 我填错了"。
        if (PidDraft.isMonitor(p.source) && FrameMonitor.running) {
            ObdController.toast("常驻监听正在跑，要停掉再开才会用上这条新信号")
        }
        ObdController.reloadPids()
        finish()
    }


    /**
     * **校验失败要让用户看得见**（v1.20.6，P10-2）。
     *
     * ## 为什么三样一起做（Toast + 警示色 + 滚到可见）
     *
     * 原来失败只把结果行的一行小字改掉（`解析结果: 请先填写 PID`），
     * 而这一行在**表单最底下** —— 用户点「发送测试请求」后屏幕上什么都没变，
     * 直接得出"App 坏了 / 车没反应"的结论（P10 表格里写着"今天我自己踩了两次"）。
     *
     * 三样各有分工，缺一样都会漏：
     *  - **Toast**：不管当前滚到哪、不管页面多长，一定看得见 → 这是主判据；
     *  - **警示色**：人已经盯着结果行时，颜色比小字更早被注意到；
     *  - **滚过去**：表单长的时候把证据送到眼前，省掉"是不是我没滚下去"的怀疑。
     *
     * @param row   写进结果行的整句（带 `解析结果:` / `采样:` 前缀，保持原有措辞）
     * @param toast 弹出来的短句。默认与 [row] 相同；结果行要带前缀、Toast 要短，就分开传
     */
    private fun fail(row: String, toast: String = row) {
        tvResult.text = row
        tvResult.setTextColor(androidx.core.content.ContextCompat.getColor(this, R.color.danger))
        // 结果行在 ScrollView 里，滚到它（`top` 是相对内容顶部的偏移）
        scrollRoot.post { runCatching { scrollRoot.smoothScrollTo(0, tvResult.top) } }
        ObdController.toast(toast)
        AppLog.w(AppLog.M_UI, "PID 编辑器校验未通过", toast)
    }

    private fun confirmDelete() {
        val cur = editing
        if (cur == null || cur.builtIn) {
            ObdController.toast("内置条目不可删除")
            return
        }
        AlertDialog.Builder(this)
            .setTitle("删除 PID")
            .setMessage("确定删除「${cur.name}」？")
            .setPositiveButton("删除") { _, _ ->
                Store.deletePid(cur.id)
                ObdController.reloadPids()
                finish()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // `fmt()` 已经搬到 `PidDraft.fmtNum`：载入表单与生成公式两处都要"整数不带 .0"，
    // 留两份的下场是其中一个慢慢变了（比如某天给一边加上千分位）。

    companion object {
        const val EXTRA_ID = "pid_id"
        const val EXTRA_PREFILL = "pid_prefill_json"
    }
}
