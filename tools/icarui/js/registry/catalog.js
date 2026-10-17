/* ==========================================================================
   js/registry/catalog.js —— 统一控件目录（P2A）
   ==========================================================================

   ## 它解决什么

   215 个库条目混在一个数组里：76 个纯图片、28 个图片轨道、19 个灯、
   26 个仪表、15 个组合预设……**用户和代码都分不清"什么是功能，什么是外观"**。

   本 Catalog 为**每一条**建立统一元数据，并给出分类，
   供未来的库分组、搜索、迁移、可用性提示统一读取。

   ## 分类判据（P2A 硬要求：不得仅凭 key 前缀）

   判据**只看 `make()` 实际产出的节点结构** + 用途语义：

   | 判据 | 结论 |
   |---|---|
   | `gauge + parts.length>0` | 控件预设（拼装仪表） |
   | `group + children.length>0` | 控件预设（组合控件） |
   | `gauge`（无 parts） | **功能控件**（仪表） |
   | `text` | **功能控件**（文字） |
   | `group`（无 children） | **功能控件**（容器） |
   | `image + states` | **功能控件**（状态指示） |
   | `image + trackStyle` | **功能控件**（代码轨道） |
   | `image + assetId` | **素材资源**（静态图片） |

   ⚠️ **反例**：`box_h1`/`box_h2`/`box_note` 的 key 前缀是 `box_`（像容器），
   但 `make()` 产出的是 `text` 节点 → 按判据必须归为**功能控件（文字）**，
   不能因为前缀叫 box 就当成容器。这正是"不得凭前缀"的具体体现。

   ## 单一事实源

   本 Catalog 是**只读视图**：它**不接管** `BUILTIN_CONTROLS`，
   也不改任何旧条目。旧路径完全不受影响。
   P2A 只验证"用 Catalog 能唯一描述全部条目"这一机制。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("catalog.js 必须在 core/namespace.js 之后加载");

  /** 条目大类 */
  const KIND = Object.freeze({
    CONTROL: "control",  // 功能控件
    PRESET: "preset",    // 控件预设（样式/组合）
    ASSET: "asset",      // 素材资源
  });

  /** 渲染方式（与 canvas.js 的实际绘制入口对应） */
  const RENDERER = Object.freeze({
    GAUGE: "gauge",        // drawGaugeParts / GaugeViewFactory
    TEXT: "text",          // drawTextNode
    IMAGE: "image",        // drawImageNode
    TRACK: "track",        // drawTrackNode（trackStyle 分支）
    STATE_IMAGE: "state",  // 带 states 的图片（状态灯）
    GROUP: "group",        // 容器，不绘制自身
    COMPOSITE: "composite",// 组合（子节点各自渲染）
  });

  /** 数据能力 */
  const DATA = Object.freeze({
    NONE: "none",          // 不读数据
    BOUND: "bound",        // 绑定 pid（仪表）
    STATE: "state",        // 绑定 statePid（状态灯三态）
  });

  /**
   * **核心分类函数：只看节点结构，不看 key。**
   *
   * @param {Object} node  `make()` 产出的节点
   * @returns {{kind:string, renderer:string, dataCapability:string, reason:string}}
   */
  function classify(node) {
    if (!node || !node.type) {
      return { kind: KIND.CONTROL, renderer: RENDERER.IMAGE, dataCapability: DATA.NONE, reason: "无法创建（降级为控件）" };
    }

    const t = node.type;
    const parts = (node.parts && node.parts.length) || 0;
    const children = (node.children && node.children.length) || 0;

    // ---- 预设：有子结构 = 由基础控件拼出来的"组合" ----
    if (t === "gauge" && parts > 0) {
      return { kind: KIND.PRESET, renderer: RENDERER.GAUGE, dataCapability: node.pid ? DATA.BOUND : DATA.NONE,
               reason: "gauge + " + parts + " 个 parts（拼装仪表）" };
    }
    if (t === "group" && children > 0) {
      return { kind: KIND.PRESET, renderer: RENDERER.COMPOSITE, dataCapability: DATA.NONE,
               reason: "group + " + children + " 个子节点（组合控件）" };
    }

    // ---- 功能控件 ----
    if (t === "gauge") {
      return { kind: KIND.CONTROL, renderer: RENDERER.GAUGE, dataCapability: node.pid ? DATA.BOUND : DATA.NONE,
               reason: "gauge 无 parts" };
    }
    if (t === "text") {
      return { kind: KIND.CONTROL, renderer: RENDERER.TEXT, dataCapability: DATA.NONE, reason: "text 节点" };
    }
    if (t === "group") {
      return { kind: KIND.CONTROL, renderer: RENDERER.GROUP, dataCapability: DATA.NONE, reason: "空容器 group" };
    }
    if (t === "image") {
      if (node.states) {
        return { kind: KIND.CONTROL, renderer: RENDERER.STATE_IMAGE,
                 dataCapability: node.statePid ? DATA.STATE : DATA.NONE,
                 reason: "image + states 三态" };
      }
      if (node.trackStyle) {
        return { kind: KIND.CONTROL, renderer: RENDERER.TRACK, dataCapability: DATA.NONE,
                 reason: "image + trackStyle（代码绘制轨道）" };
      }
      if (node.assetId) {
        return { kind: KIND.ASSET, renderer: RENDERER.IMAGE, dataCapability: DATA.NONE,
                 reason: "image + assetId（静态素材）" };
      }
      return { kind: KIND.CONTROL, renderer: RENDERER.IMAGE, dataCapability: DATA.NONE, reason: "image（未绑定素材）" };
    }

    return { kind: KIND.CONTROL, renderer: RENDERER.IMAGE, dataCapability: DATA.NONE, reason: "未识别类型：" + t };
  }

  /** 由 assetId 反查素材路径（读取 design.assets 与内置素材表，**只读**） */
  function assetPathOf(assetId) {
    if (!assetId) return "";
    const S = window.CanvasState;
    if (S && S.design && Array.isArray(S.design.assets)) {
      const hit = S.design.assets.find(function (a) { return a && a.id === assetId; });
      if (hit && hit.path) return String(hit.path);
    }
    const list = window.BUILTIN_ASSETS || [];
    const hit2 = list.find(function (a) { return a && a.id === assetId; });
    return hit2 && hit2.path ? String(hit2.path) : "";
  }

  /**
   * 功能分类（用于库分组）。**按渲染器 + 用途**，不按 key。
   */
  function categoryOf(node, cls) {
    if (cls.renderer === RENDERER.STATE_IMAGE) return "状态指示";
    if (cls.renderer === RENDERER.TRACK) return "轨道";
    if (cls.renderer === RENDERER.GAUGE) return "仪表";
    if (cls.renderer === RENDERER.TEXT) return "文字";
    if (cls.renderer === RENDERER.GROUP || cls.renderer === RENDERER.COMPOSITE) return "容器与组合";
    if (cls.kind === KIND.ASSET) {
      // ⚠️ assetId 是内部 id（如 "as2fmnf"），**不含路径**。
      // 必须从 design.assets 反查真实 path 才能知道它属于哪一类素材。
      // 这是"不凭 key 前缀分类"的具体落实：分类依据是资源的**实际路径**。
      const p = assetPathOf(node.assetId);
      const m = p.match(/assets\/([a-z0-9-]+)\//i);
      const seg = m ? m[1] : "other";
      const map = {
        dashboard: "素材·盘面", background: "素材·背景", decor: "素材·装饰",
        scale: "素材·刻度", needle: "素材·指针", digits: "素材·数字",
        units: "素材·单位", icons: "素材·图标", warning: "素材·警示",
        bar: "素材·轨道图", next: "素材·新库底板",
      };
      return map[seg] || "素材·其他";
    }
    return "其他";
  }

  /** 自动生成搜索标签（名称分词 + 结构 + 数据） */
  function tagsOf(entry, node, cls) {
    const out = new Set();
    out.add(entry.kind);
    out.add(cls.renderer);
    if (entry.dataCapability !== DATA.NONE) out.add("有数据");
    if (node && node.pid) out.add("pid:" + node.pid);
    if (node && node.statePid) out.add("statePid:" + node.statePid);
    if (node && node.style !== undefined && node.style !== null && node.type === "gauge") out.add("style:" + node.style);
    if (entry.next) out.add("新库");
    // 名称按非中文/非字母切词
    String(entry.name || "").split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).forEach(w => { if (w) out.add(w); });
    return Array.from(out);
  }

  /**
   * 缩略图方案：
   *   素材 → 直接用它的 assetId（即 PNG 路径）
   *   其它 → 用 canvas 现场绘制（`drawNodePreview`），标记生成方式
   */
  function thumbnailOf(node, cls) {
    if (cls.kind === KIND.ASSET && node.assetId) {
      return { mode: "asset", ref: node.assetId };
    }
    return { mode: "draw", ref: null };
  }

  /** 构建完成的目录（key → 元数据） */
  let catalog = new Map();
  /** 构建时的统计 */
  let stats = null;

  /**
   * 扫描并建立目录。
   *
   * @param {Array} list 条目数组（默认 `window.BUILTIN_CONTROLS`）
   * @returns {{total:number, byKind:Object, byCategory:Object, byRenderer:Object, failures:Array}}
   */
  /**
   * **无副作用探测**：在临时快照里调用 make()，结束后恢复状态。
   *
   * ## 为什么必须这样（P2A 实测到的风险）
   *
   * 部分条目的 `make()` 会**写设计状态** —— 素材类条目走
   * `window.ensureBuiltinAsset(path)`（`panels.js:1703`），
   * 而它的实现是 `d.assets.push({...})`（`:1711`）。
   * 直接调 `make()` 建目录的后果：
   *
   *   · `S.design` 为空时 → `ensureBuiltinAsset` 返回 `""` → `assetId` 为空
   *     → 104 个素材条目被误判成"功能控件"（实测就是这个现象）
   *   · `S.design` 存在时 → 往 `design.assets` 里塞进 76+ 条用户从未拖过的素材
   *
   * 所以：**先快照 assets 数组，探测完原样恢复**。
   * 目录是只读视图，不允许有可见副作用。
   */
  /**
   * 探测单个条目：只捕异常，**不在这里恢复状态**。
   *
   * 为什么恢复要挪到 build() 外层：
   *   素材条目的 `make()` 会调 `ensureBuiltinAsset` 往 `design.assets` 里登记，
   *   而分类需要**反查这份登记**（assetId → path）才能知道素材用途。
   *   若每条探测完就恢复，下一条就查不到上一条登记的路径 —— 实测正是因此
   *   104 个素材全部落进「素材·其他」。
   */
  function probe(makeFn) {
    try {
      return { node: makeFn(), error: null };
    } catch (e) {
      return { node: null, error: e && e.message ? e.message : String(e) };
    }
  }

  function build(list) {
    const src = list || window.BUILTIN_CONTROLS || [];
    catalog = new Map();
    const failures = [];

    // ---- 整轮快照（见 probe() 注释：恢复必须覆盖整轮）----
    const S0 = window.CanvasState;
    const hadAssets = !!(S0 && S0.design && Array.isArray(S0.design.assets));
    const assetsSnapshot = hadAssets ? S0.design.assets.slice() : null;
    const createdTemp = !!(S0 && S0.design && !Array.isArray(S0.design.assets));
    if (S0 && S0.design && !Array.isArray(S0.design.assets)) S0.design.assets = [];

    src.forEach(function (c, idx) {
      const probeResult = probe(function () { return c.make(); });
      const node = probeResult.node;
      const err = probeResult.error;
      if (err) failures.push({ key: c.key, error: err });

      const cls = classify(node);
      const kind = c.next ? KIND.PRESET : cls.kind;   // next_* 是组合预设（结构已证明 group+children）

      const entry = {
        key: c.key,
        name: c.name || "",
        kind: kind,
        category: categoryOf(node, cls),
        nodeType: node ? node.type : "error",
        renderer: cls.renderer,
        legacyKey: c.key,                    // 目前与 key 相同；迁移期用于映射
        dataCapability: c.next ? DATA.BOUND : cls.dataCapability,
        availability: "unknown",             // 由 availabilityOf() 按数据源判定填充
        tags: [],
        thumbnail: thumbnailOf(node, cls),
        // 附加诊断信息（不参与分类判定，便于审计）
        __meta: {
          index: idx,
          reason: cls.reason,
          next: !!c.next,
          semanticId: c.semanticId || "",
          variant: c.variant || "",
          parts: (node && node.parts && node.parts.length) || 0,
          children: (node && node.children && node.children.length) || 0,
          pid: (node && node.pid) || "",
          statePid: (node && node.statePid) || "",
          style: node && node.style !== undefined ? node.style : null,
          assetId: (node && node.assetId) || "",
          makeError: err,
        },
      };
      entry.tags = tagsOf(entry, node, cls);
      entry.availability = availabilityOf(entry, node);
      catalog.set(c.key, entry);
    });

    // ---- 恢复：目录是只读视图，不允许留下任何可见副作用 ----
    if (S0 && S0.design) {
      if (assetsSnapshot !== null) S0.design.assets = assetsSnapshot;
      else if (createdTemp) delete S0.design.assets;
    }

    stats = computeStats();
    stats.failures = failures;
    return stats;
  }

  /**
   * 可用性判定（P2A 要求：不能把"别名可解析"当"设备可用"）。
   * 复用 P1A 的 DataSource Registry 四层语义。
   */
  function availabilityOf(entry, node) {
    const DS = ICAR.registry.DataSource;
    if (!node) return "L4";                       // 建不出来 = 完全不可用
    if (entry.dataCapability === DATA.STATE) {
      return DS ? DS.resolve(node.statePid).tier : "L4";
    }
    if (entry.dataCapability === DATA.BOUND && node.pid) {
      // 组合预设的数据在其子节点里，这里按 pid 判
      return DS ? DS.resolve(node.pid).tier : "L4";
    }
    // 不读数据的条目（素材/文字/容器）：可用性 = 素材是否存在，此处标 n/a
    return "n/a";
  }

  function computeStats() {
    const byKind = {}, byCategory = {}, byRenderer = {}, byAvailability = {};
    catalog.forEach(function (e) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      byRenderer[e.renderer] = (byRenderer[e.renderer] || 0) + 1;
      byAvailability[e.availability] = (byAvailability[e.availability] || 0) + 1;
    });
    return {
      total: catalog.size,
      byKind: byKind, byCategory: byCategory, byRenderer: byRenderer, byAvailability: byAvailability,
      failures: [],
    };
  }

  const Catalog = {
    KIND: KIND,
    RENDERER: RENDERER,
    DATA: DATA,

    /** 扫描并重建目录 */
    build: build,

    /** 全量统计 */
    stats() {
      return stats || (stats = computeStats());
    },

    /** 取一条元数据 */
    get(key) {
      return catalog.get(key);
    },

    /** 是否存在 */
    has(key) {
      return catalog.has(key);
    },

    /** 全部 key（按原顺序） */
    keys() {
      return Array.from(catalog.keys());
    },

    /** 全部元数据 */
    all() {
      return Array.from(catalog.values());
    },

    /** 按 kind 查询（control / preset / asset） */
    byKind(kind) {
      return this.all().filter(function (e) { return e.kind === kind; });
    },

    /** 按分类查询 */
    byCategory(cat) {
      return this.all().filter(function (e) { return e.category === cat; });
    },

    /** 按可用性层级查询（L1/L2/L3/L4/n/a） */
    byAvailability(tier) {
      return this.all().filter(function (e) { return e.availability === tier; });
    },

    /** 分类清单（用于库分组 UI） */
    categories() {
      const m = new Map();
      this.all().forEach(function (e) {
        if (!m.has(e.category)) m.set(e.category, []);
        m.get(e.category).push(e.key);
      });
      return Array.from(m.entries()).map(function (p) { return { category: p[0], keys: p[1], count: p[1].length }; });
    },

    /**
     * 搜索：名称 / key / 标签任意命中。
     * @param {string} q
     */
    search(q) {
      const s = String(q || "").trim().toLowerCase();
      if (!s) return [];
      return this.all().filter(function (e) {
        if (e.key.toLowerCase().indexOf(s) >= 0) return true;
        if (String(e.name).toLowerCase().indexOf(s) >= 0) return true;
        return e.tags.some(function (t) { return String(t).toLowerCase().indexOf(s) >= 0; });
      });
    },

    /**
     * **兼容性自检**：目录必须覆盖原始列表的每一条，且不漏不重。
     * @returns {{ok:boolean, missing:Array, dupes:Array, total:number}}
     */
    verifyCoverage(list) {
      const src = list || window.BUILTIN_CONTROLS || [];
      const seen = new Map();
      const dupes = [];
      src.forEach(function (c) {
        if (seen.has(c.key)) dupes.push(c.key);
        seen.set(c.key, 1);
      });
      const missing = [];
      seen.forEach(function (_v, k) { if (!catalog.has(k)) missing.push(k); });
      return { ok: missing.length === 0 && dupes.length === 0, missing: missing, dupes: dupes, total: src.length };
    },

    /** 测试用：清空 */
    __reset() {
      catalog.clear();
      stats = null;
    },

    /** 分类函数本身导出，便于单测与审计 */
    __classify: classify,
  };

  window.ICAR.registry.Catalog = ICAR.register("registry", "Catalog", Catalog);
  if (window.ControlCatalog === undefined) window.ControlCatalog = Catalog;
})();
