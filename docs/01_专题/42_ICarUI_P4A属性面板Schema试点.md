# ICarUI P4A：Schema 属性面板试点

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4A` |
| 基线 | P3D `9a4ec06` |
| 结论 | 修复 P3D 遗留的**添加功能静默失效**；Schema 框架落地；**5441 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；**`panels.js` 零改动**；`registry/` 零改动 |

---

## 一、P3D 遗留核验结果（第二部分）

### 1.1 ⚠️ 发现并修复一个阻断性 Bug：双击/点击添加**完全失效**

**核验方法**：实测三个入口的实际行为。

| 入口 | 核验前 | 说明 |
|---|---|---|
| 拖拽（`drop`） | ✅ `w=150` | 正常 |
| **双击/点击添加** | ❌ **`ok: false`，什么都没加** | **静默失败** |
| `Registry.build()` | `w=240` | 原始设计尺寸（正确） |

**根因**：

```js
// catalog-panel.js 原实现
if (typeof window.addNode === "function") { window.addNode(node); return true; }
```

而 `model.js` 的签名是：

```js
function addNode(nodes, node, parentId) { ... }   // 3 个参数
```

于是 `nodes` 收到的是**节点对象**、`node` 是 `undefined` → `nodes.push(undefined)` 抛
`nodes.push is not a function` → 被 `catch` 吞掉 → **静默返回 false**。

**为什么长期没被发现**：P2B 的端到端测试只覆盖了**拖拽**（派发 `drop` 事件），
没测双击/点击添加。这是测试盲区，不是新引入的回归。

**修复**（任务要求的"统一插入适配层"）：

新增 `js/ui/insert-control.js`，三个入口共用：

```
Control.byLegacyKey(k).build()   → 原始设计尺寸 240   ← 控件定义语义（契约不变）
              │
              ▼  ICAR.ui.insertControl(k)
prepareBuiltinImages(node,false) → 画布适配尺寸 150   ← 拖进画布语义
              │
              ▼  addNode(design.nodes, node) + commit + selection
```

**修复后实测**：

| 入口 | 宽度 | 高度 | 类型 |
|---|---|---|---|
| 双击/点击添加 | **150** | 16 | image |
| 拖拽 | **150** | 16 | image |
| 统一适配层直接调 | **150** | 16 | — |
| `Registry.build()` | 240 | 16 | 契约保持不变 |

**三者一致，`prepareBuiltinImages` 只执行一次。**

### 1.2 多画布宽高比回归

| 画布 designW×designH | 比例 | 期望宽度 | 实测 | 结果 |
|---|---|---|---|---|
| 2560×1600 | 0.625 | 150.000 | 150.000 | ✅ |
| 1600×2560 | 1.600 | 384.000 | 384.000 | ✅ |
| 1280×720 | 0.5625 | 135.000 | 135.000 | ✅ |
| 800×800 | 1.000 | 240.000 | 240.000 | ✅ |

### 1.3 像素案例统计核对

`p3d-track-pixels.json` 实际 **43 个案例**，与 P3D 报告一致：

| 类别 | 数量 |
|---|---|
| 默认外观 `cd_*` | 28 |
| 自定义参数 `custom_*` | 12 |
| `bar_*` 图片轨道 | 2 |
| `trackStyle=null` 分支 | 1 |
| **合计** | **43** ✅ |

### 1.4 节点识别（禁止依赖 `__controlKey`）

**实测确认**：

| 检查 | 结果 |
|---|---|
| `__controlKey` 在节点对象上 | ✅ 存在 |
| `__controlKey` **进入序列化 JSON** | ❌ **不存在** |
| 保存 → 重载后 `__controlKey` | ❌ **必然丢失** |

**结论：`__controlKey` 不能作为识别条件。**

采用**持久化字段**识别：

```js
type === "image" && trackStyle != null   → 代码轨道
```

实测三种来源都成立：新建 ✅、保存重载 ✅、历史导入 ✅。

**本阶段未修改 `icar.ui/2`** —— 没有新增持久化字段来存控件来源。

---

## 二、Schema 解析与渲染架构

### 2.1 五组件（任务第三部分）

| 组件 | 文件 | 职责 |
|---|---|---|
| `SchemaResolver` | `schema-props.js` | 按**持久化能力**找 schema（`isTrack` / `isPlainImage` / `resolve`）|
| `SchemaRenderer` | 同上 | `mount()` 建一次 DOM；`update()` 只改值 |
| `PropertyAccessor` | 同上 | 点号路径读写（`trackStyle.orient`）|
| `PropertyValidator` | 同上 | 类型/范围/枚举校验 + 归一 |
| `PropertyUpdate` | 同上 | `setOnce`（离散） / `beginLive`+`setLive`+`endLive`（拖动）|

面板接入在 `schema-panel.js`（第六个文件，负责 DOM 挂载与事件委托）。

### 2.2 目录结构

```
js/ui/
  insert-control.js   ← 统一插入适配层（新）
  schema-props.js     ← 五个核心组件（新）
  schema-panel.js     ← 面板接入与事件（新）
  catalog-panel.js    ← 已改：addToCanvas 走统一适配层
