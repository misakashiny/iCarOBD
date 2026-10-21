# ICarUI P4F-02：28 个条形轨道 Schema 属性补齐

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-21（Asia/Shanghai）|
| 任务 | `T-UI-REFACTOR-P4F02` |
| 起点 | `eb0456c`（P4F-01 审计已同步）|
| 结论 | **track 族 4 → 11 字段全部开放**，28/28 控件识别；38 条新断言全绿；64 套 6288 断言 FAIL=0 |
| 数据契约 | **零变更**（字段早已存在，只扩开放范围）|

---

## 一、7 个字段的详细审计表

### 1.1 核心结论：**全部是标量，无对象/数组**

| 字段 | 数据类型 | 默认值 | 取值范围 | 旧面板编辑 | Registry Schema | PropertyAccessor | 序列化/解析 | Android | 专用控件 |
|---|---|---|---|---|---|---|---|---|---|
| `trackStyle.radius` | **number** | `short/2`（h=16 时 8）| **0..64**（`Math.round` 夹取）| `setTrackField('radius',…)` 数字框 | `type:"number"`, `min:0`, **`max:64`（本任务补）** | `set(n,'trackStyle.radius',v)` 直写子路径 ✅ | `normalizeTrackStyle` 读写 | ⚠️ 见 §7 | ❌ 不需要 |
| `trackStyle.inset` | **boolean** | `false` | true/false | 复选框 | `type:"boolean"` | 直写 ✅ | 同上 | 同上 | ❌ |
| `trackStyle.gradient` | **enum（字符串）** | `null` | `null` / `"fade"` / `"gloss"` | 下拉（`TRACK_GRADIENTS`）| `type:"enum"`, `values:[null,"gloss","fade"]` | 直写 ✅ | 非法值 → `null` | 同上 | ❌（枚举下拉即可）|
| `trackStyle.ticks` | **number** | `0` | `0..64`（`MAX_TRACK_TICKS`）| 数字框 | `type:"number"`, `min:0` | 直写 ✅ | `count(v, MAX_TRACK_TICKS)` | 同上 | ❌ |
| `trackStyle.band` | **boolean** | `false` | true/false | 复选框 | `type:"boolean"` | 直写 ✅ | 同上 | 同上 | ❌ |
| `w` | **number** | `240` | ≥1 | 通用变换 | `type:"number"`, `min:1` | 直写 ✅ | 标准 | 同上 | ❌ |
| `h` | **number** | `16` | ≥1 | 通用变换 | `type:"number"`, `min:1` | 直写 ✅ | 标准 | 同上 | ❌ |

### 1.2 特别验证：`gradient` / `ticks` / `band` 都不是复杂结构

任务要求「不能假设 gradient、ticks、band 是简单类型」。实测源码：

```js
// schema.js normalizeTrackStyle（唯一真源）
let gradient = null;
if (o.gradient !== undefined && o.gradient !== null && o.gradient !== "") {
  gradient = (o.gradient === "fade" || o.gradient === "gloss") ? o.gradient : null;
}
out.gradient = gradient;                      // ← 字符串或 null

out.ticks = count(o.ticks, window.MAX_TRACK_TICKS);   // ← number

["inset", "glow", "band"].forEach(function (k) {
  out[k] = !!o[k];                            // ← boolean
});
```

**实测确认**：`gradient` 是 `string`、`ticks` 是 `number`、`band` 是 `boolean`，
**三者均非对象/数组，无需复合编辑控件。**

### 1.3 关键发现：`trackStyle` 默认已有对象（与 gauge 的 `card` 不同）

| 项 | gauge `card`（P4E-04）| track `trackStyle`（本任务）|
|---|---|---|
| 默认值 | **`null`** | **完整对象** `{orient,radius,inset,glow,band,gradient,segments,ticks,fill,color,accent}` |
| 是否需自动建对象 | ✅ 需 `normalizeCardPath` | ❌ **不需要** |
| 直接写子路径 | ❌ 会被拒绝 | ✅ 可直接写 |

**所以本任务不需要新增任何中间层处理逻辑。**

---

## 二、实际完成的字段与未完成原因

### 2.1 已完成（7/7）

