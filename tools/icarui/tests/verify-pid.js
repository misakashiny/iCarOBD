// 验证：PID 表示统一 + JSON 编辑不再被静默覆盖
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9250;
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
    `--user-data-dir=${os.tmpdir()}\\edge-pidfix`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
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

    // ---------- 1) PID 表示统一 ----------
    console.log('\n=== 1. PID 的三种形态（编辑器建 vs 文件读）===');
    const rep = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const probe = n => ({
        pid: n.pid, rawPid: n.rawPid,
        found: !!window.BUILTIN_PIDS[n.pid],
        name: (window.BUILTIN_PIDS[n.pid] || {}).name || null,
        unit: (window.BUILTIN_PIDS[n.pid] || {}).unit || null,
        label: window.BUILTIN_PIDS[n.pid] ? window.BUILTIN_PIDS[n.pid].name : (n.rawPid || n.pid),
      });
      const preset = probe(window.flatten(S.design.nodes).find(x => x.type === 'gauge'));
      const parsed = window.parseDesign(JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 },
        nodes: [{ id: 'x', type: 'gauge', name: '转速', pid: 'obd.rpm', min: 0, max: 8000, x: 0, y: 0, w: 180, h: 180 }],
      }));
      const file = probe(parsed.design.nodes[0]);
      // 再建一个：直接用 createNode
      const made = probe(window.createNode(window.NODE_GAUGE, { pid: 'obd.coolant' }));
      return JSON.stringify({ preset: preset, file: file, made: made });
    })()`);
    const REP = JSON.parse(rep);
    console.log('    · 预设建: ' + JSON.stringify(REP.preset));
    console.log('    · 文件读: ' + JSON.stringify(REP.file));
    console.log('    · createNode 建: ' + JSON.stringify(REP.made));
    eq(REP.preset.pid, 'std_0C', '预设建的节点 pid 是解析后的 id（std_0C）');
    eq(REP.preset.rawPid, 'obd.rpm', '预设建的节点保留了原样写法（rawPid）');
    eq(REP.preset.pid, REP.file.pid, '编辑器建的和文件读的 **pid 一致**');
    eq(REP.preset.rawPid, REP.file.rawPid, '两者的 rawPid 也一致');
    ok(REP.preset.found, '预设建的节点能查到内置库（画布能显示中文名与单位）');
    eq(REP.preset.name, '发动机转速', '预设建的节点显示中文名');
    eq(REP.preset.unit, 'rpm', '预设建的节点有单位');
    eq(REP.made.pid, 'std_05', 'createNode 也解析别名（obd.coolant → std_05）');
    eq(REP.made.rawPid, 'obd.coolant', 'createNode 保留 rawPid');

    // 序列化写回别名
    const ser = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const txt = window.toV2Json(S.design);
      const j = JSON.parse(txt);
      const g = j.nodes.find(n => n.type === 'gauge');
      return JSON.stringify({ pidInFile: g.pid, hasRawPid: 'rawPid' in g });
    })()`);
    const SER = JSON.parse(ser);
    console.log('    · 写回文件: ' + ser);
    eq(SER.pidInFile, 'obd.rpm', '序列化写回**语义别名**（不是 std_0C）');
    ok(!SER.hasRawPid, 'rawPid 是内部字段，不写进文件');

    // ---------- 2) JSON 删字段不再被静默覆盖 ----------
    console.log('\n=== 2. JSON 里删字段后，编辑不该被覆盖 ===');
    const dirty = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const txt = document.getElementById('jsonArea').value;
      const obj = JSON.parse(txt);
      delete obj.nodes[0].pid;
      document.getElementById('jsonArea').value = JSON.stringify(obj, null, 2);
      window.jsonEdited();
      return '已删掉 nodes[0].pid';
    })()`);
    console.log('    · ' + dirty);
    await sleep(600);
    const afterDelete = await cdp.eval(`(() => ({
      msgs: Array.from(document.querySelectorAll('#msgs .msg')).map(e => e.className.replace('msg ','')),
      canvasNodes: window.flatten(window.CanvasState.design.nodes).length,
      jsonHasPid: 'pid' in JSON.parse(document.getElementById('jsonArea').value).nodes[0],
      areaDirty: document.getElementById('jsonArea').classList.contains('dirty'),
      barShown: !!document.getElementById('jsonDirtyBar') && document.getElementById('jsonDirtyBar').style.display !== 'none',
    }))()`);
    console.log('    · ' + JSON.stringify(afterDelete));
    ok(afterDelete.msgs.indexOf('err') >= 0, '校验结果里有硬错误');
    eq(afterDelete.canvasNodes, 5, '画布**保留**上一次成功的设计（没有变空）');
    ok(!afterDelete.jsonHasPid, '我的删除**还在**（文本域没被冲掉）');
    ok(afterDelete.areaDirty, '文本域被标红（.dirty）');
    ok(afterDelete.barShown, '顶部有醒目的错误提示条');

    // 关键：动一下画布，看文本域会不会被覆盖
    console.log('\n=== 2b. 关键：此时在画布上改一下 ===');
    const afterTouch = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      S.selection = [n.id];
      window.onSelectionChanged();
      window.setNodeNum('x', 77);      // 走 commit → 会调 syncJson
      const j = JSON.parse(document.getElementById('jsonArea').value);
      return JSON.stringify({
        jsonHasPid: 'pid' in j.nodes[0],
        nodeX: n.x,
        areaDirty: document.getElementById('jsonArea').classList.contains('dirty'),
      });
    })()`);
    const AT = JSON.parse(afterTouch);
    console.log('    · ' + afterTouch);
    ok(!AT.jsonHasPid, '画布改动后，我的删除**仍然还在**（这是修掉的那个 bug）');
    eq(AT.nodeX, 77, '画布改动本身生效了（改的是当前设计）');

    // ---------- 3) "放弃改动"出口 ----------
    console.log('\n=== 3. 放弃 JSON 改动，回到画布状态 ===');
    const discard = await cdp.eval(`(() => {
      window.discardJsonEdit();
      const j = JSON.parse(document.getElementById('jsonArea').value);
      return JSON.stringify({
        jsonHasPid: 'pid' in j.nodes[0],
        pid: j.nodes[0].pid,
        areaDirty: document.getElementById('jsonArea').classList.contains('dirty'),
        barShown: document.getElementById('jsonDirtyBar').style.display !== 'none',
        msgs: Array.from(document.querySelectorAll('#msgs .msg')).map(e => e.className.replace('msg ','')),
      });
    })()`);
    const DI = JSON.parse(discard);
    console.log('    · ' + discard);
    ok(DI.jsonHasPid, '文本域回到画布当前状态（pid 回来了）');
    ok(!DI.areaDirty && !DI.barShown, '红色标记与提示条都消失了');
    ok(DI.msgs.indexOf('err') < 0, '校验恢复通过');

    // ---------- 4) 修好错误后自动生效 ----------
    console.log('\n=== 4. 把错误修好，应自动生效 ===');
    const fixed = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const obj = JSON.parse(document.getElementById('jsonArea').value);
      obj.meta = { name: '改过的名字' };
      document.getElementById('jsonArea').value = JSON.stringify(obj, null, 2);
      window.jsonEdited();
      return '已改成合法 JSON';
    })()`);
    await sleep(600);
    const afterFix = await cdp.eval(`(() => ({
      name: window.CanvasState.design.name,
      areaDirty: document.getElementById('jsonArea').classList.contains('dirty'),
      barShown: document.getElementById('jsonDirtyBar').style.display !== 'none',
    }))()`);
    console.log('    · ' + JSON.stringify(afterFix));
    eq(afterFix.name, '改过的名字', '合法 JSON 自动生效');
    ok(!afterFix.areaDirty && !afterFix.barShown, '红色标记自动清除');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
