package com.icar.obd.ui.dash

import android.graphics.Bitmap
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.DashCanvas
import com.icar.obd.data.DashLayout
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.PidMerge
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.DashFragment
import com.icar.obd.ui.view.DashCanvasEditorView
import com.icar.obd.ui.view.DashboardBackground
import com.icar.obd.ui.view.GaugeTheme
import com.icar.obd.ui.view.PositionedBackgroundDrawable
import com.icar.obd.ui.view.TiledBackgroundDrawable

/**
 * **一套画布的页面**（ViewPager2 的一页）。
 *
 * ## 它取代了什么
 *
 * v1.19.x 里「仪表盘」是一个 Fragment 管全局三选一 + 一个独立的
 * `DashEditorActivity` 管拖拽。现在每套画布有自己的页面，编辑**就地**进行 ——
 *
 * | 好处 | 说明 |
 * |---|---|
 * | 编辑时能看到真实背景 / 主题 | 旧编辑器是整屏换页，配的背景图在编辑时反而看不见 |
 * | 拖表盘与横滑的冲突**有地方解决** | 旧版编辑在另一个 Activity 里，这个冲突根本不存在，也就永远没被处理 |
 * | 每套画布互不影响 | 页面只渲染**自己那一套**（[DashSpec.buildFor]），不会因为"当前画布"没切而串台 |
 *
 * ## 关键约定：只有"当前页"才渲染
 *
 * ViewPager2 的相邻页在滑动时会被创建，而 `Fragment` 一旦创建就处于 RESUMED ——
 * 如果每页都在跑 5Hz 推值，横滑几下就会有好几个渲染器同时空转。
 * 所以渲染/停止由宿主 [DashFragment] 通过 [setPageActive] 统一控制，
 * **本 Fragment 自己不看 `onResume`**（`onResume` 对"页是否可见"没有发言权）。
 */
class DashCanvasPageFragment : Fragment() {

    companion object {
        const val ARG_CANVAS_ID = "canvasId"

        /** 仪表盘渲染引擎，与 `Store.Settings.dashEngine` 对应 */
        private const val ENGINE_ANDROID = 0
        private const val ENGINE_LVGL = 1

        private val styleNames = listOf(
            "圆形指针表", "数字大屏", "横向条形",
            "线型图", "双数据 + 上下", "四数据显示", "主 + 子双数据", "G力值"
        )
        private val spanNames = listOf("半宽（并排两个）", "整行（独占一行）")
    }

    /** 本页负责哪一套画布（宿主在 `createFragment` 时灌进来） */
    val canvasId: String get() = arguments?.getString(ARG_CANVAS_ID).orEmpty()

    private lateinit var canvasArea: FrameLayout
    private lateinit var grid: FrameLayout
    private lateinit var lvgl: com.icar.obd.ui.lvgl.LvglDashView
    private lateinit var empty: TextView
    private lateinit var editor: DashCanvasEditorView
    private lateinit var tvName: TextView
    private lateinit var editBar: View
    private lateinit var tvHint: TextView
    private lateinit var btnSnap: MaterialButton

    private var renderer: DashRenderer? = null

    /** 宿主判定"这一页正被看着"。渲染与 5Hz 推值都以它为准 */
    private var pageActive = false

    /** 就地编辑态。为 true 时宿主会关掉横滑（拖表盘与翻页会打架） */
    private var editing = false

    /** 背景图缓存。每次 render 都重新解码会把主线程卡住，所以按路径缓存 */
    private var bgBitmap: Bitmap? = null
    private var bgLoadedPath: String = ""

    /** 霓虹档位。第 0 项是"跟随主题"，与 `GaugeItem.neonPreset = null` 对应 */
    private val neonNames = listOf("跟随主题") + com.icar.obd.ui.view.NeonStyle.PRESETS.map { it.first }

    // ---------------------------------------------------------------- 生命周期

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_dash_canvas, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        canvasArea = view.findViewById(R.id.canvasArea)
        grid = view.findViewById(R.id.gaugeGrid)
        lvgl = view.findViewById(R.id.lvglDash)
        empty = view.findViewById(R.id.tvDashEmpty)
        editor = view.findViewById(R.id.editorCanvas)
        tvName = view.findViewById(R.id.tvCanvasName)
        editBar = view.findViewById(R.id.editBar)
        tvHint = view.findViewById(R.id.tvEditorHint)
        btnSnap = view.findViewById(R.id.btnSnap)

