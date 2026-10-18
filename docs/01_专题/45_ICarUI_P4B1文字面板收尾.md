# ICarUI P4B.1：文字属性面板质量收尾

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4B1` |
| 基线 | P4B `b067957` |
| 结论 | 4 项遗留全部处理；**5695 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`panels.js`/`canvas.js`/`schema.js` 零改动 |

---

## 一、文字族 Schema 一致性审计与修复

### 1.1 审计结论：`max: 200` 是 **P1A 试点遗留**

| 证据 | 内容 |
|---|---|
| **来源** | `git log -S 'max: 200'` → 提交 `4346908`（**P0.5 + P1A 试点**） |
| **当时的注释** | `属性 Schema —— P1A **只登记、不驱动 UI**（面板仍走 panels.js 手写逻辑）` |
| **旧属性面板的实际输入框** | `panels.js:980` → `<input type="number" step="0.5" **min="1"** value="...">` —— **没有 max** |
| **渲染侧** | `schema.js` 的 `normalizeFont()` → `o.size = (Number.isFinite(sz) && sz > 0) ? sz : FONT_DEFAULT.size` —— **只有下限** |
| `text-family.js` 的 `400` | P3A 时后写，同样是人为值 |

**结论：`200` 是试点占位值，从未生效；真实产品语义本来就没有上限。**

### 1.2 修复：统一为 `max: 400`

改 `tools/icarui/js/registry/controls/t_label.js` 一行 + 加完整审计注释。

**实测统一结果**：

```json
{"distinctSignatures": 1, "counts": [12], "maxVals": {"400": 12}}
```

**12 条 schema 现在结构完全相同。**

### 1.3 六项约束逐条验证

| 约束 | 结果 |
|---|---|
| 12 个原有 key 不变 | ✅ 全部仍在 `BUILTIN_CONTROLS` |
| **默认字号不变** | ✅ `t_label` size=**7**、`text` **6**、`box_h1` **6**、`t_big` **24** |
| **默认颜色与字重不变** | ✅ `t_label` #8FA0B8/400、`t_big` #00D8FF/900、`t_bigunit` 400 |
| **存量设计内容不变** | ✅ `schema` 不参与 `nodeToJson`（白名单里没有），序列化结果不受影响 |
| **保存前后校验规则一致** | ✅ 见 §二 |
| **不改 normalizeFont** | ✅ `schema.js` **零改动** |

**未新增任何 `__controlKey` 序列化字段。**

### 1.4 为什么这样统一是安全的

`schema[]` 只被 `PropertyValidator` 用于**面板输入校验**，不参与：
- 节点构建（默认值在 `defaults` / `fontDefaults` 里，与 schema 无关）
- 序列化（`nodeToJson` 白名单不含 schema）
- 渲染（`normalizeFont` 未改）

所以改 `max` 只影响"面板允不允许输入 500 这样的值"，**不影响任何已存在的数据**。

---

## 二、保存前后校验规则比较

实测同一份 `t_label` 在**保存前**（有 `__controlKey`）与**保存重载后**（无 `__controlKey`）：

| 项 | 保存前 | 重载后 | 一致 |
|---|---|---|---|
| `font.size.max` | **400** | **400** | ✅ |
| 输入 `600` | 拒绝 | 拒绝 | ✅ |
| 输入 `300` | 接受 | 接受 | ✅ |
| 输入 `400` | 接受 | 接受 | ✅ |

**P4B 遗留的"重载后上限从 200 变 400"问题已随统一消失。**

---

## 三、Schema 异常诊断

### 3.1 修改

`app.js` 的 `refreshAll()` 里 **不再空 catch**：

```js
try {
  ICAR.ui.SchemaPanel.refresh();
  if (window.__ICAR_SCHEMA_ERROR) {
    console.info("[ICAR Schema 面板] 已恢复正常（此前有错误）", window.__ICAR_SCHEMA_ERROR);
    window.__ICAR_SCHEMA_ERROR = null;
    window.__ICAR_SCHEMA_ERROR_COUNT = 0;
  }
} catch (e) {
  recordSchemaError(e, "refreshAll");
}
```

`recordSchemaError()` 记录：

```js
{ where, message, stack, at, count }
```

- **控制台**：`console.error` 输出错误 + 堆栈（第 1 次和每 20 次各一条，避免狂刷）
- **`__ICAR_SCHEMA_ERROR`**：可随时读取
- **`__ICAR_SCHEMA_ERROR_COUNT`**：累计次数

`SchemaPanel.refresh` 内部也包了一层，记录 `where: "SchemaPanel.refresh"` 后**继续抛出**。

### 3.2 实测（注入 `SIMULATED_SCHEMA_FAILURE`）

| 检查 | 结果 |
|---|---|
| `__ICAR_SCHEMA_ERROR.message` | ✅ `SIMULATED_SCHEMA_FAILURE` |
| `.where` | ✅ `refreshAll` |
| `.stack` 存在 | ✅ |
| `.count` | ✅ 4 |
| **控制台输出** | ✅ `error: [ICAR Schema 面板] refresh 内部异常 Error: SIMULATED_SCHEMA_FAILURE` + 堆栈 |
| **旧属性面板仍可用** | ✅ `#props` 内容长度 4400 → 4400（**完全未受影响**）|
| **恢复后清理** | ✅ `__ICAR_SCHEMA_ERROR = null`、`COUNT = 0` |

