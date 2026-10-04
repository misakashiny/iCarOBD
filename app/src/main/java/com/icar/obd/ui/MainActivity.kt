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

    private lateinit var connDot: View
    private lateinit var tvStatus: TextView
    private lateinit var tvRate: TextView

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

        connDot = findViewById(R.id.connDot)
        tvStatus = findViewById(R.id.tvStatus)
        tvRate = findViewById(R.id.tvRate)

        // 导航控件在竖屏是 BottomNavigationView、横屏是 NavigationRailView，
        // 两者都继承 NavigationBarView，因此这里用基类接收，不需要判断方向。
        val nav = findViewById<NavigationBarView>(R.id.navView)
        nav.setOnItemSelectedListener { item ->
            switchTo(item.itemId)
            true
        }

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
        refreshStatus()
        startRateTicker()
    }

    override fun onStop() {
        super.onStop()
        stopRateTicker()
    }

    override fun onDestroy() {
        ObdController.removeListener(this)
        super.onDestroy()
    }

    // ------------------------------------------------------------ 导航

    private fun switchTo(itemId: Int) {
        val tag = when (itemId) {
            R.id.nav_dashboard -> "dash"
            R.id.nav_connect -> "connect"
            R.id.nav_pid -> "pid"
            R.id.nav_rule -> "rule"
            R.id.nav_log -> "log"
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
    }

    private fun createFragment(tag: String): Fragment = when (tag) {
        "connect" -> ConnectFragment()
        "pid" -> PidFragment()
        "rule" -> RuleFragment()
        "log" -> LogFragment()
        else -> DashFragment()
    }

    // ------------------------------------------------------------ 状态条

    private fun startRateTicker() {
        stopRateTicker()
        val r = object : Runnable {
            override fun run() {
                refreshStatus()
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

    private fun refreshStatus() {
        val state = ObdController.transport.state
        val (dot, text) = when (state) {
            State.READY -> {
                val name = ObdController.connectedDeviceName.ifBlank { "设备" }
                R.drawable.dot_online to "已连接 · $name"
            }
            State.CONNECTING, State.DISCOVERING ->
                R.drawable.dot_warn to ObdController.stateName()
            State.SCANNING ->
                R.drawable.dot_warn to "扫描中…"
            State.CLOSED ->
                R.drawable.dot_offline to "已断开"
            else -> R.drawable.dot_offline to "未连接"
        }
        connDot.setBackgroundResource(dot)
        tvStatus.text = text
        val hz = VehicleBus.sampleHz
        tvRate.text = if (hz > 0.1f) String.format("%.1f Hz", hz) else "-- Hz"
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
        runOnUiThread { refreshStatus() }
    }

    override fun onAlert(msg: String) {
        // 告警条由 DashFragment 自己展示；这里只保证状态条刷新
        runOnUiThread { refreshStatus() }
    }

    companion object {
        private const val KEY_PAGE = "page"
    }
}
