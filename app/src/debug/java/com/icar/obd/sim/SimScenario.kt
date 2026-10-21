package com.icar.obd.sim

import kotlin.math.abs
import kotlin.math.sin

/**
 * 模拟场景定义（P5A-M01 阶段 B2）。
 *
 * ## 设计原则
 *
 * 1. **确定性**：同一 `tick` 一定产出同一组值 —— 自动化测试才敢断言具体数字。
 *    不用 `Random`，全部用 `tick` 的显式函数。
 * 2. **覆盖内置 PID**：车速/转速/水温/电压/负荷/节气门 都能驱到。
 * 3. **覆盖边界**：`ALARM` 场景把值推过 warnLow/warnHigh；
 *    `NULL_PID` 产出 `ok=false`；`MISSING_PID` 干脆不写某个 PID。
 * 4. **不出现负值**：车速/转速/负荷 都夹在 0 以上（真实传感器不会给负值）。
 *
 * 场景与内置 PID 的对应（id 见 `BuiltInPids.STANDARD`）：
 *
 * | id | 名称 | 单位 | 正常区间 |
 * |---|---|---|---|
 * | `std_0D` | 车速 | km/h | 0..260，warnHigh 120 |
 * | `std_0C` | 发动机转速 | rpm | 0..8000，warnHigh 6500 |
 * | `std_05` | 冷却液温度 | ℃ | -40..215，warnLow 60 / warnHigh 105 |
 * | `std_42` | 控制模块电压 | V | 0..20，warnLow 11.8 / warnHigh 15.2 |
 * | `std_04` | 发动机负荷 | % | 0..100 |
 * | `std_11` | 节气门开度 | % | 0..100 |
 * | `std_2F` | 油量 | % | 0..100 |
 */
enum class SimScenario(val id: String, val label: String, val desc: String) {

    /** 怠速巡航：车速稳定、转速低、水温正常 */
    NORMAL("normal", "正常运行", "怠速/巡航：车速 60、转速 800、水温 90、电压 14.2"),

    /** 加速：车速与转速同步上升，负荷与节气门增大 */
    ACCEL("accel", "加速", "车速 0→140、转速 800→5500、负荷 20→85、节气门 10→80"),

    /** 减速：车速与转速下降 */
    DECEL("decel", "减速", "车速 140→20、转速 5500→900"),

    /** 暖机：冷却液温度从 20℃ 升到 90℃ */
    WARMUP("warmup", "温度升高", "水温 20℃ → 90℃（跨过 warnLow 60）"),

    /** 报警：数值越过阈值 */
    ALARM("alarm", "报警阈值", "车速 200(>120)、转速 7000(>6500)、水温 112(>105)、电压 11.0(<11.8)"),

    /** 数据断开：来源关闭，所有值 ok=false */
    DISCONNECT("disconnect", "数据断开", "关闭来源 → 所有绑定仪表显示 --、状态灯回落"),

    /** 数据恢复：从断开状态重新开来源 */
    RECOVER("recover", "数据恢复", "重新开来源并立刻给出正常值"),

    /** 值为 null：部分 PID 产出 ok=false（模拟传感器无响应） */
    NULL_PID("nullpid", "PID 值为空", "转速与水温产出 ok=false，其余正常"),

    /** PID 不存在：只写一部分 PID，其余保持"从未有过值" */
    MISSING_PID("missing", "PID 不存在", "只写车速与电压；引用其它 PID 的仪表应显示 --"),

    /** 多 PID 同时更新：全部 PID 高频变化 */
    MULTI("multi", "多 PID 更新", "6 个内置 PID 同时按不同周期变化");

