/* ==========================================================================
   verify-lamp-state.js —— 指示灯状态接线 + 闪烁频率红线（v1.20.16）

   ## 为什么需要这个套件

   这是仓库里**最贵的一条 bug** 的守卫：

   19 个指示灯里有 16 个（`lamp_brake` / `lamp_pad` / `lamp_tpms` / ...）
   在 `presets.js` 里写的是 `n.pid = ...` / `n.rawPid = ...`，**不是 `statePid`**。
   而 App 侧 `NodeTreeRenderer.resolveState()` **只读 `statePid`**，
   空就直接 `return STATE_NORMAL`；`model.js` 的 `nodeToJson` 对 `NODE_IMAGE`
   **只序列化 `statePid`**，`pid`/`rawPid` 连文件都进不去。

   净结果：用户拖一个「胎压灯」出来，它**永远显示暗的 `lamp-off.png`**。
   控件能拖、能摆、能存、能导出、构建守卫不报 —— **用户会以为车没问题**。

   ## 断言是「全库」而不是「那 16 个」

   任务书明确要求：写成能跑全库的断言（实例化**全部**控件后检查），
   而不是只查报告点名的 16 个 —— 否则下次新增控件漏了 `statePid`，
   这个套件照样绿。

   跑法：node tools/theme-studio/tests/verify-lamp-state.js
   ========================================================================== */
"use strict";
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码（换机器/换目录会报"找不到文件"）
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const KOTLIN_DESIGN_NODE = path.join(
  __dirname, '..', '..', '..', 'app', 'src', 'main', 'java', 'com', 'icar', 'obd', 'data', 'DesignNode.kt');
