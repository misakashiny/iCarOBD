package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.fragment.app.Fragment
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.DashLayout
import com.icar.obd.data.Store
import com.icar.obd.ui.dash.DashRenderer
import com.icar.obd.ui.dash.DashSpec
import com.icar.obd.ui.view.DashboardBackground
import com.icar.obd.ui.view.GaugeTheme
import com.icar.obd.ui.view.PositionedBackgroundDrawable
import com.icar.obd.ui.view.TiledBackgroundDrawable

/**
 * 仪表盘页。
 *
 * 关键设计：本 Fragment **不接触任何数据源**。
 * 它只做三件事：选规格（[DashSpec]）→ 交给 [DashRenderer] 渲染 → 展示告警条。
 * 数据由 [com.icar.obd.obd.ObdEngine] 写入 [com.icar.obd.obd.VehicleBus]，
 * 渲染器定时去取。因此本页可以完全独立地改版，不影响采集链路。
 */
class DashFragment : Fragment(), com.icar.obd.obd.ObdController.Listener {

    private lateinit var toggle: MaterialButtonToggleGroup
    private lateinit var canvas: FrameLayout
    private lateinit var lvgl: com.icar.obd.ui.lvgl.LvglDashView
    private lateinit var empty: TextView
    private lateinit var banner: TextView
    private lateinit var btnEdit: View

    private var renderer: DashRenderer? = null
    private var dashType = DashSpec.NORMAL

    private val main = Handler(Looper.getMainLooper())
    private var hideBanner: Runnable? = null

    /** 背景图缓存。每次 render 都重新解码会把主线程卡住，所以按路径缓存 */
    private var bgBitmap: android.graphics.Bitmap? = null
    private var bgLoadedPath: String = ""

