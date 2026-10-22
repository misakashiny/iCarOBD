# 84_P5A_M05阶段A_OBD连接架构审计与功能矩阵

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-23（Asia/Shanghai）|
| 任务 | `T-ANDROID-P5A-M05` 阶段 A |
| 基线 HEAD | `e62838c7d88e3dab53cb6c3eb09e3eb82d49bf63`（= `origin/main`，工作区干净）|
| 原则 | **严格依据当前源码判断，不重复开发已有功能** |

---

## 一、架构分层（实际源码，非设计意图）

```
BleTransport / SppTransport        ← 物理链路（BLE GATT / 经典蓝牙 SPP）
        ↑ implements
ObdTransport（interface, 42 行）    ← **已存在的传输抽象**：State/Callback/send/flushRx
        ↑ 注入
ElmSession(transport)              ← 一问一答封装（Mutex + CompletableDeferred + withTimeout）
        ↑ 注入
ObdEngine(session)                 ← 轮询调度、退避、不支持 PID、epoch、写 VehicleBus
        ↑ 持有
ObdController                      ← 唯一 UI 入口；buildTransport() 决定用哪种链路
        ↑
ObdService / Activity / Fragment
        ↓
VehicleBus（internal openSource/put(source,v)/closeSource + TTL）
        ↓
NodeTreeRenderer → 仪表 / 状态灯 / 轨道 / 规则引擎 / CSV
```

### 1.1 关键结论：**传输层抽象已经存在**

`ObdTransport` 接口（`ble/ObdTransport.kt`，42 行）已定义：

```kotlin
enum class State { IDLE, SCANNING, CONNECTING, DISCOVERING, READY, CLOSED }
interface Callback { onStateChanged; onScanResult; onRx; onRawChunk }
fun startScan(nameFilter) / stopScan() / connect(device) / disconnect()
fun send(text) / flushRx() / isReady() / describe()
var rawMode: Boolean; var callback: Callback?; val state: State; val kind: String
```

且 **`ElmSession(transport: ObdTransport)` 是纯构造注入、无 Android 依赖**
（只用协程 + `AppLog`）→ **可以在 JVM 单测里直接塞 FakeTransport，
完整跑「Transport → ElmSession → ObdProtocol → VehicleBus」**。

**所以阶段 C 不需要改任何生产代码就能做完整链路测试。**

`ObdController.buildTransport()` 是**唯一**创建点：

```kotlin
transport = if (Store.settings.transportKind == KIND_SPP) SppTransport(ctx) else BleTransport(ctx)
session = ElmSession(transport); engine = ObdEngine(session)
```

→ 若要设备端注入 fake，只需在此加一个最小分支；JVM 侧完全不需要。

---

## 二、功能矩阵（五类）

### 2.1 已实现且已验证 ✅

| 能力 | 证据 |
|---|---|
| Transport 抽象（BLE/SPP 可替换） | 接口 + 两个实现；`ElmSession` 构造注入 |
| 传输状态机 `IDLE/SCANNING/CONNECTING/DISCOVERING/READY/CLOSED` | 枚举 + 各实现 |
| ELM327 一问一答 + 2 秒超时 | `ElmSession.request(cmd, timeoutMs=2000)`，超时返回空串并记日志 |
| 协议自动锁定（最多 6 次 ATDPN，700ms 间隔） | `ElmSession.PROTO_LOCK_TRIES/DELAY_MS` |
| `initialize()` 完整流程 + `InitResult`（含 steps 明细） | `InitResult(ok, version, protocolNumber, protocolName, voltage, probeRaw, steps)` |
| 请求安全拦截（禁止写入类命令） | `PidRequestPolicy.sessionError/readError` + 抛异常 |
| 轮询退避（失败率触发） | `ObdEngine.failRatio` + `BACKOFF_STEP`/`BACKOFF_MAX` |
| 不支持 PID 自动剔除 | `ObdEngine.unsupportedPids` + `unsupportedStreak` + `reEnable()` |
| 轮询间隔按优先级缩放 | `PollFreshness.interval(pid, global, backoff)` |
| TTL 默认 = 间隔×3（且 ≥2000ms） | `PollFreshness.ttl` |
| VehicleBus 来源归属 + epoch | `openSource/put(source,v)/closeSource/sourceActive` |
| TTL 过期标失效 | `VehicleBus.fresh()` → `ok=false, error="值已过期 …"` |
| 日志容量上限 | `AppLog`：内存 3000 条、单日 24MB、IO 队列 4096、通知队列 500 |
| 模拟源严格互斥 + 默认关闭 + 看门狗 | M02/M03 已验证（13+10 断言）|

