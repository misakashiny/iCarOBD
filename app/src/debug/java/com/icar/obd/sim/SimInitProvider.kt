package com.icar.obd.sim

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * Debug 自动初始化（P5A-M01 阶段 B3，v2）。
 *
 * ## v1 为什么失败
 *
 * 第一版在 `ContentProvider.onCreate()` 里注册广播接收器。实测
 * `adb shell am broadcast -a com.icar.obd.SIM` 能发出（ActivityManager
 * 日志有 `Enqueued broadcast`），但**应用侧完全没收到**。
 *
 * 原因：Provider 的 `onCreate()` 跑在 `Application.onCreate()` **之前**，
 * 此时进程虽然是应用进程，但广播分发链路尚未就绪；
 * 在部分 Android 版本上 `registerReceiver` 虽然不抛异常，却注册不到
 * 真实的 dispatching 通道上。
 *
 * ## v2 做法
 *
 * 改用 `Application.ActivityLifecycleCallbacks`：等到第一个 Activity
 * `onResume` 之后再注册 —— 那时进程完全就绪，广播一定收得到。
 *
 * 仍然**不改生产代码**：通过 Provider 拿到 `Application` 实例
 * （`context.applicationContext as Application`），再挂一个生命周期回调。
 */
class SimInitProvider : android.content.ContentProvider() {

    override fun onCreate(): Boolean {
        val app = context?.applicationContext as? Application ?: return true
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            private var registered = false

            override fun onActivityResumed(activity: Activity) {
                if (registered) return
                registered = true
                runCatching { SimControl.register(activity.applicationContext) }
                    .onFailure { Log.w("SimInit", "注册模拟广播失败", it) }
                Log.i("SimInit", "模拟数据源已就绪：adb shell am broadcast -a " + SimControl.ACTION +
                    " --es scenario accel")
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
        return true
    }

    override fun query(
        uri: android.net.Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?
    ): android.database.Cursor? = null

    override fun getType(uri: android.net.Uri): String? = null

    override fun insert(uri: android.net.Uri, values: android.content.ContentValues?): android.net.Uri? = null

    override fun delete(uri: android.net.Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(
        uri: android.net.Uri,
        values: android.content.ContentValues?,
        selection: String?,
        selectionArgs: Array<out String>?
    ): Int = 0
}
