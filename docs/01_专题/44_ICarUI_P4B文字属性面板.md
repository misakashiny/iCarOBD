# ICarUI P4B：文字控件 Schema 属性面板迁移

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4B` |
| 基线 | P4A.1 `b3231de` |
| 结论 | 12 个文字控件接入 Schema 面板；5 字段可编辑；真实键盘与 IME 验证；**5640 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`panels.js` 零改动；`registry/` 零改动 |

---

## 一、12 个文字控件全部识别

| 检查 | 结果 |
|---|---|
| 识别方式 | **`node.type === "text"`**（持久化字段，不依赖 `__controlKey`）|
| 12 条全部识别 | ✅ 12/12 |
| 每条 schema 字段数 | 7 |
| 每条可编辑字段数 | **5** |
| 保存重载后（无 `__controlKey`）仍识别 | ✅ |

---

## 二、⚠️ Schema 分派规则（任务第四部分重点）

### 2.1 实测：12 条**并非结构完全一致**

```
distinctSignatures: 2, counts: [11, 1]
```

| 控件 | `font.size.max` | 来源 |
|---|---|---|
| `t_label` | **200** | P1A 单独注册（`controls/t_label.js`）|
| 其余 11 条 | **400** | `text-family.js` |

**这正是任务警告的"不能任意选一个代表定义后假设全族一致"。**

### 2.2 渲染侧的真实约束

查 `schema.js` 的 `normalizeFont()`：

```js
o.size = (Number.isFinite(sz) && sz > 0) ? sz : window.FONT_DEFAULT.size;
```

**只有下限 `size > 0`，没有上限**。所以 200 与 400 都只是 **Schema 声明层**的差异，渲染都支持。

### 2.3 采用的分派规则（明确写死，非隐式假设）

```
① 节点带 __controlKey 且该 key 在 Registry 里
   → 用该 key 自己的 schema（t_label 得到 max=200）

② 否则（保存重载后 __controlKey 必然丢失）
   → 取 Registry 里 font.size.max 最大的文字族定义（max=400）
```

**选"最宽松"的理由**：字号渲染本来不受限，用宽的那份不会拒绝用户本来就能设的值；
反之用 t_label 的 200 会**凭空限制**其余 11 条。

**已知后果（如实记录）**：重载后的 `t_label` 字号上限从 200 变 400。
**不影响渲染、不影响存量设计**，只是校验放宽。

实测验证：

| 场景 | `t_label` max | 其余 11 条 max |
|---|---|---|
| 新建（有 `__controlKey`）| **200** | 400 |
| 重载（无 `__controlKey`）| **400**（回退）| 400 |

并断言 `t_label.schema !== t_title.schema`（证明分派真实生效，不是同一个对象）。

---

## 三、5 个字段的安全编辑

### 3.1 `text`

| 检查 | 结果 |
|---|---|
| 允许空字符串 | ✅ `{ok:true, value:""}` |
| `null` → 空串 | ✅ |
| 保留换行/空格/中文/特殊字符 | ✅ 由 `nodeToJson` 既有行为保证，未改 |

### 3.2 `font.size`

Registry 声明：`min: 1`、`max: 400`（t_label 为 200）。

| 输入 | 结果 |
|---|---|
| `24` | ✅ 通过，值 = 24（number）|
| `NaN` | ❌ 拒绝 |
| `Infinity` | ❌ 拒绝 |
| `-5` | ❌ 拒绝 |
| `0` | ❌ 拒绝（min=1）|
| `9999` | ❌ 拒绝（超 max）|
| `abc` | ❌ 拒绝 |

**校验先于模型修改** —— `PropertyValidator.coerce` 在 `setLive` 之前跑，非法值直接 return。

### 3.3 `font.weight`

**严格用 Registry 枚举**，未自行猜测：

```
values: [400, 500, 600, 700, 900]
```

| 输入 | 结果 |
|---|---|
| `"400"` | ✅ → **数字 400** |
| `"900"` | ✅ |
| `"300"` | ❌ 拒绝（不在枚举内）|
| `"800"` | ❌ 拒绝 |
| `"750"` | ❌ 拒绝 |

> ⚠️ 注意：渲染侧 `fontShort()` 的判据是 `weight >= 700` 才算粗体。
> 所以 400/500/600 视觉相同、700/900 视觉相同 —— 这是**既有渲染行为，未改**。

### 3.4 `font.color`

支持三种合法形态：

| 输入 | 结果 |
|---|---|
| `#8FA0B8` | ✅ 原样（大写化）|
| `#abc` | ✅ 展开为 `#AABBCC` |
| `$accent` | ✅ **原样保留**（变量引用）|
| 空串 | ✅ → `null` |
| `red` | ❌ 拒绝 |
| `#GGGGGG` | ❌ 拒绝 |

