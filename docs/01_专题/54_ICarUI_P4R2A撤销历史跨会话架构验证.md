# ICarUI P4R-2A：撤销历史跨会话恢复架构验证

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-18（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4R2A` |
| 基线 | P4R-1.2 `462ba9d` |
| 结论 | UndoStack 语义审计完成；隔离锚点原型 fail-closed；持久删除保护复活测试通过；**未在启动流程接入 `loadUndoStack`** |
| 回归 | 浏览器 55 套 / 5975 断言 / FAIL=0；Android JVM 1365 项 0/0/0 |

---

## 一、现有 UndoStack 完整语义与调用链

### 1.1 快照与状态语义

`app.js:snapshot()` 返回 `JSON.stringify({d:S.design, sel:S.selection})`。快照包含设计和 selection；selection 是 UI 状态，**不应作为设计身份锚点**。

`design.name` 是显示字段，不是身份。跨会话关联必须使用 `designId`。

### 1.2 UndoStack 操作

| 操作 | 当前语义 |
|---|---|
| 构造 | `new UndoStack(100)`；初始空栈、index=-1 |
| `reset(state,label)` | 重建为 1 条基准，index=0，清空 coalesceKey |
| `push(state,label,key)` | 新编辑先 `splice(index+1)`，截断 redo 分支；之后 push 并更新 index |
| `push` 同 coalesceKey | 替换当前栈顶快照，不新增一步；一次拖动/滑块手势最终仍为一步 |
| `endCoalesce()` | 清空合并键，下次同类操作另开一步 |
| `trim()` | 内存栈最多 `limit+1`，即 101 条（含当前基准）；shift 最旧记录并同步 index-- |
| `undo()` / `redo()` | 按方向找可用快照；坏记录被摘除；正常端点返回对象，不返回 null |
| `index` | 指向当前设计所对应的历史记录；`depth()` 是向后可撤销步数 |
| 批量事务 | `beginBatch` 压起点；内部 commit 汇入同一批；`endBatch` flush 最终状态 |
| 实时属性 | `setLive` 不压栈；`endLive` 把起点与最终值压实为一步；`abortLive` 由调用方恢复模型 |

### 1.3 初始化与调用链

`app.js:init()` 执行 `undo.reset(snapshot(), "初始")`。`commit()` 修改模型、push 快照、同步 JSON、刷新 UI，并按 coalesceKey 调用 `saveUndoStack()`。`endBatch()`、手势结束和 `replaceDesign()` 有显式 flush/save。

**`loadUndoStack` 只有定义和测试钩子，没有正式启动调用点。** 本阶段没有增加调用。

### 1.4 内存与持久化边界

| 指标 | 现状 |
|---|---|
| UndoStack 构造 limit | 100 |
| 内存最大条数 | **101**（100 步 + 基准）|
| localStorage 最大步数 | `UNDO_MAX=40` 条，从当前 index 往回取 |
| localStorage 字节预算 | **1,228,800 bytes（1.2MiB）** |
| index 保存值 | 当前持久化栈最后一条 |
| 实际可撤销步数 | 内存可超过 40；持久化受 40 条及 1.2MiB 双限制 |
| redo 分支 | 不持久化：只保存 `index` 及之前的记录 |

**实测（60 控件）：**

| 编辑提交数 | 内存栈 | 持久化栈 | 内存可撤销步数 | localStorage |
|---:|---:|---:|---:|---:|
| 20 | 23 | 23 | 22 步 | 约 458KiB |
| 40 | 42 | 40 | 41 步 | 约 826KiB |
| 100 | 101 | 40 | 100 步 | 约 824KiB |

跨会话恢复可撤销步数可能少于当前内存；redo 分支当前不持久化。

### 1.5 发现并修复：单快照可绕过 1.2MiB 预算

修复前裁剪条件带有 `parts.length > 0`，导致**第一条快照从不检查预算**。实测一条约 1.7MiB 的快照仍被写入；另一次 3.38MiB 写入也成功。

修复为单条快照同样检查预算：超预算时跳过持久化、保留内存 UndoStack，不写超预算历史。

若 `parts` 为空，`saveUndoStack()` 只 return，磁盘可能保留更早历史；因此仍需依赖 designId/revision/digest 校验，不能自动加载旧数据。

---

## 二、设计与历史的一致性方案

推荐关系：

```text
designId
  └─ draft: revision + designJson
       └─ history: designId + draftRevision + currentDigest
            └─ stack[]: snapshot state + digest + index
