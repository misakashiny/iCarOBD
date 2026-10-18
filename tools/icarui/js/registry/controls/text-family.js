/* ==========================================================================
   js/registry/controls/text-family.js —— P3A 文字控件族（12 条）
   ==========================================================================

   ## 本文件做什么

   把 12 个文字控件**正式迁移到 Control Registry**，使 Registry 成为
   「文字控件怎么创建」的**唯一事实源**。

   | # | key | 旧实现位置 |
   |---|---|---|
   | 1 | `text` | `presets.js:146` |
   | 2 | `t_title` | `presets.js:200` |
   | 3 | `t_label` | `presets.js:201`（**P1A 已注册，本文件跳过**）|
   | 4 | `t_unit` | `presets.js:202` |
   | 5 | `t_big` | `presets.js:203` |
   | 6 | `t_small` | `presets.js:496` |
   | 7 | `t_warn` | `presets.js:494` |
   | 8 | `t_ok` | `presets.js:495` |
   | 9 | `t_bigunit` | `presets.js:497` |
   | 10 | `box_h1` | `presets.js:419` |
   | 11 | `box_h2` | `presets.js:420` |
   | 12 | `box_note` | `presets.js:421` |

   ## ⚠️ 关于 `t_label` 与 `text`

   * `t_label` 在 **P1A** 已由 `controls/t_label.js` 注册。本文件**不再注册它**
     （重复 key 会抛错）—— 加载顺序上 `t_label.js` 先加载，本文件过滤掉它。
   * `text` 与 `t_label` **不是同一个东西**（P3A 前的实测差异，见下方 DIFF 注释），
     不能合并。

   ## 默认值从哪来

   **全部照抄旧实现**（`presets.js` 的字面量），逐字段对齐。
   任何一处「顺手优化」都会让 Golden Fixture 对比失败 —— 这是有意的约束。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("text-family.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("text-family.js 必须在 control-registry.js 之后加载");

  /** 统一构造文字节点（与旧实现同构：createNode(NODE_TEXT, {...}) + font 对象） */
  function buildText(d, props) {
    const p = props || {};
    const f = Object.assign({
      family: "sans",
      size: d.size,
      weight: d.weight,
      align: d.align,
      color: d.color,
    }, p.font || {});
    const node = window.createNode(window.NODE_TEXT, {
      name: p.name === undefined ? d.name : p.name,
      text: p.text === undefined ? d.text : p.text,
      x: p.x === undefined ? (d.x === undefined ? 40 : d.x) : p.x,
      y: p.y === undefined ? (d.y === undefined ? 40 : d.y) : p.y,
      w: p.w === undefined ? d.w : p.w,
      h: p.h === undefined ? d.h : p.h,
      z: p.z === undefined ? (d.z === undefined ? 99 : d.z) : p.z,
      font: f,
    });
    node.__controlKey = d.key;
    return node;
  }

  /**
   * 12 条的默认值表。
   *
   * ⚠️ **每一行都逐字段对照 `presets.js` 的旧字面量**。
   * 特别容易搞错的几处（P3A 生成 Golden Fixture 时实测到的）：
   *
   * | key | 坑 |
   * |---|---|
   * | `text` | 旧实现用 `fontSize: 18` + **顶层 color**，经 `createNode` 归一化后
   * |        | 变成 `font.size=6`（`18/360*120` 之类换算）、`align="left"`、`color="#E8EEF7"` |
   * |        | —— **不是**直接给 font 对象。必须照抄旧写法，不能"顺手规范化"。 |
   * | `box_h1/2/note` | 旧实现**不给 `name`**，`name` 由 `defaultName(NODE_TEXT)` 兜底 |
   * | 全部 | 旧实现 `align: "center"`，但 `text` 是 `"left"` |
   */
  const DEFS = [
    // ---- 通用文字（presets.js:146）
    // 注意：旧实现是 { name:"文字", text:"标题", fontSize:18, color:"#8FA0B8" }，
    // 经 createNode 归一化 → font.size=6 / align=left / color=#E8EEF7。
    // 这里必须用**同样的入参形式**，否则序列化结果不同。
    {
      key: "text", legacyKey: "text", name: "文字", category: "文字",
      raw: { name: "文字", text: "标题", fontSize: 18, color: "#8FA0B8",
             x: 40, y: 40, w: 160, h: 30, z: 99 },
    },

    // ---- 文字四件套（presets.js:199-215，font 对象形式）
    { key: "t_title", legacyKey: "t_title", name: "标题文字", category: "文字",
      d: { name: "标题文字", text: "标题", w: 200, h: 34, size: 14, color: "#E8EEF7", weight: 700, align: "center" } },
    // t_label：P1A 已注册，此处仅占位（下方会跳过）
    { key: "t_label", legacyKey: "t_label", name: "标签文字", category: "文字", skip: true },
    { key: "t_unit", legacyKey: "t_unit", name: "单位文字", category: "文字",
      d: { name: "单位文字", text: "km/h", w: 60, h: 16, size: 6, color: "#5F6E85", weight: 400, align: "center" } },
    { key: "t_big", legacyKey: "t_big", name: "大号数字", category: "文字",
      d: { name: "大号数字", text: "000", w: 160, h: 60, size: 24, color: "#00D8FF", weight: 900, align: "center" } },

    // ---- 更多控件里的文字（presets.js:494-497）
    { key: "t_warn", legacyKey: "t_warn", name: "警告文字", category: "文字",
      d: { name: "警告文字", text: "警告", w: 160, h: 30, size: 12, color: "#FF4D4F", weight: 700, align: "center" } },
    { key: "t_ok", legacyKey: "t_ok", name: "正常文字", category: "文字",
      d: { name: "正常文字", text: "正常", w: 140, h: 26, size: 10, color: "#39D98A", weight: 700, align: "center" } },
    { key: "t_small", legacyKey: "t_small", name: "小标签", category: "文字",
      d: { name: "小标签", text: "RPM", w: 70, h: 14, size: 5, color: "#5F6E85", weight: 400, align: "center" } },
    { key: "t_bigunit", legacyKey: "t_bigunit", name: "大号单位", category: "文字",
      d: { name: "大号单位", text: "km/h", w: 120, h: 30, size: 14, color: "#8FA0B8", weight: 400, align: "center" } },

    // ---- box_h1/h2/note（presets.js:419-421）
    // ⚠️ 前缀是 box_ 但产出 text 节点 → 归文字族（P3A 明确要求）
    // ⚠️⚠️ box_* 的旧实现是 { fontSize: d.size, color: d.color }，
    // **不传 font 对象** → createNode 调 normalizeFont(undefined) → **整个落到 FONT_DEFAULT**
    // （size=6 / weight=400 / align=left），fontSize 与 color 都被忽略！
    // 这是 P3A 生成 Golden Fixture 时才发现的：源码字面量看着像 size=30，
    // 实际产出是 size=6。必须用同样的入参形式，不能"照字面抄"。
    { key: "box_h1", legacyKey: "box_h1", name: "大标题", category: "文字",
      raw: { name: "大标题", text: "仪表盘", fontSize: 30, color: "#CFE0EE",
             w: 200, h: 44, x: 40, y: 40, z: 99 } },
    { key: "box_h2", legacyKey: "box_h2", name: "小标题", category: "文字",
      raw: { name: "小标题", text: "分组标题", fontSize: 20, color: "#8FA0B8",
             w: 160, h: 32, x: 40, y: 40, z: 99 } },
    { key: "box_note", legacyKey: "box_note", name: "小注释", category: "文字",
      raw: { name: "小注释", text: "单位 / 说明", fontSize: 12, color: "#5F6E85",
             w: 140, h: 20, x: 40, y: 40, z: 99 } },
  ];

  /** 统一的属性 Schema（文字类共用） */
  function textSchema() {
    return [
      { key: "text", label: "文字内容", type: "string", group: "文字" },
      { key: "font.size", label: "字号", type: "number", group: "字体", min: 1, max: 400 },
      { key: "font.weight", label: "字重", type: "enum", values: [400, 500, 600, 700, 900], group: "字体" },
      { key: "font.color", label: "颜色", type: "color", group: "字体" },
      { key: "font.align", label: "对齐", type: "enum", values: ["left", "center", "right"], group: "字体" },
      { key: "w", label: "宽度", type: "number", group: "变换", min: 1 },
      { key: "h", label: "高度", type: "number", group: "变换", min: 1 },
    ];
  }

  /** 统一校验：文字控件不看数据源，只检查尺寸与字号（P3A 第五部分） */
  function textValidate(node) {
    const issues = [];
    if (!node) return [{ level: "error", code: "no-node", message: "节点为空" }];
    if (node.w <= 0 || node.h <= 0) {
      issues.push({ level: "warn", code: "zero-size", message: "文字控件尺寸为 0，画布上不可见" });
    }
    const f = node.font || {};
    if (!(f.size > 0)) {
      issues.push({ level: "warn", code: "zero-font", message: "字号为 0，文字不可见" });
    }
    return issues;
  }

  let registered = 0;
  let skipped = 0;

  DEFS.forEach(function (d) {
    if (d.skip) { skipped++; return; }          // t_label 由 P1A 注册
    if (Reg.has(d.key)) { skipped++; return; }  // 防重复注册（幂等）

    // `text` / `box_*` 走旧实现的入参形式（fontSize + 顶层 color，不传 font 对象）
    if (d.raw) {
      Reg.define({
        key: d.key, legacyKey: d.legacyKey, name: d.name, category: d.category,
        icon: "T", priority: d.key === "text" ? 10 : 12,
        defaults: {},
        build(props) {
          const p = Object.assign({}, d.raw, props || {});
          const node = window.createNode(window.NODE_TEXT, p);
          node.__controlKey = d.key;
          return node;
        },
        schema: textSchema(),
        slots: [],
        render: { mode: "text", adapter: "drawTextNode" },
        validate: textValidate,
      });
      registered++;
      return;
    }

    Reg.define({
      key: d.key, legacyKey: d.legacyKey, name: d.name, category: d.category,
      icon: "T", priority: 12,
      defaults: {},
      build(props) {
        return buildText(d.d, props);
      },
      schema: textSchema(),
      slots: [],
      render: { mode: "text", adapter: "drawTextNode" },
      validate: textValidate,
    });
    registered++;
  });

  // 暴露统计，给测试与自检用
  ICAR.registry.textFamily = { registered: registered, skipped: skipped, total: DEFS.length };
})();