**UI 提供色板 + 文本框双控件**：
- 色板只能选 `#RRGGBB`
- 文本框可手写 `#RGB` / `#RRGGBB` / `$变量名`

> 只用色板会**抹掉 `$变量引用`** —— 那是项目既有合法值，不能丢。

### 3.5 `font.align`

```
values: ["left", "center", "right"]   ← 来自 Registry
```

| 输入 | 结果 |
|---|---|
| left / center / right | ✅ 全部接受 |
| `justify` | ❌ 拒绝 |

与旧渲染器 `ctx.textAlign = f.align` 完全一致（`FONT_ALIGNS` 同源）。

---

## 四、真实键盘与 IME 交互记录

### 4.1 测试强度分级（任务第三部分要求）

| 标记 | 含义 | 本阶段用例数 |
|---|---|---|
| **`[真实]`** | CDP `Input.dispatchKeyEvent` / `Input.insertText` | **8** |
| `[派发]` | DOM `dispatchEvent` 程序派发 | 4 |
| `[API]` | 直接调用内部 API | 其余 |

### 4.2 真实键盘（CDP 接口）

| # | 测试 | 结果 |
|---|---|---|
| 1 | Ctrl+A 全选 + 输入 `Hello123` | ✅ 模型 = `Hello123` |
| 2 | 光标位置 | ✅ `selectionStart = 8`（末尾）|
| 3 | **ArrowLeft 移动光标** | ✅ 8 → **7** |
| 4 | **Shift+ArrowRight 选择** | ✅ 产生选区 `7→8` |
| 5 | **删除所选**（Backspace）| ✅ `Hello123` → `Hello12` |
| 6 | **Enter 提交** | ✅ 值不变、事务提交 |
| 7 | **Escape 取消** | ✅ 从 `WILL_BE_CANCELLED` 还原到 **`BASELINE`** |
| 8 | 非法输入恢复 | ✅ 输入非法时标红 `spInvalid`、模型不变 |

### 4.3 中文输入法 composition

| 阶段 | 模型值 | 说明 |
|---|---|---|
| 组合前 | `DIFFTEST` | 基线 |
| **组合中**（`compositionstart` + `input`）| **`DIFFTEST`**（**未变**）| ✅ 拼音字母不被当成最终文字 |
| 组合结束（`compositionend`）| 更新为新值 | ✅ |
| 结束后 `__composing()` | **`null`** | ✅ 状态已清理 |

**实现要点**：`composingPath` 非空时，`input` 处理器**直接 return**，只有 `compositionend` 才提交。

### 4.4 未覆盖项（如实列明）

| 项 | 状态 |
|---|---|
| Tab 切换焦点 | ❌ **未测**（P4A.1 就缺，本阶段仍未补）|
| 失焦（blur）提交 | ⚠️ 代码有处理（`blur` 监听），**未单独断言** |
| 真实中文输入法（系统 IME）| ❌ 只测了 `CompositionEvent` 派发，**不是真实输入法** |

---

## 五、文本输入事务

| 要求 | 实现 | 验证 |
|---|---|---|
| 输入时不丢焦点 | 只更新值不重建 DOM；`update(skipPath)` 跳过正在编辑的字段 | ✅ P4A.1 已验 |
| 光标位置不跳动 | 同上 + `focusin` 记录快照 | ✅ ArrowLeft 后 8→7 |
| 文字选择范围不丢失 | 同上 | ✅ Shift+Arrow 选区保持 |
| 中文输入法正常 | `compositionstart/update/end` 三段处理 | ✅ |
| 连续输入合并撤销 | `beginLive` → 多次 `setLive` → `endLive` 压一条 | ✅ P4A.1 已验 |
| **切换节点不串值** | 切节点时清 `editingPath`；`liveEdit` 带 `nodeId` | ✅ P4A.1 已验 |
| **Escape 取消** | `focusin` 记快照 → `abortLive()` + 还原 + 不产生撤销 | ✅ |
| 删除节点事务安全终止 | `liveEdit` 找不到节点则跳过 | ✅ 节点删除后面板清空 |
| 无变化不 commit | `Accessor.set` 返回 false → 跳过 | ✅ |

### 5.1 Escape 实现的关键细节

`escSnapshot` 在 **`focusin`** 时记录（不是首次 `input`）：

