/* ==========================================================================
   app.js —— 装配与启动
   --------------------------------------------------------------------------
   职责：
     - 全局状态（design / selection / snap / 模拟）
     - 撤销集成：所有改动走 window.commit()，自动压栈 + 刷新
     - 文件读写（打开 / 保存 v2 / 导出 v1）
     - 校验结果显示
     - JSON 双向同步
     - 实时数据模拟
   ========================================================================== */
"use strict";

(function () {
  const S = window.CanvasState;
  const undo = new window.UndoStack(100);
  let batch = null;          // {label, depth} —— 批量改动只压一次栈
  let suppressJsonSync = false;

  function el(id) { return document.getElementById(id); }

  // ================================================================ 撤销集成

  /** 当前状态快照（只序列化设计本身，不含界面状态） */
  function snapshot() {
    return JSON.stringify({
      d: S.design,
      sel: S.selection,
    });
  }

  /**
   * 从快照恢复。**返回是否成功** —— 调用方要据此决定提示什么。
   *
   * 为什么要防御（v2.37.0）：撤销栈会**持久化到 localStorage**，
   * 而那里的内容可能被截断或写坏（配额、隐私模式、外部改动）。
   * 原来这里裸调 `JSON.parse` —— 一坏就抛，**撤销按钮静默失灵**：
   * 点了没反应、没有 toast、界面上什么都没有，只有 console 里一行红字。
   *
   * "静默失灵"是这类问题里最糟的形态：用户会以为是"撤销坏了"，
   * 而不是"这一条记录坏了"。
   */
  function restore(snap) {
    let o = null;
    try {
      o = JSON.parse(snap);
    } catch (e) {
      return false;                 // 快照本身不是合法 JSON
    }
    // 结构也得像样 —— 合法 JSON 不等于"是一份快照"
    if (!o || typeof o !== "object" || !o.d || typeof o.d !== "object") return false;
    S.design = o.d;
    S.selection = o.sel || [];
    setJsonDirty(false);          // 撤销/重做整体替换设计，文本域跟着走
    suppressJsonSync = true;
    syncJson();
    suppressJsonSync = false;
    refreshAll();
    // ⚠️ 必须刷新撤销按钮 —— 第一版漏了这句，撤销后计数一直是旧值
    // （实测：连按撤销，界面上的"100 / 100"纹丝不动，看着像撤销没生效）
    updateUndoButtons();
    return true;
  }

  /**
   * **所有改动都必须走这里** —— 它负责压栈、刷新界面、同步 JSON。
   *
   * @param fn           改动函数（直接改 S.design）
   * @param label        撤销菜单里显示的名字
   * @param coalesceKey  同一个 key 的连续改动会合并成一步（拖动/滑块用）
   */
  /**
   * 撤销栈持久化（v2.7.0）。
   *
   * 原来栈只在内存里 —— **刷新页面就全丢**，改了半天的设计一刷新没法回退。
   *
   * ## 为什么只存最近 N 步
   * 每步是一个设计快照（几十 KB），localStorage 通常只有 5 MB。
   * 存 20 步够用，再多就会**静默写失败**（QuotaExceededError），
   * 那比"只能退 20 步"糟糕得多。
   */
  const UNDO_KEY = "icar-studio-undo";
  /** 步数硬上限（再多也没人退那么远） */
  const UNDO_MAX = 40;
  /** 字节预算。localStorage 通常 5 MB，留足余量给别的键 */
  const UNDO_BUDGET = 1200 * 1024;

  /**
   * 存撤销栈。
   *
   * ## 为什么是"按字节"而不是"按步数"
   * 步数上限写死成 20 是拍脑袋的：一个只有 3 个控件的设计和 200 个控件的设计，
   * 单步快照能差两个数量级。所以**从最新往回留，直到超出字节预算为止**，
   * 步数上限只作为兜底（防止快照极小但步数极多）。
   *
   * 实测：20 步 × 200 控件的设计 ≈ 1.2 MB —— 正好卡在预算线上。
   */
  function saveUndoStack() {
    if (!undo) return;
    try {
      const name = S.design ? S.design.name : "";
      const out = [];
      let bytes = 0;
      // 从栈顶往回走，装得下就留
      for (let i = undo.index; i >= 0 && out.length < UNDO_MAX; i--) {
        const entry = undo.stack[i];
        const one = JSON.stringify(entry);
        // +2 是数组的逗号与括号
        if (bytes + one.length + 2 > UNDO_BUDGET && out.length > 0) break;
        out.unshift(entry);
        bytes += one.length + 2;
      }
      if (!out.length) return;
      const payload = { stack: out, index: out.length - 1, designName: name };
      localStorage.setItem(UNDO_KEY, JSON.stringify(payload));
    } catch (e) {
      // 配额满了不是致命错误 —— 只是这次没存上。**不要**弹窗打断用户。
      // 顺手清掉旧数据：留着只会让下一次也失败
      try { localStorage.removeItem(UNDO_KEY); } catch (e2) {}
      console.warn("撤销栈持久化失败（多半是 localStorage 配额），已清掉旧数据：", e.message);
    }
  }

  /** 启动时恢复撤销栈。**只在设计名一致时恢复** —— 否则会"撤销"到别的设计去 */
  function loadUndoStack() {
    try {
      const raw = localStorage.getItem(UNDO_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.stack) || !o.stack.length) return null;
      if (!S.design || o.designName !== S.design.name) return null;
      // ⚠️ **丢掉坏的条目**（v2.37.0）。
      //
      // 只判断"是不是数组"不够 —— 里面的 `state` 可能是被截断的字符串。
      // 不在这里滤掉的话，坏的那条会一直躺在栈里，**每次撤销到它都要再撞一次**
      // （`restore` 会返回 false，用户看到"这一步的记录坏了"，但下次还是会撞）。
      //
      // 在**加载时**一次清干净，比每次运行时分摊处理更简单，也更诚实：
      // 那些条目本来就是坏的，留着没有任何价值。
      const good = o.stack.filter(function (it) {
        if (!it || typeof it.state !== "string") return false;
        try { JSON.parse(it.state); return true; } catch (e) { return false; }
      });
      if (good.length !== o.stack.length) {
        console.warn("撤销栈里有 " + (o.stack.length - good.length) + " 条坏记录，已丢弃");
      }
      if (!good.length) return null;
      o.stack = good;
      return o;
    } catch (e) { return null; }
  }
  window.loadUndoStack = loadUndoStack;
  window.saveUndoStack = saveUndoStack;

  window.commit = function (fn, label, coalesceKey) {
    fn();
    undo.push(snapshot(), label, batch ? batch.label : coalesceKey);
    // 每步都持久化。拖动时 commit 很频繁，但 saveUndoStack 只写**最近 20 步**
    // 且用 try/catch 兜住配额，所以不需要额外节流。
    saveUndoStack();
    if (!batch) {
      syncJson();
      refreshAll();
      updateUndoButtons();
    } else {
      updateUndoButtons();
    }
  };

  /** 批量改动：一段操作只压一次栈（比如导入多个素材） */
  window.beginBatch = function (label) {
    if (batch) { batch.depth++; return; }
    batch = { label: label || "批量改动", depth: 1 };
    undo.push(snapshot(), batch.label);
  };
  window.endBatch = function () {
    if (!batch) return;
    batch.depth--;
    if (batch.depth <= 0) {
      batch = null;
        saveUndoStack();
      syncJson();
      refreshAll();
      updateUndoButtons();
    }
  };

  function updateUndoButtons() {
    const u = el("btnUndo"), r = el("btnRedo");
    if (u) {
      u.disabled = !undo.canUndo();
      u.title = undo.canUndo() ? "撤销（Ctrl+Z）—— 可退 " + undo.depth() + " 步" : "没有可撤销的操作";
    }
    if (r) {
      r.disabled = !undo.canRedo();
      // ⚠️ 这个按钮的**文案是「返回」但功能是重做**（用户要求改的文案）。
      // 所以 tooltip 必须把功能说清楚，否则光看字面会以为是"上一步"。
      r.title = undo.canRedo()
        ? "重做（Ctrl+Y）—— 把刚撤销的操作再做一遍"
        : "没有可重做的操作";
    }
    const c = el("undoCount");
    if (c) c.textContent = undo.depth() + " / " + (undo.size() - 1);
  }

  // 测试钩子（v2.37.0）。和 `window.loadUndoStack` / `window.saveUndoStack`
  // 同一个理由：**"坏数据不能让撤销静默失灵"这件事必须能被测**，
  // 而 `restore` 在闭包里，从外面碰不到。
  window.restoreSnapshot = restore;

  window.doUndo = function () {
    const r = undo.undo();
    if (!r) return;
    // 快照坏了要说出来 —— 不能"点了没反应"（v2.37.0）
    if (!restore(r.state)) { toast("这一步的记录坏了，已跳过：" + r.label); return; }
    toast("已撤销：" + r.label);
  };
  window.doRedo = function () {
    const r = undo.redo();
    if (!r) return;
    if (!restore(r.state)) { toast("这一步的记录坏了，已跳过：" + r.label); return; }
    toast("已重做：" + r.label);
  };

  // ================================================================ 多页面（页签）

  /**
   * 渲染页签条。
   *
   * **只有一页时也显示** —— 否则用户根本发现不了"能加页"。
   * 但单页时不显示删除按钮（删不了）。
   */
  function renderPageTabs() {
    const box = el("pageTabs");
    if (!box || !S.design) return;
    const pages = S.design.pages || [];
    const cur = S.design.pageIndex || 0;
    let h = "";
    pages.forEach((pg, i) => {
      h += '<span class="pgTab' + (i === cur ? " pgCur" : "") + '"' +
        ' onclick="switchToPage(' + i + ')"' +
        ' ondblclick="renamePage(' + i + ')"' +
        ' title="' + window.esc(pg.name) + '（双击重命名）">' +
        window.esc(pg.name) +
        (pages.length > 1
          ? '<span class="pgDel" onclick="event.stopPropagation();delPage(' + i + ')" title="删除这一页">✕</span>'
          : "") +
        '</span>';
    });
    h += '<span class="pgAdd" onclick="addNewPage()" title="新建一页">＋</span>';
    h += '<span class="pgHint">' + pages.length + ' 页 · 每页有各自的一组控件</span>';
    box.innerHTML = h;
  }
  window.renderPageTabs = renderPageTabs;

  /**
   * 切到第 i 页。
   *
   * **必须先压一次撤销栈**：`design.nodes` 会换成另一页的数组，
   * 如果不记这一步，用户切页后按撤销会"撤销到上一页的改动"，
   * 而画布看起来没变 —— 非常困惑。
   */
  window.switchToPage = function (i) {
    if (!S.design) return;
    const from = S.design.pageIndex || 0;
    if (i === from) return;
    // 清掉选择：选中的节点 id 属于旧页，带到新页会指向不存在的东西
    S.selection = [];
    S.drillPath = [];
    window.commit(() => {
      window.switchPage(S.design, i);
    }, "切到「" + (S.design.pages[i] || {}).name + "」");
    if (window.updateBreadcrumb) window.updateBreadcrumb();
    window.toast("已切到「" + (S.design.pages[i] || {}).name + "」");
  };

  window.addNewPage = function () {
    if (!S.design) return;
    const name = prompt("新页面的名字", "页面 " + ((S.design.pages || []).length + 1));
    if (name === null) return;
    let idx = -1;
    window.commit(() => {
      idx = window.addPage(S.design, (name || "").trim() || undefined);
    }, "新建页面：" + name);
    if (idx >= 0) window.switchToPage(idx);
    window.toast("已新建「" + (S.design.pages[idx] || {}).name + "」");
  };

  window.delPage = function (i) {
    if (!S.design) return;
    const pages = S.design.pages || [];
    if (pages.length <= 1) { window.toast("只剩一页了，删不了"); return; }
    const pg = pages[i];
    const n = window.flatten(pg.nodes).length;
    if (!confirm("删除页面「" + pg.name + "」？\n这一页上有 " + n + " 个控件，会一起删掉。\n（可以用撤销找回来）")) return;
    window.commit(() => {
      window.removePage(S.design, i);
    }, "删除页面：" + pg.name);
    S.selection = [];
    S.drillPath = [];
    window.toast("已删除「" + pg.name + "」");
  };

  window.renamePage = function (i) {
    if (!S.design) return;
    const pg = (S.design.pages || [])[i];
    if (!pg) return;
    const name = prompt("页面名字", pg.name);
    if (name === null) return;
    window.commit(() => { pg.name = (name || "").trim() || pg.name; }, "重命名页面");
  };

  function refreshAll() {
    // 画布绘制前同步素材位图 —— 内置素材只有 path，不挂上去画布会画大 X
    if (window.syncAssetImages) window.syncAssetImages();
    renderPageTabs();
    if (window.renderPanels) window.renderPanels();
    if (window.draw) window.draw();
  }
  window.refreshAll = refreshAll;

  window.onSelectionChanged = function () {
  // 换了选中对象 → 部件选择失效（v2.32.0）
  S.selectedPart = -1;
    if (window.renderTree) window.renderTree();
    if (window.renderProps) window.renderProps();
    if (window.draw) window.draw();
  };
  window.onNodeChanged = function () { };
  window.onDragEnd = function () {
    // 拖动结束：结束合并，并把最终状态压成一步
    undo.endCoalesce();
    syncJson();
    if (window.renderProps) window.renderProps();
    updateUndoButtons();
  };

  // ================================================================ 属性写入

  function sel() {
    if (S.selection.length !== 1) return null;
    return window.findNode(S.design.nodes, S.selection[0]);
  }

  /**
   * **等比缩放锁**开关（v2.21.0）。默认开。
   *
   * 关掉之后拖角手柄可以自由拉伸 —— 图片会变形，所以默认不开。
   * 想临时自由拉伸不用关它，**按住 Alt** 就行。
   */
  /**
   * **主题配色编辑器**（v2.31.0）。
   *
   * 只改**颜色**（12 个字段）—— 圆角、缓动、发光开关那些影响的是"手感"，
   * 混在一起做一个界面会让它变成一锅粥。
   *
   * 改动存进 `design.themeColorsOverride`（只存**差异**）：
   *   · 换主题时，只调过的那几个字段保留，其余跟着新主题走
   *   · 序列化时"内置主题打底 + 覆盖"，所以设计文件里始终是**完整**配色
   */
  window.openThemeColors = function () {
    const d = S.design;
    const base = window.GAUGE_THEMES[d.themeId] || window.GAUGE_THEMES.neon;
    const ov = d.themeColorsOverride || {};
    const rows = window.THEME_COLOR_FIELDS.map(function (f) {
      const val = ov[f.k] !== undefined ? ov[f.k] : base[f.k];
      const overridden = ov[f.k] !== undefined;
      return '<div class="tcRow">' +
        '<label>' + esc(f.n) + '</label>' +
        // ⚠️ 用 type=color 而不是文本框：用户不该被要求手打 #RRGGBB，
        // 而且色轮能直接看出"这个色偏暗还是偏亮"
        '<input type="color" value="' + esc(String(val).slice(0, 7)) + '"' +
        ' oninput="setThemeColor(\'' + f.k + '\',this.value)">' +
        '<span class="tcVal">' + esc(String(val)) + '</span>' +
        (overridden ? '<button class="mini" onclick="setThemeColor(\'' + f.k + '\',null)" title="恢复主题默认">↺</button>' : "") +
        "</div>";
    }).join("");
    const box = el("themeColorsBox");
    if (!box) return;
    box.innerHTML = '<div class="tcHead">当前主题：' + esc(base.title || d.themeId || "（未指定）") +
      '　<span class="hint inline">只改颜色；改动只存差异，换主题时没改过的会跟着新主题走</span></div>' +
      '<div class="tcGrid">' + rows + '</div>' +
      '<div class="tcFoot">' +
      '<button class="mini" onclick="resetThemeColors()">全部恢复主题默认</button>' +
      '</div>';
    const dlg = el("themeColorsDlg");
    if (dlg && dlg.showModal) dlg.showModal(); else if (dlg) dlg.setAttribute("open", "");
  };

  /** 改一个颜色（v = null 表示恢复主题默认） */
  window.setThemeColor = function (k, v) {
    const d = S.design;
    window.commit(function () {
      const ov = Object.assign({}, d.themeColorsOverride || {});
      if (v === null || v === undefined) delete ov[k];
      else ov[k] = String(v);
      d.themeColorsOverride = Object.keys(ov).length ? ov : null;
    }, "改主题色", "themeColor");   // 第三参是合并键：拖色轮会产生几十次，合成一步
    window.draw();
  };

  window.resetThemeColors = function () {
    window.commit(function () { S.design.themeColorsOverride = null; }, "恢复主题配色");
    window.openThemeColors();
    window.draw();
  };

  window.setAspectLock = function (on) {
    S.aspectLock = !!on;
    // 立刻落盘 —— 等下一个操作再存的话，用户关掉就关页面会丢（v2.26.0）
    if (window.savePanelState) window.savePanelState();
    window.renderProps();
    toast(on ? "等比缩放：开（按住 Alt 可临时自由拉伸）" : "等比缩放：关（可自由拉伸）");
  };

  /**
   * 把选中节点**恢复成素材的原始宽高比**。
   *
   * 保持**面积不变**（按当前 w 推出 h）—— 直接改成素材尺寸的话，
   * 用户精心调好的大小会被重置，那是另一种"我明明没让它变"的意外。
   */
  window.fitNodeAspect = function () {
    const n = sel();
    if (!n || n.type !== window.NODE_IMAGE || !n.assetId) return;
    const a = (S.design.assets || []).find(x => x.id === n.assetId);
    const nat = a ? window.naturalSizeOf(a, n.assetId) : null;
    if (!nat) { toast("这个素材没有记录原始尺寸"); return; }
    const ar = nat[0] / nat[1];
    window.commit(() => {
      n.h = Math.max(1, Math.round(n.w / ar * 100) / 100);
    }, "恢复素材比例");
    toast("已恢复素材比例（" + Math.round(n.w) + "×" + Math.round(n.h) + "）");
  };

  window.setNodeNum = function (k, v) {
    const n = sel(); if (!n) return;
    const num = Number(v);
    window.commit(() => {
      n[k] = Number.isFinite(num) ? num : 0;
      if (k === "w" || k === "h") n[k] = Math.max(1, n[k]);
      if (k === "scale") n[k] = Math.max(0.05, n[k]);
      if (k === "alpha") n[k] = Math.max(0, Math.min(255, Math.round(n[k])));
    }, "改 " + k, "num:" + k);
  };
  window.setNodeStr = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n[k] = String(v); }, "改 " + k, "str:" + k);
  };

  /**
   * 改字体字段。**文字控件改 `n.font`，仪表改 `n.labelFont`** ——
   * 同一个 UI，两个目标，靠节点类型决定改哪个。
   *
   * 为什么不让调用方传目标：属性面板与控件编辑器都只有"字体"这一组，
   * 让它们各自判断类型会重复；集中在这里只判断一次。
   */
  // ================================================================ 子部件

  /** 当前选中的仪表节点（部件只对仪表有意义） */
  function gaugeSel() {
    const n = sel();
    if (!n || n.type !== window.NODE_GAUGE) { window.toast("子部件只能加在仪表上"); return null; }
    return n;
  }
  function ensureParts(n) { if (!n.parts) n.parts = []; return n.parts; }

  window.togglePart = function (i) {
    collapsed["part:" + i] = !collapsed["part:" + i];
    saveCollapsed();
    window.renderPanels();
  };

  /**
   * 加一个部件。
   *
   * 默认尺寸取控件自身的 80% —— 直接给 120 的话，小表上会盖住整个表。
   */
  window.addPart = function () {
    const n = gaugeSel(); if (!n) return;
    window.commit(() => {
      ensureParts(n).push(window.normalizePart({
        kind: "dial",
        w: Math.round(n.w * 0.8), h: Math.round(n.h * 0.8),
        x: Math.round(n.w * 0.1), y: Math.round(n.h * 0.1),
      }));
    }, "加子部件");
    window.toast("已加部件 —— 记得选素材，否则这一层画不出来");
  };

  window.delPart = function (i) {
    const n = gaugeSel(); if (!n || !n.parts) return;
    window.commit(() => { n.parts.splice(i, 1); if (!n.parts.length) n.parts = null; }, "删子部件");
  };

  /**
   * 上移 / 下移一个部件。
   *
   * **数组顺序 = 绘制顺序**（先画的在下），所以"上移"= 画得更早 = 更靠下层。
   * 这一点和控件树的直觉相反，title 里写清楚了。
   */
  window.movePart = function (i, dir) {
    const n = gaugeSel(); if (!n || !n.parts) return;
    const j = i + dir;
    if (j < 0 || j >= n.parts.length) return;
    window.commit(() => {
      const a = n.parts[i];
      n.parts[i] = n.parts[j];
      n.parts[j] = a;
    }, dir < 0 ? "部件上移" : "部件下移");
  };

  window.setPart = function (i, k, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    window.commit(() => {
      const patch = {}; patch[k] = v;
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], patch));
    }, "改部件 " + k);
  };

  /**
   * 给指针部件绑一个 PID（多指针表）。
   *
   * 空串 = **跟随仪表节点自己的 PID**（单指针表的老行为，完全不变）。
   */
  /**
   * 给部件设一个**布尔**字段（v2.27.0，目前用于 `sweepFollow`）。
   *
   * ⚠️ 部件下标由面板在渲染时写进 `window.__partEditIndex` ——
   * `setPartPid` 是内联在 onclick 里带下标的，而这个勾选框走的是 onchange，
   * 下标没地方传。用一个"当前编辑目标"变量最省事，也确实够用（一次只编辑一个部件）。
   */
  window.setPartBool = function (k, v) {
    const n = gaugeSel();
    const i = window.__partEditIndex;
    if (!n || !n.parts || i === null || i === undefined || !n.parts[i]) return;
    const patch = {};
    patch[k] = !!v;
    window.commit(() => {
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], patch));
    }, "部件 " + k);
  };

  window.setPartPid = function (i, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    const raw = String(v || "").trim();
    window.commit(() => {
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], {
        rawPid: raw,
        pid: raw ? window.resolvePid(raw) : "",
      }));
    }, "部件绑定 PID");
  };

  window.setPartNum = function (i, k, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    const s = String(v).trim();
    const x = s === "" ? 0 : Number(s);
    if (!Number.isFinite(x)) return;
    window.commit(() => {
      const patch = {}; patch[k] = x;
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], patch));
    }, "改部件 " + k);
  };

  /** 一键把扫描范围设成经典表盘的 135° → 405°（即 -225° → 45°，扫过 270°） */
  window.setPartSweep = function (i, from, to) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    window.commit(() => {
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], { sweepFrom: from, sweepTo: to }));
    }, "部件扫描范围");
  };

  window.clearParts = function () {
    const n = gaugeSel(); if (!n || !n.parts) return;
    if (!confirm("清空全部子部件？\n清空后会回到用「样式」程序化绘制。")) return;
    window.commit(() => { n.parts = null; }, "清空子部件");
    window.toast("已清空 —— 回到样式画法");
  };

  /**
   * 状态阈值。**空串 = 清掉覆盖，回到"按 PID 库推断"** ——
   * 用一个空值表达"跟随默认"比让用户填一个魔法数字清楚得多。
   */
  window.setStateThreshold = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    window.commit(() => {
      if (s === "") { n[k] = null; return; }
      const x = Number(s);
      n[k] = Number.isFinite(x) ? x : null;
    }, "状态" + (k === "stateWarn" ? "警告" : "严重") + "阈值");
  };

  window.setNodeFont = function (k, v) {
    const n = sel(); if (!n) return;
    const key = n.type === window.NODE_TEXT ? "font" : "labelFont";
    const patch = {};
    patch[k] = v;
    window.commit(() => {
      n[key] = window.normalizeFont(Object.assign({}, n[key], patch));
    }, "改字体 " + k, "font:" + k);
  };

  /**
   * 底框覆盖的写入。
   *
   * `card` 只在**真的覆盖了**才有值 —— 全空就置 null，
   * 这样序列化时不会写出一个没意义的 `{}`。
   */
  function ensureCard(n) {
    if (!n.card) n.card = { show: true, alpha: null, radius: null };
    return n.card;
  }
  function tidyCard(n) {
    const c = n.card;
    if (!c) return;
    const hasShow = typeof c.show === "boolean" && c.show !== true;
    const hasAlpha = c.alpha !== null && c.alpha !== undefined;
    const hasRadius = c.radius !== null && c.radius !== undefined;
    if (!hasShow && !hasAlpha && !hasRadius) n.card = null;
  }
  window.setCardFlag = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { ensureCard(n)[k] = !!v; tidyCard(n); }, "底框 " + k, "card:" + k);
  };
  window.setCardNum = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    window.commit(() => {
      const c = ensureCard(n);
      if (s === "") { c[k] = null; }
      else {
        const x = Number(s);
        c[k] = Number.isFinite(x) ? Math.max(0, Math.min(k === "alpha" ? 255 : 120, Math.round(x))) : null;
      }
      tidyCard(n);
    }, "底框 " + k, "card:" + k);
  };
  window.resetCard = function () {
    const n = sel(); if (!n) return;
    window.commit(() => { n.card = null; }, "底框恢复跟随主题");
    window.toast("底框已恢复为跟随主题");
  };

  /** 仪表标签的显示开关（名字 / 量程） */
  window.setNodeFontFlag = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n[k] = !!v; }, (v ? "显示 " : "隐藏 ") + k);
  };
  window.setNodeBool = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n[k] = !!v; }, (v ? "开启 " : "关闭 ") + k);
  };
  window.setNodeNullable = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    const num = s === "" ? null : Number(s);
    window.commit(() => { n[k] = (num === null || !Number.isFinite(num)) ? null : num; },
      "改 " + k, "null:" + k);
  };
  window.setNodePid = function (v) {
    const n = sel(); if (!n) return;
    const raw = String(v || "").trim();
    window.commit(() => {
      n.rawPid = raw;
      n.pid = window.resolvePid(raw);
      const info = window.BUILTIN_PIDS[n.pid];
      if (info) {
        n.min = info.min; n.max = info.max;
        n.warnLow = info.warnLow === undefined ? null : info.warnLow;
        n.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
      }
    }, "改 PID");
  };
  /** 状态系统的驱动 PID：内部存**解析后的 id**，原样写法留在 rawStatePid（与 pid 一致） */
  window.setNodeStatePid = function (v) {
    const n = sel(); if (!n) return;
    const raw = String(v || "").trim();
    window.commit(() => {
      n.rawStatePid = raw;
      n.statePid = raw ? window.resolvePid(raw) : "";
    }, "改状态驱动 PID", "statepid");
  };

  window.setNodeCard = function (v) {    const n = sel(); if (!n) return;
    const i = Number(v);
    window.commit(() => { n.cardStyle = (!Number.isFinite(i) || i <= 0) ? null : i; }, "改卡片外框");
  };
  window.setNodeNeon = function (v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n.neonPreset = v || null; }, "改霓虹档位");
  };
  window.setNodeExtras = function (v) {
    const n = sel(); if (!n) return;
    window.commit(() => {
      n.extraPids = String(v).split(",").map(s => s.trim()).filter(Boolean);
    }, "改副参数", "extras");
  };
  window.applyPidDefaults = function () {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    const info = window.BUILTIN_PIDS[n.pid];
    if (!info) { alert("PID `" + n.pid + "` 不在内置库里，无法回填。请手动填量程。"); return; }
    window.commit(() => {
      n.min = info.min; n.max = info.max;
      n.warnLow = info.warnLow === undefined ? null : info.warnLow;
      n.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
    }, "回填量程");
  };

  window.toggleLock = function () {
    const n = sel(); if (!n) return;
    window.commit(() => { n.locked = !n.locked; }, n.locked ? "解锁" : "锁定");
  };
  window.toggleVisible = function () {
    const n = sel(); if (!n) return;
    window.commit(() => { n.visible = !n.visible; }, n.visible ? "隐藏" : "显示");
  };
  window.lockSel = function (v) {
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (n) n.locked = !!v;
      });
    }, v ? "全部锁定" : "全部解锁");
  };

  window.dupSelected = function () {
    if (!S.selection.length) return;
    const made = [];
    window.commit(() => {
      S.selection.forEach(id => {
        const c = window.duplicateNode(S.design.nodes, id);
        if (c) made.push(c.id);
      });
      S.selection = made;
    }, "复制控件");
  };

  window.delSelected = function () {
    if (!S.selection.length) return;
    const n = S.selection.length;
    window.commit(() => {
      window.removeNodes(S.design.nodes, S.selection);
      S.selection = [];
    }, "删除 " + n + " 个控件");
  };

  // ---- 打组 / 取消组合

  /** 把选中的控件打成一个分组。打完之后拖动分组 = 同时拖动全部子控件 */
  window.groupSelected = function () {
    // 先问"能不能"，再决定要不要提交 —— 否则失败也会往撤销栈里压一条空操作
    const chk = window.groupCheck(S.design.nodes, S.selection);
    if (!chk.ok) { toast(chk.reason); return; }
    let made = null;
    window.commit(() => {
      const r = window.groupNodes(S.design.nodes, S.selection, { name: "分组" });
      if (r.ok) { made = r.node; S.selection = [r.node.id]; }
    }, "打组");
    if (made) {
      toast("已打组（" + made.children.length + " 个控件）。拖动分组会一起移动；右键可「取消组合」");
    }
  };

  /** 取消组合：子控件回到分组的父级，视觉位置不变 */
  window.ungroupSelected = function () {
    const groups = S.selection.filter(id => window.isGroup(S.design.nodes, id));
    if (!groups.length) { toast("选中的不是分组（只有分组可以取消组合）"); return; }
    let total = 0;
    window.commit(() => {
      // ⚠️ 必须把**画布矩阵**传进去：组的旋转是在设备空间施加的，
      // 而画布矩阵在 stretch 模式下非等比 —— 在父空间直接转会偏（实测 23.7px）
      const C = window.nodeToCanvasMatrix();
      groups.forEach(id => {
        const r = window.ungroupNode(S.design.nodes, id, C);
        if (r.ok) total += r.count;
      });
      S.selection = [];
    }, "取消组合");
    toast("已取消组合，还原 " + total + " 个控件");
  };

  /** 图层命令：置顶 / 置底 / 上移 / 下移 */
  window.layerCmd = function (cmd) {
    if (!S.selection.length) return;
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (!n) return;
        const sibs = window.siblingsOf(S.design.nodes, id);
        if (cmd === "front") { window.bringToFront(S.design.nodes, id); }
        else if (cmd === "back") { window.sendToBack(S.design.nodes, id); }
        else if (cmd === "up" || cmd === "down") {
          // ⚠️ 先把同层 z **归一化**成 0..n-1，再交换相邻两个。
          //
          // 直接交换 z 是错的：预设/新建的节点 z 常常**全都一样**
          // （`1big4small` 预设里所有根节点都是 z=1），交换两个相等值等于没动 ——
          // 用户看到的就是"上移/下移点了没反应"。实测确认过。
          const sorted = window.sortByZ(sibs);
          sorted.forEach((x, k) => { x.z = k; });
          const i = sorted.findIndex(x => x.id === id);
          if (i < 0) return;
          const j = cmd === "up" ? i + 1 : i - 1;
          if (j >= 0 && j < sorted.length) {
            const t = sorted[i].z;
            sorted[i].z = sorted[j].z;
            sorted[j].z = t;
          }
        }
      });
    }, "图层：" + cmd);
  };

  // ---- 多选：对齐与分布

  function boundsOf(id) { return window.worldBounds(S.design.nodes, id); }

  window.alignSel = function (mode) {
    if (S.selection.length < 2) return;
    window.commit(() => {
      const bs = S.selection.map(id => ({ id: id, b: boundsOf(id) })).filter(x => x.b);
      if (!bs.length) return;
      const minX = Math.min(...bs.map(x => x.b.x));
      const maxX = Math.max(...bs.map(x => x.b.x + x.b.w));
      const minY = Math.min(...bs.map(x => x.b.y));
      const maxY = Math.max(...bs.map(x => x.b.y + x.b.h));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      bs.forEach(x => {
        const n = window.findNode(S.design.nodes, x.id);
        if (!n) return;
        if (mode === "left") n.x += minX - x.b.x;
        else if (mode === "right") n.x += maxX - (x.b.x + x.b.w);
        else if (mode === "hcenter") n.x += cx - (x.b.x + x.b.w / 2);
        else if (mode === "top") n.y += minY - x.b.y;
        else if (mode === "bottom") n.y += maxY - (x.b.y + x.b.h);
        else if (mode === "vcenter") n.y += cy - (x.b.y + x.b.h / 2);
      });
    }, "对齐：" + mode);
  };

  window.distributeSel = function (axis) {
    if (S.selection.length < 3) { toast("等距分布至少要选 3 个"); return; }
    window.commit(() => {
      const bs = S.selection.map(id => ({ id: id, b: boundsOf(id) })).filter(x => x.b);
      if (axis === "h") {
        bs.sort((p, q) => p.b.x - q.b.x);
        const first = bs[0].b, last = bs[bs.length - 1].b;
        const total = (last.x + last.w) - first.x;
        const used = bs.reduce((s, x) => s + x.b.w, 0);
        const gap = (total - used) / (bs.length - 1);
        let cur = first.x;
        bs.forEach(x => {
          const n = window.findNode(S.design.nodes, x.id);
          if (n) n.x += cur - x.b.x;
          cur += x.b.w + gap;
        });
      } else {
        bs.sort((p, q) => p.b.y - q.b.y);
        const first = bs[0].b, last = bs[bs.length - 1].b;
        const total = (last.y + last.h) - first.y;
        const used = bs.reduce((s, x) => s + x.b.h, 0);
        const gap = (total - used) / (bs.length - 1);
        let cur = first.y;
        bs.forEach(x => {
          const n = window.findNode(S.design.nodes, x.id);
          if (n) n.y += cur - x.b.y;
          cur += x.b.h + gap;
        });
      }
    }, "等距分布");
  };

  // ---- 状态系统

  window.toggleStates = function (on) {
    const n = sel(); if (!n) return;
    window.commit(() => {
      if (on) {
        n.states = {
          normal: { assetId: n.assetId || "", alpha: 255, blink: false, blinkMs: 200 },
          warn: { assetId: "", alpha: 255, blink: false, blinkMs: 200 },
          critical: { assetId: "", alpha: 255, blink: true, blinkMs: 200 },
        };
        if (!n.statePid) n.statePid = "obd.rpm";
      } else {
        n.states = null;
      }
    }, on ? "启用状态系统" : "关闭状态系统");
  };

  window.setState = function (state, key, v) {
    const n = sel(); if (!n || !n.states) return;
    window.commit(() => {
      if (!n.states[state]) n.states[state] = { assetId: "", alpha: 255, blink: false, blinkMs: 200 };
      const st = n.states[state];
      if (key === "blink") st.blink = !!v;
      else if (key === "assetId") st.assetId = String(v);
      else if (key === "alpha") st.alpha = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
      else if (key === "blinkMs") st.blinkMs = Math.max(60, Math.round(Number(v) || 200));
    }, "改状态 " + state, "state:" + state + ":" + key);
  };

  // ================================================================ 顶栏：吸附 / 网格 / 缩放

  window.toggleSnap = function () {
    S.snap = !S.snap;
    const b = el("btnSnap");
    if (b) {
      b.textContent = S.snap ? "▦ 网格吸附 开" : "▦ 网格吸附 关";
      b.classList.toggle("on", S.snap);
      b.classList.toggle("off", !S.snap);
    }
    toast(S.snap ? "网格吸附已开启（对齐到 " + window.STEP + " 单位网格）"
      : "网格吸附已关闭（可停在任意坐标，边界仍会夹住）");
  }

  /**
   * **对象吸附**开关（v2.20.0）。
   *
   * 与网格吸附是两件事：
   *   · 网格吸附把坐标吸到 15 单位的格子上 —— 对齐的是"格子"
   *   · 对象吸附把边/中心吸到画布或别的节点上 —— 对齐的是"邻居"
   *
   * 两者可以同时开：网格先落位，对象再微调。也可以只开一个。
   */
  window.toggleSnapObj = function () {
    S.snapGuides = S.snapGuides === false;   // 默认 true，所以判 false 而不是真值
    const b = el("btnSnapObj");
    if (!b) return;
    const on = S.snapGuides !== false;
    b.textContent = on ? "🧲 对象吸附 开" : "🧲 对象吸附 关";
    b.classList.toggle("on", on);
    b.classList.toggle("off", !on);
    if (!on) { S.snapLines = null; window.draw(); }
    toast(on ? "对象吸附已开启（对齐到画布与其它控件）"
             : "对象吸附已关闭（不再显示对齐参考线）");
  };;
  window.toggleGrid = function () {
    S.showGrid = !S.showGrid;
    const b = el("btnGrid");
    if (b) { b.classList.toggle("on", S.showGrid); }
    window.draw();
  };

  /**
   * 画布上的控件是否显示 **PID id**。
   *
   * 为什么要有这个开关：做主题时"这个表绑的是哪个 PID"经常要看一眼，
   * 但摆位置时那行字又挡视线。所以做成可切换，默认**关**（画面干净）。
   * 控件名字（友好名）不受影响，始终显示。
   */
  window.togglePidLabel = function () {
    S.showPid = !S.showPid;
    try { localStorage.setItem("studio.showPid", S.showPid ? "1" : "0"); } catch (e) { }
    const b = el("btnPid");
    if (b) {
      // ⚠️ 文案要写**当前状态**，不能写成动作，否则会读反。
      // 第一版写"🏷 PID 隐 / 🏷 PID 显"，用户以为"点了会隐藏"——
      // 实际它表示"现在处于隐藏/显示状态"。
      // 现在：`🏷 PID 关`（不显示）/ `🏷 PID 开`（显示），并配 title 说明。
      b.textContent = S.showPid ? "🏷 PID 开" : "🏷 PID 关";
      b.title = S.showPid
        ? "当前：画布上显示 PID 别名（如 obd.coolant）。点击关闭"
        : "当前：画布上不显示 PID。点击开启（做主题时用来确认绑的是哪个 PID）";
      b.classList.toggle("on", S.showPid);
    }
    window.draw();
  };

  // ================================================================ 界面主题（暗黑 / 白色）

  /**
   * 切换暗黑 / 白色主题。
   *
   * 配色全在 `css/studio.css` 的 CSS 变量里，这里只切 `<html data-theme>`；
   * **画布的底色也从变量读**（`--cvOut/--cvIn/...`）—— 不然切了主题画布还是黑的。
   */
  window.toggleTheme = function (force, silent) {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = force || (cur === "dark" ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("studio.theme", next); } catch (e) { }
    const b = el("btnTheme");
    if (b) b.textContent = next === "dark" ? "🌙 暗黑" : "☀ 白色";
    // 画布要重画（底色变了）
    window.draw();
    if (!silent) toast(next === "dark" ? "已切到暗黑主题" : "已切到白色主题");
  };

  /** 画布用色：从 CSS 变量读，这样切主题时画布跟着变 */
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (e) { return fallback; }
  }
  window.readCanvasColors = function () {
    return {
      out: cssVar("--cvOut", "#020407"),
      in: cssVar("--cvIn", "#05070A"),
      grid: cssVar("--cvGrid", "rgba(20,28,38,0.9)"),
      gridAxis: cssVar("--cvGridAxis", "rgba(30,44,60,0.95)"),
      card: cssVar("--cvCard", "rgba(28,36,48,0.75)"),
      cardLine: cssVar("--cvCardLine", "#2A3547"),
      track: cssVar("--cvTrack", "#263143"),
      text: cssVar("--cvText", "#8FA0B8"),
      textDim: cssVar("--cvTextDim", "#5F6E85"),
      textFaint: cssVar("--cvTextFaint", "#3A4A5E"),
      value: cssVar("--cvValue", "#FFFFFF"),
    };
  };

  // ================================================================ 折叠面板

  /**
   * 设计信息 / 背景图 / 预设布局 的折叠。
   *
   * 折叠状态存 localStorage —— 用户调好一次布局，下次打开还是他要的样子。
   */
  window.togglePanel = function (name) {
    const body = el("body-" + name);
    const caret = el("caret-" + name);
    if (!body) return;
    const open = body.style.display === "none";
    body.style.display = open ? "" : "none";
    if (caret) caret.textContent = open ? "▾" : "▸";
    try { localStorage.setItem("studio.panel." + name, open ? "1" : "0"); } catch (e) { }
    // 展开/收起会改变右栏高度，画布要重新量
    setTimeout(() => window.applyCanvasSize(), 0);
  };

  function restorePanels() {
    ["preset", "info", "bg"].forEach(name => {
      let open;
      try {
        const saved = localStorage.getItem("studio.panel." + name);
        open = saved === null ? (name !== "preset") : saved === "1";   // 预设布局默认收起
      } catch (e) { open = name !== "preset"; }
      const body = el("body-" + name);
      const caret = el("caret-" + name);
      if (body) body.style.display = open ? "" : "none";
      if (caret) caret.textContent = open ? "▾" : "▸";
    });
  }

  // ================================================================ 新建

  /** 清空重来。**会先问一次** —— 没保存的设计丢了很恼火 */
  window.newDesign = function () {
    const n = window.flatten(S.design.nodes).length;
    if (n > 0 && !confirm("新建会清空当前 " + n + " 个控件（未保存的改动会丢）。\n\n继续？")) return;
    setJsonDirty(false);
    const d = blankDesign();
    d.nodes = window.PRESETS["blank"]();
    window.commit(() => {
      S.design = d;
      S.selection = [];
      S.bgImage = null;
    }, "新建设计");
    window.applyCanvasSize();
    toast("已新建空白设计");
  };

  // ================================================================ 校验显示

  let lastErrors = [], lastWarnings = [];

  /**
   * 渲染校验结果。
   *
   * @param errPos 若有 JSON **语法**错误，它的结构化位置 {line, col, pos}。
   *   有位置时，第一条错误会变成**可点击的"跳到第 N 行"** ——
   *   用户不用自己数行号。
   */
  function renderMessages(errors, warnings, errPos) {
    const box = el("msgs");
    if (!box) return;
    box.innerHTML = "";
    if (!errors.length && !warnings.length) {
      box.innerHTML = '<div class="msg ok">校验通过：没有硬错误，也没有警告。</div>';
      return;
    }
    errors.forEach((e, i) => {
      // 只在**第一条**错误上加跳转（语法错误就一条，其余是结构校验）
      const jump = (i === 0 && errPos) ? errPos : null;
      box.appendChild(msg("err", e, jump));
    });
    warnings.forEach(w => box.appendChild(msg("warn", w)));
  }

  /**
   * 一条消息。
   *
   * @param jump 有值时把这条做成可点击的 —— 点一下光标就跳到出错行并选中它。
   */
  function msg(kind, text, jump) {
    const d = document.createElement("div");
    d.className = "msg " + kind;
    if (!jump) { d.textContent = text; return d; }
    d.classList.add("jumpable");
    d.title = "点击跳到第 " + jump.line + " 行";
    const span = document.createElement("span");
    span.textContent = text;
    d.appendChild(span);
    const btn = document.createElement("button");
    btn.className = "jumpBtn";
    btn.textContent = "跳到第 " + jump.line + " 行 ↗";
    btn.onclick = () => window.gotoJsonError();
    d.appendChild(btn);
    return d;
  }

  /** 最近一次 JSON 语法错误的位置（用于"跳到出错处"） */
  let jsonErrPos = null;

  function validateNow() {
    const text = getVal("jsonArea");
    const r = window.validateText(text);
    lastErrors = r.errors;
    lastWarnings = r.warnings;

    // 单独跑一次严格解析拿**结构化位置** —— validateText 只给文案，
    // 而界面要把光标跳过去、并高亮那一行
    const strict = window.parseJsonStrict(text);
    jsonErrPos = strict.ok ? null : (strict.pos === undefined ? null
      : { pos: strict.pos, line: strict.line, col: strict.col });

    renderMessages(r.errors, r.warnings, jsonErrPos);
    const b = el("btnSave");
    if (b) b.classList.toggle("bad", r.errors.length > 0);
    return r;
  }

  /**
   * 把光标跳到 JSON 的出错处，并选中那一行。
   *
   * 为什么要"选中整行"而不只是放个光标：JSON 的报错位置常指向
   * **上一个 token 的结尾**（少个逗号 / 多括号），只放光标用户看不出来。
   * 选中整行能让人一眼定位。
   */
  window.gotoJsonError = function () {
    const area = el("jsonArea");
    if (!area || !jsonErrPos) return;
    const text = area.value;
    const pos = Math.min(jsonErrPos.pos, text.length);
    const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd < 0) lineEnd = text.length;
    area.focus();
    area.setSelectionRange(lineStart, lineEnd);
    // 滚动到可见（textarea 没有 scrollIntoView(line)，按行高估算）
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 16;
    const target = (jsonErrPos.line - 1) * lh - area.clientHeight / 3;
    area.scrollTop = Math.max(0, target);
  };
  window.validateNow = validateNow;

  // ================================================================ JSON 双向同步

  /**
   * 同步"设计对象 → JSON 文本 / 表单"。
   *
   * ⚠️ **`jsonDirty` 为真时直接跳过**，绝不覆盖文本域。
   *
   * 这是踩过的坑：用户在 JSON 里删了个字段 → 解析失败 → 工具保留上一次成功的设计
   * （画布不变），但**下一次画布改动会调 `syncJson()` 把文本域冲掉** ——
   * 用户的编辑就这么无声无息地没了。实测确认过（删掉 `nodes[0].pid` 后再拖一下，
   * `pid` 又回来了）。
   *
   * 所以：文本域有错未生效时，它是"用户的"，谁都不许动。
   */
  let jsonDirty = false;

  function syncJson() {
    if (!S.design) return;
    if (jsonDirty) return;                 // ← 关键：别冲掉用户正在改的文本
    suppressJsonSync = true;
    setVal("jsonArea", window.toV2Json(S.design));
    setVal("mName", S.design.name);
    setVal("mAuthor", S.design.author);
    setVal("mDesc", S.design.description);
    setVal("mTheme", S.design.themeId);
    setVal("dW", S.design.canvas.designW);
    setVal("dH", S.design.canvas.designH);
    setVal("scaleMode", String(S.design.canvas.scaleMode));
    setVal("bgPath", S.design.background ? S.design.background.path : "");
    setVal("bgFit", String(S.design.background ? S.design.background.fit : 0));
    // 尺寸留空显示（0 = 自动）
    const bw = S.design.background && S.design.background.w ? S.design.background.w : "";
    const bh = S.design.background && S.design.background.h ? S.design.background.h : "";
    setVal("bgW", bw);
    setVal("bgH", bh);
    suppressJsonSync = false;
  }

  /** JSON 文本域有错未生效时，给个**看得见**的提示 + 一个"放弃改动"的出口 */
  function setJsonDirty(dirty, errors) {
    jsonDirty = dirty;
    const area = el("jsonArea");
    if (area) area.classList.toggle("dirty", dirty);
    let bar = el("jsonDirtyBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "jsonDirtyBar";
      bar.className = "jsonDirtyBar";
      const pane = el("paneJson");
      if (pane) pane.insertBefore(bar, pane.firstChild);
    }
    if (!bar) return;
    if (!dirty) { bar.style.display = "none"; bar.innerHTML = ""; return; }
    bar.style.display = "";
    bar.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = "⚠️ JSON 有 " + (errors ? errors.length : 0) +
      " 个错误，画布仍是**上一次成功解析**的状态。修好错误才会生效 —— 在此之前画布上的改动不会写回这段文本。";
    const btn = document.createElement("button");
    btn.textContent = "放弃 JSON 改动，回到画布状态";
    btn.onclick = function () {
      setJsonDirty(false);
      syncJson();
      validateNow();
      toast("已放弃 JSON 改动，文本已回到画布当前状态");
    };
    bar.appendChild(msg);
    bar.appendChild(btn);
  }
  window.discardJsonEdit = function () {
    setJsonDirty(false);
    syncJson();
    validateNow();
  };

  /**
   * 安全地写一个 DOM 值。
   *
   * ⚠️ 为什么要它：第一版 `init()` 里直接 `el("bgFit").appendChild(...)`，
   * 而 HTML 里恰好漏了那个元素 → **抛异常 → init 中断 → design 一直是 null →
   * 所有面板全空**。一个缺失的 id 不该让整个工具瘫掉。
   * 现在所有可选的 DOM 访问都过这里，缺元素只会静默跳过。
   */
  function setVal(id, v) {
    const e = el(id);
    if (e) e.value = v;
  }

  /** 安全地读一个 DOM 值（缺元素返回空串，不抛） */
  function getVal(id) {
    const e = el(id);
    return e ? String(e.value) : "";
  }
  window.syncJson = syncJson;

  let jsonTimer = null;
  window.jsonEdited = function () {
    if (suppressJsonSync) return;
    clearTimeout(jsonTimer);
    jsonTimer = setTimeout(() => {
      const r = window.validateText(getVal("jsonArea"));
      if (r.errors.length || !r.design) {
        // 解析失败：**保留当前设计**（画布不动），把文本域标记成"有错未生效"，
        // 并且从此不再覆盖它（见 syncJson 的 jsonDirty）
        setJsonDirty(true, r.errors);
        validateNow();
        return;
      }
      setJsonDirty(false);
      S.design = r.design;
      if (S.selection.some(id => !window.findNode(S.design.nodes, id))) S.selection = [];
      window.restoreThumbs();
      window.applyCanvasSize();
      refreshAll();
      validateNow();
      updateUndoButtons();
    }, 350);
  };

  window.metaChanged = function () {
    window.commit(() => {
      S.design.name = getVal("mName");
      S.design.author = getVal("mAuthor");
      S.design.description = getVal("mDesc");
      S.design.themeId = getVal("mTheme");
    }, "改设计信息", "meta");
  };

  window.canvasChanged = function () {
    window.commit(() => {
      const w = Math.max(160, Math.round(Number(getVal("dW")) || 2560));
      const h = Math.max(120, Math.round(Number(getVal("dH")) || 1600));
      S.design.canvas.designW = w;
      S.design.canvas.designH = h;
      S.design.canvas.scaleMode = Number(getVal("scaleMode")) || 0;
    }, "改设计分辨率");
    window.applyCanvasSize();
  };

  // ---- 背景图（v1 兼容字段：只写路径，图片本身放 assets/）

  window.bgChanged = function () {
    if (suppressJsonSync) return;
    window.commit(() => {
      const p = getVal("bgPath").trim();
      const fit = Number(getVal("bgFit")) || 0;
      if (!p) { S.design.background = null; return; }
      // 尺寸留空 = 交给铺法自动决定（写 0）
      const w = Math.max(0, Math.round(Number(getVal("bgW")) || 0));
      const h = Math.max(0, Math.round(Number(getVal("bgH")) || 0));
      S.design.background = { path: p, fit: fit, w: w, h: h };
    }, "改背景图", "bg");
  };

  window.clearBg = function () {
    window.commit(() => { S.design.background = null; }, "清除背景");
    S.bgImage = null;
    window.draw();
  };

  /**
   * 选一张本机图片**只用于预览**。
   *
   * ⚠️ 浏览器读不到设备路径，所以这里**不会**改 `bgPath` ——
   * 写进设计文件的路径必须由用户手填（与 App 的 `assets/` 约定一致）。
   * 这条差异在「与 App 规则的差异」页里显式列出。
   */
  window.pickBgImage = function () {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        S.bgImage = img;
        if (!getVal("bgPath").trim()) {
          setVal("bgPath", "assets/" + f.name.replace(/[\\/:*?"<>|]/g, "_"));
          window.bgChanged();
        }
        window.draw();
        toast("背景预览已加载（写出的路径是 " + getVal("bgPath") + "）");
      };
      img.src = url;
    };
    inp.click();
  };

  // ================================================================ 实时数据模拟

  /**
   * 实时数据模拟：给所有用到的 PID 生成正弦波形，驱动预览动起来。
   *
   * 为什么要它：做主题时"数值变了会怎样"（指针扫过、条形增长、状态灯切换）
   * 是最需要看的部分，但真车不在手边。没有它就只能靠想象。
   *
   * 波形与 `DashboardBenchmark` 同思路：正弦（处处连续，不会突然跳变），
   * 每条错开相位，避免所有表同时到峰值。
   */
  let simRunning = false;
  let simStart = 0;
  let simRaf = null;

  function collectPids() {
    const set = new Set();
    window.walk(S.design.nodes, n => {
      if (n.type === window.NODE_GAUGE && n.pid) set.add(n.pid);
      if (n.type === window.NODE_IMAGE && n.statePid) set.add(n.statePid);
    });
    return Array.from(set);
  }

  function simStep() {
    if (!simRunning) return;
    const t = (performance.now() - simStart) / 1000;
    const pids = collectPids();
    const vals = {};
    pids.forEach((pid, i) => {
      const info = window.BUILTIN_PIDS[pid];
      const min = info ? info.min : 0;
      const max = info ? info.max : 100;
      const period = 4 + (i % 4) * 1.5;                 // 4~8.5 秒一圈
      const phase = (t / period) + i / Math.max(1, pids.length);
      const n = (Math.sin(phase * 2 * Math.PI) + 1) / 2; // 0..1
      vals[pid] = min + (max - min) * n;
    });
    S.previewValues = vals;
    S.simPhase = t;
    window.draw();
    simRaf = requestAnimationFrame(simStep);
  }

  window.toggleSim = function () {
    simRunning = !simRunning;
    const b = el("btnSim");
    if (simRunning) {
      simStart = performance.now();
      S.previewValues = {};
      simStep();
      if (b) { b.textContent = "⏸ 停止模拟"; b.classList.add("on"); }
      toast("实时模拟已开始：数值会按正弦变化，状态灯也会跟着切换");
    } else {
      if (simRaf) cancelAnimationFrame(simRaf);
      S.previewValues = null;
      S.simPhase = 0;
      window.draw();
      if (b) { b.textContent = "▶ 实时模拟"; b.classList.remove("on"); }
    }
  };

  /** 模拟的速度：让波形跑快一点，便于快速看到状态切换 */
  window.setSimSpeed = function () { /* 预留 */ };

  // ================================================================ 文件读写

  window.pickFile = function () {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        setJsonDirty(false);
        setVal("jsonArea", String(r.result));
        jsonTimer = null;
        window.jsonEdited();
        setTimeout(() => { syncJson(); validateNow(); }, 420);
      };
      r.readAsText(f, "utf-8");
    };
    inp.click();
  };

  function download(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.saveFile = function () {
    const r = validateNow();
    if (r.errors.length) {
      if (!confirm("还有 " + r.errors.length + " 个硬错误，App 会拒绝加载。仍然保存？")) return;
    }
    const assetNote = (S.design.assets || []).length
      ? "\n\n⚠️ 别忘了把素材图片放到设计文件**同目录**的 assets/ 下：\n" +
      (S.design.assets || []).slice(0, 8).map(a => "  " + a.path).join("\n") +
      ((S.design.assets || []).length > 8 ? "\n  …" : "")
      : "";
    download((S.design.name || "design") + ".json", getVal("jsonArea"));
    toast("已保存 v2 设计文件（含控件树 / 图片 / 状态）" + assetNote);
  };

  /**
   * 导出当前画布为 **PNG 预览图**。
   *
   * 用途：发给别人看 / 存进设计文档 / 做对比。
   *
   * ⚠️ 导出前会**临时关掉选择框与网格** —— 那些是编辑辅助，不该出现在成品图里。
   */
  window.exportPng = function () {
    const cv = document.getElementById("cv");
    if (!cv) return;
    const sel = S.selection, grid = S.showGrid, marquee = S.marquee;
    S.selection = []; S.showGrid = false; S.marquee = null;
    window.draw();
    try {
      const name = (S.design.name || "design").replace(/[\\/:*?"<>|]/g, "_");
      // ⚠️ **必须兜住 SecurityError**：`file://` 下如果画布上画过
      // 「按路径加载」的图，画布会被**污染**，toDataURL 直接抛异常。
      // 内置素材已经内嵌 data URL 规避了，但用户导入的素材、
      // 或将来别的加载方式仍可能触发 —— 兜住并**说清楚原因**，
      // 比留一个控制台报错强得多。
      const url = cv.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = name + "-预览.png";
      a.click();
      toast("已导出 PNG 预览（" + cv.width + "×" + cv.height + "）");
      } catch (err) {
        if (err && err.name === "SecurityError") {
          toast("导出失败：画布被本地图片「污染」了。请把素材**导入**（用分类上的 ＋），不要引用本地路径");
        } else {
          toast("导出失败：" + (err && err.message ? err.message : err));
        }
        console.warn("导出 PNG 失败：", err);
    } finally {
      // 无论成功失败都要把编辑状态还原，否则用户会以为选择框"丢了"
      S.selection = sel; S.showGrid = grid; S.marquee = marquee;
      window.draw();
    }
  };

  /** 导出 v1：App 当前版本能直接读（丢掉图片/文字/分组/旋转） */
  window.exportV1 = function () {
    const r = validateNow();
    if (r.errors.length) { alert("还有硬错误，先修好再导出。"); return; }
    const out = window.toV1Json(S.design);
    if (out.count === 0) { alert("没有可导出的仪表节点（v1 只支持仪表）。"); return; }
    const lost = out.lost;
    const lostList = [];
    if (lost.image) lostList.push(lost.image + " 个图片控件");
    if (lost.text) lostList.push(lost.text + " 个文字控件");
    if (lost.group) lostList.push(lost.group + " 个分组");
    if (lost.rotation) lostList.push(lost.rotation + " 个旋转");
    if (lost.scale) lostList.push(lost.scale + " 个缩放");
    if (lost.alpha) lostList.push(lost.alpha + " 个非全不透明");
    const warn = lostList.length
      ? "\n\n⚠️ v1 表达不了以下内容，会被丢掉：\n  " + lostList.join("\n  ")
      : "";
    if (!confirm("导出 v1（" + out.count + " 个仪表）。\n\n" +
      "v1 是 App **当前版本**能直接读的格式，但没有图片/状态/分组/变换。" + warn +
      "\n\n继续？")) return;
    download((S.design.name || "design") + "-v1.json", out.json);
    toast("已导出 v1（" + out.count + " 个仪表）");
  };

  // ================================================================ 预设布局

  window.applyPreset = function (name) {
    const P = window.PRESETS || {};
    const fn = P[name];
    if (!fn) return;
    const cur = window.flatten(S.design.nodes).length;
    if (cur && !confirm("会替换当前全部 " + cur + " 个控件，继续？")) return;
    setJsonDirty(false);
    window.commit(() => {
      S.design.nodes = fn();
      S.selection = [];
    }, "套用预设：" + name);
    window.applyCanvasSize();
  };

  // ================================================================ 提示

  let toastTimer = null;
  function toast(text) {
    const t = el("toast");
    if (!t) return;
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }
  window.toast = toast;

  // ================================================================ 启动

  function blankDesign() {
    const d = window.createDesign({ name: "未命名设计" });
    d.nodes = window.PRESETS["1big4small"]();
    return d;
  }

  function init() {
    // 面板折叠状态与高度是**持久的** —— 用户调过一次就该记住
    if (window.loadPanelState) window.loadPanelState();
    // 分类顺序与自定义分类也要读回 —— 不读的话每次打开都回到出厂顺序
    if (window.loadAssetKinds) window.loadAssetKinds();
    // ⚠️ **先建 design**，再做界面接线。这样即使接线里某个元素缺失抛异常，
    // 画布与面板仍然有数据可用（第一版顺序反了，一个缺 id 就让整个工具瘫掉）。
    S.design = blankDesign();
    undo.reset(snapshot(), "初始");

    // 界面接线：每块独立 try/catch，互不牵连
    const steps = [
      ["界面主题", function () {
        let saved = "dark";
        try { saved = localStorage.getItem("studio.theme") || "dark"; } catch (e) { }
        window.toggleTheme(saved, true);   // 启动时静默恢复，不弹提示
      }],
      ["面板折叠状态", function () { restorePanels(); }],
      ["PID 标签开关", function () {
        let on = false;
        try { on = localStorage.getItem("studio.showPid") === "1"; } catch (e) { }
        S.showPid = false;                       // 先置 false，让 toggle 真的翻转
        if (on) window.togglePidLabel();
        else {
          const b = el("btnPid");
          if (b) b.textContent = "🏷 PID 关";
        }
      }],
      ["下拉框", function () {
        const sm = el("scaleMode");
        if (sm && !sm.options.length) {
          window.SCALE_MODES.forEach(m => {
            const o = document.createElement("option");
            o.value = String(m.v); o.textContent = m.n; o.title = m.d;
            sm.appendChild(o);
          });
        }
        const bf = el("bgFit");
        if (bf && !bf.options.length) {
          window.FIT_NAMES.forEach((n, i) => {
            const o = document.createElement("option");
            o.value = String(i); o.textContent = i + " · " + n;
            bf.appendChild(o);
          });
        }
      }],
      ["同步 JSON", function () { syncJson(); }],
      ["素材缩略图", function () { window.restoreThumbs(); }],
      ["画布尺寸", function () { window.applyCanvasSize(); }],
      ["面板", function () { refreshAll(); }],
      ["校验", function () { validateNow(); }],
      ["撤销按钮", function () { updateUndoButtons(); }],
      ["差异清单", function () { window.renderDiff && window.renderDiff(); }],
      ["键盘快捷键", function () { bindKeys(); }],
    ];
    const failed = [];
    steps.forEach(function (pair) {
      try { pair[1](); } catch (e) {
        failed.push(pair[0] + "：" + e.message);
        console.error("[studio] 初始化步骤失败 —— " + pair[0], e);
      }
    });
    if (failed.length) {
      toast("有 " + failed.length + " 个初始化步骤失败：\n" + failed.join("\n"));
    }

    const sb = el("btnSnap");
    if (sb) sb.classList.add("on");
    toast("提示：Ctrl+Z 撤销 · Ctrl+D 复制 · Ctrl+A 全选 · 方向键微调 · Shift 加选");
  }

  function bindKeys() {
    document.addEventListener("keydown", ev => {
      const tag = (ev.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && ev.key.toLowerCase() === "z" && !ev.shiftKey) { ev.preventDefault(); window.doUndo(); return; }
      if (ctrl && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
        ev.preventDefault(); window.doRedo(); return;
      }
      if (ctrl && ev.key.toLowerCase() === "d") { ev.preventDefault(); window.dupSelected(); return; }
      if (ctrl && ev.key.toLowerCase() === "g") {
        ev.preventDefault();
        if (ev.shiftKey) window.ungroupSelected(); else window.groupSelected();
        return;
      }
      if (ctrl && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        S.selection = window.flatten(S.design.nodes).map(n => n.id);
        window.onSelectionChanged();
        return;
      }
      // F2：打开控件编辑器（和右键「编辑控件…」同一个入口）
      if (ev.key === "F2" && S.selection.length === 1) {
        ev.preventDefault();
        window.openControlEditor(S.selection[0]);
        return;
      }
      if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); window.delSelected(); return; }
      if (ev.key === "Escape") {
        // 模态框开着就先关它，别把选择也清了
        const m = document.getElementById("ctrlEditor");
        if (m && m.classList.contains("show")) { window.closeControlEditor(); return; }
        // 在分组里 → 先退出一层（而不是直接清选择）。这是"进入/退出"最自然的按键
        if (window.drillExit && window.drillExit()) return;
        S.selection = [];
        window.onSelectionChanged();
        return;
      }
      // 方向键微调（Shift = 1 单位）
      if (ev.key.indexOf("Arrow") === 0 && S.selection.length) {
        ev.preventDefault();
        const step = ev.shiftKey ? 1 : window.STEP;
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        window.commit(() => {
          S.selection.forEach(id => {
            const n = window.findNode(S.design.nodes, id);
            if (!n || n.locked) return;
            n.x = window.clamp(n.x + dx, 0, Math.max(0, window.CANVAS - n.w));
            n.y = window.clamp(n.y + dy, 0, Math.max(0, window.CANVAS - n.h));
          });
        }, "微调", "nudge");
        window.draw();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  // ================================================================ 素材数据懒加载（v2.30.0）
  //
  // ## 为什么
  //
  // `builtin-index.js` 只有 **36 KB**（元数据），11 个分类的数据文件合计 **~700 KB**。
  // 静态全加载意味着**首屏要等那 700 KB 解析完**才能在素材库里看到任何东西。
  //
  // 现在：索引先到 → 界面立刻能渲染出全部分类与缩略图位置；
  // 数据在首屏之后按分类一个个注入，每到一个就刷新一次。
  //
  // ## 串行 + 空闲时加载
  //
  // 并行注入 11 个脚本会瞬间占满主线程（每个都要解析 base64）。
  // 串行 + `requestIdleCallback` 让它在浏览器空闲时慢慢来，不卡交互。
  //
  // ## 测试怎么等
  //
  // 全部加载完会置 `window.BUILTIN_DATA_DONE = true`，
  // 各测试套件的 `waitReady()` 会等这个标志 —— 否则它们会拿到没有 data 的素材，
  // 然后在"缩略图能不能解码"这类断言上失败。
  //
  // ## 失败也不卡住
  //
  // 某个文件 404 / 解析失败 → **跳过它继续下一个**，最后照样置 DONE。
  // 那些素材的 path 仍然有效（App 侧照样能读），只是工具里没有内嵌预览。
  window.BUILTIN_DATA_DONE = false;
  (function loadAssetData() {
    const KINDS = ["background", "dashboard", "needle", "scale", "icon",
                   "turn", "warning", "brand", "decor", "bar", "frame"];
    let idx = 0;
    function next() {
      if (idx >= KINDS.length) { window.BUILTIN_DATA_DONE = true; return; }
      const kind = KINDS[idx++];
      const s = document.createElement("script");
      s.src = "assets/builtin-data-" + kind + ".js";
      s.onload = function () {
        try { window.syncAssetImages && window.syncAssetImages(); } catch (e) {}
        try { window.renderAssets && window.renderAssets(); } catch (e) {}
        next();
      };
      s.onerror = function () { next(); };   // 跳过，继续
      document.head.appendChild(s);
    }
    if (window.requestIdleCallback) window.requestIdleCallback(function () { next(); }, { timeout: 1500 });
    else setTimeout(next, 200);
  })();
})();
