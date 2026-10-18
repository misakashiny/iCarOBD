/* ==========================================================================
   js/registry/controls/lamp-family.js —— P3C-2 状态灯（19 条）
   ==========================================================================

   ## 范围

   `lamp_coolant` `lamp_oil` `lamp_batt` `lamp_brake` `lamp_pad`
   `lamp_tpms` `lamp_airbag` `lamp_belt` `lamp_abs` `lamp_esp`
   `lamp_engine` `lamp_fuel` `lamp_door` `lamp_washer` `lamp_service`
   `lamp_temp` `lamp_charge` `lamp_lane` `lamp_collision`

   ## ⚠️⚠️ 本族最贵的一条：必须写 `statePid`，不能写 `pid`

   旧实现源码注释（presets.js:309-316）记录过一次真实事故：

   > 原来写的是 `n.pid` / `n.rawPid`，于是它们的灯**永远是暗的**：
   > 1. `NodeTreeRenderer.resolveState()` 只读 `node.statePid`，
   >    `isBlank()` 就直接返回 normal，根本不看 `pid`；
   > 2. `nodeToJson` 对 `NODE_IMAGE` **只序列化 `statePid`**，
   >    `pid` / `rawPid` 被丢掉 —— 连设计文件都进不去。
   >
   > 净结果：用户拖一个「胎压灯」出来，它永远显示暗的图，**用户会以为车没问题**。

   **所以迁移时 `statePid` / `rawStatePid` 的写法一个字节都不能变。**

   ## 字段语义（第五部分要求分清的四层）

   | 层 | 位置 | 值 | 用途 |
   |---|---|---|---|
   | ① Registry 定义的默认绑定 | `DEFS[].pid` | 别名（`obd.coolant`）| 建节点时的默认 |
   | ② 用户实例的绑定 | `node.rawStatePid` | 别名 | **用户改过的值**，回显用 |
   | ③ 解析后的通道 | `node.statePid` | id（`std_05`）| 内部查表 / App 端判定 |
   | ④ 序列化写出的值 | JSON `statePid` | **别名**（`ALIAS_OF[id]`）| 设计文件里存的是别名 |

   ⚠️ 所以 `nodeToJson()` 出来的 `statePid` 是**别名**，
   而不是 `node.statePid`（那是 id）。测试必须按这个区分写断言。

   ## 三态素材

   `assets/warning/lamp-{g}-{off|warn|crit}.png`，经 `ensureBuiltinAsset()` 转成 `assetId`。
   `states` 四个字段（`assetId` / `alpha` / `blink` / `blinkMs`）必须逐字段保留 ——
   尤其是 `blinkMs`：WCAG 2.3.1 要求闪烁每秒不超过三次，
   `warn` 用 600ms（1.7Hz）、`critical` 用 `MIN_BLINK_MS`（400ms / 2.5Hz）。
   原来是 260ms（3.8Hz）**超红线**，已修。

   ## 无数据时不得显示为"正常"

   `states.normal` 的 `alpha` 是 **120**（半透明 = 熄灭外观），不是 0。
   `UNKNOWN` 由 App 侧判定，本工具不改它的语义。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("lamp-family.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("lamp-family.js 必须在 control-registry.js 之后加载");

  /** 19 个灯的默认定义（逐字段照抄 presets.js:277-295） */
  const DEFS = [
    { key: "lamp_coolant",   name: "水温灯",   pid: "obd.coolant",      g: "coolant" },
    { key: "lamp_oil",       name: "机油灯",   pid: "tpl_oilPressure",  g: "oil" },
    { key: "lamp_batt",      name: "电池灯",   pid: "obd.voltage",      g: "batt" },
    { key: "lamp_brake",     name: "制动灯",   pid: "obd.brakeFluid",   g: "brake" },
    { key: "lamp_pad",       name: "刹车片",   pid: "obd.brakePad",     g: "pad" },
    { key: "lamp_tpms",      name: "胎压灯",   pid: "obd.tpms",         g: "tpms" },
    { key: "lamp_airbag",    name: "气囊灯",   pid: "obd.airbag",       g: "airbag" },
    { key: "lamp_belt",      name: "安全带灯", pid: "obd.seatbelt",     g: "belt" },
    { key: "lamp_abs",       name: "ABS 灯",   pid: "obd.abs",          g: "abs" },
    { key: "lamp_esp",       name: "ESP 灯",   pid: "obd.esp",          g: "esp" },
    { key: "lamp_engine",    name: "发动机灯", pid: "obd.engineFault",  g: "engine" },
    { key: "lamp_fuel",      name: "燃油报警", pid: "obd.fuel_level",   g: "fuel" },
    { key: "lamp_door",      name: "车门未关", pid: "obd.door",         g: "door" },
    { key: "lamp_washer",    name: "玻璃水",   pid: "obd.washer",       g: "washer" },
    { key: "lamp_service",   name: "保养提示", pid: "obd.service",      g: "service" },
    { key: "lamp_temp",      name: "水温报警", pid: "obd.coolant",      g: "temp" },
    { key: "lamp_charge",    name: "充电提示", pid: "obd.voltage",      g: "charge" },
    { key: "lamp_lane",      name: "车道辅助", pid: "obd.laneKeep",     g: "lane" },
    { key: "lamp_collision", name: "碰撞预警", pid: "obd.collision",    g: "collision" },
  ];

  /** 三态素材路径（与 gen-lamps.js 的 save() 同名） */
  function assetPath(g, suffix) {
    return "assets/warning/lamp-" + g + "-" + suffix + ".png";
  }

  /** 属性 Schema */
  function lampSchema() {
    return [
      { key: "statePid", label: "状态数据源", type: "pid", group: "数据" },
      { key: "stateWarn", label: "警告阈值", type: "number", group: "状态" },
      { key: "stateCritical", label: "严重阈值", type: "number", group: "状态" },
      { key: "states.normal.assetId", label: "正常图", type: "asset", group: "三态素材" },
      { key: "states.warn.assetId", label: "警告图", type: "asset", group: "三态素材" },
      { key: "states.critical.assetId", label: "严重图", type: "asset", group: "三态素材" },
      { key: "states.normal.alpha", label: "正常透明度", type: "number", group: "三态素材", min: 0, max: 255 },
      { key: "states.warn.blink", label: "警告闪烁", type: "boolean", group: "三态素材" },
      { key: "states.critical.blink", label: "严重闪烁", type: "boolean", group: "三态素材" },
      { key: "w", label: "宽度", type: "number", group: "变换", min: 1 },
      { key: "h", label: "高度", type: "number", group: "变换", min: 1 },
    ];
  }

  /** 数据槽：状态灯的槽是 state 类型（不是连续量） */
  function slotsOf(d) {
    return [{
      key: "state",
      label: "状态",
      pid: d.pid,
      dataType: "state",       // 三态：normal / warn / critical
      required: true,
      states: ["normal", "warn", "critical", "unknown"],
    }];
  }

  /**
   * 状态灯校验（第五部分：改绑定后要用**当前实例**的数据源，不是预设默认值）。
   *
   * ⚠️ 关键：读 `node.rawStatePid`（用户实例的绑定），**不是** `d.pid`（预设默认）。
   *    否则用户把"胎压灯"改绑到"水温"后，校验器还会按胎压去查 —— 报错指向错误的源。
   */
  function lampValidate(node) {
    const issues = [];
    if (!node) return [{ level: "error", code: "no-node", message: "节点为空" }];

    // ① 实例绑定优先，其次才是解析后的内部 id
    const raw = node.rawStatePid || node.statePid || "";

    if (!raw) {
      issues.push({
        level: "error", code: "no-state-pid",
        message: "状态灯没有绑定状态数据源（statePid），它会永远显示为正常熄灭",
      });
    } else {
      const resolved = typeof window.resolvePid === "function" ? window.resolvePid(raw) : null;
      const info = resolved && window.BUILTIN_PIDS ? window.BUILTIN_PIDS[resolved] : null;
      if (!info) {
        // ⚠️ **不能**因此把灯当成正常/熄灭 —— 只如实报告"数据源不可用"。
        issues.push({
          level: "error", code: "state-pid-unresolved",
          message: "状态数据源「" + raw + "」在 PID 表中不存在（" +
            (resolved ? "解析为 " + resolved : "无法解析") +
            "），App 侧取不到值 → 灯会停在未知状态，不代表车辆正常",
        });
      }
    }

    // ② 三态素材完整性
    const st = node.states;
    if (!st) {
      issues.push({ level: "warn", code: "no-states", message: "未启用三态，灯只会画一张静态图" });
    } else {
      ["normal", "warn", "critical"].forEach(function (k) {
        if (!st[k] || !st[k].assetId) {
          issues.push({ level: "warn", code: "missing-state-asset",
            message: "缺少「" + k + "」状态素材，该状态下会画不出图" });
        }
      });
    }

    // ③ 阈值合理性（只在显式设过时检查）
    const w = node.stateWarn, c = node.stateCritical;
    if (w !== null && w !== undefined && c !== null && c !== undefined) {
      if (Number(c) <= Number(w)) {
        issues.push({ level: "warn", code: "bad-threshold",
          message: "严重阈值(" + c + ") 不大于警告阈值(" + w + ")，critical 状态可能永远进不去" });
      }
    }

    if (node.w <= 0 || node.h <= 0) {
      issues.push({ level: "warn", code: "zero-size", message: "状态灯尺寸为 0，画布上不可见" });
    }

    return issues;
  }

  let registered = 0;
  let skipped = 0;

  DEFS.forEach(function (d) {
    if (Reg.has(d.key)) { skipped++; return; }

    Reg.define({
      key: d.key,
      legacyKey: d.key,
      name: d.name,
      category: "状态指示",
      icon: "⚠",
      priority: 40,

      defaults: { statePid: d.pid, w: 56, h: 56, x: 40, y: 40, z: 96 },   // z=96 与旧实现一致

      /**
       * 与旧实现**完全同构**。
       *
       * 支持 `props.statePid` 覆盖（用户改绑定），但**默认**仍用 `d.pid`。
       */
      build(props) {
        const p = props || {};
        const E = window.ensureBuiltinAsset || function () { return ""; };
        const off = E(assetPath(d.g, "off"));
        const warn = E(assetPath(d.g, "warn"));
        const crit = E(assetPath(d.g, "crit"));

        const raw = p.statePid === undefined ? d.pid : p.statePid;

        const node = window.createNode(window.NODE_IMAGE, {
          name: p.name === undefined ? d.name : p.name,
          assetId: off,
          x: p.x === undefined ? 40 : p.x,
          y: p.y === undefined ? 40 : p.y,
          w: p.w === undefined ? 56 : p.w,
          h: p.h === undefined ? 56 : p.h,
          z: p.z === undefined ? 96 : p.z,
        });

        // ⚠️⚠️ 必须写 statePid / rawStatePid（不能写 pid）—— 见文件头注释
        node.rawStatePid = raw;
        node.statePid = window.resolvePid(raw);

        // 阈值：用户显式给了就用，否则 null（= 从 PID 库推断）
        if (p.stateWarn !== undefined) node.stateWarn = p.stateWarn;
        if (p.stateCritical !== undefined) node.stateCritical = p.stateCritical;

        node.states = {
          normal: { assetId: off, alpha: 120, blink: false, blinkMs: window.MIN_BLINK_MS },
          // WCAG 2.3.1：闪烁不超过每秒三次。600ms = 1.7Hz
          warn: { assetId: warn, alpha: 255, blink: true, blinkMs: 600 },
          critical: { assetId: crit, alpha: 255, blink: true, blinkMs: window.MIN_BLINK_MS },
        };

        node.__controlKey = d.key;
        return node;
      },

      schema: lampSchema(),
      slots: slotsOf(d),
      render: { mode: "state", adapter: "drawImageNode" },
      validate: lampValidate,
    });
    registered++;
  });

  ICAR.registry.lampFamily = { registered: registered, skipped: skipped, total: DEFS.length };
})();
