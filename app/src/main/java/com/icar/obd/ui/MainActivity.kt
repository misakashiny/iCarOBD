package com.icar.obd.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.google.android.material.navigation.NavigationBarView
import com.icar.obd.R
import com.icar.obd.ble.ObdTransport
import com.icar.obd.ble.ObdTransport.State
import com.icar.obd.data.AppLog
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.VehicleBus
import com.icar.obd.service.ObdService

/**
 * 主界面：底部导航 + 顶部状态条 + 页面容器。
 *
 * 职责边界（保持这一层足够薄，方便后续智能体接手）：
 *   - 只做导航、权限、状态条刷新
 *   - 不做任何 BLE / OBD 操作，全部委托给 [ObdController]
 *   - 不持有任何业务状态（进程级状态都在单例里，旋屏/重建不会丢）
 */
class MainActivity : AppCompatActivity(), ObdController.Listener {


    private val main = Handler(Looper.getMainLooper())
    private var rateTicker: Runnable? = null

    /** 只申请一次，避免在权限回调里再次申请形成递归（历史上踩过的坑） */
    private var permissionRequested = false

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val denied = result.filterValues { !it }.keys
        if (denied.isNotEmpty()) {
            AppLog.w(AppLog.M_UI, "权限被拒绝", denied.joinToString(","))
        } else {
            AppLog.i(AppLog.M_UI, "权限已授予")
        }
        // 注意：这里**不做任何会再次触发权限申请的动作**
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // ⚠️ v1.20.5：竖屏底部导航栏是**本地子类** `NavBottomBar`（ui/view/NavBottomBar.kt），
        // 它把菜单项上限从 Material 写死的 5 提到 6 —— 否则第 6 个 tab（知识库）
        // 会在**构造函数里**抛 `IllegalArgumentException: Maximum number of items ... is 5`，
        // 手机（竖屏）一启动就崩（v1.20.4 的实际故障；平板横屏用 NavigationRailView，没这个上限）。
        // 菜单仍由 XML 的 `app:menu` 提供，这里不需要额外代码。

        // 导航控件在竖屏是 BottomNavigationView、横屏是 NavigationRailView，
        // 两者都继承 NavigationBarView，因此这里用基类接收，不需要判断方向。
        val nav = findViewById<NavigationBarView>(R.id.navView)
        nav.setOnItemSelectedListener { item ->
            switchTo(item.itemId)
            true
        }

        // ---- 全屏显示（v1.19.19）：**长按「仪表盘」导航按钮**进入/退出 ----
        //
        // 为什么用长按而不是加个按钮：顶栏/导航栏是常驻的，
        // 为了"全屏"再加一个图标会让本来就不宽裕的一行更挤 ——
        // 而长按是**零成本**的（不占位置，也不影响单击切页）。
        // 长按在 nav item 的 View 上挂，不在 NavigationBarView 上（后者没有长按 API）。
        nav.findViewById<View>(R.id.nav_dashboard)?.setOnLongClickListener {
            setFullscreen(!fullscreen)
            true
        }

        // 手在导航栏上动过 → 重新计时，别在用户正要点的时候把它收走（v1.20.2）。
        // 返回 false：只旁听，不影响导航栏自己的点击处理。
        nav.setOnTouchListener { _, _ ->
            if (!railHidden) scheduleRailHide()
            false
        }

