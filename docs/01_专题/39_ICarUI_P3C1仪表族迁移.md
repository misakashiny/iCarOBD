# ICarUI P3C-1：六个常用仪表控件正式迁移

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P3C1` |
| 基线 | P3B `4eed7bc` |
| 结论 | 6 个仪表全部接管；Golden 6/6；**像素回归 10/10**；**5045 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`presets.js` 零改动 |

---

## 一、六个仪表迁移结果

| # | key | pid（别名） | 解析结果 | style | 尺寸 |
|---|---|---|---|---|---|
| 1 | `g_speed` | `obd.speed` | `std_0D` | 1 | 200×100 |
| 2 | `g_coolant` | `obd.coolant` | `std_05` | 0 | 120×120 |
| 3 | `g_fuel` | `obd.fuel_level` | `std_2F` | 0 | 120×120 |
| 4 | `g_volt` | `obd.voltage` | `std_42` | 4 | 150×150 |
| 5 | `g_load` | `obd.load` | `std_04` | 2 | 120×120 |
| 6 | `g_throttle` | `obd.throttle` | `std_11` | 3 | 200×100 |

**`gaugeFamily = { total: 6, registered: 6, skipped: 0 }`**

> ⚠️ 严格未触碰：`gauge_0~gauge_7`（外观预设，仍为 `declared:preset`）、
> `g_intake`、`g_boost`（不在 P3C-1 范围）、状态灯、轨道控件。

---

## 二、Golden 对比

### 2.1 做法

在**替换 `make()` 之前**抓取 6 条完整节点至 `fixtures/p3c1-gauge-golden.json`：

- 确定性验证：连调两次比对，**6 条全部 `stable=true`** 才落盘
- 仅排除 `id`
- 保留全部：`pid` / `rawPid` / `style` / `min` / `max` / `warnLow` / `warnHigh` /
  `x/y/w/h/z` / `font` / `label` / `unit`

### 2.2 结果

```
Golden match: 6/6
```

### 2.3 量程与阈值的来源（关键设计）

旧实现：

```js
const info = window.BUILTIN_PIDS[window.resolvePid(d.pid)] || {};
min/max/warnLow/warnHigh 全从 info 取，缺省 min=0 / max=100
```

**迁移保持同一条取值路径**，量程不写死字面量 ——
否则将来 `BUILTIN_PIDS` 更新时，Registry 与旧数据会分叉。

实测六条的默认量程：

| key | min | max | warnLow | warnHigh |
|---|---|---|---|---|
| `g_speed` | 0 | 260 | — | 120 |
| `g_coolant` | -40 | 215 | 60 | 105 |
| `g_fuel` | 0 | 100 | 15 | — |
| `g_volt` | 0 | 20 | 11.8 | 15.2 |
| `g_load` | 0 | 100 | — | — |
| `g_throttle` | 0 | 100 | — | — |

---

## 三、Registry / Bridge / Catalog 统计

| 指标 | 实测 | 任务书预估 | 一致 |
|---|---|---|---|
| **Registry bridged** | **22** | 22 | ✅ |
| Catalog `declared` | **8** | 8 | ✅ |
| Catalog `derived` | **22** | 22 | ✅ |
| Catalog `probe` | **185** | 185 | ✅ |
| Catalog `total` | **215** | 215 | ✅ |

`fallback = 0`、`missing = 0`。

`gauge_0~gauge_7` 的静态声明**保持不变**（测试逐条断言 `declared:preset`）。

---

## 四、数据绑定与 Schema 校验

### 4.1 数据槽声明

每个仪表声明**明确的数据槽**：

```js
slots: [{ key: "value", label: "显示值", pid: "obd.speed",
          dataType: "speed", required: true }]
