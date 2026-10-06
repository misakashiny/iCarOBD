package com.icar.obd.ui

import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.icar.obd.data.AppLog
import com.icar.obd.data.ProbeLog
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max

/**
 * 探测记录（v1.19.22 起；v1.19.23 重做 UI）。
 *
 * ## 这一版为什么重做
 *
 * 用户反馈两条：
 *  1. **UI 不太行** —— 原来是一长条平铺，PID 和 CAN 混在一起
 *  2. **记录得太少** —— 明细被截断（CAN 只留 60 行），而一次探测看到几百个 ID 很正常
 *
 * 所以：**两个页签（PID / CAN）+ 分页**，明细不再截断。
 *
 * ## 分页参数为什么是 20
 *
 * 一屏大约放得下 12~15 行；20 是"翻一页不至于只剩两行"和
 * "一页别长到要滑很久"之间的折中。条目本身很轻（一行标题），
 * 所以 20 条一次性建 View 也不卡。
 */
class ProbeLogActivity : AppCompatActivity() {

    private companion object {
        const val PER_PAGE = 20
    }

    private var kind = ProbeLog.KIND_PID
    private var page = 0

    private lateinit var list: LinearLayout
    private lateinit var tvCount: TextView
    private lateinit var tabPid: MaterialButton
    private lateinit var tabCan: MaterialButton
    private lateinit var tvPage: TextView
    private lateinit var btnPrev: MaterialButton
    private lateinit var btnNext: MaterialButton

    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0B0E13.toInt())
            setPadding(dp(12), dp(12), dp(12), dp(8))
        }

        // ---- ① 标题行 ----
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        bar.addView(TextView(this).apply {
            text = "探测记录"; setTextColor(0xFFE6EDF3.toInt()); textSize = 18f
        })
        tvCount = TextView(this).apply {
            setTextColor(0xFF8B98A5.toInt()); textSize = 12f; setPadding(dp(10), 0, 0, 0)
        }
        bar.addView(tvCount)
        bar.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        bar.addView(btn("导出") { export() })
        bar.addView(btn("清空本页签") { confirmClear() })
        root.addView(bar)

        // ---- ② 页签（PID / CAN 各一页）----
        val tabs = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, dp(6))
        }
        tabPid = tab("PID 探测") { kind = ProbeLog.KIND_PID; page = 0; refresh() }
        tabCan = tab("CAN 探测") { kind = ProbeLog.KIND_CAN; page = 0; refresh() }
        tabs.addView(tabPid, LinearLayout.LayoutParams(0, dp(40), 1f))
        tabs.addView(tabCan, LinearLayout.LayoutParams(0, dp(40), 1f).apply { marginStart = dp(6) })
        root.addView(tabs)

        // ---- ③ 列表 ----
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(
            ScrollView(this).apply { addView(list) },
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
        )

        // ---- ④ 翻页 ----
        val pager = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, 0)
        }
        btnPrev = btn("‹ 上一页") { if (page > 0) { page--; refresh() } }
        btnNext = btn("下一页 ›") { if (page < pageCount() - 1) { page++; refresh() } }
        tvPage = TextView(this).apply {
            setTextColor(0xFF8B98A5.toInt()); textSize = 12f
            gravity = Gravity.CENTER
        }
        pager.addView(btnPrev)
        pager.addView(tvPage, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        pager.addView(btnNext)
        root.addView(pager)

        setContentView(root)
        refresh()
    }

    // ---------------------------------------------------------------- 数据

    private fun filtered() = ProbeLog.all().filter { it.kind == kind }

    private fun pageCount(): Int = max(1, (filtered().size + PER_PAGE - 1) / PER_PAGE)

    private fun refresh() {
        val pidN = ProbeLog.all().count { it.kind == ProbeLog.KIND_PID }
        val canN = ProbeLog.all().count { it.kind == ProbeLog.KIND_CAN }
        tabPid.text = "PID 探测 ($pidN)"
        tabCan.text = "CAN 探测 ($canN)"
        // 当前页签高亮（用 alpha 区分：选中=不透明）
        tabPid.alpha = if (kind == ProbeLog.KIND_PID) 1f else 0.45f
        tabCan.alpha = if (kind == ProbeLog.KIND_CAN) 1f else 0.45f
        tvCount.text = "共 ${ProbeLog.count()} 条"

        val all = filtered()
        val pages = pageCount()
        if (page >= pages) page = pages - 1
        if (page < 0) page = 0

        list.removeAllViews()
        if (all.isEmpty()) {
            list.addView(TextView(this).apply {
                text = if (kind == ProbeLog.KIND_PID)
                    "还没有 PID 探测记录。\n在「PID」页点「PID 探测」跑一次就会记在这里。"
                else
                    "还没有 CAN 探测记录。\n在「CAN 探测」页跑一次就会记在这里。"
                setTextColor(0xFF8B98A5.toInt()); textSize = 13f; setPadding(0, dp(20), 0, 0)
            })
        } else {
            all.drop(page * PER_PAGE).take(PER_PAGE).forEach { e ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(10), dp(8), dp(10), dp(8))
                    setBackgroundColor(0xFF141A22.toInt())
                    setOnClickListener { showDetail(e) }
                }
                row.addView(TextView(this).apply {
                    text = fmt.format(Date(e.time)) +
                        "   ·   ${e.detail.lineSequence().count()} 行明细"
                    setTextColor(0xFF8B98A5.toInt()); textSize = 11f
                })
                row.addView(TextView(this).apply {
                    text = e.title
                    setTextColor(0xFFE6EDF3.toInt()); textSize = 13f
                    setPadding(0, dp(2), 0, 0)
                })
                list.addView(row, LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { bottomMargin = dp(6) })
            }
        }

        tvPage.text = "第 ${page + 1} / $pages 页"
        btnPrev.isEnabled = page > 0
        btnNext.isEnabled = page < pages - 1
        btnPrev.alpha = if (btnPrev.isEnabled) 1f else 0.35f
        btnNext.alpha = if (btnNext.isEnabled) 1f else 0.35f
    }

    private fun showDetail(e: ProbeLog.Entry) {
        // 明细可能几百行 —— 用可滚动的内容，别让 AlertDialog 自己截断
        val tv = TextView(this).apply {
            text = e.detail.ifBlank { "(无明细)" }
            textSize = 11f
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setTextIsSelectable(true)   // 允许复制某一行（比如某个 PID）
        }
        val scroll = ScrollView(this).apply { addView(tv) }
        AlertDialog.Builder(this)
            .setTitle(e.title)
            .setView(scroll)
            .setPositiveButton("关闭", null)
            .show()
    }

    private fun export() {
        val all = ProbeLog.all()
        if (all.isEmpty()) { toast("没有可导出的记录"); return }
        val sb = StringBuilder("iCar OBD · 探测记录\n共 ${all.size} 条\n\n")
        all.forEach { e ->
            sb.append("── ${if (e.kind == ProbeLog.KIND_PID) "PID 探测" else "CAN 探测"} · ")
                .append(fmt.format(Date(e.time))).append(" ──\n")
                .append(e.title).append('\n')
            if (e.detail.isNotBlank()) sb.append(e.detail).append('\n')
            sb.append('\n')
        }
        val dir = File(getExternalFilesDir(null), "export").apply { mkdirs() }
        val f = File(dir, "probe-log-${System.currentTimeMillis()}.txt")
        runCatching { f.writeText(sb.toString()) }
            .onSuccess { AppLog.i(AppLog.M_UI, "探测记录已导出", f.name); toast("已导出：${f.name}") }
            .onFailure { toast("导出失败：${it.message}") }
    }

    /** 只清**当前页签** —— 用户要清 CAN 时不该顺手把 PID 也清了 */
    private fun confirmClear() {
        val n = filtered().size
        if (n == 0) { toast("本页签没有记录"); return }
        val label = if (kind == ProbeLog.KIND_PID) "PID 探测" else "CAN 探测"
        AlertDialog.Builder(this)
            .setTitle("清空 $label 记录")
            .setMessage("确定清空 $label 的 $n 条？清掉就找不回来了。")
            .setPositiveButton("清空") { _, _ -> ProbeLog.clearKind(kind); page = 0; refresh() }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 小工具

    private fun btn(text: String, onClick: () -> Unit) = MaterialButton(this).apply {
        this.text = text
        textSize = 12f
        minWidth = 0; minimumWidth = 0
        setPadding(dp(10), 0, dp(10), 0)
        setOnClickListener { onClick() }
    }

    /** 页签按钮：选中态用「填充 vs 描边」区分，比只改颜色更明显 */
    private fun tab(text: String, onClick: () -> Unit) = MaterialButton(
        this, null,
        com.google.android.material.R.attr.materialButtonOutlinedStyle
    ).apply {
        this.text = text
        textSize = 13f
        minWidth = 0; minimumWidth = 0
        setOnClickListener { onClick() }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}