| 字段 | 状态 |
|---|---|
| `trackStyle.radius` | ✅ |
| `trackStyle.inset` | ✅ |
| `trackStyle.gradient` | ✅ |
| `trackStyle.ticks` | ✅ |
| `trackStyle.band` | ✅ |
| `w` | ✅ |
| `h` | ✅ |

**track 族达成 11/11 字段可编辑**（任务目标）。

### 2.2 刻意不开放（不属于本任务 7 个字段）

| 字段 | 原因 |
|---|---|
| `trackStyle.color` | P3D 已明确标记「字段存在但**无 UI 编辑入口**」，属未实现功能 |
| `trackStyle.accent` | 同上 |

这两个字段**存在于数据结构中并正常序列化**，但 P3D 专题明确将其列为「未实现的轨道编辑功能」。
本任务范围是「7 个待迁移字段」，不含它们。**若将来需要，属扩范围，须单独评审。**

---

## 三、28 个控件的覆盖结果

| 项 | 结果 |
|---|---|
| Registry track 控件 | **28** |
| 正确识别为 `track` 族 | **28 / 28 ✅** |
| 每个控件可编辑字段 | **11 / 11 ✅** |
| 识别判据 | `render.mode === "track"`（Registry 静态属性）+ 持久化特征 `trackStyle` 对象 |

**未依赖 `__controlKey`**（重载后它会丢失）。

---

## 四、复杂字段的安全处理方案

### 4.1 为什么不会破坏结构

| 风险 | 防护 |
|---|---|
| 文本输入把对象写成字符串 | **不提供文本输入** —— 三个字段分别用 **枚举下拉 / 数字框 / 复选框** |
| 复制第二套默认值 | ❌ 未复制 —— schema 的 `values`/`min`/`max` 与 `normalizeTrackStyle`、`MAX_TRACK_TICKS`、`TRACK_GRADIENTS` **逐条对齐**，归一化仍由唯一真源执行 |
| 非法值静默改写 | ✅ `gradient` 非法值 → `null`（不改成别的色）；数值夹取到范围；**旧行为不变** |
| 破坏其它 8 个内部字段 | ✅ `PropertyAccessor.set` 只写目标子路径，其余字段原样保留（实测 11 个内部字段全在）|
| 清空/还原默认 | ✅ 清空 → 归一化回默认；`{}` → `null`（老文件往返语义）|
| Undo/Redo | ✅ 走 `commit()` |
| 导出/重导入 | ✅ 实测 7 字段往返一致，`errors=0` |

### 4.2 不需要新组件

`PropertyValidator` 已支持 `number` / `boolean` / `enum`，
`SchemaRenderer` 已有对应控件 —— **零新增 UI 代码**。

---

## 五、修改文件清单

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | `EDITABLE.track` 4 → **11** |
| `tools/icarui/js/registry/controls/track-family.js` | `trackStyle.radius` 补 `min:0, max:64`（与 `normalizeTrackStyle` 对齐）|
| `tools/icarui/tests/verify-p4f02-track-schema.js` | **新增 38 断言** |
| `tools/icarui/tests/verify-p4a-schema-props.js` | 断言 4 → 11（预期演进）|
| `tools/icarui/tests/verify-p4a1-hardening.js` | 断言 4 → 11（预期演进）|
| `tools/icarui/tests/expected-counts.json` | +38 |
| 文档 | 专题 64 + 验证记录 + **P4F-GUI-001 新建** + 索引 |

**未改**：`app/`（Android）、`model.js`、`schema.js`（`normalizeTrackStyle` 未动）、
`panels.js`（旧面板保留）、`icar.ui/2` 契约、渲染器、P4R 草稿系统。

---

## 六、自动化测试结果

### 6.1 新增套件 `verify-p4f02-track-schema.js` —— **38 断言（A–K）全绿**

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 28/28 识别、可编辑 4→11 | ✅ |
| B | 11 字段清单精确；`color`/`accent` 未误开 | ✅ |
| C | **11/11 字段可实际编辑** | ✅ |
| D | **复杂字段结构完整**（对象/11 内部字段/类型正确）| ✅ |
| E | 归一化 9 项（夹取/默认/非法值/空对象）| ✅ |
| F | 导出→重导入一致 | ✅ |
| G | Undo/Redo | ✅ |
| H | 画布重绘触发 | ✅ |
| I | 其它四族不误判 | ✅ |
| J | 旧面板无回归 | ✅ |
| K | **非法输入不破坏设计** | ✅ |

