/* ==========================================================================
   verify-v291.js —— v2.91.0 五项用户要求的守卫

   ## 这个套件为什么存在

   用户一次提了五条要求，每一条都**要么改的是"实测出来的现象"、要么改了
   一个跨模块的契约** —— 两类都属于"改完看起来没问题，但下次有人碰就悄悄坏掉"：

     ① 19 个指示灯原来 normal/warn 态**逐像素共用同一张图**（实测），
        现在每类三态各一张自己的图。守卫：**19 个控件引用的素材必须两两不同**。
     ② JSON 面板默认收起 + 箭头。守卫：**默认是收起的**、**箭头在**、
        而且**收展不许改动画布尺寸**（本项目的老坑）。
     ③ 透明度滑块"只能点击不能拖动"。守卫：**拖动路径不许重建属性面板**
        （重建就把正在拖的那个 input 换掉了，指针捕获当场失效）。
     ④ 用户点名删掉 4 个控件。守卫：**它们真的不在了**，而且
        **`bands` 能力没被连带删掉**（那是两件事）。
     ⑤ 条形轨道从贴图改成代码画。守卫：**`trackStyle` 缺字段 = 老行为**
        （存量设计逐像素不变）+ **往返不丢** + **绘制路径真的分流了**。

   ## 判据风格

   尽量落在**可观测的东西**上（控件的 assetId、画布的 style 尺寸、DOM 里
   有没有那个 input、序列化出来的 JSON 里有没有那个字段），
   而不是"源码里有没有这句话" —— 后者改个变量名就假绿。
   ========================================================================== */
