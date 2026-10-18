# ICarUI P2B：控件目录加固与全新控件库 UI

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P2B` |
| 基线 | P2A `ccae2e4` |
| 结论 | Catalog 加固完成；控件库三入口 UI 上线；**画布渲染零差异**；测试 4696/0 |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；215 个旧 key 全保留 |

---

## 一、Catalog 加固说明（第一部分）

### 1.1 从"全探测"到"静态元数据优先"

| | P2A | **P2B** |
|---|---|---|
| 数据来源 | 全部 215 条都调 `make()` | **声明优先**，未声明才探测 |
| 副作用风险 | 靠整轮快照规避 | 声明条目**完全不调 make()** |
| 初始化 | 50 次 × 100ms 盲轮询（5s） | 就绪检查 + 显式触发 + 20 次 × 100ms 兜底 |
| 失败处理 | 静默超时 | `diagnose()` 报原因，`recover()` 可恢复 |

**实测分布**：`declared 8 / probe 207`（本轮只迁移 `gauge_0..7`，符合"不一次性迁移全部"的约束）。

### 1.2 新增 API

| API | 作用 |
|---|---|
| `Catalog.bootstrap()` | 就绪则立即构建；否则登记待构建 |
| `Catalog.onAppReady()` | 由 `app.js` 初始化完成后**显式调用**（首选路径） |
| `Catalog.diagnose()` | 返回 `{ok, total, declared, probed, failed, issues[], builtAt}` |
| `Catalog.recover()` | 重建 + 返回诊断，用于初始化失败恢复 |

### 1.3 就绪触发（减少轮询依赖）

`app.js` 新增 `bootAfterInit()` 包装：

```js
function bootAfterInit() {
  try { init(); }
  finally {
    window.__ICAR_APP_READY = true;
    ICAR.registry.Catalog.onAppReady();   // ← 显式触发
  }
}
```

> ⚠️ **踩坑记录**：第一版直接 `var rawInit = init; init = function(){...}` —— 但 `init` 是**函数声明**
> （`function init(){}`），赋值会被忽略，结果 `init` 根本没跑（实测 `TOTAL=0`）。
> 改为 `bootAfterInit()` 包装后正常。

### 1.4 静态元数据机制

```js
CatalogMeta.declare("gauge_0", {
  name: "圆表",
  kind: "preset",
  category: "预设·仪表外观",
  nodeType: "gauge",
  renderer: "gauge",
  dataCapability: "bound",
  pid: "std_0C",                    // ← 静态通道，避免调 make()
  vehicleAvailability: "unverified",
});
```

**关键**：声明里带 `pid`，所以**算可用性也不需要 `make()`** —— 真正做到零探测。

### 1.5 安全兼容路径（不删除探测）

未声明的 207 条继续走原来的 `make()` 探测，`source: "probe"` 可查。
**目录不会因为"还没迁移"而缺项**（`verifyCoverage` 仍 215/215）。

---

## 二、控件库新分类及数量统计（第二、三部分）

### 2.1 三大类

| kind | P2A | **P2B** | 变化原因 |
|---|---|---|---|
| control 功能控件 | 90 | **82** | `gauge_0..7` 移出（见 §2.2） |
| preset 预设 | 21 | **29** | `gauge_0..7` 移入 |
| asset 素材 | 104 | 104 | 不变 |
| **合计** | 215 | **215** | **不变** |

### 2.2 `gauge_0~gauge_7` 语义修正（第二部分明确要求）

**修正前**：8 条独立 `control`（功能控件）
**修正后**：**`preset`（预设·仪表外观）**

**依据**：

| key | PID | 量程 | 唯一区别 |
|---|---|---|---|
| gauge_0..7 | 全部 `std_0C` | 全部 0~8000 | **只有 style 0~7** |

它们绑同一个 PID、同一套量程，**唯一区别是 8 种样式** →
按「同一功能的不同外观优先归入预设」的原则应属预设。

**硬约束全部满足**：8 个 key 仍可查、可拖、可创建；`BUILTIN_CONTROLS` 一个元素未动。

### 2.3 数据能力 ≠ 车辆可用性（第二部分明确要求）

新增 `vehicleAvailability` 字段，与 `dataCapability` 分离：

| 字段 | 含义 | `gauge_0` 的值 |
|---|---|---|
| `dataCapability` | 这个控件**读不读数据** | `bound` |
| `availability` | 通道在 App 里**有没有实现** | **`L1`**（`std_0C` 存在） |
| `vehicleAvailability` | **车辆是否真的提供该数据** | **`unverified`** |

> **这就是 P2B 强调的区分**：`gauge_0` 的通道是 L1，但车辆可用性仍是 `unverified` ——
> **没有把"App 已实现 PID"当成"真车可用"**。

### 2.4 四层分布（全部 215 条）

| 层级 | 数量 | 说明 |
|---|---|---|
| `implemented`（L1） | **27** | App 有通道，**不保证车辆支持** |
| `alias-only`（L2） | **3** | 厂家模板 `tpl_*` |
| `unverified`（L3） | **8** | `gauge_0..7`（声明为保守档） |
| `unimplemented`（L4） | **28** | App 无数据源 |
| `n/a` | 149 | 不读数据（素材/文字/容器） |

---

## 三、UI 改造前后

### 3.1 改造前

左栏两个面板：`#assets`（控件与素材**混在一起**）+ `#tree`。
用户要翻过 104 个静态素材才能找到能显示数据的控件。

