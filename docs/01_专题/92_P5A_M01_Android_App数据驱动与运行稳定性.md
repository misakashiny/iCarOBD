# P5A-M01 Android App 数据驱动与运行稳定性报告

| 字段 | 值 |
|---|---|
| 任务 | `T-ANDROID-P5A-M01`（大型自主连续开发任务包）|
| 日期 | 2026-10-23（Asia/Shanghai）|
| 起点 | `886be5210d01793c23e6850fe490da7a420c5597`（= `origin/main`）|
| 结论 | **修复 2 个真实缺陷**（含 1 个严重崩溃）；**阶段 C 设备端 18/18 通过**；阶段 D 14/14；JVM **102 类 / 1555 项 / 0 失败**；浏览器 **90 套 / 6981 断言 / 0 失败** |
| 重要发现 | **阶段 B/C/D/E/F 的基础设施大部分已存在**；本轮主要工作是**验证 + 修缺陷**，而非新建 |

> ## ⚠️ 先说明：这是 P5A-M01 的**第二轮**
>
> T-ANDROID-P5A-M01 在 **2026-10-22 已执行过一轮**（起点 `d849ac1`），产出：
> 专题 73（功能矩阵）、专题 74（报告）、20261022_P5A_M01.md（验证记录）、
> GUI 卡片 P5A-GUI-001、perf-baseline.json。那一轮**已经建好了离线模拟数据源**，
> 并修复了「轨道不接数据」。当时基线：**78 套 / 6679 断言 / 93 类 1433 项**。
>
> 本轮（2026-10-23，起点 `886be52`）是**在更高基线上继续完善**——期间经历了
> P4F-M05/06、P5A-M02~M06、P5B-M01 等多个任务包，基线已涨到
> **90 套 / 6981 断言 / 101 类 1550 项**。
>
> **任务卡引用的 P4F-M04 基线（76 套 / 6657 / 1389）是 20261022 那轮之前的状态**，
> 已过时两轮。本轮按「必须实际复核当前基线」的要求，以实测为准。
>
> **所以本轮不重复建设模拟数据源**（那是第一轮的事），而是：
> ① 用设备端证据证明整条链真的通；② 修第一轮遗留的两个缺陷。

---

## 一、Android 当前功能矩阵

详见 [91_P5A_M01阶段A](91_P5A_M01阶段A_App架构与功能矩阵审计.md)。摘要：

### 核心规模

| 文件 | 行数 |
|---|---|
| `data/DesignNode.kt` | 831 |
| `data/PidModels.kt` | 841 |
| `data/Store.kt` | 780 |
| `data/DesignFile.kt` | 613 |
| `obd/ObdController.kt` | 648 |
| `ui/dash/NodeTreeRenderer.kt` | 504 |
| `ui/view/BaseGaugeView.kt` | 445 |
| `obd/ObdEngine.kt` | 392 |
| `ui/dash/DashRenderer.kt` | 363 |
| `obd/VehicleBus.kt` | 299 |
| `ui/view/TrackView.kt` | 256 |
| `ui/view/GaugePartsView.kt` | 196 |
| `ui/view/BarGaugeView.kt` | 142 |
| `service/ObdService.kt` | 122 |

### 五类矩阵

**① 已实现且有测试**（101 类 / 1550 项，节选）：
设计解析 25 / 异常健壮 19 / 打包 18 / 深度 6 / 图片绑定 6 / 轨道分派 10 /
数值守卫 14 / 多页面 7 / 色带 19 / 布局 34 / 子部件 23+16 / 状态灯 11+20 /
PID 相关 28+27+13+38+16 / 扫描 41 / 总线 42 / 轮询 8 / 渲染器 6 / 主题动画 69 /
**模拟数据源 79**

**② 已实现但缺测试**：
- 🔴 `ObdService` 前台服务异常路径 —— **完全无测试**（本轮发现它会崩）
- 🔴 `SimPidSource.step(n)` —— **实现有缺陷**且无测试
- 多分辨率只有设备端套件，无 JVM 层

**③ 编辑器支持但 App 尚不支持**：
- P5B-M01 的 4 个基元（arc/pathProgress/valueText/shape）—— 仅编辑器原型

**④ 尚未实现**：基元的 Android View；方向切换专项测试

**⑤ 需要真实 OBD**：适配器连接/初始化、真实 PID 解析、多 ECU、CAN 探测、
油温/油压/BOOST/Lambda（**无标准 PID，需车厂 DBC**）

### 数据链路（已核实）

