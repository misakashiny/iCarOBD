package com.icar.obd.ui.view

/**
 * 数值动画的**纯逻辑**：缓动曲线 + 输入滤波 + 收敛判据。
 *
 * ## 为什么要把这三件事抽出来
 *
 * 它们全是"放进 `onDraw` 就没法验证"的东西：
 *  - 会不会永远追不上（收敛性）
 *  - 会不会过冲（指针冲过目标再弹回来，很难看）
 *  - 换帧率会不会变快变慢
 *  - 输入抖动滤掉多少
 *
 * 做成纯函数（时间由调用方传入）就能用单测钉死。见 [EasingTest]。
 *
 * ## 三层各自的职责（**别混在一起**）
 *
 * ```
 * 总线原始值 ──[1. 输入滤波]──→ 平滑目标 ──[2. 缓动曲线]──→ 显示值
 *                                                              │
 *                                          [3. 收敛判据] ←──────┘
 * ```
 *
 * | 层 | 解决什么 | 参数 |
 * |---|---|---|
 * | 1 输入滤波 | **数据本身的抖动**（传感器噪声、量化误差） | [GaugeTheme.valueSmoothingMs] |
 * | 2 缓动曲线 | **数值跳变时的过渡手感**（0→10 要"走"过去） | [GaugeTheme.easing] + `tauMs` |
 * | 3 收敛判据 | 什么时候停止重绘（不能冻住，也不能永远空转） | `settleEpsilon` + [HOLD_MS] |
 *
 * ## 关键改动：**数据还在变时不许"吸附"**
 *
 * 原来只要 `|显示 − 目标| ≤ settleEpsilon` 就吸附到目标并停止动画。
 * 数据是 5Hz 推的，在两次推送之间目标不变 —— 于是缓动在 200ms 窗口里
 * 早早收敛、**停住**，等下一次推送再跳一下。数据变化慢时（正弦峰顶、
 * 水温上升）这个"停一下再跳"肉眼可见。
 *
 * 现在分成两种停止条件：
 *  - **数据还在动**（距上次目标变化 < [HOLD_MS]）→ 只用 `settleEpsilon`
 *    做"吸附到目标"消除累积误差，但**继续动画**（返回 true）
 *  - **数据停了一会儿**（≥ [HOLD_MS]）→ 吸附并停止，不再空转
 */
object Easing {

    // ================================================================ 曲线

    /** 标准：指数逼近（一阶低通）。全程减速，收尾长，最"顺" */
    const val MODE_STANDARD = 0

    /** 线性：匀速走过去。跳变时最像"指针在扫"，但到位略生硬 */
    const val MODE_LINEAR = 1

    /** 柔和：三次缓入缓出（ease-in-out）。起步慢、中段快、收尾慢 */
    const val MODE_SOFT = 2

    /** 干脆：二次缓出（ease-out）。起步快、收尾慢，适合报警类指标 */
    const val MODE_SNAPPY = 3

    /** 曲线名（下标与 `MODE_*` 对应）。**顺序是冻结的契约**，存进主题 JSON */
    val MODE_NAMES = listOf("标准（指数）", "线性（匀速）", "柔和（缓入缓出）", "干脆（缓出）")

    /** 把 `MODE_*` 解释成名字；未知值回落到「标准」 */
    fun modeName(mode: Int): String = MODE_NAMES.getOrElse(mode) { MODE_NAMES[MODE_STANDARD] }

    /**
     * 目标停多久之后才允许"吸附并停止动画"。
     *
     * 取 3 个 5Hz 推送周期（600ms）是权衡：
     *  - 太短 → 数据缓慢变化时仍会"停一下再跳"（就是这次要修的问题）
     *  - 太长 → 数据真停了还在 60fps 空转，白耗电
     */
    const val HOLD_MS = 600L

    /**
     * 单帧 dt 上限。
     *
     * 切页面回来时 dt 可能是几百毫秒；不夹住的话缓动会"瞬移"，看着像闪一下。
     */
    const val MAX_DT_MS = 100f

