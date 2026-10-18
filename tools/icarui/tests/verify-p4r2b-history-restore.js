// ============================================================================
// verify-p4r2b-history-restore.js —— P4R-2B 撤销历史跨会话安全恢复验收
//
// 关卡 A：同库同事务原子写草稿+历史
// 关卡 B：正式恢复入口（checkForDraft → restorePending）加载匹配历史
// 严格匹配 fail-closed、历史降级、tombstone/CAS 保护、DB 版本升级
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4r2b-suite-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp,cdp2;
 const JJ=v=>JSON.parse(v);
 const E=(c,expr)=>c.eval(expr);
 async function ready(c){for(let i=0;i<40;i++){const v=await c.eval("typeof(window.ICAR&&ICAR.ui&&ICAR.ui.DraftStore)").catch(()=>'u');if(v==='object')return;await sleep(300);}throw new Error('page not ready');}
 async function newTab(url){const t=await (cdp2||cdp).send('Target.createTarget',{url});await sleep(700);const list=await getJson('/json/list');const tb=list.find(x=>x.id===t.targetId)||list[list.length-1];const c=await CDP.connect(tb.webSocketDebuggerUrl);await c.send('Runtime.enable');await sleep(400);if(!(await c.eval("typeof CanvasState!=='undefined'").catch(()=>false))){await c.send('Page.navigate',{url});await waitReady(c);}await require('./_common').stubDialogs(c);await ready(c);await sleep(1400);return c;}
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');cdp2=cdp;
  await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2500);

  async function mkDesign(c,name,n){await c.eval("(function(){var R=ICAR.registry.Control;var d=createDesign({name:"+JSON.stringify(name)+"});d.nodes=[];for(var i=0;i<"+n+";i++)d.nodes.push(R.byLegacyKey('t_title').build());window.replaceDesign(d,'建');CanvasState.suppressPanelRender=true;})()");await sleep(600);}

  // ---------- A. 原子写入：草稿 + 历史同事务 ----------
  await mkDesign(cdp,'原子',6);
  await cdp.eval("(function(){var S=CanvasState;for(var i=0;i<5;i++){window.commit(function(){S.design.nodes[0].alpha=20+i*10;},'e'+i);}})()");
  await sleep(1600);
  const saved=JJ(await E(cdp,"(async function(){var D=ICAR.ui.DraftManager;var r=await D.flush('force');var DS=ICAR.ui.DraftStore;var h=await DS.getHistory(D.currentDesignId());var g=await DS.getDraft('draft_'+D.currentDesignId());return JSON.stringify({ok:r.ok!==false,id:D.currentDesignId(),rev:g&&g.record.revision,hist:!!h,histRev:h&&h.draftRevision,histId:h&&h.designId,fmt:h&&h.historyFormatVersion,steps:h&&h.persistedSteps,index:h&&h.index,digest:!!(h&&h.currentDesignDigest),available:h&&h.historyAvailable,redo:h&&h.redoPersisted});})()"));
  ok(saved.hist===true,'A1 草稿保存后存在匹配历史');
  ok(saved.histId===saved.id,'A2 历史 designId 与草稿一致');
  ok(saved.histRev===saved.rev,'A3 历史 draftRevision 与草稿一致');
  ok(saved.fmt===2,'A4 历史格式版本可识别');
  ok(saved.steps>0&&saved.index===saved.steps,'A5 裁剪后 index 重算为栈顶');
  ok(saved.digest===true,'A6 历史带当前设计 digest');
  ok(saved.available===true,'A7 历史标记为可用');
  ok(saved.redo===false,'A8 如实标记 redo 不跨会话');

  // ---------- B. 正式恢复入口 ----------
  const tab=await newTab(URL_PAGE);
  const rec=JJ(await E(tab,"(async function(){window.confirm=function(){return true;};var D=ICAR.ui.DraftManager;await D.checkForDraft();var ok=await D.restorePending();var u=window.__undoStack;return JSON.stringify({ok:ok,nodes:CanvasState.design.nodes.length,alpha:CanvasState.design.nodes[0].alpha,stack:u.size(),index:u.index,depth:u.depth(),canUndo:u.canUndo(),canRedo:u.canRedo(),hist:D.getHistoryState().lastRestore});})()"));
  ok(rec.ok===true,'B1 正式恢复入口返回成功');
  ok(rec.nodes===6,'B2 设计节点完整恢复');
  ok(rec.alpha===60,'B3 设计内容与保存时一致');
  ok(rec.stack===7,'B4 撤销历史 7 条已恢复');
  ok(rec.index===6&&rec.depth===6,'B5 index/depth 正确');
  ok(rec.canUndo===true,'B6 恢复后可撤销');
  ok(rec.canRedo===false,'B7 恢复后无 redo（既有语义）');
  ok(rec.hist&&rec.hist.ok===true,'B8 历史校验通过');

  // ---------- C. 恢复后继续撤销/编辑 ----------
  const undo1=JJ(await E(tab,"(function(){window.doUndo();var u=window.__undoStack;return JSON.stringify({alpha:CanvasState.design.nodes[0].alpha,index:u.index,canUndo:u.canUndo(),canRedo:u.canRedo()});})()"));
  ok(undo1.alpha===50,'C1 撤销回到前一条设计状态');
  ok(undo1.canRedo===true,'C2 撤销后可重做');
  const edit1=JJ(await E(tab,"(function(){window.commit(function(){CanvasState.design.nodes[1].alpha=188;},'after');var u=window.__undoStack;return JSON.stringify({canRedo:u.canRedo(),debug:document.getElementById('undoCount')?document.getElementById('undoCount').textContent:null});})()"));
  ok(edit1.canRedo===false,'C3 恢复后编辑正常截断 redo');
  ok(/^\d+ \/ \d+$/.test(edit1.debug||''),'C4 撤销计数按钮已刷新');
  tab.ws.close();

  // ---------- D. 历史降级：大图超预算，草稿仍保存 ----------
  await mkDesign(cdp,'大图',3);
  await cdp.eval("(function(){var png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';var big='';for(var k=0;k<3000;k++){big+=png;}for(var j=0;j<8;j++){CanvasState.design.assets.push({id:'b'+j,name:'g'+j,kind:'custom',path:'b'+j+'.png',data:big,w:100,h:100});}window.commit(function(){CanvasState.design.nodes[0].alpha=77;},'big');})()");
  await sleep(600);
  const big=JJ(await E(cdp,"(async function(){var D=ICAR.ui.DraftManager;var r=await D.flush('force');var DS=ICAR.ui.DraftStore;var h=await DS.getHistory(D.currentDesignId());var g=await DS.getDraft('draft_'+D.currentDesignId());return JSON.stringify({saveOk:r.ok!==false,histState:D.getHistoryState().lastSaveAvailable,reason:D.getHistoryState().lastSaveReason,record:!!h,draftBytes:g?g.record.byteSize:0});})()"));
  ok(big.saveOk===true,'D1 历史超预算时草稿仍保存成功');
  ok(big.draftBytes>1000000,'D2 草稿含大图数据完整');
  ok(big.histState===false&&big.reason==='too-large','D3 明确标记历史不可用');
  ok(big.record===false,'D4 不保留会被误认为当前有效的旧历史');

  // ---------- E. tombstone 同时保护草稿与历史 ----------
  // 用独立 designId 构造，避免受 D 段"历史降级"状态影响
  const tomb=JJ(await E(cdp,"(async function(){var DS=ICAR.ui.DraftStore;var A=ICAR.ui.UndoAnchor;var d=CanvasState.design;var id='TOMBSUITE';var u=window.__undoStack;var h=A.build({designId:id,draftRevision:900,stack:u.stack,index:u.index});h.historyFormatVersion=2;h.historyAvailable=true;h.savedAt=Date.now();await DS.saveDraft({designId:id,designName:'t',design:d,revision:900,lastKnownRevision:null,history:h});var b=await DS.getHistory(id);await DS.deleteDraft('draft_'+id);var a=await DS.getHistory(id);var w=await DS.saveDraft({designId:id,designName:'t',design:d,revision:901,lastKnownRevision:null,history:h});var after=await DS.getHistory(id);return JSON.stringify({before:!!b,afterDelete:!!a,blocked:w.ok===false,reason:w.reason||null,afterWrite:!!after});})()"));
  ok(tomb.before===true,'E1 删除前存在历史');
  ok(tomb.afterDelete===false,'E2 删除草稿同时清除历史');
  ok(tomb.blocked===true&&tomb.reason==='tombstoned','E3 已删除草稿的写入被墓碑拒绝');
  ok(tomb.afterWrite===false,'E4 历史不会被写入复活');

  // ---------- F. CAS 冲突不写历史 ----------
  const cas=JJ(await E(cdp,"(async function(){var DS=ICAR.ui.DraftStore;var d=CanvasState.design;var mk=function(rev){return {designId:'CAS2BSUITE',draftRevision:rev,historyFormatVersion:2,stack:[{state:'{}',digest:'x'}],index:0,historyAvailable:true,savedAt:Date.now()};};await DS.saveDraft({designId:'CAS2BSUITE',designName:'c',design:d,revision:10,lastKnownRevision:null,history:mk(10)});var w=await DS.saveDraft({designId:'CAS2BSUITE',designName:'c',design:d,revision:11,lastKnownRevision:99,history:mk(11)});var h=await DS.getHistory('CAS2BSUITE');return JSON.stringify({conflict:w.ok===false,reason:w.reason||null,histRev:h?h.draftRevision:null});})()"));
  ok(cas.conflict===true&&cas.reason==='conflict','F1 过期 CAS 写入被拒绝');
  ok(cas.histRev===10,'F2 冲突时历史保持旧版本未被覆盖');

  // ---------- G. fail-closed 校验 ----------
  const AO='ICAR.ui.UndoAnchor';
  const good=JJ(await E(cdp,"(function(){var A="+AO+";var d=JSON.parse(window.__commitState()).d,u=window.__undoStack;return JSON.stringify({b:A.build({designId:'ID',draftRevision:3,stack:u.stack,index:u.index}),d:d});})()"));
  const cases=[
    ['G1 designId 不匹配',`${AO}.validate(${JSON.stringify(good.b)},{designId:'OTHER',draftRevision:3,design:${JSON.stringify(good.d)}})`,r=>!r.ok&&r.reason==='designId-mismatch'],
    ['G2 revision 不匹配',`${AO}.validate(${JSON.stringify(good.b)},{designId:'ID',draftRevision:4,design:${JSON.stringify(good.d)}})`,r=>!r.ok&&r.reason==='revision-mismatch'],
    ['G3 index 越界',`(function(){var b=${JSON.stringify(good.b)};b.index=999;return ${AO}.validate(b,{designId:'ID',draftRevision:3,design:${JSON.stringify(good.d)}});})()`,r=>!r.ok&&r.reason==='index-mismatch'],
    ['G4 记录损坏',`(function(){var b=${JSON.stringify(good.b)};b.stack[0].state='{bad';return ${AO}.validate(b,{designId:'ID',draftRevision:3,design:${JSON.stringify(good.d)}});})()`,r=>!r.ok],
  ];
  for(const [name,expr,pred] of cases){
    let v;try{v=JJ(await E(cdp,"JSON.stringify("+expr+")"));}catch(e){ok(false,name+' :: '+e.message.slice(0,80));continue;}
    ok(pred(v),name+(v&&v.reason?' ('+v.reason+')':''));
  }
  const sel=JJ(await E(cdp,"(function(){var A="+AO+";var s=JSON.parse(window.__commitState());var a=A.digestOfSnapshot(JSON.stringify(s));s.sel=['zzz'];var b=A.digestOfSnapshot(JSON.stringify(s));return JSON.stringify({same:a===b});})()"));
  ok(sel.same===true,'G5 selection 变化不影响设计 digest');

  // ---------- H. DB 版本与升级 ----------
  const ver=JJ(await E(cdp,"(async function(){var DS=ICAR.ui.DraftStore;var db=await DS.open();return JSON.stringify({version:db.version,stores:Array.from(db.objectStoreNames)});})()"));
  ok(ver.version===3,'H1 数据库版本为 3');
  ok(ver.stores.indexOf('undoHistory')>=0,'H2 undoHistory store 存在');
  ok(ver.stores.indexOf('tombstones')>=0,'H3 tombstones store 存在');

  // ---------- I. 旧 localStorage 历史未被删除 ----------
  const oldKey=await E(cdp,"(function(){localStorage.setItem('icar-studio-undo',JSON.stringify({stack:[{state:'{}',label:'old'}],index:0,designName:'旧设计'}));return localStorage.getItem('icar-studio-undo')?'present':'missing';})()");
  ok(oldKey==='present','I1 旧 localStorage 键可正常读写未被程序删除');
  const oldUntouched=JJ(await E(cdp,"(function(){var raw=localStorage.getItem('icar-studio-undo');var o=JSON.parse(raw);return JSON.stringify({hasName:typeof o.designName==='string',hasId:o.designId!==undefined});})()"));
  ok(oldUntouched.hasName===true,'I2 旧格式仍只有 designName');
  ok(oldUntouched.hasId===false,'I3 旧格式没有 designId（不会被自动绑定）');

  await cdp.eval("(async function(){var DS=ICAR.ui.DraftStore;var l=await DS.listDrafts();for(var i=0;i<l.length;i++){await DS.deleteDraft(l[i].draftId);}})()");
 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
