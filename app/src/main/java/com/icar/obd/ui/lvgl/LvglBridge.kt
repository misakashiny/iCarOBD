package com.icar.obd.ui.lvgl

import android.view.Surface

/**
 * LVGL 的 JNI 入口。
 *
 * 只做「把调用转过去」，不含任何业务逻辑 —— 业务在 [LvglDashView] 与 C 侧。
 *
 * ## 为什么库名不叫 lvgl
 *
 * 原生库名是 `libicarobd_lvgl.so`（见 `CMakeLists.txt` 的 `add_library`）。
 * 用带项目前缀的名字，将来若同时链接别的 LVGL 构建不会撞名。
 *
 * ## 线程约定
 *
 * 除 [nativeCreate] / [nativeDestroy] 外，其余方法都可以从任意线程调用 ——
 * C 侧用 `volatile` 变量传递触摸与数值，真正的渲染在 C 自己的线程里。
 */
object LvglBridge {

    @Volatile
    var loaded: Boolean = false
        private set

    /** 加载失败时的原因，供 UI 显示（比直接崩掉友好） */
    @Volatile
    var loadError: String = ""
        private set

    init {
        try {
            System.loadLibrary("icarobd_lvgl")
            loaded = true
        } catch (t: Throwable) {
            loadError = t.message ?: t.toString()
            loaded = false
        }
    }

    external fun nativeCreate(surface: Surface, width: Int, height: Int): Boolean

    external fun nativeDestroy()

    external fun nativeTouch(x: Int, y: Int, down: Boolean)

    external fun nativeSetValue(pidId: String, value: Float)

    /**
     * 下发整份仪表配置（数量、样式、量程、位置、颜色）。
     *
     * 全是基本类型与数组，**没有 JSON** —— 语义由 Kotlin 侧的 `GaugeItem` 负责。
     *
     * @param metrics 每条 6 个：`min, max, x, y, w, h`
     *                （x/y/w/h 是**归一化 0..1**，与 Android 自由画布同一套坐标，
     *                由 C 侧乘屏幕尺寸 —— 所以手机竖屏与平板横屏共用一份配置）
     * @param colors  每条一个强调色；**负数 = 用主题 accent**
     * @return 建立成功的绑定条数；失败返回 -1
     */
    external fun nativeBuildLayout(
        pids: Array<String>, extras: Array<String>, units: Array<String>,
        styles: IntArray, colors: IntArray,
        ringStyles: IntArray, ringSegments: IntArray, metrics: FloatArray
    ): Int

    /**
     * 把主题推给 C 侧。
     *
     * 参数是**基本类型**而不是 JSON：语义由 `GaugeTheme` 在 Kotlin 侧解释，
     * C 侧只存值。这样原生代码不需要 JSON 解析器，也不会出现两边 schema 理解不一致
     * 却静默画错的情况。
     *
     * 在 `nativeCreate` **之前**调也有效 —— C 侧会先存下来，建 UI 时再用。
     */
    external fun nativeApplyTheme(
        background: Int, surface: Int, surfaceEdge: Int,
        accent: Int, accentBright: Int, accentDim: Int,
        track: Int, tick: Int, valueText: Int, labelText: Int,
        cardRadiusDp: Float, cardStrokeDp: Float, strokeDp: Float, needleRatio: Float
    )

    /** 读回上一帧某点的颜色（LVGL 序 `0xAARRGGBB`）。自动化验证用 */
    external fun nativeProbePixel(x: Int, y: Int): Int

    /** 诊断字符串：`inited=… size=… meters=… fps=…` */
    external fun nativeSelfTest(): String

    /** 整屏粗采样成 8×6 个颜色（文字版截图）。自动化验证用 */
    external fun nativeProbeGrid(): String

    /** 整屏内容哈希。判断「画面有没有变」比粗采样灵敏得多 */
    external fun nativeProbeHash(): Int

    /** 读回屏幕背景色（0xRRGGBB）。验证「主题 → LVGL」映射用 */
    external fun nativeProbeScreenBg(): Int

    /** 数画面里接近给定颜色的像素数。比读单个像素可靠得多，见 C 侧注释 */
    external fun nativeCountColor(rgb: Int): Int

    /**
     * 参考线（均匀线段覆盖层）。
     *
     * C 侧把网格层钉在**屏幕第一个子对象**的位置（z 序最底），所以不会盖住仪表。
     * 只重建网格层内部，不动仪表 —— 切密度/样式是即时的。
     *
     * @param style 0=实线 1=虚线 2=点线
     * @param alpha 0..255
     */
    external fun nativeSetGrid(
        enabled: Boolean, cols: Int, rows: Int,
        style: Int, alpha: Int, strokePx: Int
    )

    /**
     * 帧率基准：驱动全部绑定并强制立即重绘 N 秒，返回实测 FPS。
     *
     * 为什么需要它：没有车、没有模拟器时画面是静止的，`fps` 恒为 0，
     * **测不出渲染能力**。这个基准把「数据源」与「渲染能力」解耦 ——
     * 它回答的是「这块屏 + 这个软件渲染器，满负载下能画多少帧」。
     *
     * 注意它测的是**吞吐上限**（`lv_refr_now` 强制重绘，不等 LVGL 的刷新周期），
     * 所以数值会高于实际使用中的帧率，用于判断性能余量。
     */
    external fun nativeBenchmark(seconds: Int): Int
}
