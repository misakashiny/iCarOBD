package com.icar.obd.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * **反向遍历 View 树的预算**单测（v1.20.15）。
 *
 * ## 这一组用例守的是什么
 *
 * 任务要求写死了三条："遍历必须有界（深度上限 / 节点数上限 / 不得递归到环）"。
 * `View` 在 JVM 里碰不得（`android.jar` 是抛 `Stub!` 的桩），
 * 所以真正能单测的是**判定逻辑**：[TreeWalkBudget]。
 * 而"`hitTest` 确实按预算收手"只能装机验 —— 报告里如实写明。
 *
 * ⚠️ 这里用 `Any()` 冒充 View：预算只关心**身份**（`identityHashCode` + 引用相等），
 * 不关心它是不是 View。这样这一组用例既快又不碰 Android。
 */
class TreeWalkBudgetTest {

    // ------------------------------------------------------------ 深度

    @Test
    fun `深度到上限就不再往下钻`() {
        val b = TreeWalkBudget(maxDepth = 4, maxNodes = 100)
        // 根 = 0，所以 0..3 进得去，4 进不去
        assertTrue(b.canEnter(0))
        assertTrue(b.canEnter(3))
        assertFalse("第 4 层必须被挡住", b.canEnter(4))
        assertTrue("挡住之后要标记收手了", b.truncated)
    }

    @Test
    fun `最深记录只涨不跌`() {
        val b = TreeWalkBudget(maxDepth = 8, maxNodes = 100)
        b.canEnter(0)
        b.canEnter(5)
        b.canEnter(2)
        assertEquals(5, b.deepest)
    }

    @Test
    fun `默认上限是一个数量级余量，不是卡死的紧箍咒`() {
        // 正常页面 12~20 层、几百个 View —— 默认值必须离它们很远，
        // 否则"检视器动不动就检视不到"本身就是个新 bug。
        assertTrue(TreeWalkBudget.MAX_DEPTH >= 24)
        assertTrue(TreeWalkBudget.MAX_NODES >= 2000)
        val b = TreeWalkBudget()
        assertTrue(b.canEnter(TreeWalkBudget.MAX_DEPTH - 1))
        assertFalse(b.canEnter(TreeWalkBudget.MAX_DEPTH))
    }

    // ------------------------------------------------------------ 节点数

    @Test
    fun `节点数到上限就收手`() {
        val b = TreeWalkBudget(maxDepth = 10, maxNodes = 3)
        assertTrue(b.claim(TreeWalkBudget.ViewKey(Any())))
        assertTrue(b.claim(TreeWalkBudget.ViewKey(Any())))
        assertTrue(b.claim(TreeWalkBudget.ViewKey(Any())))
        assertFalse("第 4 个不许放行", b.claim(TreeWalkBudget.ViewKey(Any())))
        assertEquals(3, b.nodes)
        assertTrue(b.truncated)
    }

    // ------------------------------------------------------------ 环

    @Test
    fun `同一个节点第二次出现必须被挡住（断环）`() {
        val b = TreeWalkBudget(maxDepth = 10, maxNodes = 100)
        val v = Any()
        assertTrue("第一次要放行", b.claim(TreeWalkBudget.ViewKey(v)))
        assertFalse("同一个对象再来一次就是环，必须挡住", b.claim(TreeWalkBudget.ViewKey(v)))
        assertEquals("被挡住的不计入节点数", 1, b.nodes)
        assertTrue(b.truncated)
    }

    @Test
    fun `不同的对象互不影响`() {
        val b = TreeWalkBudget(maxDepth = 10, maxNodes = 100)
        val a = Any()
        val c = Any()
        assertTrue(b.claim(TreeWalkBudget.ViewKey(a)))
        assertTrue(b.claim(TreeWalkBudget.ViewKey(c)))
        assertEquals(2, b.nodes)
        assertFalse(b.truncated)
    }

    @Test
    fun `环也能被深度上限兜住（两道闸互相独立）`() {
        // 万一哪天去重被绕过了，深度上限还在 —— 这一条守的是"两道闸都真的存在"
        val b = TreeWalkBudget(maxDepth = 3, maxNodes = 1000)
        var depth = 0
        var guard = 0
        while (b.canEnter(depth) && guard++ < 100) depth++
        assertEquals("最多钻到第 3 层", 3, depth)
        assertTrue(b.truncated)
    }

    // ------------------------------------------------------------ 正常路径

    @Test
    fun `正常的一棵树不会被误判为收手`() {
        val b = TreeWalkBudget()
        // 模拟：20 层深、每层 3 个兄弟 —— 真实页面就是这个量级
        for (d in 0 until 20) {
            assertTrue(b.canEnter(d))
            repeat(3) { assertTrue(b.claim(TreeWalkBudget.ViewKey(Any()))) }
        }
        assertFalse("正常树不该触发收手", b.truncated)
        assertEquals(60, b.nodes)
    }
}