### 3.2 改造后

左栏三个面板，**新增 `#catalog`**：

```
┌─────────────────────────┐
│ 资源库                  215 │
├─────────────────────────┤
│ [控件 82] [预设 29] [素材 104] │  ← 三入口
├─────────────────────────┤
│ 🔍 搜索名称 / key / 标签    │  ← 支持拼音
├─────────────────────────┤
│ ▾ 仪表            24      │  ← 分类折叠
│  ┌──────┐ ┌──────┐       │
│  │◉ 车速│ │◉ 水温│       │
│  │g_speed│ │g_coolant│   │
│  │App已实现│ │App已实现│  │  ← 四层徽标
│  └──────┘ └──────┘       │
└─────────────────────────┘
```

### 3.3 增量不替换

| 项 | 状态 |
|---|---|
| `#catalog`（新） | 三入口视图 |
| `#assets`（旧） | **原样保留**，拖拽/分类/素材管理一行未改 |
| `#tree`（旧） | 原样保留 |

两个面板是**同一份 215 条数据的两种视图**，用户用哪个都行。

### 3.4 截图

| 文件 | 内容 |
|---|---|
| `stage/p2b-control.png` | 控件页（82 条 / 6 分类） |
| `stage/p2b-preset.png` | 预设页（29 条 / 3 分类） |
| `stage/p2b-asset.png` | 素材页（104 条 / 8 分类） |
| `stage/p2b-full.png` | 整页布局 |

> ⚠️ **本 AI 模型不支持图像输入**，无法自行判读截图内容。
> 交互行为已由自动化测试逐条验证（见 §五），视觉效果需人工确认。

---

## 四、数据能力提示（第四部分）

四层徽标文案严格按 P2B 要求：

| 层级 | 徽标 | 悬停说明 |
|---|---|---|
| L1 | **App 已实现**（蓝） | "App 侧有这条数据通道。⚠️ 不代表这辆车一定提供该数据。" |
| L2 | **仅别名/模板**（橙） | "只有别名或厂家模板，没有完整实现，可能取不到值。" |
| L3 | **待验证**（灰） | "数据能力存在，但这辆车是否真有该数据尚未验证。" |
| L4 | **App 未实现**（红） | "App 侧没有这条数据源，动态绑定无法生效。历史设计与拖拽能力保留。" |

**L4 的视觉处理**：`opacity: 0.62` + 虚线边框 —— 明显弱化但**仍可拖拽**
（P2B 要求：不能破坏旧设计文件或历史拖拽能力）。

实测：`BADGES=37`、`L4_ITEMS=13`（素材页外）、控件页 L4 可见。

---

## 五、新旧 API 映射

### 5.1 Catalog 元数据字段

| P2A 字段 | P2B 变化 |
|---|---|
| `key` / `name` / `kind` / `category` / `nodeType` / `renderer` / `legacyKey` / `dataCapability` / `availability` / `tags` / `thumbnail` | 不变 |
| — | **新增 `vehicleAvailability`**（车辆可用性，与通道可用性分离） |
| — | **新增 `source`**（`declared` / `probe`，便于统计迁移进度） |

### 5.2 查询 API

| API | 变化 |
|---|---|
| `build()` / `stats()` / `get()` / `has()` / `keys()` / `all()` / `byKind()` / `byCategory()` / `byAvailability()` / `categories()` / `search()` / `verifyCoverage()` | 不变 |
| — | **新增 `bootstrap()` / `onAppReady()` / `diagnose()` / `recover()`** |

### 5.3 新 UI API

| API | 作用 |
|---|---|
| `ICAR.ui.CatalogPanel.render()` | 渲染（幂等） |
| `.setTab("control"\|"preset"\|"asset")` | 切换入口 |
| `.setQuery(q)` | 搜索（支持拼音） |
| `.toggleCat(cat)` | 分类折叠 |
| `.addToCanvas(key)` | 双击添加 |

---

## 六、实际浏览器交互测试结果

