# Legacy Behavior Debt（历史行为问题登记）

| 字段 | 值 |
| --- | --- |
| 建立日期 | 2026-10-18（Asia/Shanghai） |
| 建立任务 | `T-UI-REFACTOR-P3B`（第七部分要求） |
| 性质 | **只登记，不修改**。本阶段不动文字族历史行为 |
| 维护方式 | 发现新的历史行为问题就往这里追加一条，**在 P3 各阶段不改** |

> 本清单记录的是「**当前代码的实际行为与源码/直觉不一致**」的地方。
> 它们不是 bug 修复目标，而是**必须被显式知道并传递下去的事实** ——
> 否则下一个接手的人会按源码字面意思改，一改就破坏存量设计。

---

## D-01：`box_h1` / `box_h2` / `box_note` 的字号与字重被静默重置

| 项 | 内容 |
|---|---|
| **发现于** | P3A 迁移文字族（Golden Fixture 比对时） |
| **位置** | `tools/icarui/js/presets.js:418-433` |
| **预期值**（源码字面量） | `box_h1`: `size=30`、`color=#CFE0EE`<br>`box_h2`: `size=20`、`color=#8FA0B8`<br>`box_note`: `size=12`、`color=#5F6E85` |
| **实际值**（真实产出） | 三者**全部**为 `font.size=6`、`weight=400`、`align="left"`、`color=#E8EEF7`（即 `FONT_DEFAULT` 全值） |
| **源码原因** | 旧实现写的是<br>`createNode(NODE_TEXT, { ..., fontSize: d.size, color: d.color, ... })`<br>—— 传的是**顶层 `fontSize` / `color`**，但 `createNode` 对 `NODE_TEXT` 只做：<br>`font: window.normalizeFont(o.font)`<br>而 `o.font` 是 `undefined` → `normalizeFont(undefined)` 返回完整的 `FONT_DEFAULT`。<br>**`fontSize` 与 `color` 被完全忽略，不报错、不告警。** |
| **影响面** | 拖出来的这 3 个控件在画布上是「6 号字、左对齐、默认色」，与名字暗示的「大标题 / 小标题 / 小注释」严重不符 |
| **存量设计影响** | 已有设计文件里这 3 个控件的字体**就是 `size=6`**。<br>⚠️ 若"修复"成源码字面值，**会让所有存量设计里的标题突然变大 5 倍** |
| **建议修复方式** | **不要改**。若要提供"真正的大标题"，应**新增**一个控件 key（如 `box_h1_real`）或让属性面板显式显示字号，而不是改这三个的历史行为 |
| **当前处置** | P3A 迁移时**照实际值抄**（不是照源码字面值），Golden 12/12 一致；P3B 本阶段**不改** |

---

## D-02：`t_bigunit` 的字重与源码字面量不一致

| 项 | 内容 |
|---|---|
| **发现于** | P3A |
| **位置** | `presets.js:497` |
| **预期值** | `weight: 500` |
| **实际值** | `weight: 400` |
| **源码原因** | 待确认（可能是 `normalizeFont` 的合法值表或旧实现另有分支；**未深查，不下结论**）|
| **影响面** | 视觉上比其他"大号"文字略细 |
| **建议** | 与 D-01 同：不改历史行为；如需 500 字重请新增控件或让用户自己调 |
| **当前处置** | P3A 照实际值抄；本阶段不改 |

---

## D-03：`text` 控件的字号同样是「6」而非 18

| 项 | 内容 |
|---|---|
| **发现于** | P3A |
| **位置** | `presets.js:146-154` |
| **预期值** | `fontSize: 18`、`color: "#8FA0B8"` |
| **实际值** | `font.size=6`、`align="left"`、`color=#E8EEF7` |
| **源码原因** | 与 D-01 同源：传顶层 `fontSize`/`color` 给 `NODE_TEXT`，被 `normalizeFont(undefined)` 覆盖 |
| **备注** | 这条与 D-01 是**同一个根因**，只是 `text` 在 P3A 里已单独按实际值处理 |
| **建议** | 与 D-01 同 |

---

## D-04：`box_*` 容器的 `name` 在实际产出上被追加了用途说明

