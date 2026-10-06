package com.icar.obd.data

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import java.io.File

/**
 * 设计文件**素材**的落地工具（v1.20.3）。
 *
 * ## 它解决的是哪个 bug
 *
 * 设计文件（`icar.ui/2`）里的素材是**相对路径**（`assets/背景/carbon.png`），
 * 要拼上 `Store.settings.designBaseDir` 才能读到。而：
 *
 * 1. **`designBaseDir` 全项目没有任何地方赋值** —— 导入走的是 SAF **单文件**
 *    （`OpenDocument` 选一个 `design.json`），**拿不到它所在的目录**；
 * 2. 于是 `NodeTreeRenderer.resolveAssetPath` 原样返回那个相对路径，
 *    `DashboardBackground.load` 必然读不到 → **所有素材加载失败**；
 * 3. 由**控件（素材图片）**拼出来的表盘就只剩空卡片 ——
 *    用户报的"**画布不显示我做好的内容、显示是空的**"就是这个。
 *
 * 纯程序化绘制的表（圆表/数字/条形）不依赖素材，所以以前一直没暴露。
 *
 * ## 做法：把素材复制进 app 私有目录
 *
 * 与 `DashboardBackground.import` 处理背景图**同一套思路** ——
 * 不依赖外部路径长期存在（换机、清理、重装都会让绝对路径失效）。
 *
 * 用 `DocumentsContract` 直接遍历 SAF 目录树，**不引入 `androidx.documentfile`**
 * （为一个递归复制多一个依赖不划算）。
 */
object DesignAssets {

    /**
     * 把 SAF 目录树整棵复制到 [destDir]。
     *
     * @return 复制成功的**文件**数（目录不计）
     * @throws Exception 读取失败时抛出（调用方负责提示）
     */
    fun copyTree(context: Context, treeUri: Uri, destDir: File): Int {
        val res = context.contentResolver
        val rootId = DocumentsContract.getTreeDocumentId(treeUri)
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootId)
        destDir.mkdirs()
        return copyDoc(context, rootUri, destDir)
    }

    private fun copyDoc(context: Context, docUri: Uri, dest: File): Int {
        val res = context.contentResolver
        val docId = DocumentsContract.getDocumentId(docUri)
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(docUri, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        )
        var n = 0
        res.query(childrenUri, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                val mime = c.getString(2)
                // ⚠️ 文件名里可能带 `/`（恶意或异常来源）→ 会写到 dest 之外。
                // 这里只取最后一段，挡住路径穿越。
                val safe = name.substringAfterLast('/').substringAfterLast('\\')
                if (safe.isEmpty() || safe == "." || safe == "..") continue
                val childUri = DocumentsContract.buildDocumentUriUsingTree(docUri, id)
                val out = File(dest, safe)
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    out.mkdirs()
                    n += copyDoc(context, childUri, out)
                } else {
                    out.parentFile?.mkdirs()
                    res.openInputStream(childUri)?.use { input ->
                        out.outputStream().use { output -> input.copyTo(output) }
                    }
                    n++
                }
            }
        }
        return n
    }

    /** 设计里引用的素材是不是**相对路径**（= 需要用户再指一次目录） */
    fun hasRelativeAssets(paths: List<String>): Boolean =
        paths.any { it.isNotBlank() && !it.startsWith("/") }
}