| 项 | 结果 |
|---|---|
| 控件页 | **82 条 / 6 分类** ✅ |
| 预设页 | **29 条 / 3 分类** ✅ |
| 素材页 | **104 条 / 8 分类** ✅ |
| 中文搜索「转速」 | 82 → **1 条** ✅ |
| 拼音搜索「zhuansu」 | **命中** ✅ |
| 清空搜索 | 恢复 82 条 ✅ |
| 分类折叠 | `display: none` ✅ |
| 分类展开 | 恢复显示 ✅ |
| 可用性徽标 | **37 个** ✅ |
| L4 弱化标记 | **13 个** ✅ |
| 缩略图 | 渲染 ✅ |
| 面板可滚动 | `scrollable` ✅ |
| 旧 `#assets` 面板 | **仍有内容** ✅ |
| 旧 `#tree` 面板 | 保留 ✅ |

---

## 七、完整回归测试结果

| 层 | P2A | **P2B** |
|---|---|---|
| 套件 | 38 | **39** |
| 断言 | 4639 | **4696** |
| FAIL | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |
| 构建守卫 | exit 0 | **exit 0** |

基线变更（`-UpdateBaseline` 官方流程）：
```
↑ verify-p2a-catalog    50 → 52
+ verify-p2b-catalog-ui     新增 55
合计 39 个套件 / 下限之和 4696
```

### 7.1 本轮修复的 4 个既有套件回归（重要）

改造过程中一度打破 4 个套件（10 条断言），全部已修：

| 套件 | 失败原因 | 修法 |
|---|---|---|
| `verify-features`（3 条） | 三个面板挤压，1024/600/390 三宽度全部失败 | `#assets` 的 `calc(100% - 160px)` 改为弹性布局 |
| `verify-fix`（1 条） | 控件树高度被压缩 | 同上 |
| `verify-layout`（1 条） | 我引入 `border-radius: 5px` 成为第 5 档 | 改为既有档位 `4px` |
| `verify-p2a-catalog`（5 条） | **语义修正导致的预期变化** | 更新断言 + 写明理由（见下） |

### 7.2 关于 `verify-p2a-catalog` 的断言更新（必须说明）

这不是放宽门槛，而是**语义改进后的同步**：

| 断言 | P2A | P2B | 理由 |
|---|---|---|---|
| control 数 | 90 | **82** | `gauge_0..7` 移出（-8） |
| preset 数 | 21 | **29** | `gauge_0..7` 移入（+8） |
| 「所有 preset 有子树」 | 严格要求 | 允许"声明为样式预设" | `gauge_0..7` 是单节点样式，无 parts/children |
| 仪表分类数 | 32 | **24** | 同上（-8） |
| L1 数量 | 35 | **35** | 不变（`gauge_*` 通道仍是 L1） |

**替代保障**：新增 `verify-p2b-catalog-ui.js` 的 55 条断言里，
专门加了「`gauge_0..7` 全部是 preset」「全部 `vehicleAvailability=unverified`」
「四层都有分布」「L4 条目都有数据能力」等断言守住新语义。

---

## 八、修改文件清单

### 新增（3）

| 文件 | 行数 | 说明 |
|---|---|---|
| `tools/icarui/js/registry/catalog-metadata.js` | 131 | 静态元数据注册表 |
| `tools/icarui/js/registry/catalog-declarations.js` | 76 | `gauge_0..7` 声明 |
| `tools/icarui/js/ui/catalog-panel.js` | 322 | 三入口 UI |
| `tools/icarui/tests/verify-p2b-catalog-ui.js` | 158 | 55 条断言 |

### 修改（6）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/registry/catalog.js` | 静态元数据优先 + `vehicleAvailability` + `bootstrap/onAppReady/diagnose/recover` |
| `tools/icarui/js/app.js` | **仅** `init` 调用点改为 `bootAfterInit()`（+18 行，`init` 本身未动） |
| `tools/icarui/index.html` | 新增 2 个 `<script>` + `#catalog` 容器 + 触发器改 `bootstrap()` |
| `tools/icarui/css/studio.css` | 新面板样式（`cp-` 前缀）+ 左栏三面板布局修正 |
| `tools/icarui/tests/verify-p2a-catalog.js` | 5 条断言按语义修正更新（附理由注释） |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 未改动（关键）

- **`app/`（Android）全部**
- **`icar.ui/2` 格式与字段语义**
- **`BUILTIN_CONTROLS` 的内容与顺序**
- `presets.js` / `panels.js` / `model.js` / `schema.js` / `canvas.js`（**五个核心文件零改动**）
- 旧 `#assets` 面板的渲染与拖拽逻辑

---

## 九、画布渲染对比（第五部分要求）

用同一组 10 个代表性控件（`gauge_0` / `gauge_3` / `g_speed` / `t_label` / `lamp_coolant` /
`cd_trackh` / `bar_trackh` / `gauge_parts` / `next_speed_oem` / `img_ring`）
分别在 **P2A（`ccae2e4`）** 与 **P2B（当前）** 渲染，取像素哈希（FNV-1a）：

