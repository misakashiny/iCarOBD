package com.icar.obd.ui.dash

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.DashCanvas
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.DashFragment
import com.icar.obd.ui.ThemeEditorActivity
import com.icar.obd.ui.view.DashboardBackground
import com.icar.obd.ui.view.GaugeTheme

/**
 * **画布设置页**（ViewPager2 的最后一页，滑到最右）。
 *
 * ## 它收拢了什么
 *
 * v1.19.25 把仪表盘顶栏删掉之后，「布局（预设）」和「风格（主题·背景·设计文件·
 * 参考线）」两个按钮没了去处。它们**不能丢** —— 尤其是设计文件的导入/导出，
 * 那是"在电脑上设计 → 推给设备"闭环的**唯一入口**（v1.10.3 补的）。
 *
 * 所以这一页同时是三件事：
 *  1. **多套画布**的管理（增 / 删 / 改名 / 排序 / 前往）；
 *  2. **当前画布**的外观（主题 / 背景 / 设计文件 / 参考线 / 卡片样式）；
 *  3. 两个与画面无关的全局开关（轮询间隔 / 音效）。
 *
 * ## 为什么"当前画布"这几个字要显式写出来
 *
 * 这一页上的外观项**只作用于当前那一套**（不是全部）。不写清楚的话，
 * 用户在第 2 套上改了主题、滑回第 1 套发现没变，会以为设置没生效 ——
 * 而多画布的设计本来就是"每套各管各的"。
 */
class CanvasSettingsFragment : Fragment() {

    private lateinit var llList: LinearLayout
    private lateinit var tvCount: TextView
    private lateinit var tvCurrent: TextView
    private lateinit var btnAdd: MaterialButton
    private lateinit var btnImportCanvas: MaterialButton
    private lateinit var btnExportCanvas: MaterialButton
    private lateinit var btnTheme: MaterialButton
    private lateinit var btnLook: MaterialButton
    private lateinit var btnPoll: MaterialButton
    private lateinit var swSound: MaterialSwitch
    private lateinit var btnNameLabel: MaterialButton

    /** 轮询间隔候选。**给选项而不是让用户敲数字** —— 这个值直接决定总线负载 */
    private val pollChoices = listOf(60, 80, 100, 120, 150, 200, 250, 300)

    // ---------------------------------------------------------------- 文件选择