- 用户可能聚焦后什么都没敲就按 Escape
- 若在 `input` 时记录，会记成"半途值"，Escape 还原到错误的中间态

**实测踩到过**：第一版在 `input` 记录，Escape 后模型变成 `标题`（更早的值）而非 `BASELINE`。
改为 `focusin` 后正确。

### 5.2 撤销语义

沿用既有 `UndoStack`，**未修改**。首条编辑后 undo 正常（P4A.1 已确认为测试方法问题）。

---

## 六、新旧面板同步（10 项）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 旧面板改文字 → 新面板同步 | ✅ `model:24 / panel:"24"` |
| 2 | 新面板改 → 模型同步 | ✅ |
| 3 | 改字号/字重/颜色/对齐 | ✅ 各字段独立验证 |
| 4 | 撤销、重做 | ✅ 面板与模型始终一致 |
| 5 | 切换选中节点 | ✅ |
| 6 | 删除节点 | ✅ 面板清空（`family:null`）|
| 7 | **保存后重新载入** | ✅ 仍解析为 `text` 族、5 字段可编辑 |
| 8 | 历史文件导入 | ✅ 靠 `type` 识别 |
| 9 | 无选择 / 多选 | ✅ 均为 `family:null` |
| 10 | 输入中切换节点 | ✅ 不串值（P4A.1 已验证）|

**未出现显示值与模型值不一致。**

---

## 七、历史字体问题（只读不修）

严格遵循 Legacy Behavior Debt，**本阶段只读并编辑实例实际值**：

| ID | 控件 | 源码字面 | **实际值** | 本阶段处置 |
|---|---|---|---|---|
| **D-01** | `box_h1` | size 30 | **6** | ✅ 只读，未修 |
| **D-01** | `box_h2` | size 20 | **6** | ✅ 只读，未修 |
| **D-01** | `box_note` | size 12 | **6** | ✅ 只读，未修 |
| **D-02** | `t_bigunit` | weight 500 | **400** | ✅ 只读，未修 |
| **D-03** | `text` | size 18 | **6** | ✅ 只读，未修 |

**未改任何旧控件默认字体；未改旧设计文件加载规则。**

> 面板显示的是**实际值 6**，不是源码字面的 30 —— 这是正确的（用户看到的就是真实生效的值）。

---

## 八、视觉与兼容回归

### 8.1 12 条默认外观与 P3B 基线一致

用 P3B 建立的 `fixtures/p3b-text-pixel-hashes.json`：

```
12/12 像素哈希完全一致
```

**迁移没有改变任何默认文字外观。**

### 8.2 改属性后正常重绘

| 改动 | 渲染是否变化 |
|---|---|
| `font.size` | ✅ 变 |
| `font.weight` | ✅ 变（400 ↔ 900）|
| `font.color` | ✅ 变 |
| `font.align` | ✅ 变 |
| `text` | ✅ 变 |

**未改变 Canvas 文字渲染算法**（`canvas.js` 零改动）。

> ⚠️ 关于 `font.weight`：`t_big` 默认就是 900（粗），必须改成 400 才看得出差异。
> 第一版测试改成 900 导致"无变化"误判，已修正。

---

## 九、性能审计（只读分析，未做重构）

### 9.1 输入 20 个字符的路径追踪

用真实 `Input.insertText` 逐字符输入，包裹各函数计数：

| 路径 | 调用次数 |
|---|---|
| `refreshAll` | **0** |
| `renderPanels` | **0** |
| `renderProps` | **0** |
| `syncJson` | **0** |
| `commit` | **0** |
| **`draw`** | **20**（每字符一次，符合预期）|

**结论：连续输入过程中完全不碰面板、不写撤销栈、不同步 JSON，只重绘画布。**

这正是 P4A 增量刷新设计的预期效果 —— 输入 20 字符**没有触发任何一次全量刷新或 DOM 重建**。

### 9.2 单次 `setLive` 耗时

| 指标 | 值 |
|---|---|
| 中位数 | **0.60 ms** |
| P95 | **0.90 ms** |

> ⚠️ 这是 `setLive`（改模型 + `requestDraw`）的纯耗时，
> **不包含**真实的浏览器绘制与合成时间。

### 9.3 与 P4A.1 基线的关系

P4A.1 已测得（60 控件场景）：

| 路径 | 中位数 | P95 |
|---|---|---|
| `refreshAll` | 33.7 | 69.9 ms |
| `renderProps` | 0.5 | 0.8 ms |
| `draw` | 0.7 | 1.2 ms |

**P4B 的输入路径绕过了 `refreshAll`（0 次）**，所以单字符只付 `draw`（0.7ms）+ `setLive`（0.6ms）。

