"use strict";

// A composite owns geometry; its gauge/image children own the existing PID fields.
// Keep one binding implementation for the canvas inspector and editor draft.
(function () {
  window.controlDataBindings = function (root) {
    const out = [];
    window.walk([root], n => {
      if (n.type === window.NODE_GAUGE || (n.type === window.NODE_IMAGE && n.states)) out.push(n);
    });
    return out;
  };

  window.bindingPidOptions = function (raw, pid) {
    const esc = window.esc, groups = new Map();
    const current = String(raw || pid || "");
    Object.entries(window.PID_ALIASES).forEach(([alias, id]) => {
      const info = window.BUILTIN_PIDS[id];
      const key = info ? info.g : "其他";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ value: alias, id, label: info ? info.name + (info.unit ? " · " + info.unit : "") : alias });
    });
    const templates = Object.entries(window.BUILTIN_PIDS).filter(([id]) => id.startsWith("tpl_"));
    if (templates.length) groups.set("厂家模板（未验证）", templates.map(([id, info]) => ({ value: id, id, label: info.name })));
    const known = Array.from(groups.values()).some(a => a.some(o => o.value === current));
    if (current && !known) groups.set("当前数据源", [{ value: current, id: pid, label: (window.BUILTIN_PIDS[pid] || {}).name || "自定义 PID（App 中需有此数据源）" }]);
    let html = '<option value=""' + (!current ? ' selected' : '') + '>未绑定</option>';
    groups.forEach((items, key) => {
      html += '<optgroup label="' + esc(key) + '">';
      items.forEach(o => { html += '<option value="' + esc(o.value) + '"' + (o.value === current ? ' selected' : '') + '>' + esc(o.label + ' · ' + o.value) + '</option>'; });
      html += '</optgroup>';
    });
    return html;
  };

  window.assignControlBinding = function (n, value) {
    const raw = String(value || "").trim(), pid = raw ? window.resolvePid(raw) : "";
    if (n.type === window.NODE_GAUGE) {
      n.rawPid = raw; n.pid = pid;
      const info = window.BUILTIN_PIDS[pid];
      if (info) {
        n.min = info.min; n.max = info.max;
        n.warnLow = info.warnLow === undefined ? null : info.warnLow;
        n.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
      }
    } else if (n.type === window.NODE_IMAGE && n.states) {
      n.rawStatePid = raw; n.statePid = pid;
    }
  };

  window.controlBindingFields = function (root, handler) {
    const esc = window.esc;
    const nodes = window.controlDataBindings(root);
    if (!nodes.length) return '<div class="hint">这个组合只有图片或文字。要显示车辆数据，请加入仪表或启用图片状态系统。</div>';
    return nodes.map(n => {
      const image = n.type === window.NODE_IMAGE;
      const pid = image ? n.statePid : n.pid, raw = image ? n.rawStatePid : n.rawPid;
      const info = window.BUILTIN_PIDS[pid];
      const call = handler + '(' + JSON.stringify(n.id) + ',this.value)';
      const summary = !pid ? '未绑定：不会显示车辆读数' : info
        ? info.name + (image ? ' · 按数值切换图片' : ' · ' + n.min + '~' + n.max + (info.unit ? ' ' + info.unit : ''))
        : '自定义 PID：App 中必须已配置同名数据源';
      return '<div class="bindingEntry" data-binding-node="' + esc(n.id) + '">' +
        '<div class="hint"><b>' + esc(n.name) + '</b></div>' +
        '<div class="prow"><label>数据源</label><select data-binding-pid onchange="' + esc(call) + '">' + window.bindingPidOptions(raw, pid) + '</select></div>' +
        '<div class="prow"><label>自定义 PID</label><input data-binding-custom value="' + esc(raw || pid || '') + '" placeholder="填 App 中的 PID id" onchange="' + esc(call) + '"></div>' +
        '<div class="hint" data-binding-summary>' + esc(summary) + '</div></div>';
    }).join('') + '<div class="hint">模拟预览使用示例数据。导入 App 后，读数来自所选 PID；PID 没有有效读数时显示 --。</div>';
  };

  window.collectDesignPids = function (nodes) {
    const set = new Set(), add = raw => { if (raw) set.add(window.resolvePid(raw)); };
    function parts(list) { (list || []).forEach(p => { add(p.pid); parts(p.children); }); }
    window.walk(nodes, n => {
      if (n.type === window.NODE_GAUGE) { add(n.pid); (n.extraPids || []).forEach(add); parts(n.parts); }
      if (n.type === window.NODE_IMAGE && n.states) add(n.statePid);
    });
    return Array.from(set);
  };
})();
