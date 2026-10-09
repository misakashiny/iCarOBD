package com.icar.obd.ui

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import com.icar.obd.R
import com.icar.obd.data.AppLog
import com.icar.obd.data.Backup
import com.icar.obd.data.PidDedup
import com.icar.obd.data.Store
import com.icar.obd.obd.ObdController
import com.icar.obd.ui.adapter.PidAdapter
import java.io.File

/**
 * PID 管理页。
 *
 * 这是「不改 APK 就能支持新车数据」的入口：
 *   · 新增 PID  → 手工填协议/Mode/PID/公式/量程
 *   · PID 扫描器 → 让车告诉我们它支持什么

 *   · 导入/导出  → JSON 分享，便于在多个设备/多个智能体之间传递成果
 */
class PidFragment : Fragment() {

    private lateinit var adapter: PidAdapter

    override fun onCreateView(
        inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?
    ): View = inflater.inflate(R.layout.fragment_pid, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        adapter = PidAdapter(
            onToggle = { pid, on ->
                Store.setEnabled(pid.id, on)
                ObdController.reloadPids()
                AppLog.i(AppLog.M_UI, "PID 启用状态变更", "${pid.name} → $on")
            },
            onClick = { pid ->
                startActivity(
                    Intent(requireContext(), PidEditorActivity::class.java)
                        .putExtra(PidEditorActivity.EXTRA_ID, pid.id)
                )
            },
            onDelete = { pid ->
                AlertDialog.Builder(requireContext())
                    .setTitle("删除 PID")
                    .setMessage("确定删除「${pid.name}」？使用它的仪表与规则会失效。")
                    .setPositiveButton("删除") { _, _ ->
                        Store.deletePid(pid.id)
                        ObdController.reloadPids()
                        refresh()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        )

        view.findViewById<RecyclerView>(R.id.rvPids).apply {
            layoutManager = LinearLayoutManager(requireContext())
            adapter = this@PidFragment.adapter
        }

        view.findViewById<MaterialButton>(R.id.btnAddPid).setOnClickListener {
            startActivity(Intent(requireContext(), PidEditorActivity::class.java))
        }
        view.findViewById<MaterialButton>(R.id.btnScanner).setOnClickListener {
            startActivity(Intent(requireContext(), ScannerActivity::class.java))
        }
        view.findViewById<MaterialButton>(R.id.btnImport).setOnClickListener { showImportDialog() }
        view.findViewById<MaterialButton>(R.id.btnExport).setOnClickListener { showExportDialog() }
        // CAN 探测放在扫描器旁边：两者是同一件事的两条路 ——
        // **扫描器主动问**（找 ECU 愿答的 PID），**探测被动听**（找模块自己广播的帧）
        view.findViewById<MaterialButton>(R.id.btnCanSniffer).setOnClickListener {
            startActivity(Intent(requireContext(), CanSnifferActivity::class.java))
        }
        // 探测记录（v1.19.22）：翻看 PID 探测 / CAN 探测的历史结论
        view.findViewById<MaterialButton>(R.id.btnProbeLog).setOnClickListener {
            startActivity(Intent(requireContext(), ProbeLogActivity::class.java))
        }
        // 清理重复（v1.20.12）—— 按钮默认 GONE，refresh() 里按实际情况显形
        view.findViewById<MaterialButton>(R.id.btnDedup).setOnClickListener { showDedupDialog() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        val all = Store.allPids()
        // 重复清单：**只算一次**，按钮文案 / 行内标注 / 对话框共用（三处各算一次迟早会分叉）
        val gaugeIds = Store.customGauges.map { it.pidId }
        val ruleIds = Store.rules.flatMap { r -> r.conditions.map { it.sourceId } }
        duplicates = PidDedup.removable(PidDedup.findDuplicates(all), gaugeIds, ruleIds)
        adapter.submit(all, duplicates.associate { it.pid.id to it.reason })
        val btn = view?.findViewById<MaterialButton>(R.id.btnDedup) ?: return
        btn.visibility = if (duplicates.isEmpty()) View.GONE else View.VISIBLE
        btn.text = "清理 ${duplicates.size} 条重复"
    }

    /** 上一次 [refresh] 算出来的可清理重复条目 */
    private var duplicates: List<PidDedup.Duplicate> = emptyList()

    /**
     * 清理重复（v1.20.12）。
     *
     * **先把清单和理由摆出来再删** —— 本项目最忌"静默改用户数据"。
     * 而且清单里**只会出现"重复且没有任何仪表/规则引用"的条目**
     * （安全闸见 `Store.cleanupDuplicatePids` 的注释），所以删完
     * 不可能出现空仪表或失效规则。
     */
    private fun showDedupDialog() {
        if (duplicates.isEmpty()) {
            ObdController.toast("没有发现重复的 PID")
            return
        }
        AlertDialog.Builder(requireContext())
            .setTitle("清理 ${duplicates.size} 条重复 PID")
            .setMessage(PidDedup.confirmMessage(duplicates))
            .setPositiveButton("删除这 ${duplicates.size} 条") { _, _ ->
                val removed = Store.cleanupDuplicatePids()
                ObdController.reloadPids()
                ObdController.toast("已清理 ${removed.size} 条重复 PID")
                refresh()
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ------------------------------------------------------------ 导出

    private fun showExportDialog() {
        AlertDialog.Builder(requireContext())
            .setTitle("导出")
            .setItems(
                arrayOf(
                    "只导出 PID（体积小，便于分享）",
                    "导出全部配置（完整备份）"
                )
            ) { _, which -> if (which == 0) exportPids() else exportBackup() }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun exportPids() {
        shareJson("pids", "iCarOBD-pids") { Store.exportPidsJson() }
    }

    private fun exportBackup() {
        val s = Backup.currentSummary()
        AlertDialog.Builder(requireContext())
            .setTitle("导出完整备份")
            .setMessage("将打包：\n${s.describe()}\n\n包含 PID、启用状态、规则、仪表布局、主题与设置。")
            .setPositiveButton("导出") { _, _ ->
                shareJson("backup", "iCarOBD-backup") { Backup.export() }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    /** 写文件 → 交给系统分享面板（用户可存到网盘/发给自己） */
    private fun shareJson(prefix: String, chooserTitle: String, build: () -> String) {
        runCatching {
            val dir = File(requireContext().getExternalFilesDir(null), "export").apply { mkdirs() }
            val f = File(dir, "$prefix-${System.currentTimeMillis()}.json")
            f.writeText(build())
            AppLog.i(AppLog.M_UI, "导出 $prefix", f.absolutePath)

            val uri = androidx.core.content.FileProvider.getUriForFile(
                requireContext(), "${requireContext().packageName}.fileprovider", f
            )
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            startActivity(Intent.createChooser(send, chooserTitle))
            f
        }.onSuccess {
            ObdController.toast("已导出：${it.name}")
        }.onFailure {
            ObdController.toast("导出失败：${it.message}")
        }
    }

    // ------------------------------------------------------------ 导入

    /** 从文件恢复完整备份（SAF 选择器，不依赖存储权限） */
    private val openBackupFile = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val text = runCatching {
            requireContext().contentResolver.openInputStream(uri)
                ?.bufferedReader()?.use { it.readText() }
        }.getOrNull()
        if (text.isNullOrBlank()) {
            ObdController.toast("读取文件失败")
            return@registerForActivityResult
        }
        doImportBackup(text)
    }

    private fun showImportDialog() {
        AlertDialog.Builder(requireContext())
            .setTitle("导入")
            .setItems(
                arrayOf(
                    "粘贴 PID JSON（只导入 PID）",
                    "粘贴完整备份（覆盖全部配置）",
                    "从文件恢复完整备份"
                )
            ) { _, which ->
                when (which) {
                    0 -> showPasteDialog("导入 PID JSON", "粘贴 PID 的 JSON 数组") { doImportPids(it) }
                    1 -> showPasteDialog("导入完整备份", "粘贴备份 JSON") { doImportBackup(it) }
                    else -> openBackupFile.launch(arrayOf("application/json", "text/plain", "*/*"))
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun showPasteDialog(title: String, hintText: String, onOk: (String) -> Unit) {
        val ctx = requireContext()
        val pad = (resources.displayMetrics.density * 12).toInt()
        val et = EditText(ctx).apply {
            hint = hintText
            setPadding(pad, pad, pad, pad)
            minLines = 5
        }
        val wrap = FrameLayout(ctx).apply { setPadding(pad, pad, pad, pad); addView(et) }
        AlertDialog.Builder(ctx)
            .setTitle(title)
            .setView(wrap)
            .setPositiveButton("导入") { _, _ -> onOk(et.text.toString()) }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun doImportPids(text: String) {
        runCatching { Store.importPidsJson(text) }
            .onSuccess {
                ObdController.reloadPids()
                refresh()
                ObdController.toast("已导入 $it 条")
            }
            .onFailure {
                ObdController.toast("导入失败：${it.message}")
                AppLog.e(AppLog.M_UI, "导入 PID 失败", it.message ?: "")
            }
    }

    private fun doImportBackup(text: String) {
        AlertDialog.Builder(requireContext())
            .setTitle("恢复完整备份")
            .setMessage("会**整体替换**当前的 PID、启用状态、规则、仪表布局、主题与设置。\n\n此操作不可撤销，确定继续？")
            .setPositiveButton("恢复") { _, _ ->
                val r = Backup.import(text)
                ObdController.reloadPids()
                ObdController.reloadRules()
                refresh()
                ObdController.toast(r.message)
                AppLog.i(AppLog.M_UI, "恢复备份", "ok=${r.ok} ${r.message}")
            }
            .setNegativeButton("取消", null)
            .show()
    }


}
