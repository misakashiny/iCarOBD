package com.icar.obd.data

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.InputStream
import java.util.zip.CRC32
import java.util.zip.ZipInputStream

/**
 * **设计包（`.icarzip`）的解开与校验**（v1.20.9，App 侧）。
 *
 * ## 它治的是哪个病
 *
 * 设计文件里的素材是**相对路径**（`assets/xx.png`），而 App 侧导入走 SAF
 * **单文件** —— 拿不到它旁边的 `assets/`，于是 `designBaseDir` 永远是空 →
 * **所有素材加载失败** → 由控件（素材图片）拼出来的表盘只剩空卡片。
 * 用户报的「画布不显示我做好的内容、显示是空的」就是这个
 * （见 [`DesignAssets`] 与 CHANGELOG v1.20.3）。
 *
 * v1.20.3 加的「选素材文件夹」是两步操作的兜底。工具侧 v2.79.0 起能导出
 * **自包含的设计包**：`design.json` + 只打包真正引用到的素材 + `manifest.json`。
 * 包内路径 = 设计里写的相对路径，所以**解压出来目录结构天然一致**，
 * App 侧只要把 `designBaseDir` 指到解压目录即可，**不需要任何路径映射**。
 *
 * ## 为什么整份逻辑放在 `data/` 而不是 Fragment 里
 *
 * 解压、manifest 校验、路径穿越防护全是**纯 JVM 逻辑**（`java.util.zip` +
 * `java.io.File`，**零新依赖**）。放这里才能在 `test/` 里用内存造的 zip 穷举
 * "CRC 不符 / 少一个素材 / 条目名带 `..`" 这些边界 —— 写在 Fragment 里一条都测不到，
 * 而这几条恰恰是**错了也不会立刻报错**的那类（CRC 只影响个别素材能否显示）。
 *
 * ## 一条刻意定的口径：**不静默**
 *
 * 素材字节数或 CRC 对不上、manifest 里声明的素材不在包里 —— **整个包拒收**
 * 并把每一条都列出来。理由：这份包的意义就是"素材齐了"，只导进去一半
 * 恰恰会重现"表盘只剩空卡片"那个症状，而那时用户已经离原因很远了。
 * 唯一放行的是 manifest 自己 `missing` 里**已经如实登记**的素材
 * （工具导出时就读不到字节的那些）—— 它会在结果里作为警告逐条列出。
 */
object DesignPack {

    /** 包格式版本。⚠️ 与设计文件自己的 `icar.ui/2` **不是一回事**（见工具侧 `pack.js`） */
    const val PACK_FORMAT = "icar.pack/1"

    /** 包内固定的两个条目名（工具侧 `pack.js` 的 `DESIGN_ENTRY` / `MANIFEST_ENTRY`） */
    const val DESIGN_ENTRY = "design.json"
    const val MANIFEST_ENTRY = "manifest.json"

    /** manifest 里的一个素材条目 */
    data class Asset(
        val path: String,
        val assetId: String,
        val refs: List<String>,
        val bytes: Long,
        val crc32: Long,
        val w: Int,
        val h: Int,
    )

    /** 工具**导出时就**没打进包的素材（字节读不到），如实登记在 manifest 里 */
    data class Missing(val path: String, val reason: String)

    data class Manifest(
        val format: String,
        val designSchema: String,
        val designName: String,
        val exportedAt: String,
        val assets: List<Asset>,
        val missing: List<Missing>,
    )

    /** 解压 + 校验的结果 */
    sealed class Result {
        /**
         * @param dir 解压目录（**直接拿去当 `designBaseDir`**）
         * @param warnings 不阻断导入、但必须让用户看到的事（缺素材 / 多余条目）
         */
        data class Ok(
            val dir: File,
            val manifest: Manifest,
            val designJson: String,
            val extractedFiles: Int,
            val warnings: List<String>,
        ) : Result()

        /** @param problems 逐条说清"哪个文件、为什么"，**不做概括** */
        data class Fail(val problems: List<String>) : Result()
    }

    // ---------------------------------------------------------------- 纯判定

    /**
     * 前 4 个字节是不是一个 zip（`.icarzip` 就是 store-only 的 zip）。
     *
     * 导入入口靠它**自动识别**：zip 走包导入、其余当设计文件 JSON 读。
     * 只认三种合法签名（普通 / 空归档 / 分卷），**不认 "PK" 开头的任意字节** ——
     * 一个以 "PK" 开头的 JSON 是不存在的，但误判的代价是"文件读不出来"。
     */
    fun isZipHead(head: ByteArray): Boolean {
        if (head.size < 4) return false
        if (head[0] != 0x50.toByte() || head[1] != 0x4B.toByte()) return false
        val c = head[2].toInt() and 0xFF
        val d = head[3].toInt() and 0xFF
        return (c == 0x03 || c == 0x05 || c == 0x07) && (d == 0x04 || d == 0x06 || d == 0x08)
    }

