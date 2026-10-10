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
import com.icar.obd.data.AppLog
import com.icar.obd.data.TreeWalkBudget
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
 *
 * ## v1.20.15：面板上加了「检视 开 / 暂停」开关（用户点名要的）
 *
 * 用户原话：「悬浮窗上面加个检视器的开关」。开关与 `×` 分工：
 *
 * | | 触摸 | 面板 | 怎么恢复 |
 * |---|---|---|---|
 * | **检视 开** | 被接管 | 在 | 点一下变「暂停」 |
 * | **检视 暂停** | **放行（App 正常用）** | **还在** | 点一下变「开」 |
 * | **`×`** | 放行 | **摘掉** | 只能回设置页重开 |
 *
 * ⚠️ 两条硬约束：
 * - **暂停时面板本体不许抢触摸**（[UiInspectorInfo.panelStealsTouch]）——
 *   只留开关与 `×` 两小块可点，否则会挡住画布横滑与编辑手势；
 * - **开关自己的点击不能被"检视消费"吃掉** —— 命中判定（[isOnPanel]）**先排除浮层自己**，
 *   宿主据此把这一次触摸交回 `super`，开关才收得到点击。
 *
 * ## v1.20.15：触摸路径上的加固（ANR 之后补的）
 *
 * 那一轮 ANR 的真根因在 [UiInspectorInfo.chainLine]（纯函数死循环），**不在这里**；
 * 但"在触摸路径上做无界遍历"本身是雷，所以一并加固：
 *
 * 1. **遍历有界**：[hitTest] 走 [TreeWalkBudget]（深度上限 / 节点数上限 / 按身份去重断环）；
 * 2. **便宜**：坐标查询复用同一个 `IntArray`，一次触摸不再按节点数分配数组；
 * 3. **异常兜底**：[inspect] 返回 `false` = 解析失败，**宿主据此放行这一次触摸** ——
 *    宁可漏检，不能卡死。
 */
