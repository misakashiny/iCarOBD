/* ==========================================================================
   js/adapter/legacy-adapter.js —— 新旧路径的兼容适配层（P1A）
   ==========================================================================

   ## 职责

   新架构（Registry）与旧数据模型（`BUILTIN_CONTROLS` / `nodeToJson`）之间的桥。

   **本层只做两件事**：

   1. **读**：把旧的 `BUILTIN_CONTROLS` 条目映射成新 Registry 定义（单向，不改旧数组）
   2. **比**：提供"新旧两条路径产出是否等价"的对照工具（给测试与自检用）

   ## 硬约束

   * **不改 `icar.ui/2` 格式** —— 序列化仍走旧的 `nodeToJson`
   * **不改旧数组** —— `BUILTIN_CONTROLS` 一个元素都不动
   * **不接管渲染** —— P1A 不碰 `draw()` / 面板

   ## 为什么需要「比」

   P1A 的验收标准是「两条路径序列化后的已知字段一致」。
   手工比对不可靠，所以把它做成一个函数：`compare(legacyKey)` 返回差异列表。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("legacy-adapter.js 必须在 core/namespace.js 之后加载");

  const Adapter = {
    /**
     * 找一个旧库条目。
     * @param {string} legacyKey
     * @returns {Object|null}
     */
    legacyEntry(legacyKey) {
      const list = window.BUILTIN_CONTROLS || [];
      for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === legacyKey) return list[i];
      }
      return null;
    },

    /**
     * 用**旧路径**创建一个节点（就是库里那个 `make()`）。
     * @returns {Object|null}
     */
    buildLegacy(legacyKey) {
      const e = this.legacyEntry(legacyKey);
      if (!e) return null;
      return e.make();
    },

    /**
     * 用**新路径**创建一个节点。
     * @returns {Object|null}
     */
    buildNew(legacyKey) {
      const def = ICAR.registry.Control.byLegacyKey(legacyKey);
      if (!def) return null;
      return ICAR.registry.Control.build(def.key);
    },

    /**
     * 序列化后的字段级对比。
     *
     * ⚠️ **`id` 与 `name` 之外的差异都算不等价**：
     *  - `id` 每次随机，必然不同 → 跳过
     *  - `name` 理论上相同，但保留在比较里（不同就是 bug）
     *
     * @param {string} legacyKey
     * @returns {{ok:boolean, diffs:Array<{path:string, legacy:*, next:*}>, legacyJson:Object, nextJson:Object}}
     */
    compare(legacyKey) {
      const a = this.buildLegacy(legacyKey);
      const b = this.buildNew(legacyKey);
      if (!a) throw new Error("compare: 旧库没有 `" + legacyKey + "`");
      if (!b) throw new Error("compare: 新 Registry 没有 `" + legacyKey + "`");

      const toJson = window.nodeToJson;
      if (typeof toJson !== "function") throw new Error("compare: window.nodeToJson 不存在");

      const ja = toJson(a);
      const jb = toJson(b);
      const diffs = [];
      diffDeep(ja, jb, "", diffs);
      return { ok: diffs.length === 0, diffs: diffs, legacyJson: ja, nextJson: jb };
    },
  };

  /**
   * 递归比较两个 JSON 值，收集差异。
   * `id` 字段直接跳过（随机值，不参与等价判定）。
   */
  function diffDeep(a, b, path, out) {
    const pa = path ? path + "." : "";

    if (a === b) return;

    // 跳过随机 id（只跳过**顶层** id —— 子节点 id 同样随机）
    if (path === "id" || path.endsWith(".id")) return;

    const isObj = (v) => v !== null && typeof v === "object";
    if (isObj(a) && isObj(b)) {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      keys.forEach(function (k) {
        diffDeep(a[k], b[k], pa + k, out);
      });
      return;
    }

    // 数字容差：旧实现里已有 r2() 取两位，浮点等同即可
    if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9) return;

    out.push({ path: path, legacy: a, next: b });
  }

  window.ICAR.adapter.Legacy = ICAR.register("adapter", "Legacy", Adapter);
  if (window.LegacyAdapter === undefined) window.LegacyAdapter = Adapter;
})();
