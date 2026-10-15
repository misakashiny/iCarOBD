// ============================================================================
// 素材接线守卫（v2.86.0）
//
// ## 为什么单开一个套件
//
// 「控件引用了不存在的素材」和「控件引用了**空图**素材」是同一类故障的两种形态，
// 而且**都是静默的**：
//
//   1. **路径不存在** —— 拖出来是一个紫色大 X。`check-build-guard.ps1` 的
//      「素材引用完整性」已经查了（path 在不在磁盘上），这里**再查一遍反向**：
//      控件引用的 path 必须能在 `BUILTIN_ASSETS` 里找到**并且带 data URL**
//      （只在磁盘上、不在清单里 → 登记出来的素材没有 data → 导出 PNG 抛 SecurityError）。
//   2. **路径存在但整张图全透明** —— 静态检查完全看不出来：图能加载、
//      `naturalWidth > 0`、清单里也在，就是**画到深色底上什么都没有**。
//      实测 7 个素材 0 个不透明像素，其中 `assets/background/vignette.png`
//      正被控件 `img_bgvign` 引用 —— 也就是**用户拖一个"暗角背景"出来，什么都不会出现**。
//
// 第 2 条只有**看像素**才查得出来，所以这个套件在 Node 侧解码 PNG。
// 见 `_common.js` 的 `decodePng` / `opaquePixels`。
//
// ## 「已知待办」而不是硬白名单
//
// 空图是**存量缺陷**（生成器的 `c.fill()` alpha 单位写错，见 CHANGELOG）。
// 这里照 `tools/guard-pid-probe.js` 的老办法：
// **把当前已知的越界项显式列出来**，断言的是"越界集合 == 已知集合" ——
// 一旦有人接进**新的**空图素材，或者有人修好了老问题却忘了删这一行，两边都会红。
//
// ## v2.87.0：那份清单**清空了**
//
// 上一轮把 7 个空图记成"等拍板"，这一轮拍板修了 —— 于是
// `KNOWN_BLANK_REFS` 变成空对象，断言随之变成"**一条都不许有**"，
// 并且新增 3b 节把修好的素材**逐个钉在像素上**（修前/修后数字都写在断言里）。
//
// ⚠️ 为什么 3b 要单列而不是靠 3 节的"没有空图"：这一轮实测发现
// `assets/frame/frame-corners.png` **不是空图**（415 个不透明像素，画出了 1 个角），
// 所以"没有空图"这条守卫**根本查不出它** —— 而它正被控件 `img_corners` 引用，
// 修前用户拖出来的"四角标"只有**一个角**。
// 结论：空图守卫管不了"内容画错/画少"的素材，得靠"四个象限都有墨迹"这类判据。
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { decodePng, opaquePixels } = require('./_common');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const STUDIO = path.join(__dirname, '..');
const PORT = 9277;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ---------------------------------------------------------------------------
// 「已知引用空图」清单 —— 修好一个就删一行，接进新的就加一行（**加行会被审**）
//
// 每一条都要写清"为什么现在还留着"，不能只写个名字。
//
// v2.87.0：**唯一那条 `img_bgvign` 已删** —— `vignette.png` 修好了
// （修前 0 个不透明像素 → 修后 48893 个）。所以现在这里是**空的**：
// 断言变成"引用空图的控件集合必须是空集"，也就是**一条都不许有**。
//
// 之所以还留着这个空对象而不是删掉机制：下一个"路径在、图是空的"素材出现时，
// 唯一合法的处理是**去修素材**；如果谁真的加了一行，评审会看到 diff。
// ---------------------------------------------------------------------------
const KNOWN_BLANK_REFS = {};

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-wiring`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 6).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0].slice(0, 120)));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 控件库引用的素材路径：**全部**能在清单里找到且带 data
    console.log('\n=== 1. 控件库 → 素材清单（反向查）===');
    //
    // `ensureBuiltinAsset` 是**唯一收口点**：所有控件模板登记素材都走它。
    // 在它上面记一笔，就能拿到"控件库到底引用了哪些 path"的完整集合 ——
    // 不用去正则抠 presets.js 的字符串（那样会漏掉循环里拼出来的路径）。
    const refs = await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const savedNodes = S.design.nodes, savedAssets = S.design.assets;
      S.design.nodes = []; S.design.assets = [];
      const seen = {};
      const order = [];
      const orig = window.ensureBuiltinAsset;
      window.ensureBuiltinAsset = function (p) {
        p = String(p);
        if (!seen[p]) { seen[p] = []; order.push(p); }
        return orig.apply(this, arguments);
      };
      const out = { total: 0, notInIndex: [], noData: [], emptyPath: [] };
      try {
        (window.BUILTIN_CONTROLS || []).forEach(c => {
          out.total++;
          const before = order.length;
          try { c.make(); } catch (e) { /* make 抛错由别的套件管 */ }
          for (let i = before; i < order.length; i++) seen[order[i]].push(c.key);
        });
      } finally {
        window.ensureBuiltinAsset = orig;
        S.design.nodes = savedNodes; S.design.assets = savedAssets;
      }
      const idx = {};
      (window.BUILTIN_ASSETS || []).forEach(a => { idx[a.path] = a; });
      order.forEach(p => {
        if (!p) { out.emptyPath.push('(空路径)'); return; }
        const a = idx[p];
        if (!a) { out.notInIndex.push(p); return; }
        if (!a.data || a.data.indexOf('data:image/png;base64,') !== 0) out.noData.push(p);
      });
      out.refCount = order.length;
      out.byPath = seen;
      return out;
    })())`);
    const R = JSON.parse(refs);
    console.log('    · ' + R.total + ' 个控件，共引用 ' + R.refCount + ' 个素材路径（去重）');
    eq(R.emptyPath.length, 0, '没有控件登记空路径' + (R.emptyPath.length ? '：' + R.emptyPath.slice(0, 4) : ''));
    eq(R.notInIndex.length, 0,
      '**控件引用的素材路径全部能在 BUILTIN_ASSETS 里找到**' +
      (R.notInIndex.length ? '：' + R.notInIndex.slice(0, 5).join(', ') : ''));
    eq(R.noData.length, 0,
      '**这些素材都带内嵌 data URL**（否则登记出来的素材没有字节 → 导出 PNG 会抛 SecurityError）' +
      (R.noData.length ? '：' + R.noData.slice(0, 5).join(', ') : ''));
    ok(R.refCount >= 100, `引用面够广才有意义（${R.refCount} 个路径）`);

    // ---------- 2) 反过来：清单里的每个 path 都在磁盘上（含新素材）
    console.log('\n=== 2. 素材清单 → 磁盘 ===');
    const paths = await cdp.eval(`JSON.stringify((window.BUILTIN_ASSETS || []).map(a => a.path))`);
    const all = JSON.parse(paths);
    const missing = all.filter(p => !fs.existsSync(path.join(STUDIO, p.replace(/\//g, path.sep))));
    eq(missing.length, 0, `全部 ${all.length} 个素材路径都能在磁盘上找到` + (missing.length ? '：' + missing.slice(0, 5) : ''));
    const onDisk = [];
    (function walk(d) {
      fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else if (e.name.endsWith('.png')) onDisk.push(f);
      });
    })(path.join(STUDIO, 'assets'));
    const fresh = await cdp.eval('NEXT_LIBRARY.assets.map(a=>a.path)');
    fresh.forEach(p => { if(!fs.existsSync(path.join(STUDIO,p))) throw new Error('Missing new asset: '+p); });
    eq(onDisk.length, all.length + fresh.length, `磁盘上的 PNG 数与清单一致（${onDisk.length} 个）`);

    // ---------- 2b) **内嵌 data 与磁盘字节必须逐字节一致**
    //
    // 为什么单列一条：`builtin-data-*.js` 里的 base64 是**生成器写出来的**，
    // 磁盘上的 PNG 是**另一份拷贝**，两边可以各自漂移。漂移的后果不是报错，是
    // **同一个素材在设计器里和在设备上是两张图** ——
    // 工具的画布 / 导出 PNG 走内嵌那份，打包（`.icarzip`）走磁盘那份。
    //
    // ⚠️ 这条是**开发过程中真踩到过**才加的（v2.86.0）：手工改数据文件时少了一个
    // 开引号，整类素材变成 `"path":data:...` —— 文件语法错误 → 那 25 个素材
    // **一个都没有 data**。而当时的"校验"只查了 `indexOf('data:image/png;base64,')`，
    // **没查引号、也没查字节**，所以它是绿的。判据必须落在**字节**上。
    const embData = JSON.parse(await cdp.eval(
      `JSON.stringify((window.BUILTIN_ASSETS || []).map(a => ({ path: a.path, data: a.data || '' })))`));
    const crypto = require('crypto');
    const mismatched = [];
    const noData = [];
    embData.forEach(a => {
      const f = path.join(STUDIO, a.path.replace(/\//g, path.sep));
      if (!/^data:image\/png;base64,/.test(a.data)) { noData.push(a.path); return; }
      if (!fs.existsSync(f)) return;                       // 上一条已经报过"文件不在"
      const disk = fs.readFileSync(f);
      const emb = Buffer.from(a.data.slice('data:image/png;base64,'.length), 'base64');
      const h = b => crypto.createHash('md5').update(b).digest('hex');
      if (disk.length !== emb.length || h(disk) !== h(emb)) {
        mismatched.push(a.path + `（磁盘 ${disk.length}B vs 内嵌 ${emb.length}B）`);
      }
    });
    console.log('    · ' + embData.length + ' 个素材：内嵌 data 与磁盘字节不一致 ' + mismatched.length + ' 个');
    mismatched.slice(0, 5).forEach(x => console.log('       ⚠️ ' + x));
    eq(noData.length, 0, '**每个素材都带合法前缀的内嵌 data URL**' +
      (noData.length ? '：' + noData.slice(0, 5).join(', ') : ''));
    eq(mismatched.length, 0,
      '**内嵌 base64 与磁盘 PNG 逐字节一致**（不一致 = 设计器与设备上是两张图）' +
      (mismatched.length ? '：' + mismatched.slice(0, 5).join(' | ') : ''));

    // ---------- 3) **空图守卫**：整张全透明的素材不许被控件引用
    console.log('\n=== 3. 空图守卫（像素级，Node 侧解码）===');
    const blank = [];
    const undecodable = [];
    all.forEach(p => {
      const buf = fs.readFileSync(path.join(STUDIO, p.replace(/\//g, path.sep)));
      const n = opaquePixels(buf);
      if (n < 0) undecodable.push(p);
      else if (n === 0) blank.push(p);
    });
    console.log('    · ' + all.length + ' 个素材里，**全透明** ' + blank.length + ' 个');
    blank.forEach(p => console.log('       · ' + p + (R.byPath[p] ? '   ← 被 ' + R.byPath[p].join(',') + ' 引用' : '   （无控件引用）')));
    eq(undecodable.length, 0, '每个素材都能解码（解码器认不出 = 生成器写出了别的 PNG 形态）' +
      (undecodable.length ? '：' + undecodable.slice(0, 5) : ''));

    // 越界的引用（控件引用了空图）
    const badRefs = {};
    Object.keys(R.byPath).forEach(p => { if (blank.indexOf(p) >= 0) badRefs[R.byPath[p].join(',')] = p; });
    const badKeys = Object.keys(badRefs).sort();
    const knownKeys = Object.keys(KNOWN_BLANK_REFS).sort();
    console.log('    · 引用空图的控件：' + (badKeys.length ? badKeys.join(' | ') : '（无）'));
    eq(badKeys.length, knownKeys.length,
      `引用空图的控件**正好是已知待办那几个**（${knownKeys.length} 个）` +
      (badKeys.length !== knownKeys.length
        ? '：实测 [' + badKeys.join(', ') + '] vs 已知 [' + knownKeys.join(', ') + ']'
        : ''));
    eq(badKeys.join('|'), knownKeys.join('|'),
      '引用空图的控件**名单一致**（修好一个就删 KNOWN_BLANK_REFS 里的那一行，接进新的就要先修素材）');
    // v2.87.0：7 个空图全修好了 → 这条从"没有变多（≤7）"升级成"**一个都不许有**"。
    // 强得多：以后新素材只要是空图，无论有没有控件引用它，这里都会红。
    eq(blank.length, 0,
      '**没有任何全透明素材**（v2.86.0 体检出的 7 个已在 v2.87.0 修完）' +
      (blank.length ? '：' + blank.slice(0, 8).join(', ') : ''));

    // ---------- 3b) v2.87.0 修好的素材：**修前/修后都钉在像素上**
    //
    // 这一段存在的理由：上一轮体检是**人工**跑临时脚本得出的数字
    // （"这 7 个 0 个不透明像素"），人工结论会随文件一起漂走。
    // 这里把"修好了"变成每轮机器核对的判据 —— 而且是**像素级**的：
    // 不看名字、不看文件大小、不看 md5（md5 会随无关改动变）。
    console.log('\n=== 3b. v2.87.0 修好的坏素材（像素级）===');
    const FIXED = [
      // [路径, 修前不透明像素数, 说明]
      ['assets/background/gradient-radial.png', 0, '径向渐变'],
      ['assets/background/gradient-v.png', 0, '纵向渐变'],
      ['assets/background/vignette.png', 0, '暗角（**被控件 img_bgvign 引用**）'],
      ['assets/decor/corner-tl.png', 0, '角标 TL'],
      ['assets/decor/corner-tr.png', 0, '角标 TR'],
      ['assets/decor/corner-bl.png', 0, '角标 BL'],
      ['assets/decor/divider-gradient.png', 0, '渐变分隔线'],
      ['assets/bar/track-gradient-h.png', 6052, '渐变轨道（水平）—— 修前渐变层被除没了'],
      ['assets/bar/track-gradient-v.png', 6052, '渐变轨道（垂直）'],
      // 第 10 个：**同一个负宽高根因**，但体检没列进 9 个 ——
      // 因为它不是空图（画出了 1 个角），415 个不透明像素看着"有内容"。
      // 它**正被控件 `img_corners`（四角标）引用** → 修前用户只看到**一个角**。
      ['assets/frame/frame-corners.png', 415, '四角标记（**被控件 img_corners 引用**）'],
    ];
    const readPng = p => {
      const f = path.join(STUDIO, p.replace(/\//g, path.sep));
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    };
    FIXED.forEach(([p, before, note]) => {
      const buf = readPng(p);
      const n = buf ? opaquePixels(buf) : -1;
      ok(n > 0, `${note}：**不再全透明**（修前 ${before} → 修后 ${n} 个不透明像素）`);
    });
    // 四个角标：各自有内容 + 四个**互不相同**（四个文件以前 md5 完全相同 —— 都是空图）
    const cornerPaths = ['assets/decor/corner-tl.png', 'assets/decor/corner-tr.png',
      'assets/decor/corner-bl.png', 'assets/decor/corner-br.png'];
    const cornerMd5 = cornerPaths.map(p => {
      const b = readPng(p);
      return b ? crypto.createHash('md5').update(b).digest('hex') : '(缺文件)';
    });
    eq(cornerMd5.filter((h, i) => cornerMd5.indexOf(h) === i).length, 4,
      '**四个角标是四张不同的图**（修前 tl/tr/bl 三张 md5 完全相同 = 同一张空图）');
    // frame-corners 的**四个象限都要有墨迹** —— 这才是"四个角都在"的直接证据
    const fcBuf = readPng('assets/frame/frame-corners.png');
    const fcImg = fcBuf ? decodePng(fcBuf) : null;
    const quad = [0, 0, 0, 0];
    if (fcImg) {
      for (let y = 0; y < fcImg.h; y++) for (let x = 0; x < fcImg.w; x++) {
        if (fcImg.rgba[(y * fcImg.w + x) * 4 + 3] > 8) quad[(y < fcImg.h / 2 ? 0 : 2) + (x < fcImg.w / 2 ? 0 : 1)]++;
      }
    }
    console.log('    · 四角标记四个象限的墨迹：' + quad.join(' / '));
    eq(quad.filter(n => n > 0).length, 4,
      '**四角标记的四个角都有墨迹**（修前只有左上那一个 —— 负宽高被静默吃掉）' +
      (quad.filter(n => n > 0).length !== 4 ? '：' + quad.join('/') : ''));

    // ---- 3c) 四个角标：**文件名就是 API**（v2.88.0 修「命名镜像」）----
    //
    // ## 为什么这条必须存在
    //
    // v2.87.0 把四个角标从"全透明空图"修成了"有内容"，但**内容在哪个角**没人管 ——
    // 实测那时每个文件装的都是**对角**那个角：`corner-tl` 的墨迹在右下、
    // `corner-br` 在左上、`corner-tr` 在左下、`corner-bl` 在右上。
    //
    // 这不是"风格问题"，是**可证明的错**：用户按名字选"左上角"，
    // 拿到的是右下角 —— **文件名就是 API**，内容对不上名字就是 bug。
    // （四个角标**没有任何控件引用**，所以修它不会动到任何存量设计的观感。）
    //
    // 根因是 `gen-assets-more.js` 里的**双重取负**：
    // `ox = x + sx*56` 把原点挪到一个角，`c.rect(ox, oy, -sx*40, -sy*6)` 又往回画。
    //
    // ## 判据为什么用"象限"而不是"最亮的那个点"
    //
    // 角标是**两条互相垂直的短线**（40×6 + 6×40），必须整条都落在名字那个象限里。
    // 用"墨迹重心"或"最亮点"会被抗锯齿/端点带偏；数**四个象限各自的不透明像素**
    // 是直接、稳定、可复现的（实测每个角都是 522 个，全在同一个象限里）。
    const QUAD_NAME = ['左上', '右上', '左下', '右下'];
    const cornerQuad = [];
    cornerPaths.forEach((p, i) => {
      const img = decodePng(readPng(p));
      const q = [0, 0, 0, 0];
      if (img) {
        for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
          if (img.rgba[(y * img.w + x) * 4 + 3] > 8) q[(y < img.h / 2 ? 0 : 2) + (x < img.w / 2 ? 0 : 1)]++;
        }
      }
      cornerQuad.push(q);
      const want = QUAD_NAME[i];
      const ink = q[0] + q[1] + q[2] + q[3];
      const at = QUAD_NAME[q.indexOf(Math.max.apply(null, q))];
      console.log('    · ' + p.split('/').pop() + ' 的墨迹象限 [左上,右上,左下,右下] = ' +
        JSON.stringify(q) + ' → ' + at);
      ok(ink > 0 && q[i] === ink,
        `**\`${p.split('/').pop()}\` 的墨迹全在「${want}」象限**（名字说什么角，内容就得是什么角）` +
        (q[i] === ink ? `：${ink} 个不透明像素` : `：实测分布 ${JSON.stringify(q)}（主象限「${at}」）`));
    });
    // 四张**互不相同**由上面那条 md5 断言负责（`cornerMd5` 四张两两不同）；
    // 这里再钉一层**结构**判据：四个文件必须落在**四个不同的象限**，
    // 而且各自**只有一个**象限有墨迹（不是"两个角都沾一点"的糊图）。
    const filled = cornerQuad.map(q => q.indexOf(Math.max.apply(null, q)));
    eq(new Set(filled).size, 4,
      '**四个角标各自落在四个不同的象限**（修前四个文件只覆盖对角线两侧）' +
      (new Set(filled).size !== 4 ? '：' + JSON.stringify(filled) : ''));
    eq(cornerQuad.filter(q => q.filter(n => n > 0).length === 1).length, 4,
      '**每个角标只有一个象限有墨迹**（另一条对角线必须是干净的 0）' +
      (cornerQuad.filter(q => q.filter(n => n > 0).length === 1).length !== 4
        ? '：' + JSON.stringify(cornerQuad) : ''));

    // 渐变轨道 vs 普通轨道：渐变层真的回来了（修前两者几乎逐像素相同）
    const chanDiff = (pa, pb) => {
      const A = decodePng(readPng(pa)), B = decodePng(readPng(pb));
      if (!A || !B || A.w !== B.w || A.h !== B.h) return null;
      let same = 0, sum = 0;
      const total = A.w * A.h * 4;
      for (let i = 0; i < total; i++) { const d = Math.abs(A.rgba[i] - B.rgba[i]); if (d === 0) same++; else sum += d; }
      return { sameRatio: same / total, meanDiff: sum / total };
    };
    [['assets/bar/track-gradient-h.png', 'assets/bar/track-h.png', '水平'],
     ['assets/bar/track-gradient-v.png', 'assets/bar/track-v.png', '垂直']].forEach(([g, t, dir]) => {
      const d = chanDiff(g, t);
      console.log('    · ' + dir + '：渐变轨道 vs 普通轨道 —— 通道相同 ' +
        (d ? (100 * d.sameRatio).toFixed(1) + '%' : '?') + '，平均差 ' + (d ? d.meanDiff.toFixed(2) : '?'));
      ok(!!d && d.sameRatio < 0.6 && d.meanDiff > 6,
        `**${dir}渐变轨道的渐变层回来了**（与普通轨道不再逐像素相同：相同 ${d ? (100 * d.sameRatio).toFixed(1) : '?'}% < 60%、平均差 ${d ? d.meanDiff.toFixed(2) : '?'} > 6）`);
    });
    // 修好了**还要真的接进控件库** —— 否则"素材是好的"和"用户能拖出来"是两件事。
    // v2.86.0 的"不接"是对的（那时它是坏的），v2.88.0 修好后接上；
    // 这条断言把"接上了"钉住，省得哪天有人按老注释又把它摘掉。
    [['assets/bar/track-gradient-h.png', 'bar_trackgradh', '渐变轨道(水平)'],
     ['assets/bar/track-gradient-v.png', 'bar_trackgradv', '渐变轨道(垂直)']].forEach(([p, key, name]) => {
      const users = R.byPath[p] || [];
      ok(users.indexOf(key) >= 0,
        `**${name}（\`${key}\`）已接进控件库**（引用 \`${p}\` 的控件：${users.join(', ') || '一个都没有'}）`);
    });
    // `img_bgvign`（暗角背景）拖出来必须**真的有东西**
    //
    // ⚠️ 判据取的是**控件登记出来的那份内嵌 data**，不是磁盘上的 PNG ——
    // 用户在设计器里看到的是内嵌那份（见 2b 的说明）。
    const vignCtrl = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const savedNodes = S.design.nodes, savedAssets = S.design.assets;
      S.design.nodes = []; S.design.assets = [];
      const c = (window.BUILTIN_CONTROLS || []).find(x => x.key === 'img_bgvign');
      const out = { exists: !!c, path: '', data: '' };
      try {
        const n = c && c.make();
        if (n) {
          const a = (S.design.assets || []).find(x => x.id === n.assetId);
          out.path = a ? a.path : '(assetId 悬空)';
          out.data = a && a.data ? a.data : '';
        }
      } catch (e) { out.err = String(e.message).slice(0, 60); }
      S.design.nodes = savedNodes; S.design.assets = savedAssets;
      return out;
    })())`));
    const vignOp = /^data:image\/png;base64,/.test(vignCtrl.data)
      ? opaquePixels(Buffer.from(vignCtrl.data.slice('data:image/png;base64,'.length), 'base64')) : -1;
    console.log('    · 控件 img_bgvign → ' + (vignCtrl.path || '(无)') + '，内嵌 data 解出不透明像素 ' + vignOp);
    ok(vignCtrl.exists, '控件 `img_bgvign`（暗角背景）在库里');
    eq(vignCtrl.path, 'assets/background/vignette.png', '  它引用的就是修好的 `vignette.png`');
    ok(vignOp > 0, `  **拖出来真的看得见东西**（内嵌 data 有 ${vignOp} 个不透明像素，修前是 0）`);

    // ---------- 4) v2.86.0 新接的素材：非空 + 元数据对得上
    console.log('\n=== 4. v2.86.0 新增的 4 个素材 ===');
    const NEW_ASSETS = [
      ['assets/bar/band-3-h.png', 256, 24],
      ['assets/bar/band-3-v.png', 24, 256],
      ['assets/frame/alert-bar.png', 256, 56],
      ['assets/scale/nums-arc-jump5.png', 256, 256],
    ];
    const idx = {};
    const meta = JSON.parse(await cdp.eval(`JSON.stringify((window.BUILTIN_ASSETS || []).map(a => ({ path: a.path, w: a.w, h: a.h, label: a.label, kind: a.kind, hasData: !!(a.data && a.data.length > 100) })))`));
    meta.forEach(m => { idx[m.path] = m; });
    NEW_ASSETS.forEach(([p, w, h]) => {
      const m = idx[p];
      const f = path.join(STUDIO, p.replace(/\//g, path.sep));
      const buf = fs.existsSync(f) ? fs.readFileSync(f) : null;
      const img = buf ? decodePng(buf) : null;
      const op = buf ? opaquePixels(buf) : 0;
      ok(!!m, `新素材在清单里：${p}`);
      ok(!!m && m.w === w && m.h === h, `  元数据尺寸对（${w}×${h}）` + (m ? ` 实际 ${m.w}×${m.h}` : ''));
      ok(!!m && !!m.label && String(m.label).trim().length > 0, `  有中文说明（${m ? m.label : '（无 label）'}）`);
      ok(!!m && m.hasData, '  内嵌 data URL 非空');
      ok(!!img && img.w === w && img.h === h, '  **磁盘上的 PNG 尺寸与元数据一致**');
      ok(op > 0, `  **不是空图**（不透明像素 ${op} 个）`);
    });

    // ---------- 5) v2.86.0 新接的控件：逐个存在、引用对、尺寸正
    console.log('\n=== 5. v2.86.0 新增的控件 ===');
    const NEW_CTRLS = [
      ['bar_markerh', 'assets/bar/marker-h.png'], ['bar_markerv', 'assets/bar/marker-v.png'],
      ['bar_markerglowh', 'assets/bar/marker-glow-h.png'], ['bar_markerglowv', 'assets/bar/marker-glow-v.png'],
      ['bar_trackglowh', 'assets/bar/track-glow-h.png'], ['bar_trackglowv', 'assets/bar/track-glow-v.png'],
      ['bar_trackinseth', 'assets/bar/track-inset-h.png'], ['bar_trackinsetv', 'assets/bar/track-inset-v.png'],
      ['bar_trackticksh', 'assets/bar/track-ticks-h.png'], ['bar_trackticksv', 'assets/bar/track-ticks-v.png'],
      ['bar_fillglowh', 'assets/bar/fill-glow-h.png'], ['bar_fillglowv', 'assets/bar/fill-glow-v.png'],
      ['bar_fillgradh', 'assets/bar/fill-gradient-h.png'], ['bar_fillgradv', 'assets/bar/fill-gradient-v.png'],
      ['bar_seg5h', 'assets/bar/segment-5-h.png'], ['bar_seg5v', 'assets/bar/segment-5-v.png'],
      ['bar_seg20h', 'assets/bar/segment-20-h.png'], ['bar_seg20v', 'assets/bar/segment-20-v.png'],
      ['bar_band3h', 'assets/bar/band-3-h.png'], ['bar_band3v', 'assets/bar/band-3-v.png'],
      ['img_unita', 'assets/scale/unit-a.png'], ['img_unitpct', 'assets/scale/unit-pct.png'],
      ['img_unitbar', 'assets/scale/unit-bar.png'], ['img_unitl100', 'assets/scale/unit-l100.png'],
      ['img_unitkm', 'assets/scale/unit-km.png'], ['img_unitx1000', 'assets/scale/unit-x1000.png'],
      ['img_digitdot', 'assets/scale/digit-dot.png'], ['img_digitminus', 'assets/scale/digit-minus.png'],
      ['img_digitpct', 'assets/scale/digit-pct.png'],
      ['img_numsarcjump5', 'assets/scale/nums-arc-jump5.png'], ['img_numsarc5', 'assets/scale/nums-arc-5.png'],
      ['img_numsroweven', 'assets/scale/nums-row-even.png'], ['img_numsrowtens', 'assets/scale/nums-row-tens.png'],
      ['img_numscolpct', 'assets/scale/nums-col-pct.png'],
      ['img_ticksband', 'assets/scale/ticks-band.png'], ['img_ticksgrad', 'assets/scale/ticks-gradient.png'],
      ['img_icfuel', 'assets/icon/fuel.png'], ['img_ictemp', 'assets/icon/temp.png'],
      ['img_icbatt', 'assets/icon/battery.png'], ['img_icoil', 'assets/icon/oil.png'],
      ['img_icturbo', 'assets/icon/turbo.png'], ['img_icgear', 'assets/icon/gear.png'],
      ['img_icodo', 'assets/icon/odo.png'], ['img_icrange', 'assets/icon/range.png'],
      ['img_icclock', 'assets/icon/clock.png'], ['img_icgps', 'assets/icon/gps.png'],
      ['img_iccheck', 'assets/icon/check.png'], ['img_iccross', 'assets/icon/cross.png'],
      ['img_lampcrit', 'assets/warning/lamp-crit.png'],
      ['img_alertbar', 'assets/frame/alert-bar.png'],
    ];
    const ctrl = await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const savedNodes = S.design.nodes, savedAssets = S.design.assets;
      S.design.nodes = []; S.design.assets = [];
      const out = {};
      (window.BUILTIN_CONTROLS || []).forEach(c => { out[c.key] = { name: c.name, cat: c.cat }; });
      S.design.nodes = savedNodes; S.design.assets = savedAssets;
      return out;
    })())`);
    const C = JSON.parse(ctrl);
    const notFound = NEW_CTRLS.filter(([k]) => !C[k]).map(([k]) => k);
    eq(notFound.length, 0, `**${NEW_CTRLS.length} 个新控件全部在库里**` + (notFound.length ? '：' + notFound.join(', ') : ''));
    // 逐个 make()：assetId 必须指向那条素材，尺寸必须为正
    const made = await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const savedNodes = S.design.nodes, savedAssets = S.design.assets;
      const want = ${JSON.stringify(NEW_CTRLS)};
      const out = { bad: [], byKey: {} };
      want.forEach(function (pair) {
        const key = pair[0], p = pair[1];
        const c = (window.BUILTIN_CONTROLS || []).find(function (x) { return x.key === key; });
        if (!c) { out.bad.push(key + ' 不存在'); return; }
        S.design.nodes = []; S.design.assets = [];
        let n = null;
        try { n = c.make(); } catch (e) { out.bad.push(key + ' make 抛错: ' + String(e.message).slice(0, 40)); return; }
        if (!n) { out.bad.push(key + ' make 返回空'); return; }
        const a = (S.design.assets || []).find(function (x) { return x.id === n.assetId; });
        if (!a) { out.bad.push(key + ' assetId 悬空'); return; }
        if (a.path !== p) { out.bad.push(key + ' 指向 ' + a.path + '，期望 ' + p); return; }
        if (!a.data || a.data.indexOf('data:image/png;base64,') !== 0) { out.bad.push(key + ' 素材没有 data'); return; }
        if (!(n.w > 0 && n.h > 0)) { out.bad.push(key + ' 尺寸非正 ' + n.w + 'x' + n.h); return; }
        out.byKey[key] = { w: n.w, h: n.h, path: a.path, name: n.name };
      });
      S.design.nodes = savedNodes; S.design.assets = savedAssets;
      return out;
    })())`);
    const M = JSON.parse(made);
    M.bad.slice(0, 8).forEach(x => console.log('       ⚠️ ' + x));
    eq(M.bad.length, 0, '**每个新控件都能 make()，且 assetId 指向它该引用的那条素材、带 data、尺寸为正**');
    eq(Object.keys(M.byKey).length, NEW_CTRLS.length, `全部 ${NEW_CTRLS.length} 个新控件都验过`);

    // ---------- 6) 分类：没有控件掉进「其它」；新分类真的生效
    console.log('\n=== 6. 分类 ===');
    const cats = {};
    Object.keys(C).forEach(k => { cats[C[k].cat] = (cats[C[k].cat] || 0) + 1; });
    console.log('    · ' + Object.keys(cats).sort().map(k => k + '=' + cats[k]).join('  '));
    ok(!cats['其它'], '**没有控件掉进「其它」分类**（掉进去 = CAT_RULES 漏了新前缀）');
    eq(cats['图标'], 12, '新分类「图标」有 12 个控件');
    // ticks / seg 归到「数字刻度」（调研建议 8 的第 ② 条）
    eq(C['img_ticks90'] && C['img_ticks90'].cat, '数字刻度', '`img_ticks90` 已归到「数字刻度」（原来错在「图片 / 底盘」）');
    eq(C['img_seg20'] && C['img_seg20'].cat, '数字刻度', '`img_seg20` 已归到「数字刻度」');
    eq(C['img_ticksband'] && C['img_ticksband'].cat, '数字刻度', '新接的色带刻度归到「数字刻度」');
    eq(C['img_alertbar'] && C['img_alertbar'].cat, '图片 / 底盘', '告警条底板归到「图片 / 底盘」');
    // CTRL_CATS 必须包含所有实际出现的分类（否则面板会把它们塞进「其它」兜底块）
    const catsList = JSON.parse(await cdp.eval(`JSON.stringify(window.CTRL_CATS || [])`));
    const missingCat = Object.keys(cats).filter(k => catsList.indexOf(k) < 0);
    eq(missingCat.length, 0, '**实际出现的分类都在 `CTRL_CATS` 里**（否则渲染时会被兜底到「其它」块）' +
      (missingCat.length ? '：' + missingCat.join(', ') : ''));

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(60));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