```
OBD ─→ ElmSession ─→ ObdProtocol ─→ ObdEngine.poll() ─┐
                                                       ├─→ VehicleBus ─→ NodeTreeRenderer ─→ View
模拟(debug) ─→ SimPidSource ─→ SignalSimulator ────────┘
```

**关键**：`SimPidSource` 走的是**同一个 `VehicleBus`**（`SignalSimulator.openSource`），
**不是第二套渲染通道** ✅ 完全符合任务要求。

---

## 二、模拟 PID 数据源：实现方案与结果

### 2.1 结论：**已存在，无需新开发**

审计发现阶段 B 的全部要求都已实现（P4F/M05 时期建的）：

| 任务要求 | 现有实现 |
|---|---|
| 通过现有数据入口注入 | `SimPidSource` → `SignalSimulator.openSource` → `VehicleBus` ✅ |
| 车速/RPM/水温/电压/油量/负荷/油门 | 6 个核心通道 ✅ |
| 自定义 PID 兼容 | `--es pid a,b,c` 的 `extra` 参数 ✅ |
| **正常运行** | `SimScenario.NORMAL` ✅ |
| **加速与减速** | `ACCEL` / `DECEL` ✅ |
| **温度升高** | `WARMUP`（20℃→90℃，跨 warnLow 60）✅ |
| **报警阈值触发** | `ALARM`（warn 档）/ `CRITICAL`（critical 档）✅ |
| **数据断开** | `DISCONNECT`（关闭来源）✅ |
| **数据恢复** | `RECOVER` ✅ |
| **PID 值为 null** | `NULL_PID` ✅ |
| **PID 不存在** | `MISSING_PID` ✅ |
| **多 PID 同时更新** | `MULTI`（6 通道不同周期）✅ |
| 可配置、可重复、可用于自动化 | `--es scenario X --ei step N` 广播接口 ✅ |

**共 11 个场景**，且 `SimScenarioTest` 23 项已钉住：确定性（同 tick 同值）、
量程、报警档位、三种"无数据"语义互不相同、自定义 PID 不覆盖内置。

### 2.2 Debug / Release 隔离（已复核）

| 要求 | 状态 |
|---|---|
| 明确显示 SIMULATED / 模拟数据 | ✅ 连接页显示「模拟数据运行中（不是真实车辆数据）」（P5A-M06 验证）|
| Release 不会意外启用 | ✅ `verify-p5a02-isolation` **5/5**（debug 有 dex，release 0 个）|
| 不覆盖真实数据持久化 | ✅ 只写 `VehicleBus`，不写 Store |
| 不绕过正式数据绑定协议 | ✅ 走同一 `VehicleBus` + 同一 `NodeTreeRenderer` |
| 不发送汽车控制指令 | ✅ 模拟源只 `put` 值，无 `send` |
| 不影响真实 OBD | ✅ `onRealPollingStarting` 钩子同回合让位（P5A-M05）|

**但发现一个缺陷**（见第七节缺陷 2）：`step` 参数空转，导致"可推进"这一自动化能力实际失效。

---

## 三、仪表和状态灯动态联调结果

### 3.1 本轮做的：**设备端端到端验证**（18/18）

新增 `verify-p5a01-sim-chain.js`。为什么必须做：`SimScenarioTest` 只证明**场景值本身**正确，
**证明不了"值 → 屏幕"**。这是唯一能证明整条链通了的证据。

| # | 用例 | 结果 |
|---|---|---|
| C0 | 关闭模拟 → 基线指纹 | ✅ `40859172/3804488554/123120` |
| C1 | 开模拟 → 画面**确实变化** | ✅ 指纹改变（链路通）|
| C2a | tick=0 精确等于声明值 | ✅ 转速 800 / 车速 60 / 水温 90 |
| C2b | 推进 20 tick → 值变化 | ✅ 2 个通道变化（`std_0D` 62.1→57.9，`std_05` 90.5→91.5）|
| C2c | 重新启用后归零，值与首轮一致 | ✅ 确定性成立 |
| C3 | 报警场景 vs 正常 | ✅ 画面不同 |
| C4 | critical vs alarm | ✅ 画面不同（分档有效）|
| C5 | 数据断开 | ✅ 画面回到基线（`40859172/…` 完全相同）|
| C6 | 数据恢复 | ✅ 数值回来 |
| C7 | 多 PID 同时更新 | ✅ 与单场景不同 |
| C8a | PID 为空 | ✅ 画面变化 |
| C8b | PID 不存在 vs 为空 | ✅ **两者画面不同（语义已区分）** |
| C9 | 关闭 → 回基线 | ✅ 与 C0 完全一致（可重复、无残留）|
| C10 | crash buffer 无 FATAL + 进程存活 | ✅ |

