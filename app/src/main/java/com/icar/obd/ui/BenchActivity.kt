package com.icar.obd.ui

import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.ui.dash.DashboardBenchmark
import com.icar.obd.ui.view.DrawStats
import com.icar.obd.ui.view.GaugeTheme
import java.io.File

/**
 * 仪表盘**性能基准**页 —— 回答一个从 v1.9.0 起就没答上的问题：
 *
 * > **9 层霓虹辉光，在 8 个仪表下守得住 60fps 吗？**
 *
 * ## 为什么这件事必须做在重构之前
 *
 * 见 `docs/下一步-主题工具与仪表盘重构.md` §2.4。如果守不住，
 * `NeonStyle` 的默认值和 `layersFor` 的档位都要重调，
 * 而重构（拆 `DashRenderer`、抽 `GaugePalette`）的基线就跟着变 ——
 * **先量再改，否则改完还得再量一遍**。
 *
 * ## 为什么之前量不出来
 *
 * 1. `dumpsys gfxinfo` 在这台设备上只给头部、没有帧统计；
 * 2. 用真实数据测时**仪表根本没在动** —— 静止的 View 不重绘，
 *    测出来的"帧率"是屏幕刷新率，跟绘制成本无关。
 *
 * 这一页用 [BenchHarness] 每帧强制重绘，配合 [DrawStats] 的真实耗时，
 * 把这两个坑一起绕开。
 *
 * ## 三段测量
 *
 * 依次跑「主题默认 / 夸张（11 层）/ 关闭辉光」，每段 10 秒。
 * 三段的意义是给出**辉光的边际成本**：如果关闭辉光也只快一点点，
 * 说明瓶颈不在辉光，优化方向就要换。
 */
class BenchActivity : AppCompatActivity() {

    private lateinit var gaugeHost: FrameLayout
    private lateinit var tvSummary: TextView
    private lateinit var tvProgress: TextView
    private lateinit var btnRun: MaterialButton

    private val main = Handler(Looper.getMainLooper())
    private var harness: BenchHarness? = null
    private val results = ArrayList<Measure>()

    /**
     * 四段：档位名 → 表数 / 霓虹档位（null = 跟随主题默认）。
     *
     * 前三段固定 8 个表，只改霓虹档位 —— 这样「辉光的边际成本」是可比的。
     * 第四段加到 [DashboardBenchmark.STRESS_GAUGES] 个表，用来**看斜率**：
     * 只测 8 个的话，万一刚好压线，结论就只是「这一种排布没事」。
     */
    private val segments: List<Segment> = listOf(
        Segment("8 表 · 主题默认", DashboardBenchmark.GAUGES, null),
        Segment("8 表 · 夸张（11 层）", DashboardBenchmark.GAUGES, "夸张"),
        Segment("8 表 · 关闭辉光", DashboardBenchmark.GAUGES, "关闭"),
        Segment("12 表 · 夸张（极限）", DashboardBenchmark.STRESS_GAUGES, "夸张"),
    )

    private data class Segment(val label: String, val count: Int, val preset: String?)

    private var segIndex = 0

    /**
     * 测量开始时记下的屏幕刷新率。
     *
     * 掉帧判据要按它算：120Hz 下 8.3ms 就是正常帧，用 60fps 的 16.7ms 当判据
     * 会把「掉了一半帧」当成完全正常。
     */
    private var hzAtStart = 60f

    /** 掉帧判据（毫秒）= 一个刷新周期 × 1.5。1.5 倍给调度留余量，避免把正常抖动算成掉帧 */
    private fun jankMs(): Double {
        val hz = if (hzAtStart > 1f) hzAtStart else 60f
        return 1000.0 / hz * 1.5
    }

