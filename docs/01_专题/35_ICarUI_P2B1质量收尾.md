# ICarUI P2B.1：控件库质量收尾与 P3 迁移准备

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P2B1` |
| 基线 | P2B `c0b4210` |
| 结论 | 5 个关键逻辑问题全部修复；端到端拖拽实测通过；**4746 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；215 key 全保留 |

---

## 一、问题根因（P2B.1 第一部分）

### 1.1 三个报告的"矛盾"逐一查清

| 报告的现象 | 根因 | 定性 |
|---|---|---|
| `gauge_0` 一处 L1、一处 L3 | **不是矛盾**：`availability`（通道在 App 有无实现）= L1；`vehicleAvailability`（车辆能否提供）= unverified | 两概念混用 → **拆分三字段** |
| L4 统计 28，UI 只标 13 | **15 个 `next_*` 被误判**：它们是 `group` 节点，**根节点没有 pid**，pid 在子节点（仪表）上。旧逻辑只看根 → 判成"无数据/L4" | **真 bug** |
| 15 个 `next_*` 数据能力 | 同上，全部被误判为 `bound`/L4 | **真 bug** |

### 1.2 修复：复合节点必须分析子节点

新增 `analyzeDataOf(node)`：自身无 pid 时递归子节点收集通道。

```
修复前: next_speed_oem  dataCapability=bound  availability=L4   ← 误判
修复后: next_speed_oem  dataCapability=composite  availability=L1  childChannels=[std_0D]
```

**统计变化**：

| 指标 | 修复前 | **修复后** |
|---|---|---|
| L1 | 35 | **50**（+15 个 next_*） |
| L4 | **28** | **13**（= UI 标记数，一致） |
| `next_*` 能力 | `bound` | **`composite`** |

### 1.3 三字段方案（保留旧字段）

按要求新增，**旧字段全部保留**：

| 新字段 | 取值 | 与旧字段关系 |
|---|---|---|
| `channelStatus` | `implemented` / `alias-only` / `unimplemented` / `unknown` / `n/a` | 由 `availability` 映射 |
| `vehicleStatus` | `supported` / `unsupported` / `unverified` | 由 `vehicleAvailability` 映射 |
| `dataCapability` | `none` / `bound` / `state` / **`composite`** | 新增 `composite` |
| `availability`（旧） | `L1`~`L4`/`n/a` | **保留** |
| `vehicleAvailability`（旧） | `implemented`/... | **保留** |

**最终分布**：

| channelStatus | 数量 | | vehicleStatus | 数量 |
|---|---|---|---|---|
| n/a | 149 | | unverified | 202 |
| implemented | 50 | | unsupported | 13 |
| unimplemented | 13 | | supported | **0** |
| alias-only | 3 | | | |

> `supported` = 0 是**正确且诚实**的：本轮没有任何真车证据，不能声称"车辆支持"。

### 1.4 一致性守卫与诊断清单

新增两个 API：

| API | 作用 |
|---|---|
| `Catalog.report(filter)` | **逐 key 诊断清单**，含三字段 + 旧字段 + 通道 |
| `Catalog.checkConsistency()` | **一致性守卫**：统计 vs 逐条计数、字段组合合法性、新旧字段不漂移 |

`checkConsistency()` 的 5 类检查：
1. `byChannelStatus` 统计 == 逐条计数
2. 三字段取值合法
3. `dataCapability=none` 不该有 channel 状态
4. `unimplemented` 必须对应 `unsupported`
5. 旧 `availability` 与新 `channelStatus` 不冲突

**实测：`checkConsistency() = {ok: true, issues: []}`**

---

## 二、初始化逻辑修复（第二部分）

### 2.1 问题

```js
// P2B 原写法（错）
try { init(); }
finally {
  window.__ICAR_APP_READY = true;     // ← 无条件！init 抛异常也变成"就绪"
  Catalog.onAppReady();
}
```

后果：`init()` 抛异常时目录也会"就绪" → 异常被吞成空目录/半截目录，**无法诊断**。

### 2.2 修复

```js
try {
  init();
} catch (e) {
  window.__ICAR_INIT_ERROR = e.stack || e.message;   // 保留原始异常
  window.__ICAR_APP_READY = false;                   // 不置就绪
  Catalog.onInitFailed(window.__ICAR_INIT_ERROR);    // 交给诊断链
  throw e;                                            // 继续抛出，不静默
}
window.__ICAR_APP_READY = true;
Catalog.onAppReady();
```

新增 `Catalog.onInitFailed(err)`：记录 `_initError`，`diagnose()` 报 `code: "init-error"` 并**保留原始异常文本**。

### 2.3 场景验证（均在测试中）

| 场景 | 结果 |
|---|---|
| 正常初始化 | `__ICAR_APP_READY=true`、`__ICAR_INIT_ERROR=null` ✅ |
| 模拟初始化失败 | `diagnose().ok=false`、含 `init-error`、**保留原始错误文本** ✅ |
| 恢复 | `recover()` 清除失败态，`diagnose().ok=true` ✅ |
| 重复构建 | 三次 `build()` 后仍是 215、设计不变 ✅ |
| 切换设计文件 | `recover()` 后新设计 `assets` 未被污染 ✅ |

---

## 三、UI 端到端测试（第三部分）

### 3.1 关键发现：拖拽 MIME 用错了

P2B 里新面板用 `text/control-key` —— **画布 drop 处理器根本不认**（`panels.js:1992` 认的是 `application/x-ctrl`）。
所以 P2B 阶段的"拖拽"**实际是不工作的**，只验证了 `dataTransfer` 设置（当时就标注了"未端到端验证"）。

**修复**：改用真实 MIME：

| 条目类型 | MIME | 画布处理 |
|---|---|---|
| 控件 / 预设 | `application/x-ctrl` | `c.make()` → `dropControlAt()` |
| 素材 | `application/x-asset` | `addImageNode(assetId)` |

### 3.2 真实落画布验证（21 条断言）

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 拖文字控件（`t_label`）到画布 | ✅ 节点创建，`type=text` |
| 2 | 拖组合预设（`gauge_0`）到画布 | ✅ 节点创建，`type=gauge` |
| 3 | 拖 PNG 素材到画布 | ✅ 节点创建，`type=image` |
| 4 | 坐标 / 尺寸 / 图层 | ✅ x/y/w/h/z 全为有限值、w/h>0、id 唯一 |
| 5 | 选中后属性面板 | ✅ 渲染出内容、含"变换/位置" |
| 6 | 撤销 / 重做 | ✅ `doUndo()` 3→2、`doRedo()` 2→3 |
| 7 | 保存 / 重新载入 | ✅ 0 错误、节点数一致 |
| 8 | 搜索/切分类不改设计 | ✅ 节点 id/x/y/w/h 签名不变 |

> 补充：撤销的真实入口是 `window.doUndo` / `window.doRedo`（第一次误用 `window.undo`，该 API 不存在）。

---

## 四、左侧面板布局（第四部分）

### 4.1 方案：新面板为主入口 + 旧面板默认折叠

| 项 | 处理 |
|---|---|
| 新 `#catalog` | **主资源入口**（三入口、搜索、分类） |
| 旧 `#assets` | **默认折叠**，标题栏的 `▤` 按钮可随时展开（经典视图） |
| 旧 `#tree` | **完整保留**，不受影响 |

