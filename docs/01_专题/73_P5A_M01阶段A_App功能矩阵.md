# P5A-M01 阶段 A：Android App 架构与功能矩阵

**日期**：2026-10-21（Asia/Shanghai）
**任务**：`T-ANDROID-P5A-M01`
**起点**：`d849ac1`

---

## 一、架构审计结论

### 1.1 数据链路（**关键发现**）

```
BLE/ELM327 硬件
    ↓
ObdEngine.poll()                          [obd/ObdEngine.kt]
    ↓ 解析响应
VehicleBus.put(source, PidValue)          [obd/VehicleBus.kt:74]  ← **唯一数据入口**
    ↓ 存入 values: ConcurrentHashMap
    │
    ├→ get(id) / value(id) / snapshot()   [带 TTL 新鲜度判定]
    │       ↓
    │   DashRenderer.kt:405/418/429/437   ← 拉模式
    │   NodeTreeRenderer.kt:525
    │   RuleEngine.kt:133/179             ← 规则引擎
    │
    └→ addValueListener { v -> }          ← 推模式
            ↓
        LvglDashView.kt:208
        ObdService.kt:39
```

**架构优点**：
- `VehicleBus` 明确设计为「数据层与渲染层的唯一接口」
- 渲染层**不认识 BLE，也不认识 ELM327**
- 源码注释明确：`BaseGaugeView`「本类及其子类不得自己去读」总线 —— 值由渲染层传入

### 1.2 为什么 VehicleBus 是**安全的模拟注入点**

| 特点 | 说明 |
|---|---|
| `openSource(owner)` 是 internal | 建立**独立采集来源**，有自己的 epoch |
| `put(source, v)` 校验 `sourceActive` | 已关闭的来源写入会被拒绝 |
| `closeSource(source)` | 关闭时把该来源的值标记 `ok=false`，触发 UI 显示 `--` |
| `retainOnClose` 参数 | 控制关闭时是否保留值 |
| **与真实 OBD 走完全相同的下游** | 不建立第二套渲染通道 |

**结论**：可以在 Debug 下用一个**独立的 Source** 注入模拟值，真实 OBD 连接时 `openSource` 会自然替换它，互不干扰。

---

## 二、App 功能矩阵

分类口径：
- **T** = 已实现且有测试
- **M** = 已实现但缺测试
- **E** = 编辑器支持但 App 尚不支持
- **N** = 尚未实现
- **H** = 需要真实 OBD 才能验证

### 2.1 数据层

| 功能 | 状态 | 证据/说明 |
|---|---|---|
| PID 定义加载/保存 | **T** | `Store.findPid()` 等，多测试覆盖 |
| PID 实时值总线 | **T** | `VehicleBus` + `VehicleBusTest` |
| 值新鲜度判定（TTL）| **T** | `fresh()` 有测试 |
| 采集来源代际管理 | **T** | `openSource`/`closeSource` 有测试 |
| 值历史（线型图）| **T** | `pushHistory` |
| 规则引擎 | **T** | `RuleEngine` + 测试 |
| **模拟数据源** | **N** | **本轮新增** |
| 实际 BLE 采集 | **H** | 需真实适配器 |

### 2.2 渲染层

| 功能 | 状态 | 证据/说明 |
|---|---|---|
| `DesignNode` 解析 | **T** | `DesignNodeTrackDispatchTest` 等 |
| `NodeTreeRenderer` 分派 | **T** | 本轮前已有 + P4F-M03 新增 track 分派 |
| `TrackStyle` 解析 | **T** | `TrackStyleParseTest` 14 项 |
| `TrackView` 绘制 | **M** | 仅模拟器截图验证，无 Canvas 单元测试 |
| `GaugePartsView` 子部件 | **M** | 无独立测试 |
| `BarGaugeView` 色带 | **M** | 无独立测试 |
| 仪表数值更新 | **M** | 无端到端测试 |
| 状态灯状态切换 | **M** | 无独立测试 |
| `valueLabels` 数值映射 | **T** | `ValueLabels.kt` |
| 多段色带 | **M** | `PidModels` 层有，绘制无测试 |
| 报警阈值 warnLow/warnHigh | **M** | 逻辑在 `BaseGaugeView`，无测试 |
| LVGL 渲染通道 | **M** | 可选通道 |

### 2.3 主题导入