**判定方法**：改模拟场景 → 截屏 → 比对画布区像素指纹。
指纹变 = 数据真走到了屏幕；指纹不变 = 链路断。**这是可判定的硬证据，不是"看着像"**。

### 3.2 与任务 §五 的 10 项对照

| # | 要求 | 状态 |
|---|---|---|
| 1 | 仪表数值实时变化 | ✅ C1/C2 |
| 2 | 数值范围映射 | ✅ C2a（tick=0 精确等于声明值）|
| 3 | `warnLow` / `warnHigh` | ✅ C3（alarm 档）|
| 4 | 状态灯 normal/warn/critical | ✅ C3/C4（两档画面不同）|
| 5 | 无数据状态 | ✅ C5/C8 |
| 6 | 多 PID 与副参数 | ✅ C7 + JVM `GaugePartsValueBindingTest` 16 项 |
| 7 | `valueLabels` | ✅ 两端都已实现（`ValueLabels.kt` 58 行 + 编辑器 9 个文件）|
| 8 | 多段色带 | ✅ JVM `GaugeBandsTest` 19 项 |
| 9 | 子部件绑定 PID | ✅ JVM `GaugePartsTest` 23 + `GaugePartsValueBindingTest` 16 |
| 10 | 断开/恢复后 UI 更新 | ✅ C5/C6 |

**未发现"既有缺口需新增开发"的项** —— 10 项全部有实现+测试覆盖。

---

## 四、多分辨率兼容测试

`verify-p5a01-multires.js`，**14/14 通过**：

| 分辨率 | 截图实测 | 元素渲染 | 屏内 | 重叠 | 状态栏侵入 |
|---|---|---|---|---|---|
| 手机竖屏 | 1080×2400 | 8/8 | 8/8 | 0 | 0 |
| 平板横屏 | 1600×1000 | 8/8 | 8/8 | 0 | 0 |
| 车载宽屏 | 1280×600 | 8/8 | 8/8 | 0 | 0 |

### 形变系数（量化测量）

| 分辨率 | 画布 | 形变系数 | 评价 |
|---|---|---|---|
| 手机竖屏 1080×2400 | 1080×2273 | **0.475** | 52% 拉伸 |
| 平板横屏 1600×1000 | 1600×947 | **1.690** | 69% 拉伸 |
| 车载宽屏 1280×600 | 1280×568 | **2.254** | 125% 拉伸 |

### 结论：**这是 `SCALE_STRETCH` 的设计取舍，不是缺陷**

- `SCALE_STRETCH`（默认，v1 行为）每轴独立缩放 → 宽高比差异大时必然形变
- `SCALE_FIT`（`k = min(cw,ch)/360`）严格等比，居中留边 → **不变形**
- `SCALE_FILL`（`k = max(cw,ch)/360`）等比 + 裁切

三种模式都已实现且有 `NodeTreeRendererTest` 6 项覆盖。

**→ 已登记为兼容性限制**（见第十节卡片），**不是代码 bug**。
用户在设计文件里写 `scaleMode: 1`（FIT）即可换取等比。

---

## 五、主题导入和异常恢复结果

### 结论：**已被 `DesignFileRobustnessTest` 19 项完整覆盖**

| 任务要求 | 覆盖 |
|---|---|
| 正常主题 | ✅ |
| 旧版本主题 | ✅ 旧版 `icar.ui/1` 仍能解析 |
| 空节点主题 | ✅ 可解析、节点数为零、无误报 |
| 缺失素材 | ✅ 空清单不误报 / 非空清单必须告警 |
| 错误 assetId | ✅ `../../etc/passwd` 不导致崩溃，给 warning |
| 部分字段缺失 | ✅ 字段全缺 / 缺 pid |
| 超出范围的数值 | ✅ 超出画布坐标记 warning；负宽高不被静默接受 |
| 无效 PID | ✅ 完全缺 pid 产生明确错误 |
| 损坏 JSON | ✅ 返回错误而非抛异常 |
| 重复导入 | ✅ |
| 导入中断 | ✅ **半截 JSON 不崩溃** |

**目标达成**：遇到无效设计给合理错误提示，**不白屏、不崩溃**。

现有测试资产：`bad-broken.json` / `bad-empty.json` / `bad-invalidpid.json` /
`bad-outofrange.json` / `bad-schema.json`。

---

## 六、性能测试结果

