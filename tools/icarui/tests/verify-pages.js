// 验证多页面（格式层）：解析 / 序列化 / 切页 API / 向后兼容
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9269;
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
    `--user-data-dir=${os.tmpdir()}\\edge-pg`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
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

    // ---------- 1) 向后兼容：没有 pages 的老文件 ----------
    console.log('\n=== 1. 向后兼容（没有 pages 字段）===');
    const old = await cdp.eval(`(() => {
      const txt = JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 },
        nodes: [{ id:'g1', type:'gauge', pid:'obd.rpm', style:0, min:0, max:8000, x:0,y:0,w:180,h:180 }]
      });
      const r = window.parseDesign(txt);
      const d = r.design;
      return JSON.stringify({
        errors: r.errors.length,
        pages: d ? d.pages.length : -1,
        页名: d ? d.pages[0].name : null,
        pageIndex: d ? d.pageIndex : -1,
        nodes是同一引用: d ? (d.nodes === d.pages[0].nodes) : false,
        节点数: d ? window.flatten(d.nodes).length : -1,
      });
    })()`);
    const O = JSON.parse(old);
    console.log('    · ' + old);
    eq(O.errors, 0, '老文件（只有 nodes）解析 0 错误');
    eq(O.pages, 1, '自动兜成 1 页');
    eq(O.pageIndex, 0, '默认第 0 页');
    ok(O.nodes是同一引用, '**design.nodes 与 pages[0].nodes 是同一个引用**（这是"不用改几千处代码"的关键）');
    eq(O.节点数, 1, '节点照常读到');

    // ---------- 2) 解析多页文件 ----------
    console.log('\n=== 2. 解析多页文件 ===');
    const multi = await cdp.eval(`(() => {
      const txt = JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 },
        pages: [
          { id:'p1', name:'主页面', nodes:[{ id:'a', type:'text', text:'主', x:0,y:0,w:50,h:30 }] },
          { id:'p2', name:'性能页', nodes:[
            { id:'b', type:'text', text:'性', x:0,y:0,w:50,h:30 },
            { id:'c', type:'text', text:'能', x:60,y:0,w:50,h:30 }
          ]}
        ]
      });
      const r = window.parseDesign(txt);
      const d = r.design;
      return JSON.stringify({
        errors: r.errors.length,
        错误内容: r.errors,
        pages: d ? d.pages.map(p => p.name + ':' + p.nodes.length).join(' | ') : null,
        当前页节点: d ? d.nodes.map(n => n.text).join('') : null,
      });
    })()`);
    const M = JSON.parse(multi);
    console.log('    · ' + multi);
    eq(M.errors, 0, '多页文件解析 0 错误');
    eq(M.pages, '主页面:1 | 性能页:2', '两页都解析出来了（各自的节点数正确）');
    eq(M.当前页节点, '主', '默认停在第 0 页');

    // ---------- 3) 切页 ----------
    console.log('\n=== 3. 切页（design.nodes 换引用）===');
    const sw = await cdp.eval(`(() => {
      const txt = JSON.stringify({
        schema: 'icar.ui/2', canvas: { unit: 360 },
        pages: [
          { id:'p1', name:'A页', nodes:[{ id:'a', type:'text', text:'甲', x:0,y:0,w:50,h:30 }] },
          { id:'p2', name:'B页', nodes:[{ id:'b', type:'text', text:'乙', x:0,y:0,w:50,h:30 }] }
        ]
      });
      const S = window.CanvasState;
      const d = window.parseDesign(txt).design;
      S.design = d;
      const out = {};
      out.切前 = d.nodes.map(n => n.text).join('');
      out.切前索引 = d.pageIndex;
      out.切了 = window.switchPage(d, 1);
      out.切后 = d.nodes.map(n => n.text).join('');
      out.切后索引 = d.pageIndex;
      out.引用正确 = (d.nodes === d.pages[1].nodes);
      // 在第 2 页加个节点，切回第 1 页不应该看到
      d.nodes.push(window.createNode(window.NODE_TEXT, { name:'新', text:'丙', x:0,y:0,w:50,h:30 }));
      window.switchPage(d, 0);
      out.回第1页 = d.nodes.map(n => n.text).join('');
      out.第2页仍有3个 = d.pages[1].nodes.length;
      // 越界切页
      out.越界 = window.switchPage(d, 99);
      out.越界后索引 = d.pageIndex;
      return JSON.stringify(out);
    })()`);
    const SW = JSON.parse(sw);
    console.log('    · ' + sw);
    eq(SW.切前, '甲', '第 1 页是「甲」');
    eq(SW.切了, true, '切页成功');
    eq(SW.切后, '乙', '第 2 页是「乙」');
    eq(SW.切后索引, 1, '索引跟着变');
    ok(SW.引用正确, 'design.nodes 换成了目标页的数组');
    eq(SW.回第1页, '甲', '切回第 1 页只看到「甲」');
    eq(SW.第2页仍有3个, 2, '在第 2 页加的节点留在第 2 页（不会串页）');
    eq(SW.越界后索引, 1, '越界切页被夹到最后一页');

    // ---------- 4) 增删页 ----------
    console.log('\n=== 4. 增页 / 删页 ===');
    const ap = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const d = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        pages:[{ id:'p1', name:'唯一页', nodes:[{id:'a',type:'text',text:'甲',x:0,y:0,w:50,h:30}] }]
      })).design;
      S.design = d;
      const out = {};
      out.初始页数 = d.pages.length;
      out.删最后一页 = window.removePage(d, 0);
      out.删后页数 = d.pages.length;
      const idx = window.addPage(d, '新页');
      out.加后索引 = idx;
      out.加后页数 = d.pages.length;
      out.新页名 = d.pages[idx].name;
      out.新页是空的 = d.pages[idx].nodes.length === 0;
      out.删掉新页 = window.removePage(d, idx);
      out.最终页数 = d.pages.length;
      return JSON.stringify(out);
    })()`);
    const AP = JSON.parse(ap);
    console.log('    · ' + ap);
    eq(AP.初始页数, 1, '初始 1 页');
    eq(AP.删最后一页, false, '**最后一页不能删**（没有页面的设计没法编辑）');
    eq(AP.删后页数, 1, '页数没变');
    eq(AP.加后索引, 1, '加页返回新索引');
    eq(AP.加后页数, 2, '页数变成 2');
    eq(AP.新页名, '新页', '页名生效');
    ok(AP.新页是空的, '新页是空的');
    eq(AP.最终页数, 1, '删掉后回到 1 页');

    // ---------- 5) 序列化往返 ----------
    console.log('\n=== 5. 多页往返（这是最容易丢数据的地方）===');
    const rt = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const d = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        pages:[
          { id:'p1', name:'甲页', nodes:[{id:'a',type:'text',text:'甲',x:0,y:0,w:50,h:30}] },
          { id:'p2', name:'乙页', nodes:[{id:'b',type:'text',text:'乙',x:0,y:0,w:50,h:30},
                                        {id:'c',type:'text',text:'丙',x:0,y:40,w:50,h:30}] }
        ]
      })).design;
      S.design = d;
      // 停在**第 2 页**再序列化 —— 最容易丢的正是"非当前页"
      window.switchPage(d, 1);
      const json = window.toV2Json(d);
      const j = JSON.parse(json);
      const back = window.parseDesign(json);
      return JSON.stringify({
        文件里有pages: !!j.pages,
        文件页数: j.pages ? j.pages.length : -1,
        文件各页节点: j.pages ? j.pages.map(p => p.name + ':' + p.nodes.length).join(' | ') : null,
        往返错误: back.errors.length,
        往返页数: back.design ? back.design.pages.length : -1,
        往返各页: back.design ? back.design.pages.map(p => p.name + ':' + p.nodes.length).join(' | ') : null,
      });
    })()`);
    const RT = JSON.parse(rt);
    console.log('    · ' + rt);
    ok(RT.文件里有pages, '序列化写出了 pages');
    eq(RT.文件页数, 2, '文件里有 2 页');
    eq(RT.文件各页节点, '甲页:1 | 乙页:2', '**每一页各自的节点数都对**（非当前页没丢）');
    eq(RT.往返错误, 0, '往返 0 错误');
    eq(RT.往返各页, '甲页:1 | 乙页:2', '往返后两页都完整');


    // ---------- 6) 页签 UI ----------
    console.log('\n=== 6. 页签 UI ===');
    const tabs = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const d = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        pages:[
          { id:'p1', name:'主页面', nodes:[{id:'a',type:'text',text:'甲',x:0,y:0,w:50,h:30}] },
          { id:'p2', name:'性能页', nodes:[{id:'b',type:'text',text:'乙',x:0,y:0,w:50,h:30}] }
        ]
      })).design;
      S.design = d;
      window.refreshAll();
      const box = document.getElementById('pageTabs');
      const out = {};
      out.存在 = !!box;
      out.页签数 = box.querySelectorAll('.pgTab').length;
      out.页名 = Array.from(box.querySelectorAll('.pgTab')).map(e => e.textContent.replace('✕','').trim());
      out.当前高亮 = (box.querySelector('.pgCur')||{}).textContent.replace('✕','').trim();
      out.有加号 = !!box.querySelector('.pgAdd');
      out.每页有删除 = box.querySelectorAll('.pgDel').length;
      out.提示文字 = (box.querySelector('.pgHint')||{}).textContent || '';
      // 切到第 2 页
      window.switchToPage(1);
      window.refreshAll();
      out.切后高亮 = (box.querySelector('.pgCur')||{}).textContent.replace('✕','').trim();
      out.切后节点 = window.flatten(S.design.nodes).map(n => n.text).join('');
      out.切后选择被清 = S.selection.length === 0;
      // 单页时不该有删除按钮
      const d1 = window.parseDesign(JSON.stringify({
        schema:'icar.ui/2', canvas:{unit:360},
        pages:[{ id:'p1', name:'唯一页', nodes:[{id:'a',type:'text',text:'甲',x:0,y:0,w:50,h:30}] }]
      })).design;
      S.design = d1; window.refreshAll();
      out.单页页签数 = box.querySelectorAll('.pgTab').length;
      out.单页删除按钮 = box.querySelectorAll('.pgDel').length;
      out.单页有加号 = !!box.querySelector('.pgAdd');
      return JSON.stringify(out);
    })()`);
    const TB = JSON.parse(tabs);
    console.log('    · ' + tabs);
    ok(TB.存在, '页签条渲染了');
    eq(TB.页签数, 2, '两个页签');
    eq(TB.页名.join('/'), '主页面/性能页', '页名正确');
    eq(TB.当前高亮, '主页面', '当前页高亮');
    ok(TB.有加号, '有「＋」新建按钮');
    eq(TB.每页有删除, 2, '多页时每页都有删除按钮');
    ok(TB.提示文字.indexOf('2 页') >= 0, '提示文字显示页数：' + TB.提示文字);
    eq(TB.切后高亮, '性能页', '切页后高亮跟着变');
    eq(TB.切后节点, '乙', '切页后画布上的节点确实换了');
    ok(TB.切后选择被清, '切页会清空选择（旧页的 id 带到新页会指向不存在的东西）');
    eq(TB.单页页签数, 1, '单页时只有一个页签');
    eq(TB.单页删除按钮, 0, '**单页时不显示删除按钮**（删不了，显示只会误导）');
    ok(TB.单页有加号, '单页时仍显示「＋」（否则用户发现不了能加页）');

    // ================================================================ 新建页面 = 一步撤销
    //
    // ⚠️ 这条是 v2.83.0（Round 1）加的回归。
    //
    // `addNewPage` 底下有**两次** commit（加页 + 切页）。不合批的话撤销栈里
    // 会多出一条中间态：用户按一次撤销，**新页面还在**（只把当前页切了回去），
    // 看起来就是"撤销没反应"，得按两次才退干净。
    //
    // 判据不是"撤销栈长度"（那是实现细节），而是**用户看到的东西**：
    // 按一次撤销，设计必须回到按之前的样子。
    console.log('\n=== 新建页面只占一步撤销 ===');
    const undoPage = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const snap = () => JSON.stringify({ d: S.design, sel: S.selection });
      const before = snap();
      const beforePages = (S.design.pages || []).length;
      window.addNewPage();                       // prompt 已被 stub 成返回 "P"
      const afterPages = (S.design.pages || []).length;
      const after = snap();
      const changed = after !== before;
      window.doUndo();
      const u = snap();
      const pagesAfterUndo = (S.design.pages || []).length;
      window.doRedo();
      const r = snap();
      return JSON.stringify({
        beforePages: beforePages, afterPages: afterPages,
        changed: changed,
        undoRestored: u === before,
        pagesAfterUndo: pagesAfterUndo,
        redoRestored: r === after,
        indexAfterUndo: S.design.pageIndex,
      });
    })()`);
    console.log('    · ' + undoPage);
    const UP = JSON.parse(undoPage);
    ok(UP.changed, `新建页面确实改了设计（页数 ${UP.beforePages} → ${UP.afterPages}）`);
    eq(UP.afterPages, UP.beforePages + 1, '新建后页数 +1');
    ok(UP.undoRestored, '**按一次撤销就回到新建之前**（不是"页面还在、只切回了当前页"）');
    eq(UP.pagesAfterUndo, UP.beforePages, '撤销后页数也回去了');
    ok(UP.redoRestored, '重做能再回到新建之后');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
