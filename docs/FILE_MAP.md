# 文件大纲 · FILE_MAP

> **这份文档的用途**：改代码前先在这里定位「该动哪个文件」，改完回来更新对应行。
>
> 文档共六份，**各有单一职责，按需查阅即可**：
>
> | 文档 | 回答什么问题 |
> |---|---|
> | [`接手大纲.md`](接手大纲.md) | **项目全貌 + 上手路线 + 红线**（接手者从这里开始） |
> | [`迭代清单.md`](迭代清单.md) | 做完了什么 / 接下来做什么 |
> | [`ARCHITECTURE.md`](ARCHITECTURE.md) | **为什么这样设计** —— 分层边界、数据流排障、UI 自适应 |
> | `FILE_MAP.md`（本文） | **改哪里** —— 每个文件干什么、关键符号、改动风险 |
> | [`HANDOVER.md`](HANDOVER.md) | 详细手册 —— 扩展流程、安全模型、装机清单、踩坑 |
> | [`CHANGELOG.md`](CHANGELOG.md) | **改过什么** —— 按版本的变更与验证记录 |
>
> 规模：**112 个 Kotlin 文件 / 约 26,100 行**（`app/src/main/java` 实测 **26,078** 非空行），
> **25 个布局 XML**（资源目录合计 48 个 XML）。
> ⚠️ v1.20.14 的 112 里有 **2 个是工作区里未提交的新文件**（本版交付的控件检视器）：
> `data/UiInspectorInfo.kt` + `ui/view/UiInspectorOverlay.kt`。
> ✅ 另一个智能体曾在本工作区加过 `data/UiScale.kt` + `ui/view/UiScaleApplier.kt`
> （全局字号 / 间距 / 导航栏缩放，设置页叫「界面调参」）—— **用户明确否掉，交付前已整套撤掉**，
> 所以文件数从 114 回到 112（少了那 2 个文件、约 739 非空行）。
> （这些数字会随迭代漂，改完顺手核一遍 —— 见 §4 末尾那条警告。）

---

## 1. 目录总览

```
D:/icarobd/   （ASCII 联结 → D:\AI Dsh\车机项目\iCarOBD2）
├── app/
│   ├── build.gradle.kts            构建脚本（版本号在这里改）
│   └── src/main/
│       ├── AndroidManifest.xml     权限 / Activity / 前台服务声明
│       ├── java/com/icar/obd/      ← 全部 Kotlin 源码（见 §2）
│       └── res/                    ← 全部资源（见 §3）
├── gradle/ + gradlew(.bat)         构建包装器（Gradle 8.14.3）
├── settings.gradle.kts             仓库配置（**阿里云镜像不能删**）
├── local.properties                sdk.dir
├── tools/                          辅助脚本（见 §4）
│   ├── theme-studio/               PC 端主题制作工具（**v2 多文件**，双击 index.html 即用，见 §4）
├── docs/                           **全部文档集中在此**
│   ├── 接手大纲.md                 【入口】项目全貌 + 上手路线 + 红线
│   ├── 交接-换电脑.md              **换机专用**：环境变量 / ASCII 联结 / 编译 / 本机实测偏差
│   ├── 上车监控清单.md             **上车专用**：§4 判据表 + **§11 本趟工单** + 取证 + 已知的坑
│   ├── 迭代清单.md                 版本清单 + 待办（带验收标准）+ §五 阻塞关系
│   ├── 下一步-主题工具与仪表盘重构.md  主题工具 + 仪表盘重构的执行规格（**已完成**，留作记录）
│   ├── ARCHITECTURE.md             为什么
│   ├── FILE_MAP.md                 本文（改哪里）
│   ├── HANDOVER.md                 详细手册
│   ├── CHANGELOG.md                逐版本变更记录
│   ├── UI设计指南.md               `icar.ui/1` 设计文件格式
│   ├── 主题设计大纲.md              **主题设计系统架构**（节点树 / 素材 / 状态 / 分辨率 / 编辑器分阶段）
│   ├── UI控件清单.md               全部 View / 控件 ID / 颜色 / 样式 / drawable
│   ├── 动画实现.md                 动画机制（**三层数值过渡** / 爆闪 / 共用时钟）
│   ├── 仪表框架.md                 8 种仪表 + 「某块表为什么是空的」排查
│   ├── CAN-信号库与逆向框架.md     **CAN 信号逆向的方法论**（DBC 分析 / 采样率是前提 / 四阶段方案）
│   ├── 下一步-CAN信号库实现规格.md  **上一条的执行规格**（**S1~S5 全部已做**：S1/S2 = v1.20.7、S3/S4 = v1.20.8、S5 = v1.20.10）
│   ├── 下一步-变量模式与组件变体.md  **主题工具的下一轮执行规格**（变量·模式 / 组件·变体，待评审）
│   ├── LVGL-放弃记录.md            LVGL 方案为什么被放弃（教训）
│   ├── 主题格式参考.md             Sky Gauge 格式逆向（已不用，格式知识仍有效）
│   ├── archive/                    归档的历史文档（`CHANGELOG-v1.0~v1.8.md`）
│   └── screenshots/                实机截图 20 张 + 索引 README
├── dist/                           当前版本 APK（只保留最新一个）
├── README.md                       面向使用者
└── .gitignore                      排除 build/ .gradle/ .kotlin/ local.properties stage/
```

> `stage/`（装机中转与临时截图）与 `app/build/` 等构建产物已清理，
> 跑一次 `./gradlew assembleDebug` 即可重建。

---

## 2. Kotlin 源文件清单

> 「风险」列的含义：
> 🔴 = 改错会导致数据错误/连接异常/用户配置丢失，改前必读 `HANDOVER.md` 对应章节
> 🟡 = 需要连带改动别处
> 🟢 = 相对独立，随便改

### 2.1 根包 `com.icar.obd`

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `App.kt` | 42 | Application 入口，**初始化顺序在此确定** | `App.onCreate` | 🔴 顺序错会 lateinit 崩溃 |

初始化顺序（不可调换）：`AppLog.init` → `Store.init` → `Defaults.seedIfEmpty` → `ObdController.init` → `ensureChannel`。
前台服务**故意不在这里启动**（Android 12+ 后台启动限制），由 `MainActivity.onCreate` 启动。

### 2.2 `ble/` — 传输层

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `ObdTransport.kt` | 70 | **传输层接口**：把「字节怎么收发」与「OBD 语义」解耦。注释里写明 5 条实现约定（一帧一次 `onRx`、`send` 非阻塞、状态严格流转、回调在主线程、断开清接收缓冲） | `State`、`Callback`、`send/flushRx/isReady`、`startScan/stopScan/connect/disconnect`、`kind`、`describe()` | 🟡 改接口 = 所有实现都要跟着改 |
| `BleTransport.kt` | 540 | BLE GATT 收发（`iCar Pro 2S`）。**GATT 表转储** + 属性校验的特征选择 + 写类型自适应 + 有界重试；按 `>` 切帧 | `KNOWN`、`probeCharacteristics`、`dumpGattTable()`、`props()`、`hasWrite/hasNotify`、`writeTypeUsed`、`writeFailureCount` | 🔴 **改写入逻辑前先看 CHANGELOG v1.3.0** |
| `SppTransport.kt` | 300 | 经典蓝牙 SPP/RFCOMM 收发（`iCar Pro BT3.0`）。扫描走 `startDiscovery()` + 广播，连接走 `createRfcommSocketToServiceRecord`；**读循环单独起线程** | `SPP_UUID`、`discoveryReceiver`、`startReadLoop`、`connectedAddress` | 🟡 **未经真实适配器验证**（v1.4.0） |

> 传输方式由 `Store.settings.transportKind`（`"ble"` / `"spp"`）决定，
> 在 `ObdController.buildTransport()` 里创建；连接页下拉框可切换（**立即生效**）。
> **上层（`ElmSession` / `ObdEngine`）只依赖 `ObdTransport`，新增一种链路不需要改它们。**