        renderer = DashRenderer(grid, empty)

        editor.onChange = { updateHint() }
        editor.onSelect = { updateHint() }

        // v1.20.2：画布页**没有**「编辑」按钮了 —— 入口在设置页的操作菜单里
        // （用户要求）。这里不再挂任何编辑入口。
        view.findViewById<MaterialButton>(R.id.btnAdd).setOnClickListener { showEditDialog(-1) }
        view.findViewById<MaterialButton>(R.id.btnEditGauge).setOnClickListener {
            if (editor.selected < 0) ObdController.toast("先点选一个仪表") else showEditDialog(editor.selected)
        }
        view.findViewById<MaterialButton>(R.id.btnDeleteGauge).setOnClickListener {
            if (editor.selected < 0) ObdController.toast("先点选一个仪表")
            else editor.removeSelected()
        }
        view.findViewById<MaterialButton>(R.id.btnFrontGauge).setOnClickListener {
            if (editor.selected < 0) ObdController.toast("先点选一个仪表")
            else editor.bringSelectedToFront()
        }
        view.findViewById<MaterialButton>(R.id.btnPreset).setOnClickListener { showPresetPicker() }
        view.findViewById<MaterialButton>(R.id.btnGrid).setOnClickListener { toggleGrid() }
        btnSnap.setOnClickListener { toggleSnap() }
        view.findViewById<MaterialButton>(R.id.btnDone).setOnClickListener { exitEdit() }
    }

    override fun onResume() {
        super.onResume()
        // 自己不决定渲染 —— 由宿主统一裁决（见类注释）
        (parentFragment as? DashFragment)?.onPageLifecycleChanged()
    }

    override fun onPause() {
        super.onPause()
        // 编辑中被打断（切页 / 开别的 Activity）时别把改动丢了 —— 与旧编辑器一致
        if (editing) saveGauges()
        renderer?.stop()
    }

    // ---------------------------------------------------------------- 宿主接口

    /**
     * 宿主裁决："这一页现在是不是唯一被看着的那一页"。
     *
     * @param active true = 渲染 + 起推值；false = 停推值（省电，也避免多页同时空转）
     */
    fun setPageActive(active: Boolean) {
        val v = view
        if (v == null || !isAdded) {
            pageActive = false
            return
        }
        pageActive = active
        if (active) {
            if (editing) return          // 编辑态不重渲染：会把编辑器盖掉
            renderer?.pruneOrphans()     // 只在"当前这一套"上清死块，见 DashRenderer.pruneOrphans
            render()
        } else {
            renderer?.stop()
        }
    }

    /** 宿主从别的页切回来 / 从编辑器回来时调，保证改动立即生效 */
    fun refreshIfActive() {
        if (pageActive && !editing) render()
    }

    fun isEditing(): Boolean = editing

    /**
     * 宿主（设置页的操作菜单）要求"进编辑态"。
     *
     * v1.20.2：编辑入口从画布页右下角搬到了设置页 —— 画布页上不再有任何编辑按钮。
     * 语义与原来点按钮**完全一致**（内置布局仍然会先问"用哪一份表"），
     * 所以这里直接走 [requestEdit]，不另开一条路。
     */
    fun enterEditFromHost() {
        if (editing) return
        if (view == null || !isAdded) return
        requestEdit()
    }

    // ---------------------------------------------------------------- 渲染

    private fun canvas(): DashCanvas? =
        Store.settings.canvases.firstOrNull { it.id == canvasId } ?: Store.activeCanvas()

    /**
     * 渲染**这一套画布**。
     *
     * 与旧 `DashFragment.render()` 的唯一区别：所有取值来自 [canvas] 而**不是**
     * `Store.settings` —— 横滑时非当前页也会走到这里，读 settings 的话
     * 每一页都会显示"当前画布"的盘面（滑过去像没切换，最难查的一类不一致）。
     */
    private fun render() {
        val c = canvas() ?: return
        if (view == null) return
        applyNameLabel(c)

        val theme = GaugeTheme.resolveFor(c.designJson, c.theme)
        applyEngine()
        if (Store.settings.dashEngine == ENGINE_LVGL) {
            lvgl.applyTheme(theme)
            lvgl.applyGrid()
            lvgl.buildLayout(DashSpec.buildFor(c))
            AppLog.d(AppLog.M_UI, "渲染画布(LVGL)", "canvas=${c.name} theme=${theme.id}")
            return
        }
        applyBackground(c, theme)

        val design = if (DashSpec.useDesignFile(c.type, c.designJson)) {
            runCatching { com.icar.obd.data.DesignFile.parse(c.designJson) }.getOrNull()?.design
        } else null

        if (design != null) {
            // 多页面：按画布自己记的那一页取节点。**越界夹到最后一页** ——
            // 换设计文件后旧索引可能超范围，夹住比崩溃好。
            val pages = design.pages
            val pick = if (pages.isNotEmpty()) {
                design.copy(nodes = pages[c.pageIndex.coerceIn(0, pages.size - 1)].nodes)
            } else design
            renderer?.renderDesign(pick, theme)
            AppLog.d(
                AppLog.M_UI, "渲染画布(v2)",
                "canvas=${c.name} nodes=${pick.nodes.size} page=${c.pageIndex}/${design.pages.size}"
            )
        } else {
            val spec = DashSpec.buildFor(c)
            renderer?.render(spec, theme)
            AppLog.d(
                AppLog.M_UI, "渲染画布",
                "canvas=${c.name} type=${c.type} theme=${theme.id} count=${spec.size}"
            )
        }
    }

    /**
     * 画布名浮标：位置 + 文案。
     *
     * 位置是**全局偏好**（`Store.settings.canvasNamePos`）—— 跟着画布走的话，
     * 横滑时小字会在四个角之间乱跳。文案是本页这一套的名字。
     *
     * 用 `layout_gravity` + `padding` 而不是 margin：padding 在四个角上都等价于
     * "离边多远"，一套值就够；margin 得为每个角各算一遍 start/end 组合。
     */
    private fun applyNameLabel(c: DashCanvas?) {
        val pos = Store.settings.canvasNamePos.coerceIn(0, DashCanvas.NAME_POS_HIDDEN)
        if (pos == DashCanvas.NAME_POS_HIDDEN || editing || c == null) {
            tvName.visibility = View.GONE
            return
        }
        tvName.visibility = View.VISIBLE
        tvName.text = c.name

        val gravity: Int
        when (pos) {
            DashCanvas.NAME_POS_TOP_END -> gravity = Gravity.TOP or Gravity.END
            DashCanvas.NAME_POS_BOTTOM_START -> gravity = Gravity.BOTTOM or Gravity.START
            // v1.20.2：右下角**不再需要让位**了 —— 「编辑」按钮已经从画布页搬走
            // （用户要求：编辑放到设置页的操作菜单里）。所以四个角现在是等价的。
            DashCanvas.NAME_POS_BOTTOM_END -> gravity = Gravity.BOTTOM or Gravity.END
            else -> gravity = Gravity.TOP or Gravity.START
        }
        val lp = tvName.layoutParams as FrameLayout.LayoutParams
        lp.gravity = gravity
        tvName.layoutParams = lp

        val h = dp(12)
        val v = dp(6)
        tvName.setPadding(h, v, h, v)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    /**
     * 两个引擎二选一。
     *
     * 用 `GONE` 而不是 `INVISIBLE` 是关键：`GONE` 会销毁 SurfaceView 的 Surface，
     * 从而触发 `surfaceDestroyed` → `nativeDestroy()`，把 C 侧的渲染线程收掉。
     * `INVISIBLE` 不会，那样切回 Android 引擎后 LVGL 线程还在空转。
     */
    private fun applyEngine() {
        val lvglOn = Store.settings.dashEngine == ENGINE_LVGL
        lvgl.visibility = if (lvglOn) View.VISIBLE else View.GONE
        grid.visibility = if (lvglOn) View.GONE else View.VISIBLE
        if (lvglOn) renderer?.stop() else renderer?.start()
    }

    /**
     * 背景：设了图片就用图片，否则用主题底色。
     *
     * 铺法取值与 `DesignFile.FIT_*` 同源 —— **不引入第二套枚举**：
     *  - 0 铺满     → `FILL`（centerCrop：裁掉溢出部分，不留黑边）
     *  - 1 完整显示 → `FIT_CENTER`（留黑边但不丢内容）
     *  - 2 居中     → `CENTER`（1:1 像素，适合精确对位的设计稿）
     *
     * ⚠️ 宿主是 [canvasArea] 而**不是**页面根：编辑态工具条会占掉高度，
     * 画在根上的话 `PositionedBackgroundDrawable` 的换算会与实际画布尺寸对不上。
     */
    private fun applyBackground(c: DashCanvas, theme: GaugeTheme) {
        val path = c.bgImagePath
        if (path.isBlank()) {
            canvasArea.setBackgroundColor(theme.background)
            bgBitmap = null
            bgLoadedPath = ""
            return
        }
        if (bgLoadedPath != path) {
            bgBitmap = DashboardBackground.load(path)
            bgLoadedPath = path
        }
        val bmp = bgBitmap
        if (bmp == null) {
            // 文件没了（被清理/换机）→ 静默回落纯色，不打断使用
            canvasArea.setBackgroundColor(theme.background)
            return
        }
        // 平铺：**不能**走 BitmapDrawable —— 它铺的是原图尺寸，而下采样后的图很大，
        // 铺出来只看到 1~2 块。用专门的 Drawable（先缩再铺）。
        // 指定了设计尺寸 → 按那块矩形画，而不是铺满
        if (c.bgW > 0 && c.bgH > 0 && canvasArea.width > 0 && canvasArea.height > 0) {
            // 换算与 NodeTreeRenderer 同一套（0..360 画布单位 → 像素），否则背景会与控件对不上
            val vp = NodeTreeRenderer.computeViewport(c.scaleMode, canvasArea.width, canvasArea.height)
            canvasArea.background = PositionedBackgroundDrawable(
                bmp,
                vp.x(0f).toInt(), vp.y(0f).toInt(),
                (c.bgW * vp.pxX).toInt(), (c.bgH * vp.pxY).toInt()
            )
            return
        }
        if (c.bgFit == com.icar.obd.data.DesignFile.FIT_TILE) {
            canvasArea.background = TiledBackgroundDrawable(bmp)
            return
        }
        val gravity = when (c.bgFit) {
            // ⚠️ 0 是 BitmapDrawable 的**默认** gravity，语义正是「等比缩放、完整放进边界」
            // （可能留黑边）。`android.view.Gravity.FIT_CENTER` 这个常量**并不公开**，
            // 所以这里写字面量 0 并留注释 —— 别改成 Gravity.FIT_CENTER，编不过。
            com.icar.obd.data.DesignFile.FIT_FIT -> 0
            // 居中原始大小：1:1 像素，适合精确对位的设计稿
            com.icar.obd.data.DesignFile.FIT_CENTER -> android.view.Gravity.CENTER
            // FIT_FILL（0）与任何未知取值都回落到"铺满"（centerCrop）
            else -> android.view.Gravity.FILL
        }
        canvasArea.background = android.graphics.drawable.BitmapDrawable(resources, bmp).apply {
            setGravity(gravity)
        }
    }

    // ---------------------------------------------------------------- 编辑态

    /**
     * 进入编辑。
     *
     * 内置布局（普通 / 性能）**不能直接拖** —— 它们的内容来自 [DashLayout]，
     * 拖了也存不回（`DashSpec.buildFor` 按类型取，不看画布里的表）。
     *
     * ## ⚠️ 这里原来有个会**静默销毁用户作品**的坑（v1.20.2 修）
     *
     * 旧实现只有两个按钮（转为自定义并编辑 / 取消），确认后 `convertToCustom`
     * 直接 `customGauges.clear()` + 填内置布局 —— 而**画布里本来可能存着用户攒的一整套表**
     * （迁移过来的、或从自定义切回内置时留下的）。
     *
     * 实机证据（2026-10-06 23:52）：
     * ```
     * [23:52:03] 渲染画布 | canvas=默认 type=0 count=8      ← 画布是「普通驾驶」
     * [23:52:06] 画布已转为自定义 | canvas=默认 原类型=普通驾驶 gauges=8
     * ```
     * 用户的 11 块表就这么没了（`dash.json` 3730 → 2509 字节），而且只弹了一句
     * "已转为自定义布局"。用户的原话是"**画布不显示我做好的内容**" —— 一点没错。
     *
     * 现在：**只要画布里存着表，就必须让用户选哪一份**，默认是"保留我的"。
     */
    private fun requestEdit() {
        val c = canvas() ?: return
        if (c.type == DashSpec.CUSTOM) {
            startEdit()
            return
        }
        // 当前画布的工作区就是 customGauges，所以它的大小 = 这一套里存着的表数
        val existing = Store.customGauges.size
        val builder = MaterialAlertDialogBuilder(requireContext())
            .setTitle("「${c.name}」是内置布局")
        if (existing > 0) {
            builder
                .setMessage(
                    "现在显示的是内置的「${DashCanvas.typeName(c.type)}」布局，\n" +
                        "但这一套里还存着你自己做的 $existing 块表。\n\n" +
                        "转成「自定义仪表」后要显示哪一份？"
                )
                .setPositiveButton("保留我的 $existing 块表") { _, _ ->
                    convertToCustom(c, keepExisting = true)
                    startEdit()
                }
                .setNeutralButton("用内置布局覆盖") { _, _ ->
                    convertToCustom(c, keepExisting = false)
                    startEdit()
                }
                .setNegativeButton("取消", null)
        } else {
            builder
                .setMessage(
                    "「${DashCanvas.typeName(c.type)}」的内容来自内置布局，不能拖拽摆放。\n\n" +
                        "转成「自定义仪表」后可以任意摆放 —— 会用现在这一套的内容作为起点，" +
                        "内置布局本身不受影响。"
                )
                .setPositiveButton("转为自定义并编辑") { _, _ ->
                    convertToCustom(c, keepExisting = false)
                    startEdit()
                }
                .setNegativeButton("取消", null)
        }
        builder.show()
    }

    /**
     * 内置布局 → 自定义布局。
     *
     * @param keepExisting **true = 保留画布里已有的表**（非破坏性，只把类型翻成自定义）；
     *   false = 用内置布局的内容覆盖（旧行为，只在用户明确选了"覆盖"时走）。
     *
     * ⚠️ `keepExisting=false` 时**必须同时清掉 `designJson`**：内置布局与手改产出的是
     * v1 扁平表，而 v2 设计文件在「自定义」这一层**优先级更高** —— 不清的话
     * "转了自定义但画面一点没变"（v1.17.7 实测踩过：一份残留的测试设计挡住 8 个表）。
     */
    private fun convertToCustom(c: DashCanvas, keepExisting: Boolean) {
        if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)
        // ⚠️ **原类型必须在改之前抓下来**（v1.20.1 修）。
        // 下面 `Store.settings.dashType = CUSTOM` + `saveDash()` 会经
        // `snapshotToActiveCanvas()` 把 `c.type` 就地同步成 CUSTOM ——
        // 之后再读 `c.type` 打日志，就会打出"原类型=自定义仪表"这种**自己骗自己**的行
        // （实测第一版就是这样，日志里完全看不出它原本是普通/性能）。
        val fromType = c.type
        val kept = Store.customGauges.size
        if (!keepExisting) {
            val seed = DashSpec.buildFor(c)
            Store.customGauges.clear()
            Store.customGauges.addAll(seed)
            Store.settings.designJson = ""
            Store.settings.dashPageIndex = 0
        }
        Store.settings.dashType = DashSpec.CUSTOM
        Store.saveDash()
        AppLog.i(
            AppLog.M_UI, "画布已转为自定义",
            "canvas=${c.name} 原类型=${DashCanvas.typeName(fromType)} " +
                "内容=${if (keepExisting) "保留原有的 $kept 块" else "用内置布局覆盖（原有 $kept 块）"} " +
                "现在=${Store.customGauges.size} 块"
        )
        ObdController.toast(
            if (keepExisting) "已转为自定义，保留你的 $kept 块表" else "已转为自定义布局"
        )
    }

    private fun startEdit() {
        val c = canvas() ?: return
        // 安全网：编辑改的是 Store.customGauges（= 当前画布的工作区），
        // 页面与 activeCanvasId 万一不同步，这里先对齐 —— 否则会改到别的一套上
        if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)

        editing = true
        renderer?.stop()

        editBar.visibility = View.VISIBLE
        editor.visibility = View.VISIBLE
        grid.visibility = View.GONE
        lvgl.visibility = View.GONE
        empty.visibility = View.GONE
        tvName.visibility = View.GONE

        val theme = GaugeTheme.of(Store.settings.gaugeTheme)
        editor.submit(Store.customGauges.toList(), theme, Store.settings.gridEnabled)
        editor.setSnapEnabled(Store.settings.dashSnapEnabled)
        refreshSnapButton()
        updateHint()
        // 关掉横滑：拖表盘与翻页会抢同一个横向手势
        notifyHostEditing(true)
        AppLog.i(AppLog.M_UI, "进入画布编辑态", "canvas=${c.name} gauges=${Store.customGauges.size}")
    }

    private fun exitEdit() {
        if (!editing) return
        saveGauges()
        editing = false

        editBar.visibility = View.GONE
        editor.visibility = View.GONE
        grid.visibility = View.VISIBLE
        // 不直接置 VISIBLE：位置可能是"隐藏"（见 applyNameLabel）
        applyNameLabel(canvas())

        notifyHostEditing(false)
        // 只有"正被看着"才重渲染并起推值 —— 否则会替一个看不见的页面开定时器
        if (pageActive) render() else renderer?.stop()
    }

    /**
     * 通知宿主"编辑态变了"（宿主据此开关横滑）。
     *
     * 拿不到宿主时**必须留下日志**：那意味着"编辑态禁用横滑"这条约定静默失效，
     * 而它的表现只是"拖表盘时偶尔翻页"，不写日志根本查不出来。
     */
    private fun notifyHostEditing(on: Boolean) {
        val host = parentFragment as? DashFragment
        if (host == null) {
            AppLog.w(
                AppLog.M_UI, "编辑态未能通知宿主",
                "parentFragment=${parentFragment?.javaClass?.simpleName} 不是 DashFragment" +
                    " —— 编辑时横滑不会被禁用"
            )
            return
        }
        host.onPageEditing(on)
    }

    private fun saveGauges() {
        Store.customGauges.clear()
        Store.customGauges.addAll(editor.currentItems())
        Store.saveDash()
        AppLog.i(
            AppLog.M_UI, "画布已保存",
            "canvas=${canvas()?.name} count=${Store.customGauges.size}"
        )
    }

    private fun updateHint() {
        val sel = editor.selectedItem()
        val snap = if (Store.settings.dashSnapEnabled) {
            "坐标吸附到 1/24 网格（每格 ${"%.0f".format(DashLayout.Drag.STEP)} 单位）"
        } else {
            "自由摆放（吸附已关，可停在任意坐标）"
        }
        tvHint.text = if (sel == null) {
            "还没有仪表，点「添加」开始 · 拖动移动，右下角方块缩放 · $snap"
        } else {
            val name = Store.findPid(sel.pidId)?.name ?: "未绑定"
            val style = styleNames.getOrElse(sel.style) { "样式${sel.style}" }
            "已选：$name · $style · ${(sel.w / GaugeItem.CANVAS * 100).toInt()}% × " +
                "${(sel.h / GaugeItem.CANVAS * 100).toInt()}% · $snap"
        }
    }

    private fun refreshSnapButton() {
        btnSnap.text = if (Store.settings.dashSnapEnabled) "吸附开" else "吸附关"
    }

    private fun toggleGrid() {
        Store.settings.gridEnabled = !Store.settings.gridEnabled
        Store.saveSettings()
        editor.setGridVisible(Store.settings.gridEnabled)
        ObdController.toast(if (Store.settings.gridEnabled) "参考线已开" else "参考线已关")
    }

    private fun toggleSnap() {
        Store.settings.dashSnapEnabled = !Store.settings.dashSnapEnabled
        Store.saveSettings()
        editor.setSnapEnabled(Store.settings.dashSnapEnabled)
        refreshSnapButton()
        updateHint()
    }

    private fun showPresetPicker() {
        val presets = DashLayout.presets()
        // ⚠️ **不要把 `setMessage` 和列表一起用**（v1.20.1 实测踩到）：
        // `MaterialAlertDialogBuilder` 同时收到 message 与 setItems 时**列表会被整个丢掉**
        // （对话框只剩标题+说明+取消）。说明改放标题里 —— 标题会换行，撑得住。
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("套用预设（会覆盖这一套画布的内容）")
            .setItems(presets.map { "${it.title} —— ${it.description}" }.toTypedArray()) { _, which ->
                Store.customGauges.clear()
                Store.customGauges.addAll(presets[which].build())
                // 预设是 v1 扁平表；v2 设计文件优先级更高，不清掉会"套了预设但什么都没变"
                Store.settings.designJson = ""
                Store.saveDash()
                val theme = GaugeTheme.of(Store.settings.gaugeTheme)
                editor.submit(Store.customGauges.toList(), theme, Store.settings.gridEnabled)
                editor.setSnapEnabled(Store.settings.dashSnapEnabled)
                updateHint()
                ObdController.toast("已套用：${presets[which].title}")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 字段对话框

    /**
     * 新增仪表的初始位置：从现有内容最底部往下排一条整宽。
     *
     * 只是「别叠在一起」的兜底 —— 真正的摆放靠拖拽。
     * 画布放满时回落到顶部半宽（会重叠，拖开即可）。
     */
    private fun nextSlot(): FloatArray {
        val bottom = editor.currentItems()
            .maxOfOrNull { (it.y + it.h).coerceIn(0f, GaugeItem.CANVAS) } ?: 0f
        val h = 0.25f
        return if (bottom + h <= 1.0001f) floatArrayOf(0f, bottom, 1f, h)
        else floatArrayOf(0f, 0f, 0.5f, 0.25f)
    }

    private fun showEditDialog(index: Int) {
        val existing: GaugeItem? = if (index >= 0) editor.itemAt(index) else null
        // ⚠️ 列表里把"已合并的同义条目"收起来（v1.20.13，见 data/PidMerge.kt），
        // 但**这块表当前绑的 id 必须保留**：下面 `indexOfFirst` 找不到时 spinner 会停在
        // 0 号（发动机转速），点一下「确定」就把老仪表**静默改成转速表**了。
        val pids: List<PidDefinition> = PidMerge.filterForList(
            Store.allPids(), setOfNotNull(existing?.pidId)
        )
        if (pids.isEmpty()) {
            ObdController.toast("没有可用通道，请先添加 PID")
            return
        }

        val v = layoutInflater.inflate(R.layout.dialog_gauge_edit, null)
        val spPid = v.findViewById<Spinner>(R.id.spPid)
        val spStyle = v.findViewById<Spinner>(R.id.spStyle)
        val spSpan = v.findViewById<Spinner>(R.id.spSpan)
        val spNeon = v.findViewById<Spinner>(R.id.spNeon)
        val spCard = v.findViewById<Spinner>(R.id.spCard)
        val etMin = v.findViewById<EditText>(R.id.etMin)
        val etMax = v.findViewById<EditText>(R.id.etMax)
        val etWarnLow = v.findViewById<EditText>(R.id.etWarnLow)
        val etWarnHigh = v.findViewById<EditText>(R.id.etWarnHigh)

        val ctx = requireContext()
        spPid.adapter = ArrayAdapter(
            ctx, android.R.layout.simple_spinner_dropdown_item,
            pids.map { "${it.name}  [${it.requestString()}]${if (it.unit.isBlank()) "" else "  ${it.unit}"}" }
        )
        spStyle.adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, styleNames)
        spSpan.adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, spanNames)
        // 第 0 项是"跟随主题"（neonPreset = null），后面才是具体档位
        spNeon.adapter = ArrayAdapter(ctx, android.R.layout.simple_spinner_dropdown_item, neonNames)
        // 卡片外框：0..3 与 GaugeItem.CARD_* 一一对应，所以下标就是取值
        spCard.adapter = ArrayAdapter(
            ctx, android.R.layout.simple_spinner_dropdown_item, GaugeItem.CARD_NAMES
        )

        // 选通道时自动带入建议量程，减少手工输入
        spPid.setOnItemSelectedListener(object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, vv: View?, pos: Int, id: Long) {
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
            spCard.setSelection(
                (existing.cardStyle ?: GaugeItem.CARD_THEME).coerceIn(0, GaugeItem.CARD_NAMES.lastIndex)
            )
            etMin.setText(fmt(existing.minVal))
            etMax.setText(fmt(existing.maxVal))
            etWarnLow.setText(existing.warnLow?.let { fmt(it) } ?: "")
            etWarnHigh.setText(existing.warnHigh?.let { fmt(it) } ?: "")
        }

        MaterialAlertDialogBuilder(ctx)
            .setTitle(if (existing == null) "添加仪表" else "编辑仪表")
            .setView(v)
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
                    editor.refresh()
                } else {
                    val slot = nextSlot()
                    editor.add(
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
                            // ⚠️ 必须用画布单位（0..CANVAS）—— 归一化的 0.5 在 360 单位下
                            // 只有 0.14% 宽，新加的仪表会是一条缝（坐标迁移时踩过）
                            w = if (full) GaugeItem.CANVAS else GaugeItem.CANVAS * 0.5f,
                            h = slot[3]
                        )
                    )
                }
                updateHint()
                AppLog.i(AppLog.M_UI, "仪表已编辑", "pid=${pid.name} style=$style")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun fmt(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else f.toString()
}
