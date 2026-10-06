package com.icar.obd.ui

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
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
import com.icar.obd.data.Formula
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.Store
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
 */
class PidEditorActivity : AppCompatActivity() {

    private lateinit var etName: EditText
    private lateinit var spProtocol: Spinner
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

    private var editing: PidDefinition? = null
    private var isBuiltIn = false

    private val protocols = listOf("CAN", "ISO9141", "KWP", "J1850", "其他")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pid_editor)

        etName = findViewById(R.id.etName)
        spProtocol = findViewById(R.id.spProtocol)
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

        spProtocol.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, protocols
        )

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

        bindAutoRequest()
        bindFormulaTemplates()

        findViewById<MaterialButton>(R.id.btnTest).setOnClickListener { runTest() }
        findViewById<MaterialButton>(R.id.btnSample).setOnClickListener { runSample() }
        findViewById<MaterialButton>(R.id.btnSave).setOnClickListener { save() }
        findViewById<MaterialButton>(R.id.btnDelete).setOnClickListener { confirmDelete() }

        title = if (editing == null) "新增 PID" else "编辑 PID"
    }

    // ------------------------------------------------------------ 载入 / 预填

    private fun load(p: PidDefinition) {
        isBuiltIn = p.builtIn
        etName.setText(p.name)
        spProtocol.setSelection(protocols.indexOf(p.protocol).coerceAtLeast(0))
        etMode.setText(p.mode)
        etPid.setText(p.pid)
        etRequest.setText(p.customRequest ?: p.requestString())
        etFormula.setText(p.formula)
        etUnit.setText(p.unit)
        etMin.setText(fmt(p.minVal))
        etMax.setText(fmt(p.maxVal))
        etWarnLow.setText(p.warnLow?.let { fmt(it) } ?: "")
        etWarnHigh.setText(p.warnHigh?.let { fmt(it) } ?: "")
        etGroup.setText(p.group)
        etInterval.setText(p.intervalMs.toString())
        spPriority.setSelection(p.priority.coerceIn(0, 2))
        etEcuIndex.setText(p.ecuIndex.toString())
        etNote.setText(p.note)
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
            R.id.btnTpl5 to "bit(A,0)"
        )
        map.forEach { (id, f) ->
            findViewById<MaterialButton>(id).setOnClickListener { etFormula.setText(f) }
        }
    }

    // ------------------------------------------------------------ 测试

    private fun collect(): PidDefinition {
        val mode = etMode.text.toString().trim().ifBlank { "01" }
        val pid = etPid.text.toString().trim()
        val req = etRequest.text.toString().trim().ifBlank { PidDefinition.normalize("$mode $pid") }
        return PidDefinition(
            id = editing?.id ?: UUID.randomUUID().toString(),
            name = etName.text.toString().trim(),
            protocol = spProtocol.selectedItem?.toString() ?: "CAN",
            mode = mode,
            pid = pid,
            formula = etFormula.text.toString().trim().ifBlank { "A" },
            unit = etUnit.text.toString().trim(),
            minVal = etMin.text.toString().toFloatOrNull() ?: 0f,
            maxVal = etMax.text.toString().toFloatOrNull() ?: 100f,
            warnLow = etWarnLow.text.toString().toFloatOrNull(),
            warnHigh = etWarnHigh.text.toString().toFloatOrNull(),
            enabled = swEnabled.isChecked,
            builtIn = false,
            intervalMs = etInterval.text.toString().toIntOrNull() ?: 0,
            ecuIndex = (etEcuIndex.text.toString().toIntOrNull() ?: 0).coerceAtLeast(0),
            priority = spPriority.selectedItemPosition.coerceIn(0, 2),
            customRequest = req,
            group = etGroup.text.toString().trim().ifBlank { "自定义" },
            note = etNote.text.toString().trim()
        )
    }

    private fun runTest() {
        val p = collect()
        if (p.source.equals("monitor", true)) {
            tvResult.text = "解析结果: 这是**监听型** PID（广播帧），不能主动请求 —— 到「CAN 探测」页开启常驻监听"
            return
        }
        if (p.pid.isBlank()) {
            tvResult.text = "解析结果: 请先填写 PID"
            return
        }
        if (!ObdController.isConnected()) {
            tvResult.text = "解析结果: 设备未就绪，请先到「连接」页完成初始化"
            return
        }
        // 先做静态语法检查，省一次总线往返
        Formula.check(p.formula)?.let { err ->
            tvResult.text = "公式语法错误: $err"
            return
        }

        tvTx.text = "TX: ${p.requestString()}（发送中…）"
        tvRx.text = "RX: -"
        tvBytes.text = "数据字节: -"
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
        val p = collect()
        if (p.source.equals("monitor", true)) {
            tvResult.text = "解析结果: 这是**监听型** PID（广播帧），不能主动请求 —— 到「CAN 探测」页开启常驻监听"
            return
        }
        if (p.pid.isBlank()) {
            tvResult.text = "采样: 请先填写 PID"
            return
        }
        if (!ObdController.isConnected()) {
            tvResult.text = "采样: 设备未就绪，请先到「连接」页完成初始化"
            return
        }
        Formula.check(p.formula)?.let {
            tvResult.text = "公式语法错误: $it"
            return
        }

        val btnSample = findViewById<MaterialButton>(R.id.btnSample)
        if (sampling) {
            sampling = false
            btnSample.text = "连续采样（标定量程）"
            return
        }

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
        val p = collect()
        if (p.name.isBlank()) {
            ObdController.toast("请填写名称")
            return
        }
        if (p.source.equals("monitor", true)) {
            tvResult.text = "解析结果: 这是**监听型** PID（广播帧），不能主动请求 —— 到「CAN 探测」页开启常驻监听"
            return
        }
        if (p.pid.isBlank()) {
            ObdController.toast("请填写 PID")
            return
        }
        Formula.check(p.formula)?.let {
            ObdController.toast("公式有问题：$it")
            return
        }

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
            ObdController.toast("已保存")
            AppLog.i(AppLog.M_UI, "PID 已保存", "name=${p.name} req=${p.requestString()}")
        }
        ObdController.reloadPids()
        finish()
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

    private fun fmt(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else f.toString()

    companion object {
        const val EXTRA_ID = "pid_id"
        const val EXTRA_PREFILL = "pid_prefill_json"
    }
}
