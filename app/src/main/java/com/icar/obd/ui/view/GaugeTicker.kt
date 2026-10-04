package com.icar.obd.ui.view

import android.view.Choreographer
import android.view.View
import java.util.WeakHashMap

/**
 * 所有仪表**共用的动画时钟**。
 *
 * ## 为什么需要它（这是"模拟信号时特别卡"的主因）
 *
 * 原来每个仪表自己 `postDelayed(animator, 16)`：
 *
 * ```
 * 8 个仪表 → 每帧 8 次消息投递 → 8 次不同步的 invalidate → 8 次重绘
 * ```
 *
 * 三个问题：
 *  1. **消息队列压力**：每秒 480 次 `postDelayed`，而且每帧都要重新投递；
 *  2. **和 vsync 不同步**：各自按 16ms 猜，实际会和屏幕刷新错拍，
 *     有时一帧画两次、有时一次都不画 —— 表现就是**忽快忽慢、撕裂感**；
 *  3. **无法统一节流**：想降帧率得改 8 个地方。
 *
 * 改成 `Choreographer` 之后：**每帧一次回调，所有仪表在同一帧里一起重绘**，
 * 天然和 vsync 对齐。
 *
 * ## 生命周期
 *
 * 用 [WeakHashMap] 持有视图 —— 视图忘了反注册也不会泄漏。
 * 但仍然要求在 `onDetachedFromWindow` 里显式 [release]，否则会白跑一帧的回调。
 */
object GaugeTicker : Choreographer.FrameCallback {

    private val active = WeakHashMap<View, Boolean>()
    private var running = false

    /** 让某个视图加入动画。重复调是安全的 */
    fun request(view: View) {
        if (view !is AnimatableGauge) return
        active[view] = true
        if (!running) {
            running = true
            Choreographer.getInstance().postFrameCallback(this)
        }
    }

    fun release(view: View) {
        active.remove(view)
    }

    override fun doFrame(frameTimeNanos: Long) {
        // 用 vsync 时间戳，不用 SystemClock —— 后者在掉帧时会让动画"追赶"
        val nowMs = frameTimeNanos / 1_000_000
        var any = false

        try {
            // 先快照：回调里视图可能反注册（动画结束），遍历时改 map 会抛异常。
            //
            // ⚠️ `WeakHashMap` 在 **GC 回收了某个 key 时会自己修改内部结构**，
            // 快照过程有可能撞上 `ConcurrentModificationException`。
            // 这里吞掉并当作"这帧没有可动画的视图" —— 下一帧还会再来，
            // 但**绝不能让它冒泡**：冒泡会让 `running` 停在 true、时钟再也不启动。
            val list = try {
                active.keys.toList()
            } catch (t: Throwable) {
                emptyList()
            }
            list.forEach { v ->
                val ga = v as? AnimatableGauge ?: return@forEach
                if (ga.stepFrame(nowMs)) {
                    any = true
                } else {
                    active.remove(v)      // 收敛了，退出动画
                }
            }

            // 绘制统计也在这里结算 —— 保证它和实际帧率同源
            DrawStats.tick(nowMs)
        } catch (t: Throwable) {
            // 任何一帧出问题都不能让时钟停摆；下一帧继续
            any = active.isNotEmpty()
        } finally {
            if (any) {
                Choreographer.getInstance().postFrameCallback(this)
            } else {
                running = false
            }
        }
    }
}

/**
 * 参与共用时钟的仪表。
 *
 * 抽成接口是为了让 [GaugeTicker] 不必依赖 [BaseGaugeView] 的具体实现，
 * 也方便将来让别的会动的控件（比如波形缩略图的实时预览）接进来。
 */
interface AnimatableGauge {
    /**
     * 推进一帧。
     * @param nowMs vsync 时间戳（毫秒）
     * @return 是否还需要继续动画
     */
    fun stepFrame(nowMs: Long): Boolean
}
