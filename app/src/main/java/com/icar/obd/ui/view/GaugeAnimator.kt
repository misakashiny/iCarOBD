package com.icar.obd.ui.view

/**
 * 单个数值的动画状态机（v1.10.4）。
 *
 * ## 为什么把它从 `BaseGaugeView` 里抽出来
 *
 * 这是重构文档 §2.2 步骤 2 要的那一步。抽出来的直接收益是**可测**：
 * 动画的状态机（起点、总行程、目标稳定计时）在 `stepFrame` 里**JVM 单测跑不了**
 * （要 View、要 Choreographer）。而"数据还在变时会不会冻住""重启后会不会抽风"
 * 这类问题恰恰只出在状态机上，不在数学上。
 *
 * 抽出来之后 `BaseGaugeView` 少了约 40 行可变状态，且这些状态有了单一负责人。
 *
 * ## 状态一览
 *
 * | 状态 | 作用 |
 * |---|---|
 * | [display] | 当前显示值（动画中的中间值） |
 * | `filteredTarget` | 输入滤波后的目标（压数据抖动） |
 * | `lastTarget` | 上一次的目标，用来判断"数据是不是还在变" |
 * | `targetChangedAtMs` | 目标上次变化的时刻（进度型曲线的进度基准） |
 * | `journeyStart` / `journeyDist` | 目标变化时**固定下来**的总行程（进度型曲线用） |
 *
 * ## 不做的事
 *
 * 不认识 View、不碰主题、不管报警爆闪 —— 那些留在 [BaseGaugeView]。
 * 本类只回答一个问题：**这一帧该显示多少**。
 *
 * @param tauMs 缓动时间常数
 * @param mode 缓动曲线，见 [Easing.MODE_*]
 * @param smoothMs 输入滤波时间常数，0 = 不过滤
 * @param range 参考量程（线性模式换算速度用）
 */
class GaugeAnimator(
    var tauMs: Float = 120f,
    var mode: Int = Easing.MODE_STANDARD,
    var smoothMs: Float = 90f,
    var range: Float = 0f
) {

    /** 当前显示值。`null` = 还没有过有效值 */
    var display: Float? = null
        private set

    private var filteredTarget: Float? = null
    private var lastTarget: Float? = null
    private var targetChangedAtMs = 0L
    private var journeyStart = Float.NaN
    private var journeyDist = Float.NaN

    /** 上一帧的 vsync 时间戳。0 = 还没跑过（第一帧按 16ms 算） */
    private var lastFrameMs = 0L

    /**
     * 推进一帧。
     *
     * @param raw    原始值（来自总线）。`null` / `NaN` = 无数据，直接透传
     * @param nowMs  vsync 时间戳（毫秒）
     * @param epsilon 吸附阈值（子类按像素折算后传入）
     * @return 是否还需要继续动画
     */
    fun step(raw: Float?, nowMs: Long, epsilon: Float): Boolean {
        val dt = if (lastFrameMs == 0L) 16f else (nowMs - lastFrameMs).toFloat()
        lastFrameMs = nowMs

        if (raw == null || raw.isNaN()) {
            display = raw
            filteredTarget = raw
            lastTarget = raw
            return false
        }

        // ---- 第 1 层：输入滤波（压抖动）----
        val target = Easing.smooth(filteredTarget, raw, dt, smoothMs)
        filteredTarget = target

        // 目标变了 → 记时间戳，并把"总行程"固定下来
        if (lastTarget == null || target != lastTarget) {
            targetChangedAtMs = nowMs
            journeyStart = display ?: target
            journeyDist = target - journeyStart
            lastTarget = target
        }

        // ---- 第 2 层：缓动曲线 ----
        val from = display ?: target
        val next = Easing.step(
            from = from,
            target = target,
            dtMs = dt,
            tauMs = tauMs,
            mode = mode,
            range = range,
            elapsedMs = if (targetChangedAtMs == 0L) -1f else (nowMs - targetChangedAtMs).toFloat(),
            journeyStart = journeyStart,
            journeyDist = journeyDist
        )
        val dist = Math.abs(target - from)

        // ---- 第 3 层：收敛判据 ----
        // 吸附消除指数逼近的尾巴（累积误差），但**不决定要不要继续动画**
        display = if (Easing.shouldSnap(dist, epsilon)) target else next
        return Easing.needsMoreFrames(
            dist = Math.abs(target - display!!),
            epsilon = epsilon,
            sinceTargetChangeMs = nowMs - targetChangedAtMs
        )
    }

    /**
     * 重新开始动画前调用。
     *
     * 清掉帧时间与"目标稳定计时"：否则停一会儿再启动时，
     * `targetChangedAtMs` 还停在很久以前 → 第一帧就判定"目标已稳定"→ 立刻停止。
     * 总行程也要作废，否则会拿着上一轮的起点算进度。
     */
    fun restart() {
        lastFrameMs = 0L
        targetChangedAtMs = 0L
        lastTarget = null
        journeyStart = Float.NaN
        journeyDist = Float.NaN
    }

    /** 直接跳到某个值（不经过动画）。用于没有数据 / 切换数据源 */
    fun snapTo(v: Float?) {
        display = v
        filteredTarget = v
        lastTarget = v
    }
}
