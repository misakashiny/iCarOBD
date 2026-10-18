# ICarUI P4E-04：仪表高级外观属性 Schema 迁移

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-19（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4E04` |
| 起点 | `3380ade`（P4E-03）|
| 结论 | 7 个高级外观字段**全部可安全迁移**（第一类）；44 条新增断言全绿；63 套 6250 断言 FAIL=0 |
| 数据契约 | **未改**（补登记既有持久化字段）|
| GitHub 同步 | ⚠️ **无法执行**（仓库无 remote，见第九节）|

---

## 一、高级外观字段审计表

### 1.1 逐个核查（任务第二阶段 8 项）

| 字段 | 默认值 | 取值范围 | 旧面板编辑 | 序列化 | 解析 | Android | Undo/Redo | Schema 已声明 |
|---|---|---|---|---|---|---|---|---|
| `cardStyle` | `null` | `null` 或 1..3（0 归一 null）| `setNodeCard` | ✅ `:834` | ✅ `:78` | ✅ `GaugeItem.cardStyle` | ✅ commit | ❌ |
| `card.show` | `null`（card 整体 null）| 布尔 | `setCardFlag` | ✅ 随 card | ✅ `CardOverride` | ✅ `DesignNode.CardOverride` | ✅ commit | ❌ |
| `card.alpha` | `null` | 0..255，可 null | `setCardNumLive` | ✅ 随 card | ✅ | ✅ | ✅ live+commit | ❌ |
| `card.radius` | `null` | 0..120，可 null | `setCardNumLive` | ✅ 随 card | ✅ | ✅ | ✅ | ❌ |
| `neonPreset` | `null` | null / 关闭 / 克制 / 标准 / 强烈 / 夸张 | `setNodeNeon` | ✅ `:833` | ✅ `:78` | ✅ `GaugeItem.neonPreset` | ✅ | ❌ |
| `ringStyle` | `0` | 0(无) / 1(外圈刻度) | `setNodeNum` | ✅ `:831` | ✅ | ✅ `GaugeItem.ringStyle` | ✅ | ❌ |
| `ringSegments` | `40` | 整数 ≥1 | `setNodeNum` | ✅ `:832` | ✅ | ✅ `GaugeItem.ringSegments` | ✅ | ❌ |

### 1.2 三分类结论（任务第一阶段要求）

| 类别 | 字段 | 处置 |
|---|---|---|
| **① 已有完整持久化支持** | **全部 7 个** | ✅ **可安全迁移** |
| ② 需补 Registry Schema 声明 | **全部 7 个** | ✅ 已补登记 |
| **③ 需修改数据契约** | **无** | 无需报告/等待批准 |

**结论：无第三类字段，无需停止。**

### 1.3 同名但语义不同的字段检查

| 字段 | 出现在哪些 render.mode | 结论 |
|---|---|---|
| `card` | **仅 gauge（6 条）** | ✅ 无冲突 |
| `ringStyle` | **仅 gauge（6 条）** | ✅ 无冲突 |
| `neonPreset` | **仅 gauge（6 条）** | ✅ 无冲突 |

**实测全文库扫描：三者只存在于 gauge 模式，不存在同名异义。**

### 1.4 旧面板编辑方式

| 函数 | 语义 |
|---|---|
| `setNodeCard(v)` | `cardStyle = (NaN 或 ≤0) ? null : i` |
| `setCardFlag(k,v)` | `ensureCard(n)[k] = !!v` → `tidyCard(n)` |
| `setCardNumLive(k,v)` | 空 → null；否则 `clamp(0,255 或 120, round)`，走 live 事务 |
| `resetCard()` | 恢复跟随主题 |
| `setNodeNeon(v)` | 写 `neonPreset` 字符串 |

### 1.5 `card` 为 null 的特殊性（关键实现点）

`node.card` **默认是 `null`**（= 跟随主题）。而 `PropertyAccessor.set` 要求中间层必须是已存在对象 —— 所以 `card.show` / `card.alpha` / `card.radius` 在全新仪表上**原本永远写不进去**。

**解决**：新增 `normalizeCardPath()`，与 `app.js` 的 `ensureCard` / `tidyCard` **逐条同构**：

```js
写之前：card 不是对象 → 建 { show:true, alpha:null, radius:null }
写之后：三字段全默认 → card 还原 null（跟随主题）
```

---

## 二、实际迁移的字段及适用仪表样式

### 2.1 迁移了 7 个字段

| # | 字段 | 类型 | 中文名称 |
|---|---|---|---|
| 1 | `cardStyle` | enum [0,1,2,3] | 卡片外框 |
| 2 | `card.show` | boolean | 画底框 |
| 3 | `card.alpha` | number 0..255 可空 | 底框透明度 |
| 4 | `card.radius` | number 0..120 可空 | 底框圆角 |
| 5 | `neonPreset` | enum | 霓虹档位 |
| 6 | `ringStyle` | enum [0,1] | 指针环 |
| 7 | `ringSegments` | number ≥1 | 环段数 |

### 2.2 适用仪表样式（任务第四部分第 1 项）

| 仪表 | style | 外观字段可用 | 说明 |
|---|---|---|---|
| `g_speed` | 1（数字）| ✅ 7/7 | |
| `g_coolant` | 0（圆表）| ✅ 7/7 | |
| `g_fuel` | 0（圆表）| ✅ 7/7 | |
| `g_volt` | 4（双数据上下）| ✅ 7/7 | |
| `g_load` | 2（条形）| ✅ 7/7 | |
| `g_throttle` | 3（线型图）| ✅ 7/7 | |

**实测：6/6 仪表全部 7 个外观字段可用。**

> **关于"不因未支持某种仪表样式而错误显示高级属性"**：
> 三层字段（card/neon/ring）在**所有 gauge 样式**下都是有意义的通用外观层，
> 旧面板也从不按 style 过滤。实测 6 个仪表覆盖 style 0/1/2/3/4 四档，
> 全部可用，**不存在"某样式不支持"的情况**，因此不需要样式过滤。
>
> 若未来出现确实不适用的样式，应在 Registry schema 加 `styles: [...]` 约束，
> 而不是在 UI 层硬编码 —— 本批次不做（属扩范围）。

---

## 三、修改文件清单

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/registry/controls/gauge-family.js` | **补登记 7 个外观字段**（14→21）|
| `tools/icarui/js/ui/schema-props.js` | 新增 `normalizeCardPath()`（ensureCard/tidyCard 同构）；`EDITABLE.gauge` 10→17 |
| `tools/icarui/tests/verify-p4e04-gauge-appearance.js` | 新增 44 断言 |
| `tools/icarui/tests/verify-p4e02-gauge-schema.js` | A3/A4 预期值演进（14/10 → 21/17）|
| `tools/icarui/tests/verify-p4e03-gauge-advanced.js` | A5/K2 预期值演进（10 → 17）|
| `tools/icarui/tests/expected-counts.json` | +44 |
| 文档 | 专题 61 + 验证记录 + P4E-GUI-001 + 索引 |

