# ICarUI P4D-01：19 个状态灯 Schema 属性面板迁移

| 字段 | 值 |
|---|---|
| 日期 | 2026-10-19（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P4D01` |
| 起点 | `cf82181` |
| 结论 | **19/19 状态灯接入 Schema 属性面板**；32 条新增断言全绿；60 套 6122 断言 FAIL=0 |
| 范围 | 仅 Schema 属性面板接入，**未改 `icar.ui/2` 字段语义与 Android 契约** |

---

## 一、审计结论（动手前）

### 1.1 Registry 现状

| 项 | 值 |
|---|---|
| Registry 总条目 | 69 |
| 状态灯条目 | **19**（`lamp_*`）|
| `render.mode` | `"state"` |
| `render.adapter` | `"drawImageNode"` |
| schema 字段数 | **11**（19 个灯完全一致）|

### 1.2 Schema 面板现状

`SchemaResolver.resolve()` 原本只分发三族：`container` / `text` / `track`。
**没有 image 状态灯分支** —— 这就是 19 个灯没进 Schema 面板的直接原因。

### 1.3 关键风险：`__controlKey` 不进序列化

`nodeToJson()` 白名单**没有 `__controlKey`**，所以保存重载后必然丢失。
已有注释（schema-props.js:22-24）明确写着「禁止把 `node.__controlKey` 作为唯一识别条件」。

**因此识别必须靠持久化字段特征**：`type === "image"` + 有 `states` 对象 + 无 `trackStyle`。

### 1.4 数据契约（最贵的一条）

状态灯有两个绑定字段，语义不同：

| 字段 | 值 | 用途 |
|---|---|---|
| `node.rawStatePid` | 别名 `obd.coolant` | 用户写的值，回显用 |
| `node.statePid` | 通道 id `std_05` | 内部查表 / App 端判定 |
| 序列化 `statePid` | **别名**（`ALIAS_OF[id]`）| 设计文件里存的是别名 |

**历史事故**（lamp-family.js:12-24 记录）：写错字段导致灯**永远是暗的**，用户以为车没问题。

---

## 二、19 个状态灯迁移对照表

| # | key | 名称 | 默认 PID 别名 | 分组 | 迁移状态 |
|---|---|---|---|---|---|
| 1 | `lamp_coolant` | 水温灯 | `obd.coolant` | coolant | ✅ |
| 2 | `lamp_oil` | 机油灯 | `tpl_oilPressure` | oil | ✅ |
| 3 | `lamp_batt` | 电池灯 | `obd.voltage` | batt | ✅ |
| 4 | `lamp_brake` | 制动灯 | `obd.brakeFluid` | brake | ✅ |
| 5 | `lamp_pad` | 刹车片 | `obd.brakePad` | pad | ✅ |
| 6 | `lamp_tpms` | 胎压灯 | `obd.tpms` | tpms | ✅ |
| 7 | `lamp_airbag` | 气囊灯 | `obd.airbag` | airbag | ✅ |
| 8 | `lamp_belt` | 安全带灯 | `obd.seatbelt` | belt | ✅ |
| 9 | `lamp_abs` | ABS 灯 | `obd.abs` | abs | ✅ |
| 10 | `lamp_esp` | ESP 灯 | `obd.esp` | esp | ✅ |
| 11 | `lamp_engine` | 发动机灯 | `obd.engineFault` | engine | ✅ |
| 12 | `lamp_fuel` | 燃油报警 | `obd.fuel_level` | fuel | ✅ |
| 13 | `lamp_door` | 车门未关 | `obd.door` | door | ✅ |
| 14 | `lamp_washer` | 玻璃水 | `obd.washer` | washer | ✅ |
| 15 | `lamp_service` | 保养提示 | `obd.service` | service | ✅ |
| 16 | `lamp_temp` | 水温报警 | `obd.coolant` | temp | ✅ |
| 17 | `lamp_charge` | 充电提示 | `obd.voltage` | charge | ✅ |
| 18 | `lamp_lane` | 车道辅助 | `obd.laneKeep` | lane | ✅ |
| 19 | `lamp_collision` | 碰撞预警 | `obd.collision` | collision | ✅ |

**全部 19 个通过同一套 SchemaResolver 分支接入**，无逐个特殊处理。

### 2.1 开放编辑的 11 个字段

| 字段 | 语义 |
|---|---|
| `statePid` | 数据绑定（**双字段同步**，见下）|
| `stateWarn` / `stateCritical` | 警告/严重阈值 |
| `states.normal.assetId` | 正常态素材 |
| `states.warn.assetId` | 警告态素材 |
| `states.critical.assetId` | 严重态素材 |
| `states.normal.alpha` | 正常态透明度 |
| `states.warn.blink` | 警告态闪烁开关 |
| `states.critical.blink` | 严重态闪烁开关 |
| `w` / `h` | 尺寸 |

### 2.2 刻意**不开放**的字段

| 字段 | 原因 |
|---|---|
| `states.*.blinkMs` | **WCAG 2.3.1 要求闪烁 ≤3Hz**。warn=600ms(1.7Hz)、critical=400ms(2.5Hz) 是安全值，开放后用户可调到红线以下 |

实测确认 `blinkMs` 仍为 600/400，未被暴露到可编辑列表。

---

## 三、实现说明（最小改动）

### 3.1 修改点一：新增 `imageState` 族

```js
EDITABLE.imageState = [
  "statePid", "stateWarn", "stateCritical",
  "states.normal.assetId", "states.warn.assetId", "states.critical.assetId",
  "states.normal.alpha", "states.warn.blink", "states.critical.blink",
  "w", "h",
];
```

### 3.2 修改点二：持久化特征识别

```js
isStateLamp(node) {
  if (!node || node.type !== "image") return false;
  if (trackStyle 是对象) return false;          // 排除条形轨道
  if (!states 是对象) return false;             // 排除普通图片
  return !!(states.normal || states.warn || states.critical);
}
```

**不依赖 `__controlKey`** —— 重载后仍能识别（实测 19/19）。

### 3.3 修改点三：`statePid` 双字段同步

```js
function normalizeStateLampBinding(node, path, value) {
  if (path !== "statePid" || 不是状态灯) return false;
  node.rawStatePid = 别名;                       // 用户写的值
  const resolved = resolvePid(别名);
  if (resolved) node.statePid = resolved;        // 解析后的通道 id
  return true;
}
```

在 `PropertyAccessor.set()` 入口拦截，**保证任何写入路径都走同一语义**。

### 3.4 修改点四：Registry 取代表定义

`stateLampSchemaFor()` 从 Registry 取，**不在 UI 层复制 schema**（P4A.1 消除 Schema 双源的教训）。
优先 `__controlKey` 精确匹配，回退任一 `render.mode === "state"` 定义。

---

## 四、自动化测试结果

新增 `verify-p4d01-lamp-schema.js`：**32 断言，A–K 十一组**。

| 组 | 覆盖 | 结果 |
|---|---|---|
| A | 19 个灯全部识别为 imageState，11 字段可编辑 | ✅ |
| B | **重载后（无 `__controlKey`）19/19 仍识别** | ✅ |
| C | 基础属性 `w`/`h` 编辑 | ✅ |
| D | **`statePid` 双字段同步**（id + 别名 + 序列化别名）| ✅ |
| E | 三态素材替换、alpha、blink 配置 | ✅ |
| F | **blinkMs 不在可编辑列表**（WCAG 保护）| ✅ |
| G | 属性变更触发画布重绘 | ✅ |
| H | Undo / Redo 连续两步 + 重做 | ✅ |
| I | **导出 → 重新导入后属性一致**（statePid/素材/alpha/尺寸）| ✅ |
| J | 普通图片、条形轨道**不被误判** | ✅ |
| K | Registry 仍 69 条、lampFamily 19 条（旧实现未删）| ✅ |

### 全量回归

| 层 | 结果 |
|---|---|
| 浏览器 | **60 套 / 6122 断言 / FAIL=0**（原 59/6090）|
| 未删除任何既有断言 | ✅ |
| Registry | 69（未变）|
| Catalog | 215（未变）|

---

## 五、兼容性说明

| 项 | 状态 |
|---|---|
| `icar.ui/2` 字段语义 | ✅ 未改（`statePid` 仍序列化为别名）|
| Android 数据契约 | ✅ 未改（`node.statePid` 仍是通道 id）|
| 旧属性面板 | ✅ 保留并行运行（普通图片仍走旧面板）|
| 已有素材路径 | ✅ 未改（`assets/warning/lamp-*`）|
| 旧设计文件 | ✅ 兼容（靠持久化特征识别，不依赖新字段）|
| 旧控件实现 | ✅ 未删除（`presets.js` 仍在）|
| 现有全局入口 | ✅ 未删除 |
| 新框架/构建系统/ES 模块 | ✅ 未引入 |
| P4R 草稿系统 | ✅ 未重构 |

### 5.1 开发过程中发现（非缺陷，记录备查）

**`restore()` 会替换整个 design 对象**，撤销/重做后必须重新取节点引用，不能持有旧引用。
这是既有行为，测试写法必须遵守。已在套件中加注释说明。

---

## 六、修改文件清单

| 文件 | 改动 |
|---|---|
| `tools/icarui/js/ui/schema-props.js` | 新增 `imageState` 族：`EDITABLE.imageState`、`isStateLamp()`、`stateLampSchemaFor()`、`normalizeStateLampBinding()`、`resolve()` 分支 |
| `tools/icarui/tests/verify-p4d01-lamp-schema.js` | 新增 32 断言 |
| `tools/icarui/tests/expected-counts.json` | 基线 +32（60 套 6122）|

**未改**：`app/`（Android）、`lamp-family.js`、`presets.js`、`canvas.js`、`model.js`、`schema.js`、草稿系统。

---

## 七、尚待人工验收

**自动化测试通过 ≠ GUI 验收通过。** 以下须在真实浏览器确认：

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 拖入状态灯后 Schema 面板正确显示 11 个字段 | ❌ 待人工 |
| 2 | 修改 `statePid` 后下拉回显正确 | ❌ 待人工 |
| 3 | 三态素材选择器能打开并选中 | ❌ 待人工 |
| 4 | 改属性后画布立即更新（视觉确认）| ❌ 待人工 |
| 5 | 三种状态的实际渲染效果（含闪烁）| ❌ 待人工 |
| 6 | 保存 → 刷新 → 恢复后属性仍在 | ❌ 待人工 |
| 7 | 导出设计文件 → 真机 App 读取正常 | ❌ 待人工（需设备）|

### 关联的暂缓验收

`P4R-GUI-001` 仍有 5 项暂缓（③④⑤⑥⑦），**不作为 P4D 阻塞项**，P4R 状态为
「**功能已实现，部分 GUI 验收暂缓**」。

---

## 八、范围扩张报告

**未发生范围扩张，未改变既有数据契约。**

唯一需要说明的决策点：**`blinkMs` 未开放编辑**。
理由：WCAG 2.3.1 安全约束，开放会让用户把闪烁调到 ≥3Hz。这不是功能缺失，是安全边界。
如需开放，必须另开任务并同时提供下限守卫。

---

**本卡完成，停止。**
