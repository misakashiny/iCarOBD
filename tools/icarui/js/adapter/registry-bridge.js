/* ==========================================================================
   js/adapter/registry-bridge.js —— 旧入口 → Control Registry（P3A）
   ==========================================================================

   ## 它做什么

   **让旧的 `BUILTIN_CONTROLS[i].make()` 改调 Registry**，
   从而「一个定义驱动两套入口」：

   ```
   ControlRegistry.define({ key, build, ... })
           │
           ├──→ 旧入口  BUILTIN_CONTROLS.find(key).make()   ← 本文件接线到这里
           └──→ 新入口  ICAR.registry.Control.build(key)
   ```

   ## 三条硬约束

   1. **不改 `presets.js`** —— 旧文件的原始 `make()` 原地保留，本文件运行时替换引用
   2. **保留 fallback** —— 若 Registry 没有该 key 的定义，仍用原 `make()`
      （避免迁移不完整时功能丢失）
   3. **行为完全一致** —— 产出节点必须与替换前逐字段相同（Golden Fixture 守）

   ## 为什么在运行时替换而不是改源码

   改 `presets.js` 里 12 处的 `make` 会让「旧实现」和「新实现」同时存在两份源码，
   而 P3A 的要求是**旧入口不保留独立的创建逻辑**。
   运行时替换 = 旧数组里那份 `make` 变成"转调 Registry"，
   原实现在内存里被覆盖，源码层面不再有第二份可执行路径。

   ⚠️ 但原函数仍被保存为 `__legacyMake`（只读诊断用途），
   **不得**在比较测试里用它当新旧对照 —— 那会变成"自己跟自己比"。
   新旧对照一律用 `fixtures/p3a-text-golden.json`（替换前抓的独立基准）。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("registry-bridge.js 必须在 core/namespace.js 之后加载");
  const Reg = ICAR.registry.Control;
  if (!Reg) throw new Error("registry-bridge.js 必须在 control-registry.js 之后加载");

  /** 已接管的 key 列表（诊断用） */
  const bridged = [];
  /** Registry 缺定义、仍用原实现的 key */
  const fallback = [];

  /**
   * 把旧数组里指定 key 的 `make()` 换成 Registry 实现。
   *
   * @param {Array<string>} keys 要接管的 key
   * @returns {{bridged:string[], fallback:string[], missing:string[]}}
   */
  function bridge(keys) {
    const list = window.BUILTIN_CONTROLS || [];
    const missing = [];

    (keys || []).forEach(function (key) {
      const entry = list.find(function (c) { return c && c.key === key; });
      if (!entry) { missing.push(key); return; }

      const def = Reg.byLegacyKey(key);
      if (!def) { fallback.push(key); return; }

      // 幂等：已经接管过的不再包一层
      if (entry.__bridgedTo) return;

      // 保留原实现（只读诊断用；**不用它做新旧对照**）
      entry.__legacyMake = entry.make;

      /**
       * ⚠️⚠️ **panels.js 会给每个 make 包一层 prepareBuiltinImages**（P3C-2 才发现）。
       *
       * panels.js 加载时执行：
       *   control.make = () => window.prepareBuiltinImages(make(), false);
       *
       * 它把图片控件的 `w` 按画布宽高比缩放（56 × designH/designW = 35）。
       * P3A/P3B/P3C-1 迁的控件都不是 NODE_IMAGE，这层对它们无副作用，一直没暴露；
       * P3C-2 迁状态灯（NODE_IMAGE）时立刻炸出来：
       *
       *   旧入口 make()     → 35（包了一层）
       *   Registry.build()  → 56（未包）
       *
       * **修法**：bridge 把 Registry 节点**补上这层包装**。
       *
       * ⚠️ 但不能直接调全局 prepareBuiltinImages —— 因为 `entry.make`（赋值前的那个）
       *    本身已经是包装过的，再包一次会缩两次（实测 56→21.875）。
       *    所以这里的语义是：**替换掉整条链**，由 bridge 统一负责"Registry + 一次包装"。
       */
      entry.make = function () {
        const node = Reg.build(def.key);
        if (typeof window.prepareBuiltinImages === "function") {
          return window.prepareBuiltinImages(node, false);
        }
        return node;
      };
      entry.__bridgedTo = def.key;
      bridged.push(key);
    });

    return { bridged: bridged.slice(), fallback: fallback.slice(), missing: missing };
  }

  /** 诊断：当前接管状态 */
  function status() {
    return {
      bridged: bridged.slice(),
      fallback: fallback.slice(),
      total: (window.BUILTIN_CONTROLS || []).length,
    };
  }

  window.ICAR.adapter.RegistryBridge = ICAR.register("adapter", "RegistryBridge", {
    bridge: bridge,
    status: status,
  });
})();
