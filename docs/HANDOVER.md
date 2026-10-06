# iCar OBD —— 详细手册

> 面向「下一个接手这个项目的 AI 智能体」。
> 目标：让你在 15 分钟内理解全部设计意图、能独立构建、能安全地继续扩展，而不需要重新踩一遍坑。
>
> **⚠️ 请先从 [`接手大纲.md`](接手大纲.md) 开始** —— 那是唯一入口，
> 里面有项目全貌、上手路线和红线清单。本文是它的展开手册。
>

---

## ⭐ 最新状态（v1.9.0 · 2026-10-03）—— **先读这一节**

> 上面那些章节是长期有效的架构与手册；这一节只讲"现在到哪了"。
> 会话轮次很多，历史细节见 [`CHANGELOG.md`](CHANGELOG.md)（已 9000+ 行，按版本倒序）。

### 产物

```
dist/iCarOBD-debug-v1.10.4-android.apk    6.69 MB
```
**415 个单元测试全通过（19 个文件）。** 构建/测试命令见 §2.1。

### 这个阶段做完的

| 项 | 说明 |
|---|---|
| **LVGL 方案放弃** | 软件渲染 327 万像素撑不住 60fps（≈23ms/帧），且引入线程模型负担。<br>完整记录见 **[LVGL-放弃记录.md](LVGL-放弃记录.md)**。代码还在树里但**入口已关闭** |
| **坐标系改每轴 0..360** | 含旧配置自动迁移（`unit` 版本标记）。`Drag` 网格 `STEP=15` |
| **Sky Gauge 主题解析/转换** | `data/SkyTheme.kt` + `data/DashElement.kt` + `SkyImport`。**纯 Kotlin，不依赖 LVGL**，29 个单测 |
| **仪表盘霓虹重构** | 新增 `NeonPainter`（共用辉光层）+ `CircularGaugeView` 重写（危险区标识 + 爆闪）|
| **阈值爆闪** | 新增 `AlertPulse`（**带迟滞** + 两档节奏），27 个单测 |
| **模拟信号页重构** | 每通道从 7 行控件压到 1 行摘要 + 可展开详情；波形缩略图复用生成器函数 |
| **PC 端设计框架** | `data/DesignFile.kt` + [UI设计指南.md](UI设计指南.md)（`icar.ui/1` 格式） |
| **UI 文档化** | [UI控件清单.md](UI控件清单.md)（所有控件名/ID/颜色）· [动画实现.md](动画实现.md)（动画机制） |

### ⚠️ 未完成 / 未验证（**接手时请优先处理**）

1. **🔴 霓虹的性能基准没量准**。`dumpsys gfxinfo` 只采到 5 帧（样本太小）。
   **9 层辉光上限能否在 8 个仪表下守住 60fps，尚未验证。**
   这是**唯一一个"可能推倒重来"的风险点** —— 本项目已经因为"选型不量性能"放弃过一次 LVGL，
   不要再犯。建议先做一个能强制连续动画的基准（不依赖模拟信号）。
2. 数字 / 折线 / 多值 / G力值**四种仪表还没接霓虹**
3. 模拟器分组太粗（标准 OBD 19 个通道挤在一组）
4. LVGL 代码未删除（`cpp/lvgl/` 14.4 MB + `lvgl_bridge.cpp` + `neon_gauge.cpp`）。
   删掉能缩短编译时间。**属独立且不可逆的一次动作**
5. **实车 BLE 写入链路从 v1.3.0 起从未复验**（`tools/oncar-check.ps1`）

### 这个阶段踩过的坑（**都是"看起来合理的推断"没去量**）

| 推断 | 实际 |
|---|---|
| `g_buf` 是帧缓冲 | 它是 LVGL 的**绘制暂存区**，只有脏区域有效 → 整个仪表炸了 |
| `lv_disp_flush_is_last` 能省提交 | 它把**大部分提交挡掉了** → 帧率 100→10 |
| `flush_cb` 里可以直接提交窗口 | `ANativeWindow_lock` 会阻塞，而那时**正握着锁** → **ANR** |
| 探针能读出正确像素 ⇒ 是帧缓冲 | 探针**只在自己触发过全屏重绘后才成立** |

**两条方法论**（写进 `LVGL-放弃记录.md` §七）：
- **改完立刻量。** 上面每一个都能在改完当场量出来。
- **用户的现象描述比日志值钱。**「弹无响应」四个字直接指向主线程阻塞，比我靠日志猜有效得多。

### 工具经验（本机实测）

- **改 C 文件不要用 PowerShell 多行字符串替换** —— 这个阶段**静默失败 5 次**（引号/换行差异），
  其中一次导致"字体加载成功但从未使用"，还基于它报告过成功。**直接按行号 splice，一次没失手。**
- **8×6 像素探针会骗人**（每 ~200×340 像素才采一个点，整片漏掉文字）。
  判断"画面是不是空的"要用**亮像素统计**，最可靠的是**截图 + 解码成色彩网格**。
- **adb 传二进制**：`cmd /c ... < file` 会**截断**（204288 → 16484）。
  用 `adb push` + `chmod 644` + `run-as cp`。
- **跑自动化验证前先锁方向**（`accelerometer_rotation 0` + `user_rotation 0`），
  否则转屏导致 Fragment 重建、验证链断掉。

---
> 项目路径：`D:/icarobd`（ASCII 联结 → `D:\AI Dsh\车机项目\iCarOBD2`）
> 包名：`com.icar.obd`　版本：`1.4.0`（versionCode 6）
>
> **六份文档的分工**（别重复读）：
> | 文档 | 回答什么 |
> |---|---|
> | [`接手大纲.md`](接手大纲.md) | **入口** —— 项目全貌、上手路线、红线清单 |
> | [`迭代清单.md`](迭代清单.md) | 做完了什么 / 接下来做什么（带验收标准） |
> | [`ARCHITECTURE.md`](ARCHITECTURE.md) | **为什么** —— 架构意图、数据流、边界速查 |
> | [`FILE_MAP.md`](FILE_MAP.md) | **改哪里** —— 文件清单、关键符号、改动风险、任务索引 |
> | `HANDOVER.md`（本文） | **详细手册** —— 扩展流程、安全模型、装机清单、踩坑记录 |
> | [`CHANGELOG.md`](CHANGELOG.md) | **改过什么** —— 按版本的变更与验证记录 |