class UiInspectorOverlay(
    private val ctx: Context,
    /** 用户点了面板右上角的 `×` —— 由宿主负责落盘 + 收起（宿主是**唯一**的开关写者） */
    private val onRequestClose: () -> Unit = {},
    /**
     * 用户拨了面板上的「检视 开 / 暂停」开关（v1.20.15）。
     *
     * 传的是**目标状态**：`true` = 暂停（放行触摸），`false` = 恢复接管。
     * 与 [onRequestClose] 一样，浮层**只上报意图**，状态由宿主写
     * （[UiInspectorOverlay.paused] 是唯一权威）—— 免得两处各写一份状态。
     */
    private val onRequestPause: (Boolean) -> Unit = {},
) {

    private val main = Handler(Looper.getMainLooper())

    private var host: ViewGroup? = null
    private var panel: LinearLayout? = null
    private var highlight: HighlightView? = null

    private var tvType: TextView? = null
    private var tvId: TextView? = null
    private var tvBody: TextView? = null

    /** 面板底部那行固定提示（v1.20.15：暂停时换文案） */
    private var tvHint: TextView? = null

    /** 面板上那个「检视 开 / 暂停」开关（v1.20.15） */
    private var toggle: TextView? = null

    /**
     * 坐标查询的**复用**数组。
     *
     * `getLocationOnScreen` 只是往这个数组里写两个 int，用完即弃 ——
     * 而一次触摸要查几十上百个节点，每个节点 new 一个 `IntArray(2)` 是纯浪费。
     * 只在主线程用（触摸路径），所以复用是安全的。
     */
    private val locTmp = IntArray(2)

    /** [rectOf] 要同时拿两个控件的位置，所以第二个复用数组 */
    private val baseTmp = IntArray(2)

    /**
     * 上一次**已经画到面板上**的暂停态。
     *
     * 宿主那个 1 秒的 ticker 会反复调 [setPaused]，而重画面板要新建 `GradientDrawable`、
     * 重设三段文案 —— 主线程上的纯浪费。`null` = 面板刚建好、什么都还没画。
     */
    private var appliedPaused: Boolean? = null

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
     *
     * ## ⚠️ v1.20.15：多一道"父容器还活着吗"的检查
     *
     * 原来只比 `host !== h`。但"宿主引用没变、浮层却被从父容器上摘掉了"是可能的
     * （Activity 重建、`content` 换了一茬、别处 `removeView`）——
     * 那时 `panel != null` 会让 `show()` 直接 `return`，
     * **浮层就永远挂不回去了**（用户看到的是"开着检视却什么都没有"）。
     * 现在多比一句 `panel?.parent !== h`：对不上就**先摘干净再重建**。
     */
    fun show(h: ViewGroup) {
        if (host !== h || panel?.parent !== h) {
            // 宿主变了（旋转重建 / 换 Activity），或浮层挂到了一个已经失效的父容器上
            // —— 旧的引用一律作废（旧 content 已经没了，removeView 也是安全的）
            hide()
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
        applyPausedToPanel()
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
        tvHint = null
        toggle = null
        appliedPaused = null
        lastLines = emptyList()
    }

    /** Activity 销毁时调：停掉长按计时，别让 Handler 抓着旧 content */
    fun detach() {
        main.removeCallbacks(longPress)
        panel = null
        highlight = null
        host = null
        tvType = null
        tvId = null
        tvBody = null
        tvHint = null
        toggle = null
        appliedPaused = null
        lastLines = emptyList()
    }

    /**
     * **暂停 / 恢复**（v1.20.15）。由宿主在写完 [paused] 之后调。
     *
     * 做两件事：
     * 1. 面板本体按 [UiInspectorInfo.panelStealsTouch] 决定抢不抢触摸
     *    （暂停时连拖动监听一起摘掉，否则它会"旁听"并吃掉 MOVE）；
     * 2. 开关文案 / 配色 / 底部提示换成对应状态 —— **用户必须一眼看出现在是哪个状态**。
     */
    fun setPaused(p: Boolean) {
        applyPausedToPanel()
    }

    private fun applyPausedToPanel() {
        val p = panel ?: return
        // ⚠️ 幂等短路：宿主那个 1 秒的 ticker 会反复调 `setPaused`，
        // 而这里要新建 `GradientDrawable`、重设文案 —— 状态没变就**一点都不做**。
        if (appliedPaused == paused) return
        appliedPaused = paused
        val steals = UiInspectorInfo.panelStealsTouch(paused)
        p.isClickable = steals
        // 暂停时必须把拖动监听也摘掉：`isClickable=false` 只影响"自己要不要消费"，
        // 而 OnTouchListener 一旦返回 true 就是消费 —— 留着它照样会挡住画布横滑。
        p.setOnTouchListener(if (steals) dragListener else null)
        p.background = panelBackground(paused)
        toggle?.let { t ->
            t.text = UiInspectorInfo.toggleLabel(paused)
            t.setTextColor(if (paused) WARN else ACCENT)
            t.background = pillBackground(if (paused) WARN else ACCENT)
            t.contentDescription = if (paused) "恢复控件检视（重新接管触摸）" else "暂停控件检视（放行触摸）"
        }
        tvHint?.text = if (paused) {
            UiInspectorInfo.HINT_PAUSED
        } else {
            UiInspectorInfo.HINT_DOC + "\n" + UiInspectorInfo.HINT_OPS
        }
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
        p.getLocationOnScreen(locTmp)
        return rawX >= locTmp[0] && rawX < locTmp[0] + p.width &&
            rawY >= locTmp[1] && rawY < locTmp[1] + p.height
    }

    /**
     * 检视屏幕坐标 `(rawX, rawY)` 处的控件 —— **宿主在检视模式下消费触摸时调它**。
     *
     * 传的是 `MotionEvent.rawX/rawY`（屏幕坐标）：面板、警示条、导航栏都在
     * `android.R.id.content` 里各占一块，用**窗口局部坐标**会在系统栏显示/隐藏时错位，
     * 屏幕坐标没有这个问题。
     *
     * ## 返回值 = "这一次解析成功了吗"（v1.20.15 加的）
     *
     * `false` 表示**解析失败**（抛了任何 `Throwable`，含 `StackOverflowError`），
     * 宿主据此**放行这一次触摸**（不消费）。
     *
     * 为什么必须这样：`inspect` 跑在 `dispatchTouchEvent` 里，它一不返回就是 ANR。
     * 检视器是**开发/调试工具**，"这一次没检视到"的代价远小于"整个 App 卡死"。
     * 宁可漏检，不能卡死。
     */
    fun inspect(rawX: Float, rawY: Float): Boolean {
        val h = host ?: return false
        return runCatching {
            val hit = hitTest(h, rawX, rawY)
            if (hit == null) {
                highlight?.setTarget(null)
                render(UiInspectorInfo.NO_HIT, "", listOf("这里是空白区（没有控件）"))
            } else {
                highlight?.setTarget(rectOf(hit))
                val snap = snapshotOf(hit, h)
                render(
                    snap.typeName, UiInspectorInfo.idLine(snap.idEntry),
                    UiInspectorInfo.renderBody(snap)
                )
            }
            true
        }.getOrElse { t ->
            // 兜底：解析炸了就把高亮清掉、面板上说明一句，然后**放行触摸**。
            // 这里再包一层 runCatching —— 兜底本身也不许把主线程带下去。
            runCatching {
                highlight?.setTarget(null)
                render(
                    "检视解析失败", "",
                    listOf(
                        (t.javaClass.simpleName.ifBlank { "Throwable" }) +
                            "：这一次触摸已放行（App 照常可用）"
                    )
                )
            }
            AppLog.w(AppLog.M_UI, "控件检视解析失败（已放行触摸）", t.toString())
            false
        }
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
     *
     * ## ⚠️ v1.20.15：遍历**有界**（[TreeWalkBudget]）
     *
     * 这条路径在**主线程**上（`dispatchTouchEvent`），"转不出来"就是 ANR。
     * 所以三道闸：
     * - **深度上限** `MAX_DEPTH`（32）—— 超过就不再往下钻；
     * - **节点数上限** `MAX_NODES`（4000）—— 到了就收手；
     * - **按身份去重** —— 同一个 View 一次遍历只认领一次，**父子互指也不会转圈**。
     *
     * 用尽预算是**收手**而不是报错：这一下退化成"没检视到"，触摸照常放行。
     */
    private fun hitTest(root: ViewGroup, sx: Float, sy: Float): View? =
        hitTest(root, sx, sy, 0, TreeWalkBudget())

    private fun hitTest(
        root: ViewGroup, sx: Float, sy: Float, depth: Int, budget: TreeWalkBudget
    ): View? {
        if (!budget.canEnter(depth)) return null
        for (i in root.childCount - 1 downTo 0) {
            val c = root.getChildAt(i) ?: continue
            if (c.visibility != View.VISIBLE) continue
            if (c === panel || c === highlight) continue
            // 认领（去重 + 计数）**必须在读它的属性之前** —— 预算是"要做多少活"的上限
            if (!budget.claim(TreeWalkBudget.ViewKey(c))) return null
            if (c.width <= 0 || c.height <= 0) continue
            if (!containsPoint(c, sx, sy)) continue
            if (c is ViewGroup) {
                val deeper = hitTest(c, sx, sy, depth + 1, budget)
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
     *
     * v1.20.15：写进**复用**的 [locTmp]，不再按节点 new 数组（这条路径在触摸上）。
     */
    private fun containsPoint(v: View, sx: Float, sy: Float): Boolean {
        v.getLocationOnScreen(locTmp)
        return sx >= locTmp[0] && sx < locTmp[0] + v.width &&
            sy >= locTmp[1] && sy < locTmp[1] + v.height
    }

    /** 控件在**高亮层坐标系**里的矩形（两层都挂在 content 上，差一个 content 原点） */
    private fun rectOf(v: View): Rect {
        val hl = highlight
        (hl ?: v).getLocationOnScreen(baseTmp)
        v.getLocationOnScreen(locTmp)
        val l = locTmp[0] - baseTmp[0]
        val t = locTmp[1] - baseTmp[1]
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
     *
     * v1.20.15：加一道**硬上限**（[TreeWalkBudget.MAX_DEPTH] 的两倍）。
     * 正常到 `root` 就 `break` 了，用不到它；但"往上找父链"同样是**主线程上的无界循环**，
     * 万一哪天 `root` 不在这个 View 的祖先链上（浮层挂错父容器），
     * 没有上限就会一路走到 `DecorView` 之外 —— 加一个上限是零成本的保险。
     */
    private fun chainOf(v: View, root: ViewGroup): List<String> {
        val names = ArrayList<String>(8)
        var cur: View? = v
        var guard = TreeWalkBudget.MAX_DEPTH * 2
        while (cur != null && guard-- > 0) {
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
            background = panelBackground(paused)
            val ph = dp(10)
            val pv = dp(8)
            setPadding(ph, pv, ph, pv)
            elevation = dp(12).toFloat()
            // ⚠️ v1.20.15：这个 `isClickable` **不是恒 true** 了 ——
            // 暂停时由 [applyPausedToPanel] 拨回 false，让面板本体不抢触摸
            //（只留开关与 × 两小块可点）。拖动与长按要能拿到触摸，所以检视中是 true。
            isClickable = UiInspectorInfo.panelStealsTouch(paused)
            isFocusable = false
        }

        // ---- 标题行：类型 + 【检视 开/暂停】+ 关闭 ----
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

        // ---- 检视开关（v1.20.15，用户点名要的）----
        //
        // 为什么是「一个可点的小 TextView」而不是 `Switch`：
        // ① 面板只有 320dp 宽，Switch 会把它挤掉一行；
        // ② 文案本身就是状态（`检视 开` / `检视 暂停`），不需要再配一个 label；
        // ③ **可点区域只有这一小块** —— 用户明确要求"面板其余部分仍不抢触摸"，
        //    一个 Switch 的触摸热区比它看上去大得多，反而容易挡住画布横滑。
        //
        // ⚠️ 点击回调走 [onRequestPause]，状态由宿主写 —— 浮层自己不维护 `paused`。
        val sw = TextView(ctx).apply {
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(8), dp(3), dp(8), dp(3))
            isClickable = true
            isFocusable = false
            setOnClickListener { onRequestPause(!paused) }
        }
        toggle = sw
        head.addView(sw)

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
        // v1.20.15：暂停时换成"触摸已放行、怎么恢复"（用户必须一眼看出现在能正常用 App）。
        val hint = TextView(ctx).apply {
            textSize = 10f
            setTextColor(0xFF5F6E85.toInt())
            setPadding(0, dp(4), 0, 0)
        }
        tvHint = hint
        root.addView(hint)

        installDragAndLongPress(root)
        // 注意：这里**不能**调 `applyPausedToPanel()` —— 此刻 `panel` 字段还没赋值
        // （赋值在 `show()` 里 `buildPanel()` 返回之后）。开关文案/配色由 `show()` 收尾时统一刷。
        return root
    }

    /** 面板底色。检视中 = 青色描边；**暂停 = 琥珀色描边**（一眼看出现在不接管触摸） */
    private fun panelBackground(paused: Boolean): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(10).toFloat()
        // 半透明（规格 §2 要求）——但要比灵动岛实一点：这一屏全是小字
        setColor(0xE60F141C.toInt())
        setStroke(dp(1), if (paused) 0x66FFB300.toInt() else 0x6600D8FF.toInt())
    }

    /** 开关那块小药丸的底色（同色系描边 + 极淡的白填充，保证在任何底色上都看得见） */
    private fun pillBackground(color: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(6).toFloat()
        setColor(0x33FFFFFF)
        setStroke(dp(1), color)
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
     *
     * ⚠️ v1.20.15：监听器改成**字段**（[dragListener]），因为**暂停时要把它摘下来** ——
     * 用户明确要求"面板其余部分仍不抢触摸"。只把 `isClickable` 拨成 false 不够：
     * OnTouchListener 一旦返回 `true` 就是消费，留着它照样会挡住画布横滑。
     */
    private fun installDragAndLongPress(p: LinearLayout) {
        if (UiInspectorInfo.panelStealsTouch(paused)) p.setOnTouchListener(dragListener)
    }

    /** 面板的拖动 + 长按复制（见 [installDragAndLongPress]）。挂/摘由 [applyPausedToPanel] 管 */
    private val dragListener = View.OnTouchListener { v, e ->
        val p = v as? LinearLayout ?: return@OnTouchListener false
        val lp = p.layoutParams as? FrameLayout.LayoutParams ?: return@OnTouchListener false
        val slop = ViewConfiguration.get(ctx).scaledTouchSlop
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

        /**
         * **检视暂停了没有**（v1.20.15，面板上那个开关）。
         *
         * ## 默认值 = `false`（**开启即接管**）—— 这是刻意的，写清楚
         *
         * `false` 的含义是"不暂停"，也就是**设置页一打开检视，触摸立刻被接管**，
         * 与 v1.20.14 逐字节一致 —— 这样 v1.20.14 那 8 条判据
         * （尤其"检视开着横滑不翻页"）**不需要重新解释**。
         *
         * 为什么不默认"暂停"：那会让"打开检视"看起来**没生效**
         * （用户点哪儿都正常，会以为开关坏了）。默认接管、按一下才暂停，
         * 状态变化才是"用户按出来的"，而不是"猜出来的"。
         *
         * ## 与 [enabled] 的分工
         *
         * - [enabled] = 浮层**在不在**（关掉 = 摘掉浮层，要恢复得回设置页）；
         * - [paused] = 浮层在、但**触摸放行**（临时状态，随时能按回来）。
         *
         * ## 落盘？**不落**（与 [enabled] 同一条理由）
         *
         * 它是临时状态：App 重启 / 旋屏重建都回到"接管"。
         * 进程内、`@Volatile`（读它的是主线程的 `dispatchTouchEvent`，与 [enabled] 同理）。
         */
        @Volatile
        var paused: Boolean = false

        /**
         * **此刻检视是否真的在接管触摸** = [enabled] 且 未 [paused]。
         *
         * 宿主 `MainActivity.dispatchTouchEvent` 只认这一个判据 ——
         * 别再在别处写 `enabled && !paused`（两处各写一份 = 迟早不一致）。
         */
        val active: Boolean get() = UiInspectorInfo.inspecting(enabled, paused)

        /** 面板宽度上限（dp） */
        private const val PANEL_W_DP = 320

        /** 浮层距屏幕边的默认留白（dp） */
        private const val MARGIN_DP = 12

        /** 长按判定（毫秒）—— 与系统的 500ms 一致 */
        private const val LONG_PRESS_MS = 500L

        private val ACCENT = 0xFF00D8FF.toInt()

        /** 暂停态的点缀色（琥珀）—— 与检视中的青色明确区分 */
        private val WARN = 0xFFFFB300.toInt()
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
