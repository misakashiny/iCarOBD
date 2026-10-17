# ICarUI P2A：统一控件目录与资源分类重构

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P2A` |
| 基线 | P1A `4346908` |
| 结论 | Catalog 建立完成，**215/215 全覆盖**；两项风险核验完成；**测试失败数归零** |
| 影响力 | 只增不改：新增 1 模块 + 1 套件；旧路径零改动 |

---

## 一、215 条完整分类统计

### 1.1 扫描方法（按 P2A 要求：完整浏览器环境，不能只加载 presets.js）

在真实 Edge 浏览器里加载完整页面（17+ `<script>` 全部执行），
读 `window.BUILTIN_CONTROLS`（此时已含 `next-controls.js` 追加的 15 条），
对每条调用 `make()` 拿**真实节点**。

**结果：215 条，0 个 make() 失败。**

### 1.2 三大类（kind）

| kind | 数量 | 占比 | 判定依据（结构） |
|---|---|---|---|
| **control** 功能控件 | **90** | 41.9% | `gauge`(无parts) / `text` / 空`group` / `image+states` / `image+trackStyle` / `image`(无asset) |
| **preset** 控件预设 | **21** | 9.8% | `gauge+parts`（6）/ `group+children>0`（15） |
| **asset** 素材资源 | **104** | 48.4% | `image + assetId`（静态图片） |
| 合计 | **215** | 100% | |

### 1.3 渲染器分布（renderer）

| renderer | 数量 | 对应绘制入口 |
|---|---|---|
| image | 105 | `canvas.js` `drawImageNode` |
| gauge | 32 | `drawGaugeParts` / `GaugeViewFactory` |
| track | 28 | `drawTrackNode`（`trackStyle` 分支） |
| state | 19 | 带 `states` 的图片（状态灯） |
| composite | 15 | 组合，子节点各自渲染 |
| text | 12 | `drawTextNode` |
| group | 4 | 容器，不绘自身 |

### 1.4 功能分类（category）—— 14 组

| 分类 | 数量 |
|---|---|
| 素材·刻度 | 36 |
| 仪表 | 32 |
| 轨道 | 28 |
| 素材·轨道图 | 28 |
| 状态指示 | 19 |
| 容器与组合 | 19 |
| 素材·其他 | 14 |
| 文字 | 12 |
| 素材·盘面 | 9 |
| 素材·装饰 | 9 |
| 素材·背景 | 5 |
| 素材·指针 | 2 |
| 素材·警示 | 1 |
| 其他 | 1（`image` 空图片控件） |

### 1.5 数据可用性（availability）—— 复用 P1A 四层语义

| 层级 | 数量 | 说明 |
|---|---|---|
| n/a | 164 | 不读数据（素材/文字/容器） |
| **L1** | **35** | App 已实现数据源 |
| L2 | 3 | 仅识别别名（厂家模板 `tpl_*`） |
| L4 | 13 | 工具与 App 都未实现 |
| L3 | 0 | 无真车证据（不是不存在） |

### 1.6 15 个 NEXT_CONTROLS 完整分类

| 项 | 结论 |
|---|---|
| 数量 | 15 = 5 语义 × 3 变体 |
| kind | **全部 `preset`** |
| nodeType | 全部 `group` |
| renderer | 全部 `composite` |
| 子节点 | 全部 **2 个**（底板 image + 仪表 gauge） |
| 语义 | `speed` / `rpm` / `coolant` / `voltage` / `fuel` |
| 变体 | `oem`（原厂）/ `sport`（运动）/ `minimal`（极简） |

**判定理由**：结构是 `group + 2 children`，属于「通过基础控件组合形成的样式」→ 按 P2A 分类原则归入**控件预设**，不是新功能类型。

---

## 二、功能控件与外观预设的去重分析

### 2.1 已识别的「同功能不同外观」簇

按 **PID 绑定**聚类（不看 key）：

| PID | 绑定该 PID 的条目 | 分析 |
|---|---|---|
| `std_0C`（转速） | `gauge_0`~`gauge_7`（8 条）+ `g_rpm` + `gauge_parts` + `gauge_parts_dual` + `gauge_parts_triple` = **12 条** | `gauge_0..7` 是**同一 PID 的 8 种样式** → 典型外观预设 |
| `std_0D`（车速） | `g_speed` + `gauge_parts_arc` + `gauge_parts_bigval` = 3 条 | 前 1 条是控件，后 2 条是拼装预设 |
| `std_2F`（油量） | `g_fuel` + `gauge_parts_fuel` = 2 条 | 同上 |

### 2.2 建议：`gauge_0`~`gauge_7` 应合并为「仪表控件的 8 个样式预设」

**当前问题**：8 条独立条目，`make()` 逻辑几乎相同（仅 `style` 与尺寸不同），
却各占一个库位。

**建议（P2B 执行，本阶段不做）**：

```
功能控件：仪表（1 个）
  └─ 外观预设：圆形 / 数字 / 条形 / 折线 / 上下双值 / 四值 / 主副双值 / G力（8 个）