---

## 0. 一句话定位

一个 Android 应用：通过 **Vgate iCar Pro 2S**（ELM327 兼容）把车辆 OBD 数据读到手机，
以**可自定义的仪表盘**实时显示，并用**规则引擎**把数据变成事件（转向灯音效、水温/电压告警等）。

**这个项目最重要的一条设计原则：**

> 新增一种车辆数据，永远不需要改代码、不需要重新编译 APK —— 只需要在 App 里「添加 PID → 测试 → 保存 → 选进仪表盘」。

所有架构决策都是为了守住这条原则。**你在改动任何东西之前，先确认没有破坏它。**

---

## 1. 当前状态

### 已完成并编译通过

| 模块 | 状态 | 说明 |
|---|---|---|
| BLE 传输层 | ✅ | GATT 连接、已知 UUID 优先 + 通用特征探测兜底、MTU 协商、按 `>` 切帧 |
| ELM327 会话层 | ✅ | AT 初始化序列、串行化请求、超时、原始命令通道 |
| OBD 协议层 | ✅ | 响应 → 数据字节提取（兼容 ATH0/ATH1）、公式求值 |
| 公式引擎 | ✅ | 自研表达式解析器，支持 `A..Z`、四则运算、`bit()/signed()/min()/max()` 等 |
| 轮询引擎 | ✅ | 单请求串行、按 PID 独立周期、失败退避冷却、采样率统计 |
| 派生通道 | ✅ | 瞬时油耗、燃油流量、增压压力、本次里程（由其它通道实时算） |
| 规则引擎 | ✅ | AND/OR 多条件、持续时间防抖、冷却、6 种动作 |
| 仪表渲染层 | ✅ | 圆表/数字/条形 三种自绘 View，与数据层完全解耦 |
| 3 种仪表盘 | ✅ | 普通驾驶 / 性能模式 / 自定义 |
| **横竖屏自适应** | ✅ | 横屏左侧导航栏；仪表盘竖屏 2 列 / 横屏 3~4 列；表单限宽居中。详见 `FILE_MAP.md` §6 |
| 自定义仪表编辑器 | ✅ | 通道、样式、占位宽度、量程、报警值、顺序，全部持久化 |
| PID 编辑器 | ✅ | 全字段 + **在线测试**（TX/RX/数据字节/解析结果） |
| PID 扫描器 | ✅ | 限流/超时/重试/黑名单/危险模式拦截/支持位图收敛 |
| CSV 记录 | ✅ | 1Hz 采样，列对齐，可导出 |
| 结构化日志 | ✅ | 内存环形缓冲 + 按天落盘（保留 7 天）+ 模块/级别过滤 + 导出 |
| 前台服务 | ✅ | 保活 BLE，通知栏显示状态与采样率 |
| 自动重连 | ✅ | 掉线后 3s 重试，上限 3 次；用户主动断开不重连 |
| 音效 | ✅ | SoundPool 低延迟，`tick_left/tick_right/warn/beep` 四个内置音效 |

### 尚未完成 / 未验证（**接手时请优先处理**）

| 项 | 严重度 | 说明 |
|---|---|---|
| **仅支持 BLE，不支持经典蓝牙 SPP / WiFi** | 🔴 高 | 见 §10.1。若你的 iCar Pro 2S 在系统蓝牙里显示为经典设备而非 BLE，当前代码扫不到它 |
| **尚未接入真实车辆** | 🔴 高 | 已在平板（小米平板5 / Android 13）上完成 UI 全链路验证（见 §11.1），但**从未连接过 iCar Pro 2S，也没有在车上跑过**。首次接车请按 §11 排查 |
| 阿特兹厂家 PID 号全部为占位值 | 🟡 中 | 见 §10.2。必须用扫描器实测，不能直接信任 |
| 无单元测试 | 🟡 中 | 公式引擎、协议解析、规则引擎都很适合补测试 |
| ISO-TP 多帧重组 | 🟡 中 | 依赖 ELM327 自身重组，长响应可能不完整 |
| 故障码（DTC）读取 | ⚪ 低 | **有意不做**，见 §9 |

---

## 2. 五分钟上手

### 2.1 构建与测试

```bash
cd /d/icarobd
export JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
export ANDROID_HOME='C:\Android\Sdk'
export ANDROID_SDK_ROOT='C:\Android\Sdk'
./gradlew assembleDebug
```

> ⚠️ 关于 `JAVA_HOME`：旧文档说「必须显式导出，否则报没装」——那是当时 WorkBuddy 会话的
> 现象（进程启动早于用户级变量写入）。**当前 DSH 会话里两个变量都已就绪**，
> 真报 `JAVA_HOME is not set` 时再显式导出即可。

> ⚠️ **路径曾经含空格与中文**（旧位置 `D:\AI Dsh\车机项目`；现位于 `D:\AI Dsh\车机项目\iCarOBD2`（含空格与中文））：AGP 默认拒绝构建，
> 已用 `android.overridePathCheck=true` 放行。**但测试任务在原路径必然失败** ——
> 见 [`FILE_MAP.md`](FILE_MAP.md) §6。

产物：`app/build/outputs/apk/debug/app-debug.apk`
归档副本：`dist/iCarOBD-debug-v1.10.4-android.apk`

**跑单元测试**（415 个用例）—— **不要**直接 `./gradlew testDebugUnitTest`：

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-tests.ps1
```

非 ASCII 路径会让 JVM 启动器解码坏 `-cp`，全部测试类都报
`ClassNotFoundException: <测试类自身>`。脚本先建 ASCII 目录联接 `D:\icarobd`
指向工程真实位置，从联接路径跑 Gradle；**工程本身不动**，构建产物也仍在原处。

### 2.2 装机

```bash
# 中文路径会让 Git Bash 向 adb 传参编码错乱，所以先复制成英文名
cp dist/iCarOBD-debug-v1.10.4-android.apk /tmp/stage.apk
C:/Android/Sdk/platform-tools/adb.exe install -r -d /tmp/stage.apk

