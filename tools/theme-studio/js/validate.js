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
      node.statePid = typeof o.statePid === "string" ? o.statePid : "";
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
      const a = Number(o.alpha);
      if (!Number.isFinite(a)) {
        warnings.push(path + ".alpha = " + trimNum(o.alpha) + " 不是数字 —— 已忽略");
      } else {
        if (a < 0 || a > 255) warnings.push(path + ".alpha = " + trimNum(a) + " 超出 0..255 —— 已夹住");
        out.alpha = Math.max(0, Math.min(255, Math.round(a)));
      }
    }
    if (o.radius !== undefined) {
      const r = Number(o.radius);
      if (!Number.isFinite(r)) {
        warnings.push(path + ".radius = " + trimNum(o.radius) + " 不是数字 —— 已忽略");
      } else {
        if (r < 0) warnings.push(path + ".radius = " + trimNum(r) + " 为负 —— 已夹到 0");
        out.radius = Math.max(0, Math.min(120, r));
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
        blinkMs: Math.max(60, Math.round(num(v.blinkMs, 200))),
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
