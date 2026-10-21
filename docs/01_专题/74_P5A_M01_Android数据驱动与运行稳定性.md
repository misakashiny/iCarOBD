# P5A-M01 Android App 数据驱动与运行稳定性报告

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-21 ~ 2026-10-22（Asia/Shanghai）|
| 任务 | `T-ANDROID-P5A-M01`（自主连续开发包）|
| 起点 | `d849ac1`（P4F-M04 已同步）|
| 结论 | 建立**离线 PID 模拟数据源**（Debug 隔离已验证）；打通**数据→仪表/轨道**真实链路；**发现并修复 2 个真实缺陷**；三分辨率验证；5 类异常主题全部安全处理；性能基线建立 |
| 门禁 | 浏览器 **78 套 / 6679 断言 / FAIL=0**；Android JVM **93 类 / 1433 项 / 0 失败**；APK 构建成功 |

---

## 一、Android 当前功能矩阵

详见 [73_P5A_M01阶段A_App功能矩阵](../01_专题/73_P5A_M01阶段A_App功能矩阵.md)。

### 关键架构发现

```
BLE/ELM327 → ObdEngine.poll() → VehicleBus.put(source, PidValue)   ← 唯一数据入口
                                        ↓
    ┌───────────────────────────────────┴────────────────────────┐
    ├→ get/value/snapshot（拉）        └→ addValueListener（推）
    │      ↓                                    ↓
    │  DashRenderer.pushValues() 每 200ms      LvglDashView
    │      ├→ gauges    → BaseGaugeView.updateMulti
    │      ├→ trackViews → TrackView.setValue   ★本轮新增
    │      ├→ partsViews → GaugePartsView.setValues
    │      └→ stateCells → applyStates
```

**`VehicleBus` 是数据层与渲染层的唯一接口**（源码注释明示），所以模拟源只往总线写，
下游一行不改 —— 「模拟能跑」与「真机能跑」走同一条路。

### 分类统计

| 类别 | 数量 | 代表 |
|---|---|---|
| T 已实现且有测试 | 12 | PID Store、VehicleBus、DesignNode 解析、规则引擎 |
| M 已实现缺测试 | 11 | TrackView 绘制、GaugePartsView、状态灯切换、生命周期 |
| E 编辑器支持 App 不支持 | 0 | — |
| N 尚未实现 | 2 | **模拟数据源（本轮已补）**、多分辨率验证（本轮已补）|
| H 需真实 OBD | 3 | 实际 BLE 采集、真车 PID 响应、CAN |

---

## 二、模拟 PID 数据源实现方案与结果

### 2.1 隔离策略（**已验证**）

| 位置 | 内容 | Release 是否编译 |
|---|---|---|
| `app/src/debug/java/com/icar/obd/sim/` | 模拟源全部代码 | **否** |
| `app/src/debug/AndroidManifest.xml` | SimInitProvider 声明 | **否** |
| `app/src/main/` | **一行未改**（VehicleBus/ObdEngine/DashRenderer 原样）| — |

**实测验证**（dex 字节搜索）：

| 变体 | dex 数 | 含 `com/icar/obd/sim` |
|---|---|---|
| **DEBUG** | 10 | **1** ✅ |
| **RELEASE** | 2 | **0** ✅ |

Release APK 的 manifest 也不含 `SimInitProvider`。

### 2.2 为什么用 `VehicleBus.put(v)` 而不是 `openSource()`

`openSource` / `closeSource` / `put(source,v)` 都是 `internal`，而 `app/src/debug/` 与
`app/src/main/` 是**不同编译单元**。本轮红线是「不修改生产代码」，所以**没有为了测试去放宽
VehicleBus 的可见性**，改用公开的 `put(v)`：

- 它走 `storeLocked()` + `notifyValues()` —— **与真实数据完全同一条下游**
- 它把该 PID 从 `currentOwners` 摘掉，语义是「这是个无归属的值」

「断开」由模拟源自己实现（补发 `ok=false`），语义与真实链路 `closeSource` 一致。

### 2.3 支持的 10 种场景