| 项 | 内容 |
|---|---|
| **发现于** | P3B |
| **位置** | `presets.js:411-412` |
| **源码字面** | `{ key: "box_card", name: "卡片容器", note: "放一组相关读数的底板" }` |
| **实际产出** | `name = "卡片容器（放一组相关读数的底板）"` |
| **源码原因** | 旧实现里有一行<bt>`n.name = d.name + "（" + d.note + "）";` |
| **影响面** | 拖进画布后控件树显示的是带括号的长名字；**库里显示的仍是短名** |
| **是否为问题** | **不是 bug** —— 这是刻意设计（注释写「拖进画布后在控件树里一眼看得出是干嘛的」）|
| **建议** | 保持。P3B 迁移时照实际值抄（`nodeName` 字段），Golden 4/4 一致 |

---

## D-05：`group` 的节点名是「分组」，库里显示名是「空分组」

| 项 | 内容 |
|---|---|
| **发现于** | P3B |
| **位置** | `presets.js:378-385` |
| **库显示名** | `空分组`（`c.name`）|
| **节点名** | `分组`（`make()` 里 `createNode(NODE_GROUP, { name: "分组" })`）|
| **影响面** | 控件库里叫「空分组」，拖出来在控件树里叫「分组」 |
| **建议** | 保持（无害，且改名会影响存量设计的节点名显示）|
| **当前处置** | P3B 用 `name`（库显示名）+ `nodeName`（节点名）两个字段分开表达 |

---

---

## D-06：`NODE_GAUGE` 的 `pid` 被归一化，`rawPid` 才是用户输入

| 项 | 内容 |
|---|---|
| **发现于** | P3C-1（迁移六个常用仪表） |
| **位置** | `tools/icarui/js/model.js` 的 `createNode` → `NODE_GAUGE` 分支 |
| **现象** | 传 `pid: "obd.speed"` 建节点，读回来 `node.pid === "std_0D"`，`node.rawPid === "obd.speed"` |
| **性质** | **刻意设计，不是 bug**。源码注释写明了原因：早期 `createNode` 直接存别名，而 `parseNode` 存解析后的 id，导致"预设建的表画布上写着 obd.rpm、导入的表写着发动机转速"。统一后：`pid` = 解析后 id（内部查表用），`rawPid` = 用户别名（回显与序列化用）。 |
| **影响面** | 任何按 `node.pid` 去比对"用户写的别名"的代码都会失败。本次写 P3C-1 验收测试时踩到，14 条断言先红后修。 |
| **建议** | 不改行为。在 [04_架构与数据流](../04_架构与数据流.md) 的节点字段表里显式写清：<br>`pid` = 解析后 id（内部查表）；`rawPid` = 用户别名（回显/序列化） |
| **当前处置** | P3C-1 按实际行为断言（`rawPid` 比别名、`pid` 比解析结果）；未改代码 |

---

## D-07：`panels.js` 给所有 `make` 包了一层 `prepareBuiltinImages`

| 项 | 内容 |
|---|---|
| **发现于** | P3C-2（迁移状态灯时 Golden 0/19） |
| **位置** | `tools/icarui/js/panels.js` 加载末尾的 `BUILTIN_CONTROLS.forEach` |
| **现象** | `control.make` 被替换成 `() => prepareBuiltinImages(make(), false)`；图片控件的 `w` 被按画布宽高比缩放（56 → 56×1600/2560 = 35） |
| **性质** | **刻意设计**。注释写"Built-in image templates describe their visual aspect, unlike saved canvas geometry" |
| **影响面** | 任何"未包装"的创建路径（如直接调 Registry.build）都会与旧入口差一截。P3A/P3B/P3C-1 因控件不是 NODE_IMAGE 从未暴露；P3C-2 状态灯立刻踩到 |
| **建议** | **不改 panels.js**。约束是：`registry-bridge` 的执行必须放在 `panels.js` **之后**（已在 index.html 修正）。P3F 素材族（104 条 IMAGE）会同样依赖此修复 |
| **当前处置** | bridge 调用已移到 panels.js 之后；Golden 19/19 |

---

## D-08：`assetId` 是运行期生成的，不能作为 Golden 比对字段

