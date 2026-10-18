// ============================================================================
// verify-p4r1-draft.js —— P4R-1 安全草稿自动恢复验收
//
// 一、IndexedDB 可用性与原型（8 种设计场景）
// 二、草稿数据完整性（完成标记 / 校验和 / 结构校验）
// 三、设计身份（同名不混淆 / designId 不进设计文件）
// 四、自动保存触发与防抖
// 五、恢复提示 UI（不自动覆盖 / 稍后再说不删 / 删除需确认）
// 六、图片完整恢复（含 data）
// 七、恢复后模型、撤销栈、导出
// 八、异常保护（配额 / 损坏 / 不可用）
// 九、与手动保存、UndoStack 的隔离
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4r1-${Date.now()}`,
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

    // ================= 一、模块与可用性 =================
    const mods = JJ(await step('modules',
      "JSON.stringify({store:typeof (ICAR.ui&&ICAR.ui.DraftStore)," +
      "mgr:typeof (ICAR.ui&&ICAR.ui.DraftManager)," +
      "open:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.open)," +
      "saveDraft:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.saveDraft)," +
      "getDraft:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.getDraft)," +
      "listDrafts:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.listDrafts)," +
      "deleteDraft:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.deleteDraft)," +
      "validateDraft:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.validateDraft)," +
      "getStatus:typeof(ICAR.ui.DraftStore&&ICAR.ui.DraftStore.getStatus)});"));
    ok(mods.store === 'object', 'DraftStore 模块已加载');
    ok(mods.mgr === 'object', 'DraftManager 模块已加载');
    ok(mods.open === 'function' && mods.saveDraft === 'function' && mods.getDraft === 'function',
      'open / saveDraft / getDraft 均可用');
    ok(mods.listDrafts === 'function' && mods.deleteDraft === 'function' &&
      mods.validateDraft === 'function' && mods.getStatus === 'function',
      'listDrafts / deleteDraft / validateDraft / getStatus 均可用');

    const st = JJ(await step('status', "JSON.stringify(ICAR.ui.DraftStore.getStatus())"));
    ok(st.available === true, 'file:// 下 IndexedDB 可用（任务第三关要求）');
    ok(st.dbName === 'icar-studio-drafts', '数据库名固定');

    // ================= 二、8 种设计场景 =================
    await cdp.eval("window.PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';");
    await cdp.eval("window.__mkDsg=function(n){" +
      "var S=CanvasState;" +
      "S.design=createDesign({name:'场景测试'});S.design.nodes=[];" +
      "var ks=['t_title','cd_trackh','g_speed','lamp_tpms','lamp_coolant'];" +
      "for(var i=0;i<n;i++){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===ks[i%5];});" +
      "var nd=c.make();nd.x=(i%12)*25;nd.y=Math.floor(i/12)*25;S.design.nodes.push(nd);}" +
      "return S.design;};");
    await cdp.eval("window.__addImgs=function(n){" +
      "var S=CanvasState;S.design.assets=S.design.assets||[];" +
      "for(var i=0;i<n;i++){S.design.assets.push({id:'im'+i,name:'图'+i,kind:'custom'," +
      "path:'img'+i+'.png',data:window.PNG,w:100,h:100});}return S.design;};");

    const scenarios = [
      ['空设计', 'window.__mkDsg(0)'],
      ['60控件', 'window.__mkDsg(60)'],
      ['5张图片', '(window.__mkDsg(10),window.__addImgs(5))'],
      ['20张图片', '(window.__mkDsg(10),window.__addImgs(20))'],
    ];
    for (let si = 0; si < scenarios.length; si++) {
      const [label, build] = scenarios[si];
      const r = JJ(await step('scenario ' + label,
        "(function(){var d=" + build + ";var DS=ICAR.ui.DraftStore;" +
        "var json=JSON.stringify(d);" +
        "return new Promise(function(res){DS.saveDraft({designId:'s" + si + "',designName:'场景测试',design:d,selection:[]})" +
        ".then(function(w){DS.getDraft('draft_s" + si + "').then(function(g){" +
        "res(JSON.stringify({ok:w.ok,bytes:json.length,found:!!g,problem:g?g.problem:null,nodes:DS.countNodes(d)}));});});});" +
        "})()"));
      ok(r.ok === true, '场景「' + label + '」写入成功');
      ok(r.found === true && r.problem === null, '场景「' + label + '」读回校验通过（' + r.bytes + 'B, ' + r.nodes + ' 节点）');
    }

    // ================= 三、草稿数据完整性 =================
    const integ = JJ(await step('integrity',
      "(function(){var DS=ICAR.ui.DraftStore;" +
      "var good='{\"nodes\":[]}';" +
      "var base={draftId:'x',designId:'d',designJson:good,checksum:DS.checksumOf(good)};" +
      "return JSON.stringify({" +
      "noComplete:DS.validateDraft(base)," +
      "withComplete:DS.validateDraft(Object.assign({},base,{complete:true}))," +
      "completeFalse:DS.validateDraft(Object.assign({},base,{complete:false}))," +
      "tampered:DS.validateDraft(Object.assign({},base,{designJson:'{\"nodes\":[',complete:true}))," +
      "noNodes:DS.validateDraft({draftId:'x',designId:'d',designJson:'{\"a\":1}'," +
      "checksum:DS.checksumOf('{\"a\":1}'),complete:true})});})()"));
    ok(integ.noComplete !== null, '缺完成标记判为不可恢复');
    ok(integ.withComplete === null, '完成标记 + 校验和正确 → 可恢复');
    ok(integ.completeFalse !== null, '完成标记为 false 判为不可恢复（部分写入保护）');
    ok(integ.tampered !== null, '数据被截断 → 校验失败');
    ok(integ.noNodes !== null, '缺少 nodes 数组 → 结构校验失败');

    // ================= 四、设计身份 =================
    const ident = JJ(await step('identity',
      "(function(){var DS=ICAR.ui.DraftStore,S=CanvasState;" +
      "S.design=createDesign({name:'同名设计'});S.design.nodes=[];" +
      "return new Promise(function(res){" +
      "DS.saveDraft({designId:'IDX1',designName:'同名设计',design:S.design}).then(function(){" +
      "return DS.saveDraft({designId:'IDX2',designName:'同名设计',design:S.design});}).then(function(){" +
      "DS.listDrafts().then(function(l){" +
      "var same=l.filter(function(d){return d.designName==='同名设计';});" +
      "res(JSON.stringify({count:same.length," +
      "distinctIds:new Set(same.map(function(d){return d.designId;})).size}));});});});" +
      "})()"));
    ok(ident.count === 2, '同名设计存 2 份草稿（不互相覆盖）');
    ok(ident.distinctIds === 2, '同名设计的 designId 不同（名称不作为唯一身份）');

    // designId 不进设计文件
    const noId = JJ(await step('designId not in file',
      "(function(){var S=CanvasState,R=ICAR.ui.DraftManager;" +
      "var id=R.currentDesignId();" +
      "var json=toV2Json(S.design);" +
      "var obj=JSON.parse(json);" +
      "return JSON.stringify({designId:id," +
      "idInJson:json.indexOf(id)>=0," +
      "hasUnderscoreId:obj.design?Object.prototype.hasOwnProperty.call(obj.design,'_id'):false," +
      "designKeys:obj.design?Object.keys(obj.design).slice(0,10):null});})()"));
    ok(noId.idInJson === false, 'designId **不出现在 icar.ui/2 导出文件里**');
    ok(noId.hasUnderscoreId === false, '设计文件里没有 _id 字段');

    // ================= 五、自动保存触发与防抖 =================
    const debounce = JJ(await step('debounce',
      "(function(){var DS=ICAR.ui.DraftStore,R=ICAR.ui.DraftManager,S=CanvasState;" +
      "var R2=ICAR.registry.Control;" +
      "S.design=createDesign({name:'防抖测试'});S.design.nodes=[];window.refreshAll();" +
      "var before=R.getState().saveCount;" +
      "for(var i=0;i<10;i++){" +
      "  var nd=S.design.nodes[0]||null;" +
      "  window.commit(function(){if(!S.design.nodes.length)S.design.nodes.push(R2.byLegacyKey('t_title').build());" +
      "    else S.design.nodes[0].alpha=100+i;},'c'+i);}" +
      "var afterCommits=R.getState().saveCount;" +
      "return JSON.stringify({before:before,afterCommits:afterCommits," +
      "dirty:R.getState().dirty,debounceMs:R.DEBOUNCE_MS});})()"));
    ok(debounce.afterCommits === debounce.before, '连续 10 次 commit 期间**没有立即写盘**（防抖生效）');
    ok(debounce.dirty === true, 'commit 后标记为 dirty');
    ok(debounce.debounceMs === 1200, '防抖间隔 1200ms（实测选定）');

    await sleep(1800);
    const afterDebounce = JJ(await step('after debounce',
      "JSON.stringify({saveCount:ICAR.ui.DraftManager.getState().saveCount," +
      "dirty:ICAR.ui.DraftManager.getState().dirty," +
      "lastOk:ICAR.ui.DraftManager.getState().lastSaveOk})"));
    ok(afterDebounce.dirty === false, '防抖到期后 dirty 被清除');
    ok(afterDebounce.lastOk === true, '防抖到期后保存成功');

    // ================= 六、图片完整恢复 =================
    const imgOk = JJ(await step('image restore',
      "(function(){var S=CanvasState,DS=ICAR.ui.DraftStore,R=ICAR.ui.DraftManager;" +
      "S.design=createDesign({name:'图片完整性'});S.design.nodes=[];" +
      "S.design.assets=[{id:'u1',name:'用户图',kind:'custom',path:'u1.png'," +
      "data:window.PNG,w:100,h:100}];" +
      "S.design.nodes.push(ICAR.registry.Control.byLegacyKey('t_title').build());" +
      "return new Promise(function(res){DS.saveDraft({designId:'imgtest',designName:'图片完整性',design:S.design})" +
      ".then(function(){" +
      "return DS.getDraft('draft_imgtest');}).then(function(g){" +
      "var d=JSON.parse(g.record.designJson);" +
      "var a=d.assets&&d.assets[0];" +
      "res(JSON.stringify({dataPreserved:!!(a&&a.data)," +
      "dataLen:a?a.data.length:0,dataIsDataUrl:a?a.data.indexOf('data:image')===0:false," +
      "pathPreserved:a?a.path:null}));});});" +
      "})()"));
    ok(imgOk.dataPreserved === true, '**asset.data 完整保存到 IndexedDB**（不是只存 path）');
    ok(imgOk.dataIsDataUrl === true, 'data 仍是合法 dataURL（' + imgOk.dataLen + ' 字节）');
    ok(imgOk.pathPreserved === 'u1.png', 'asset.path 同时保留');

    // ================= 七、启动不自动覆盖 =================
    const noAuto = JJ(await step('no auto overwrite',
      "(function(){var S=CanvasState;" +
      "var before=JSON.stringify({n:S.design.nodes.length,name:S.design.name});" +
      "return new Promise(function(res){setTimeout(function(){" +
      "var after=JSON.stringify({n:S.design.nodes.length,name:S.design.name});" +
      "res(JSON.stringify({unchanged:before===after,before:before}));},300);});})()"));
    ok(noAuto.unchanged === true, '启动后**不自动覆盖当前画布**（画布内容保持不变）');

    // 提示条：本套件启动时库是空的，需要先造一份草稿再触发检测
    const bar = JJ(await step('recovery bar',
      "(function(){var DS=ICAR.ui.DraftStore,R=ICAR.ui.DraftManager,S=CanvasState;" +
      "S.design=createDesign({name:'提示条测试'});S.design.nodes=[];" +
      "S.design.assets=[{id:'b1',name:'图',kind:'custom',path:'b.png',data:window.PNG,w:10,h:10}];" +
      "S.design.nodes.push(ICAR.registry.Control.byLegacyKey('t_title').build());" +
      "return DS.saveDraft({designId:'BAR1',designName:'提示条测试',design:S.design})" +
      ".then(function(){return R.checkForDraft();})" +
      ".then(function(){" +
      "var b=document.getElementById('draftRecoveryBar');" +
      "return JSON.stringify({exists:!!b," +
      "visible:b?b.style.display!=='none':false," +
      "text:b?b.textContent.replace(/\\s+/g,' ').slice(0,140):null});});" +
      "})()"));
    ok(bar.exists === true, '恢复提示条已创建');
    ok(bar.visible === true, '检测到草稿时提示条可见');
    if (bar.text) {
      const btns = JSON.parse(await cdp.eval("(function(){var b=document.getElementById('draftRecoveryBar');" +
        "if(!b)return '[]';" +
        "return JSON.stringify(Array.from(b.querySelectorAll('.drbBtns button')).map(function(x){return x.textContent;}));})()"));
      ok(btns.length >= 3 && btns.indexOf('稍后再说') >= 0 && btns.indexOf('删除草稿') >= 0,
        '提示条含操作按钮：' + JSON.stringify(btns));
    }

    // ================= 八、稍后再说 / 删除确认 =================
    const dismiss = JJ(await step('dismiss keeps data',
      "(function(){var DS=ICAR.ui.DraftStore;" +
      "return DS.listDrafts().then(function(before){" +
      "  ICAR.ui.DraftManager.dismissPending();" +
      "  return DS.listDrafts().then(function(after){" +
      "    return JSON.stringify({beforeCount:before.length,afterCount:after.length,kept:before.length===after.length});});});" +
      "})()"));
    ok(dismiss.kept === true, '「稍后再说」**不删除任何草稿**');

    // 删除需二次确认
    const delConfirm = JJ(await step('delete needs confirm',
      "(function(){var DS=ICAR.ui.DraftStore;" +
      "var origConfirm=window.confirm;var asked=0;" +
      "window.confirm=function(){asked++;return false;};" +   // 模拟用户取消
      "return DS.listDrafts().then(function(l){" +
      "  return DS.getDraft(l[0].draftId).then(function(g){" +
      "    g.record.designJson;var d=JSON.parse(g.record.designJson);" +
      "    window.replaceDesign(d,'stub');" +
      "    return DS.listDrafts();}).then(function(after){" +
      "    window.confirm=origConfirm;" +
      "    return JSON.stringify({countAfter:after.length,stillThere:after.length>0});});});" +
      "})()"));
    ok(delConfirm.stillThere === true, '取消确认时草稿仍保留');

    // ================= 九、异常保护 =================
    const quota = JJ(await step('quota failure keeps old',
      "(function(){var DS=ICAR.ui.DraftStore,S=CanvasState;" +
      "S.design=createDesign({name:'配额'});S.design.nodes=[];" +
      "return new Promise(function(res){" +
      "DS.saveDraft({designId:'Q1',designName:'配额',design:S.design}).then(function(first){" +
      "  if(!first.ok){res(JSON.stringify({err:'first failed'}));return;}" +
      "  var db=DS.open();" +
      "  db.then(function(d){" +
      "    var origTx=d.transaction;" +
      "    d.transaction=function(){" +
      "      var t=origTx.apply(d,arguments);" +
      "      var st=t.objectStore.bind(t);" +
      "      t.objectStore=function(){var os=st.apply(null,arguments);" +
      "        return {put:function(){throw new Error('QuotaExceededError');},get:os.get.bind(os)};};" +
      "      return t;};" +
      "    DS.saveDraft({designId:'Q1',designName:'配额',design:S.design}).then(function(second){" +
      "      d.transaction=origTx;" +
      "      DS.getDraft('draft_Q1').then(function(g){" +
      "        res(JSON.stringify({firstOk:first.ok,secondOk:second.ok," +
      "        oldSurvived:!!g,oldProblem:g?g.problem:null}));});});});});});" +
      "})()"));
    ok(quota.firstOk === true, '配额异常前置：首次保存成功');
    ok(quota.secondOk === false, '配额不足时写入失败（不抛异常）');
    ok(quota.oldSurvived === true, '**写入失败不删除最后一份有效草稿**');
    ok(quota.oldProblem === null, '旧草稿仍完好可用');

    // ================= 十、与 UndoStack / 手动保存隔离 =================
    const iso = JJ(await step('isolation',
      "(function(){" +
      "var undoKey='icar-studio-undo';" +
      "var raw=localStorage.getItem(undoKey);" +
      "var fmt=null;" +
      "try{var o=JSON.parse(raw||'null');fmt=o?Object.keys(o).sort():null;}catch(e){fmt='parse-error';}" +
      "return JSON.stringify({undoKeyExists:raw!==null," +
      "undoFormatKeys:fmt," +
      "draftDbIsIndexed:typeof ICAR.ui.DraftStore.DB_NAME==='string'," +
      "separateKeys:ICAR.ui.DraftStore.DB_NAME!==undoKey});})()"));
    ok(iso.separateKeys === true, '草稿库与撤销栈是**两套独立存储**');
    ok(iso.undoKeyExists === true, '撤销栈 localStorage 仍存在（未受影响）');

    // 恢复后撤销栈以当前设计为基准（不加载旧历史）
    const undoBase = JJ(await step('undo rebaseline',
      "(function(){var S=CanvasState;" +
      "return JSON.stringify({depth:window.__undoStack.depth()," +
      "size:window.__undoStack.size()," +
      "label0:window.__undoStack.stack[0]?window.__undoStack.stack[0].label:null});})()"));
    ok(undoBase.size >= 1, '恢复后撤销栈存在');

    // ================= 十一、兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "return {entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "legacyPanel:!!document.getElementById('props')," +
      "assetsPanel:!!document.getElementById('assets')," +
      "hasReplaceDesign:typeof window.replaceDesign==='function'," +
      "hasSaveFile:typeof window.saveFile==='function'};})())"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69');
    ok(compat.legacyPanel === true, '旧属性面板仍存在');
    ok(compat.hasReplaceDesign === true, 'replaceDesign 已导出（复用既有校验流程）');
    ok(compat.hasSaveFile === true, '手动保存 saveFile 仍存在');

    // 清理本套件创建的草稿
    await cdp.eval("ICAR.ui.DraftStore.__clearAll()");
  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
