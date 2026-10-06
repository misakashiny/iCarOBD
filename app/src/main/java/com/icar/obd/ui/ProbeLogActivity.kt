package com.icar.obd.ui

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.icar.obd.data.AppLog
import com.icar.obd.data.ProbeLog
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 探测记录（v1.19.22）：翻看「PID 探测」与「CAN 探测」的历史结论。
 *
 * ## 为什么不做成 RecyclerView + 布局文件
 *
 * 这里最多 [ProbeLog.MAX_ENTRIES] 条、每行就是一个 TextView ——
 * 为它加一套 adapter + item 布局，代码量比收益大。
 * **用代码建**还能顺带避免"新布局没进 git / 行高约束"这类小事。
 *
 * 界面：`[标题 共N条]  [导出] [清空]` + 可滚动的记录列表；
 * 点某条弹详情（明细是探测报告全文，列表里放不下）。
 */
class ProbeLogActivity : AppCompatActivity() {

    private lateinit var list: LinearLayout
    private lateinit var tvCount: TextView

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0B0E13.toInt())
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }

        // ---- 顶栏 ----
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        bar.addView(TextView(this).apply {
            text = "探测记录"
            setTextColor(0xFFE6EDF3.toInt())
            textSize = 18f
        })
        tvCount = TextView(this).apply {
            setTextColor(0xFF8B98A5.toInt())
            textSize = 12f
            setPadding(dp(10), 0, 0, 0)
        }
        bar.addView(tvCount)
        bar.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))   // 弹性空白推右
        bar.addView(btn("导出") { export() })
        bar.addView(btn("清空") { confirmClear() })
        root.addView(bar)

        root.addView(TextView(this).apply {
            text = "点条目看明细。只留最近 ${ProbeLog.MAX_ENTRIES} 条，超出丢最旧的。"
            setTextColor(0xFF8B98A5.toInt())
            textSize = 11f
            setPadding(0, dp(4), 0, dp(8))
        })

        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(
            ScrollView(this).apply { addView(list) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        )

        setContentView(root)
        refresh()
    }

    private fun refresh() {
        tvCount.text = "共 ${ProbeLog.count()} 条"
        list.removeAllViews()
        val all = ProbeLog.all()
        if (all.isEmpty()) {
            list.addView(TextView(this).apply {
                text = "还没有记录。\n做一次「PID 探测」或「CAN 探测」就会自动记在这里。"
                setTextColor(0xFF8B98A5.toInt())
                textSize = 13f
                setPadding(0, dp(20), 0, 0)
            })
            return
        }
        all.forEach { e ->
            val isPid = e.kind == ProbeLog.KIND_PID
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(10), dp(8), dp(10), dp(8))
                setBackgroundColor(0xFF141A22.toInt())
                setOnClickListener { showDetail(e) }
            }
            row.addView(TextView(this).apply {
                text = "${if (isPid) "PID" else "CAN"} · ${fmt.format(Date(e.time))}"
                setTextColor(if (isPid) 0xFF4DA3FF.toInt() else 0xFFFFD400.toInt())
                textSize = 11f
            })
            row.addView(TextView(this).apply {
                text = e.title
                setTextColor(0xFFE6EDF3.toInt())
                textSize = 13f
                setPadding(0, dp(2), 0, 0)
            })
            list.addView(row, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(6) })
        }
    }

    private fun showDetail(e: ProbeLog.Entry) {
        AlertDialog.Builder(this)
            .setTitle(e.title)
            .setMessage(e.detail.ifBlank { "(无明细)" })
            .setPositiveButton("关闭", null)
            .show()
    }

    /** 导出成文本，走「导出」目录 + FileProvider 分享（与扫描器导出同一套路） */
    private fun export() {
        val all = ProbeLog.all()
        if (all.isEmpty()) {
            ObdControllerToast.show(this, "没有可导出的记录")
            return
        }
        val sb = StringBuilder("iCar OBD · 探测记录\n共 ${all.size} 条\n\n")
        all.forEach { e ->
            sb.append("── ${if (e.kind == ProbeLog.KIND_PID) "PID 探测" else "CAN 探测"} · ")
                .append(fmt.format(Date(e.time))).append(" ──\n")
                .append(e.title).append('\n')
            if (e.detail.isNotBlank()) sb.append(e.detail).append('\n')
            sb.append('\n')
        }
        val dir = java.io.File(getExternalFilesDir(null), "export").apply { mkdirs() }
        val f = java.io.File(dir, "probe-log-${System.currentTimeMillis()}.txt")
        runCatching { f.writeText(sb.toString()) }
            .onSuccess {
                AppLog.i(AppLog.M_UI, "探测记录已导出", f.name)
                ObdControllerToast.show(this, "已导出：${f.name}")
            }
            .onFailure { ObdControllerToast.show(this, "导出失败：${it.message}") }
    }

    private fun confirmClear() {
        AlertDialog.Builder(this)
            .setTitle("清空探测记录")
            .setMessage("确定清空全部 ${ProbeLog.count()} 条？清掉就找不回来了。")
            .setPositiveButton("清空") { _, _ -> ProbeLog.clear(); refresh() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun btn(text: String, onClick: () -> Unit) = MaterialButton(this).apply {
        this.text = text
        textSize = 12f
        minWidth = 0
        minimumWidth = 0
        setPadding(dp(10), 0, dp(10), 0)
        setOnClickListener { onClick() }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}

/** 小工具：本页只用到一句 toast，不值得为它引入整个控制器 */
private object ObdControllerToast {
    fun show(ctx: android.content.Context, msg: String) {
        android.widget.Toast.makeText(ctx, msg, android.widget.Toast.LENGTH_SHORT).show()
    }
}
