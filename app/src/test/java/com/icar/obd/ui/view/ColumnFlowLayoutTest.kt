package com.icar.obd.ui.view

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * 分栏流式布局的列分配规则（第二轮迭代补）。
 *
 * 只测纯函数 [ColumnFlowLayout.assign] / [ColumnFlowLayout.assignColumns] ——
 * 布局错位这类问题要肉眼才发现就太晚了，而规则本身完全可以钉死。
 */
class ColumnFlowLayoutTest {

    @Test
    fun `单列时所有孩子都在第 0 列`() {
        assertArrayEquals(
            intArrayOf(0, 0, 0),
            ColumnFlowLayout.assignColumns(listOf(10, 20, 30), 1, 2)
        )
    }

    @Test
    fun `两列时依次放进当前最矮的列`() {
        // 10→列0(10)；20→列1(20)；此时列0(10)更矮，30 仍进列0
        assertArrayEquals(
            intArrayOf(0, 1, 0),
            ColumnFlowLayout.assignColumns(listOf(10, 20, 30), 2, 0)
        )
    }

    @Test
    fun `等高块在两列间均分`() {
        val col = ColumnFlowLayout.assign(listOf(50, 50, 50, 50), 2, 0)
        assertEquals("等高的四块应均分", col[0], col[1])
        assertEquals(100, col[0])
    }

    @Test
    fun `三列也能均衡`() {
        val col = ColumnFlowLayout.assign(listOf(10, 10, 10, 10, 10, 10), 3, 0)
        assertEquals(col[0], col[1])
        assertEquals(col[1], col[2])
        assertEquals(20, col[0])
    }

    @Test
    fun `assign 与 assignColumns 是同一套规则`() {
        val heights = listOf(30, 10, 45, 5, 60, 20)
        val total = ColumnFlowLayout.assign(heights, 2, 4)
        val cols = ColumnFlowLayout.assignColumns(heights, 2, 4)
        // 按 assignColumns 的结果重算每列高度，必须与 assign 完全一致 ——
        // onMeasure 用前者、onLayout 用后者，不一致就会错位
        val re = IntArray(2)
        heights.forEachIndexed { i, h -> re[cols[i]] += h + 4 }
        assertArrayEquals(total, re)
    }

    @Test
    fun `间隙计入列高`() {
        val noGap = ColumnFlowLayout.assign(listOf(10, 10), 1, 0)
        val withGap = ColumnFlowLayout.assign(listOf(10, 10), 1, 5)
        assertEquals(20, noGap[0])
        assertEquals(30, withGap[0])
    }

    @Test
    fun `空列表不崩`() {
        assertArrayEquals(IntArray(2), ColumnFlowLayout.assign(emptyList(), 2, 2))
        assertEquals(0, ColumnFlowLayout.assignColumns(emptyList(), 2, 2).size)
    }

    @Test
    fun `列数为 0 或负数时按 1 列处理`() {
        assertArrayEquals(intArrayOf(10), ColumnFlowLayout.assign(listOf(10), 0, 0))
        assertArrayEquals(intArrayOf(0), ColumnFlowLayout.assignColumns(listOf(10), -3, 0))
    }

    @Test
    fun `极不均衡的高度也不会让某列空着`() {
        // 一个超高块 + 一堆矮块：矮块应全部堆到另一列
        val heights = listOf(1000, 10, 10, 10)
        val cols = ColumnFlowLayout.assignColumns(heights, 2, 0)
        assertEquals(0, cols[0])
        assertEquals(1, cols[1])
        assertEquals(1, cols[2])
        assertEquals(1, cols[3])
    }
}
