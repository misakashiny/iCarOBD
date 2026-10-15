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
  async eval(e, timeoutMs) {
    // 瞬时 CDP 错误重试（v2.26.0）：重型的 evaluate 会让渲染进程短暂无响应，
    // CDP 报 -32000 "Inspected target navigated or closed"。
    // ⚠️ **只重试这一种** —— 语法错误/断言失败绝不重试，否则会掩盖真 bug。
    const TRANSIENT = /-32000|navigated or closed|Target closed|Session closed/i;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, timeoutMs);
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

  // ================================================================ 坏快照的结构判据与运行时跳过（T5-A 任务 · 尚未发版）
  //
  // ## 这一段补的是什么（上面 v2.37.0 那一段**留着**，不是替换）
  //
  // 上面钉的是「坏快照不许抛异常 / 加载时丢掉几条坏记录」。但它是**按字符串形态**举的例子：
  // 截断 JSON、`null`、`[]`、`{"d":null}` 这些**JSON 本身就坏**的输入 ——
  // 旧的 `restore` 只查 `o.d` 是不是对象，于是**JSON 合法但结构坏**的那一类
  // （`d.nodes` 不是数组、`d.pages` 是字符串、`sel` 是数字）**一路放行**：
  // 赋值给 `S.design` 之后才在 `refreshAll()` / `draw()` 里炸，
  // 而异常冒出去 **`restore` 根本没返回 false** —— 留下"画布坏了、撤销索引却动了"的半套状态。
  //
  // 所以下面按 T5-A 的验收逐条钉：
  //   ① 七类坏记录（截断 / null·数组·缺 d / 合法 JSON 但结构损坏 / 错误 selection / 混合好坏 / 连续坏 / 全坏）
  //   ② 无效快照**一个字节都不许改** `S.design` / `S.selection`（不许有部分状态）
  //   ③ 运行中撞到坏记录：**有限步跳过 + 就地摘掉**，不无限循环、不反复撞同条、不清空整个好栈
  //   ④ `loadUndoStack` 过滤后**索引重算**，全坏 → `null`
  //   ⑤ 好快照照常能恢复（没把功能一起挡掉）
  //
  // ⚠️ 这里的断言刻意**只依赖** `window.isUsableSnapshot` / `window.restoreSnapshot` /
  // `window.__undoStack` 公开的语义，不写"某函数内部调了某函数"：
  // 那种写法会在重构时变成假红，而**真坏**照样漏。
  console.log('\n=== T5-A · 坏快照的结构判据（解析成功 ≠ 快照可用）===');
  const struct = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    out.钩子齐 = (typeof window.isUsableSnapshot === "function") && (typeof window.restoreSnapshot === "function")
      && !!(window.__undoStack && window.__commitState);

    // ⚠️ **向后/变异跑时要仍然能走完**（T5-A 验收要求"用修复前代码反向运行证明新用例会报错"）。
    // 旧代码里没有 isUsableSnapshot，硬用会让整块在第一步就抛 "U is not a function" ——
    // 那样**只能证明"钩子不存在"**，证明不了"判据真的不对"。
    // 所以这里退化到**旧代码自身的判据等价物**（只查 JSON.parse 成功 + d 是对象），
    // 把每一条用例的真实结果收齐，再逐条断言。缺钩子这件事本身由 out.钩子齐 单独断言。
    const U = (typeof window.isUsableSnapshot === "function") ? window.isUsableSnapshot : function (snap) {
      if (typeof snap !== "string" || !snap) return false;
      let o = null;
      try { o = JSON.parse(snap); } catch (e) { return false; }
      return !!(o && typeof o === "object" && o.d && typeof o.d === "object" && !Array.isArray(o.d));
    };
    const R0 = window.restoreSnapshot;
    const R = function (snap) { return (typeof R0 === "function") ? R0(snap) : null; };

    const good = JSON.stringify({ d: { name: "结构判据", nodes: [], pages: [], pageIndex: 0 }, sel: [] });
    const snap0 = JSON.stringify({ d: S.design, sel: S.selection });
    out.基线确实有效 = (U(snap0) === true) && (R(snap0) === true);

    // ---- 正例：**不该**被硬拒的（验收明确禁止"对旧合法快照的无依据硬拒绝"）
    const 正例 = {
      "只有 d.nodes 的旧快照": JSON.stringify({ d: { nodes: [] } }),
      "缺 sel":               JSON.stringify({ d: { nodes: [], pages: [] } }),
      "sel 指向已删除的 id":   JSON.stringify({ d: { nodes: [] }, sel: ["no-such-node"] }),
      "缺 canvas/PID 等字段":  JSON.stringify({ d: { name: "x", nodes: [{ id: "a", type: "text" }] }, sel: [] }),
    };
    out.正例误拒 = [];
    for (const k in 正例) { if (U(正例[k]) !== true) out.正例误拒.push(k); }

    // ---- ①a 结构坏但 JSON 合法：**必须**判坏（旧代码在这里一律放行）
    const 结构坏 = {
      "d.nodes 不是数组":       JSON.stringify({ d: { nodes: {} }, sel: [] }),
      "d.nodes 缺失":           JSON.stringify({ d: { name: "只有名字" }, sel: [] }),
      "d.pages 是字符串":       JSON.stringify({ d: { nodes: [], pages: "p1" }, sel: [] }),
      "d 是数组":               JSON.stringify({ d: [1, 2], sel: [] }),
      "sel 是数字":             JSON.stringify({ d: { nodes: [] }, sel: 3 }),
      "sel 里有非字符串":       JSON.stringify({ d: { nodes: [] }, sel: ["ok", 7] }),
    };
    out.结构坏没判坏 = [];
    for (const k in 结构坏) { if (U(结构坏[k]) !== false) out.结构坏没判坏.push(k); }

    // ---- ①b JSON 本身就坏（截断 / null / 数组 / 缺 d）
    const 非法 = {
      "截断 JSON":   good.slice(0, Math.max(3, good.length - 8)),
      "null":        "null",
      "顶层数组":    "[1,2]",
      "缺 d":        JSON.stringify({ sel: [] }),
      "d:null":      JSON.stringify({ d: null, sel: [] }),
      "空字符串":    "",
      "不是字符串":  null,
    };
    out.非法没判坏 = [];
    for (const k in 非法) { if (U(非法[k]) !== false) out.非法没判坏.push(k); }

    // ---- ② 无效快照不得改动 design/selection，也不得留下部分状态
    //
    // ⚠️ 先自己抄一份 design/selection 的**深拷贝**：
    // 修复前的代码在结构坏快照上会直接 S.design = o.d 把设计真的换坏（这正是缺陷本身），
    // 不抄的话本块的后续步骤（commit / snapshot / refreshAll）会跟着炸，
    // 那就只证明"环境坏了"，收不到"12 条里哪几条没返回 false"。
    const 抄的设计 = JSON.parse(JSON.stringify(S.design || { nodes: [] }));
    const 抄的选区 = JSON.parse(JSON.stringify(S.selection || []));
    const before = JSON.stringify({ d: S.design, sel: S.selection });
    out.坏的没返回false = [];
    out.坏的抛了 = [];
    for (const k in 结构坏) {
      try { if (R(结构坏[k]) !== false) out.坏的没返回false.push(k); }
      catch (e) { out.坏的抛了.push(k + ":" + e.message); }
    }
    for (const k in 非法) {
      try { if (R(非法[k]) !== false) out.坏的没返回false.push(k); }
      catch (e) { out.坏的抛了.push(k + ":" + e.message); }
    }
    out.设计没被改动 = (JSON.stringify({ d: S.design, sel: S.selection }) === before);
    out.设计仍可用 = !!(S.design && Array.isArray(S.design.nodes) && Array.isArray(S.selection));
    // 环境复位：把设计换回抄下来的那份（只为了让本块跑完，不是产品行为）
    out.需要复位 = !out.设计没被改动;
    if (out.需要复位) {
      S.design = 抄的设计;
      S.selection = 抄的选区;
      try { if (typeof window.refreshAll === "function") window.refreshAll(); } catch (e) { out.复位时抛了 = String(e.message); }
    }
    out.复位后可用 = !!(S.design && Array.isArray(S.design.nodes) && Array.isArray(S.selection));

    // ---- ⑤ 好快照照常恢复（别把功能一起挡掉）
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "结构判据探针", x: 0, y: 0, w: 60, h: 20 }));
    }, "结构判据探针", "结构判据探针");
    const grown = S.design.nodes.some(function (n) { return n.name === "结构判据探针"; });
    const s = JSON.stringify({ d: JSON.parse(JSON.stringify(S.design)), sel: [] });
    S.design.nodes = S.design.nodes.filter(function (n) { return n.name !== "结构判据探针"; });
    out.好快照仍能恢复 = (R(s) === true);
    out.改动确实发生过 = grown;
    S.design.nodes = S.design.nodes.filter(function (n) { return n.name !== "结构判据探针"; });

    return JSON.stringify(out);
  })()`);
  const SC = JSON.parse(struct);
  console.log('    · ' + struct);
  ok(SC.钩子齐, 'T5-A 测试钩子齐（isUsableSnapshot / restoreSnapshot / __undoStack / __commitState）—— 缺一个下面就只能用旧判据等价物，等于反向跑');
  ok(SC.基线确实有效, '故意造的好快照本身是有效的（后面的"误拒"检查才有意义）');
  eq(SC.正例误拒.length, 0, '**合法旧快照没被硬拒**' + (SC.正例误拒.length ? '（误伤：' + SC.正例误拒.join('; ') + '）' : ''));
  eq(SC.结构坏没判坏.length, 0,
    '**合法 JSON 但结构损坏的 6 条全部判坏**' + (SC.结构坏没判坏.length ? '（漏了：' + SC.结构坏没判坏.join('; ') + '）' : ''));
  eq(SC.非法没判坏.length, 0,
    '**截断 / null / 数组 / 缺 d 等 7 条也全部判坏**' + (SC.非法没判坏.length ? '（漏了：' + SC.非法没判坏.join('; ') + '）' : ''));
  eq(SC.坏的没返回false.length, 0,
    '**12 条无效快照的 restoreSnapshot() 一律返回 false**（旧代码只查 d 是对象 → 结构坏的那 6 条会返回 true）'
    + (SC.坏的没返回false.length ? '（漏了：' + SC.坏的没返回false.join('; ') + '）' : ''));
  ok(SC.坏的抛了.length === 0, '**无效快照一个都不抛异常**（旧代码恢复失败不返回 false，异常直接冒出去）'
    + (SC.坏的抛了.length ? '（抛了：' + SC.坏的抛了.join('; ') + '）' : ''));
  ok(SC.设计没被改动, '**恢复失败后 design/selection 一个字节都没被改动**（没有部分状态）');
  ok(SC.复位后可用, '**12 条无效快照试完之后设计仍然可用**（不靠事后"手动换回"掩盖缺陷）');
  ok(SC.设计仍可用 && SC.改动确实发生过, '设计仍是可用结构，且前置改动确实生效（不是空测）');
  ok(SC.好快照仍能恢复, '**好快照仍然能恢复**（没把功能一起挡掉）');

  // ---------- ③ 运行中撞到坏记录：就地摘掉 + 有限步跳过 ----------
  //
  // 造法：`commit` 压一条**真实**快照进栈，然后用 `__commitState()` 取一份真实快照，
  // 通过 `__undoStack` **原样换掉**那一格的 `state` —— 其余记录仍是真实快照。
  // （直接改 `state` 会破坏"每条记录都是真实快照"的前提，换掉才能只坏一格。）
  console.log('\n=== T5-A · 运行中撞到坏记录：摘掉而不是反复撞 ===');
  const runtime = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const st = window.__undoStack;
    const out = {};
    // 反向（变异）跑时旧代码没有 __undoStack / __commitState —— 如实返回缺钩子，
    // **不要**在这里抛，"整块崩掉"只能证明钩子不存在，证明不了行为不对。
    out.钩子 = !!(st && typeof window.__commitState === "function");
    if (!out.钩子) return JSON.stringify(out);
    const 拍 = function () { return window.__commitState(); };

    // 一个结构坏的快照：JSON 合法，但 d.nodes 不是数组（旧代码的 restore 会放行并炸）
    const 坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });

    // ⚠️ 这里整段是**模板字符串**，正文里一个反引号都不许有（会提前闭合）。
    // ⚠️ commit 的第三个参数是 coalesceKey（不是 label）：**同一个 key 的连续改动会
    // 合并成一步**。所以下面每步都给**不同**的 key —— 否则栈会短一条、
    // "第 3 格是坏的"这个前提直接不成立。（第一版漏了，栈长_初 断言把它抓出来了。）

    // ---- (a) 混合好坏：栈 = [好(基), 好, 坏, 好, 好(当前)]，第 3 格（下标 2）是坏的
    st.reset(拍(), "基");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-1", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-1", "T5A-1");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-2", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-2", "T5A-2");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-3", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-3", "T5A-3");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-4", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-4", "T5A-4");

    st.stack[2].state = 坏;                       // 只换第 3 格（其余仍是真实快照）
    out.坏得_对_ = st.stack[2].state;
    out.换坏后可用表 = st.stack.map(function (it) { return window.isUsableSnapshot(it.state) ? 1 : 0; }).join("");
    out.换坏后标签 = st.stack.map(function (it) { return it.label; }).join("|");

    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const 表 = function () { return st.stack.map(function (it) { return (window.isUsableSnapshot(it.state) ? "+" : "-") + it.label; }).join("|"); };
    out.栈长_初 = st.size();
    out.索引_初 = st.index;
    out.换坏后标签 = 表();

    // ---- (a1) 第一步撤销：目标就在下面一格，**不该**摘任何东西
    window.doUndo();
    out.a1_索引 = st.index;
    out.a1_栈长 = st.size();
    out.a1_还留着坏记录 = st.stack.some(function (it) { return !window.isUsableSnapshot(it.state); });
    out.a1_节点名 = S.design.nodes.filter(function (n) { return /^T5A-/.test(n.name || ""); })
      .map(function (n) { return n.name; }).join(",");
    out.a1_表 = 表();

    // ---- (a2) 第二步撤销：下面那格是坏的 → 跳过它、落到"加T5A-2"，并**就地摘掉**坏记录
    // ⚠️ 进这一步之前把"当场的栈"再拍一次：如果这一刻的栈与预期不符，
    //    下面那条断言失败才能被正确定位（而不是把它读成"跳过逻辑坏了"）。
    out.a2前_索引 = st.index;
    out.a2前_栈长 = st.size();
    out.a2前_stack2可用 = window.isUsableSnapshot(st.stack[2] ? st.stack[2].state : "");
    out.a2前_stack1可用 = window.isUsableSnapshot(st.stack[1] ? st.stack[1].state : "");
    // 临时埋点：把这一步 _step 的入参/返回记下来（用完立刻还原，只在本块内）
    out.a2_step日志 = [];
    const origStep = st._step;
    const origUsable = st._usable;
    out.a2_usable问过 = [];
    st._usable = function (i, u) { const r = origUsable.call(this, i, u); out.a2_usable问过.push(i + ":" + r + "(" + (this.stack[i] && this.stack[i].label) + ")"); return r; };
    st._step = function (dir, isUsable) {
      const pre = this.index + "/" + this.stack.length;
      const r = origStep.call(this, dir, isUsable);
      out.a2_step日志.push(pre + " -> " + (r ? (r.label + " removed=" + r.removed + " index=" + r.index) : "null"));
      return r;
    };
    window.doUndo();
    st._step = origStep;
    st._usable = origUsable;
    out.a2_索引 = st.index;
    out.a2_栈长 = st.size();
    out.a2_表 = 表();
    out.a2_节点名 = S.design.nodes.filter(function (n) { return /^T5A-/.test(n.name || ""); })
      .map(function (n) { return n.name; }).join(",");
    out.a2_还有坏记录 = st.stack.some(function (it) { return !window.isUsableSnapshot(it.state); });
    out.a2_标签 = st.stack.map(function (it) { return it.label; }).join("|");
    out.a2_提示 = toastEl();
    out.设计没坏 = !!(S.design && Array.isArray(S.design.nodes));

    // ---- (b) 重做：上面那格同样是坏的 → 跳过它落到"加T5A-3"，再摘掉一条
    window.doRedo();
    out.b_索引 = st.index;
    out.b_栈长 = st.size();
    out.b_标签 = st.stack.map(function (it) { return it.label; }).join("|");
    out.b_表 = 表();
    out.b_提示 = toastEl();
    out.b_索引在界内 = st.index >= 0 && st.index < st.size();
    out.b_还有坏记录 = st.stack.some(function (it) { return !window.isUsableSnapshot(it.state); });
    out.b_节点名 = S.design.nodes.filter(function (n) { return /^T5A-/.test(n.name || ""); })
      .map(function (n) { return n.name; }).join(",");
    out.b_canUndo = st.canUndo();
    out.b_canRedo = st.canRedo();
    out.b_再撤销一次 = (function () {
      const r = st.undo(window.isUsableSnapshot);
      return r ? (r.label + "/" + r.index + "/" + st.size()) : "null";
    })();

    // 收尾：把探针节点删干净
    st.reset(拍(), "收尾");
    S.design.nodes = S.design.nodes.filter(function (n) { return !/^T5A-/.test(n.name || ""); });
    return JSON.stringify(out);
  })()`);
  const RT = JSON.parse(runtime);
  console.log('    · ' + runtime);
  ok(RT.钩子, '运行时坏记录用例拿到了测试钩子（__undoStack / __commitState）');
  // ⚠️ 缺钩子时把本段**唯一一条**失败打出来然后跳过后续断言 —— 不静默、也不刷屏。
  if (!RT.钩子) ok(false, '运行时坏记录用例缺测试钩子（__undoStack / __commitState）—— 本段其余断言未执行');
  if (RT.钩子) {
  eq(RT.坏得_对_, JSON.stringify({ d: { nodes: "不是数组" }, sel: [] }), '真的把一格换成了"JSON 合法但结构坏"的记录（前置）');
  eq(RT.换坏后可用表, '11011', '前置：**只有第 3 格（下标 2）是坏的**，其余 4 格都是真实可用快照');
  eq(RT.栈长_初, 5, '前置栈是 5 条（基 + 4 步）');
  eq(RT.索引_初, 4, '前置索引停在栈顶（第 5 格）');
  eq(RT.a1_索引, 3, '(a1) 第一次撤销退到第 4 格（下面那格是好的，正常一步）');
  eq(RT.a1_栈长, 5, '(a1) **没有坏记录被扫过 → 一条都不摘**（栈还是 5 条，纯粹一格移动）');
  ok(RT.a1_还留着坏记录, '(a1) 这一步还没碰到坏记录，它仍在栈里（没被提前清掉）');
  eq(RT.a1_节点名, 'T5A-1,T5A-2,T5A-3', '(a1) 画布上是 T5A-1 / T5A-2 / T5A-3');
  eq(RT.a2前_索引, 3, '(a2 前置) 进第二次撤销时索引是 3');
  eq(RT.a2前_栈长, 5, '(a2 前置) 进第二次撤销时栈是 5 条');
  eq(RT.a2前_stack2可用, false, '(a2 前置) **这一刻 stack[2] 确实是坏的**（否则下面的断言会指向错误的原因）');
  eq(RT.a2前_stack1可用, true, '(a2 前置) 这一刻 stack[1] 是好的（跳过目标）');
  eq(RT.a2_索引, 1, '**(a2) 第二次撤销跳过坏记录、落到"加T5A-1"那一格**（不是"点了没反应"）');
  eq(RT.a2_栈长, 4, '**(a2) 只摘掉那条坏记录**（5 条 → 4 条）；`加T5A-3/4` 是好记录，必须留着当重做锚点');
  eq(RT.a2_表, '+基|+加T5A-1|+加T5A-3|+加T5A-4', '(a2) 剩下的都是可用记录（**好记录一条没被误摘**）');
  eq(RT.a2_节点名, 'T5A-1', '(a2) 画布上只剩 T5A-1（被跳过的那条没有污染设计）');
  ok(!RT.a2_还有坏记录, '(a2) **栈里不再有坏记录残留**');
  eq(RT.a2_step日志.length, 1, '(a2) 一次撤销只走一次 _step（没有在内部反复扫）');
  ok(String(RT.a2_step日志[0]).indexOf('加T5A-1') >= 0 && String(RT.a2_step日志[0]).indexOf('removed=1') >= 0,
    '(a2) _step 落点与摘除条数：' + RT.a2_step日志[0]);
  ok(RT.a2_提示.indexOf('跳过 1 条坏记录') >= 0, '**(a2) 跳过坏记录有可见提示**：' + (RT.a2_提示 || '(空)').slice(0, 40));
  ok(RT.设计没坏, '撤销过程中设计结构始终可用（没被坏记录弄坏）');
  eq(RT.b_索引, 2, '(b) 重做回到"加T5A-3"（索引 2）—— **坏记录被摘掉后，重做仍然走得回去**');
  eq(RT.b_栈长, 4, '(b) 重做这一步栈长不变（坏记录在撤销那一步已经摘掉了）');
  eq(RT.b_标签, '基|加T5A-1|加T5A-3|加T5A-4', '(b) 剩下的标签顺序正确（没有把好记录一起摘掉）');
  eq(RT.b_节点名, 'T5A-1,T5A-2,T5A-3', '(b) 重做把设计推回"加T5A-3"那一刻');
  ok(RT.b_提示.indexOf('已重做') >= 0, '(b) 重做有可见提示：' + (RT.b_提示 || '(空)').slice(0, 30));
  ok(RT.b_索引在界内, '重做后索引在界内：' + RT.b_索引 + ' / ' + RT.b_栈长);
  ok(!RT.b_还有坏记录, '重做之后栈里依然没有坏记录（没有"反复撞同一坏记录"）');
  ok(RT.b_canUndo, '重做后仍可撤销（没把栈弄成不可用的形态）');
  eq(RT.b_canRedo, true, '(b) 栈顶"加T5A-4"还在上面 → canRedo 仍为真（重做历史没被摘坏）');
  eq(RT.b_再撤销一次, '加T5A-1/1/4', '再撤销一次落回"加T5A-1"（索引 1 / 栈长 4），序列自洽');
  }

  // ---------- ③b 连续坏 + 全坏：有限步、不无限循环、不清空好记录 ----------
  console.log('\n=== T5-A · 连续坏记录与整栈全坏 ===');
  const chain = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const st = window.__undoStack;
    const out = {};
    out.钩子 = !!(st && typeof window.__commitState === "function");
    if (!out.钩子) return JSON.stringify(out);
    const 拍 = function () { return window.__commitState(); };
    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const 坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });

    // ---- (c) 连续坏：栈 = [好(基), 好, 坏, 坏, 坏(当前)] —— 末尾**连着三条**坏的
    st.reset(拍(), "基");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-C1", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-C1", "T5A-C1");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-C2", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-C2", "T5A-C2");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-C3", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-C3", "T5A-C3");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-C4", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-C4", "T5A-C4");
    st.stack[2].state = 坏; st.stack[3].state = 坏;      // 连续三条坏的（下标 2/3/4）
    st.stack[4].state = 坏;

    out.可用表_初 = st.stack.map(function (it) { return window.isUsableSnapshot(it.state) ? 1 : 0; }).join("");
    out.栈长_初 = st.size();
    const t0 = Date.now();
    window.doUndo();
    out.用时ms = Date.now() - t0;
    out.栈长_后 = st.size();
    out.索引_后 = st.index;
    out.标签_后 = st.stack.map(function (it) { return it.label; }).join("|");
    out.节点名_后 = S.design.nodes.filter(function (n) { return /^T5A-C/.test(n.name || ""); })
      .map(function (n) { return n.name; }).join(",");
    out.还有坏记录 = st.stack.some(function (it) { return !window.isUsableSnapshot(it.state); });
    out.提示 = toastEl();
    out.设计没坏 = !!(S.design && Array.isArray(S.design.nodes));

    // ---- (d) 整栈全坏：不许清空当前设计、不许留下 -1 索引、要有可见提示
    st.reset(拍(), "基");
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "T5A-D", x: 0, y: 0, w: 10, h: 10 }));
    }, "加T5A-D", "T5A-D");
    st.stack[0].state = 坏; st.stack[1].state = 坏;       // 全坏
    out.全坏_栈长_初 = st.size();
    const designBefore = JSON.stringify(S.design);
    const selBefore = JSON.stringify(S.selection);
    window.doUndo();
    out.全坏_设计没变 = (JSON.stringify(S.design) === designBefore) && (JSON.stringify(S.selection) === selBefore);
    out.全坏_栈长_后 = st.size();
    out.全坏_索引_后 = st.index;
    out.全坏_还有坏记录 = st.stack.some(function (it) { return !window.isUsableSnapshot(it.state); });
    out.全坏_提示 = toastEl();
    const cnt = document.getElementById("undoCount");
    out.全坏_计数文案 = cnt ? cnt.textContent : null;
    out.全坏_节点名 = S.design.nodes.filter(function (n) { return /^T5A-/.test(n.name || ""); })
      .map(function (n) { return n.name; }).join(",");

    // 收尾：清干净探针节点
    st.reset(拍(), "收尾");
    S.design.nodes = S.design.nodes.filter(function (n) { return !/^T5A-/.test(n.name || ""); });
    return JSON.stringify(out);
  })()`);
  const CH = JSON.parse(chain);
  console.log('    · ' + chain);
  if (!CH.钩子) ok(false, '(连续坏/全坏) 缺测试钩子（__undoStack / __commitState）—— 本段其余断言未执行');
  if (CH.钩子) {
  eq(CH.可用表_初, '11000', '(连续坏) 前置：**末尾连着 3 条都是坏的**（下标 2/3/4）');
  eq(CH.栈长_初, 5, '(连续坏) 前置栈是 5 条（基 + 4 步）');
  ok(CH.用时ms < 2000, '**连续坏记录不会卡住**（撤销一步用时 ' + CH.用时ms + ' ms < 2000）');
  eq(CH.栈长_后, 2, '**三条连续坏记录被一次摘干净**（5 条 → 2 条），好记录一条没动');
  eq(CH.索引_后, 1, '(连续坏) 撤销一步落到第 2 格（基 | 加T5A-C1 里的 C1）');
  eq(CH.标签_后, '基|加T5A-C1', '(连续坏) 剩下的正是那条好的');
  eq(CH.节点名_后, 'T5A-C1', '(连续坏) 画布上只剩 T5A-C1');
  ok(!CH.还有坏记录, '(连续坏) 栈里不再有坏记录');
  ok(/跳过 3 条坏记录/.test(CH.提示), '**跳过 3 条有可见提示**：' + (CH.提示 || '(空)').slice(0, 40));
  ok(CH.设计没坏, '(连续坏) 设计结构始终可用');
  eq(CH.全坏_栈长_初, 2, '(全坏) 前置栈是 2 条且都是坏的');
  ok(CH.全坏_设计没变, '**整栈全坏时当前设计/选区一个字节都没变**（不是"清空画布"）');
  eq(CH.全坏_还有坏记录, false, '(全坏) 坏记录被摘干净（否则下次加载又冒出来）');
  ok(CH.全坏_索引_后 >= 0, '**全坏之后索引不悬空**（当前值 ' + CH.全坏_索引_后 + '，不是 -1）');
  eq(CH.全坏_计数文案, '0 / 0', '**撤销计数不显示 "-1 / -1" 这种坏值**：' + CH.全坏_计数文案);
  ok(/都坏了/.test(CH.全坏_提示), '**整栈全坏有可见提示**：' + (CH.全坏_提示 || '(空)').slice(0, 40));
  ok(CH.全坏_节点名.indexOf('T5A-D') >= 0, '(全坏) 当前设计里的 T5A-D 还在（没被栈烂掉连带清掉）');
  }

  // ---------- ④ loadUndoStack：同一判据 + 索引重算 + 全坏返回 null ----------
  console.log('\n=== T5-A · loadUndoStack 与 restore 用同一判据、索引重算 ===');
  const loaded2 = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const KEY = "icar-studio-undo";
    const out = {};
    if (typeof window.loadUndoStack !== "function") { out.缺钩子 = true; return JSON.stringify(out); }
    // 反向（变异）跑时旧代码没有这个判据 —— 退化到旧判据等价物（JSON.parse 成功即算过），
    // 这样"加载时到底留下几条 / 索引怎么算"仍然收得到真实数据。
    const 判可用 = (typeof window.isUsableSnapshot === "function") ? window.isUsableSnapshot : function (s) {
      if (typeof s !== "string" || !s) return false;
      try { JSON.parse(s); return true; } catch (e) { return false; }
    };
    const 结构坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });   // JSON 合法、结构坏
    const 好1 = JSON.stringify({ d: { nodes: [], pages: [] }, sel: [] });
    const 好2 = JSON.stringify({ d: { nodes: [{ id: "a", type: "text" }], pages: [] }, sel: [] });

    // ---- (e) 混合：3 条（好 / 结构坏 / 好）→ 只剩 2 条，且 index 必须跟着重算
    try {
      localStorage.setItem(KEY, JSON.stringify({
        designName: S.design.name,
        index: 2,
        stack: [
          { state: 好1, label: "好的第一条" },
          { state: 结构坏, label: "结构坏的一条" },
          { state: 好2, label: "好的第二条" },
        ],
      }));
    } catch (e) { return JSON.stringify({ 跳过: "localStorage 不可用" }); }
    const r = window.loadUndoStack();
    out.剩几条 = r && Array.isArray(r.stack) ? r.stack.length : -1;
    out.剩下标签 = r ? r.stack.map(function (it) { return it.label; }).join(",") : null;
    out.索引 = r ? r.index : null;
    out.剩下的都可用 = !!(r && r.stack.every(function (it) { return 判可用(it.state); }));

    // ---- (f) 连续坏：1 好 + 2 坏 → 只剩 1 条，index = 0
    try {
      localStorage.setItem(KEY, JSON.stringify({
        designName: S.design.name,
        index: 2,
        stack: [
          { state: 好1, label: "唯一好的" },
          { state: 结构坏, label: "坏A" },
          { state: "不是 JSON {", label: "坏B" },
        ],
      }));
    } catch (e) {}
    const r2 = window.loadUndoStack();
    out.连续坏_剩几条 = r2 ? r2.stack.length : -1;
    out.连续坏_索引 = r2 ? r2.index : null;

    // ---- (g) 全坏：必须返回 null（不许把坏栈当好的交出去）
    try {
      localStorage.setItem(KEY, JSON.stringify({
        designName: S.design.name,
        index: 1,
        stack: [
          { state: 结构坏, label: "坏1" },
          { state: { 不是字符串: true }, label: "坏2" },
        ],
      }));
    } catch (e) {}
    const r3 = window.loadUndoStack();
    out.全坏_返回null = (r3 === null);

    // ---- (h) 名字不一致：不恢复（不许"启动时自动恢复某个同名旧设计"的旁路）
    try {
      localStorage.setItem(KEY, JSON.stringify({
        designName: (S.design.name || "") + "-另一个设计",
        index: 0,
        stack: [{ state: 好1, label: "别的设计的" }],
      }));
    } catch (e) {}
    out.异名_返回null = (window.loadUndoStack() === null);

    try { localStorage.removeItem(KEY); } catch (e) {}
    return JSON.stringify(out);
  })()`);
  const L2 = JSON.parse(loaded2);
  console.log('    · ' + loaded2);
  if (L2.跳过) {
    ok(false, 'localStorage 不可用，无法验证 loadUndoStack 的结构过滤（' + L2.跳过 + '）');
  } else if (L2.缺钩子) {
    ok(false, '缺测试钩子 window.loadUndoStack —— 本段断言未执行（不静默跳过）');
  } else {
    eq(L2.剩几条, 2, '**结构坏的那条在加载时就被丢掉**（3 条 → 2 条）');
    eq(L2.剩下标签, '好的第一条,好的第二条', '剩下的确实是那两条好的（顺序也没乱）');
    ok(L2.剩下的都可用, '加载后栈里每一条都通过同一判据（加载与 restore 不漂移）');
    eq(L2.索引, 1, '**索引跟着过滤后的栈重算**（过滤前写的是 2，重算后为 1）');
    eq(L2.连续坏_剩几条, 1, '(连续坏) 加载后只剩那条好的');
    eq(L2.连续坏_索引, 0, '(连续坏) **索引重算为 0**（不是原来写死的 2，那会越界）');
    eq(L2.全坏_返回null, true, '**整栈全坏时 loadUndoStack 返回 null**（不把坏栈当好的交出去）');
    eq(L2.异名_返回null, true, '**设计名不一致时不恢复**（没有悄悄自动恢复同名旧设计的旁路）');
  }

  // ================================================================ R1（T5-R 返工）· 恢复失败**前后**的完整状态
  //
  // ## 这一段补的是什么（上面两段都留着，不是替换）
  //
  // 上面两段钉的是"判据判坏 + 加载时丢弃 + 失败后 design/selection 不动"。
  // 但规划方在**真实 file 页面**用四种快照复现了另一类：
  //
  // | 快照 | T5-A 第一版的判据 | 实际后果 |
  // |---|---|---|
  // | 缺 `canvas` | 判**可用** ✗ | `restore` 抛 `designW`，design 已被替换、dirty 已清 |
  // | `nodes=[null]` | 判**可用** ✗ | 抛 `id`/`name`，同上 |
  // | `pages=[null]` | 判**可用** ✗ | 抛，**还覆盖了未应用的 JSON 草稿** |
  // | `assets` 是对象 | 判**可用** ✗ | 抛，**还覆盖了未应用的 JSON 草稿** |
  //
  // 也就是"数组即结构有效"和"缺 canvas 有默认值"都不成立。所以这里**逐例**验证
  // （不靠"全部跑完再聚合比较"，也不用事后人工复位冒充产品回滚）。
  //
  // 每一例的现场：**有效设计 + 非空选区 + 未应用的 JSON 草稿 + 存储哨兵**。
  // 判定：`restoreSnapshot()` 必须返回 `false` 且不抛；design / selection /
  // JSON 文本 / dirty 状态 / localStorage 哨兵**一个字节都不许变**。
  // 正例（有效快照）仍然必须能恢复 —— 别把功能一起挡掉。
  console.log('\n=== T5-R · R1：四类坏快照不许污染 design / 选区 / JSON 草稿 ===');

  // ---- 现场准备（分两步：`jsonEdited` 走 setTimeout，要等它落下来）----
  //
  // 用**真实入口**造"未应用的草稿"：往文本域里写一段坏 JSON 再触发 `jsonEdited`。
  // 那正是 T6 的行为 —— 解析失败就保留画布、把文本标成"有错未生效"，
  // 此后谁都不许覆盖它。这里验的就是"恢复失败也不许覆盖它"。
  const r1setup = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    out.钩子在 = (typeof window.restoreSnapshot === "function") && (typeof window.isUsableSnapshot === "function")
      && (typeof window.jsonEdited === "function");
    const area = document.getElementById("jsonArea");
    out.有JSON文本域 = !!area;
    if (!out.钩子在 || !area) return JSON.stringify(out);
    window.commit(function () {
      S.design.nodes.push(window.createNode(window.NODE_TEXT, { name: "R1探针", x: 5, y: 5, w: 30, h: 12 }));
    }, "R1探针", "R1探针");
    const probe = S.design.nodes.filter(function (n) { return n.name === "R1探针"; })[0];
    out.原选区 = S.selection.slice();
    S.selection = probe ? [probe.id] : [];
    out.选区非空 = S.selection.length > 0;
    // 坏 JSON 草稿 + 触发真实入口（异步 250ms）
    //
    // ⚠️ 草稿文本挂到页面全局上，供下一段**在页面里**原样取回来比对
    // （不往模板字符串里插中文，避免占位符语法被当成真的模板插值）。
    window.__T5R_DRAFT = "【未应用的 JSON 草稿 T5R-R1】{ 故意写坏";
    area.value = window.__T5R_DRAFT;
    window.jsonEdited();
    return JSON.stringify(out);
  })()`);
  const R1S = JSON.parse(r1setup);
  await sleep(450);            // 等 `jsonEdited` 的 setTimeout 落下来

  const r1 = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    // ⚠️ 反向验证（HEAD / 变异形态）里可能没有这些**导出到 window** 的钩子 ——
    //    退化到旧代码自身的等价物，这样每条用例的真实结果仍然收得到，
    //    "钩子不存在"由另一条断言单独报，而不是让整段 eval 崩在第一步。
    const R = (typeof window.restoreSnapshot === "function") ? window.restoreSnapshot : function () { return null; };
    const U = (typeof window.isUsableSnapshot === "function") ? window.isUsableSnapshot : function (s) {
      if (typeof s !== "string" || !s) return false;
      let o = null;
      try { o = JSON.parse(s); } catch (e) { return false; }
      return !!(o && typeof o === "object" && o.d && typeof o.d === "object" && !Array.isArray(o.d));
    };
    out.钩子齐 = (typeof window.restoreSnapshot === "function") && (typeof window.isUsableSnapshot === "function");
    if (!out.钩子齐) return JSON.stringify(out);
    const area = document.getElementById("jsonArea");
    const draft = window.__T5R_DRAFT;                            // 上一步写进去的草稿（从页面取，不做模板插值）
    out.dirty = !!(area && area.classList.contains("dirty"));   // jsonEdited 把草稿标成"有错未生效"
    out.草稿在 = !!(area && area.value === draft);
    out.选区非空 = S.selection.length > 0;

    // ---- 存储哨兵：恢复失败不许动用户数据 ----
    const SENT = "t5r-sentinel";
    let sentBefore = null;
    try { localStorage.setItem(SENT, "哨兵值"); sentBefore = localStorage.getItem(SENT); } catch (e) { out.存储不可用 = String(e && e.message); }

    // ---- 六例：四例规划方 + 坏 children / 坏页节点 ----
    //
    // ⚠️ "缺 canvas"**不在**这一组：它是有依据的旧形态（旧快照可以只有 nodes），
    //    判据**接受**它、由 restore 做纯候选归一化（下面单独验它的真实恢复）。
    const 完整的 = JSON.stringify({ canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 }, pages: [] });
    const mk = function (extra, name) {
      const d = JSON.parse(完整的);
      d.name = name;
      Object.keys(extra).forEach(function (k) { d[k] = extra[k]; });
      return JSON.stringify({ d: d, sel: [] });
    };
    const 例 = {
      "nodes含null":     mk({ nodes: [null] }, "空节点"),
      "pages含null":     mk({ nodes: [], pages: [null] }, "空页"),
      "assets为对象":    mk({ nodes: [], assets: {} }, "素材坏"),
      "children非数组":  mk({ nodes: [{ id: "a", type: "group", children: {} }] }, "子表坏"),
      "页节点非数组":    mk({ nodes: [], pages: [{ id: "p", name: "p" }] }, "页节点坏"),
      "canvas非对象":    mk({ nodes: [], canvas: "不是对象" }, "画布坏"),
    };
    out.逐例 = [];
    Object.keys(例).forEach(function (k) {
      const snap = 例[k];
      const designRef = S.design;                     // **引用**：回滚必须把同一个对象放回去
      const before = JSON.stringify({ d: S.design, sel: S.selection });
      let 返回值 = null, 抛了 = null;
      try { 返回值 = R(snap); } catch (e) { 抛了 = String(e && e.message); }
      const after = JSON.stringify({ d: S.design, sel: S.selection });
      out.逐例.push({
        例: k,
        判可用: U(snap),                                // 这一条必须为 false（判据不许放行）
        返回值: 返回值,
        抛了: 抛了,
        设计未变: (after === before),
        同一个对象: (S.design === designRef),
        JSON草稿未被覆盖: (area.value === draft),
        dirty未被清: area.classList.contains("dirty"),
        哨兵未变: (function () { try { return localStorage.getItem(SENT) === sentBefore; } catch (e) { return false; } })(),
        设计仍可用: !!(S.design && Array.isArray(S.design.nodes)),
      });
    });

    // ---- 旧合法形态"只有 nodes / 缺 canvas"：判据接受 + **真实恢复成功** ----
    //
    // 验收明确要求"正例必须走真实 restore，结果可用"——只给判据判 true
    // 不算数（T5-A 就是这么掩盖了"代码直接访问 canvas"这件事）。
    const 旧快照 = JSON.stringify({ d: { name: "只有节点", nodes: [] }, sel: [] });
    const 旧判可用 = U(旧快照);
    const 旧返回 = R(旧快照);
    const 旧画布 = S.design && S.design.canvas;
    out.旧形态 = {
      判可用: 旧判可用,
      返回: 旧返回,
      画布对象: !!(旧画布 && typeof 旧画布 === "object"),
      画布宽: 旧画布 ? 旧画布.designW : null,
      节点表是数组: !!(S.design && Array.isArray(S.design.nodes)),
      页表对齐: !!(S.design && Array.isArray(S.design.pages) && S.design.pages.length === 1
        && S.design.pages[0].nodes === S.design.nodes),
      JSON同步了: (area.value.indexOf('"canvas"') >= 0),
      dirty被清: !area.classList.contains("dirty"),
    };

    // ---- 正例：有效快照仍然必须能恢复（别把功能一起挡掉）----
    const snapNow = JSON.stringify({ d: JSON.parse(JSON.stringify(S.design)), sel: S.selection.slice() });
    const 正例判可用 = U(snapNow);
    const 正例返回 = R(snapNow);
    out.正例 = { 判可用: 正例判可用, 返回: 正例返回, 设计仍可用: !!(S.design && Array.isArray(S.design.nodes)) };

    // ---- 收尾：草稿放弃、哨兵清掉（**测试收尾，不是产品回滚**）----
    //
    // ⚠️ 探针节点不在这里删：R1 的 design 从头到尾没变过（这正是本段的结论），
    //    那个节点是上一段（r1setup）通过 commit 加进去的，属于"上一个设计"。
    //    真正的清理放在下一段之前，按**对象**找，不做"事后人工复位"。
    try { localStorage.removeItem(SENT); } catch (e) {}
    try { if (typeof window.discardJsonEdit === "function") window.discardJsonEdit(); } catch (e) {}
    if (typeof window.refreshAll === "function") window.refreshAll();
    return JSON.stringify(out);
  })()`);
  const R1 = JSON.parse(r1);
  console.log('    · ' + r1);
  ok(R1S.钩子在, 'R1 用例拿到了测试钩子（restoreSnapshot / isUsableSnapshot / jsonEdited）');
  if (!R1S.钩子在 || !R1S.有JSON文本域) {
    ok(false, 'R1 用例缺现场（钩子或 #jsonArea）—— 其余断言未执行（不静默跳过）');
  } else {
    ok(R1.选区非空, 'R1 现场：**选区非空**（验收要求"先建立有效设计 · 非空选区"）');
    ok(R1.草稿在, 'R1 现场：JSON 文本域里是**未应用的草稿**（不是画布同步出来的文本）');
    ok(R1.dirty, 'R1 现场：草稿是 **dirty（有错未生效）** 状态（走真实 `jsonEdited` 入口）');
    eq(R1.逐例.length, 6, 'R1 六例都在（坏节点 / 坏页 / 坏素材 / 坏 children / 坏页节点 / canvas 非对象）');
    R1.逐例.forEach(function (c) {
      ok(c.判可用 === false, 'R1[' + c.例 + '] **判据判它坏**（`isUsableSnapshot` = false）');
      ok(c.返回值 === false, 'R1[' + c.例 + '] `restoreSnapshot()` 返回 **false**（实际 ' + JSON.stringify(c.返回值) + '）');
      ok(c.抛了 === null, 'R1[' + c.例 + '] **一个异常都没抛**' + (c.抛了 ? '（抛了：' + c.抛了 + '）' : ''));
      ok(c.设计未变, 'R1[' + c.例 + '] **design / selection 一个字节都没变**');
      ok(c.同一个对象, 'R1[' + c.例 + '] design 还是**同一个对象**（不是"换了个等价的新对象"）');
      ok(c.JSON草稿未被覆盖, 'R1[' + c.例 + '] **未应用的 JSON 草稿没被覆盖**');
      ok(c.dirty未被清, 'R1[' + c.例 + '] **dirty 状态没被清掉**');
      ok(c.哨兵未变, 'R1[' + c.例 + '] **localStorage 哨兵未变**（持久化用户数据没被动）');
      ok(c.设计仍可用, 'R1[' + c.例 + '] 试完这一例设计仍然可用');
    });
    // ---- 缺 canvas 的旧合法形态：判据接受 + **真实恢复成功** ----
    ok(R1.旧形态.判可用, 'R1[缺canvas] **判据接受它**（旧快照可以只有 `nodes`，不许无依据硬拒）');
    eq(R1.旧形态.返回, true, 'R1[缺canvas] **走真实 `restore` 成功**（不是"判据说行"就算）');
    ok(R1.旧形态.画布对象, 'R1[缺canvas] 归一化补上了 `canvas` 对象（恢复路径真的会读它）');
    eq(R1.旧形态.画布宽, 2560, 'R1[缺canvas] 补的是**同一组缺省值**（designW=2560）');
    ok(R1.旧形态.节点表是数组, 'R1[缺canvas] 恢复之后 `nodes` 仍是数组');
    ok(R1.旧形态.页表对齐, 'R1[缺canvas] `pages[0].nodes` 与 `nodes` 是**同一个引用**（别名没断）');
    ok(R1.旧形态.JSON同步了, 'R1[缺canvas] **同步出来的 JSON 里有 canvas**（证明它真的过了同步路径）');
    ok(R1.旧形态.dirty被清, 'R1[缺canvas] 恢复成功 → 草稿被放弃（`dirty` 清掉，这是**成功路径**该有的行为）');
    ok(R1.正例.判可用, 'R1 正例：有效快照仍被判可用（判据没把功能一起挡掉）');
    eq(R1.正例.返回, true, 'R1 正例：有效快照**走真实 restore 成功**（不是"判据说行"就算）');
    ok(R1.正例.设计仍可用, 'R1 正例：恢复之后设计可用');
  }

  // ================================================================ R2（T5-R 返工）· 端点无可用目标 ≠ 整个栈都坏
  //
  // ## 规划方的两个反例（都在真实 doUndo/doRedo 上复现过）
  //
  // | 起点 | 操作 | T5-A 的后果 |
  // |---|---|---|
  // | `[坏, current, 好redo]` index=1 | 撤销 | 整栈清空 → **反方向那条好重做记录永久丢失**，UI 误报"全坏" |
  // | `[好undo, current, 坏]` index=1 | 重做 | 整栈清空 → **反方向那条好撤销记录永久丢失** |
  //
  // 要求：两种端点、双方向连续坏、正常端点、整栈真正全坏**分别**加回归；
  // 只摘已确认坏的，保留当前与反方向的全部有效记录；没有可用目标时
  // 当前设计/选区/草稿不变、反方向仍可走；整栈真全坏才允许用当前设计重建基准。
  console.log('\n=== T5-R · R2：端点无可用目标不能清空有效历史 ===');
  const r2 = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const st = window.__undoStack;
    const out = {};
    out.钩子 = !!(st && typeof window.__commitState === "function");
    if (!out.钩子) return JSON.stringify(out);
    const 拍 = function () { return window.__commitState(); };
    // 反向验证（HEAD / 变异）里判据可能没导出到 window —— 这里退化到
    // 旧代码自身的判据等价物，让每条行为断言仍然收得到真实结果。
    const U = (typeof window.isUsableSnapshot === "function") ? window.isUsableSnapshot : function (s) {
      if (typeof s !== "string" || !s) return false;
      let o = null;
      try { o = JSON.parse(s); } catch (e) { return false; }
      return !!(o && typeof o === "object" && o.d && typeof o.d === "object" && !Array.isArray(o.d));
    };
    const 坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });
    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const 表 = function () { return st.stack.map(function (it) { return (U(it.state) ? "+" : "-") + it.label; }).join("|"); };
    const 快照 = function () { return JSON.stringify({ d: S.design, sel: S.selection }); };
    const area = document.getElementById("jsonArea");
    const 草稿 = "【未应用的 JSON 草稿 T5R-R2】";
    if (area) area.value = 草稿;
    out.病例 = [];

    // ⚠️ 每个病例都包一层 try/catch：**反向验证时**（保护被去掉）doUndo() 会抛
    //    异常。抛了就如实记下，让后面的断言去报"有效历史被清空 / 数据被污染"，
    //    而不是让整段 eval 崩掉、只剩一句"某个属性读不到"。
    const 病例 = function (名, fn) {
      const o = { 名: 名, 抛了: null };
      try { fn(o); } catch (e) { o.抛了 = String((e && e.message) || e); }
      out.病例.push(o);
    };

    // ---- 病例 A：stack=[坏, current, 好redo]，index=1 时**撤销** ----
    病例("A·端点在反方向(撤销)", function (o) {
      st.stack = [
        { state: 坏, label: "坏A" },
        { state: 拍(), label: "当前" },
        { state: 拍(), label: "好redo" },
      ];
      st.index = 1; st.lastKey = null;
      const 前A = 快照();
      window.doUndo();
      o.表 = 表(); o.索引 = st.index; o.栈长 = st.size();
      o.设计未变 = (快照() === 前A);
      o.草稿未被覆盖 = (area ? area.value === 草稿 : true);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.提示 = toastEl();
      o.计数文案 = (document.getElementById("undoCount") || {}).textContent;
    });

    // ---- 病例 B：stack=[好undo, current, 坏]，index=1 时**重做** ----
    病例("B·端点在反方向(重做)", function (o) {
      st.stack = [
        { state: 拍(), label: "好undo" },
        { state: 拍(), label: "当前" },
        { state: 坏, label: "坏B" },
      ];
      st.index = 1; st.lastKey = null;
      const 前B = 快照();
      window.doRedo();
      o.表 = 表(); o.索引 = st.index; o.栈长 = st.size();
      o.设计未变 = (快照() === 前B);
      o.草稿未被覆盖 = (area ? area.value === 草稿 : true);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.提示 = toastEl();
      o.计数文案 = (document.getElementById("undoCount") || {}).textContent;
    });

    // ---- 病例 C：双方向连续坏（撤销方向连着 2 条坏，下面还有好的）----
    病例("C·双方向连续坏(撤销)", function (o) {
      st.stack = [
        { state: 拍(), label: "好基" },
        { state: 坏, label: "坏C1" },
        { state: 坏, label: "坏C2" },
        { state: 拍(), label: "当前C" },
        { state: 拍(), label: "好上C" },
      ];
      st.index = 3; st.lastKey = null;
      const rC = st.undo(U);
      o.表 = 表(); o.索引 = st.index; o.栈长 = st.size();
      o.落到 = (rC && rC.ok) ? rC.label : "null";
      o.摘除 = (rC && rC.removed);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
    });

    // ---- 病例 D：正常端点（栈底/栈顶都是**好**记录）——必须仍是纯一格移动 ----
    病例("D·正常端点", function (o) {
      st.reset(拍(), "好底");
      st.push(拍(), "好中", "k-d1");
      st.push(拍(), "好顶", "k-d2");
      o.长初 = st.size();
      const rD = st.undo(U);
      o.长后 = st.size();
      const rD2 = st.undo(U);
      o.表 = 表(); o.索引 = st.index; o.栈长 = st.size();
      o.第一次 = (rD && rD.ok) ? rD.label : "null";
      o.第一次摘除 = (rD && rD.removed);
      o.第二次摘除 = (rD2 && rD2.removed);
    });

    // ---- 病例 E：整栈**真的**全坏（连当前条都是坏的）----
    病例("E·整栈真全坏", function (o) {
      st.stack = [
        { state: 坏, label: "坏E1" },
        { state: 坏, label: "坏E2" },
      ];
      st.index = 1; st.lastKey = null;
      const 前E = 快照();
      const 草稿前E = area ? area.value : null;
      window.doUndo();
      o.表 = 表(); o.索引 = st.index; o.栈长 = st.size();
      o.设计未变 = (快照() === 前E);
      o.草稿未被覆盖 = (area ? area.value === 草稿前E : true);
      o.还有坏记录 = st.stack.some(function (it) { return !U(it.state); });
      o.提示 = toastEl();
      const cntEl = document.getElementById("undoCount");
      o.计数文案 = cntEl ? cntEl.textContent : null;
      const u = document.getElementById("btnUndo"), r = document.getElementById("btnRedo");
      o.按钮 = (u ? (u.disabled ? "灰" : "可") : "-") + "/" + (r ? (r.disabled ? "灰" : "可") : "-");
    });

    // 收尾：栈与草稿都回到干净状态（**测试收尾，不是产品回滚**）
    st.reset(拍(), "收尾");
    if (area) area.value = "";
    if (typeof window.syncJson === "function") window.syncJson();
    if (typeof window.refreshAll === "function") window.refreshAll();
    return JSON.stringify(out);
  })()`);
  const R2 = JSON.parse(r2);
  console.log('    · ' + r2);
  ok(R2.钩子, 'R2 用例拿到了测试钩子（__undoStack / __commitState）');
  if (!R2.钩子) {
    ok(false, 'R2 用例缺测试钩子 —— 其余断言未执行（不静默跳过）');
  } else {
    const C = {};
    (R2.病例 || []).forEach(function (c) { C[c.名] = c; });
    eq(R2.病例.length, 5, 'R2 五例都在（两种端点 / 双方向连续坏 / 正常端点 / 整栈真全坏）');
    const A = C['A·端点在反方向(撤销)'], B = C['B·端点在反方向(重做)'];
    const CC = C['C·双方向连续坏(撤销)'], D = C['D·正常端点'], E = C['E·整栈真全坏'];
    // ---- A：`[坏, current, 好redo]` index=1 撤销 ----
    // 只摘**确认坏的**记录。`坏A` 在撤销够不到的那一侧，它自己也坏了 → 一并清掉；
    // **反方向那条好重做记录、当前条、索引、设计全部原样** —— 这正是 R2 的要点。
    //
    // 🔴 T5-R2 更正（R3 验收第 1 条）：这里原来写的是
    //    `eq(A.索引, 1)` + `eq(A.计数文案, '1 / 1')` —— **那是错的预期**。
    //    摘掉 `坏A` 之后栈是 `[当前, 好redo]`，**当前记录的新下标是 0**；
    //    `index` 留在 1 就等于"游标指向了 FUTURE 而设计还是 CURRENT"，
    //    `canRedo` 也会错成 false。规划方正是拿这两条把错位断言钉成了"预期"。
    //    现在按**当前记录对象**与后续实际状态断言（见 T5-R2-R1/A）。
    ok(!!A, 'R2[A] 病例存在');
    if (A) {
      ok(A.表.indexOf('+好redo') >= 0, 'R2[A] **反方向那条好重做记录还在**（不许被当成"整栈全坏"清掉）：' + A.表);
      ok(A.表.indexOf('+当前') >= 0, 'R2[A] 当前那条记录也还在：' + A.表);
      ok(A.表.indexOf('-') < 0, 'R2[A] 摘完之后栈里**没有坏记录残留**（只摘坏的）：' + A.表);
      eq(A.索引, 0, 'R2[A] **游标落在当前那条记录的新下标 0 上**（不是删除前那个数值下标 1）');
      eq(A.栈长, 2, 'R2[A] **反方向那些好记录一条都没被清掉**（3 条里只少了那条坏的）：' + A.栈长);
      ok(A.设计未变, 'R2[A] **当前设计一个字节都没变**');
      ok(A.草稿未被覆盖, 'R2[A] **未应用的 JSON 草稿没被覆盖**');
      ok(/没有可以撤销的记录了/.test(A.提示 || ''), 'R2[A] 提示说的是"这个方向没记录了"：' + (A.提示 || '(空)'));
      ok(!/都坏了/.test(A.提示 || ''), 'R2[A] **不许把混合栈称为"都坏了"**');
      eq(A.计数文案, '0 / 1', 'R2[A] 计数与实际一致（游标 0 / 栈长 2 → "0 / 1"）：' + A.计数文案);
      eq(A.canRedo, true, 'R2[A] **`canRedo` 为真**（反方向那条好重做记录真的能走）');
      eq(A.canUndo, false, 'R2[A] **`canUndo` 为假**（已经到栈底）');
    }
    // ---- B：`[好undo, current, 坏]` index=1 重做 ----
    // 重做要从**当前条出发**，所以当前条与它上面那条（坏的）都在扫描范围里：
    // 坏的那条摘掉，**反方向那条好撤销记录保持不动**、游标仍然落在当前条上。
    //
    // 🔴 T5-R2 更正：原来写 `eq(B.索引, 1)` / `eq(B.计数文案, '1 / 1')`。
    //
    //  ⚠️ 但**不是**改成"下标必须 0" —— 那是又一个错位预期。重做方向摘掉的是
    //     当前条**上面**那条（`坏B` 在 cur+1），当前条下面的 `好undo` 不动，
    //     所以 `当前` 在这个新栈里仍然落在**下标 1**。
    //     正确的断言是"**游标 === 当前那条记录对象**"（下标由栈的实际排列决定），
    //     加上 `canUndo=true`/`canRedo=false` 与计数 `1 / 1` —— 与
    //     `[坏, CURRENT, FUTURE]` 撤销那一支（下标 0、`0 / 1`）刚好对称。
    ok(!!B, 'R2[B] 病例存在');
    if (B) {
      ok(B.表.indexOf('-坏B') < 0, 'R2[B] **本方向那条坏记录已被摘掉**：' + B.表);
      ok(B.表.indexOf('+好undo') >= 0, 'R2[B] **反方向那条好撤销记录还在**（不许被清掉）：' + B.表);
      eq(B.栈长, 2, 'R2[B] 只摘掉那一条坏记录（3 → 2）：' + B.栈长);
      eq(B.索引, 1, 'R2[B] 游标落在**可用的当前那条记录**的新下标 1 上（当前条在扫描之前，摘掉的是它**上面**那条）');
      ok(B.设计未变, 'R2[B] **当前设计一个字节都没变**');
      ok(B.草稿未被覆盖, 'R2[B] **未应用的 JSON 草稿没被覆盖**');
      ok(!/都坏了/.test(B.提示 || ''), 'R2[B] **不许把混合栈称为"都坏了"**：' + (B.提示 || '(空)'));
      eq(B.计数文案, '1 / 1', 'R2[B] 计数与实际一致（游标 1 / 栈长 2 → "1 / 1"）：' + B.计数文案);
      eq(B.canUndo, true, 'R2[B] **反方向的撤销仍然能走**（`canUndo` 为真）');
      eq(B.canRedo, false, 'R2[B] 重做方向确实没记录了（`canRedo` 为假）');
    }
    // ---- C：撤销方向连着两条坏，落到下面那条好记录 ----
    ok(!!CC, 'R2[C] 病例存在');
    if (CC) {
      eq(CC.落到, '好基', 'R2[C] **一次撤销穿过两条连续坏记录，落到"好基"**');
      eq(CC.摘除, 2, 'R2[C] **两条连续坏记录都被摘掉**（只摘坏的）');
      eq(CC.表, '+好基|+当前C|+好上C', 'R2[C] 好记录一条没动、顺序也没乱：' + CC.表);
      ok(CC.canRedo, 'R2[C] 重做方向仍可走（上方两条好记录还在）');
    }
    // ---- D：正常端点 = 纯粹的一格移动 ----
    ok(!!D, 'R2[D] 病例存在');
    if (D) {
      eq(D.长初, 3, 'R2[D] 前置栈 3 条');
      eq(D.长后, 3, 'R2[D] **正常端点一步一格，一条记录都不摘**');
      eq(D.第一次摘除, 0, 'R2[D] 第一次撤销没摘任何坏记录');
      eq(D.第二次摘除, 0, 'R2[D] 到栈底也没摘任何记录');
      eq(D.第一次, '好中', 'R2[D] 第一次撤销落到"好中"');
      eq(D.索引, 0, 'R2[D] 第二次撤销落到栈底（索引 0）');
    }
    // ---- E：整栈真的全坏（连当前条都是坏的）----
    ok(!!E, 'R2[E] 病例存在');
    if (E) {
      eq(E.表, '+初始', 'R2[E] **整栈全坏才用当前设计重建基准**（只剩"初始"）：' + E.表);
      ok(E.设计未变, 'R2[E] 当前设计一个字节都没变');
      ok(E.草稿未被覆盖, 'R2[E] 未应用的 JSON 草稿没被覆盖');
      eq(E.还有坏记录, false, 'R2[E] 坏记录被摘干净');
      ok(/都坏了/.test(E.提示 || ''), 'R2[E] **整栈全坏才有"都坏了"的提示**：' + (E.提示 || '(空)'));
      eq(E.计数文案, '0 / 0', 'R2[E] **计数不显示 "-1 / -1" 这种坏值**：' + E.计数文案);
      eq(E.按钮, '灰/灰', 'R2[E] 撤销/重做按钮都变灰（栈里只剩基准）：' + E.按钮);
    }
  }

  // ================================================================ T5-R2 · R1（P1）· 端点和失败后游标必须代表**实际当前记录**
  //
  // ## 规划方实测的三个反例（真实 file 页面）
  //
  // | 栈 | index | 操作 | T5-R 的后果 |
  // |---|---|---|---|
  // | `[坏, CURRENT, FUTURE]` | 1 | 撤销 | 摘掉坏条后栈=`[CURRENT, FUTURE]`，但 **index 仍 1 → 指向 FUTURE**；设计仍 CURRENT、`canRedo=false`、计数 `1 / 1` |
  // | 同上 | — | 再重做 | 误当"全坏"→ **整栈清空**，FUTURE 丢失 |
  // | 全好栈 | 栈底 | Ctrl+Z | 被 `afterFailedStep(null)` 判成全坏 → **三条有效记录变 `[初始]`** |
  // | 全好栈 | 栈顶 | Ctrl+Y | 同上，反方向历史丢失 |
  // | `[CURRENT, TARGET, FUTURE]` | 1 | 重做（TARGET 恢复失败被摘） | 夹取下标后 index=1 → 游标留在 FUTURE，设计却仍是 CURRENT |
  //
  // ## 这一段怎么验（对每一条反例都建独立现场）
  //
  //  · **三条快照用不同设计名 / 不同节点值 / 不同选区** —— 靠 `d.name` 与
  //    `sel` 的**实际取值**判断"真的恢复到了那一份设计"，不靠三条不同的标签；
  //  · 断言 `undo.stack[undo.index] === 期望记录对象`（**对象身份**），
  //    而不只是数字下标；
  //  · 真实入口（`doUndo`/`doRedo`）与真实键盘（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）
  //    都要走一遍 —— 按钮禁用挡不住 `bindKeys`；
  //  · 失败路径（`restore` 返回 false）也要"游标回到实际当前记录"。
  console.log('\n=== T5-R2 · R1：端点与失败后游标 ===');

  const r1r2 = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const st = window.__undoStack;
    const out = {};
    out.钩子 = !!(st && typeof window.__commitState === "function" && typeof window.doUndo === "function");
    if (!out.钩子) return JSON.stringify(out);
    const area = document.getElementById("jsonArea");
    const cnt = function () { const e = document.getElementById("undoCount"); return e ? e.textContent : null; };
    const btn = function () {
      const u = document.getElementById("btnUndo"), r = document.getElementById("btnRedo");
      return (u ? (u.disabled ? "灰" : "可") : "-") + "/" + (r ? (r.disabled ? "灰" : "可") : "-");
    };
    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const 落点标签 = function () { const it = st.stack[st.index]; return it ? it.label : "(无)"; };

    // ---- 造三份**真的不同**的快照（不同设计名 / 节点值 / 选区）----
    // 基准设计先存一份，用完还原。
    const 基准 = 拍原样();

    // ① EARLIER：name=EARLIER，一个 text 节点 x=11，选区选它
    // ② CURRENT：name=CURRENT，一个 text 节点 x=22，选区选它
    // ③ FUTURE ：name=FUTURE ，一个 text 节点 x=33，选区选它
    const 做设计 = function (name, x) {
      return {
        name: name, author: "t5r2", description: "", themeId: 0,
        canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 },
        assets: [], controls: [], pages: [],
        nodes: [{ id: "n-" + name, type: "text", name: name + "节点", text: name, x: x, y: x, w: 40, h: 20 }],
      };
    };
    const 快照 = function (name, x) {
      const d = 做设计(name, x);
      return JSON.stringify({ d: d, sel: ["n-" + name] });
    };
    // ⚠️ 助手：读当前设计"身份"（名字 + 节点 x + 选区）—— 判断恢复到了**哪一份**
    const 身份 = function () {
      const d = S.design || {};
      const n = (d.nodes && d.nodes[0]) || {};
      return d.name + "|" + n.x + "|" + (S.selection || []).join(",");
    };
    function 拍原样() { return { d: S.design, sel: S.selection.slice() }; }
    const 还原基准 = function () {
      S.design = 基准.d; S.selection = 基准.sel;
      try { if (typeof window.refreshAll === "function") window.refreshAll(); } catch (e) { }
      try { window.updateUndoButtons(); } catch (e) { }
    };
    // 真实键盘事件（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）—— 走 「bindKeys」，
    // 按钮的 disabled 完全不参与。规划方两条 P1 反例就是靠它复现的。
    const kz = function (shift) {
      return new KeyboardEvent("keydown", {
        key: "z", code: "KeyZ", ctrlKey: true, shiftKey: !!shift,
        bubbles: true, cancelable: true,
      });
    };
    const ky = function () {
      return new KeyboardEvent("keydown", {
        key: "y", code: "KeyY", ctrlKey: true, bubbles: true, cancelable: true,
      });
    };

    const EARLIER = 快照("EARLIER", 11);
    const CURRENT = 快照("CURRENT", 22);
    const FUTURE  = 快照("FUTURE", 33);
    out.三份不同 = (EARLIER !== CURRENT) && (CURRENT !== FUTURE) && (EARLIER !== FUTURE);
    out.三份判可用 = [EARLIER, CURRENT, FUTURE].map(function (s) { return window.isUsableSnapshot(s); });

    const 病例 = function (名, fn) {
      const o = { 名: 名, 抛了: null };
      try { fn(o); } catch (e) { o.抛了 = String((e && e.message) || e); }
      out.病例.push(o);
    };
    out.病例 = [];

    // ---- A：「[坏, CURRENT, FUTURE]」 index=1 → 撤销 ----
    //
    // 期望（验收第 1 条）：坏条被摘掉 → 栈 「[CURRENT, FUTURE]」，
    // **游标 = CURRENT（下标 0）**、计数 「0 / 1」、「canUndo=false」/「canRedo=true」；
    // 然后**真实重做**到 FUTURE，再**真实撤销**回 CURRENT，顺序与有效历史都保留。
    病例("A·混合端点撤销→重做→撤销", function (o) {
      // 先把画布置成 CURRENT（当前记录就该是它）
      window.restoreSnapshot(CURRENT);
      o.前置身份 = 身份();
      st.stack = [
        { state: JSON.stringify({ d: { nodes: "不是数组" }, sel: [] }), label: "坏A" },
        { state: CURRENT, label: "CURRENT" },
        { state: FUTURE,  label: "FUTURE" },
      ];
      st.index = 1; st.lastKey = null;
      const 当前记录 = st.stack[1];          // ⚠️ 保存**当前记录对象**（不是下标）
      const 前 = 身份();

      window.doUndo();
      o.表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.栈长 = st.size();
      o.索引 = st.index;
      // ⚠️ **对象身份**：游标必须指着**这条** CURRENT 记录对象
      o.游标是CURRENT = (st.stack[st.index] === 当前记录);
      o.游标标签 = 落点标签();
      o.下游标 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.设计未变 = (身份() === 前);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.计数文案 = cnt(); o.按钮 = btn(); o.提示 = toastEl();

      // ---- 真实重做 → FUTURE ----
      window.doRedo();
      o.重做后身份 = 身份();
      o.重做后索引 = st.index;
      o.重做后是FUTURE = (st.stack[st.index] && st.stack[st.index].label === "FUTURE");
      o.重做后计数 = cnt();
      o.重做后canUndo = st.canUndo(); o.重做后canRedo = st.canRedo();
      o.重做后按钮 = btn();

      // ---- 再真实撤销 → 回 CURRENT ----
      window.doUndo();
      o.再撤销后身份 = 身份();
      o.再撤销后是CURRENT = (st.stack[st.index] && st.stack[st.index].label === "CURRENT");
      o.再撤销后表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.再撤销后栈长 = st.size();
    });

    // ---- B：对称的 「[EARLIER, CURRENT, 坏]」 index=1 → 重做 ----
    // 期望：坏条摘掉 → 栈 「[EARLIER, CURRENT]」，**游标 = CURRENT 那条记录对象**，
    // 「canUndo=true」/「canRedo=false」；**反方向真的能回 EARLIER**。
    //
    // ⚠️ 这里**不写死"下标必须是 0"**：重做方向摘掉的是当前条**上面**那条，
    //    它下面的 EARLIER 不动，所以 CURRENT 在新栈里的下标是 **1**
    //    （与「[坏, CURRENT, FUTURE]」撤销那一支的 0 刚好对称）。
    //    要钉的是"游标代表实际当前记录"，不是某个数字。
    病例("B·对称混合端点重做→撤销", function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: EARLIER, label: "EARLIER" },
        { state: CURRENT, label: "CURRENT" },
        { state: JSON.stringify({ d: { nodes: "不是数组" }, sel: [] }), label: "坏B" },
      ];
      st.index = 1; st.lastKey = null;
      const 当前记录 = st.stack[1];          // ⚠️ 保存**当前记录对象**（不是下标）
      const 前 = 身份();
      window.doRedo();
      o.表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.栈长 = st.size(); o.索引 = st.index;
      o.游标是CURRENT = (st.stack[st.index] === 当前记录);
      o.下游标 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.设计未变 = (身份() === 前);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.计数文案 = cnt(); o.按钮 = btn(); o.提示 = toastEl();
      // 反方向真能走：撤销回 EARLIER
      window.doUndo();
      o.撤销后身份 = 身份();
      o.撤销后是EARLIER = (st.stack[st.index] && st.stack[st.index].label === "EARLIER");
      o.撤销后栈长 = st.size();
    });

    // ---- C：双方向连续坏（撤销方向连着两条坏，中间夹着当前记录）----
    // 「[EARLIER, 坏1, 坏2, CURRENT, FUTURE]」 index=3 → 撤销应该穿过两条坏、
    // 落到 EARLIER，并且两条坏都被摘掉、CURRENT/FUTURE 保留。
    病例("C·双方向连续坏", function (o) {
      window.restoreSnapshot(CURRENT);
      const 坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });
      st.stack = [
        { state: EARLIER, label: "EARLIER" },
        { state: 坏, label: "坏C1" },
        { state: 坏, label: "坏C2" },
        { state: CURRENT, label: "CURRENT" },
        { state: FUTURE, label: "FUTURE" },
      ];
      st.index = 3; st.lastKey = null;
      window.doUndo();
      o.表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.身份 = 身份();
      o.游标标签 = 落点标签();
      o.canRedo = st.canRedo();
      o.计数文案 = cnt();
    });

    // ---- D：**正常栈底 / 栈顶** + 真实键盘（Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z）----
    //
    // 这是规划方第二条 P1 反例：正常端点被 「afterFailedStep(null)」 清栈。
    // ⚠️ 用 「window.commit」 造**真实三步**，再用**真实 keydown** 驱动 ——
    //    按钮 disabled 不参与（「bindKeys」 直接绑 document）。
    病例("D·正常栈底栈顶+真实快捷键", function (o) {
      const 真步 = function (n, x) {
        window.commit(function () {
          const d = S.design;
          d.name = "正常" + n;
          if (!d.nodes[0]) d.nodes.push({ id: "k", type: "text", name: "k", x: x, y: x, w: 10, h: 10 });
          d.nodes[0].x = x;
          d.nodes[0].name = "正常" + n + "节点";
          S.selection = [d.nodes[0].id];
        }, "步" + n);
      };
      // 造三步：栈 = [基准, 步1, 步2, 步3]，游标 3
      真步(1, 101); 真步(2, 202); 真步(3, 303);
      o.步后栈长 = st.size(); o.步后索引 = st.index;
      o.步后身份 = 身份(); o.步后计数 = cnt();
      const 步后按钮 = btn();

      // 到栈底：真实入口连按三次撤销
      window.doUndo(); window.doUndo(); window.doUndo();
      o.到栈底索引 = st.index; o.到栈底canUndo = st.canUndo();
      o.到栈底身份 = 身份(); o.到栈底计数 = cnt(); o.到栈底按钮 = btn();
      o.栈底未摘 = (st.size() === o.步后栈长);

      // ⚠️ 栈底再按**真实 Ctrl+Z** —— 必须无害无操作
      document.body.dispatchEvent(kz(false));
      o.CtrlZ后表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.CtrlZ后索引 = st.index; o.CtrlZ后身份 = 身份();
      o.CtrlZ后栈长 = st.size(); o.CtrlZ后计数 = cnt(); o.CtrlZ后按钮 = btn();
      o.CtrlZ后提示 = toastEl();
      o.CtrlZ未清栈 = (st.size() === o.步后栈长) && (st.index === o.到栈底索引);
      o.CtrlZ未误报全坏 = !/都坏了/.test(o.CtrlZ后提示 || "");
      o.CtrlZ身份未变 = (o.CtrlZ后身份 === o.到栈底身份);

      // 反方向仍能到原设计：真实入口重做三次回栈顶
      window.doRedo(); window.doRedo(); window.doRedo();
      o.重做回顶身份 = 身份(); o.重做回顶索引 = st.index;

      // ⚠️ 栈顶再按**真实 Ctrl+Y** —— 同样必须无害无操作
      document.body.dispatchEvent(ky());
      o.CtrlY后表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.CtrlY后索引 = st.index; o.CtrlY后身份 = 身份();
      o.CtrlY后栈长 = st.size(); o.CtrlY后计数 = cnt(); o.CtrlY后按钮 = btn();
      o.CtrlY后提示 = toastEl();
      o.CtrlY未清栈 = (st.size() === o.步后栈长) && (st.index === o.重做回顶索引);
      o.CtrlY未误报全坏 = !/都坏了/.test(o.CtrlY后提示 || "");
      o.CtrlY身份未变 = (o.CtrlY后身份 === o.重做回顶身份);

      // ⚠️ 栈顶再按**真实 Ctrl+Shift+Z**（= 重做）—— 同样无害
      document.body.dispatchEvent(kz(true));
      o.ShiftZ后表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.ShiftZ后索引 = st.index; o.ShiftZ后栈长 = st.size();
      o.ShiftZ未清栈 = (st.size() === o.步后栈长) && (st.index === o.重做回顶索引);
      o.ShiftZ后身份 = 身份();
      o.ShiftZ身份未变 = (o.ShiftZ后身份 === o.重做回顶身份);

      // 反方向（顶 → 底）真实快捷键仍然工作：再按一次 Ctrl+Z 必须真退一格
      document.body.dispatchEvent(kz(false));
      o.再CtrlZ身份 = 身份(); o.再CtrlZ索引 = st.index;
      o.再CtrlZ生效 = (st.index === o.重做回顶索引 - 1);
      o.步后表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.步后按钮 = 步后按钮;
    });

    // ---- E：整栈**真的**全坏 → 才允许重建基准 ----
    病例("E·整栈真全坏", function (o) {
      window.restoreSnapshot(CURRENT);
      const 坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });
      st.stack = [{ state: 坏, label: "坏E1" }, { state: 坏, label: "坏E2" }];
      st.index = 1; st.lastKey = null;
      const 前 = 身份();
      const 草稿前 = area ? area.value : null;
      window.doUndo();
      o.表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.栈长 = st.size(); o.索引 = st.index;
      o.设计未变 = (身份() === 前);
      o.草稿未被覆盖 = (area ? area.value === 草稿前 : true);
      o.提示 = toastEl(); o.计数文案 = cnt(); o.按钮 = btn();
    });

    // ---- F：「restore」 判据通过但**失败** → 两个方向游标都回到实际当前记录 ----
    //
    // 规划方第三条 P1 反例：「[CURRENT, TARGET, FUTURE]」，TARGET 在真实 draw 阶段
    // 失败被摘掉后，**夹取下标**把游标留在 FUTURE。这里 redo 与 undo 两个方向
    // 各来一次，断言的是"游标 === 实际当前记录对象"。
    病例("F·恢复失败后游标(两方向)", function (o) {
      const 真draw = window.draw;
      const 坏TARGET = JSON.stringify({
        d: {
          name: "TARGET", author: "t", description: "", themeId: 0,
          canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 },
          assets: [], controls: [], pages: [],
          nodes: [{ id: "n-TARGET", type: "text", name: "T", text: "T", x: 77, y: 77, w: 10, h: 10 }],
        },
        sel: ["n-TARGET"],
      });
      o.坏TARGET判可用 = window.isUsableSnapshot(坏TARGET);

      // ---- F1：redo 方向 ----
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: CURRENT, label: "CURRENT" },
        { state: 坏TARGET, label: "TARGET" },
        { state: FUTURE, label: "FUTURE" },
      ];
      st.index = 0; st.lastKey = null;
      const 当前记录 = st.stack[0];
      const 前身份 = 身份();
      let 抛了 = null, 提示 = "";
      // 让**真实** window.draw 抛一次（只这一次）
      let 已抛 = false;
      window.draw = function () {
        if (!已抛) { 已抛 = true; throw new Error("T5R2 注入：draw 阶段失败"); }
        return 真draw.apply(this, arguments);
      };
      try { window.doRedo(); } catch (e) { 抛了 = String((e && e.message) || e); }
      window.draw = 真draw;
      提示 = toastEl();
      o.redo抛了 = 抛了;
      o.redo表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.redo栈长 = st.size(); o.redo索引 = st.index;
      o.redo游标是当前记录 = (st.stack[st.index] === 当前记录);
      o.redo游标标签 = 落点标签();
      o.redo身份未变 = (身份() === 前身份);
      o.redo计数 = cnt(); o.redo按钮 = btn();
      o.redo未报成功 = !/已重做/.test(提示 || "");
      o.redo如实报失败 = /无法恢复/.test(提示 || "");
      o.redoTARGET已摘 = (st.stack.indexOf(st.stack[1]) < 0);

      // ---- F2：undo 方向（对称）----
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: FUTURE, label: "FUTURE" },
        { state: 坏TARGET, label: "TARGET" },
        { state: CURRENT, label: "CURRENT" },
      ];
      st.index = 2; st.lastKey = null;
      const 当前记录2 = st.stack[2];
      const 前身份2 = 身份();
      已抛 = false;
      window.draw = function () {
        if (!已抛) { 已抛 = true; throw new Error("T5R2 注入：draw 阶段失败"); }
        return 真draw.apply(this, arguments);
      };
      let 抛了2 = null;
      try { window.doUndo(); } catch (e) { 抛了2 = String((e && e.message) || e); }
      window.draw = 真draw;
      o.undo抛了 = 抛了2;
      o.undo表 = st.stack.map(function (it) { return it.label; }).join("|");
      o.undo栈长 = st.size(); o.undo索引 = st.index;
      o.undo游标是当前记录 = (st.stack[st.index] === 当前记录2);
      o.undo游标标签 = 落点标签();
      o.undo身份未变 = (身份() === 前身份2);
      o.undo计数 = cnt(); o.undo按钮 = btn();
      o.undo未报成功 = !/已撤销/.test(toastEl() || "");

      // 收尾：真实恢复能力没被破坏
      o.收尾恢复 = window.restoreSnapshot(FUTURE);
      o.收尾身份 = 身份();
    });

    // ---- 收尾（测试收尾，不是产品回滚）----
    还原基准();
    st.reset(window.__commitState(), "收尾");
    if (area) area.value = "";
    try { if (typeof window.syncJson === "function") window.syncJson(); } catch (e) { }
    return JSON.stringify(out);
  })()`);
  const RR = JSON.parse(r1r2);
  console.log('    · ' + r1r2);
  ok(RR.钩子, 'T5-R2 R1 用例拿到了测试钩子（__undoStack / __commitState / doUndo）');
  if (!RR.钩子) {
    ok(false, 'T5-R2 R1 用例缺测试钩子 —— 其余断言未执行（不静默跳过）');
  } else {
    const C2 = {};
    (RR.病例 || []).forEach(function (c) { C2[c.名] = c; });
    ok(RR.三份不同, 'T5-R2 R1 **三条快照是不同字符串**（不同设计名/节点值/选区，不是同一拍贴不同标签）');
    eq((RR.三份判可用 || []).join(","), "true,true,true", 'T5-R2 R1 三条快照都**判可用**（都是有效设计）');
    eq(RR.病例.length, 6, 'T5-R2 R1 六个病例都在（两种混合端点 / 连续坏 / 正常端点+快捷键 / 整栈全坏 / 恢复失败游标）');

    const A2 = C2['A·混合端点撤销→重做→撤销'];
    ok(!!A2, 'T5-R2 R1[A] 病例存在');
    if (A2) {
      eq(A2.抛了, null, 'T5-R2 R1[A] **一个异常都没抛**' + (A2.抛了 ? '（抛了：' + A2.抛了 + '）' : ''));
      eq(A2.表, 'CURRENT|FUTURE', 'T5-R2 R1[A] 坏条被摘掉，两条有效记录按原顺序保留：' + A2.表);
      eq(A2.栈长, 2, 'T5-R2 R1[A] 栈长 2（3 条里只少了那条坏的）');
      eq(A2.索引, 0, 'T5-R2 R1[A] **CURRENT 的新下标是 0**（不是删除前的 1）');
      ok(A2.游标是CURRENT, 'T5-R2 R1[A] **游标就是 CURRENT 那条记录对象**（对象身份，标签=' + A2.游标标签 + '）');
      ok(A2.设计未变, 'T5-R2 R1[A] 撤销这一步没走成 → **当前设计一个字节都没变**');
      eq(A2.canUndo, false, 'T5-R2 R1[A] **`canUndo=false`**（已经到栈底）');
      eq(A2.canRedo, true, 'T5-R2 R1[A] **`canRedo=true`**（FUTURE 真的还能走）');
      eq(A2.计数文案, '0 / 1', 'T5-R2 R1[A] **计数 0 / 1**：' + A2.计数文案);
      eq(A2.按钮, '灰/可', 'T5-R2 R1[A] 按钮与 canUndo/canRedo 一致：' + A2.按钮);
      eq(A2.重做后是FUTURE, true, 'T5-R2 R1[A] **真实重做走到了 FUTURE**（游标=' + A2.重做后索引 + '）');
      eq(A2.重做后身份, 'FUTURE|33|n-FUTURE', 'T5-R2 R1[A] 重做后**实际设计**是 FUTURE（名/节点值/选区三项都对）：' + A2.重做后身份);
      eq(A2.重做后canRedo, false, 'T5-R2 R1[A] 重做到顶后 `canRedo=false`');
      eq(A2.重做后canUndo, true, 'T5-R2 R1[A] 重做到顶后 `canUndo=true`');
      eq(A2.再撤销后是CURRENT, true, 'T5-R2 R1[A] 再真实撤销又回到 CURRENT');
      eq(A2.再撤销后身份, 'CURRENT|22|n-CURRENT', 'T5-R2 R1[A] 撤销回来的是 **CURRENT 那份设计**：' + A2.再撤销后身份);
      eq(A2.再撤销后表, 'CURRENT|FUTURE', 'T5-R2 R1[A] **顺序与有效历史全程保留**：' + A2.再撤销后表);
    }

    const B2 = C2['B·对称混合端点重做→撤销'];
    ok(!!B2, 'T5-R2 R1[B] 病例存在');
    if (B2) {
      eq(B2.抛了, null, 'T5-R2 R1[B] **一个异常都没抛**' + (B2.抛了 ? '（抛了：' + B2.抛了 + '）' : ''));
      eq(B2.表, 'EARLIER|CURRENT', 'T5-R2 R1[B] 坏条被摘掉，反方向的 EARLIER 保留：' + B2.表);
      eq(B2.栈长, 2, 'T5-R2 R1[B] 栈长 2');
      eq(B2.索引, 1, 'T5-R2 R1[B] **CURRENT 的新下标是 1**（摘掉的是它**上面**那条，EARLIER 还在下面）');
      ok(B2.游标是CURRENT, 'T5-R2 R1[B] **游标就是 CURRENT 那条记录对象**（标签=' + B2.游标标签 + '）');
      ok(B2.设计未变, 'T5-R2 R1[B] 重做这一步没走成 → **当前设计一个字节都没变**');
      eq(B2.canUndo, true, 'T5-R2 R1[B] **`canUndo=true`**（EARLIER 真的还能走）');
      eq(B2.canRedo, false, 'T5-R2 R1[B] **`canRedo=false`**');
      eq(B2.计数文案, '1 / 1', 'T5-R2 R1[B] **计数 1 / 1**（与游标/栈长一致）：' + B2.计数文案);
      eq(B2.按钮, '可/灰', 'T5-R2 R1[B] 按钮与 canUndo/canRedo 一致：' + B2.按钮);
      ok(!/都坏了/.test(B2.提示 || ''), 'T5-R2 R1[B] **不许把混合栈称为"都坏了"**：' + (B2.提示 || '(空)'));
      eq(B2.撤销后是EARLIER, true, 'T5-R2 R1[B] **反方向真的走到了 EARLIER**');
      eq(B2.撤销后身份, 'EARLIER|11|n-EARLIER', 'T5-R2 R1[B] 落到的是 EARLIER 那份设计：' + B2.撤销后身份);
      eq(B2.撤销后栈长, 2, 'T5-R2 R1[B] 撤销后栈长仍 2（有效历史保留）');
    }

    const CC2 = C2['C·双方向连续坏'];
    ok(!!CC2, 'T5-R2 R1[C] 病例存在');
    if (CC2) {
      eq(CC2.抛了, null, 'T5-R2 R1[C] 不抛异常');
      eq(CC2.表, 'EARLIER|CURRENT|FUTURE', 'T5-R2 R1[C] 一次撤销穿过两条连续坏，好记录一条没动、顺序不乱：' + CC2.表);
      eq(CC2.游标标签, 'EARLIER', 'T5-R2 R1[C] 游标落在 EARLIER');
      eq(CC2.身份, 'EARLIER|11|n-EARLIER', 'T5-R2 R1[C] 实际设计就是 EARLIER：' + CC2.身份);
      eq(CC2.canRedo, true, 'T5-R2 R1[C] 重做方向仍可走');
      eq(CC2.计数文案, '0 / 2', 'T5-R2 R1[C] 计数与实际一致：' + CC2.计数文案);
    }

    const D2 = C2['D·正常栈底栈顶+真实快捷键'];
    ok(!!D2, 'T5-R2 R1[D] 病例存在');
    if (D2) {
      eq(D2.步后栈长, 4, 'T5-R2 R1[D] 真实 commit 三步 → 栈 4 条（含基准）：' + D2.步后栈长);
      eq(D2.步后索引, 3, 'T5-R2 R1[D] 游标在栈顶（3）');
      eq(D2.到栈底索引, 0, 'T5-R2 R1[D] 连按撤销退到栈底（0）');
      eq(D2.到栈底canUndo, false, 'T5-R2 R1[D] 到栈底 `canUndo=false`');
      eq(D2.到栈底计数, '0 / 3', 'T5-R2 R1[D] 到栈底计数仍是 0 / 3（有效历史没丢）：' + D2.到栈底计数);
      eq(D2.到栈底按钮, '灰/可', 'T5-R2 R1[D] 到栈底按钮：撤销灰、重做可：' + D2.到栈底按钮);
      eq(D2.栈底未摘, true, 'T5-R2 R1[D] 退到栈底的过程中**一条记录都没摘**');
      // ⚠️ 规划方第二条 P1 反例就发生在这里
      eq(D2.CtrlZ未清栈, true, 'T5-R2 R1[D] 🔴 **栈底真实 Ctrl+Z 不清空有效历史**（栈长与游标都不动）');
      eq(D2.CtrlZ后栈长, 4, 'T5-R2 R1[D] 栈底 Ctrl+Z 之后栈仍是 4 条：' + D2.CtrlZ后栈长);
      eq(D2.CtrlZ后索引, 0, 'T5-R2 R1[D] 栈底 Ctrl+Z 之后游标仍是 0：' + D2.CtrlZ后索引);
      eq(D2.CtrlZ身份未变, true, 'T5-R2 R1[D] 栈底 Ctrl+Z 是**无害无操作**（当前设计没变）');
      eq(D2.CtrlZ未误报全坏, true, 'T5-R2 R1[D] 🔴 栈底 Ctrl+Z **不误报"记录都坏了"**：' + (D2.CtrlZ后提示 || '(空)'));
      eq(D2.CtrlZ后计数, '0 / 3', 'T5-R2 R1[D] 栈底 Ctrl+Z 后计数仍与实际一致：' + D2.CtrlZ后计数);
      eq(D2.CtrlZ后按钮, '灰/可', 'T5-R2 R1[D] 栈底 Ctrl+Z 后按钮：撤销灰、重做可：' + D2.CtrlZ后按钮);
      // 反方向仍能到原设计
      eq(D2.重做回顶索引, 3, 'T5-R2 R1[D] 反方向重做两次回到栈顶（3）');
      eq(D2.重做回顶身份, D2.步后身份, 'T5-R2 R1[D] 🔴 **反方向仍能到原设计**（身份与三步之后一致）：' + D2.重做回顶身份);
      // 栈顶真实 Ctrl+Y
      eq(D2.CtrlY未清栈, true, 'T5-R2 R1[D] 🔴 **栈顶真实 Ctrl+Y 不清空有效历史**');
      eq(D2.CtrlY后栈长, 4, 'T5-R2 R1[D] 栈顶 Ctrl+Y 之后栈仍是 4 条：' + D2.CtrlY后栈长);
      eq(D2.CtrlY后索引, 3, 'T5-R2 R1[D] 栈顶 Ctrl+Y 之后游标仍是 3：' + D2.CtrlY后索引);
      eq(D2.CtrlY身份未变, true, 'T5-R2 R1[D] 栈顶 Ctrl+Y 是**无害无操作**');
      eq(D2.CtrlY未误报全坏, true, 'T5-R2 R1[D] 栈顶 Ctrl+Y **不误报"记录都坏了"**：' + (D2.CtrlY后提示 || '(空)'));
      eq(D2.CtrlY后计数, '3 / 3', 'T5-R2 R1[D] 栈顶 Ctrl+Y 后计数：' + D2.CtrlY后计数);
      eq(D2.CtrlY后按钮, '可/灰', 'T5-R2 R1[D] 栈顶 Ctrl+Y 后按钮：撤销可、重做灰：' + D2.CtrlY后按钮);
      // Ctrl+Shift+Z
      eq(D2.ShiftZ未清栈, true, 'T5-R2 R1[D] 🔴 **栈顶 Ctrl+Shift+Z 也不清空有效历史**');
      eq(D2.ShiftZ后索引, 3, 'T5-R2 R1[D] Ctrl+Shift+Z 之后游标仍是 3：' + D2.ShiftZ后索引);
      eq(D2.ShiftZ身份未变, true, 'T5-R2 R1[D] Ctrl+Shift+Z 是**无害无操作**');
      // 反方向（顶→底）真实快捷键仍然工作
      eq(D2.再CtrlZ生效, true, 'T5-R2 R1[D] 栈顶再按真实 Ctrl+Z **真的退了一格**（回到 ' + D2.再CtrlZ索引 + '）');
      ok(D2.再CtrlZ身份 !== D2.重做回顶身份, 'T5-R2 R1[D] 真实 Ctrl+Z 确实改变了设计：' + D2.再CtrlZ身份);
    }

    const E2 = C2['E·整栈真全坏'];
    ok(!!E2, 'T5-R2 R1[E] 病例存在');
    if (E2) {
      eq(E2.表, '初始', 'T5-R2 R1[E] **整栈真的全坏才重建基准**（只剩"初始"）：' + E2.表);
      eq(E2.栈长, 1, 'T5-R2 R1[E] 清完只剩一条基准');
      ok(E2.设计未变, 'T5-R2 R1[E] 当前设计一个字节都没变');
      ok(E2.草稿未被覆盖, 'T5-R2 R1[E] 未应用的 JSON 草稿没被覆盖');
      ok(/都坏了/.test(E2.提示 || ''), 'T5-R2 R1[E] 只有这一支才报"都坏了"：' + (E2.提示 || '(空)'));
      eq(E2.计数文案, '0 / 0', 'T5-R2 R1[E] 计数不显示 "-1 / -1"：' + E2.计数文案);
      eq(E2.按钮, '灰/灰', 'T5-R2 R1[E] 两个按钮都灰：' + E2.按钮);
    }

    const F2 = C2['F·恢复失败后游标(两方向)'];
    ok(!!F2, 'T5-R2 R1[F] 病例存在');
    if (F2) {
      eq(F2.坏TARGET判可用, true, 'T5-R2 R1[F] 前置：TARGET **判据判它可用**（失败发生在判据之后）');
      // ---- redo 方向（规划方第三条反例）----
      eq(F2.redo抛了, null, 'T5-R2 R1[F] redo 失败路径**不抛异常**' + (F2.redo抛了 ? '（抛了：' + F2.redo抛了 + '）' : ''));
      eq(F2.redo表, 'CURRENT|FUTURE', 'T5-R2 R1[F] TARGET 被摘掉，CURRENT/FUTURE 保留：' + F2.redo表);
      eq(F2.redo索引, 0, 'T5-R2 R1[F] 🔴 **redo 失败后游标是 0**（不是夹取出来的 1 → FUTURE）');
      eq(F2.redo游标是当前记录, true, 'T5-R2 R1[F] 🔴 **游标就是进 restore 之前那条当前记录对象**（标签=' + F2.redo游标标签 + '）');
      eq(F2.redo身份未变, true, 'T5-R2 R1[F] redo 失败后**实际设计仍是 CURRENT**');
      eq(F2.redo未报成功, true, 'T5-R2 R1[F] 🔴 **失败不报成功**（提示里没有"已重做"）');
      eq(F2.redo如实报失败, true, 'T5-R2 R1[F] 如实报"这一步的记录无法恢复"');
      eq(F2.redo计数, '0 / 1', 'T5-R2 R1[F] 计数与游标/栈长一致：' + F2.redo计数);
      eq(F2.redo按钮, '灰/可', 'T5-R2 R1[F] 按钮与 canUndo/canRedo 一致（FUTURE 仍可走）：' + F2.redo按钮);
      // ---- undo 方向（对称，不能只验一边）----
      eq(F2.undo抛了, null, 'T5-R2 R1[F] undo 失败路径**不抛异常**' + (F2.undo抛了 ? '（抛了：' + F2.undo抛了 + '）' : ''));
      eq(F2.undo表, 'FUTURE|CURRENT', 'T5-R2 R1[F] undo 方向 TARGET 被摘掉：' + F2.undo表);
      eq(F2.undo索引, 1, 'T5-R2 R1[F] undo 失败后游标落在 CURRENT（下标 1）');
      eq(F2.undo游标是当前记录, true, 'T5-R2 R1[F] **undo 方向游标也是当前记录对象**（标签=' + F2.undo游标标签 + '）');
      eq(F2.undo身份未变, true, 'T5-R2 R1[F] undo 失败后**实际设计仍是 CURRENT**');
      eq(F2.undo未报成功, true, 'T5-R2 R1[F] **失败不报成功**（提示里没有"已撤销"）');
      eq(F2.undo计数, '1 / 1', 'T5-R2 R1[F] 计数与游标/栈长一致：' + F2.undo计数);
      eq(F2.undo按钮, '可/灰', 'T5-R2 R1[F] 按钮一致（FUTURE 方向仍可撤销）：' + F2.undo按钮);
      // ---- 收尾：恢复能力没被破坏 ----
      eq(F2.收尾恢复, true, 'T5-R2 R1[F] 收尾：真实 `restoreSnapshot` 仍然成功（失败路径没把功能挡掉）');
      eq(F2.收尾身份, 'FUTURE|33|n-FUTURE', 'T5-R2 R1[F] 收尾恢复到的就是 FUTURE：' + F2.收尾身份);
    }
  }

  // ================================================================ T5-R3 · R1（P1）· 当前记录**自己坏了**时的锚点语义
  //
  // ## 规划方实测的两个反例（真实 file 页面）
  //
  // | 栈 | index | 操作 | T5-R2 的后果 |
  // |---|---|---|---|
  // | `[坏BEFORE, 坏CURRENT, FUTURE]` | 1 | 撤销 | 两条坏记录摘掉后栈=`[FUTURE]`、`index=0`；**实际设计仍是 CURRENT**、`canRedo=false` → 保留的 FUTURE **不可达** |
  // | `[EARLIER, 坏CURRENT, 坏AFTER]` | 1 | 重做 | 对称：栈=`[EARLIER]`、`index=0`；实际设计仍是 CURRENT、`canUndo=false` → EARLIER **不可达** |
  //
  // 关键区别：这**不是**"整栈全坏"（反方向真有好记录），所以既不许清栈、
  // 也不许把游标硬指到一条不是当前的记录上 —— 正确做法是**仅为"实际当前设计"
  // 补一条有效锚点**（位置 = 它原来的位置前面还剩几条活着的记录）。
  //
  // ## 这一段怎么验
  //
  //  · 三份快照的**设计名 / 节点值 / 非空选区全都不同**；判"恢复到了哪一份"看的是
  //    `设计名 | 节点 x | 选区` 三项**实际值**，不是标签；
  //  · **模型结果**（直接调 `st.undo/st.redo` 拿返回对象：`ok/removed/usableLeft/
  //    curRemoved/anchorAt/anchor`）与**真实入口**（`doUndo`/`doRedo`）都要走；
  //  · 反方向的记录按**对象身份**证明"原字节与顺序保留"；
  //  · 失败那一步**不许动** dirty 草稿（真的经 `jsonEdited()` 造出 dirty 提示条）
  //    与 localStorage 哨兵；
  //  · 还要覆盖"当前记录坏 **且** 目标恢复也失败"与"连续坏条 / 连续失败"。
  console.log('\n=== T5-R3 · R1：当前记录自己坏了（锚点） ===');

  const r3r1 = await cdp.eval(`(async () => {
    const S = window.CanvasState;
    const st = window.__undoStack;
    const out = {};
    out.钩子 = !!(st && typeof window.__commitState === "function"
      && typeof window.doUndo === "function" && typeof window.doRedo === "function"
      && typeof window.isUsableSnapshot === "function"
      && typeof window.restoreSnapshot === "function");
    if (!out.钩子) return JSON.stringify(out);
    const area = document.getElementById("jsonArea");
    const cnt = function () { const e = document.getElementById("undoCount"); return e ? e.textContent : null; };
    const btn = function () {
      const u = document.getElementById("btnUndo"), r = document.getElementById("btnRedo");
      return (u ? (u.disabled ? "灰" : "可") : "-") + "/" + (r ? (r.disabled ? "灰" : "可") : "-");
    };
    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const 表 = function () { return st.stack.map(function (i) { return i.label; }).join("|"); };
    const 坏 = JSON.stringify({ d: { nodes: "不是数组" }, sel: [] });
    const 睡眠 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    const 做设计 = function (name, x) {
      return {
        name: name, author: "t5r3", description: "", themeId: 0,
        canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 },
        assets: [], controls: [], pages: [],
        nodes: [{ id: "n-" + name, type: "text", name: name + "节点", text: name, x: x, y: x, w: 40, h: 20 }],
      };
    };
    const 快照 = function (name, x) { return JSON.stringify({ d: 做设计(name, x), sel: ["n-" + name] }); };
    const EARLIER = 快照("EARLIER", 11);
    const CURRENT = 快照("CURRENT", 22);
    const FUTURE  = 快照("FUTURE", 33);
    const TARGET  = 快照("TARGET", 44);
    const 身份 = function () {
      const d = S.design || {};
      const n = (d.nodes && d.nodes[0]) || {};
      return d.name + "|" + n.x + "|" + (S.selection || []).join(",");
    };
    const 基准 = { d: S.design, sel: S.selection.slice() };
    const barOf = function () { return document.getElementById("jsonDirtyBar"); };
    const 条文本 = function () { const b = barOf(); return b ? b.textContent : null; };
    const 条可见 = function () { const b = barOf(); return b ? (b.style.display !== "none") : false; };
    const 按钮是函数 = function () {
      const b = barOf();
      const x = b ? b.querySelector("button") : null;
      return !!(x && typeof x.onclick === "function");
    };

    const SENT = "t5r3-sentinel";
    try { localStorage.setItem(SENT, "哨兵"); } catch (e) { out.存储不可用 = String(e && e.message); }
    const 哨兵 = function () { try { return localStorage.getItem(SENT); } catch (e) { return null; } };

    out.三份不同 = (EARLIER !== CURRENT) && (CURRENT !== FUTURE) && (EARLIER !== FUTURE);
    out.三份判可用 = [EARLIER, CURRENT, FUTURE].map(function (s) { return window.isUsableSnapshot(s); });
    out.坏记录判坏 = window.isUsableSnapshot(坏);
    out.TARGET判可用 = window.isUsableSnapshot(TARGET);

    out.病例 = [];
    // ⚠️ 病例是 **async** 的：I 例要走**真实**的 jsonEdited()（350ms 防抖）
    //    把"dirty 草稿 + dirty 提示条 + 可点按钮"真的造出来，再验证失败那一步没动它。
    const 病例 = async function (名, fn) {
      const o = { 名: 名, 抛了: null };
      try { await fn(o); } catch (e) { o.抛了 = String((e && e.message) || e); }
      out.病例.push(o);
    };

    // ---- G：**模型层**（撤销方向）----
    await 病例("G·模型结果(撤销方向)", function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: 坏, label: "坏BEFORE" },
        { state: 坏, label: "坏CURRENT" },
        { state: FUTURE, label: "FUTURE" },
      ];
      st.index = 1; st.lastKey = "哨兵键";
      const 记录FUTURE = st.stack[2];
      const 前身份 = 身份();
      const r = st.undo(window.isUsableSnapshot, window.__commitState(), "当前设计");
      o.返回ok = r.ok; o.removed = r.removed; o.usableLeft = r.usableLeft;
      o.curRemoved = r.curRemoved; o.anchorAt = r.anchorAt;
      o.有锚点 = !!r.anchor; o.锚点标签 = r.anchor ? r.anchor.label : null;
      o.锚点就是实际当前设计 = !!r.anchor && (r.anchor.state === window.__commitState());
      o.表 = 表(); o.栈长 = st.size(); o.索引 = st.index;
      o.游标是锚点 = (st.stack[st.index] === r.anchor);
      o.FUTURE原对象保留 = (st.stack[1] === 记录FUTURE);
      o.FUTURE原字节保留 = (st.stack[1] && st.stack[1].state === FUTURE);
      o.lastKey归位 = (st.lastKey === null);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.身份 = 身份();
      o.设计未变 = (o.身份 === 前身份);
    });

    // ---- H：**模型层**（对称方向）----
    await 病例("H·模型结果(重做方向)", function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: EARLIER, label: "EARLIER" },
        { state: 坏, label: "坏CURRENT" },
        { state: 坏, label: "坏AFTER" },
      ];
      st.index = 1; st.lastKey = "哨兵键2";
      const 记录EARLIER = st.stack[0];
      const 前身份 = 身份();
      const r = st.redo(window.isUsableSnapshot, window.__commitState(), "当前设计");
      o.返回ok = r.ok; o.removed = r.removed; o.usableLeft = r.usableLeft;
      o.curRemoved = r.curRemoved; o.anchorAt = r.anchorAt;
      o.有锚点 = !!r.anchor; o.锚点标签 = r.anchor ? r.anchor.label : null;
      o.锚点就是实际当前设计 = !!r.anchor && (r.anchor.state === window.__commitState());
      o.表 = 表(); o.栈长 = st.size(); o.索引 = st.index;
      o.游标是锚点 = (st.stack[st.index] === r.anchor);
      o.EARLIER原对象保留 = (st.stack[0] === 记录EARLIER);
      o.EARLIER原字节保留 = (st.stack[0] && st.stack[0].state === EARLIER);
      o.lastKey归位 = (st.lastKey === null);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.身份 = 身份();
      o.设计未变 = (o.身份 === 前身份);
    });

    // ---- I：**真实入口**（撤销方向）+ **真实 dirty 草稿/提示条** + 存储哨兵 + 反方向真实可达 ----
    await 病例("I·真实入口撤销→重做→撤销", async function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: 坏, label: "坏BEFORE" },
        { state: 坏, label: "坏CURRENT" },
        { state: FUTURE, label: "FUTURE" },
      ];
      st.index = 1; st.lastKey = null;
      const 记录FUTURE = st.stack[2];
      const 前身份 = 身份();
      // 真实造 dirty：文本域写坏 JSON → jsonEdited()（350ms 防抖）→ setJsonDirty(true, errors)
      area.value = "【T5R3 草稿 I】{ 故意写坏";
      window.jsonEdited();
      await 睡眠(460);
      const 草稿前 = area.value;
      const 条前 = 条文本(); const 见前 = 条可见();
      const 旗前 = window.__jsonSyncFlags();
      const 哨兵前 = 哨兵();
      o.dirty条已生成 = (条前 !== null) && /个错误/.test(条前 || "");
      o.dirty条可见 = 见前;
      o.失败前按钮可用 = 按钮是函数();
      o.失败前dirty = 旗前.dirty;

      window.doUndo();
      o.表 = 表(); o.栈长 = st.size(); o.索引 = st.index;
      o.游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.游标状态是实际当前 = !!(st.stack[st.index] && st.stack[st.index].state === window.__commitState());
      o.设计未变 = (身份() === 前身份);
      o.身份 = 身份();
      o.草稿未变 = (area.value === 草稿前);
      o.条文本未变 = (条文本() === 条前);
      o.条可见性未变 = (条可见() === 见前);
      o.徽标未变 = (window.__jsonSyncFlags().dirty === 旗前.dirty);
      o.错误数未变 = (window.__jsonSyncFlags().dirtyErrors === 旗前.dirtyErrors);
      o.失败后按钮仍可用 = 按钮是函数();
      o.哨兵未变 = (哨兵() === 哨兵前);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.计数文案 = cnt(); o.按钮 = btn(); o.提示 = toastEl();
      o.未误报全坏 = !/都坏了/.test(o.提示 || "");
      o.FUTURE原对象保留 = (st.stack[1] === 记录FUTURE);
      o.FUTURE原字节保留 = (st.stack[1] && st.stack[1].state === FUTURE);

      // ---- 反方向**真实重做** → FUTURE ----
      // ⚠️ 先"主动放弃"未应用的草稿（等价于真实点那个按钮的语义），
      //    否则下一步的 syncPreparedJson 会按设计覆盖文本域（那是既有 T6 行为，
      //    本卡不改）。这一步是**主动**的，不是自动合并/自动放弃。
      if (typeof window.discardJsonEdit === "function") window.discardJsonEdit();
      o.放弃后dirty = window.__jsonSyncFlags().dirty;
      o.放弃后条隐藏 = !条可见();
      window.doRedo();
      o.重做后身份 = 身份();
      o.重做后游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.重做后计数 = cnt(); o.重做后按钮 = btn();
      o.重做后canUndo = st.canUndo(); o.重做后canRedo = st.canRedo();

      // ---- 再**真实撤销** → 回到锚点（= 刚才那份实际当前设计）----
      window.doUndo();
      o.再撤销后身份 = 身份();
      o.再撤销后游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.再撤销后表 = 表(); o.再撤销后栈长 = st.size();
      o.哨兵仍未被丢 = (哨兵() === 哨兵前);
    });

    // ---- J：**真实入口**（对称方向）+ 反方向真实可达 ----
    await 病例("J·真实入口重做→撤销", function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: EARLIER, label: "EARLIER" },
        { state: 坏, label: "坏CURRENT" },
        { state: 坏, label: "坏AFTER" },
      ];
      st.index = 1; st.lastKey = null;
      const 记录EARLIER = st.stack[0];
      const 前身份 = 身份();
      window.doRedo();
      o.表 = 表(); o.栈长 = st.size(); o.索引 = st.index;
      o.游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.设计未变 = (身份() === 前身份);
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.计数文案 = cnt(); o.按钮 = btn(); o.提示 = toastEl();
      o.EARLIER原对象保留 = (st.stack[0] === 记录EARLIER);
      window.doUndo();
      o.撤销后身份 = 身份();
      o.撤销后游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.撤销后表 = 表();
    });

    // ---- K：当前记录坏 **且** 目标恢复也失败（真实 restore 在 draw 阶段抛）----
    await 病例("K·当前记录坏+目标恢复失败", function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: 坏, label: "坏BEFORE" },
        { state: 坏, label: "坏CURRENT" },
        { state: TARGET, label: "TARGET" },
        { state: FUTURE, label: "FUTURE" },
      ];
      st.index = 1; st.lastKey = null;
      const 记录FUTURE = st.stack[3];
      const 前身份 = 身份();
      const 真draw = window.draw;
      let 已抛 = false, draw次数 = 0;
      window.draw = function () {
        draw次数++;
        if (!已抛) { 已抛 = true; throw new Error("T5R3 注入：draw 阶段失败"); }
        return 真draw.apply(this, arguments);
      };
      let 抛了 = null;
      try { window.doRedo(); } catch (e) { 抛了 = String((e && e.message) || e); }
      window.draw = 真draw;
      o.抛了 = 抛了;
      o.表 = 表(); o.栈长 = st.size(); o.索引 = st.index;
      o.游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.设计未变 = (身份() === 前身份);
      o.身份 = 身份();
      o.canUndo = st.canUndo(); o.canRedo = st.canRedo();
      o.计数文案 = cnt(); o.按钮 = btn(); o.提示 = toastEl();
      o.未报成功 = !/已重做/.test(o.提示 || "");
      o.如实报失败 = /无法恢复/.test(o.提示 || "");
      o.TARGET已摘 = (表().indexOf("TARGET") < 0);
      o.FUTURE原对象保留 = (st.stack[1] === 记录FUTURE);
      o.draw次数 = draw次数;
      const fin = window.__lastRestoreFinish ? window.__lastRestoreFinish() : null;
      o.收尾画布已重画 = !!(fin && fin.canvas === true);
      // 反方向仍然真的能走
      window.doRedo();
      o.再重做后身份 = 身份();
      o.再重做后标签 = st.stack[st.index] ? st.stack[st.index].label : null;
    });

    // ---- L：连续坏条 + 连续失败（有限处理、不重复撞坏条、不丢有效历史）----
    await 病例("L·连续坏条+连续失败", function (o) {
      window.restoreSnapshot(CURRENT);
      st.stack = [
        { state: 坏, label: "坏1" },
        { state: 坏, label: "坏2" },
        { state: 坏, label: "坏CURRENT" },
        { state: FUTURE, label: "FUTURE" },
      ];
      st.index = 2; st.lastKey = null;
      const 前身份 = 身份();
      window.doUndo();
      o.表 = 表(); o.栈长 = st.size(); o.索引 = st.index;
      o.游标标签 = st.stack[st.index] ? st.stack[st.index].label : null;
      o.设计未变 = (身份() === 前身份);
      o.canRedo = st.canRedo(); o.计数文案 = cnt();
      o.提示 = toastEl();
      const 记录锚点 = st.stack[0];
      // 连续失败：让 draw **每次都真画一遍再抛**（持续异常）
      const 真draw = window.draw;
      let 次数 = 0;
      window.draw = function () { 次数++; 真draw.apply(this, arguments); throw new Error("T5R3 注入：持续失败"); };
      let 抛了1 = null, 抛了2 = null;
      try { window.doRedo(); } catch (e) { 抛了1 = String((e && e.message) || e); }
      const 状态1 = { 表: 表(), 栈长: st.size(), 索引: st.index };
      try { window.doRedo(); } catch (e) { 抛了2 = String((e && e.message) || e); }
      const 状态2 = { 表: 表(), 栈长: st.size(), 索引: st.index };
      window.draw = 真draw;
      o.抛了1 = 抛了1; o.抛了2 = 抛了2;
      o.状态1 = 状态1; o.状态2 = 状态2;
      o.第一次摘了FUTURE = (状态1.栈长 === 1);
      o.第二次没再摘 = (状态2.栈长 === 状态1.栈长) && (状态2.表 === 状态1.表);
      o.游标仍在锚点 = (st.stack[st.index] === 记录锚点);
      o.设计未变2 = (身份() === 前身份);
      o.画布收尾如实报失败 = (function () {
        const fin = window.__lastRestoreFinish ? window.__lastRestoreFinish() : null;
        return !!(fin && fin.canvas === false && fin.error);
      })();
    });

    // ---- 收尾：还原基准（测试收尾，不是产品行为）----
    st.reset(window.__commitState(), "收尾");
    st.lastKey = null;
    try { if (typeof window.discardJsonEdit === "function") window.discardJsonEdit(); } catch (e) { }
    if (area) area.value = "";
    try { window.restoreSnapshot(JSON.stringify({ d: 基准.d, sel: 基准.sel })); } catch (e) { }
    try { window.updateUndoButtons(); } catch (e) { }
    try { localStorage.removeItem(SENT); } catch (e) { }
    out.哨兵已清理 = (哨兵() === null);
    return JSON.stringify(out);
  })()`);
  const RR3 = JSON.parse(r3r1);
  console.log('    · ' + r3r1);
  ok(RR3.钩子, 'T5-R3 R1 用例拿到了测试钩子（__undoStack / __commitState / doUndo / doRedo）');
  if (!RR3.钩子) {
    ok(false, 'T5-R3 R1 用例缺测试钩子 —— 其余断言未执行（不静默跳过）');
  } else {
    const C3 = {};
    (RR3.病例 || []).forEach(function (c) { C3[c.名] = c; });
    ok(RR3.三份不同, 'T5-R3 R1 **三条快照是不同字符串**（不同设计名/节点值/选区）');
    eq((RR3.三份判可用 || []).join(','), 'true,true,true', 'T5-R3 R1 三条快照都是有效设计（判可用）');
    eq(RR3.坏记录判坏, false, 'T5-R3 R1 现场：占位记录**真的判坏**（不是"判据放行的坏条"）');
    eq(RR3.TARGET判可用, true, 'T5-R3 R1 现场：TARGET **判据判它可用**（K 例的失败发生在判据之后）');
    eq((RR3.病例 || []).length, 6, 'T5-R3 R1 六个病例都在（模型两方向 / 真实两方向 / 目标恢复失败 / 连续坏条）');

    const G = C3['G·模型结果(撤销方向)'];
    ok(!!G, 'T5-R3 R1[G] 病例存在');
    if (G) {
      eq(G.抛了, null, 'T5-R3 R1[G] 模型层不抛' + (G.抛了 ? '（抛了：' + G.抛了 + '）' : ''));
      eq(G.返回ok, false, 'T5-R3 R1[G] 模型层如实返回 `ok:false`（这一步没走成）');
      eq(G.removed, 2, 'T5-R3 R1[G] 只摘掉那**两条坏记录**');
      eq(G.usableLeft, 2, 'T5-R3 R1[G] `usableLeft=2`（锚点 + FUTURE）：**不是整栈全坏**，所以既不清栈也不硬指');
      eq(G.curRemoved, true, 'T5-R3 R1[G] 模型层明确报告"当前记录自己被摘掉了"');
      eq(G.anchorAt, 0, 'T5-R3 R1[G] 🔴 **锚点位置 = 0**（当前记录原来的位置前面没有活着的记录）');
      eq(G.有锚点, true, 'T5-R3 R1[G] 🔴 **为实际当前设计补了一条有效锚点**（不是就近硬指好记录）');
      eq(G.锚点标签, '当前设计', 'T5-R3 R1[G] 锚点标签：' + G.锚点标签);
      eq(G.锚点就是实际当前设计, true, 'T5-R3 R1[G] 🔴 锚点的 state **就是画布此刻的真实设计**');
      eq(G.表, '当前设计|FUTURE', 'T5-R3 R1[G] 栈变成「锚点 + FUTURE」：' + G.表);
      eq(G.栈长, 2, 'T5-R3 R1[G] 栈长 2（3 条里只少了那两条坏的）');
      eq(G.索引, 0, 'T5-R3 R1[G] 🔴 游标落在锚点（0），**不是删除前的 1**');
      eq(G.游标是锚点, true, 'T5-R3 R1[G] 🔴 游标**就是**那条锚点记录（对象身份）');
      eq(G.FUTURE原对象保留, true, 'T5-R3 R1[G] 🔴 FUTURE 是**原来那个记录对象**（字节与顺序都没动）');
      eq(G.FUTURE原字节保留, true, 'T5-R3 R1[G] FUTURE 的 state 逐字节相同');
      eq(G.lastKey归位, true, 'T5-R3 R1[G] `lastKey` 归位为 null');
      eq(G.canUndo, false, 'T5-R3 R1[G] `canUndo=false`（锚点已在栈底）');
      eq(G.canRedo, true, 'T5-R3 R1[G] 🔴 **`canRedo=true`**（FUTURE 真的可达）');
      eq(G.设计未变, true, 'T5-R3 R1[G] 模型层不碰设计：' + G.身份);
    }

    const H = C3['H·模型结果(重做方向)'];
    ok(!!H, 'T5-R3 R1[H] 病例存在');
    if (H) {
      eq(H.抛了, null, 'T5-R3 R1[H] 模型层不抛' + (H.抛了 ? '（抛了：' + H.抛了 + '）' : ''));
      eq(H.返回ok, false, 'T5-R3 R1[H] 模型层如实返回 `ok:false`');
      eq(H.removed, 2, 'T5-R3 R1[H] 只摘掉两条坏记录');
      eq(H.usableLeft, 2, 'T5-R3 R1[H] `usableLeft=2`（EARLIER + 锚点）：反方向还在');
      eq(H.curRemoved, true, 'T5-R3 R1[H] 当前记录自己被摘掉');
      eq(H.anchorAt, 1, 'T5-R3 R1[H] 🔴 **锚点位置 = 1**（EARLIER 还在它前面，必须排在后面）');
      eq(H.有锚点, true, 'T5-R3 R1[H] 🔴 补了一条有效锚点');
      eq(H.锚点就是实际当前设计, true, 'T5-R3 R1[H] 锚点 state 就是画布此刻的真实设计');
      eq(H.表, 'EARLIER|当前设计', 'T5-R3 R1[H] 栈变成「EARLIER + 锚点」：' + H.表);
      eq(H.栈长, 2, 'T5-R3 R1[H] 栈长 2');
      eq(H.索引, 1, 'T5-R3 R1[H] 🔴 游标落在锚点（1）');
      eq(H.游标是锚点, true, 'T5-R3 R1[H] 游标就是那条锚点记录');
      eq(H.EARLIER原对象保留, true, 'T5-R3 R1[H] 🔴 EARLIER 是原来那个记录对象');
      eq(H.EARLIER原字节保留, true, 'T5-R3 R1[H] EARLIER 的 state 逐字节相同');
      eq(H.lastKey归位, true, 'T5-R3 R1[H] `lastKey` 归位');
      eq(H.canUndo, true, 'T5-R3 R1[H] 🔴 **`canUndo=true`**（EARLIER 真的可达）');
      eq(H.canRedo, false, 'T5-R3 R1[H] `canRedo=false`');
      eq(H.设计未变, true, 'T5-R3 R1[H] 模型层不碰设计：' + H.身份);
    }

    const I = C3['I·真实入口撤销→重做→撤销'];
    ok(!!I, 'T5-R3 R1[I] 病例存在');
    if (I) {
      eq(I.抛了, null, 'T5-R3 R1[I] 真实 `doUndo` 不抛' + (I.抛了 ? '（抛了：' + I.抛了 + '）' : ''));
      eq(I.dirty条已生成, true, 'T5-R3 R1[I] 现场：**真实 `jsonEdited()` 造出了 dirty 提示条**（含错误数）');
      eq(I.dirty条可见, true, 'T5-R3 R1[I] 现场：dirty 提示条**可见**');
      eq(I.失败前dirty, true, 'T5-R3 R1[I] 现场：`jsonDirty` 为真（草稿有错未生效）');
      eq(I.失败前按钮可用, true, 'T5-R3 R1[I] 现场："放弃 JSON 改动"按钮**可用**（onclick 是函数）');
      eq(I.表, '当前设计|FUTURE', 'T5-R3 R1[I] 坏条摘掉、锚点补上：' + I.表);
      eq(I.栈长, 2, 'T5-R3 R1[I] 栈长 2');
      eq(I.索引, 0, 'T5-R3 R1[I] 🔴 游标 0（代表实际当前设计）');
      eq(I.游标标签, '当前设计', 'T5-R3 R1[I] 游标标签：' + I.游标标签);
      eq(I.游标状态是实际当前, true, 'T5-R3 R1[I] 🔴 游标指向的记录 state **就是当前设计的快照**');
      eq(I.设计未变, true, 'T5-R3 R1[I] 这一步没走成 → **设计一个字节都没变**：' + I.身份);
      eq(I.草稿未变, true, 'T5-R3 R1[I] 🔴 **未应用的 dirty 草稿没被覆盖**');
      eq(I.条文本未变, true, 'T5-R3 R1[I] 🔴 dirty 提示条**文本逐字未变**');
      eq(I.条可见性未变, true, 'T5-R3 R1[I] dirty 提示条**可见性未变**');
      eq(I.徽标未变, true, 'T5-R3 R1[I] `jsonDirty` 标志未变');
      eq(I.错误数未变, true, 'T5-R3 R1[I] **错误条数未变**');
      eq(I.失败后按钮仍可用, true, 'T5-R3 R1[I] 🔴 失败之后按钮**仍然可用**（事件没丢）');
      eq(I.哨兵未变, true, 'T5-R3 R1[I] 🔴 **localStorage 哨兵未变**');
      eq(I.canUndo, false, 'T5-R3 R1[I] `canUndo=false`');
      eq(I.canRedo, true, 'T5-R3 R1[I] 🔴 **`canRedo=true`**（FUTURE 真的还能走）');
      eq(I.计数文案, '0 / 1', 'T5-R3 R1[I] 计数 0 / 1：' + I.计数文案);
      eq(I.按钮, '灰/可', 'T5-R3 R1[I] 按钮与 canUndo/canRedo 一致：' + I.按钮);
      eq(I.未误报全坏, true, 'T5-R3 R1[I] 🔴 **不许把混合栈报成"都坏了"**：' + (I.提示 || '(空)'));
      eq(I.FUTURE原对象保留, true, 'T5-R3 R1[I] FUTURE 原记录对象保留');
      eq(I.FUTURE原字节保留, true, 'T5-R3 R1[I] FUTURE 字节未变');
      eq(I.放弃后dirty, false, 'T5-R3 R1[I] **主动**放弃草稿后 dirty 归 false（用户自己点的语义）');
      eq(I.放弃后条隐藏, true, 'T5-R3 R1[I] 主动放弃后提示条隐藏');
      eq(I.重做后身份, 'FUTURE|33|n-FUTURE', 'T5-R3 R1[I] 🔴 **真实重做走到了 FUTURE**：' + I.重做后身份);
      eq(I.重做后canRedo, false, 'T5-R3 R1[I] 重做到顶后 `canRedo=false`');
      eq(I.重做后canUndo, true, 'T5-R3 R1[I] 重做到顶后 `canUndo=true`');
      eq(I.再撤销后身份, 'CURRENT|22|n-CURRENT', 'T5-R3 R1[I] 🔴 再真实撤销**回到刚才那份实际当前设计**：' + I.再撤销后身份);
      eq(I.再撤销后表, '当前设计|FUTURE', 'T5-R3 R1[I] 顺序与有效历史全程保留：' + I.再撤销后表);
      eq(I.哨兵仍未被丢, true, 'T5-R3 R1[I] 全程 localStorage 哨兵都在');
    }

    const J = C3['J·真实入口重做→撤销'];
    ok(!!J, 'T5-R3 R1[J] 病例存在');
    if (J) {
      eq(J.抛了, null, 'T5-R3 R1[J] 真实 `doRedo` 不抛' + (J.抛了 ? '（抛了：' + J.抛了 + '）' : ''));
      eq(J.表, 'EARLIER|当前设计', 'T5-R3 R1[J] 对称方向：' + J.表);
      eq(J.栈长, 2, 'T5-R3 R1[J] 栈长 2');
      eq(J.索引, 1, 'T5-R3 R1[J] 🔴 游标 1');
      eq(J.游标标签, '当前设计', 'T5-R3 R1[J] 游标标签：' + J.游标标签);
      eq(J.设计未变, true, 'T5-R3 R1[J] 设计一个字节都没变');
      eq(J.canUndo, true, 'T5-R3 R1[J] 🔴 **`canUndo=true`**（EARLIER 真的还能走）');
      eq(J.canRedo, false, 'T5-R3 R1[J] `canRedo=false`');
      eq(J.计数文案, '1 / 1', 'T5-R3 R1[J] 计数 1 / 1：' + J.计数文案);
      eq(J.按钮, '可/灰', 'T5-R3 R1[J] 按钮与 canUndo/canRedo 一致：' + J.按钮);
      eq(J.EARLIER原对象保留, true, 'T5-R3 R1[J] EARLIER 原记录对象保留');
      eq(J.撤销后身份, 'EARLIER|11|n-EARLIER', 'T5-R3 R1[J] 🔴 **真实撤销走到了 EARLIER**：' + J.撤销后身份);
      eq(J.撤销后表, 'EARLIER|当前设计', 'T5-R3 R1[J] 撤销后有效历史仍在：' + J.撤销后表);
    }

    const K = C3['K·当前记录坏+目标恢复失败'];
    ok(!!K, 'T5-R3 R1[K] 病例存在');
    if (K) {
      eq(K.抛了, null, 'T5-R3 R1[K] 目标恢复也失败时**不抛异常**' + (K.抛了 ? '（抛了：' + K.抛了 + '）' : ''));
      eq(K.设计未变, true, 'T5-R3 R1[K] 实际设计仍是 CURRENT：' + K.身份);
      eq(K.表, '当前设计|FUTURE', 'T5-R3 R1[K] 🔴 摘掉 TARGET 之后**给实际当前设计补了锚点**，FUTURE 保留：' + K.表);
      eq(K.栈长, 2, 'T5-R3 R1[K] 栈长 2');
      eq(K.索引, 0, 'T5-R3 R1[K] 🔴 游标 0（不是夹取出来的 1 → FUTURE）');
      eq(K.游标标签, '当前设计', 'T5-R3 R1[K] 游标标签：' + K.游标标签);
      eq(K.canRedo, true, 'T5-R3 R1[K] 🔴 `canRedo=true`：FUTURE 仍然可达');
      eq(K.计数文案, '0 / 1', 'T5-R3 R1[K] 计数 0 / 1：' + K.计数文案);
      eq(K.按钮, '灰/可', 'T5-R3 R1[K] 按钮一致：' + K.按钮);
      eq(K.未报成功, true, 'T5-R3 R1[K] 🔴 **失败不报成功**');
      eq(K.如实报失败, true, 'T5-R3 R1[K] 如实报"这一步的记录无法恢复"：' + (K.提示 || ''));
      eq(K.TARGET已摘, true, 'T5-R3 R1[K] TARGET 那条确实被摘掉了');
      eq(K.FUTURE原对象保留, true, 'T5-R3 R1[K] FUTURE 原记录对象保留');
      eq(K.收尾画布已重画, true, 'T5-R3 R1[K] 失败收尾**按实际设计重画了画布**（R3 的像素回滚）');
      eq(K.再重做后身份, 'FUTURE|33|n-FUTURE', 'T5-R3 R1[K] 🔴 之后真实重做真的到 FUTURE：' + K.再重做后身份);
    }

    const L = C3['L·连续坏条+连续失败'];
    ok(!!L, 'T5-R3 R1[L] 病例存在');
    if (L) {
      eq(L.抛了, null, 'T5-R3 R1[L] 连续失败也**不抛异常**' + (L.抛了 ? '（抛了：' + L.抛了 + '）' : ''));
      eq(L.抛了1, null, 'T5-R3 R1[L] 第一次失败不抛' + (L.抛了1 ? '（抛了：' + L.抛了1 + '）' : ''));
      eq(L.抛了2, null, 'T5-R3 R1[L] 第二次失败也不抛' + (L.抛了2 ? '（抛了：' + L.抛了2 + '）' : ''));
      eq(L.表, '当前设计|FUTURE', 'T5-R3 R1[L] 🔴 一次撤销穿过**两条连续坏条** + 当前坏记录，只留锚点与 FUTURE：' + L.表);
      eq(L.栈长, 2, 'T5-R3 R1[L] 栈长 2');
      eq(L.索引, 0, 'T5-R3 R1[L] 游标 0');
      eq(L.游标标签, '当前设计', 'T5-R3 R1[L] 游标标签：' + L.游标标签);
      eq(L.设计未变, true, 'T5-R3 R1[L] 设计未变');
      eq(L.canRedo, true, 'T5-R3 R1[L] `canRedo=true`');
      eq(L.计数文案, '0 / 1', 'T5-R3 R1[L] 计数 0 / 1：' + L.计数文案);
      eq(L.第一次摘了FUTURE, true, 'T5-R3 R1[L] 🔴 第一次失败只摘掉 FUTURE 那一条：' + JSON.stringify(L.状态1));
      eq(L.第二次没再摘, true, 'T5-R3 R1[L] 🔴 **第二次按不再反复摘**（栈与表都不动）：' + JSON.stringify(L.状态2));
      eq(L.游标仍在锚点, true, 'T5-R3 R1[L] 连续失败后游标仍在**实际当前设计**上');
      eq(L.设计未变2, true, 'T5-R3 R1[L] 连续失败后设计仍未变');
      eq(L.画布收尾如实报失败, true, 'T5-R3 R1[L] 🔴 持续异常时**如实记录"画布没重画成功"**（不谎报已复原）');
    }

    eq(RR3.哨兵已清理, true, 'T5-R3 R1 收尾：测试自己留下的 localStorage 哨兵已清理');
  }

  // ================================================================ T5-R2 · R2（P1/P2）· 覆盖**校验至刷新的完整失败现场**
  //
  // ## 规划方实测的两个反例
  //
  //  1. 让**真实** `window.draw` 抛一次：`restore` 返回 false、design/selection
  //     引用与草稿/dirty 保留 —— 但 **`mName` 仍显示 TARGET**、
  //     **dirty 提示从"1 个错误"变成"0 个错误"**、redo 游标还错位；
  //  2. **10000 层 `children` 的可解析 JSON** 在 `snapshotProblem`/`nodeProblem`
  //     里抛 `Maximum call stack size exceeded`，而且发生在事务 `try` **之外**。
  //
  // ## 这一段验什么
  //
  //  · **三个注入阶段各一例**：prepare（`toV2Json`）/ 同步写入（DOM setter）/
  //    refresh·draw（`window.draw`）。逐例都用**有效设计 + 非空选区 +
  //    dirty JSON 草稿 + 原错误提示 + 存储哨兵**；
  //  · 失败返回 `false` 且**不抛**；**逐字段 / 逐引用**检查
  //    （design 引用、selection 引用、JSON 文本、**元数据表单每个字段**、
  //     dirty 提示条整段 HTML、localStorage 哨兵）—— **不是事后人工复位**；
  //  · 异常收尾本身不得再抛；`suppressJsonSync` **归位**（有直接取样钩子）；
  //  · 失败之后**真实 JSON 编辑 / 正常恢复 / 撤销重做继续工作**；
  //  · 深快照：共用判据安全返回 `boolean`、`restore` 返回 `false` 且不抛。
  console.log('\n=== T5-R2 · R2：完整失败现场（逐阶段注入）===');

  // ---- 现场准备：有效设计 + 非空选区 + dirty 草稿 + dirty 提示条落地 ----
  const r2setup = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    out.钩子 = (typeof window.restoreSnapshot === "function")
      && (typeof window.isUsableSnapshot === "function")
      && (typeof window.__jsonSyncFlags === "function")
      && (typeof window.toV2Json === "function");
    const area = document.getElementById("jsonArea");
    out.有现场 = !!area;
    if (!out.钩子 || !area) return JSON.stringify(out);
    // 先让元数据表单与**真实设计**同步（不然"回滚是否复原表单"没有基线）
    try { if (typeof window.syncJson === "function") window.syncJson(); } catch (e) { out.syncJson抛了 = String(e && e.message); }
    // 非空选区：没有节点就**先造一个**（验收明确要求"有效设计 + 非空选区"，
    // 不能因为上一段把设计弄空了就静默降级成空选区）
    let first = S.design.nodes[0];
    if (!first && window.createNode) {
      first = window.createNode(window.NODE_TEXT, { name: "R2探针", x: 7, y: 7, w: 30, h: 12 });
      S.design.nodes.push(first);
    }
    if (first) { S.selection = [first.id]; window.onSelectionChanged(); }
    out.选区非空 = S.selection.length > 0;
    out.有节点 = !!first;
    // dirty 草稿 + 真实入口（异步 350ms）→ 会生成 dirty 提示条
    window.__T5R2_DRAFT = "【未应用的 JSON 草稿 T5R2-R2】{ 故意写坏";
    area.value = window.__T5R2_DRAFT;
    window.jsonEdited();
    return JSON.stringify(out);
  })()`);
  const R2S = JSON.parse(r2setup);
  await sleep(520);

  const r2i = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    const area = document.getElementById("jsonArea");
    const bar = function () { return document.getElementById("jsonDirtyBar"); };
    const barHTML = function () { const b = bar(); return b ? b.innerHTML : null; };
    const barDisp = function () { const b = bar(); return b ? b.style.display : null; };
    const FIDS = ["mName", "mAuthor", "mDesc", "mTheme", "dW", "dH",
      "scaleMode", "bgPath", "bgFit", "bgW", "bgH"];
    const formSnap = function () {
      const o = {};
      FIDS.forEach(function (id) { const e = document.getElementById(id); o[id] = e ? e.value : null; });
      return o;
    };
    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const SENT = "t5r2-sentinel";
    try { localStorage.setItem(SENT, "哨兵值"); } catch (e) { out.存储不可用 = String(e && e.message); }
    const sentOf = function () { try { return localStorage.getItem(SENT); } catch (e) { return null; } };

    out.现场 = {
      dirty: !!(area && area.classList.contains("dirty")),
      dirty条在: !!bar(),
      dirty条可见: barDisp() !== "none",
      dirty条含错误数: /个错误/.test(barHTML() || ""),
      dirty条错误数: (function () { const m = (barHTML() || "").match(/有\\s*(\\d+)\\s*个错误/); return m ? Number(m[1]) : null; })(),
      选区非空: S.selection.length > 0,
      草稿在: !!(area && area.value === window.__T5R2_DRAFT),
      toV2Json是函数: (typeof window.toV2Json === "function"),
    };
    out.原表单 = formSnap();
    out.原设计名 = S.design ? S.design.name : null;
    out.哨兵前 = sentOf();

    out.病例 = [];
    const 病例 = function (名, fn) {
      const o = { 名: 名, 抛了: null };
      try { fn(o); } catch (e) { o.抛了 = String((e && e.message) || e); }
      out.病例.push(o);
    };

    // 注入用的"修复后"快照：把设计名改成 TARGET（失败时表单会先被写成 TARGET）
    const 目标快照 = function () {
      const d = JSON.parse(JSON.stringify(S.design));
      d.name = "TARGET";
      return JSON.stringify({ d: d, sel: S.selection.slice() });
    };
    // 每例的公共检查：逐字段 / 逐引用
    const 检查 = function (o, 注入前) {
      o.设计引用未变 = (S.design === 注入前.designRef);
      o.选区引用未变 = (S.selection === 注入前.selRef);
      o.JSON文本未变 = (area ? area.value === 注入前.jsonText : true);
      o.表单未变 = JSON.stringify(formSnap()) === JSON.stringify(注入前.form);
      o.dirty条未变 = (barHTML() === 注入前.barHTML);
      o.dirty条可见性未变 = (barDisp() === 注入前.barDisp);
      o.dirty标志未变 = (window.__jsonSyncFlags().dirty === 注入前.dirtyFlag);
      o.dirty错误数未变 = (window.__jsonSyncFlags().dirtyErrors === 注入前.dirtyErrors);
      o.哨兵未变 = (sentOf() === 注入前.sent);
      o.suppress归位 = (window.__jsonSyncFlags().suppress === false);
      o.mName不是TARGET = ((document.getElementById("mName") || {}).value !== "TARGET");
      o.设计名不是TARGET = (S.design && S.design.name !== "TARGET");
      o.未报成功 = !/已撤销|已重做/.test(toastEl() || "");
    };
    const 拍照 = function () {
      return {
        designRef: S.design, selRef: S.selection,
        jsonText: area ? area.value : null,
        form: formSnap(),
        barHTML: barHTML(), barDisp: barDisp(),
        dirtyFlag: window.__jsonSyncFlags().dirty,
        dirtyErrors: window.__jsonSyncFlags().dirtyErrors,
        sent: sentOf(),
      };
    };

    // ---- 注入 ①：prepare 阶段（「toV2Json」 在 restore 内部抛）----
    病例("①·prepare(toV2Json)异常", function (o) {
      const 真 = window.toV2Json;
      const 前 = 拍照();
      let 抛了 = null, 返回 = null;
      window.toV2Json = function () { throw new Error("T5R2 注入：prepare 阶段失败"); };
      try { 返回 = window.restoreSnapshot(目标快照()); } catch (e) { 抛了 = String((e && e.message) || e); }
      window.toV2Json = 真;
      o.返回 = 返回; o.抛了 = 抛了;
      检查(o, 前);
      o.表单还是原设计 = JSON.stringify(formSnap()) === JSON.stringify(前.form);
    });

    // ---- 注入 ②：**同步写入**阶段（DOM 「value」 setter 在写 #mAuthor 时抛）----
    //
    // 这一例命中 「syncPreparedJson」：JSON 文本域**已经被写**、元数据表单写到
    // 一半才炸 —— 正是规划方"mName 仍显示 TARGET"那条反例的位置。
    病例("②·同步写入阶段异常", function (o) {
      const el0 = document.getElementById("mAuthor");
      const proto = el0 ? Object.getPrototypeOf(el0) : null;
      const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      const 前 = 拍照();
      let 抛了 = null, 返回 = null;
      if (!desc) { o.跳过 = "拿不到 value 描述符"; return; }
      Object.defineProperty(proto, "value", {
        configurable: true, enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          if (this && this.id === "mAuthor") throw new Error("T5R2 注入：同步写入阶段失败");
          return desc.set.call(this, v);
        },
      });
      // ⚠️ 用 try/finally 保证**原型一定还原** —— 注入本身会抛，
      //    而"抛出来的那一次"正是我们要验的行为，不是脚本错误。
      try {
        try { 返回 = window.restoreSnapshot(目标快照()); } catch (e) { 抛了 = String((e && e.message) || e); }
      } finally {
        Object.defineProperty(proto, "value", desc);
      }
      o.返回 = 返回; o.抛了 = 抛了;
      检查(o, 前);
      o.原型已还原 = (Object.getOwnPropertyDescriptor(proto, "value").set === desc.set);
    });

    // ---- 注入 ③：refresh·draw 阶段（真实 「window.draw」 抛一次）----
    病例("③·refresh(draw)阶段异常", function (o) {
      const 真 = window.draw;
      const 前 = 拍照();
      let 抛了 = null, 返回 = null, 已抛 = false;
      window.draw = function () {
        if (!已抛) { 已抛 = true; throw new Error("T5R2 注入：refresh/draw 阶段失败"); }
        return 真.apply(this, arguments);
      };
      try { 返回 = window.restoreSnapshot(目标快照()); } catch (e) { 抛了 = String((e && e.message) || e); }
      window.draw = 真;
      o.返回 = 返回; o.抛了 = 抛了;
      检查(o, 前);
      o.提示 = toastEl();
    });

    // ---- 注入 ③b：**连续多次失败**不反复撞同条、不凭空丢好历史 ----
    病例("③b·连续多次失败", function (o) {
      const 真 = window.draw;
      const st = window.__undoStack;
      // 摆一个**好栈**：[A, CURRENT, FUTURE]，游标在 1（CURRENT）
      const A = JSON.stringify({ d: { name: "A", nodes: [] }, sel: [] });
      const CUR = JSON.stringify({ d: { name: "CUR", nodes: [] }, sel: [] });
      const FUT = JSON.stringify({ d: { name: "FUT", nodes: [] }, sel: [] });
      window.restoreSnapshot(CUR);
      st.stack = [{ state: A, label: "A" }, { state: CUR, label: "CUR" }, { state: FUT, label: "FUT" }];
      st.index = 1; st.lastKey = null;
      const 当前记录 = st.stack[1];
      // 让 draw **每次都抛**
      window.draw = function () { throw new Error("T5R2 注入：连续失败"); };
      let 抛了 = null;
      try { window.doRedo(); } catch (e) { 抛了 = String((e && e.message) || e); }
      const 状态1 = { 表: st.stack.map(function (i) { return i.label; }).join("|"), 索引: st.index, 栈长: st.size() };
      try { window.doRedo(); } catch (e) { 抛了 = 抛了 || String((e && e.message) || e); }
      const 状态2 = { 表: st.stack.map(function (i) { return i.label; }).join("|"), 索引: st.index, 栈长: st.size() };
      window.draw = 真;
      o.抛了 = 抛了;
      o.状态1 = 状态1; o.状态2 = 状态2;
      o.第一次摘了1条 = (状态1.栈长 === 2);
      o.第二次没再摘 = (状态2.栈长 === 状态1.栈长);
      o.好历史还在 = (状态1.表.indexOf("A") >= 0) && (状态2.表.indexOf("A") >= 0);
      o.游标仍在当前记录 = (st.stack[st.index] === 当前记录);
      o.设计未变 = (S.design && S.design.name === "CUR");
      // 收尾：还一个能用的栈
      st.reset(window.__commitState(), "收尾");
    });

    // ---- 注入 ⑤：「restore」 对**解析/判据/准备**异常一律 false 且不抛 ----
    //
    // 🎯 验收第 3 条。这跟"判据说这条快照坏"是两件事：**判据/解析自己出意外**
    //    （宿主环境的怪东西、引擎的爆栈/内存上限）时，异常绝不许冒到调用方。
    //
    // ## ⚠️ 如实说明一条边界：真机字符串输入下"判据抛"造不出来
    //
    // 快照是**字符串**，「JSON.parse」 出来的必然是**纯数据** —— 纯数据上放不出
    // "会抛的取值器"。判据真正会抛的现实来源是**引擎自己**（爆栈 / 内存），
    // 那是**不可确定性复现**的。所以这里不假装造它，而是验"判据的输入守门"与
    // "解析失败"这两条**可确定性复现**的路：
    //  · (a) 非字符串输入（「null」 / 「undefined」 / 数字 / 对象 / 数组 / 空串）
    //        —— 判据必须**安全返回 boolean false**，不许把异常放出去；
    //  · (b) 解析失败（截断 JSON / 不是 JSON）
    //        —— 「restoreSnapshot」 必须 false 且不抛；
    //  · (c) 深快照（解析后结构合法但超出预算）—— 见注入 ④。
    病例("⑤·解析/判据异常安全", function (o) {
      const 目标 = 拍照();
      // (a) 判据对各种**非字符串**输入都要安全返回 boolean
      const 怪输入 = [
        { 名: "null", v: null },
        { 名: "undefined", v: undefined },
        { 名: "数字", v: 12345 },
        { 名: "对象", v: { d: { nodes: [] } } },
        { 名: "数组", v: [{ d: { nodes: [] } }] },
        { 名: "空串", v: "" },
      ];
      const 判据 = {};
      怪输入.forEach(function (it) {
        let r = null, 类型 = null, 抛了 = null;
        try { r = window.isUsableSnapshot(it.v); 类型 = typeof r; }
        catch (e) { 抛了 = String((e && e.message) || e); }
        判据[it.名] = { 值: r, 类型: 类型, 抛了: 抛了 };
      });
      o.判据 = 判据;
      o.判据全部安全 = Object.keys(判据).every(function (k) {
        return 判据[k].抛了 === null && 判据[k].类型 === "boolean" && 判据[k].值 === false;
      });

      // (b) 「restoreSnapshot」 对解析失败的输入必须 false 且不抛
      const 坏输入 = [
        { 名: "截断JSON", v: "{'d':{'nodes':[" },
        { 名: "不是JSON", v: "这根本不是 JSON" },
        { 名: "null", v: null },
        { 名: "数字", v: 42 },
        { 名: "空串", v: "" },
      ];
      const 恢复 = {};
      坏输入.forEach(function (it) {
        let r = null, 抛了 = null;
        try { r = window.restoreSnapshot(it.v); } catch (e) { 抛了 = String((e && e.message) || e); }
        恢复[it.名] = { 返回: r, 抛了: 抛了 };
      });
      o.恢复 = 恢复;
      o.恢复全部false不抛 = Object.keys(恢复).every(function (k) {
        return 恢复[k].抛了 === null && 恢复[k].返回 === false;
      });

      o.设计引用未变 = (S.design === 目标.designRef);
      o.选区引用未变 = (S.selection === 目标.selRef);
      o.JSON文本未变 = (area ? area.value === 目标.jsonText : true);
      o.表单未变 = JSON.stringify(formSnap()) === JSON.stringify(目标.form);
      o.dirty条未变 = (barHTML() === 目标.barHTML);
      o.suppress归位 = (window.__jsonSyncFlags().suppress === false);
    });

    // ---- 注入 ③c：失败之后**真实 JSON 编辑 / 正常恢复 / 撤销重做继续工作** ----
    //
    // 🎯 验收第 2 条后半句：不仅"回滚干净"，还要"回滚没把功能弄坏"。
    //    所以这里走**真实入口**：「jsonEdited()」（文本域 → 画布，异步 350ms）
    //    与「doUndo()」，并断言它们真的改了设计。
    病例("③c·失败后功能仍工作", function (o) {
      const 真 = window.draw;
      const 前 = 拍照();
      let 已抛 = false;
      window.draw = function () {
        if (!已抛) { 已抛 = true; throw new Error("T5R2 注入：刷新阶段失败"); }
        return 真.apply(this, arguments);
      };
      let 返回 = null;
      try { 返回 = window.restoreSnapshot(目标快照()); } catch (e) { o.抛了 = String((e && e.message) || e); }
      window.draw = 真;
      o.返回 = 返回;
      检查(o, 前);
      // ⚠️ "真实 JSON 编辑 / 撤销 / 恢复"**不在这一段里跑**：「jsonEdited()」
      //    是异步（350ms）的，而这一段后面还有别的病例会往文本域里写东西 →
      //    防抖拍到的是**别人留下的文本**（实测就是深嵌套那一例）。
      //    所以放到本段 eval 之后、单独一拍里跑（见下面的 R2C）。
    });

    // ---- 深嵌套：共用判据必须**安全返回 boolean**，restore 返回 false 且不抛 ----
    病例("④·10000层children", function (o) {
      const 深 = function (depth) {
        let inner = { id: "leaf", type: "text", text: "x", x: 0, y: 0, w: 10, h: 10 };
        for (let i = 0; i < depth; i++) {
          inner = { id: "g" + i, type: "group", x: 0, y: 0, w: 10, h: 10, children: [inner] };
        }
        return JSON.stringify({ d: { name: "深", nodes: [inner] }, sel: [] });
      };
      const 深快照 = 深(10000);
      o.快照长度 = 深快照.length;
      // (a) 判据：必须返回 boolean，且不抛
      let 判据 = null, 判据抛了 = null, 判据类型 = null;
      try { 判据 = window.isUsableSnapshot(深快照); 判据类型 = typeof 判据; }
      catch (e) { 判据抛了 = String((e && e.message) || e); }
      o.判据 = 判据; o.判据类型 = 判据类型; o.判据抛了 = 判据抛了;
      // (b) restore：必须 false 且不抛（解析/判据/准备三处异常都不许冒出去）
      const 前 = 拍照();
      let 返回 = null, 抛了 = null;
      try { 返回 = window.restoreSnapshot(深快照); } catch (e) { 抛了 = String((e && e.message) || e); }
      o.返回 = 返回; o.抛了 = 抛了;
      检查(o, 前);
      // (c) 走真实入口（doUndo）也不抛，并按"这条不可用"处理
      const st = window.__undoStack;
      st.stack = [{ state: window.__commitState(), label: "当前" }, { state: 深快照, label: "深" }];
      st.index = 1; st.lastKey = null;
      const 真st = st.index;
      let 入口抛了 = null;
      try { window.doUndo(); } catch (e) { 入口抛了 = String((e && e.message) || e); }
      o.入口抛了 = 入口抛了;
      o.入口后表 = st.stack.map(function (i) { return window.isUsableSnapshot(i.state) ? "+" : "-"; }).join("");
      o.入口后栈长 = st.size();
      // (d) 合法深度**不许被误伤**
      const 合法 = 深(10);
      let 合法返回 = null, 合法抛了 = null;
      try { 合法返回 = window.restoreSnapshot(合法); } catch (e) { 合法抛了 = String((e && e.message) || e); }
      o.合法判可用 = window.isUsableSnapshot(合法);
      o.合法返回 = 合法返回; o.合法抛了 = 合法抛了;
      o.合法身份 = (S.design ? S.design.name : null);
      st.reset(window.__commitState(), "收尾");
    });

    // ---- 收尾：恢复真实设计，供下一段用 ----
    try { window.restoreSnapshot(JSON.stringify({ d: S.design, sel: S.selection.slice() })); } catch (e) { }
    try { localStorage.removeItem(SENT); } catch (e) { }
    return JSON.stringify(out);
  })()`);
  const R2I = JSON.parse(r2i);

  // ---- ③c（第二拍）：失败之后的**真实**功能回归 ----
  //
  // 🎯 验收第 2 条：失败之后**真实 JSON 编辑 / 正常恢复 / 撤销重做继续工作**。
  //    ⚠️ 单独一拍：`jsonEdited()` 是异步（350ms）入口，必须等它真的提交完
  //    再看结果，不能和别的往文本域写东西的病例挤在同一段里。
  const r2cPre = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const area = document.getElementById("jsonArea");
    const o = { 编辑前名字: S.design ? S.design.name : null };
    o.suppress前 = window.__jsonSyncFlags().suppress;
    const 名 = "R2失败后JSON-" + Date.now();
    const 文本 = JSON.stringify({
      schema: "icar.ui/2",
      canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 },
      meta: { name: 名 },
      assets: [], controls: [], pages: [],
      nodes: [{ id: "jj", type: "text", name: "jj", text: "jj", x: 5, y: 5, w: 10, h: 10 }],
    });
    area.value = 文本;
    window.jsonEdited();
    o.JSON名字 = 名;
    // ⚠️ 把"编辑前后"挂在页面全局上：下一拍（异步提交之后）在页面里取回，
    //    不往模板字符串里插值（避免占位符语法被当成真的模板插值）。
    window.__T5R2_JSONNAME = 名;
    window.__T5R2_JSONBEFORE = o.编辑前名字;
    return JSON.stringify(o);
  })()`);
  const R2CP = JSON.parse(r2cPre);
  await sleep(520);
  const r2c2 = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const o = {};
    o.JSON名字 = window.__T5R2_JSONNAME;
    o.编辑前名字 = window.__T5R2_JSONBEFORE;
    o.JSON编辑生效 = (S.design && S.design.name === o.JSON名字);
    o.编辑后名字 = S.design ? S.design.name : null;
    // 真实撤销：必须回到编辑之前那份设计
    try { window.doUndo(); } catch (e) { o.撤销抛了 = String((e && e.message) || e); }
    o.撤销后名字 = S.design ? S.design.name : null;
    o.撤销回到了编辑前 = (o.撤销后名字 === o.编辑前名字);
    o.撤销后设计可用 = !!(S.design && Array.isArray(S.design.nodes));
    // 真实恢复仍然成功
    let 恢复 = null, 恢复抛了 = null;
    try { 恢复 = window.restoreSnapshot(JSON.stringify({ d: S.design, sel: S.selection.slice() })); }
    catch (e) { 恢复抛了 = String((e && e.message) || e); }
    o.真实恢复 = 恢复; o.恢复抛了 = 恢复抛了;
    o.suppress归位 = (window.__jsonSyncFlags().suppress === false);
    return JSON.stringify(o);
  })()`);
  const R2C = JSON.parse(r2c2);
  console.log('    · ' + r2c2);

  console.log('    · ' + r2i);
  ok(R2S.钩子 && R2S.有现场, 'T5-R2 R2 用例拿到了现场（钩子齐 + #jsonArea）');
  if (!R2S.钩子 || !R2S.有现场) {
    ok(false, 'T5-R2 R2 用例缺现场 —— 其余断言未执行（不静默跳过）');
  } else {
    const F = R2I.现场 || {};
    ok(F.选区非空, 'T5-R2 R2 现场：**选区非空**');
    ok(F.草稿在, 'T5-R2 R2 现场：JSON 文本域里是**未应用的草稿**');
    ok(F.dirty, 'T5-R2 R2 现场：草稿是 **dirty（有错未生效）** 状态');
    ok(F.dirty条在, 'T5-R2 R2 现场：**dirty 提示条已生成**（不是空 DOM）');
    ok(F.dirty条可见, 'T5-R2 R2 现场：dirty 提示条**可见**');
    ok(F.dirty条含错误数, 'T5-R2 R2 现场：提示条文案里有**错误数**："' + (F.dirty条错误数) + ' 个错误"');
    ok((F.dirty条错误数 || 0) > 0, 'T5-R2 R2 现场：错误数 > 0（回滚后必须还是这个数）');

    const CI = {};
    (R2I.病例 || []).forEach(function (c) { CI[c.名] = c; });
    eq((R2I.病例 || []).length, 7, 'T5-R2 R2 七个病例都在（三个注入阶段 / 连续失败 / 失败后功能 / 判据自身抛异常 / 深嵌套）');

    ["①·prepare(toV2Json)异常", "②·同步写入阶段异常", "③·refresh(draw)阶段异常"].forEach(function (名) {
      const c = CI[名];
      ok(!!c, 'T5-R2 R2[' + 名 + '] 病例存在');
      if (!c) return;
      eq(c.返回, false, 'T5-R2 R2[' + 名 + '] `restoreSnapshot()` 返回 **false**（实际 ' + JSON.stringify(c.返回) + '）');
      eq(c.抛了, null, 'T5-R2 R2[' + 名 + '] **一个异常都没抛**（异常收尾本身也不抛）' + (c.抛了 ? '（抛了：' + c.抛了 + '）' : ''));
      ok(c.设计引用未变, 'T5-R2 R2[' + 名 + '] design 还是**同一个对象引用**');
      ok(c.选区引用未变, 'T5-R2 R2[' + 名 + '] selection 还是**同一个对象引用**');
      ok(c.JSON文本未变, 'T5-R2 R2[' + 名 + '] **未应用的 JSON 草稿没被覆盖**');
      ok(c.mName不是TARGET, 'T5-R2 R2[' + 名 + '] 🔴 **`mName` 没有停在 TARGET 上**');
      ok(c.设计名不是TARGET, 'T5-R2 R2[' + 名 + '] **实际设计名不是 TARGET**');
      ok(c.表单未变, 'T5-R2 R2[' + 名 + '] 🔴 **元数据表单逐字段与失败前一致**（mName/mAuthor/mDesc/mTheme/dW/dH/scaleMode/bgPath/bgFit/bgW/bgH）');
      ok(c.dirty条未变, 'T5-R2 R2[' + 名 + '] 🔴 **dirty 提示条整段内容与失败前一致**（不是"1 个错误变 0 个错误"）');
      ok(c.dirty条可见性未变, 'T5-R2 R2[' + 名 + '] dirty 提示条的**可见性**也没变');
      ok(c.dirty标志未变, 'T5-R2 R2[' + 名 + '] `jsonDirty` 标志未变');
      ok(c.dirty错误数未变, 'T5-R2 R2[' + 名 + '] 🔴 **记着的错误条数未变**（回滚能按原条数重建提示）');
      ok(c.suppress归位, 'T5-R2 R2[' + 名 + '] 🔴 **`suppressJsonSync` 归位**（= false）');
      ok(c.哨兵未变, 'T5-R2 R2[' + 名 + '] **localStorage 哨兵未变**（持久化用户数据没被动）');
      ok(c.未报成功, 'T5-R2 R2[' + 名 + '] **失败不报成功**（提示里没有"已撤销/已重做"）');
    });

    const C2b = CI["②·同步写入阶段异常"];
    if (C2b) ok(C2b.原型已还原, 'T5-R2 R2[②] 注入用的 DOM 原型**已还原**（不是改完就走）');

    const C3b = CI["③b·连续多次失败"];
    ok(!!C3b, 'T5-R2 R2[③b] 病例存在');
    if (C3b) {
      eq(C3b.抛了, null, 'T5-R2 R2[③b] 连续失败也**不抛异常**' + (C3b.抛了 ? '（抛了：' + C3b.抛了 + '）' : ''));
      ok(C3b.第一次摘了1条, 'T5-R2 R2[③b] 第一次失败**只摘掉那一条**目标（3 → 2）：' + JSON.stringify(C3b.状态1));
      ok(C3b.第二次没再摘, 'T5-R2 R2[③b] 🔴 **继续按不再反复摘**（第二次没再少记录）：' + JSON.stringify(C3b.状态2));
      ok(C3b.好历史还在, 'T5-R2 R2[③b] 🔴 **不凭空丢好历史**（反方向的 A 一直在）：' + C3b.状态1.表 + ' → ' + C3b.状态2.表);
      ok(C3b.游标仍在当前记录, 'T5-R2 R2[③b] 游标仍指向**实际当前记录**');
      ok(C3b.设计未变, 'T5-R2 R2[③b] 实际设计未变');
    }

    // ---- ③c：失败之后的**真实**功能回归（JSON 编辑 / 撤销 / 恢复）----
    ok(R2C && typeof R2C === "object", 'T5-R2 R2[③c] 拿到了失败后的功能回归结果');
    if (R2C) {
      ok(R2C.JSON编辑生效, 'T5-R2 R2[③c] 🔴 失败之后**真实 JSON 编辑仍然生效**（设计名变成 ' + R2C.编辑后名字 + '）');
      eq(R2C.撤销抛了, undefined, 'T5-R2 R2[③c] 真实撤销不抛异常：' + (R2C.撤销抛了 || ''));
      ok(R2C.撤销回到了编辑前, 'T5-R2 R2[③c] 🔴 **真实撤销回到了编辑之前**（' + R2C.撤销后名字 + ' ← ' + R2C.编辑前名字 + '）');
      ok(R2C.撤销后设计可用, 'T5-R2 R2[③c] 撤销后设计仍然可用');
      eq(R2C.真实恢复, true, 'T5-R2 R2[③c] 失败之后**正常恢复仍然成功**');
      eq(R2C.恢复抛了, null, 'T5-R2 R2[③c] 正常恢复不抛：' + (R2C.恢复抛了 || ''));
      ok(R2C.suppress归位, 'T5-R2 R2[③c] 失败+编辑之后 `suppressJsonSync` 仍在 false');
    }

    // ---- ⑤：解析/判据异常一律 false 且不抛 ----
    const C5 = CI["⑤·解析/判据异常安全"];
    ok(!!C5, 'T5-R2 R2[⑤] 病例存在');
    if (C5) {
      eq(C5.判据全部安全, true, 'T5-R2 R2[⑤] 🔴 判据对 null/undefined/数字/对象/数组/空串**一律安全返回 boolean false、不抛**：' + JSON.stringify(C5.判据));
      eq(C5.恢复全部false不抛, true, 'T5-R2 R2[⑤] 🔴 `restoreSnapshot` 对截断/非 JSON/非字符串**一律 false 且不抛**：' + JSON.stringify(C5.恢复));
      ok(C5.设计引用未变, 'T5-R2 R2[⑤] design 引用未变');
      ok(C5.选区引用未变, 'T5-R2 R2[⑤] selection 引用未变');
      ok(C5.JSON文本未变, 'T5-R2 R2[⑤] 未应用的 JSON 草稿未变');
      ok(C5.表单未变, 'T5-R2 R2[⑤] 元数据表单未变');
      ok(C5.dirty条未变, 'T5-R2 R2[⑤] dirty 提示条未变');
      ok(C5.suppress归位, 'T5-R2 R2[⑤] `suppressJsonSync` 归位');
    }

    const C4 = CI["④·10000层children"];
    ok(!!C4, 'T5-R2 R2[④] 病例存在');    if (C4) {
      eq(C4.判据类型, "boolean", 'T5-R2 R2[④] 🔴 共用判据对 10000 层快照**返回 boolean**（实际类型 ' + C4.判据类型 + '）');
      eq(C4.判据抛了, null, 'T5-R2 R2[④] 🔴 判据**不抛**（原来在这里爆栈）' + (C4.判据抛了 ? '（抛了：' + C4.判据抛了 + '）' : ''));
      eq(C4.判据, false, 'T5-R2 R2[④] 判据判它**不可用**（超出有界检查预算 → 拒绝，不是"检查一半当通过"）');
      eq(C4.抛了, null, 'T5-R2 R2[④] 🔴 `restore` **不抛** `Maximum call stack size exceeded`' + (C4.抛了 ? '（抛了：' + C4.抛了 + '）' : ''));
      eq(C4.返回, false, 'T5-R2 R2[④] 🔴 `restore` 返回 **false**');
      ok(C4.设计引用未变, 'T5-R2 R2[④] design 引用未变');
      ok(C4.表单未变, 'T5-R2 R2[④] 元数据表单未变');
      ok(C4.dirty条未变, 'T5-R2 R2[④] dirty 提示条未变');
      ok(C4.suppress归位, 'T5-R2 R2[④] `suppressJsonSync` 归位');
      eq(C4.入口抛了, null, 'T5-R2 R2[④] 真实入口 `doUndo()` 也不抛：' + (C4.入口抛了 || ''));
      eq(C4.入口后栈长, 1, 'T5-R2 R2[④] 真实入口把它当**坏记录摘掉**，只剩当前基准：' + C4.入口后栈长);
      ok(C4.合法判可用 === true, 'T5-R2 R2[④] 🔴 **合法深度（10 层）不被误伤**：判据判可用');
      eq(C4.合法返回, true, 'T5-R2 R2[④] 🔴 合法深度**走真实 restore 成功**（不是"判据说行"就算）');
      eq(C4.合法抛了, null, 'T5-R2 R2[④] 合法深度恢复不抛');
      eq(C4.合法身份, "深", 'T5-R2 R2[④] 合法深度恢复到的就是那份设计：' + C4.合法身份);
    }
  }

  // ================================================================ T5-R3 · R2（P2）· 提示条恢复必须连**事件**一起恢复
  //
  // ## 规划方实测的反例
  //
  // 真实 draw 阶段失败后，回滚用 HTML 字符串还原文字 → 原 button 的点击处理
  // （**JS 属性，不在 innerHTML 里**）变成 null → 真实点击"放弃 JSON 改动"后
  // dirty 仍 true、草稿不变、提示仍可见。**HTML 相同 ≠ 交互相同。**
  //
  // ## 这一段怎么验（三个注入阶段各一例，全部走**真实按钮点击**）
  //
  //  · 先用真实 jsonEdited()（350ms 防抖）造出"dirty 草稿 + dirty 提示条 + 按钮"；
  //  · 分别让 prepare（toV2Json）/ 同步写入（DOM value setter）/ refresh·draw 抛一次，
  //    断言 restoreSnapshot 返回 false 且不抛、提示条的**文本 / 错误数 / 可见性**
  //    逐项未变、按钮**还是原来那个节点**（对象身份）且 onclick 仍是函数；
  //  · 然后**真实 .click()**：dirty 归 false、文本域被同步成**实际设计**的 JSON、
  //    提示条隐藏、给"已放弃 JSON 改动"的反馈、设计引用不变；
  //  · 最后再**真实**编辑一次 JSON + 撤销，证明功能没被弄坏。
  console.log('\n=== T5-R3 · R2：提示条事件随回滚一起恢复 ===');

  const r3r2 = await cdp.eval(`(async () => {
    const S = window.CanvasState;
    const out = {};
    out.钩子 = !!(typeof window.restoreSnapshot === "function"
      && typeof window.jsonEdited === "function"
      && typeof window.toV2Json === "function"
      && typeof window.__jsonSyncFlags === "function"
      && typeof window.doUndo === "function");
    const area = document.getElementById("jsonArea");
    out.有现场 = !!area;
    if (!out.钩子 || !out.有现场) return JSON.stringify(out);
    const 睡眠 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    const barOf = function () { return document.getElementById("jsonDirtyBar"); };
    const 按钮Of = function () { const b = barOf(); return b ? b.querySelector("button") : null; };
    const toastEl = function () { const t = document.getElementById("toast"); return t ? (t.textContent || "") : ""; };
    const 拍照 = function () {
      const b = barOf(); const x = 按钮Of();
      const t = b ? b.textContent : null;
      const m = t ? t.match(/([0-9]+) 个错误/) : null;
      return {
        有: !!b, 文本: t, 错误数: m ? Number(m[1]) : null,
        可见: b ? (b.style.display !== "none") : false,
        按钮节点: x, 按钮是函数: !!(x && typeof x.onclick === "function"),
        dirty: window.__jsonSyncFlags().dirty,
        dirtyErrors: window.__jsonSyncFlags().dirtyErrors,
        设计引用: S.design,
      };
    };
    const 目标快照 = function () {
      const d = JSON.parse(JSON.stringify(S.design));
      d.name = "TARGET-R3";
      return JSON.stringify({ d: d, sel: S.selection.slice() });
    };
    const 造dirty = async function (tag) {
      area.value = "【T5R3-R2 草稿 " + tag + "】{ 故意写坏";
      window.jsonEdited();
      await 睡眠(460);
    };

    const 阶段 = [
      {
        名: "①·prepare(toV2Json)",
        装: function () {
          const 真 = window.toV2Json;
          window.toV2Json = function () { throw new Error("T5R3-R2 注入：prepare 阶段失败"); };
          return function () { window.toV2Json = 真; };
        },
      },
      {
        名: "②·同步写入(mAuthor)",
        装: function () {
          const el0 = document.getElementById("mAuthor");
          const proto = el0 ? Object.getPrototypeOf(el0) : null;
          const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
          if (!desc) return null;
          Object.defineProperty(proto, "value", {
            configurable: true, enumerable: desc.enumerable, get: desc.get,
            set: function (v) {
              if (this && this.id === "mAuthor") throw new Error("T5R3-R2 注入：同步写入阶段失败");
              return desc.set.call(this, v);
            },
          });
          return function () { Object.defineProperty(proto, "value", desc); };
        },
      },
      {
        名: "③·refresh(draw)",
        装: function () {
          const 真 = window.draw; let 已抛 = false;
          window.draw = function () {
            if (!已抛) { 已抛 = true; throw new Error("T5R3-R2 注入：refresh/draw 阶段失败"); }
            return 真.apply(this, arguments);
          };
          return function () { window.draw = 真; };
        },
      },
    ];

    out.病例 = [];
    for (let i = 0; i < 阶段.length; i++) {
      const ph = 阶段[i];
      await 造dirty(String(i + 1));
      const o = { 名: ph.名, 抛了: null };
      const 前 = 拍照();
      o.失败前有提示条 = 前.有;
      o.失败前可见 = 前.可见;
      o.失败前错误数 = 前.错误数;
      o.失败前dirty = 前.dirty;
      o.失败前按钮可用 = 前.按钮是函数;
      o.失败前按钮文本 = 前.按钮节点 ? 前.按钮节点.textContent : null;
      const 撤 = ph.装();
      o.注入成功 = !!撤;
      let 返回 = null;
      try { 返回 = window.restoreSnapshot(目标快照()); } catch (e) { o.抛了 = String((e && e.message) || e); }
      if (撤) 撤();
      const 后 = 拍照();
      o.返回 = 返回;
      o.条文本未变 = (后.文本 === 前.文本);
      o.错误数未变 = (后.错误数 === 前.错误数);
      o.可见性未变 = (后.可见 === 前.可见);
      o.按钮还是原节点 = (后.按钮节点 === 前.按钮节点);
      o.按钮onclick是函数 = 后.按钮是函数;
      o.dirty未变 = (后.dirty === 前.dirty);
      o.草稿还在 = (area.value.indexOf("故意写坏") >= 0);
      o.设计引用未变 = (S.design === 前.设计引用);
      o.设计名不是TARGET = !!(S.design && S.design.name !== "TARGET-R3");
      // ---- 真实点击"放弃 JSON 改动" ----
      const b = 按钮Of();
      o.点击前按钮存在 = !!b;
      if (b) { try { b.click(); } catch (e) { o.点击抛了 = String((e && e.message) || e); } }
      o.点击后dirty = window.__jsonSyncFlags().dirty;
      o.点击后草稿等于实际设计 = (area.value === window.toV2Json(S.design));
      o.点击后条隐藏 = (function () { const x = barOf(); return !x || x.style.display === "none"; })();
      o.点击后提示 = toastEl();
      o.点击后反馈对 = /已放弃 JSON 改动/.test(o.点击后提示 || "");
      o.点击后设计引用未变 = (S.design === 前.设计引用);
      out.病例.push(o);
    }

    // ---- 失败之后**真实** JSON 编辑与撤销仍然可用 ----
    const 名2 = "R3R2编辑后-" + Date.now();
    area.value = JSON.stringify({
      schema: "icar.ui/2",
      canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 },
      meta: { name: 名2 },
      assets: [], controls: [], pages: [],
      nodes: [{ id: "jj", type: "text", name: "jj", text: "jj", x: 5, y: 5, w: 10, h: 10 }],
    });
    window.jsonEdited();
    await 睡眠(460);
    out.编辑生效 = !!(S.design && S.design.name === 名2);
    out.编辑后名字 = S.design ? S.design.name : null;
    const st = window.__undoStack;
    out.编辑后canUndo = st ? st.canUndo() : null;
    let 撤抛 = null;
    try { window.doUndo(); } catch (e) { 撤抛 = String((e && e.message) || e); }
    out.撤销抛了 = 撤抛;
    out.撤销后名字 = S.design ? S.design.name : null;
    out.撤销回到编辑前 = (out.撤销后名字 !== 名2);
    out.suppress归位 = (window.__jsonSyncFlags().suppress === false);
    // 收尾
    try { if (typeof window.discardJsonEdit === "function") window.discardJsonEdit(); } catch (e) { }
    if (area) area.value = "";
    try { if (st) st.reset(window.__commitState(), "收尾"); } catch (e) { }
    return JSON.stringify(out);
  })()`);
  const R3R2 = JSON.parse(r3r2);
  console.log('    · ' + r3r2);
  ok(R3R2.钩子 && R3R2.有现场, 'T5-R3 R2 用例拿到了现场（钩子齐 + #jsonArea）');
  if (!R3R2.钩子 || !R3R2.有现场) {
    ok(false, 'T5-R3 R2 用例缺现场 —— 其余断言未执行（不静默跳过）');
  } else {
    eq((R3R2.病例 || []).length, 3, 'T5-R3 R2 三个注入阶段各一例（prepare / 同步写入 / refresh·draw）');
    (R3R2.病例 || []).forEach(function (c) {
      const T = 'T5-R3 R2[' + c.名 + '] ';
      ok(c.失败前有提示条, T + '前置：**dirty 提示条已生成**');
      ok(c.失败前可见, T + '前置：dirty 提示条**可见**');
      ok((c.失败前错误数 || 0) > 0, T + '前置：提示条里有**错误数**（' + c.失败前错误数 + ' 个错误）');
      eq(c.失败前dirty, true, T + '前置：`jsonDirty` 为真');
      eq(c.失败前按钮可用, true, T + '前置：按钮**可用**（onclick 是函数，文本="' + c.失败前按钮文本 + '"）');
      eq(c.注入成功, true, T + '注入装上了');
      eq(c.返回, false, T + '`restoreSnapshot()` 返回 **false**（实际 ' + JSON.stringify(c.返回) + '）');
      eq(c.抛了, null, T + '**一个异常都没抛**' + (c.抛了 ? '（抛了：' + c.抛了 + '）' : ''));
      eq(c.设计引用未变, true, T + 'design 还是**同一个对象引用**（回滚到位）');
      eq(c.设计名不是TARGET, true, T + '实际设计名不是 TARGET');
      ok(c.条文本未变, T + '🔴 dirty 提示条**文本逐字未变**');
      eq(c.错误数未变, true, T + '🔴 **错误数未变**（不是"1 个错误变 0 个错误"）');
      eq(c.可见性未变, true, T + 'dirty 提示条的**可见性**未变');
      eq(c.dirty未变, true, T + '`jsonDirty` 标志未变');
      ok(c.草稿还在, T + '🔴 **用户草稿还在**（回滚没有替用户做决定）');
      ok(c.按钮还是原节点, T + '🔴 **按钮还是原来那个 DOM 节点**（对象身份，不是重新解析出来的新节点）');
      eq(c.按钮onclick是函数, true, T + '🔴 **`onclick` 仍是函数**（事件随节点一起回来了）');
      eq(c.点击前按钮存在, true, T + '点击前按钮存在');
      eq(c.点击抛了, undefined, T + '真实点击本身不抛' + (c.点击抛了 ? '（抛了：' + c.点击抛了 + '）' : ''));
      eq(c.点击后dirty, false, T + '🔴 **真实点击后 dirty 归 false**（不再"点了没反应"）');
      eq(c.点击后草稿等于实际设计, true, T + '🔴 点击后文本域**同步成实际设计的 JSON**');
      eq(c.点击后条隐藏, true, T + '🔴 点击后**提示条隐藏**');
      eq(c.点击后反馈对, true, T + '点击后给正确反馈：' + (c.点击后提示 || '(空)'));
      eq(c.点击后设计引用未变, true, T + '点击只是放弃草稿，没有换设计对象');
    });
    eq(R3R2.编辑生效, true, 'T5-R3 R2 失败之后**真实 JSON 编辑仍然生效**（' + R3R2.编辑后名字 + '）');
    eq(R3R2.编辑后canUndo, true, 'T5-R3 R2 编辑进了撤销栈（可撤销）');
    eq(R3R2.撤销抛了, null, 'T5-R3 R2 真实撤销不抛');
    eq(R3R2.撤销回到编辑前, true, 'T5-R3 R2 🔴 **真实撤销回到了编辑之前**');
    eq(R3R2.suppress归位, true, 'T5-R3 R2 `suppressJsonSync` 归位（= false）');
  }

  // ================================================================ T5-R3 · R3（P2）· 部分绘制后失败，画布也要回到实际设计
  //
  // ## 规划方实测的反例
  //
  // 候选快照在**真实 draw 内部**抛，而 draw 是**先真的画了候选**（空节点/目标页）
  // 再抛的。restore 返回 false、实际设计已经回到 CURRENT，**但画布上留下的是
  // 候选那一帧**（立即与 150ms 后都不是原画面）；规划方用诊断脚本手动
  // draw(CURRENT) 才让像素一致 —— 说明**产品没有完成像素回滚**。
  //
  // ## 这一段怎么验（确定性静态设计 + 固定尺寸）
  //
  //  · 先把原设计画上去并取**整张画布的像素指纹**（FNV-1a 哈希 + 尺寸 + 代表点
  //    + 异色比），作为"原画面"的基准；
  //  · 三种注入各一例：**绘制前抛** / **绘制后抛**（先真画候选再抛）/ **持续异常**；
  //  · 每例断言：restoreSnapshot 返回 false **且不抛**、实际设计/元数据表单/
  //    选区/页签/树/属性与设计一致、**画布尺寸与像素**回到原画面（立即 + 150ms 后）；
  //  · **不手动重画**：像素一致性只能来自产品自己的收尾（另有
  //    __lastRestoreFinish() 直接证明"收尾里确实重画过"以及"重画也失败"时如实记录）；
  //  · 持续异常那一例还断言**重画次数有界**（只多一次，不重试轰炸）。
  console.log('\n=== T5-R3 · R3：部分绘制后失败，画布像素回滚 ===');

  const r3r3 = await cdp.eval(`(async () => {
    const S = window.CanvasState;
    const out = {};
    const cv = document.getElementById("cv");
    out.钩子 = !!(cv && typeof window.restoreSnapshot === "function"
      && typeof window.__lastRestoreFinish === "function"
      && typeof window.jsonEdited === "function");
    if (!out.钩子) return JSON.stringify(out);
    const ctx = cv.getContext("2d");
    const 睡眠 = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    const area = document.getElementById("jsonArea");
    const barOf = function () { return document.getElementById("jsonDirtyBar"); };
    const 条文本 = function () { const b = barOf(); return b ? b.textContent : null; };
    const 按钮是函数 = function () {
      const b = barOf(); const x = b ? b.querySelector("button") : null;
      return !!(x && typeof x.onclick === "function");
    };

    // ---- 整张画布的像素指纹（在页面内算，只把哈希/代表点传回去）----
    const 指纹 = function () {
      const w = cv.width, h = cv.height;
      if (!w || !h) return { 尺寸: w + "x" + h, 错误: "画布尺寸为 0" };
      let img;
      try { img = ctx.getImageData(0, 0, w, h); }
      catch (e) { return { 尺寸: w + "x" + h, 错误: String((e && e.message) || e) }; }
      const d = img.data;
      let hash = 2166136261;
      for (let i = 0; i < d.length; i += 4) {
        hash = ((hash ^ d[i]) * 16777619) >>> 0;
        hash = ((hash ^ d[i + 1]) * 16777619) >>> 0;
        hash = ((hash ^ d[i + 2]) * 16777619) >>> 0;
      }
      const at = function (x, y) {
        const k = (y * w + x) * 4;
        return d[k] + "," + d[k + 1] + "," + d[k + 2] + "," + d[k + 3];
      };
      let 异 = 0, 总 = 0;
      for (let k = 0; k < d.length; k += 4 * 197) {
        总++;
        if (d[k] !== d[0] || d[k + 1] !== d[1] || d[k + 2] !== d[2]) 异++;
      }
      return {
        尺寸: w + "x" + h,
        哈希: hash,
        代表点: [at(2, 2), at(w >> 1, h >> 1), at(w - 3, h - 3)],
        异色比: 总 ? Math.round(异 / 总 * 1000) / 1000 : 0,
      };
    };

    // ---- 确定性静态设计（无素材、无背景图 → 画布不会被跨源图污染，像素可比）----
    // ⚠️ 节点必须带 visible: true：drawList 会跳过 visible 为假的节点
    //    （不写这个字段 = 画布上什么都没有 → "候选画上去了"这件事就无法用像素证明）。
    const 做设计 = function (name, 节点数) {
      const nodes = [];
      for (let i = 0; i < 节点数; i++) {
        nodes.push({
          id: "n" + i, type: "text", name: "t" + i, text: "画布内容 " + i,
          x: 10 + i * 60, y: 10 + i * 60, w: 330, h: 80, visible: true,
          font: { size: 40, color: "#FFFFFF", align: "left" },
        });
      }
      return {
        name: name, author: "t5r3", description: "", themeId: 0,
        canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 1 },
        assets: [], controls: [], pages: [], nodes: nodes,
      };
    };
    const CUR = JSON.stringify({ d: 做设计("PIXCUR", 3), sel: [] });
    const TGT = JSON.stringify({ d: 做设计("PIXTGT", 0), sel: [] });
    out.CUR判可用 = window.isUsableSnapshot(CUR);
    out.TGT判可用 = window.isUsableSnapshot(TGT);

    // 清一遍位图（顺带把 origin-clean 复位），再把"原设计"真的画上去
    cv.width = cv.width; cv.height = cv.height;
    out.原设计恢复 = window.restoreSnapshot(CUR);
    await 睡眠(80);
    let 原指纹 = 指纹();
    out.原指纹 = 原指纹;
    out.原设计名 = S.design ? S.design.name : null;
    out.原尺寸 = cv.width + "x" + cv.height;

    // 造一个**真实 dirty 现场**：证明 R3 的回滚没有破坏 R2 的按钮功能
    area.value = "【T5R3-R3 草稿】{ 故意写坏";
    window.jsonEdited();
    await 睡眠(460);
    // A dirty error message can resize the canvas container. Compare rollback
    // against the actual pre-transaction screen, after that layout has settled.
    // The immediate and 150ms pixel/size assertions below remain strict.
    原指纹 = 指纹();
    out.原指纹 = 原指纹;
    out.原尺寸 = cv.width + "x" + cv.height;
    out.dirty前文本 = 条文本();
    out.dirty前按钮可用 = 按钮是函数();

    const 现场 = function () {
      const nameEl = document.getElementById("mName");
      const tree = document.getElementById("tree");
      const props = document.getElementById("props");
      const tabs = document.getElementById("pageTabs");
      return {
        设计名: S.design ? S.design.name : null,
        表单名: nameEl ? nameEl.value : null,
        表单一致: !!(nameEl && S.design && nameEl.value === S.design.name),
        选区: (S.selection || []).join(","),
        页签文本: tabs ? (tabs.textContent || "") : null,
        树非空: !!(tree && tree.innerHTML.length > 0),
        属性非空: !!(props && props.innerHTML.length > 0),
      };
    };
    out.原现场 = 现场();

    out.病例 = [];
    const 跑一例 = async function (名, 包, 期望收尾重画) {
      const o = { 名: 名, 抛了: null };
      const 真draw = window.draw;
      let 次 = 0, 候选指纹 = null;
      window.draw = 包(真draw, function () { 次++; }, function () { 候选指纹 = 指纹(); });
      let 返回 = null;
      try { 返回 = window.restoreSnapshot(TGT); } catch (e) { o.抛了 = String((e && e.message) || e); }
      const 立即 = 指纹();
      const fin = window.__lastRestoreFinish();
      window.draw = 真draw;
      o.返回 = 返回;
      o.立即 = 立即;
      o.draw次数 = 次;
      o.收尾 = fin;
      o.候选指纹 = 候选指纹;
      o.现场 = 现场();
      o.条文本 = 条文本();
      o.按钮是函数 = 按钮是函数();
      await 睡眠(150);
      o.后150ms = 指纹();
      o.立即与原一致 = (立即.哈希 === 原指纹.哈希);
      o["150ms仍与原一致"] = (o.后150ms.哈希 === 原指纹.哈希);
      o.尺寸未变 = (立即.尺寸 === out.原尺寸) && (o.后150ms.尺寸 === out.原尺寸);
      o.代表点一致 = (JSON.stringify(立即.代表点) === JSON.stringify(原指纹.代表点));
      o.异色比一致 = (立即.异色比 === 原指纹.异色比);
      o.收尾按期望 = (!!(fin && fin.canvas === true) === !!期望收尾重画);
      out.病例.push(o);
    };

    // ---- ① 绘制**之后**抛（规划方那一例：先真画候选，再抛）----
    await 跑一例("①·绘制后抛", function (真draw, 加次, 记候选) {
      let 已抛 = false;
      return function () {
        加次();
        const r = 真draw.apply(this, arguments);
        if (!已抛) { 已抛 = true; 记候选(); throw new Error("T5R3 注入：绘制后失败"); }
        return r;
      };
    }, true);

    // ---- ② 绘制**之前**抛（候选一帧都没画上去）----
    await 跑一例("②·绘制前抛", function (真draw, 加次) {
      let 已抛 = false;
      return function () {
        加次();
        if (!已抛) { 已抛 = true; throw new Error("T5R3 注入：绘制前失败"); }
        return 真draw.apply(this, arguments);
      };
    }, true);

    // ---- ③ 持续异常（每次都真画一遍再抛，永不成功）----
    await 跑一例("③·持续异常", function (真draw, 加次) {
      return function () {
        加次();
        真draw.apply(this, arguments);
        throw new Error("T5R3 注入：持续失败");
      };
    }, false);

    // ---- 收尾 ----
    try { if (typeof window.discardJsonEdit === "function") window.discardJsonEdit(); } catch (e) { }
    if (area) area.value = "";
    try { if (window.__undoStack) window.__undoStack.reset(window.__commitState(), "收尾"); } catch (e) { }
    return JSON.stringify(out);
  })()`);
  const R3R3 = JSON.parse(r3r3);
  console.log('    · ' + r3r3);
  ok(R3R3.钩子, 'T5-R3 R3 用例拿到了现场（#cv + restoreSnapshot + __lastRestoreFinish）');
  if (!R3R3.钩子) {
    ok(false, 'T5-R3 R3 用例缺现场 —— 其余断言未执行（不静默跳过）');
  } else {
    ok(!(R3R3.原指纹 || {}).错误, 'T5-R3 R3 画布像素**可读**（没有被跨源图污染）：' + JSON.stringify((R3R3.原指纹 || {}).尺寸));
    eq(R3R3.CUR判可用, true, 'T5-R3 R3 原设计快照判可用');
    eq(R3R3.TGT判可用, true, 'T5-R3 R3 候选（空节点）快照判可用');
    eq(R3R3.原设计恢复, true, 'T5-R3 R3 先把**原设计真的画上画布**');
    eq(R3R3.原设计名, 'PIXCUR', 'T5-R3 R3 原设计就是 PIXCUR：' + R3R3.原设计名);
    ok(R3R3.原指纹 && typeof R3R3.原指纹.哈希 === 'number', 'T5-R3 R3 原画面像素指纹已取到（尺寸 ' + ((R3R3.原指纹 || {}).尺寸) + '、异色比 ' + ((R3R3.原指纹 || {}).异色比) + '）');
    ok((R3R3.原指纹 || {}).异色比 > 0, 'T5-R3 R3 原画面**不是纯底色**（有真实内容可辨）：异色比 ' + ((R3R3.原指纹 || {}).异色比));
    eq(R3R3.dirty前按钮可用, true, 'T5-R3 R3 现场：dirty 提示条按钮可用（R2 的功能要一起保持）');

    eq((R3R3.病例 || []).length, 3, 'T5-R3 R3 三个病例都在（绘制前抛 / 绘制后抛 / 持续异常）');
    (R3R3.病例 || []).forEach(function (c) {
      const T = 'T5-R3 R3[' + c.名 + '] ';
      eq(c.抛了, null, T + '**一个异常都没抛**（异常收尾本身不得再抛）' + (c.抛了 ? '（抛了：' + c.抛了 + '）' : ''));
      eq(c.返回, false, T + '`restoreSnapshot()` 返回 **false**');
      eq(c.立即与原一致, true, T + '🔴 **收尾那一刻画布已经回到原设计**（整张画布像素哈希一致）');
      eq(c["150ms仍与原一致"], true, T + '🔴 **150ms 后仍然一致**（不靠后续刷新/定时器慢慢修）');
      eq(c.尺寸未变, true, T + '🔴 **画布尺寸未变**：' + ((c.立即 || {}).尺寸));
      eq(c.代表点一致, true, T + '🔴 **代表点像素一致**（左上/中心/右下）：' + JSON.stringify((c.立即 || {}).代表点));
      eq(c.异色比一致, true, T + '🔴 有内容的像素占比也一致（' + (c.立即 || {}).异色比 + '）');
      eq((c.现场 || {}).设计名, 'PIXCUR', T + '实际设计回到 PIXCUR：' + ((c.现场 || {}).设计名));
      eq((c.现场 || {}).表单一致, true, T + '元数据表单与设计一致（不是停在 TARGET）');
      eq((c.现场 || {}).选区, '', T + '选区与回滚后的设计一致');
      ok((c.现场 || {}).树非空, T + '控件树已按实际设计重渲染（非空）');
      ok((c.现场 || {}).属性非空, T + '属性面板块已重渲染（非空）');
      ok((c.现场 || {}).页签文本 !== null, T + '页签已重渲染：' + JSON.stringify((c.现场 || {}).页签文本));
      eq(c.条文本, R3R3.dirty前文本, T + 'dirty 提示条文本未变（R2 的现场没被破坏）');
      eq(c.按钮是函数, true, T + '🔴 dirty 提示条的按钮**仍然可用**（R2 的事件恢复一起保持）');
    });

    const C1 = (R3R3.病例 || [])[0] || {};
    const C2 = (R3R3.病例 || [])[1] || {};
    const C3 = (R3R3.病例 || [])[2] || {};
    ok(!!C1.候选指纹 && C1.候选指纹.哈希 !== (R3R3.原指纹 || {}).哈希,
      'T5-R3 R3[①] 🔴 前置证据：候选**真的被画上了画布**（注入里取的像素指纹与原画面不同）');
    eq(C1.收尾按期望, true, 'T5-R3 R3[①] 收尾里**确实重画过**（__lastRestoreFinish().canvas=true）');
    eq(C1.draw次数, 2, 'T5-R3 R3[①] 整次失败只发生 **2 次** draw（refreshAll 一次 + 收尾**有界**重画一次）：' + C1.draw次数);
    eq(C2.收尾按期望, true, 'T5-R3 R3[②] 收尾里也重画过（绘制前抛的那一例）');
    eq(C2.draw次数, 2, 'T5-R3 R3[②] 同样只有 2 次 draw（有界）：' + C2.draw次数);
    eq(C3.收尾按期望, true, 'T5-R3 R3[③] 🔴 持续异常时**如实记录"画布没重画成功"**（不谎报已复原）：' + JSON.stringify(C3.收尾));
    eq(C3.draw次数, 2, 'T5-R3 R3[③] 🔴 **持续异常也不重试轰炸**：仍然只有 2 次 draw：' + C3.draw次数);
    ok(!!(C3.收尾 || {}).error, 'T5-R3 R3[③] 记录里带着失败原因（诊断用）：' + JSON.stringify((C3.收尾 || {}).error));
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

  console.log('\n=== T6：JSON 草稿保护（真实输入、快捷键和 FileReader）===');
  {
    const checks = await cdp.eval(`(async () => {
      const S = window.CanvasState, U = window.__undoStack;
      const A = document.getElementById('jsonArea'), results = [];
      const wait = () => new Promise(r => setTimeout(r, 480));
      const base = JSON.parse(JSON.stringify(S.design));
      const named = name => Object.assign(JSON.parse(JSON.stringify(base)), {name});
      const check = (name, value) => results.push({name, value: !!value});
      const state = () => ({design: JSON.stringify(S.design), sel: JSON.stringify(S.selection),
        text: A.value, bar: document.getElementById('jsonDirtyBar').textContent,
        flags: JSON.stringify(window.__jsonSyncFlags()), stack: JSON.stringify(U.stack),
        index: U.index, storage: localStorage.getItem('icar-studio-undo')});
      const same = (name, before, keys) => {
        const after = state();
        keys.forEach(k => check(name + '：' + k + ' 保留', before[k] === after[k]));
      };
      const all = ['design', 'sel', 'text', 'bar', 'flags', 'stack', 'index', 'storage'];
      const reset = empty => {
        window.discardJsonEdit();
        const d = named('CURRENT');
        if (empty) { d.nodes = []; d.pages.forEach(p => p.nodes = []); }
        window.restoreSnapshot(JSON.stringify({d, sel: []}));
        U.reset(window.__commitState(), 'CURRENT');
        window.saveUndoStack();
      };
      const input = text => { A.value = text; A.dispatchEvent(new Event('input', {bubbles:true})); };
      const bad = '{"draft":';
      const key = direction => document.body.dispatchEvent(new KeyboardEvent('keydown',
        {key: direction === 'undo' ? 'z' : 'y', ctrlKey:true, bubbles:true}));
      let prompts = [];
      const consent = answer => { prompts = []; window.confirm = q => {prompts.push(q); return answer;}; };
      try {
        for (const valid of [false, true]) {
          reset(false);
          const text = valid ? window.toV2Json(named('JSON-APPLIED')) : bad;
          input(text);
          check('待校验立即保护（' + valid + '）', A.classList.contains('dirty'));
          check('待校验提示如实', /等待校验/.test(state().bar) && !/0 个错误/.test(state().bar));
          document.getElementById('mName').value = 'CANVAS-EDIT'; window.metaChanged();
          check('等待时属性编辑保留草稿', A.value === text && S.design.name === 'CANVAS-EDIT');
          await wait();
          check('定时器使用原输入', valid ? S.design.name === 'JSON-APPLIED' : A.value === text && S.design.name === 'CANVAS-EDIT');
          check('校验状态正确', valid ? !A.classList.contains('dirty') : /[1-9][0-9]* 个错误/.test(state().bar));
          check('没有凭空追加 JSON 历史', U.stack.length === (valid ? 3 : 2));
        }
        for (const direction of ['undo', 'redo']) {
          reset(false);
          window.commit(() => {S.design.name = 'FUTURE';}, 'FUTURE');
          if (direction === 'redo') window.doUndo();
          input(bad); await wait();
          consent(false); const before = state(); key(direction);
          check(direction + ' 取消只问一次', prompts.length === 1);
          same(direction + ' 取消', before, all);
          consent(true); key(direction);
          check(direction + ' 同意后替换', S.design.name === (direction === 'undo' ? 'CURRENT' : 'FUTURE'));
          check(direction + ' 成功后草稿才清除', !A.classList.contains('dirty') && A.value !== bad);
          check(direction + ' 提醒草稿无法撤销找回', prompts.length === 1 && /草稿/.test(prompts[0]) && /无法/.test(prompts[0]));
          consent(false); input(bad); await wait(); const endpoint = state(); key(direction);
          check(direction + ' 正常端点不询问', prompts.length === 0);
          same(direction + ' 正常端点', endpoint, all);
          // 同意后真实 draw 抛一次；T5 恢复事务仍须保留草稿和模型。
          reset(false); consent(true);
          window.commit(() => {S.design.name = 'FUTURE';}, 'FUTURE');
          if (direction === 'redo') window.doUndo();
          input(bad); await wait(); const failed = state(), draw = window.draw;
          let calls = 0;
          window.draw = function () { draw.apply(this, arguments); if (++calls === 1) throw new Error('T6 恢复故障'); };
          try {key(direction);} finally {window.draw = draw;}
          same(direction + ' 恢复失败', failed, ['design','sel','text','bar','flags']);
          check(direction + ' 恢复失败未误报成功', !/已撤销|已重做/.test(document.getElementById('toast').textContent));
          document.getElementById('jsonDirtyBar').querySelector('button').click();
          check(direction + ' 失败后放弃按钮仍可用', !A.classList.contains('dirty') && A.value === window.toV2Json(S.design));
        }
        // 真 FileReader；只拦截文件选择器，保留真实读取/解析/替换入口。
        const open = async text => {
          const create = document.createElement.bind(document); let picker;
          document.createElement = function(tag) {const e = create(tag); if(tag === 'input'){picker=e;e.click=()=>{};}return e;};
          try {
            window.pickFile(); const data = new DataTransfer();
            data.items.add(new File([text], 't6.json', {type:'application/json'}));
            picker.files = data.files; picker.dispatchEvent(new Event('change')); await wait();
          } finally {document.createElement = create;}
        };
        for (const empty of [false,true]) {
          reset(empty); input(bad); await wait(); consent(false); const before = state();
          await open(window.toV2Json(named('OPENED')));
          check('打开取消询问（空=' + empty + '）', prompts.length === 1);
          same('打开取消（空=' + empty + '）', before, all);
          consent(true); await open('not json');
          same('无效文件保留现场（空=' + empty + '）', before, all);
          await open(window.toV2Json(named('OPENED')));
          check('合法文件替换（空=' + empty + '）', S.design.name === 'OPENED' && !A.classList.contains('dirty'));
          window.doUndo(); check('打开可撤销到当前设计', S.design.name === 'CURRENT');
        }
        reset(false); input(bad); await wait(); consent(true);
        const fileBefore = state(), actualDraw = window.draw; let drawCount = 0;
        window.draw = function () { actualDraw.apply(this, arguments); if (++drawCount === 1) throw new Error('T6 打开故障'); };
        try { await open(window.toV2Json(named('OPEN-FAIL'))); }
        finally { window.draw = actualDraw; }
        same('打开恢复失败', fileBefore, all);
        // 取消时保留尚未校验的输入和原定时器；它仍应正常自动应用。
        reset(false); window.commit(() => { S.design.name = 'FUTURE'; }, 'FUTURE');
        input(window.toV2Json(named('PENDING-CANCEL'))); consent(false);
        const pendingBefore = state(); key('undo');
        same('待校验撤销取消', pendingBefore, all); await wait();
        check('取消后待校验合法草稿仍应用', S.design.name === 'PENDING-CANCEL');
        // 连续输入后反复放弃，不得凭空写历史或存储。
        reset(false); input(bad); input('{"second":');
        window.discardJsonEdit(); const discarded = state(); window.discardJsonEdit(); await wait();
        same('重复放弃', discarded, all);
        for (const action of ['newDesign','applyPreset']) {
          reset(true); input(bad); await wait(); consent(false); const before = state();
          if(action === 'applyPreset') window.applyPreset('blank'); else window.newDesign();
          check(action + ' 空设计也询问', prompts.length === 1);
          same(action + ' 取消', before, all);
          consent(true);
          if(action === 'applyPreset') window.applyPreset('blank'); else window.newDesign();
          check(action + ' 成功后草稿清除', !A.classList.contains('dirty') && A.value !== bad);
        }
        reset(false); consent(true);
        const imageFile = new File(['image-bytes'], 't6.png', {type:'image/png'});
        S.design.assets.push({id:'t6-asset', kind:'image', path:'assets/t6.png', rawFile:imageFile});
        const assets = S.design.assets;
        window.applyPreset('blank');
        check('预设保留素材数组和原文件', S.design.assets === assets && S.design.assets[S.design.assets.length - 1].rawFile === imageFile);
        check('预设仍替换控件', S.design.nodes.length === 1 && S.design.nodes[0].text === '点「添加」或从素材库拖入开始');
        // 过期回调：显式放弃、成功替换、新输入均不能再应用旧草稿。
        for(const action of ['discard','undo','open','new','preset','input']) {
          reset(false); consent(true);
          window.commit(() => {S.design.name = 'FUTURE';}, 'FUTURE');
          input(window.toV2Json(named('STALE')));
          if(action === 'discard') window.discardJsonEdit();
          if(action === 'undo') key('undo');
          if(action === 'open') await open(window.toV2Json(named('OPENED')));
          if(action === 'new') window.newDesign();
          if(action === 'preset') window.applyPreset('blank');
          if(action === 'input') input(window.toV2Json(named('LATEST')));
          const before = state(); await wait();
          if(action === 'input') check('新输入覆盖旧请求', S.design.name === 'LATEST');
          else same(action + ' 无过期定时器', before, all);
          check(action + ' 不应用旧草稿', S.design.name !== 'STALE');
        }
        input(window.toV2Json(named('CONTINUED'))); await wait();
        check('后续合法输入仍能应用', S.design.name === 'CONTINUED' && !A.classList.contains('dirty'));
        window.doUndo(); window.doRedo();
        check('后续撤销和重做仍能往返', S.design.name === 'CONTINUED');
      } finally {window.confirm = () => true; window.discardJsonEdit();}
      return results;
    })()`, 60000);
    checks.forEach(c => ok(c.value, 'T6 ' + c.name));
  }

  // T7-U: actual library drop and pixel aspect, including late bitmap loading.
  {
    const checks = await cdp.eval(`(async () => {
      const out = [], S = window.CanvasState;
      const check = (name, value) => out.push({name, value: !!value});
      const reset = (W,H,mode) => {
        window.discardJsonEdit();
        const d = window.createDesign({nodes: []});
        d.canvas.designW=W; d.canvas.designH=H; d.canvas.scaleMode=mode;
        check('测试设计恢复 '+W+'/'+mode, window.restoreSnapshot(JSON.stringify({d,sel:[]})));
        window.applyCanvasSize();
      };
      const ratio = n => { const m=window.nodeToCanvasMatrix(); return n.w*Math.hypot(m.a,m.b)/(n.h*Math.hypot(m.c,m.d)); };
      const near = (v,r) => Math.abs(v/r-1)<0.025;
      for (const [W,H] of [[2560,1600],[1600,2560],[1920,1080]]) {
        for (const mode of [window.SCALE_STRETCH,window.SCALE_FIT,window.SCALE_FILL]) {
          reset(W,H,mode);
          for (const [w,h] of [[320,320],[320,160],[160,320],[1024,32]]) {
            const a={id:window.newId('as'),name:'test.png',path:'assets/test.png',w,h};
            S.design.assets.push(a); window.addImageNode(a.id);
            let n=S.design.nodes.at(-1);
            check('添加比例 '+W+'x'+H+'/'+mode+'/'+w+'x'+h, near(ratio(n),w/h));
            check('节点不超画布 '+W+'/'+mode+'/'+w, Math.max(n.w,n.h)<=355);
            n.w=100; n.h=100; S.selection=[n.id]; window.fitNodeAspect();
            check('恢复比例 '+W+'/'+mode+'/'+w+'x'+h, near(ratio(n),w/h));
          }
        }
      }
      reset(2560,1600,window.SCALE_STRETCH);
      const c=document.createElement('canvas'); c.width=320;c.height=160;
      c.getContext('2d').fillRect(0,0,320,160);
      const blob=await new Promise(r=>c.toBlob(r)); const file=new File([blob],'wide.png',{type:'image/png'});
      const a=await new Promise(r=>window.importAsset(file,'custom',r));
      S.design.assets.push(a); window.addImageNode(a.id);
      check('真实文件导入比例',near(ratio(S.design.nodes.at(-1)),2));
      check('原尺寸和原文件保留',a.w===320 && a.h===160 && a.rawFile===file);
      const late={id:window.newId('as'),name:'late.png',path:'assets/late.png',w:0,h:0};
      S.design.assets.push(late); window.addImageNode(late.id);
      const lateNode=S.design.nodes.at(-1);
      const untouched={id:window.newId('as'),name:'changed.png',path:'assets/changed.png',w:0,h:0};
      S.design.assets.push(untouched);window.addImageNode(untouched.id);
      const edited=S.design.nodes.at(-1);edited.w=73;edited.h=31;
      window.loadAssetImage(late.id,c.toDataURL()); window.loadAssetImage(untouched.id,c.toDataURL());
      await new Promise(r=>setTimeout(r,450));
      check('延迟位图比例',near(ratio(lateNode),2));
      check('延迟加载不覆盖手动尺寸',edited.w===73 && edited.h===31);
      window.assetsExpandAll(true);
      const scroll=()=>document.getElementById('assetsBody');
      scroll().scrollTop=450; const before=scroll().scrollTop;
      check('库确实滚动',before>0);
      const dt=new DataTransfer();dt.setData('application/x-ctrl',window.BUILTIN_CONTROLS[0].key);
      const cv=document.getElementById('cv'), rect=cv.getBoundingClientRect(), count=S.design.nodes.length;
      cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
      check('控件真实drop已添加',S.design.nodes.length===count+1);
      check('控件drop保持库位置',scroll().scrollTop===before);
      window.renderAssets();check('再次刷新保持库位置',scroll().scrollTop===before);
      const adt=new DataTransfer();adt.setData('application/x-asset',a.id);
      cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:adt}));
      check('素材drop保持库位置',scroll().scrollTop===before);
      check('素材drop比例',near(ratio(S.design.nodes.at(-1)),2));
      const fdt=new DataTransfer();fdt.items.add(file);const ac=S.design.assets.length;
      cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:fdt}));
      await new Promise(r=>setTimeout(r,450));
      check('外部文件drop已导入',S.design.assets.length===ac+1);
      check('外部文件drop比例',near(ratio(S.design.nodes.at(-1)),2));
      check('外部文件drop保持库位置',scroll().scrollTop===before);
      const icon=document.querySelector('link[rel="icon"]');
      check('图标为本地文件',icon && icon.getAttribute('href')==='branding/icarui-icon.png');
      const im=new Image();im.src=icon.href;await im.decode();
      check('图标可解码为正方形',im.naturalWidth>=256 && im.naturalWidth===im.naturalHeight);
      window.renderAssets();
      return out;
    })()`,60000);
    checks.forEach(c=>ok(c.value,'T7-U '+c.name));
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
