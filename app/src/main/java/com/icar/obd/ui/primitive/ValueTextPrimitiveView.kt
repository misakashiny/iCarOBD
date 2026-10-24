package com.icar.obd.ui.primitive

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import com.icar.obd.obd.VehicleBus

/**
 * P5B-M03 §D3：**动态数值**（ValueText）Android 实现
 *
 * ## 身份
 *
 * Android 内部绘制组件，**未注册进正式主题格式**。
 *
 * ## 指令要求
 *
 *   · 主 PID 绑定
 *   · 数值更新
 *   · 精度
 *   · 单位
 *   · 前后缀
 *   · 数值映射（`valueLabels`）
 *   · 无数据占位
 *   · 阈值颜色
 *   · 字体、对齐和透明度
 *   · 屏幕尺寸变化
 *
 * ## ⚠️ 「复用 VehicleBus 与现有格式化能力，不新建独立数据采集入口」
 *
 * 本类**不自己读 OBD、不自己轮询**：
 *   · 取值只走 [VehicleBus.value] / [VehicleBus.addValueListener]（生产数据通道）
 *   · 数值映射复用 `ValueLabels`（同一份规则）
 *   · `Test-only` 的 [setValueDirect] 只用于隔离测试，**不注册进 VehicleBus**，
 *     也不出现在正式渲染路径里
 *
 * ## 阈值颜色
 *
 * 判定规则与 `BaseGaugeView.alertLevel` 一致：
 *   value >= criticalHigh → 危险色
 *   value >= warnHigh     → 警告色
 *   否则                   → 正常色
 *
 * （低值报警 `warnLow` 的语义有争议，见问题清单 P5A-M04-LOWDIR-REVERSE，本类**不实现**）
 */