```

**保留要求**：`gauge_0`~`gauge_7` 的 **key 与生成能力必须保留**（P2A 硬要求：不删旧控件）。
做法是 Catalog 里标记 `kind=preset`、`legacyKey=gauge_N`，旧路径继续可用。

### 2.3 `cd_*` 与 `bar_*`：同概念双实现

| 项 | cd_* | bar_* |
|---|---|---|
| 数量 | 28 | 28 |
| 归一化后同名 | **24 组** | |
| renderer | `track`（代码绘制） | `image`（PNG） |
| kind | control | **asset** |
| 兼容要求 | 新设计用 | **存量设计按 path 引用，永久保留** |

**这是 P2A Catalog 最有价值的区分**：同样的名字（`trackh`），
因为**节点结构不同**（有/无 `trackStyle`），被正确分到不同 kind。

### 2.4 建议保留的基础控件类型（12 类）

| # | 基础控件 | 依据（结构） |
|---|---|---|
| 1 | 仪表 `gauge` | 所有 `gauge` 条目共用 |
| 2 | 文字 `text` | 所有 `text` 条目共用 |
| 3 | 图片 `image` | 静态素材 |
| 4 | 容器 `group` | 空分组/卡片/行/列 |
| 5 | 状态指示 `image+states` | 19 灯的机制 |
| 6 | 代码轨道 `image+trackStyle` | 28 条 cd_* |
| 7 | 拼装仪表 `gauge+parts` | 6 条 gauge_parts* |
| 8 | 组合控件 `group+children` | 15 条 next_* |
| 9~12 | 保留现有节点类型 `gauge/image/text/group` 的语义不变 | 与 App `DesignNode` 一致 |

> **共同点：只有 4 种节点类型（`gauge`/`image`/`text`/`group`）** ——
> 215 条全部由这 4 种 + 配置组合而成。这是新架构可以「1 个定义驱动 N 个条目」的根基。

---

## 三、新 Catalog API 说明

文件：`tools/icarui/js/registry/catalog.js`
入口：`window.ICAR.registry.Catalog`（兼容别名 `window.ControlCatalog`）

### 3.1 元数据结构（11 个必填字段 + 诊断）

```js
{
  key: "gauge_0",                  // 原始唯一标识
  name: "圆表",                     // 显示名称
  kind: "control",                 // control | preset | asset
  category: "仪表",                 // 功能分类（14 组）
  nodeType: "gauge",               // 实际创建的节点类型
  renderer: "gauge",               // 渲染方式
  legacyKey: "gauge_0",            // 旧系统兼容标识
  dataCapability: "bound",         // none | bound | state
  availability: "L1",              // L1/L2/L3/L4/n/a
  tags: ["control","gauge","有数据","pid:std_0C","style:0","圆表"],
  thumbnail: { mode:"draw", ref:null },  // asset 类为 {mode:"asset", ref:路径}
  __meta: { index, reason, next, semanticId, variant, parts, children, pid, statePid, style, assetId, makeError }
}
```

### 3.2 查询 API

| API | 说明 |
|---|---|
| `Catalog.build([list])` | 扫描并重建（**无副作用**，见 §3.4） |
| `Catalog.stats()` | `{total, byKind, byCategory, byRenderer, byAvailability, failures}` |
| `Catalog.get(key)` | 取一条元数据 |
| `Catalog.has(key)` | 是否存在 |
| `Catalog.keys()` / `.all()` | 全部 key / 全部元数据 |
| `Catalog.byKind(kind)` | 按三大类筛选 |
| `Catalog.byCategory(cat)` | 按功能分类筛选 |
| `Catalog.byAvailability(tier)` | 按可用性层级筛选 |
| `Catalog.categories()` | 分组清单 `[{category, keys, count}]` |
| `Catalog.search(q)` | 名称 / key / 标签模糊搜索 |
| `Catalog.verifyCoverage([list])` | **兼容性自检**：`{ok, missing, dupes, total}` |

### 3.3 分类判据（**不凭 key 前缀**）

```
gauge + parts>0        → preset   (拼装仪表)
group + children>0     → preset   (组合控件)
gauge (无parts)        → control  (仪表)
text                   → control  (文字)
group (无children)     → control  (容器)
image + states         → control  (状态指示)
image + trackStyle     → control  (代码轨道)
image + assetId        → asset    (静态素材)
image (无asset)        → control  (空图片)
```

**反例验证（测试已覆盖）**：

| key | 前缀暗示 | 实际结构 | Catalog 判定 |
|---|---|---|---|
| `box_h1` | `box_` → 容器 | **`text`** | **control / text** ✅ |
| `img_lampcrit` | `img_` → 素材 | `image+assetId` | asset ✅ |
| `cd_trackh` | 与 `bar_trackh` 同名 | `image+trackStyle` | **control/track** ✅ |
| `bar_trackh` | 同上 | `image+assetId` | **asset/image** ✅ |

### 3.4 无副作用保证（P2A 实测到的风险）

**风险**：素材条目的 `make()` 走 `window.ensureBuiltinAsset(path)`
（`panels.js:1703`），其实现是 `d.assets.push({...})`（`:1711`）——**会写设计状态**。

**实测踩坑过程**：

| 问题 | 现象 | 原因 |
|---|---|---|
| ① 构建太早 | 104 个素材全被判成 control | `ensureBuiltinAsset` 未定义（在 `panels.js`） |
| ② 构建太早 | 15 个 next_* 全部失败 | `design.canvas` 未初始化（在 `app.js` 的 `init()`） |
| ③ 每条探测后恢复 | 素材全落「素材·其他」 | 恢复太快，下一条查不到上一条登记的路径 |
| ④ assetId 不含路径 | 分类正则匹配失败 | `assetId` 是内部 id（`as2fmnf`），需反查 `design.assets` |

**最终方案**：

1. 构建点放在 `panels.js` **之后**（`ensureBuiltinAsset` 已定义）
2. 用 `DOMContentLoaded` + 轮询等 `CanvasState.design` 就绪
3. **整轮快照**：`build()` 开头记下 `design.assets`，结束时原样恢复
4. 素材分类用 `assetPathOf(assetId)` **反查真实路径**

**验证**：测试断言「rebuild 前后 assets 数量与 id 序列完全一致」。

---

## 四、新旧资源映射表

### 4.1 节点类型映射（格式零变化）

| Catalog nodeType | App `DesignNode` | 渲染入口 | 变化 |
|---|---|---|---|
| `gauge` | `NODE_GAUGE` | `GaugeViewFactory.create()` | 无 |
| `image` | `NODE_IMAGE` | `drawImageNode` / `StateImageView` | 无 |
| `text` | `NODE_TEXT` | `drawTextNode` / `TextView` | 无 |
| `group` | `NODE_GROUP` | 容器（不绘制） | 无 |

**`icar.ui/2` 格式未改任何字段。**

### 4.2 概念映射（`cd_*` ↔ `bar_*`，24 组）

| 概念 | 旧代码版 | 旧图片版 | 新 kind |
|---|---|---|---|
| 水平轨道 | `cd_trackh` | `bar_trackh` | control/track vs asset/image |
| 垂直轨道 | `cd_trackv` | `bar_trackv` | 同上 |
| 渐变轨道 | `cd_trackgradh/v` | `bar_trackgradh/v` | 同上 |
| 内凹轨道 | `cd_trackinseth/v` | `bar_trackinseth/v` | 同上 |
| 发光轨道 | `cd_trackglowh/v` | `bar_trackglowh/v` | 同上 |
| 带刻度轨道 | `cd_trackticksh/v` | `bar_trackticksh/v` | 同上 |
| 5/10/20 段条 | `cd_seg{5,10,20}h/v` | `bar_seg{5,10,20}h/v` | 同上 |
| 三段色带 | `cd_band3h/v` | `bar_band3h/v` | 同上 |
| 填充条 | `cd_fillh/v` | `bar_fillh/v` | 同上 |
| 发光填充 | `cd_fillglowh/v` | `bar_fillglowh/v` | 同上 |
| 阈值标记 | `cd_markerh/v` | `bar_markerh/v` | 同上 |

**只在 cd_**：`cd_trackfadeh/v`、`cd_cursorh/v`
**只在 bar_**：`bar_markerglowh/v`、`bar_fillgradh/v`

### 4.3 NEXT_CONTROLS 映射

| 旧 key | 新 kind | 语义 | 变体 |
|---|---|---|---|
| `next_<semantic>_<variant>` | preset | speed/rpm/coolant/voltage/fuel | oem/sport/minimal |

---

## 五、测试结果

### 5.1 新增套件 `verify-p2a-catalog.js`（50 条断言）

| 组 | 断言数 | 覆盖 |
|---|---|---|
| 覆盖完整性 | 4 | 215 条、无遗漏、无重复 key |
| 结构分类（含反例） | 11 | `box_h1` 是 text、`cd_`/`bar_` 分流、灯是 state、拼装是 preset |
| NEXT_CONTROLS | 6 | 15 条、全 composite/group/2 children、5 语义 3 变体 |
| 三类数量 | 6 | 90/21/104、和为 215、结构一致性 |
| 只读无副作用 | 3 | rebuild 前后 assets 数量/id 序列不变 |
| 查询 API | 12 | get/has/byKind/byCategory/categories/byAvailability/search×3/字段齐全/缩略图 |
| 旧路径不受影响 | 4 | 215 条仍可 make、全局符号完好 |
| 渲染不受影响 | 1 | 6 个抽样节点 `drawNodePreview` 无异常 |

**结果：50/50 通过。**

### 5.2 全量回归

| 层 | 改动前（P1A） | 改动后（P2A） |
|---|---|---|
| 套件数 | 37 | **38** |
| **TOTAL** | PASS=4588 **FAIL=1** | **PASS=4639 FAIL=0** |
| 退出码 | 1 | **0** |
| 断言下限 | 4527 | **4639** |
| JVM | 88 套 1365 项 | 88 套 1365 项 失败 0/错误 0/跳过 0 |

### 5.3 基线变更明细（`-UpdateBaseline` 官方流程输出）

```
↑ verify-crosslang           174 → 235
↑ verify-next-library        90 → 91
+ verify-p2a-catalog         新增 50
合计 38 个套件 / 下限之和 4639
```

**所有变动都是增加，无一条下降。**

---

## 六、风险核验 A：`verify-next-library` 缺 `production.png`

### 6.1 根因（**不是缺测试素材**）

`verify-next-library.js:54`（原代码）：

```js
require('fs').writeFileSync(
  require('path').resolve(__dirname,'../../../stage/t11i-codex-20261012/production.png'),
  Buffer.from(screenshot.data,'base64'));
