/* ==========================================================================
   js/ui/assets-signature.js —— 素材库刷新签名（P4P-1A）
   ==========================================================================

   ## 为什么需要它

   P4P-0 审计实测：`renderAssets()` 中位数 **24.7ms**，占 `refreshAll` 约 94%。
   它每次 `commit` 都无条件重建：
   - 生成 **242,611 字符**的 HTML
   - `innerHTML` 写入解析 **5.4ms**

   而**改一个节点的字号/颜色/locked** 时，素材库显示内容**根本没变**。

   ## 为什么不能只比 `design.assets` 的引用或长度

   审计确认素材数组是**原地 push** 的（6 处）：

     editor.js:466        S.design.assets.push(...prepared.assets)
     next-controls.js:11  d.assets.push({...})
     panels.js:1711       d.assets.push({...})
     panels.js:1730       S.design.assets.push({...})
     panels.js:1839       S.design.assets.push(asset)
     panels.js:2012       S.design.assets.push(asset)

   **数组引用永远不变、长度可能不变**（删一个加一个）。所以必须比**内容**。

   ## 签名怎么算

   把 `renderAssets()` 实际读取的**全部显示相关数据**序列化成一个字符串：

   | # | 依赖 | 来源 |
   |---|---|---|
   | 1 | 用户素材（id/name/kind/path/data 长度/w/h）| `design.assets` |
   | 2 | 内置素材（path/label/name/kind）| `BUILTIN_ASSETS`（416 条）|
   | 3 | 内置控件（key/name/next）| `BUILTIN_CONTROLS`（215 条）|
   | 4 | 自定义控件（id/name）| `design.controls` |
   | 5 | 分类列表（v/n）| `assetKindList()` |
   | 6 | 搜索词 | `assetQuery` |
   | 7 | ~~面板折叠态~~ | **不进签名**（由 `renderAssets(true)` 强制重建，见 D-14）|
   | 8 | **素材「已用」状态** | `design.assets` 的 path 集合 ∩ 节点引用 |

   ⚠️ 第 8 项容易被漏：`renderAssets` 用 `havePath[a.path]` 决定是否画"已用"角标，
   而 `havePath` 来自 `design.assets` 的 path —— **不是节点引用**。

   > 本签名**不包含**画布节点。因为 `renderAssets` 的 `havePath` 只看
   > `design.assets` 的 path（用户把素材加入设计即算"已用"），
   > 与节点是否引用它无关。**改节点属性不会改变素材库显示** —— 这正是优化的前提。

   ## 保守原则

   任务要求「对未完全确认的依赖，优先使用保守兜底刷新」。
   所以签名**只覆盖确认过的字段**，且任何计算异常都**返回"脏"**（强制刷新）：

   ```js
   try { ... } catch (e) { return "ERR:" + e.message; }   // 异常 → 必然不等 → 刷新
   ```
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("assets-signature.js 必须在 core/namespace.js 之后加载");

  /**
   * 计算当前素材库的显示签名。
   *
   * @returns {string} 任意字符串；**只要不相同就必须刷新**
   */
  function computeAssetsSignature() {
    try {
      const S = window.CanvasState;
      const d = S && S.design;
      if (!d) return "no-design";

      const parts = [];

      // ① 用户素材 —— 逐字段（含 data 长度：缩略图 src 就是它）
      const mine = d.assets || [];
      parts.push("A" + mine.length);
      for (let i = 0; i < mine.length; i++) {
        const a = mine[i] || {};
        parts.push([
          a.id || "",
          a.name || "",
          a.kind || "",
          a.path || "",
          // data 可能是很长的 base64 —— 只取长度 + 首尾各 16 字符，足够区分
          a.data ? (a.data.length + ":" + a.data.slice(0, 16) + a.data.slice(-16)) : "",
          a.w || 0,
          a.h || 0,
        ].join("\u0001"));
      }

      // ② 内置素材（416 条）
      const builtin = window.BUILTIN_ASSETS || [];
      parts.push("B" + builtin.length);
      for (let i = 0; i < builtin.length; i++) {
        const b = builtin[i] || {};
        parts.push([b.path || "", b.label || "", b.name || "", b.kind || ""].join("\u0001"));
      }

      // ③ 内置控件（215 条：renderAssets 要按 name 搜索、按 next 分两组）
      const ctrls = window.BUILTIN_CONTROLS || [];
      parts.push("C" + ctrls.length);
      for (let i = 0; i < ctrls.length; i++) {
        const c = ctrls[i] || {};
        parts.push([c.key || "", c.name || "", c.next ? "1" : "0"].join("\u0001"));
      }

      // ④ 自定义控件
      const saved = d.controls || [];
      parts.push("D" + saved.length);
      for (let i = 0; i < saved.length; i++) {
        const c = saved[i] || {};
        parts.push([c.id || "", c.name || ""].join("\u0001"));
      }

      // ⑤ 分类列表
      const kinds = typeof window.assetKindList === "function" ? window.assetKindList() : [];
      parts.push("K" + kinds.length);
      for (let i = 0; i < kinds.length; i++) {
        const k = kinds[i] || {};
        parts.push([k.v || "", k.n || ""].join("\u0001"));
      }

      // ⑥ 搜索词
      parts.push("Q" + String(typeof assetQuery !== "undefined" ? assetQuery : ""));

      // ⑦ 面板折叠态 —— **不放进签名**
      //
      // P4P-1A 实测教训：
      //   · `panelCollapsed` 是 panels.js 闭包里的 const，本模块访问不到
      //   · 改成读 DOM 折叠标记也不行 —— `togglePanelCollapse` 先改状态再调
      //     `renderAssets()`，此时 DOM 还没更新，签名对比会说"没变化"
      //
      // 结论：**折叠不是"显示内容"的变化，而是"用户显式操作"**，
      // 由 `renderAssets(true)` 强制重建即可（见 panels.js 的
      // togglePanelCollapse / assetsExpandAll）。
      // 所以这里不记录折叠态 —— 避免一个脆弱的 DOM 探测混进签名。
      //
      // （折叠状态的持久化由 panels.js 自己的 savePanelState 负责，与本模块无关）

      // ⑧ 「已用」角标：havePath 只由 design.assets 的 path 决定（见文件头注释）
      const paths = new Set();
      for (let i = 0; i < mine.length; i++) {
        if (mine[i] && mine[i].path) paths.add(mine[i].path);
      }
      parts.push("U" + paths.size);

      return parts.join("\u0002");
    } catch (e) {
      // ⚠️ 保守兜底：算不出来就返回唯一值 → 必然触发刷新，绝不漏刷
      return "SIG-ERROR:" + Date.now() + ":" + ((e && e.message) || e);
    }
  }

  /** 上次成功渲染时的签名 */
  let lastSignature = null;

  /**
   * 判断是否需要重建素材库。
   *
   * @param {boolean} force 强制刷新（用户显式操作素材时用）
   * @returns {{need:boolean, reason:string}}
   */
  /** 对外 API 对象（needRebuild 里通过它调 compute，便于测试注入） */
  const API = { compute: computeAssetsSignature };

  function needRebuild(force) {
    if (force) return { need: true, reason: "forced" };
    // ⚠️ 通过 `API.compute` 调用（不是直接调闭包函数）——
    //    这样测试可以注入"计算抛异常"来验证兜底路径。
    //
    // ⚠️ **这里必须自己 try/catch**：compute 内部虽然有兜底，
    //    但 compute 被替换/抛异常时（测试注入、或将来改了实现），
    //    异常会直接冒到 renderAssets，中断整个面板渲染。
    //    失败 → 视为"必须重建"（保守，绝不漏刷）。
    let sig;
    try {
      sig = API.compute();
    } catch (e) {
      return { need: true, reason: "signature-error" };
    }
    if (lastSignature === null) return { need: true, reason: "first-render" };
    if (sig !== lastSignature) return { need: true, reason: "signature-changed" };
    return { need: false, reason: "unchanged" };
  }

  /** 记录"已渲染到这个签名"（`renderAssets` 真正重建完后调用） */
  function markRendered() {
    // ⚠️ 这里也要兜底：`compute` 被替换/抛异常时，markRendered 不能把异常
    //    漏给 renderAssets（那会让整个面板渲染中断）。
    //    失败时把 lastSignature 置 null → 下次必然重建（保守）。
    try {
      lastSignature = API.compute();
    } catch (e) {
      lastSignature = null;
    }
    return lastSignature;
  }

  /** 清空记录（切换设计 / 强制重绘时用） */
  function invalidate() {
    lastSignature = null;
  }


  API.needRebuild = needRebuild;
  API.markRendered = markRendered;
  API.invalidate = invalidate;
  API.__last = function () { return lastSignature; };

  ICAR.ui = ICAR.ui || {};
  ICAR.ui.AssetsSignature = API;
})();
