# ICarUI P3C-2：19 个状态灯控件正式迁移

| 字段 | 值 |
| --- | --- |
| 日期 | 2026-10-18（Asia/Shanghai） |
| 任务 | `T-UI-REFACTOR-P3C2` |
| 基线 | P3C-1 `a6ce387` |
| 结论 | 19 个状态灯全部接管；Golden 19/19；三态素材 57/57；**5305 断言 FAIL=0** |
| 兼容性 | `app/` 零改动；`icar.ui/2` 零改动；`presets.js`/`panels.js` 零改动 |

---

## 一、19 个状态灯 Registry 迁移清单

| # | key | name | 默认 statePid | 通道分级 |
|---|---|---|---|---|
| 1 | `lamp_coolant` | 水温灯 | `obd.coolant` → `std_05` | **implemented** |
| 2 | `lamp_oil` | 机油灯 | `tpl_oilPressure` | **alias-only** |
| 3 | `lamp_batt` | 电池灯 | `obd.voltage` → `std_42` | **implemented** |
| 4 | `lamp_brake` | 制动灯 | `obd.brakeFluid` | unimplemented |
| 5 | `lamp_pad` | 刹车片 | `obd.brakePad` | unimplemented |
| 6 | `lamp_tpms` | 胎压灯 | `obd.tpms` | unimplemented |
| 7 | `lamp_airbag` | 气囊灯 | `obd.airbag` | unimplemented |
| 8 | `lamp_belt` | 安全带灯 | `obd.seatbelt` | unimplemented |
| 9 | `lamp_abs` | ABS 灯 | `obd.abs` | unimplemented |
| 10 | `lamp_esp` | ESP 灯 | `obd.esp` | unimplemented |
| 11 | `lamp_engine` | 发动机灯 | `obd.engineFault` → `std_01` | **implemented** |
| 12 | `lamp_fuel` | 燃油报警 | `obd.fuel_level` → `std_2F` | **implemented** |
| 13 | `lamp_door` | 车门未关 | `obd.door` | unimplemented |
| 14 | `lamp_washer` | 玻璃水 | `obd.washer` | unimplemented |
| 15 | `lamp_service` | 保养提示 | `obd.service` | unimplemented |
| 16 | `lamp_temp` | 水温报警 | `obd.coolant` → `std_05` | **implemented** |
| 17 | `lamp_charge` | 充电提示 | `obd.voltage` → `std_42` | **implemented** |
| 18 | `lamp_lane` | 车道辅助 | `obd.laneKeep` | unimplemented |
| 19 | `lamp_collision` | 碰撞预警 | `obd.collision` | unimplemented |

**`lampFamily = { total: 19, registered: 19, skipped: 0 }`**

---

## 二、独立 Golden 19/19 对比

### 2.1 ⚠️ 本轮最重要的发现：`assetId` 是运行期生成的

第一次抓 Golden 时 19 条全部不一致，差异在 `assetId`：

```
golden: "asbeq89"    actual: "asbei0j"
```

查源码：`ensureBuiltinAsset()` 里 `const id = window.newId("as")` ——
**`assetId` 是运行时自增 id，跨会话必然不同**。

**这属于必须排除的真正非确定性字段**（与 `id` 同类）。

### 2.2 处理方式

Golden 里把 `assetId` **归一化为素材路径**再比对：

```js
function norm(o) {
  const byId = {}; design.assets.forEach(a => byId[a.id] = a.path);
  o.assetId = 'PATH:' + byId[o.assetId];
  ['normal','warn','critical'].forEach(k => o.states[k].assetId = byId[...]);
  return o;
}
```

迁移后同样归一化再比。

### 2.3 结果

```
Golden match: 19/19
```

保留并比对的字段：`type` / `name` / `x/y/w/h` / `z` / `statePid` /
`stateWarn` / `stateCritical` / `states.{normal,warn,critical}.{assetId,alpha,blink,blinkMs}`。

---

## 三、新旧入口调用关系

```
BUILTIN_CONTROLS[i].make()
        │
        │  ← panels.js 追加的外层包装（按画布宽高比缩放图片控件）
        ▼
prepareBuiltinImages( make_内层(), false )
        │
        │  ← registry-bridge 替换的就是这一层
        ▼
Registry.build(key)  →  def.build(props)  →  createNode(NODE_IMAGE, {...})
```

