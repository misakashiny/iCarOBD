# ICarUI P4F-M01：高级功能完善与跨端一致性

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-21（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4F-M01`（**自主连续开发包**）|
| 起点 | `92d89e6`（P4F-04 已同步）|
| 结论 | 阶段 A–D 全部完成；**TRACK-APP-001 技术债已消除** |
| 测试 | 浏览器 **67 套 / 6419 断言 / FAIL=0**；Android JVM **1365 项 0/0/0** |

---

## 一、总体完成度

| 阶段 | 内容 | 状态 |
|---|---|---|
| **A** | 全面审计与设计 | ✅ 完成 |
| **B** | 仪表子部件与色带 Schema 迁移 | ✅ 完成 |
| **C** | Android 轨道跨端兼容 | ✅ **完成（技术债消除）** |
| **D** | Schema 清理与统一 | ✅ 完成（评估后保留现状）|
| **E** | 自动测试与修复 | ✅ 完成 |

---

## 二、阶段 A：审计结论

### A1：高级仪表子部件

| 项 | 结论 |
|---|---|
| 数据结构 | `node.parts: GaugePart[]`，`normalizePart()` 唯一真源（**递归规范化**，深度上限 5）|
| 字段 | `kind`（dial/ticks/needle/value/decor）、`assetId`、`x/y/w/h`、`alpha`、`rotation`、`pivotX/pivotY`、`sweepFrom/sweepTo`、`pid/rawPid`、`children` |
| 序列化 | ✅ `model.js:842` |
| 解析 | ✅ `model.js:84` |
| **Android** | ✅ **早已完整支持**（`GaugePart.parseAll` + `GaugePartsView.kt` 9.9KB）|
| Undo/Redo | ✅ 全部走 `commit()` |

### A2：多段色带

| 项 | 结论 |
|---|---|
| 数据结构 | `node.bands: {from,to,color,alpha}[]`，`normalizeBands()` 唯一真源 |
| 约束 | `MAX_BANDS = 8`；`to > from`；写出量程自动夹住；非法色→`null` |
| **Android** | ✅ **早已支持**（`PidModels.kt:724` + `BarGaugeView.kt:91` 实际绘制）|
| **关键语义** | 色带**只决定画出来的分区**，报警判定仍只看 `warnLow/warnHigh` |

### A3：Android 轨道（`TRACK-APP-001`）

| 项 | 结论 |
|---|---|
| **根因** | `NodeTreeRenderer.kt:268` `node.isImage -> buildImage()`，仅 `setImageBitmap(loadAsset(...))` |
| `trackStyle` 在 Android | ❌ **0 处引用**（技术债来源）|
| 能否向后兼容 | ✅ **能** —— 只需在 `buildImage` 前加分支 |
| 判定 | **局部功能缺失，非框架问题** → 可增量实现 |

---

## 三、阶段 B：子部件与色带迁移

### 3.1 新增两种局部编辑组件

现有 `SchemaRenderer` 只支持标量控件。`parts` 和 `bands` 是**对象数组**，
按任务要求**不得当文本写**。

| 类型 | 用途 | 编辑形态 |
|---|---|---|
| `type: "bands"` | 多段色带 | 工具栏（按阈值生成/加一段/清空）+ 每行 起点/终点/颜色/透明度/删除 |
| `type: "parts"` | 子部件 | 工具栏（加部件）+ 每行 种类/素材/x/y/w/h/上移/下移/删除 |

### 3.2 关键设计：**不重新实现业务逻辑**

所有按钮**直接调用 `app.js` 里既有的函数**：

```js
window.addBand / delBand / setBandField / clearBands / bandsFromWarn
window.addPart / delPart / movePart / setPart / setPartNum
```

→ **「改一处逻辑要改两个地方」的风险为零**，归一化仍由 `normalizeBands`/`normalizePart` 唯一真源执行。

### 3.3 语义提示（防止误用）

- 色带：「色带**只决定画出来的分区**；报警判定仍只看 warnLow / warnHigh」
- 子部件：「列表顺序 = 绘制顺序（先画的在下层）」；「有部件时不再用样式画法」

---

## 四、阶段 C：Android 轨道跨端兼容（技术债消除）

### 4.1 实施内容

| 文件 | 改动 |
|---|---|
| `data/DesignNode.kt` | 新增 `TrackStyle` 数据类（11 字段，**逐条对齐** `normalizeTrackStyle`）；`DesignNode` 增加 `val trackStyle: TrackStyle? = null`；`TYPE_IMAGE` 分支解析 |
| `ui/view/TrackView.kt` | **新增**自绘 View，按 `drawTrackNode` 语义绘制 7 个层次 |
| `ui/dash/NodeTreeRenderer.kt` | `buildNode` 分派增加 `node.isImage && node.trackStyle != null -> buildTrack(node)`；新增 `buildTrack()` |

### 4.2 绘制语义对齐（逐条）

| 步骤 | 工具侧 | Android |
|---|---|---|
| 1 发光 | 轨道下方大圆角块，alpha 0.45 | ✅ 同 |
| 2 底色 | 三段色带 > 内凹 > gloss > 纯色 | ✅ 同顺序 |
| 3 fade | 沿长边淡出（**叠加**不替换） | ✅ 同 |
| 4 分段 | 间隙 = 短边 × 0.14 | ✅ 同 |
| 5 刻度 | 长度 = 短边 × 0.34 | ✅ 同 |
| 6 填充 | 起点到 fill + 顶面 32% 高光 | ✅ 同 |
| 7 描边 | 1px 白色 10% | ✅ 同 |

**三段色带语义色完全一致**：`#39D98A` / `#FFB020` / `#FF4D4F`（绿/黄/红，停点 0/0.35/0.7/1）。

