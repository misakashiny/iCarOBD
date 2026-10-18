
// ============================================================================
// verify-p2b-catalog-ui.js —— P2B：Catalog 加固 + 控件库新界面验收
//
// 守什么：
//   1. 静态元数据优先：声明过的条目不调用 make()（零副作用）
//   2. 未声明条目仍走探测兜底，目录不缺项（215 全覆盖）
//   3. 就绪触发 / 诊断 / 恢复 三个 API 可用
//   4. 重复构建、切设计、导入、初始化失败等场景安全
//   5. gauge_0..7 语义为 preset（非 control），且 vehicleAvailability != implemented
//   6. 四层车辆可用性都有分布，且不与"App 已实现"混淆
//   7. 新 UI：三入口 / 搜索（中文+拼音）/ 分类折叠 / 徽标 / L4 弱化
//   8. 旧路径零影响：215 条可 make、旧面板 renderAssets 仍在
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p2b`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);
  await require('./_common').stubDialogs(cdp);
  await sleep(800);
  const report=await cdp.eval(`(()=>{
   const out=[],check=(v,m)=>out.push([!!v,m]);
   const C=ICAR.registry.Catalog, M=ICAR.registry.CatalogMeta, CP=ICAR.ui.CatalogPanel;

   // ---------- 1. 静态元数据优先 ----------
   check(M.count()===8,'8 entries declared statically (got '+M.count()+')');
   const g0=C.get('gauge_0');
   check(!!g0,'gauge_0 in catalog');
   check(g0.source==='declared','gauge_0 built from declaration, not probe');
   check(g0.kind==='preset','gauge_0 classified as preset (semantic fix)');
   check(g0.category==='预设·仪表外观','gauge_0 category is 预设·仪表外观');
   // 8 条 gauge_N 全部声明
   const allDeclared=[0,1,2,3,4,5,6,7].every(i=>C.get('gauge_'+i).source==='declared');
   check(allDeclared,'gauge_0..7 all declared');
   // 声明条目不应调用 make()：通过"声明条目 nodeType 来自 decl"间接验证
   check(g0.nodeType==='gauge','gauge_0 nodeType from declaration');

   // ---------- 2. 探测兜底仍工作 ----------
   const st=C.stats();
   check(st.total===215,'total 215 with mixed sources (got '+st.total+')');
   check(st.bySource.declared===8&&st.bySource.probe===207,'source split 8/207 (got '+JSON.stringify(st.bySource)+')');
   check(C.verifyCoverage().ok,'coverage ok across both sources');

   // ---------- 3. 就绪/诊断/恢复 ----------
   check(typeof C.bootstrap==='function','bootstrap() exists');
   check(typeof C.onAppReady==='function','onAppReady() exists');
   check(typeof C.diagnose==='function','diagnose() exists');
   check(typeof C.recover==='function','recover() exists');
   const dg=C.diagnose();
   check(dg.ok===true,'diagnose ok');
   check(dg.total===215&&dg.failed===0,'diagnose total/failed correct');
   check(Array.isArray(dg.issues),'diagnose returns issues array');
   check(window.__ICAR_APP_READY===true,'app ready flag set by init wrapper');

   // ---------- 4. 重复构建 / 切设计 / 导入 ----------
   const a1=(CanvasState.design.assets||[]).length;
   C.build(); C.build(); C.build();
   const a2=(CanvasState.design.assets||[]).length;
   check(a1===a2,'triple rebuild leaves design.assets unchanged');
   check(C.stats().total===215,'triple rebuild still 215');
   // 切设计：换一个空设计再构建
   const prev=CanvasState.design;
   const fresh=createDesign({name:'switch-test'});
   CanvasState.design=fresh;
   const r1=C.recover();
   check(r1.ok,'recover() after design switch ok');
   check((fresh.assets||[]).length===0,'recover did not pollute fresh design assets');
   CanvasState.design=prev;
   C.build();
   check(C.stats().total===215,'back to 215 after restore');
   // 初始化失败场景：清空目录 + diagnose
   C.__reset();
   const dg2=C.diagnose();
   check(dg2.ok===false,'diagnose reports failure when catalog empty');
   check(dg2.issues.some(i=>i.code==='empty'),'diagnose empty code present');
   C.build();
   check(C.stats().total===215,'rebuild after reset works');

   // ---------- 5. gauge_0..7 语义 ----------
   const gAll=[0,1,2,3,4,5,6,7].map(i=>C.get('gauge_'+i));
   check(gAll.every(e=>e.kind==='preset'),'all gauge_0..7 are preset');
   check(gAll.every(e=>e.vehicleAvailability==='unverified'),
     'all gauge_0..7 marked unverified (NOT implemented) — App has channel but vehicle unconfirmed');

   // ---------- 6. 四层分布 ----------
   const bv=st.byVehicle;
   check(bv.implemented>0,'has implemented tier');
   check(bv['alias-only']>0,'has alias-only tier');
   check(bv.unverified>0,'has unverified tier');
   check(bv.unimplemented>0,'has unimplemented tier');
   // L4 条目必须 dataCapability != none（否则不该标不可用）
   const l4=C.all().filter(e=>e.vehicleAvailability==='unimplemented');
   check(l4.length>0,'L4 entries exist ('+l4.length+')');
   check(l4.every(e=>e.dataCapability!=='none'),'L4 entries all have data capability');

   // ---------- 7. 新 UI ----------
   check(!!document.getElementById('catalog'),'#catalog panel exists');
   check(!!CP,'CatalogPanel exposed');
   // 三入口
   CP.setTab('control');
   const nCtrl=document.querySelectorAll('#catalog .cpItem').length;
   check(nCtrl>0,'control tab renders items ('+nCtrl+')');
   check(nCtrl===st.byKind.control,'control tab count matches stats');
   CP.setTab('preset');
   check(document.querySelectorAll('#catalog .cpItem').length===st.byKind.preset,'preset tab count matches');
   CP.setTab('asset');
   check(document.querySelectorAll('#catalog .cpItem').length===st.byKind.asset,'asset tab count matches');
   // 搜索
   CP.setTab('control'); CP.setQuery('转速');
   const s1=document.querySelectorAll('#catalog .cpItem').length;
   check(s1>0&&s1<nCtrl,'Chinese search narrows results ('+s1+'/'+nCtrl+')');
   CP.setQuery('zhuansu');
   check(document.querySelectorAll('#catalog .cpItem').length>0,'pinyin search works');
   CP.setQuery('');
   check(document.querySelectorAll('#catalog .cpItem').length===nCtrl,'clearing query restores all');
   // 分类折叠
   const gridBefore=document.querySelector('#catalog .cpGrid');
   check(!!gridBefore,'category grid exists');
   const catName=gridBefore.getAttribute('data-cat');
   CP.toggleCat(catName);
   const g2=document.querySelector('#catalog .cpGrid');
   check(g2&&g2.style.display==='none','category collapses');
   CP.toggleCat(catName);
   const g3=document.querySelector('#catalog .cpGrid');
   check(g3&&g3.style.display!=='none','category expands again');
   // 徽标与 L4 弱化
   check(document.querySelectorAll('#catalog .cpBadge').length>0,'availability badges rendered');
   check(document.querySelectorAll('#catalog .cpItemL4').length>0,'L4 items visually marked');
   // 缩略图
   check(document.querySelectorAll('#catalog .cpThumb').length>0,'thumbnails rendered');

   // ---------- 8. 旧路径零影响 ----------
   check(BUILTIN_CONTROLS.length===215,'BUILTIN_CONTROLS still 215');
   let okc=0;BUILTIN_CONTROLS.forEach(c=>{try{if(c.make())okc++;}catch(e){}});
   check(okc===215,'all 215 still make() ('+okc+')');
   check(typeof renderAssets==='function','old renderAssets intact');
   check(!!document.getElementById('assets'),'old #assets panel still present');
   check(!!document.getElementById('tree'),'old #tree panel still present');
   // 旧面板仍在渲染（有内容）
   check(document.getElementById('assets').innerHTML.length>100,'old assets panel still has content');

   return {out, st};
  })()`);
  report.out.forEach(([v,m])=>ok(v,m));
  console.log('  [byVehicle] '+JSON.stringify(report.st.byVehicle));
  console.log('  [byKind] '+JSON.stringify(report.st.byKind));
  console.log('  [bySource] '+JSON.stringify(report.st.bySource));
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