### 2.3 `data/` — 数据层

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `PidModels.kt` | 650 | **核心数据模型**，全部带 JSON 序列化 | `PidDefinition`（含 v1.20.7 的 **`invalidRaw`/`minDlc`/`ttlMs`**、v1.20.8 的 **`DEFAULT_MONITOR_TTL_MS`**）、`CompareOp`、`Rule`、`RuleCondition`、`RuleAction`、`GaugeItem`（含 **`cardStyle`** + `CARD_*` / `CARD_NAMES`）、`PidValue`（含 **`ttlMs`**）、**`dlcTooShort()` / `hitsInvalidRaw()`**（S2 两条判定的纯函数实现） | 🔴 加字段必须同步 `toJson`/`fromJson`。⚠️ `invalidRaw`/`minDlc`/`ttlMs` **默认值 = 旧行为**，所以默认值一律**不写进 JSON**（零迁移）；`invalidRaw` 的 `null` 与 `0` 必须区分（0 是合法的无效原始值）。⚠️ `dlcTooShort`/`hitsInvalidRaw` 抽在这里而不是 `FrameMonitor` 里，是因为那个 object 在 JVM 里一碰就抛 `Stub!`。⚠️ **`DEFAULT_MONITOR_TTL_MS` 是"新建监听型信号默认显示超时"的唯一权威**（信号表导入与手工录入都引用它）—— 字段默认值仍是 `0`（存量零迁移），两者**不是一回事**，别合并 |
| `Formula.kt` | 462 | 自研表达式求值器（词法→语法→求值）+ **通用位段函数**（v1.20.7） | `Formula.eval(expr, data)`、`Formula.check(expr)`、**`bitSequence(start,len,motorola)`**（真实位集）、**`bitsAt(data,start,len,motorola,signed)`**、**`bitsAtArgs(expr)`**（v1.20.8：取出那四个字面量参数，`rawBits` 与 `PidDraft.suggestedMinDlc` **共用**它）、**`rawBits(expr,data)`**（取位段的原始值给 `invalidRaw` 用）、内部 `Lexer`/`Parser` | 🔴 解析正确性命门。⚠️⚠️ **`bits(v,start,len)` 与 `bitsAt(起始位,长度,字节序,符号)` 不是一回事**（类注释里有对照表）：`bits` 的输入是**一个数值**，只能取单字节内的位段；`bitsAt` 自己拿**整帧**按位序遍历，所以跨字节 + 非对齐 + Motorola 都表达得了。⚠️ **判"解到帧外"必须用 `bitSequence` 的真实位集**，不能用线性的 `起始位+长度`（Motorola 是锯齿位序，实测误报过 2 条）。⚠️ `check()` 的假数据是 **64 字节**（CAN FD 上限），26 会让起始位靠后的合法 `bitsAt` 被误判。⚠️ **"是不是 bitsAt 形态"只判一次**（`bitsAtArgs`）—— 两处各判一遍必然分叉（`FormulaTest` 有一条用例专门钉住两边一致） |
| `SignalTableCsv.kt` | 590 | **25 列「信号表」的唯一生成/解析实现**（v1.20.7，S1 规格 §3），**纯函数** | `BOM`/`withBom`/`stripBom`（**CSV BOM 的唯一权威**）、`COLUMNS`(25)、`C_*` 列名常量、`Observed`、`template(observed)`、`parse(text)`、`Result`/`Problem`、`formulaOf()`、`noteOf()`、`pidId()`、`normalizeId()`、`parseOrder/parseSign`、`escape/splitRows` | 🔴 **BOM 只在这里定义一次**（三处写 CSV 都引用它 —— `CsvRecorder` 恰恰因为漏了它让 Excel 中文乱码）。⚠️ 导入**按列名**匹配（插列/调序不能让导入错位 —— 错位的后果是"值解错了但看起来正常"）；PID id 由 `(报文ID, 信号名)` 确定性推出 → 重复导入是**覆盖**不是翻倍。⚠️ 判越界/位重叠都用 `Formula.bitSequence`。⚠️ 规格 §3.4 写的「起始位 ≤0 是硬错误」按**意图**实现成「<0 才是」——起始位 0 是合法的（有单测钉住这个偏差）。⚠️ `显示超时` 的默认值取自 `PidDefinition.DEFAULT_MONITOR_TTL_MS`（v1.20.8 起**唯一权威**，`PidDraft` 引用同一个常量） |
| `PidDraft.kt` | 462 | **PID 编辑器「表单 → `PidDefinition`」的纯逻辑 + 全部校验**（v1.20.8，S3），**纯函数** | `SOURCE_POLL/MONITOR`、`SOURCE_VALUES/SOURCE_LABELS`、`MODE_MONITOR/MODE_CALC`、`isMonitor`、`sourceIndexOf/sourceOf`、`Fields`、`Issue`/`Field`、`Result`（`errors`/`warnings`/`ok`）、`of(p)`（→表单，**与 `build` 严格往返**）、`build(f,id,builtIn)`、`suggestedMinDlc(formula)`、`fmtNum` | 🔴 **校验只能有这一份实现**：编辑器的测试/采样/保存三个按钮全走 `build`（以前每个按钮各写一遍 `if (pid.isBlank())`，两条路会慢慢分叉）。⚠️ **`header` 是同一个字段两种含义**：`poll` 时是 `AT SH` 的**目标模块头**（`7E0`，留空 = 广播 `7DF`），`monitor` 时是**广播帧的 CAN ID**（`09A`）—— 界面上按 source 换标签，否则用户会把 CAN ID 填进"模块头"里。⚠️ 监听型的 `mode`/`pid` **不是用户输入**（固定 `MON` / `= header`），界面上藏起来。⚠️ `of()` 把 `ttlMs` **原样**写出来（含 `"0"`）：0 在 JSON 里与"没这个字段"不可区分，当成空就会**改用户数据**。⚠️ 数值字段解析失败一律**硬错误**，不再 `?: 0f` 静默兜底（那正是"被错值骗"的入口）。⚠️ `suggestedMinDlc` 用 `Formula.bitSequence` 的**真实位集**，不能用线性的 `起始位/8+长度` |
| `SignalDecode.kt` | 168 | **一帧 → 人看得懂的话**（v1.20.8，S4）：拿**已有监听型 PID 的 `formula`** 解帧，供 CAN 探测页显示物理值。**纯函数** | `Decoded`（`value`/`candidate`/`ok`/`reason`/`text()`）、`decode(frame,pid)`、`decodeAll`、`indexByHeader(pids)`、`parseHexData(s)`、`fmtValue(v)` | 🔴 **解不出来就说解不出来，绝不编值**：DLC 不足 / 命中无效原始值 / 公式解到帧外 → `value=null` + `reason`。⚠️ 判定**复用** `PidDefinition.dlcTooShort`/`hitsInvalidRaw`（与运行时 `FrameMonitor` 是**同一对函数**）—— 自己再写一遍就会出现"探测页说够、运行时不收"。⚠️ `indexByHeader` **必须收候选（`enabled=false`）**：按 enabled 过滤会让候选彻底看不见（那就又回到"只能看 hex"）。⚠️ 顺序与 `FrameMonitor.feedLine` 一致（DLC → 求值 → 无效原始值） |
| `BuiltInPids.kt` | 106 | 内置 PID 库 | `STANDARD`(20)、`DERIVED`(4)、`MANUFACTURER_TEMPLATES`(4)、`all()` | 🟡 **只增不改** |
| `Store.kt` | 868 | JSON 持久化 + **多画布（v1.20.0）** + **双指手势映射（v1.20.9）** | `Settings`、`allPids/findPid/isEnabled/setEnabled`、`upsertPid/**upsertPids**`（批量，v1.20.7 信号表导入用 —— 循环调 `upsertPid` 会写盘 N 次，而导入在**主线程**的 SAF 回调里）、`deletePid`、`upsertRule/deleteRule`、`exportPidsJson/importPidsJson`、`importTemplatesAsCustom`、**`settingsToJson/applySettingsJson`**（备份复用）、`customThemeJson`、`saveThemes`、**`activeCanvas/canvasIndex/activeCanvasIndex`**、**`snapshotToActiveCanvas/loadActiveCanvas`**、**`switchCanvas/addCanvas/removeCanvas/renameCanvas/moveCanvas`**、`migrateLegacyToCanvas`（私有，一次性）、**`Settings.lastImportSummary()`**（「最近一次导入」的摘要行，纯函数）、**`Settings.gestureAt/setGestureAt/gestureSummary`**（v1.20.9） | 🔴 改存储结构要考虑迁移；**加设置项必须同时改 `settingsToJson` 与 `applySettingsJson`**。仪表盘相关：`gridEnabled`/`grid*`（参考线）、**`dashSnapEnabled`**（拖拽吸附，默认 true）、`bgImagePath`、**`bgFit`**（背景铺法）、**`canvasNamePos`**（画布名浮标位置，v1.20.1；**全局**，不跟着画布走）、**`lastImportName/lastImportGauges/lastImportAt`**（最近一次导入设计文件，v1.20.6；`lastImportSummary()` 是它的**唯一**格式化处，有单测）、**`gestureLeft/Right/Up/Down`**（v1.20.9，四个键各自 `optString` 兜默认值 —— 旧配置根本没有它们，兜错了的表现是"升级后手势全没了"）。⚠️ **`gestureAt` 必须过 `GestureActions.normalize`**：设置页显示的映射与 `MainActivity` 真的执行的动作只能有这一个来源。⚠️ **灵动岛的七个键**（v1.20.13）：`islandPos/islandSize/islandCorner/islandHold/islandColorMode/islandBg/islandFg` —— 与手势同一条约定：**旧配置根本没有这七个键**，所以逐个过 `IslandStyle` 的归一化函数兜默认值，而**默认值就是 v1.20.12 写死的那些数**（兜错了的表现是"升级之后提示跑到别处 / 变大变小"，而那时现场旧配置已经被覆盖掉了；有单测逐个断言）。⚠️ `Settings.islandStyle()` 是**显示层拿样式的唯一入口**（归一化只在 `IslandStyle.spec` 一处发生），`Settings.islandSummary()` 是设置页那行小字的唯一格式化处。⚠️ **多画布的两个坑**：① `settings.dashType/gaugeTheme/designJson/bg*/dashPageIndex` 现在的身份是「当前画布的**实时副本**」，落盘/切画布时由 `snapshotToActiveCanvas`/`loadActiveCanvas` 双向同步（不改成转发属性是为了"漏改只是少存一次"而不是"静默读到过期值"）；② `saveDash()` 会写 `settings.json`，所以 **`load()` 必须先读 settings 再读 dash.json**，反了会拿默认设置覆写用户配置 |
| `Backup.kt` | 132 | **完整配置备份**：PID + 启用状态 + 规则 + 仪表 + 主题 + 设置 打包成一个 JSON | `export()`、`import(text)`、`currentSummary()`、`APP_TAG/FORMAT`、`Summary/ImportResult` | 🟡 导入是**整体替换**不是合并；分区独立解析 |
| `Defaults.kt` | 87 | 首次启动的默认规则与仪表 | `defaultRules()`(5条)、`defaultGauges()`（**转发到 `DashLayout.normal()`**）、`seedIfEmpty()` | 🟢 |
| `DashLayout.kt` | 228 | **内置布局 + 预设布局 + 旧配置迁移 + 拖拽数学** | `presets()`、`normal/perf/line/dualStack/quad/subDual/gForce`、`migrateFromGrid()`、`Drag.snap/move/resize`（**STEP=15 / MIN_SIZE=30**）、**`Drag.snapIf/moveIf/resizeIf`**（可关吸附） | 🟡 放 `data/` 是因为 `Store` 加载时要调迁移；放 `ui/` 会形成 `data → ui` 反向依赖。⚠️ 关掉吸附只去掉「对齐网格」，**夹取永远生效** |
| `DashCanvas.kt` | 199 | **一套画布**（多画布，v1.20.0）：`id/name/type/gauges/designJson` **+ `theme/pageIndex/bg*/scaleMode`**；另带**画布名浮标的位置常量**（v1.20.1） | `TYPE_NORMAL/PERF/CUSTOM`、`TYPE_NAMES`、`MAX_CANVASES`(8)、`DEFAULT_NAME`、`typeName`、`sanitizeName`、`gaugeCount`、`toJson/fromJson/listFromJson`、**`NAME_POS_*`/`NAME_POS_NAMES`/`namePosName`** | 🟡 **一套画布 = 一屏**：主题/背景/页号都跟着它走（留全局会出现"性能页顶着日常页底图"的半套效果）。`listFromJson` 坏条目**跳过**而不是整体失败。⚠️ `NAME_POS_*` 是**全局显示偏好**（存在 `Settings.canvasNamePos`），**不是每套画布各自的属性** —— 否则横滑时小字会在四个角之间乱跳 |
| `GestureActions.kt` | 198 | **双指手势 → 动作**的映射表（v1.20.9；**v1.20.10 加两个切 tab 动作**）：4 个方向（左/右/上/下）× **7 个动作**（无 / 呼出导航 / 收起导航 / 切上·下一套画布 / **切上·下一个 tab**），**纯逻辑** | `NONE`/`NAV_SHOW`/`NAV_HIDE`/`CANVAS_PREV`/`CANVAS_NEXT`/**`TAB_PREV`/`TAB_NEXT`**、`ACTION_IDS`/`ACTION_NAMES`、`SLOT_LEFT/RIGHT/UP/DOWN`/`SLOT_COUNT`/`SLOT_NAMES`、**`DEFAULTS`**、**`TAB_TAGS`**（6 个导航页的 tag，**循环顺序的唯一一处**）、**`slotOf(dx,dy,threshold)`**、**`normalize(slot,id)`**、`actionName/actionIndex/shortSlotName`、**`adjacentTab(actionId,current)` / `adjacentTab(current,delta)`**（`floorMod` 回绕）、**`isTabAction`**、**`summary(map)`** | 🔴 **方向判定只有这一份实现**（`MainActivity.dispatchTouchEvent` 调它）：**先比主轴再比阈值** —— 反过来判会把"斜着划"一律当成横滑（两根手指不可能完全同步，斜划非常常见）。⚠️ `normalize` 对**认不得的值落回该槽位的默认值、不是落回「无」**：旧配置根本没这四个键，落回「无」的表现是"升级之后手势全没了"。⚠️ **两个新动作的默认值必须是「无」**（`DEFAULTS` 里不许出现 `TAB_*`，有单测钉着）—— v1.20.9 及以前根本没这两个动作，升级后某个方向突然开始切页是不可接受的。⚠️ **新动作追加在 `ACTION_IDS` 末尾**：下标同时被 `Store.Settings` 与设置页 Spinner 用，插在中间会让旧配置落错动作。⚠️ 动作**刻意只给"导航类 + 翻页类"** —— 不给编辑态 / 全屏 / **跳指定页**（`adjacentTab` 对认不得的当前页返回 **null 而不是落回第一个**，就是为了不变成"跳页"）。⚠️ **双击兜底不在这一张表里**（它是"卡在仪表盘出不去"的保险，不可关）。⚠️ 加动作要同时改 `ACTION_IDS` / `ACTION_NAMES` / `shortAction` + `MainActivity.runGesture` 的 `when`（漏一处的表现是"能选但没反应"）。⚠️ 改 `TAB_TAGS` 要同时改 `res/menu/bottom_nav.xml`（菜单是"导航栏长什么样"的权威，`TAB_TAGS` 是"循环按什么顺序"的权威） |
| `DesignFile.kt` | 224 | **`icar.ui/1` 设计文件**（PC 端设计 → App 加载）。**不抛异常**，返回带字段路径的可读错误 | `SCHEMA`、`MAX_GAUGES`(32)、**`PID_ALIASES`**(27)、`resolvePid`、**`missingAliases()`**、`parse(text)`、`Result.errors/warnings`、**`Background`/`FIT_*`/`fitName`** | 🔴 改校验规则要**同时改 `tools/theme-studio/index.html`**，否则编辑器与 App 分叉（`ThemeStudioSampleTest` 会失败）。`PID_ALIASES` 改一处要同步三处（Kotlin / 工具 / 设计指南） |
| `DesignPack.kt` | 325 | **设计包（`.icarzip`）的解开与校验**（v1.20.9，App 侧）：`design.json` + 只打包真正引用到的素材 + `manifest.json`。**纯 JVM**（`java.util.zip` + `java.io.File`，**零新依赖**） | `PACK_FORMAT`(`icar.pack/1`)、`DESIGN_ENTRY`/`MANIFEST_ENTRY`、`Asset`/`Missing`/`Manifest`、**`Result.Ok/Fail`**、**`isZipHead(head)`**、**`safeEntryName(raw)`**、`parseManifest(text)`、**`unpack(input, destDir)`** | 🔴 治的是"**表盘只剩空卡片**"那个病（见 `DesignAssets`）：解压目录直接当 `designBaseDir`，**不需要任何路径映射**（包内路径 = 设计里的相对路径）。⚠️ **不静默**：字节数 / CRC32 对不上、清单里声明了但包里没有 → **整个包拒收**并把每条都列出来（只导一半恰恰会重现"空卡片"）；唯一放行的是 manifest 自己 `missing` 里已登记的素材，且逐条列成警告。⚠️ **路径穿越防护**：`safeEntryName` 拒绝对路径与任何一段 `..`（反斜杠先归一化 —— `..\..\x` 能构造出来），命中即**整包拒收 + 删掉已解压内容**（不留半个目录）。⚠️ `crc32` 是**无符号 32 位**（工具侧 `crc >>> 0`），比较用 `Long`，报错文案给**十六进制**（十进制看不出来对不对）。⚠️ 判"是不是 zip"只看前 4 字节的三种合法签名（`isZipHead`），**不认 "PK" 开头的任意字节** |
| `CrashCatcher.kt` | 60 | 全局未捕获异常兜底，写 `files/last-crash.log` | `install()` | 🟢 用户报「闪退」时先看那个文件 |
| `IslandStyle.kt` | 313 | **灵动岛提示的五组样式**（v1.20.13，用户要「可以自定义样式」）：位置 3 / 尺寸 3 / 圆角 3 / 停留 3 / 配色 2，**纯函数** | `POS_*`/`SIZE_*`/`CORNER_*`/`COLOR_*`/`HOLD_CHOICES_MS`、各 `*_NAMES` 与 `*_DEFAULT`、**`SIZE_TEXT_SP`/`SIZE_PAD_H_DP`/`SIZE_PAD_V_DP`/`CORNER_RADIUS_DP`**（下标一一对应）、`BG_PRESETS`/`FG_PRESETS`、**`normalizePos/Size/Corner/ColorMode/HoldMs/Color`**、**`Spec`**（已解析样式：`textSp`/`padHdp`/`padVdp`/`cornerDp`/`holdMs`/`bg`/`fg`/`accent`）、**`spec(...)`**、`holdIndex`、`summary`、`hexOf`、**`parseHex`** | 🔴 **默认值 = v1.20.12 写死在 `IslandNotice` 里的那些数**（13sp/14dp/7dp/18dp/`0xF01A1F27`/白/琥珀），改动任何一个都会让升级后的观感变样 —— `IslandStyleTest` 逐个断言。⚠️ **归一化对"认不得的档位"落回默认值，不是夹到边界**（夹到边界会让一份手改坏的 `settings.json` 把提示**静默挪到靠右**）。⚠️ **停留时长必须在 `HOLD_CHOICES_MS` 里**，否则落回默认（手改 `999999` 会让提示赖在画布上不走）。⚠️ **全透明（alpha==0）一律落回兜底** —— 它等于"胶囊看不见"，而用户看到的是"提示坏了"；半透明**原样保留**（那是有意的选择）。⚠️ 放在 `data/` 而不是 `ui/view/`：要被 `Store.Settings` 引用（落盘），而 `data/` 不能反向依赖 `ui/`；顺带好处是归一化/摘要/取值全可 JVM 单测。⚠️ **显示层只能从 `Store.settings.islandStyle()` 拿样式**，不许自己读那七个原始字段（归一化只在这一处发生） |
| `PidMerge.kt` | 121 | **燃油两条同义 PID 的合并**（v1.20.13，用户拍板「燃油可以合并」）：**保留两个 id，只在列表里不重复显示** | `KEEP_ID`(`calc_lh`)、`FOLDED_ID`(`std_5E`)、`FOLDED_IDS`、`isFolded`、**`filterForList(all, keep)`**、`mergeNote`、`describe` | 🔴 **先读代码确认了关系**：`std_5E` 是**输入**（`01 5E`）、`calc_lh` 是**派生输出**（`Derived.computeAll` 算出来），而 `computeAll` 的优先级是"`std_5E` 有值就用它、否则 MAF 推算" → **`calc_lh` 是超集通道，两者数值不等价** → **删任何一条都是错的**（车不支持 `01 5E` 时 `std_5E` 根本没值）。⚠️ **不许改 `Store.allPids()`** —— 轮询 / 模拟器 / 派生通道读的都是它，过滤**只能发生在"拿去做列表"那一步**（PID 管理页 / 仪表编辑器 / 规则编辑器）。⚠️ **`keep` 参数不是保险，是个真陷阱**：编辑器（`showEditDialog` / `addConditionRow`）都是 `indexOfFirst` 找不到就不设 → Spinner 停在 **0 号（发动机转速）** → 点「确定」把老仪表/老规则条件**静默改成转速**（有单测钉着）。⚠️ `mergeNote` 必须是**纯文本**（PID 行是 `TextView` 直接显示，写 `**` 用户看到的就是星号）。⚠️ 与 `PidDedup` 的分工：`PidDedup` 判的是"同一个信号的**两份条目**"（可清理），这里判的是"**输入与派生输出**"（**不可清理**，`PidDedup` 刻意不判内置之间的重复） |
| `UiInspectorInfo.kt` | 268 | **控件检视器的显示内容**（v1.20.14）：**纯函数**（33 条单测）—— px→dp/sp、四边数值、颜色 `#RRGGBB`、父链拼装、整屏渲染。**规格 §6 明确要求抽成纯函数**（View 在 JVM 里碰不得） | **`num`/`dp`/`sp`**、**`colorHex`**、`specName`（`MATCH_PARENT`/`WRAP_CONTENT`）、**`sizeLine`**、`quad`/`boxLine`、`textLine`、`shortResName`、`backgroundLine`、`stateLine`、**`chainLine`**、`optLine`/`optNumLine`、**`InspectorSnapshot`**、**`render`/`renderBody`**、`clipboardText`、`NONE`/`NO_ID`/`NO_HIT`/`HINT_DOC`/`HINT_SELF_DRAWN`/`HINT_OPS` | 🔴 **拿不到就写"（无）"，绝不编**（规格 §3）：非 `TextView` 的字号/颜色写「（无）」；`wrap_content` 没有"声明的宽高" → 写「尺寸 …（实测；声明 MATCH_PARENT × 40dp）」。⚠️ **`idLine` 收的是资源名**（`getResourceEntryName` 的结果）而不是数字 —— 用户要拿它去 `UI样式与排版总表.md` 搜 `文件:行`，数字搜不到任何东西。⚠️ **`chainLine` 的截断规则是"从头部丢、尾部永远完整"**：实测踩过第一版砍尾巴，最有用的一段显示成 `… > M…`（`MaterialTextView` 被砍成 `M…`）；另有 `NAME_MAX=20` 先截单个类名。⚠️ **本文件不许 import 任何 Android 类型**（`Gravity` 的解码因此放在 `UiInspectorOverlay`，用 `gravityText` 传进来）—— 一旦 import 就跑不了 JVM 单测，这一份的价值就没了。⚠️ `背景` 的**资源名**要反射拿（见 `UiInspectorOverlay.backgroundResName`），本文件只负责把拿到的名字缩成 `@drawable/bg_card` |
| `PidDedup.kt` | 186 | **PID 重复判定**（v1.20.12，纯逻辑，可单测）：请求型按 `mode+pid+公式`、监听型按 `报文 ID+位段指纹` | `Duplicate`、**`bitFingerprint(formula)`**、`isMonitor`、`isSameSignal`、`findDuplicates(all)`、`isReferenced`、`removable`、`summary`、**`confirmMessage`** | 🔴 **位段指纹**把 `bit(C,2)` / `bits(A,6,4)` / `bitsAt(18,1,0,0)` / `signed(A)` 都归一成「帧内起始位:长度:字节序:符号 + 系数/偏移」—— 设备上那条真重复（`bitsAt(18,1,0,0)` vs `bit(C,2)`）文字完全不同、指纹相同。⚠️ 认不出的公式**返回 null 并一律判"不重复"**（宁可漏报，误报会删掉真信号）。⚠️ **监听型与请求型不互判**（被动听广播 vs 主动问 ECU）；⚠️ **内置之间不判重复**（内置表是刻意设计的，且永远不给用户删）。⚠️ `confirmMessage` **必须是纯文本**：这一页的 `TextView` 不做 Markdown 渲染，写 `**粗体**` 用户看到的就是星号（v1.20.11 在知识库踩过，有单测钉着） |
| `AppLog.kt` | 385 | 结构化日志：环形缓冲 + **重复抑制** + 批量落盘 + 有界队列 | `Level`、**`M_*` 模块常量**、`log/v/d/i/w/e`、`size()`、`snapshot/clear/exportText`、`prepareTodayFile` | 🔴 四条自我保护（去重/文件上限/队列有界/批量派发）**不可移除**，见 CHANGELOG v1.3.0。`mainHandler` 是 **lazy** 的（否则 JVM 单测里一碰就抛 `Stub!`） |
| `CsvRecorder.kt` | 108 | 1Hz 数值记录 | `start/stop/append/files` | 🟢 ⚠️ 表头写的是 **PID 的中文名**，所以**必须先写 `\uFEFF`**（v1.20.7 修）—— 没有 BOM，Windows Excel 会按 ANSI 打开 → 中文列名乱码、**列名认不出来**。BOM 常量在 `SignalTableCsv.BOM` |
| `AudioPlayer.kt` | 72 | SoundPool 低延迟音效 | `play(name)`、`availableSounds()`、`sounds` 映射表 | 🟢 加音效登记一行 |

### 2.4 `obd/` — 业务核心

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `ObdController.kt` | 442 | **进程级单例门面**，UI 操作车辆的唯一入口 | `Listener`、`init`、`buildTransport`、`setTransportKind`、`setGForceMode`、`connect/disconnect/reconnectLast`、`initializeAndStart`、`handleAction`、`CH_RULE/CH_SERVICE` | 🔴 UI 不得绕过它 |
| `ObdProtocol.kt` | 156 | 纯函数层：初始化序列、hex 解析、**响应→数据字节** | `initSequence`、`PROTOCOLS`、`extractData(raw,mode,pidHex)`、`parse(raw,pid)`、`isError`、`DANGEROUS_MODES`、`isDangerous` | 🔴 `extractData` 是解析命门 |
| `ElmSession.kt` | 110 | 把串口语义封装成 suspend 调用 | `request(cmd,timeout)`、`initialize(protocol)`、`InitResult`、`raw()` | 🔴 Mutex 是串行化唯一保证 |
| `ObdEngine.kt` | 157 | 轮询调度 | `activePids`、`start/stop/reload`、`onCycle`、`loop()`、`failStreak/cooldownUntil` | 🟡 不得并发请求 |
| `RuleEngine.kt` | 139 | 规则求值 + 仪表变色覆盖表 | `evaluate()`、`reload()`、`actionHandler`、`colorOf/setColor/clearColors`、`testRuleOnce`、`describeRule/describeCondition` | 🟡 触发语义是重复触发 |
| `VehicleBus.kt` | 244 | 数据总线 + 派生通道 + **趋势历史环形缓冲** + **新鲜度判定（v1.20.7）** | `put/get/value/snapshot/clear`、`historyOf`、`HISTORY_SIZE`、`addValueListener`、`emit`、`sampleHz`、`Derived.computeAll/integrateDistance`、私有 **`fresh(v, now)`** | 🟡 派生 id 被内置仪表引用；历史**有界**，只有 `ok` 且非 NaN 才入。⚠️ **`fresh()` 是取值入口的唯一权威**：`now - ts > ttlMs` → 返回 `ok=false` 的副本。**`get`/`value`/`snapshot` 三个入口必须都过它** —— 漏一个就留下一条"看得见旧值"的路（仪表 `--`、规则不误触发、CSV 记空全靠它） |
| `PidScanner.kt` | 276 | 安全扫描器（7 道闸门） | `Config`、`Hit`、`scan(cfg,onProgress)`、`cancel()`、`querySupportedPids`、`learnRange` | 🔴 **安全参数不可放松** |
| `GForceSource.kt` | 187 | **G 值数据源**：加速度计（优先 `LINEAR`，回退 `ACCEL` + 高通估重力）与车速差分 `dv/dt`，可切换 | `MODE_OFF/SENSOR/SPEED`、`setMode`、`onCycle`、`available`、`modeName` | 🟡 OBD 总线上**没有** G 传感器，必须另找来源 |
| `SignalSimulator.kt` | 308 | **合成数据源**：往 `VehicleBus` 灌波形，**没有车也能调试仪表**。开启时由 UI 负责停掉 `ObdEngine` | `WAVE_*`、`Channel`、`waveAt/phaseAt/valueOf`（纯函数）、`autoChannel`、`applyDemoPreset`、`start/stop/tick` | 🟡 `main` 派发器是 **lazy**（否则 JVM 单测里一碰就抛 `Stub!`，纯函数也跟着测不了） |
| `CanFrame.kt` | 207 | CAN 广播帧解析 + 按 ID 聚合（纯逻辑）+ **观察表 CSV（v1.20.7）** + **合并多段结果的两个入口（v1.20.10）** | `parseLine`、`Aggregate`（含 **`maxDlc`/`dlc()`**）、`Accumulator`、**`aggregateCsv()/rawCsv()`**、**`feedRepeated(f,now,times)`**、**`setCounts(canId,count,changed)`** | 🟢 观察表 CSV 是**中文表头 + UTF-8 BOM + `报文ID(dec)` 冗余列**（v1.20.7）：没有 BOM，Excel 打开中文表头就是乱码。⚠️ `dlc()` 取**最长帧**而不是最后一帧（同一 ID 会有 4/8 字节两种帧，取最后一帧会让模板的 DLC 随机偏小 → 导入时被"解到帧外"误拒）。⚠️ v1.20.10 的两个新方法**只给分段轮换的合并用**：`feedRepeated` 的判据必须与 `feed` **逐字一致**（`hex != lastData`，不是 `lastData.isEmpty()`），差一次就会让合并出来的 `changed` 比单段少一次；`setCounts` 存在的理由是 `values` **去重**（`01→02→01` 三帧只剩两个元素）→ 靠喂帧重建不出 `count` |
| `FrameMonitor.kt` | 455 | **常驻监听通道**：把**广播帧**变成虚拟 PID（`source=monitor`）。停轮询 → `ATH1`/`ATS1`/`ATL1` → 装过滤器（能装就装）→ `ATMA` → 每帧按 `header` 匹配并用 `formula` 求值 → **DLC 守卫 / 无效原始值**（v1.20.7）→ `VehicleBus.put` → `runCycleOnce()` | `start/stop`、`signals()`、`parseCanId`、`filterPlan`（单 ID → `ATCRA`；同段 → `ATCM`+`ATCF`；**跨段 → 不加过滤器**）、**`onChunk`（主线程热路径，三道闸）**、`feedLine`、`matchesMonitoredId`（零分配预筛）、`warnGate` | 🔴 **`onChunk` 跑在主线程**：跨 ID 段时可达 344 帧/秒，本项目已因此 ANR 过一次（v1.18.4）→ 帧率闸不可删（见 `FrameRateGate`）。⚠️ 退出时必须重新初始化（过滤器清不掉）。⚠️ `onStateChanged` 是**单值槽位**，别在别处赋值（会顶掉 CAN 探测页的按钮文案刷新）。⚠️ `feedLine` 里的两条判定调的是 `PidModels` 的**纯函数**（`dlcTooShort`/`hitsInvalidRaw`）—— 不要搬回这个 object（JVM 里测不了）。⚠️ `Formula.rawBits` **只在真的配了 `invalidRaw` 时才调**（它在主线程热路径上，不能白花一次词法分析） |
| `FrameRateGate.kt` | 211 | **帧率闸的纯逻辑**（v1.20.6，P10-5）：正常 / >150 行/秒**限流** / >240 行/秒**过载** + 迟滞（退出阈值 60%） | `Mode`、`evaluate(nowMs)`、`countLine`、`noteSkipped`、`noteChunkDropped`、`describe()`、**`acceptIdsOf`/`leadingIdMatches`**（零分配预筛） | 🔴 抽成独立类是因为 `FrameMonitor` 是 object 且 `Handler(Looper.getMainLooper())` **饿汉初始化** —— JVM 里一碰就抛 `Stub!`，判定不抽出来**测不到**。⚠️ `leadingIdMatches` 是**安全性质**（不许漏掉解析后能命中的行），`FrameRateGateTest` 钉着 |
| `CanSniffer.kt` | 631 | **`ATMA` 被动探测**：停轮询 → `ATH1`/`ATS1`/`ATL1`（带 3 次重试）→ 开透传 → `ATMA` → 采集 → 复原。五道防洪水闸门 + 「对比基准」差分 + **分段轮换扫描（v1.20.10，S5）** | `start(duration,filterHex,rotate)`、`stop`、`Phase`/`Status`（含 **`rotation`/`rotatedIdCount`**）、`snapshot/diffAgainstBaseline`、`aggregates/rawFrames`、`aggregateCsv/rawCsv`、`reset`、**`ROTATE_DURATION_MS`**、私有 **`advanceRotationIfDue`/`closeSegment`/`mergeSegments`** | 🔴 与 PID 扫描器**不是一回事**（扫描器主动请求，只能发现 ECU 愿答的 PID）。⚠️ v1.20.6：`ATH1`/`ATS1` 三次都不 OK → **判定这趟无效**（这两条任一失效必然 0 帧，继续跑只会给出空结果）；`ATL1` 只警告。⚠️ `reset()` **故意不动基准**（否则两次对照之间按清空就把基准换掉了）。⚠️ **轮换的三条约定**：① 换段在 **`uiTicker`** 里判（与主线程的 `onChunk` 同线程 → 天然串行，起独立定时器就是两个线程抢 `acc`）；② **收尾时先 `closeSegment` 再合并**（`uiTicker` 一停就没人取最后一段的统计，症状是"`0x700` 那一段凭空消失"）；③ 轮换的**判定全在 `SegmentRotation`/`RotationPlan`**，**不许搬回这个 object**（JVM 里一碰就抛 `Stub!`，搬进来就一条都测不到） |
| `SegmentRotation.kt` | 233 | **分段轮换扫描的纯逻辑**（v1.20.10，P12-S5）：段号/段范围/AT 命令/**多段合并**（`object`）+ 时间 → 段号的状态机（`class RotationPlan`） | `SEGMENT_COUNT`(8)、`SEGMENT_MS`(10000)、`ROUND_MS`、`MASK_CMD`(`ATCM700`)、`segmentCommands(seg)`、`segmentFilter(seg)`、`segmentRange(seg)`、`label(seg)`、`SegmentStat`、**`merge(perSegment, into)`**；`RotationPlan.Snapshot`、`indexAt`、`isDone`、`segmentsToAdvance`、`snapshot` | 🔴 抽出来是因为 `CanSniffer` 是 object + `Handler(Looper.getMainLooper())`，**JVM 里测不到**（与 `FrameRateGate` 同一套理由）。⚠️⚠️ **`ATCF000` 单独发是"11 位 ID 全通"，不是"第 0 段"** —— 必须与 `ATCM700` 掩码**成对**下发（少了掩码会得到一份"第 0 段 ID 特别多"的假象，而帧数/ID 看起来都正常）。⚠️ **`object SegmentRotation` 与状态机类不能同名** —— 同名 `object` + `class` 会把 object 的作用域整个弄坏（Kotlin 报 `Redeclaration`，然后 object 里所有成员都变成 `Unresolved reference`，**报错跑到调用方去**）。所以状态机叫 `RotationPlan`。⚠️ **段号是"算出来"的**（`elapsed / segmentMs`），不是累加的 —— 累加式漏一次 tick 就永久偏移；`segmentsToAdvance` 返回**列表**，被拖慢的一拍要把欠下的段命令补齐（跳过一段 = 那一段的 ID 一个都没收到，而日志看起来正常）。⚠️ **合并必须补"段间边界"那一次变化**（各段累加器都从零开始）：不补的后果不是"数字小一点"，而是"按 changed 排序"那张表**把跨段跳动的信号埋掉** —— 而那正是要找的东西。⚠️ `count`/`changed` 用 `Accumulator.setCounts` **直接设**（`values` 去重，重建不出帧数），而且**每个 ID 只设一次**（分两次设是覆盖不是相加）。⚠️ **29 位 ID 一段都扫不到**（掩码只覆盖 11 位 ID 空间）—— 方案边界，不是 bug |

### 2.5 `service/`

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `ObdService.kt` | 111 | 前台服务，只为保活 BLE | `onCreate/onStartCommand/onDestroy`、`buildNotification`、`refreshNotification` | 🟡 业务在 ObdController，这里只做保活 |

### 2.6 `ui/` — 页面

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `MainActivity.kt` | 781 | 导航 + 权限 + **仪表盘沉浸模式**（收左侧 tab / 收系统栏 / **双指手势 ×4 + 双击兜底**）+ **常驻监听警示条**（v1.20.6） | `switchTo`（**commitNow**）、`createFragment`、`ensurePermissions`、`applyKeepScreenOn`、**`applySystemStatusBar`**、**`setRailVisible`/`ensureRailHandle`/`scheduleRailHide`**、`setFullscreen`、`updateSimBar`、**`syncMonitorWarn`**、**`runGesture(slot)`**（**全项目唯一**执行双指手势动作的地方，v1.20.9）、`dashFragment()` | 🔴 收起导航栏用**平移**（`translationX`+`alpha`）**不是 GONE** —— GONE 会让页面容器重排、画布尺寸变化、表盘重排并闪一下。⚠️ 沉浸时系统栏用 `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`（否则把人锁住）。⚠️ 警示条**不能**挂 `FrameMonitor.onStateChanged`（单值槽位，CAN 探测页已占用）→ 用 1 秒 ticker。⚠️ 双指/双击一律**旁听不消费**（照旧 `return super.dispatchTouchEvent(ev)`）—— 改成消费会把单指手势一起吃掉。⚠️ **动作执行只能有一处**（`runGesture`），设置页只编辑 `Store.settings` 里那张表；两处各执行一遍迟早"显示的映射"与"真的动作"分叉。⚠️ 「切画布」**要先判当前页**（只在仪表盘页有意义） |
| `KnowledgeFragment.kt` | 1285 | **知识库 + 软件使用手册**（v1.20.2 建 / v1.20.3 改成**导航 tab** + 标签筛选 / **v1.20.11 补 6 节新知识 + 新增手册 12 节**）：共 **31 节**（知识 0~18 答"为什么"、手册 1~12 答"下一步点哪里"，手册每节固定 `【前置】/【步骤】/【判据】/【没成功怎么办】` 四栏） | `Section`（**internal**）、`SECTIONS`、`TAGS`（11 个 + 「全部」）、`TAG_MAP`（**按节索引**挂标签，正文里不写）、`buildTagChips`、`applyFilter`、`tagsOf` | 🟡 内容是**文档性质的代码**，**没有编译期约束** —— 结构守卫在 `ui/KnowledgeFragmentTest.kt`（12 条）。⚠️ `ChipGroup(singleSelection)` 会**覆盖**你给 chip 挂的监听 —— 必须用 `setOnCheckedStateChangeListener`。⚠️ **在 `SECTIONS` 中间插节要顺手改 `TAG_MAP`**（v1.20.11 就把收尾节从索引 12 挪到了 18；错位的后果是"点某个标签筛出别的东西"，页面看起来完全正常）。⚠️ **正文里不许写 Markdown**（`**粗体**`、反引号都会**原样显示** —— 这一页不做渲染，v1.20.2~v1.20.10 一直带着 144 个 `**`，v1.20.11 清掉并有单测守着）；代码注释里的 Markdown 不受影响。⚠️ 标签词表与映射会分叉（多写一个 / 少挂一个 = 某个 chip 永远 0 节），两个方向各有单测 |
| `SafFile.kt` | 39 | **SAF（`content://`）文件显示名**（v1.20.6）：三级回退（`DISPLAY_NAME` → URI 路径末段 → 调用方兜底） | `displayName(ctx, uri, fallback)` | 🟡 抽成一处是因为"最近一次导入"与规则编辑器选音频都要它 —— 两处各写一遍必然分叉 |
| `DesignAssets.kt` | 105 | 设计文件**素材**落地（v1.20.3）：把 SAF 目录树整棵复制进 app 私有目录 | `copyTree`、`hasRelativeAssets` | 🔴 解决 P0：素材是相对路径 + 导入走单文件 → `designBaseDir` 永远为空 → 素材全加载失败。用 `DocumentsContract` 遍历，**不引入 `androidx.documentfile`**；文件名做了路径穿越防护 |
| `ui/view/NavBottomBar.kt` | 46 | **竖屏底部导航栏**（v1.20.5，P0）：把 `BottomNavigationView` 写死的菜单项上限 5 提到 6 | 重写 `getMaxItemCount()` | 🔴 Material 1.12.0 **没有** `setMaxItemCount`（逐字节搜过 classes.jar），只有 getter；但构造函数里是**虚调用** `getMaxItemCount()`，子类重写能在构造期生效。⚠️ 第 6 项用原生 `BottomNavigationView` 会**启动即崩**（只在竖屏暴露 —— 平板横屏用 NavigationRailView 没事） |
| `DashFragment.kt` | 368 | **仪表盘宿主（v1.20.0 起 = 多画布宿主）**：告警条 + `ViewPager2` + 「页码 → `activeCanvasId`」+ 裁决谁在渲染 | `handlePageSelected`、**`awaitingPos`**（程序化翻页标记）、`updatePageActivation`、`onPageEditing`（**编辑态关横滑**）、`jumpToCanvas`、**`stepCanvas(delta)`**（v1.20.9，双指上下滑用）、`onCanvasAdded/Removed/Moved/Renamed`、`refreshSimBanner` | 🔴 `ViewPager2` **分不清"用户滑的"和"我们调的"** —— 程序化翻页必须先记 `awaitingPos`，否则"新增一套画布"会把当前画布切成邻居。渲染/编辑/外观都**不在**这里（见 `ui/dash/`）。⚠️ **切画布只能由这一层做**：只改 `activeCanvasId` 不翻页会让"当前画布"与页码不一致，下一次横滑会把页码变化当成用户操作。⚠️ `stepCanvas` 要判"pager 是不是停在设置页"（那时没有"当前是哪一套"可言） |
| `ConnectFragment.kt` | 324 | 扫描/连接/初始化/运行选项（含**传输方式**与 **G 值来源**） | `doInit`、`applyInitResult`、`bindSwitches`、`updateTransportHint` | 🟡 |
| `PidFragment.kt` | 243 | PID 列表 + **导出/导入（PID 或完整备份）** + 模板 | `showExportDialog`、`showImportDialog`、`shareJson`、`doImportBackup`、`openBackupFile`、`seedTemplates` | 🟢 |
| `RuleFragment.kt` | 96 | 规则列表 + 恢复默认 | — | 🟢 |
| `LogFragment.kt` | 177 | 日志过滤/暂停/导出；UI 刷新合并到 250ms | `updateStats`、`exportLog`、`uiTick` | 🟡 统计必须用 `AppLog.size()`，不要用 `snapshot()` |
| `PidEditorActivity.kt` | 677 | **核心：PID 编辑器 + 在线测试**；**能自己造监听型 PID**（v1.20.8，S3）：`source` / `header` / `invalidRaw` / `minDlc` / `ttlMs` 五个输入口 + **按来源变形**（监听型藏掉 Mode/PID/请求帧/轮询间隔/优先级/多 ECU） | `evaluate()`（→ `PidDraft.build`，**唯一**的校验入口）、**`applySourceUi()`**、`load()`（走 `PidDraft.of`）、`failIssues(r,prefix)`、`runTest()`、`save()`、`bindAutoRequest`、**`fail(row, toast)`**（校验失败：Toast + 警示色 + 滚到可见，v1.20.6） | 🔴 项目核心。⚠️ 校验失败的提示**不能只改结果行的小字** —— 那一行在表单最底下，用户看不到（P10-2 踩过两次）。⚠️ **校验逻辑一律写在 `data/PidDraft.kt`**（纯函数、可 JVM 单测）：写在这个 Activity 里的话，"CAN ID 写错 → 帧永远不命中"这类判定**一条都测不到**。⚠️ **隐藏 ≠ 清空**：切来源只改 `visibility`，输入框里的字还在 → 编辑存量条目、来回切一次、再保存**不会丢值**（有单测 + 装机 md5 证据）。⚠️ 两个测试按钮对监听型**刻意不禁用**（死按钮点不动，用户就学不到"广播帧不能主动请求"） |
| `RuleEditorActivity.kt` | 478 | 事件规则编辑器（动态条件/动作行） | `addConditionRow`、`addActionRow`、`collect()`、`updatePreview()`、`testNow()`、**`fail(row, toast)`**（v1.20.6） | 🟡 `testNow()` 原来**不校验条件是否配全** —— 空条件时 `testRuleOnce` 返回"不成立"，用户会去怀疑车/信号（v1.20.6 已补） |
| `ScannerActivity.kt` | 252 | 扫描器 UI + 安全确认 | `startScan`、`applyModeDefaults`、`saveHit` | 🔴 危险模式拦截 |
| `ThemeEditorActivity.kt` | 388 | **主题编辑器**：顶部实时预览 + 声明式字段行（12 色 + 几何/指针环/辉光） | `ColorField`、`buildFields`、`applyDraft`、`pickColor`、`save/saveAs/persist/delete` | 🟡 内置主题只读，保存会自动转「另存为」 |
| `SimulatorActivity.kt` | 446 | **模拟信号工具**：分组折叠的单行摘要 + 展开详情（波形缩略图用**真正的 `waveAt`**，预览不可能与实际输出脱节） | `periodSteps`、`noiseSteps`、`buildRows`、`toggle`、`refreshHeader` | 🟡 **`onDestroy` 刻意不停模拟**（它是数据源，应像 OBD 连接一样在界面之外继续跑） |
| `CanSnifferActivity.kt` | 648 | CAN 被动探测页 + **两个观察表 CSV 导出**（`can-observe-aggregate/raw.csv`）+ **导出信号表模板 / 导入信号表**（v1.20.7）+ **对比基准** + **常驻监听开关** + **解码显示**（v1.20.8，S4：`0x09A → 左转向灯 1`）+ **分段轮换勾选框与进度行**（v1.20.10，S5） | `sniffResults`、`export`、**`observedRows`/`openSignalTable`/`showImportResult`**、`toggleMonitor`、`showDiff`、`addMonitorPid`、**`refreshStatus`**（唯一的状态行刷新入口，两条状态都要反映）、**`decodeLines`/`decodeColor`/`decodeSummary`/`decodeReport`/`refreshDecodeIndex`**（S4）、**`cbRotate`/`tvRotate`/`refreshRotateLine`**（S5） | 🟡 用 `ColumnFlowLayout` 自动分栏。⚠️ 常驻监听开着时状态行要说"轮询已暂停"（`MonitorWarnBar.TEXT`），不能还说"未开始"。⚠️ `FAILED` 要弹 Toast（状态行是 11sp 暗色小字，埋着等于没说）。⚠️ **导入结果对话框只能用 `setMessage` 一段正文** —— `setMessage` + `setItems` 会让**列表整个消失**（规格 §7 陷阱 4，v1.20.1 实测）。⚠️ 导入在**主线程**的 SAF 回调里跑：写库走 `Store.upsertPids`（一次写盘），不要循环调 `upsertPid`。⚠️ S4 解码：**未绑定 PID 的 ID 只显示原始 hex**（不猜值）、**候选压暗 + 标「候选」**、**不可信用 danger 色**；解码汇总挂在 `tvStatus` 而**不是**结果流里（`ColumnFlowLayout` 会把结果流切成半宽，看着像某一条的附注）。⚠️ `decodeIndex` **每轮刷新都重建**（用户可能先去 PID 页建一条再回来探测，缓存住就会出现"我明明建了，这里还是 hex"）。⚠️ **S5 进度行是单独一行、单独的控件**（`tvRotate`，非轮换时 `GONE`）：一轮 80~90 秒，用户全程盯着一片空白，进度必须一眼可见 —— **不要**把它并进 `tvStatus` 那行 11sp 暗色小字里。⚠️ 勾上轮换后「采集」与「过滤器」**置灰而不是隐藏**（隐藏会让人以为控件消失了）。⚠️ 轮换时**不要在 `describe()` 里重复段号/剩余时间**（那是进度行的活） |
| `BenchActivity.kt` | 404 | **性能基准页**（四段：8 表×3 档 + 12 表极限） | `segments`、`runAll/runSegment`、`verdictLine`、`buildReport`、`jankMs()` | 🔴 **判据是帧间隔不是 `DrawStats`**（硬件加速下后者只是记录 DisplayList 的耗时）。⚠️ 布局监听器**不得读 `segments[segIndex]`**（会越界崩溃，见 CHANGELOG v1.10.1） |
| `BenchHarness.kt` | 240 | 基准驱动端：建视图 + **每帧强制重绘** + 预热 + 帧间隔统计 | `build(count, neonPreset)`、`start/stop`、`frameStats(jankMs)`、`WARMUP_MS`、`SEGMENT_SEC` | 🟡 `GaugeTicker.request()` 每帧重调是**刻意的测量手段**，别抄到正常渲染路径 |

### 2.7 `ui/adapter/` — 列表适配器

| 文件 | 行 | 对应布局 |
|---|---|---|
| `PidAdapter.kt` | 114 | `item_pid.xml` + `item_pid_header.xml`（带分组标题） |
| `RuleAdapter.kt` | 72 | `item_rule.xml` |
| `LogAdapter.kt` | 113 | `item_log.xml`（增量插入；**溢出时必须成对通知**） |
| `DeviceAdapter.kt` | 66 | `item_device.xml`（按地址去重） |
| `ScanHitAdapter.kt` | 62 | `item_scan_hit.xml` |

### 2.8 `ui/dash/` — 仪表盘规格与渲染

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `DashSpec.kt` | 84 | 类型 → 布局列表的**分发**（内容在 `data/DashLayout.kt`） | `NORMAL/PERF/CUSTOM`（**别名指向 `DashCanvas.TYPE_*`**）、`build(type)`、**`buildFor(canvas)`**、`title(type)`、`useDesignFile(type, designJson)` | 🔴 横滑时每页要渲染**自己那一套** → 用 `buildFor(canvas)`；用 `build(type)`（读 `Store.customGauges` = 当前画布）会让所有页显示同一个盘面（滑过去像没切换） |
| `DashCanvasPagerAdapter.kt` | 69 | `[画布0][画布1]…[设置]` | `getItemId`（**画布 id 派生的稳定值**）、`containsItem`、`createFragment`、`positionOfCanvas`、`settingsPosition`、`SETTINGS_ID` | 🔴 **不能按下标当 itemId**：中间插/删一套画布会让后面每页的 tag 都变 → 正在编辑的那一页被无声销毁 |
| `DashCanvasPageFragment.kt` | 689 | **每套画布一页**：渲染 + **就地编辑**（取代已删除的 `DashEditorActivity`） | `setPageActive`、`refreshIfActive`、`isEditing`、`render`、**`applyNameLabel`**（浮标四角/隐藏 + 让开「编辑」按钮）、`applyBackground`、`requestEdit`、`convertToCustom`、`startEdit/exitEdit`、`showEditDialog`、`showPresetPicker` | 🔴 只渲染**自己那一套**（`DashSpec.buildFor`）；**只有当前页才渲染**（由宿主 `setPageActive` 裁决，`onResume` 对"页是否可见"没有发言权）；内置布局要先 `convertToCustom`（并清 `designJson`，否则"转了自定义但画面没变"）。浮标位置用 `layout_gravity` + `padding` 设（padding 在四个角上都等价于"离边多远"） |
| `CanvasSettingsFragment.kt` | 1573 | **最后一页（设置）**：画布增/删/改名/排序 + 当前画布外观（主题/背景/设计文件/参考线/卡片）+ 轮询间隔 + **手势** + 音效 + **画布名浮标位置** + **最近一次导入记录**（v1.20.6）+ **设计包导入**（v1.20.9）+ **灵动岛样式**（v1.20.13） | `refresh`（**包在 `binding` 标志里**，见下）、`refreshInner`、`buildRow`、`showAddDialog/showRenameDialog/showRowMenu`、`showLookMenu`（**动作列表，不做下标算术**）、`importDesign/applyDesign/exportDesign/clearDesignFile`、`showPollDialog`、**`showGestureDialog`**、**`importPack`/`showPackFailure`/`readHead`**、**`showNamePosDialog`**、**`showIslandDialog`/`pickIslandColor`**（v1.20.13）、**`tvLastImport`/`tvGestureSummary`/`tvIslandSummary`**、`pendingImportName/lastDesignName` | 🔴 **列表对话框一律不要带 `setMessage`**：`MaterialAlertDialogBuilder` 同时收到 message 与 `setItems`/`setSingleChoiceItems` 时**列表会被整个丢掉**（实测 `android:id/text1` 节点数 0），对话框只剩标题+说明+取消。说明进标题或进选项文字；说明较长时改**自定义 View**（见 `showPollDialog`/`showGestureDialog`，与 `showGridDialog` 同一条路）。⚠️⚠️ **程序化回填控件状态必须先判 `binding`**（v1.20.9）：`swSound.isChecked = …` 会走一遍 `OnCheckedChangeListener`，于是"在别处改过音效 → 滑到设置页"会弹一次 Toast；判据是"这次变化是不是用户点的"，`if (isChecked != value)` 那种写法**挡不住**（值确实不同，正是需要恢复的时候）。以后往 `refresh()` 里加带监听的控件，**副作用一律先判 `binding`**。⚠️ 行数偏大，要拆的话沿「画布管理 / 画布外观」切开。⚠️ 「最近一次导入」必须**在 `saveSettings()` 之前**赋值，否则这次导入要等下次落盘才记得住。⚠️ **设计包解压后不立刻写 `designBaseDir`**，要等用户点「导入」（`applyDesign` 的 `baseDirOverride`）—— 一解开就写的话，用户点「取消」也会把当前盘面的素材基目录换掉 |
| `DashRenderer.kt` | 476 | 规格 + 主题 → **自由画布**（归一化坐标绝对定位 + 参考线覆盖层），5Hz 数据推送 | `render(spec, theme)`、`renderDesign`、`relayout`、**`postRebuild`**、**`scheduleSizeCheck`**、`hasRendered`、`applyOverlay`、`pushValues`、`pruneOrphans`、`start/stop` | 🔴 不得塞数据获取逻辑；主/副参数由它推给视图。⚠️ `pruneOrphans` 动的是 `Store.customGauges`（**当前画布**），只有当前页该调它。⚠️ **`relayout()` 必须在收到第一次规格之前直接返回**（`hasRendered`）：`lastSpec` 初值是空列表，而容器第一次布局就会触发 relayout —— 不挡的话会打出**误导性的** `无可渲染的表 \| spec=0` 并闪一下空态；多画布后非当前页**故意不渲染**，那些页 100% 会走到这里。🔴🔴 **`relayout()` 绝对不许同步重建，必须走 `postRebuild()`**（v1.20.12 的 P0）：它挂在 `addOnLayoutChangeListener` 上、而那是**在 `View.layout()` 内部**被回调的 —— layout 期间 `addView` 的子 View **永远不会被 measure**，`FrameLayout` 拿 0 尺寸把它摆成 **0×0 @ (0,0)**。症状是 8 块表**都在树上**（`childCount=9`、日志照打「表=8」）却**一块都看不见**；而且**不会自愈**（告警条收起时再触发一次同样在 layout 里的重建）。以后**任何**在 layout 期间动 View 树的改动都会重犯这条 |
| `CanvasRebuildPolicy.kt` | 74 | 画布重建的**纯判定**（v1.20.12，不碰 View，可单测） | `needsRebuild(hasRendered,cw,ch,lastW,lastH)`、`zeroSizedCount(sizes)`、`shouldHeal(zeroSized,total,healed)` | 🔴 `shouldHeal` **只补一次**（补完还是 0 尺寸说明根因不是时序，继续补会死循环）；**1×1 不算坏**（那是 `item.w/h` 配成 0，补重建解决不了） |
| `DashboardBenchmark.kt` | 161 | **性能基准的纯逻辑**：排布 + 假值生成（不碰 View / Store / 总线，**可单测**） | `GAUGES`(8)、`STRESS_GAUGES`(12)、`pids`、`gauges`、`gaugeList(count,cols,rows)`、`cellRect`、`valueAt` | 🟡 用 `sin` 而非锯齿 —— 锯齿的周期跳变会额外触发全量重绘，把峰值拉高、测不出稳态 |

### 2.9 `ui/view/` — 自绘控件

| 文件 | 行 | 职责 | 关键符号 | 风险 |
|---|---|---|---|---|
| `BaseGaugeView.kt` | 409 | 仪表基类（只认识 `GaugeItem` + 数值 + 主题） | `bind(item, pid, theme, extras)`、`update`、`updateMulti`、`wantsHistory/updateHistory`、`extraValue/extraFormat/extraWarn`、**`alertColor` / `valueTextColor` / `extraTextColor`**、`mainColor`、`glowColor`、`isAnimating` | 🔴 分层的守门人。**报警状态只有 `alertLevel` 一个**（v1.10.1 删掉了 `warn`，见红线 §4.1.5 与 CHANGELOG） |
| `GaugeTheme.kt` | 176 | 三套内置主题 + **用户自建主题**（可序列化 + 几何参数） | `NEON/ICE/CLASSIC`、`CUSTOM_ID_BASE`、`builtIns/all/of/fromJson/nextCustomId`、**`aliasOf`/`byAlias`**（设计文件的主题别名，**冻结契约**）、`asCustom`、`cardBackground()`、**`withCardOverride()`** / **`cardBackgroundFor()`**（单表覆盖） | 🟡 **不要用 `Color.parseColor`**（Android 桩，会让本类没法单测）；辉光色必须由主题派生。⚠️ `cardBackground*` 要 `GradientDrawable`，**JVM 单测里测不了**（Android 桩），纯 Kotlin 的那一半已测 |
| `CircularGaugeView.kt` | 159 | 圆表（270° 弧 + 指针 + 刻度 + 霓虹辉光 + **指针环**） | `onDraw`、`RING_TICK` 分支 | 🟡 辉光色必须由主题派生 |
| `DigitalGaugeView.kt` | 98 | 数字大屏（字号按 `min(h, w*0.42)` 自适应） | `onDraw` | 🟡 |
| `BarGaugeView.kt` | 91 | 条形表（含报警阈值刻度线） | `onDraw` | 🟡 |
| `LineChartView.kt` | 116 | 线型图（折线 + 面积 + 末端点）；**纵轴固定用量程，不自动缩放** | `wantsHistory`、`updateHistory` | 🟡 历史由渲染层推送，视图不读总线 |
| `MultiValueGaugeView.kt` | 60 | 多数据显示**公共基类**（缓存画笔 + 画数值单元） | `drawCell` | 🟢 |
| `DualStackGaugeView.kt` | 34 | 双数据 + 上下（上下等分） | `onDraw` | 🟢 |
| `QuadGaugeView.kt` | 38 | 四数据（2×2） | `onDraw` | 🟢 |
| `SubDualGaugeView.kt` | 35 | 主 + 子双数据（上大下小） | `onDraw` | 🟢 |
| `GForceGaugeView.kt` | 86 | G力值（圆内 2D 点 + 0.5G 参考圈 + 十字准线） | `MAX_G`、`onDraw` | 🟢 轴向假设见 `GForceSource` |
| `GaugeViewFactory.kt` | 24 | **样式 → View 的唯一映射处**（编辑器与渲染器共用） | `create(ctx, style)` | 🔴 分两处写必然分叉 |
| `DashGridOverlayView.kt` | 81 | **参考线覆盖层**（均匀线段，密度/样式可调，常驻 z 序最底） | `linesEnabled`、`cols`、`rows`、`style` | 🟡 **不能叫 `enabled`**（撞 `View.setEnabled` 的 JVM 签名） |
| `MonitorWarnBar.kt` | 108 | **常驻监听警示条**（v1.20.6，P10-3）：监听期间在顶部挂 `监听中 · 轮询已暂停（转速/水温冻结）`，**跨页面可见** | `sync(host)`、**`heightPx()`**（v1.20.12，给灵动岛让位）、`TEXT`（文案的**唯一**出处，CAN 探测页共用） | 🔴 挂 `android.R.id.content` 而**不是**改 `activity_main.xml` —— 加一行会让 `pageContainer` 变矮 → 画布尺寸变化 → 表盘重排 + 闪一下。⚠️ 判据只有 `FrameMonitor.running` 一处，UI 不再自己判断 |
| `IslandNotice.kt` | 226 | **灵动岛式悬浮提示**（v1.20.12；**v1.20.13 起样式可自定义**）：平时**完全隐藏**、规则触发展开、按设置停留（默认 4 秒）后淡出；展开期间换文案并显示 `+N` | `attach(host)`、**`setTopOffsetPx`**（只动纵向）、`show(text)`、`dismissNow()`、私有 **`layoutParams()`**、`applied`（样式缓存） | 🔴 三条硬约束：**浮层不改布局**（挂 `android.R.id.content`，`layoutParams()` 里**不许出现具体宽高** —— 只有 `WRAP_CONTENT`）/ **`isClickable=false` 不抢触摸**（在 `IslandCapsuleView` 里统一设）/ **与警示条错开**（纵向**永远**是 `topOffsetPx + TOP_MARGIN_DP`）。⚠️ v1.20.13：位置档位只改**水平** `Gravity`（`START`/`CENTER_HORIZONTAL`/`END` + 靠边留 `SIDE_MARGIN_DP`），**纵向自由度是刻意不给的**（给了就能把胶囊拖到画布正中间 —— 那正是 v1.20.12 修掉的病）。⚠️ 样式每次 `show()` 从 `Store.settings.islandStyle()` **现读**（改完下一条就生效），但**只有 `Spec` 变了才动 View**（转向灯 450ms 一条，每次都设属性会白重排） |
| `IslandCapsuleView.kt` | 106 | **灵动岛胶囊本体**（v1.20.13 从 `IslandNotice.build()` 抽出来）：`applySpec(Spec)` + `setContent(text, pending)` | `applySpec`、`setContent` | 🔴 **样式 → View 的映射只有这一处**（红线 4.5）：设置页对话框的**实时预览**与真弹出来的胶囊用的是**同一个类 + 同一个 `IslandStyle.spec`** —— 两处各写一遍的后果不是"多几十行"，而是"预览里看到的样子和真弹出来的不一样"，而用户正是照着预览做决定的。⚠️ 构造里 `isClickable=false`/`isFocusable=false`，**子 `TextView` 也一样**（约束 ②）；本类**不设任何尺寸**（约束 ①）。⚠️ 背景 `GradientDrawable` **只建一次**、之后原地改 `cornerRadius`/颜色 —— 每次 `show()` 新建 drawable 会 `invalidate` 整棵子树，而 `show()` 在规则高频触发时被调 |
| `UiInspectorOverlay.kt` | 700 | **控件检视器的浮层本体**（v1.20.14）：面板 + **描边高亮** + **自己遍历 View 树**解析命中（规格 §6 方向 A）。规格 `docs/下一步-控件检视器.md` | **`enabled`**（`@Volatile`，**进程内、刻意不落盘**）、`show(host)`/`hide()`/`detach()`、**`isOnPanel(rawX,rawY)`**、**`inspect(rawX,rawY)`**、`snapshotOf`、`chainOf`、`gravityTextOf`、**`backgroundResName`/`resIdOf`/`findResIdField`**（反射 `mResourceId`）、`installDragAndLongPress`、`copyToClipboard`、私有 **`HighlightView`** | 🔴 **本类不注册任何全局触摸监听** —— 消费与否由宿主 `MainActivity.dispatchTouchEvent` 决定（`if (UiInspectorOverlay.enabled && consumeForInspector(ev)) return true`），所以**关着的时候对触摸完全不存在**（v1.20.4 把手就栽在"总抢手势"）。🔴 **`HighlightView` 永远 `MATCH_PARENT`、命中只 `invalidate()`** —— 不做"跟着控件走的小 View"：后者每次命中改 `layoutParams` → `requestLayout`，而 v1.20.12 那个「画布 0×0」的触发条件就是布局重排。🔴 **`enabled` 不许进 `Store.Settings`**：它一开就吃掉全部触摸，活到下次启动 = 用户以为"装坏了"，备份还会带到别的机器（有单测钉着）。⚠️ **浮层自己必须从命中解析里排除**（`c === panel \|\| c === highlight`），否则点哪儿都命中高亮层。⚠️ **`inspect` 传的是 `MotionEvent.rawX/rawY`（屏幕坐标）**：面板/警示条/导航栏都在 `android.R.id.content` 里各占一块，用窗口局部坐标会在系统栏显隐时错位；`containsPoint` 用 `getLocationOnScreen`（把 `translationX`/`scrollY` 全算进去）而不是自己加 `left/top`。⚠️ **`gravityTextOf` 放在这里而不是 `data/UiInspectorInfo`** —— `Gravity` 是 Android 类型，放进去那份纯函数就跑不了 JVM 单测。⚠️ **`backgroundResName` 是尽力而为**：公开 API 拿不到"Drawable 是哪个资源"，只能反射 `mResourceId`（Drawable 自己 → 它的 `ConstantState`，按类缓存、全程 `runCatching`），失败就退化成类名 —— **绝不编假资源名**。⚠️ 默认位置**左下角**（顶部居中已被灵动岛占、顶部已被警示条占）。⚠️ 拖动超过 `scaledTouchSlop` 就取消长按（否则"想挪一下位置"会顺手把信息复制进剪贴板） |
| `IslandStateMachine.kt` | 123 | 灵动岛的**纯逻辑**状态机（不碰 View、`now` 由调用方传入） | `HOLD_MS`(4000)、**`holdMs`（v1.20.13 起是 `var`）**、`Snapshot`、`onMessage`、`onTick`、`reset` | 🔴 **同一条文本只续期**（转向灯每 450ms 触发一次，重播动画会一直闪、`+N` 会涨到几百）；**不做严格 FIFO**（第 3 条等 8 秒才看到是有害的）。⚠️ `holdMs` 是 `var` 而不是构造参数：停留时长进了设置（2/4/6 秒）且**运行中可改**，而**重建**状态机会把"正在显示的那条"一起丢掉（表现是"改完时长后提示闪一下"）—— 调用方每次弹之前赋一次值即可 |
| `DashCanvasEditorView.kt` | 319 | **拖拽画布**（ViewGroup；点选 / 拖动 / 手柄缩放 / 网格吸附） | `submit`、`add`、`refresh`、`currentItems`、`hitTest`、`inHandle` | 🟡 坐标一律走 `DashLayout.Drag` |
| `MaxWidthViews.kt` | 168 | **限宽容器 4 个变体** + **`MaxWidthCapable` 接口**（v1.20.14：暴露 `maxWidthPx`，供控件检视器显示「限宽 720dp」） | `MaxWidthScrollView`、`MaxWidthNestedScrollView`、`MaxWidthLayout`、`MaxWidthLinearLayout`、**`MaxWidthCapable`** | 🟡 见 `ARCHITECTURE.md` §3。⚠️ `maxWidthPx` 原本是 `private` —— 外面只能看到"被夹过的宽度"，分不清"它本来就窄"还是"被限宽夹了"。用**接口**而不是给四个类各加一个 `fun`：检视器只需 `is MaxWidthCapable` 一次判断，以后再加第五个变体也不会漏 |
| `ColumnFlowLayout.kt` | 190 | **按宽度自动分 1/2 列的瀑布流容器**（横屏表单不再一行一个超宽输入框） | `assign` / `assignColumns`（纯函数，`onMeasure` 与 `onLayout` **共用同一个**） | 🔴 两处各算一次必然算出不同结果 → 错位。**不用 `layout-land` 副本**（红线 §4.2.13） |
| `Easing.kt` | 300 | 数值动画的**纯逻辑**：输入滤波 + 4 种缓动曲线 + 收敛判据（不碰 View，时间由调用方传入） | `MODE_STANDARD/LINEAR/SOFT/SNAPPY`、`MODE_NAMES`、`step`、`smooth`、`needsMoreFrames`、`shouldSnap`、`REF_FRAME_MS`、`HOLD_MS` | 🔴 曲线参数作用在**累计进度**上（不是每帧 dt）；进度型曲线用**固定总行程**（不是剩余距离），否则永远到不了目标 |
| `GaugeAnimator.kt` | 130 | 单值动画**状态机**（起点/总行程/目标稳定计时），从 `stepFrame` 抽出来以便单测 | `step(raw, nowMs, epsilon)`、`display`、`restart()`、`snapTo()`、`tauMs/mode/smoothMs/range` | 🔴 **数据还在变时不许停止动画**（`HOLD_MS` 之前）；`restart()` 必须清掉稳定计时与总行程 |
| `GaugeTicker.kt` | 105 | **全工程唯一的动画时钟**（`Choreographer`）。每帧一次回调，所有仪表在同一帧一起重绘 | `request/release`、`doFrame`、`AnimatableGauge.stepFrame` | 🔴 不新增第二个动画驱动；`WeakHashMap` 快照要吞 `ConcurrentModificationException`（冒泡会让时钟永久停摆） |
| `AlertPulse.kt` | 175 | 阈值报警与爆闪的**纯逻辑**（不碰 View、时间由调用方传） | `NONE/WARN/CRITICAL/`**`WARN_LOW`**、`level`、**`levelWithLow`**、`releaseOf`、**`releaseHighOf`**、`square/pulse/intensity/tintMix/mix/alpha` | 🔴 **下限的迟滞方向与上限相反**（退出阈值要**加**）；照抄 `releaseOf` 会让下限永远进不去 |
| `NeonStyle.kt` | 79 | 霓虹档位（可全局设，也可单块表覆盖） | `PRESETS`（关闭/克制/标准/强烈/夸张）、`layersOr`、`presetOf/presetNameOf`、`MAX_LAYERS`(12) | 🔴 **档位名是跨层契约**（`data/` 存字符串）：改名会让存量配置**静默回落到「标准」**，`NeonStyleTest` 冻结了名字 |
| `NeonPainter.kt` | 196 | 共用霓虹绘制层（弧 / 线 / 圆 / 圆角矩形 / 文字五套原语） | `layersFor(sizePx)`（自适应 3/5/7/9）、`spreadFor`、`bloom*` | 🔴 `onDraw` 里**零分配**（所有 Paint 复用）；层数按控件尺寸自适应 |
| `DrawStats.kt` | 154 | 绘制耗时统计（每 5 秒结算一次，按平均降序打日志） | `record`、`tick`、`snapshot()`、`Snapshot.fps(gaugeCount)` | 🟡 ⚠️ **硬件加速下它只量到主线程记录 DisplayList 的耗时，不是光栅化成本** —— 别拿它当性能判据（见 `BenchActivity`） |
| `DashboardBackground.kt` | 120 | 导入图片作仪表盘背景 | 必须**下采样**（4000×3000 直接解码是 48MB，平板必 OOM）+ **复制到私有目录** + 按路径缓存 | 🟡 SAF 的 uri 重启后可能失效，所以必须复制。铺法（`bgFit`）由 `DashFragment.applyBackground()` 用 `BitmapDrawable` 的 gravity 实现 |
| `WaveThumbView.kt` | 70 | 波形缩略图（模拟信号工具用），数据来自真正的 `SignalSimulator.waveAt` | `wave/period/noise` | 🟢 预览不可能与实际输出脱节 |

> `GaugeTheme` **属于 `ui/view/` 而不是 `ui/dash/`**：它是「绘制所需的调色板」，
> 是最底层绘制契约，[`BaseGaugeView`] 必须认识它。
> 放在 `ui/dash/` 会让底层 `ui/view/` 反向依赖上层编排层，属于依赖倒置。

---

### 2.5 单元测试 `app/src/test/java/com/icar/obd/`（**44 个文件 / 824 个用例**）

> ⚠️ 下表的「用例」列**长期滞后于实际**（`run-tests.ps1` 的输出才是准的）——
> 2026-10-09（v1.20.11）实测 `TOTAL=824`。加用例时顺手把这一行和本表改掉。

| 文件 | 用例 | 覆盖 |
|---|---|---|
| `ui/KnowledgeFragmentTest.kt` | 12 | **知识库 / 使用手册的结构守卫（v1.20.11）** —— 这一页没有编译期约束，只守三件会**静默坏掉**的事：**`TAG_MAP` 索引对齐**（条目数 = 节数 / 索引正好是 `0..size-1` / 不漏不跳号 / 不指向不存在的节）；**标签词表不分叉**（映射里用的标签都在词表里、词表里没有死标签、无重复、**数量 ≤ 11**）；**正文里没有 Markdown**（逐节扫成对的 `**` 与反引号；**单个 `*` 是正常的** —— 公式里的乘号如 `A * 0.1 - 48`）。另加：手册正好 **12 节**且编号连续（`手册 N · ` 开头）/ **手册每节四栏齐全**（`【前置】`/`【步骤`/`【判据`/`【没成功怎么办】`，⚠️ 步骤只查前缀 —— 手册 4 拆成 `步骤 A/B`）/ 知识节不许混进 `使用手册` / 标题与正文非空且标题不重复 / **正文不许有 Tab**（Tab 不参与 `trimIndent()` 的公共缩进计算，表现是"整段左边多出一截空白"） |
| `data/DesignPackTest.kt` | 18 | **设计包（v1.20.9）**：`isZipHead` 三种合法签名 / JSON 不误判 / 太短；`safeEntryName` 拒绝对路径·`..`·反斜杠穿越·空，归一化 `./` `//` `\` 且中文与空格原样保留；**正常包解出后目录结构与设计引用一致**（含中文目录）；**CRC32 / 字节数 / 缺失素材各自报错并指名道姓**（CRC 用十六进制）；格式版本不对 / 没有 manifest / 没有 design.json / manifest 是坏 JSON / 根本不是 zip；**穿越条目 → 整包拒收且一个文件都没写到目录外**；**拒收时不留半个目录**；manifest 的 `missing` 与"包里多出的文件"**放行但列成警告**；纯控件（零素材）的包也能解开 |
| `data/GestureActionsTest.kt` | 29 | **双指手势映射（v1.20.9；v1.20.10 加切 tab 的 13 条）**：默认值保持升级前手感（右滑呼出/左滑收起/上下翻画布）+ 每个默认值都是合法动作；`slotOf` 四个方向 / **未达阈值返回 -1**（不是某个槽位）/ 阈值 ≤0 不触发 / **斜划按主轴判**；`normalize` 认得的值原样、认不得的**落回该槽默认值**（含 null / 空白 / 拼错 / 越界槽位）；`actionName`/`actionIndex` 对认不得的当「无」；`summary` 文案与需求给的例子逐字一致 / 四个都配上时不补"其余无" / 全「无」时另给一句并提醒双击兜底；**旧配置缺这四个键取默认值**；存→读往返一致且真的写进 JSON；**手改坏的值落回默认**；`setGestureAt` 写进去的一定是合法 id；**v1.20.10**：可选动作是 **7 个**（id/名都不重复）/ **两个新动作的默认值是「无」** / 7 个动作**逐个往返**（`normalize`+`actionName`+`actionIndex`）/ 切 tab 能落盘读回 / **旧配置里不会出现切 tab** / `TAB_TAGS` 顺序 / **下一个走完 6 页回到第一个** / **上一个倒着走完回到最后一个** / **循环边界** / 六个 tab 各走一步都不原地不动且往返回到原点 / **认不得的当前页返回 null（不落回第一个）** / `isTabAction` 只认那两个 / 摘要认得出两个新动作 |
| `data/PidDraftTest.kt` | 27 | **PID 编辑器的表单逻辑（v1.20.8，S3）**：监听型/主动请求型**往返**（字段一个不许变，含 `ttlMs=0` 不许被改成默认值）；`header` 两种含义（监听型必填 + 规范化 `9a→09A`、29 位原样；poll 的模块头可空）；监听型的 `mode`/`pid` 恒被忽略；校验边界逐条（名称·公式空 / PID 奇数 nibble / Mode 非十六进制但 `CALC` 放行 / min·max·间隔·ECU·无效原始值·最小帧长·显示超时的非数·负数·越界 / 最小>最大）；**`suggestedMinDlc` 按真实位集**（Motorola 锯齿，含规格 §7 的 `60,5` 实测案例）；软警告（无效原始值越界 / minDlc 为 0 或偏小）；下拉框映射与 `fmtNum`；有硬错误时 `pid == null` |
| `data/SignalDecodeTest.kt` | 14 | **探测页解码（v1.20.8，S4）**：实车 09A 三帧（关/左/右）解对；`bitsAt` 形态也能解；`text()` 格式（值·单位·候选）；**三种"不可信"都不给值**（DLC 不足 / 命中无效原始值 / 解到帧外）+ 原因可读；无效原始值**比位段而不是物理值**（并钉住非 `bitsAt` 形态的回落语义）；候选 + 不可信两种标记共存；`indexByHeader`（只收监听型 / **候选必须进来** / header 空退到 pid / 非法与空公式跳过）；`parseHexData` 与 `fmtValue` |
| `data/FormulaTest.kt` | 61 | 文档承诺的全部公式模板、优先级与结合性、内置函数（含 `be16`/`le16`/`s16`/`bits`/`map`）、错误路径（除零 / 变量越界 / 未知函数 / NaN）、`check()`；**通用位段 `bitsAt`（v1.20.7）**：Intel·Motorola × 对齐·跨字节 × signed·unsigned、**与 `bits` 的区别**（`bits` 取不到跨字节）、解到帧外必须抛异常而不是补零、参数非法；`bitSequence()` 的真实位序（含锯齿）；`rawBits()`（取位段原始值 / 非 `bitsAt` 形态返回 null / 帧外返回 null）；**`bitsAtArgs()`（v1.20.8）**：四个参数的顺序与默认、后面接 `* f ± o` 不影响、**与 `rawBits` 的形态判定必须一致**（分叉的后果是"编辑器建议的帧长与运行时解码的位段对不上"） |
| `data/SignalTableCsvTest.kt` | 41 | **25 列信号表（v1.20.7，S1）**：模板（BOM / 25 列中文表头 / 每个 ID 一行 / 预填 ID·DLC·取值集合 / 其余留空）；往返（公式生成 / `minDlc` / `ttlMs` / `invalidRaw` / 可信度→`enabled` / `note` 固定格式）；**硬错误逐条**（ID 非法 / 信号名空 / 起始位非数或负 / 长度越界 / 字节序·符号不认识 / 因子 0 / 最小>最大 / **解到帧外**）；**软警告逐条**（dec 不一致 / 字节不符 / 无效原始值越界 / **位重叠** / 多路复用 / 单位·证据空 / DLC 空）；**Motorola 真实位集不误报越界**（规格 §7 陷阱 1 的两个实测案例）；重复导入覆盖；表头缺失 / 列序打乱 / CRLF / 空行；CSV 引号与转义 |
| `data/DashCanvasTest.kt` | 25 | **多画布（v1.20.0/1.20.1）**：`DashCanvas` JSON 往返 / 坏条目跳过 / 名字兜底；**旧配置迁移**（取值完全不变、只迁一次、有画布时 `dash.json` 不再覆盖）；增/删/切/排序（内容互不串台、最后一套删不掉、删当前落到邻居、上限、悬空 id 自愈）；**画布名浮标**（名字表契约 / 越界回落 / 设置往返 / 读取时夹取 / **全局性**）；**备份往返保留全部画布与当前画布**；**最近一次导入（v1.20.6）**（设置往返 / 旧配置缺字段是空记录而不是假时间 / 摘要格式 / 缺文件名兜底） |
| `obd/ObdProtocolTest.kt` | 42 | `extractData` 各种响应格式（ATH0 / ATH1 / SEARCHING / 多帧 / NO DATA / 15 种错误码 / 兜底分支）、`parse` 端到端、初始化序列、**危险模式拦截**、`scanCandidates`、**ISO-TP 多帧重组**、多 ECU 选序 |
| `ui/view/AlertPulseTest.kt` | 37 | 等级判定与**迟滞**（含反证用例）、**下限 `levelWithLow`**（方向 / 优先级 / 阈值 0 与 null / `WARN_LOW` 不爆闪）、爆闪时间相位、颜色混合 |
| `ui/view/EasingTest.kt` | 37 | **缓动纯数学**（v1.10.4）：4 种曲线的单调 / 不过冲 / **帧率无关** / dt 夹取 / 未知模式回落、输入滤波（压尖刺 / 帧率无关 / 收敛）、收敛判据（**数据还在变时不许停** / 稳定后才停 / 吸附与继续是两件事）、5Hz 推送回归 |
| `data/PidModelsTest.kt` | 37 | `CompareOp` 七种比较（含 CHANGED 边沿语义）、`RuleAction.describe`、`requestString` / `modeInt` / `pidBytes`、优先级倍率与未知取值兜底；**运行时三语义的字段（v1.20.7，S2）**：三个新字段默认值 = 旧行为 / JSON 往返 / **旧 JSON 缺字段取默认值** / `invalidRaw` 的 `null` 与 `0` 必须区分；`dlcTooShort()` 与 `hitsInvalidRaw()`（优先比位段原始值、非 `bitsAt` 形态退回物理值） |
| `data/PidDedupTest.kt` | 28 | **PID 重复判定（v1.20.12）**：位段指纹（`bit(C,2)`≡`bitsAt(18,1,0,0)` / `bits(C,3)`≡`bitsAt(19,…)` / `bits(A,6,4)`≡`bitsAt(6,4,0,0)` / `signed(A)`≡`bitsAt(0,8,0,1)` / 系数偏移算进指纹 / **认不出返回 null**）、同请求同公式算重复 / 公式只差空白仍算重复 / 同请求不同公式不算、监听型同报文同一位算重复 / 不同位不同报文不算 / **监听型与请求型不互判** / 派生通道不参与、**内置之间不判重复**（含"真的同请求同公式也不判"）/ 自定义撞内置保留内置 / 两条自定义保留先出现的 / **设备上那条真重复（`TestMonitor09A` vs 左转向灯）能被完整判出来** / 认不出公式的监听型不误判、被仪表或规则引用的不清理 / 没被引用的可清理 / 汇总逐条带理由 / **确认框正文不许出现 Markdown 标记** |
| `ui/dash/CanvasRebuildPolicyTest.kt` | 17 | **画布重建纯判定（v1.20.12）**：没渲染过不重建（v1.20.1 那个坑）/ 尺寸没变不重建 / **高度 2272→2164 要重建（就是告警条出现那一次）** / 收起时也要 / 宽度变 / 两轴同时变；`zeroSizedCount`：全正常 0 / **layout 期间 `addView` 的指纹（全 0×0）** / 只有宽为 0 / 只有高为 0 / 负尺寸 / **1×1 不算坏**（那是配置写错）/ 空列表；`shouldHeal`：有坏块补一次 / **补过就不再补（防死循环）** / 没坏块不补 / 一块表都没有时不补 |
| `ui/view/IslandStateMachineTest.kt` | 12 | **灵动岛状态机（v1.20.12）**：初始隐藏 / 来一条展开 / 空白文案不弹空胶囊 / 到点自动收起（`HOLD-1` 还在、`HOLD` 收起）/ **同一条重复触发只续期**（20 次 ×450ms 不收起、不累加 `+N`）/ 不同提示换文案并 `+N`（且续期）/ 收起后再来算全新一条 / `reset` / 未展开时 tick 不会变可见 / 首尾空白去掉 / 去空白后相同算同一条 / 停留时长 = 4 秒 |
| `data/IslandStyleTest.kt` | 17 | **灵动岛样式（v1.20.13）**：**默认样式就是 v1.20.12 的样子**（六个数字逐个断言：13sp/14dp/7dp/18dp/`#F01A1F27`/白/琥珀）/ 默认摘要字符串 / **越界档位落回默认值而不是夹到边界** / 停留时长必须在候选里（`999999`、`0` 都兜回默认）/ **全透明落回兜底、半透明原样保留** / 跟随主题时忽略自定义色 / 自定义配色下 `+N` 跟正文色 / 尺寸三档与档位表一一对应（长度 + **单调递增**）/ 色板与色名一一对应 + 色板里不许有全透明 / 停留时长下标映射 / **改完能落盘再读回来** / **`settingsToJson` 里必须有这七个键** / **旧配置缺字段时取默认值** / **手改坏的配置在读取时就被夹住**（且写回去的也是合法值）/ 摘要跟着设置变 / 色值解析与格式化（`#RRGGBB` / `#AARRGGBB` / 认不出返回 null）/ 摘要与说明文案里不许出现 Markdown 星号 |
| `data/PidMergeTest.kt` | 13 | **燃油两条 PID 的合并（v1.20.13）**：两条是**输入与派生输出的关系**（`01 5E` vs `CALC`，同单位）/ **`calc_lh` 是超集通道**（车支持 `01 5E` 时取它 7.5 L/h；不支持时由 MAF 推算仍有值）/ `filterForList` 把 `std_5E` 收起来且**顺序不乱** / 没有可折叠条目时**原样返回同一个实例** / `keep` 里的 id 一律保留 / **编辑器里当前绑定的 `std_5E` 不会被静默改成 0 号（`std_0C`）** / **合并只动显示层：`allPids()` 里两条都还在** / 被引用的 id 仍然能查到 / 设计文件的两个别名都还能解析 / 合并不会被当成重复去清掉 / **平均油耗与续航读的还是 `calc_lh`**（端到端：`std_5E` 8 L/h → `calc_lh` 8 → `calc_l100` 8 → `calc_avg_l100` 8 → `calc_range` 312.5km）/ 说明文案是纯文本且说清了另一条去哪了 / `isFolded` 的边界 |
| `data/GaugeLayoutTest.kt` | 34 | `GaugeItem` JSON 往返、**旧 span 网格 → 归一化坐标迁移**、7 个预设、`allPidIds`、**拖拽数学**（吸附 / 夹取 / 反复拖动）、**吸附开关**（关掉可停任意坐标但夹取仍生效） |
| `obd/SignalSimulatorTest.kt` | 28 | 7 种波形 / 相位回绕 / 周期夹取 / 噪声不越界 / 自动配置与零量程兜底 |
| `data/DesignFileTest.kt` | 22 | `icar.ui/1` 解析：别名解析 / 各类硬错误与软警告的**文案可定位性** / `unit` 标记注入（防坐标 ×360） |
| `ui/view/GaugeThemeTest.kt` | 25 | 主题：内置稳定 / 十六进制解析 / JSON 往返 / 自建主题 / 损坏 JSON 跳过 / 未知 id 兜底 / **单表卡片覆盖** / **主题别名是冻结契约**（漏一个内置主题就失败） |
| `data/ThemeStudioSampleTest.kt` | 25 | **主题工具产出的 `sample.json` 必须能被 `DesignFile.parse()` 解析且 0 错误**；坐标不被再乘 360；别名落地；**每个内置 PID 都有语义别名**；卡片外框与背景段往返不丢；背景路径不存在只警告；**App 导出→再导入闭环** |
| `ui/view/GaugeAnimatorTest.kt` | 19 | **动画状态机**（v1.10.4）：首帧直达 / null 与 NaN 透传 / 目标稳定后停 / **5Hz 下指针大部分时间都在动** / **τ 变大后动得更久** / 目标跳变后重新计时 / 输入滤波压尖刺 / 重启不抽风 / 四种曲线收敛 / **下降方向也收敛** |
| `obd/CanFrameTest.kt` | 23 | CAN 帧解析 + 按 ID 聚合；**观察表 CSV（v1.20.7）**：**带 UTF-8 BOM** / 中文表头 / `报文ID(dec)` 列 / 29 位 ID / **`maxDlc` 取最长帧**；**v1.20.10**：**`feedRepeated` 与重复调 `feed` 逐字段相同**（count/changed/lastData/maxDlc/values）/ 首次出现也算一次变化 / `times<=0` 什么都不做 / **不追加原始帧流** |
| `obd/SegmentRotationTest.kt` | 22 | **分段轮换扫描（v1.20.10，P12-S5）**：8 段×10 秒×一轮 80 秒 / **段号看 `ATCF` 高三位**（`000`…`700`）/ **每段命令是掩码+过滤两条**（缺一不可）/ 越界段号被夹住 / 8 段首尾相接铺满 `0x000~0x7FF` / 段标签；**状态机**：时间落在哪一段 / 一轮跑完仍是最后一段 / 负时间不崩 / 倒计时单调不增 / **一轮下发 8 次命令** / **被拖慢的一拍把欠下的段补齐不跳段** / 同一段反复评估只下发一次 / 跑完后不再下发 / 构造参数非法即拒；**合并**：count 相加且段内重复不算变化 / **段间值不同时补记一次变化** / 段内多次变化数得出来 / 不同 ID 不串 / 顺序反了不影响 / 空段不崩 / 结果能直接导出观察表 / 收尾时 `acc` 指向它 |
| `obd/FrameRateGateTest.kt` | 14 | **帧率闸（v1.20.6，P10-5）**：正常不误伤 / 超软上限进限流 / 超硬上限进过载 / **迟滞**（阈值上下不每秒抖动）/ 同窗口不重复滚动 / 跳过与丢弃分别记账 / `reset` 清干净 / 过载提示要说清"拆成两次"；**预筛的安全性质**（凡解析后能命中的行必须放行、丢掉的是解析后也命不中的行、空集合不筛） |
| `ui/view/GaugeEasingTest.kt` | 14 | 时间基准缓动：收敛 / 不过冲 / **帧率无关** / **一个 5Hz 周期内不走完（留余量给下次推送）** / 绝对阈值收敛 |
| `ui/dash/DashboardBenchmarkTest.kt` | 12 | 基准排布（铺满 / 不重叠 / 尺寸一致）+ 假值不越界不 NaN + 压力段 12 格不重叠 + 表数比 1.5× |
| `data/BackupTest.kt` | 10 | 完整备份：往返 / **整体替换而非合并** / 三类拒绝 / 旧格式迁移 / 缺段容错 |
| `ui/view/ColumnFlowLayoutTest.kt` | 9 | 分栏 `assign` 纯函数：1 列 / 2 列 / 瀑布流分配 / 空列表 |
| `obd/TriggerGateTest.kt` | 8 | 规则「持续成立 + 冷却后重复触发」语义（转向灯节奏）、条件中断后重新计时 |
| `obd/VehicleBusHistoryTest.kt` | 8 | 趋势历史：有界、NaN / 无穷 / 失败值不入、通道隔离、快照隔离、`clear` |
| `obd/VehicleBusTtlTest.kt` | 8 | **新鲜度（v1.20.7，S2）**：`ttlMs=0` 永不超时（旧行为）/ 未超时照常给 / 超时后 `get` 返回 `ok=false` 副本且**保留原始时间戳** / 超时后 `value` 返回 null（仪表 `--`）/ 超时后 `snapshot` 里也是 `ok=false`（规则不误触发、CSV 记空）/ 读取不写回总线 / 失败值的原因不被覆盖 / 每通道各判各的 |
| `ui/view/NeonStyleTest.kt` | 6 | **霓虹档位名是冻结的跨层契约**；未知名字回落不崩；层数上限夹取 |

> **跑法**：`tools/run-tests.ps1`。**不要**在原路径直接 `./gradlew testDebugUnitTest` ——
> 工程路径含非 ASCII 字符会让测试类报 `ClassNotFoundException`，原因见 §6。
>
> **`org.json` 已换成真实实现**：Android 的 `org.json` 在 JVM 单测里只是会抛 `Stub!` 的桩，
> 所以 `app/build.gradle.kts` 里加了 `testImplementation("org.json:json:20231013")`。
> 因此 `toJson` / `fromJson` **现在是真的被测到了**（v1.3.1 时还测不了）。

---

## 3. 资源文件清单

### 3.1 布局

| 文件 | 行 | 用途 | 限宽 |
|---|---|---|---|
| `layout/activity_main.xml` | 72 | 主界面（竖屏）：状态条 + 容器 + **底部导航** | — |
| `layout-land/activity_main.xml` | 93 | 主界面（横屏）：**左侧 NavigationRailView** + 状态条 + 容器 | — |
| `layout/fragment_dash.xml` | 52 | 仪表盘**宿主**页（v1.20.0）：告警条 + `ViewPager2`（`[画布0][画布1]…[设置]`） | 不限宽（仪表要铺满） |
| `layout/fragment_connect.xml` | 344 | 连接页（含**传输方式**下拉框 `spTransport` + 提示 `tvTransportHint` + 「模拟信号 / CAN 探测 / 性能基准」三个入口） | 根 `MaxWidthNestedScrollView` 720dp |
| `layout/fragment_pid.xml` | 107 | PID 列表页 | 根 `MaxWidthLinearLayout` 760dp |
| `layout/fragment_rule.xml` | 62 | 规则列表页 | 根 `MaxWidthLinearLayout` 760dp |
| `layout/fragment_log.xml` | 97 | 日志页 | 根 `MaxWidthLinearLayout` 900dp |
| `layout/activity_pid_editor.xml` | 473 | **PID 编辑器**（字段最多）。根 `MaxWidthScrollView` 带 id **`scrollRoot`**（v1.20.6：校验失败要能滚到结果行） | `MaxWidthScrollView` 720dp |
| `layout/activity_rule_editor.xml` | 236 | 规则编辑器。根 `MaxWidthScrollView` 带 id **`scrollRoot`**（同上） | `MaxWidthScrollView` 760dp |
| `layout/activity_scanner.xml` | 343 | 扫描器 | `MaxWidthNestedScrollView` 760dp |
| `layout/fragment_dash_canvas.xml` | 272 | **一套画布**（pager 的一页）：`gaugeGrid`（自由画布）+ `lvglDash` + **就地编辑器 `editorCanvas`** + 编辑工具条 2 行 + 画布名浮标 + 右下角「编辑」 | 不限宽（限了预览比例就失真）。⚠️ 浮标的 `layout_gravity`/`padding` 由 `DashCanvasPageFragment.applyNameLabel()` **运行时覆盖**（XML 里的 top|start 只是默认） |
| `layout/fragment_canvas_settings.xml` | 186 | 画布设置页（pager 最后一页）：画布列表 + 当前画布外观 + 轮询间隔 + 音效 + **画布名浮标** + **最近导入记录 `tvLastImport`**（v1.20.6） | 根 `MaxWidthNestedScrollView` 720dp |
| `layout/item_canvas.xml` | 57 | 画布设置页里的一行（名字 + 副标题 + **一个「操作」按钮**；不做四个小按钮，否则每个只剩 40dp） | — |
| `layout/activity_theme_editor.xml` | 175 | 主题编辑器（工具栏 + 实时预览 + 字段容器；字段行代码生成）。预览表各套一层 `pvCard*` 容器画**卡片底** —— 不套的话调描边/不透明度看不到变化 | 不限宽 |
| `layout/dialog_gauge_edit.xml` | 168 | 添加/编辑仪表对话框（含**霓虹档位**与**卡片外框**两个单表覆盖项） | `MaxWidthScrollView` 520dp |
| `layout/item_*.xml` (6) | 13~68 | 各列表行 | — |
| `layout/row_condition.xml` | 47 | 规则条件行（动态插入） | — |
| `layout/row_action.xml` | 52 | 规则动作行（动态插入） | — |

### 3.2 值 / 图形 / 其他

| 路径 | 说明 |
|---|---|
| `values/colors.xml` | 深色车载配色。涨红跌绿按中国习惯 |
| `values/themes.xml` | `Theme.ICarOBD`（Material3 Dark）+ `InputEdit` / `FieldLabel` / `SectionTitle` / `MonoBox` 等复用样式 |
| `values/attrs.xml` | 自定义属性：`MaxWidth_maxWidthDp` |
| `values/strings.xml` | 文案（部分界面文案直接写在代码里） |
| `drawable/` (14) | `bg_*`（卡片/输入/仪表格/告警条）、`dot_*`（连接状态点）、`ic_launcher*`、`ic_nav_*`（5 个导航图标） |
| `menu/bottom_nav.xml` | 底部/侧边导航共用菜单（5 项） |
| `color/nav_item_color.xml` | 导航项选中/未选中色 |
| `raw/` (4) | `tick_left.wav` `tick_right.wav` `warn.wav` `beep.wav`（由 `tools/gen_sounds.py` 生成） |
| `xml/file_paths.xml` | FileProvider 路径（日志/导出分享用） |

---

## 4. 构建与工具

| 路径 | 说明 |
|---|---|
| `settings.gradle.kts` | **阿里云镜像必须保留**，本机 `dl.google.com` 不可达 |
| `app/build.gradle.kts` | `versionCode` / `versionName` 在这里改；`buildFeatures.buildConfig = true` 必需 |
| `tools/gen_sounds.py` | 纯标准库生成 4 个 wav 音效，改音色后重跑 |
| `tools/crop_png.py` | 纯标准库最小 PNG 解码 + 裁剪放大，用于放大截图排查像素级问题（本机无 PIL） |
| `tools/oncar-check.ps1` | **实车取证脚本**（P0-1~P0-4）：一条命令收齐设备/版本、崩溃与 ANR、GATT 表、AT 命令 TX/RX 与超时、初始化结果、轮询与规则、扫描器日志，并按 GATT 表直接给出判定 |
| `tools/theme-studio/tests/verify-crosslang.js` | **跨语言一致性检查**（**103 项**）：从 Kotlin 源码解析常量，与工具逐条比对。改别名/量程/样式/校验文案后必跑 |
| `tools/run-tests.ps1` | **单测入口**：先建 ASCII 目录联接再跑 `testDebugUnitTest`（**不要**在原路径直接跑，见 §6） |
| `tools/run-all.ps1` | **一条命令跑完全部验证**（Kotlin + 构建守卫 + 浏览器套件）。`-SkipBrowser` / `-SkipKotlin` 可按需跳过 |
| `docs/archive/` | **归档的历史文档**。目前是 `CHANGELOG-v1.0~v1.8.md`（含 LVGL 迁移的完整调试日志，8712 行） |
| `tools/run-browser-tests.ps1` | **跑工具的全部浏览器测试套件**（**21 个 / 792 条断言**）。每个套件独立进程；跑前后各清一次测试浏览器残留。`-Filter` 只跑匹配的，`-List` 只列出 |
| `tools/theme-studio/tests/` | 浏览器测试套件（`verify-*.js`，**21 个**）+ `_common.js`（公共前置）。**原来散在 %TEMP% 里**，v2.14.0 搬进仓库；路径从 `__dirname` 推导（v2.15.0） |
| `tools/theme-studio/tests/_common.js` | **测试套件的公共前置**（v2.35.0）：`stubDialogs(cdp)` 把 `alert`/`confirm`/`prompt` 换成空实现。**headless Chrome 里 `alert()` 会阻塞渲染进程**，漏一个就会重现 v2.34.0 那种"求值超时"（报错位置离原因很远，极难查）。文件名以 `_` 开头，不会被 `verify-*.js` 的匹配当套件跑 |

> ⚠️ **上表这些数字会随迭代漂**（套件数、断言数、素材数、用例数）。
> 改完之后顺手核对一遍 —— v2.39.0 就一次揪出 6 处过期数字
> （说 95 素材实际 344、说 16 套件实际 21、说 479 断言实际 792…）。
> **宁可写"见 run-all 输出"，也不要写一个会悄悄变旧的数字。**
| `tools/check-build-guard.ps1` | **构建守卫**：检查 `abiFilters` 是否生效 / APK 是否只编一个 ABI / 体积 / `.ps1` 的 BOM。`abiFilters` 失效那个坑**犯过两次**，所以做成机器检查 |
| `tools/kill-test-browsers.ps1` | **只结束本项目的无头测试浏览器**。判定：profile 路径形如 `*\Temp\edge-*`。**默认只列出、不动手**，加 `-Kill` 才真杀。🔴 **禁止** `Get-Process msedge \| Stop-Process -Force` —— 那会杀掉**用户自己的浏览器窗口**（实测用户 13 个进程、AI 的 0 个，那条命令唯一的实际效果就是干掉用户的浏览器） |
| `tools/theme-studio/png.js` | **极简 PNG 编码器**（零依赖，只用内置 zlib）。PNG 结构 + CRC32 + 绘图原语（rect/roundRect/circle/ring/arc/line/poly）。抗锯齿用**超采样**（4 倍绘制再降采样） |
| `tools/theme-studio/gen-assets.js` | **生成示例素材**：`node gen-assets.js` → `assets/<分类>/*.png`（**344 个**）+ `assets/builtin.js`（清单）。**全部是几何图形，不含任何车标** |
| `tools/theme-studio/` | **PC 端主题制作工具**（v2）：`index.html` + `css/studio.css` + `js/{schema,model,validate,presets,canvas,panels,editor,app}.js` + `png.js`（PNG 编码器）+ `gen-assets.js` + `tests/`（**21 个浏览器套件** + `_common.js` 公共前置） + `gen-sample.js` + `sample.json`(v1) + `sample-v2.json` + `README.md` + `CHANGELOG.md`。**双击 index.html 即用，零安装**（经典脚本，不用 ES module/fetch —— 那在 `file://` 下被 CORS 挡）。校验规则与 `DesignFile.kt` 同源，`ThemeStudioSampleTest` 钉着 |
| `app/src/test/java/com/icar/obd/` | JVM 单元测试（见 §2.5）。**用例数不要写死在这里** —— 跑 `tools/run-tests.ps1` 看 `TOTAL=`（v1.20.11 时是 **44 个文件 / 824 用例**；工作区里可能还有未提交的新测试文件） |
| `docs/screenshots/` | 真机截图：`01~10` 竖屏，`11~17` 横屏 |

### ⚠️ 改这两个地方时必须成对

| 改了 | 必须同时改 | 否则 |
|---|---|---|
| `data/DesignFile.kt` 的校验规则 / 错误文案 / `PID_ALIASES` | `tools/theme-studio/js/validate.js` + `js/schema.js` 里对应的 `parseDesign` / `PID_ALIASES` / `BUILTIN_PIDS` | 编辑器说没问题、App 加载报错。**`tools/theme-studio/tests/verify-crosslang.js`（跨语言 **103 项**）与 `ThemeStudioSampleTest` 都会失败**（这是有意的） |
| `data/PidModels.kt` 的 `GaugeItem` 字段 | `toJson` + `fromJson` + `tools/theme-studio/js/validate.js`（节点解析）/ `js/model.js`（序列化）/ `js/panels.js`（属性面板） | 存量配置丢字段；工具的预览与 App 不一致 |
| `ui/view/NeonStyle.kt` 的档位名 | 存量 `dash.json` / `design.json` 的迁移 | 用户的「夸张」霓虹**静默回落**到「标准」。`NeonStyleTest` 冻结了名字 |
| 渲染层 / 动画（`BaseGaugeView`、`NeonPainter`、`GaugeTicker`、各 View） | 重跑**性能基准**（连接页 →「运行选项」→「性能基准」） | 不知道有没有把 120fps 做掉到 60fps 以下 |
| **旋转语义**（工具侧 `js/canvas.js` 的 `withDeviceRotation` / `deviceMatrix`） | `js/model.js` 的 `ungroupNode`（取消组合要在**设备空间**换算）+ [`主题设计大纲.md`](主题设计大纲.md) §2.3 + `tools/theme-studio/README.md` | 取消组合位置偏 23.7px（父空间转了、设备空间没转）；**阶段 2 实现 App 侧渲染时若按节点空间旋转，会得到平行四边形**（实测 45° 对角线差 209px、内容放大 1.82 倍） |
| **节点树结构**（`js/model.js` 的 `groupNodes` / `reparent`） | `docs/主题设计大纲.md` §2.5 + 工具 CHANGELOG 末尾的「待优化与功能建议」 | 打组后子控件跳位置（`x/y` 相对父节点，换父级要补平移量） |

### 构建命令（必须显式设置环境变量）

PowerShell：

```powershell
Set-Location 'D:\icarobd'
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
$env:ANDROID_HOME = 'C:\Android\Sdk'
.\gradlew.bat assembleDebug
```

Git Bash：

```bash
cd /d/icarobd
export JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
export ANDROID_HOME='C:\Android\Sdk'
./gradlew assembleDebug
```

### 装机与调试

```bash
ADB='C:/Android/Sdk/platform-tools/adb.exe'
$ADB install -r -d app/build/outputs/apk/debug/app-debug.apk
$ADB logcat -d -b crash                       # 装机后第一件事
$ADB exec-out run-as com.icar.obd cat files/log/obd-$(date +%Y%m%d).log
```

---

## 5. 常见修改任务 → 该改哪些文件

| 我想… | 改这些文件 |
|---|---|
| 加一种传输方式（如 WiFi/TCP） | 实现 `ble/ObdTransport.kt` 接口 → 在 `ObdController.buildTransport()` 注册 → `Store.Settings.transportKind` 加一个取值 → 连接页 `transportKeys` 加一项 |
| 加一个内置标准 PID | `data/BuiltInPids.kt` 的 `STANDARD`（**只增不改**） |
| 加一个派生通道（由其它量算出来） | `data/BuiltInPids.kt` 的 `DERIVED` + `obd/VehicleBus.kt` 的 `Derived` |
| 加公式函数（如 `log()`） | `data/Formula.kt` 的 `call()` + `check()` 的提示文案（未知函数列表也要加） |
| 改「信号表」的列（增列/改名/改顺序） | `data/SignalTableCsv.kt` 的 `C_*` 常量与 `COLUMNS`（**导入是按列名匹配的**，改列名会让旧 CSV 读不到那一列 → 必填列缺失就整行拒绝）。规格同步 `下一步-CAN信号库实现规格.md` §3.1 |
| 让一种"值不可信"变成 `--` | 判据放 `data/PidModels.kt` 的**纯函数**（照 `dlcTooShort`/`hitsInvalidRaw` 的样子）→ 在 `obd/FrameMonitor.feedLine` 里调 → 结果写 `PidValue(ok=false)`。**不要**在仪表/规则/CSV 里各判一遍（那就是"两份权威"） |
| 给 PID 编辑器加一个字段（v1.20.8 起） | 三处一起改：`data/PidDraft.kt`（`Fields` + `of()` + `build()` + 校验）→ `res/layout/activity_pid_editor.xml`（控件）→ `ui/PidEditorActivity.kt`（`evaluate()` 读它、`applySourceUi()` 决定对哪一类来源可见）。**校验只写在 `PidDraft` 里**（写在 Activity 里就一条都测不到） |
| 改"哪些字段对监听型/主动请求型适用" | `ui/PidEditorActivity.applySourceUi()`（只改 `visibility`，**不许清空输入框** —— 隐藏不等于清空，清了就会丢用户的值） |
| 改探测页"解码显示"的规则 | `data/SignalDecode.kt`（纯函数：`decode` / `text` / `indexByHeader`）→ `ui/CanSnifferActivity.decodeLines/decodeColor/decodeSummary` 负责呈现。**"不可信"的判据必须复用 `PidModels` 的 `dlcTooShort`/`hitsInvalidRaw`**，不要在 `SignalDecode` 里另写一份 |
| 加一个音效 | wav 放 `res/raw/` + `data/AudioPlayer.kt` 的 `sounds` 表登记一行 |
| 加一种规则动作类型 | `obd/ObdController.handleAction` + `data/PidModels.kt` 的 `RuleAction.describe()` + `ui/RuleEditorActivity` 的 `actionTypes`/`updateActionHints` |
| 改内置仪表盘布局 | `data/DashLayout.kt`（**内容**在这里；`ui/dash/DashSpec.kt` 只做"类型 → 列表"的分发） |
| 加 / 改"一套画布"的字段 | `data/DashCanvas.kt`（字段 + `toJson`/`fromJson`）**并且**在 `Store.snapshotToActiveCanvas` 与 `Store.loadActiveCanvas` **两处都加** —— 只加一处 = 切画布时静默丢设置 |
| 改画布页的渲染 / 就地编辑 | `ui/dash/DashCanvasPageFragment.kt`（宿主 `ui/DashFragment.kt` 只管翻页与"谁在渲染"的裁决） |
| 加一个画布设置项 | `ui/dash/CanvasSettingsFragment.kt` + `res/layout/fragment_canvas_settings.xml`。⚠️ 带监听的控件在 `refresh()` 里回填时要**先判 `binding`**（否则程序化赋值会触发用户操作的副作用） |
| 加一个双指手势动作 | `data/GestureActions.kt`（`ACTION_IDS` / `ACTION_NAMES` / `shortAction` **三处一起加**）+ `ui/MainActivity.runGesture` 的 `when` 加分支。**执行只能在这一处**，设置页只编辑那张表。⚠️ **新动作追加在 `ACTION_IDS` 末尾**（下标被 `Store.Settings` 与设置页 Spinner 用，插中间会让旧配置落错动作）；⚠️ 新动作的**默认值默认是「无」**（`DEFAULTS` 不改 = 升级不改变手感） |
| 改"切上/下一个 tab"的**循环顺序** | `data/GestureActions.kt` 的 **`TAB_TAGS`**（顺序的唯一一处）+ `res/menu/bottom_nav.xml`（导航栏本身）**两处一起改**；相邻页计算在 `adjacentTab`（纯函数，边界有单测），`MainActivity.navItemIdOf` 只做 tag → `R.id.nav_*` 的映射。**执行复用 `switchTo`**（改导航栏 `selectedItemId`），不要另写一套页面切换 |
| 改分段轮换（S5）的参数 / 段号 / 合并语义 | `obd/SegmentRotation.kt`（`SEGMENT_COUNT` / `SEGMENT_MS` / `segmentCommands` / `merge`）**唯一一处**；`CanSniffer` 只负责"什么时候调"（`uiTicker` 换段、收尾结算最后一段）。⚠️ **`ATCM700` 掩码与 `ATCF<段>00` 必须成对下发** —— 少了掩码，`ATCF000` 放行的是整条总线而不是第 0 段。⚠️ 判定**不要搬进 `CanSniffer`**（object + `Handler(Looper.getMainLooper())` → JVM 里测不到） |
| 改知识库 / 使用手册的**内容或标签** | `ui/KnowledgeFragment.kt` 的 `SECTIONS`（正文）+ **`TAG_MAP`（按节索引挂标签，中间插节必须一起改）** + `TAGS`（词表，加标签时别忘）。⚠️ **正文里不许写 Markdown**（`**` / 反引号会原样显示）；⚠️ 手册每节要保住 `【前置】/【步骤】/【判据】/【没成功怎么办】` 四栏。改完跑 `ui/KnowledgeFragmentTest.kt`（12 条结构守卫会告诉你哪里错位/分叉/写了星号） |
| 改设计包（`.icarzip`）的格式或校验 | 格式由 `tools/theme-studio/js/pack.js` 定义 → App 侧 `data/DesignPack.kt`（`PACK_FORMAT` / `parseManifest` / `unpack`）→ 入口 `ui/dash/CanvasSettingsFragment.importPack`。**两边的字段名必须一致**，改一边不改另一边会让所有旧包被拒收 |
| **画布上什么东西"看不见"了 / 表盘空了** | 先分清是**树的问题**还是**像素的问题**：① `container.childCount` 与日志「仪表盘已落盘 \| 表=N」**都正常**、`uiautomator dump` 里那一层**整个消失** → 是 **0 尺寸**（`ui/dash/CanvasRebuildPolicy.kt` + `DashRenderer.scheduleSizeCheck` 那条 W 就是为它准备的）；② 日志里 `仪表盘渲染推迟：容器还没有尺寸` / `无可渲染的表：PID 全部查不到` / `设计渲染` → 才是渲染链本身。🔴 **只要在 layout 期间动 View 树（`addView`/`removeView`）就会变成 ①** —— 一律走 `post`，见 `DashRenderer.relayout()` 的注释 |
| 加 / 改**规则提示**的表现（灵动岛 / Toast / 告警条） | 提示的**唯一入口**是 `ObdController.handleAction` 的 `toast` 分支 → `toast()`（系统 Toast）+ `emitAlert()`（→ `MainActivity.onAlert` → `ui/view/IslandNotice.kt`）。⚠️ **不要新造动作类型**，也不要在 `DashFragment` 里再挂一处 —— "规则提示"曾经有两处（系统 Toast + 页面内告警条），而那条页面内告警条**就是** v1.20.12 那个"画布全消失"的触发条件（它让 pager 重新量尺寸）。⚠️ 灵动岛**必须保持浮层**（挂 `android.R.id.content`、`WRAP_CONTENT`、`isClickable=false`），改布局或让它可点会分别踩"画布重排"和"抢手势"两个坑。改展开/收起/`+N` 的语义改 `ui/view/IslandStateMachine.kt`（纯逻辑，有 12 条单测） |
| **PID 页出现重复 / 要改"什么叫重复"** | 判据只有一处：`data/PidDedup.kt`（`isSameSignal` / `bitFingerprint` / `findDuplicates` / `removable`）。清理动作在 `Store.cleanupDuplicatePids`（**三条安全闸：只删自定义 / 被仪表或规则引用的不删 / 先给用户确认**），入口是 PID 页的 `btnDedup`（默认 GONE，有重复才出现）。⚠️ 加新的"造 PID"路径时（导入 JSON / 扫描器命中 / 信号表导入 / 复制模板）要顺手想一遍它会不会产生重复 —— `Store.importTemplatesAsCustom` 就是漏了这一条才把实车确认过的 `mon_turn_*` 复制成两份的 |
| **加 / 改灵动岛样式**（位置 / 尺寸 / 配色 / 停留 / 圆角） | 取值、默认值、归一化、`Spec` 解析、摘要、色值解析**只有一处**：`data/IslandStyle.kt`（纯函数，17 条单测）。**样式 → View 的映射也只有一处**：`ui/view/IslandCapsuleView.applySpec`（设置页预览与真弹的胶囊共用它）。加一档 = 改 `IslandStyle` 的常量/名字表/归一化 + 对话框里那一行 Spinner（**漏改归一化的表现是"手改坏的配置不兜底"**）。⚠️ **默认值必须保持 = v1.20.12 的样子**（`IslandStyleTest` 逐个断言）—— 改默认值等于"升级后观感变了"。⚠️ **位置档位只能改水平对齐**：给它纵向自由度 = 用户能把胶囊拖到画布正中间 = 重现 v1.20.12 那个病。⚠️ 三条硬约束不许破（浮层不改布局 / 不抢触摸 / 与警示条错开），改完按 `CHANGELOG` v1.20.13 的判据上真机复验 |
| **两条 PID"看起来重复"要不要合并 / 能不能删** | 先分清楚是哪一类：① **同一个信号的两份条目**（`PidDedup` 判得出来）→ 可以清理，走 PID 页的「清理 N 条重复」；② **输入与派生输出的关系**（如 `std_5E` 与 `calc_lh`：同单位、同一个量，但一个是 `01 5E` 的原始读数、一个是 `Derived.computeAll` 算出来的）→ **不能删**，`PidDedup` 刻意不判内置之间的重复。要"列表里只出现一条"就在 `data/PidMerge.kt` 里登记（`FOLDED_IDS` + `filterForList`），**过滤只能发生在"拿去做列表"那一步**，`Store.allPids()` 一行都不许动（轮询 / 模拟器 / 派生通道读的都是它）。⚠️ 编辑器里必须把"当前绑定的 id"传进 `keep`，否则 Spinner 会停在 0 号并把老仪表/老规则**静默改掉** |
| 改"设计包解压到哪 / 素材基目录怎么定" | `ui/dash/CanvasSettingsFragment.importPack`（解压目录 = `files/design/<时间戳>/`）+ `applyDesign` 的 `baseDirOverride`（**必须等用户点「导入」才写 `designBaseDir`**） |
| 增加或调整仪表盘风格 | `ui/view/GaugeTheme.kt`（调色板）；需要新的绘制效果时改对应 `ui/view/*GaugeView.kt` |
| 加一种仪表样式 | 继承 `ui/view/BaseGaugeView.kt` + 在 `DashRenderer.createView` 注册 + `naturalHeightPx` 加高度 |
| 改默认规则/默认仪表 | `data/Defaults.kt`（只影响首次启动，已装机的用户需「恢复默认」） |
| 加一个导航页 | `menu/bottom_nav.xml` + `MainActivity.createFragment`/`switchTo` + 新建 Fragment 与布局 |
| 调扫描器安全参数 | `obd/PidScanner.kt`（**只收紧，不放松**） |
| 调轮询节奏 | `Store.Settings.pollIntervalMs`（全局）或单条 PID 的 `intervalMs` |
| 改配色/主题 | `values/colors.xml` + `values/themes.xml` |
| 改版本号 | `app/build.gradle.kts` 的 `versionCode`/`versionName` |
| 加一个自定义控件属性 | `values/attrs.xml` 登记 + 控件构造函数 `obtainStyledAttributes` 读取 |

架构边界、UI 自适应和维护约定见 [ARCHITECTURE.md](ARCHITECTURE.md)。

---

## 6. 环境约束（本机特有，都踩过坑）

### 6.1 工程路径含空格 + 非 ASCII 字符

工程位于 `D:\AI Dsh\车机项目\iCarOBD2`（2026-10-06 起；构建走联结 `D:\icarobd`）。两个后果：

| 任务 | 影响 | 对策 |
|---|---|---|
| `assembleDebug` | AGP 默认拒绝构建（`Your project path contains non-ASCII characters`） | `gradle.properties` 的 `android.overridePathCheck=true`（已加） |
| `testDebugUnitTest` | **必然失败**：JVM 启动器用系统 ANSI 代码页解码 `-cp`，中文路径被解坏，测试类报 `ClassNotFoundException: <测试类自身>`（全部类都是 `initializationError`） | 用 `tools/run-tests.ps1`：建 ASCII 目录联接 `D:\icarobd` 指向工程真实位置，从联接路径跑 |

实测结论（2026-10-02）：

- 同一份代码放到纯 ASCII 路径 → **全部用例通过**（数量见 `run-all.ps1` 输出）；
- 加 `-Dsun.jnu.encoding=UTF-8`（Gradle 守护进程与测试 worker 都加）→ **无效**，
  因为 argv 在 `-D` 生效之前就已被启动器解码。

### 6.1.1 ⚠️ 改 `tools/*.ps1` 必须保留 UTF-8 BOM

**Windows PowerShell 5.1 对无 BOM 的 `.ps1` 按 ANSI(GBK) 解码。**
中文注释会变成乱码，而且**会把行尾吃掉**，导致下一行代码被并进注释里 ——

```
# 所以按可靠性依次回退：… → $MyInvocation.MyCommand.Path。
if (-not $ProjectDir) {        ← 这一行被并进上一行注释，整个 if 消失
```

报错是 `Unexpected token '}' in expression or statement`，
**看起来像语法错误，实际是编码问题** —— 顺着报错行去查语法会白费很久。

| 对策 | 说明 |
|---|---|
| 编辑 `.ps1` 时保留 BOM | 本机 `oncar-check.ps1` 一直有 BOM，可以对照 |
| 用 .NET 显式写 | `[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($true)))` |
| 验证 | `[System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$null, [ref]$errs)` |

> v1.10.1 实测栽过一次：`run-tests.ps1` 被写掉了 BOM，
> 结果脚本**一个用例都没跑就退出**，而报错指向的是语法。
> 同期的 `docs/*.md` 与 `.kt` 不受影响（Markdown / Kotlin 都按 UTF-8 读）。

> 若把工程移回纯 ASCII 路径（如原先的 `D:/AIWorkbuddy/ELM327`），
> `android.overridePathCheck` 与 `run-tests.ps1` 的联接都可删除。

### 6.2 其他

- `dl.google.com` 不可达 → `settings.gradle.kts` 的阿里云镜像**不能删**。
- `--offline` 构建**必然失败**（本地缺 plugin marker）。
- 向 `adb` 传含中文的路径容易编码错乱 → 用 `D:\icarobd`（ASCII 联接）下的产物最稳。
- **PowerShell 脚本含中文时必须带 UTF-8 BOM**，否则 Windows PowerShell 5.1 按 ANSI 读取，
  会直接报语法错误（`oncar-check.ps1` / `run-tests.ps1` 都已带 BOM；
  用编辑器改完若 BOM 丢了，记得补回来）。

---

## 7. 文档清单（`docs/` 逐份职责）

> **权威的读法顺序在 [`接手大纲.md`](接手大纲.md) §2** —— 这里只回答"这份是干什么的"。
> 新增文档请**同时**加进本节与 §1 的目录树。

| 文件 | 职责 |
|---|---|
| docs/接手大纲.md | **唯一入口**：项目全貌 + 上手路线 + 验证方法 + 交付物清单 |
| docs/交接-换电脑.md | **换机专用**：搬什么 / 工具链怎么起 / 本机实测偏差 |
| docs/上车监控清单.md | **上车专用**：环境 / 实时监控 / **§4 判据表** / **§11 本趟工单** / 取证 / 已知的坑 |
| docs/迭代清单.md | 版本清单 + 待办（带验收标准）+ 发版固定动作 + **§五 当前阻塞关系** |
| docs/ARCHITECTURE.md | **为什么这样设计**：分层边界、数据流、排障、**§4 红线唯一权威清单** |
| docs/HANDOVER.md | 详细手册：扩展流程（加 PID / 加规则）、安全模型、装机清单、踩坑 |
| docs/CHANGELOG.md | 逐版本变更 + 根因 + **验证方式 + 遗留问题**（最老的部分在 `docs/archive/`） |
| docs/主题设计大纲.md | **主题设计系统架构**（节点树 / 素材 / 状态 / 分辨率 / 编辑器分阶段） |
| docs/UI设计指南.md | `icar.ui/1` 设计文件格式（PC 端做设计用） |
| docs/UI控件清单.md | **UI 控件清单**：全部自定义 View、控件 ID、颜色/样式/drawable 资源 |
| docs/动画实现.md | **动画实现分析**：共用时钟 / 数值缓动 / 阈值爆闪，两套机制的区别 |
| docs/仪表框架.md | 8 种仪表 + 「某块表为什么是空的」排查顺序 |
| docs/LVGL-放弃记录.md | LVGL 方案放弃记录（动机/成果/原因/保留项/后续） |
| docs/主题格式参考.md | Sky Gauge 格式逆向（已不用，格式知识仍有效） |
| docs/CAN-信号库与逆向框架.md | **CAN 信号逆向的方法论**（DBC 分析 / 采样率是前提 / 四阶段方案） |
| docs/下一步-CAN信号库实现规格.md | **上一条的执行规格**：S1/S2 已做（v1.20.7），S3~S5 待做 |
| docs/下一步-主题工具与仪表盘重构.md | 主题制作工具 + 仪表盘重构分步方案（**已完成**，留作决策记录） |
| docs/下一步-变量模式与组件变体.md | **主题工具的下一轮执行规格**（变量·模式 / 组件·变体，待评审，App 侧零改动） |
| docs/archive/ | 归档的历史文档（`CHANGELOG-v1.0~v1.8.md`，含 LVGL 完整调试日志） |
| docs/screenshots/ | 真机截图 + 索引 README |
