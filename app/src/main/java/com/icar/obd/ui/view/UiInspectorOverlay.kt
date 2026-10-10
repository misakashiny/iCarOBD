package com.icar.obd.ui.view

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.icar.obd.data.UiInspectorInfo
import com.icar.obd.data.UiInspectorInfo.InspectorSnapshot

/**
 * **控件检视器**的浮层本体（v1.20.14）。
 *
 * 规格：`docs/下一步-控件检视器.md`。一句话 ——
 * **开启后挂一个悬浮窗；点任意控件，悬浮窗显示它的类型 / ID / 样式。只看不改。**
 *
 * ## 它做三件事
 *
 * 1. **悬浮面板**：挂 `android.R.id.content` 的 `WRAP_CONTENT` 浮层，可拖动、长按复制；
 * 2. **命中解析**：从坐标出发自己遍历 View 树，找最上层可见、且包含该点的控件
 *    （规格 §6 的**方向 A** —— 复用的正是被撤掉那版全局缩放实现"遍历 View 树"的思路）；
 * 3. **描边高亮**：被点中的控件画一圈亮边（规格 §7 判据 4）。
 *
 * ## ⚠️ 四条硬约束（规格 §4，违反就是 bug）
 *
 * ### ① 只在检视模式抢触摸 —— 本类**不消费任何触摸**
 *
 * 谁消费由宿主决定：`MainActivity.dispatchTouchEvent` 里"检视开着 → 消费并调 [inspect]"。
 * 本类**不注册任何全局触摸监听** —— 所以平时（没开检视）它对触摸是**完全不存在**的，
 * 画布横滑与编辑态拖拽一点都碰不到它（规格 §4.1，v1.20.4 的把手就栽在"总抢手势"上）。
 *
 * ### ② 不改任何布局
 *
 * 面板与高亮都是 `android.R.id.content` 的**浮层**，`activity_main.xml` /
 * `fragment_dash.xml` **一个字没动**（规格 §4.2）。
 * 高亮那一层更是**永远 `MATCH_PARENT`**：命中的矩形只走 `invalidate()` 重画，
 * 不碰 `layoutParams` —— 也就**不会触发一次 `requestLayout`**
 * （v1.20.12 那个「画布 0×0」的触发条件就是布局重排）。
 *
 * ### ③ 不盖画布 / 与现有浮层错开
 *
 * 默认位置**左下角**：灵动岛（顶部居中）与监听警示条（顶部）都在上面，够不着（规格 §4.4）；
 * 面板本身可拖动，且宽度被夹到屏幕宽度的 85% 以内。
 *
 * ### ④ 出口要明显
 *
 * 右上角一个 `×`（回调 [onRequestClose]）+ 设置页那个开关。
 * 关掉 = 浮层整个移除，触摸立刻恢复（规格 §4.5）。
 *
 * ## 只看不改
 *
 * 本类**没有任何一行**去改被检视控件的属性（规格 §8）。它只读 + 画自己的浮层。
 * 仪表盘的自绘区（`BaseGaugeView` / `DashGridOverlayView`）**会明说**不是控件
 * —— 免得用户以为"点了表盘没反应 = 坏了"（规格 §8 最后一条）。
 */