---

## 四、⚠️ 本轮发现的第二个真 Bug：bridge 的加载顺序

### 4.1 现象

迁移后 `Golden 0/19`，差异全部是同一条：

```
w: 35  (旧入口)   vs   w: 56  (Registry)
```

### 4.2 根因

`panels.js` 在加载时会做：

```js
window.BUILTIN_CONTROLS.forEach(control => {
  const make = control.make;
  control.make = () => window.prepareBuiltinImages(make(), false);   // ← 包装
});
```

`prepareBuiltinImages` 把图片控件的 `w` 按画布宽高比缩放：
`56 × designH/designW = 56 × 1600/2560 = 35`。

而我的 bridge 脚本在 **`panels.js` 之前**执行（L261 vs L286），
替换被 `panels.js` 的 `forEach` **覆盖**了。

**P3A/P3B/P3C-1 迁的控件都不是 `NODE_IMAGE`**，这层包装对它们无副作用，
所以前三轮一直没暴露。P3C-2 迁状态灯立刻炸出来。

### 4.3 修复

把 bridge 的**调用**从 `<script>` 位置移到 `panels.js` 之后：

```html
<script src="js/panels.js"></script>
<script>
  window.__P3A_BRIDGE  = B.bridge([...12 文字...]);
  window.__P3B_BRIDGE  = B.bridge([...4 容器...]);
  window.__P3C1_BRIDGE = B.bridge([...6 仪表...]);
  window.__P3C2_BRIDGE = B.bridge([...19 状态灯...]);
</script>
```

bridge 模块本身仍在前方加载（它只定义函数，不执行）。

修复后：`Golden 19/19`。

### 4.4 这个坑对后续阶段的意义

**任何 `NODE_IMAGE` 类控件（P3F 素材族 104 条）都会踩同一个坑。**
修复已在 bridge 层面统一解决，P3F 不会再遇到。

---

## 五、`statePid` / `rawStatePid` 语义说明

### 5.1 四层语义（第五部分要求区分）

| 层 | 位置 | 值 | 用途 |
|---|---|---|---|
| ① Registry 默认绑定 | `DEFS[].pid` | 别名 `obd.coolant` | 建节点时的默认值 |
| ② 用户实例绑定 | `node.rawStatePid` | 别名 | **用户改过的值**，回显用 |
| ③ 解析后通道 | `node.statePid` | id `std_05` | 内部查表 / App 端判定 |
| ④ 序列化写出 | JSON `statePid` | **别名**（`ALIAS_OF[id]`）| 设计文件里存别名 |

**⚠️ 所以 `nodeToJson()` 出来的 `statePid` 是别名，不是 `node.statePid`（那是 id）。**
测试按此区分断言。

### 5.2 绝不能用 `pid` 代替 `statePid`

旧实现源码注释记录过一次真实事故（`presets.js:309-316`）：

> 原来写的是 `n.pid` / `n.rawPid`，于是它们的灯**永远是暗的**：
> 1. `NodeTreeRenderer.resolveState()` 只读 `node.statePid`，
>    `isBlank()` 就直接返回 normal，根本不看 `pid`；
> 2. `nodeToJson` 对 `NODE_IMAGE` **只序列化 `statePid`**，`pid`/`rawPid` 被丢掉。

**净结果：用户拖一个「胎压灯」出来，它永远显示暗的图，用户会以为车没问题。**

测试逐条断言：**19 条全部不写 `pid` 字段**。

### 5.3 用户改绑定后校验器用实例数据源

```js
// lamp-family.js
const raw = node.rawStatePid || node.statePid || "";   // ← 实例优先，不是 d.pid
```

测试：
- 把 `lamp_tpms` 改绑到 `obd.coolant` → 校验器**不报** unresolved ✅
- 改绑到 `obd.nonexistent` → 校验器报 `state-pid-unresolved` ✅

> 若校验器读 `d.pid`（预设默认），改绑后报错会指向**错误的源**。

---

## 六、三态素材与像素回归

### 6.1 57 个状态图逐项核验

19 灯 × 3 态 = **57**，全部通过：

