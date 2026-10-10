// ============================================================================
// 素材分类的功能测试（v2.26.0）
//
// ## 为什么单独一个套件
//
// 这段测试原来想塞进 verify-studio2，但那里 `cdp` 句柄**不在作用域内**
// （它在那个文件的闭包里），试过报 `cdp is not defined`，我当时的处理是
// **把坏代码删掉**并留了说明 —— 于是"排序真的生效了吗"一直没测。
//
// 单独一个文件就没有这个问题：cdp 在这里是顶层变量。
//
// ## 测什么
//
// 分类的**顺序**与**增删**都是持久化的用户状态，改错了会静默丢配置：
//   · moveAssetKind 真的换了顺序，而且写进了 localStorage
//   · addAssetKind 新建成功、重名不重复、名字生不出标识时拒绝
//   · delAssetKind 只删分类不删素材；内置分类删不掉
//   · resetAssetKinds 恢复出厂顺序但保留自定义分类
//   · 坏 localStorage 数据要**退回出厂**，不能让素材库整个坏掉
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9330;
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
        await sleep(350 * (attempt + 1));
      }
    }
    throw lastErr;
  }
}
/**
 * 求值，并在**页面重新加载**后自动恢复。
 *
 * ## 为什么需要
 *
 * 实测：跑到第 4 节时 `window.CanvasState` / `window.assetKindList` 全变 undefined，
 * 而 `#cv` 还在 —— 说明**页面重新加载了**（HTML 在，脚本还没跑完）。
 *
 * 这**不是** CDP 错误（求值本身成功了），所以 eval 里的瞬时错误重试抓不到它。
 * 只能在"结果看起来像新页面"时自己判断并等回来。
 *
 * 判据：脚本全局没了（`CanvasState` undefined）。那就等就绪，再求一次。
 */
async function evalReady(cdp, expr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const alive = await cdp.eval("typeof window.CanvasState !== 'undefined'");
    if (alive) return cdp.eval(expr);
    console.log("       ↻ 页面重新加载了，等它就绪…（第 " + (attempt + 1) + " 次）");
    await waitReady(cdp, 15000);
  }
  return cdp.eval(expr);
}



