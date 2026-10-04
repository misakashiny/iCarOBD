package com.icar.obd.ui.adapter

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.icar.obd.R
import com.icar.obd.data.AppLog

/**
 * 日志适配器。
 *
 * 性能考量：日志可到数千条，因此：
 *  - 新条目走 notifyItemInserted（不整表刷新）
 *  - 用 stackFromEnd 让最新一条始终在底部
 *  - 超过上限时丢弃最早的一条（与 AppLog 环形缓冲一致）
 */
class LogAdapter : RecyclerView.Adapter<LogAdapter.VH>() {

    private val items = ArrayList<AppLog.Entry>()
    private var levelFilter: AppLog.Level = AppLog.Level.V
    private var moduleFilter: String = ALL

    private val visible = ArrayList<AppLog.Entry>()

    fun setLevel(l: AppLog.Level) {
        levelFilter = l
        rebuild()
    }

    fun setModule(m: String) {
        moduleFilter = m
        rebuild()
    }

    fun clear() {
        items.clear()
        rebuild()
    }

    /** 用当前完整缓冲替换（切页回来时用） */
    fun submitAll(list: List<AppLog.Entry>) {
        items.clear()
        items.addAll(list.takeLast(MAX))
        rebuild()
    }

    fun add(e: AppLog.Entry) {
        val itemsOverflow = items.size >= MAX
        items.add(e)
        if (itemsOverflow) items.removeAt(0)

        if (!pass(e)) return

        val visibleOverflow = visible.size >= MAX
        visible.add(e)
        if (visibleOverflow) {
            // 队首被挤掉 + 队尾新增，**必须成对通知**。
            // 早期版本只发 notifyItemInserted(visible.size - 1)：
            // RecyclerView 认为条目数 +1，而适配器实际仍是 MAX，
            // 位置表持续漂移，最终抛
            //   IndexOutOfBoundsException: Inconsistency detected.
            //   Invalid view holder adapter position ... oldPos=2999
            // （2026-10-02 实车日志洪泛时复现两次，见 CHANGELOG v1.3.0）
            visible.removeAt(0)
            notifyItemRemoved(0)
        }
        notifyItemInserted(visible.size - 1)
    }

    private fun rebuild() {
        visible.clear()
        visible.addAll(items.filter { pass(it) })
        notifyDataSetChanged()
    }

    private fun pass(e: AppLog.Entry): Boolean =
        e.level.prio >= levelFilter.prio && (moduleFilter == ALL || e.module == moduleFilter)

    fun count(): Int = visible.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_log, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(visible[position])

    override fun getItemCount(): Int = visible.size

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val tv: TextView = v.findViewById(R.id.tvLog)

        fun bind(e: AppLog.Entry) {
            tv.text = e.format()
            tv.setTextColor(
                when (e.level) {
                    AppLog.Level.E -> 0xFFFF4D4F.toInt()
                    AppLog.Level.W -> 0xFFFFB020.toInt()
                    AppLog.Level.I -> 0xFFE8EEF7.toInt()
                    AppLog.Level.D -> 0xFF9AA8BC.toInt()
                    else -> 0xFF5F6E85.toInt()
                }
            )
        }
    }

    companion object {
        const val ALL = "全部"
        private const val MAX = 3000
    }
}
