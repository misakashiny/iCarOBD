# UI 控件清单

> **本工程所有 UI 控件的名字、类型、位置。** 做设计/改代码时查这一份就够。
> 配套：[UI设计指南.md](UI设计指南.md)（设计文件格式）· [ARCHITECTURE.md](ARCHITECTURE.md)（分层红线）

---

## 一、仪表控件（8 种样式）

`GaugeItem.style` → View 的映射。**这是唯一的映射点**（红线 20：单一映射），
新增样式只改 [GaugeViewFactory](../app/src/main/java/com/icar/obd/ui/view/GaugeViewFactory.kt)。

| style | 名称 | View 类 | 画什么 | 需要 |
|---|---|---|---|---|
| `0` | 圆表 | `CircularGaugeView` | 霓虹辉光弧 + 危险区 + 刻度 + 指针环 + 5 层指针 + 中心读数 | 值 |
| `1` | 数字 | `DigitalGaugeView` | 大号读数 + 单位 | 值 |
| `2` | 条形 | `BarGaugeView` | 名称 + 读数 + 霓虹进度条 + 阈值刻度线 | 值 |
| `3` | 线型图 | `LineChartView` | 趋势曲线（60 点）+ 读数 | **历史**，不是单值 |
| `4` | 双数据·上下 | `DualStackGaugeView` | 主参数在上、1 个副参数在下，各占一半 | 主值 + 1 副值 |
| `5` | 四数据 | `QuadGaugeView` | 主参数 + 3 副参数，2×2 | 主值 + 3 副值 |
| `6` | 主+子双数据 | `SubDualGaugeView` | 主参数占上半（大），2 个副参数下半并排 | 主值 + 2 副值 |
| `7` | G 力值 | `GForceGaugeView` | G 值大表 + 横/纵分量 | 3 个值 |

**继承关系**：

```
View
 └─ BaseGaugeView                    ← 缓动 / 主题绑定 / 报警等级 / 霓虹样式 都在这一层
     ├─ CircularGaugeView
     ├─ DigitalGaugeView
     ├─ BarGaugeView
     ├─ LineChartView
     ├─ GForceGaugeView
     └─ MultiValueGaugeView          ← 多值卡的公共基类（缓存画笔 + 画一个数值单元）
         ├─ DualStackGaugeView
         ├─ QuadGaugeView
         └─ SubDualGaugeView
```

---

## 二、全部自定义 View

`app/src/main/java/com/icar/obd/ui/view/`

| 类 | 基类 | 职责 |
|---|---|---|
| `BaseGaugeView` | `View` | **所有仪表的基类**。缓动、主题绑定、报警等级、霓虹样式、绘制计时 |
| `CircularGaugeView` | `BaseGaugeView` | 圆表 |
| `DigitalGaugeView` | `BaseGaugeView` | 数字表 |
| `BarGaugeView` | `BaseGaugeView` | 条形表 |
| `LineChartView` | `BaseGaugeView` | 趋势折线 |
| `GForceGaugeView` | `BaseGaugeView` | G 力值表 |
| `MultiValueGaugeView` | `BaseGaugeView` | 多值卡公共基类（`drawCell` 画一个单元） |
| `DualStackGaugeView` | `MultiValueGaugeView` | 双数据·上下 |
| `QuadGaugeView` | `MultiValueGaugeView` | 四数据 2×2 |
| `SubDualGaugeView` | `MultiValueGaugeView` | 主大副小 |
| `ColumnFlowLayout` | `ViewGroup` | **两列瀑布流**（PID 列表、主题字段、扫描结果用） |
| `MaxWidthScrollView` | `ScrollView` | 限制最大宽度的滚动容器（大屏上表单不至于拉满） |
| `MaxWidthNestedScrollView` | `NestedScrollView` | 同上，嵌套滚动版 |
| `MaxWidthLayout` | `ViewGroup` | 限制最大宽度的普通容器 |
| `MaxWidthLinearLayout` | `LinearLayout` | 限制最大宽度的线性容器 |
| `DashCanvasEditorView` | `ViewGroup` | **自由画布编辑器**：拖拽 / 缩放 / 吸附 / 选中高亮 |
| `DashGridOverlayView` | `View` | 参考线叠加层（独立 View 是为了不污染渲染层） |
| `WaveThumbView` | `View` | **波形缩略图**（模拟器用）。复用 `SignalSimulator.waveAt`，预览不可能和实际脱节 |

