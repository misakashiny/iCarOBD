package com.icar.obd.ui.dash

/**
 * 画布重建的**纯判定**（v1.20.12）。
 *
 * ## 为什么抽出来
 *
 * 这一版修的是一个 P0：**规则 toast 一弹，整个画布就不见了**。
 * 根因是"在 layout 期间 `addView`"—— 见 [DashRenderer.relayout] 的注释。
 * 而它之所以能拖到用户报了两轮才定位，是因为**所有常规判据都显示"一切正常"**：
 *
 * | 判据 | 坏掉时的样子 |
 * |---|---|
 * | `container.childCount` | 9（1 个参考线 + 8 块表）**正常** |
 * | 应用日志 `仪表盘已落盘 \| 表=8` | **照打** |
 * | `uiautomator dump` | 那一层**整个消失**（`isVisibleToUser=false` 被跳过） |
 * | 只有 `screencap` 像素 | **99.96% 是一片纯背景色** |
 *
 * 所以这里把三件"只有像素/尺寸才看得见"的判定做成纯函数：
 * 尺寸是否真的变了、有几块表是 0 尺寸、要不要补一次重建。
 * 它们不碰 View、不碰时间源，可以在 JVM 里直接测
 * （与 `ui/view/AlertPulse.kt`、`obd/FrameRateGate.kt` 同一条约定）。
 */
internal object CanvasRebuildPolicy {

    /**
     * 尺寸变化后**要不要**按上一次的规格重建。
     *
     * @param hasRendered 是否已经渲染过至少一次。**首次渲染之前必须为 false** ——
     *   否则"还没有任何规格"会被当成"规格是空的"，把空态提示闪一下，
     *   并打出一条误导性的「PID 全部查不到」（v1.20.1 修过的坑）
     * @param cw / @param ch 容器当前宽高（像素）
     * @param lastW / @param lastH 上一次渲染时记下的宽高
     */
    fun needsRebuild(hasRendered: Boolean, cw: Int, ch: Int, lastW: Int, lastH: Int): Boolean =
        hasRendered && (cw != lastW || ch != lastH)

    /**
     * 有几块表是"在树上但看不见"的。
     *
     * 判据是**宽或高 ≤ 0**：`FrameLayout` 用 `getMeasuredWidth()/Height()` 摆放子 View，
     * 而 layout 期间加进来的子 View 这两个值都是 0 —— 于是它被摆在 (0,0) 且尺寸为 0，
     * 屏幕上就是"什么都没有"。这正是这个 P0 的指纹。
     *
     * 注意 1 像素**不算**坏：`DashRenderer.render` 对宽高都有 `.coerceAtLeast(1)`，
     * 1×1 的表是"配置写错了"，不是"画布不见了"，不该触发补重建。
     */
    fun zeroSizedCount(sizes: List<Pair<Int, Int>>): Int =
        sizes.count { (w, h) -> w <= 0 || h <= 0 }

    /**
     * 要不要补一次重建。
     *
     * @param zeroSized 0 尺寸的表数
     * @param total     一共几块表
     * @param healed    本次"0 尺寸"事件里是否已经补过 —— **只补一次**：
     *   如果补完还是 0 尺寸，说明根因不是"时序"而是别的东西，
     *   继续补只会变成死循环（而且会把真正的错误刷掉）
     */
    fun shouldHeal(zeroSized: Int, total: Int, healed: Boolean): Boolean =
        zeroSized > 0 && total > 0 && !healed
}
