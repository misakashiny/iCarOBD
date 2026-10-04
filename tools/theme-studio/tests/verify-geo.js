// 数值验证排版几何（我这个模型读不了图，只能用数字判断"好不好看"）
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9263;
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
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
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

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-geo`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval('window.resetPanelLayout && window.resetPanelLayout();');
    await sleep(600);

    const g = await cdp.eval(`(() => {
      const box = document.getElementById('assets');
      const br = box.getBoundingClientRect();
      const thumbs = Array.from(box.querySelectorAll('.assetThumb'));
      const rects = thumbs.map(e => e.getBoundingClientRect()).filter(r => r.width > 0);
      // 一行几个：按 top 分组
      const rows = {};
      rects.forEach(r => { const k = Math.round(r.top); rows[k] = (rows[k]||0)+1; });
      const perRow = Object.values(rows);
      const chips = Array.from(box.querySelectorAll('.ctrlChip')).map(e=>e.getBoundingClientRect()).filter(r=>r.width>0);
      const chipRows = {};
      chips.forEach(r => { const k = Math.round(r.top); chipRows[k]=(chipRows[k]||0)+1; });
      // 有没有横向溢出
      const overflow = Array.from(box.querySelectorAll('*')).filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > br.right + 1 || r.left < br.left - 1);
      }).length;
      // 缩略图尺寸是否一致
      const ws = [...new Set(rects.map(r=>Math.round(r.width)))];
      const hs = [...new Set(rects.map(r=>Math.round(r.height)))];
      return JSON.stringify({
        panelW: Math.round(br.width), panelH: Math.round(br.height),
        thumbCount: rects.length,
        perRowCounts: perRow,
        maxPerRow: Math.max(...perRow),
        rowCount: perRow.length,
        thumbW: ws, thumbH: hs,
        chipRows: Object.values(chipRows),
        overflow,
        scrollH: box.scrollHeight, clientH: box.clientHeight,
      });
    })()`);
    const G = JSON.parse(g);
    console.log('\n=== 素材库排版几何 ===');
    console.log('  面板 ' + G.panelW + '×' + G.panelH + '  内容高 ' + G.scrollH + '（可视 ' + G.clientH + '）');
    console.log('  缩略图 ' + G.thumbCount + ' 个，每行 ' + G.maxPerRow + ' 个，共 ' + G.rowCount + ' 行');
    console.log('  缩略图尺寸: ' + G.thumbW.join('/') + ' × ' + G.thumbH.join('/'));
    console.log('  控件芯片每行: ' + G.chipRows.join('/'));
    console.log('  横向溢出元素: ' + G.overflow);

    ok(G.thumbCount >= 30, '缩略图都渲染了（' + G.thumbCount + '）');
    ok(G.maxPerRow >= 3, `一行至少 3 个（实际 ${G.maxPerRow}）—— 这才叫「网格」而不是「列表」`);
    // 38 个素材分散在 9 个分类里、各自成网格，行数本来就比 ceil(38/4) 多。
    // 真正该管的是「别长得离谱」：49 个条目（38 素材 + 11 控件）滚 2 屏左右是合理的。
    const screens = G.scrollH / G.clientH;
    ok(screens <= 2.5, `内容 ${G.scrollH}px / 可视 ${G.clientH}px = ${screens.toFixed(2)} 屏（≤2.5）`);
    ok(G.thumbW.length === 1, '所有缩略图宽度一致（对齐）');
    ok(G.thumbH.length === 1, '所有缩略图高度一致（对齐）');
    ok(G.thumbW[0] >= 48 && G.thumbW[0] <= 100, `缩略图宽度合理（${G.thumbW[0]}px，能看清形状又不浪费）`);
    ok(G.overflow === 0, '没有元素横向溢出面板');
    // 40 个芯片排下来最后一行可能只剩 1 个 —— 要求"**至少有一行**是多列"就够
    // （原来要求每一行都 ≥2，数量一变就会误报）
    ok(Math.max(...G.chipRows) >= 2, `控件芯片是多列排（最宽一行 ${Math.max(...G.chipRows)} 个）`);

  
  // ---------- 等比缩放（v2.21.0，用户报的"缩放之后全是扁的"）
  console.log('\n=== 等比缩放 ===');
  const lock = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    out.默认开 = S.aspectLock !== false;
    out.有函数 = typeof window.setAspectLock === 'function' && typeof window.fitNodeAspect === 'function';

    // 建一个 4:1 的图片节点
    const a = (window.BUILTIN_ASSETS || []).find(x => x.w / x.h > 3) || (window.BUILTIN_ASSETS || [])[0];
    const id = 'lock-test';
    S.design.assets = (S.design.assets || []).filter(x => x.id !== id);
    S.design.assets.push({ id: id, name: '横条', kind: a.kind, path: a.path, data: a.data, w: a.w, h: a.h });
    S.design.nodes = [];
    window.addImageNode(id);
    const n = S.design.nodes[0];
    n.x = 40; n.y = 40;
    out.素材比 = +(a.w / a.h).toFixed(3);
    out.初始 = n.w + 'x' + n.h;
    out.初始比 = +(n.w / n.h).toFixed(3);

    // 拖右下角：横向 +60，纵向 +60（自由拉伸会明显改变比例）
    //
    // ⚠️ 坐标换算必须用 **dpr = 位图宽 / CSS 宽**，不是 S.zoom ——
    // 手柄命中用的是设备矩阵，混用会点空（第一版就是这样，尺寸纹丝不动，
    // 于是"保持比例"那条断言**空过**了，看起来还通过）。
    // 另外 pointermove 要派发到 **cv**，不是 window。
    S.selection = [n.id];
    const cv = document.getElementById("cv");
    const rect = cv.getBoundingClientRect();
    const dpr = cv.width / rect.width;
    const toClient = p => ({ x: rect.x + p.x / dpr, y: rect.y + p.y / dpr });

    function dragCorner(handleIndex, dxCanvas, dyCanvas, alt) {
      const m = window.deviceMatrix(S.design.nodes, n.id);
      const hp = window.handlePositionsFor(n.id).hp;
      const c = hp.corners[handleIndex];
      const p0 = toClient(window.matApply(m, c.x, c.y));
      const p1 = toClient(window.matApply(m, c.x + dxCanvas, c.y + dyCanvas));
      cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true,
        clientX: p0.x, clientY: p0.y, pointerId: 1, isPrimary: true }));
      const mode = S.drag ? S.drag.mode : "none";
      cv.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, cancelable: true,
        clientX: p1.x, clientY: p1.y, pointerId: 1, isPrimary: true, altKey: !!alt }));
      cv.dispatchEvent(new PointerEvent("pointerup", { bubbles: true,
        pointerId: 1, isPrimary: true }));
      return mode;
    }

    // 1) 锁开（默认）：比例应当保持，而且**尺寸必须真的变了**
    out.拖拽模式 = dragCorner(2, 60, 60, false);
    out.锁开_尺寸 = n.w + "x" + n.h;
    out.锁开_比 = +(n.w / n.h).toFixed(3);
    out.锁开_确实变了 = (n.w !== 90);

    // 2) Alt 临时解锁：应当自由拉伸
    n.w = 90; n.h = 90 / (a.w / a.h);
    dragCorner(2, 60, 60, true);
    out.Alt_尺寸 = n.w + "x" + n.h;
    out.Alt_比 = +(n.w / n.h).toFixed(3);

    // 3) 关掉锁：应当自由拉伸
    window.setAspectLock(false);
    out.关后_状态 = S.aspectLock;
    n.w = 90; n.h = 90 / (a.w / a.h);
    dragCorner(2, 60, 60, false);
    out.关_尺寸 = n.w + "x" + n.h;
    out.关_比 = +(n.w / n.h).toFixed(3);
    window.setAspectLock(true);
    // 4) 恢复素材比例
    n.w = 200; n.h = 50;   // 故意压扁成 4:1（素材是别的比例）
    S.selection = [n.id];
    window.fitNodeAspect();
    out.恢复_尺寸 = n.w + 'x' + n.h;
    out.恢复_比 = +(n.w / n.h).toFixed(3);

    // 5) 属性面板里有开关
    window.renderProps();
    out.面板有开关 = !!document.querySelector('#props input[type=checkbox][onchange*="setAspectLock"]');
    S.design.nodes = [];
    return JSON.stringify(out);
  })()`);
  const LK = JSON.parse(lock);
  console.log('    · ' + lock);
  ok(LK.默认开, '**等比锁默认是开的**');
  ok(LK.有函数, 'setAspectLock / fitNodeAspect 都在');
  ok(LK.锁开_确实变了, '拖角手柄**真的改动了尺寸**（不是空过）：' + LK.锁开_尺寸 + '，拖拽模式=' + LK.拖拽模式);
  ok(Math.abs(LK.锁开_比 - LK.素材比) / LK.素材比 < 0.03,
    '锁开时拖角保持比例（素材 ' + LK.素材比 + ' → 节点 ' + LK.锁开_比 + '，' + LK.锁开_尺寸 + '）');
  ok(Math.abs(LK.Alt_比 - LK.素材比) / LK.素材比 > 0.10,
    '**按住 Alt 临时解锁**，比例确实变了（' + LK.Alt_比 + '，' + LK.Alt_尺寸 + '）');
  ok(LK.关后_状态 === false, 'setAspectLock(false) 生效');
  ok(Math.abs(LK.关_比 - LK.素材比) / LK.素材比 > 0.10,
    '关掉锁后可以自由拉伸（' + LK.关_比 + '，' + LK.关_尺寸 + '）');
  ok(Math.abs(LK.恢复_比 - LK.素材比) / LK.素材比 < 0.03,
    '「恢复素材比例」把 4:1 修正回 ' + LK.素材比 + '（' + LK.恢复_尺寸 + '）');
  ok(LK.面板有开关, '属性面板里有「等比缩放」开关');

  // ---------- 选中框必须贴合内容（v2.25.0，用户报的"边框偏大号"）
  console.log('\n=== 选中框贴合内容 ===');
  const sb = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = {};
    // 关键：**内容用的是 uniformMatrix，框也必须用同一个**。
    // stretch 模式下 deviceMatrix 是每轴独立的，两者差一个拉伸倍数。
    const cases = [
      { tag: "正方表 200x200", w: 200, h: 200 },
      { tag: "长方形表 240x120", w: 240, h: 120 },
      { tag: "竖长表 120x240", w: 120, h: 240 },
    ];
    out.用例 = [];
    cases.forEach(c => {
      const n = window.createNode(window.NODE_GAUGE, { name: c.tag, pid: "obd.rpm", style: 0, min: 0, max: 8000, x: 60, y: 60, w: c.w, h: c.h });
      S.design.nodes = [n];
      const raw = window.deviceMatrix(S.design.nodes, n.id);
      const uni = window.uniformMatrix(raw, n.w, n.h);
      const sel = window.selectionMatrix(n, raw);
      // 框用的矩阵必须 = 内容矩阵
      const same = Math.abs(sel.a - uni.a) < 1e-6 && Math.abs(sel.d - uni.d) < 1e-6 &&
                   Math.abs(sel.e - uni.e) < 1e-6 && Math.abs(sel.f - uni.f) < 1e-6;
      // 手柄位置也要基于同一个矩阵
      const hp = window.handlePositionsFor(n.id);
      const hpSame = Math.abs(hp.real.a - uni.a) < 1e-6 && Math.abs(hp.real.d - uni.d) < 1e-6;
      // 框的宽（设备像素）应当 = uniform 盒宽，而不是 raw 盒宽
      const boxSel = Math.hypot(sel.a, sel.b) * n.w;
      const boxRaw = Math.hypot(raw.a, raw.b) * n.w;
      const boxUni = Math.hypot(uni.a, uni.b) * n.w;
      out.用例.push({
        tag: c.tag,
        框等于内容矩阵: same,
        手柄也用同一矩阵: hpSame,
        框宽: Math.round(boxSel), 等比盒宽: Math.round(boxUni), 原始盒宽: Math.round(boxRaw),
        贴合: Math.abs(boxSel - boxUni) < 1.5,
      });
    });
    // 图片节点例外：图片按盒子拉伸，框就该是原始盒子
    const img = window.createNode(window.NODE_IMAGE, { name: "图", x: 40, y: 40, w: 100, h: 100 });
    S.design.nodes = [img];
    const raw2 = window.deviceMatrix(S.design.nodes, img.id);
    const sel2 = window.selectionMatrix(img, raw2);
    out.图片用原始盒 = Math.abs(sel2.a - raw2.a) < 1e-6 && Math.abs(sel2.d - raw2.d) < 1e-6;
    S.design.nodes = [];
    return JSON.stringify(out);
  })()`);
  const SB = JSON.parse(sb);
  console.log('    · ' + sb);
  SB.用例.forEach(c => {
    ok(c.框等于内容矩阵, c.tag + "：**选中框与内容用同一个矩阵**");
    ok(c.手柄也用同一矩阵, c.tag + "：手柄位置也基于同一矩阵（点得中）");
    ok(c.贴合, c.tag + "：框宽 " + c.框宽 + " = 等比盒 " + c.等比盒宽 + "（原始盒 " + c.原始盒宽 + "）");
  });
  ok(SB.图片用原始盒, '图片节点例外 —— 它按盒子拉伸，框就该是原始盒子');

  await cdp.ws.close();
  } catch (e) { console.log('  ❌ ' + e.message); fail++; }
  finally { proc.kill(); }
  console.log('\nPASS=' + pass + '  FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})();
