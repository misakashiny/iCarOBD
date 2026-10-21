# ICarUI P4F-04：文字与容器 Schema 属性补齐

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-21（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4F04` |
| 起点 | `ea18a2c`（P4F-03 已同步）|
| 结论 | text 5→**7** 字段（补 w/h）；container 6→**7** 字段（补 scale）；**12/12 + 4/4 全部支持**；37 断言全绿；66 套 6368 断言 FAIL=0 |
| 数据契约 | **零变更**（三字段本就在 schema 与序列化中）|

---

## 一、三个字段的审计结果

| 字段 | 类型 | 默认值 | 合法范围 | Registry Schema | 旧面板编辑 | PropertyAccessor | nodeToJson / parseNode | Canvas 语义 | Android | Undo/Redo 冲突 |
|---|---|---|---|---|---|---|---|---|---|---|
| **text `w`** | number | **120** | **≥1** | ✅ 已声明 `min:1` | `setNodeNum('w', …)` | 直接写，✅ | ✅ 均已序列化/解析 | 控件宽度 | 见 §4 | ❌ 无冲突 |
| **text `h`** | number | **20** | **≥1** | ✅ 已声明 `min:1` | 同上 | 直接写，✅ | ✅ | 控件高度 | 见 §4 | ❌ 无冲突 |
| **container `scale`** | number | **1** | **≥0.05** | ✅ 已声明（本任务把 `min` 由 `0.01` 对齐为 **`0.05`**）| `setNodeNum('scale', …)` + 「1×」重置按钮 | 直接写，✅ | ✅ | **w/h 之上的额外倍率** | 见 §4 | ❌ 无冲突 |

### 1.1 关键审计结论

| 检查项 | 结果 |
|---|---|
| **文字自动测量** | ✅ **不存在** —— `measureText` / `autoSizeText` / `fitText` / `textMetrics` 全部 `undefined` |
| **文字宽高约束** | `setNodeNum` 对 `w`/`h` 做 `Math.max(1, …)` |
| **容器缩放语义** | `model.js:12` 明确：「scale 是 w/h 之上的**额外**倍率」；`localMatrix` 是唯一矩阵源 |
| **子节点布局** | 子节点 x/y 为**绝对坐标**；容器 `scale` **不修改**子节点坐标（实测改 `scale=2` 后子节点仍是 `(10,10)`）|
| **变换框架** | ❌ **未重构** —— `localMatrix` 原样保留，本任务只开放属性 |
| **Undo/Redo 冲突** | ❌ 无 —— 三者都走 `commit()`，与通用变换操作共用同一撤销栈 |

### 1.2 唯一需要调整的地方

`container-family.js` 中 `scale` 的 schema 是 `min: 0.01`，
但旧面板 `setNodeNum` 用的是 `Math.max(0.05, …)`。

**schema 比旧面板宽松** → 对齐为 **`min: 0.05`**，避免面板允许输入 0.02 但落地变成 0.05 的不一致。

---

## 二、接入结果

### 2.1 文字控件（12 个）

| 项 | 结果 |
|---|---|
| Registry text 控件 | **12** |
| 正确识别 | **12 / 12 ✅** |
| 可编辑字段 | **5 → 7**（`text` / `font.size` / `font.weight` / `font.color` / `font.align` / **`w`** / **`h`**）|

### 2.2 容器控件（4 个）

| 项 | 结果 |
|---|---|
| Registry container 控件 | **4**（`group` / `box_card` / `box_row` / `box_col`）|
| 正确识别 | **4 / 4 ✅** |
| 可编辑字段 | **6 → 7**（`w` / `h` / `rotation` / **`scale`** / `alpha` / `locked` / `visible`）|

### 2.3 五族覆盖现状（P4F 系列收官）

| 族 | 控件数 | schema 字段 | **Schema 可编辑** | 覆盖率 |
|---|---|---|---|---|
| container | 4 | 7 | **7** | **7/7 ✅** |
| text | 12 | 7 | **7** | **7/7 ✅** |
| gauge | 6 | 21 | **17** | 17/21 |
| state | 19 | 11 | **11** | **11/11 ✅** |
| track | 28 | 11 | **11** | **11/11 ✅** |
| image（普通图片）| 动态 | — | **6** | — |

**五大族中 4 个已 100% 覆盖**，仅 gauge 剩 4 个「从未实现」的字段（`label`/`unit`/`font.size`/`font.color`）。

---

## 三、实际修改文件

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | `EDITABLE.text` 5→7；`EDITABLE.container` 6→7 |
| `tools/icarui/js/registry/controls/container-family.js` | `scale` 的 `min` 由 `0.01` → **`0.05`**（对齐旧面板）|
| `tools/icarui/tests/verify-p4f04-text-container-schema.js` | **新增 37 断言** |
| `tools/icarui/tests/verify-p4b-text-props.js` | 断言 5 → 7（预期演进）|
| `tools/icarui/tests/verify-p4b1-text-finalize.js` | 断言 6 → 8（预期演进）|
| `tools/icarui/tests/verify-p4c-container-props.js` | 断言 6 → 7；`scale` 描述由「declared but NOT editable」改为「editable since P4F-04」|
| `tools/icarui/tests/expected-counts.json` | +37 |
| 文档 | 专题 66 + 验证记录 + **P4F-GUI-003 新建** + 索引 |

**未改**：`app/`（Android）、`model.js`（`localMatrix` 未动）、`schema.js`、
`panels.js`（旧面板保留）、`icar.ui/2` 契约、P4R 持久化、PID 绑定、轨道属性、图片素材选择器。

---

## 四、字段持久化与跨端兼容

| 字段 | `nodeToJson` | `parseNode` | Android |
|---|---|---|---|
| `w` / `h` | ✅ 通用块 | ✅ 通用块 | ✅ 既有字段，未改语义 |
| `scale` | ✅ 通用块 | ✅ `num(o.scale, 1)` | ✅ 既有字段，未改语义 |

**未新增任何持久化字段；`icar.ui/2` 语义零变更。**

---

## 五、浏览器和 Android 测试结果

### 5.1 新增套件 `verify-p4f04-text-container-schema.js` —— **37 断言（A–M）全绿**

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 12/12 text 识别；可编辑 5→7；清单精确 | ✅ |
| B | 4/4 container 识别；可编辑 6→7；清单精确 | ✅ |
| C | 文字 w/h 编辑 | ✅ |
| D | 容器 scale 编辑；默认值 1 | ✅ |
| E | **scale 下限 0.05**；w/h 下限 1；非法输入不崩 | ✅ |
| F | 画布重绘触发 | ✅ |
| G | **容器缩放不改子节点坐标** | ✅ |
| H | Undo/Redo | ✅ |
| I | 导出→重导入一致 | ✅ |
| J | 旧面板 `setNodeNum`/`localMatrix` 仍在；Registry 69 | ✅ |
| K | 其它四族无回归 | ✅ |
| L | **schema 无重复字段定义**（各 7 字段）| ✅ |
| M | **确认无文字自动测量逻辑** | ✅ |

### 5.2 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **66 套 / 6368 断言 / FAIL=0** |
| Android JVM | **1365 项 0/0/0** |

### 5.3 三处既有断言演进（非放宽门槛）

字段数由 5→7、6→7，三个专门测 text/container 的套件把数量写死了：

| 套件 | 修正 | 断言数 |
|---|---|---|
| `verify-p4b-text-props` | 「exactly 5 editable」→ 7（12 个控件各一条）| 114（不变）|
| `verify-p4b1-text-finalize` | 「6 focusable controls」→ 8 | 55（不变）|
| `verify-p4c-container-props` | 「exactly 6 editable」→ 7（4 个控件各一条）+ `scale` 描述更新 | 88（不变）|

**断言数量全部不变，未删任何断言、未降门槛。**

---

## 六、GUI 待验收卡片

### 新建 `P4F-GUI-003`：**0 / 8 项**（全部未验收）

| # | 项目 |
|---|---|
| ① | 12 个文字控件显示 7 个字段 |
| ② | 文字宽度调整 |
| ③ | 文字高度调整 |
| ④ | 4 个容器控件显示 7 个字段 |
| ⑤ | 容器缩放 |
| ⑥ | **子节点布局不意外变化**（核心）|
| ⑦ | 撤销 / 重做 |
| ⑧ | 保存恢复 + 导出导入 |

### 保留的既有卡片（**均未改动**）

| 卡片 | 状态 |
|---|---|
| `P4R-GUI-001` | 2/7 |
| `P4D-GUI-001` | 0/7 |
| `P4E-GUI-001` | 0/15 |
| `P4F-GUI-001` | 0/9 |
| `P4F-GUI-002` | 0/8 |

> ⚠️ **不得因自动测试通过而标记 GUI 人工验收通过。**

---

## 七、GitHub 同步记录与最终 Hash

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/misakashiny/iCarOBD` |
| 分支 | `main` → `origin/main` |
| 起点 Hash | `ea18a2c` |
| 本次提交 | 见提交后补记 |
| 推送结果 | 见提交后补记 |