| 检查 | 结果 |
|---|---|
| 三个状态图都存在 | 19/19 ✅ |
| 三图**互不相同** | 19/19 ✅ |
| `normal.alpha = 120`（半透明熄灭） | ✅ |
| `warn.alpha=255 / blink=true / blinkMs=600` | ✅ |
| `critical.alpha=255 / blink=true / blinkMs=400` | ✅ |
| **blinkMs ≥ 334（WCAG 2.3.1 ≤3Hz）** | 38/38 ✅ |
| 旧素材路径 `assets/warning/lamp-*-{off,warn,crit}.png` 仍注册 | ≥57 ✅ |
| 缺素材时给 `missing-state-asset` 诊断 | ✅ |

### 6.2 关于 57 个状态图的像素对比（如实说明）

**未生成 57 张状态图像的像素哈希对比。** 原因与边界：

- 绘制入口 `drawNodePreview(node)` 接收的是**节点**，节点的三态在绘制时由
  `n.states` + 当前模拟状态决定。现有测试工具链里**没有**暴露
  "以指定状态渲染单张状态图"的入口。
- 我**没有**为此新增渲染入口（会扩大改动范围，且属于"为新功能改渲染"，
  本阶段禁止）。
- 已做到的替代保证：
  1. **节点 JSON 逐字段 19/19 与 Golden 一致**（含三态 assetId 路径、alpha、blink、blinkMs）
  2. **素材路径存在性** 57/57 已核验
  3. **三图互异** 19/19 已核验

**未覆盖项（如实列明）**：以 `warn` / `critical` 模拟状态渲染时的**像素外观**
未与基线对比。这需要 App 端或新增渲染入口，本阶段未做。

> 不用"构建成功"代替渲染验证 —— 上面三条是有具体断言支撑的，
> 而"未做"的部分明确标注为未做。

### 6.3 无数据 / UNKNOWN 的处理

| 项 | 行为 | 是否改动 |
|---|---|---|
| `normal.alpha` | **120**（半透明 = 熄灭外观），不是 0 | 未改 |
| 无 `statePid` | 校验器报 **error `no-state-pid`**，明确提示"会永远显示为正常熄灭" | 未改判定行为 |
| `statePid` 解析不到 | 校验器报 **error `state-pid-unresolved`**，提示"灯会停在未知状态，**不代表车辆正常**" | 未改判定行为 |

**没有把 UNKNOWN 变成"正常熄灭"** —— 本工具不改 App 的状态判定，
只在设计器里如实报告"数据源不可用"。

---

## 七、数据能力分级

### 7.1 实测分布（与任务书预估完全吻合）

| 分级 | 实测 | 预估 |
|---|---|---|
| `implemented` | **6** | 6 ✅ |
| `alias-only` | **1** | 1 ✅ |
| `unimplemented` | **12** | 12 ✅ |

全部 19 条：
- `dataCapability = state`
- `vehicleStatus = **unverified**`（**不是 supported**）
- `source = derived`

### 7.2 12 个未实现的灯：不伪造数据源

| 要求 | 实现 | 验证 |
|---|---|---|
| 保留历史控件及旧 key | 未删除任何 key | ✅ 19 条全部仍在 `BUILTIN_CONTROLS` |
| 清晰提示数据源未实现 | 校验器报 `state-pid-unresolved` | ✅ 12/12 全部报 |
| 不伪造数据源使警告消失 | 未改 `channelStatus` 判定，未添加假 PID | ✅ |
| UNKNOWN 不误判为安全/正常 | 见 §6.3 | ✅ |

> 这 12 条的 `obd.brakeFluid` / `obd.tpms` / `obd.abs` 等别名
> **在 App 与工具两侧都不存在**，`resolvePid` 原样返回，
> 因此 `channelStatus=unimplemented` 是如实反映。

---

## 八、实际浏览器交互测试

| # | 项 | 结果 |
|---|---|---|
| 1 | 旧控件库和新 Catalog 添加状态灯 | ✅ 新旧入口产出 **19/19 一致** |
| 2 | 默认创建与数据绑定 | ✅ Golden 19/19 |
| 3 | 修改状态灯绑定 | ✅ `lamp_tpms` → `obd.coolant`，`rawStatePid`/`statePid`/序列化三层都正确 |
| 4 | normal/warn/critical 模拟预览 | ✅ 三态字段（alpha/blink/blinkMs）逐项核验 |
| 5 | 位置、大小、旋转、透明度、图层 | ✅ `x/y/w/h/rotation/alpha/scale/z` 全部持久化 |
| 6 | 撤销、重做 | ✅ 节点数正确变化 |
| 7 | 保存、导出、重新载入 | ✅ 0 错误、3 灯、`rawStatePid` 别名保持 |
| 8 | 新旧路径资源引用一致 | ✅ 归一化为素材路径后 19/19 一致 |
| 9 | 不可用数据源的视觉提示 | ✅ 12 条全部报 `state-pid-unresolved` |
| 10 | 模拟状态变化不污染设计 JSON | ✅ `_simState` 前后 JSON 完全相同 |
| **11** | **真实鼠标拖放** | ✅ 派发 `DragEvent('drop')` 带 `application/x-ctrl=lamp_tpms` → **成功创建 image 节点且保留 statePid** |

