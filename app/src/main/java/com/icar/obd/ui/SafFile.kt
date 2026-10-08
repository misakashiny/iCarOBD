package com.icar.obd.ui

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns

/**
 * SAF（`content://`）文件的**显示名**。
 *
 * ## 为什么要有这个文件
 *
 * `content://com.android.providers.../document/1234` 这种东西给人看毫无意义，
 * 而用户恰恰需要看到**自己选的是哪个文件** —— v1.20.6 加的「最近一次导入」记录
 * 就是为此（用户报过"画布还是空的"，查半天才发现根本没导进去）。
 *
 * 规则编辑器选音频文件时也要同一个东西。**两处各写一遍必然分叉**
 * （本项目因为"两份权威"栽过三次），所以抽成一处。
 *
 * ## 三级回退（顺序是有意的）
 *
 * 1. 查 `OpenableColumns.DISPLAY_NAME` —— 正常情况；
 * 2. 退到 URI 路径末段 —— 某些 provider 不实现 `DISPLAY_NAME` 列；
 * 3. 退到调用方给的 [fallback] —— 连路径都没有时（例如 `content://` 后面是空的），
 *    也**不能返回空串**：界面上会变成"最近导入： · 5 块表"，看着像坏了。
 */
object SafFile {

    fun displayName(ctx: Context, uri: Uri, fallback: String): String {
        val fromQuery = runCatching {
            ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) c.getString(i) else null
            }
        }.getOrNull()
        return fromQuery?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
            ?: fallback
    }
}
