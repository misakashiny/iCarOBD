/* ==========================================================================
   js/registry/controls/t_label.js —— P1A 试点控件（唯一迁移的一个）
   ==========================================================================

   ## 为什么选 t_label

   P0 审计 §11 的推荐：无 `parts` 子树、无 `states` 状态机、无 `trackStyle`、
   字段少、已有 `verify-font.js` 覆盖。

   ## 本文件的任务（P1A 验收）

   不是"替换旧实现"，而是**证明新路径能产出与旧路径完全相同的节点**。
   旧 `t_label` 仍留在 `presets.js:199-215` 的数组里照常工作。

   验收方式：`ICAR.registry.Control.build("t_label")` 与
   `BUILTIN_CONTROLS.find(c=>c.key==="t_label").make()` 产出的节点，
   经 `nodeToJson()` 序列化后除 `id` 外逐字段相等。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("controls/t_label.js 必须在 core/namespace.js 之后加载");

  /**
   * 旧实现的事实基准（从 `presets.js` 的 `t_label` 条目抄来，**逐字段对照**）：
   *
   * ```js
   * { key: "t_label", name: "标签文字", text: "标签", w: 120, h: 20,
   *   size: 7, color: "#8FA0B8", weight: 400 }
   * ...
   * createNode(window.NODE_TEXT, {
   *   name: d.name, text: d.text, x: 40, y: 40, w: d.w, h: d.h, z: 99,
   *   font: { family: "sans", size: d.size, weight: d.weight,
   *           align: "center", color: d.color },
   * })
   * ```
   *
   * ⚠️ `x/y` 固定 40、`z` 固定 99 —— 这是旧实现的**硬编码**，
   * 本文件保持一致（P1A 不改行为，只换定义位置）。
   */
  ICAR.registry.Control.define({
    key: "t_label",
    legacyKey: "t_label",        // ← 与旧 BUILTIN_CONTROLS 的 key 一致（兼容映射）
    name: "标签文字",
    category: "文字",
    icon: "T",
    priority: 10,

    /** 默认节点字段（不含 font，font 在 build 里组装以保持与旧实现同构） */
    defaults: {
      text: "标签",
      w: 120,
      h: 20,
      x: 40,
      y: 40,
      z: 99,
    },

    /**
     * 字体默认值 —— **必须与旧实现的字面量逐字段一致**。
     * 旧实现只给了 `family/size/weight/align/color`，
     * 其余（`italic`/`letterSpacing`）由 `normalizeFont` 补默认。
     */
    fontDefaults: {
      family: "sans",
      size: 7,
      weight: 400,
      align: "center",
      color: "#8FA0B8",
    },

    build(props) {
      const p = props || {};
      const f = Object.assign({}, this.fontDefaults, p.font || {});
      const node = window.createNode(window.NODE_TEXT, {
        name: p.name === undefined ? this.name : p.name,
        text: p.text === undefined ? this.defaults.text : p.text,
        x: p.x === undefined ? this.defaults.x : p.x,
        y: p.y === undefined ? this.defaults.y : p.y,
        w: p.w === undefined ? this.defaults.w : p.w,
        h: p.h === undefined ? this.defaults.h : p.h,
        z: p.z === undefined ? this.defaults.z : p.z,
        font: f,
      });
      // 标记来源控件（**不写进设计文件** —— nodeToJson 是白名单，不会带它出去）
      node.__controlKey = p.__controlKey || this.key;
      return node;
    },

    /** 属性 Schema —— P1A **只登记、不驱动 UI**（面板仍走 panels.js 手写逻辑） */
    schema: [
      { key: "text", label: "文字内容", type: "string", group: "文字" },
      { key: "font.size", label: "字号", type: "number", group: "字体", min: 1, max: 200 },
      { key: "font.weight", label: "字重", type: "enum", values: [400, 500, 600, 700, 900], group: "字体" },
      { key: "font.color", label: "颜色", type: "color", group: "字体" },
      { key: "font.align", label: "对齐", type: "enum", values: ["left", "center", "right"], group: "字体" },
      { key: "w", label: "宽度", type: "number", group: "变换", min: 1 },
      { key: "h", label: "高度", type: "number", group: "变换", min: 1 },
    ],

    /** 数据槽：文字不显示数据 → 空。这条本身就是"它不需要数据源"的声明 */
    slots: [],

    /** 渲染能力声明（供后续渲染适配层分派；P1A 不被消费） */
    render: {
      mode: "text",
      /** 渲染器名称：对应 `canvas.js` 的 drawTextNode */
      adapter: "drawTextNode",
    },

    /**
     * 运行前校验：文字控件没有数据依赖，只检查必要字段是否成型。
     * @returns {Array} 问题列表（空 = 通过）
     */
    validate(node) {
      const issues = [];
      if (!node) return [{ level: "error", code: "no-node", message: "节点为空" }];
      if (node.w <= 0 || node.h <= 0) {
        issues.push({
          level: "warn",
          code: "zero-size",
          message: "文字控件的尺寸为 0，画布上不可见",
        });
      }
      return issues;
    },
  });
})();