**非 View 的绘制辅助**：

| 类 | 职责 |
|---|---|
| `NeonPainter` | 共用霓虹辉光绘制层（弧 / 线 / 圆 / 圆角矩形 / 文字） |
| `GaugeTicker` | **共用动画时钟**（Choreographer）。所有仪表在同一帧重绘 |
| `AlertPulse` | 阈值报警 + 爆闪的纯逻辑（**带迟滞**，两档节奏） |
| `NeonStyle` | 霓虹样式（`enabled`/`layers`/`spreadRatio`/`intensity`/`textGlow`） |
| `GaugeTheme` | 主题（颜色 + 圆角 + 描边 + 霓虹默认值） |
| `GaugeViewFactory` | **style → View 的唯一映射** |
| `DrawStats` | 绘制耗时统计（应用内，`dumpsys gfxinfo` 在本机不可用） |
| `DashboardBackground` | 仪表盘背景图（降采样 + 缓存） |

---

## 三、布局文件与控件 ID 全表

> **改代码时用 `R.id.xxx` 引用；做设计时用下表核对控件是否存在。**

### activity_main.xml —— 主框架

| 类型 | ID | 说明 |
|---|---|---|
| `LinearLayout` | `rootLayout` | 根容器 |
| `LinearLayout` | `statusBar` | 顶部状态条 |
| `View` | `connDot` | 连接状态圆点（`dot_online`/`dot_offline`/`dot_warn`） |
| `TextView` | `tvStatus` | 连接状态文字 |
| `TextView` | `tvRate` | 采样率（`-- Hz`） |
| `FrameLayout` | `pageContainer` | **四个 Fragment 的容器**（show/hide 切换，不走 replace） |
| `BottomNavigationView` | `navView` | 底部导航 |

**导航项 ID**：`nav_dashboard` / `nav_connect` / `nav_pid` / `nav_rule` / `nav_log`

### fragment_dash.xml —— 仪表盘（**v1.20.0 起只是宿主**）

| 类型 | ID | 说明 |
|---|---|---|
| `TextView` | `alertBanner` | **告警横幅**（规则触发 / 模拟数据提示）。跨画布，所以放在 pager 之外 |
| `ViewPager2` | `dashPager` | `[画布0][画布1]…[设置]`；页码变化即切 `activeCanvasId` |

> ⚠️ v1.20.0 **删掉了** `dashToggle` / `btnDashNormal` / `btnDashPerf` / `btnDashCustom` /
> `btnDashPreset` / `btnDashTheme` / `btnEditDash`。原能力的新位置：
> 「布局 / 风格」→ 设置页的 `btnCanvasLook`；「编辑」→ 画布页的 `btnEditCanvas`。

### fragment_dash_canvas.xml —— 一套画布（含就地编辑器）

| 类型 | ID | 说明 |
|---|---|---|
| `FrameLayout` | `canvasArea` | **画布区**。背景（主题纯色 / 背景图）画在这一层 —— 编辑态工具条占高度，画在根上背景定位会对不上 |
| `FrameLayout` | `gaugeGrid` | **仪表容器**（Android 自绘路径往这里塞 View） |
| `LvglDashView` | `lvglDash` | LVGL 渲染面（**已废弃**，`dashEngine` 强制为 0） |
| `TextView` | `tvDashEmpty` | 空布局提示 |
| `DashCanvasEditorView` | `editorCanvas` | **就地编辑器**（编辑态显示，直接持有 `Store` 里的 `GaugeItem` 实例） |
| `LinearLayout` | `editBar` | 编辑工具条（2 行，编辑态才显示） |
| `MaterialButton` | `btnAdd` / `btnEditGauge` / `btnDeleteGauge` / `btnFrontGauge` / `btnPreset` / `btnGrid` / `btnSnap` / `btnDone` | 编辑工具条的按钮（`btnDone` = 退出并保存） |
| `TextView` | `tvEditorHint` | 编辑提示（已选哪块 / 吸附状态） |
| `TextView` | `tvCanvasName` | 画布名浮标（半透明 overlay，不占布局高度）。**位置四角/隐藏可选**（v1.20.1）：`layout_gravity` + `padding` 由 `applyNameLabel()` 运行时设 |

