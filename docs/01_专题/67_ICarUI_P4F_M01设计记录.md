# P4F-M01 内部设计记录

**日期**：2026-10-21（Asia/Shanghai）
**任务**：`T-UI-REFACTOR-P4F-M01`
**起点**：`92d89e6`

---

## 阶段 A 审计结论

### A1：高级仪表子部件

| 项 | 结论 |
|---|---|
| 数据结构 | `node.parts: Array<GaugePart> \| null`；`normalizePart()` 是唯一真源，**递归规范化**（深度上限 5）|
| 字段 | `kind`（dial/ticks/needle/value/decor）、`assetId`、`x/y/w/h`、`alpha`、`rotation`、`pivotX/pivotY`、`sweepFrom/sweepTo`、`pid/rawPid`（仅 needle/value）、`children` |
| 序列化 | ✅ `model.js:842` `if (n.parts.length) o.parts = n.parts.map(cleanPart)` |
| 解析 | ✅ `model.js:84` `parts: o.parts.map(normalizePart)` |
| **Android** | ✅ **已完整支持** —— `DesignNode.kt:246` `val parts: List<GaugePart>?`，`:478` `GaugePart.parseAll(...)`，`GaugePartsView.kt`（9.9KB）实际绘制 |
| Undo/Redo | ✅ 全部编辑函数走 `commit()` |
| 旧面板 | `partsFields()` 129 行，含增/删/排序/折叠 |

**判定：① 数据契约完整 → 可安全迁移。**

### A2：多段色带

| 项 | 结论 |
|---|---|
| 数据结构 | `node.bands: Array<{from,to,color,alpha}> \| null`；`normalizeBands(arr, min, max)` 唯一真源 |
| 约束 | `MAX_BANDS = 8`；`to > from`；写出量程自动夹住；非法色 → `null`（不静默改默认色）|
| 序列化 | ✅ `model.js:840` `if (bandsUsable) o.bands = bandsJson(n.bands)` |
| **Android** | ✅ **已支持** —— `PidModels.kt:724` `var bands: MutableList<GaugeBand>`，`:878` 解析，`BarGaugeView.kt:91` 实际绘制 |
| Undo/Redo | ✅ 走 `commitBands()` |
| 旧面板 | `bandFields()` 36 行，4 个按钮 + 每段 4 个输入 |

**判定：① 数据契约完整 → 可安全迁移。**

**⚠️ 关键语义**：色带**只决定画出来的分区**，报警判定仍只看 `warnLow/warnHigh`。编辑组件必须保持这个说明。

### A3：Android 轨道显示（`TRACK-APP-001`）

| 项 | 结论 |
|---|---|
| 根因 | `NodeTreeRenderer.kt:268` `node.isImage -> buildImage(node)`，`:286` 仅 `setImageBitmap(loadAsset(...))` |
| `trackStyle` 在 Android | ❌ **0 处引用** |
| 28 个轨道控件合约 | 与普通图片同为 `type:"image"` + `trackStyle` 对象 + `assetId` |
| 能否向后兼容 | ✅ **能** —— 只需在 `buildImage` 前加一个「有 trackStyle → 用代码绘制」分支 |
| 分辨率/缩放 | 轨道尺寸来自 `node.w/h`，Android 用 dp→px 换算，与其它控件一致 |
| 性能 | 单控件一次性绘制，无每帧重绘，影响可忽略 |
| 与主题框架 | 读 `trackStyle.color/accent` 为 null 时回落主题色，与工具侧一致 |

**判定：局部功能缺失，非框架问题 → 可做**增量实现**，不重构渲染框架。**

---

## 阶段 B 设计方案：子部件与色带编辑组件

### 问题

现有 `SchemaRenderer` 只支持标量控件（text/number/enum/boolean/color/list/asset）。
`parts` 和 `bands` 是**对象数组**，不能当文本写。

### 最小方案：新增两种数组类型

| 类型 | 用途 | 编辑形态 |
|---|---|---|
| `type: "bands"` | 多段色带 | 行列表：from/to/color/alpha + 删除按钮 + 「加一段」「按阈值生成」「清空」 |
| `type: "parts"` | 子部件 | 行列表：种类/素材/x/y/w/h + 上移/下移/删除 + 「加部件」 |

### 为什么不用文本输入

任务明确禁止：「不要将复杂数组直接当作普通文本写入」。
对象数组有 8~12 个字段，文本无法表达且极易破坏结构。

### 复用原则

- **归一化**：全部复用 `normalizeBands` / `normalizePart`（唯一真源）
- **默认值**：不复制，`addBand` 逻辑照旧面板
- **撤销**：每个操作都走 `commit()`
- **不改渲染**：Canvas 绘制代码不动

### 实施位置

`tools/icarui/js/ui/schema-props.js`：
1. `EDITABLE.gauge` 增加 `bands` / `parts`
2. `gauge-family.js` schema 增加两个声明
3. `buildControl` 增加两种类型的容器
4. 新增 `renderBandEditor()` / `renderPartEditor()`（**局部组件**）
5. 事件委托处理编辑操作

---

## 阶段 C 设计方案：Android 轨道绘制

在 `NodeTreeRenderer.buildImage()` 增加前置分支：

```kotlin
if (node.trackStyle != null) { return buildTrack(node) }
```

新增 `TrackView`（自绘 View），按工具侧 `drawTrackNode` 的语义绘制：
底色 → 三段色带/内凹/渐变 → 分段 → 刻度 → 填充 → 描边。

**不改任何既有字段含义，不改主题格式版本。**
