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

    private fun startForegroundCompat(n: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, n)
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
    }
}