# 装机后立刻查崩溃（编译通过 ≠ 能运行）
C:/Android/Sdk/platform-tools/adb.exe logcat -d -b crash
```

### 2.3 运行期调试

```bash
# 实时看应用日志（应用内「日志」页也能看，且更友好）
C:/Android/Sdk/platform-tools/adb.exe logcat -s iCarOBD/V iCarOBD/D iCarOBD/I iCarOBD/W iCarOBD/E

# 把 App 内日志文件拉到电脑分析（这是最有用的调试手段）
C:/Android/Sdk/platform-tools/adb.exe shell run-as com.icar.obd ls files/log
C:/Android/Sdk/platform-tools/adb.exe exec-out run-as com.icar.obd cat files/log/obd-$(date +%Y%m%d).log > obd.log
```

---

## 3–4. 架构与文件职责（指向权威文档）

> **这两节的内容已经收敛到别处，本文刻意不再重复。**
>
> 原因：历史上同一份内容在多个文档各写一份，结果真的分叉过 ——
> 最典型的是「红线清单」曾一处 7 条、另一处 12 条，v1.1.0 的横屏约束只写进其中一份，
> 照着另一份改代码就漏了约束。**同一个事实只允许有一个权威位置。**

| 我想知道… | 权威文档 |
|---|---|
| 分层、依赖方向、数据链路与排障 | [`ARCHITECTURE.md`](ARCHITECTURE.md) §1 / §2 |
| 仪表盘渲染与布局（自由画布 / 参考线 / 多数据 / 历史） | [`ARCHITECTURE.md`](ARCHITECTURE.md) §6 |
| 横竖屏自适应 | [`ARCHITECTURE.md`](ARCHITECTURE.md) §3 |
| **不可跨越的边界（红线）** | [`ARCHITECTURE.md`](ARCHITECTURE.md) §4（**唯一权威清单**） |
| 某个文件是干什么的、改哪里 | [`FILE_MAP.md`](FILE_MAP.md) §2 / §3 / §5 |
| 现在该干什么 | [`迭代清单.md`](迭代清单.md) |

本文（HANDOVER）只保留**接手流程、扩展步骤、安全模型、装机清单、踩坑记录**这类
「只有做过一遍的人才知道」的内容 —— 也就是无法从代码里直接读出来的部分。

---

## 5. 核心工作流 A：新增阿特兹 PID（**最重要的一节**）

这是整个项目存在的意义。请严格按顺序操作，能省掉大量试错。

### 步骤 1：先扫，不要猜

厂家 PID 号是猜不得的。打开 **PID 页 → PID 扫描器**：

- **Mode 01**：勾选「先用支持位图收敛范围」。程序会先请求 `0100/0120/0140/0160` 拿支持位图，
  只扫车厂声明支持的 PID，请求量从 ~96 次降到 ~30 次。
- **Mode 22（阿特兹厂家数据主要在这里）**：没有标准位图，必须给地址范围。
  默认 `1100~11FF` 只是**示例**，实际地址段请按你查到的资料调整。
- 安全参数保持默认（间隔 150ms / 超时 1500ms / 重试 1 / 上限 400）。
  **不要为了快把间隔调到 30ms 以下**，那会打满总线。

扫到命中后，每条结果右侧有「存为PID」，会自动带入编辑器并预填 Mode/PID/建议公式。

### 步骤 2：在编辑器里验证

在 **PID 编辑器** 里点「发送测试请求」，界面会显示四个关键信息：

```
TX: 22 12 34                          ← 实际发出的帧
RX: 62 12 34 3A F2                    ← 原始响应
数据字节： A=3A  B=F2                   ← 提取出的数据字节与变量名对应
解析结果： 63.86 ℃                      ← 按当前公式算出的值
```

**反推公式的方法**：拿 `A=3A B=F2`（十进制 58 与 242），
配合你资料上该量的物理值，就能确定是 `(A*256+B)*k+c` 还是 `A*k+c` 还是别的编码。

### 步骤 3：改公式 → 再测 → 直到对上

公式支持（见 `Formula.kt`）：

```
变量：A B C ... Z          （响应第 1..26 个数据字节，0..255）
运算：+ - * / % ^          括号 ( )
函数：min max abs round floor ceil sqrt
      bit(A, n)           取 A 的第 n 位（0 起），返回 0 或 1
      signed(A)           把 A 当 8 位有符号数（-128..127）
进制：0xFF
```

常用模板（编辑器里有快捷按钮）：

| 场景 | 公式 |
|---|---|
| 单字节直读 | `A` |
| 双字节大端 | `(A*256)+B` |
| 双字节大端 ×0.1 偏置 | `((A*256)+B)*0.1-40` |
| 温度（单字节，-40 偏置） | `A-40` |
| 百分比 | `A*100/255` |
| 燃油修正 | `(A-128)*100/128` |
| 开关量/位标志 | `bit(A,0)` |
| 有符号双字节 | `signed(A)*256+B` |

### 步骤 4：保存 → 启用 → 加进仪表盘

保存后回到 PID 页把开关打开（**未启用的 PID 不参与轮询**），
然后到 **仪表盘 → 自定义 → 编辑 → 添加仪表**，选上它，设好量程与报警值。

### 步骤 5（可选）：让规则引擎用上它

如果这个量需要告警（比如变速箱油温 > 120℃），到 **规则页 → 新增规则**，
数据源选它，设阈值与持续时间，动作选「弹出提示 + 仪表变色」。

> **转向灯音效同理**：转向灯信号扫出来后，把「左转向灯音效」规则的数据源
> 从默认的占位 PID 改成真实 PID 即可，不需要写任何代码。

---

## 6. 核心工作流 B：规则引擎与转向灯音效

### 6.1 触发语义（**容易误解，务必看清**）

```
条件成立 → 开始计时 → 持续 durationMs → 触发 → 进入 cooldownMs 冷却
                                                  ↓
                            冷却结束后，若条件仍成立 → 再次触发