    /**
     * **参考帧长**（毫秒）。
     *
     * ## 为什么需要它（v1.10.4 修的一个实质缺陷）
     *
     * 指数逼近写成增量积分时，**离散步长不同会导致结果漂移**：
     *
     * ```
     * v ← v + (target − v)·(1 − e^(−dt/τ))
     * ```
     *
     * 同样 250ms，60Hz 与 120Hz 的结果差 **20 个百分点**（实测 55.5 vs 35.0）——
     * 因为 1−e^(−dt/τ) 不是线性的，帧多帧少累积出来的曲线不一样。
     * 这与"时间基准"的初衷正好相反（这台平板 120Hz、别的设备 60Hz，
     * 同一个仪表观感会明显不同）。
     *
     * 修法：把每帧的混合系数**按参考帧长归一化**
     *
     * ```
     * k = 1 − (1 − k_ref)^(dt / REF_FRAME_MS)
     * ```
     *
     * 这样 k 对 dt 是"可加的"（同样时长不论分几帧，结果一致），
     * 而且 dt = REF_FRAME_MS 时 k = k_ref，行为不变。
     */
    const val REF_FRAME_MS = 16.6667f

    /**
     * 按参考帧长归一化的混合系数（**可加**）。
     *
     * @param tauMs 时间常数
     * @param dtMs  实际帧长（会被 [MAX_DT_MS] 夹住）
     * @return 本帧应当混合的比例 0..1
     */
    private fun blend(tauMs: Float, dtMs: Float): Float {
        val tau = tauMs.coerceAtLeast(1f)
        val dt = dtMs.coerceAtMost(MAX_DT_MS)
        val kRef = 1f - Math.exp((-REF_FRAME_MS / tau).toDouble()).toFloat()
        // k = 1 − (1 − k_ref)^(dt / REF)
        return 1f - Math.pow((1f - kRef).toDouble(), (dt / REF_FRAME_MS).toDouble()).toFloat()
    }

    /**
     * 缓入缓出 / 缓出曲线的**总时长系数**：`总时长 = K · τ`。
     *
     * 取 2 是手感权衡：τ=120ms 时整段过渡 240ms ——
     * 比 5Hz 推送周期（200ms）略长，指针正好在下一次推送前收住。
     */
    private const val DURATION_K = 2f

    /**
     * **进度型曲线**：给定累计进度，返回位移**比例** 0..1。
     *
     * ## 为什么必须是"进度的函数"而不是"dt 的函数"
     *
     * 第一版把曲线参数当成**每帧进度**（`u = dt/τ`），结果两个毛病：
     *  - **帧率相关**：dt 固定时 u 每帧都一样，60Hz 与 120Hz 在同刻差 20 个百分点
     *  - **曲线根本没生效**：u 恒定 → 位移只随剩余距离衰减，那不是 ease-in-out
     *
     * 正确做法：曲线作用在**累计进度** `p = 已走时间 / 总时长` 上。
     * `p` 只取决于时间 → 帧率无关；且 `曲线(1) = 1` → 一定到位。
     *
     * @param p 累计进度 0..1（超出会被夹住）
     * @return 位移比例 0..1
     */
    private fun progressCurve(mode: Int, p: Float): Float {
        val u = p.coerceIn(0f, 1f)
        return when (mode) {
            // ease-in-out：三次 smoothstep，3u² − 2u³
            // 起点/终点速度为 0（慢起慢收），u=0.5 处最快
            MODE_SOFT -> u * u * (3f - 2f * u)

            // ease-out：二次 1 − (1−u)²，起步最快、收尾为 0
            MODE_SNAPPY -> 1f - (1f - u) * (1f - u)

            else -> u
        }
    }

