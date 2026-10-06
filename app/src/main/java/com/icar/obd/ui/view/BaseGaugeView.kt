package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import androidx.core.content.ContextCompat
import com.icar.obd.R
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.ValueLabels

/**
 * 仪表渲染基类。
 *
 * **分层原则（这是整个项目最值得保留的设计）**：
 * 本类只认识 [GaugeItem]（怎么画）与一个已经算好的 Float（画多少），
 * 完全不知道 BLE、ELM327、PID 公式的存在。
 * 数据从哪来由上层 [com.icar.obd.ui.dash.DashRenderer] 决定。
 * 因此新增一种仪表只需要继承本类，不必碰数据层。
 *
 * 三种内置样式：
 *   style 0 → [CircularGaugeView] 圆形指针表
 *   style 1 → [DigitalGaugeView]  数字大屏
 *   style 2 → [BarGaugeView]      横向条
 */
abstract class BaseGaugeView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr), AnimatableGauge {

    protected var item: GaugeItem = GaugeItem()
    protected var pid: PidDefinition? = null

    protected var value: Float? = null
    protected var colorOverride: Int? = null

    /**
     * 平滑显示用的值：以动画方式逼近 [value]。
     *
     * 指针 / 弧 / 条 / 指针环都用它，**数字文本仍用 [value]** ——
     * 读数要准，动效可以慢半拍。
     */
    protected var displayValue: Float?
        get() = animator.display
        set(v) { animator.snapTo(v) }

    /**
     * 数值动画状态机（v1.10.4）。三层：**输入滤波 → 缓动曲线 → 收敛判据**。
     *
     * 抽成独立类的理由见 [GaugeAnimator]：状态机在 `stepFrame` 里 JVM 单测跑不了，
     * 而"数据还在变时会不会冻住"这类问题恰恰只出在状态机上。
     */
    private val animator = GaugeAnimator()

    private var animating = false

    /**
     * 当前是否在动画中（缓动未收敛，或有报警爆闪）。
     *
     * 给性能基准页用：它需要区分「画面在动」和「画面静止」——
     * 静止时的帧率没有意义（不重绘自然不掉帧），只有持续动画时才测得出绘制成本。
     */
    val isAnimating: Boolean get() = animating

    /**
     * 推进一帧。由**共用时钟** [GaugeTicker] 调 —— 不再各自 `postDelayed`。
     *
     * 8 个仪表各自 postDelayed 的话，每秒 480 次消息投递，而且各自按 16ms 猜、
     * 和 vsync 错拍。共用时钟每帧一次回调，所有仪表在同一帧里一起重绘。
     *
     * ## ⚠️ 关键：数据还在变时**不许停止动画**
     *
     * 原来只要距离 ≤ `settleEpsilon` 就吸附并停止。数据 5Hz 推，两次推送之间
     * 目标不变 —— 缓动在 200ms 窗口里早早收敛、**停住**，下次推送再跳一下。
     * 数据变化慢时（正弦峰顶、水温上升）这个"停一下再跳"肉眼可见。
     *
     * 现在只有**目标也稳定了**（超过 [Easing.HOLD_MS]）才允许停。见 [Easing.needsMoreFrames]。
     *
     * @param nowMs vsync 时间戳。**不用 `SystemClock`** —— 掉帧时后者会让动画"追赶"，
     *              闪频会抖
     * @return 是否还需要继续动画
     */
    override fun stepFrame(nowMs: Long): Boolean {
        clockMs = nowMs
        // 主题里的动画参数每次都用最新的（主题切换后立刻生效）
        animator.tauMs = palette.easingTauMs
        animator.mode = palette.easingMode
        animator.smoothMs = palette.valueSmoothingMs
        animator.range = (item.maxVal - item.minVal).let { if (it > 0f) it else 0f }

        var needMore = animator.step(value, nowMs, settleEpsilon)

        // ⚠️ 报警期间**必须持续重绘**：爆闪是时间驱动的动画，
        // 数值收敛了也不能停 —— 否则闪一下就定住了。
        if (alertLevel != AlertPulse.NONE) needMore = true

        animating = needMore
        invalidate()
        return needMore
    }

