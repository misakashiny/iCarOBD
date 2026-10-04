// 验证子部件模型：格式 / 绘制 / UI / 指针角度
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9273;
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
    `--user-data-dir=${os.tmpdir()}\\edge-parts`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval(`window.confirm = () => true; window.alert = () => {}; window.prompt = () => 'x';`);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 常量与规范化 ----------
    console.log('\n=== 1. 部件常量与规范化 ===');
    const norm = await cdp.eval(`JSON.stringify({
      kinds: window.PART_KINDS.map(k => k.v),
      def: window.PART_DEFAULT,
      bad: window.normalizePart({ kind: '不存在', w: -5, alpha: 999, pivotX: 9, sweepFrom: 'x' }),
      empty: window.normalizePart(null),
    })`);
    const N = JSON.parse(norm);
    console.log('    · 种类 ' + N.kinds.join('/'));
    console.log('    · 非法 → ' + JSON.stringify(N.bad));
    eq(N.kinds.length, 5, '5 种部件（表盘/刻度/指针/数值/装饰）');
    eq(N.bad.kind, 'decor', '未知种类回落到 decor');
    eq(N.bad.w, 1, '负宽度夹到 1');
    eq(N.bad.alpha, 255, '透明度夹到 255');
    eq(N.bad.pivotX, 2, 'pivot 夹到上限 2');
    eq(N.bad.sweepFrom, 135, '非数字扫描起点回落默认');
    ok(N.empty.kind === 'decor' && N.empty.w > 0, 'null 也能拿到完整默认值');

    // ---------- 2) 指针角度 ----------
    console.log('\n=== 2. 指针角度（这是"值 → 角度"的唯一入口）===');
    const ang = await cdp.eval(`(() => {
      const p = { kind:'needle', sweepFrom:135, sweepTo:405, rotation:0 };
      const at = v => window.partAngle(p, v, 0, 100);
      const out = { v0: at(0), v50: at(50), v100: at(100), 超上限: at(150), 负值: at(-10) };
      // 静态 rotation 会叠加
      out.带rotation = window.partAngle({ kind:'needle', sweepFrom:135, sweepTo:405, rotation:90 }, 0, 0, 100);
      // 反向扫描（从大到小）
      out.反向 = window.partAngle({ kind:'needle', sweepFrom:405, sweepTo:135 }, 0, 0, 100);
      // 量程为 0 时不能除零
      out.零量程 = window.partAngle(p, 50, 50, 50);
      return JSON.stringify(out);
    })()`);
    const A = JSON.parse(ang);
    console.log('    · ' + ang);
    eq(A.v0, 135, '值 = min → 起始角 135°');
    eq(A.v50, 270, '值 = 中点 → 270°（正好扫过一半）');
    eq(A.v100, 405, '值 = max → 结束角 405°');
    eq(A.超上限, 405, '超过上限夹在 405°（不会转过头）');
    eq(A.负值, 135, '低于下限夹在 135°');
    eq(A.带rotation, 225, '静态 rotation 叠加');
    eq(A.反向, 405, '反向扫描（405→135）也支持');
    ok(Number.isFinite(A.零量程), '量程为 0 不产生 NaN（除零保护）');

    // ---------- 3) 格式往返 ----------
    console.log('\n=== 3. 部件格式往返 ===');
    const rt = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const txt = JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        assets:[{id:'as1',name:'盘',kind:'dashboard',path:'assets/x.png',w:256,h:256}],
        nodes:[{ id:'g', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000,
                 x:0,y:0,w:200,h:200,
                 parts:[
                   { kind:'dial', assetId:'as1', x:0,y:0,w:200,h:200 },
                   { kind:'needle', assetId:'as1', x:76,y:4,w:48,h:192, pivotX:0.5, pivotY:0.9, sweepFrom:135, sweepTo:405 },
                   { kind:'value', x:70,y:80,w:60,h:40 }
                 ]}]
      });
      const r = window.parseDesign(txt);
      const d = r.design;
      const g = d ? window.flatten(d.nodes).find(n => n.type === 'gauge') : null;
      const json = window.toV2Json(d);
      const back = window.parseDesign(json);
      const g2 = back.design ? window.flatten(back.design.nodes).find(n => n.type === 'gauge') : null;
      return JSON.stringify({
        errors: r.errors.length,
        部件数: g && g.parts ? g.parts.length : -1,
        指针pivotY: g && g.parts ? g.parts[1].pivotY : null,
        文件里有parts: JSON.parse(json).nodes[0].parts ? JSON.parse(json).nodes[0].parts.length : -1,
        往返错误: back.errors.length,
        往返部件数: g2 && g2.parts ? g2.parts.length : -1,
        往返一致: g && g2 ? JSON.stringify(g.parts) === JSON.stringify(g2.parts) : false,
      });
    })()`);
    const RT = JSON.parse(rt);
    console.log('    · ' + rt);
    eq(RT.errors, 0, '带部件的设计解析 0 错误');
    eq(RT.部件数, 3, '3 个部件都读进来了');
    eq(RT.指针pivotY, 0.9, '指针的 pivot 保住了（0.9 = 轴心在图片底部）');
    eq(RT.文件里有parts, 3, '部件写进文件');
    eq(RT.往返错误, 0, '往返 0 错误');
    ok(RT.往返一致, '部件逐项往返一致');

    // ---------- 4) 没素材时给警告 ----------
    console.log('\n=== 4. 缺素材要警告（否则用户对着空白猜）===');
    const warn = await cdp.eval(`(() => {
      const r = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        nodes:[{ id:'g', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000,
                 x:0,y:0,w:200,h:200,
                 parts:[{ kind:'dial' }] }]
      }));
      return JSON.stringify({ 错误数: r.errors.length, warnings: r.warnings });
    })()`);
    const W = JSON.parse(warn);
    console.log('    · ' + warn);
    eq(W.错误数, 0, '没素材**不是硬错误**（设计仍可用，只是这一层画不出来）');
    ok(W.warnings.some(x => x.indexOf('没有选素材') >= 0), '给了"没选素材"的警告');

    // ---------- 5) 空数组 = 回到样式画法 ----------
    console.log('\n=== 5. 空部件数组 = 走样式画法（向后兼容）===');
    const empty = await cdp.eval(`(() => {
      const a = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        nodes:[{ id:'g', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000,
                 x:0,y:0,w:200,h:200, parts:[] }]
      }));
      const b = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        nodes:[{ id:'g', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000,
                 x:0,y:0,w:200,h:200 }]
      }));
      const ga = window.flatten(a.design.nodes)[0];
      const gb = window.flatten(b.design.nodes)[0];
      return JSON.stringify({ 空数组: ga.parts, 没字段: gb.parts });
    })()`);
    const E = JSON.parse(empty);
    console.log('    · ' + empty);
    eq(E.空数组, null, '空数组 → null（走样式画法）');
    eq(E.没字段, null, '没字段 → null');

    // ---------- 6) 画布真的按部件画 ----------
    console.log('\n=== 6. 画布真的按部件画 ===');
    const draw = await cdp.eval(`(() => {
      const S = window.CanvasState;
      // 用**打桩**代替真实图片解码：headless 里 data URL 解码会让 CDP 目标不稳定。
      // 我们真正要验的是"部件路径有没有被走到、画了几次、角度对不对"，
      // 而不是浏览器能不能解码 PNG（那是浏览器的事）。
      // 用**真实 canvas 元素**打桩：drawImage 接受 HTMLCanvasElement，
      // 而纯对象会报 "not of type ..."。canvas 上挂 complete/naturalWidth
      // 就能骗过 assetBitmap 的"已就绪"判定，又不触发真实解码。
      const fake = document.createElement("canvas");
      fake.width = 32; fake.height = 32;
      Object.defineProperty(fake, "complete", { value: true });
      Object.defineProperty(fake, "naturalWidth", { value: 32 });
      Object.defineProperty(fake, "naturalHeight", { value: 32 });
      const URL = 'fake://dial';
      S.imgCache = S.imgCache || {};
      S.imgCache[URL] = fake;
      S.design.assets = [{ id:'as-fake', name:'假盘', kind:'custom', path:URL, w:32, h:32 }];
      S.design.nodes = [];
      const n = window.createNode(window.NODE_GAUGE, {
        name:'部件表', pid:'obd.rpm', min:0, max:8000, x:0, y:0, w:200, h:200,
      });
      n.parts = [
        window.normalizePart({ kind:'dial',   assetId:'as-fake', x:0, y:0, w:200, h:200 }),
        window.normalizePart({ kind:'needle', assetId:'as-fake', x:76, y:4, w:48, h:192,
                               pivotX:0.5, pivotY:0.9, sweepFrom:135, sweepTo:405 }),
        window.normalizePart({ kind:'value',  x:70, y:80, w:60, h:40 }),
      ];
      S.design.nodes.push(n);
      S.selection = []; S.showGrid = false; S.showPid = false; S.previewValues = {};

      // 打桩：数 drawImage 调用与旋转角
      const cv = document.getElementById('cv');
      const c2 = cv.getContext('2d');
      const origDraw = c2.drawImage.bind(c2);
      const origRot = c2.rotate.bind(c2);
      let images = 0, rotations = [];
      c2.drawImage = function () { images++; return origDraw.apply(null, arguments); };
      c2.rotate = function (a) { rotations.push(Math.round(a * 180 / Math.PI)); return origRot(a); };

      // 值 = 0 → 指针 135°；值 = max → 405°
      S.previewValues = { 'std_0C': 0 };
      window.draw();
      const atMin = { images: images, rot: rotations.slice() };

      images = 0; rotations = [];
      S.previewValues = { 'std_0C': 8000 };
      window.draw();
      const atMax = { images: images, rot: rotations.slice() };

      images = 0; rotations = [];
      n.parts = null;
      window.draw();
      const noParts = { images: images };

      c2.drawImage = origDraw; c2.rotate = origRot;
      S.showGrid = true;
      return JSON.stringify({
        有部件_图片数: atMin.images, 有部件_角度: atMin.rot,
        满值_角度: atMax.rot,
        无部件_图片数: noParts.images,
      });
    })()`);
    const D = JSON.parse(draw);
    console.log('    · ' + draw);
    eq(D.有部件_图片数, 2, '3 个部件里画了 2 张图（数值部件是文字，不算图）');
    ok(D.有部件_角度.indexOf(135) >= 0, '值 = min 时指针转到 135°（实际 ' + D.有部件_角度.join(',') + '）');
    ok(D.满值_角度.indexOf(405) >= 0, '值 = max 时指针转到 405°（实际 ' + D.满值_角度.join(',') + '）');
    eq(D.无部件_图片数, 0, '**没有部件时一张图都不画** —— 证明两条路径确实是分开的');

    // ---------- 7) UI ----------
    console.log('\n=== 7. 属性面板的部件编辑器 ===');
    const ui = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      // 用测试 6 里已登记的素材（assets 里现在只有它）
      const aid = (S.design.assets[0] || {}).id || 'as-fake';
      n.parts = [window.normalizePart({ kind:'dial', assetId:aid, x:0,y:0,w:200,h:200 })];
      S.selection = [n.id];
      window.onSelectionChanged();
      const out = {};
      out.有部件组 = Array.from(document.querySelectorAll('#props .phead'))
        .some(e => e.textContent.indexOf('子部件') >= 0);
      out.部件框数 = document.querySelectorAll('#props .partBox').length;
      out.有加部件按钮 = Array.from(document.querySelectorAll('#props button'))
        .some(b => b.textContent.indexOf('加部件') >= 0);
      out.种类标签 = (document.querySelector('#props .partKind') || {}).textContent || null;
      out.有素材名 = (document.querySelector('#props .partName') || {}).textContent || null;
      // 加一个部件
      window.addPart();
      out.加后数量 = n.parts.length;
      // 上移下移
      window.movePart(1, -1);
      out.移动后第一件 = n.parts[0].kind;
      // 改 pivot
      n.parts[0].kind = 'needle';
      window.setPartNum(0, 'pivotY', 0.9);
      out.pivotY = n.parts[0].pivotY;
      // 清空
      window.clearParts();
      out.清空后 = n.parts;
      return JSON.stringify(out);
    })()`);
    const U = JSON.parse(ui);
    console.log('    · ' + ui);
    ok(U.有部件组, '属性面板有「子部件」组');
    ok(U.部件框数 >= 1, '渲染出部件卡片（' + U.部件框数 + ' 个）');
    ok(U.有加部件按钮, '有「＋ 加部件」按钮');
    eq(U.种类标签, '表盘', '部件卡片显示种类');
    ok(U.有素材名 && U.有素材名.indexOf('假盘') >= 0, '显示素材名（不是 id）：' + U.有素材名);
    eq(U.加后数量, 2, '加部件生效');
    eq(U.移动后第一件, 'dial', '上移生效（新加的 needle 挪到后面）');
    eq(U.pivotY, 0.9, '改 pivot 生效');
    eq(U.清空后, null, '清空后回到 null（样式画法）');


    // ---------- 8) 多指针表（每个 needle 各绑一个 PID）
    console.log('\n=== 8. 多指针表 ===');
    const multi = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const out = {};
      const rpm = { pid: 'std_0C', min: 0, max: 8000 };
      const values = { 'std_0C': 4000, 'std_0D': 120 };

      // 1) 没绑 pid 的指针 → 用仪表自己的
      const p1 = window.normalizePart({ kind: 'needle' });
      const r1 = window.partValueRange(p1, rpm, values);
      out.跟随仪表 = { v: r1.value, min: r1.min, max: r1.max };

      // 2) 绑了车速 → 用**车速的值与量程**
      const p2 = window.normalizePart({ kind: 'needle', rawPid: 'obd.speed' });
      out.绑定后 = { pid: p2.pid, raw: p2.rawPid, v: null, min: null, max: null };
      const r2 = window.partValueRange(p2, rpm, values);
      out.绑定后.v = r2.value; out.绑定后.min = r2.min; out.绑定后.max = r2.max;

      // 3) 两个指针的角度**必须不同**（这是多指针的意义）
      out.角度_跟随 = window.partAngle(p1, r1.value, r1.min, r1.max);
      out.角度_绑定 = window.partAngle(p2, r2.value, r2.min, r2.max);

      // 4) 没有实时数据时用 min（不悬在半空）
      const r3 = window.partValueRange(p2, rpm, {});
      out.无数据 = r3.value;

      // 5) 绑了未知 PID → 回落 0~100 而不是崩
      const p3 = window.normalizePart({ kind: 'needle', rawPid: '不存在的PID' });
      const r4 = window.partValueRange(p3, rpm, {});
      out.未知PID = { pid: p3.pid, min: r4.min, max: r4.max };

      // 6) 非指针部件不该被 pid 影响
      const p4 = window.normalizePart({ kind: 'dial', rawPid: 'obd.speed' });
      out.dial的pid = p4.pid;

      // 7) 序列化保留 pid
      const n = window.createNode(window.NODE_GAUGE, { name:'双针', pid:'obd.rpm', min:0, max:8000, x:0,y:0,w:200,h:200 });
      n.parts = [p1, p2];
      S.design.nodes = [n];
      const j = JSON.parse(window.toV2Json(S.design));
      const parts = j.nodes[0].parts;
      out.文件里 = parts.map(x => x.rawPid || x.pid || '(无)').join(' | ');
      out.跟随的不写pid = !('pid' in parts[0]) && !('rawPid' in parts[0]);

      // 8) 往返
      const back = window.parseDesign(window.toV2Json(S.design));
      const g2 = window.flatten(back.design.nodes)[0];
      out.往返错误 = back.errors.length;
      out.往返第二个指针pid = g2.parts[1].pid;
      out.往返第二个指针raw = g2.parts[1].rawPid;
      return JSON.stringify(out);
    })()`);
    const MN = JSON.parse(multi);
    console.log('    · ' + multi);
    eq(MN.跟随仪表.v, 4000, '没绑 pid → 用仪表自己的值（4000）');
    eq(MN.跟随仪表.max, 8000, '量程也是仪表自己的（0~8000）');
    eq(MN.绑定后.pid, 'std_0D', '绑 obd.speed → 解析成 std_0D');
    eq(MN.绑定后.raw, 'obd.speed', 'rawPid 保留别名（回显用）');
    eq(MN.绑定后.v, 120, '用**车速的值**（120）');
    ok(MN.绑定后.max !== 8000, '量程跟着 PID 走（' + MN.绑定后.max + '，不是 8000）');
    ok(MN.角度_跟随 !== MN.角度_绑定, '两个指针角度**不同**（跟随 ' + Math.round(MN.角度_跟随) + '° vs 绑定 ' + Math.round(MN.角度_绑定) + '°）');
    eq(MN.无数据, 0, '没有实时数据时用 min（不悬在半空）');
    eq(MN.未知PID.pid, '不存在的PID', '未知 PID 原样保留');
    eq(MN.未知PID.max, 100, '未知 PID 的量程回落 0~100（不崩）');
    eq(MN.dial的pid, '', '非指针部件不解析 pid（表盘不该有绑定）');
    ok(MN.文件里.indexOf('obd.speed') >= 0, '序列化写出 rawPid：' + MN.文件里);
    ok(MN.跟随的不写pid, '跟随仪表的指针**不写** pid（避免每个部件塞默认值）');
    eq(MN.往返错误, 0, '双针表往返 0 错误');
    eq(MN.往返第二个指针pid, 'std_0D', '往返后第二个指针的 pid 还在');
    eq(MN.往返第二个指针raw, 'obd.speed', '往返后 rawPid 还在');


    // ---------- 9) 子部件嵌套
    console.log('\n=== 9. 子部件嵌套 ===');
    const nest = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const out = {};

      // 1) 规范化：子部件被递归处理
      const p = window.normalizePart({
        kind: 'needle', assetId: 'as1', rawPid: 'obd.rpm',
        children: [
          { kind: 'decor', assetId: 'as2', x: -10, y: -10, w: 20, h: 20 },
          { kind: 'decor', assetId: 'as3', children: [ { kind: 'decor', assetId: 'as4' } ] }
        ]
      });
      out.子部件数 = p.children.length;
      out.二层子部件数 = p.children[1].children.length;
      out.子部件有默认值 = p.children[0].pivotX === 0.5 && p.children[0].alpha === 255;
      out.子部件的子部件也被规范化 = p.children[1].children[0].kind === 'decor';

      // 2) 空 children 不写进文件
      const n = window.createNode(window.NODE_GAUGE, { name:'嵌套', pid:'obd.rpm', min:0, max:8000, x:0,y:0,w:200,h:200 });
      n.parts = [
        window.normalizePart({ kind: 'needle', assetId: 'as1' }),
        p
      ];
      S.design.nodes = [n];
      const j = JSON.parse(window.toV2Json(S.design));
      const parts = j.nodes[0].parts;
      out.第一个没children字段 = !('children' in parts[0]);
      out.第二个有children = Array.isArray(parts[1].children) && parts[1].children.length === 2;
      out.二层还在 = parts[1].children[1].children && parts[1].children[1].children.length === 1;
      out.空的被剔了 = !('children' in parts[1].children[0]);

      // 3) 往返
      const back = window.parseDesign(window.toV2Json(S.design));
      const g2 = window.flatten(back.design.nodes)[0];
      out.往返错误 = back.errors.length;
      out.往返子部件数 = g2.parts[1].children.length;
      out.往返二层 = g2.parts[1].children[1].children.length;
      out.往返子部件x = g2.parts[1].children[0].x;

      // 4) 深度上限：手改一个 10 层深的文件，不该爆栈
      let deep = { kind:'decor', assetId:'as1' };
      for (let i = 0; i < 10; i++) deep = { kind:'decor', assetId:'as1', children:[deep] };
      const d10 = window.normalizePart(deep);
      let cnt = 0, cur = d10;
      while (cur && cur.children && cur.children.length) { cnt++; cur = cur.children[0]; }
      out.深度被夹到 = cnt;

      // 5) **真的画一遍**（递归绘制不崩）。
      //    用 drawNodePreview —— 它把节点画进一个离屏 canvas，
      //    是唯一导出的绘制入口（draw() 是模块内部的）。
      try {
        const cv = document.createElement('canvas');
        cv.width = 200; cv.height = 200;
        window.drawNodePreview(n, cv);
        const g = cv.getContext('2d');
        const d = g.getImageData(0, 0, 200, 200).data;
        let nonEmpty = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonEmpty++;
        out.绘制没崩 = true;
        out.画出的像素 = nonEmpty;
      } catch (e) { out.绘制没崩 = false; out.绘制错误 = String(e.message).slice(0, 80); }
      return JSON.stringify(out);
    })()`);
    const NS = JSON.parse(nest);
    console.log('    · ' + nest);
    eq(NS.子部件数, 2, '子部件被解析（2 个）');
    eq(NS.二层子部件数, 1, '**二层**子部件也解析了');
    ok(NS.子部件有默认值, '子部件套用 PART_DEFAULT（pivot/alpha 有默认值）');
    ok(NS.子部件的子部件也被规范化, '递归规范化到底');
    ok(NS.第一个没children字段, '没有子部件的部件**不写** children 字段');
    ok(NS.第二个有children, '有子部件的照常写出');
    ok(NS.二层还在, '二层结构写出去了');
    ok(NS.空的被剔了, '空的 children 被剔除（不留噪音）');
    eq(NS.往返错误, 0, '嵌套结构往返 0 错误');
    eq(NS.往返子部件数, 2, '往返后子部件数不变');
    eq(NS.往返二层, 1, '往返后二层不变');
    eq(NS.往返子部件x, -10, '往返后子部件坐标不变');
    ok(NS.深度被夹到 <= 5, '超深结构被夹到 5 层（实测 ' + NS.深度被夹到 + ' 层，不爆栈）');
    ok(NS.绘制没崩, '递归绘制没崩' + (NS.绘制错误 ? '：' + NS.绘制错误 : ''));
    // 素材是假的（as1/as2 没登记），所以画不出图 —— 但**表盘/文字的兜底绘制**
    // 应该留下像素。全 0 说明整个绘制链断了。
    ok(NS.画出的像素 > 0, '递归绘制**确实画出了东西**（' + NS.画出的像素 + ' 个非透明像素）');

    // ---------- 10) 子部件可直接拖（v2.32.0）
  console.log('\n=== 10. 子部件可直接拖 ===');
  const pd = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    // 造一个带两个部件的仪表
    const n = window.createNode(window.NODE_GAUGE, { name: "拼装", pid: "obd.rpm", min: 0, max: 8000, x: 60, y: 60, w: 200, h: 200 });
    n.parts = [
      window.normalizePart({ kind: "dial", assetId: "as1", x: 10, y: 10, w: 180, h: 180 }),
      window.normalizePart({ kind: "needle", assetId: "as2", x: 90, y: 20, w: 20, h: 150, sweepFrom: 135, sweepTo: 405 }),
    ];
    S.design.nodes = [n];
    S.selection = [n.id];
    S.selectedPart = -1;

    // --- hitPart：从后往前判（上面的先命中）
    out.命中表盘 = window.hitPart(n, 100, 100);
    out.命中指针 = window.hitPart(n, 100, 60);
    out.命中空白 = window.hitPart(n, 300, 300);

    // --- 拖一个部件
    const cv = document.getElementById("cv");
    const rect = cv.getBoundingClientRect();
    const dpr = cv.width / rect.width;
    // ⚠️ 手柄位置基于 **selectionMatrix**（非图片节点 = uniformMatrix），
    // 用 deviceMatrix 算会点空（v2.25.0 的教训）。
    const m = window.selectionMatrix(n, window.deviceMatrix(S.design.nodes, n.id));
    const toClient = p => ({ x: rect.x + p.x / dpr, y: rect.y + p.y / dpr });
    const p0 = toClient(window.matApply(m, 100, 100));   // 表盘中心
    const p1 = toClient(window.matApply(m, 130, 120));   // 往右下拖 30/20
    // ⚠️ 拖的是**下标 1**（指针在上面，hitPart 从后往前判命中的是它）
    const before = { x: n.parts[1].x, y: n.parts[1].y };
    cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true,
      clientX: p0.x, clientY: p0.y, pointerId: 1, isPrimary: true }));
    out.拖拽模式 = S.drag ? S.drag.mode : "none";
    out.选中了部件 = S.selectedPart;
    cv.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true,
      clientX: p1.x, clientY: p1.y, pointerId: 1, isPrimary: true }));
    out.拖后 = { x: n.parts[1].x, y: n.parts[1].y };
    cv.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));
    out.位移 = [Math.round((n.parts[1].x - before.x) * 10) / 10, Math.round((n.parts[1].y - before.y) * 10) / 10];
    out.另一部件没动 = n.parts[0].x === 10 && n.parts[0].y === 10;   // 动的是 parts[1]，表盘应当没动

    // --- 拖角手柄仍应优先（不能把 resize 抢走）
    const hp = window.handlePositionsFor(n.id).hp;
    const br = hp.corners[2];
    const h0 = toClient(window.matApply(m, br.x, br.y));
    const h1 = toClient(window.matApply(m, br.x + 40, br.y + 40));
    cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true,
      clientX: h0.x, clientY: h0.y, pointerId: 1, isPrimary: true }));
    out.角手柄模式 = S.drag ? S.drag.mode : "none";
    cv.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, isPrimary: true }));

    // --- 换选中对象时清掉部件选择
    S.selectedPart = 1;
    window.onSelectionChanged();
    out.换选中后清了 = S.selectedPart === -1;

    S.design.nodes = [];
    return JSON.stringify(out);
  })()`);
  const PD = JSON.parse(pd);
  console.log('    · ' + pd);
  // 那个点**同时**在表盘与指针的框内 —— hitPart 从后往前判，所以命中上面的指针。
  // 这正是要的行为（视觉上指针在上面）。
  eq(PD.命中表盘, 1, "hitPart 在该点命中**指针**（下标 1，它在上面）");
  eq(PD.命中指针, 1, "hitPart 命中指针（下标 1，**从后往前判**所以上面的先中）");
  eq(PD.命中空白, -1, "点在部件外返回 -1");
  eq(PD.拖拽模式, "part", "**按下部件进入 part 拖拽模式**");
  eq(PD.选中了部件, 1, "同时选中了拖的那个部件（下标 1）");
  ok(Math.abs(PD.位移[0]) > 5 && Math.abs(PD.位移[1]) > 5,
    "部件**真的被拖走了**（位移 " + PD.位移[0] + ", " + PD.位移[1] + "）");
  ok(PD.另一部件没动, "**只动拖的那个**（下标 1），表盘（下标 0）没动");
  eq(PD.角手柄模式, "resize", "**拖角手柄仍然是 resize**（没被部件拖拽抢走）");
  ok(PD.换选中后清了, "换选中对象时清掉部件选择");

  await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
