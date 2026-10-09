package com.icar.obd.ui.dash

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import com.icar.obd.data.AppLog
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.DesignFile
import com.icar.obd.data.Store
import com.icar.obd.obd.RuleEngine
import com.icar.obd.obd.VehicleBus
import com.icar.obd.ui.view.BaseGaugeView
import com.icar.obd.ui.view.DashGridOverlayView
import com.icar.obd.ui.view.GaugeTheme
import com.icar.obd.ui.view.GaugeViewFactory

/**
 * 仪表盘渲染器：把 [GaugeItem] 列表变成可实时更新的**自由画布**。
 *
 * **它只做两件事**：
 *   1) 按 [GaugeItem] 的归一化坐标建视图（布局）
 *   2) 定时从 [VehicleBus] 取值 + 从 [RuleEngine] 取覆盖色，推给视图
 *
 * 它不发起任何总线请求，也不认识 BLE —— 数据层与渲染层在这里彻底分开。
 * 因此「换一套仪表盘」= 换一个 List<GaugeItem>，不影响任何采集逻辑。
 *
 * ## 为什么从网格改成自由画布（v1.5.0）
 *
 * 旧版是 2/3/4 列网格 + `span` 跨列，仪表**不能任意摆放**，也就没法做
 * 「线型图占满上半屏、四数据挤在右下角」这类布局。现在每条仪表自带
 * `x/y/w/h`（归一化 0..1），画布尺寸只影响像素换算，不影响布局语义 ——
 * 手机竖屏与平板横屏共用同一份配置。
 *
 * ## 参考线
 *
 * [DashGridOverlayView] 作为画布的**第一个子 View**（z 序最底），
 * 所以永远盖不住仪表。开关与密度来自 [Store.settings]。
 */
