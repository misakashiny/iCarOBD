package com.icar.obd.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
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
import com.icar.obd.data.PidMerge
import com.icar.obd.data.Rule
import com.icar.obd.data.RuleAction
import com.icar.obd.data.RuleAlertRouting
import com.icar.obd.data.RuleCondition
import com.icar.obd.data.SoundPresets
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.RuleEngine
import com.icar.obd.ui.view.IslandNotice
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
 *
 * ## 动作行的三个按钮（v1.20.21，用户原话「后面也增加个播放键、显示弹出效果啥样」）
 *
 * | 按钮 | 只在哪种动作下出现 | 按下去发生什么 |
 * |---|---|---|
 * | 🎵 音效库 | `sound` | 打开 [SoundPresets.ALL] 列表（名字说人话），选中即试听 |
 * | 📁 选文件 | `sound` | SAF 挑一个自己的音频文件（v1.19.18 起） |
 * | ▶ 预览 | `sound` / `toast` / `notify` | **当场演一次**：试听 / 弹一次灵动岛 / 发一条系统通知 |
 *
 * ⚠️ 三个都**不落盘、不进规则记录、不触发别的动作**。
 * ⚠️ 灵动岛预览用的是**本 Activity 自己**的 [IslandNotice]（`MainActivity` 那个
 * 挂在别的窗口上，这里看不见），但样式与"不抢触摸"那几条约束是同一套代码。
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
    private lateinit var scrollRoot: android.widget.ScrollView

    /** 试判结果行的正常颜色（从布局读，不写死 —— 见 PidEditorActivity 的同名字段） */
    private var testColor = 0

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
        scrollRoot = findViewById(R.id.scrollRoot)
        testColor = tvTestResult.currentTextColor

        pidList = Store.allPids()
        spLogic.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            listOf("AND（全部满足）", "OR（任一满足）")
        )

        val id = intent.getStringExtra(EXTRA_ID)
        val rule = id?.let { rid -> Store.rules.firstOrNull { it.id == rid } }

        // ⚠️ 列表里把"已合并的同义条目"收起来（v1.20.13，见 data/PidMerge.kt），
        // 但**这条规则当前绑的 id 必须保留** —— `addConditionRow` 的
        // `indexOfFirst` 找不到时 spinner 停在 0 号（发动机转速），保存时
        // 会把条件**静默改成转速**（老规则变样，用户不会想到是列表过滤干的）。
        pidList = PidMerge.filterForList(
            pidList, rule?.conditions?.map { it.sourceId } ?: emptyList()
        )

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
        // v1.19.19：模拟测试 —— **先保存再模拟**。
        // 为什么必须先保存：模拟是按 **规则 id** 跑的，而引擎读的是 Store 里的规则。
        // 不保存就模拟，跑的是**上一次保存的版本**（用户改了阈值却按旧值跑，
        // 而且现象上完全看不出）—— 这类"看起来生效其实没有"的坑本项目踩过多次。
        findViewById<MaterialButton>(R.id.btnSimulate).setOnClickListener {
            val saved = saveRule() ?: return@setOnClickListener
            ObdController.startRuleSimulation(saved.id)
            ObdController.pendingGotoDash = true
            ObdController.toast("模拟已开启：回仪表盘看效果（右下角可关闭/退出）")
            finish()
        }

        updatePreview()
    }

    /**
     * ⚠️ 必须把预览用的灵动岛收掉（v1.20.21）。
     *
     * `IslandNotice` 内部有一个 `Handler.postDelayed` 的节拍（50ms 一次，
     * 用来判"该收起了"）。Activity 销毁时不摘，那个 Runnable 会**一直**往主线程
     * 消息队列里投 —— 一个看不见的浮层 + 一条永不停止的心跳。
     * 与 `MainActivity` 里对 `island` 的处理是同一条理由。
     */
    override fun onDestroy() {
        islandPreview?.dismissNow()
        islandPreview = null
        super.onDestroy()
    }

    // ------------------------------------------------------------ 条件行

    private fun addConditionRow(c: RuleCondition) {
        val row = LayoutInflater.from(this).inflate(R.layout.row_condition, condContainer, false)
        val spSource = row.findViewById<Spinner>(R.id.spSource)
        val spOp = row.findViewById<Spinner>(R.id.spOp)
        val etThreshold = row.findViewById<EditText>(R.id.etThreshold)
        val btnRemove = row.findViewById<MaterialButton>(R.id.btnRemove)
        val btnPreview = row.findViewById<MaterialButton>(R.id.btnPreview)

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

    /** 正在等用户选音频文件的那一行（SAF 回调是异步的，得记住是谁发起的） */
    private var pendingFileRow: View? = null

    /**
     * 选一个音频文件当音效（v1.19.18）。
     *
     * 走 SAF（`OpenDocument`）而不是直接读路径：Android 10+ 的分区存储下，
     * 用户能选的文件**拿不到真实路径**，只有 `content://` URI。
     *
     * ⚠️ **必须 `takePersistableUriPermission`** —— 否则重启 App 后那个 URI
     * 就没有读权限了，规则触发时**静默不响**（用户会以为规则坏了）。
     */
    private val pickAudio = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        val row = pendingFileRow
        pendingFileRow = null
        if (uri == null || row == null) return@registerForActivityResult
        runCatching {
            contentResolver.takePersistableUriPermission(
                uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        }.onFailure { AppLog.w(AppLog.M_UI, "音频读权限持久化失败", it.message ?: "") }

        val shown = audioDisplayName(uri)
        row.tag = shown                                        // → p4
        row.findViewById<EditText>(R.id.etP1).setText(uri.toString())   // → p1（机器用）
        refreshPickButton(row.findViewById(R.id.btnPickAudio), uri.toString(), shown)
        AppLog.i(AppLog.M_UI, "已选择音频文件", "name=$shown uri=$uri")
        updatePreview()
    }

    /** 给用户看的文件名（URI 本身没法看）。三级回退见 [SafFile] */
    private fun audioDisplayName(uri: android.net.Uri): String =
        SafFile.displayName(this, uri, "自定义音频")

    /** 按钮文案：没选文件时是 📁，选了就显示文件名（让用户一眼看到选了什么） */
    private fun refreshPickButton(btn: View, spec: String, shown: String) {
        val b = btn as MaterialButton
        b.text = if (RuleAction.isAudioFileSpec(spec) && shown.isNotBlank()) shown else "📁"
    }

    private fun addActionRow(a: RuleAction) {
        val row = LayoutInflater.from(this).inflate(R.layout.row_action, actionContainer, false)
        val spType = row.findViewById<Spinner>(R.id.spType)
        val etP1 = row.findViewById<EditText>(R.id.etP1)
        val etP2 = row.findViewById<EditText>(R.id.etP2)
        val etP3 = row.findViewById<EditText>(R.id.etP3)
        val btnRemove = row.findViewById<MaterialButton>(R.id.btnRemove)
        val btnPreview = row.findViewById<MaterialButton>(R.id.btnPreview)
        val btnPickAudio = row.findViewById<MaterialButton>(R.id.btnPickAudio)
        val btnPickSound = row.findViewById<MaterialButton>(R.id.btnPickSound)

        // p4（显示名）挂在行上：p1 存的是 URI，人看不懂
        row.tag = a.p4
        refreshPickButton(btnPickAudio, a.p1, a.p4)

        spType.adapter = ArrayAdapter(
            this, android.R.layout.simple_spinner_dropdown_item,
            actionTypes.map { "${it.first} · ${it.second}" }
        )
        val tIdx = actionTypes.indexOfFirst { it.first == a.type }
        if (tIdx >= 0) spType.setSelection(tIdx)
        etP1.setText(a.p1)
        etP2.setText(a.p2)
        etP3.setText(a.p3)
        updateActionHints(spType.selectedItemPosition, etP1, etP2, etP3, btnPreview, btnPickAudio, btnPickSound)

        spType.setOnItemSelectedListener(object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                updateActionHints(pos, etP1, etP2, etP3, btnPreview, btnPickAudio, btnPickSound)
                updatePreview()
            }
            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
        })
        btnRemove.setOnClickListener {
            actionContainer.removeView(row)
            updatePreview()
        }
        // 选音频文件（只在"播放音效"时可见）
        btnPickAudio.setOnClickListener {
            pendingFileRow = row
            pickAudio.launch(arrayOf("audio/*"))
        }
        // 音效库（v1.20.21）：从预设清单里挑，名字说人话
        btnPickSound.setOnClickListener { showSoundPicker(row) }
        // ▶ 预览：**不必先保存规则**，按当前这一行立刻演一次效果
        //   · 音效 → 试听（含速率与音量）
        //   · 弹提示 → 真的弹一次灵动岛（用当前样式 + 当前文案）
        //   · 系统通知 → 真的发一条系统通知
        // ⚠️ 三个都**不落盘、不进规则记录、不触发别的动作**（只是演示）
        btnPreview.setOnClickListener {
            val type = actionTypes.getOrNull(spType.selectedItemPosition)?.first ?: "sound"
            val p1 = etP1.text.toString()
            when (type) {
                "sound" -> ObdController.previewSound(
                    p1,
                    volume = etP3.text.toString().toFloatOrNull() ?: 1f,
                    rate = etP2.text.toString().toFloatOrNull() ?: 1f
                )
                "toast" -> showIslandPreview(p1)
                "notify" -> ObdController.previewNotification(p1)
            }
        }
        etP1.addTextChangedListener(SimpleWatcher { updatePreview() })
        etP2.addTextChangedListener(SimpleWatcher { updatePreview() })
        etP3.addTextChangedListener(SimpleWatcher { updatePreview() })

        actionContainer.addView(row)
        updatePreview()
    }

    // ------------------------------------------------------------ 预览（v1.20.21）

    /**
     * 编辑器里的灵动岛实例。
     *
     * ⚠️ **是本 Activity 自己的**，不是 `MainActivity` 那个 —— 规则编辑器是独立
     * Activity，`MainActivity` 的浮层挂在它自己的 `android.R.id.content` 上，
     * 这里根本看不见。所以要"当场看到效果"就得自己挂一个。
     *
     * 复用的是**同一个** [IslandNotice]（同一套样式读取、同一套状态机、
     * 同一个 `IslandCapsuleView`），所以看到的就是真弹出来的样子；
     * "不抢触摸"那三条硬约束也**自动继承**（`isClickable=false` 等写在胶囊里）。
     */
    private var islandPreview: IslandNotice? = null

    /**
     * 弹一次灵动岛（演示）。
     *
     * ⚠️ 刻意**不走** `ObdController.emitAlert`：那条路会 `VehicleBus.emit` +
     * 通知所有监听者，等于"真的触发了一次规则提示"（会进日志、会进别的页面）。
     * 这里只动这一个浮层。
     *
     * ⚠️ 文案用 [RuleAlertRouting.previewText] / [RuleAlertRouting.islandText]
     * ——与规则真正触发时**同一套**回退与前缀，否则"预览和真弹的不一样"，
     * 而这个按钮存在的全部意义就是让用户看到真的长什么样。
     */
    private fun showIslandPreview(p1: String) {
        val notice = islandPreview ?: IslandNotice(this).also { islandPreview = it }
        findViewById<android.view.ViewGroup>(android.R.id.content)?.let { notice.attach(it) }
        val text = RuleAlertRouting.previewText(p1, etName.text.toString().trim())
        notice.show(RuleAlertRouting.islandText(text))
        AppLog.i(AppLog.M_UI, "预览灵动岛提示（不落盘）", text)
    }

    /**
     * 「🎵 音效库」：从 [SoundPresets.ALL] 里挑一个。
     *
     * ⚠️ 对话框只 `setTitle` + `setItems`，**不许 `setMessage`** ——
     * `MaterialAlertDialogBuilder` 同时收到 message 与 setItems 时列表会被整个丢掉
     * （见 `docs/FILE_MAP.md` 里 `CanvasSettingsFragment` 那条）。
     *
     * 选中后**立刻试听**：用户点这一下本来就是想听，再让他去按 ▶ 是多余的。
     */
    private fun showSoundPicker(row: View) {
        val labels = SoundPresets.ALL.map { "${it.label}    ${it.id}\n${it.hint}" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("选择音效（共 ${SoundPresets.ALL.size} 个预设）")
            .setItems(labels) { _, which ->
                val p = SoundPresets.ALL[which]
                row.findViewById<EditText>(R.id.etP1).setText(p.id)
                // 选预设 = 不再用自定义文件，把 p4 的显示名清掉
                //（留着的话规则描述里会挂着上一个文件的名字）
                row.tag = ""
                refreshPickButton(row.findViewById(R.id.btnPickAudio), p.id, "")
                ObdController.previewSound(p.id)
                AppLog.i(AppLog.M_UI, "已选择预设音效", "${p.id} · ${p.label}")
                updatePreview()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun updateActionHints(
        pos: Int,
        p1: EditText,
        p2: EditText,
        p3: EditText,
        preview: MaterialButton,
        pick: MaterialButton,
        pickSound: MaterialButton
    ) {
        val type = actionTypes.getOrNull(pos)?.first
        val isSound = type == "sound"
        // ♪ / 📁 / 🎵 都只在"播放音效"时有意义 —— 其他类型下显示它们只会让人误点
        pick.visibility = if (isSound) android.view.View.VISIBLE else android.view.View.GONE
        pickSound.visibility = if (isSound) android.view.View.VISIBLE else android.view.View.GONE

        // ▶ 预览按钮（v1.20.21）：三类"有看得见/听得见的效果"的动作都有它。
        // `log` / `gauge` / `vibrate` 刻意没有 —— 前两个的效果在日志页和仪表上
        // （不在这块屏幕上），振动 adb 也验不了，给个按了"没反应"的按钮不如不给。
        val previewable = type == "sound" || type == "toast" || type == "notify"
        preview.visibility = if (previewable) android.view.View.VISIBLE else android.view.View.GONE
        preview.text = "▶"

        when (type) {
            "sound" -> {
                // 点 📁 选文件后 p1 会变成 content:// URI —— 提示里说清楚两种都行
                p1.hint = "音效名（或点 🎵 选预设 / 📁 选文件）"
                p2.hint = "速率 0.5~2"
                p3.hint = "音量 0~1"
                if (p1.text.isBlank()) p1.setText("warn")
            }
            "toast" -> {
                p1.hint = "提示文本（空 = 用规则名）"
                p2.hint = "(不用)"
                p3.hint = "(不用)"
            }
            "log", "notify" -> {
                p1.hint = "文本内容"
                p2.hint = "(不用)"
                p3.hint = "(不用)"
            }
            "gauge" -> {
                p1.hint = "PID id（空=条件源）"
                p2.hint = "颜色 red/green/yellow/blue"
                // p3 = 自动恢复延时（v1.19.18）：不填就一直红着
                p3.hint = "N 秒后自动恢复"
                if (p2.text.isBlank()) p2.setText("red")
            }
            "vibrate" -> {
                p1.hint = "时长 ms"
                p2.hint = "(不用)"
                p3.hint = "(不用)"
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
            val p3 = row.findViewById<EditText>(R.id.etP3).text.toString()
            out.add(
                RuleAction(
                    type = actionTypes.getOrNull(spType.selectedItemPosition)?.first ?: "toast",
                    p1 = p1, p2 = p2, p3 = p3,
                    // p4 = 选文件时的显示名（挂在行 tag 上）；没选就是空
                    p4 = (row.tag as? String).orEmpty()
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

    /**
     * 试判失败：**Toast + 警示色 + 滚到可见**，与 `PidEditorActivity.fail()` 同一套理由。
     *
     * 规则编辑器的"点了没反应"更隐蔽：条件没配全时 `RuleEngine.testRuleOnce` 照样返回
     * 一个结果，用户看到的是"当前条件下：不成立"，会去怀疑车/信号，
     * 而真正的原因是**那一行的数据源根本没选**。
     */
    private fun fail(row: String, toast: String = row) {
        tvTestResult.text = row
        tvTestResult.setTextColor(androidx.core.content.ContextCompat.getColor(this, R.color.danger))
        scrollRoot.post { runCatching { scrollRoot.smoothScrollTo(0, tvTestResult.top) } }
        ObdController.toast(toast)
        AppLog.w(AppLog.M_UI, "规则试判未通过", toast)
    }

    private fun testNow() {
        val r = collect()
        if (r.conditions.isEmpty() || r.conditions.any { it.sourceId.isBlank() }) {
            fail("试判: 请至少配置一个有效条件（数据源那一栏是空的）", "请至少配置一个有效条件")
            return
        }
        if (!ObdController.engine.running) {
            fail("试判: 轮询未运行，请先连接并初始化设备", "轮询未运行 —— 请先到「连接」页连接并初始化")
            return
        }
        tvTestResult.setTextColor(testColor)
        val ok = RuleEngine.testRuleOnce(r)
        val detail = r.conditions.joinToString("\n") { c ->
            val v = com.icar.obd.obd.VehicleBus.value(c.sourceId)
            "  ${RuleEngine.describeCondition(c)}  →  当前值 ${v?.let { fmt(it) } ?: "无数据"}"
        }
        tvTestResult.text = if (ok) "当前条件下：成立 ✓\n$detail" else "当前条件下：不成立\n$detail"
        AppLog.i(AppLog.M_UI, "规则试判", "name=${r.name} result=$ok")
    }

    // ------------------------------------------------------------ 保存 / 删除

    /**
     * 校验并落盘；**不 finish**。
     *
     * 抽出来是为了让"保存后立刻做别的"能复用它（v1.19.19 的模拟测试：
     * 先保存再按规则 id 起模拟）—— 否则要么重复写一遍校验，
     * 要么就得在 save() 里 finish 之后再操作一个已经关掉的界面。
     *
     * @return 保存成功返回规则；校验没过返回 null（并已 toast 说明原因）
     */
    private fun saveRule(): Rule? {
        val r = collect()
        if (r.name.isBlank()) {
            ObdController.toast("请填写规则名称")
            return null
        }
        if (r.conditions.isEmpty() || r.conditions.any { it.sourceId.isBlank() }) {
            ObdController.toast("请至少配置一个有效条件")
            return null
        }
        if (r.actions.isEmpty()) {
            ObdController.toast("请至少配置一个动作")
            return null
        }
        Store.upsertRule(r)
        ObdController.reloadRules()
        AppLog.i(AppLog.M_UI, "规则已保存", RuleEngine.describeRule(r))
        return r
    }

    private fun save() {
        if (saveRule() == null) return
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
