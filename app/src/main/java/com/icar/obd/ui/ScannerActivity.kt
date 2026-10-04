package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.ObdProtocol
import com.icar.obd.obd.PidScanner
import com.icar.obd.ui.adapter.ScanHitAdapter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * PID 扫描器界面。
 *
 * 这个页面的首要目标不是「扫得全」，而是「扫得安全」。
 * 因此所有危险参数都做成显式开关 + 二次确认，并且默认值偏保守：
 *   间隔 150ms、超时 1500ms、重试 1 次、上限 400 条、学习采样关闭。
 *
 * 危险模式（02 冻结帧 / 03 读码 / 04 清码 / 06 监测）在 [PidScanner] 里被硬拒绝，
 * 界面上也能看到它们，但点开始会被拦下并写日志——这是有意为之，
 * 让下一个接手的人知道「这里曾经挡过一次」。
 */
class ScannerActivity : AppCompatActivity() {

    private lateinit var spMode: Spinner
    private lateinit var etFrom: EditText
    private lateinit var etTo: EditText
    private lateinit var etInterval: EditText
    private lateinit var etTimeout: EditText
    private lateinit var etRetry: EditText
    private lateinit var etMax: EditText
    private lateinit var etLearn: EditText
    private lateinit var etBlacklist: EditText
    private lateinit var swBitmap: MaterialSwitch
    private lateinit var swConfirm: MaterialSwitch
    private lateinit var btnStart: MaterialButton
    private lateinit var btnStop: MaterialButton
    private lateinit var progress: ProgressBar
    private lateinit var tvProgress: TextView
    private lateinit var tvLog: TextView
    private lateinit var adapter: ScanHitAdapter

    private val modes = listOf(
        "01" to "01 实时数据（推荐）",
        "09" to "09 车辆信息",
        "21" to "21 厂家自定义",
        "22" to "22 厂家自定义（最常用）",
        "23" to "23 厂家自定义",
        "02" to "02 冻结帧（危险·拒绝）",
        "03" to "03 读取故障码（危险·拒绝）",
        "04" to "04 清除故障码（危险·拒绝）",
        "06" to "06 车载监测（危险·拒绝）"
    )

