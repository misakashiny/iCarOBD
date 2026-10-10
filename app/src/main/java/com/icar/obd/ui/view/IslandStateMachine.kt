package com.icar.obd.ui.view

/**
 * 「灵动岛」悬浮提示的**状态机**（v1.20.12）。
 *
 * ## 为什么抽成纯逻辑
 *
 * 要测的三件事全在时间轴上，而时间轴上的东西在 `onDraw` / `Handler` 里**没法验**：
 * 「同一条规则每 450ms 触发一次，胶囊会不会一直闪」「三条规则同时报，谁压谁」
 * 「到点了到底收没收」。所以这里**不碰 View、不碰时间源**，`now` 由调用方传进来
 * （与 [AlertPulse]、`obd/FrameRateGate.kt` 同一条约定）。
 *
 * ## 三种情形，语义各不同
 *
 * | 情形 | 处理 | 为什么 |
 * |---|---|---|
 * | 空闲时来一条 | 展开，`until = now + hold` | 正常路径 |
 * | **同一条文本**再次到来 | **只续期**，不重播入场动画、不累加 `+N` | 转向灯那种规则每几百毫秒触发一次；重播动画会变成一直闪，而 `+N` 会瞬间涨到几百 |
 * | **不同文本**到来 | 换文案、重播入场动画、`pending + 1` | 这是"又出了一件事"，要看得出来；`pending` 显示成 `+N` |
 *
 * ## 为什么不做严格的 FIFO 队列
 *
 * 严格排队意味着"第 3 条要等前两条各 4 秒" —— 行车场景里 8 秒后才看到当前告警
 * 是**有害**的（水温已经上去了）。所以采用**最新一条压住旧的 + `+N` 计数**：
 * 当前信息永远是最新的，同时不丢"还有别的"这个事实。
 */
internal class IslandStateMachine(
    /**
     * 一条提示展开停留多久。
     *
     * v1.20.13 起是 `var` —— 停留时长进了设置（2 / 4 / 6 秒，见
     * `data/IslandStyle.HOLD_CHOICES_MS`），而设置可以在**运行中**改。
     * 调用方（`IslandNotice.show`）每次弹提示前按当前设置赋一次值即可，
     * 不需要为了改时长重建状态机（重建会把"还在显示的那条"一起丢掉）。
     */
    var holdMs: Long = HOLD_MS,
) {

    /** 一次"当前该显示成什么样"的快照。UI 只认它，不自己维护状态 */
    data class Snapshot(
        val visible: Boolean,
        val text: String,
        /** 展示期间又来了几条**不同**的消息（显示成 `+N`） */
        val pending: Int,
        /** 到点收起的时刻（`SystemClock.uptimeMillis()` 口径，由调用方给） */
        val untilMs: Long,
    ) {
        companion object {
            val HIDDEN = Snapshot(false, "", 0, 0L)
        }
    }

    private var visible = false
    private var text = ""
    private var pending = 0
    private var untilMs = 0L

    val current: Snapshot get() = if (visible) Snapshot(true, text, pending, untilMs) else Snapshot.HIDDEN

    /**
     * 来了一条新提示。
     *
     * @return 处理后的快照。**只有 `text` 变了才需要重播入场动画** ——
     *   调用方拿返回值的 `text` 与上一次比即可（不要比 `untilMs`，它每次都会变）
     */
    fun onMessage(msg: String, now: Long): Snapshot {
        val m = msg.trim()
        if (m.isEmpty()) return current
        when {
            !visible -> {
                visible = true
                text = m
                pending = 0
            }
            text == m -> {
                // 同一条重复触发：只续期（见类注释的表格）
            }
            else -> {
                text = m
                pending += 1
            }
        }
        untilMs = now + holdMs
        return current
    }

    /**
     * 时间推进。
     *
     * @return 收起后的快照（`visible=false`）或原样
     */
    fun onTick(now: Long): Snapshot {
        if (visible && now >= untilMs) {
            visible = false
            text = ""
            pending = 0
            untilMs = 0L
        }
        return current
    }

    /** 手动收起（例如用户离开仪表盘、或 Activity 销毁） */
    fun reset() {
        visible = false
        text = ""
        pending = 0
        untilMs = 0L
    }

    companion object {
        /**
         * 停留时长。
         *
         * 4 秒与告警条一致（`DashFragment.showAlert` 原来也是 4000ms）——
         * 换一个数字会让"同一件事在两个地方停留时间不同"，没必要。
         * 够看清一句「水温 105℃ 过高」，又不至于赖在画布上不走。
         */
        const val HOLD_MS = 4000L
    }
}
