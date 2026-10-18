# P4E-01 仪表控件及 PID 数据绑定审计报告

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-19（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4E01`（**只读审计**）|
| 起点 | `0409204`（P4D-01）|
| 源码修改 | **无**（本阶段只读；工作树干净）|
| 结论 | 仪表族 6 个控件**未接入 Schema 面板**；发现 **3 项风险**，其中 1 项为 P4D-01 引入的方法级缺陷 |

---

## 一、前置检查

| 项 | 结果 |
|---|---|
| Git HEAD | `0409204` |
| 工作树 | 干净（仅用户 zip 与测试图未跟踪）|
| `P4R-GUI-001` 卡片 | ✅ 存在，2/7 已确认，5 项暂缓 |
| **`P4D-GUI-001` 卡片** | ❌ **不存在**（见风险 R5）|
| 数据契约 | 本阶段未改 |

---

## 二、仪表控件清单

### 2.1 Registry 全貌（69 条）

| render.mode | 数量 | 说明 |
|---|---|---|
| `text` | 12 | 文字族 |
| `container` | 4 | 容器族 |
| **`gauge`** | **6** | **仪表族（本次审计对象）** |
| `state` | 19 | 状态灯（P4D-01 已完成）|
| `track` | 28 | 条形轨道族 |
| **合计** | **69** | |

### 2.2 仪表族 6 个控件

| # | Registry key | 名称 | style | 默认 PID（内部 id）| 对应别名 | parts |
|---|---|---|---|---|---|---|
| 1 | `g_speed` | 车速表 | 1（数字）| `std_0D` | `obd.speed` | 0 |
| 2 | `g_coolant` | 水温表 | 0（圆表）| `std_05` | `obd.coolant` | 0 |
| 3 | `g_fuel` | 油量表 | 0（圆表）| `std_2F` | `obd.fuel_level` | 0 |
| 4 | `g_volt` | 电压表 | 4（双数据上下）| `std_42` | `obd.voltage` | 0 |
| 5 | `g_load` | 负荷表 | 2（条形）| `std_04` | `obd.load` | 0 |
| 6 | `g_throttle` | 油门表 | 3（线型图）| `std_11` | `obd.throttle` | 0 |

> **注**：`gauge_parts`（拼装圆表）在 `presets.js` 中存在但**未注册到 Registry**，属于旧控件库路径，不在本次 69 条内。

### 2.3 Schema 字段（6 个完全一致，12 个字段）

```
pid, style, min, max, warnLow, warnHigh, label, unit, w, h, font.size, font.color
```

---

## 三、PID 字段映射与数据流

### 3.1 三层字段语义

| 层 | 位置 | 值形态 | 用途 |
|---|---|---|---|
| ① Registry 默认 | `DEFS[].pid` | 内部 id（`std_0D`）| 建节点初值 |
| ② 用户实例 · 原样写法 | `node.rawPid` | **别名**（`obd.speed`）| 下拉框回显 |
| ③ 用户实例 · 解析后 | `node.pid` | **内部 id**（`std_0D`）| 渲染/查表 |
| ④ 序列化写出 | JSON `pid` | **别名**（`ALIAS_OF[pid]`）| 设计文件 |

### 3.2 核心函数

```js
// schema.js:1522-1530
window.ALIAS_OF = {};                                   // id → 别名
window.resolvePid = name => PID_ALIASES[name] || name;  // 别名 → id
```

**实测语义**：

| 输入 | 输出 |
|---|---|
| `resolvePid('obd.rpm')` | `'std_0C'` ✅ |
| `resolvePid('std_0C')` | `'std_0C'`（幂等）|
| **`resolvePid('not.a.pid')`** | **`'not.a.pid'`**（原样返回，**不报错**）|
| `resolvePid('')` | `''` |

### 3.3 序列化

```js
// model.js:825
o.pid = window.ALIAS_OF[n.pid] || n.pid;
```

- 若 `n.pid` 是 id → 写出别名
- 若 `n.pid` 已是别名/无效值 → 原样写出

### 3.4 双字段写入的两条路径（**关键差异**）

| 路径 | 位置 | 行为 | 评价 |
|---|---|---|---|
| **旧面板** | `data-bindings.js:36` `assignControlBinding()` | `n.rawPid = raw; n.pid = resolvePid(raw)` | ✅ **正确** |
| **状态灯（旧）** | `app.js:1790` `setNodeStatePid()` | `n.rawStatePid = raw; n.statePid = resolvePid(raw)` | ✅ **正确** |
| **P4D-01 新路径** | `schema-props.js` `normalizeStateLampBinding()` | 只对 `statePid` 生效；`resolved` 为假时不更新 | ⚠️ 见 R2 |
| **Schema 面板 gauge** | **不存在** | 仪表未接入 Schema 面板 | ❌ 未实现 |

---

## 四、旧面板 vs Schema 面板：功能对照

### 4.1 现有 Schema 面板接管范围

```js
EDITABLE = {
  track:      4 个字段,
  text:       5 个字段,
  container:  6 个字段,
  imageState: 11 个字段,   // P4D-01
}
```

**没有 `gauge` 分类** —— 6 个仪表控件在 Schema 面板中**完全不接管**（实测 `resolve()` 返回 null）。

### 4.2 旧面板 `gaugeFields()` 覆盖的 15 项功能

| # | 功能 | 字段 | Schema 面板 | 备注 |
|---|---|---|---|---|
| 1 | PID 下拉选择 | `rawPid`/`pid` | ❌ | 走 `bindingPidOptions` 分组 |
| 2 | PID id 文本输入 | 同上 | ❌ | 允许自定义 |
| 3 | 仪表样式 | `style`（0-7）| ❌ | 8 种 |
| 4 | 量程 min/max | `min`,`max` | ❌ | |
| 5 | 数值映射 | `valueLabels` | ❌ | 逗号分隔枚举 |
| 6 | warnLow | `warnLow` | ❌ | 可空 |
| 7 | warnHigh | `warnHigh` | ❌ | 可空 |
| 8 | 卡片外框 | `cardStyle` | ❌ | 9 种 |
| 9 | 底框显示 | `card.show` | ❌ | |
| 10 | 底框透明度 | `card.alpha` | ❌ | 数字+滑块 |
| 11 | 底框圆角 | `card.radius` | ❌ | |
| 12 | 霓虹档位 | `neonPreset` | ❌ | 5 档 |
| 13 | 指针环 | `ringStyle` | ❌ | |
| 14 | 环段数 | `ringSegments` | ❌ | |
| 15 | 副参数 | `extraPids` | ❌ | 逗号分隔 |
| 附 | 按 PID 库回填 | 按钮 | ❌ | `applyPidDefaults()` |

### 4.3 Schema 声明的 12 字段 vs 序列化实际字段

**实测不一致**（重要发现）：

| 仪表 | schema 12 字段 | 序列化实际字段数 | 缺失的序列化字段 |
|---|---|---|---|
| `g_speed` | pid,style,min,max,warnLow,warnHigh,**label**,**unit**,w,h,**font.size**,**font.color** | 16 | `label`/`unit`/`font.size`/`font.color` |
| `g_coolant` | 同上 | 17 | 同上（有 warnLow/High）|
| `g_fuel` | 同上 | 16 | 同上 |
| `g_volt` | 同上 | 17 | 同上 |
| `g_load` | 同上 | 15 | 同上 + 无 warnLow/High |
| `g_throttle` | 同上 | 15 | 同上 + 无 warnLow/High |

**结论**：`label`、`unit`、`font.size`、`font.color` 这 4 个 schema 字段**未进入 v2 序列化**。
若在 Schema 面板开放它们，会出现「改了保存不住」的静默失效。

---

## 五、数据更新流程与 Android 契约

### 5.1 工具侧（浏览器）

| 环节 | 实现 |
|---|---|
| 数据源注册 | `ICAR.registry.DataSource`（`TIER/declare/resolve/isUsable/implementedAliases`）|
| PID 库 | `window.BUILTIN_PIDS`（含 min/max/warnLow/warnHigh/unit）|
| 别名表 | `window.PID_ALIASES` |
| 预览数据 | 工具内示例数据（非真实车辆）|

### 5.2 Android 侧契约（由 `icar.ui/2` 承载）

| 字段 | 契约 |
|---|---|
| `pid` | **别名**（`App DesignFile.resolvePid` 认别名）|
| `statePid` | **别名**（同上）|
| `style/min/max/warnLow/warnHigh` | 数值 |
| 未知 PID | App 显示 `--`；未绑定则不显示读数 |

> **本阶段未改这些契约**，且后续也不得改。

---

## 六、边界情况评估

| 场景 | 工具侧表现 | 风险 |
|---|---|---|
| 实时数据刷新 | 工具用示例数据，真实刷新在 App | — |
| 断连 | 工具无连接概念 | — |
| **无效 PID** | `resolvePid` 原样返回 → `pid` 变成无效字符串 | ⚠️ **R1** |
| 未绑定（空 PID）| `pid=''`，序列化剔除空 pid | ✅ 已处理 |
| 未知值 | `STATE_NAMES` 只有 normal/warn/critical；UNKNOWN 由 App 判定 | ⚠️ **R4** |
| 数据异常（超出量程）| 工具预览不校验 | — |

---

## 七、风险清单（按优先级）

### 🔴 R1（P0）：Schema 面板直接写 `pid` 会破坏双字段语义

**证据**（实测）：

```
改前: pid=std_0D  rawPid=obd.speed
写入 'obd.rpm' 后:
  pid    = obd.rpm     ← 别名进了通道位（应为 std_0C）
  rawPid = obd.speed   ← 未更新（应为 obd.rpm）
  序列化  = obd.rpm
