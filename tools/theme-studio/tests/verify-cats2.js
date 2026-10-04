// ============================================================================
// 素材分类：新建 / 删除 / 恢复出厂 / 坏数据回退（v2.34.0）
//
// ## 为什么和 verify-cats.js 分开
//
// 那四条测试原来想加进 verify-cats.js 的 3~6 节，但**跑到第 3 节就 CDP 超时**，
// 而那个求值只是读个 `.length`。试过 5 种办法都没解决（详见那边的文件头）。
//
// **隔离脚本跑同样的操作完全正常** → 问题在"连着跑"，不在操作本身。
// 所以这里**独立成一个套件**：一个全新进程、一个全新 Edge、一个全新页面。
//
// ## 一条通用经验（两次都栽在这）
//
// `renderAssets` 的 stub **必须装在每个求值内部**，不能跨求值安装 ——
// 页面会自己重载，跨求值安装在重载后就没了，于是真 `renderAssets()` 跑起来
// 渲染 319 缩略图 + 112 控件，把渲染进程占住几十秒。
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9360;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
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
    for (let a = 0; a < 3; a++) {
      try {
        const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception || {}).description || ''));
        return r.result.value;
      } catch (err) {
        lastErr = err;
        if (!TRANSIENT.test(String(err && err.message))) throw err;
        await sleep(400 * (a + 1));
      }
    }
    throw lastErr;
  }
}
async function waitReady(cdp, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    try {
      const ok = await cdp.eval("!!(window.CanvasState && (window.BUILTIN_ASSETS||[]).length > 0 && document.getElementById('cv') && document.getElementById('cv').width > 0 && window.BUILTIN_DATA_DONE !== false)");
      if (ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));

// 每个求值第一行都卸掉重渲染 —— 跨求值安装会被页面重载冲掉
const E = (cdp, expr) => cdp.eval('window.renderAssets = function () {}; ' + expr);

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-cats2`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval('try { localStorage.removeItem("icar-studio-asset-kinds"); } catch (e) {}');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);

    // ⚠️⚠️ **开局就把三个原生弹窗 stub 掉**（v2.34.0）——
    //
    // 这是 ⑦ 卡了很久的**真正原因**：`addAssetKind()` 遇到重名会调
    // `window.alert("已经有这个分类了")`，而 **headless Chrome 里 `alert` 会阻塞**
    // 整个渲染进程 → CDP 求值超时。
    //
    // 我原来只在**后面某个用例**里 stub 了 alert，于是重名那一步先卡死了 ——
    // 症状是"第三个求值超时，而那个求值只是读个 .length"，完全看不出和 alert 有关。
    await cdp.eval("window.STUB_DIALOGS = 1; window.alert = function () {}; window.confirm = function () { return true; }; window.prompt = function () { return null; }; 1");

    // ---------------------------------------------------------------- 1. 新建分类
    console.log('\n=== 1. 新建分类 ===');
    const n0 = await E(cdp, 'window.assetKindList().length');
    const add1 = await E(cdp, '(() => { window.prompt = () => "我的分类"; window.addAssetKind(); return window.assetKindList().length; })()');
    eq(add1, n0 + 1, '新建成功（' + n0 + ' → ' + add1 + '）');
    const info = await E(cdp, '(() => { const k = window.customAssetKinds[window.customAssetKinds.length-1]; return JSON.stringify({ n: k.n, v: k.v, custom: window.isCustomAssetKind(k.v) }); })()');
    const IF = JSON.parse(info);
    eq(IF.n, '我的分类', '名字对');
    ok(IF.custom, '被标记为自定义（可删）');
    const dup = await E(cdp, '(() => { const a = window.assetKindList().length; window.addAssetKind(); return window.assetKindList().length === a; })()');
    ok(dup, '**重名不重复添加**');
    const bad = await E(cdp, '(() => { window.prompt = () => "!!!"; window.alert = () => {}; const a = window.assetKindList().length; window.addAssetKind(); return window.assetKindList().length === a; })()');
    ok(bad, '名字生不出有效标识时拒绝');
    const cancel = await E(cdp, '(() => { window.prompt = () => ""; const a = window.assetKindList().length; window.addAssetKind(); return window.assetKindList().length === a; })()');
    ok(cancel, '取消（空输入）不添加');

    // ---------------------------------------------------------------- 2. 删除
    console.log('\n=== 2. 删除分类 ===');
    const delBuiltin = await E(cdp, '(() => { window.confirm = () => true; const a = window.assetKindList().length; window.delAssetKind("background"); return window.assetKindList().length === a; })()');
    ok(delBuiltin, '**内置分类删不掉**');
    const delCustom = await E(cdp, `(() => {
      const S = window.CanvasState;
      const k = window.customAssetKinds[window.customAssetKinds.length - 1].v;
      S.design.assets = S.design.assets || [];
      S.design.assets.push({ id: "cat-del", name: "测试", kind: k, path: "assets/decor/dots.png", w: 120, h: 120 });
      const a = window.assetKindList().length;
      window.delAssetKind(k);
      const still = !!(S.design.assets || []).find(x => x.id === "cat-del");
      S.design.assets = S.design.assets.filter(x => x.id !== "cat-del");
      return JSON.stringify({ 少了一个: window.assetKindList().length === a - 1, 素材还在: still });
    })()`);
    const DC = JSON.parse(delCustom);
    ok(DC.少了一个, '自定义分类能删');
    ok(DC.素材还在, '**删分类不删素材**（它们落到"未分类"）');
    const delCancel = await E(cdp, '(() => { window.confirm = () => false; window.prompt = () => "临时"; window.addAssetKind(); const n = window.assetKindList().length; window.delAssetKind(window.customAssetKinds[window.customAssetKinds.length-1].v); return window.assetKindList().length === n; })()');
    ok(delCancel, '取消确认时不删');

    // ---------------------------------------------------------------- 3. 恢复出厂
    console.log('\n=== 3. 恢复出厂顺序 ===');
    const reset = await E(cdp, `(() => {
      window.confirm = () => true;
      window.prompt = () => "保留我";
      window.addAssetKind();
      window.moveAssetKind(window.assetKindList()[0].v, 3);
      window.resetAssetKinds();
      const list = window.assetKindList().map(k => k.v);
      const defs = window.DEFAULT_ASSET_KINDS.map(k => k.v);
      return JSON.stringify({
        前12个等于出厂: JSON.stringify(list.slice(0, 12)) === JSON.stringify(defs),
        自定义保留: window.customAssetKinds.length >= 1,
        // ⚠️ 不能只比最后一个 —— 前面几节已经加过好几个自定义分类，
        // 要比"整条尾巴"（顺序也要一致）。
        自定义在最后: (function () {
          const tail = list.slice(list.length - window.customAssetKinds.length);
          return JSON.stringify(tail) === JSON.stringify(window.customAssetKinds.map(k => k.v));
        })(),
        显示名也清了: Object.keys(window.assetKindNames).length === 0,
      });
    })()`);
    const RS = JSON.parse(reset);
    ok(RS.前12个等于出厂, '恢复出厂顺序生效（前 12 个与 DEFAULT_ASSET_KINDS 一致）');
    ok(RS.自定义保留, '**自定义分类保留**（恢复的是顺序，不是内容）');
    ok(RS.自定义在最后, '自定义分类排在最后');
    ok(RS.显示名也清了, '显示名覆盖也一起清掉（v2.29.0 起）');

    // ---------------------------------------------------------------- 4. 坏 localStorage
    console.log('\n=== 4. 坏 localStorage 要退回出厂 ===');
    const cases = ['不是 JSON', '{"order": "不是数组"}', '{"order": [1,2,3]}', '{"custom": "不是数组"}', '{"custom": [{"没有v":1}]}', '{"names": 123}', 'null'];
    for (let i = 0; i < cases.length; i++) {
      const r = await E(cdp, `(() => {
        try {
          localStorage.setItem("icar-studio-asset-kinds", ${JSON.stringify(cases[i])});
          window.assetKindOrder = window.DEFAULT_ASSET_KINDS.map(k => k.v);
          window.customAssetKinds = [];
          window.assetKindNames = {};
          window.loadAssetKinds();
          const l = window.assetKindList();
          return JSON.stringify({ n: l.length, 都完整: l.every(k => k && k.v && k.n) });
        } catch (e) { return "抛错: " + String(e.message).slice(0, 50); }
      })()`);
      let R;
      try { R = JSON.parse(r); } catch (e) { R = null; }
      ok(R && R.n >= 12 && R.都完整, `坏数据 case${i}（${String(cases[i]).slice(0, 20)}）不炸、退回出厂且每个分类都有 v/n`);
    }
    await E(cdp, '(() => { localStorage.removeItem("icar-studio-asset-kinds"); return 1; })()');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
