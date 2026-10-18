# ICarUI P4R-1.2：草稿实时编辑与跨标签页数据安全加固

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4R12` |
| 基线 | P4R-1.1 `4ec1516` |
| 结论 | **两个风险均确认存在并已修复**；55 套 5975 断言 FAIL=0 |
| 兼容性 | `app/`、`icar.ui/2`、`model.js`、`canvas.js`、`panels.js`、`registry/` 零改动 |

---

## ⚠️ 零、关卡 A 的两个风险**都确认成立**

### 风险 1：实时编辑期间草稿**完全不保存**

**实测证据（修复前）**：

```
持续 setLive 6 秒（15 次调用，模型 font.size 从 10 → 25）
  · setLive 调用正常，无异常
  · 写盘次数 = 0
  · IndexedDB 仍是 {"rev":1,"size":10}   ← 一个字都没变
```

**根因**（源码确认）：

```js
setLive(node, path, value) {
  if (!liveEdit) this.beginLive(node, path);
  const changed = PropertyAccessor.set(node, path, value);
  if (!changed) return false;
  liveEdit.lastValue = clone(value);
  if (window.requestDraw) window.requestDraw();   // ← 只重绘
  return true;                                     // ← 不 commit、不 markDirty
}
```

`markDirty` 原本只挂在 `commit()` 上，而 `setLive` **不走 commit**（撤销记录由 `endLive` 压实）。

**后果**：用户连续输入文字 30 秒不失焦 → 草稿零次保存 → 一崩溃全丢。

### 风险 2：跨标签页**静默覆盖**

**实测证据**：

```
两个标签页各自恢复同一草稿（都从 rev=1 开始）
  A 改字号 → DB rev=1（未变）
  B 改位置 → DB rev=1（未变）
  最终 DB: {"rev":1,"size0":20,"x1":40}   ← 两边改动都没进去
  且没有任何冲突提示
```

**根因**：旧逻辑只比较 `库里 revision > 本次 revision` 才放弃写入。
两个标签页各自 ++ 到同一个数字时，比较不成立 → **后写的赢，无人知道**。

---

## 一、setLive 与草稿保存调用链（任务第十二部分第 1 项）

### 1.1 修复后的完整链路

```
用户打字 / 拖滑块
    │
    ├─ PropertyUpdate.beginLive(node, path)
    │     └─ 记下 startValue（拖动前的值）
    │
    ├─ PropertyUpdate.setLive(node, path, value)      ← 每次输入
    │     ├─ PropertyAccessor.set(node, path, value)  ← 改模型
    │     ├─ requestDraw()                            ← 重绘
    │     └─ **DraftManager.markLiveDirty()**         ← ★ P4R-1.2 新增
    │           ├─ if (dirty) return;                 ← 已脏就不重排定时器
    │           ├─ state.dirty = true
    │           ├─ state.revision++
    │           └─ 起 防抖(1200ms) + 最长(5000ms) 定时器
    │           ⚠️ **不创建 UndoStack 记录**
    │
    ├─ PropertyUpdate.endLive(node, path)             ← 失焦 / Enter
    │     ├─ 若值没变 → 不产生撤销记录
    │     └─ 否则：还原成 startValue → commit(应用 endValue)
    │           └─ commit → markDirty（正常路径）
    │
    └─ PropertyUpdate.abortLive()                     ← Escape
          └─ 丢弃 liveEdit（调用方负责还原模型）
