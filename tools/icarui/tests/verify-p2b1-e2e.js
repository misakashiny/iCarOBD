// ============================================================================
// verify-p2b1-e2e.js —— P2B.1 质量收尾与端到端验收
//
// 一、三字段分类自洽：gauge_0 的 L1(通道) 与 unverified(车辆) 是两个概念；
//     unimplemented 统计必须等于 13（此前 28，含 15 个误判的 next_*）；
//     15 个 next_* 组合预设必须识别子节点数据（composite）。
// 二、初始化失败不静默：onInitFailed 保留原始异常、diagnose 报 init-error、recover 可恢复。
// 三、真实拖拽落画布：文字/预设/素材三类 + 坐标尺寸图层 + 属性面板 + 撤销重做 + 保存重载。
// 四、旧面板保留且可切换。
// 五、Catalog 重建无副作用；并实测有多少 make() 会写 design.assets。
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p2b1`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);
  await require('./_common').stubDialogs(cdp);
  await sleep(1500);

  const SRC = [
   "(()=>{",
   " const out=[],check=(v,m)=>out.push([!!v,m]);",
   " const C=ICAR.registry.Catalog, CP=ICAR.ui.CatalogPanel, S=CanvasState;",
   " const g0=C.get('gauge_0');",
   " check(g0.channelStatus==='implemented','gauge_0 channelStatus=implemented');",
   " check(g0.vehicleStatus==='unverified','gauge_0 vehicleStatus=unverified NOT supported');",
   " check(g0.availability==='L1'&&g0.vehicleAvailability==='unverified','legacy fields kept: L1 channel + unverified vehicle');",
   " const cons=C.checkConsistency();",
   " check(cons.ok,'checkConsistency passes');",
   " const st=C.stats();",
   " check(Object.values(st.byChannelStatus).reduce((a,b)=>a+b,0)===215,'byChannelStatus sums to 215');",
   " check(Object.values(st.byVehicleStatus).reduce((a,b)=>a+b,0)===215,'byVehicleStatus sums to 215');",
   " const l4=C.all().filter(e=>e.channelStatus==='unimplemented').length;",
   " check(l4===13,'unimplemented count is 13 got '+l4);",
   " const nxt=C.all().filter(e=>e.__meta&&e.__meta.next);",
   " check(nxt.length===15,'15 next_ present');",
   " check(nxt.every(e=>e.dataCapability==='composite'),'all next_ composite');",
   " check(nxt.every(e=>(e.__meta.childChannels||[]).length>0),'all next_ have child channels');",
   " check(nxt.every(e=>e.channelStatus!=='unimplemented'),'no next_ misclassified as unimplemented');",
   " check(window.__ICAR_APP_READY===true,'app ready after successful init');",
   " C.onInitFailed('simulated: init threw');",
   " const dg=C.diagnose();",
   " check(dg.ok===false,'diagnose reports failure after onInitFailed');",
   " check(dg.issues.some(i=>i.code==='init-error'),'diagnose surfaces init-error');",
   " check(dg.issues.some(i=>String(i.message).indexOf('simulated')>=0),'diagnose preserves original error');",
   " const rec=C.recover();",
   " check(rec.ok===true,'recover clears failure');",
   " S.design=createDesign({name:'e2e'}); S.design.nodes=[]; S.selection=[];",
   " if(window.refreshAll) window.refreshAll();",
   " function fakeDrop(mime,value,cx,cy){var cv=document.getElementById('cv'),rect=cv.getBoundingClientRect();var dt=new DataTransfer();dt.setData(mime,value);cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:rect.left+cx,clientY:rect.top+cy}));}",
   " const n0=S.design.nodes.length;",
   " fakeDrop('application/x-ctrl','t_label',300,300);",
   " check(S.design.nodes.length===n0+1,'drop text control creates node');",
   " const tn=S.design.nodes[S.design.nodes.length-1];",
   " check(tn.type==='text','text node type correct');",
   " fakeDrop('application/x-ctrl','gauge_0',600,400);",
   " check(S.design.nodes.length===n0+2,'drop gauge preset creates node');",
   " const gn=S.design.nodes[S.design.nodes.length-1];",
   " check(gn.type==='gauge','gauge node type correct');",
   " const ae=C.byKind('asset').find(e=>e.__meta.assetId);",
   " fakeDrop('application/x-asset',ae.__meta.assetId,800,500);",
   " check(S.design.nodes.length===n0+3,'drop asset creates node');",
   " const an=S.design.nodes[S.design.nodes.length-1];",
   " check(an.type==='image','image node type correct');",
   " [tn,gn,an].forEach(function(n,i){check(Number.isFinite(n.x)&&Number.isFinite(n.y),'node'+i+' finite xy');check(n.w>0&&n.h>0,'node'+i+' positive wh');check(Number.isFinite(n.z),'node'+i+' finite z');});",
   " check(new Set(S.design.nodes.map(n=>n.id)).size===S.design.nodes.length,'node ids unique');",
   " S.selection=[gn.id];",
   " if(window.onSelectionChanged) window.onSelectionChanged();",
   " const props=document.getElementById('props');",
   " check(props&&props.innerHTML.length>50,'property panel renders');",
   " check(/变换|位置/.test(props.textContent),'property panel shows transform');",
   " const before=S.design.nodes.length;",
   " window.doUndo();",
   " check(S.design.nodes.length===before-1,'undo removes last node');",
   " window.doRedo();",
   " check(S.design.nodes.length===before,'redo restores node');",
   " const saved=toV2Json(S.design);",
   " const back=parseDesign(saved);",
   " check(back.errors.length===0,'saved design parses clean');",
   " check(back.design.nodes.length===S.design.nodes.length,'reload keeps node count');",
   " const sig=JSON.stringify(S.design.nodes.map(n=>[n.id,n.x,n.y,n.w,n.h]));",
   " CP.setTab('asset'); CP.setQuery('ring'); CP.setTab('control'); CP.setQuery('');",
   " check(JSON.stringify(S.design.nodes.map(n=>[n.id,n.x,n.y,n.w,n.h]))===sig,'tab/search does not modify design');",
   " check(!!document.getElementById('catalog'),'new catalog exists');",
   " check(!!document.getElementById('assets'),'legacy assets exists');",
   " check(typeof CP.collapseLegacy==='function','collapseLegacy exposed');",
   " const bids=S.design.nodes.map(n=>n.id).join(',');",
   " const bsel=(S.selection||[]).join(',');",
   " const bajson=toV2Json(S.design);",
   " C.build(); C.build();",
   " check(S.design.nodes.map(n=>n.id).join(',')===bids,'rebuild keeps node ids');",
   " check((S.selection||[]).join(',')===bsel,'rebuild keeps selection');",
   " check(toV2Json(S.design)===bajson,'rebuild keeps serialized design identical');",
   " check(C.stats().total===215,'rebuild still 215');",
   " var a0=(S.design.assets||[]).length, sfx=0, cln=0;",
   " (window.BUILTIN_CONTROLS||[]).forEach(function(c){ var b=(S.design.assets||[]).length; try{c.make();}catch(e){} var a=(S.design.assets||[]).length; if(a!==b){sfx++; S.design.assets=S.design.assets.slice(0,b);} else {cln++;} });",
   " check(sfx+cln===215,'side-effect probe covered all 215');",
   " check(sfx>0,'measured: some make() do write design.assets ('+sfx+' of 215)');",
   " check((S.design.assets||[]).length===a0,'assets restored after probe');",
   " return {out:out, stats:{channel:st.byChannelStatus, vehicle:st.byVehicleStatus}, sfx:sfx};",
   "})()"
  ].join("\n");

  const r=await cdp.eval(SRC);
  r.out.forEach(function(p){ok(p[0],p[1]);});
  console.log('  [channel] '+JSON.stringify(r.stats.channel));
  console.log('  [vehicle] '+JSON.stringify(r.stats.vehicle));
  console.log('  [side-effect] '+r.sfx+' of 215 make() write design.assets');
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
