# UI 样式与排版总表

> **这份文档是给"照着改"用的。** 每一行都写清：控件是什么 → 它多大 / 多少边距 / 字号多少 / 什么颜色 → **在哪个文件的第几行**。
> 基准版本：**v1.20.20**（`versionCode 89`，HEAD `8e6eb45`）。⚠️ 上一版基准是 v1.20.13（`e54e38e`）；
> v1.20.14~v1.20.20 只动了**控件检视器 / 日志页 / CAN 探测预设 / 文案**，**没有改布局 XML 的尺寸与颜色** ——
> 所以本表的行号与数值仍然成立，但**改动日志页 / 探测页文案时不受本表覆盖**（那些字在纯函数里，见下）。
>
> ⚠️ **本表只管"看得见的排版数值"**，不管**界面上的字该怎么说**。文案的权威在代码里的纯函数
> （`data/LogViewText.kt` / `data/CanFilterPresets.kt` / `data/UiInspectorInfo.kt`），
> 改文案请改那里 + 对应单测，**不要改本表**。
>
> 配套（**不重复、只指向**）：
> - [UI控件清单.md](UI控件清单.md) —— **控件 id 与用途的权威清单**（本表不再抄一遍 id 列表）
> - [UI设计指南.md](UI设计指南.md) —— 设计文件（`icar.ui/1` 与 `icar.ui/2`）格式
> - [主题格式参考.md](主题格式参考.md) · [主题设计大纲.md](主题设计大纲.md) —— 主题 JSON / 设计包
> - [ARCHITECTURE.md](ARCHITECTURE.md) —— 分层红线

---

## 怎么用这份文档（三步）

