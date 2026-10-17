package com.icar.obd.data

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.IOException

/**
 * **把导出的设计文件写到公共下载目录 `Download/ICarOBD/`**（T-UI-EXPORT-03）。
 *
 * ## 为什么不再只写 `cache/` 然后依赖分享
 *
 * 原来导出写 `cacheDir/design.json` 再弹分享面板。真机验证发现两个问题：
 *
 *  1. 分享给某些第三方文件管理器会被 `FileProvider` 的 URI 权限拒绝
 *     （`FLAG_GRANT_READ_URI_PERMISSION` 只对通过这个 Intent 接收的组件生效）；
 *  2. 当前 `type = "application/json"` 过窄，很多应用（含微信）不声明接收它，
 *     于是分享面板里根本不出现。
 *
 * 写到公共下载目录之后，用户可以直接在文件管理器里找到并传到电脑，
 * 不再依赖分享面板的组件声明。
 *
 * ## 为什么必须分两条路径
 *
 * `minSdk = 24`（Android 7），而分区存储从 **API 29** 开始生效：
 *
 * | API | 写法 | 原因 |
 * |---|---|---|
 * | ≥ 29 | `MediaStore` + `RELATIVE_PATH` | 分区存储下**不能直接写** `/sdcard/Download`（实测 `Permission denied`） |
 * | < 29 | `Environment.getExternalStoragePublicDirectory` + `File` | `RELATIVE_PATH` 是 API 29 才有的列 |
 *
 * ⚠️ 两条路径都不需要运行时权限：
 *  - API ≥ 29：MediaStore 属于 App 自己创建的媒体，无需 `WRITE_EXTERNAL_STORAGE`
 *  - API < 29：写 `Download` 需要 `WRITE_EXTERNAL_STORAGE`，由调用方在
 *    `mkdirs()` 失败时如实报错（本项目 targetSdk 34，实际设备都 ≥ 29）
 *
 * ## 本类刻意做成纯逻辑 + 依赖注入
 *
 * 文件名生成是纯函数（可 JVM 单测）；写盘部分接受 `Context`，
 * 便于将来替换。**不吞异常** —— 写失败必须让用户看见，不能静默当成功。
 */
object DesignExporterFiles {

    /** 公共下载目录下的子目录名。与根目录约定一致，大小写固定 */
    const val SUB_DIR = "ICarOBD"

    /** MIME 类型（设计文件是 JSON 文本） */
    const val MIME_JSON = "application/json"

    /**
     * 生成导出文件名：`ICarOBD_<画布名>_<yyyyMMdd-HHmmss>.json`。
     *
     * ## 为什么要带画布名和时间戳
     *
     * - **画布名**：多画布时用户一眼知道这份是哪个盘面的
     * - **时间戳**：同一画布多次导出**不互相覆盖**（只写 `design.json` 的话，
     *   第二次导出就把第一次冲掉了，而用户往往想留几个版本对比）
     *
     * 画布名里的文件系统非法字符（`/ \ : * ? " < > |`）与首尾空白/点会被替换或去掉 ——
     * 否则不同机器/文件管理器上会出现"文件创建了但看不到"的怪象。
     *
     * @param canvasName 画布名（可为空）
     * @param stamp 时间戳字符串，格式 `yyyyMMdd-HHmmss`
     */
    fun fileName(canvasName: String, stamp: String): String {
        val safe = canvasName.trim()
            .replace(Regex("""[\\/:*?"<>|\u0000-\u001F]"""), "_")
            .trim('.', ' ')
            .take(40)
        val suffix = stamp.ifBlank { "unknown" }
        return if (safe.isEmpty()) "ICarOBD_${suffix}.json" else "ICarOBD_${safe}_${suffix}.json"
    }

    /** 一次导出的结果 */
    sealed class Result {
        /** 写入成功。[location] 是给用户看的完整路径（如 `Download/ICarOBD/xxx.json`） */
        data class Ok(val uri: Uri?, val location: String, val displayName: String) : Result()

        /** 写入失败。[reason] 必须能直接展示给用户 */
        data class Failed(val reason: String) : Result()
    }

    /**
     * 把 [text] 写成 `Download/ICarOBD/<displayName>`。
     *
     * @param context 用于 `contentResolver`（API ≥ 29）；API < 29 只用文件系统
     */
    fun write(context: Context, displayName: String, text: String): Result =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            writeViaMediaStore(context, displayName, text)
        } else {
            writeViaLegacyPath(displayName, text)
        }

    // ---------------------------------------------------------------- API 29+

    private fun writeViaMediaStore(context: Context, displayName: String, text: String): Result {
        val collection = MediaStore.Files.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.Files.FileColumns.DISPLAY_NAME, displayName)
            put(MediaStore.Files.FileColumns.MIME_TYPE, MIME_JSON)
            // 相对路径必须以 `/` 结尾，表示"这是一个目录"
            put(MediaStore.Files.FileColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$SUB_DIR/")
            // IS_PENDING 是 Android 10+ 的原子可见性机制：
            // 写一半的文件不会以"完整的"身份出现在文件管理器里
            put(MediaStore.Files.FileColumns.IS_PENDING, 1)
        }
        return try {
            val resolver = context.contentResolver
            val uri = resolver.insert(collection, values)
                ?: return Result.Failed("无法在 Download/$SUB_DIR/ 下创建文件（系统拒绝）")
            val wrote = runCatching {
                resolver.openOutputStream(uri)?.use { out ->
                    out.write(text.toByteArray(Charsets.UTF_8))
                    out.flush()
                } ?: throw IOException("打不开输出流")
            }
            if (wrote.isFailure) {
                // 写失败要把半成品删掉 —— 否则 Download 里会留一个空/残缺的 json
                runCatching { resolver.delete(uri, null, null) }
                return Result.Failed("写入失败：${wrote.exceptionOrNull()?.message ?: "未知错误"}")
            }
            // 写完才发布
            runCatching {
                resolver.update(uri, ContentValues().apply {
                    put(MediaStore.Files.FileColumns.IS_PENDING, 0)
                }, null, null)
            }
            Result.Ok(uri, "${Environment.DIRECTORY_DOWNLOADS}/$SUB_DIR/$displayName", displayName)
        } catch (e: Exception) {
            Result.Failed("写入失败：${e.message ?: e::class.java.simpleName}")
        }
    }

    // ---------------------------------------------------------------- API < 29

    @Suppress("DEPRECATION")
    private fun writeViaLegacyPath(displayName: String, text: String): Result {
        return try {
            val dir = File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
                SUB_DIR
            )
            if (!dir.exists() && !dir.mkdirs()) {
                return Result.Failed("无法创建目录 ${dir.absolutePath}")
            }
            val f = File(dir, displayName)
            f.writeText(text, Charsets.UTF_8)
            Result.Ok(null, "${Environment.DIRECTORY_DOWNLOADS}/$SUB_DIR/$displayName", displayName)
        } catch (e: Exception) {
            Result.Failed("写入失败：${e.message ?: e::class.java.simpleName}")
        }
    }
}
