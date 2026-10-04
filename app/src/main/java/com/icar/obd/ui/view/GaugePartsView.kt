package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import com.icar.obd.data.GaugeFont
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.GaugePart
import com.icar.obd.data.Store

/**
 * **按子部件绘制的仪表视图**（v2.12.0）。
 *
 * 工具侧可以把一个仪表拆成几个可替换的部件（表盘 / 刻度 / 指针 / 数值），
 * 这个 View 负责把它们拼起来。
 *
 * ## 与程序化画法的关系
 *
 * 有 `parts` 就用它，没有就继续用 `GaugeViewFactory` 的程序化画法 ——
 * 两条路径并存，存量设计行为完全不变。
 *
 * ## 坐标系
 *
 * 部件的 x/y/w/h 是**画布单位**（与节点同级），要乘 `pxPerUnit` 才到像素。
 * 旋转中心用部件自己的 `pivotX/pivotY`（相对自身 0..1）——
 * **指针素材的轴心基本不在图片中心**，所以这个必须能单独设。
 *
 * 绘制顺序 = **列表顺序**（先画的在下）。
 */
class GaugePartsView(
    context: Context,
    private val item: GaugeItem,
    private val parts: List<GaugePart>,
    private val pxPerUnit: Float,
    private val labelFont: GaugeFont,
    /** 取素材位图。由渲染器注入 —— View 不该自己去读文件 */
    private val bitmapOf: (String) -> Bitmap?
) : View(context) {

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = labelFont.typeface()
        textSize = (labelFont.size * pxPerUnit).coerceAtLeast(1f)
        color = labelFont.color
        textAlign = Paint.Align.CENTER
    }

    /** 这个表绑的 PID。渲染器靠它取当前值推进来 */
    val pid: String get() = item.pidId

    /**
     * 当前值表：**PID id → 值**（由渲染器 5Hz 推入）。
     *
     * 用一张表而不是单个 Float —— 多指针表里每个 needle 可能绑不同的 PID，
     * 一个值不够用。
     */
    private val values = HashMap<String, Float>()

    /**
    * 这个视图**需要哪些 PID 的值**。
    *
    * 渲染器靠它一次把值取齐推进来 —— 视图自己不去读总线（红线 4.1.5）。
    */
    fun neededPids(): Set<String> {
        val out = HashSet<String>()
        out.add(item.pidId)
        parts.forEach { p -> if (p.pid.isNotBlank()) out.add(p.pid) }
        return out
    }

    /** 推一批值进来（PID id → 值）。**变了才重绘** —— 5Hz 下每帧重绘很浪费 */
    fun setValues(v: Map<String, Float>) {
        var changed = false
        v.forEach { (k, x) -> if (values[k] != x) { values[k] = x; changed = true } }
        if (changed) invalidate()
    }

    /**
     * 一个部件该用哪个值、哪套量程。
     *
     * 绑了 pid 就用那个 PID 的值与量程；没绑就回落到仪表节点自己的。
     * **与工具侧 partValueRange() 是同一套判定** —— 各写一份迟早分叉。
     */
    private fun valueRangeOf(p: GaugePart): FloatArray {
        if (p.pid.isNotBlank()) {
            val def = Store.findPid(p.pid)
            val min = def?.minVal ?: 0f
            val max = def?.maxVal ?: 100f
            return floatArrayOf(values[p.pid] ?: min, min, max)
        }
        return floatArrayOf(values[item.pidId] ?: item.minVal, item.minVal, item.maxVal)
    }

    override fun onDraw(canvas: Canvas) {
        val k = pxPerUnit
        parts.forEach { p -> drawPart(canvas, p, k, 0) }
    }

    /**
     * **递归画一个部件及其子树**（v2.18.0）。
     *
     * ## 坐标系
     *
     * 顶层部件的 x/y 相对**仪表节点**；子部件相对**父部件的 pivot**。
     *
     * 为什么以 pivot 为原点：嵌套的典型用法是「指针上挂个装饰/配重」——
     * 装饰要跟着指针**绕轴心转**。以 pivot 为原点，子部件写 (0,0) 就在轴心上，
     * 符合直觉；以左上角为原点的话，每加一个装饰都要手算 pivot 偏移。
     *
     * 子部件**继承父的旋转** —— 父的 rotate 留在 canvas 里，子在自己的坐标系里画。
     *
     * @param depth 嵌套深度。上限 5，与工具侧和 parseAll 一致
     */
    private fun drawPart(canvas: Canvas, p: GaugePart, k: Float, depth: Int) {
        if (depth > 5) return
        if (p.alpha <= 0) return
        paint.alpha = p.alpha.coerceIn(0, 255)

        // **每个部件各算各的值与量程**（多指针表：两个 needle 各绑一个 PID）
        val vr = valueRangeOf(p)

        if (p.kind == GaugePart.KIND_VALUE) {
            // 数值部件用文字画 —— 它要跟着数据变
            canvas.drawText(
                fmt(vr[0]),
                (p.x + p.w / 2f) * k,
                (p.y + p.h / 2f) * k + textPaint.textSize / 3f,
                textPaint
            )
            return
        }

        // 指针的角度由**值**驱动；其余部件用静态 rotation
        val angle = if (p.kind == GaugePart.KIND_NEEDLE) {
            // 扫描范围可能"跟随第一个指针"（v2.27.0）。
            //
            // 为什么是"第一个指针"而不是"仪表节点"：双针表的实际用法就是
            // "两根针共用一段弧" —让它跟着领头针走，既符合直觉，
            // 又不需要 View 拿到节点（这个 View 只有 item/parts，没有 node）。
            val lead = parts.firstOrNull { it.kind == GaugePart.KIND_NEEDLE }
            val swFrom = if (p.sweepFollow && lead != null) lead.sweepFrom else p.sweepFrom
            val swTo = if (p.sweepFollow && lead != null) lead.sweepTo else p.sweepTo
            p.angleFor(vr[0], vr[1], vr[2], swFrom, swTo)
        } else p.rotation

        // 旋转中心 = 部件自身的 pivot（相对自身 0..1）
        val cx = (p.x + p.w * p.pivotX) * k
        val cy = (p.y + p.h * p.pivotY) * k
        val saved = canvas.save()
        canvas.translate(cx, cy)
        if (angle != 0f) canvas.rotate(angle)

        // 自身画在"以 pivot 为原点"的坐标系里
        bitmapOf(p.assetId)?.let { bmp ->
            val left = -p.w * p.pivotX * k
            val top = -p.h * p.pivotY * k
            canvas.drawBitmap(
                bmp, null,
                android.graphics.RectF(left, top, left + p.w * k, top + p.h * k),
                paint
            )
        }

        // 子部件在**父的 pivot 坐标系**里，继承父的旋转
        p.children.forEach { c -> drawPart(canvas, c, k, depth + 1) }

        canvas.restoreToCount(saved)
    }

    /** 数值格式化：整数不带小数点，小数保留一位 —— 与工具侧一致 */
    private fun fmt(v: Float): String =
        if (v == v.toInt().toFloat()) v.toInt().toString()
        else String.format(java.util.Locale.US, "%.1f", v)

    override fun setAlpha(a: Float) {
        super.setAlpha(a)
        paint.alpha = (a * 255).toInt()
    }
}