实现：复用旧面板已有的 `panelCollapsed` 机制，**不改旧面板渲染代码**。

### 4.2 三宽度实测

| 宽度 | catalog | 条目数 | 入口数 | 旧 assets 高 | 旧 tree 高 |
|---|---|---|---|---|---|
| 1024px | 250×206 | 82 | 3 | 154 | 120 |
| 600px | 580×218 | 82 | 3 | 162 | 120 |
| 390px | 370×218 | 82 | 3 | 162 | 120 |

三种宽度下面板可见、条目完整、入口齐全、旧面板保留。

截图：`stage/p2b1-w1024.png` / `p2b1-w600.png` / `p2b1-w390.png`

---

## 五、Catalog 副作用核查（第五部分）

### 5.1 实测：144 / 215 条 `make()` 会写 `design.assets`

逐条测量（调 `make()` 前后比对 `design.assets.length` / `nodes.length`）：

| 类别 | 数量 | 副作用 |
|---|---|---|
| **有副作用** | **144** | `design.assets` +1（素材类与 `next_*` 都会登记底板/图片） |
| 无副作用 | 71 | — |
| `nodes` 变化 | 0 | 无一条会改节点数组 |
| 选中变化 | 0 | 无一条会改 selection |

**副作用面比预期大得多**（P2B 只标注了"素材类会写"，实测 `next_*` 也写）。

