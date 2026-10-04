package com.icar.obd.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.CompareOp
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.Rule
import com.icar.obd.data.RuleAction
import com.icar.obd.data.RuleCondition
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.RuleEngine
import java.util.UUID

/**
 * 事件规则编辑器。
 *
 * 界面直接对应「当…持续…则…」三段式，与 [RuleEngine] 的执行语义一一对应：
 *   - 条件：数据源 + 操作符 + 阈值（多条件可用 AND/OR 组合）
 *   - 持续：条件需要连续成立多久才触发（防抖，避免瞬时抖动误报）
 *   - 动作：播放音效 / 弹提示 / 记日志 / 仪表变色 / 振动 / 通知
 *
 * 「转向灯音效」就是：数据源=左转向信号，操作符=等于，阈值=1，冷却=450ms，动作=播放 tick_left。
 * 想改成「车速>100 且 水温>105 报警」，只是把这两行条件加进去而已。
 */
class RuleEditorActivity : AppCompatActivity() {

    private lateinit var etName: EditText
    private lateinit var swEnabled: MaterialSwitch
    private lateinit var spLogic: Spinner
    private lateinit var etDuration: EditText
    private lateinit var etCooldown: EditText
    private lateinit var condContainer: LinearLayout
    private lateinit var actionContainer: LinearLayout
    private lateinit var tvPreview: TextView
    private lateinit var tvTestResult: TextView

    private var editing: Rule? = null

    /** 当前可选的数据源（内置 + 自定义全部 PID） */
    private var pidList: List<PidDefinition> = emptyList()
    private val opList = CompareOp.entries.toList()

    private val actionTypes = listOf(
        "sound" to "播放音效",
        "toast" to "弹出提示",
        "log" to "记录日志",
        "gauge" to "仪表变色",
        "vibrate" to "振动",
        "notify" to "系统通知"
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_rule_editor)

        etName = findViewById(R.id.etName)
        swEnabled = findViewById(R.id.swEnabled)
        spLogic = findViewById(R.id.spLogic)
        etDuration = findViewById(R.id.etDuration)
        etCooldown = findViewById(R.id.etCooldown)
        condContainer = findViewById(R.id.condContainer)
        actionContainer = findViewById(R.id.actionContainer)
        tvPreview = findViewById(R.id.tvPreview)
        tvTestResult = findViewById(R.id.tvTestResult)

