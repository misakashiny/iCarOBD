package com.icar.obd.data

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 配置持久化。全部走 JSON 文件，方便导出/分享/版本对比。
 *
 * 内置 PID 只保存「启用状态覆盖表」，不整份落盘，
 * 这样以后升级内置库不会把用户改过的启用状态冲掉。
 */
object Store {

    data class Settings(
        var protocol: Int = 0,            // ATSP n，0=自动
        var pollIntervalMs: Int = 120,    // 全局轮询间隔
        var autoReconnect: Boolean = true,
        var csvEnabled: Boolean = false,
        var soundEnabled: Boolean = true,
        var mirrorLogcat: Boolean = false,
        var keepScreenOn: Boolean = true,
        var lastDeviceAddress: String = "",
        var lastDeviceName: String = "",
        var dashType: Int = 0,            // 0 普通 1 性能 2 自定义
        var gaugeTheme: Int = 0,          // 0 霓虹 1 冰川 2 经典
        var scanIntervalMs: Int = 150,    // 扫描器请求间隔（限流）
        var scanTimeoutMs: Int = 1500,
        var scanRetry: Int = 1,
        var minLogLevel: String = "V",
        /**
         * 传输方式：`"ble"` = BLE GATT（iCar Pro 2S）；`"spp"` = 经典蓝牙 SPP（iCar Pro BT3.0）。
         * 上层只认 `ObdTransport` 接口，所以这里只是一个字符串开关。
         */
        var transportKind: String = "ble",
        // ---------- 仪表盘参考线 ----------
        /** 是否显示参考线 */
        var gridEnabled: Boolean = false,
        /** 参考线密度：分几列 */
        var gridCols: Int = 6,
        /** 参考线密度：分几行 */
        var gridRows: Int = 4,
        /** 线段样式：0=实线 1=虚线 2=点线 */
        var gridStyle: Int = 1,
        /** 参考线透明度 0..255（颜色由主题派生，不单独存 RGB） */
        var gridAlpha: Int = 60,
        /** 线宽（dp） */
        var gridStrokeDp: Float = 1f,
        /**
         * 拖拽编辑器是否吸附到网格（v1.10.2）。
         *
         * **默认开** —— 与引入本开关之前的行为一致。
         * 关掉后可以停在任意坐标（想微调 3 个单位却被吸到 15 的倍数上，
         * 是拖拽编辑器最常见的抱怨）。边界夹取**始终生效**，与它无关。
         */
        var dashSnapEnabled: Boolean = true,
        /** G 值来源：0=关闭 1=加速度计 2=车速差分（见 `obd/GForceSource`） */
        var gForceMode: Int = 0,
        /** 仪表盘背景图片的绝对路径（空 = 用主题纯色）。导入时会复制到 files/bg/ */
        /**
         * 设计文件的**基目录**（v2）。
         *
         * v2 的素材是**相对路径**（`assets/背景/carbon.png`），
         * 要拼上这个前缀才能读到。导入设计文件时把所在目录记在这里。
         *
         * 留空时相对路径会当「当前工作目录」处理（多半读不到）——
         * 所以导入流程**应该**填它。
         */
        var designBaseDir: String = "",

        /**
         * 导入的 **v2 设计文件原文**（空 = 用扁平的自定义仪表）。
         *
         * 为什么存原文而不是重新序列化：
         *  - [DesignFile.toJson] 写的是 **v1**（v2 渲染刚做完，导出还没切过去）
         *  - 存原文能**原样保留** nodes / assets / controls / 字体 / 状态，
         *    不会因为往返丢字段
         *
         * 代价是 settings.json 会大一些（设计文件几 KB ~ 几十 KB），可接受。
         */
        var designJson: String = "",

        var bgImagePath: String = "",

        /**
         * 背景在设计里的尺寸（**画布单位**，0 = 铺满）。
         *
         * 工具侧允许给背景指定 w/h —— 「这张底图只占中间一块」。
         * 不读这两个字段的话，电脑上缩在中间的图推到设备上会变成全屏拉伸。
         */
        var bgW: Int = 0,
        var bgH: Int = 0,

        /**
         * 当前设计的**缩放模式**（DesignFile.SCALE_STRETCH / FIT / FILL）。
         *
         * 背景定位要用它算换算 —— 而它存在设计文件里，不在设置里。
         * 单独存一份是为了不改渲染路径就能拿到。
         */
        var dashScaleMode: Int = 0,

        /**
         * 设备上显示**哪一页**（多页面设计用）。越界时渲染层会夹到最后一页。
         *
         * 为什么要有它：工具里可以给同一份设计做多页（主页面 / 性能页），
         * 设备上得能选看哪一页 —— 否则多页面在车机上等于没用。
         */
        var dashPageIndex: Int = 0,
        /**
         * 背景铺法（v1.10.2）。取值与 `DesignFile.FIT_*` 一一对应：
         * 0 = 铺满（裁切）1 = 完整显示（可能留边）2 = 居中原始大小。
         *
         * 默认 0（铺满）—— 与引入本项之前的行为一致（旧版就是 centerCrop）。
         */
        var bgFit: Int = 0,
        /**
         * 仪表盘渲染引擎：0 = Android 自绘 View（默认），1 = LVGL（C + SurfaceView）。
         *
         * 保留两个引擎是为了能**并排对比**：LVGL 那条路是新加的，
         * 出问题时切回 0 就能确认是不是渲染层的问题。
         */
        var dashEngine: Int = 0,
    )

