// ============================================================================
// probe-file-url.js —— **file:// 直开能力探针**（v2.90.0）
//
// ## 为什么要有它
//
// ICarUI 的硬约束是「**双击 index.html 就能用、零安装、不联网**」。
// 但「双击就能用」这句话**从来没有人逐条验过** ——
// 工具确实是用 `file://` 跑的（每个 verify-*.js 都 `pathToFileURL(index.html)`），
// 可那些套件验的是**功能逻辑**，不是**file:// 这个环境本身**。
//
// 于是有几个问题一直悬着：
//   · `showSaveFilePicker()` 要 secure context —— `file://` 在 Chrome 里算不算？
//   · `Blob` + `URL.createObjectURL` + `<a download>` 这条路在 `file://` 下通不通？
//   · 用户从资源管理器**拖一个 png 进画布**能不能读到字节？
//
// 这个探针把它们**逐条实测出来**，并留下可复读的输出。
//
// ## 它不是套件（刻意）
//
// 文件名是 `probe-*.js`，**不匹配** `run-browser-tests.ps1` 的 `verify-*.js`，
// 所以不进断言数基线、不进 CI 的 68 秒。
// 理由：它**不判对错** —— 它的产出是「file:// 下哪条行、哪条不行」这份**事实**，
// 而不是一组必须全绿的断言。`showSaveFilePicker` 在 file:// 下不存在
// **不是 bug**（工具有 `<a download>` 兜底），把它写成断言会让守卫红着，
// 而「长期红着的守卫 = 没有守卫」。
//
// ## 跑法
//
//   node tools\icarui\tests\probe-file-url.js
//
// 输出：每条带 `[OK] / [NO] / [??]` 前缀 + 实测值（不是"应该没问题"）。
// 退出码恒为 0 —— 它是探针，不是守卫。
// ============================================================================

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不硬编码盘符（同 verify-*.js 的规矩）
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9391;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    const LIMIT = timeoutMs || 15000;
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
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception || {}).description || ''));
    return r.result.value;
  }
}