```

**`registry/` 零改动** —— Registry 完全不依赖属性面板（任务硬约束）。

### 2.3 数据流

```
选中节点
   │
   ▼
SchemaResolver.resolve(node)   ← 只看 type + trackStyle（持久化字段）
   │  null → 显示"继续用旧面板"
   ▼
SchemaRenderer.mount()  ← 只建一次
   │
   ▼  用户编辑
PropertyValidator.coerce()  ← 非法值不写入模型
   │
   ▼
PropertyUpdate.setOnce/setLive
   │
   ▼
commit() → 撤销栈 → draw()
```

---

## 三、轨道属性清单及字段映射

| # | Schema 路径 | 标签 | 类型 | 范围/枚举 | 可编辑 |
|---|---|---|---|---|---|
| 1 | `trackStyle.orient` | 方向 | enum | `h` / `v` | ✅ **试点开放** |
| 2 | `trackStyle.segments` | 分段数 | number | ≥ 0 | ✅ **试点开放** |
| 3 | `trackStyle.glow` | 发光 | boolean | — | ✅ **试点开放** |
| 4 | `trackStyle.fill` | 填充比例 | number | 0~1，可 null | ✅ **试点开放** |
| 5 | `trackStyle.radius` | 圆角 | number | 可 null | 只读 |
| 6 | `trackStyle.inset` | 内凹 | boolean | — | 只读 |
| 7 | `trackStyle.gradient` | 渐变 | enum | `null` / `gloss` / `fade` | 只读 |
| 8 | `trackStyle.ticks` | 刻度数 | number | ≥ 0 | 只读 |
| 9 | `trackStyle.band` | 三段色带 | boolean | — | 只读 |
| 10 | `w` | 宽度 | number | ≥ 1 | 只读 |
| 11 | `h` | 高度 | number | ≥ 1 | 只读 |

**实测：11 行中恰好 4 个可编辑控件**（与任务要求的 4 个字段一致）。

---

## 四、新旧面板对比

| 维度 | 旧 `#props` | 新 `#schemaProps` |
|---|---|---|
| 覆盖控件 | **全部 215 条** | 仅代码轨道（`image + trackStyle`）|
| 可编辑字段 | 全部 | 仅 4 个（试点）|
| DOM 策略 | `innerHTML` **整面板重建** | **只建一次 + 原位更新** |
| 单次刷新耗时 | **0.310 ms** | **0.0080 ms** |
| 刷新后同一 DOM 元素 | ❌ **false** | ✅ **true** |
| 光标/焦点 | 会丢失 | **保留** |
| 拖动撤销 | 每步一条 | **一次拖动一条** |
| 位置 | 下方 | 上方 |

**两个面板并行存在，都能编辑轨道** —— 旧面板能力一项未删。

---

## 五、属性编辑及撤销测试

| 测试 | 结果 |
|---|---|
| Accessor 读嵌套路径 | ✅ `trackStyle.orient` → `"h"` |
| Accessor 读 `null` | ✅ 返回**真 null**（不是 undefined）|
| Accessor 写变化值 | ✅ 返回 true |
| Accessor 写相同值 | ✅ 返回 **false**（不 commit）|
| Accessor 拒绝创建缺失中间层 | ✅ 返回 false（防止普通图片被变成半残轨道）|
| Validator：真 null | ✅ `{ok:true, value:null}` —— **保持 null** |
| Validator：UI 占位 `"__null__"` | ✅ **拒绝**（不会被当成值写入）|
| Validator：合法 enum | ✅ 通过 |
| Validator：非法 enum | ✅ 拒绝 |
| Validator：boolean + 字符串 | ✅ `"true"` → `true` |
| Validator：空字符串 → null | ✅（nullable 字段）|
| Validator：非数字 | ✅ 拒绝 |
| Validator：超范围 | ✅ 拒绝 |
| **两次编辑后 undo** | ✅ 20 → **5**（退一步）|
| **redo** | ✅ 恢复 20 |
| **连续拖动 10 步** | ✅ **一次 undo 回到拖动前值** |
| 无变化写入 | ✅ **不产生 commit** |