    /**
     * 当前测量用的霓虹档位。
     *
     * ⚠️ **布局监听器只能读这个，绝不能读 `segments[segIndex]`。**
     *
     * 第一版在 `onLayoutChange` 里写 `segments[segIndex].second`，
     * 而 `segIndex` 在三段跑完后会变成 3 —— 此时只要再发生一次布局，
     * 就直接 `ArrayIndexOutOfBoundsException: length=3; index=3` 崩掉。
     * 实测在真机上崩了两次（`files/last-crash.log`）。
     *
     * 现在布局监听器**完全不碰索引**：要重建就按主题默认重建。
     */
    @Volatile
    private var currentPreset: String? = null

    /** 当前表数。布局监听器重建时要用同一个值 */
    @Volatile
    private var currentCount: Int = DashboardBenchmark.GAUGES

    /** 测量进行中。布局监听器据此避免在测量期间重建视图（重建会打断计时） */
    @Volatile
    private var measuring = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        AppLog.i(AppLog.M_UI, "性能基准页已打开", "gauges=${DashboardBenchmark.gauges.size}")
    }

    override fun onDestroy() {
        super.onDestroy()
        main.removeCallbacksAndMessages(null)
        harness?.stop()
    }

    // ---------------------------------------------------------------- UI

    /**
     * ⚠️ **不要把这些控件放进 `ScrollView`。**
     *
     * 第一版是 `ScrollView > LinearLayout > (标题+按钮+weight=1 的画布)`，
     * 结果画布高度**塌成 0** —— `ScrollView` 用无界高度测量子 View，
     * `weight` 拿不到任何剩余空间可分。表现是点「开始测量」直接报
     * 「容器还没布局好」，8 个表一个都没建出来。
     *
     * 现在改成：**固定高度的头部 + `weight=1` 的画布**，根部不再套 ScrollView。
     * 画布必须拿到确定的像素高度，[BenchHarness.build] 才有尺寸可用。
     */
    private fun buildUi(): ViewGroup {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(color(R.color.bg))
            setPadding(dp(12), dp(12), dp(12), dp(12))
        }

        val head = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }

        head.addView(TextView(this).apply {
            text = "仪表盘性能基准"
            textSize = 16f
            setTextColor(color(R.color.text_primary))
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER_VERTICAL
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        btnRun = MaterialButton(this).apply {
            text = "开始测量"
            setOnClickListener { runAll() }
        }
        head.addView(btnRun, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ))

        head.addView(MaterialButton(this).apply {
            text = "复制结果"
            setOnClickListener { copyResult() }
        }, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply { marginStart = dp(6) })

        root.addView(head)

        tvProgress = TextView(this).apply {
            textSize = 12f
            setTextColor(color(R.color.accent))
            text = "就绪 · 四段（8 表×3 档 + 12 表极限）· 每帧强制重绘"
        }
        root.addView(tvProgress)

        tvSummary = TextView(this).apply {
            textSize = 11f
            setTextColor(color(R.color.text_secondary))
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(4), 0, dp(4))
            text = "还没测。"
        }
        root.addView(tvSummary)

        gaugeHost = FrameLayout(this).apply {
            setBackgroundColor(color(R.color.bg_surface))
            // 容器要有确定高度，否则 build() 时宽高为 0，量不到任何东西。
            //
            // ⚠️ 这里**只能**用 currentPreset，不能用 segments[segIndex] ——
            // 后者在三段跑完后会越界崩溃（见 currentPreset 的注释）。
            // 测量期间也不重建：重建会清掉计时窗口，数字就没意义了。
            addOnLayoutChangeListener { _, l, t, r, b, ol, ot, orr, ob ->
                val sizeChanged = (r - l) != (orr - ol) || (b - t) != (ob - ot)
                if (sizeChanged && !measuring) {
                    harness?.build(currentCount, currentPreset)
                }
            }
        }
        root.addView(
            gaugeHost,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
                .apply { topMargin = dp(4) }
        )

        return root
    }

    // ---------------------------------------------------------------- 测量流程

    /**
     * 三段依次跑。
     *
     * 用 `Handler.postDelayed` 而不是 `Choreographer` 驱动状态机：
     * 段与段之间要重建视图，用固定延时最直观，也不会和渲染帧抢时序。
     */
    private fun runAll() {
        results.clear()
        segIndex = 0
        hzAtStart = refreshHz()
        btnRun.isEnabled = false
        runSegment()
    }

    private fun runSegment() {
        // 防御：状态机被外部打断（比如连点两次）时不越界
        if (segIndex !in segments.indices) {
            measuring = false
            btnRun.isEnabled = true
            return
        }
        val seg = segments[segIndex]
        currentPreset = seg.preset
        currentCount = seg.count
        val h = harness ?: BenchHarness(gaugeHost, GaugeTheme.of(GaugeTheme.NEON)).also { harness = it }
        // 每次重新 build：一是换表数/霓虹档位，二是首次进来时容器可能刚布局完还没建过
        h.build(seg.count, seg.preset)
        if (h.gaugeCount == 0) {
            tvProgress.text = "容器还没布局好（宽高为 0），请再点一次「开始测量」"
            btnRun.isEnabled = true
            return
        }

        measuring = true
        tvProgress.text = "第 ${segIndex + 1}/${segments.size} 段：${seg.label} —— 预热 ${BenchHarness.WARMUP_MS}ms 后测 ${BenchHarness.SEGMENT_SEC}s…"
        h.start()

        // 总时长 = 预热 + 测量。**必须把预热算进去** ——
        // 只延时 SEGMENT_SEC 的话，测量窗口会被预热吃掉 1.5 秒，
        // 实际只测了 8.5 秒（第一版就是这个错，数字偏乐观）。
        main.postDelayed({
            h.stop()
            measuring = false
            val snap = DrawStats.snapshot()
            val m = Measure(
                label = seg.label,
                gauges = h.gaugeCount,
                frames = h.frameCount(),
                fps = h.measuredFps(),
                drawMs = snap.frameMs,
                peakUs = snap.peakUs,
                animating = h.animatingCount(),
                rows = snap.rows,
                frameStats = h.frameStats(jankMs()),
                motionRatio = h.motionRatio(),
                motionMoved = h.motionFramesMoved
            )
            results.add(m)
            AppLog.i(AppLog.M_UI, "基准段完成", m.oneLine())
            AppLog.i(AppLog.M_UI, "基准段帧间隔", "${seg.label} | ${m.frameStats.oneLine(jankMs())}")
            renderSummary()

            segIndex++
            if (segIndex < segments.size) {
                main.postDelayed({ runSegment() }, 400)
            } else {
                tvProgress.text = "测量完成"
                btnRun.isEnabled = true
                finishAll()
            }
        }, BenchHarness.WARMUP_MS + BenchHarness.SEGMENT_SEC * 1000L)
    }

    /** 把结论写成一行写进日志，并把完整报告落盘 —— 分析时不用盯着屏幕抄数字 */
    private fun finishAll() {
        val report = buildReport()
        AppLog.i(AppLog.M_UI, "基准结论", verdictLine())
        runCatching {
            File(filesDir, "bench-dashboard.txt").writeText(report)
        }.onFailure {
            AppLog.w(AppLog.M_UI, "基准报告写入失败", it.message ?: "")
        }
    }

    /**
     * 结论行。**判据落在数字上** —— 本项目有过"没崩就算过"的教训
     * （注入被队列截断，根本没走到被测分支）。
     *
     * ## 两个指标，各自回答不同的问题
     *
     * | 指标 | 量的是什么 | 能回答 |
     * |---|---|---|
     * | **帧间隔**（主判据） | 主线程 + 渲染线程 + 合成器整条链路的最终结果 | **有没有掉帧** |
     * | `DrawStats` 每帧耗时（旁证） | 主线程 `onDraw` 里**记录**绘制指令的耗时 | 视图层代码有没有意外变贵 |
     *
     * ⚠️ **不能只用 `DrawStats` 下结论**：开了硬件加速后 `onDraw` 只把指令记进
     * DisplayList，真正的光栅化在渲染线程上做。所以那 0.3ms **不是**绘制成本，
     * 拿它说"还有 50 倍余量"是错的。
     *
     * ## 判据为什么不是帧率
     *
     * 帧率被屏幕刷新率封顶（实测这台平板会在 30/60/120Hz 之间切），
     * 拿它当判据会得出"刚好达标"或"轻松达标"的错觉。
     */
    private fun verdictLine(): String {
        if (results.isEmpty()) return "无数据"
        val worst = results.maxByOrNull { it.frameStats.overBudgetPct } ?: return "无数据"
        val clean = results.all { it.frameStats.clean }
        val hz = hzAtStart
        return buildString {
            append("掉帧判据=%.1fms（%.0fHz × 1.5）→ ".format(jankMs(), hz))
            if (clean) {
                append("**四段全部无掉帧**")
            } else {
                append("**有掉帧**，最差是「%s」：%d/%d 帧超时（%.1f%%）"
                    .format(worst.label, worst.frameStats.overBudget, worst.frameStats.count,
                        worst.frameStats.overBudgetPct))
            }
            append("；最慢一段的帧间隔 p99=%.2fms 最大=%.2fms"
                .format(results.maxOf { it.frameStats.p99Ms }, results.maxOf { it.frameStats.maxMs }))
            append("。视图层记录耗时 %.2fms/帧（旁证，非光栅化成本）"
                .format(results.maxOf { it.drawMs }))
        }
    }

    /** 当前屏幕刷新率（Hz）。用来解释帧率为什么封顶在某个值 */
    private fun refreshHz(): Float =
        runCatching { windowManager.defaultDisplay.refreshRate }.getOrDefault(0f)

    private fun buildReport(): String {
        val sb = StringBuilder()
        sb.appendLine("# 仪表盘性能基准报告")
        sb.appendLine()
        sb.appendLine("设备：${android.os.Build.MODEL} · 画布容器 ${gaugeHost.width}×${gaugeHost.height}")
        sb.appendLine("屏幕刷新率：%.1f Hz（**帧率会被它封顶**，所以主判据是帧间隔而不是 fps）".format(hzAtStart))
        sb.appendLine("每段：预热 ${BenchHarness.WARMUP_MS}ms + 测量 ${BenchHarness.SEGMENT_SEC}s。")
        sb.appendLine("全部为圆表（最贵的样式），每帧强制重绘；掉帧判据 = 刷新周期 × 1.5 = %.1fms".format(jankMs()))
        sb.appendLine()
        sb.appendLine("## 主判据：帧间隔（有没有掉帧）")
        sb.appendLine()
        sb.appendLine("| 档位 | 仪表 | 帧数 | 平均 | p99 | 最大 | 超时帧 | 结论 |")
        sb.appendLine("|---|---|---|---|---|---|---|---|")
        results.forEach { m ->
            val f = m.frameStats
            sb.appendLine(
                "| ${m.label} | ${m.gauges} | ${f.count} | %.2f ms | %.2f ms | %.2f ms | ${f.overBudget}（%.1f%%） | %s |"
                    .format(f.avgMs, f.p99Ms, f.maxMs, f.overBudgetPct, if (f.clean) "无掉帧" else "有掉帧")
            )
        }
        sb.appendLine()
        sb.appendLine("## 流畅度：显示值真的变了的帧占比（v1.10.4）")
        sb.appendLine()
        sb.appendLine("帧率与掉帧只说明「画得动」，不说明「动得顺」。")
        sb.appendLine("指针「一格一格跳」的本质是**部分帧上没有位移**（缓动提前收敛 / 吸附太早），")
        sb.appendLine("所以这里直接数「显示值真的变了」的帧占比 —— 越高越顺。")
        sb.appendLine()
        sb.appendLine("| 档位 | 动了 | 总帧 | 占比 |")
        sb.appendLine("|---|---|---|---|")
        results.forEach { m ->
            sb.appendLine(
                "| ${m.label} | ${m.motionMoved} | ${m.frameStats.count} | %.1f%% |"
                    .format(m.motionRatio * 100)
            )
        }
        sb.appendLine()
        sb.appendLine("## 旁证：视图层记录耗时（**不是**光栅化成本）")
        sb.appendLine()
        sb.appendLine("⚠️ 硬件加速下 `onDraw` 只把绘制指令记录进 DisplayList，真正光栅化在渲染线程。")
        sb.appendLine("所以这一列低**不能**推出「绘制很便宜」，只能说明视图层代码没意外变贵。")
        sb.appendLine()
        sb.appendLine("| 档位 | 仪表 | 自绘帧 | 帧率 | 每帧记录耗时 | 单次峰值 | 动画中 |")
        sb.appendLine("|---|---|---|---|---|---|---|")
        results.forEach { m ->
            sb.appendLine(
                "| ${m.label} | ${m.gauges} | ${m.frames} | %.1f fps | %.2f ms | %.0f µs | ${m.animating}/${m.gauges} |"
                    .format(m.fps, m.drawMs, m.peakUs)
            )
        }
        sb.appendLine()
        sb.appendLine("## 结论")
        sb.appendLine()
        sb.appendLine(verdictLine())
        sb.appendLine()
        sb.appendLine("## 明细（按平均耗时降序）")
        results.forEach { m ->
            sb.appendLine()
            sb.appendLine("### ${m.label}")
            m.rows.forEach { r ->
                sb.appendLine("- ${r.name}: 次数=${r.count} 平均=%.0fµs 峰值=%.0fµs".format(r.avgUs, r.peakUs))
            }
        }
        return sb.toString()
    }

    private fun renderSummary() {
        if (results.isEmpty()) return
        val sb = StringBuilder()
        results.forEach { m ->
            val f = m.frameStats
            sb.appendLine(
                "%s：%d 帧 | 间隔 平均%.2f p99=%.2f 最大%.2f ms | 超时 %d（%.1f%%） | 记录 %.2fms | 动 %.0f%%"
                    .format(m.label, f.count, f.avgMs, f.p99Ms, f.maxMs, f.overBudget,
                        f.overBudgetPct, m.drawMs, m.motionRatio * 100)
            )
        }
        sb.appendLine()
        sb.appendLine(verdictLine())
        sb.appendLine()
        sb.appendLine("（详细报告见 files/bench-dashboard.txt）")
        tvSummary.text = sb.toString()
    }

    private fun copyResult() {
        val text = buildReport()
        runCatching {
            val cm = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            cm.setPrimaryClip(android.content.ClipData.newPlainText("bench", text))
        }
        // 同时也写文件：复制走不通时还能 adb 取
        runCatching { File(filesDir, "bench-dashboard.txt").writeText(text) }
        tvProgress.text = "报告已复制（并写入 files/bench-dashboard.txt）"
    }

    // ---------------------------------------------------------------- 小工具

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
    private fun color(id: Int): Int = ContextCompat.getColor(this, id)

    /** 一段测量的结果 */
    private data class Measure(
        val label: String,
        val gauges: Int,
        val frames: Long,
        val fps: Double,
        val drawMs: Double,
        val peakUs: Double,
        val animating: Int,
        val rows: List<DrawStats.Snapshot.Row>,
        /** 帧间隔分布 —— 判断有没有掉帧的**真正判据** */
        val frameStats: BenchHarness.FrameStats,
        /** 显示值真的变了的帧占比 —— 判断"动得顺不顺"的判据（v1.10.4） */
        val motionRatio: Double,
        val motionMoved: Long
    ) {
        fun oneLine(): String =
            "label=%s gauges=%d frames=%d fps=%.1f drawMs=%.2f peakUs=%.0f animating=%d"
                .format(label, gauges, frames, fps, drawMs, peakUs, animating)
    }
}