| 功能 | 状态 | 说明 |
|---|---|---|
| `icar.ui/2` 解析 | **T** | `DesignFile.parse` 大量测试 |
| 旧版 `icar.ui/1` 兼容 | **T** | `DesignFileTest` |
| 设计包（zip）导入 | **M** | `DesignPack.kt` |
| SAF 导入流程 | **M** | 模拟器已验证（P4F-M03），无自动化 |
| 错误提示 | **T** | `parse` 返回 `errors`/`warnings` |
| **异常恢复** | **M** | 部分，本轮专项验证 |

### 2.4 多分辨率

| 功能 | 状态 | 说明 |
|---|---|---|
| 坐标 0..360 归一化 | **T** | `DesignCoordUnitTest` |
| 画布缩放 | **M** | `DashCanvas.scaleMode` |
| **多分辨率验证** | **N** | **本轮新增** |

### 2.5 App 生命周期

| 功能 | 状态 | 说明 |
|---|---|---|
| 前后台切换 | **M** | `setPageActive` |
| 横竖屏 | **M** | 无自动化 |
| 崩溃捕获 | **T** | `CrashCatcher` |

---

## 三、本轮任务范围（基于审计）

| 阶段 | 内容 | 可行性 |
|---|---|---|
| **B** | 离线 PID 模拟数据源 | ✅ `VehicleBus` 提供安全注入点 |
| **C** | 仪表与状态灯动态联调 | ✅ 依赖 B |
| **D** | 多分辨率适配 | ✅ 有 AVD，可自动截图 |
| **E** | 主题导入与异常恢复 | ✅ P4F-M03 已打通 SAF |
| **F** | 性能与稳定性 | ✅ 可用 logcat + 截图 |
| **G** | 自动测试与门禁 | ✅ |

**不在本轮范围**（需真实硬件）：
- 实际 BLE 采集验证
- 真实车辆 PID 响应
- CAN 控制帧（明确禁止）

---

## 四、模拟数据源设计方案

### 4.1 隔离策略

```
app/src/debug/java/com/icar/obd/sim/          ← **只在 debug 变体**
    SimPidSource.kt      模拟数据源（含 openSource/put/closeSource）
    SimScenario.kt       场景定义（正常/加速/报警/断连…）
    SimControl.kt        开关与状态（SIMULATED 标记）

app/src/main/java/...                          ← 正式代码不动
```

**关键点**：
- Debug 专用目录 `app/src/debug/` —— **Release 变体不会编译进去**
- 不修改 `VehicleBus`、`ObdEngine`、`DashRenderer` 任何一行
- 通过 `openSource(SimPidSource)` 建立独立来源
- 真实 OBD 连接时 `openSource(ObdController)` 会替换它

### 4.2 为什么不用 `VehicleBus.put(v)` 无来源版本

`put(v)`（行 91）会 `currentOwners.remove(v.pidId)` —— 让该 PID 失去归属，
真实轮询关闭时不会失效它。这适合"派生值"，但**不适合模拟**（无法被真实连接自然替换）。

**用 `openSource` + `put(source, v)` 才是正确姿势。**

### 4.3 模拟场景

| 场景 | 行为 |
|---|---|
| `NORMAL` | 各 PID 在正常区间小幅波动 |
| `ACCEL` | 车速/RPM 上升，负荷增大 |
| `DECEL` | 车速/RPM 下降 |
| `WARMUP` | 冷却液温度从 20°C 升到 90°C |
| `ALARM` | 触发 warnLow/warnHigh 阈值 |
| `DISCONNECT` | `closeSource` → 所有值变 `ok=false` |
| `RECOVER` | 重新 `openSource` + 恢复值 |
| `NULL_PID` | 某些 PID 值为 null |
| `MISSING_PID` | 引用不存在的 PID |
| `MULTI` | 多 PID 同时高频更新 |

### 4.4 可配置、可重复

- 场景用**确定性伪随机**（固定种子）→ 可重复
- 支持通过 `adb shell am broadcast` 或 Debug 面板切换
- 每个 tick 的值可预测 → 便于自动化断言

---

## 五、风险登记

| # | 风险 | 级别 | 处理 |
|---|---|---|---|
| R1 | Debug/Release 变体隔离需验证 | **中** | 构建后检查 Release APK 不含 sim 类 |
| R2 | 模拟值可能污染真实数据持久化 | **中** | 不写 `Store`、不写 IndexedDB、不进 CSV |
| R3 | 模拟来源可能干扰真实 OBD | **中** | 连接真实设备时自动关闭模拟 |
| R4 | `TrackView` 等无 Canvas 单元测试 | 低 | 本轮用截图验证，不引入 Robolectric |
| R5 | 多分辨率测试需创建 AVD | 低 | 复用现有 2 个 AVD + 必要时新建 |

---

**阶段 A 完成。继续阶段 B。**