class UiInspectorOverlay(
    private val ctx: Context,
    /** 用户点了面板右上角的 `×` —— 由宿主负责落盘 + 收起（宿主是**唯一**的开关写者） */
    private val onRequestClose: () -> Unit = {},
) {

    private val main = Handler(Looper.getMainLooper())

    private var host: ViewGroup? = null
    private var panel: LinearLayout? = null
    private var highlight: HighlightView? = null

    private var tvType: TextView? = null
    private var tvId: TextView? = null
    private var tvBody: TextView? = null

    /** 最近一次渲染出的行（长按复制用）。没检视过就是空 */
    private var lastLines: List<String> = emptyList()

    /** 反射找 `mResourceId` 的结果缓存（按类）—— 见 [backgroundResName] */
    private val resIdFieldCache = HashMap<Class<*>, java.lang.reflect.Field?>()

    /** 浮层是否挂着 */
    val isShowing: Boolean get() = panel != null

    // ------------------------------------------------------------ 挂 / 摘

    /**
     * 挂上浮层。**幂等**，可以每次 `onResume` 与每秒的 ticker 各调一次
     * （与 `MonitorWarnBar.sync` / `IslandNotice.attach` 同一套写法）。
     */
    fun show(h: ViewGroup) {
        if (host !== h) {
            // 宿主变了（旋转重建 / 换 Activity）：旧浮层已经随着旧 content 一起没了
            panel = null
            highlight = null
            host = h
        }
        if (panel != null) return

        val hl = HighlightView(ctx)
        h.addView(
            hl,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        highlight = hl

        val p = buildPanel()
        val lp = FrameLayout.LayoutParams(panelWidthPx(), ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.gravity = Gravity.TOP or Gravity.START
        // 先给一个"左下角"的初始值；量完真实高度后在 post 里落到贴底
        lp.leftMargin = dp(MARGIN_DP)
        lp.topMargin = dp(MARGIN_DP)
        h.addView(p, lp)
        panel = p
        // 面板高度要等布局完才知道 —— post 一次落位（**不是**在 layout 里改 layoutParams，
        // 那是 v1.20.12 的坑：layout 期间 addView 的子 View 永远不会被 measure）
        p.post { placeDefault() }

        render("控件检视", "", listOf("点屏幕上任意控件查看它的信息"))
    }

    /** 摘掉浮层（触摸立刻恢复正常）。幂等 */
    fun hide() {
        main.removeCallbacks(longPress)
        panel?.let { v -> (v.parent as? ViewGroup)?.removeView(v) }
        highlight?.let { v -> (v.parent as? ViewGroup)?.removeView(v) }
        panel = null
        highlight = null
        tvType = null
        tvId = null
        tvBody = null
        lastLines = emptyList()
    }

    /** Activity 销毁时调：停掉长按计时，别让 Handler 抓着旧 content */
    fun detach() {
        main.removeCallbacks(longPress)
        panel = null
        highlight = null
        host = null
        lastLines = emptyList()
    }

    // ------------------------------------------------------------ 给宿主用

    /**
     * 这一下是不是落在**浮层自己**身上（面板）。
     *
     * 宿主据此决定"交给浮层（拖动 / 长按 / ×）"还是"当成检视点击"——
     * 规格 §6 明确要求处理"点悬浮窗不应被当成点控件"。
     */
    fun isOnPanel(rawX: Float, rawY: Float): Boolean {
        val p = panel ?: return false
        if (p.visibility != View.VISIBLE || p.width <= 0) return false
        val loc = IntArray(2)
        p.getLocationOnScreen(loc)
        return rawX >= loc[0] && rawX < loc[0] + p.width &&
            rawY >= loc[1] && rawY < loc[1] + p.height
    }

    /**
     * 检视屏幕坐标 `(rawX, rawY)` 处的控件 —— **宿主在检视模式下消费触摸时调它**。
     *
     * 传的是 `MotionEvent.rawX/rawY`（屏幕坐标）：面板、警示条、导航栏都在
     * `android.R.id.content` 里各占一块，用**窗口局部坐标**会在系统栏显示/隐藏时错位，
     * 屏幕坐标没有这个问题。
     */
    fun inspect(rawX: Float, rawY: Float) {
        val h = host ?: return
        val hit = hitTest(h, rawX, rawY)
        if (hit == null) {
            highlight?.setTarget(null)
            render(UiInspectorInfo.NO_HIT, "", listOf("这里是空白区（没有控件）"))
            return
        }
        highlight?.setTarget(rectOf(hit))
        val snap = snapshotOf(hit, h)
        render(snap.typeName, UiInspectorInfo.idLine(snap.idEntry), UiInspectorInfo.renderBody(snap))
    }

    // ------------------------------------------------------------ 命中解析

    /**
     * 找"最上层可见、且包含该点"的控件（规格 §6 方向 A）。
     *
     * 从**后往前**遍历子 View（后加的在上层，与绘制顺序一致），
     * 命中了就往下钻 —— 钻到底返回**最深的那一个**：用户点的是"那个按钮"，
     * 不是"装着按钮的那张卡片"。卡片本身也点得到（点它的空白处），
     * 这时显示的是容器的信息，同样有用（能看出层级与 id）。
     *
     * 浮层自己（面板 / 高亮层）**必须排除**，否则点哪儿都命中高亮层。
     */
    private fun hitTest(root: ViewGroup, sx: Float, sy: Float): View? {
        for (i in root.childCount - 1 downTo 0) {
            val c = root.getChildAt(i)
            if (c.visibility != View.VISIBLE) continue
            if (c === panel || c === highlight) continue
            if (c.width <= 0 || c.height <= 0) continue
            if (!containsPoint(c, sx, sy)) continue
            if (c is ViewGroup) {
                val deeper = hitTest(c, sx, sy)
                if (deeper != null) return deeper
            }
            return c
        }
        return null
    }

    /**
     * 点是否落在控件内（**屏幕坐标**）。
     *
     * 用 `getLocationOnScreen` 而不是 `left/top` 一路加：导航栏收起走的是
     * `translationX`（见 `MainActivity.setRailVisible`），滚动容器还有 `scrollY` ——
     * 自己算偏移迟早会漏一项，而 `getLocationOnScreen` 把这些**全都算进去了**。
     */
    private fun containsPoint(v: View, sx: Float, sy: Float): Boolean {
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        return sx >= loc[0] && sx < loc[0] + v.width && sy >= loc[1] && sy < loc[1] + v.height
    }

    /** 控件在**高亮层坐标系**里的矩形（两层都挂在 content 上，差一个 content 原点） */
    private fun rectOf(v: View): Rect {
        val hl = highlight
        val base = IntArray(2)
        (hl ?: v).getLocationOnScreen(base)
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        val l = loc[0] - base[0]
        val t = loc[1] - base[1]
        return Rect(l, t, l + v.width, t + v.height)
    }

    // ------------------------------------------------------------ 读 View

    /**
     * 把一个 View 读成 [InspectorSnapshot]（**只读**，不改它任何属性）。
     *
     * ⚠️ 拿不到的字段一律留 `null`，由 [UiInspectorInfo] 显示"（无）"——
     * **不编**（规格 §3）。背景的 `getResourceName` 是最常失败的一个
     * （`ColorDrawable` / 代码 new 的 `GradientDrawable` 都没有资源名），
     * 那时退化成类名，比"（无）"有用。
     */
    private fun snapshotOf(v: View, root: ViewGroup): InspectorSnapshot {
        val dm = ctx.resources.displayMetrics
        val lp = v.layoutParams
        val mlp = lp as? ViewGroup.MarginLayoutParams
        val tv = v as? TextView
        val bg = v.background
        val bgRes = backgroundResName(v, bg)

        // id → **资源名**（规格 §5 的命根子）。
        // 拿不到资源名时给 null（显示"（无 id）"）而不是那个数字：
        // 用户要的是能拿去搜 `UI样式与排版总表.md` 的名字，数字搜不到任何东西。
        val idEntry = if (v.id == View.NO_ID) null
        else runCatching { v.resources.getResourceEntryName(v.id) }.getOrNull()

        return InspectorSnapshot(
            typeName = v.javaClass.simpleName,
            idEntry = idEntry,
            widthPx = v.width,
            heightPx = v.height,
            declaredW = lp?.width ?: ViewGroup.LayoutParams.WRAP_CONTENT,
            declaredH = lp?.height ?: ViewGroup.LayoutParams.WRAP_CONTENT,
            margin = if (mlp == null) listOf(0, 0, 0, 0)
            else listOf(mlp.leftMargin, mlp.topMargin, mlp.rightMargin, mlp.bottomMargin),
            padding = listOf(
                v.paddingLeft, v.paddingTop, v.paddingRight, v.paddingBottom
            ),
            textSizePx = tv?.textSize,
            textColor = tv?.currentTextColor,
            bgResName = bgRes,
            bgClassName = bg?.javaClass?.simpleName,
            visibility = v.visibility,
            enabled = v.isEnabled,
            chain = chainOf(v, root),
            weight = (lp as? LinearLayout.LayoutParams)?.weight,
            gravityText = gravityTextOf(lp),
            maxWidthPx = (v as? MaxWidthCapable)?.maxWidthPx,
            // 仪表盘的自绘区：里面的刻度/指针/数值都是 `onDraw` 画的，**不是 View**（规格 §8）
            selfDrawn = v is BaseGaugeView || v is DashGridOverlayView,
            density = dm.density,
            scaledDensity = spPerPx(dm),
        )
    }

    /**
     * 背景的**资源名**（`@drawable/bg_card` 那种）。
     *
     * ## ⚠️ 为什么需要反射（而规格 §6 已经预告了退化成类名）
     *
     * `Resources.getResourceName(int)` 要的是**资源 id**，而 `View.getBackground()`
     * 给的是一个**已经 inflate 好的 `Drawable` 对象** —— 公开 API 里**没有**
     * "这个 Drawable 是哪个资源"这条路（AOSP 把它记在私有的 `mResourceId` 上）。
     *
     * 所以这里做两件事：
     *  1. **尽力而为**：反射找 `mResourceId`（先看 Drawable 自己，再看它的
     *     `ConstantState` —— 不同 Drawable 子类把它记在两处之一）。找到就是
     *     `@drawable/bg_card`，这正是用户拿去搜样式总表要的东西。
     *  2. **找不到就返回 `null`** → 面板显示**类名**（`GradientDrawable`），
     *     并标"（无资源名）"。**绝不编一个看起来像资源名的假名字**
     *     （规格 §3：拿不到就明说"（无）"）。
     *
     * 反射结果**按类缓存**：一次触摸只碰几个 Drawable，但同一个类会反复出现。
     * 全部包在 `runCatching` 里 —— 隐藏 API 在不同 ROM 上表现不一（可能抛
     * `NoSuchFieldException`，也可能因为非 SDK 接口限制而失败），
     * **失败只是少一行信息，绝不能让检视器崩掉**。
     */
    private fun backgroundResName(v: View, bg: android.graphics.drawable.Drawable?): String? {
        if (bg == null) return null
        return runCatching {
            var id = resIdOf(bg)
            if (id == 0) id = resIdOf(bg.constantState)
            if (id == 0) null else v.resources.getResourceName(id)
        }.getOrNull()
    }

    /** 反射读一个对象上的 `mResourceId`；找不到（或读不出）返回 0 */
    private fun resIdOf(o: Any?): Int {
        if (o == null) return 0
        val f = resIdFieldCache.getOrPut(o.javaClass) { findResIdField(o.javaClass) } ?: return 0
        return runCatching { f.getInt(o) }.getOrDefault(0)
    }

    /** 在类（及其父类）上找 `mResourceId`。找不到返回 `null`（缓存下来，别每次都反射） */
    private fun findResIdField(c: Class<*>): java.lang.reflect.Field? {
        var k: Class<*>? = c
        while (k != null && k != Any::class.java) {
            val f = runCatching { k.getDeclaredField("mResourceId") }.getOrNull()
            if (f != null) return runCatching { f.isAccessible = true; f }.getOrNull()
            k = k.superclass
        }
        return null
    }

    /**
     * 父链：**从根到该控件**（含它自己）。规格 §3 的"层级"。
     * 到 [root]（`android.R.id.content`）为止 —— 再往上（`DecorView` 那一串）
     * 每个控件都一样，写出来只是噪声。
     */
    private fun chainOf(v: View, root: ViewGroup): List<String> {
        val names = ArrayList<String>(8)
        var cur: View? = v
        while (cur != null) {
            names += cur.javaClass.simpleName
            if (cur === root) break
            val p = cur.parent
            cur = if (p is View) p else null
        }
        names.reverse()
        return names
    }

    /**
     * `layoutParams.gravity` → 人话（`center_v|right`）。
     *
     * 解码放在这里（UI 层）而不是 `data/UiInspectorInfo.kt`：`Gravity` 是 Android 类型，
     * 放进去那份纯函数就跑不了 JVM 单测了。默认值 `-1`（UNSPECIFIED）返回 `null`
     * → 那一行**整个不出现**（没设过 gravity 是常态，写一行"gravity（无）"只是噪声）。
     */
    private fun gravityTextOf(lp: ViewGroup.LayoutParams?): String? {
        val g = when (lp) {
            is FrameLayout.LayoutParams -> lp.gravity
            is LinearLayout.LayoutParams -> lp.gravity
            else -> -1
        }
        if (g < 0) return null
        val parts = ArrayList<String>(4)
        when (g and Gravity.HORIZONTAL_GRAVITY_MASK) {
            Gravity.LEFT -> parts += "left"
            Gravity.RIGHT -> parts += "right"
            Gravity.CENTER_HORIZONTAL -> parts += "center_h"
        }
        when (g and Gravity.VERTICAL_GRAVITY_MASK) {
            Gravity.TOP -> parts += "top"
            Gravity.BOTTOM -> parts += "bottom"
            Gravity.CENTER_VERTICAL -> parts += "center_v"
        }
        if (g and Gravity.FILL_HORIZONTAL != 0) parts += "fill_h"
        if (g and Gravity.FILL_VERTICAL != 0) parts += "fill_v"
        return if (parts.isEmpty()) null else parts.joinToString("|")
    }

    // ------------------------------------------------------------ 面板

    private fun buildPanel(): LinearLayout {
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(10).toFloat()
                // 半透明（规格 §2 要求）——但要比灵动岛实一点：这一屏全是小字
                setColor(0xE60F141C.toInt())
                setStroke(dp(1), 0x6600D8FF.toInt())
            }
            val ph = dp(10)
            val pv = dp(8)
            setPadding(ph, pv, ph, pv)
            elevation = dp(12).toFloat()
            isClickable = true      // 拖动与长按要能拿到触摸（见 setOnTouchListener）
            isFocusable = false
        }

        // ---- 标题行：类型 + 关闭 ----
        val head = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val t = TextView(ctx).apply {
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(ACCENT)
            maxLines = 1
        }
        tvType = t
        head.addView(t, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val close = TextView(ctx).apply {
            text = "×"
            textSize = 17f
            setTextColor(0xFF9AA8BC.toInt())
            gravity = Gravity.CENTER
            setPadding(dp(10), 0, dp(2), 0)
            contentDescription = "关闭控件检视"
            isClickable = true
            setOnClickListener { onRequestClose() }
        }
        head.addView(close)
        root.addView(head)

        // ---- id（资源名，黄色：这是用户要抄走的那一行）----
        val idv = TextView(ctx).apply {
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setTextColor(0xFFFFD400.toInt())
            maxLines = 2
        }
        tvId = idv
        root.addView(idv)

        // ---- 正文 ----
        val body = TextView(ctx).apply {
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextColor(0xFFE8EEF7.toInt())
            setLineSpacing(dp(2).toFloat(), 1.1f)
        }
        tvBody = body
        root.addView(body)

        // ---- 底部提示（固定，不随控件变）----
        // 第一行就是规格 §5 要的那句：**id 拿去哪儿搜**。这是这个功能真正的价值所在
        // （id → `UI样式与排版总表.md` → `文件:行` + 全部样式值 + "改了会出事"的坑）。
        root.addView(TextView(ctx).apply {
            text = UiInspectorInfo.HINT_DOC + "\n" + UiInspectorInfo.HINT_OPS
            textSize = 10f
            setTextColor(0xFF5F6E85.toInt())
            setPadding(0, dp(4), 0, 0)
        })

        installDragAndLongPress(root)
        return root
    }

    /** 面板内容更新。`title` 走标题行，`idText` 走黄色那行，`bodyLines` 走正文 */
    private fun render(title: String, idText: String, bodyLines: List<String>) {
        lastLines = (listOf(title, idText) + bodyLines).filter { it.isNotBlank() }
        tvType?.text = title
        tvId?.text = idText
        tvId?.visibility = if (idText.isBlank()) View.GONE else View.VISIBLE
        tvBody?.text = bodyLines.joinToString("\n")
    }

    // ------------------------------------------------------------ 拖动 / 长按

    private var downRawX = 0f
    private var downRawY = 0f
    private var startLeft = 0
    private var startTop = 0
    private var moved = false

    private val longPress = Runnable { copyToClipboard() }

    /**
     * 拖动 + 长按复制。
     *
     * ⚠️ 监听器**挂在面板自己身上**（不是全局）：面板的触摸由宿主
     * `MainActivity` 原样放行（见 [isOnPanel]），所以这里拿到的是**只有面板范围内**的触摸。
     * 面板一旦被摘掉，监听器跟着一起没了 —— 平时它对触摸零影响（约束 ①）。
     */
    private fun installDragAndLongPress(p: LinearLayout) {
        val slop = ViewConfiguration.get(ctx).scaledTouchSlop
        p.setOnTouchListener { _, e ->
            val lp = p.layoutParams as? FrameLayout.LayoutParams ?: return@setOnTouchListener false
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    downRawX = e.rawX
                    downRawY = e.rawY
                    startLeft = lp.leftMargin
                    startTop = lp.topMargin
                    moved = false
                    main.removeCallbacks(longPress)
                    main.postDelayed(longPress, LONG_PRESS_MS)
                    true
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downRawX
                    val dy = e.rawY - downRawY
                    // 一超过触摸阈值就算"在拖"，长按立刻取消 ——
                    // 否则想挪一下位置会顺手把信息复制进剪贴板
                    if (!moved && kotlin.math.abs(dx) + kotlin.math.abs(dy) > slop) {
                        moved = true
                        main.removeCallbacks(longPress)
                    }
                    if (moved) {
                        val dm = ctx.resources.displayMetrics
                        lp.leftMargin = (startLeft + dx.toInt())
                            .coerceIn(0, (dm.widthPixels - p.width).coerceAtLeast(0))
                        lp.topMargin = (startTop + dy.toInt())
                            .coerceIn(0, (dm.heightPixels - p.height).coerceAtLeast(0))
                        p.requestLayout()
                    }
                    true
                }
                android.view.MotionEvent.ACTION_UP,
                android.view.MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(longPress)
                    true
                }
                else -> false
            }
        }
    }

    /** 落到默认位置：**左下角**（躲开顶部的灵动岛与监听警示条，规格 §4.4） */
    private fun placeDefault() {
        val p = panel ?: return
        val lp = p.layoutParams as? FrameLayout.LayoutParams ?: return
        if (p.height <= 0) return
        val dm = ctx.resources.displayMetrics
        lp.leftMargin = dp(MARGIN_DP)
        lp.topMargin = (dm.heightPixels - p.height - dp(MARGIN_DP)).coerceAtLeast(dp(MARGIN_DP))
        p.layoutParams = lp
    }

    /** 长按 → 全部信息进剪贴板（规格 §2 / §7 判据 8） */
    private fun copyToClipboard() {
        if (lastLines.isEmpty()) return
        val text = UiInspectorInfo.clipboardText(lastLines, clipboardHeader())
        val ok = runCatching {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("控件检视", text))
        }.isSuccess
        if (!ok) {
            toast("复制失败（剪贴板不可用）")
            return
        }
        // API 33+ 系统自己会弹一个"已复制"的浮标，再弹一条就是两条 —— 只在这以下自己弹
        if (Build.VERSION.SDK_INT < 33) toast("控件信息已复制")
    }

    /**
     * 复制文本的头一行。
     *
     * 为什么要有它：粘给作者时**上下文会丢** —— 一串裸的
     * `Button / btnGestures / 尺寸…` 看不出是从哪个版本、哪台机器复制的。
     */
    private fun clipboardHeader(): String {
        val ts = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
            .format(java.util.Date())
        return "控件检视 · ${com.icar.obd.BuildConfig.VERSION_NAME} · $ts"
    }

    private fun toast(msg: String) {
        runCatching { Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show() }
    }

    // ------------------------------------------------------------ 尺寸工具

    private fun dp(v: Int): Int = (v * ctx.resources.displayMetrics.density).toInt()

    /**
     * **1sp 等于多少像素**（= 老的 `DisplayMetrics.scaledDensity`）。
     *
     * 用 `TypedValue.applyDimension` 而不是直接读 `scaledDensity`：
     * 后者在 API 34 起被标记为废弃（编译告警），而前者是官方推荐的等价算法，
     * 且**认用户改过的系统字号**（`fontScale`）—— 面板显示的 sp 与系统设置一致。
     * 万一算出 0（理论上不会），退回 `density`，**不让面板显示"Infinity sp"**。
     */
    private fun spPerPx(dm: android.util.DisplayMetrics): Float {
        val v = android.util.TypedValue.applyDimension(
            android.util.TypedValue.COMPLEX_UNIT_SP, 1f, dm
        )
        return if (v > 0f) v else dm.density
    }

    /** 面板宽度：320dp 封顶，窄屏再夹到 85% —— 撑宽了会盖住画布（约束 ③） */
    private fun panelWidthPx(): Int {
        val dm = ctx.resources.displayMetrics
        return minOf(dp(PANEL_W_DP), (dm.widthPixels * 0.85f).toInt()).coerceAtLeast(dp(180))
    }

    companion object {
        /**
         * **检视模式开着没有** —— 进程内状态，**刻意不落盘**（规格 §2 / §4.5）。
         *
         * ## 为什么不放进 `Store.Settings`（本项目其它开关都在那儿）
         *
         * `Store.Settings` 是**落盘 schema**（`settingsToJson` / `applySettingsJson` +
         * 备份导出导入都过它）。而这个开关一开，App 就**把全部触摸消费掉**
         * （只剩浮窗自己可点）——
         *
         * - 如果它跟着 `settings.json` 活到下一次启动，用户会遇到：
         *   打开 App → 点哪儿都没反应 → 以为**装坏了**；
         * - 而"每次开 App 手动点一下开关"的代价，只是多点一下。
         *
         * 所以它是**进程内**的：旋屏重建（同一个进程）保持，
         * 杀进程 / 重启 / 从备份恢复设置之后一律回到 `false`。
         *
         * 放进落盘 schema 还有一个具体的坏处：**它会被备份导出**，
         * 于是"在 A 机器上开过检视 → 备份 → 恢复到 B 机器"会让 B 机器一开机就不响应触摸。
         *
         * ## 为什么是 `@Volatile`
         *
         * 读它的是 `MainActivity.dispatchTouchEvent`（主线程），
         * 写它的是设置页（也是主线程）—— 但 `Store` 的加载发生在服务线程，
         * 而这类"跨线程读的进程级布尔"是本项目**踩过的坑**
         * （`ObdController.pendingGotoDash` 就是同一类）。加一个 `@Volatile` 是零成本的。
         */
        @Volatile
        var enabled: Boolean = false

        /** 面板宽度上限（dp） */
        private const val PANEL_W_DP = 320

        /** 浮层距屏幕边的默认留白（dp） */
        private const val MARGIN_DP = 12

        /** 长按判定（毫秒）—— 与系统的 500ms 一致 */
        private const val LONG_PRESS_MS = 500L

        private val ACCENT = 0xFF00D8FF.toInt()
    }

    /**
     * **被点中控件的描边高亮**（规格 §7 判据 4）。
     *
     * ## 为什么是"整屏一层 + 只重画"而不是"一个跟着控件走的小 View"
     *
     * 小 View 每次命中都要改 `layoutParams` → 触发父容器一次 `requestLayout`
     * → `android.R.id.content` 下所有子 View 重新量一遍。而这一层是**永远
     * `MATCH_PARENT`**：命中矩形只走 `invalidate()`，**一次布局都不触发**。
     * 画布因此不可能因为"点了一下控件"而重排（约束 ②，判据 6）。
     *
     * 它 `isClickable = false`：不抢触摸（约束 ①）。
     */
    private class HighlightView(ctx: Context) : View(ctx) {

        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = 0xFF00D8FF.toInt()
        }
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = 0x1F00D8FF
        }
        private val rect = Rect()
        private var has = false

        init {
            isClickable = false
            isFocusable = false
            setWillNotDraw(false)
        }

        fun setTarget(r: Rect?) {
            has = r != null
            if (r != null) rect.set(r) else rect.setEmpty()
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            if (!has || rect.isEmpty) return
            stroke.strokeWidth = (2 * resources.displayMetrics.density).coerceAtLeast(2f)
            canvas.drawRect(rect, fill)
            canvas.drawRect(rect, stroke)
        }
    }
}