    private lateinit var dir: File

    val customPids = mutableListOf<PidDefinition>()
    val enabledOverride = mutableMapOf<String, Boolean>()
    val rules = mutableListOf<Rule>()
    val customGauges = mutableListOf<GaugeItem>()
    var settings = Settings()

    /**
     * 用户自建主题的**原始 JSON**。
     *
     * 刻意存字符串而不是 `GaugeTheme` 对象：`GaugeTheme` 在 `ui/view/`，
     * 而 `data/` 不能反向依赖 `ui/`（分层红线）。schema 由 `GaugeTheme` 自己负责解析。
     */
    val customThemeJson = mutableListOf<String>()

    fun init(baseDir: File) {
        dir = baseDir
        if (!dir.exists()) dir.mkdirs()
        load()
    }

    // ---------------------------------------------------------- load / save

    private fun f(name: String) = File(dir, name)

    fun load() {
        runCatching {
            val a = JSONArray(f("pids.json").takeIf { it.exists() }?.readText() ?: "[]")
            customPids.clear()
            for (i in 0 until a.length()) customPids.add(PidDefinition.fromJson(a.getJSONObject(i)))
        }
        runCatching {
            val o = JSONObject(f("enabled.json").takeIf { it.exists() }?.readText() ?: "{}")
            enabledOverride.clear()
            o.keys().forEach { enabledOverride[it] = o.getBoolean(it) }
        }
        runCatching {
            val a = JSONArray(f("rules.json").takeIf { it.exists() }?.readText() ?: "[]")
            rules.clear()
            for (i in 0 until a.length()) rules.add(Rule.fromJson(a.getJSONObject(i)))
        }
        runCatching {
            val o = JSONObject(f("dash.json").takeIf { it.exists() }?.readText() ?: "{}")
            customGauges.clear()
            val ga = o.optJSONArray("gauges")
            if (ga != null) for (i in 0 until ga.length()) customGauges.add(GaugeItem.fromJson(ga.getJSONObject(i)))
            // v1.4.0 及以前的配置只有 span（网格布局），这里一次性迁到归一化自由坐标并回写，
            // 避免每次启动都迁一遍。
            if (DashLayout.migrateFromGrid(customGauges)) {
                saveDash()
                AppLog.i(
                    AppLog.M_DATA, "仪表布局已迁移",
                    "span 网格 → 归一化自由坐标 count=${customGauges.size}"
                )
            }
        }
        runCatching {
            applySettingsJson(JSONObject(f("settings.json").takeIf { it.exists() }?.readText() ?: "{}"))
        }
        runCatching {
            val a = JSONArray(f("themes.json").takeIf { it.exists() }?.readText() ?: "[]")
            customThemeJson.clear()
            for (i in 0 until a.length()) customThemeJson.add(a.getJSONObject(i).toString())
        }
    }