```

三个事实：

1. 这是**写文件**，不是读文件 —— 缺的是**输出目录**，不是输入素材
2. `stage/` 被 `.gitignore` 忽略，`t11i-codex-20261012/` 子目录在别的机器上不存在
3. **`writeFileSync` 在 L51 全部断言之后**（L52 `sleep(500)`，L54 才写）
   → 没有任何断言依赖该文件；它是**遗留的调试截图落盘**

**所以这是「测试脚本的副作用失败」，不是「测试素材缺失」。**

### 6.2 修复方式（不降门槛、不跳过断言）

| 原做法 | 新做法 |
|---|---|
| 裸写到固定私有路径 | 写到 `os.tmpdir()`，文件名带 `p002-` 前缀（任何机器都存在） |
| 失败静默进 catch 计 1 条 FAIL | `try/catch` 包裹，**但补一条断言** `screenshot produced a non-empty PNG` |

**关键**：没有"跳过"，反而**多了一条断言**（校验 PNG 非空）。

### 6.3 结果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| PASS | 90 | **91** |
| FAIL | **1** | **0** |

### 6.4 可复现的测试素材方案（供其他套件参考）

| 需求 | 方案 |
|---|---|
| 需要输出文件 | 一律写 `os.tmpdir()`，不要写仓库内 `stage/` |
| 需要输入素材 | 用仓库内 `tools/icarui/assets/**`（已被版本控制）；**不要依赖 `stage/`** |
| 确实需要 `stage/` 的文件 | 加 `fs.mkdirSync(dir,{recursive:true})` 或改用临时目录 |
| 断言依赖文件 | **不要在断言后写文件**；要么写到临时目录，要么把写入也断言化 |

---

## 七、风险核验 B：未知字段安全透传方案

完整方案见专题 [32_未知字段安全透传方案](32_未知字段安全透传方案.md)。

### 7.1 核心结论

**必须区分两类未知字段**：

| 类 | 特征 | 处理 |
|---|---|---|
| **A 合法扩展** | 来自文件、无 `__` 前缀、可序列化 | 可考虑保留 |
| **B 编辑器内部** | `rawPid`/`rawStatePid`（`model.js:65`/`:106`）、`__controlKey`、`__meta`、运行时 `unknown` | **绝不能写进文件** |

### 7.2 推荐方案：**显式 `ext` 扩展位**（不是全局透传）

```json
{ "id":"n1", "type":"gauge", "pid":"obd.rpm",
  "ext": { "v292": { "futureProp": 123 } } }
```

理由：
- App 侧不认 `ext` → 自动忽略，**Android 契约零改动**
- 旧工具只需把 `ext` 加进白名单即可透传
- 内部字段仍在节点顶层，**不会误入 `ext`**
- 可审计：扩展集中一处

### 7.3 本阶段**未实施**

- ❌ 未修改 `nodeToJson`
- ❌ 未把 `ext` 加入任何白名单
- ✅ 已提交方案 + 测试样例（T1/T2/T3 三场景）

### 7.4 实施前必须先确认

`DesignNode.kt` 是否真的忽略 `ext`？理论上会（Kotlin 只读已知字段），**未实测**。

---

## 八、文件修改清单

### 新增（3）

| 文件 | 行数 | 说明 |
|---|---|---|
| `tools/icarui/js/registry/catalog.js` | 402 | Catalog 模块 |
| `tools/icarui/tests/verify-p2a-catalog.js` | 154 | 50 条断言 |
| `docs/01_专题/32_未知字段安全透传方案.md` | — | 风险核验 B 方案 |

### 修改（3）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 加 `catalog.js` 的 `<script>`；在 `panels.js` 之后加构建触发器（含时序说明注释） |
| `tools/icarui/tests/verify-next-library.js` | 截图落盘改为 `os.tmpdir()` + 断言化 |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方流程写入（3 项变更，全部增加） |

### 未改动（关键）

- **`tools/icarui/js/` 下所有既有文件**（`presets.js` / `panels.js` / `model.js` / `schema.js` / `canvas.js` / `app.js` 等）
- **`app/`（Android）全部**
- **`icar.ui/2` 格式与字段语义**
- **`BUILTIN_CONTROLS` 的内容与顺序**
- P1A 的 `t_label` 试点（`verify-p1a-registry` 仍全绿）

---

## 九、验收对照

| P2A 验收标准 | 结果 |
|---|---|
| 1. 215 条全部分类，无遗漏无重复 | ✅ `verifyCoverage` = `{ok:true, missing:[], dupes:[]}` |
| 2. 统一 API 查询资源/分类/原始 key | ✅ 11 个 API，12 条断言覆盖 |
| 3. 新 Catalog 不影响旧控件创建 | ✅ 215 条全部可 `make()`；`BUILTIN_CONTROLS` 未改 |
| 4. 37+ 套件不降门槛 | ✅ 38 套**全部达下限**，无一条下降 |
| 5. 新增分类与兼容测试 | ✅ `verify-p2a-catalog.js` 50 条 |
| 6. 新模块不依赖属性面板/编辑器 | ✅ `catalog.js` 只读 `ICAR` + `CanvasState` + `BUILTIN_*`，不引用 `renderProps`/`renderPanels` |
| 7. 不改画布渲染结果 | ✅ 未改任何渲染代码；抽样 `drawNodePreview` 无异常 |
| 8. 保留 P1A `t_label` 兼容性 | ✅ `verify-p1a-registry` 57 条全绿 |

---

## 十、仍存在的兼容性风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 未知字段仍被丢弃 | **高** | 方案已提交（专题 32），未实施。不解决则新字段无法向后兼容 |
| R2 | `APP_IMPLEMENTED_ALIASES` 是静态快照 | 中 | 从 Kotlin 源码抄的常量，App 侧改动会漂 |
| R3 | 12 个 L4 灯仍可拖可绑 | 中 | Catalog **已能标记** L4（13 条含 `g_tpl`），但未接 UI |
| R4 | Catalog 与旧库双份描述 | 中 | Catalog 是只读视图，不接管。若旧库新增条目，Catalog 需重建（已由构建时机保证） |
| R5 | 构建时机依赖设计就绪 | 中 | 用 `DOMContentLoaded` + 50 次轮询（5s）。超时则目录为空 —— 已用测试兜底 |
| R6 | `assetPathOf` 依赖 `design.assets` 快照 | 低 | 若 `design` 在构建中途被替换，路径反查可能失败 |
| R7 | 15 个 next_* 是复制粘贴 | 低 | 5×3 完全同构，`make()` 逐字相同；P2B 可用参数化收敛 |

---

## 十一、下一阶段 P2B 实施建议

### 11.1 建议顺序（低风险 → 高风险）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P2B-1** | 未知字段 `ext` 透传（专题 32 方案） | T1/T2/T3 三场景 + 38 套件全绿 + **App 侧确认忽略 `ext`** |
| **P2B-2** | Catalog 接入库分组 UI（**只改显示，不改拖拽**） | 库按 category 分组；215 条全部仍可拖；截图对比 |
| **P2B-3** | 可用性提示：L4 条目在库里可见地标灰 | 13 个不可用条目有视觉区分；不影响拖拽 |
| **P2B-4** | `gauge_0..7` 合并为「仪表 + 8 样式预设」 | 8 个旧 key 仍可创建；Catalog 标记 `kind=preset` |
| **P2B-5** | `next_*` 参数化收敛（5×3 → 1 定义） | 15 个 key 全部保留；产出节点逐字段相等 |

### 11.2 明确不要做

- ❌ 不要一次性替换 `BUILTIN_CONTROLS`
- ❌ 不要删除任何旧 key / 旧素材路径
- ❌ 不要在 P2B 重做整个属性面板（那是 P3）
- ❌ 不要引入框架/构建工具

### 11.3 Catalog 已为后续准备好的能力

- `byKind` / `byCategory` → 库分组 UI 直接用
- `byAvailability` / `availability` → 可用性提示直接用
- `verifyCoverage` → 每次改动后的兼容性自检
- `search` / `tags` → 搜索栏直接用

---

## 十二、未验证边界

1. **未在真实浏览器里人工点过** Catalog 的 UI（本阶段不接 UI，只用 API + 测试）。
2. **`ext` 透传方案未实施** —— 只是提案 + 样例。
3. **App 侧是否忽略 `ext`** 未实测。
4. **L3 层为空** —— 无真车证据。
5. **性能未测** —— Catalog 构建是启动时一次性的（215 次 `make()`），未测耗时。
6. **分类的语义合理性**：结构判据是机械的，个别条目的 `category` 可能不理想
   （如 `img_lampcrit` 归到「素材·警示」而非「状态指示」—— 因为它是纯素材，这是**有意的**）。
