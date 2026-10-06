package com.icar.obd.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.viewpager2.widget.ViewPager2
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.Store
import com.icar.obd.ui.dash.CanvasSettingsFragment
import com.icar.obd.ui.dash.DashCanvasPageFragment
import com.icar.obd.ui.dash.DashCanvasPagerAdapter

/**
 * 仪表盘页 = **多套画布的宿主**（v1.20.0，方案 A）。
 *
 * ## 结构
 *
 * ```
 * DashFragment            ← 本文件：告警条 + ViewPager2 + 页码 → activeCanvasId
 *   └ ViewPager2  [画布0][画布1]…[设置]
 *        ├ DashCanvasPageFragment   每套画布一页（渲染 + 就地编辑）
 *        └ CanvasSettingsFragment   最后一页：画布管理 / 外观 / 全局开关
 * ```
 *
 * ## 它只做三件事
 *
 * 1. **页码 → 当前画布**：滑到第 N 页就 `Store.switchCanvas(第 N 套)`；
 * 2. **裁决谁在渲染**：ViewPager2 的相邻页一旦创建就处于 RESUMED，
 *    不统一裁决的话横滑几下就有好几个 5Hz 渲染器同时空转（见 [updatePageActivation]）；
 * 3. **告警条 + 模拟数据提示**：跨画布，与哪一套无关。
 *
 * 渲染、编辑、画布外观都不在这里 —— 本页因此从 v1.19.x 的 873 行降到 ~200 行。
 *
 * ## 一条容易踩的坑：`awaitingPos`
 *
 * `ViewPager2` 无法区分"用户滑的"和"我们调的"。而"新增一套画布"会把设置页
 * 从第 N 页挤到第 N+1 页，我们必须**自己**把 pager 挪过去；挪的过程中
 * `onPageSelected` 会报出中间页码（第 N 页，正好是一套画布）——
 * 照它切的话，用户只是加了一套画布，当前画布却被换成了别人。
 *
 * 所以：凡是**程序化**翻页，都先记下目标页 [awaitingPos]，
 * 期间所有 `onPageSelected` 一律不切画布（[handlePageSelected] 顶部那段）。
 */
class DashFragment : Fragment(), com.icar.obd.obd.ObdController.Listener {

    private lateinit var pager: ViewPager2
    private lateinit var adapter: DashCanvasPagerAdapter
    private lateinit var banner: TextView

    private val main = Handler(Looper.getMainLooper())
    private var hideBanner: Runnable? = null

    /**
     * 程序化翻页的目标页；`-1` = 没有正在进行的程序化翻页。
     * 语义见类注释最后一段。
     */
    private var awaitingPos = -1

    /**
     * 设置页要求"跳到某一套并直接进编辑态"时记下的页码；`-1` = 没有待处理的。
     * 由 [updatePageActivation] 在那一页真正激活后消费掉。
     */
    private var pendingEditPos = -1

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_dash, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        pager = view.findViewById(R.id.dashPager)
        banner = view.findViewById(R.id.alertBanner)

        adapter = DashCanvasPagerAdapter(this)
        pager.adapter = adapter
        // 1 = 只多留一页。多留会多几个渲染器（虽然非当前页已停推值，但 View 树还在）
        pager.offscreenPageLimit = 1

        // 起点 = 当前画布那一页。**必须吃掉这次页码变化** ——
        // 否则每次冷启动都会把 activeCanvasId 改成第 0 套（用户上次选的那套就丢了）
        val start = Store.activeCanvasIndex().coerceIn(0, (adapter.itemCount - 1).coerceAtLeast(0))
        awaitingPos = start
        pager.setCurrentItem(start, false)

