// 验证：对齐参考线 / 组的进入退出 / 撤销栈持久化
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9265;
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
    `--user-data-dir=${os.tmpdir()}\\edge-v27`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval(`window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'x';`);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 对齐吸附的**逻辑** ----------
    console.log('\n=== 1. 对齐吸附（直接测逻辑）===');
    const snap = await cdp.eval(`(() => {
      const A = { id: 'A', x: 50, y: 50, w: 100, h: 100 };
      const out = {};
      let s = window.computeSnap([{ id: 'B', x: 200, y: 53, w: 100, h: 100 }], [A]);
      out.near = { dy: s.dy, guides: s.guides.length, axis: s.guides.map(g => g.axis).join(',') };
      // ⚠️ 原来用 y=80，但它的下边正好落在 180（画布中线）—— 有参考线是**对的**。
      // 换一个离所有候选都远的位置（边 137/187/237，都超过阈值 6）。
      s = window.computeSnap([{ id: 'B', x: 200, y: 137, w: 100, h: 100 }], [A]);
      out.far = { dy: s.dy, guides: s.guides.length };
      s = window.computeSnap([{ id: 'B', x: 146, y: 300, w: 100, h: 100 }], [A]);
      out.left = { dx: s.dx, guides: s.guides.length };
      s = window.computeSnap([{ id: 'B', x: 128, y: 300, w: 100, h: 100 }], []);
      out.mid = { dx: s.dx, from: s.guides.map(g => g.from).join(',') };
      s = window.computeSnap([{ id: 'B', x: 100, y: 100, w: 20, h: 20 }], []);
      out.none = { dx: s.dx, dy: s.dy, guides: s.guides.length };
      // 多个一起拖：按**整体包围盒**对齐，不是各自吸各自的
      s = window.computeSnap([
        { id: 'B', x: 200, y: 53, w: 100, h: 100 },
        { id: 'C', x: 200, y: 200, w: 100, h: 100 },
      ], [A]);
      out.multi = { dy: s.dy, guides: s.guides.length };
      return JSON.stringify(out);
    })()`);
    const SN = JSON.parse(snap);
    console.log('    · ' + snap);
    eq(SN.near.dy, -3, '上边差 3 → 吸附（dy = -3）');
    ok(SN.near.guides >= 1, '吸附时产生参考线');
    eq(SN.far.dy, 0, '差 30 → 不吸附（阈值生效）');
    eq(SN.far.guides, 0, '离所有候选都远时没有参考线');
    // 反过来钉住：y=80 时下边正好是画布中线 180 —— **应该**给参考线
    const midGuide = await cdp.eval(`JSON.stringify(window.computeSnap([{id:'B',x:200,y:80,w:100,h:100}], [{id:'A',x:50,y:50,w:100,h:100}]).guides.map(g=>g.axis+'@'+g.at+':'+g.from))`);
    ok(JSON.parse(midGuide).some(s => s.indexOf('y@180:canvas') >= 0), '下边落在画布中线时给参考线（这是对的，不是误报）：' + midGuide);
    eq(SN.left.dx, 4, '左边差 4 → 吸附到 A 的右边');
    eq(SN.mid.dx, 2, '中心差 2 → 吸附到画布中线');
    ok(SN.mid.from.indexOf('canvas') >= 0, '画布来源被标记（参考线用不同颜色）');
    eq(SN.none.guides, 0, '没有候选时不吸附');
    eq(SN.multi.dy, -3, '多个一起拖 → 按整体包围盒吸附');

    // ---------- 2) 参考线的显示与清理 ----------
    console.log('\n=== 2. 参考线的显示与清理 ===');
    const lineState = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const cv = document.getElementById('cv');
      S.design.nodes = [];
      const a = window.createNode(window.NODE_TEXT, { name: 'A', text: 'A', x: 50, y: 50, w: 100, h: 100 });
      const b = window.createNode(window.NODE_TEXT, { name: 'B', text: 'B', x: 200, y: 53, w: 100, h: 100 });
      S.design.nodes.push(a, b);
      S.selection = [b.id];
      // 直接设参考线并画一帧：确认 draw 不报错
      S.snapLines = [{ axis: 'x', at: 100, from: 'canvas' }, { axis: 'y', at: 150, from: a.id }];
      let drawErr = null;
      try { window.draw(); } catch (e) { drawErr = e.message; }
      const n = S.snapLines.length;
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return JSON.stringify({ n: n, drawErr: drawErr, afterUp: (S.snapLines || []).length });
    })()`);
    const LS = JSON.parse(lineState);
    console.log('    · ' + lineState);
    ok(LS.drawErr === null, '画参考线不报错' + (LS.drawErr ? '：' + LS.drawErr : ''));
    eq(LS.afterUp, 0, '松手后参考线清掉（不会一直留在画布上）');

    // ---------- 3) 组的进入 / 退出 ----------
    console.log('\n=== 3. 组的进入 / 退出（面包屑）===');
    const drill = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.design.nodes = [];
      const g1 = window.createNode(window.NODE_GROUP, { name: '外层组', x: 20, y: 20, w: 300, h: 300 });
      const g2 = window.createNode(window.NODE_GROUP, { name: '内层组', x: 10, y: 10, w: 200, h: 200 });
      const leaf = window.createNode(window.NODE_TEXT, { name: '叶子', text: 'x', x: 5, y: 5, w: 50, h: 30 });
      g2.children = [leaf];
      g1.children = [g2];
      S.design.nodes = [g1];
      const bar = document.getElementById('breadcrumb');
      const out = {};
      // ⚠️ 用 getComputedStyle：display:none 来自 CSS 表，读 style.display 是空串
      out.初始显示 = getComputedStyle(bar).display;
      S.selection = [leaf.id];
      S.drillPath = window.groupChainOf(leaf.id).map(g => g.id);
      let err = null;
      try { window.updateBreadcrumb(); } catch (e) { err = e.message; }
      out.错误 = err;
      out.进入后显示 = getComputedStyle(bar).display;
      out.面包屑文字 = bar.textContent.replace(/\\s+/g, ' ').trim();
      out.段数 = bar.querySelectorAll('.bcSeg').length;
      out.当前段 = (bar.querySelector('.bcCur') || {}).textContent || null;
      out.有退出按钮 = !!bar.querySelector('.bcExit');
      window.drillExit();
      out.退出后文字 = bar.textContent.replace(/\\s+/g, ' ').trim();
      window.drillExit();
      out.回画布显示 = getComputedStyle(bar).display;
      return JSON.stringify(out);
    })()`);
    const DR = JSON.parse(drill);
    console.log('    · ' + drill);
    ok(DR.错误 === null, 'updateBreadcrumb 不报错' + (DR.错误 ? '：' + DR.错误 : ''));
    eq(DR.初始显示, 'none', '在画布层不显示面包屑（CSS 生效）');
    eq(DR.进入后显示, 'flex', '进入分组后显示');
    eq(DR.段数, 3, '面包屑有 3 段（画布 + 2 层组）');
    eq(DR.当前段, '内层组', '当前层高亮正确');
    ok(DR.有退出按钮, '有「退出」按钮');
    ok(DR.退出后文字.indexOf('外层组') >= 0 && DR.退出后文字.indexOf('内层组') < 0, '退出一层 → 只剩外层组');
    eq(DR.回画布显示, 'none', '再退一层 → 回到画布层，面包屑隐藏');

    // ---------- 4) 撤销栈持久化 ----------
    console.log('\n=== 4. 撤销栈持久化 ===');
    const undo = await cdp.eval(`(() => {
      const S = window.CanvasState;
      localStorage.removeItem('icar-studio-undo');
      S.design.nodes = [];
      const n1 = window.createNode(window.NODE_TEXT, { name: 'U1', text: '1', x: 10, y: 10, w: 60, h: 30 });
      window.commit(() => { S.design.nodes.push(n1); }, '加 U1');
      const n2 = window.createNode(window.NODE_TEXT, { name: 'U2', text: '2', x: 10, y: 50, w: 60, h: 30 });
      window.commit(() => { S.design.nodes.push(n2); }, '加 U2');
      const raw = localStorage.getItem('icar-studio-undo');
      const o = raw ? JSON.parse(raw) : null;
      return JSON.stringify({
        saved: !!raw,
        steps: o ? o.stack.length : 0,
        name: o ? o.designName : null,
        curName: S.design.name,
        nodesInTop: o ? JSON.parse(o.stack[o.index].state).d.nodes.length : -1,
      });
    })()`);
    const U = JSON.parse(undo);
    console.log('    · ' + undo);
    ok(U.saved, '撤销栈写进了 localStorage');
    ok(U.steps >= 2, `存了 ${U.steps} 步（≥2）`);
    eq(U.name, U.curName, '记了设计名（防止"撤销到别的设计去"）');
    ok(U.nodesInTop >= 2, '栈顶快照含当前节点');

    const cap = await cdp.eval(`(() => {
      const S = window.CanvasState;
      for (let i = 0; i < 30; i++) {
        const n = window.createNode(window.NODE_TEXT, { name: 'X' + i, text: 'x', x: 5, y: 5, w: 20, h: 20 });
        window.commit(() => { S.design.nodes.push(n); }, '批量' + i);
      }
      const raw = localStorage.getItem('icar-studio-undo');
      const o = JSON.parse(raw);
      return JSON.stringify({ steps: o.stack.length, kb: Math.round(raw.length / 1024) });
    })()`);
    const C = JSON.parse(cap);
    console.log('    · ' + cap);
    // 上限是**字节预算**（1.2 MB）+ 40 步兜底 —— 按字节才是真正的约束：
    // 3 个控件的设计和 200 个控件的设计，单步快照能差两个数量级，
    // 写死步数要么浪费要么写爆。
    ok(C.steps <= 40, `步数不超过兜底上限 40（实际 ${C.steps}）`);
    ok(C.kb <= 1200, `占用 ${C.kb} KB ≤ 1.2 MB 预算`);
    ok(C.steps >= 10, `字节预算下能存下 ${C.steps} 步（不是一压就爆）`);

    // 刷新后还能撤销（真持久化）
    const before = await cdp.eval(`JSON.stringify({ nodes: window.flatten(window.CanvasState.design.nodes).length, name: window.CanvasState.design.name })`);
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    const after = await cdp.eval(`(() => {
      const raw = localStorage.getItem('icar-studio-undo');
      const o = raw ? JSON.parse(raw) : null;
      return JSON.stringify({ 还在: !!o, 步数: o ? o.stack.length : 0, 设计名: o ? o.designName : null });
    })()`);
    const AF = JSON.parse(after);
    console.log('    · 刷新前 ' + before);
    console.log('    · 刷新后 ' + after);
    ok(AF.还在, '刷新页面后撤销栈还在（这就是"持久化"的意义）');
    ok(AF.步数 >= 2, `刷新后仍有 ${AF.步数} 步可退`);

  
  // ---------- 两种吸附独立（v2.20.0）
  console.log('\n=== 网格吸附 vs 对象吸附 ===');
  const sp = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    out.默认_网格 = S.snap;
    out.默认_对象 = S.snapGuides !== false;
    out.有网格按钮 = !!document.getElementById('btnSnap');
    out.有对象按钮 = !!document.getElementById('btnSnapObj');
    out.网格按钮文案 = (document.getElementById('btnSnap') || {}).textContent || '';
    out.对象按钮文案 = (document.getElementById('btnSnapObj') || {}).textContent || '';
    out.两个toggle都存在 = typeof window.toggleSnap === 'function' && typeof window.toggleSnapObj === 'function';

    // 关掉网格 → 对象不该受影响
    const g0 = S.snap, o0 = S.snapGuides;
    window.toggleSnap();
    out.关网格后_网格 = S.snap;
    out.关网格后_对象 = S.snapGuides;
    window.toggleSnap();  // 还原
    out.还原_网格 = S.snap;

    // 关掉对象 → 网格不该受影响
    window.toggleSnapObj();
    out.关对象后_网格 = S.snap;
    out.关对象后_对象 = S.snapGuides;
    window.toggleSnapObj();  // 还原
    out.还原_对象 = S.snapGuides;

    // 网格吸附真的把坐标吸到 STEP 的整数倍
    S.snap = true;
    out.网格吸附_187 = window.snapIf(187.4);
    S.snap = false;
    out.无网格_187 = window.snapIf(187.4);
    S.snap = g0; S.snapGuides = o0;

    // 对象吸附真的算出对齐量
    const moving = [{ id: 'm', x: 103, y: 50, w: 40, h: 40 }];
    const others = [{ id: 'o', x: 100, y: 0, w: 60, h: 60 }];
    const r = window.computeSnap(moving, others);
    out.对象吸附_dx = r.dx;
    out.对象吸附_有参考线 = r.guides.length > 0;
    return JSON.stringify(out);
  })()`);
  const SP = JSON.parse(sp);
  console.log('    · ' + sp);
  ok(SP.有网格按钮 && SP.有对象按钮, '两个吸附按钮都在');
  ok(SP.两个toggle都存在, 'toggleSnap 与 toggleSnapObj 都在');
  ok(SP.网格按钮文案.indexOf('网格') >= 0, '网格按钮文案点明是「网格」：' + SP.网格按钮文案);
  ok(SP.对象按钮文案.indexOf('对象') >= 0, '对象按钮文案点明是「对象」：' + SP.对象按钮文案);
  eq(SP.关网格后_网格, false, '关掉网格吸附');
  eq(SP.关网格后_对象, SP.默认_对象, '**关网格不影响对象吸附**');
  eq(SP.关对象后_网格, SP.还原_网格, '**关对象不影响网格吸附**');
  eq(SP.关对象后_对象, false, '关掉对象吸附');
  eq(SP.还原_网格, true, '网格能还原');
  eq(SP.还原_对象, true, '对象能还原');
  eq(SP.网格吸附_187, 180, '网格开：187.4 → 180（15 的整数倍）');
  eq(SP.无网格_187, 187.4, '网格关：187.4 保持原值');
  ok(SP.对象吸附_dx !== 0, '对象吸附算出对齐量 dx=' + SP.对象吸附_dx);
  ok(SP.对象吸附_有参考线, '对象吸附给出参考线（画布上要画出来）');

  await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