> ⚠️ 关于"两次编辑才看得出 undo"：这是既有 `UndoStack` 语义（D-09，P3D 已登记）——
> 首次 `commit()` 建立基准。**不是本阶段的缺陷。**

---

## 六、增量刷新验证

| 要求（任务第六部分） | 实测 |
|---|---|
| 不销毁整个面板 DOM | ✅ **同一 DOM 元素**（`before === after`）|
| 输入时不丢光标/焦点/选择范围 | ✅ 焦点保留、输入值 `'7'` 未被覆盖 |
| Slider 拖动画布实时响应 | ✅ `setLive` 内调 `requestDraw`/`draw` |
| 一次连续滑动不产生大量撤销 | ✅ 10 步 → **1 条** |
| 无变化不重复 commit | ✅ |
| 只更新受影响字段 | ✅ `update(view, node, skipPath)` 跳过正在编辑的字段 |
| 切换节点正确刷新 | ✅ 只更新值，不重建 DOM |
| 不破坏其它控件旧面板 | ✅ **`panels.js` 零改动**；旧面板对全部 215 条仍有效 |

### 关于 `suppressPanelRender` 等旧补丁

**一个都没动。** 任务明确要求"不得直接移除，除非已证明所有相关交互不再依赖它"——
本阶段没有做这种证明，所以一律保留。

---

## 七、保存重新载入测试

| 场景 | 结果 |
|---|---|
| 新建轨道 → Schema 面板识别 | ✅ `family: "track"` |
| 保存 → `parseDesign` 重载 → 仍识别 | ✅ `family: "track"`，值正确（`orient=v`）|
| 历史导入（无 `__controlKey`）→ 识别 | ✅ 靠 `type + trackStyle` |
| 普通图片（`trackStyle=null`）| ✅ **不误判**为轨道 |
| 仪表（`type=gauge`）| ✅ 不误判 |

---

## 八、性能基线与优化结果

### 8.1 真实测量（60 控件场景）

任务要求"先建立改造前真实性能基线，不得沿用历史注释中的 8.8ms"。

| 指标 | 旧面板（实测基线） | Schema 面板（实测） | 提升 |
|---|---|---|---|
| 单次刷新耗时 | **0.310 ms** | **0.0080 ms** | **38.8×** |
| 刷新后同一 DOM 元素 | ❌ false（重建）| ✅ true（原位）| — |
| 60 控件场景交互 | 同上 | 同上 | — |

> **旧面板本身就很快**（0.31ms / 60 控件），所以"性能"不是主要收益。
> **主要收益是"不重建 DOM"** —— 这才是焦点丢失、光标跳位、拖动被截断的根因。

### 8.2 测量方法说明

- 场景：60 个混合控件（轨道/仪表/灯/文字）
- 测量：`performance.now()` 前后差，取 20 次平均
- 旧面板基线测的是 `window.renderProps()`
- Schema 测的是 `SchemaRenderer.update(view, node, null)`

---

## 九、完整回归测试结果

| 层 | P3D | **P4A** |
|---|---|---|
| 套件 | 45 | **46** |
| 断言 | 5369 | **5441** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：
```
+ verify-p4a-schema-props   新增 72
合计 46 个套件 / 下限之和 5441
```

---

## 十、修改文件清单

### 新增（4）

| 文件 | 行数 | 说明 |
|---|---|---|
| `tools/icarui/js/ui/insert-control.js` | ~120 | 统一插入适配层 |
| `tools/icarui/js/ui/schema-props.js` | ~430 | Schema 五组件 |
| `tools/icarui/js/ui/schema-panel.js` | ~250 | 面板接入与事件 |
| `tools/icarui/tests/verify-p4a-schema-props.js` | ~280 | **72 条断言** |

