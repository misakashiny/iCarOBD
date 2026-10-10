package com.icar.obd.ui

import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.data.AppLog
import com.icar.obd.R
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.obd.SignalSimulator
import com.icar.obd.ui.view.WaveThumbView

/**
 * 模拟信号工具 —— 无车调试仪表用的合成数据源。
 *
 * ## 这一版为什么重构（v1.9.0）
 *
 * 旧版每个通道铺 **7 行控件**（开关+名称+自动 / 波形下拉+周期 / 周期滑块 / min~max 输入 /
 * 噪声标签 / 噪声滑块），26 个通道就是 **182 行** —— 滚动地狱，
 * 想调"转速"要翻很久，而且：
 *
 *  - **波形是 Spinner 下拉**，7 个选项藏在里面，选完**还是不知道这波形长什么样**，
 *    得切到仪表盘等一个周期才能看出来；
 *  - **周期滑块 1–119 秒线性映射**，常用的 3/6/12/20 秒挤在最左边 16%，根本调不准；
 *  - **噪声滑块 0–0.3 线性**，常用值 0.004–0.05 挤在最左边；
 *  - **min/max 是 EditText**，要弹键盘、输入、失焦才生效，而且不校验 min > max；
 *  - **双列瀑布流**，表单在双列里阅读顺序会跳；
 *  - 顶部按钮是术语（"重建通道"、"全部自动"），不知道点了会怎样。
 *
 * ## 现在的结构
 *
 * ```
 * [状态点] 运行中 · 26 个通道 @10Hz        ← 固定，不随列表滚动
 * [        开始模拟 / 停止模拟        ]
 * [满量程快扫] [全部恢复默认] [重新读取 PID]
 * ────────────────────────────────
 * ▸ 标准 OBD (24)                          ← 分组可折叠
 *   [✓] 转速        ╱╲╱╲  3200 rpm   ▸     ← 单行摘要（含波形缩略图）
 *   [✓] 车速        ╱──╲    68 km/h   ▾     ← 展开后才有详情
 *      波形 [正弦][三角][锯齿][方波]...
 *      周期 [1s][2s][3s][5s][8s][12s][20s]...
 *      范围 0 ──●──── 8000   噪声 [0][0.01][0.02][0.05]
 * ▸ 派生 (2)
 * ```
 *
 * 关键改进：**波形缩略图**用的是 [SignalSimulator.waveAt] ——
 * 也就是真正灌进总线的那个函数，所以**预览不可能和实际输出脱节**。
 */
class SimulatorActivity : AppCompatActivity() {

    private lateinit var container: LinearLayout
    private lateinit var btnToggle: MaterialButton
    private lateinit var tvStatus: TextView
    private lateinit var tvHint: TextView
    private lateinit var simDot: View

    /** 展开详情的通道。默认全收起 —— 26 个通道全展开就是旧版那个滚动地狱 */
    private val expanded = HashSet<String>()

    /** 收起的组 */
    private val collapsedGroups = HashSet<String>()

    private var engineWasRunning = false

    /** 周期档位。**离散**而不是连续滑块 —— 常用的 3/6/12/20 秒在 1–119 线性映射里挤在最左边 */
    private val periodSteps = floatArrayOf(1f, 2f, 3f, 5f, 8f, 12f, 20f, 30f, 60f, 120f)

