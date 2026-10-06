package com.icar.obd.ui.dash

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import com.icar.obd.data.DesignFile
import com.icar.obd.data.DesignNode
import com.icar.obd.data.GaugeFont
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.NodeState
import com.icar.obd.data.Store
import com.icar.obd.ui.view.BaseGaugeView
import com.icar.obd.ui.view.DashboardBackground
import com.icar.obd.ui.view.GaugeTheme
import com.icar.obd.ui.view.GaugePartsView
import com.icar.obd.ui.view.GaugeViewFactory
import com.icar.obd.obd.VehicleBus
import kotlin.math.max
import kotlin.math.min

/**
 * `icar.ui/2` **节点树的渲染器**。
 *
 * ## 为什么单独一个类
 *
 * 原来的 [DashRenderer] 处理"扁平的仪表列表"：一个 item 一个宿主 FrameLayout。
 * v2 是**树**（分组可嵌套）+ 图片/文字 + 变换（旋转/缩放/透明度）+ 图层顺序。
 * 递归建 View 这件事和"5Hz 推值"是两件独立的职责，混在一起会很难读。
 *
 * ## 坐标与缩放（**必须与工具侧一致**）
 *
 * 节点坐标是 0..360（每轴独立）。映射到像素有三种模式：
 *
 * | 模式 | 换算 | 用途 |
 * |---|---|---|
 * | `SCALE_STRETCH` | `px = 坐标/360 × 屏宽`（每轴独立） | v1 行为，默认 |
 * | `SCALE_FIT` | 等比 `k = min(cw,ch)/360`，居中留边 | 有圆形/图片，不能变形 |
 * | `SCALE_FILL` | 等比 `k = max(cw,ch)/360`，超出裁切 | 背景图 |
 *
 * ## 变换的语义（**与工具侧、与节点模型一致**）
 *
 * - `x/y` **相对父节点**
 * - `rotation` 绕自身中心（`View.setRotation` 的 pivot 默认就是中心）
 * - `scale` 在 `w/h` 之上的额外倍率（`View.setScaleX/Y` 同样绕中心）
 * - `alpha` 直接映射
 * - 子节点在**父节点的坐标系**里排布，所以父级旋转时子级跟着转
 *
 * > ⚠️ 工具侧是在**设备空间**施加旋转的（先排好版、再旋转）。
 * > Android 的 `View.setRotation` 语义**正好相同** —— 它转的是已经布局好的 View。
 * > 两端因此天然一致，不需要额外换算。
 */
class NodeTreeRenderer(private val context: Context) {

    /** 一个已渲染的仪表（5Hz 推值要用） */
    class GaugeCell(val node: DesignNode, val item: GaugeItem, val view: BaseGaugeView?)

    /** 一个带状态系统的图片（5Hz 换图 / 闪灯要用） */
    class StateCell(val node: DesignNode, val view: ImageView, val states: Map<String, NodeState>)

    val gauges = ArrayList<GaugeCell>()
    val stateCells = ArrayList<StateCell>()

    /** 用子部件拼装的仪表（v2.12.0）。它们的值由 5Hz tick 推入 */
    val partsViews = ArrayList<GaugePartsView>()

    /** 素材位图缓存：路径 → Bitmap。**必须缓存** —— 每次 render 都解码会卡住主线程 */
    private val bitmaps = HashMap<String, Bitmap?>()

    private var t: Viewport = Viewport(1f, 1f, 0f, 0f)

    /**
     * 画布 → 像素的换算。
     *
     * @param pxX 每"画布单位"多少像素（x 轴）
     * @param pxY 每"画布单位"多少像素（y 轴）
     * @param offX / offY 居中留边时的偏移（fit/fill 用，stretch 是 0）
     */
    data class Viewport(val pxX: Float, val pxY: Float, val offX: Float, val offY: Float) {
        fun x(v: Float) = offX + v * pxX
        fun y(v: Float) = offY + v * pxY
    }

