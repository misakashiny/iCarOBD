# ICarUI 全框架重构 · P0 架构审计报告

| 字段 | 值 |
| --- | --- |
| 审计日期 | 2026-10-18（Asia/Shanghai） |
| 审计基线 | Git `ef73d48`，工作区干净（仅 4 个受保护的未跟踪原件） |
| 审计性质 | **只读**。未修改任何源码、配置、测试或设计文件 |
| 任务 | `T-UI-REFACTOR-P0-AUDIT` |
| 结论 | 系统性问题成立；重构应以「控件抽象」为核心，分 4 阶段推进 |

> **本报告的方法说明**：多数结论来自**静态解析 + 在 Node 沙箱里真实执行工具模块**，
> 而非人工目测。凡无法验证的，在 §12 明确标为「未验证」。

---

## 一、现有架构总览

### 1.1 规模

| 层 | 文件数 | 行数 | 体积 |
|---|---|---|---|
| 核心业务 JS（`tools/icarui/js/`） | 15 | **12,633** | 675 KB |
| 浏览器测试套件（`tools/icarui/tests/verify-*.js`） | **36** | **18,050** | — |
| 内置素材数据（`assets/builtin-data-*.js`） | 8 | — | **1.19 MB** |
| 样式（`css/studio.css`） | 1 | — | 45 KB |

**单个文件最大**：`app.js` 2,705 行 / 165 KB；`canvas.js` 2,184 行 / 124 KB；
`panels.js` 1,701 行 / 101 KB；`schema.js` 1,267 行 / 84 KB。

### 1.2 加载方式（`tools/icarui/index.html`）

```html
builtin-index.js → pinyin.js → spring.js → schema.js → model.js → validate.js
→ presets.js → canvas.js → next-library/data.js → next-controls.js
→ data-bindings.js → panels.js → editor.js → zip.js → pack.js
→ control-files.js → app.js
```

**零依赖、零构建、17 个 `<script>` 顺序加载**，全部挂在 `window.*` 上。
本报告 §11 会确认这个约束可以保留。

---

## 二、模块依赖与循环（对应要求 3）

### 2.1 实测依赖图

用静态解析提取每个文件 `window.X =` 的**定义**与 `window.X` 的**读取**，
再按「读取的全局符号属于哪个文件」连边：

```
pinyin.js     → (无)
spring.js     → (无)
schema.js     → canvas.js                                    ← 循环源头
model.js      → schema.js, canvas.js
validate.js   → schema.js, model.js
presets.js    → schema.js, model.js, panels.js, canvas.js
canvas.js     → schema.js, spring.js, model.js, app.js, panels.js, editor.js
next-controls.js → canvas.js, model.js, schema.js, presets.js
data-bindings.js → model.js, schema.js, panels.js
panels.js     → canvas.js, schema.js, presets.js, model.js, app.js,
                data-bindings.js, pinyin.js, editor.js
editor.js     → canvas.js, panels.js, model.js, app.js, schema.js,
                data-bindings.js, presets.js, control-files.js
control-files.js → schema.js, model.js, validate.js
app.js        → canvas.js, model.js, schema.js, panels.js, spring.js,
                data-bindings.js, presets.js, validate.js, editor.js
zip.js / pack.js → (无 window 依赖)
```

### 2.2 强连通分量：**15 个文件里有 10 个在同一个环里**

```
cycle#1: validate ←→ control-files ←→ editor ←→ data-bindings
       ←→ presets ←→ panels ←→ app ←→ model ←→ canvas ←→ schema
```

**这不是"几处循环依赖"，而是「几乎整个代码库是一个环」。**
后果：任意文件的加载顺序、初始化时机、状态可见性都无法局部推理；
改一处的影响面只能靠全量回归兜底。

### 2.3 耦合枢纽（被最多其他文件读取的全局符号）

| 全局符号 | 定义处 | 被 N 个其他文件读取 |
|---|---|---|
| `window.NODE_GAUGE` / `window.NODE_IMAGE` | `schema.js` | **9** |
| `window.BUILTIN_PIDS` | `schema.js` | 8 |
| `window.NODE_GROUP` / `window.resolvePid` / `window.NODE_TEXT` | `schema.js` | 7 |
| `window.CanvasState` | `canvas.js` | 6 |
| `window.normalizePart` / `normalizeFont` / `CANVAS` | `schema.js` | 6 |
| `window.newId` | `model.js` | 6 |

**统计口径**：跨文件 `(全局符号, 读取方)` 组合共 **370** 对，
跨文件引用的全局符号共 **204** 个。

### 2.4 每个文件的跨文件引用权重

| 文件 | 引用他人全局符号的次数 |
|---|---|
| `canvas.js` | **82** |
| `app.js` | **75** |
| `panels.js` | **69** |
| `validate.js` | 45 |
| `editor.js` | 38 |
| `model.js` | 23 |
| `presets.js` | 16 |
| `next-controls.js` | 10 |
| `data-bindings.js` | 7 |
| `control-files.js` | 4 |
| `schema.js` | 1 |

**`schema.js` 只依赖 1 个外部符号，却提供了 114 个导出** —— 它是全库最稳定的底座，
唯一问题是那 1 个依赖（指向 `canvas.js`）制造了整个环。

### 2.5 15 个「读了但从未定义」的全局符号

```
BUILTIN_ASSETS, NEXT_LIBRARY, NUMERIC_, PackKit, ZipKit,
partKindName, alert, confirm, console, prompt, addEventListener,
devicePixelRatio, innerHeight, innerWidth, requestIdleCallback
```