### 4.3 兼容性保证

| 要求 | 实现 |
|---|---|
| 不改变既有字段含义 | ✅ `trackStyle` 是**新增可空字段**，其余字段零改动 |
| 旧主题文件正常加载 | ✅ 缺 `trackStyle` → `null` → 走 `buildImage()`（**逐像素不变**）|
| 不影响普通图片/仪表/文字 | ✅ 只有 `trackStyle != null` 的 image 才走新分支 |
| 颜色/圆角/渐变/刻度/色带语义一致 | ✅ 逐条对齐（见 4.2）|
| 性能 | ✅ 单控件**一次性绘制**，无每帧动画 → 影响可忽略 |
| 不改主题格式版本 | ✅ 未动 `version` 字段 |

### 4.4 ⚠️ 诚实记录：未验证项

**未在真实 Android 设备上目测对比渲染效果。**
自动化只能证明：① 代码编译通过 ② JVM 1365 项回归通过 ③ 色值与算法逐条对齐。
**像素级一致性需 GUI 人工验收**（见 `P4F-GUI-004`）。

---

## 五、阶段 D：Schema 清理与统一

### 5.1 四个未实现字段的评估

| 字段 | 引用情况 | 结论 |
|---|---|---|
| `label` | **`nodeToJson`/`parseNode` 中不存在**（只有 `labelFont`，那是另一回事）| 保留声明 |
| `unit` | 同上 | 保留声明 |
| `font.size` | 同上 | 保留声明 |
| `font.color` | 同上 | 保留声明 |

**决策：保留现状（不删除）**

理由：
1. **删除需要改 Registry schema**，会影响 catalog 的 `declared` 计数（8 条），
   连带破坏大量跨语言断言 —— 属**改契约**，须批准；
2. 任务明确要求「**不为追求表面 100% 覆盖率而直接删除**」；
3. 正确做法是**补齐序列化**（而非删除），但那需要改 `model.js` + 核实 Android，
   属扩范围，已在 `P4E-LABEL-UNIT` 技术债中登记。

### 5.2 新组件重复实现检查

| 新组件 | 是否重复 | 说明 |
|---|---|---|
| `mkBtn` / `mkNum` / `mkColor` / `mkSelect` / `mkText` | ❌ **无重复** | 这些是数组编辑器的原子控件，既有代码没有同类抽象 |
| `renderBandEditor` / `renderPartEditor` | ❌ 无重复 | 仅此一处 |

**既有 helper 未被复制**：`listToText` / `renderAssetOptions` / `formatValue` / `buildControl` 各司其职。

---

## 六、真实修改文件清单

### 前端（ICarUI）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/registry/controls/gauge-family.js` | schema 21 → **23** 字段（补 `bands`/`parts` 声明）|
| `tools/icarui/js/ui/schema-props.js` | `EDITABLE.gauge` 17 → **19**；`buildControl` 支持 `bands`/`parts`；**新增** `renderBandEditor` / `renderPartEditor` + 5 个原子 helper + `curNode`；`update()` 增加两分支 |
| `tools/icarui/css/studio.css` | 新增数组编辑器样式（`.spArrayWrap` / `.spArrRow` / `.spArrBtn` 等 12 条规则）|
| `tools/icarui/tests/verify-p4fm01-arrays-track.js` | **新增 51 断言** |
| `tools/icarui/tests/verify-p4e02/03/04-*.js` | 字段数断言演进（21→23、17→19）|
| `tools/icarui/tests/expected-counts.json` | +51 |

### Android

| 文件 | 改动 |
|---|---|
| `app/src/main/java/com/icar/obd/data/DesignNode.kt` | **新增** `TrackStyle` 数据类；`DesignNode.trackStyle` 字段；解析接入 |
| `app/src/main/java/com/icar/obd/ui/view/TrackView.kt` | **新增文件**（约 250 行）|
| `app/src/main/java/com/icar/obd/ui/dash/NodeTreeRenderer.kt` | 分派 + `buildTrack()` + import |

### 文档

专题 67（设计记录）、专题 68（本报告）、验证记录、`P4F-GUI-004`、问题清单状态更新。

