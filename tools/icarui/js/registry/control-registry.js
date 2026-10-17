/* ==========================================================================
   js/registry/control-registry.js —— 控件定义的唯一事实源（P1A）
   ==========================================================================

   ## 它解决什么

   P0 审计的结论：一个控件的信息散在 5 处 ——
     `presets.js` 的 `make()`、`panels.js` 的属性行、`schema.js` 的字段表、
     `model.js:802` 的 `nodeToJson` 白名单、App 侧 `DesignNode.kt`。

   本 Registry 把「这个控件是什么」收成**一条定义**，
   属性面板、数据绑定、渲染分派、序列化校验都从这一条推导。

   ## 三条硬约束（P1A 任务要求）

   1. **不允许依赖整个编辑器或属性面板** —— 本文件只读 `window.ICAR.core` 与
      `window.createNode`（工厂），不引用 `panels.js` / `app.js` / `canvas.js`。
      用 `P1A` 的依赖图验证：本文件不应出现在任何 SCC 里。
   2. **不是新格式** —— `build()` 产出的节点仍走旧的 `nodeToJson`，
      本 Registry 只描述，不改写。
   3. **旧 key 映射** —— `legacyKey` 字段记录它对应的旧 `BUILTIN_CONTROLS` key。

   ## 与「控件预设」的区别

     * 控件类型定义（`Control`）：`g_speed`、`t_label` —— 描述"能拖出来什么"
     * 实例数据（`Node`）：用户拖到画布上的那一个对象（含 x/y/w/h）
     * 外观预设（`Preset`）：`PRESETS` 的 `"1big4small"` —— 一次摆一组

   三者字段不同，本文件只负责第一类；后两类分别留在旧位置（P1A 不迁移）。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("control-registry.js 必须在 core/namespace.js 之后加载");

  /**
   * 已注册控件的 key → 定义
   * @type {Map<string, ControlDef>}
   */
  const defs = new Map();

  /**
   * @typedef {Object} ControlDef
   * @property {string}   key          新架构唯一 key
   * @property {string}   [legacyKey]  对应的旧 BUILTIN_CONTROLS key（兼容映射）
   * @property {string}   name         显示名
   * @property {string}   category     分类（驱动库分组）
   * @property {string}   icon         图标字符
   * @property {Object}   [defaults]   默认节点字段
   * @property {Function} build        (props) => Node   创建节点
   * @property {Array}    [schema]     属性 Schema（驱动属性面板，P1A 只登记不使用）
   * @property {Array}    [slots]      数据槽声明
   * @property {Object}   [render]     渲染能力声明 {mode:"gauge"|"text"|"image"|"track"|"container"}
   * @property {Function} [validate]   (node) => Issue[]  运行前校验
   * @property {number}   [priority]   排序权重
   */

  function assertDef(def) {
    const need = ["key", "name", "category", "build"];
    for (const k of need) {
      if (def[k] === undefined || def[k] === null || def[k] === "") {
        throw new Error("ControlRegistry.define: 缺少必填字段 `" + k + "`（key=" + def.key + "）");
      }
    }
    if (typeof def.build !== "function") {
      throw new Error("ControlRegistry.define: `build` 必须是函数（key=" + def.key + "）");
    }
    if (def.schema && !Array.isArray(def.schema)) {
      throw new Error("ControlRegistry.define: `schema` 必须是数组（key=" + def.key + "）");
    }
    if (def.slots && !Array.isArray(def.slots)) {
      throw new Error("ControlRegistry.define: `slots` 必须是数组（key=" + def.key + "）");
    }
  }

  const Registry = {
    /**
     * 注册一个控件定义。
     *
     * 重复 key 会**抛错**而不是静默覆盖 ——
     * P0 审计发现库里已有「同名不同义」的隐患（`box_h1` 产出 text 节点），
     * 静默覆盖会让这类问题永远查不出来。
     */
    define(def) {
      if (!def || typeof def !== "object") throw new Error("ControlRegistry.define: 参数必须是对象");
      assertDef(def);
      if (defs.has(def.key)) {
        throw new Error("ControlRegistry.define: 重复 key `" + def.key + "`");
      }
      const frozen = Object.freeze(Object.assign({ priority: 100 }, def));
      defs.set(def.key, frozen);
      return frozen;
    },

    /** 取一条定义（不存在返回 undefined） */
    get(key) {
      return defs.get(key);
    },

    /** 是否已注册 */
    has(key) {
      return defs.has(key);
    },

    /** 全部 key（按 priority 升序、同优先级按注册顺序） */
    keys() {
      return Array.from(defs.values())
        .sort((a, b) => (a.priority - b.priority))
        .map((d) => d.key);
    },

    /** 全部定义 */
    all() {
      return this.keys().map((k) => defs.get(k));
    },

    /**
     * 按旧 key 反查新定义 —— **兼容适配层的入口**。
     *
     * @param {string} legacyKey 例如 `"t_label"`
     * @returns {ControlDef|undefined}
     */
    byLegacyKey(legacyKey) {
      for (const d of defs.values()) {
        if (d.legacyKey === legacyKey) return d;
      }
      return undefined;
    },

    /** 按分类分组（驱动库分组，P1A 只提供数据，不改 UI） */
    byCategory() {
      const out = new Map();
      for (const d of this.all()) {
        if (!out.has(d.category)) out.set(d.category, []);
        out.get(d.category).push(d);
      }
      return out;
    },

    /**
     * 用某个控件定义创建一个节点。
     *
     * ⚠️ **不写总线、不触发重绘** —— 只产出一个节点对象。
     * 拖拽接线仍由旧代码负责（`app.js` / `panels.js`），
     * 这样新旧两条路径产出的对象可以直接 `deepEqual` 比对。
     *
     * @param {string} key
     * @param {Object} [props] 覆盖默认值
     * @returns {Object} 节点
     */
    build(key, props) {
      const def = defs.get(key);
      if (!def) throw new Error("ControlRegistry.build: 未注册的控件 `" + key + "`");
      const merged = Object.assign({}, def.defaults || {}, props || {});
      const node = def.build(merged);
      if (!node || typeof node !== "object") {
        throw new Error("ControlRegistry.build: `" + key + "` 的 build() 没有返回节点");
      }
      return node;
    },

    /**
     * 运行前校验：给定一个节点，返回问题列表。
     *
     * 汇总两处：
     *   1. 控件自己的 `validate(node)`
     *   2. **数据槽检查** —— `slots` 里 `required:true` 的槽必须有可解析的数据源
     *
     * 这两条正是 P0 审计里「13 个灯能拖能绑、设备上却无数据」的检查点。
     *
     * @returns {Array<{level:"error"|"warn", code:string, message:string}>}
     */
    validate(node) {
      const issues = [];
      if (!node) return issues;

      const def = this.byLegacyKey(node.__controlKey) || this.get(node.__controlKey);
      if (def && typeof def.validate === "function") {
        const r = def.validate(node);
        if (Array.isArray(r)) issues.push.apply(issues, r);
      }

      if (def && Array.isArray(def.slots)) {
        const resolver = window.ICAR.core.resolveDataSource;
        for (const slot of def.slots) {
          if (!slot.required) continue;
          const raw = slot.read ? slot.read(node) : null;
          const ok = typeof resolver === "function" ? resolver(raw) : { usable: true };
          if (!ok || !ok.usable) {
            issues.push({
              level: "error",
              code: "slot-unavailable",
              message: "控件「" + def.name + "」需要的数据源「" + (raw || "(未绑定)") + "」在设备上不可用" +
                (ok && ok.reason ? "（" + ok.reason + "）" : ""),
            });
          }
        }
      }
      return issues;
    },

    /** 测试/热重载用：清空（**不在产品代码里调用**） */
    __reset() {
      defs.clear();
    },

    /** 只读快照，便于测试断言 */
    __snapshot() {
      return this.all().map((d) => ({ key: d.key, legacyKey: d.legacyKey, name: d.name, category: d.category }));
    },
  };

  window.ICAR.registry.Control = ICAR.register("registry", "Control", Registry);
  // 兼容入口：给新代码一个短名字，旧代码不受影响
  if (window.ControlRegistry === undefined) window.ControlRegistry = Registry;
})();
