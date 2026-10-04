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
        data class Header(val title: String, val count: Int) : Row()
        data class Item(val pid: PidDefinition) : Row()
    }

    private val rows = ArrayList<Row>()

    fun submit(list: List<PidDefinition>) {
        rows.clear()
        val grouped = list.groupBy { it.group }
        // 分组顺序固定：标准 → 派生 → 厂家模板 → 自定义
        val order = listOf("标准 OBD", "派生", "厂家模板(未验证)")
        val keys = order.filter { grouped.containsKey(it) } +
            grouped.keys.filter { it !in order }.sorted()
        keys.forEach { k ->
            val items = grouped[k] ?: return@forEach
            rows.add(Row.Header(k, items.size))
            items.forEach { rows.add(Row.Item(it)) }
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
            tv.text = "${r.title}  (${r.count})"
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
            if (pid.note.isBlank()) {
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
