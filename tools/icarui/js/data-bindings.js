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

  // ==================================================================
  // 量程来源标记（P5A-M04 阶段 C 重做）
  //
  // 为什么不再靠数值相等：P5A-M03 用「min/max 恰好等于旧 PID 定义」推断
  // 「这是自动填的」。任务明确要求：不能仅靠数值相等就绝对判定用户未手动设置
  // —— 用户完全可能手填一个正好等于 PID 默认的量程。
  //
  // 现在的做法：自动填量程的入口（createNode / 预设 / assignControlBinding /
  // applyPidDefaults）同时记下 n.__rangeAuto = { pid, min, max }：
  //   · 不进设计文件（toV2Json 只写已知字段，下划线属性天然不被序列化）
  //   · 只在内存；草稿/导出/重新导入后标记消失 → 那就不再自动跟随（保守）
  //
  // 用户一旦手改 min 或 max（走 setNodeNum），标记立即清除。
  //
  // 三条同时成立才算派生：① 有标记 ② 标记 pid == 旧 pid ③ 标记值 == 当前值。
  // ==================================================================

  /** 记录：这个量程是自动填的 */
  window.markRangeAuto = function (n, pid, min, max) {
    if (!n) return;
    n.__rangeAuto = { pid: pid, min: Number(min), max: Number(max) };
  };

  /** 用户手改量程 → 立刻取消派生身份 */
  window.clearRangeAuto = function (n) {
    if (!n) return;
    try { delete n.__rangeAuto; } catch (e) { n.__rangeAuto = undefined; }
  };

  /** 三条同时成立才算派生；不再用数值相等推断 */
  function rangeWasDerived(n, oldPid) {
    const m = n && n.__rangeAuto;
    if (!m) return false;
    if (String(m.pid) !== String(oldPid)) return false;
    return Number(m.min) === Number(n.min) && Number(m.max) === Number(n.max);
  }

  /**
   * 换数据源。
   *
   * @param {boolean} [forceRange] 强制按新 PID 覆盖量程（默认 false = 尊重用户手填值）
   */
  window.assignControlBinding = function (n, value, forceRange) {
    const raw = String(value || "").trim(), pid = raw ? window.resolvePid(raw) : "";
    if (n.type === window.NODE_GAUGE) {
      const oldPid = n.pid;
      const takeRange = !!forceRange || rangeWasDerived(n, oldPid);
      n.rawPid = raw; n.pid = pid;
      const info = window.BUILTIN_PIDS[pid];
      if (info) {
        if (takeRange) {
          n.min = info.min; n.max = info.max;
          // 跟随之后重新打标记，否则下一次换 PID 会因为没标记而不再跟随
          window.markRangeAuto(n, pid, n.min, n.max);
        }
        // 阈值随 PID 走不受量程影响：它们描述的是"这个 PID 多少算报警"
        n.warnLow = info.warnLow === undefined ? null : info.warnLow;
        n.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
      } else if (takeRange && window.markRangeAuto) {
        // 换到**自定义 PID**：新 PID 没有定义可填，量程保持原值不变；
        // 但"派生身份"要延续下去（pid 更新为新 pid、值仍是当前值），
        // 这样从这个自定义 PID 再换回内置 PID 时仍能跟随 ——
        // 与既有契约 `source range follows binding` 一致（verify-data-bindings 钉着这条）。
        window.markRangeAuto(n, pid, n.min, n.max);
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