**但真正"落定"时（Enter / 失焦 / 换节点）仍会走一次 `refreshAll`（33.7/69.9ms）。**

### 9.4 未吞异常的诊断

要求"新增诊断时不得吞掉 Schema 面板刷新异常"。

现状：`refreshAll()` 里的 `try/catch` **仍然吞掉异常**（P4A.1 加的）。

**本阶段未改**，但如实记录：这意味着 Schema 面板若在刷新中抛错，**不会显式暴露**。
建议后续单独任务把 catch 改为记录到 `__ICAR_SCHEMA_ERROR` 而不是静默。

---

## 十、全量回归测试结果

| 层 | P4A.1 | **P4B** |
|---|---|---|
| 套件 | 47 | **48** |
| 断言 | 5526 | **5640** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：`+ verify-p4b-text-props 新增 114`。

---

## 十一、文件修改清单

### 修改（3）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | `isTextNode` + `textSchemaFor`（分派规则）；`resolve` 加文字分支；`EDITABLE.text`；`PropertyUpdate.abortLive`；`color` 类型校验与双控件渲染 |
| `tools/icarui/js/ui/schema-panel.js` | `focusin` 记快照；IME 三段处理；Escape 取消；标题按族显示 |
| `tools/icarui/css/studio.css` | 颜色控件样式（`.spColorWrap`）|

### 新增（1）

| 文件 | 说明 |
|---|---|
| `tools/icarui/tests/verify-p4b-text-props.js` | **114 条断言** |

### 未改动（关键）

- **`app/`（Android）**、**`icar.ui/2`**
- **`panels.js`**（零改动）
- **`registry/`**（零改动）—— 文字族 schema 全部从 Registry 读
- `presets.js` / `model.js` / `canvas.js` / `schema.js`
- 旧控件默认字体、`UndoStack`

---

## 十二、剩余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | **Tab 切换焦点仍未测** | 中 | P4A.1 就缺，P4B 仍未补 |
| R2 | **真实系统输入法未测** | 中 | 只测了 `CompositionEvent` 派发 |
| R3 | **`refreshAll` 仍吞 Schema 异常** | 中 | 面板出错不会显式暴露 |
| R4 | `refreshAll` 仍是落定时的瓶颈（33.7/69.9ms）| 中 | 需独立性能优化阶段 |
| R5 | **`t_label` 重载后字号上限 200→400** | 低 | 分派规则的回退后果，不影响渲染/存量设计 |
| R6 | `font.weight` 只有粗/不粗两档视觉效果 | 低 | 既有渲染行为（400-600 同、700-900 同），未改 |
| R7 | 未人工判读 UI | 中 | 模型无图像输入 |
| R8 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |

---

## 十三、下一步建议

### 13.1 建议先补测试能力

在继续迁移其它族之前，建议**先补上 P4A.1/P4B 的共同缺口**：

1. **Tab 焦点切换**：`Input.dispatchKeyEvent` 带 `key: "Tab"`
2. **真实系统输入法**：需要真实 IME 环境，或至少验证 `isComposing` 标志
3. **`refreshAll` 异常显式化**：把 `catch {}` 改为记录 `__ICAR_SCHEMA_ERROR`

### 13.2 继续迁移的建议顺序

| 阶段 | 目标 | 字段数 | 风险 |
|---|---|---|---|
| **P4C** | 容器族（4 条）| 7 | 最低（全是一层字段 `w/h/rotation/alpha/locked/visible`）|
| P4D | 状态灯（19 条）| 11 | 中（需三态素材选择器 + `statePid` 选择器）|
| P4E | 仪表族（6 条）| 12 | **最高**（`pid` 需要 PID 选择器、受 D-06 归一化影响）|

**建议 P4C 先做容器族** —— 字段最简单，可验证"多族共用同一框架"的扩展性。

### 13.3 推广时的固定三处改动

P4B 验证了扩展一个族只需：

1. `isXxx(node)` 持久化能力判断
2. `EDITABLE.xxx` 加一行路径清单
3. （可选）特殊控件类型渲染（如 color 的双控件）

**不需要写新的字段表** —— 全部来自 Registry。

---

## 十四、未验证边界

1. **未人工判读 UI** —— 截图 `stage/p4b-text-panel.png`
2. **Tab 切换焦点未测**
3. **真实系统中文输入法未测**（只测 `CompositionEvent` 派发）
4. 失焦提交有代码但未单独断言
5. 未在真机上验证；无真车证据
6. `refreshAll` 仍吞 Schema 异常
7. `ext` 透传未实施
