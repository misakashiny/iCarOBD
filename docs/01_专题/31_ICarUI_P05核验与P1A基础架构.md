# ICarUI P0.5 核验 + P1A 基础架构

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P1A` |
| 基线 | P0 审计 `ef73d48`；本轮起点 `fd5a0df` |
| 结论 | **P0.5 发现 1 项重大勘误（非阻断）**；P1A 基础设施完成，`t_label` 试点通过 |

---

## 一、P0 审计勘误（最重要）

### 1.1 勘误：**「删除 `schema.js → canvas.js` 就能消除全部循环」是错误的**

P0 报告 §2.2 与结论 §14 断言：
> `schema.js` 只依赖 1 个外部符号…这条反向依赖制造了整环
> 「阶段 1.2 消除 `schema.js → canvas.js` 反向依赖」→ 依赖图无环

**实测推翻**（用括号深度 + 注释/字符串剥离的 sanitizer 法，见 §1.3）：

| 假设 | 验证结果 |
|---|---|
| 是否存在 `schema.js → canvas.js` 依赖 | **不存在**（该边来自 `schema.js:671` 的 `window.CanvasState`，但它在 `window.currentTheme` **函数体内**，是运行时读取） |
| 删掉它能否解环 | **不能** —— 即使强行删除，运行时仍有 **10 文件** 的强连通分量 |

### 1.2 勘误：**「顶层初始化依赖存在多个环」也是错误的**

P0 报告用的是**朴素行扫描**（未区分函数体），得出「2 个顶层环」。

**精确法结果：15 个文件「顶层初始化外部依赖」全部为 0，顶层零环。**

> ⚠️ 关键区别：**所有 `window.xxx` 读取都发生在函数体内**。
> 也就是说这套代码**没有初始化时序依赖**（这也解释了为什么 17 个 `<script>`
> 的加载顺序从未出过问题）。真实问题是**运行时函数引用的网状耦合**，不是初始化环。

### 1.3 核验方法（可复现）

P0 报告的方法缺陷：用「缩进 + 花括号计数」判断是否在函数内，但**没有任何文件有 IIFE 外壳**，
导致函数体深度被判为 1，与顶层混淆。

本轮方法：

```js
// 1. 完整剥离注释 / 字符串 / 模板串（保留换行以维持行号）
function sanitize(s){ /* 状态机：block / line / " / ' / ` */ }

