/* ==========================================================================
   validate.js —— 解析与校验（**必须与 data/DesignFile.kt 同源**）
   --------------------------------------------------------------------------
   硬错误 / 软警告的判定与文案逐条对齐 Kotlin 侧，由 tools/verify-studio.js
   跨语言比对守着。改这里的规则**必须同时改 DesignFile.kt**。

   ## v2 相对 v1 的两处语义变化（校验规则跟着变）
   1. 越界只对**根节点**警告 —— 子节点的 x/y 相对父节点，溢出父级是正常的
   2. 坐标可以超出 0..360 任意值（画布会裁切），只对根节点提示
   ========================================================================== */
"use strict";

(function () {
  const SCHEMA_V1 = window.SCHEMA_V1;
  const SCHEMA_V2 = window.SCHEMA_V2;
  const CANVAS = window.CANVAS;
  const MAX_NODES = window.MAX_NODES;
  const MAX_GAUGES = window.MAX_GAUGES;

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== null; }
  function trimNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  /**
   * 把 JSON.parse 的报错转成**带位置**的可读信息。
   * Kotlin 用 org.json，文案不可能逐字一致 —— 这条差异在差异清单里显式列出。
   */
  function parseJsonStrict(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      const m = /position\s+(\d+)/i.exec(e.message);
      if (m) {
        const pos = parseInt(m[1], 10);
        const before = text.slice(0, pos);
        const line = before.split("\n").length;
        const col = pos - before.lastIndexOf("\n");
        const near = text.slice(Math.max(0, pos - 20), pos + 20).replace(/\n/g, "⏎");
        return { ok: false, msg: `JSON 语法错误：第 ${line} 行第 ${col} 列附近 —— …${near}…`,
                   // **把位置结构化地带出来**（不只是塞进文案）——
                   // 界面要用它把光标跳到出错处、并高亮那一行
                   line: line, col: col, pos: pos };
      }
      return { ok: false, msg: `JSON 语法错误：${e.message}` };
    }
  }
  window.parseJsonStrict = parseJsonStrict;

  // ================================================================ 主入口

  /**
   * 解析设计文件。**不抛异常**，所有问题进 errors / warnings。
   *
   * v1 会自动**升级**成 v2 的节点树（gauge 根节点），并给一条提示。
   */
  function parseDesign(text) {
    const parsed = parseJsonStrict(text);
    if (!parsed.ok) return { design: null, errors: [parsed.msg], warnings: [] };
    return parseDesignRoot(parsed.value);
  }
  window.parseDesign = parseDesign;

  function parseDesignRoot(root) {
    const errors = [];
    const warnings = [];

    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      errors.push("顶层必须是一个 JSON 对象");
      return { design: null, errors, warnings };
    }

    // ---- schema
    const schema = typeof root.schema === "string" ? root.schema : "";
    let isV1 = false;
    if (!schema) {
      errors.push('缺少 `schema` 字段。应当写 "' + SCHEMA_V2 + '"');
    } else if (schema === SCHEMA_V1) {
      isV1 = true;
      warnings.push("这是 v1（`" + SCHEMA_V1 + "`）设计文件，已自动升级成 v2 的节点树。"
        + "保存时会写成 v2。");
    } else if (schema !== SCHEMA_V2) {
      errors.push("不支持的 schema：`" + schema + "`（本版本认 `" + SCHEMA_V1 + "` 与 `" + SCHEMA_V2 + "`）");
    }

    // ---- meta
    const meta = root.meta;
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      warnings.push("没有 `meta` 段（不影响渲染，但建议写上名字方便识别）");
    }

    // ---- canvas
    const canvas = root.canvas;
    const unit = (canvas && typeof canvas === "object") ? num(canvas.unit, 0) : 0;
    if (unit !== 0 && unit !== CANVAS) {
      errors.push("canvas.unit = " + trimNum(unit) + "，但本版本只支持 " + CANVAS +
        "。如果你按像素设计的，请换算：`坐标 / 屏宽 * 360`");
    }
    const designW = (canvas && typeof canvas === "object") ? num(canvas.designW, 2560) : 2560;
    const designH = (canvas && typeof canvas === "object") ? num(canvas.designH, 1600) : 1600;
    let scaleMode = (canvas && typeof canvas === "object") ? num(canvas.scaleMode, 0) : 0;
    if (designW <= 0 || designH <= 0) {
      errors.push("canvas.designW / designH 必须为正数（当前 " + trimNum(designW) + "×" + trimNum(designH) + "）");
    }
    if (!Number.isInteger(scaleMode) || scaleMode < 0 || scaleMode >= window.SCALE_MODES.length) {
      warnings.push("canvas.scaleMode = " + trimNum(scaleMode) + " 不认识（本版本只认 0.." +
        (window.SCALE_MODES.length - 1) + "）—— 已回落到「" + window.SCALE_MODES[0].n + "」");
      scaleMode = 0;
    }

    // ---- background（可选，v1 兼容字段）
    const background = parseBackground(root.background, warnings);

    // ---- assets（可选）
    const assets = [];
    const assetIds = new Set();
    if (root.assets !== undefined) {
      if (!Array.isArray(root.assets)) {
        errors.push("`assets` 必须是数组");
      } else {
        root.assets.forEach((a, i) => {
          if (a === null || typeof a !== "object" || Array.isArray(a)) {
            errors.push("assets[" + i + "] 不是一个对象");
            return;
          }
          const id = typeof a.id === "string" ? a.id : "";
          const path = typeof a.path === "string" ? a.path : "";
          if (!id) { errors.push("assets[" + i + "] 缺少 `id`"); return; }
          if (assetIds.has(id)) { errors.push("assets[" + i + "] 的 id `" + id + "` 重复"); return; }
          if (!path) { errors.push("assets[" + i + "]（" + id + "）缺少 `path`"); return; }
          assetIds.add(id);
          assets.push({
            id: id,
            name: typeof a.name === "string" ? a.name : id,
            kind: typeof a.kind === "string" ? a.kind : "custom",
            path: path,
            w: num(a.w, 0), h: num(a.h, 0), bytes: num(a.bytes, 0),
          });
        });
      }
    }

    // ---- 变量 / 模式 / 绑定（v2.80.0，规格 §3）
    //
    // ⚠️ **放在 nodes 之前**：`nodes` 的 `$` 检查与漂移检测都要拿 bindings 当判据。
    // 顺带一个好处：即使后面 nodes 报错返回 null，这些警告也已经收进 warnings 里了。
    const tokens = parseTokens(root.tokens, errors, warnings);
    const modes = parseModes(root.modes, tokens, errors, warnings);
    const bindings = parseBindings(root.bindings, warnings);
    const activeMode = typeof root.activeMode === "string" ? root.activeMode.trim() : "";
    if (activeMode && !modes.some(m => m.id === activeMode)) {
      warnings.push("`activeMode` = `" + activeMode + "` 在 `modes` 里找不到 —— 已回落到"
        + "「当前主题对应的内置模式」（再没有就用第一个模式）");
    }
    checkBindingRefs(bindings, tokens, errors);

    // ---- 多页面（可选）。有 pages 就用 pages，否则 nodes 当单页 ——
    // **向后兼容**：没有 pages 字段的老文件行为完全不变。
    let pages = null;
    if (!isV1 && Array.isArray(root.pages) && root.pages.length) {
      pages = [];
      root.pages.forEach((pg, i) => {
        if (pg === null || typeof pg !== "object" || Array.isArray(pg)) {
          errors.push("pages[" + i + "] 不是一个对象");
          return;
        }
        const kids = Array.isArray(pg.nodes) ? pg.nodes.map((o, k) => {
          if (o === null || typeof o !== "object" || Array.isArray(o)) {
            errors.push("pages[" + i + "].nodes[" + k + "] 不是一个对象");
            return null;
          }
          return parseNode(o, "pages[" + i + "].nodes[" + k + "]", errors, warnings, assetIds, null);
        }).filter(Boolean) : [];
        pages.push({ id: pg.id || ("pg" + i), name: pg.name || ("页面 " + (i + 1)), nodes: kids });
      });
      if (!pages.length) { errors.push("pages 是空的 —— 仪表盘上什么都不会显示"); pages = null; }
    }

    // ---- nodes / gauges
    let nodes = pages ? pages[0].nodes : [];
    if (isV1) {
      const up = upgradeV1(root, errors, warnings, assetIds);
      nodes = up.nodes;
      if (up.count === 0 && errors.length === 0) {
        // v1 的空 gauges 是硬错误，升级路径也要保留这条
      }
    } else if (!pages) {
      const arr = root.nodes;
      if (!Array.isArray(arr)) {
        errors.push("缺少 `nodes` 数组");
        return { design: null, errors, warnings };
      }
      if (arr.length === 0) errors.push("`nodes` 是空的 —— 仪表盘上什么都不会显示");
      let count = 0;
      nodes = arr.map((o, i) => {
        if (o === null || typeof o !== "object" || Array.isArray(o)) {
          errors.push("nodes[" + i + "] 不是一个对象");
          return null;
        }
        return parseNode(o, "nodes[" + i + "]", errors, warnings, assetIds, () => ++count);
      }).filter(Boolean);
      const total = flatten(nodes).length;
      if (total > MAX_NODES) {
        errors.push("`nodes` 展开后有 " + total + " 个节点，超过上限 " + MAX_NODES);
      }
    }

    // ---- controls（自定义控件库，可选）
    const controls = [];
    if (root.controls !== undefined) {
      if (!Array.isArray(root.controls)) {
        errors.push("`controls` 必须是数组");
      } else {
        root.controls.forEach((c, i) => {
          if (c === null || typeof c !== "object" || Array.isArray(c)) {
            errors.push("controls[" + i + "] 不是一个对象");
            return;
          }
          if (c.node === null || typeof c.node !== "object" || Array.isArray(c.node)) {
            errors.push("controls[" + i + "] 缺少 `node`（模板节点）");
            return;
          }
          const n = parseNode(c.node, "controls[" + i + "].node", errors, warnings, assetIds);
          if (n) {
            controls.push({
              id: typeof c.id === "string" && c.id ? c.id : window.newId("ct"),
              name: typeof c.name === "string" && c.name ? c.name : n.name,
              node: n,
            });
          }
        });
      }
    }

    // ---- 核心不变式：`nodes` 里不许出现 `$`（§3.1 / §4.2）+ 漂移检测（§5）
    //
    // ⚠️ 有 `pages` 时只走 pages —— `nodes` 那时是"当前页的副本"，
    // 两边都走会把同一处报两遍，而且被忽略的那份 `nodes` 本来就不参与渲染。
    const nodeRoots = pages
      ? pages.map((pg, i) => ({ list: pg.nodes, path: "pages[" + i + "].nodes" }))
      : [{ list: nodes, path: (isV1 ? "gauges" : "nodes") }];
    checkDollarInNodes(nodeRoots, bindings, errors, warnings);
    // 漂移检测要用**与 resolveDesign 同一套**的当前值（§4「不许各写一份」）
    checkDrift(nodeRoots, bindings,
      window.resolveTokenState({ tokens: tokens, modes: modes, activeMode: activeMode, themeId: typeof root.theme === "string" ? root.theme : "" }),
      warnings);

    if (errors.length) return { design: null, errors, warnings };

    const design = {
      name: (meta && typeof meta.name === "string" && meta.name.trim()) ? meta.name : "未命名设计",
      author: (meta && typeof meta.author === "string") ? meta.author : "",
      description: (meta && typeof meta.description === "string") ? meta.description : "",
      themeId: typeof root.theme === "string" ? root.theme : "",
// 内嵌配色（P8-5）。**缺字段 / 不是对象都当没有** —— 老文件行为不变。
themeColors: (root.themeColors && typeof root.themeColors === "object" && !Array.isArray(root.themeColors))
  ? root.themeColors : null,
  // 内嵌配色与内置主题的**差异**部分（v2.31.0）—— 只留"用户改过的"，
  // 这样换主题时没改过的字段还会跟着新主题走。
  themeColorsOverride: (function () {
    const tc = root.themeColors;
    if (!tc || typeof tc !== "object" || Array.isArray(tc)) return null;
    const themeId = typeof root.theme === "string" ? root.theme : "";
    const base = window.GAUGE_THEMES ? window.GAUGE_THEMES[themeId] : null;
    if (!base) return Object.assign({}, tc);   // 未知主题：整份留下
    const out = {};
    Object.keys(tc).forEach(function (k) { if (tc[k] !== base[k]) out[k] = tc[k]; });
    return Object.keys(out).length ? out : null;
  })(),
      canvas: { unit: CANVAS, designW: designW, designH: designH, scaleMode: scaleMode },
      background: background,
      assets: assets,
      controls: controls,
      // ---- 变量 / 模式 / 绑定（v2.80.0，规格 §3）
      //
      // ⚠️ 这四个字段**只活在内存里的 design 对象上**：
      //   · `toV2Json` 是显式构造 root 的，不遍历 design 的键 →
      //     **不写进文件**，所以对 App 与存量文件零影响（App 侧一行都不用改）
      //   · 第 4 步（`model.js` 序列化四个新键）才会真正落盘 —— 本轮刻意不做
      // 缺省值取"空"而不是 null：下游（resolveDesign / 校验）不用再判空。
      tokens: tokens,
      modes: modes,
      activeMode: activeMode,
      bindings: bindings,
      nodes: nodes,
      // ⚠️ **必须兜底成单页**：validate 这里是字面量构造对象，不走 createDesign，
      // 留 undefined 的话 d.pages 是空的，切页 / 序列化全会炸。
      // 注意 nodes 与 pages[0].nodes 是**同一个数组引用** ——
      // 这是「不用改几千处现有代码」的关键。
      pages: pages || [{ id: "pg0", name: "主页面", nodes: nodes }],
      pageIndex: 0,
    };
    return { design: design, errors: [], warnings: warnings };
  }
  window.parseDesignRoot = parseDesignRoot;

  // ================================================================ v1 → v2 升级

  /**
   * 把 v1 的扁平 `gauges[]` 升级成 v2 的 gauge 根节点。
   *
   * **一对一**，不做任何坐标换算 —— v1 的 x/y/w/h 已经是 0..360 画布单位，
   * 而 v2 根节点的 x/y 就是画布坐标。所以迁移是恒等变换。
   * z 用数组下标，保证**绘制顺序与 v1 完全一致**。
   */
  function upgradeV1(root, errors, warnings, assetIds) {
    const arr = root.gauges;
    if (!Array.isArray(arr)) {
      errors.push("缺少 `gauges` 数组");
      return { nodes: [], count: 0 };
    }
    if (arr.length === 0) {
      errors.push("`gauges` 是空的 —— 仪表盘上什么都不会显示");
      return { nodes: [], count: 0 };
    }
    if (arr.length > MAX_GAUGES) {
      errors.push("`gauges` 有 " + arr.length + " 项，超过上限 " + MAX_GAUGES);
    }
    const nodes = [];
    arr.forEach((o, i) => {
      if (o === null || typeof o !== "object" || Array.isArray(o)) {
        errors.push("gauges[" + i + "] 不是一个对象");
        return;
      }
      const n = parseNode(o, "gauges[" + i + "]", errors, warnings, assetIds, null, true);
      if (n) { n.z = i; nodes.push(n); }
    });
    return { nodes: nodes, count: nodes.length };
  }

  // ================================================================ 单节点

  /**
   * 解析一个节点（v2）。v1 的 gauge 也走这里 —— `forceGauge` 为真时按仪表处理。
   *
   * @param path 报错用的字段路径（如 `nodes[0].children[2]`）
   */
  function parseNode(o, path, errors, warnings, assetIds, bumpCount, forceGauge) {
    const type = forceGauge ? window.NODE_GAUGE
      : (typeof o.type === "string" && o.type ? o.type : window.NODE_GAUGE);

    const known = window.NODE_TYPES.map(t => t.v);
    if (known.indexOf(type) < 0) {
      errors.push(path + " 的 type `" + type + "` 不认识（本版本认：" + known.join(" / ") + "）");
      return null;
    }
    if (bumpCount) bumpCount();

    // ---- 变换（所有类型共有）
    const x = num(o.x, 0), y = num(o.y, 0);
    const w = num(o.w, forceGauge ? 120 : 120), h = num(o.h, forceGauge ? 120 : 120);
    const rotation = num(o.rotation, 0);
    const scale = num(o.scale, 1);
    let alpha = num(o.alpha, 255);

    if (w <= 0 || h <= 0) {
      errors.push(path + " 的尺寸非法：w=" + trimNum(w) + " h=" + trimNum(h) + "（必须为正）");
    }
    if (scale <= 0) {
      errors.push(path + " 的 scale=" + trimNum(scale) + " 非法（必须为正）");
    }
    if (alpha < 0 || alpha > 255) {
      warnings.push(path + " 的 alpha=" + trimNum(alpha) + " 超出 0..255 —— 已夹住");
      alpha = Math.max(0, Math.min(255, Math.round(alpha)));
    }

    const node = {
      id: typeof o.id === "string" && o.id ? o.id : window.newId("n"),
      type: type,
      name: typeof o.name === "string" && o.name ? o.name : (type === window.NODE_GAUGE ? "仪表" : type),
      x: x, y: y, w: w, h: h,
      rotation: rotation, scale: scale,
      alpha: Math.round(alpha),
      z: num(o.z, 0),
      locked: !!o.locked,
      visible: o.visible === undefined ? true : !!o.visible,
      children: [],
    };

    // ---- 类型专属
    if (type === window.NODE_GAUGE) {
      const rawPid = typeof o.pid === "string" ? o.pid : "";
      if (!rawPid.trim()) {
        errors.push(path + " 缺少 `pid`（可以写语义名如 `obd.rpm`，或直接写 PID id 如 `std_0C`）");
      }
      const pid = window.resolvePid(rawPid);
      if (rawPid.trim() && !(rawPid in window.PID_ALIASES) && !(rawPid in window.BUILTIN_PIDS)) {
        warnings.push(path + " 的 pid `" + rawPid + "` 不在内置 PID 库里 —— 需要先在 App 里导入对应 PID");
      }
      node.pid = pid;
      node.rawPid = rawPid;
      node.style = num(o.style, 0);
      node.min = num(o.min, 0);
      node.max = num(o.max, 100);
      node.warnLow = has(o, "warnLow") ? num(o.warnLow, 0) : null;
      node.warnHigh = has(o, "warnHigh") ? num(o.warnHigh, 0) : null;
      node.extraPids = Array.isArray(o.extraPids) ? o.extraPids.filter(s => typeof s === "string") : [];
      node.ringStyle = num(o.ringStyle, 0);
      node.ringSegments = num(o.ringSegments, 40);
      node.neonPreset = (typeof o.neonPreset === "string" && o.neonPreset.trim()) ? o.neonPreset : null;
      let cs = null;
      if (has(o, "cardStyle")) {
        const c = num(o.cardStyle, 0);
        cs = (Number.isInteger(c) && c >= 0 && c < window.CARD_NAMES.length) ? c : null;
      }
      node.cardStyle = cs;
      if (node.min >= node.max) {
        errors.push(path + "（" + pid + "）量程非法：min=" + trimNum(node.min) + " ≥ max=" + trimNum(node.max));
      }
      node.parts = parseParts(o.parts, path + ".parts", warnings, assetIds);
      node.card = parseCard(o.card, path + ".card", warnings);
      node.labelFont = parseFont(o.labelFont, path + ".labelFont", warnings);
      node.showLabel = o.showLabel === undefined ? true : !!o.showLabel;
      node.showRange = o.showRange === undefined ? true : !!o.showRange;
    } else if (type === window.NODE_IMAGE) {
      node.assetId = typeof o.assetId === "string" ? o.assetId : "";
      // ⚠️ `statePid` 必须与 `model.js` 的 `createNode`（NODE_IMAGE 分支）**同源**：
      //    内部查表用 id、回显与写文件用别名。原来这里直接抄 `o.statePid`、
      //    而且**不设 `rawStatePid`** —— 于是「导出再导入」之后编辑器里
      //    状态 PID 输入框变成空的（`std_05` 认不出别名），
      //    再保存一次就会把 `std_05` 写回文件（丢掉可读的语义别名）。
      //    v1.20.16 修（由 tests/verify-lamp-state.js 的往返用例抓到）。
      const rawState = o.rawStatePid || o.statePid || "";
      node.rawStatePid = rawState;
      node.statePid = rawState ? window.resolvePid(rawState) : "";
      node.states = parseStates(o.states, path, errors, warnings, assetIds);
      node.stateWarn = parseThreshold(o.stateWarn, path + ".stateWarn", warnings);
      node.stateCritical = parseThreshold(o.stateCritical, path + ".stateCritical", warnings);
      if (node.assetId && assetIds && !assetIds.has(node.assetId)) {
        warnings.push(path + " 引用的素材 `" + node.assetId + "` 不在 `assets` 清单里 —— 请重新导入");
      }
    } else if (type === window.NODE_TEXT) {
      node.text = typeof o.text === "string" ? o.text : "文字";
      node.font = parseFont(o.font, path + ".font", warnings);
    }

    // ---- 子节点
    if (Array.isArray(o.children) && o.children.length) {
      o.children.forEach((c, i) => {
        if (c === null || typeof c !== "object" || Array.isArray(c)) {
          errors.push(path + ".children[" + i + "] 不是一个对象");
          return;
        }
        const cn = parseNode(c, path + ".children[" + i + "]", errors, warnings, assetIds, bumpCount);
        if (cn) node.children.push(cn);
      });
    }

    // ---- 尺寸过小（所有类型）
    if (w > 0 && h > 0 && (w < 10 || h < 10)) {
      warnings.push(path + "（" + (node.pid || node.name) + "）尺寸过小（" + trimNum(w) + "×" +
        trimNum(h) + "），几乎看不见");
    }
    return node;
  }

  /**
   * 解析子部件数组。
   *
   * **空数组 / 缺失都当"没有部件"**（走 style 的程序化画法）——
   * 这样存量文件行为完全不变。
   *
   * 部件引用的素材不在清单里只给**警告**：设计文件常跨机器传，
   * 素材可能还没拷过来。
   */
  function parseParts(arr, path, warnings, assetIds) {
    if (arr === undefined || arr === null) return null;
    if (!Array.isArray(arr)) {
      warnings.push(path + " 不是数组 —— 已忽略（改用 style 的程序化画法）");
      return null;
    }
    if (!arr.length) return null;
    const out = [];
    arr.forEach((o, i) => {
      if (o === null || typeof o !== "object" || Array.isArray(o)) {
        warnings.push(path + "[" + i + "] 不是一个对象 —— 已忽略");
        return;
      }
      const p = window.normalizePart(o);
      if (o.kind !== undefined && p.kind !== o.kind) {
        warnings.push(path + "[" + i + "].kind = " + trimNum(o.kind) + " 不认识（本版本认：" +
          window.PART_KINDS.map(k => k.v).join(" / ") + "）—— 已回落到 " + p.kind);
      }
      // value 部件不需要素材；其余部件没素材就画不出来
      if (p.kind !== "value" && !p.assetId) {
        warnings.push(path + "[" + i + "]（" + p.kind + "）没有选素材 —— 这一层画不出来");
      }
      if (p.assetId && assetIds.size && !assetIds.has(p.assetId)) {
        warnings.push(path + "[" + i + "] 引用的素材 `" + p.assetId + "` 不在 assets 清单里");
      }
      out.push(p);
    });
    return out.length ? out : null;
  }

  /** 解析一个阈值：null / 非数字都当"没设"（回落 PID 库推断） */
  function parseThreshold(v, path, warnings) {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      warnings.push(path + " = " + trimNum(v) + " 不是数字 —— 已忽略（改为按 PID 库推断）");
      return null;
    }
    return n;
  }

  /**
   * 解析底框覆盖（`card`）。**缺字段一律 null = 跟随主题**，不报错。
   *
   * 非法值给警告并夹住 —— 底框是可见属性，用户改了没反应会以为工具坏了。
   */
  function parseCard(o, path, warnings) {
    if (o === undefined || o === null) return null;
    if (typeof o !== "object" || Array.isArray(o)) {
      warnings.push(path + " 不是一个对象 —— 已忽略该段（底框跟随主题）");
      return null;
    }
    const out = {};
    if (o.show !== undefined) out.show = !!o.show;
    if (o.alpha !== undefined) {
      // ⚠️ **变量引用原样保留**（v2.80.0，规格 §3.6 白名单里有 `card.alpha`）。
      // 走下面的 `Number()` 分支的话 `"$dim"` 会变成"不是数字 —— 已忽略"，
      // 于是绑定在**校验之前**就被丢掉了 —— 症状和 §4.2 那个静默陷阱一模一样：
      // 不报错、值没了。所以引用串直接放行，交给「nodes 里不许有 `$`」那条硬错误去判。
      if (window.isTokenRef(o.alpha)) {
        out.alpha = o.alpha;
      } else {
        const a = Number(o.alpha);
        if (!Number.isFinite(a)) {
          warnings.push(path + ".alpha = " + trimNum(o.alpha) + " 不是数字 —— 已忽略");
        } else {
          if (a < 0 || a > 255) warnings.push(path + ".alpha = " + trimNum(a) + " 超出 0..255 —— 已夹住");
          out.alpha = Math.max(0, Math.min(255, Math.round(a)));
        }
      }
    }
    if (o.radius !== undefined) {
      if (window.isTokenRef(o.radius)) {
        out.radius = o.radius;                 // 同上：引用原样保留
      } else {
        const r = Number(o.radius);
        if (!Number.isFinite(r)) {
          warnings.push(path + ".radius = " + trimNum(o.radius) + " 不是数字 —— 已忽略");
        } else {
          if (r < 0) warnings.push(path + ".radius = " + trimNum(r) + " 为负 —— 已夹到 0");
          out.radius = Math.max(0, Math.min(120, r));
        }
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * 解析字体对象。**缺字段一律回落默认值**（不报错）——
   * 字体是"锦上添花"的属性，不该因为它拦下整个设计。
   * 但**非法值给警告**，否则用户改了没反应会以为工具坏了。
   */
  function parseFont(o, path, warnings) {
    if (o === undefined || o === null) return window.normalizeFont(null);
    if (typeof o !== "object" || Array.isArray(o)) {
      warnings.push(path + " 不是一个对象 —— 已用默认字体");
      return window.normalizeFont(null);
    }
    const f = window.normalizeFont(o);
    if (o.family !== undefined && f.family !== o.family) {
      warnings.push(path + ".family = " + trimNum(o.family) + " 不认识（本版本认：" +
        window.FONT_FAMILIES.map(x => x.v).join(" / ") + "）—— 已回落到 " + f.family);
    }
    if (o.align !== undefined && f.align !== o.align) {
      warnings.push(path + ".align = " + trimNum(o.align) + " 不认识（本版本认：" +
        window.FONT_ALIGNS.map(x => x.v).join(" / ") + "）—— 已回落到 " + f.align);
    }
    if (o.size !== undefined && (Number(o.size) <= 0 || !Number.isFinite(Number(o.size)))) {
      warnings.push(path + ".size = " + trimNum(o.size) + " 非法 —— 已回落到 " + f.size);
    }
    return f;
  }

  /** 状态系统（大纲 §四）。缺字段就当作"该状态不存在"，不报错 */
  function parseStates(o, path, errors, warnings, assetIds) {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const out = {};
    let any = false;
    window.STATE_NAMES.forEach(s => {
      const v = o[s.v];
      if (v === null || typeof v !== "object" || Array.isArray(v)) return;
      any = true;
      const st = {
        assetId: typeof v.assetId === "string" ? v.assetId : "",
        alpha: Math.max(0, Math.min(255, Math.round(num(v.alpha, 255)))),
        blink: !!v.blink,
        // WCAG 2.3.1「每秒不超过三次」→ 周期下限 400ms（=2.5Hz）。
        // 原来是 60ms（16.7Hz），比红线高 5 倍多。与 AlertPulse.MIN_BLINK_MS 同源。
        blinkMs: Math.max(window.MIN_BLINK_MS, Math.round(num(v.blinkMs, window.MIN_BLINK_MS))),
      };
      if (st.assetId && assetIds && !assetIds.has(st.assetId)) {
        warnings.push(path + ".states." + s.v + " 引用的素材 `" + st.assetId + "` 不在 `assets` 清单里");
      }
      out[s.v] = st;
    });
    return any ? out : null;
  }

  /** 背景段（可选）。路径不存在**只警告不报错**（设计文件常跨机器传） */
  function parseBackground(o, warnings) {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return null;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    if (!path) {
      warnings.push("`background` 段没有 `path` —— 已忽略该段（不影响仪表布局）");
      return null;
    }
    const fit = num(o.fit, 0);
    // 尺寸（可选）：0 / 缺省 = 按铺法自动。App 侧目前忽略这两个字段（阶段 2 才读）
    const w = Math.max(0, num(o.w, 0));
    const h = Math.max(0, num(o.h, 0));
    if (!Number.isInteger(fit) || fit < 0 || fit >= window.FIT_NAMES.length) {
      warnings.push("background.fit = " + trimNum(fit) + " 不认识（本版本只认 0.." +
        (window.FIT_NAMES.length - 1) + "：" + window.FIT_NAMES.join(" / ") +
        "）—— 已回落到「" + window.FIT_NAMES[0] + "」");
      return { path: path, fit: 0, w: w, h: h };
    }
    return { path: path, fit: fit, w: w, h: h };
  }

  // ================================================================ 变量 / 模式 / 绑定
  //
  // 规格：[`docs/下一步-变量模式与组件变体.md`](../../../docs/下一步-变量模式与组件变体.md) §3 ~ §5。
  //
  // ⚠️ 这一节**只解析与检查**，不改写任何东西：
  //   · 未知的顶层键 App 会忽略（DesignFile.kt 用 optJSONObject/optJSONArray 读），
  //     所以"工具认识 tokens/modes/bindings"对 App 与存量文件**零影响**
  //   · 真正把四个新键**写出**是 `model.js` 的下一步（§9.1 第 4 步），本轮刻意不做
  //
  // 硬错误 / 警告的分工（§5 的表，v2.80.1 起按字段分两档）：
  //   颜色/数值字段里出现 `$` 且 bindings 没有对应条目 → **硬错误**（引用不能写在 nodes 里）
  //   `text` 里出现 `$` 且 bindings 没有对应条目        → **警告**（字面 `$` 是正常内容，见下）
  //   bindings 指向不存在的变量                        → **硬错误**
  //   nodes 的值与 bindings 推出来的不一致              → **警告**（手改 JSON 是合法用法，但会被覆盖）

  /**
   * 解析 `tokens`（§3.2）。
   *
   * **值一律走 [window.coerceTokenValue]**（与 `resolveDesign` 同一个函数）——
   * 校验的判据和解析的判据必须是同一条，否则会出现"校验说合法、解析却跳过"。
   */
  function parseTokens(raw, errors, warnings) {
    const out = [];
    if (raw === undefined || raw === null) return out;
    if (!Array.isArray(raw)) { errors.push("`tokens` 必须是数组"); return out; }
    const ids = {}, names = {};
    raw.forEach((t, i) => {
      const path = "tokens[" + i + "]";
      if (t === null || typeof t !== "object" || Array.isArray(t)) {
        errors.push(path + " 不是一个对象");
        return;
      }
      const id = typeof t.id === "string" ? t.id.trim() : "";
      if (!id) { errors.push(path + " 缺少 `id`（变量靠 id 被引用，不能省）"); return; }
      if (ids[id]) { errors.push(path + " 的 id `" + id + "` 与前面的变量重复"); return; }
      if (id.charAt(0) === window.MODE_RAW_PREFIX) {
        errors.push(path + " 的 id 不能以 `" + window.MODE_RAW_PREFIX + "` 开头（那是 modes 里"
          + "「直接覆盖 themeColors」的保留前缀）");
        return;
      }
      ids[id] = true;

      const name = (typeof t.name === "string" && t.name.trim()) ? t.name.trim() : id;
      if (name.charAt(0) === "$") {
        warnings.push(path + " 的名字以 `$` 开头 —— 引用语法里 `$` 是前缀，这个名字**引用不到**");
      } else if (names[name]) {
        warnings.push(path + " 的名字 `" + name + "` 与前面的变量重名 —— 按名字引用时以**先出现的**为准");
      } else {
        names[name] = true;
      }

      // 类型：不认识就按值猜（比"一律当字符串"更贴近用户意图）
      let type = typeof t.type === "string" ? t.type : "";
      if (window.TOKEN_TYPE_VALUES.indexOf(type) < 0) {
        const guess = window.isHexColor(t.value) ? "color"
          : (typeof t.value === "number" && Number.isFinite(t.value)) ? "number" : "string";
        warnings.push(path + " 的 type `" + trimNum(t.type) + "` 不认识（本版本认："
          + window.TOKEN_TYPE_VALUES.join(" / ") + "）—— 已按值当作 `" + guess + "`");
        type = guess;
      }

      // 值：null/undefined = "没设"，合法；给了但转不出来 = 警告（解析时会跳过它）
      if (t.value !== null && t.value !== undefined
        && window.coerceTokenValue(type, t.value) === undefined) {
        warnings.push(path + "（" + name + "）的 value " + trimNum(t.value)
          + " 不是合法的 " + type + " —— 解析时会跳过它");
      }

      const tok = { id: id, name: name, type: type, value: (t.value === undefined ? null : t.value) };
      if (typeof t.builtin === "string" && t.builtin) {
        if (!window.THEME_COLOR_FIELDS.some(f => f.k === t.builtin)) {
          warnings.push(path + " 的 builtin `" + t.builtin + "` 不是主题色字段（"
            + window.THEME_COLOR_FIELDS.map(f => f.k).join(" / ") + "）—— 不会写进 themeColors");
        } else {
          if (!window.isHexColor(tok.value)) {
            warnings.push(path + " 是内置变量（" + t.builtin + "）但值不是 `#RRGGBB` —— "
              + "解析时会**回落内置主题的同名色**，不会写坏 themeColors");
          }
          tok.builtin = t.builtin;
        }
      }
      out.push(tok);
    });
    return out;
  }

  /** 解析 `modes`（§3.3）。`values` 只存差异；`@` 开头的键 = 直接覆盖 themeColors 的同名字段 */
  function parseModes(raw, tokens, errors, warnings) {
    const out = [];
    if (raw === undefined || raw === null) return out;
    if (!Array.isArray(raw)) { errors.push("`modes` 必须是数组"); return out; }
    const byId = {}, byName = {};
    tokens.forEach(t => { byId[t.id] = t; if (t.name) byName[t.name] = t; });
    const ids = {};
    raw.forEach((m, i) => {
      const path = "modes[" + i + "]";
      if (m === null || typeof m !== "object" || Array.isArray(m)) {
        errors.push(path + " 不是一个对象");
        return;
      }
      const id = typeof m.id === "string" ? m.id.trim() : "";
      if (!id) { errors.push(path + " 缺少 `id`"); return; }
      if (ids[id]) { errors.push(path + " 的 id `" + id + "` 与前面的模式重复"); return; }
      ids[id] = true;

      const values = {};
      if (m.values === undefined || m.values === null) {
        warnings.push(path + " 没有 `values` —— 这个模式不给任何变量赋值（等于全部跟随默认值）");
      } else if (typeof m.values !== "object" || Array.isArray(m.values)) {
        warnings.push(path + ".values 不是一个对象 —— 已当空（这个模式不给任何变量赋值）");
      } else {
        Object.keys(m.values).forEach(k => {
          const v = m.values[k];
          if (k.charAt(0) === window.MODE_RAW_PREFIX) {
            const f = k.slice(1);
            if (["glow", "title", "description"].indexOf(f) < 0) {
              warnings.push(path + ".values." + k + " 会**原样写进 themeColors**，但 `" + f
                + "` 不是已知的主题字段（已知：glow / title / description）");
            } else if (f === "glow" && typeof v !== "boolean") {
              warnings.push(path + ".values." + k + " 应当是 true / false —— 当前是 " + trimNum(v));
            }
            values[k] = v;
            return;
          }
          const t = byId[k] || byName[k];
          if (!t) {
            warnings.push(path + ".values 里的 `" + k + "` 不是任何变量（id 或名字）—— 已忽略");
            return;
          }
          if (window.coerceTokenValue(t.type, v) === undefined) {
            warnings.push(path + ".values." + k + " 的值 " + trimNum(v)
              + " 对不上变量类型 " + t.type + " —— 已忽略（回落默认值）");
            return;
          }
          values[k] = v;
        });
      }
      out.push({
        id: id,
        name: (typeof m.name === "string" && m.name.trim()) ? m.name.trim() : id,
        values: values,
      });
    });
    return out;
  }

  /** 解析 `bindings`（§3.4）。只留白名单字段 + `$` 引用；其余一律"警告 + 忽略" */
  function parseBindings(raw, warnings) {
    const out = {};
    if (raw === undefined || raw === null) return out;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push("`bindings` 必须是一个对象（`{ 节点id: { 字段: \"$变量\" } }`）—— 已忽略该段");
      return out;
    }
    Object.keys(raw).forEach(nid => {
      const spec = raw[nid];
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
        warnings.push("bindings." + nid + " 不是一个对象 —— 已忽略");
        return;
      }
      const one = {};
      Object.keys(spec).forEach(p => {
        const v = spec[p];
        if (p.charAt(0) === window.MODE_RAW_PREFIX) {
          // §3.4 的 @component / @variant：**阶段 2** 的血缘字段。
          // 如实说"本版本不解析"，不要静默收下 —— 静默收下会让用户以为组件已经联动。
          warnings.push("bindings." + nid + "." + p + " 是阶段 2 的组件血缘字段 —— 本版本不解析，已忽略");
          return;
        }
        if (!window.bindableField(p)) {
          warnings.push("bindings." + nid + "." + p + " 不在可绑定白名单里（本版本只支持："
            + window.BINDABLE_FIELD_PATHS.join(" / ") + "）—— 已忽略");
          return;
        }
        if (!window.isTokenRef(v)) {
          warnings.push("bindings." + nid + "." + p + " 的值 " + trimNum(v)
            + " 不是变量引用（要以 `$` 开头）—— 已忽略");
          return;
        }
        one[p] = v;
      });
      if (Object.keys(one).length) out[nid] = one;
    });
    return out;
  }

  /**
   * 每个绑定条目引用的变量**必须存在**（§5 的表：错误）。
   *
   * 为什么是错误而不是"回落默认值"：绑定指向一个不存在的变量时，
   * 这个字段到底该显示什么**没有正确答案** —— 而 App 侧拿到的是
   * "上一次写进去的字面值"，看起来一切正常。报出来，别让它烂在文件里。
   */
  function checkBindingRefs(bindings, tokens, errors) {
    const names = {};
    tokens.forEach(t => { names[t.id] = true; if (t.name) names[t.name] = true; });
    Object.keys(bindings).forEach(nid => {
      Object.keys(bindings[nid]).forEach(p => {
        const ref = bindings[nid][p];
        if (!names[window.tokenRefName(ref)]) {
          errors.push("bindings." + nid + " 引用了不存在的变量 " + ref);
        }
      });
    });
  }

  /**
   * **`nodes` 里永远不出现 `$` 引用**（§3.1 的核心不变式 / §4.2）。
   *
   * 这条是「App 零改动」的全部依据：App 不认识 `$`，拿到引用串会**静默回落**
   * 成默认色 —— 不报错、不崩，就是颜色不对，直到推上设备才发现。
   *
   * ## v2.80.1 起按字段分**两档**（原来的"一律硬错误"会把文件锁死）
   *
   * | 字段 | 判据 | 为什么 |
   * |---|---|---|
   * | `font.color` / `labelFont.color` / `card.radius` / `card.alpha` | **硬错误** | 合法值是 `#RRGGBB` 或数字，**不可能有字面 `$`** —— 出现 `$` 必然是调试期笔误，硬错误能立刻抓住 |
   * | `text` | **警告** | `$100` / `$PID` 是**正常内容**。硬错误 = 用户的文件打不开，而这个项目最怕的就是"文件打不开 / 画布是空的" |
   *
   * ⚠️ **降为警告仍然满足 §4.2「不静默」的初衷** —— 问题照样被报出来了，
   * 只是不再用"打不开文件"这种代价最高、而收益最低的方式报。
   * 文案必须说清**怎么办**，否则用户只知道"有问题"。
   *
   * ## ⚠️ v2.80.2：`text` 上**没有转义**，文案不许再教 `$$`（规格 §十二.3）
   *
   * v2.80.1 的文案是"如果这是要显示的字面 `$`，请写成 `$$100`" ——
   * **那句话在教用户写出设备显示错的文件**：App 侧就是 `tv.text = node.text`，
   * 它不认识 `$$`，于是平板上显示 `$$100` 而工具里显示 `$100`。
   *
   * 现在 `nodes[].text` **永远是字面值**，写什么显示什么。所以"这是字面 `$`"
   * 这件事**根本不需要任何操作** —— 文案要说的只是"想绑定变量才需要加条目"。
   *
   * @param roots    [{ list, path }]，path 是报错文案里的前缀（`nodes` / `pages[0].nodes`）
   * @param bindings 解析后的 bindings（判"这条引用有没有被声明"）
   * @param errors   硬错误（颜色/数值）
   * @param warnings 软警告（`text`）
   */
  function checkDollarInNodes(roots, bindings, errors, warnings) {
    roots.forEach(root => {
      walkNodes(root.list, root.path, (n, npath) => {
        const spec = bindings[n.id];
        window.BINDABLE_FIELD_PATHS.forEach(p => {
          const v = getFieldPath(n, p);
          // ⚠️ 两个字段类别用**同一条判据**（v2.80.2 起不再有 `text` 专用的转义判据）：
          // "字符串且以 `$` 开头" = 看起来像引用。区别只在**报的档位**。
          if (!window.isTokenRef(v)) return;
          if (spec && window.isTokenRef(spec[p])) return;   // 绑定里写了这条 → 正常状态
          if (p === "text") {
            // ⚠️ 文案要给出**出路**，而且**不许**再提 `$$`：
            // `text` 是字面值，用户什么都不用做就能显示 `$`；只有"想绑定"才需要动作。
            warnings.push(npath + ".text 是 `" + v + "`，看起来像变量引用，但 bindings 里没有这条 —— "
              + "如果这是要**显示的字面内容**，不用管这条（文件照常打开，就按 `" + v + "` 显示）；"
              + "如果是要**绑定变量**，请给这个节点加 bindings 条目（`\"text\": \"" + v + "\"`）。");
            return;
          }
          errors.push(npath + "." + p + " 是 `" + v + "`，但 bindings 里没有这条 —— "
            + "引用不能写在 nodes 里（nodes 是编译产物，必须是字面值）");
        });
      });
    });
  }

  /**
   * **漂移检测**（§5）：`nodes` 里的实际值与 bindings 推出来的值不一致 → **警告**。
   *
   * > 为什么只算警告：手改 JSON 是合法用法（本工具的定位就是"JSON 能直接改"）。
   * > 只是这种改法会被 bindings 覆盖 —— 所以要**报出来**，让用户知道自己的改动去哪了。
   *
   * 字段在 nodes 里**不存在**时不报：那只是"还没写过值"，不是漂移。
   *
   * ⚠️ 直接比**字面值**。v2.80.1 这里比的是"显示值"（`text` 上的 `$$` 先解开）——
   * v2.80.2 取消转义之后 `text` 就是字面值，那一层间接没有了
   *（少一个"两处规则要对齐"的地方）。
   */
  function checkDrift(roots, bindings, st, warnings) {
    Object.keys(bindings).forEach(nid => {
      const spec = bindings[nid];
      roots.forEach(root => {
        walkNodes(root.list, root.path, (n, npath) => {
          if (n.id !== nid) return;
          Object.keys(spec).forEach(p => {
            const ref = spec[p];
            const t = st.byId[window.tokenRefName(ref)] || st.byName[window.tokenRefName(ref)];
            if (!t) return;                       // 变量不存在：已经报过硬错误了
            const field = window.bindableField(p);
            const want = window.coerceTokenValue(field.type, st.cur[t.id]);
            if (want === undefined) return;       // 变量没值：解析时也跳过，不算漂移
            const raw = getFieldPath(n, p);
            if (raw === undefined) return;        // 还没写过值
            if (raw === want) return;
            warnings.push(n.id + " 的 " + p + " 在 nodes 里是 " + trimNum(raw)
              + "，但 bindings 指向 " + ref + "（= " + trimNum(want) + "）。已按 bindings 重建。");
          });
        });
      });
    });
  }

  /** 深度优先遍历节点树（含子树），带上报错用的字段路径 */
  function walkNodes(list, prefix, fn) {
    if (!Array.isArray(list)) return;
    list.forEach((n, i) => {
      if (n === null || typeof n !== "object") return;
      fn(n, prefix + "[" + i + "]");
      walkNodes(n.children, prefix + "[" + i + "].children", fn);
    });
  }

  /** 读字段路径的值（`card.radius`）；中间层不是对象就返回 undefined */
  function getFieldPath(node, path) {
    const i = path.indexOf(".");
    if (i < 0) return node[path];
    const head = node[path.slice(0, i)];
    return (head && typeof head === "object") ? head[path.slice(i + 1)] : undefined;
  }

  // ================================================================ 布局自检

  /**
   * 根节点的越界检查。
   *
   * ⚠️ **只查根节点** —— 子节点的 x/y 相对父节点，溢出父级是正常设计
   * （比如指针故意伸出表盘）。v1 没有层级，所以那时候查所有；v2 必须只查根。
   */
  function checkRootBounds(design, warnings) {
    const W = CANVAS, H = CANVAS;
    sortByZ(design.nodes).forEach(n => {
      if (n.x < 0 || n.y < 0) {
        warnings.push("根节点「" + n.name + "」坐标为负：x=" + trimNum(n.x) + " y=" + trimNum(n.y) +
          "，会被画到屏幕外");
      }
      if (n.x + n.w > W + 1 || n.y + n.h > H + 1) {
        warnings.push("根节点「" + n.name + "」超出画布右下角：右=" + trimNum(n.x + n.w) +
          " 下=" + trimNum(n.y + n.h) + "（上限 " + W + "）");
      }
    });
  }
  window.checkRootBounds = checkRootBounds;

  /** 完整校验：解析 + 根节点越界检查 */
  function validateText(text) {
    const r = parseDesign(text);
    if (r.design) checkRootBounds(r.design, r.warnings);
    return r;
  }
  window.validateText = validateText;
})();