前 5 个是**拼写/命名漂移**（例如 `NUMERIC_` 是 `NUMERIC_NODE_FIELDS` 之类的前缀误匹配，
`PackKit`/`ZipKit` 疑似旧名残留）；后 10 个是浏览器原生 API。
**说明代码里存在引用旧名的死代码路径**，重构时应清理。

---

## 三、控件库盘点（对应要求 1）

### 3.1 方法

**不是数行数，而是把 `presets.js` 真正跑起来**：在 Node `vm` 沙箱里 stub 掉
`window`/`document`/`navigator`，按 `index.html` 的顺序加载 `schema.js` → `model.js`
→ `validate.js` → `presets.js`，然后遍历 `window.BUILTIN_CONTROLS`，
对每一项调用 `make()` 看它**实际产出什么节点**。

**修正一个数字**：此前调研报告的「192 条」是正则计数，
**真实运行时是 200 条**（正则漏掉了数组驱动生成的条目）。本报告以 **200** 为准。

### 3.2 分类结果

| 类别 | 数量 | 占比 |
|---|---|---|
| 静态素材（纯图片，无数据） | **77** | **38.5%** |
| 图片轨道（存量兼容，`bar_*`） | **28** | 14.0% |
| 代码绘制轨道（`cd_*`） | **28** | 14.0% |
| 功能控件（仪表，`gauge_*`/`g_*`） | **26** | 13.0% |
| 状态灯（图片 + 状态机，`lamp_*`） | 19 | 9.5% |
| 文字控件（`text`/`t_*`/`box_h*`/`box_note`） | 12 | 6.0% |
| 控件预设（拼装仪表，`gauge_parts*`） | 6 | 3.0% |
| 结构/容器（`group`/`box_*`） | 4 | 2.0% |
| **合计** | **200** | 100% |

**按节点类型**（`make()` 实际返回值）：`image` 152、`gauge` 32、`text` 12、`group` 4。

> **关键判断**：**76% 的库条目是 `image` 节点**（152/200）。
> 也就是说「控件库」实际上是「素材库 + 少量真控件」的混合体。
> 用户找"能显示转速的表"需要翻过 152 个图片条目 —— 这是"库臃肿"的直接机制。

### 3.3 逐条清单

#### 功能控件（26 条，`make()` 产出 `gauge` 且带 pid）

`gauge_0`~`gauge_7`（8 种样式各一条，全部用转速做样板）、
`g_speed`、`g_coolant`、`g_fuel`、`g_volt`、`g_intake`、`g_boost`、`g_load`、`g_throttle`、
`g_rpm`、`g_avgfuel`、`g_instfuel`、`g_range`、`g_odo`、`g_oiltemp`、`g_gearbox`、`g_afr`、`g_gear`、`g_gforce`

定义位置：`tools/icarui/js/presets.js:123`（8 样式循环）、`:156`（8 个常用 PID）、
`:435`（`更多控件` 段，10 + 4 + 16 条）。

#### 控件预设（6 条，拼装仪表）

`gauge_parts`、`gauge_parts_arc`、`gauge_parts_dual`、`gauge_parts_triple`、`gauge_parts_bigval`、`gauge_parts_fuel`

定义位置：`presets.js:332`、`:358`、`:1029` 起（`分类（v2.22.0）` 段）。
它们由 `normalizePart()` 拼出 `parts` 子树，是**唯一带子部件结构的库条目**。

#### 文字控件（12 条）

`text`、`t_title`、`t_label`、`t_unit`、`t_big`、`t_warn`、`t_ok`、`t_small`、`t_bigunit`、
`box_h1`、`box_h2`、`box_note`

⚠️ `box_h1`/`box_h2`/`box_note` 在 `make()` 里产出 `text` 节点，
但 key 前缀是 `box_`（暗示容器）—— **命名与语义不一致**。

#### 状态灯（19 条）

`lamp_coolant`、`lamp_oil`、`lamp_batt`、`lamp_brake`、`lamp_pad`、`lamp_tpms`、
`lamp_airbag`、`lamp_belt`、`lamp_abs`、`lamp_esp`、`lamp_engine`、`lamp_fuel`、
`lamp_door`、`lamp_washer`、`lamp_service`、`lamp_temp`、`lamp_charge`、`lamp_lane`、`lamp_collision`

定义位置：`presets.js:275-329`。每条产出 `image` 节点 + `states{normal,warn,critical}` 三态图。
**关键**：必须写 `statePid`（不是 `pid`）—— 见 `presets.js:309-316` 的血泪注释。

#### 代码绘制轨道（28 条，`cd_*`）

`cd_track{h,v}`、`cd_trackgrad{h,v}`、`cd_trackfade{h,v}`、`cd_trackinset{h,v}`、
`cd_trackglow{h,v}`、`cd_trackticks{h,v}`、`cd_seg{5,10,20}{h,v}`、`cd_band3{h,v}`、
`cd_fill{h,v}`、`cd_fillglow{h,v}`、`cd_marker{h,v}`、`cd_cursor{h,v}`

定义位置：`presets.js:569-629`。产出 `image` 节点 + `trackStyle` 对象，
`assetId` 为空，由 `canvas.js:820` 的 `drawTrackNode()` 用 canvas 原语绘制。

#### 图片轨道（28 条，`bar_*` —— 存量兼容层）

`bar_track{h,v}`、`bar_trackgrad{h,v}`、`bar_fill{h,v}`、`bar_seg{5,10,20}{h,v}`、
`bar_marker{h,v}`、`bar_markerglow{h,v}`、`bar_trackglow{h,v}`、`bar_trackinset{h,v}`、
`bar_trackticks{h,v}`、`bar_fillglow{h,v}`、`bar_fillgrad{h,v}`、`bar_band3{h,v}`

定义位置：`presets.js:632` 起 + `:725`（`闲置素材接线（v2.86.0）` 段）。
每条产出 `image` 节点 + 一个 PNG `path`。

