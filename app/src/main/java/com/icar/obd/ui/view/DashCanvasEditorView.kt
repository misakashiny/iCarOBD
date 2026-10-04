package com.icar.obd.ui.view

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.ViewGroup
import android.widget.FrameLayout
import com.icar.obd.data.DashLayout
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.Store

/**
 * 拖拽式仪表盘画布。
 *
 * 一个 [ViewGroup]，每个仪表是一个子 View（所以是**所见即所得**的预览），
 * 触摸事件由本控件统一处理（子 View 不可点击）。
 *
 * ## 交互
 *  - 点选：点哪块选哪块，空白处取消选择
 *  - 拖动：按住块内拖动即可移动
 *  - 缩放：按住**右下角手柄**拖动改尺寸
 *  - 吸附：所有坐标吸附到 [GRID] 分之一的网格（1/24 ≈ 4.2%），
 *    这样手抖也能排出整齐的布局
 *
 * ## 坐标系
 *
 * 存的是**归一化 0..1**（与 [GaugeItem] 一致），像素只在这里换算 ——
 * 所以手机竖屏排的布局，到平板横屏上依然成立。
 */
class DashCanvasEditorView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : ViewGroup(context, attrs, def) {

    companion object {
        /** 吸附网格：与 [com.icar.obd.data.DashLayout.Drag.GRID] 同一份定义，避免两处不一致 */
        const val GRID = DashLayout.Drag.GRID
        private const val HANDLE_DP = 26f

        private const val MODE_NONE = 0
        private const val MODE_MOVE = 1
        private const val MODE_RESIZE = 2
    }

    /** 布局改动后回调（用于「保存」按钮的脏标记） */
    var onChange: (() -> Unit)? = null

    /** 选中项变化回调（-1 = 没选中） */
    var onSelect: ((Int) -> Unit)? = null

    private val items = mutableListOf<GaugeItem>()
    private val hosts = mutableListOf<FrameLayout>()

    private var theme: GaugeTheme = GaugeTheme.of(GaugeTheme.NEON)
    private var gridOn = false

    /**
     * 吸附开关。**默认开** —— 与 v1.10.2 之前的行为一致。
     *
     * 由 `DashEditorActivity` 从 `Store.settings.dashSnapEnabled` 灌进来，
     * 关掉后拖动可以停在任意坐标。
     */
    private var snapOn = true

    var selected: Int = -1
        private set

    private var mode = MODE_NONE
    private var downX = 0f
    private var downY = 0f
    private var origX = 0f
    private var origY = 0f
    private var origW = 0f
    private var origH = 0f

