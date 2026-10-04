package com.icar.obd.ui.adapter

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.icar.obd.R
import com.icar.obd.data.Rule
import com.icar.obd.obd.RuleEngine

/** 规则列表。描述文本由 [RuleEngine.describeRule] 统一生成，保证与执行语义一致。 */
class RuleAdapter(
    private val onToggle: (Rule, Boolean) -> Unit,
    private val onClick: (Rule) -> Unit,
    private val onDelete: (Rule) -> Unit
) : RecyclerView.Adapter<RuleAdapter.VH>() {

    private val items = ArrayList<Rule>()

    fun submit(list: List<Rule>) {
        items.clear()
        items.addAll(list)
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_rule, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    override fun getItemCount(): Int = items.size

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val tvName: TextView = v.findViewById(R.id.tvName)
        private val tvDesc: TextView = v.findViewById(R.id.tvDesc)
        private val tvState: TextView = v.findViewById(R.id.tvState)
        private val sw: MaterialSwitch = v.findViewById(R.id.swEnable)
        private val btnDelete: MaterialButton = v.findViewById(R.id.btnDelete)

        fun bind(r: Rule) {
            tvName.text = r.name.ifBlank { "(未命名规则)" }
            tvDesc.text = RuleEngine.describeRule(r)

            val conds = r.conditions.mapNotNull { c ->
                com.icar.obd.data.Store.findPid(c.sourceId)?.let { it.id to it.enabled }
            }
            val disabledSources = conds.filter { !it.second }
            tvState.text = when {
                r.conditions.isEmpty() -> "⚠ 没有条件，不会触发"
                disabledSources.isNotEmpty() ->
                    "⚠ 数据源未启用：${disabledSources.joinToString(",") { com.icar.obd.data.Store.findPid(it.first)?.name ?: it.first }}"
                else -> "就绪"
            }
            tvState.setTextColor(
                if (r.conditions.isEmpty() || disabledSources.isNotEmpty())
                    0xFFFFB020.toInt() else 0xFF5F6E85.toInt()
            )

            sw.setOnCheckedChangeListener(null)
            sw.isChecked = r.enabled
            sw.setOnCheckedChangeListener { _, c -> onToggle(r, c) }

            itemView.setOnClickListener { onClick(r) }
            btnDelete.setOnClickListener { onDelete(r) }
        }
    }
}
