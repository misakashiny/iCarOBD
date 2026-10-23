# P5A-M01 阶段A：App 架构与功能矩阵审计

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-23（Asia/Shanghai）|
| 任务 | `T-ANDROID-P5A-M01` 阶段 A |
| 基线 HEAD | `886be5210d01793c23e6850fe490da7a420c5597` |
| 原则 | **不把静态源码中存在某个类认定为功能完整** |
| 结论 | 阶段 B/C/D/E/F 的**基础设施大部分已存在**（P4F / P5A-M02 / M05 / M06 建立）；本轮真实价值在**验证**与**修缺陷** |

---

## 一、关键类规模（不是"存在"而是"有多少实现"）

| 文件 | 行数 | 职责 |
|---|---|---|
| `data/DesignNode.kt` | 831 | 节点模型 + 字体 + 多态子项 |
| `data/DesignFile.kt` | 613 | `icar.ui/2` 解析 / 导出 / 守卫 |
| `data/PidModels.kt` | 841 | PID 定义 / GaugeItem / TrackStyle / 常量 |
| `data/Store.kt` | 780 | 设置 / PID 库 / 主题目录 |
| `data/ValueLabels.kt` | 58 | 数值 → 文字映射 |
| `ui/dash/NodeTreeRenderer.kt` | 504 | 节点树 → View（含 `computeViewport`）|
| `ui/dash/DashRenderer.kt` | 363 | 仪表盘整体渲染 |
| `ui/view/BaseGaugeView.kt` | 445 | 所有表盘基类（调色板/报警/霓虹）|
| `ui/view/GaugePartsView.kt` | 196 | 子部件叠加层 |
| `ui/view/BarGaugeView.kt` | 142 | 条形表 |
| `ui/view/TrackView.kt` | 256 | 代码绘制轨道 |
| `service/ObdService.kt` | 122 | 前台服务 |
| `obd/ObdController.kt` | 648 | 连接/轮询总控 |
| `obd/ObdEngine.kt` | 392 | 轮询引擎 |
| `obd/VehicleBus.kt` | 299 | 总线（源归属 + TTL + 历史）|

**合计约 5,900 行**只算核心渲染与数据链路。

---

## 二、功能矩阵（按任务要求分五类）

### ① 已实现且有测试

| 能力 | 测试 | 断言数 |
|---|---|---|
| 设计文件解析 / 导出 | `DesignFileTest` | 25 |
| 设计文件异常健壮性 | `DesignFileRobustnessTest` | 19 |
| 设计包（打包/解包）| `DesignPackTest` | 18 |
| 节点深度限制 | `DesignNodeDepthTest` | 6 |
| 节点图片/PID 绑定 | `DesignNodeImagePidTest` | 6 |
| 轨道分派 | `DesignNodeTrackDispatchTest` | 10 |
| 数值守卫（NaN/Inf）| `DesignNumericGuardTest` | 14 |
| 多页面 | `DesignPagesTest` | 7 |
| 表盘色带 | `GaugeBandsTest` | 19 |
| 表盘布局 | `GaugeLayoutTest` | 34 |
| 子部件 | `GaugePartsTest` | 23 |
| 子部件值绑定 | `GaugePartsValueBindingTest` | 16 |
| 状态灯解析 | `NodeStateTest` / `NodeStateResolverTest` | 11 + 20 |
| 部件动画 | `PartAnimTest` | 7 |
| PID 去重 / 草稿 / 合并 | `PidDedupTest` 28 / `PidDraftTest` 27 / `PidMergeTest` 13 | 68 |
| PID 模型 | `PidModelsTest` | 38 |
| 轨道样式解析 | `TrackStyleParseTest` | 14 |
| 请求安全策略 | `PidRequestPolicyTest` | 16 |
| PID 扫描（4 个类）| `PidScanner*` | 41 |
| 总线历史 / 源归属 / TTL | `VehicleBus*` 4 个类 | 42 |
| 轮询引擎 | `ObdEnginePollingTest` | 8 |
| 渲染器视口 | `NodeTreeRendererTest` | 6 |
| 表盘动画 / 缓动 / 主题 | `GaugeAnimatorTest` 19 / `GaugeEasingTest` 14 / `GaugeThemeTest` 36 | 69 |
| **模拟数据源** | `SimScenarioTest` 23 + `SignalSimulator*` 47 + `SimRealMutexTest` 9 | **79** |

**合计 101 个测试类 / 1550 项**。

### ② 已实现但缺测试（本轮发现）

| 能力 | 现状 |
|---|---|
| **`ObdService` 前台服务异常路径** | 🔴 **完全无测试** —— 本轮发现它在 Android 14 缺权限时**崩溃**（见第四节）|
| `SimPidSource.step(n)` | 🔴 **实现有缺陷**（不重新算通道值，改 tick 无效），且无测试（见第四节）|
| 多分辨率适配 | ✅ 有 `verify-p5a01-multires`（设备端 14 断言）但**无 JVM 层** |