### 5.2 现有隔离机制有效

`build()` 的**整轮快照/恢复**：

```
还原后 assets 一致: true
nodes 未变: true
selection 未变: true
rebuild keeps serialized design identical: true
```

### 5.3 残余风险与隔离方案

| 风险 | 说明 |
|---|---|
| 快照只覆盖 `assets` | 若未来有条目写**别的**状态（如 `controls` / `themeColors`），当前快照不覆盖 |
| 144 条依赖快照 | 声明迁移后才能真正消除 |

**P3 隔离方案**（建议）：
1. 迁移到声明后，`make()` 只在**用户实际拖拽**时调用
2. 探测阶段完全停止（`source` 全为 `declared`）
3. 中间态可给 `make()` 加"只读模式"包装（临时冻结 `design.assets`）

---

## 六、P3 迁移准备（第六部分）

### 6.1 修正：`box_h1`/`box_h2`/`box_note` 属于**文字族**

P2B.1 明确指出：这三条虽然前缀是 `box_`（像容器），但 `make()` 产出的是 **`text` 节点**。

实测确认（P2A 已有反例断言）：

| key | 前缀暗示 | 实际 `make()` 产出 |
|---|---|---|
| `box_h1` | 容器 | **`text`** |
| `box_h2` | 容器 | **`text`** |
| `box_note` | 容器 | **`text`** |

→ 归入**文字族**，不是容器族。

### 6.2 重新制定的迁移顺序

| 阶段 | 内容 | 数量 | 依据 |
|---|---|---|---|
| **P3A** | **文字族（全部 12 条）** | 12 | `text`、`t_title`、`t_label`、`t_unit`、`t_big`、`t_small`、`t_warn`、`t_ok`、`t_bigunit`、**`box_h1`**、**`box_h2`**、**`box_note`** |
| **P3B** | 容器族（4 条） | 4 | `group`、`box_card`、`box_row`、`box_col` |
| P3C | 常用仪表 | 6 | `g_speed`/`g_coolant`/`g_fuel`/`g_volt`/`g_load`/`g_throttle` |
| P3D | 状态灯 | 19 | 含 `statePid` 静态声明 |
| P3E | 轨道族 | 28 | `cd_*` |
| P3F | `next_*` 参数化 | 15 | 5×3 → 1 定义 + 15 声明 |
| P3G | 素材族 | 104 | `img_*`/`bar_*` |

**P2B.1 完成后进度**：`declared 8 / probe 207`（仅 `gauge_0..7`）。

### 6.3 关键区分：元数据声明 ≠ Registry 接管创建

这是 P3 必须分清的两层：

| 层 | 做什么 | 现状 |
|---|---|---|
| **① Catalog 元数据声明**（`CatalogMeta.declare`） | 只解决**分类与探测**：告诉 Catalog "这条是什么"，避免调 `make()` | `gauge_0..7` 已完成 |
| **② Control Registry 接管创建**（`ControlRegistry.define`） | 真正**接管控件创建**：`build()` 产出节点，旧 `BUILTIN_CONTROLS` 改为从 Registry 读 | 仅 `t_label` 试点（P1A） |

**P3A 的目标是两层都做**（对 12 个文字条目）：
1. `CatalogMeta.declare` 全部 12 条 → 零探测
2. `ControlRegistry.define` 全部 12 条 → `build()` 与旧 `make()` 逐字段相等
3. 旧入口改为**从 Registry 读**（保持同一个 key）

