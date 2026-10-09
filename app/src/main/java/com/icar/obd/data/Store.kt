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
        /**
         * **真的收到过车辆数据**（v1.19.2）。
         *
         * 用来把「开机自动连」限定在**确认能用过的设备**上 —— 只看 `lastDeviceAddress`
         * 不够：那个字段在「点了连接但连不上 / 连上了却读不到数据」时也会被写进去，
         * 于是下次开机会对着一个连不通的适配器反复尝试。
         *
         * 只在**第一次真的解析出数值**时置位（见 ObdController 里的 VehicleBus 监听）。
         */
        var everGotData: Boolean = false,
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

        /**
         * **油箱容量（L）** —— 只用于「续航里程」派生通道（v1.17.5）。
         *
         * ```
         * 续航 = 油量% × 油箱容量 ÷ 平均油耗(L/100km) × 100
         * ```
         *
         * ## 为什么必须问用户
         *
         * OBD **读不到油箱容量** —— 它连"油量%"都只有部分车支持（`012F`），
         * 容量更是纯车辆参数（阿特兹 2.0/2.5 是 62L，紧凑车 40~50L）。
         * 猜一个数字会让续航**看起来像真的但差很多**，比不显示更糟。
         *
         * 默认 50L 只是"能算出个数"的起点，界面上明确标了要用户确认。
         * 填 0 或负数 = **关闭续航**（通道不出值，仪表显示 `--`）。
         */
        var tankCapacityL: Float = 50f,

        // ---------- 多画布（方案 A，v1.20.0）----------

        /**
         * **全部画布**，数组顺序 = 横滑的页序。
         *
         * 空 = 这台设备还是旧配置（三选一 + 全局 `customGauges`），
         * 由 [Store.migrateLegacyToCanvas] 一次性包成第一套画布。
         *
         * 为什么不单独放一个 `canvases.json`：画布是**配置的一部分**，
         * 而 [Store.settingsToJson] 已经是「完整备份」的 schema ——
         * 放进来，备份/恢复自动带上多画布，不用再维护第三份字段清单。
         */
        var canvases: MutableList<DashCanvas> = mutableListOf(),

        /**
         * 当前画布的 id。**唯一权威**是它 ——
         * `dashType` / `gaugeTheme` / `designJson` / `bg*` / `dashPageIndex`
         * 都只是"当前画布"的实时副本（见 [Store.snapshotToActiveCanvas]）。
         *
         * 指向不存在的 id 时由 [Store.activeCanvas] 兜回第一套，不会崩。
         */
        var activeCanvasId: String = "",

        /**
         * 画布名浮标画在哪个角（v1.20.1），取值见 [DashCanvas.NAME_POS_*]。
         *
         * **全局偏好，不跟着画布走** —— 跟着走的话，横滑时小字会在四个角之间乱跳。
         */
        var canvasNamePos: Int = DashCanvas.NAME_POS_TOP_START,

        // ---------- 双指手势（v1.20.9）----------

        /**
         * 四个双指手势各绑一个动作，取值见 [GestureActions]。
         *
         * 默认值 = [GestureActions.DEFAULTS]（右滑呼出导航、左滑收起导航、上下翻画布）。
         * **旧配置里没有这四个键** —— [Store.applySettingsJson] 用 `optString` 逐个兜默认值，
         * 所以升级后手感不变（这一条有单测钉着）。
         *
         * 为什么不存成一个数组：四个键各自独立，缺哪个兜哪个 —— 数组缺一项就整份作废。
         */
        var gestureLeft: String = GestureActions.DEFAULTS[GestureActions.SLOT_LEFT],
        var gestureRight: String = GestureActions.DEFAULTS[GestureActions.SLOT_RIGHT],
        var gestureUp: String = GestureActions.DEFAULTS[GestureActions.SLOT_UP],
        var gestureDown: String = GestureActions.DEFAULTS[GestureActions.SLOT_DOWN],

        // ---------- 最近一次导入设计文件（v1.20.6）----------

        /**
         * **最近一次成功导入**的设计文件：文件名 / 几块表 / 时间。
         *
         * ## 为什么需要它（用户报过两次）
         *
         * "导入设计文件之后画布还是空的" —— 查了半天才发现是**根本没导进去**
         * （选错了文件、解析失败后没注意、或者选完素材文件夹又没重新应用）。
         * 界面上没有任何"上次到底导了什么"的痕迹，所以只能靠翻日志。
         *
         * 这三个字段就是那条**一眼可见**的记录（画布设置页显示，
         * 例：`未命名设计-v1.json · 5 块表 · 10-08 21:30`）。
         *
         * 存在 settings 里而不是单独的记录文件：`settingsToJson` 已经是"完整备份"的
         * schema，放进来备份/恢复自动带上，不用再维护第三份字段清单。
         */
        var lastImportName: String = "",
        /** 那次导入**实际应用**了几块表（不是设计文件里声明了几块 —— 两者可能不同） */
        var lastImportGauges: Int = 0,
        /** 导入成功的时刻（`System.currentTimeMillis()`）。0 = 从没导入过 */
        var lastImportAt: Long = 0L,
    ) {
        /**
         * 「最近一次导入」的一行摘要；从没导入过返回**空串**。
         *
         * 放在 data 层而不是 Fragment 里：这是**纯函数**，放这儿才能被 JVM 单测覆盖
         * （Fragment 里的格式化永远测不到，而"记录写没写对"恰恰是最容易悄悄坏的地方）。
         */
        fun lastImportSummary(): String {
            if (lastImportAt <= 0L) return ""
            val ts = java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.getDefault())
                .format(java.util.Date(lastImportAt))
            val name = lastImportName.ifBlank { "未命名设计" }
            return "$name · $lastImportGauges 块表 · $ts"
        }

        /**
         * 某个双指手势绑的动作（**读**）。
         *
         * ⚠️ 必须走 [GestureActions.normalize]：设置页显示的映射与 `MainActivity`
         * 真的执行的动作**只能有这一个来源**。读原始字段的话，一份手改坏了的
         * `settings.json` 会出现"设置页说右滑呼出导航、实际什么都不做"。
         */
        fun gestureAt(slot: Int): String = GestureActions.normalize(slot, rawGesture(slot))

        /** 某个双指手势绑的动作（**写**）。写入前归一化，保证落盘的永远是合法 id */
        fun setGestureAt(slot: Int, actionId: String) {
            val v = GestureActions.normalize(slot, actionId)
            when (slot) {
                GestureActions.SLOT_LEFT -> gestureLeft = v
                GestureActions.SLOT_RIGHT -> gestureRight = v
                GestureActions.SLOT_UP -> gestureUp = v
                GestureActions.SLOT_DOWN -> gestureDown = v
            }
        }

        /** 设置页那一行「当前：…」；格式化只有一处（[GestureActions.summary]，纯函数有单测） */
        fun gestureSummary(): String =
            GestureActions.summary(listOf(gestureLeft, gestureRight, gestureUp, gestureDown))

        private fun rawGesture(slot: Int): String = when (slot) {
            GestureActions.SLOT_LEFT -> gestureLeft
            GestureActions.SLOT_RIGHT -> gestureRight
            GestureActions.SLOT_UP -> gestureUp
            GestureActions.SLOT_DOWN -> gestureDown
            else -> GestureActions.NONE
        }
    }

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
            // v1.19.9 迁移：转向灯从占位模板 `tpl_left_turn`/`tpl_right_turn`
            // 换成了实车确认的监听型 `mon_turn_left`/`mon_turn_right`
            // （见 BuiltInPids 与 stage/oncar-evidence/turn-signal-09A.md）。
            //
            // ⚠️ 不迁的话，存量 `rules.json` 里那两条规则会指向一个**不存在的 id** ——
            // 而 `RuleEngine` 拿不到值时是"条件不成立"，**不会报错、不会提示**，
            // 表现为"转向灯拨了但就是不响"，极难查。改过才回写盘，避免每次启动都写。
            if (migrateTurnRules()) saveRules()
        }
        // ⚠️ 顺序要紧（v1.20.0）：**先读设置（含多画布），再读旧的 dash.json**。
        //
        // 旧顺序（先 dash.json 后 settings.json）会踩一个很脏的坑：
        // dash.json 的网格迁移里会调 saveDash()，而 saveDash() 现在要把画布落盘 →
        // 会拿**还没加载的默认 settings** 覆写 settings.json ——
        // 用户的轮询间隔、主题、画布全被冲成出厂值，而且日志里一条都不提。
        runCatching {
            applySettingsJson(JSONObject(f("settings.json").takeIf { it.exists() }?.readText() ?: "{}"))
        }
        runCatching {
            if (settings.canvases.isEmpty()) {
                // ---- 旧配置（v1.19.x 及以前）：三选一 + 全局扁平表 + 全局设计文件 ----
                val o = JSONObject(f("dash.json").takeIf { it.exists() }?.readText() ?: "{}")
                customGauges.clear()
                val ga = o.optJSONArray("gauges")
                if (ga != null) for (i in 0 until ga.length()) customGauges.add(GaugeItem.fromJson(ga.getJSONObject(i)))
                // v1.4.0 及以前的配置只有 span（网格布局），这里一次性迁到归一化自由坐标并回写，
                // 避免每次启动都迁一遍。
                val gridMigrated = DashLayout.migrateFromGrid(customGauges)
                migrateLegacyToCanvas()
                if (gridMigrated) saveDash()
            }
            // 有画布的分支已经在 applySettingsJson 末尾 loadActiveCanvas() 过了，
            // 这里不再重复 —— 重复是幂等的，但会让"谁负责同步"变得含糊。
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
            everGotData = o.optBoolean("everGotData", false),
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
            // 油箱容量（L）：续航里程派生用。旧文件没有这个字段 → 50L 兜底
            tankCapacityL = o.optDouble("tankCapacityL", 50.0).toFloat(),
            // 多画布（v1.20.0）。旧文件没有这两个键 → 空列表 + 空 id，
            // 交给 load() / 备份导入走一次性迁移 —— 这里**不能**硬造一套，
            // 因为扁平表在 dash.json 里，这里读不到。
            canvases = DashCanvas.listFromJson(o.optJSONArray("canvases")),
            activeCanvasId = o.optString("activeCanvasId", ""),
            // 越界值**在读取时就夹住**：这个值会被当成 Gravity 分支的输入，
            // 让一个手改坏的 settings.json 落到未知分支是不必要的风险
            canvasNamePos = o.optInt("canvasNamePos", DashCanvas.NAME_POS_TOP_START)
                .coerceIn(0, DashCanvas.NAME_POS_HIDDEN),
            // 双指手势（v1.20.9）。旧配置**没有这四个键** → 逐个兜出厂默认值，
            // 于是"升级不改变已有手感"（右滑呼出 / 左滑收起），上下两个方向是新增的。
            // ⚠️ 兜底值必须写 [GestureActions.DEFAULTS]，**不能**写字符串字面量 ——
            // 两处各写一份的话，以后改默认值必然漏掉一处（表现是"默认值和文档不一样"）。
            gestureLeft = GestureActions.normalize(
                GestureActions.SLOT_LEFT, o.optString("gestureLeft", "")
            ),
            gestureRight = GestureActions.normalize(
                GestureActions.SLOT_RIGHT, o.optString("gestureRight", "")
            ),
            gestureUp = GestureActions.normalize(
                GestureActions.SLOT_UP, o.optString("gestureUp", "")
            ),
            gestureDown = GestureActions.normalize(
                GestureActions.SLOT_DOWN, o.optString("gestureDown", "")
            ),
            // 最近一次导入（v1.20.6）。旧配置没有这三个键 → 空记录，
            // 设置页显示"还没导入过"（**不要**兜一个假时间，那比空更糟）
            lastImportName = o.optString("lastImportName", ""),
            lastImportGauges = o.optInt("lastImportGauges", 0),
            lastImportAt = o.optLong("lastImportAt", 0L),
        )
        // 有画布 → 立刻把「当前画布」灌进实时字段。
        //
        // 抽在这里，而不是让每个调用方自己记得同步：调用方（load / 备份导入）
        // 在返回后读 settings.dashType / Store.customGauges 就必须已经是当前画布的值，
        // 否则备份导入会拿**上一台设备的实时字段**去覆写刚导进来的画布（静默丢配置）。
        if (settings.canvases.isNotEmpty()) loadActiveCanvas()
    }

    fun savePids() = runCatching {
        f("pids.json").writeText(JSONArray().apply { customPids.forEach { put(it.toJson()) } }.toString(2))
    }

    fun saveEnabled() = runCatching {
        f("enabled.json").writeText(JSONObject().apply { enabledOverride.forEach { put(it.key, it.value) } }.toString(2))
    }

    /**
     * v1.19.9 的一次性迁移：转向灯规则的数据源改名。
     *
     * `tpl_left_turn` -> `mon_turn_left`，`tpl_right_turn` -> `mon_turn_right`。
     * 名字换了是因为它们**不再是"厂家模板占位示例"**：2026-10-06 实车确认了
     * CAN `0x09A` 的 bit2/bit3，已改成 `source = "monitor"` 的监听型 PID。
     *
     * @return 是否真的改过（只有改过才需要回写 `rules.json`）
     */
    private fun migrateTurnRules(): Boolean {
        val map = mapOf("tpl_left_turn" to "mon_turn_left", "tpl_right_turn" to "mon_turn_right")
        var changed = false
        for (r in rules) {
            for (c in r.conditions) {
                val to = map[c.sourceId] ?: continue
                AppLog.w(AppLog.M_SYS, "规则迁移(转向灯)", "${r.name}: ${c.sourceId} -> $to")
                c.sourceId = to
                changed = true
            }
        }
        return changed
    }
    fun saveRules() = runCatching {
        f("rules.json").writeText(JSONArray().apply { rules.forEach { put(it.toJson()) } }.toString(2))
    }

    /**
     * 把**当前画布**的内容落盘。做两件事：
     *
     * 1. `dash.json` —— **旧格式镜像**。留着是有意的：降级回 v1.19.x 时那份文件
     *    仍然读得到用户的扁平表（否则降级 = 盘面全空，而用户不会想到是降级导致的）。
     * 2. `settings.json` —— 画布真正住的地方（v1.20.0 起）。
     *
     * ⚠️ 因此它**不能在 `load()` 读完 settings.json 之前被调用** ——
     * 那会拿默认设置覆写 `settings.json`（旧代码里 dash.json 的网格迁移就会调它）。
     * 见 [load] 顶部那段顺序说明。
     */
    fun saveDash() = runCatching {
        f("dash.json").writeText(JSONObject().apply {
            put("gauges", JSONArray().apply { customGauges.forEach { put(it.toJson()) } })
        }.toString(2))
        saveSettings()
    }

    fun settingsToJson(): JSONObject = JSONObject().apply {
        // ⚠️ 先同步再序列化：调用方（saveSettings / 备份导出）读的是**实时字段**，
        // 而画布才是权威。不同步就会把"上一次切画布时"的旧内容写回去，
        // 表现为"改完不生效，切一下画布又对了"。
        snapshotToActiveCanvas()
        put("protocol", settings.protocol)
        put("pollInterval", settings.pollIntervalMs)
        put("autoReconnect", settings.autoReconnect)
        put("csv", settings.csvEnabled)
        put("sound", settings.soundEnabled)
        put("mirror", settings.mirrorLogcat)
        put("screenOn", settings.keepScreenOn)
        put("lastAddr", settings.lastDeviceAddress)
        put("lastName", settings.lastDeviceName)
        put("everGotData", settings.everGotData)
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
        put("tankCapacityL", settings.tankCapacityL.toDouble())
        // ---- 多画布（v1.20.0）----
        //
        // 数组顺序 = 横滑页序，所以**不要**按 id 排序。
        // `activeCanvasId` 与上面的 dashType/gaugeTheme/... 有冗余，但冗余是有用的：
        // 旧版本读到这些键仍能正常显示（只是只认当前那一套）。
        put("activeCanvasId", settings.activeCanvasId)
        put("canvases", JSONArray().apply { settings.canvases.forEach { put(it.toJson()) } })
        // 画布名浮标的位置：全局偏好（与"当前是哪一套"无关）
        put("canvasNamePos", settings.canvasNamePos)
        // 双指手势（v1.20.9）：全局偏好。写出去的是**归一化后**的值
        // （读回来的可能是手改坏的串，见 Settings.gestureAt）
        put("gestureLeft", settings.gestureAt(GestureActions.SLOT_LEFT))
        put("gestureRight", settings.gestureAt(GestureActions.SLOT_RIGHT))
        put("gestureUp", settings.gestureAt(GestureActions.SLOT_UP))
        put("gestureDown", settings.gestureAt(GestureActions.SLOT_DOWN))
        // 最近一次导入的设计文件（v1.20.6）—— 设置页那条"一眼可见"的记录
        put("lastImportName", settings.lastImportName)
        put("lastImportGauges", settings.lastImportGauges)
        put("lastImportAt", settings.lastImportAt)
    }

    fun saveSettings() = runCatching {
        f("settings.json").writeText(settingsToJson().toString(2))
    }

    fun saveThemes() = runCatching {
        f("themes.json").writeText(
            JSONArray().apply { customThemeJson.forEach { put(JSONObject(it)) } }.toString(2)
        )
    }

    // ---------------------------------------------------------- 多画布（v1.20.0）

    /**
     * 当前画布。**永不返回 null、永不返回空** ——
     *
     *  - 列表为空（全新安装 / 刚导入一份旧备份）→ 就地补一套默认画布；
     *  - [Settings.activeCanvasId] 指向已删除的 id → 落到第一套并**改写 id**。
     *
     * 自愈放在这里而不是在调用方，是因为调用方太多（渲染、编辑器、设置页、
     * `customGauges` 的每一次读写），任何一处漏判都会 NPE。
     */
    fun activeCanvas(): DashCanvas {
        if (settings.canvases.isEmpty()) settings.canvases.add(DashCanvas())
        val cur = settings.canvases.firstOrNull { it.id == settings.activeCanvasId }
        if (cur != null) return cur
        val first = settings.canvases.first()
        settings.activeCanvasId = first.id
        return first
    }

    fun canvasIndex(id: String): Int = settings.canvases.indexOfFirst { it.id == id }

    fun activeCanvasIndex(): Int = canvasIndex(settings.activeCanvasId).coerceAtLeast(0)

    /**
     * **实时字段 → 当前画布**。
     *
     * 画布是权威、实时字段是工作区，两者靠这一对函数同步。
     * 每次 `saveSettings()` / `saveDash()` 都会先调它 —— 所以用户改完东西
     * 不需要"记得保存画布"。
     */
    fun snapshotToActiveCanvas() {
        val c = activeCanvas()
        c.type = settings.dashType.coerceIn(DashCanvas.TYPE_NORMAL, DashCanvas.TYPE_CUSTOM)
        // 浅拷：GaugeItem 实例保持同一批，与 DashCanvasEditorView 的就地编辑约定一致
        c.gauges = ArrayList(customGauges)
        c.designJson = settings.designJson
        c.theme = settings.gaugeTheme
        c.pageIndex = settings.dashPageIndex
        c.bgImagePath = settings.bgImagePath
        c.bgW = settings.bgW
        c.bgH = settings.bgH
        c.bgFit = settings.bgFit
        c.scaleMode = settings.dashScaleMode
    }

    /** **当前画布 → 实时字段**（切画布 / 加载配置时用） */
    fun loadActiveCanvas() {
        val c = activeCanvas()
        settings.dashType = c.type.coerceIn(DashCanvas.TYPE_NORMAL, DashCanvas.TYPE_CUSTOM)
        settings.designJson = c.designJson
        settings.gaugeTheme = c.theme
        settings.dashPageIndex = c.pageIndex
        settings.bgImagePath = c.bgImagePath
        settings.bgW = c.bgW
        settings.bgH = c.bgH
        settings.bgFit = c.bgFit
        settings.dashScaleMode = c.scaleMode
        customGauges.clear()
        customGauges.addAll(c.gauges)
    }

    /**
     * 切到某一套画布。
     *
     * 顺序要紧：**先**把实时字段落回当前画布，**再**换 id 并加载新的 ——
     * 反过来会把刚改完的内容写进新画布（用户会看到"切过去之后上一套被覆盖了"）。
     *
     * @return false = 该 id 不存在（调用方应忽略这次切换，而不是崩）
     */
    fun switchCanvas(id: String): Boolean {
        val target = settings.canvases.firstOrNull { it.id == id } ?: return false
        if (target.id == settings.activeCanvasId) return true
        snapshotToActiveCanvas()
        settings.activeCanvasId = target.id
        loadActiveCanvas()
        saveSettings()
        AppLog.i(
            AppLog.M_DATA, "已切换画布",
            "name=${target.name} type=${target.type} gauges=${target.gauges.size} " +
                "index=${activeCanvasIndex()}/${settings.canvases.size}"
        )
        return true
    }

    /**
     * 新增一套画布并**立刻切过去**。
     *
     * 为什么自动切：用户点「新增」就是想看那一套 —— 不切的话他会滑过去发现
     * 还是旧盘面（因为"当前画布"没变），看起来像按钮没生效。
     *
     * 初始内容按类型给（普通/性能 = 内置布局，自定义 = 空表）；
     * **配色跟随当前这一套**（一上来就是同一个观感），
     * 但**背景图与设计文件不继承** —— 那是上一套"作品"的一部分，
     * 抄过来只会让人以为串台了。
     *
     * @return null = 已达上限 [DashCanvas.MAX_CANVASES]
     */
    fun addCanvas(name: String, type: Int): DashCanvas? {
        if (settings.canvases.size >= DashCanvas.MAX_CANVASES) return null
        val t = type.coerceIn(DashCanvas.TYPE_NORMAL, DashCanvas.TYPE_CUSTOM)
        val c = DashCanvas(
            name = DashCanvas.sanitizeName(name),
            type = t,
            gauges = when (t) {
                DashCanvas.TYPE_PERF -> ArrayList(DashLayout.perf())
                DashCanvas.TYPE_CUSTOM -> ArrayList()
                else -> ArrayList(DashLayout.normal())
            },
            theme = settings.gaugeTheme,
        )
        snapshotToActiveCanvas()
        settings.canvases.add(c)
        settings.activeCanvasId = c.id
        loadActiveCanvas()
        saveSettings()
        AppLog.i(
            AppLog.M_DATA, "已新增画布",
            "name=${c.name} type=$t index=${activeCanvasIndex()}/${settings.canvases.size}"
        )
        return c
    }

    /**
     * 删除一套画布。
     *
     * **至少留一套** —— 删空之后横滑没有页、`customGauges` 没有归属，
     * 整个仪表盘页就是一片空白，比"删不掉"难查得多。
     *
     * @return false = 只剩一套 / id 不存在
     */
    fun removeCanvas(id: String): Boolean {
        if (settings.canvases.size <= 1) return false
        val i = canvasIndex(id)
        if (i < 0) return false
        val removed = settings.canvases.removeAt(i)
        if (settings.activeCanvasId == id) {
            // 落到原位置的邻居；删的是最后一套就落到新的最后一套
            val next = settings.canvases[i.coerceAtMost(settings.canvases.size - 1)]
            settings.activeCanvasId = next.id
            loadActiveCanvas()
        }
        saveSettings()
        AppLog.i(
            AppLog.M_DATA, "已删除画布",
            "name=${removed.name} 剩余=${settings.canvases.size} 当前=${activeCanvas().name}"
        )
        return true
    }

    fun renameCanvas(id: String, name: String): Boolean {
        val c = settings.canvases.firstOrNull { it.id == id } ?: return false
        c.name = DashCanvas.sanitizeName(name)
        saveSettings()
        return true
    }

    /**
     * 调整画布顺序（横滑页序）。
     *
     * 只动列表顺序、**不动 [Settings.activeCanvasId]** —— 当前看的那一套
     * 不该因为别人换位置而变。
     */
    fun moveCanvas(from: Int, to: Int): Boolean {
        val n = settings.canvases.size
        if (from !in 0 until n || to !in 0 until n || from == to) return false
        val c = settings.canvases.removeAt(from)
        settings.canvases.add(to, c)
        saveSettings()
        AppLog.i(AppLog.M_DATA, "画布已排序", "${c.name}: $from -> $to")
        return true
    }

    /**
     * **一次性迁移**：把 v1.19.x 的「三选一 + 全局扁平表 + 全局设计文件 + 全局背景」
     * 包成第一套画布，名叫 [DashCanvas.DEFAULT_NAME]。
     *
     * 只做**打包**，不改任何取值 —— 迁移完用户看到的东西必须和升级前一模一样，
     * 否则"升级之后盘面变了"会成为一个说不清的 bug。
     */
    private fun migrateLegacyToCanvas() {
        val c = DashCanvas(
            name = DashCanvas.DEFAULT_NAME,
            type = settings.dashType.coerceIn(DashCanvas.TYPE_NORMAL, DashCanvas.TYPE_CUSTOM),
            gauges = ArrayList(customGauges),
            designJson = settings.designJson,
            theme = settings.gaugeTheme,
            pageIndex = settings.dashPageIndex,
            bgImagePath = settings.bgImagePath,
            bgW = settings.bgW,
            bgH = settings.bgH,
            bgFit = settings.bgFit,
            scaleMode = settings.dashScaleMode,
        )
        settings.canvases.add(c)
        settings.activeCanvasId = c.id
        saveSettings()
        AppLog.i(
            AppLog.M_DATA, "配置已迁移到多画布",
            "第 1 套「${c.name}」type=${c.type} gauges=${c.gauges.size} " +
                "design=${if (c.designJson.isBlank()) "无" else "有"} theme=${c.theme}"
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

    fun upsertPid(p: PidDefinition) = upsertPids(listOf(p))

    /**
     * **批量** upsert（v1.20.7，S1 信号表导入用）。
     *
     * 为什么不循环调 [upsertPid]：它每次都 `savePids()`（把整份 `pids.json`
     * 序列化一遍再写盘）。导入一份信号表可能有几十上百行，
     * 而导入是在**主线程**的 SAF 回调里跑的 —— N 次全量写盘足够卡出 ANR。
     * 这里只写一次。
     */
    fun upsertPids(list: List<PidDefinition>) {
        if (list.isEmpty()) return
        list.forEach { p ->
            val i = customPids.indexOfFirst { it.id == p.id }
            if (i >= 0) customPids[i] = p else customPids.add(p)
        }
        savePids()
    }

    fun deletePid(id: String) {
        customPids.removeAll { it.id == id }
        customGauges.removeAll { it.pidId == id }
        // ⚠️ v1.20.12：启用状态覆盖也要一起清掉。
        // 不清的话 `enabled.json` 会永久留着一个指向已删条目的 id
        // （每删一条攒一个，谁也不知道它是什么），而且"删除后重新建一条同 id"
        // 会被这条陈旧覆盖静默改掉启用状态。
        if (enabledOverride.remove(id) != null) saveEnabled()
        savePids(); saveDash()
    }

    /**
     * **清理重复 PID**（v1.20.12）—— 用户要求「检查 PID 页面、将重复多余的清除掉」。
     *
     * ## 为什么是一个动作，而不是"这一版手工删几条"
     *
     * 重复不是一次性的：导入别人的 JSON（[importPidsJson] 会给每条换新 id）、
     * 从 CAN 探测里"加为监听"、复制厂家模板 —— 每一条路都可能再产生一批。
     * 所以给一个**可重复执行**的清理入口，判据在 [PidDedup]（纯逻辑，有单测）。
     *
     * ## 安全闸（三样缺一不可）
     *
     * 1. **只删自定义**：`builtIn=true` 的条目一律不碰 —— 内置表是刻意设计的，
     *    删了会让别的画布/设计文件里的别名对不上；
     * 2. **被引用的不删**：任何仪表或规则的 `pidId`/`sourceId` 指向它就不删 ——
     *    否则仪表会变空、规则永远不成立（任务里那条硬约束）；
     * 3. **先返回清单，由调用方确认**：这里**只负责算和删**，
     *    不负责弹窗 —— 界面上必须先把"要删哪些、为什么"显示给用户看。
     *
     * @return 实际删掉的条数
     */
    fun cleanupDuplicatePids(): List<PidDedup.Duplicate> {
        val gaugeIds = customGauges.map { it.pidId }
        val ruleIds = rules.flatMap { r -> r.conditions.map { it.sourceId } }
        val dups = PidDedup.removable(
            PidDedup.findDuplicates(allPids()), gaugeIds, ruleIds
        )
        if (dups.isEmpty()) return emptyList()
        dups.forEach { d ->
            customPids.removeAll { it.id == d.pid.id }
            customGauges.removeAll { it.pidId == d.pid.id }
            enabledOverride.remove(d.pid.id)
        }
        savePids(); saveDash(); saveEnabled()
        AppLog.i(
            AppLog.M_DATA, "已清理重复 PID",
            "删=${dups.size} 条：${dups.joinToString(", ") { "${it.pid.name}(${it.reason})" }}"
        )
        return dups
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
     *
     * ## ⚠️ v1.20.12 修：**不许复制已经实车确认的监听型**
     *
     * 原实现无条件复制 `MANUFACTURER_TEMPLATES` 全表，而那张表里混着
     * **两条实车确认过的真条目**（`mon_turn_left` / `mon_turn_right`，
     * 2026-10-06 在阿特兹上确认：CAN `0x09A` 的 bit2/bit3）。
     * 复制它们的结果是 PID 页里**凭空多出两条一模一样的信号** ——
     * 同一个报文、同一个位段，只是 id 和分组不同（副本还 `enabled=false`，纯死重量）。
     * 这正是用户说的「重复多余的」。
     *
     * 判据用 [PidDedup.isMonitor]：**监听型一律不复制**（它们不是"待验证的占位模板"，
     * 而是已经能用的东西；用户真想再要一条，用「+ 新增 PID」自己建）。
     *
     * @return 实际复制了几条
     */
    fun importTemplatesAsCustom(): Int {
        var n = 0
        BuiltInPids.MANUFACTURER_TEMPLATES
            .filterNot { PidDedup.isMonitor(it) }
            .forEach { t ->
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
        AppLog.i(
            AppLog.M_DATA, "厂家模板已复制为自定义",
            "复制=$n 条（跳过监听型 ${BuiltInPids.MANUFACTURER_TEMPLATES.count { PidDedup.isMonitor(it) }} 条 —— 它们是实车确认过的真条目，不是模板）"
        )
        return n
    }
}
