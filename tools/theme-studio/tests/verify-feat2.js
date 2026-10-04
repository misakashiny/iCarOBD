// 验证本批新功能：平铺 / 控件库 / 控件编辑器 / 素材库文件夹
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9256;
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
    `--user-data-dir=${os.tmpdir()}\\edge-feat2`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    await cdp.eval(`window.confirm = () => true; window.alert = () => {}; window.prompt = (m,d) => '我的控件';`);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 0. JS 错误 ===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ---------- 1) 素材库文件夹已生成 ----------
    console.log('\n=== 1. 素材库文件夹（磁盘上真的存在）===');
    const kinds = ['background','dashboard','needle','scale','icon','turn','warning','brand','decor','custom'];
    const dir = require('path').join(__dirname, '..', "assets");
    let found = 0;
    kinds.forEach(k => { if (fs.existsSync(dir + '/' + k + '/README.md')) found++; });
    eq(found, 10, '10 个分类目录都在（各带 README）');
    ok(fs.existsSync(dir + '/needle/README.md'), 'needle/README.md 存在');

    // 折叠状态持久在 localStorage 里 —— 上次跑（尤其"展开全部"）会影响这次的基线，
    // 导致「自定义控件」是收起状态、里面的条目根本没渲染出来。先重置。
    await cdp.eval("window.resetPanelLayout();");

    // ---------- 2) 控件库 ----------
    console.log('\n=== 2. 素材库里的「控件」区 ===');
    const lib = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const items = Array.from(document.querySelectorAll('#assets .ctrlChip')).map(e => e.textContent.trim());
      return JSON.stringify({
        内置控件数: window.BUILTIN_CONTROLS.length,
        内置名字: window.BUILTIN_CONTROLS.map(c => c.name),
        库里的条目: items,
        自定义控件数: (S.design.controls || []).length,
      });
    })()`);
    const LB = JSON.parse(lib);
    console.log('    · 内置控件 ' + LB.内置控件数 + ' 个: ' + LB.内置名字.join(' / '));
    console.log('    · 素材库条目 ' + LB.库里的条目.length + ' 个');
    // 控件库大幅扩充过：8 种样式 + 常用 PID 仪表 + 4 种文字 + 12 种图片
    // + 3 种警告灯 + 2 种拼装表 + 分组 + 图片控件
    ok(LB.内置控件数 >= 40, `内置控件 ≥40 个（实际 ${LB.内置控件数}）`);
    ok(LB.内置名字.indexOf('圆表') >= 0, '含「圆表」');
    ok(LB.内置名字.indexOf('数字') >= 0, '含「数字」');
    ok(LB.内置名字.indexOf('线型图') >= 0, '含「线型图」');
    ok(LB.内置名字.indexOf('G力值') >= 0, '含「G力值」');
    ok(LB.库里的条目.length >= 40, `素材库里能看到这些控件（${LB.库里的条目.length}）`);

    // ---------- 3) 点控件 → 打开编辑器 ----------
    console.log('\n=== 3. 单击控件 → 打开控件编辑器 ===');
    const ed = await cdp.eval(`(() => {
      const S = window.CanvasState;
      window.editBuiltinControl('gauge_0');
      const m = document.getElementById('ctrlEditor');
      const cv = document.getElementById('cePreview');
      // 预览画布上有没有画出东西（非纯背景）
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const bg = cv.getContext('2d').getImageData(2, 2, 1, 1).data;
      let nonBg = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i]-bg[0]) + Math.abs(d[i+1]-bg[1]) + Math.abs(d[i+2]-bg[2]) > 20) nonBg++;
      }
      return JSON.stringify({
        打开了: m.classList.contains('show'),
        标题: document.getElementById('ceTitle').textContent,
        类型: document.getElementById('ceType').textContent,
        预览非背景像素: nonBg,
        属性组: Array.from(document.querySelectorAll('#ceProps .phead')).map(e => e.textContent.replace(/[▾▸]/g,'').trim()),
        按钮: Array.from(document.querySelectorAll('#ctrlEditor .modalFoot button')).map(e => e.textContent.trim()),
      });
    })()`);
    const ED = JSON.parse(ed);
    console.log('    · 标题: ' + ED.标题 + ' / 类型: ' + ED.类型);
    console.log('    · 属性组: ' + ED.属性组.join(' · '));
    console.log('    · 按钮: ' + ED.按钮.join(' / '));
    ok(ED.打开了, '编辑器打开');
    eq(ED.标题, '新建控件', '从控件库进来是「新建控件」模式');
    ok(ED.预览非背景像素 > 300, `预览真的画出来了（${ED.预览非背景像素} 个非背景像素）`);
    ok(ED.属性组.indexOf('数据') >= 0, '仪表有「数据」组');
    ok(ED.属性组.indexOf('外观') >= 0, '仪表有「外观」组');
    ok(ED.属性组.indexOf('变换') >= 0, '有通用「变换」组');
    ok(ED.属性组.indexOf('图层') >= 0, '有通用「图层」组');
    ok(ED.按钮.some(b => /保存到素材库/.test(b)), '有「保存到素材库」');
    ok(ED.按钮.some(b => /导出 JSON/.test(b)), '有「导出 JSON」');

    // ---------- 4) 编辑器里改属性 → 预览跟着变 ----------
    console.log('\n=== 4. 编辑器里改属性，预览实时更新 ===');
    const live = await cdp.eval(`(() => {
      const cv = document.getElementById('cePreview');
      const grab = () => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0; for (let i = 0; i < d.length; i += 331) h = (h*31 + d[i]) % 2147483647;
        return h;
      };
      const before = grab();
      window.ceSetNum('w', 260);          // 改尺寸
      const afterSize = grab();
      window.ceSetPid('obd.coolant');     // 换 PID（会改量程与标签）
      const afterPid = grab();
      window.ceSetNum('alpha', 100);      // 改透明度
      const afterAlpha = grab();
      return JSON.stringify({ before, afterSize, afterPid, afterAlpha,
        尺寸变了: before !== afterSize, PID变了: afterSize !== afterPid, 透明度变了: afterPid !== afterAlpha,
        草稿pid: window.CanvasState && null });
    })()`);
    const LV = JSON.parse(live);
    console.log('    · ' + live);
    ok(LV.尺寸变了, '改尺寸 → 预览变了');
    ok(LV.PID变了, '换 PID → 预览变了');
    ok(LV.透明度变了, '改透明度 → 预览变了');

    // ---------- 5) 应用 → 进画布 ----------
    console.log('\n=== 5. 应用 → 控件进画布 ===');
    const applied = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const before = window.flatten(S.design.nodes).length;
      window.applyControlEdit();
      const after = window.flatten(S.design.nodes).length;
      const m = document.getElementById('ctrlEditor');
      const sel = S.selection.length ? window.findNode(S.design.nodes, S.selection[0]) : null;
      return JSON.stringify({
        before: before, after: after, 关闭了: !m.classList.contains('show'),
        新控件名: sel ? sel.name : null, 新控件pid: sel ? sel.pid : null,
        新控件宽: sel ? sel.w : null, 新控件透明度: sel ? sel.alpha : null,
        撤销计数: document.getElementById('undoCount').textContent,
      });
    })()`);
    const AP = JSON.parse(applied);
    console.log('    · ' + applied);
    eq(AP.after, AP.before + 1, '画布多了一个控件');
    ok(AP.关闭了, '编辑器自动关闭');
    eq(AP.新控件pid, 'std_05', '用的是编辑器里改过的 PID');
    eq(AP.新控件宽, 260, '用的是编辑器里改过的尺寸');
    eq(AP.新控件透明度, 100, '用的是编辑器里改过的透明度');

    // ---------- 6) 保存到素材库 ----------
    console.log('\n=== 6. 保存到素材库 ===');
    const saved = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.findNode(S.design.nodes, S.selection[0]);
      S.selection = [n.id];
      window.onSelectionChanged();
      window.openControlEditor(n.id);
      const isEdit = document.getElementById('ceTitle').textContent;
      window.saveControlToLibrary();
      const list = (S.design.controls || []);
      // 保存之后"自定义控件"才有内容；显式展开一次，让这条断言只测
      // "保存的控件出现在素材库里"，而不是"空分类会不会自动展开"（另一回事）
      window.assetsExpandAll(true);
      window.assetsExpandAll(false);
      window.assetsExpandAll(true);
      const json = JSON.parse(window.toV2Json(S.design));
      return JSON.stringify({
        编辑器标题: isEdit,
        自定义控件数: list.length,
        名字: list.length ? list[0].name : null,
        模板里有子树字段: list.length ? ('children' in list[0].node) : false,
        JSON里有controls: !!json.controls,
        JSON里controls数: json.controls ? json.controls.length : 0,
        库里的条目: Array.from(document.querySelectorAll('#assets .ctrlChip')).map(e => e.textContent.trim()).filter(x => x.indexOf('★') >= 0).length,
      });
    })()`);
    const SV = JSON.parse(saved);
    console.log('    · ' + saved);
    eq(SV.编辑器标题, '编辑控件', '从画布右键进来是「编辑控件」模式');
    eq(SV.自定义控件数, 1, '保存了 1 个自定义控件');
    ok(SV.JSON里有controls, 'controls 写进了设计文件');
    ok(SV.库里的条目 >= 1, '素材库的「自定义控件」里能看到它');

    // ---------- 7) 保存的控件能重新实例化 + 往返 ----------
    console.log('\n=== 7. 自定义控件能复用、能往返 ===');
    const reuse = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const c = S.design.controls[0];
      const before = window.flatten(S.design.nodes).length;
      const n = window.instantiateControl(c.node, { x: 10, y: 10 });
      S.design.nodes.push(n);
      const after = window.flatten(S.design.nodes).length;
      // 往返
      const txt = window.toV2Json(S.design);
      const r = window.parseDesign(txt);
      return JSON.stringify({
        before: before, after: after,
        往返错误: r.errors.length,
        往返controls: r.design ? r.design.controls.length : -1,
        往返模板名: r.design && r.design.controls.length ? r.design.controls[0].name : null,
        新实例id不同: n.id !== c.node.id,
      });
    })()`);
    const RU = JSON.parse(reuse);
    console.log('    · ' + reuse);
    ok(RU.after > RU.before, '能实例化到画布');
    eq(RU.往返错误, 0, '带 controls 的设计文件往返 0 错误');
    eq(RU.往返controls, 1, '往返保留 controls');
    ok(RU.新实例id不同, '实例化会换新 id（不会和模板撞）');

    // ---------- 8) 背景图平铺 ----------
    console.log('\n=== 8. 背景图平铺（tile）===');
    const tile = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const names = window.FIT_NAMES;
      // 造一张小图当背景，看平铺会不会真的铺多块
      const c = document.createElement('canvas'); c.width = 40; c.height = 40;
      const g = c.getContext('2d');
      g.fillStyle = '#FF0000'; g.fillRect(0, 0, 20, 20);
      g.fillStyle = '#00FF00'; g.fillRect(20, 20, 20, 20);
      const img = new Image();
      let loaded = false;
      img.onload = () => { loaded = true; };
      img.src = c.toDataURL();
      S.bgImage = img;
      S.design.background = { path: 'assets/test.png', fit: window.FIT_TILE, w: 0, h: 0 };
      S.showGrid = false;
      // 等图片解码
      return new Promise(res => setTimeout(() => {
        window.draw();
        const cv = document.getElementById('cv');
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let red = 0, green = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] > 180 && d[i+1] < 80 && d[i+2] < 80) red++;
          if (d[i+1] > 180 && d[i] < 80 && d[i+2] < 80) green++;
        }
        S.design.background = null; S.bgImage = null; S.showGrid = true; window.draw();
        res(JSON.stringify({ fitNames: names, 图片已加载: loaded, 红像素: red, 绿像素: green }));
      }, 300));
    })()`);
    const TL = JSON.parse(tile);
    console.log('    · ' + tile);
    eq(TL.fitNames.length, 4, 'FIT_NAMES 有 4 种（含平铺）');
    eq(TL.fitNames[3], '平铺', '第 4 种是「平铺」');
    ok(TL.红像素 > 1000 && TL.绿像素 > 1000, `平铺真的铺了多块（红 ${TL.红像素} / 绿 ${TL.绿像素} 像素）`);

    // ---------- 9) 右键菜单有「编辑控件…」 ----------
    console.log('\n=== 9. 右键菜单含「编辑控件…」 ===');
    const menu = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      S.selection = [n.id];
      window.onSelectionChanged();
      window.showCtxMenu(300, 300);
      const items = Array.from(document.querySelectorAll('#ctxMenu .ctxItem')).map(e => e.textContent.trim());
      window.hideCtxMenu();
      return JSON.stringify(items);
    })()`);
    const MN = JSON.parse(menu);
    console.log('    · ' + MN.slice(0, 5).join(' / '));
    ok(MN.some(x => /编辑控件/.test(x)), '有「编辑控件…」');
    ok(MN.some(x => /F2/.test(x)), '显示快捷键 F2');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
