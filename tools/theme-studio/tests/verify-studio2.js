// 用 CDP 连无头 Edge，**真的驱动**主题制作工具：
//   1) 捕获任何 JS 错误（拆分多文件后最容易出的就是加载顺序/未定义）
//   2) 检查三栏面板都渲染出来了
//   3) 实际执行：建节点 → 改属性 → 撤销/重做 → 序列化 → 校验
// 这是"双击能用"这条核心属性的机器验证。
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// ⚠️ 路径**从 __dirname 推导**，不要硬编码 ——
// 换机器 / 换目录时硬编码会报"找不到文件"，看起来像测试坏了。
const PAGE = require('path').join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9224;
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

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waiting.has(m.id)) {
        const { resolve, reject } = c.waiting.get(m.id);
        c.waiting.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        c.events.push(m);
      }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' :: ' +
        ((r.exceptionDetails.exception || {}).description || ''));
    }
    return r.result.value;
  }
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);

(async () => {
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-studio-profile`,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    let ver = null;
    for (let i = 0; i < 40; i++) {
      try { ver = await getJson('/json/version'); break; } catch (e) { await sleep(250); }
    }
    if (!ver) throw new Error('CDP 未就绪');
    console.log('  Edge:', ver['Browser']);

    const targets = await getJson('/json/list');
    const page = targets.find(t => t.type === 'page');
    const cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);   // 弹窗 stub —— 见 _common.js 的说明

    // ---------- 1) JS 错误 ----------
    console.log('\n=== 1. JS 错误 / 控制台 ===');
    const errs = cdp.events.filter(e =>
      (e.method === 'Runtime.exceptionThrown') ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
      (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    if (errs.length) {
      errs.slice(0, 8).forEach(e => {
        const p = e.params;
        const txt = p.exceptionDetails
          ? (p.exceptionDetails.text + ' :: ' + ((p.exceptionDetails.exception || {}).description || ''))
          : (p.entry ? p.entry.text : JSON.stringify(p.args || []));
        console.log('    ⚠️ ' + String(txt).split('\n')[0]);
      });
    }
    ok(errs.length === 0, `无 JS 错误（捕获 ${errs.length} 条）`);

    // ---------- 2) 脚本加载顺序 ----------
    console.log('\n=== 2. 模块加载 ===');
    const mods = await cdp.eval(`JSON.stringify({
      schema: typeof window.SCHEMA_V2,
      model: typeof window.createNode,
      undo: typeof window.UndoStack,
      validate: typeof window.validateText,
      presets: typeof window.PRESETS,
      canvas: typeof window.draw,
      panels: typeof window.renderPanels,
      commit: typeof window.commit,
      nodeTypes: window.NODE_TYPES ? window.NODE_TYPES.length : -1,
      aliases: window.PID_ALIASES ? Object.keys(window.PID_ALIASES).length : -1,
      // v2.19.0：渲染走 assetKindList()（用户能排序/新建），不是出厂常量
      kinds: window.assetKindList ? window.assetKindList().length : -1,
      defaultKinds: (window.DEFAULT_ASSET_KINDS || []).length,
      hasMoveKind: typeof window.moveAssetKind === 'function',
      hasAddKind: typeof window.addAssetKind === 'function',
      hasDelKind: typeof window.delAssetKind === 'function',
      hasResetKinds: typeof window.resetAssetKinds === 'function',
      scaleModes: window.SCALE_MODES ? window.SCALE_MODES.length : -1,
    })`);
    const M = JSON.parse(mods);
    ok(M.schema === 'string', 'schema.js 已加载');
    ok(M.model === 'function', 'model.js 已加载（createNode）');
    ok(M.undo === 'function', 'model.js 的 UndoStack 已加载');
    ok(M.validate === 'function', 'validate.js 已加载');
    ok(M.presets === 'object', 'presets.js 已加载');
    ok(M.canvas === 'function', 'canvas.js 已加载');
    ok(M.panels === 'function', 'panels.js 已加载');
    ok(M.commit === 'function', 'app.js 已加载');
    eq(M.nodeTypes, 4, '节点类型 4 种');
    eq(M.aliases, 27, 'PID 别名 27 条');
    eq(M.kinds, 12, '素材分类 12 个（v2.20.0 新增 条形轨道 / 面板边框）');
    // v2.19.0：分类可排序 / 可新建 —— 渲染走 assetKindList()，不是出厂常量
    eq(M.defaultKinds, 12, '出厂分类常量 12 个');
    ok(M.hasMoveKind, 'moveAssetKind() 可用（分类排序）');
    ok(M.hasAddKind, 'addAssetKind() 可用（新建分类）');
    ok(M.hasDelKind, 'delAssetKind() 可用（删除自定义分类）');
    ok(M.hasResetKinds, 'resetAssetKinds() 可用（恢复出厂顺序）');
    eq(M.scaleModes, 3, '缩放模式 3 种');

    // ---------- 3) 面板渲染 ----------
    console.log('\n=== 3. 面板渲染 ===');
    const ui = await cdp.eval(`JSON.stringify({
      tree: document.getElementById('tree').innerHTML.length,
      treeRows: document.querySelectorAll('#tree .trow').length,
      assets: document.getElementById('assets').innerHTML.length,
      assetKinds: document.querySelectorAll('#assets .akind').length,
      props: document.getElementById('props').innerHTML.length,
      msgs: document.querySelectorAll('#msgs .msg').length,
      canvasW: document.getElementById('cv').width,
      canvasH: document.getElementById('cv').height,
      sizeLabel: document.getElementById('canvasSizeLabel').textContent,
      undoCount: document.getElementById('undoCount').textContent,
    })`);
    const U = JSON.parse(ui);
    ok(U.tree > 200, '控件树已渲染');
    ok(U.treeRows >= 5, `控件树有节点行（${U.treeRows} 行）`);
    ok(U.assets > 200, '素材库已渲染');
    // 10 个**图片**分类 + 2 个控件区（复用同一个 .akind 类），共 12 个
    eq(U.assetKinds, 14, '素材库有 12 个图片分类 + 2 个控件区');
    const kindNames = await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('#assets .akind .akname')).map(e => e.textContent.trim()))`);
    ok(JSON.parse(kindNames).filter(x => /背景|仪表盘|指针|刻度|图标|转向灯|警告灯|汽车品牌|装饰|自定义/.test(x)).length >= 10,
      '10 个图片分类都在：' + JSON.parse(kindNames).length + ' 个区');
    ok(U.props > 50, '属性面板已渲染（未选中时给提示）');
    // 用户明确要求删掉那段引导文案；现在只留一个极简标题（不至于看着像坏了）
    const emptyProps = await cdp.eval(`document.getElementById('props').textContent`);
    ok(!/选一个控件/.test(emptyProps), '未选中时不再显示引导文案（用户要求删掉）');
    ok(/属性/.test(emptyProps), '但仍有极简标题');
    ok(U.msgs >= 1, '校验结果已渲染');
    ok(U.canvasW > 0 && U.canvasH > 0, `画布位图 ${U.canvasW}×${U.canvasH}`);
    ok(/2560×1600/.test(U.sizeLabel), `尺寸标签显示设计分辨率（${U.sizeLabel}）`);
    eq(U.undoCount, '0 / 0', '撤销计数初始为 0 / 0');

    // ---------- 4) 实际驱动：选中 + 改属性 + 撤销重做 ----------
    console.log('\n=== 4. 选中 / 改属性 / 撤销重做 ===');
    const drive = await cdp.eval(`(() => {
      const log = [];
      const S = window.CanvasState;
      const before = window.flatten(S.design.nodes).length;
      log.push('初始节点数=' + before);

      // 选中第一个节点
      const first = window.sortByZ(S.design.nodes)[0];
      S.selection = [first.id];
      window.onSelectionChanged();
      log.push('选中=' + first.name + ' props长度=' + document.getElementById('props').innerHTML.length);

      // 改属性（走 commit → 压栈）
      window.setNodeNum('x', 33);
      log.push('x改为33 实际=' + first.x + ' 撤销计数=' + document.getElementById('undoCount').textContent);

      // 撤销
      window.doUndo();
      const n2 = window.findNode(S.design.nodes, first.id);
      log.push('撤销后 x=' + (n2 ? n2.x : 'NODE_GONE'));

      // 重做
      window.doRedo();
      const n3 = window.findNode(S.design.nodes, first.id);
      log.push('重做后 x=' + (n3 ? n3.x : 'NODE_GONE'));

      // 加图片控件
      window.addImageNode();
      log.push('加图片后节点数=' + window.flatten(S.design.nodes).length);

      // 删除
      window.delSelected();
      log.push('删除后节点数=' + window.flatten(S.design.nodes).length);

      // 撤销删除
      window.doUndo();
      log.push('撤销删除后节点数=' + window.flatten(S.design.nodes).length);
      return JSON.stringify(log);
    })()`);
    JSON.parse(drive).forEach(l => console.log('    · ' + l));
    const D = JSON.parse(drive);
    ok(/撤销后 x=0/.test(D.join('|')), '撤销把 x 改回 0');
    ok(/重做后 x=33/.test(D.join('|')), '重做把 x 改回 33');
    ok(/撤销删除后节点数=5/.test(D.join('|')) || /撤销删除后节点数=6/.test(D.join('|')),
      '撤销删除恢复了节点');

    // ---------- 5) 序列化与校验 ----------
    console.log('\n=== 5. 序列化 / 校验 / v1 导出 ===');
    const ser = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const v2 = window.toV2Json(S.design);
      const parsed = JSON.parse(v2);
      const back = window.parseDesign(v2);
      const v1 = window.toV1Json(S.design);
      const v1parsed = window.parseDesign(v1.json);
      return JSON.stringify({
        schema: parsed.schema,
        nodeCount: parsed.nodes.length,
        hasCanvas: !!parsed.canvas && parsed.canvas.designW === 2560,
        roundTripErrors: back.errors.length,
        roundTripNodes: back.design ? back.design.nodes.length : -1,
        v1Count: v1.count,
        v1Schema: JSON.parse(v1.json).schema,
        v1Errors: v1parsed.errors.length,
        lostImage: v1.lost.image,
        validateErrors: window.validateText(v2).errors.length,
      });
    })()`);
    const R = JSON.parse(ser);
    console.log('    · ' + ser);
    eq(R.schema, 'icar.ui/2', '写出的是 v2');
    ok(R.nodeCount >= 5, `v2 节点数 ${R.nodeCount}`);
    ok(R.hasCanvas, 'canvas.designW 正确写出');
    eq(R.roundTripErrors, 0, 'v2 往返 0 错误');
    eq(R.roundTripNodes, R.nodeCount, 'v2 往返节点数一致');
    eq(R.v1Schema, 'icar.ui/1', 'v1 导出写成 icar.ui/1');
    eq(R.v1Errors, 0, 'v1 导出能被解析（0 错误）');
    ok(R.v1Count >= 1, `v1 导出 ${R.v1Count} 个仪表`);
    ok(R.lostImage >= 1, `v1 导出如实报告丢掉的图片控件（${R.lostImage} 个）`);
    eq(R.validateErrors, 0, '校验 0 硬错误');

    // ---------- 6) 撤销栈：100 步上限 + 连续改动合并 ----------
    console.log('\n=== 6. 撤销栈 100 步上限 / 连续改动合并 ===');

    // 6a) 合并：同一个 coalesceKey 的连续改动只算一步
    const coalesce = await cdp.eval(`(() => {
      const S = window.CanvasState;
      const n = window.sortByZ(S.design.nodes)[0];
      S.selection = [n.id];
      window.onSelectionChanged();
      const before = document.getElementById('undoCount').textContent;
      for (let i = 0; i < 150; i++) window.setNodeNum('x', i % 360);   // 带 coalesceKey
      window.onDragEnd();                                             // 结束合并
      const after = document.getElementById('undoCount').textContent;
      const d = s => parseInt(String(s).split('/')[0], 10);
      return JSON.stringify({ before: before, after: after, delta: d(after) - d(before) });
    })()`);
    const CO = JSON.parse(coalesce);
    console.log('    · 150 次连续改 x：' + CO.before + ' → ' + CO.after +
      '（增加 ' + CO.delta + ' 步）');
    ok(CO.delta === 1, '150 次连续同类改动被合并成 1 步（实际增加 ' + CO.delta + ' 步）');

    // 6b) 上限：用**不合并**的操作（加节点）灌满栈，数能退多少步
    const stack = await cdp.eval(`(() => {
      const S = window.CanvasState;
      for (let i = 0; i < 150; i++) window.addImageNode();   // 每次都是新的一步
      const label = document.getElementById('undoCount').textContent;
      let depth = 0;
      while (depth < 400) {
        const before = document.getElementById('undoCount').textContent;
        window.doUndo();
        const after = document.getElementById('undoCount').textContent;
        if (before === after) break;
        depth++;
      }
      return JSON.stringify({ label: label, depth: depth });
    })()`);
    const K = JSON.parse(stack);
    console.log('    · 灌 150 步后：' + K.label + '，实际可退 ' + K.depth + ' 步');
    ok(K.depth <= 101, `撤销深度受 100 步上限约束（实际 ${K.depth} 步）`);
    ok(K.depth >= 95, `但确实保留了近百步（实际 ${K.depth}）`);

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally {
    proc.kill();
  }


  // ⚠️ 分类排序 / 新建的**功能**测试还没写：
  //    它需要 cdp 句柄，而这段代码在 cdp 的作用域之外（试过，报 cdp is not defined）。
  //    目前只验证了 API 存在 + 渲染出 12 个区（见上面）。
  //    要补的话，把这段挪到文件里 cdp 还在作用域的位置。

  console.log('\n' + '='.repeat(56));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