"use strict";
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { decodePng } = require('./_common');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const STUDIO = path.join(__dirname, '..');
const PORT = 9301;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitReady(cdp, timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 20000;
  while (Date.now() - t0 < limit) {
    try {
      const ok = await cdp.eval("!!(window.CanvasState && (window.BUILTIN_ASSETS||[]).length > 0 && document.getElementById('cv') && document.getElementById('cv').width > 0 && window.BUILTIN_DATA_DONE !== false)");
      if (ok) return true;
    } catch (e) { /* 还没起来 */ }
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
      this.w.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      try { this.ws.send(JSON.stringify({ id, method: m, params: p })); }
      catch (e) { this.w.delete(id); rej(e); }
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

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-v291`, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
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

    // ================================================================== ① 指示灯
    console.log('\n=== ① 19 个指示灯：每类三态各一张自己的图 ===');
    const lamp = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const savedA = S.design.assets, savedN = S.design.nodes;
      S.design.assets = []; S.design.nodes = [];
      const idx = {};
      (window.BUILTIN_ASSETS || []).forEach(a => { idx[a.path] = a; });
      const pathOf = id => { const a = (S.design.assets || []).find(x => x.id === id); return a ? a.path : ""; };
      const lamps = (window.BUILTIN_CONTROLS || []).filter(c => c.key.indexOf("lamp_") === 0);
      const rows = [];
      lamps.forEach(c => {
        const n = c.make();
        const st = n.states || {};
        rows.push({ key: c.key,
          normal: pathOf(st.normal && st.normal.assetId),
          warn: pathOf(st.warn && st.warn.assetId),
          critical: pathOf(st.critical && st.critical.assetId),
          statePid: n.statePid });
      });
      S.design.assets = savedA; S.design.nodes = savedN;
      return { n: lamps.length, rows: rows };
    })())`));
    eq(lamp.n, 19, '指示灯控件 = 19 个');
    ["normal", "warn", "critical"].forEach(function (k) {
      const set = {};
      lamp.rows.forEach(r => { set[r[k]] = (set[r[k]] || 0) + 1; });
      const uniq = Object.keys(set).filter(p => p);
      const dup = Object.keys(set).filter(p => set[p] > 1);
      eq(uniq.length, 19, `**${k} 态 19 个控件引用了 19 张不同的图**` +
        (dup.length ? `（共用：${dup.map(p => p + "×" + set[p]).join(", ")}）` : ''));
      ok(uniq.every(p => /^assets\/warning\/lamp-/.test(p)),
        `  ${k} 态的图都来自新的 \`lamp-*\` 素材（不是旧的共用图）` +
        (uniq.some(p => !/^assets\/warning\/lamp-/.test(p)) ? '：' + uniq.filter(p => !/^assets\/warning\/lamp-/.test(p)).slice(0, 3) : ''));
    });
    // 旧的共用图**还在磁盘上**（存量设计按路径引用它，不许删）
    ["lamp-off", "lamp-warn", "lamp-crit"].forEach(function (n) {
      ok(fs.existsSync(path.join(STUDIO, "assets", "warning", n + ".png")),
        `旧的 \`assets/warning/${n}.png\` **仍在磁盘上**（存量设计按路径引用，不许动）`);
    });
    // 新素材必须真的高清（192×192，旧灯盘是 64×64）
    const probe = decodePng(fs.readFileSync(path.join(STUDIO, "assets", "warning", "lamp-tpms-crit.png")));
    ok(probe && probe.w === 192 && probe.h === 192,
      `新灯盘是 **192×192**（旧 \`lamp-off.png\` 是 64×64；实测 ${probe ? probe.w + "×" + probe.h : "解码失败"}）`);
    const oldProbe = decodePng(fs.readFileSync(path.join(STUDIO, "assets", "warning", "lamp-off.png")));
    ok(oldProbe && oldProbe.w === 64, `对照：旧灯盘确实是 64×64（实测 ${oldProbe ? oldProbe.w : "?"}）`);

    // ================================================================== ② JSON 面板
    console.log('\n=== ② JSON 面板默认收起 + 箭头 + 不挤压画布 ===');
    const panel = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      const body = document.getElementById("body-json");
      const caret = document.getElementById("caret-json");
      const head = caret ? caret.closest(".panelHead") : null;
      return {
        hasBody: !!body, hasCaret: !!caret,
        defaultHidden: body ? getComputedStyle(body).display === "none" : null,
        caretText: caret ? caret.textContent : null,
        headClickable: head ? (head.getAttribute("onclick") || "") : "",
        textareaExists: !!document.getElementById("jsonArea"),
      };
    })())`));
    ok(panel.hasBody && panel.hasCaret, '有 `body-json` 与 `caret-json`（面板体 + 箭头）');
    ok(panel.defaultHidden, 'JSON 面板初始是收起的（`display:none`）');
    eq(panel.caretText, "▸", '收起时箭头指向右（▸）');
    ok(/togglePanel\('json'\)/.test(panel.headClickable),
      '标题行可点击切换（`togglePanel(\'json\')`）—— 箭头与标题同一套交互');
    ok(panel.textareaExists, '收起时 `jsonArea` 仍在 DOM 里（校验/测试要读它，不能因为隐藏就没收）');

    // ⚠️ **"默认隐藏"必须在一次干净启动后也成立**（v2.91.0 补的一条真判据）。
    //
    // 上面那条读的是**初始 inline style**。它测不出"`restorePanels()` 把默认值
    // 改成了展开" —— 而 `restorePanels()` 才是**启动时真正决定**面板收展的那一步。
    // 实测踩到：把 `restorePanels()` 里 json 的默认值改成"展开"，整段照样全绿。
    // 所以这里清掉 localStorage 偏好、**重新加载页面**，再看一次。
    await cdp.eval(`(function(){ try { localStorage.removeItem("studio.panel.json"); } catch(e){} return 1; })()`);
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);
    const fresh = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      const body = document.getElementById("body-json");
      const caret = document.getElementById("caret-json");
      return { display: body ? getComputedStyle(body).display : null,
        caret: caret ? caret.textContent : null };
    })())`));
    eq(fresh.display, "none", '**清掉偏好、重新加载后 JSON 面板仍然是收起的**（默认值真的落在 restorePanels 上）');
    eq(fresh.caret, "▸", '  重新加载后箭头也是 ▸');

    // 收展**不许改动画布尺寸** —— 这是本项目的老坑
    const resize = JSON.parse(await cdp.eval(`(() => {
      const cv = document.getElementById("cv");
      window.__panelCanvasResize = [];
      const before = { w: cv.style.width, h: cv.style.height, bw: cv.width, bh: cv.height };
      window.togglePanel("json");     // 展开
      const mid = { w: cv.style.width, h: cv.style.height, bw: cv.width, bh: cv.height };
      window.togglePanel("json");     // 再收起
      const after = { w: cv.style.width, h: cv.style.height, bw: cv.width, bh: cv.height };
      return JSON.stringify({ before: before, mid: mid, after: after,
        log: window.__panelCanvasResize });
    })()`));
    eq(JSON.stringify(resize.mid), JSON.stringify(resize.before),
      '**展开 JSON 后面板画布尺寸一字不变**' + (JSON.stringify(resize.mid) === JSON.stringify(resize.before) ? '' :
        '（' + JSON.stringify(resize.before) + ' → ' + JSON.stringify(resize.mid) + '）'));
    eq(JSON.stringify(resize.after), JSON.stringify(resize.before), '再收起后仍然不变');
    ok(resize.log.every(x => !x.changed),
      '`applyCanvasSizePreserving()` 一次都没报"尺寸被改了"（记了 ' + resize.log.length + ' 次）');
    // ---- ② 的**反向证据**：那个"尺寸被改了"的探测器**真的会响** ----
    //
    // 只断言 `changed` 全是 false 是不够的：把探测器写成恒 false（比如忘了比较、
    // 或者比错了对象）同样是全绿 —— 而那时它**保护不了任何东西**。
    // 所以这里手动把画布尺寸改掉再调一次，要求它**必须发现并还原**。
    const detector = JSON.parse(await cdp.eval(`(() => {
      const cv = document.getElementById("cv");
      // 先按当前布局定一次"正确值"，再手动破坏，看函数报不报。
      window.applyCanvasSizePreserving();
      const realW = cv.style.width, realBw = cv.width;
      window.__panelCanvasResize = [];
      cv.width = 123; cv.height = 123;               // 只动位图（动 style 会连带改父容器宽度）
      window.applyCanvasSizePreserving();
      const log = window.__panelCanvasResize[0];
      return JSON.stringify({ changed: log ? log.changed : null,
        restoredBw: cv.width, realBw: realBw, styleKept: cv.style.width === realW });
    })()`));
    eq(detector.changed, true,
      '**探测器真的会响**：手动把画布位图改成 123×123 后，`changed` 报 true（不是恒 false 的摆设）');
    ok(detector.styleKept,
      '  而且它没有顺手改坏 CSS 尺寸（`style.width` 还是原来的）');
    // ⚠️ **为什么不在这里断言"还原成原尺寸"**（试过，做不到，如实记下）：
    // `applyCanvasSize()` 是按 `wrap.clientWidth` 算的，而这个 headless 环境里
    // `.canvasWrap` 的 clientWidth **跟着画布走**（画布 123px → 容器 ~139px →
    // 算出来还是 123px）→ 函数认为"没变"、不触发还原分支。
    // 也就是说这条路径在**这个布局下不可能被触发** —— 那正是"收展面板不挤压画布"
    // 这条保证的强度来源（上面那两条 `togglePanel` 的断言测的就是它）。
    // 还原分支本身（`if (changed) { 写回 before }`）是 6 行直白代码，
    // 真正的风险不在它写错，而在**根本没人调它** —— 那条已经由 `changed` 全覆盖。
    // 收起来后箭头要翻回去
    const caretAfter = await cdp.eval(`document.getElementById("caret-json").textContent`);
    eq(caretAfter, "▸", '收起后箭头回到 ▸（切换真的生效，不是只有初始状态对）');
    // 记住用户上次的选择
    await cdp.eval(`window.togglePanel("json"); 1`);   // 展开 → localStorage 记 1
    const saved = await cdp.eval(`(function(){ try { return localStorage.getItem("studio.panel.json"); } catch(e){ return "err"; } })()`);
    eq(saved, "1", '展开后**记住了**（localStorage `studio.panel.json` = 1）');
    await cdp.eval(`window.togglePanel("json"); 1`);   // 收回，别影响后面的用例
    const saved2 = await cdp.eval(`(function(){ try { return localStorage.getItem("studio.panel.json"); } catch(e){ return "err"; } })()`);
    eq(saved2, "0", '收起后也记住（= 0）');

    // ================================================================== ③ 滑块实时拖动
    console.log('\n=== ③ 透明度滑块：拖动即预览（不重建属性面板）===');
    const sliderExpr = `(() => {
      const S = window.CanvasState;
      // 造一个仪表选中它，让属性面板渲染出来
      const n = window.createNode(window.NODE_GAUGE, { name: "拖动用例", pid: "obd.rpm", x: 20, y: 20, w: 120, h: 120 });
      S.design.nodes = [n]; S.selection = [n.id];
      window.onSelectionChanged();
      const box = document.getElementById("props");
      const ranges = box.querySelectorAll("input[type=range]");
      const want = "setNodeNumLive";
      const alphaRange = Array.prototype.find.call(ranges, function (r) {
        return (r.getAttribute("oninput") || "").indexOf(want) >= 0;
      });
      return JSON.stringify({ rangeCount: ranges.length, foundAlpha: !!alphaRange,
        oninput: alphaRange ? alphaRange.getAttribute("oninput") : null,
        onchange: alphaRange ? alphaRange.getAttribute("onchange") : null,
        hasLiveFn: typeof window.setNodeNumLive === "function",
        hasBegin: typeof window.beginLiveEdit === "function",
        hasEnd: typeof window.endLiveEdit === "function" });
    })()`;
    if (process.env.V291_DEBUG) { fs.writeFileSync(path.join(os.tmpdir(), "v291-slider-expr.js"), sliderExpr); }
    const slider = JSON.parse(await cdp.eval(sliderExpr));
    ok(slider.rangeCount > 0, `属性面板里有滑块（${slider.rangeCount} 个 range）`);
    ok(slider.foundAlpha, '「不透明度」滑块在（`oninput` 走 `setNodeNumLive(\'alpha\')`）');
    ok(slider.hasLiveFn && slider.hasBegin && slider.hasEnd,
      '三个函数都在：`setNodeNumLive` / `beginLiveEdit` / `endLiveEdit`');
    eq(slider.onchange, "endLiveEdit()", '滑块 `onchange` 绑了 `endLiveEdit()`（收手补一次完整刷新）');

    // **核心判据**：模拟拖动（连续 input）期间，DOM 里那个滑块节点**必须还是同一个**
    const drag = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const box = document.getElementById("props");
      const want = "setNodeNumLive";
      function findAlpha() {
        return Array.prototype.find.call(box.querySelectorAll("input[type=range]"), function (r) {
          return (r.getAttribute("oninput") || "").indexOf(want) >= 0;
        });
      }
      const before = findAlpha();
      // ⚠️ 找不到滑块时**不要抛** —— 抛出去整个套件会中断，后面的断言一条都不跑，
      // 而"拖动时是不是同一个节点"这条**最重要的**判据就永远看不到结果了
      //（反向验证时实测踩到：把 oninput 退回老函数后套件在这里就断了）。
      if (!before) return JSON.stringify({ missing: true, sameNode: false,
        vals: [], trace: [], settled: {}, stillInDomDuringDrag: false, rebuiltAfterRelease: false });
      const n = S.design.nodes[0];
      const vals = [];
      const trace = [];
      // 模拟 6 帧拖动：每帧派发一个 input 事件（真实浏览器就是这么发的）
      for (let i = 0; i < 6; i++) {
        before.value = String(255 - i * 30);
        before.dispatchEvent(new Event("input", { bubbles: true }));
        vals.push(n.alpha);
        trace.push({ i: i, same: before === findAlpha(), live: window.__liveEdit(),
          suppress: S.suppressPanelRender });
      }
      const after = findAlpha();
      // 收手之前取：change 会触发 endLiveEdit 补一次完整刷新，面板那时才重建
      const stillInDom = document.contains(before);
      // 收手
      before.dispatchEvent(new Event("change", { bubbles: true }));
      const settled = { alpha: n.alpha, liveEdit: window.__liveEdit() };
      return JSON.stringify({
        sameNode: before === after,
        vals: vals,
        trace: trace,
        settled: settled,
        stillInDomDuringDrag: stillInDom,
        // 收手之后面板**应该**被重建（旧节点离开 DOM）—— 这才是"补一次完整刷新"
        rebuiltAfterRelease: !document.contains(before),
      });
    })()`));
    ok(drag.sameNode && drag.stillInDomDuringDrag,
      '**拖动 6 帧期间滑块一直是同一个 DOM 节点**（重建面板会把正在拖的 input 换掉 → 指针捕获失效 → 拖不动）');
    if (drag.missing) console.log('    · 滑块没找到（`oninput` 没走 live 路径）—— 上面那条已经报过了');
    ok(drag.rebuiltAfterRelease,
      '收手（`change`）后属性面板**补了一次完整刷新**（旧节点离开 DOM）—— 手势期间省掉的重建补回来了');
    console.log('    · sameNode=' + drag.sameNode + ' stillInDomDuringDrag=' + drag.stillInDomDuringDrag +
      ' rebuiltAfterRelease=' + drag.rebuiltAfterRelease);
    eq(JSON.stringify(drag.vals), JSON.stringify([255, 225, 195, 165, 135, 105]),
      '**每一帧都实时改了值**（拖动即预览，不是"松手才生效"）');
    eq(drag.settled.alpha, 105, '收手后值保留（没有被最后一次重建覆盖回旧值）');
    eq(drag.settled.liveEdit, false, '收手后 `__liveEdit()` 回到 false（手势状态没漏）');

    // 撤销：整段拖动应该是**一步**
    const undo = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = S.design.nodes[0];
      const beforeAlpha = n.alpha;
      const depthBefore = (function () { try { return JSON.parse(localStorage.getItem("icar-studio-undo") || "{}"); } catch (e) { return null; } })();
      window.doUndo();
      const n2 = S.design.nodes[0];
      return JSON.stringify({ beforeAlpha: beforeAlpha, afterUndo: n2 ? n2.alpha : null });
    })()`));
    ok(undo.afterUndo !== undo.beforeAlpha,
      `撤销把整段拖动**一步退掉**（${undo.beforeAlpha} → ${undo.afterUndo}）`);

    // 数字框也走 live 路径（同一个根因的另一种表现）
    // ⚠️ 必须**重新选中一个节点**再查 —— 上面的撤销可能把当前设计换掉了，
    // 属性面板这时是"未选中"，`input[type=number]` 一个都没有（第一版就是这么假红的）。
    const numIn = await cdp.eval(`(function(){
      const S = window.CanvasState;
      const n = window.createNode(window.NODE_GAUGE, { name: "数字框用例", pid: "obd.rpm", x: 10, y: 10, w: 120, h: 120 });
      S.design.nodes = [n]; S.selection = [n.id];
      window.onSelectionChanged();
      const box = document.getElementById("props");
      const ts = box.querySelectorAll("input[type=number]");
      const hit = Array.prototype.find.call(ts, function (t) {
        return (t.getAttribute("oninput") || "").indexOf("setNodeNumLive") >= 0;
      });
      return JSON.stringify({ total: ts.length, found: !!hit,
        oninput: hit ? hit.getAttribute("oninput") : null,
        onchange: hit ? hit.getAttribute("onchange") : null });
    })()`);
    const NI = JSON.parse(numIn);
    ok(NI.found, `数字框也走 \`setNodeNumLive\`（${NI.total} 个数字框，示例：${NI.oninput}）` +
      '—— 每敲一个字符就重建面板 = 光标丢失，同一个根因');
    eq(NI.onchange, "endLiveEdit()", '  数字框也有 `onchange` 收手');

    // 同类滑块：底框透明度 / 圆角（在**仪表**节点上才有这一组）
    const cardSlider = await cdp.eval(`(function(){
      const S = window.CanvasState;
      const n = window.createNode(window.NODE_GAUGE, { name: "底框用例", pid: "obd.rpm", x: 10, y: 10, w: 120, h: 120 });
      S.design.nodes = [n]; S.selection = [n.id];
      window.onSelectionChanged();
      const box = document.getElementById("props");
      const rs = box.querySelectorAll("input[type=range]");
      const all = Array.prototype.map.call(rs, function (r) { return r.getAttribute("oninput") || ""; });
      const nums = Array.prototype.map.call(box.querySelectorAll("input[type=number]"),
        function (t) { return t.getAttribute("oninput") || ""; });
      return JSON.stringify({ ranges: all, numbers: nums });
    })()`);
    const CS = JSON.parse(cardSlider);
    ok(CS.ranges.some(s => s.indexOf("setCardNumLive") >= 0),
      '「底框透明度」滑块也修了（`setCardNumLive`）—— 用户要求"其它同类滑块一起查"');
    ok(CS.numbers.some(s => s.indexOf("setCardNumLive") >= 0),
      '  「底框圆角」数字框同样走 live 路径');
    ok(CS.ranges.every(s => s.indexOf("setNodeNum(") < 0 && s.indexOf("setCardNum(") < 0),
      '**没有滑块还留在会重建面板的老函数上**（' + JSON.stringify(CS.ranges) + '）');
    ok(CS.numbers.every(s => s.indexOf("setNodeNum(") < 0 && s.indexOf("setCardNum(") < 0),
      '**没有数字框还留在老函数上**（' + JSON.stringify(CS.numbers) + '）');

    // ---- ③ 的**反向证据**：老路径（`setNodeNum`）确实会在第一帧就把滑块换掉 ----
    //
    // 这一条是这套修复的"根因证明"。只断言"新路径不重建"是不够的 ——
    // 那只说明现在的代码没走老路径；**老路径到底会不会坏**没有任何证据，
    // 下次有人"顺手简化"回 `setNodeNum` 时，也没有对照物说明为什么不能。
    //
    // 做法：**直接调老函数**（`setNodeNum`），看滑块节点还在不在。
    const oldPath = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.createNode(window.NODE_GAUGE, { name: "老路径对照", pid: "obd.rpm", x: 10, y: 10, w: 120, h: 120 });
      S.design.nodes = [n]; S.selection = [n.id];
      window.onSelectionChanged();
      const box = document.getElementById("props");
      const want = "setNodeNumLive";
      const findAlpha = () => Array.prototype.find.call(box.querySelectorAll("input[type=range]"),
        function (r) { return (r.getAttribute("oninput") || "").indexOf(want) >= 0; });
      const before = findAlpha();
      // 走**老路径**：它 commit → refreshAll → renderPanels → renderProps → innerHTML
      window.setNodeNum("alpha", 200);
      const after = findAlpha();
      return JSON.stringify({
        foundBefore: !!before,
        sameNode: before === after,
        stillInDom: before ? document.contains(before) : null,
        alpha: n.alpha,
      });
    })()`));
    ok(oldPath.foundBefore, '（对照）老路径用例：滑块先是在的');
    ok(oldPath.sameNode === false && oldPath.stillInDom === false,
      '**老路径（`setNodeNum`）确实把滑块节点换掉了** —— 这就是"拖一下就断"的根因（实测 sameNode=' +
      oldPath.sameNode + ' stillInDom=' + oldPath.stillInDom + '）');
    eq(oldPath.alpha, 200, '  对照：老路径的值也写对了（坏的不是"值没写"，是"节点被换掉"）');

    // ================================================================== ④ 删除 4 个控件
    console.log('\n=== ④ 用户点名的 4 个控件已删除 ===');
    const del = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      const byKey = {};
      (window.BUILTIN_CONTROLS || []).forEach(c => { byKey[c.key] = c; });
      return {
        total: (window.BUILTIN_CONTROLS || []).length,
        gone: ["g_speed_d", "g_soc", "g_rpmband", "g_fuelband"].map(k => !byKey[k]),
        // 能力没被连带删掉
        hasBandsApi: typeof window.normalizeBands === "function" && typeof window.bandsUsable === "function",
        cats: (window.CTRL_CATS || []).slice(),
        other: (window.BUILTIN_CONTROLS || []).filter(c => c.cat === "其它").map(c => c.key),
      };
    })())`));
    ok(del.gone.every(Boolean),
      '4 个控件**都不在控件库里**了：数字车速 / 电池电量 / 转速红区表 / 油量绿黄红条');
    ok(del.hasBandsApi, '**`bands` 能力还在**（删的是库里的样板，不是能力）');
    eq(del.other.length, 0, '没有控件掉进「其它」分类（新增的 `cd_` 前缀过了 CAT_RULES）' +
      (del.other.length ? '：' + del.other.slice(0, 6) : ''));
    // `g_soc` 删了，PENDING_P9 里那一条也得删 —— 否则守卫会报"清单里这条已经不需要了"
    const probeSrc = fs.readFileSync(path.join(STUDIO, "..", "guard-pid-probe.js"), "utf8");
    ok(probeSrc.indexOf("g_soc:") < 0,
      '`guard-pid-probe.js` 的 `PENDING_P9` 里没有 `g_soc` 残留（控件删了，待办也要删）');

    // ================================================================== ⑤ 代码绘制轨道
    console.log('\n=== ⑤ 条形轨道改成代码绘制（trackStyle）===');
    const track = JSON.parse(await cdp.eval(`JSON.stringify((() => {
      const S = window.CanvasState;
      const cd = (window.BUILTIN_CONTROLS || []).filter(c => c.key.indexOf("cd_") === 0);
      const cats = {};
      cd.forEach(c => { cats[c.cat] = (cats[c.cat] || 0) + 1; });
      const one = (window.BUILTIN_CONTROLS || []).find(c => c.key === "cd_trackgradh");
      const node = one ? one.make() : null;
      // 老控件（贴图轨道）**必须还在**且不带 trackStyle
      const oldOne = (window.BUILTIN_CONTROLS || []).find(c => c.key === "bar_trackh");
      const oldNode = oldOne ? oldOne.make() : null;
      return {
        cdCount: cd.length, cats: cats,
        trackStyle: node ? node.trackStyle : null,
        assetId: node ? node.assetId : null,
        oldStillThere: !!oldOne,
        oldTrackStyle: oldNode ? oldNode.trackStyle : "MISSING",
        hasDrawTrack: typeof window.drawTrackNode === "function",
        hasNormalize: typeof window.normalizeTrackStyle === "function",
      };
    })())`));
    ok(track.cdCount >= 24, `代码绘制轨道控件 ${track.cdCount} 个`);
    eq(JSON.stringify(Object.keys(track.cats)), JSON.stringify(["条形轨道(代码)"]),
      '它们都归到新分类「条形轨道(代码)」');
    ok(track.trackStyle && track.trackStyle.gradient === "gloss",
      '`cd_trackgradh` 带 `trackStyle.gradient = "gloss"`（代码画的渐变，不是 PNG）');
    eq(track.assetId, "", '代码轨道控件**不引用任何素材**（`assetId` 为空 → 不可能贴图）');
    ok(track.oldStillThere, '旧的贴图轨道控件 `bar_trackh` **还在**（存量设计按 path 引用，不许删）');
    eq(track.oldTrackStyle, null, '  老控件的 `trackStyle` 是 `null` → **走老行为**（贴图）');
    ok(track.hasDrawTrack && track.hasNormalize,
      '绘制侧与归一化侧都在（`drawTrackNode` / `normalizeTrackStyle`）');

    // 向后兼容：**缺字段 = 老行为**，往返逐字段不变
    const compat = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const savedN = S.design.nodes;
      // 一份"老设计"：图片节点，没有 trackStyle
      const old = window.createNode(window.NODE_IMAGE, { name: "老贴图轨道", assetId: "as_x", x: 0, y: 0, w: 240, h: 16 });
      S.design.nodes = [old];
      const j1 = window.toV2Json(S.design);
      const hasField = j1.indexOf("trackStyle") >= 0;
      const back = window.parseDesign(j1);
      // 再导出一次，两次必须逐字相同（往返稳定）
      S.design.nodes = back.design.nodes;
      const j2 = window.toV2Json(S.design);
      S.design.nodes = savedN;
      return JSON.stringify({ hasField: hasField, same: j1 === j2, errors: back.errors.length,
        trackStyle: back.design.nodes[0] ? back.design.nodes[0].trackStyle : "MISSING" });
    })()`));
    ok(!compat.hasField, '**老图片节点导出时不写 `trackStyle`**（缺字段 = 老行为）');
    eq(compat.trackStyle, null, '  解析回来是 `null` → 绘制侧走贴图那条分支');
    ok(compat.same, '**"老设计 → 导出 → 导入 → 再导出"逐字节相同**（往返稳定，存量文件不会被改写）');
    eq(compat.errors, 0, '  往返 0 错误');

    // 代码轨道往返：字段不许丢
    const rt = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const savedN = S.design.nodes;
      const one = (window.BUILTIN_CONTROLS || []).find(c => c.key === "cd_seg10h").make();
      one.trackStyle.fill = 0.5; one.trackStyle.color = "#123456"; one.trackStyle.accent = "#ABCDEF";
      S.design.nodes = [one];
      const j = window.toV2Json(S.design);
      const back = window.parseDesign(j);
      S.design.nodes = savedN;
      return JSON.stringify({ errors: back.errors.length,
        before: one.trackStyle, after: back.design.nodes[0].trackStyle });
    })()`));
    eq(rt.errors, 0, '代码轨道往返 0 错误');
    eq(JSON.stringify(rt.after), JSON.stringify(rt.before),
      '**`trackStyle` 逐字段往返不变**（segments / fill / color / accent 都不丢）');

    // 畸形输入：夹住 + 出声，**不拒收**
    const malformed = JSON.parse(await cdp.eval(`(() => {
      const r = window.parseDesign(JSON.stringify({
        schema: "icar.ui/2", canvas: { unit: 360 },
        nodes: [{ id: "x", type: "image", name: "畸形轨道", x: 0, y: 0, w: 100, h: 20,
          trackStyle: { orient: "q", radius: "abc", segments: 9999, ticks: -3, fill: 5, gradient: "zzz", color: "red" } }],
      }));
      const n = r.design ? r.design.nodes[0] : null;
      return JSON.stringify({ errors: r.errors.length, warnings: r.warnings.length,
        ts: n ? n.trackStyle : null });
    })()`));
    eq(malformed.errors, 0, '畸形 `trackStyle` **不产生硬错误**（拒收存量文件比少画一格贵得多）');
    ok(malformed.warnings > 0, `畸形值**出声警告**（${malformed.warnings} 条）—— 不能静默`);
    ok(malformed.ts && malformed.ts.orient === "h", '`orient: "q"` → 夹成 `h`');
    ok(malformed.ts && malformed.ts.segments === 64, '`segments: 9999` → 夹到上限 64');
    ok(malformed.ts && malformed.ts.ticks === 0, '`ticks: -3` → 0');
    ok(malformed.ts && malformed.ts.fill === 1, '`fill: 5` → 夹到 1');
    ok(malformed.ts && malformed.ts.gradient === null, '`gradient: "zzz"` → null（无渐变）');
    ok(malformed.ts && malformed.ts.color === null, '`color: "red"` → null（只认 #RRGGBB，不静默改成别的色）');

    // 属性面板里**能改**（否则字段再多也没入口）
    const ui = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const savedN = S.design.nodes;
      const n = window.createNode(window.NODE_IMAGE, { name: "轨道UI", assetId: "", x: 0, y: 0, w: 240, h: 16 });
      S.design.nodes = [n]; S.selection = [n.id];
      window.onSelectionChanged();
      const box = document.getElementById("props");
      const text1 = box.textContent || "";
      const offHasHint = text1.indexOf("贴图") >= 0;
      // 勾上「用代码画」
      window.toggleTrackStyle(true);
      const after = S.design.nodes[0];
      const text2 = box.textContent || "";
      const onHasFields = text2.indexOf("分段 / 刻度") >= 0 && text2.indexOf("填充比例") >= 0;
      const turnedOn = !!(S.design.nodes[0] && S.design.nodes[0].trackStyle);
      // 改一个字段，看它有没有落进 trackStyle
      window.setTrackField("segments", "7");
      const seg = S.design.nodes[0].trackStyle.segments;
      // 非法值要被夹住（唯一入口是 normalizeTrackStyle）
      window.setTrackField("segments", "9999");
      const clamped = S.design.nodes[0].trackStyle.segments;
      // 关掉 → 回到 null（贴图）
      window.toggleTrackStyle(false);
      const back = S.design.nodes[0].trackStyle;
      S.design.nodes = savedN;
      return JSON.stringify({ offHasHint: offHasHint, onHasFields: onHasFields,
        hasTrackGroup: text2.indexOf("条形轨道") >= 0,
        turnedOn: turnedOn, seg: seg, clamped: clamped, backToNull: back === null });
    })()`));
    ok(ui.offHasHint, '未开启时面板上有「贴图 / 拉长会模糊」的说明（用户知道自己在看什么）');
    ok(ui.turnedOn && ui.onHasFields, '勾上「用代码画」后出现方向 / 圆角 / 分段 / 填充等字段');
    eq(ui.seg, 7, '`setTrackField("segments","7")` 真的写进 `trackStyle`');
    eq(ui.clamped, 64, '**面板写入也过 `normalizeTrackStyle`**（9999 → 夹到 64，唯一入口没被绕过）');
    ok(ui.backToNull, '取消勾选 → `trackStyle = null`（**回到贴图 = 完全旧行为**）');

    // 绘制路径真的分流了：画一个代码轨道，它周围的像素必须变
    const pixels = JSON.parse(await cdp.eval(`(() => {
      const S = window.CanvasState;
      const savedN = S.design.nodes;
      const cv = document.getElementById("cv");
      const g = cv.getContext("2d");
      function snap() { return g.getImageData(0, 0, cv.width, cv.height).data; }
      function diff(a, b) { let n = 0; for (let i = 0; i < a.length; i += 4) { if (Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]) > 20) n++; } return n; }
      // 1) 空白设计
      S.design.nodes = [];
      window.draw();
      const blank = snap();
      // 2) 一条代码轨道（大一点，好数像素）
      const t = window.createNode(window.NODE_IMAGE, { name: "t", assetId: "", x: 40, y: 40, w: 280, h: 60,
        trackStyle: { orient: "h", band: true, glow: true, fill: 0.6 } });
      S.design.nodes = [t];
      window.draw();
      const withTrack = snap();
      // 3) 同一个节点、但去掉 trackStyle（应该走"没有素材"的紫占位分支）
      t.trackStyle = null;
      window.draw();
      const asImage = snap();
      S.design.nodes = savedN;
      return JSON.stringify({ blankVsTrack: diff(blank, withTrack), trackVsImage: diff(withTrack, asImage) });
    })()`));
    ok(pixels.blankVsTrack > 500,
      `代码轨道**真的画出了东西**（相对空白底改了 ${pixels.blankVsTrack} 个像素）`);
    ok(pixels.trackVsImage > 500,
      `**\`trackStyle\` 非空时不会走贴图/占位分支**（去掉它之后画面差了 ${pixels.trackVsImage} 个像素）`);

    // ================================================================== 素材总量
    console.log('\n=== 附：素材与控件总量（会写进 docs/12 的那两个数字）===');
    const totals = JSON.parse(await cdp.eval(`JSON.stringify({
      assets: (window.BUILTIN_ASSETS || []).length,
      controls: (window.BUILTIN_CONTROLS || []).length,
      dataKB: Math.round((window.BUILTIN_ASSETS || []).reduce((s, a) => s + (a.data || "").length, 0) / 1024),
    })`));
    console.log('    · ' + JSON.stringify(totals));
    ok(totals.dataKB < 1200, `内嵌 data 总量 ${totals.dataKB} KB（< 1200 KB，不然工具启动会变慢）`);
    ok(totals.assets >= 400, `素材 ${totals.assets} 个（v2.90.0 是 359，本轮 +57 个指示灯）`);
    ok(totals.controls >= 190, `控件 ${totals.controls} 个（v2.90.0 是 176，本轮 −4 +28）`);

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + (e && e.stack ? e.stack : e));
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(60));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
