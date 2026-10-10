# 架构与维护规则

> 本文回答「为什么这样设计、哪些边界不能跨越」。查找要修改的文件请看
> [FILE_MAP.md](FILE_MAP.md)，接手项目与真实设备验证请看
> [HANDOVER.md](HANDOVER.md)。

## 1. 分层与依赖方向

依赖只能从上往下，不能反向。

```text
ui/
  MainActivity、Fragment、Editor Activity、adapter/、dash/、view/
       │ 读 VehicleBus；写 ObdController（车辆操作的唯一入口）
       ▼
obd/
  VehicleBus、ObdController、ObdEngine、RuleEngine、ObdProtocol、
  PidScanner、ElmSession
       ▼
ble/
  BleTransport（只管收发字节）
       ▼
data/
  模型、公式、内置 PID、持久化、日志、CSV、音效、默认配置
```

`service/ObdService` 只依赖 `obd/` 与 `data/`，不依赖 `ui/`。
`ui/view/` 和 `ui/dash/` 只依赖 `data/PidModels`、`obd/VehicleBus`、
`obd/RuleEngine`；它们不认识 BLE、ELM327 或公式。

## 2. 关键数据链路与排障

```text
BLE → BleTransport → ElmSession → ObdEngine → ObdProtocol
    → VehicleBus → RuleEngine / DashRenderer / CsvRecorder
```

| 现象 | 优先检查 | 对应日志模块 |
|---|---|---|
| 扫不到或连不上设备 | BLE 权限、扫描、GATT 服务与特征 | `BLE` |
| **连上了但所有 AT 命令都超时** | **看自动转储的 GATT 表**：写特征的 `props` 是否有 `Wn`/`W`、写类型是否被接受 | `BLE` |
| 初始化或请求超时 | 串行请求、协议协商、原始响应 | `OBD` |
| 已收到响应但数值异常 | `ObdProtocol.extractData`、PID 公式 | `OBD`、`DATA` |
| 仪表不刷新 | `VehicleBus` 是否有值、仪表绑定的 channel | `DATA`、`UI` |
| 规则不触发 | 数据源启用状态、阈值与持续时间 | `RULE` |
| CSV 没有记录 | 记录开关、存储权限与文件路径 | `DATA` |
| **日志页崩溃 / 日志文件异常大** | 环形缓冲溢出通知是否成对、是否有单点刷屏 | 见下方 |

### 2.1 实车踩过的两个坑（v1.3.0 修复，务必先读）

**① 「连上了但一个字节都收不到」** —— 2026-10-02 上车实测，
`ATZ/ATE0/…/0100` 全部超时。原因是 `BleTransport` 把写类型写死成
`WRITE_TYPE_DEFAULT`，而该适配器（`IOS-Vlink`，服务 `18F0`/写 `2AF0`/通知 `2AF1`）
的写特征只支持 write-without-response，于是 `writeCharacteristic()` 永远返回 false。

现在的对策：**连接后自动把整张 GATT 表写进日志**（`dumpGattTable()`），
包含每个特征的 `properties` / `writeType` / descriptor 数量。
排查这类问题**第一步永远是看这张表**，不要靠猜 UUID。

**② 「日志页崩溃 + 日志文件 57MB」** —— 两个独立缺陷：
- `LogAdapter` 环形缓冲满 3000 后是「挤掉队首 + 追加队尾」，
  但只发了 `notifyItemInserted`。RecyclerView 的位置表因此持续漂移
  （2999 → 3049 → 3084），最终抛 `Inconsistency detected`。
  **缓冲区溢出时必须成对通知**（`notifyItemRemoved(0)` + `notifyItemInserted(last)`）。
- BLE 写入失败进入了无限重试并逐次写日志，2 小时刷出 113 万行 / 57.9MB，
  占全部日志的 99.9%。现在 `AppLog` 有四条自我保护：
  重复消息抑制、单日文件上限、落盘队列有界、监听器批量派发。
  **这四条不可移除** —— 任何一处单点刷屏都曾把整个日志系统拖垮。

