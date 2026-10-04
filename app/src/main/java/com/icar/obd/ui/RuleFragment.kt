package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.Defaults
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.adapter.RuleAdapter

/**
 * 规则页。
 *
 * 「转向灯音效」「高水温告警」都在这里以规则形式存在——
 * 它们不是硬编码功能，删掉就没了，改阈值立刻生效。
 */
class RuleFragment : Fragment() {

    private lateinit var adapter: RuleAdapter

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_rule, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        adapter = RuleAdapter(
            onToggle = { rule, on ->
                Store.upsertRule(rule.copy(enabled = on))
                ObdController.reloadRules()
                refresh()
            },
            onClick = { rule ->
                startActivity(
                    Intent(requireContext(), RuleEditorActivity::class.java)
                        .putExtra(RuleEditorActivity.EXTRA_ID, rule.id)
                )
            },
            onDelete = { rule ->
                AlertDialog.Builder(requireContext())
                    .setTitle("删除规则")
                    .setMessage("确定删除「${rule.name}」？")
                    .setPositiveButton("删除") { _, _ ->
                        Store.deleteRule(rule.id)
                        ObdController.reloadRules()
                        refresh()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        )

        view.findViewById<RecyclerView>(R.id.rvRules).apply {
            layoutManager = LinearLayoutManager(requireContext())
            adapter = this@RuleFragment.adapter
        }

        view.findViewById<MaterialButton>(R.id.btnAddRule).setOnClickListener {
            startActivity(Intent(requireContext(), RuleEditorActivity::class.java))
        }

        view.findViewById<MaterialButton>(R.id.btnResetRules).setOnClickListener {
            AlertDialog.Builder(requireContext())
                .setTitle("恢复默认规则")
                .setMessage("将清空当前全部规则，并写回内置的 5 条默认规则（转向灯音效 / 水温 / 电压 / 超速）。")
                .setPositiveButton("恢复") { _, _ ->
                    Store.rules.clear()
                    Store.rules.addAll(Defaults.defaultRules())
                    Store.saveRules()
                    ObdController.reloadRules()
                    refresh()
                    ObdController.toast("已恢复默认规则")
                    AppLog.i(AppLog.M_UI, "规则已恢复默认")
                }
                .setNegativeButton("取消", null)
                .show()
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        adapter.submit(Store.rules)
    }
}
