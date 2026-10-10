const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9293;
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
    `--user-data-dir=${os.tmpdir()}\\edge-props`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval(`localStorage.clear();`);
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    console.log('\n=== 1. 属性面板可拖拽调高 ===');
    const drag = await cdp.eval(`(() => {
      const S = window.CanvasState;
      // 选中一个控件，属性面板才有内容
      const n = window.flatten(S.design.nodes)[0];
      if (n) { S.selection = [n.id]; window.onSelectionChanged(); }
      const props = document.getElementById('props');
      const handle = document.querySelector('.propsWrap .panelResize');
      const out = {};
      out.有手柄 = !!handle;
      out.手柄标题 = handle ? handle.getAttribute('title') : null;
      out.拖前高 = Math.round(props.getBoundingClientRect().height);
      out.拖前有内联高度 = !!props.style.height;
      if (!handle) return JSON.stringify(out);

      // 模拟拖拽：按下 → 移动 +160 → 松开
      const r = handle.getBoundingClientRect();
      const y0 = r.top + 2;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true,
        clientX: r.left + 5, clientY: y0, pointerId:1, isPrimary:true }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles:true,
        clientX: r.left + 5, clientY: y0 + 160, pointerId:1, isPrimary:true }));
      out.拖中高 = Math.round(props.getBoundingClientRect().height);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1, isPrimary:true }));
      out.拖后有内联高度 = props.style.height;
      out.存的高度 = (window.panelHeights || {}).props;
      out.持久化 = JSON.parse(localStorage.getItem('icar-studio-panels') || '{}').propsHeight;
      // 面板不能超出视口
      out.在视口内 = props.getBoundingClientRect().bottom <= window.innerHeight + 2;
      return JSON.stringify(out);
    })()`);
    const D = JSON.parse(drag);
    console.log('    · ' + drag);
    ok(D.有手柄, '属性面板有拖拽手柄');
    ok(D.手柄标题 && D.手柄标题.indexOf('属性面板') >= 0, '手柄有提示文字');
    ok(D.拖中高 > D.拖前高, `拖动时变高（${D.拖前高} → ${D.拖中高}）`);
    ok(D.拖后有内联高度, '松开后高度被固定（' + D.拖后有内联高度 + '）');
    ok(D.存的高度 > 0, '高度记在 panelHeights 里（' + D.存的高度 + '）');
    eq(D.持久化, D.存的高度, '高度写进了 localStorage');
    // ⚠️ **不要求**面板底部在视口内 —— 右栏本来就能滚动；
    // 强行卡住会让「往下拖反而变矮」（实测踩过）。只要求高度合理。
    ok(D.拖中高 >= 100, `高度在合理范围（${D.拖中高}px）`);

    console.log('\n=== 2. 两个面板用同一套交互 ===');
    const same = await cdp.eval(`(() => {
      const a = document.querySelector('#assets .panelResize');
      const p = document.querySelector('.propsWrap .panelResize');
      return JSON.stringify({
        素材库手柄: !!a, 属性手柄: !!p,
        素材库onpointerdown: a ? a.getAttribute('onpointerdown') : null,
        属性onpointerdown: p ? p.getAttribute('onpointerdown') : null,
        同一函数: !!(a && p && a.getAttribute('onpointerdown').indexOf('beginPanelResize') >= 0
                  && p.getAttribute('onpointerdown').indexOf('beginPanelResize') >= 0),
      });
    })()`);
    const SM = JSON.parse(same);
    console.log('    · ' + same);
    ok(SM.素材库手柄 && SM.属性手柄, '两个面板都有手柄');
    ok(SM.同一函数, '用的是同一个 beginPanelResize（不会各写一份分叉）');

    console.log('\n=== 3. 最小高度保护 ===');
    const minH = await cdp.eval(`(() => {
      const props = document.getElementById('props');
      const handle = document.querySelector('.propsWrap .panelResize');
      const r = handle.getBoundingClientRect();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true,
        clientX: r.left + 5, clientY: r.top + 2, pointerId:1, isPrimary:true }));
      // 往上拖 9999px（想拖到 0）
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles:true,
        clientX: r.left + 5, clientY: r.top - 9999, pointerId:1, isPrimary:true }));
      const h = Math.round(props.getBoundingClientRect().height);
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1, isPrimary:true }));
      return JSON.stringify({ 拖到极矮: h });
    })()`);
    const MH = JSON.parse(minH);
    console.log('    · ' + minH);
    ok(MH.拖到极矮 >= 100, `有最小高度保护（拖到底仍是 ${MH.拖到极矮}px，≥100）`);

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
