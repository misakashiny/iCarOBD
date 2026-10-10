/* ==========================================================================
   editor.js —— 控件编辑器（右键 →「编辑控件…」）
   --------------------------------------------------------------------------
   用户要求："当控件右键的时候可以进行修改、修改后进入控件修改状态、
   能改什么（自己扩散想法）、修改之后可以保存到素材库或者导出"

   ## 设计

   - 编辑的是**草稿副本**（`S.editDraft`），画布上的原节点不动 ——
     点「取消」就什么都没有发生，不用撤销
   - 预览**复用画布的绘制代码**（`drawNodePreview`），所以预览与画布一定一致
   - 「应用并关闭」把草稿写回原节点（保留 id，走 `commit` 所以可撤销）
   - 「保存到素材库」把草稿存成**可复用模板**（写进设计文件的 `controls`）
   - 「导出 JSON」把草稿单独下载下来，可以给别人/别的设计用

   ## 能改什么（用户问的"自己扩散想法"）

   按节点类型给出**该类型真正有意义**的字段，而不是把所有字段堆一遍：

   | 类型 | 可改 |
   |---|---|
   | 仪表 | 名称 / PID / 样式 / 量程 / 上下限报警 / 卡片外框 / 霓虹档位 / 指针环 / 环段数 / 副参数 |
   | 图片 | 名称 / 素材 / 状态系统（三态图片 + 透明度 + 闪烁） |
   | 文字 | 名称 / 内容 / 字号 / 颜色 / 加粗 |
   | 分组 | 名称（子控件在控件树里改） |
   | 通用 | 尺寸 / 旋转 / 缩放 / 不透明度 / 层级 / 锁定 / 可见 |
   ========================================================================== */
"use strict";

