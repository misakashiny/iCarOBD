package com.icar.obd.ui

import android.os.Bundle
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.DashLayout
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.view.DashCanvasEditorView
import com.icar.obd.ui.view.GaugeTheme

/**
 * 拖拽式仪表盘编辑器。
 *
 * 交互：**点选 → 拖动移动 → 右下角方块缩放**，坐标自动吸附到 1/24 网格。
 * 点「属性」打开字段对话框改通道/样式/量程/报警值。
 *
 * ## 为什么不再用列表式编辑器（v1.4.0 及以前）
 *
 * 那时布局是 2/3/4 列网格 + `span` 跨列，仪表**不能任意摆放**，
 * 也就做不出「线型图占上半屏、四数据挤右下角」这类布局。
 * 现在 [GaugeItem] 自带归一化 `x/y/w/h`，画布所见即所得。
 *
 * ## 保存策略
 *
 * 画布直接持有 [Store.customGauges] 里的**同一批 GaugeItem 实例**（拖动改的就是它们），
 * 所以「保存」只需把画布的顺序回写。另外 [onPause] 时会自动保存一次，
 * 避免直接返回丢掉改动。
 */
class DashEditorActivity : AppCompatActivity() {

    private lateinit var canvas: DashCanvasEditorView
    private lateinit var tvHint: TextView
    private lateinit var btnSnap: MaterialButton
    private var dirty = false

    /** 霓虹档位。第 0 项是"跟随主题"，与 GaugeItem.neonPreset = null 对应 */
    private val neonNames = listOf("跟随主题") + com.icar.obd.ui.view.NeonStyle.PRESETS.map { it.first }

