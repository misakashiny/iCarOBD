# ICarUI P4R-2B：撤销历史跨会话安全恢复正式实施

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4R2B` |
| 起点 | P4R-2A 检查点 `cf506ef` |
| 结论 | 正式实现同库同事务原子写 + fail-closed 历史恢复；**41 条断言全绿**；57 套 / 6035 断言 / FAIL=0 |
| 首要原则 | **历史恢复失败不得影响已经恢复的设计** —— 已由代码结构与测试双重保证 |

---

## 一、P4R-2A 工作树检查结果

| 项 | 结果 |
|---|---|
| 起点 HEAD | `462ba9d` |
| 已暂存改动 | **无**（`git diff --cached` 为空）|
| 未暂存改动 | 10 个修改 + 5 个新增（含原型与测试）|
| 全量测试（提交前）| 56 套 / 5994 断言 / FAIL=0 |
| 文档守卫 / diff 检查 | exit 0 / exit 0 |

**处置**：先提交检查点 `cf506ef`（仅正常 `git add` + `git commit`），
**未执行任何 `reset --hard`、`clean -fd` 或破坏性操作**，未覆盖 P4R-2A 成果。

用户提供的未跟踪 `iCarOBD2_开发交接包.zip` 全程保留未动。

---

## 二、关卡 A：同库同事务原子持久化

### 2.1 数据库结构

`icar-studio-drafts` 升级到 **v3**，同一个数据库内四个 store：

| store | 作用 |
|---|---|
| `drafts` | 草稿（keyPath `draftId`）|
| `tombstones` | 持久删除墓碑（P4R-2A）|
| `undoHistory` | **撤销历史（P4R-2B 新增）**，keyPath `designId` |
| `meta` | 通用元数据 |

### 2.2 单事务写入

```js
tx = db.transaction([STORE, TOMB_STORE, HIST_STORE], "readwrite");
//   ① 查 tombstone   → 命中则拒绝（不写任何东西）
//   ② 查当前 revision → CAS 校验
//   ③ put 草稿
//   ④ put 历史（或 delete 旧历史）
//   oncomplete 才 resolve
```

**结论**：查墓碑、CAS、写草稿、写历史是**一个原子单元**；
任何一步失败（含 abort），草稿与历史**不会只成功一半**（已有 abort 回滚实测，见 P4R-2A）。

### 2.3 历史记录结构

| 字段 | 说明 |
|---|---|
| `designId` | 与草稿严格一致（keyPath）|
| `draftRevision` | 与草稿 revision 严格一致 |
| `schemaVersion` | 草稿 schema 版本 |
| `historyFormatVersion` | **历史格式版本 = 2** |
| `stack[]` | `{state, label, digest}` |
| `index` | **裁剪后重算**，指向当前设计 |
| `currentDesignDigest` | 当前设计的规范化 digest |
| `historyAvailable` | 是否可用 |
| `unavailableReason` | 不可用原因 |
| `savedAt` | 保存时间 |
| `persistedSteps` / `redoPersisted` | 如实记录可恢复步数与 redo 状态 |

### 2.4 历史无法保存时的降级（任务第三部分特别要求）

| 要求 | 实现 | 实测 |
|---|---|---|
| 草稿仍正常保存 | `history` 传 `null`，草稿照写 | ✅ 2.83 MB 大图草稿保存成功 |
| 明确标记当前 revision 无历史 | `historyAvailable=false` + `unavailableReason="too-large"` | ✅ |
| 不保留会被误认有效的旧历史 | 同事务 `delete(designId)` | ✅ `getHistory()` 返回 null |
| 不删除用户设计数据 | 只删历史记录 | ✅ 草稿完整 |
| UI 明确状态说明 | `histState` + 恢复时 toast | ✅ |

**不为了保存历史而降低设计数据完整性。**

---

## 三、CAS 与 tombstone 保护测试

| 场景 | 结果 |
|---|---|
| CAS 期望值过期 | ✅ `conflict`，草稿不写 |
| **CAS 冲突时历史保持旧版本** | ✅ 历史仍为 `draftRevision=10`，未被 `11` 覆盖 |
| 已删除草稿再次写入 | ✅ `tombstoned` |
| **删除草稿同时清除历史** | ✅ `getHistory` 立即返回 null |
| 删除后历史不会被复活 | ✅ |

### 3.1 本阶段修复的缺口

**实测发现**：删除草稿时只删草稿与写墓碑，**历史记录仍留在库中**（`writeOk=false` 但 `getHistory` 仍可取到）。

按任务第九部分「历史写入不得绕过 tombstone」，已改为**同一事务内一并 `delete` 历史**。

---

## 四、历史匹配规则与 fail-closed

### 4.1 十项校验（任务第五部分）

| # | 校验 | 实现 | 实测 |
|---|---|---|---|
| 1 | 格式版本可识别 | `historyFormatVersion === 2` | ✅ `format-mismatch` |
| 2 | `designId` 完全一致 | 严格 `===` | ✅ `designId-mismatch` |
| 3 | `draftRevision` 完全一致 | 严格 `===`，缺失也拒绝 | ✅ `revision-mismatch` |
| 4 | `index` 合法 | 栈内整数，不夹取 | ✅ `index-mismatch` |
| 5 | stack 每条结构合法 | 逐条检查 | ✅ |
| 6 | 每条 state 可解析 | `digestOfSnapshot` 成功 | ✅ |
| 7 | 每条 digest 与内容相符 | 重算比对 | ✅ `record-digest-mismatch` |
| 8 | 当前 digest 与恢复设计一致 | `designDigest(design)` | ✅ `current-mismatch` |
| 9 | 未被 tombstone 禁止 | 写入事务内检查 | ✅ |
| 10 | 无未确认跨标签页冲突 | CAS 校验 revision | ✅ |

### 4.2 失败时的行为

保留已恢复设计 → 拒绝历史 → `undo.reset(恢复后的设计)` → toast 说明原因 → **不删除损坏原记录**。

### 4.3 本阶段修复的关键缺陷

**实测发现**：历史保存成功（`steps=6`），但恢复被 `schema-mismatch` 拒绝 —— 所有历史永远无法恢复。

**原因**：原型校验读 `bundle.schema`，正式记录写的是 `historyFormatVersion`。

**修复**：校验同时接受两种字段名，缺失即拒绝。

### 4.4 digest 语义

- 递归排序完整设计对象的 key，**数组顺序保留**
- 从 `snapshot()` 只取 `d`，**排除 `selection`**
- 实测：selection 变化 → digest 不变 ✅
- **FNV-1a 是非对抗性一致性校验，不是密码学安全证明**

---

## 五、真实用户草稿恢复与撤销测试

走**正式入口**（`checkForDraft` → `restorePending`），非直接调内部函数/新标签页重开：

| 检查 | 结果 |
|---|---|
| 设计恢复 | ✅ 6 节点，`alpha=60` 与保存时一致 |
| **撤销历史恢复** | ✅ 7 条，`index=6`，`depth=6` |
| 恢复后可撤销 | ✅ `canUndo=true` |
| 撤销一步 | ✅ `60 → 50`（回到前一条）|
| 撤销后可重做 | ✅ `canRedo=true` |
| 恢复后编辑 | ✅ 正常截断 redo |
| 撤销计数按钮 | ✅ 已刷新为 `N / M` |

### 5.1 跨会话能力（任务第四部分要求明确说明）

| 项 | 实测 |
|---|---|
| **可恢复 Undo 步数** | 受 `HISTORY_MAX=40` 与 `1.2MiB` 双限制；实测 20/39/34 步 |
| **Redo 是否可恢复** | ❌ **不可恢复**（既有语义，本阶段保持并如实标记 `redoPersisted=false`）|
| 恢复后可用操作 | 可撤销 ≤ 持久化步数；**无初始 redo** |
| 裁剪后 index | ✅ 重算为栈顶，不沿用内存旧 index |

> 内存上限 101 条未被改动；持久化少于内存时如实上报，**不做静默裁剪伪装成功**。

---

## 六、setLive 未结束时恢复行为

| 场景 | 实测 |
|---|---|
| 编辑中输入，未 `endLive` 就保存 | ✅ 草稿保存模型值 39 |
| 历史是否含未压实事务 | ✅ `persistedSteps=0`（未压栈）|
| `endLive` 后 | ✅ `steps=1`（压实为一步）|
| 关闭重开恢复 | ✅ `alpha=39` 保留，历史恢复 2 步 |
| 是否强行拼接不匹配 UndoStack | ❌ 不会（严格校验）|

**设计不因撤销栈未压实而回滚**；历史不足时从当前状态重新开始。

### 6.1 兼容测试覆盖

Escape 取消、Enter 提交、失焦提交、composition 派发、持续滑块、持续拖动、撤销/重做后自动保存 —— 由既有套件（`verify-p4b1-text-finalize`、`verify-p4r12-live-draft` 等）覆盖，本阶段回归全绿。

> ⚠️ **真实系统中文 IME 仍未验证**，派发 `CompositionEvent` 不等价于真实 IME 输入。

---

## 七、历史超预算处理

| 场景 | 草稿 | 历史 | 结果 |
|---|---|---|---|
| 8 张大图（单快照超预算）| ✅ 保存 2.83 MB | 降级 `too-large` | ✅ 设计完整 |
| 单条快照超预算 | ✅ | 不写 | ✅ |
| 全部历史超预算 | ✅ | 不写 | ✅ |
| 草稿有、历史无 | ✅ | 恢复时 `no-history` | ✅ 设计保留 |
| 历史完整但部分损坏 | ✅ | 整包拒绝 | ✅ 设计保留 |

**大图片设计可能只有草稿、没有历史 —— 这是可接受的安全降级。**

---

## 八、旧 localStorage 兼容策略

| 要求 | 执行 |
|---|---|
| 保留旧键 `icar-studio-undo` | ✅ 未删除 |
| 不按名称自动绑定 | ✅ 未调用旧 `loadUndoStack` |
| 不自动载入旧记录 | ✅ |
| 不无身份迁移 | ✅ |
| 不将 A 历史绑到 B | ✅ |
| 本阶段不做迁移 UI | ✅ |

### 8.1 旧写盘是否造成额外重复写盘（任务第八部分要求评估）

| 项 | 现状 |
|---|---|
| `saveUndoStack()` 仍每次 commit 写 localStorage | 保留未动 |
| 新的历史写入 | **跟随草稿防抖（1200ms / 最长 5000ms）**，不是每次 commit |
| 重复性 | 两者写的是**不同介质**，非重复写同一处 |
| 结论 | **未停止旧写盘**（任务要求未经审核不得直接停）；实测 localStorage 写 2.8ms 中位、无回归 |

> 后续如需停用旧写盘，需单独任务提供兼容证据与前后测试。

---

## 九、双标签页与删除安全

| 场景 | 结果 |
|---|---|
| 两标签页恢复同一草稿 | ✅ 同一 `designId`/`revision` |
| A 编辑并保存 | ✅ 成功推进 revision |
| B 编辑保存 | ✅ `conflict`，画布内容不丢失 |
| B 另存独立草稿 | ✅ 新 identity，历史随新草稿 |
| A 与 B 历史分别匹配自身草稿 | ✅ 各自 `designId` 独立 |
| A 删除后 B 复活 | ✅ `tombstoned`（含 65 秒后、重启后）|
| 历史写入绕过 CAS/tombstone | ❌ **不可能**（同事务）|

**存储事务保证，不依赖提示消息。**

---

## 十、v1/v2 IndexedDB 升级兼容

| 升级 | 结果 |
|---|---|
| v1（`drafts`,`meta`）→ v2（+`tombstones`）| ✅ 旧草稿 rev=7 与旧 meta 保留 |
| **v2（`drafts`,`meta`,`tombstones`）→ v3（+`undoHistory`）** | ✅ `draftKept=true, draftRev=9, tombKept=true, histInitiallyEmpty=true` |

升级逻辑用 `if (!contains) createObjectStore`，可重入且不破坏既有数据。

---

## 十一、恢复性能测量

Edg/155 headless。**120 控件 / 40 步**详细分位（n=20 / 10）：

| 项 | median | P95 | max |
|---|---:|---:|---:|
| `designDigest` | 0.3 ms | 0.4 ms | 0.4 ms |
| 历史读取 | 1.7 ms | 7.0 ms | 7.0 ms |
| 历史校验 `validate` | 14.5 ms | 18.8 ms | 18.8 ms |
| **UndoStack 恢复** | **24.1 ms** | 35.1 ms | 35.1 ms |
| 原子写（含草稿+历史）| <1 ms | <1 ms | <1 ms |

综合场景（median）：

| 控件 | 编辑步 | digest | 读取 | 校验 | 恢复 | 持久条数 |
|---|---|---|---:|---:|---:|---:|
| 20 | 20 | 0.2 ms | 0.2 ms | 3.4 ms | 4.2 ms | 21 |
| 60 | 20 | 0.2 ms | 1.0 ms | 10.3 ms | 11.6 ms | 39 |
| 60 | 40 | 0.3 ms | 1.4 ms | 11.3 ms | 15.5 ms | 39 |
| 120 | 20 | 0.8 ms | 1.9 ms | 21.8 ms | 25.5 ms | 39 |
| 120 | 40 | 0.5 ms | 2.1 ms | 20.3 ms | 28.1 ms | 34 |
| 60 | 100 | 0.2 ms | 1.5 ms | 12.5 ms | 18.7 ms | 39 |

**未通过减少内存 UndoStack 上限换取性能；未静默裁剪制造"恢复成功"假象。**

> 校验耗时主要在逐条重算 digest；后续可缓存 digest 降低，但本阶段不优化以免引入正确性风险。

---

## 十二、全量回归结果

| 层 | P4R-2A | **P4R-2B** |
|---|---|---|
| 套件 | 56 | **57** |
| 断言 | 5994 | **6035** |
| FAIL | 0 | **0** |
| Android JVM | 1365 | **1365 项 0/0/0** |
| Registry bridged | 69 | **69** |
| Catalog total | 215 | **215** |
| Schema 支持 | 59 | **59** |

新增验收套件：`verify-p4r2b-history-restore.js`（**41 断言**，A–I 九组）。

### 12.1 P4R-2A「19/19」统计校正（任务第十一部分要求）

原报告称"19/19 通过"但正文只列 18 项。**实际为：18 类场景 + 1 条模块加载检查 = 套件共 19 条断言。**

已在专题 54 中校正表述，避免夸大覆盖。

### 12.2 本阶段修复的两个真实缺陷

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | 历史版本字段名不一致（`schema` vs `historyFormatVersion`）| **所有历史永远无法恢复** |
| 2 | 删除草稿未删除历史 | 历史记录残留，违反 tombstone 保护 |

---

## 十三、修改文件清单

| 文件 | 改动 |
|---|---|
| `js/ui/draft-store.js` | DB v3 + `undoHistory` store；单事务写草稿+历史；`getHistory`/`deleteHistory`；删除一并清历史 |
| `js/ui/draft-manager.js` | `buildHistoryForSave`（预算/降级）；`restoreHistoryFor`（fail-closed）；接入 `restorePending`；诊断导出 |
| `js/ui/undo-anchor.js` | 版本字段兼容（`historyFormatVersion` / `schema`）|
| `tests/verify-p4r2b-history-restore.js` | 新增 41 断言 |
| `tests/expected-counts.json` | 基线 +41 |
| `docs/01_专题/54_...P4R2A...md` | 校正 19 项统计口径 |

### 未改动（任务第十二部分）

- ✅ `app/`（Android）零改动
- ✅ `icar.ui/2` 设计文件格式未改
- ✅ 控件默认样式未改
- ✅ `canvas.js` 未改（Canvas 绘制未重写）
- ✅ 未实施 `ext` 透传
- ✅ 未改造成协同编辑系统
- ✅ 未引入框架/构建工具
- ✅ 无破坏性 Git 操作
- ✅ 未自动覆盖用户正在编辑的设计
- ✅ **未在 `init()` 无条件调用 `loadUndoStack`**

---

## 十四、未验证事项

| 项 | 原因 |
|---|---|
| **真实系统中文 IME** | 只能派发 `CompositionEvent`，不等价于真实 IME → 人工验收 |
| 真实 GUI 浏览器崩溃恢复 | 仅 headless 证据 |
| 系统断电 / 蓝屏后持久化 | 未做物理断电实验 |
| Firefox / Safari | 仅覆盖 Chromium 155 |
| 真实用户长时间（数小时）会话 | 未测 |
| 多标签页 >2 并发 | 仅测两标签页 |
| 旧 localStorage 历史导入 UI | 本阶段明确不做 |

---

## 十五、残留风险

| # | 风险 | 级别 |
|---|---|---|
| R1 | **redo 分支不跨会话** —— 恢复后无法重做恢复前的操作 | 中（既有语义，已如实告知）|
| R2 | 大图设计可能完全无历史（安全降级）| 中 |
| R3 | `validate` 120 控件约 14.5ms，随控件数增长 | 中 |
| R4 | FNV-1a 非抗碰撞，极端碰撞可能导致误判匹配 | 低（另有逐条结构校验）|
| R5 | 旧 localStorage 写盘仍在，与新历史并存 | 低（不同介质，无重复写同一处）|
| R6 | 真实 IME 未验，composition 期间历史行为未在真机确认 | 中 |

---

## 十六、P4R-2C 前置条件（如后续要做）

1. 若要让 **redo 跨会话**：需同时持久化 `index` 之后的记录，并重新定义"当前设计"与 redo 分支的一致性锚点。
2. 若要**性能优化**：缓存 per-record digest，需保证缓存与内容强绑定并有失效验证。
3. 若要**旧历史导入**：必须独立任务，设计用户确认 + 逐条校验流程，禁止按名称绑定。
4. 真实 IME 与真实浏览器崩溃恢复须另开人工验收。

**本卡完成，停止；不自动进入 P4D / P4E 属性面板迁移。**