| 场景 | 行为 | 验证 |
|---|---|---|
| `NORMAL` | 车速 60 / 转速 800 / 水温 90 / 电压 14.2 | ✅ |
| `ACCEL` | 车速 0→140、转速 800→5500、负荷 20→85 | ✅ 单调上升 |
| `DECEL` | 车速 140→20、转速 5500→900 | ✅ 单调下降 |
| `WARMUP` | 水温 20→90℃，跨过 warnLow 60 | ✅ |
| `ALARM` | 200/7000/112/11.0 全部越阈值 | ✅ |
| `DISCONNECT` | 关闭来源，所有值 ok=false | ✅ |
| `RECOVER` | 重新开来源并给正常值 | ✅ |
| `NULL_PID` | 转速/水温 ok=false，其余正常 | ✅ |
| `MISSING_PID` | 只写 2 个 PID | ✅ |
| `MULTI` | 7 个 PID 不同周期变化 | ✅ |

**确定性**：值由 `tick` 的显式函数生成（不用 Random），所以自动化能断言具体数字。

### 2.4 ADB 控制接口

```bash
adb shell am broadcast -a com.icar.obd.SIM --es scenario accel --ei step 30
adb shell am broadcast -a com.icar.obd.SIM --es scenario disconnect
adb shell am broadcast -a com.icar.obd.SIM --es dump 1        # 打印总线值
```

**Debug 自动初始化**：用空 `ContentProvider` 当钩子（`Application.onCreate` 之前执行），
**生产代码一行不改**。第一版在 Provider.onCreate 里直接注册广播**收不到**，
改为挂 `ActivityLifecycleCallbacks` 在首个 Activity resume 后注册 —— 实测生效。

---

## 三、仪表和状态灯动态联调结果

### 3.1 测试主题（全部代码绘制，不依赖素材）

`docs/02_验证记录/android-theme/designdata-bind.json`（8 节点）：

| y 带 | 元素 |
|---|---|
| 10..70 | 3 个仪表（转速 / 车速 / 水温）|
| 90..120 | 2 条水平轨道（车速填充 / 转速色带）|
| 140..170 | 2 条水平轨道（负荷 gloss / 节气门 fade）|
| 190..250 | 1 条垂直轨道（车速）|

### 3.2 结果：**8/8 全部通过**

| 检查 | 结果 |
|---|---|
| C0 元素真实渲染（非空白）| ✅ 8/8（轨道密度 99.8%，仪表 18~21%）|
| C1 仪表随数值变化 | ✅ 3/3（差异 1.5%~7.8%）|
| **C2 轨道随数值变化** | ✅ **5/5（差异 23%~58%）** ← 修复后才能 |
| C3 报警阈值触发 | ✅ 8/8 |
| C4 数据断开回落 | ✅ 8/8（差异 4.8%~60%）|
| C5 数据恢复 | ✅ 8/8 |
| C6 暖机水温 | ✅ 3.63% |
| C7 六场景互不相同 | ✅ 6 种截图 |

### 3.3 既有缺口 vs 新缺陷

| 项 | 判定 |
|---|---|
| **轨道不随数据变化** | 🔴 **新发现的真实缺陷**（P4F-M01 遗留）→ 已修 |
| 断开后 UI 不回落 | 🔴 **新发现的真实缺陷**（模拟源实现问题）→ 已修 |
| `valueLabels` 数值映射 | ✅ 既有能力，数据层已由既有套件覆盖 |
| 子部件绑定 PID | ⚪ 本轮测试主题未含子部件 — **登记限制** |
| 状态灯三态 | ⚪ 需素材文件；本轮用代码绘制的轨道替代 — **登记限制** |

---

## 四、多分辨率兼容测试

### 4.1 覆盖

| 环境 | 分辨率 | 采集方式 |
|---|---|---|
| 手机竖屏 | 1080×2400 @420 | 物理默认 |
| 平板横屏 | 1600×1000 @240 | `wm size` / `wm density` |
| 车载宽屏 | 1280×600 @160 | 同上 |

测完已 `wm size reset` / `wm density reset` 恢复，**不覆盖用户模拟器配置**。

### 4.2 结果：**14/14 通过**

| 检查 | 结果 |
|---|---|
| D1 各分辨率 8 个元素都渲染 | ✅ 3/3 环境 × 8/8 元素 |
| D2 元素完全在屏内（不裁剪）| ✅ 3/3 × 8/8 |
| D3 形变量化 | ✅ 已量化（见下）|
| D4 元素互不重叠 | ✅ 3/3 环境 0 处重叠 |
| D5 不侵入系统栏 | ✅ 3/3 |

### 4.3 **形变系数测量**（关键发现）

