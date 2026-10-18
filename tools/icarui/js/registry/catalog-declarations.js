/* ==========================================================================
   js/registry/catalog-declarations.js —— 显式元数据声明（P2B）
   ==========================================================================

   ## 本文件声明的第一批条目

   **`gauge_0` ~ `gauge_7`**（8 条）

   ### 为什么要修正语义归属（P2B 第二部分明确要求）

   P2A 把它们判成 `control`（功能控件），因为它们 `make()` 出来是 `gauge` 节点。
   但看它们**是什么**：

   | key | 对应 `window.STYLES[i]` | 尺寸 |
   |---|---|---|
   | gauge_0..7 | 8 种仪表**样式**各一个 | 120×120 或 200×100 |

   **它们绑定的是同一个 PID（`std_0C` 转速）、同一套量程，唯一区别是样式（style 0~7）。**

   按 P2A 自己定的原则「同一功能的不同外观优先归入预设」，
   这 8 条应当归为**预设（外观预设）**，而不是 8 个独立功能控件。

   ### 但硬约束：不能删

   * 8 个 key 必须继续可查、可拖、可创建
   * `BUILTIN_CONTROLS` 一个元素都不动
   * 本文件只声明**语义归属**，不改任何行为

   ### 数据能力 vs 车辆可用性（P2B 第二部分）

   * `dataCapability: "bound"` —— 它们确实绑定 `std_0C`
   * `vehicleAvailability: "unverified"` —— **但车辆是否有转速数据未验证**

   ⚠️ 这正是 P2B 强调的区分：**App 实现了通道 ≠ 真车可用**。
   `std_0C` 在 App 侧有实现（`BuiltInPids.kt`），但本轮没有任何真车证据。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("catalog-declarations.js 必须在 core/namespace.js 之后加载");

  const META = ICAR.registry.CatalogMeta;
  if (!META) throw new Error("catalog-declarations.js 必须在 catalog-metadata.js 之后加载");

  const V = META.VEHICLE;
  const D = META.DATA_CAP;

  // ---------------------------------------------------------------- gauge_0..7
  //
  // 8 种仪表样式的**外观预设**。结构统一：gauge 节点 + style 0..7。
  const STYLE_NAMES = [
    "圆表",      // 0 STYLE_CIRCLE
    "数字表",    // 1 STYLE_DIGITAL
    "条形表",    // 2 STYLE_BAR
    "折线表",    // 3 STYLE_LINE
    "上下双值",  // 4 STYLE_DUAL_STACK
    "四值表",    // 5 STYLE_QUAD
    "主副双值",  // 6 STYLE_SUB_DUAL
    "G力表",     // 7 STYLE_GFORCE
  ];

  for (let i = 0; i < 8; i++) {
    META.declare("gauge_" + i, {
      name: STYLE_NAMES[i] || ("样式 " + i),
      kind: "preset",                 // ← 修正：从 control 改为 preset
      category: "预设·仪表外观",
      nodeType: "gauge",
      renderer: "gauge",
      dataCapability: D.BOUND,
      /** 绑定的通道（静态声明 —— 让 Catalog 无需调 make() 就能算可用性） */
      pid: "std_0C",
      // ⚠️ App 有 std_0C 通道，但**车辆是否提供转速未验证**
      vehicleAvailability: V.UNVERIFIED,
      thumbnail: { mode: "draw", ref: null },
      /** 诊断信息：为什么归为预设 */
      note: "同一 PID(std_0C) 的 8 种样式之一，属外观预设而非独立功能控件",
    });
  }
})();
