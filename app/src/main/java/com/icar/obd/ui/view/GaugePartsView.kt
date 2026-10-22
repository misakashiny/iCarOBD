package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.view.View
import com.icar.obd.data.GaugeFont
import com.icar.obd.data.GaugeItem
import com.icar.obd.data.GaugePart
import com.icar.obd.data.PartAnim
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
 * ## 坐标系（P5A-M02 修正：X/Y 分别缩放）
 *
 * 部件的 x/y/w/h 是**画布单位**（与节点同级）。原来这里只有一个
 * `pxPerUnit`，X 和 Y 用同一个比例 —— 而 `NodeTreeRenderer` 的
 * `Viewport` 从 v2 起就是 **pxX / pxY 分别算**（节点尺寸用
 * `node.w*pxX` / `node.h*pxY`）。
 *
 * 后果（实测）：手机竖屏视口 1080×2272 → pxX=3、pxY=6.31，
 * 部件横向被放大 2.1 倍并溢出 View 边界被裁掉 ——
 * 「表盘和刻度画出来了、指针却不见」就是这么来的。
 *
 * 现在 [pxX] 管横向、[pxY] 管纵向，与节点尺寸同一套换算。
 * 旋转中心仍是部件自身的 `pivotX/pivotY`（相对自身 0..1）——
 * **指针素材的轴心基本不在图片中心**，所以这个必须能单独设。
 *
 * 绘制顺序 = **列表顺序**（先画的在下）。
 */