class DashRenderer(
    private val container: FrameLayout,
    private val emptyView: TextView
) {

    private class Cell(val item: GaugeItem, val view: BaseGaugeView, val host: FrameLayout)

    private val cells = ArrayList<Cell>()

    /**
     * v2 的**节点树渲染器**。与上面的 [cells]（扁平仪表）并存：
     * v2 走节点树，v1 仍走 cells 那条老路 —— 两条路的推值逻辑是共用的。
     */
    private val nodeRenderer = NodeTreeRenderer(container.context)

    /** 最近一次渲染的完整设计（v2 才有；用于 relayout 与状态系统） */
    private var lastDesign: DesignFile? = null
    private val main = Handler(Looper.getMainLooper())
    private var running = false

    private var lastSpec: List<GaugeItem> = emptyList()
    private var lastTheme: GaugeTheme = GaugeTheme.of(GaugeTheme.NEON)
    private var lastW = 0
    private var lastH = 0

    /**
     * **是否已经收到过一次规格**（v1.20.1 加）。
     *
     * [relayout] 在首次渲染之前必须直接返回 —— 见那里的注释。
     * 初值是 `false`，[render] / [renderDesign] 一进来就置位（**在尺寸判断之前**：
     * 容器还没尺寸时 `lastSpec` 也已经记下了，relayout 正该拿它去补渲染）。
     */
    private var hasRendered = false

    /** 参考线覆盖层。常驻容器底部，不随每次渲染重建 */
    private val overlay = DashGridOverlayView(container.context)

    private val ticker = object : Runnable {
        override fun run() {
            if (!running) return
            pushValues()
            main.postDelayed(this, REFRESH_MS)
        }
    }

    init {
        container.addView(
            overlay,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        // 宽或高变了就重排（旋转、分屏、折叠屏展开都会走到这里）。
        // 归一化坐标本身与尺寸无关，重排只是把 0..1 重新换算成像素。
        container.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob ->
            if (r - l != orr - ol || b - t != ob - ot) relayout()
        }
    }

    /** 重建全部仪表。spec 为空时显示空态提示。 */
    fun render(spec: List<GaugeItem>, theme: GaugeTheme) {
        lastSpec = spec
        lastTheme = theme
        hasRendered = true
        // v2 渲染会把空态文案改成"这套设计渲染不出任何东西…"，切回 v1 必须还原，
        // 否则 v1 空盘时会显示一句完全不相干的 v2 原因（v1.20.3）
        if (emptyView.text != EMPTY_TEXT_V1) emptyView.text = EMPTY_TEXT_V1
        applyOverlay(theme)

        val cw = container.width
        val ch = container.height
        // 首次布局前尺寸为 0：先记下规格，等 onLayoutChange 再来一次
        //
        // ⚠️ v1.19.21：这里以前是**静默 return**，而调用方（DashFragment）那行
        // 「渲染仪表盘 | count=N」是**无条件打印**的 —— 于是日志说"渲染了 8 个表"、
        // 画布上却一个都没有，而且**从日志完全看不出**。
        // 现在把"没渲染成"的原因打出来：一条日志就能定性。
        if (cw <= 0 || ch <= 0) {
            AppLog.w(
                AppLog.M_UI, "仪表盘渲染推迟：容器还没有尺寸",
                "cw=$cw ch=$ch spec=${spec.size}（等 onLayoutChange 重排）"
            )
            return
        }

        clearCells()
        val valid = spec.filter { it.pidId.isNotBlank() && Store.findPid(it.pidId) != null }
        if (valid.isEmpty()) {
            // 同样：以前只显示空态、不打原因 —— 而"为什么一条都留不下"才是要看的
            AppLog.w(
                AppLog.M_UI, "仪表盘无可渲染的表：PID 全部查不到",
                "spec=${spec.size} ids=${spec.joinToString(",") { it.pidId.ifBlank { "(空)" } }.take(120)}"
            )
            emptyView.visibility = View.VISIBLE
            lastW = cw; lastH = ch
            return
        }
        emptyView.visibility = View.GONE
        lastW = cw; lastH = ch

        val ctx = container.context
        val density = ctx.resources.displayMetrics.density
        val margin = (density * CELL_MARGIN_DP).toInt()

        for (item in valid) {
            val host = FrameLayout(ctx).apply {
                // 单块表可覆盖卡片外观（无边框 / 完全透明 / 不画卡片）。
                // 返回 null = 不画卡片底 —— 此时 background 留空，少一次绘制
                background = theme.cardBackgroundFor(item.cardStyle, density)
                val pad = (density * 4).toInt()
                setPadding(pad, pad, pad, pad)
            }
            val view = createView(ctx, item.style)
            view.bind(
                item,
                Store.findPid(item.pidId),
                theme,
                item.extraPids.map { Store.findPid(it) }
            )
            host.addView(
                view,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )

            // 画布单位（每轴 0..CANVAS）→ 像素。留出 margin 作为卡片间距。
            val wpx = ((item.w / GaugeItem.CANVAS * cw).toInt() - margin * 2).coerceAtLeast(1)
            val hpx = ((item.h / GaugeItem.CANVAS * ch).toInt() - margin * 2).coerceAtLeast(1)
            val lp = FrameLayout.LayoutParams(wpx, hpx).apply {
                leftMargin = (item.x / GaugeItem.CANVAS * cw).toInt() + margin
                topMargin = (item.y / GaugeItem.CANVAS * ch).toInt() + margin
            }
            container.addView(host, lp)
            cells.add(Cell(item, view, host))
        }
        pushValues()
        scheduleSizeCheck()
        // 成功路径也留一条（有界：每次渲染一行）—— 和上面两条失败日志一起，
        // 让「到底渲染没渲染」**只靠日志就能定性**，不用再去量像素
        AppLog.d(AppLog.M_UI, "仪表盘已落盘", "表=${valid.size} 容器=${cw}x${ch}")
    }

    /** 尺寸变化后按上一次的规格重排 */
    /**
     * v2：按**节点树**渲染整个设计。
     *
     * 与 [render]（扁平仪表）的分工：
     *  - 这里负责图片 / 分组 / 文字 / 变换 / 图层顺序 / 缩放模式
     *  - 仪表节点仍然走 [GaugeViewFactory] + [BaseGaugeView.bind]，与 v1 完全一致
     *
     * ⚠️ **必须在布局完成之后调**（容器尺寸为 0 时算不出坐标）。
     * 尺寸为 0 就先记下来，等 onLayoutChange 再来一次。
     */
    fun renderDesign(design: DesignFile, theme: GaugeTheme) {
        lastDesign = design
        lastTheme = theme
        hasRendered = true
        applyOverlay(theme)

        val cw = container.width
        val ch = container.height
        if (cw <= 0 || ch <= 0) return

        clearCells()
        // 清掉上一次节点树建出来的 View（overlay 是常驻的第一个子 View，要留着）
        while (container.childCount > 1) container.removeViewAt(container.childCount - 1)

        nodeRenderer.setTheme(theme)
        nodeRenderer.setDesign(design)
        val built = nodeRenderer.build(design.nodes, container, design, cw, ch)
        val rpt = nodeRenderer.lastReport
        lastW = cw
        lastH = ch

        // ⚠️ **一行日志定性**（v1.20.3）：以前这条链上一个日志都没有，
        // "画布是空的"只能靠猜（实机为此查了两轮）。现在无论成败都打一行，有问题再补明细。
        AppLog.i(
            AppLog.M_UI, "设计渲染",
            "节点=${rpt.totalNodes} 建出=$built 跳过(未绑通道)=${rpt.skippedNoPid.size} " +
                "跳过(未知类型)=${rpt.skippedUnknownType.size} 素材缺失=${rpt.missingAssets.size}"
        )
        if (rpt.skippedNoPid.isNotEmpty()) {
            AppLog.w(AppLog.M_UI, "设计里有节点绑了 PID 库里没有的通道", rpt.skippedNoPid.joinToString(", "))
        }
        if (rpt.skippedUnknownType.isNotEmpty()) {
            AppLog.w(AppLog.M_UI, "设计里有不认识的节点类型", rpt.skippedUnknownType.joinToString(", "))
        }
        if (rpt.missingAssets.isNotEmpty()) {
            AppLog.w(AppLog.M_UI, "设计里的素材加载不到", rpt.missingAssets.joinToString(", "))
        }

        if (built == 0) {
            // 空态**必须说清为什么**。原来这里只有 XML 里那句
            // "请先连接设备并在「PID」页启用通道" —— 那是 **v1 的提示**，
            // 对 v2 设计完全不对路，用户看了只会更糊涂（实机反馈就是"还是不会显示"）。
            emptyView.text = v2EmptyReason(rpt)
            emptyView.visibility = View.VISIBLE
        } else {
            emptyView.visibility = View.GONE
        }
        // v1 那条自检（见 scheduleSizeCheck）在 v2 这条路上同样需要
        scheduleSizeCheck()
    }

    /** v2 设计的空态原因。**要说人话** —— 用户看不懂"PID 全部查不到"这种内部话 */
    private fun v2EmptyReason(r: NodeTreeRenderer.BuildReport): String = buildString {
        append("这套设计渲染不出任何东西\n")
        if (r.skippedNoPid.isNotEmpty()) append("· ").append(r.skippedNoPid.size).append(" 个节点绑的通道不存在\n")
        if (r.skippedUnknownType.isNotEmpty()) append("· ").append(r.skippedUnknownType.size).append(" 个节点类型不认识\n")
        if (r.missingAssets.isNotEmpty()) append("· ").append(r.missingAssets.size).append(" 个素材加载不到\n")
        if (!r.hasTrouble) append("· 设计里没有可见节点\n")
        append("（详见日志「设计渲染」）")
    }

    /**
     * 尺寸变化后按上一次的规格重排。
     *
     * ## ⚠️⚠️ 为什么**必须 post 到下一轮消息**，不能在这里同步重建（v1.20.12 修的 P0）
     *
     * 这个方法唯一的调用者是 [init] 里那个 `container.addOnLayoutChangeListener` ——
     * 而它是在 **`View.layout()` 内部**被回调的。
     *
     * 在 layout 期间 `addView` 出来的子 View，父容器**这一轮的 `onMeasure` 已经跑完**，
     * 于是它**永远不会被 measure**；`FrameLayout.onLayout` 取
     * `getMeasuredWidth()/getMeasuredHeight()`（都是 0）把它摆成 **0×0 @ (0,0)**。
     * 症状：8 块表**都在 View 树上**（`childCount=9`、日志照打「仪表盘已落盘 | 表=8」），
     * 但屏幕上一块都看不见 —— 用户原话：
     * **「当规则 toast 弹出提示的时候、整个画布都会不见」**。
     *
     * ### 触发链（已用 logcat 实测钉死，不是推测）
     *
     * ```
     * 规则动作 toast → ObdController.handleAction → emitAlert
     *   → DashFragment.onAlert → showAlert：alertBanner VISIBLE
     *   → fragment_dash.xml 是 LinearLayout，pager 是 weight=1 → pager 高度 2272 → 2164
     *   → gaugeGrid 尺寸变化 → 走到这里 → 在 layout 里重建 → 8 块表 0×0
     * 4 秒后告警条收起 → 高度 2164 → 2272 → **又**在 layout 里重建一次 → 仍然 0×0
     * ```
     *
     * 所以它**不会自愈**：只有切页 / 旋转这类"在 layout 之外"的重建路径才会恢复
     * （实测：滑到设置页再滑回来，画布立刻回来 —— 这正是当初定位它的突破口）。
     *
     * ### 为什么 post 就对了
     *
     * `post` 的重建发生在**这一轮 traversal 之外**，`addView` 正常触发下一轮
     * measure + layout + draw，所以**不会闪**（不存在"先画一帧空的再补"）。
     * 判定本身抽到了 [CanvasRebuildPolicy]（纯逻辑，有单测）。
     */
    fun relayout() {
        // ⚠️ **首次渲染之前不能走这条路**（v1.20.1 修）。
        //
        // `lastSpec` 的初值是空列表，而容器的 `addOnLayoutChangeListener` 在
        // **第一次布局**（0,0,0,0 → 0,0,W,H）就会触发这里 —— 于是"还没有任何规格"
        // 被当成"规格是空的"，打出一条**误导性的**
        // `仪表盘无可渲染的表：PID 全部查不到 | spec=0`，并把空态提示闪一下。
        //
        // 为什么多画布之后必须挡：每一页都有自己的渲染器，而**非当前页故意不渲染**
        // （见 DashCanvasPageFragment.setPageActive）—— 那些页面被布局时
        // 100% 会走到这里，日志里会堆一排查不出所以然的"PID 全部查不到"。
        if (!CanvasRebuildPolicy.needsRebuild(
                hasRendered, container.width, container.height, lastW, lastH
            )
        ) return
        postRebuild()
    }

    /** 已经排了一次待重建（同一帧里连续几次尺寸变化只重建一次） */
    private var rebuildPosted = false

    /**
     * 把"按上一次的规格重建"排到下一轮消息里。**所有重建都必须走这里** ——
     * 理由见 [relayout] 的类注释（layout 期间 addView 的子 View 不会被 measure）。
     */
    private fun postRebuild() {
        if (rebuildPosted) return
        rebuildPosted = true
        container.post {
            rebuildPosted = false
            // 排队期间尺寸可能又变了（也可能已经变回来）—— 再判一次，省一次无谓重建
            if (!CanvasRebuildPolicy.needsRebuild(
                    hasRendered, container.width, container.height, lastW, lastH
                )
            ) return@post
            val d = lastDesign
            if (d != null) renderDesign(d, lastTheme) else render(lastSpec, lastTheme)
        }
    }

    /** 自检已经补过一次重建（只补一次，避免"补了还是 0 尺寸"时死循环） */
    private var healed = false

    /**
     * 重建之后的**自检**：等这次布局跑完，量一下每块表的真实尺寸。
     *
     * ## 为什么必须有它
     *
     * `0×0` 那种失败**在 View 树上和日志里都看不出来**：`childCount` 正常、
     * `仪表盘已落盘 | 表=8` 照打、`uiautomator dump` 里那一层甚至整个消失
     * （因为它 `isVisibleToUser=false` 被跳过）—— 只有**像素**能看出来。
     * 这正是这次 P0 拖到"用户报了两轮"才定位的原因。
     *
     * 所以这里在**布局结束之后**（`OnGlobalLayoutListener`）量一次真实尺寸：
     * 发现 0 尺寸就记一条 W（让下一次能一条日志定性），并补重建一次。
     */
    private fun scheduleSizeCheck() {
        val vto = container.viewTreeObserver
        vto.addOnGlobalLayoutListener(object : android.view.ViewTreeObserver.OnGlobalLayoutListener {
            override fun onGlobalLayout() {
                val obs = container.viewTreeObserver
                if (obs.isAlive) obs.removeOnGlobalLayoutListener(this)

                val sizes = ArrayList<Pair<Int, Int>>(container.childCount)
                // 0 号是常驻的参考线覆盖层（MATCH_PARENT），不参与判定
                for (i in 1 until container.childCount) {
                    val c = container.getChildAt(i)
                    sizes.add(c.width to c.height)
                }
                val bad = CanvasRebuildPolicy.zeroSizedCount(sizes)
                if (bad == 0) {
                    healed = false
                    return
                }
                val heal = CanvasRebuildPolicy.shouldHeal(bad, sizes.size, healed)
                AppLog.w(
                    AppLog.M_UI, "画布有 0 尺寸的表（屏幕上就是'画布不见了'）",
                    "0尺寸=$bad/${sizes.size} 容器=${container.width}x${container.height} " +
                        "补重建=$heal（若反复出现，说明又有人在 layout 期间动了 View 树）"
                )
                if (heal) {
                    healed = true
                    postRebuild()
                }
            }
        })
    }

    private fun clearCells() {
        cells.forEach { container.removeView(it.host) }
        cells.clear()
    }

    private fun applyOverlay(theme: GaugeTheme) {
        val s = Store.settings
        overlay.linesEnabled = s.gridEnabled
        overlay.cols = s.gridCols
        overlay.rows = s.gridRows
        overlay.style = s.gridStyle
        overlay.strokeDp = s.gridStrokeDp
        // 参考线颜色由主题派生，**不写死 RGB**（否则换主题会串色）
        overlay.color = (theme.tick and 0x00FFFFFF) or (s.gridAlpha.coerceIn(0, 255) shl 24)
    }

    /** 样式 → View 的映射统一在 [GaugeViewFactory]，避免编辑器与渲染器分叉 */
    private fun createView(ctx: Context, style: Int): BaseGaugeView =
        GaugeViewFactory.create(ctx, style)

    private fun pushValues() {
        // ---- v2 节点树里的仪表
        nodeRenderer.gauges.forEach { cell ->
            val values = cell.item.allPidIds().map { id ->
                VehicleBus.get(id)?.takeIf { it.ok }?.value
            }
            val override = RuleEngine.colorOf(cell.item.pidId)
            cell.view?.updateMulti(values, override)
            if (cell.view?.wantsHistory == true) {
                cell.view?.updateHistory(VehicleBus.historyOf(cell.item.pidId))
            }
        }
        // ---- 子部件拼装的仪表：值由 5Hz 推入（部件视图不是 BaseGaugeView）
        nodeRenderer.partsViews.forEach { pv ->
            // **一次取齐它需要的全部 PID**（多指针表可能有多个）
            val vals = HashMap<String, Float>()
            pv.neededPids().forEach { id ->
                VehicleBus.get(id)?.takeIf { it.ok }?.value?.let { vals[id] = it }
            }
            if (vals.isNotEmpty()) pv.setValues(vals)
        }

        // ---- 状态系统：按 PID 值换图 / 闪灯
        // 用 5Hz 这个 tick 算闪烁相位就够了（默认 blinkMs=200 正好一个 tick），
        // **不引入第二个动画驱动**
        if (nodeRenderer.stateCells.isNotEmpty()) {
            nodeRenderer.applyStates(
                { id -> VehicleBus.get(id)?.takeIf { it.ok }?.value },
                android.os.SystemClock.uptimeMillis()
            )
        }

        cells.forEach { cell ->
            // 主参数 + 副参数一次取齐交给视图；视图自己不去读总线（红线 4.1.5）
            val values = cell.item.allPidIds().map { id ->
                VehicleBus.get(id)?.takeIf { it.ok }?.value
            }
            val override = RuleEngine.colorOf(cell.item.pidId)
            cell.view?.updateMulti(values, override)
            // 只有趋势图需要历史；列表拷贝不贵，但没必要给每个视图都拷一遍
            if (cell.view?.wantsHistory == true) {
                cell.view?.updateHistory(VehicleBus.historyOf(cell.item.pidId))
            }
        }
    }

    fun start() {
        if (running) return
        running = true
        main.post(ticker)
    }

    fun stop() {
        running = false
        main.removeCallbacks(ticker)
    }

    /** 自定义仪表盘里被删除的 PID 需要清理，避免出现「未绑定」死块 */
    fun pruneOrphans() {
        val removed = Store.customGauges.filter { Store.findPid(it.pidId) == null }
        if (removed.isNotEmpty()) {
            Store.customGauges.removeAll(removed)
            Store.saveDash()
        }
    }

    companion object {
        /** 5Hz 刷新：高于 OBD 轮询率，保证不丢帧，同时足够省电 */
        private const val REFRESH_MS = 200L
        /** 卡片间距（dp）。归一化坐标算完像素后再扣，保证每块之间留缝 */
        private const val CELL_MARGIN_DP = 3f
        /**
         * v1 空态的默认文案（与 `fragment_dash_canvas.xml` 里 `tvDashEmpty` 的初值一致）。
         * v2 渲染会临时改写它，所以切回 v1 时要还原。
         */
        private const val EMPTY_TEXT_V1 = "没有可显示的通道\n请先连接设备并在「PID」页启用通道"
    }
}