class ValueTextPrimitiveView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    // ---------------------------------------------------------------- 数据绑定

    /** 绑定的 PID id（空 = 不绑定）*/
    var pid: String = ""
        set(v) {
            if (field == v) return
            unbind()
            field = v
            if (v.isNotEmpty()) bind()
            invalidate()
        }

    /** 是否绑定到 VehicleBus（默认 true；测试可关掉用 [setValueDirect]）*/
    var busBinding: Boolean = true

    private var unsub: (() -> Unit)? = null

    private fun bind() {
        if (!busBinding) return
        unsub = VehicleBus.addValueListener { pv ->
            if (pv.pidId == pid) {
                lastValue = if (pv.ok) pv.value else null
                postInvalidate()
            }
        }
        // 立即取一次当前值（避免等下一次推送）
        lastValue = VehicleBus.value(pid)
    }

    private fun unbind() {
        unsub?.invoke()
        unsub = null
    }

    override fun onDetachedFromWindow() {
        unbind()
        super.onDetachedFromWindow()
    }

    /** 当前值（null = 无数据）*/
    var lastValue: Float? = null
        private set

    /**
     * **仅测试用**：直接给值，不经过 VehicleBus。
     *
     * 为什么需要：JVM 单测与隔离页面要能确定性地喂值。
     * ⚠️ 正式渲染路径**不使用**它（正式路径一律走 [pid] + VehicleBus）。
     */
    fun setValueDirect(v: Float?) {
        lastValue = v
        invalidate()
    }

    // ---------------------------------------------------------------- 显示参数

    /** 小数位 */
    var decimals: Int = 0
        set(v) { field = v.coerceIn(0, 3); invalidate() }

    /** 单位（如 "km/h"）*/
    var unit: String = ""
        set(v) { field = v; invalidate() }

    /** 前缀 */
    var prefix: String = ""
        set(v) { field = v; invalidate() }

    /** 后缀（与 [unit] 分开，后缀贴在数值后、单位前）*/
    var suffix: String = ""
        set(v) { field = v; invalidate() }

    /** 数值映射（如 ["关","开"]）；非空且值在范围内时优先显示映射文字 */
    var valueLabels: List<String>? = null
        set(v) { field = v; invalidate() }

    /** 主数值字号（sp）*/
    var valueSizeSp: Float = 28f
        set(v) { field = v.coerceAtLeast(1f); invalidate() }

    /**
     * 主数值字号（**像素**）。
     *
     * 为什么要有这个：画布单位 → 像素的换算由渲染器做（它知道 Viewport），
     * 而这个值是"已经算好的像素"，直接设置比再传一遍 scale 干净。
     */
    var valueSizePx: Float
        get() = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, valueSizeSp, resources.displayMetrics)
        set(v) {
            val sp = TypedValue.deriveDimension(TypedValue.COMPLEX_UNIT_SP, v.coerceAtLeast(1f),
                resources.displayMetrics)
            valueSizeSp = sp
        }

    /** 单位字号（**像素**）*/
    var unitSizePx: Float
        get() = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, unitSizeSp, resources.displayMetrics)
        set(v) {
            val sp = TypedValue.deriveDimension(TypedValue.COMPLEX_UNIT_SP, v.coerceAtLeast(1f),
                resources.displayMetrics)
            unitSizeSp = sp
        }

    /** 单位字号（sp）*/
    var unitSizeSp: Float = 12f
        set(v) { field = v.coerceAtLeast(1f); invalidate() }

    /** 对齐：0=左 1=居中 2=右 */
    var align: Int = ALIGN_CENTER
        set(v) { field = v.coerceIn(0, 2); invalidate() }

    /** 整体透明度 [0,255] */
    var textAlpha: Int = 255
        set(v) { field = v.coerceIn(0, 255); invalidate() }

    /** 字体（null = 默认）*/
    var typeface: Typeface? = null
        set(v) { field = v; invalidate() }

    // ---------------------------------------------------------------- 颜色

    var normalColor: Int = Color.WHITE
        set(v) { field = v; invalidate() }
    var warnColor: Int = Color.parseColor("#FFB020")
        set(v) { field = v; invalidate() }
    var criticalColor: Int = Color.parseColor("#FF4D4F")
        set(v) { field = v; invalidate() }
    var noDataColor: Int = Color.parseColor("#7A8088")
        set(v) { field = v; invalidate() }

    // ---------------------------------------------------------------- 阈值

    var warnHigh: Float? = null
        set(v) { field = v; invalidate() }
    var criticalHigh: Float? = null
        set(v) { field = v; invalidate() }

    // ---------------------------------------------------------------- 绘制

    private val valuePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
    }
    private val unitPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
    }

    /** 最近一次画出的文本（供测试断言，不必猜）*/
    var lastValueText: String? = null
        private set
    var lastUnitText: String? = null
        private set
    var lastColor: Int = 0
        private set

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val v = lastValue

        // ---- 无数据 → 占位（不是 0）
        val mapped = com.icar.obd.data.ValueLabels.labelFor(valueLabels, v)
        val valueText: String = when {
            v == null && (mapped == null) -> NO_DATA
            mapped != null -> mapped
            else -> formatValue(v!!, decimals)
        }
        val color = when {
            v == null -> noDataColor
            criticalHigh != null && v >= criticalHigh!! -> criticalColor
            warnHigh != null && v >= warnHigh!! -> warnColor
            else -> normalColor
        }

        lastValueText = valueText
        lastUnitText = if (v == null) null else unit.ifEmpty { null }
        lastColor = color

        // ---- 字号随 View 高度自适应（指令：屏幕尺寸变化）
        val vsp = autoFit(valueSizeSp, w, valueText)
        valuePaint.textSize = vsp
        valuePaint.color = color
        valuePaint.alpha = textAlpha
        typeface?.let { valuePaint.typeface = it }

        val cx = when (align) {
            ALIGN_LEFT -> 0f
            ALIGN_RIGHT -> w
            else -> w / 2f
        }
        valuePaint.textAlign = when (align) {
            ALIGN_LEFT -> Paint.Align.LEFT
            ALIGN_RIGHT -> Paint.Align.RIGHT
            else -> Paint.Align.CENTER
        }

        val showUnit = v != null && unit.isNotEmpty()
        val usp = autoFit(unitSizeSp, w, unit)
        unitPaint.textSize = usp
        unitPaint.color = color
        unitPaint.alpha = textAlpha
        unitPaint.textAlign = valuePaint.textAlign

        val totalH = vsp + if (showUnit) usp + 2f else 0f
        val baseY = (h - totalH) / 2f + vsp * 0.85f

        // 前缀 / 后缀拼进主串（保证基线对齐简单、不引入额外测量）
        val fullValue = prefix + valueText + suffix
        canvas.drawText(fullValue, cx, baseY, valuePaint)

        if (showUnit) {
            canvas.drawText(unit, cx, baseY + usp + 2f, unitPaint)
        }
    }

    /** 文本超出宽度时逐步缩小字号 */
    private fun autoFit(baseSp: Float, availableW: Float, text: String): Float {
        var sp = baseSp.coerceAtLeast(1f)
        val px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, resources.displayMetrics)
        valuePaint.textSize = px
        val measured = valuePaint.measureText(text)
        if (measured > availableW && measured > 0f) {
            val k = availableW / measured
            sp = (sp * k * 0.98f).coerceAtLeast(1f)
        }
        return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, resources.displayMetrics)
    }

    companion object {
        const val ALIGN_LEFT = 0
        const val ALIGN_CENTER = 1
        const val ALIGN_RIGHT = 2

        /** 无数据占位 —— 必须是 `--`，**不能是 0** */
        const val NO_DATA = "--"

        /**
         * 数值格式化（纯函数，可单测）。
         *
         * 规则与编辑器原型 `fmt()` 一致：固定 [decimals] 位后**去掉尾随零**。
         * 例：formatValue(1.50, 2) = "1.5"；formatValue(2.00, 2) = "2"
         */
        fun formatValue(v: Float, decimals: Int): String {
            if (!v.isFinite()) return NO_DATA
            val d = decimals.coerceIn(0, 3)
            var s = String.format("%.${d}f", v)
            if (d > 0) {
                s = s.trimEnd('0').trimEnd('.')
                if (s.isEmpty() || s == "-") s = "0"
            }
            return s
        }

        /**
         * 阈值判定（纯函数，可单测）。
         *
         * 与 `BaseGaugeView.alertLevel` 一致：只有高值报警，没有低值报警。
         */
        fun levelOf(v: Float?, warnHigh: Float?, criticalHigh: Float?): Int {
            if (v == null) return LEVEL_NO_DATA
            if (criticalHigh != null && v >= criticalHigh) return LEVEL_CRITICAL
            if (warnHigh != null && v >= warnHigh) return LEVEL_WARN
            return LEVEL_NORMAL
        }

        const val LEVEL_NO_DATA = -1
        const val LEVEL_NORMAL = 0
        const val LEVEL_WARN = 1
        const val LEVEL_CRITICAL = 2
    }
}