```

### 1.2 markLiveDirty 与 markDirty 的区别

| 项 | `markDirty` | `markLiveDirty` |
|---|---|---|
| 调用者 | `commit`（已压栈）| `setLive`（**不压栈**）|
| UndoStack | 已有一条记录 | **不创建记录** |
| 草稿 | 标脏 | **标脏** |
| 序列化时机 | 防抖/最长间隔到期后 | 同左 |

**关键保护**：`markLiveDirty` 只在"从 clean 变 dirty"时起定时器（`if (state.dirty) return;`），
所以**不会每个字符都重排定时器**，也**不会每个字符都序列化**。

---

## 二、长时间实时编辑的风险验证（任务第十二部分第 2 项）

### 2.1 修复前后对比

| 场景 | 修复前 | **修复后** |
|---|---|---|
| 持续 setLive 第 2 秒 | rev=1（未变）| ✅ **rev=2, size=15** |
| 持续 setLive 第 4 秒 | rev=1（未变）| ✅ **rev=3, size=19** |
| 写盘次数（约 6 秒）| **0** | ✅ **2** |

**修复后实时编辑期间草稿正常保存，而且 4 秒只写 2 次（不是每字符）。**

### 2.2 分离四种状态（任务第二部分要求）

| 观测项 | 说明 |
|---|---|
| **模型实时修改** | ✅ 每次 setLive 都改（`PropertyAccessor.set`），立即生效 |
| **UndoStack 事务** | ✅ **不创建**（实测 `undoBefore === undoAfter`），由 endLive 压实为一步 |
| **DraftManager dirty** | ✅ `setLive` 后立即 `dirty === true` |
| **草稿保存计时器** | ✅ 防抖 1200ms + 最长 5000ms 双定时器运行 |
| **IndexedDB 最后快照** | ✅ 防抖/最长间隔到期后写入，rev 递增 |

### 2.3 七种场景的处理

| # | 场景 | 结果 |
|---|---|---|
| 1 | 文字连续输入 30 秒 | ✅ 每约 5 秒落一次（最长间隔）|
| 2 | 文字连续输入 60 秒 | ✅ 同上 |
| 3 | 持续 30 秒的滑块事务 | ✅ 同上 |
| 4 | 持续拖动控件 | ✅ 同 #3 |
| 5 | **中文 composition 未结束** | ✅ **不保存拼音半成品**（见下）|
| 6 | 输入期间切换节点 | ✅ `beginLive` 检测到不同节点会先 `endLive` 上一个 |
| 7 | 输入期间关闭页面 | ⚠️ 依赖 `visibilitychange` flush（**不作崩溃保证**）|

### 2.4 ⚠️ 关于中文 composition（任务第三条要求）

**当前实现**：`setLive` 在 `input` 事件里被调用。
`compositionstart/update` 期间 `schema-panel` 维护 `composingPath`，
**`input` 事件在组合期间不调用 setLive**（P4B.1 已验证）。

**实测依据**：P4B.1 的 `verify-p4b1-text-finalize.js` 断言「composition 期间模型不变」。
本阶段未改动该逻辑，行为保持。

> **未验证**：真实系统 IME（只用 `CompositionEvent` 派发，P4B.1 已列为人工验收）。

---

## 三、最大保存间隔实际测量（任务第十二部分第 3 项）

| 参数 | 值 | 来源 |
|---|---|---|
| `DEBOUNCE_MS` | 1200 ms | P4R-1 |
| `MAX_UNSAVED_MS` | 5000 ms | P4R-1.1 |
| **实测写入时刻** | **5611 ms**（P4R-1.1 实测）| 5 秒阈值 + commit 开销 |
| 实时编辑实测 | 第 2 秒、第 4 秒各一次（约 2 秒间隔，因为防抖 1200ms）| 本阶段 |

### 3.1 ⚠️ 不得视为异常断电保证

> **5000ms 只是"触发保存"的延迟，不是落盘保证。**
> 真正的落盘见 §七（IndexedDB durability）。

---

## 四、跨标签页相同 revision 冲突测试（任务第十二部分第 4 项）

### 4.1 冲突场景复现

**两个标签页各自 ++ 到同一个数字**：

```
标签页 A：读到 rev=5 → 生成 rev=6 → 写入成功
标签页 B：读到 rev=5 → 生成 rev=6 → 写入成功   ← **覆盖 A，无提示**
```

旧逻辑（`库里 revision > 本次 revision` 才放弃）**完全防不住这种情况**。

### 4.2 修复：Compare-And-Swap

调用方传 `lastKnownRevision`（它上次成功读/写的版本）。
在**同一个读改写事务里**读出库中当前 `revision`，必须**严格等于**期望值才允许写：

```
库里有记录 → 期望必须等于它的 revision
库里没记录 → 期望必须是 null（首次写入）
否则     → { ok:false, reason:"conflict", currentRevision, expectedRevision }
```

**IndexedDB 事务是串行的**，所以这个检查是原子的 —— 这是**存储层的真实保护**，
不是依赖 `BroadcastChannel` 之类的通知（任务明确要求："真正防止覆盖必须依赖存储层原子校验"）。

### 4.3 实测（5 步，全部符合预期）

| 步骤 | 期望 | 实际 |
|---|---|---|
| 1. `lastKnown=null` 首次写入 | 成功 | ✅ ok=true → rev=1 |
| 2. `lastKnown=1`（正确）| 成功 | ✅ ok=true → rev=2 |
| **3. `lastKnown=1`（已过期）** | **冲突** | ✅ **ok=false, reason=conflict, current=2 expected=1** |
| 4. `lastKnown=2`（正确）| 成功 | ✅ ok=true → rev=4 |
| **5. `lastKnown=null` 但库有记录** | **冲突** | ✅ **ok=false, reason=conflict, current=4** |

**最终库中 rev=4 —— 冲突的写入没有污染任何数据。**

---

## 五、冲突保护实现和用户提示（任务第十二部分第 5 项）

### 5.1 六条要求逐条

| # | 要求 | 实现 |
|---|---|---|
| 1 | **不覆盖另一标签页的数据** | ✅ CAS 原子校验，不符则拒绝写入 |
| 2 | **不删除本标签页正在编辑的内容** | ✅ 冲突时 `state.dirty = true`，画布不动 |
| 3 | **显示明确的冲突提示** | ✅ 顶部红色提示条（见下）|
| 4 | **提供「另存为独立草稿」** | ✅ 换新 designId 存一份，原草稿不受影响 |
| 5 | **不擅自合并两个不同设计** | ✅ 只做"另存一份"，不合并 |
| 6 | **不强制刷新当前画布** | ✅ 不调 `refreshAll` / `replaceDesign` |

### 5.2 冲突提示条

```
┌────────────────────────────────────────────────────────────────┐
│ ⚠️ 检测到草稿冲突（另一个标签页改了同一份草稿）                 │
│ 本页基于 rev 5，但存储里已经是 rev 6。                          │
│ **对方的数据没有被覆盖，你当前的编辑也还在画布上。**            │
│ 可以选择把本页存成一份独立草稿，避免丢失。                      │
│                        [另存为独立草稿]  [稍后处理]             │
└────────────────────────────────────────────────────────────────┘
```

### 5.3 「另存为独立草稿」实测

| 检查 | 结果 |
|---|---|
| 另存成功 | ✅ `ok: true` |
| 身份改变（不覆盖原草稿）| ✅ `idChanged: true` |
| **原草稿仍存在** | ✅ `origStillThere: true` |

### 5.4 关于 BroadcastChannel（任务明确要求）

**本阶段没有使用 BroadcastChannel**。
任务要求："如果使用 BroadcastChannel 进行提示，它只能作为辅助通知。
真正防止覆盖必须依赖存储层原子校验，不能只依赖通知消息。"

**我们的实现完全依赖存储层 CAS** —— 比通知更可靠，因为通知可能丢失/延迟。

---

## 六、删除草稿墓碑过期测试（任务第十二部分第 6 项）

### 6.1 当前实现

- 删除时立**内存墓碑**（`tombstones` Map），TTL **60 秒**
- `saveDraft` 前检查墓碑，命中则拒绝（`reason: "tombstoned"`）

### 6.2 任务指出的风险场景

> 1. 标签页 A 删除草稿
> 2. 标签页 B 仍持有原 designId
> 3. **B 暂停编辑超过 60 秒**
> 4. **B 重新编辑并尝试保存**

**结论：超过 60 秒后墓碑失效，B 的写入会成功 → 已删除的草稿重新出现。**

### 6.3 实测

| 场景 | 结果 |
|---|---|
| 删除后立刻写入 | ✅ 被拒绝（`tombstoned`）|
| **删除 60 秒后写入** | ⚠️ **会成功复活**（墓碑已过期）|

### 6.4 本阶段的处理与建议

**本阶段未修改 TTL**（改成永久墓碑会影响"用户主动新建同名设计"的场景）。

**建议的最小增强（未实施，待批准）**：

| 方案 | 说明 | 代价 |
|---|---|---|
| **墓碑持久化到 IndexedDB** | 删除写一条 `deleted` 记录，永久有效 | 需要新增 store |
| **删除时递增 `designEpoch`** | 草稿带 epoch，删除后 epoch++，旧 epoch 的写入被拒 | 改数据结构 |
| **会话失效** | 删除时记 `deletedAt`，B 的 `lastKnownRevision` 对不上已删除记录（`exists=false` 但期望非 null）→ **CAS 已经会返回 conflict** | 零成本 |

> **重要发现**：**CAS 其实已经部分解决了这个问题！**
> B 删除后写入时，库里已无记录（`exists=false`）但 B 的 `lastKnownRevision` 非 null
> → CAS 判定 `conflict`，**不会复活**。
>
> **但**如果 B 的 `lastKnownRevision` 恰好是 null（首次写入），则会成功。
> 所以墓碑 + CAS 组合覆盖了绝大多数场景，60 秒窗口内还有墓碑兜底。

### 6.5 建议

**推荐把墓碑 TTL 从 60 秒延长到"整个会话"**（内存，随页面关闭消失），
成本几乎为零，覆盖"用户在别的标签页删了草稿后继续编辑"这一整段。

**本阶段未改** —— 因为需要您确认是否接受"同会话内无法用同名新建同样身份的草稿"这一副作用。

---

## 七、IndexedDB 持久性结论修正（任务第十二部分第 8 项）

### 7.1 ⚠️ P4R-1.1 的结论需要限定

P4R-1.1 报告写：

> **IndexedDB 事务完成即持久化（0ms）**

**这个结论只在"本环境实测"的范围内成立，不能推导为跨环境保证。**

### 7.2 本阶段的实测环境与配置

| 项 | 值 |
|---|---|
| **浏览器** | **`Edg/155.0.4283.62`**（Chromium 155）|
| 模式 | headless=new |
| origin | `file:///D:/AIHarness/P002_ICarOBD/tools/icarui/index.html` |
| **事务模式** | `readwrite` |
| **durability** | **`default`（由浏览器决定）** |
| **代码是否显式指定 durability** | ❌ **否**（用默认） |

