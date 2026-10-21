package com.icar.obd.sim

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.util.Log

/**
 * 模拟数据的开关与广播控制（P5A-M01 阶段 B3）。
 *
 * ## 为什么用广播
 *
 * 自动化测试（ADB）需要在不点界面的情况下切换场景：
 *
 * ```bash
 * adb shell am broadcast -a com.icar.obd.SIM --es scenario accel
 * adb shell am broadcast -a com.icar.obd.SIM --es scenario off
 * adb shell am broadcast -a com.icar.obd.SIM --es scenario normal --ei step 5
 * adb shell am broadcast -a com.icar.obd.SIM --es dump 1
 * ```
 *
 * `--es dump 1` 会**把总线里每个 PID 的当前值打到 logcat**，
 * 自动化脚本据此断言「数据真的进了 VehicleBus」——
 * 不用去读屏幕上的数字（截图 OCR 不可靠）。
 */
object SimControl {

    const val ACTION = "com.icar.obd.SIM"

    const val EXTRA_SCENARIO = "scenario"
    const val EXTRA_PID = "pid"
    const val EXTRA_STEP = "step"
    const val EXTRA_DUMP = "dump"

    /** 自动化断言要看的 PID（与 SimScenario 的核心通道一致） */
    private val DUMP_PIDS = listOf(
        "std_0C" to "转速",
        "std_0D" to "车速",
        "std_05" to "水温",
        "std_42" to "电压",
        "std_04" to "负荷",
        "std_11" to "节气门"
    )

    private var receiver: BroadcastReceiver? = null

    fun register(ctx: Context) {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                if (i == null) return
                handle(i)
            }
        }
        receiver = r
        val filter = IntentFilter(ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.applicationContext.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.applicationContext.registerReceiver(r, filter)
        }
    }

    fun unregister(ctx: Context) {
        receiver?.let { runCatching { ctx.applicationContext.unregisterReceiver(it) } }
        receiver = null
    }

    /** 处理一条控制指令 */
    fun handle(i: Intent) {
        // ---------- dump：只读总线，不改场景 ----------
        val dump = i.getStringExtra(EXTRA_DUMP)
        if (dump != null && dump != "0" && !dump.equals("false", true)) {
            dumpBus()
            return
        }

        val raw = i.getStringExtra(EXTRA_SCENARIO) ?: run {
            Log.w("SimControl", "收到 SIM 广播但缺少 scenario 参数")
            return
        }
        Log.i("SimControl", "收到 SIM 广播 scenario=$raw pid=${i.getStringExtra(EXTRA_PID)} step=${i.getIntExtra(EXTRA_STEP, 0)}")

        if (raw.equals("off", true) || raw.equals("disable", true)) {
            SimPidSource.disable()
            Log.i("SimControl", SimPidSource.statusText())
            return
        }

        val sc = SimScenario.values().firstOrNull { it.id.equals(raw, true) }
            ?: SimScenario.values().firstOrNull { it.name.equals(raw, true) }
            ?: run {
                Log.w("SimControl", "未知场景: $raw")
                return
            }

        val extra = i.getStringExtra(EXTRA_PID)
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()

        if (!SimPidSource.enabled || SimPidSource.scenario == SimScenario.DISCONNECT ||
            sc == SimScenario.DISCONNECT
        ) {
            SimPidSource.enable(sc, extra)
            if (sc == SimScenario.DISCONNECT) SimPidSource.setScenario(sc)
        } else {
            SimPidSource.setScenario(sc)
        }

        val n = i.getIntExtra(EXTRA_STEP, 0)
        if (n > 0) SimPidSource.step(n)
        Log.i("SimControl", SimPidSource.statusText())
    }

    /**
     * 把总线里每个关注 PID 的当前值打到 logcat。
     *
     * 输出格式固定，便于脚本正则解析：
     *
     * ```
     * BUSD std_0C ok=1 v=1234.0 err=- name=转速
     * BUSD std_0D ok=0 v=0.0 err=模拟：数据断开 name=车速
     * ```
     */
    private fun dumpBus() {
        DUMP_PIDS.forEach { (pid, name) ->
            val pv = com.icar.obd.obd.VehicleBus.get(pid)
            if (pv == null) {
                Log.i("SimBus", "BUSD $pid ok=-1 v=none name=$name")
            } else {
                Log.i(
                    "SimBus",
                    "BUSD $pid ok=${if (pv.ok) 1 else 0} v=${pv.value} err=${pv.error ?: "-"} name=$name"
                )
            }
        }
        Log.i("SimBus", "BUSD sim=${SimPidSource.enabled} scene=${SimPidSource.scenario.id} tick=${SimPidSource.tick}")
    }
}
