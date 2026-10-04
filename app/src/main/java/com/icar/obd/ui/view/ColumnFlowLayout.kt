package com.icar.obd.ui.view

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.view.ViewGroup

/**
 * 分栏流式布局：**宽度够就自动分 2 列**。
 *
 * ## 解决什么问题
 *
 * 平板横屏可用宽度 1138dp，而表单控件是单列的 —— 结果一行一个「超宽输入框」，
 * 既难看又浪费。`MaxWidthViews` 那套是把内容**夹窄居中**，治的是「太宽」；
 * 但夹窄之后右边一大片还是空的。分栏才是真正把宽度用起来。
 *
 * ## 为什么不用 `layout-land` 副本
 *
 * 同一份表单写两遍 XML，改一处忘一处是必然的。这里的列数由**可用宽度**决定，
 * 竖屏自动 1 列、横屏自动 2 列，一份代码通吃，也不需要 `layout-land`。
 *
 * ## 摆放规则
 *
 * 依次把每个孩子放进**当前最矮的那一列**（masonry / 瀑布流）。
 * 对「字段行高度不一」的表单来说，这比按行切分更整齐 —— 按行切分会让
 * 一个高控件把整行撑开，另一边留一大块空白。
 *
 * 列分配规则抽成了纯函数 [assign]，可单测 —— 布局错位这类问题肉眼才发现就太晚了。
 */
class ColumnFlowLayout @JvmOverloads constructor(
    ctx: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : ViewGroup(ctx, attrs, defStyle) {

    /** 可用宽度达到这个 dp 就启用多列 */
    var twoColumnMinWidthDp: Int = 640

    /** 最多几列。平板横屏 2 列已经够用，3 列会让每列太窄 */
    var maxColumns: Int = 2

    /** 列间距（dp） */
    var columnGapDp: Int = 12

    /** 行间距（dp） */
    var rowGapDp: Int = 2

    // onMeasure 决定，onLayout 复用 —— 两处各算一次很容易算出不同结果
    private var columns = 1
    private var colWidth = 0
    private var colGap = 0
    private var rowGap = 0

    private fun visibleChildren(): List<View> =
        (0 until childCount).map { getChildAt(it) }.filter { it.visibility != GONE }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val density = resources.displayMetrics.density
        val width = MeasureSpec.getSize(widthMeasureSpec)

        columns = if (width >= twoColumnMinWidthDp * density) maxColumns.coerceAtLeast(1) else 1
        colGap = (columnGapDp * density).toInt()
        rowGap = (rowGapDp * density).toInt()

        val contentW = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        colWidth = if (columns <= 1) {
            contentW
        } else {
            ((contentW - colGap * (columns - 1)) / columns).coerceAtLeast(0)
        }

        val kids = visibleChildren()
        val childSpec = MeasureSpec.makeMeasureSpec(colWidth, MeasureSpec.EXACTLY)
        val heights = IntArray(kids.size)
        kids.forEachIndexed { i, c ->
            c.measure(childSpec, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            heights[i] = c.measuredHeight
        }

        val colHeights = assign(heights.toList(), columns, rowGap)
        val h = (colHeights.maxOrNull() ?: 0) + paddingTop + paddingBottom
        setMeasuredDimension(width, resolveSize(h, heightMeasureSpec))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val kids = visibleChildren()
        val heights = kids.map { it.measuredHeight }
        // 与 onMeasure 用**同一个纯函数**，保证两次分配完全一致
        val colOf = assignColumns(heights, columns, rowGap)

        val colY = IntArray(columns)
        kids.forEachIndexed { i, c ->
            val col = colOf[i]
            val x = paddingLeft + col * (colWidth + colGap)
            val y = paddingTop + colY[col]
            c.layout(x, y, x + colWidth, y + c.measuredHeight)
            colY[col] += c.measuredHeight + rowGap
        }
    }

    companion object {
        /**
         * 依次把每个孩子放进当前最矮的列，返回**每列的总高度**。
         * 纯函数，可单测。
         */
        fun assign(heights: List<Int>, columns: Int, gap: Int): IntArray {
            val col = IntArray(columns.coerceAtLeast(1))
            heights.forEach { h ->
                var t = 0
                for (j in 1 until col.size) if (col[j] < col[t]) t = j
                col[t] += h + gap
            }
            return col
        }

        /** 与 [assign] 同样的规则，但返回**每个孩子落在哪一列** */
        fun assignColumns(heights: List<Int>, columns: Int, gap: Int): IntArray {
            val n = columns.coerceAtLeast(1)
            val col = IntArray(n)
            val out = IntArray(heights.size)
            heights.forEachIndexed { i, h ->
                var t = 0
                for (j in 1 until n) if (col[j] < col[t]) t = j
                out[i] = t
                col[t] += h + gap
            }
            return out
        }
    }
}