    /**
     * 把 zip 条目名归一化成一个**只能落在目标目录内**的相对路径。
     *
     * @return 安全的相对路径（`/` 分隔）；**不安全或为空返回 null**
     *
     * 拒绝的东西：绝对路径（`/x`、`C:/x`）、任何一段是 `..`、空名。
     * 反斜杠先统一成 `/` —— 工具在 Windows 上跑，`normPath` 也会把 `\` 换成 `/`，
     * 这里不换的话 `..\..\x` 会绕过检查（它不是一个合法的 zip 条目名，但**能构造出来**）。
     */
    fun safeEntryName(raw: String): String? {
        var n = raw.trim().replace('\\', '/')
        if (n.isEmpty()) return null
        if (n.startsWith("/")) return null
        // 盘符（C:/…）—— 绝对路径的另一种写法
        if (n.length >= 2 && n[1] == ':') return null
        while (n.startsWith("./")) n = n.substring(2)
        val parts = n.split('/').filter { it.isNotEmpty() }
        if (parts.isEmpty()) return null
        for (p in parts) if (p == "..") return null
        return parts.joinToString("/")
    }

    /** manifest 里的路径 → 与 [safeEntryName] 同一套归一化（只归一化，不判安全） */
    private fun normRel(p: String): String {
        var n = p.trim().replace('\\', '/')
        while (n.startsWith("./")) n = n.substring(2)
        return n
    }

    /** 解析 `manifest.json`。**抛异常 = 这份包根本读不懂**（调用方转成一条明确的问题） */
    fun parseManifest(text: String): Manifest {
        val o = JSONObject(text)
        val assets = ArrayList<Asset>()
        o.optJSONArray("assets")?.let { a ->
            for (i in 0 until a.length()) {
                val e = a.optJSONObject(i) ?: continue
                val p = e.optString("path", "")
                if (p.isBlank()) continue
                val refs = ArrayList<String>()
                e.optJSONArray("refs")?.let { r ->
                    for (j in 0 until r.length()) refs.add(r.optString(j, ""))
                }
                assets.add(
                    Asset(
                        path = p,
                        assetId = e.optString("assetId", ""),
                        refs = refs.filter { it.isNotBlank() },
                        bytes = e.optLong("bytes", -1L),
                        crc32 = e.optLong("crc32", -1L),
                        w = e.optInt("w", 0),
                        h = e.optInt("h", 0),
                    )
                )
            }
        }
        val missing = ArrayList<Missing>()
        o.optJSONArray("missing")?.let { a ->
            for (i in 0 until a.length()) {
                val e = a.optJSONObject(i) ?: continue
                val p = e.optString("path", "")
                if (p.isBlank()) continue
                missing.add(Missing(p, e.optString("reason", "读不到字节")))
            }
        }
        val design = o.optJSONObject("design")
        return Manifest(
            format = o.optString("format", ""),
            designSchema = o.optString("designSchema", ""),
            designName = design?.optString("name", "").orEmpty(),
            exportedAt = o.optString("exportedAt", ""),
            assets = assets,
            missing = missing,
        )
    }

    /** CRC32 的小写十六进制（报错文案里用；**十进制看不出来对不对**） */
    private fun hex32(v: Long): String = "%08x".format(v and 0xFFFFFFFFL)

    // ---------------------------------------------------------------- 解压 + 校验

