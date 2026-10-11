package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import com.icar.obd.data.Bands
import com.icar.obd.data.GaugeBand
import com.icar.obd.data.GaugeItem

/**
 * 圆形指针表。270° 量程弧，从 135° 到 405°（7:30 → 4:30）。
 *
 * ## 这一版改了什么（v1.8.0 重构）
 *
 * 1. **辉光换成共用层 [NeonPainter]**。原来是 4 层写死的循环，现在是自适应层数，
 *    并且和其他仪表用同一套原语 —— 整个盘面才像一套设计。
 * 2. **底轨上标出危险区**。原来危险阈值只体现在"超了之后变红"，
 *    开车时看不到"还有多远到红线"。现在底轨从 `warnHigh` 起就是暗红。
 * 3. **爆闪**。超过危险阈值时，整个环 + 指针按 [AlertPulse] 的节奏闪。
 *    两级不同节奏：警告慢脉冲、危险快方波。
 * 4. **onDraw 零分配**。Paint / RectF 全部复用，格式化字符串只在数值变化时重算
 *    （文本用的是 `value` 不是缓动中的 `displayValue`，所以 5Hz 才变一次，
 *    没必要跟着 60fps 的动画每帧重新格式化）。
 */
class CircularGaugeView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, def: Int = 0
) : BaseGaugeView(context, attrs, def) {

    private val arcRect = RectF()
    private val arcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val tickPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private val needlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

    private var valuePaint: Paint? = null
    private var unitPaint: Paint? = null
    private var labelPaint: Paint? = null
    private var minMaxPaint: Paint? = null

    /** 缓存的格式化结果。文本只随 [value] 变（5Hz），不随缓动变（60fps） */
    private var cachedText: String = "--"
    private var cachedFor: Float = Float.NaN

    private val startAngle = 135f
    private val sweep = 270f

    override fun drawGauge(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val stroke = dp(palette.strokeDp)
        val size = minOf(w, h)
        // 辉光会向外扩散，留白要按**扩散量**给，否则最外层会被裁掉
        val spread = neon.spreadFor(size)
        val pad = stroke * 1.6f + spread + dp(2f)
        val inner = size - pad * 2f
        val cx = w / 2f
        val cy = h / 2f - h * 0.045f
        arcRect.set(cx - inner / 2f, cy - inner / 2f, cx + inner / 2f, cy + inner / 2f)

        val radius = inner / 2f
        val r = shownRatio()
        val layers = neon.layersFor(size)
        val glowOn = palette.glow

        // 报警时主色往危险色推 —— 用 alertMix 而不是直接换色，
        // 这样"灭"的那一半仍能看清读数（见 AlertPulse.tintMix 的注释）
        val main = alertMix(mainColor())
        val tint = alertTint()

        // ---------------------------------------------------------- 1) 底轨 + 危险区
        neon.arc(canvas, arcRect, startAngle, sweep, cTrack, stroke)

        // 危险区 / 色带：**有 `bands` 就逐段画，没有才走老路径**（`warnHigh`）。
        //
        // ⚠️ 这里画的是**分区**，与报警判定无关 —— 报警（变色 / 爆闪）由
        // `BaseGaugeView.alertLevel` 单独判，来源始终是 `warnLow`/`warnHigh`。
        // 让色带顺带改报警 = 静默改变存量设计的安全语义。
        //
        // 绘制顺序**刻意保持原样**（分区在数值弧之前）：老路径的像素一个都不动。
        // 工具侧 v2.88.0 把顺序调成了"分区在上"（红区不被进度弧盖住），
        // 那是**另一件事**，会动到所有存量红区的像素，需要单独一轮 + 拍板。
        val span = item.maxVal - item.minVal
        val warnAt = item.warnHigh
        // 一次算好：绘制与刻度取色都要用（`zoneSegments()` 每次都会归一化一遍）
        val zones = zoneSegments()
        for (z in zones) {
            val zoneStart = ((z.from - item.minVal) / span).coerceIn(0f, 1f)
            val zoneEnd = ((z.to - item.minVal) / span).coerceIn(0f, 1f)
            val zoneSweep = sweep * (zoneEnd - zoneStart)
            if (zoneSweep <= 1f) continue
            // 颜色：色带自带的色（没写就回落老红区那个红）。
            // ⚠️ 必须走 `GaugeBand.colorOf` 而不是 `z.color ?: cDanger`：
            // 老路径那一段的 `color` 是 `null`，要回落成 `cDanger`；
            // 而 `bands` 带来的段也允许不写颜色（同一个兜底语义）。
            // 老路径（color = null → cDanger）仍然随爆闪变亮，底色始终可见 —— 行为不变
            val base = GaugeBand.colorOf(z)
            // 色带自己的 alpha 是**倍率**（0..255 / 255）—— 与工具侧 `zoneAlpha()` 同口径。
            //
            // ⚠️ 必须在 `AlertPulse.mix()` **之后**再上 alpha：`mix` 的返回值
            // 把 alpha 写死成 0xFF（它只混 RGB），所以"先 alpha 再 mix"等于没上 ——
            // 症状是"给色带写了 alpha 但车上一点不变"，而且**不报错**。
            //
            // 没写 alpha 的段（老路径那一段恒为 null）倍率 = 1.0，于是
            // `alpha(mix(d90, d220, tint), 220)` 与老代码的 `mix(..., tint)` **逐位相同**
            // —— 存量红区的像素一个都不动。
            val zf = GaugeBand.alphaOf(z) / 255f
            val zoneColor = AlertPulse.alpha(
                AlertPulse.mix(
                    AlertPulse.alpha(base, 90),
                    AlertPulse.alpha(base, 220),
                    tint
                ),
                (220 * zf).toInt()
            )
            neon.arc(canvas, arcRect, startAngle + sweep * zoneStart, zoneSweep, zoneColor, stroke)
        }

        // ---------------------------------------------------------- 2) 数值弧
        if (r > 0f) {
            if (glowOn) {
                neon.bloomArc(canvas, arcRect, startAngle, sweep * r, main, stroke, spread, layers)
            }
            neon.arc(canvas, arcRect, startAngle, sweep * r, main, stroke)
        }

        // ---------------------------------------------------------- 2.5) 爆闪叠加
        // 报警时在整圈上再叠一层危险色辉光，强度由 AlertPulse 给 ——
        // 这是"爆闪"的视觉主体：整个表盘随节奏呼吸
        val flash = alertIntensity()
        if (flash > 0.01f) {
            val flashColor = AlertPulse.alpha(cDanger, (200 * flash).toInt().coerceIn(0, 255))
            val flashSpread = spread * (0.6f + 0.8f * flash)
            neon.bloomArc(canvas, arcRect, startAngle, sweep, flashColor, stroke, flashSpread, layers)
            neon.arc(canvas, arcRect, startAngle, sweep, flashColor, stroke * (1f + 0.4f * flash))
        }

        // ---------------------------------------------------------- 3) 刻度
        //
        // ⚠️ **这一段本版一个字没改** —— 刻度仍然只看 `warnHigh`（不看 `bands`）。
        // 理由：它是**存量像素**的一部分，动它就会让"没有 `bands` 的老设计"
        // 之外的东西也变；而"有 `bands` 时刻度要不要跟着分段上色"是个**观感决定**，
        // 得单独拍板（本版的边界是"让 App 认得 `bands`"，不是重新设计盘面）。
        // 记账见 CHANGELOG v1.20.22「遗留」。
        for (i in 0..20) {
            val major = i % 2 == 0
            val frac = i / 20f
            val ang = Math.toRadians((startAngle + sweep * frac).toDouble())
            val outer = radius - stroke / 2f - dp(3f)
            val len = if (major) dp(9f) else dp(4.5f)
            val innerR = outer - len
            val cos = Math.cos(ang).toFloat()
            val sin = Math.sin(ang).toFloat()
            // 刻度落在危险区里就提前用危险色 —— 和底轨的危险区呼应
            val inDanger = warnAt != null && span > 0f &&
                (item.minVal + span * frac) >= warnAt
            tickPaint.color = when {
                frac <= r -> main
                inDanger -> AlertPulse.mix(AlertPulse.alpha(cDanger, 120), AlertPulse.alpha(cDanger, 255), tint)
                else -> cTick
            }
            tickPaint.strokeWidth = if (major) dp(2f) else dp(1.2f)
            canvas.drawLine(
                cx + cos * innerR, cy + sin * innerR,
                cx + cos * outer, cy + sin * outer,
                tickPaint
            )
        }

        // ---------------------------------------------------------- 4) 指针环（可选）
        val ringStyle =
            if (item.ringStyle != GaugeItem.RING_NONE) item.ringStyle else palette.defaultRingStyle
        if (ringStyle == GaugeItem.RING_TICK) {
            val segs = (
                if (item.ringStyle != GaugeItem.RING_NONE) item.ringSegments
                else palette.defaultRingSegments
                ).coerceIn(8, 120)
            val ringR = radius + stroke * 0.5f + dp(2f)
            val segLen = dp(4.5f)
            for (i in 0 until segs) {
                val ang = Math.toRadians((startAngle + 360.0 * i / segs).toDouble())
                val cos = Math.cos(ang).toFloat()
                val sin = Math.sin(ang).toFloat()
                val lit = i / segs.toFloat() <= r
                tickPaint.color = if (lit) main else cTick
                tickPaint.strokeWidth = if (lit) dp(2.5f) else dp(1.5f)
                canvas.drawLine(
                    cx + cos * ringR, cy + sin * ringR,
                    cx + cos * (ringR + segLen), cy + sin * (ringR + segLen),
                    tickPaint
                )
            }
        }

        // ---------------------------------------------------------- 5) 指针
        val vAng = Math.toRadians((startAngle + sweep * r).toDouble())
        val needleLen = radius * palette.needleLengthRatio.coerceIn(0.2f, 1f)
        val nx = cx + Math.cos(vAng).toFloat() * needleLen
        val ny = cy + Math.sin(vAng).toFloat() * needleLen
        // 指针颜色由**唯一的**报警状态决定（v1.10.1 起不再判第二个 warn）：
        //   NONE → 主题指针色；WARN/WARN_LOW → 警告色；CRITICAL → 危险色
        // 再叠一层 alertMix，让报警时指针参与爆闪
        val needleColor = alertMix(alertColor().let {
            if (it == cAccent) cNeedle else it
        })
        if (glowOn) {
            neon.bloomLine(canvas, cx, cy, nx, ny, needleColor, dp(3f), spread * 0.8f, layers)
        }
        needlePaint.color = needleColor
        needlePaint.strokeWidth = dp(3f)
        canvas.drawLine(cx, cy, nx, ny, needlePaint)

        // 轴心
        fillPaint.color = needleColor
        canvas.drawCircle(cx, cy, dp(4f), fillPaint)
        if (glowOn) {
            neon.bloomCircle(canvas, cx, cy, dp(4f), alertGlowColor(120), spread * 0.5f, layers)
            fillPaint.color = needleColor
            canvas.drawCircle(cx, cy, dp(4f), fillPaint)
        }

        // ---------------------------------------------------------- 6) 文字
        val base = minOf(w, h)
        val vp = valuePaint ?: newTextPaint(1f, cValue, true).also { valuePaint = it }
        val up = unitPaint ?: newTextPaint(1f, cLabel).also { unitPaint = it }
        val lp = labelPaint ?: newTextPaint(1f, cLabel).also { labelPaint = it }
        val mp = minMaxPaint ?: newTextPaint(1f, cDim).also { minMaxPaint = it }

        vp.textSize = base * 0.20f
        up.textSize = base * 0.055f
        lp.textSize = base * 0.058f
        mp.textSize = base * 0.042f

        // 数值色：报警时也参与爆闪，但**始终保留可读对比度**
        vp.color = valueTextColor()
        up.color = cLabel
        lp.color = cLabel
        mp.color = cDim

        val text = valueText()
        val valueY = cy + vp.textSize * 0.35f
        if (glowOn && tint > 0.01f) {
            neon.glowText(canvas, text, cx, valueY, vp, alertMix(cAccent), 2, dp(3f) * tint)
        }
        canvas.drawText(text, cx, valueY, vp)
        canvas.drawText(unit(), cx, valueY + up.textSize + dp(4f), up)

        val labelY = (cy + radius + lp.textSize * 1.15f).coerceAtMost(h - dp(3f))
        canvas.drawText(label(), cx, labelY, lp)
        mp.textAlign = Paint.Align.LEFT
        canvas.drawText(trim(item.minVal), dp(6f), labelY, mp)
        mp.textAlign = Paint.Align.RIGHT
        canvas.drawText(trim(item.maxVal), w - dp(6f), labelY, mp)
        mp.textAlign = Paint.Align.CENTER
    }

    /**
     * 这一段分区要画哪几段色带（**按段的 from/to，不是按比例**）。
     *
     * ## 判据（与工具侧 `gaugeDialOpts()` 逐条对齐）
     *
     * | 情况 | 结果 |
     * |---|---|
     * | `bands` 非空 | **只用它** —— 逐段画，`warnLow`/`warnHigh` **不参与绘制** |
     * | `bands` 空 | 回落到老路径：`warnHigh → maxVal` **一段**（老红区） |
     *
     * ⚠️ 老路径**刻意只有 `warnHigh` 一段**：App 侧的圆表历史上就只画这一段
     * （`warnLow` 只影响变色，不画分区）。保持原样 = 存量设计的像素一个都不动。
     *
     * ⚠️ **两条路都只决定"画什么"**，谁也不改报警判定（那是 `warnLow`/`warnHigh`
     * 在 [BaseGaugeView.updateMulti] 里的事）。
     *
     * ## 为什么在 onDraw 里现算而不缓存
     *
     * `bands` 只有 `bind()` 时才会换（换表 / 换页），而这里每帧最多分配一个
     * 长度 ≤ [GaugeBand.MAX_BANDS] 的小列表。用 `var` 缓存就得在 `bind()` 里
     * 记得失效 —— 那种"忘了清缓存"的 bug 症状是"改了设计但表上还是老分区"，
     * 而它不报错。现算的代价（一个 8 元素列表）远小于那个风险。
     */
    private fun zoneSegments(): List<GaugeBand> {
        val usable = Bands.normalize(item.bands, item.minVal, item.maxVal)
        if (usable.isNotEmpty()) return usable
        val w = item.warnHigh ?: return emptyList()
        return listOf(GaugeBand(from = w, to = item.maxVal))
    }

    /**
     * 针尖移动不到半个像素就吸附。
     *
     * 圆表的量程跨度大（转速 8000），相对比例会让指针在末端"爬"很久；
     * 按半径折算成弧长，半像素是视觉上真正看不出差别的点。
     */
    override val settleEpsilon: Float
        get() {
            val r = minOf(width, height).toFloat() / 2f
            val span = item.maxVal - item.minVal
            // 针尖走过的弧长 = r × 角度；半个像素对应 span × 0.5 / (2πr × 0.75)
            return if (r <= 0f || span <= 0f) super.settleEpsilon
            else span * 0.5f / (6.2832f * r * 0.75f)
        }

    /** 格式化结果缓存：文本只随 [value] 变（5Hz），不随缓动变（60fps） */
    private fun valueText(): String {
        val v = value
        // 用 NaN 代表"没有值"，避免 Float? 与 Float 的来回转换
        val key = v ?: Float.NaN
        if (key != cachedFor || cachedFor.isNaN() != key.isNaN()) {
            cachedFor = key
            cachedText = format(v)
        }
        return cachedText
    }

    private fun trim(f: Float): String =
        if (f == f.toInt().toFloat()) f.toInt().toString() else String.format("%.1f", f)
}