    /** 噪声档位。同理：常用值 0.004–0.05 在 0–0.3 线性映射里挤在最左边 */
    private val noiseSteps = floatArrayOf(0f, 0.005f, 0.01f, 0.02f, 0.05f, 0.1f, 0.2f)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_simulator)

        container = findViewById(R.id.simChannels)
        btnToggle = findViewById(R.id.btnSimToggle)
        tvStatus = findViewById(R.id.tvSimStatus)
        tvHint = findViewById(R.id.tvSimHint)
        simDot = findViewById(R.id.simDot)

        btnToggle.setOnClickListener { toggle() }

        // 「满量程快扫」：一行说清会做什么，而不是"快速演示（满量程快扫 · 3 秒一圈）"这种长串
        findViewById<MaterialButton>(R.id.btnSimDemo).setOnClickListener {
            SignalSimulator.applyDemoPreset()
            AppLog.i(AppLog.M_OBD, "模拟信号已切到满量程快扫", "channels=${SignalSimulator.channels().size}")
            buildRows()
            refreshHeader()
            ObdController.toast("已切到满量程快扫（3 秒一圈）")
        }

        // 「全部恢复默认」= 每个通道按自己的 PID 量程重建。旧文案"全部自动"看不出是这个意思
        findViewById<MaterialButton>(R.id.btnSimAllAuto).setOnClickListener {
            SignalSimulator.channels().forEach { SignalSimulator.resetToAuto(it.pidId) }
            buildRows()
            ObdController.toast("已按各 PID 量程恢复默认波形")
        }

        findViewById<MaterialButton>(R.id.btnSimRebuild).setOnClickListener {
            SignalSimulator.rebuildFromPids()
            buildRows()
            refreshHeader()
            ObdController.toast("已按「PID」页的启用状态重新读取通道")
        }

        SignalSimulator.rebuildFromPids()
        buildRows()
        refreshHeader()
    }

    override fun onDestroy() {
        super.onDestroy()
        // ⚠️ 刻意**不**在这里停模拟信号。
        //
        // 模拟信号是一个**数据源**，应该像 OBD 连接一样在界面之外继续跑；
        // 原来这里会 stop()，而提示却写着"切到仪表盘页即可看到效果"——
        // 用户照着做就把数据源关了。详见 docs/LVGL-放弃记录.md 同期的 CHANGELOG。
        if (SignalSimulator.running) {
            AppLog.i(AppLog.M_UI, "离开模拟器界面，模拟信号继续运行")
        } else if (engineWasRunning) {
            ObdController.engine.start()
        }
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun color(id: Int): Int = ContextCompat.getColor(this, id)

    // ---------------------------------------------------------------- 开关

    private fun toggle() {
        if (SignalSimulator.running) {
            SignalSimulator.stop()
            if (engineWasRunning) {
                ObdController.engine.start()
                engineWasRunning = false
            }
        } else {
            engineWasRunning = ObdController.engine.running
            if (engineWasRunning) ObdController.engine.stop()
            SignalSimulator.start()
        }
        refreshHeader()
    }

    private fun refreshHeader() {
        val all = SignalSimulator.channels()
        val on = all.count { it.enabled }
        val running = SignalSimulator.running

        simDot.setBackgroundResource(if (running) R.drawable.dot_online else R.drawable.dot_offline)
        tvStatus.text = if (running) "运行中 · $on 个通道 @10Hz" else "未运行"
        tvStatus.setTextColor(color(if (running) R.color.ok else R.color.text_dim))
        btnToggle.text = if (running) "停止模拟" else "开始模拟"

        tvHint.text = if (running) {
            "**离开本页不会停**，切到「仪表盘」页即可看到效果。\n" +
                "仪表盘顶部会显示「模拟数据」提示。要停就回到这里点「停止模拟」。"
        } else if (on == 0) {
            "没有启用的通道。先到「PID」页启用几个，再点「重新读取 PID」。"
        } else {
            "$on 个通道待命。点「开始模拟」后往数据总线灌合成值，用于无车调试仪表外观与动画。"
        }
    }

    // ---------------------------------------------------------------- 列表

    private fun buildRows() {
        container.removeAllViews()
        val list = SignalSimulator.channels()
        if (list.isEmpty()) {
            container.addView(
                TextView(this).apply {
                    text = "没有启用的 PID。\n请先到「PID」页启用几个通道，再回来点「重新读取 PID」。"
                    setPadding(0, dp(24), 0, 0)
                    setTextColor(color(R.color.text_dim))
                    textSize = 13f
                }
            )
            return
        }

        // 按 PID 的 group 分组。没有 group 的归到"其它"
        val groups = LinkedHashMap<String, MutableList<SignalSimulator.Channel>>()
        list.forEach { ch ->
            val g = Store.findPid(ch.pidId)?.group?.takeIf { it.isNotBlank() } ?: "其它"
            groups.getOrPut(g) { mutableListOf() }.add(ch)
        }

        groups.forEach { (name, chans) ->
            container.addView(groupHeader(name, chans))
            if (name !in collapsedGroups) {
                chans.forEach { container.addView(channelRow(it)) }
            }
        }
    }

    private fun groupHeader(name: String, chans: List<SignalSimulator.Channel>): View {
        val on = chans.count { it.enabled }
        val collapsed = name in collapsedGroups
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(14), 0, dp(6))
            isClickable = true
            setOnClickListener {
                if (collapsed) collapsedGroups.remove(name) else collapsedGroups.add(name)
                buildRows()
            }
            addView(TextView(this@SimulatorActivity).apply {
                text = if (collapsed) "▸" else "▾"
                textSize = 14f
                setTextColor(color(R.color.text_secondary))
                setPadding(0, 0, dp(6), 0)
            })
            addView(TextView(this@SimulatorActivity).apply {
                text = name
                textSize = 14f
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                setTextColor(color(R.color.text_primary))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(TextView(this@SimulatorActivity).apply {
                text = "$on/${chans.size} 启用"
                textSize = 12f
                setTextColor(color(R.color.text_dim))
            })
        }
    }

    /** 单行摘要：[开关] 名称 [波形缩略图] 当前值 [展开箭头] */
    private fun channelRow(ch: SignalSimulator.Channel): View {
        val pid = Store.findPid(ch.pidId)
        val isOpen = ch.pidId in expanded

        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(color(if (isOpen) R.color.bg_surface2 else R.color.bg_surface))
            setPadding(dp(10), dp(6), dp(10), dp(6))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(4) }
        }

        // ---- 摘要行
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            setOnClickListener {
                if (isOpen) expanded.remove(ch.pidId) else expanded.add(ch.pidId)
                buildRows()
            }
        }
        row.addView(MaterialSwitch(this).apply {
            isChecked = ch.enabled
            setOnCheckedChangeListener { _, on ->
                ch.enabled = on
                refreshHeader()
            }
        })
        row.addView(TextView(this).apply {
            text = pid?.name ?: ch.pidId
            textSize = 14f
            setTextColor(color(if (ch.enabled) R.color.text_primary else R.color.text_dim))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            setPadding(dp(10), 0, dp(6), 0)
        })
        // 波形缩略图：一眼看出是什么波，不用切页面等一个周期
        row.addView(WaveThumbView(this).apply {
            setColors(color(R.color.accent), color(R.color.gauge_track))
            setWave(ch.wave)
            layoutParams = LinearLayout.LayoutParams(dp(54), dp(22)).apply { marginEnd = dp(8) }
        })
        row.addView(TextView(this).apply {
            text = "${fmt(ch.min)}~${fmt(ch.max)} ${pid?.unit ?: ""}"
            textSize = 11f
            setTextColor(color(R.color.text_dim))
            gravity = Gravity.END
            layoutParams = LinearLayout.LayoutParams(dp(96), ViewGroup.LayoutParams.WRAP_CONTENT)
        })
        row.addView(TextView(this).apply {
            text = if (isOpen) "▾" else "▸"
            textSize = 13f
            setTextColor(color(R.color.text_secondary))
            setPadding(dp(6), 0, 0, 0)
        })
        col.addView(row)

        if (isOpen) {
            col.addView(space(6))
            col.addView(chipLabel("波形"))
            col.addView(chipRow(
                SignalSimulator.WAVE_NAMES,
                SignalSimulator.WAVE_NAMES.getOrNull(ch.wave) ?: "",
                color(R.color.accent)
            ) { i -> ch.wave = i; buildRows() })

            col.addView(space(6))
            col.addView(chipLabel("周期（秒）"))
            col.addView(chipRow(
                periodSteps.map { fmt(it) },
                fmt(nearestStep(periodSteps, ch.periodSec)),
                color(R.color.info)
            ) { i -> ch.periodSec = periodSteps[i]; buildRows() })

            col.addView(space(6))
            col.addView(chipLabel("噪声"))
            col.addView(chipRow(
                noiseSteps.map { fmt(it) },
                fmt(nearestStep(noiseSteps, ch.noise)),
                color(R.color.warn)
            ) { i -> ch.noise = noiseSteps[i]; buildRows() })

            col.addView(space(6))
            col.addView(chipLabel("范围"))
            col.addView(rangeRow(ch))
        }
        return col
    }

    private fun space(h: Int) = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(h))
    }

    private fun chipLabel(text: String) = TextView(this).apply {
        this.text = text
        textSize = 11f
        setTextColor(color(R.color.text_dim))
        setPadding(0, 0, 0, dp(3))
    }

    /** 一行可横滑的 chip。选中态用实心，未选中用描边 */
    private fun chipRow(
        labels: List<String>, selected: String, accent: Int, onPick: (Int) -> Unit
    ): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        labels.forEachIndexed { i, label ->
            val on = label == selected
            row.addView(MaterialButton(this).apply {
                text = label
                textSize = 11f
                minWidth = 0
                minimumWidth = 0
                setPadding(dp(12), 0, dp(12), 0)
                isAllCaps = false
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, dp(32)
                ).apply { marginEnd = dp(6) }
                if (on) {
                    setBackgroundColor(accent)
                    setTextColor(Color.BLACK)
                } else {
                    setBackgroundColor(color(R.color.bg_elevated))
                    setTextColor(color(R.color.text_secondary))
                }
                setOnClickListener { onPick(i) }
            })
        }
        return row
    }

    /** min/max 用可点的 ± 档位而不是 EditText —— 不用弹键盘，也不会输错 */
    private fun rangeRow(ch: SignalSimulator.Channel): View {
        val pid = Store.findPid(ch.pidId)
        val pidMin = pid?.minVal ?: 0f
        val pidMax = pid?.maxVal ?: 100f
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        // ⚠️ v1.20.18：**只把每一端夹在 PID 量程里是不够的** ——
        // 「最小」能一路加到 PID 上界、「最大」能一路减到下界，
        // 两端各自都合法，合起来却是空区间 → `valueOf` 的 `coerceIn(min,max)` 抛
        // `IllegalArgumentException: Cannot coerce value to an empty range`。
        // 2026-10-11 01:31:12 实机崩溃就是这么来的（冷却液温度：最小 122.0 > 最大 120.5）。
        // 现在走 `withMin` / `withMax`：**不允许越过另一端**。
        row.addView(rangeSide("最小", ch.min, pidMin, pidMax) { v ->
            SignalSimulator.update(ch.withMin(v)); buildRows()
        })
        row.addView(TextView(this).apply {
            text = "  ~  "
            textSize = 12f
            setTextColor(color(R.color.text_dim))
        })
        row.addView(rangeSide("最大", ch.max, pidMin, pidMax) { v ->
            SignalSimulator.update(ch.withMax(v)); buildRows()
        })
        return row
    }

    private fun rangeSide(
        title: String, value: Float, pidMin: Float, pidMax: Float,
        set: (Float) -> Unit
    ): View {
        // 步进走 `SignalSimulator.stepRange`：**两端先归一再夹** ——
        // PID 量程被写反时（导入的 JSON 没有 PidDraft 那层校验）也不会在这里抛空 range。
        val lo = minOf(pidMin, pidMax)
        val hi = maxOf(pidMin, pidMax)
        val span = (hi - lo).let { if (it <= 0f) 1f else it }
        val step = span / 20f
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        fun small(text: String, onTap: () -> Unit) = MaterialButton(this).apply {
            this.text = text
            textSize = 13f
            minWidth = 0
            minimumWidth = 0
            setPadding(dp(10), 0, dp(10), 0)
            isAllCaps = false
            layoutParams = LinearLayout.LayoutParams(dp(34), dp(32))
            setBackgroundColor(color(R.color.bg_elevated))
            setTextColor(color(R.color.text_secondary))
            setOnClickListener { onTap() }
        }
        box.addView(small("−") {
            set(SignalSimulator.stepRange(value, -step, pidMin, pidMax))
        })
        box.addView(TextView(this).apply {
            text = "$title ${fmt(value)}"
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(color(R.color.text_primary))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        box.addView(small("+") {
            set(SignalSimulator.stepRange(value, step, pidMin, pidMax))
        })
        return box
    }

    /** 找最接近的档位下标（用于把连续值显示成选中的档） */
    private fun nearestStep(steps: FloatArray, v: Float): Float {
        var best = steps[0]
        var bestD = Float.MAX_VALUE
        steps.forEach { s ->
            val d = Math.abs(s - v)
            if (d < bestD) { bestD = d; best = s }
        }
        return best
    }

    private fun fmt(v: Float): String =
        if (v == v.toInt().toFloat()) v.toInt().toString() else String.format("%.3f", v)
}