    /** 选背景图片（SAF，不需要存储权限） */
    private val pickBgImage = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val path = DashboardBackground.import(requireContext(), uri)
        if (path == null) {
            ObdController.toast("导入图片失败")
            return@registerForActivityResult
        }
        Store.settings.bgImagePath = path
        Store.saveSettings()
        ObdController.toast("背景图片已设置")
        refresh()
    }

    /**
     * 导入设计文件（`icar.ui/1` / `2`，由 `tools/theme-studio/` 产出）。
     *
     * 走 SAF（`OpenDocument`），**不需要任何存储权限** —— 与「从文件恢复备份」同一套。
     */
    private val openDesignFile = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val text = runCatching {
            requireContext().contentResolver.openInputStream(uri)
                ?.bufferedReader()?.use { it.readText() }
        }.getOrNull()
        if (text.isNullOrBlank()) {
            ObdController.toast("读取文件失败")
            return@registerForActivityResult
        }
        importDesign(text)
    }

    /** 最近一次应用的设计（选完素材文件夹后要**再应用一次**，那时素材才解析得到） */
    private var lastDesign: com.icar.obd.data.DesignFile? = null
    private var lastDesignRaw: String = ""

    /**
     * 选**素材文件夹**（SAF 目录树），整棵复制进 app 私有目录，再重新应用设计。
     *
     * 为什么需要这一步：设计文件的素材是相对路径，而 `design.json` 是**单文件导入**的
     * —— 拿不到它旁边的 `assets/`。不解决的话所有素材都加载不到，
     * 由控件拼出来的表盘只剩空卡片（v1.20.3 修的那个 P0）。
     *
     * 复制进私有目录（而不是直接引用 SAF 路径）与 `DashboardBackground.import`
     * 同一套理由：**外部路径不保证长期存在**（换机、清理、拔卡都会失效）。
     */
    private val pickAssetDir = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val ctx = requireContext()
        val dest = java.io.File(ctx.filesDir, "design/${System.currentTimeMillis()}")
        val n = runCatching {
            com.icar.obd.data.DesignAssets.copyTree(ctx, uri, dest)
        }.getOrElse {
            ObdController.toast("复制素材失败：${it.message}")
            return@registerForActivityResult
        }
        // 选的应该是**包含 assets/ 的那一层**。选错了要明确说出来，
        // 否则又是一次"选完了但还是空的"（这次经历够了）
        if (!java.io.File(dest, "assets").isDirectory) {
            ObdController.toast("这个文件夹里没有 assets/ 子目录 —— 请选它的上一层")
            return@registerForActivityResult
        }
        Store.settings.designBaseDir = dest.absolutePath
        Store.saveSettings()
        AppLog.i(
            AppLog.M_UI, "已导入设计素材",
            "文件=$n 目录=${dest.absolutePath}"
        )
        ObdController.toast("已导入 $n 个素材文件，重新渲染")
        // 再应用一次 —— 这次 designBaseDir 有值了，素材与背景都能解析
        lastDesign?.let { applyDesign(it, lastDesignRaw) }
    }

    // ---------------------------------------------------------------- 生命周期

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_canvas_settings, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        llList = view.findViewById(R.id.llCanvasList)
        tvCount = view.findViewById(R.id.tvCanvasCount)
        tvCurrent = view.findViewById(R.id.tvCurrentCanvas)
        btnAdd = view.findViewById(R.id.btnAddCanvas)
        btnImportCanvas = view.findViewById(R.id.btnImportCanvas)
        btnExportCanvas = view.findViewById(R.id.btnExportCanvas)
        btnTheme = view.findViewById(R.id.btnCanvasTheme)
        btnLook = view.findViewById(R.id.btnCanvasLook)
        btnPoll = view.findViewById(R.id.btnPollInterval)
        swSound = view.findViewById(R.id.swSound)
        btnNameLabel = view.findViewById(R.id.btnNameLabel)

        btnAdd.setOnClickListener { showAddDialog() }
        // 导入 / 导出画布（v1.20.2）：与电脑上的 tools/theme-studio 对接的入口。
        // 从"画布外观"菜单里搬出来做成常驻一行 —— 用户明确要求"做成一行、好配合网页版工具"。
        btnImportCanvas.setOnClickListener {
            openDesignFile.launch(arrayOf("application/json", "text/plain", "*/*"))
        }
        btnExportCanvas.setOnClickListener { exportDesign() }
        btnTheme.setOnClickListener { showThemePicker() }
        btnLook.setOnClickListener { showLookMenu() }
        btnPoll.setOnClickListener { showPollDialog() }
        btnNameLabel.setOnClickListener { showNamePosDialog() }
        swSound.setOnCheckedChangeListener { _, checked ->
            Store.settings.soundEnabled = checked
            Store.saveSettings()
            ObdController.applySoundEnabled()
            ObdController.toast(if (checked) "音效已开" else "音效已关")
        }

        refresh()
    }

    /** 宿主在这一页成为当前页时调（列表可能被别的页改过） */
    fun onPageShown() = refresh()

    // ---------------------------------------------------------------- 刷新

    /**
     * 一套画布的一句话描述。
     *
     * ⚠️ **内置布局的画布必须说清"存着的表没在显示"**（v1.20.2 修）。
     *
     * 原来这里一律写 `N 个仪表` —— 而 type=普通/性能 的画布**显示的是内置布局**，
     * 那一份 `gauges` 是**存着但没显示**的。实机后果（2026-10-06 23:52）：
     * 用户看到"11 个仪表"，屏幕上却是内置的 8 个，于是报"**画布不显示我做好的内容**"，
     * 接着点「编辑」确认转换 → 那 11 块被覆盖销毁。描述说谎是这条链的第一环。
     */
    private fun describeCanvas(c: DashCanvas): String = buildString {
        if (c.type == DashCanvas.TYPE_CUSTOM) {
            append(DashCanvas.typeName(c.type))
            if (c.designJson.isNotBlank()) append("（设计文件）")
            append(" · ").append(c.gaugeCount()).append(" 个仪表")
        } else {
            append("内置「").append(DashCanvas.typeName(c.type)).append("」布局")
            if (c.gauges.isNotEmpty()) {
                // ⚠️ 不要用 ** 强调 —— TextView 不渲染 Markdown，会原样显示星号
                append(" · 另存着 ").append(c.gauges.size).append(" 块自定义表（未显示）")
            }
        }
        if (c.bgImagePath.isNotBlank()) append(" · 有背景图")
        append(" · 主题 ").append(GaugeTheme.of(c.theme).title)
    }

    private fun refresh() {
        if (view == null) return
        val canvases = Store.settings.canvases
        val activeId = Store.settings.activeCanvasId

        tvCount.text = "共 ${canvases.size} 套 · 上限 ${DashCanvas.MAX_CANVASES} 套 · 横滑切换"
        val active = Store.activeCanvas()
        tvCurrent.text = "当前：${active.name} · ${describeCanvas(active)}"

        llList.removeAllViews()
        canvases.forEachIndexed { i, c ->
            llList.addView(buildRow(i, c, c.id == activeId))
        }

        val theme = GaugeTheme.of(Store.settings.gaugeTheme)
        btnTheme.text = "画布主题：${theme.title}" + (if (theme.custom) "（自建）" else "")
        btnLook.text = if (Store.settings.bgImagePath.isBlank()) {
            "背景 / 设计文件 / 参考线…"
        } else {
            "背景 / 设计文件 / 参考线…（已设背景图）"
        }
        btnPoll.text = "轮询间隔：${Store.settings.pollIntervalMs} ms"
        btnNameLabel.text = "画布名浮标：${DashCanvas.namePosName(Store.settings.canvasNamePos)}"
        if (swSound.isChecked != Store.settings.soundEnabled) {
            swSound.isChecked = Store.settings.soundEnabled
        }
    }

    private fun buildRow(index: Int, c: DashCanvas, isActive: Boolean): View {
        val row = layoutInflater.inflate(R.layout.item_canvas, llList, false)
        row.findViewById<TextView>(R.id.tvName).text =
            (if (isActive) "● " else "") + c.name + "（第 ${index + 1} 套）"
        row.findViewById<TextView>(R.id.tvSub).text = describeCanvas(c)
        // 点整行 = 前往那一套（同时把它设为当前）
        row.setOnClickListener { gotoCanvas(index) }
        row.findViewById<MaterialButton>(R.id.btnRowMenu).setOnClickListener { showRowMenu(index) }
        return row
    }

    // ---------------------------------------------------------------- 画布列表

    private fun gotoCanvas(index: Int) {
        val c = Store.settings.canvases.getOrNull(index) ?: return
        if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)
        refresh()
        // 交给宿主翻页：它会把"页码变化"和"切当前画布"区分开（见 DashFragment.awaitingPos）
        (parentFragment as? DashFragment)?.jumpToCanvas(index)
    }

    /**
     * 把内置布局的画布切到"用我存着的那 N 块表"。
     *
     * **非破坏性**：只把类型翻成自定义，`customGauges` 一个字都不动。
     * 与"点编辑 → 确认转换"是两条路 —— 后者在 v1.20.1 及以前会覆盖用户的作品。
     */
    private fun useStoredGauges(c: DashCanvas) {
        if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)
        val n = Store.customGauges.size
        Store.settings.dashType = DashSpec.CUSTOM
        Store.saveDash()
        refresh()
        (parentFragment as? DashFragment)?.jumpToCanvas(Store.canvasIndex(c.id))
        ObdController.toast("已切到你的 $n 块表")
        AppLog.i(AppLog.M_UI, "改用存着的自定义表", "canvas=${c.name} count=$n")
    }

    private fun showRowMenu(index: Int) {
        val c = Store.settings.canvases.getOrNull(index) ?: return
        val actions = ArrayList<Pair<String, () -> Unit>>()
        actions += "改名…" to { showRenameDialog(index) }
        if (index > 0) actions += "上移" to { moveCanvas(index, index - 1) }
        if (index < Store.settings.canvases.size - 1) actions += "下移" to { moveCanvas(index, index + 1) }
        actions += "前往这一套" to { gotoCanvas(index) }
        // 内置布局 + 存着表 → 给一条**非破坏性**的出路（这是"我做好的内容不见了"的答案）
        if (c.type != DashCanvas.TYPE_CUSTOM && c.gauges.isNotEmpty()) {
            actions += "改用我存着的 ${c.gauges.size} 块表" to { useStoredGauges(c) }
        }
        actions += "编辑这一套…" to { editCanvas(index) }
        actions += "删除这一套" to { confirmRemove(index) }

        MaterialAlertDialogBuilder(requireContext())
            .setTitle("「${c.name}」")
            .setItems(actions.map { it.first }.toTypedArray()) { _, which -> actions[which].second() }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 编辑某一套画布（v1.20.2：编辑入口从画布页右下角搬到**设置页的操作菜单**）。
     *
     * 用户要求："画布右下角不要编辑、编辑功能应该是在设置页面里的操作里面"。
     *
     * 搬到这里的额外好处：编辑是**破坏性动作**（会改盘面），放在"操作"菜单里
     * 比常驻在画布上更合适 —— 原来那个常驻按钮一点就进编辑态，
     * 在车上很容易误触。
     */
    private fun editCanvas(index: Int) {
        val c = Store.settings.canvases.getOrNull(index) ?: return
        if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)
        refresh()
        // 先翻到那一页，再让页面自己进编辑态（编辑态要由宿主关掉横滑，见 onPageEditing）
        (parentFragment as? DashFragment)?.jumpToCanvasAndEdit(index)
    }

    /**
     * 一行文本输入的对话框主体。
     *
     * ## 为什么必须抽出来（v1.20.2）
     *
     * 原来「新增画布」和「画布改名」各写各的：前者把 EditText 放进带内边距的容器，
     * 后者**直接给 EditText 自己 `setPadding(20dp, …)`** 就丢给对话框 ——
     * 于是文字被推进去 20dp，而下划线（EditText 自己的背景）还是整宽，
     * 看起来就是"输入框错位了"。
     *
     * 统一成：**容器给内边距，EditText 自己不加**，并显式定义高度/输入类型。
     */
    private fun textInputBody(hint: String, initial: String): Pair<LinearLayout, EditText> {
        val ctx = requireContext()
        val density = ctx.resources.displayMetrics.density
        val pad = (density * 20).toInt()
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
        }
        val et = EditText(ctx).apply {
            this.hint = hint
            setText(initial)
            setSelection(initial.length)
            maxLines = 1
            inputType = android.text.InputType.TYPE_CLASS_TEXT
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
            minHeight = (density * 44).toInt()
        }
        root.addView(et)
        return root to et
    }

    private fun showAddDialog() {
        if (Store.settings.canvases.size >= DashCanvas.MAX_CANVASES) {
            ObdController.toast("最多 ${DashCanvas.MAX_CANVASES} 套画布")
            return
        }
        val ctx = requireContext()
        val (root, etName) = textInputBody("画布名（如「跑山」「长途」）", "画布 ${Store.settings.canvases.size + 1}")
        val spType = Spinner(ctx).apply {
            adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, DashCanvas.TYPE_NAMES)
            setSelection(DashCanvas.TYPE_NORMAL)
        }
        root.addView(
            TextView(ctx).apply {
                text = "起始布局"
                textSize = 12f
                setPadding(0, (resources.displayMetrics.density * 12).toInt(), 0, 0)
            }
        )
        root.addView(spType)

        MaterialAlertDialogBuilder(ctx)
            .setTitle("新增画布")
            .setView(root)
            .setPositiveButton("新增") { _, _ ->
                val type = spType.selectedItemPosition.coerceIn(0, DashCanvas.TYPE_CUSTOM)
                val c = Store.addCanvas(etName.text.toString(), type)
                if (c == null) {
                    ObdController.toast("最多 ${DashCanvas.MAX_CANVASES} 套画布")
                    return@setPositiveButton
                }
                refresh()
                (parentFragment as? DashFragment)?.onCanvasAdded(Store.canvasIndex(c.id))
                ObdController.toast("已新增「${c.name}」—— 向左滑即可看到")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showRenameDialog(index: Int) {
        val c = Store.settings.canvases.getOrNull(index) ?: return
        val ctx = requireContext()
        val (root, et) = textInputBody("画布名", c.name)
        MaterialAlertDialogBuilder(ctx)
            .setTitle("画布改名")
            .setView(root)
            .setPositiveButton("确定") { _, _ ->
                Store.renameCanvas(c.id, et.text.toString())
                refresh()
                (parentFragment as? DashFragment)?.onCanvasRenamed(Store.canvasIndex(c.id))
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun moveCanvas(from: Int, to: Int) {
        val c = Store.settings.canvases.getOrNull(from) ?: return
        if (!Store.moveCanvas(from, to)) return
        refresh()
        (parentFragment as? DashFragment)?.onCanvasMoved(from, to)
        AppLog.i(AppLog.M_UI, "画布已排序", "${c.name}: $from -> $to")
    }

    private fun confirmRemove(index: Int) {
        val c = Store.settings.canvases.getOrNull(index) ?: return
        if (Store.settings.canvases.size <= 1) {
            ObdController.toast("至少要留一套画布")
            return
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("删除「${c.name}」？")
            .setMessage("这一套的布局、主题、背景设置都会一起删掉，不能撤销。")
            .setPositiveButton("删除") { _, _ ->
                if (!Store.removeCanvas(c.id)) {
                    ObdController.toast("至少要留一套画布")
                    return@setPositiveButton
                }
                refresh()
                (parentFragment as? DashFragment)?.onCanvasRemoved(index)
                ObdController.toast("已删除「${c.name}」")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 当前画布：主题

    private fun showThemePicker() {
        val themes = GaugeTheme.all()
        val labels = themes.map {
            "${it.title}${if (it.custom) "（自建）" else ""}\n${it.description}"
        } + listOf("编辑主题…")
        val selected = themes.indexOfFirst { it.id == Store.settings.gaugeTheme }.coerceAtLeast(0)

        MaterialAlertDialogBuilder(requireContext())
            .setTitle("画布主题（只作用于当前这一套）")
            .setSingleChoiceItems(labels.toTypedArray(), selected) { dialog, which ->
                if (which == themes.size) {
                    dialog.dismiss()
                    startActivity(
                        Intent(requireContext(), ThemeEditorActivity::class.java)
                            .putExtra(ThemeEditorActivity.EXTRA_THEME_ID, Store.settings.gaugeTheme)
                    )
                    return@setSingleChoiceItems
                }
                Store.settings.gaugeTheme = themes[which].id
                Store.saveSettings()
                refresh()
                dialog.dismiss()
                ObdController.toast("画布主题：${themes[which].title}")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 当前画布：外观

    /**
     * 「背景 / 设计文件 / 参考线」菜单。
     *
     * ⚠️ 用**动作列表**而不是"标签数组 + 下标算术"。
     * 旧版顶栏那个菜单是按 `themes.size + N` 反推下标的，条件项一多就错位，
     * 而错位的表现是"点了没反应"（静默失效，v1.17.7 为此查了很久）。
     */
    private fun showLookMenu() {
        val labels = ArrayList<String>()
        val actions = ArrayList<() -> Unit>()
        fun add(label: String, act: () -> Unit) {
            labels += label
            actions += act
        }

        add("选择背景图片…") { pickBgImage.launch(arrayOf("image/*")) }
        if (Store.settings.bgImagePath.isNotBlank()) {
            add("清除背景图片") {
                Store.settings.bgImagePath = ""
                Store.saveSettings()
                DashboardBackground.clear(requireContext())
                refresh()
                ObdController.toast("已清除背景图片")
            }
        }
        add("背景铺法：${com.icar.obd.data.DesignFile.fitName(Store.settings.bgFit)}") { showBgFitPicker() }
        // 两个快捷开关：不用进主题编辑器就能去掉外框 / 把卡片做成透明
        add("关闭卡片外框（保留卡片底）") { applyCardQuickStyle("无边框", strokeDp = 0f) }
        add("卡片完全透明（适合背景图）") { applyCardQuickStyle("透明卡片", strokeDp = 0f, alpha = 0) }
        add("参考线…") { showGridDialog() }
        // ⚠️ 「导入 / 导出画布」**不在这里**了 —— v1.20.2 起做成设置页上一行常驻按钮
        // （用户要求"新增画布下面加个导入画布、导出画布、做成一行"）。
        // 同一个动作留两个入口是"两份权威"的轻量版：以后改一处忘一处。
        add(
            if (Store.settings.designJson.isBlank()) "清除导入的设计文件（当前没有）"
            else "清除导入的设计文件"
        ) { clearDesignFile() }

        // 「选择页面」**只在多页设计时出现**，而且是最后一项
        val pages = designPages()
        if (pages.size > 1) {
            val i = Store.settings.dashPageIndex.coerceIn(0, pages.size - 1)
            add("选择页面：${pages[i].name}（${i + 1}/${pages.size}）") { showPagePicker() }
        }

        MaterialAlertDialogBuilder(requireContext())
            .setTitle("画布外观（只作用于当前这一套）")
            .setItems(labels.toTypedArray()) { _, which -> actions[which].invoke() }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 「关闭卡片外框」/「卡片完全透明」快捷开关。
     *
     * ## 为什么要生成自建主题，而不是直接改当前主题
     *
     * 内置主题（霓虹/冰川/经典）是**只读常量**。就地改它们会让"经典"在重启后
     * 又变回有边框，用户会以为设置没生效。所以走**与主题编辑器完全相同的路径**：
     * `asCustom()` 复制一份、写进 `Store.customThemeJson`、把当前主题切过去。
     *
     * ## 复用已有自建主题
     *
     * 如果当前用的**本来就是自建主题**，就地改那一份而不是再生成一个 ——
     * 否则每点一次开关就多出一个主题，主题列表很快会被垃圾填满。
     */
    private fun applyCardQuickStyle(label: String, strokeDp: Float, alpha: Int? = null) {
        val current = GaugeTheme.of(Store.settings.gaugeTheme)
        val target = if (current.custom) {
            current.copy(cardStrokeDp = strokeDp, cardAlpha = alpha ?: current.cardAlpha)
        } else {
            current.copy(
                cardStrokeDp = strokeDp,
                cardAlpha = alpha ?: current.cardAlpha
            ).asCustom(GaugeTheme.nextCustomId(), "${current.title} · $label")
        }

        // 同 id 覆盖（与 ThemeEditorActivity.persist 同一套写法）
        val keep = Store.customThemeJson.filter { json ->
            runCatching { org.json.JSONObject(json).optInt("id", -1) }.getOrDefault(-1) != target.id
        }
        Store.customThemeJson.clear()
        Store.customThemeJson.addAll(keep)
        Store.customThemeJson.add(target.toJson().toString())
        Store.saveThemes()

        Store.settings.gaugeTheme = target.id
        Store.saveSettings()
        refresh()
        ObdController.toast(
            if (current.custom) "已更新「${target.title}」" else "已新建主题「${target.title}」"
        )
    }

    private fun showBgFitPicker() {
        if (Store.settings.bgImagePath.isBlank()) {
            ObdController.toast("先选一张背景图片")
            return
        }
        val names = com.icar.obd.data.DesignFile.FIT_NAMES
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("背景铺法")
            .setSingleChoiceItems(names.toTypedArray(), Store.settings.bgFit) { d, which ->
                Store.settings.bgFit = which
                Store.saveSettings()
                refresh()
                d.dismiss()
                ObdController.toast("背景铺法：${names[which]}")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 参考线

    private fun showGridDialog() {
        val s = Store.settings
        val ctx = requireContext()
        val density = ctx.resources.displayMetrics.density
        val pad = (density * 20).toInt()

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
        }
        val sw = MaterialSwitch(ctx).apply {
            text = "显示参考线"
            isChecked = s.gridEnabled
        }
        val densityLabels = listOf("3 × 2", "4 × 3", "6 × 4", "8 × 6", "12 × 8")
        val densityPairs = listOf(3 to 2, 4 to 3, 6 to 4, 8 to 6, 12 to 8)
        val styleLabels = listOf("实线", "虚线", "点线")

        val spDensity = Spinner(ctx).apply {
            adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, densityLabels)
            val idx = densityPairs.indexOfFirst { it.first == s.gridCols && it.second == s.gridRows }
            setSelection(if (idx >= 0) idx else 2)
        }
        val spStyle = Spinner(ctx).apply {
            adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, styleLabels)
            setSelection(s.gridStyle.coerceIn(0, 2))
        }

        fun caption(text: String) = TextView(ctx).apply {
            this.text = text
            setPadding(0, (density * 12).toInt(), 0, (density * 2).toInt())
            textSize = 12f
        }

        root.addView(sw)
        root.addView(caption("密度"))
        root.addView(spDensity)
        root.addView(caption("样式"))
        root.addView(spStyle)

        MaterialAlertDialogBuilder(ctx)
            .setTitle("参考线")
            .setView(root)
            .setPositiveButton("确定") { _, _ ->
                val d = densityPairs[spDensity.selectedItemPosition.coerceIn(0, densityPairs.size - 1)]
                s.gridEnabled = sw.isChecked
                s.gridCols = d.first
                s.gridRows = d.second
                s.gridStyle = spStyle.selectedItemPosition.coerceIn(0, 2)
                Store.saveSettings()
                AppLog.i(
                    AppLog.M_UI, "参考线设置",
                    "on=${s.gridEnabled} ${s.gridCols}x${s.gridRows} style=${s.gridStyle}"
                )
                ObdController.toast("参考线已更新")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 设计文件

    /**
     * 解析 → **先给用户看结果** → 再应用。
     *
     * 两段式是刻意的：设计文件的校验**不抛异常**、只返回带字段路径的错误列表，
     * 所以有硬错误时可以精确告诉用户"第几块表的哪个字段错了"，
     * 而不是笼统地"导入失败"。软警告也要显示出来（比如背景路径在本机不存在）——
     * 那些是**能加载但效果可能不是你想要的**，瞒着用户反而更糟。
     */
    private fun importDesign(text: String) {
        val r = com.icar.obd.data.DesignFile.parse(text)
        val msg = buildString {
            if (!r.ok) {
                append("**无法导入**，有 ${r.errors.size} 个硬错误：\n\n")
                r.errors.forEach { append("· ").append(it).append('\n') }
            } else {
                val d = r.design!!
                append("设计：**").append(d.name).append("**")
                if (d.description.isNotBlank()) append("（").append(d.description).append("）")
                append("\n\n会**整体替换当前这一套画布**：\n")
                append("· ").append(d.gauges.size).append(" 块仪表\n")
                if (d.themeId.isNotBlank()) append("· 主题：").append(d.themeId).append('\n')
                d.background?.let { b ->
                    append("· 背景：").append(com.icar.obd.data.DesignFile.fitName(b.fit)).append('\n')
                }
                if (r.warnings.isNotEmpty()) {
                    append("\n⚠️ ").append(r.warnings.size).append(" 条提示（不影响导入）：\n")
                    r.warnings.forEach { append("· ").append(it).append('\n') }
                }
            }
        }
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(if (r.ok) "导入设计文件" else "设计文件有错误")
            .setMessage(msg.trim())
            .apply {
                if (r.ok) setPositiveButton("导入") { _, _ -> applyDesign(r.design!!, text) }
                setNegativeButton(if (r.ok) "取消" else "知道了", null)
            }
            .show()
    }

    /** 应用设计文件。**先全部校验完再落盘**，避免中途失败留下半个盘面 */
    private fun applyDesign(d: com.icar.obd.data.DesignFile, rawText: String = "") {
        // 布局：整体替换当前这一套画布的自定义仪表
        Store.customGauges.clear()
        Store.customGauges.addAll(d.gauges)

        // v2：把**设计文件原文**存下来，渲染时按节点树走。
        // 为什么存原文而不是序列化 d：DesignFile.toJson() 写的是 v1，
        // 往返会丢掉 nodes / assets / controls / 字体 / 状态。
        Store.settings.designJson =
            if (rawText.isNotBlank() && rawText.contains("icar.ui/2")) rawText else ""

        // 主题：设计文件里存的是**名字**（neon/ice/amber），不是 id ——
        // 因为 id 会随自建主题分配而变化，名字才是跨机器稳定的
        if (d.themeId.isNotBlank()) {
            val t = GaugeTheme.byAlias(d.themeId)
            if (t != null) {
                Store.settings.gaugeTheme = t.id
            } else {
                ObdController.toast("主题「${d.themeId}」不存在，已保持当前主题")
            }
        }

        // 背景：路径照写。文件不在本机时**仍然写入**（解析阶段已警告过），
        // 这样用户能看出"这里本该有张图"，而不是莫名其妙什么都没有
        d.background?.let { b ->
            // 缩放模式要在背景之前存 —— 背景定位要用它算换算
            Store.settings.dashScaleMode = d.scaleMode
            // v2 的 w/h（画布单位，0 = 铺满）。**必须一起存** ——
            // 只存路径不存尺寸的话，刷新后「缩在中间的一块图」又会变成全屏
            Store.settings.bgW = b.w
            Store.settings.bgH = b.h
            // ⚠️ v1.20.3：背景也可能是**相对路径**（`assets/bg.png`）。
            // 直接存原始路径的话 `DashboardBackground.load` 必然读不到 ——
            // 与素材是同一个病。这里拼上设计基目录（可能还是空，那就先原样存，
            // 等用户选完素材文件夹后 [pickAssetDir] 会再应用一次）。
            Store.settings.bgImagePath = resolveDesignPath(b.path)
            Store.settings.bgFit = b.fit
        }

        // 切到「自定义」：设计文件改的就是它，停在普通/性能上会看不到变化
        Store.settings.dashType = DashSpec.CUSTOM
        Store.saveSettings()
        Store.saveDash()

        // 记住这一份，供"选完素材文件夹后重新应用"用
        lastDesign = d
        lastDesignRaw = rawText

        refresh()
        AppLog.i(
            AppLog.M_UI, "已导入设计文件",
            "canvas=${Store.activeCanvas().name} name=${d.name} gauges=${d.gauges.size} " +
                "theme=${d.themeId} bg=${d.background?.path ?: "-"} " +
                "素材=${d.assets.size} base=${Store.settings.designBaseDir.ifBlank { "(空)" }}"
        )
        ObdController.toast("已导入 ${d.gauges.size} 块仪表")

        // ⚠️ **P0 的真正入口**（v1.20.3）：设计里的素材是相对路径，而导入是走 SAF
        // **单文件** —— 拿不到它所在的目录，`designBaseDir` 永远是空，
        // 于是所有素材加载失败、由控件拼的表盘只剩空卡片。
        // 用户报的"画布不显示我做好的内容、显示是空的"就是这个。
        // 这里主动问一次"素材在哪个文件夹"，选完复制进私有目录并重新应用。
        val rel = d.assets.map { it.path }
        if (com.icar.obd.data.DesignAssets.hasRelativeAssets(rel) &&
            Store.settings.designBaseDir.isBlank()
        ) {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle("这份设计还需要素材")
                .setMessage(
                    "它引用了 ${d.assets.size} 个素材（相对路径，如 assets/xx.png）。\n\n" +
                        "单靠一个 design.json 拿不到素材 —— **不选的话表盘会只剩空卡片**。\n\n" +
                        "请选**包含 assets/ 的那个文件夹**（电脑上主题工具导出目录的上一层）。"
                )
                .setPositiveButton("选择素材文件夹") { _, _ -> pickAssetDir.launch(null) }
                .setNegativeButton("先不选（会显示不全）", null)
                .show()
        }
    }

    /**
     * 相对路径拼上设计基目录；已经是绝对路径就原样返回。
     *
     * 与 `NodeTreeRenderer.resolveAssetPath` 同一套规则 —— 两处不一致的话
     * 会出现"素材读到了、背景读不到"这种半截效果。
     */
    private fun resolveDesignPath(p: String): String {
        if (p.isBlank() || p.startsWith("/")) return p
        val base = Store.settings.designBaseDir
        if (base.isBlank()) return p
        return if (base.endsWith("/")) base + p else "$base/$p"
    }

    /**
     * 把当前画布导出成设计文件，分享出去。
     *
     * **闭环的另一半**：没有它，用户在电脑上设计 → 导入 → 再微调 → 就回不到电脑上了，
     * 只能从头重画。
     *
     * 主题写成**别名**而不是数字 id —— 见 [GaugeTheme.aliasOf]。
     */
    private fun exportDesign() {
        if (Store.customGauges.isEmpty()) {
            ObdController.toast("这一套画布是空的，先添加几块表")
            return
        }
        val d = com.icar.obd.data.DesignFile(
            name = Store.activeCanvas().name,
            author = "",
            description = "由 App 导出的画布「${Store.activeCanvas().name}」",
            // 自建主题没有别名 → 留空（用当前主题），否则导出后导入会报"主题不存在"
            themeId = GaugeTheme.aliasOf(Store.settings.gaugeTheme) ?: "",
            background = Store.settings.bgImagePath.takeIf { it.isNotBlank() }?.let {
                com.icar.obd.data.DesignFile.Background(
                    it, Store.settings.bgFit, Store.settings.bgW, Store.settings.bgH
                )
            },
            gauges = Store.customGauges.toList()
        )
        val json = d.toJson().toString(2)
        val file = java.io.File(requireContext().cacheDir, "design.json")
        runCatching { file.writeText(json) }.onFailure {
            ObdController.toast("导出失败：${it.message}")
            return
        }
        val uri = androidx.core.content.FileProvider.getUriForFile(
            requireContext(), "${requireContext().packageName}.fileprovider", file
        )
        startActivity(
            Intent.createChooser(
                Intent(Intent.ACTION_SEND).apply {
                    type = "application/json"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                },
                "导出设计文件"
            )
        )
        AppLog.i(AppLog.M_UI, "已导出设计文件", "gauges=${d.gauges.size} theme=${d.themeId}")
    }

    /**
     * 清除**导入的设计文件**，回到「预设 / 手改的扁平表」。
     *
     * ## 为什么必须有这个出口
     *
     * 导进去之后**原来没有任何办法撤销** —— 只能再导一份覆盖。
     * 而 v2 设计文件在「自定义」层优先级最高：留着它就会一直压住预设，
     * 表现为"套了预设但什么都没变"（v1.17.7 实测：一份残留的测试设计挡住 8 个表）。
     */
    private fun clearDesignFile() {
        if (Store.settings.designJson.isBlank()) {
            ObdController.toast("当前没有导入的设计文件")
            return
        }
        Store.settings.designJson = ""
        // 页面索引跟着失效（扁平表没有多页面），夹回第一页
        Store.settings.dashPageIndex = 0
        Store.saveSettings()
        refresh()
        ObdController.toast("已清除导入的设计文件")
        AppLog.i(
            AppLog.M_UI, "已清除设计文件",
            "canvas=${Store.activeCanvas().name} 回到 customGauges（count=${Store.customGauges.size}）"
        )
    }

    /**
     * 当前设计文件的页面列表。
     *
     * **每次都重新解析** —— 设计文件可能刚被导入过，缓存会读到旧的。
     * 解析失败 / 没有设计文件时返回空列表（调用方据此隐藏「选择页面」）。
     */
    private fun designPages(): List<com.icar.obd.data.DesignFile.DesignPage> {
        val dj = Store.settings.designJson
        if (dj.isBlank()) return emptyList()
        return runCatching {
            com.icar.obd.data.DesignFile.parse(dj).design?.pages ?: emptyList()
        }.getOrDefault(emptyList())
    }

    /** 选页对话框。选中后写 dashPageIndex 并重渲染 —— 不用重启、不用重新导入 */
    private fun showPagePicker() {
        val pages = designPages()
        if (pages.size <= 1) {
            ObdController.toast("这个设计只有一页")
            return
        }
        val cur = Store.settings.dashPageIndex.coerceIn(0, pages.size - 1)
        val names = pages.map { p ->
            p.name + "（" + com.icar.obd.data.DesignNode.flatten(p.nodes).size + " 个控件）"
        }.toTypedArray()
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("选择页面")
            .setSingleChoiceItems(names, cur) { d, which ->
                d.dismiss()
                Store.settings.dashPageIndex = which
                Store.saveSettings()
                refresh()
                ObdController.toast("已切到「" + pages[which].name + "」")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 全局设置

    /**
     * 轮询间隔（全局）。
     *
     * ⚠️ 用**自定义 View**（说明文字 + Spinner）而不是"message + 单选列表"：
     * 后者在 `MaterialAlertDialogBuilder` 下**列表会被整个丢掉**（v1.20.1 实测，
     * 详见 [showNamePosDialog] 的注释）。这里与 `showGridDialog` 走同一条已验证的路子。
     */
    private fun showPollDialog() {
        val ctx = requireContext()
        val density = ctx.resources.displayMetrics.density
        val pad = (density * 20).toInt()
        val cur = Store.settings.pollIntervalMs
        val idx = pollChoices.indexOfFirst { it >= cur }.let { if (it < 0) pollChoices.lastIndex else it }

        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
        }
        root.addView(TextView(ctx).apply {
            text = "越小越跟手，但总线负载越高。\n多个 PID 时总线负载保护会自动降频。"
            textSize = 12f
            setTextColor(androidx.core.content.ContextCompat.getColor(ctx, R.color.text_secondary))
        })
        val sp = Spinner(ctx).apply {
            adapter = ArrayAdapter(
                ctx, android.R.layout.simple_spinner_dropdown_item, pollChoices.map { "$it ms" }
            )
            setSelection(idx)
            setPadding(0, (density * 10).toInt(), 0, 0)
        }
        root.addView(sp)

        MaterialAlertDialogBuilder(ctx)
            .setTitle("轮询间隔（全局）")
            .setView(root)
            .setPositiveButton("确定") { _, _ ->
                val v = pollChoices[sp.selectedItemPosition.coerceIn(0, pollChoices.lastIndex)]
                Store.settings.pollIntervalMs = v
                Store.saveSettings()
                refresh()
                ObdController.toast("轮询间隔：$v ms（下一次轮询即生效）")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 画布名浮标的位置（四角 / 隐藏）。
     *
     * ## 为什么是四角预设而不是自由拖拽
     *
     *  1. 车上这块屏**只会设一次**，四个角足够覆盖所有实际诉求；
     *  2. 自由拖拽要和「横滑翻页」抢同一个横向手势 —— 为了挪两个字把翻页搞坏不划算；
     *  3. 自由坐标会落到「编辑」按钮底下或贴边，又得再加一套避让规则。
     *
     * 真需要任意位置时，正确做法是"长按浮标进入移动态"（那时不翻页），
     * 而不是让它在正常浏览时就能拖。
     */
    private fun showNamePosDialog() {
        // ⚠️ **不要把 `setMessage` 和列表一起用**（v1.20.1 实测踩到）：
        // `MaterialAlertDialogBuilder` 同时收到 message 与 setItems/setSingleChoiceItems 时，
        // **列表会被整个丢掉** —— 对话框只剩标题 + 说明 + 取消，一个选项都没有。
        // 实测判据：`uiautomator dump` 里 `android:id/text1` 节点数为 **0**（不带 message 的
        // 行菜单是 4）。所以说明要么进标题，要么进选项文字。
        val labels = DashCanvas.NAME_POS_NAMES.mapIndexed { i, n ->
            if (i == DashCanvas.NAME_POS_BOTTOM_END) "$n（自动让开「编辑」）" else n
        }.toTypedArray()
        val cur = Store.settings.canvasNamePos.coerceIn(0, labels.lastIndex)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("画布名浮标位置（全局，横滑时位置不变）")
            .setSingleChoiceItems(labels, cur) { d, which ->
                Store.settings.canvasNamePos = which
                Store.saveSettings()
                refresh()
                d.dismiss()
                ObdController.toast("画布名浮标：${DashCanvas.namePosName(which)}")
            }
            .setNegativeButton("取消", null)
            .show()
    }
}