class GaugePartsView(
    context: Context,
    private val item: GaugeItem,
    private val parts: List<GaugePart>,
    /** 横向：画布单位 → 像素 */
    private val pxX: Float,
    /** 纵向：画布单位 → 像素 */
    private val pxY: Float,
    private val labelFont: GaugeFont,
    /** 取素材位图。由渲染器注入 —— View 不该自己去读文件 */
    private val bitmapOf: (String) -> Bitmap?
) : View(context) {

    /**
     * 单比例构造（正方形视口 / 兼容老调用）。
     *
     * `pxX == pxY` 时与分轴版本**逐像素一致**，所以老设计不受影响。
     */
    constructor(
        context: Context,
        item: GaugeItem,
        parts: List<GaugePart>,
        pxPerUnit: Float,
        labelFont: GaugeFont,
        bitmapOf: (String) -> Bitmap?
    ) : this(context, item, parts, pxPerUnit, pxPerUnit, labelFont, bitmapOf)

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = labelFont.typeface()
        // 字号跟**纵向**比例走：与文字节点 `f.size * t.pxY` 同一套（见 NodeTreeRenderer）
        textSize = (labelFont.size * pxY).coerceAtLeast(1f)
        color = labelFont.color
        textAlign = Paint.Align.CENTER
    }

    /** 这个表绑的 PID。渲染器靠它取当前值推进来 */
    val pid: String get() = item.pidId

    // ================================================================ 装饰动画

    /** 最近一帧的 vsync 时间（[stepFrame] 写入，绘制时读取） */
    private var clockMs: Long = 0L

    /**
     * 这棵部件树里是否**有**持续动画。
     *
     * 没有的话 [stepFrame] 立刻返回 false —— 存量设计（无 anim 字段）
     * 一行代码都不多跑，行为与改动前完全一致。
     */
    private val hasAnim: Boolean by lazy { parts.any { animatingIn(it) } }

    private fun animatingIn(p: GaugePart): Boolean {
        if (p.anim != null) return true
        return p.children.any { animatingIn(it) }
    }

    /**
     * 每帧推进（由 `NodeTreeRenderer` 的装饰时钟调进来）。
     *
     * 与数值缓动的区别：缓动会收敛、会停；这里只要还有 anim 部件就**永远返回 true**
     * —— 这是"环境动画"的本质。
     *
     * ## 为什么是整表 `invalidate()` 而不是局部脏区（实测过，已放弃）
     *
     * 2026-10-17 试过「只刷带动画部件的外接矩形」，**没有任何改善**
     * （12 表 P99 仍是 20ms、Janky 仍是 0.16%）。原因：瓶颈不在重绘面积，
     * 而在每帧的 prepare/记录阶段（12 张 View 各走一遍测量与绘制列表）。
     * 既然无收益，就不引入那份脏区计算的复杂度与出错面。
     *
     * ⚠️ **调用方必须保证不可见时不调用**（外层有 `pv.isShown` 守卫），
     * 否则页面切走后仍会空转。
     *
     * @return 是否还需要下一帧
     */
    fun stepFrame(nowMs: Long): Boolean {
        if (!hasAnim) return false
        clockMs = nowMs
        invalidate()
        return true
    }

    /** 停止时把时钟归零，避免下次进入时相位「跳」一大段 */
    fun stopAnimation() {
        clockMs = 0L
    }

    /**
     * 当前值表：**PID id → 值**（由渲染器 5Hz 推入）。
     *
     * 用一张表而不是单个 Float —— 多指针表里每个 needle 可能绑不同的 PID，
     * 一个值不够用。
     */
    private val values = GaugePartValues(item.pidId, parts)

    fun neededPids(): Set<String> = values.neededPids

    /** Receive a complete current snapshot, clearing unavailable sources too. */
    fun setValues(v: Map<String, Float>) {
        if (values.replace(v)) invalidate()
    }

    /**
     * 一个部件该用哪个值、哪套量程。
     *
     * 绑了 pid 就用那个 PID 的值与量程；没绑就回落到仪表节点自己的。
     * **与工具侧 partValueRange() 是同一套判定** —— 各写一份迟早分叉。
     */
    private data class ValueRange(val value: Float?, val min: Float, val max: Float)

    private fun valueRangeOf(p: GaugePart): ValueRange {
        if (p.pid.isNotBlank()) {
            val def = Store.findPid(p.pid)
            val min = def?.minVal ?: 0f
            val max = def?.maxVal ?: 100f
            return ValueRange(values.valueOf(p), min, max)
        }
        return ValueRange(values.valueOf(p), item.minVal, item.maxVal)
    }

    override fun onDraw(canvas: Canvas) {
        parts.forEach { p -> drawPart(canvas, p, 0) }
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
     * 横向一律乘 [pxX]、纵向一律乘 [pxY]（P5A-M02 修正）。
     *
     * @param depth 嵌套深度。上限 5，与工具侧和 parseAll 一致
     */
    private fun drawPart(canvas: Canvas, p: GaugePart, depth: Int) {
        if (depth > 5) return
        if (p.alpha <= 0) return
        paint.alpha = p.alpha.coerceIn(0, 255)

        // **每个部件各算各的值与量程**（多指针表：两个 needle 各绑一个 PID）
        val vr = valueRangeOf(p)

        if (p.kind == GaugePart.KIND_VALUE) {
            // 数值部件用文字画 —— 它要跟着数据变
            canvas.drawText(
                GaugePartValues.format(vr.value),
                (p.x + p.w / 2f) * pxX,
                (p.y + p.h / 2f) * pxY + textPaint.textSize / 3f,
                textPaint
            )
            return
        }

        if (p.kind == GaugePart.KIND_NEEDLE && vr.value == null) return

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
            p.angleFor(vr.value!!, vr.min, vr.max, swFrom, swTo)
        } else p.rotation

        // 旋转中心 = 部件自身的 pivot（相对自身 0..1）
        // X/Y 各用各的比例（P5A-M02 修正），否则非方形视口下 pivot 会跑到 View 外
        val cx = (p.x + p.w * p.pivotX) * pxX
        val cy = (p.y + p.h * p.pivotY) * pxY
        val saved = canvas.save()

        // ---- 装饰动画（T-UI-HUD-01 原型）----
        // 在**静态布局之上**追加时间偏移：不改变任何静态字段的含义，
        // 所以没有 anim 的部件与改动前逐像素一致。
        var animAlpha = p.alpha
        var animDx = 0f
        var animDy = 0f
        var animAngle = 0f
        val a = p.anim
        if (a != null && clockMs > 0L) {
            val u = a.cycle(clockMs)
            when (a.kind) {
                // 绕 pivot 匀速转：u 走完一圈 → 360°×amplitude
                PartAnim.KIND_SPIN -> animAngle = 360f * a.amplitude * u
                // alpha 呼吸：sin 曲线，中位不动、两端 ±amplitude
                PartAnim.KIND_PULSE -> {
                    val s = Math.sin(u * 2.0 * Math.PI).toFloat()   // -1..1
                    animAlpha = (p.alpha * (1f + s * a.amplitude * 0.5f)).toInt().coerceIn(0, 255)
                }
                // 沿主轴往返扫描：三角波，画布单位
                PartAnim.KIND_SWEEP -> {
                    val tri = if (u < 0.5f) u * 2f else (1f - u) * 2f   // 0..1..0
                    animDx = (tri * 2f - 1f) * a.amplitude
                }
                // 小幅缓慢漂移：两个不同频率的正弦，避免规律感
                PartAnim.KIND_DRIFT -> {
                    animDx = (Math.sin(u * 2.0 * Math.PI) * a.amplitude).toFloat()
                    animDy = (Math.cos(u * 2.0 * Math.PI * 0.7) * a.amplitude).toFloat()
                }
            }
            paint.alpha = animAlpha.coerceIn(0, 255)
        }

        canvas.translate(cx + animDx * pxX, cy + animDy * pxY)
        if (angle != 0f) canvas.rotate(angle)
        if (animAngle != 0f) canvas.rotate(animAngle)

        // 自身画在"以 pivot 为原点"的坐标系里
        bitmapOf(p.assetId)?.let { bmp ->
            val left = -p.w * p.pivotX * pxX
            val top = -p.h * p.pivotY * pxY
            canvas.drawBitmap(
                bmp, null,
                android.graphics.RectF(left, top, left + p.w * pxX, top + p.h * pxY),
                paint
            )
        }

        // 子部件在**父的 pivot 坐标系**里，继承父的旋转
        p.children.forEach { c -> drawPart(canvas, c, depth + 1) }

        canvas.restoreToCount(saved)
    }

    override fun setAlpha(a: Float) {
        super.setAlpha(a)
        paint.alpha = (a * 255).toInt()
    }
}