// 2. 剥离后再算花括号深度
//    depth === 0  → 顶层初始化
//    depth  >  0  → 函数体内（运行时）
```

验证：`sanitize` 后所有文件最终深度均为 0（括号配平正确），
`panels.js` 顶层外部读取从「7 条」降到 **0 条**。

### 1.4 核验子项结果

| 核验项（P0.5 要求） | 结果 |
|---|---|
| `schema.js` / `panels.js` 真实行数 | ✅ **1267 / 1701 行**，与报告一致 |
| Git 基线是否一致 | ✅ `ef73d48..fd5a0df` 期间 `tools/` 与 `app/` **零改动** |
| 重算依赖图与 SCC | ✅ 已重算，见 §1.1 / §1.2 |
| 区分顶层初始化与运行时引用 | ✅ **已区分，结论完全不同于 P0** |
| 删 `schema→canvas` 后是否仍有环 | ✅ **仍有**，且该边实际不存在 |

**14 条行号引用抽查**：11 条精确命中，3 条指向数组起始行 `[`（内容在下一行），
属可接受的粗粒度引用，已记录不修改。

### 1.5 另一处数字勘误：控件库条目 **200 → 215**

P0 报告用 Node 沙箱只加载到 `presets.js`，得到 **200** 条。
浏览器里 `next-controls.js:38` 会执行 `BUILTIN_CONTROLS.unshift(...controls)`
再追加 **15** 条（5 类 × 3 变体）。

| 环境 | 条目数 |
|---|---|
| Node 沙箱（只到 presets.js） | 200 |
| **浏览器真实运行时** | **215** = 200 + 15 |

P1A 测试已按 **215** 断言，并单独验证 `NEXT_CONTROLS === 15`。

### 1.6 勘误小结（不阻断）

- 三条勘误都**不否定 P0 的核心判断**（控件库臃肿、面板全量重建、13 灯无源、字段多点定义仍成立）。
- 但**直接改了重构成败的关键前提**：原本以为「解一个环就能拆库」，
  实际是「运行时网状引用，靠拆文件解决不了」。
- **对 P1A 的影响**：`window.ICAR` 命名空间的价值**上升**了 ——
  既然没有初始化环，真正要做的是**给运行时引用建立边界**，而不是调整加载顺序。

---

## 二、测试基线（P0.5 要求）

### 2.1 改动前的真实基线

| 项 | 结果 |
|---|---|
| 套件数 | 36 |
| **TOTAL** | **PASS=4531  FAIL=1** |
| 断言数基线核对 | 36 套全部达到下限（下限合计 4470） |
| 失败套件 | `verify-next-library` |

### 2.2 唯一失败的定性（已证明是既有问题）

```
❌ Error: ENOENT: no such file or directory,
   open '...\stage\t11i-codex-20261012\production.png'
```

`stage/` 被 `.gitignore` 忽略，该文件不在版本控制内。

**证明方式**（不污染工作区）：创建临时 worktree 检出 `ef73d48`（P1A 改动前），
在**原始代码**上直接跑该套件：

```
PASS=90 FAIL=1      ← 与改动后完全一致
```

→ **该失败与 P1A 无关**，是既有环境缺失。已 `git worktree remove` 清理。

### 2.3 改动后的基线

| 项 | 结果 |
|---|---|
| 套件数 | **37**（+`verify-p1a-registry`） |
| **TOTAL** | **PASS=4588  FAIL=1**（+57 条新断言，失败仍是同一个既有问题） |
| 断言数基线核对 | ✅ 37 套全部达到下限（下限合计 **4527**） |
| JVM | 88 套 1365 项 失败 0 / 错误 0 / 跳过 0 |
| 构建守卫 | exit 0 |

### 2.4 基线更新的合规性

`-UpdateBaseline` 因存在既有 FAIL 而**拒绝写入**（守卫正确，未绕过）。
本轮采用**只增不改**方式把新套件加入 `expected-counts.json`：

```
更新前: 套件 36 个, 下限合计 4470
更新后: 套件 37 个, 下限合计 4527
既有条目改动: 0 条（脚本核验输出「✅ 零改动」）
```

**未降低任何既有门槛，未删除任何断言。**

### 2.5 序列化回归样本

| # | 样本 | 解析错误 | 两次序列化幂等 |
|---|---|---|---|
| 1 | `t_label`（文字） | 0 | ✅ |
| 2 | `gauge_parts`（含 `parts` 子树） | 0 | ✅ |
| 3 | `lamp_coolant`（含 `states` 三态） | 0 | ✅ |
| 4 | `bar_trackh`（含图片路径） | 0 | ✅ |

---

## 三、兼容性核验：**现有实现会丢弃未知字段**

### 3.1 三层实证

构造一份含未知字段的设计，过「读取 → 保存」：

| 层级 | 注入字段 | 保存后保留 |
|---|---|---|
| 设计根 | `futureTopLevel` | **❌ 丢弃** |
| 节点 | `futureNodeField` | **❌ 丢弃** |
| 嵌套 `gauge` | `futureGaugeField` | **❌ 丢弃**（`gauge` 子对象整体不存在） |

**根因**：`model.js:802` 的 `nodeToJson` 是**逐字段白名单**（显式写出 29 个字段），
且**没有** `Object.assign({}, n)` 或展开运算来兜底。

### 3.2 必须记录的事实

> **「现有代码本来就会丢弃未知字段」—— 不可宣称现有功能已支持保留。**
> 这是 P0.5 明确要求单独记录的一条。

**影响**：
- 未来的字段扩展**无法向后兼容**：新版本工具存的文件，用旧版本打开再保存，
  新字段会**静默消失**。
- 这是**重构的动机之一**，也是新架构必须解决的问题（但不能在 P1A 里改 —— 会动格式契约）。

### 3.3 其他兼容项

| 项 | 结果 |
|---|---|
| 图片路径 | ✅ `assetId` + `assets` 表机制正常；`bar_trackh` 的 `assetId` 为空（`trackStyle` 走代码绘制，符合设计） |
| 组合控件（`parts`） | ✅ 往返幂等 |
| 状态灯（`states`） | ✅ `statePid` + `states` 三态字段完整往返 |
| 旧设计文件重新载入 | ✅ 4 类样本均 0 错误、幂等 |

---

## 四、数据绑定语义：四层重新分级

按 P0.5 要求，**不得把「别名可解析」等同于「设备可用」**，
用可获得证据分为四层。19 个状态灯实测：

| 层级 | 含义 | 数量 | 判定依据 |
|---|---|---|---|
| **L1** | App 已实现数据源 | **6** | 别名可解析 + `BuiltInPids.kt` 有对应 PID 实现 |
| **L2** | App 仅识别别名，语义未验证 | **1** | 厂家模板 `tpl_oilPressure`，App 未实现 |
| **L3** | 实现存在但车辆可得性未确认 | **0** | 本轮无真车证据，不臆造 |
| **L4** | 工具与 App 都未实现 | **12** | 别名在两边都不存在（`resolvePid` 原样返回） |

### L1 的 6 个（真·可用）

| 灯 | 别名 | 通道 | 公式 |
|---|---|---|---|
| 水温灯 / 水温报警 | `obd.coolant` | `std_05` | `A-40` ℃ |
| 电池灯 / 充电提示 | `obd.voltage` | `std_42` | `((A*256)+B)/1000` V |
| 发动机灯 | `obd.engineFault` | `std_01` | MIL 状态 |
| 燃油报警 | `obd.fuel_level` | `std_2F` | `A*100/255` % |

### L4 的 12 个（纯占位符）

`obd.brakeFluid`、`obd.brakePad`、`obd.tpms`、`obd.airbag`、`obd.seatbelt`、
`obd.abs`、`obd.esp`、`obd.door`、`obd.washer`、`obd.service`、
`obd.laneKeep`、`obd.collision`

**这 12 个不是「缺数据源」，是「工具和 App 都没定义过这条通道」。**

### 关于 L3 的说明

P0.5 要求区分「车辆能否实际提供数据尚未确认」。
本轮**没有**真车证据，因此 L3 = 0 —— 这不是「不存在这种状态」，
而是「本轮无法用证据把任何条目放进 L3」。产品侧应把它保留为独立层级。

### 运行时表现（修正 P0 报告的表述）

| 节点类型 | 数据源不可用时 | 依据 |
|---|---|---|
| `gauge` | **跳过不建**，记入 `BuildReport.skippedNoPid` | `NodeTreeRenderer.kt:381-384` |
| `image`/灯 | **显示 `--`** | `:348` `showUnknown()` → `:586` → `StateImageView:82-91` 画 `UNKNOWN_TEXT`（`NodeStateResolver.kt:9` = `"--"`） |

P0 报告说「灯静默消失」**不准确**：灯显示 `--`，不消失。
`gauge` 才会消失（且仅当 `built==0` 时才给 UI 提示）。

---

## 五、新核心架构与依赖关系

### 5.1 新增模块（4 个文件 + 1 个试点）

```
tools/icarui/js/
  core/namespace.js                     window.ICAR 根命名空间
  registry/datasource-registry.js       数据源四层语义 + 可用性判定
  registry/control-registry.js          控件定义唯一事实源
  registry/controls/t_label.js          P1A 试点控件（唯一迁移项）
  adapter/legacy-adapter.js             新旧路径兼容桥（只读 + 等价比对）
```

### 5.2 加载顺序（`index.html`）

```
builtin-index → pinyin → spring
  → core/namespace.js          ← 新增，必须最前
  → schema → model → validate → presets
  → registry/datasource-registry.js
  → registry/control-registry.js
  → registry/controls/t_label.js
  → adapter/legacy-adapter.js
  → canvas → next-library/data → next-controls → data-bindings
  → panels → editor → zip → pack → control-files → app
```

### 5.3 依赖关系（实测，运行时引用）

| 新模块 | 依赖的旧模块 |
|---|---|
| `core/namespace.js` | **无**（纯独立） |
| `registry/datasource-registry.js` | `schema.js`（仅 `resolvePid`，且做了 `typeof` 兜底） |
| `registry/control-registry.js` | **无旧模块**（只用 `window.ICAR.core`） |
| `registry/controls/t_label.js` | `schema.js`（`createNode`/`NODE_TEXT`）+ `model.js` |
| `adapter/legacy-adapter.js` | `presets.js`（`BUILTIN_CONTROLS`）+ `model.js`（`nodeToJson`） |

**验收：新文件不进入任何 SCC**（实测输出 `新文件是否进入任何 SCC: 否 ✅`）。
旧 10 文件环保持原样 —— P1A 不改变旧结构，符合"只建基础设施"的定位。

### 5.4 关键设计：`ICAR.register` 的"旧名已存在就不动"

```js
register(domain, name, value, legacy) {
  ICAR[domain][name] = value;
  if (legacy && window[legacy] === undefined) window[legacy] = value;  // ← 只补空位
}
```

理由：兼容优先级是「**旧实现赢**」。若新代码覆盖 `window.renderPanels`，
而旧 `panels.js` 后加载又覆盖回去 —— 结果取决于加载顺序，
这种不确定性正是要消除的。所以**旧名已存在就一个字节都不动**。

---

## 六、`t_label` 新旧创建与序列化对比

### 6.1 两条路径

| 路径 | 调用 |
|---|---|
| 旧 | `BUILTIN_CONTROLS.find(c=>c.key==="t_label").make()` |
| 新 | `ICAR.registry.Control.build("t_label")` |

### 6.2 序列化结果（`nodeToJson` 后）

```json
{
  "id": "n…",            ← 随机，不参与比对
  "type": "text",
  "name": "标签文字",
  "x": 40, "y": 40, "w": 120, "h": 20,
  "rotation": 0, "scale": 1, "alpha": 255, "z": 99,
  "text": "标签",
  "font": {
    "family": "sans", "size": 7, "weight": 400,
    "italic": false, "letterSpacing": 0,
    "align": "center", "color": "#8FA0B8"
  }
}
```

**两条路径逐字段相等**（除随机 `id`）：

```
t_label legacy vs new serialize identically    ✅
text field equal                               ✅
font object equal                              ✅
position equal                                 ✅
size equal                                     ✅
z equal                                        ✅
internal __controlKey not serialized           ✅
```

### 6.3 旧行为未受影响

| 检查 | 结果 |
|---|---|
| `BUILTIN_CONTROLS` 条目数 | **215**（未变） |
| `NEXT_CONTROLS` 条目数 | 15（未变） |
| 全部 215 条 `make()` 可调用 | ✅ |
| 20 个关键旧全局符号 | **一个不少** |
| `renderPanels`/`renderProps`/`refreshAll`/`draw`/`commit`/`nodeToJson`/`createNode`/`resolvePid` | ✅ 全部仍在 |
| 旧路径创建 `t_label` → 序列化 → 解析 | ✅ 0 错误，往返保持 |

### 6.4 Registry 独立性验证

测试里**临时把编辑器相关全局置空**（`renderPanels`/`renderProps`/`refreshAll`/`draw`/`commit`），
再调 `registry.build("t_label")`：

```
registry.build does not need editor/panels (ok)   ✅
```

→ 满足 P1A 要求「Registry 不允许直接依赖整个编辑器或属性面板」。

---

## 七、新增 / 修改文件清单

### 新增（5）

| 文件 | 行数 | 说明 |
|---|---|---|
| `tools/icarui/js/core/namespace.js` | 96 | `window.ICAR` + `register`/`get` |
| `tools/icarui/js/registry/control-registry.js` | 208 | Control Registry |
| `tools/icarui/js/registry/datasource-registry.js` | 168 | 数据源四层语义 |
| `tools/icarui/js/registry/controls/t_label.js` | 129 | P1A 试点控件 |
| `tools/icarui/js/adapter/legacy-adapter.js` | 118 | 兼容适配层 |
| `tools/icarui/tests/verify-p1a-registry.js` | 143 | P1A 验收套件（57 断言） |

### 修改（2）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 新增 5 个 `<script>`（含注释说明顺序理由） |
| `tools/icarui/tests/expected-counts.json` | 仅新增 `verify-p1a-registry: 57`，既有 36 条零改动 |

**未改动**：`app/`（Android）全部、`tools/icarui/js/` 下所有既有文件、所有既有测试。

---

## 八、仍存在的兼容性风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| **R1** | **未知字段仍会被丢弃** | **高** | 现有 `nodeToJson` 是白名单。新架构**没有**修复它（会动格式契约）。下一阶段必须先决定：是"有意保持"还是"改为透传" |
| **R2** | 数据源四层语义是静态快照 | 中 | `APP_IMPLEMENTED_ALIASES` 是从 Kotlin 源码抄的常量，**不是运行时探测**。App 侧新增/删除通道时，两边会漂 |
| **R3** | 12 个 L4 灯仍可拖可绑 | 中 | P1A **只提供判定能力**，未接 UI。用户仍会看到它们可拖、可绑、显示 `--` |
| **R4** | 新 Registry 与 `BUILTIN_CONTROLS` 双份定义 | 中 | `t_label` 现在有两处定义。若只改一处会漂 —— 需在阶段 2 用测试保证等（已有 `compare()`，但只覆盖 `t_label`） |
| **R5** | 旧 10 文件环未解 | 中 | P1A 有意不动。真正的解环要等阶段 3 的渲染适配层 |
| **R6** | `verify-p1a-registry` 用固定数字 215/15 | 低 | 库条目数若变，此断言需同步。这是**有意的手动确认点**（防止条目静默增减） |
| **R7** | 旧设计文件的图片路径依赖 `assets/` 表 | 低 | 已验证 `bar_*` 走 `trackStyle` 时 `assetId` 为空是设计如此，非 bug |

---

## 九、下一阶段「完整控件库重组」实施方案

### 9.1 前置决策（必须先定）

**决策 A：未知字段是否改为透传？**

- **不改**（推荐 P1A 之后立即做）：新增 `preserveUnknown` 字段表，
  `nodeToJson` 在安全名单外**保留原值**。风险：可能把脏数据带进设计文件。
- **改但要可关**：加 `schema.unknownPolicy`，默认 `preserve`。

⚠️ 这条**不解决，后面所有控件的 `schema` 扩展都无法向后兼容**。
建议作为阶段 2 的**第一个单元**。

### 9.2 阶段划分

| 阶段 | 内容 | 验收 |
|---|---|---|
| **2.1** | 未知字段透传 + 回归样本 | 三层未知字段往返保留；37 套件全绿 |
| **2.2** | Control Registry 批量定义（26 个功能控件） | 每个控件 `compare()` 通过（新旧序列化逐字段相等） |
| **2.3** | 状态灯 19 个 + `slots` 声明 | 6 个 L1 可用、1 个 L2、12 个 L4 在 Registry 里**可查询** |
| **2.4** | 库重组：77 个静态素材移出控件库 | 库条目 215 → 138；旧设计与 `BUILTIN_CONTROLS` 引用不受影响 |
| **2.5** | 渲染适配层接管 `drawNode` 分派 | `cd_*`/`bar_*` 合并为 Track；像素级截图对比无差异 |
| **2.6** | 面板由 `schema` 驱动（先只读预览） | 新旧面板对同一节点显示一致 |

### 9.3 迁移顺序（低风险优先，来自 P0 §11 + 本轮实测）

| 序 | 控件 | 理由 | 已有覆盖 |
|---|---|---|---|
| 1 | `t_label` ✅ | **P1A 已完成** | `verify-font.js` |
| 2 | `t_unit`、`t_small` | 同 `t_label` 结构 | `verify-font.js` |
| 3 | `text`、`t_title`、`t_big` | 文字族收口 | 同上 |
| 4 | `gauge_0`~`gauge_7` | 8 条同构，一次验证循环生成路径 | `verify-props.js` |
| 5 | `g_speed`、`g_coolant` | 单 PID 单 style 最典型 | `verify-pid.js` |
| 6 | `cd_trackh/v` | 只有 `trackStyle`，验证渲染适配 | `verify-v291.js` |
| 7 | 6 个 L1 灯 | 有 states 但数据源真实 | `verify-lamp-state.js` |
| — | **暂缓** | `gauge_parts*`（parts 子树）、`bar_*`（path 兼容）、12 个 L4 灯 | — |

### 9.4 每单元的动作与验收

每个迁移单元固定四步：

1. 在 `registry/controls/` 加定义
2. **加 `compare()` 断言**（新旧序列化必须相等）
3. 跑该套件 + 全量 37 套
4. 只有全绿才进下一个

### 9.5 不做什么（红线）

- ❌ 不改 `icar.ui/2` 字段名与语义
- ❌ 不删 `bar_*` 及任何旧素材（存量设计按 `path` 引用）
- ❌ 不一次性删除旧全局符号
- ❌ 不引入框架/构建工具/ES Module
- ❌ 不改 Android App 数据契约

---

## 十、未验证边界

1. **未在真实浏览器里人工点过**新模块（只用自动化套件 + Node 沙箱）。
2. **L3 层级为空** —— 无真车证据，不是"不存在"。
3. **`--` 显示**来自源码阅读（`NodeTreeRenderer.kt`），未在设备上复验。
4. **性能未测**：P1A 未改热路径，`refreshAll` 全量重建问题仍存在（留待阶段 2.6）。
5. **未知字段透传方案**只给了方向，未做原型验证。