    companion object {

        // ---- 内置 PID id（与 BuiltInPids 保持一致）----
        const val PID_RPM = "std_0C"
        const val PID_SPEED = "std_0D"
        const val PID_COOLANT = "std_05"
        const val PID_VOLTAGE = "std_42"
        const val PID_LOAD = "std_04"
        const val PID_THROTTLE = "std_11"
        const val PID_FUEL = "std_2F"

        /** 所有场景都会写的 PID */
        private val CORE = listOf(PID_RPM, PID_SPEED, PID_COOLANT, PID_VOLTAGE, PID_LOAD, PID_THROTTLE)

        /**
         * 给定场景与 tick，产出 pidId → 值（null 表示 ok=false）。
         *
         * @param extra 额外的自定义 PID（值按 tick 做简单变化）
         */
        fun values(s: SimScenario, tick: Int, extra: List<String>): Map<String, Float?> {
            val out = LinkedHashMap<String, Float?>()
            val t = tick

            when (s) {
                NORMAL -> {
                    out[PID_SPEED] = 60f + wobble(t, 40, 3f)
                    out[PID_RPM] = 800f + wobble(t, 20, 60f)
                    out[PID_COOLANT] = 90f + wobble(t, 100, 1.5f)
                    out[PID_VOLTAGE] = 14.2f + wobble(t, 60, 0.15f)
                    out[PID_LOAD] = 22f + wobble(t, 30, 3f)
                    out[PID_THROTTLE] = 12f + wobble(t, 30, 2f)
                    out[PID_FUEL] = 68f + wobble(t, 200, 0.5f)
                }

                ACCEL -> {
                    // 0..60 tick 内线性爬升到目标，之后保持并轻微抖动
                    val k = clamp01(t.toFloat() / 60f)
                    out[PID_SPEED] = (lerp(0f, 140f, k) + wobble(t, 15, 1.5f)).coerceAtLeast(0f)
                    out[PID_RPM] = (lerp(800f, 5500f, k) + wobble(t, 12, 120f)).coerceAtLeast(0f)
                    out[PID_LOAD] = lerp(20f, 85f, k)
                    out[PID_THROTTLE] = lerp(10f, 80f, k)
                    out[PID_COOLANT] = 88f + wobble(t, 80, 1f)
                    out[PID_VOLTAGE] = 14.0f + wobble(t, 50, 0.1f)
                }

                DECEL -> {
                    val k = clamp01(t.toFloat() / 60f)
                    out[PID_SPEED] = (lerp(140f, 20f, k) + wobble(t, 15, 1f)).coerceAtLeast(0f)
                    out[PID_RPM] = (lerp(5500f, 900f, k) + wobble(t, 12, 60f)).coerceAtLeast(0f)
                    out[PID_LOAD] = lerp(85f, 15f, k)
                    out[PID_THROTTLE] = lerp(80f, 5f, k)
                    out[PID_COOLANT] = 92f + wobble(t, 80, 1f)
                    out[PID_VOLTAGE] = 14.1f + wobble(t, 50, 0.1f)
                }

                WARMUP -> {
                    // 20℃ → 90℃，120 tick 走完
                    val k = clamp01(t.toFloat() / 120f)
                    out[PID_COOLANT] = lerp(20f, 90f, k)
                    out[PID_SPEED] = 0f                      // 原地暖机
                    out[PID_RPM] = 1200f + wobble(t, 25, 40f) // 高怠速
                    out[PID_VOLTAGE] = 14.3f + wobble(t, 60, 0.1f)
                    out[PID_LOAD] = 18f + wobble(t, 30, 2f)
                    out[PID_THROTTLE] = 0f
                }

                ALARM -> {
                    // 全部越过阈值（warnHigh / warnLow）
                    out[PID_SPEED] = 200f + wobble(t, 20, 2f)      // > 120 warnHigh
                    out[PID_RPM] = 7000f + wobble(t, 15, 80f)      // > 6500 warnHigh
                    out[PID_COOLANT] = 112f + wobble(t, 40, 1f)    // > 105 warnHigh
                    out[PID_VOLTAGE] = 11.0f + wobble(t, 50, 0.05f) // < 11.8 warnLow
                    out[PID_LOAD] = 95f
                    out[PID_THROTTLE] = 90f
                }

                DISCONNECT -> {
                    // 断开时由 SimPidSource 关闭来源，这里不需要产出
                    // 但为了「场景函数是纯函数」，仍返回空表
                }

                RECOVER -> {
                    // 恢复后立刻给正常值
                    out[PID_SPEED] = 55f + wobble(t, 40, 2f)
                    out[PID_RPM] = 850f + wobble(t, 20, 40f)
                    out[PID_COOLANT] = 89f + wobble(t, 100, 1f)
                    out[PID_VOLTAGE] = 14.1f + wobble(t, 60, 0.1f)
                    out[PID_LOAD] = 25f
                    out[PID_THROTTLE] = 14f
                }

                NULL_PID -> {
                    // 转速与水温 = ok=false（传感器无响应），其余正常
                    out[PID_RPM] = null
                    out[PID_COOLANT] = null
                    out[PID_SPEED] = 70f + wobble(t, 40, 2f)
                    out[PID_VOLTAGE] = 14.2f + wobble(t, 60, 0.1f)
                    out[PID_LOAD] = 30f
                    out[PID_THROTTLE] = 18f
                }

                MISSING_PID -> {
                    // 只写车速与电压 —— 其它仪表应该显示 --
                    out[PID_SPEED] = 45f + wobble(t, 40, 1f)
                    out[PID_VOLTAGE] = 14.0f + wobble(t, 60, 0.1f)
                }

                MULTI -> {
                    // 每个 PID 用不同周期，便于观察"是否都在动"
                    out[PID_SPEED] = 80f + wobble(t, 36, 25f)
                    out[PID_RPM] = 2200f + wobble(t, 24, 900f)
                    out[PID_COOLANT] = 88f + wobble(t, 180, 6f)
                    out[PID_VOLTAGE] = 14.0f + wobble(t, 90, 0.5f)
                    out[PID_LOAD] = 45f + wobble(t, 48, 25f)
                    out[PID_THROTTLE] = 30f + wobble(t, 60, 20f)
                    out[PID_FUEL] = 60f + wobble(t, 300, 8f)
                }
            }

            // 自定义 PID：给一个可预测的锯齿值（0..100 循环）
            extra.forEachIndexed { i, pid ->
                if (!out.containsKey(pid)) {
                    out[pid] = ((t * (i + 3)) % 100).toFloat()
                }
            }

            return out
        }

        // ---- 小工具 ----

        private fun clamp01(v: Float): Float = if (v < 0f) 0f else if (v > 1f) 1f else v

        private fun lerp(a: Float, b: Float, k: Float): Float = a + (b - a) * k

        private fun wobble(t: Int, period: Int, amp: Float): Float =
            if (period <= 0) 0f else sin(2.0 * Math.PI * t / period).toFloat() * amp
    }
}
