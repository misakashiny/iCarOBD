package com.icar.obd.ui.view

import android.content.Context
import android.util.AttributeSet
import com.google.android.material.bottomnavigation.BottomNavigationView

/**
 * 竖屏底部导航栏，**把菜单项上限从 5 提到 6**（v1.20.5）。
 *
 * ## 为什么需要这个子类（P0：手机一启动就崩）
 *
 * `BottomNavigationView` 的菜单项**硬上限是 5**，第 6 个会让它在**构造函数里**
 * 就抛异常：
 *
 * ```
 * java.lang.IllegalArgumentException: Maximum number of items supported by
 *   BottomNavigationView is 5. Limit can be checked with
 *   BottomNavigationView#getMaxItemCount()
 * ```
 *
 * v1.20.3 加了第 6 个 tab（知识库）之后：
 * - **平板（横屏）**用 `NavigationRailView`，**没有**这个上限 → 一直正常；
 * - **手机（竖屏）**用 `BottomNavigationView` → **一启动就崩**（用户报"手机端打不开"）。
 *
 * ## 为什么只能靠重写，不能用 `setMaxItemCount`
 *
 * 已核实：**Material 1.12.0 里根本没有 `setMaxItemCount`** ——
 * 把 `material-1.12.0/jars/classes.jar` 里的
 * `NavigationBarView` / `NavigationBarMenu` / `BottomNavigationView` 三个类
 * 逐个按字节搜过，只有 `getMaxItemCount`，没有 setter。
 * 也就是说这个 5 是**写死的、没有公开的改法**。
 *
 * 而 `getMaxItemCount()` 是**可重写**的，并且 `BottomNavigationView` 的构造函数里
 * 是**虚调用**它（`new NavigationBarMenu(context, getClass(), getMaxItemCount())`）——
 * Java 的虚调用会派发到子类重写，所以**在构造过程中就能生效** ✓
 *
 * 这里返回常量（不读子类字段）是有意的：构造期子类字段还没初始化。
 */
class NavBottomBar @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = com.google.android.material.R.attr.bottomNavigationStyle
) : BottomNavigationView(context, attrs, defStyleAttr) {

    /** 与 `menu/bottom_nav.xml` 的 item 数保持一致（6 个页面） */
    override fun getMaxItemCount(): Int = 6
}
