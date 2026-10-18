# ICarUI P3D：28 个代码轨道控件正式迁移

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P3D` |
| 基线 | P3C-2 `3fcd4c8` |
| 结论 | 28 条 `cd_*` 全部接管；Golden 28/28；**像素回归 43/43**；**5369 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`presets.js`/`panels.js`/`catalog.js` 零改动 |

---

## 一、28 条轨道迁移清单

全部 `cd_*`，按参数分组：

| 组 | 数量 | key | 关键参数 |
|---|---|---|---|
| 基础 | 2 | `cd_trackh` / `cd_trackv` | `orient` h/v |
| 渐变 | 4 | `cd_trackgradh/v`（gloss）、`cd_trackfadeh/v`（fade） | `gradient` |
| 内凹 | 2 | `cd_trackinseth/v` | `inset: true` |
| 发光 | 2 | `cd_trackglowh/v` | `glow: true` |
| 带刻度 | 2 | `cd_trackticksh/v` | `ticks: 10` |
| 分段 | 6 | `cd_seg5h/v`、`cd_seg10h/v`、`cd_seg20h/v` | `segments: 5/10/20` |
| 三段色带 | 2 | `cd_band3h/v` | `band: true` |
| 填充 | 4 | `cd_fillh/v`、`cd_fillglowh/v` | `fill: 0.62`（+glow） |
| 标记/游标 | 4 | `cd_markerh/v`、`cd_cursorh/v` | `fill: 1`、`radius: 2`（+glow） |

**`trackFamily = { total: 28, registered: 28, skipped: 0 }`**

> ⚠️ **`bar_*` 完全未迁移**（任务明令禁止）。实测验证：`index.html` 中 `bar_` 出现 **0 次**，
> `bar_trackh/v` 仍 `type=image`、仍有 `assetId`、仍 `trackStyle=null`、未被 bridged。

---

## 二、独立 Golden 28/28 对比

### 2.1 做法

在**替换任何 `make()` 之前**抓取 28 条完整节点至 `fixtures/p3d-track-golden.json`：

- 确定性：连调两次比对，**28/28 stable=true**
- 排除 `id`
- `assetId` 为空串（无需归一化，但结论与 D-08 一致：若将来填了必须按路径归一化）
- **完整保留 `trackStyle` 全部 10 个字段**：`orient`/`radius`/`inset`/`gradient`/`glow`/`segments`/`ticks`/`band`/`fill`/`color`/`accent`
- 保留 `x/y/w/h/z`/`rotation`/`scale`/`alpha`

### 2.2 结果

```
Golden match: 28/28
```

---

## 三、Registry / Bridge / Catalog 统计

| 指标 | 实测 | 预估 | 一致 |
|---|---|---|---|
| Registry bridged | **69** | 69 | ✅ |
| Catalog `declared` | **8** | 8 | ✅ |
| Catalog `derived` | **69** | 69 | ✅ |
| Catalog `probe` | **138** | 138 | ✅ |
| Catalog `total` | **215** | 215 | ✅ |

`fallback = 0`、`missing = 0`。

**28 条全部 `source=derived`** —— Catalog 不再调 `make()` 探测这 28 条。

---

## 四、`trackStyle` 数据语义与参数化设计

### 4.1 参数化架构（第三部分要求）

28 条**不是** 28 份实现，而是 **9 个参数的组合**，由**共享工厂** `buildTrack(d, props)` 一处实现：

```js
function buildTrack(d, props) {
  const ts = {
    orient,   // "h" | "v"
    radius,   // null | number（null = 短边一半，胶囊）
    inset,    // boolean
    gradient, // null | "gloss" | "fade"
    glow,     // boolean
    segments, // 0 | 5 | 10 | 20
    ticks,    // 0 | 10
    band,     // boolean
    fill,     // null | 0.62 | 1
  };
  return createNode(NODE_IMAGE, { assetId: "", ..., trackStyle: ts });
}
```

每条 key 只在 `DEFS` 里写**参数差异**，但**默认行为逐字段照抄旧实现**：
- `radius: d.radius === undefined ? null : d.radius`
- `segments: d.segments || 0`
- `fill: d.fill === undefined ? null : d.fill`
- `z: 97`（不是 99 —— 旧实现如此）

### 4.2 实测参数分布（验证参数化无遗漏）

| 参数 | 分布 |
|---|---|
| `orient` | h **14** / v **14** |
| `gradient` | gloss **2** / fade **2** / null 24 |
| `segments` | 5→**2** / 10→**2** / 20→**2** / 0→22 |
| `ticks` | 10→**2** / 0→26 |
| `band` | true **2** |
| `inset` | true **2** |

### 4.3 `assetId` 必须留空

旧实现注释：

> `drawTrackNode` 不会去读它（`trackStyle` 非空就整个走代码画）

测试断言：**28/28 `assetId === ""`**。若填了就会走图片分支，不再是代码轨道。

### 4.4 `trackStyle = null` 的旧行为

```js
createNode(NODE_IMAGE, {...})  // trackStyle 缺省
→ n.trackStyle === null  → trackUsable(null) === false → 画 assetId 那张 PNG
```

测试断言：`trackStyle defaults to null` + `trackUsable(null) === false`。
**通过设计**（`null` 表示老行为）未改。

---

## 五、图片包装链检查（第五部分）

### 5.1 28 条全部是 `NODE_IMAGE`

实测：**28/28 都是 `NODE_IMAGE`** —— 所以**全部**受 `panels.js` 的 `prepareBuiltinImages` 影响。

### 5.2 Bridge 执行顺序

P3C-2 已将 bridge 调用移到 `panels.js` **之后**，本族自动受益。
本轮再次实测确认：`Golden 28/28`，无尺寸偏差。

### 5.3 图片尺寸适配**只执行应有的次数**

实测对照：

| 入口 | 宽度 | 说明 |
|---|---|---|
| `BUILTIN_CONTROLS['cd_trackh'].make()` | **150** | 240 × 1600/2560，包装**一次** |
| `Control.byLegacyKey('cd_trackh').build()` | **240** | 原始设计尺寸，**未包装** |

测试断言 `prepareBuiltinImages applied exactly once (not squared)` ——
若被包两次会是 `240 × 0.625² = 93.75`。

### 5.4 Registry 直接创建 vs 旧兼容入口的尺寸语义

**两者语义不同，且都正确**：

| 入口 | 语义 | 宽度 |
|---|---|---|
| `BUILTIN_CONTROLS[key].make()` | "**拖进画布**" —— 需适配画布比例 | 150 |
| `Control.byLegacyKey(key).build()` | "**控件定义**" —— 给出原始设计尺寸 | 240 |

> 用户真正拖到画布上时走 `dropControlAt` → `c.make()` → 旧入口 → **已缩放**。
> 所以画布显示尺寸与原版一致（像素回归 43/43 已证）。

### 5.5 启动顺序守卫（新增）

在 `index.html` 的 bridge 脚本块末尾新增 `orderGuard()`：

```js
// 1) bridge 是否真的接管了
// 2) 抽查图片控件 w 是否 = 原始 w × 画布宽高比
// 失败 → window.__ICAR_ORDER_GUARD_FAILED = [...] + console.error 红字
```

**把"静默失效"变成"启动时立刻可见的错误"** —— P3C-2 就是静默丢了一轮。

守卫自身有 null 保护（初始化早期 `CanvasState.design` 可能为 null，守卫不能成为故障源）。

实测：`__ICAR_ORDER_GUARD_FAILED === null`（通过）。

---

## 六、代码轨道与图片轨道的兼容性

| 维度 | 代码轨道 `cd_*` | 图片轨道 `bar_*` |
|---|---|---|
| 迁移状态 | ✅ **已接管 28 条** | ❌ **未迁移**（任务禁止） |
| 节点类型 | `NODE_IMAGE` | `NODE_IMAGE` |
| `assetId` | `""`（空） | 有值 |
| `trackStyle` | 非 null | `null` |
| 绘制 | `drawTrackNode` | PNG |
| Catalog 来源 | `derived` | `probe`（仍在探测） |

**双实现刻意保留，未合并**（P0 审计确认过：24 组重复概念是有意设计）。

---

## 七、实际浏览器交互与像素回归

### 7.1 像素回归：43/43 完全一致

用 `git worktree` 检出 **P3C-2 基线 `3fcd4c8`**，与当前版本分别渲染取像素哈希（320×320）。

覆盖 7 类（任务第七部分要求）：

| 类别 | 案例数 | 结果 |
|---|---|---|
| 1. 28 个默认外观 | 28 | ✅ 全一致 |
| 2. 水平与垂直方向 | （含在默认里，14 h + 14 v） | ✅ |
| 3. 分段轨道不同分段数 | 2（seg3 / seg16） | ✅ 全一致 |
| 4. 渐变、发光、刻度配置 | 4（gloss / fade / glow / ticks4 / ticks20） | ✅ 全一致 |
| 5. 自定义 trackStyle 参数 | 3（fill 0.3 / fill 0.85 / radius 0 / band off / inset off） | ✅ 全一致 |
| 6. 有/无 assetId 典型分支 | 1（`trackStyle=null` → 图片分支） | ✅ 一致 |
| 7. 旧 `bar_*` 图片轨道 | 2（`bar_trackh` / `bar_trackv`） | ✅ 一致 |

**总计 43/43，零差异。**

### 7.2 ⚠️ 一个必须说明的测试方法修正

第一轮像素对比时 **12 个自定义案例全部不一致**。排查后确认：

- 基线路径：`make()` 后 `Object.assign(n.trackStyle, patch)` → `w=150`（已包装）
- 当前路径：`Registry.build({...})` → `w=240`（未包装）

**差异来自尺寸，不是渲染。** 修正为让两条路径都走 `make()`（统一路径），
第二轮 **43/43 一致**。

> 这不是"调断言掩盖差异"，而是修正了对照方法本身 ——
> 尺寸语义已在 §5.4 单独断言。

### 7.3 浏览器交互验证

| # | 项 | 结果 |
|---|---|---|
| 1 | 新控件库添加轨道 | ✅ `Control.byLegacyKey(k).build()` |
| 2 | 旧资源入口添加轨道 | ✅ **新旧入口 28/28 一致** |
| 3 | **真实拖拽 `dragstart`→`dragover`→`drop`** | ✅ 创建 `image` 节点、保留 `segments=5`、`assetId=""` |
| 4 | 位置及尺寸修改 | ✅ `x/y/w/h` 持久化 |
| 5 | 样式参数修改 | ✅ `orient`/`segments`/`gradient` 等持久化 |
| 6 | 层级、透明度、旋转 | ✅ `z/alpha/rotation/scale` 持久化 |
| 7 | 撤销 / 重做 | ✅ 两步 commit 后 undo 退一步、redo 恢复 |
| 8 | 保存、导出、重新载入 | ✅ 0 错误、3 轨道、orient/segments/type 保持 |
| 9 | 切换资源分类不改变设计 | ✅ 设计 JSON 前后完全相同 |
| 10 | 设计文件资源引用不丢失 | ✅ `assetId` 空串保持（代码轨道本就不引用图片） |

### 7.4 仍未实现的轨道编辑功能（明确标记未支持）

| 未支持项 | 说明 |
|---|---|
| 渐变**自定义颜色** | `trackStyle.color` / `accent` 字段存在（序列化为 `null`），但**没有 UI 编辑入口** |
| 分段**自定义段色** | 同上 |
| 刻度**自定义密度/标签** | `ticks` 只能设数量，无标签编辑 |
| 填充**动态绑定** | `fill` 是用户设的静态比例，**不做数据绑定**（旧行为如此） |

本阶段**未新增这些功能**（任务禁止）。

---

## 八、完整测试结果

| 层 | P3C-2 | **P3D** |
|---|---|---|
| 套件 | 44 | **45** |
| 断言 | 5305 | **5369** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：
```
+ verify-p3d-track-family   新增 64
合计 45 个套件 / 下限之和 5369
```

### 8.1 本轮调整的既有断言

| 套件 | 断言 | 变化 | 理由 |
|---|---|---|---|
| `verify-p3c2-lamp-family` | bridged / derived / probe | 硬编码 `41/41/166` → **"至少 41"** | P3D 推进了阶段数字；精确数字由 `verify-p3d` 守 |

### 8.2 P3D 开发中修正的 3 条测试写法（均为测试方法问题，非产品缺陷）

| 断言 | 现象 | 根因 | 修法 |
|---|---|---|---|
| `validate catches bad orient` | 收不到坏值 | `createNode` 里 `normalizeTrackStyle()` 把非法 `orient` 归一成 `h`（**既有防护**） | 建好后直接改 `trackStyle.orient` 再校验 |
| `old/new entry identical` | 0/28 | 测试里 `delete a.id` 顺序写错 | 正确删 id 后比对 |
| `undo changes node count` | 无变化 | **`UndoStack` 首次 commit 是基准** —— 一次 commit 后 undo 回到"有 1 个节点" | 改为 commit 两次再 undo |

---

## 九、修改文件清单

### 新增（3）

| 文件 | 说明 |
|---|---|
| `tools/icarui/js/registry/controls/track-family.js` | 28 条轨道定义（共享工厂参数化）|
| `tools/icarui/tests/fixtures/p3d-track-golden.json` | **独立旧版基准** |
| `tools/icarui/tests/fixtures/p3d-track-pixels.json` | 像素基准（43 案例）|
| `tools/icarui/tests/verify-p3d-track-family.js` | **64 条断言** |

### 修改（3）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 加载 `track-family.js`；bridge 追加 28 key；**新增启动顺序守卫** |
| `tools/icarui/tests/verify-p3c2-lamp-family.js` | 数量断言改结构性 |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 未改动（关键）

- **`app/`**、**`icar.ui/2`**、**`presets.js`**、**`panels.js`**
- `model.js` / `schema.js` / `canvas.js` / `catalog.js`
- **`bar_*` 全部**（未迁移、未修改）
- 其它 187 个条目的创建逻辑

---

## 十、新发现的 Legacy Behavior Debt

### D-09：`UndoStack` 的首次 `commit()` 建立基准，单次撤销不产生可见变化

| 项 | 内容 |
|---|---|
| **发现于** | P3D（写 undo 测试时） |
| **位置** | `app.js` 的 `UndoStack` 使用处 |
| **现象** | 空设计上 `commit()` 一次 → `doUndo()` 后节点数仍是 1（未退回 0）。`commit()` 两次 → undo 退回 1 |
| **性质** | **刻意设计**。首次 commit 把"当前状态"记为基准（`undo.reset(snapshot(), "初始")`），撤销回到基准而非空 |
| **影响面** | 写撤销测试时若只 commit 一次会误判"undo 没生效"。P3C-2 的状态灯测试也因此用了"节点数变化"而非"回到 0"的宽松判据 |
| **建议** | 不改。测试写法约定：**要观察 undo 必须至少 commit 两次** |
| **当前处置** | P3D 测试改为两次 commit，断言 `undo steps back exactly one node` |

### D-10：`normalizeTrackStyle()` 会把非法值静默归一

| 项 | 内容 |
|---|---|
| **发现于** | P3D |
| **位置** | `model.js` `createNode` 的 `NODE_IMAGE` 分支 |
| **现象** | `createNode(NODE_IMAGE, { trackStyle: { orient: "x" } })` → `trackStyle.orient === "h"`（非法值被归一） |
| **性质** | **刻意防护**（保证画布不会因坏数据崩） |
| **影响面** | 校验器**收不到**坏值 —— 若靠 `build({orient:'x'})` 造坏数据测校验，测试会假通过 |
| **建议** | 不改防护。测试要验证校验器时必须**建好后直接改字段**，不能经过 `createNode` |
| **当前处置** | P3D 测试已按此写法修正 |

> 两条均已追加到 [37_LegacyBehaviorDebt.md](37_LegacyBehaviorDebt.md)。

---

## 十一、剩余兼容性风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | `trackStyle.color` / `accent` 无 UI 编辑入口 | 中 | 字段存在但只能手改 JSON；本阶段未新增 |
| R2 | 138 条仍走 `make()` 探测 | 中 | 其中多数有写 `design.assets` 副作用 |
| R3 | **启动顺序守卫只覆盖抽样 3 条** | 中 | 抽查而非全量（全量 215 次 make 太慢）；若真失效，抽样仍会红 |
| R4 | 旧 `make` 源码仍在 `presets.js` | 中 | 运行时被 bridge 覆盖 |
| R5 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |
| R6 | `vehicleStatus` 全 `unverified`/`n/a` | **高** | 无真车证据 |
| R7 | 像素回归依赖"统一走 make() 路径" | 低 | 已在报告 §7.2 说明方法 |

---

## 十二、P4A 属性面板 Schema 试点建议

### 12.1 现状

28 条轨道、6 个仪表、19 个灯、12 个文字、4 个容器**都已经在 Registry 里声明了 `schema[]`**，
但**属性面板还没读它** —— 面板仍是 `panels.js` 里的硬编码渲染。

### 12.2 建议试点范围：**轨道族**

理由：

| 理由 | 说明 |
|---|---|
| **Schema 结构最规整** | 11 个字段，全部是 number/boolean/enum，**没有嵌套对象、没有 asset 选择器** |
| **不涉及数据绑定** | `slots: []`，不会牵扯 PID 选择器（那是最复杂的控件） |
| **不涉及素材** | 不用处理 `assetId` 下拉 |
| **28 条共享同一 schema** | 一个试点覆盖 28 个控件，投入产出比最高 |
| **有像素基准** | 43 案例可直接用于验证"改属性 → 渲染变化" |

### 12.3 试点步骤建议

1. 在 `panels.js` 新增**一个** `renderPropsFromSchema(node)` 函数（**不重写现有面板**）
2. 仅当 `node.__controlKey` 命中轨道族时走 schema 路径，其余走原路径
3. 用 `p3d-track-pixels.json` 做回归：改属性前后渲染差异应符合预期
4. 成功后再推广到文字族（12 条）→ 容器族（4 条）

### 12.4 需要注意的坑

| 坑 | 说明 |
|---|---|
| **`schema` 路径是点号表示**（`trackStyle.orient`） | 需要通用的 setter/getter，不能简单 `node[key] = v` |
| **`enum` 含 `null`** | `gradient` 的合法值含 `null`（= 不渐变），UI 要能显示"无" |
| **属性面板绝不改渲染** | P2B 明确禁止"重构右侧属性面板"，P4A 必须增量接入 |

---

## 十三、未验证边界

1. **未人工判读 UI**（模型无图像输入能力）
2. **未做真实鼠标拖动的完整物理链路**（派发了 `dragover` + `drop` 事件，但未模拟 OS 级拖动）
3. **`trackStyle.color` / `accent` 的自定义渲染未覆盖**（无 UI 入口，也没手工构造该场景的像素对比）
4. **未在真机上验证**（无真车证据）
5. 138 条仍走 `make()` 探测；`ext` 透传未实施
6. 启动顺序守卫是**抽样**（3 条）而非全量