async function waitReady(cdp, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    try {
      const ok = await cdp.eval("!!(window.CanvasState && (window.BUILTIN_ASSETS||[]).length > 0 && document.getElementById('cv') && document.getElementById('cv').width > 0 && window.BUILTIN_DATA_DONE === true)");
      if (ok) return true;
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

let ok = 0, no = 0, unk = 0;
const OK = m => { ok++; console.log('  [OK] ' + m); };
const NO = m => { no++; console.log('  [NO] ' + m); };
const UNK = m => { unk++; console.log('  [??] ' + m); };

(async () => {
  if (!fs.existsSync(EDGE)) { console.log('找不到 Edge：' + EDGE); process.exit(0); }

  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'edge-fileurlprobe')}`,
    '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

  try {
    let up = false;
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); up = true; break; } catch (e) { await sleep(250); } }
    if (!up) { console.log('Edge 调试端口没起来'); process.exit(0); }

    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);

    // ⚠️ 顺序：先 enable、再 navigate —— 否则脚本/请求事件会漏掉前几个
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });

    console.log('============================================================');
    console.log('file:// 直开能力探针');
    console.log('  目标 URL : ' + URL_PAGE);
    console.log('============================================================');

    // ---------------------------------------------------------------- 0
    console.log('\n=== 0. 页面加载 ===');
    const ready = await waitReady(cdp);
    const doc = JSON.parse(await cdp.eval(`JSON.stringify({
      url: location.href,
      protocol: location.protocol,
      origin: String(location.origin),
      title: document.title,
      readyState: document.readyState,
      isSecureContext: window.isSecureContext,
      hasState: !!window.CanvasState,
      dataDone: window.BUILTIN_DATA_DONE,
      assetCount: (window.BUILTIN_ASSETS||[]).length,
      ctrlCount: (window.BUILTIN_CONTROLS||[]).length,
    })`));
    console.log('    · location.href     = ' + doc.url);
    console.log('    · location.protocol = ' + doc.protocol);
    console.log('    · location.origin   = ' + (doc.origin === 'null' ? '"null"（file:// 的 origin 是空串/null —— 这正是 CORS 挡 fetch 的根因）' : doc.origin));
    console.log('    · document.title    = ' + doc.title);
    console.log('    · readyState        = ' + doc.readyState);
    console.log('    · isSecureContext   = ' + doc.isSecureContext);
    console.log('    · BUILTIN_ASSETS    = ' + doc.assetCount + ' 条');
    console.log('    · BUILTIN_CONTROLS  = ' + doc.ctrlCount + ' 个');
    console.log('    · BUILTIN_DATA_DONE = ' + doc.dataDone);
    if (doc.protocol === 'file:' && doc.readyState === 'complete' && doc.assetCount > 0) OK('页面在 file:// 下加载完成，工具状态对象与素材清单都在');
    else NO('页面没能在 file:// 下加载完成（见上面的实测值）');
    doc.isSecureContext ? OK('isSecureContext = true（file:// 被当作 secure context）')
                        : NO('isSecureContext = false（file:// 不是 secure context → 依赖它的 API 会缺失）');

    // ---------------------------------------------------------------- 1
    console.log('\n=== 1. 全部 js/ + assets/*.js + css 的加载结果 ===');
    const reqs = cdp.events.filter(e => e.method === 'Network.responseReceived').map(e => e.params.response);
    const fileReqs = reqs.filter(r => r.url.startsWith('file://'));
    const bad = fileReqs.filter(r => r.status !== 200 && r.status !== 0);
    // file:// 的 status 实测是 200；status 0 是"没走 HTTP 语义"（也算拿到了内容）
    const byKind = {};
    fileReqs.forEach(r => {
      const u = decodeURIComponent(r.url.replace(/^file:\/\/\//, ''));
      const m = u.match(/\.(js|css|png)$/i);
      const k = m ? m[1].toLowerCase() : 'other';
      byKind[k] = (byKind[k] || 0) + 1;
    });
    const failed = cdp.events.filter(e => e.method === 'Network.loadingFailed');
    console.log('    · 子资源请求共 ' + fileReqs.length + ' 条：' +
      Object.keys(byKind).map(k => k + '=' + byKind[k]).join('  '));
    const jsReqs = fileReqs.filter(r => /\.js(\?|$)/i.test(r.url));
    const jsBad = jsReqs.filter(r => r.status !== 200);
    console.log('    · .js 请求 ' + jsReqs.length + ' 条，非 200 的 ' + jsBad.length + ' 条');
    jsBad.slice(0, 8).forEach(r => console.log('        ✗ ' + decodeURIComponent(r.url) + '  status=' + r.status));
    fileReqs.length > 20 && jsBad.length === 0
      ? OK('全部 ' + jsReqs.length + ' 个 .js 都加载成功（file:// 下经典 <script src> 不受 CORS 限制）')
      : NO('有 .js 没加载成功（' + jsBad.length + ' 条）');
    failed.length === 0
      ? OK('没有任何 Network.loadingFailed（' + fileReqs.length + ' 个子资源全到齐）')
      : NO(failed.length + ' 个请求失败：' + failed.slice(0, 5).map(f => (f.params.errorText || '') + ' ' + f.params.requestId).join(' | '));

    // 显式点名两个字库（任务要求「两个字库 / 所有 js/ 都 200/成功」）
    const libs = JSON.parse(await cdp.eval(`JSON.stringify({
      pinyin: !!(window.PINYIN && Object.keys(window.PINYIN).length) || !!(window.PINYIN_TABLE && Object.keys(window.PINYIN_TABLE).length),
      pinyinKeys: (function(){ var o = window.PINYIN || window.PINYIN_TABLE || {}; return Object.keys(o).length; })(),
      pinyinFn: typeof window.pinyinOf + ',' + typeof window.toPinyin + ',' + typeof window.pyOf,
      dotMatrix: typeof window.FONT_5x7,
      fontFn: typeof window.setNodeFont,
    })`));
    console.log('    · 字库① 拼音表：window.PINYIN/PINYIN_TABLE 共 ' + libs.pinyinKeys + ' 个键；pinyin 函数 = ' + libs.pinyinFn);
    libs.pinyinKeys > 100 ? OK('字库① js/pinyin.js 已加载（' + libs.pinyinKeys + ' 条）') : NO('字库① js/pinyin.js 没加载到（键数 ' + libs.pinyinKeys + '）');
    // 点阵字库在 png.js 里，只在 Node 侧（素材生成用），index.html **本来就不加载它** —— 如实说明
    console.log('    · 字库② 5×7 点阵字库：window.FONT_5x7 = ' + libs.dotMatrix);
    libs.dotMatrix === 'undefined'
      ? UNK('字库②（`png.js` 的 `FONT_5x7`）在浏览器里**不存在** —— 但这是**设计如此**：`index.html` 的 <script> 列表里根本没有 `png.js`（它是 Node 侧素材生成器用的）。**与 file:// 无关**，起本地服务器也一样。`verify-font.js` 在 Node 侧验它')
      : OK('字库② 点阵字库在浏览器里可用（window.FONT_5x7 = ' + libs.dotMatrix + '）');

    // ---------------------------------------------------------------- 2
    console.log('\n=== 2. console 报错 / JS 异常 ===');
    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    const warns = cdp.events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'warning');
    const errText = errs.map(e => (e.params.exceptionDetails ? e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]);
    errs.slice(0, 8).forEach(t => console.log('        ✗ ' + t));
    warns.slice(0, 5).forEach(t => console.log('        ⚠ ' + String(t.params.entry.text).split('\n')[0]));
    errs.length === 0 ? OK('0 条 console error / JS 异常') : NO(errs.length + ' 条 console error / JS 异常（见上）');
    console.log('    · 另有 ' + warns.length + ' 条 warning');

    // ---------------------------------------------------------------- 3
    console.log('\n=== 3. 素材能不能出来（画布上有东西） ===');
    const canvas = JSON.parse(await cdp.eval(`(() => {
      const cv = document.getElementById('cv');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let nonBg = 0, opaque = 0, sum = 0;
      // 画布底色是设计背景；这里数"与左上角像素不同的像素"= 画上去的内容
      const bg = [d[0], d[1], d[2], d[3]];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i+3] > 0) opaque++;
        if (d[i] !== bg[0] || d[i+1] !== bg[1] || d[i+2] !== bg[2]) nonBg++;
        sum += d[i] + d[i+1] + d[i+2];
      }
      // 素材库缩略图：数有多少 <img> 真的解出了像素
      const imgs = Array.from(document.querySelectorAll('#assets img'));
      let decoded = 0;
      imgs.forEach(im => { if (im.complete && im.naturalWidth > 0) decoded++; });
      return JSON.stringify({
        w: cv.width, h: cv.height,
        不透明像素: opaque, 与底色不同的像素: nonBg, 像素和: sum,
        素材库缩略图: imgs.length, 缩略图解出: decoded,
        素材清单条数: (window.BUILTIN_ASSETS||[]).length,
        有内嵌data的: (window.BUILTIN_ASSETS||[]).filter(a => !!a.data).length,
        设计节点数: window.flatten(window.CanvasState.design.nodes).length,
      });
    })()`));
    console.log('    · 画布 ' + canvas.w + '×' + canvas.h + '：不透明像素 ' + canvas.不透明像素 +
      '，与底色不同的像素 ' + canvas.与底色不同的像素 + '，像素和 ' + canvas.像素和);
    console.log('    · 素材库缩略图 ' + canvas.缩略图解出 + '/' + canvas.素材库缩略图 +
      ' 张解出像素（⚠️ 分母小是**正常的**：素材库只把当前可见/已展开分类的 <img> 放进 DOM，不是 359 张全渲染）');
    console.log('    · 素材清单 ' + canvas.素材清单条数 + ' 条，其中带内嵌 data 的 ' + canvas.有内嵌data的 + ' 条');
    console.log('    · 默认设计节点数 ' + canvas.设计节点数);
    canvas.与底色不同的像素 > 1000
      ? OK('画布上确实画了东西（' + canvas.与底色不同的像素 + ' 个像素与底色不同）')
      : NO('画布几乎是空的（只有 ' + canvas.与底色不同的像素 + ' 个像素与底色不同）');
    canvas.缩略图解出 > 20
      ? OK('素材缩略图能解码（' + canvas.缩略图解出 + ' 张 naturalWidth>0 → 内嵌 data URL 在 file:// 下可用）')
      : NO('素材缩略图解不出来（只有 ' + canvas.缩略图解出 + ' 张）');
    // 懒加载的 11 个 builtin-data-*.js（app.js 用 createElement("script") 动态注入）——
    // 它们走的是**动态 <script>**，是 file:// 下最值得确认的一条
    const lazy = JSON.parse(await cdp.eval(`(() => {
      const A = window.BUILTIN_ASSETS || [];
      const withData = A.filter(a => typeof a.data === 'string' && a.data.length > 100);
      const kinds = {};
      A.forEach(a => { if (typeof a.data === 'string' && a.data.length > 100) kinds[a.kind] = (kinds[a.kind]||0)+1; });
      return JSON.stringify({ total: A.length, withData: withData.length, kinds: kinds, done: window.BUILTIN_DATA_DONE });
    })()`));
    console.log('    · 懒加载数据（assets/builtin-data-*.js，11 个分类）：BUILTIN_DATA_DONE=' + lazy.done +
      '，带真实 data 的素材 ' + lazy.withData + '/' + lazy.total + ' 条');
    console.log('      按分类：' + JSON.stringify(lazy.kinds));
    lazy.done && lazy.withData === lazy.total
      ? OK('11 个懒加载数据文件全部注入成功（' + lazy.withData + ' 条素材都有内嵌 base64）—— 动态 <script> 在 file:// 下可用')
      : NO('懒加载没跑完或部分缺失（' + lazy.withData + '/' + lazy.total + '，DONE=' + lazy.done + '）');

    // 真放一个素材到画布上，确认"素材能出来"不是只靠背景
    const dropIn = JSON.parse(await cdp.eval(`(() => {
      const before = window.flatten(window.CanvasState.design.nodes).length;
      let added = null, err = null;
      try {
        const a = (window.BUILTIN_ASSETS || []).find(x => x.data && /\\/icon\\//.test(x.path)) || (window.BUILTIN_ASSETS||[]).find(x => x.data);
        if (!a) { err = '清单里没有带 data 的素材'; }
        else {
          window.CanvasState.design.assets.push(JSON.parse(JSON.stringify({ id: a.id || a.path, path: a.path, name: a.name || a.path, w: a.w, h: a.h, data: a.data })));
          window.addImageNode(a.id || a.path);
          added = a.path;
        }
      } catch (e) { err = String(e && e.message || e); }
      window.draw();
      const cv = document.getElementById('cv');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 0) n++;
      return JSON.stringify({ before: before, after: window.flatten(window.CanvasState.design.nodes).length, added: added, err: err, 不透明像素: n });
    })()`));
    console.log('    · 放入素材 ' + dropIn.added + '：节点 ' + dropIn.before + ' → ' + dropIn.after +
      '，画布不透明像素 ' + dropIn.不透明像素 + (dropIn.err ? '  错误=' + dropIn.err : ''));
    dropIn.added && !dropIn.err ? OK('能往画布上加素材节点并画出来') : NO('加素材失败：' + dropIn.err);

    // ---------------------------------------------------------------- 4
    console.log('\n=== 4. 导出：Blob + URL.createObjectURL + <a download> ===');
    // 拦 <a>.click()，看**真的被调用**了、href 是不是 blob:/data:、download 名对不对
    await cdp.eval(`(() => {
      window.__dl = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        try {
          window.__dl.push({ download: this.download || null, href: String(this.href).slice(0, 64), isBlob: /^blob:/.test(String(this.href)), isData: /^data:/.test(String(this.href)) });
        } catch (e) {}
        // ⚠️ **不真的调用原 click**：headless 里真下载会写文件 + 弹下载栏，
        // 而且我们只需要证明"这条路被走到了"。
      };
      window.__origAnchorClick = orig;
      // 顺便把 Blob 大小也量出来
      window.__blobs = [];
      const OB = URL.createObjectURL.bind(URL);
      URL.createObjectURL = function (b) { try { window.__blobs.push(b && b.size); } catch (e) {} return OB(b); };
      return 1;
    })()`);

    const exportJson = JSON.parse(await cdp.eval(`(() => {
      window.__dl.length = 0; window.__blobs.length = 0;
      try { window.saveFile(); } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
      return JSON.stringify({ downloads: window.__dl.slice(), blobSizes: window.__blobs.slice() });
    })()`));
    console.log('    · 保存（导出 JSON）：downloads=' + JSON.stringify(exportJson.downloads) + '  blob 字节=' + JSON.stringify(exportJson.blobSizes));
    (exportJson.downloads || []).some(d => d.isBlob && d.download)
      ? OK('导出 JSON 走了 blob: + <a download>（Blob 与 createObjectURL 在 file:// 下可用）')
      : NO('导出 JSON 没能走到 <a download>：' + JSON.stringify(exportJson));

    const exportPng = JSON.parse(await cdp.eval(`(() => {
      window.__dl.length = 0;
      let warn = null;
      const ow = console.warn; console.warn = function () { warn = Array.from(arguments).map(String).join(' '); ow.apply(console, arguments); };
      try { window.exportPng(); } catch (e) { console.warn = ow; return JSON.stringify({ err: String(e && e.message || e) }); }
      console.warn = ow;
      return JSON.stringify({ downloads: window.__dl.slice(), warn: warn });
    })()`));
    console.log('    · 导出图（PNG）：downloads=' + JSON.stringify(exportPng.downloads) + (exportPng.warn ? '  warn=' + exportPng.warn : ''));
    (exportPng.downloads || []).some(d => d.isData && d.download)
      ? OK('导出 PNG 走了 data: + <a download>（toDataURL 没被画布污染挡住）')
      : NO('导出 PNG 失败：' + JSON.stringify(exportPng));

    // 设计包（.icarzip）—— 这是 Blob(二进制) 那条路
    const exportPack = JSON.parse(await cdp.eval(`(async () => {
      window.__dl.length = 0; window.__blobs.length = 0;
      try { await window.exportPackage(); } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
      return JSON.stringify({ downloads: window.__dl.slice(), blobSizes: window.__blobs.slice(),
        report: window.__lastPackReport ? { ok: window.__lastPackReport.ok, entries: window.__lastPackReport.counts } : null });
    })()`));
    console.log('    · 设计包（.icarzip）：downloads=' + JSON.stringify(exportPack.downloads) +
      '  blob 字节=' + JSON.stringify(exportPack.blobSizes) +
      '  自检=' + JSON.stringify(exportPack.report));
    (exportPack.downloads || []).some(d => d.isBlob && /\.icarzip$/.test(d.download || ''))
      ? OK('导出设计包走了 blob: + <a download>（二进制 Blob 在 file:// 下可用）')
      : NO('导出设计包失败：' + JSON.stringify(exportPack));
    if (exportPack.report && exportPack.report.ok) OK('包导出后自检通过（' + JSON.stringify(exportPack.report.entries) + '）');

    // ---------------------------------------------------------------- 5
    console.log('\n=== 5. showSaveFilePicker / showOpenFilePicker / showDirectoryPicker ===');
    const pickers = JSON.parse(await cdp.eval(`(async () => {
      // ⚠️ README 里那张表写着「IndexedDB 被拒绝」。**光看 typeof 不够** ——
      //    对象存在但 open() 可能被拒。这里真的开一次库，把结论钉在实测上。
      const idbOpen = await new Promise(function (res) {
        if (!window.indexedDB) return res('没有 indexedDB 对象');
        var done = false;
        var finish = function (v) { if (!done) { done = true; res(v); } };
        setTimeout(function () { finish('timeout（既没成功也没失败）'); }, 3000);
        try {
          var req = indexedDB.open('__icarui_probe', 1);
          req.onupgradeneeded = function () { /* 首次建库，正常 */ };
          req.onsuccess = function () { try { req.result.close(); indexedDB.deleteDatabase('__icarui_probe'); } catch (e) {} finish('open 成功'); };
          req.onerror = function () { finish('open 失败：' + (req.error && req.error.name)); };
          req.onblocked = function () { finish('open blocked'); };
        } catch (e) { finish('open 抛异常：' + (e && e.name)); }
      });
      return JSON.stringify({
        showSaveFilePicker: typeof window.showSaveFilePicker,
        showOpenFilePicker: typeof window.showOpenFilePicker,
        showDirectoryPicker: typeof window.showDirectoryPicker,
        isSecureContext: window.isSecureContext,
        crossOriginIsolated: window.crossOriginIsolated,
        hasFileSystemHandle: typeof window.FileSystemHandle,
        hasFileSystemFileHandle: typeof window.FileSystemFileHandle,
        clipboardWrite: typeof (navigator.clipboard && navigator.clipboard.write),
        localStorage: (function(){ try { localStorage.setItem('__probe','1'); var v = localStorage.getItem('__probe'); localStorage.removeItem('__probe'); return 'ok(' + v + ')'; } catch(e) { return 'THROWS: ' + e.name; } })(),
        indexedDB: typeof window.indexedDB,
        idbOpen: idbOpen,
        cryptoSubtle: typeof (window.crypto && window.crypto.subtle),
        worker: typeof window.Worker,
        fetch: typeof window.fetch,
      });
    })()`));
    console.log('    · window.showSaveFilePicker      = ' + pickers.showSaveFilePicker);
    console.log('    · window.showOpenFilePicker      = ' + pickers.showOpenFilePicker);
    console.log('    · window.showDirectoryPicker     = ' + pickers.showDirectoryPicker);
    console.log('    · window.FileSystemFileHandle    = ' + pickers.hasFileSystemFileHandle);
    console.log('    · isSecureContext                = ' + pickers.isSecureContext);
    console.log('    · crossOriginIsolated            = ' + pickers.crossOriginIsolated);
    console.log('    · navigator.clipboard.write      = ' + pickers.clipboardWrite);
    console.log('    · localStorage                   = ' + pickers.localStorage);
    console.log('    · indexedDB 对象 / 真 open()      = ' + pickers.indexedDB + ' / ' + pickers.idbOpen);
    console.log('    · crypto.subtle / Worker / fetch = ' + pickers.cryptoSubtle + ' / ' + pickers.worker + ' / ' + pickers.fetch);
    /open 成功/.test(pickers.idbOpen)
      ? OK('IndexedDB 在 file:// 下**可用**（' + pickers.idbOpen + '）—— ⚠️ README 那张表原来写"被拒绝"，**实测不成立**，已按实测改')
      : OK('IndexedDB 在 file:// 下不可用（' + pickers.idbOpen + '）—— 与 README 那张表一致')
    pickers.showSaveFilePicker === 'undefined'
      ? NO('showSaveFilePicker 在 file:// 下**不存在**（' + pickers.showSaveFilePicker + '）—— 好在工具**根本没用它**（全库 0 处引用，导出走 <a download>）')
      : OK('showSaveFilePicker 存在（' + pickers.showSaveFilePicker + '）');

    // 真的调一下，把真实报错也记下来（比 typeof 更有说服力）
    const pickerCall = await cdp.eval(`(async () => {
      if (typeof window.showSaveFilePicker !== 'function') return 'not a function';
      try { const h = await window.showSaveFilePicker({ suggestedName: 'probe.txt' }); return 'resolved: ' + typeof h; }
      catch (e) { return 'threw: ' + (e && e.name) + ' / ' + (e && e.message); }
    })()`);
    console.log('    · 真调用 showSaveFilePicker() → ' + pickerCall);

    // ---------------------------------------------------------------- 6
    console.log('\n=== 6. 导入：<input type=file> + FileReader + 拖放 ===');
    const importRes = JSON.parse(await cdp.eval(`(async () => {
      const out = {};
      // (a) 造一个真的 File，塞进真的 input[type=file]，再走真的 change 事件
      //
      // ⚠️ **名字要写进 meta.name**，不是顶层的 design.name。
      // toV2Json 写的是 meta:{name:rd.name}，而 parseDesign 读的也是 meta.name ——
      // 顶层那个 name 根本不是文件格式的一部分。
      // 第一版探针写错了字段（design.name = …），于是"导入后名字没变"
      // 被报成「导入不行」—— 那是**探针的错**，不是工具的错。
      const design = JSON.parse(window.toV2Json(window.CanvasState.design));
      design.meta.name = 'probe-import';
      const file = new File([JSON.stringify(design)], 'probe.json', { type: 'application/json' });
      out.fileOk = file.size > 0;
      // DataTransfer 是**把 File 塞进 input.files 的唯一标准途径**
      let dt = null;
      try { dt = new DataTransfer(); dt.items.add(file); } catch (e) { out.dtErr = String(e && e.message || e); }
      out.hasDataTransfer = !!dt;
      if (!dt) return JSON.stringify(out);
      // 拦截 pickFile() 造的那个 input：钩 document.createElement
      const origCreate = document.createElement.bind(document);
      let captured = null;
      document.createElement = function (tag) {
        const el = origCreate(tag);
        if (String(tag).toLowerCase() === 'input') {
          captured = el;
          const origClick = el.click.bind(el);
          el.click = function () { /* 不真弹对话框：headless 里会挂住 */ };
        }
        return el;
      };
      window.confirm = function () { return true; };
      try { window.pickFile(); } catch (e) { out.pickErr = String(e && e.message || e); }
      document.createElement = origCreate;
      out.gotInput = !!captured && captured.type === 'file';
      if (!captured) return JSON.stringify(out);
      out.accept = captured.accept;
      // 塞文件 + 触发 change（就是用户选完文件后浏览器做的事）
      try { captured.files = dt.files; } catch (e) { out.assignErr = String(e && e.message || e); }
      out.filesLen = captured.files ? captured.files.length : -1;
      const beforeName = window.CanvasState.design.name;
      captured.onchange && captured.onchange();
      // FileReader 是异步的，等一拍
      await new Promise(r => setTimeout(r, 900));
      out.beforeName = beforeName;
      out.afterName = window.CanvasState.design.name;
      out.jsonAreaHead = String((document.getElementById('jsonArea') || {}).value || '').slice(0, 40);
      out.imported = window.CanvasState.design.name === 'probe-import';
      return JSON.stringify(out);
    })()`));
    console.log('    · 造 File 成功            = ' + importRes.fileOk);
    console.log('    · DataTransfer 可用       = ' + importRes.hasDataTransfer + (importRes.dtErr ? '  err=' + importRes.dtErr : ''));
    console.log('    · pickFile() 造出 input   = ' + importRes.gotInput + '  accept=' + importRes.accept);
    console.log('    · input.files 可赋值      = ' + (importRes.filesLen > 0 ? '是（' + importRes.filesLen + ' 个）' : '否 ' + (importRes.assignErr || '')));
    console.log('    · 设计名 ' + importRes.beforeName + ' → ' + importRes.afterName + '（jsonArea 开头：' + JSON.stringify(importRes.jsonAreaHead) + '）');
    importRes.imported
      ? OK('导入可用：真 File + DataTransfer + change 事件 → FileReader 读到内容并回灌进设计（名字变成 probe-import）')
      : NO('导入没能生效（实测 ' + JSON.stringify(importRes) + '）');

    // (b) 拖放：走真的 drop 事件 + dataTransfer.files
    const dropRes = JSON.parse(await cdp.eval(`(async () => {
      const cv = document.getElementById('cv');
      const png = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
      const bytes = new Uint8Array(png.length); for (let i = 0; i < png.length; i++) bytes[i] = png.charCodeAt(i);
      const f = new File([bytes], 'probe.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(f);
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      const n0 = window.flatten(window.CanvasState.design.nodes).length;
      cv.dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 700));
      return JSON.stringify({ filesInDt: dt.files.length, nodesBefore: n0,
        nodesAfter: window.flatten(window.CanvasState.design.nodes).length,
        assets: (window.CanvasState.design.assets||[]).length,
        customAssets: (window.CanvasState.design.assets||[]).filter(a => a.rawFile || /custom/.test(a.path||'')).length });
    })()`));
    console.log('    · 拖放事件：dataTransfer.files=' + dropRes.filesInDt + '，素材数 ' + dropRes.assets +
      '（custom 类 ' + dropRes.customAssets + '），节点 ' + dropRes.nodesBefore + ' → ' + dropRes.nodesAfter);
    dropRes.nodesAfter > dropRes.nodesBefore
      ? OK('拖放 png 进画布可用（新建了图片控件）')
      : NO('拖放 png 没能建出控件（素材数 ' + dropRes.assets + ' → 可能是 importAsset 的 FileReader/Image 在 file:// 下受限）');

    // ---------------------------------------------------------------- 7
    console.log('\n=== 7. file:// 下明确**不行**的东西（fetch / XHR / ES module / 本地路径读图） ===');
    const limits = JSON.parse(await cdp.eval(`(async () => {
      const out = {};
      // fetch 相对路径
      try { const r = await fetch('assets/builtin-index.js'); out.fetchRelative = 'ok ' + r.status; }
      catch (e) { out.fetchRelative = 'threw: ' + (e && e.name) + ' / ' + String(e && e.message).slice(0, 90); }
      // fetch file:// 绝对
      try { const r = await fetch(location.href); out.fetchFileAbs = 'ok ' + r.status; }
      catch (e) { out.fetchFileAbs = 'threw: ' + (e && e.name); }
      // XHR
      out.xhr = await new Promise(res => {
        try { const x = new XMLHttpRequest(); x.open('GET', 'assets/builtin-index.js'); x.onload = () => res('ok ' + x.status); x.onerror = () => res('onerror（status ' + x.status + '）'); x.send(); }
        catch (e) { res('threw: ' + (e && e.name)); }
      });
      // 用 <img> 按**相对路径**加载磁盘上的 png（不是 data URL）
      out.imgByPath = await new Promise(res => {
        const im = new Image();
        im.onload = () => res('loaded ' + im.naturalWidth + 'x' + im.naturalHeight);
        im.onerror = () => res('onerror');
        im.src = 'assets/icon/abs.png';
        setTimeout(() => res('timeout'), 2500);
      });
      // 画布会不会被"按路径加载的图"污染
      try {
        const cv = document.getElementById('cv');
        const c2 = document.createElement('canvas'); c2.width = 4; c2.height = 4;
        const g = c2.getContext('2d');
        const im = new Image();
        await new Promise(r => { im.onload = r; im.onerror = r; im.src = 'assets/icon/abs.png'; });
        g.drawImage(im, 0, 0);
        c2.toDataURL();
        out.taint = '不污染（toDataURL 成功）';
      } catch (e) { out.taint = '污染：' + (e && e.name); }
      return JSON.stringify(out);
    })()`));
    console.log('    · fetch("assets/builtin-index.js")  = ' + limits.fetchRelative);
    console.log('    · fetch(location.href)              = ' + limits.fetchFileAbs);
    console.log('    · XHR("assets/builtin-index.js")    = ' + limits.xhr);
    console.log('    · <img src="assets/icon/abs.png">   = ' + limits.imgByPath);
    console.log('    · 按路径加载的图画进 canvas 后 toDataURL = ' + limits.taint);
    /threw|onerror/.test(limits.fetchRelative) ? OK('确认 fetch 在 file:// 下被挡（这正是工具全用经典 <script> 的理由）') : UNK('fetch 居然通了：' + limits.fetchRelative);
    /loaded/.test(limits.imgByPath) ? OK('<img> 按相对路径能加载磁盘上的 png（file:// 下图片不受 CORS 限制）') : UNK('<img> 按路径加载：' + limits.imgByPath);

    // ---------------------------------------------------------------- 8
    console.log('\n=== 8. 收尾统计 ===');
    const finalReqs = cdp.events.filter(e => e.method === 'Network.responseReceived').length;
    console.log('    · 全程子资源请求 ' + finalReqs + ' 条');
    console.log('    · console error/异常 ' + errs.length + ' 条');
    console.log('    · 素材清单 ' + canvas.素材清单条数 + ' 条，全部带内嵌 data 的 ' + canvas.有内嵌data的);

    await cdp.ws.close();
  } catch (e) {
    console.log('  [!!] 探针自身出错: ' + (e && e.stack || e));
  } finally {
    try { proc.kill(); } catch (e) {}
  }

  console.log('\n' + '='.repeat(60));
  console.log('探针结果：OK=' + ok + '  NO=' + no + '  拿不准=' + unk);
  console.log('（探针**不判对错**、退出码恒为 0 —— 它的产出是事实，不是门禁）');
  console.log('='.repeat(60));
  process.exit(0);
})();