```

这是**重复触发**语义，不是边沿触发。原因：转向灯信号在总线上是持续为 1 的状态
（开关量），只有「持续成立就按冷却周期反复响」才能产生「一秒一闪」的效果。

默认规则「左转向灯音效」的参数就是按这个设计的：
- 数据源 = 左转向信号，操作符 = `==`，阈值 = `1`
- 持续 = 0ms，冷却 = **450ms** ← 这个值决定了闪烁节奏

如果你需要「值一变就响一声」的边沿语义，把操作符改成 `~`（CHANGED）。

### 6.2 六种动作

| type | p1 | p2 | 说明 |
|---|---|---|---|
| `sound` | 音效名 | — | `tick_left` / `tick_right` / `warn` / `beep`，未登记的名字回退 `beep` 并记日志 |
| `toast` | 文本 | — | 系统 Toast + 仪表盘顶部告警条 |
| `log` | 文本 | — | 只写日志 |
| `gauge` | PID id（空=条件源） | 颜色名 | 给仪表染色。颜色：`red/green/yellow/orange/blue/cyan/purple/white/reset`，也支持 `#RRGGBB` |
| `vibrate` | 时长 ms | — | 振动 |
| `notify` | 文本 | — | 系统通知（需 POST_NOTIFICATIONS 权限） |

### 6.3 默认 5 条规则

`Defaults.defaultRules()`：左转向音效、右转向音效、高水温告警（>105℃ 持续 3s）、
电压异常（<11.8V 持续 3s）、超速提醒（>120 持续 5s）。

前两条依赖的 `tpl_left_turn` / `tpl_right_turn` **默认是关闭的** —— 这是刻意的：
标准 OBD 里没有转向灯，必须先扫出真实 PID。规则列表里会显示
「⚠ 数据源未启用」提示，避免你以为规则坏了。

---

## 7. 公式引擎细节

`Formula.eval(expr, data)`：`data[i]` 对应变量 `'A'+i`。

- 取超出数据长度的变量会抛 `FormulaException`（不是返回 0）——这是刻意的，
  避免「公式写错但静默算出一个看似合理的值」。
- `Formula.check(expr)` 用 26 字节零数据做静态语法校验，编辑器保存前会调它。
- 解析器是递归下降：`parseExpr`(+/-) → `parseTerm`(*/%/) → `parseUnary`(-/+) → `parsePower`(^) → `parsePrimary`。

---

## 8. 仪表渲染层（速查）

> **架构与取舍见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §6** ——
> 本节只给速查表，**刻意不重复「为什么」**。

### 8.1 样式 → View

映射的**唯一**位置是 `ui/view/GaugeViewFactory.kt`（渲染器与拖拽编辑器共用它，
分两处写必然分叉）。

| style | 常量 | 类 | 适用 |
|---|---|---|---|
| 0 | `STYLE_CIRCLE` | `CircularGaugeView` | 主指标（车速 / 转速），可挂指针环 |
| 1 | `STYLE_DIGITAL` | `DigitalGaugeView` | 需要精确读数的主指标 |
| 2 | `STYLE_BAR` | `BarGaugeView` | 次要指标，一屏放多个 |
| 3 | `STYLE_LINE` | `LineChartView` | 趋势曲线（**纵轴固定用量程，不自动缩放**） |
| 4 | `STYLE_DUAL_STACK` | `DualStackGaugeView` | 主 + 1 副，上下等分 |
| 5 | `STYLE_QUAD` | `QuadGaugeView` | 主 + 3 副，2×2 |
| 6 | `STYLE_SUB_DUAL` | `SubDualGaugeView` | 主大 + 2 副小 |
| 7 | `STYLE_GFORCE` | `GForceGaugeView` | G 值 2D 点 |

> 未知 `style` 一律回落到数字表，**绝不崩**（旧配置降级时很重要）。

### 8.2 刷新与布局

- `DashRenderer` 内部 **5Hz**（200ms）拉取数据 —— 高于 OBD 轮询率，不丢帧又省电。
- 位置尺寸用**归一化坐标**，像素换算只在 `render()` 里做；画布尺寸变化时 `relayout()` 重排。
- ⚠️ **不要改回「网格 + span + weight」**：那套（自然高度 186/92/54、`MAX_SCALE`、
  `NestedScrollView`）在 v1.5.0 已废弃，见 [`ARCHITECTURE.md`](ARCHITECTURE.md) §6.3。

### 8.3 横竖屏自适应

**权威描述在 [`ARCHITECTURE.md`](ARCHITECTURE.md) §3**，本节不再重复。
唯一要记的是：`MainActivity.switchTo()` 必须用 `commitNow()`，不能用 `commit()`
（后者异步，旋转恢复时会产生重复 Fragment）。

---

## 9. PID 扫描器的安全模型（**不要放松**）

`PidScanner` 有 7 道闸门，全部是硬约束：

| 闸门 | 默认 | 作用 |
|---|---|---|
| 请求间隔 `intervalMs` | 150ms | 两条请求之间强制 `delay()`，这是「不伤总线」的核心 |
| 单条超时 `timeoutMs` | 1500ms | 未定义 PID 往往超时，必须限时 |
| 重试 `retry` | 1 | 避免偶发丢包被误判为「不支持」 |
| 黑名单 `blacklist` | Mode 01 预置 4 条 | 跳过 DTC 相关等非实时数据 |
| 危险模式拦截 | 硬编码 | `ObdProtocol.isDangerous()` 命中即抛异常 |
| 总量上限 `maxRequests` | 400 | 防止参数填错跑出天文数字 |
| 支持位图收敛 | 开启 | Mode 01/09 只扫车厂声明支持的 PID |

**危险模式**（`DANGEROUS_MODES`）：`02 冻结帧 / 03 读故障码 / 04 清故障码 / 05 氧传感器 /
06 车载监测 / 07 / 08 / 10~14`。其中 **04 会清除故障码**，误触可能让你丢失重要的历史故障信息。

扫描器 UI 里这些模式**故意仍然可见**（标注「危险·拒绝」），点开始会被拦下并写日志 ——
这是为了让下一个接手的人知道「这里曾经挡过一次」。

`learnSamples`（学习采样）默认 **0（关闭）**：开启后会对每条命中额外请求 N 次以记录 min/max，
**这会显著增加总线负载**，只在需要标定量程时临时开。

---

## 10. 已知限制与风险

### 10.1 🟡 传输方式：BLE 已支持，经典蓝牙 SPP 已实现（未实机验证），WiFi 未做

