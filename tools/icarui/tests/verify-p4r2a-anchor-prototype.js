// ============================================================================
// P4R-2A isolated UndoHistory anchor prototype tests.
// Does NOT load localStorage history or call loadUndoStack.
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4r2a-anchor-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});let cdp;
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2500);
  async function check(name,expr,predicate,detail){let r;try{r=await cdp.eval(expr);const v=typeof r==='string'?JSON.parse(r):r;ok(predicate(v),name+(detail?' '+detail(v):''));}catch(e){ok(false,name+' :: '+String(e.message).slice(0,140));}}
  const U='ICAR.ui.UndoAnchor';
  await cdp.eval("(function(){var R=ICAR.registry.Control;var d=createDesign({name:'p4r2a'});d.nodes=[];for(var i=0;i<8;i++)d.nodes.push(R.byLegacyKey('t_title').build());window.replaceDesign(d,'base');window.commit(function(){CanvasState.design.nodes[0].alpha=10;},'edit');})()");await sleep(350);
  ok(await cdp.eval('typeof ICAR.ui.UndoAnchor')==='object','isolated anchor prototype loaded');
  // 1 首次编辑/可算锚点
  await check('1 first edit digest',`(function(){var s=JSON.parse(window.__commitState());return JSON.stringify({d:!!s.d,digest:${U}.designDigest(s.d)});})()`,x=>x.d&&/^[0-9a-f]{8}$/.test(x.digest));
  // 2 十次普通编辑增长
  const n0=Number(await cdp.eval('window.__undoStack.size()'));
  await cdp.eval("(function(){for(var i=0;i<10;i++){window.commit(function(){CanvasState.design.nodes[i%8].alpha=30+i;},'n'+i);}})()");
  ok(Number(await cdp.eval('window.__undoStack.size()'))>=n0+10,'2 ten ordinary commits create history steps');
  // 3 live input compacts to one record
  const n3=Number(await cdp.eval('window.__undoStack.size()'));
  await cdp.eval("(function(){var U=ICAR.ui.schemaProps.PropertyUpdate,n=CanvasState.design.nodes[2];U.beginLive(n,'alpha');for(var i=0;i<15;i++)U.setLive(n,'alpha',40+i);U.endLive(n,'alpha');})()");
  ok(Number(await cdp.eval('window.__undoStack.size()'))===n3+1,'3 live input is one undo step');
  // 4 drag coalesce
  const n4=Number(await cdp.eval('window.__undoStack.size()'));
  await cdp.eval("(function(){var n=CanvasState.design.nodes[3];for(var i=0;i<20;i++)window.commit(function(){n.x=i;},'drag','drag-4');window.__undoStack.endCoalesce();})()");
  ok(Number(await cdp.eval('window.__undoStack.size()'))===n4+1,'4 drag coalesces to one step');
  // 5 undo redo round trip
  const i5=Number(await cdp.eval('String(window.__undoStack.index)'));await cdp.eval('window.doUndo();');await sleep(100);const u5=Number(await cdp.eval('String(window.__undoStack.index)'));await cdp.eval('window.doRedo();');await sleep(100);const r5=Number(await cdp.eval('String(window.__undoStack.index)'));
  ok(u5===i5-1&&r5===i5,'5 undo then redo restores index');
  // 6 undo retains redo branch
  await cdp.eval('window.doUndo();window.doUndo();');await sleep(100);ok(await cdp.eval('window.__undoStack.canRedo()'),'6 undo leaves redo branch');
  // 7 edit after undo truncates redo
  await cdp.eval("window.commit(function(){CanvasState.design.nodes[5].alpha=177;},'branch');");ok(!(await cdp.eval('window.__undoStack.canRedo()')),'7 edit after undo truncates redo');
  // 8 memory and persistence budgets
  await cdp.eval("(function(){for(var i=0;i<120;i++)window.commit(function(){CanvasState.design.nodes[i%8].alpha=i;},'budget'+i);})()");await sleep(400);
  const q8=JSON.parse(await cdp.eval("(function(){var r=localStorage.getItem('icar-studio-undo');return JSON.stringify({memory:window.__undoStack.stack.length,persisted:r?JSON.parse(r).stack.length:0,bytes:r?r.length:0});})()"));
  ok(q8.memory<=101&&q8.persisted<=40&&q8.bytes<=1200*1024,'8 history budget caps',JSON.stringify(q8));
  // 9 same name different content digest
  await check('9 same name different design digest',`(function(){var A=${U};var a=createDesign({name:'same'});a.nodes=[ICAR.registry.Control.byLegacyKey('t_title').build()];var b=createDesign({name:'same'});b.nodes=[ICAR.registry.Control.byLegacyKey('t_label').build()];return JSON.stringify({sameName:a.name===b.name,different:A.designDigest(a)!==A.designDigest(b)});})()`,x=>x.sameName&&x.different);
  // base good bundle
  const bundleExpr=`(function(){var A=${U},id='ID-A',d=JSON.parse(window.__commitState()).d,u=window.__undoStack;return JSON.stringify({b:A.build({designId:id,draftRevision:4,stack:u.stack,index:u.index}),d:d});})()`;
  const baseObj=JSON.parse(await cdp.eval(bundleExpr));
  // 10 designId mismatch
  await check('10 designId mismatch rejected',`(function(){var b=${JSON.stringify(baseObj.b)},d=${JSON.stringify(baseObj.d)};return JSON.stringify(${U}.validate(b,{designId:'ID-B',draftRevision:4,design:d}));})()`,x=>!x.ok&&x.reason==='designId-mismatch');
  // 11 revision mismatch
  await check('11 draft revision mismatch rejected',`(function(){var b=${JSON.stringify(baseObj.b)},d=${JSON.stringify(baseObj.d)};return JSON.stringify(${U}.validate(b,{designId:'ID-A',draftRevision:5,design:d}));})()`,x=>!x.ok&&x.reason==='revision-mismatch');
  // 12 content mismatch
  await check('12 current content mismatch rejected',`(function(){var b=${JSON.stringify(baseObj.b)},d=${JSON.stringify(baseObj.d)};d.nodes[0].alpha=250;return JSON.stringify(${U}.validate(b,{designId:'ID-A',draftRevision:4,design:d}));})()`,x=>!x.ok&&x.reason==='current-mismatch');
  // 13 corrupt any history record (including redo) rejects full bundle
  await check('13 any damaged history record rejects bundle',`(function(){var b=${JSON.stringify(baseObj.b)},d=${JSON.stringify(baseObj.d)};var k=(b.index<b.stack.length-1)?b.index+1:Math.max(0,b.index-1);b.stack[k].state='{bad';return JSON.stringify(${U}.validate(b,{designId:'ID-A',draftRevision:4,design:d}));})()`,x=>!x.ok&&(x.reason==='bad-record'||x.reason==='record-digest-mismatch'));
  // 14 draft exists, no history
  await check('14 draft without history rejected safely',`(function(){return JSON.stringify(${U}.validate(null,{designId:'ID-A',draftRevision:4,design:{}}));})()`,x=>!x.ok&&x.reason==='empty');
  // 15 history exists but draft revision unknown
  await check('15 unknown draft revision rejected',`(function(){var b=${JSON.stringify(baseObj.b)},d=${JSON.stringify(baseObj.d)};return JSON.stringify(${U}.validate(b,{designId:'ID-A',design:d}));})()`,x=>!x.ok&&x.reason==='revision-mismatch');
  // 16 cross-tab revision conflict rejects history
  await check('16 cross-tab revision mismatch rejected',`(function(){var b=${JSON.stringify(baseObj.b)},d=${JSON.stringify(baseObj.d)};return JSON.stringify(${U}.validate(b,{designId:'ID-A',draftRevision:9,design:d}));})()`,x=>!x.ok&&x.reason==='revision-mismatch');
  // 17 image-heavy design digest
  await check('17 image-heavy design digest builds',`(function(){var d=JSON.parse(JSON.stringify(${JSON.stringify(baseObj.d)}));d.assets=[{data:'data:image/png;base64,'+'a'.repeat(400000)}];return JSON.stringify({digest:${U}.designDigest(d)});})()`,x=>/^[0-9a-f]{8}$/.test(x.digest));
  // 18 history missing resets to restored baseline (prototype expected policy)
  await check('18 missing history policy is reset baseline',`(function(){var b=null,d=${JSON.stringify(baseObj.d)};var r=${U}.validate(b,{designId:'ID-A',draftRevision:4,design:d});return JSON.stringify({reject:!r.ok,baselineDigest:${U}.designDigest(d)});})()`,x=>x.reject&&/^[0-9a-f]{8}$/.test(x.baselineDigest));
  console.log('RESULTS: 18 required scenarios plus 1 module check; coverage is isolated prototype, not product history loading.');
  await cdp.eval("ICAR.ui.DraftStore.__clearAll()");
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