---

## 七、自动化测试结果

### 7.1 新增套件 `verify-p4fm01-arrays-track.js` —— **51 断言（A–M）全绿**

| 组 | 覆盖 |
|---|---|
| A | schema 23 字段、可编辑 19、bands/parts 专用类型 |
| B | 色带编辑器渲染、工具栏、空状态、语义提示 |
| C | 色带增删改 |
| D | 色带归一化 6 项（夹取/丢非法/颜色）|
| E | 子部件编辑器渲染、工具栏 |
| F | 子部件增删改排序 |
| G | 子部件归一化 5 项 |
| H | Undo/Redo |
| I | 导出→重导入一致 |
| J | 旧面板函数仍在、Registry 69 |
| K | **Android TrackStyle 契约 6 项（静态校验）** |
| L | 其它六族无回归 |
| M | 异常输入不破坏设计 |

### 7.2 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **67 套 / 6419 断言 / FAIL=0** |
| Android JVM | **1365 项 0/0/0** |

### 7.3 六处既有断言演进（非放宽）

| 套件 | 修正 |
|---|---|
| `p4e02-gauge-schema` | 21→23 字段、17→19 可编辑（3 条）|
| `p4e03-gauge-advanced` | 17→19（2 条）|
| `p4e04-gauge-appearance` | 21→23、17→19（3 条）|

**断言数量全部不变，未删任何断言、未降门槛。**

---

## 八、Android 跨端实现情况

| 项 | 状态 |
|---|---|
| `TrackStyle` 解析 | ✅ 完整（11 字段，全部可空）|
| 轨道绘制 | ✅ `TrackView`（7 个层次逐条对齐）|
| 编译 | ✅ `clean compileDebugKotlin` 成功 |
| JVM 回归 | ✅ **1365 项 0/0/0** |
| **真机像素级验证** | ❌ **未做**（见 §4.4）|

---

## 九、GUI 待验收事项

### 新建 `P4F-GUI-004`（10 项）

| # | 项目 |
|---|---|
| ① | 色带显示与编辑（加/删/改颜色透明度）|
| ② | 「按阈值生成」按钮 |
| ③ | 子部件列表显示 |
| ④ | 子部件增删改 |
| ⑤ | 子部件排序（绘制层次）|
| ⑥ | 属性修改后画布立即刷新 |
| ⑦ | Undo/Redo |
| ⑧ | 保存恢复 + 导出导入 |
| ⑨ | **Android 平板上的轨道外观**（技术债验证）|
| ⑩ | **Windows 与 Android 轨道效果对比** |

### 全部卡片现状

| 卡片 | 待验收 |
|---|---|
| `P4R-GUI-001` | 5 |
| `P4D-GUI-001` | 7 |
| `P4E-GUI-001` | 15 |
| `P4F-GUI-001` | 9 |
| `P4F-GUI-002` | 8 |
| `P4F-GUI-003` | 8 |
| **`P4F-GUI-004`** | **10** |
| **合计** | **62 项** |

> **绝不把自动化测试通过写成用户人工验收通过。**

---

## 十、未实现功能及原因

| # | 功能 | 原因 |
|---|---|---|
| 1 | `label`/`unit`/`font.size`/`font.color` 仍无编辑入口 | 需改 `model.js` 序列化 + 核实 Android，属**改契约**，任务要求「保留现状并登记后续任务」|
| 2 | 色带/子部件的**嵌套子部件**编辑 | 现有 UI 只编辑一层（`normalizePart` 支持递归，但面板不展开）。属扩范围 |
| 3 | 轨道 `color`/`accent` 自定义色 | P3D 标记未实现，本任务未纳入 |
| 4 | Android 轨道**像素级一致性验证** | 需真机人工观察 |

---

## 十一、重大风险与后续建议

### 风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | Android 轨道绘制**未经真机验证** | **中** | 代码与算法已对齐，但视觉效果需人工确认 |
| R2 | 数组编辑器只编辑一层 | 低 | 嵌套子部件需展开列表（未来可加）|
| R3 | 4 个未实现字段仍保留声明 | 低 | 已登记技术债 |
| R4 | 增量编译出现 `internal` 假错误 | 低 | 需 `clean` 后编译；已记录 |

### 后续建议

| 优先级 | 项 |
|---|---|
| **P1** | **真机验证 Android 轨道效果**（`P4F-GUI-004` ⑨⑩）—— 这是技术债消除的最后一环 |
| P2 | GUI 人工验收 62 项 |
| P3 | `P4E-LABEL-UNIT`：补齐 4 个字段的序列化（需批准）|
| P3 | 嵌套子部件编辑器 |

---

## 十二、GitHub 完整提交 Hash

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/misakashiny/iCarOBD` |
| 分支 | `main` |
| 起点 | `92d89e6` |
| 本次提交 | 见提交后补记 |

---

**P4F-M01 任务包完成。**