    /**
     * 进度型曲线的**瞬时速度**（位移比例对进度的导数）。
     *
     * 保留为文档与将来可能的需要（比如按速度做告警判定）。
     * ⚠️ **不要**用它写"每帧位移 = 剩余距离 × 速度"—— 那会让剩余距离逐帧缩小、
     * 位移逐帧衰减、**永远到不了目标**（实测停在 64.76%）。
     * 正确路径是 [progressCurve] 算绝对位置，见 [step] 的说明。
     */
    private fun progressSpeed(mode: Int, p: Float): Float {
        val u = p.coerceIn(0f, 1f)
        return when (mode) {
            MODE_SOFT -> 6f * u * (1f - u)      // ∫₀¹ = 1
            MODE_SNAPPY -> 2f * (1f - u)        // ∫₀¹ = 1
            else -> 1f
        }
    }

    // ================================================================ 缓动

    /**
     * 算一帧之后的值。
     *
     * **所有模式都保证**：单调逼近、不过冲、帧率无关（时间基准）。
     * 这三条由 [EasingTest] 逐个模式钉死 —— 新增模式也必须满足。
     *
     * ## 两种机制（**这是最容易搞错的地方**）
     *
     * | 模式 | 机制 | 参数含义 |
     * |---|---|---|
     * | [MODE_STANDARD] | **增量**：每帧朝目标走 `k·dist` | τ = 时间常数（一个 τ 走 63%） |
     * | [MODE_LINEAR] | **增量**：每帧走固定速度 | τ = 走完整个量程的时间 |
     * | [MODE_SOFT] / [MODE_SNAPPY] | **绝对位置**：位置 = 起点 + 总行程 × 曲线(进度) | τ = 总时长 = `2τ` |
     *
     * ### ⚠️ 为什么进度型必须是"绝对位置"而不是"每帧增量"
     *
     * 第一版写成 `每帧位移 = 剩余距离 × 曲线速度 × dt/时长`。看着合理，实际是错的：
     * **剩余距离每帧都在缩小**，于是位移逐帧衰减 —— 那不是"缓动过去"，
     * 而是又一个衰减曲线，**永远到不了目标**（实测停在 64.76 / 100）。
     *
     * 正确做法是把曲线作用在**固定不变的总行程**上：
     *
     * ```
     * 目标变化时：  起点 = 当前显示值，总行程 = 目标 − 起点
     * 每一帧：      显示值 = 起点 + 总行程 × 曲线(已走时间 / 总时长)
     * ```
     *
     * 这样进度只取决于**时间**，与分几帧无关 → 帧率无关；
     * 而且 `曲线(1) = 1` → **一定到位**。
     *
     * @param from      当前显示值
     * @param target    目标值
     * @param dtMs      距上一帧的毫秒数
     * @param tauMs     时间常数（越小越快）
     * @param mode      [MODE_STANDARD] / [MODE_LINEAR] / [MODE_SOFT] / [MODE_SNAPPY]
     * @param range     用于"线性"模式换算速度的参考量程（= max − min）
     * @param elapsedMs 距目标上一次变化过了多久。**负数 = 刚变化**（进度 0）。
     * @param journeyStart 目标变化那一刻的显示值（进度型曲线的起点）
     * @param journeyDist  目标变化那一刻的总行程（`目标 − 起点`，**固定不变**）
     */
    fun step(
        from: Float,
        target: Float,
        dtMs: Float,
        tauMs: Float = 120f,
        mode: Int = MODE_STANDARD,
        range: Float = 0f,
        elapsedMs: Float = -1f,
        journeyStart: Float = Float.NaN,
        journeyDist: Float = Float.NaN
    ): Float {
        if (dtMs <= 0f) return from
        val tau = tauMs.coerceAtLeast(1f)
        val dt = dtMs.coerceAtMost(MAX_DT_MS)
        val delta = target - from
        if (delta == 0f) return target
        // 方向：+1 / -1。用 sign 而不是比较，避免 delta 极小时的抖动
        val dir = if (delta > 0f) 1f else -1f
        val dist = Math.abs(delta)

        val moved = when (mode) {
            // 指数逼近：k 已按参考帧长归一化 → 帧率无关、永不过冲
            MODE_STANDARD -> dist * blend(tau, dt)

            // 线性：以 range/tau 为基准速度匀速走。
            // ⚠️ 这里**不按 dist 夹**（那会让最后一步短于其它步，破坏"匀速"），
            // 统一在最后夹
            MODE_LINEAR -> {
                val r = if (range > 0f) range else dist
                r / tau * dt
            }

            // 进度型：绝对位置。需要调用方给出"总行程"（目标变化时固定下来的）
            MODE_SOFT, MODE_SNAPPY -> {
                val duration = tau * DURATION_K
                val p = if (elapsedMs < 0f) 0f else elapsedMs / duration
                val curve = progressCurve(mode, p)
                if (journeyDist.isNaN() || journeyStart.isNaN()) {
                    // 兜底：调用方没给总行程。退化成一个"按进度插值"的近似 ——
                    // ⚠️ 它没有曲线形状（等于线性），但**必须能收敛**：
                    // 进度 ≥ 1 时直接落到目标。否则动画会永远差一点点、永远空转。
                    if (p >= 1f) dist else dist * (dt / duration)
                } else {
                    // 正常路径：曲线作用在固定总行程上 → 有形状、帧率无关、一定到位。
                    //
                    // `journeyStart + journeyDist*curve` 是**该到的绝对位置**，
                    // 减去 from 就是"这一步该走多少"。
                    //
                    // ⚠️ 必须取 `abs`：下降方向（`journeyDist < 0`）算出来是负数，
                    // 而后面统一乘 `dir = −1` 来处理方向。不取 abs 的话负数会被
                    // `coerceIn(0, dist)` 夹成 0 → **下降方向恒不动**
                    // （上升方向完全测不出来，这个 bug 我实际写出来过）。
                    Math.abs((journeyStart + journeyDist * curve) - from)
                }
            }

            // 未知模式回落到标准，绝不崩
            else -> dist * blend(tau, dt)
        }

        // 夹住不过冲：moved ∈ [0, dist]，所以结果必然落在 [from, target] 之间
        return from + dir * moved.coerceIn(0f, dist)
    }