| 控件 | P2A 哈希 | P2B 哈希 | 一致 |
|---|---|---|---|
| gauge_0 | `975ec215` | `975ec215` | ✅ |
| gauge_3 | `a7d72f0d` | `a7d72f0d` | ✅ |
| g_speed | `acf72d1` | `acf72d1` | ✅ |
| t_label | `fe08f69` | `fe08f69` | ✅ |
| lamp_coolant | `fed3369a` | `fed3369a` | ✅ |
| cd_trackh | `24965c0f` | `24965c0f` | ✅ |
| bar_trackh | `3a4713ca` | `3a4713ca` | ✅ |
| gauge_parts | `9dc85987` | `9dc85987` | ✅ |
| next_speed_oem | `b89f6389` | `b89f6389` | ✅ |
| img_ring | `295f26b7` | `295f26b7` | ✅ |

**10/10 完全一致 → 画布渲染零差异。** 无需解释任何差异。

---

## 十、尚未解决的风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 207/215 仍在走探测 | 中 | 迁移是渐进的，`source` 字段可查进度 |
| R2 | 探测路径仍有 `make()` 副作用风险 | 中 | 已有整轮快照保护，但脆弱；全部声明后即可移除 |
| R3 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃（P2A 专题 32 方案待批准） |
| R4 | 三面板挤压下的极小宽度未验 | 中 | `verify-features` 覆盖 1024/600/390，更窄未测 |
| R5 | 新 UI 拖拽只落在 `dataTransfer` | 中 | 依赖旧面板的 drop 处理；两者交互未做联合验证 |
| R6 | `vehicleAvailability` 无真车证据 | 高 | 全部 `unverified`/`implemented` 都只是"通道存在"，非"车辆可用" |
| R7 | 徽标只覆盖有数据能力的条目 | 低 | 素材类不显示徽标（`n/a`） |
| R8 | 截图未人工判读 | 中 | AI 无图像输入能力，视觉需人工确认 |

---

## 十一、下一阶段 Registry 正式迁移建议

### 11.1 迁移顺序（按风险递增）

| 阶段 | 内容 | 数量 | 验收 |
|---|---|---|---|
| **P3-1** | 文字族声明（`text`/`t_title`/`t_unit`/`t_big`/`t_small`/`t_warn`/`t_ok`/`t_bigunit`） | 8 | 声明后 `source=declared`；产出节点与旧路径逐字段相等 |
| **P3-2** | 容器族（`group`/`box_card`/`box_row`/`box_col`/`box_h1`/`box_h2`/`box_note`） | 7 | 同上 |
| **P3-3** | 常用仪表（`g_speed`/`g_coolant`/`g_fuel`/`g_volt`/`g_load`/`g_throttle`） | 6 | 同上 |
| **P3-4** | 状态灯 19 条（含 `statePid` 静态声明） | 19 | 6 个 L1 / 1 个 L2 / 12 个 L4 分类不变 |
| **P3-5** | 轨道族（`cd_*` 28 条） | 28 | 渲染零差异 |
| **P3-6** | `next_*` 参数化（5×3 → 1 定义 + 15 声明） | 15 | 15 个 key 全保留 |
| **P3-7** | 素材族（`img_*`/`bar_*` 104 条） | 104 | 路径不变 |

**建议每阶段单独一卡**，每卡都要满足：
- 声明条目的 `compare()` 与旧路径逐字段相等
- `source=declared` 数量按预期增加
- 39 套件全绿、断言数不减

### 11.2 全部声明后可做的事

1. **彻底移除探测机制** —— `build()` 不再调任何 `make()`，零副作用
2. **移除整轮快照恢复** —— 不再需要
3. **`bootstrap` 可去掉兜底轮询** —— 完全依赖 `onAppReady()`
4. **启动性能提升** —— 省 215 次工厂调用

### 11.3 不要做的事

- ❌ 不要为了"声明得快"而跳过 `compare()` 等价验证
- ❌ 不要在声明里猜字段（拿不准的留给探测）
- ❌ 不要同时改右侧属性面板（P2B 明确禁止，仍有效）
- ❌ 不要在 Android 侧未验证前实施 `ext` 透传

---

## 十二、未验证边界

1. **截图内容未人工判读** —— 本 AI 无图像输入，UI 视觉需人工确认。
2. **新 UI 的拖拽未做端到端验证** —— 只验证了 `dataTransfer` 设置，未验证落到画布的完整链路。
3. **更窄宽度（< 390px）未测**。
4. **L3 层仍无真车证据**。
5. **`Catalog.build()` 耗时未测**（声明条目已不调 `make()`，但 207 条仍在探测）。