**未改**：`app/`（Android）、`model.js`、`data-bindings.js`、`panels.js`、
`schema.js`、`icar.ui/2` 契约、渲染器、P4R 草稿系统。

---

## 四、序列化和 Android 兼容验证结果

### 4.1 序列化往返（实测）

设置全部 7 字段后导出 → 重新解析：

```json
{"cardStyle":2,"card":{"show":true,"alpha":180,"radius":10},
 "neonPreset":"强烈","ringStyle":1,"ringSegments":60}
```

往返**完全一致**，`errors = 0`。

### 4.2 Android 契约兼容

| 字段 | Android 位置 | 结论 |
|---|---|---|
| `cardStyle` | `PidModels.kt:696` `var cardStyle: Int?` | ✅ 认 |
| `card` | `DesignNode.kt:479` `CardOverride.parse(...)` | ✅ 认 |
| `neonPreset` | `PidModels.kt:676` `var neonPreset: String?` | ✅ 认 |
| `ringStyle` | `PidModels.kt:664` `var ringStyle: Int` | ✅ 认 |
| `ringSegments` | `PidModels.kt:666` `var ringSegments: Int = 40` | ✅ 认 |

**未修改任何 Android 代码，未改变字段语义。**

### 4.3 旧设计文件兼容

字段名与结构完全未变（只是补登记进 Registry schema），旧设计文件照常可读。

---

## 五、专项核查：`extraPids = []` 行为（任务第四部分第 3 项）

### 5.1 实测结果

| 检查项 | 实测 |
|---|---|
| 空数组是否在 JSON 中省略 | ✅ **省略**（`model.js:830` 的 `if (n.extraPids.length)`）|
| 清空后 Undo | ✅ 回到 `["obd.rpm","obd.coolant"]` |
| 清空后 Redo | ✅ 回到 `[]` |
| 清空后导出 JSON 含键 | ❌ 不含 |
| 清空后重新导入 | ✅ **恢复为空数组 `[]`**（`parseNode:71` 的 `|| []` 兜底）|

### 5.2 修正 P4E-03 报告中的矛盾描述

**P4E-03 报告存在前后矛盾**：

| 位置 | 原文 | 实际 |
|---|---|---|
| 二、字段表说明 | 「`extraPids` 空数组不序列化」| ✅ **正确** |
| 六、R2 风险行 | 「`extraPids` **空数组序列化为 `[]`**（而非剔除）」| ❌ **错误** |

**事实**：空数组时**不写该键**；重载时由 `parseNode` 的 `|| []` 兜底成 `[]`。
两者结果都是"空"，但**序列化行为是省略而非写出 `[]`**。

**是否修复代码**：❌ **不需要**。这是既有正确行为（省略空数组可减小文件体积，语义等价）。
**只修正文档描述**，并已在 P4E-03 报告中标注。

---

## 六、新增断言与全量测试结果