| 项 | 内容 |
|---|---|
| **发现于** | P3C-2 |
| **位置** | `tools/icarui/js/panels.js` 的 `ensureBuiltinAsset()` → `window.newId("as")` |
| **现象** | 同一控件在不同会话里拿到的 `assetId` 不同（`asbeq89` vs `asbei0j`） |
| **性质** | 刻意设计（素材 id 与用户设计绑定，每次导入重新分配） |
| **影响面** | Golden 里若保留 `assetId`，跨会话比较必然失败（实测 19 条全红） |
| **建议** | Golden 比对时**把 `assetId` 归一化为素材路径**。这不是"忽略字段"，而是换成等价且稳定的表示 —— 素材**路径**才是语义身份 |
| **当前处置** | 已按路径归一化；Golden 19/19 |

---

## D-09：`UndoStack` 首次 `commit()` 建立基准，单次撤销无可见变化

| 项 | 内容 |
|---|---|
| **发现于** | P3D（写 undo 测试时） |
| **位置** | `tools/icarui/js/app.js` 的 `UndoStack` 使用处 |
| **现象** | 空设计上 `commit()` 一次 → `doUndo()` 后节点数仍是 1（未退回 0）；`commit()` 两次 → undo 退回 1 |
| **性质** | **刻意设计**。首次 commit 把"当前状态"记为基准，撤销回到基准而非空 |
| **影响面** | 写撤销测试若只 commit 一次会误判"undo 没生效" |
| **建议** | 不改。测试写法约定：**要观察 undo 必须至少 commit 两次** |
| **当前处置** | P3D 测试改为两次 commit，断言 `undo steps back exactly one node` |

---

## D-10：`normalizeTrackStyle()` 会把非法值静默归一

| 项 | 内容 |
|---|---|
| **发现于** | P3D |
| **位置** | `tools/icarui/js/model.js` `createNode` 的 `NODE_IMAGE` 分支 |
| **现象** | `createNode(NODE_IMAGE,{trackStyle:{orient:"x"}})` → `trackStyle.orient === "h"` |
| **性质** | **刻意防护**（保证画布不会因坏数据崩） |
| **影响面** | 校验器**收不到**坏值 —— 若靠 `build({orient:'x'})` 造坏数据测校验，测试会假通过 |
| **建议** | 不改防护。测试验证校验器时必须**建好后直接改字段**，不能经过 `createNode` |
| **当前处置** | P3D 测试已按此写法修正 |

---

## D-11：`addNode` 是 3 参数函数，但曾被当 1 参数调用（已修）

| 项 | 内容 |
|---|---|
| **发现于** | P4A（核验三个添加入口时） |
| **位置** | `tools/icarui/js/ui/catalog-panel.js` 的 `addToCanvas`（**已修**） |
| **现象** | 双击/点击添加**完全失效**：`addNode(node)` 只传 1 个参数，而 `model.js` 签名是 `addNode(nodes, node, parentId)` → `nodes` 收到节点对象、`node` 是 undefined → `nodes.push(undefined)` 抛错 → 被 catch 吞掉 → **静默返回 false** |
| **性质** | **真 Bug**（P2B 引入） |
| **影响面** | 新资源库的双击/点击添加功能**从未真正工作过**。之所以没被发现：P2B 端到端测试只覆盖**拖拽**（drop 事件），没测双击添加 |
| **建议** | 已修：新增 `js/ui/insert-control.js` 统一插入适配层，三个入口共用。**后续所有新增入口都应走这一层** |
| **当前处置** | 已修复并加入 P4A 验收套件（三入口尺寸一致性断言） |

---

## D-12：refreshAll() 不通知并行属性面板（P4A.1 已修）

| 项 | 内容 |
|---|---|
| **发现于** | P4A.1（新旧面板双向同步核验） |
| **位置** | `tools/icarui/js/app.js` 的 `refreshAll()`（**已修**） |
| **现象** | 旧面板改字段后走 `refreshAll()`，它只调 `renderPanels()`→`renderProps()`，**不通知 Schema 面板**，于是新面板显示旧值（实测 model:12 / panel:5） |
| **性质** | 架构缺口（不是既有 bug，是 P4A 新增并行面板后暴露的） |
| **影响面** | 任何并行面板都必须自己挂到刷新链上，否则会静默不同步 |
| **建议** | 已修：在 `refreshAll()` 里追加 `SchemaPanel.refresh()`（放在 renderPanels 之后、draw 之前） |
| **当前处置** | 已修并加入 P4A.1 验收套件（6 项同步断言） |