## 3. 横竖屏自适应

| 方向 | 布局 | 导航控件 |
|---|---|---|
| 竖屏 | `layout/activity_main.xml` | `BottomNavigationView` |
| 横屏 | `layout-land/activity_main.xml` | `NavigationRailView` |

两者共用 `navView` id，且都继承 `NavigationBarView`；新增导航项只需改
`menu/bottom_nav.xml`。

**仪表盘布局与方向无关**（v1.5.0 起）：位置尺寸用**归一化坐标**（`GaugeItem.x/y/w/h`），
同一份配置在竖屏与横屏都成立，所以仪表盘**不再按方向切换列数**。
旧版那套（`DashRenderer.columnCount()` / `GaugeItem.span` / `MAX_SCALE` /
`NestedScrollView`）**已废弃**，见 §6。

**导航控件才按方向切换**：竖屏底部 `BottomNavigationView`，横屏左侧 `NavigationRailView`
—— 横屏垂直像素只有竖屏的 62%（1600 vs 2560），底部导航要吃掉约 8% 屏高。

宽屏表单用 `MaxWidthViews.kt` 居中限制在 720–900dp：表单页用
`MaxWidthScrollView`，嵌套滚动页用 `MaxWidthNestedScrollView`，列表根布局用
`MaxWidthLinearLayout`，非滚动内容用 `MaxWidthLayout`。

旋转会重建 Activity；连接和轮询驻留在 `ObdController` 单例中，当前页面由
`MainActivity` 保存恢复。`switchTo()` 必须保持 `commitNow()`，避免快速切换时重复添加 Fragment。

## 4. 不可跨越的边界（**唯一权威清单**）

> ⚠️ **这份清单只在本文件维护。** `接手大纲.md` §6 与 `HANDOVER.md` §14
> 只做索引与补充说明，**不再重复列出条目**。
>
> 历史上这份清单曾在两处各写一份，结果分叉成「一处 7 条、另一处 12 条」，
> v1.1.0 新增的横屏约束只写进了其中一份。**新增/修改红线请只改这里。**

### 4.1 架构边界

1. UI 不得直接创建 `BleTransport`；车辆操作统一经过 `ObdController`。
   否则两条 GATT 连接会互相抢响应。
2. 不得绕过 `ElmSession.request()`；其 Mutex 是 ELM327 半双工串行化的唯一保证。
3. 不得给 `ObdEngine` 加并发请求；提速只能调整轮询间隔。
4. 不得放松 `PidScanner` 的限流、总量上限或危险模式拦截；Mode 04 会清除故障码。
5. 不得向 `DashRenderer`、`BaseGaugeView` 添加数据采集逻辑；
   渲染层只接收「已计算好的数值 + 可选覆盖色」。这是本项目最值得保留的设计。
   **报警状态也只有一处**：`BaseGaugeView.alertLevel`（v1.10.1 起）。
   曾经并存过一个 `warn: Boolean`（含下限、用于选色）与 `alertLevel`
   （只认上限、用于爆闪），两者重叠但不相等，加一档报警要改 7 个视图。
   现在颜色统一走 `alertColor()` / `valueTextColor()`，**不要再引入第二个报警布尔**。
6. 改动 `PidDefinition`、`Rule`、`GaugeItem` 字段时，必须同步 JSON 的
   `toJson` / `fromJson`，并考虑旧配置迁移；**同时同步
   `tools/icarui/index.html`**（否则 PC 端编辑器与 App 的校验会分叉）。
7. `GaugeTheme` 必须留在 `ui/view/`；放到 `ui/dash/` 会让底层绘制层反向依赖上层编排层。

### 4.2 UI 与自适应

8. 不得在 `GridLayout` 用高度 `weight`（`NestedScrollView` 内高度无界会塌成 0）。
9. 仪表内字号一律按视图尺寸取比例，不写死 sp（否则平板放大后「大表配小字」）。
10. 不得给任何 Activity 加回 `android:screenOrientation="portrait"`。
11. 不得改 `navView` 这个 id，也不得只改其中一个方向的布局；
    `layout/` 与 `layout-land/` 靠同名 id + 共同基类 `NavigationBarView` 才做到零分支。