### 6.2 全量

| 层 | 结果 |
|---|---|
| 浏览器 | **64 套 / 6288 断言 / FAIL=0** |
| Android JVM | **1365 项 0/0/0** |

### 6.3 两处既有断言演进（非放宽门槛）

`verify-p4a-schema-props` 与 `verify-p4a1-hardening` 原写死「track 恰好 4 个可编辑字段」，
P4F-02 扩到 11 后前提失效。更新为 11 并注明演进原因。
**断言数量不变（72 / 85），未删未降。**

---

## 七、Android 兼容验证

### 7.1 检查结果

| 项 | 结果 |
|---|---|
| Android 是否有 `trackStyle` 解析代码 | ❌ **完全无** |
| `app/` 是否改动 | ❌ **零改动** |
| `icar.ui/2` 契约 | ❌ **零改动** |
| P3D 专题记载 | 「`app/` 零改动；`icar.ui/2` 零改动；`presets.js`/`panels.js`/`catalog.js` 零改动」|

### 7.2 结论

**轨道族（track）是 ICarUI 编辑器侧的绘制能力**，Android 运行端不消费 `trackStyle` 字段。
因此：

- ✅ **不破坏 Android 兼容**（字段对 App 是透明附加数据）
- ✅ Android JVM 1365 项 0/0/0 全绿
- ⚠️ **诚实记录**：这意味着轨道控件的外观**不会在 App 端呈现**，属 P3D 已确立的既有边界，
  **不是本任务引入的问题**。

---

## 八、GUI 待验收卡片

### 新建 `P4F-GUI-001`：**0 / 9 项**（全部未验收）

| # | 项目 |
|---|---|
| ① | 28 个 track 控件在面板中显示 11 个字段 |
| ② | 圆角（radius）调整后画布圆角变化 |
| ③ | 内凹（inset）勾选后画布效果变化 |
| ④ | 渐变（gradient）3 档切换（无 / 沿长边淡出 / 沿短边明暗）|
| ⑤ | 刻度（ticks）数量调整后刻度可见 |
| ⑥ | 三段色带（band）勾选效果 |
| ⑦ | 宽度 / 高度调整后控件尺寸变化 |
| ⑧ | 撤销 / 重做 |
| ⑨ | 保存后刷新恢复 + 导出导入回读一致 |

### 保留的既有卡片（**均未改动**）

| 卡片 | 状态 |
|---|---|
| `P4R-GUI-001` | 2/7（5 项暂缓）|
| `P4D-GUI-001` | 0/7 |
| `P4E-GUI-001` | 0/15 |

> ⚠️ **不得因自动测试通过而标记 GUI 人工验收通过。**

---

## 九、GitHub 同步

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/misakashiny/iCarOBD` |
| 分支 | `main` → `origin/main` |
| 起点 Hash | `eb0456c` |
| 本次提交 | 见提交后补记 |
| 推送结果 | 见提交后补记 |

---

## 十、遗留风险与下一阶段建议

### 10.1 遗留风险

| # | 风险 | 级别 |
|---|---|---|
| R1 | `trackStyle.color` / `accent` 仍无编辑入口（P3D 未实现）| 低 |
| R2 | 轨道外观在 **App 端不呈现**（P3D 既有边界）| 低（既有，非本任务引入）|
| R3 | `radius` 默认值依赖控件高度（`short/2`），改 `h` 后未改 `radius` 会保持旧值 | 低（与旧面板一致）|
| R4 | 刻度无标签编辑（P3D 未实现）| 低 |

### 10.2 下一阶段建议

按 P4F-01 审计结论，**批次 2（普通图片接入 Schema）** 是下一个 P1 项：

| 项 | 内容 |
|---|---|
| 目标 | 新增 `image` 族，开放 `assetId` + `w`/`h` + 通用变换 |
| 前置 | `isPlainImage()` 已存在（`trackStyle == null` 且 `states == null`）|
| 工作量 | 中 |
| 风险 | 低 |

之后是批次 3（text `w`/`h` + container `scale`）、批次 5（清理 4 个未实现字段，可选）。

---

**P4F-02 完成。track 族达成 4 → 11 字段全量开放。停止，不启动 P4F-03。**