```

| key | slot key | slot pid（别名） | dataType |
|---|---|---|---|
| `g_speed` | `value` | `obd.speed` | `speed` |
| `g_coolant` | `value` | `obd.coolant` | `temperature` |
| `g_fuel` | `value` | `obd.fuel_level` | `percent` |
| `g_volt` | `value` | `obd.voltage` | `voltage` |
| `g_load` | `value` | `obd.load` | `percent` |
| `g_throttle` | `value` | `obd.throttle` | `percent` |

**数据槽的 pid 与节点的 `rawPid` 一致**（逐条断言），
防止"槽里写 A、节点绑 B"的静默错配。

### 4.2 ⚠️ 重要发现：`pid` 被归一化，别名存在 `rawPid`

`model.js` 的 `createNode` 对 `NODE_GAUGE` 做：

```js
pid: window.resolvePid(rawPid),   // obd.speed → std_0D
rawPid: rawPid,                    // 保留别名
```

这是**既有设计**（源码注释写明了踩过的坑：
"预设建的表画布上写着 obd.rpm，导入的表写着发动机转速"）。

所以：
- 节点 `pid` = **解析后 id**（`std_0D`）
- 节点 `rawPid` = **用户写的别名**（`obd.speed`）
- 序列化时写回**别名**

测试按此断言，不是迁移引入的偏差。

### 4.3 channelStatus / vehicleStatus 语义正确

| 仪表 | dataCapability | channelStatus | vehicleStatus |
|---|---|---|---|
| 全部 6 个 | `bound` | **`implemented`** | **`unverified`** |

**这是本阶段最需要守住的区分**：

- `channelStatus=implemented` —— App 侧**有这条数据通道**（`BUILTIN_PIDS` 里有）
- `vehicleStatus=unverified` —— **这辆车是否真提供该数据，无证据**

**没有把"App 已实现 PID"当成"真车可用"。**

### 4.4 数据源缺失时的行为

实测 `build({pid:'obd.nonexistent'})`：

```json
{"built": true, "pid": "std_nonexistent", "min": 0, "max": 100,
 "issues": ["warn:pid-unresolved"]}
