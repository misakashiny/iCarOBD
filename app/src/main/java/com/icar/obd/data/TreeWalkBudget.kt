package com.icar.obd.data

/**
 * **反向遍历 View 树的预算**（v1.20.15）。
 *
 * ## 为什么需要它
 *
 * v1.20.14 的检视器在 `MainActivity.dispatchTouchEvent` 里**同步**遍历整棵 View 树找命中控件
 * （`UiInspectorOverlay.hitTest`）。那一版的卡死根因**不在这里**（是
 * [UiInspectorInfo.chainLine] 的死循环，见那边的注释），但"在触摸路径上做无界遍历"
 * 本身就是一颗**随时会响的雷**：
 *
 * - `RecyclerView` / `ViewPager` 在页数多时子 View 数量不可控；
 * - 树深没有保证（每一层包装容器都算一层）；
 * - 万一日后有人写出"父子互相引用"的自定义容器，递归会**直接爆栈**或转不出来。
 *
 * 而这条路径是**主线程**上的：转不出来 = `dispatchTouchEvent` 不返回 = ANR。
 * 所以规格（本次任务）明确要求：**遍历必须有界（深度上限 / 节点数上限 / 不得递归到环）**。
 *
 * ## 为什么单独一个纯类
 *
 * 预算判定是**纯计数**，与 `View` 无关 —— 放 `data/` 就能在 JVM 单测里断言
 * "第 33 层进不去""第 4001 个节点不放行"（`TreeWalkBudgetTest`）。
 * 真正的 `View` 递归在 `ui/view/UiInspectorOverlay.kt`，那里只能装机验。
 *
 * ## 三个上限各自防什么
 *
 * | 上限 | 防的是 |
 * |---|---|
 * | [maxDepth] | 深树把递归栈压爆、或在一棵"没有底"的树上转不出来 |
 * | [maxNodes] | 宽树（几千个子 View）把一帧拖到几十毫秒 |
 * | [seen] | **环**：同一个 View 在一次遍历里只处理一次，父子互指也不会转圈 |
 *
 * ⚠️ 达到上限**不是错误**：遍历**提前收手**，退化成"这一下没检视到"。
 * 宁可漏检一次，也不能卡死（这是本次任务的硬要求）。
 */
class TreeWalkBudget(
    val maxDepth: Int = MAX_DEPTH,
    val maxNodes: Int = MAX_NODES,
) {

    /** 已经放行的节点数 */
    var nodes: Int = 0
        private set

    /** 实际达到过的最大深度（诊断/单测用） */
    var deepest: Int = 0
        private set

    /** 见过的 View（**按身份**比较）—— 用来断环 */
    private val seen = HashSet<ViewKey>()

    /** 是不是已经因为超预算而收手了（调用方据此决定要不要记一条日志） */
    var truncated: Boolean = false
        private set

    /**
     * 能不能进入深度 [depth]（根 = 0）。
     *
     * 到上限就**不再往下钻**，并置 [truncated]。
     */
    fun canEnter(depth: Int): Boolean {
        if (depth >= maxDepth) {
            truncated = true
            return false
        }
        if (depth > deepest) deepest = depth
        return true
    }

    /**
     * 认领一个节点（在真正读它的属性**之前**调）。
     *
     * 返回 `false` = 这个节点不该被处理，调用方必须 `continue`/`return`：
     * - 已经见过（**环**）；
     * - 节点数已经到顶。
     */
    fun claim(key: ViewKey): Boolean {
        if (nodes >= maxNodes) {
            truncated = true
            return false
        }
        if (!seen.add(key)) {
            truncated = true
            return false
        }
        nodes++
        return true
    }

    /**
     * 一次遍历里"同一个 View"的身份。
     *
     * 用 `System.identityHashCode` 而不是 `View.equals`：`View` 没有重写 `equals`
     * （就是引用相等），但**显式写出来**能让人一眼看出"这是按身份去重"，
     * 而不是误以为在比内容。`identityHashCode` 理论上会碰撞，所以这里**只拿它当哈希**，
     * 相等判定交给引用本身 —— 碰撞最多让两个不同 View 里少检视一个，不会死循环。
     */
    class ViewKey(private val v: Any) {
        private val h = System.identityHashCode(v)
        override fun hashCode(): Int = h

        /** **引用相等**才是同一个 View；哈希碰撞不会把两个不同的 View 判成同一个 */
        override fun equals(other: Any?): Boolean = other is ViewKey && other.v === v
    }

    companion object {
        /**
         * 深度上限。
         *
         * 实测的 Android 窗口树深度：`DecorView > LinearLayout > FrameLayout > content
         * > rootLayout > pageContainer > Fragment 容器 > …`，一个正常的页面在 **12~20** 层。
         * 取 32 是"正常页面两倍"的余量 —— 真到 32 层，那棵树本身就该修了。
         */
        const val MAX_DEPTH = 32

        /**
         * 节点数上限。
         *
         * 一次点击能碰到的最坏情况：一个铺满屏幕的 `RecyclerView`（十几行 × 每行十几个 View）
         * ≈ 几百个。取 4000 是**一个数量级**的余量；到 4000 说明这棵树不适合"点一下全遍历"，
         * 那时候正确做法是收手，而不是把主线程按住。
         */
        const val MAX_NODES = 4000
    }
}
