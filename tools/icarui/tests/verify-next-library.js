// Reuse the established file:// browser harness, with an independent lifecycle.
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];
async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-next-library`,'--window-size=1600,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 try{
  for(let i=0;i<40;i++){try{await getJson('/json/version');break;}catch(e){await sleep(250);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});await waitReady(cdp);
  await require('./_common').stubDialogs(cdp);
  const results=await cdp.eval(`(()=>{
   const out=[],check=(v,m)=>out.push([!!v,m]);const S=CanvasState;
   check(NEXT_CONTROLS.length===15,'15 production variants');
   for(const v of [null,undefined,NaN,Infinity,-Infinity])check(formatGaugePreview({min:0,max:20},v)==='--','invalid data '+String(v));
   check(formatGaugePreview({min:0,max:20},13.8)==='13.8','voltage decimal');
   check(formatGaugePreview({min:0,max:8000},1234.5)==='1234','RPM matches App truncation');
   check(document.querySelector('#nextLibrary')!==null,'visible top library entry');
   NEXT_CONTROLS.forEach(c=>{const n=c.make(),g=n.children.find(n=>n.type==='gauge');
    const info=BUILTIN_PIDS[g.pid];check(!!info&&g.min===info.min&&g.max===info.max,c.key+' actual PID/range');
    check(n.children[0].assetId&&S.design.assets.some(a=>a.id===n.children[0].assetId&&a.data.startsWith('data:image/png')),c.key+' embedded PNG');
   });
   const old=JSON.stringify(S.design.canvas);
   for(const dims of [[2560,1600],[1600,2560],[1920,1080]])for(const mode of [0,1,2]){
    Object.assign(S.design.canvas,{designW:dims[0],designH:dims[1],scaleMode:mode});
    applyCanvasSize();const m=nodeToCanvasMatrix();
    const n=NEXT_CONTROLS[0].make(),im=n.children[0];
    check(Math.abs(im.w*m.a/(im.h*m.d)-1)<.015,'new image aspect '+dims+'/'+mode);
    const legacy=BUILTIN_CONTROLS.find(c=>!c.next&&c.make().type==='image');
    if(legacy){const a=legacy.make();check(Number.isFinite(a.w)&&a.w>0,'legacy image geometry '+dims+'/'+mode);}
    for(const aspect of [.5,1,2]){
     const image=prepareBuiltinImages(createNode(NODE_IMAGE,{w:80*aspect,h:80}));
     check(Math.abs(image.w*m.a/(image.h*m.d)-aspect)<.03,'template physical aspect '+aspect+' '+dims+'/'+mode);
    }
   }
   Object.assign(S.design.canvas,JSON.parse(old));applyCanvasSize();
   const cv=document.getElementById('cv'),r=cv.getBoundingClientRect(),dt=new DataTransfer();dt.setData('application/x-ctrl','next_voltage_minimal');
   const before=S.design.nodes.length;cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));
   check(S.design.nodes.length===before+1,'actual drag/drop adds new control');
   const output=toV2Json(S.design),serialized=JSON.stringify(output);
   check(serialized.includes('assets/next/v1/minimal-panel.png'),'export references original panel');
   check(serialized.includes('obd.voltage'),'export retains semantic PID');
   check(PackKit.collectAssetRefs(JSON.parse(output),id=>S.design.assets.find(a=>a.id===id),path=>S.design.assets.find(a=>a.path===path)).some(a=>a.path==='assets/next/v1/minimal-panel.png'),'package collects new panel');
   const roundtrip=parseDesign(output);check(roundtrip.errors.length===0,'saved JSON parses');
   const previous=S.design;S.design=roundtrip.design;syncAssetImages();
   check(S.design.assets.filter(a=>a.path.startsWith('assets/next/')).every(a=>a.data&&a.data.startsWith('data:image/png')),'reopened JSON restores original PNG bytes');
   S.design=previous;
   return out;
  })()`);
  results.forEach(([v,m])=>ok(v,m));
  await sleep(500);
  const screenshot=await cdp.send('Page.captureScreenshot',{format:'png'});
  require('fs').writeFileSync(require('path').resolve(__dirname,'../../../stage/t11i-codex-20261012/production.png'),Buffer.from(screenshot.data,'base64'));
 }catch(e){ok(false,e.stack||e.message);}finally{if(cdp)cdp.ws.close();proc.kill();}
 console.log('PASS='+pass+' FAIL='+fail);process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);m._compile(prefix+'\n('+main.toString()+')();',base);