    private val selPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val handlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }

    init {
        // ViewGroup 默认不调 onDraw，必须显式打开
        setWillNotDraw(false)
        clipChildren = false
    }

    private fun dp(v: Float): Float = v * resources.displayMetrics.density

    // ---------------------------------------------------------------- 数据

    /**
     * 提交要编辑的列表。
     *
     * 注意：这里**直接持有调用方传进来的 [GaugeItem] 实例**（不拷贝），
     * 拖动时改的就是它们，这样「保存」只需把 [Store.customGauges] 回写即可。
     */
    fun submit(list: List<GaugeItem>, th: GaugeTheme, grid: Boolean) {
        items.clear()
        items.addAll(list)
        theme = th
        gridOn = grid
        selected = items.indices.firstOrNull() ?: -1
        rebuildChildren()
        onSelect?.invoke(selected)
        requestLayout()
        invalidate()
    }

    fun setGridVisible(on: Boolean) {
        gridOn = on
        invalidate()
    }

    /**
     * 吸附开关（v1.10.2）。
     *
     * 关掉后拖动/缩放按原始像素走，可以停在任意坐标 —— 但**边界夹取仍然生效**
     * （见 `DashLayout.Drag.moveIf`），所以不会拖出画布。
     */
    fun setSnapEnabled(on: Boolean) {
        snapOn = on
    }

    fun itemAt(i: Int): GaugeItem? = items.getOrNull(i)

    /** 当前画布上的全部仪表（保存时回写 [Store.customGauges] 用） */
    fun currentItems(): List<GaugeItem> = items.toList()

    fun selectedItem(): GaugeItem? = items.getOrNull(selected)

    fun select(i: Int) {
        if (selected == i) return
        selected = i
        onSelect?.invoke(i)
        invalidate()
    }

    /** 就地改过 [GaugeItem] 的字段后调用：重建子 View 并刷新 */
    fun refresh() {
        rebuildChildren()
        requestLayout()
        invalidate()
        onChange?.invoke()
    }

    fun add(item: GaugeItem) {
        items.add(item)
        rebuildChildren()
        select(items.lastIndex)
        onChange?.invoke()
        requestLayout()
        invalidate()
    }

    fun removeSelected() {
        val i = selected
        if (i !in items.indices) return
        items.removeAt(i)
        selected = items.indices.firstOrNull() ?: -1
        rebuildChildren()
        onSelect?.invoke(selected)
        onChange?.invoke()
        requestLayout()
        invalidate()
    }

    /** 把选中块移到最前（后添加的在上层，避免小块被大块盖住点不到） */
    fun bringSelectedToFront() {
        val i = selected
        if (i !in items.indices || i == items.lastIndex) return
        val it = items.removeAt(i)
        items.add(it)
        selected = items.lastIndex
        rebuildChildren()
        onChange?.invoke()
        requestLayout()
        invalidate()
    }

    private fun rebuildChildren() {
        removeAllViews()
        hosts.clear()
        val ctx = context
        items.forEach { item ->
            val host = FrameLayout(ctx).apply {
                // 与 DashRenderer 用同一个入口，编辑器里看到的边框 = 实际渲染的边框
                background = theme.cardBackgroundFor(item.cardStyle, resources.displayMetrics.density)
                isClickable = false
                isFocusable = false
            }
            val view = GaugeViewFactory.create(ctx, item.style)
            view.bind(item, Store.findPid(item.pidId), theme, item.extraPids.map { Store.findPid(it) })
            host.addView(
                view,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                )
            )
            addView(host)
            hosts.add(host)
        }
    }

    // ---------------------------------------------------------------- 布局

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = MeasureSpec.getSize(heightMeasureSpec)
        setMeasuredDimension(w, h)
        for (i in hosts.indices) {
            val it = items[i]
            hosts[i].measure(
                MeasureSpec.makeMeasureSpec((it.w / GaugeItem.CANVAS * w).toInt().coerceAtLeast(1), MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec((it.h / GaugeItem.CANVAS * h).toInt().coerceAtLeast(1), MeasureSpec.EXACTLY)
            )
        }
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val w = r - l
        val h = b - t
        for (i in hosts.indices) {
            val it = items[i]
            val x = (it.x / GaugeItem.CANVAS * w).toInt()
            val y = (it.y / GaugeItem.CANVAS * h).toInt()
            val cw = (it.w / GaugeItem.CANVAS * w).toInt().coerceAtLeast(1)
            val ch = (it.h / GaugeItem.CANVAS * h).toInt().coerceAtLeast(1)
            hosts[i].layout(x, y, x + cw, y + ch)
        }
    }

    // ---------------------------------------------------------------- 绘制

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        if (gridOn) {
            gridPaint.color = (theme.tick and 0x00FFFFFF) or (70 shl 24)
            gridPaint.strokeWidth = dp(1f)
            for (i in 0..GRID) {
                val x = w * i / GRID
                canvas.drawLine(x, 0f, x, h, gridPaint)
            }
            for (j in 0..GRID) {
                val y = h * j / GRID
                canvas.drawLine(0f, y, w, y, gridPaint)
            }
        }

        val it = items.getOrNull(selected) ?: return
        val l = it.x / GaugeItem.CANVAS * w
        val t = it.y / GaugeItem.CANVAS * h
        val r = l + it.w / GaugeItem.CANVAS * w
        val b = t + it.h / GaugeItem.CANVAS * h

        selPaint.color = theme.accent
        selPaint.strokeWidth = dp(2f)
        canvas.drawRect(l, t, r, b, selPaint)

        val s = dp(HANDLE_DP)
        handlePaint.color = theme.accent
        canvas.drawRect(r - s, b - s, r, b, handlePaint)

        hintPaint.color = theme.value
        hintPaint.textSize = dp(11f)
        canvas.drawText(
            "${(it.w / GaugeItem.CANVAS * 100).toInt()}% × ${(it.h / GaugeItem.CANVAS * 100).toInt()}%",
            (l + r) / 2f, (t - dp(6f)).coerceAtLeast(dp(12f)), hintPaint
        )
    }

    // ---------------------------------------------------------------- 触摸

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return false

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val i = hitTest(event.x, event.y, w, h)
                select(i)
                if (i < 0) return true
                val it = items[i]
                downX = event.x
                downY = event.y
                origX = it.x; origY = it.y; origW = it.w; origH = it.h
                mode = if (inHandle(event.x, event.y, it, w, h)) MODE_RESIZE else MODE_MOVE
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                val it = items.getOrNull(selected) ?: return false
                val dx = (event.x - downX) / w * GaugeItem.CANVAS
                val dy = (event.y - downY) / h * GaugeItem.CANVAS
                when (mode) {
                    MODE_MOVE -> {
                        it.x = DashLayout.Drag.moveIf(snapOn, origX, dx, it.w)
                        it.y = DashLayout.Drag.moveIf(snapOn, origY, dy, it.h)
                    }
                    MODE_RESIZE -> {
                        it.w = DashLayout.Drag.resizeIf(snapOn, origW, dx, it.x)
                        it.h = DashLayout.Drag.resizeIf(snapOn, origH, dy, it.y)
                    }
                    else -> return false
                }
                requestLayout()
                invalidate()
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (mode != MODE_NONE) {
                    mode = MODE_NONE
                    onChange?.invoke()
                }
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    /** 从上层往下找（后添加的在上面，所以倒序），命中就返回下标 */
    private fun hitTest(x: Float, y: Float, w: Float, h: Float): Int {
        for (i in items.indices.reversed()) {
            val it = items[i]
            val l = it.x / GaugeItem.CANVAS * w
            val t = it.y / GaugeItem.CANVAS * h
            if (x >= l && x <= l + it.w / GaugeItem.CANVAS * w && y >= t && y <= t + it.h / GaugeItem.CANVAS * h) return i
        }
        return -1
    }

    /** 右下角手柄热区。比视觉方块略大一点，手指才好按 */
    private fun inHandle(x: Float, y: Float, it: GaugeItem, w: Float, h: Float): Boolean {
        val r = (it.x + it.w) / GaugeItem.CANVAS * w
        val b = (it.y + it.h) / GaugeItem.CANVAS * h
        val s = dp(HANDLE_DP)
        return x >= r - s && y >= b - s
    }
}
