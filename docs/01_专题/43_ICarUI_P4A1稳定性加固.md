# ICarUI P4A.1：Schema 面板稳定性与兼容性加固

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4A1` |
| 基线 | P4A `7ad679b` |
| 结论 | 修复 2 个真问题（同步缺失、Schema 双源）；真实键盘输入验证；**5526 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`panels.js` 零改动；`registry/` 零改动 |

---

## 一、所有添加入口的兼容性结果

### 1.1 7 类来源全部支持（任务指定）

| # | key | Catalog 来源 | 节点类型 | 插入 | 尺寸 | 子节点 | assetId |
|---|---|---|---|---|---|---|---|
| 1 | `t_label` | `derived` | text | ✅ | 120×20 | 0 | 空 |
| 2 | `cd_trackh` | `derived` | image | ✅ | 150×16 | 0 | 空 |
| 3 | `lamp_tpms` | `derived` | image | ✅ | 35×56 | 0 | 有 |
| 4 | `gauge_0` | **`declared`** | gauge | ✅ | 120×120 | 0 | 空 |
| 5 | `next_speed_oem` | **`probe`** | group | ✅ | 120×120 | **2** | 空 |
| 6 | `bar_trackh` | **`probe`** | image | ✅ | 150×16 | 0 | 有 |
| 7 | `img_ring` | **`probe`** | image | ✅ | 112.5×180 | 0 | 有 |

**三种来源（`derived` / `declared` / `probe`）全部通过统一适配层正常工作。**

### 1.2 未迁移条目正确回退（不静默失败）

实测 `img_ring`：

- `__bridgedTo` **不存在**（仍是旧工厂）
- `Control.byLegacyKey('img_ring')` **返回 undefined**
- **但 `insertControl` 依然成功插入**

→ 回退路径有效，**没有静默失败**。

### 1.3 ⚠️ 未发现重复执行 `prepareBuiltinImages`

| key | 原始宽度 | 实测 | 一次值 | 二次值 | 判定 |
|---|---|---|---|---|---|
| `cd_trackh` | 240 | **150.000** | 150.000 | 93.750 | ✅ 一次 |
| `bar_trackh` | 240 | **150.000** | 150.000 | 93.750 | ✅ 一次 |
| `img_ring` | 180 | **112.500** | 112.500 | 70.313 | ✅ 一次 |
| `lamp_tpms` | 56 | **35.000** | 35.000 | 21.875 | ✅ 一次 |

**4/4 全部只执行一次，未出现二次缩放的数值。**

### 1.4 子节点 / 素材路径 / 撤销 / 保存重载

| 验证 | 结果 |
|---|---|
| 组合控件 `next_speed_oem` 子节点 | ✅ 保留 **2** 个 |
| 素材 `img_ring` 的 assetId | ✅ 有值 |
| 保存 → `parseDesign` 重载 | ✅ 0 错误、2 节点 |

---

## 二、⚠️ Schema 单一事实源核验：发现并修复双源

### 2.1 问题

P4A 初版 `schema-props.js` 里**内置了一份 `TRACK_SCHEMA`**（11 个字段），同时 `SchemaResolver` 又会优先读 Registry 的定义 —— **同一族两套字段表**：

```
新建节点（有 __controlKey） → 读 Registry 的 schema[]
重载节点（无 __controlKey） → 读内置 TRACK_SCHEMA
```

**两份已经产生偏差**：内置那份多了 `nullable` 标记，Registry 那份没有。

而且由于 `__controlKey` **保存后必然丢失**，**绝大多数情况下实际用的是内置那份** —— Registry 的 schema 形同虚设。

### 2.2 修复

**删除内置 `TRACK_SCHEMA`，只保留 Registry 一处。**

新的数据流：

```
持久化能力（type + trackStyle）
        ↓  只用来判断"这是哪一族"
SchemaResolver._representative("track")
        ↓  从 Registry 里找任一条 render.mode==='track' 的定义
        ↓  用它的 schema[]（同族共享）
