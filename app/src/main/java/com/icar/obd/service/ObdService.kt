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

    /** 是否已成功进入前台（P5B-M03：避免重复 startForeground 与状态不明）*/
    private var isForegroundStarted = false

    override fun onCreate() {
        super.onCreate()
        ObdController.init(this)
        ObdController.ensureChannel()

        // ================================================================
        // P5B-M03 §A2：**没有蓝牙权限就不占前台服务**
        //
        // ## 为什么改
        //
        // P5B-M02 的做法是"没权限就用 DATA_SYNC 保活"。指令 §A2 明确列出四条禁止：
        //   · 无蓝牙权限时，不启动真实 OBD 采集
        //   · **离线主题浏览不应依赖无实际工作的 FGS**
        //   · **不为延长存活时间而滥用 dataSync 服务类型**
        //   · Service 停止/重启/前后台切换均有明确状态
        //
        // 实测当前行为：无权限时 Service 里**没有任何 OBD 通信**（无连接、无轮询），
        // 只订阅总线 + 更新通知（已有 2 秒节流 + 同文本跳过）。这占着 dataSync
        // 纯属"为了活着而活着" —— 正是被禁止的滥用。
        //
        // ## 现在的做法
        //
        //   · 有蓝牙权限 → 正常起前台服务（connectedDevice，与既有行为一致）
        //   · 无蓝牙权限 → **不起前台服务**，Service 降为普通后台服务：
        //       不需要通知、不占 FGS 配额、不消耗 dataSync 的 6 小时额度
        //       用户仍可正常浏览主题（那本来就不需要 FGS）
        //
        // ## 为什么不干脆不启动 Service
        //
        // `ObdController.init()` 与 `ensureChannel()` 仍需执行（连接页要用），
        // 且授权后要能立刻恢复正常前台服务（见 onStartCommand）。
        // 所以 Service 启动，但**不进入前台**。
        // ================================================================
        if (hasBluetoothPermission()) {
            startForegroundCompat(buildNotification("未连接"))
        } else {
            AppLog.i(
                AppLog.M_SYS,
                "无蓝牙权限 → 不启动前台服务（离线浏览不需要 FGS）；授权后自动恢复"
            )
        }

        // 订阅总线，让通知栏显示实时速率（低频更新，避免耗电）
        // 只有真正在前台时才需要刷新通知
        unsubValue = VehicleBus.addValueListener { refreshNotification() }
        AppLog.i(AppLog.M_SYS, "ObdService 已启动")
    }

    /**
     * Android 15+（API 35）：`dataSync` 类型的**累计运行上限是 6 小时/24 小时**，
     * 超时后系统会调用本方法。**不处理会导致 ANR 或崩溃**。
     *
     * 当前 targetSdk=34 时系统不强制，但一旦升到 35 立刻生效 —— 所以现在就处理。
     *
     * 处理方式：停掉自己的前台状态（不再占 dataSync 配额），但**不杀 App 进程** ——
     * 用户回到前台时 [onStartCommand] 会重新按权限恢复。
     *
     * ⚠️ 正常情形下不会走到这里：有蓝牙权限走的是 `connectedDevice`（无此限制），
     *    无权限则根本不起前台服务。这里只是兜底。
     */
    override fun onTimeout(startId: Int) {
        AppLog.w(AppLog.M_SYS, "前台服务超时（Android 15+ dataSync 限制）→ 退出前台，保留进程")
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        isForegroundStarted = false
        // 不调用 stopSelf()：App 仍可用，用户回前台会重新恢复
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // ================================================================
        // P5B-M03 §A3：**授权后自动恢复前台服务**
        //
        // 场景：用户先拒了蓝牙权限（onCreate 没起前台服务）→ 后来在设置里授予
        // → 回到 App → MainActivity.onResume 再次 startForegroundService。
        // 这时必须把前台服务补起来，否则 OBD 通信没有 FGS 保护。
        //
        // ⚠️ **关键约束**：调用方用的是 `startForegroundService()`，
        //    系统要求 **5 秒内**必须调用 `startForeground()`，
        //    否则抛 `ForegroundServiceDidNotStartInTimeException`（ANR 级）。
        //
        //    所以「没有权限就不进前台」这个决定**不能只是 return** ——
        //    必须二选一：
        //      ① 调 startForeground（但我们已判定无权限时不该占 FGS）
        //      ⚠️ 更正：**`stopSelf()` 不行**。实测系统只认 `startForeground()`，
        //         stopSelf 照样抛 `ForegroundServiceDidNotStartInTimeException`。
        //         所以调用方改用 `startService()`（无该契约），见 MainActivity。
        // ================================================================
        if (hasBluetoothPermission()) {
            if (!isForegroundStarted) startForegroundCompat(buildNotification("未连接"))
            return START_STICKY
        }

        // 无权限：不进入前台。调用方用的是 startService()（无 5 秒契约），
        // 所以这里可以直接返回 —— 系统不再要求必须 startForeground。
        AppLog.i(
            AppLog.M_SYS,
            "onStartCommand：无蓝牙权限 → 不进入前台（不占 FGS 配额）"
        )
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        isForegroundStarted = false
        // START_NOT_STICKY：无权限时没有工作需要持续，被回收不必重建
        return START_NOT_STICKY
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
        // ================================================================
        // P5B-M02 §B：**权限前置检查**（而不是靠 try/catch 兜）
        //
        // ## 为什么必须前置检查
        //
        // P5A-M01 R2 的降级补丁只做了 try/catch —— 实测（verify-p5b02-fgs）
        // 发现它**并不能真的把服务变成前台**：
        //
        //   · 有权限时：startForegroundCount = 1  ✅
        //   · 撤销权限：startForegroundCount = 0  ❌ —— 带类型和无类型**都失败**
        //
        // 原因正是 P5B-M02 §B 第 2 条问的：「不指定类型重试是否仍继承 Manifest 类型」
        // → **会继承**。Manifest 写了 `foregroundServiceType="connectedDevice"`，
        //   Android 14 对**无类型调用也按 Manifest 类型校验**，所以无类型重试同样抛
        //   SecurityException。
        //
        // 后果：不崩了（异常被 catch），但 Service **从未成为前台服务** ——
        //       App 切到后台后没有 FGS 保护，可能被系统回收。
        //
        // ## 正确做法
        //
        // 先**检查权限**，再决定用哪种类型：
        //   · 有蓝牙权限 → CONNECTED_DEVICE（正常路径，与既有行为一致）
        //   · 没有权限  → 用 **dataSync**（不需要蓝牙权限，仍能给进程 FGS 保护）
        //                 并在通知里如实说明"未授权蓝牙，仅保活"
        //
        // ⚠️ 用 dataSync 需要 manifest 声明 FOREGROUND_SERVICE_DATA_SYNC（已加）。
        // ⚠️ 不改正常连接时的既有机制：有权限时走的还是 CONNECTED_DEVICE。
        // ================================================================
        val btGranted = hasBluetoothPermission()
        AppLog.i(AppLog.M_SYS, "前台服务启动：蓝牙权限=" + (if (btGranted) "已授予" else "未授予"))

        if (shouldUseTypedForeground(Build.VERSION.SDK_INT)) {
            // Android 14+：先按权限选类型
            val chosenType = chooseForegroundType(btGranted)
            try {
                startForeground(NOTIF_ID, n, chosenType)
                isForegroundStarted = true
                AppLog.i(AppLog.M_SYS, "前台服务已启动，type=" + typeName(chosenType))
                return
            } catch (e: SecurityException) {
                AppLog.w(
                    AppLog.M_SYS,
                    "带类型启动失败，尝试无类型",
                    (typeName(chosenType) + " | " + (e.message ?: ""))
                )
            }
        }

        try {
            @Suppress("DEPRECATION")
            startForeground(NOTIF_ID, n)
            isForegroundStarted = true
            AppLog.i(AppLog.M_SYS, "前台服务已启动（无类型）")
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

    /** 当前是否持有任一蓝牙权限（Android 12+ 是运行时权限；低版本无此权限）*/
    private fun hasBluetoothPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val need = arrayOf(
            android.Manifest.permission.BLUETOOTH_CONNECT,
            android.Manifest.permission.BLUETOOTH_SCAN,
        )
        return need.any {
            androidx.core.content.ContextCompat.checkSelfPermission(this, it) ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
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

        /**
         * P5B-M02 §B：**按权限选前台服务类型**。
         *
         * · 有蓝牙权限 → `CONNECTED_DEVICE`（正常路径，与既有行为完全一致）
         * · 没有权限   → `DATA_SYNC`（不需要蓝牙权限，仍能给进程 FGS 保护）
         *
         * 为什么没有权限时不能继续用 `CONNECTED_DEVICE`：
         * Android 14 要求该类型**同时**满足「manifest 声明」+「持有运行时蓝牙权限」，
         * 缺后者必然抛 `SecurityException`。而 Manifest 声明了
         * `foregroundServiceType="connectedDevice"` 之后，**连无类型调用也会按它校验** ——
         * 所以"降级成无类型"这条路本来就走不通（P5B-M02 §B 实测 startForegroundCount=0）。
         */
        fun chooseForegroundType(bluetoothGranted: Boolean): Int =
            if (bluetoothGranted) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            } else {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }

        /** 类型 → 可读名字（日志用）*/
        fun typeName(type: Int): String = when (type) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE -> "connectedDevice"
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC -> "dataSync"
            else -> "type=" + type
        }
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