---

## D-13：t_label 的 font.size.max=200 是 P1A 试点遗留（P4B.1 已统一为 400）

| 项 | 内容 |
|---|---|
| **发现于** | P4B.1（文字族 Schema 一致性审计） |
| **位置** | `tools/icarui/js/registry/controls/t_label.js`（**已修**）|
| **现象** | 同族 12 条文字控件出现两种 font.size.max：t_label=200，其余=400 |
| **根因** | t_label 的 schema 写于 P1A 试点（提交 4346908），当时注释为「只登记、不驱动 UI」，200 是占位值从未生效；P3A 写 text-family.js 时用了 400 |
| **审计证据** | 旧属性面板 panels.js:980 的输入框只有 min="1"、**没有 max**；normalizeFont 也只判 size > 0 |
| **影响面** | P4B 接入面板后，重载的 t_label 因 __controlKey 丢失会回退到 400，导致「保存前后校验规则不一致」|
| **建议** | 已统一为 400；不影响默认值、序列化、渲染与存量设计 |
| **当前处置** | 已修；P4B.1 断言 12 条 `distinctSignatures === 1` |

---

## D-14：`assetQuery` / `collapsed` / `panelCollapsed` 是 panels.js 闭包变量（P4P-1A 踩到）

| 项 | 内容 |
|---|---|
| **发现于** | P4P-1A（做素材库签名时）|
| **位置** | `tools/icarui/js/panels.js` 的 IIFE 内部 |
| **现象** | `assetQuery`、`collapsed`、`panelCollapsed` 都是闭包里的 `const`/`let`，**外部模块访问不到**；`typeof panelCollapsed` 永远返回 `"undefined"` |
| **性质** | 刻意封装（避免污染全局），不是缺陷 |
| **影响面** | 任何想从外部读这些状态的代码都会静默拿到 undefined。P4P-1A 第一版把折叠态放进签名，导致 `verify-assets`/`verify-fix`/`verify-feat2` 三个套件变红 |
| **建议** | 需要这些状态时**不要试图读闭包变量**，改为在**操作入口处**显式通知（如 `renderAssets(true)`）|
| **当前处置** | P4P-1A 已改为 5 个入口强制刷新；签名不记录折叠态 |

---

## D-15：撤销栈写进 localStorage 但从不自动加载；设计无自动保存

| 项 | 内容 |
|---|---|
| **发现于** | P4P-1B（关卡 A 审计）|
| **位置** | `app.js` 的 `saveUndoStack` / `loadUndoStack` |
| **现象** | `saveUndoStack()` 每次 commit 同步写 1.19MB（约 15.6ms），但 `loadUndoStack()` **在产品代码里从未被调用**（全库只有赋值与测试套件调用）。刷新页面后 localStorage 数据完好，撤销历史却不可用 |
| **附带** | 全库无设计自动保存 —— 崩溃后**设计本身**也会丢 |
| **影响** | 每次 commit 付 15.6ms 换来的恢复能力实际为 0；用户不知道刷新会丢历史 |
| **建议** | ① 若要保持该功能：`init()` 里调 `loadUndoStack()`，但需同时做设计持久化（否则设计名不匹配仍不加载）；② 若决定不要：直接停掉写盘，commit 可降约 70% |
| **当前处置** | **未修**（P4P-1B 任务要求只报告不扩大范围）；已记录在专题 49 |

---

## D-16：设计无自动保存；设计名不能作唯一身份（P4R-0 实测）

| 项 | 内容 |
|---|---|
| **发现于** | P4R-0（数据安全审计）|
| **现象1** | 刷新/关闭/崩溃后**设计全部丢失** —— 只有手动 `saveFile()` 下载能持久化 |
| **现象2** | `designName` 匹配挡不住同名：实测**同名但内容完全不同的两个设计会错位加载历史** |
| **现象3** | 空设计名一律存成 `未命名设计`，大量设计会撞名 |
| **影响** | 用户改了半天刷新一下全丢；即使将来接上 loadUndoStack 也可能把 A 的历史加载到 B |
| **建议** | ① 方案 B：IndexedDB 草稿（剥离素材 data）+ 启动提示条，不自动恢复；② 新增内部 `design._id`，**不写进 icar.ui/2**（nodeToJson 白名单过滤）|
| **当前处置** | **未修**（P4R-0 只读）；方案待批准 |

