package com.icar.obd.obd

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.icar.obd.data.AppLog
import com.icar.obd.data.PidValue
import kotlin.math.sqrt

/**
 * G 值数据源。
 *
 * OBD 总线上**没有** G 传感器，所以这个量必须另找来源。两种都实现了、可切换：
 *
 * | 模式 | 来源 | 特点 |
 * |---|---|---|
 * | [MODE_SENSOR] | 平板/手机加速度计 | 真实 G，**含横向**；需要设备固定安装 |
 * | [MODE_SPEED] | 车速差分 `dv/dt` | 只用总线数据，**只有纵向**、且依赖车速质量 |
 *
 * 结果写进 [VehicleBus] 的三个派生通道：`calc_gx`（横向）/ `calc_gy`（纵向）/ `calc_gforce`（综合）。
 * 因此仪表盘侧完全不需要知道 G 值从哪来 —— 它只认 PID。
 *
 * ## 两个实现细节
 *
 * 1. **优先用 `TYPE_LINEAR_ACCELERATION`**（系统已去重力）。没有这个虚拟传感器时回退到
 *    `TYPE_ACCELEROMETER`，用慢速低通估出重力再减掉（高通）。
 * 2. **必须低通滤波**：原始加速度计噪声很大，不滤的话圆点会抖成一团，看不出驾驶状态。
 *
 * ## 轴向约定
 *
 * 横向 = 传感器 x，纵向 = 传感器 y（正 = 加速方向）。
 * 这假设设备**竖放且屏幕朝向驾驶员**。横放/平放时轴向会变，届时需要按实际安装调整 ——
 * 所以这一版先不提供轴向翻转开关，等实车确认安装方式再加。
 */
class GForceSource(private val ctx: Context) : SensorEventListener {

    companion object {
        const val MODE_OFF = 0
        const val MODE_SENSOR = 1
        const val MODE_SPEED = 2

        private const val G = 9.80665f

        /** 低通滤波系数：越小越平滑、越迟钝 */
        private const val ALPHA = 0.18f

        /** 估重力用的慢速低通（仅加速度计回退路径） */
        private const val GRAVITY_ALPHA = 0.02f

        /** 车速差分模式的平滑系数 */
        private const val SPEED_ALPHA = 0.30f

        /** 车速差分的最大 G，防止 GPS/总线跳变把指针甩飞 */
        private const val MAX_G = 2f
    }

    private val sensorManager =
        ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager

    private val linearSensor: Sensor?
        get() = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val accelSensor: Sensor?
        get() = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)

    @Volatile
    private var mode: Int = MODE_OFF

    @Volatile
    private var listening = false

    /** 当前模式下是否真的能出 G 值（给 UI 提示用） */
    @Volatile
    var available: Boolean = false
        private set

    /** 低通后的横向 / 纵向加速度（m/s²） */
    private var fx = 0f
    private var fy = 0f

    /** 加速度计回退路径里估出的重力分量 */
    private var gx = 0f
    private var gy = 0f

    /** 车速差分用的上一次采样 */
    private var lastSpeed: Float? = null
    private var lastTs = 0L

    /** 切换模式。会立即重挂/摘掉传感器监听。 */
    fun setMode(m: Int) {
        if (mode == m) return
        mode = m
        if (m == MODE_SENSOR) startSensor() else stopSensor()
        reset()
        AppLog.i(AppLog.M_DATA, "G 值来源已切换", "mode=${modeName(m)} available=$available")
    }

    fun currentMode(): Int = mode

    fun start() {
        if (mode == MODE_SENSOR) startSensor()
    }

    fun stop() {
        stopSensor()
    }

    fun modeName(m: Int = mode): String = when (m) {
        MODE_SENSOR -> "加速度计"
        MODE_SPEED -> "车速差分"
        else -> "关闭"
    }

    private fun reset() {
        fx = 0f; fy = 0f; gx = 0f; gy = 0f
        lastSpeed = null; lastTs = 0L
        available = false
    }

    private fun startSensor() {
        if (listening) return
        val s = linearSensor ?: accelSensor
        if (s == null) {
            available = false
            AppLog.w(AppLog.M_DATA, "设备没有加速度计，G 值不可用")
            return
        }
        val ok = runCatching {
            sensorManager.registerListener(this, s, SensorManager.SENSOR_DELAY_UI)
        }.getOrDefault(false)
        listening = ok
        available = ok
        AppLog.i(
            AppLog.M_DATA, "G 值传感器已注册",
            "sensor=${s.name} type=${if (s.type == Sensor.TYPE_LINEAR_ACCELERATION) "LINEAR" else "ACCEL"} ok=$ok"
        )
    }

    private fun stopSensor() {
        if (!listening) return
        runCatching { sensorManager.unregisterListener(this) }
        listening = false
        available = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (mode != MODE_SENSOR) return
        val v = event.values
        if (v.size < 2) return

        if (event.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION) {
            // 系统已去重力，直接低通
            fx += (v[0] - fx) * ALPHA
            fy += (v[1] - fy) * ALPHA
        } else {
            // 回退：慢速低通估重力，减掉得到运动加速度（高通）
            gx += (v[0] - gx) * GRAVITY_ALPHA
            gy += (v[1] - gy) * GRAVITY_ALPHA
            fx += ((v[0] - gx) - fx) * ALPHA
            fy += ((v[1] - gy) - fy) * ALPHA
        }
        emit(fx / G, fy / G, "sensor")
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { }

    /**
     * 由 [ObdEngine] 每轮轮询后调用。**只有车速差分模式在这里算**。
     *
     * 纵向 G = Δv / Δt / 9.80665。横向无从得知，固定输出 0。
     */
    fun onCycle() {
        if (mode != MODE_SPEED) return
        val speed = VehicleBus.value("std_0D") ?: return
        val now = System.currentTimeMillis()

        val v0 = lastSpeed
        val t0 = lastTs
        if (v0 != null && t0 > 0L) {
            val dt = (now - t0) / 1000f
            // dt 太小会放大噪声，太大说明中间丢了很多轮
            if (dt in 0.05f..5f) {
                val a = ((speed - v0) / 3.6f) / dt          // km/h → m/s，再除秒
                val g = (a / G).coerceIn(-MAX_G, MAX_G)
                fy += (g - fy) * SPEED_ALPHA
                fx += (0f - fx) * SPEED_ALPHA
                emit(fx / G, fy / G, "speed")
            }
        }
        lastSpeed = speed
        lastTs = now
    }

    private fun emit(gx: Float, gy: Float, src: String) {
        val now = System.currentTimeMillis()
        VehicleBus.put(PidValue("calc_gx", gx, src, now, true))
        VehicleBus.put(PidValue("calc_gy", gy, src, now, true))
        VehicleBus.put(PidValue("calc_gforce", sqrt(gx * gx + gy * gy), src, now, true))
    }
}