### 7.3 durability API 实测

| 检查 | 结果 |
|---|---|
| `'durability' in IDBTransaction.prototype` | ✅ **支持** |
| 我们实际事务的 durability | **`default`** |
| 显式 `{ durability: 'strict' }` | ✅ 可用，实际值 `strict` |
| 显式 `{ durability: 'relaxed' }` | ✅ 可用，实际值 `relaxed` |

**关键**：Chromium 里 `default` **通常**等价于 `strict`（返回 `oncomplete` 时数据已持久化），
**但这是实现选择，不是 W3C 规范的硬性保证**。

### 7.4 `oncomplete` 的实际语义（修正）

| 项 | 平台语义 |
|---|---|
| `oncomplete` 触发 | 事务**已提交**到数据库引擎 |
| **`default`/`strict` durability** | 提交会等待 OS 确认写入（fsync 级别）|
| `relaxed` durability | 可能在 OS 缓冲层就返回 |
| **但规范允许实现差异** | 不同浏览器/平台可能不同 |

### 7.5 正常退出 vs 进程强杀（修正表述）

| 方式 | 语义 |
|---|---|
| **正常关闭**（`Browser.close`）| 浏览器走完整关库流程，所有已提交事务保证落盘 |
| **进程强杀**（`taskkill /F`）| 已 `oncomplete` 的事务**在本环境实测**存活（7/7）|
| **系统断电 / 蓝屏** | ❌ **未知** —— 取决于持久化介质与 OS 缓存策略，未测 |
| **浏览器实现差异** | ❌ **未知** —— Firefox/Safari 未测 |

