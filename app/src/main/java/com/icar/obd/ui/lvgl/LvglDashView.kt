package com.icar.obd.ui.lvgl

import android.content.Context
import android.graphics.PixelFormat
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.icar.obd.data.AppLog
import com.icar.obd.obd.VehicleBus

/**
 * 用 **LVGL** 渲染的仪表盘（混合架构里的「那一屏」）。
 *
 * ## 为什么只有仪表盘走 LVGL
 *
 * LVGL 渲到一个不透明 Surface 上，里面**没有 Android View**：没有 `RecyclerView`、
 * 没有 `EditText`、没有系统对话框，中文输入法也要自己桥接。
 * 而配置类界面（PID 编辑、公式、JSON 导入）恰恰全是文本输入。
 *
 * 仪表盘则相反：纯自绘、无文本输入、全屏 —— 是 LVGL 的理想场景。
 * 所以只把这一屏交出去，其余继续用 Android View。
 *
 * ## 数值怎么进去
 *
 * **推**，不是拉：挂 [VehicleBus.addValueListener]，值一到就转给 C 侧。
 * 这样不用轮询，也不占主线程。
 *
 * ## 注意
 *
 * 原生库加载失败**不会崩**，而是记日志并留空屏 —— 否则一个 ABI 没编出来
 * 就会让整个 App 起不来，代价太大。
 */