### 6.4 最终目标：一个定义驱动两套入口

```
ControlRegistry.define({ key, build, schema, slots, render, legacyKey })
        │
        ├──→ 旧入口 BUILTIN_CONTROLS.find(key).make()   （兼容适配器包装 Registry.build）
        └──→ 新入口 Catalog/UI                          （直接读 Registry）
```

这样就**不会长期维护两份实现**。

---

## 七、修改清单

### 修改（4）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/registry/catalog.js` | `analyzeDataOf`（复合分析）、三字段、`report()`、`checkConsistency()`、`onInitFailed()`、composite 可用性、顺序修正 |
| `tools/icarui/js/app.js` | `bootAfterInit` 失败路径不再无条件置 ready，保留原始异常 |
| `tools/icarui/js/ui/catalog-panel.js` | 三态徽标、composite 标识、`collapseLegacy`/`toggleLegacy`、**拖拽 MIME 修正** |
| `tools/icarui/index.html` | 初始化时折叠旧面板 |

### 新增（1）

| 文件 | 说明 |
|---|---|
| `tools/icarui/tests/verify-p2b1-e2e.js` | 49 条断言（端到端 + 三字段 + 初始化失败 + 副作用） |

### 修改（测试）

| 文件 | 改动 |
|---|---|
| `tools/icarui/tests/verify-p2a-catalog.js` | L1 35→50、L4 28→13（复合修正的必然结果，附理由） |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 未改动（关键）

- `app/`、`icar.ui/2`、`BUILTIN_CONTROLS`
- `presets.js` / `panels.js` / `model.js` / `schema.js` / `canvas.js`

---

## 八、测试结果

| 层 | P2B | **P2B.1** |
|---|---|---|
| 套件 | 39 | **40** |
| 断言 | 4696 | **4746** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | 1365 项 0/0/0 |

基线变更（官方流程）：
```
↑ verify-p2a-catalog    53
+ verify-p2b1-e2e       新增 49
合计 40 个套件 / 下限之和 4743
```
**全部为增加，无一条下降。**

---

## 九、残余风险

| # | 风险 | 级别 |
|---|---|---|
| R1 | **144/215 条 `make()` 有副作用**，靠快照保护 | 中 |
| R2 | 快照只覆盖 `design.assets`，未覆盖其它状态 | 中 |
| R3 | `ext` 透传仍未实施 | **高** |
| R4 | `vehicleStatus` 全部无真车证据（`supported=0`） | **高** |
| R5 | 207/215 仍走探测 | 中 |
| R6 | 截图未人工判读（AI 无图像输入） | 中 |
| R7 | 拖拽已验证落画布，但**真实鼠标拖动**（含 dragover/dragleave）未测 | 中 |

---

## 十、下一阶段 P3A 执行方案（文字族 12 条）

### 10.1 范围

`text`、`t_title`、`t_label`、`t_unit`、`t_big`、`t_small`、`t_warn`、`t_ok`、`t_bigunit`、`box_h1`、`box_h2`、`box_note`

### 10.2 每条的验收步骤（固定四步）

1. `CatalogMeta.declare(key, {...})` —— 静态元数据（含 `nodeType: "text"`）
2. `ControlRegistry.define({ key, legacyKey, build, schema, slots: [], render: {mode:"text"}, validate })`
3. **等价验证**：`LegacyAdapter.compare(key)` 必须 `ok: true`（新旧序列化逐字段相等）
4. 跑 40 套件 + 断言数不减

### 10.3 完成判据

- `verifyCoverage()` 仍 215/215
- `source.declared` 从 8 → **20**
- `checkConsistency()` 仍 `ok: true`
- 12 条 `compare()` 全部 `ok`
- 40 套件全绿

### 10.4 特别注意

- **`box_h1`/`box_h2`/`box_note` 的分类必须是 `文字`**（不是 `容器与组合`）—— 与 `make()` 实际产出保持一致
- 它们的 `category` 需从 P2A 的自动分类结果核对，避免声明与探测不一致（`checkConsistency` 会抓）