1. **找页面** → 从下面「目录」跳到那一页。页面标题后面括号里就是布局文件。
2. **找控件** → 在那一页的表格里按 **缩进** 找到它（缩进 = 谁套着谁）。id 对不上时去 [UI控件清单.md](UI控件清单.md) 核。
3. **按「在哪儿改」跳过去** → 那一列是 `文件:行`，直接跳。改完记得看 [§6 「怎么改」工作流](#六怎么改工作流) 里的"改完要做什么"。

**三条读之前必须知道的事：**

| # | 事 | 说明 |
|---|---|---|
| 1 | **单位要分清** | `dp` = 布局尺寸（`layout_width` / `margin` / `padding`）；`sp` = 文字（`textSize`）；**`px` = 代码里按密度算出来的**（本表里凡是 px 都标了"实测/代码算"）。XML 里写 `12dp`，代码里写 `dp(12)` —— 同一个数，但改的位置完全不同。 |
| 2 | **只有主框架有横竖屏两份布局** | `res/layout/activity_main.xml`（竖屏）与 `res/layout-land/activity_main.xml`（横屏）。**其余 24 个布局文件只有一份**，横竖屏靠 `MaxWidth*` 限宽 + `ColumnFlowLayout` 自动分栏适配。 |
| 3 | **这是"当前状态"的快照** | 快照日期 **2026-10-11（v1.20.20）**。⚠️ **上一版这里曾写"另一个 agent 正在给 App 加「实时调参」能力（`data/UiScale.kt`，规划 v1.20.14）"** —— 那个方向**已被用户明确否掉，代码整套撤掉了**（`data/UiScale.kt` 与 `ui/view/UiScaleApplier.kt` 现在**都不存在**，见 [FILE_MAP.md](FILE_MAP.md) 文件头与 [下一步-控件检视器.md](下一步-控件检视器.md) §1）。**字号 / 间距 / 导航栏宽度三类仍然是"必须改代码"**，本表 §7.2 的写法不变。 |

---

## 目录

- [§1 全局：主题、公共样式、颜色](#一全局主题公共样式颜色)
- [§2 主框架 activity_main（竖屏 / 横屏两份）](#二主框架-activity_main竖屏--横屏两份)
- [§3 六个导航页](#三六个导航页)
  - [3.1 仪表盘页](#31-仪表盘页fragment_dashxml--fragment_dash_canvasxml)
  - [3.2 画布设置页](#32-画布设置页fragment_canvas_settingsxml--item_canvasxml)
  - [3.3 连接页](#33-连接页fragment_connectxml)
  - [3.4 PID 页](#34-pid-页fragment_pidxml--item_pidxml--item_pid_headerxml)
  - [3.5 规则页](#35-规则页fragment_rulexml--item_rulexml)
  - [3.6 日志页](#36-日志页fragment_logxml--item_logxml)
  - [3.7 知识库页](#37-知识库页fragment_knowledgexml)
- [§4 各编辑器 / 工具 Activity](#四各编辑器--工具-activity)
- [§5 对话框与浮层](#五对话框与浮层)
- [§6 「怎么改」工作流](#六怎么改工作流)
- [§7 哪些样式已经是可配置的](#七哪些样式已经是可配置的)
- [§8 拿不准 / 需要现场量的地方](#八拿不准--需要现场量的地方)

---

## 一、全局：主题、公共样式、颜色

### 1.1 应用主题

`app/src/main/res/values/themes.xml:3-13`，`AndroidManifest.xml` 的 `<application android:theme>` 引用它，所有 Activity 默认继承。

| 项 | 值 | 说明 |
|---|---|---|
| parent | `Theme.Material3.Dark.NoActionBar` | 深色、无 ActionBar |
| `colorPrimary` | `@color/accent` | `#FF00D8FF` |
| `colorOnPrimary` | `@color/bg` | |
| `colorSecondary` | `@color/accent2` | `#FF7C5CFF` |
| `android:colorBackground` / `windowBackground` | `@color/bg` | 改这个 = 改全局底色 |
| `android:statusBarColor` | `@color/bg` | |
| `android:navigationBarColor` | `@color/bg_surface` | |
| `android:textColorPrimary` / `Secondary` | `text_primary` / `text_secondary` | |

### 1.2 公共 style（`values/themes.xml`）

**这些是"改一处、很多页跟着变"的杠杆** —— 想批量调字号/内边距就改这里，不要一个个页面去改。

| style | 行 | 字号 | 颜色 | 内边距 / 其它 | 谁在用 |
|---|---|---|---|---|---|
| `FieldLabel` | 36-41 | **12sp** | `text_secondary` | `paddingTop 8dp` / `paddingBottom 4dp` | PID 编辑器、规则编辑器、扫描器、表属性对话框的**所有字段标签** |
| `InputEdit` | 43-55 | **14sp** | 文字 `text_primary` / hint `text_dim` | `paddingStart/End 10dp`、`Top/Bottom 8dp`；`minHeight 42dp`；`maxLines 1`；背景 `@drawable/bg_input` | PID 编辑器的名称/单位/分组/备注，规则编辑器的名称 |
| `InputEditMono` | 57-59 | 继承 `InputEdit` | 同 | 同上 + `fontFamily monospace` | 所有十六进制/公式/数值输入框 |
| `SectionTitle` | 61-67 | **13sp bold** | `accent` | `paddingTop 14dp` / `Bottom 2dp` | 「基本信息」「扫描范围」「测试」等分区标题 |
| `MonoBox` | 69-75 | **12sp** | `text_primary` | `padding 10dp`；`monospace`；背景 `@drawable/bg_input` | PID 编辑器的 TX/RX/数据字节/解析结果，规则预览，扫描日志 |
| `CardStyle` | 15-17 | — | `bg_surface` | — | ⚠️ **定义了但当前无人引用**（卡片实际用 `@drawable/bg_card`） |
| `TextCaption` | 19-22 | 11sp | `text_secondary` | — | ⚠️ **定义了但当前无人引用** |
| `TextLabel` | 24-27 | 13sp | `text_secondary` | — | ⚠️ **定义了但当前无人引用** |
| `TextValue` | 29-33 | 18sp bold | `text_primary` | — | ⚠️ **定义了但当前无人引用** |

> ⚠️ **改了 `FieldLabel` 的 `paddingTop` 会让所有编辑器的纵向节奏一起变**（每个字段标签都高 8dp）。这是"一键统一"也是"一键炸一片"。

### 1.3 公共 drawable（`res/drawable/`）

| 文件 | 形状 | 关键值 | 用在哪 |
|---|---|---|---|
| `bg_card.xml` | rectangle | `corners 12dp`；`solid @color/bg_surface`；`stroke 1dp @color/divider` | 连接页 5 张卡、画布设置页 3 张卡、`item_pid` / `item_rule` / `item_scan_hit` |
| `bg_input.xml` | rectangle | `corners 8dp`；`solid @color/bg_elevated`（**无描边**） | 所有输入框/下拉框、`item_canvas` / `item_device` / `row_condition` / `row_action` 的行底、`MonoBox` |
| `bg_banner.xml` | rectangle | `corners 10dp`；`solid #33FFB020`（半透明琥珀）；`stroke 1dp @color/warn` | 仪表盘告警横幅 `alertBanner`、扫描器顶部警告 `tvWarning` |
| `dot_offline.xml` | oval | 10dp×10dp；`solid @color/text_dim` | `connDot` / `simDot` 未连接态 |
| `dot_online.xml` | oval | 10dp×10dp；`solid @color/ok` | 已连接 / 模拟运行中 |
| `dot_warn.xml` | oval | 10dp×10dp；`solid @color/warn` | 扫描中 |
| `ic_nav_*.xml` | vector | **24dp × 24dp**，`fillColor #FFFFFF`（由 `nav_item_color` 着色） | 导航栏 6 个图标 |

> ⚠️ **`bg_card` / `bg_input` 是全局共用的**。把 `bg_card` 的 `corners` 从 12dp 改成 20dp，会同时改掉连接页、画布设置页、PID 行、规则行 —— 想只改一处就得新建一个 drawable。

### 1.4 颜色总表（`res/values/colors.xml`）

**这是 UI 配色的唯一权威**（下面 1.5 那 12 个是仪表盘的，别混）。

| 名字 | 色值 | 行 | 用在哪 |
|---|---|---|---|
| `bg` | `#FF0A0D12` | 4 | 全局背景：`activity_main` 根、所有 Fragment 根、`Theme.ICarOBD` 的 `windowBackground` |
| `bg_surface` | `#FF141A23` | 5 | 卡片底（`bg_card` 的 solid）、导航栏底、编辑器底部按钮条 |
| `bg_surface2` | `#FF1C2430` | 6 | 模拟页**展开态**通道行底（`SimulatorActivity.kt:246`） |
| `bg_elevated` | `#FF212B39` | 7 | 输入框底（`bg_input` 的 solid）、模拟页未选中 chip 底（`SimulatorActivity.kt:364`） |
| `divider` | `#FF2A3547` | 8 | `navDivider` 分隔线、`bg_card` 描边 |
| `text_primary` | `#FFE8EEF7` | 10 | 主文字（标题、读数、开关标签、输入框文字） |
| `text_secondary` | `#FF9AA8BC` | 11 | 次级文字（分区标题、字段标签、副标题、日志正文） |
| `text_dim` | `#FF5F6E85` | 12 | 说明小字（hint、提示行、`tvPidHint` / `tvRuleHint` / `tvLogStats`）、`dot_offline` |
| `accent` | `#FF00D8FF` | 15 | `SectionTitle`、`item_pid_header` 的分组标题、导航选中态、编辑态选中框与手柄（`DashCanvasEditorView`）、模拟页选中 chip |
| `accent2` | `#FF7C5CFF` | 16 | `colorSecondary`（Material 组件派生色） |
| `accent_dim` | `#6600D8FF` | 17 | ⚠️ **当前无引用** |
| `ok` | `#FF2FD47A` | 20 | `dot_online` |
| `warn` | `#FFFFB020` | 21 | `dot_warn`、`bg_banner` 描边、扫描器"我已确认…"开关文字（`activity_scanner.xml:267`）、模拟页"噪声"chip 色 |
| `danger` | `#FFFF4D4F` | 22 | 所有"删"按钮文字、删除类按钮文字 |
| `info` | `#FF4DA3FF` | 23 | 模拟页"周期"chip 色（`SimulatorActivity.kt:312`） |
| `gauge_track` | `#FF263143` | 26 | 模拟页分隔线（`activity_simulator.xml:133`）、模拟页波形缩略图底色、模拟页滑块轨道 |
| `gauge_tick` | `#FF4A5A73` | 27 | 仪表刻度**兜底色**（`BaseGaugeView.kt:205`，绑定主题后被覆盖） |
| `gauge_needle` | `#FFFF4D4F` | 28 | 指针兜底色（`BaseGaugeView.kt:206`） |
| `gauge_value` | `#FFFFFFFF` | 29 | 读数兜底色（`BaseGaugeView.kt:207`） |
| `gauge_label` | `#FF8FA0B8` | 30 | 名称兜底色（`BaseGaugeView.kt:208`） |
| `scan_hit` | `#FF2FD47A` | 33 | `item_scan_hit` 的 `tvTitle`（命中标题） |
| `scan_miss` | `#FF3A465C` | 34 | ⚠️ **当前无引用** |

> ⚠️ **`gauge_*` 那 5 个色只是仪表 View 的兜底值**（在 `bind(theme)` 之前用）。仪表真正显示的颜色来自 `GaugeTheme`（见 1.5）—— 改 `colors.xml` 里的 `gauge_needle` **不会**改变仪表盘上的指针颜色。

### 1.5 `GaugeTheme` 的 12 个主题色 + 几何参数（**仪表盘专用，别和 1.4 混**）

`app/src/main/java/com/icar/obd/ui/view/GaugeTheme.kt`

主题**只影响渲染颜色与几何参数，不影响 PID / 量程 / 采集频率**（类注释 :10-11）。
内置三套是**只读默认值**（:231-253）；用户自建的存在 `Store.customThemeJson` 里，`all()` 会把两边合起来看。

**12 个颜色字段**（`data class` 参数顺序，:35-46）：

| 字段 | 作用 | 霓虹赛道 `NEON`(id 0) | 冰川科技 `ICE`(id 1) | 经典琥珀 `CLASSIC`(id 2) |
|---|---|---|---|---|
| `background` | 卡片渐变**终点**（卡片底 = surface→background 的 TL_BR 渐变） | `#080A0E` | `#071018` | `#0B0B09` |
| `surface` | 卡片渐变**起点** / 卡片主体 | `#17110D` | `#0C1B28` | `#181714` |
| `surfaceEdge` | 卡片**描边** | `#553520` | `#1B4C62` | `#4A4530` |
| `accent` | 主强调色（量程弧、进度条、选中框） | `#FF8A00` | `#28D7FF` | `#E3A83B` |
| `accentHot` | 高亮/危险段 | `#FFE45C` | `#B8F5FF` | `#FFD57A` |
| `accentDim` | 暗调强调（次级弧、底纹） | `#5B2B00` | `#123D52` | `#4C3612` |
| `track` | 未填充轨道 | `#322820` | `#173343` | `#302D23` |
| `tick` | 刻度线 | `#725635` | `#4C8195` | `#766B4D` |
| `needle` | 指针 | `#FFB000` | `#63E5FF` | `#E8B84F` |
| `value` | 大号读数 | `#FFF4DF` | `#E7FAFF` | `#FFF6DB` |
| `label` | 名称 / 单位 | `#D8BFA0` | `#9DC7D6` | `#D5C8A3` |
| `dim` | 最弱的说明文字 | `#806B57` | `#5E8493` | `#847B61` |
| `glow`（不是颜色，是开关） | 霓虹辉光 | `true` | `false` | `false` |

**几何与动画参数**（`data class` 默认值，:50-96）：

| 字段 | 默认值 | 单位 | 作用 / 坑 |
|---|---|---|---|
| `cardRadiusDp` | `18f` | dp | 卡片圆角 |
| `cardStrokeDp` | `1f` | dp | 卡片描边宽度。**0 = 无边框**；`<0.5px` 的描边画出来是虚的，代码里会夹到至少 1px（:110） |
| `cardAlpha` | `255` | 0..255 | 卡片不透明度。**0 = 完全透明**（只剩仪表本体，适合叠背景图） |
| `strokeDp` | `9f` | dp | 圆表量程弧 / 条形表主条粗细 |
| `needleLengthRatio` | `0.62f` | 比例 | 圆表指针长度占半径比例（0.2~1.0） |
| `defaultRingStyle` | `0` | 枚举 | 默认指针环样式（`GaugeItem.RING_NONE=0` / `RING_TICK=1`） |
| `defaultRingSegments` | `40` | 段 | 默认指针环段数 |
| `easingMode` | `Easing.MODE_STANDARD` | 枚举 | 数值缓动曲线 |
| `easingTauMs` | `120f` | ms | **越小越快**。⚠️ 数据是 5Hz 推的（200ms 一次），**τ ≤ 45ms 会让指针"一格一格跳"**（:81-83） |
| `valueSmoothingMs` | `90f` | ms | 输入滤波。**0 = 不滤波** |

**在哪儿改**：App 内 → 画布设置页「画布主题」→ 主题编辑器（`activity_theme_editor.xml` + `ThemeEditorActivity.kt`）。
改**内置三套**的颜色只能改 `GaugeTheme.kt:231-253`（源码里的十六进制字面量）。

---

## 二、主框架 activity_main（竖屏 / 横屏两份）

**这是唯一有横竖屏两份布局的文件。** 两份保持**相同 id**（`rootLayout` / `pageContainer` / `navDivider` / `navView`），`MainActivity` 用 `NavigationBarView` 基类接收两者，所以代码里没有任何 `if (横屏)` 分支。

### 2.1 竖屏 —— `res/layout/activity_main.xml`

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 其它 | 背景 | 行 |
|---|---|---|---|---|---|---|
| | `rootLayout` | `FrameLayout` | `match_parent` × `match_parent` | — | `@color/bg` | 29-34 |
| ├ | `pageContainer` | `FrameLayout` | `match_parent` × `match_parent` | **永远整屏**（不被导航栏挤） | — | 37-40 |
| ├ | `navDivider` | `View` | `match_parent` × **`1dp`** | `layout_gravity=bottom`；**`layout_marginBottom=80dp`** | `@color/divider` | 43-49 |
| └ | `navView` | `NavBottomBar`（`BottomNavigationView` 子类） | `match_parent` × `wrap_content` | `layout_gravity=bottom`；`elevation 8dp`；`labelVisibilityMode=labeled` | `@color/bg_surface` | 56-67 |

导航栏属性：`app:itemActiveIndicatorStyle=@style/Widget.Material3.BottomNavigationView.ActiveIndicator`、`app:itemIconTint` / `app:itemTextColor` = `@color/nav_item_color`、`app:menu=@menu/bottom_nav`。

### 2.2 横屏 —— `res/layout-land/activity_main.xml`

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 其它 | 背景 | 行 |
|---|---|---|---|---|---|---|
| | `rootLayout` | `FrameLayout` | `match_parent` × `match_parent` | — | `@color/bg` | 21-26 |
| ├ | `pageContainer` | `FrameLayout` | `match_parent` × `match_parent` | 永远整屏 | — | 29-32 |
| ├ | `navDivider` | `View` | **`1dp`** × `match_parent` | `layout_gravity=start`；**`layout_marginStart=88dp`** | `@color/divider` | 39-45 |
| └ | `navView` | `NavigationRailView` | `wrap_content` × `match_parent` | `layout_gravity=start`；`elevation 8dp`；**`android:minWidth=88dp`**；`app:menuGravity=center`；`labelVisibilityMode=labeled` | `@color/bg_surface` | 48-61 |

### 2.3 导航项与配色

`res/menu/bottom_nav.xml` —— **6 项，顺序即导航顺序**：

| 顺序 | id | 图标 | 标题（`strings.xml`） |
|---|---|---|---|
| 1 | `nav_dashboard` | `ic_nav_dash` | 仪表盘 |
| 2 | `nav_connect` | `ic_nav_ble` | 连接 |
| 3 | `nav_pid` | `ic_nav_pid` | PID |
| 4 | `nav_rule` | `ic_nav_rule` | 规则 |
| 5 | `nav_log` | `ic_nav_log` | 日志 |
| 6 | `nav_knowledge` | `ic_nav_book` | 知识库 |

`res/color/nav_item_color.xml`：`state_checked=true` → `@color/accent`；否则 `@color/text_dim`。

### 2.4 ⚠️ 改主框架会出的事（都踩过）

| 改动 | 会出什么事 | 依据 |
|---|---|---|
| 把根容器从 `FrameLayout` 换回 `LinearLayout` | 导航栏会**把画布挤掉**；仪表盘页收起/展开导航栏时 `pageContainer` 重新量一次 → **画布尺寸变化 → 表盘重排 + 闪一下** | `activity_main.xml:5-9`、`layout-land/activity_main.xml:5-14` |
| `navView` 用 `GONE` 隐藏 | `pageContainer` 会重排。代码里用的是 `translationX/translationY` + `alpha`（**平移不改变任何布局**） | `MainActivity.kt:431-461` |
| 漏了 `navDivider` 的同步隐藏 | 屏幕最左会留一条 `divider` 色的细条（v1.20.3 实测截图 `x=0/1` 仍是 `RGB(42,53,71)`） | `layout-land/activity_main.xml:34-38`、`MainActivity.kt:435-437` |
| 往 `menu/bottom_nav.xml` 加**第 7 项** | `BottomNavigationView` 的菜单项**硬上限是 5**，`NavBottomBar` 重写成了 6。第 7 项会在**构造函数里**抛 `IllegalArgumentException` → **手机一启动就崩** | `NavBottomBar.kt:7-46` |
| 只改 `minWidth=88dp` 而忘了 `navDivider` 的 `marginStart=88dp` | 分隔线与导航栏之间会留缝 / 压住导航栏（**这两个数在代码里没有绑在一起，靠人工一致**） | `layout-land/activity_main.xml:44` vs `:55` |

**导航栏收起/展开的运行时行为**（`MainActivity.kt`）：只在**仪表盘页**自动收起，只留左边缘一条把手；展开后 **8000ms** 自动收回（`scheduleRailHide`，:417-422）；动画 **160ms**（:444 / :453）。

---

## 三、六个导航页

> 六个页面的容器都是 `activity_main.xml` 的 `pageContainer`（`FrameLayout`，整屏）。`MainActivity` 用 **`show`/`hide`** 切换（**不是 `replace`**），所以切页不重建 View。

### 3.1 仪表盘页（`fragment_dash.xml` + `fragment_dash_canvas.xml`）

#### 3.1.1 宿主页 —— `res/layout/fragment_dash.xml`

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 其它 | 颜色 / 背景 | 行 |
|---|---|---|---|---|---|---|
| | （根） | `LinearLayout` vertical | `match_parent` × `match_parent` | — | `@color/bg` | 21-25 |
| ├ | `alertBanner` | `TextView` | `match_parent` × `wrap_content` | `marginStart 12dp` / `marginTop 6dp` / `marginEnd 12dp`；`padding 8dp`；`textSize 13sp`；**默认 `visibility=gone`** | 文字 `text_primary`；背景 `@drawable/bg_banner` | 28-39 |
| └ | `dashPager` | `ViewPager2` | `match_parent` × **`0dp` + `layout_weight=1`** | — | — | 47-51 |

- `alertBanner` 是**跨画布**的（规则触发与哪一套画布无关），所以放在 pager **之外** —— 翻页不会重建它、也不会跟着平移（:16-19）。
- `dashPager` 用 `weight=1` 而**不是固定高度**：告警条出现时 pager 自己让位，不用手算高度（:44-45）。
- `pager.offscreenPageLimit = 1`（`DashFragment.kt:85`）—— 只多留一页。

> 🔴 **`alertBanner` 从 `gone` 变 `visible` 会让 pager 变矮 → `gaugeGrid` 尺寸变化 → 表盘重排。**
> 这正是 v1.20.12 那个 P0「规则 toast 一弹画布全消失」的**触发条件**（v1.20.12 已在 `DashRenderer.relayout()` 里 `post` 到下一轮消息修掉）。
> 现在规则提示**不再走这条横幅**，改由灵动岛出 —— 但 `alertBanner` 还在，改它的边距/字号仍然会牵动 pager。

#### 3.1.2 一套画布 —— `res/layout/fragment_dash_canvas.xml`

根是 `canvasRoot`（`LinearLayout` vertical，`match_parent` × `match_parent`，`@color/bg`，:26-32）。同一个布局承担**浏览**与**编辑**两种状态。

**A. 编辑工具条 `editBar`（默认 `gone`，:35-40）**

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 内边距 | 字号 | 行 |
|---|---|---|---|---|---|---|
| `editBar` | | `LinearLayout` vertical | `match_parent` × `wrap_content` | — | | 35-40 |
| ├ 第 1 行 | | `LinearLayout` horizontal | `match_parent` × `wrap_content` | `paddingStart 6dp` / `Top 6dp` / `End 6dp` | | 42-48 |
| │ ├ `btnAdd` | `MaterialButton`（实心） | `0dp` × **`40dp`**，`weight=1` | `insetTop/Bottom 0dp`；`minWidth 0dp`；`paddingStart/End 4dp` | **12sp** | 50-61 |
| │ ├ `btnEditGauge` | `MaterialButton`（Outlined） | 同上 | 同上 + `marginStart 4dp` | 12sp | 63-76 |
| │ ├ `btnDeleteGauge` | 同上 | 同上 | 同上 | 12sp | 78-91 |
| │ └ `btnFrontGauge` | 同上 | 同上 | 同上 | 12sp | 93-106 |
| ├ 第 2 行 | | `LinearLayout` horizontal | `match_parent` × `wrap_content` | `paddingStart 6dp` / `Top 4dp` / `End 6dp` | | 109-115 |
| │ ├ `btnPreset` | Outlined | `0dp` × `40dp`，`weight=1` | `paddingStart/End 4dp` | 12sp | 117-129 |
| │ ├ `btnGrid` | Outlined | 同上 | + `marginStart 4dp` | 12sp | 131-144 |
| │ ├ `btnSnap` | Outlined | 同上 | 同上 | 12sp | 146-159 |
| │ └ `btnDone` | 实心 | 同上 | 同上 | 12sp | 161-173 |
| └ `tvEditorHint` | `TextView` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 6dp` / `End 12dp` / `Bottom 4dp` | **11sp**，`text_dim` | 176-186 |

**B. 画布区 `canvasArea`（:195-199）** —— `match_parent` × **`0dp` + `weight=1`**

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 其它 | 颜色 | 行 |
|---|---|---|---|---|---|---|
| `canvasArea` | | `FrameLayout` | `match_parent` × `0dp` weight=1 | — | 背景由代码画（主题纯色 / 背景图） | 195-199 |
| ├ `gaugeGrid` | | `FrameLayout` | `match_parent` × `match_parent` | 仪表 View 由 `DashRenderer` 塞进来 | — | 201-204 |
| ├ `lvglDash` | `LvglDashView` | | `match_parent` × `match_parent` | **默认 `gone`**（`dashEngine` 强制为 0） | — | 210-214 |
| ├ `tvDashEmpty` | `TextView` | | `match_parent` × `wrap_content` | `layout_gravity=center`；`gravity=center`；`padding 24dp`；**默认 `gone`** | `text_dim`，**14sp** | 216-226 |
| ├ `editorCanvas` | `DashCanvasEditorView` | | `match_parent` × `match_parent` | **默认 `gone`** | — | 229-233 |
| └ `tvCanvasName` | `TextView` | | `wrap_content` × `wrap_content` | `layout_gravity=top\|start`；**`alpha 0.45`**；`paddingStart 12dp` / `Top 6dp` / `End 12dp` / `Bottom 6dp` | `text_primary`，**11sp** | 242-253 |

**画布名浮标的位置是运行时设的**（`DashCanvasPageFragment.applyNameLabel()`，:260-285）：

- `Store.settings.canvasNamePos` → `layout_gravity`：
  `0 左上`→`TOP|START`、`1 右上`→`TOP|END`、`2 左下`→`BOTTOM|START`、`3 右下`→`BOTTOM|END`、`4 隐藏`→`GONE`（常量在 `data/DashCanvas.kt:135-142`，中文名 `NAME_POS_NAMES`）。
- 边距用 **`setPadding(dp(12), dp(6), dp(12), dp(6))`** 覆盖 XML 的值 —— 用 `padding` 而不是 `margin`，因为 padding 在四个角上都等价于"离边多远"，一套值就够（:257-258）。
- **编辑态强制 `GONE`**（:262-265）。

**C. 画布上的表盘排版（代码算的，XML 里没有）** —— `ui/dash/DashRenderer.kt`

| 项 | 值 | 行 |
|---|---|---|
| 卡片间距 | **`CELL_MARGIN_DP = 3f`**（dp，**左右各留一份**） | 471 |
| 卡片内边距 | `(density * 4).toInt()` px（= **4dp**） | 152-153 |
| 表盘位置/尺寸 | `item.x / 360f * 容器宽` 等 —— 归一化坐标 `0..360`（`GaugeItem.CANVAS = 360f`） | 171-176 |
| 推值周期 | **`REFRESH_MS = 200L`**（5Hz） | 469 |
| 空态文案（v1） | `"没有可显示的通道\n请先连接设备并在「PID」页启用通道"` | 476 |

**D. 编辑器的交互常量** —— `ui/view/DashCanvasEditorView.kt`

| 项 | 值 | 行 |
|---|---|---|
| 吸附网格 | `GRID = DashLayout.Drag.GRID = 24`（画布分 24 份，1 格 = 360/24 = **15 画布单位 ≈ 4.17%**） | 39 / `DashLayout.kt:202` |
| 最小尺寸 | `MIN_SIZE = 2 * STEP` = **30 画布单位**（≈8.3%） | `DashLayout.kt:208` |
| 缩放手柄 | `HANDLE_DP = 26f`（dp，**视觉方块 = 热区**，热区没有再放大） | 40 |
| 选中框描边 | `dp(2f)`，色 = `theme.accent` | 262-264 |
| 尺寸提示文字 | `dp(11f)`，色 = `theme.value`，位置在选中框上边 `dp(6f)` 处 | 270-275 |
| 参考线颜色 | `theme.tick` 的 RGB + alpha `70`（≈27%） | 244 |

**E. 参考线覆盖层** —— `ui/view/DashGridOverlayView.kt`

| 项 | 默认值 | 行 |
|---|---|---|
| `linesEnabled` | `false`（由 `Store.settings.gridEnabled` 灌） | 36 |
| `cols` / `rows` | `6` / `4`（`Store.settings.gridCols` / `gridRows`） | 39 / 42 |
| `style` | `STYLE_DASH=1`（虚线） | 45 |
| `color` | `0x33FFFFFF`（由主题派生） | 48 |
| `strokeDp` | `1f` | 51 |
| 密度上限 | `MAX_DIVISIONS = 24`（再多就成实心色块） | 32 |
| 虚线节奏 | 实线 6dp / 空 6dp；点线 1.5dp / 空 5dp | 67-68 |

> 🔴 **`canvasArea` / `gaugeGrid` 的尺寸就是"画布尺寸"。任何让它变小的事 → `DashRenderer` 的 `addOnLayoutChangeListener` 触发 `relayout()` → 所有表盘按归一化坐标重算 → 表盘重建 + 位置变化。**
> 为什么编辑工具条要放在 `canvasArea` **外面**：编辑态它占掉高度，画布就得让位（`DashCanvasEditorView` 是叠在 `gaugeGrid` 上的**同级 FrameLayout 子 View**，不是插进布局里的）。
> 同理，背景画在 `canvasArea` 这一层而**不是页面根** —— 画在根上的话背景定位换算会与实际画布尺寸对不上（:190-194）。

#### 3.1.3 画布列表行 —— `res/layout/item_canvas.xml`

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 内边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|---|---|
| | （根） | `LinearLayout` horizontal，`gravity=center_vertical` | `match_parent` × `wrap_content` | `paddingStart 10dp` / `Top 6dp` / `End 6dp` / `Bottom 6dp` | 背景 `@drawable/bg_input` | 9-18 |
| ├ | （文字列） | `LinearLayout` vertical | `0dp` × `wrap_content`，`weight=1` | — | | 20-24 |
| │ ├ `tvName` | `TextView` | `match_parent` × `wrap_content` | `ellipsize=end`，`maxLines=1` | **14sp**，`text_primary` | 26-33 |
| │ └ `tvSub` | `TextView` | `match_parent` × `wrap_content` | `marginTop 2dp`，`ellipsize=end`，`maxLines=1` | **11sp**，`text_dim` | 35-43 |
| └ `btnRowMenu` | `MaterialButton`（TextButton） | `wrap_content` × **`36dp`** | `marginStart 4dp`；`minWidth 0dp`；`paddingStart/End 10dp` | **12sp**，"操作" | 46-56 |

> 刻意只留**一个**「操作」按钮而不是四个小按钮：一行里塞四个，在 720dp 限宽下每个只剩 ~40dp，中文两个字都放不下（:5-7）。

---

### 3.2 画布设置页（`fragment_canvas_settings.xml` + `item_canvas.xml`）

`res/layout/fragment_canvas_settings.xml` —— ViewPager2 的**最后一页**。

| 层级 | 控件 | 类型 | 尺寸 | 边距 / 内边距 | 背景 / 颜色 | 行 |
|---|---|---|---|---|---|---|
| | （根） | `FrameLayout` | `match_parent` × `match_parent` | — | `@color/bg` | 21-25 |
| └ | （限宽滚动容器） | `MaxWidthNestedScrollView` | `match_parent` × `match_parent` | `layout_gravity=center_horizontal`；`fillViewport=true`；**`app:maxWidthDp=720dp`** | `@color/bg` | 27-33 |
| ⠀└ | （内容） | `LinearLayout` vertical | `match_parent` × `wrap_content` | **`padding 10dp`** | | 35-39 |

**卡 1：画布列表（:42-47，`bg_card` + `padding 12dp`）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "画布（横滑切换）" | `wrap_content` | — | 13sp，`text_secondary` | 49-54 |
| `tvCanvasCount` | `match_parent` × `wrap_content` | `marginTop 4dp` | 11sp，`text_dim` | 56-62 |
| `llCanvasList` | `match_parent` × `wrap_content` | `marginTop 6dp` | 行由代码生成（`item_canvas.xml`） | 65-70 |
| `btnAddCanvas` | `match_parent` × **`40dp`** | `marginTop 6dp`；`insetTop/Bottom 0dp` | 13sp，"＋ 新增画布" | 72-80 |
| （导入/导出行） | `LinearLayout` horizontal | `match_parent` × `wrap_content`，`marginTop 6dp` | | 87-91 |
| ├ `btnImportCanvas`（Outlined） | `0dp` × `40dp`，`weight=1` | `insetTop/Bottom 0dp`；`minWidth 0dp`；`paddingStart/End 4dp` | 13sp | 93-105 |
| └ `btnExportCanvas`（Outlined） | 同上 | 同上 + `marginStart 6dp` | 13sp | 107-120 |
| `tvLastImport` | `match_parent` × `wrap_content` | `marginTop 6dp` | 11sp，`text_dim` | 130-136 |

**卡 2：当前画布（:140-146，`bg_card` + `padding 12dp` + `marginTop 10dp`）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "当前画布" | `wrap_content` | — | 13sp，`text_secondary` | 148-153 |
| `tvCurrentCanvas` | `match_parent` × `wrap_content` | `marginTop 4dp` | 11sp，`text_dim` | 155-161 |
| `btnCanvasTheme`（Outlined） | `match_parent` × **`40dp`** | `marginTop 8dp`；`insetTop/Bottom 0dp` | 13sp | 163-172 |
| `btnCanvasLook`（Outlined） | `match_parent` × `40dp` | `marginTop 6dp`；`insetTop/Bottom 0dp` | 13sp，"背景 / 设计文件 / 参考线…" | 174-183 |

**卡 3：全局（:187-193，`bg_card` + `padding 12dp` + `marginTop 10dp`）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "全局（与画布无关）" | `wrap_content` | — | 13sp，`text_secondary` | 195-200 |
| `btnPollInterval`（Outlined） | `match_parent` × `40dp` | `marginTop 8dp` | 13sp | 202-211 |
| `btnGestures`（Outlined） | `match_parent` × `40dp` | `marginTop 6dp` | 13sp，"手势" | 220-229 |
| `tvGestureSummary` | `match_parent` × `wrap_content` | `marginTop 4dp` | 11sp，`text_dim` | 231-237 |
| `swSound` | `match_parent` × `wrap_content` | `marginTop 10dp` | 13sp，`text_primary`，"音效（规则触发时的提示音）" | 239-246 |
| `btnNameLabel`（Outlined） | `match_parent` × `40dp` | `marginTop 6dp` | 13sp，"画布名浮标" | 248-257 |
| `btnIsland`（Outlined） | `match_parent` × `40dp` | `marginTop 6dp` | 13sp，"灵动岛" | 265-274 |
| `tvIslandSummary` | `match_parent` × `wrap_content` | `marginTop 4dp` | 11sp，`text_dim` | 276-282 |

**页脚提示**：`TextView`，`match_parent` × `wrap_content`，`marginTop 10dp`，`padding 4dp`，11sp，`text_dim`（:285-292）。

> 🔴 **为什么外面多套了一层 `FrameLayout`（:21）**：`MaxWidthNestedScrollView` 的限宽靠**父容器认 `layout_gravity` 来居中**，而这一页的父容器是 **ViewPager2** —— `FragmentStateAdapter.addViewToContainer()` 给页面根视图套的是 `FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT)`，**把 gravity 覆盖掉了**。
> 后果：限宽生效、居中失效，整页靠左（实测内容 `x=250..1770`，而页面是 `200..2560`）。所以这一页自己套一层 `FrameLayout` 来提供居中（`MaxWidthViews.kt:139-146`）。
> **任何放进 ViewPager2 的页面要用 `MaxWidth*` 居中，都必须这样套一层。**

---

### 3.3 连接页（`fragment_connect.xml`）

根 = `MaxWidthNestedScrollView`，`match_parent` × `match_parent`，`layout_gravity=center_horizontal`，`fillViewport=true`，**`app:maxWidthDp=720dp`**，背景 `@color/bg`（:2-9）。
内容容器 = `LinearLayout` vertical，`match_parent` × `wrap_content`，**`padding 10dp`**（:11-15）。

**卡 1：连接状态（:18-24，`bg_card`，`gravity=center_vertical`，horizontal，`padding 12dp`）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 / 背景 | 行 |
|---|---|---|---|---|
| `connDot` | **`10dp` × `10dp`** | — | `@drawable/dot_offline` | 26-30 |
| `tvConnState` | `0dp` × `wrap_content`，`weight=1` | `marginStart 8dp` | **15sp**，`text_primary`，"未连接" | 32-40 |
| `tvConnHz` | `wrap_content` | — | **12sp**，`text_dim`，"-- Hz" | 42-48 |

**卡 2：选择设备（:52-58，`bg_card` vertical `padding 12dp` `marginTop 10dp`）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "1. 选择设备" | `wrap_content` | — | 13sp，`text_secondary` | 60-65 |
| `spTransport` | `match_parent` × `wrap_content` | `marginTop 6dp`；`paddingStart/End 10dp`；背景 `bg_input` | — | 67-74 |
| `tvTransportHint` | `match_parent` × `wrap_content` | `marginTop 4dp` | 11sp，`text_dim` | 76-83 |
| （按钮行） | horizontal | `marginTop 8dp` | | 85-89 |
| ├ `btnScan` | `0dp` × `wrap_content`，`weight=1` | — | 13sp，"扫描设备" | 91-97 |
| └ `btnStopScan`（Outlined） | `0dp` × `wrap_content`，`weight=1` | `marginStart 8dp` | 13sp | 99-107 |
| `tvDeviceHint` | `match_parent` × `wrap_content` | `marginTop 6dp` | 11sp，`text_dim` | 110-117 |
| `rvDevices` | `match_parent` × `wrap_content` | `marginTop 6dp`；`nestedScrollingEnabled=false` | — | 119-124 |

**卡 3：协议与初始化（:128-134）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "2. 协议与初始化" | `wrap_content` | — | 13sp，`text_secondary` | 136-141 |
| `spProtocol` | `match_parent` × `wrap_content` | `marginTop 6dp`；`paddingStart/End 10dp`；`bg_input` | — | 143-150 |
| （按钮行） | horizontal | `marginTop 8dp` | | 152-156 |
| ├ `btnInit` | `0dp` × `wrap_content`，`weight=1` | — | 13sp | 158-164 |
| └ `btnDisconnect`（Outlined） | 同上 | `marginStart 8dp` | 13sp | 166-174 |
| `tvInitInfo` | `match_parent` × `wrap_content` | `marginTop 8dp`；**`monospace`** | 11sp，`text_secondary` | 177-185 |
| `tvInitSteps` | `match_parent` × `wrap_content` | `marginTop 6dp`；`monospace`；**`maxLines 8`** | **10sp**，`text_dim` | 187-195 |

**卡 4：总线健康度（:199-205）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "3. 总线健康度" | `wrap_content` | — | 13sp，`text_secondary` | 207-212 |
| `tvBusInfo` | `match_parent` × `wrap_content` | `marginTop 6dp`；`monospace` | 12sp，`text_primary` | 214-222 |

**卡 5：运行选项（:225-231）**

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `TextView` "运行选项" | `wrap_content` | — | 13sp，`text_secondary` | 233-238 |
| `swSound` | `match_parent` × `wrap_content` | `marginTop 4dp` | 13sp，`text_primary` | 240-247 |
| `swCsv` | 同上 | — | 13sp | 249-255 |
| `swMirror` | 同上 | — | 13sp | 257-263 |
| `swScreenOn` | 同上 | — | 13sp | 265-271 |
| `TextView` "油箱容量（L）…" | `match_parent` × `wrap_content` | `marginTop 10dp` | 12sp，`text_secondary` | 275-281 |
| `etTankCapacity` | `match_parent` × `wrap_content` | `marginTop 4dp`；`paddingStart/End 10dp`；`bg_input` | 13sp，`text_primary`，hint `50` | 283-294 |
| `TextView` "G 值来源" | `match_parent` × `wrap_content` | `marginTop 10dp` | 12sp，`text_secondary` | 296-302 |
| `spGForce` | `match_parent` × `wrap_content` | `marginTop 4dp`；`paddingStart/End 10dp`；`bg_input` | — | 304-311 |
| `TextView` 说明 | `match_parent` × `wrap_content` | `marginTop 4dp` | 11sp，`text_dim` | 313-319 |
| （按钮行） | horizontal | `match_parent` × `wrap_content`，`marginTop 10dp` | | 321-325 |
| ├ `btnSimulator`（Outlined） | `0dp` × `wrap_content`，`weight=1` | `insetTop/Bottom 0dp`；`minWidth 0dp`；`paddingStart/End 4dp` | 12sp | 327-339 |
| └ `btnBench`（Outlined） | 同上 | + `marginStart 4dp` | 12sp，"性能基准" | 342-355 |
| `btnDashEngine`（Outlined） | `match_parent` × `wrap_content` | `marginTop 6dp` | 12sp；**运行时置 `GONE`** | 358-365 |

> 📌 **与 [UI控件清单.md](UI控件清单.md) 的一处出入**：那份清单在「连接页」下写了 `btnCanSniffer`，但 `fragment_connect.xml` 里**没有这个 id** —— 连接页那一格的实际 id 是 **`btnBench`**（`ConnectFragment.kt:148`）。`btnCanSniffer` 在 **`fragment_pid.xml`**（PID 页）。以本表为准。

---

### 3.4 PID 页（`fragment_pid.xml` + `item_pid.xml` + `item_pid_header.xml`）

根 = `MaxWidthLinearLayout`，`match_parent` × `match_parent`，`layout_gravity=center_horizontal`，vertical，**`app:maxWidthDp=760dp`**，`@color/bg`（:7-14）。

| 层级 | 控件 | 尺寸 | 边距 / 其它 | 字号 | 行 |
|---|---|---|---|---|---|
| ├ 第 1 行 | `LinearLayout` horizontal | `match_parent` × `wrap_content` | `paddingStart 8dp` / `Top 8dp` / `End 8dp` | | 16-22 |
| │ ├ `btnAddPid` | `0dp` × **`40dp`**，`weight=1` | `insetTop/Bottom 0dp` | 12sp | 24-32 |
| │ ├ `btnScanner`（Outlined） | `0dp` × `40dp`，`weight=1` | `marginStart 6dp`；`insetTop/Bottom 0dp` | 12sp | 34-44 |
| │ ├ `btnCanSniffer`（Outlined） | `0dp` × `40dp`，`weight=1` | `marginStart 6dp` | **11sp** | 46-56 |
| │ └ `btnProbeLog`（Outlined） | `0dp` × `40dp`，`weight=1` | `marginStart 6dp` | 11sp | 62-72 |
| ├ 第 2 行 | `LinearLayout` horizontal | `match_parent` × `wrap_content` | `paddingStart 8dp` / `Top 4dp` / `End 8dp` | | 75-81 |
| │ ├ `btnImport`（TextButton） | `0dp` × **`36dp`**，`weight=1` | `insetTop/Bottom 0dp` | 11sp | 83-92 |
| │ ├ `btnExport`（TextButton） | 同上 | 同上 | 11sp | 94-103 |
| │ └ `btnDedup`（TextButton） | 同上 | 同上；**默认 `gone`** | 11sp，"清理重复" | 112-122 |
| ├ `tvPidHint` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `End 12dp` / `Bottom 4dp` | 11sp，`text_dim` | 127-136 |
| └ `rvPids` | `match_parent` × **`0dp` + `weight=1`** | `clipToPadding=false`；`paddingBottom 12dp` | — | 138-144 |

**`item_pid.xml`（每行）**

| 层级 | 控件 | 尺寸 | 边距 / 内边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|---|
| | （根） | `match_parent` × `wrap_content` | `marginStart 8dp` / `Top 4dp` / `End 8dp`；`padding 10dp`；`gravity=center_vertical` | 背景 `@drawable/bg_card` | 2-11 |
| ├ | （文字列） vertical | `0dp` × `wrap_content`，`weight=1` | — | | 13-17 |
| │ ├ `tvName` | `match_parent` × `wrap_content` | — | **14sp bold**，`text_primary` | 19-25 |
| │ ├ `tvSub` | `match_parent` × `wrap_content` | `marginTop 2dp`；`monospace` | **11sp**，`text_secondary` | 27-34 |
| │ └ `tvNote` | `match_parent` × `wrap_content` | `marginTop 2dp`；`maxLines 2`；**默认 `gone`** | **10sp**，`text_dim` | 36-44 |
| ├ `swEnable` | `wrap_content` | `marginStart 6dp` | — | 47-51 |
| └ `btnDelete`（TextButton） | `wrap_content` × **`36dp`** | `minWidth 0dp`；`paddingStart/End 8dp` | **12sp**，"删"，色 `@color/danger` | 53-63 |

**`item_pid_header.xml`（分组标题行）**：`TextView`，`match_parent` × `wrap_content`，`paddingStart 12dp` / `Top 12dp` / `End 12dp` / `Bottom 2dp`，**12sp bold**，色 `@color/accent`（:2-11）。

---

### 3.5 规则页（`fragment_rule.xml` + `item_rule.xml`）

根 = `MaxWidthLinearLayout`，**`app:maxWidthDp=760dp`**，`@color/bg`（:3-10）。

| 层级 | 控件 | 尺寸 | 边距 | 字号 | 行 |
|---|---|---|---|---|---|
| ├ 按钮行 | horizontal | `match_parent` × `wrap_content` | `paddingStart 8dp` / `Top 8dp` / `End 8dp` | | 12-18 |
| │ ├ `btnAddRule` | `0dp` × **`40dp`**，`weight=1` | `insetTop/Bottom 0dp` | 12sp | 20-28 |
| │ └ `btnResetRules`（Outlined） | `0dp` × `40dp`，`weight=1` | `marginStart 6dp`；`insetTop/Bottom 0dp` | 12sp | 30-40 |
| ├ `tvRuleHint` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 6dp` / `End 12dp` / `Bottom 4dp` | 11sp，`text_dim` | 43-53 |
| └ `rvRules` | `match_parent` × `0dp` `weight=1` | `clipToPadding=false`；`paddingBottom 12dp` | — | 55-61 |

**`item_rule.xml`**

| 层级 | 控件 | 尺寸 | 边距 / 内边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|---|
| | （根） | `match_parent` × `wrap_content` | `marginStart 8dp` / `Top 4dp` / `End 8dp`；`padding 10dp` | `@drawable/bg_card` | 2-11 |
| ├ | 文字列 vertical | `0dp` × `wrap_content`，`weight=1` | — | | 13-17 |
| │ ├ `tvName` | `match_parent` × `wrap_content` | — | **14sp bold**，`text_primary` | 19-25 |
| │ ├ `tvDesc` | `match_parent` × `wrap_content` | `marginTop 3dp` | **11sp**，`text_secondary` | 27-33 |
| │ └ `tvState` | `match_parent` × `wrap_content` | `marginTop 2dp` | **10sp**，`text_dim` | 35-41 |
| ├ `swEnable` | `wrap_content` | `marginStart 6dp` | — | 44-48 |
| └ `btnDelete`（TextButton） | `wrap_content` × `36dp` | `minWidth 0dp`；`paddingStart/End 8dp` | 12sp，"删"，`@color/danger` | 50-60 |

---

### 3.6 日志页（`fragment_log.xml` + `item_log.xml`）

根 = `MaxWidthLinearLayout`，**`app:maxWidthDp=900dp`**（日志行较长，比列表页稍宽），`@color/bg`（:3-10）。

| 层级 | 控件 | 尺寸 | 边距 | 其它 | 行 |
|---|---|---|---|---|---|
| ├ 筛选行 | horizontal，`gravity=center_vertical` | `match_parent` × `wrap_content` | `paddingStart 10dp` / `Top 8dp` / `End 10dp` | | 12-19 |
| │ ├ `spLevel` | `0dp` × **`36dp`**，`weight=1` | — | 背景 `bg_input` | 21-26 |
| │ └ `spModule` | `0dp` × `36dp`，**`weight=1.2`** | `marginStart 6dp` | 背景 `bg_input` | 28-34 |
| ├ 按钮行 | horizontal | `match_parent` × `wrap_content` | `paddingStart 8dp` / `Top 4dp` / `End 8dp` | | 37-43 |
| │ ├ `btnLogPause`（TextButton） | `0dp` × `36dp`，`weight=1` | `insetTop/Bottom 0dp` | 11sp，"暂停滚动" | 45-54 |
| │ ├ `btnLogExport`（TextButton） | 同上 | 同上 | 11sp | 56-65 |
| │ └ `btnLogClear`（TextButton） | 同上 | 同上 | 11sp | 67-76 |
| ├ `tvLogStats` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `End 12dp` / `Bottom 4dp` | 11sp，`text_dim` | 79-88 |
| └ `rvLogs` | `match_parent` × `0dp` `weight=1` | `clipToPadding=false`；`paddingBottom 12dp` | — | 90-96 |

**`item_log.xml`（一行日志）**：`TextView`，`match_parent` × `wrap_content`，**`monospace`**，`paddingStart 10dp` / `Top 1dp` / `End 10dp` / `Bottom 1dp`，**10sp**，`text_secondary`，`textIsSelectable=true`（:2-12）。

> 这里原来有个「知识库」按钮（v1.20.3 已删，改成导航栏第 6 个 tab）—— 同一个功能两个入口 = 两份权威（:97-101）。

---

### 3.7 知识库页（`fragment_knowledge.xml`）

根 = `MaxWidthNestedScrollView`，`layout_gravity=center_horizontal`，`fillViewport=true`，**`app:maxWidthDp=820dp`**（正文是长段落，太宽难扫读），`@color/bg`（:19-26）。

| 层级 | 控件 | 尺寸 | 边距 / 内边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|---|
| ├ | （内容）vertical | `match_parent` × `wrap_content` | **`padding 10dp`** | | 28-32 |
| ├ `etFilter` | `match_parent` × `wrap_content` | **`minHeight 44dp`**；`paddingStart/End 12dp`；`maxLines 1`；`imeOptions=actionDone` | 13sp；文字 `text_primary`，hint `text_dim`；背景 `bg_input` | 34-48 |
| ├ `chipTags` | `ChipGroup` | `match_parent` × `wrap_content` | `marginTop 6dp`；`singleLine=false`；`singleSelection=true` | — | 55-61 |
| ├ `tvFilterHint` | `match_parent` × `wrap_content` | `marginTop 2dp`；`paddingStart 4dp` | 11sp，`text_dim` | 63-70 |
| └ `llSections` | `match_parent` × `wrap_content` | `marginTop 6dp`；vertical | 各节由代码生成 | 73-78 |

**各节（标题 + 正文 + 标签）是代码生成的** —— `KnowledgeFragment.kt`：

| 元素 | 值 | 行 |
|---|---|---|
| 每节容器内边距 | `setPadding(dp(14), dp(12), dp(14), dp(12))` | 151 |
| 节标题 | **14f sp**，色 `@color/accent` | 157 |
| 标签行 | **10.5f sp**，`paddingTop dp(3)` | 164-165 |
| 正文 | **12.5f sp**，`setLineSpacing(dp(4), 1f)`，`paddingTop dp(8)` | 171-173 |
| 节间距 | `topMargin = dp(8)` | 179 |

> 内容写在 `KnowledgeFragment.SECTIONS` 里，**不是 XML** —— 每加一条术语只加一行（:11-16）。改这些字号要去 `.kt`。

---

## 四、各编辑器 / 工具 Activity

### 4.1 PID 编辑器（`activity_pid_editor.xml`）

**底部按钮条（固定，不滚动）**：`LinearLayout`，`match_parent` × `wrap_content`，`@color/bg_surface`，horizontal，**`padding 10dp`**（:694-699）

| 控件 | 尺寸 | 边距 | 其它 | 行 |
|---|---|---|---|---|
| `btnDelete`（Outlined） | `0dp` × `wrap_content`，`weight=1` | — | 文字色 `@color/danger` | 701-708 |
| `btnSave` | `0dp` × `wrap_content`，**`weight=2`** | `marginStart 10dp` | "保存 PID" | 710-716 |

**滚动区**：`MaxWidthScrollView`，`id=scrollRoot`，`match_parent` × **`0dp` + `weight=1`**，`layout_gravity=center_horizontal`，`fillViewport=true`，**`app:maxWidthDp=720dp`**（:13-20）。
内容 = `LinearLayout` vertical，`match_parent` × `wrap_content`，**`padding 12dp`**（:22-26）。

**字段与分区**（全部用 §1.2 的公共 style）：

| 分区标题（`SectionTitle`） | 行 |
|---|---|
| 基本信息 | 28-33（`paddingTop` 被覆盖成 `0dp`） |
| 解析与换算 | 182-186 |
| 信号校验与新鲜度 | 524-528 |
| 测试（强烈建议保存前先测） | 636-640 |

| 控件 | style | 尺寸 | 行 |
|---|---|---|---|
| `etName` | `InputEdit` | `match_parent` × `wrap_content` | 41-47 |
| `spProtocol` | — | `match_parent` × **`42dp`**，背景 `bg_input` | 55-59 |
| `spSource`（数据来源） | — | `match_parent` × **`42dp`**，`bg_input` | 72-76 |
| `tvHeaderLabel` | `FieldLabel` | `wrap_content` | 84-89 |
| `etHeader` | `InputEditMono` | `match_parent` × `wrap_content` | 91-97 |
| `tvHeaderHint` | — | 11sp，`text_dim` | 99-104 |
| `rowModePid`（horizontal，`etMode` weight=1 / `etPid` weight=1.4，中间 `marginStart 10dp`） | | | 111-159 |
| `rowRequest`（vertical，`etRequest`） | | | 161-180 |
| `etFormula` | `InputEditMono` | `match_parent` × `wrap_content` | 194-200 |
| `btnTpl1`…`btnTpl5`（TextButton） | | `0dp` × **`34dp`**，各 `weight=1`，11sp | 208-262 |
| `btnTplBitsAt`（TextButton） | | `match_parent` × **`34dp`**，11sp | 271-279 |
| `tvFormulaHint` | — | 11sp，`text_dim` | 281-287 |
| 单位/最小/最大 行（3 列，各 `weight=1`，`marginStart 10dp`） | | | 289-358 |
| 报警下限/上限 行（2 列） | | | 360-407 |
| `rowGroupInterval`（分组 `etGroup` weight=1 / `colInterval` weight=1） | | | 409-463 |
| `rowPriorityEcu`（`spPriority` / `etEcuIndex`，各 `weight=1`，`marginTop 8dp`） | | | 466-515 |
| `rowSignalParams`（`etInvalidRaw` / `etMinDlc` / `colTtl`，各 `weight=1`） | | | 530-604 |
| `tvSignalHint` | — | 11sp，`text_dim` | 606-611 |
| `etNote` | `InputEdit` | `match_parent` × `wrap_content` | 619-625 |
| `swEnabled` | — | `marginTop 8dp`，13sp，`text_primary` | 627-634 |
| `btnTest` | 实心 | `match_parent` × `wrap_content` | 642-646 |
| `btnSample`（Outlined） | | `match_parent` × `wrap_content`，`marginTop 6dp` | 648-654 |
| `tvTx` / `tvRx` / `tvBytes` / `tvResult` | `MonoBox` | `match_parent` × `wrap_content`，`marginTop 6dp` / `4dp` / `4dp` / `4dp` | 656-686 |
| （底部留白） | `View` | `match_parent` × **`16dp`** | 688-690 |

**运行时按「数据来源」变形**（`PidEditorActivity` + `PidDraft`）：监听型会隐藏 `rowModePid` / `rowRequest` / `colInterval` / `rowPriorityEcu`，`colTtl` 反过来只对监听型显示（:106-110、:436-440、:465、:517-523）。**隐藏不等于清空** —— 存量条目的值原样保留。

---

### 4.2 规则编辑器（`activity_rule_editor.xml` + `row_condition.xml` + `row_action.xml`）

结构与 PID 编辑器**完全同构**：`MaxWidthScrollView`（`id=scrollRoot`，`weight=1`，**`maxWidthDp=760dp`**，:13-20）+ 底部按钮条（`@color/bg_surface`，`padding 10dp`，:224-247）。

| 控件 | style / 尺寸 | 边距 | 行 |
|---|---|---|---|
| `TextView` "规则" | `SectionTitle`（`paddingTop` 覆盖为 `0dp`） | | 28-33 |
| `etName` | `InputEdit`，`match_parent` | | 41-47 |
| `swEnabled` | `match_parent` × `wrap_content` | `marginTop 8dp`，13sp | 49-56 |
| 三列行：`spLogic`（`42dp`）/ `etDuration` / `etCooldown`，各 `weight=1`，`marginStart 10dp` | | | 58-125 |
| `TextView` "当（条件）" | `SectionTitle` | | 127-131 |
| 提示文字 | 10sp，`text_dim` | | 133-138 |
| `condContainer` | `LinearLayout` vertical（行 = `row_condition.xml`） | | 140-144 |
| `btnAddCond`（TextButton） | `wrap_content` | `marginTop 4dp` | 146-152 |
| `TextView` "则（动作）" | `SectionTitle` | | 154-158 |
| 提示文字 | 10sp，`text_dim` | | 160-165 |
| `actionContainer` | vertical（行 = `row_action.xml`） | | 167-171 |
| `btnAddAction`（TextButton） | `wrap_content` | `marginTop 4dp` | 173-179 |
| `tvPreview` | `MonoBox` | `marginTop 12dp` | 181-187 |
| `btnTestNow`（Outlined） | `match_parent` | `marginTop 8dp` | 189-195 |
| `btnSimulate`（Outlined） | `match_parent` | `marginTop 6dp` | 202-208 |
| `tvTestResult` | 12sp，`text_secondary` | `marginTop 4dp` | 210-216 |
| （底部留白） | `View` | `match_parent` × **`16dp`** | 218-220 |
| 底部条 `btnDelete`（Outlined，weight=1）/ `btnSave`（weight=2，`marginStart 10dp`） | | `padding 10dp` | 224-247 |

**`row_condition.xml`（一行条件）** —— 根 `LinearLayout` horizontal，`gravity=center_vertical`，`match_parent` × `wrap_content`，`marginTop 6dp`，`padding 6dp`，背景 `bg_input`（:2-9）

| 控件 | 尺寸 | 权重 | 边距 | 行 |
|---|---|---|---|---|
| `spSource` | `0dp` × **`40dp`** | **2.2** | — | 11-15 |
| `spOp` | `0dp` × `40dp` | **1.3** | `marginStart 4dp` | 17-22 |
| `etThreshold` | `0dp` × `40dp`（`InputEditMono`，`minHeight 40dp`，13sp） | **1.1** | `marginStart 4dp` | 24-34 |
| `btnRemove`（TextButton） | `wrap_content` × `40dp` | — | `minWidth 0dp`；`paddingStart/End 6dp`；**16sp**，`@color/danger`，"×" | 36-46 |

**`row_action.xml`（一行动作）** —— 同根样式（:2-9）

| 控件 | 尺寸 | 权重 | 边距 | 行 |
|---|---|---|---|---|
| `spType` | `0dp` × `40dp` | **1.4** | — | 11-15 |
| `etP1` | `0dp` × `40dp`（`InputEditMono`，**12sp**，hint "参数1"） | **1.4** | `marginStart 4dp` | 17-27 |
| `etP2` | 同上，hint "参数2" | **1** | `marginStart 4dp` | 29-39 |
| `etP3` | 同上，hint "参数3" | **1** | `marginStart 4dp` | 41-51 |
| `btnPickAudio`（TextButton） | `wrap_content` × `40dp` | — | `paddingStart/End 6dp`；16sp；"📁"；**默认 `gone`** | 53-63 |
| `btnPreview`（TextButton） | `wrap_content` × `40dp` | — | 同上；"♪" | 65-74 |
| `btnRemove`（TextButton） | `wrap_content` × `40dp` | — | 同上；"×"，`@color/danger` | 76-86 |

> 📌 `row_action.xml` 里有 **`etP3`** 和 **`btnPickAudio`**，[UI控件清单.md](UI控件清单.md) 的 id 列表里没有 —— 以本表为准。

---

### 4.3 PID 扫描器（`activity_scanner.xml`）

根 = `LinearLayout`，`match_parent` × `match_parent`，`@color/bg`，vertical（:2-7）。

| 层级 | 控件 | 尺寸 | 边距 / 内边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|---|
| └ | `MaxWidthNestedScrollView` | `match_parent` × **`0dp` + `weight=1`** | `layout_gravity=center_horizontal`；`fillViewport=true`；**`maxWidthDp=760dp`** | | 9-15 |
| ⠀└ | （内容）vertical | `match_parent` × `wrap_content` | **`padding 12dp`** | | 17-21 |
| ⠀⠀├ `tvWarning` | `match_parent` × `wrap_content` | `padding 10dp` | 11sp，`text_primary`；背景 `@drawable/bg_banner` | 23-31 |
| ⠀⠀├ `TextView` "扫描范围" | `SectionTitle` | | | 33-37 |
| ⠀⠀├ 3 列行（`spMode` **`42dp`** / `etFrom` / `etTo`，各 `weight=1`，`marginStart 10dp`） | | | | 39-106 |
| ⠀⠀├ `TextView` "限流与容错（保护总线）" | `SectionTitle` | | | 108-112 |
| ⠀⠀├ 3 列行（`etInterval` / `etTimeout` / `etRetry`，各 `weight=1`） | | | 默认值 150 / 1500 / 1 | 114-186 |
| ⠀⠀├ 2 列行（`etMax` weight=1 默认 400 / `etLearn` **weight=2** 默认 0） | | | | 188-237 |
| ⠀⠀├ `etBlacklist` | `FieldLabel` + `InputEditMono` | `match_parent` | | 239-250 |
| ⠀⠀├ `swBitmap` | `match_parent` × `wrap_content` | `marginTop 6dp`；`checked=true` | 12sp，`text_primary` | 252-260 |
| ⠀⠀├ `swConfirm` | `match_parent` × `wrap_content` | — | 12sp，**`@color/warn`** | 262-268 |
| ⠀⠀├ 按钮行（`btnStart` / `btnStop` / `btnExport`，各 `weight=1`，`marginStart 8dp`） | | `marginTop 8dp` | | 270-304 |
| ⠀⠀├ `progress` | `ProgressBar`（horizontal） | `match_parent` × `wrap_content` | `marginTop 10dp`；`max=100` | 306-312 |
| ⠀⠀├ `tvProgress` | `match_parent` × `wrap_content` | `marginTop 4dp`；`monospace` | 11sp，`text_secondary` | 314-322 |
| ⠀⠀├ `TextView` "命中结果" | `SectionTitle` | | | 324-328 |
| ⠀⠀├ `rvHits` | `match_parent` × `wrap_content` | `nestedScrollingEnabled=false` | | 330-334 |
| ⠀⠀├ `TextView` "扫描日志" | `SectionTitle` | | | 336-340 |
| ⠀⠀├ `tvLog` | `MonoBox` + **`textSize` 覆盖为 `10sp`** | `match_parent` × `wrap_content`；`maxLines 12` | | 342-348 |
| ⠀⠀└ （底部留白） | `View` | `match_parent` × **`20dp`** | | 350-352 |

> 📌 `activity_scanner.xml` 里有 **`btnExport`**，[UI控件清单.md](UI控件清单.md) 的扫描器 id 列表里没有 —— 以本表为准。

---

### 4.4 CAN 被动探测（`activity_can_sniffer.xml`）

> ⚠️ **这一页没有 `MaxWidth*` 限宽** —— 根是普通 `LinearLayout`，横屏平板上按钮会拉满整宽。

根 = `LinearLayout`，`match_parent` × `match_parent`，`@color/bg`，vertical（:5-10）。

| 层级 | 控件 | 尺寸 | 边距 / 内边距 | 字号 | 行 |
|---|---|---|---|---|---|
| ├ 第 1 行 | horizontal | `match_parent` × `wrap_content` | `paddingStart 6dp` / `Top 6dp` / `End 6dp` | | 12-18 |
| │ ├ `btnSniffToggle` | `0dp` × **`40dp`**，**`weight=2`** | `insetTop/Bottom 0dp`；`minWidth 0dp` | 12sp | 20-29 |
| │ └ `btnSniffClear`（Outlined） | `0dp` × `40dp`，`weight=1` | `marginStart 4dp`；`paddingStart/End 4dp` | 12sp | 31-44 |
| ├ 第 2 行 | horizontal，`gravity=center_vertical` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 4dp` / `End 12dp` | | 47-54 |
| │ ├ `TextView` "采集" | `wrap_content` | — | 11sp | 56-60 |
| │ ├ `spSniffDuration` | `0dp` × `wrap_content`，`weight=1` | `paddingStart 4dp` | — | 62-67 |
| │ ├ `cbSniffRotate`（CheckBox） | `wrap_content` | `paddingStart 6dp` / `End 2dp` | 11sp，"分段轮换" | 75-82 |
| │ ├ `btnSniffExportAgg`（Outlined） | `0dp` × **`36dp`**，`weight=1.4` | `paddingStart/End 2dp` | 11sp | 84-96 |
| │ └ `btnSniffExportRaw`（Outlined） | 同上 | + `marginStart 4dp` | 11sp | 98-111 |
| ├ 第 3 行（信号表） | horizontal | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 4dp` / `End 12dp` | | 119-126 |
| │ ├ `btnSniffExportTemplate`（Outlined） | `0dp` × `36dp`，`weight=1.4` | `paddingStart/End 2dp` | 11sp | 128-140 |
| │ └ `btnSniffImportSignal`（Outlined） | 同上 | + `marginStart 4dp` | 11sp | 142-155 |
| ├ 第 4 行（过滤器） | horizontal，`gravity=center_vertical` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 4dp` / `End 12dp` | | 157-164 |
| │ ├ `TextView` "过滤器" | `wrap_content` | — | 11sp | 166-170 |
| │ └ `etSniffFilter` | `0dp` × `wrap_content`，`weight=1` | `paddingStart 4dp`；`maxLength 40`；`inputType=textCapCharacters\|textNoSuggestions` | 11sp | 172-182 |
| ├ `HorizontalScrollView`（`scrollbars=none`） | `match_parent` × `wrap_content` | `paddingStart/End 12dp` | | 193-198 |
| │ └ `cgFilterPresets` | `ChipGroup`，`wrap_content` | `singleLine=true`；`singleSelection=false` | — | 200-205 |
| ├ `btnSniffDiff`（Outlined） | `match_parent` × **`40dp`** | `marginStart 12dp` / `Top 4dp` / `End 12dp` | 12sp | 207-218 |
| ├ `btnMonitorToggle`（Outlined） | `match_parent` × **`40dp`** | `marginStart 12dp` / `Top 4dp` / `End 12dp` | 12sp | 220-231 |
| ├ `tvSniffStatus` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 6dp` / `End 12dp` / `Bottom 4dp` | 11sp，`text_dim` | 233-242 |
| ├ `tvSniffRotate` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `End 12dp` / `Bottom 4dp` | 12sp，`text_primary`；**默认 `gone`** | 250-259 |
| └ `ScrollView`（`0dp` + `weight=1`） | | | | 261-264 |
| ⠀└ `sniffResults`（`ColumnFlowLayout`）/ `sniffDiffs`（vertical），`paddingStart/End 12dp` / `Bottom 16dp` | | | 每行代码生成 | 271-286 |

**结果行是代码生成的**（`CanSnifferActivity.kt`）：分组标题 11f + `padding(0, dp(8), 0, dp(2))`（:375-376）；行内 `padding(0, dp(2), 0, dp(2))`（:383）；主文字 **12f**（:388）；次要文字 **11f**，`padding(dp(6), 0, dp(6), 0)`（:395-397）。

---

### 4.5 模拟信号（`activity_simulator.xml` + 代码生成的行）

根 = `LinearLayout`，`match_parent` × `match_parent`，`@color/bg`，vertical（:11-15）。**没有 `MaxWidth*` 限宽。**

**A. 状态区（固定，不随列表滚动）** —— `LinearLayout` vertical，`match_parent` × `wrap_content`，`paddingStart 12dp` / `Top 10dp` / `End 12dp` / `Bottom 6dp`（:18-25）

| 控件 | 尺寸 | 边距 | 字号 / 颜色 | 行 |
|---|---|---|---|---|
| `simDot` | **`10dp` × `10dp`** | — | `@drawable/dot_offline`（运行时换） | 34-38 |
| `tvSimStatus` | `0dp` × `wrap_content`，`weight=1` | `marginStart 8dp` | **15sp bold**，`text_primary` | 40-49 |
| `tvSimHint` | `match_parent` × `wrap_content` | `marginTop 4dp` | 12sp，`text_dim` | 52-58 |

**B. 主操作**：`btnSimToggle`，`match_parent` × **`48dp`**，`marginStart/End 12dp`，`insetTop/Bottom 0dp`，**15sp**（:62-71）。

**C. 快捷预设行**（:74-80，`marginStart/Top/End 12dp/6dp/12dp`）：`btnSimDemo` / `btnSimAllAuto` / `btnSimRebuild`，各 `0dp` × **`40dp`**，`weight=1`，`insetTop/Bottom 0dp`，`minWidth 0dp`，`paddingStart/End 6dp`，**12sp**（:82-124）。

**D. 分隔线**：`View`，`match_parent` × **`1dp`**，`marginStart 12dp` / `Top 10dp` / `End 12dp`，色 **`@color/gauge_track`**（:127-133）。

**E. 通道列表**：`ScrollView`，`match_parent` × **`0dp` + `weight=1`**，`paddingStart/End 12dp`（:136-141）→ `simChannels`（`LinearLayout` vertical，`paddingBottom 24dp`，:143-148）。

**F. 每个通道行（代码生成，`SimulatorActivity.kt:240-328`）**

| 元素 | 值 | 行 |
|---|---|---|
| 行容器 | vertical；`setPadding(dp(10), dp(6), dp(10), dp(6))`；`bottomMargin dp(4)` | 244-251 |
| 行底色 | 展开 `@color/bg_surface2` / 收起 `@color/bg_surface` | 246 |
| `MaterialSwitch` | 无显式尺寸 | 263-269 |
| 名称 | **14f**；启用 `text_primary` / 停用 `text_dim`；`weight=1`；`padding(dp(10), 0, dp(6), 0)` | 270-276 |
| `WaveThumbView` | **`dp(54)` × `dp(22)`**；`marginEnd dp(8)`；色 `accent` + `gauge_track` | 278-282 |
| 量程文字 | **11f**，`text_dim`，`gravity=END`，宽 **`dp(96)`** | 283-289 |
| 展开箭头 | **13f**，`text_secondary`，`padding(dp(6), 0, 0, 0)` | 290-295 |
| 分组小标题 | **11f**，`text_dim`，`padding(0, 0, 0, dp(3))` | 334-339 |
| chip 按钮 | **11f**；`dp(32)` 高；`padding(dp(12), 0, dp(12), 0)`；`marginEnd dp(6)`；选中实心 `accent`+黑字 / 未选 `bg_elevated`+`text_secondary` | 350-368 |
| chip 颜色 | 波形=`accent`、周期=`info`、噪声=`warn` | 304 / 312 / 320 |
| 间距 | `space(6)` = 6dp 高占位 | 299-330 |

---

### 4.6 主题编辑器（`activity_theme_editor.xml`）

根 = `LinearLayout`，`match_parent` × `match_parent`，`@color/bg`，vertical（:7-11）。**没有 `MaxWidth*` 限宽。**

| 层级 | 控件 | 尺寸 | 边距 | 字号 | 行 |
|---|---|---|---|---|---|
| ├ 按钮行 1 | horizontal | `match_parent` × `wrap_content` | `paddingStart 6dp` / `Top 6dp` / `End 6dp` | | 13-19 |
| │ ├ `btnThemeSave` | `0dp` × **`40dp`**，`weight=1` | `insetTop/Bottom 0dp`；`minWidth 0dp`；`paddingStart/End 4dp` | 12sp | 21-32 |
| │ ├ `btnThemeSaveAs`（Outlined） | 同上 | + `marginStart 4dp` | 12sp | 34-47 |
| │ ├ `btnThemeDelete`（Outlined） | 同上 | 同上 | 12sp | 49-62 |
| │ └ `btnThemeRevert`（Outlined） | 同上 | 同上 | 12sp | 64-77 |
| ├ 按钮行 2 | horizontal | `match_parent` × `wrap_content` | `paddingStart 6dp` / `Top 4dp` / `End 6dp` | | 80-86 |
| │ ├ `btnThemeExport`（Outlined） | `0dp` × `40dp`，`weight=1` | 同上 | 12sp | 88-100 |
| │ └ `btnThemeImport`（Outlined） | 同上 | + `marginStart 4dp` | 12sp | 102-115 |
| ├ `tvThemeTitle` | `match_parent` × `wrap_content` | `paddingStart 12dp` / `Top 6dp` / `End 12dp` | 12sp，`text_secondary` | 118-126 |
| ├ **实时预览区** | horizontal | `match_parent` × **`170dp`**（固定高度） | `padding 8dp` | | 134-138 |
| │ ├ `pvCardCircle`（FrameLayout，`weight=1`）→ `pvCircle`（`CircularGaugeView`，`match_parent`） | | | | 140-150 |
| │ └ 右列（vertical，`weight=1`，`marginStart 8dp`） | | | | 152-157 |
| │ ⠀├ `pvCardBar1`（`weight=1`）→ `pvBar1`（`BarGaugeView`） | | | | 159-169 |
| │ ⠀└ `pvCardBar2`（`weight=1`，`marginTop 6dp`）→ `pvBar2`（`BarGaugeView`） | | | | 171-182 |
| └ `ScrollView`（`0dp` + `weight=1`）→ `themeFields`（`ColumnFlowLayout`） | `match_parent` × `wrap_content` | `paddingStart/End 12dp` / `Bottom 16dp` | 字段由代码生成 | 186-198 |

> ⚠️ **每个仪表都套了一层 `pvCard*` 容器**，用来画**卡片底**（圆角/描边/不透明度）。不套的话调「卡片描边」「卡片不透明度」滑块时**看不到任何变化**（:128-133）。

---

### 4.7 探测记录（`ProbeLogActivity`，**纯代码 UI，没有 XML**）

| 元素 | 值 | 行 |
|---|---|---|
| 根背景 | **硬编码 `0xFF0B0E13`**（不在 `colors.xml` 里！） | 62 |
| 根内边距 | `setPadding(dp(12), dp(12), dp(12), dp(8))` | 63 |
| 标题 | 18f，`0xFFE6EDF3` | 72 |
| 副标题 | 12f，`0xFF8B98A5`，`paddingStart dp(10)` | 75 |
| TabLayout 指示器高 | `setSelectedTabIndicatorHeight(dp(2))` | 93 |
| TabLayout 背景 | `0xFF0B0E13` | 95 |
| 空态文字 | 13f，`0xFF8B98A5`，`paddingTop dp(20)` | 170 |
| 记录卡 | `padding(dp(10), dp(8), dp(10), dp(8))`；底 `0xFF141A22`；`bottomMargin dp(6)` | 176-192 |
| 卡内小字 | 11f，`0xFF8B98A5` | 183 |
| 卡内主字 | 13f，`0xFFE6EDF3`，`paddingTop dp(2)` | 187-188 |

> ⚠️ 这一页的颜色**全是硬编码 ARGB**，改 `colors.xml` **不会**影响它。

---

### 4.8 性能基准（`BenchActivity`，**纯代码 UI，没有 XML**）

| 元素 | 值 | 行 |
|---|---|---|
| 根背景 | `@color/bg`，`padding dp(12)` 四边 | 143-144 |
| 标题 | 16f，`weight=1` | 151-155 |
| 按钮行 | 按钮 + `marginStart dp(6)` | 161-170 |
| 按钮文字 | 12f | 175 |
| 说明文字 | 11f，`padding(0, dp(4), 0, dp(4))` | 182-185 |
| 数据行底 | `@color/bg_surface` | 191 |
| 表格容器 | `match_parent` × `0dp`，`weight=1`，`topMargin dp(4)` | 206-207 |
| 强调色 | `@color/accent` | 176 |

---

## 五、对话框与浮层

### 5.1 表属性对话框（`dialog_gauge_edit.xml`）

根 = `MaxWidthScrollView`，`match_parent` × `wrap_content`，`layout_gravity=center_horizontal`，**`app:maxWidthDp=520dp`**（:2-7）。
内容 = `LinearLayout` vertical，`match_parent` × `wrap_content`，**`padding 16dp`**（:9-13）。

| 控件 | 类型 | 尺寸 | 边距 / 其它 | 行 |
|---|---|---|---|---|
| `TextView` "数据通道" | `FieldLabel`（`paddingTop` 覆盖为 `0dp`） | `wrap_content` | | 15-20 |
| `spPid` | `Spinner` | `match_parent` × **`42dp`** | 背景 `bg_input` | 22-26 |
| `TextView` "样式" | `FieldLabel` | | | 28-32 |
| `spStyle` | `Spinner` | `match_parent` × **`42dp`** | `bg_input` | 34-38 |
| `TextView` "占位宽度" | `FieldLabel` | | | 40-44 |
| `spSpan` | `Spinner` | `match_parent` × **`42dp`** | `bg_input` | 46-50 |
| `TextView` "霓虹效果（只作用于这一块表）" | `FieldLabel` | | | 51-55 |
| `spNeon` | `Spinner` | `match_parent` × **`42dp`** | `bg_input` | 57-61 |
| `TextView` "卡片外框（只作用于这一块表）" | `FieldLabel` | | | 63-67 |
| **`spCard`** | `Spinner` | `match_parent` × **`42dp`** | `bg_input` | 69-73 |
| 两列行：`etMin` / `etMax`（各 `weight=1`，`marginStart 10dp`） | `InputEditMono` | `match_parent` × `wrap_content` | | 75-122 |
| 两列行：`etWarnLow` / `etWarnHigh`（各 `weight=1`，`marginStart 10dp`） | `InputEditMono` | `match_parent` × `wrap_content` | | 124-171 |

> 📌 **`spCard`**（卡片外框）在 XML 里存在，[UI控件清单.md](UI控件清单.md) 的对话框 id 列表里没有 —— 以本表为准。它的取值见 `GaugeItem.CARD_THEME=0` / `CARD_NO_BORDER=1` / `CARD_TRANSPARENT=2` / `CARD_NONE=3`（`PidModels.kt:582-588`）。

### 5.2 纯代码对话框（没有 XML，尺寸在 `.kt` 里）

全部在 `ui/dash/CanvasSettingsFragment.kt`，用 `MaterialAlertDialogBuilder` + 代码建的 `LinearLayout`。

| 对话框 | 触发控件 | 关键尺寸 | 行 |
|---|---|---|---|
| **轮询间隔** | `btnPollInterval` | 8 档：**60 / 80 / 100 / 120 / 150 / 200 / 250 / 300 ms**（`pollChoices`，:93）；默认 **120**（`Store.kt:17`） | 1139-1172 |
| **手势** | `btnGestures` | 4 个方向 × 7 个动作（见 §7） | — |
| **画布名浮标** | `btnNameLabel` | 5 个选项：左上 / 右上 / 左下 / 右下 / 隐藏（`DashCanvas.NAME_POS_NAMES`） | 1279 |
| **灵动岛样式** | `btnIsland` | 见下 | 1336-1489 |
| **画布操作菜单** | 每行 `btnRowMenu` | 改名 / 上移 / 下移 / 前往 / 删除 / **编辑这一套…** | — |

**灵动岛样式对话框的排版**（`CanvasSettingsFragment.kt:1336-1472`）：

| 元素 | 值 | 行 |
|---|---|---|
| **实时预览框** | `FrameLayout`，`match_parent` × **`78dp`**；底色 `0x33FFFFFF`；`topMargin dp(10)` | 1337-1342 |
| 预览胶囊 | `IslandCapsuleView`（**与真弹的是同一个类**），`WRAP_CONTENT`，`Gravity.TOP\|CENTER_HORIZONTAL`，`topMargin dp(10)` | 1343-1351 |
| 预览文案 | `setContent("冷却液温度过高", 2)`（带一个 `+N`，把"还有别的告警"也预览出来） | 1424 |
| 字段标签 | 12f，`setPadding(0, dp(12), 0, 0)` | 1361-1365 |
| Spinner | 5 个：位置 / 尺寸 / 圆角 / 停留时长 / 配色 | 1374-1389 |
| 背景色 / 文字色按钮 | `match_parent` × **`44dp`**，13f；`topMargin dp(10)` / `dp(6)` | 1391-1404 |
| 靠边时的边距 | `dp(10)`（与 `IslandNotice.SIDE_MARGIN_DP` 同值） | 1436-1437 |

### 5.3 浮层（全部挂在 `android.R.id.content` 上，**不占布局**）

| 浮层 | 实现 | 位置 / 尺寸 | 关键值 |
|---|---|---|---|
| **灵动岛** | `ui/view/IslandNotice.kt` + `IslandCapsuleView.kt` | `Gravity.TOP` + 水平三档；**`WRAP_CONTENT × WRAP_CONTENT`**（代码里明确不许出现具体宽高） | 见下表 |
| **监听警示条** | `ui/view/MonitorWarnBar.kt` | `Gravity.TOP`，`MATCH_PARENT × WRAP_CONTENT` | 12sp 白字；`padding(dp(8), dp(4), dp(8), dp(4))`；底 **`0xF0B3261E`**；`elevation dp(6)` |
| **模拟悬浮条** | `MainActivity.updateSimBar()` | `Gravity.BOTTOM \| END`；`WRAP_CONTENT`；**`setMargins(0, 0, dp(12), dp(88))`**（抬高一点，别压住底部导航） | 底色 `0xE6101820`；`padding(dp(10), dp(6), dp(6), dp(6))`；规则名 12f `0xFFFFD400`；按钮 12f `padding(dp(8),0,dp(8),0)` |
| **左边缘把手** | `MainActivity.ensureRailHandle()` | `Gravity.START \| CENTER_VERTICAL`；**`dp(18)` × `dp(120)`**；`leftMargin dp(32)` | 文字 `❯` 14f `0xCCFFFFFF`；圆角 `dp(9)`；底色 `0x3DFFFFFF` |

**灵动岛的样式参数**（`data/IslandStyle.kt`，全部可配置）：

| 组 | 档位 | 值 | 行 |
|---|---|---|---|
| **位置** | 3 | 顶部居中（默认）/ 顶部靠左 / 顶部靠右 | 40-54 |
| **尺寸** | 3 | 字号 **12 / 13（默认）/ 15 sp** | 75 |
| | | 横向内边距 **12 / 14 / 18 dp** | 76 |
| | | 纵向内边距 **6 / 7 / 9 dp** | 77 |
| **圆角** | 3 | **6 / 12 / 18（默认）dp** —— ⚠️ `GradientDrawable` 会把半径夹到高度的一半，所以 18dp 渲染出来就是"全圆角胶囊" | 99 |
| **停留** | 3 | **2000 / 4000（默认）/ 6000 ms** | 104 |
| **配色** | 2 | 跟随主题（默认）/ 自定义 | 128 |
| | | 背景板 8 色：深色胶囊 `#F01A1F27` / 纯黑 / 卡片 `#F0141A23` / 卡片次级 `#F01C2430` / 警示红 `#F0B3261E` / 琥珀 `#F0FFB020` / 白 / 信息蓝 `#F04DA3FF` | 163-174 |
| | | 文字板 4 色：白 / 黑 / 黄 `#FFFFD400` / 青 `#FF00D8FF`；也支持手打 `#RRGGBB` | 177-184 |
| 描边 | 固定 | `1dp`，`#33FFFFFF` | 155 |
| `+N` 字号 | 派生 | 正文 `-2sp`，**不低于 10sp** | `IslandCapsuleView.kt:82` |

**灵动岛的位置与动画常量**（`IslandNotice.kt`）：

| 常量 | 值 | 行 |
|---|---|---|
| `TOP_MARGIN_DP` | **`10`** dp（贴顶留白） | 219 |
| `SIDE_MARGIN_DP` | **`10`** dp（靠左/靠右时的屏幕边距，**刻意不是 0**） | 222 |
| 纵向偏移 | `topOffsetPx + TOP_MARGIN_DP` —— `topOffsetPx` = 监听警示条高度（`MonitorWarnBar.heightPx()`），**三个位置档位都一样** | 207 |
| 入场动画 | `180ms`，`alpha 0→1`，`scale 0.82→1` | 224 / 163 |
| 出场动画 | `220ms`，`alpha→0`，`scale→0.9` | 225 / 181-184 |
| 收起判定节拍 | `TICK_MS = 50L` | 228 |
| `elevation` | `dp(8)` | `IslandCapsuleView.kt:50` |

---

## 六、「怎么改」工作流

### 6.1 改哪个值要动哪个文件

| 想改什么 | 动哪个文件 | 备注 |
|---|---|---|
| 全局底色、文字色、强调色、状态色 | `app/src/main/res/values/colors.xml` | **只影响 UI**；仪表盘颜色在 `GaugeTheme`（§1.5） |
| 所有输入框/字段标签/分区标题的字号与内边距 | `app/src/main/res/values/themes.xml` | 一次改、多处生效 |
| 所有卡片的圆角/描边/底色 | `app/src/main/res/drawable/bg_card.xml` | 全局共用，见 §1.3 的警告 |
| 所有输入框的圆角/底色 | `app/src/main/res/drawable/bg_input.xml` | 全局共用 |
| 导航栏底色/高度/图标配色 | `res/layout/activity_main.xml`、`res/layout-land/activity_main.xml`、`res/color/nav_item_color.xml` | **两份都要改** |
| 导航项的名字/数量/顺序 | `res/menu/bottom_nav.xml` + `res/values/strings.xml` | ⚠️ 上限 6 |
| 某个页面某个控件的尺寸/边距/字号 | 那个页面的 `res/layout/xxx.xml` | 见 §3 / §4 的「在哪儿改」 |
| 某个页面的限宽 | 该布局根上的 `app:maxWidthDp` | 见下表 |
| 代码生成的 UI（模拟页行、知识库节、探测记录、性能基准、CAN 结果行、悬浮条、把手、对话框） | 对应的 `.kt` | 见 §4.5 / §4.7 / §4.8 / §5.2 / §5.3 |
| 仪表盘外观（颜色/几何） | **App 内改**（主题编辑器 / 画布主题），或 `ui/view/GaugeTheme.kt:231-253` 改内置三套 | 见 §7 |
| 仪表内部字号/线宽比例 | `ui/view/*GaugeView.kt`、`BaseGaugeView.kt` | ⚠️ 本表**不覆盖**仪表内部的绘制排版（那是按 View 尺寸比例算的） |

**各页面的限宽一览**（`app:maxWidthDp`，单位 dp）：

| 页面 / 容器 | 限宽 | 容器类 | 文件:行 |
|---|---|---|---|
| 连接页 | **720** | `MaxWidthNestedScrollView` | `fragment_connect.xml:9` |
| 画布设置页 | **720** | `MaxWidthNestedScrollView` | `fragment_canvas_settings.xml:33` |
| PID 编辑器 | **720** | `MaxWidthScrollView` | `activity_pid_editor.xml:20` |
| PID 页 | **760** | `MaxWidthLinearLayout` | `fragment_pid.xml:14` |
| 规则页 | **760** | `MaxWidthLinearLayout` | `fragment_rule.xml:10` |
| 规则编辑器 | **760** | `MaxWidthScrollView` | `activity_rule_editor.xml:20` |
| 扫描器 | **760** | `MaxWidthNestedScrollView` | `activity_scanner.xml:15` |
| 知识库页 | **820** | `MaxWidthNestedScrollView` | `fragment_knowledge.xml:26` |
| 日志页 | **900** | `MaxWidthLinearLayout` | `fragment_log.xml:10` |
| 表属性对话框 | **520** | `MaxWidthScrollView` | `dialog_gauge_edit.xml:7` |
| 未指定时的默认值 | **720** | — | `MaxWidthViews.kt:68`（`DEFAULT_MAX_DP`） |
| CAN 探测页 / 模拟页 / 主题编辑器 / 探测记录 / 性能基准 | **无**（不限宽） | — | — |

### 6.2 改完要做什么（**这一步最容易漏**）

```
改 XML / values / drawable
        ↓
① 重建 APK        .\gradlew.bat assembleDebug
        ↓         （产物：app\build\outputs\apk\debug\…；发版时另存到 dist\iCarOBD-debug-vX.Y.Z-android.apk）
② 重装到设备       adb install -r -d dist\iCarOBD-debug-v1.20.20-android.apk
        ↓
③ 看真机效果（换主题/改设置类的改动可以跳过 ①②，见 §7）
```

> 🔴 **`tools/run-tests.ps1` 不重建 APK —— 这是踩过的坑。**
> 它只跑 **JVM 单元测试 + 构建守卫**，而守卫**只核 APK 的名字/体积/ABI**（CHANGELOG v1.20.13 明确写了这一点）。
> 所以「改完样式 → 跑 `run-tests.ps1` 全过 → 以为装机就是新样子」是**错的**：设备上跑的还是旧包。
> `tools/run-all.ps1`（完整回归 = Kotlin 单测 + 浏览器套件）**同样不产 APK**。
> **要看到样式改动，必须显式 `assembleDebug` + `adb install -r`。**

其它构建注意：

| 事 | 说明 |
|---|---|
| 路径含中文/空格 | 工程真实路径是 `D:\AI Dsh\车机项目\iCarOBD2`。`gradle.properties` 里已设 `android.overridePathCheck=true` 放行构建 |
| **单测必须走脚本** | **不要**在原路径直接 `./gradlew testDebugUnitTest`（JVM 启动器用 ANSI 代码页解码 `-cp`，中文路径被解坏，全部报 `ClassNotFoundException: <测试类自身>`）。用 `tools/run-tests.ps1`（它建 ASCII 联接 `D:\icarobd` 再跑） |
| `run-tests.ps1` 的 `TOTAL=` | 读的是磁盘上的 `app/build/test-results/*.xml` —— 换了机器/拷了 `app/build` 时它可能报的是**上一次**的数字（见 [交接-换电脑.md](交接-换电脑.md)） |
| 只改样式（无 Kotlin 改动） | 仍然要 `assembleDebug` —— 资源编译进 APK，没有"热加载" |

### 6.3 ⚠️「改了会出事」清单

| 改动 | 会出什么事 | 为什么 | 依据 |
|---|---|---|---|
| **`activity_main.xml` 根容器**（`FrameLayout` → `LinearLayout`） | 导航栏把画布挤掉；收起/展开导航栏时 `pageContainer` 重新量 → **画布尺寸变化 → 表盘重排 + 闪一下** | 归一化坐标要重新换算成像素，`DashRenderer` 会 `relayout()` 重建所有表盘 | `activity_main.xml:5-9`、`DashRenderer.kt:95-99` |
| **`fragment_dash.xml` 里 `dashPager` 的高度**（`0dp`+`weight=1` → 固定值） | 告警条出现时 pager 不让位 → 画布被顶掉；pager 高度一变 → `gaugeGrid` 尺寸变 → **表盘重排** | 同上 | `fragment_dash.xml:41-51` |
| **`fragment_dash_canvas.xml` 里 `canvasArea` 的 `weight=1`** | 编辑工具条出现/消失会改变画布高度 → 表盘重排 | `editBar` 与 `canvasArea` 是同一个 `LinearLayout` 的兄弟，`editBar` 从 `gone` 变 `visible` 会吃掉 `canvasArea` 的高度 | `fragment_dash_canvas.xml:35-40` / `:195-199` |
| **`gaugeGrid` / `canvasArea` 的任何尺寸相关改动**（加 padding、改 weight、外面再套一层） | **所有表盘按归一化坐标重算 → 表盘重建 + 位置变化 + 闪一下** | `container.addOnLayoutChangeListener` → `relayout()` | `DashRenderer.kt:95-99`、`:259-269` |
| **`tvCanvasName` 的 `layout_gravity` / `padding`** | 只在"还没跑 `applyNameLabel()`"时有效 —— 运行时会被覆盖 | 位置是全局偏好，由 `Store.settings.canvasNamePos` 决定 | `fragment_dash_canvas.xml:235-253`、`DashCanvasPageFragment.kt:260-285` |
| **`navView` 用 `GONE` 隐藏** | 父容器重排（现在因为导航栏已改成悬浮，画布本来就整屏，但这是第二道保险） | 代码用 `translationX/Y` + `alpha` 代替 | `MainActivity.kt:424-461` |
| **`navDivider` 不与 `navView` 同步隐藏** | 屏幕边缘留一条 `divider` 色细条 | v1.20.3 实测：`navView` 平移出去后截图 `x=0/1` 仍是 `RGB(42,53,71)` | `layout-land/activity_main.xml:34-38` |
| **往 `menu/bottom_nav.xml` 加第 7 项** | `IllegalArgumentException` → **手机一启动就崩** | `BottomNavigationView` 硬上限 5，`NavBottomBar` 重写成 6；Material 1.12.0 没有 `setMaxItemCount` | `NavBottomBar.kt:7-46` |
| **把 `MaxWidth*` 放进 ViewPager2 页面根** | 限宽生效但**居中失效**，整页靠左 | `FragmentStateAdapter.addViewToContainer()` 用 `MATCH_PARENT` 覆盖了 `layout_gravity` | `MaxWidthViews.kt:139-146`、`fragment_canvas_settings.xml:10-19` |
| **改 `bg_card` / `bg_input` 的圆角或颜色** | 一次改掉十几个页面/列表行 | 全局共用同一个 drawable | §1.3 |
| **改 `FieldLabel` 的 `paddingTop`** | 所有编辑器的字段纵向节奏一起变 | 公共 style | `themes.xml:36-41` |
| **改 `colors.xml` 的 `text_dim`** | 所有说明小字一起变（含导航未选中图标） | `nav_item_color.xml` 也用它 | §1.4 |
| **为灵动岛/警示条/悬浮条去改 `activity_main.xml`** | 会让 `pageContainer` 变矮 → **画布尺寸变化 → 表盘重排** | 这三者都是挂 `android.R.id.content` 的浮层，**刻意不占布局** | `IslandNotice.kt:34-40`、`MonitorWarnBar.kt:22-30`、`MainActivity.kt:216-221` |
| **把左边缘把手贴到屏幕边** | 每次按它都触发**系统返回手势** | 必须离边缘 **32dp**（大于系统手势热区 20~24dp） | `MainActivity.kt:346-363` |
| **主题编辑器里去掉 `pvCard*` 那层 `FrameLayout`** | 调「卡片描边」「卡片不透明度」时**看不到任何变化** | 卡片底画在 `pvCard*` 上 | `activity_theme_editor.xml:128-133` |
| **改 `activity_pid_editor.xml` 里各 `row*` 容器的 id** | 监听型的"按来源变形"失效（藏不掉/显示不出） | `PidEditorActivity` 按 id 找它们 | `activity_pid_editor.xml:111/161/441/466/582` |

---

## 七、哪些样式已经是可配置的

> **这一节是"不用改代码就能调"的清单。** 分两张表：左 = App 内直接改；右 = 必须改代码 + 重编。

### 7.1 ✅ 可配置（**不用改代码**，App 内改完立刻/下次生效）

| # | 能调什么 | 在哪调 | 取值 | 默认值 | 生效时机 |
|---|---|---|---|---|---|
| 1 | **仪表盘主题**（12 色 + 几何 + 缓动） | 画布设置页「画布主题」→ 主题编辑器 | 内置 3 套 + 用户自建；12 色 + `cardRadiusDp` / `cardStrokeDp` / `cardAlpha` / `strokeDp` / `needleLengthRatio` / `easingMode` / `easingTauMs` / `valueSmoothingMs` | 霓虹赛道（id 0） | 立即（预览）+ 保存后全局 |
| 2 | **单块表的霓虹档位** | 表属性对话框 `spNeon` | 跟随主题 / 关闭 / 克制 / 标准 / 强烈 / 夸张 | 跟随主题 | 确定后 |
| 3 | **单块表的卡片外框** | 表属性对话框 `spCard` | 跟随主题 / 无边框 / 透明 / 不画卡片 | 跟随主题 | 确定后 |
| 4 | **单块表的量程与报警阈值** | 表属性对话框 `etMin` / `etMax` / `etWarnLow` / `etWarnHigh` | 任意数 | 取自 PID 库 | 确定后 |
| 5 | **画布名浮标位置** | 画布设置页「画布名浮标」 | 左上角 / 右上角 / 左下角 / 右下角 / 隐藏 | **左上角** | 切页/重渲染后 |
| 6 | **手势映射** | 画布设置页「手势」 | 4 个方向（双指左/右/上/下滑）× **7 个动作**（无 / 呼出导航 / 收起导航 / 切上一套画布 / 切下一套画布 / 切上一个 tab / 切下一个 tab） | 左滑=**收起导航**、右滑=**呼出导航**、上滑=**下一套画布**、下滑=**上一套画布** | 下一次手势 |
| 7 | **灵动岛样式** | 画布设置页「灵动岛」 | 位置 3 / 尺寸 3 / 圆角 3 / 停留 3 / 配色 2（自定义 = 8 色背景板 + 4 色文字板 + 手打 `#RRGGBB`） | 顶部居中 · 中 · 圆角大（胶囊） · 4 秒 · 跟随主题 | **下一条提示立刻生效**（`show()` 每次现读） |
| 8 | **音效开关** | 连接页 `swSound` / 画布设置页 `swSound` | 开 / 关 | **开** | 当次生效 |
| 9 | **轮询间隔** | 画布设置页「轮询间隔」 | 60 / 80 / 100 / **120** / 150 / 200 / 250 / 300 ms | **120 ms** | 下一次轮询 |
| 10 | **参考线** | 画布设置页「背景 / 设计文件 / 参考线…」 | 开关 / 列数 / 行数 / 线型（实线·虚线·点线） | 关 / 6 列 / 4 行 / 虚线 | 立即 |
| 11 | **吸附开关** | 编辑态工具条 `btnSnap` | 开 / 关 | **开** | 立即（关掉后仍不能拖出画布） |
| 12 | **画布背景图 / 设计文件 / 设计包** | 画布设置页「背景 / 设计文件 / 参考线…」 | 任意图片；`icar.ui/1` `2`；`.icarzip` | 无 | 立即 |
| 13 | **画布套数与管理** | 画布设置页「操作」菜单 | 上限 **8 套**，至少留 1 套 | 1 套「默认」 | 立即 |
| 14 | **每套画布的主题 / 页号 / 类型** | 同上 | 普通 / 性能 / 自定义 | 普通 | 立即 |
| 15 | **油箱容量** | 连接页 `etTankCapacity` | 任意数 | 空（hint 50） | 保存后 |
| 16 | **G 值来源** | 连接页 `spGForce` | 加速度计 / 车速差分 | — | 立即 |
| 17 | **CSV 记录 / 日志镜像 / 行车保持亮屏** | 连接页三个 `MaterialSwitch` | 开 / 关 | 见 `Store.Settings` | 立即 |
| 18 | **规则（条件 / 动作 / 时长 / 冷却）** | 规则编辑器 | 任意 | 内置若干条 | 保存后 |
| 19 | **扫描参数 / 过滤器 / 分段轮换** | 扫描器、CAN 探测页 | 任意 | 间隔 150ms / 超时 1500ms / 重试 1 / 上限 400 | 立即 |

### 7.2 ❌ 必须改代码 + 重编（改完走 §6.2 的 ① ②）

| # | 要改什么 | 改哪里 |
|---|---|---|
| 1 | **任何 UI 色值**（底色/文字/强调/状态/卡片） | `res/values/colors.xml` |
| 2 | **公共字号与内边距**（字段标签、输入框、分区标题、MonoBox） | `res/values/themes.xml` 的 `FieldLabel` / `InputEdit` / `SectionTitle` / `MonoBox` |
| 3 | **卡片 / 输入框 / 横幅的圆角、描边、底色** | `res/drawable/bg_card.xml` / `bg_input.xml` / `bg_banner.xml` |
| 4 | **任何页面控件的尺寸、边距、字号、`weight`、`gravity`** | 对应的 `res/layout/*.xml`（见 §3 / §4） |
| 5 | **各页面的限宽** | 该布局根上的 `app:maxWidthDp`（见 §6.1 的表）；未指定时的默认 720 在 `MaxWidthViews.kt:68` |
| 6 | **导航栏的宽度 / 高度 / 底色 / 图标色** | `res/layout/activity_main.xml` + `res/layout-land/activity_main.xml` + `res/color/nav_item_color.xml` |
| 7 | **导航项的数量 / 名字 / 图标** | `res/menu/bottom_nav.xml` + `res/values/strings.xml`（⚠️ 上限 6，`NavBottomBar.kt:46`） |
| 8 | **灵动岛的"固定"部分**：贴顶留白 10dp、靠边留白 10dp、描边 1dp、入场 180ms、出场 220ms、`+N` 偏移 8dp、`elevation 8dp` | `IslandNotice.kt:219-228`、`IslandCapsuleView.kt:50/82-88` |
| 9 | **监听警示条**：文案、12sp、内边距、底色 `0xF0B3261E`、`elevation 6dp` | `MonitorWarnBar.kt:57-69 / 103` |
| 10 | **模拟悬浮条**：边距 `(0,0,12,88)`、底色 `0xE6101820`、字号、按钮内边距 | `MainActivity.kt:231-287` |
| 11 | **左边缘把手**：宽 18dp / 高 120dp / 边距 32dp / 圆角 9dp / 底色 `0x3DFFFFFF` | `MainActivity.kt:346-379` |
| 12 | **画布表盘间距与卡片内边距**：`CELL_MARGIN_DP = 3f`、卡片 padding 4dp | `DashRenderer.kt:152-153 / 471` |
| 13 | **表盘推值周期**：`REFRESH_MS = 200L`（5Hz） | `DashRenderer.kt:469` |
| 14 | **编辑器的吸附网格 / 最小尺寸 / 手柄大小 / 选中框** | `DashLayout.kt:202-208`、`DashCanvasEditorView.kt:39-40 / 262-275` |
| 15 | **参考线默认值**：6 列 / 4 行 / 虚线 / `0x33FFFFFF` / 1dp / 密度上限 24 | `DashGridOverlayView.kt:32-51`（运行时由 `Store.settings` 覆盖） |
| 16 | **表单自动分栏的阈值与间距**：`twoColumnMinWidthDp=640` / `maxColumns=2` / `columnGapDp=12` / `rowGapDp=2` | `ColumnFlowLayout.kt:37-46` |
| 17 | **模拟页行/滑块/chip 的所有尺寸与字号** | `SimulatorActivity.kt:240-425` |
| 18 | **知识库节标题/正文/标签的字号与行距** | `KnowledgeFragment.kt:151-179` |
| 19 | **探测记录页的颜色与内边距**（**硬编码，不在 colors.xml**） | `ProbeLogActivity.kt:62-208` |
| 20 | **性能基准页的排版** | `BenchActivity.kt:143-207` |
| 21 | **CAN 探测结果行的排版** | `CanSnifferActivity.kt:375-397 / 511-565` |
| 22 | **仪表内部绘制**（圆表刻度/指针/读数位置、条形表比例等） | `ui/view/*GaugeView.kt` + `BaseGaugeView.kt` + `NeonPainter.kt` —— ⚠️ **本表不覆盖** |
| 23 | **内置三套主题的颜色** | `ui/view/GaugeTheme.kt:231-253` |

> 📌 **曾计划从本表移出、现已作废**：**字号 / 间距（padding+margin）/ 横屏导航栏宽度**。
> 原计划是让「实时调参」（`data/UiScale.kt`，规划 v1.20.14）把这三类变成"不用改代码就能调"。
> ⚠️ **那个方向已被用户明确否掉、代码整套撤掉了**（`UiScale.kt` 不存在），
> 所以本表第 2、4、6 项**维持"必须改代码"**，§7.1 不会多那一行。**不要再按旧计划去更新本表。**

---

## 八、拿不准 / 需要现场量的地方

**如实列出 —— 以下这些值我在 XML/代码里找不到权威定义，或者是从别处量出来的。**

| # | 项 | 情况 |
|---|---|---|
| 1 | **竖屏导航栏的实际高度** | `activity_main.xml:48` 的 `layout_marginBottom="80dp"` 是**跟着 `BottomNavigationView` 的默认高度写的常量**，代码里**没有读控件高度**。BottomNavigationView 的高度由 Material 内部（item 高度 + padding）决定，**换 Material 版本或系统字体放大时可能不再是 80dp** → 那条分隔线会不再贴在导航栏上边缘。横屏同理：`minWidth=88dp`（`layout-land:55`）与 `marginStart=88dp`（`:44`）是**两个独立常量，靠人工保持一致**。 |
| 2 | **灵动岛胶囊的实际尺寸** | XML 里**没有** —— 它是 `WRAP_CONTENT`，代码里明确"不许出现具体宽高"（`IslandNotice.kt:195`）。CHANGELOG v1.20.12 记的实测 bounds `[365,154][714,240]`（**宽 349px / 高 86px**）是在**小米平板 5、默认「中」档、系统字体默认**下量的，**不是常量**。改字号/内边距/系统字体缩放都会变。 |
| 3 | **各列表行（`item_*`）的实际行高** | 全是 `wrap_content`，XML 里没有固定值。实际高度取决于 `textSize` × 系统字体缩放 + `padding`。要精确值只能 `uiautomator dump` 量。 |
| 4 | **编辑器底部按钮条的高度** | `wrap_content`（PID 编辑器 / 规则编辑器）。MaterialButton 的默认 `minHeight` 由 Material 主题决定，XML 里没写死。 |
| 5 | **`MaterialSwitch` 的尺寸** | 全部是 `wrap_content`，XML 里没有任何尺寸。 |
| 6 | **`MaterialButton` 的圆角 / 高度 / 内边距** | 全部来自 Material 主题的默认样式（`Widget.Material3.Button.*`），`themes.xml` 里**没有覆盖**。要改就得在 `themes.xml` 里加对应的 `Widget.Material3.Button` 覆盖。 |
| 7 | **`ChipGroup` 里 chip 的样式** | `fragment_knowledge.xml:55-61` 与 `activity_can_sniffer.xml:200-205` 都没有指定 chip 样式 → 用 Material 默认。Chip 是代码 `new Chip(ctx)` 建的，尺寸也在代码里。 |
| 8 | **`Spinner` 下拉项的文字样式** | 由 `android.R.layout.simple_spinner_dropdown_item` 决定（`CanvasSettingsFragment.kt:1367`），**不在本工程资源里**。 |
| 9 | **`alertBanner` 的显示/隐藏逻辑** | 我只在 `DashFragment.kt:80` 找到 `findViewById(R.id.alertBanner)` 和 `DashRenderer.kt:278` 的一句注释提到它；横幅的完整显示时长/触发链**没有逐行读完**（v1.20.12 起规则提示已改走灵动岛，横幅的当前用途需要再确认）。 |
| 10 | **各 `*GaugeView` 内部的字号、线宽、刻度位置** | 全是按 View 尺寸比例在 `onDraw` 里算的（如 `strokeDp` 来自主题、其余按半径比例）。**本表不覆盖** —— 要调请看 `ui/view/*GaugeView.kt` 与 [UI控件清单.md](UI控件清单.md) §一 的 style → View 映射表。 |
| 11 | **`activity_simulator.xml` 里滑块（`SeekBar`）的样式** | 滑块由 `SimulatorActivity.kt` 代码建（`:279` 用 `setColors`），XML 里没有。 |
| 12 | **`MonitorWarnBar` 的实际高度** | `WRAP_CONTENT`（12sp 字 + 上下 4dp padding），代码里**没有固定值** —— 灵动岛的让位偏移是运行时读 `heightPx()` 拿的（`IslandNotice.kt:113-117`），不是常量。 |
| 13 | **`dist/` 里的 APK 命名规则** | `dist/iCarOBD-debug-v<versionName>-android.apk` 是**历史约定**（见 [FILE_MAP.md](FILE_MAP.md) / CHANGELOG），但 `assembleDebug` 本身只输出到 `app/build/outputs/`；**改名并复制到 `dist/` 这一步由发布流程（或人）做**，我没有找到自动化的脚本入口。 |
| 14 | **构建守卫到底核什么** | 我引用的"守卫只核 APK 的名字/体积/ABI"来自 CHANGELOG v1.20.13 的描述，**没有逐行读 `tools/check-build-guard.ps1`**（该文件在 `tools/` 下，本次任务范围不碰）。 |

---

## 附：本表的证据来源

| 类别 | 文件 |
|---|---|
| 布局 | `app/src/main/res/layout/*.xml`（25 个）、`app/src/main/res/layout-land/activity_main.xml` |
| 资源 | `values/colors.xml` · `values/themes.xml` · `values/attrs.xml` · `values/strings.xml` · `values/ids.xml` · `drawable/*.xml` · `color/nav_item_color.xml` · `menu/bottom_nav.xml` |
| 代码 | `ui/view/`（`GaugeTheme` · `MaxWidthViews` · `NavBottomBar` · `IslandNotice` · `IslandCapsuleView` · `MonitorWarnBar` · `DashCanvasEditorView` · `DashGridOverlayView` · `ColumnFlowLayout`）、`ui/dash/`（`DashRenderer` · `DashCanvasPageFragment` · `CanvasSettingsFragment`）、`ui/`（`MainActivity` · `SimulatorActivity` · `KnowledgeFragment` · `ProbeLogActivity` · `BenchActivity` · `CanSnifferActivity` · `ConnectFragment`）、`data/`（`IslandStyle` · `DashLayout` · `DashCanvas` · `Store` · `GestureActions` · `PidModels`） |
| 元信息 | `app/build.gradle.kts`（`versionCode 82` / `versionName 1.20.13`）· `gradle.properties` · `AndroidManifest.xml` · git HEAD `e54e38e` |
