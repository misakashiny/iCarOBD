/* ==========================================================================
   js/ui/catalog-panel.js —— 控件库新界面（P2B 第三部分）
   ==========================================================================

   ## 设计原则

   **增量，不替换。** 现有 `#assets`（控件与素材混合面板）与 `#tree` 保持原样，
   它们的拖拽/选中/分类逻辑一行都不动。本文件新增一个**独立入口**，
   用 Catalog 的三分类（控件 / 预设 / 素材）呈现同一个 215 条库。

   ## 为什么这样做

   P2B 第六部分禁止「直接删除 BUILTIN_CONTROLS」「一次性迁移全部控件」。
   而现有 `renderAssets()` 有 193 行、含拼音搜索、分类折叠、素材新建/排序/恢复等
   成熟逻辑 —— **重写它风险远大于收益**。
   所以：新界面只做**读取与呈现**，拖拽复用现有 `addNodeFromControl` 等既有函数。

   ## 三个入口

   | 入口 | 内容 | 判定依据 |
   |---|---|---|
   | 控件 | 功能控件（能显示数据/有明确功能） | `kind === "control"` |
   | 预设 | 外观预设、组合仪表、文字样式 | `kind === "preset"` |
   | 素材 | 背景/刻度/指针/图标/装饰等静态图 | `kind === "asset"` |

   ## 与旧面板的关系

   新面板是**同一份数据的另一种视图**，不是迁移后的替代品。
   两个面板可以同时存在；用户用哪个都行。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("catalog-panel.js 必须在 core/namespace.js 之后加载");

  /** 当前选中的入口：control | preset | asset */
  let activeTab = "control";
  /** 搜索词 */
  let query = "";
  /** 折叠状态（分类名 → 是否折叠） */
  const collapsed = new Set();

  /** 徽标：优先用 P2B.1 的 vehicleStatus 三态；旧条目回落到 vehicleAvailability */
  const VS_BADGE = {
    "supported":     { text: "已验证", cls: "vb-l1", title: "通道与车辆可用性均已验证。" },
    "unverified":    { text: "待验证", cls: "vb-l3", title: "数据通道存在（或未确认），但这辆车是否真有该数据尚未验证。" },
    "unsupported":   { text: "App 未实现", cls: "vb-l4", title: "App 侧没有这条数据源，动态绑定无法生效。历史设计与拖拽能力保留。" },
  };
  /** 复合控件：标示它由多个子控件组成 */
  const COMPOSITE_BADGE = { text: "组合", cls: "vb-l2", title: "由多个子控件组成，数据绑定在子控件上。" };

  /** 旧四层文案（保留兼容，仅当 vehicleStatus 缺失时使用） */
  const VEHICLE_BADGE = {
    "implemented":   { text: "App 已实现", cls: "vb-l1", title: "App 侧有这条数据通道。⚠️ 不代表这辆车一定提供该数据。" },
    "alias-only":    { text: "仅别名/模板", cls: "vb-l2", title: "只有别名或厂家模板，没有完整实现，可能取不到值。" },
    "unverified":    { text: "待验证", cls: "vb-l3", title: "数据能力存在，但这辆车是否真有该数据尚未验证。" },
    "unimplemented": { text: "App 未实现", cls: "vb-l4", title: "App 侧没有这条数据源，动态绑定无法生效。历史设计与拖拽能力保留。" },
    "n/a":           { text: "", cls: "", title: "" },
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** 拼音/原文混合匹配（复用 pinyin.js；没有就退化到包含判断） */
  function matchText(text, q) {
    if (!q) return true;
    const s = String(text).toLowerCase();
    if (s.indexOf(q) >= 0) return true;
    return typeof window.matchPinyin === "function" ? window.matchPinyin(String(text), q) : false;
  }

  /** 从 Catalog 取当前 tab 的条目 */
  function itemsOf(cat, tab) {
    const KIND = ICAR.registry.Catalog.KIND;
    let list;
    if (tab === "control") list = cat.byKind(KIND.CONTROL);
    else if (tab === "preset") list = cat.byKind(KIND.PRESET);
    else list = cat.byKind(KIND.ASSET);
    if (!query) return list;
    return list.filter(function (e) {
      if (matchText(e.name, query) || matchText(e.key, query)) return true;
      // 标签也参与搜索（可直接搜 statePid:std_05 / style:3 这种）
      return (e.tags || []).some(function (t) { return matchText(t, query); });
    });
  }

  /** 按分类分组（保持稳定的显示顺序） */
  function groupOf(list) {
    const m = new Map();
    list.forEach(function (e) {
      if (!m.has(e.category)) m.set(e.category, []);
      m.get(e.category).push(e);
    });
    const order = [
      "仪表", "文字", "状态指示", "轨道", "容器与组合",
      "预设·仪表外观", "预设·组合控件",
      "素材·盘面", "素材·背景", "素材·刻度", "素材·指针",
      "素材·数字", "素材·单位", "素材·图标", "素材·装饰",
      "素材·警示", "素材·轨道图", "素材·新库底板",
      "素材·其他", "其他与组合", "其他",
    ];
    return Array.from(m.entries()).sort(function (a, b) {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  /** 缩略图：素材类用真实图片；其余用类型图标 */
  function thumbOf(e) {
    if (e.kind === "asset" && e.__meta && e.__meta.assetId) {
      const src = typeof window.assetBitmapUrl === "function"
        ? window.assetBitmapUrl(e.__meta.assetId)
        : null;
      if (src) return '<img class="cpThumbImg" src="' + esc(src) + '" alt="">';
      // 退化：用 assetId 打一个占位块，不假装有图
      return '<span class="cpThumbPh">▨</span>';
    }
    const R = ICAR.registry.Catalog.RENDERER;
    const icon = e.renderer === R.GAUGE ? "◉"
      : e.renderer === R.TEXT ? "T"
      : e.renderer === R.TRACK ? "▬"
      : e.renderer === R.STATE_IMAGE ? "⚠"
      : e.renderer === R.COMPOSITE ? "❏"
      : e.renderer === R.GROUP ? "▢" : "▣";
    return '<span class="cpThumbPh">' + icon + "</span>";
  }

  /** 可用性徽标（只在有数据能力的条目上显示） */
  function badgeOf(e) {
    // 组合控件单独标（它们的绑定在子节点上，不该按根节点判"无数据/不可用"）
    if (e.dataCapability === "composite") {
      const t = (e.__meta && e.__meta.childChannels && e.__meta.childChannels.length)
        ? "组合 · 子通道：" + e.__meta.childChannels.join(", ")
        : "组合控件";
      return '<span class="cpBadge ' + COMPOSITE_BADGE.cls + '" title="' + esc(t) + '">' +
        esc(COMPOSITE_BADGE.text) + "</span>";
    }
    const b = (e.vehicleStatus && VS_BADGE[e.vehicleStatus]) || VEHICLE_BADGE[e.vehicleAvailability];
    if (!b || !b.text) return "";
    return '<span class="cpBadge ' + b.cls + '" title="' + esc(b.title) + '">' + esc(b.text) + "</span>";
  }

  /** 单个条目卡片 */
  function itemHtml(e) {
    const l4 = (e.vehicleStatus === "unsupported") || (e.vehicleAvailability === "unimplemented");
    return '<div class="cpItem' + (l4 ? " cpItemL4" : "") + '"' +
      ' data-key="' + esc(e.key) + '"' +
      ' title="' + esc(e.name + " · " + e.key + (l4 ? "（App 未实现数据源，动态绑定无法生效）" : "")) + '"' +
      ' ondblclick="ICAR.ui.CatalogPanel.addToCanvas(\'' + esc(e.key) + '\')">' +
      '<span class="cpThumb">' + thumbOf(e) + "</span>" +
      '<span class="cpMeta"><span class="cpName">' + esc(e.name) + "</span>" +
      '<span class="cpKey">' + esc(e.key) + "</span></span>" +
      badgeOf(e) +
      "</div>";
  }

  /** 渲染整个面板 */
  function render() {
    const box = document.getElementById("catalog");
    if (!box) return;
    const C = ICAR.registry.Catalog;
    const st = C.stats();

    if (!st || !st.total) {
      box.innerHTML = '<div class="cpErr">' +
        "<b>控件目录未初始化</b><br>" +
        "可能原因：编辑器尚未完成初始化，或初始化超时。<br>" +
        '<button class="mini" onclick="ICAR.registry.Catalog.recover();ICAR.ui.CatalogPanel.render()">重试</button>' +
        "</div>";
      return;
    }

    const counts = {
      control: (st.byKind && st.byKind.control) || 0,
      preset: (st.byKind && st.byKind.preset) || 0,
      asset: (st.byKind && st.byKind.asset) || 0,
    };

    const diag = C.diagnose ? C.diagnose() : null;
    let h = '<div class="panelBar">' +
      '<span class="pbTitle">资源库</span>' +
      '<span class="pbCount">' + st.total + "</span>" +
      // 迁移进度：声明 / 探测（P2B.1 便于观察 P3 进展）
      (st.bySource ? '<span class="cpSrc" title="已静态声明 / 仍走探测">' +
        (st.bySource.declared || 0) + "/" + st.total + "</span>" : "") +
      '<span class="pbBtn" title="展开/折叠经典视图（旧的控件与素材混合面板）"' +
      ' onclick="ICAR.ui.CatalogPanel.toggleLegacy()">\u25a4</span>' +
      "</div>";
    if (diag && !diag.ok) {
      h += '<div class="cpErr">' + diag.issues.map(function (i) { return esc(i.message); }).join("<br>") +
        '<button class="mini" onclick="ICAR.registry.Catalog.recover();ICAR.ui.CatalogPanel.render()">重试</button></div>';
    }

    // ---- 三个主入口
    h += '<div class="cpTabs">';
    [["control", "控件"], ["preset", "预设"], ["asset", "素材"]].forEach(function (t) {
      h += '<button class="cpTab' + (activeTab === t[0] ? " on" : "") + '" data-tab="' + t[0] + '"' +
        ' onclick="ICAR.ui.CatalogPanel.setTab(\'' + t[0] + '\')">' +
        t[1] + '<span class="cpTabN">' + counts[t[0]] + "</span></button>";
    });
    h += "</div>";

    // ---- 搜索
    h += '<div class="cpSearch"><input id="cpSearchInput" type="search" placeholder="搜索名称 / key / 标签（支持拼音）"' +
      ' value="' + esc(query) + '" oninput="ICAR.ui.CatalogPanel.setQuery(this.value)"></div>';

    // ---- 列表
    const list = itemsOf(C, activeTab);
    if (!list.length) {
      h += '<div class="cpEmpty">没有匹配的条目' + (query ? "（搜索：" + esc(query) + "）" : "") + "</div>";
    } else {
      const groups = groupOf(list);
      h += '<div class="cpBody">';
      groups.forEach(function (g) {
        const cat = g[0], arr = g[1];
        const isCol = collapsed.has(cat);
        h += '<div class="cpCat">' +
          '<span class="cpCatHead" onclick="ICAR.ui.CatalogPanel.toggleCat(\'' + esc(cat) + '\')">' +
          '<span class="cpCaret">' + (isCol ? "▸" : "▾") + "</span>" +
          esc(cat) + '<span class="cpCatN">' + arr.length + "</span></span>" +
          "<div class=\"cpGrid\" data-cat=\"" + esc(cat) + "\" style=\"" + (isCol ? "display:none" : "") + "\">" +
          arr.map(itemHtml).join("") +
          "</div></div>";
      });
      h += "</div>";
    }

    box.innerHTML = h;
    bindDrag();
  }

  /**
   * 拖拽接线：复用现有拖放逻辑。
   *
   * ⚠️ 不自己实现拖拽 —— 现有 `#assets` 里的拖拽已经有一整套 snap/撤销/多层处理，
   * 重写必然出现两套行为。这里只设置 `dataTransfer`，落到画布时交给既有代码。
   */
function bindDrag() {
    const box = document.getElementById("catalog");
    if (!box) return;
    box.querySelectorAll(".cpItem").forEach(function (el) {
      el.setAttribute("draggable", "true");
      el.addEventListener("dragstart", function (ev) {
        const key = el.getAttribute("data-key");
        const e = ICAR.registry.Catalog.get(key);
        // P2B.1：必须用画布 drop 处理器认识的真实 MIME（panels.js:1992-2005）：
        //   application/x-ctrl  -> 控件（会调 c.make() 后 dropControlAt）
        //   application/x-asset -> 素材（会调 addImageNode(assetId)）
        // 之前用的 "text/control-key" 画布根本不认 —— 拖了没反应。
        if (e && e.kind === "asset") {
          const aid = (e.__meta && e.__meta.assetId) || "";
          if (aid) ev.dataTransfer.setData("application/x-asset", aid);
          else ev.dataTransfer.setData("application/x-ctrl", key);
        } else {
          ev.dataTransfer.setData("application/x-ctrl", key);
        }
        ev.dataTransfer.setData("text/plain", key);
        ev.dataTransfer.effectAllowed = "copy";
        el.classList.add("cpDragging");
      });
      el.addEventListener("dragend", function () { el.classList.remove("cpDragging"); });
    });
  }
  /**
   * **旧面板折叠控制**（P2B.1 第四部分）。
   *
   * 问题：新 #catalog 与旧 #assets 都是资源列表，同时展开等于给用户两份重复内容。
   * 方案：新面板成为主入口；旧面板**默认折叠**，但保留一个明确的"经典视图"开关，
   *       随时可展开（不是删除，也不是隐藏到找不到）。
   *
   * 实现：复用旧面板已有的 panelCollapsed 机制，**不改旧面板的渲染代码**。
   */
  function collapseLegacyAssets() {
    try {
      if (typeof window.panelCollapsed === "object" && window.panelCollapsed) {
        if (!window.panelCollapsed.assets) {
          window.panelCollapsed.assets = true;
          if (typeof window.renderAssets === "function") window.renderAssets();
        }
        return true;
      }
    } catch (e) { /* 忽略：旧面板不存在时不影响新面板 */ }
    return false;
  }

  /** 切换旧面板的展开/折叠（给按钮用） */
  function toggleLegacyAssets() {
    try {
      if (typeof window.togglePanelCollapse === "function") { window.togglePanelCollapse("assets"); return true; }
    } catch (e) { /* 忽略 */ }
    return false;
  }
  const CatalogPanel = {
    /** 渲染（幂等，可重复调用） */
    render: render,

    setTab(tab) {
      if (["control", "preset", "asset"].indexOf(tab) < 0) return;
      activeTab = tab;
      render();
    },

    setQuery(q) {
      query = String(q || "").trim().toLowerCase();
      render();
      // 重新渲染会丢焦点，这里恢复
      const inp = document.getElementById("cpSearchInput");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    },

    toggleCat(cat) {
      if (collapsed.has(cat)) collapsed.delete(cat);
      else collapsed.add(cat);
      render();
    },

    activeTab() { return activeTab; },
    query() { return query; },

    /**
     * 双击添加：复用现有 `#assets` 的添加路径。
     *
     * 查找顺序（都失败才报错，不静默）：
     *   1. `window.addControlKey`（若存在）
     *   2. 退化为调用该条目的 `make()` + `window.addNode`（若存在）
     */
    /**
     * 双击/点击添加。
     *
     * ⚠️⚠️ **P4A 修的一个重要 bug**：原实现调 `window.addNode(node)`（1 个参数），
     * 而 `model.js` 的签名是 `addNode(nodes, node, parentId)`（3 个参数）。
     * 于是 `nodes` 拿到的是节点对象、`node` 是 undefined → `nodes.push(undefined)`
     * 抛错 → 被 catch 吞掉 → **静默返回 false，什么也没添加**。
     *
     * 之所以长期没被发现：P2B 的端到端测试只覆盖了**拖拽**（drop 事件），
     * 没测双击/点击添加。
     *
     * 现在的做法：**统一走"插入适配层"**，三个入口
     * （双击 / 点击 / 拖拽）共用同一套语义。
     */
    addToCanvas(key) {
      const entry = (window.BUILTIN_CONTROLS || []).find(function (c) { return c.key === key; });
      if (!entry) { if (window.toast) window.toast("找不到控件：" + key); return false; }
      try {
        return ICAR.ui.insertControl(key, { source: "catalog" }) !== null;
      } catch (e) {
        if (window.toast) window.toast("添加失败：" + e.message);
        return false;
      }
    },

    /** 折叠旧面板（新面板成为主入口） */
    collapseLegacy: collapseLegacyAssets,
    /** 切换旧面板展开/折叠 */
    toggleLegacy: toggleLegacyAssets,

    /** 测试用：导出当前视图状态 */
    __state() {
      return { activeTab: activeTab, query: query, collapsed: Array.from(collapsed) };
    },
  };

  if (!ICAR.ui) ICAR.ui = {};
  ICAR.ui.CatalogPanel = CatalogPanel;
  if (window.CatalogPanel === undefined) window.CatalogPanel = CatalogPanel;
})();