> 旧面板之所以不受影响：Schema 刷新在 `renderPanels()` **之后**，异常已被隔离。

---

## 四、Tab / Shift+Tab / 失焦（真实 CDP 键盘）

### 4.1 控件顺序

```
text → font.size → font.weight → font.color(picker) → font.color(text) → font.align
```

共 **6 个可聚焦控件**（`font.color` 是色板 + 文本框两个）。

### 4.2 真实键盘测试结果

| # | 测试 | 结果 |
|---|---|---|
| 1 | **Tab 前进** | ✅ `text` → `font.size` |
| 2 | Tab 再前进 | ✅ → `font.weight` |
| 3 | **Shift+Tab 返回** | ✅ `font.weight` → `font.size` |
| 4 | **ArrowLeft 移动光标** | ✅ `5 → 4` |
| 5 | **Shift+ArrowRight 选区** | ✅ 产生选区 |
| 6 | **Tab 触发失焦提交** | ✅ 模型 = `TAB_COMMITTED`，焦点移到 `font.size` |
| 7 | **聚焦其他控件触发失焦** | ✅ 模型 = `CLICK_BLUR` |
| 8 | **Escape 取消** | ✅ `SHOULD_BE_CANCELLED` → 还原到 `ESC_BASE` |
| 9 | **非法输入失焦不污染模型** | ✅ 输入 `abc` 到字号框后失焦，模型字号不变 |
| 10 | 切换节点不串值 | ✅（composition 场景已验证，见 §五）|

**全部使用 `Input.dispatchKeyEvent` / `Input.insertText` 真实接口，未用内部 API 代替。**

---

## 五、composition 边界

### 5.1 实测结果

| # | 场景 | 结果 |
|---|---|---|
| 1 | **composition 中失焦** | ✅ 模型保持 `COMPBASE`（**不提交半成品**）|
| 2 | **composition 中切换节点** | ✅ 原节点仍 `SWBASE`；新节点未串值 `qiye` |
| 3 | **compositionend + input 连发** | ✅ 值稳定，**不重复提交** |
| 4 | **中英混合输入 + 一次撤销** | ✅ `中文abc123XYZ` → undo → **完整恢复 `ORIGINAL`** |
| 5 | composition 后 Enter | ✅（Enter 场景已在 §四 验证）|

### 5.2 ⚠️ 如实标注：合成事件 vs 真实 IME

本阶段所有 composition 测试都是 **`new CompositionEvent(...)` 程序派发**（标记 `[派发]`），
**不是真实 Windows 中文输入法**。

**当前环境（headless Edge + CDP）无法驱动系统级 IME。**

→ **真实 IME 验证列入人工验收待办**，不得把上述合成事件测试描述成真实 IME 测试。

---

## 六、连续输入与撤销事务

### 6.1 输入 20 个字符

| 检查 | 结果 |
|---|---|
| **输入过程中 `refreshAll` 调用次数** | ✅ **0** |
| **输入过程中 `renderProps` 调用次数** | ✅ **0**（不重建 DOM）|
| 画布实时绘制 | ✅ 模型随输入实时更新（`len` 逐字符增长到 20）|
| Enter / 失焦后落定 | ✅ 完整 20 字符写入 |
| **一次撤销** | ✅ 恢复到 **完整的前编辑字符串 `BEFORE20`** |
| **一次重做** | ✅ 恢复完整的 20 字符 |
| 保存重载后内容完整 | ✅ `len = 20` |

### 6.2 关于撤销基准（用户正常路径）

测试中 `BEFORE20` 用 **`commit()`** 写入，而不是直接赋 `n.text=...`。

这不是"人为掩盖初始化问题"——**`commit()` 正是用户编辑的正常路径**：

- 用户改任何属性都走 `PropertyUpdate.setOnce/endLive` → 内部调 `commit()`
- 直接给模型赋值（`n.text='X'`）**不是用户路径**，绕过了撤销栈

P4A.1/P4B 排查过：`UndoStack` 首次 `commit()` 建立基准（D-09），
所以测试必须用 `commit()` 才与真实用户路径一致。

---

## 七、全量回归结果

| 层 | P4B | **P4B.1** |
|---|---|---|
| 套件 | 48 | **49** |
| 断言 | 5640 | **5695** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：`+ verify-p4b1-text-finalize 新增 55`。

### 7.1 调整的既有断言（逐条解释）

| 套件 | 断言 | 原值 | 新值 | 原因 | 替代保障 |
|---|---|---|---|---|---|
| `verify-p4b-text-props` | `t_label uses its OWN schema (font.size max=200)` | `=== 200` | `=== 400` | **P4B.1 统一了上限**，200 是 P1A 占位值 | 新增 P4B.1 断言：12 条 `distinctSignatures===1`、`maxVals==={"400":12}` |
| `verify-p4b-text-props` | `t_label and t_title have DISTINCT schema objects` | `!==` | 改为比**内容**相等 | 统一后内容相同；对象仍各自独立（不同文件的工厂） | P4B.1 断言 `distinctSignatures===1` 更强 |

