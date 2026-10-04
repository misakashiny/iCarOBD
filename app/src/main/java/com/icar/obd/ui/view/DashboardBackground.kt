package com.icar.obd.ui.view

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.icar.obd.data.AppLog
import java.io.File

/**
 * 仪表盘背景图片。
 *
 * ## 为什么必须下采样
 *
 * 手机相册里的图动辄 4000×3000。直接 `BitmapFactory.decodeFile` 解码成 ARGB_8888
 * 就是 **48MB 一张**，而仪表盘是全屏 View，平板上必然 OOM。
 * 所以先 `inJustDecodeBounds` 读尺寸，算出 2 的幂次 `inSampleSize`，再解码。
 *
 * ## 为什么要把图复制到私有目录
 *
 * SAF 返回的 `content://` uri 只保证**当次会话**可读；重启后很可能失效。
 * 所以导入时复制一份到 `files/bg/`，之后只认这个路径。
 */
object DashboardBackground {

    /** 解码后的最长边上限。平板屏幕本身 2560 宽，2048 足够且留了余量 */
    const val MAX_DIM = 2048

    private const val DIR = "bg"

    /**
     * 把用户选的图片复制到私有目录。
     * @return 新文件绝对路径；失败返回 null
     */
    fun import(ctx: Context, uri: Uri): String? = runCatching {
        val dir = File(ctx.filesDir, DIR).apply { mkdirs() }
        // 先清旧的：换背景图时不该把历史图片堆在设备上
        dir.listFiles()?.forEach { it.delete() }

        val out = File(dir, "background.img")
        ctx.contentResolver.openInputStream(uri)?.use { input ->
            out.outputStream().use { output -> input.copyTo(output) }
        }
        if (out.length() <= 0L) return null
        AppLog.i(AppLog.M_UI, "背景图片已导入", "size=${out.length() / 1024}KB")
        out.absolutePath
    }.getOrNull()

    /**
     * 读取并下采样。
     * @return 解码后的 Bitmap；路径为空/文件不存在/解码失败都返回 null（调用方回落到纯色）
     */
    fun load(path: String, maxDim: Int = MAX_DIM): Bitmap? {
        if (path.isBlank()) return null
        val f = File(path)
        if (!f.exists() || f.length() <= 0L) return null
        return runCatching {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(path, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

            var sample = 1
            while (bounds.outWidth / sample > maxDim || bounds.outHeight / sample > maxDim) {
                sample *= 2
            }
            val opts = BitmapFactory.Options().apply { inSampleSize = sample }
            BitmapFactory.decodeFile(path, opts)?.also {
                AppLog.i(
                    AppLog.M_UI, "背景图片已解码",
                    "src=${bounds.outWidth}x${bounds.outHeight} sample=$sample " +
                        "out=${it.width}x${it.height}"
                )
            }
        }.getOrNull()
    }

    /** 删除已设置的背景图 */
    fun clear(ctx: Context) {
        runCatching { File(ctx.filesDir, DIR).listFiles()?.forEach { it.delete() } }
    }
}