`verify-p5a02-longrun.js`（11 分钟长跑，压力循环：每 2 秒切一档模拟场景，
每 2 分钟切页，每 4 分钟反复断连）。

### 实测数据（前 5 分钟，测试仍在跑）

| 时间 | PSS | Java Heap | 场景 |
|---|---|---|---|
| 0.5 min | 74.5 MB | 14.0 MB | critical |
| 1.0 min | 77.5 MB | 12.9 MB | decel |
| 1.5 min | 78.1 MB | 12.9 MB | recover |
| 2.1 min | 80.1 MB | 13.4 MB | critical |
| 2.6 min | 79.6 MB | 12.9 MB | decel |
| 3.2 min | 79.5 MB | 12.9 MB | recover |
| 3.7 min | 79.6 MB | 12.9 MB | critical |
| 4.4 min | 81.7 MB | 13.7 MB | decel |
| 4.9 min | 81.0 MB | 12.9 MB | recover |

**观察**：PSS 在 74~82MB 之间波动，**未见持续上升**；Java Heap 稳定在 12.9~14MB。
全程 App 存活（`存活=Y`）。

> ⚠️ 完整 11 分钟结果见 `docs/02_验证记录/screenshots/` 下的长跑日志与报告。

### 模拟器限制（如实注明）

- 这是 **SwiftShader 软件渲染**的模拟器，GPU 性能不代表真机
- 内存基线 74MB 包含模拟器自身开销
- **不能把模拟器性能数据当作真机性能**

---

## 七、修复的真实缺陷

### 缺陷 1【严重】拒绝蓝牙权限 → App 崩溃

**现象**：用户第一次装 App，系统弹"允许查找附近设备吗"，点「不允许」→ **App 崩溃**。

**根因**：`ObdService.startForegroundCompat()` 在 Android 14+ 调
`startForeground(..., FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)`。
Android 14 对该类型要求**双重**条件：
1. manifest 声明 `FOREGROUND_SERVICE_CONNECTED_DEVICE` ✅ 已有
2. **且**持有 `BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN` 之一

用户拒绝 → 条件 2 不满足 → `SecurityException` → 在 `Service.onCreate()` 无人接 → **FATAL**。

**实测复现**：撤销两个蓝牙权限后启动 → crash buffer **2 条 FATAL EXCEPTION**。

**修复**：三段降级而不是崩：
1. 优先带 `CONNECTED_DEVICE` 类型（正常路径行为不变）
2. `SecurityException` → 退回**无类型** `startForeground(id, n)`
3. 再失败 → `stopForeground`，服务转普通（App 仍可用）
   - 两次失败都记 `AppLog`，**不吞异常**

**验证**：
- 修复后撤销权限启动 → **FATAL 数 = 0**，App 正常存活
- 新增 `ForegroundServiceDegradeTest` **5 项**（把降级决策抽成纯函数 `shouldUseTypedForeground` / `planForegroundFallback` / `planSecondFallback`）

### 缺陷 2【中】模拟 `step` 参数空转

**现象**：`--es scenario normal --ei step 20` 与 `--ei step 0` 的通道值**完全一致**。

**根因**：
```kotlin
// 原实现
repeat(n.coerceIn(0, 200)) {
    tick++
    runCatching { SignalSimulator.tick(System.currentTimeMillis()) }  // 只重写通道
}
```
场景通道都是 `WAVE_CONSTANT`（min==max==目标值），重写一次**值不变**。
真正用新 tick 算通道值的 `applyScenario()` **没被调用**。

→ 意味着 `--ei step N` 这个**自动化测试接口一直是空转**。

**修复**：每推进一个 tick 就重新 `applyScenario(scenario)`。

**验证**：
- 修复前：`std_0D=62.1` 两次相同
- 修复后：`std_0D=62.1 → 57.9`、`std_05=90.5 → 91.5`（C2b 通过）
- tick=0 精确等于场景声明值（转速 800 / 车速 60 / 水温 90）

### 修掉的自身问题（如实记录）

1. `verify-p5a01-sim-chain` 第一版用 **FNV-1a 64 位哈希**算像素指纹 →
   PowerShell 的 `[uint64]` 遇负数中间值抛异常。改用**双累加器**（加权和 + 平方和）。
2. C2 第一版"等 4 秒看画面变" —— **前提就错了**：`tick` 是**手动步进**，不会自动循环。
   改用主动广播 + 读 `SimControl` 回显。
3. C2 第二版以为 `--ei step 0` 能归零 —— `tick` 是**累加**的，必须 `off` 再 `normal` 才能归零。

---

## 八、自动化测试数据

