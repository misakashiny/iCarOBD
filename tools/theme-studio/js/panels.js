/* ==========================================================================
   panels.js —— 控件树 / 属性面板 / 素材管理器
   --------------------------------------------------------------------------
   设计见 docs/主题设计大纲.md §6.3。

   用户反馈"主题、属性里面太杂乱了"，所以：
     - 控件树 = 图层管理器 + 控件管理器（顺序、可见、锁定、父子）
     - 属性**按组折叠**（变换 / 图层 / 数据 / 状态 / 文字），不再堆成一长列
   ========================================================================== */
"use strict";

(function () {
  const S = window.CanvasState;

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function attr(s) { return esc(s); }
  // ---- 三个 HTML 助手都导出（v2.35.0）
  //
  // ⚠️ **以前只导出了 `esc`** —— `attr` 和 `el` 是"看着像公共助手、其实是本文件局部"的，
  // 在别的文件里直接用就会 `ReferenceError`。**本次会话为 `attr` 踩了两次坑**：
  //   · canvas.js 的面包屑
  //   · app.js 的主题配色编辑器
  //
  // 两次都是"运行到那一行才炸"，而且报错只说 `attr is not defined`，
  // 不给"应该从哪来"的线索。导出来就不会再有这个问题。
  window.esc = esc;
  window.attr = attr;
  window.el = el;

  /** 折叠组的状态（工具级，存 localStorage） */
  const collapsed = {};
  try {
    const saved = JSON.parse(localStorage.getItem("studio.collapsed") || "{}");
    Object.assign(collapsed, saved);
  } catch (e) { /* 首次运行 */ }

  function saveCollapsed() {
    try { localStorage.setItem("studio.collapsed", JSON.stringify(collapsed)); } catch (e) { }
  }

  // ================================================================ 控件树

  /**
   * 控件树 = 图层管理器 + 控件管理器。
   *
   * 显示顺序：**从上到下 = 从上层到下层**（与 Photoshop 一致），
   * 也就是同层里 z 大的在上面。这样"拖到列表上方 = 置顶"符合直觉。
   */
  function renderTree() {
    const box = el("tree");
    if (!box) return;
    const d = S.design;
    if (!d) { box.innerHTML = ""; return; }
    box.innerHTML = "";

    const head = document.createElement("div");
    head.className = "panelBar";
    head.innerHTML =
      '<span class="pbCaret" onclick="togglePanelCollapse(\'tree\')">' +
      (panelCollapsed.tree ? "▸" : "▾") + '</span>' +
      '<span class="pbTitle" onclick="togglePanelCollapse(\'tree\')">控件树</span>' +
      '<span class="pbCount">' + window.flatten(d.nodes).length + '</span>' +
      '<span class="pbBtn" onclick="event.stopPropagation();treeExpandAll(true)" title="展开全部节点">⊞</span>' +
      '<span class="pbBtn" onclick="event.stopPropagation();treeExpandAll(false)" title="折叠全部节点">⊟</span>';
    box.appendChild(head);

    const root = document.createElement("div");
    root.className = "treeBody panelScroll";
    renderLevel(d.nodes, root, 0, true);
    box.appendChild(root);
    applyPanelCollapse("tree");
  }
  window.renderTree = renderTree;

  /**
   * 控件树：折叠 / 展开**全部**。
   *
   * 用 `collapsed` 的反向语义记「已展开」太绕 —— 直接按当前树里所有**有子节点**
   * 的节点逐个设值。节点多了也不慢（200 个上限）。
   */
  window.treeExpandAll = function (open) {
    if (!S.design) return;
    window.walk(S.design.nodes, n => {
      if (n.children && n.children.length) collapsed[n.id] = !open;
    });
    saveCollapsed();
    renderTree();
    window.toast(open ? "已展开全部" : "已折叠全部");
  };

  function renderLevel(list, parentEl, depth, isRoot) {
    // 上层在上：按 z 降序
    window.sortByZ(list).reverse().forEach(n => {
      const row = document.createElement("div");
      row.className = "trow" + (S.selection.indexOf(n.id) >= 0 ? " sel" : "");
      row.dataset.id = n.id;
      row.draggable = true;

      const typeInfo = window.NODE_TYPES.find(t => t.v === n.type) || { icon: "?", n: n.type };
      const hasKids = n.children && n.children.length;

      // 展开箭头
      const tw = document.createElement("span");
      tw.className = "tw";
      if (hasKids) {
        tw.textContent = collapsed[n.id] ? "▸" : "▾";
        tw.onclick = ev => {
          ev.stopPropagation();
          collapsed[n.id] = !collapsed[n.id];
          saveCollapsed();
          renderTree();
        };
      }
      row.appendChild(tw);

      // 层级数徽章：用户要求"显示层级数的显示图标"。
      // 缩进只能看出"有层级"，看不出"第几层" —— 徽章把这件事说清楚。
      const dep = document.createElement("span");
      dep.className = "tdepth";
      dep.textContent = "L" + depth;
      dep.title = depth === 0
        ? "第 0 层（根节点）"
        : "第 " + depth + " 层（嵌套在父节点内，坐标相对父节点）";
      row.appendChild(dep);

      const ic = document.createElement("span");
      ic.className = "tic";
      ic.textContent = typeInfo.icon;
      row.appendChild(ic);

      const nm = document.createElement("span");
      nm.className = "tnm";
      nm.textContent = n.name || typeInfo.n;
      if (n.type === window.NODE_GAUGE && n.pid) {
        const info = window.BUILTIN_PIDS[n.pid];
        nm.title = (info ? info.name : n.pid);
      }
      row.appendChild(nm);

      if (n.locked) {
        const lk = document.createElement("span");
        lk.className = "tflag";
        lk.textContent = "🔒";
        lk.title = "已锁定：不能移动/缩放/旋转";
        row.appendChild(lk);
      }

      // 可见性
      const vis = document.createElement("span");
      vis.className = "tbtn";
      vis.textContent = n.visible ? "👁" : "🚫";
      vis.title = n.visible ? "隐藏" : "显示";
      vis.onclick = ev => {
        ev.stopPropagation();
        window.commit(() => { n.visible = !n.visible; }, (n.visible ? "显示" : "隐藏") + "「" + n.name + "」");
      };
      row.appendChild(vis);

      // 锁定
      const lk = document.createElement("span");
      lk.className = "tbtn";
      lk.textContent = n.locked ? "🔒" : "🔓";
      lk.title = n.locked ? "解锁" : "锁定（锁定后无法移动调整）";
      lk.onclick = ev => {
        ev.stopPropagation();
        window.commit(() => { n.locked = !n.locked; }, (n.locked ? "锁定" : "解锁") + "「" + n.name + "」");
      };
      row.appendChild(lk);

      row.onclick = ev => {
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
          const i = S.selection.indexOf(n.id);
          if (i >= 0) S.selection.splice(i, 1); else S.selection.push(n.id);
        } else {
          S.selection = [n.id];
        }
        if (window.onSelectionChanged) window.onSelectionChanged();
      };

      // 右键也出菜单（和画布上一致，"像软件一样"）
      row.oncontextmenu = ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (S.selection.indexOf(n.id) < 0) {
          S.selection = [n.id];
          if (window.onSelectionChanged) window.onSelectionChanged();
        }
        if (window.showCtxMenu) window.showCtxMenu(ev.clientX, ev.clientY);
      };

      // 拖拽改父子关系
      row.ondragstart = ev => {
        ev.dataTransfer.setData("text/plain", n.id);
        ev.dataTransfer.effectAllowed = "move";
      };
      // 拖拽分**三个区域**（Figma / VS Code 都是这个约定）：
      //   上 1/4 → 插到这一行的**前面**（同层重排）
      //   下 1/4 → 插到这一行的**后面**（同层重排）
      //   中间   → 成为它的**子节点**
      // 这样"调顺序"和"改父子"两个需求不用两种手势。
      row.ondragover = ev => {
        ev.preventDefault();
        const src = ev.dataTransfer.getData("text/plain");
        row.classList.remove("dropTarget", "dropBefore", "dropAfter");
        if (!src || src === n.id) return;
        const r = row.getBoundingClientRect();
        const t = (ev.clientY - r.top) / Math.max(1, r.height);
        const sameLevel = window.canReorderSameLevel(S.design.nodes, src, n.id);
        if (sameLevel && t < 0.25) row.classList.add("dropBefore");
        else if (sameLevel && t > 0.75) row.classList.add("dropAfter");
        else row.classList.add("dropTarget");
      };
      row.ondragleave = () => row.classList.remove("dropTarget", "dropBefore", "dropAfter");
      row.ondrop = ev => {
        ev.preventDefault();
        const before = row.classList.contains("dropBefore");
        const after = row.classList.contains("dropAfter");
        row.classList.remove("dropTarget", "dropBefore", "dropAfter");
        const src = ev.dataTransfer.getData("text/plain");
        if (!src || src === n.id) return;
        if (before || after) {
          window.commit(() => {
            window.reorderSibling(S.design.nodes, src, n.id, after);
            // 重排之后把 z 归一化，否则"顺序变了但 z 没变"会让画布上层级不动
            window.normalizeZ(S.design.nodes);
          }, (after ? "移到「" + n.name + "」之后" : "移到「" + n.name + "」之前"));
          return;
        }
        window.commit(() => {
          // 拖到某个节点中间 = 成为它的子节点（放到最上）
          if (!window.reparent(S.design.nodes, src, n.id)) return;
          const sn = window.findNode(S.design.nodes, src);
          if (sn) sn.z = (n.children.reduce((m, c) => Math.max(m, c.z || 0), 0)) + 1;
        }, "移动「" + n.name + "」到「" + n.name + "」下");
      };

      parentEl.appendChild(row);

      if (hasKids && !collapsed[n.id]) {
        const kids = document.createElement("div");
        kids.className = "tkids";
        renderLevel(n.children, kids, depth + 1, false);
        parentEl.appendChild(kids);
      }
    });

    // 根级放置区（拖出分组）
    if (isRoot) {
      const drop = document.createElement("div");
      drop.className = "tdrop";
      drop.textContent = "拖到此处移出分组（成为根节点）";
      drop.ondragover = ev => { ev.preventDefault(); drop.classList.add("dropTarget"); };
      drop.ondragleave = () => drop.classList.remove("dropTarget");
      drop.ondrop = ev => {
        ev.preventDefault();
        drop.classList.remove("dropTarget");
        const src = ev.dataTransfer.getData("text/plain");
        if (!src) return;
        window.commit(() => { window.reparent(S.design.nodes, src, null); }, "移出分组");
      };
      parentEl.appendChild(drop);
    }
  }

  // ================================================================ 属性面板

  /** 折叠组。key 稳定，折叠状态会记住 */
  function group(key, title, bodyHtml) {
    const open = !collapsed["grp:" + key];
    return '<div class="pgroup">' +
      '<div class="phead" onclick="toggleGroup(\'' + key + '\')">' +
      '<span class="pcaret">' + (open ? "▾" : "▸") + '</span>' + esc(title) +
      '</div>' +
      '<div class="pbody" style="display:' + (open ? "block" : "none") + '">' + bodyHtml + '</div>' +
      '</div>';
  }

  window.toggleGroup = function (key) {
    collapsed["grp:" + key] = !collapsed["grp:" + key];
    saveCollapsed();
    renderProps();
  };

  function row(label, inner) {
    return '<div class="prow"><label>' + esc(label) + '</label>' + inner + '</div>';
  }
  function numIn(k, v, step) {
    return '<input type="number" step="' + (step || "1") + '" value="' + window.r2(v) +
      '" oninput="setNodeNum(\'' + k + '\', this.value)">';
  }

  /**
   * 属性面板。**按组折叠**，一组一个职责：
   *   变换 / 图层 / 数据 / 状态 / 文字 / 图片
   */
  function renderProps() {
    const box = el("props");
    if (!box) return;
    const d = S.design;
    if (!d || S.selection.length === 0) {
      // 用户明确说那段提示不需要。但完全空着会看着像坏了 —— 只留一个标题。
      box.innerHTML = '<div class="panelHead" style="cursor:default">' +
        '<span class="pcaret">▾</span>属性' +
        '<span class="ph-count">未选中</span></div>';
      return;
    }
    if (S.selection.length > 1) {
      box.innerHTML = renderMulti();
      return;
    }

    const n = window.findNode(d.nodes, S.selection[0]);
    if (!n) { box.innerHTML = '<div class="hint">选中的控件已不存在。</div>'; return; }

    const out = [];
    out.push('<div class="pTitle">' + esc(n.name) +
      ' <span class="badge">' + (window.NODE_TYPES.find(t => t.v === n.type) || {}).n + '</span>' +
      (n.locked ? ' <span class="badge lock">已锁定</span>' : '') + '</div>');

    // ---- 名称
    out.push(row("名称", '<input value="' + attr(n.name) + '" oninput="setNodeStr(\'name\',this.value)">'));

    // ---- 变换
    out.push(group("tf", "变换", [
      row("位置 x / y", numIn("x", n.x) + numIn("y", n.y)),
      row("尺寸 w / h", numIn("w", n.w) + numIn("h", n.h)),
      // ---- 等比缩放（v2.21.0）。默认**开** ——
      // 拖角手柄自由拉伸会让图片素材立刻变形，而多数时候用户只是想放大。
      row("等比缩放",
        '<label class="chk"><input type="checkbox"' +
        (window.CanvasState.aspectLock !== false ? " checked" : "") +
        ' onchange="setAspectLock(this.checked)"> 拖角手柄保持比例</label>' +
        '<span class="hint inline">按住 Alt 临时自由拉伸</span>' +
        (n.type === window.NODE_IMAGE && n.assetId
          ? '<button class="mini" onclick="fitNodeAspect()">恢复素材比例</button>'
          : "")),
      row("旋转（度）", numIn("rotation", n.rotation, "0.5") +
        '<button class="mini" onclick="setNodeNum(\'rotation\',0)">归零</button>'),
      row("缩放（倍）", numIn("scale", n.scale, "0.05") +
        '<button class="mini" onclick="setNodeNum(\'scale\',1)">1×</button>'),
      row("不透明度", numIn("alpha", n.alpha) +
        '<input type="range" min="0" max="255" value="' + Math.round(n.alpha) +
        '" oninput="setNodeNum(\'alpha\',this.value)">'),
      // 用户明确说这段说明不需要（"旋转绕自身中心；缩放是额外倍率"）
    ].join("")));

    // ---- 图层
    out.push(group("z", "图层", [
      row("层级 z", numIn("z", n.z) + '<span class="hint inline">大者在上</span>'),
      '<div class="btnRow">' +
      '<button onclick="layerCmd(\'front\')">置顶</button>' +
      '<button onclick="layerCmd(\'back\')">置底</button>' +
      '<button onclick="layerCmd(\'up\')">上移</button>' +
      '<button onclick="layerCmd(\'down\')">下移</button>' +
      '</div>',
      '<div class="btnRow">' +
      '<button onclick="toggleLock()">' + (n.locked ? "🔓 解锁" : "🔒 锁定") + '</button>' +
      '<button onclick="toggleVisible()">' + (n.visible ? "🚫 隐藏" : "👁 显示") + '</button>' +
      '<button onclick="dupSelected()">复制</button>' +
      '<button class="danger" onclick="delSelected()">删除</button>' +
      '</div>',
      '<div class="hint">锁定的控件不能拖动/缩放/旋转，但仍可改属性。</div>',
    ].join("")));

    // ---- 类型专属
    if (n.type === window.NODE_GAUGE) {
      out.push(group("data", "数据绑定", gaugeFields(n)));
      // 表上的文字也归字体管：名字 / PID / 量程 的字体 + 是否显示
      // ---- 子部件（v2.12.0）：把仪表拆成可替换的表盘/刻度/指针/数值
      out.push(group("parts", "子部件（自己拼装）", partsFields(n)));
      out.push(group("font", "字体（表上的文字）", window.fontFields(n.labelFont, "setNodeFont",
        row("显示", '<label class="chk"><input type="checkbox"' + (n.showLabel !== false ? " checked" : "") +
          ' onchange="setNodeFontFlag(\'showLabel\',this.checked)"> 名字</label>' +
          '<label class="chk"><input type="checkbox"' + (n.showRange !== false ? " checked" : "") +
          ' onchange="setNodeFontFlag(\'showRange\',this.checked)"> 量程</label>'))));
    }
    if (n.type === window.NODE_IMAGE) out.push(group("img", "图片", imageFields(n)));
    if (n.type === window.NODE_IMAGE) out.push(group("st", "状态系统", stateFields(n)));
    if (n.type === window.NODE_TEXT) {
      out.push(group("txt", "文字", textFields(n)));
      out.push(group("font", "字体", window.fontFields(n.font, "setNodeFont")));
    }

    box.innerHTML = out.join("");
    // 属性面板的拖拽高度（如果拖过）要落上 —— 与素材库同一套
    applyPanelCollapse("props");
  }
  window.renderProps = renderProps;

  function renderMulti() {
    const names = S.selection.map(id => {
      const n = window.findNode(S.design.nodes, id);
      return n ? n.name : "?";
    });
    return '<div class="pTitle">已选 ' + S.selection.length + ' 个控件</div>' +
      '<div class="hint">' + names.map(esc).join(" · ") + '</div>' +
      group("multi", "批量操作", [
        '<div class="btnRow">' +
        '<button onclick="alignSel(\'left\')">左对齐</button>' +
        '<button onclick="alignSel(\'hcenter\')">水平居中</button>' +
        '<button onclick="alignSel(\'right\')">右对齐</button>' +
        '</div>',
        '<div class="btnRow">' +
        '<button onclick="alignSel(\'top\')">顶对齐</button>' +
        '<button onclick="alignSel(\'vcenter\')">垂直居中</button>' +
        '<button onclick="alignSel(\'bottom\')">底对齐</button>' +
        '</div>',
        '<div class="btnRow">' +
        '<button onclick="distributeSel(\'h\')">水平等距</button>' +
        '<button onclick="distributeSel(\'v\')">垂直等距</button>' +
        '</div>',
        '<div class="btnRow">' +
        '<button onclick="layerCmd(\'front\')">全部置顶</button>' +
        '<button onclick="layerCmd(\'back\')">全部置底</button>' +
        '<button onclick="lockSel(true)">全部锁定</button>' +
        '<button onclick="lockSel(false)">全部解锁</button>' +
        '</div>',
        '<div class="btnRow"><button class="danger" onclick="delSelected()">删除全部</button></div>',
      ].join(""));
  }

  function gaugeFields(n) {
    const pidOptions = (function () {
      const groups = new Map();
      Object.entries(window.PID_ALIASES).forEach(([alias, id]) => {
        const info = window.BUILTIN_PIDS[id];
        const g = info ? info.g : "其他";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push({ v: alias, l: alias + "  →  " + id + (info ? "  " + info.name : "") });
      });
      const tpl = Object.keys(window.BUILTIN_PIDS).filter(id => id.startsWith("tpl_"));
      if (tpl.length) {
        groups.set("厂家模板（未验证，直接写 id）",
          tpl.map(id => ({ v: id, l: id + "  " + window.BUILTIN_PIDS[id].name })));
      }
      // ⚠️ 兜底项：当前 PID 既不是别名也不是模板（比如手填的厂家 PID），
      // 否则 <select> 找不到匹配项会**显示空白**，看起来像没绑定。
      const cur = n.rawPid || n.pid;
      const known = Array.from(groups.values()).some(items => items.some(it => it.v === cur));
      if (cur && !known) {
        groups.set("当前（不在内置库）", [{ v: cur, l: cur + "  ⚠️ 不在内置 PID 库" }]);
      }
      let h = "";
      groups.forEach((items, g) => {
        h += '<optgroup label="' + attr(g) + '">';
        items.forEach(it => { h += '<option value="' + attr(it.v) + '">' + esc(it.l) + '</option>'; });
        h += '</optgroup>';
      });
      return h;
    })();

    return [
      row("PID", '<select onchange="setNodePid(this.value)">' + pidOptions + '</select>'),
      row("PID id", '<input value="' + attr(n.rawPid || n.pid) + '" oninput="setNodePid(this.value)">'),
      row("样式", '<select onchange="setNodeNum(\'style\',this.value)">' +
        window.STYLES.map(s => '<option value="' + s.v + '"' +
          (n.style === s.v ? " selected" : "") + '>' + s.v + ' · ' + s.n + '</option>').join("") +
        '</select>'),
      row("min / max", numIn("min", n.min, "any") + numIn("max", n.max, "any")),
      // P9「非数值 PID 模型」方向 A：枚举的**显示**映射
      // （值仍然是数 → 指针/条照旧按数值走；只有读数换名字）
      //
      // ⚠️ **单行输入 + 逗号分隔**，不是 textarea：属性面板有"行高 ≤ 40px"的
      // 排版约束（`verify-layout` 守着），3 行 textarea 会当场把它顶红。
      // 代价：**名字里不能有逗号**（挡位这类本来也没有）。
      row("数值映射", '<input value="' + attr((n.valueLabels || []).join(",")) +
        '" placeholder="逗号分隔，索引 = round(值)，如 P,R,N,1,2" ' +
        'oninput="setNodeValueLabels(this.value)">'),
      row("warnLow", '<input type="number" step="any" value="' + (n.warnLow === null ? "" : window.r2(n.warnLow)) +
        '" placeholder="（不设）" oninput="setNodeNullable(\'warnLow\',this.value)">'),
      row("warnHigh", '<input type="number" step="any" value="' + (n.warnHigh === null ? "" : window.r2(n.warnHigh)) +
        '" placeholder="（不设）" oninput="setNodeNullable(\'warnHigh\',this.value)">'),
      row("卡片外框", '<select onchange="setNodeCard(this.value)">' +
        window.CARD_NAMES.map((c, i) => '<option value="' + i + '"' +
          (((n.cardStyle === null ? 0 : n.cardStyle)) === i ? " selected" : "") + '>' + i + ' · ' + c +
          '</option>').join("") + '</select>'),
        row("底框显示", '<label class="chk"><input type="checkbox"' +
          (window.resolveCard(n).show ? " checked" : "") +
          ' onchange="setCardFlag(\'show\',this.checked)"> 画底框</label>'),
        row("底框透明度", '<input type="number" min="0" max="255" placeholder="跟随主题" value="' +
          (n.card && n.card.alpha !== null && n.card.alpha !== undefined ? n.card.alpha : "") +
          '" oninput="setCardNum(\'alpha\',this.value)">' +
          '<input type="range" min="0" max="255" value="' +
          (n.card && n.card.alpha !== null && n.card.alpha !== undefined ? n.card.alpha : 190) +
          '" oninput="setCardNum(\'alpha\',this.value)">'),
        row("底框圆角", '<input type="number" min="0" max="120" placeholder="跟随主题" value="' +
          (n.card && n.card.radius !== null && n.card.radius !== undefined ? n.card.radius : "") +
          '" oninput="setCardNum(\'radius\',this.value)">'),
        '<div class="btnRow"><button onclick="resetCard()">底框恢复跟随主题</button></div>',
      row("霓虹档位", '<select onchange="setNodeNeon(this.value)">' +
        '<option value="">（跟随主题）</option>' +
        window.NEON_PRESETS.map(p => '<option value="' + attr(p) + '"' +
          (n.neonPreset === p ? " selected" : "") + '>' + esc(p) + '</option>').join("") +
        '</select>'),
      row("指针环", '<select onchange="setNodeNum(\'ringStyle\',this.value)">' +
        '<option value="0"' + (n.ringStyle === 0 ? " selected" : "") + '>0 · 无</option>' +
        '<option value="1"' + (n.ringStyle === 1 ? " selected" : "") + '>1 · 外圈刻度</option>' +
        '</select>'),
      row("环段数", numIn("ringSegments", n.ringSegments)),
      row("副参数", '<input value="' + attr((n.extraPids || []).join(",")) +
        '" placeholder="逗号分隔，如 obd.coolant,obd.intake" oninput="setNodeExtras(this.value)">'),
      '<div class="btnRow"><button onclick="applyPidDefaults()">按 PID 库回填量程与阈值</button></div>',
    ].join("");
  }

  function imageFields(n) {
    const opts = (S.design.assets || []).map(a =>
      '<option value="' + attr(a.id) + '"' + (n.assetId === a.id ? " selected" : "") + '>' +
      esc(a.name) + '（' + esc(a.kind) + '）</option>').join("");
    return [
      row("素材", '<select onchange="setNodeStr(\'assetId\',this.value)">' +
        '<option value="">（未选）</option>' + opts + '</select>'),
      '<div class="hint">素材从左侧**素材库**拖到画布即可添加新图片控件。</div>',
    ].join("");
  }

  function stateFields(n) {
    const st = n.states || {};
    const assetOpts = (sel) => '<option value="">（未选）</option>' +
      (S.design.assets || []).map(a =>
        '<option value="' + attr(a.id) + '"' + (sel === a.id ? " selected" : "") + '>' +
        esc(a.name) + '</option>').join("");

    let h = row("启用", '<label class="chk"><input type="checkbox"' + (n.states ? " checked" : "") +
      ' onchange="toggleStates(this.checked)"> 用状态替换单张图</label>');
    if (!n.states) {
      h += '<div class="hint">开启后，同一个控件可以按数值显示不同图片（正常/警告/严重），' +
        '位置与层级只写一次。详见 docs/主题设计大纲.md §四。</div>';
      return h;
    }
    h += row("驱动 PID", '<input value="' + attr(n.rawStatePid || window.ALIAS_OF[n.statePid] || n.statePid || "") +
      '" placeholder="如 obd.rpm（留空 = 恒定 normal）" oninput="setNodeStatePid(this.value)">');
      // 阈值：留空 = 跟随 PID 库。不同车/传感器的报警线不一样，必须能改
      h += row("警告阈值", '<input type="number" step="any" placeholder="跟随 PID 库" value="' +
        (n.stateWarn === null || n.stateWarn === undefined ? "" : window.r2(n.stateWarn)) +
        '" oninput="setStateThreshold(\'stateWarn\',this.value)">');
      h += row("严重阈值", '<input type="number" step="any" placeholder="默认取警告与上限的中点" value="' +
        (n.stateCritical === null || n.stateCritical === undefined ? "" : window.r2(n.stateCritical)) +
        '" oninput="setStateThreshold(\'stateCritical\',this.value)">');
    window.STATE_NAMES.forEach(s => {
      const v = st[s.v] || { assetId: "", alpha: 255, blink: false, blinkMs: 200 };
      h += '<div class="stateBox"><div class="stateName">' + esc(s.n) + '</div>' +
        row("图片", '<select onchange="setState(\'' + s.v + '\',\'assetId\',this.value)">' +
          assetOpts(v.assetId) + '</select>') +
        row("透明度", '<input type="number" min="0" max="255" value="' + v.alpha +
          '" oninput="setState(\'' + s.v + '\',\'alpha\',this.value)">') +
        row("闪烁", '<label class="chk"><input type="checkbox"' + (v.blink ? " checked" : "") +
          ' onchange="setState(\'' + s.v + '\',\'blink\',this.checked)"> 闪烁</label>' +
          '<input type="number" min="60" step="20" value="' + v.blinkMs +
          '" oninput="setState(\'' + s.v + '\',\'blinkMs\',this.value)" title="闪烁周期 ms">' +
          '</row>') +
        '</div>';
    });
    return h;
  }

  /** 文字控件：**内容**在「文字」组，**样式**在「字体」组（共用 fontFields） */
  function textFields(n) {
    return [
      row("内容", '<input value="' + attr(n.text) + '" oninput="setNodeStr(\'text\',this.value)">'),
    ].join("");
  }

  /**
   * **子部件编辑器**（v2.12.0）。
   *
   * 让用户把仪表拆成几个可替换的部件。**数组顺序 = 绘制顺序**（先画的在下），
   * 所以有"上移 / 下移"。
   *
   * 设计取舍：
   *  - **不用拖拽排序** —— 部件通常只有 2~4 个，上下按钮比拖拽更省事也更准
   *  - 每个部件**折叠显示** —— 5 个部件 × 9 个字段全摊开太长，看不下去
   *  - 指针独有 pivot / 扫描范围 —— 指针素材的轴心基本不在图片中心，必须能设
   */
  function partsFields(n) {
    const parts = n.parts || [];
    const assetOpts = (sel) => '<option value="">（未选）</option>' +
      (S.design.assets || []).map(a =>
        '<option value="' + attr(a.id) + '"' + (sel === a.id ? " selected" : "") + '>' +
        esc(a.name) + '</option>').join("");

    let h = '<div class="hint">把仪表拆成可替换的部件。<b>列表顺序 = 绘制顺序</b>（先画的在下）。' +
      '有部件时**不再用样式画法**，完全按这里拼。</div>';

    if (!parts.length) {
      h += '<div class="akempty">（空 —— 点下面的「＋ 加部件」开始拼；' +
        '或者保持空着，用上面的「样式」程序化绘制）</div>';
    }

    parts.forEach((p, i) => {
      const q = window.normalizePart(p);
      const kind = (window.PART_KINDS.find(k => k.v === q.kind) || {}).n || q.kind;
      const isNeedle = q.kind === "needle";
      const openKey = "part:" + i;
      const open = !collapsed[openKey];
      h += '<div class="partBox">' +
        '<div class="partHead" onclick="togglePart(' + i + ')">' +
        '<span class="pcaret">' + (open ? "▾" : "▸") + '</span>' +
        '<span class="partKind">' + esc(kind) + '</span>' +
        '<span class="partName">' + esc(q.assetId
          ? ((S.design.assets || []).find(a => a.id === q.assetId) || {}).name || q.assetId
          : "（未选素材）") + '</span>' +
        '<span class="tbtn" onclick="event.stopPropagation();movePart(' + i + ',-1)" title="上移（画得更早，在下层）">↑</span>' +
        '<span class="tbtn" onclick="event.stopPropagation();movePart(' + i + ',1)" title="下移（画得更晚，在上层）">↓</span>' +
        '<span class="tbtn" onclick="event.stopPropagation();delPart(' + i + ')" title="删除">✕</span>' +
        '</div>';
      if (open) {
        // 记录"当前展开的部件下标" —— setPartBool 靠它定位（见 app.js）
        window.__partEditIndex = i;
        h += '<div class="partBody">' +
          row("种类", '<select onchange="setPart(' + i + ',\'kind\',this.value)">' +
            window.PART_KINDS.map(k => '<option value="' + attr(k.v) + '"' +
              (q.kind === k.v ? " selected" : "") + '>' + k.icon + ' ' + esc(k.n) + '</option>').join("") +
            '</select>') +
          (q.kind === "value" ? "" :
            row("素材", '<select onchange="setPart(' + i + ',\'assetId\',this.value)">' +
              assetOpts(q.assetId) + '</select>')) +
          row("位置 x / y", numIn("__", 0) .replace(/oninput="[^"]*"/, 'oninput="setPartNum(' + i + ',\'x\',this.value)"')
            .replace(/value="[^"]*"/, 'value="' + window.r2(q.x) + '"') +
            numIn("__", 0).replace(/oninput="[^"]*"/, 'oninput="setPartNum(' + i + ',\'y\',this.value)"')
            .replace(/value="[^"]*"/, 'value="' + window.r2(q.y) + '"')) +
          row("尺寸 w / h", numIn("__", 0).replace(/oninput="[^"]*"/, 'oninput="setPartNum(' + i + ',\'w\',this.value)"')
            .replace(/value="[^"]*"/, 'value="' + window.r2(q.w) + '"') +
            numIn("__", 0).replace(/oninput="[^"]*"/, 'oninput="setPartNum(' + i + ',\'h\',this.value)"')
            .replace(/value="[^"]*"/, 'value="' + window.r2(q.h) + '"')) +
          // 扫描范围跟随仪表（v2.27.0）—— 双针表两根针通常共用同一段弧
          (isNeedle ? row("扫描范围",
            '<label class="chk"><input type="checkbox"' +
            (q.sweepFollow ? " checked" : "") +
            ' onchange="setPartBool(\'sweepFollow\',this.checked)"> 跟随仪表</label>' +
            (q.sweepFollow
              ? '<span class="hint inline">跟着第一个指针的扫描范围走</span>'
              : "")) : "") +
          row("透明度", '<input type="number" min="0" max="255" value="' + q.alpha +
            '" oninput="setPartNum(' + i + ',\'alpha\',this.value)">') +
            // ---- 子部件（v2.18.0 嵌套）
            // 子部件的 x/y 相对**本部件的轴心**，并继承本部件的旋转。
            // 放在部件展开体里（而不是另起一棵树）—— 嵌套是"这个部件的细节"，
            // 单独一棵树会让"哪个子部件属于谁"看不出来。
            '<div class="subParts">' +
            '<div class="hint">子部件（坐标相对本部件轴心，继承旋转）</div>' +
            (q.children && q.children.length
              ? (function () { const o2 = []; partRows(n, q.children, String(i), 1, o2); return o2.join(""); })()
              : '<div class="akempty">（无）</div>') +
            '<button class="mini" onclick="addPartChild(\'' + i + '\')">＋ 子部件</button>' +
            '</div>' +
          ((isNeedle || q.kind === "value") ? row("绑定 PID", '<select onchange="setPartPid(' + i + ',this.value)">' +
            '<option value="">（跟随仪表）</option>' +
            (function () {
              const groups = new Map();
              Object.entries(window.PID_ALIASES).forEach(function (kv) {
                const alias = kv[0], id = kv[1];
                const info = window.BUILTIN_PIDS[id];
                const g = info ? info.g : "其他";
                if (!groups.has(g)) groups.set(g, []);
                groups.get(g).push({ v: alias, l: alias + "  " + (info ? info.name : "") });
              });
              let h2 = "";
              groups.forEach(function (items, g) {
                h2 += '<optgroup label="' + attr(g) + '">';
                items.forEach(function (it) {
                  h2 += '<option value="' + attr(it.v) + '"' +
                    ((q.rawPid || q.pid) === it.v ? " selected" : "") + '>' + esc(it.l) + '</option>';
                });
                h2 += "</optgroup>";
              });
              return h2;
            })() + '</select>') : "") +
          // 绑了别的 PID 就用**那个 PID 的量程** —— 否则车速按转速的角度映射，
          // 指针几乎不动。这里显式提示一下量程来源。
          (isNeedle && q.pid ? (function () {
            const info = window.BUILTIN_PIDS[q.pid];
            return '<div class="hint">量程跟随该 PID：' +
              (info ? (window.r2(info.min) + " ~ " + window.r2(info.max) + (info.unit || "")) : "（未知 PID）") +
              '</div>';
          })() : "") +
          (isNeedle ? row("轴心 x / y", '<input type="number" step="0.01" value="' + q.pivotX +
            '" oninput="setPartNum(' + i + ',\'pivotX\',this.value)" title="相对自身，0.5 = 正中心">' +
            '<input type="number" step="0.01" value="' + q.pivotY +
            '" oninput="setPartNum(' + i + ',\'pivotY\',this.value)">') : "") +
          (isNeedle ? row("扫描范围", '<input type="number" value="' + q.sweepFrom +
            '" oninput="setPartNum(' + i + ',\'sweepFrom\',this.value)" title="起始角（度，0=正右，顺时针）">' +
            '<input type="number" value="' + q.sweepTo +
            '" oninput="setPartNum(' + i + ',\'sweepTo\',this.value)" title="结束角">' +
            '<button onclick="setPartSweep(' + i + ',135,405)">135→405</button></div>') : "") +
          (isNeedle ? "" : row("静态旋转", '<input type="number" step="0.5" value="' + q.rotation +
            '" oninput="setPartNum(' + i + ',\'rotation\',this.value)">')) +
          '</div>';
      }
      h += '</div>';
    });

    h += '<div class="btnRow">' +
      '<button onclick="addPart()">＋ 加部件</button>' +
      (parts.length ? '<button onclick="clearParts()" title="回到用「样式」程序化绘制">清空（用样式画）</button>' : "") +
      '</div>';
    return h;
  }
  /**
   * 渲染**部件树**（v2.18.0 支持嵌套）。
   *
   * 子部件缩进显示 —— 不缩进的话，嵌套结构在 UI 上完全看不出来，
   * 用户会以为子部件是同级部件（顺序、层级全乱）。
   *
   * @param path 用 "0" / "0.1" 这样的**路径**定位部件（嵌套下索引会歧义）
   */
  function partRows(n, list, path, depth, out) {
    list.forEach(function (p, i) {
      const q = window.normalizePart(p);
      const here = path ? (path + "." + i) : String(i);
      const pad = depth ? ' style="margin-left:' + (depth * 14) + 'px"' : "";
      out.push('<div class="prow"' + pad + '>' +
        '<span class="pkind">' + (depth ? "└ " : "") + esc(window.partKindName(q.kind)) + '</span>' +
        '<button class="mini" onclick="movePartPath(\'' + here + '\',-1)" title="上移">↑</button>' +
        '<button class="mini" onclick="movePartPath(\'' + here + '\',1)" title="下移">↓</button>' +
        (depth < 5 ? '<button class="mini" onclick="addPartChild(\'' + here + '\')" title="加子部件">＋子</button>' : "") +
        '<button class="mini" onclick="delPartPath(\'' + here + '\')" title="删除">×</button>' +
        '</div>');
      if (q.children && q.children.length) {
        partRows(n, q.children, here, depth + 1, out);
      }
    });
  }

  /** 按路径找到部件（及其所在数组与下标） */
  function findPartByPath(n, path) {
    const idx = String(path).split(".").map(Number);
    let list = n.parts, part = null;
    for (let k = 0; k < idx.length; k++) {
      if (!list || !list[idx[k]]) return null;
      part = window.normalizePart(list[idx[k]]);
      if (k < idx.length - 1) {
        if (!part.children) part.children = [];
        list[idx[k]] = part;
        list = part.children;
      }
    }
    return { list: list, index: idx[idx.length - 1], part: part, parent: n };
  }
  window.findPartByPath = findPartByPath;

  /** 加一个子部件（默认放个装饰 —— 最常用的是"指针上挂个配重/装饰"） */
  window.addPartChild = function (path) {
    const n = gaugeSel(); if (!n) return;
    const f = findPartByPath(n, path); if (!f) return;
    window.commit(function () {
      if (!f.part.children) f.part.children = [];
      f.part.children.push(window.normalizePart({ kind: "decor" }));
    }, "加子部件");
  };

  /** 删一个部件（支持路径） */
  window.delPartPath = function (path) {
    const n = gaugeSel(); if (!n) return;
    const f = findPartByPath(n, path); if (!f) return;
    window.commit(function () { f.list.splice(f.index, 1); }, "删除部件");
  };

  /** 上下移一个部件（支持路径） */
  window.movePartPath = function (path, dir) {
    const n = gaugeSel(); if (!n) return;
    const f = findPartByPath(n, path); if (!f) return;
    const j = f.index + dir;
    if (j < 0 || j >= f.list.length) return;
    window.commit(function () {
      const tmp = f.list[f.index]; f.list[f.index] = f.list[j]; f.list[j] = tmp;
    }, "移动部件");
  };

  /**
   * **字体属性表单**（文字控件与仪表标签共用）。
   *
   * @param font    字体对象（会被 normalizeFont 补齐）
   * @param prefix  写入函数的**前缀**：属性面板传 `setNodeFont`，
   *                控件编辑器传 `ceSetFont`。生成的 oninput 就是
   *                `前缀('family', this.value)` 这种形式
   * @param extra   额外行（HTML），追加在末尾
   *
   * 为什么抽成共用函数：字体有 7 个字段，如果属性面板和控件编辑器各写一遍，
   * 改一个字段就要改两处 —— 迟早分叉。
   */
  window.fontFields = function (font, prefix, extra) {
    const f = window.normalizeFont(font);
    const call = prefix + "('";
    return [
      row("字体", '<select onchange="' + call + 'family\',this.value)">' +
        window.FONT_FAMILIES.map(x => '<option value="' + attr(x.v) + '"' +
          (f.family === x.v ? " selected" : "") + '>' + esc(x.n) + '</option>').join("") + '</select>'),
      row("字号", '<input type="number" step="0.5" min="1" value="' + window.r2(f.size) +
        '" oninput="' + call + 'size\',this.value)">'),
      row("字重", '<select onchange="' + call + 'weight\',this.value)">' +
        window.FONT_WEIGHTS.map(x => '<option value="' + x.v + '"' +
          (f.weight === x.v ? " selected" : "") + '>' + esc(x.n) + '（' + x.v + '）</option>').join("") +
        '</select>'),
      row("斜体", '<label class="chk"><input type="checkbox"' + (f.italic ? " checked" : "") +
        ' onchange="' + call + 'italic\',this.checked)"> 斜体</label>'),
      row("字距", '<input type="number" step="0.5" min="-10" max="50" value="' + window.r2(f.letterSpacing) +
        '" oninput="' + call + 'letterSpacing\',this.value)">'),
      row("对齐", '<select onchange="' + call + 'align\',this.value)">' +
        window.FONT_ALIGNS.map(x => '<option value="' + attr(x.v) + '"' +
          (f.align === x.v ? " selected" : "") + '>' + esc(x.n) + '</option>').join("") + '</select>'),
      row("颜色", '<input value="' + attr(f.color) + '" placeholder="#RRGGBB" oninput="' + call +
        'color\',this.value)">' +
        '<input type="color" value="' + attr(f.color) + '" oninput="' + call + 'color\',this.value)" style="flex:0 0 34px;padding:1px">'),
      extra || "",
    ].join("");
  };

  // ================================================================ 素材管理器

  /**
   * 素材库。分类只是标签（大纲 §3.2），素材由用户导入。
   *
   * ⚠️ `file://` 下 **IndexedDB 不可用**（实测），所以：
   *   - 完整图片**按相对路径引用**（assets/xxx.png），与 App 的模型一致
   *   - 预览用内存里的 File 对象（objectURL）
   *   - 缩略图（64px data URL）缓存进 localStorage，重开还能看到
   */
  const THUMB_KEY = "studio.thumbs";
  let thumbs = {};
  try { thumbs = JSON.parse(localStorage.getItem(THUMB_KEY) || "{}"); } catch (e) { }

  function saveThumbs() {
    try { localStorage.setItem(THUMB_KEY, JSON.stringify(thumbs)); } catch (e) {
      // 超配额就丢掉一半最旧的
      const keys = Object.keys(thumbs);
      keys.slice(0, Math.floor(keys.length / 2)).forEach(k => delete thumbs[k]);
      try { localStorage.setItem(THUMB_KEY, JSON.stringify(thumbs)); } catch (e2) { }
    }
  }

  /** 把文件转成 64px 缩略图 dataURL */
  function makeThumb(file, cb) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 64;
      const c = document.createElement("canvas");
      const k = Math.min(size / img.naturalWidth, size / img.naturalHeight, 1);
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      cb(c.toDataURL("image/png"), img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => { URL.revokeObjectURL(url); cb(null, 0, 0); };
    img.src = url;
  }

  /**
   * 导入素材。
   *
   * @param file    用户选的文件
   * @param kind    分类
   * @param onDone  回调（拿到 asset 对象）
   */
  function importAsset(file, kind, onDone) {
    if (!file || !/^image\//.test(file.type)) {
      alert("只能导入图片文件（当前：" + (file ? file.type || "未知类型" : "空") + "）");
      return;
    }
    makeThumb(file, (dataUrl, w, h) => {
      const id = window.newId("as");
      // 路径：设计文件同目录下的 assets/ —— 与 App 的模型一致
      const safe = file.name.replace(/[\\/:*?"<>|]/g, "_");
      const asset = {
        id: id,
        name: file.name,
        kind: kind || "custom",
        path: "assets/" + safe,
        w: w, h: h, bytes: file.size,
      };
      if (dataUrl) { thumbs[id] = dataUrl; saveThumbs(); }
      // 本机预览：立刻用 objectURL 显示真实图片
      window.loadAssetImage(id, URL.createObjectURL(file));
      onDone && onDone(asset);
    });
  }
  window.importAsset = importAsset;

  /** 从缩略图缓存恢复预览（重开设计文件时） */
  function restoreThumbs() {
    Object.entries(thumbs).forEach(([id, dataUrl]) => {
      if (!S.assetUrls[id]) window.loadAssetImage(id, dataUrl);
    });
  }
  window.restoreThumbs = restoreThumbs;

  /**
   * **让每个素材都有可显示的 URL**。
   *
   * ## 为什么需要它（大 X 图标那个 bug）
   *
   * 画布画图片节点时查的是 `S.assetUrls[assetId]` —— 而那个表**只有导入的素材**
   * 才写得进去（导入时给的是 objectURL 或 dataURL）。
   * 内置素材只有 `path`（`assets/warning/lamp-warn.png`），查不到 →
   * 画布以为"没素材"，画了个紫框大 X。
   *
   * 修法：**path 本身就能当 URL 用** —— 工具就跑在 `tools/theme-studio/` 下，
   * 相对路径 `assets/…` 正好指向工具自己的素材目录。所以对没有 URL 的素材
   * 直接用 path 加载。
   *
   * 每次渲染素材库与每次画布重绘前调一次，代价极低（只是查表 + 首次建 Image）。
   */
  window.syncAssetImages = function () {
    const d = S.design;
    if (!d || !d.assets) return;
    d.assets.forEach(a => {
      if (S.assetUrls[a.id]) return;                 // 已有（导入的 objectURL / 缩略图）
      const url = a.data || a.path;
      if (url) window.loadAssetImage(a.id, url);
    });
  };

  /** 素材库面板 */
  /** 素材库搜索词（空 = 不过滤） */
  let assetQuery = "";
  window.setAssetQuery = function (v) {
    assetQuery = String(v || "");
    renderAssets();
    // 重新渲染后把光标放回搜索框，否则打一个字就失焦
    const inp = document.getElementById("assetSearch");
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  };

  /**
   * 渲染素材库。
   *
   * ## 排版（v2.6.0 重做）
   *
   * 原来是"一列折叠列表"，素材多了就没法看。现在分**两大区块**：
   *
   *   控件库 —— 内置控件 / 自定义控件（点一下先改再放）
   *   素材   —— 10 个分类，**缩略图网格**
   *
   * 三个具体改进：
   *  1. **缩略图网格**代替一行一个 —— 一屏能看十几个，形状一眼可辨
   *  2. **搜索框** —— 跨控件与素材过滤；搜索时**自动展开**命中的分类
   *  3. **空分类自动收起** —— 10 个空文件夹不再占满左栏（用户抱怨的"乱"主要在这）
   */
  // ================================================================ 素材分类（v2.19.0）

  /** 把分类配置存进 localStorage（与面板高度同一套做法） */
  function saveAssetKinds() {
    try {
      localStorage.setItem("icar-studio-asset-kinds", JSON.stringify({
        order: window.assetKindOrder,
        custom: window.customAssetKinds,
        names: window.assetKindNames,   // 显示名覆盖（v2.29.0）
      }));
    } catch (e) { /* 隐私模式下 localStorage 可能不可用 —— 不该因此崩掉 */ }
  }

  /** 读回分类配置。坏数据一律**退回出厂**，不让一个坏 JSON 卡住整个素材库 */
  window.loadAssetKinds = function () {
    try {
      const raw = localStorage.getItem("icar-studio-asset-kinds");
      if (!raw) return;
      const o = JSON.parse(raw);
      if (Array.isArray(o.order)) {
        const known = window.DEFAULT_ASSET_KINDS.map(function (k) { return k.v; });
        window.assetKindOrder = o.order.filter(function (v) { return typeof v === "string"; });
        // 出厂有、用户表里没有的补回去 —— 否则升级后新分类不显示
        known.forEach(function (v) { if (window.assetKindOrder.indexOf(v) < 0) window.assetKindOrder.push(v); });
      }
      if (o.names && typeof o.names === "object" && !Array.isArray(o.names)) {
        window.assetKindNames = {};
        Object.keys(o.names).forEach(function (k) {
          const n = String(o.names[k] || "").trim();
          if (n) window.assetKindNames[k] = n;
        });
      }
      if (Array.isArray(o.custom)) {
        window.customAssetKinds = o.custom
          .filter(function (k) { return k && typeof k.v === "string" && k.v; })
          .map(function (k) { return { v: String(k.v), n: String(k.n || k.v), icon: "\uD83D\uDCC1", custom: true }; });
      }
    } catch (e) { /* 坏数据 → 用出厂值 */ }
  };

  /**
   * **移动一个分类**（拖动排序用）。
   *
   * @param dir -1 上移 / +1 下移。用方向而不是目标下标：
   *   拖动实现里算目标下标要处理"拖过几个"的边界，容易差一。
   */
  window.moveAssetKind = function (v, dir) {
    const list = window.assetKindList().map(function (k) { return k.v; });
    const i = list.indexOf(v);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    window.assetKindOrder = list;
    saveAssetKinds();
    window.renderAssets();
  };

  /** **新建分类**。v 由名字生成（去空格、转小写、非字母数字换成 -） */
  window.addAssetKind = function () {
    const name = (window.prompt("新分类的名字？") || "").trim();
    if (!name) return;
    const v = "u-" + name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "");
    if (!v || v === "u-") { window.alert("这个名字生不出有效的分类标识，换个吧"); return; }
    if (window.assetKindList().some(function (k) { return k.v === v; })) {
      window.alert("已经有这个分类了");
      return;
    }
    window.customAssetKinds.push({ v: v, n: name, icon: "\uD83D\uDCC1", custom: true });
    window.assetKindOrder.push(v);
    saveAssetKinds();
    window.renderAssets();
  };

  /**
   * **删除自定义分类**。
   *
   * ⚠️ 只删分类，**不删素材** —— 素材的 kind 不变，只是没有分类标题了，
   * 会落到「未分类」里。删素材是不可逆的，不该跟"整理分类"混在一起。
   */
  window.delAssetKind = function (v) {
    if (!window.isCustomAssetKind(v)) { window.alert("内置分类不能删"); return; }
    const n = (S.design.assets || []).filter(function (a) { return (a.kind || "custom") === v; }).length;
    const msg = n ? ("这个分类下有 " + n + " 个素材。\n\n删掉分类后它们会落到「未分类」，素材本身不会丢。继续？")
                  : "删掉这个空分类？";
    if (!window.confirm(msg)) return;
    window.customAssetKinds = window.customAssetKinds.filter(function (k) { return k.v !== v; });
    window.assetKindOrder = window.assetKindOrder.filter(function (x) { return x !== v; });
    saveAssetKinds();
    window.renderAssets();
  };

  /** 恢复出厂分类顺序（自定义分类**留着**，只是排到最后） */
  /**
   * **给分类改名**（v2.29.0）。只改**显示名**，不动 `v`。
   *
   * 为什么不改 `v`：它是设计文件里的契约 —— 老设计文件写的是 `"kind":"background"`，
   * 改了 `v` 那些素材就落到"未分类"了。显示名是纯展示，改了没风险。
   */
  window.renameAssetKind = function (v) {
    const cur = window.assetKindName(v);
    const name = (window.prompt("分类的新名字？（只改显示，不影响设计文件）", cur) || "").trim();
    if (!name || name === cur) return;
    window.assetKindNames[v] = name;
    saveAssetKinds();
    window.renderAssets();
  };

  /** 恢复某个分类的出厂名（清掉覆盖） */
  window.resetAssetKindName = function (v) {
    if (!window.assetKindNames[v]) return;
    delete window.assetKindNames[v];
    saveAssetKinds();
    window.renderAssets();
  };

  /**
   * **把素材移到另一个分类**（v2.29.0）。
   *
   * 只改素材的 `kind` 字段 —— 不动 `path`。
   * 所以**磁盘上的文件不动**（还是原来那个目录），只是它现在归到别的分类下了。
   * 这是有意的：移动文件会让老设计文件的相对路径失效。
   */
  window.moveAssetToKind = function (assetId, kind) {
    const a = (S.design.assets || []).find(function (x) { return x.id === assetId; });
    if (!a || !kind || a.kind === kind) return;
    const from = window.assetKindName(a.kind || "custom");
    const to = window.assetKindName(kind);
    window.commit(function () { a.kind = kind; }, "移动素材：" + from + " → " + to);
    toast("已移到「" + to + "」");
  };

  window.resetAssetKinds = function () {
    if (!window.confirm("恢复出厂？（顺序与**显示名**都恢复，自定义分类保留并排到最后）")) return;
    window.assetKindNames = {};   // 显示名也一起恢复（v2.29.0）
    window.assetKindOrder = window.DEFAULT_ASSET_KINDS.map(function (k) { return k.v; })
      .concat(window.customAssetKinds.map(function (k) { return k.v; }));
    saveAssetKinds();
    window.renderAssets();
  };

  /**
   * 把控件渲染成**按分类分组**的芯片网格（v2.22.0）。
   *
   * 为什么要分组：控件从 40 涨到 78 个，平铺成一个网格已经很难找了。
   * 分组标题 + 组内数量让"我想要的在哪一块"一眼可见。
   *
   * ⚠️ 组的顺序用 `window.CTRL_CATS`（**固定数组**），不是"按出现顺序"——
   * 后者会在每次改动控件代码时让组序乱跳。
   */
  function ctrlChipsHTML(list) {
    const chip = c =>
      '<div class="ctrlChip" onclick="editBuiltinControl(\'' + attr(c.key) + '\')" draggable="true"' +
      ' ondragstart="ctrlDragStart(event,\'' + attr(c.key) + '\')"' +
      ' title="' + attr(c.name) + '（点击：先修改再放入 ｜ 拖拽：直接放入）">' +
      '<span class="ccIcon">' + c.icon + '</span><span class="ccName">' + esc(c.name) + '</span></div>';

    const cats = (window.CTRL_CATS || []).filter(cat => list.some(c => c.cat === cat));
    // 兜底：没归到任何已知分类的（比如以后加了新前缀但忘了加规则）
    const other = list.filter(c => cats.indexOf(c.cat) < 0);
    let h = cats.map(cat => {
      const group = list.filter(c => c.cat === cat);
      return '<div class="ctrlCat">' + esc(cat) +
        '<span class="ctrlCatN">' + group.length + '</span></div>' +
        '<div class="ctrlGrid">' + group.map(chip).join("") + '</div>';
    }).join("");
    if (other.length) {
      h += '<div class="ctrlCat">其它<span class="ctrlCatN">' + other.length + '</span></div>' +
        '<div class="ctrlGrid">' + other.map(chip).join("") + '</div>';
    }
    // ⚠️ **包一层有高度上限的可滚容器**（v2.23.0）。
    //
    // 控件涨到 112 个之后，控件网格把**整个素材网格挤出了视口** ——
    // 用户打开工具只看到控件，一个素材都看不到（实测 0/319 可见）。
    //
    // 给它自己一个滚动区，控件再多也不会侵占素材的位置。
    return '<div class="ctrlScroll">' + h + '</div>';
  }

  /**
   * **素材悬停大图**（v2.24.0）。
   *
   * 为什么需要：缩略图只有 62px，像"碳纤维 vs 拉丝"、"两种刻度"这种差别，
   * 在小图上根本看不出来 —— 用户只能一个个拖到画布上试。
   *
   * 定位规则：默认贴鼠标右侧；**右边放不下就翻到左侧**，
   * 下边放不下就往上收 —— 否则靠近面板边缘的素材会弹到屏幕外。
   */
  window.showAssetPreview = function (el, src, label) {
    const box = document.getElementById("assetPreview");
    if (!box || !src) return;
    const r = el.getBoundingClientRect();
    const W = 200, H = 200;   // 浮层尺寸（与 CSS 一致）
    let x = r.right + 10;
    let y = r.top;
    if (x + W > window.innerWidth - 8) x = r.left - W - 10;
    if (x < 8) x = 8;
    if (y + H > window.innerHeight - 8) y = window.innerHeight - H - 8;
    if (y < 8) y = 8;
    box.style.left = x + "px";
    box.style.top = y + "px";
    box.innerHTML = '<img src="' + attr(src) + '" alt="">' +
      '<div class="apName">' + esc(label || "") + '</div>';
    box.classList.add("on");
  };

  window.hideAssetPreview = function () {
    const box = document.getElementById("assetPreview");
    if (box) box.classList.remove("on");
  };

  function renderAssets() {
    const box = el("assets");
    if (!box) return;
    const d = S.design;
    if (!d) { box.innerHTML = ""; return; }

    const q = assetQuery.trim().toLowerCase();
    // 搜索命中判定（v2.51.0 支持**拼音**）。
//
// 三种输入都认：
//   `碳纤维`      原文（含英文名，比如 `turn-left`）
//   `tanxianwei`  全拼
//   `txw`         首字母
//
// 原来的实现只有第一条 —— 中文界面里搜东西得切输入法，很别扭。
// `window.matchPinyin` 在 `js/pinyin.js` 里（表只覆盖现有名字用到的 368 个字，
// 几 KB；以后名字里出现生字要往那个表里加）。
const hit = s => !q
  || String(s).toLowerCase().indexOf(q) >= 0
  || (window.matchPinyin ? window.matchPinyin(s, q) : false);

    const mine = d.assets || [];
    const builtin = window.BUILTIN_ASSETS || [];
    const havePath = {};
    mine.forEach(a => { havePath[a.path] = true; });

    // 先把内置素材的位图挂上（否则画布上是大 X，见 syncAssetImages 的注释）
    window.syncAssetImages();

    // ---- 面板头（常驻）+ 搜索框 + **可滚动的内容区**
    //
    // ⚠️ 内容区必须自己滚动：`#assets` 是 `overflow:hidden` 的 flex 容器，
    // 直接往里塞内容会被裁掉且**滚不动** —— 这正是"素材库无法滚动"的原因。
    const head = '<div class="panelBar">' +
      '<span class="pbCaret" onclick="togglePanelCollapse(\'assets\')">' +
      (panelCollapsed.assets ? "▸" : "▾") + '</span>' +
      '<span class="pbTitle" onclick="togglePanelCollapse(\'assets\')">素材库</span>' +
      '<span class="pbCount">' + mine.length + (builtin.length ? " + " + builtin.length : "") + '</span>' +
      '<span class="pbBtn" onclick="event.stopPropagation();assetsExpandAll(true)" title="展开全部分类">⊞</span>' +
      '<span class="pbBtn" onclick="event.stopPropagation();assetsExpandAll(false)" title="折叠全部分类">⊟</span>' +
        // 分类的新建 / 排序 / 恢复（v2.19.0）。
        // 排序用 ↑↓ 而不是真拖动：分类标题是整行可点的折叠头，
        // 在它上面做 drag 会与"点一下折叠"打架（实测很容易误触发）。
        '<span class="pbBtn" onclick="event.stopPropagation();addAssetKind()" title="新建分类">＋分类</span>' +
        '<span class="pbBtn" onclick="event.stopPropagation();resetAssetKinds()" title="恢复出厂分类顺序">⟲</span>' +
      '</div>';

    let h = head + '<div class="panelScroll" id="assetsBody">' +
      '<div class="assetSearchWrap">' +
      '<input id="assetSearch" placeholder="搜索控件 / 素材…" value="' + attr(assetQuery) + '"' +
      ' oninput="setAssetQuery(this.value)">' +
      (q ? '<span class="tbtn" onclick="setAssetQuery(\'\')" title="清空">✕</span>' : '') +
      '</div>';

    // ================================================================ 控件库
    const ctrls = window.BUILTIN_CONTROLS.filter(c => hit(c.name));
    const saved = (d.controls || []).filter(c => hit(c.name));
    const ctrlTotal = ctrls.length + saved.length;
    if (!q || ctrlTotal) {
      h += '<div class="asection">控件库</div>';

      // 内置控件
      h += assetFolder({
        key: "__ctrl", icon: "🧩", title: "内置控件", count: ctrls.length,
        autoOpen: true, forceOpen: !!q, extraBtn: '<span class="tbtn" onclick="event.stopPropagation();importControlJson()" title="导入控件 JSON">⇩</span>',
      body: ctrls.length ? ctrlChipsHTML(ctrls)
        : (q ? '<div class="akempty">没有匹配的控件</div>' : '<div class="akempty">（无）</div>'),
      });

      // 自定义控件
      //
      // ⚠️ **搜索时，没命中的分类要整个跳过**（v2.46.0）。
      //
      // 素材分类早就是这么做的（见下面的 `anyKind`），控件这块漏了 ——
      // 于是搜「圆表」时会看到一个空的「★ 自定义控件 0」，
      // 而且里面的提示是"右键控件 → 保存到素材库"，**跟搜索完全无关**。
      // 搜索的意图是"找东西"，显示空分类只是噪音（还占一行滚动）。
      if (!q || saved.length) {
      h += assetFolder({
        key: "__myctrl", icon: "★", title: "自定义控件", count: saved.length,
        autoOpen: false, forceOpen: !!q,
        body: saved.length
          ? '<div class="ctrlGrid">' + saved.map(c =>
              '<div class="ctrlChip" onclick="editSavedControl(\'' + attr(c.id) + '\')" draggable="true"' +
              ' ondragstart="savedCtrlDragStart(event,\'' + attr(c.id) + '\')"' +
              ' title="' + attr(c.name) + '">' +
              '<span class="ccIcon">★</span><span class="ccName">' + esc(c.name) + '</span>' +
              '<span class="ccDel" onclick="event.stopPropagation();delSavedControl(\'' + attr(c.id) + '\')" title="删除">✕</span>' +
              '</div>'
            ).join("") + '</div>'
          // 搜索语境下说"没有匹配"才贴切；"去素材库保存"跟搜索无关
          : (q ? '<div class="akempty">没有匹配的自定义控件</div>'
               : '<div class="akempty">（空 —— 右键控件 →「编辑控件…」→「保存到素材库」）</div>'),
      });
      }   // ← 对应上面的 `if (!q || saved.length)`
    }

    // ================================================================ 素材
    h += '<div class="asection">素材</div>';
    let anyKind = false;
    window.assetKindList().forEach(k => {
      const mineK = mine.filter(a => a.kind === k.v && hit(a.name));
      const builtK = builtin.filter(a => a.kind === k.v && hit(a.label || a.name));
      const total = mineK.length + builtK.length;
      // 搜索时：没命中的分类直接隐藏（否则 10 个空标题很吵）
      if (q && !total) return;
      anyKind = true;

      let body = '<div class="assetGrid">';
      // 内置示例（已加入设计的就不再重复列）
      builtK.forEach(a => {
        const used = havePath[a.path];
        body += '<div class="assetThumb' + (used ? " used" : "") + '"' +
          ' onclick="useBuiltinAsset(\'' + attr(a.path) + '\')"' +
          // 悬停看大图（缩略图 62px 认不出细节）
          ' onmouseenter="showAssetPreview(this, \'' + attr(a.path) + '\', \'' + attr(a.label || a.name) + '\')"' +
          ' onmouseleave="hideAssetPreview()"' +
          ' title="' + attr(a.label || a.name) + '（内置示例' + (used ? "，已加入" : "，点击加入并放置") + '）">' +
          '<img src="' + attr(a.path) + '" alt="" loading="lazy">' +
          '<span class="atName">' + esc(a.label || a.name) + '</span>' +
          (used ? '<span class="atBadge">已用</span>' : '') +
          '</div>';
      });
      // 用户导入的
      mineK.forEach(a => {
        body += '<div class="assetThumb"' +
          ' onclick="addImageNode(\'' + attr(a.id) + '\')"' +
          ' draggable="true" ondragstart="assetDragStart(event,\'' + attr(a.id) + '\')"' +
          ' title="' + attr(a.name) + '（点击放到画布中央 ｜ 拖拽放到落点）">' +
          (a.data
            ? '<img src="' + attr(a.data) + '" alt="">'
            : '<div class="atNoImg">无预览</div>') +
          '<span class="atName">' + esc(a.name) + '</span>' +
          // 「改分类」下拉（v2.29.0）。用 select 而不是拖拽：
          // 拖拽要处理跨分类的落点判定，而这里只改一个 kind 字段 ——
          // 下拉更直接，也不会和"拖到画布"冲突（那个是 draggable）。
          '<select class="atKind" title="移到别的分类" onclick="event.stopPropagation()"' +
          ' onchange="event.stopPropagation();moveAssetToKind(\'' + attr(a.id) + '\',this.value)">' +
          window.assetKindList().map(function (kk) {
            return '<option value="' + attr(kk.v) + '"' + ((a.kind || "custom") === kk.v ? " selected" : "") + '>' + esc(window.assetKindName(kk.v)) + '</option>';
          }).join("") + '</select>' +
          '<span class="atDel" onclick="event.stopPropagation();delAsset(\'' + attr(a.id) + '\')" title="移除">✕</span>' +
          '</div>';
      });
      body += '</div>';

      h += assetFolder({
        sortable: true,
        key: k.v, icon: "📁", title: k.n, count: total,
        // 空分类默认收起；有内容才自动展开（这就是"不乱"的关键）
        autoOpen: total > 0, forceOpen: !!q,
        extraBtn: '<span class="tbtn" onclick="event.stopPropagation();pickAsset(\'' + attr(k.v) + '\')" title="导入图片到「' + attr(k.n) + '」">＋</span>',
        body: body,
      });
    });
    if (q && !anyKind) h += '<div class="akempty">没有匹配的素材</div>';

    h += '<div class="hint">内置示例是**几何图形**（不含任何车标），可直接用。' +
      '导入自己的图请点分类上的 ＋。整个 <code>assets/</code> 要和设计文件一起拷贝。</div>';

    h += '</div>';   // 关掉 panelScroll
    // 底部的拖拽手柄：调整素材库高度（否则展开会把控件树挤出去）
    h += '<div class="panelResize" onpointerdown="beginPanelResize(event,\'assets\')" title="拖动调整高度"></div>';

    box.innerHTML = h;
    applyPanelCollapse("assets");
  }

  // ================================================================ 面板折叠 / 高度

  /** 各面板是否收起 */
  const panelCollapsed = { assets: false, tree: false };
  /**
   * 各面板的**拖拽高度**（px）。0 = 用 CSS 里的默认值。
   *
   * 泛化成一张表是因为"素材库"和"属性面板"的需求完全一样 ——
   * 各写一份迟早分叉（比如一边能持久化、另一边忘了）。
   */
  const panelHeights = { assets: 0, props: 0 };
  /** 各面板的**最小高度**（拖不出更矮的） */
  const PANEL_MIN = { assets: 80, props: 100 };
  const PANEL_KEY = "icar-studio-panels";

  function loadPanelState() {
    try {
      const o = JSON.parse(localStorage.getItem(PANEL_KEY) || "{}");
      if (typeof o.assetsCollapsed === "boolean") panelCollapsed.assets = o.assetsCollapsed;
      if (typeof o.treeCollapsed === "boolean") panelCollapsed.tree = o.treeCollapsed;
      if (typeof o.assetHeight === "number" && o.assetHeight > 60) panelHeights.assets = o.assetHeight;
      if (typeof o.propsHeight === "number" && o.propsHeight > 60) panelHeights.props = o.propsHeight;
      // 等比缩放锁（v2.26.0）：这是**用户偏好**，不是布局 —— 但一起存最省事，
      // 而且它本来就是"面板上的一个开关"。
      if (typeof o.aspectLock === "boolean") window.CanvasState.aspectLock = o.aspectLock;
    } catch (e) { /* 坏数据就忽略，用默认 */ }
  }
  function savePanelState() {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify({
        assetsCollapsed: panelCollapsed.assets,
        treeCollapsed: panelCollapsed.tree,
        assetHeight: panelHeights.assets,
        propsHeight: panelHeights.props,
        // 等比锁也存（v2.26.0）—— 不然关掉后重开页面又回到默认开
        aspectLock: (window.CanvasState || {}).aspectLock !== false,
      }));
    } catch (e) { /* 配额满了不是致命错误 */ }
  }
  window.loadPanelState = loadPanelState;
  window.savePanelState = savePanelState;

  /**
   * 收起 / 展开一个面板。
   *
   * 收起时面板变成 `flex: 0 0 auto`（只剩标题条），把空间让给别的面板 ——
   * 这就是用户要的"收起来"。
   */
  window.togglePanelCollapse = function (which) {
    panelCollapsed[which] = !panelCollapsed[which];
    savePanelState();
    if (which === "assets") renderAssets(); else renderTree();
  };

  /** 把折叠状态落到 DOM 上 */
  function applyPanelCollapse(which) {
    const box = document.getElementById(which);
    if (!box) return;
    const collapsed = !!panelCollapsed[which];
    box.classList.toggle("collapsed", collapsed);
    // 通用：有拖拽高度就用它，否则清掉让 CSS 的默认值生效
    const h = panelHeights[which];
    if (!collapsed && h > 0) box.style.height = h + "px";
    else box.style.height = "";
  }
  window.applyPanelCollapse = applyPanelCollapse;

  /**
   * 拖拽调整素材库高度。
   *
   * 用户明确要求"素材库固定好高度，不然展开就把控件树挤出去了" ——
   * 固定高度 + 可拖拽是最实用的组合：默认给一个合理值，需要时自己调。
   */
  /**
   * 拖拽调整面板高度。**素材库与属性面板共用**。
   *
   * 上限用 `window.innerHeight - 220` —— 给顶栏、消息区、JSON 页签留出空间，
   * 否则用户可以把面板拖到占满整屏、别的什么都够不着。
   */
  window.beginPanelResize = function (ev, which) {
    ev.preventDefault();
    const box = document.getElementById(which);
    if (!box) return;
    const startY = ev.clientY;
    const rect0 = box.getBoundingClientRect();
    const startH = rect0.height;
    const minH = PANEL_MIN[which] || 80;
    /**
     * 上限只做**兜底**（不让面板占满整屏），不按面板位置卡死。
     *
     * ⚠️ 第一版按"面板顶部到视口底部"算，结果属性面板在右栏里
     * 顶部已经在 y=778，可用只剩 132px —— **往下拖反而变矮**，很反直觉。
     * 右栏本来就能滚动，"面板底部超出视口"不是问题，滚一下就看到。
     */
    const maxH = Math.max(minH, window.innerHeight - 200);
    const move = e => {
      const h = Math.max(minH, Math.min(startH + (e.clientY - startY), maxH));
      panelHeights[which] = Math.round(h);
      box.style.height = panelHeights[which] + "px";
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      savePanelState();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  window.panelHeights = panelHeights;

  /**
   * 一个折叠分类的外壳。
   *
   * @param autoOpen  没有用户手动设置时的默认状态
   * @param forceOpen 搜索时强制展开（用户明确在找东西，别让他再点一次）
   */
  function assetFolder(o) {
    const userSet = collapsed["ak:" + o.key];
    const open = o.forceOpen ? true : (userSet === undefined ? o.autoOpen : !userSet);
    return '<div class="akind">' +
      '<div class="akhead" onclick="toggleAssetKind(\'' + attr(o.key) + '\')">' +
      '<span class="pcaret">' + (open ? "▾" : "▸") + '</span>' +
      '<span class="akname">' + o.icon + " " + esc(o.title) + '</span>' +
      '<span class="treeCount">' + o.count + '</span>' +
      // 分类排序 / 删除（v2.19.0）。
      // ⚠️ 只对**素材分类**显示（o.sortable）—— 控件树的文件夹不该有这些。
      // 用 ↑↓ 而不是真拖动：标题行是整行可点的折叠头，
      // 在上面做 drag 会与「点一下折叠」打架（很容易误触发）。
      (o.sortable ?
        '<span class="tbtn" onclick="event.stopPropagation();moveAssetKind(\'' + attr(o.key) + '\',-1)" title="上移分类">↑</span>' +
        '<span class="tbtn" onclick="event.stopPropagation();moveAssetKind(\'' + attr(o.key) + '\',1)" title="下移分类">↓</span>' +
        '<span class="tbtn" onclick="event.stopPropagation();renameAssetKind(\'' + attr(o.key) + '\')" title="改显示名（不动设计文件）">✎</span>' +
        (window.isCustomAssetKind(o.key)
          ? '<span class="tbtn" onclick="event.stopPropagation();delAssetKind(\'' + attr(o.key) + '\')" title="删除分类（素材不丢）">✕</span>'
          : "")
        : "") +
      (o.extraBtn || "") +
      '</div>' +
      (open ? '<div class="akitems">' + o.body + '</div>' : "") +
      '</div>';
  }

  /**
   * 用内置示例素材：**加入设计 + 直接放到画布**。
   *
   * 为什么要"加入设计"而不是只放一个图片节点：设计文件的 `assets[]` 是
   * **素材清单**，App 侧靠它把 `assetId` 解析成路径。不登记的话
   * 推到设备上就是一片空白。
   */
  /**
 * 确保某个内置素材**已登记进当前设计**，返回它的 assetId。
 *
 * 控件模板（图片类、警告灯、拼装表）在 make() 时要用素材 ——
 * 不登记的话拖出来就是个紫框大 X。
 *
 * ⚠️ 它会**改 S.design.assets**。调用点都在 commit 内部（拖放/新建），
 * 所以是安全的；不要在只读路径里调它。
 */
window.ensureBuiltinAsset = function (path) {
  const d = S.design;
  if (!d || !path) return "";
  const exist = (d.assets || []).find(x => x.path === path);
  if (exist) return exist.id;
  const b = (window.BUILTIN_ASSETS || []).find(x => x.path === path);
  const id = window.newId("as");
  if (!d.assets) d.assets = [];
  d.assets.push({
    id: id,
    name: b ? (b.label || b.name) : path.split("/").pop(),
    kind: b ? b.kind : "custom",
    path: path,
    data: b ? b.data : "",
    w: b ? b.w : 0, h: b ? b.h : 0,
    builtin: true,
  });
  return id;
};
window.useBuiltinAsset = function (path) {
    const b = (window.BUILTIN_ASSETS || []).find(a => a.path === path);
    if (!b) { toast("找不到这个内置素材"); return; }
    let id = (S.design.assets || []).find(a => a.path === path)?.id;
    if (!id) {
      id = window.newId("as");
      window.commit(() => {
        if (!S.design.assets) S.design.assets = [];
        S.design.assets.push({
          id: id, name: b.label || b.name, kind: b.kind, path: b.path,
          // data 只给工具预览用；**序列化时不写出**（见 model.js 的 root.assets）
          data: b.data,
          w: b.w, h: b.h, builtin: true,
        });
      }, "加入内置素材：" + (b.label || b.name));
    }
    window.addImageNode(id);
  };
  window.renderAssets = renderAssets;

  /**
   * 素材库：折叠 / 展开全部分类。
   *
   * ⚠️ **展开时跳过空分类** —— 空文件夹展开只显示一片「（空）」，
   * 既没用又把面板撑长（用户抱怨的"乱"）。这与"空分类默认收起"是同一个意图。
   */
  /**
   * 恢复**默认排版**：清掉所有手动折叠记录。
   *
   * 用途：面板被折得乱七八糟之后一键回到"有内容的展开、空的收起"。
   * 单测也用它拿确定性基线 —— 比清 localStorage 再重载可靠得多
   * （重载会丢掉内存里的设计状态）。
   */
  window.resetPanelLayout = function () {
    Object.keys(collapsed).forEach(k => delete collapsed[k]);
    saveCollapsed();
    renderAssets();
    if (typeof renderTree === "function") renderTree();
    window.toast("面板排版已恢复默认");
  };

  window.assetsExpandAll = function (open) {
    const d = S.design;
    const mine = (d && d.assets) || [];
    const builtin = window.BUILTIN_ASSETS || [];
    const has = k => mine.some(a => a.kind === k) || builtin.some(a => a.kind === k);

    window.assetKindList().forEach(k => {
      if (open && !has(k.v)) return;        // 空的：展开没意义，保持收起
      collapsed["ak:" + k.v] = !open;
    });
    if (!open || (d && (d.controls || []).length)) collapsed["ak:__myctrl"] = !open;
    collapsed["ak:__ctrl"] = !open;         // 内置控件永远有内容
    saveCollapsed();
    renderAssets();
    const skipped = open ? window.assetKindList().filter(k => !has(k.v)).length : 0;
    window.toast(open
      ? ("已展开有内容的分类" + (skipped ? "（跳过 " + skipped + " 个空的）" : ""))
      : "素材库已全部折叠");
  };

  window.toggleAssetKind = function (k) {
    collapsed["ak:" + k] = !collapsed["ak:" + k];
    saveCollapsed();
    renderAssets();
  };

  // ---- 控件库的交互

  /** 单击内置控件 → 打开编辑器（"先改再放"，也就是用户说的"控件修改状态"） */
  window.editBuiltinControl = function (key) {
    const c = window.BUILTIN_CONTROLS.find(x => x.key === key);
    if (!c) return;
    window.openControlEditor(null, c.make());
  };

  /** 单击自定义控件 → 同样先打开编辑器 */
  window.editSavedControl = function (id) {
    const c = (S.design.controls || []).find(x => x.id === id);
    if (!c) return;
    window.openControlEditor(null, c.node);
  };

  window.delSavedControl = function (id) {
    const c = (S.design.controls || []).find(x => x.id === id);
    if (!c) return;
    if (!confirm("从素材库移除「" + c.name + "」？\n（已经放到画布上的控件不受影响）")) return;
    window.commit(() => {
      S.design.controls = (S.design.controls || []).filter(x => x.id !== id);
    }, "删除自定义控件：" + c.name);
  };

  /** 拖拽控件到画布 → 直接实例化（不用先过编辑器） */
  window.ctrlDragStart = function (ev, key) {
    ev.dataTransfer.setData("application/x-ctrl", key);
    ev.dataTransfer.effectAllowed = "copy";
  };
  window.savedCtrlDragStart = function (ev, id) {
    ev.dataTransfer.setData("application/x-sctrl", id);
    ev.dataTransfer.effectAllowed = "copy";
  };

  let pickingKind = "custom";
  window.pickAsset = function (kind) {
    pickingKind = kind;
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.multiple = true;
    inp.onchange = () => {
      const files = Array.from(inp.files || []);
      if (!files.length) return;
      let pending = files.length;
      window.beginBatch("导入 " + files.length + " 个素材");
      files.forEach(f => {
        importAsset(f, pickingKind, asset => {
          S.design.assets.push(asset);
          if (--pending === 0) {
            window.endBatch();
            renderAssets();
            renderProps();
          }
        });
      });
    };
    inp.click();
  };

  /** 素材拖到画布 → 新建图片控件 */
  window.assetDragStart = function (ev, assetId) {
    ev.dataTransfer.setData("application/x-asset", assetId);
    ev.dataTransfer.effectAllowed = "copy";
  };

  window.selectAsset = function (assetId) {
    // 单击素材：如果有选中的图片控件，就把它的素材换掉
    if (S.selection.length === 1) {
      const n = window.findNode(S.design.nodes, S.selection[0]);
      if (n && n.type === window.NODE_IMAGE) {
        window.commit(() => { n.assetId = assetId; }, "更换素材");
        return;
      }
    }
    // 否则直接新建一个
    addImageNode(assetId);
  };

  window.addImageNode = function (assetId) {
    const a = assetId ? (S.design.assets || []).find(x => x.id === assetId) : null;
    // ⚠️ **必须按比例缩放**（用户报的"添加进去全都是扁的"就是这个）。
    //
    // 原来的写法是 w 与 h **各自独立夹取**：
    //   w = clamp(a.w / a.h * 90, 40, 200)
    //   h = clamp(90, 40, 200)   // 恒等于 90
    // 于是任何宽高比超出 40/90 ~ 200/90 的素材都被压扁 ——
    // 256×64 的横条（比例 4.0）会变成 200×90（比例 2.2）。
    //
    // 正确做法：先定"最长边 = 90"，另一边按比例算；
    // 夹取时**两边一起乘同一个系数**，比例才不会被破坏。
    let w = 90, h = 90;
    const nat = naturalSizeOf(a, assetId);
    if (nat) {
      const ar = nat[0] / nat[1];
      const LONG = 90;
      // 这里不用 MIN/MAX 直接夹 w、h —— 那会**各自独立**夹，比例就废了。
      // 全程只算一个**整体缩放系数 k**。
      if (ar >= 1) { w = LONG; h = LONG / ar; }
      else { h = LONG; w = LONG * ar; }

      // ① 短边不能小于 MIN：太细的素材（比如 1×256 的分隔线）会窄到点不中。
      const MIN = 12;
      if (w < MIN) { const k = MIN / w; w *= k; h *= k; }
      if (h < MIN) { const k = MIN / h; w *= k; h *= k; }

      // ② ⚠️ **长边不能超过画布**（v2.48.0 修）。
      //
      // 上面那条 MIN 是"整体放大"，比例越极端放得越大：
      //   256×8 的分隔线（比 32）→ 90×2.8 → 撑短边到 12 → **384×12**
      //   而画布只有 **360** 宽 —— 加进去就比整个画布还宽，直接被裁掉。
      //
      // **这条优先于 MIN**：宁可短边略低于 12，也不能让节点超出画布。
      // （比 29.6 更极端的比例下两条约束无法同时满足，必须选一个。）
      const CAP = 355;   // 留 5 个单位的余量
      const longSide = Math.max(w, h);
      if (longSide > CAP) { const k = CAP / longSide; w *= k; h *= k; }

      w = Math.round(w); h = Math.round(h);
      // 取整后可能又超一点点，再夹一次（比例已经定型，这次只影响 1 个单位以内）
      if (Math.max(w, h) > CAP) { if (w >= h) w = CAP; else h = CAP; }
    }
    // else：素材既没有 w/h、位图也没加载 —— 只能先用正方形兜底。
    // 这不是"正确"的尺寸，所以补一次**异步重算**（见下面的 refitImageNode）。
    window.commit(() => {
      const n = window.createNode(window.NODE_IMAGE, {
        name: a ? a.name.replace(/\.[^.]+$/, "") : "图片",
        assetId: assetId || "",
        x: 20, y: 20, w: w, h: h,
        z: nextTopZ(),
      });
      S.design.nodes.push(n);
      S.selection = [n.id];
    }, "添加图片控件");

    // ⚠️ **没有自然尺寸时，靠位图异步补算**（v2.48.0）。
    //
    // 上面 `nat` 为 null 时只能给 90×90 正方形 —— 而正方形对一张
    // 256×8 的分隔线来说就是"扁掉"（用户报的就是这个）。
    // 素材的位图是**异步加载**的，等它到了再按真实比例修一次。
    if (!nat && assetId) refitImageNodeWhenBitmapReady(assetId);
  };

  /**
   * 位图到位后，把刚加进画布的节点按**真实比例**重修一次。
   *
   * 只在 `addImageNode` 拿不到自然尺寸时才会走到这里。
   * 最多等 3 秒（位图可能在设计文件里，加载更慢）。
   */
  function refitImageNodeWhenBitmapReady(assetId) {
    let tries = 0;
    const tick = () => {
      tries++;
      const bmp = window.assetBitmap ? window.assetBitmap(assetId) : null;
      if (bmp && bmp.naturalWidth > 0 && bmp.naturalHeight > 0) {
        const n = S.design.nodes.find(x => x.assetId === assetId && x.w === x.h);
        if (n) {
          const ar = bmp.naturalWidth / bmp.naturalHeight;
          const LONG = 90, MIN = 12, CAP = 355;
          let w, h;
          if (ar >= 1) { w = LONG; h = LONG / ar; } else { h = LONG; w = LONG * ar; }
          if (w < MIN) { const k = MIN / w; w *= k; h *= k; }
          if (h < MIN) { const k = MIN / h; w *= k; h *= k; }
          const longSide = Math.max(w, h);
          if (longSide > CAP) { const k = CAP / longSide; w *= k; h *= k; }
          window.commit(() => { n.w = Math.round(w); n.h = Math.round(h); }, "按真实比例修正素材尺寸");
        }
        return;
      }
      if (tries < 30) setTimeout(tick, 100);
    };
    setTimeout(tick, 60);
  }

  /**
   * 素材的**原始宽高**（用于按比例定新节点的尺寸）。
   *
   * 优先用素材记录里的 w/h；没有就退回已加载 bitmap 的自然尺寸。
   * 两个都没有 → null（调用方用正方形兜底）。
   *
   * 为什么要退回 bitmap：手改过的设计文件 / 早期版本可能没记 w/h，
   * 那种情况下"变扁"比"没有尺寸"更糟 —— 用户看到的是一张压变形的图。
   */
  function naturalSizeOf(a, assetId) {
    if (a && a.w > 0 && a.h > 0) return [a.w, a.h];
    const bmp = assetId && window.assetBitmap ? window.assetBitmap(assetId) : null;
    if (bmp && bmp.naturalWidth > 0 && bmp.naturalHeight > 0) {
      return [bmp.naturalWidth, bmp.naturalHeight];
    }
    return null;
  }
  window.naturalSizeOf = naturalSizeOf;

  function nextTopZ() {
    return S.design.nodes.reduce((m, n) => Math.max(m, n.z || 0), 0) + 1;
  }
  window.nextTopZ = nextTopZ;

  window.delAsset = function (assetId) {
    const used = [];
    window.walk(S.design.nodes, n => {
      if (n.type === window.NODE_IMAGE) {
        if (n.assetId === assetId) used.push(n.name);
        if (n.states) {
          window.STATE_NAMES.forEach(s => {
            if (n.states[s.v] && n.states[s.v].assetId === assetId) used.push(n.name + " · " + s.n);
          });
        }
      }
    });
    if (used.length && !confirm("这个素材正被 " + used.length + " 处引用：\n" +
      used.slice(0, 6).join("\n") + (used.length > 6 ? "\n…" : "") +
      "\n\n仍要移除吗？（引用会变成空占位）")) return;
    window.commit(() => {
      S.design.assets = (S.design.assets || []).filter(a => a.id !== assetId);
    }, "移除素材");
    delete thumbs[assetId];
    saveThumbs();
  };

  // 画布接受素材拖放
  const cvEl = document.getElementById("cv");
  if (cvEl) {
    cvEl.addEventListener("dragover", ev => {
      const t = ev.dataTransfer.types;
      if (t.indexOf("application/x-asset") >= 0 || t.indexOf("Files") >= 0 ||
        t.indexOf("application/x-ctrl") >= 0 || t.indexOf("application/x-sctrl") >= 0) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
      }
    });
    cvEl.addEventListener("drop", ev => {
      ev.preventDefault();
      // 控件库拖进来的：直接实例化到落点
      const ctrlKey = ev.dataTransfer.getData("application/x-ctrl");
      if (ctrlKey) {
        const c = window.BUILTIN_CONTROLS.find(x => x.key === ctrlKey);
        if (c) dropControlAt(c.make(), ev);
        return;
      }
      const sctrlId = ev.dataTransfer.getData("application/x-sctrl");
      if (sctrlId) {
        const c = (S.design.controls || []).find(x => x.id === sctrlId);
        if (c) dropControlAt(c.node, ev);
        return;
      }
      const assetId = ev.dataTransfer.getData("application/x-asset");
      if (assetId) { window.addImageNode(assetId); return; }
      const files = Array.from(ev.dataTransfer.files || []);
      if (!files.length) return;
      window.beginBatch("拖入 " + files.length + " 个素材");
      let pending = files.length;
      files.forEach(f => {
        importAsset(f, "custom", asset => {
          S.design.assets.push(asset);
          if (--pending === 0) {
            window.endBatch();
            renderAssets();
            // 拖进来的第一张顺手建个控件，省一步
            if (files.length === 1) window.addImageNode(asset.id);
          }
        });
      });
    });
  }

  /**
   * 把控件模板放到**鼠标落点**（而不是固定偏移），拖到哪就放哪。
   *
   * 落点换算：client 坐标 → 画布位图 → 0..360 坐标 → 减去节点自身一半（让中心对准鼠标）。
   */
  function dropControlAt(template, ev) {
    const cv = document.getElementById("cv");
    const rect = cv.getBoundingClientRect();
    const bx = (ev.clientX - rect.left) / rect.width * cv.width;
    const by = (ev.clientY - rect.top) / rect.height * cv.height;
    const np = window.canvasToNode(bx, by);
    const n = window.instantiateControl(template, {
      x: window.clamp(Math.round(np.x - template.w / 2), 0, Math.max(0, window.CANVAS - template.w)),
      y: window.clamp(Math.round(np.y - template.h / 2), 0, Math.max(0, window.CANVAS - template.h)),
    });
    window.commit(() => {
      S.design.nodes.push(n);
      S.selection = [n.id];
    }, "添加控件：" + n.name);
    window.toast("已添加「" + n.name + "」——右键可「编辑控件…」");
  }

  window.renderPanels = function () {
    renderTree();
    renderProps();
    renderAssets();
  };
})();
