package com.icar.obd.ui.view

import com.icar.obd.data.NodeState

/**
 * 阈值报警与「爆闪」动画的纯逻辑。
 *
 * ## 为什么抽成独立对象
 *
 * 迟滞边界和时间相位是**最容易写错、又最难手测**的两处：
 *  - 没有迟滞，数值在阈值附近抖动会让爆闪随机乱闪，看起来像坏了；
 *  - 时间相位算错，闪频就会忽快忽慢或者根本不动。
 *
 * 放在 `onDraw` 里这两件事都没法验证。这里做成纯函数 —— **不碰 View、不碰时间源**，
 * 时间由调用方传进来，于是可以单测。
 */
object AlertPulse {

    const val NONE = 0

    /** 超过警告阈值：慢闪 */
    const val WARN = 1

    /** 超过危险阈值：快闪 + 更强 */
    const val CRITICAL = 2

    /**
     * **低于下限**（如电压过低）。
     *
     * 单独一档而不是复用 [WARN] 的原因：下限只**染色**、不爆闪
     * （见 `BaseGaugeView.alertIntensity` 的说明）。
     * 如果混进 [WARN]，`intensity()` 就会给低电压也来一段慢闪 ——
     * 那是行为变化，不是重构。
     */
    const val WARN_LOW = 3

    /**
     * 迟滞比例。退出阈值 = 进入阈值 × (1 - 这个值)。
     *
     * 3% 是权衡：太小挡不住抖动，太大又会让"降下来了但还在闪"。
     * 对转速 6500 而言是 195 转的缓冲。
     */
    const val HYSTERESIS = 0.03f

    /** 阈值接近 0 时的绝对兜底缓冲（相对比例会失效） */
    private const val ABS_FLOOR = 0.5f

    // ---------------------------------------------------------------- 等级判定

    /**
     * 判定报警等级。**带迟滞** —— 传 [prev] 才能正确解除。
     *
     * @param v         当前值。`null` / `NaN` 视为无报警
     * @param warnAt    警告阈值（超过即 WARN）
     * @param criticalAt 危险阈值（超过即 CRITICAL）。`null` 表示只有一档
     * @param prev      上一次的等级，用于迟滞
     */
    fun level(v: Float?, warnAt: Float?, criticalAt: Float?, prev: Int): Int {
        if (v == null || v.isNaN()) return NONE
        val w = warnAt ?: return NONE
        if (w <= 0f) return NONE

        val c = criticalAt?.takeIf { it > 0f }
        // 危险档也要迟滞，否则在危险线上来回跳
        if (c != null) {
            val releaseC = if (prev == CRITICAL) releaseOf(c) else c
            if (v >= releaseC) return CRITICAL
        }
        val releaseW = if (prev != NONE) releaseOf(w) else w
        return if (v >= releaseW) WARN else NONE
    }

    /** 退出阈值。相对比例，并保证至少降 [ABS_FLOOR]，避免小阈值时比例失效 */
    fun releaseOf(threshold: Float): Float =
        threshold - (threshold * HYSTERESIS).coerceAtLeast(ABS_FLOOR)

    /**
     * 判定报警等级，**同时考虑上限与下限**。
     *
     * ## 为什么加这一个函数而不是改 [level]
     *
     * [level] 只认上限，是**扫描器/仪表盘**等处沿用的既有语义，27 个用例钉着它。
     * 直接改签名会让那些用例失效 —— 而它们保护的是迟滞边界，是本项目
     * 最不该被顺手改掉的东西。所以新增一个入口，[level] 原样保留。
     *
     * ## 优先级
     *
     * 上限优先于下限：同时越过两端时（量程写错、或数据异常）按上限处理，
     * 因为"过高"才是需要立刻反应的场景。
     *
     * ## 迟滞的方向是**反的**（这里最容易写错）
     *
     * 上限是"超过才报、跌下来才解除"：进入用原阈值，退出用**更低**的 [releaseOf]。
     * 下限正好相反 —— 进入用原阈值（低于才报），退出要用**更高**的阈值：
     *
     * ```
     * 下限 11.5：进入 = 11.5，退出 = 11.5 + 0.5 ≈ 12.0
     * ```
     *
     * 照抄 [releaseOf]（减法）会让退出阈值落到进入阈值**下面**，
     * 于是永远进不去 —— 这个 bug 是单测抓出来的（见 `下限也有迟滞`）。
     *
     * @param lowAt 下限阈值（低于即 [WARN_LOW]）。`null` 或 ≤ 0 表示不设下限
     */
    fun levelWithLow(v: Float?, warnAt: Float?, criticalAt: Float?, lowAt: Float?, prev: Int): Int {
        if (v == null || v.isNaN()) return NONE

        val up = level(v, warnAt, criticalAt, prev)
        if (up != NONE) return up

        // 下限：阈值必须为正才生效。0 是"没设"的常见写法（比如 warnLow=0），
        // 若当成有效阈值，任何正常值都会立刻变报警。
        val lo = lowAt?.takeIf { it > 0f } ?: return NONE
        val release = if (prev == WARN_LOW) releaseHighOf(lo) else lo
        return if (v <= release) WARN_LOW else NONE
    }

