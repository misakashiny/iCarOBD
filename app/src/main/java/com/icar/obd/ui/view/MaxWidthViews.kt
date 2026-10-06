package com.icar.obd.ui.view

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import androidx.core.widget.NestedScrollView
import com.icar.obd.R

/**
 * 最大宽度约束容器（三个变体，共用同一套限宽逻辑）。
 *
 * ## 为什么需要它
 *
 * 表单类页面（PID 编辑器 / 规则编辑器 / 扫描器 / 连接页）在竖屏手机上宽度约
 * 360~420dp，字段铺满整宽正好。同一套 XML 放到横屏平板上宽度变成 1100dp+，
 * 单列表单会被拉成「一行一个超宽输入框」，扫读成本高、观感差。
 *
 * ## 做法
 *
 * 测量时把自己的宽度夹到 `maxWidthDp` 以内，配合 `android:layout_gravity="center_horizontal"`
 * 由父容器居中。竖屏（屏幕本来就窄）完全不受影响，因此
 * **不需要写 layout-land 副本 —— 一套 XML 同时适配两种方向**。
 *
 * ## 为什么是 ScrollView 变体而不是纯 FrameLayout
 *
 * 表单页的根几乎都是 `LinearLayout > ScrollView > 内容`。
 * 如果做成 FrameLayout 包装器，就得在每个布局里插一层开始/结束标签并重新缩进
 * （4 个编辑器 × 460 行 XML，改动面大且易错）。
 * 直接继承 ScrollView 只需**换掉一行标签 + 加一行 layout_gravity**。
 *
 * ## 用法
 * ```xml
 * <com.icar.obd.ui.view.MaxWidthScrollView
 *     android:layout_width="match_parent"
 *     android:layout_height="0dp"
 *     android:layout_weight="1"
 *     android:layout_gravity="center_horizontal"
 *     android:fillViewport="true"
 *     app:maxWidthDp="720dp">
 *     ... 表单内容 ...
 * </com.icar.obd.ui.view.MaxWidthScrollView>
 * ```
 *
 * 注意：父容器必须支持 `layout_gravity`（LinearLayout / FrameLayout 都可以）。
 */

/** 限宽计算。返回夹取后的宽度像素。 */
private fun cappedWidth(view: View, maxWidthPx: Int, widthMeasureSpec: Int): Int {
    val mode = View.MeasureSpec.getMode(widthMeasureSpec)
    val size = View.MeasureSpec.getSize(widthMeasureSpec)
    return if (mode == View.MeasureSpec.UNSPECIFIED) maxWidthPx else minOf(size, maxWidthPx)
}

/** 从 XML 读取 maxWidthDp，缺省用 [DEFAULT_MAX_DP]。 */
private fun readMaxWidth(context: Context, attrs: AttributeSet?, defStyleAttr: Int): Int {
    val fallback = (DEFAULT_MAX_DP * context.resources.displayMetrics.density).toInt()
    if (attrs == null) return fallback
    val a = context.obtainStyledAttributes(attrs, R.styleable.MaxWidth, defStyleAttr, 0)
    val v = a.getDimensionPixelSize(R.styleable.MaxWidth_maxWidthDp, fallback)
    a.recycle()
    return v
}

/** 未在 XML 指定时的默认上限。720dp ≈ 竖屏平板全宽，横屏下两侧各留白 */
private const val DEFAULT_MAX_DP = 720f

/** 纵向滚动 + 最大宽度约束 */
class MaxWidthScrollView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : ScrollView(context, attrs, defStyleAttr) {

    private val maxWidthPx = readMaxWidth(context, attrs, defStyleAttr)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(
                cappedWidth(this, maxWidthPx, widthMeasureSpec), MeasureSpec.EXACTLY
            ),
            heightMeasureSpec
        )
    }
}

/** NestedScrollView + 最大宽度约束（给 Fragment 用，支持嵌套滚动） */
class MaxWidthNestedScrollView @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : NestedScrollView(context, attrs, defStyleAttr) {

    private val maxWidthPx = readMaxWidth(context, attrs, defStyleAttr)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(
                cappedWidth(this, maxWidthPx, widthMeasureSpec), MeasureSpec.EXACTLY
            ),
            heightMeasureSpec
        )
    }
}

/** 通用包装容器：给不是 ScrollView 的内容（如 RecyclerView）加限宽 */
class MaxWidthLayout @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : FrameLayout(context, attrs, defStyleAttr) {

    private val maxWidthPx = readMaxWidth(context, attrs, defStyleAttr)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(
                cappedWidth(this, maxWidthPx, widthMeasureSpec), MeasureSpec.EXACTLY
            ),
            heightMeasureSpec
        )
    }
}

/**
 * 线性布局 + 最大宽度约束。
 *
 * **列表页首选**：把 Fragment 的根 LinearLayout 直接换成它，
 * 顶部按钮区与下方列表会一起被限宽，左右边缘自然对齐，
 * 不需要在中间插一层包装容器（插层会让 XML 缩进错乱、后续难维护）。
 *
 * 用法（Fragment 根，配合 layout_gravity 让容器居中）：
 * ```xml
 * <com.icar.obd.ui.view.MaxWidthLinearLayout
 *     android:layout_width="match_parent"
 *     android:layout_height="match_parent"
 *     android:layout_gravity="center_horizontal"
 *     app:maxWidthDp="760dp">
 * ```
 * Fragment 的根视图会被加到 FragmentManager 的容器（FrameLayout）里，
 * 因此 `layout_gravity` 生效。
 *
 * ## ⚠️ 放进 ViewPager2 的页面里**不生效**（v1.20.2 实测）
 *
 * `FragmentStateAdapter.addViewToContainer()` 给页面根视图套的是
 * `FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)` —— **gravity 被覆盖掉了**。
 * 于是"限宽生效、居中失效"，整页靠左（实测：内容 x=250..1770，而页面是 200..2560）。
 *
 * 修法：**自己再套一层 FrameLayout 提供居中**，那一层由布局文件控制、pager 不改写它。
 * 见 `fragment_canvas_settings.xml` 的根。
 */
class MaxWidthLinearLayout @JvmOverloads constructor(
    context: Context, attrs: AttributeSet? = null, defStyleAttr: Int = 0
) : LinearLayout(context, attrs, defStyleAttr) {

    private val maxWidthPx = readMaxWidth(context, attrs, defStyleAttr)

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(
            MeasureSpec.makeMeasureSpec(
                cappedWidth(this, maxWidthPx, widthMeasureSpec), MeasureSpec.EXACTLY
            ),
            heightMeasureSpec
        )
    }
}
