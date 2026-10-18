# ICarUI P4E-03：仪表数值映射、副 PID 与参数回填

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-19（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4E03` |
| 起点 | `114f1bc`（P4E-02）|
| 结论 | 三批次完成；**46 条新增断言全绿**；62 套 6206 断言 FAIL=0 |
| 范围 | 仅数据绑定类字段，**未迁移外观类**；**未改 `icar.ui/2` 契约** |

---

## 一、开发前审计结论

### 1.1 `valueLabels`（批次 A）

| 项 | 结论 |
|---|---|
| 数据格式 | `string[]`，索引 = `round(值)` |
| 上限 | `VALUE_LABELS_MAX = 32` |
| 归一化 | `normalizeValueLabels`：只留字符串、截断 32、**去尾部空项**、空表返 `null` |
| 序列化 | `model.js:836` `if (valueLabelsUsable) o.valueLabels = slice()` |
| 解析 | `model.js:78` `valueLabels: normalizeValueLabels(o.valueLabels)` |
| 旧面板编辑 | 逗号分隔单行输入（因属性面板「行高 ≤ 40px」约束，不用 textarea）|

**结论**：链路完整，可直接接入。

### 1.2 `extraPids`（批次 B）

| 项 | 结论 |
|---|---|
| 数据结构 | `string[]`，**存别名原样，不做 `resolvePid` 转换** |
| 序列化 | `model.js:830` `if (n.extraPids.length) o.extraPids = slice()` |
| 解析 | `model.js:71` `extraPids: o.extraPids || []` |
| 旧面板编辑 | `setNodeExtras`：`split(',').map(trim).filter(Boolean)` |
| **Android 支持** | ✅ `PidModels.kt:647` `var extraPids: MutableList<String>`；`NodeTreeRenderer.kt:423` / `DashRenderer.kt:160` 用 **`Store.findPid(it)`** 解析 → **接受别名** |

**关键差异（与主 PID 不同）**：

| | 主 PID | 副 PID |
|---|---|---|
| 字段 | `pid` + `rawPid`（双字段）| `extraPids`（单字段数组）|
| 存什么 | `pid`=**通道 id**，`rawPid`=别名 | **全部是别名** |
| 解析方 | 工具侧 `resolvePid` | **Android 侧 `findPid`** |

→ **不能把别名写进需要通道 id 的字段**：`extraPids` 本来就该是别名，本次保持。

### 1.3 `applyPidDefaults`（批次 C）

```js
window.applyPidDefaults = function () {
  const n = sel(); if (!n || n.type !== NODE_GAUGE) return;
  const info = BUILTIN_PIDS[n.pid];
  if (!info) { alert("PID 不在内置库里，无法回填。请手动填量程。"); return; }
  window.commit(() => {
    n.min = info.min; n.max = info.max;
    n.warnLow = info.warnLow === undefined ? null : info.warnLow;
    n.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
  }, "回填量程");
};
```

| 项 | 结论 |
|---|---|
| 只改哪些字段 | **仅 `min` / `max` / `warnLow` / `warnHigh`** |
| 是否碰外观 | ❌ 不碰 |
| 是否可撤销 | ✅ 走 `commit()` → 自动一条撤销记录 |
| PID 不在库时 | ✅ `alert` 明确提示，不静默改数据 |

**结论：直接复用，不复制默认参数库。**

### 1.4 Schema 面板可复用的组件

| 组件 | 复用情况 |
|---|---|
| 文本输入 | ✅ 默认分支已支持 `input[type=text]` |
| 枚举下拉 | ✅ |
| 布尔勾选 | ✅ |
| 颜色（色板+文本）| ✅ |
| **数组型（list）** | ❌ 新增 `type:"list"` 的 coerce + 回显分支 |
| **动作按钮** | ❌ 面板原无按钮机制，新增最小动作区 |

### 1.5 断言总数口径核对（任务第二部分第 5 项）

**确实存在口径差异，已核实**：

| 项 | 数值 |
|---|---|
| P4E-02 新增套件 | 38 |
| **旧套件 `verify-p4a-schema-props` 变化** | **70 → 72（+2）** |
| 全量总数变化 | 6122 → **6160** = +38 ✅（**总数只增 38，不含那 2 条**）|

**那 2 条是同一套件内部的**：原先用 `g_speed` 当"非轨道"样本断言 `resolve()` 返回 `null`，
仪表接入后前提失效，改用普通图片节点后**该套件自身从 70 涨到 72**（新增了 2 条与图片相关的断言分支）。

**结论**：总数 6160 = 6122 + 38，**没有凭空多出**；那 2 条是既有套件的内部演进，已如实记录。

### 1.6 持久化可行性检查（任务第二部分要求）

| 字段 | 能否通过现有 `icar.ui/2` 可靠持久化 | 结论 |
|---|---|---|
| `valueLabels` | ✅ 已在白名单，往返实测一致 | 可迁移 |
| `extraPids` | ✅ 已在白名单，往返实测一致 | 可迁移 |
| `applyPidDefaults` | ✅ 不涉及持久化，仅改已有字段 | 可迁移 |

**无字段因无法持久化而停止迁移。**

---

## 二、字段映射及数据契约说明

### 2.1 关键发现：两个字段"在数据里但没进 schema"

`valueLabels` 与 `extraPids` **本来就在**：

- `model.js` 的 `parseNode` 解构（71）与 `nodeToJson` 白名单（830）
- Android 的 `GaugeItem` 契约
- 旧属性面板的编辑入口

但 Registry 的 `gaugeSchema()` **只声明 12 个字段**，没有它们 → Schema 面板看不到。

**本次是「补登记」，不是「新增数据契约」**：字段名、类型、序列化路径全都没变。

### 2.2 最终字段表（14 个）

| # | 字段 | 类型 | 可编辑 | 说明 |
|---|---|---|---|---|
| 1 | `pid` | pid | ✅ | 主数据源（双字段）|
| 2 | `style` | enum | ✅ | 8 种样式 |
| 3 | `min` | number | ✅ | |
| 4 | `max` | number | ✅ | |
| 5 | `warnLow` | number | ✅ | 可空 |
| 6 | `warnHigh` | number | ✅ | 可空 |
| 7 | `label` | string | ❌ | **未序列化，不开放** |
| 8 | `unit` | string | ❌ | **未序列化，不开放** |
| 9 | `w` | number | ✅ | |
| 10 | `h` | number | ✅ | |
| 11 | `font.size` | number | ❌ | **未序列化，不开放** |
| 12 | `font.color` | color | ❌ | **未序列化，不开放** |
| 13 | **`valueLabels`** | **list** | ✅ | **P4E-03 新增** |
| 14 | **`extraPids`** | **list** | ✅ | **P4E-03 新增** |

### 2.3 list 类型的归一化规则（复用既有函数）

| 字段 | 规则 | 实现 |
|---|---|---|
| `valueLabels` | `normalizeValueLabels(parts)`：截断 32、去尾部空项、空表返 `null` | **复用** `schema.js` |
| `extraPids` | `parts.filter(Boolean)`：去空项，空数组保留 `[]` | 与 `setNodeExtras` 一致 |

**未另造一套规则。**

---

## 三、PID 回填逻辑说明

### 3.1 实现方式

在 `schema-panel.js` 的 `renderShell()` 中，**仅当 `schema.family === "gauge"`** 时追加一个动作区：

```js
if (schema && schema.family === "gauge") {
  container.appendChild(buildGaugeActions());
}
```

按钮点击 → 调用**既有的** `window.applyPidDefaults()` → `refresh(true)` + `refreshAll()`。

### 3.2 为什么这样做

| 要求 | 满足方式 |
|---|---|
| 优先复用 `applyPidDefaults` | ✅ **直接调用**，零复制 |
| 不复制 PID 默认参数库 | ✅ 无任何本地常量 |
| 只影响 min/max/warnLow/warnHigh | ✅ 由 `applyPidDefaults` 自身保证 |
| 不覆盖外观设置 | ✅ 实测外观 5 项全部不变 |
| 可撤销/重做 | ✅ 内部走 `commit()`，实测撤销回手改值、重做回库默认 |
| 同步刷新面板与画布 | ✅ `refresh(true)` + `refreshAll()` |

---

## 四、新增测试及全量测试结果

新增 `verify-p4e03-gauge-advanced.js` —— **46 断言，A–M 十三组**：

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 两字段已登记、类型为 list、可编辑 10 个 | ✅ |
| B | valueLabels 设置/清空/回显/序列化 | ✅ |
| C | **7 种非法输入均不崩溃**、超长截断 32 | ✅ |
| D | extraPids 别名语义、序列化一致 | ✅ |
| E | **主/副 PID 结构差异**、未凭空新增字段 | ✅ |
| F | 回填正确、**外观未被覆盖** | ✅ |
| G | 回填可撤销/重做 | ✅ |
| H | 两字段 Undo/Redo | ✅ |
| I | 导出 → 重导入一致 | ✅ |
| J | 旧面板三个函数仍在（被复用不是被替换）| ✅ |
| K | **6/6 仪表可编辑 10 字段** | ✅ |
| L | 状态灯 19 / 轨道 28 / 文字 12 / 容器 4 无回归 | ✅ |
| M | 状态灯 statePid 语义未受影响 | ✅ |

### 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **62 套 / 6206 断言 / FAIL=0** |
| Android JVM | **1365 项 0/0/0** |

### 4.1 一处既有断言的演进更新（非放宽门槛）

`verify-p4e02-gauge-schema.js` 的 A3/A4 断言原先固定校验「12 字段 / 可编辑 8 个」。
P4E-03 **按任务要求**补登记 2 个字段 → schema 变 14、可编辑变 10。

更新为 14/10 并在注释里写明演进原因。**断言数量不变（38），未删未降。**

---

## 五、修改文件清单

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/registry/controls/gauge-family.js` | **补登记** `valueLabels` / `extraPids` 两个 schema 字段（12→14）|
| `tools/icarui/js/ui/schema-props.js` | `PropertyValidator.coerce` 增加 `list` 类型；`listToText` 回显辅助；`EDITABLE.gauge` 8→10 |
| `tools/icarui/js/ui/schema-panel.js` | 新增 gauge 动作区（回填按钮）+ 头部族名补 gauge/imageState/container |
| `tools/icarui/tests/verify-p4e03-gauge-advanced.js` | 新增 46 断言 |
| `tools/icarui/tests/verify-p4e02-gauge-schema.js` | A3/A4 预期值按演进更新 |
| `tools/icarui/tests/expected-counts.json` | +46 |
| 文档 | 专题 60 + 验证记录 + P4E-GUI-001 更新 + 索引 |

