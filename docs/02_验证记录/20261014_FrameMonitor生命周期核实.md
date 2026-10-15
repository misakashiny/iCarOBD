# T-App-A1-M-P：FrameMonitor 常驻监听生命周期核实

日期：2026-10-14（Asia/Shanghai）  
任务：`T-App-A1-M-P`  
范围：只核实 FrameMonitor 生产入口与停源/晚到帧/快重开；未连接真实适配器，未发送真实车辆 AT/OBD/CAN。

## 本轮接线

为使 JVM 测试进入生产路径，新增窄运行时边界：

- `app/src/main/java/com/icar/obd/obd/FrameMonitorRuntime.kt`
- `FrameMonitor` 的默认 Android runtime/scheduler 延迟初始化；Android 默认仍委托 `ObdController`。
- 测试只替换 Transport、调度、初始化和规则周期回调；解析、接收、发布、停止和 epoch 判断仍走 `FrameMonitor` 生产实现。
- 新增 `app/src/test/java/com/icar/obd/obd/FrameMonitorLifecycleTest.kt`。

这不是业务修复，也没有改变 VehicleBus 来源语义。

## 命令与结果

命令：

```text
D:\icarobd2\gradlew.bat :app:testDebugUnitTest --tests com.icar.obd.obd.FrameMonitorLifecycleTest --no-daemon --rerun-tasks --console=plain
```

结果：exit=1；3 tests completed，1 passed，2 failed。逐例 XML：
`app/build/test-results/testDebugUnitTest/TEST-com.icar.obd.obd.FrameMonitorLifecycleTest.xml`。

### 逐例判定

| 用例 | 结果 | 证据/结论 |
|---|---|---|
| `production receive then stop invalidates monitor value` | 红 | `FrameMonitor.feedLine` 真实发布后，`stop()` 完成仍为 `ok=true`；证明当前路径没有关闭监听专属来源。 |
| `old callback after fast reopen cannot publish into new run` | 绿 | 旧 callback 在新一轮开启后不能写入新轮历史；epoch 保护当前有效。 |
| `same pid from another source survives monitor stop` | 测试接线失败 | 假运行时收尾状态未稳定，`waitUntil` 超时；不能作为产品结论，需修夹具后重跑。 |

此前两次非业务阻断：

- 初次编译因增量缓存显示错误的扩展函数/internal 符号不可见；`--rerun-tasks` 后编译通过。
- 初次运行因 Android `Looper` 静态初始化阻断；已通过 runtime/scheduler 延迟初始化和规则周期注入解除。

## 已证实缺口

1. `FrameMonitor.feedLine()` 当前使用无来源的 `VehicleBus.put(PidValue)`。
2. `stop()` 只停止 raw mode、清理 callback、发送回车并初始化，不关闭监听来源。
3. 因此停止后监听 PID 仍可能保持当前 `ok=true`，直到其他来源覆盖或 TTL 过期。
4. 快速重开旧 callback 的 epoch 保护已有本地绿证据，但不能替代停源修复。
5. 当前测试尚未覆盖真实硬件 Transport、真实适配器、真实 ECU/CAN 流和轮询恢复。

## 最小实施方案（后续实现卡，不在本轮实施）

- 允许修改：`FrameMonitor.kt`、`FrameMonitorRuntime.kt`（如需测试边界收敛）、`VehicleBus.kt`/其来源 API、对应生命周期测试。
- `FrameMonitor.start()` 成功进入接收前打开一个监听专属 `VehicleBus.Source`，并绑定本轮 epoch/owner。
- `feedLine()` 改为 `VehicleBus.put(monitorSource, PidValue(...))`，不再使用无来源写入。
- `stop()` 和准备失败/断连路径必须在同一收尾边界关闭该 Source；关闭应产生未知状态但保留历史/累计，并不得清除其他来源同 PID。
- 新一轮 start 必须先关闭旧 source 或用同 owner 的代际替换，旧 source close 不能结束新 source。
- 保留已有过滤、FrameRateGate、DLC/invalidRaw、合法 0、规则周期和轮询恢复契约。
- 不在本卡混入传感器、Controller/Session 重连、MAF/015E、PID/CAN 协议或真车修复。

## 后续验收

先补齐第三个假运行时夹具用例，再实现最小 Source 修复并让三例全绿；随后跑完整 JVM 回归、构建守卫和必要的 APK 构建。真实适配器/车辆验收另开授权任务，本轮不操作设备。

## 未完成

FrameMonitor 产品停源修复、其他来源重连/晚到帧、真实硬件和车辆验收均保持未完成。红证据不代表产品已修复。
