# ICarUI P4E-02：仪表 PID 规范化与基础 Schema 接入

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-19（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4E02` |
| 起点 | `e4cc2dc`（P4E-01 审计）|
| 结论 | 批次 A + 批次 B 完成；**6/6 仪表接入**；38 条新增断言全绿；61 套 6160 断言 FAIL=0 |
| 范围 | 仅 `schema-props.js`；**未改数据契约** |

---

## 一、根因与修复说明

### 1.1 根因（P4E-01 审计 R1）

仪表与状态灯一样有**两个绑定字段**：

| 字段 | 值 | 用途 |
|---|---|---|
| `node.rawPid` | 别名 `obd.speed` | 下拉框回显 |
| `node.pid` | 内部 id `std_0D` | 渲染/查表 |

而 `nodeToJson()` 写的是 `ALIAS_OF[n.pid] || n.pid`（直接反查别名表）。

**若只写 `node.pid = 'obd.rpm'`（别名）**：

```
改前: pid=std_0D   rawPid=obd.speed
写入后: pid=obd.rpm（别名进了通道位）  rawPid=obd.speed（没动）
重载后: pid=obd.rpm, rawPid=obd.rpm   ← 两个字段同时错
```

**对比**：旧面板 `assignControlBinding()`（`data-bindings.js:36`）写法正确。
→ 缺陷在 Schema 路径，本次补齐。

### 1.2 修复（批次 A）

新增 `normalizeGaugePidBinding()`，在 `PropertyAccessor.set` 入口拦截：

```js
if (node.type !== 'gauge' || path !== 'pid') return false;   // 只接管仪表

const raw = String(value ?? '').trim();
if (!raw) { node.rawPid = ''; node.pid = ''; return true; }   // 未绑定

