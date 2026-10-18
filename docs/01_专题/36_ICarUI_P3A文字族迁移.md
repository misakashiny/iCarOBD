# ICarUI P3A：文字控件族正式迁移至 Control Registry

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P3A` |
| 基线 | P2B.1 `bfdb4a3` |
| 结论 | 12 个文字控件全部由 Registry 接管；**12/12 与独立 Golden 一致**；4826 断言 FAIL=0 |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`presets.js` 等五个核心文件零改动 |

---

## 一、迁移成果

### 1.1 12 个文字控件全部接管

| # | key | 旧实现位置 | Registry 状态 |
|---|---|---|---|
| 1 | `text` | `presets.js:146` | ✅ 本卡注册 |
| 2 | `t_title` | `presets.js:200` | ✅ 本卡注册 |
| 3 | `t_label` | `presets.js:201` | ✅ **P1A 已注册**，本卡跳过 |
| 4 | `t_unit` | `presets.js:202` | ✅ 本卡注册 |
| 5 | `t_big` | `presets.js:203` | ✅ 本卡注册 |
| 6 | `t_small` | `presets.js:496` | ✅ 本卡注册 |
| 7 | `t_warn` | `presets.js:494` | ✅ 本卡注册 |
| 8 | `t_ok` | `presets.js:495` | ✅ 本卡注册 |
| 9 | `t_bigunit` | `presets.js:497` | ✅ 本卡注册 |
| 10 | `box_h1` | `presets.js:419` | ✅ 本卡注册（**归文字族**）|
| 11 | `box_h2` | `presets.js:420` | ✅ 本卡注册（**归文字族**）|
| 12 | `box_note` | `presets.js:421` | ✅ 本卡注册（**归文字族**）|

**族统计**：`total 12 / registered 11 / skipped 1`（`t_label`），**无重复注册**。

### 1.2 一个定义驱动两套入口

```
ICAR.registry.Control.define({ key, build, schema, slots, render, validate })
        │
        ├──→ 旧入口  BUILTIN_CONTROLS.find(key).make()  ← registry-bridge 运行时接线
        └──→ 新入口  ICAR.registry.Control.build(key)