---

## 九、Registry / Catalog 统计

| 指标 | 实测 | 预估 | 一致 |
|---|---|---|---|
| Registry bridged | **41** | 41 | ✅ |
| Catalog `declared` | **8** | 8 | ✅ |
| Catalog `derived` | **41** | 41 | ✅ |
| Catalog `probe` | **166** | 166 | ✅ |
| Catalog `total` | **215** | 215 | ✅ |

`fallback = 0`、`missing = 0`。

---

## 十、完整测试结果

| 层 | P3C-1 | **P3C-2** |
|---|---|---|
| 套件 | 43 | **44** |
| 断言 | 5045 | **5305** |
| **FAIL** | 0 | **0** |
| JVM | 1365 项 0/0/0 | **1365 项 0/0/0** |

基线变更（官方 `-UpdateBaseline`）：
```
+ verify-p3c2-lamp-family   新增 260
合计 44 个套件 / 下限之和 5305
```

### 10.1 本轮调整的既有断言

| 套件 | 断言 | 变化 | 理由 |
|---|---|---|---|
| `verify-p3c1-gauge-family` | bridged / derived / probe | 硬编码 `22/22/185` → **"至少 22"** | P3C-2 推进了阶段数字；精确数字由 `verify-p3c2` 守 |

---

## 十一、修改文件清单

### 新增（3）

| 文件 | 说明 |
|---|---|
| `tools/icarui/js/registry/controls/lamp-family.js` | 19 条状态灯定义 |
| `tools/icarui/tests/fixtures/p3c2-lamp-golden.json` | **独立旧版基准**（assetId 归一化为路径）|
| `tools/icarui/tests/verify-p3c2-lamp-family.js` | **260 条断言**（分步 eval）|

### 修改（5）

| 文件 | 改动 |
|---|---|
| `tools/icarui/index.html` | 加载 `lamp-family.js`；**bridge 调用移到 `panels.js` 之后**（关键修复）|
| `tools/icarui/js/adapter/registry-bridge.js` | 注释说明 `prepareBuiltinImages` 包装链（逻辑保持等价）|
| `tools/icarui/tests/verify-p3c1-gauge-family.js` | 数量断言改结构性 |
| `tools/icarui/tests/expected-counts.json` | `-UpdateBaseline` 官方写入 |

### 未改动（关键）

- **`app/`**、**`icar.ui/2`**、**`presets.js`**、**`panels.js`**（包装逻辑原样）
- `model.js` / `schema.js` / `canvas.js` / `catalog.js`
- 其它 196 个条目的创建逻辑

---

## 十二、残余风险

| # | 风险 | 级别 | 说明 |
|---|---|---|---|
| R1 | **57 个状态图未做像素对比** | 中 | 缺少"按状态渲染"入口，已如实列明未覆盖 |
| R2 | 12 个灯的通道确实不存在 | **高** | 事实：App 与工具都没有这些 PID |
| R3 | `vehicleStatus` 全 `unverified` | **高** | 无真车证据 |
| R4 | 166 条仍走 `make()` 探测 | 中 | 其中多数有写 `design.assets` 副作用 |
| R5 | `ext` 透传未实施 | **高** | 未知字段仍被丢弃 |
| R6 | 旧 `make` 源码仍在 `presets.js` | 中 | 运行时被 bridge 覆盖 |
| R7 | **bridge 顺序依赖 `panels.js`** | 中 | 已在代码与报告里注明，但若将来调整脚本顺序会静默失效 |

---

## 十三、新发现的 Legacy Behavior Debt

### D-07：`panels.js` 给所有 `make` 包了一层 `prepareBuiltinImages`

