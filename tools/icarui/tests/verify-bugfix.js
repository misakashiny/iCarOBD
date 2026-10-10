// 验证 4 个 bug 的修复：打组缩放 / 紫色虚线 / PID 开关 / 图层上移下移
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9254;
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
    `--user-data-dir=${os.tmpdir()}\\edge-bugfix`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
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

    // ---------- 1) 图层上移 / 下移 ----------
    console.log('\n=== 1. 图层上移 / 下移（原来点了没反应）===');
    const layer = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const zs0 = S.design.nodes.map(n => n.z);
      const order0 = window.sortByZ(S.design.nodes).map(x => x.name);
      // 选中间那个上移
      const mid = window.sortByZ(S.design.nodes)[2];
      S.selection = [mid.id];
      window.onSelectionChanged();
      window.layerCmd('up');
      const order1 = window.sortByZ(S.design.nodes).map(x => x.name);
      window.layerCmd('up');
      const order2 = window.sortByZ(S.design.nodes).map(x => x.name);
      window.layerCmd('down');
      const order3 = window.sortByZ(S.design.nodes).map(x => x.name);
      return JSON.stringify({
        z初值: zs0, 顺序0: order0, 上移1: order1, 上移2: order2, 下移: order3,
        上移生效: order0.join() !== order1.join(),
        下移生效: order2.join() !== order3.join(),
      });
    })()`);
    const L = JSON.parse(layer);
    console.log('    · z 初值: ' + L.z初值.join(','));
    console.log('    · ' + L.顺序0.join(' > '));
    console.log('    · 上移 → ' + L.上移1.join(' > '));
    console.log('    · 上移 → ' + L.上移2.join(' > '));
    console.log('    · 下移 → ' + L.下移.join(' > '));
    ok(L.上移生效, '上移生效（原来因为 z 全相同而无效）');
    ok(L.下移生效, '下移生效');
    eq(L.上移1[3], L.顺序0[2], '上移一次：原第 3 个跑到了第 4 位');

    // ---------- 2) 打组后缩放 ----------
    console.log('\n=== 2. 打组后四角缩放，子控件跟着变 ===');
    const grpScale = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const all = window.flatten(S.design.nodes).filter(x => x.type === 'gauge');
      S.selection = [all[0].id, all[1].id];
      window.groupSelected();
      const g = S.design.nodes.find(x => x.type === 'group');
      if (!g) return JSON.stringify({ err: '打组失败' });
      const kid0 = g.children.map(c => Math.round(c.w) + 'x' + Math.round(c.h));
      const dev0 = g.children.map(c => { const b = window.deviceBounds(c.id); return Math.round(b.w) + 'x' + Math.round(b.h); });
      const gw0 = g.w, gh0 = g.h;
      S.selection = [g.id];
      window.onSelectionChanged();
      const cv = document.getElementById('cv');
      const rect = cv.getBoundingClientRect();
      const dpr = cv.width / rect.width;
      const H = window.handlePositionsFor(g.id);
      const corner = window.matApply(H.real, g.w, g.h);
      const toC = p => ({ x: rect.x + p.x/dpr, y: rect.y + p.y/dpr });
      const a = toC(corner), b = toC({ x: corner.x + 80, y: corner.y + 40 });
      cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, clientX:a.x, clientY:a.y, pointerId:1, isPrimary:true }));
      cv.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, cancelable:true, clientX:b.x, clientY:b.y, pointerId:1, isPrimary:true }));
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles:true, pointerId:1, isPrimary:true }));
      const kid1 = g.children.map(c => Math.round(c.w) + 'x' + Math.round(c.h));
      const dev1 = g.children.map(c => { const b = window.deviceBounds(c.id); return Math.round(b.w) + 'x' + Math.round(b.h); });
      // 宽高比是否保持（每个子控件自身）
      const ar0 = g.children.map(c => Math.round(c.w / c.h * 100) / 100);
      return JSON.stringify({
        组尺寸: Math.round(gw0) + 'x' + Math.round(gh0) + ' → ' + Math.round(g.w) + 'x' + Math.round(g.h),
        子尺寸前: kid0, 子尺寸后: kid1,
        子设备前: dev0, 子设备后: dev1,
        变了: kid0.join() !== kid1.join(),
        设备变了: dev0.join() !== dev1.join(),
      });
    })()`);
    const GS = JSON.parse(grpScale);
    console.log('    · 组: ' + GS.组尺寸);
    console.log('    · 子控件 ' + GS.子尺寸前.join(' / ') + '  →  ' + GS.子尺寸后.join(' / '));
    console.log('    · 设备尺寸 ' + GS.子设备前.join(' / ') + '  →  ' + GS.子设备后.join(' / '));
    ok(GS.变了, '子控件尺寸跟着组变了（原来完全不动）');
    ok(GS.设备变了, '子控件的**设备**尺寸也跟着变了（画布上真的变大了）');

    // 缩放后取消组合，位置不该跳
    const afterScale = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const g = S.design.nodes.find(x => x.type === 'group');
      const kids = g.children.map(c => c.id);
      const before = kids.map(id => window.deviceBounds(id));
      S.selection = [g.id];
      window.ungroupSelected();
      const after = kids.map(id => window.deviceBounds(id));
      const drift = before.map((x,i) => ({
        dx: Math.abs(x.x - after[i].x), dy: Math.abs(x.y - after[i].y),
        dw: Math.abs(x.w - after[i].w), dh: Math.abs(x.h - after[i].h) }));
      return JSON.stringify({ drift: drift });
    })()`);
    const AS = JSON.parse(afterScale);
    console.log('    · 缩放后取消组合的漂移: ' + JSON.stringify(AS.drift));
    ok(AS.drift.every(d => d.dx < 1 && d.dy < 1 && d.dw < 1 && d.dh < 1),
      '缩放过的组取消组合后位置与尺寸都不跳');

    // ---------- 3) 紫色虚线已去掉 ----------
    console.log('\n=== 3. 分组不再画紫色虚线 ===');
    const noLine = await cdp.eval(`(() => {
      const S = window.CanvasState;
      // 造一个分组
      const all = window.flatten(S.design.nodes).filter(x => x.type === 'gauge');
      S.selection = [all[0].id, all[1].id];
      window.groupSelected();
      const g = S.design.nodes.find(x => x.type === 'group');
      if (!g) return JSON.stringify({ err: '打组失败' });
      S.selection = [];           // 取消选中，排除青色选择框的干扰
      window.onSelectionChanged();
      // 判定办法（最可靠）：把分组的子控件全隐藏，然后**对比"有分组"与"删掉分组"
      // 两种情况的画布指纹**。分组若不画任何东西，两者必然完全相同。
      const cv = document.getElementById('cv');
      const hash = () => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 397) h = (h * 31 + d[i]) % 2147483647;
        return h;
      };
      g.children.forEach(c => { c.visible = false; });
      window.draw();
      const hWith = hash();
      const gx = g.x, gy = g.y, gw = g.w, gh = g.h;
      // 临时把分组尺寸改成 0（等价于"不存在"），但不影响子控件（已隐藏）
      g.w = 0.0001; g.h = 0.0001;
      window.draw();
      const hWithout = hash();
      g.w = gw; g.h = gh;
      g.children.forEach(c => { c.visible = true; });
      window.draw();
      return JSON.stringify({ 有分组: hWith, 无分组: hWithout, 完全相同: hWith === hWithout });
    })()`);
    const NL = JSON.parse(noLine);
    console.log('    · ' + noLine);
    ok(NL.完全相同, '分组不画任何东西（有分组/无分组的画布指纹完全相同）—— 紫色虚线已去掉');

    // ---------- 4) PID 开关 ----------
    console.log('\n=== 4. PID 开关：显示别名、文案不歧义 ===');
    const pid = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const btn = document.getElementById('btnPid');
      const g = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      const t0 = btn.textContent.trim(), s0 = S.showPid, ti0 = btn.title;
      window.togglePidLabel();
      const t1 = btn.textContent.trim(), s1 = S.showPid, ti1 = btn.title;
      window.togglePidLabel();
      return JSON.stringify({
        初态: { 文案: t0, showPid: s0, title: ti0 },
        切换后: { 文案: t1, showPid: s1, title: ti1 },
        该节点pid: g.pid, 别名: window.ALIAS_OF[g.pid],
        画布会显示: window.pidLabelOf(g),
      }, null, 1);
    })()`);
    const P = JSON.parse(pid);
    console.log('    · 初态 ' + P.初态.文案 + '（showPid=' + P.初态.showPid + '）');
    console.log('    · 切换 ' + P.切换后.文案 + '（showPid=' + P.切换后.showPid + '）');
    console.log('    · 画布显示: ' + P.画布会显示 + '（pid=' + P.该节点pid + '，别名=' + P.别名 + '）');
    ok(/开|关/.test(P.初态.文案), '按钮文案是"开/关"状态，不再是"隐/显"（避免读成动作）');
    eq(P.初态.showPid, false, '默认关闭');
    eq(P.切换后.showPid, true, '点击后开启');
    eq(P.画布会显示, P.别名, '画布显示**别名**（obd.xxx）而不是解析后的 id');
    ok(/当前/.test(P.初态.title), 'title 写明"当前"状态：' + P.初态.title.slice(0, 30));

    // ---------- 坏快照不能让撤销静默失灵（v2.37.0）
  console.log('\n=== 撤销栈的坏数据 ===');
  //
  // 撤销栈会持久化到 localStorage，那里的内容可能被截断或写坏。
  // 原来 `restore()` 裸调 JSON.parse —— 一坏就抛，**撤销按钮静默失灵**：
  // 点了没反应、没有提示，只有 console 里一行红字。
  const bad = await cdp.eval(`(() => {
    const out = {};
    const S = window.CanvasState;
    const R = window.restoreSnapshot;
    out.钩子在 = typeof R === "function";

    // 1) 各种坏快照都应当返回 false 而不是抛异常
    const cases = ["不是 JSON", "null", "{}", '{"d":null}', '{"d":"不是对象"}', "", undefined, "[1,2]"];
    out.坏的没返回false = [];
    out.没一个抛 = true;
    cases.forEach(function (c) {
      try {
        const r = R(c);
        if (r !== false) out.坏的没返回false.push(String(c).slice(0, 14) + "→" + r);
      } catch (e) { out.没一个抛 = false; }
    });

    // 2) 好快照仍然要能恢复（别把功能一起挡掉了）
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "坏快照测试", x: 0, y: 0, w: 60, h: 20 }));
    }, "加一个");
    const grew = (S.design.nodes || []).some(function (n) { return n.name === "坏快照测试"; });
    const snap = JSON.stringify({ d: JSON.parse(JSON.stringify(S.design)), sel: [] });
    S.design.nodes = S.design.nodes.filter(function (n) { return n.name !== "坏快照测试"; });
    out.好快照能恢复 = (R(snap) === true);
    out.改动确实发生了 = grew;

    // 3) doUndo 喂坏数据也不能抛
    let threw = false;
    try { window.doUndo(); } catch (e) { threw = true; }
    out.撤销没抛 = !threw;
    out.设计还在 = !!S.design && Array.isArray(S.design.nodes);

    S.design.nodes = S.design.nodes.filter(function (n) { return n.name !== "坏快照测试"; });
    return JSON.stringify(out);
  })()`);
  const B = JSON.parse(bad);
  console.log('    · ' + bad);
  ok(B.钩子在, "测试钩子 window.restoreSnapshot 在");
  ok(B.没一个抛, "**8 种坏快照一个都没抛异常**（原来会抛，撤销按钮静默失灵）");
  ok(B.坏的没返回false.length === 0,
    "坏快照一律返回 false" + (B.坏的没返回false.length ? "（漏了：" + B.坏的没返回false.join("; ") + "）" : ""));
  ok(B.好快照能恢复, "**好快照仍然能恢复**（没把功能一起挡掉）");
  ok(B.改动确实发生了, "前置的改动确实生效了（不是空测）");
  ok(B.撤销没抛, "doUndo() 在坏数据下不抛");
  ok(B.设计还在, "设计没被坏数据弄坏");

  // ---------- 坏的条目应当在**加载时**就被丢掉（v2.37.0）
  //
  // 只在 restore 里挡住是不够的：坏的那条会一直躺在栈里，
  // **每次撤销到它都要再撞一次**。
  const loaded = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const KEY = "icar-studio-undo";
    const goodSnap = JSON.stringify({ d: { nodes: [], pages: [{ id: "p", name: "p", nodes: [] }], pageIndex: 0 }, sel: [] });
    // 三条里混两条坏的（一条不是 JSON、一条 state 不是字符串）
    const payload = {
      designName: S.design.name,
      stack: [
        { state: goodSnap, label: "好的一条" },
        { state: "坏掉的 JSON {", label: "坏的一条" },
        { state: { 不是字符串: true }, label: "类型错的" },
      ],
    };
    try { localStorage.setItem(KEY, JSON.stringify(payload)); } catch (e) { return JSON.stringify({ 跳过: "localStorage 不可用" }); }
    const r = window.loadUndoStack();
    const n = r && Array.isArray(r.stack) ? r.stack.length : -1;
    const onlyGood = !!(r && r.stack.length === 1 && r.stack[0].label === "好的一条");
    try { localStorage.removeItem(KEY); } catch (e) {}
    return JSON.stringify({ 剩下几条: n, 只剩好的: onlyGood });
  })()`);
  const UL = JSON.parse(loaded);
  console.log('    · ' + loaded);
  if (UL.跳过) {
    // ⚠️ 原来是 `ok(true, "localStorage 不可用，跳过（…）")` —— 环境缺失时**假装通过**
    // （v1.20.20 修）。那正是本项目最恨的"会骗人的绿"：套件报 ✅，
    // 而"坏数据在加载时被丢掉"这条**一个断言都没跑**。
    //
    // 这里的环境（headless Edge + 临时 profile）一定有 localStorage ——
    // 真不可用就是环境坏了，该红。跳过不等于通过。
    ok(false, "localStorage 不可用，无法验证撤销栈的坏数据清理（" + UL.跳过 + "）");
  } else {
    eq(UL.剩下几条, 1, "**加载时就把 2 条坏的丢掉了**（3 条只剩 1 条）");
    ok(UL.只剩好的, "剩下的确实是那条好的（不是随机留下一条）");
  }

  // ================================================================ 深嵌套不能爆栈（v2.83.0 Round 2）
  //
  // `parseNode` 是递归的。修复前：2 万层嵌套的 group 直接把调用栈打爆
  // （RangeError），异常冒到 jsonEdited 的 setTimeout 里没人接 ——
  // 用户粘了一份文件，画布不动、校验框不动、什么都没有。
  console.log('\n=== 深嵌套必须报**看得懂的错**，不能爆栈 ===');
  const deep = await cdp.eval(`(() => {
    const mk = (depth) => {
      let inner = { id:'leaf', type:'text', text:'x', x:0, y:0, w:10, h:10 };
      for (let i = 0; i < depth; i++) inner = { id:'g'+i, type:'group', x:0, y:0, w:10, h:10, children:[inner] };
      return JSON.stringify({ schema:'icar.ui/2', canvas:{unit:360}, meta:{name:'深'}, nodes:[inner] });
    };
    const out = {};
    // (a) 20000 层：必须**返回**错误，不能抛
    try {
      const r = window.parseDesign(mk(20000));
      out.爆栈 = false;
      out.design为null = r.design === null;
      out.有深度错误 = r.errors.some(e => e.indexOf('嵌套深度') >= 0);
      out.首条错误 = r.errors[0] || null;
    } catch (e) {
      out.爆栈 = true;
      out.异常 = String(e && e.message || e);
    }
    // (b) 合法深度（3 层）不能被误伤
    const okR = window.parseDesign(mk(3));
    out.合法深度通过 = okR.errors.length === 0 && !!okR.design;
    // (c) 上限本身是个正数且够宽松
    out.上限 = window.MAX_NODE_DEPTH;
    // (d) 走真实入口 jsonEdited 也不能抛
    try {
      document.getElementById('jsonArea').value = mk(20000);
      window.jsonEdited();
      out.入口不抛 = true;
    } catch (e) { out.入口不抛 = false; out.入口异常 = String(e && e.message || e); }
    return JSON.stringify(out);
  })()`);
  const DP = JSON.parse(deep);
  console.log('    · ' + deep);
  ok(!DP.爆栈, '2 万层嵌套**不抛异常**' + (DP.异常 ? '（实际抛了 ' + DP.异常 + '）' : ''));
  ok(DP.design为null, '被拒绝（design = null），不是悄悄接受一个坏设计');
  ok(DP.有深度错误, '错误文案里有「嵌套深度」—— 用户看得懂' + (DP.首条错误 ? '：' + DP.首条错误 : ''));
  ok(DP.合法深度通过, '3 层嵌套照常通过（上限不误伤真实设计）');
  ok(typeof DP.上限 === 'number' && DP.上限 >= 16, 'MAX_NODE_DEPTH = ' + DP.上限 + '（够宽松）');
  ok(DP.入口不抛, 'jsonEdited 这条真实入口也不抛（否则就是"粘了文件什么都没发生"）');
  await sleep(500);   // 让 jsonEdited 的防抖跑完

  // ================================================================ 校验消息有上限且**说出来**
  console.log('\n=== 海量警告不能把面板撑爆（且必须说明截断了）===');
  //
  // ⚠️ 警告的**发生器**换过一次（v1.20.20）。
  //
  // 原来靠"一块表挂 5000 个 parts"来造 >1000 条警告。v1.20.20 给 `parts`
  // 加了条数上限（`window.MAX_PARTS = 64`，与 App 侧成对）——
  // 5000 项现在是**一条硬错误**（文件被拒收），警告数是 0，
  // 于是这条用例测的东西（面板渲染上限 + 截断提示）**根本没跑到**。
  //
  // 换成"150 个节点、每个踩 8 个可警告的点"：同样是海量警告，
  // 但不依赖那个已经不成立的输入形态。**被测行为一个字没改。**
  const cap = await cdp.eval(`(() => {
    const nodes = [];
    for (let i = 0; i < 150; i++) {
      // 每个节点踩满：alpha 越界 / 6 个非数字字段 / pid 不在库 / 尺寸过小
      nodes.push({ id:'n'+i, type:'gauge', pid:'std_FF',
        alpha: 999, x:'a', y:'a', w:5, h:5, rotation:'a', scale:'a', z:'a' });
    }
    const txt = JSON.stringify({ schema:'icar.ui/2', canvas:{unit:360}, meta:{name:'x'}, nodes: nodes });
    document.getElementById('jsonArea').value = txt;
    const t0 = performance.now();
    const v = window.validateNow();
    const ms = performance.now() - t0;
    const box = document.getElementById('msgs');
    return JSON.stringify({
      警告数: v.warnings.length,
      渲染的msg行: box.querySelectorAll('.msg').length,
      截断提示: (box.querySelector('.msgMore') || {}).textContent || '',
      耗时ms: Math.round(ms),
    });
  })()`);
  const CP = JSON.parse(cap);
  console.log('    · ' + cap);
  ok(CP.警告数 > 1000, `确实产生了海量警告（${CP.警告数} 条）`);
  ok(CP.渲染的msg行 <= 200, `面板只渲染 ${CP.渲染的msg行} 行（≤200），不会撑爆`);
  ok(CP.截断提示.indexOf('还有') >= 0 && CP.截断提示.indexOf(String(CP.警告数)) >= 0,
    '**明说了还有多少条**（不是静默截断）：' + CP.截断提示);

  // ================================================================ JSON 文本 → 画布 必须可撤销（v2.83.0 Round 5）
  //
  // 原来 `jsonEdited` 是裸赋值 `S.design = r.design` —— **不进撤销栈**。
  // 后果：「打开」一份设计文件后按撤销，回到的**不是打开前**，而是撤销栈里的
  // **上一步**（实测：打开前 A{x:33}，打开 B，撤销后变成一个无关的旧状态，
  // 用户做的 A 直接丢）。这条钉住"文本 → 画布"是一个可撤销的步骤。
  console.log('\n=== JSON 文本同步到画布：必须能撤销回去 ===');
  const jsonUndo = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const A = window.createDesign({ name: 'A-我的工作' });
    A.nodes = [window.createNode(window.NODE_GAUGE, { name:'A1', pid:'obd.rpm', x:33, y:0, w:100, h:100 })];
    S.design = A; S.selection = [];
    window.refreshAll();
    window.commit(() => { A.nodes[0].x = 33; }, '在 A 上做的一步');
    const before = JSON.stringify({ name: S.design.name, x: S.design.nodes[0].x });
    // 「打开」内部走的就是这条路：把文本塞进文本域 → jsonEdited
    const B = window.createDesign({ name: 'B-别人给的' });
    B.nodes = [window.createNode(window.NODE_GAUGE, { name:'B1', pid:'obd.speed', x:5, y:5, w:50, h:50 })];
    document.getElementById('jsonArea').value = window.toV2Json(B);
    window.jsonEdited();
    return before;
  })()`);
  await sleep(700);   // 等 jsonEdited 的 350ms 防抖
  const afterOpen = await cdp.eval(`JSON.stringify({ name: window.CanvasState.design.name, x: window.CanvasState.design.nodes[0] ? window.CanvasState.design.nodes[0].x : null })`);
  await cdp.eval(`window.doUndo()`);
  const afterUndo = await cdp.eval(`JSON.stringify({ name: window.CanvasState.design.name, x: window.CanvasState.design.nodes[0] ? window.CanvasState.design.nodes[0].x : null })`);
  console.log('    · 打开前 ' + jsonUndo + ' → 打开后 ' + afterOpen + ' → 撤销后 ' + afterUndo);
  ok(JSON.parse(afterOpen).name === 'B-别人给的', '文本域里的设计真的生效了（画布换成了 B）');
  eq(afterUndo, jsonUndo, '**按一次撤销回到的是"打开前"**（不是撤销栈里的上一步）');

  // ================================================================ 界面文案里不许有 Markdown 星号（v2.83.0 Round 5）
  //
  // `DIFF_NOTES` 的文案按 Markdown 写（`**加粗**`），但落点是 `textContent` ——
  // 于是界面上**原样显示星号**。同类问题在 toast / alert / confirm / .hint 里
  // 一共有 25 处（实测）。这条按**落点类型**分别钉住：
  //   · innerHTML 的落点（.hint / DIFF_NOTES）→ 必须渲染成 <b>，不许留 `**`
  //   · textContent / 原生对话框的落点 → 直接不许出现 `**`
  console.log('\n=== 界面文案里不许残留会原样显示的 Markdown 星号 ===');
  {
    const fsx = require('fs');
    const pathx = require('path');
    const base = pathx.join(__dirname, '..');
    /**
     * 逐行剔掉注释。
     *
     * ⚠️ 试过写一个"正经的词法扫描器"（按 `//`、`/*`、引号三种状态走），
     * **失败了**：`/[\\/:*?"<>|]/g` 这种**正则字面量里的引号**会让扫描器
     * 误以为进了字符串，之后整份文件全乱 —— 于是把 JSDoc 里的 `**` 全报成缺陷
     * （实测 94 处假阳性）。注释里的 `**` 是**给读代码的人看的**，不是缺陷。
     *
     * 现在用**行级**判定：整行是注释就跳过，块注释按开/闭行跟踪。
     * 这个仓库的 JSDoc 每行都以 ` * ` 开头，所以够用。
     */
    function scanLines(rel, src) {
      const out = [];
      let inBlock = false;
      src.split(/\r?\n/).forEach((L, i) => {
        const t = L.trim();
        if (inBlock) { if (t.indexOf('*/') >= 0) inBlock = false; return; }
        if (t.indexOf('//') === 0) return;
        const open = t.indexOf('/*');
        if (open === 0) {
          if (t.indexOf('*/', 2) < 0) inBlock = true;
          return;
        }
        if (t.charAt(0) === '*') return;                 // JSDoc 正文行
        // 行尾注释也要剔掉（`foo();  // **说明**`）—— 那同样是给人看的。
        // 用 ` //`（前面带空格）而不是裸 `//`：URL 里的 `://` 前面是冒号，不会误伤。
        const cut = L.lastIndexOf(' //');
        const code = cut >= 0 ? L.slice(0, cut) : L;
        if (/\*\*[^*\n]{1,40}\*\*/.test(code)) out.push(rel + ':' + (i + 1) + '  ' + t.slice(0, 90));
      });
      return out;
    }
    const jsFiles = ['app.js', 'panels.js', 'editor.js', 'canvas.js', 'presets.js', 'schema.js', 'model.js', 'validate.js'];
    let offenders = [];
    jsFiles.forEach(f => {
      let src = fsx.readFileSync(pathx.join(base, 'js', f), 'utf8');
      // ⚠️ **唯一一处允许保留 `**` 的源**：`presets.js` 的 `DIFF_NOTES`。
      // 它是一张"文案表"，`**加粗**` 是**作者意图**，由 `renderDiff` 的
      // `boldify()` 渲染成 `<b>`（下面那条行为断言钉着它真的渲染了）。
      // 把这一段挖掉（保留行号），其余地方一律不许有。
      if (f === 'presets.js') {
        const a = src.indexOf('window.DIFF_NOTES = [');
        const b = src.indexOf('\n  ];', a);
        if (a >= 0 && b > a) {
          const head = src.slice(0, a), mid = src.slice(a, b), tail = src.slice(b);
          src = head + mid.replace(/[^\n]/g, '') + tail;
        }
      }
      offenders = offenders.concat(scanLines('js/' + f, src));
    });
    // index.html：先整段去掉 <!-- --> 注释，再按同一套行级规则看
    const htmlNoComment = fsx.readFileSync(pathx.join(base, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    offenders = offenders.concat(scanLines('index.html(去注释后)', htmlNoComment));
    offenders.slice(0, 12).forEach(s => console.log('       ↳ ' + s));
    ok(offenders.length === 0, `代码（去注释后）里没有会原样显示的 \`**加粗**\`（剩 ${offenders.length} 处）`);
  }
  // 行为面：差异页签真的渲染成了 <b>，而不是把星号写进文本
  {
    const diff = await cdp.eval(`(() => {
      window.renderDiff();
      const box = document.getElementById('diffBox');
      const first = box.querySelector('.msg');
      return JSON.stringify({
        条数: box.children.length,
        有粗体标签: box.querySelectorAll('b').length,
        文本里有星号: box.textContent.indexOf('**') >= 0,
        首条: first ? first.textContent.slice(0, 60) : null,
      });
    })()`);
    const D = JSON.parse(diff);
    console.log('    · ' + diff);
    ok(D.条数 > 10, `差异清单渲染了 ${D.条数} 条`);
    ok(D.有粗体标签 > 0, `\`**加粗**\` 渲染成了 <b>（共 ${D.有粗体标签} 处）`);
    ok(!D.文本里有星号, '差异页签的可见文本里**没有星号**');
  }

  await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