    /**
     * 计算换算。
     *
     * ⚠️ 放在 companion 里（而不是实例方法）是**有意的**：它是**纯数学**，
     * 不依赖 Context / 不依赖 View。这样单测能直接调它，
     * 不用去造一个跑不起来的 Android 环境（单测 classpath 里没有 MockContext）。
     */
    companion object {
        fun computeViewport(scaleMode: Int, cw: Int, ch: Int): Viewport {
        val c = GaugeItem.CANVAS
        return when (scaleMode) {
            DesignFile.SCALE_FIT -> {
                val k = min(cw / c, ch / c)
                Viewport(k, k, (cw - c * k) / 2f, (ch - c * k) / 2f)
            }
            DesignFile.SCALE_FILL -> {
                val k = max(cw / c, ch / c)
                Viewport(k, k, (cw - c * k) / 2f, (ch - c * k) / 2f)
            }
            // stretch（默认）：每轴独立 —— **v1 的行为，不能改**
            else -> Viewport(cw / c, ch / c, 0f, 0f)
        }
    }
    }   // ← 关 companion object（它只放纯数学的 computeViewport）

    /**
     * 最近一次 [build] 的**诊断**（v1.20.3）。
     *
     * ## 为什么必须有它
     *
     * 设计里的节点会因为三种原因**被静默跳过 / 静默变空**：
     * ① 绑的 PID 在库里找不到 ② 节点类型不认识 ③ **素材加载失败**
     * （相对路径拼不出绝对路径、或文件根本不在）。三种的表现**完全一样**：
     * 画布上一片空白，**日志里一个字都没有**。
     *
     * 实机踩到（2026-10-06）：用户的设计由**控件（素材图片）**拼成，
     * 而 `designBaseDir` **全项目没有任何地方赋值** → 相对路径永远拼不出来 →
     * 所有素材加载失败 → 表盘只剩空卡片。用户报的是
     * "画布不显示我做好的内容、显示是空的"，而我们**查了两轮都没定位到** ——
     * 就是因为这条链上一个日志都没有。
     */
    data class BuildReport(
        val built: Int = 0,
        /** 绑的 PID 在库里找不到的节点（`节点id(pid)`） */
        val skippedNoPid: List<String> = emptyList(),
        /** 类型不认识的节点（`节点id(type)`） */
        val skippedUnknownType: List<String> = emptyList(),
        /** 解析不到 / 解码失败的素材 */
        val missingAssets: List<String> = emptyList(),
    ) {
        /** 设计里一共有多少个节点（建出来的 + 跳过的） */
        val totalNodes: Int get() = built + skippedNoPid.size + skippedUnknownType.size
        val hasTrouble: Boolean
            get() = skippedNoPid.isNotEmpty() || skippedUnknownType.isNotEmpty() ||
                missingAssets.isNotEmpty()
    }

    private val rptNoPid = ArrayList<String>()
    private val rptUnknown = ArrayList<String>()
    private val rptAssets = ArrayList<String>()

    /** 每种问题最多记几条 —— 与项目其它日志一样**有界**，防洪水 */
    private val RPT_MAX = 8

    /** 最近一次 [build] 的诊断。画布空了的时候，这是唯一能说清原因的东西 */
    var lastReport: BuildReport = BuildReport()
        private set

    private fun rec(list: ArrayList<String>, item: String) {
        if (list.size < RPT_MAX && !list.contains(item)) list.add(item)
    }

    /**
     * 建一棵节点树。
     *
     * @param parent 挂到哪里（通常是画布容器）
     * @return 建出来的 View 数量（0 表示没有可见节点）
     */
    fun build(nodes: List<DesignNode>, parent: ViewGroup, design: DesignFile, cw: Int, ch: Int): Int {
        gauges.clear()
        stateCells.clear()
        rptNoPid.clear(); rptUnknown.clear(); rptAssets.clear()
        t = computeViewport(design.scaleMode, cw, ch)
        val n = buildInto(nodes, parent, design)
        lastReport = BuildReport(n, rptNoPid.toList(), rptUnknown.toList(), rptAssets.toList())
        return n
    }

    private fun buildInto(nodes: List<DesignNode>, parent: ViewGroup, design: DesignFile): Int {
        var n = 0
        // **按 z 升序 addView** —— 后加的盖在上面，与"z 大者在上"一致
        for (node in nodes.sortedBy { it.z }) {
            if (!node.visible) continue
            val v = buildNode(node, design) ?: continue
            parent.addView(v, layoutParams(node))
            applyTransform(v, node)
            n++
        }
        return n
    }

    private fun layoutParams(node: DesignNode): FrameLayout.LayoutParams {
        val w = (node.w * t.pxX).toInt().coerceAtLeast(1)
        val h = (node.h * t.pxY).toInt().coerceAtLeast(1)
        return FrameLayout.LayoutParams(w, h).apply {
            leftMargin = t.x(node.x).toInt()
            topMargin = t.y(node.y).toInt()
        }
    }