    /**
     * 设置 ↔ JSON。
     *
     * 抽成一对函数是为了让**完整备份导出/导入**复用同一份 schema ——
     * 备份若自己再写一遍字段列表，以后加设置项必然漏掉一处。
     */
    fun applySettingsJson(o: JSONObject) {
        settings = Settings(
            protocol = o.optInt("protocol", 0),
            pollIntervalMs = o.optInt("pollInterval", 120),
            autoReconnect = o.optBoolean("autoReconnect", true),
            csvEnabled = o.optBoolean("csv", false),
            soundEnabled = o.optBoolean("sound", true),
            mirrorLogcat = o.optBoolean("mirror", false),
            keepScreenOn = o.optBoolean("screenOn", true),
            lastDeviceAddress = o.optString("lastAddr"),
            lastDeviceName = o.optString("lastName"),
            dashType = o.optInt("dashType", 0),
            gaugeTheme = o.optInt("gaugeTheme", 0),
            scanIntervalMs = o.optInt("scanInterval", 150),
            scanTimeoutMs = o.optInt("scanTimeout", 1500),
            scanRetry = o.optInt("scanRetry", 1),
            minLogLevel = o.optString("minLevel", "V"),
            transportKind = o.optString("transport", "ble"),
            gridEnabled = o.optBoolean("gridEnabled", false),
            gridCols = o.optInt("gridCols", 6),
            gridRows = o.optInt("gridRows", 4),
            gridStyle = o.optInt("gridStyle", 1),
            gridAlpha = o.optInt("gridAlpha", 60),
            gridStrokeDp = o.optDouble("gridStrokeDp", 1.0).toFloat(),
            // 缺字段时**默认 true**（老配置没有这一项 → 保持原来"吸附"的手感）
            dashSnapEnabled = o.optBoolean("dashSnap", true),
            gForceMode = o.optInt("gForceMode", 0),
            designBaseDir = o.optString("designBaseDir", ""),
            designJson = o.optString("designJson", ""),
            bgImagePath = o.optString("bgImage", ""),
            bgW = o.optInt("bgW", 0),
            bgH = o.optInt("bgH", 0),
            dashScaleMode = o.optInt("dashScaleMode", 0),
            dashPageIndex = o.optInt("dashPageIndex", 0),
            bgFit = o.optInt("bgFit", 0),
            // ⚠️ **强制 0**：LVGL 引擎已放弃（见 docs/LVGL-放弃记录.md）。
            //
            // 已装设备上存的可能是 1（调试时留下的），这里直接归零 ——
            // 否则用户升级后仍然进 LVGL 路径，看到的就是卡顿和「应用无响应」。
            //
            // 等 LVGL 代码真正删掉之后，这个字段本身也该一起去掉。
            dashEngine = 0,
        )
    }

    fun savePids() = runCatching {
        f("pids.json").writeText(JSONArray().apply { customPids.forEach { put(it.toJson()) } }.toString(2))
    }

    fun saveEnabled() = runCatching {
        f("enabled.json").writeText(JSONObject().apply { enabledOverride.forEach { put(it.key, it.value) } }.toString(2))
    }

    fun saveRules() = runCatching {
        f("rules.json").writeText(JSONArray().apply { rules.forEach { put(it.toJson()) } }.toString(2))
    }

    fun saveDash() = runCatching {
        f("dash.json").writeText(JSONObject().apply {
            put("gauges", JSONArray().apply { customGauges.forEach { put(it.toJson()) } })
        }.toString(2))
    }

