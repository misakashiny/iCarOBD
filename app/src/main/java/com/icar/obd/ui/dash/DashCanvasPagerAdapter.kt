package com.icar.obd.ui.dash

import android.os.Bundle
import androidx.fragment.app.Fragment
import androidx.viewpager2.adapter.FragmentStateAdapter
import com.icar.obd.data.Store

/**
 * 仪表盘页的适配器：`[画布0][画布1]…[设置]`。
 *
 * ## 为什么用稳定 id（`getItemId`）而不是按下标
 *
 * `FragmentStateAdapter` 用 `getItemId` 的返回值当 `Fragment` 的 tag（`"f" + itemId`）。
 * 按下标的话，**在中间插入/删除一套画布会让后面每一页的 tag 都变** ——
 * 于是 `ViewPager2` 认为"这些项都换了"，把后面的页面全部重建：
 * 正在编辑的那一页会被无声销毁（拖了一半的表全丢）。
 *
 * 用**画布 id 派生的稳定值**就没有这个问题：只有真正被增删的那一页会动。
 * 设置页固定用 [SETTINGS_ID]。
 *
 * ## 为什么映射表只增不减
 *
 * 同一个画布 id 必须**永远**映射到同一个 Long。删除后重建的"同名画布"是**新 id**
 * （`DashCanvas` 默认给 UUID），所以不需要回收 —— 回收反而会让新旧两套撞上同一个 tag。
 */
class DashCanvasPagerAdapter(host: Fragment) : FragmentStateAdapter(host) {

    /** canvasId -> 稳定 Long。只增不减，见类注释 */
    private val stableIds = HashMap<String, Long>()
    private var nextId = 1L

    private fun canvasCount(): Int = Store.settings.canvases.size

    /** 最后一页是设置页 */
    override fun getItemCount(): Int = canvasCount() + 1

    override fun getItemId(position: Int): Long {
        if (position >= canvasCount()) return SETTINGS_ID
        val c = Store.settings.canvases.getOrNull(position) ?: return -(position + 1).toLong()
        return stableIds.getOrPut(c.id) { nextId++ }
    }

    override fun containsItem(itemId: Long): Boolean {
        if (itemId == SETTINGS_ID) return true
        // getItemId 可能还没被调过；先保证每套画布都有值再比对
        Store.settings.canvases.forEach { stableIds.getOrPut(it.id) { nextId++ } }
        return Store.settings.canvases.any { stableIds[it.id] == itemId }
    }

    override fun createFragment(position: Int): Fragment {
        if (position >= canvasCount()) return CanvasSettingsFragment()
        return DashCanvasPageFragment().apply {
            arguments = Bundle().apply {
                putString(DashCanvasPageFragment.ARG_CANVAS_ID, Store.settings.canvases[position].id)
            }
        }
    }

    /** 某一套画布在第几页（找不到 → -1） */
    fun positionOfCanvas(id: String): Int = Store.settings.canvases.indexOfFirst { it.id == id }

    /** 设置页在第几页（永远是最右） */
    fun settingsPosition(): Int = canvasCount()

    companion object {
        /** 设置页的稳定 id。与画布 id 的取值空间（从 1 开始）不重叠 */
        const val SETTINGS_ID = 0L
    }
}
