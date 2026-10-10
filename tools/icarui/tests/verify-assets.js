// 验证：素材库新排版 + 生成的示例素材
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9260;
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
    `--user-data-dir=${os.tmpdir()}\\edge-assets`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
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
    errs.slice(0, 6).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 清单加载 ----------
    console.log('\n=== 1. 内置素材清单 ===');
    const mf = await cdp.eval(`JSON.stringify({
      n: (window.BUILTIN_ASSETS||[]).length,
      kinds: [...new Set((window.BUILTIN_ASSETS||[]).map(a=>a.kind))].sort(),
      sample: (window.BUILTIN_ASSETS||[]).slice(0,3).map(a=>a.path),
      allHaveWH: (window.BUILTIN_ASSETS||[]).every(a=>a.w>0&&a.h>0),
    })`);
    const M = JSON.parse(mf);
    console.log('    · ' + M.n + ' 个，分类：' + M.kinds.join('/'));
    // v2.20.0 大扩充：95 → 288。写下限而不是等号 ——
// 以后再加素材不该让测试失败，但**大幅减少**必须被发现。
ok(M.n >= 280, `内置素材 ≥280 个（实际 ${M.n}）`);
    ok(M.allHaveWH, '每个都带 w/h（工具要用它算默认尺寸）');
    ok(M.kinds.length >= 11, `${M.kinds.length} 个分类有素材`);

    // 折叠状态是持久的（localStorage），上一次跑会影响基线。用 API 拿确定性初始状态。
    await cdp.eval("window.resetPanelLayout();");

    // ---------- 2) 排版结构 ----------
    console.log('\n=== 2. 素材库排版 ===');
    const layout = await cdp.eval(`(() => {
      const box = document.getElementById('assets');
      return JSON.stringify({
        hasSearch: !!document.getElementById('assetSearch'),
        sections: Array.from(box.querySelectorAll('.asection')).map(e=>e.textContent.trim()),
        folders: Array.from(box.querySelectorAll('.akind')).map(e => ({
          name: (e.querySelector('.akname')||{}).textContent || '',
          open: !!e.querySelector('.akitems'),
          count: (e.querySelector('.treeCount')||{}).textContent || '',
        })),
        assetGrids: box.querySelectorAll('.assetGrid').length,
        ctrlGrids: box.querySelectorAll('.ctrlGrid').length,
        thumbs: box.querySelectorAll('.assetThumb').length,
        chips: box.querySelectorAll('.ctrlChip').length,
      });
    })()`);
    const L = JSON.parse(layout);
    console.log('    · 区块: ' + L.sections.join(' / '));
    console.log('    · 缩略图 ' + L.thumbs + ' 个，控件芯片 ' + L.chips + ' 个');
    const openNames = L.folders.filter(f => f.open).map(f => f.name.trim());
    const shutNames = L.folders.filter(f => !f.open).map(f => f.name.trim());
    console.log('    · 展开: ' + openNames.join(' / '));
    console.log('    · 收起: ' + shutNames.join(' / '));
    ok(L.hasSearch, '有搜索框');
    eq(L.sections.length, 2, '两个大区块（控件库 / 素材）');
    ok(L.assetGrids >= 1, '素材用网格排（不是一行一个）');
    ok(L.ctrlGrids >= 1, '控件用网格排');
    ok(L.thumbs >= 90, `缩略图数量 ${L.thumbs}（≥90）`);
    ok(L.chips >= 40, `控件芯片 ${L.chips} 个（≥40）`);

    // ---------- 3) 空分类默认收起 ----------
    console.log('\n=== 3. 空分类自动收起（用户抱怨的"乱"主要在这）===');
    const emptyShut = await cdp.eval(`(() => {
      const box = document.getElementById('assets');
      const out = [];
      box.querySelectorAll('.akind').forEach(e => {
        const name = (e.querySelector('.akname')||{}).textContent||'';
        const cnt = parseInt((e.querySelector('.treeCount')||{}).textContent||'0',10);
        const open = !!e.querySelector('.akitems');
        out.push({name:name.trim(), cnt:cnt, open:open});
      });
      return JSON.stringify(out);
    })()`);
    const ES = JSON.parse(emptyShut);
    const badEmpty = ES.filter(f => f.cnt === 0 && f.open);
    const badFull = ES.filter(f => f.cnt > 0 && !f.open);
    badEmpty.forEach(f => console.log('    ⚠️ 空但展开: ' + f.name));
    badFull.forEach(f => console.log('    ⚠️ 有内容却收起: ' + f.name));
    ok(badEmpty.length === 0, '空分类全部收起');
    ok(badFull.length === 0, '有内容的分类全部展开');

    // ---------- 4) 缩略图真的能显示 ----------
    console.log('\n=== 4. 缩略图真的加载出来了 ===');
    const imgs = await cdp.eval(`(() => {
      // 先展开全部分类 —— 折叠的分类**不渲染**缩略图（这是有意的，省内存）
      window.assetsExpandAll(true);
      const list = Array.from(document.querySelectorAll('#assets .assetThumb img'));
      return JSON.stringify({
        total: list.length,
        loaded: list.filter(i => i.complete && i.naturalWidth > 0).length,
        broken: list.filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
      });
    })()`);
    const IM = JSON.parse(imgs);
    console.log('    · ' + IM.loaded + ' / ' + IM.total + ' 张加载成功');
    if (IM.broken.length) console.log('    · 坏的: ' + IM.broken.slice(0, 4).join(', '));
    ok(IM.broken.length === 0, '没有加载失败的图');
    // ⚠️ **不能要求全部 95 张都 loaded** —— 缩略图带 loading="lazy"，
    // 视口外的图浏览器**故意不加载**（这是对的，省内存）。
    // 真正该钉的是「没有坏图」+「视口内的确实加载了」。
    // v2.22.0：控件库从 40 涨到 78 个（8 个分组标题），把素材网格往下推了。
    // 视口内的缩略图从二十几张变成 8 张。这不是回归，是布局变了。
    // 守的东西不变：视口内的确实加载了，而且没有破图。
    ok(IM.loaded >= 5, `视口内的缩略图都加载了（${IM.loaded}/${IM.total}）`);
    ok(IM.broken.length === 0, '没有任何缩略图加载失败');

    // ---------- 5) 搜索过滤 ----------
    console.log('\n=== 5. 搜索 ===');
    const search = await cdp.eval(`(() => {
      const box = document.getElementById('assets');
      const before = box.querySelectorAll('.assetThumb').length;
      window.setAssetQuery('灯');
      const afterLight = box.querySelectorAll('.assetThumb').length;
      const openAfter = box.querySelectorAll('.akitems').length;
      window.setAssetQuery('圆表');
      const afterGauge = box.querySelectorAll('.ctrlChip').length;
      window.setAssetQuery('zzz-不存在');
      const afterNone = box.querySelectorAll('.assetThumb').length + box.querySelectorAll('.ctrlChip').length;
      const noneMsg = !!box.querySelector('.akempty');
      window.setAssetQuery('');
      const restored = box.querySelectorAll('.assetThumb').length;
      return JSON.stringify({before, afterLight, openAfter, afterGauge, afterNone, noneMsg, restored});
    })()`);
    const SE = JSON.parse(search);
    console.log('    · ' + search);
    ok(SE.afterLight < SE.before && SE.afterLight > 0, `搜「灯」过滤到 ${SE.afterLight} 个（原来 ${SE.before}）`);
    ok(SE.openAfter >= 1, '搜索时自动展开命中的分类');
    // 「圆表」现在也匹配到「拼装圆表」—— 搜索是**包含匹配**，这是对的
    ok(SE.afterGauge >= 1, `搜「圆表」命中 ${SE.afterGauge} 个`);
    eq(SE.afterNone, 0, '搜不到东西时结果为空');
    ok(SE.noneMsg, '搜不到时给出提示');
    eq(SE.restored, SE.before, '清空搜索后恢复');

    // ---------- 6) 点内置素材 → 加入设计 + 放上画布 ----------
    console.log('\n=== 6. 用内置素材 ===');
    const use = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const beforeNodes = window.flatten(S.design.nodes).length;
      const beforeAssets = (S.design.assets||[]).length;
      const path = (window.BUILTIN_ASSETS||[]).find(a=>a.kind==='warning').path;
      window.useBuiltinAsset(path);
      const afterNodes = window.flatten(S.design.nodes).length;
      const afterAssets = (S.design.assets||[]).length;
      const img = window.flatten(S.design.nodes).filter(n=>n.type==='image').pop();
      // 再用一次，应该复用已有素材而不是重复登记
      window.useBuiltinAsset(path);
      const assets2 = (S.design.assets||[]).length;
      return JSON.stringify({
        beforeNodes, afterNodes, beforeAssets, afterAssets, assets2,
        imgAssetId: img ? img.assetId : null,
        imgW: img ? img.w : null, imgH: img ? img.h : null,
        usedBadge: document.querySelectorAll('#assets .assetThumb.used').length,
      });
    })()`);
    const U = JSON.parse(use);
    console.log('    · ' + use);
    eq(U.afterAssets, U.beforeAssets + 1, '素材登记进了设计的 assets[]');
    eq(U.afterNodes, U.beforeNodes + 1, '画布上多了一个图片节点');
    ok(U.imgAssetId, '图片节点指向该素材');
    ok(U.imgW > 0 && U.imgH > 0, `默认尺寸取自素材 w/h（${U.imgW}×${U.imgH}）`);
    eq(U.assets2, U.afterAssets, '第二次使用**不重复登记**');
    ok(U.usedBadge >= 1, '已用的素材有「已用」标记');

    // ---------- 7) 折叠/展开全部 ----------
    console.log('\n=== 7. 折叠 / 展开全部 ===');
    const fold = await cdp.eval(`(() => {
      const box = document.getElementById('assets');
      window.assetsExpandAll(false);
      const afterFold = box.querySelectorAll('.akitems').length;
      window.assetsExpandAll(true);
      const afterExpand = box.querySelectorAll('.akitems').length;
      const total = box.querySelectorAll('.akind').length;
      // 展开全部**会跳过空分类**（展开空文件夹只显示「（空）」，没用）
      const empty = Array.from(box.querySelectorAll('.akind')).filter(e =>
        parseInt((e.querySelector('.treeCount')||{}).textContent||'0',10) === 0).length;
      return JSON.stringify({afterFold, afterExpand, total, empty});
    })()`);
    const F = JSON.parse(fold);
    console.log('    · ' + fold);
    eq(F.afterFold, 0, '折叠全部 → 一个都不展开');
    // 展开全部**会跳过空分类** —— 展开空文件夹只显示一片「（空）」，没用
    eq(F.afterExpand, F.total - F.empty, `展开全部 → 展开 ${F.afterExpand} 个，跳过 ${F.empty} 个空的`);
    ok(F.empty > 0, `确实存在空分类（${F.empty} 个），否则这条断言没有意义`);

    // ---------- 8) 生成的素材在 App 侧也能读（文件真的是 PNG） ----------
    console.log('\n=== 8. 素材文件本身 ===');
    const fs = require('fs');
    const dir = require('path').join(__dirname, '..', "assets");
    let pngCount = 0, dirs = 0;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (!e.isDirectory()) return;
      dirs++;
      fs.readdirSync(dir + '/' + e.name).forEach(f => { if (f.endsWith('.png')) pngCount++; });
    });
    // v2.20.0 从 10 类扩到 12 类（新增「条形轨道」「面板边框」）
eq(dirs, 12, '12 个分类目录');
    ok(pngCount >= 95, `${pngCount} 个 PNG 文件在磁盘上`);
    ok(fs.existsSync(dir + '/builtin.js'), 'builtin.js 清单存在');

  
  // ---------- 宽高比（用户报的"添加进去全都是扁的"）
  console.log('\n=== 添加素材时保持宽高比 ===');
  const ar = await cdp.eval(`(() => {
    const S = window.CanvasState;
    const out = { cases: [] };
    // 各种极端形状：正方 / 宽横条 / 高竖条 / 超宽 / 超高
    const shapes = [
      { w: 256, h: 256, tag: '正方' },
      { w: 256, h: 64,  tag: '宽横条 4:1' },
      { w: 48,  h: 192, tag: '高竖条 1:4' },
      { w: 512, h: 32,  tag: '超宽 16:1' },
      { w: 32,  h: 512, tag: '超高 1:16' },
      { w: 200, h: 100, tag: '2:1' },
    ];
    shapes.forEach(function (s, i) {
      const id = 'test-ar-' + i;
      S.design.assets = (S.design.assets || []).filter(function (a) { return a.id !== id; });
      S.design.assets.push({ id: id, name: s.tag, kind: 'decor', path: 'assets/x.png', w: s.w, h: s.h });
      const n0 = S.design.nodes.length;
      window.addImageNode(id);
      const n = S.design.nodes[S.design.nodes.length - 1];
      out.cases.push({
        tag: s.tag,
        素材比: +(s.w / s.h).toFixed(4),
        节点比: +(n.w / n.h).toFixed(4),
        尺寸: n.w + '×' + n.h,
        加了节点: S.design.nodes.length === n0 + 1,
      });
      S.design.nodes.pop();
    });
    // 没有 w/h 的素材（老文件）不该崩
    S.design.assets.push({ id: 'test-nowh', name: '无尺寸', kind: 'decor', path: 'assets/y.png' });
    try { window.addImageNode('test-nowh'); out.无尺寸没崩 = true; S.design.nodes.pop(); }
    catch (e) { out.无尺寸没崩 = false; out.无尺寸错误 = String(e.message).slice(0, 60); }
    // 清理
    S.design.assets = S.design.assets.filter(function (a) { return a.id.indexOf('test-ar-') !== 0 && a.id !== 'test-nowh'; });
    return JSON.stringify(out);
  })()`);
  const AR = JSON.parse(ar);
  console.log('    · ' + ar);
  AR.cases.forEach(function (c) {
    // 允许 1 位小数的舍入误差（尺寸是整数像素）
    const diff = Math.abs(c.素材比 - c.节点比) / c.素材比;
    ok(diff < 0.06,
      c.tag + '：素材 ' + c.素材比 + ' vs 节点 ' + c.节点比 + '（' + c.尺寸 + '）');
  });
  ok(AR.cases.every(function (c) { return c.加了节点; }), '每种形状都真的加进了画布');
  ok(AR.无尺寸没崩, '没有 w/h 的素材不崩' + (AR.无尺寸错误 ? '：' + AR.无尺寸错误 : ''));

  // ---------- 悬停大图（v2.24.0）
  console.log('\n=== 素材悬停大图 ===');
  const hov = await cdp.eval(`(() => {
    const out = {};
    const box = document.getElementById("assetPreview");
    out.浮层存在 = !!box;
    if (!box) return JSON.stringify(out);
    out.初始隐藏 = !box.classList.contains("on");
    const th = document.querySelector("#assetsBody .assetThumb");
    out.有缩略图 = !!th;
    if (!th) return JSON.stringify(out);
    out.挂了hover = !!th.getAttribute("onmouseenter");
    // 手动触发（headless 下 hover 事件不可靠）
    th.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    out.显示后on = box.classList.contains("on");
    out.有图 = !!box.querySelector("img");
    out.有名字 = (box.querySelector(".apName") || {}).textContent || "";
    const r = box.getBoundingClientRect();
    out.在视口内 = r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
    out.位置 = Math.round(r.left) + "," + Math.round(r.top);
    // 右边放不下时应当翻到左侧
    const last = document.querySelectorAll("#assetsBody .assetThumb");
    const rightMost = last[last.length - 1];
    window.showAssetPreview(rightMost, "assets/scale/digit-8.png", "边界测试");
    const r2 = box.getBoundingClientRect();
    out.边界也在视口内 = r2.left >= 0 && r2.right <= innerWidth + 1 && r2.bottom <= innerHeight + 1;
    window.hideAssetPreview();
    out.隐藏后off = !box.classList.contains("on");
    return JSON.stringify(out);
  })()`);
  const HV = JSON.parse(hov);
  console.log('    · ' + hov);
  ok(HV.浮层存在, '有悬停浮层 #assetPreview');
  ok(HV.初始隐藏, '初始是隐藏的');
  ok(HV.挂了hover, '缩略图挂了 mouseenter');
  ok(HV.显示后on, '悬停后浮层显示');
  ok(HV.有图, '浮层里有图');
  ok((HV.有名字 || '').length > 0, '浮层显示素材名：' + HV.有名字);
  ok(HV.在视口内, '浮层在视口内（' + HV.位置 + '）');
  ok(HV.边界也在视口内, '**靠右边的素材浮层会翻到左侧**，不弹出屏幕');
  ok(HV.隐藏后off, '移开后浮层隐藏');

  await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