#### 静态素材（77 条，纯图片）

底盘类：`img_ring`、`img_dial40`、`img_half`、`img_plate`、`img_carbon`、`img_grid`、
`img_glow`、`img_corners`、`img_lineh`、`img_trackbar`、`img_trackarc`、`img_dots`、`image`

形状类：`img_oct`、`img_capsule`、`img_twin`、`img_triple`、`img_arc270`、`img_ticks90`、
`img_seg20`、`img_needle`、`img_cap`、`img_frame`、`img_glowring`

背景类：`img_carbonblk`、`img_plateblank`、`img_bgmesh`、`img_bghex`、`img_bgvign`

数字类：`img_digit0`~`img_digit9`、`img_digitdot`、`img_digitminus`、`img_digitpct`、
`img_numsarc9`、`img_numsarc11`、`img_numsarc5`、`img_numsarcjump5`、
`img_numsrow`、`img_numsroweven`、`img_numsrowtens`、`img_numscol`、`img_numscolpct`

单位类：`img_unitrpm`、`img_unitkmh`、`img_unitc`、`img_unitv`、`img_unita`、
`img_unitpct`、`img_unitbar`、`img_unitl100`、`img_unitkm`、`img_unitx1000`

图标类：`img_icfuel`、`img_ictemp`、`img_icbatt`、`img_icoil`、`img_icturbo`、`img_icgear`、
`img_icodo`、`img_icrange`、`img_icclock`、`img_icgps`、`img_iccheck`、`img_iccross`

其它：`img_ticksband`、`img_ticksgrad`、`img_lampcrit`、`img_alertbar`

#### 结构/容器（4 条）

`group`、`box_card`、`box_row`、`box_col`

### 3.4 重复实现：**24 组同名双实现**

`cd_*`（代码绘制）与 `bar_*`（图片）各有 28 条，**归一化前缀后 24 个名字完全相同**：

| 概念 | 代码版 | 图片版 |
|---|---|---|
| 水平/垂直轨道 | `cd_trackh` / `cd_trackv` | `bar_trackh` / `bar_trackv` |
| 渐变轨道 | `cd_trackgradh/v` | `bar_trackgradh/v` |
| 内凹轨道 | `cd_trackinseth/v` | `bar_trackinseth/v` |
| 发光轨道 | `cd_trackglowh/v` | `bar_trackglowh/v` |
| 带刻度轨道 | `cd_trackticksh/v` | `bar_trackticksh/v` |
| 5/10/20 段条 | `cd_seg5/10/20h/v` | `bar_seg5/10/20h/v` |
| 三段色带 | `cd_band3h/v` | `bar_band3h/v` |
| 填充条 | `cd_fillh/v` | `bar_fillh/v` |
| 发光填充 | `cd_fillglowh/v` | `bar_fillglowh/v` |
| 阈值标记 | `cd_markerh/v` | `bar_markerh/v` |

只在 `cd_` 有：`trackfadeh/v`、`cursorh/v`（4 条）
只在 `bar_` 有：`markerglowh/v`、`fillgradh/v`（4 条）

**这不是意外重复，是刻意的兼容策略** —— `presets.js:555-565` 有完整说明：

> `bar_*`（图片）—— 存量设计的观感锚点。设计文件按 `path` 引用它们，
> 删掉 = 存量设计在设备上**空白**。
> `cd_*`（代码）—— 新做的设计用这一批。

**重构价值**：这 56 条应收敛为**一个 `Track` 概念 + 两种渲染器**（见 §7.5）。
这正是"渲染适配层"要解决的东西。

---

## 四、控件全链路追踪（对应要求 2）

### 4.1 七个阶段

| # | 阶段 | 入口 | 关键文件:行 |
|---|---|---|---|
| 1 | **注册** | `window.BUILTIN_CONTROLS` 数组 | `presets.js:120` 建数组；各段 `list.push({key,name,icon,make})`；`:920` 起 `CAT_RULES` 分类 |
| 2 | **创建** | 拖拽 → 调条目 `make()` | `presets.js` 各段的 `make()`；工厂 `model.js` 的 `createNode()`；全库 `createNode` 调用点：`presets.js` 28 处、`next-controls.js` 3、`model.js` 2、`panels.js` 1 |
| 3 | **属性编辑** | `renderProps()` | `panels.js:328`；属性行工厂 `panels.js:303` 的 `row()`（全库 63 处）；分组函数 `group()` 共 **13 组** |
| 4 | **数据绑定** | `bindingPidOptions()` / `assignControlBinding()` | `data-bindings.js:15` / `:33`；别名表 `schema.js:1406` `window.PID_ALIASES`（36 条）；解析 `schema.js:1528` `resolvePid()` |
| 5 | **预览渲染** | `draw()` → `drawNode()` | `canvas.js:270` `draw()`；`:703` `drawNode()`；分支 `:738` `drawImageNode()` / `:820` `drawTrackNode()` / `:963` `drawTextNode()` / `:1237` `drawGaugeParts()` |
| 6 | **序列化** | `nodeToJson()` | `model.js:802`；逐字段白名单写入；`bandsJson()` 在 `:792` 单独抽出 |
| 7 | **App 运行** | `DesignFile.parse()` → `NodeTreeRenderer.build()` | `app/src/main/java/com/icar/obd/data/DesignFile.kt`（解析 + 别名表）；`ui/dash/NodeTreeRenderer.kt:337` `buildImage` / `:372` `buildGauge` / `:353` `buildText`；`ui/view/GaugeViewFactory.kt:18` 按 `style` 建视图 |

### 4.2 链路上的**结构性问题**

**问题 A：字段要在 4 个地方各写一遍**