```

**后果**：
- 工具侧查表 `BUILTIN_PIDS[pid]` 拿不到 `obd.rpm`（那是别名）
- 重载后 `pid` 停留在别名，`rawPid` 也被覆盖成别名 → **双字段同时错**

**对比**：旧面板走 `assignControlBinding()`，会正确设置两个字段。
**若 P4E 直接照搬 P4D 的 `PropertyAccessor.set(n,'pid',v)`，会重演状态灯那次「灯永远是暗的」的事故。**

### 🟠 R2（P1）：P4D-01 的 `normalizeStateLampBinding` 在无法解析时不更新 statePid

**现状**：`resolvePid` 永不返回空（无效别名原样返回），所以 `if (resolved) node.statePid = resolved;` **永远成立**。
因此**不存在"残留旧通道"**（已实测确认），但会**把无效别名写进 statePid**。

**结论**：任务第六部分怀疑的「残留旧通道 ID」**不成立**；实际问题是「无效值直接进通道位」，两者都不该发生。

### 🟠 R3（P1）：schema 声明的 4 个字段未序列化

`label` / `unit` / `font.size` / `font.color` 在 schema 里，但 `nodeToJson` 不写、`parseNode` 不读。
**任何面板开放这 4 个字段 = 改了保存不住。**

### 🟡 R4（P2）：未知数据状态（UNKNOWN）无独立配置

`STATE_NAMES` 仅 normal/warn/critical。任务要求「未知数据状态的显示配置」——
**当前只能在 App 侧判定，工具无对应字段**。若要做，属于**新增字段 = 改数据契约**，须单独评审。

### 🟡 R5（P2）：`P4D-GUI-001` 卡片缺失

P4D-01 的 7 项待验收只记在专题 57 与任务卡，**没有独立待验收卡片**。
任务第一部分要求保留 `P4E-GUI-001` 和 `P4D-GUI-001` 卡片 —— 后者需补建。

---

## 八、推荐分批实施顺序

### 批次 1（P0 前置）：修正 PID 写入语义 · 不改 UI

| 项 | 内容 |
|---|---|
| 目标 | 让 `PropertyAccessor.set(n,'pid',v)` 与 `assignControlBinding` 语义一致 |
| 做法 | 新增 `normalizeGaugePidBinding()`，同 `statePid` 模式 |
| 影响面 | 仅 `schema-props.js`；仪表**尚未接入**面板，属预防性修复 |
| 风险 | 极低（当前无调用路径）|
| **必须先做** | 否则后续接入必然踩 R1 |

### 批次 2（最小可用）：仪表族基础字段

| 项 | 内容 |
|---|---|
| 开放字段 | `pid`（走批次 1 规范）、`style`、`min`、`max`、`warnLow`、`warnHigh`、`w`、`h` |
| **不开放** | `label`/`unit`/`font.*`（R3，未序列化）|
| 需新增 | `isGauge()`、`gaugeSchemaFor()`、`resolve()` 分支、`EDITABLE.gauge` |

### 批次 3：数据绑定与数值映射

`valueLabels`、`extraPids`、`applyPidDefaults` 按钮等价功能。

### 批次 4：外观类字段

`cardStyle`/`card.*`、`neonPreset`、`ringStyle`/`ringSegments`。
**建议单独评审**：这些字段不在 Registry schema 的 12 个里，需确认是否纳入 Schema 面板。

---

## 九、预计需要修改的文件

| 文件 | 批次 | 改动 |
|---|---|---|
| `tools/icarui/js/ui/schema-props.js` | 1,2,3,4 | 新增 gauge 族（唯一源码文件）|
| `tools/icarui/js/registry/controls/gauge-family.js` | 2 | **可能**需补 schema 字段（若要开放 appearance）|
| `tools/icarui/tests/verify-p4e01-*.js` | 各批 | 新增验收套件 |
| `tools/icarui/tests/expected-counts.json` | 各批 | 基线 |
| `tools/icarui/js/panels.js` | **不改** | 旧面板保留并行 |

---

## 十、自动化测试与人工验收计划

### 10.1 自动化（每批次）

| 组 | 覆盖 |
|---|---|
| A | 6 个仪表全部识别为 gauge 族，字段数正确 |
| B | 重载后（无 `__controlKey`）仍识别 |
| C | 基础字段编辑 + 序列化往返 |
| D | **PID 双字段同步**（id/别名/序列化三层）|
| E | 无效 PID 的行为（明确、不静默）|
| F | Undo/Redo |
| G | 导出 → 重导入一致性 |
| H | 普通图片/状态灯/轨道**不被误判** |
| I | 旧面板未受影响 |

### 10.2 人工验收（新增 `P4E-GUI-001` 卡片）

1. 拖入 6 种仪表，Schema 面板显示正确
2. PID 下拉分组正确、回显正确
3. 改 PID 后画布读数/量程更新
4. 保存 → 刷新 → 恢复属性一致
5. 导出 → 真机 App 读数正确
6. 未绑定/无效 PID 的显示符合预期

---

## 十一、建议：本阶段停止，等待指令

按任务要求，审计完成即停止。**未修改任何源码。**

### 需用户决策的 3 个问题

1. **批次 1（PID 语义预防性修复）是否立即执行？** 建议是——它是批次 2 的前置。
2. **外观类字段（卡片/霓虹/指针环）是否纳入 Schema 面板？** 它们不在 Registry schema 的 12 字段内，属于扩范围。
3. **UNKNOWN 状态配置是否需要？** 若需要，属于**新增字段 = 改数据契约**，须单独评审（当前禁止）。

### 已发现的既有缺陷（建议登记）

| ID | 描述 | 优先级 |
|---|---|---|
| R1 | Schema 直写 pid 破坏双字段 | P0（批次1修）|
| R2 | `normalizeStateLampBinding` 无法解析时静默 | P1 |
| R3 | 4 个 schema 字段未序列化 | P1（限制开放范围规避）|
| R4 | UNKNOWN 无配置字段 | P2（需评审）|
| R5 | `P4D-GUI-001` 卡片缺失 | P2 |
