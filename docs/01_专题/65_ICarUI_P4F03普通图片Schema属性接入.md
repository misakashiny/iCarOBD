# ICarUI P4F-03：普通图片控件 Schema 属性面板接入

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-21（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4F03` |
| 起点 | `505139c`（P4F-02 已同步）|
| 结论 | 新增 **`image` 族（6 字段）**；修正 `isPlainImage()` 误判；素材选择器复用 `<select>`；**P4R-FIX-01 零回归**；43 断言全绿；65 套 6331 断言 FAIL=0 |
| 数据契约 | **零变更**（Registry 仍 69，未加条目）|

---

## 一、普通图片识别规则

### 1.1 三种 `type === "image"` 节点的区分

| 节点 | 判据 | 族 |
|---|---|---|
| **状态灯** | `states` 是含 `normal`/`warn`/`critical` 的对象 | `imageState` |
| **条形轨道** | `trackStyle` 是对象 | `track` |
| **普通图片** | 上述两者都不满足 | **`image`（新增）** |

### 1.2 ⚠️ 修正的既有缺陷

原 `isPlainImage()` 实现：

```js
isPlainImage(node) {
  return !!node && node.type === "image" &&
    (node.trackStyle === null || node.trackStyle === undefined);
}
```

**缺陷**：状态灯 `states ≠ null` 但 `trackStyle === null` → **被误判为普通图片**（实测 `isPlainImage(lamp) === true`）。

虽然 `resolve()` 里状态灯分支在前、实际不会走错，但该函数**被单独调用时会给出错误答案**。

**修正**：显式排除 `states`：

```js
isPlainImage(node) {
  if (!node || node.type !== "image") return false;
  if (node.trackStyle !== null && typeof node.trackStyle === "object") return false;
  const st = node.states;
  if (st && typeof st === "object" && !Array.isArray(st)) {
    if (st.normal || st.warn || st.critical) return false;
  }
  return true;
}
```

**`resolve()` 分支顺序**（保证优先级）：

```
容器 → 仪表 → 文字 → 状态灯 → 【新增 图片】 → 轨道 → null
```

---

## 二、实际开放的 Schema 字段（6 个）

| # | 字段 | 类型 | 范围 | 依据 |
|---|---|---|---|---|
| 1 | `assetId` | **asset（素材选择器）** | — | nodeToJson 通用块 |
| 2 | `w` | number | ≥1 | 同 container |
| 3 | `h` | number | ≥1 | 同 container |
| 4 | `rotation` | number | 任意 | 同 container |
| 5 | `scale` | number | >0 | 同 container |
| 6 | `alpha` | number | 0..255 | clampInt(0,255) |

**刻意不开**：`locked` / `visible` —— 属"通用布局"而非"图片属性"，
与容器族 (P4C) 口径保持一致，未纳入本批。

### 2.1 ⚠️ 为什么没有往 Registry 加第 70 条

普通图片**不是预置控件**：由用户从素材库拖入或导入产生，没有 `__controlKey`，
不应出现在控件库里。Registry = 69 是既定契约（catalog declared 8 / derived 69 / probe 138），
**加一条会连带破坏大量既有断言，属于改契约**。

因此 `imageSchemaFor()` 采用：
1. **优先**从 Registry 找 `render.mode === "image"` 的条目（若将来有人注册）
2. **回退**到内置 schema（当前唯一来源）

实测：**Registry 仍 69 条，image 模式条目 0 条。**

---

## 三、素材选择实现方式

### 3.1 旧面板的做法（已核对）

```js
function imageFields(n) {
  const opts = (S.design.assets || []).map(a =>
    '<option value="' + attr(a.id) + '"' + (n.assetId === a.id ? " selected" : "") + '>' +
    esc(a.name) + '（' + esc(a.kind) + '）</option>').join("");
  return [row("素材", '<select onchange="setNodeStr(\'assetId\',this.value)">' +
    '<option value="">（未选）</option>' + opts + '</select>'), ...];
}
```

→ **下拉 `<select>`，选项来自 `design.assets`，显示「名称（类型）」**。

### 3.2 Schema 面板的实现（等价，非文本框）

新增 **`type: "asset"`** 控件类型：

| 特性 | 实现 |
|---|---|
| 控件形态 | **`<select>` 下拉**（不是 `input`）|
| 选项来源 | `CanvasState.design.assets`（**动态**，每次刷新重建）|
| 显示文本 | `名称（类型）` —— 与旧面板完全一致 |
| 首项 | 「（未选）」= `assetId` 为空 |
| 回显 | 当前 `assetId` 命中则选中 |
| **素材丢失** | 额外显示「（素材已丢失: id）」并选中 —— **明确提示，不静默回退** |
| 性能 | 选项签名未变则**不重建 DOM**，不打断用户操作 |

### 3.3 切换素材后的绘图缓存更新

```js
if (field.type === "asset" && window.refreshAll) window.refreshAll();
```

走**既有链路**：`syncAssetImages()` 按新 `assetId` 重新解析图片并更新绘图缓存，
P4R-FIX-01 的「原图优先于缩略图」逻辑也在这条链路里。
**不碰 `asset.data`、不改 IndexedDB、不动持久化政策。**

---

## 四、P4R-FIX-01 防回归结果

| # | 要求 | 结果 |
|---|---|---|
| 1 | 原始高清图优先于缩略图 | ✅ `loadAssetImage`/`syncAssetImages`/`restoreThumbs` 均未改动 |
| 2 | 正式 Canvas 不用 64×64 预览图 | ✅ 未触及缩略图逻辑 |
| 3 | **修改图片属性不覆盖 `asset.data`** | ✅ **实测：改 5 个属性后 `data` 引用完全相同、长度不变、仍是 dataURL** |
| 4 | 保存草稿刷新后保持原分辨率 | ✅ 未改动草稿/持久化路径 |
| 5 | 原图路径失效后仍可恢复 | ✅ `asset.data`（内联）优先，未改动 |
| 6 | **同原图多素材 ID 不混淆** | ✅ 实测两个节点各指 `a1`/`a2`，独立引用 |
| 7 | 保持既有大小限制与降级行为 | ✅ 未改动限制逻辑 |
| 8 | **素材切换后正确更新绘图缓存** | ✅ 触发 `refreshAll()` → `syncAssetImages()` |
| 9 | 不清空 IndexedDB、不删草稿 | ✅ 全程未触碰 |

**结论：P4R-FIX-01 零回归。**

---

## 五、修改文件清单

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | ① 修正 `isPlainImage()`（排除 states）② 新增 `EDITABLE.image`（6 字段）③ 新增 `imageSchemaFor()` ④ `buildControl` 支持 `asset` 类型 ⑤ 新增 `renderAssetOptions()` ⑥ `update()` 增加 asset 回显分支 ⑦ `resolve()` 增加 image 分支 |
| `tools/icarui/js/ui/schema-panel.js` | ① `change` 事件支持 `asset`（含 refreshAll 刷新缓存）② 面板头部补「图片」族名 |
| `tools/icarui/tests/verify-p4f03-image-schema.js` | **新增 43 断言** |
| 5 个既有套件 | 普通图片断言前提修正（见 §6.3）|
| `tools/icarui/tests/expected-counts.json` | +43 |
| 文档 | 专题 65 + 验证记录 + **P4F-GUI-002 新建** + **TRACK-APP-001 技术债** + 索引 |

**未改**：`app/`（Android）、`model.js`、`schema.js`、`panels.js`（旧面板保留）、
`icar.ui/2` 契约、P4R 恢复系统、素材导入流程、渲染器。

---

## 六、全量测试结果

### 6.1 新增套件 `verify-p4f03-image-schema.js` —— **43 断言（A–M）全绿**

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 普通图片识别；状态灯/轨道/仪表/文字/容器**不误判** | ✅ |
| B | 6 字段；`assetId` 使用 asset 类型（非文本框）| ✅ |
| C | **素材选择器是 `<select>`、3 选项、回显 a1、显示「名称（类型）」** | ✅ |
| D | 素材替换 + 触发 refreshAll | ✅ |
| E | 宽/高/旋转/缩放/透明度全部可编辑 | ✅ |
| F | **【P4R-FIX-01】`asset.data` 不被覆盖** | ✅ |
| G | 高清链路三个函数仍在 | ✅ |
| H | **多素材 ID 独立引用不混淆** | ✅ |
| I | Undo/Redo | ✅ |
| J | 导出→重导入 6 字段一致 | ✅ |
| K | 旧面板 `setNodeStr` 仍在 | ✅ |
| L | **Registry 仍 69、无 image 条目** | ✅ |
| M | 非法输入不破坏设计 | ✅ |

### 6.2 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **65 套 / 6331 断言 / FAIL=0** |
| Android JVM | **1365 项 0/0/0** |

### 6.3 五处既有断言前提修正（非放宽门槛）

普通图片此前一直是「未被 Schema 接管」的样本，P4F-03 后它**正常接入**，
导致 5 个套件里以「普通图片 family === null」为前提的断言**前提失效**（不是行为退化）。

| 套件 | 原断言 | 修正后 | 断言数 |
|---|---|---|---|
| `verify-p4a-schema-props` | 用普通图片测「未接管→回退旧面板」| 改用**人为构造的无族节点**（保持原语义）| 70 → **72** |
| `verify-p4d01-lamp-schema` | `plainFamily==='null'` | `plainFamily==='image'` | 32（不变）|
| `verify-p4e02-gauge-schema` | `plainFam==='null'` | `plainFam==='image'` | 38（不变）|
| `verify-p4e04-gauge-appearance` | `fam==='null'` | `fam==='image'` | 44（不变）|
| `verify-p4f02-track-schema` | `plain==='null'` | `plain==='image'` | 38（不变）|

**修正后的断言比原来更精确**（原来是"不是任何族"，现在是"是 image 族"），
未删任何断言、未降门槛。

---

## 七、Android 兼容结果

| 项 | 结果 |
|---|---|
| `app/` 改动 | ❌ 零 |
| `icar.ui/2` 契约 | ❌ 零（`assetId`/`w`/`h`/`rotation`/`scale`/`alpha` 全是既有字段）|
| JVM 回归 | ✅ **1365 项 0/0/0** |
| 新增字段 | ❌ **无**（未新增任何持久化字段）|

---

## 八、GUI 待验收卡片

### 新建 `P4F-GUI-002`：**0 / 8 项**（全部未验收）

| # | 项目 |
|---|---|
| ① | Schema 面板显示图片属性（6 字段）|
| ② | 素材选择与替换 |
| ③ | 高清图片显示（非 64×64）|
| ④ | 宽高及变换 |
| ⑤ | Undo/Redo |
| ⑥ | 保存恢复 |
| ⑦ | 原文件路径失效后的恢复 |
| ⑧ | 导出导入一致性 |

### 保留的既有卡片（**均未改动**）

| 卡片 | 状态 |
|---|---|
| `P4R-GUI-001` | 2/7 |
| `P4D-GUI-001` | 0/7 |
| `P4E-GUI-001` | 0/15 |
| `P4F-GUI-001` | 0/9 |

> ⚠️ **不得因自动测试通过而标记 GUI 人工验收通过。**

---

## 九、跨端技术债 `TRACK-APP-001`

已登记到 `docs/03_开发进度与问题清单.md`（含看板白话）：

| 项 | 内容 |
|---|---|
| **ID** | `TRACK-APP-001` |
| **问题** | ICarUI 的轨道外观（`trackStyle` 的 11 个字段）**未被 Android 运行端消费** |
| **影响** | 用户在编辑器里调好的圆角/渐变/刻度/色带，**在平板 App 上看不到**，只会显示底图 |
| **Android 现状** | `app/src/main/java` 中**完全没有** `trackStyle` 相关代码；Android 只认 `assetId` 走贴图 |
| **范围** | 28 个 track 控件 |
| **建议** | 后续专项审计：① 确认 App 侧是否计划支持代码绘制轨道 ② 若不支持，考虑在编辑器内提示用户 |

**本任务仅登记，不实施 Android 轨道渲染器改造。**

---

## 十、GitHub 提交与推送证明

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/misakashiny/iCarOBD` |
| 分支 | `main` → `origin/main` |
| 起点 Hash | `505139c` |
| 本次提交 | 见提交后补记 |
| 推送结果 | 见提交后补记 |

---

## 十一、已知风险与下一阶段建议

### 11.1 已知风险

| # | 风险 | 级别 |
|---|---|---|
| R1 | 普通图片无 Registry 条目，用内置 schema（若将来加 Registry 条目需同步）| 低 |
| R2 | `assetId` 指向已删素材时显示「素材已丢失」，但**不自动清理** | 低（明确提示优于静默）|
| R3 | `locked`/`visible` 未纳入 image 族（口径与 container 一致）| 低 |
| R4 | `TRACK-APP-001`：轨道外观 App 端不呈现 | 中（已登记技术债）|

### 11.2 下一阶段建议

按 P4F-01 审计，剩余批次：

| 批次 | 内容 | 优先级 | 工作量 |
|---|---|---|---|
| **3** | text `w`/`h` + container `scale` | P2 | 很小 |
| 4 | gauge 子部件/色带 | P2 | **大**（需新 UI）|
| 5 | 清理 4 个未实现字段 | P3 | 极小 |

**建议下一轮做批次 3**（投入最小、补齐 text/container 的遗漏字段）。

---

**P4F-03 完成。停止，不启动 P4F-04。**
