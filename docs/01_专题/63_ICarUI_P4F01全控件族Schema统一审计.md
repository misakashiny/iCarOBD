# P4F-01：ICarUI 全控件族 Schema 统一审计报告

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-21（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4F01`（**只读审计**）|
| 起点 | `45ef8f1`（P4E-05 已同步 GitHub）|
| 结论 | 69 控件**全部接入 SchemaResolver**，但**功能覆盖不均**（track 仅 4/11、普通图片 0）；建议按 4 个批次推进 |
| 源码修改 | **无** |

---

## 一、前置任务：P4E-05 收尾（已完成）

| # | 项 | 结果 |
|---|---|---|
| 1 | 修正覆盖率统计口径 | ✅ 已改为双口径 |
| 2 | 保留两种统计 | ✅ **16/20 声明覆盖** + **16/16 实际功能迁移** |
| 3 | 核实本地/远程 Hash | ✅ 均为 `45ef8f1` |
| 4 | 专题 62 / 断言修复 / 验证记录 / 索引已推送 | ✅ 全部在 `45ef8f1` 中 |
| 5 | 未同步修改 | ✅ 工作区干净（本次仅改专题 62 口径）|
| 6 | 禁强推/覆盖/私人文件 | ✅ 遵守 |
| 7 | P4E 标记 | ✅ **功能开发阶段关闭，GUI 人工验收暂缓** |

### 覆盖率双口径（修正说明）

| 口径 | 分母 | 结果 |
|---|---|---|
| **A. 声明覆盖** | schema 声明的 20 项 | **16 / 20 = 80%** |
| **B. 实际功能迁移** | 旧面板**真正能编辑**的功能 | **16 / 16 = 100%** |

**判据**：`label`/`unit`/`font.size`/`font.color` 在旧面板**从来没有输入框**（node 值 `undefined`、`nodeToJson` 不写、`parseNode` 不读），
所以 **B 才是「迁移是否完成」的正确判据**；A 反映的是 schema 声明与实现之间的**历史欠账**。

---

## 二、69 个控件覆盖矩阵

### 2.1 Registry 全量（69 条）

| render.mode | 数量 | schema 字段 | **Schema 可编辑** | 覆盖率 |
|---|---|---|---|---|
| `container` | 4 | 7 | **6** | 6/7 |
| `text` | 12 | 7 | **5** | 5/7 |
| `gauge` | 6 | 21 | **17** | 17/21 |
| `state` | 19 | 11 | **11** | **11/11 ✅** |
| `track` | 28 | 11 | **4** | **4/11 ⚠** |
| **合计** | **69** | — | **43** | — |

### 2.2 逐族明细

| 族 | 旧面板（Fields 组）| 旧面板可编辑 | Schema 可编辑 | 缺口 |
|---|---|---|---|---|
| **container** (4) | 通用变换组 | — | 6 | `scale` 未开 |
| **text** (12) | `textFields`(1) | 1 + 通用变换 | 5 | `w`/`h` 未开 |
| **gauge** (6) | `gaugeFields`(15) + `bandFields`(0+4按钮) + `partsFields`(10+4按钮) | 25+8按钮 | 17 | 4 个未实现字段 + band/parts 未迁 |
| **state** (19) | `stateFields`(7) | 3 + 通用 | **11** | **无 ✅** |
| **track** (28) | `trackFields`(8+1按钮) | 9 | **4** | **7 个字段未开 ⚠** |
| **普通图片** | `imageFields`(1) | 1 | **0** | **未接入 ⚠** |

### 2.3 track 族 schema 11 字段 vs 可编辑 4

| # | 字段 | 可编辑 |
|---|---|---|
| 1 | `trackStyle.orient` | ✅ |
| 2 | `trackStyle.radius` | ❌ |
| 3 | `trackStyle.inset` | ❌ |
| 4 | `trackStyle.gradient` | ❌ |
| 5 | `trackStyle.glow` | ✅ |
| 6 | `trackStyle.segments` | ✅ |
| 7 | `trackStyle.ticks` | ❌ |
| 8 | `trackStyle.band` | ❌ |
| 9 | `trackStyle.fill` | ✅ |
| 10 | `w` | ❌ |
| 11 | `h` | ❌ |

**差距 7 个**（旧面板 `trackFields` 实际有 9 项可编辑）。

---

## 三、Registry 之外的旧控件清单

### 3.1 检查结果

| 检查项 | 结果 |
|---|---|
| `NEXT_LIBRARY.controls` | 5 条，但**均为素材条目**（车速/转速/水温/电压/油量），**无 `make` 函数、不是控件** |
| `CONTROL_LIST`（presets） | **与 Registry 69 条完全对应，无孤儿** |
| `gauge_parts`（拼装圆表） | ⚠️ **在 `presets.js` 中存在，但未注册进 Registry** |

### 3.2 Registry 外旧控件判定

| 控件 | 状态 | 处置建议 |
|---|---|---|
| `gauge_parts` | presets 可创建（`n.parts` 数组），但 Registry 无对应 key | **长期保留**（子部件能力暂未纳入 Registry）|
| NEXT_LIBRARY 5 条 | 素材条目，非控件 | 无需处理 |

**结论：Registry 外无失控控件入口，仅 `gauge_parts` 是已知的"半游离"能力。**

---

## 四、新旧属性面板功能差异

### 4.1 旧面板结构

| 组函数 | 可编辑行 | 按钮 | 适用 |
|---|---|---|---|
| `gaugeFields` | **15** | 2 | gauge |
| `bandFields` | 0 | 4 | gauge |
| `partsFields` | **10** | 4 | gauge（子部件）|
| `imageFields` | 1（素材）| 0 | 普通图片 |
| `trackFields` | **8** | 1 | track |
| `stateFields` | 7 | 0 | state |
| `textFields` | 1（内容）| 0 | text |

### 4.2 并行安全性

| 检查 | 结果 |
|---|---|
| 旧面板 `renderProps` | ✅ 存在 |
| Schema 面板 `refresh` | ✅ 存在 |
| 两个面板 DOM 同时挂载 | ✅ `#props` + `#schemaProps` |
| **结论** | ✅ **可安全并行**（P4A 起就是这样设计的）|

