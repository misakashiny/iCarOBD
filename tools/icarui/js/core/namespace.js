/* ==========================================================================
   js/core/namespace.js —— window.ICAR 命名空间（P1A）
   ==========================================================================

   ## 为什么需要这个文件

   现状：**204 个全局符号平铺在 `window` 上**，跨文件引用 370 对。
   后果是「谁依赖谁」无法静态推理（P0.5 实测：所有文件都没有 IIFE 外壳，
   全部读取都发生在函数体内 → 顶层零依赖，但运行时形成 10 文件强连通分量）。

   `window.ICAR` 的作用不是"消灭全局"，而是**给全局一个有形状的家**：
   之后新写的模块挂到 `ICAR.<domain>.<name>`，旧符号**原样保留**在 `window.*`。

   ## 硬约束（P1A 任务要求）

   1. **不删任何现有全局符号** —— 旧代码继续用 `window.xxx` 照常工作。
   2. **零依赖、零构建** —— 普通 `<script>`，不引入模块系统。
   3. **可被 `vm` 加载** —— `verify-crosslang.js` 在 Node 里按顺序 `runInContext`
      加载工具模块，本文件必须不依赖 DOM 才能在那边也跑得起来。

   ## 加载顺序

   必须排在 `schema.js` **之前**（其它新模块要用 `ICAR.register` 挂载）。
   ========================================================================== */
"use strict";

(function () {
  // 允许重复加载（测试里可能 runInContext 多次）—— 幂等
  if (window.ICAR && window.ICAR.__namespace) return;

  /**
   * `window.ICAR` —— 新架构的唯一根命名空间。
   *
   * 子空间按职责划分，与 P0 审计报告的六大 Registry 对应：
   *   `ICAR.core`       基础能力（当前仅版本与兼容桥）
   *   `ICAR.registry`   控件/数据源/素材/预设的注册表
   *   `ICAR.render`     渲染适配层
   *   `ICAR.adapter`    与旧数据模型的兼容适配
   */
  const ICAR = {
    /** 标记位：用于幂等加载检测 */
    __namespace: true,

    /** 架构阶段标记。P1A = 基础设施试点，不是完整迁移 */
    phase: "P1A",

    core: {},
    registry: {},
    render: {},
    adapter: {},

    /**
     * 把一个能力挂到指定域下，**同时**保留旧全局入口。
     *
     * @param {string} domain   `core` / `registry` / `render` / `adapter`
     * @param {string} name     能力名
     * @param {*}      value    能力本体
     * @param {string} [legacy] 旧 `window.<legacy>` 名称；给了就同时挂上去
     *                          （**只在旧名尚不存在时**挂，绝不覆盖既有实现）
     * @returns {*} value
     *
     * ## 为什么"只在旧名不存在时挂"
     *
     * 兼容优先级是「**旧实现赢**」。如果本函数覆盖了 `window.renderPanels`，
     * 而旧 `panels.js` 后加载又把真的实现覆盖回去 —— 结果取决于加载顺序，
     * 这种不确定性正是要消除的。所以：**旧名已存在就一个字节都不动**。
     */
    register(domain, name, value, legacy) {
      if (!domain || !name) throw new Error("ICAR.register: domain 与 name 必填");
      if (!ICAR[domain]) ICAR[domain] = {};
      ICAR[domain][name] = value;
      if (legacy && window[legacy] === undefined) {
        window[legacy] = value;
      }
      return value;
    },

    /**
     * 读取一个能力：**先看新命名空间，再回落到旧全局**。
     *
     * 迁移期的代码应该一律走这个函数 ——
     * 这样"某个能力迁到 ICAR 了"对调用方是透明的，不需要改调用点。
     */
    get(domain, name) {
      const d = ICAR[domain];
      if (d && d[name] !== undefined) return d[name];
      // 回落：旧全局（按惯例新名与旧名同形时可用）
      return window[name];
    },
  };

  window.ICAR = ICAR;
})();