const PORT = 9264;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 等页面**真的就绪**（判据三条，与 verify-pid.js 一致） */
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
      const timer = setTimeout(() => {
        if (this.w.has(id)) { this.w.delete(id); rej(new Error('CDP 超时（' + LIMIT + 'ms）: ' + m)); }
      }, LIMIT);
      this.w.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      try { this.ws.send(JSON.stringify({ id, method: m, params: p })); }
      catch (e) { clearTimeout(timer); this.w.delete(id); rej(e); }
    });
  }
  async eval(e) {
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
    `--user-data-dir=${os.tmpdir()}\\edge-lampstate`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 【核心】全库断言：states 非空 ⇒ statePid 非空 ----------
    console.log('\n=== 1. 全库：states 非空 ⇒ statePid 必须非空 ===');
    const scan = await cdp.eval(`(() => {
      const bad = [], good = [];
      let total = 0, withStates = 0, makeFail = [];
      window.BUILTIN_CONTROLS.forEach(function (c) {
        total++;
        let n;
        try { n = c.make(); } catch (e) { makeFail.push(c.key + ': ' + e.message); return; }
        if (!n.states) return;
        withStates++;
        if (n.statePid) good.push(c.key + ' -> ' + n.statePid);
        else bad.push(c.key);
      });
      return JSON.stringify({ total: total, withStates: withStates, good: good, bad: bad, makeFail: makeFail });
    })()`);
    const SC = JSON.parse(scan);
    ok(SC.makeFail.length === 0, `全部 ${SC.total} 个控件都能 make()（失败 ${SC.makeFail.length} 个）` +
      (SC.makeFail.length ? '：' + SC.makeFail.slice(0, 5).join('; ') : ''));
    console.log(`    · 控件总数 ${SC.total} · states 非空 ${SC.withStates} · statePid 有值 ${SC.good.length} · 空 ${SC.bad.length}`);
    eq(SC.withStates, 19, 'states 非空的控件 = 19（指示灯）');
    // ⚠️ **这条就是本套件的存在理由**。修复前是 3。
    eq(SC.good.length, SC.withStates, '**每一个** states 非空的控件都有 statePid（修复前 3/19）');
    eq(SC.bad.length, 0, '没有 statePid 为空的控件' +
      (SC.bad.length ? '：' + SC.bad.join(', ') : ''));
    SC.good.forEach(g => console.log('      · ' + g));

    // ---------- 2) 具体的「胎压灯」—— 任务书点名的那个 ----------
    console.log('\n=== 2. 胎压灯（lamp_tpms）：接线正确 ===');
    const tpms = await cdp.eval(`(() => {
      const c = window.BUILTIN_CONTROLS.find(x => x.key === 'lamp_tpms');
      if (!c) return JSON.stringify({ found: false });
      const n = c.make();
      const coolant = window.BUILTIN_CONTROLS.find(x => x.key === 'lamp_coolant').make();
      return JSON.stringify({
        found: true, name: n.name, type: n.type,
        pid: n.pid, rawPid: n.rawPid,
        statePid: n.statePid, rawStatePid: n.rawStatePid,
        hasStates: !!n.states,
        stateNames: n.states ? Object.keys(n.states) : [],
        critAsset: n.states && n.states.critical ? n.states.critical.assetId : null,
        // 对照组：PID **在库里**的灯要解析成真实 id（证明 resolvePid 这条路径是通的）
        coolantStatePid: coolant.statePid,
        // obd.tpms 目前**不在** PID 库里（等 P9 上车逆向）→ 保留语义别名
        tpmsInPidLib: !!window.BUILTIN_PIDS[n.statePid],
      });
    })()`);
    const TP = JSON.parse(tpms);
    console.log('    · ' + tpms);
    ok(TP.found, '控件库里有 lamp_tpms');
    eq(TP.statePid, 'obd.tpms', 'statePid 有值（obd.tpms 还不在 PID 库里，保留语义别名）');
    eq(TP.rawStatePid, 'obd.tpms', 'rawStatePid 保留语义别名');
    eq(TP.coolantStatePid, 'std_05', '对照组：PID 在库里的灯解析成真实 id（obd.coolant → std_05）');
    eq(TP.pid, undefined, '**不再**写 pid（旧写法已清除）');
    eq(TP.rawPid, undefined, '**不再**写 rawPid（旧写法已清除）');
    ok(TP.hasStates && TP.stateNames.length === 3, '三个状态都在（normal/warn/critical）');
    ok(!!TP.critAsset, '严重态有图（crit 素材）');
    ok(!TP.tpmsInPidLib, 'obd.tpms 确实还不在 PID 库里 —— 这是 guard-pid-probe 的「等 P9」待办，不是本 bug');

    // ---------- 3) 序列化：statePid 真的进得了设计文件 ----------
    console.log('\n=== 3. 序列化：statePid 写进设计文件（旧写法进不去）===');
    const ser = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const c = window.BUILTIN_CONTROLS.find(x => x.key === 'lamp_tpms');
      const n = window.instantiateControl(c.make(), { x: 0, y: 0 });
      S.design.nodes = [n];
      const j = JSON.parse(window.toV2Json(S.design));
      const img = j.nodes[0];
      return JSON.stringify({
        statePid: img.statePid,
        hasPid: ('pid' in img),
        hasRawPid: ('rawPid' in img),
        hasStates: !!img.states,
        states: img.states ? Object.keys(img.states) : [],
      });
    })()`);
    const SE = JSON.parse(ser);
    console.log('    · ' + ser);
    eq(SE.statePid, 'obd.tpms', '文件里有 statePid（语义别名 obd.tpms，App 侧 resolvePid 认）');
    ok(!SE.hasPid, '文件里没有 pid（旧写法被 model.js 丢掉 —— 所以那时等于没接）');
    ok(!SE.hasRawPid, 'rawPid 是内部字段，不写进文件');
    ok(SE.hasStates && SE.states.length === 3, '三个状态都写进文件');

    // ---------- 4) 往返：写出去再读回来，接线还在 ----------
    console.log('\n=== 4. 往返：导出再导入，statePid 不丢 ===');
    const rt = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const txt = window.toV2Json(S.design);
      const r = window.parseDesign(txt);
      const n = r.design ? r.design.nodes[0] : null;
      return JSON.stringify({
        errors: r.errors.length,
        statePid: n ? n.statePid : null,
        rawStatePid: n ? n.rawStatePid : null,
        states: n && n.states ? Object.keys(n.states).length : 0,
      });
    })()`);
    const RT = JSON.parse(rt);
    console.log('    · ' + rt);
    eq(RT.errors, 0, '往返 0 错误');
    eq(RT.statePid, 'obd.tpms', '读回来的 statePid 还在（这条链就是"灯会不会亮"的全部依据）');
    eq(RT.rawStatePid, 'obd.tpms', '读回来保留了语义别名');
    eq(RT.states, 3, '三个状态都读回来');

    // ---------- 5) 闪烁频率：全库不得低于 MIN_BLINK_MS ----------
    console.log('\n=== 5. 闪烁频率红线：WCAG 2.3.1「每秒不超过三次」===');
    const bl = await cdp.eval(`(() => {
      const min = window.MIN_BLINK_MS;
      const bad = [], all = [];
      window.BUILTIN_CONTROLS.forEach(function (c) {
        const n = c.make();
        if (!n.states) return;
        Object.keys(n.states).forEach(function (k) {
          const st = n.states[k];
          all.push(c.key + '.' + k + '=' + st.blinkMs + (st.blink ? '(闪)' : ''));
          if (st.blink && st.blinkMs < min) bad.push(c.key + '.' + k + '=' + st.blinkMs);
        });
      });
      // 再扫全设计文件路径：任何 blink 状态的周期
      return JSON.stringify({ min: min, bad: bad, count: all.length, sample: all.slice(0, 8) });
    })()`);
    const BL = JSON.parse(bl);
    console.log('    · MIN_BLINK_MS=' + BL.min + 'ms（' + (1000 / BL.min).toFixed(2) + ' Hz）· 检查了 ' + BL.count + ' 个状态');
    BL.sample.forEach(s => console.log('      · ' + s));
    ok(BL.min >= 400, `工具侧 MIN_BLINK_MS ≥ 400ms（实际 ${BL.min}）`);
    ok(1000 / BL.min <= 3, `换算 ≤ 3 Hz（实际 ${(1000 / BL.min).toFixed(2)} Hz）`);
    eq(BL.bad.length, 0, '全库没有低于下限的**闪烁**周期' + (BL.bad.length ? '：' + BL.bad.join(', ') : ''));

    // ---------- 6) 下限真的拦得住（不是摆设）----------
    console.log('\n=== 6. 下限真的拦得住：写 100ms 进去要变成 400ms ===');
    const clamp = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.instantiateControl(window.BUILTIN_CONTROLS.find(x => x.key === 'lamp_tpms').make(), { x: 0, y: 0 });
      S.design.nodes = [n];
      S.selection = [n.id];
      window.onSelectionChanged();
      const out = {};
      window.setState('critical', 'blinkMs', '100');
      out.设100 = n.states.critical.blinkMs;
      window.setState('critical', 'blinkMs', '50');
      out.设50 = n.states.critical.blinkMs;
      window.setState('critical', 'blinkMs', '900');
      out.设900 = n.states.critical.blinkMs;
      window.setState('critical', 'blinkMs', 'abc');
      out.设abc = n.states.critical.blinkMs;
      return JSON.stringify(out);
    })()`);
    const CL = JSON.parse(clamp);
    console.log('    · ' + clamp);
    eq(CL.设100, 400, '100ms → 被抬到 400ms（不是照单全收）');
    eq(CL.设50, 400, '50ms → 被抬到 400ms');
    eq(CL.设900, 900, '900ms 是合规的，不该被动（只抬下限，不改上限）');
    eq(CL.设abc, 400, '非数字 → 用下限兜底（不是 NaN）');

    // ---------- 7) 解析路径也拦（文件里写了小值）----------
    console.log('\n=== 7. 解析路径：文件里写 120ms 也要抬到 400ms ===');
    const parseClamp = await cdp.eval(`(() => {
      const r = window.parseDesign(JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 },
        nodes: [{ id: 'x', type: 'image', name: '灯', x: 0, y: 0, w: 20, h: 20,
          statePid: 'obd.tpms',
          states: { normal: { assetId: '', alpha: 255, blink: false, blinkMs: 120 },
                    critical: { assetId: '', alpha: 255, blink: true, blinkMs: 120 } } }],
      }));
      const n = r.design ? r.design.nodes[0] : null;
      return JSON.stringify({ errors: r.errors.length, normal: n.states.normal.blinkMs, critical: n.states.critical.blinkMs });
    })()`);
    const PC = JSON.parse(parseClamp);
    console.log('    · ' + parseClamp);
    eq(PC.errors, 0, '解析 0 错误（抬下限不是错误，是静默纠正）');
    eq(PC.critical, 400, '文件里 120ms 的**闪烁**周期被抬到 400ms');
    eq(PC.normal, 400, '不闪的状态也一并抬（避免"勾一下闪烁"就掉到红线以下）');

    // ---------- 8) 跨语言：工具侧与 App 侧的下限必须同源 ----------
    console.log('\n=== 8. 跨语言：window.MIN_BLINK_MS == NodeState.MIN_BLINK_MS ===');
    const kotlinSrc = fs.readFileSync(KOTLIN_DESIGN_NODE, 'utf8');
    const m = /const val MIN_BLINK_MS\s*=\s*(\d+)/.exec(kotlinSrc);
    const kMin = m ? Number(m[1]) : null;
    console.log(`    · 工具 window.MIN_BLINK_MS = ${BL.min} · App DesignNode.kt MIN_BLINK_MS = ${kMin}`);
    ok(kMin !== null, '从 DesignNode.kt 解析到 MIN_BLINK_MS');
    eq(BL.min, kMin, '工具侧与 App 侧的下限**逐字一致**');
    ok(kMin !== null && kMin >= 400, `App 侧下限 ≥ 400ms（实际 ${kMin}）`);

    // 工具侧不该再有 60ms 的老下限残留
    const studioJs = ['js/validate.js', 'js/app.js', 'js/editor.js', 'js/panels.js']
      .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    ok(!/Math\.max\(60,/.test(studioJs), '工具侧没有 Math.max(60, ...) 残留（那是 16.7Hz）');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
