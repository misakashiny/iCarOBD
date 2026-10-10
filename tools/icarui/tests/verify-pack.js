// ============================================================================
// verify-pack.js —— 「设计包（.icarzip）」的验证套件（v2.79.0）
//
// ## 为什么要专门一套
//
// 打包这条路**没有界面能一眼看出对错**：zip 写坏了，用户在解压时才知道；
// 引用收集漏了一处（比如状态系统的 warn 图），设备上只有那一张是空的。
// 所以这套测试分三段：
//
//   第 0 段  **Node 侧**独立验证 zip.js —— 拿 `zlib.crc32` 当裁判，
//            并且**用 Node 的 zlib 真解一遍**（我们只写 store，所以数据段
//            应当能原样 inflate 出来）。自己验自己不算验。
//   第 0b 段 **Node 侧**直接测 pack.js 的引用收集（不开浏览器）——
//            多页面 / 状态 / 子部件 / 背景 这几处最容易漏。
//   第 1~n 段 **浏览器侧**端到端：真的调 exportPackage()，
//            把生成的 zip 从页面里 base64 拿出来，用 Node 的解析器读回。
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
// 端口与其它套件错开（那 22 个用的是 9260 附近）
const PORT = 9311;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ZipKit = require('../js/zip.js');
const PackKit = require('../js/pack.js');

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
        await sleep(350 * (attempt + 1));
      }
    }
    throw lastErr;
  }
}
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));

// ⚠️ **Node 自己算一遍 CRC32**，不 import 被测实现 —— 否则"两边一起错"
// 会看起来像通过。zlib.crc32 是 Node 20+ 才有的，没有就退回手算（下面这份
// 是照着 RFC 1952 的说明独立写的，与被测实现不共享代码）。
function nodeCrc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