新增一个节点字段，必须同步修改：

1. `schema.js` 的 `normalize*`（读入归一化）
2. `model.js:802` `nodeToJson`（写出）
3. `panels.js` `renderProps`（面板编辑）
4. App 侧 `DesignNode.kt`（解析）+ `NodeTreeRenderer.kt`（渲染）

**没有任何一处是"定义即生效"的** —— 这是"加个字段要改五处、漏一处就静默失效"的机制性来源。

**问题 B：`nodeToJson` 是手工白名单**

`model.js:802-830+` 逐字段 `o.xxx = ...`。漏写 = 字段在当前格式里不存在，
但内存里存在 —— **工具里看着正常、存盘后丢失**。

**问题 C：测试用正则从源码抓字段名**

`model.js:786-791` 的注释明确写道：

> `tests/verify-fields.js` 的**结构面**检查是从 `nodeToJson` 的源码里正则抠 `o.FIELD =` 的。

也就是说**测试的正确性依赖源码排版**。重排 `nodeToJson` 会让测试误报（注释里已记录踩过）。

**问题 D：`statePid` vs `pid` 的双轨**

状态灯必须写 `statePid`；写成 `pid` 会**永远显示暗图**（`presets.js:309-316` 记录为"这个库里最贵的一条"）。
App 侧 `NodeTreeRenderer.kt:348` 只读 `statePid`；`model.js` 的 `nodeToJson` 对 `NODE_IMAGE` **只序列化 `statePid`**。
**同一语义存在两个字段名，且不做互斥校验**。

---

## 五、`schema.js` / `panels.js` / `refreshAll()` 分析（对应要求 3）

### 5.1 `schema.js`：114 个导出的"万能底座"

一个文件同时承担：

| 职责 | 例子 |
|---|---|
| 格式常量 | `SCHEMA_V1`/`SCHEMA_V2`/`CANVAS`/`MAX_NODES`/`MAX_PARTS`/`GRID`/`STEP` |
| 节点类型常量 | `NODE_GAUGE`/`NODE_IMAGE`/`NODE_TEXT`/`NODE_GROUP`/`NODE_TYPES` |
| 数值字段表 | `NUMERIC_NODE_FIELDS`/`NUMERIC_PART_FIELDS`/`NUMERIC_GAUGE_FIELDS` |
| 归一化函数 | `normalizePart`/`normalizeFont`/`normalizeBands`/`normalizeTrackStyle`/`normalizeValueLabels` |
| 数据源注册表 | `BUILTIN_PIDS`（40 条）/`PID_ALIASES`（36 条）/`ALIAS_OF` |
| 几何计算 | `partAngle`/`clamp`/`trackUsable` |
| 展示映射 | `STYLES`/`STATE_NAMES`/`CARD_NAMES`/`styleColor` |

**它被 9 个文件依赖，自己只依赖 1 个**（`canvas.js`）。这个反向依赖制造了 §2.2 的整环。
**重构时把它拆开，环会自动解开。**

### 5.2 `panels.js`：innerHTML 全量重建

```js
function renderProps() {                     // panels.js:328
  const box = el("props");
  ...
  box.innerHTML = ...;                       // ← 整块 DOM 重建
}
```

- 属性行 63 处 `row()`，分组 **13 个**（其中「数据绑定」出现两次：`binding` 与 `data`，重复）
- `panels.js` 全文 `innerHTML =` **11 处**
- `window.renderPanels = function () { renderTree(); renderProps(); renderAssets(); }`（`panels.js:2046`）

**由此产生的已知补丁**（代码注释自证）：

| 补丁 | 位置 | 说明 |
|---|---|---|
| `setNodeNumLive` + `endLiveEdit` | `panels.js:306-322` | 因为 `innerHTML` 重建会**换掉输入框、丢光标**，才把 `oninput` 改成"手势期间不重建" |
| `S.suppressPanelRender` | `app.js` `refreshAll()` 内 | 滚轮缩放期间跳过面板重建 |

**两个补丁都是同一个根因的症状**：面板没有增量更新能力。

### 5.3 `refreshAll()`：全量刷新是默认路径

```js
function refreshAll() {                       // app.js
  if (window.syncAssetImages) window.syncAssetImages();
  renderPageTabs();
  if (!S.suppressPanelRender && window.renderPanels) window.renderPanels();  // 全量
  if (window.draw) window.draw();
  if (window.__ensureAnimPreview) window.__ensureAnimPreview();
}
```

| 指标 | 数量 |
|---|---|
| `refreshAll(` 调用点 | **17** |
| `commit(` 调用点 | **90** |
| `draw()` 调用点 | 46 |
| `renderPanels(` 调用点 | 7 |
| `renderProps(` 调用点 | 13 |
| `renderTree(` 调用点 | 8 |

**代码注释里的历史实测**（`app.js` `refreshAll` 上方）：

> `renderPanels()` 要重建整个素材库 + 控件树 + 控制库（实测 **60 个控件时 8.8ms**，
> 占一次滚轮事件 **17.8ms** 的一半）

⚠️ **此数据是代码注释里的历史实测，本次审计未重新测量**（见 §12）。

**结论**：性能问题的根因是**架构性**的 —— 90 个 `commit` 调用点里每一个都可能触发全量面板重建，
而面板重建是 O(全部控件 + 全部素材)。

---

## 六、两个灯问题分别定性（对应要求 4）

### 6.1 「13 个状态灯没有数据源」—— **成立，根因已精确定位**

把 19 个灯的定义（`presets.js:275-296`）逐条对照 App 别名表
（`app/.../data/DesignFile.kt` 的别名映射）和工具自己的 `BUILTIN_PIDS`（`schema.js:1468`）：