| 项 | 内容 |
|---|---|
| **发现于** | P3C-2（迁移状态灯时 `Golden 0/19`） |
| **位置** | `panels.js` 加载末尾的 `BUILTIN_CONTROLS.forEach` |
| **现象** | `control.make` 被替换为 `() => prepareBuiltinImages(make(), false)`；图片控件的 `w` 被按画布宽高比缩放（56→35） |
| **性质** | **刻意设计**（注释写"Built-in image templates describe their visual aspect"）|
| **影响** | 任何直接调"未包装的 Registry.build"都会与旧入口差 21；P3A/P3B/P3C-1 因控件非 IMAGE 未暴露 |
| **建议** | 不改 `panels.js`。**bridge 必须放在 `panels.js` 之后执行**（已修）。P3F 素材族（104 条 IMAGE）会同样依赖此修复 |
| **当前处置** | 已把 bridge 调用移到 `panels.js` 之后；`Golden 19/19` |

### D-08：`assetId` 是运行期生成的，不能作为 Golden 比对字段

| 项 | 内容 |
|---|---|
| **发现于** | P3C-2 |
| **位置** | `panels.js` `ensureBuiltinAsset()` → `window.newId("as")` |
| **现象** | 同一控件两次会话拿到的 `assetId` 不同（`asbeq89` vs `asbei0j`）|
| **性质** | 刻意设计（素材 id 与用户设计绑定，每次导入重新分配）|
| **影响** | Golden 里若保留 `assetId`，跨会话比较必然失败（实测 19 条全红）|
| **建议** | Golden 比对时**把 `assetId` 归一化为素材路径**；这不是"忽略字段"，而是换成等价且稳定的表示 |
| **当前处置** | 已按路径归一化，`Golden 19/19` |

> 两条均已追加到 [37_LegacyBehaviorDebt.md](37_LegacyBehaviorDebt.md)。

---

## 十四、下一阶段：轨道控件迁移建议（P3D）

### 14.1 范围

`cd_*` 系列 **28 条**（代码绘制条形轨道）。

### 14.2 需要特别注意的坑

| 坑 | 说明 |
|---|---|
| **`trackStyle` 字段** | 新字段，`null` = 老行为（画 `assetId` 那张 PNG）。迁移必须保持 `normalizeTrackStyle` 调用 |
| **D-07 包装** | 若 `cd_*` 是 `NODE_IMAGE`，会踩同一个 `prepareBuiltinImages` 坑 —— **已由 bridge 顺序修复覆盖** |
| **`cd_*` vs `bar_*` 双渲染器** | P0 审计确认过：24 组重复概念，**刻意保留两套**（代码画 vs 图片画）。迁移时不得合并 |
| **`normalizeBands`** | 多段色带只画分区、**不参与报警判定**，迁移时不能改这个语义 |

### 14.3 建议流程（沿用已验证的四段式）

1. **先抓 Golden**（替换前；`assetId` 归一化为路径）
2. 写 `controls/track-family.js`（28 条）
3. `bridge([...28 keys])` —— 放在 `panels.js` 之后（已就位）
4. 写验收套件（分步 eval）+ 像素回归（`trackStyle` 与 `assetId` 两分支都要覆盖）
5. 全量回归

### 14.4 预期统计（P3D 完成后）

| 指标 | 数值 |
|---|---|
| bridged | 41 → **69** |
| declared | 8 |
| derived | 69 |
| probe | 138 |
| total | 215 |

> ⚠️ 这只是**预估**，以运行时实测为准（P3C-1/P3C-2 两轮实测都与预估吻合，
> 但 `cd_*` 的边界（是否有子部件、是否全部 `NODE_IMAGE`）尚未逐一核实）。

---

## 十五、未验证边界

1. **57 个状态图的像素外观未与基线对比**（缺"按状态渲染"入口，已如实列明）
2. **未做真实鼠标拖动的完整链路**（只验证了 `drop` 事件派发与节点创建）
3. **未人工判读 UI**（模型无图像输入能力）
4. **无真车证据** → `vehicleStatus` 全 `unverified`
5. **未在 App 端验证 `UNKNOWN` 的实际显示**（本工具不改 App 逻辑，
   App 端 `--` 契约保持不变，但未执行验证）
6. 166 条仍走 `make()` 探测；`ext` 透传未实施