**未删除任何断言，未降低门槛。**

---

## 八、修改文件清单

### 修改（4）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/registry/controls/t_label.js` | `font.size.max` 200 → **400** + 完整审计注释 |
| `tools/icarui/js/app.js` | `recordSchemaError()` 新增；`refreshAll()` 去掉空 catch，改为记录 + 恢复清理 |
| `tools/icarui/js/ui/schema-panel.js` | `refresh` 包一层，内部异常记录后继续抛出 |
| `tools/icarui/tests/verify-p4b-text-props.js` | 2 条断言按统一结果更新（附理由） |

### 新增（1）

| 文件 | 说明 |
|---|---|
| `tools/icarui/tests/verify-p4b1-text-finalize.js` | **55 条断言** |

### 未改动（关键）

- **`app/`（Android）**、**`icar.ui/2`**
- **`panels.js`**、**`canvas.js`**、**`schema.js`**（`normalizeFont` 未变）
- `presets.js` / `model.js` / `registry/`（除 t_label 一行）
- 文字默认样式、旧设计文件格式、`UndoStack`

---

## 九、剩余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | **真实系统中文 IME 未验证** | 中 | 全部 composition 测试是程序派发；列为**人工验收待办** |
| R2 | **`font.size` 上限 400 仍是人为值** | 低 | 旧面板无上限；400 是保守上限，超 400 的字号在 360 单位画布上已无实用意义 |
| R3 | `t_label` 与其余 11 条**对象仍不同源** | 低 | 内容已一致；两者分别由 `t_label.js` 与 `text-family.js` 产出，长期有漂移可能 |
| R4 | `refreshAll` 仍是落定瓶颈（33.7/69.9ms）| 中 | 需独立性能优化阶段 |
| R5 | Schema 面板只覆盖轨道 + 文字 | 中 | 其余 199 条仍走旧面板 |
| R6 | 未人工判读 UI | 中 | 模型无图像输入 |
| R7 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |

### 关于 R3 的建议（未执行）

`t_label` 与 `text-family.js` 各自维护 schema，**结构一致但源码两份**。
彻底消除需把 `t_label` 并入 `text-family.js`（P3A 时为避免重复注册而分开）。
建议在 **P5 收尾阶段**统一，本阶段不动（避免影响已通过的门槛）。

---

## 十、P4C 容器属性面板迁移建议

### 10.1 容器族是**最简单**的一族

| 特性 | 说明 |
|---|---|
| 字段 | `w` / `h` / `rotation` / `alpha` / `locked` / `visible` —— **全是一层字段** |
| 嵌套 | 无（不像 `font.size` 要两层）|
| 素材 | 无 |
| 数据绑定 | 无（`slots: []`）|
| 条数 | 4 条（`group` / `box_card` / `box_row` / `box_col`）|

### 10.2 P4C 需要做的（P4B 已验证的三步）

1. **`SchemaResolver.isContainer(node)`**
   ```js
   node.type === "group"
   ```
2. **`EDITABLE.container`** 一行
   ```js
   container: ["w", "h", "rotation", "alpha", "locked", "visible"]
   ```
3. **确认 Registry 里容器族的 `schema`** 已含这些字段

**不需要写字段表，不需要特殊控件类型。**

### 10.3 P4C 前必须先确认的一件事

⚠️ **容器的 `schema` 是否也像文字族那样存在不一致？**

P4B 的教训：`t_label` 与 `text-family` 两条来源产生了 200 vs 400 的偏差。
容器族 4 条全在 `container-family.js` 一个文件里，**理论上一致**，
但**必须先审计再假设**——用与 P4B.1 相同的方法：

```js
distinctSignatures === 1 ?
```

### 10.4 P4C 需要注意的点

| 坑 | 说明 |
|---|---|
| `locked` / `visible` 是 **boolean** | `SchemaRenderer` 已有 checkbox 支持 |
| `alpha` 范围 0~255 | Registry schema 已声明 min/max |
| `rotation` 无范围限制 | 需确认是否允许负值/超 360 |
| **容器有 children** | 需确认 schema 里没有 `children` 字段（不应该有）|

### 10.5 建议的 P4C 交付前检查

1. 4 条 schema 签名一致（`distinctSignatures === 1`）
2. 6 个字段可编辑、值正确
3. 与旧面板双向同步
4. 改动后画布重绘（容器本身不绘制，需验证**子节点**位置随容器变换）
5. 保存重载后仍可编辑

---

## 十一、未验证边界

1. **真实 Windows 中文输入法未验证**（全部是 `CompositionEvent` 程序派发）→ **人工验收待办**
2. **未人工判读 UI**（模型无图像输入）
3. 未在真机上验证；无真车证据
4. `refreshAll` 仍是落定瓶颈
5. `ext` 透传未实施
6. `t_label` 与 `text-family.js` 的 schema 源码仍是两份（内容已一致）