> ⚠️ v1.20.2 **删掉了** `btnEditCanvas`（画布页右下角那个「编辑」）。
> 编辑入口搬到设置页的**操作菜单**（「编辑这一套…」）—— 用户要求，
> 而且编辑是破坏性动作，常驻按钮在车上容易误触。

### fragment_canvas_settings.xml + item_canvas.xml —— 画布设置页（最后一页）

| 类型 | ID | 说明 |
|---|---|---|
| `TextView` | `tvCanvasCount` | `共 N 套 · 上限 8 套` |
| `LinearLayout` | `llCanvasList` | 画布行容器（**代码生成**，每行 `item_canvas.xml`） |
| `MaterialButton` | `btnAddCanvas` | 新增画布 |
| `MaterialButton` | `btnImportCanvas` / `btnExportCanvas` | **导入 / 导出画布**（v1.20.2，一行两个；对接 `tools/theme-studio`） |
| `TextView` | `tvCurrentCanvas` | `当前：名字 · 类型 · N 个仪表` |
| `MaterialButton` | `btnCanvasTheme` | 画布主题（**只作用于当前这一套**） |
| `MaterialButton` | `btnCanvasLook` | 背景 / 设计文件 / 参考线 / 卡片样式菜单 |
| `MaterialButton` | `btnPollInterval` | 轮询间隔（全局） |
| `MaterialSwitch` | `swSound` | 音效（全局，改完当次生效） |
| `MaterialButton` | `btnNameLabel` | **画布名浮标位置**（左上/右上/左下/右下/隐藏，全局） |
| `item_canvas.xml` | `tvName` / `tvSub` / `btnRowMenu` | 每行：名字（`●` = 当前）/ 副标题 / 「操作」菜单（改名·上移·下移·前往·删除） |

### fragment_connect.xml —— 连接页

| 类型 | ID | 说明 |
|---|---|---|
| `View` | `connDot` | 状态点 |
| `TextView` | `tvConnState` | 连接状态 |
| `TextView` | `tvConnHz` | 采样率 |
| `Spinner` | `spTransport` | 传输方式（BLE / 经典蓝牙 SPP） |
| `TextView` | `tvTransportHint` | 传输方式说明 |
| `MaterialButton` | `btnScan` | 扫描设备 |
| `MaterialButton` | `btnStopScan` | 停止扫描 |
| `TextView` | `tvDeviceHint` | 设备列表提示 |
| `RecyclerView` | `rvDevices` | 设备列表（`item_device.xml`） |
| `Spinner` | `spProtocol` | 协议选择 |
| `MaterialButton` | `btnInit` | 初始化 ELM327 |
| `MaterialButton` | `btnDisconnect` | 断开 |
| `TextView` | `tvInitInfo` | 初始化信息 |
| `TextView` | `tvInitSteps` | 初始化步骤 |
| `TextView` | `tvBusInfo` | 总线健康度 |
| `MaterialSwitch` | `swSound` | 音效开关 |
| `MaterialSwitch` | `swCsv` | CSV 记录 |
| `MaterialSwitch` | `swMirror` | 日志镜像到 logcat |
| `MaterialSwitch` | `swScreenOn` | 行车保持亮屏 |
| `Spinner` | `spGForce` | G 值来源 |
| `MaterialButton` | `btnSimulator` | **进入模拟信号页** |
| `MaterialButton` | `btnCanSniffer` | 进入 CAN 被动探测 |
| `MaterialButton` | `btnDashEngine` | 引擎切换（**已隐藏**，`visibility = GONE`） |

