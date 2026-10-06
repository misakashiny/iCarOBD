package com.icar.obd.ui.adapter

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.PidDefinition
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController

/**
 * PID 列表适配器。带分组标题行。
 *
 * 分组的意义：内置标准 OBD / 派生通道 / 厂家模板（未验证）/ 自定义
 * 一眼能分清「哪些是车本来就支持的、哪些是我自己加的、哪些还没验证」。
 */
class PidAdapter(
    private val onToggle: (PidDefinition, Boolean) -> Unit,
    private val onClick: (PidDefinition) -> Unit,
    private val onDelete: (PidDefinition) -> Unit
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {

    /** 行模型。非 private：HeaderVH.bind 是公开成员，若 Row 私有会触发可见性错误。 */
    sealed class Row {
        data class Header(val title: String, val count: Int, val collapsed: Boolean = false) : Row()
        data class Item(val pid: PidDefinition) : Row()
    }

    private val rows = ArrayList<Row>()

    /**
     * 被**收起**的分组名（v1.20.3）。
     *
     * 用户要求："PID 列表现在不是分了四类吗、我想给类目上面加个收缩起来的按钮"。
     *
     * 状态放在适配器里（不是 Store）—— 它是**纯 UI 临时状态**：
     * 重启后回到"全展开"是符合预期的，为它加一个持久化字段反而多一份要维护的东西。
     */
    private val collapsed = HashSet<String>()

    private var source: List<PidDefinition> = emptyList()

    fun submit(list: List<PidDefinition>) {
        source = list
        rebuild()
    }

    /** 展开 / 收起一个分组 */
    fun toggleGroup(title: String) {
        if (!collapsed.remove(title)) collapsed.add(title)
        rebuild()
    }

    private fun rebuild() {
        rows.clear()
        val grouped = source.groupBy { it.group }
        // 分组顺序固定：标准 → 派生 → 厂家模板 → 自定义
        val order = listOf("标准 OBD", "派生", "厂家模板(未验证)")
        val keys = order.filter { grouped.containsKey(it) } +
            grouped.keys.filter { it !in order }.sorted()
        keys.forEach { k ->
            val items = grouped[k] ?: return@forEach
            rows.add(Row.Header(k, items.size, collapsed.contains(k)))
            // 收起时**只留标题行** —— 这样"四类一眼看全"这个好处还在
            if (!collapsed.contains(k)) items.forEach { rows.add(Row.Item(it)) }
        }
        notifyDataSetChanged()
    }

    override fun getItemViewType(position: Int): Int =
        if (rows[position] is Row.Header) TYPE_HEADER else TYPE_ITEM

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inf = LayoutInflater.from(parent.context)
        return if (viewType == TYPE_HEADER) {
            HeaderVH(inf.inflate(R.layout.item_pid_header, parent, false))
        } else {
            VH(inf.inflate(R.layout.item_pid, parent, false))
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val r = rows[position]) {
            is Row.Header -> (holder as HeaderVH).bind(r)
            is Row.Item -> (holder as VH).bind(r.pid)
        }
    }

    override fun getItemCount(): Int = rows.size

    inner class HeaderVH(v: View) : RecyclerView.ViewHolder(v) {
        private val tv: TextView = v.findViewById(R.id.tvHeader)
        fun bind(r: Row.Header) {
            // ▾ 展开 / ▸ 收起 —— 一眼看出"这个标题能点"
            tv.text = "${if (r.collapsed) "▸" else "▾"}  ${r.title}  (${r.count})"
            // 整行都可点（只点文字太难按，尤其在车上）
            itemView.setOnClickListener { toggleGroup(r.title) }
        }
    }

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val tvName: TextView = v.findViewById(R.id.tvName)
        private val tvSub: TextView = v.findViewById(R.id.tvSub)
        private val tvNote: TextView = v.findViewById(R.id.tvNote)
        private val sw: MaterialSwitch = v.findViewById(R.id.swEnable)
        private val btnDelete: MaterialButton = v.findViewById(R.id.btnDelete)

        fun bind(pid: PidDefinition) {
            tvName.text = pid.name.ifBlank { "(未命名)" }
            val unit = if (pid.unit.isBlank()) "" else " ${pid.unit}"
            tvSub.text = "${pid.requestString()}  ·  ${pid.formula}  ·  " +
                "${trim(pid.minVal)}~${trim(pid.maxVal)}$unit"

            // ---- P10-1：被判定「本车不支持」的**标灰**，并说明怎么恢复 ----
            //
            // 为什么用长按而不是再加个按钮：这一行已经有开关和删除两个可点区域，
            // 再加会挤（工具那边有行高约束，App 这边同理）。
            // 「标灰 + 备注写明长按重新启用」够用，也不破坏原有交互。
            val unsupported = ObdController.isUnsupported(pid.id)
            itemView.alpha = if (unsupported) 0.45f else 1f
            if (unsupported) {
                tvNote.visibility = View.VISIBLE
                tvNote.text = "本车不支持，已退出轮询 —— 长按重新启用"
            } else if (pid.note.isBlank()) {
                tvNote.visibility = View.GONE
            } else {
                tvNote.visibility = View.VISIBLE
                tvNote.text = pid.note
            }

            // 避免复用时触发旧监听
            sw.setOnCheckedChangeListener(null)
            sw.isChecked = Store.isEnabled(pid.id)
            sw.setOnCheckedChangeListener { _, checked -> onToggle(pid, checked) }

            itemView.setOnClickListener { onClick(pid) }
            itemView.setOnLongClickListener {
                // 长按只对"被判定不支持"的行生效，其他行保持原样（返回 false 让事件继续）
                if (!ObdController.isUnsupported(pid.id)) return@setOnLongClickListener false
                ObdController.reEnablePid(pid.id)
                ObdController.toast("已重新启用：${pid.name}")
                val pos = bindingAdapterPosition
                if (pos != RecyclerView.NO_POSITION) notifyItemChanged(pos)
                true
            }
            btnDelete.visibility = if (pid.builtIn) View.GONE else View.VISIBLE
            btnDelete.setOnClickListener { onDelete(pid) }
        }

        private fun trim(f: Float): String =
            if (f == f.toInt().toFloat()) f.toInt().toString() else String.format("%.1f", f)
    }

    companion object {
        private const val TYPE_HEADER = 0
        private const val TYPE_ITEM = 1
    }
}