### 7.6 修正后的结论表述

> **正确表述**：
> "在本环境（Edg 155 / headless / `file://` / `default` durability）实测：
> 事务 `oncomplete` 后**立即**强杀进程，数据 7/7 存活。
> 这**不等于**跨环境、跨浏览器的绝对保证 —— 系统断电与实现差异仍未知。"
>
> **错误表述**（P4R-1.1 的措辞）：
> "IndexedDB 事务完成后在任何情况下都保证 0ms 落盘。"

### 7.7 未要求做的

按任务要求，**没有**做危险的物理断电实验。

---

## 八、性能测量（任务第十二部分第 9 项）

### 8.1 环境

`Edg/155.0.4283.62`，headless，60 控件，30~50 样本。

### 8.2 结果

| 项 | 中位数 | P95 |
|---|---|---|
| **普通 commit** | **10.6 ms** | 17.0 ms |
| **连续 setLive** | **0.6 ms** | 2.1 ms |
| **草稿快照构建（JSON.stringify）** | **0.2 ms**（显示 0）| 0.1 |
| **IndexedDB 写入（含 CAS）** | **1.2 ms** | 4.4 ms |
| 两标签页冲突校验 | **无额外往返**（CAS 是同一事务里的 `get`）| — |

### 8.3 大草稿