| 灯 | 绑定别名 | App 别名单有 | 工具 BUILTIN_PIDS 有 | 结论 |
|---|---|---|---|---|
| 水温灯 | `obd.coolant` | ✅ | ✅ | **可用**（→ `std_05`）|
| 机油灯 | `tpl_oilPressure` | ❌ | ✅（厂家模板） | **不可用** |
| 电池灯 | `obd.voltage` | ✅ | ✅ | **可用**（→ `std_42`）|
| 制动灯 | `obd.brakeFluid` | ❌ | **❌** | **不可用** |
| 刹车片 | `obd.brakePad` | ❌ | **❌** | **不可用** |
| 胎压灯 | `obd.tpms` | ❌ | **❌** | **不可用** |
| 气囊灯 | `obd.airbag` | ❌ | **❌** | **不可用** |
| 安全带灯 | `obd.seatbelt` | ❌ | **❌** | **不可用** |
| ABS 灯 | `obd.abs` | ❌ | **❌** | **不可用** |
| ESP 灯 | `obd.esp` | ❌ | **❌** | **不可用** |
| 发动机灯 | `obd.engineFault` | ✅ | ✅ | **可用**（→ `std_01`）|
| 燃油报警 | `obd.fuel_level` | ✅ | ✅ | **可用**（→ `std_2F`）|
| 车门未关 | `obd.door` | ❌ | **❌** | **不可用** |
| 玻璃水 | `obd.washer` | ❌ | **❌** | **不可用** |
| 保养提示 | `obd.service` | ❌ | **❌** | **不可用** |
| 水温报警 | `obd.coolant` | ✅ | ✅ | **可用** |
| 充电提示 | `obd.voltage` | ✅ | ✅ | **可用** |
| 车道辅助 | `obd.laneKeep` | ❌ | **❌** | **不可用** |
| 碰撞预警 | `obd.collision` | ❌ | **❌** | **不可用** |

**可解析 6 个，不可解析 13 个** —— 与用户/前序调研的数字**完全吻合**。

**根因比此前判断更深一层**：这 13 个里，**12 个的别名连工具自己的 `BUILTIN_PIDS` 都不存在**。
`resolvePid()`（`schema.js:1528`）的实现是 `PID_ALIASES[name] || name`，
所以它把 `"obd.tpms"` **原样**写进 `statePid`。

**这些不是"缺数据源"，而是「纯占位符」** —— 库里能拖、能绑、能存盘，
但从来没有任何一层定义过这个通道。

**运行时表现**（与"静默消失"的旧判断不同，已修正）：
`NodeTreeRenderer.kt:348` 对绑定但未解析的 image 节点调 `showUnknown()`，
`showUnknown`（`:586`）把 drawable 置空并让 `StateImageView.unknown = true`，
最终由 `:82-91` 画出 `NodeStateResolver.UNKNOWN_TEXT`（`NodeStateResolver.kt:9` = `"--"`）。
**即：灯显示 `--`，不是消失。** 这比"静默消失"好，但用户仍无法分辨"车没问题"与"这条路根本不通"。

### 6.2 「19 个状态灯素材复用」—— **已修复，不是当前问题**

`presets.js:243-274` 记录了 v2.91.0 的重做。实测素材目录可验证：

| 项 | 数量 |
|---|---|
| `assets/warning/` 下 PNG 总数 | 105 |
| **新式** `lamp-<key>-<off/warn/crit>.png` | **57**（= 19 类 × 3 态）|
| 旧式共用 `lamp-off` / `lamp-warn` / `lamp-crit` | 3 |

`presets.js:250-253` 引用的体检输出（"19 个灯全是同一张图"）是**重做前**的状态。
**现在每个灯三态各一张自己的图。**

**仍然存在的问题（不是复用，而是双轨）**：

1. **旧路径必须永久保留**：`lamp-off.png` / `lamp-warn.png` / `lamp-crit.png` 三个文件
   被**存量设计文件按路径引用**（`presets.js:265-269` 说明「一个字都没动」）。
2. **`img_lampcrit` 控件仍指向旧 `lamp-crit.png`**（`presets.js:269`）。
3. 素材命名存在**新旧两套**，重构必须保证**旧路径继续可用**。

**结论**：要求 4 的第二个前提（素材复用）**已不成立**，应更新为"新旧路径双轨兼容"，
这是 Asset Library 设计时的硬约束，而不是待修缺陷。

---

## 七、新架构设计（对应要求 5）

### 7.1 设计原则

1. **零依赖、零构建不变**（`<script>` 顺序加载，`window.*` 命名空间）
2. **`icar.ui/2` 语义不变**：新架构是**写层与读层之间**的中间表示，不是新格式
3. **单一事实源**：一个控件的"是什么"只定义一次
4. **可渐进迁移**：新旧并存，逐个控件切换，任何时候都能回退

### 7.2 六大 Registry

```
┌──────────────────────────────────────────────────────────────┐
│  Control Registry      控件定义（唯一事实源）                  │
│    id, name, category, icon                                   │
│    build(props) → Node                                        │
│    schema: PropSchema[]     → 驱动属性面板                     │
│    slots: DataSlot[]        → 驱动绑定与可用性检查              │
│    render: 适配层入口        → 决定用哪个渲染器                 │
└──────────────────────────────────────────────────────────────┘
        │                │                │              │
        ▼                ▼                ▼              ▼
┌───────────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────┐
│ Preset Library│ │ Asset Library│ │ DataSource │ │ Render       │
│ 布局预设/拼装  │ │ 素材索引      │ │ Registry   │ │ Adapter      │
│ （PRESETS）   │ │ （图片+新旧    │ │ 通道+别名   │ │ 节点→绘制     │
│               │ │  路径兼容）   │ │ +可用性     │ │ 器（image/    │
│               │ │              │ │             │ │ code/parts）  │
└───────────────┘ └──────────────┘ └────────────┘ └──────────────┘
```

