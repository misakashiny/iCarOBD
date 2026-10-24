/* ==========================================================================
   js/registry/controls/primitive-family.js —— P5B-M04 高级基元（4 条）
   ==========================================================================

   ## 授权依据

   任务 P5B-M04 §一 明确授权：
     · 新增主题格式 `icar.ui/3`
     · 新增 `segmentedArc` / `pathProgress` / `valueText` / `shape` 四种正式节点类型

   ## 与 P5B-M01 原型的关系

   `advanced-primitives-proto.js`（`PROTO: true`）是**绘制内核**：它只负责画，
   不注册控件。本文件是**正式注册层**：把四种 type 接进 Registry，
   让它们出现在控件库、能被拖进画布、能被属性面板编辑、能进 Undo/Redo。

   两者分工明确：
     · 原型文件 = 绘制函数（drawSegmentedArc 等）
     · 本文件   = 控件定义（key / build / schema / slots / render）

   ⚠️ **不重复实现绘制**：`render.adapter` 指向原型里的绘制函数。

   ## v3 专属

   这四种节点**只有 `icar.ui/3` 主题才合法**。
   编辑器在 v1/v2 设计里放入它们时，保存会**自动升级为 v3**（见 schema.js 的
   `ensureSchemaForNodes`）。Android 侧对 v1/v2 里的这些 type 会报错。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("primitive-family.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("primitive-family.js 必须在 control-registry.js 之后加载");

  /** v3 的四种 type（与 Android DesignNode.TYPES_V3_ONLY 逐条一致）*/
  const V3_TYPES = ["valueText", "shape", "segmentedArc", "pathProgress"];

  /**
   * 属性面板的分组结构。
   *
   * 指令 §六 明确要求：「避免将几十个字段全部平铺到一个长面板中」，
   * 按**基础 / 外观 / 几何 / 数据绑定 / 动画与状态**分组。
   */
  function baseSchema() {
    return [
      { group: "基础属性", fields: [
        { key: "name", label: "名称", type: "text" },
        { key: "x", label: "X", type: "number", min: 0, max: 360, step: 1 },
        { key: "y", label: "Y", type: "number", min: 0, max: 360, step: 1 },
        { key: "z", label: "层级", type: "number", step: 1 },
        { key: "locked", label: "锁定", type: "bool" },
        { key: "visible", label: "显示", type: "bool" },
      ]},
      { group: "几何", fields: [
        { key: "w", label: "宽", type: "number", min: 1, max: 360, step: 1 },
        { key: "h", label: "高", type: "number", min: 1, max: 360, step: 1 },
        { key: "rotation", label: "旋转", type: "number", min: -360, max: 360, step: 1 },
        { key: "scale", label: "缩放", type: "number", min: 0.05, max: 10, step: 0.05 },
      ]},
      { group: "外观", fields: [
        { key: "alpha", label: "透明度", type: "number", min: 0, max: 255, step: 1 },
      ]},
    ];
  }

  const pidField = { key: "pid", label: "PID", type: "pid" };
  const rangeFields = [
    { key: "minVal", label: "量程最小", type: "number", step: 1 },
    { key: "maxVal", label: "量程最大", type: "number", step: 1 },
  ];

  // ================================================================
  // 1. valueText —— 动态数值
  // ================================================================
  function valueTextSchema() {
    const s = baseSchema();
    s[2].fields.push(
      { key: "color", label: "数值颜色", type: "color" },
      { key: "size", label: "字号", type: "number", min: 1, max: 200, step: 1 },
      { key: "unitSize", label: "单位字号", type: "number", min: 1, max: 100, step: 1 },
      { key: "align", label: "对齐", type: "select", options: [
        { value: 0, label: "左" }, { value: 1, label: "中" }, { value: 2, label: "右" }]},
    );
    s.push({ group: "数据绑定", fields: [
      pidField,
      { key: "unit", label: "单位", type: "text" },
      { key: "prefix", label: "前缀", type: "text" },
      { key: "suffix", label: "后缀", type: "text" },
      { key: "decimals", label: "小数位", type: "number", min: 0, max: 3, step: 1 },
    ]});
    s.push({ group: "动画与状态", fields: [
      { key: "warnHigh", label: "警告阈值", type: "number", step: 1, allowEmpty: true },
      { key: "criticalHigh", label: "危险阈值", type: "number", step: 1, allowEmpty: true },
      { key: "warnColor", label: "警告色", type: "color" },
      { key: "criticalColor", label: "危险色", type: "color" },
      { key: "noDataColor", label: "无数据色", type: "color" },
    ]});
    return s;
  }

  // ================================================================
  // 2. shape —— 基础图形
  // ================================================================
  function shapeSchema() {
    const s = baseSchema();
    s[2].fields.push(
      { key: "kind", label: "图形", type: "select", options: [
        { value: "rect", label: "矩形" },
        { value: "roundRect", label: "圆角矩形" },
        { value: "circle", label: "圆" },
        { value: "ring", label: "圆环" },
        { value: "line", label: "直线" },
        { value: "polyline", label: "折线" },
      ]},
      { key: "fill", label: "填充", type: "color" },
      { key: "stroke", label: "描边", type: "color" },
      { key: "strokeWidth", label: "描边宽", type: "number", min: 0, max: 100, step: 0.5 },
      { key: "cornerRadius", label: "圆角", type: "number", min: 0, max: 180, step: 1 },
      { key: "innerRatio", label: "圆环内径比", type: "number", min: 0.05, max: 0.95, step: 0.05 },
      { key: "rotationDeg", label: "图形旋转", type: "number", min: -360, max: 360, step: 1 },
    );
    return s;
  }

  // ================================================================
  // 3. segmentedArc —— 分段圆环
  // ================================================================
  function segmentedArcSchema() {
    const s = baseSchema();
    s[2].fields.push(
      { key: "activeColor", label: "点亮色", type: "color" },
      { key: "inactiveColor", label: "未点亮色", type: "color" },
      { key: "noDataColor", label: "无数据色", type: "color" },
    );
    s.push({ group: "几何", fields: [
      { key: "startAngle", label: "起始角", type: "number", min: -360, max: 360, step: 1 },
      { key: "sweepAngle", label: "扫角", type: "number", min: -360, max: 360, step: 1 },
      { key: "segmentCount", label: "分段数", type: "number", min: 1, max: 360, step: 1 },
      { key: "gapAngle", label: "段间空隙", type: "number", min: 0, max: 90, step: 0.1 },
      { key: "thickness", label: "线宽", type: "number", min: 0.5, max: 200, step: 0.5 },
      { key: "radiusRatio", label: "半径占比", type: "number", min: 0.05, max: 0.5, step: 0.01 },
    ]});
    s.push({ group: "数据绑定", fields: [pidField].concat(rangeFields) });
    return s;
  }

  // ================================================================
  // 4. pathProgress —— 曲线进度
  // ================================================================
  function pathProgressSchema() {
    const s = baseSchema();
    s[2].fields.push(
      { key: "activeColor", label: "已完成色", type: "color" },
      { key: "inactiveColor", label: "未完成色", type: "color" },
      { key: "gradientTo", label: "渐变终点", type: "color", allowEmpty: true },
      { key: "fill", label: "面积填充", type: "bool" },
      { key: "fillColor", label: "填充色", type: "color" },
      { key: "thickness", label: "线宽", type: "number", min: 0.5, max: 100, step: 0.5 },
      { key: "curve", label: "曲线类型", type: "select", options: [
        { value: 0, label: "平滑" }, { value: 1, label: "折线" }]},
      { key: "forward", label: "正向进度", type: "bool" },
    );
    s.push({ group: "数据绑定", fields: [pidField].concat(rangeFields) });
    s.push({ group: "几何", fields: [
      // 点数组由专门的编辑器处理（指令 §六：「复杂路径控制点可以采用专门的编辑区域」）
      { key: "points", label: "控制点", type: "points", maxPoints: 64 },
    ]});
    return s;
  }

  // ================================================================
  // 注册
  // ================================================================
  const DEFS = [
    {
      key: "p_value_text", type: "valueText", name: "数值", icon: "🔢",
      w: 100, h: 44, schema: valueTextSchema,
      defaults: {
        pid: "obd.speed", decimals: 0, unit: "km/h", unitSize: 12, size: 28, align: 1,
        color: "#FFFFFF", warnColor: "#FFB020", criticalColor: "#FF4D4F", noDataColor: "#7A8088",
      },
    },
    {
      key: "p_shape", type: "shape", name: "图形", icon: "⬛",
      w: 160, h: 80, schema: shapeSchema,
      defaults: {
        kind: "roundRect", fill: "#1B2430", stroke: "#3DD6FF", strokeWidth: 2,
        cornerRadius: 12, innerRatio: 0.6, strokeWidth2: 0,
      },
    },
    {
      key: "p_segmented_arc", type: "segmentedArc", name: "分段圆环", icon: "◕",
      w: 130, h: 130, schema: segmentedArcSchema,
      defaults: {
        pid: "obd.rpm", minVal: 0, maxVal: 8000,
        startAngle: 150, sweepAngle: 240, segmentCount: 24, gapAngle: 2, thickness: 12,
        activeColor: "#FF3D7F", inactiveColor: "#4A5058", noDataColor: "#FF4D4F", radiusRatio: 0.42,
      },
    },
    {
      key: "p_path_progress", type: "pathProgress", name: "曲线进度", icon: "〰",
      w: 200, h: 100, schema: pathProgressSchema,
      defaults: {
        pid: "obd.load", minVal: 0, maxVal: 100, thickness: 6, curve: 0,
        activeColor: "#3DD6FF", inactiveColor: "#2A3038",
        gradientTo: "#00E5FF", fill: false, forward: true,
        points: [{ x: 0, y: 1 }, { x: 0.25, y: 0.35 }, { x: 0.6, y: 0.12 }, { x: 1, y: 0.05 }],
      },
    },
  ];

  let added = 0, skipped = 0;

  DEFS.forEach(function (d) {
    if (Reg.has(d.key)) { skipped++; return; }

    Reg.define({
      key: d.key,
      legacyKey: d.key,
      name: d.name,
      category: "primitive",
      icon: d.icon,
      priority: 60,

      /** 这个控件产出的节点 type（v3 专属）*/
      nodeType: d.type,

      defaults: Object.assign({ x: 20, y: 20, z: 100, rotation: 0, scale: 1, alpha: 255 }, d.defaults, { w: d.w, h: d.h }),

      /**
       * 建节点。
       *
       * ⚠️ **不复制原型里的绘制逻辑** —— 只是 `createNode(type, props)`。
       * 绘制由 canvas.js 的 `drawNode` 分派到 `drawGaugeStylePreview` 之后的
       * `drawPrimitiveNode`（见 canvas.js 的 P5B-M04 分支）。
       */
      build(props) {
        const p = props || {};
        const merged = {};
        Object.keys(d.defaults).forEach(function (k) {
          merged[k] = d.defaults[k];
        });
        Object.keys(p).forEach(function (k) {
          if (p[k] !== undefined) merged[k] = p[k];
        });
        merged.name = p.name === undefined ? d.name : p.name;
        merged.x = p.x === undefined ? 20 : p.x;
        merged.y = p.y === undefined ? 20 : p.y;
        merged.w = p.w === undefined ? d.w : p.w;
        merged.h = p.h === undefined ? d.h : p.h;
        merged.z = p.z === undefined ? 100 : p.z;

        const node = window.createNode(d.type, merged);
        node.__controlKey = d.key;
        return node;
      },

      schema: d.schema(),
      slots: [
        { key: "value", pid: d.defaults.pid || "", dataType: "number" },
      ],
      render: { mode: "primitive", adapter: "drawPrimitiveNode" },
    });
    added++;
  });

  window.PRIMITIVE_FAMILY = {
    V3_TYPES: V3_TYPES.slice(),
    added: added,
    skipped: skipped,
    /** 某个 type 是不是 v3 专属 */
    isV3Type: function (t) { return V3_TYPES.indexOf(t) >= 0; },
  };
})();