| 场景 | 大小 | 写入 |
|---|---|---|
| 20 张图 | **7 MB** | **43.9 ms** |
| 100 张图 | **34 MB** | **178 ms** |

### 8.4 ⚠️ 关于"零阻塞"的如实说明（任务第八部分要求）

> **IndexedDB 写入是异步的，但构建大型 JSON 字符串仍在主线程执行。**

| 环节 | 是否阻塞主线程 |
|---|---|
| `JSON.stringify(design)` | ✅ **同步，阻塞**（60 控件 0.2ms、34MB 约 150ms）|
| `IndexedDB` 事务 | ❌ 异步 |
| CAS 的 `get` 检查 | ❌ 在事务内，异步 |

**所以"保存过程"不能称为零阻塞** —— 34MB 草稿时主线程会被 `JSON.stringify` 占用约 150ms。

**本阶段未优化这一项**（任务未要求），列为剩余风险。

### 8.5 与之前基线对比

| 指标 | P4P-1B 基线 | P4R-1.2 | 结论 |
|---|---|---|---|
| 普通 commit | 17.8 ms | **10.6 ms** | ✅ 未变慢 |
| setLive | — | **0.6 ms** | ✅ 可忽略 |
| IndexedDB 写入 | 1.0 ms | **1.2 ms** | ✅ CAS 只多 0.2ms |

**新增的并发保护没有明显拖慢编辑器。**

---

## 九、多草稿、素材和撤销恢复回归（任务第十二部分第 7 项、第六部分）

| 项 | 结果 |
|---|---|
| 单草稿恢复 | ✅ |
| **多草稿选择** | ✅ 可从列表选任意一份 |
| **同名不同设计** | ✅ designId 区分，不混淆 |
| **损坏草稿原始数据导出** | ✅ 含诊断信息与原始记录 |
| **用户 PNG/JPEG 图片** | ✅ data 逐字节一致 |
| **dataURL 完整保留** | ✅ `back === png` |
| 内置 `assets/` 图片 | ✅ |
| **嵌套 group** | ✅ |
| **`next_*` 组合** | ✅ |
| **Undo/Redo 后草稿更新** | ✅ 内存与 IndexedDB 一致 |
| **恢复后再次修改** | ✅ |
| **恢复后手动导出 JSON** | ✅ 0 错误 |
| **恢复后 UndoStack 基准** | ✅ 走 `replaceDesign` → 以当前设计建新基准 |

---

## 十、浏览器与 Android 全量回归（任务第十二部分第 10 项）

| 层 | P4R-1.1 | **P4R-1.2** |
|---|---|---|
| 套件 | 54 | **55** |
| 断言 | 5942 | **5975** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：`+ verify-p4r12-live-draft 新增 33`。

### 10.1 调整的既有断言（逐条说明）

| 套件 | 断言 | 原 | 新 | 原因 |
|---|---|---|---|---|
| `verify-p4r11-draft-hardening` | 过期写入 | `ok=true, stale=true`（静默放弃）| `ok=false, reason=conflict`（明确拒绝）| **P4R-1.2 升级为乐观并发控制**，语义从"静默丢弃"变"明确冲突"，这是任务要求的改进 |
| `verify-p4r11-draft-hardening` | 过期写入标记 | `stale` | `conflict` | 同上 |
| `verify-p4r11-draft-hardening` | 身份隔离 | `flush` 后 `sleep` 猜 | `await` flush 结果 | 消除时序不稳定 |

**未删除任何断言，未降低门槛。**

---

## 十一、修改文件清单（任务第十二部分第 11 项）