| Registry | 职责 | 现状对应物 | 迁移难度 |
|---|---|---|---|
| **Control Registry** | 控件定义（build/schema/slots/render） | `BUILTIN_CONTROLS`（只有 build） | 高 |
| **Schema 驱动属性面板** | 由 `PropSchema[]` 自动生成面板 | `panels.js` 手写 63 行 13 组 | 高 |
| **Asset Library** | 素材索引 + 新旧路径映射 | `BUILTIN_ASSETS` / `ensureBuiltinAsset` | 中 |
| **Preset Library** | 布局预设 + 拼装仪表 | `window.PRESETS` / `gauge_parts*` | 低 |
| **DataSource Registry** | 通道 + 别名 + **可用性** | `BUILTIN_PIDS` + `PID_ALIASES`（分散在 schema.js） | 中 |
| **Render Adapter** | 节点 → 具体绘制器 | `canvas.js` 的 `drawNode` 分支 | 中 |

### 7.3 目录草案（保持 `<script>` 顺序加载）

```
tools/icarui/
  js/
    core/                        ← 无依赖层（可直接照搬现状）
      constants.js               ← schema.js 的常量部分
      namespaces.js              ← window.* 命名空间声明（消环关键）
    registry/
      control-registry.js        ← 控件定义（唯一事实源）
      prop-schema.js             ← 属性声明（驱动的面板）
      asset-library.js           ← 素材索引（含新旧路径映射）
      preset-library.js          ← 布局/拼装预设
      datasource-registry.js     ← 通道 + 别名 + 可用性
    render/
      render-adapter.js          ← 节点类型 → 渲染器分派
      render-image.js            ← 图片
      render-track.js            ← 代码轨道（吸收 cd_*）
      render-gauge.js            ← 仪表主体
      render-text.js             ← 文字
      render-parts.js            ← 子部件
    model/
      node-factory.js            ← createNode / normalize
      serialize.js               ← nodeToJson（**保持字段名不变**）
      validate.js
    editor/
      panels/                    ← 按 schema 生成，按域拆分
      canvas/
      undo/
    app.js                       ← 只做装配
```

**必须是普通 `<script>`，不能是 ES module** —— 现状 17 个 `<script>` 直接执行、
且 `verify-crosslang.js` 在 Node 里用 `vm` 顺序加载。
改成 `<script type="module">` 会让所有测试桩失效，代价远大于收益。

### 7.4 Control 定义草案

```js
// control-registry.js
ControlRegistry.define({
  id: "g_speed",
  name: "车速",
  category: "仪表",           // ← 驱动库分组（解决"库臃肿"）
  icon: "▬",
  build: (props) => createNode(NODE_GAUGE, {
    pid: "obd.speed", style: 1, ...props,
  }),
  schema: [                    // ← 驱动面板（解决"面板乱"）
    { key: "w",   label: "宽度", type: "number", min: 20 },
    { key: "h",   label: "高度", type: "number", min: 20 },
    { key: "max", label: "量程上限", type: "number", group: "数据" },
  ],
  slots: [                     // ← 驱动绑定检查（解决"绑了不生效"）
    { role: "value", required: true, accept: ["obd.speed"] },
  ],
  render: "gauge",             // ← 渲染适配层入口
});
```

**一处定义同时驱动**：库分组、面板字段、绑定可用性、渲染分派、序列化字段校验。

### 7.5 关键收敛：Track 概念（24 组双实现 → 1 概念 + 2 渲染器）

```js
ControlRegistry.define({
  id: "track",
  name: "轨道",
  category: "素材组件",
  schema: [
    { key: "orient", type: "enum", values: ["h", "v"] },
    { key: "variant", type: "enum", values: ["plain","gradient","inset","glow","ticks","segments","band","fill"] },
    { key: "renderer", type: "enum", values: ["code", "image"] },  // ← 适配层
  ],
  render: "track",            // 内部按 renderer 分派 drawTrackNode 或 drawImageNode
});
```

**映射**：`cd_trackh` → `{orient:"h", variant:"plain", renderer:"code"}`
`bar_trackh` → `{orient:"h", variant:"plain", renderer:"image"}`

**约束**：`bar_*` 的 `path` 必须继续写进设计文件（存量兼容），
所以 `build()` 在 `renderer:"image"` 时要保留原 `assetId`。

---

## 八、新旧控件数据映射表（对应要求 6）

### 8.1 格式兼容的三条硬约束

1. **`schema: "icar.ui/2"` 不能变** —— 变了 App 侧 `DesignFile.parse` 会拒绝
2. **字段名不能变** —— `model.js:802` `nodeToJson` 写什么，`DesignNode.kt` 就读什么
3. **未知字段必须保留** —— 用户提到「保留已有设计文件与未知字段」

### 8.2 节点字段映射（57 个 App 字段 → 新架构归属）

| 域 | 字段 | 新架构归属 | 说明 |
|---|---|---|---|
| **变换** | `x,y,w,h,rotation,scale,alpha,z` | Node 核心 | 所有类型共有 |
| **身份** | `id,type,name` | Node 核心 | |
| **可见性** | `locked,visible` | Node 核心 | |
| **结构** | `children,parts` | Node 核心 | |
| **仪表** | `gauge{pid,style,min,max,warnLow,warnHigh,bands,...}` | Gauge 子对象 | 由 `ControlRegistry` 的 `slots` 校验 pid 可用性 |
| **文字** | `text,font{family,size,weight,italic,letterSpacing,align,color,isDefault,...}` | Text 子对象 | |
| **图片** | `assetId` | Asset Library | 需新旧路径兼容 |
| **状态** | `statePid,stateWarn,stateCritical,states{normal,warn,critical}` | State 子对象 | ⚠️ `statePid`/`pid` 双轨需在 schema 里互斥 |
| **轨道** | `trackStyle{orient,radius,inset,gradient,glow,segments,ticks,band,fill}` | Render Adapter | 由 `render:"track"` 消费 |
| **动画** | `anim{kind,periodMs,phase,amplitude}` | Node 核心 | |
| **标签显示** | `showLabel,showRange,labelFont` | Gauge 子对象 | |

