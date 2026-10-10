// 验证 Batch B：控件树同层顺序拖拽 + 状态阈值入口
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9267;
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
    `--user-data-dir=${os.tmpdir()}\\edge-b`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
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

    // ---------- 1) 同层重排的逻辑 ----------
    console.log('\n=== 1. 同层重排（reorderSibling）===');
    const reorder = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const mk = (name) => { const n = window.createNode(window.NODE_TEXT, { name:name, text:name, x:0,y:0,w:50,h:30 }); return n; };
      const a = mk('A'), b = mk('B'), c = mk('C');
      S.design.nodes = [a, b, c];
      window.normalizeZ(S.design.nodes);
      const out = {};
      out.初始 = S.design.nodes.map(n => n.name).join('');
      out.初始z = S.design.nodes.map(n => n.z).join(',');

      // C 插到 A 之前 → C A B
      out.r1 = window.reorderSibling(S.design.nodes, c.id, a.id, false);
      out.后1 = S.design.nodes.map(n => n.name).join('');

      // A 插到 B 之后 → C B A
      out.r2 = window.reorderSibling(S.design.nodes, a.id, b.id, true);
      out.后2 = S.design.nodes.map(n => n.name).join('');

      // 拖到自己身上 → 失败
      out.r3 = window.reorderSibling(S.design.nodes, a.id, a.id, false);

      // 同层判定
      out.同层 = window.canReorderSameLevel(S.design.nodes, a.id, b.id);
      // 跨层：放进一个分组里，就不同层了
      const g = window.createNode(window.NODE_GROUP, { name:'G', x:0,y:0,w:200,h:200 });
      g.children = [a];
      S.design.nodes = [g, b, c];
      out.跨层 = window.canReorderSameLevel(S.design.nodes, a.id, b.id);
      out.跨层重排 = window.reorderSibling(S.design.nodes, a.id, b.id, false);
      // 同层（都在 G 里）
      const a2 = mk('X'), b2 = mk('Y');
      g.children = [a2, b2];
      out.组内同层 = window.canReorderSameLevel(S.design.nodes, a2.id, b2.id);
      out.组内重排 = window.reorderSibling(S.design.nodes, b2.id, a2.id, false);
      out.组内顺序 = g.children.map(n => n.name).join('');
      return JSON.stringify(out);
    })()`);
    const RO = JSON.parse(reorder);
    console.log('    · ' + reorder);
    eq(RO.初始, 'ABC', '初始顺序 ABC');
    ok(RO.r1, 'C 插到 A 之前 → 成功');
    eq(RO.后1, 'CAB', '顺序变成 CAB');
    ok(RO.r2, 'A 插到 B 之后 → 成功');
    eq(RO.后2, 'CBA', '顺序变成 CBA');
    eq(RO.r3, false, '拖到自己身上 → 失败（不做无意义操作）');
    eq(RO.同层, true, '根节点之间算同层');
    eq(RO.跨层, false, '分组内外不算同层');
    eq(RO.跨层重排, false, '跨层重排被拒绝（那是 reparent 的职责）');
    eq(RO.组内同层, true, '同一个分组内算同层');
    eq(RO.组内顺序, 'YX', '组内也能重排');

    // ---------- 2) z 归一化 ----------
    console.log('\n=== 2. z 归一化（重排后画布层级要跟着动）===');
    const norm = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const mk = (name, z) => { const n = window.createNode(window.NODE_TEXT, { name:name, text:name, x:0,y:0,w:50,h:30 }); n.z = z; return n; };
      const a = mk('A', 5), b = mk('B', 5), c = mk('C', 99);
      const g = window.createNode(window.NODE_GROUP, { name:'G', x:0,y:0,w:200,h:200 });
      g.children = [mk('X', 7), mk('Y', 7)];
      S.design.nodes = [a, b, g, c];
      window.normalizeZ(S.design.nodes);
      return JSON.stringify({
        根: S.design.nodes.map(n => n.name + ':' + n.z).join(' '),
        子: g.children.map(n => n.name + ':' + n.z).join(' '),
      });
    })()`);
    const NM = JSON.parse(norm);
    console.log('    · ' + norm);
    eq(NM.根, 'A:0 B:1 G:2 C:3', '根层 z 归一化成 0..n-1');
    eq(NM.子, 'X:0 Y:1', '子层也递归归一化');

    // ---------- 3) 状态阈值 ----------
    console.log('\n=== 3. 状态阈值入口 ===');
    const thr = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.design.nodes = [];
      const n = window.createNode(window.NODE_IMAGE, { name:'灯', x:0,y:0,w:60,h:60 });
      n.states = { normal:{assetId:'',alpha:255,blink:false,blinkMs:200},
                   warn:{assetId:'',alpha:255,blink:false,blinkMs:200},
                   critical:{assetId:'',alpha:255,blink:true,blinkMs:200} };
      n.statePid = 'std_05';           // 冷却液温度
      S.design.nodes.push(n);
      S.selection = [n.id];
      window.onSelectionChanged();
      const out = {};
      out.默认warn = n.stateWarn;
      out.默认critical = n.stateCritical;
      // 阈值行在界面上吗
      out.有警告阈值框 = Array.from(document.querySelectorAll('#props .prow > label'))
        .some(e => e.textContent.indexOf('警告阈值') >= 0);
      out.有严重阈值框 = Array.from(document.querySelectorAll('#props .prow > label'))
        .some(e => e.textContent.indexOf('严重阈值') >= 0);
      // 设阈值
      window.setStateThreshold('stateWarn', '95');
      window.setStateThreshold('stateCritical', '110');
      out.设后warn = n.stateWarn;
      out.设后critical = n.stateCritical;
      // 清掉 → 回到 null（跟随 PID 库）
      window.setStateThreshold('stateWarn', '');
      out.清后warn = n.stateWarn;
      // 非数字 → null
      window.setStateThreshold('stateWarn', 'abc');
      out.非数字warn = n.stateWarn;
      // 序列化
      window.setStateThreshold('stateWarn', '95');
      const j = JSON.parse(window.toV2Json(S.design));
      const img = j.nodes.find(x => x.type === 'image');
      out.文件里有warn = img.stateWarn;
      out.文件里有critical = img.stateCritical;
      // 没设的字段不该写出
      window.setStateThreshold('stateCritical', '');
      const j2 = JSON.parse(window.toV2Json(S.design));
      const img2 = j2.nodes.find(x => x.type === 'image');
      out.清掉后不写出 = !('stateCritical' in img2);
      return JSON.stringify(out);
    })()`);
    const TH = JSON.parse(thr);
    console.log('    · ' + thr);
    eq(TH.默认warn, null, '默认阈值是 null（跟随 PID 库）');
    ok(TH.有警告阈值框, '界面上有「警告阈值」输入框');
    ok(TH.有严重阈值框, '界面上有「严重阈值」输入框');
    eq(TH.设后warn, 95, '设阈值生效');
    eq(TH.设后critical, 110, '严重阈值生效');
    eq(TH.清后warn, null, '清空 → 回到 null（跟随 PID 库）');
    eq(TH.非数字warn, null, '非数字 → 当没设（而不是 NaN）');
    eq(TH.文件里有warn, 95, '阈值写进设计文件');
    ok(TH.清掉后不写出, '没设的字段不写进文件（避免每个灯塞一坨默认值）');

    // ---------- 4) 阈值真的影响状态判定 ----------
    console.log('\n=== 4. 阈值影响状态判定 ===');
    const judge = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.flatten(S.design.nodes).find(x => x.type === 'image');
      const out = {};
      // 显式阈值：warn 95 / critical 110
      n.stateWarn = 95; n.stateCritical = 110;
      const at = v => { S.previewValues = {}; S.previewValues[n.statePid] = v; return window.resolveStateName(n); };
      out.v80 = at(80); out.v96 = at(96); out.v115 = at(115);
      // 回到 PID 库推断（冷却液温度库里的 warnHigh）
      n.stateWarn = null; n.stateCritical = null;
      out.库里warn = (window.BUILTIN_PIDS[n.statePid] || {}).warnHigh;
      out.库v80 = at(80); out.库v96 = at(96);
      return JSON.stringify(out);
    })()`);
    const JU = JSON.parse(judge);
    console.log('    · ' + judge);
    eq(JU.v80, 'normal', '显式阈值下 80 → normal');
    eq(JU.v96, 'warn', '显式阈值下 96 → warn（越过 95）');
    eq(JU.v115, 'critical', '显式阈值下 115 → critical（越过 110）');
    ok(JU.库里warn !== null && JU.库里warn !== undefined, 'PID 库里有推断阈值：' + JU.库里warn);
    eq(JU.库v80, 'normal', '跟随库时 80 → normal');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
