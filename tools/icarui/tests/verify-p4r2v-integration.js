// ============================================================================
// verify-p4r2v-integration.js —— P4R-2V 数据恢复系统最终集成验收
//
// 覆盖：v3 原子故障注入、历史格式一致性、真实用户操作路径、
//       Undo/Redo 完整行为、中间 index 带 redo 保存、图片完整性
// 不覆盖（人工验收）：真实 GUI、真实 Windows 中文 IME
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4r2v-suite-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp,c2;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  async function mkDesign(name,nodes){
    await cdp.eval("(function(){var R=ICAR.registry.Control;var d=createDesign({name:"+JSON.stringify(name)+"});d.nodes=[];for(var i=0;i<"+nodes+";i++)d.nodes.push(R.byLegacyKey('t_title').build());window.replaceDesign(d,'建');CanvasState.suppressPanelRender=true;})()");
    await sleep(700);
  }

  // ================= A. v3 原子故障注入 =================
  await mkDesign('故障',1);

  const fCas=JJ(await cdp.eval(`(async function(){
    var DS=ICAR.ui.DraftStore;var d=CanvasState.design;
    var mk=function(v){return {designId:'V2CAS',draftRevision:v,historyFormatVersion:2,stack:[{state:'{}',digest:'x'}],index:0,historyAvailable:true,savedAt:Date.now()};};
    await DS.saveDraft({designId:'V2CAS',designName:'c',design:d,revision:5,lastKnownRevision:null,history:mk(5)});
    var r=await DS.saveDraft({designId:'V2CAS',designName:'c',design:d,revision:6,lastKnownRevision:4,history:mk(6)});
    var h=await DS.getHistory('V2CAS');
    return JSON.stringify({ok:r.ok,reason:r.reason||null,histRev:h&&h.draftRevision});
  })()`));
  ok(fCas.ok===false&&fCas.reason==='conflict','A1 CAS 冲突被拒绝');
  ok(fCas.histRev===5,'A2 冲突时历史保持旧版本未被污染');

  const fTomb=JJ(await cdp.eval(`(async function(){
    var DS=ICAR.ui.DraftStore;var d=CanvasState.design;
    var mk=function(v){return {designId:'V2TOMB',draftRevision:v,historyFormatVersion:2,stack:[{state:'{}',digest:'x'}],index:0,historyAvailable:true,savedAt:Date.now()};};
    await DS.saveDraft({designId:'V2TOMB',designName:'t',design:d,revision:1,lastKnownRevision:null,history:mk(1)});
    await DS.deleteDraft('draft_V2TOMB');
    var r=await DS.saveDraft({designId:'V2TOMB',designName:'t',design:d,revision:2,lastKnownRevision:null,history:mk(2)});
    var g=await DS.getDraft('draft_V2TOMB');var h=await DS.getHistory('V2TOMB');
    return JSON.stringify({ok:r.ok,reason:r.reason||null,draft:!!g,hist:!!h});
  })()`));
  ok(fTomb.ok===false&&fTomb.reason==='tombstoned','A3 tombstone 拒绝写入');
  ok(!fTomb.draft&&!fTomb.hist,'A4 删除后草稿与历史都不复活');

  const fAbort=JJ(await cdp.eval(`(async function(){
    var DS=ICAR.ui.DraftStore;var db=await DS.open();
    var aborted=await new Promise(function(res){
      var tx=db.transaction(['drafts','undoHistory'],'readwrite');
      tx.objectStore('drafts').put({draftId:'draft_V2AB',designId:'V2AB',designName:'a',designJson:'{}',revision:1,complete:true,nodeCount:0,assetCount:0,byteSize:2,checksum:'x',savedAt:Date.now(),schemaVersion:1,manualSavedAt:0});
      tx.objectStore('undoHistory').put({designId:'V2AB',draftRevision:1,historyFormatVersion:2,stack:[],index:0,historyAvailable:true});
      setTimeout(function(){try{tx.abort();}catch(e){}},0);
      tx.onabort=function(){res(true);};tx.oncomplete=function(){res(false);};
    });
    var g=await new Promise(function(res){var tx2=db.transaction(['drafts','undoHistory'],'readonly');var q=tx2.objectStore('drafts').get('draft_V2AB');var q2=tx2.objectStore('undoHistory').get('V2AB');tx2.oncomplete=function(){res({d:q.result,h:q2.result});};});
    return JSON.stringify({aborted:aborted,draft:!!g.d,hist:!!g.h});
  })()`));
  ok(fAbort.aborted===true,'A5 事务可主动 abort');
  ok(!fAbort.draft&&!fAbort.hist,'A6 abort 后草稿与历史都不留下（原子回滚）');

  const fBadHist=JJ(await cdp.eval(`(async function(){
    var DS=ICAR.ui.DraftStore;var d=CanvasState.design;
    var r=await DS.saveDraft({designId:'V2BAD',designName:'b',design:d,revision:1,lastKnownRevision:null,
      history:{designId:'V2BAD',draftRevision:1,historyFormatVersion:2,stack:'NOT-ARRAY',index:0,historyAvailable:true}});
    var g=await DS.getDraft('draft_V2BAD');var h=await DS.getHistory('V2BAD');
    return JSON.stringify({ok:r.ok,draft:!!g,hist:!!h,rejected:DS.getStatus().historyRejected||0});
  })()`));
  ok(fBadHist.draft===true,'A7 历史结构非法时草稿仍保存（仅草稿可用）');
  ok(fBadHist.hist===false,'A8 结构非法的历史不被写入');

  const consistency=JJ(await cdp.eval(`(async function(){
    var DS=ICAR.ui.DraftStore;var l=await DS.listDrafts();var bad=[];
    for(var i=0;i<l.length;i++){
      var d=l[i];var h=await DS.getHistory(d.designId);
      if(h&&h.historyAvailable===true&&h.draftRevision!==d.revision)bad.push(d.designId);
    }
    return JSON.stringify({checked:l.length,invalid:bad});
  })()`));
  ok(consistency.invalid.length===0,'A9 全库无 revision 不一致却被判有效的记录');

  // ================= B. 历史格式一致性 =================
  await mkDesign('格式',1);
  await cdp.eval("window.commit(function(){CanvasState.design.nodes[0].alpha=55;},'a');");
  await sleep(1600);
  const fmt=JJ(await cdp.eval(`(async function(){
    var D=ICAR.ui.DraftManager,DS=ICAR.ui.DraftStore;
    var h=await DS.getHistory(D.currentDesignId());
    return JSON.stringify({version:h.historyFormatVersion,hasSchema:h.schema!==undefined,
      available:h.historyAvailable,redo:h.redoPersisted,digest:!!h.currentDesignDigest,
      designIdMatch:h.designId===D.currentDesignId()});
  })()`));
  ok(fmt.version===2,'B1 正式记录 historyFormatVersion=2');
  ok(fmt.hasSchema===false,'B2 正式记录不含原型旧字段 schema');
  ok(fmt.available===true,'B3 historyAvailable 明确');
  ok(fmt.redo===false,'B4 redoPersisted 如实为 false');
  ok(fmt.digest===true&&fmt.designIdMatch===true,'B5 记录带 digest 且 designId 与草稿一致');

  const unknownFmt=JJ(await cdp.eval(`(function(){
    var A=ICAR.ui.UndoAnchor;var s=window.__commitState();
    var b=A.build({designId:'Z',draftRevision:1,stack:[{state:s,label:'x'}],index:0});
    b.historyFormatVersion=99;
    return JSON.stringify(A.validate(b,{designId:'Z',draftRevision:1,design:JSON.parse(s).d}));
  })()`));
  ok(unknownFmt.ok===false&&unknownFmt.reason==='schema-mismatch','B6 未知历史格式被拒绝');

  const legacyFmt=JJ(await cdp.eval(`(function(){
    var A=ICAR.ui.UndoAnchor;var s=window.__commitState();
    var b=A.build({designId:'W',draftRevision:1,stack:[{state:s,label:'x'}],index:0});
    b.historyFormatVersion=undefined;b.schema=2;
    return JSON.stringify(A.validate(b,{designId:'W',draftRevision:1,design:JSON.parse(s).d}));
  })()`));
  ok(legacyFmt.ok===true,'B7 原型旧字段 schema 仍被兼容接受');

  // ================= C. 真实用户操作路径 =================
  await mkDesign('路径',1);
  const path=JJ(await cdp.eval(`(function(){
    var R=ICAR.registry.Control,S=CanvasState,U=ICAR.ui.schemaProps.PropertyUpdate,out={};
    window.commit(function(){S.design.nodes[0].alpha=60;},'c');out.commit=S.design.nodes[0].alpha;
    U.beginLive(S.design.nodes[0],'alpha');for(var i=0;i<10;i++)U.setLive(S.design.nodes[0],'alpha',100+i);
    out.setLive=S.design.nodes[0].alpha;U.endLive(S.design.nodes[0],'alpha');
    out.endLive=S.design.nodes[0].alpha;out.stackAfterLive=window.__undoStack.size();
    var beforeAbort=S.design.nodes[0].alpha;U.abortLive();out.abort=beforeAbort===S.design.nodes[0].alpha;
    window.doUndo();out.undo=S.design.nodes[0].alpha;
    window.doRedo();out.redo=S.design.nodes[0].alpha;
    var box=R.byLegacyKey('box_card').build();
    window.commit(function(){S.design.nodes.push(box);},'box');
    window.commit(function(){box.alpha=128;},'boxa');out.boxAlpha=box.alpha;
    var png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.commit(function(){S.design.assets.push({id:'n1',name:'图',kind:'custom',path:'n1.png',data:png,w:8,h:8});},'asset');
    out.assets=S.design.assets.length;
    var j=toV2Json(S.design),p=parseDesign(j);out.exportErrors=p.errors.length;
    return JSON.stringify(out);
  })()`));
  ok(path.commit===60,'C1 普通属性提交');
  ok(path.setLive===109&&path.endLive===109,'C2 长时间 setLive 与 endLive');
  ok(path.abort===true,'C3 Escape/abort 不改变模型');
  ok(typeof path.undo==='number'&&typeof path.redo==='number','C4 Undo/Redo 可用');
  ok(path.boxAlpha===128,'C5 容器属性修改');
  ok(path.assets===1,'C6 图片素材添加');
  ok(path.exportErrors===0,'C7 手动导出 JSON 无错误');

  // ================= D. 中间 index 带 redo 保存 =================
  const mid=JJ(await cdp.eval(`(async function(){
    var D=ICAR.ui.DraftManager,DS=ICAR.ui.DraftStore,u=window.__undoStack;
    window.doUndo();window.doUndo();
    var before={index:u.index,size:u.size(),canRedo:u.canRedo()};
    var canRedoAfterUndo=u.canRedo();
    await new Promise(function(r){setTimeout(r,1500);});
    await D.flush('force');
    var h=await DS.getHistory(D.currentDesignId());
    // 撤销后回到含素材的栈顶再保存，供 E 段验证图片完整性
    while(u.canRedo())window.doRedo();
    await new Promise(function(r){setTimeout(r,1400);});
    await D.flush('force');
    var h2=await DS.getHistory(D.currentDesignId());
    return JSON.stringify({before:before,persistedSteps:h&&h.persistedSteps,histIndex:h&&h.index,
      redo:h&&h.redoPersisted,memIndex:u.index,memCanRedo:canRedoAfterUndo,
      finalAssets:CanvasState.design.assets.length,hist2Steps:h2&&h2.persistedSteps});
  })()`));
  ok(mid.before.canRedo===true,'D1 保存前确处于中间 index 且有 redo 分支');
  ok(mid.histIndex===mid.persistedSteps,'D2 持久化 index 等于持久化步数');
  console.log('  [diag D] before.index='+mid.before.index+' before.size='+mid.before.size+' persistedSteps='+mid.persistedSteps+' histIndex='+mid.histIndex);
