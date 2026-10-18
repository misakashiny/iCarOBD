/* ==========================================================================
   js/registry/controls/gauge-family.js —— P3C-1 常用仪表（6 条）
   ==========================================================================

   ## 范围（严格限定）

   | # | key | pid | style |
   |---|---|---|---|
   | 1 | `g_speed` | `obd.speed` | 1 |
   | 2 | `g_coolant` | `obd.coolant` | 0 |
   | 3 | `g_fuel` | `obd.fuel_level` | 0 |
   | 4 | `g_volt` | `obd.voltage` | 4 |
   | 5 | `g_load` | `obd.load` | 2 |
   | 6 | `g_throttle` | `obd.throttle` | 3 |

   ⚠️ **不包含** `gauge_0`~`gauge_7`（八种外观预设，P2B 已由 CatalogMeta 静态声明，
   本阶段保持不变）；也**不包含** `g_intake` / `g_boost`（不在 P3C-1 范围）。

   ## 量程与阈值从哪来

   旧实现：
   ```js
   const info = window.BUILTIN_PIDS[window.resolvePid(d.pid)] || {};
   min/max/warnLow/warnHigh 全从 info 取，缺省 min=0 / max=100
   ```
   所以 **`resolvePid` 的结果决定一切**。迁移时保持**同样的取值路径**，
   不把量程写死成字面量 —— 否则将来 `BUILTIN_PIDS` 更新时会两边不一致。

   ⚠️ 旧实现里 `warnLow/warnHigh` 取到 `null` 时**不写进序列化结果**
   （`nodeToJson` 对 null 值字段跳过）。迁移必须保持这个行为。

   ## 数据槽（第四部分要求）

   每个仪表声明**明确的数据槽**：`slots: [{ key:"value", pid, dataType, ... }]`。
   `dataType` 取自 `BUILTIN_PIDS` 的语义（连续量 → `number`；百分比 → `percent`）。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("gauge-family.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("gauge-family.js 必须在 control-registry.js 之后加载");

  /**
   * 六个仪表的定义。
   *
   * `dataType` 是人读的分类，用来做 Schema 校验；
   * 真正的量程**运行时**从 `BUILTIN_PIDS[resolvePid(pid)]` 取，不写死。
   */
  const DEFS = [
    { key: "g_speed",    name: "车速",       category: "仪表", icon: "▬",
      pid: "obd.speed",      style: 1, w: 200, h: 100, dataType: "speed" },
    { key: "g_coolant",  name: "水温",       category: "仪表", icon: "◉",
      pid: "obd.coolant",    style: 0, w: 120, h: 120, dataType: "temperature" },
    { key: "g_fuel",     name: "油量",       category: "仪表", icon: "◉",
      pid: "obd.fuel_level", style: 0, w: 120, h: 120, dataType: "percent" },
    { key: "g_volt",     name: "电压",       category: "仪表", icon: "▣",
      pid: "obd.voltage",    style: 4, w: 150, h: 150, dataType: "voltage" },
    { key: "g_load",     name: "发动机负荷", category: "仪表", icon: "◍",
      pid: "obd.load",       style: 2, w: 120, h: 120, dataType: "percent" },
    { key: "g_throttle", name: "节气门",     category: "仪表", icon: "▬",
      pid: "obd.throttle",   style: 3, w: 200, h: 100, dataType: "percent" },
  ];

  /** 数据槽 Schema：每个仪表一个连续量槽 */
  function slotsOf(d) {
    return [{
      key: "value",
      label: "显示值",
      pid: d.pid,
      dataType: d.dataType,
      required: true,
      // 量程在运行时从 BUILTIN_PIDS 取（不写死），这里只声明"有这个槽"
    }];
  }

  /** 属性 Schema */
  function gaugeSchema() {
    return [
      { key: "pid", label: "数据源", type: "pid", group: "数据" },
      { key: "style", label: "样式", type: "enum", values: [0, 1, 2, 3, 4, 5, 6, 7], group: "外观" },
      { key: "min", label: "最小值", type: "number", group: "量程" },
      { key: "max", label: "最大值", type: "number", group: "量程" },
      { key: "warnLow", label: "低警告", type: "number", group: "量程" },
      { key: "warnHigh", label: "高警告", type: "number", group: "量程" },
      { key: "label", label: "标签", type: "string", group: "外观" },
      { key: "unit", label: "单位", type: "string", group: "外观" },
      { key: "w", label: "宽度", type: "number", group: "变换", min: 1 },
      { key: "h", label: "高度", type: "number", group: "变换", min: 1 },
      { key: "font.size", label: "字号", type: "number", group: "字体", min: 1 },
      { key: "font.color", label: "颜色", type: "color", group: "字体" },
      // ==== P4E-03：把**一直在数据里、但没登记进 schema** 的两个字段补上 ====
      //
      // 它们本来就在 model.js 的白名单里（extraPids 解构于 parseNode:71、
      // 序列化于 nodeToJson:830；valueLabels 同理 78/836），
      // 也存在 Android 契约里（GaugeItem.extraPids / valueLabels）。
      // 只是 Registry schema 没声明 —— 于是 Schema 面板**看不到**它们。
      //
      // ⚠️ 这是**补登记**，不是新增数据契约：字段名、类型、序列化路径全都没变。
      //
      // type 用 "list"：数据是 string[]，面板用**逗号分隔的单行输入**编辑
      // （与旧面板一致；属性面板有"行高 ≤ 40px"的排版约束，不能用 textarea）。
      { key: "valueLabels", label: "数值映射", type: "list", group: "数据",
        hint: "逗号分隔，索引 = round(值)，如 P,R,N,1,2" },
      { key: "extraPids", label: "副参数", type: "list", group: "数据",
        hint: "逗号分隔的 PID 别名，如 obd.coolant,obd.intake" },
    ];
  }

  /**
   * 仪表校验（第四部分：数据槽 Schema 校验）。
   *
   * 检查项与判据：
   *   1. 必须有 pid（否则画不出值）
   *   2. pid 必须能被 resolvePid 解析（解析不了 = 数据源缺失 → warn，**不 throw**）
   *   3. min < max（量程反了仪表画不出来 → error）
   *   4. 尺寸 > 0
   *
   * ⚠️ 数据源缺失时返回 **warn** 而不是 error —— 旧行为是画一个空表，
   * 不崩、不丢控件。这里保持一致，只是把"为什么是空的"说出来。
   */
  function gaugeValidate(node) {
    const issues = [];
    if (!node) return [{ level: "error", code: "no-node", message: "节点为空" }];

    if (!node.pid) {
      issues.push({ level: "error", code: "no-pid", message: "仪表没有数据源（pid），无法显示数值" });
    } else {
      const resolved = typeof window.resolvePid === "function" ? window.resolvePid(node.pid) : null;
      const info = resolved && window.BUILTIN_PIDS ? window.BUILTIN_PIDS[resolved] : null;
      if (!info) {
        issues.push({
          level: "warn",
          code: "pid-unresolved",
          message: "数据源「" + node.pid + "」在 PID 表中找不到（" +
            (resolved ? "解析为 " + resolved : "无法解析") + "），仪表会显示为空",
        });
      }
    }

    const mn = Number(node.min), mx = Number(node.max);
    if (Number.isFinite(mn) && Number.isFinite(mx) && mx <= mn) {
      issues.push({ level: "error", code: "bad-range", message: "量程异常：min(" + mn + ") >= max(" + mx + ")" });
    }

    if (node.w <= 0 || node.h <= 0) {
      issues.push({ level: "warn", code: "zero-size", message: "仪表尺寸为 0，画布上不可见" });
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
      category: d.category,
      icon: d.icon,
      priority: 30,

      defaults: { pid: d.pid, style: d.style, w: d.w, h: d.h, x: 40, y: 40, z: 99 },

      /**
       * 与旧实现**完全同构**：
       * 量程与阈值从 `BUILTIN_PIDS[resolvePid(pid)]` 实时取，缺省 0/100。
       * ⚠️ 不写死字面量 —— 否则 BUILTIN_PIDS 更新时会两边不一致。
       */
      build(props) {
        const p = props || {};
        const pid = p.pid === undefined ? d.pid : p.pid;
        const info = (window.BUILTIN_PIDS && window.resolvePid(pid)
          ? window.BUILTIN_PIDS[window.resolvePid(pid)]
          : null) || {};

        const node = window.createNode(window.NODE_GAUGE, {
          name: p.name === undefined ? d.name : p.name,
          pid: pid,
          style: p.style === undefined ? d.style : p.style,
          min: p.min === undefined ? (info.min === undefined ? 0 : info.min) : p.min,
          max: p.max === undefined ? (info.max === undefined ? 100 : info.max) : p.max,
          warnLow: p.warnLow === undefined ? (info.warnLow === undefined ? null : info.warnLow) : p.warnLow,
          warnHigh: p.warnHigh === undefined ? (info.warnHigh === undefined ? null : info.warnHigh) : p.warnHigh,
          x: p.x === undefined ? 40 : p.x,
          y: p.y === undefined ? 40 : p.y,
          w: p.w === undefined ? d.w : p.w,
          h: p.h === undefined ? d.h : p.h,
          z: p.z === undefined ? 99 : p.z,
        });
        node.__controlKey = d.key;
        return node;
      },

      schema: gaugeSchema(),
      slots: slotsOf(d),
      render: { mode: "gauge", adapter: "drawGaugeNode" },
      validate: gaugeValidate,
    });
    registered++;
  });

  ICAR.registry.gaugeFamily = { registered: registered, skipped: skipped, total: DEFS.length };
})();