**映射表结论**：**新架构不需要改任何字段名**。它是 57 个字段的**分组与校验层**，
不是新格式。这是本方案风险可控的根本原因。

### 8.3 Control 映射表（200 条 → 新模型）

| 旧类别 | 旧 key 前缀 | 新模型 | 迁移动作 |
|---|---|---|---|
| 功能控件 26 | `gauge_*`、`g_*` | `Control{render:"gauge"}` | 逐条补 `schema`/`slots` |
| 控件预设 6 | `gauge_parts*` | `Preset{kind:"composite"}` | 复用现有 `parts` |
| 文字 12 | `text`、`t_*`、`box_h*` | `Control{render:"text"}` | 按用途合并 |
| 状态灯 19 | `lamp_*` | `Control{render:"image", states:3}` | `slots` 标注**可用性** |
| 代码轨道 28 | `cd_*` | `Control{render:"track",renderer:"code"}` | 合并进 Track |
| 图片轨道 28 | `bar_*` | `Control{render:"track",renderer:"image"}` | 合并进 Track，**保留 path** |
| 静态素材 77 | `img_*`、`image` | **移出控件库** → Asset Library | 从 200 降到 123 |
| 结构 4 | `group`、`box_*` | `Control{render:"container"}` | |

**迁移后库条目数**：200 → **123**（控件类），素材 77 条移入独立素材面板。
**这是"库臃肿"的量化修复**。

---

## 九、高风险耦合点（对应交付项）

| # | 风险 | 位置 | 为什么危险 | 缓解 |
|---|---|---|---|---|
| **R1** | **整个代码库是一个环** | §2.2 | 改任意一处的影响面不可推理 | 拆 `schema.js`→`core/`，先解 `schema→canvas` 这条边 |
| **R2** | **4 处字段重复定义** | §4.2 问题 A | 漏改一处 = 静默失效 | 字段表从 `PropSchema` 生成，删掉手写白名单 |
| **R3** | **测试正则抓源码** | `model.js:786-791`；`verify-fields.js`、`verify-lamp-state.js`、`verify-spring.js`、`verify-v291.js`、`verify-crosslang.js` | 重排源码即误报 | 迁移前先把这些断言改成**行为断言** |
| **R4** | **`statePid`/`pid` 双轨** | `presets.js:309`；`NodeTreeRenderer.kt:348` | 写错字段则灯永远暗 | schema 里互斥校验 + 库定义走唯一入口 |
| **R5** | **存量设计按 `path` 引用素材** | `presets.js:265-269` | 改素材路径 = 存量设计空白 | Asset Library 保留旧路径永久别名 |
| **R6** | **`verify-crosslang.js` 用正则解析 Kotlin** | `tools/icarui/tests/verify-crosslang.js`（813 行） | JS 常量结构一变，正则失配 → 假绿/假红 | 常量形状冻结；无法冻结时同步改正则并加自检 |
| **R7** | **90 个 `commit()` 调用点** | 全库 | 任何"改 commit 行为"的改动放大 90 倍 | 保持 `commit` 签名不变，只换内部实现 |
| **R8** | **`innerHTML` 全量重建** | `panels.js` 11 处 | 焦点丢失 / 性能 | 分阶段：先拆只读区，再上增量 |
| **R9** | **15 个引用未定义的全局符号** | §2.5 | 死代码路径，重构时误判 | 迁移时逐个确认并清理 |

---

## 十、分阶段重构任务与验收（对应交付项）

### 阶段 0（本报告）：审计 — **已完成**

### 阶段 1：解环与基础设施（**不改行为**）

| 任务 | 内容 | 验收 |
|---|---|---|
| 1.1 | 拆 `schema.js` → `core/constants.js` + `core/value-labels.js` + `registry/datasource-registry.js` | 36 个套件全绿；`verify-crosslang.js` 通过 |
| 1.2 | 消除 `schema.js → canvas.js` 反向依赖 | 依赖图无环（用本次的解析脚本验证） |
| 1.3 | 建立 `window.ICAR` 命名空间，逐步收敛 `window.*` | 未定义的 15 个符号清零或登记 |
| 1.4 | 把 4 个源码正则断言改成行为断言 | 改后测试覆盖不降低 |

**关键**：阶段 1 结束时**用户观感零变化**。

### 阶段 2：Control Registry（**先建旁路，不替换**）

| 任务 | 内容 | 验收 |
|---|---|---|
| 2.1 | 实现 `ControlRegistry` + `PropSchema` 驱动的**只读面板预览**（新面板，旧面板并存） | 新旧面板对同一节点显示的字段值一致 |
| 2.2 | 迁移 **低风险控件**（见 §11）到 Registry | 新旧条目产出的节点 JSON **逐字段相等** |
| 2.3 | 建 `DataSourceRegistry`，含**可用性检查** | 13 个不可用灯在工具里**可见地标灰** |

**关键**：阶段 2 用**双写对比**验证 —— 同一个控件走旧路径与新路径，产出的
`nodeToJson()` 结果必须 `deepEqual`。

### 阶段 3：库重组 + 渲染适配层