    /**
     * 变换。**rotation / scale 都绕 View 中心** —— 这正是节点模型的定义，
     * 也是 Android 的默认 pivot，所以不需要额外设置。
     */
    private fun applyTransform(v: View, node: DesignNode) {
        v.alpha = (node.alpha / 255f).coerceIn(0f, 1f)
        if (node.rotation != 0f) v.rotation = node.rotation
        if (node.scale != 1f) {
            v.scaleX = node.scale
            v.scaleY = node.scale
        }
        // 锁定的节点在设备上不可交互 —— 目前仪表盘本来也不响应触摸，
        // 但显式关掉可以避免将来加了手势之后"锁了个寂寞"
        v.isClickable = !node.locked
    }

    private fun buildNode(node: DesignNode, design: DesignFile): View? = when {
        node.isGroup -> buildGroup(node, design)
        node.isImage -> buildImage(node)
        node.isText -> buildText(node)
        node.isGauge -> buildGauge(node)
        else -> {
            // 类型不认识 —— 以前**静默返回 null**：画布上少一块，而日志里没有任何线索
            rec(rptUnknown, "${node.id}(${node.type})")
            null
        }
    }

    /** 分组：一个透明 FrameLayout，子节点在它的坐标系里排布 */
    private fun buildGroup(node: DesignNode, design: DesignFile): View {
        val g = FrameLayout(context)
        // 分组本身不画任何东西（与工具侧一致）—— 它只是变换与层级的容器
        g.clipChildren = false
        buildInto(node.children, g, design)
        return g
    }

    private fun buildImage(node: DesignNode): View {
        val iv = ImageView(context)
        iv.scaleType = ImageView.ScaleType.FIT_XY
        iv.setImageBitmap(loadAsset(assetPathOf(node, null)))
        // 有状态系统：5Hz 时按 PID 值换图（见 applyStates）
        // ⚠️ 先取到局部变量：`node.states` 是**跨模块**的 public 属性，
        // Kotlin 不给它做 smart cast（编译报 "Smart cast is impossible"）
        val st = node.states
        if (st != null) stateCells.add(StateCell(node, iv, st))
        return iv
    }