新增 `verify-p4e04-gauge-appearance.js` —— **44 断言，A–L 十二组**：

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 7 字段全登记、schema 21、可编辑 17 | ✅ |
| B | 枚举/范围与旧面板一致（0-3 / 5档 / 0-1 / 0-255 / 0-120）| ✅ |
| C | **card 默认 null 时也能写入**（自动建对象 + tidyCard）| ✅ |
| D | 7 字段设置 + 往返一致 | ✅ |
| E | Undo/Redo | ✅ |
| F | **6/6 仪表 7 个外观字段均可用**；覆盖 4 档样式 | ✅ |
| G | **extraPids=[] 省略键** + Undo/Redo | ✅ |
| H | **清空后导出→重导入恢复 `[]`** | ✅ |
| I | P4E-02/03 数据绑定无回归 | ✅ |
| J | 旧面板 6 个函数仍在 | ✅ |
| K | 状态灯19/轨道28/文字12/容器4/仪表6 无回归 | ✅ |
| L | 普通图片不误判 | ✅ |

### 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **63 套 / 6250 断言 / FAIL=0** |
| Android JVM | **1365 项 0/0/0** |

### 6.1 两处既有断言演进（非放宽门槛）

`verify-p4e02` A3/A4（14/10 → 21/17）与 `verify-p4e03` A5/K2（10 → 17）——
均为 P4E-04 按任务要求扩大开放范围所致。**断言数量不变（38 / 46），未删未降。**

---

## 七、遗留风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 外观字段未做 per-style 过滤 | 低 | 实测 6 样式全部适用；若未来出现不适用样式需加 `styles` 约束 |
| R2 | `card.*` 依赖 `normalizeCardPath` | 低 | 与 app.js 同构，已实测三字段往返 |
| R3 | `neonPreset` 是**中文串** | 低 | 冻结契约（`NEON_PRESETS` 名字是契约），不能改英文 |
| R4 | 4 个未序列化字段（label/unit/font.*）仍不开放 | 中 | 需先做序列化改造 |
| R5 | 外观字段无样式适用性元数据 | 中 | 当前无此需求 |

---

## 八、更新后的 GUI 验收卡片

### `P4E-GUI-001`：11 项 → **15 项**

新增 4 项（全部未验收）：

| # | 新增项 |
|---|---|
| ⑫ | 卡片外框 4 档切换，画布外观随之变化 |
| ⑬ | 底框「画底框」勾选 / 透明度 / 圆角可编辑，且全部还原后回到「跟随主题」|
| ⑭ | 霓虹档位 5 档切换，效果可见 |
| ⑮ | 指针环开关与环段数可编辑，效果可见 |

### 其他卡片（**均未改动**）

| 卡片 | 状态 |
|---|---|
| `P4R-GUI-001` | 5 项暂缓 |
| `P4D-GUI-001` | 7 项待验收 |

> ⚠️ **不因自动测试通过而标记 GUI 人工验收完成。**

---

## 九、GitHub 仓库同步（第八部分）— ⚠️ **无法执行**

### 9.1 阻塞原因

```
$ git remote -v
（空输出）

$ git branch --show-current
main

$ git rev-parse --abbrev-ref @{u}
fatal: no upstream configured for branch 'main'
```

**本仓库没有配置任何 Git remote，也没有上游跟踪分支。**

### 9.2 按要求停止，未擅自操作

任务第八部分明确要求：

> "不擅自创建新仓库。"
> "出现冲突、权限错误或认证失败时，**停止并报告，不得强行覆盖**。"

因此**未执行**：
- ❌ 未 `git remote add`（需用户提供仓库地址，擅自添加等于"创建新仓库关联"）
- ❌ 未 push（无目标可推）
- ✅ 已完成本地提交（保留完整历史）

### 9.3 需要用户提供

| 项目 | 需要用户提供 |
|---|---|
| GitHub 仓库地址 | 例如 `https://github.com/<user>/<repo>.git` |
| 目标分支 | 当前为 `main`，是否就用 `main` |
| 认证方式 | HTTPS token / SSH key |

**收到后我可执行**：`git remote add origin <URL>` → `git push -u origin main` → 验证远程包含提交。

### 9.4 同步状态表（按任务要求格式）

| 项目 | 值 |
|---|---|
| GitHub 仓库 | **未配置**（无 remote）|
| 目标分支 | `main`（本地）|
| Commit | 见提交后补记（本地已提交）|
| Push 结果 | ❌ **失败/未执行** —— 仓库无 remote |
| 远程验证 | ❌ 不适用 |
| 测试结果 | 浏览器 63 套 / 6250 断言 / FAIL=0；Android JVM 1365 项 0/0/0 |

### 9.5 完成判定

按任务第八部分第 5 条：

> "若 GitHub 推送失败，必须将任务标记为**「本地开发完成，待 GitHub 同步」**，明确报告阻塞原因。"

→ **P4E-04 状态：本地开发完成，待 GitHub 同步。**

---

## 十、停止

**P4E-04 完成（本地），停止。等待下一轮审查及 GitHub 同步所需信息。**
