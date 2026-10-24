/* ==========================================================================
   js/primitive-presets.js —— P5B-M05 阶段 E：基元快捷预设
   ==========================================================================

   ## 范围（任务 §七 明确限定）

   「可以新增快捷预设，如普通转速环、赛车红区转速环、分段油门环。
     **这些是控件预设，不是新增 node type。**」

   所以本文件：
     · 只产出 `segmentedArc` / `shape` / `valueText` 三种**已有**节点的参数组合
     · **不注册任何新 type**
     · 不改 `PrimitiveParser` 的数值映射

   ## 为什么需要预设

   做一个"赛车红区转速环"要调 12 个字段（起止角、分段、空隙、粗细、
   三个颜色、zoneColors 四段…）。用户第一次做要试十几次。
   预设给一个**能直接用的起点**，之后微调。

   ## zoneColors 的语义（不改变）

   与 v3 规范一致：`[{at, color}]`，`at ∈ 0..1` 表示**进度比例**，
   渲染时按 `at` 升序取色。预设只是把一组合理的值填进去。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("primitive-presets.js 必须在 core/namespace.js 之后加载");

  /**
   * 预设定义的公共结构：
   *   key      稳定标识（导出/测试用）
   *   name     界面显示名
   *   type     产出的 node type（**只能是 v3 已有的四种之一**）
   *   props    要合并进节点的字段（不含 id/type）
   *   note     一句人话说明「这个预设适合什么场景」
   */
  const PRESETS = [
    // ================================================================
    // SegmentedArc
    // ================================================================
    {
      key: "arc_plain_rpm",
      name: "普通转速环",
      type: "segmentedArc",
      note: "一整圈均匀分段，单调粉色点亮。适合没有明确红线的车。",
      props: {
        name: "转速环",
        pid: "obd.rpm", minVal: 0, maxVal: 8000,
        startAngle: 150, sweepAngle: 240,
        segmentCount: 24, gapAngle: 2, thickness: 10, radiusRatio: 0.42,
        activeColor: "#FF3D7F", inactiveColor: "#4A5058", noDataColor: "#FF4D4F",
        // 无分区色 —— 单调更干净
        zoneColors: [],
      },
    },
    {
      key: "arc_racing_redzone",
      name: "赛车红区转速环",
      type: "segmentedArc",
      note: "36 段细密刻度 + 四段分区色（粉→粉→琥珀→红）：7200 起进红区。这是 P5B-M04 模板 A 用的那套。",
      props: {
        name: "转速环",
        pid: "obd.rpm", minVal: 0, maxVal: 8000,
        startAngle: 135, sweepAngle: 270,
        segmentCount: 36, gapAngle: 1.6, thickness: 10, radiusRatio: 0.44,
        activeColor: "#FF3D7F", inactiveColor: "#4A5058", noDataColor: "#FF4D4F",
        zoneColors: [
          { at: 0, color: "#FF3D7F" },
          { at: 0.72, color: "#FF3D7F" },
          { at: 0.82, color: "#FFB020" },
          { at: 0.92, color: "#FF2D3D" },
        ],
      },
    },
    {
      key: "arc_throttle",
      name: "分段油门环",
      type: "segmentedArc",
      note: "半圈（150°→240° 中的 180°），12 粗段，绿→黄→红三段。适合油门开度/负载这类 0-100 的量。",
      props: {
        name: "油门环",
        pid: "obd.throttle", minVal: 0, maxVal: 100,
        startAngle: 180, sweepAngle: 180,
        segmentCount: 12, gapAngle: 3, thickness: 14, radiusRatio: 0.40,
        activeColor: "#39D98A", inactiveColor: "#3A4048", noDataColor: "#FF4D4F",
        zoneColors: [
          { at: 0, color: "#39D98A" },
          { at: 0.60, color: "#FFB020" },
          { at: 0.85, color: "#FF2D3D" },
        ],
      },
    },

    // ================================================================
    // Shape
    // ================================================================
    {
      key: "shape_panel",
      name: "圆角面板",
      type: "shape",
      note: "深色圆角面板 + 细描边，当容器/卡片底。比纯矩形有质感。",
      props: {
        name: "面板", w: 220, h: 220,
        kind: "roundRect", fill: "#121A24", stroke: "#243040", strokeWidth: 1.5,
        cornerRadius: 24, innerRatio: 0.6,
      },
    },
    {
      key: "shape_ring_frame",
      name: "圆环框",
      type: "shape",
      note: "空心圆环，给圆盘类仪表做外框装饰。",
      props: {
        name: "圆环", w: 140, h: 140,
        kind: "ring", fill: "#1B2430", stroke: "#3DD6FF", strokeWidth: 2,
        cornerRadius: 0, innerRatio: 0.72,
      },
    },
    {
      key: "shape_divider",
      name: "分隔线",
      type: "shape",
      note: "一条细横线，用来分隔上下区域。",
      props: {
        name: "分隔线", w: 320, h: 2,
        kind: "line", fill: "none", stroke: "#2A3038", strokeWidth: 1,
      },
    },

    // ================================================================
    // ValueText
    // ================================================================
    {
      key: "vt_big_speed",
      name: "大号车速",
      type: "valueText",
      note: "46 号白字 + 小单位，居中。仪表盘主读数用。",
      props: {
        name: "车速", w: 160, h: 56,
        pid: "obd.speed", decimals: 0, size: 46, unitSize: 14, unit: "km/h",
        align: 1, color: "#FFFFFF", noDataColor: "#7A8088",
      },
    },
    {
      key: "vt_gear",
      name: "挡位",
      type: "valueText",
      note: "用 valueLabels 把 0..6 映射成 N/1..6，大号青色。",
      props: {
        name: "挡位", w: 120, h: 56,
        pid: "calc.calc_gear", decimals: 0, size: 44, unitSize: 12, unit: "",
        align: 1, color: "#3DD6FF", noDataColor: "#7A8088",
        valueLabels: ["N", "1", "2", "3", "4", "5", "6"],
      },
    },
    {
      key: "vt_coolant_warn",
      name: "水温（带报警）",
      type: "valueText",
      note: "105 起琥珀、115 起红。修车厂最常看的那个表。",
      props: {
        name: "水温", w: 90, h: 34,
        pid: "obd.coolant", decimals: 0, size: 24, unitSize: 10, unit: "°C",
        align: 1, color: "#FFFFFF",
        warnHigh: 105, criticalHigh: 115,
        warnColor: "#FFB020", criticalColor: "#FF4D4F", noDataColor: "#7A8088",
      },
    },
  ];

  /** 按 type 分组（给界面用）*/
  function grouped() {
    const g = {};
    PRESETS.forEach(function (p) {
      (g[p.type] = g[p.type] || []).push({ key: p.key, name: p.name, note: p.note });
    });
    return g;
  }

  /** 取一个预设定义 */
  function get(key) {
    return PRESETS.filter(function (p) { return p.key === key; })[0] || null;
  }

  /**
   * 把一个预设**应用到已有节点**上。
   *
   * ⚠️ 只写 `props` 里出现的字段 —— 其余字段（x/y/z/rotation/alpha 等）保持原样。
   * 这样用户先把控件摆好位置，再套预设，位置不会被打乱。
   *
   * @param {string} key 预设 key
   * @param {object} node 目标节点（必须同 type）
   * @param {boolean} withHistory 是否记一条历史（默认 true）
   * @returns {{ok:boolean, applied?:string[], error?:string}}
   */
  function applyTo(key, node, withHistory) {
    const p = get(key);
    if (!p) return { ok: false, error: "没有这个预设：" + key };
    if (!node) return { ok: false, error: "没有目标节点" };
    if (node.type !== p.type) {
      return { ok: false, error: "预设「" + p.name + "」只能用在 " + p.type + " 上（当前是 " + node.type + "）" };
    }
    const applied = [];
    Object.keys(p.props).forEach(function (k) {
      const v = p.props[k];
      // 深拷贝数组/对象，避免预设定义被用户后续编辑污染
      node[k] = (v && typeof v === "object") ? JSON.parse(JSON.stringify(v)) : v;
      applied.push(k);
    });
    if (withHistory !== false && typeof window.commit === "function") {
      window.commit(function () { }, "套用预设：" + p.name);
    } else if (withHistory !== false && typeof window.commit !== "function") {
      if (window.console && console.warn) {
        console.warn("[PrimitivePresets] 找不到 window.commit —— 套用预设不会进撤销栈");
      }
    }
    return { ok: true, applied: applied };
  }

  window.PrimitivePresets = {
    LIST: PRESETS.map(function (p) { return { key: p.key, name: p.name, type: p.type, note: p.note }; }),
    grouped: grouped,
    get: get,
    applyTo: applyTo,
    /** 预设产出哪些 type（测试用：必须都是 v3 已有的）*/
    typesUsed: function () {
      const s = {};
      PRESETS.forEach(function (p) { s[p.type] = true; });
      return Object.keys(s);
    },
  };
})();
