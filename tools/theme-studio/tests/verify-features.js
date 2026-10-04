// 验证这一批新功能：主题切换 / 面板折叠 / 顶栏文案 / 新建 / 层级徽章 /
// 右键菜单 / 滚轮缩放 / 右下角旋转图标 / 背景尺寸 / 属性面板空态
// 以及**画布非等比矩阵的修复**（用户报告"名字特别大、分辨率不对劲"）
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9232;
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
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { this.w.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
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
    `--user-data-dir=${os.tmpdir()}\\edge-feat`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明
    // ⚠️ confirm/alert 在无头下会**真的阻塞页面**（"新建"会先问一次）。
    // 这不是工具的 bug —— 恰恰证明确认框在工作；测试里 stub 掉即可。
    await cdp.eval(`window.confirm = () => true; window.alert = () => {};`);

    // ---------- 0) 无 JS 错误 ----------
    console.log('\n=== 0. JS 错误 ===');
    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    errs.slice(0, 6).forEach(e => {
      const p = e.params;
      console.log('    ⚠️ ' + String(p.exceptionDetails ? p.exceptionDetails.text + ' :: ' +
        ((p.exceptionDetails.exception || {}).description || '') : p.entry.text).split('\n')[0]);
    });
    ok(errs.length === 0, `无 JS 错误（捕获 ${errs.length} 条）`);

    // ---------- 1) 顶栏文案 + 新按钮 ----------
    console.log('\n=== 1. 顶栏文案与新增按钮 ===');
    const btns = await cdp.eval(`JSON.stringify(
      Array.from(document.querySelectorAll('header button')).map(b => b.textContent.trim()))`);
    const B = JSON.parse(btns);
    console.log('    · ' + B.join(' | '));
    ok(B.includes('新建'), '有「新建」按钮');
    ok(B.includes('保存') && !B.includes('保存 v2'), '「保存 v2」→「保存」');
    ok(B.includes('导出') && !B.includes('导出 v1'), '「导出 v1」→「导出」');
    ok(B.some(x => x.includes('返回')) && !B.some(x => x.includes('重做')), '「重做」→「返回」');
    ok(B.some(x => /暗黑|白色/.test(x)), '有主题切换按钮');
    const redoTip = await cdp.eval(`document.getElementById('btnRedo').title`);
    ok(/重做/.test(redoTip), '「返回」按钮的 tooltip 说明了它其实是重做：' + redoTip);

    // ---------- 2) 主题切换 ----------
    console.log('\n=== 2. 暗黑 / 白色主题切换 ===');
    const th0 = await cdp.eval(`JSON.stringify({
      attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      label: document.getElementById('btnTheme').textContent.trim(),
    })`);
    const T0 = JSON.parse(th0);
    console.log('    · 初始 ' + th0);
    eq(T0.attr, 'dark', '默认是暗黑主题');

    await cdp.eval(`window.toggleTheme()`);
    await sleep(200);
    const T1 = JSON.parse(await cdp.eval(`JSON.stringify({
      attr: document.documentElement.getAttribute('data-theme'),
      bg: getComputedStyle(document.body).backgroundColor,
      label: document.getElementById('btnTheme').textContent.trim(),
      cvOut: getComputedStyle(document.documentElement).getPropertyValue('--cvOut').trim(),
    })`));
    console.log('    · 切换后 ' + JSON.stringify(T1));
    eq(T1.attr, 'light', '切到白色主题');
    ok(T1.bg !== T0.bg, `body 底色真的变了（${T0.bg} → ${T1.bg}）`);
    ok(/白色/.test(T1.label), '按钮文案跟着变：' + T1.label);
    ok(T1.cvOut && T1.cvOut !== '', '画布底色变量 --cvOut 有值：' + T1.cvOut);

    // 画布真的用了新底色？
    const canvasPix = await cdp.eval(`(() => {
      const cv = document.getElementById('cv');
      const d = cv.getContext('2d').getImageData(2, 2, 1, 1).data;
      return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
    })()`);
    console.log('    · 画布左上角像素 ' + canvasPix);
    ok(canvasPix !== 'rgb(2,4,7)', '画布底色已跟随主题（不再是写死的深色）');

    // 持久化
    await cdp.eval(`location.reload()`);
    await sleep(1800);
    const T2 = await cdp.eval(`document.documentElement.getAttribute('data-theme')`);
    eq(T2, 'light', '刷新后主题被记住（localStorage）');
    await cdp.eval(`window.toggleTheme('dark', true)`);
    await sleep(150);

    // ---------- 3) 面板折叠 ----------
    console.log('\n=== 3. 面板折叠（预设布局默认不展开）===');
    const panels = await cdp.eval(`JSON.stringify({
      preset: document.getElementById('body-preset').style.display,
      info: document.getElementById('body-info').style.display,
      bg: document.getElementById('body-bg').style.display,
      presetInRight: !!document.querySelector('main > .col:nth-child(3) #body-preset'),
      presetInCenter: !!document.querySelector('main > .col:nth-child(2) #body-preset'),
    })`);
    const P = JSON.parse(panels);
    console.log('    · ' + panels);
    eq(P.preset, 'none', '预设布局默认不展开');
    eq(P.info, '', '设计信息默认展开');
    eq(P.bg, '', '背景图默认展开');
    ok(P.presetInRight && !P.presetInCenter, '预设布局已从中栏挪到右栏');

    await cdp.eval(`window.togglePanel('preset')`);
    await sleep(150);
    const P2 = await cdp.eval(`JSON.stringify({
      disp: document.getElementById('body-preset').style.display,
      caret: document.getElementById('caret-preset').textContent,
    })`);
    ok(JSON.parse(P2).disp === '' , '点标题能展开：' + P2);
    ok(JSON.parse(P2).caret === '▾', '箭头跟着变');
    // 设计信息 / 背景图 也能折叠
    await cdp.eval(`window.togglePanel('info'); window.togglePanel('bg')`);
    await sleep(150);
    const P3 = JSON.parse(await cdp.eval(`JSON.stringify({
      info: document.getElementById('body-info').style.display,
      bg: document.getElementById('body-bg').style.display })`));
    ok(P3.info === 'none' && P3.bg === 'none', '设计信息与背景图都能折叠');
    await cdp.eval(`window.togglePanel('info'); window.togglePanel('bg'); window.togglePanel('preset')`);

    // ---------- 4) 背景尺寸 ----------
    console.log('\n=== 4. 背景图尺寸 ===');
    const bgFields = await cdp.eval(`JSON.stringify({
      hasW: !!document.getElementById('bgW'), hasH: !!document.getElementById('bgH') })`);
    ok(JSON.parse(bgFields).hasW && JSON.parse(bgFields).hasH, '背景图有 宽/高 输入框');
    const bgWrite = await cdp.eval(`(() => {
      const S = window.CanvasState;
      document.getElementById('bgPath').value = 'assets/x.png';
      document.getElementById('bgFit').value = '0';
      document.getElementById('bgW').value = '200';
      document.getElementById('bgH').value = '100';
      window.bgChanged();
      const bg = S.design.background;
      const json = window.toV2Json(S.design);
      return JSON.stringify({ bg: bg, inJson: JSON.parse(json).background });
    })()`);
    const BW = JSON.parse(bgWrite);
    console.log('    · ' + bgWrite);
    eq(BW.bg.w, 200, '尺寸 w 写进 design');
    eq(BW.bg.h, 100, '尺寸 h 写进 design');
    eq(BW.inJson.w, 200, '尺寸 w 出现在 JSON 里');
    // 往返
    const bgRound = await cdp.eval(`(() => {
      const r = window.parseDesign(window.toV2Json(window.CanvasState.design));
      return JSON.stringify({ err: r.errors.length, bg: r.design ? r.design.background : null });
    })()`);
    eq(JSON.parse(bgRound).err, 0, '带尺寸的背景段往返 0 错误');
    eq(JSON.parse(bgRound).bg.w, 200, '往返保留尺寸 w');
    await cdp.eval(`window.clearBg()`);

    // ---------- 5) 控件树层级徽章 ----------
    console.log('\n=== 5. 控件树层级数徽章 ===');
    const depth = await cdp.eval(`JSON.stringify(
      Array.from(document.querySelectorAll('#tree .tdepth')).map(e => e.textContent))`);
    const D = JSON.parse(depth);
    console.log('    · ' + D.join(' '));
    ok(D.length >= 5, `每行都有层级徽章（${D.length} 个）`);
    ok(D.every(x => /^L\d+$/.test(x)), '徽章格式是 L0 / L1 / L2 …');
    // 造一个嵌套，确认层级数真的会变
    const nested = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const a = window.sortByZ(S.design.nodes)[0];
      const b = window.sortByZ(S.design.nodes)[1];
      window.commit(() => { window.reparent(S.design.nodes, b.id, a.id); }, '嵌套测试');
      const deps = Array.from(document.querySelectorAll('#tree .tdepth')).map(e => e.textContent);
      return JSON.stringify(deps);
    })()`);
    const ND = JSON.parse(nested);
    console.log('    · 嵌套后 ' + ND.join(' '));
    ok(ND.includes('L1'), '嵌套后出现 L1（层级数真的跟着变）');
    await cdp.eval(`window.doUndo()`);

    // ---------- 6) 属性面板空态 ----------
    console.log('\n=== 6. 属性面板空态 ===');
    await cdp.eval(`window.CanvasState.selection = []; window.onSelectionChanged();`);
    await sleep(150);
    const emptyTxt = await cdp.eval(`document.getElementById('props').textContent`);
    console.log('    · 空态文案: ' + JSON.stringify(emptyTxt.trim()));
    ok(!/在画布或控件树里选一个控件/.test(emptyTxt), '那段提示文字已去掉');
    ok(!/按住 Shift 点选/.test(emptyTxt), '「按住 Shift 点选可以多选」也去掉了');
    ok(/属性/.test(emptyTxt), '但仍有个极简标题，不至于看着像坏了');

    // ---------- 7) 画布非等比矩阵修复（用户报的 bug）----------
    console.log('\n=== 7. 画布内容等比（修「名字特别大/分辨率不对劲」）===');
    for (const mode of [0, 1, 2]) {
      const r = await cdp.eval(`(() => {
        const S = window.CanvasState;
        S.design.canvas.scaleMode = ${mode};
        window.applyCanvasSize();
        const M = window.nodeToCanvasMatrix();
        const n = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
        const wm = window.worldMatrix(S.design.nodes, n.id);
        const real = window.matMul(M, wm.m);
        const uni = window.uniformMatrix(real, n.w, n.h);
        // 等比的判据：a == d 且 b == -c
        const sx = Math.hypot(real.a, real.b), sy = Math.hypot(real.c, real.d);
        const usx = Math.hypot(uni.a, uni.b), usy = Math.hypot(uni.c, uni.d);
        return JSON.stringify({
          mode: ${mode},
          realScale: [Math.round(sx * 1000) / 1000, Math.round(sy * 1000) / 1000],
          uniScale: [Math.round(usx * 1000) / 1000, Math.round(usy * 1000) / 1000],
          realNonUniform: Math.abs(sx - sy) > 0.01,
          uniNonUniform: Math.abs(usx - usy) > 0.001,
        });
      })()`);
      const R = JSON.parse(r);
      console.log('    · 模式 ' + mode + ' 真实=' + R.realScale.join('×') +
        ' 内容=' + R.uniScale.join('×') + (R.realNonUniform ? '  ← 真实矩阵非等比' : ''));
      ok(!R.uniNonUniform, `模式 ${mode}：内容矩阵等比（圆不会变椭圆、字不会拉伸）`);
    }
    // stretch 模式下确实是非等比的 —— 证明这个修复是必要的
    const need = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.design.canvas.scaleMode = 0;
      window.applyCanvasSize();
      const M = window.nodeToCanvasMatrix();
      return Math.abs(Math.hypot(M.a, M.b) - Math.hypot(M.c, M.d)) > 0.01;
    })()`);
    ok(need, 'stretch 模式的真实矩阵确实非等比 —— 所以这个修复是必要的（不是过度设计）');
    await cdp.eval(`window.CanvasState.design.canvas.scaleMode = 0; window.applyCanvasSize();`);

    // ---------- 8) 右键菜单 ----------
    console.log('\n=== 8. 右键菜单 ===');
    const ctx = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      S.selection = [n.id];
      window.onSelectionChanged();
      window.showCtxMenu(300, 300);
      const menu = document.getElementById('ctxMenu');
      return JSON.stringify({
        shown: menu.classList.contains('show'),
        items: Array.from(menu.querySelectorAll('.ctxItem')).map(e => e.textContent.trim()),
        title: menu.querySelector('.ctxTitle').textContent.trim(),
        visible: getComputedStyle(menu).display,
      });
    })()`);
    const CX = JSON.parse(ctx);
    console.log('    · 标题: ' + CX.title);
    console.log('    · 项: ' + CX.items.join(' / '));
    ok(CX.shown && CX.visible !== 'none', '右键菜单会显示');
    ok(CX.items.length >= 8, `菜单项足够（${CX.items.length} 项）`);
    ok(CX.items.some(x => /复制/.test(x)) && CX.items.some(x => /删除/.test(x)), '含复制/删除');
    ok(CX.items.some(x => /置顶/.test(x)) && CX.items.some(x => /置底/.test(x)), '含置顶/置底');
    ok(CX.items.some(x => /旋转/.test(x)), '含旋转');
    ok(CX.items.some(x => /锁定|解锁/.test(x)), '含锁定');

    // 多选时出现对齐项
    const ctxMulti = await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.selection = window.flatten(S.design.nodes).slice(0, 3).map(x => x.id);
      window.onSelectionChanged();
      window.showCtxMenu(300, 300);
      return JSON.stringify(Array.from(document.querySelectorAll('#ctxMenu .ctxItem')).map(e => e.textContent.trim()));
    })()`);
    const CM = JSON.parse(ctxMulti);
    ok(CM.some(x => /对齐/.test(x)), '多选时菜单里有对齐项');
    ok(CM.some(x => /等距/.test(x)), '多选时菜单里有等距项');
    // 空选时
    const ctxNone = await cdp.eval(`(() => {
      window.CanvasState.selection = [];
      window.onSelectionChanged();
      window.showCtxMenu(300, 300);
      return JSON.stringify(Array.from(document.querySelectorAll('#ctxMenu .ctxItem')).map(e => e.textContent.trim()));
    })()`);
    ok(JSON.parse(ctxNone).some(x => /全选/.test(x)), '空选时菜单里有全选');
    // 关掉
    const hidden = await cdp.eval(`(() => { window.hideCtxMenu();
      return document.getElementById('ctxMenu').classList.contains('show'); })()`);
    ok(!hidden, '菜单能关掉');
    // 真实右键事件
    await cdp.eval(`(() => {
      const S = window.CanvasState;
      S.selection = [window.sortByZ(S.design.nodes)[0].id];
      window.onSelectionChanged();
      const cv = document.getElementById('cv');
      const r = cv.getBoundingClientRect();
      cv.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.x + 60, clientY: r.y + 60 }));
      return 1;
    })()`);
    await sleep(120);
    const afterReal = await cdp.eval(`document.getElementById('ctxMenu').classList.contains('show')`);
    ok(afterReal, '在画布上真的右键（contextmenu 事件）也能出菜单');
    await cdp.eval(`window.hideCtxMenu()`);

    // ---------- 9) 滚轮缩放选中控件 ----------
    console.log('\n=== 9. 滚轮缩放选中控件 ===');
    const wheel = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      S.selection = [n.id];
      window.onSelectionChanged();
      const before = { w: n.w, h: n.h, ar: n.w / n.h };
      const cv = document.getElementById('cv');
      // 上滚 = 放大
      cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
      const mid = { w: n.w, h: n.h };
      // 下滚两次 = 缩小
      cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
      cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
      const after = { w: n.w, h: n.h };
      return JSON.stringify({
        before: before, mid: mid, after: after,
        arMid: Math.round((mid.w / mid.h) * 100) / 100,
        undoLabel: document.getElementById('undoCount').textContent,
      });
    })()`);
    const WH = JSON.parse(wheel);
    console.log('    · ' + wheel);
    ok(WH.mid.w > WH.before.w, `上滚放大（${WH.before.w} → ${WH.mid.w}）`);
    ok(WH.after.w < WH.mid.w, `下滚缩小（${WH.mid.w} → ${WH.after.w}）`);
    ok(Math.abs(WH.arMid - WH.before.ar) < 0.05, '缩放保持宽高比');
    // 连续滚轮只算一步撤销
    // 先收尾上一组滚轮手势（滚轮没有"松开"事件，靠 350ms 延时；这里显式结束）
    await cdp.eval(`window.onDragEnd()`);
    await sleep(120);
    const wheelUndo = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      const before = document.getElementById('undoCount').textContent;
      const cv = document.getElementById('cv');
      for (let i = 0; i < 12; i++) cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
      window.onDragEnd();
      const after = document.getElementById('undoCount').textContent;
      const d = s => parseInt(s.split('/')[0], 10);
      return JSON.stringify({ before: before, after: after, delta: d(after) - d(before) });
    })()`);
    const WU = JSON.parse(wheelUndo);
    console.log('    · 连滚 12 次：' + WU.before + ' → ' + WU.after);
    ok(WU.delta === 1, `连续滚轮合并成 1 步撤销（实际 +${WU.delta}）`);
    // 没选中时不拦截
    const wheelNoSel = await cdp.eval(`(() => {
      window.CanvasState.selection = [];
      window.onSelectionChanged();
      const cv = document.getElementById('cv');
      const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
      cv.dispatchEvent(ev);
      return ev.defaultPrevented;
    })()`);
    ok(!wheelNoSel, '没选中时不拦截滚轮（页面还能正常滚动）');
    // 锁定的不响应
    const wheelLocked = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      n.locked = true;
      S.selection = [n.id];
      window.onSelectionChanged();
      const before = n.w;
      const cv = document.getElementById('cv');
      cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }));
      const after = n.w;
      n.locked = false;
      return JSON.stringify({ before: before, after: after });
    })()`);
    ok(JSON.parse(wheelLocked).before === JSON.parse(wheelLocked).after, '锁定的控件不响应滚轮缩放');

    // ---------- 10) 右下角旋转图标 ----------
    console.log('\n=== 10. 右下角旋转图标 ===');
    const rot = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      S.selection = [n.id];
      window.onSelectionChanged();
      const hp = window.handlePositions ? null : null;
      // 通过 canvas.js 暴露的 handlePositions 不可用（内部函数），改用几何反推：
      // 右下角手柄应该在 (w, h) 的外侧
      const S2 = window.CanvasState;
      return JSON.stringify({ w: n.w, h: n.h, rot: n.rotation || 0 });
    })()`);
    // 用右键菜单的"旋转 +15°"验证旋转本身可用
    const rot15 = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      const before = n.rotation || 0;
      window.rotateBy(15);
      const after = window.findNode(S.design.nodes, n.id).rotation;
      window.rotateTo(0);
      return JSON.stringify({ before: before, after: after });
    })()`);
    const R15 = JSON.parse(rot15);
    console.log('    · 旋转 ' + R15.before + '° → ' + R15.after + '°');
    eq(R15.after, 15, '旋转 +15° 生效');

    // 右下角手柄的命中：模拟 pointerdown 在右下角外侧，应进入 rotate 模式
    const brHit = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      n.rotation = 0;
      S.selection = [n.id];
      window.onSelectionChanged();
      const cv = document.getElementById('cv');
      const rect = cv.getBoundingClientRect();

      // 先问实现：这个节点的右下角手柄在哪、那个点算什么手柄
      const H = window.handlePositionsFor(n.id);
      const c = window.matApply(H.real, H.hp.rotateBR.x, H.hp.rotateBR.y);
      const hh = window.hitHandleFor(n.id, c.x, c.y);

      const dpr = cv.width / rect.width;
      const px = rect.x + c.x / dpr;
      const py = rect.y + c.y / dpr;
      // 走真实事件路径
      cv.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, clientX: px, clientY: py, pointerId: 1, isPrimary: true }));
      const mode = S.drag ? S.drag.mode : 'none';
      const corner = S.drag ? S.drag.corner : -1;
      cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true }));
      return JSON.stringify({
        mode: mode, corner: corner,
        px: Math.round(px), py: Math.round(py),
        nodeWH: n.w + 'x' + n.h, locked: !!n.locked, selLen: S.selection.length,
        hpBR: [Math.round(H.hp.rotateBR.x * 100) / 100, Math.round(H.hp.rotateBR.y * 100) / 100],
        directHandle: hh.handle,
        inCanvas: (py >= rect.y && py <= rect.bottom && px >= rect.x && px <= rect.right),
        rectBottom: Math.round(rect.bottom),
      });
    })()`);
    const BR = JSON.parse(brHit);
    console.log('    · 在右下角外侧按下 → ' + brHit);
    eq(BR.mode, 'rotate', '右下角图标拖动进入旋转模式');
    eq(BR.corner, 5, '命中的是右下角旋转手柄（编号 5）');

    // ---------- 10b) 四角缩放手柄（同一个 toLocal bug 的回归）----------
    console.log('\n=== 10b. 四角缩放手柄（同一个 bug 的回归）===');
    const corners = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      n.rotation = 0;
      S.selection = [n.id];
      window.onSelectionChanged();
      const cv = document.getElementById('cv');
      const rect = cv.getBoundingClientRect();
      const H = window.handlePositionsFor(n.id);
      const dpr = cv.width / rect.width;
      const out = [];
      // 四角：0=左上 1=右上 2=右下 3=左下
      const pts = [[0,0],[n.w,0],[n.w,n.h],[0,n.h]];
      for (let i = 0; i < 4; i++) {
        const c = window.matApply(H.real, pts[i][0], pts[i][1]);
        const hh = window.hitHandleFor(n.id, c.x, c.y);
        cv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
          clientX: rect.x + c.x / dpr, clientY: rect.y + c.y / dpr, pointerId: 1, isPrimary: true }));
        const mode = S.drag ? S.drag.mode : 'none';
        const corner = S.drag ? S.drag.corner : -1;
        cv.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true }));
        out.push({ i: i, direct: hh.handle, mode: mode, corner: corner });
        S.selection = [n.id];
        window.onSelectionChanged();
      }
      return JSON.stringify(out);
    })()`);
    const CN = JSON.parse(corners);
    CN.forEach(c => console.log('    · 角 ' + c.i + ' → 直接判定 ' + c.direct + '，事件路径 mode=' + c.mode + ' corner=' + c.corner));
    ok(CN.every(c => c.direct === c.i), '四个角都能被直接判定命中');
    ok(CN.every(c => c.mode === 'resize' && c.corner === c.i), '四个角走事件路径都进入 resize 模式（回归：曾因 toLocal 返回 NaN 而全部失效）');
    // ---------- 11) 新建 ----------
    console.log('\n=== 11. 新建 ===');
    const nd = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const before = window.flatten(S.design.nodes).length;
      // 统计 confirm 是否被调用（"新建会先问一次"是设计行为，要断言）
      let asked = 0;
      const orig = window.confirm;
      window.confirm = () => { asked++; return true; };
      window.newDesign();
      window.confirm = orig;
      const after = window.flatten(S.design.nodes).length;
      const names = S.design.nodes.map(n => n.name);
      return JSON.stringify({ before: before, after: after, names: names, sel: S.selection.length, asked: asked });
    })()`);
    const ND2 = JSON.parse(nd);
    console.log('    · ' + nd);
    ok(ND2.after <= 1, `新建后清空（${ND2.before} → ${ND2.after} 个控件）`);
    ok(ND2.sel === 0, '新建后选择被清空');
    eq(ND2.asked, 1, '新建前会先确认一次（避免误清空）');

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