    private fun startAnimationIfNeeded() {
        if (animating) return
        animating = true
        // 清掉上一轮的帧时间与"目标稳定计时"：否则停一会儿再启动时，
        // 第一帧的 dt 会大得离谱、或者立刻判定"目标已稳定"→ 停止动画。
        // 这些都在 GaugeAnimator.restart() 里统一处理。
        animator.restart()
        GaugeTicker.request(this)
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        // 必须反注册：否则页面切走后还在 60fps 空转
        GaugeTicker.release(this)
        animating = false
        neon.recycle()
    }

    /** 绘制用的当前显示值（动画中的中间值） */
    protected fun shown(): Float? = displayValue ?: value

    /**
     * 收敛阈值（值域单位）。子类按**像素**折算后覆写。
     *
     * 默认用相对比例只是兜底：绝对量程很大时（转速 8000）相对比例会让尾巴拖很长，
     * 而"半个像素以内"才是视觉上真正看不出差别的点。
     */
    protected open val settleEpsilon: Float get() = 1e-3f * (1f + Math.abs(value ?: 0f))

    // ================================================================ v2：字体

    /**
     * 表上文字的字体（v2 的 `labelFont`）。null = 没设置，子类用自动字号。
     *
     * 子类在自己的文字绘制里调 [applyFontTo] 即可，不用各自解析字体对象。
     */
    protected var labelFont: com.icar.obd.data.GaugeFont? = null

    /** 是否画名字（v2 的 `showLabel`） */
    protected var showLabel: Boolean = true

    /** 是否画量程提示（v2 的 `showRange`） */
    protected var showRange: Boolean = true

    /**
     * v2：应用表上文字的字体。由 [com.icar.obd.ui.dash.NodeTreeRenderer] 调用。
     *
     * @param font      字体（默认值也算「设置过」——工具侧默认就是 sans/16）
     * @param showLabel 是否画名字
     * @param showRange 是否画量程
     */
    fun applyLabelFont(font: com.icar.obd.data.GaugeFont, showLabel: Boolean, showRange: Boolean) {
        labelFont = font
        this.showLabel = showLabel
        this.showRange = showRange
        invalidate()
    }

    /**
     * 把字体应用到画笔。
     *
     * @param pxPerUnit 画布单位 → 像素。**字号是画布单位**，不乘这个系数
     *   换个分辨率观感就完全不一样
     * @param fallbackSizePx 没设置字体时的自动字号（各子类按自己的尺寸算）
     */
    protected fun applyFontTo(paint: android.graphics.Paint, pxPerUnit: Float, fallbackSizePx: Float) {
        val f = labelFont ?: return
        paint.typeface = f.typeface()
        val px = if (f.isDefault) fallbackSizePx else (f.size * pxPerUnit).coerceAtLeast(1f)
        paint.textSize = px
        paint.color = f.color
    }

    /** 字体设置过就用它的颜色，否则用调用方给的默认色 */
    protected fun fontColorOr(default: Int): Int = labelFont?.color ?: default

    /** 基于**显示值**的归一化位置 —— 指针 / 弧 / 条 / 环用这个才平滑 */
    protected fun shownRatio(): Float = ratio(shown())

    /**
     * 当前的显示值（动画中的中间值），**给性能基准页统计"动了几帧"用**。
     *
     * 与 [shown] 的区别：`shown` 在 `displayValue` 为 null 时回落到 `value`，
     * 而这个方法如实返回 `displayValue`（含 null）—— 基准要的就是"动画值本身
     * 有没有变"，回落会掩盖"其实没在动"。
     */
    fun shownValueForBench(): Float? = displayValue

    /** 副参数定义（多数据显示用），顺序与 [GaugeItem.extraPids] 一致 */
    protected var extraPids: List<PidDefinition?> = emptyList()

    /** 当前值列表：第 0 个是主参数，第 1..n 个对应 [extraPids] */
    protected var extraValues: List<Float?> = emptyList()

