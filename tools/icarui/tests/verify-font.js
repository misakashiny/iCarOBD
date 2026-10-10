// 验证字体：格式 / 绘制 / 属性面板 / 控件编辑器 / 往返
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9258;
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
    `--user-data-dir=${os.tmpdir()}\\edge-font`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
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

    // ---------- 1) 常量 ----------
    console.log('\n=== 1. 字体常量 ===');
    const consts = await cdp.eval(`JSON.stringify({
      fam: window.FONT_FAMILIES.map(x => x.v),
      weights: window.FONT_WEIGHTS.map(x => x.v),
      aligns: window.FONT_ALIGNS.map(x => x.v),
      def: window.FONT_DEFAULT,
    })`);
    const C = JSON.parse(consts);
    console.log('    · 字体族 ' + C.fam.join('/') + '  字重 ' + C.weights.join('/') + '  对齐 ' + C.aligns.join('/'));
    eq(C.fam.length, 4, '4 种字体族');
    eq(C.weights.length, 4, '4 档字重');
    eq(C.aligns.length, 3, '3 种对齐');
    ok(C.def.family === 'sans' && C.def.size > 0, '有默认字体对象');

    // ---------- 2) normalizeFont 兜底 ----------
    console.log('\n=== 2. normalizeFont 夹住非法值 ===');
    const norm = await cdp.eval(`JSON.stringify({
      bad: window.normalizeFont({ family: '不存在', size: -5, weight: 123, align: 'xx', color: 'red', letterSpacing: 999 }),
      empty: window.normalizeFont(null),
      good: window.normalizeFont({ family: 'mono', size: 22, weight: 700, italic: true, letterSpacing: 2, align: 'center', color: '#FF0000' }),
    })`);
    const N = JSON.parse(norm);
    console.log('    · 非法输入 → ' + JSON.stringify(N.bad));
    eq(N.bad.family, 'sans', '未知字体族回落到 sans');
    eq(N.bad.align, 'left', '未知对齐回落到 left');
    eq(N.bad.size, 6, '负字号回落到默认（6，不是 16）');
    eq(N.bad.weight, 400, '非法字重回落到 400');
    eq(N.bad.color, '#E8EEF7', '非法颜色回落到默认');
    eq(N.bad.letterSpacing, 50, '字距被夹到上限 50');
    ok(N.empty.family === 'sans' && N.empty.size === 6, 'null 也能拿到完整默认值');
    eq(N.good.italic, true, '合法值原样保留');

    // ---------- 3) 新建文字控件带 font ----------
    console.log('\n=== 3. 新建的文字控件带 font 对象 ===');
    const mk = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const c = window.BUILTIN_CONTROLS.find(x => x.key === 'text');
      const n = c.make();
      return JSON.stringify({ type: n.type, hasFont: !!n.font, font: n.font, hasOldFields: ('fontSize' in n) || ('bold' in n) });
    })()`);
    const MK = JSON.parse(mk);
    console.log('    · ' + mk);
    ok(MK.hasFont, '文字节点带 font 对象');
    ok(!MK.hasOldFields, '旧的 fontSize/bold 字段已经不存在了');
    eq(MK.font.family, 'sans', '默认字体族 sans');

    // ---------- 4) 仪表带 labelFont ----------
    console.log('\n=== 4. 仪表带 labelFont + 显示开关 ===');
    const g = await cdp.eval(`(() => {
      const c = window.BUILTIN_CONTROLS.find(x => x.key === 'gauge_0');
      const n = c.make();
      return JSON.stringify({ hasLabelFont: !!n.labelFont, showLabel: n.showLabel, showRange: n.showRange });
    })()`);
    const G = JSON.parse(g);
    console.log('    · ' + g);
    ok(G.hasLabelFont, '仪表带 labelFont');
    eq(G.showLabel, true, '默认显示名字');
    eq(G.showRange, true, '默认显示量程');

    // ---------- 5) 属性面板有「字体」组 ----------
    console.log('\n=== 5. 属性面板的字体组 ===');
    const panel = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const out = {};
      // 文字控件
      const txt = window.createNode(window.NODE_TEXT, { name: 'T', x: 0, y: 0, w: 100, h: 30 });
      S.design.nodes.push(txt);
      S.selection = [txt.id];
      window.onSelectionChanged();
      out.textGroups = Array.from(document.querySelectorAll('#props .phead')).map(e => e.textContent.replace(/[▾▸]/g,'').trim());
      out.textFontRows = Array.from(document.querySelectorAll('#props .prow > label')).map(e => e.textContent.trim())
        .filter(x => /字体|字号|字重|斜体|字距|对齐|颜色/.test(x));
      // 仪表
      const gg = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      S.selection = [gg.id];
      window.onSelectionChanged();
      out.gaugeGroups = Array.from(document.querySelectorAll('#props .phead')).map(e => e.textContent.replace(/[▾▸]/g,'').trim());
      return JSON.stringify(out);
    })()`);
    const P = JSON.parse(panel);
    console.log('    · 文字控件的组: ' + P.textGroups.join(' / '));
    console.log('    · 字体行: ' + P.textFontRows.join(' / '));
    console.log('    · 仪表的组: ' + P.gaugeGroups.join(' / '));
    ok(P.textGroups.some(x => /字体/.test(x)), '文字控件有「字体」组');
    ok(P.textFontRows.length >= 7, `字体组有 7 行（实际 ${P.textFontRows.length}）`);
    ok(P.gaugeGroups.some(x => /字体/.test(x)), '仪表也有「字体（表上的文字）」组');

    // ---------- 6) 改字体 → 画布真的变 ----------
    console.log('\n=== 6. 改字体 → 画布真的变 ===');
    const live = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const cv = document.getElementById('cv');
      // ⚠️ **指纹必须够灵敏**（v2.55.0）。
      //
      // 原来是 i += 331 且**只读 R 通道**（d[i]）——
      // 实测在"把仪表调色板换成主题色"之后，
      // 「改字距 → 画布变了」「改斜体 → 画布变了」两条会**红**：
      // 字距/斜体改的是抗锯齿边缘的**细微灰度**，只读 R 且抽样稀疏时测不到。
      //
      // 改成：**步长 97**（密 3.4 倍）+ **四个通道都读**。
      //
      // 仍然会「看起来变了但指纹没变」的极端情况存在吗？会 ——
      // 但只要"四通道 + 密采样"都测不出来，那个差异在视觉上也确实可以忽略。
      const hash = () => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 97) {
          for (let c = 0; c < 4; c++) h = (h * 31 + d[i + c]) % 2147483647;
        }
        return h;
      };
      const txt = window.flatten(S.design.nodes).find(x => x.type === 'window' || x.type === 'text');
      S.selection = [txt.id];
      window.onSelectionChanged();
      const h0 = hash();
      window.setNodeFont('size', 40);   const h1 = hash();
      window.setNodeFont('family', 'mono'); const h2 = hash();
      window.setNodeFont('weight', 700);  const h3 = hash();
      window.setNodeFont('letterSpacing', 6); const h4 = hash();
      window.setNodeFont('align', 'center'); const h5 = hash();
      window.setNodeFont('color', '#FF0000'); const h6 = hash();
      window.setNodeFont('italic', true);  const h7 = hash();
      const n = window.findNode(S.design.nodes, txt.id);
      return JSON.stringify({ h0,h1,h2,h3,h4,h5,h6,h7, font: n.font,
        每项都变了: [h1,h2,h3,h4,h5,h6,h7].every((x,i) => x !== [h0,h1,h2,h3,h4,h5,h6][i]) });
    })()`);
    const LV = JSON.parse(live);
    console.log('    · 最终 font: ' + JSON.stringify(LV.font));
    ok(LV.h1 !== LV.h0, '改字号 → 画布变了');
    ok(LV.h2 !== LV.h1, '改字体族 → 画布变了');
    ok(LV.h3 !== LV.h2, '改字重 → 画布变了');
    ok(LV.h4 !== LV.h3, '改字距 → 画布变了');
    ok(LV.h5 !== LV.h4, '改对齐 → 画布变了');
    ok(LV.h6 !== LV.h5, '改颜色 → 画布变了');
    ok(LV.h7 !== LV.h6, '改斜体 → 画布变了');
    eq(LV.font.size, 40, '字号写进去了');
    eq(LV.font.align, 'center', '对齐写进去了');
    eq(LV.font.color, '#FF0000', '颜色写进去了');

    // ---------- 7) 序列化 + 往返 ----------
    console.log('\n=== 7. 字体往返 ===');
    const round = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const txt = window.flatten(S.design.nodes).find(x => x.type === 'text');
      const json = window.toV2Json(S.design);
      const j = JSON.parse(json);
      const inFile = j.nodes.filter(n => n.type === 'text').map(n => n.font)[0];
      const r = window.parseDesign(json);
      const back = window.flatten(r.design.nodes).find(x => x.type === 'text');
      return JSON.stringify({
        文件里的font: inFile,
        往返错误: r.errors.length,
        往返后的font: back ? back.font : null,
        一致: back ? JSON.stringify(back.font) === JSON.stringify(inFile) : false,
      });
    })()`);
    const RD = JSON.parse(round);
    console.log('    · 文件里: ' + JSON.stringify(RD.文件里的font));
    console.log('    · 往返后: ' + JSON.stringify(RD.往返后的font));
    eq(RD.往返错误, 0, '带字体的文件往返 0 错误');
    ok(RD.一致, '字体字段逐项往返一致');

    // 仪表 labelFont 只在非默认时写出
    const lf = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const gg = window.flatten(S.design.nodes).find(x => x.type === 'gauge');
      const before = JSON.parse(window.toV2Json(S.design)).nodes.find(n => n.type === 'gauge');
      S.selection = [gg.id];
      window.onSelectionChanged();
      window.setNodeFont('family', 'condensed');
      const after = JSON.parse(window.toV2Json(S.design)).nodes.find(n => n.type === 'gauge');
      return JSON.stringify({ 默认时写了labelFont吗: 'labelFont' in before, 改后写了吗: 'labelFont' in after,
        改后的值: after.labelFont });
    })()`);
    const LF = JSON.parse(lf);
    console.log('    · ' + lf);
    ok(!LF.默认时写了labelFont吗, 'labelFont 是默认值时**不写进文件**（避免每个表塞一坨默认值）');
    ok(LF.改后写了吗, '改了之后会写进文件');
    eq(LF.改后的值.family, 'condensed', '写的是改后的值');

    // ---------- 8) 控件编辑器也有字体 ----------
    console.log('\n=== 8. 控件编辑器里的字体 ===');
    const ed = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const txt = window.flatten(S.design.nodes).find(x => x.type === 'text');
      window.openControlEditor(txt.id);
      const groups = Array.from(document.querySelectorAll('#ceProps .phead')).map(e => e.textContent.replace(/[▾▸]/g,'').trim());
      const cv = document.getElementById('cePreview');
      const hash = () => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let h = 0; for (let i = 0; i < d.length; i += 331) h = (h*31 + d[i]) % 2147483647;
        return h;
      };
      const h0 = hash();
      window.ceSetFont('family', 'serif');
      const h1 = hash();
      window.closeControlEditor();
      return JSON.stringify({ groups: groups, 预览变了: h0 !== h1 });
    })()`);
    const ED = JSON.parse(ed);
    console.log('    · 编辑器的组: ' + ED.groups.join(' / '));
    ok(ED.groups.some(x => /字体/.test(x)), '控件编辑器有「字体」组');
    ok(ED.预览变了, '在编辑器里改字体 → 预览跟着变');

    // ---------- 点阵字形完整性（v2.34.0）
  console.log('\n=== 点阵字形完整性 ===');
  {
    const pngMod = require(require("path").join(__dirname, "..", "png.js"));
    const F = pngMod.FONT_5x7;
    const KEYS = Object.keys(F);
    const missUp = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter(c => !F[c]);
    const missLo = "abcdefghijklmnopqrstuvwxyz".split("").filter(c => !F[c]);
    const missDi = "0123456789".split("").filter(c => !F[c]);
    console.log("    · 共 " + KEYS.length + " 个字形；缺大写 " + missUp.length +
                "、小写 " + missLo.length + "、数字 " + missDi.length);
    eq(missUp.length, 0, "A-Z 齐" + (missUp.length ? "（缺 " + missUp.join(",") + "）" : ""));
    eq(missLo.length, 0, "a-z 齐" + (missLo.length ? "（缺 " + missLo.join(",") + "）" : ""));
    eq(missDi.length, 0, "0-9 齐" + (missDi.length ? "（缺 " + missDi.join(",") + "）" : ""));
    ok(KEYS.every(k => F[k].length === 7 && F[k].every(r => r.length === 5)),
      "每个字形都是 7 行 × 5 列（尺寸不对会静默画歪）");
    ok(["°", ".", "-", "%", "/", ":"].every(c => F[c]), "常用符号齐（° . - % / :）");
    ok(KEYS.length >= 70, "字形总数合理（" + KEYS.length + "）");
  }
  //
  // 为什么值得单独测：v2.27.0 加小写时，我的替换锚点就是 `Z: [...]` 那一行，
  // 而它以 `};` 结尾 —— 替换整个锚点等于**把 Z 一起删了**。
  // 影响：任何含 Z 的文字（比如 "Hz"）渲染成空格，**而且不会报错**。
  //
  // 这类"字形悄悄少了一个"的问题，只有逐个点名才查得出来。
  await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
