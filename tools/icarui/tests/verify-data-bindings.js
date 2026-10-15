const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const fixturePath=require('path').join(__dirname,'fixtures/next-bound-design.json');
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-data-bindings`,'--window-size=1600,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);
  await require('./_common').stubDialogs(cdp);
  const report=await cdp.eval(`(async()=>{
   const out=[],check=(v,m)=>out.push([!!v,m]),S=CanvasState;
   const fresh=()=>{S.design=createDesign({name:'新仪表数据绑定验收'});Object.assign(S.design.canvas,{designW:2560,designH:1600,scaleMode:0});S.selection=[];};
   const change=(select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));};
   function texts(node){const lines=[],proto=CanvasRenderingContext2D.prototype,original=proto.fillText;proto.fillText=function(t,...args){lines.push(String(t));return original.call(this,t,...args);};try{drawNodePreview(node,document.createElement('canvas'));}finally{proto.fillText=original;}return lines;}
   fresh();
   for(const control of NEXT_CONTROLS){
    const group=control.make();S.design.nodes=[group];S.selection=[group.id];renderPanels();applyCanvasSize();
    const gauge=group.children.find(n=>n.type==='gauge'),entry=document.querySelector('#props [data-binding-node]');
    check(!!entry,control.key+' group exposes data binding');
    check(entry.querySelector('select').value===gauge.rawPid,control.key+' correct PID selected');
    check(entry.textContent.includes(BUILTIN_PIDS[gauge.pid].unit),control.key+' unit visible');
    check(!group.children.some(n=>n.type==='text'),control.key+' no frozen unit label');
    const geometry=group.children.filter(n=>n.type==='image').map(n=>[n.x,n.y,n.w,n.h,n.assetId]);
    const target=gauge.pid==='std_42'?'obd.speed':'obd.voltage';change(entry.querySelector('select'),target);
    const actual=BUILTIN_PIDS[resolvePid(target)];
    check(gauge.pid===resolvePid(target)&&gauge.rawPid===target,control.key+' actual change handler updates nested gauge');
    check(gauge.min===actual.min&&gauge.max===actual.max,control.key+' source range follows binding');
    check(gauge.warnLow===(actual.warnLow===undefined?null:actual.warnLow)&&gauge.warnHigh===(actual.warnHigh===undefined?null:actual.warnHigh),control.key+' thresholds follow binding');
    check(JSON.stringify(geometry)===JSON.stringify(group.children.filter(n=>n.type==='image').map(n=>[n.x,n.y,n.w,n.h,n.assetId])),control.key+' binding leaves frame intact');
    S.previewValues={[gauge.pid]:gauge.pid==='std_42'?13.8:88};
    const rendered=texts(group);
    check(rendered.includes(gauge.pid==='std_42'?'13.8':'88'),control.key+' reads chosen source');
    check(rendered.includes(actual.unit),control.key+' renders chosen source unit');
    S.previewValues={};check(texts(group).includes('--'),control.key+' no value shows unknown');
    const parsed=parseDesign(toV2Json(S.design));
    const restored=controlDataBindings(parsed.design.nodes[0])[0];
    check(!parsed.errors.length&&restored.pid===gauge.pid,control.key+' saved design retains binding');
    const imported=await prepareControlFile(makeControlFile(group,S.design),S.design);
    check(controlDataBindings(imported.control.node)[0].pid===gauge.pid,control.key+' control file retains binding');
   }
   fresh();const group=NEXT_CONTROLS[0].make();S.design.nodes=[group];S.selection=[group.id];renderPanels();
   let gauge=controlDataBindings(group)[0];
   S.selection=[gauge.id];renderProps();
   check(document.querySelector('#props select[onchange="setNodePid(this.value)"]').value==='obd.speed','single gauge inspector no longer falsely selects RPM');
   setNodePid('std_42');check(document.querySelector('#props select[onchange="setNodePid(this.value)"]').value==='std_42','raw standard id preserved in selection');
   setNodePid('my_custom_pressure');check(document.querySelector('#props select[onchange="setNodePid(this.value)"]').value==='my_custom_pressure','custom PID preserved in selection');
   S.selection=[group.id];renderProps();
   check(document.querySelector('#props [data-binding-summary]').textContent.includes('自定义 PID'),'unknown source has an honest summary');
   openControlEditor(group.id);change(document.querySelector('#ceProps [data-binding-pid]'),'obd.coolant');
   check(gauge.pid==='my_custom_pressure','editor edits draft, not live node');
   document.querySelector('#ctrlEditor .modalFoot button.primary').click();
   gauge=controlDataBindings(S.design.nodes[0])[0];
   check(gauge.pid==='std_05'&&gauge.min===-40,'editor apply commits nested binding');
   openControlEditor(S.design.nodes[0].id);change(document.querySelector('#ceProps [data-binding-pid]'),'obd.rpm');
   document.querySelector('#ctrlEditor .modalFoot button:last-child').click();
   check(controlDataBindings(S.design.nodes[0])[0].pid==='std_05','editor cancel preserves current binding');
   const second=createNode(NODE_GAUGE,{pid:'obd.fuel_level'});S.design.nodes[0].children.push(second);S.selection=[S.design.nodes[0].id];renderProps();
   const selects=document.querySelectorAll('#props [data-binding-pid]');check(selects.length===2,'multiple child bindings exposed independently');
   change(selects[1],'obd.voltage');check(gauge.pid==='std_05'&&second.pid==='std_42','changing second source does not rewrite first');
   gauge.parts=[normalizePart({kind:'decor',children:[{kind:'needle',pid:'obd.speed'},{kind:'value',pid:'obd.rpm'}]})];gauge.extraPids=['obd.fuel_level'];
   const pids=collectDesignPids(S.design.nodes);
   check(['std_05','std_42','std_0D','std_0C','std_2F'].every(id=>pids.includes(id)),'simulator gathers nested parts and extra sources');
   document.getElementById('btnSim').click();await new Promise(r=>setTimeout(r,120));
   check(pids.every(id=>Number.isFinite(S.previewValues[id])),'actual simulate button feeds all bindings');
   document.getElementById('btnSim').click();check(S.previewValues===null,'stopping simulation clears values');
   for(const bad of [null,undefined,NaN,Infinity,-Infinity,1e100,'13.8'])check(partValueRange(normalizePart({kind:'value'}),gauge,{[gauge.pid]:bad}).value===null,'part rejects invalid data '+String(bad));
   check(partValueRange(normalizePart({kind:'value'}),gauge,{[gauge.pid]:0}).value===0,'part accepts actual zero');
   S.previewValues={};check(texts(S.design.nodes[0]).includes('--'),'composed value does not substitute range minimum');
   fresh();S.design.nodes=NEXT_CONTROLS.map(c=>c.make());
   const fixture=JSON.parse(toV2Json(S.design));let sequence=0;const ids=new Map();
   for(const asset of fixture.assets||[]) {const id='asset_'+ids.size;ids.set(asset.id,id);asset.id=id;}
   function canonical(node){node.id='node_'+sequence++;if(node.assetId)node.assetId=ids.get(node.assetId);(node.children||[]).forEach(canonical);}
   fixture.nodes.forEach(canonical);
   return {out,fixture};
  })()`);
  report.out.forEach(([v,m])=>ok(v,m));
  const canonical=JSON.stringify(report.fixture,null,2)+'\n';
  if(process.argv.includes('--write-fixture')){require('fs').mkdirSync(require('path').dirname(fixturePath),{recursive:true});require('fs').writeFileSync(fixturePath,canonical);}
  eq(require('fs').readFileSync(fixturePath,'utf8'),canonical,'JVM fixture exactly matches production factory export');
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
