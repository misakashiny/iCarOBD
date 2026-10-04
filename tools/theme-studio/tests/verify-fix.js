// 验证本轮修复：大 X / 滚动 / 面板收起 / 固定高度
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9281;
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
    `--user-data-dir=${os.tmpdir()}\\edge-fix`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval(`window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'x'; localStorage.clear();`);
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 6).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 大 X：内置素材按 path 加载 ----------
    console.log('\n=== 1. 内置素材能被画布画出来（修大 X）===');
    const url = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const path = (window.BUILTIN_ASSETS || []).find(a => a.kind === 'warning').path;
      window.useBuiltinAsset(path);
      const img = window.flatten(S.design.nodes).filter(n => n.type === 'image').pop();
      const id = img.assetId;
      return JSON.stringify({
        assetId: id,
        有URL: !!S.assetUrls[id],
        URL值: S.assetUrls[id] || null,
        节点名: img.name,
      });
    })()`);
    const U = JSON.parse(url);
    console.log('    · ' + url);
    ok(U.有URL, '内置素材拿到了可显示的 URL（之前是 undefined → 大 X）');
    // URL 现在是**内嵌 data URL**（不是 path）—— 这是有意的：
    // file:// 下按 path 加载的图会污染画布，导致 toDataURL 抛 SecurityError。
    ok(U.URL值 && U.URL值.indexOf('data:image/png') === 0,
      'URL 是内嵌 data URL（不污染画布，导出 PNG 才能用）');

    // 等图片解码，然后数紫色占位像素。
    // ⚠️ 只取图片覆盖的那一小块（200×200）—— 之前取 300×300 且整幅扫，
    // 在 headless 里会让 CDP 目标不稳定。
    await sleep(700);
    const pixels = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const img = window.flatten(S.design.nodes).filter(n => n.type === 'image').pop();
      img.x = 0; img.y = 0; img.w = 200; img.h = 200;
      S.design.nodes = [img];
      S.selection = []; S.showGrid = false;
      window.draw();
      const cv = document.getElementById('cv');
      // 画布位图比 CSS 尺寸大，按比例换算到节点覆盖的区域
      const k = cv.width / cv.getBoundingClientRect().width;
      const w = Math.min(cv.width, Math.round(200 * k));
      const h = Math.min(cv.height, Math.round(200 * k));
      const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
      let purple = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 90 && d[i] < 160 && d[i+1] > 60 && d[i+1] < 130 && d[i+2] > 200) purple++;
      }
      const url = S.assetUrls[img.assetId];
      const im = S.imgCache[url];
      S.showGrid = true;
      return JSON.stringify({
        紫色像素: purple,
        采样像素: w * h,
        图已解码: !!(im && im.complete && im.naturalWidth),
      });
    })()`);
    const P = JSON.parse(pixels);
    console.log('    · ' + pixels);
    ok(P.图已解码, '素材图真的解码了');
    ok(P.紫色像素 / P.采样像素 < 0.01, `紫色占位像素占比 ${(P.紫色像素 / P.采样像素 * 100).toFixed(2)}%（< 1%）—— 大 X 没了`);

    // ---------- 2) 素材库能滚动 ----------
    console.log('\n=== 2. 素材库能滚动（之前被 overflow:hidden 裁掉）===');
    const scroll = await cdp.eval(`(() => {
      window.resetPanelLayout && window.resetPanelLayout();
      const body = document.getElementById('assetsBody');
      const out = {
        有滚动体: !!body,
        溢出样式: body ? getComputedStyle(body).overflowY : null,
        内容高: body ? body.scrollHeight : -1,
        可视高: body ? body.clientHeight : -1,
      };
      if (body) { body.scrollTop = 9999; out.滚动后scrollTop = body.scrollTop; }
      out.可滚动 = out.内容高 > out.可视高 && out.滚动后scrollTop > 0;
      return JSON.stringify(out);
    })()`);
    const SC = JSON.parse(scroll);
    console.log('    · ' + scroll);
    ok(SC.有滚动体, '素材库有独立的滚动容器 #assetsBody');
    ok(SC.溢出样式 === 'auto' || SC.溢出样式 === 'scroll', 'overflow-y 是 auto/scroll（实际 ' + SC.溢出样式 + '）');
    ok(SC.可滚动, `真的能滚（内容 ${SC.内容高} > 可视 ${SC.可视高}）`);

    // ---------- 3) 面板收起 ----------
    console.log('\n=== 3. 三个面板都能收起来 ===');
    const collapse = await cdp.eval(`(() => {
      const out = {};
      const box = id => document.getElementById(id);
      const h = id => Math.round(box(id).getBoundingClientRect().height);

      out.收起前_素材库 = h('assets');
      out.收起前_控件树 = h('tree');
      out.有素材库标题条 = !!document.querySelector('#assets .panelBar');
      out.有控件树标题条 = !!document.querySelector('#tree .panelBar');
      out.有拖拽手柄 = !!document.querySelector('#assets .panelResize');

      window.togglePanelCollapse('assets');
      out.收起后_素材库 = h('assets');
      out.收起后_控件树 = h('tree');
      out.素材库有collapsed类 = box('assets').classList.contains('collapsed');
      out.收起后滚动体隐藏 = getComputedStyle(document.getElementById('assetsBody')).display === 'none';

      window.togglePanelCollapse('assets');
      out.展开回来_素材库 = h('assets');

      window.togglePanelCollapse('tree');
      out.收起控件树 = h('tree');
      out.控件树有collapsed类 = box('tree').classList.contains('collapsed');
      window.togglePanelCollapse('tree');
      return JSON.stringify(out);
    })()`);
    const CO = JSON.parse(collapse);
    console.log('    · ' + collapse);
    ok(CO.有素材库标题条, '素材库有标题条');
    ok(CO.有控件树标题条, '控件树有标题条');
    ok(CO.有拖拽手柄, '素材库有拖拽调高手柄');
    ok(CO.收起后_素材库 < CO.收起前_素材库, `收起素材库后变矮（${CO.收起前_素材库} → ${CO.收起后_素材库}）`);
    ok(CO.素材库有collapsed类, '收起时加了 collapsed 类');
    ok(CO.收起后滚动体隐藏, '收起时滚动体隐藏');
    ok(CO.展开回来_素材库 >= CO.收起前_素材库 - 5, `能展开回来（${CO.展开回来_素材库}）`);
    ok(CO.收起控件树 < CO.收起前_控件树, `控件树也能收（${CO.收起前_控件树} → ${CO.收起控件树}）`);

    // ---------- 4) 素材库固定高度：展开分类不会挤走控件树 ----------
    console.log('\n=== 4. 展开分类不会把控件树挤出去 ===');
    const stable = await cdp.eval(`(() => {
      const h = id => Math.round(document.getElementById(id).getBoundingClientRect().height);
      const before = { assets: h('assets'), tree: h('tree') };
      // 展开全部分类
      window.assetsExpandAll(true);
      const afterExpand = { assets: h('assets'), tree: h('tree') };
      // 收起全部分类
      window.assetsExpandAll(false);
      const afterFold = { assets: h('assets'), tree: h('tree') };
      return JSON.stringify({ before, afterExpand, afterFold });
    })()`);
    const ST = JSON.parse(stable);
    console.log('    · ' + stable);
    eq(ST.afterExpand.assets, ST.before.assets, '展开全部分类后素材库高度**不变**（固定高度）');
    eq(ST.afterExpand.tree, ST.before.tree, '控件树高度也**不变** —— 不会被挤出去');
    eq(ST.afterFold.assets, ST.before.assets, '收起全部分类后高度仍不变');

    // ---------- 5) 高度持久化 ----------
    console.log('\n=== 5. 面板状态持久化 ===');
    const persist = await cdp.eval(`(() => {
      window.togglePanelCollapse('tree');
      const saved = JSON.parse(localStorage.getItem('icar-studio-panels') || '{}');
      return JSON.stringify(saved);
    })()`);
    const PE = JSON.parse(persist);
    console.log('    · ' + persist);
    ok(PE.treeCollapsed === true, '收起状态写进了 localStorage');
    ok(typeof PE.assetHeight === 'number' || PE.assetHeight === 0, '高度也记了（' + PE.assetHeight + '）');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