**未改**：`app/`（Android）、`model.js`、`data-bindings.js`、`panels.js`（旧面板保留）、
`schema.js`（归一化函数被复用而非修改）、`icar.ui/2` 契约、P4R 草稿系统。

---

## 六、已知风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 板**新增了按钮区**，但仅 gauge 族有 | 低 | 其他族无按钮，不影响布局 |
| R2 | `extraPids` 空数组序列化为 `[]`（而非剔除）| 低 | 既有行为 `if (length)` 才写，空数组不写 |
| R3 | `valueLabels` 名字里不能有逗号 | 低 | 与旧面板一致（属性面板行高约束）|
| R4 | 回填依赖 `sel()`，无选中时静默无操作 | 低 | 与旧面板行为一致 |
| R5 | 外观类字段仍未迁移 | 中 | 不在本批次范围 |
| R6 | 4 个未序列化字段仍未开放 | 中 | 需先做序列化改造 |

---

## 七、`P4E-GUI-001` 待验收事项更新

原 8 项**保留**，新增 3 项（共 **11 项**，全部未验收）：

| # | 新增项 |
|---|---|
| ⑨ | 数值映射在面板中设置/清空，画布读数按映射显示 |
| ⑩ | 副参数在面板中编辑，保存重开后回显正确 |
| ⑪ | 「按 PID 库回填」按钮可点，回填后量程变化且可撤销；外观不变 |

`P4R-GUI-001`（5 项暂缓）与 `P4D-GUI-001`（7 项未验收）**均保持不变**。

> ⚠️ **自动化测试通过不等于 GUI 人工验收通过。** 上述 11 项须在真实浏览器逐项确认。

---

## 八、停止

**P4E-03 完成，停止。等待下一轮审查。**