### fragment_pid.xml —— PID 列表

| 类型 | ID |
|---|---|
| `MaterialButton` | `btnAddPid` / `btnScanner` / `btnImport` / `btnExport` / `btnSeedMazda` |
| `TextView` | `tvPidHint` |
| `RecyclerView` | `rvPids` |

### fragment_rule.xml —— 规则列表

| 类型 | ID |
|---|---|
| `MaterialButton` | `btnAddRule` / `btnResetRules` |
| `TextView` | `tvRuleHint` |
| `RecyclerView` | `rvRules` |

### fragment_log.xml —— 日志页

| 类型 | ID |
|---|---|
| `Spinner` | `spLevel` / `spModule` |
| `MaterialButton` | `btnLogPause` / `btnLogExport` / `btnLogClear` |
| `TextView` | `tvLogStats` |
| `RecyclerView` | `rvLogs` |

### activity_simulator.xml —— 模拟信号（v1.9.0 重构）

| 类型 | ID | 说明 |
|---|---|---|
| `View` | `simDot` | 运行状态点 |
| `TextView` | `tvSimStatus` | `运行中 · N 个通道 @10Hz` |
| `TextView` | `tvSimHint` | 说明文字 |
| `MaterialButton` | `btnSimToggle` | 开始/停止模拟 |
| `MaterialButton` | `btnSimDemo` | 满量程快扫 |
| `MaterialButton` | `btnSimAllAuto` | 全部恢复默认 |
| `MaterialButton` | `btnSimRebuild` | 重新读取 PID |
| `LinearLayout` | `simChannels` | **通道列表容器**（代码生成，分组 + 可折叠） |

### ~~activity_dash_editor.xml~~ —— **v1.20.0 已删除**

原来的全屏拖拽编辑器被**就地编辑**取代（见上面的 `fragment_dash_canvas.xml`）。
`DashEditorActivity.kt` 与这个布局文件都已删除，`AndroidManifest.xml` 里的声明也去掉了。
按钮对应关系：`btnAdd` / `btnEditGauge` / `btnDeleteGauge` / `btnFrontGauge` /
`btnPreset` / `btnGrid` / `btnSnap` 原样搬到画布页的工具条；
`btnSave` **没有了** —— 退出编辑（`btnDone`）与 `onPause` 都会自动保存。

### dialog_gauge_edit.xml —— 单块表编辑对话框

| 类型 | ID | 说明 |
|---|---|---|
| `Spinner` | `spPid` | 绑定哪个 PID |
| `Spinner` | `spStyle` | 样式（0..7） |
| `Spinner` | `spSpan` | 占位宽度（半宽/整行） |
| `Spinner` | `spNeon` | **霓虹档位**（跟随主题/关闭/克制/标准/强烈/夸张） |
| `EditText` | `etMin` / `etMax` / `etWarnLow` / `etWarnHigh` | 量程与报警阈值 |

### activity_theme_editor.xml —— 主题编辑器

| 类型 | ID | 说明 |
|---|---|---|
| `MaterialButton` | `btnThemeSave` / `btnThemeSaveAs` / `btnThemeDelete` / `btnThemeRevert` / `btnThemeExport` / `btnThemeImport` | |
| `TextView` | `tvThemeTitle` | |
| `CircularGaugeView` | `pvCircle` | **实时预览：圆表** |
| `BarGaugeView` | `pvBar1` / `pvBar2` | **实时预览：条形** |
| `ColumnFlowLayout` | `themeFields` | 字段容器（代码生成） |

### 其它布局