    fun settingsToJson(): JSONObject = JSONObject().apply {
        put("protocol", settings.protocol)
        put("pollInterval", settings.pollIntervalMs)
        put("autoReconnect", settings.autoReconnect)
        put("csv", settings.csvEnabled)
        put("sound", settings.soundEnabled)
        put("mirror", settings.mirrorLogcat)
        put("screenOn", settings.keepScreenOn)
        put("lastAddr", settings.lastDeviceAddress)
        put("lastName", settings.lastDeviceName)
        put("dashType", settings.dashType)
        put("gaugeTheme", settings.gaugeTheme)
        put("scanInterval", settings.scanIntervalMs)
        put("scanTimeout", settings.scanTimeoutMs)
        put("scanRetry", settings.scanRetry)
        put("minLevel", settings.minLogLevel)
        put("transport", settings.transportKind)
        put("gridEnabled", settings.gridEnabled)
        put("gridCols", settings.gridCols)
        put("gridRows", settings.gridRows)
        put("gridStyle", settings.gridStyle)
        put("gridAlpha", settings.gridAlpha)
        put("gridStrokeDp", settings.gridStrokeDp.toDouble())
        put("dashSnap", settings.dashSnapEnabled)
        put("gForceMode", settings.gForceMode)
        put("designBaseDir", settings.designBaseDir)
        put("designJson", settings.designJson)
        put("bgImage", settings.bgImagePath)
        put("bgW", settings.bgW)
        put("bgH", settings.bgH)
        put("dashScaleMode", settings.dashScaleMode)
        put("dashPageIndex", settings.dashPageIndex)
        put("bgFit", settings.bgFit)
        put("dashEngine", settings.dashEngine)
    }

    fun saveSettings() = runCatching {
        f("settings.json").writeText(settingsToJson().toString(2))
    }

    fun saveThemes() = runCatching {
        f("themes.json").writeText(
            JSONArray().apply { customThemeJson.forEach { put(JSONObject(it)) } }.toString(2)
        )
    }

    // ---------------------------------------------------------- PID 集合

    /** 内置 + 自定义，并应用启用状态覆盖 */
    fun allPids(): List<PidDefinition> {
        val out = ArrayList<PidDefinition>()
        BuiltInPids.all().forEach { p ->
            enabledOverride[p.id]?.let { p.enabled = it }
            out.add(p)
        }
        customPids.forEach { out.add(it) }
        return out
    }

    fun findPid(id: String): PidDefinition? = allPids().firstOrNull { it.id == id }

    fun isEnabled(id: String): Boolean {
        enabledOverride[id]?.let { return it }
        return allPids().firstOrNull { it.id == id }?.enabled ?: false
    }

    fun setEnabled(id: String, on: Boolean) {
        enabledOverride[id] = on
        saveEnabled()
    }

    fun upsertPid(p: PidDefinition) {
        val i = customPids.indexOfFirst { it.id == p.id }
        if (i >= 0) customPids[i] = p else customPids.add(p)
        savePids()
    }

    fun deletePid(id: String) {
        customPids.removeAll { it.id == id }
        customGauges.removeAll { it.pidId == id }
        savePids(); saveDash()
    }

    fun upsertRule(r: Rule) {
        val i = rules.indexOfFirst { it.id == r.id }
        if (i >= 0) rules[i] = r else rules.add(r)
        saveRules()
    }

    fun deleteRule(id: String) {
        rules.removeAll { it.id == id }
        saveRules()
    }

    // ---------------------------------------------------------- 导入导出

    /** 导出全部自定义 PID（可直接分享给别人） */
    fun exportPidsJson(): String = JSONArray().apply { customPids.forEach { put(it.toJson()) } }.toString(2)

    fun importPidsJson(text: String): Int {
        val a = JSONArray(text)
        var n = 0
        for (i in 0 until a.length()) {
            val p = PidDefinition.fromJson(a.getJSONObject(i))
            // 强制新 id，避免与本地现有条目冲突
            p.id = java.util.UUID.randomUUID().toString()
            customPids.add(p); n++
        }
        savePids()
        return n
    }

    /**
     * 把内置的「厂家 PID 模板」复制成**可编辑的自定义 PID**。
     *
     * 这是给阿特兹研究工作流用的起点：模板里的 PID 号是占位值，
     * 用扫描器扫出真实地址后，在 PID 编辑器里改号 → 测试 → 保存 → 启用。
     * 复制出来的条目 builtIn=false，因此可以随便改、随便删。
     */
    fun importTemplatesAsCustom(): Int {
        var n = 0
        BuiltInPids.MANUFACTURER_TEMPLATES.forEach { t ->
            val copy = t.copy(
                id = java.util.UUID.randomUUID().toString(),
                builtIn = false,
                enabled = false,
                group = "阿特兹候选(待验证)"
            )
            customPids.add(copy)
            n++
        }
        savePids()
        return n
    }
}
