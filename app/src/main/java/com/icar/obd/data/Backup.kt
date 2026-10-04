package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * 完整配置备份：一键导出 / 导入。
 *
 * ## 为什么要它
 *
 * 到 v1.4.0 为止，只有 **PID** 能导入导出（`Store.exportPidsJson`）。
 * 但用户真正想备份的是「整套配置」—— PID + 启用状态 + 规则 + 仪表布局 + 主题 + 设置。
 * 少任何一项，换机或重装后都要重新配一遍。
 *
 * ## 设计取舍
 *
 * 1. **导入 = 整体替换，不是合并**。备份的语义是「回到当时的状态」；
 *    合并会让用户已经删掉的 PID / 规则复活，很难理解。
 * 2. **分区独立解析**：某一段坏了（比如手工改坏了 `rules`）不影响其它段导入，
 *    失败信息会汇总返回。
 * 3. **带 `app` 与 `format` 标记**：导入前先确认这是本 App 的备份，
 *    且不是来自更新版本（否则会静默丢字段）。
 */
object Backup {

    const val APP_TAG = "iCarOBD"

    /** 当前备份格式版本。**加字段不用改它，改结构才要** */
    const val FORMAT = 1

    /** 备份规模，用于给用户看「导出了什么」 */
    data class Summary(
        val pids: Int = 0,
        val rules: Int = 0,
        val gauges: Int = 0,
        val themes: Int = 0,
        val enabledOverrides: Int = 0
    ) {
        fun describe(): String =
            "$pids 个自定义 PID · $rules 条规则 · $gauges 个仪表 · $themes 个主题 · $enabledOverrides 条启用状态"
    }

    data class ImportResult(val ok: Boolean, val message: String, val summary: Summary? = null)

    /** 打包全部配置成一个 JSON 字符串 */
    fun export(): String {
        val o = JSONObject()
        o.put("app", APP_TAG)
        o.put("format", FORMAT)
        o.put("exportedAt", System.currentTimeMillis())
        o.put("pids", JSONArray().apply { Store.customPids.forEach { put(it.toJson()) } })
        o.put("enabled", JSONObject().apply { Store.enabledOverride.forEach { (k, v) -> put(k, v) } })
        o.put("rules", JSONArray().apply { Store.rules.forEach { put(it.toJson()) } })
        o.put("gauges", JSONArray().apply { Store.customGauges.forEach { put(it.toJson()) } })
        o.put("themes", JSONArray().apply { Store.customThemeJson.forEach { put(JSONObject(it)) } })
        o.put("settings", Store.settingsToJson())
        return o.toString(2)
    }

    /** 当前配置规模（导出前确认用） */
    fun currentSummary(): Summary = Summary(
        pids = Store.customPids.size,
        rules = Store.rules.size,
        gauges = Store.customGauges.size,
        themes = Store.customThemeJson.size,
        enabledOverrides = Store.enabledOverride.size
    )

    /**
     * 解析并整体替换当前配置。
     * @return 成功与否 + 人类可读的说明（失败时说明哪一段坏了）
     */
    fun import(text: String): ImportResult {
        val root = try {
            JSONObject(text)
        } catch (t: Throwable) {
            return ImportResult(false, "不是合法的 JSON：${t.message}")
        }

        val app = root.optString("app")
        if (app != APP_TAG) {
            return ImportResult(false, "这不是 iCarOBD 的备份文件（app=\"$app\"）")
        }
        val fmt = root.optInt("format", 0)
        if (fmt > FORMAT) {
            return ImportResult(false, "备份来自更新的版本（format=$fmt > $FORMAT），请先升级 App")
        }

        val failures = mutableListOf<String>()
        fun section(name: String, block: () -> Unit) {
            runCatching(block).onFailure { failures += "$name（${it.message ?: "未知错误"}）" }
        }

        section("自定义 PID") {
            val a = root.optJSONArray("pids") ?: JSONArray()
            Store.customPids.clear()
            for (i in 0 until a.length()) Store.customPids.add(PidDefinition.fromJson(a.getJSONObject(i)))
            Store.savePids()
        }
        section("启用状态") {
            val o = root.optJSONObject("enabled") ?: JSONObject()
            Store.enabledOverride.clear()
            o.keys().forEach { k -> Store.enabledOverride[k] = o.getBoolean(k) }
            Store.saveEnabled()
        }
        section("规则") {
            val a = root.optJSONArray("rules") ?: JSONArray()
            Store.rules.clear()
            for (i in 0 until a.length()) Store.rules.add(Rule.fromJson(a.getJSONObject(i)))
            Store.saveRules()
        }
        section("仪表布局") {
            val a = root.optJSONArray("gauges") ?: JSONArray()
            Store.customGauges.clear()
            for (i in 0 until a.length()) Store.customGauges.add(GaugeItem.fromJson(a.getJSONObject(i)))
            // v1.4.0 及以前的备份只有 span（网格），这里补一次迁移
            DashLayout.migrateFromGrid(Store.customGauges)
            Store.saveDash()
        }
        section("主题") {
            val a = root.optJSONArray("themes") ?: JSONArray()
            Store.customThemeJson.clear()
            for (i in 0 until a.length()) Store.customThemeJson.add(a.getJSONObject(i).toString())
            Store.saveThemes()
        }
        section("设置") {
            root.optJSONObject("settings")?.let {
                Store.applySettingsJson(it)
                Store.saveSettings()
            }
        }

        val s = currentSummary()
        return if (failures.isEmpty()) {
            AppLog.i(AppLog.M_DATA, "备份已导入", s.describe())
            ImportResult(true, "导入完成：${s.describe()}", s)
        } else {
            AppLog.w(AppLog.M_DATA, "备份导入有失败段", failures.joinToString("；"))
            ImportResult(false, "部分内容导入失败：${failures.joinToString("；")}", s)
        }
    }
}