Vgate iCar Pro 系列有几个变体，对应不同链路：

| 变体 | 链路 | 状态 |
|---|---|---|
| **iCar Pro 2S** | BLE 4.0（GATT 透传） | ✅ `BleTransport` |
| **iCar Pro BT3.0** | **经典蓝牙 SPP**（RFCOMM + `00001101-...`） | ✅ `SppTransport`（v1.4.0，**未实机验证**） |
| iCar Pro WiFi | TCP `192.168.0.10:35000` | ⬜ 未做 |

**接手第一件事**：确认你手上的设备在系统蓝牙设置里是「BLE 设备」还是「经典设备」。
BLE 设备会出现在 BLE 扫描里；**经典设备在 BLE 扫描里根本不出现** ——
这时把连接页的「传输方式」改成 **经典蓝牙 SPP** 再扫。

**分层已经干净**（v1.4.0 完成）：`ObdTransport` 是接口，`ElmSession` / `ObdEngine`
只依赖它。要再加 WiFi/TCP，只需：

1. 实现 `ObdTransport`（照 `SppTransport` 抄即可）；
2. 在 `ObdController.buildTransport()` 注册；
3. `Store.Settings.transportKind` 加一个取值，连接页 `transportKeys` 加一项。

**不要**在 `ElmSession` 或更上层加传输分支判断，那会污染分层。

> ⚠️ SPP 的**接口抽象已验证**（BLE 路径无回归、应用可正常启动），
> 但**没有用真实 BT3.0 适配器跑过**。真机上连不上时优先怀疑三处：
> ① `connect()` 前是否漏了 `cancelDiscovery`（已做）；
> ② 是否需要 `createRfcommSocketToServiceRecord` 的反射兜底；
> ③ 连接超时是否太短。

### 10.2 🟡 阿特兹 PID 号全是占位值

`BuiltInPids.MANUFACTURER_TEMPLATES` 里 4 条厂家模板的 PID 号（`1234` / `2201` / `2202` / `2300`）
**都是占位示例**，只有公式骨架是对的。它们默认关闭。

我没有编造真实的马自达 PID 号，因为**错误的 PID 号比没有更危险** ——
你可能会拿到别的信号的值，然后据此做判断。

正确做法见 §5。

### 10.3 🟡 ISO-TP 多帧

长响应（>7 字节）依赖 ELM327 自身重组。部分廉价固件重组不完整。
如果发现某条 PID 响应被截断，日志里能看到原始帧，可以自己用 `customRequest` + 公式处理。

### 10.4 真机（平板）验证状态

**已完成**：小米平板 5（`M2105K81AC` / 代号 `elish`，Android 13 / SDK 33，1600×2560 @360dpi）
上安装运行，UI 全链路无崩溃、无 ANR。详见 §11.1。

**已完成（v1.1.0）**：横竖屏自适应在平板上逐页验证通过。详见 §11.2。

**已完成（v1.3.0）**：日志页崩溃与日志洪泛修复，
用压力注入的方式验证了适配器 3000 条溢出路径。

**已连接过真车（v1.3.0 前）但未取到数据**：
2026-10-02 首次上车，成功连上适配器 `IOS-Vlink`（BLE GATT），
但**所有 AT 命令超时、一个字节都没收到**，扫描 0 命中。
根因是写类型写死 + 特征选择不校验属性，已在 v1.3.0 修复，
但**修复本身尚未经实车复验**。详见 §11.3。

**仍未完成**：从未取到任何真实总线数据。
因此「数据链路」——ELM327 初始化、PID 解析、公式求值、规则触发
——**全部尚未经真实总线验证**。这是当前最大的风险。

---

## 11. 装机后必查清单（编译通过 ≠ 能运行）

> **实车场景直接跑 `tools\oncar-check.ps1`**：它把下面这些检查连同 GATT 表、
> AT 命令 TX/RX 与超时、初始化结果、扫描器日志一次收齐，并按 GATT 表给出判定。

```bash
# 1. 装机
cp dist/iCarOBD-debug-v1.10.4-android.apk /tmp/stage.apk
C:/Android/Sdk/platform-tools/adb.exe install -r -d /tmp/stage.apk

# 2. 启动
C:/Android/Sdk/platform-tools/adb.exe shell am start -n com.icar.obd/.ui.MainActivity

# 3. 立刻查崩溃（最重要）
C:/Android/Sdk/platform-tools/adb.exe logcat -d -b crash

# 4. 看应用日志确认初始化顺序
C:/Android/Sdk/platform-tools/adb.exe logcat -d -s iCarOBD/I iCarOBD/E
```

**预期看到**：日志里有 `===== iCar OBD 启动 =====` → `ObdController 初始化完成` → `写入默认规则`。

**常见问题**：

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即崩，`NullPointerException` on `lateinit` | `ObdController.init()` 没在 `App.onCreate` 里跑到 | 检查 `AndroidManifest.xml` 的 `android:name=".App"` |
| 前台服务启动失败 | Android 12+ 后台启动限制 | 已改为从 `MainActivity.onCreate` 启动，不要挪回 `App` |
| 扫描不到设备 | 权限未授予 / 设备是经典蓝牙 | 见 §10.1；确认 `BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT` 已授予 |
| 连上但 `0100` 无响应 | 点火开关未到 ON / 协议不对 | 在连接页换协议（阿特兹通常 **6 = ISO 15765 CAN 11bit 500k**，用 `ATSP0` 自动也行） |
| 通知栏没有常驻通知 | 未授予 `POST_NOTIFICATIONS`（Android 13+） | 手动去系统设置授予 |

### 权限在 MIUI/澎湃上的注意

悬浮窗/通知类权限在某些国产 ROM 上走 `appops` 而非运行时权限。排查用：

```bash
C:/Android/Sdk/platform-tools/adb.exe shell appops get com.icar.obd SYSTEM_ALERT_WINDOW
C:/Android/Sdk/platform-tools/adb.exe shell dumpsys package com.icar.obd | grep SYSTEM_ALERT_WINDOW
```

另外 **`pm clear com.icar.obd` 会同时重置 appops**，清数据后权限要重新授予。