class LvglDashView @JvmOverloads constructor(
    ctx: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0
) : SurfaceView(ctx, attrs, defStyle), SurfaceHolder.Callback {

    @Volatile
    private var ready = false

    /** 最近一次应用的主题，自检测完要恢复回去 */
    private var lastTheme: com.icar.obd.ui.view.GaugeTheme? = null

    /** 最近一次下发的仪表配置。Surface 还没建好时先存着，建好后再补下 */
    private var pendingItems: List<com.icar.obd.data.GaugeItem>? = null

    private var unregister: (() -> Unit)? = null

    /**
     * 建好 3 秒后打一条自检日志。
     *
     * 自动化验证看不了图，`selfTest()` 里的 `ink`（非背景像素占比）是判断
     * 「LVGL 到底有没有把控件画出来」最直接的证据 —— 全是 0 就说明只画了背景。
     */
    private val selfCheck = Runnable {
        if (ready) {
            AppLog.i(AppLog.M_UI, "LVGL 自检", selfTest())
            // 文字版截图：一行一个屏幕行，方便判断控件到底画在哪 / 有没有画
            val grid = runCatching { LvglBridge.nativeProbeGrid() }.getOrDefault("(失败)")
            grid.trim().split("\n").forEachIndexed { i, row ->
                AppLog.i(AppLog.M_UI, "LVGL 画面 r$i", row.trim())
            }
            // 顺序很重要：先验字节序（读真实屏幕），再验数值驱动（读帧缓冲）
            captureAndVerify("初始")
            postDelayed(driveTest, 1200)
        }
    }

    /**
     * 数值驱动测试：把三个表先压到 0，再顶到满量程，比较整屏哈希。
     *
     * 这是验证「`VehicleBus` → `nativeSetValue` → 指针」这条路的**唯一**办法 ——
     * 不依赖连车，也不依赖模拟器（之前想串「开模拟器 + 切 LVGL」结果导航没串起来）。
     */
    private val driveTest = Runnable {
        if (!ready) return@Runnable
        LvglBridge.nativeSetValue("std_0C", 0f)
        LvglBridge.nativeSetValue("std_0D", 0f)
        LvglBridge.nativeSetValue("std_05", 0f)
        postDelayed({
            val h0 = LvglBridge.nativeProbeHash()
            LvglBridge.nativeSetValue("std_0C", 8000f)
            LvglBridge.nativeSetValue("std_0D", 240f)
            LvglBridge.nativeSetValue("std_05", 120f)
            postDelayed({
                val h1 = LvglBridge.nativeProbeHash()
                AppLog.i(
                    AppLog.M_UI, "LVGL 驱动测试",
                    "零位=%08X 满量程=%08X → %s".format(
                        h0, h1, if (h0 != h1) "指针随数值变化 ✓" else "画面完全没变 ✗"
                    )
                )
                AppLog.i(AppLog.M_UI, "LVGL 自检(驱动后)", selfTest())
                // 驱动后立刻再采一次画面：排查「满量程后屏幕底色变了」这个反常现象
                runCatching { LvglBridge.nativeProbeGrid() }
                captureAndVerify("满量程")
                postDelayed({ verifyThemeMapping() }, 1200)
            }, 1500)
        }, 1500)
    }

    /**
     * 用 `PixelCopy` 读回**真正显示在屏幕上**的像素。
     *
     * 为什么不能只读 C 侧的帧缓冲：那是 LVGL 画完的原始数据，
     * R/B 交换发生在它**之后** —— 读它等于没测到交换。
     *
     * 判据：屏幕背景设的是 `0x0A0C10`（R=0A ≠ B=10），
     * 所以交换正确时读回 `FF0A0C10`，交换反了会读回 `FF100C0A`。
     */
    fun captureAndVerify(tag: String) {
        val w = width
        val h = height
        if (w <= 0 || h <= 0) return
        val bmp = runCatching {
            android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
        }.getOrNull() ?: return

        runCatching {
            android.view.PixelCopy.request(this, bmp, { result ->
                if (result != android.view.PixelCopy.SUCCESS) {
                    AppLog.w(AppLog.M_UI, "LVGL 屏幕采样失败 $tag", "result=$result")
                    return@request
                }
                val pts = listOf(4 to 4, w / 2 to 4, w / 2 to h / 2, 8 to h / 2, w / 2 to h - 4)
                val sb = StringBuilder()
                pts.forEach { (x, y) ->
                    val p = bmp.getPixel(x.coerceIn(0, w - 1), y.coerceIn(0, h - 1))
                    sb.append("($x,$y)=%08X ".format(p))
                }
                AppLog.i(AppLog.M_UI, "LVGL 屏幕采样 $tag", sb.toString().trim())
            }, android.os.Handler(android.os.Looper.getMainLooper()))
        }.onFailure {
            AppLog.w(AppLog.M_UI, "LVGL 屏幕采样异常 $tag", it.message ?: "")
        }
    }

    init {
        holder.addCallback(this)
        holder.setFormat(PixelFormat.RGBA_8888)
        isFocusable = false
        isClickable = true
    }

    override fun surfaceCreated(h: SurfaceHolder) {
        if (!LvglBridge.loaded) {
            AppLog.e(AppLog.M_UI, "LVGL 原生库未加载，仪表盘留空", LvglBridge.loadError)
            return
        }
        val frame = h.surfaceFrame
        val w = if (width > 0) width else frame.width()
        val ht = if (height > 0) height else frame.height()
        ready = runCatching { LvglBridge.nativeCreate(h.surface, w, ht) }.getOrDefault(false)
        AppLog.i(AppLog.M_UI, "LVGL Surface 已创建", "ok=$ready ${w}x$ht")
        if (ready) {
            startPushing()
            // 顺序：先网格（它读的是全局设置），再布局（布局里会建网格层）
            pushGrid()
            pendingItems?.let { applyLayout(it) }
            postDelayed(selfCheck, 3000)
        }
    }

    /**
     * 下发参考线设置。
     *
     * 必须在 `buildLayout` **之前**调 —— 网格层是在建布局时创建的，
     * 创建时会读这份设置。Surface 没就绪时先记下，`surfaceCreated` 里补。
     */
    fun applyGrid() {
        if (!ready || !LvglBridge.loaded) return
        pushGrid()
    }

    private fun pushGrid() {
        if (!LvglBridge.loaded) return
        val s = com.icar.obd.data.Store.settings
        val density = resources.displayMetrics.density
        runCatching {
            LvglBridge.nativeSetGrid(
                s.gridEnabled, s.gridCols, s.gridRows, s.gridStyle, s.gridAlpha,
                (s.gridStrokeDp * density).toInt().coerceAtLeast(1)
            )
        }.onFailure {
            AppLog.w(AppLog.M_UI, "LVGL 设置参考线失败", it.message ?: "")
        }
    }

    override fun surfaceChanged(h: SurfaceHolder, format: Int, w: Int, h2: Int) {
        // 尺寸变化（旋转）目前靠重建 Surface 处理：surfaceDestroyed → surfaceCreated
        AppLog.d(AppLog.M_UI, "LVGL Surface 尺寸变化", "${w}x$h2")
    }

    override fun surfaceDestroyed(h: SurfaceHolder) {
        removeCallbacks(selfCheck)
        stopPushing()
        if (ready) {
            runCatching { LvglBridge.nativeDestroy() }
            ready = false
            AppLog.i(AppLog.M_UI, "LVGL Surface 已销毁")
        }
    }

    private fun startPushing() {
        if (unregister != null) return
        unregister = VehicleBus.addValueListener { v ->
            if (ready && v.ok) {
                runCatching { LvglBridge.nativeSetValue(v.pidId, v.value) }
            }
        }
        AppLog.i(AppLog.M_UI, "LVGL 数值推送已挂上")
    }

    /**
     * 下发整份仪表配置。
     *
     * 坐标沿用自由画布的**归一化 0..1**，由 C 侧乘屏幕尺寸 ——
     * 所以同一份配置在手机竖屏与平板横屏都成立，与 Android 引擎行为一致。
     *
     * Surface 还没建好时先存下来，`surfaceCreated` 里补下 ——
     * 否则「先 render 后建 Surface」的顺序下会一条仪表都没有。
     */
    fun buildLayout(items: List<com.icar.obd.data.GaugeItem>) {
        pendingItems = items
        if (!ready || !LvglBridge.loaded) return
        applyLayout(items)
    }

    private fun applyLayout(items: List<com.icar.obd.data.GaugeItem>) {        val n = items.size
        if (n == 0) return
        val pids = Array(n) { "" }
        val extras = Array(n) { "" }
        val units = Array(n) { "" }
        val styles = IntArray(n)
        val colors = IntArray(n)
        val ringStyles = IntArray(n)
        val ringSegs = IntArray(n)
        val metrics = FloatArray(n * 6)

        items.forEachIndexed { i, g ->
            pids[i] = g.pidId
            extras[i] = g.extraPids.joinToString(",")
            units[i] = com.icar.obd.data.Store.findPid(g.pidId)?.unit ?: ""
            styles[i] = g.style
            colors[i] = g.color
            ringStyles[i] = g.ringStyle
            ringSegs[i] = g.ringSegments
            val b = i * 6
            metrics[b] = g.minVal
            metrics[b + 1] = g.maxVal
            metrics[b + 2] = g.x
            metrics[b + 3] = g.y
            metrics[b + 4] = g.w
            metrics[b + 5] = g.h
        }

        val built = runCatching {
            LvglBridge.nativeBuildLayout(
                pids, extras, units, styles, colors, ringStyles, ringSegs, metrics
            )
        }.getOrDefault(-1)
        AppLog.i(AppLog.M_UI, "LVGL 布局已下发", "items=$n bindings=$built")
    }

    /**
     * 把主题推给 C 侧。
     *
     * Surface 建好之前调也有效（C 侧先存着，建 UI 时再用），
     * 所以 `DashFragment.render()` 可以无脑调，不用关心生命周期顺序。
     */
    fun applyTheme(theme: com.icar.obd.ui.view.GaugeTheme) {
        lastTheme = theme
        if (!LvglBridge.loaded) return
        runCatching {
            LvglBridge.nativeApplyTheme(
                theme.background, theme.surface, theme.surfaceEdge,
                theme.accent, theme.accentHot, theme.accentDim,
                theme.track, theme.tick, theme.value, theme.label,
                theme.cardRadiusDp, theme.cardStrokeDp, theme.strokeDp, theme.needleLengthRatio
            )
        }.onFailure {
            AppLog.w(AppLog.M_UI, "LVGL 应用主题失败", it.message ?: "")
        }
        // 主题变了 C 侧会清空重建，所以**紧接着把布局再下发一遍** ——
        // 否则换主题后仪表会全部消失，只剩一片底色。
        pendingItems?.let { if (ready) applyLayout(it) }
    }

    /**
     * 验证「主题 → LVGL 样式」这条路。
     *
     * 连续应用两个内置主题，读回各自的屏幕底色：不同就说明映射生效。
     * 测完**恢复用户自己的主题** —— 自检不该把用户的设置改掉。
     */
    private fun verifyThemeMapping() {
        if (!ready || !LvglBridge.loaded) return
        val all = runCatching { com.icar.obd.ui.view.GaugeTheme.builtIns() }.getOrDefault(emptyList())
        if (all.size < 2) return
        val a = all[0]
        val b = all[1]

        applyTheme(a)
        postDelayed({
            val hitsA = runCatching { LvglBridge.nativeCountColor(a.accent and 0xFFFFFF) }.getOrDefault(-1)
            applyTheme(b)
            postDelayed({
                // 换到 B 之后：A 的强调色应该基本消失，B 的强调色应该出现。
                // 用「颜色像素计数」而不是「读左上角当背景色」——
                // 卡片会盖住 (0,0)，那个假设在建了自由画布之后就不成立了。
                val leftA = runCatching { LvglBridge.nativeCountColor(a.accent and 0xFFFFFF) }.getOrDefault(-1)
                val hitsB = runCatching { LvglBridge.nativeCountColor(b.accent and 0xFFFFFF) }.getOrDefault(-1)
                AppLog.i(
                    AppLog.M_UI, "LVGL 主题映射验证",
                    "%s 强调%06X 命中%d  →  %s 强调%06X 命中%d（换后 %s 残留%d）  → %s".format(
                        a.title, a.accent and 0xFFFFFF, hitsA,
                        b.title, b.accent and 0xFFFFFF, hitsB,
                        a.title, leftA,
                        if (hitsA > 50 && hitsB > 50 && leftA < hitsA / 4) {
                            "主题切换生效 ✓"
                        } else {
                            "主题没生效 ✗"
                        }
                    )
                )
                lastTheme?.let { applyTheme(it) }
                postDelayed({ runBenchmark(5) }, 1500)
            }, 1500)
        }, 1500)
    }

    /**
     * 帧率基准。放在自检链**最后**跑 —— 它会全速占用渲染线程 5 秒，
     * 混在别的验证里会干扰结果。
     */
    fun runBenchmark(seconds: Int = 5) {
        if (!ready || !LvglBridge.loaded) return
        val fps = runCatching { LvglBridge.nativeBenchmark(seconds) }.getOrDefault(-1)
        AppLog.i(AppLog.M_UI, "LVGL 帧率基准", "${seconds}s 满负载 → $fps FPS（吞吐上限）")
    }

    private fun stopPushing() {
        unregister?.invoke()
        unregister = null
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!ready) return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE ->
                LvglBridge.nativeTouch(event.x.toInt(), event.y.toInt(), true)

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL ->
                LvglBridge.nativeTouch(event.x.toInt(), event.y.toInt(), false)
        }
        return true
    }

    /** 诊断信息，写日志 / 自动化验证用 */
    fun selfTest(): String =
        if (ready) runCatching { LvglBridge.nativeSelfTest() }.getOrDefault("(调用失败)")
        else "not-ready loaded=${LvglBridge.loaded} err=${LvglBridge.loadError}"

    /** 读回上一帧某点颜色（LVGL 序 `0xAARRGGBB`）。自动化验证用 */
    fun probePixel(x: Int, y: Int): Int =
        if (ready) runCatching { LvglBridge.nativeProbePixel(x, y) }.getOrDefault(0) else 0
}