---

## 八、已知风险

| # | 风险 | 级别 |
|---|---|---|
| R1 | 文字无自动测量 → 改 w/h 不会自动适配文字长度 | 低（本项目本无此能力）|
| R2 | 容器 `scale` 只影响绘制，子节点保持绝对坐标 | 低（既有语义）|
| R3 | gauge 仍有 4 个「从未实现」字段未开放 | 中（需改序列化，须批准）|
| R4 | `TRACK-APP-001`：轨道外观 App 端不呈现 | 中（已登记）|

---

## 九、下一阶段建议

P4F 系列已完成 P4F-01（审计）、P4F-02（track）、P4F-03（image）、P4F-04（text/container）。

**剩余可选工作**：

| 项 | 内容 | 优先级 | 说明 |
|---|---|---|---|
| **P4F-05** | 清理 gauge 4 个从未实现字段（`label`/`unit`/`font.size`/`font.color`）| P3 | 从 schema 移除可让声明覆盖回到 100%，或补齐序列化（须批准）|
| gauge 子部件/色带 | `partsFields` / `bandFields` | P2 | 工作量大，需新 UI 组件 |
| **GUI 人工验收** | 现有 5 张卡片共 **46 项**待人工确认 | — | **建议优先** |

**建议下一轮做 GUI 人工验收**（自动化已全部就绪，人工确认是唯一缺口），
或 P4F-05（成本极小）。

---

**P4F-04 完成。停止，不自动推进 P4F-05。**
