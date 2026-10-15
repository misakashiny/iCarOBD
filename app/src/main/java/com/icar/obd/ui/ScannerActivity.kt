package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.*
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.obd.*
import com.icar.obd.ui.adapter.ScanHitAdapter
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

/** Rotation replaces observers, not the scan owner. Final page exit cancels it. */
class ScannerStateModel : ViewModel() {
    internal val scan=PidScanRun(AndroidPidScanRuntime())
    val fields=mutableMapOf<Int,String>()
    var mode="01"
    var confirmed=false
    var bitmap=true
    var advanced=false
    var settings=true
    var logs=false
    val logLines=mutableListOf<String>()
    override fun onCleared() { scan.stop() }
}

class ScannerActivity : AppCompatActivity() {
    private val model by lazy { ViewModelProvider(this)[ScannerStateModel::class.java] }
    private lateinit var adapter: ScanHitAdapter
    private lateinit var mode: Spinner
    private lateinit var bitmap: MaterialSwitch
    private lateinit var confirm: MaterialSwitch
    private lateinit var start: MaterialButton
    private lateinit var stop: MaterialButton
    private lateinit var export: MaterialButton
    private val fields=linkedMapOf<Int,EditText>()
    private val modes=listOf("01" to "01 · 实时数据", "09" to "09 · 车辆信息",
        "21" to "21 · 厂家本地ID（1字节）", "22" to "22 · 厂家数据ID（2字节）")
    private val defaults=linkedMapOf(R.id.etFrom to "00",R.id.etTo to "C0",R.id.etScanHeader to "7DF",
        R.id.etMax to "400",R.id.etInterval to "150",R.id.etTimeout to "1500",
        R.id.etRetry to "1",R.id.etLearn to "0",R.id.etBlacklist to "01:02,01:03,01:07,01:0A")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scanner)
        if(model.fields.isEmpty() && savedInstanceState!=null) {
            model.mode=savedInstanceState.getString("mode") ?: "01"
            defaults.keys.forEach { id -> savedInstanceState.getString("field$id")?.let { model.fields[id]=it } }
            model.settings=savedInstanceState.getBoolean("settings",true)
            model.advanced=savedInstanceState.getBoolean("advanced",false)
        }
        defaults.forEach { (id,value) -> fields[id]=findViewById<EditText>(id).also { it.setText(model.fields[id] ?: value) } }
        mode=findViewById(R.id.spMode)
        bitmap=findViewById(R.id.swBitmap); confirm=findViewById(R.id.swConfirm)
        start=findViewById(R.id.btnStart); stop=findViewById(R.id.btnStop); export=findViewById(R.id.btnExport)
        adapter=ScanHitAdapter(::saveHit)
        findViewById<RecyclerView>(R.id.rvHits).apply { layoutManager=LinearLayoutManager(this@ScannerActivity); adapter=this@ScannerActivity.adapter }
        mode.adapter=ArrayAdapter(this,android.R.layout.simple_spinner_dropdown_item,modes.map { it.second })
        mode.setSelection(modes.indexOfFirst { it.first==model.mode }.coerceAtLeast(0))
        mode.onItemSelectedListener=object: AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) {}
            override fun onItemSelected(parent: AdapterView<*>?,view: View?,position: Int,id: Long) {
                val selected=modes[position].first
                if(selected!=model.mode) {
                    model.mode=selected; model.confirmed=false; confirm.isChecked=false
                    set(R.id.etFrom,if(selected=="22") "1100" else "00")
                    set(R.id.etTo,when(selected) { "01"->"C0"; "09"->"40"; "21"->"FF"; else->"11FF" })
                    set(R.id.etBlacklist,if(selected=="01") defaults.getValue(R.id.etBlacklist) else "")
                    bitmap.isChecked=selected in setOf("01","09")
                }
                bitmap.isEnabled=!model.scan.state.value.busy && selected in setOf("01","09")
                validateForm()
            }
        }
        bitmap.isChecked=model.bitmap; confirm.isChecked=model.confirmed
        bitmap.setOnCheckedChangeListener { _,checked -> model.bitmap=checked; validateForm() }
        confirm.setOnCheckedChangeListener { _,checked -> model.confirmed=checked; validateForm() }
        fields.forEach { (id,edit) -> edit.doAfterTextChanged { model.fields[id]=it.toString(); validateForm() } }
        start.setOnClickListener { startScan() }
        stop.setOnClickListener { model.scan.stop() }
        export.setOnClickListener { exportResults() }
        findViewById<MaterialButton>(R.id.btnScanBack).setOnClickListener { finish() }
        findViewById<MaterialButton>(R.id.btnScanSettings).setOnClickListener { model.settings=!model.settings; layoutPanels() }
        findViewById<MaterialButton>(R.id.btnScanAdvanced).setOnClickListener { model.advanced=!model.advanced; layoutPanels() }
        findViewById<MaterialButton>(R.id.btnScanLog).setOnClickListener { model.logs=!model.logs; layoutPanels() }
        layoutPanels(); render(model.scan.state.value)
        lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { model.scan.state.collect(::render) } }
    }
    private fun set(id: Int,value: String) { fields.getValue(id).setText(value) }
    private fun text(id: Int)=fields.getValue(id).text.toString().trim()
    private fun number(id: Int)=text(id).toIntOrNull() ?: error("请填写有效的数字")
    private fun config(): PidScanner.Config {
        val cfg=PidScanner.Config(mode=model.mode,
            from=text(R.id.etFrom).toIntOrNull(16) ?: error("起始PID需为十六进制"),
            to=text(R.id.etTo).toIntOrNull(16) ?: error("结束PID需为十六进制"),
            intervalMs=number(R.id.etInterval).toLong(),timeoutMs=number(R.id.etTimeout).toLong(),
            retry=number(R.id.etRetry),maxRequests=number(R.id.etMax),learnSamples=number(R.id.etLearn),
            blacklist=text(R.id.etBlacklist).split(',').map { it.trim().uppercase() }.filter { it.isNotEmpty() }.toSet(),
            useSupportedBitmap=bitmap.isChecked && model.mode in setOf("01","09"),header=text(R.id.etScanHeader).uppercase())
        PidScanner.validate(cfg)
        return cfg
    }
    private fun validateForm() {
        if(!::start.isInitialized) return
        val error=runCatching { config() }.exceptionOrNull()?.message
        findViewById<TextView>(R.id.tvWarning).text=error ?: "主动读取会暂停轮询；只允许01/09/21/22。"
        if(!model.scan.state.value.busy) {
            findViewById<TextView>(R.id.tvProgress).text=error?.let { "参数有误 · $it" } ?: statusLabel(model.scan.state.value)
        }
        start.isEnabled=error==null && confirm.isChecked && ObdController.isConnected() && !model.scan.state.value.busy
    }
    private fun startScan() {
        runCatching { check(confirm.isChecked) { "请确认车辆已安全停放" }; model.scan.start(config()) }
            .onFailure { ObdController.toast(it.message ?: "无法开始探测") }
    }
    private fun render(s: PidScanRun.Snapshot) {
        start.visibility=if(s.busy) View.GONE else View.VISIBLE
        stop.visibility=if(s.busy) View.VISIBLE else View.GONE
        stop.isEnabled=s.message!="正在收尾"
        fields.values.forEach { it.isEnabled=!s.busy }
        mode.isEnabled=!s.busy; confirm.isEnabled=!s.busy
        bitmap.isEnabled=!s.busy && model.mode in setOf("01","09")
        export.isEnabled=s.cfg!=null && !s.busy
        adapter.replace(s.hits)
        findViewById<TextView>(R.id.tvScanResults).text="探测结果 · ${s.hits.size}条"
        findViewById<TextView>(R.id.tvScanEmpty).apply {
            visibility=if(s.hits.isEmpty()) View.VISIBLE else View.GONE
            text=when { s.busy->"探测中，收到有效应答后显示在这里。"; s.cfg!=null->"本轮没有命中。可导出记录检查范围、ECU和响应情况。"; else->"还没有结果。先到连接页初始化，再设置范围。" }
        }
        val count=s.summary
        findViewById<ProgressBar>(R.id.progress).apply {
            isIndeterminate=s.busy && count.total==0
            progress=if(count.total>0) count.done*100/count.total else 0
        }
        val label=statusLabel(s)
        findViewById<TextView>(R.id.tvProgress).text=label
        if(model.logLines.lastOrNull()!=label) { model.logLines+=label; while(model.logLines.size>200) model.logLines.removeAt(0) }
        findViewById<TextView>(R.id.tvLog).text=model.logLines.takeLast(12).joinToString("\n")
        validateForm()
    }
    private fun statusLabel(s: PidScanRun.Snapshot): String {
        val count=s.summary
        return if(s.cfg==null && !ObdController.isConnected()) "未连接 · 先到连接页初始化" else
            "${s.message} · 请求${count.requests}/${s.cfg?.maxRequests ?: 0} · PID ${count.done}/${count.total}"+
                if(count.unknownBlocks>0) " · ${count.unknownBlocks}块位图未探明" else ""
    }
    private fun layoutPanels() {
        val wide=resources.configuration.screenWidthDp>=900
        findViewById<LinearLayout>(R.id.scanColumns).orientation=if(wide) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
        findViewById<View>(R.id.scanSettingsScroll).apply {
            visibility=if(model.settings) View.VISIBLE else View.GONE
            layoutParams=LinearLayout.LayoutParams(if(wide) dp(350) else -1,if(wide) -1 else dp(240)).apply { if(wide) marginEnd=dp(8) }
        }
        findViewById<View>(R.id.scanResults).layoutParams=LinearLayout.LayoutParams(if(wide) 0 else -1,if(wide) -1 else 0,1f).apply { if(!wide && model.settings) topMargin=dp(8) }
        findViewById<View>(R.id.scanAdvanced).visibility=if(model.advanced) View.VISIBLE else View.GONE
        findViewById<View>(R.id.scanLogScroll).visibility=if(model.logs) View.VISIBLE else View.GONE
        findViewById<MaterialButton>(R.id.btnScanSettings).text=if(model.settings) "收起" else "设置"
        findViewById<MaterialButton>(R.id.btnScanAdvanced).text=if(model.advanced) "收起高级参数" else "高级参数"
        findViewById<MaterialButton>(R.id.btnScanLog).text=if(model.logs) "收起过程记录" else "过程记录"
    }
    private fun dp(value: Int)=(value*resources.displayMetrics.density).toInt()
    private fun exportResults() {
        val s=model.scan.state.value
        if(s.cfg==null || s.busy) return
        runCatching {
            val dir=File(getExternalFilesDir(null),"export").apply { mkdirs() }
            val stamp=SimpleDateFormat("yyyyMMdd-HHmmss",Locale.US).format(Date())
            val file=File(dir,"scan-${s.cfg.mode}-$stamp.txt")
            file.writeText(PidScanner.report(s.cfg,s.hits,model.logLines,Date().toString(),s.summary))
            val uri=FileProvider.getUriForFile(this,"$packageName.fileprovider",file)
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type="text/plain"; putExtra(Intent.EXTRA_STREAM,uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            },"导出探测记录"))
        }.onFailure { ObdController.toast("导出失败：${it.message}") }
    }
    private fun saveHit(hit: PidScanner.Hit) {
        if(model.scan.state.value.busy) { ObdController.toast("请先停止探测，再核实并编辑PID"); return }
        val json=JSONObject().apply {
            put("name","Mode${hit.mode} PID${hit.pid}"); put("mode",hit.mode); put("pid",hit.pid)
            put("header",hit.header); put("formula",hit.suggestedFormula); put("unit",""); put("min",0); put("max",100)
        }.toString()
        startActivity(Intent(this,PidEditorActivity::class.java).putExtra(PidEditorActivity.EXTRA_PREFILL,json))
    }
    override fun onSaveInstanceState(outState: Bundle) {
        fields.forEach { (id,edit) -> outState.putString("field$id",edit.text.toString()) }
        outState.putString("mode",model.mode); outState.putBoolean("settings",model.settings); outState.putBoolean("advanced",model.advanced)
        super.onSaveInstanceState(outState)
    }
}