    protected var cAccent = ContextCompat.getColor(context, R.color.accent)
    protected var cAccentHot = cAccent
    protected var cTrack = ContextCompat.getColor(context, R.color.gauge_track)
    protected var cTick = ContextCompat.getColor(context, R.color.gauge_tick)
    protected var cNeedle = ContextCompat.getColor(context, R.color.gauge_needle)
    protected var cValue = ContextCompat.getColor(context, R.color.gauge_value)
    protected var cLabel = ContextCompat.getColor(context, R.color.gauge_label)
    protected val cWarn = ContextCompat.getColor(context, R.color.warn)
    protected val cDanger = ContextCompat.getColor(context, R.color.danger)
    protected var cDim = ContextCompat.getColor(context, R.color.text_dim)
    protected var palette = GaugeTheme.of(GaugeTheme.NEON)

    protected fun sp(v: Float): Float = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics
    )

    // ---------------------------------------------------------- 霓虹 + 爆闪

    /** 共用的霓虹绘制层。子类直接用，不要在 onDraw 里自己 new Paint */
    protected val neon = NeonPainter()

    // ================================================================ 霓虹助手（P7-8）

    /**
     * 画一条**发光进度条**（数字表底部条 / 多值表的各条共用）。
     *
     * 抽出来的原因：6 个视图都要这个模式，各写一遍辉光循环迟早分叉
     * （层数、扩散、glow 开关的判定会不一致）。
     *
     * @param on 主题的 glow 开关。**关掉时只画实心**，不做任何额外绘制 ——
     *   辉光是纯装饰，关掉必须是零开销
     */
    protected fun neonBar(canvas: Canvas, rect: RectF, r: Float, color: Int, on: Boolean, sizePx: Float) {
        if (on) neon.bloomRoundRect(canvas, rect, r, color, neon.spreadFor(sizePx), neon.layersFor(sizePx))
        neon.roundRect(canvas, rect, r, color)
    }

    /**
     * 画一段**发光文字**（数字读数 / 多值表的各读数共用）。
     *
     * ⚠️ 颜色**必须传进来**：`glowText` 会临时改 paint 的颜色做多层叠加，
     * 画完要把颜色还原成调用方期望的那个 —— 否则下一次绘制会串色。
     */
    protected fun neonText(
        canvas: Canvas, text: String, x: Float, y: Float,
        paint: Paint, color: Int, sizePx: Float
    ) {
        if (palette.glow) {
            neon.glowText(canvas, text, x, y, paint, color, neon.layersFor(sizePx), neon.spreadFor(sizePx))
        }
        paint.color = color
        canvas.drawText(text, x, y, paint)
    }

    /** 画一条**发光线段**（折线图 / G力十字线共用） */
    protected fun neonLine(
        canvas: Canvas, x1: Float, y1: Float, x2: Float, y2: Float,
        color: Int, strokePx: Float, on: Boolean, sizePx: Float
    ) {
        if (on) neon.bloomLine(canvas, x1, y1, x2, y2, color, strokePx, neon.spreadFor(sizePx), neon.layersFor(sizePx))
        neon.line(canvas, x1, y1, x2, y2, color, strokePx)
    }

    /**
     * 给一条**路径**加辉光（折线图的轨迹用）。
     *
     * ⚠️ 只画辉光层，**不画实线** —— 实线由调用方画（它有自己的颜色与线宽）。
     * 让这个函数也画实线的话，调用方就得知道"传进来的 paint 会不会被改"，
     * 那种耦合很容易出错。
     *
     * 用多层递减 alpha + 递增线宽模拟辉光 —— 与 [NeonPainter.bloomLine] 同一个套路，
     * 只是作用在 Path 上（折线有几十个点，逐段 bloomLine 太贵）。
     */
    protected fun neonPath(
        canvas: Canvas, path: Path, paint: Paint, color: Int,
        strokePx: Float, on: Boolean, sizePx: Float
    ) {
        if (!on) return
        val layers = neon.layersFor(sizePx)
        val spread = neon.spreadFor(sizePx)
        val savedColor = paint.color
        val savedWidth = paint.strokeWidth
        val savedStyle = paint.style
        paint.style = Paint.Style.STROKE
        for (i in 0 until layers) {
            val t = (i + 1).toFloat() / layers
            paint.color = color
            paint.alpha = ((1f - t) * 0.30f * 255f).toInt().coerceIn(0, 255)
            paint.strokeWidth = strokePx + spread * t
            canvas.drawPath(path, paint)
        }
        paint.color = savedColor
        paint.strokeWidth = savedWidth
        paint.style = savedStyle
    }

    /** 画一个**发光圆点**（G力球共用） */
    protected fun neonDot(canvas: Canvas, cx: Float, cy: Float, r: Float, color: Int, on: Boolean, sizePx: Float) {
        if (on) neon.bloomCircle(canvas, cx, cy, r, color, neon.spreadFor(sizePx), neon.layersFor(sizePx))
        neon.roundRect(canvas, RectF(cx - r, cy - r, cx + r, cy + r), r, color)
    }

    /**
     * 当前报警等级（**带迟滞**）。这是**唯一**的报警状态 ——
     * 颜色、爆闪、指针染色全部由它决定。
     *
     * ## 为什么不再有第二个 `warn` 布尔（v1.10.1 重构）
     *
     * 原来并存两个概念，是这份代码最容易读错的地方：
     *
     * | | 来源 | 用途 |
     * |---|---|---|
     * | `warn: Boolean` | `isOutOfRange()`，**含下限** | 选颜色 |
     * | `alertLevel: Int` | `AlertPulse.level()`，**只认上限** | 驱动爆闪 |
     *
     * 两者重叠但不相等：`warnLow` 触发时 `warn=true` 而 `alertLevel=NONE`，
     * 于是「到底哪个才是报警」永远说不清，加一种报警档位要动两处。
     *
     * 现在下限也进 [alertLevel]（见 [AlertPulse.levelWithLow]），
     * 颜色统一走 [alertColor] / [valueTextColor]，只有一处判定。
     *
     * **行为刻意保持不变**：下限报警只染色、不爆闪 —— 见 [alertIntensity]。
     */
    protected var alertLevel: Int = AlertPulse.NONE
        private set

    /** 缓存的动画时钟。用 `SystemClock.uptimeMillis` 而不是自己累加，避免漂移 */
    private var clockMs: Long = 0L

    /**
     * 危险阈值：由 `warnHigh` 与量程推出 —— 取 `warnHigh` 到 `maxVal` 的**中点**。
     *
     * 为什么不是写死的值：不同 PID 量程差几个数量级（转速 8000 / 车速 240 / 油温 150），
     * 写死必然对不上。按比例推至少**方向是对的**：
     *  转速 6500 → 危险 7250；车速 120 → 危险 180。
     *
     * 没有 `warnHigh` 就不设危险档（只有一档）。
     */
    protected fun criticalOf(): Float? {
        val w = item.warnHigh ?: return null
        val top = item.maxVal
        if (top <= w) return null
        return w + (top - w) * 0.5f
    }

    /**
     * 爆闪强度 0..1。子类在 onDraw 里用，**不要在别处调**（依赖当前时钟）
     *
     * ⚠️ **下限报警刻意不爆闪**（电压过低之类）。
     * 爆闪的语义是"立刻松油门/靠边"，而数值偏低通常不需要这种紧迫感；
     * 硬要闪反而会让驾驶员对爆闪脱敏。下限只染色，见 [alertColor]。
     */
    protected fun alertIntensity(): Float = AlertPulse.intensity(alertLevel, clockMs)

    /** 爆闪染色比例 0..1：把辉光/外圈往报警色推。下限报警不参与，理由同 [alertIntensity] */
    protected fun alertTint(): Float =
        if (alertLevel == AlertPulse.WARN_LOW) 0f else AlertPulse.tintMix(alertLevel, clockMs)

    /** 按爆闪比例把 [base] 往 [cDanger] 混 */
    protected fun alertMix(base: Int): Int {
        val t = alertTint()
        return if (t <= 0f) base else AlertPulse.mix(base, cDanger, t)
    }

    /** 辉光色：平时是主题色，报警时往危险色推 */
    protected fun alertGlowColor(alpha: Int): Int =
        AlertPulse.alpha(alertMix(cAccent), alpha)

    protected fun dp(v: Float): Float = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics
    )

    /** 绑定定义。渲染层在创建时调用一次。 */
    open fun bind(
        item: GaugeItem,
        pid: PidDefinition?,
        theme: GaugeTheme = GaugeTheme.of(GaugeTheme.NEON),
        extras: List<PidDefinition?> = emptyList()
    ) {
        this.item = item
        this.pid = pid
        this.extraPids = extras
        palette = theme
        cAccent = theme.accent
        cAccentHot = theme.accentHot
        cTrack = theme.track
        cTick = theme.tick
        cNeedle = theme.needle
        cValue = theme.value
        cLabel = theme.label
        cDim = theme.dim
        invalidate()
    }

    /**
     * 更新数值。渲染层每次收到总线推送时调用。
     * @param override 规则引擎给的覆盖色（null = 用默认配色）
     */
    /** 单值更新（圆表 / 数字 / 条形用）。多数据显示走 [updateMulti]。 */
    open fun update(v: Float?, override: Int?) = updateMulti(listOf(v), override)

    /**
     * 多值更新：`values[0]` 是主参数，`values[1..]` 依次对应 [GaugeItem.extraPids]。
     *
     * 数值由渲染层从 [com.icar.obd.obd.VehicleBus] 取好再传进来 ——
     * **本类及其子类不得自己去读总线**（红线 4.1.5：渲染层只接收「已算好的数值 + 可选覆盖色」）。
     */
    open fun updateMulti(values: List<Float?>, override: Int?) {
        val primary = values.getOrNull(0)
        val changed = primary != value || override != colorOverride || values != extraValues
        value = primary
        extraValues = values
        colorOverride = override

        // 报警等级：**上限与下限一起判**，并且必须把上一帧的等级传回去才有迟滞 ——
        // 否则真实转速在 6500 上下抖动时会乱闪（见 AlertPulseTest 的反证用例）。
        alertLevel = AlertPulse.levelWithLow(
            primary, item.warnHigh, criticalOf(), item.warnLow, alertLevel
        )

        if (changed || alertLevel != AlertPulse.NONE) {
            startAnimationIfNeeded()
            invalidate()
        }
    }

    /**
     * 报警时元素该用什么颜色。**唯一的报警配色入口**。
     *
     * 之前每个子类各写一遍 `if (warn) cWarn else …`，7 处重复 ——
     * 加一档报警就要改 7 个文件，漏一个就出现"表在闪但颜色没变"这种半吊子状态。
     */
    protected fun alertColor(): Int = when (alertLevel) {
        AlertPulse.CRITICAL -> cDanger
        AlertPulse.WARN, AlertPulse.WARN_LOW -> cWarn
        else -> cAccent
    }

    /**
     * 数值文本的颜色：覆盖色 > 报警色 > 主题数值色。
     *
     * **文本不参与爆闪** —— 让读数在闪烁中消失是不可接受的（见 [alertTint] 的说明）。
     */
    protected fun valueTextColor(): Int =
        colorOverride ?: when (alertLevel) {
            AlertPulse.CRITICAL -> cDanger
            AlertPulse.WARN, AlertPulse.WARN_LOW -> cWarn
            else -> cValue
        }

    /**
     * 主色：覆盖色 > 报警色 > 强调色。
     *
     * 用 [alertColor] 而不是自己判 `warn`：报警状态只有一处判定（[alertLevel]）。
     */
    protected fun mainColor(): Int = colorOverride ?: alertColor()

    /**
     * 由主色派生带透明度的辉光色。
     *
     * 存在的意义：辉光必须跟随主题走。**不要在绘制代码里写死 RGB**
     * —— 早期版本把霓虹橙 `(255,116,0)` 硬编码在 [CircularGaugeView] 里，
     * 当时只有霓虹主题开 `glow`，所以看不出问题；
     * 但只要以后加一个 `glow = true` 的青色/紫色主题，就会立刻串色。
     */
    protected fun glowColor(color: Int, alpha: Int): Int =
        (color and 0x00FFFFFF) or (alpha.coerceIn(0, 255) shl 24)

    /**
     * 数值格式化：按量程自动决定小数位。
     *
     * **先查映射表**（`GaugeItem.valueLabels`，P9 方向 A）—— 枚举型数据
     * （挡位 `P/R/N/1..6`）在这里换成名字。
     *
     * ⚠️ **这是唯一的入口**：圆表 / 条形表 / 数字表 / 折线 / G力 / 多值表
     * 全都调这一个函数。放到这里而不是各视图里各判一次 ——
     * 6 处判定迟早分叉（本项目在"报警配色"上已经栽过一次，见 §2.1 步骤 1）。
     */
    protected fun format(v: Float?): String {
        ValueLabels.labelFor(item.valueLabels, v)?.let { return it }
        if (v == null || v.isNaN()) return "--"
        val span = (item.maxVal - item.minVal).let { if (it <= 0f) 1f else it }
        return when {
            span >= 1000f -> v.toInt().toString()
            span >= 100f -> String.format("%.0f", v)
            span >= 10f -> String.format("%.1f", v)
            else -> String.format("%.2f", v)
        }
    }

    /** 0..1 归一化位置，超出量程会被夹住 */
    protected fun ratio(v: Float?): Float {
        if (v == null || v.isNaN()) return 0f
        val span = item.maxVal - item.minVal
        if (span <= 0f) return 0f
        return ((v - item.minVal) / span).coerceIn(0f, 1f)
    }

    /** 需要趋势历史的子类覆写为 true（渲染层据此推送 [updateHistory]，避免无谓的列表拷贝） */
    open val wantsHistory: Boolean get() = false

    /** 趋势历史推送（旧 → 新）。只有 [wantsHistory] 为 true 的视图会收到。 */
    open fun updateHistory(history: List<Float>) { }

    // ---------------------------------------------------------- 副参数（多数据显示）

    protected fun extraPid(i: Int): PidDefinition? = extraPids.getOrNull(i)
    protected fun extraValue(i: Int): Float? = extraValues.getOrNull(i + 1)
    protected fun extraLabel(i: Int): String = extraPid(i)?.name ?: "—"
    protected fun extraUnit(i: Int): String = extraPid(i)?.unit ?: ""

    /** 副参数按**它自己的量程**格式化，而不是主参数的 */
    protected fun extraFormat(i: Int): String = fmtByRange(extraValue(i), extraPid(i))

    /** 主参数按自己的量程格式化（多数据显示里主副量程往往差很多） */
    protected fun primaryFormat(): String =
        ValueLabels.labelFor(item.valueLabels, value) ?: fmtByRange(value, pid)

    protected fun extraWarn(i: Int): Boolean {
        val p = extraPid(i) ?: return false
        val v = extraValue(i) ?: return false
        if (v.isNaN()) return false
        p.warnLow?.let { if (v < it) return true }
        p.warnHigh?.let { if (v > it) return true }
        return false
    }

    /**
     * 副参数文本的颜色。
     *
     * ## 为什么副参数不走 [alertLevel]
     *
     * 一条仪表只有一个 [alertLevel]（主参数的），而副参数各有自己的
     * `warnLow/warnHigh`。副参数**只染色、不爆闪** ——
     * 一块表上同时闪两处会让人分不清哪个才是主报警。
     *
     * 所以这里保留逐条判定，但**配色与主参数同源**（[cWarn]），
     * 不会出现"主参数橙、副参数红"这种不一致。
     */
    protected fun extraTextColor(i: Int): Int =
        colorOverride ?: if (extraWarn(i)) cWarn else cValue

    private fun fmtByRange(v: Float?, p: PidDefinition?): String {
        if (v == null || v.isNaN()) return "--"
        val span = ((p?.maxVal ?: 100f) - (p?.minVal ?: 0f)).let { if (it <= 0f) 1f else it }
        return when {
            span >= 1000f -> v.toInt().toString()
            span >= 100f -> String.format("%.0f", v)
            span >= 10f -> String.format("%.1f", v)
            else -> String.format("%.2f", v)
        }
    }

    protected fun label(): String = pid?.name ?: "未绑定"
    protected fun unit(): String = pid?.unit ?: ""

    protected fun newTextPaint(sizeSp: Float, textColor: Int, bold: Boolean = false): Paint =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = textColor
            textSize = sp(sizeSp)
            isFakeBoldText = bold
            textAlign = Paint.Align.CENTER
        }

    /**
     * **final**：统一包一层计时，子类实现 [drawGauge]。
     *
     * 这样所有仪表的绘制耗时自动被 [DrawStats] 覆盖，不用每个子类自己加。
     * 优化时最需要的就是"哪个控件贵"这个数 —— 没有它只能猜。
     */
    final override fun onDraw(canvas: Canvas) {
        val t0 = System.nanoTime()
        // 每帧设一次样式：单块表的覆盖优先，否则用主题全局的。
        // 放在这里而不是各子类里，是为了**子类不需要知道有"样式"这回事**
        neon.style = item.neonPreset?.let { NeonStyle.presetOf(it) } ?: palette.neon
        drawGauge(canvas)
        DrawStats.record(javaClass.simpleName, System.nanoTime() - t0)
    }

    /** 子类的实际绘制。不要覆写 [onDraw] */
    protected abstract fun drawGauge(canvas: Canvas)

    companion object {
        /**
         * 默认缓动**时间常数**（毫秒）。
         *
         * ## 为什么从"每帧比例"改成"时间常数"
         *
         * 原来是 `from + (target - from) * 0.25`，**按帧**逼近。两个毛病：
         *
         * 1. **帧率相关**。60Hz 下 200ms 收敛，120Hz 下只要 100ms ——
         *    同一份代码在不同设备上观感完全不同。这台平板就能跑 120Hz。
         * 2. **和 5Hz 的数据推送错拍**。数据每 200ms 来一个新目标，
         *    而按帧缓动要 ~173ms 才到 95%，剩下 5% 是长长的尾巴 ——
         *    **永远在"快起步、慢收尾"的循环里，看起来就是一顿一顿。**
         *
         * 时间基准之后：`k = 1 - e^(-dt/τ)`，不管多少帧率，**固定时间收敛**。
         *
         * ## ⚠️ 为什么从 45ms 提到 120ms（v1.10.4）
         *
         * τ=45ms 时一个 5Hz 推送周期（200ms）内会走完 **98.8%** ——
         * 也就是说指针**几乎瞬间到位**，然后在剩下的时间里"趴"在目标上不动，
         * 等下一次推送。数据缓变时看起来就是**一格一格地跳**，不是"走"过去。
         *
         * τ=120ms 时一个周期走 **81%**，永远留一点余量给下一次推送 ——
         * 指针**一直在动**，这才是"过渡"而不是"跳变"。
         *
         * 代价是到位慢一点（3τ≈360ms 收住）。仪表读数本来就不需要瞬时响应，
         * 而"顺"是肉眼第一眼就能看出来的。
         *
         * 现在这个值只是**默认值**，实际取自 `GaugeTheme.easingTauMs`（主题可调）。
         */
        const val TAU_MS = 120f

        /** 兜底帧间隔（仅用于 dt 异常时） */
        const val FRAME_MS = 16L

        /**
         * 缓动的下一步（标准指数曲线）。
         *
         * **保留**是为了向后兼容既有调用点与测试；新代码请直接用
         * [Easing.step]（支持多种曲线）。
         *
         * @param dtMs 距上一帧的毫秒数
         */
        fun nextDisplay(from: Float, target: Float, dtMs: Float): Float =
            Easing.step(from, target, dtMs, TAU_MS, Easing.MODE_STANDARD)

        /**
         * 收敛判据（纯距离判断）。
         *
         * ⚠️ **它只回答"够不够近"，不回答"要不要继续动画"** ——
         * 后者是 [Easing.needsMoreFrames] 的事。v1.10.4 之前把这两件事混在一起，
         * 导致数据还在变时动画提前停止（"停一下再跳"）。
         *
         * @param epsilon 允许的剩余差。子类按**像素**折算后传进来 ——
         *   绝对值很大时（转速 8000）用相对比例会让尾巴拖很长，
         *   而"半个像素以内"才是视觉上真正看不出差别的点。
         */
        fun settled(from: Float, target: Float, epsilon: Float): Boolean =
            Easing.shouldSnap(Math.abs(target - from), epsilon)
    }
}