```

`RegistryBridge.status()` 实测：

```json
{"bridged":[12 个 key],"fallback":[],"total":215}
```

**`fallback` 为空** = 12 条全部有 Registry 定义，没有一条回落到旧实现。

---

## 二、Golden Fixtures（第三部分：迁移前建立独立基准）

### 2.1 做法

**在任何替换之前**，把 12 个控件旧 `make()` 的完整输出抓下来，存为
`tools/icarui/tests/fixtures/p3a-text-golden.json`。

| 项 | 处理 |
|---|---|
| 排除字段 | **仅 `id`**（随机生成）|
| 保留字段 | `type`、`name`、`x/y/w/h`、`rotation`、`scale`、`alpha`、`z`、`text`、**`font` 全部 7 个子字段** |
| 确定性验证 | 先连调两次 `make()` 比对，**12 条全部 stable=true** 才落盘 |

### 2.2 为什么不能用 `__legacyMake` 做对照

要求明确："迁移后不得使用已被新 Registry 包装的旧函数作为唯一对比来源"。

`registry-bridge.js` 保留了 `entry.__legacyMake`（只读诊断用途），但
**测试一律用 `fixtures/p3a-text-golden.json`**，不用 `__legacyMake` ——
否则就是"新旧调同一个实现自证"。

### 2.3 Golden 抓出的两个真问题（这是本卡最有价值的部分）

**问题 A：`box_h1/h2/note` 的源码字面量具有欺骗性**

源码看起来是：

```js
{ key: "box_h1", text: "仪表盘", size: 30, color: "#CFE0EE", w: 200, h: 44 }
```

但旧实现是 `createNode(NODE_TEXT, { fontSize: d.size, color: d.color, ... })` ——
**不传 `font` 对象**，而 `createNode` 对 `NODE_TEXT` 只做 `normalizeFont(o.font)`：

```js
font: window.normalizeFont(o.font)   // o.font 是 undefined
```

`normalizeFont(undefined)` → 整个落到 `FONT_DEFAULT`：

```js
FONT_DEFAULT = { size: 6, weight: 400, align: "left", color: "#E8EEF7", ... }
```

**所以 `box_h1` 实际产出 `font.size=6 / weight=400`，而不是源码写的 30/700。**
`fontSize` 与 `color` 全被忽略。

> **如果按源码字面量"照抄"，12 条里会有 4 条错。** 这正是要求三强调
> "迁移前建立独立旧版基准"的价值 —— 我第一版就是照字面抄的，
> Golden 一比对立刻暴露 4 条不一致。

**问题 B：`t_bigunit` 的字重**

源码 `weight: 500`，但实际产出 `weight: 400`（`normalizeFont` 的合法值表里
`500` 是合法的，所以这里是我抄错而非归一化问题）—— 同样被 Golden 抓出。

### 2.4 最终结果

```
与 Golden 一致: 12/12
```

---

## 三、Registry 定义（第四部分）

每条包含要求中的全部要素：

| 要素 | 字段 | 说明 |
|---|---|---|
| 身份、名称及分类 | `key` / `name` / `category` | category 统一 `文字` |
| 默认配置与节点创建 | `build()` | 逐字段对齐旧实现 |
| 属性 Schema | `schema[]` | 文字内容、字号、字重、颜色、对齐、宽高 |
| 类型和数值校验 | `validate(node)` | 尺寸为 0 / 字号为 0 → warn |
| 渲染能力声明 | `render: { mode:"text", adapter:"drawTextNode" }` | |
| 新旧 key 映射 | `legacyKey` | |
| 数据槽 | `slots: []` | **文字控件不需要数据源** |

### Catalog 元数据从 Registry 派生

`catalog.js` 新增派生逻辑：

```js
const regDef = Control.get(c.key) || Control.byLegacyKey(c.key);
const derived = regDef ? { name, category, nodeType, renderer, kind } : null;
// 优先级：decl（CatalogMeta）> derived（Registry）> probe（make 探测）
```

**不再需要在 `CatalogMeta` 里重复手写一份**，避免两套配置漂移。

---

## 四、数据源语义修正（第五部分）

### 4.1 修正的错误推断

**原逻辑（错）**：

```js
entry.vehicleStatus = entry.channelStatus === "unimplemented" ? "unsupported" : "unverified";
```

这把「**App 未实现通道**」直接推断成「**车辆不支持**」。

### 4.2 修正后

```js
// 没有实车证据 → 一律 unverified。
// channelStatus=unimplemented 只说明 App 没做，推不出车辆有没有。
entry.vehicleStatus = "unverified";
```

**分布变化**：

| 值 | 修正前 | **修正后** |
|---|---|---|
| `unverified` | 202 | **215** |
| `unsupported` | 13 | **0** |
| `supported` | 0 | **0** |

> `unsupported=0` 与 `supported=0` 都是**正确的**：本轮没有任何实车证据，
> 两个方向都不能断言。将来接入真车验证后才有资格填这两个值。

### 4.3 静态文字控件

12 个文字控件的 `slots: []`（不需要数据源），
`vehicleStatus` 一律 `unverified`，**绝不会被标成"车辆不支持"**。
测试里对每个 key 单独断言了这一点。

### 4.4 兼容字段保留

`availability`（旧 L1~L4）与 `vehicleAvailability`（旧四档）**全部保留**，
测试断言 `C.get('t_label').availability !== undefined`。

### 4.5 一致性守卫同步修正

`checkConsistency()` 原来有一条「`unimplemented` 必须对应 `unsupported`」，
**这条规则本身就是错误推断的产物**，已删除。

改为反向守卫：

```
任何 unsupported / supported 都必须在有实车证据时才能出现；
当前无证据来源 → 两者数量必须为 0
```

---

## 五、架构与副作用（第七部分）

| 要求 | 实现 | 验证 |
|---|---|---|
| Catalog 获取元数据**不调用 make()** | 12 条由 Registry 派生（`derived`），不走探测 | `catalog rebuild does not touch design` ✅ |
| Registry **不依赖属性面板** | `text-family.js` 只读 `window.ICAR` + `createNode` | 无 `renderProps`/`renderPanels` 引用 |
| 创建控件**不修改无关设计数据** | `build()` 只产节点 | `toV2Json(design)` 前后一致 ✅ |
| 旧入口**不保留独立创建逻辑** | `registry-bridge` 运行时替换 `make` | `__bridgedTo===key` ✅ |
| 旧 key / 名称 / 行为兼容 | 12/12 Golden 一致 | ✅ |
| 不改变其它 203 条 | 未触碰 | `all 203 non-text still make()` ✅ |

### 初始化与恢复诊断

`Catalog.diagnose()` 现在会报 `init-error` 并保留原始异常；
`recover()` 清除失败态。测试覆盖：正常 / 模拟失败 / 恢复。

---

## 六、测试结果（第八部分）

### 6.1 新增验收套件 `verify-p3a-text-family.js`（80 断言）

| 组 | 断言数 | 覆盖 |
|---|---|---|
| 12 条全部接管 | 15 | bridged/fallback/missing + 每条 `byLegacyKey` |
| t_label 不重复 | 3 | `total 12 / skipped 1 / registered 11` |
| 定义字段齐全 | 12 | 每条 7 个要素 |
| 旧入口路由 | 12 | 每条 `__bridgedTo===key` |
| 节点类型 | 1 | 12 条全产出 `text` |
| 校验函数 | 2 | 默认通过 + 零尺寸被抓 |
| **vehicleStatus 语义** | 18 | 无 supported/unsupported + 215 全 unverified + 12 条逐条 |
| 兼容字段 | 2 | 旧字段保留 |
| Catalog 派生 | 12 | 每条 category=`文字` |
| 副作用 | 1 | 重建不动设计 |
| 一致性 | 2 | `checkConsistency` + `verifyCoverage` |
| 其余 203 条 | 3 | 数量 + 全部可 `make()` |

**结果：80/80 全绿。**

### 6.2 全量回归

| 层 | P2B.1 | **P3A** |
|---|---|---|
| 套件 | 40 | **41** |
| 断言 | 4746 | **4826** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | 1365 项 0/0/0 |

基线变更（官方 `-UpdateBaseline`）：
```
↑ verify-p2b1-e2e         46 → 49
+ verify-p3a-text-family      新增 80
合计 41 个套件 / 下限之和 4826
```
**全部为增加，无一条下降。**

---

## 七、修改清单

### 新增（4）

| 文件 | 行数 | 说明 |
|---|---|---|
| `tools/icarui/js/registry/controls/text-family.js` | 236 | 12 条文字控件定义 |
| `tools/icarui/js/adapter/registry-bridge.js` | 105 | 旧入口 → Registry 接线 |
| `tools/icarui/tests/fixtures/p3a-text-golden.json` | — | **独立旧版基准**（替换前抓取）|
| `tools/icarui/tests/verify-p3a-text-family.js` | 110 | 80 条断言 |

### 修改（3）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 新增 3 个 `<script>` + 接管调用（含顺序说明）|
| `tools/icarui/js/registry/catalog.js` | Catalog 元数据从 Registry 派生；`vehicleStatus` 语义修正；`checkConsistency` 规则修正 |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 未改动（关键）

- **`app/`（Android）**
- **`icar.ui/2` 格式**
- **`presets.js`**（旧 12 条 `make` 源码原样保留，运行时被接线覆盖）
- `panels.js` / `model.js` / `schema.js` / `canvas.js`
- `BUILTIN_CONTROLS` 的内容与顺序（215 条）

---

## 八、残余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 旧 `make` 源码仍在 `presets.js` | 中 | 运行时被 bridge 覆盖，但源码里仍是"死代码"。彻底清理需改 `presets.js`（P3B 之后考虑）|
| R2 | `__legacyMake` 仍挂在条目上 | 低 | 只读诊断用；测试不用它对照 |
| R3 | 203 条仍走 `make()` 探测 | 中 | 其中 144 条有写 `design.assets` 的副作用 |
| R4 | `vehicleStatus` 全是 `unverified` | **高** | 无真车证据，属事实而非缺陷 |
| R5 | `ext` 透传仍未实施 | **高** | 未知字段仍被丢弃 |
| R6 | bridge 在 `index.html` 内联执行 | 低 | 若将来脚本顺序变动会失效；已有测试守 |

---

## 九、下一阶段 P3B 执行方案（容器族 4 条）

### 9.1 范围

`group`、`box_card`、`box_row`、`box_col` —— **仅这 4 条**。

> ⚠️ `box_h1`/`box_h2`/`box_note` **已在 P3A 归入文字族并完成迁移**，
> P3B 不得重复处理。

### 9.2 与 P3A 的差异（需特别注意）

| 项 | P3A 文字族 | P3B 容器族 |
|---|---|---|
| 节点类型 | `text` | **`group`** |
| 子节点 | 无 | `box_*` 可能带 `children` |
| 渲染 | `drawTextNode` | 容器不绘自身（`render.mode: "container"`）|
| 数据槽 | `[]` | `[]`（容器不读数据）|
| Catalog 分类 | `文字` | `容器与组合` |

### 9.3 固定步骤（沿用 P3A 已验证的流程）

1. **先抓 Golden**：`fixtures/p3b-container-golden.json`（替换前）
2. 写 `controls/container-family.js`（4 条定义）
3. `registry-bridge.bridge([...4 keys])`
4. `verify-p3b-container-family.js` 验收套件
5. 全量回归 + 断言数只增不减

### 9.4 完成判据

- `bridged` 从 12 → **16**
- `source.declared` / Registry 派生从 12 → **16**
- Golden 4/4 一致
- `checkConsistency()` 仍 ok
- 41 套件全绿、断言数不减

---

## 十、未验证边界

1. **未做真实鼠标拖动**（P2B.1 已测 `drop`，本卡未重复；文字控件走同一条 drop 通道）
2. **未做画布渲染像素对比**：文字控件改的只是"由谁创建节点"，节点内容已由 Golden 逐字段保证；
   但**未重新截图比对** P3A 前后画布视觉
3. **未人工判读 UI**
4. 真车证据仍为 0（`vehicleStatus` 全 `unverified`）