### ③ 编辑器支持但 App 尚不支持

| 能力 | 说明 |
|---|---|
| **P5B-M01 的 4 个基元**（arc / pathProgress / valueText / shape）| 仅编辑器原型，**App 侧完全无实现**（任务明确未批准接入）|
| **style 3/4/5/6/7 的编辑器预览** | 本轮 P5B-M01 刚补齐；App 侧本来就有（方向相反）|

### ④ 尚未实现

| 能力 | 说明 |
|---|---|
| 基元的 Android View | 见上，属 P5B-M01 阶段 G 方案范围 |
| 屏幕方向切换的自动恢复验证 | 有代码（`onSaveInstanceState`）但**无专项测试** |

### ⑤ 需要真实 OBD 才能验证

| 能力 | 原因 |
|---|---|
| 真实适配器连接 / 初始化 | 无硬件 |
| 真实 PID 响应解析（尤其 P5A-M06 改的归属判定）| 需真车 |
| 多 ECU 真实响应 | 需真车 |
| CAN 总线探测（`ATMA`）| 需真车 + 适配器 |
| 油温 / 油压 / BOOST / Lambda | **无标准 OBD-II PID**，需车厂 CAN/DBC |

---

## 三、数据链路（本轮重点核实）

```
OBD 设备 ──→ ElmSession ──→ ObdProtocol ──→ ObdEngine.poll() ──→ VehicleBus.put()
                                                                      │
模拟（debug）──→ SimPidSource ──→ SignalSimulator ───────────────────┤
                                                                      ↓
                                                     VehicleBus.get(pid) / TTL / historyOf
                                                                      ↓
                                     NodeTreeRenderer.build() → BaseGaugeView / TrackView / ...
                                                                      ↓
                                                            屏幕
```

**关键点（已核实）**：

- `Store.findPid(id)` 是**纯内存查找**（`allPids().firstOrNull`），**不读总线**
- 所有 View 的值都从 **`VehicleBus`** 取，**不直接读 OBD**
- `SimPidSource` 走的是**同一个 `VehicleBus`**（`SignalSimulator.openSource`）→ **不是第二套渲染通道** ✅
- 模拟与真实**互斥**由 `onRealPollingStarting` 钩子保证（P5A-M05 修）

**这条链路符合任务要求「不建立第二套与生产逻辑不一致的渲染通道」** —— 复用既有架构，未新增旁路。

---

## 四、本轮发现的两个真实缺陷

### 缺陷 1【严重】拒绝蓝牙权限 → App 崩溃

`ObdService.startForegroundCompat()` 在 Android 14+ 调：
```kotlin
startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
```

Android 14 对 `CONNECTED_DEVICE` 要求**双重条件**：
1. manifest 声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE` ✅（已有）
2. **且**持有 `BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN` 之一

用户第一次装 App 点「不允许」→ 条件 2 不满足 → `SecurityException` →
在 `onCreate()` 无人接 → **进程 FATAL**。

**实测复现**：撤销两个蓝牙权限后启动 → crash buffer 出现 **2 条 FATAL**。

### 缺陷 2【中】模拟 `step` 参数无实效

`SimPidSource.step(n)` 原实现：
```kotlin
repeat(n.coerceIn(0, 200)) {
    tick++
    runCatching { SignalSimulator.tick(System.currentTimeMillis()) }
}
```

只递增 `tick` 并重写通道 —— 但**场景通道都是 `WAVE_CONSTANT`（min==max==目标值）**，
重写一次值不变。`applyScenario()` 才负责用新 tick 算通道值，却没被调用。

**实测证据**：`--ei step 0` 与 `--ei step 20` 广播回显**完全一致**（`std_0C=860` 两次相同）。

→ 意味着 `--ei step N` 这个**自动化测试接口一直是空转**。

---

## 五、审计结论

1. **阶段 B（模拟数据源）不需要新开发** —— 11 个场景 + 自定义 PID + ADB 广播接口全在，
   且走的是同一个 `VehicleBus`，符合"不建第二套通道"的要求。**缺的是 step 缺陷修复**。

2. **阶段 C（仪表/状态灯联调）的基础齐备**，但**从未在设备上端到端验证过**
   （`SimScenarioTest` 只测场景值本身，不测"值→屏幕"）。

3. **阶段 D（多分辨率）已有 3 种分辨率的设备端套件**（14 断言），
   实测**形变系数 0.475 / 1.69 / 2.254** —— 这是 `SCALE_STRETCH` 的**已知取舍**，
   `FIT`/`FILL` 可解决，属**兼容性限制不是缺陷**。

4. **阶段 E（导入异常恢复）已被 `DesignFileRobustnessTest` 19 项完整覆盖**，
   11 个场景一个不缺。

5. **阶段 F（长跑）已有 11 分钟套件**。

**所以本轮的开发量集中在：修 2 个缺陷 + 补齐"设备端端到端证据"。**