### 修改（4）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/catalog-panel.js` | `addToCanvas` 改走统一适配层（**修真 Bug**）|
| `tools/icarui/js/app.js` | `onSelectionChanged` 末尾追加 Schema 面板刷新（+8 行）|
| `tools/icarui/index.html` | 加载 3 个新脚本；新增 `#schemaProps` 容器；初始化块 |
| `tools/icarui/css/studio.css` | Schema 面板样式（`sp-` 前缀）|

### 未改动（关键）

- **`app/`**、**`icar.ui/2`**
- **`panels.js`**（零改动 —— 旧面板能力一项未删）
- **`presets.js`**、`model.js`、`schema.js`、`canvas.js`
- **`registry/`**（零改动 —— Registry 不依赖面板）
- `cd_*` 默认创建值、`bar_*`、其它控件族

---

## 十一、剩余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | **Schema 面板只覆盖轨道** | 中 | 其它 187 条仍只能走旧面板（这是刻意，任务要求不批量迁移）|
| R2 | 焦点保留验证是**模拟**的 | 中 | 用 `__setEditing` 模拟"正在编辑"，未用真实键盘输入序列 |
| R3 | 未做**真实鼠标拖动滑块** | 中 | `beginLive/setLive/endLive` 是直接调用，未模拟 pointer 事件序列 |
| R4 | **D-09 影响用户体验** | 中 | 首次编辑后 undo 看起来"没生效"（既有语义，非本阶段缺陷）|
| R5 | `addToCanvas` 修复只覆盖 Catalog 面板 | 低 | 旧面板的添加按钮走各自路径，未纳入统一适配层 |
| R6 | 未人工判读 UI | 中 | 模型无图像输入能力 |
| R7 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |

---

## 十二、向文字、仪表、状态灯推广的建议

### 12.1 推广顺序（按风险递增）

| 阶段 | 目标 | 字段数 | 可编辑试点建议 | 风险点 |
|---|---|---|---|---|
| **P4B** | 文字族（12 条） | 12 | `text` / `font.size` / `font.weight` / `font.color` / `font.align` | `font` 是嵌套对象，**已经验证过点号路径可用** |
| **P4C** | 容器族（4 条） | 7 | `w` / `h` / `rotation` / `alpha` / `locked` / `visible` | 全是一层字段，最简单 |
| **P4D** | 仪表族（6 条） | 12 | `pid` / `style` / `min` / `max` / `warnLow` / `warnHigh` | **`pid` 需要 PID 选择器**（最复杂，放最后）|
| P4E | 状态灯（19 条） | 11 | `statePid` / `warnLow` / `warnHigh` | 需要三态素材选择器 |

### 12.2 建议先做文字族（P4B）的理由

1. **`font` 是嵌套对象** —— 可以验证 Accessor 的多层路径（本轮已验证一层嵌套 `trackStyle.x`）
2. **12 条共享同一 schema** —— 投入产出比高
3. **有像素基准可扩展** —— P3B 的 12 个文字像素哈希可直接复用
4. **不涉及数据绑定** —— 避开 PID 选择器

### 12.3 推广时必须注意

| 坑 | 说明 |
|---|---|
| **`pid` 归一化（D-06）** | 仪表 `node.pid` 是解析后 id，别名在 `rawPid`。schema 里写 `pid` 会让面板显示 `std_0D` 而非 `obd.speed` |
| **`assetId` 运行期生成（D-08）** | 三态素材编辑不能用 `assetId` 做 schema 路径 |
| **`normalizeFont` 归一化** | 文字 `font.size` 非法值会被静默重置 —— 面板校验要先于模型 |
| **不要一次开放太多字段** | 本轮只开放 4 个，验证稳定后再扩 |

### 12.4 推广前必须补的两件事

1. **真实 pointer 事件测试**：用 `dispatchEvent(new PointerEvent(...))` 模拟真实滑块拖动
2. **真实键盘输入测试**：用 `Input.insertText` 或 `Input.dispatchKeyEvent` 验证光标不跳

---

## 十三、未验证边界

1. **未人工判读 UI**（模型无图像输入能力）——
   截图：`stage/p4a-track-selected.png`（选中轨道）、`stage/p4a-gauge-fallback.png`（选中仪表回退提示）
2. **焦点保留是模拟验证**（`__setEditing` 注入），未走真实键盘输入序列
3. **滑块拖动是直接调用 API**，未模拟 pointerdown/move/up 序列
4. 未在真机上验证；无真车证据
5. 旧面板的添加按钮未纳入统一适配层
6. `ext` 透传未实施