### 4.3 渲染是否有重复实现

| render.mode | adapter | 数量 |
|---|---|---|
| text | `drawTextNode` | 12 |
| container | `drawTextNode` | 4 |
| gauge | `drawGaugeNode` | 6 |
| state | `drawImageNode` | 19 |
| track | `drawTrackNode` | 28 |

**结论**：**渲染无重复实现** —— 每个 mode 唯一映射到一个 adapter，共 4 个绘制函数。

---

## 五、尚未迁移的功能清单

| # | 功能 | 影响族 | 原因 | 优先级 |
|---|---|---|---|---|
| 1 | **track 7 个字段**（radius/inset/gradient/ticks/band/w/h）| track(28) | P3D 只开了 4 个 | **P1**（涉及 28 条控件）|
| 2 | **普通图片未接入 Schema** | 图片控件 | 从未做（`resolve()` 返回 null）| **P1**（基础控件）|
| 3 | text 的 `w`/`h` | text(12) | P4B 只开 5 个 | P2 |
| 4 | container 的 `scale` | container(4) | P4C 刻意不开（任务限定 6 个）| P2 |
| 5 | gauge `bandFields`（4 按钮，多段色带）| gauge(6) | 未迁 | P2 |
| 6 | gauge `partsFields`（10 行，子部件）| gauge(6) | 未迁 | P2 |
| 7 | 4 个从未实现的字段 | gauge | 声明残留 | P3（需改序列化）|

---

## 六、风险分级与技术债

### 6.1 P1（重要）

| # | 风险 | 说明 |
|---|---|---|
| R1 | **track 族 28 条仅迁 4/11 字段** | 用户改半径/刻度/渐变等仍需回到旧面板；数量最多的族覆盖最差 |
| R2 | **普通图片控件完全未接入 Schema** | 最基础的图片控件 `resolve()` 返回 null，只能走旧面板 |

### 6.2 P2（一般）

| # | 风险 | 说明 |
|---|---|---|
| R3 | text `w`/`h` 未开 | 尺寸仍需旧面板 |
| R4 | container `scale` 未开 | 缩放仍需旧面板 |
| R5 | gauge 子部件/色带未迁 | 属高级功能，用户少 |
| R6 | `gauge_parts` 未进 Registry | 半游离能力，无法被 Schema 识别 |

### 6.3 P3（技术债）

| # | 风险 | 说明 |
|---|---|---|
| R7 | **4 个 schema 字段从未实现**（label/unit/font.size/font.color）| schema 声明了但 `nodeToJson` 不写、`parseNode` 不读。**建议从 schema 中移除或补齐实现** |
| R8 | 两套面板长期并存 | 维护成本翻倍，但当前是安全网 |

---

## 七、推荐的 P4F 开发批次

### 批次 1（P1）：track 族补齐 7 个字段

