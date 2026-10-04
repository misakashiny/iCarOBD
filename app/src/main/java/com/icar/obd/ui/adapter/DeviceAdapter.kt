package com.icar.obd.ui.adapter

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.icar.obd.R

/** 扫描到的 BLE 设备列表。按地址去重，刷新 RSSI。 */
class DeviceAdapter(
    private val onConnect: (BluetoothDevice) -> Unit
) : RecyclerView.Adapter<DeviceAdapter.VH>() {

    private class Row(val dev: BluetoothDevice, var name: String, var rssi: Int)

    private val rows = ArrayList<Row>()

    @SuppressLint("MissingPermission")
    fun clear() {
        rows.clear()
        notifyDataSetChanged()
    }

    @SuppressLint("MissingPermission")
    fun add(dev: BluetoothDevice, name: String, rssi: Int) {
        val idx = rows.indexOfFirst { it.dev.address == dev.address }
        if (idx >= 0) {
            rows[idx].rssi = rssi
            if (name.isNotBlank()) rows[idx].name = name
            notifyItemChanged(idx)
        } else {
            rows.add(Row(dev, name, rssi))
            notifyItemInserted(rows.size - 1)
        }
    }

    fun size(): Int = rows.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_device, parent, false)
        return VH(v)
    }

    @SuppressLint("MissingPermission")
    override fun onBindViewHolder(holder: VH, position: Int) {
        val r = rows[position]
        holder.name.text = r.name.ifBlank { "(未命名设备)" }
        holder.addr.text = r.dev.address
        holder.rssi.text = "${r.rssi} dBm"
        holder.btn.setOnClickListener { onConnect(r.dev) }
        holder.itemView.setOnClickListener { onConnect(r.dev) }
    }

    override fun getItemCount(): Int = rows.size

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val name: TextView = v.findViewById(R.id.tvDevName)
        val addr: TextView = v.findViewById(R.id.tvDevAddr)
        val rssi: TextView = v.findViewById(R.id.tvRssi)
        val btn: MaterialButton = v.findViewById(R.id.btnConnect)
    }
}
