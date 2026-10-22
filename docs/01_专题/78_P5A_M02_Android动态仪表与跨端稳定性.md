# P5A-M02 Android 动态仪表与跨端稳定性报告

| 字段 | 值 |
|---|---|
| 任务 | `T-ANDROID-P5A-M02`（自主连续开发包）|
| 日期 | 2026-10-22（Asia/Shanghai）|
| 起点 | `9ddfde9`（P5A-M01 已同步，工作区干净）|
| 结论 | 数据源改为**复用 `SignalSimulator` 的严格互斥方案**（生产代码零改动、Release 隔离 5/5）；状态灯三态**真实换图**（27 断言）；子部件（含嵌套）动态 PID 打通并**修复 1 个真实绘制缺陷**（`GaugePartsView` 单比例缩放）；三比例 + FIT/STRETCH **量化**；11 分钟长跑内存**趋平台**；浏览器 **81 套 / 6752 断言 / 0 失败**；JVM **95 类 / 1466 项 / 0 失败** |
| 修复缺陷 | **2 个**（1 个绘制缺陷 + 1 个数据归属缺陷）|
| 登记缺口/建议 | 5 项 |

---

## 一、数据源归属与隔离的最终方案

### 1.1 为什么必须改（M01 写法的真实代价）

M01 用 `VehicleBus.put(v)` 注入。这个方法内部会 `currentOwners.remove(pidId)`，
把该 PID 从「谁在采」表里摘掉。用 JVM 测试把代价钉住
（`VehicleBusSourceSemanticsTest`，13 项全过）：

| 场景 | 结果 |
|---|---|
| `put(source,v)` → `closeSource` | 值 `ok=false`、`error="采集来源已停止"`、`value()` → null ✅ |
| `put(v)` → `closeSource` | 值**仍 `ok=true`** ❌ 仪表以为还在实时采样 |

另两条：该 PID 脱离 `openSource` 的 epoch 保护；归属在真实/模拟之间来回漂。

### 1.2 最终方案：复用既有机制 + 严格互斥 + 默认关闭

```
app/src/debug/  SimScenario  场景 → 目标值（纯函数）
                SimPidSource 场景 → SignalSimulator.Channel；互斥；看门狗
                SimControl    adb 广播入口（enable/disable/scenario/dump）
                SimInitProvider 空 Provider 钩子（首个 Activity resume 后注册广播）
app/src/main/   SignalSimulator  openSource + put(source,v) + 10Hz（v1.5.0 既有）
                VehicleBus       归属 / epoch / TTL / 失效（未改）
```

- 开模拟：先 `ObdController.engine.stop()`（互斥）→ 配通道 → `SignalSimulator.start()`
- 关模拟：`SignalSimulator.stop()` → `closeSource` → 所有模拟值 `ok=false`
- **看门狗**：每 2 秒检查，真实轮询一旦起来 → 模拟**自动退让**并记 `lastYieldReason`
- **默认关闭**：进程启动不启动模拟
- **可见标记**：App 既有横幅「⚠ 模拟数据（非真车）」，实测出现

**生产代码改动：0 行**（`app/src/main` 本轮只有一处缺陷修复，见第六节）。

### 1.3 为什么是「互斥」而不是「优先级共存」

| 方案 | 能否证明安全 |
|---|---|
| 模拟与真实并存 | ❌ 两者写同一 PID，画面交替闪烁（源码注释已写明）|
| 真实优先 | ❌ 需要额外状态机判断"真实值是否存在"，仍有竞态 |
| **严格互斥** | ✅ 项目既有做法（`SimulatorActivity.toggle()` v1.5.0）|

依据：`SignalSimulator` 文件头「开启时会停掉 ObdEngine，否则合成值会和真实值交替写入总线」。

### 1.4 Release 隔离（实测）

`tools/icarui/tests/device/verify-p5a02-isolation.js`（dex 字节级搜索）：

| 变体 | dex 数 | 含 `com/icar/obd/sim` | manifest 含 SimInitProvider |
|---|---|---|---|
| **DEBUG** | 10 | **1** | 是 |
| **RELEASE** | 2 | **0** | 否 |

⚠️ **必须说准**：Release **仍然包含** `SignalSimulator` / `SimulatorActivity`
（v1.5.0 起的既有产品功能，「连接 → 模拟信号」界面）。
准确表述是：**本轮新增的 adb 广播入口与场景化模拟源不在 Release**，
而不是"Release 不含任何波形发生器"。