12. `MainActivity.switchTo()` 必须保持 `commitNow()`；
    `commit()` 是异步的，会产生重复 Fragment。
13. 宽屏限宽不得用 `layout-land` 副本实现，统一走 `MaxWidthViews.kt`；
    复制 XML 会让后续改字段时两处不同步。

### 4.3 数据与日志

14. 不得移除 `AppLog` 的四条自我保护（重复抑制 / 文件上限 / 队列有界 / 批量派发），
    也不得在循环里逐次写日志 —— 实车上曾因此 2 小时刷出 113 万行 / 57.9MB。
15. RecyclerView 适配器做环形缓冲时，**移除与插入必须成对通知**；
    只发插入会让位置表漂移并抛 `Inconsistency detected`（实车复现两次）。

### 4.4 BLE

16. 特征选择必须校验 `properties`，不能只比对 UUID；
    写类型要在 `WRITE_TYPE_NO_RESPONSE` 与 `WRITE_TYPE_DEFAULT` 之间自适应。
17. **GATT 操作必须串行化 —— 同一连接同时只允许一个未完成操作。**
    这条是 2026-10-06 用**一轮实车日志**换来的：`requestMtu(512)` 与
    `writeDescriptor(CCCD)` 背靠背发出（相隔 12ms），描述符写的回调**再也没回来** →
    栈上永远挂着一个未完成操作 → **之后每一次 `writeCharacteristic()` 都返回 false**。
    症状是「连上了、通知也能收、但一个字节都发不出去」，一小时刷出 902 条
    「写入被拒」而**零有效数据**。

    **判据**：日志里必须有 `CCCD 写入完成 | status=0`。没有它 = 栈已卡死，
    此时**唯一有效的动作是断开重连**，继续写毫无意义。

    **两个具体禁令**：
    - `requestMtu` 之后**不能**紧接着 `writeDescriptor` —— 要在 `onMtuChanged` 里再开通知
    - 超时兜底**必须用显式的 `pending` 标志**做判据，
      **不能拿 `state == DISCOVERING` 代替** —— 前者会被另一个回调先改掉，
      兜底就变成**永不触发的死代码**（我们正是这么静默失效的）

### 4.5 其他

18. `settings.gradle.kts` 的阿里云镜像是当前网络环境的构建前提，不能删除。
19. `AppLog` 的模块常量是 `M_XXX`（`M_RULE` 不是 `RULE`）。
20. 不得把仪表盘布局改回「网格 + `span` + 高度 `weight`」：v1.5.0 起是
    **归一化自由画布**（`GaugeItem.x/y/w/h`），网格那套（自然高度 / `MAX_SCALE` /
    `NestedScrollView`）已废弃，见 §6。
21. 样式 → View 的映射只能写在 `ui/view/GaugeViewFactory.kt` 一处；
    渲染器与拖拽编辑器都调它，**分两处写必然分叉**（编辑器看到的与实际渲染的不一致）。
22. **性能判据只能是帧间隔，不能是 `DrawStats` 的每帧耗时。**
    开了硬件加速后 `onDraw` 只是把绘制指令**记录**进 DisplayList，
    真正的光栅化在**渲染线程**上做 —— `DrawStats` 量的是"记录耗时"，不是绘制成本。
    拿它下结论会得出过于乐观的答案（v1.10.1 差点这么干）。
    基准入口：连接页 →「运行选项」→「性能基准」，报告在 `files/bench-dashboard.txt`。
23. **设计文件（`icar.ui/1`）的校验规则必须与 `tools/icarui/index.html` 保持同源。**
    两边分叉的后果是「编辑器说没问题、App 加载报错」，而用户直到推上设备才发现。
    改任何一边都要改另一边，`ThemeStudioSampleTest` 会守住这条。

## 5. 维护约定

