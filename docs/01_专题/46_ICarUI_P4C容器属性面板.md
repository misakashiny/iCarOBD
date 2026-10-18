# ICarUI P4C：容器属性面板 Schema 迁移

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4C` |
| 基线 | P4B.1 `294df61` |
| 结论 | 容器族接入 Schema 面板；6 字段可编辑；**5783 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`panels.js`/`canvas.js`/`model.js`/`schema.js`/`registry/` 零改动 |

---

## 一、P4C 容器 Schema 审计结果

### 1.1 四个容器定义

| key | 默认尺寸 | z | `render.mode` |
|---|---|---|---|
| `group` | 160×160 | 99 | `container` |
| `box_card` | 320×200 | 99 | `container` |
| `box_row` | 340×100 | 99 | `container` |
| `box_col` | 140×320 | 99 | `container` |

### 1.2 签名审计

```json
{"distinctSignatures": 1, "counts": [4]}
```

**四个容器的 schema 完全一致**（与文字族 P4B 时发现的 2 种签名不同）。

### 1.3 Schema 字段清单（7 个）

| # | 路径 | 类型 | 范围 | 本阶段开放 |
|---|---|---|---|---|
| 1 | `w` | number | min 1 | ✅ |
| 2 | `h` | number | min 1 | ✅ |
| 3 | `rotation` | number | **无限制** | ✅ |
| 4 | `scale` | number | min 0.01 | ❌ **不开放**（任务只要求 6 个）|
| 5 | `alpha` | number | 0~255 | ✅ |
| 6 | `locked` | boolean | — | ✅ |
| 7 | `visible` | boolean | — | ✅ |

**Schema 里共有 7 个字段，本阶段只开放 6 个** —— `scale` 保持只读。

### 1.4 UI 层未复制 Schema

`SchemaResolver` 新增 `containerSchemaFor(node)`，**完全从 Registry 取**：

```
① 节点带 __controlKey 且该 key 是 container 定义 → 用该 key 自己的 schema
② 否则 → Registry 里任一 render.mode === "container" 的定义
```

**没有在 UI 模块写 `CONTAINER_SCHEMA`**（P4A.1 消除 Schema 双源的教训）。
`registry/` **零改动**，保持 Registry 对 UI 的单向依赖。

---

## 二、group 节点识别范围与冲突分析

### 2.1 全库实测（215 条）

| 来源 | 条数 | 子节点 | 说明 |
|---|---|---|---|
| `derived`（Registry 接管）| **4** | 0 | `group` / `box_card` / `box_row` / `box_col` |
| `probe`（旧工厂）| **15** | **2** | 全部 `next_*` 组合预设 |

### 2.2 运行时产生的 group

| 来源 | 位置 |
|---|---|
| 用户手动「组合」 | `model.js:489` 的 `groupNodes()` |
| 历史设计文件 | `parseDesign` / `parseNode` |
| **嵌套 group** | 以上任意来源的子节点 |

### 2.3 冲突分析：六个属性对**所有** group 都安全

**关键依据**：`w` / `h` / `rotation` / `alpha` / `locked` / `visible`
**全都是 `createNode()` 的通用基础字段**（`model.js` 的 `base` 对象）：

```js
const base = {
  w: num(o.w, 120), h: num(o.h, 120),
  rotation: num(o.rotation, 0),
  alpha: clampInt(o.alpha ?? 255, 0, 255),
  z: num(o.z, 0),
  locked: !!o.locked,
  visible: o.visible === undefined ? true : !!o.visible,
  ...
};
```

**任何节点类型都有这些字段，不是容器专有。**

所以「某类 group 不能改 alpha」这种情况**不存在**。

### 2.4 结论：不需要按 key 分派

- ✅ `node.type === "group"` **一个判据就够**
- ✅ **不需要**持久化控件来源字段（任务明确禁止新增）
- ✅ **不需要**按 `__controlKey` 限制适用范围

实测验证：

| 节点 | 识别 | 可编辑字段 |
|---|---|---|
| 4 个容器 key | ✅ `container` | 6 |
| **15 个 `next_*`** | ✅ `container` | 6 |
| **嵌套 group** | ✅ `container` | 6 |
| **手动组合的 group** | ✅ `container` | 6 |
| text 节点 | ❌ 不识别为容器 | — |
| gauge 节点 | ❌ 不识别为容器 | — |

**本阶段未改变 `next_*` 的创建逻辑或默认值。**

---

## 三、六字段编辑和校验结果

### 3.1 `w` / `h`

| 输入 | 结果 |
|---|---|
| `200` | ✅ 通过（number）|
| `NaN` | ❌ 拒绝 |
| `Infinity` | ❌ 拒绝 |
| `-5` | ❌ 拒绝（min=1）|
| `0` | ❌ 拒绝 |
| `abc` | ❌ 拒绝 |

**校验先于模型写入**（`PropertyValidator.coerce` 在 `setLive` 之前）。

### 3.2 `rotation`：**无范围限制，各值原样保留**

实测经 `build` → 序列化 → 重载：

| 输入 | set | reloaded |
|---|---|---|
| `-45` | **-45** | **-45** |
| `0` | 0 | 0 |
| `45` | 45 | 45 |
| `360` | **360** | **360** |
| `450` | **450** | **450** |

**未新增任何角度限制**（渲染侧是 `ang × π/180`，不做归一化 —— 这是既有行为）。

### 3.3 `alpha`：0~255，**255 不被换算成 1**

| 输入 | set | reloaded |
|---|---|---|
| `0` | 0 | **0** |
| `128` | 128 | **128** |
| `255` | 255 | **255** ✅ |
| `256` | — | ❌ 拒绝（max=255）|
| `-1` | — | ❌ 拒绝 |

**未改变 Canvas 渲染算法**（`canvas.js` 零改动）。

### 3.4 `locked` / `visible`

| 检查 | 结果 |
|---|---|
| boolean 类型 | ✅ |
| `locked=true` / `visible=false` 经保存重载保留 | ✅ |
| **隐藏后节点仍在设计里**（不是删除）| ✅ `nodes.length === 1` |
| **可通过 schema 字段解回** | ✅ `locked → false`、`visible → true` |

**未修改历史锁定语义**；用户在 Schema 面板或旧面板都能解除。

---

## 四、父子节点及 next_* 回归测试

### 4.1 七个场景

| # | 场景 | 验证结果 |
|---|---|---|
| 1 | **空容器** | ✅ `children: 0` |
| 2 | **容器含文字** | ✅ 父容器改 `w/h/rotation/alpha` 后，**子节点局部坐标不变**（20,30 → 20,30）|
| 3 | **容器含图片** | ✅ `childType: "image"` |
| 4 | **容器含仪表** | ✅ `childType: "gauge"` |
| 5 | **嵌套 group** | ✅ 外层改 `w=500/alpha=64` 后，内层 `w=80/rotation=10` **不受影响** |
| 6 | **`next_*` 组合预设** | ✅ 2 个子节点保留；父改 `w/h/rotation/alpha` 后子节点局部坐标不变 |
| 7 | **历史导入嵌套** | ✅ 3 层嵌套（`box_card` → `box_row` → `t_label`）；`w=333`/`rot=-45`/`alpha=77`/`locked=true`/`visible=false` 全部保留 |

### 4.2 关于子节点「最终显示位置」

**局部坐标不变**是正确语义（`x/y` 相对父节点）。
最终屏幕位置由父容器变换矩阵决定 —— 这由 `withDeviceRotation` 等既有渲染路径处理，**本阶段未改**。

### 4.3 P3B 约束保持不变

实测断言：

```
autoLayout === undefined   ✅ 未引入自动布局
clipChildren === undefined ✅ 未引入容器裁剪
```

**没有为了测试通过而新增自动排列或裁剪。**

---

## 五、新旧面板同步测试

| # | 场景 | 结果 |
|---|---|---|
| 1 | 旧面板改 `w=555` → 新面板同步 | ✅ `panel: "555"` |
| 2 | 新面板改 `w=222` → 模型同步 | ✅ |
| 3 | 撤销后两面板一致 | ✅ |
| 4 | 切换选中节点 | ✅（P4A.1 机制）|
| 5 | 删除节点 → 面板清空 | ✅ `family:null`、**0 个输入框** |
| 6 | 无选择 / 多选 | ✅ 均为 `family:null` |
| 7 | 保存重新载入 | ✅ 仍可编辑 |
| 8 | 历史文件导入 | ✅ 靠 `type === "group"` 识别 |
| 9 | 编辑中途切换容器 | ✅ 不串值（`liveEdit` 带 `nodeId`）|

**没有出现失效节点引用**（删除后输入框数为 0）。

---

## 六、输入与撤销事务测试

### 6.1 真实 CDP 键盘

| # | 测试 | 结果 |
|---|---|---|
| 1 | **Enter 提交**：输入 `250` + Enter | ✅ 模型 = 250 |
| 2 | **Tab 焦点切换**：`w` → `h` | ✅ |
| 3 | **Escape 取消**：alpha 输入 `99` 后 Escape | ✅ 还原到原值 |
| 4 | **非法数值失焦不污染**：`h` 输入 `abc` 后失焦 | ✅ `h` 未变 |

### 6.2 Checkbox 与事务

| 检查 | 结果 |
|---|---|
| **Checkbox 修改只提交一次** | ✅ `firstToggle: 1` |
| **重复设同值不产生 commit** | ✅ `secondNoop: 0` |
| **连续修改 + 单次撤销** | ✅ 10 步 live 到 `w=260`，一次 undo 回到 160 |
| **无变化不产生撤销记录** | ✅ |
| **锁定+隐藏后仍能恢复** | ✅ 节点仍在、可解回 |

---

## 七、异常诊断检查（第八部分第 1 项）

### 7.1 发现的问题

P4B.1 里两处都计数：

- `SchemaPanel.refresh` 内部 `catch` → `+1` 并写 `__ICAR_SCHEMA_ERROR`
- `refreshAll` 外层 `catch` → **再 +1**

→ **同一次逻辑故障被算成 2 次**，排查时会误以为发生了两次独立故障。

### 7.2 修复

`SchemaPanel.refresh` 的 catch **不再计数**，只打标记后继续抛出：

```js
if (e && typeof e === "object") {
  try { e.__icarSchemaOrigin = "SchemaPanel.refresh"; } catch (err) {}
}
throw e;
```

计数与记录**统一在外层 `recordSchemaError()`**。

### 7.3 实测

| 检查 | 结果 |
|---|---|
| **一次故障计数** | ✅ **1**（修复前会是 2）|
| 原始错误消息保留 | ✅ `DUP_COUNT_TEST` |
| **原始堆栈保留** | ✅ |
| 旧面板可用 | ✅（P4B.1 已验证，本轮未破坏）|

---

## 八、性能测量

### 8.1 容器属性

| 指标 | 结果 |
|---|---|
| 修改容器属性是否重建 Schema DOM | ✅ **否**（`before === after`）|
| Checkbox 是否触发无关全量刷新 | ✅ 只在 `setOnce` 内走一次 `refreshAll` |
| 编辑中焦点稳定性 | ✅（Tab 测试间接验证）|
| commit 只发生必要次数 | ✅ 重复赋同值 **0 次 commit** |
| 对同一属性重复赋值 | ✅ **跳过事务** |

### 8.2 子节点较多时 `refreshAll` 耗时

**20 个子节点的容器**：

| 指标 | 值 |
|---|---|
| 中位数 | **25.8 ms** |
| 最大 | **32.7 ms** |

**对照 P4A.1 基线**（60 控件、无深层嵌套）：`refreshAll` 中位数 **33.7 ms**。

→ **容器 + 20 子节点并未让 `refreshAll` 变慢**（25.8 < 33.7）。
`refreshAll` 的主要成本仍来自控件数量而非嵌套深度。

### 8.3 本阶段未做全局性能优化

按要求只做测量，未改动 `panels.js` / `refreshAll` 结构。

---

## 九、全量回归结果

| 层 | P4B.1 | **P4C** |
|---|---|---|
| 套件 | 49 | **50** |
| 断言 | 5695 | **5783** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：`+ verify-p4c-container-props 新增 88`。

**本阶段未调整任何既有断言**（`distinctSignatures === 1` 本来就成立，无冲突）。

---

## 十、修改文件清单

### 修改（2）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | `isContainerNode()`；`containerSchemaFor()`（从 Registry 取）；`resolve` 加容器分支；`EDITABLE.container` 加 6 字段；导出 `isContainer` |
| `tools/icarui/js/ui/schema-panel.js` | `refresh` catch **不再重复计数**（第八部分第 1 项）|

### 新增（1）

| 文件 | 说明 |
| --- | --- |
| `tools/icarui/tests/verify-p4c-container-props.js` | **88 条断言** |

### 未改动（关键）

- **`app/`（Android）**、**`icar.ui/2`**
- **`panels.js`**、**`canvas.js`**、**`model.js`**、**`schema.js`**
- **`registry/`**（零改动 —— Schema 全部从 Registry 读）
- `presets.js`、`next-controls.js`（`next_*` 创建逻辑未改）
- 容器默认值、`UndoStack`

---

## 十一、剩余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | **文字字号上限 400 ≠ 旧面板无上限** | 中 | P4B.1 已确认；本阶段**继续保留在兼容风险中**，不得认为与旧版完全等价 |
| R2 | `scale` 字段声明但**不可编辑** | 低 | 任务只要求 6 个字段；`scale` 仍走旧面板 |
| R3 | **容器不裁剪子节点 / 无自动布局** | 中 | P3B 已明确记录，本阶段未新增（有意）|
| R4 | 子节点**最终屏幕位置**未逐像素验证 | 中 | 只验了局部坐标不变；变换矩阵由既有渲染处理 |
| R5 | `refreshAll` 仍是落定瓶颈（25.8~33.7ms）| 中 | 需独立性能优化阶段 |
| R6 | Schema 面板覆盖 轨道+文字+容器（**35 条**）| 中 | 其余 180 条仍走旧面板 |
| R7 | 未人工判读 UI | 中 | 模型无图像输入 |
| R8 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |

---

## 十二、后续建议

### 12.1 性能优化建议（独立阶段）

现状测量：

| 场景 | `refreshAll` 中位数 |
|---|---|
| 60 控件（P4A.1）| 33.7 ms |
| 容器 + 20 子节点（P4C）| 25.8 ms |

**瓶颈明确是 `refreshAll`**（占完整交互约 80%）。建议独立阶段分析：

1. `renderPanels()` 里的 `renderAssets`（104 个素材 + 分类）是否必要每次全量
2. `syncJson()` 的序列化成本
3. `saveUndoStack()` 的 localStorage 写入（P4A.1 注释提到 13.2 ms/次）

**不建议在属性面板迁移阶段做**。

### 12.2 数据绑定属性面板建议（P4D/P4E）

| 族 | 关键难点 | 建议 |
|---|---|---|
| **状态灯（19 条）** | `statePid` 需要 **PID 选择器**；三态素材需要 **assetId 选择器** | 先做 `statePid`（普通 enum/自定义控件），素材选择器单独评估 |
| **仪表（6 条）** | `pid` **受 D-06 影响**（`node.pid` 是解析后 id，别名在 `rawPid`）| 必须**先解决 D-06**：面板显示 `rawPid`、写入走 `rawPid` |

#### ⚠️ P4D/P4E 的前置条件

**D-06 必须先解决**：

```
node.pid    = std_0D   （解析后 id，内部查表）
node.rawPid = obd.speed（用户别名，回显/序列化）
```

面板若绑 `pid`，用户会看到 `std_0D` 而不是 `obd.speed`；若写 `pid`，会绕过 `resolvePid` 归一化。

**建议方案**：给 Schema 增加一个 `readPath` / `writePath` 概念（读取 `rawPid`、写入后由 `createNode` 归一化），
或让 `PropertyAccessor` 支持"读 A 写 B"。**这需要单独设计，本阶段不实施。**

### 12.3 覆盖进度

| 族 | 条数 | 状态 |
|---|---|---|
| 代码轨道 `cd_*` | 28 | ✅ P4A |
| 文字 | 12 | ✅ P4B/P4B.1 |
| 容器 | 4 + 15 `next_*` + 手动/历史 | ✅ P4C |
| 状态灯 | 19 | ⬜ P4D |
| 仪表 | 6 | ⬜ P4E |
| 素材/其它 | ~180 | 仍走旧面板 |

---

## 十三、未验证边界

1. **未人工判读 UI**（模型无图像输入）
2. **子节点最终屏幕位置未逐像素验证**（只验局部坐标不变）
3. **文字字号上限 400 ≠ 旧面板无上限** —— 继续列为兼容风险 R1
4. 未在真机上验证；无真车证据
5. `refreshAll` 仍是性能瓶颈
6. `ext` 透传未实施
7. 真实系统中文 IME 仍未验证（P4B.1 遗留的人工验收待办）