    // ================================================================ 输入滤波

    /**
     * 输入滤波（指数滑动平均，时间基准）。
     *
     * ## 为什么需要它
     *
     * 缓动解决的是"数值跳变要过渡"，但**数据本身带抖动**（传感器噪声、
     * 5Hz 量化）。抖动直接喂给缓动的话，指针会小幅高频地抖 —— 看着"毛躁"。
     * 这一层专门压这个，与缓动曲线解耦：想更稳就调大 `smoothMs`，
     * 想更灵敏就调小，不影响过渡手感。
     *
     * @param smoothMs 平滑时间常数。**0 = 不滤波**（原样返回，零开销）
     */
    fun smooth(prev: Float?, raw: Float, dtMs: Float, smoothMs: Float): Float {
        if (prev == null) return raw
        if (smoothMs <= 0f) return raw
        if (dtMs <= 0f) return prev
        // 与缓动用同一套归一化混合系数 → 滤波同样帧率无关
        val k = blend(smoothMs, dtMs)
        return prev + (raw - prev) * k
    }

    // ================================================================ 收敛

    /**
     * 是否还需要继续动画。
     *
     * @param dist      当前显示值与目标的距离（绝对值）
     * @param epsilon   吸附阈值（子类按像素折算）
     * @param sinceTargetChangeMs 距上一次**目标值变化**过了多久
     *
     * 判据见类注释：**数据还在变时不许停止**，否则会"停一下再跳"。
     */
    fun needsMoreFrames(dist: Float, epsilon: Float, sinceTargetChangeMs: Long): Boolean {
        if (dist > epsilon) return true
        // 已经够近了：只有在目标也稳定下来之后才允许停
        return sinceTargetChangeMs < HOLD_MS
    }

    /**
     * 是否该把显示值吸附到目标。
     *
     * 吸附的作用是**消除指数逼近的尾巴**（永远差一点点会累积误差），
     * 但它不该决定"要不要继续动画" —— 那是 [needsMoreFrames] 的事。
     */
    fun shouldSnap(dist: Float, epsilon: Float): Boolean = dist <= epsilon
}