---

## D-17：P4R-0 建议「草稿剥离 asset.data」是错的（P4R-1 实测纠正）

| 项 | 内容 |
|---|---|
| **发现于** | P4R-1（图片可恢复性验证）|
| **原建议** | P4R-0 建议草稿只存 `path` 不存 `data`，以减小体积 |
| **实测反证** | 用户拖入的图片若来自 `URL.createObjectURL()`，得到 `blob:null/xxx`。**刷新后 `fetch(blobUrl)` 直接 `Failed to fetch`** —— 该 URL 只活在创建它的文档里 |
| **后果** | 只存 path 会导致**用户导入的图片永久丢失** |
| **修正** | P4R-1 实施方案 A：草稿**完整保存 asset.data**（任务第二部分要求）|
| **当前处置** | ✅ **已按正确方案实现**；本文件记录这次纠正 |

## 汇总表

| ID | 问题 | 类型 | 处置 |
|---|---|---|---|
| D-01 | `box_h1/h2/note` 字体被重置为 `FONT_DEFAULT` | **真异常**（静默失效）| **登记，不修** |
| D-02 | `t_bigunit` 字重 500→400 | 待确认 | 登记，不修 |
| D-03 | `text` 字号 18→6 | **真异常**（同 D-01 根因）| 登记，不修 |
| D-04 | `box_*` 节点名追加用途说明 | 刻意设计 | 保持 |
| D-05 | `group` 库名「空分组」/ 节点名「分组」 | 刻意设计 | 保持 |
| D-06 | `NODE_GAUGE` 的 `pid` 被归一化，别名在 `rawPid` | 刻意设计 | 保持 |
| D-07 | `panels.js` 给所有 `make` 包了 `prepareBuiltinImages`（图片控件 w 被缩放） | 刻意设计 | bridge 必须在其后 |
| D-08 | `assetId` 是运行期生成的，不能作为 Golden 字段 | 刻意设计 | 归一化为素材路径 |
| D-09 | `UndoStack` 首次 commit 建基准，单次 undo 无可见变化 | 刻意设计 | 测试须 commit 两次 |
| D-10 | `normalizeTrackStyle()` 静默归一非法值 | 刻意防护 | 测校验须绕过 createNode |
| D-11 | `addNode` 3 参数曾被当 1 参数调用致添加静默失效 | **真 Bug** | **P4A 已修** |
| D-12 | `refreshAll()` 不通知并行属性面板致不同步 | 架构缺口 | **P4A.1 已修** |
| D-13 | `t_label` 的 font.size.max=200 是 P1A 试点遗留 | 遗留占位 | **P4B.1 已统一** |
| D-14 | `assetQuery`/`collapsed`/`panelCollapsed` 是闭包变量，外部读不到 | 刻意封装 | 入口处显式通知 |
| D-15 | 撤销栈写入但从不加载 | **功能缺陷** | **未修**（待决策）|
| D-16 | 设计无自动保存；设计名不能作唯一身份 | **功能缺陷** | **P4R-1 已部分解决**（草稿+designId）|
| D-17 | P4R-0「剥离 asset.data」建议错误 | **方案缺陷** | ✅ P4R-1 已纠正 |

---

## 为什么"只登记不修"是对的选择

1. **存量设计文件按实际值存储**。改默认值 = 改所有历史设计在设备上的样子。
2. 这三个问题**不是用户在报的问题**，修它们没有收益、只有风险。
3. 但它们**必须被记录** —— 否则下一个 AI 看到源码 `size: 30` 会以为"这是大标题"，
   进而写出"修复"，一次性破坏全部存量设计。

**若要真正提供"大标题"能力**，正确做法是：
- 新增独立 key（如 `box_h1_real`），或在属性面板把字号显式暴露出来让用户自己调。

---

## 后续追加规则

P3C 及以后每个阶段，若发现新的历史行为问题：

1. 在**本文件**追加 `D-0N` 条目
2. 注明：发现于哪个任务、源码位置、预期值 vs 实际值、原因、影响面、建议
3. **当阶段不修**，只在报告里引用本文件
