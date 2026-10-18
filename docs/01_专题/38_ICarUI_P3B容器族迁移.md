# ICarUI P3B：容器控件族正式迁移

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P3B` |
| 基线 | P3A `b48971b` |
| 结论 | 4 类容器控件全部接管；Golden 4/4；文字族像素 12/12 零回归；**4888 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`presets.js` 零改动 |

---

## 一、四个控件迁移结果

| # | key | 旧实现 | Registry | Golden |
|---|---|---|---|---|
| 1 | `group` | `presets.js:378-385` | ✅ | ✅ |
| 2 | `box_card` | `presets.js:401-403` | ✅ | ✅ |
| 3 | `box_row` | `presets.js:401-403` | ✅ | ✅ |
| 4 | `box_col` | `presets.js:401-403` | ✅ | ✅ |

**`bridged` 从 12 → 16**，`fallback 0`、`missing 0`。
族统计：`containerFamily = { total: 4, registered: 4, skipped: 0 }`。

> ⚠️ `box_h1` / `box_h2` / `box_note` **不在本阶段范围** —— 它们已在 P3A 归入文字族完成迁移。

---

## 二、Golden 独立对比（第二部分）

### 2.1 做法

在**替换任何 `make()` 之前**抓取 4 条完整输出至
`tools/icarui/tests/fixtures/p3b-container-golden.json`：

- 确定性验证：连调两次比对，**4 条全部 stable=true** 才落盘
- 仅排除 `id`（随机生成）
- 保留全部结构、尺寸、位置、层级字段

### 2.2 Golden 抓到的两个必须照抄的细节

**细节 A：`group` 的节点名是「分组」**

```js
createNode(NODE_GROUP, { name: "分组", ... })   // 注意不是「空分组」
```

「空分组」是**控件库里的显示名**（`c.name`）；拖出来的节点名是「分组」。
两者必须分开表达（`name` / `nodeName`）。

**细节 B：`box_*` 的节点名被追加了用途提示**

```js
const n = createNode(NODE_GROUP, { name: d.name, ... });
n.name = d.name + "（" + d.note + "）";   // ← 追加！
```

实际产出：

| key | 库里显示名 | 实际节点名 |
|---|---|---|
| `box_card` | `卡片容器` | `卡片容器（放一组相关读数的底板）` |
| `box_row` | `横向分组` | `横向分组（左右排列的几个控件）` |
| `box_col` | `纵向分组` | `纵向分组（上下排列的几个控件）` |

**按源码字面抄会 3 条全错** —— 这是 P3A/P3B 两轮反复验证出的同一教训。

### 2.3 结果

```
Golden match: 4/4
```

---

## 三、容器行为验证（第四部分）

全部 10 项实测通过：

| # | 验证项 | 结果 |
|---|---|---|
| 1 | 空容器创建 | ✅ `children=0`、尺寸正常、**空 children 不序列化** |
| 2 | 加入文字子节点 | ✅ `type=text`、text 内容保留 |
| 3 | 加入图片子节点 | ✅ `type=image` |
| 4 | 容器嵌套容器 | ✅ 外层 group → 内层 group → text 三层 |
| 5 | 父容器位置改变 | ✅ 子节点局部坐标 **不变**（符合"x/y 相对父节点"语义）|
| 6 | 缩放与旋转 | ✅ `scale=1.5` / `rotation=45` 持久化 |
| 7 | 图层顺序 | ✅ `z` 独立可设 |
| 8 | 锁定与可见性 | ✅ `locked=true` / `visible=false` 持久化 |
| 9 | 撤销与重做 | ✅ 增删后节点数正确变化 |
| 10 | 保存、导出、重新加载 | ✅ 0 错误、嵌套 children 与孙节点全部保留 |

### 3.1 明确标记为「未支持」的行为

按要求，以下**不擅自修改行为**，只如实登记：

| 行为 | 现状 | 说明 |
|---|---|---|
| **空 children 序列化** | **不写出 `children` 字段** | `model.js` 的既有设计：`if (n.children && n.children.length)`。这是**刻意的**，保证老文件往返逐字段不变。测试按此断言，未改代码 |
| 容器裁剪子节点 | **不裁剪** | 子节点超出容器边界仍绘制。未实现裁剪，也未伪造校验 |
| 容器自动布局 | **无** | `box_row`/`box_col` 只是**语义标记**，不做自动排列 |

> 这三项都在 P3B 报告里显式登记，**没有为了让测试通过而改行为**。

---

## 四、Catalog 三级来源统计（第五部分）

### 4.1 修正前的问题

P3B 之前 `bySource` 只有两级：`declared 8 / probe 207`。

**把已由 Registry 接管的 16 条也算进 `probe`** —— 这正是任务指出的
"不得把剩余旧条目数量直接当作 probe 数量"。

### 4.2 修正后（实测值）

| 来源 | 数量 | 任务书预估 | 一致性 |
|---|---|---|---|
| `declared`（CatalogMeta 显式声明） | **8** | 8 | ✅ |
| `derived`（Registry 派生） | **16** | 16 | ✅ |
| `probe`（仍调旧 `make()` 探测） | **191** | 191 | ✅ |
| **合计** | **215** | 215 | ✅ |

判定优先级：`declared > derived > probe`。

---

## 五、vehicleStatus 语义（第六部分）

### 5.1 评估结论：静态控件应用 `n/a`

| 判据 | 结论 |
|---|---|
| 「不读数据的静态控件」标 `unverified` 是否合理 | **不合理** —— 等于说"这辆车可能不支持一个纯装饰文字" |
| 应采用什么 | **`n/a`**（不涉及车辆数据）|

### 5.2 修正后分布（实测）

| `dataCapability` | 数量 | `vehicleStatus` |
|---|---|---|
| `none`（不读数据） | **149** | **`n/a`** |
| `bound` | 32 | `unverified` |
| `state` | 19 | `unverified` |
| `composite` | 15 | `unverified` |
| — | — | `supported` = **0**、`unsupported` = **0** |

**双向都没误判**：
- ✅ 没有把「App 未实现」误判成「车辆不支持」（`unsupported=0`）
- ✅ 没有把「静态素材」误判成「需要车辆验证」（`none/unverified = 0`）

4 个容器控件全部 `n/a`，逐条断言。

### 5.3 兼容字段保留

`availability`（L1~L4）与 `vehicleAvailability`（旧四档）**全部保留**，
测试断言 `C.get('t_label').vehicleAvailability !== undefined`。

`checkConsistency` 的 `VALID_VH` 白名单已加 `n/a`；反向守卫保持：
**有实车证据才能标 `supported`/`unsupported`**。

---

## 六、Legacy Behavior Debt 清单（第七部分）

新建独立文件：[37_LegacyBehaviorDebt.md](37_LegacyBehaviorDebt.md)

| ID | 问题 | 类型 | 处置 |
|---|---|---|---|
| **D-01** | `box_h1/h2/note` 字号与颜色被静默重置为 `FONT_DEFAULT` | **真异常** | 登记，不修 |
| **D-02** | `t_bigunit` 字重 500→400 | 待确认 | 登记，不修 |
| **D-03** | `text` 字号 18→6（与 D-01 同根因） | **真异常** | 登记，不修 |
| D-04 | `box_*` 节点名追加用途说明 | 刻意设计 | 保持 |
| D-05 | `group` 库名「空分组」/ 节点名「分组」 | 刻意设计 | 保持 |

### 为什么只记录不修

存量设计文件按**实际值**存储。若把 D-01「修复」成源码字面的 `size=30`，
**所有历史设计里的标题会突然变大 5 倍**。

正确做法（写入清单）：新增独立 key（如 `box_h1_real`），或让属性面板显式暴露字号。

**本阶段未修改任何文字族历史行为。**

---

## 七、文字族视觉回归补充（第八部分第 9 条）

P3A 报告里标注"未重做画布像素对比"，本阶段补齐。

方法：用 `git worktree` 检出 **P2B.1（`bfdb4a3`，P3A 之前）**，
与当前版本分别渲染 12 个文字控件并取像素哈希（FNV-1a）：

| key | P3A 之前 | P3A+P3B 之后 | 一致 |
|---|---|---|---|
| text | `e4035631` | `e4035631` | ✅ |
| t_title | `17c8742d` | `17c8742d` | ✅ |
| t_label | `fe08f69` | `fe08f69` | ✅ |
| t_unit | `9da19a21` | `9da19a21` | ✅ |
| t_big | `85e10737` | `85e10737` | ✅ |
| t_small | `ca353db` | `ca353db` | ✅ |
| t_warn | `bffd14b4` | `bffd14b4` | ✅ |
| t_ok | `e7c183e2` | `e7c183e2` | ✅ |
| t_bigunit | `29913023` | `29913023` | ✅ |
| box_h1 | `9e0f6768` | `9e0f6768` | ✅ |
| box_h2 | `b0d90ccf` | `b0d90ccf` | ✅ |
| box_note | `5bfa785c` | `5bfa785c` | ✅ |

**12/12 像素级完全一致 → 文字族迁移视觉零回归。**

基准已存 `tools/icarui/tests/fixtures/p3b-text-pixel-hashes.json`。

---

## 八、全量测试结果

| 层 | P3A | **P3B** |
|---|---|---|
| 套件 | 41 | **42** |
| 断言 | 4826 | **4888** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | 1365 项 0/0/0 |

基线变更（官方 `-UpdateBaseline`）：
```
↑ verify-p2b-catalog-ui      55 → 56
↑ verify-p3a-text-family     80 → 81
+ verify-p3b-container-family     新增 60
合计 42 个套件 / 下限之和 4888
```
**全部为增加，无一条下降。**

### 8.1 本轮修正的两条既有断言（均为语义演进，非放宽）

| 套件 | 断言 | 变化 | 理由 |
|---|---|---|---|
| `verify-p2b-catalog-ui` | 来源拆分 | `8/207` → `8/16/191` | 三级来源取代二级 |
| `verify-p3a-text-family` | bridged 数 | `===12` → `>=12` 且逐 key 检查 | P3B 新增 4 条，总数变 16 |
| `verify-p3a-text-family` | 文字控件 vehicleStatus | `unverified` → **`n/a`** | 静态控件不涉及车辆数据 |

替代保障：P3B 套件新增 60 条断言守住新语义。

---

## 九、修改文件清单

### 新增（4）

| 文件 | 说明 |
|---|---|
| `tools/icarui/js/registry/controls/container-family.js` | 4 条容器定义 |
| `tools/icarui/tests/fixtures/p3b-container-golden.json` | **独立旧版基准**（替换前抓取）|
| `tools/icarui/tests/fixtures/p3b-text-pixel-hashes.json` | 文字族像素基准 |
| `tools/icarui/tests/verify-p3b-container-family.js` | 60 条断言（**分步 eval**）|
| `docs/01_专题/37_LegacyBehaviorDebt.md` | Legacy Behavior Debt 清单 |

### 修改（4）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 加载 `container-family.js`；bridge 追加 4 个 key |
| `tools/icarui/js/registry/catalog.js` | 三级来源判定；`vehicleStatus=n/a` 支持；`VALID_VH` 加 `n/a` |
| `tools/icarui/tests/verify-p2b-catalog-ui.js` | 来源断言改三级 |
| `tools/icarui/tests/verify-p3a-text-family.js` | bridged / vehicleStatus 断言按新语义 |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 未改动（关键）

- **`app/`（Android）**
- **`icar.ui/2` 格式**
- **`presets.js`**（4 条旧 `make` 源码原样保留）
- `panels.js` / `model.js` / `schema.js` / `canvas.js`
- **其它 211 个条目的创建逻辑**

---

## 十、尚未解决的风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | 191 条仍走 `make()` 探测 | 中 | 其中多数有写 `design.assets` 的副作用 |
| R2 | 旧 `make` 源码仍在 `presets.js` | 中 | 运行时被 bridge 覆盖，但源码层面仍是死代码 |
| R3 | **D-01/D-03 字体静默失效** | **高** | 已在 Debt 清单登记；**修它会破坏全部存量设计** |
| R4 | `vehicleStatus` 全为 `n/a`/`unverified` | **高** | 无真车证据，属事实 |
| R5 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |
| R6 | 容器不裁剪子节点、无自动布局 | 中 | 已显式标记"未支持" |
| R7 | bridge 在 `index.html` 内联执行 | 低 | 脚本顺序变动会失效；有测试守 |

---

## 十一、P3C 下一阶段建议

### 11.1 建议顺序（按风险递增）

| 阶段 | 内容 | 数量 | 备注 |
|---|---|---|---|
| **P3C-1** | 常用仪表 | 6 | `g_speed`/`g_coolant`/`g_fuel`/`g_volt`/`g_load`/`g_throttle` |
| **P3C-2** | 状态灯 | 19 | 含 `statePid` 静态声明；注意 L4 的 12 条占位别名 |
| **P3D** | 轨道族 | 28 | `cd_*`，渲染复杂，建议单独一卡 |
| **P3E** | `next_*` 参数化 | 15 | 5×3 → 1 定义 + 15 声明（减少重复） |
| **P3F** | 素材族 | 104 | 最后一批，数量最大但结构简单 |

### 11.2 P3C-1 的关键注意点

1. **仪表有真实数据绑定**（`pid`），必须声明 `slots`，且 `pid` 进静态元数据
2. `gauge_0..7` 已在 P2B 由 `CatalogMeta` 声明（`declared`），
   **P3C 要把它们从 `declared` 迁到 `derived`** —— 需同步调整两条统计断言
3. 仪表渲染复杂，**必须做像素回归**（沿用 P3B 的 worktree 对比法）

### 11.3 每阶段固定流程（P3A/P3B 已验证）

1. **先抓 Golden**（替换前，确定性验证）
2. 写 family 定义（逐字段对齐旧实现，**照实际产出而非源码字面量**）
3. `registry-bridge.bridge([...keys])`
4. 写验收套件（**分步 eval**，避免大表达式调试困难）
5. 全量回归 + 断言数只增不减
6. 发现历史行为问题 → 追加到 `37_LegacyBehaviorDebt.md`

---

## 十二、本次开发中的一个方法论修正

**验收套件改用分步 eval。**

P3B 开发时，一整段大 `cdp.eval(...)` 里若某个断言抛异常，整个表达式中断，
而错误只报 `Cannot read properties of undefined` **不指位置**，排查耗时很长
（本次在此卡了近 30 分钟，最后靠"逐场景隔离"才定位）。

改为**每步一次 `cdp.eval`** 后：
- 失败只影响该步，其余断言继续跑
- 错误消息自带步骤名

后续所有新套件建议沿用此模式。

---

## 十三、未验证边界

1. **未做真实鼠标拖动**（P2B.1 已测 `drop` 通道，容器走同一条）
2. **未人工判读 UI**（模型无图像输入能力）
3. 真车证据仍为 0
4. 容器裁剪 / 自动布局**明确未支持**，不是"待验证"