    /**
     * **下限**的退出阈值：比进入阈值**高**一档。
     *
     * 与 [releaseOf] 方向相反，理由见 [levelWithLow]。
     * 同样带绝对兜底 —— 阈值很小时相对比例会失效（0.5 × 3% = 0.015）。
     */
    fun releaseHighOf(threshold: Float): Float =
        threshold + (threshold * HYSTERESIS).coerceAtLeast(ABS_FLOOR)

    // ---------------------------------------------------------------- 爆闪强度

    /**
     * 硬爆闪：方波，0 或 1。这是「爆闪」要的效果 —— 干脆、有冲击力。
     *
     * @param nowMs   当前时间（毫秒）
     * @param periodMs 一轮周期
     * @param duty    一个周期里「亮」的占比
     */
    fun square(nowMs: Long, periodMs: Int, duty: Float): Float {
        if (periodMs <= 0) return 0f
        val phase = (nowMs % periodMs).toFloat() / periodMs
        return if (phase < duty.coerceIn(0f, 1f)) 1f else 0f
    }

    /**
     * 平滑脉冲：0→1→0 的 smoothstep 三角。
     *
     * 用在**警告档**（慢闪）—— 硬方波在低等级下太刺眼，长途驾驶会烦。
     * 危险档才用 [square]。
     */
    fun pulse(nowMs: Long, periodMs: Int): Float {
        if (periodMs <= 0) return 0f
        val phase = (nowMs % periodMs).toFloat() / periodMs
        val tri = if (phase < 0.5f) phase * 2f else (1f - phase) * 2f
        // smoothstep：让起止更柔和，中段更陡
        return tri * tri * (3f - 2f * tri)
    }

    /**
     * 危险档的闪烁周期。**必须 ≥ [NodeState.MIN_BLINK_MS]**（2.5 Hz ≤ 3 Hz）。
     *
     * 原来是 200ms（5 Hz，超 WCAG 2.3.1「每秒不超过三次」红线）。
     * 周期的**唯一真源**在数据层的 [NodeState.MIN_BLINK_MS] ——
     * 那是设计文件的契约，工具侧 `window.MIN_BLINK_MS` 与它同源。
     */
    private const val CRITICAL_PERIOD_MS = NodeState.MIN_BLINK_MS

    /**
     * 警告档的闪烁周期（1.7 Hz，本来就合规）。
     *
     * 与危险档保持**肉眼可分辨的快慢差** —— 这是 `docs/动画实现.md` 记的
     * 有意设计（"一眼能看出严重程度"），2.5Hz vs 1.7Hz 仍然分得出。
     */
    private const val WARN_PERIOD_MS = 600

    /**
     * 按等级给出爆闪强度 0..1。
     *
     * 两档用**不同节奏**，这样一眼能看出严重程度：
     *  - [WARN]     ≈1.7Hz 平滑脉冲，柔和
     *  - [CRITICAL] ≈2.5Hz 硬方波，干脆
     *  - [WARN_LOW] 恒为 0 —— 下限只染色不爆闪（见 `BaseGaugeView.alertIntensity`）
     *
     * ⚠️ **两档都必须 ≤3 Hz**（WCAG 2.3.1）。危险档原来是 5 Hz，已降到 2.5 Hz。
     * 因为 `DashRenderer` 只以 5 Hz 的 tick 采样（见那里的说明），
     * 400ms 周期下每周期恰好 2 个采样点，闪烁照旧可见 —— **没有丢掉"爆闪"的观感**。
     */
    fun intensity(level: Int, nowMs: Long): Float = when (level) {
        CRITICAL -> square(nowMs, periodMs = CRITICAL_PERIOD_MS, duty = 0.5f)
        WARN -> pulse(nowMs, periodMs = WARN_PERIOD_MS)
        else -> 0f
    }

    /**
     * 爆闪时的**颜色混合比例**：0 = 原色，1 = 完全变成报警色。
     *
     * 不做成"整个元素变色"是因为那会让读数在闪烁中消失；
     * 只把**辉光和外圈**推向报警色，读数始终可辨。
     */
    fun tintMix(level: Int, nowMs: Long): Float = when (level) {
        // ⚠️ 周期必须与 [intensity] **逐字一致** —— 否则"变色"和"闪"会错开相位
        CRITICAL -> 0.35f + 0.65f * square(nowMs, CRITICAL_PERIOD_MS, 0.5f)
        WARN -> 0.25f + 0.45f * pulse(nowMs, WARN_PERIOD_MS)
        else -> 0f
    }

    // ---------------------------------------------------------------- 颜色

    /** 两个颜色按比例混合。[t]=0 取 [a]，[t]=1 取 [b] */
    fun mix(a: Int, b: Int, t: Float): Int {
        val k = t.coerceIn(0f, 1f)
        val ar = (a shr 16) and 0xFF; val ag = (a shr 8) and 0xFF; val ab = a and 0xFF
        val br = (b shr 16) and 0xFF; val bg = (b shr 8) and 0xFF; val bb = b and 0xFF
        val r = (ar + (br - ar) * k).toInt()
        val g = (ag + (bg - ag) * k).toInt()
        val bl = (ab + (bb - ab) * k).toInt()
        return (0xFF shl 24) or (r shl 16) or (g shl 8) or bl
    }

    /** 换透明度，保留 RGB */
    fun alpha(color: Int, alpha: Int): Int =
        (color and 0x00FFFFFF) or (alpha.coerceIn(0, 255) shl 24)
}
