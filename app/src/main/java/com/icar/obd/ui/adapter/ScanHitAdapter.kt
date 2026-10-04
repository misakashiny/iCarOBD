package com.icar.obd.ui.adapter

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.obd.PidScanner

/** 扫描命中结果。每条都可以一键「存为 PID」，带着建议公式跳到编辑器。 */
class ScanHitAdapter(
    private val onSave: (PidScanner.Hit) -> Unit
) : RecyclerView.Adapter<ScanHitAdapter.VH>() {

    private val items = ArrayList<PidScanner.Hit>()

    fun add(hit: PidScanner.Hit) {
        items.add(hit)
        notifyItemInserted(items.size - 1)
    }

    fun clear() {
        items.clear()
        notifyDataSetChanged()
    }

    fun all(): List<PidScanner.Hit> = items.toList()

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_scan_hit, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) = holder.bind(items[position])

    override fun getItemCount(): Int = items.size

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        private val tvTitle: TextView = v.findViewById(R.id.tvTitle)
        private val tvRaw: TextView = v.findViewById(R.id.tvRaw)
        private val tvPreview: TextView = v.findViewById(R.id.tvPreview)
        private val btn: MaterialButton = v.findViewById(R.id.btnSave)

        fun bind(h: PidScanner.Hit) {
            tvTitle.text = "Mode ${h.mode} · PID ${h.pid}"
            tvRaw.text = "TX: ${h.request}\nRX: ${h.raw.take(70)}"
            val preview = buildString {
                append("数据: ").append(h.dataHex.ifBlank { "-" })
                append("\n建议公式: ").append(h.suggestedFormula.ifBlank { "-" })
                h.previewValue?.let { append("  →  ").append(String.format("%.2f", it)) }
                if (h.learnedMin != null && h.learnedMax != null) {
                    append("\n学习范围: ").append(String.format("%.2f", h.learnedMin))
                        .append(" ~ ").append(String.format("%.2f", h.learnedMax))
                }
            }
            tvPreview.text = preview
            btn.setOnClickListener { onSave(h) }
        }
    }
}