    /** 选背景图片（SAF，不需要存储权限） */
    private val pickBgImage = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val path = DashboardBackground.import(requireContext(), uri)
        if (path == null) {
            com.icar.obd.obd.ObdController.toast("导入图片失败")
            return@registerForActivityResult
        }
        Store.settings.bgImagePath = path
        Store.saveSettings()
        bgLoadedPath = ""   // 强制重载
        render()
        com.icar.obd.obd.ObdController.toast("背景图片已设置")
    }

    /**
     * 导入设计文件（`icar.ui/1`，由 `tools/theme-studio/` 产出）。
     *
     * ## 为什么必须有这个入口（v1.10.3）
     *
     * v1.10.2 之前，PC 端的主题工具**只能产出文件**：`DesignFile.parse` 写好了、
     * 22 个用例守着，但 `app/src/main` 里**一次都没调用过** ——
     * 也就是说「在电脑上改仪表盘」这条路在 App 侧是断的，只能手动 `adb push`。
     * 工具做得再好也流不到设备上。
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
            com.icar.obd.obd.ObdController.toast("读取文件失败")
            return@registerForActivityResult
        }
        importDesign(text)
    }

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
                append("\n\n会**整体替换**当前自定义仪表盘：\n")
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
        // 布局：整体替换自定义仪表盘
        Store.customGauges.clear()
        Store.customGauges.addAll(d.gauges)
        Store.saveDash()

        // v2：把**设计文件原文**存下来，渲染时按节点树走（见 renderDashboard）。
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
                com.icar.obd.obd.ObdController.toast("主题「${d.themeId}」不存在，已保持当前主题")
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
            Store.settings.bgImagePath = b.path
            Store.settings.bgFit = b.fit
            bgLoadedPath = ""   // 强制重载
        }
        Store.saveSettings()

        // 切到「自定义」页签：设计文件改的就是它，停在普通/性能上会看不到变化
        dashType = DashSpec.CUSTOM
        Store.settings.dashType = DashSpec.CUSTOM
        Store.saveSettings()
        toggle.check(R.id.btnDashCustom)
        btnEdit.visibility = View.VISIBLE

        render()
        AppLog.i(
            AppLog.M_UI, "已导入设计文件",
            "name=${d.name} gauges=${d.gauges.size} theme=${d.themeId} bg=${d.background?.path ?: "-"}"
        )
        com.icar.obd.obd.ObdController.toast("已导入 ${d.gauges.size} 块仪表")
    }

    // ---------------------------------------------------------------- 导出设计文件

    /**
     * 把当前自定义仪表盘导出成设计文件，分享出去（v1.10.3）。
     *
     * **闭环的另一半**：没有它，用户在电脑上设计 → 导入 → 再微调 → 就回不到电脑上了，
     * 只能从头重画。
     *
     * 主题写成**别名**而不是数字 id —— 见 [GaugeTheme.aliasOf]。
     */
    private fun exportDesign() {
        if (Store.customGauges.isEmpty()) {
            com.icar.obd.obd.ObdController.toast("自定义仪表盘是空的，先添加几块表")
            return
        }
        val d = com.icar.obd.data.DesignFile(
            name = "仪表盘导出",
            author = "",
            description = "由 App 导出的当前自定义仪表盘",
            // 自建主题没有别名 → 留空（用当前主题），否则导出后导入会报"主题不存在"
            themeId = GaugeTheme.aliasOf(Store.settings.gaugeTheme) ?: "",
            background = Store.settings.bgImagePath.takeIf { it.isNotBlank() }?.let {
                com.icar.obd.data.DesignFile.Background(it, Store.settings.bgFit, Store.settings.bgW, Store.settings.bgH)
            },
            gauges = Store.customGauges.toList()
        )
        val json = d.toJson().toString(2)
        val file = java.io.File(requireContext().cacheDir, "design.json")
        runCatching { file.writeText(json) }.onFailure {
            com.icar.obd.obd.ObdController.toast("导出失败：${it.message}")
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

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_dash, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        toggle = view.findViewById(R.id.dashToggle)
        canvas = view.findViewById(R.id.gaugeGrid)
        lvgl = view.findViewById(R.id.lvglDash)
        empty = view.findViewById(R.id.tvDashEmpty)
        banner = view.findViewById(R.id.alertBanner)
        btnEdit = view.findViewById(R.id.btnEditDash)

        // 画布是自由布局：归一化坐标 → 像素的换算与「尺寸变化后重排」都由渲染器自己处理
        renderer = DashRenderer(canvas, empty).also { it.pruneOrphans() }

        dashType = Store.settings.dashType.coerceIn(0, 2)
        toggle.check(
            when (dashType) {
                DashSpec.PERF -> R.id.btnDashPerf
                DashSpec.CUSTOM -> R.id.btnDashCustom
                else -> R.id.btnDashNormal
            }
        )
        btnEdit.visibility = if (dashType == DashSpec.CUSTOM) View.VISIBLE else View.GONE

        toggle.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            dashType = when (checkedId) {
                R.id.btnDashPerf -> DashSpec.PERF
                R.id.btnDashCustom -> DashSpec.CUSTOM
                else -> DashSpec.NORMAL
            }
            Store.settings.dashType = dashType
            Store.saveSettings()
            btnEdit.visibility = if (dashType == DashSpec.CUSTOM) View.VISIBLE else View.GONE
            render()
        }

        btnEdit.setOnClickListener {
            startActivity(Intent(requireContext(), DashEditorActivity::class.java))
        }
        view.findViewById<View>(R.id.btnDashTheme).setOnClickListener { showThemePicker() }
        view.findViewById<View>(R.id.btnDashPreset).setOnClickListener { showPresetPicker() }
    }

    override fun onResume() {
        super.onResume()
        // 从编辑器返回或切页回来时重建，保证 PID/量程改动立即生效。
        // 渲染器的启停交给 render() → applyEngine() 按当前引擎决定，这里别再 start 一次
        render()
        refreshSimBanner()
        com.icar.obd.obd.ObdController.addListener(this)
    }

    /**
     * `MainActivity` 用 `show`/`hide` 切页，**不会触发 onResume/onPause**。
     * 而「仪表盘引擎」开关是在「连接」页改的 —— 不在这里重渲染，切回来就没反应。
     */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden) {
            render()
            refreshSimBanner()
        }
    }

    /**
     * 常驻显示「模拟数据」提示。
     *
     * 模拟信号是**数据源**，离开模拟器页后仍在跑（见 `SimulatorActivity.onDestroy`），
     * 所以必须让用户一眼看出「现在看到的不是真车数据」。
     *
     * 原来靠「离开模拟器页就自动停」来避免这个误导 —— 代价是**仪表盘永远看不到模拟效果**
     * （提示还写着"切到仪表盘页即可看到效果"，自相矛盾）。现在改成：**数据源留着，用提示兜底**。
     */
    private fun refreshSimBanner() {
        if (com.icar.obd.obd.SignalSimulator.running) {
            hideBanner?.let { main.removeCallbacks(it) }
            hideBanner = null                     // 常驻，不自动隐藏
            banner.text = "⚠ 模拟数据（非真车）· 到「连接 → 模拟信号」关闭"
            banner.visibility = View.VISIBLE
        } else {
            banner.visibility = View.GONE
        }
    }

    override fun onPause() {
        super.onPause()
        renderer?.stop()
        com.icar.obd.obd.ObdController.removeListener(this)
    }

    private companion object {
        /** 仪表盘渲染引擎，与 `Store.Settings.dashEngine` 对应 */
        const val ENGINE_ANDROID = 0
        const val ENGINE_LVGL = 1
    }

    private fun render() {
        val spec = DashSpec.build(dashType)
        // **内嵌配色优先**（P8-5）：设计文件带了 themeColors 就用它，
            // 否则按设置里的主题 id 查。
            //
            // 为什么优先内嵌：设计文件是「作品」，配色是作品的一部分；
            // 跟着设备当前主题走的话，同一份设计在两台机器上长得不一样。
            // 抽到 GaugeTheme.resolveFor 里了（v2.26.0）—Fragment 没法单测，
            // 那段逻辑原来是"写完就没验证过"的状态。现在有 Kotlin 测试钉着。
            val theme = GaugeTheme.resolveFor(
                Store.settings.designJson, Store.settings.gaugeTheme
            )
        applyEngine()
        if (Store.settings.dashEngine == ENGINE_LVGL) {
            // 顺序要紧：主题 → 参考线 → 布局。
            // 主题会置「待重建」标志，而 buildLayout 自己就会重建并清掉那个标志；
            // 参考线必须在布局之前设，因为网格层是建布局时创建的、创建时读这份设置。
            lvgl.applyTheme(theme)
            lvgl.applyGrid()
            lvgl.buildLayout(spec)
            AppLog.d(
                AppLog.M_UI, "渲染仪表盘(LVGL)",
                "type=$dashType theme=${theme.id} count=${spec.size}"
            )
            return
        }
        applyBackground(theme)
        // v2 优先：导入过设计文件就按**节点树**渲染 —— 图片/分组/文字/旋转/图层/缩放模式才生效。
        // 没有就回落到 v1 的扁平仪表路径（行为与以前完全一致）。
        val dj = Store.settings.designJson
        val design = if (dj.isNotBlank())
            runCatching { com.icar.obd.data.DesignFile.parse(dj) }.getOrNull()?.design else null
        if (design != null) {
            // 多页面：按设置里选的那一页取节点。**越界夹到最后一页** ——
            // 换设计文件后旧索引可能超范围，夹住比崩溃好。
            val pages = design.pages
            val pick = if (pages.isNotEmpty()) {
                design.copy(
                    nodes = pages[Store.settings.dashPageIndex.coerceIn(0, pages.size - 1)].nodes
                )
            } else design
            renderer?.renderDesign(pick, theme)
            // ⚠️ 记 **pick** 的节点数，不是 design 的 ——
// 多页面下 design.nodes 永远是第 1 页，记它会让人以为"切页没生效"（实测踩到）。
AppLog.d(
    AppLog.M_UI, "渲染仪表盘(v2)",
    "nodes=${pick.nodes.size} page=${Store.settings.dashPageIndex}/${design.pages.size} " +
    "scaleMode=${design.scaleMode}"
)
        } else {
        renderer?.render(spec, theme)
        AppLog.d(AppLog.M_UI, "渲染仪表盘", "type=$dashType theme=${theme.id} count=${spec.size}")
          }
    }

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
        canvas.visibility = if (lvglOn) View.GONE else View.VISIBLE
        // LVGL 模式下停掉 Android 渲染器的 5Hz 定时器 —— 那些视图已经 GONE，
        // 继续推值纯属白烧电（数据由 LvglDashView 自己推给 C 侧）
        if (lvglOn) renderer?.stop() else renderer?.start()
    }

    /**
     * 背景：设了图片就用图片，否则用主题底色。
     *
     * 图片按**路径**缓存 —— 每次 `render()` 都重新解码会把主线程卡住
     * （平板背景图解码一次几十毫秒，而 render 在旋屏/切页时都会调）。
     *
     * 铺法（v1.10.2）用 `BitmapDrawable` 的 gravity 实现，取值与
     * `DesignFile.FIT_*` 同源 —— **不引入第二套枚举**：
     *  - 0 铺满     → `FILL`（centerCrop：裁掉溢出部分，不留黑边）
     *  - 1 完整显示 → `FIT_CENTER`（留黑边但不丢内容）
     *  - 2 居中     → `CENTER`（1:1 像素，适合精确对位的设计稿）
     */
    private fun applyBackground(theme: GaugeTheme) {
        val path = Store.settings.bgImagePath
        if (path.isBlank()) {
            view?.setBackgroundColor(theme.background)
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
            view?.setBackgroundColor(theme.background)
        } else {
            // 平铺（v1.10.4 新增）：**不能**走 BitmapDrawable —— 它铺的是原图尺寸，
            // 而下采样后的图很大，铺出来只看到 1~2 块。用专门的 Drawable（先缩再铺）。
            // 指定了设计尺寸 → 按那块矩形画，而不是铺满
            val bw = Store.settings.bgW
            val bh = Store.settings.bgH
            val bgView = view
            if (bw > 0 && bh > 0 && bgView != null && bgView.width > 0 && bgView.height > 0) {
                // 换算与 NodeTreeRenderer 同一套（0..360 画布单位 → 像素），
                // 否则背景会与控件对不上
                val vp = com.icar.obd.ui.dash.NodeTreeRenderer.computeViewport(
                    Store.settings.dashScaleMode, bgView.width, bgView.height
                )
                bgView.background = PositionedBackgroundDrawable(
                    bmp,
                    vp.x(0f).toInt(), vp.y(0f).toInt(),
                    (bw * vp.pxX).toInt(), (bh * vp.pxY).toInt()
                )
                return
            }

            if (Store.settings.bgFit == com.icar.obd.data.DesignFile.FIT_TILE) {
                view?.background = TiledBackgroundDrawable(bmp)
                return
            }
            val gravity = when (Store.settings.bgFit) {
                // ⚠️ 0 是 BitmapDrawable 的**默认** gravity，语义正是「等比缩放、完整放进边界」
                // （可能留黑边）。`android.view.Gravity.FIT_CENTER` 这个常量**并不公开**，
                // 所以这里写字面量 0 并留注释 —— 别改成 Gravity.FIT_CENTER，编不过。
                com.icar.obd.data.DesignFile.FIT_FIT -> 0
                // 居中原始大小：1:1 像素，适合精确对位的设计稿
                com.icar.obd.data.DesignFile.FIT_CENTER -> android.view.Gravity.CENTER
                // FIT_FILL（0）与任何未知取值都回落到"铺满"（centerCrop）
                else -> android.view.Gravity.FILL
            }
            view?.background = android.graphics.drawable.BitmapDrawable(resources, bmp).apply {
                setGravity(gravity)
            }
        }
    }

    // ---------------------------------------------------------------- 风格

    private fun showThemePicker() {
        val themes = GaugeTheme.all()
        // 末尾几项是动作项，不是主题 —— 用下标区分
        val extras = listOf(
            "编辑主题…",
            "选择背景图片…",
            if (Store.settings.bgImagePath.isBlank()) "背景图片：未设置" else "清除背景图片",
            "关闭卡片外框（保留卡片底）",
            "卡片完全透明（适合背景图）",
            if (Store.settings.bgImagePath.isBlank()) "背景铺法（未设背景图）"
            else "背景铺法：${com.icar.obd.data.DesignFile.fitName(Store.settings.bgFit)}",
            "导入设计文件…（PC 主题工具产出）",
            "导出当前布局为设计文件…",
        ) + (
            // 「选择页面」**只在多页设计时出现**，而且是加在**末尾** ——
            // 上面的项是按索引匹配的（themes.size + N），插在中间会全错位。
            if (designPages().size > 1) {
                val pg = designPages()
                val i = Store.settings.dashPageIndex.coerceIn(0, pg.size - 1)
                listOf("选择页面：" + pg[i].name + "（" + (i + 1) + "/" + pg.size + "）")
            } else emptyList()
        )
        val labels = themes.map {
            "${it.title}${if (it.custom) "（自建）" else ""}\n${it.description}"
        } + extras
        val selected = themes.indexOfFirst { it.id == Store.settings.gaugeTheme }.coerceAtLeast(0)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("仪表盘风格")
            .setSingleChoiceItems(labels.toTypedArray(), selected) { dialog, which ->
                when (which) {
                    themes.size -> {
                        dialog.dismiss()
                        startActivity(
                            Intent(requireContext(), ThemeEditorActivity::class.java)
                                .putExtra(ThemeEditorActivity.EXTRA_THEME_ID, Store.settings.gaugeTheme)
                        )
                    }
                    themes.size + 1 -> {
                        dialog.dismiss()
                        pickBgImage.launch(arrayOf("image/*"))
                    }
                    themes.size + 2 -> {
                        dialog.dismiss()
                        if (Store.settings.bgImagePath.isNotBlank()) {
                            Store.settings.bgImagePath = ""
                            Store.saveSettings()
                            DashboardBackground.clear(requireContext())
                            bgLoadedPath = ""
                            render()
                            com.icar.obd.obd.ObdController.toast("已清除背景图片")
                        }
                    }
                    // 两个快捷开关：不用进主题编辑器就能去掉外框 / 把卡片做成透明。
                    // 内置主题是只读常量，所以走「另存为自建主题」——与主题编辑器同一条路
                    themes.size + 3 -> {
                        dialog.dismiss()
                        applyCardQuickStyle("无边框", strokeDp = 0f)
                    }
                    themes.size + 4 -> {
                        dialog.dismiss()
                        applyCardQuickStyle("透明卡片", strokeDp = 0f, alpha = 0)
                    }
                    themes.size + 5 -> {
                        dialog.dismiss()
                        showBgFitPicker()
                    }
                    // 「选择页面」永远是**最后一项**。因为它是条件添加的，
                    // 所以用 labels.size - 1 反推，比硬编码索引稳。
                    labels.size - 1 -> {
                        if (designPages().size > 1) {
                            dialog.dismiss()
                            showPagePicker()
                        }
                    }
                    themes.size + 6 -> {
                        dialog.dismiss()
                        openDesignFile.launch(arrayOf("application/json", "text/plain", "*/*"))
                    }
                    themes.size + 7 -> {
                        dialog.dismiss()
                        exportDesign()
                    }
                    else -> {
                        Store.settings.gaugeTheme = themes[which].id
                        Store.saveSettings()
                        render()
                        dialog.dismiss()
                    }
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 预设布局

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
        render()
        com.icar.obd.obd.ObdController.toast(
            if (current.custom) "已更新「${target.title}」" else "已新建主题「${target.title}」"
        )
    }

    /**
     * 背景铺法选择。
     *
     * 三种铺法解决的是**同一个问题**：手机相册里的图与屏幕宽高比几乎不可能一致。
     * 铺满会裁掉边缘（可能把设计稿的水印裁掉），完整显示会留黑边 ——
     * 哪个更好取决于图，所以交给用户选。
     */
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

    /**
     * 选页对话框。
     *
     * 选中后写 dashPageIndex 并**重渲染** —— 不用重启、不用重新导入。
     */
    private fun showPagePicker() {
        val pages = designPages()
        if (pages.size <= 1) {
            com.icar.obd.obd.ObdController.toast("这个设计只有一页")
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
                render()
                com.icar.obd.obd.ObdController.toast("已切到「" + pages[which].name + "」")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showBgFitPicker() {
        if (Store.settings.bgImagePath.isBlank()) {
            com.icar.obd.obd.ObdController.toast("先选一张背景图片")
            return
        }
        val names = com.icar.obd.data.DesignFile.FIT_NAMES
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("背景铺法")
            .setSingleChoiceItems(names.toTypedArray(), Store.settings.bgFit) { d, which ->
                Store.settings.bgFit = which
                Store.saveSettings()
                render()
                d.dismiss()
                com.icar.obd.obd.ObdController.toast("背景铺法：${names[which]}")
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showPresetPicker() {
        val presets = DashLayout.presets()
        MaterialAlertDialogBuilder(requireContext())
            .setTitle("预设布局")
            .setItems(presets.map { "${it.title}\n${it.description}" }.toTypedArray()) { _, which ->
                applyPreset(presets[which])
            }
            .setNeutralButton("参考线…") { _, _ -> showGridDialog() }
            .setNegativeButton("取消", null)
            .show()
    }

    /**
     * 应用预设 = 覆盖「自定义」仪表盘的内容。
     *
     * 之所以顺手切到「自定义」页签：预设改的是 [Store.customGauges]，
     * 停在「普通/性能」页签上会看不到任何变化，容易被当成没生效。
     */
    private fun applyPreset(preset: DashLayout.Preset) {
        Store.customGauges.clear()
        Store.customGauges.addAll(preset.build())
        Store.saveDash()

        Store.settings.dashType = DashSpec.CUSTOM
        Store.saveSettings()
        dashType = DashSpec.CUSTOM
        toggle.check(R.id.btnDashCustom)
        btnEdit.visibility = View.VISIBLE
        render()
        com.icar.obd.obd.ObdController.toast("已应用预设：${preset.title}")
        AppLog.i(AppLog.M_UI, "应用预设布局", "id=${preset.id} count=${Store.customGauges.size}")
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
                render()
                AppLog.i(
                    AppLog.M_UI, "参考线设置",
                    "on=${s.gridEnabled} ${s.gridCols}x${s.gridRows} style=${s.gridStyle}"
                )
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------------------------------------------------------- 告警条

    /** 规则触发时由 [com.icar.obd.obd.ObdController] 回调（在任意线程） */
    override fun onAlert(msg: String) {
        view?.post { showAlert(msg) }
    }

    private fun showAlert(msg: String) {
        banner.text = msg
        banner.visibility = View.VISIBLE
        hideBanner?.let { main.removeCallbacks(it) }
        val r = Runnable {
            banner.visibility = View.GONE
            refreshSimBanner()      // 告警消失后把常驻的「模拟数据」提示恢复
        }
        hideBanner = r
        main.postDelayed(r, 4000)
    }
}