async function waitReady(cdp, timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 20000;
  while (Date.now() - t0 < limit) {
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

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-cats`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    // 清掉可能残留的分类配置，拿确定性基线
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval('try { localStorage.removeItem("icar-studio-asset-kinds"); } catch (e) {}');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);

    // ⚠️ **把 renderAssets 换成空实现**（v2.26.0）。
    //
    // 这些分类操作内部都会调 `renderAssets()` 重渲染整个素材库 ——
    // 现在是 **319 个缩略图 + 112 个控件芯片**，连着调几次会让渲染进程
    // 崩掉、页面自动重载（实测：`window.CanvasState` 变 undefined 而 `#cv` 还在）。
    //
    // 这个套件测的是**分类逻辑**，不是渲染。stub 掉之后又快又稳。
    // 渲染本身由 verify-assets / verify-geo 覆盖。
    await cdp.eval(`(() => {
      window.renderAssetsStub = window.renderAssets;
      window.renderAssets = function () { /* 测试里不重渲染 */ };
      return 1;
    })()`);

    console.log('\n=== 1. 出厂基线 ===');
    const base = await cdp.eval(`JSON.stringify({
      kinds: window.assetKindList().length,
      defaults: window.DEFAULT_ASSET_KINDS.length,
      custom: window.customAssetKinds.length,
      first: window.assetKindList()[0].v,
      hasFns: ["moveAssetKind","addAssetKind","delAssetKind","resetAssetKinds","loadAssetKinds"]
        .every(f => typeof window[f] === "function"),
    })`);
    const B = JSON.parse(base);
    console.log('    · ' + base);
    eq(B.kinds, 12, '出厂 12 个分类');
    eq(B.defaults, 12, 'DEFAULT_ASSET_KINDS 也是 12');
    eq(B.custom, 0, '没有自定义分类');
    ok(B.hasFns, '五个分类操作函数都在');

    console.log('\n=== 2. 排序：真的换序 + 持久化 ===');
    const mv = await cdp.eval(`(() => {
      // ⚠️ **必须先卸掉 renderAssets**（v2.26.0）。
      //
      // moveAssetKind 内部会调 renderAssets() —— 现在要渲染
      // **319 个缩略图 + 112 个控件芯片**，会把渲染进程占住几十秒。
      // 这一节自己的求值能跑完（所以之前看起来"通过"），但**渲染进程已经被占**，
      // 于是下一节的求值直接超时 25 秒 —— 症状是"第 3 节第一个求值就卡死"，
      // 而那个求值只是读个 .length，完全看不出关联。
      window.renderAssets = function () {};
      const before = window.assetKindList().map(k => k.v);
      window.moveAssetKind(before[0], 1);
      const after = window.assetKindList().map(k => k.v);
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem("icar-studio-asset-kinds") || "{}").order; } catch (e) {}
      // 越界不崩
      let crashed = false;
      try { window.moveAssetKind(after[0], -1); window.moveAssetKind(after[after.length-1], 1); } catch (e) { crashed = true; }
      return JSON.stringify({
        前: before.slice(0, 3), 后: after.slice(0, 3),
        换了: before[0] !== after[0] && before[1] === after[0],
        数量不变: before.length === after.length,
        持久化的第一个: stored ? stored[0] : null,
        越界没崩: !crashed,
      });
    })()`);
    const MV = JSON.parse(mv);
    console.log('    · ' + mv);
    ok(MV.换了, '下移第一个分类后顺序真的变了（' + MV.前.join(',') + ' → ' + MV.后.join(',') + '）');
    ok(MV.数量不变, '排序不影响分类数量');
    eq(MV.持久化的第一个, MV.后[0], '新顺序**写进了 localStorage**');
    ok(MV.越界没崩, '越界移动不崩（第一个再上移 / 最后一个再下移）');

    // ================================================================
    // ⚠️ **3~6 节还没做**（本轮明确留下的缺口，不是忘了写）
    // ================================================================
    //
    // 要测的：新建分类 / 删除（内置删不掉、素材不丢）/ 恢复出厂 / 坏 localStorage 回退。
    //
    // **卡在哪**：跑到第 3 节的第一个求值就 `CDP 超时（25000ms）`，
    // 而那个求值只是读 `window.assetKindList().length` —— 说明渲染进程在前面积累了负担。
    //
    // **已经试过**（都没解决）：
    //   · 加 `send()` 超时 —— 把"挂死"变成"失败"，能定位了，但没消除
    //   · 每节之前 `Page.navigate` 重载 —— 反而引入导航竞态
    //   · 把 `renderAssets` 换成空实现（第 2 节也补了）—— 仍超时
    //   · 把第 3 节拆成 6 个独立求值 —— 第一个就超时
    //   · 单独的隔离脚本跑同样的操作 —— **全部正常，不超时**
    //
    // 所以问题在"连着跑"而不是"某个操作"。下一步值得试的方向：
    //   · 把 3~6 节挪到**独立的套件文件**（每节一次全新的 Edge + 页面）
    //   · 或者查 `moveAssetKind` 到底有没有真的被 stub 掉
    //
    // 当前实际覆盖到的是第 1~2 节：出厂基线 + 排序真的换序并持久化。
    // 这已经是原本**完全没有覆盖**的部分（`moveAssetKind` 之前一条断言都没有）。

    console.log('\n=== 3. 分类改名 + 素材跨分类移动 ===');
    //
    // ⚠️ 每个求值第一行都卸掉 renderAssets（页面可能已重载），
    //   而且**只能在求值内部**卸 —— 跨求值安装的 stub 会被重载冲掉（踩过）。
    const E3 = async (expr) => cdp.eval("window.renderAssets = function () {}; " + expr);

    // --- 改名只动显示名，不动标识
    const rn = await E3(`(() => {
      const out = {};
      out.原显示名 = window.assetKindName("background");
      out.原标识 = window.assetKindList().find(k => k.v === "background").v;
      window.prompt = () => "我的背景";
      window.renameAssetKind("background");
      out.新显示名 = window.assetKindName("background");
      out.标识没变 = window.assetKindList().find(k => k.v === "background").v === "background";
      out.写进了覆盖表 = window.assetKindNames["background"] === "我的背景";
      let stored = null;
      try { stored = JSON.parse(localStorage.getItem("icar-studio-asset-kinds") || "{}").names; } catch (e) {}
      out.持久化了 = !!(stored && stored["background"] === "我的背景");
      // 恢复出厂名
      window.resetAssetKindName("background");
      out.恢复后 = window.assetKindName("background");
      // 空输入不改
      window.prompt = () => "";
      window.renameAssetKind("dashboard");
      out.空输入不改 = !window.assetKindNames["dashboard"];
      return JSON.stringify(out);
    })()`);
    const RN = JSON.parse(rn);
    console.log('    · ' + rn);
    eq(RN.新显示名, "我的背景", "改名生效");
    eq(RN.原标识, "background", "标识本来就是 background");
    ok(RN.标识没变, "**改名不动标识**（标识是设计文件里的契约）");
    ok(RN.写进了覆盖表, "写进了 assetKindNames");
    ok(RN.持久化了, "**改名写进了 localStorage**");
    eq(RN.恢复后, "背景", "恢复出厂名生效");
    ok(RN.空输入不改, "空输入（取消）不改名");

    // --- 移动素材只改 kind，不动 path
    const mv2 = await E3(`(() => {
      const S = window.CanvasState;
      const out = {};
      S.design.assets = S.design.assets || [];
      S.design.assets.push({ id: "mv-test", name: "测试素材", kind: "decor",
        path: "assets/decor/dots.png", w: 120, h: 120 });
      window.moveAssetToKind("mv-test", "icon");
      const a = S.design.assets.find(x => x.id === "mv-test");
      out.kind = a.kind;
      out.path没变 = a.path === "assets/decor/dots.png";
      out.w没变 = a.w === 120;
      // 同分类再移一次是空操作
      const before = a.kind;
      window.moveAssetToKind("mv-test", "icon");
      out.同分类不动 = a.kind === before;
      // 不存在的素材不崩
      let crashed = false;
      try { window.moveAssetToKind("不存在", "icon"); } catch (e) { crashed = true; }
      out.不存在不崩 = !crashed;
      S.design.assets = S.design.assets.filter(x => x.id !== "mv-test");
      return JSON.stringify(out);
    })()`);
    const MV2 = JSON.parse(mv2);
    console.log('    · ' + mv2);
    eq(MV2.kind, "icon", "素材移到了新分类");
    ok(MV2.path没变, "**只改 kind，不动 path**（磁盘文件不动，老设计文件的相对路径不会失效）");
    ok(MV2.w没变, "尺寸等信息没动");
    ok(MV2.同分类不动, "移到同一个分类是空操作");
    ok(MV2.不存在不崩, "移动不存在的素材不崩");

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