| 环境 | 画布 | 形变系数 | 判定 |
|---|---|---|---|
| 手机竖屏 | 1080×2273 | **0.475** | 竖向拉伸 52% |
| 平板横屏 | 1600×947 | **1.690** | 横向拉伸 69% |
| 车载宽屏 | 1280×568 | **2.254** | 横向拉伸 125% |

**根因**：`NodeTreeRenderer.computeViewport` 在 `SCALE_STRETCH`（默认）下是
`Viewport(cw/360, ch/360)` —— **每轴独立缩放**。这是 **v1 契约行为**，不能擅自改。

**这不是宽屏特有问题**：竖向手机也有 52% 拉伸。

**处置**：
- 登记为**跨端兼容问题**（不是代码缺陷）
- 用户可在设计文件写 `scaleMode: 1`（FIT）换取等比缩放
- 已用 FIT 对照主题实测，但它会引入居中留白 —— 取舍需用户决定

---

## 五、主题导入和异常恢复结果

### 5.1 JVM 层（19 项全过）

`DesignFileRobustnessTest`：正常 / 旧版 / 空节点 / 缺素材 / 错 assetId / 缺字段 /
超范围 / 负宽高 / 无效 PID / 缺 pid / 损坏 JSON / 空串 / 空白 / 半截 JSON /
重复导入 / 顶层全缺 / 未知 schema / pages 缺失 / 200 层深嵌套 —— **全部不崩溃、有提示**。

### 5.2 模拟器真实导入（31 断言全过）

| 案例 | 提示内容 | 结果 |
|---|---|---|
| 损坏 JSON | 「设计文件有错误」| ✅ 拒绝加载，App 存活 |
| 未知 schema | 「设计文件有错误」| ✅ 拒绝加载 |
| 空节点 | 「0 块仪表」| ✅ 可加载 |
| 无效 PID | 「pid `totally_not_a_pid` 不在内置 PID 库里」| ✅ 加载 + warning |
| 超范围坐标 | 「超出画布右下角：右=10099 下=10099（上限 360）」| ✅ 加载 + warning |

**全部案例**：App 未崩溃、仍在前台、**0 条 FATAL**、导入后可继续使用。

### 5.3 一个被证伪的「缺陷」

初次测试认为「缺素材没报 warning 是缺陷」。查源码后发现 `assetIds.isNotEmpty()` 是
**故意**的条件 —— 空素材清单表示「素材由外部提供」（SAF 导入时另选文件夹）。
**是我的测试断言错了，不是产品缺陷。** 已按实测行为修正测试。

---

## 六、性能测试结果

基线已存 `docs/02_验证记录/screenshots/perf-baseline.json`。

| 项 | 数值 | 判定 |
|---|---|---|
| 启动后 PSS | **68.6 MB** | 基线 |
| 高频刷新（354 帧）| **Janky 30 帧 (8.5%)**、P50 **24ms**、P90 34ms、P99 85ms | ✅ |
| 60 秒连续运行内存增长 | **+8.9 MB** | ✅（阈值 60 MB）|
| 页面切换 3 轮 | +4.1 MB | ✅ |
| 暂停/恢复 | 正常回前台 | ✅ |
| **FATAL / ANR** | **0 / 0** | ✅ |
| 总内存增长（全流程）| +9.0 MB | ✅ |

**环境限制（如实记录）**：
- 模拟器是**软件渲染**（swiftshader），帧率不代表真机
- `dumpsys gfxinfo reset` 后必须**期间持续推数据**才有帧统计 —— 首版测得 0 帧是
  **测量方法错误**，修正后得到 354 帧 / 8.5% janky
- 未做任何无测量依据的渲染优化

---

## 七、修复的真实缺陷（2 个）

### 缺陷 1：模拟源断开时 UI 不回落

| 项 | 内容 |
|---|---|
| 发现 | 阶段 C：`disconnect` 与 `warmup` 截图 **MD5 完全相同** |
| 根因 | `enable()` 每次清空 `writtenPids`，导致切到 DISCONNECT 时 `markAllStale()` 遍历空集合 |
| 证据 | `BUSD` dump 显示断开后所有 PID 仍是 `ok=1` |
| 修复 | `enable()` 不清空 `writtenPids`；只有 `disable()` 才清 |
| 验证 | 修复后 dump 全部 `ok=0 err=模拟：数据断开`；截图 81835 → **56323 bytes** |

### 缺陷 2（**重要**）：条形轨道不随数据变化