    /**
     * 解开一个设计包。
     *
     * **要么整个成功、要么整个失败**：任何一条问题都会把已解压的内容删掉，
     * 不留半个目录 —— 半个目录的后果是"表盘上一半卡片是空的"，
     * 而用户只会以为是渲染坏了。
     */
    fun unpack(input: InputStream, destDir: File): Result {
        val problems = ArrayList<String>()
        val warnings = ArrayList<String>()
        /** 归一化路径 → (字节数, CRC32) */
        val written = LinkedHashMap<String, Pair<Long, Long>>()

        try {
            destDir.mkdirs()
            val zip = ZipInputStream(BufferedInputStream(input))
            zip.use { z ->
                while (true) {
                    val e = z.nextEntry ?: break
                    val raw = e.name ?: continue
                    // 目录条目直接跳过：文件的父目录由我们自己建（`out.parentFile.mkdirs()`）
                    if (raw.endsWith("/")) continue
                    val safe = safeEntryName(raw)
                    if (safe == null) {
                        problems += "包里有不安全的条目名「$raw」—— 含 .. 或绝对路径，" +
                            "解压会写到目标目录之外，整个包拒收"
                        return reject(destDir, problems)
                    }
                    val out = File(destDir, safe)
                    // 双保险：归一化之后再核一遍规范化路径（`File` 在不同平台上对
                    // 分隔符/相对段的处理不完全一致，只靠字符串判是不够的）
                    val base = destDir.canonicalPath
                    if (out.canonicalPath != base && !out.canonicalPath.startsWith(base + File.separator)) {
                        problems += "条目「$raw」解压后会落到目标目录之外（$out），整个包拒收"
                        return reject(destDir, problems)
                    }
                    out.parentFile?.mkdirs()
                    val crc = CRC32()
                    var n = 0L
                    out.outputStream().use { os ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val r = z.read(buf)
                            if (r < 0) break
                            os.write(buf, 0, r)
                            crc.update(buf, 0, r)
                            n += r
                        }
                    }
                    written[safe] = n to crc.value
                }
            }
        } catch (t: Throwable) {
            problems += "解压失败：${t.javaClass.simpleName}${t.message?.let { "：$it" } ?: ""}"
            return reject(destDir, problems)
        }

        // ---- manifest ----
        val manifestText = readIfPresent(destDir, MANIFEST_ENTRY)
        if (manifestText == null) {
            problems += "包里没有 $MANIFEST_ENTRY —— 这不是设计包" +
                "（用旧版工具导出的目录请用「选素材文件夹」那条路）"
            return reject(destDir, problems)
        }
        val manifest = try {
            parseManifest(manifestText)
        } catch (t: Throwable) {
            problems += "$MANIFEST_ENTRY 解析失败：${t.message ?: t.javaClass.simpleName}"
            return reject(destDir, problems)
        }
        if (manifest.format != PACK_FORMAT) {
            problems += "包格式是「${manifest.format.ifBlank { "(空)" }}」，本版只认 $PACK_FORMAT" +
                " —— 请升级 App 或用当前版本的 tools/icarui 重新导出"
            return reject(destDir, problems)
        }

        // ---- design.json ----
        val designJson = readIfPresent(destDir, DESIGN_ENTRY)
        if (designJson == null) {
            problems += "包里没有 $DESIGN_ENTRY —— 解开了 ${written.size} 个文件但里面没有设计文件"
            return reject(destDir, problems)
        }

        // ---- 逐条核素材（字节数 + CRC32）----
        val usedKeys = HashSet<String>()
        for (a in manifest.assets) {
            val key = normRel(a.path)
            usedKeys.add(key)
            val got = written[key]
            if (got == null) {
                problems += "素材缺失：${a.path}（清单声明 ${a.bytes} 字节，包里没有这个条目）"
                continue
            }
            if (got.first != a.bytes) {
                problems += "素材字节数不符：${a.path}（清单 ${a.bytes}，实际 ${got.first}）" +
                    " —— 这个文件在包内损坏了"
                continue
            }
            if (got.second != a.crc32) {
                problems += "素材 CRC32 不符：${a.path}" +
                    "（清单 ${hex32(a.crc32)}，实际 ${hex32(got.second)}）—— 这个文件在包内损坏了"
            }
        }
        if (problems.isNotEmpty()) return reject(destDir, problems)

        // ---- 不阻断、但必须让用户看到的 ----
        if (manifest.missing.isNotEmpty()) {
            warnings += "导出时就缺 ${manifest.missing.size} 个素材（工具那边读不到字节），" +
                "这些位置会是空的：" +
                manifest.missing.joinToString("、") { "${it.path}（${it.reason}）" }
        }
        val extra = written.keys.filter { it != DESIGN_ENTRY && it != MANIFEST_ENTRY && it !in usedKeys }
        if (extra.isNotEmpty()) {
            warnings += "包里另有 ${extra.size} 个文件不在素材清单里（不影响导入）：" +
                extra.joinToString("、")
        }

        return Result.Ok(
            dir = destDir,
            manifest = manifest,
            designJson = designJson,
            extractedFiles = written.size,
            warnings = warnings,
        )
    }

    /** 拒收：**把已经解压出来的东西删掉**，不留半个目录（见 [unpack] 的口径） */
    private fun reject(destDir: File, problems: List<String>): Result.Fail {
        runCatching { destDir.deleteRecursively() }
        return Result.Fail(problems)
    }

    private fun readIfPresent(dir: File, name: String): String? {
        val f = File(dir, name)
        if (!f.isFile) return null
        return runCatching { f.readText() }.getOrNull()
    }
}