SchemaRenderer
```

**可编辑清单也移出**，单独放在 `EDITABLE` 表里（只存路径，不碰字段定义）。

### 2.3 修复后实测

| 检查 | 结果 |
|---|---|
| 两条路径是否**同一个对象** | ✅ `sameObject: true` |
| 带 `__controlKey` 的路径用 Registry | ✅ `s1IsRegistry: true` |
| **重载节点（无 key）也用 Registry** | ✅ `s2IsRegistry: true` |
| 字段数 | 11（来自 Registry）|
| 可编辑字段 | 4（来自 `EDITABLE`）|

> **以后新增字段只需改 Registry 的 `schema[]`，面板自动跟上。**

持久化能力识别保持不变，仍不依赖 `__controlKey`。

---

## 三、⚠️ 新旧面板双向同步：发现并修复同步缺失

### 3.1 问题

实测**旧面板改字段后，新面板不更新**：

```
model: 12     panel: "5"      ← 不同步！
```

**根因**：`refreshAll()` 只调 `renderPanels()` → `renderProps()`（旧面板），**完全没有通知 Schema 面板**。

而旧面板的所有修改最终都走 `refreshAll`，所以这条路径**从来没有同步过**。

### 3.2 修复

在 `refreshAll()` 里追加 Schema 面板刷新（+9 行）：

```js
if (!S.suppressPanelRender && window.renderPanels) window.renderPanels();
// P4A.1：同步 Schema 属性面板（并行面板，只刷新值、不重建 DOM）
if (!S.suppressPanelRender) {
  try { if (ICAR.ui.SchemaPanel) ICAR.ui.SchemaPanel.refresh(); } catch (e) {}
}
if (window.draw) window.draw();
```

放在 `renderPanels` **之后**、`draw` **之前** —— 与旧面板同一次刷新完成。

### 3.3 修复后 8 项同步测试

| # | 场景 | 结果 |
|---|---|---|
| 1 | 旧面板改 → 新面板显示 | ✅ `model:12 / panel:"12"` |
| 2 | 新面板改 → 模型 | ✅ `model:7` |
| 3 | 撤销 → 两面板同步 | ✅ `after:7 / panel:"7"` |
| 4 | 切换节点 | ✅ 值正确刷新 |
| 5 | 删除当前节点 → 清空 | ✅ `family:null`、**0 个输入框** |
| 6 | 多选 | ✅ 不绑定到单个节点 |
| 7 | 导入新设计 → 旧引用不残留 | ✅ `oldStillFound:false` |
| 8 | 无选择 | ✅ 显示占位提示 |

> 未增加新的事件机制 —— 复用既有 `refreshAll` / `onSelectionChanged` 两个入口。

---

## 四、真实键盘与滑块交互记录

### 4.1 真实键盘（CDP `Input.insertText` + `dispatchKeyEvent`）

| 测试 | 方法 | 结果 |
|---|---|---|
| 输入数值 | Ctrl+A → `Input.insertText("42")` → Enter | ✅ 模型 = **42** |
| 输入框保留文本 | — | ✅ 值显示 `"42"` |
| **非法输入** | Ctrl+A → `Input.insertText("abc")` | ✅ 模型**仍是 42**（未污染）、输入框标红 `spInvalid` |
| 光标移动 / 选择部分文字 | 用 `inp.select()` + Ctrl+A | ⚠️ **部分覆盖**（见 §8）|
| Tab 切换焦点 | **未测** | ⚠️ 见 §8 |
| Enter / 失焦提交 | Enter 提交 ✅ | ✅ |

### 4.2 滑块手势

**⚠️ 必须说明**：P4A 开放的 4 个字段里**没有 `<input type="range">`**（都是 `text` / `select` / `checkbox`）。所以"滑块测试"实际测的是 **`beginLive → setLive×10 → endLive` 事务序列**，**不是 DOM 滑块的真实 pointer 事件**。

| 验证 | 结果 |
|---|---|
| 连续 10 步 | ✅ 最终值 **1.0** |
| 模型值正确 | ✅ `latest: 1.0` |
| **一次撤销回到拖动前** | ✅ `afterUndo === start`（0.62）|

> 这**不构成"完整真实鼠标交互测试"** —— 任务第六部分明确要求区分，
> 此处如实标注为**事务 API 的指针等价序列**。

---

## 五、首次编辑及撤销语义验证

### 5.1 关键发现：撤销基准的建立方式

排查过程中确认了两条既有语义（**都不是缺陷**）：

1. **`commit()` 先改模型、再 `undo.push(snapshot())`** —— 所以快照记录的是**改之后**的状态，
   `doUndo()` 会跳到**上一条记录**（即改之前）
2. **`S.design = createDesign(...)` 绕过正规载入流程**时，撤销栈基准仍是**旧设计**，
   于是撤销会跳回旧设计、新节点整批消失

**测试必须用 `commit` 建立基准**，才与真实用户路径一致。

### 5.2 撤销事务实测

| 场景 | 结果 |
|---|---|
| **首次编辑**（commit 加节点 → 改属性 → undo） | ✅ 回到 `5`，**节点仍在** |
| 第二次编辑 | ✅ `5 → 15`，undo 回到 `5` |
| 连续拖动 10 步 | ✅ **一条**撤销恢复到拖动前 |
| 修改中途切换节点 | ✅ **不串值**到新节点 |
| 无效输入 | ✅ 不进入模型 |
| 无变化输入 | ✅ **不产生事务** |
| 撤销后重新编辑 | ✅ 正常 |

> **首次编辑完全可以撤销** —— P4A 时看起来"不能"，是测试方法问题（基准未建立），
> 不是 `UndoStack` 的缺陷。因此**本阶段未修改 `UndoStack`**。

---

## 六、端到端性能数据（60 控件场景）

### 6.1 分段测量（中位数 / P95，单位 ms）

| 路径 | 中位数 | P95 | 说明 |
|---|---|---|---|
| `renderProps`（旧面板纯刷新） | **0.5** | 0.8 | 重建整个属性面板 DOM |
| `SchemaRenderer.update`（新面板纯刷新） | **~0** | 0.1 | 只改值 |
| **`refreshAll`（全量刷新）** | **33.7** | **69.9** | **真实瓶颈** |
| `draw`（画布绘制） | 0.7 | 1.2 | |
| **完整交互（走新面板）** | **42.3** | **53.4** | setOnce = commit + syncJson + refreshAll |
| **完整交互（旧路径等价）** | **51.3** | **64.7** | 直接 commit |

### 6.2 ⚠️ 修正 P4A 报告的一处不准确表述

P4A 报告写"性能提升 38.8×"（0.310ms → 0.0080ms）。

**这个比值只代表"属性面板自身的刷新耗时"，不能当作整体性能提升。** 实测：

- 属性面板刷新只占完整交互的 **约 1%**（0.5ms / 42.3ms）
- **真正的大头是 `refreshAll` 的 33.7 ms（中位数）/ 69.9 ms（P95）**

### 6.3 DOM 重建次数（10 次刷新）

| 面板 | 重建次数 |
|---|---|
| 旧 `#props` | **10 / 10** |
| 新 `#schemaProps` | **0 / 10** |

