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
      const META = ICAR.registry.CatalogMeta;
      const decl = META ? META.get(c.key) : null;

      // ---- 静态元数据优先：声明过的条目**不调用 make()**，零副作用 ----
      // P2B 第一部分要求：「优先采用静态元数据注册机制，
      // 不允许控件目录扫描修改用户当前设计」。
      let node = null, err = null, cls = null;
      if (decl && decl.nodeType) {
        // 已声明结构：跳过探测。node 保持 null，后续用 decl 兜底。
      } else {
        const probeResult = probe(function () { return c.make(); });
        node = probeResult.node;
        err = probeResult.error;
        if (err) failures.push({ key: c.key, error: err });
        cls = classify(node);
      }
      const kind = decl && decl.kind ? decl.kind : (c.next ? KIND.PRESET : cls.kind);

      const entry = {
        key: c.key,
        name: (decl && decl.name) || c.name || "",
        kind: kind,
        category: decl && decl.category ? decl.category : categoryOf(node, cls),
        nodeType: decl && decl.nodeType ? decl.nodeType : (node ? node.type : "error"),
        renderer: decl && decl.renderer ? decl.renderer : cls.renderer,
        legacyKey: (decl && decl.legacyKey) || c.key,
        dataCapability: decl && decl.dataCapability ? decl.dataCapability
          : (c.next ? DATA.BOUND : cls.dataCapability),
        // ⚠️ 数据能力 ≠ 车辆可用性（P2B 第二部分）。
        // declared 可以直接给 vehicleAvailability；否则按数据源判定。
        availability: "unknown",
        vehicleAvailability: (decl && decl.vehicleAvailability) || "unknown",
        source: decl ? "declared" : "probe",   // 便于统计"还有多少条在走探测"
        tags: [],
        thumbnail: (decl && decl.thumbnail) || thumbnailOf(node, cls),
        // 附加诊断信息（不参与分类判定，便于审计）
        __meta: {
          index: idx,
          reason: cls ? cls.reason : ((decl && decl.note) || "declared"),
          next: !!c.next,
          semanticId: c.semanticId || "",
          variant: c.variant || "",
          parts: (node && node.parts && node.parts.length) || (decl && decl.parts) || 0,
          children: (node && node.children && node.children.length) || (decl && decl.children) || 0,
          pid: (node && node.pid) || "",
          statePid: (node && node.statePid) || "",
          style: node && node.style !== undefined ? node.style : null,
          assetId: (node && node.assetId) || "",
          makeError: err,
          declared: !!decl,
        },
      };
      entry.tags = tagsOf(entry, node, cls || { renderer: entry.renderer, kind: entry.kind });
      // ⚠️ 声明条目没有 node，但 availability 仍应按"它绑什么通道"计算 ——
      //    否则 gauge_0（绑 std_0C）会被误判成 L4（实测踩到）。
      //    通道来源：声明里的 pid/statePid，或旧实现 make() 后我们会拿到；
      //    这里用声明里的 dataCapability + 从旧条目探测到的 pid 兜底。
      // 声明条目**不调 make()**：通道信息由声明直接给出（decl.pid / decl.statePid）。
      // 这是 P2B「静态元数据注册机制」的核心 —— 声明过的条目零探测。
      const availNode = node || (decl ? { pid: decl.pid || "", statePid: decl.statePid || "" } : null);
      entry.availability = availabilityOf(entry, availNode);
      if (decl) {
        entry.__meta.pid = entry.__meta.pid || decl.pid || "";
        entry.__meta.statePid = entry.__meta.statePid || decl.statePid || "";
      }
      // 探测路径的车辆可用性由 availabilityOf 的结果推导（声明路径已自带，不覆盖）
      if (!(decl && decl.vehicleAvailability)) {
        const META2 = ICAR.registry.CatalogMeta;
        const V2 = META2 ? META2.VEHICLE : null;
        entry.vehicleAvailability = !V2 ? entry.availability
          : entry.availability === "L1" ? V2.IMPLEMENTED
          : entry.availability === "L2" ? V2.ALIAS_ONLY
          : entry.availability === "L4" ? V2.UNIMPLEMENTED
          : entry.availability === "n/a" ? V2.NA
          : V2.UNVERIFIED;
      }
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
  /**
   * 可用性判定。
   *
   * ⚠️⚠️ **P2B 第二部分硬要求**：不要把「App 已实现 PID」当成「真车可用」。
   *
   * 两个概念必须分开：
   *   · dataCapability     —— 这个控件**读不读数据**（结构事实）
   *   · vehicleAvailability —— 这条数据**在车上能不能拿到**（证据事实）
   *
   * 本函数返回的是**车辆可用性**（四层），依据 P1A 的 DataSource Registry。
   * L1 的含义严格限定为「App 已实现该通道」，**不代表车辆实际支持** —— 这一点
   * 在 UI 文案与 tags 里都会明确写出来。
   */
  function availabilityOf(entry, node) {
    const DS = ICAR.registry.DataSource;
    // 不读数据的条目不参与可用性判定
    if (entry.dataCapability === DATA.NONE) return "n/a";

    const raw = entry.dataCapability === DATA.STATE
      ? (node && node.statePid) || (entry.__meta && entry.__meta.statePid) || ""
      : (node && node.pid) || (entry.__meta && entry.__meta.pid) || "";

    if (!raw) return "L4";
    if (!DS) return "L3";

    const r = DS.resolve(raw);
    if (r.tier === "L1") return "L1";
    if (r.tier === "L2") return "L2";
    if (r.tier === "L4") return "L4";
    return "L3";
  }

  function computeStats() {
    const byKind = {}, byCategory = {}, byRenderer = {}, byAvailability = {}, byVehicle = {}, bySource = {};
    catalog.forEach(function (e) {
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      byCategory[e.category] = (byCategory[e.category] || 0) + 1;
      byRenderer[e.renderer] = (byRenderer[e.renderer] || 0) + 1;
      byAvailability[e.availability] = (byAvailability[e.availability] || 0) + 1;
      byVehicle[e.vehicleAvailability] = (byVehicle[e.vehicleAvailability] || 0) + 1;
      bySource[e.source] = (bySource[e.source] || 0) + 1;
    });
    return {
      total: catalog.size,
      byKind: byKind, byCategory: byCategory, byRenderer: byRenderer,
      byAvailability: byAvailability, byVehicle: byVehicle, bySource: bySource,
      failures: [],
      builtAt: Date.now(),
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

    // ============================================================ P2B：就绪触发与诊断

    /** 最近一次构建的诊断（失败/耗时/来源统计） */
    lastDiagnostics: null,

    /**
     * **应用就绪触发**（P2B 第一部分要求：减少对固定时长轮询的依赖）。
     *
     * 现状问题：P2A 用 `setTimeout` 轮询等 `CanvasState.design`，
     * 最多 50 次 × 100ms = 5s，超时就静默放弃。
     *
     * 本函数改为：
     *   1. 若设计已就绪 → **立即构建**（同步返回）
     *   2. 否则登记一个"待构建"，由 app.js 在 init 完成后**显式调用** `Catalog.onAppReady()`
     *   3. 保留一个**兜底轮询**（次数少、间隔长），用于没人调 onAppReady 的场景
     *
     * @returns {{ready:boolean, built:boolean, stats?:Object}}
     */
    bootstrap() {
      const ready = !!(window.CanvasState && window.CanvasState.design);
      if (ready) {
        const st = this.build();
        return { ready: true, built: true, stats: st };
      }
      this._pending = true;
      const self = this;
      let tries = 0;
      /**
       * 兜底轮询。
       *
       * ⚠️ 为什么 P2B 实测后把次数从 3 调回 20、间隔 100ms：
       * 启动时 `design` 要等 app.js 的 init() 跑完（含异步素材加载），
       * 实测约 1~2s。3 x 300ms = 0.9s 太短，会只建出部分目录（实测 total=15）。
       * 真正的解法是 onAppReady() 显式触发；轮询只是**没人调时的保险**。
       */
      (function tick() {
        if (!self._pending) return;              // 已被 onAppReady 抢先
        if (window.CanvasState && window.CanvasState.design) {
          self._pending = false;
          self.build();
          return;
        }
        if (++tries >= 20) { self._pending = false; self._bootFailed = "timeout"; return; }
        setTimeout(tick, 100);
      })();
      return { ready: false, built: false };
    },

    /** 由 app.js 在设计初始化完成后显式调用（**首选路径**） */
    onAppReady() {
      if (this.stats() && this.stats().total > 0 && !this._forceRebuildOnReady) {
        // 已构建过：幂等，不重复探测
        this._pending = false;
        return this.stats();
      }
      this._pending = false;
      return this.build();
    },

    /**
     * **诊断**：返回构建健康度与问题清单。
     *
     * @returns {{ok:boolean, total:number, declared:number, probed:number, failed:number, issues:Array}}
     */
    diagnose() {
      const st = this.stats();
      const issues = [];
      if (!st || !st.total) {
        issues.push({ level: "error", code: "empty", message: "目录为空：可能未初始化（design 未就绪）" });
      }
      const declared = (st.bySource && st.bySource.declared) || 0;
      const probed = (st.bySource && st.bySource.probe) || 0;
      const failed = (st.failures || []).length;
      if (failed) {
        issues.push({
          level: "warn", code: "probe-failed",
          message: failed + " 个条目 make() 失败，已降级为控件（详见 failures）",
        });
      }
      if (this._bootFailed) {
        issues.push({ level: "error", code: "boot-" + this._bootFailed, message: "启动构建未完成：" + this._bootFailed });
      }
      // 覆盖性自检（不能与实际列表漂移）
      if (st && st.total) {
        const cov = this.verifyCoverage();
        if (!cov.ok) {
          if (cov.missing.length) issues.push({ level: "error", code: "missing", message: "缺少 " + cov.missing.length + " 条：" + cov.missing.slice(0, 5).join(",") });
          if (cov.dupes.length) issues.push({ level: "error", code: "dupes", message: "重复 key：" + cov.dupes.slice(0, 5).join(",") });
        }
      }
      return {
        ok: issues.filter(function (i) { return i.level === "error"; }).length === 0,
        total: (st && st.total) || 0,
        declared: declared, probed: probed, failed: failed,
        issues: issues,
        builtAt: (st && st.builtAt) || null,
      };
    },

    /**
     * **恢复**：重建目录并返回诊断。用于初始化失败或状态可疑时。
     * @returns {{ok:boolean, stats:Object, diag:Object}}
     */
    recover() {
      this._bootFailed = null;
      let st = null, err = null;
      try {
        st = this.build();
      } catch (e) {
        err = e && e.message ? e.message : String(e);
      }
      const diag = this.diagnose();
      return { ok: !err && diag.ok, stats: st, diag: diag, error: err };
    },

    /** 测试用：清空 */
    __reset() {
      catalog.clear();
      stats = null;
      this.lastDiagnostics = null;
      this._pending = false;
      this._bootFailed = null;
    },

    /** 分类函数本身导出，便于单测与审计 */
    __classify: classify,
  };

  window.ICAR.registry.Catalog = ICAR.register("registry", "Catalog", Catalog);
  if (window.ControlCatalog === undefined) window.ControlCatalog = Catalog;
})();
