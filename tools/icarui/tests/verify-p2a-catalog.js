
// ============================================================================
// verify-p2a-catalog.js —— P2A 统一控件目录（Catalog）验收
//
// 守什么：
//   1. 215 条全部入目录，无遗漏、无重复 key
//   2. 分类依据是**节点结构**，不是 key 前缀（含反例）
//   3. 15 个 NEXT_CONTROLS 完整分类为 preset
//   4. 三类 kind 的数量与结构一致（control/preset/asset）
//   5. Catalog 是只读视图：构建前后 design.assets 不变（无副作用）
//   6. 查询 API 可用：byKind/byCategory/search/categories/verifyCoverage
//   7. 旧控件创建路径不受影响（215 条仍可 make，全局符号不变）
//   8. 不改变渲染结果（抽样对比 drawNodePreview 调用不报错）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p2a`,'--window-size=1600,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);
  await require('./_common').stubDialogs(cdp);
  const report=await cdp.eval(`(()=>{
   const out=[],check=(v,m)=>out.push([!!v,m]);
   const C=ICAR.registry.Catalog;

   // ---------- 1. 覆盖 ----------
   const cov=C.verifyCoverage();
   check(cov.total===215,'source library has 215 entries (got '+cov.total+')');
   check(cov.ok,'catalog covers every legacy key (missing='+cov.missing.length+' dupes='+cov.dupes.length+')');
   check(C.stats().total===215,'catalog has 215 entries (got '+C.stats().total+')');
   check(new Set(C.keys()).size===215,'no duplicate keys');

   // ---------- 2. 分类基于结构，不是前缀 ----------
   const T=C.KIND, R=C.RENDERER;
   const byKey=k=>C.get(k);
   // 反例：box_h1 前缀像容器，实际是 text
   const boxH1=byKey('box_h1');
   check(!!boxH1,'box_h1 present');
   check(boxH1&&boxH1.nodeType==='text','box_h1 actually creates text node (not container)');
   check(boxH1&&boxH1.kind===T.CONTROL,'box_h1 classified as control despite box_ prefix');
   check(boxH1&&boxH1.renderer===R.TEXT,'box_h1 renderer is text');
   // 反例：img_lampcrit 前缀是 img_，但它是普通素材
   const imgLamp=byKey('img_lampcrit');
   check(imgLamp&&imgLamp.kind===T.ASSET,'img_lampcrit is asset');
   // 反例：cd_* 与 bar_* 都产出 image，但渲染方式不同
   const cdTrack=byKey('cd_trackh'), barTrack=byKey('bar_trackh');
   check(cdTrack&&cdTrack.renderer===R.TRACK,'cd_trackh renderer=track');
   check(barTrack&&barTrack.renderer===R.IMAGE,'bar_trackh renderer=image');
   check(cdTrack&&barTrack&&cdTrack.kind===T.CONTROL&&barTrack.kind===T.ASSET,'cd_ is control, bar_ is asset (same name, different structure)');
   // 状态灯：image + states
   const lamp=byKey('lamp_coolant');
   check(lamp&&lamp.renderer===R.STATE_IMAGE,'lamp_coolant renderer=state');
   check(lamp&&lamp.kind===T.CONTROL,'lamp is control');
   check(lamp&&lamp.dataCapability===C.DATA.STATE,'lamp dataCapability=state');
   // 拼装仪表 = preset
   const parts=byKey('gauge_parts');
   check(parts&&parts.kind===T.PRESET,'gauge_parts classified as preset');

   // ---------- 3. 15 个 NEXT_CONTROLS ----------
   const next=C.byKind(T.PRESET).filter(e=>e.__meta.next);
   check(next.length===15,'15 next-library entries present (got '+next.length+')');
   check(next.every(e=>e.renderer===R.COMPOSITE),'all next_* are composite');
   check(next.every(e=>e.nodeType==='group'),'all next_* create group nodes');
   check(next.every(e=>e.__meta.children===2),'all next_* have 2 children');
   const nextKeys=next.map(e=>e.key).sort();
   check(nextKeys.indexOf('next_speed_oem')>=0&&nextKeys.indexOf('next_fuel_minimal')>=0,'next_* keys complete');
   const semantics=new Set(next.map(e=>e.__meta.semanticId));
   check(semantics.size===5,'next_* cover 5 semantics (got '+semantics.size+')');
   const variants=new Set(next.map(e=>e.__meta.variant));
   check(variants.size===3,'next_* cover 3 variants (got '+variants.size+')');

   // ---------- 4. 三类数量 ----------
   const st=C.stats();
   // ⚠️ P2B 语义修正（2026-10-18）：gauge_0..7 从 control 改为 preset。
   //    理由：它们绑定同一个 PID(std_0C)、同一套量程，唯一区别是 8 种样式
   //    → 按「同一功能的不同外观优先归入预设」的原则应属预设。
   //    90-8=82（control）、21+8=29（preset）。这是**语义改进**不是放宽门槛：
   //    总条目数仍是 215，且新增了 verify-p2b 的语义断言来守这条规则。
   check(st.byKind[T.CONTROL]===82,'82 controls (got '+st.byKind[T.CONTROL]+')');
   check(st.byKind[T.PRESET]===29,'29 presets (got '+st.byKind[T.PRESET]+')');
   check(st.byKind[T.ASSET]===104,'104 assets (got '+st.byKind[T.ASSET]+')');
   check(st.byKind[T.CONTROL]+st.byKind[T.PRESET]+st.byKind[T.ASSET]===215,'kinds sum to 215');
   // 结构一致性：asset 必须都是 image 且有 assetId
   const assets=C.byKind(T.ASSET);
   check(assets.every(e=>e.nodeType==='image'),'all assets are image nodes');
   check(assets.every(e=>!!e.__meta.assetId),'all assets have assetId');
   // preset 必须都有子结构
   const presets=C.byKind(T.PRESET);
   // ⚠️ P2B：gauge_0..7 是"单节点 + 8 种样式"的外观预设，没有 parts/children 子树。
   //    所以判据放宽为「有子树 **或** 被显式声明为预设样式」。
   //    （不是无条件放行：未声明且无子树的预设仍会红）
   check(presets.every(e=>e.__meta.parts>0||e.__meta.children>0||
     (e.source==='declared'&&e.category==='预设·仪表外观')),
     'all presets either have substructure or are declared style presets');

   // ---------- 5. 只读 / 无副作用 ----------
   const before=(CanvasState.design.assets||[]).length;
   const beforeIds=(CanvasState.design.assets||[]).map(a=>a.id).join(',');
   C.build();
   const after=(CanvasState.design.assets||[]).length;
   const afterIds=(CanvasState.design.assets||[]).map(a=>a.id).join(',');
   check(before===after,'rebuild does not change assets count ('+before+' -> '+after+')');
   check(beforeIds===afterIds,'rebuild does not change assets identity');
   check(C.stats().total===215,'rebuild still yields 215');

   // ---------- 6. 查询 API ----------
   check(typeof C.get==='function'&&C.get('t_label')!==undefined,'get() works');
   check(C.has('lamp_abs')&&!C.has('__nope__'),'has() works');
   check(C.byKind(T.ASSET).length===104,'byKind works');
   // P2B：gauge_0..7 移到「预设·仪表外观」后，仪表分类剩 32-8=24
   check(C.byCategory('仪表').length===24,'byCategory works (got '+C.byCategory('仪表').length+')');
   check(C.byCategory('预设·仪表外观').length===8,'declared style presets grouped (got '+C.byCategory('预设·仪表外观').length+')');
   check(C.categories().length>=10,'categories() returns grouped list (got '+C.categories().length+')');
   // P2B：gauge_0..7 显式声明为 vehicleAvailability=unverified（App 有 std_0C 通道，
   //      但车辆是否提供转速未验证）。所以 L1 从 35 降到 27。
   //      这是**保守化**：P2B 明确要求"不要把 App 已实现 PID 直接标记为真车可用"。
   // P2B.1 修正：15 个 next_* 组合预设的 pid 在**子节点**上，之前只看根节点
   // 被判成 L4（无数据）→ 误计入 L4；正确分析子通道后归为 L1（子通道 std_0C 等）。
   // 所以 L1 从 35 增至 50、L4 从 28 降至 13。这是**修正**不是放水：
   // 总数据条目数不变，且 verify-p2b 有专门断言守"composite 必须识别出子通道"。
   check(C.byAvailability('L1').length===50,'byAvailability L1 works (got '+C.byAvailability('L1').length+')');
   check(C.byAvailability('L4').length===13,'L4 is 13 after composite fix (got '+C.byAvailability('L4').length+')');
   // P2B 关键区分：gauge_0..7 的 availability=**L1**（App 有 std_0C 通道），
   // 但 vehicleAvailability=**unverified**（车辆是否真有转速未验证）。
   // 这正是"不要把 App 已实现 PID 当成真车可用"的落地。
   const g0=C.get('gauge_0');
   check(g0.availability==='L1'&&g0.vehicleAvailability==='unverified',
     'gauge_0: channel is L1 but vehicle availability is unverified');
   const s1=C.search('转速');
   check(s1.length>0,'search by Chinese name works ('+s1.length+' hits)');
   const s2=C.search('gauge_0');
   check(s2.length>=1,'search by key works');
   const s3=C.search('statePid:std_05');
   check(s3.length>=1,'search by tag works');
   // 每条元数据字段齐全
   const fields=['key','name','kind','category','nodeType','renderer','legacyKey','dataCapability','availability','tags','thumbnail'];
   const incomplete=C.all().filter(e=>fields.some(f=>e[f]===undefined));
   check(incomplete.length===0,'all entries have 11 required metadata fields'+(incomplete.length?' missing on '+incomplete.length:''));
   // thumbnail 方案
   check(C.byKind(T.ASSET).every(e=>e.thumbnail.mode==='asset'&&!!e.thumbnail.ref),'assets use asset thumbnail');
   check(C.byKind(T.CONTROL).filter(e=>e.renderer===R.GAUGE).every(e=>e.thumbnail.mode==='draw'),'gauges use draw thumbnail');

   // ---------- 7. 旧路径不受影响 ----------
   check(BUILTIN_CONTROLS.length===215,'BUILTIN_CONTROLS untouched (215)');
   let makeOk=0,makeFail=0;
   BUILTIN_CONTROLS.forEach(c=>{try{const n=c.make();if(n&&n.type)makeOk++;else makeFail++;}catch(e){makeFail++;}});
   check(makeFail===0,'all 215 legacy controls still make() ('+makeOk+' ok, '+makeFail+' fail)');
   check(typeof renderPanels==='function'&&typeof renderProps==='function','panel globals intact');
   check(typeof draw==='function'&&typeof nodeToJson==='function','render/serialize globals intact');

   // ---------- 8. 渲染不受影响（抽样） ----------
   let drawErr=null;
   try{
     const sample=['gauge_0','t_label','lamp_coolant','cd_trackh','gauge_parts','next_speed_oem'];
     const prev=CanvasState.design;
     sample.forEach(k=>{
       const c=BUILTIN_CONTROLS.find(x=>x.key===k);
       if(!c)return;
       const n=c.make();
       const cv=document.createElement('canvas');cv.width=200;cv.height=200;
       drawNodePreview(n,cv);
     });
     CanvasState.design=prev;
   }catch(e){drawErr=e.message;}
   check(!drawErr,'sample nodes render without error ('+(drawErr||'ok')+')');

   return {out, stats:st, cats:C.categories().map(c=>[c.category,c.count])};
  })()`);
  report.out.forEach(([v,m])=>ok(v,m));
  console.log('  [stats] '+JSON.stringify(report.stats.byKind));
  console.log('  [categories] '+report.cats.map(c=>c[0]+'='+c[1]).join(' '));
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