    private fun buildText(node: DesignNode): View {
        val tv = TextView(context)
        tv.text = node.text
        val f = node.font
        tv.typeface = f.typeface()
        // 字号是**画布单位**，要乘换算系数 —— 直接当 px 用换个分辨率就完全不一样
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, (f.size * t.pxY).coerceAtLeast(1f))
        tv.setTextColor(f.color)
        tv.gravity = when (f.align) {
            GaugeFont.ALIGN_CENTER -> Gravity.CENTER_HORIZONTAL or Gravity.CENTER_VERTICAL
            GaugeFont.ALIGN_RIGHT -> Gravity.RIGHT or Gravity.CENTER_VERTICAL
            else -> Gravity.LEFT or Gravity.CENTER_VERTICAL
        }
        // letterSpacing 是 em 单位：字距（画布单位）× pxY ÷ 字号（px）
        val sizePx = (f.size * t.pxY).coerceAtLeast(1f)
        tv.letterSpacing = if (f.letterSpacing != 0f) (f.letterSpacing * t.pxY) / sizePx else 0f
        return tv
    }

    private fun buildGauge(node: DesignNode): View? {
        val item = node.gauge
        if (item == null) {
            rec(rptNoPid, "${node.id}(gauge 字段缺失)")
            return null
        }
        // 与 v1 一样：过滤掉 PID 库里没有的（否则渲染出来是个空壳）。
        // ⚠️ 但**必须记下来** —— 这是"画布是空的"两个最常见原因之一
        // （另一个是素材加载失败）。见 [BuildReport] 的说明。
        if (item.pidId.isBlank() || Store.findPid(item.pidId) == null) {
            rec(rptNoPid, "${node.id}(${item.pidId.ifBlank { "未绑定" }})")
            return null
        }

        val density = context.resources.displayMetrics.density
        val host = FrameLayout(context).apply {
            background = cardDrawable(node, item, density)
            val pad = (density * 4).toInt()
            setPadding(pad, pad, pad, pad)
        }
        // **有子部件就按部件拼装** —— 用户明确说了「我要自己拼」，
        // 就别再叠一层程序化画法。没有部件时下面那套照旧（行为完全不变）。
        val parts = node.parts
        if (parts != null && parts.isNotEmpty()) {
            val pv = GaugePartsView(
                context, item, parts,
                // 部件的 x/y/w/h 是**画布单位**，与节点同级 → 用同一套换算
                t.pxY,
                node.labelFont,
                { id: String -> loadAsset(assetPathOfAsset(id)) }
            )
            pv.setValues(pv.neededPids().associateWith { currentValueOf(it) })
            partsViews.add(pv)
            host.addView(
                pv,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
            gauges.add(GaugeCell(node, item, null))
            return host
        }

        val view = GaugeViewFactory.create(context, item.style)
        view.bind(
            item,
            Store.findPid(item.pidId),
            lastTheme,
            item.extraPids.map { Store.findPid(it) }
        )
        // 表上文字的字体（名字 / PID / 量程）
        view.applyLabelFont(node.labelFont, node.showLabel, node.showRange)
        host.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        gauges.add(GaugeCell(node, item, view))
        return host
    }

    /**
     * 底框 Drawable。
     *
     * 优先级：**节点的 `card` 覆盖 → `cardStyle` 粗档位 → 主题默认**。
     * 与工具侧 `resolveCard()` 同一套语义 —— 两端必须一致，
     * 否则"电脑上看到的"与"设备上看到的"不一样。
     *
     * `card` 存在时**自己建 Drawable**，不走 [GaugeTheme.cardBackgroundFor] ——
     * 那个只认 4 个粗档位，表达不了"半透明 + 大圆角"。
     */
    private fun cardDrawable(
        node: DesignNode,
        item: GaugeItem,
        density: Float
    ): android.graphics.drawable.Drawable? {
        val c = node.card ?: return lastTheme.cardBackgroundFor(item.cardStyle, density)

        // cardStyle 的"透明/不画"仍然生效，除非 card.show 显式覆盖
        val style = item.cardStyle ?: 0
        var show = style != 2 && style != 3
        c.show?.let { show = it }
        if (!show) return null

        // 没显式设 alpha 就用主题的卡片不透明度（原来只有主题级能调）
        val alpha = c.alpha ?: lastTheme.cardAlpha
        // 圆角是**画布单位**，要乘 density 换成像素
        val radiusPx = (c.radius ?: 6f) * density
        return android.graphics.drawable.GradientDrawable().apply {
            shape = android.graphics.drawable.GradientDrawable.RECTANGLE
            cornerRadius = radiusPx
            setColor(lastTheme.surface)
            // cardStyle=1（无边框）只去描边，保留底色
            if (style != 1) setStroke((density * 1f).toInt().coerceAtLeast(1), lastTheme.surfaceEdge)
            this.alpha = alpha.coerceIn(0, 255)
        }
    }

    private var lastTheme: GaugeTheme = GaugeTheme.of(GaugeTheme.NEON)

    fun setTheme(theme: GaugeTheme) {
        lastTheme = theme
    }

    // ================================================================ 素材

    private fun assetPathOf(node: DesignNode, stateAsset: String?): String {
        val id = stateAsset?.takeIf { it.isNotBlank() } ?: node.assetId
        if (id.isBlank()) return ""
        val a = lastDesign?.assets?.firstOrNull { it.id == id }
        if (a == null) {
            rec(rptAssets, "素材 id 未定义: $id")
            return ""
        }
        return a.path
    }

    /** 按**素材 id** 取路径（部件的 assetId 是 id，不是 path） */
    private fun assetPathOfAsset(assetId: String): String {
        if (assetId.isBlank()) return ""
        val a = lastDesign?.assets?.firstOrNull { it.id == assetId }
        if (a == null) {
            rec(rptAssets, "素材 id 未定义: $assetId")
            return ""
        }
        return a.path
    }

    /** 一个 PID 的当前值。**必须走总线**（红线 4.1.5：视图不自己去读） */
    private fun currentValueOf(pid: String): Float {
        val def = Store.findPid(pid) ?: return 0f
        return VehicleBus.get(pid)?.takeIf { it.ok }?.value ?: def.minVal
    }

    private var lastDesign: DesignFile? = null

    fun setDesign(design: DesignFile) {
        lastDesign = design
    }

    /**
     * 加载素材位图。**带缓存** —— 每次 render 都解码会把主线程卡住
     * （一张平板背景解码几十毫秒，而 render 在旋屏/切页时都会调）。
     *
     * 路径解析：绝对路径直接用；相对路径（`assets/xxx.png`）拼到设计文件的基目录上。
     */
    private fun loadAsset(path: String): Bitmap? {
        if (path.isBlank()) return null
        if (bitmaps.containsKey(path)) return bitmaps[path]
        val resolved = resolveAssetPath(path)
        val bmp = runCatching { DashboardBackground.load(resolved) }.getOrNull()
        if (bmp == null) {
            // ⚠️ 这是"画布是空的"**最常见的第二个原因**，以前完全静默。
            // 相对路径 + `designBaseDir` 为空 → 拼出来还是个相对路径，必然读不到。
            rec(
                rptAssets,
                if (resolved == path) "$path（相对路径，designBaseDir 为空）" else resolved
            )
        }
        bitmaps[path] = bmp
        return bmp
    }

    private fun resolveAssetPath(path: String): String {
        if (path.startsWith("/")) return path
        val base = Store.settings.designBaseDir
        if (base.isBlank()) return path
        return if (base.endsWith("/")) base + path else "$base/$path"
    }

    /** 设计文件换了 / 素材改了 → 清缓存，下次重新解码 */
    fun invalidateAssets() {
        bitmaps.clear()
    }

    // ================================================================ 状态系统

    /**
     * 按 PID 值决定图片节点显示哪个状态。
     *
     * ## 迟滞（**必须与 [com.icar.obd.ui.view.AlertPulse] 同一套语义**）
     *
     * 数值在阈值附近抖动时不能让灯乱闪。这里复用仪表报警的那套迟滞：
     * 升档要超过阈值 + 回差，降档要低于阈值 − 回差。
     *
     * ## 闪烁
     *
     * `blink = true` 的状态按 `blinkMs` 周期切换可见性。
     * **不引入第二个动画驱动** —— 用现有的 5Hz tick 算相位就够了
     * （默认 200ms 正好一个 tick）。
     *
     * @param valueOf 取某个 PID 当前值（null = 没数据）
     * @param nowMs   当前时间（算闪烁相位）
     */
    fun applyStates(valueOf: (String) -> Float?, nowMs: Long) {
        for (c in stateCells) {
            val st = resolveState(c, valueOf) ?: continue
            val bmp = loadAsset(assetPathOf(c.node, st.assetId))
            if (c.view.drawable == null || c.view.tag != bmp) {
                c.view.setImageBitmap(bmp)
                c.view.tag = bmp
            }
            val blinkOn = if (st.blink) {
                val period = st.blinkMs.coerceAtLeast(60).toLong()
                (nowMs / period) % 2L == 0L
            } else true
            c.view.alpha = if (blinkOn) (st.alpha / 255f).coerceIn(0f, 1f) else 0f
        }
    }

    /**
     * 解析当前状态。阈值来源按优先级：
     *  1. PID 库里的 `warnHigh`（与仪表报警**同一套阈值**，避免"表红了灯还绿"）
     *  2. 没有阈值就恒定 normal
     */
    private fun resolveState(c: StateCell, valueOf: (String) -> Float?): NodeState? {
        val pid = c.node.statePid
        if (pid.isBlank()) return c.states[NodeState.STATE_NORMAL]
        val v = valueOf(pid) ?: return c.states[NodeState.STATE_NORMAL]
        val def = Store.findPid(pid)
        // **显式阈值优先**，没设才从 PID 库推断 ——
        // 不同车/不同传感器的报警线本来就不一样，写死在库里不合理
        val warnAt = c.node.stateWarn ?: def?.warnHigh
        if (warnAt == null) return c.states[NodeState.STATE_NORMAL]
        val max = def?.maxVal ?: 100f
        // "严重"取警告线与量程上限的中点 —— 没单独配置时的合理默认
        val critAt = c.node.stateCritical
            ?: (if (max > warnAt) warnAt + (max - warnAt) * 0.5f else null)

        val cur = c.view.tag as? String ?: NodeState.STATE_NORMAL
        return when {
            critAt != null && v >= critAt -> c.states[NodeState.STATE_CRITICAL]
                ?: c.states[NodeState.STATE_WARN] ?: c.states[NodeState.STATE_NORMAL]
            v >= warnAt -> c.states[NodeState.STATE_WARN] ?: c.states[NodeState.STATE_NORMAL]
            else -> c.states[NodeState.STATE_NORMAL]
        }
    }
}