### 11.1 已完成的平板验证记录（2026-10-02）

设备：小米平板 5（`M2105K81AC`，Android 13 / SDK 33，1600×2560 @360dpi）

| 验证项 | 结果 | 证据 |
|---|---|---|
| 安装 | ✅ | `adb install -r -d` → Success |
| 冷启动 | ✅ | `logcat -b crash` 为空；日志出现 `===== iCar OBD 启动 =====` |
| 初始化顺序 | ✅ | 默认规则 5 条 / 默认仪表 8 个 / 音效 4 个登记 / ObdController 就绪 |
| 权限申请 | ✅ | `BLUETOOTH_SCAN` `BLUETOOTH_CONNECT` `POST_NOTIFICATIONS` 全部授予 |
| 前台服务 | ✅ | `ObdService 已启动`，无 FGS 启动异常 |
| 底部导航 5 页 | ✅ | 仪表盘 / 连接 / PID / 规则 / 日志 逐页打开无崩溃 |
| 仪表盘 3 种布局 | ✅ | 普通（6）/ 性能（6）/ 自定义（8） 均正确渲染并填满屏幕 |
| PID 编辑器 | ✅ | 内置条目字段正确回填；`发送测试请求` 在未连接时给出「设备未就绪」提示而非崩溃 |
| 规则编辑器 | ✅ | 动态条件/动作行、实时预览（`当 发动机转速 > 0rpm → 播放音效 beep`）正常 |
| 扫描器安全闸门 | ✅ | 未勾选安全确认点「开始扫描」→ Toast「请先勾选安全确认」，扫描未启动 |
| 仪表盘编辑器 | ✅ | 8 个仪表列出样式/宽度/量程/报警；「添加仪表」对话框自动带入 PID 建议量程 |
| 设置持久化 | ✅ | 切到「自定义」后杀进程重启，`restorePage` 与 `dashType=2` 均正确恢复 |

**验证过程中修掉的两个真机问题**：

1. **大屏留白**：仪表盘原本用固定 dp 高度，在 2560px 高的平板上只占上半屏，下方 55% 全黑。
   → `DashRenderer` 新增 `viewportHeight` 参数，按可用高度等比放大（上限 2.2 倍），
   同时把三种仪表的字号改为按视图尺寸取比例，避免「大表配小字」。
2. **日志列表贴底**：`LinearLayoutManager.stackFromEnd = true` 在条目少时让内容全部堆在底部，
   看起来像渲染错误。→ 改为顶部对齐 + 新条目到达时 `scrollToPosition(last)`。

**一个非应用问题的排查记录**（避免接手的人重复怀疑）：
截图上左侧边缘固定位置有个白色圆点，且遮住了「限流与容错」标题的首字。
放大局部后确认那是 **MIUI 的系统侧边栏把手**（在仪表盘/连接/PID/规则/日志五个页面上
位置完全一致，属于系统叠加层），**不是应用的布局 bug**。
定位手段：`tools/crop_png.py`（纯标准库的最小 PNG 解码+裁剪放大工具）。

> 现场截图已归档在 `docs/screenshots/`（17 张：`01~10` 竖屏，`11~17` 横屏，覆盖全部页面与编辑器）。
> 排查界面问题时注意：**截图的实际分辨率是 1600×2560，但预览工具会缩放显示**，
> 估算点击坐标时要按 2.374 的比例换算回物理像素。

### 11.2 v1.1.0 横竖屏验证记录（2026-10-02）

强制横屏方式：`adb shell settings put system accelerometer_rotation 0` +
`adb shell settings put system user_rotation 1`（验证完记得把 `accelerometer_rotation` 改回 1）。

| 验证项 | 结果 |
|---|---|
| 竖屏全部页面 | ✅ 与 v1.0.0 一致，无回归 |
| 横屏左侧导航栏 | ✅ 5 项图标+文字，垂直居中，选中态正常 |
| 横屏仪表盘（普通/性能/自定义） | ✅ 均 4 列正确排版，填满屏幕 |
| 横屏连接页 / PID / 规则 / 日志 | ✅ 限宽居中，边缘对齐 |
| 横屏 4 个编辑器 | ✅ 限宽居中，功能正常 |
| 旋转往返 | ✅ 页面位置恢复，BLE 状态不受影响 |
| 崩溃 / ANR | ✅ 均为空 |

**本次修掉的 3 个真机问题**：
1. 数字仪表文字溢出 —— 原本按高度取字号，横屏 4 列格子又宽又高导致数值/单位溢出屏幕。
   改为 `base = min(h, w × 0.42)`。
2. 圆表标签离表盘过远 —— 标签原本贴单元格底部，格子变高后与圆盘之间出现大片空白。
   改为紧跟圆下方。
3. 重复 Fragment 风险 —— `switchTo` 的 `commit()` 改为 `commitNow()`（见 §8.4）。

**未做（有意取舍）**：横屏下编辑器仍是单列表单，只做限宽居中。
要真正利用横屏宽度需 `layout-land/activity_pid_editor.xml` 等 2 列布局，
代价约 1000 行重复 XML。若后续要做，优先做 PID 编辑器（字段最多）。

### 11.3 首次上车实测记录（2026-10-02，**必读**）

第一次接上真车（`IOS-Vlink` @ `41:42:86:9B:2E:7E`）。**结果：一个字节都没收到，
扫描 0 命中，日志页崩溃。** 根因与修复见 CHANGELOG v1.3.0，这里只记结论与教训。

**观察到的现象**

```
[BLE][I] 发起连接 | addr=41:42:86:9B:2E:7E name=IOS-Vlink
[BLE][I] 选定服务 | svc=000018f0-0000-1000-8000-00805f9b34fb
[BLE][I] 写特征   | uuid=00002af0-...
[BLE][I] 通知特征 | uuid=00002af1-...
[BLE][D] 无 CCCD 描述符，直接进入就绪
[OBD][V] TX | ATZ
[OBD][W] 超时无响应 | cmd=ATZ timeout=3000ms      ← 后续所有 AT 命令都一样
[BLE][W] 写入失败，重试排队                        ← 刷了 113 万行
```

**三条教训**