| 项 | 内容 |
|---|---|
| 发现 | 阶段 C：5 条轨道区域跨场景像素差异 **0.00%**（而同屏仪表是 2.5%~8%）|
| 根因 | **P4F-M01 遗留**：`NodeTreeRenderer.buildTrack()` 只设了静态 `trackStyle`，**没接 PID**；`TrackView` 也没有接值的接口；`DashRenderer.pushValues()` 不遍历轨道 |
| 影响 | 用户在编辑器里调好的轨道只是个「静态装饰」，**永远画成设计时的比例** |
| 修复 | ① `TrackView` 加 `setValue()` / `setValueRange()` / `effectiveFill()`<br>② `NodeTreeRenderer` 加 `TrackCell` / `trackViews`，`buildTrack` 登记 PID<br>③ `DashRenderer.pushValues()` 增加轨道推值<br>④ `DesignNode.TYPE_IMAGE` 读 `pid`（回落 `statePid`，**不新增字段**）|
| 验证 | 轨道差异从 **0.00%** → **23%~58%**；断开回落 4.8%~60% |
| 回归 | JVM `DesignNodeImagePidTest` 6 项（含「老设计只写 statePid 仍有效」）|

---

## 八、自动化测试数据

| 类别 | 通过 | 失败 | 跳过 | 说明 |
|---|---|---|---|---|
| **浏览器全量** | **6679** | 0 | 0 | **78 套** |
| **Android JVM** | **1433** | 0 | 0 | **93 类** |
| Android APK | ✅ 8.1 MB | — | — | assembleDebug |
| Release APK | ✅ 5.8 MB | — | — | 隔离验证用 |
| **模拟数据源单测** | **19** | 0 | 0 | `SimScenarioTest` |
| **图片 PID 绑定单测** | **6** | 0 | 0 | `DesignNodeImagePidTest` |
| **主题健壮性单测** | **19** | 0 | 0 | `DesignFileRobustnessTest` |
| **数据绑定可视化** | **8** | 0 | 0 | `verify-p5a01-data-binding` |
| **多分辨率** | **14** | 0 | 0 | `verify-p5a01-multires` |
| 异常主题导入（模拟器）| **31** | 0 | 0 | 5 案例 |
| 性能稳定性 | **12** | 0 | 0 | F0~F6 |

### 基线复核（任务要求不照抄）

| 项 | P4F-M04 报告 | 本轮实测 | 变化 |
|---|---|---|---|
| 浏览器套件 | 76 | **78** | +2 |
| 浏览器断言 | 6657 | **6679** | +22 |
| Android JVM | 1389 | **1433** | **+44** |

---

## 九、未实现功能与原因

| # | 项 | 原因 |
|---|---|---|
| 1 | 真实 OBD 适配器采集验证 | 无硬件 |
| 2 | 真实车辆 PID 响应 | 无车辆 |
| 3 | 状态灯三态视觉验证 | 需素材文件；本轮用代码绘制轨道替代 |
| 4 | 子部件绑定 PID 联调 | 测试主题未含子部件（可在下轮补） |
| 5 | 横竖屏旋转自动化 | 本模拟器旋转时**两次崩溃**（swiftshader 限制），改用 `wm size` 模拟不同宽高比 |
| 6 | 真机性能基线 | 无真机 |
| 7 | 像素级视觉一致性 | 需 OCR / 人工 |

---

## 十、新增 GUI 待验收卡片

新建 `P5A-GUI-001`：**Android 数据驱动与运行稳定性人工验收**（12 项）。

见 [P5A-GUI-001](../02_验证记录/P5A-GUI-001Android数据驱动人工验收待办.md)。

**重要**：本轮所有模拟器验证**均不得标记为用户人工通过**。

---

## 十一、GitHub 完整提交 Hash 与远程验证

见提交后补记。

---

## 十二、下一阶段建议

| 优先级 | 建议 |
|---|---|
| **P1** | 补**状态灯三态**与**子部件绑定 PID** 的数据驱动验证（需准备素材） |
| **P1** | 真机跑一遍模拟数据源，确认真实环境下链路一致 |
| **P2** | 评估 `SCALE_STRETCH` 形变问题：是否提供「按屏幕比例自动选 FIT/STRETCH」选项 |
| **P2** | 多 AVD（`qz33`）交叉验证，排除单一模拟器特性 |
| **P3** | 横竖屏旋转自动化（需换能稳定旋转的模拟器配置） |
| **P3** | 性能长跑（10 分钟以上）看内存是否持续增长 |

---

**P5A-M01 完成。**
