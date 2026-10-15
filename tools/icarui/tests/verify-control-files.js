const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-control-files`,'--window-size=1600,1000','about:blank'],{stdio:'ignore'});let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);await require('./_common').stubDialogs(cdp);
  const appRoot=require('path').resolve(__dirname,'../../../app/src/main');
  const read=p=>require('fs').readFileSync(require('path').join(appRoot,p),'utf8');
  const models=read('java/com/icar/obd/data/PidModels.kt'),factory=read('java/com/icar/obd/ui/view/GaugeViewFactory.kt');
  ok(/STYLE_CIRCLE\s*=\s*0/.test(models)&&/STYLE_DIGITAL\s*=\s*1/.test(models)&&/STYLE_GFORCE\s*=\s*7/.test(models),'App scalar style constants are 0/1; 7 is G force');
  ok(/STYLE_CIRCLE\s*->\s*CircularGaugeView/.test(factory)&&/STYLE_DIGITAL\s*->\s*DigitalGaugeView/.test(factory),'App factory consumes the intended scalar views');
  ok(/RING_TICK\s*=\s*1/.test(models)&&read('java/com/icar/obd/ui/view/CircularGaugeView.kt').includes('item.ringSegments'),'App circular view consumes the segmented ring');
  const colors=read('res/values/colors.xml');ok(/name="warn">#FFFFB020</.test(colors)&&/name="danger">#FFFF4D4F</.test(colors),'preview warning/danger colors match App resources');
  for(let index=0;index<15;index++){
   const checks=await cdp.eval(`(async()=>{
    const out=[],check=(v,m)=>out.push([!!v,m]),S=CanvasState,original=clone(S.design.canvas);
    for(const source of [[2560,1600,0],[1600,2560,0],[1920,1080,1]]){
     Object.assign(S.design.canvas,{designW:source[0],designH:source[1],scaleMode:source[2]});
     const n=NEXT_CONTROLS[${index}].make(),file=makeControlFile(n,S.design),sourceR=source[2]===0?source[0]/source[1]:1;
     check(file.kind==='icar.control/2'&&file.assets.length===1,'variant ${index} carries its bitmap '+source);
     const visibleFrame=n.children[0];check(visibleFrame.x>=-.001&&visibleFrame.y>=-.001&&visibleFrame.x+visibleFrame.w<=n.w+.001&&visibleFrame.y+visibleFrame.h<=n.h+.001,'variant ${index} fresh panel stays inside the group bounds '+source);
     for(const target of [[1600,2560,0],[2560,1600,0],[1920,1080,1],[1920,1080,2]]){
      const d=clone(S.design);Object.assign(d.canvas,{designW:target[0],designH:target[1],scaleMode:target[2]});d.assets=[];
      const before=JSON.stringify(d),result=await prepareControlFile(file,d),root=result.control.node,frame=root.children[0];
      const targetR=target[2]===0?target[0]/target[1]:1,sourceFrame=n.children[0];
      check(Math.abs(frame.w/frame.h*targetR-sourceFrame.w/sourceFrame.h*sourceR)<.002,'variant ${index} physical image ratio '+source+'/'+target);
      const oldGauge=n.children.find(n=>n.type==='gauge'),gauge=root.children.find(n=>n.type==='gauge');
      const k=Math.min(sourceR,1)/Math.min(targetR,1);
      check(Math.abs(gauge.w/oldGauge.w-k)<.002&&Math.abs(gauge.h/oldGauge.h-k)<.002,'variant ${index} native gauge uniform geometry '+source+'/'+target);
      check(Math.abs((gauge.x+gauge.w/2)-(frame.x+frame.w/2))<.03&&Math.abs((gauge.y+gauge.h/2)-(frame.y+frame.h/2))<.03,'variant ${index} panel and gauge centres remain aligned');
      check(result.assets[0].id!==file.assets[0].id&&frame.assetId===result.assets[0].id&&result.assets[0].data===file.assets[0].data,'variant ${index} remaps references and preserves bytes');
      check(JSON.stringify(d)===before,'variant ${index} preparation is atomic');
     }
    }Object.assign(S.design.canvas,original);
    const control=NEXT_CONTROLS[${index}],gauge=control.make().children.find(n=>n.type==='gauge');
    check(gauge.style===(control.variant==='minimal'?1:0),'variant ${index} uses the App scalar gauge style');
    if(control.variant==='sport')check(gauge.ringStyle===1&&gauge.ringSegments===32,'sport uses the supported segmented circular ring');
    const savedValues=S.previewValues,savedSprings=S.simSprings;S.simSprings={active:true,peek:()=>gauge.max*2};
    const preview=document.createElement('canvas');preview.width=200;preview.height=200;
    const fill=CanvasRenderingContext2D.prototype.fillText;let readings=[];
    CanvasRenderingContext2D.prototype.fillText=function(text,x,y){readings.push([String(text),x,y,this.fillStyle.toUpperCase()]);return fill.apply(this,arguments);};
    let prior=0;
    try{for(const value of [gauge.min,(gauge.min+gauge.max)/2,gauge.max,gauge.min-1,gauge.max+1]){
     S.previewValues={[gauge.pid]:value};readings=[];drawNodePreview(gauge,preview);
     const y=gauge.style===1?gauge.h/2:gauge.h/2+Math.min(gauge.w,gauge.h)*.36*.52;
     const span=gauge.max-gauge.min,expected=span>=1000?String(Math.trunc(value)):value.toFixed(span>=100?0:span>=10?1:2);
     const level=gaugePreviewAlertLevel(gauge,value,prior);prior=level;const color=level===2?'#FF4D4F':level===1||level===3?'#FFB020':null;
     check(readings.some(t=>t[0]===expected&&Math.abs(t[1]-gauge.w/2)<.001&&Math.abs(t[2]-y)<.001&&(color===null||t[3]===color)),'variant ${index} min/mid/max/out-of-range true readout '+value);
    }}finally{CanvasRenderingContext2D.prototype.fillText=fill;S.previewValues=savedValues;S.simSprings=savedSprings;}
    return out;
   })()`);checks.forEach(([v,m])=>ok(v,m));
  }
  const security=await cdp.eval(`(async()=>{
   const S=CanvasState,out=[],check=(v,m)=>out.push([!!v,m]);const file=makeControlFile(NEXT_CONTROLS[0].make(),S.design);
   for(const mutate of [f=>f.assets[0].path='../secret.png',f=>f.assets[0].path='https://bad/image.png',f=>f.assets[0].data='data:image/svg+xml;base64,PHN2Zz4=',f=>f.assets[0].data='data:image/png;base64,iVBORw0KGgo=',f=>f.assets.push(clone(f.assets[0])),f=>f.assets=[],f=>f.canvas.designW=0,f=>f.node.children[0].assetId='',f=>f.node.children[1].pid='x'.repeat(257)]){
    const bad=clone(file);mutate(bad);let rejected=false;const before=JSON.stringify(S.design);
    try{await prepareControlFile(bad,S.design);}catch(e){rejected=true;}
    check(rejected&&JSON.stringify(S.design)===before,'malformed control rejected without changing design');
   }
   const legacy={kind:'icar.control/1',name:'old',node:nodeToJson(createNode(NODE_GAUGE,{pid:'obd.rpm',x:15,y:20,w:90,h:90}))};
   const old=await prepareControlFile(legacy,S.design);check(old.control.node.x===15&&old.control.node.w===90,'legacy file coordinates preserved');
   const text=makeControlFile(createNode(NODE_TEXT,{text:'custom',w:120,h:30,font:{size:10,letterSpacing:2}}),S.design);
   text.canvas={designW:2560,designH:1600,scaleMode:0};const target=clone(S.design);target.canvas={designW:1600,designH:2560,scaleMode:0};
   const scaled=await prepareControlFile(text,target);check(Math.abs(scaled.control.node.font.size-16)<.01&&Math.abs(scaled.control.node.font.letterSpacing-3.2)<.01,'custom font size and letter spacing migrate together');
   const allocate=newId;let allocations=0;const occupied=S.design.assets[0].id;
   window.newId=()=>++allocations===1?occupied:allocate('as');
   try{const unique=await prepareControlFile(file,S.design);check(unique.assets[0].id!==occupied&&allocations>=2,'allocator retries an existing asset ID');}finally{window.newId=allocate;}
   const saved={springs:S.simSprings,anim:S.anim,tween:S.tweenValues};S.simSprings={active:true,peek:()=>5678};S.anim={allows:()=>true};
   for(const raw of [null,undefined,NaN,Infinity,-Infinity,'12',1e40])check(needleValue('std_0C',raw)===null,'invalid data does not revive spring '+String(raw));
   S.anim={allows:()=>false};S.tweenValues={std_0C:2345};check(needleValue('std_0C',null)===2345,'explicit self-test tween preserved');
   S.tweenValues={std_0C:NaN};check(needleValue('std_0C',null)===null,'invalid tween rejected');
   S.simSprings=saved.springs;S.anim=saved.anim;S.tweenValues=saved.tween;
   const voltage={min:0,max:20,warnLow:11.8,warnHigh:15.2};
   check(formatGaugePreview(voltage,13.85)==='13.9','voltage rounding uses App Float precision');
   check(formatGaugePreview(voltage,15.95)==='15.9','opposite half-step rounding uses App Float precision');
   check(formatGaugePreview(voltage,-0)==='-0.0','negative zero matches App formatter');
   check(formatGaugePreview(voltage,1e40)==='--','Float overflow is unknown');
   check(gaugePreviewAlertLevel(voltage,1e40,2)===0,'Float overflow also clears the alert');
   check(formatGaugePreview({min:0,max:8000},1e20)==='2147483647','integer conversion matches Kotlin saturation');
   for(const [value,prior,wanted] of [[13.8,0,0],[11.8,0,3],[12.2,3,3],[12.4,3,0],[15.2,0,1],[14.8,1,1],[14.8,0,0],[18,0,2],[17.2,2,2],[16.9,2,1],[null,2,0]])check(gaugePreviewAlertLevel(voltage,value,prior)===wanted,'App threshold/hysteresis '+value+'/'+prior);
   const collision=clone(file);collision.assets[0].data=NEXT_LIBRARY.assets.find(a=>a.name==='sport-panel').data;
   const renamed=await prepareControlFile(collision,S.design);check(renamed.assets[0].path.startsWith('assets/imported-controls/'),'different bytes at same path get a unique package path');
   const savedValues=S.previewValues,savedSprings=S.simSprings;S.simSprings={active:false};
   const canvas=document.createElement('canvas');canvas.width=200;canvas.height=200;
   const fill=CanvasRenderingContext2D.prototype.fillText;let texts=[];
   CanvasRenderingContext2D.prototype.fillText=function(text,...args){texts.push([String(text),this.fillStyle.toUpperCase()]);return fill.call(this,text,...args);};
   try{for(const style of ['oem','sport','minimal']){
    const g=NEXT_CONTROLS.find(c=>c.key==='next_voltage_'+style).make().children.find(n=>n.type==='gauge');
    for(const [value,color] of [[16,'#FFB020'],[18,'#FF4D4F'],[null,null],[1e40,null]]){
     S.previewValues={std_42:value};texts=[];drawNodePreview(g,canvas);
     const wanted=formatGaugePreview(g,value);
     check(texts.some(t=>t[0]===wanted&&(color===null||t[1]===color)),'actual '+style+' readout and alert color '+wanted);
    }
   }}finally{CanvasRenderingContext2D.prototype.fillText=fill;S.previewValues=savedValues;S.simSprings=savedSprings;}
   return out;
  })()`);security.forEach(([v,m])=>ok(v,m));
  const actual=await cdp.eval(`(async()=>{
   const S=CanvasState;editBuiltinControl('next_voltage_minimal');
   const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let blob;
   URL.createObjectURL=b=>{blob=b;return 'blob:control-test';};HTMLAnchorElement.prototype.click=function(){};
   try{exportControlJson();}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}
   const payload=JSON.parse(await blob.text());document.getElementById('controlEditor')?.close?.();
   const savedClick=HTMLInputElement.prototype.click;let input;
   HTMLInputElement.prototype.click=function(){input=this;};try{importControlJson();}finally{HTMLInputElement.prototype.click=savedClick;}
   const prior=S.design.controls.length;Object.defineProperty(input,'files',{value:[new File([JSON.stringify(payload)],'sample.control.json',{type:'application/json'})]});input.onchange();
   for(let i=0;i<100&&S.design.controls.length===prior;i++)await new Promise(r=>setTimeout(r,20));
   const imported=S.design.controls[S.design.controls.length-1];
   S.design.nodes=[instantiateControl(imported.node,{x:0,y:0})];S.design.pages=[{id:'pg0',name:'test',nodes:S.design.nodes}];S.design.pageIndex=0;S.design.background={path:'',fit:0};
   await exportPackage();
   return [payload.kind==='icar.control/2',S.design.controls.length===prior+1,!!imported&&S.design.assets.some(a=>a.id===imported.node.children[0].assetId&&a.data),__lastPackReport.ok&&__lastPackReport.counts.assets===1&&__lastPackReport.counts.missing===0];
  })()`);actual.forEach((v,i)=>ok(v,'actual export/file-input path '+i));
  const zip=require('../js/zip.js').readZip(Buffer.from(await cdp.eval('window.__lastPackB64'),'base64'));
  const png=zip.entries.find(e=>e.name==='assets/next/v1/minimal-panel.png');
  ok(!!png&&Buffer.from(png.data).equals(require('fs').readFileSync(require('path').resolve(__dirname,'../assets/next/v1/minimal-panel.png'))),'independent ZIP readback matches original PNG bytes');
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
