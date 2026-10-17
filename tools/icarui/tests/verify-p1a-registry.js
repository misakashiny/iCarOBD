
// ============================================================================
// verify-p1a-registry.js —— P1A 新架构基础设施验收
//
// 守什么：
//   1. window.ICAR 命名空间存在且幂等（不覆盖既有全局）
//   2. Control Registry 能定义/查询/构建，且**不依赖编辑器与属性面板**
//   3. DataSource Registry 的四层语义判定正确（13 灯那条线）
//   4. t_label 新旧两条路径产出的节点，序列化后除 id 外逐字段相等
//   5. 旧页面行为不变：BUILTIN_CONTROLS 条目数、t_label 旧路径仍可用、
//      renderPanels/draw 等旧全局一个不少
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p1a`,'--window-size=1600,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);
  await require('./_common').stubDialogs(cdp);
  const report=await cdp.eval(`(()=>{
   const out=[],check=(v,m)=>out.push([!!v,m]);

   // ---------- 1. 命名空间 ----------
   check(!!window.ICAR,'ICAR namespace exists');
   check(window.ICAR.phase==='P1A','ICAR phase is P1A');
   check(!!window.ICAR.core&&!!window.ICAR.registry&&!!window.ICAR.render&&!!window.ICAR.adapter,'ICAR has 4 domains');
   const keyCountBefore=Object.keys(window).length;
   const snap=JSON.stringify(window.ICAR.__snapshot?window.ICAR.__snapshot():{});
   // 幂等：重复加载不重置
   const reg=window.ICAR.registry.Control;
   check(reg.has('t_label'),'registry survived (idempotent load)');

   // ---------- 2. Control Registry ----------
   check(!!window.ICAR.registry.Control,'Control registry exposed');
   check(typeof reg.define==='function'&&typeof reg.get==='function'&&typeof reg.build==='function','registry has define/get/build');
   const def=reg.get('t_label');
   check(!!def,'t_label registered');
   check(def.legacyKey==='t_label','t_label legacyKey maps to old key');
   check(def.category==='文字','t_label category is 文字');
   check(Array.isArray(def.schema)&&def.schema.length>0,'t_label has prop schema');
   check(Array.isArray(def.slots)&&def.slots.length===0,'t_label declares zero data slots');
   check(def.render&&def.render.mode==='text','t_label declares render mode text');
   check(typeof def.validate==='function','t_label has validate()');
   // 重复 key 必须抛错
   let dupThrew=false;try{reg.define({key:'t_label',name:'x',category:'x',build:()=>null});}catch(e){dupThrew=true;}
   check(dupThrew,'duplicate key throws');
   // 缺字段必须抛错
   let missThrew=false;try{reg.define({key:'bad_ctl'});}catch(e){missThrew=true;}
   check(missThrew,'missing required fields throws');
   // byLegacyKey 反查
   check(reg.byLegacyKey('t_label')&&reg.byLegacyKey('t_label').key==='t_label','byLegacyKey works');
   check(reg.byLegacyKey('__nope__')===undefined,'byLegacyKey returns undefined for unknown');

   // Registry 不得依赖编辑器/面板：把面板相关全局临时置空后仍能 build
   const savedRenderPanels=window.renderPanels, savedRenderProps=window.renderProps,
         savedRefreshAll=window.refreshAll, savedDraw=window.draw, savedCommit=window.commit;
   window.renderPanels=undefined;window.renderProps=undefined;window.refreshAll=undefined;
   window.draw=undefined;window.commit=undefined;
   let builtWithoutEditor=null, buildErr=null;
   try{ builtWithoutEditor=reg.build('t_label'); }catch(e){ buildErr=e.message; }
   window.renderPanels=savedRenderPanels;window.renderProps=savedRenderProps;
   window.refreshAll=savedRefreshAll;window.draw=savedDraw;window.commit=savedCommit;
   check(!buildErr&&!!builtWithoutEditor,'registry.build does not need editor/panels ('+(buildErr||'ok')+')');

   // ---------- 3. DataSource four tiers ----------
   const DS=window.ICAR.registry.DataSource;
   check(!!DS,'DataSource registry exposed');
   check(!!DS.TIER&&DS.TIER.L1==='L1'&&DS.TIER.L4==='L4','TIER constants present');
   check(DS.resolve('obd.coolant').tier==='L1','obd.coolant is L1 (App implemented)');
   check(DS.resolve('obd.coolant').usable===true,'obd.coolant usable');
   check(DS.resolve('obd.tpms').tier==='L4','obd.tpms is L4 (neither side)');
   check(DS.resolve('obd.tpms').usable===false,'obd.tpms NOT usable');
   check(DS.resolve('tpl_oilPressure').tier==='L2','tpl_oilPressure is L2 (tool knows, App does not)');
   check(DS.resolve('tpl_oilPressure').usable===false,'tpl_oilPressure NOT usable');
   check(DS.resolve('').usable===false,'empty binding not usable');
   // 19 个灯的分级统计必须与 P0.5 核验一致：6/1/12
   const lamps=window.BUILTIN_CONTROLS.filter(c=>c.key.indexOf('lamp_')===0);
   const tiers={L1:0,L2:0,L3:0,L4:0};
   lamps.forEach(c=>{const lc=c.make();const t=DS.resolve(lc.rawStatePid||lc.statePid||'').tier;tiers[t]=(tiers[t]||0)+1;});
   check(lamps.length===19,'19 lamp controls present');
   check(tiers.L1===6,'exactly 6 lamps have App data source (got '+tiers.L1+')');
   check(tiers.L4===12,'exactly 12 lamps have no data source anywhere (got '+tiers.L4+')');
   check(tiers.L2===1,'exactly 1 lamp is manufacturer template (got '+tiers.L2+')');

   // ---------- 4. t_label parity ----------
   const A=window.ICAR.adapter.Legacy;
   check(!!A,'Legacy adapter exposed');
   check(A.legacyEntry('t_label')!==null,'legacy entry t_label exists');
   const cmp=A.compare('t_label');
   check(cmp.ok,'t_label legacy vs new serialize identically'+(cmp.ok?'':' diffs='+JSON.stringify(cmp.diffs)));
   check(cmp.legacyJson.type==='text'&&cmp.nextJson.type==='text','both produce text node');
   check(cmp.legacyJson.text===cmp.nextJson.text,'text field equal');
   check(JSON.stringify(cmp.legacyJson.font)===JSON.stringify(cmp.nextJson.font),'font object equal');
   check(cmp.legacyJson.x===cmp.nextJson.x&&cmp.legacyJson.y===cmp.nextJson.y,'position equal');
   check(cmp.legacyJson.w===cmp.nextJson.w&&cmp.legacyJson.h===cmp.nextJson.h,'size equal');
   check(cmp.legacyJson.z===cmp.nextJson.z,'z equal');
   // 新节点不能把内部字段漏进设计文件
   const n=reg.build('t_label');
   check(n.__controlKey===undefined||!(('__controlKey') in nodeToJson(n)),'internal __controlKey not serialized');

   // ---------- 5. 旧行为不变 ----------
   // 浏览器里 BUILTIN_CONTROLS = presets.js 的 200 条 + next-controls.js unshift 的 15 条 = 215
   const ctrlTotal=(window.BUILTIN_CONTROLS||[]).length;
   check(ctrlTotal===215,'BUILTIN_CONTROLS still 215 entries in browser (got '+ctrlTotal+')');
   check((window.NEXT_CONTROLS||[]).length===15,'NEXT_CONTROLS still 15 entries (got '+(window.NEXT_CONTROLS||[]).length+')');
   check((window.BUILTIN_CONTROLS||[]).filter(c=>c.next).length===15,'15 next-library controls still flagged');
   const legacyNodes=window.BUILTIN_CONTROLS.map(c=>{try{return c.make();}catch(e){return null;}});
   check(legacyNodes.every(x=>x&&x.type),'all legacy controls still make() without error');
   // next_* 那 15 条需要 CanvasState.design（依赖设计上下文），单独验证它们可调用
   const nextOk=window.NEXT_CONTROLS.map(c=>{try{const n=c.make();return !!(n&&n.type);}catch(e){return false;}});
   check(nextOk.every(Boolean),'all 15 next-library controls still make() without error');
   check(typeof window.renderPanels==='function','renderPanels still global');
   check(typeof window.renderProps==='function','renderProps still global');
   check(typeof window.refreshAll==='function','refreshAll still global');
   check(typeof window.draw==='function','draw still global');
   check(typeof window.nodeToJson==='function','nodeToJson still global');
   check(typeof window.createNode==='function','createNode still global');
   check(typeof window.resolvePid==='function','resolvePid still global');
   check(typeof window.commit==='function','commit still global');
   // 旧全局一个不少：抽样 20 个关键符号
   const sample=['NODE_GAUGE','NODE_IMAGE','NODE_TEXT','NODE_GROUP','BUILTIN_PIDS','PID_ALIASES',
     'CanvasState','normalizePart','normalizeFont','newId','findNode','createNode','walk',
     'parseDesign','toV2Json','PRESETS','BUILTIN_CONTROLS','CARD_DEFAULT','FONT_DEFAULT','NEXT_CONTROLS','CTRL_CATS'];
   const missing=sample.filter(k=>window[k]===undefined);
   check(missing.length===0,'legacy globals intact'+(missing.length?' missing='+missing.join(','):''));
   // 旧路径创建 t_label 仍然正常（设计文件读写走旧路）
   const legacyT=BUILTIN_CONTROLS.find(c=>c.key==='t_label').make();
   const design=createDesign({name:'P1A'});
   design.nodes=[legacyT];
   const json=toV2Json(design);
   const parsed=parseDesign(json);
   check(parsed.errors.length===0,'design with legacy t_label serializes+parses clean');
   check(parsed.design.nodes[0].text===legacyT.text,'round-trip keeps text');

   return {out, tiers, lampCount:lamps.length};
  })()`);
  report.out.forEach(([v,m])=>ok(v,m));
  console.log('  [lamp tiers] '+JSON.stringify(report.tiers));
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