| 文件 | 控件 ID |
|---|---|
| `activity_pid_editor.xml` | `etName` `spProtocol` `etMode` `etPid` `etRequest` `etFormula` `btnTpl1` `btnTpl2` `btnTpl3` `btnTpl4` `btnTpl5` `etUnit` `etMin` `etMax` `etWarnLow` `etWarnHigh` `etGroup` `etInterval` `spPriority` `etEcuIndex` `etNote` `swEnabled` `btnTest` `btnSample` `tvTx` `tvRx` `tvBytes` `tvResult` `btnDelete` `btnSave` |
| `activity_rule_editor.xml` | `etName` `swEnabled` `spLogic` `etDuration` `etCooldown` `condContainer` `btnAddCond` `actionContainer` `btnAddAction` `tvPreview` `btnTestNow` `tvTestResult` `btnDelete` `btnSave` |
| `activity_scanner.xml` | `tvWarning` `spMode` `etFrom` `etTo` `etInterval` `etTimeout` `etRetry` `etMax` `etLearn` `etBlacklist` `swBitmap` `swConfirm` `btnStart` `btnStop` `progress` `tvProgress` `rvHits` `tvLog` |
| `activity_can_sniffer.xml` | `btnSniffToggle` `btnSniffClear` `spSniffDuration` `btnSniffExportAgg` `btnSniffExportRaw` `tvSniffStatus` `sniffResults` |
| `item_device.xml` | `tvDevName` `tvDevAddr` `tvRssi` `btnConnect` |
| `item_pid.xml` | `tvName` `tvSub` `tvNote` `swEnable` `btnDelete` |
| `item_pid_header.xml` | `tvHeader` |
| `item_rule.xml` | `tvName` `tvDesc` `tvState` `swEnable` `btnDelete` |
| `item_scan_hit.xml` | `tvTitle` `tvRaw` `tvPreview` `btnSave` |
| `item_log.xml` | `tvLog` |
| `row_condition.xml` | `spSource` `spOp` `etThreshold` `btnRemove` |
| `row_action.xml` | `spType` `etP1` `etP2` `btnRemove` |

---

## 四、颜色资源

`res/values/colors.xml`

### 界面基础

| 名字 | 值 | 用途 |
|---|---|---|
| `bg` | `#FF0A0D12` | 全局背景 |
| `bg_surface` | `#FF141A23` | 卡片 |
| `bg_surface2` | `#FF1C2430` | 卡片（次级 / 展开态） |
| `bg_elevated` | `#FF212B39` | 浮起元素（chip、按钮底） |
| `divider` | `#FF2A3547` | 分隔线 |

### 文字

| 名字 | 值 | 用途 |
|---|---|---|
| `text_primary` | `#FFE8EEF7` | 主文字 |
| `text_secondary` | `#FF9AA8BC` | 次文字 |
| `text_dim` | `#FF5F6E85` | 弱化文字 / 提示 |

### 语义色

| 名字 | 值 | 用途 |
|---|---|---|
| `accent` | `#FF00D8FF` | 强调（青） |
| `accent2` | `#FF7C5CFF` | 强调（紫） |
| `accent_dim` | `#6600D8FF` | 强调（半透明） |
| `ok` | `#FF2FD47A` | 正常 / 成功 |
| `warn` | `#FFFFB020` | 警告 |
| `danger` | `#FFFF4D4F` | 危险 / 报警（**爆闪用这个色**） |
| `info` | `#FF4DA3FF` | 信息 |

### 仪表专用

| 名字 | 值 | 用途 |
|---|---|---|
| `gauge_track` | `#FF263143` | 底轨 |
| `gauge_tick` | `#FF4A5A73` | 未点亮的刻度 |
| `gauge_needle` | `#FFFF4D4F` | 指针 |
| `gauge_value` | `#FFFFFFFF` | 读数 |
| `gauge_label` | `#FF8FA0B8` | 标签 / 单位 |

### 扫描

| 名字 | 值 |
|---|---|
| `scan_hit` | `#FF2FD47A` |
| `scan_miss` | `#FF3A465C` |

---

## 五、样式资源

`res/values/` 下：