```

- ✅ **能构建**（不抛异常、不丢控件）—— 与旧行为一致
- ✅ 量程回落 `0..100` —— 与旧实现 `|| {}` 兜底一致
- ✅ 给出**可诊断信息** `warn:pid-unresolved`

未修改 App 的任何解析或显示逻辑。

### 4.5 校验项

| 检查 | 级别 | 实测 |
|---|---|---|
| 无 `pid` | error `no-pid` | ✅ 能抓到 |
| `pid` 解析不到 | **warn** `pid-unresolved` | ✅ 能抓到 |
| `min >= max` | error `bad-range` | ✅ 能抓到 |
| 尺寸为 0 | warn `zero-size` | ✅ 能抓到 |

> `pid` 解析不到用 **warn 而非 error** —— 旧行为是画一个空表、不崩，
> 这里保持一致，只是把"为什么是空的"说出来。

---

## 五、浏览器编辑与渲染验证

### 5.1 像素回归（10 案例）

用 `git worktree` 检出 **P3B 基线 `4eed7bc`**，与当前版本分别渲染取像素哈希（FNV-1a，300×300）：

| # | 案例 | P3B 基线 | P3C-1 | 一致 |
|---|---|---|---|---|
| 1 | `g_speed` 默认 | `b05e83dd` | `b05e83dd` | ✅ |
| 2 | `g_coolant` 默认 | `dfb193bb` | `dfb193bb` | ✅ |
| 3 | `g_fuel` 默认 | `585d3bc9` | `585d3bc9` | ✅ |
| 4 | `g_volt` 默认 | `e35b75a7` | `e35b75a7` | ✅ |
| 5 | `g_load` 默认 | `36644e34` | `36644e34` | ✅ |
| 6 | `g_throttle` 默认 | `8a3b50c8` | `8a3b50c8` | ✅ |
| 7 | `g_speed` **style=3** | `988197df` | `988197df` | ✅ |
| 8 | `g_coolant` **style=5** | `9a26df18` | `9a26df18` | ✅ |
| 9 | `g_volt` **自定义量程** 10~16 / 12~15 | `1abc8c4f` | `1abc8c4f` | ✅ |
| 10 | `g_fuel` **阈值为空** warnLow=null | `bab55b3` | `bab55b3` | ✅ |

**10/10 完全一致 → 无非预期差异。**

基准存 `fixtures/p3c1-gauge-pixels.json`。

### 5.2 编辑流程（10 项）

| # | 项 | 结果 |
|---|---|---|
| 1 | 从新控件库添加仪表 | ✅ `Control.byLegacyKey(k).build()` |
| 2 | 从旧入口添加相同仪表 | ✅ **新旧入口产出 JSON 完全一致**（6 条逐条断言）|
| 3 | 修改数据绑定 | ✅ `pid=obd.load` → `std_04`，量程跟着更新为 0~100 |
| 4 | 修改量程和警告阈值 | ✅ `min/max/warnLow/warnHigh` 全部持久化 |
| 5 | 修改仪表样式 | ✅ `style=6` 持久化 |
| 6 | 移动、缩放、旋转、图层 | ✅ `x/y/w/h/rotation/scale/z` 全部持久化 |
| 7 | 撤销、重做 | ✅ 节点数正确变化 |
| 8 | 保存、导出、重新打开 | ✅ 0 错误、3 个仪表、`rawPid` 与 `pid` 均正确 |
| 9 | 重新加载后的渲染 | ✅ 节点类型与绑定保持 |
| 10 | 模拟数据变化 | ✅ **运行时的值不进入序列化**（只影响绘制，不改设计 JSON）|

---

## 六、性能与副作用说明

| 项 | 结论 |
|---|---|
| **Catalog 获取元数据不调 `make()`** | ✅ 6 条由 Registry 派生（`source=derived`），走 `derived` 分支不探测 |
| **创建控件不修改无关设计数据** | ✅ `build()` 只产节点；`toV2Json(design)` 前后一致 |
| **Registry 不依赖属性面板** | ✅ `gauge-family.js` 只读 `ICAR` + `createNode` + `BUILTIN_PIDS` |
| **旧入口不保留独立创建逻辑** | ✅ `__bridgedTo` 已设；旧 `make` 被转调 |
| **不影响其它 209 条** | ✅ 全部仍可 `make()` |
| 性能 | 无变化（`build()` 与旧 `make()` 同复杂度；`resolvePid` 查表 O(1)）|

> 仍然存在的副作用：`probe` 的 185 条多数会写 `design.assets`（P2B.1 已实测 144 条），
> 由 `Catalog.build()` 的整轮快照/恢复兜底。本阶段未扩大该面（6 条仪表不写 assets）。

---

## 七、全量测试结果

| 层 | P3B | **P3C-1** |
|---|---|---|
| 套件 | 42 | **43** |
| 断言 | 4888 | **5045** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：
```
+ verify-p3c1-gauge-family   新增 157
合计 43 个套件 / 下限之和 5045
```

### 7.1 本轮调整的两条既有断言（结构性替代硬数字）

| 套件 | 断言 | 变化 | 理由 |
|---|---|---|---|
| `verify-p2b-catalog-ui` | 来源拆分 | 硬编码 `8/16/191` → **"三级都存在"** | 每迁一个族都要改，改为结构性断言 |
| `verify-p3b-container-family` | bridged / derived / probe | 硬编码 `16/16/191` → **"至少 16"** | 同上 |

**数字精确校验交由各阶段自己的套件守**（`verify-p3c1` 断言 `8/22/185`），
避免"改数字就算通过"。

---

## 八、修改文件清单

### 新增（4）

| 文件 | 说明 |
|---|---|
| `tools/icarui/js/registry/controls/gauge-family.js` | 6 条仪表定义（含数据槽）|
| `tools/icarui/tests/fixtures/p3c1-gauge-golden.json` | **独立旧版基准**（替换前）|
| `tools/icarui/tests/fixtures/p3c1-gauge-pixels.json` | 像素基准（10 案例）|
| `tools/icarui/tests/verify-p3c1-gauge-family.js` | **157 条断言**（分步 eval）|

### 修改（5）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 加载 `gauge-family.js`；bridge 追加 6 个 key |
| `tools/icarui/tests/verify-p2b-catalog-ui.js` | 来源断言改结构性 |
| `tools/icarui/tests/verify-p3b-container-family.js` | 数量断言改结构性 |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

> 注：`catalog.js` **本阶段零改动** —— 仪表通过既有的 `derived` 派生路径接入，
> 不需要新增任何 Catalog 逻辑。这是架构收敛的证据。

### 未改动（关键）

- **`app/`（Android）**、**`icar.ui/2` 格式**、**`presets.js`**
- `panels.js` / `model.js` / `schema.js` / `canvas.js`
- `catalog.js`（零改动）
- 其它 209 个条目的创建逻辑

---

## 九、新发现的 Legacy Behavior Debt

### D-06：`NODE_GAUGE` 的 `pid` 被归一化，`rawPid` 才是用户输入

| 项 | 内容 |
|---|---|
| **发现于** | P3C-1 |
| **位置** | `model.js` `createNode` 的 `NODE_GAUGE` 分支 |
| **现象** | 传 `pid: "obd.speed"` 建节点，读回来 `node.pid === "std_0D"`，`node.rawPid === "obd.speed"` |
| **性质** | **刻意设计，不是 bug**（源码注释写明这是为了统一"预设建的表 vs 导入的表"两种内部表示）|
| **影响** | 任何按 `node.pid` 比对别名的代码都会失败（本次写测试时就踩到，14 条断言先红后修）|
| **建议** | 在 `docs/04_架构与数据流.md` 的节点字段表里显式写清楚：<br>`pid` = 解析后 id（内部查表用）；`rawPid` = 用户别名（回显与序列化用）|

> 已追加到 [37_LegacyBehaviorDebt.md](37_LegacyBehaviorDebt.md)。

---

## 十、后续 `gauge_0~gauge_7` 预设迁移建议

### 10.1 它们的特殊性

| 项 | 六仪表（P3C-1） | `gauge_0..7` |
|---|---|---|
| 当前来源 | `probe` → 已迁 `derived` | **`declared`**（P2B 静态声明）|
| kind | `control` | **`preset`** |
| 数量关系 | 6 条独立功能 | **8 条同一功能的不同外观** |
| 绑定 | 各自的 pid | **全部 `std_0C`（rpm）** |

### 10.2 建议做法

**不建议把它们迁进 `gauge-family.js`**，理由：

1. 它们是 **preset**（外观预设），不是 control（功能控件），
   `Control Registry` 的语义是"控件定义"，把预设塞进去会让 `kind` 语义混乱。
2. 它们的唯一差异是 `style` 值，已经被 `gauge` 控件的 `style` 字段完全覆盖。

**推荐方案**：新建 `registry/presets/gauge-styles.js`（若需要），
用**预设注册表**而不是控件注册表；或者保持现状（`declared` + `kind:preset` 已正确）。

### 10.3 若确实要迁移，需同步改动

| 项 | 说明 |
|---|---|
| `CatalogMeta` 声明 | `gauge_0..7` 从 `declared` 迁到 `derived` |
| 统计断言 | 会变成 `declared 0 / derived 30 / probe 185` |
| `kind` 保持 | 必须仍是 `preset`，不能变 `control` |
| 八条 key 全部保留 | 不得合并成一条 |

### 10.4 下一步建议

按风险从低到高：

| 阶段 | 内容 | 数量 | 风险 |
|---|---|---|---|
| **P3C-2** | 状态灯（含 `statePid`） | 19 | 中（12 条是 L4 占位别名）|
| P3D | 轨道族 `cd_*` | 28 | 高（渲染复杂）|
| P3E | `next_*` 参数化 | 15 | 中（5×3 → 1 定义 + 15 声明）|
| P3F | 素材族 | 104 | 低（结构简单、数量大）|

---

## 十一、未验证边界

1. **未做真实鼠标拖动**（P2B.1 已测 `drop` 通道，仪表走同一条）
2. **未人工判读 UI**（模型无图像输入能力）
3. **无真车证据** → `vehicleStatus` 全为 `unverified`
4. **未在真实设备上验证数值刷新**（模拟数据变化只验证了"值不进入序列化"）
5. `ext` 透传仍未实施