    private val styleNames = listOf(
        "圆形指针表", "数字大屏", "横向条形",
        "线型图", "双数据 + 上下", "四数据显示", "主 + 子双数据", "G力值"
    )
    private val spanNames = listOf("半宽（并排两个）", "整行（独占一行）")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_dash_editor)

        canvas = findViewById(R.id.editorCanvas)
        tvHint = findViewById(R.id.tvEditorHint)

        canvas.onChange = { dirty = true; updateHint() }
        canvas.onSelect = { updateHint() }

        findViewById<MaterialButton>(R.id.btnAdd).setOnClickListener { showEditDialog(-1) }
        findViewById<MaterialButton>(R.id.btnEditGauge).setOnClickListener {
            if (canvas.selected < 0) ObdController.toast("先点选一个仪表") else showEditDialog(canvas.selected)
        }
        findViewById<MaterialButton>(R.id.btnDeleteGauge).setOnClickListener {
            if (canvas.selected < 0) ObdController.toast("先点选一个仪表") else canvas.removeSelected()
        }
        findViewById<MaterialButton>(R.id.btnPreset).setOnClickListener { showPresetPicker() }
        findViewById<MaterialButton>(R.id.btnFrontGauge).setOnClickListener {
            if (canvas.selected < 0) ObdController.toast("先点选一个仪表") else canvas.bringSelectedToFront()
        }
        findViewById<MaterialButton>(R.id.btnGrid).setOnClickListener { toggleGrid() }
        btnSnap = findViewById(R.id.btnSnap)
        btnSnap.setOnClickListener { toggleSnap() }
        findViewById<MaterialButton>(R.id.btnSave).setOnClickListener { save(true) }

        reload()
    }

    override fun onPause() {
        super.onPause()
        // 直接返回时别把改动丢了
        if (dirty) save(false)
    }

    // ---------------------------------------------------------------- 基础

    private fun reload() {
        val theme = GaugeTheme.of(Store.settings.gaugeTheme)
        canvas.submit(Store.customGauges.toList(), theme, Store.settings.gridEnabled)
        // 吸附开关是持久设置，每次进来都要灌给画布（否则默认值会盖掉用户的选择）
        canvas.setSnapEnabled(Store.settings.dashSnapEnabled)
        refreshSnapButton()
        dirty = false
        updateHint()
    }

    private fun toggleSnap() {
        Store.settings.dashSnapEnabled = !Store.settings.dashSnapEnabled
        Store.saveSettings()
        canvas.setSnapEnabled(Store.settings.dashSnapEnabled)
        refreshSnapButton()
        updateHint()
    }

    /** 按钮文字直接显示当前状态 —— 比一个只有按下才知道状态的开关清楚 */
    private fun refreshSnapButton() {
        btnSnap.text = if (Store.settings.dashSnapEnabled) "吸附开" else "吸附关"
    }

    private fun updateHint() {
        val sel = canvas.selectedItem()
        val snap = if (Store.settings.dashSnapEnabled) {
            "坐标吸附到 1/24 网格（每格 ${"%.0f".format(com.icar.obd.data.DashLayout.Drag.STEP)} 单位）"
        } else {
            "自由摆放（吸附已关，可停在任意坐标）"
        }
        tvHint.text = if (sel == null) {
            "还没有仪表，点「添加」开始 · 拖动移动，右下角方块缩放 · $snap"
        } else {
            val name = Store.findPid(sel.pidId)?.name ?: "未绑定"
            val style = styleNames.getOrElse(sel.style) { "样式${sel.style}" }
            "已选：$name · $style · ${(sel.w / GaugeItem.CANVAS * 100).toInt()}% × ${(sel.h / GaugeItem.CANVAS * 100).toInt()}% · $snap"
        }
    }

    private fun toggleGrid() {
        Store.settings.gridEnabled = !Store.settings.gridEnabled
        Store.saveSettings()
        canvas.setGridVisible(Store.settings.gridEnabled)
        ObdController.toast(if (Store.settings.gridEnabled) "参考线已开" else "参考线已关")
    }

    private fun save(showToast: Boolean) {
        Store.customGauges.clear()
        Store.customGauges.addAll(canvas.currentItems())
        Store.saveDash()
        dirty = false
        if (showToast) ObdController.toast("布局已保存（${Store.customGauges.size} 个仪表）")
        AppLog.i(AppLog.M_UI, "仪表布局已保存", "count=${Store.customGauges.size}")
    }

    private fun showPresetPicker() {
        val presets = DashLayout.presets()
        AlertDialog.Builder(this)
            .setTitle("套用预设布局")
            .setMessage("会覆盖当前画布内容（未保存的改动将丢失）")
            .setItems(presets.map { "${it.title} —— ${it.description}" }.toTypedArray()) { _, which ->
                Store.customGauges.clear()
                Store.customGauges.addAll(presets[which].build())
                Store.saveDash()
                reload()
                ObdController.toast("已套用：${presets[which].title}")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 新增仪表的初始位置：从现有内容最底部往下排一条整宽。
     *
     * 只是「别叠在一起」的兜底 —— 真正的摆放靠拖拽。
     * 画布放满时回落到顶部半宽（会重叠，拖开即可）。
     */
    private fun nextSlot(): FloatArray {
        val bottom = canvas.currentItems().maxOfOrNull { (it.y + it.h).coerceIn(0f, GaugeItem.CANVAS) } ?: 0f
        val h = 0.25f
        return if (bottom + h <= 1.0001f) floatArrayOf(0f, bottom, 1f, h)
        else floatArrayOf(0f, 0f, 0.5f, 0.25f)
    }

    // ---------------------------------------------------------------- 字段对话框

    private fun showEditDialog(index: Int) {
        val existing: GaugeItem? = if (index >= 0) canvas.itemAt(index) else null
        val pids: List<PidDefinition> = Store.allPids()
        if (pids.isEmpty()) {
            ObdController.toast("没有可用通道，请先添加 PID")
            return
        }

        val view = layoutInflater.inflate(R.layout.dialog_gauge_edit, null)
        val spPid = view.findViewById<Spinner>(R.id.spPid)
        val spStyle = view.findViewById<Spinner>(R.id.spStyle)
        val spSpan = view.findViewById<Spinner>(R.id.spSpan)
    val spNeon = view.findViewById<Spinner>(R.id.spNeon)
        val spCard = view.findViewById<Spinner>(R.id.spCard)
        val etMin = view.findViewById<EditText>(R.id.etMin)
        val etMax = view.findViewById<EditText>(R.id.etMax)
        val etWarnLow = view.findViewById<EditText>(R.id.etWarnLow)
        val etWarnHigh = view.findViewById<EditText>(R.id.etWarnHigh)

        spPid.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            pids.map { "${it.name}  [${it.requestString()}]${if (it.unit.isBlank()) "" else "  ${it.unit}"}" }
        )
        spStyle.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, styleNames)
        spSpan.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, spanNames)
        // 第 0 项是"跟随主题"（neonPreset = null），后面才是具体档位
        spNeon.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, neonNames)
        // 卡片外框：0..3 与 GaugeItem.CARD_* 一一对应，所以下标就是取值
        spCard.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item, GaugeItem.CARD_NAMES
        )

        // 选通道时自动带入建议量程，减少手工输入
        spPid.setOnItemSelectedListener(object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                if (existing != null && existing.pidId == pids[pos].id) return
                val pid = pids[pos]
                etMin.setText(fmt(pid.minVal))
                etMax.setText(fmt(pid.maxVal))
                etWarnLow.setText(pid.warnLow?.let { fmt(it) } ?: "")
                etWarnHigh.setText(pid.warnHigh?.let { fmt(it) } ?: "")
            }

            override fun onNothingSelected(p: AdapterView<*>?) {}
        })

        if (existing != null) {
            val pi = pids.indexOfFirst { it.id == existing.pidId }
            if (pi >= 0) spPid.setSelection(pi)
            spStyle.setSelection(existing.style.coerceIn(0, styleNames.lastIndex))
            spSpan.setSelection(if (existing.w >= 0.75f * GaugeItem.CANVAS) 1 else 0)
        // 已有预设 → 下标 +1（跳过"跟随主题"）；null → 0
        spNeon.setSelection(
            existing.neonPreset?.let { p -> neonNames.indexOf(p).takeIf { it > 0 } } ?: 0
        )
        // 卡片覆盖：null → 0（跟随主题），否则直接是 CARD_* 取值
        spCard.setSelection((existing.cardStyle ?: GaugeItem.CARD_THEME).coerceIn(0, GaugeItem.CARD_NAMES.lastIndex))
            etMin.setText(fmt(existing.minVal))
            etMax.setText(fmt(existing.maxVal))
            etWarnLow.setText(existing.warnLow?.let { fmt(it) } ?: "")
            etWarnHigh.setText(existing.warnHigh?.let { fmt(it) } ?: "")
        }

        AlertDialog.Builder(this)
            .setTitle(if (existing == null) "添加仪表" else "编辑仪表")
            .setView(view)
            .setPositiveButton("确定") { _, _ ->
                val pid = pids[spPid.selectedItemPosition.coerceIn(0, pids.size - 1)]
                val style = spStyle.selectedItemPosition.coerceIn(0, styleNames.lastIndex)
                val minV = etMin.text.toString().toFloatOrNull() ?: pid.minVal
                val maxV = etMax.text.toString().toFloatOrNull() ?: pid.maxVal
                val wl = etWarnLow.text.toString().toFloatOrNull()
                val wh = etWarnHigh.text.toString().toFloatOrNull()
                val full = spSpan.selectedItemPosition == 1
        // 0 = 跟随主题（存 null）
        val neonIdx = spNeon.selectedItemPosition
        val neon = if (neonIdx <= 0) null else neonNames.getOrNull(neonIdx)
        // 0 = 跟随主题（存 null），否则直接是 CARD_* 取值
        val cardIdx = spCard.selectedItemPosition
        val card = if (cardIdx <= 0) null else cardIdx

                if (existing != null) {
                    // 就地改，**保留自由坐标 / 副参数 / 指针环** ——
                    // 每次编辑都重建对象会把位置重置回左上角
                    existing.pidId = pid.id
                    existing.style = style
                    existing.minVal = minV
                    existing.maxVal = maxV
                    existing.warnLow = wl
                    existing.warnHigh = wh
                    existing.neonPreset = neon
                    existing.cardStyle = card
                    canvas.refresh()
                } else {
                    val slot = nextSlot()
                    canvas.add(
                        GaugeItem(
                            pidId = pid.id,
                            style = style,
                            minVal = minV,
                            maxVal = maxV,
                            warnLow = wl,
                            warnHigh = wh,
                            span = if (full) 2 else 1,
                            x = slot[0], y = slot[1],
                            neonPreset = neon,
                            cardStyle = card,
                            // 「半宽/整行」决定初始宽度，之后可以拖角自由缩放。
                            // ⚠️ 必须用画布单位（0..CANVAS）—— 坐标迁移时这里漏改了，
                            // 归一化的 0.5 在 360 单位下只有 0.14% 宽，新加的仪表会是一条缝
                            w = if (full) GaugeItem.CANVAS else GaugeItem.CANVAS * 0.5f,
                            h = slot[3]
                        )
                    )
                }
                dirty = true
                AppLog.i(AppLog.M_UI, "仪表已编辑", "pid=${pid.name} style=$style")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun fmt(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else f.toString()
}