(function () {
  const S = window.CanvasState;

  function el(id) { return document.getElementById(id); }
  function esc(s) { return window.esc(String(s)); }
  function attr(s) { return esc(s); }

  let draft = null;       // 正在编辑的草稿（深拷贝）
  let targetId = null;    // 原节点 id
  let isNew = false;      // 是从控件库"新建"进来的（应用时是新增而不是替换）

  // ================================================================ 打开 / 关闭

  /** 打开控件编辑器。`nodeId` 为 null 时用 `template` 新建一个 */
  window.openControlEditor = function (nodeId, template) {
    if (nodeId) {
      const n = window.findNode(S.design.nodes, nodeId);
      if (!n) { window.toast("找不到这个控件"); return; }
      draft = window.clone(n);
      targetId = nodeId;
      isNew = false;
    } else if (template) {
      draft = window.clone(template);
      targetId = null;
      isNew = true;
    } else {
      return;
    }
    buildModal();
    renderEditor();
    const m = el("ctrlEditor");
    if (m) m.classList.add("show");
  };

  window.closeControlEditor = function () {
    const m = el("ctrlEditor");
    if (m) m.classList.remove("show");
    draft = null; targetId = null; isNew = false;
  };

  function buildModal() {
    if (el("ctrlEditor")) return;
    const d = document.createElement("div");
    d.id = "ctrlEditor";
    d.className = "modal";
    d.innerHTML =
      '<div class="modalBox">' +
      '  <div class="modalHead">' +
      '    <span id="ceTitle">编辑控件</span>' +
      '    <span class="badge" id="ceType"></span>' +
      '    <span class="spacer"></span>' +
      '    <button onclick="closeControlEditor()" title="不保存任何改动（画布上的原控件不动）">✕ 关闭</button>' +
      '  </div>' +
      '  <div class="modalBody">' +
      '    <div class="ceLeft">' +
      '      <canvas id="cePreview" width="260" height="260"></canvas>' +
      '      <div class="hint" style="text-align:center">实时预览（与画布同一套绘制代码）</div>' +
      '    </div>' +
      '    <div class="ceRight" id="ceProps"></div>' +
      '  </div>' +
      '  <div class="modalFoot">' +
      '    <button class="primary" onclick="applyControlEdit()" id="ceApply">应用并关闭</button>' +
      '    <button onclick="saveControlToLibrary()">保存到素材库</button>' +
      '    <button onclick="exportControlJson()">导出 JSON</button>' +
      '    <span class="spacer"></span>' +
      '    <button onclick="closeControlEditor()">取消</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(d);
    // 点遮罩关闭
    d.addEventListener("pointerdown", ev => { if (ev.target === d) window.closeControlEditor(); });
  }

  // ================================================================ 属性表单

  function row(label, inner) {
    return '<div class="prow"><label>' + esc(label) + '</label>' + inner + '</div>';
  }
  function numIn(k, v, step) {
    return '<input type="number" step="' + (step || "1") + '" value="' + window.r2(v) +
      '" oninput="ceSetNum(\'' + k + '\',this.value)">';
  }
  function group(title, body, key) {
    return '<div class="pgroup"><div class="phead" onclick="ceToggle(\'' + key + '\')">' +
      '<span class="pcaret" id="cec-' + key + '">▾</span>' + esc(title) + '</div>' +
      '<div class="pbody" id="ceb-' + key + '">' + body + '</div></div>';
  }
  const ceCollapsed = {};
  window.ceToggle = function (k) {
    ceCollapsed[k] = !ceCollapsed[k];
    const b = el("ceb-" + k), c = el("cec-" + k);
    if (b) b.style.display = ceCollapsed[k] ? "none" : "";
    if (c) c.textContent = ceCollapsed[k] ? "▸" : "▾";
  };

  function renderEditor() {
    if (!draft) return;
    const n = draft;
    el("ceTitle").textContent = isNew ? "新建控件" : "编辑控件";
    el("ceType").textContent = (window.NODE_TYPES.find(t => t.v === n.type) || {}).n || n.type;
    el("ceApply").textContent = isNew ? "添加到画布" : "应用并关闭";

    const out = [];
    out.push(row("名称", '<input value="' + attr(n.name) + '" oninput="ceSetStr(\'name\',this.value)">'));

    // ---- 类型专属
    if (n.type === window.NODE_GAUGE) {
      const opts = (function () {
        const groups = new Map();
        Object.entries(window.PID_ALIASES).forEach(([alias, id]) => {
          const info = window.BUILTIN_PIDS[id];
          const g = info ? info.g : "其他";
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push({ v: alias, l: alias + "  →  " + id + (info ? "  " + info.name : "") });
        });
        let h = "";
        groups.forEach((items, g) => {
          h += '<optgroup label="' + attr(g) + '">';
          items.forEach(it => { h += '<option value="' + attr(it.v) + '"' +
            ((n.rawPid || n.pid) === it.v ? " selected" : "") + '>' + esc(it.l) + '</option>'; });
          h += '</optgroup>';
        });
        return h;
      })();
      out.push(group("数据", [
        row("PID", '<select onchange="ceSetPid(this.value)">' + opts + '</select>'),
        row("样式", '<select onchange="ceSetNum(\'style\',this.value)">' +
          window.STYLES.map(s => '<option value="' + s.v + '"' + (n.style === s.v ? " selected" : "") +
            '>' + s.v + ' · ' + s.n + '</option>').join("") + '</select>'),
        row("min / max", numIn("min", n.min, "any") + numIn("max", n.max, "any")),
        row("warnLow", '<input type="number" step="any" value="' + (n.warnLow === null ? "" : window.r2(n.warnLow)) +
          '" placeholder="（不设）" oninput="ceSetNullable(\'warnLow\',this.value)">'),
        row("warnHigh", '<input type="number" step="any" value="' + (n.warnHigh === null ? "" : window.r2(n.warnHigh)) +
          '" placeholder="（不设）" oninput="ceSetNullable(\'warnHigh\',this.value)">'),
        row("副参数", '<input value="' + attr((n.extraPids || []).join(",")) +
          '" placeholder="逗号分隔" oninput="ceSetExtras(this.value)">'),
        '<div class="btnRow"><button onclick="ceApplyPidDefaults()">按 PID 库回填量程与阈值</button></div>',
      ].join(""), "data"));

      out.push(group("字体（表上的文字）", window.fontFields(n.labelFont, "ceSetFont",
        row("显示", '<label class="chk"><input type="checkbox"' + (n.showLabel !== false ? " checked" : "") +
          ' onchange="ceSetBool(\'showLabel\',this.checked)"> 名字</label>' +
          '<label class="chk"><input type="checkbox"' + (n.showRange !== false ? " checked" : "") +
          ' onchange="ceSetBool(\'showRange\',this.checked)"> 量程</label>')), "font"));
      out.push(group("外观", [
        row("卡片外框", '<select onchange="ceSetCard(this.value)">' +
          window.CARD_NAMES.map((c, i) => '<option value="' + i + '"' +
            (((n.cardStyle === null ? 0 : n.cardStyle)) === i ? " selected" : "") + '>' + i + ' · ' + esc(c) +
            '</option>').join("") + '</select>'),
        row("底框显示", '<label class="chk"><input type="checkbox"' +
          (window.resolveCard(n).show ? " checked" : "") +
          ' onchange="ceSetCardFlag(\'show\',this.checked)"> 画底框</label>'),
        row("底框透明度", '<input type="number" min="0" max="255" placeholder="跟随主题" value="' +
          (n.card && n.card.alpha !== null && n.card.alpha !== undefined ? n.card.alpha : "") +
          '" oninput="ceSetCardNum(\'alpha\',this.value)">'),
        row("底框圆角", '<input type="number" min="0" max="120" placeholder="跟随主题" value="' +
          (n.card && n.card.radius !== null && n.card.radius !== undefined ? n.card.radius : "") +
          '" oninput="ceSetCardNum(\'radius\',this.value)">'),
        row("霓虹档位", '<select onchange="ceSetNeon(this.value)">' +
          '<option value="">（跟随主题）</option>' +
          window.NEON_PRESETS.map(p => '<option value="' + attr(p) + '"' +
            (n.neonPreset === p ? " selected" : "") + '>' + esc(p) + '</option>').join("") + '</select>'),
        row("指针环", '<select onchange="ceSetNum(\'ringStyle\',this.value)">' +
          '<option value="0"' + (n.ringStyle === 0 ? " selected" : "") + '>0 · 无</option>' +
          '<option value="1"' + (n.ringStyle === 1 ? " selected" : "") + '>1 · 外圈刻度</option></select>'),
        row("环段数", numIn("ringSegments", n.ringSegments)),
      ].join(""), "look"));
    }

    if (n.type === window.NODE_IMAGE) {
      const assetOpts = sel => '<option value="">（未选）</option>' +
        (S.design.assets || []).map(a => '<option value="' + attr(a.id) + '"' +
          (sel === a.id ? " selected" : "") + '>' + esc(a.name) + '</option>').join("");
      out.push(group("图片", [
        row("素材", '<select onchange="ceSetStr(\'assetId\',this.value)">' + assetOpts(n.assetId) + '</select>'),
      ].join(""), "img"));
      out.push(group("状态系统", [
        row("启用", '<label class="chk"><input type="checkbox"' + (n.states ? " checked" : "") +
          ' onchange="ceToggleStates(this.checked)"> 按数值切换图片</label>'),
        n.states ? row("驱动 PID", '<input value="' + attr(n.rawStatePid || window.ALIAS_OF[n.statePid] || n.statePid || "") +
          '" placeholder="如 obd.coolant" oninput="ceSetStatePid(this.value)">') : "",
        n.states ? row("警告阈值", '<input type="number" step="any" placeholder="跟随 PID 库" value="' +
          (n.stateWarn === null || n.stateWarn === undefined ? "" : window.r2(n.stateWarn)) +
          '" oninput="ceSetStateThreshold(\'stateWarn\',this.value)">') : "",
        n.states ? row("严重阈值", '<input type="number" step="any" placeholder="默认取中点" value="' +
          (n.stateCritical === null || n.stateCritical === undefined ? "" : window.r2(n.stateCritical)) +
          '" oninput="ceSetStateThreshold(\'stateCritical\',this.value)">') : "",
        n.states ? window.STATE_NAMES.map(function (s) {
          const v = n.states[s.v] || { assetId: "", alpha: 255, blink: false, blinkMs: window.MIN_BLINK_MS };
          const blinkRow = row("闪烁",
            '<label class="chk"><input type="checkbox"' + (v.blink ? " checked" : "") +
            ' onchange="ceSetState(\'' + s.v + '\',\'blink\',this.checked)"> 闪</label>' +
            '<input type="number" min="' + window.MIN_BLINK_MS + '" step="20" value="' + v.blinkMs +
            '" oninput="ceSetState(\'' + s.v + '\',\'blinkMs\',this.value)" title="周期 ms（下限 ' +
            window.MIN_BLINK_MS + 'ms —— WCAG 2.3.1 闪烁每秒不超过三次）">');
          return '<div class="stateBox"><div class="stateName">' + esc(s.n) + '</div>' +
            row("图片", '<select onchange="ceSetState(\'' + s.v + '\',\'assetId\',this.value)">' +
              assetOpts(v.assetId) + '</select>') +
            row("透明度", '<input type="number" min="0" max="255" value="' + v.alpha +
              '" oninput="ceSetState(\'' + s.v + '\',\'alpha\',this.value)">') +
            blinkRow +
            '</div>';
        }).join("") : '<div class="hint">开启后，同一个控件按数值显示不同图片（正常/警告/严重），位置与层级只写一次。</div>',
      ].join(""), "states"));
    }

    if (n.type === window.NODE_TEXT) {
      out.push(group("文字", [
        row("内容", '<input value="' + attr(n.text) + '" oninput="ceSetStr(\'text\',this.value)">'),
      ].join(""), "text"));
      // 与属性面板**共用** fontFields —— 改一个字段不用改两处
      out.push(group("字体", window.fontFields(n.font, "ceSetFont"), "font"));
    }

    // ---- 通用：变换
    out.push(group("变换", [
      row("尺寸 w / h", numIn("w", n.w) + numIn("h", n.h)),
      row("旋转（度）", numIn("rotation", n.rotation, "0.5")),
      row("缩放（倍）", numIn("scale", n.scale, "0.05")),
      row("不透明度", numIn("alpha", n.alpha) +
        '<input type="range" min="0" max="255" value="' + Math.round(n.alpha) +
        '" oninput="ceSetNum(\'alpha\',this.value)">'),
    ].join(""), "tf"));
    out.push(group("图层", [
      row("层级 z", numIn("z", n.z)),
      row("状态", '<label class="chk"><input type="checkbox"' + (n.locked ? " checked" : "") +
        ' onchange="ceSetBool(\'locked\',this.checked)"> 锁定</label>' +
        '<label class="chk"><input type="checkbox"' + (n.visible ? " checked" : "") +
        ' onchange="ceSetBool(\'visible\',this.checked)"> 可见</label>'),
    ].join(""), "layer"));

    el("ceProps").innerHTML = out.join("");
    // 折叠状态
    Object.keys(ceCollapsed).forEach(k => {
      if (ceCollapsed[k]) {
        const b = el("ceb-" + k), c = el("cec-" + k);
        if (b) b.style.display = "none";
        if (c) c.textContent = "▸";
      }
    });
    // ⚠️ **先同步素材位图，再画预览**（v2.21.0 修的真 bug）。
  //
  // 控件模板的 `make()` 会调 `ensureBuiltinAsset()` 把素材登记进
  // `S.design.assets` —— 但**位图进 `S.assetUrls` 是另一件事**，
  // 由 `syncAssetImages()` 做，而它只在 `renderAssets()` 里被调。
  //
  // 于是"从控件库新建控件 → 立刻打开编辑器"这条路上，素材刚登记、位图还没加载，
  // `assetBitmap()` 返回 null → `drawImageNode` 画出**紫色占位 X**。
  // 实测：40 个内置控件里有 16 个预览是紫 X（全是带素材的）。
  if (window.syncAssetImages) window.syncAssetImages();
  window.drawNodePreview(draft, el("cePreview"));
  }
  window.renderControlEditor = renderEditor;

  /**
   * **只重绘预览**（不重建整个属性面板）。
   *
   * 为什么单独一个：素材位图是异步解码的，`loadAssetImage` 的 onload 里
   * 需要"图好了就把预览刷新一下"。走整个 renderEditor 会重建 DOM，
   * **把用户正在输入的焦点弄丢**（改一个字就跳走）。
   */
  window.redrawEditorPreview = function () {
    const cv = document.getElementById("cePreview");
    if (!cv || !draft) return;
    window.drawNodePreview(draft, cv);
  };

  // ================================================================ 草稿写入

  function after() { renderEditor(); }

  window.ceSetNum = function (k, v) {
    if (!draft) return;
    const x = Number(v);
    draft[k] = Number.isFinite(x) ? x : 0;
    if (k === "w" || k === "h") draft[k] = Math.max(1, draft[k]);
    if (k === "scale") draft[k] = Math.max(0.05, draft[k]);
    if (k === "alpha") draft[k] = Math.max(0, Math.min(255, Math.round(draft[k])));
    after();
  };
  window.ceSetStr = function (k, v) { if (draft) { draft[k] = String(v); after(); } };

  /**
   * 改字体字段。和属性面板一样：**文字控件改 `font`，仪表改 `labelFont`**。
   * 用 normalizeFont 过一遍，非法值会被夹住而不是写进去。
   */
  window.ceSetFont = function (k, v) {
    if (!draft) return;
    const key = draft.type === window.NODE_TEXT ? "font" : "labelFont";
    const patch = {};
    patch[k] = v;
    draft[key] = window.normalizeFont(Object.assign({}, draft[key], patch));
    after();
  };
  window.ceSetBool = function (k, v) { if (draft) { draft[k] = !!v; after(); } };
  window.ceSetNullable = function (k, v) {
    if (!draft) return;
    const s = String(v).trim();
    const x = s === "" ? null : Number(s);
    draft[k] = (x === null || !Number.isFinite(x)) ? null : x;
    after();
  };
  window.ceSetExtras = function (v) {
    if (!draft) return;
    draft.extraPids = String(v).split(",").map(s => s.trim()).filter(Boolean);
  };
  window.ceSetCard = function (v) {
    if (!draft) return;
    const i = Number(v);
    draft.cardStyle = (!Number.isFinite(i) || i <= 0) ? null : i;
    after();
  };
  window.ceSetNeon = function (v) { if (draft) { draft.neonPreset = v || null; after(); } };
  window.ceSetPid = function (v) {
    if (!draft) return;
    const raw = String(v || "").trim();
    draft.rawPid = raw;
    draft.pid = window.resolvePid(raw);
    const info = window.BUILTIN_PIDS[draft.pid];
    if (info) {
      draft.min = info.min; draft.max = info.max;
      draft.warnLow = info.warnLow === undefined ? null : info.warnLow;
      draft.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
    }
    after();
  };
  window.ceApplyPidDefaults = function () {
    if (!draft) return;
    const info = window.BUILTIN_PIDS[draft.pid];
    if (!info) { window.toast("这个 PID 不在内置库里，请手动填量程"); return; }
    draft.min = info.min; draft.max = info.max;
    draft.warnLow = info.warnLow === undefined ? null : info.warnLow;
    draft.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
    after();
  };
  window.ceToggleStates = function (on) {
    if (!draft) return;
    // ⚠️ 与 `app.js` 的 `toggleStates` 共用**同一个**默认值真源（schema.js）。
    // 原来两边各写了一份一模一样的 normal/warn/critical 字面量 ——
    // 加第四个状态时只改一处就会漏。
    draft.states = on ? window.defaultStates(draft.assetId) : null;
    if (on && !draft.statePid) window.ceSetStatePid("obd.rpm");
    after();
  };
  window.ceSetStatePid = function (v) {
    if (!draft) return;
    const raw = String(v || "").trim();
    draft.rawStatePid = raw;
    draft.statePid = raw ? window.resolvePid(raw) : "";
  };
  window.ceSetState = function (state, key, v) {
    if (!draft || !draft.states) return;
    if (!draft.states[state]) draft.states[state] = window.defaultStates(draft.assetId)[state];
    const st = draft.states[state];
    if (key === "blink") st.blink = !!v;
    else if (key === "assetId") st.assetId = String(v);
    else if (key === "alpha") st.alpha = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
    // WCAG 2.3.1：闪烁每秒不超过三次 → 周期下限 400ms（见 window.MIN_BLINK_MS）
    else if (key === "blinkMs") st.blinkMs = Math.max(window.MIN_BLINK_MS, Math.round(Number(v) || window.MIN_BLINK_MS));
    after();
  };

  // ================================================================ 应用 / 保存 / 导出

  /** 应用草稿：替换原节点（保留 id），或新增到画布 */
  window.applyControlEdit = function () {
    if (!draft) return;
    const d = window.clone(draft);
    if (isNew) {
      window.commit(() => {
        const n = window.instantiateControl(d, { x: d.x, y: d.y });
        S.design.nodes.push(n);
        S.selection = [n.id];
      }, "从控件库添加：" + d.name);
    } else {
      window.commit(() => {
        d.id = targetId;
        // 原地替换：保留在原父级的同一位置
        const parent = window.findParent(S.design.nodes, targetId);
        const parentId = parent ? parent.id : null;
        const sibs = window.siblingsOf(S.design.nodes, targetId);
        const idx = sibs.findIndex(x => x.id === targetId);
        window.removeNodes(S.design.nodes, [targetId]);
        if (parentId) {
          const p = window.findNode(S.design.nodes, parentId);
          if (p) { p.children.splice(idx, 0, d); return; }
        }
        S.design.nodes.splice(idx, 0, d);
      }, "编辑控件：" + d.name);
    }
    window.closeControlEditor();
    window.toast(isNew ? "已添加「" + d.name + "」" : "已应用对「" + d.name + "」的修改");
  };

  /** 保存成**可复用模板**（写进设计文件的 `controls`），之后能从素材库拖出来 */
  window.saveControlToLibrary = function () {
    if (!draft) return;
    const name = prompt("给这个控件起个名字（会出现在素材库的「自定义控件」里）", draft.name || "我的控件");
    if (name === null) return;
    const d = window.clone(draft);
    d.id = window.newId("tpl");
    // 模板节点不带锁定/可见状态，避免拖出来就是锁的
    d.locked = false;
    d.visible = true;
    window.commit(() => {
      if (!S.design.controls) S.design.controls = [];
      S.design.controls.push({ id: window.newId("ct"), name: name.trim() || d.name, node: d });
    }, "保存控件到素材库：" + name);
    window.renderAssets && window.renderAssets();
    window.toast("已保存到素材库「自定义控件」——之后可以从左侧拖进画布");
  };

  /** 导出成独立 JSON（可以给别人 / 给别的设计文件用） */
  window.exportControlJson = function () {
    if (!draft) return;
    const payload = {
      schema: window.SCHEMA_V2,
      kind: "icar.control/1",
      name: draft.name,
      node: window.nodeToJson(draft),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (draft.name || "control") + ".control.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    window.toast("已导出控件 JSON");
  };

  /** 从导出的控件 JSON 导入回素材库 */
  window.importControlJson = function () {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = function () {
      const f = inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = function () {
        let obj;
        try { obj = JSON.parse(String(r.result)); } catch (e) {
          window.toast("不是合法的 JSON：" + e.message); return;
        }
        if (!obj || !obj.node) { window.toast("缺少 `node` 字段 —— 不是控件文件？"); return; }
        // 用解析器校验这个节点（借 controls 段走一遍完整校验）
        const probe = window.parseDesign(JSON.stringify({
          schema: window.SCHEMA_V2,
          canvas: { unit: 360 },
          controls: [{ id: "probe", name: obj.name || "导入的控件", node: obj.node }],
          nodes: [{ id: "x", type: "gauge", name: "占位", pid: "obd.rpm", min: 0, max: 100, x: 0, y: 0, w: 10, h: 10 }],
        }));
        if (probe.errors.length) {
          window.toast("导入失败：" + probe.errors[0]); return;
        }
        const c = probe.design.controls[0];
        window.commit(() => {
          if (!S.design.controls) S.design.controls = [];
          S.design.controls.push({ id: window.newId("ct"), name: c.name, node: c.node });
        }, "导入控件：" + c.name);
        window.renderAssets && window.renderAssets();
        window.toast("已导入「" + c.name + "」到素材库");
      };
      r.readAsText(f, "utf-8");
    };
    inp.click();
  };
})();