- 新增、删除或重命名文件后，更新 [FILE_MAP.md](FILE_MAP.md)。
- 变更架构边界、数据流或扩展机制后，更新本文。
- 每次发版在 [CHANGELOG.md](CHANGELOG.md) 记录版本、日期、验证方式和遗留问题。
- 新工具脚本放在 `tools/`，并登记到文件大纲。
- **改了渲染层或动画后重跑性能基准**（红线 21）。
- **改了 `GaugeItem` / `DesignFile` 字段后同步主题工具**（红线 22）。

## 6. 仪表盘渲染与布局（v1.5.0 起：自由画布）

> **这一节替代了 v1.4.0 及以前「网格 + span + 自然高度等比放大」那一套。**
> 如果你在别处看到「自然高度 186/92/54」「`MAX_SCALE` 2.2」「不要改成 weight」，
> **那是已废弃的描述** —— 现在既没有网格，也没有等比放大。

### 6.1 坐标系：归一化 0..1

`GaugeItem` 用 `x/y/w/h`（**归一化 0..1**，y 向下）描述位置与尺寸。

为什么不存像素：归一化坐标**与分辨率、横竖屏都无关**，同一份布局配置在手机竖屏与
平板横屏上都成立，不需要为每个方向存一套。像素换算只发生在 `DashRenderer.render()`。

### 6.2 渲染流程

```text
DashSpec.build(type)            → List<GaugeItem>
DashRenderer.render(spec, theme)
  ├─ applyOverlay(theme)        → 参考线覆盖层（z 序最底，永远盖不住仪表）
  ├─ 每个 item：
  │    ├─ GaugeViewFactory.create(ctx, style)    ← 样式→View 的【唯一】映射处
  │    ├─ view.bind(item, pid, theme, extras)    ← 副参数定义也在这里传进去
  │    └─ FrameLayout.LayoutParams(w*cw, h*ch) + margin
  └─ pushValues()  5Hz
       ├─ updateMulti(values, override)          ← 主参数 + 副参数一次取齐
       └─ 若 wantsHistory：updateHistory(...)    ← 只有趋势图要，避免无谓拷贝
```

### 6.3 为什么不再需要滚动容器

旧网格的高度是「自然高度 × 缩放」，内容可能超出视口，所以套了 `NestedScrollView`。
归一化坐标**天然铺满视口**，所以 v1.5.0 去掉了滚动容器，画布就是 `match_parent` 的
`FrameLayout`。

### 6.4 参考线

`DashGridOverlayView` 是画布的**第一个子 View**。开关、密度（列 × 行）、
样式（实线 / 虚线 / 点线）、透明度都存在 `Store.settings` 里。

> ⚠️ 它的属性叫 `linesEnabled` 而不是 `enabled` —— 后者与 `View.setEnabled`
> 撞 JVM 签名，编译期直接报 `Accidental override`。

### 6.5 多数据显示与历史

- 主参数 = `GaugeItem.pidId`，副参数 = `GaugeItem.extraPids`，`allPidIds()` 给出全部。
- **数值由渲染层推给视图**（`updateMulti`），视图**不读总线** —— 见红线 4.1.5。
- 趋势历史同理：`VehicleBus` 维护**有界环形缓冲**（150 点 ≈ 30 秒），
  只有 `ok` 且非 NaN 的值入历史（否则曲线会被无效值打断成锯齿）。

### 6.6 布局迁移与拖拽数学

- v1.4.0 及以前的 `dash.json` 只有 `span`（2 列网格语义）。`GaugeItem.fromJson` 读到
  缺 `x/y/w/h` 的条目会把 `legacyGrid` 置位，由 `DashLayout.migrateFromGrid()`
  **一次性迁移并回写**（行高按该行最高样式的自然高度占比还原）。
- 拖拽编辑器的坐标运算（吸附 / 夹取）是**纯函数** `DashLayout.Drag`，可单测。
  边界夹取用精确值 `1-size` 而不是吸附值 —— 贴边时允许不在网格上，
  但**绝不溢出画布**（这是刻意的取舍）。