        // 返回键：全屏时先退出全屏，而不是直接退出 App
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(false) {
            override fun handleOnBackPressed() {
                if (fullscreen) setFullscreen(false) else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        // 恢复上次选中的页面
        val saved = savedInstanceState?.getInt(KEY_PAGE) ?: R.id.nav_dashboard
        nav.selectedItemId = saved
        // 兜底同步一次：旋转重建后若选中项恰好未变化，回调可能不触发。
        // switchTo 内部用 commitNow + findFragmentByTag，重复调用是幂等的。
        switchTo(saved)

        ObdController.addListener(this)
        applyKeepScreenOn()
        ensurePermissions()
        startServiceSafely()

        AppLog.i(
            AppLog.M_UI, "MainActivity 创建",
            "restorePage=$saved orientation=${resources.configuration.orientation} " +
                "screen=${resources.configuration.screenWidthDp}x${resources.configuration.screenHeightDp}dp"
        )
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(KEY_PAGE, findViewById<NavigationBarView>(R.id.navView).selectedItemId)
    }

    override fun onStart() {
        super.onStart()
        startRateTicker()
    }

    override fun onResume() {
        super.onResume()
        // 从规则编辑器开完模拟回来：切到仪表盘 + 挂上悬浮条
        if (ObdController.pendingGotoDash) {
            ObdController.pendingGotoDash = false
            findViewById<NavigationBarView>(R.id.navView).selectedItemId = R.id.nav_dashboard
        }
        updateSimBar()
    }

    override fun onStop() {
        super.onStop()
        stopRateTicker()
    }

    // ------------------------------------------------ 全屏显示（v1.19.19）

    private var fullscreen = false

    /**
     * 全屏：**三样都要隐藏，少一样都不算全屏** ——
     *
     * 1. 系统状态栏 / 导航栏（`WindowInsetsController`）
     * 2. App 自己的顶部状态条（`statusBar`）
     * 3. App 的底部/侧边导航（`navView`）
     *
     * 进入时顺带切到仪表盘 —— 长按的是「仪表盘」那个按钮，
     * 如果人当时在别的页，全屏之后看到的却是 PID 页，会很困惑。
     */
    private fun setFullscreen(on: Boolean) {
        fullscreen = on
        if (on) findViewById<NavigationBarView>(R.id.navView).selectedItemId = R.id.nav_dashboard

        // v1.20.2：导航栏的收起改由 setRailVisible 统一管（平移而不是 GONE），
        // 全屏时连左边缘那条把手一起收掉 —— 退出全屏靠**返回键**
        // （见 onBackPressedDispatcher：全屏时返回键先退全屏）。
        railHideRunnable?.let { main.removeCallbacks(it) }
        val nav = findViewById<View>(R.id.navView)
        if (on) {
            nav?.visibility = View.GONE
            railHandle?.visibility = View.GONE
            findViewById<View>(R.id.navDivider)?.visibility = View.GONE
        } else {
            nav?.animate()?.cancel()
            nav?.translationX = 0f
            nav?.alpha = 1f
            nav?.visibility = View.VISIBLE
        }

        val c = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            // 允许从边缘滑出临时系统栏 —— 否则用户在全屏里可能找不到怎么退出
            c.systemBarsBehavior =
                androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        } else {
            c.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            // 退出全屏后按**当前页**重新决定（仪表盘页仍然要沉浸：收栏 + 收系统栏）
            applySystemStatusBar(currentTag())
        }
        AppLog.i(
            AppLog.M_UI, if (on) "进入全屏" else "退出全屏",
            "长按「仪表盘」按钮或按返回键可切换"
        )
    }

    // ------------------------------------------------ 规则模拟悬浮条（v1.19.19）

    private var simBar: View? = null