### 2.2 已实现但缺少测试 ⚠️

| 能力 | 缺什么 |
|---|---|
| **ElmSession 完整通信路径**（连接失败/初始化失败/超时/空响应/无效响应/中途断开） | 无 JVM 单测；只有真实设备能跑到 |
| **ObdEngine 轮询错误处理**（连续超时→退避→恢复） | 无针对性单测 |
| **ObdController 状态转换**（蓝牙连上 ≠ 能采样） | 无单测 |
| **重复连接 / 重复停止** | 无单测 |
| **旧 source 迟到响应不覆盖新连接** | M02 有 `VehicleBusSourceSemanticsTest`（13 断言）覆盖了 VehicleBus 层，但**没覆盖 ElmSession→Engine 这一段的迟到响应** |
| **PID 响应延迟 / 多 PID 轮询** | 无单测 |
| **连接恢复** | 无单测 |

### 2.3 存在确定缺陷 🔴

| # | 缺陷 | 依据 |
|---|---|---|
| （待本轮 C/D 阶段实测确认，见第三节）| | |

### 2.4 尚未实现但确有用户价值 💡

| 能力 | 用户价值 |
|---|---|
| **统一的"当前处于什么状态"对外表示** | 现在状态散落在 `transport.state`、`engine.running`、`VehicleBus` 里，UI 需要自己拼 |
| **最近一次有效数据时间 / 已收到 PID 数 / 成功失败计数** | 出问题时用户与开发者都无法判断"到底是没连上、还是连上但没数据" |
| **诊断摘要导出（Debug）** | 排查现场问题 |
| **"蓝牙已连接但无有效 PID" 的显式状态** | 任务 §四明确要求；现有状态机只有 `READY`（传输层），不代表能采样 |

### 2.5 必须真实硬件才能验证 🔧

| 能力 | 原因 |
|---|---|
| BLE GATT 实际连接 / MTU 协商 / 分片 | 需要真实适配器 |
| SPP 配对与通道建立 | 需要真实适配器 |
| 真实 ELM327 初始化（ATZ/ATE0/ATL0/ATS0/ATH1/ATSP0）| 需要真实芯片 |
| 真实车辆 PID 响应、CAN 总线探测（`ATMA`）| 需要真车 |
| 蓝牙权限弹窗与拒绝路径 | 需要真实系统权限流 |

---

## 三、本轮将做什么（按阶段）

| 阶段 | 内容 | 依据 |
|---|---|---|
| **C** | 用 `FakeTransport` 做**完整链路** JVM 测试（14 类异常场景）| 2.2 的缺口；接口已就绪，无需改生产代码 |
| **B** | 补一个**从真实层推导**的统一连接状态（不建第二套状态机，只做聚合只读）| 2.4 第一项 |
| **E** | 补最小诊断信息（阶段/最近有效数据/成功失败/耗时/最后错误/来源/是否模拟）| 2.4 第二、三项 |
| **D** | 断开/过期/重连的 10 项审计与测试 | 2.2 缺口 |
| **F** | 复核互斥与 2 秒看门狗窗口 | 任务 §八 |
| **G** | G1 轨道坐标文档核对 / G2 `__rangeAuto` 理论歧义 / G3 预览状态重置 | 历史边界 |
| **H** | 稳定性与自动化 | 任务 §十 |

### 明确不做

- ❌ 不改 `icar.ui/2` 契约（`stateDir` 仍待批准）
- ❌ 不新增持久化字段
- ❌ 不连接真实车辆、不发 ECU 写入/任意 CAN 控制帧
- ❌ 不重建已有的退避/剔除/TTL 机制
- ❌ 不为了理论零竞态破坏正常采集逻辑

---

## 四、验证边界（必须区分）

| 层级 | 本轮 |
|---|---|
| JVM 单测通过 | ✅ 可做（FakeTransport 完整链路）|
| Android 模拟器通过 | ✅ 可做（导入主题、界面状态、模拟数据）|
| 真实蓝牙硬件通过 | ❌ **无适配器，未验证** |
| 真实车辆通过 | ❌ **无车辆，未验证** |

> 任务明确：「不得把模拟测试当成真实车辆测试」。本报告全程按上述四级分别标注。
