// ============================================================================
// 素材库全面审计（v2.20.0）
//
// 目的：素材从 95 扩到 288 之后，**逐个**验证它们在真实链路里没问题 ——
// 不是抽查几个，而是全量过一遍。查的是"批量生成"最容易出的那类问题：
//   · 尺寸异常（0×0 / 超大 / 极端比例）
//   · data URL 损坏或不是 PNG
//   · 缩略图加载不出来（画布上是个破图）
//   · 加入画布时抛错
//   · 序列化后往返丢失
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9296;
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
    `--user-data-dir=${os.tmpdir()}\\edge-audit`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
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
    console.log('\n=== 0. 页面 JS 错误 ===');
    errs.slice(0, 6).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0].slice(0, 120)));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 清单结构
    console.log('\n=== 1. 清单结构（逐条）===');
    const meta = await cdp.eval(`JSON.stringify((() => {
      const L = window.BUILTIN_ASSETS || [];
      const out = {
        n: L.length,
        badPath: [], badData: [], badSize: [], badLabel: [], badKind: [], badWH: [],
        kinds: {}, paths: {},
      };
      const KNOWN = window.assetKindList().map(k => k.v);
      L.forEach((a, i) => {
        if (!a.path || !/^assets\\/[a-z0-9-]+\\/[a-z0-9-]+\\.png$/.test(a.path)) out.badPath.push(a.path || ('#' + i));
        if (!a.data || a.data.indexOf('data:image/png;base64,') !== 0) out.badData.push(a.path);
        if (typeof a.w !== 'number' || typeof a.h !== 'number' || a.w <= 0 || a.h <= 0) out.badSize.push(a.path);
        if (a.w > 2048 || a.h > 2048) out.badWH.push(a.path + ' ' + a.w + 'x' + a.h);
        if (!a.label || !String(a.label).trim()) out.badLabel.push(a.path);
        if (KNOWN.indexOf(a.kind) < 0) out.badKind.push(a.path + ' kind=' + a.kind);
        out.kinds[a.kind] = (out.kinds[a.kind] || 0) + 1;
        out.paths[a.path] = (out.paths[a.path] || 0) + 1;
      });
      out.dupPaths = Object.keys(out.paths).filter(k => out.paths[k] > 1);
      out.kindCount = Object.keys(out.kinds).length;
      out.emptyKinds = KNOWN.filter(k => !out.kinds[k] && k !== 'custom');
      return out;
    })())`);
    const M = JSON.parse(meta);
    console.log('    · ' + M.n + ' 个素材，' + M.kindCount + ' 个非空分类');
    console.log('    · ' + JSON.stringify(M.kinds));
    eq(M.badPath.length, 0, '每条 path 格式都对（assets/<分类>/<名>.png）' + (M.badPath.length ? '：' + M.badPath.slice(0, 5) : ''));
    eq(M.badData.length, 0, '每条都带合法 PNG data URL' + (M.badData.length ? '：' + M.badData.slice(0, 5) : ''));
    eq(M.badSize.length, 0, '每条 w/h 都是正数' + (M.badSize.length ? '：' + M.badSize.slice(0, 5) : ''));
    eq(M.badWH.length, 0, '没有超过 2048 的超大素材' + (M.badWH.length ? '：' + M.badWH.slice(0, 5) : ''));
    eq(M.badLabel.length, 0, '每条都有中文说明（不是空 label）' + (M.badLabel.length ? '：' + M.badLabel.slice(0, 5) : ''));
    eq(M.badKind.length, 0, '每条 kind 都是已登记的分类' + (M.badKind.length ? '：' + M.badKind.slice(0, 5) : ''));
    eq(M.dupPaths.length, 0, '没有重名（重名会互相覆盖）' + (M.dupPaths.length ? '：' + M.dupPaths.slice(0, 5) : ''));
    eq(M.emptyKinds.length, 0, '没有空分类' + (M.emptyKinds.length ? '：' + M.emptyKinds.join(',') : ''));

    // ---------- 2) 极端比例
    console.log('\n=== 2. 尺寸分布 ===');
    const dist = await cdp.eval(`JSON.stringify((() => {
      const L = window.BUILTIN_ASSETS || [];
      const ratios = L.map(a => a.w / a.h);
      const areas = L.map(a => a.w * a.h);
      return {
        minW: Math.min(...L.map(a => a.w)), maxW: Math.max(...L.map(a => a.w)),
        minH: Math.min(...L.map(a => a.h)), maxH: Math.max(...L.map(a => a.h)),
        extremeList: L.filter(a => (a.w / a.h > 8) || (a.h / a.w > 8)).map(a => a.path),
        tiny: L.filter(a => a.w < 8 || a.h < 8).map(a => a.path + ' ' + a.w + 'x' + a.h),
        totalPx: areas.reduce((s, x) => s + x, 0),
        dataKB: Math.round(L.reduce((s, a) => s + a.data.length, 0) / 1024),
      };
    })())`);
    const D = JSON.parse(dist);
    console.log('    · ' + dist);
    // 极端比例**本身不是错** —— bar/decor 里的分隔线、轨道就是细长的。
    // 要守的是：这类素材不能出现在别的分类里（那说明是画错了）。
    // 「能不能点中」由下面第 3 节的最小尺寸夹取保证。
    const extremeElsewhere = (D.extremeList || []).filter(p => !/assets\/(bar|decor|frame)\//.test(p));
    ok(extremeElsewhere.length === 0,
      `极端比例（>8:1）只出现在 bar/decor/frame 里（共 ${(D.extremeList || []).length} 个，越界的 ${extremeElsewhere.length} 个）` +
      (extremeElsewhere.length ? '：' + extremeElsewhere.slice(0, 5) : ''));
    ok(D.tiny.length === 0, '没有小于 8px 的边' + (D.tiny.length ? '：' + D.tiny.slice(0, 5) : ''));
    ok(D.dataKB < 1200, `清单体积 ${D.dataKB} KB（< 1200 KB，不然工具启动会变慢）`);

    // ---------- 3) 逐个加入画布（全量，不是抽查）
    console.log('\n=== 3. 逐个加入画布（288 个全过）===');
    // ⚠️ **分批跑** —— 288 次连续 addImageNode 会让页面在一次 evaluate 里跑太久，
    // CDP 直接报 "Inspected target navigated or closed"（实测踩到）。
    // 每批 40 个，批间让出一次事件循环。
    const add = await cdp.eval(`(async () => {
      const S = window.CanvasState;
      const L = window.BUILTIN_ASSETS || [];
      const out = { tried: 0, failed: [], arBad: [], tiny: [] };
      const savedNodes = S.design.nodes, savedAssets = S.design.assets;
      S.design.nodes = []; S.design.assets = [];
      const BATCH = 40;
      for (let start = 0; start < L.length; start += BATCH) {
        L.slice(start, start + BATCH).forEach(a => {
          out.tried++;
          try {
            const id = "audit-" + out.tried;
            S.design.assets.push({ id: id, name: a.label, kind: a.kind, path: a.path, data: a.data, w: a.w, h: a.h });
            const n0 = S.design.nodes.length;
            window.addImageNode(id);
            if (S.design.nodes.length !== n0 + 1) { out.failed.push(a.path + " 没加进去"); return; }
            const n = S.design.nodes[S.design.nodes.length - 1];
            const want = a.w / a.h, got = n.w / n.h;
            if (Math.abs(want - got) / want > 0.06) out.arBad.push(a.path + " " + want.toFixed(3) + "→" + got.toFixed(3));
            if (n.w < 6 || n.h < 6) out.tiny.push(a.path + " " + n.w + "x" + n.h);
            // ⚠️ **必须立刻弹掉** —— addImageNode 内部会 commit()，
            // 而 commit 做的是**全量 JSON 快照**。不清的话 288 个节点累积起来
            // 是 O(n²)，页面会被拖死（CDP 报 "Inspected target navigated or closed"）。
            S.design.nodes.pop();
            S.design.assets.pop();
          } catch (e) { out.failed.push(a.path + " 抛错: " + String(e.message).slice(0, 50)); }
        });
        // 让出一次事件循环，别把主线程占死
        await new Promise(r => setTimeout(r, 0));
      }
      S.design.nodes = savedNodes; S.design.assets = savedAssets;
      return JSON.stringify(out);
    })()`);
    const A = JSON.parse(add);
    console.log('    · 试了 ' + A.tried + ' 个，失败 ' + A.failed.length + '，比例异常 ' + A.arBad.length);
    eq(A.tried, M.n, `全部 ${M.n} 个都试过了`);
    eq(A.failed.length, 0, '没有一个抛错/加不进去' + (A.failed.length ? '：' + A.failed.slice(0, 5) : ''));
    eq(A.arBad.length, 0, '**每一个都保持了宽高比**' + (A.arBad.length ? '：' + A.arBad.slice(0, 6) : ''));
    eq(A.tiny.length, 0, '没有一个被缩到 <6px' + (A.tiny.length ? '：' + A.tiny.slice(0, 5) : ''));

    // ---------- 4) data URL 真的能解码成图
    console.log('\n=== 4. data URL 能解码（抽样 40 个，含每类）===');
    const dec = await cdp.eval(`(async () => {
      const L = window.BUILTIN_ASSETS || [];
      // 每类抽几个，保证覆盖所有分类
      const byKind = {};
      L.forEach(a => { (byKind[a.kind] = byKind[a.kind] || []).push(a); });
      const pick = [];
      Object.keys(byKind).forEach(k => { byKind[k].slice(0, 4).forEach(a => pick.push(a)); });
      const out = { tried: 0, bad: [] };
      for (const a of pick) {
        out.tried++;
        const okk = await new Promise(res => {
          const img = new Image();
          img.onload = () => res(img.naturalWidth > 0 && img.naturalHeight > 0);
          img.onerror = () => res(false);
          img.src = a.data;
        });
        if (!okk) out.bad.push(a.path);
      }
      return JSON.stringify(out);
    })()`);
    const DE = JSON.parse(dec);
    console.log('    · ' + dec);
    eq(DE.bad.length, 0, `抽样的 ${DE.tried} 个都能解码成图` + (DE.bad.length ? '：' + DE.bad.slice(0, 5) : ''));
    ok(DE.tried >= 30, `抽样覆盖够广（${DE.tried} 个）`);

    // ---------- 5) 序列化往返（素材不该带 data 进设计文件）
    console.log('\n=== 5. 序列化：data 不能进设计文件 ===');
    const ser = await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const savedNodes = S.design.nodes, savedAssets = S.design.assets;
      const a = (window.BUILTIN_ASSETS || [])[0];
      S.design.assets = [{ id: 'ser1', name: a.label, kind: a.kind, path: a.path, data: a.data, w: a.w, h: a.h }];
      S.design.nodes = [];
      window.addImageNode('ser1');
      const json = window.toV2Json(S.design);
      const back = window.parseDesign(json);
      const out = {
        jsonKB: Math.round(json.length / 1024),
        hasData: json.indexOf('data:image') >= 0,
        errors: back.errors.length,
        assets: back.design.assets.length,
        path: back.design.assets[0] ? back.design.assets[0].path : null,
        wh: back.design.assets[0] ? (back.design.assets[0].w + 'x' + back.design.assets[0].h) : null,
        nodeAssetId: back.design.nodes[0] ? back.design.nodes[0].assetId : null,
      };
      S.design.nodes = savedNodes; S.design.assets = savedAssets;
      return out;
    })())`);
    const SE = JSON.parse(ser);
    console.log('    · ' + ser);
    ok(!SE.hasData, '设计文件里**不含** data URL（否则文件会变成几百 KB 的二进制块）');
    ok(SE.jsonKB < 4, `单个素材的设计文件很小（${SE.jsonKB} KB）`);
    eq(SE.errors, 0, '往返 0 错误');
    eq(SE.assets, 1, '素材往返后还在');
    eq(SE.wh, '256x256', '素材的 w/h 往返后保留');
    ok(SE.nodeAssetId === 'ser1', '节点还指向那个素材');

    // ---------- 6) 搜索能找到新素材
    console.log('\n=== 6. 搜索能找到新分类的素材 ===');
    const search = await cdp.eval(`JSON.stringify((() => {
      // ⚠️ assetQuery 是 panels.js 的**模块内局部变量**，不是 S 上的属性 ——
      // 第一版写 S.assetQuery = '...' 完全没生效（搜索框还是空的），
      // 于是断言失败还以为是搜索坏了。必须用导出的 setAssetQuery。
      const before = document.querySelectorAll('#assetsBody img').length;
      window.setAssetQuery('轨道');
      const after = document.querySelectorAll('#assetsBody img').length;
      const emptyText = (document.querySelector('#assetsBody') || {}).textContent || '';
      // 再搜一个只可能命中 label 的中文词（文件名里没有汉字）
      window.setAssetQuery('胎压');
      const tire = document.querySelectorAll('#assetsBody img').length;
      window.setAssetQuery('');
      const cleared = document.querySelectorAll('#assetsBody img').length;
      return { before: before, hit: after, tire: tire, cleared: cleared, noMatch: emptyText.indexOf('没有匹配') >= 0 };
    })())`);
    const SR = JSON.parse(search);
    console.log('    · ' + search);
    ok(SR.hit > 0, `搜「轨道」能命中素材（${SR.hit} 个缩略图，搜索前 ${SR.before} 个）`);
    ok(SR.tire > 0, `搜**中文 label**「胎压」也能命中（${SR.tire} 个）—— 文件名里没有汉字，靠的是 label`);
    ok(SR.cleared >= SR.hit, `清空搜索后恢复全部（${SR.cleared} 个）`);

    // ---------- 7) 控件编辑器预览（v2.21.0 修的真 bug）
    console.log("\n=== 7. 控件编辑器预览 ===");
    //
    // 用户报的"新建控件里弹出来的界面预览图显示不正常"就是这个：
    // 从控件库新建控件时，make() 里的 ensureBuiltinAsset() 刚把素材登记进
    // S.design.assets，但**位图是异步解码的** —— 预览在解码完成前画出**紫色占位 X**，
    // 而 loadAssetImage 的 onload 只重绘主画布、没重绘预览。
    //
    // 修法：① 画预览前 syncAssetImages() ② onload 里调 redrawEditorPreview()。
    const prev = await cdp.eval(`(async () => {
      const S = window.CanvasState;
      // ⚠️ **只测带素材的控件** —— 两个原因：
      //   1. bug 只出在这类（紫占位 X 是"素材位图没解码"造成的）
      //   2. 40 次 openControlEditor 会把主线程占死，CDP 报
      //      "Inspected target navigated or closed"（实测踩到两次）
      const all = window.BUILTIN_CONTROLS || [];
      const list = all.filter(c => {
        try {
          const n = c.make();
          return !!(n && (n.assetId || (n.states && Object.keys(n.states).some(k => n.states[k] && n.states[k].assetId))));
        } catch (e) { return false; }
      });
      const out = { total: list.length, all: all.length, purple: [], blank: [], err: [] };
      // 只测前 8 个（按分类各取一个更均匀）——
      // bug 是**系统性**的（所有带素材的控件都中招），8 个足够取证；
      // 全跑 15 次 openControlEditor 会把主线程占死，CDP 报 target closed。
      const picked = [];
      const seenCat = {};
      for (const c of list) { if (!seenCat[c.cat] && picked.length < 8) { seenCat[c.cat] = 1; picked.push(c); } }
      for (const c of list) { if (picked.length < 8 && picked.indexOf(c) < 0) picked.push(c); }
      for (const c of picked) {
        try {
          S.design.nodes = []; S.selection = [];
          const node = window.instantiateControl(c.make());
          if (!node) { out.err.push(c.name + " 实例化为空"); continue; }
          S.design.nodes = [node]; S.selection = [node.id];
          window.openControlEditor(node.id);
          // 等位图解码（真实用户看到的就是这个时刻之后的样子）
          await new Promise(r => setTimeout(r, 70));
          const cv = document.getElementById("cePreview");
          if (!cv) { out.err.push(c.name + " 没有预览"); continue; }
          const W = cv.width, H = cv.height;
          const d = cv.getContext("2d").getImageData(0, 0, W, H).data;
          const bg = [d[0], d[1], d[2]];
          let cnt = 0, purple = 0;
          for (let i = 0; i < d.length; i += 4) {
            const R = d[i], G = d[i+1], B = d[i+2];
            if (Math.abs(R-bg[0]) + Math.abs(G-bg[1]) + Math.abs(B-bg[2]) > 18) cnt++;
            if (R > 90 && B > 130 && B > G + 40 && R > G + 20) purple++;
          }
          const needsAsset = !!(node.assetId) || (node.states && Object.keys(node.states).some(k => node.states[k] && node.states[k].assetId));
          // ⚠️ **本身就是叠加层**的素材（暗角、光晕、扫描线、噪点…）画在深色
          // 预览底上几乎看不见 —— 那不是 bug，是素材的性质。
          //
          // 用**名单**而不是"算素材自己的不透明度"：后者要先解码图片，
          // 而 drawImage 是同步的、图片是异步的 —— 算出来恒为 1（第一版就是这么错的），
          // 而且 15 次解码会把主线程占死，CDP 直接报 target closed。
          const OVERLAY = /(vignette|glow|scanline|noise|fade|waves|mesh|hatch|stripes)/;
          const aid2 = node.assetId || (node.states && Object.keys(node.states).map(k => node.states[k] && node.states[k].assetId).find(Boolean)) || "";
          const as2 = (S.design.assets || []).find(x => x.id === aid2) || {};
          const isOverlay = OVERLAY.test(as2.path || "");
          if (cnt === 0 && !isOverlay && node.type !== "group") out.blank.push(c.name);
          if (purple > 200 && needsAsset) out.purple.push(c.name + " " + purple + "px");
          window.closeControlEditor && window.closeControlEditor();
          await new Promise(r => setTimeout(r, 0));
        } catch (e) { out.err.push(c.name + " " + String(e.message).slice(0, 50)); }
      }
      S.design.nodes = [];
      return JSON.stringify(out);
    })()`);
    const PV = JSON.parse(prev);
    console.log("    · 控件库共 " + PV.all + " 个，其中带素材的 " + PV.total + " 个；紫占位 " + PV.purple.length + "，空白 " + PV.blank.length + "，抛错 " + PV.err.length);
    PV.purple.slice(0, 6).forEach(x => console.log("       ⚠️ " + x));
    eq(PV.err.length, 0, "带素材的控件都能打开编辑器" + (PV.err.length ? "：" + PV.err.slice(0, 4) : ""));
    eq(PV.purple.length, 0,
      "**带素材的控件预览不出现紫色占位 X**" + (PV.purple.length ? "（" + PV.purple.length + " 个中招）" : ""));
    ok(PV.total >= 12, "带素材的控件有 " + PV.total + " 个（够验证这条 bug）");
ok(PV.all >= 40, "控件库总共 " + PV.all + " 个");
    eq(PV.blank.length, 0, "带素材的控件预览**都不是空白**" + (PV.blank.length ? "：" + PV.blank.slice(0, 5) : ""));

    // ---------- 8) 控件模板的素材**登记**检查（v2.26.0）
    console.log('\n=== 8. 控件模板的素材登记 ===');
    //
    // 静态守卫只能查"path 在清单里"（v2.20.0 已加）。
    // 但真正会出问题的是**运行时登记**：`make()` 调 `ensureBuiltinAsset(path)`
    // 把素材加进 `S.design.assets`，如果这一步没做/做漏，节点就会带一个
    // **悬空的 assetId** —— 画布上是紫色占位 X，而静态检查完全看不出来。
    //
    // 这条检查跑**全部**控件（不做重活，只是 make + 查表，不会拖死主线程）。
    const reg = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const out = { total: 0, dangling: [], noAsset: [], statesDangling: [] };
      const savedAssets = S.design.assets;
      const savedNodes = S.design.nodes;
      S.design.assets = []; S.design.nodes = [];
      (window.BUILTIN_CONTROLS || []).forEach(c => {
        out.total++;
        let n = null;
        try { n = window.instantiateControl(c.make()); } catch (e) { out.dangling.push(c.name + " make 抛错"); return; }
        if (!n) { out.dangling.push(c.name + " make 返回空"); return; }
        const known = {};
        (S.design.assets || []).forEach(a => { known[a.id] = true; });
        // 节点自己的 assetId
        if (n.assetId && !known[n.assetId]) out.dangling.push(c.name + " assetId=" + n.assetId);
        // 状态系统里的 assetId
        if (n.states) {
          Object.keys(n.states).forEach(k => {
            const sid = n.states[k] && n.states[k].assetId;
            if (sid && !known[sid]) out.statesDangling.push(c.name + "." + k + "=" + sid);
          });
        }
        // 子部件里的 assetId
        (n.parts || []).forEach((p, i) => {
          if (p.assetId && !known[p.assetId]) out.dangling.push(c.name + " parts[" + i + "]=" + p.assetId);
        });
      });
      S.design.assets = savedAssets; S.design.nodes = savedNodes;
      return JSON.stringify(out);
    })()`);
    const RG = JSON.parse(reg);
    console.log('    · 检查了 ' + RG.total + ' 个控件；悬空 assetId ' + RG.dangling.length + '，状态里的 ' + RG.statesDangling.length);
    RG.dangling.slice(0, 6).forEach(x => console.log("       ⚠️ " + x));
    eq(RG.dangling.length, 0,
      "**每个控件引用的素材都真的登记进了设计**（悬空的会画成紫色占位 X）" +
      (RG.dangling.length ? "：" + RG.dangling.slice(0, 5).join(" | ") : ""));
    eq(RG.statesDangling.length, 0,
      "状态系统里的素材也都登记了" + (RG.statesDangling.length ? "：" + RG.statesDangling.slice(0, 4).join(" | ") : ""));
    ok(RG.total >= 100, "控件数够多才有意义（" + RG.total + " 个）");

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(60));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
