/* ==========================================================================
   js/registry/controls/container-family.js —— P3B 容器控件族（4 条）
   ==========================================================================

   ## 范围

   | # | key | 旧实现位置 | 旧 name |
   |---|---|---|---|
   | 1 | `group` | `presets.js:378-385` | `分组` |
   | 2 | `box_card` | `presets.js:401-403` | `卡片容器（放一组相关读数的底板）` |
   | 3 | `box_row` | `presets.js:401-403` | `横向分组（左右排列的几个控件）` |
   | 4 | `box_col` | `presets.js:401-403` | `纵向分组（上下排列的几个控件）` |

   ⚠️ **`box_h1` / `box_h2` / `box_note` 不在本文件** —— 它们在 P3A 已归入文字族迁移完毕。

   ## 两个必须照抄的细节（Golden 抓到）

   1. **`group` 的 name 是「分组」，不是 key 或「空分组」**
      旧实现：`createNode(NODE_GROUP, { name: "分组", ... })`

   2. **`box_*` 的 name 会被追加用途提示**
      旧实现：
      ```js
      const n = createNode(NODE_GROUP, { name: d.name, ... });
      n.name = d.name + "（" + d.note + "）";   // ← 追加 note！
      ```
      所以实际 name 是 `卡片容器（放一组相关读数的底板）`，**不是** `卡片容器`。
      这是 P3B 里最容易抄错的一处。

   ## 数据槽与校验

   容器**不读数据**：`slots: []`。
   `validate()` 只检查尺寸为 0（不可见）与子节点层级深度（与 App 的 `MAX_NODE_DEPTH` 对齐）。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("container-family.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("container-family.js 必须在 control-registry.js 之后加载");

  /** 统一的属性 Schema（容器类共用） */
  function containerSchema() {
    return [
      { key: "w", label: "宽度", type: "number", group: "变换", min: 1 },
      { key: "h", label: "高度", type: "number", group: "变换", min: 1 },
      { key: "rotation", label: "旋转", type: "number", group: "变换" },
      { key: "scale", label: "缩放", type: "number", group: "变换", min: 0.01 },
      { key: "alpha", label: "不透明度", type: "number", group: "图层", min: 0, max: 255 },
      { key: "locked", label: "锁定", type: "boolean", group: "图层" },
      { key: "visible", label: "可见", type: "boolean", group: "图层" },
    ];
  }

  /**
   * 容器校验。
   *
   * 只做**能被证据支持**的检查：
   *   · 尺寸为 0 → 不可见（warn，与文字族一致）
   *   · 子节点深度超过 MAX_NODE_DEPTH → error（与 App 契约一致）
   *
   * ⚠️ 不去校验"子节点是否越界"—— 当前版本**不裁剪**子节点（见 P3B 报告
   * 「未支持的行为」），把未支持的操作写成校验会误导使用者。
   */
  function containerValidate(node) {
    const issues = [];
    if (!node) return [{ level: "error", code: "no-node", message: "节点为空" }];
    if (node.w <= 0 || node.h <= 0) {
      issues.push({ level: "warn", code: "zero-size", message: "容器尺寸为 0，其内容不可见" });
    }
    const maxDepth = window.MAX_NODE_DEPTH || 32;
    const depth = (function d(n) {
      if (!n || !n.children || !n.children.length) return 1;
      return 1 + Math.max.apply(null, n.children.map(d));
    })(node);
    if (depth > maxDepth) {
      issues.push({
        level: "error", code: "too-deep",
        message: "容器嵌套深度 " + depth + " 超过上限 " + maxDepth + "（与 App 契约一致）",
      });
    }
    return issues;
  }

  const DEFS = [
    // ---- group（presets.js:378-385）
    // ⚠️ name 是「分组」而非「空分组」—— 后者是库里的显示名 c.name
    { key: "group", legacyKey: "group", name: "空分组", nodeName: "分组",
      category: "容器与组合", w: 160, h: 160 },

    // ---- box_card / box_row / box_col（presets.js:401-416）
    // ⚠️ 实际 name = d.name + "（" + d.note + "）"
    { key: "box_card", legacyKey: "box_card", name: "卡片容器",
      category: "容器与组合", w: 320, h: 200,
      nodeName: "卡片容器（放一组相关读数的底板）" },
    { key: "box_row", legacyKey: "box_row", name: "横向分组",
      category: "容器与组合", w: 340, h: 100,
      nodeName: "横向分组（左右排列的几个控件）" },
    { key: "box_col", legacyKey: "box_col", name: "纵向分组",
      category: "容器与组合", w: 140, h: 320,
      nodeName: "纵向分组（上下排列的几个控件）" },
  ];

  let registered = 0;
  let skipped = 0;

  DEFS.forEach(function (d) {
    if (Reg.has(d.key)) { skipped++; return; }   // 幂等 / 防重复注册

    Reg.define({
      key: d.key,
      legacyKey: d.legacyKey,
      name: d.name,
      category: d.category,
      icon: "▤",
      priority: 20,

      /** 默认节点字段（与旧实现逐字段对齐） */
      defaults: { w: d.w, h: d.h, x: 40, y: 40, z: 99 },

      build(props) {
        const p = props || {};
        const node = window.createNode(window.NODE_GROUP, {
          name: p.name === undefined ? d.nodeName : p.name,
          x: p.x === undefined ? 40 : p.x,
          y: p.y === undefined ? 40 : p.y,
          w: p.w === undefined ? d.w : p.w,
          h: p.h === undefined ? d.h : p.h,
          z: p.z === undefined ? 99 : p.z,
        });
        node.__controlKey = d.key;
        return node;
      },

      schema: containerSchema(),
      slots: [],                                   // 容器不读数据
      render: { mode: "container", adapter: null }, // 容器不绘自身
      validate: containerValidate,
    });
    registered++;
  });

  ICAR.registry.containerFamily = { registered: registered, skipped: skipped, total: DEFS.length };
})();
