// 验证这一批：旋转修复 / 打组 / 取消组合 / PID 标签开关 / 提示文字删除
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9242;
const sleep = ms => new Promise(r => setTimeout(r, ms));

  /**
   * 等页面**真的就绪**（而不是硬等固定毫秒）。
   *
   * 判据三条：状态对象在、素材清单非空、画布有尺寸。
   * 超时后不抛错 —— 让后续断言去报真正的问题（比"加载超时"更有信息量）。
   */
  async function waitReady(cdp, timeoutMs) {
    const t0 = Date.now();
    const limit = timeoutMs || 20000;
    while (Date.now() - t0 < limit) {
      try {
        const ok = await cdp.eval("!!(window.CanvasState && (window.BUILTIN_ASSETS||[]).length > 0 && document.getElementById('cv') && document.getElementById('cv').width > 0 && window.BUILTIN_DATA_DONE !== false)");
        if (ok) return true;
      } catch (e) { /* 页面还没起来，继续等 */ }
      await sleep(200);
    }
    return false;
  }
const getJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); this.events = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      else if (m.method) c.events.push(m);
    };
    return c;
  }
  send(m, p, timeoutMs) {
    const id = ++this.id;
    const LIMIT = timeoutMs || 12000;
    return new Promise((res, rej) => {
      // ⚠️ **超时保护**（v2.26.0）：CDP 请求可能永远等不到响应（页面崩了、
      // 调试通道断了），那会让整个套件**挂死**而不是失败 —— 实测挂过 10 分钟。
      // 挂死比失败糟：CI 里不会自己结束，也看不出卡在哪一步。
      const timer = setTimeout(() => {
        if (this.w.has(id)) {
          this.w.delete(id);
          rej(new Error('CDP 超时（' + LIMIT + 'ms）: ' + m));
        }
      }, LIMIT);
      this.w.set(id, {
        res: v => { clearTimeout(timer); res(v); },
        rej: e => { clearTimeout(timer); rej(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method: m, params: p })); }
      catch (e) { clearTimeout(timer); this.w.delete(id); rej(e); }
    });
  }
  async eval(e) {
    // 瞬时 CDP 错误重试（v2.26.0）：重型的 evaluate 会让渲染进程短暂无响应，
    // CDP 报 -32000 "Inspected target navigated or closed"。
    // ⚠️ **只重试这一种** —— 语法错误/断言失败绝不重试，否则会掩盖真 bug。
    const TRANSIENT = /-32000|navigated or closed|Target closed|Session closed/i;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception || {}).description || ''));
        return r.result.value;
      } catch (err) {
        lastErr = err;
        if (!TRANSIENT.test(String(err && err.message))) throw err;
        // ⚠️ 重试前**先等页面就绪** —— 失败可能是"渲染进程崩了、页面自动重载"，
        // 那时重发会打在还在加载的页面上（症状：window.xxx is not a function）。
        try { await waitReady(this, 2000); } catch (e2) { /* 等不到就按原节奏重试 */ }
        await new Promise(res => setTimeout(res, 350 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-grp`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval(`window.confirm = () => true; window.alert = () => {};`);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 旋转：外框不变形、尺寸不变 ----------
    console.log('\n=== 1. 旋转：外框保持矩形、尺寸恒定 ===');
    const rot = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      n.rotation = 0; n.scale = 1;
      const rows = [];
      [0, 15, 30, 45, 60, 90, 135, 180].forEach(deg => {
        n.rotation = deg;
        const m = window.deviceMatrix(S.design.nodes, n.id);
        const c = [window.matApply(m,0,0), window.matApply(m,n.w,0),
                   window.matApply(m,n.w,n.h), window.matApply(m,0,n.h)];
        const e1 = {x:c[1].x-c[0].x, y:c[1].y-c[0].y}, e2 = {x:c[3].x-c[0].x, y:c[3].y-c[0].y};
        const cosang = (e1.x*e2.x+e1.y*e2.y)/(Math.hypot(e1.x,e1.y)*Math.hypot(e2.x,e2.y));
        const d1 = Math.hypot(c[2].x-c[0].x, c[2].y-c[0].y);
        const d2 = Math.hypot(c[3].x-c[1].x, c[3].y-c[1].y);
        const k = Math.min(Math.hypot(m.a,m.b), Math.hypot(m.c,m.d));
        rows.push({ deg: deg, skew: Math.abs(cosang), diagDiff: Math.abs(d1-d2), k: k });
      });
      n.rotation = 0;
      return JSON.stringify(rows);
    })()`);
    const ROT = JSON.parse(rot);
    ROT.forEach(r => console.log('    · ' + r.deg + '°  斜切=' + r.skew.toFixed(4) +
      '  对角线差=' + r.diagDiff.toFixed(2) + '  内容尺度=' + r.k.toFixed(3)));
    ok(ROT.every(r => r.skew < 0.001), '所有角度都不斜切（相邻边垂直）');
    ok(ROT.every(r => r.diagDiff < 0.5), '所有角度对角线相等（是矩形，不是平行四边形）');
    ok(ROT.every(r => Math.abs(r.k - ROT[0].k) < 0.001),
      '内容尺度恒定（不随旋转变大变小）—— 修好了"旋转时控件会变大"');

    // 旋转拖动：真的按角度转
    console.log('\n=== 1b. 旋转拖动：角度算得对 ===');
    const dragRot = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      n.rotation = 0;
      S.selection = [n.id];
      window.onSelectionChanged();
      const cv = document.getElementById('cv');
      const rect = cv.getBoundingClientRect();
      const dpr = cv.width / rect.width;
      const m = window.deviceMatrix(S.design.nodes, n.id);
      const center = window.matApply(m, n.w/2, n.h/2);
      // ⚠️ 必须用**真实手柄位置**：顶部旋转柄在 (n.w/2, -offY)，不是节点内的一点。
      // 第一版用 center.y - r（节点内部）→ 命中的是节点本体 → 变成 move。
      const hp = window.handlePositionsFor(n.id).hp;
      const handlePt = window.matApply(m, hp.rotate.x, hp.rotate.y);
      const r = Math.hypot(handlePt.x - center.x, handlePt.y - center.y);
      const toClient = p => ({ x: rect.x + p.x/dpr, y: rect.y + p.y/dpr });
      const p0 = toClient(handlePt);
      const p1 = toClient({ x: center.x + r, y: center.y });
      cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true,
        clientX:p0.x, clientY:p0.y, pointerId:1, isPrimary:true }));
      const started = S.drag ? S.drag.mode : 'none';
      cv.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, cancelable:true,
        clientX:p1.x, clientY:p1.y, pointerId:1, isPrimary:true }));
      const after = window.findNode(S.design.nodes, n.id).rotation;
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1, isPrimary:true }));
      n.rotation = 0;
      return JSON.stringify({ started: started, rotation: after });
    })()`);
    const DR = JSON.parse(dragRot);
    console.log('    · ' + dragRot);
    eq(DR.started, 'rotate', '从顶部旋转柄按下进入旋转模式');
    ok(Math.abs(DR.rotation - 90) < 3, `从"正上"拖到"正右"应转约 90°（实际 ${DR.rotation}°）`);

    // ---------- 2) 打组 ----------
    console.log('\n=== 2. 打组 ===');
    const grp = await cdp.eval(`(() => {
      const S = window.CanvasState;
      // 用干净的两个表
      const all = window.flatten(S.design.nodes);
      const a = all.find(x => x.type === 'gauge');
      const b = all.filter(x => x.type === 'gauge')[1];
      // 记录打组前的视觉包围盒
      const before = [a,b].map(n => window.deviceBounds(n.id));
      S.selection = [a.id, b.id];
      window.onSelectionChanged();
      const chk = window.groupCheck(S.design.nodes, S.selection);
      const rootsBefore = S.design.nodes.length;
      window.groupSelected();
      const rootsAfter = S.design.nodes.length;
      const g = S.design.nodes.find(x => x.type === 'group');
      const after = [a,b].map(n => window.deviceBounds(n.id));
      const d = before.map((x,i) => ({
        dx: Math.abs(x.x - after[i].x), dy: Math.abs(x.y - after[i].y),
        dw: Math.abs(x.w - after[i].w), dh: Math.abs(x.h - after[i].h) }));
      return JSON.stringify({
        chkOk: chk.ok, chkCount: chk.count,
        rootsBefore: rootsBefore, rootsAfter: rootsAfter,
        groupName: g ? g.name : null, kids: g ? g.children.length : 0,
        groupRot: g ? g.rotation : null, groupScale: g ? g.scale : null,
        drift: d, sel: S.selection.length,
      });
    })()`);
    const G = JSON.parse(grp);
    console.log('    · ' + grp);
    ok(G.chkOk, 'groupCheck 通过');
    eq(G.rootsAfter, G.rootsBefore - 1, '两个根节点变成一个分组（根数 -1）');
    eq(G.kids, 2, '分组里有 2 个子控件');
    eq(G.groupRot, 0, '新分组 rotation=0（纯平移，所以子控件位置不变）');
    eq(G.groupScale, 1, '新分组 scale=1');
    ok(G.drift.every(d => d.dx < 0.5 && d.dy < 0.5), '打组后子控件**位置没跳**（<0.5px）');
    ok(G.drift.every(d => d.dw < 0.5 && d.dh < 0.5), '打组后子控件**尺寸没变**');

    // 拖动分组 → 子控件一起动
    console.log('\n=== 2b. 拖动分组 = 同时拖动全部子控件 ===');
    const dragGrp = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const g = S.design.nodes.find(x => x.type === 'group');
      S.selection = [g.id];
      window.onSelectionChanged();
      const kids = g.children.map(c => ({ id: c.id, x: c.x, y: c.y }));
      const before = g.children.map(c => window.deviceBounds(c.id));
      const cv = document.getElementById('cv');
      const rect = cv.getBoundingClientRect();
      const dpr = cv.width / rect.width;
      const m = window.deviceMatrix(S.design.nodes, g.id);
      const p0 = window.matApply(m, g.w/2, g.h/2);
      const toClient = p => ({ x: rect.x + p.x/dpr, y: rect.y + p.y/dpr });
      const a = toClient(p0), b = toClient({ x: p0.x + 30 * dpr, y: p0.y + 20 * dpr });
      cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true,
        clientX:a.x, clientY:a.y, pointerId:1, isPrimary:true }));
      const mode = S.drag ? S.drag.mode : 'none';
      cv.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, cancelable:true,
        clientX:b.x, clientY:b.y, pointerId:1, isPrimary:true }));
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1, isPrimary:true }));
      const after = g.children.map(c => window.deviceBounds(c.id));
      const moved = before.map((x,i) => ({
        dx: after[i].x - x.x, dy: after[i].y - x.y }));
      return JSON.stringify({ mode: mode, moved: moved, gx: g.x, gy: g.y });
    })()`);
    const DG = JSON.parse(dragGrp);
    console.log('    · ' + dragGrp);
    eq(DG.mode, 'move', '拖动分组进入 move 模式');
    ok(DG.moved.every(mv => mv.dx > 10 && mv.dy > 5),
      '两个子控件都跟着移动了（' + DG.moved.map(mv => Math.round(mv.dx) + ',' + Math.round(mv.dy)).join(' / ') + '）');
    ok(Math.abs(DG.moved[0].dx - DG.moved[1].dx) < 0.5,
      '两个子控件位移**完全一致**（真正的一起动）');

    // ---------- 3) 取消组合 ----------
    console.log('\n=== 3. 取消组合 ===');
    const ungrp = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const g = S.design.nodes.find(x => x.type === 'group');
      const gid = g.id;
      const kids = g.children.map(c => c.id);
      const before = kids.map(id => window.deviceBounds(id));
      const rootsBefore = S.design.nodes.length;
      S.selection = [gid];
      window.onSelectionChanged();
      window.ungroupSelected();
      const rootsAfter = S.design.nodes.length;
      const after = kids.map(id => {
        const n = window.findNode(S.design.nodes, id);
        return n ? window.deviceBounds(id) : null;
      });
      const stillGrouped = !!window.findNode(S.design.nodes, gid);
      const drift = before.map((x,i) => after[i] ? {
        dx: Math.abs(x.x - after[i].x), dy: Math.abs(x.y - after[i].y),
        dw: Math.abs(x.w - after[i].w), dh: Math.abs(x.h - after[i].h) } : { dx: 999 });
      return JSON.stringify({ rootsBefore: rootsBefore, rootsAfter: rootsAfter,
        stillGrouped: stillGrouped, drift: drift, kids: kids.length });
    })()`);
    const UG = JSON.parse(ungrp);
    console.log('    · ' + ungrp);
    ok(!UG.stillGrouped, '分组节点已消失');
    eq(UG.rootsAfter, UG.rootsBefore + 1, '子控件回到根级（根数 +1）');
    ok(UG.drift.every(d => d.dx < 0.5 && d.dy < 0.5), '取消组合后**位置没跳**（<0.5px）');
    ok(UG.drift.every(d => d.dw < 0.5 && d.dh < 0.5), '取消组合后尺寸没变');

    // 旋转过的分组取消组合
    console.log('\n=== 3b. 旋转过的分组取消组合 ===');
    const ungrpRot = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const all = window.flatten(S.design.nodes).filter(x => x.type === 'gauge');
      S.selection = [all[0].id, all[1].id];
      window.groupSelected();
      const g = S.design.nodes.find(x => x.type === 'group');
      if (!g) return JSON.stringify({ err: '打组失败' });
      g.rotation = 40;                        // 把组转 40°
      const kids = g.children.map(c => c.id);
      const before = kids.map(id => window.deviceBounds(id));
      S.selection = [g.id];
      window.ungroupSelected();
      const after = kids.map(id => window.deviceBounds(id));
      const drift = before.map((x,i) => ({
        dx: Math.abs(x.x - after[i].x), dy: Math.abs(x.y - after[i].y) }));
      const rot = window.findNode(S.design.nodes, kids[0]).rotation;
      return JSON.stringify({ drift: drift, childRot: rot });
    })()`);
    const UGR = JSON.parse(ungrpRot);
    console.log('    · ' + ungrpRot);
    ok(UGR.childRot >= 39, `组的旋转被烘焙进子控件（子 rotation=${UGR.childRot}）`);
    ok(UGR.drift.every(d => d.dx < 1.5 && d.dy < 1.5),
      '旋转过的组取消组合后位置也基本不跳（<1.5px）');

    // 前提拦截：把表放进旋转过的组里再打组，应被拒绝
    console.log('\n=== 3c. 旋转过的分组里不能直接打组（前提拦截）===');
    const guard = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const all = window.flatten(S.design.nodes).filter(x => x.type === 'gauge');
      S.selection = [all[0].id, all[1].id];
      window.groupSelected();
      const g = S.design.nodes.find(x => x.type === 'group');
      if (!g) return JSON.stringify({ err: '打组失败' });
      g.rotation = 30;
      // 选组里的两个子控件 + 一个根级表 → 应被拒
      const kids = g.children.map(c => c.id);
      const rootGauge = S.design.nodes.find(x => x.type === 'gauge');
      const ids = rootGauge ? kids.concat([rootGauge.id]) : kids;
      const chk = window.groupCheck(S.design.nodes, ids);
      const undoBefore = document.getElementById('undoCount').textContent;
      S.selection = ids;
      window.groupSelected();
      const undoAfter = document.getElementById('undoCount').textContent;
      return JSON.stringify({ ok: chk.ok, reason: (chk.reason||'').slice(0, 40),
        undoBefore: undoBefore, undoAfter: undoAfter });
    })()`);
    const GD = JSON.parse(guard);
    console.log('    · ' + guard);
    ok(!GD.ok, 'groupCheck 拦住了（祖先带旋转）');
    eq(GD.undoAfter, GD.undoBefore, '被拦住时**不往撤销栈里压空操作**');

    // ---------- 4) PID 标签开关 ----------
    console.log('\n=== 4. PID 标签显示开关 ===');
    const pid = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const hasBtn = !!document.getElementById('btnPid');
      const label0 = document.getElementById('btnPid').textContent.trim();
      const s0 = S.showPid;
      window.togglePidLabel();
      const s1 = S.showPid;
      const label1 = document.getElementById('btnPid').textContent.trim();
      window.togglePidLabel();
      const s2 = S.showPid;
      return JSON.stringify({ hasBtn: hasBtn, label0: label0, s0: s0, s1: s1, label1: label1, s2: s2 });
    })()`);
    const P = JSON.parse(pid);
    console.log('    · ' + pid);
    ok(P.hasBtn, '顶栏有 🏷 PID 按钮');
    eq(P.s0, false, '默认不显示 PID（画面干净）');
    eq(P.s1, true, '点一下变成显示');
    eq(P.s2, false, '再点一下变回隐藏');
    ok(/开/.test(P.label1), '按钮文案跟着变（现在是「开/关」而不是「显/隐」）：' + P.label1);
    // 真的画上去了吗？比较画布像素
    const pidPix = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const cv = document.getElementById('cv');
      const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      S.selection = [];
      const m = window.deviceMatrix(S.design.nodes, n.id);
      // 取 PID 那行文字所在的区域
      const p = window.matApply(m, n.w * 0.06, n.h * 0.22);
      // 整张画布指纹：比"某个点"稳，不受节点位置影响
      const grab = () => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) % 2147483647;
        return h;
      };
      S.showPid = false; window.draw(); const off = grab();
      S.showPid = true;  window.draw(); const on = grab();
      S.showPid = false; window.draw();
      return JSON.stringify({ off: off, on: on });
    })()`);
    const PP = JSON.parse(pidPix);
    console.log('    · PID 行像素亮度和：关=' + PP.off + ' 开=' + PP.on);
    ok(PP.on !== PP.off, '开关真的改变了画布内容（像素级验证）');

    // ---------- 5) 提示文字已删除 ----------
    console.log('\n=== 5. 那段提示文字已删除 ===');
    const hint = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      S.selection = [n.id];
      window.onSelectionChanged();
      const txt = document.getElementById('props').textContent;
      return JSON.stringify({ hasOld: /绕\\*\\*自身中心\\*\\*/.test(txt) || /额外\\*\\*倍率/.test(txt),
        hasAny: /自身中心/.test(txt) || /额外倍率/.test(txt), len: txt.length });
    })()`);
    const H = JSON.parse(hint);
    console.log('    · ' + hint);
    ok(!H.hasAny, '「旋转绕自身中心；缩放是额外倍率」这段已删除');

    // ---------- 6) 右键菜单里有打组 ----------
    console.log('\n=== 6. 右键菜单含打组/取消组合 ===');
    const menu = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const all = window.flatten(S.design.nodes).filter(x => x.type === 'gauge');
      S.selection = [all[0].id, all[1].id];
      window.onSelectionChanged();
      window.showCtxMenu(300, 300);
      const multi = Array.from(document.querySelectorAll('#ctxMenu .ctxItem')).map(e => e.textContent.trim());
      const g = S.design.nodes.find(x => x.type === 'group');
      S.selection = g ? [g.id] : [];
      window.onSelectionChanged();
      window.showCtxMenu(300, 300);
      const onGroup = Array.from(document.querySelectorAll('#ctxMenu .ctxItem')).map(e => e.textContent.trim());
      window.hideCtxMenu();
      return JSON.stringify({ multi: multi, onGroup: onGroup });
    })()`);
    const MN = JSON.parse(menu);
    console.log('    · 多选: ' + MN.multi.filter(x => /组/.test(x)).join(' / '));
    console.log('    · 选中分组: ' + MN.onGroup.filter(x => /组/.test(x)).join(' / '));
    ok(MN.multi.some(x => /打组/.test(x)), '多选时菜单有「打组」');
    ok(MN.multi.some(x => /Ctrl\+G/.test(x)), '打组显示快捷键 Ctrl+G');
    ok(MN.onGroup.some(x => /取消组合/.test(x)), '选中分组时菜单有「取消组合」');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