    /**
     * 模拟进行中时挂一条**悬浮操作条**，退出时移除。
     *
     * ## 为什么挂在 MainActivity 而不是 DashFragment
     *
     * 用户的原话是"开启后可以**返回仪表盘**查看效果" —— 说明模拟要**跨页面存活**
     * （他可能先去 PID 页看看、再回仪表盘）。挂在 Fragment 上一切页就没了。
     *
     * ## 为什么用代码建而不用布局文件
     *
     * 加到 `android.R.id.content`（Activity 自带的 FrameLayout）就行，
     * **不用改 activity_main.xml** —— 那个根是 LinearLayout，
     * 为了悬浮去套一层 FrameLayout 会牵动所有子 View 的布局参数。
     */
    private fun updateSimBar() {
        val active = ObdController.isSimulating
        if (!active) {
            simBar?.let { v -> (v.parent as? android.view.ViewGroup)?.removeView(v) }
            simBar = null
            return
        }
        val bar = simBar ?: buildSimBar().also {
            simBar = it
            val lp = android.widget.FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM or android.view.Gravity.END
            )
            lp.setMargins(0, 0, dp(12), dp(88))   // 抬高一点，别压住底部导航
            (findViewById<android.view.ViewGroup>(android.R.id.content)).addView(it, lp)
        }
        // 每次刷新文案与按钮态：模拟可能是"关掉查看"的状态
        val on = ObdController.simulationOn
        bar.findViewById<TextView>(R.id.tvSimRule).text =
            "模拟中 · ${ObdController.simulatingRuleName().ifBlank { "未命名规则" }}"
        bar.findViewById<android.widget.Button>(R.id.btnSimOn).alpha = if (on) 0.4f else 1f
        bar.findViewById<android.widget.Button>(R.id.btnSimOff).alpha = if (on) 1f else 0.4f
    }

    private fun buildSimBar(): View {
        val ctx = this
        val row = android.widget.LinearLayout(ctx).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            setBackgroundColor(0xE6101820.toInt())
            setPadding(dp(10), dp(6), dp(6), dp(6))
        }
        row.addView(TextView(ctx).apply {
            id = R.id.tvSimRule
            setTextColor(0xFFFFD400.toInt())
            textSize = 12f
            setPadding(0, 0, dp(8), 0)
        })
        row.addView(simButton("开启查看") { ObdController.setSimulationOn(true); updateSimBar() }.apply { id = R.id.btnSimOn })
        row.addView(simButton("关闭查看") { ObdController.setSimulationOn(false); updateSimBar() }.apply { id = R.id.btnSimOff })
        row.addView(simButton("退出模拟") {
            // 用户要求：退出模拟要**回到刚才那个设置页**（规则编辑器），
            // 而不是把人扔在仪表盘上 —— 他多半还想接着改那条规则。
            val backId = ObdController.simulatingRuleId()
            ObdController.stopRuleSimulation()
            updateSimBar()
            if (backId != null) {
                startActivity(
                    android.content.Intent(this, RuleEditorActivity::class.java)
                        .putExtra(RuleEditorActivity.EXTRA_ID, backId)
                )
            }
        })
        return row
    }

    private fun simButton(text: String, onClick: () -> Unit): android.widget.Button =
        android.widget.Button(this).apply {
            this.text = text
            textSize = 12f
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(8), 0, dp(8), 0)
            setOnClickListener { onClick() }
        }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    override fun onDestroy() {
        ObdController.removeListener(this)
        super.onDestroy()
    }

    // ------------------------------------------------------------ 导航

    /**
     * 仪表盘页**隐藏系统状态栏**（顶部那条时间/电量）。
     *
     * 用户要求：在仪表盘时把系统那条也收掉，让画布更满。
     * 注意它和 v1.19.19 的「全屏」不是一回事：
     *  - 这里只收**状态栏**，底部/侧边导航栏留着（还要靠它切页）
     *  - 全屏（长按仪表盘按钮）会把**导航栏一起**收掉
     * 所以全屏时这里直接返回，交给 setFullscreen 全权处理 ——
     * 否则两个地方各收各的，退出全屏时状态会错乱。
     */
    // ------------------------------------------------ 仪表盘沉浸模式（v1.20.2）

    /**
     * 仪表盘页**自动收起左侧 tab 栏**，只留一条左边缘的小把手；同时收起系统栏。
     *
     * ## 为什么（用户原话）
     *
     * > 「仪表盘里自动隐藏左边的 tab 栏目（想个好的方法去实现）或者直接以悬浮UI的方式
     * > 去做 tab 栏目、通过手势去拖出拖入？」
     * > 「画布下面的白条太厚了、很明显、搞小点、且带点透明的效果那种」
     *
     * ## "白条"到底是什么（**实测出来的，不是猜的**）
     *
     * 拿仪表盘截图做逐行亮像素统计：
     * ```
     * 截图 2560x1600，而 App 窗口只到 y=1564
     * y=1564..1599（36px）平均亮度 27，峰值 80.5   ← 系统导航栏
     * 其余各行平均亮度 12（App 本体 #0A0D12）
     * ```
     * 所以那是**系统导航栏**，不是 App 的控件 —— **改不了它的大小**。
     * 能做的只有两件：① 在仪表盘页把它收起来（画布多 36px，白条彻底消失）
     * ② 或者把它设成透明让画布透过去。这里选 ①，并且保留
     * `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` —— 从边缘划一下它还会临时出现，
     * 不会把人锁在里面。
     *
     * ## 为什么用"滑出 + 把手"而不是重新做一个悬浮导航
     *
     * 现成的 `navView` 已经是完整的导航控件（横屏 Rail / 竖屏 Bottom），
     * 再搭一套悬浮导航就是**两份导航**（本项目已经因为"两份权威"栽过三次）。
     * 平移它、加一个把手，语义完全一样，代码量差一个数量级。
     */
    private var railHandle: View? = null
    private var railHidden = false
    private var railHideRunnable: Runnable? = null

    /** 左边缘把手的宽度/高度（dp）。**刻意离屏幕边缘远一点**（见 ensureRailHandle） */
    private val railHandleW = 18
    private val railHandleH = 120
    /** 把手距左边缘的距离（dp）。**必须大于系统返回手势的热区（约 20~24dp）** */
    private val railHandleMargin = 32

    /**
     * 建左边缘那条把手（只建一次）。加到 `android.R.id.content` 而不是改 activity_main.xml —— 见 updateSimBar 的同类说明
     *
     * ## ⚠️ 为什么必须离边缘 32dp（v1.20.3 修）
     *
     * 第一版把它贴在 x=4px（≈2dp）。结果**每次按它都触发系统的返回/退出手势** ——
     * Android 的屏幕边缘是系统手势热区，贴在边上等于把手势让给了系统。
     * 用户原话："半透明把手有点不好按、总是触发系统的手势退出"。
     *
     * 现在：距边缘 **32dp**（在热区之外）、宽 **18dp**、高 **120dp**，
     * 而且是个带 `❯` 的 TextView（第一版是个光秃秃的 View，看不出能点）。
     */
    private fun ensureRailHandle() {
        if (railHandle != null) return
        val v = android.widget.TextView(this).apply {
            text = "❯"
            textSize = 14f
            gravity = android.view.Gravity.CENTER
            setTextColor(0xCCFFFFFF.toInt())
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                cornerRadius = dp(9).toFloat()
                setColor(0x3DFFFFFF)
            }
            layoutParams = android.widget.FrameLayout.LayoutParams(
                dp(railHandleW), dp(railHandleH),
                android.view.Gravity.START or android.view.Gravity.CENTER_VERTICAL
            ).apply { leftMargin = dp(railHandleMargin) }
            contentDescription = "展开导航"
        }
        // 点一下 = 展开；往右拖也能展开（用户要的"手势拖出拖入"）
        var downX = 0f
        v.setOnClickListener { revealRail() }
        v.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    downX = e.rawX
                    false
                }
                android.view.MotionEvent.ACTION_MOVE ->
                    if (e.rawX - downX > dp(16)) { revealRail(); true } else false
                else -> false
            }
        }
        (findViewById<android.view.ViewGroup>(android.R.id.content)).addView(v)
        railHandle = v
    }

    /**
     * 画布进入/退出编辑态时，把手要让位。
     *
     * 编辑态里手指要在画布上拖表盘 —— 一个浮在画布上的把手会**抢走它附近的手势**
     * （表盘贴左边时最明显）。这与"编辑态禁用横滑"是同一个考虑。
     */
    fun onDashEditing(editing: Boolean) {
        railHandle?.visibility =
            if (editing || fullscreen || !railHidden) View.GONE else View.VISIBLE
    }

    private fun revealRail() {
        setRailVisible(true)
        // 展开后**自动收回去**：不收的话仪表盘上会一直挂着一条导航栏
        scheduleRailHide()
    }

    private fun scheduleRailHide() {
        railHideRunnable?.let { main.removeCallbacks(it) }
        val r = Runnable { if (!fullscreen) setRailVisible(false) }
        railHideRunnable = r
        main.postDelayed(r, 8000)
    }

    /**
     * 展开 / 收起左侧 tab 栏。
     *
     * ⚠️ 收起用 `translationX` + `alpha` 而**不是** `GONE`：GONE 会让
     * `navView` 从布局里消失，页面容器会跟着重排（画布尺寸变化 → 表盘重排 + 闪一下）。
     * 平移只是把它挪出屏幕，布局不动。
     */
    private fun setRailVisible(on: Boolean) {
        val nav = findViewById<View>(R.id.navView) ?: return
        railHideRunnable?.let { main.removeCallbacks(it) }
        railHidden = !on
        // ⚠️ 那条 1dp 分隔线必须一起藏 —— 否则屏幕边缘会留一条 divider 色的细条
        // （v1.20.3 实测：navView 平移出去后，截图 x=0/1 仍是 RGB(42,53,71)，用户："看着很不爽"）
        findViewById<View>(R.id.navDivider)?.visibility = if (on) View.VISIBLE else View.GONE
        val w = if (nav.width > 0) nav.width else dp(88)
        val h = if (nav.height > 0) nav.height else dp(80)
        val landscape =
            resources.configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
        if (on) {
            nav.visibility = View.VISIBLE
            nav.animate().translationX(0f).translationY(0f).alpha(1f).setDuration(160).start()
        } else {
            // 横屏滑出左边、竖屏滑出下边。用 translation 而**不是 GONE**：
            // GONE 会让父容器重新量一次（v1.20.4 起导航栏已改成悬浮、画布本来就整屏，
            // 但这是第二道保险 —— 平移不改变任何布局）
            nav.animate()
                .translationX(if (landscape) -w.toFloat() else 0f)
                .translationY(if (landscape) 0f else h.toFloat())
                .alpha(0f)
                .setDuration(160)
                .withEndAction { if (railHidden) nav.visibility = View.GONE }
                .start()
        }
        AppLog.d(
            AppLog.M_UI, if (on) "展开导航栏" else "收起导航栏",
            "page=${currentTag()} 方式=悬浮平移（画布不动）"
        )
    }

    // ------------------------------------------------ 双指手势呼出导航（v1.20.4）

    /**
     * **双指横滑**呼出 / 收起导航栏。
     *
     * ## 为什么把"左边缘把手"整个停用
     *
     * v1.20.3 加过一条贴左边缘的小把手，两版都不好用：第一版在 x=4px（≈2dp），
     * 正好落在**系统返回手势的热区**里；挪到 32dp 后好按了一些，用户仍然反馈
     * "还是有点不好按、总是触发系统的手势退出"，并直接给了方案：
     * **"要么采用个手势、双指拖动的时候呼出来"**。
     *
     * 双指的好处是**不与任何单指手势冲突**：系统的边缘手势是单指、
     * ViewPager 横滑是单指、拖表盘也是单指。
     *
     * ## 为什么重写 dispatchTouchEvent，而不是加一个透明 View
     *
     * 透明 View 要"看着"双指就得消费 DOWN —— 那样单指手势会被它吃掉；
     * 返回 false 又收不到后续的 MOVE。而 `dispatchTouchEvent` 能**旁听全部触摸
     * 且不消费**（照旧交给 super），这才是"加一个手势"该有的侵入性。
     */
    private var twoFingerStartX = 0f
    private var twoFingerHandled = false

    /**
     * 双击兜底（v1.20.4）。
     *
     * ## 为什么必须有它
     *
     * 双指手势**没法用 adb 验**（`input swipe` 只能发单指），也就是说
     * "它在真机上到底灵不灵"只能靠用户的手指。而万一不灵，
     * 用户会**卡在仪表盘页出不来**（导航栏是收起的）—— 这是不能接受的赌注。
     *
     * 所以再给一条**单指也能用**的路：**双击画布**呼出导航。
     * 它不与任何已有手势冲突（拖表盘是"按下-移动"，横滑是"按下-快滑"，
     * 都不产生"两次快速点按"）。
     */
    private var lastTapMs = 0L
    private var tapDownX = 0f
    private var tapDownY = 0f

    override fun dispatchTouchEvent(ev: android.view.MotionEvent): Boolean {
        // ---- 双指横滑 ----
        if (ev.pointerCount >= 2) {
            when (ev.actionMasked) {
                android.view.MotionEvent.ACTION_POINTER_DOWN -> {
                    twoFingerStartX = (ev.getX(0) + ev.getX(1)) / 2f
                    twoFingerHandled = false
                }
                android.view.MotionEvent.ACTION_MOVE -> if (!twoFingerHandled) {
                    val dx = (ev.getX(0) + ev.getX(1)) / 2f - twoFingerStartX
                    if (dx > dp(48)) {
                        twoFingerHandled = true
                        revealRail()
                        AppLog.i(AppLog.M_UI, "双指右滑：呼出导航", "page=${currentTag()}")
                    } else if (dx < -dp(48)) {
                        twoFingerHandled = true
                        setRailVisible(false)
                        AppLog.i(AppLog.M_UI, "双指左滑：收起导航", "page=${currentTag()}")
                    }
                }
            }
        }
        // ---- 双击兜底（旁听，不消费）----
        when (ev.actionMasked) {
            android.view.MotionEvent.ACTION_DOWN -> {
                tapDownX = ev.x
                tapDownY = ev.y
            }
            android.view.MotionEvent.ACTION_UP -> {
                val moved = kotlin.math.abs(ev.x - tapDownX) + kotlin.math.abs(ev.y - tapDownY)
                if (moved < dp(24)) {
                    val now = System.currentTimeMillis()
                    if (now - lastTapMs < 400) {
                        lastTapMs = 0L
                        if (railHidden) {
                            revealRail()
                            AppLog.i(AppLog.M_UI, "双击：呼出导航", "page=${currentTag()}")
                        } else {
                            setRailVisible(false)
                            AppLog.i(AppLog.M_UI, "双击：收起导航", "page=${currentTag()}")
                        }
                    } else {
                        lastTapMs = now
                    }
                } else {
                    lastTapMs = 0L
                }
            }
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun currentTag(): String =
        when (findViewById<NavigationBarView>(R.id.navView)?.selectedItemId) {
            R.id.nav_connect -> "connect"
            R.id.nav_pid -> "pid"
            R.id.nav_rule -> "rule"
            R.id.nav_log -> "log"
            R.id.nav_knowledge -> "knowledge"
            else -> "dash"
        }

    private fun applySystemStatusBar(tag: String) {
        if (fullscreen) return
        val c = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
        // 允许从边缘滑出临时系统栏 —— 否则用户在全屏/沉浸里可能找不到怎么退出
        c.systemBarsBehavior =
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (tag == "dash") {
            // 仪表盘页：状态栏 + **导航栏**都收起（那条"白条"就是导航栏，实测 36px）
            c.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            setRailVisible(false)
        } else {
            c.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            setRailVisible(true)
        }
    }

    private fun switchTo(itemId: Int) {
        val tag = when (itemId) {
            R.id.nav_dashboard -> "dash"
            R.id.nav_connect -> "connect"
            R.id.nav_pid -> "pid"
            R.id.nav_rule -> "rule"
            R.id.nav_log -> "log"
            R.id.nav_knowledge -> "knowledge"
            else -> "dash"
        }
        val fm = supportFragmentManager
        // 状态已保存后不能再提交事务（旋转/回收流程中会抛 IllegalStateException）
        if (fm.isStateSaved) return

        val existing = fm.findFragmentByTag(tag)
        val tx = fm.beginTransaction()
        // 用 hide/show 而不是 replace：切页不重建，仪表盘不会闪
        fm.fragments.forEach { tx.hide(it) }
        if (existing != null) {
            tx.show(existing)
        } else {
            tx.add(R.id.pageContainer, createFragment(tag), tag)
        }
        // commitNow（而不是 commit）让切换在当前帧内生效：
        // 这样 switchTo 可被重复调用而不产生重复 Fragment（commit 是异步的，
        // 两次快速调用会都看到 existing == null 从而各 add 一份）。
        tx.commitNow()
        AppLog.d(AppLog.M_UI, "切换页面", tag)
        applySystemStatusBar(tag)
    }

    private fun createFragment(tag: String): Fragment = when (tag) {
        "connect" -> ConnectFragment()
        "pid" -> PidFragment()
        "rule" -> RuleFragment()
        "log" -> LogFragment()
        "knowledge" -> KnowledgeFragment()
        else -> DashFragment()
    }

    // ------------------------------------------------------------ 状态条

    private fun startRateTicker() {
        stopRateTicker()
        val r = object : Runnable {
            override fun run() {
                main.postDelayed(this, 1000)
            }
        }
        rateTicker = r
        main.postDelayed(r, 1000)
    }

    private fun stopRateTicker() {
        rateTicker?.let { main.removeCallbacks(it) }
        rateTicker = null
    }


    // ------------------------------------------------------------ 权限

    private fun ensurePermissions() {
        if (permissionRequested) return
        val need = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!granted(Manifest.permission.BLUETOOTH_SCAN)) need.add(Manifest.permission.BLUETOOTH_SCAN)
            if (!granted(Manifest.permission.BLUETOOTH_CONNECT)) need.add(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) need.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!granted(Manifest.permission.POST_NOTIFICATIONS)) need.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        if (need.isEmpty()) return
        permissionRequested = true
        AppLog.i(AppLog.M_UI, "申请权限", need.joinToString(","))
        permLauncher.launch(need.toTypedArray())
    }

    private fun granted(p: String): Boolean =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    // ------------------------------------------------------------ 其他

    private fun applyKeepScreenOn() {
        if (Store.settings.keepScreenOn) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun startServiceSafely() {
        runCatching {
            startForegroundService(Intent(this, ObdService::class.java))
            AppLog.i(AppLog.M_SYS, "前台服务已拉起")
        }.onFailure {
            AppLog.w(AppLog.M_SYS, "前台服务启动失败", it.message ?: "")
        }
    }

    override fun onState(state: State, detail: String) {
    }

    override fun onAlert(msg: String) {
        // 告警条由 DashFragment 自己展示；这里只保证状态条刷新
    }

    companion object {
        private const val KEY_PAGE = "page"
    }
}
