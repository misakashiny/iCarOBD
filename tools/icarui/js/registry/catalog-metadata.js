/* ==========================================================================
   js/registry/catalog-metadata.js —— 静态元数据注册表（P2B 第一部分）
   ==========================================================================

   ## 为什么需要它

   P2A 的 Catalog 靠**调用 `make()` 探测**得到分类。
   这有个根本缺陷：

   * `make()` 会改状态（素材类会 `design.assets.push`）—— 已用快照规避，但脆弱
   * 构建要等 `design` 就绪 → 只能轮询
   * 每次启动要跑 215 次工厂函数

   P2B 改为：**优先读静态元数据，探测只作为兜底**。

   ## 两级来源（优先级从高到低）

   1. **`DECLARED`（本文件）** —— 显式声明的元数据，零副作用、零探测
   2. **探测兜底** —— 没有声明的旧条目仍走 `make()` 探测
      （P2B 要求：不得直接删除探测机制导致目录缺项）

   迁移是**渐进**的：先把确定的条目声明进来，其余继续探测，
   `coverage()` 能随时报出"还有多少条在走探测"。

   ## 声明格式

   ```js
   CatalogMeta.declare("gauge_0", {
     name: "圆表",
     kind: "preset",              // control | preset | asset
     category: "预设·仪表外观",
     nodeType: "gauge",
     renderer: "gauge",
     dataCapability: "bound",
     vehicleAvailability: "unverified",   // 见 datasource 四层
   });
   ```

   ⚠️ **未声明的字段必须留空由探测补**，不能瞎猜。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("catalog-metadata.js 必须在 core/namespace.js 之后加载");

  /** key → 静态元数据 */
  const declared = new Map();

  /**
   * 数据能力（"这个控件读不读数据"）
   * ⚠️ 与「车辆可用性」是**两件事** —— P2B 明确要求区分。
   */
  const DATA_CAP = Object.freeze({
    NONE: "none",    // 不读数据
    BOUND: "bound",  // 绑定 pid
    STATE: "state",  // 绑定 statePid（三态）
  });

  /**
   * 车辆可用性（P2B 第四部分四层）
   *
   * ⚠️ **不要因为 "App 已实现 PID" 就标 `available`**。
   * `implemented` 只代表"App 有这条通道"，**不代表这辆车有数据**。
   */
  const VEHICLE = Object.freeze({
    /** L1 之外的保守档：App 实现了通道，但车辆未实测 */
    IMPLEMENTED: "implemented",
    /** L2：仅别名/模板，实现不完整 */
    ALIAS_ONLY: "alias-only",
    /** L3：车辆可用性待验证 */
    UNVERIFIED: "unverified",
    /** L4：App 未实现数据源 */
    UNIMPLEMENTED: "unimplemented",
    /** 不适用（不读数据） */
    NA: "n/a",
  });

  const CatalogMeta = {
    DATA_CAP: DATA_CAP,
    VEHICLE: VEHICLE,

    /**
     * 声明一条条目的静态元数据。
     * 只写你**确定**的字段；其余留给探测补。
     */
    declare(key, meta) {
      if (!key || typeof key !== "string") throw new Error("CatalogMeta.declare: key 必填");
      if (!meta || typeof meta !== "object") throw new Error("CatalogMeta.declare: meta 必填");
      declared.set(key, Object.freeze(Object.assign({}, meta)));
      return declared.get(key);
    },

    /** 批量声明 */
    declareAll(map) {
      Object.keys(map || {}).forEach((k) => this.declare(k, map[k]));
    },

    /** 取静态声明（无则 undefined） */
    get(key) {
      return declared.get(key);
    },

    has(key) {
      return declared.has(key);
    },

    count() {
      return declared.size;
    },

    keys() {
      return Array.from(declared.keys());
    },

    /** 测试用 */
    __reset() {
      declared.clear();
    },
  };

  window.ICAR.registry.CatalogMeta = ICAR.register("registry", "CatalogMeta", CatalogMeta);
  if (window.CatalogMetadata === undefined) window.CatalogMetadata = CatalogMeta;
})();