**这才是新面板的真实收益**：不是"更快"（快 0.5ms 对 42ms 无感），而是**不重建 DOM** ——
焦点丢失、光标跳位、拖动被截断的根因。

### 6.4 完整交互对比

新路径（42.3ms）比旧路径（51.3ms）**快约 9ms（约 18%）**，
但这**主要来自新面板不重建属性面板 DOM**，不是属性面板本身的速度差异。

---

## 七、全量回归测试结果

| 层 | P4A | **P4A.1** |
|---|---|---|
| 套件 | 46 | **47** |
| 断言 | 5441 | **5526** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：`+ verify-p4a1-hardening 新增 85`。

---

## 八、文件修改清单

### 修改（3）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | **删除内置 `TRACK_SCHEMA`**；`SchemaResolver` 改为从 Registry 取代表定义；新增 `EDITABLE` 表 |
| `tools/icarui/js/app.js` | `refreshAll()` 追加 Schema 面板同步（+9 行）|
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 新增（1）

| 文件 | 说明 |
|---|---|
| `tools/icarui/tests/verify-p4a1-hardening.js` | **85 条断言** |

### 未改动（关键）

- **`app/`（Android）**、**`icar.ui/2`**
- **`panels.js`**（零改动）
- **`registry/`**（零改动）
- `presets.js` / `model.js` / `schema.js` / `canvas.js`
- `cd_*` 默认值、`bar_*`、`UndoStack`（未重写）