        pidList = Store.allPids()
        spLogic.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            listOf("AND（全部满足）", "OR（任一满足）")
        )

        val id = intent.getStringExtra(EXTRA_ID)
        val rule = id?.let { rid -> Store.rules.firstOrNull { it.id == rid } }

        if (rule != null) {
            editing = rule
            etName.setText(rule.name)
            swEnabled.isChecked = rule.enabled
            spLogic.setSelection(if (rule.logic.equals("OR", true)) 1 else 0)
            etDuration.setText(rule.durationMs.toString())
            etCooldown.setText(rule.cooldownMs.toString())
            rule.conditions.forEach { addConditionRow(it) }
            rule.actions.forEach { addActionRow(it) }
            title = "编辑规则"
        } else {
            etName.setText("")
            swEnabled.isChecked = true
            spLogic.setSelection(0)
            etDuration.setText("0")
            etCooldown.setText("5000")
            addConditionRow(RuleCondition())
            addActionRow(RuleAction("sound", "beep"))
            title = "新增规则"
        }

        findViewById<MaterialButton>(R.id.btnAddCond).setOnClickListener { addConditionRow(RuleCondition()) }
        findViewById<MaterialButton>(R.id.btnAddAction).setOnClickListener { addActionRow(RuleAction()) }
        findViewById<MaterialButton>(R.id.btnSave).setOnClickListener { save() }
        findViewById<MaterialButton>(R.id.btnDelete).setOnClickListener { confirmDelete() }
        findViewById<MaterialButton>(R.id.btnTestNow).setOnClickListener { testNow() }

        updatePreview()
    }

    // ------------------------------------------------------------ 条件行

    private fun addConditionRow(c: RuleCondition) {
        val row = LayoutInflater.from(this).inflate(R.layout.row_condition, condContainer, false)
        val spSource = row.findViewById<Spinner>(R.id.spSource)
        val spOp = row.findViewById<Spinner>(R.id.spOp)
        val etThreshold = row.findViewById<EditText>(R.id.etThreshold)
        val btnRemove = row.findViewById<MaterialButton>(R.id.btnRemove)

        val labels = pidList.map { "${it.name}  [${it.requestString()}]" }
        spSource.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            labels.ifEmpty { listOf("(无可用通道)") }
        )
        spOp.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            opList.map { "${it.symbol} ${it.label}" }
        )

        val srcIdx = pidList.indexOfFirst { it.id == c.sourceId }
        if (srcIdx >= 0) spSource.setSelection(srcIdx)
        val opIdx = opList.indexOfFirst { it.symbol == c.op }
        if (opIdx >= 0) spOp.setSelection(opIdx)
        etThreshold.setText(if (c.threshold == 0f) "" else fmt(c.threshold))

        btnRemove.setOnClickListener {
            condContainer.removeView(row)
            updatePreview()
        }
        // 任意变化都刷新预览，让用户立刻看到「这条规则到底是什么意思」
        spSource.setOnItemSelectedListener(PreviewWatcher())
        spOp.setOnItemSelectedListener(PreviewWatcher())
        etThreshold.addTextChangedListener(SimpleWatcher { updatePreview() })

        condContainer.addView(row)
        updatePreview()
    }

    // ------------------------------------------------------------ 动作行

    private fun addActionRow(a: RuleAction) {
        val row = LayoutInflater.from(this).inflate(R.layout.row_action, actionContainer, false)
        val spType = row.findViewById<Spinner>(R.id.spType)
        val etP1 = row.findViewById<EditText>(R.id.etP1)
        val etP2 = row.findViewById<EditText>(R.id.etP2)
        val btnRemove = row.findViewById<MaterialButton>(R.id.btnRemove)

        spType.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            actionTypes.map { "${it.first} · ${it.second}" }
        )
        val tIdx = actionTypes.indexOfFirst { it.first == a.type }
        if (tIdx >= 0) spType.setSelection(tIdx)
        etP1.setText(a.p1)
        etP2.setText(a.p2)
        updateActionHints(spType.selectedItemPosition, etP1, etP2)

        spType.setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                updateActionHints(pos, etP1, etP2)
                updatePreview()
            }
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        })
        btnRemove.setOnClickListener {
            actionContainer.removeView(row)
            updatePreview()
        }
        etP1.addTextChangedListener(SimpleWatcher { updatePreview() })
        etP2.addTextChangedListener(SimpleWatcher { updatePreview() })

        actionContainer.addView(row)
        updatePreview()
    }

    private fun updateActionHints(pos: Int, p1: EditText, p2: EditText) {
        when (actionTypes.getOrNull(pos)?.first) {
            "sound" -> {
                p1.hint = "音效名：tick_left/tick_right/warn/beep"
                p2.hint = "(不用)"
                if (p1.text.isBlank()) p1.setText("warn")
            }
            "toast", "log", "notify" -> {
                p1.hint = "文本内容"
                p2.hint = "(不用)"
            }
            "gauge" -> {
                p1.hint = "PID id（空=条件源）"
                p2.hint = "颜色 red/green/yellow/blue"
                if (p2.text.isBlank()) p2.setText("red")
            }
            "vibrate" -> {
                p1.hint = "时长 ms"
                p2.hint = "(不用)"
                if (p1.text.isBlank()) p1.setText("300")
            }
        }
    }

    // ------------------------------------------------------------ 读取 / 预览

    private fun readConditions(): MutableList<RuleCondition> {
        val out = mutableListOf<RuleCondition>()
        for (i in 0 until condContainer.childCount) {
            val row = condContainer.getChildAt(i)
            val spSource = row.findViewById<Spinner>(R.id.spSource)
            val spOp = row.findViewById<Spinner>(R.id.spOp)
            val et = row.findViewById<EditText>(R.id.etThreshold)
            val srcIdx = spSource.selectedItemPosition
            val opIdx = spOp.selectedItemPosition
            out.add(
                RuleCondition(
                    sourceId = pidList.getOrNull(srcIdx)?.id ?: "",
                    op = opList.getOrNull(opIdx)?.symbol ?: ">",
                    threshold = et.text.toString().toFloatOrNull() ?: 0f
                )
            )
        }
        return out
    }

    private fun readActions(): MutableList<RuleAction> {
        val out = mutableListOf<RuleAction>()
        for (i in 0 until actionContainer.childCount) {
            val row = actionContainer.getChildAt(i)
            val spType = row.findViewById<Spinner>(R.id.spType)
            val p1 = row.findViewById<EditText>(R.id.etP1).text.toString()
            val p2 = row.findViewById<EditText>(R.id.etP2).text.toString()
            out.add(
                RuleAction(
                    type = actionTypes.getOrNull(spType.selectedItemPosition)?.first ?: "toast",
                    p1 = p1, p2 = p2
                )
            )
        }
        return out
    }

    private fun collect(): Rule = Rule(
        id = editing?.id ?: UUID.randomUUID().toString(),
        name = etName.text.toString().trim(),
        enabled = swEnabled.isChecked,
        logic = if (spLogic.selectedItemPosition == 1) "OR" else "AND",
        conditions = readConditions(),
        durationMs = etDuration.text.toString().toLongOrNull() ?: 0L,
        actions = readActions(),
        cooldownMs = etCooldown.text.toString().toLongOrNull() ?: 5000L
    )

    private fun updatePreview() {
        runCatching { tvPreview.text = "预览：\n" + RuleEngine.describeRule(collect()) }
            .onFailure { tvPreview.text = "预览：${it.message}" }
    }

    private fun testNow() {
        val r = collect()
        if (!ObdController.engine.running) {
            tvTestResult.text = "轮询未运行，请先连接并初始化设备"
            return
        }
        val ok = RuleEngine.testRuleOnce(r)
        val detail = r.conditions.joinToString("\n") { c ->
            val v = com.icar.obd.obd.VehicleBus.value(c.sourceId)
            "  ${RuleEngine.describeCondition(c)}  →  当前值 ${v?.let { fmt(it) } ?: "无数据"}"
        }
        tvTestResult.text = if (ok) "当前条件下：成立 ✓\n$detail" else "当前条件下：不成立\n$detail"
        AppLog.i(AppLog.M_UI, "规则试判", "name=${r.name} result=$ok")
    }

    // ------------------------------------------------------------ 保存 / 删除

    private fun save() {
        val r = collect()
        if (r.name.isBlank()) {
            ObdController.toast("请填写规则名称")
            return
        }
        if (r.conditions.isEmpty() || r.conditions.any { it.sourceId.isBlank() }) {
            ObdController.toast("请至少配置一个有效条件")
            return
        }
        if (r.actions.isEmpty()) {
            ObdController.toast("请至少配置一个动作")
            return
        }
        Store.upsertRule(r)
        ObdController.reloadRules()
        AppLog.i(AppLog.M_UI, "规则已保存", RuleEngine.describeRule(r))
        ObdController.toast("已保存")
        finish()
    }

    private fun confirmDelete() {
        val r = editing ?: return
        AlertDialog.Builder(this)
            .setTitle("删除规则")
            .setMessage("确定删除「${r.name}」？")
            .setPositiveButton("删除") { _, _ ->
                Store.deleteRule(r.id)
                ObdController.reloadRules()
                finish()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun fmt(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else String.format("%.2f", f)

    /** Spinner 选中即刷新预览 */
    private inner class PreviewWatcher : android.widget.AdapterView.OnItemSelectedListener {
        override fun onItemSelected(p: android.widget.AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) = updatePreview()
        override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
    }

    private class SimpleWatcher(val cb: () -> Unit) : android.text.TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        override fun afterTextChanged(s: android.text.Editable?) = cb()
    }

    companion object {
        const val EXTRA_ID = "rule_id"
    }
}
