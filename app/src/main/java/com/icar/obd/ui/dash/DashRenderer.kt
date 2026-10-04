package com.icar.obd.ui.dash

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
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
        applyOverlay(theme)

        val cw = container.width
        val ch = container.height
        // 首次布局前尺寸为 0：先记下规格，等 onLayoutChange 再来一次
        if (cw <= 0 || ch <= 0) return

        clearCells()

        val valid = spec.filter { it.pidId.isNotBlank() && Store.findPid(it.pidId) != null }
        if (valid.isEmpty()) {
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
        lastW = cw
        lastH = ch

        if (built == 0 || nodeRenderer.gauges.isEmpty()) {
            // 一个仪表都没有 → 空态提示。
            // 注意：只有图片/文字也算"有内容"，但没仪表就没数据可显示，
            // 这时候**不**弹空态（否则一张纯背景盘面会被判定为"空"）
            emptyView.visibility = if (built == 0) View.VISIBLE else View.GONE
        } else {
            emptyView.visibility = View.GONE
        }
    }

    fun relayout() {
        if (container.width == lastW && container.height == lastH) return
        val d = lastDesign
        if (d != null) renderDesign(d, lastTheme) else render(lastSpec, lastTheme)
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
    }
}