---

## 二、状态灯三态实际联调结果

### 2.1 素材与主题（合成，测试专用）

- 三张 64×64 合成图：绿(#22C55E) / 黄(#F59E0B) / 红(#EF4444)，各带不同白色标记
- 通过 **`.icarzip` 设计包**导入（单文件 JSON 拿不到素材目录 → `designBaseDir` 为空 → 素材必失败）
- 生成器：`tools/icarui/tests/p5a02-make-state-lamps.js`（可复现）
- 主题：`docs/02_验证记录/android-theme/state-lamps/`
  - 6 个灯：水温 / 车速 / **低电压（缺口对照）** / **无此PID** / 转速 / 负荷
  - 1 个参考仪表（证明同屏还有别的控件在动）

### 2.2 判定逻辑（审计自源码，未自行编造）

`NodeStateResolver.select()` 是全项目唯一判定：

```
warnAt     = node.stateWarn     ?: pid.warnHigh ?: NORMAL
criticalAt = node.stateCritical ?: warnAt + (pid.maxVal - warnAt) * 0.5
value >= criticalAt → critical ；value >= warnAt → warn ；else → normal
```

代入内置 PID 得：车速 120→190、转速 6500→7250、水温 105→160。
因此模拟场景新增 `critical`（200/7400/170），与 `alarm`（150/6800/115）分档。

### 2.3 结果：**27/27**（像素证据，不是状态变量）

`verify-p5a02-state-lamps.js` 直接解码模拟器截图，按**主色**判「画的是哪张图」。
关键：黄色与红色的区分用**绿分量占红分量的比例**（黄 ≈0.73、红 ≈0.47，界 0.60）——
第一版只判「R 最大」把黄误判成红，是测量错误，已修正。

主色判定矩阵（证据）：

| 元素 | normal | warn | critical | disconnect | recover |
|---|---|---|---|---|---|
| `l_coolant`（水温）| normal | **warn** | **critical** | unknown | normal |
| `l_speed`（车速）| normal | **warn** | **critical** | unknown | normal |
| `l_rpm`（转速）| normal | **warn** | **critical** | unknown | normal |
| `l_load`（无 warnHigh）| normal | normal | normal | unknown | normal |
| `l_volt_low`（低值缺口）| normal | **normal（预期不变）** | normal | unknown | normal |
| `l_nopid`（PID 不存在）| unknown | unknown | unknown | unknown | unknown |

采样均色（截取）：
`warn` 场景 `l_coolant=247,180,67`（黄）；`critical` 场景 `l_coolant=243,114,114`（红）；
`disconnect` 全灯 `≈10,11,15`（不画素材，画 `--`）。

**结论**：状态灯**真的换了图**（不是只改了状态变量），三态、断开、恢复、多灯独立更新全部成立。

### 2.4 已登记缺口：**低值报警（warnLow）不支持**

- 事实：`select()` 只做 `value >= warnAt`，**没有低值分支**
- 实测：电压 11.03（warnLow=11.8）时 `l_volt_low` **保持绿**
- 处置：**不擅自改语义**（会改变旧主题行为）；登记 `P5A-M02-LAMP-WARNLOW`，
  建议后续以**可选新字段**（缺省=现有行为）支持低值报警

---

## 三、仪表子部件 PID 动态联调

### 3.1 支持范围（审计结论）

| 项 | 结论 |
|---|---|
| kind 种类 | `dial` / `ticks` / `needle` / `value` / `decor` |
| **`pid` 只在 `needle` 与 `value` 上生效** | 其余 kind 一律强制空（解析层决定）|
| `children` | 递归解析，深度上限 **5**；`x/y` 相对**父的 pivot** |
| 变换 | `alpha`(0..255) / `rotation` / `pivotX,Y`(-1..2) / `sweepFrom,To` / `sweepFollow` |
| 素材 | 非 `value` 必须有 `assetId`，否则该层画不出来 |
| 数据 | `neededPids()` 递归收集；`valueOf(part)` = `values[part.pid ?: 主PID]` |
| 断开 | `needle` 且值不可用 → **直接 return（指针消失）** |

### 3.2 测试主题（合成素材）

`docs/02_验证记录/android-theme/parts-gauge/`：

| 表 | 内容 |
|---|---|
| `gA` 单针+数字 | dial/ticks/needle(主 PID=转速)/value |
| `gB` **双针+双数字** | 两个 needle 各自绑 转速 / 车速（量程各自跟随 PID）+ 两个 value |
| `gC` **嵌套 + 变换** | needle(水温) 的 children 里挂亮点(第2层) + 旋转角标(第3层)；另有一个 rotation=30/alpha=150 的装饰 |

### 3.3 结果：**19/19**（像素证据）+ JVM **16/16**

| 检查 | 结果 |
|---|---|
| D1 部件真实绘制 | ✅ 三表内容密度 13.5~16.3%，盘面外环/指针橙都存在 |
| **D2 嵌套 children** | ✅ gC 青色亮点 0.707%、紫色角标 0.293%，而 gA 无同类 → **确是 gC 独有嵌套件** |
| D3 指针随值转动 | ✅ gA 6.2% / gB 9.4% / gC 6.2% 区域变化 |
| D4 双针独立 | ✅ 指针极角桶数 gB(12) > gA(9) |
| **D5 断开后指针消失** | ✅ 三表 3.4~5.2% 变化；指针橙从 2.523% → **0.000%** |
| D6 恢复后指针回来 | ✅ 指针橙回到 3.053% |
| D7 数字读数变化 | ✅ 数字区 20.9% |

JVM（`GaugePartsValueBindingTest` 16 项）覆盖：`neededPids` 递归含嵌套 PID、
`valueOf` 子部件独立 PID、无 pid 回落主 PID、`replace` 只留 neededPids、
断开置空、`NaN` 视为不可用、别名解析、只有 needle/value 保留 pid、
嵌套 depth 截断、rotation/alpha/pivot 保留、量程跟随 PID 时同值不同角。

### 3.4 🔴 修复的真实缺陷：`GaugePartsView` 只用单一缩放比例

| 项 | 内容 |
|---|---|
| 现象 | 三块表里 **`gB` 有指针，`gA`/`gC` 没有**；嵌套亮点/角标完全缺失 |
| 根因 | `GaugePartsView` 只接收一个 `pxPerUnit`，X/Y 同比例；而 `NodeTreeRenderer` 的 `Viewport` 从 v2 起是 **pxX/pxY 分别算**（节点尺寸用 `node.w*pxX` / `node.h*pxY`）。手机竖屏视口 1080×2272 → pxX=3、**pxY=6.31**，部件横向被放大 2.1 倍 → 溢出 View 边界被裁；指针 pivot 落到 View 外 → 整根针不可见；`drawPart` 在画指针时提前 return，**它的 children 也就一起不画了** |
| 影响 | **任何用 parts 拼表的主题，在非正方形视口下指针/嵌套子部件会被裁掉** |
| 修复 | 构造改为 `pxX, pxY` 两个比例（保留单比例次级构造，`pxX==pxY` 时逐像素一致）；`x/w` 乘 `pxX`、`y/h` 乘 `pxY`、pivot/文字/动画位移同理 |
| 验证 | 修复前 gA/gC 指针橙 0.000%、青点 0%；修复后 gD1 全过、D3 指针转动 6~9%、D5 断开 disappear |
| 兼容性 | 方形视口（pxX==pxY）行为完全不变；非方形视口由「裁掉」变为「按画布拉伸显示」——与节点/背景同一套语义 |

### 3.5 登记建议：用 parts 拼表时请写 `min`/`max`

指针**没有**显式 `pid` 时，量程回落到**仪表节点的 `min`/`max`**（`GaugeItem.fromJson` 默认 **0..100**）。
若主 PID 量程不是 0..100（几乎都不是），指针会**钉在端点不动**。

这是**文档化语义**（"没绑就回落仪表节点自己的"），不是缺陷；
第一版测试主题漏写量程，就出现了"指针不动"的假象（排查过程如实记录在验证记录里）。
**建议**：工具侧创建 parts 表时把主 PID 量程写进节点，或 App 侧在节点量程为默认值且主 PID 有量程时给出提示。
登记 `P5A-M02-PARTS-RANGE`。

---

## 四、多屏幕比例适配及 FIT/STRETCH 对比

### 4.1 覆盖

同一 AVD（`vent34`，Android 14）三档显示 + 两种缩放模式 × 6 张截图：

| 档 | 分辨率 |
|---|---|
| 手机竖屏 | 1080×2400 @420 |
| 平板横屏 | 1600×1000 @240 |
| 车载宽屏 | 1280×600 @160 |

测完已 `wm size reset` / `wm density reset` 复原，**不覆盖用户配置**。

### 4.2 量化结果：**27/27**

用主题里的 **圆形盘面（dial）** 做「形变探针」：设计 150×150 正方形素材，
等比缩放下仍为正圆（宽高比 1），每轴独立缩放下变椭圆（宽高比 ≈ pxX/pxY）。

| 档 | STRETCH 实测 | 理论 pxX/pxY | 偏差 | **FIT 实测** |
|---|---|---|---|---|
| 手机竖屏 | 0.498 | 0.475 | 5% | **1.000** |
| 平板横屏 | 1.796 | 1.690 | 6% | **1.000** |
| 车载宽屏 | 2.368 | 2.254 | 5% | **1.000** |

**结论**：
- `SCALE_STRETCH`（默认，v1 契约）的形变**可精确预测**，与 `pxX/pxY` 完全对得上
- `SCALE_FIT` 在任何比例下都**精确保持正圆**（1.000）
- 同分辨率下 FIT 形变 0% ≤ STRETCH 50%/80%/137%

### 4.3 其他检查

| 检查 | 结果 |
|---|---|
| 图片是否被裁切 | ✅ 三档 × 两模式，盘面 bbox 全部完整落在屏内 |
| FIT 是否产生预期留白 | ✅ 手机竖屏 FIT 内容只占屏高 **70.1%**（STRETCH 91.4%）→ 明显 letterbox |
| STRETCH 是否铺满 | ✅ 宽度 94.3% / 97.6% / 98.0%（两侧有 App 内边距）|
| 字体形变 | 从属于整体缩放，未单独量化（登记为未量化项）|
| 轨道圆角/刻度/渐变 | 本主题无 track 节点；该能力已由 M01 的轨道主题覆盖 |
| 屏幕旋转后状态恢复 | **未验证**（该 AVD 旋转会崩，见第八节）|

### 4.4 方案建议（**本轮未改默认值**）

按任务要求「不允许擅自把旧主题默认 STRETCH 改成 FIT」，只提交建议：

1. **设计器显示当前屏幕比例风险**：当 `pxX/pxY` 偏离 1 超过 ±15%，提示「此比例下圆表会变椭圆，建议用 FIT」
2. **新主题可选等比缩放**：把 `canvas.scaleMode` 暴露到导出界面（当前 `toJson()` 不写这个字段，
   手写才行 —— 本轮 FIT 对照包就是手工加 `canvas.scaleMode=1`）
3. **FIT 的代价要说清**：留白（手机竖屏 30% 高度闲置）是否可接受，属产品决策

---

## 五、长时间运行性能结果

`tools/icarui/tests/device/verify-p5a02-longrun.js`，基线存
`docs/02_验证记录/screenshots/perf-baseline-p5a02.json`。

### 5.1 压力内容（11 分钟，> 任务的 10 分钟）

- 每 2 秒循环 9 档场景（normal/accel/decel/warmup/alarm/critical/multi/disconnect/recover）
- 每 2 分钟：横滑到设置页再回来（页面切换）
- 每 4 分钟：额外反复断连 3 次
- 每 30 秒采 PSS / Java heap

### 5.2 结果：**6/6**

| 指标 | 数值 |
|---|---|
| 采样点 | 20 |
| PSS | **100.22 → 95.04 MB**（max 100.22 / min 93.92）|
| **线性斜率** | **+0.082 MB/min** |
| 分段均值 | 前 1/3 **96.49** → 后 1/3 **97.03**（+0.54 MB）→ **趋于平台** |
| 帧 | total 544；**P50 17ms / P90 22ms / P99 36ms** |
| **FATAL / ANR** | **0 / 0** |
| 结束状态 | 进程存活、仍在前台 |

### 5.3 为什么这比"M01 的 60 秒没超阈值"更有说服力

任务明确要求：「不能仅因 60 秒内存增长低于某个宽松阈值就断言不存在内存泄漏」。
本轮的判据不是单点阈值，而是：

1. **11 分钟 / 20 点**的完整曲线
2. **线性斜率** 0.082 MB/min（≈ 10 分钟 0.8 MB，属噪声量级）
3. **前后 1/3 均值对比**（+0.54 MB，未上升）→ 判为**平台**
4. 粗阈值 60 MB 只作兜底，不作为主结论

**环境说明（不混淆瓶颈来源）**：模拟器为软件渲染（swiftshader），
帧耗时绝对值不代表真机；本节只用于**趋势与泄漏判断**，不用于性能排名。

---

## 六、实际修复的产品缺陷（2 个）

### 缺陷 1：`GaugePartsView` 只用单一缩放比例 → 指针/嵌套子部件被裁掉

见第三节 3.4。**影响面**：所有用 `parts` 拼表、且视口非正方形的主题。

### 缺陷 2：模拟数据源破坏 `VehicleBus` 来源归属

见第一节 1.1。**影响面**：断开场景下旧值不失效；归属 epoch 保护失效。
**修复**：改用 `SignalSimulator`（`openSource` + `put(source,v)`），并加互斥与看门狗。

### 另外：两处**测量方法**错误（不是产品缺陷，但会影响结论，如实记录）

| # | 错误 | 修正 |
|---|---|---|
| 1 | 状态灯主色判定把"黄"误判成"红"（只判 R 最大）| 改用 G/R 比例（0.60 分界）|
| 2 | 盘面环连通域被抗锯齿断开 → 取最大连通域得到"一段弧"，宽高比造假（FIT 显示 1.37）| 掩膜先膨胀 2 格再连通域，FIT 如实得到 1.000 |

---

## 七、新增测试与全量测试结果

### 7.1 本轮新增测试

| 类型 | 文件 | 数量 |
|---|---|---|
| JVM | `VehicleBusSourceSemanticsTest` | **13** |
| JVM | `GaugePartsValueBindingTest` | **16** |
| JVM | `SimScenarioTest`（扩充 CRITICAL/warn-critical 分档）| 19 → **23** |
| 离线套件 | `verify-p5a02-state-lamps` | **27** |
| 离线套件 | `verify-p5a02-parts` | **19** |
| 离线套件 | `verify-p5a02-multires` | **27** |
| 设备套件 | `device/verify-p5a02-isolation` | **5** |
| 设备套件 | `device/verify-p5a02-longrun` | **6** |
| 设备检查 | `_p5a02-phaseG`（运行体验 8 项）| **19** |

（离线套件已纳入浏览器全量基线；`device/` 下的不进浏览器套件，因为要连模拟器）

### 7.2 全量门禁

| 项 | 本轮实测 | P5A-M01 基线 | 变化 |
|---|---|---|---|
| **浏览器** | **81 套 / 6752 断言 / FAIL=0** | 78 / 6679 | **+3 套 / +73 断言** |
| **Android JVM** | **95 类 / 1466 项 / 0 失败** | 93 / 1433 | **+2 类 / +33 项** |
| Debug APK | ✅ 7.2 MB | 8.1 MB | 构建成功 |
| Release APK | ✅ 5.8 MB | 5.8 MB | 构建成功 |
| Release 隔离 | ✅ 5/5（dex 级）| 已验 | 复核通过 |
| 浏览器基线 | 已按流程 `-UpdateBaseline`（+3 项新增）| — | 未手改 JSON |

**未删除/弱化任何既有断言**；基线变更只增不减（新增 3 个套件）。

---

## 八、Android 模拟器真实截图证据

`docs/02_验证记录/screenshots/`：

| 文件 | 内容 |
|---|---|
| `p5a02-lamp-{normal,warn,critical,disconnect,recover}.png` | 状态灯三态 + 断开 + 恢复（5 张）|
| `p5a02-parts-{normal,accel,decel,warn,critical,disconnect,recover}.png` | 子部件 7 场景（7 张）|
| `p5a02-e-{stretch,fit}-{phone,tablet,carwide}.png` | 三比例 × FIT/STRETCH（6 张）|
| `p5a02-g-{reenter,critical,disconnect,recover,before-bg,after-bg,missing-asset}.png` | 阶段 G 运行体验（7 张）|
| `perf-baseline-p5a02.json` | 11 分钟长跑 20 个采样点 + 趋势分析 |

全部为 **1080×2400 或按 `wm size` 指定**的真实设备截图，由 `adb screencap` 采集，
判定由脚本解码 PNG 完成（本轮 AI 模型不支持看图，因此所有视觉结论都是像素计算得出）。

---

## 九、未完成事项与原因

| # | 事项 | 原因（具体，不是"时间不够"）|
|---|---|---|
| 1 | **第二 AVD（`qz33`，Android 13）交叉验证** | APK 只打包 `arm64-v8a`（`build.gradle`：LVGL 192 个 .c，多 ABI 编译时间翻倍）；`qz33` 的 Android 13 镜像 abilist **仅 `x86_64`** → `INSTALL_FAILED_NO_MATCHING_ABIS`。改用同一 AVD 三档显示配置覆盖比例差异 |
| 2 | **屏幕旋转后状态恢复** | 该 AVD 旋转会崩（swiftshader/GPU 相关，M01 已两次数观察到）；本轮未再拿它冒险中断长跑 |
| 3 | 字体形变的量化 | 需 OCR 或人工；只用「字体大小随 pxY」的代码事实说明，未做像素量化 |
| 4 | 轨道圆角/刻度/渐变的多比例检查 | 本轮主题无 track 节点；该能力由 M01 轨道主题覆盖，但**未在 FIT 下重测** |
| 5 | 真机 / 真车验证 | 无硬件 |
| 6 | 低值报警（warnLow）支持 | 属语义扩展，任务要求「不得自行改变旧主题语义」→ 只登记建议 |

---

## 十、GUI 验收状态

- 上一阶段的人验收结果**保持不变**：[P5A-GUI-001](../02_验证记录/P5A-GUI-001Android数据驱动人工验收待办.md) 仍 **0/12**
- 本轮新增：[P5A-GUI-002](../02_验证记录/P5A-GUI-002Android动态仪表人工验收待办.md) **0/10**

**P5A-GUI-002 的 10 项**：状态灯三态观感 / 低值报警是否要补 / 指针轴心是否正确 /
双针是否易分辨 / 嵌套子部件观感 / **FIT vs STRETCH 该用哪个（产品决策）** /
车载宽屏观感 / 真机一致性 / 真车数据 / 模拟横幅是否醒目。

> ⚠️ 本轮所有模拟器验证**均未标记为用户人工通过**。

---

## 十一、GitHub 完整 Commit Hash、提交链接与同步结果

**`ea8df65a04d93e08e2c4fc65d9bc470b33c2ba07`**

| 项 | 值 |
|---|---|
| 本地 HEAD | `ea8df65a04d93e08e2c4fc65d9bc470b33c2ba07` |
| 远程 `origin/main` | `ea8df65a04d93e08e2c4fc65d9bc470b33c2ba07` |
| 一致性 | ✅ **完全一致** |
| Push | ✅ `9ddfde9..ea8df65`（快进，无重写）|
| 提交链接 | https://github.com/misakashiny/iCarOBD/commit/ea8df65a04d93e08e2c4fc65d9bc470b33c2ba07 |
| 禁止操作 | 未使用 `--force` / `--force-with-lease` / `reset --hard` / `--allow-unrelated-histories` |

---

## 十二、下一阶段实际功能开发建议

| 优先级 | 建议 | 依据 |
|---|---|---|
| **P1** | **支持低值报警（`warnLow`）**，以可选字段实现（缺省=现有行为） | 电压/油量这类"越低越危险"的 PID 现在完全没有告警能力 |
| **P1** | **工具侧把主 PID 量程写进 gauge 节点**（创建 parts 表时自动填 `min`/`max`） | 漏写会让指针钉死（本轮踩过）|
| **P1** | 设计器加**屏幕比例风险提示** + 导出 `canvas.scaleMode` | 现在导出不写 scaleMode，用户只能手改 JSON |
| **P2** | 用「按屏幕比例自动选 FIT/STRETCH」的产品级方案替掉手写字段 | 需产品决策（会改变旧主题表现，必须显式迁移）|
| **P2** | 状态灯的 `blink`（闪烁）三态动态验证 | 本轮刻意用 `blink=false` 保证截图可复现，闪烁未测 |
| **P2** | 新增 `x86_64` ABI 或把 LVGL 预编译产物入仓，恢复第二 AVD 交叉验证能力 | 现在 x86 模拟器一律装不上，跨镜像验证做不了 |
| **P3** | 旋转/折叠屏场景的自动化 | 需先解决该 AVD 旋转崩溃 |