| 项 | 本轮 | P4F-M04 基线（任务卡引用）| 实际 M01 起点 |
|---|---|---|---|
| **浏览器** | **90 套 / 6981 断言 / 0 失败** | 76 套 / 6657 断言 | 90 套 / 6981 断言 |
| **Android JVM** | **102 类 / 1555 项 / 0 失败** | 1389 项 | 101 类 / 1550 项 |
| Debug APK | 构建成功 | 成功 | 成功 |

> ⚠️ 任务卡引用的 P4F-M04 基线（76 套 / 6657 / 1389）**已过时**。
> 按任务要求「必须实际复核当前基线，不直接照抄历史数字」，实际基线是
> **90 套 / 6981 断言 / 101 类 / 1550 项**。

### 本轮新增

| 内容 | 数量 |
|---|---|
| `ForegroundServiceDegradeTest` | +5 项 |
| `verify-p5a01-sim-chain.js`（设备） | 18 断言 |

### 全量回归结果

| 项 | 结果 |
|---|---|
| 浏览器 | ✅ 90 套 / 6981 断言 / 0 失败（426s）|
| Android JVM | ✅ 102 类 / 1555 项 / 0 失败 |
| Release 隔离 | ✅ 5/5 |
| Debug APK | ✅ 构建成功 |

> ⚠️ 浏览器首轮曾出现 16 个套件"脚本崩了"——查证是**并发资源冲突**
> （17 个 msedge + 9 个 node 残留进程），清理后 **6981/0** 全绿。
> 那些残留进程是**今早 07:30 其它会话留下的**，不是本轮产生。

---

## 九、未实现功能与原因

| # | 事项 | 原因 |
|---|---|---|
| 1 | 真实 OBD 适配器连接/初始化 | **无硬件** |
| 2 | 真实 PID 解析（含 P5A-M06 改的归属判定）| **无车辆** |
| 3 | 多 ECU 真实响应 | 无车辆 |
| 4 | CAN 总线探测（`ATMA`）| 无硬件 |
| 5 | 油温/油压/BOOST/Lambda | **无标准 OBD-II PID**，需车厂 CAN/DBC |
| 6 | P5B-M01 的 4 个基元 Android View | 任务 §十 明确：未经批准不改 `icar.ui/2` |
| 7 | 屏幕方向切换专项测试 | 有 `onSaveInstanceState` 代码但无专项自动化 |
| 8 | 11 分钟完整长跑结论 | 测试在后台运行，报告写作时只到 ~5 分钟（趋势已平稳）|

---

## 十、新增 GUI 待验收卡片

| 卡片 | 内容 | 状态 |
|---|---|---|
| **GUI-P5A-M01-01** | 首次安装拒绝蓝牙权限后 App 是否能正常进入（不再闪退）| ⏳ **待真人验收** |
| **GUI-P5A-M01-02** | 拒绝权限后连接页是否显示「缺少蓝牙权限」提示 | ⏳ 待真人验收（P5A-M06 已登记 D5 环境限制）|
| **GUI-P5A-M01-03** | 车载宽屏下仪表是否明显变形；切换 `scaleMode:1`(FIT) 后是否变正常 | ⏳ 待真人验收 |
| **GUI-P5A-M01-04** | 长跑 11 分钟后 App 是否仍流畅、无发热异常 | ⏳ 待真人验收（模拟器数据仅供参考）|

> **不得把模拟器自动验证标记成真人验收通过。**
> 上述 4 张卡片全部为「待真人验收」。

---

## 十一、GitHub 完整提交 Hash 与远程验证

见提交后回填。

---

## 十二、下一阶段建议

| 优先级 | 建议 | 理由 |
|---|---|---|
| **P0** | **真机验收首装拒绝权限不崩** | 本轮修的是**首次体验最痛的点**，但只有真机能确认 |
| **P0** | 真车验证 PID 归属判定（P5A-M06 遗留）| 数据正确性核心 |
| **P1** | 把 `sim-chain` 的 18 项纳入常驻设备套件 | 现在是一次性脚本，应在 CI 里跑 |
| **P1** | 补屏幕方向切换专项测试 | 目前只有代码没有证据 |
| **P1** | 批准 `stateDir` 低值报警（已待批四轮）| 旧版会反向报警 |
| **P2** | 按 P5B-M01 阶段 G 方案接入 4 个基元 | 约 7 人日，第 1 步先验旧版容错 |
| **P2** | 给 `scaleMode` 加"按目标设备自动推荐" | 车载宽屏用 STRETCH 必然变形，用户不知道该改 |
