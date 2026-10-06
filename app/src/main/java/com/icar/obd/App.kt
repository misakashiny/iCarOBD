package com.icar.obd

import android.app.Application
import android.os.Build
import com.icar.obd.data.AppLog
import com.icar.obd.data.CrashCatcher
import com.icar.obd.data.Defaults
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import java.io.File

/**
 * 应用入口：所有全局单例的初始化顺序都在这里确定。
 *
 * 顺序很重要：
 *   AppLog.init  → 之后任何组件都能打日志
 *   Store.init   → 读取用户配置与自定义 PID
 *   Defaults.seedIfEmpty → 首次启动写入默认规则/仪表
 *   ObdController.init   → 建立 BLE 传输与会话（不连接，只准备）
 */
class App : Application() {

    override fun onCreate() {
        super.onCreate()

        // **第一个装**：越早越好，否则初始化期的崩溃抓不到
        CrashCatcher.install(this)

        AppLog.init(filesDir)
        AppLog.i(AppLog.M_SYS, "===== iCar OBD 启动 =====", "ver=${BuildConfig.VERSION_NAME} sdk=${Build.VERSION.SDK_INT}")

        Store.init(File(filesDir, "config"))
        AppLog.minLevel = AppLog.Level.fromTag(Store.settings.minLogLevel)
        AppLog.mirrorToLogcat = Store.settings.mirrorLogcat

        Defaults.seedIfEmpty()

        ObdController.init(this)
        ObdController.ensureChannel()

        // 开机自动连上次那台设备 —— 只有**以前真的收到过数据**才做（门槛在方法里）。
        // 这里只负责"发起连接"：初始化要等 READY 到了由 ObdController 自己触发，
        // 因为此刻链路还没建立，直接初始化必然失败。
        // 用 runCatching 兜住权限：全新安装时 BLUETOOTH_CONNECT 可能还没授予。
        runCatching { ObdController.autoStartIfPossible() }
            .onFailure { AppLog.w(AppLog.M_SYS, "开机自动连接异常", it.message ?: "") }

        // 注意：前台服务**不在这里启动**。
        // Android 12+ 对「从 Application.onCreate 启动前台服务」有后台启动限制，
        // 因此改由 MainActivity.onCreate 启动（此时应用处于前台，一定允许）。
        AppLog.i(AppLog.M_SYS, "初始化完成，等待 UI 拉起前台服务")
    }
}