| 任务 | 内容 | 验收 |
|---|---|---|
| 3.1 | 静态素材 77 条移出控件库 | 库条目 200 → 123；存量设计引用不受影响 |
| 3.2 | `cd_*`/`bar_*` 合并为 Track 概念 | 56 条 → 1 概念 × 2 渲染器；**两种渲染器产出节点与旧版逐字段相等** |
| 3.3 | 渲染适配层接管 `drawNode` 分派 | 像素级回归（截图对比）无差异 |

### 阶段 4：面板增量更新 + 性能

| 任务 | 内容 | 验收 |
|---|---|---|
| 4.1 | 面板按 `PropSchema` 分域增量更新 | 数字框输入不丢焦点（可去掉 `setNodeNumLive` 补丁） |
| 4.2 | 去掉 `suppressPanelRender` 补丁 | 滚轮缩放无面板重建 |
| 4.3 | 性能基准 | 60 控件场景 `renderPanels` **≤ 2ms**（现注释记录 8.8ms，需重新测量确定基线） |

---

## 十一、推荐最先迁移的低风险控件（对应交付项）

**筛选标准**：① 无 `parts` 子树 ② 无 `states` 状态机 ③ 无 `trackStyle`
④ 字段少 ⑤ 有现成测试覆盖。

| 顺序 | 控件 | 理由 |
|---|---|---|
| **1** | `t_label` / `t_unit` / `t_small` | 纯文字，字段最少；有 `verify-font.js` 覆盖 |
| **2** | `g_speed` / `g_coolant` | 单 pid、单 style，最典型的仪表；`verify-pid.js` 覆盖 |
| **3** | `gauge_0`~`gauge_7` | 8 条结构完全同构，一次迁移能验证"循环生成"路径 |
| **4** | `cd_trackh` / `cd_trackv` | 只有 `trackStyle`，无 pid；用来验证渲染适配层 |
| **5** | `lamp_coolant` / `lamp_batt`（**可用**的 6 个灯） | 有 states 但 pid 可解析，安全性高 |

**不要先动**：`gauge_parts*`（parts 子树）、`bar_*`（path 兼容）、
13 个不可用灯（要先解决 DataSource 语义）。

---

## 十二、零依赖零构建的模块化评估（对应要求 8）

### 12.1 约束实测

| 约束 | 现状 | 新架构能否满足 |
|---|---|---|
| 无构建步骤 | 17 个 `<script>` 顺序加载 | ✅ 保持 |
| 无第三方依赖 | 无 `package.json` 依赖 | ✅ 保持 |
| 测试在 Node 里加载工具 | `verify-crosslang.js` 用 `vm` + 浏览器桩顺序加载 | ✅ 只要仍是普通脚本 |
| 测试驱动真实页面 | 36 套件全靠 CDP | ✅ 不受模块拆分影响 |

### 12.2 三种方案对比

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 普通 `<script>` + IIFE + `window.ICAR.*` 命名空间** | 目录拆分，文件顺序加载 | ✅ **推荐**。零风险，测试桩不改 |
| B. ES Module (`<script type="module">`) | 原生 `import`/`export` | ❌ 会破坏 `vm` 加载与 `file://` 直接打开；收益不足以抵消风险 |
| C. 单个 IIFE 命名空间 + 手写依赖顺序 | 全塞一个文件 | ❌ 可维护性更差 |

### 12.3 关键结论

**模块化靠"命名空间 + 目录"就够，不需要模块系统。**
`window.ICAR.registry.control` 这样的路径已经能提供边界感，
而 `window.*` 的 204 个平铺符号才是混乱来源。

---

## 十三、未验证边界（如实声明）

1. **性能数字未重测**：`8.8ms` / `17.8ms` 来自 `app.js` 注释里的**历史实测**。
   本次审计**没有**跑浏览器性能剖析，阶段 4 前必须重新建立基线。
2. **未在浏览器里逐步复现卡顿**：结论来自代码结构分析（全量重建 + 90 个 commit 点）。
3. **`make()` 执行是在 Node 沙箱里、用浏览器桩跑的**，与真实 Chrome 行为可能有差异
   （但只用于拿节点形状，不涉及渲染）。
4. **App 侧未运行**：App 行为结论来自源码阅读（`NodeTreeRenderer.kt` / `NodeStateResolver.kt`），
   未在设备上复验 `--` 的实际显示。
5. **未评估工作量**：本报告只给阶段划分，不给工期。
6. **`assets/builtin-data-*.js`（1.19 MB）未审计**：那是素材数据，不在本次范围。
7. **`studio.css`（45 KB）未审计**：样式层不在本次范围。

---

## 十四、结论

1. **系统性判断成立**：控件库/属性面板/数据模型三者缺少共同抽象，
   导致"加一个能力改五处"的结构，六个痛点同源。
2. **最硬的两个数字**：控件库 **200 条里 152 条是图片节点**（76%）；
   核心代码 **15 个文件里 10 个在同一个循环依赖里**。
3. **13 灯问题定性更精确了**：不是"缺数据源"，是 **12 个别名连工具自己都没定义**（纯占位符），
   运行时会显示 `--` 而不是消失。
4. **19 灯素材复用问题已不存在**（v2.91.0 已修），剩下的是**新旧路径双轨兼容**，是约束不是缺陷。
5. **方案风险可控**：新架构不改设计文件格式、不改字段名，只加"分组 + 校验 + 生成"层。
6. **建议路径**：阶段 1（解环，零观感变化）→ 阶段 2（旁路 Registry + 双写对比）→
   阶段 3（库重组）→ 阶段 4（面板增量 + 性能）。

**本阶段结束，等待下一阶段开发指令。未修改任何源码。**