```

考虑历史加载必须同时满足：

1. `designId` 严格相等；不比较 `design.name`。
2. `draftRevision` 存在且严格相等。
3. `index` 是栈内整数，不夹取越界 index。
4. **整条 undo/redo 栈**的每一条记录均可解析、结构有效，且每条 digest 与内容匹配。
5. 当前 index 处的设计 digest 与已恢复草稿设计一致。

任一条件失败：**保留已恢复设计，拒绝历史并以恢复设计建立新基准**。历史损坏不能阻止草稿恢复。

原型对 snapshot 仅取 `d`，递归排序完整设计对象的键后算 digest；数组顺序保留，selection 排除。FNV-1a 是一致性指纹，不是抗碰撞密码学身份；若正式防恶意篡改需强哈希或逐字段验证。

Fail-closed 检查通过：designId/revision/index 不匹配、任一 redo 记录损坏均拒绝；selection 改变不影响 digest；对象键序改变不影响 digest。

---

## 三、三种持久化方案比较

Edg/155 headless、60 控件、22 条持久化快照实测：

| 方案 | 写入中位数 / P95 | 读取中位数 / P95 | 一致性 | 复杂度 |
|---|---|---|---|---|
| A. localStorage，恢复时加锚点 | **2.8ms 同步 / 3.5ms** | 0.8ms / 1.5ms | 历史与草稿分别写，不能原子提交 | 低，但旧历史身份不足 |
| B. IndexedDB 独立存历史 | 1.1ms / 7.9ms（异步） | 0.2ms / 0.3ms | 不同事务仍可能 revision 不一致 | 中 |
| **C. 草稿与历史同库同事务** | **1.1ms / 1.7ms** | 原型中读取较 B 相同量级 | **可原子提交** | 中高，需要 schema/编排 |

隔离原子性测试在同一 IndexedDB `readwrite` transaction 中写 `drafts` 与 `meta`：两者同时提交成功；主动 abort 后草稿记录未出现。因此平台支持方案 C 所需的跨 store 原子事务；这不表示现有产品代码已经这样保存历史。

**推荐 P4R-2B 以 C 为目标**：同 DB、同事务写 draft + undo bundle + CAS revision。不要用两个事务后假设自然一致。

---

## 四、旧 localStorage 历史兼容策略

旧键 `icar-studio-undo`，字段 `stack`、`index`、`designName`，没有可靠 `designId`、draftRevision 或内容锚点。

- 不按 `designName` 自动关联。
- 不自动载入旧历史。
- 不删除旧 localStorage 数据；原字节留作诊断/备份。
- P4R-2B 可让用户显式确认“无法证明身份，是否只作为当前设计新历史导入”；不得称为原设计身份恢复。

实际旧格式字段检查为 `stack,index,designName`，原数据未修改。

---

## 五、双标签页原子 CAS 与历史锚点 E2E 原型

使用真实两个 Edge 标签页并走正式 `DraftManager.checkForDraft()` / `restorePending()`：

1. A、B 都恢复同一 `designId` 与 revision=1。
2. A 编辑并保存成功，草稿 revision=2。
3. B 编辑不同属性后保存返回 `reason="conflict"`，expected=1/current=2。
4. B 本地修改仍在画布（x=222）。
5. B 另存独立副本成功，新 designId；原草稿仍存在。

历史包只校验锚点，不调用 `loadUndoStack`。原型测试发现 `replaceDesign()` 会生成新 ID，因此正式 `restorePending()` 成功后需把草稿原 `designId` 与 revision 绑定回来；本阶段仅恢复该身份/CAS 上下文，不加载历史栈。

---

## 六、删除草稿持久保护

### 修复前复现

A 删除，B 保留旧 designId，等 65 秒后保存成功，草稿 rev=100 复活。B 重启后再次写入被 CAS 拒绝，但首次复活已发生。

### 最小安全修复

- IndexedDB schema v1→v2，新增 `tombstones` store。
- 删除草稿与永久墓碑在同一 `readwrite` transaction。
- 保存事务同库检查墓碑，再做 revision CAS；墓碑存在即 `tombstoned`。
- 内存 60 秒 tombstone 保留为快速路径，不再是安全边界。

### 实测

两个真实标签页：A 删除；B 等待 65 秒再保存；随后关闭重开 B 再保存。两个写入均返回 `tombstoned`，记录不存在、未复活。

### v1→v2 隔离升级夹具

v1 stores=`drafts,meta`；升级后 v2=`drafts,meta,tombstones`。原 draft rev=7 和 legacy history 均保留，新 tombstone store 初始为空。

---

## 七、18 类恢复矩阵

隔离原型 18/18 通过：首次编辑、十次普通编辑、连续实时事务、coalesce 拖动、undo/redo、redo 分支、编辑截断 redo、持久化/内存预算、同名不同设计、designId 不匹配、revision 不匹配、当前 digest 不匹配、部分历史损坏、草稿有历史无、历史有版本未知、跨标签页 revision 分歧、大图片设计、恢复后继续编辑与导出。

这是隔离原型覆盖，不是正式启动自动恢复功能验证。

---

## 八、性能、预算边界与容量

| 项 | 中位数 | P95 |
|---|---:|---:|
| localStorage saveUndoStack | 2.8ms | 3.5ms |
| localStorage read + parse | 0.8ms | 1.5ms |
| IndexedDB 独立历史写 | 1.1ms | 7.9ms |
| IndexedDB 历史读 | 0.2ms | 0.3ms |
| 同库双 store 事务 | 1.1ms | 1.7ms |
| `UndoAnchor.validate`（22 条）| 0.1ms | 0.4ms |
| 22 条 per-record digest 构建 | 1.7ms | 3.7ms |

| 控件 / 提交步数 | 内存栈 | 持久化 | 字节 | digest 构建 |
|---|---:|---:|---:|---:|
| 60 / 20 | 43 | 40 | 826KiB | 4.2ms |
| 60 / 40 | 84 | 40 | 826KiB | 6.8ms |
| 120 / 20 | 101 | 37 | 1191KiB | 10.1ms |
| 120 / 40 | 101 | 29 | 1188KiB | 13.6ms |

大素材可能使单快照超过预算、持久历史为 0；P4R-2B 需明确提示“草稿保存成功，撤销历史未保存”。

---

## 九、正式接入历史恢复的阻止条件

以下条件全部满足前，禁止在正式启动中调用 `loadUndoStack`：

1. draft + history 同库同事务保存，并共用 CAS revision。
2. designId、draftRevision、index、**整条栈**与恢复设计 digest 全匹配。
3. 任一记录损坏时历史整体拒绝，保留设计并 reset 为新基准。
4. 旧 localStorage 历史没有 designId，绝不按名字自动载入。
5. 双标签页 E2E 冲突及本地保留/另存有正式自动测试。
6. 历史预算裁剪和 redo 不持久化边界明确告知用户。
7. tombstone 与历史写入纳入同事务保护范围。
8. 调用顺序严格为：draft 恢复成功 → 校验 history → 加载栈；失败只 reset，不回滚设计。

当前原型未接入启动流程，本阶段未自动进入 P4R-2B。

---

## 十、现场修改与验证边界

修改中的源码：`app.js` 单条超预算历史不得绕过 1.2MiB；`draft-store.js` v2 持久 tombstone/CAS；`draft-manager.js` 恢复后重新绑定 draft identity/revision；`index.html` 加载隔离锚点原型；新增 `undo-anchor.js` 与隔离 history-store 原型。

未修改 Android `app/`、旧设计格式、UndoStack 数据/用户可见语义；未在正式启动调用 `loadUndoStack`。当前工作树有未提交变更与用户提供的未跟踪 zip，均保留。

验证：浏览器 55 套 / 5975 断言 FAIL=0；JVM 1365 项 0/0/0。文档守卫、build guard、看板仍待最终收口执行。