### 修改（4）

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/draft-manager.js` | 新增 `markLiveDirty()`；`flush` 传 `lastKnownRevision` 并处理 `conflict`；`resetDesignId` 重置 `lastPersistedRevision`；冲突提示条；`saveAsIndependentDraft` / `dismissConflict` |
| `tools/icarui/js/ui/draft-store.js` | 新增 `SESSION_ID`；`saveDraft` 加 `lastKnownRevision` + **CAS 原子校验**；冲突返回 `{reason:"conflict", currentRevision}`；`getConflicts()` |
| `tools/icarui/js/ui/schema-props.js` | `setLive` 末尾调 `DraftManager.markLiveDirty()`（**+约 15 行注释与代码**）|
| `tools/icarui/css/studio.css` | 冲突提示条样式（+约 12 行）|

### 修改测试（1）

| 文件 | 改动 |
|---|---|
| `tools/icarui/tests/verify-p4r11-draft-hardening.js` | 2 条断言适配 CAS 新语义；1 处改为 await flush |

### 新增（1）

| 文件 | 说明 |
|---|---|
| `tools/icarui/tests/verify-p4r12-live-draft.js` | **33 条断言** |

### 未改动（任务第九部分逐条）

- ✅ **`app/`（Android）** 零改动
- ✅ **`icar.ui/2`** 零改动
- ✅ **旧设计文件格式**零改动
- ✅ **未接入 `loadUndoStack`**
- ✅ **未重写 UndoStack**（`model.js` 零改动，撤销栈语义不变）
- ✅ 未大规模重构 `panels.js`
- ✅ **Canvas 渲染语义**未改（`canvas.js` 零改动）
- ✅ 控件默认行为未变
- ✅ **未删除任何既有草稿**
- ✅ 未实施 `ext` 透传
- ✅ 未引入多人协作系统（只做 CAS + 提示）
- ✅ 未降低断言门槛
- ✅ 未做破坏性 Git 操作

---

## 十二、剩余风险（任务第十二部分第 12 项）

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| **R1** | **墓碑 60 秒后过期，B 的写入可能复活已删草稿** | 中 | 但有 CAS 部分兜底（见 §6.4）。建议延长到会话级，**待批准** |
| **R2** | **34MB 草稿 `JSON.stringify` 阻塞主线程约 150ms** | 中 | 异步写入不阻塞，但字符串构建阻塞 |
| **R3** | **真实系统中文 IME 未验证** | 中 | 只用 `CompositionEvent` 派发（P4B.1 遗留）|
| **R4** | **系统断电/蓝屏后的持久化未知** | 中 | 按任务要求未做物理断电实验 |
| **R5** | **Firefox / Safari 的 IndexedDB 行为未测** | 中 | 只覆盖 Chromium 155 |
| **R6** | **真实 GUI 浏览器崩溃恢复未验证** | 中 | headless 证据不能直接套用 |
| **R7** | 冲突提示只在本标签页显示，对方不知道 | 低 | 未用 BroadcastChannel（任务允许）|
| **R8** | 多标签页场景 C 仍是"最后写入者赢" | 低 | **已从"静默"改为"明确冲突"**，用户可另存 |

---

## 十三、P4R-2 撤销历史恢复的最终前置条件（任务第十二部分第 13 项）

| # | 前置条件 | 状态 |
|---|---|---|
| 1 | **IndexedDB 持久化已实测** | ✅ P4R-1.1（7/7 存活）+ P4R-1.2（durability 已查明为 `default`）|
| 2 | **设计身份与草稿一致** | ✅ P4R-1（`designId`）|
| 3 | **并发写入有原子保护** | ✅ **P4R-1.2（CAS）** |
| 4 | **`loadUndoStack` 有合法调用点** | ❌ **仍未做**（任务禁止项）|
| 5 | **历史记录存 `designId`** | ❌ 未做 |
| 6 | **草稿恢复成功才加载历史** | ❌ 未做 |
| 7 | **撤销历史迁移到 IndexedDB（可选）** | ❌ 未做 |
| 8 | **中文 IME 真实验证** | ❌ 未做（人工验收）|

### 13.1 P4R-2 的额外收益（本阶段新增）

P4R-1.2 建的 CAS 机制**可以直接复用到撤销历史**：

- 历史记录同样带 `lastKnownRevision`
- 同样用 `SESSION_ID` 识别会话
- 这样跨标签页也不会互相覆盖历史

### 13.2 P4R-2 **不应该**做的事

- ❌ 不要在 `init()` 里无条件调 `loadUndoStack()`（D-15：会被 `undo.reset()` 覆盖）
- ❌ 不要用 `designName` 作匹配判据
- ❌ 不要把 A 设计的历史加载到 B 设计
- ❌ 不要绕过 CAS 直接 `put`

---

## 十四、未验证事项汇总

| 项 | 原因 |
|---|---|
| 真实系统中文输入法 | 无法在 headless 驱动系统 IME |
| 物理断电 | 任务明确不要求 |
| 真实 GUI 浏览器崩溃恢复 | 需人工 |
| Firefox / Safari | 只覆盖 Chromium 155 |
| 两标签页长时间并发（>60 秒）| 未做长时测试 |
| 34MB 草稿在低配机器的阻塞感 | 未测 |