---

## 九、剩余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | **`refreshAll` 是真正瓶颈**（33.7/69.9ms）| **高** | 属性面板优化只占 1%；要真正提速必须动 `renderPanels`，那是 P4B+ 的事 |
| R2 | **Tab 切换焦点未测** | 中 | 缺 `Input.dispatchKeyEvent` 的 Tab 序列验证 |
| R3 | **光标移动 / 部分选择未充分测** | 中 | 只验证了 `select()` + Ctrl+A，未逐字符移动验证 |
| R4 | **无真实 DOM 滑块** | 中 | 4 个字段都是 text/select/checkbox；"滑块测试"是事务 API 序列 |
| R5 | 未人工判读 UI | 中 | 模型无图像输入 |
| R6 | Schema 面板只覆盖轨道 | 中 | 其余 187 条仍走旧面板 |
| R7 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |

---

## 十、P4B 文字属性面板迁移建议

### 10.1 现在可以直接做的（P4A.1 已铺好）

| 项 | 状态 |
|---|---|
| 单一事实源机制 | ✅ 已建立，加新族只需写 `EDITABLE` 一行 |
| 双向同步 | ✅ 由 `refreshAll` 统一驱动，新族自动获得 |
| 持久化能力识别 | ✅ 模式已验证（`type + 特征字段`）|
| 插入适配层 | ✅ 7 类来源已覆盖 |

### 10.2 P4B 需要做的三件事

1. **在 `SchemaResolver` 加 `isText(node)`**：
   ```js
   node.type === "text"      // text 节点没有别的特征字段，type 就够
   ```
2. **在 `EDITABLE` 加一行**：
   ```js
   text: ["text", "font.size", "font.weight", "font.color", "font.align"]
   ```
3. **`ControlRegistry` 里确认文字族的 `render.mode === "text"`**（已有）

**不需要写新的字段表** —— P4A.1 消除重复定义后，字段全部来自 Registry。

### 10.3 P4B 必须注意的坑

| 坑 | 说明 |
|---|---|
| **`normalizeFont` 静默归一** | 非法字号会被重置为默认（D-01 根因）。校验必须**先于**模型写入 —— 现有 `PropertyValidator` 已满足 |
| **D-01 字体异常** | `box_h1/h2/note` 的实际字号是 6（不是源码的 30）。面板显示的是**实际值**，用户会看到 6 —— 这是正确的，**不要"修正"它** |
| **`font` 是嵌套对象** | 已验证点号路径可用（`font.size`）|
| **`text` 字段允许空串** | 文字内容可以为空，validator 不能拒绝 |

### 10.4 建议的 P4B 开放字段（保守）

第一批只开 5 个：`text`、`font.size`、`font.weight`、`font.color`、`font.align`。
其余（`w/h/rotation/alpha` 等）继续走旧面板。

### 10.5 建议 P4B 之前先补的测试能力

1. **Tab 焦点切换**：`Input.dispatchKeyEvent` 带 `key: "Tab"`
2. **光标移动**：`ArrowLeft/ArrowRight` + 检查 `selectionStart`
3. **部分选择**：`Shift+ArrowRight` + 检查 `selectionEnd`

这三项是 P4A.1 的已知缺口（§9 R2/R3）。

---

## 十一、未验证边界

1. **未人工判读 UI**
2. **Tab 切换焦点未测**
3. **光标移动与部分选择的逐字符验证未做**
4. **无真实 `<input type="range">`** —— 4 个字段都不是滑块，事务序列只代表语义
5. 未在真机上验证；无真车证据
6. `ext` 透传未实施