1. **「GATT 连上了」不等于「能通信」**。必须确认写特征真的有写属性、
   写类型被接受。本版起连接后会自动转储 GATT 表，
   **下次上车第一件事就是看那张表**。
2. **无限重试 + 逐次写日志 = 灾难**。写入失败的重试必须有界，
   且日志系统必须能自保（重复抑制/文件上限/队列有界）。
3. **UI 测试覆盖不到的长尾**：日志页崩溃只在日志超过 3000 条时触发，
   而 UI 单测时日志只有几十条。**改动环形缓冲类组件后，
   必须用压力注入的方式验证溢出路径**（本次用临时压力代码注入 6000 条验证，
   验证后已删除）。

**下次上车请按这个顺序做**

1. 连接 → 等「已就绪」→ 到「日志」页看 `===== GATT 表开始 =====` 那一段。
2. 关注写特征那一行的 `props=`：
   - 含 `Wn` → 支持 write-without-response，本版应能正常写入；
   - 只有 `N`（notify）没有 `W`/`Wn` → 该 UUID 不是写特征，需要换特征；
   - 整张表里没有任何可写特征 → 这台适配器可能不是 BLE 透传，
     需改走经典蓝牙 SPP（见 §10.1）。
3. 若仍全部超时，把 GATT 表那段日志导出发我，可据此确定正确的特征与写类型。

---

## 12. 日志与迭代方法

### 12.1 日志在哪

| 位置 | 内容 |
|---|---|
| 内存环形缓冲 | 最近 3000 条，App 内「日志」页实时看 |
| `files/log/obd-YYYYMMDD.log` | 按天滚动，保留 7 天（`AppLog.KEEP_DAYS`） |
| `files/csv/obd-YYYYMMDD-HHmmss.csv` | 行车数值序列（1Hz），可用 Excel/pandas 画图 |
| logcat | 可选镜像（连接页开关），tag 前缀 `iCarOBD/` |

### 12.2 模块标签

`SYS` / `BLE` / `OBD` / `SCAN` / `RULE` / `AUDIO` / `DATA` / `UI`

**排查套路**：
- 连不上 → 过滤 `BLE`
- 连上但没数据 → 过滤 `OBD`，看 `TX/RX` 与「超时无响应」
- 某条 PID 一直没值 → 过滤 `OBD` 找「PID 连续失败进入冷却」，或在 PID 编辑器里单独测
- 音效不响 → 过滤 `AUDIO`，看是否「未登记的音效」
- 规则不触发 → 规则列表会显示「⚠ 数据源未启用」，先用编辑器里的「试判一次」

### 12.3 迭代建议

1. **先看日志再改代码**。日志里 TX/RX 是全的，绝大多数问题看日志就能定位。
2. 改协议/公式相关代码后，**务必用一条已知 PID（如 `01 0C` 转速）回归**。
3. 新加的音效/颜色/动作类型，记得同步更新 §6.2 表格和 `RuleEditorActivity` 里的提示文案。
4. 改动**环形缓冲类组件**（`LogAdapter` 这类）后，必须用压力注入验证溢出路径
   —— 日志页崩溃只在超过 3000 条时触发，日常 UI 测试永远覆盖不到。

### 12.4 日志系统的四条自我保护（**不要移除**）

2026-10-02 实车上，BLE 写入失败进入无限重试并逐次写日志，
**2 小时刷出 113 万行 / 57.9MB**（占全部日志 99.9%），并把日志页一起拖崩。
现在 `data/AppLog.kt` 有四条防线，任何一条被拿掉都会重演：

| 防线 | 参数 | 作用 |
|---|---|---|
| 重复消息抑制 | 2 秒窗口；1 秒或 200 条触发汇总 | 同一消息只留一条 `该消息重复 N 次，已抑制` |
| 单日文件上限 | 24MB | 超过停写；启动时发现历史超限文件会归档重开（否则当天日志全被堵死） |
| 落盘队列有界 | 4096，丢最旧 | IO 跟不上时丢弃而不是堆到 OOM |
| 监听器批量派发 | 待派发队列 500 | 不再每条 post 一次主线程任务 |

配套的两条实现要求：

- **落盘必须批量**：保持一个 `BufferedWriter`，400ms flush 一次。
  早期是「每条 `appendText`」= 每条开关一次文件，8000 条突发会大量丢弃。
- **`exportText()` 只导出末尾 2MB** 并注明截断。早期用 `readText()` 读整个文件，
  57MB 会直接 OOM。

> 排查「日志为什么少了」时：先看有没有 `已抑制` 汇总行，
> 再看 `AppLog` 的 `droppedByIo` 计数。UI 侧另有 500 条的派发队列上限 ——
> 极端突发时**日志页显示的可能不是全部**，但内存缓冲（3000 条）与文件是完整的，
> 切页回来会重新装载。

---

## 13. 本机环境与踩坑记录

### 13.1 工具链

- JDK 21：`C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot`
- Android SDK：`C:\Android\Sdk`（platforms 35/36、build-tools 35.0.0/36.0.0）
- Gradle 8.14.3（wrapper）、AGP 8.13.0、Kotlin 2.2.20

### 13.2 网络

**`dl.google.com` 在本机不可达，Maven Central 可达。**
因此 `settings.gradle.kts` 里必须保留阿里云镜像：

```kotlin
maven { url = uri("https://maven.aliyun.com/repository/public") }
maven { url = uri("https://maven.aliyun.com/repository/google") }
maven { url = uri("https://maven.aliyun.com/repository/gradle-plugin") }
```

删掉它们会报 `Plugin [id: 'com.android.application'] was not found`。
另外 `--offline` 构建**会失败**（本地缓存缺 plugin marker），必须联网走镜像。

### 13.3 环境坑（本机通用，DSH 会话实测）

1. **旧工程路径含空格 + 中文**（`D:\AI Dsh\车机项目`；2026-10-06 已迁到纯 ASCII 路径）：
   - `assembleDebug`：AGP 默认拒绝构建 → 用 `android.overridePathCheck=true`（已加）
   - `testDebugUnitTest`：**原路径必然失败**，测试类报 `ClassNotFoundException: <测试类自身>`。
     原因是 JVM 启动器用系统 ANSI 代码页解码 `-cp`，中文路径被解坏。
     加 `-Dsun.jnu.encoding=UTF-8`（Gradle 守护进程与测试 worker 都加）**实测无效** ——
     argv 在 `-D` 生效之前就已被解码。
     → 用 `tools/run-tests.ps1`：建 ASCII 目录联接 `D:\icarobd` 再跑
