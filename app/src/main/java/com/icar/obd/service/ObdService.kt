package com.icar.obd.service

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.VehicleBus
import com.icar.obd.ui.MainActivity

/**
 * 前台服务：只为「让 BLE 连接在后台存活」而存在。
 *
 * 它不承载业务逻辑——业务在 [ObdController] 单例里。
 * 这样设计的好处是：服务被系统杀掉重建后，控制器状态不会重复初始化
 * （ObdController.init 是幂等的），UI 重新订阅即可。
 *
 * 通知栏会实时显示连接状态与采样率，方便行车中瞥一眼确认还在工作。
 */
class ObdService : Service() {

    private var unsubValue: (() -> Unit)? = null
    private var lastText: String = ""

    override fun onCreate() {
        super.onCreate()
        ObdController.init(this)
        ObdController.ensureChannel()
        startForegroundCompat(buildNotification("未连接"))

        // 订阅总线，让通知栏显示实时速率（低频更新，避免耗电）
        unsubValue = VehicleBus.addValueListener { refreshNotification() }
        AppLog.i(AppLog.M_SYS, "ObdService 已启动")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // START_STICKY：被系统回收后自动重建，配合 ObdController 幂等初始化
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        unsubValue?.invoke()
        AppLog.w(AppLog.M_SYS, "ObdService 被销毁")
        super.onDestroy()
    }

    /**
     * 把本服务提升为前台服务。
     *
     * ## ⚠️ P5A-M01 修复的真实崩溃
     *
     * Android 14（targetSDK 34）对 `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE` 有**双重**要求：
     *   1. manifest 声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE`（已有）
     *   2. **且**持有至少一个运行时权限：`BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN` / …
     *
     * 用户第一次装 App 时点「不允许」→ 第 2 条不满足 → `startForeground()` 抛
     * `SecurityException: Starting FGS with type connectedDevice ... requires permissions`
     * → 在 `onCreate()` 里没人接 → **进程直接 FATAL，App 崩在启动那一刻**。
     *
     * 实测复现：撤销 BLUETOOTH_CONNECT/SCAN 后启动 → crash buffer 出现 2 条 FATAL。
     *
     * ## 修法
     *
     * 降级而不是崩：
     *   ① 优先用 `CONNECTED_DEVICE` 类型（正常路径，行为不变）
     *   ② 失败就退回**不带类型**的 `startForeground(id, n)`（Android 14 仍允许，
     *      只是没有 connectedDevice 的额外特权 —— 而本服务本来也不依赖那个特权）
     *   ③ 再失败就 `stopSelf()`，让 App 正常可用、只是没有常驻通知
     *
     * **不吞异常**：两次失败都记 `AppLog.e`，现场能看到为什么前台服务起不来。
     */
    private fun startForegroundCompat(n: Notification) {
        // ---- ① 先试带类型（Android 14+ 才有意义）
        var typedFailed = false
        if (shouldUseTypedForeground(Build.VERSION.SDK_INT)) {
            try {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
                return
            } catch (e: SecurityException) {
                typedFailed = true
                // 最常见：用户没给蓝牙权限。不是致命错误，降级继续。
                AppLog.w(
                    AppLog.M_SYS,
                    "前台服务降级：缺少蓝牙权限，改用无类型的 startForeground",
                    e.message ?: ""
                )
            }
        }

        // ---- ② 决定是否要降级（纯函数，有单测钉住"必须降级不能崩"）
        val plan = planForegroundFallback(typedFailed)
        if (plan == ForegroundPlan.NONE) {
            // 低版本：直接走无类型即可（下面统一做）
        }

        try {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, n)
        } catch (e: Throwable) {
            // 连无类型都起不来（极少数 ROM / 通知被完全禁用）→ 放弃前台，别让 App 崩
            AppLog.e(
                AppLog.M_SYS,
                "前台服务启动失败，已降级为普通服务（App 仍可用）",
                e.message ?: e.javaClass.simpleName
            )
            runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        }
    }

    private fun refreshNotification() {
        val now = System.currentTimeMillis()
        if (now - lastRefresh < 2000) return
        lastRefresh = now
        val text = buildText()
        if (text == lastText) return
        lastText = text
        runCatching {
            val nm = androidx.core.app.NotificationManagerCompat.from(this)
            nm.notify(NOTIF_ID, buildNotification(text))
        }
    }

    private var lastRefresh = 0L

    private fun buildText(): String {
        val state = ObdController.stateName()
        val hz = VehicleBus.sampleHz
        val dev = ObdController.connectedDeviceName.ifBlank { Store.settings.lastDeviceName }
        return buildString {
            append(state)
            if (dev.isNotBlank()) append(" · ").append(dev)
            if (hz > 0.1f) append(" · ").append(String.format("%.1f Hz", hz))
        }
    }

    private fun buildNotification(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, ObdController.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_nav_ble)
            .setContentTitle("iCar OBD")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        private const val NOTIF_ID = 1001

        // ================================================================
        // P5A-M01：前台服务**降级决策**（纯函数，可 JVM 单测）
        //
        // 抽出来的原因：`ObdService` 继承 `android.app.Service`，JVM 单测里造不出来。
        // 但"失败要降级、不能崩"这个语义**必须被钉住** —— 本轮的真实缺陷就是它。
        // 抽成纯函数后可以用 `ForegroundServiceDegradeTest` 直接测。
        // ================================================================

        /**
         * 该不该用 `FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE`。
         * 只有 Android 14（API 34, UPSIDE_DOWN_CAKE）起才引入这个类型约束。
         */
        fun shouldUseTypedForeground(sdkInt: Int): Boolean =
            sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE

        /**
         * 带类型启动失败后怎么办。
         *
         * **必须是降级，不能是抛出** —— 这正是本轮修的崩溃：
         * 用户拒绝蓝牙权限时 Android 14 会拒绝 `CONNECTED_DEVICE` 类型，
         * 原实现让异常直接冒到 `onCreate()`，进程 FATAL。
         */
        fun planForegroundFallback(typedFailed: Boolean): ForegroundPlan =
            if (typedFailed) ForegroundPlan.UNTYPED else ForegroundPlan.NONE

        /** 无类型启动也失败后怎么办：放弃前台，别让 App 崩。 */
        fun planSecondFallback(untypedFailed: Boolean): ForegroundPlan =
            if (untypedFailed) ForegroundPlan.STOP_SELF else ForegroundPlan.NONE
    }
}

// ============================================================================
// P5A-M01：前台服务降级计划（顶层类型，便于单测直接引用）
// ============================================================================

/** 前台服务启动计划 */
enum class ForegroundPlan {
    /** 无需降级（已经是想要的状态）*/
    NONE,

    /** 带类型失败 → 退回无类型 `startForeground(id, n)` */
    UNTYPED,

    /** 无类型也失败 → 放弃前台，服务转普通（App 仍可用）*/
    STOP_SELF,
}