| 样式名 | 用途 |
|---|---|
| `Theme.ICarOBD` | 应用主题（深色） |
| `CardStyle` | 卡片容器 |
| `SectionTitle` | 分节标题 |
| `FieldLabel` | 表单字段标签 |
| `InputEdit` | 输入框 |
| `InputEditMono` | 等宽输入框（PID / 公式用） |
| `MonoBox` | 等宽文本框（收发报文用） |
| `TextLabel` | 普通标签文字 |
| `TextValue` | 数值文字 |
| `TextCaption` | 说明文字 |

---

## 六、drawable 资源

| 名字 | 用途 |
|---|---|
| `bg_card` | 卡片背景 |
| `bg_input` | 输入框背景 |
| `bg_banner` | 告警横幅背景 |
| `dot_online` | 状态点：在线（绿） |
| `dot_offline` | 状态点：离线（灰） |
| `dot_warn` | 状态点：警告（黄） |
| `ic_nav_dash` / `ic_nav_ble` / `ic_nav_pid` / `ic_nav_rule` / `ic_nav_log` | 底部导航图标 |
| `ic_launcher` / `ic_launcher_round` | 应用图标 |

---

## 七、主题（`GaugeTheme`）字段

设计文件里的 `theme` 引用的是**主题 id**，主题本身定义这些：

| 字段 | 说明 |
|---|---|
| `id` / `title` / `description` | 标识与显示名 |
| `background` | 仪表盘背景 |
| `surface` / `surfaceEdge` | 卡片底色 / 描边 |
| `accent` / `accentHot` / `accentDim` | **强调色三档。辉光由它派生，不写死 RGB** |
| `track` | 底轨 |
| `tick` | 未点亮刻度 |
| `needle` / `value` / `label` / `dim` | 指针 / 读数 / 标签 / 弱化 |
| `glow` | 是否开辉光（**已被 `neon` 取代**） |
| `cardRadiusDp` / `cardStrokeDp` / `cardAlpha` | 卡片圆角 / 描边 / 透明度 |
| `strokeDp` | 弧线粗细基准 |
| `needleLengthRatio` | 指针长度（相对半径） |
| `defaultRingStyle` / `defaultRingSegments` | 指针环默认值 |
| `neon` | **霓虹样式**（`NeonStyle`）—— 单块表可用 `GaugeItem.neonPreset` 覆盖 |
| `custom` | 是否用户自建 |

**内置主题**：`neon`（霓虹赛道）· `ice`（冰川科技）· `amber`（经典琥珀）

---

## 八、霓虹档位（`NeonStyle.PRESETS`）

| 档位名 | layers | spreadRatio | intensity | textGlow |
|---|---|---|---|---|
| `关闭` | — | — | — | — |
| `克制` | 2 | 0.022 | 0.7 | false |
| `标准` | 0（自适应） | 0.035 | 1.0 | true |
| `强烈` | 8 | 0.055 | 1.25 | true |
| `夸张` | 11 | 0.075 | 1.5 | true |

`layers = 0` 表示**按控件尺寸自适应**（3/5/7/9 层）。硬上限 12 层。

---

## 九、改 UI 时的注意事项

1. **新增一种仪表** → 只需继承 `BaseGaugeView` 实现 `drawGauge(canvas)`，
   再去 `GaugeViewFactory` 加一行映射。**不要碰数据层**（红线 4.1.5）。
2. **不要覆写 `onDraw`** —— 它是 `final` 的，统一包了绘制计时。覆写会编译失败。
3. **不要在 `onDraw` 里 new 对象** —— Paint / RectF / Path 全部复用，
   60fps 下每次分配都会给 GC 压力，表现是周期性掉帧。
4. **颜色必须从主题派生**，不要写死 RGB —— 否则换主题会串色
   （历史上霓虹橙 `(255,116,0)` 被硬编码过，加第二个发光主题时立刻暴露）。
5. **动画不要各自 `postDelayed`** —— 用 `GaugeTicker`，
   否则每帧 N 次消息投递且和 vsync 错拍。
6. **文字格式化要缓存** —— 文本只随 `value` 变（5Hz），不随缓动变（60fps）。