2. **PowerShell 脚本含中文必须带 UTF-8 BOM**，否则 Windows PowerShell 5.1 按 ANSI
   读取，直接报语法错误（`The string is missing the terminator`）。
3. **向 `adb` 传含中文的路径容易编码错乱** → 用 `D:\icarobd`（ASCII 联接）下的产物最稳。
4. **环境变量**：DSH 会话里 `JAVA_HOME` / `ANDROID_HOME` 已就绪；
   旧文档说的「会话里读不到」是 WorkBuddy 会话的现象。

### 13.4 Kotlin DSL 易错点（本工程已修）

- `resourceConfigurations` 已废弃 → 用 `androidResources.localeFilters`
- `kotlinOptions.jvmTarget` 已废弃 → 用 `kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }`
- AGP 8+ 默认关闭 `BuildConfig` 生成 → 已在 `buildFeatures` 里显式开 `buildConfig = true`

---

## 14. 改代码的注意事项（**禁区**）

> **完整条目见 [ARCHITECTURE.md](ARCHITECTURE.md) §4 —— 那是唯一权威清单（18 条）。**
> 本节**刻意不重复列出条目**，只补充几条「为什么」和踩坑细节。
>
> 原因：这份清单曾在两处各写一份，结果分叉成「一处 7 条、另一处 12 条」，
> v1.1.0 新增的横屏约束只写进了其中一份。**新增/修改红线请只改 `ARCHITECTURE.md` §4。**

### 14.1 三条最容易无意中踩的

| 红线 | 为什么危险 | 详细 |
|---|---|---|
| 渲染层不得取数 | 这是本项目最值得保留的设计，破坏了就再也回不去 | §3、§8 |
| `AppLog` 四条自我保护不得移除 | 违反不会立刻报错，而是在长时间运行后日志爆掉 | §12.4 |
| RecyclerView 环形缓冲成对通知 | 只在缓冲超过上限时才崩，日常 UI 测试永远覆盖不到 | §12.3 第 4 条 |

### 14.2 几个具体的历史踩坑

- **`AppLog` 的常量是 `M_XXX`**（`M_RULE` 不是 `RULE`）—— 编译期才会发现，踩过一次。
- **不要改 `navView` 这个 id，也不要只改其中一个布局** ——
  `layout/` 与 `layout-land/` 靠同名 id + 共同基类 `NavigationBarView` 才做到零分支，
  改一处漏一处会在某个方向上崩溃。
- **`switchTo()` 必须用 `commitNow()`** —— 不要"优化"回 `commit()`。
  `commit` 是异步的，旋转恢复时两次快速调用会都看到 `findFragmentByTag == null`，
  各 `add()` 一份，产生重复 Fragment。
- **表单/列表页的限宽不要用 layout-land 副本实现** ——
  `MaxWidthViews.kt` 一套 XML 适配两个方向；复制 XML 会让后续改字段时两处不同步，
  这是最容易埋雷的维护方式。
- **BLE 特征选择必须校验 `properties`** —— 只比对 UUID 会让
  「连上了但一个字节都收不到」，而且从现象上完全看不出原因。见 §11.3。

---

## 15. 建议的下一步（按优先级）

> **完整待办清单（含前置条件、步骤、验收标准、阻塞关系）见
> [迭代清单.md](迭代清单.md) §二 —— 那是唯一维护位置，本节只给概要。**

| 优先级 | 事项 | 为什么 |
|---|---|---|
| **P0** | 上车复验 BLE 写入修复（先看 GATT 表） | 数据链路一次都没跑通，当前最大风险 |
| P1 | 若 GATT 表无可写特征 → 实现 `SppTransport`（经典蓝牙） | 决定项目可行性，见 §10.1 |
| P1 | 用扫描器实测阿特兹 Mode 22 地址段并回填 | 解锁厂家专有数据 |
| P2 | 补 `Formula` / `ObdProtocol.extractData` / `RuleEngine` 单元测试 | 纯函数，最易补也最易悄悄错 |
| P3 | 横屏下编辑器改 2 列布局 | 观感优化，需约 1000 行 XML |

可选增强（不阻塞）：仪表盘拖拽排序、PID 分组折叠、CSV 回放、暗色/亮色主题切换。

---

## 16. 附：内置标准 PID 速查

| 请求 | 名称 | 公式 | 单位 |
|---|---|---|---|
| `01 0C` | 发动机转速 | `((A*256)+B)/4` | rpm |
| `01 0D` | 车速 | `A` | km/h |
| `01 05` | 冷却液温度 | `A-40` | ℃ |
| `01 42` | 控制模块电压 | `((A*256)+B)/1000` | V |
| `01 04` | 发动机负荷 | `A*100/255` | % |
| `01 11` | 节气门开度 | `A*100/255` | % |
| `01 0F` | 进气温度 | `A-40` | ℃ |
| `01 10` | 空气流量 MAF | `((A*256)+B)/100` | g/s |
| `01 06` | 短期燃油修正 STFT | `(A-128)*100/128` | % |
| `01 07` | 长期燃油修正 LTFT | `(A-128)*100/128` | % |
| `01 0B` | 进气歧管压力 MAP | `A` | kPa |
| `01 2F` | 燃油液位 | `A*100/255` | % |
| `01 5C` | 机油温度 | `A-40` | ℃ |

派生通道（`mode=CALC`，由其它通道实时算）：
`calc_l100` 瞬时油耗 / `calc_lh` 燃油流量 / `calc_boost` 增压压力 / `calc_km` 本次里程

---

*文档版本 1.0 · 随代码一起演进。改动架构或新增扩展点时，请同步更新本文档。*

## LVGL 已放弃

仪表盘渲染**已放弃 LVGL**，改回 Android 自绘控件。
原因、过程与保留成果见 [LVGL-放弃记录.md](LVGL-放弃记录.md)。
代码暂未删除，引擎开关已隐藏。
