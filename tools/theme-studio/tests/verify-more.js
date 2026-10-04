const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9283;
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
    `--user-data-dir=${os.tmpdir()}\\edge-more`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 8).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    console.log('\n=== 1. 素材与控件数量 ===');
    const counts = await cdp.eval(`JSON.stringify({
      assets: (window.BUILTIN_ASSETS||[]).length,
      assetKinds: [...new Set((window.BUILTIN_ASSETS||[]).map(a=>a.kind))].length,
      controls: window.BUILTIN_CONTROLS.length,
      controlNames: window.BUILTIN_CONTROLS.map(c=>c.name),
    })`);
    const C = JSON.parse(counts);
    console.log('    · 素材 ' + C.assets + ' 个（' + C.assetKinds + ' 类）');
    console.log('    · 控件 ' + C.controls + ' 个');
    console.log('    · 名字: ' + C.controlNames.join(' / '));
    ok(C.assets >= 90, `素材 ≥90（实际 ${C.assets}）`);
    ok(C.controls >= 40, `控件 ≥40（实际 ${C.controls}）`);

    console.log('\n=== 2. 每个控件都能造出来且不报错 ===');
    const make = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const bad = [];
      let okCount = 0;
      window.BUILTIN_CONTROLS.forEach(c => {
        try {
          const n = c.make();
          if (!n || !n.type) { bad.push(c.key + ': 没返回节点'); return; }
          if (!(n.w > 0) || !(n.h > 0)) { bad.push(c.key + ': 尺寸非法'); return; }
          okCount++;
        } catch (e) { bad.push(c.key + ': ' + e.message); }
      });
      return JSON.stringify({ okCount, bad, total: window.BUILTIN_CONTROLS.length });
    })()`);
    const M = JSON.parse(make);
    console.log('    · ' + M.okCount + '/' + M.total + ' 可创建');
    if (M.bad.length) M.bad.slice(0, 6).forEach(b => console.log('      ⚠️ ' + b));
    eq(M.okCount, M.total, '全部控件都能创建');

    console.log('\n=== 3. 图片类控件会自动登记素材（不再是紫框大 X）===');
    const img = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.design.assets = [];
      S.design.nodes = [];
      const c = window.BUILTIN_CONTROLS.find(x => x.key === 'img_ring');
      const n = c.make();
      const a = (S.design.assets || []).find(x => x.id === n.assetId);
      return JSON.stringify({
        有assetId: !!n.assetId,
        已登记: !!a,
        路径: a ? a.path : null,
        有data: a ? !!a.data : false,
      });
    })()`);
    const I = JSON.parse(img);
    console.log('    · ' + img);
    ok(I.有assetId, '图片控件带 assetId');
    ok(I.已登记, '素材被自动登记进设计');
    ok(I.有data, '登记时带了内嵌 data（不污染画布）');

    console.log('\n=== 4. 拼装控件带 parts ===');
    const parts = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.design.assets = [];
      const c = window.BUILTIN_CONTROLS.find(x => x.key === 'gauge_parts');
      const n = c.make();
      return JSON.stringify({
        有parts: !!(n.parts && n.parts.length),
        部件数: n.parts ? n.parts.length : 0,
        种类: n.parts ? n.parts.map(p => p.kind).join(',') : null,
        指针有扫描: n.parts ? n.parts.some(p => p.kind === 'needle' && p.sweepTo === 405) : false,
        两个指针绑不同PID: n.parts
          ? (function () {
              const ns = n.parts.filter(p => p.kind === 'needle');
              return ns.length >= 2 && ns[0].pid !== ns[1].pid && !!ns[1].pid;
            })()
          : false,
        素材都登记了: n.parts ? n.parts.filter(p => p.assetId).every(p =>
          (S.design.assets||[]).some(a => a.id === p.assetId)) : false,
      });
    })()`);
    const PT = JSON.parse(parts);
    console.log('    · ' + parts);
    ok(PT.有parts, '拼装控件带 parts');
    // v2.17.0 把「拼装圆表」改成**双针示例**（长针转速 + 短针车速），所以是 5 个部件
    eq(PT.部件数, 5, '5 个部件（表盘/刻度/2 个指针/数值）');
    ok(PT.两个指针绑不同PID, '两个指针各绑一个 PID（多指针表）');
    ok(PT.指针有扫描, '指针带扫描范围');
    ok(PT.素材都登记了, '部件引用的素材都登记了');

    console.log('\n=== 5. 界面几何（自己检查观感）===');
    const geo = await cdp.eval(`(() => {
      const box = id => document.getElementById(id);
      const r = id => { const b = box(id); if (!b) return null; const x = b.getBoundingClientRect(); return { w: Math.round(x.width), h: Math.round(x.height) }; };
      const overflow = [];
      document.querySelectorAll('#assets *, #tree *, #props *').forEach(e => {
        const b = e.getBoundingClientRect();
        if (b.width === 0) return;
        const p = e.parentElement ? e.parentElement.getBoundingClientRect() : null;
        if (p && (b.right > p.right + 2 || b.left < p.left - 2)) overflow.push((e.className||e.tagName) + ' 横向溢出');
      });
      return JSON.stringify({
        素材库: r('assets'), 控件树: r('tree'), 属性: r('props'),
        素材库可滚: box('assetsBody') ? box('assetsBody').scrollHeight > box('assetsBody').clientHeight : false,
        控件树可滚: box('tree') ? true : false,
        横向溢出: overflow.slice(0, 5),
        溢出数: overflow.length,
      });
    })()`);
    const G = JSON.parse(geo);
    console.log('    · 素材库 ' + JSON.stringify(G.素材库) + '  控件树 ' + JSON.stringify(G.控件树) + '  属性 ' + JSON.stringify(G.属性));
    console.log('    · 横向溢出元素: ' + G.溢出数);
    G.横向溢出.forEach(o => console.log('      ⚠️ ' + o));
    ok(G.素材库 && G.素材库.h > 80, '素材库有高度');
    ok(G.控件树 && G.控件树.h > 80, '控件树有高度');
    ok(G.溢出数 === 0, '没有元素横向溢出面板');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