| 项 | 内容 |
|---|---|
| 目标 | `EDITABLE.track` 由 4 → 11 |
| 依据 | **28 条控件受影响，投入产出比最高** |
| 工作量 | 小（模式与 P4E-04 完全相同：补 schema 声明 + 扩 EDITABLE）|
| 风险 | 低 —— 字段已在 schema 与 `normalizeTrackStyle` 中 |
| 需确认 | `trackStyle.radius/inset/gradient/ticks/band` 是否已在 `schema.js` 声明 |

### 批次 2（P1）：普通图片接入 Schema

| 项 | 内容 |
|---|---|
| 目标 | 新增 `image` 族，开放 `assetId` + `w`/`h` + 通用变换 |
| 依据 | 最基础控件，目前完全不可用 |
| 工作量 | 中（需新增 `isPlainImage()` 已有判定，只需加 `resolve()` 分支与 `EDITABLE.image`）|
| 风险 | 低 —— `isPlainImage()` 已存在（`trackStyle == null`）|

### 批次 3（P2）：text/container 补齐遗漏字段

| 项 | 内容 |
|---|---|
| 目标 | text 加 `w`/`h`；container 开 `scale` |
| 工作量 | 很小 |
| 风险 | 极低 |

### 批次 4（P2）：gauge 子部件与色带

| 项 | 内容 |
|---|---|
| 目标 | `partsFields`（10 行）与 `bandFields`（4 按钮）迁入 |
| 工作量 | **大** —— 子部件是数组结构，需要新的 UI 组件 |
| 风险 | 中 —— 需设计列表型编辑器 |
| 建议 | **单独评估后再排期** |

### 批次 5（P3）：清理 4 个未实现字段

| 项 | 内容 |
|---|---|
| 目标 | 从 schema 移除，或补齐序列化 |
| 建议 | **优先移除**（它们从未存在，移除可让声明覆盖回到 100%）|
| 风险 | 极低（无人使用）|

---

## 八、预计修改文件

| 批次 | 文件 |
|---|---|
| 1（track）| `registry/controls/track-family.js`、`ui/schema-props.js` |
| 2（image）| `registry/controls/*.js`（可能需新建 image-family 或复用）、`ui/schema-props.js` |
| 3（text/container）| `ui/schema-props.js`（仅改 EDITABLE）|
| 4（parts/band）| `ui/schema-props.js`、`ui/schema-panel.js`（新 UI 组件）|
| 5（清理）| `registry/controls/gauge-family.js` |

**均不触及**：`model.js`、`icar.ui/2` 契约、Android、P4R 草稿系统。

---

## 九、GUI 待验收（保持不变）

| 卡片 | 进度 | 待人工验收 |
|---|---|---|
| `P4R-GUI-001` | **2 / 7** | 5 项 |
| `P4D-GUI-001` | **0 / 7** | 7 项 |
| `P4E-GUI-001` | **0 / 15** | 15 项 |
| **合计** | — | **27 项** |

**不因自动测试通过而标记 GUI 验收通过。**

---

## 十、GitHub 同步记录

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/misakashiny/iCarOBD` |
| 分支 | `main` → `origin/main` |
| 本任务起点 | `45ef8f1` |
| 本任务改动 | 专题 62 覆盖率口径修正 + 本报告 + 验证记录 |
| 推送结果 | 见提交后补记 |

---

## 十一、结论

### 11.1 现状判定

**不能仅凭 `resolve()` 非空判定迁移完成** —— 审计证实：

- 69 控件**全部**接入 SchemaResolver（`resolve()` 均返回非 null）
- 但**功能覆盖严重不均**：`state` 11/11 ✅ vs `track` **4/11** ⚠
- **普通图片完全未接入**（0）

### 11.2 建议

**P4F 分 5 批推进**，优先 **批次 1（track 7 字段）** 与 **批次 2（普通图片接入）** ——
二者都是「投入小、覆盖广（28 + N 条控件）、风险低」。

批次 4（子部件/色带）工作量大，建议单独评估。

### 11.3 旧面板退役判断

| 入口 | 未来可否删除 | 条件 |
|---|---|---|
| 旧 `gaugeFields` | ⚠️ 暂不可 | 子部件/色带未迁 |
| 旧 `trackFields` | ⚠️ 暂不可 | 7 字段未迁 |
| 旧 `imageFields` | ⚠️ 暂不可 | 图片未接入 |
| 旧 `textFields`/`group` | ❌ 需长期保留 | w/h 等未迁 |
| `gauge_parts` 创建入口 | ❌ **必须长期保留** | 未进 Registry |

**结论：当前阶段无任何旧面板可安全删除。**

---

**P4F-01 只读审计完成。未删除旧面板，未修改运行时源码。停止，等待下一轮开发指令。**