const resolved = resolvePid(raw);
node.rawPid = raw;              // 用户写法
node.pid = resolved || raw;     // 通道 id
```

### 1.3 关于「无效 PID」（任务要求不得静默误绑定）

`resolvePid(name) = PID_ALIASES[name] || name` —— **永远不返回空**，
所以无法靠返回值判断合法性。处理规则：

| 输入 | 行为 | 理由 |
|---|---|---|
| 空串 | 两边清空 | 与旧面板「未绑定」一致 |
| 已知别名/id | 正常解析 | |
| **未知值 / 自定义 PID** | **原样保留在两边** | 自定义 PID 是旧面板支持的合法用法，**不能未经评审就禁掉** |

> 未知值与旧面板 `assignControlBinding` 行为**完全一致**，属既有契约，本批次不改。

---

## 二、批次 B：6 个仪表基础 Schema 接入

### 2.1 改动 4 处（均在 `schema-props.js`）

| # | 改动 |
|---|---|
| 1 | `EDITABLE.gauge = ['pid','style','min','max','warnLow','warnHigh','w','h']` |
| 2 | `isGauge()` —— `type==='gauge'` + 无 `states` + 无 `trackStyle` |
| 3 | `gaugeSchemaFor()` —— 从 Registry 取代表定义，**不复制 schema** |
| 4 | `resolve()` 增加 gauge 分支（在 container 之后、text 之前）|

### 2.2 识别不依赖 `__controlKey`

`type` 是**持久化字段**（JSON 里有），重载后仍在。
实测：重载后 6/6 仍识别（`__controlKey` 全丢）。

### 2.3 刻意不开放（遵循任务第三部分）

| 字段 | 原因 |
|---|---|
| `label`/`unit`/`font.size`/`font.color` | **未进入 v2 序列化**（P4E-01 R3），开放=改了保存不住 |
| `card*`/`neonPreset`/`ringStyle`/`ringSegments` | 不在 schema 12 字段内，属扩范围 |

---

## 三、6 个仪表接入结果

| # | key | 名称 | style | 默认 PID | 接入 | 可编辑 |
|---|---|---|---|---|---|---|
| 1 | `g_speed` | 车速表 | 1 | `std_0D` | ✅ | 8 字段 |
| 2 | `g_coolant` | 水温表 | 0 | `std_05` | ✅ | 8 字段 |
| 3 | `g_fuel` | 油量表 | 0 | `std_2F` | ✅ | 8 字段 |
| 4 | `g_volt` | 电压表 | 4 | `std_42` | ✅ | 8 字段 |
| 5 | `g_load` | 负荷表 | 2 | `std_04` | ✅ | 8 字段 |
| 6 | `g_throttle` | 油门表 | 3 | `std_11` | ✅ | 8 字段 |

**6/6 通过同一分支接入**，无逐个特判。

---

## 四、PID 数据契约验证结果

| 场景 | pid（通道）| rawPid（别名）| 序列化 | 结论 |
|---|---|---|---|---|
| 写别名 `obd.rpm` | `std_0C` | `obd.rpm` | `obd.rpm` | ✅ 契约保持 |
| 写 id `std_0C` | `std_0C` | `std_0C` | `obd.rpm` | ✅ id 幂等 |
| 空值 | `''` | `''` | — | ✅ 未绑定 |
| 自定义 `tpl_oilPressure` | `tpl_oilPressure` | `tpl_oilPressure` | `tpl_oilPressure` | ✅ 可用 |
| 未知 `xx.unknown` | `xx.unknown` | `xx.unknown` | `xx.unknown` | ✅ 不丢失、可恢复 |

**导出 JSON 中 `pid` 始终为别名** —— `icar.ui/2` 契约未变。

### 4.1 一个既有行为（如实记录，未修改）

空绑定（`pid=''`）时 `nodeToJson` **仍会写出 `pid: ""`**（`model.js:825` 无条件赋值）。
这是既有行为，不是本次引入；App 侧按未绑定处理。**未修改**以免扩大范围。

---

## 五、新增断言及全量测试

新增 `verify-p4e02-gauge-schema.js` —— **38 断言，A–M 十三组**：

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 6/6 接入，12 字段，可编辑恰为 8 个 | ✅ |
| B | 重载后 6/6 仍识别 | ✅ |
| C | PID 双字段（别名入口）| ✅ |
| D | PID 双字段（id 入口）| ✅ |
| E | 空 PID = 未绑定 | ✅ |
| F | 合法自定义 PID 保留 | ✅ |
| G | 未知 PID 不静默、可恢复 | ✅ |
| H | 8 字段编辑 + 序列化 | ✅ |
| I | Undo / Redo | ✅ |
| J | 导出 → 重导入一致 | ✅ |
| K | 图片/轨道/状态灯/文字**不误判** | ✅ |
| L | 状态灯 19 / 轨道 28 / 文字 12 / 容器 4 无回归 | ✅ |
| M | 状态灯 `statePid` 语义未受影响 | ✅ |

### 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **61 套 / 6160 断言 / FAIL=0**（原 60/6122）|
| Android JVM | **1365 项 0/0/0** |

### 5.1 一处既有测试的前提修正（非放宽门槛）

`verify-p4a-schema-props.js` 原用 **`g_speed`（仪表）** 作为"非轨道"样本，
断言其 `resolve()` 返回 `null`。仪表接入后该**前提失效**。

修正为使用**普通图片节点**（图片族至今未接入，语义完全一致）。
断言数量 70 → **72**（未删任何断言、未降门槛）。

---

## 六、修改文件及变更范围

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | **唯一源码改动**（批次 A 1 处 + 批次 B 4 处）|
| `tools/icarui/tests/verify-p4e02-gauge-schema.js` | 新增 38 断言 |
| `tools/icarui/tests/verify-p4a-schema-props.js` | 样本前提修正（70→72 断言）|
| `tools/icarui/tests/expected-counts.json` | 基线 +38 |
| 文档 | 专题 59 + 验证记录 + 2 张 GUI 卡片 + 索引 |

**未改**：`app/`（Android）、`model.js`、`data-bindings.js`、`panels.js`（旧面板保留）、
`gauge-family.js`、`lamp-family.js`、`icar.ui/2` 契约、P4R 草稿系统。

---

## 七、风险与未完成事项

### 7.1 风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 未知 PID 会进 `pid` 通道位 | 低 | 与旧面板行为一致，属既有契约 |
| R2 | 空绑定仍写出 `pid: ""` | 低 | 既有行为，未改 |
| R3 | 4 个 schema 字段仍未开放 | 中 | 需先让它们进序列化才能开放 |
| R4 | 外观类字段未迁移 | 中 | 属扩范围，需单独评审 |
| R5 | UNKNOWN 状态无配置 | 中 | 需改数据契约 |

### 7.2 未完成（明确不在本批次）

- `label`/`unit`/`font.*` 开放（依赖序列化改造）
- 卡片/霓虹/指针环迁移
- UNKNOWN 状态字段
- 数值映射 `valueLabels`、副参数 `extraPids`、PID 回填按钮（P4E-03 范围）

---

## 八、GUI 待验收卡片更新情况

| 卡片 | 状态 | 说明 |
|---|---|---|
| `P4R-GUI-001` | ⏸ 5 项仍暂缓 | **未改动**，保持原有状态 |
| **`P4D-GUI-001`** | 🆕 **本次补建** | 7 项全部未验收，补建自 P4E-01 审计 R5 |
| **`P4E-GUI-001`** | 🆕 **新建** | 8 项仪表 GUI 待验收 |

三张卡片均标注「不作为后续开发阻塞项」，且各项均需 **GUI 截图 + 实际结果 + 测试日期**。

---

## 九、停止

**P4E-02 完成，停止。** 等待下一轮审查，**不推进 P4E-03**。