    private val logLines = ArrayList<String>()
    private var running = false
    private var lastAppliedMode: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scanner)

        spMode = findViewById(R.id.spMode)
        etFrom = findViewById(R.id.etFrom)
        etTo = findViewById(R.id.etTo)
        etInterval = findViewById(R.id.etInterval)
        etTimeout = findViewById(R.id.etTimeout)
        etRetry = findViewById(R.id.etRetry)
        etMax = findViewById(R.id.etMax)
        etLearn = findViewById(R.id.etLearn)
        etBlacklist = findViewById(R.id.etBlacklist)
        swBitmap = findViewById(R.id.swBitmap)
        swConfirm = findViewById(R.id.swConfirm)
        btnStart = findViewById(R.id.btnStart)
        btnStop = findViewById(R.id.btnStop)
        progress = findViewById(R.id.progress)
        tvProgress = findViewById(R.id.tvProgress)
        tvLog = findViewById(R.id.tvLog)

        adapter = ScanHitAdapter { hit -> saveHit(hit) }
        findViewById<RecyclerView>(R.id.rvHits).apply {
            layoutManager = LinearLayoutManager(this@ScannerActivity)
            adapter = this@ScannerActivity.adapter
        }

        spMode.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, modes.map { it.second }
        )
        spMode.setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) = applyModeDefaults()
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        })

        btnStart.setOnClickListener { startScan() }
        btnStop.setOnClickListener { stopScan() }

        applyModeDefaults()
        appendLog("就绪。扫描前请确认车辆处于安全状态。")
    }

    private fun currentMode(): String = modes[spMode.selectedItemPosition.coerceIn(0, modes.size - 1)].first

    /** 切换模式时给出合理的默认范围与黑名单，减少用户填错的机会 */
    private fun applyModeDefaults() {
        val mode = currentMode()
        // Spinner 初始化与显式调用都会走到这里，用 lastAppliedMode 去重，
        // 否则日志里会出现两条一模一样的「已切换到 Mode …」
        if (mode == lastAppliedMode) return
        lastAppliedMode = mode

        when (mode) {
            "01" -> {
                etFrom.setText("00"); etTo.setText("60")
                etBlacklist.setText("01:02,01:03,01:07,01:0A")
            }
            "09" -> {
                etFrom.setText("00"); etTo.setText("40")
                etBlacklist.setText("")
            }
            else -> {
                etFrom.setText("1100"); etTo.setText("11FF")
                etBlacklist.setText("")
            }
        }
        appendLog("已切换到 Mode $mode，范围 ${etFrom.text}~${etTo.text}")
    }

    private fun startScan() {
        if (running) return
        val mode = currentMode()

        if (ObdProtocol.isDangerous(mode)) {
            appendLog("⛔ Mode $mode 会改变 ECU 状态，已拒绝。")
            ObdController.toast("该模式被安全策略拒绝")
            AppLog.w(AppLog.M_SCAN, "UI 层拦截危险模式", "mode=$mode")
            return
        }
        if (!swConfirm.isChecked) {
            ObdController.toast("请先勾选安全确认")
            return
        }
        if (!ObdController.isConnected()) {
            ObdController.toast("设备未就绪，请先到「连接」页初始化")
            return
        }

        val width = if (mode == "01" || mode == "02" || mode == "09") 2 else 4
        val from = etFrom.text.toString().trim().toIntOrNull(16)
        val to = etTo.text.toString().trim().toIntOrNull(16)
        if (from == null || to == null || from > to) {
            ObdController.toast("范围不合法")
            return
        }

        val cfg = PidScanner.Config(
            mode = mode,
            from = from,
            to = to,
            intervalMs = (etInterval.text.toString().toIntOrNull() ?: 150).coerceAtLeast(30).toLong(),
            timeoutMs = (etTimeout.text.toString().toIntOrNull() ?: 1500).coerceAtLeast(200).toLong(),
            retry = (etRetry.text.toString().toIntOrNull() ?: 1).coerceIn(0, 3),
            blacklist = etBlacklist.text.toString().split(',')
                .map { it.trim().uppercase() }.filter { it.isNotEmpty() }.toSet(),
            useSupportedBitmap = swBitmap.isChecked,
            maxRequests = (etMax.text.toString().toIntOrNull() ?: 400).coerceIn(1, 2000),
            learnSamples = (etLearn.text.toString().toIntOrNull() ?: 0).coerceIn(0, 20)
        )

        adapter.clear()
        progress.progress = 0
        running = true
        btnStart.isEnabled = false
        btnStop.isEnabled = true

        val est = ((to - from + 1) * cfg.intervalMs / 1000.0)
        appendLog("开始扫描 Mode $mode ${hex(from, width)}~${hex(to, width)}，预计约 ${"%.0f".format(est)} 秒")

        val scanner = ObdController.scanner
        lifecycleScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) {
                    scanner.scan(cfg) { done, total, hit ->
                        withContext(Dispatchers.Main) {
                            progress.progress = if (total > 0) done * 100 / total else 0
                            tvProgress.text = "进度 $done / $total"
                            if (hit != null) {
                                adapter.add(hit)
                                appendLog("命中 Mode ${hit.mode} PID ${hit.pid} → ${hit.dataHex}")
                            }
                        }
                    }
                }
            }
            running = false
            btnStart.isEnabled = true
            btnStop.isEnabled = false
            progress.progress = 100
            result.onSuccess { hits ->
                tvProgress.text = "完成：${hits.size} 条命中"
                appendLog("扫描完成，命中 ${hits.size} 条。点击结果里的「存为PID」可带入编辑器。")
            }.onFailure { t ->
                tvProgress.text = "失败：${t.message}"
                appendLog("扫描失败：${t.message}")
            }
        }
    }

    private fun stopScan() {
        if (!running) return
        ObdController.scanner.cancel()
        appendLog("已请求停止…")
    }

    private fun saveHit(hit: PidScanner.Hit) {
        val json = JSONObject().apply {
            put("name", "Mode${hit.mode} PID${hit.pid}")
            put("mode", hit.mode)
            put("pid", hit.pid)
            put("formula", hit.suggestedFormula)
            put("unit", "")
            put("min", hit.learnedMin ?: 0f)
            put("max", hit.learnedMax ?: 100f)
        }.toString()
        startActivity(
            Intent(this, PidEditorActivity::class.java).putExtra(PidEditorActivity.EXTRA_PREFILL, json)
        )
    }

    private fun appendLog(line: String) {
        logLines.add(line)
        while (logLines.size > 200) logLines.removeAt(0)
        tvLog.text = logLines.takeLast(12).joinToString("\n")
    }

    private fun hex(v: Int, w: Int) = v.toString(16).uppercase().padStart(w, '0')
}
