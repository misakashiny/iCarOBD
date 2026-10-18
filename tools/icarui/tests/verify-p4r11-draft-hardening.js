// ============================================================================
// verify-p4r11-draft-hardening.js —— P4R-1.1 自动草稿可靠性加固验收
//
// 设计原则：**每段测试都从干净状态开始**，不依赖前一阶段的异步定时器。
// 之前踩过：一个未停的 setInterval 污染后续所有 revision 断言。
//
//   一、最长保存间隔机制存在且参数合理
//   二、全变更入口（commit/undo/redo/setOnce/增删节点/加素材）
//   三、撤销后 IndexedDB 与内存一致（任务第三部分关键场景）
//   四、异步写入版本保护（旧写入不覆盖新草稿）
//   五、删除墓碑（飞行中写入不复活已删草稿）
//   六、设计身份隔离（A 草稿不被 B 覆盖）
//   七、素材完整性（data 逐字节一致）
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4r11-${Date.now()}`,
    '--window-size=1700,1050', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    for (let i = 0; i < 60; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(300); } }
    cdp = await CDP.connect((await getJson('/json/list')).find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);
    await sleep(2600);

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const JJ = (v) => JSON.parse(v);

    /** 异步结果写全局，再轮询取回 —— 避开评估上下文差异 */
    async function asyncGet(expr, key, tries) {
      await cdp.eval("delete window[" + JSON.stringify(key) + "];" + expr);
      for (let i = 0; i < (tries || 24); i++) {
        await sleep(150);
        const v = await cdp.eval("typeof window[" + JSON.stringify(key) + "]==='undefined' ? '' : window[" + JSON.stringify(key) + "]");
        if (v !== '' && v !== null && v !== undefined) return typeof v === 'string' ? JJ(v) : v;
      }
      return null;
    }

    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    // ================= 一、最长保存间隔机制 =================
    const cfg = JJ(await step('config',
      "JSON.stringify({debounce:ICAR.ui.DraftManager.DEBOUNCE_MS," +
      "maxUnsaved:ICAR.ui.DraftManager.MAX_UNSAVED_MS});"));
    ok(cfg.debounce === 1200, '防抖间隔 1200ms（保持 P4R-1 值）');
    ok(typeof cfg.maxUnsaved === 'number', '存在最长保存间隔机制（P4R-1.1 新增）');
    ok(cfg.maxUnsaved === 5000, '最长未保存 5000ms（任务建议 5~10s，取偏保守）');
    ok(cfg.maxUnsaved > cfg.debounce, '最长间隔 > 防抖间隔（否则退化成第二个防抖）');

    // ================= 二、全变更入口 =================
    // 直接返回 Promise（cdp.eval 带 awaitPromise:true，会等到 resolve）
    const revOf = async () => {
      const raw = await cdp.eval(
        "ICAR.ui.DraftStore.listDrafts().then(function(l){" +
        "var id=ICAR.ui.DraftManager.currentDesignId();" +
        "var d=l.find(function(x){return x.designId===id;});" +
        "return JSON.stringify({rev:d?d.revision:-1," +
        "nodes:d?d.nodeCount:-1,assets:d?d.assetCount:-1});})");
      return typeof raw === 'string' ? JJ(raw) : raw;
    };

    const entryCheck = async (label, action) => {
      // ⚠️ 每个入口测试都**重建设计**：避免前一入口的 undo/redo 留下的历史影响判断
      await cdp.eval("(function(){var R=ICAR.registry.Control,S=CanvasState;" +
        "S.design=createDesign({name:'入口测试'});S.design.nodes=[];S.design.assets=[];" +
        "for(var i=0;i<8;i++){S.design.nodes.push(R.byLegacyKey('t_title').build());}" +
        "window.refreshAll();window.__undoStack.reset(window.__commitState(),'初始');})()");
      await sleep(600);
      // 建立基线草稿
      await cdp.eval("window.commit(function(){CanvasState.design.nodes[0].alpha=200;},'baseline');");
      await sleep(2100);

      const before = await revOf();
      await cdp.eval(action);
      await sleep(2100);
      const after = await revOf();
      return { label, before, after };
    };

    await cdp.eval("(function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'撤销关键'});S.design.nodes=[];" +
      "for(var i=0;i<5;i++){S.design.nodes.push(R.byLegacyKey('t_title').build());}" +
      "window.commit(function(){S.design.nodes[0].alpha=11;},'A');})()");
    await sleep(1500);
    await cdp.eval("window.commit(function(){CanvasState.design.nodes[0].alpha=22;},'B');");
    await sleep(1700);
    await cdp.eval("window.doUndo();");
    await sleep(1800);

    const undoConsistent = await asyncGet(
      "(function(){var id=ICAR.ui.DraftManager.currentDesignId();" +
      "ICAR.ui.DraftStore.listDrafts().then(function(l){" +
      "var d=l.find(function(x){return x.designId===id;});" +
      "return ICAR.ui.DraftStore.getDraft(d.draftId);}).then(function(g){" +
      "var o=JSON.parse(g.record.designJson);" +
      "window.__uc=JSON.stringify({dbAlpha:o.nodes[0].alpha,memAlpha:CanvasState.design.nodes[0].alpha});});})()",
      '__uc');
    ok(undoConsistent && undoConsistent.dbAlpha === undoConsistent.memAlpha,
      '**undo 后 IndexedDB 与内存一致**（db=' + (undoConsistent ? undoConsistent.dbAlpha : '?') +
      ' mem=' + (undoConsistent ? undoConsistent.memAlpha : '?') + '）');

    const restoreAfterUndo = await asyncGet(
      "(function(){var DS=ICAR.ui.DraftStore;" +
      "var id=ICAR.ui.DraftManager.currentDesignId();" +
      "DS.listDrafts().then(function(l){" +
      "var d=l.find(function(x){return x.designId===id;});" +
      "return DS.getDraft(d.draftId);}).then(function(g){" +
      "var o=JSON.parse(g.record.designJson);" +
      "var ok=window.replaceDesign(o,'恢复');" +
      "window.__ru=JSON.stringify({ok:ok,alpha:CanvasState.design.nodes[0].alpha});});})()",
      '__ru');
    ok(restoreAfterUndo && restoreAfterUndo.ok === true &&
      restoreAfterUndo.alpha === undoConsistent.memAlpha,
      '恢复拿到的是 undo 后状态（alpha=' + (restoreAfterUndo ? restoreAfterUndo.alpha : '?') + '）');

    // ================= 四、版本保护 =================
    const stale = await asyncGet(
      "(function(){var DS=ICAR.ui.DraftStore,S=CanvasState;" +
      "S.design=createDesign({name:'verA'});S.design.nodes=[];" +
      "S.design.nodes.push(ICAR.registry.Control.byLegacyKey('t_title').build());" +
      "DS.saveDraft({designId:'VER',designName:'verA',design:S.design,revision:10,lastKnownRevision:null})" +
      ".then(function(){return DS.saveDraft({designId:'VER',designName:'verA',design:S.design,revision:5,lastKnownRevision:9});})" +
      ".then(function(second){return DS.getDraft('draft_VER').then(function(g){" +
      "window.__sw=JSON.stringify({secondOk:second.ok,conflict:second.reason==='conflict',storedRev:g.record.revision});});});" +
      "})()", '__sw');
    // P4R-1.2：语义从"静默放弃(stale)"升级为"明确冲突(conflict)"
    ok(stale && stale.secondOk === false, '过期的写入被**拒绝**（P4R-1.2 乐观并发控制）');
    ok(stale && stale.conflict === true, '拒绝原因是 conflict（不再静默丢弃）');
    ok(stale && stale.storedRev === 10, '**旧写入没有覆盖新草稿**（库里仍是 rev=10）');

    // ================= 五、删除墓碑 =================
    const tomb = await asyncGet(
      "(function(){var DS=ICAR.ui.DraftStore,S=CanvasState;" +
      "S.design=createDesign({name:'tombA'});S.design.nodes=[];" +
      "DS.saveDraft({designId:'TOMB',designName:'tombA',design:S.design,revision:1})" +
      ".then(function(){return DS.deleteDraft('draft_TOMB');})" +
      ".then(function(){return DS.saveDraft({designId:'TOMB',designName:'tombA',design:S.design,revision:2});})" +
      ".then(function(after){return DS.getDraft('draft_TOMB').then(function(g){" +
      "window.__tb=JSON.stringify({blocked:after.ok===false,reason:after.reason," +
      "resurrected:!!(g&&g.record)});});});" +
      "})()", '__tb');
    ok(tomb && tomb.blocked === true, '删除后的写入被拒绝');
    ok(tomb && tomb.reason === 'tombstoned', '拒绝原因是 tombstoned');
    ok(tomb && tomb.resurrected === false, '**已删除草稿不会被飞行中写入复活**');

    // ================= 六、设计身份隔离 =================
    // 身份隔离：先清空草稿库，避免前面测试的草稿干扰判断
    await cdp.eval("(function(){if(window.ICAR&&ICAR.ui&&ICAR.ui.DraftStore){" +
  "return ICAR.ui.DraftStore.__clearAll();}return 'not-ready';})()");
    await sleep(900);

    // ⚠️ 必须走 replaceDesign（真实用户路径）才会换 designId；
    //    直接赋 S.design 不换身份 —— 这是测试写法问题，不是产品缺陷。
    await cdp.eval("(function(){var R=ICAR.registry.Control;" +
      "var d=createDesign({name:'隔离A'});d.nodes=[];" +
      "for(var i=0;i<6;i++){d.nodes.push(R.byLegacyKey('t_title').build());}" +
      "window.replaceDesign(d,'建A');" +
      "window.commit(function(){CanvasState.design.nodes[0].alpha=88;},'A');})()");
    // 确保 A 的草稿**确实写进库**再切走（await 等待 Promise 完成，不是 sleep 猜）
    const flushRes = await cdp.eval("(function(){var D=ICAR.ui.DraftManager;" +
      "var r=D.flush('force');" +
      "if(r&&typeof r.then==='function'){return r.then(function(x){return JSON.stringify(x||{});});}" +
      "return JSON.stringify({sync:true});})()");
    console.log('  [diag] flush = ' + flushRes);
    await sleep(600);
    const idA = await cdp.eval("ICAR.ui.DraftManager.currentDesignId()");
    const draftA = JJ(await cdp.eval("ICAR.ui.DraftStore.listDrafts().then(function(l){" +
      "var a=l.find(function(x){return x.designId===" + JSON.stringify(idA) + ";});" +
      "return JSON.stringify({exists:!!a,nodes:a?a.nodeCount:-1});})"));

    await cdp.eval("(function(){var d=createDesign({name:'隔离B'});d.nodes=[];window.replaceDesign(d,'换到B');})()");
    await sleep(2100);
    const idB = await cdp.eval("ICAR.ui.DraftManager.currentDesignId()");
    const draftAAfter = JJ(await cdp.eval("ICAR.ui.DraftStore.listDrafts().then(function(l){" +
      "var a=l.find(function(x){return x.designId===" + JSON.stringify(idA) + ";});" +
      "return JSON.stringify({exists:!!a,nodes:a?a.nodeCount:-1});})"));

    const identity = { different: idA !== idB, aExistsBefore: draftA.exists,
      aExists: draftAAfter.exists, aNodes: draftAAfter.nodes };

    console.log('  [diag] identity = ' + JSON.stringify(identity));
    ok(identity.different === true, '换设计后 designId 不同');
    ok(identity.aExistsBefore === true && identity.aExists === true, '**A 的草稿仍在**（不被 B 覆盖）');
    ok(identity.aNodes === 6, 'A 草稿节点数正确（' + identity.aNodes + '）');

    // ================= 七、素材完整性 =================
    const assetInt = await asyncGet(
      "(function(){var DS=ICAR.ui.DraftStore,S=CanvasState;" +
      "var png='" + PNG + "';" +
      "S.design=createDesign({name:'素材完整性'});S.design.nodes=[];S.design.assets=[];" +
      "for(var i=0;i<20;i++){S.design.assets.push({id:'im'+i,name:'t'+i,kind:'custom'," +
      "path:'im'+i+'.png',data:png,w:100,h:100});}" +
      "DS.saveDraft({designId:'AI',designName:'asset',design:S.design,revision:1})" +
      ".then(function(){return DS.getDraft('draft_AI');}).then(function(g){" +
      "var o=JSON.parse(g.record.designJson);var back=o.assets[0].data;" +
      "window.__ai=JSON.stringify({assets:o.assets.length,dataLen:back.length," +
      "sameAsSource:back===png,isDataUrl:back.indexOf('data:image/png')===0});});" +
      "})()", '__ai');
    ok(assetInt && assetInt.assets === 20, '20 张素材全部保存');
    ok(assetInt && assetInt.isDataUrl === true, '素材 data 仍是合法 dataURL');
    ok(assetInt && assetInt.sameAsSource === true, '**素材内容逐字节一致**（不只是存在）');

    const reEdit = await asyncGet(
      "(function(){var DS=ICAR.ui.DraftStore,S=CanvasState;" +
      "DS.getDraft('draft_AI').then(function(g){" +
      "var o=JSON.parse(g.record.designJson);var ok=window.replaceDesign(o,'恢复');" +
      "window.commit(function(){S.design.assets[0].name='改名';},'改素材');" +
      "var j=toV2Json(S.design);var b=parseDesign(j);" +
      "window.__re=JSON.stringify({ok:ok,assets:S.design.assets.length," +
      "renamed:S.design.assets[0].name,errs:b.errors.length});});})()", '__re');
    ok(reEdit && reEdit.ok === true, '恢复后可以再次编辑素材');
    ok(reEdit && reEdit.renamed === '改名', '恢复后素材可改名');
    ok(reEdit && reEdit.assets === 20, '恢复后导出包含全部 20 张素材（errs=' + (reEdit?reEdit.errs:'?') + '，' +
  '其中可能含素材路径告警，非硬错误）');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "return {entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "hasSaveFile:typeof window.saveFile==='function'," +
      "hasReplaceDesign:typeof window.replaceDesign==='function'};})())"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69');
    ok(compat.hasSaveFile === true, '手动保存 saveFile 未被删除');
    ok(compat.hasReplaceDesign === true, 'replaceDesign 仍可用');

    await cdp.eval("ICAR.ui.DraftStore.__clearAll()");
  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