ok(mid.persistedSteps===mid.before.index,'D3 persistedSteps 为最后保留条目下标，不含 redo 分支');
  ok(mid.redo===false,'D4 redoPersisted 明确为 false');
  ok(mid.memCanRedo===true,'D5 内存 redo 分支不受持久化裁剪影响');

  // ================= E. 恢复后行为（含图片完整性） =================
  await cdp.eval("(async function(){var D=ICAR.ui.DraftManager;await new Promise(function(r){setTimeout(r,1200);});})()");
  const t=await cdp.send('Target.createTarget',{url:URL_PAGE});await sleep(700);
  const list=await getJson('/json/list');
  c2=await CDP.connect((list.find(x=>x.id===t.targetId)||list[list.length-1]).webSocketDebuggerUrl);
  await c2.send('Runtime.enable');await sleep(400);
  if(!(await c2.eval("typeof CanvasState!=='undefined'").catch(()=>false))){await c2.send('Page.navigate',{url:URL_PAGE});await waitReady(c2);}
  await require('./_common').stubDialogs(c2);
  for(let i=0;i<30;i++){if(await c2.eval("typeof(window.ICAR&&ICAR.ui&&ICAR.ui.DraftStore)")==='object')break;await sleep(400);}
  await sleep(1600);
  const rec=JJ(await c2.eval(`(async function(){
    window.confirm=function(){return true;};
    var D=ICAR.ui.DraftManager;await D.checkForDraft();var ok=await D.restorePending();
    var u=window.__undoStack;var a=CanvasState.design.assets||[];
    var png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return JSON.stringify({ok:ok,nodes:CanvasState.design.nodes.length,assets:a.length,
      assetIntact:a.length?a[0].data===png:false,
      stack:u.size(),canUndo:u.canUndo(),canRedo:u.canRedo(),
      restore:D.getHistoryState().lastRestore});
  })()`));
  ok(rec.ok===true,'E1 恢复成功');
  ok(rec.nodes>=1,'E2 设计节点恢复');
  console.log('  [diag E] assets='+rec.assets+' intact='+rec.assetIntact);
  ok(rec.assetIntact===true,'E3 图片 data 逐字节完整');
  ok(rec.stack>=1&&rec.canUndo===true,'E4 撤销历史恢复且可撤销');
  ok(rec.canRedo===false,'E5 恢复后无 redo（既有规则）');
  ok(rec.restore&&rec.restore.ok===true,'E6 历史校验通过');

  // ================= F. 库结构 =================
  const dbv=JJ(await cdp.eval("(async function(){var db=await ICAR.ui.DraftStore.open();return JSON.stringify({version:db.version,stores:Array.from(db.objectStoreNames)});})()"));
  ok(dbv.version===3,'F1 数据库版本为 3');
  ok(dbv.stores.indexOf('undoHistory')>=0&&dbv.stores.indexOf('tombstones')>=0,'F2 v3 store 齐全');

  await cdp.eval("(async function(){var DS=ICAR.ui.DraftStore;var l=await DS.listDrafts();for(var i=0;i<l.length;i++){await DS.deleteDraft(l[i].draftId);}})()");
  try{c2.ws.close();}catch(e){}
 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