        pager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) = handlePageSelected(position)
        })

        // 首次激活：页面的 Fragment 是在 pager 布局时才建出来的，
        // 所以真正的激活由 DashCanvasPageFragment.onResume 回调进来（onPageLifecycleChanged）
        pager.post { settleAwaiting(); updatePageActivation() }

        AppLog.i(
            AppLog.M_UI, "仪表盘宿主已就绪",
            "画布=${Store.settings.canvases.size} 当前=${Store.activeCanvas().name} 起点页=$start"
        )
    }

    override fun onResume() {
        super.onResume()
        updatePageActivation()
        refreshSimBanner()
        com.icar.obd.obd.ObdController.addListener(this)
    }

    override fun onPause() {
        super.onPause()
        // 别让隐藏页继续 5Hz 推值（`hide()` 切页不会触发子 Fragment 的 onPause）
        childFragmentManager.fragments.forEach { (it as? DashCanvasPageFragment)?.setPageActive(false) }
        com.icar.obd.obd.ObdController.removeListener(this)
    }

    /**
     * `MainActivity` 用 `show`/`hide` 切页，**不会触发 onResume/onPause**。
     * 而设置项是在别的页改的 —— 不在这里重新激活，切回来就没反应。
     */
    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            childFragmentManager.fragments.forEach {
                (it as? DashCanvasPageFragment)?.setPageActive(false)
            }
        } else {
            updatePageActivation()
            refreshSimBanner()
        }
    }

    // ---------------------------------------------------------------- 页码 → 画布

    private fun handlePageSelected(position: Int) {
        // 程序化翻页期间一律不切画布（见类注释）
        if (awaitingPos >= 0) {
            if (position == awaitingPos) awaitingPos = -1
            updatePageActivation()
            return
        }
        val canvases = Store.settings.canvases
        if (position in canvases.indices) {
            val c = canvases[position]
            if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)
        }
        updatePageActivation()
    }

    /**
     * **裁决每一页该不该渲染**。
     *
     * 只有"当前页 + 整个仪表盘页可见 + 本 Fragment 已 RESUMED"三者同时成立时才渲染 ——
     * 少一个条件都会出现"看不见的页面在烧电"或者"切回来不刷新"。
     */
    private fun updatePageActivation() {
        if (view == null) return
        val visible = !isHidden && isResumed
        val cur = pager.currentItem
        childFragmentManager.fragments.forEach { f ->
            when (f) {
                is DashCanvasPageFragment -> {
                    val pos = adapter.positionOfCanvas(f.canvasId)
                    val active = visible && pos >= 0 && pos == cur
                    f.setPageActive(active)
                    // 设置页的操作菜单点了「编辑这一套…」→ 翻页到位之后替它进编辑态。
                    // 放在**激活之后**：编辑态要盖住渲染结果，顺序反了会先渲染再被编辑器盖掉
                    // （视觉上是闪一下）。消费掉就清空，避免下次激活又自动进编辑。
                    if (active && pendingEditPos == pos) {
                        pendingEditPos = -1
                        f.enterEditFromHost()
                    }
                }
                is CanvasSettingsFragment -> {
                    if (visible && cur == adapter.settingsPosition()) f.onPageShown()
                }
                else -> Unit
            }
        }
    }

    /** 页面 Fragment 走完生命周期后会回调进来（它的 onResume 早于 pager 完成布局） */
    fun onPageLifecycleChanged() = updatePageActivation()

    /**
     * 就地编辑态开关。
     *
     * **决定之二**：编辑时禁用横滑 —— 拖表盘和翻页抢的是同一个横向手势，
     * 不关掉就会出现"想挪 10 个单位，结果翻到了隔壁画布"。
     */
    fun onPageEditing(editing: Boolean) {
        pager.isUserInputEnabled = !editing
        // v1.20.3：编辑态还要**把左边缘那条把手收起来** ——
        // 它浮在画布上，会抢走表盘附近的手势（表盘贴左边时最明显）。
        // 与"编辑态禁用横滑"是同一个考虑：编辑时画布上的手势只归编辑器。
        (activity as? MainActivity)?.onDashEditing(editing)
        AppLog.i(
            AppLog.M_UI,
            if (editing) "编辑态：横滑已禁用" else "退出编辑态：横滑已恢复",
            "原因=拖拽表盘与翻页会抢同一个横向手势"
        )
    }

    /** 当前页是不是在编辑态（宿主 MainActivity 用它决定要不要显示把手） */
    fun isEditing(): Boolean =
        childFragmentManager.fragments.any { it is DashCanvasPageFragment && it.isEditing() }

    // ---------------------------------------------------------------- 画布列表变化

    /**
     * 程序化翻页。
     *
     * @param smooth true = 带动画（用户点了"前往这一套"）；false = 直接跳（列表结构变了）
     */
    private fun jumpTo(position: Int, smooth: Boolean) {
        val target = position.coerceIn(0, (adapter.itemCount - 1).coerceAtLeast(0))
        awaitingPos = target
        pager.setCurrentItem(target, smooth)
        pager.post { settleAwaiting(); updatePageActivation() }
    }

    /**
     * 清掉"程序化翻页"标记。
     *
     * 必须有这一步：`setCurrentItem` 到**当前已经是**的那一页时
     * `onPageSelected` 根本不会触发，标记就会一直挂着，
     * 把用户**下一次真正的滑动**也一起吞掉（表现为"滑到别的画布没反应"）。
     */
    private fun settleAwaiting() {
        if (awaitingPos == pager.currentItem) awaitingPos = -1
    }

    /** 设置页要求跳到某一套画布 */
    fun jumpToCanvas(index: Int) = jumpTo(index, true)

    /**
     * 设置页的操作菜单要求"跳到某一套并**直接进编辑态**"（v1.20.2）。
     *
     * 为什么要两件事一起做：编辑入口从画布页搬到了设置页，用户点的是
     * 「编辑这一套…」，期待的是"跳过去、能拖了" —— 中间再让他自己找按钮就多一步。
     *
     * ⚠️ 顺序要紧：先记下 [pendingEditPos] 再翻页。翻页过程中
     * `awaitingPos` 会把页码变化吃掉（不切画布），到 `updatePageActivation`
     * 真正激活那一页时才进编辑态 —— 否则会在**错误的页**上进编辑。
     */
    fun jumpToCanvasAndEdit(index: Int) {
        val c = Store.settings.canvases.getOrNull(index) ?: return
        pendingEditPos = index
        if (Store.settings.activeCanvasId != c.id) Store.switchCanvas(c.id)
        jumpTo(index, true)
    }

    /**
     * 画布列表的结构变化。
     *
     * 增 / 删 / 排序都会**移动设置页的下标**（它永远在最右），所以每次都要
     * 把 pager 重新钉回设置页 —— 否则用户"加了一套画布"之后会被留在
     * 一套画布页上，而他并没有要求切过去。
     */
    fun onCanvasAdded(index: Int) {
        adapter.notifyItemInserted(index)
        keepOnSettings()
    }

    fun onCanvasRemoved(index: Int) {
        adapter.notifyItemRemoved(index)
        keepOnSettings()
    }

    fun onCanvasMoved(from: Int, to: Int) {
        adapter.notifyItemMoved(from, to)
        keepOnSettings()
    }

    /** 改名不改结构，只需重画那一页（以及设置页的标题） */
    fun onCanvasRenamed(index: Int) {
        adapter.notifyItemChanged(index)
        updatePageActivation()
    }

    private fun keepOnSettings() {
        val target = adapter.settingsPosition().coerceAtLeast(0)
        awaitingPos = target
        pager.setCurrentItem(target, false)
        pager.post { settleAwaiting(); updatePageActivation() }
    }

    // ---------------------------------------------------------------- 提示条

    /**
     * 常驻显示「模拟数据」提示。
     *
     * 模拟信号是**数据源**，离开模拟器页后仍在跑（见 `SimulatorActivity.onDestroy`），
     * 所以必须让用户一眼看出「现在看到的不是真车数据」。
     */
    private fun refreshSimBanner() {
        if (com.icar.obd.obd.SignalSimulator.running) {
            hideBanner?.let { main.removeCallbacks(it) }
            hideBanner = null                     // 常驻，不自动隐藏
            banner.text = "⚠ 模拟数据（非真车）· 到「连接 → 模拟信号」关闭"
            banner.visibility = View.VISIBLE
        } else {
            banner.visibility = View.GONE
        }
    }

    /** 规则触发时由 [com.icar.obd.obd.ObdController] 回调（在任意线程） */
    override fun onAlert(msg: String) {
        view?.post { showAlert(msg) }
    }

    private fun showAlert(msg: String) {
        banner.text = msg
        banner.visibility = View.VISIBLE
        hideBanner?.let { main.removeCallbacks(it) }
        val r = Runnable {
            banner.visibility = View.GONE
            refreshSimBanner()      // 告警消失后把常驻的「模拟数据」提示恢复
        }
        hideBanner = r
        main.postDelayed(r, 4000)
    }
}