(async () => {
  // =========================================================== Node 侧：zip.js
  console.log('=== 0. zip.js 自身（Node 侧，独立裁判） ===');

  const A = Buffer.from('hello 设计包', 'utf8');
  const B = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 254]);
  const C = Buffer.alloc(0);                     // 空文件也要能进包
  const LONG = crypto.randomBytes(300000);       // 大文件：偏移量算错在这里最容易暴露

  eq(ZipKit.crc32(A), nodeCrc32(A), 'CRC32 与 Node 独立实现一致（中文 UTF-8）');
  eq(ZipKit.crc32(B), nodeCrc32(B), 'CRC32 与 Node 独立实现一致（含 0xFF 的二进制）');
  eq(ZipKit.crc32(LONG), nodeCrc32(LONG), 'CRC32 与 Node 独立实现一致（300KB 随机）');

  const built = ZipKit.buildZip([
    { name: 'design.json', data: '{"schema":"icar.ui/2"}' },
    { name: 'assets/背景/carbon.png', data: B },
    { name: 'assets/空.png', data: C },
    { name: 'assets/大图.png', data: LONG },
  ]);
  const bytes = Buffer.from(built.bytes);

  // ---- 用 Node 的 zlib 独立确认"这真是一份合法的 zip"：读中央目录 → 取数据段
  //      → 我们只写 store，所以数据段应当**逐字节等于源数据**。
  const zr = ZipKit.readZip(bytes);
  eq(zr.entries.length, 4, '读回 4 个条目');
  eq(zr.entries[0].name, 'design.json', '第一个条目名（顺序 = 写入顺序）');
  eq(zr.entries[1].name, 'assets/背景/carbon.png', '中文路径能正确读回（UTF-8 位已置）');
  eq(zr.entries[1].data.length, B.length, '中文名条目的数据长度');
  ok(Buffer.from(zr.entries[1].data).equals(B), '数据段逐字节等于源数据（store 不压缩）');
  eq(zr.entries[2].data.length, 0, '空文件条目长度为 0');
  ok(Buffer.from(zr.entries[3].data).equals(LONG), '300KB 条目的数据段逐字节一致（偏移没算错）');
  eq(zr.entries[3].offset, built.entries[3].offset, '中央目录里的本地头偏移与写入账本一致');
  eq(zr.entries[3].crc, nodeCrc32(LONG), '大条目的 CRC 与 Node 独立实现一致');
  // 数据段起点 = 本地头 + 30 + 文件名（无扩展区）—— 手算一遍，确认偏移链没断
  eq(zr.entries[3].dataOffset, built.entries[3].offset + 30 + Buffer.byteLength('assets/大图.png'),
    '数据段起点 = 本地头 + 30 + 文件名长度（偏移链正确）');

  // ---- ⚠️ **不能用 inflateRawSync 验 store 段**（第一版就是这么错的）：
  //      "store" 不是 deflate 流，inflate 会报 `invalid stored block lengths`。
  //      正确的验法是**两种打包方式各验各的**：
  //        · store（本工具用的）→ 数据段必须**逐字节等于源数据**
  //        · deflate（外部工具产出的）→ 能被 zlib 解回来
  //      后者证明"我们产出的中央目录/本地头结构，别的工具真的能顺着走"。
  const raw = zlib.deflateRawSync(LONG);
  const ext = ZipKit.buildZip([{ name: 'assets/deflate.bin', data: raw }]);
  const extRead = ZipKit.readZip(ext.bytes).entries[0];
  eq(extRead.size, raw.length, 'deflate 条目：中央目录里的原大小 = 压缩后长度（这里两者相等是巧合，只验读得出）');
  ok(Buffer.from(extRead.data).equals(raw), 'deflate 条目的数据段原样取出（结构能被外部工具顺着走）');
  eq(zlib.inflateRawSync(Buffer.from(extRead.data)).length, LONG.length,
    '外部 zlib 能把取出的数据段解回原始长度（说明偏移/长度都对）');

  // ---- verifyZip：三项（条目数 / 字节数 / CRC）
  const expect = built.entries.map(e => ({ name: e.name, size: e.size, crc: e.crc }));
  const v1 = ZipKit.verifyZip(bytes, expect);
  ok(v1.ok, 'verifyZip：自己产出的包自检通过' + (v1.ok ? '' : ' —— ' + v1.problems.join('; ')));

  // ---- 反向验证：三种坏法都必须被抓住
  const badSize = expect.map((e, i) => i === 1 ? Object.assign({}, e, { size: e.size + 1 }) : e);
  ok(!ZipKit.verifyZip(bytes, badSize).ok, '反向：期望字节数写错 → 报错');
  const badCrc = expect.map((e, i) => i === 1 ? Object.assign({}, e, { crc: (e.crc ^ 1) >>> 0 }) : e);
  ok(!ZipKit.verifyZip(bytes, badCrc).ok, '反向：期望 CRC 写错 → 报错');
  const shortExpect = expect.slice(0, 3);
  ok(!ZipKit.verifyZip(bytes, shortExpect).ok, '反向：期望条目少一个 → 报错');

  // ⚠️ **最阴的一种坏法**：把数据区某个字节改了，但**中央目录里的 CRC 不动**。
  // 只比"中央目录里的 CRC"的实现在这里会放过去 —— 所以 verifyZip 必须
  // **拿读出来的字节重算**。这条断言就是为了钉住那个行为。
  const tampered = Buffer.from(bytes);
  const tamperAt = zr.entries[1].dataOffset;   // 第 2 个条目的数据段第一个字节
  ok(tamperAt > 0, '定位到被篡改条目的数据区（偏移 ' + tamperAt + '）');
  tampered[tamperAt] ^= 0xFF;
  const vt = ZipKit.verifyZip(tampered, expect);
  ok(!vt.ok && vt.problems.some(p => /数据与 CRC 对不上/.test(p)),
    '反向：只改数据、不改中央目录 CRC → 仍被抓住（重算而非只比记录值）');

  // ---- 重复条目名 / `..` 必须被拒（前者让解压端只留一个，后者是 zip slip）
  let threw = '';
  try { ZipKit.buildZip([{ name: 'a', data: A }, { name: 'a', data: B }]); } catch (e) { threw = e.message; }
  ok(/重复/.test(threw), '重复条目名被拒绝：' + threw);
  threw = '';
  try { ZipKit.buildZip([{ name: '../evil.png', data: A }]); } catch (e) { threw = e.message; }
  ok(/\.\./.test(threw), '`..` 路径被拒绝（zip slip）：' + threw);
  const norm = ZipKit.buildZip([{ name: 'assets\\win\\a.png', data: A }]);
  eq(ZipKit.readZip(norm.bytes).entries[0].name, 'assets/win/a.png', '反斜杠被归一成正斜杠');

  // =========================================================== Node 侧：pack.js
  console.log('\n=== 0b. pack.js 的引用收集（Node 侧，纯逻辑） ===');

  const assets = [
    { id: 'a1', path: 'assets/dial.png' },
    { id: 'a2', path: 'assets/needle.png' },
    { id: 'a3', path: 'assets/lamp-off.png' },
    { id: 'a4', path: 'assets/lamp-warn.png' },
    { id: 'a5', path: 'assets/lamp-crit.png' },
    { id: 'a6', path: 'assets/bg.png' },
    { id: 'a7', path: 'assets/从未引用.png' },       // 试过又删掉的 —— **不该进包**
  ];
  const byId = id => assets.find(a => a.id === id) || null;
  const byPath = p => assets.find(a => PackKit.normPath(a.path) === PackKit.normPath(p)) || null;

  const design = {
    assets: assets,
    background: { path: './assets/bg.png' },          // 带 ./ 前缀，必须归一化后仍认得出
    nodes: [
      { type: 'image', assetId: 'a1', states: null },
      {
        type: 'image', assetId: 'a3',
        states: { normal: { assetId: 'a3' }, warn: { assetId: 'a4' }, critical: { assetId: 'a5' } },
      },
      {
        type: 'gauge',
        parts: [
          { kind: 'dial', assetId: 'a1' },
          { kind: 'needle', assetId: 'a2', children: [{ kind: 'decor', assetId: 'a2' }] },
        ],
      },
      { type: 'group', children: [{ type: 'image', assetId: 'a2' }] },
    ],
    pages: [
      { id: 'p0', nodes: [] },
      { id: 'p1', nodes: [{ type: 'image', assetId: 'a6' }] },   // 第二页 —— 最容易漏
    ],
  };
  const refs = PackKit.collectAssetRefs(design, byId, byPath);
  const paths = refs.map(r => r.path);
  console.log('    · ' + paths.join(' , '));
  eq(paths.length, 6, '收集到 6 个被引用的素材');
  ok(paths.indexOf('assets/从未引用.png') < 0, '**没有**把 assets[] 里没被引用的素材打进包');
  ok(paths.indexOf('assets/bg.png') >= 0, '背景图进包（它不在 assets 的引用里，只在 background.path）');
  ok(paths.indexOf('assets/lamp-warn.png') >= 0, '状态系统的 warn 图进包');
  ok(paths.indexOf('assets/lamp-crit.png') >= 0, '状态系统的 critical 图进包');
  ok(paths.indexOf('assets/needle.png') >= 0, '子部件（含嵌套 children）的素材进包');
  ok(paths.indexOf('assets/dial.png') >= 0, '拼装表的表盘素材进包');
  const sorted = paths.slice().sort();
  eq(paths.join('|'), sorted.join('|'), '输出按路径排序（可复现）');
  const bgRef = refs.find(r => r.path === 'assets/bg.png');
  ok(bgRef && bgRef.refs.indexOf(PackKit.REF_BACKGROUND) >= 0, '背景的来源被标成 background（便于排查）');

  // 去重：同一个素材被多处引用只出现一次
  const dup = PackKit.collectAssetRefs({
    assets: assets, nodes: [{ type: 'image', assetId: 'a1' }, { type: 'image', assetId: 'a1' }],
  }, byId, byPath);
  eq(dup.length, 1, '同一素材被引用两次只收集一次');
  ok(dup[0].refs.length >= 1, '但来源会被记下来（refs 非空）');

  // 引用了一个不在清单里的 assetId → 不报错、不打包（校验器另有警告）
  const ghost = PackKit.collectAssetRefs({ assets: assets, nodes: [{ type: 'image', assetId: 'nope' }] }, byId, byPath);
  eq(ghost.length, 0, '引用了清单里没有的 assetId → 收集为空（不崩）');

  // buildPackage：注入 readBytes，验证清单与条目顺序
  const fakeBytes = p => Buffer.from('BYTES:' + p, 'utf8');
  const pkg = await PackKit.buildPackage({
    design: design,
    designJson: '{"schema":"icar.ui/2"}',
    now: '2026-10-09T00:00:00.000Z',
    crc32: ZipKit.crc32,
    readBytes: async ref => ({ bytes: new Uint8Array(fakeBytes(ref.path)), w: 10, h: 20 }),
  });
  eq(pkg.entries[0].name, PackKit.DESIGN_ENTRY, 'design.json 是第一个条目');
  eq(pkg.entries[pkg.entries.length - 1].name, PackKit.MANIFEST_ENTRY, 'manifest.json 是最后一个条目');
  eq(pkg.entries.length, 1 + 6 + 1, '条目数 = 1(design) + 6(素材) + 1(manifest)');
  eq(pkg.manifest.format, 'icar.pack/1', 'manifest 写明了包格式版本');
  eq(pkg.manifest.designSchema, 'icar.ui/2', 'manifest 写明了设计文件格式版本');
  eq(pkg.manifest.exportedAt, '2026-10-09T00:00:00.000Z', '导出时间来自注入值（可测）');
  eq(pkg.manifest.counts.entries, 8, 'manifest.counts.entries = 8');
  eq(pkg.manifest.assets.length, 6, 'manifest 里 6 条素材');
  eq(pkg.manifest.missing.length, 0, '没有缺失素材');
  const mBg = pkg.manifest.assets.find(a => a.path === 'assets/bg.png');
  ok(mBg && mBg.bytes === fakeBytes('assets/bg.png').length, 'manifest 记了字节数');
  eq(mBg.crc32, ZipKit.crc32(fakeBytes('assets/bg.png')), 'manifest 记的 CRC 与字节一致');
  ok(mBg.refs.indexOf('background') >= 0, 'manifest 里保留来源标记');

  // 读不到字节 → **如实记进 missing**，不静默跳过
  const pkg2 = await PackKit.buildPackage({
    design: design, designJson: '{}', now: 'x', crc32: ZipKit.crc32,
    readBytes: async ref => ref.path === 'assets/needle.png' ? { missing: '重开工具后字节丢了' } : { bytes: fakeBytes(ref.path) },
  });
  eq(pkg2.manifest.missing.length, 1, '读不到字节的素材进 missing 清单');
  eq(pkg2.manifest.assets.length, 5, '其余 5 个照常进包');
  eq(pkg2.entries.length, 1 + 5 + 1, '条目数按实际进包的算');
  ok(/needle/.test(pkg2.manifest.missing[0].path), 'missing 里记的是哪个素材');

  eq(PackKit.packageFileName('我的 主题:v2'), '我的 主题_v2.icarzip', '包文件名清洗非法字符 + .icarzip');
  eq(PackKit.packageFileName(''), 'design.icarzip', '空名字兜底成 design.icarzip');

  // =========================================================== 浏览器侧
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-pack`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    for (let i = 0; i < 100; i++) {
      const ready = await cdp.eval("!!(window.CanvasState && window.PackKit && window.ZipKit && window.BUILTIN_DATA_DONE === true)");
      if (ready) break;
      await sleep(200);
    }
    await require('./_common').stubDialogs(cdp);
    await cdp.eval(`window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'x';`);

    console.log('\n=== 1. 模块装载与入口 ===');
    const load = JSON.parse(await cdp.eval(`JSON.stringify({
      zip: typeof (window.ZipKit||{}).buildZip,
      pack: typeof (window.PackKit||{}).buildPackage,
      exp: typeof window.exportPackage,
      btn: !!document.getElementById('btnPack'),
      btnText: (document.getElementById('btnPack')||{}).textContent,
      scriptOrder: Array.from(document.querySelectorAll('script[src]')).map(s=>s.getAttribute('src')),
    })`));
    eq(load.zip, 'function', 'window.ZipKit.buildZip 在');
    eq(load.pack, 'function', 'window.PackKit.buildPackage 在');
    eq(load.exp, 'function', 'window.exportPackage 在');
    ok(load.btn, '顶栏有 📦 设计包 按钮：' + load.btnText);
    const iZip = load.scriptOrder.indexOf('js/zip.js'), iPack = load.scriptOrder.indexOf('js/pack.js');
    const iApp = load.scriptOrder.indexOf('js/app.js');
    ok(iZip >= 0 && iPack >= 0 && iZip < iApp && iPack < iApp, 'zip.js / pack.js 都在 app.js 之前加载');

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 2. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 3) 空设计：只该有 design.json + manifest.json
    console.log('\n=== 3. 没有素材的设计 → 只有 2 个条目 ===');
    const empty = JSON.parse(await cdp.eval(`(async () => {
      const S = window.CanvasState;
      S.design = window.createDesign({ name: '空设计' });
      S.design.nodes = [];
      S.design.assets = [];
      S.design.background = null;
      await window.exportPackage();
      const r = window.__lastPackReport;
      return JSON.stringify({ ok: r.ok, n: r.counts.entries, names: r.names, problems: r.problems,
        zipBytes: r.zipBytes, assets: r.counts.assets });
    })()`));
    console.log('    · ' + JSON.stringify(empty.names));
    ok(empty.ok, '自检通过' + (empty.ok ? '' : ' —— ' + empty.problems.join('; ')));
    eq(empty.n, 2, '条目数 = 2（design.json + manifest.json）');
    eq(empty.assets, 0, '素材 0 个');
    eq(empty.names.join(','), 'design.json,manifest.json', '条目顺序固定');

    // ---------- 4) 真实设计（带素材：状态灯 + 拼装表 + 背景）
    //
    // ⚠️ **不能用 `applyPreset('race')` 当素材来源** —— 它建的是"警告灯"节点，
    // 但 `states.*.assetId` 全是空串（预设只演示状态**结构**，素材要用户自己选）。
    // 第一版就是这么写的，结果"包里 0 个素材"，看起来像打包坏了。
    // 所以这里**显式登记**内置素材并真的挂到节点上 —— 走的是用户真实路径。
    console.log('\n=== 4. 真实设计：导出 → Node 侧读回自检 ===');
    const got = JSON.parse(await cdp.eval(`(async () => {
      const S = window.CanvasState;
      const E = window.ensureBuiltinAsset;
      // 三态灯：off / warn / crit 三张图
      const off = E('assets/warning/lamp-off.png');
      const warn = E('assets/warning/lamp-warn.png');
      const crit = E('assets/warning/engine.png');
      // 拼装表：表盘 + 指针
      const dial = E('assets/dashboard/ring-thick.png');
      const needle = E('assets/needle/needle-classic.png');
      // 背景
      const bg = E('assets/background/carbon.png');

      const lamp = window.createNode(window.NODE_IMAGE, { name:'故障灯', x:0, y:0, w:40, h:40 });
      lamp.assetId = off;
      lamp.statePid = 'obd.coolant';
      lamp.states = { normal:{assetId:off,alpha:77,blink:false,blinkMs:200},
                      warn:{assetId:warn,alpha:255,blink:false,blinkMs:200},
                      critical:{assetId:crit,alpha:255,blink:true,blinkMs:200} };
      const gauge = window.createNode(window.NODE_GAUGE, { name:'拼装表', x:40, y:40, w:180, h:180 });
      gauge.parts = [ window.normalizePart({ kind:'dial', assetId:dial, x:0,y:0,w:180,h:180 }),
                      window.normalizePart({ kind:'needle', assetId:needle, x:0,y:0,w:40,h:160 }) ];
      S.design.nodes = [lamp, gauge];
      S.design.background = { path: 'assets/background/carbon.png', fit: 1 };
      // 顺带塞一个"登记了但没人引用"的素材（4b 要验它不进包）
      S.design.assets.push({ id:'as_unused', name:'没人用.png', kind:'custom',
        path:'assets/没人用.png', data:(S.design.assets.find(a=>a.path==='assets/background/carbon.png')||{}).data,
        w:16, h:16 });
      window.syncAssetImages();

      await window.exportPackage();
      const r = window.__lastPackReport;
      return JSON.stringify({
        ok: r.ok, problems: r.problems, names: r.names, counts: r.counts,
        zipBytes: r.zipBytes,
        manifest: r.manifest,
        assetsInDesign: (S.design.assets||[]).length,
        nodes: window.flatten(S.design.nodes).length,
        withData: (S.design.assets||[]).filter(a => a.data).length,
      });
    })()`));
    console.log('    · 设计里登记素材 ' + got.assetsInDesign + ' 个（其中 ' + got.withData + ' 个有字节）· 节点 ' +
      got.nodes + ' 个 · 包里 ' + got.counts.entries + ' 个条目 · ' + Math.round(got.zipBytes / 1024) + ' KB');
    console.log('    · 条目：' + got.names.join(' , '));
    ok(got.ok, '自检通过' + (got.ok ? '' : ' —— ' + got.problems.join('; ')));
    eq(got.counts.entries, 1 + got.manifest.assets.length + 1, '条目数 = 1 + 引用素材数 + 1（与 manifest 对得上）');
    eq(got.manifest.assets.length, 6, '打进了 6 个被引用的素材（三态 3 + 表盘 1 + 指针 1 + 背景 1）');
    ok(got.manifest.assets.length < got.assetsInDesign,
      '**只打引用的**：' + got.manifest.assets.length + ' < 设计里登记的 ' + got.assetsInDesign);
    ok(got.names.indexOf('design.json') === 0, 'design.json 在第一个');
    ok(got.names[got.names.length - 1] === 'manifest.json', 'manifest.json 在最后一个');
    ok(got.names.every(n => /^(design\.json|manifest\.json|assets\/)/.test(n)),
      '条目名都是相对路径（design.json / manifest.json / assets/…）');
    ok(got.manifest.assets.every(a => a.bytes > 0), '每个素材的字节数 > 0（不是空占位）');
    ok(got.manifest.assets.every(a => a.crc32 > 0), '每个素材都有 CRC32');
    ok(got.manifest.assets.every(a => a.refs.length > 0), '每条素材都记了"谁在用它"');
    const kinds = {};
    got.manifest.assets.forEach(a => a.refs.forEach(r => kinds[r] = (kinds[r] || 0) + 1));
    console.log('    · 来源分布：' + JSON.stringify(kinds));
    ok(kinds.background >= 1, '背景图被识别出来源（background）');
    ok(kinds.node >= 1, '图片节点/状态被识别出来源（node）');
    ok(kinds.part >= 1, '拼装表子部件被识别出来源（part）');

    // ---- **端到端验证"只打引用的"**：上面塞的那个"没人用.png"**不该**在包里
    console.log('\n=== 4b. 登记了但没被引用的素材 → 不进包 ===');
    ok(got.names.indexOf('assets/没人用.png') < 0, '没人引用的素材**没有**进包');
    ok(!got.manifest.missing.some(m => /没人用/.test(m.path)), '它也不该出现在 missing 里（它只是没被引用）');

    // ---------- 5) 把 zip 字节从页面里带出来，用 Node 的解析器读
    console.log('\n=== 5. 把 zip 从页面带出来，Node 侧独立解析 ===');
    // ⚠️ 用 exportPackage() **自己留下的那份字节**（window.__lastPackB64），
    // 不是"在测试里照着重造一份" —— 那样测的是重造的那份，不是用户拿到的那份。
    const b64 = await cdp.eval(`window.__lastPackB64 || ''`);
    ok(b64.length > 100, '拿到 exportPackage 产出的 zip 字节（base64 ' + Math.round(b64.length / 1024) + ' KB）');
    const zipBytes = Buffer.from(b64, 'base64');
    console.log('    · 带出来 ' + Math.round(zipBytes.length / 1024) + ' KB');
    const parsed = ZipKit.readZip(zipBytes);
    ok(parsed.entries.length > 2, 'Node 侧读回 ' + parsed.entries.length + ' 个条目');
    const manifestEntry = parsed.entries.find(e => e.name === 'manifest.json');
    ok(!!manifestEntry, 'Node 侧找到了 manifest.json');
    const mf = JSON.parse(Buffer.from(manifestEntry.data).toString('utf8'));
    eq(mf.format, 'icar.pack/1', 'manifest.format = icar.pack/1');
    eq(mf.designSchema, 'icar.ui/2', 'manifest.designSchema = icar.ui/2');
    eq(mf.entry, 'design.json', 'manifest.entry 指向 design.json');
    ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(mf.exportedAt),
      'manifest.exportedAt 是 ISO 时间串（真实导出走的是当前时间）：' + mf.exportedAt);
    ok(typeof mf.design.name === 'string' && mf.design.name.length > 0, 'manifest 记了设计名：' + mf.design.name);
    eq(mf.design.designW, JSON.parse(Buffer.from(parsed.entries.find(e => e.name === 'design.json').data).toString('utf8')).canvas.designW,
      'manifest 里的设计分辨率与 design.json 一致');

    // ---- 逐条核对：字节数 / CRC / 内容哈希（**全部在 Node 侧重算**）
    let sizeOk = 0, crcOk = 0, nameOk = 0;
    const problems = [];
    for (const m of mf.assets) {
      const e = parsed.entries.find(x => x.name === m.path);
      if (!e) { problems.push('缺条目 ' + m.path); continue; }
      nameOk++;
      const data = Buffer.from(e.data);
      if (data.length === m.bytes) sizeOk++; else problems.push(m.path + ' 字节数 ' + data.length + '≠' + m.bytes);
      if (nodeCrc32(data) === m.crc32) crcOk++;
      else problems.push(m.path + ' CRC ' + nodeCrc32(data).toString(16) + '≠' + m.crc32.toString(16));
    }
    eq(sizeOk, mf.assets.length, '每个条目的字节数与 manifest 一致（' + sizeOk + '/' + mf.assets.length + '）');
    eq(crcOk, mf.assets.length, '每个条目的 CRC 与 manifest 一致（Node 独立重算）');
    eq(nameOk, mf.assets.length, '每个 manifest 素材都能在 zip 里按路径找到');
    ok(problems.length === 0, '逐条核对无问题' + (problems.length ? '：' + problems.slice(0, 3).join('; ') : ''));

    // ---- 条目数恒等式：1 + 引用素材 + 1
    eq(parsed.entries.length, 1 + mf.assets.length + 1, '条目数 = 1 + 引用素材数 + 1');
    eq(mf.counts.entries, parsed.entries.length, 'manifest.counts.entries 与实际条目数一致');

    // ---- 每个条目：store 段的数据长度必须等于声明长度（偏移没算错的直接证据）
    let storeOk = 0;
    for (const e of parsed.entries) {
      if (e.method === 0 && e.data.length === e.size) storeOk++;
      else console.log('    ⚠️ ' + e.name + ' method=' + e.method + ' 数据长 ' + e.data.length + ' 声明 ' + e.size);
    }
    eq(storeOk, parsed.entries.length, '每个条目都是 store 且数据长度 = 声明长度（' + storeOk + '/' + parsed.entries.length + '）');

    // ---- design.json 本身要是**合法且能被工具自己的校验器接受**的
    const designEntry = parsed.entries.find(e => e.name === 'design.json');
    const designText = Buffer.from(designEntry.data).toString('utf8');
    const dj = JSON.parse(designText);
    eq(dj.schema, 'icar.ui/2', 'design.json 的 schema 是 icar.ui/2');
    const vres = await cdp.eval(`JSON.stringify(window.validateText(${JSON.stringify(designText)}).errors)`);
    eq(JSON.parse(vres).length, 0, '包里的 design.json 能被工具校验器接受（0 硬错误）');

    // ---------- 6) 背景图也要进包（它不在 assets 的引用里，只在 background.path）
    console.log('\n=== 6. 背景图进包 ===');
    // ⚠️ 这里必须用一张**还没有被任何节点引用**的素材当背景 ——
    // 否则它本来就在包里，"背景进包"这条断言等于没测。
    const bgRes = JSON.parse(await cdp.eval(`(async () => {
      const S = window.CanvasState;
      const id = window.ensureBuiltinAsset('assets/background/grid.png');   // 只有背景会引用它
      S.design.background = { path: 'assets/background/grid.png', fit: 2 };
      await window.exportPackage();
      const r = window.__lastPackReport;
      const hit = r.manifest.assets.find(x => x.path === 'assets/background/grid.png');
      return JSON.stringify({ ok: r.ok, hasBg: r.names.indexOf('assets/background/grid.png') >= 0,
        refs: hit ? hit.refs : null, bytes: hit ? hit.bytes : 0,
        missing: r.manifest.missing.length });
    })()`));
    ok(bgRes.hasBg, '只被背景引用的素材**进包了**（assets/background/grid.png）');
    ok(bgRes.refs && bgRes.refs.indexOf('background') >= 0,
      '它的来源被标成 background：' + JSON.stringify(bgRes.refs));
    ok(bgRes.bytes > 0, '背景的字节数 > 0（' + bgRes.bytes + ' 字节）');
    ok(bgRes.ok, '自检通过');
    eq(bgRes.missing, 0, '没有缺失素材');

    // ---------- 7) 缺字节的素材：不静默跳过
    console.log('\n=== 7. 素材字节读不到 → 如实报出，不静默跳过 ===');
    const miss = JSON.parse(await cdp.eval(`(async () => {
      const S = window.CanvasState;
      // 造一个"只有缩略图、没有字节"的素材（模拟：导入后重开工具）
      S.design.assets.push({ id:'as_lost', name:'丢了字节.png', kind:'custom', path:'assets/丢了字节.png', w:8,h:8 });
      S.design.nodes.push(window.createNode(window.NODE_IMAGE, { name:'缺图', assetId:'as_lost', x:0,y:0,w:40,h:40 }));
      await window.exportPackage();
      const r = window.__lastPackReport;
      const out = { missing: r.manifest.missing, names: r.names, ok: r.ok,
                    assets: r.manifest.assets.length };
      // 收尾：把这颗素材摘掉，别影响后面的断言
      S.design.assets = S.design.assets.filter(a => a.id !== 'as_lost');
      return JSON.stringify(out);
    })()`));
    eq(miss.missing.length, 1, '1 个素材被记进 missing');
    ok(/丢了字节/.test(miss.missing[0].path), 'missing 里指出了是哪个素材：' + miss.missing[0].path);
    ok(miss.missing[0].reason.length > 5, 'missing 里带了原因（不是空字符串）');
    ok(miss.names.indexOf('assets/丢了字节.png') < 0, '读不到字节的素材**没有**被塞进包（不产生坏条目）');
    ok(miss.ok, '自检仍然通过（缺素材不等于包是坏的）');

    // ---------- 8) 重复导出内容可复现（除时间戳）
    console.log('\n=== 8. 同一个设计导出两次：内容可复现 ===');
    const twice = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const mk = () => {
        const designJson = window.toV2Json(S.design);
        const refs = window.PackKit.collectAssetRefs(S.design,
          id => (S.design.assets||[]).find(a=>a.id===id) || null,
          p => (S.design.assets||[]).find(a=>window.PackKit.normPath(a.path)===window.PackKit.normPath(p)) || null);
        return JSON.stringify(refs);
      };
      return JSON.stringify({ a: mk(), b: mk() });
    })()`));
    eq(twice.a, twice.b, '两次收集到的引用清单完全一致');

    // ---------- 9) 撤销栈 / 设计文件不受影响
    console.log('\n=== 9. 导出**不改设计**（不该有副作用） ===');
    const side = JSON.parse(await cdp.eval(`(async () => {
      const S = window.CanvasState;
      const before = window.toV2Json(S.design);
      const undoBefore = document.getElementById('undoCount').textContent;
      await window.exportPackage();
      return JSON.stringify({
        same: before === window.toV2Json(S.design),
        undoBefore: undoBefore,
        undoAfter: document.getElementById('undoCount').textContent,
      });
    })()`));
    ok(side.same, '导出前后设计文件逐字节相同（导出不写设计）');
    eq(side.undoAfter, side.undoBefore, '导出不进撤销栈');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
