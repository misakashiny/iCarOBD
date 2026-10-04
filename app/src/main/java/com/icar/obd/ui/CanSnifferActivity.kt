package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.obd.CanFrame
import com.icar.obd.obd.CanSniffer
import com.icar.obd.obd.ObdController
import java.io.File

/**
 * CAN 总线被动探测界面。
 *
 * 与 PID 扫描器的区别：扫描器**主动请求**（只能发现 ECU 愿答的 PID），
 * 这里**被动监听**（`ATMA`），能看到广播帧 —— 转向灯、车门、刹车这类信号只能这样找。
 */
class CanSnifferActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var btnToggle: MaterialButton
    private lateinit var container: ViewGroup
    private lateinit var spDuration: Spinner

    private val durations = listOf(3, 5, 10, 20, 30, 60)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_can_sniffer)

        tvStatus = findViewById(R.id.tvSniffStatus)
        btnToggle = findViewById(R.id.btnSniffToggle)
        container = findViewById(R.id.sniffResults)
        spDuration = findViewById(R.id.spSniffDuration)

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

        CanSniffer.onUpdate = { st ->
            tvStatus.text = describe(st)
            btnToggle.text = if (CanSniffer.running) "停止探测" else "开始探测"
            buildRows()
        }
        tvStatus.text = describe(CanSniffer.status)
        buildRows()
    }

    override fun onDestroy() {
        super.onDestroy()
        CanSniffer.onUpdate = null
        // 退出时不能把适配器留在监听模式 —— 那会让后续所有 AT 命令都收不到响应
        CanSniffer.stop()
    }

    private fun describe(s: CanSniffer.Status): String = when (s.phase) {
        CanSniffer.Phase.IDLE ->
            "未开始。探测期间会暂停轮询引擎，并临时打开 ATH1（带 CAN 头）。\n" +
                "只记录**变化了的**数据，重复帧只计数 —— 防止总线流量把内存和存储撑爆。"
        CanSniffer.Phase.PREPARING -> s.message
        CanSniffer.Phase.CAPTURING ->
            "监听中… ${s.elapsedMs / 1000}s · ${s.frameCount} 帧 / ${s.idCount} 个 ID" +
                if (s.dropped > 0) " · 原始流已丢弃 ${s.dropped} 条" else ""
        CanSniffer.Phase.FINISHING -> s.message
        CanSniffer.Phase.DONE -> s.message + "\n按出现次数排序。次数高但「变化次数」低的 ID 通常是周期性心跳。"
        CanSniffer.Phase.FAILED -> s.message
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
            CanSniffer.start(sec * 1000L)
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
