// 验证 P8-5：设计文件内嵌主题配色
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9295;
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
    `--user-data-dir=${os.tmpdir()}\\edge-theme`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
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
    errs.slice(0, 4).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    console.log('\n=== 1. 主题色常量 ===');
    const c1 = await cdp.eval(`JSON.stringify({
      aliases: window.THEME_ALIASES,
      themes: Object.keys(window.GAUGE_THEMES || {}),
      neonAccent: (window.GAUGE_THEMES || {}).neon?.accent,
      neonGlow: (window.GAUGE_THEMES || {}).neon?.glow,
      iceGlow: (window.GAUGE_THEMES || {}).ice?.glow,
      fields: Object.keys((window.GAUGE_THEMES || {}).neon || {}).length,
    })`);
    const C = JSON.parse(c1);
    console.log('    · ' + c1);
    eq(C.aliases.length, 3, '3 个主题别名');
    eq(C.themes.length, 3, '3 套主题定义');
    eq(C.neonAccent, '#FF8A00', 'neon 的 accent 是 #FF8A00');
    eq(C.neonGlow, true, 'neon 的 glow 是 true');
    eq(C.iceGlow, false, 'ice 的 glow 是 false');
    // 12 个颜色字段 + title + description + glow = 15
    eq(C.fields, 15, `每套主题 15 个字段（12 色 + title/desc/glow）`);

    console.log('\n=== 2. 序列化时内嵌配色 ===');
    const c2 = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const out = {};
      S.design.themeId = 'neon';
      const j = JSON.parse(window.toV2Json(S.design));
      out.theme = j.theme;
      out.hasColors = !!j.themeColors;
      out.accent = j.themeColors ? j.themeColors.accent : null;
      out.字段与Kotlin一致 = j.themeColors ? [
        'background','surface','surfaceEdge','accent','accentHot','accentDim',
        'track','tick','needle','value','label','dim'
      ].every(k => typeof j.themeColors[k] === 'string') : false;
      // 换个主题
      S.design.themeId = 'ice';
      const j2 = JSON.parse(window.toV2Json(S.design));
      out.iceAccent = j2.themeColors ? j2.themeColors.accent : null;
      // 未知主题名 → 不写 themeColors（而不是写个错的）
      S.design.themeId = '不存在的主题';
      const j3 = JSON.parse(window.toV2Json(S.design));
      out.未知主题有colors = !!j3.themeColors;
      // 空主题 → 也不写
      S.design.themeId = '';
      const j4 = JSON.parse(window.toV2Json(S.design));
      out.空主题有colors = !!j4.themeColors;
      S.design.themeId = 'neon';
      return JSON.stringify(out);
    })()`);
    const C2 = JSON.parse(c2);
    console.log('    · ' + c2);
    eq(C2.theme, 'neon', 'theme 名字照旧写出');
    ok(C2.hasColors, 'themeColors 被写进设计文件');
    eq(C2.accent, '#FF8A00', 'neon 的 accent 正确');
    ok(C2.字段与Kotlin一致, '12 个颜色字段名与 GaugeTheme.toJson 一致（App 能直接 fromJson）');
    eq(C2.iceAccent, '#28D7FF', '换主题后写的是对应配色');
    ok(!C2.未知主题有colors, '未知主题名**不写** themeColors（不编造）');
    ok(!C2.空主题有colors, '空主题**不写** themeColors');

    console.log('\n=== 3. 往返：themeColors 不丢 ===');
    const c3 = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.design.themeId = 'amber';
      const json = window.toV2Json(S.design);
      const r = window.parseDesign(json);
      return JSON.stringify({
        errors: r.errors.length,
        themeId: r.design ? r.design.themeId : null,
        hasColors: r.design ? !!r.design.themeColors : false,
        accent: r.design && r.design.themeColors ? r.design.themeColors.accent : null,
        一致: r.design && r.design.themeColors
          ? JSON.stringify(r.design.themeColors) === JSON.stringify(window.GAUGE_THEMES.amber)
          : false,
      });
    })()`);
    const C3 = JSON.parse(c3);
    console.log('    · ' + c3);
    eq(C3.errors, 0, '往返 0 错误');
    eq(C3.themeId, 'amber', '主题名保留');
    ok(C3.hasColors, 'themeColors 往返后还在');
    ok(C3.一致, '往返后配色逐项一致');

    console.log('\n=== 4. 向后兼容：老文件没有 themeColors ===');
    const c4 = await cdp.eval(`(() => {
      const r = window.parseDesign(JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 }, theme: 'ice',
        nodes: [{ id:'g', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000, x:0,y:0,w:180,h:180 }]
      }));
      const bad = window.parseDesign(JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 }, theme: 'ice', themeColors: '不是对象',
        nodes: [{ id:'g', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000, x:0,y:0,w:180,h:180 }]
      }));
      return JSON.stringify({
        errors: r.errors.length,
        colors: r.design ? r.design.themeColors : 'MISSING',
        themeId: r.design ? r.design.themeId : null,
        非法类型_错误数: bad.errors.length,
        非法类型_colors: bad.design ? bad.design.themeColors : 'MISSING',
      });
    })()`);
    const C4 = JSON.parse(c4);
    console.log('    · ' + c4);
    eq(C4.errors, 0, '老文件（无 themeColors）解析 0 错误');
    eq(C4.colors, null, 'themeColors 是 null（不是 undefined）');
    eq(C4.themeId, 'ice', '主题名照常读到');
    eq(C4.非法类型_错误数, 0, 'themeColors 是字符串时**不报错**（当没有）');
    eq(C4.非法类型_colors, null, '非法类型被当成 null');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
