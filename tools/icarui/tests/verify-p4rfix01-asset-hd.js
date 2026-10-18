// ============================================================================
// verify-p4rfix01-asset-hd.js —— P4R-FIX-01 草稿恢复图片模糊专项修复
//
// 回归点：
//   A. 导入高清图 → asset.data 有原图（不再是空）→ 草稿可恢复
//   B. 恢复后 Canvas 实际绘制源保持原始分辨率（不是 64×64）
//   C. 缩略图不污染正式绘制缓存（restoreThumbs 不写 assetUrls）
//   D. 同一原图导入两次、不同素材 ID → 两个都高清
//   E. 明确降级：只有缩略图时用缩略图并被标记
//   F. 旧草稿兼容诊断（legacy/missing 计数）
//   G. Undo/Redo 不受影响
//   H. 超大图不内联（dataSkipped=too-large）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-fix01s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // 工具函数：造真 JPEG File
  await cdp.eval(`window.__mkJpeg=async function(w,h){
    var c=document.createElement('canvas');c.width=w;c.height=h;
    var x=c.getContext('2d');var g=x.createLinearGradient(0,0,w,h);
    g.addColorStop(0,'#f00');g.addColorStop(0.5,'#0f0');g.addColorStop(1,'#00f');
    x.fillStyle=g;x.fillRect(0,0,w,h);
    var blob=await new Promise(function(res){c.toBlob(res,'image/jpeg',0.92);});
    return new File([blob],'img-'+w+'x'+h+'.jpg',{type:'image/jpeg'});
  };`);

  // ---------- A/B. 导入 948×949 → 保存 → 恢复 → 仍是原分辨率 ----------
  const A=JJ(await cdp.eval(`(async function(){
    var f=await window.__mkJpeg(948,949);
    var a=await new Promise(function(res){window.importAsset(f,'custom',res);});
    window.commit(function(){CanvasState.design.assets.push(a);},'add');
    var D=ICAR.ui.DraftManager,DS=ICAR.ui.DraftStore;
    await new Promise(function(r){setTimeout(r,1600);});
    await D.flush('force');
    var id=D.currentDesignId();
    var g=await DS.getDraft('draft_'+id);
    var o=JSON.parse(g.record.designJson);
    var saved=o.assets.find(function(x){return x.id===a.id;});
    return JSON.stringify({assetId:a.id,fileSize:f.size,
      liveDataLen:a.data?a.data.length:0,
      savedDataLen:saved&&saved.data?saved.data.length:0,
      savedW:saved&&saved.w,savedH:saved&&saved.h,
      rawFileStillEmpty:JSON.stringify(saved&&saved.rawFile)==='{}'});
  })()`));
  ok(A.liveDataLen>1000,'A1 导入后 asset.data 含原图（' + A.liveDataLen + ' 字节）');
  ok(A.savedDataLen===A.liveDataLen,'A2 草稿 asset.data 原样持久化');
  ok(A.savedW===948&&A.savedH===949,'A3 素材记录为原图尺寸（' + A.savedW + '×' + A.savedH + '）');

  const B=JJ(await cdp.eval(`(async function(){
    var S=CanvasState;
    // 模拟刷新：清运行时缓存，走 restoreThumbs + syncAssetImages
    S.assetUrls={};S.imgCache={};
    window.restoreThumbs();
    window.syncAssetImages();
    await new Promise(function(r){setTimeout(r,900);});
    var id=Object.keys(S.assetUrls)[0];
    var url=S.assetUrls[id];var im=S.imgCache[url];
    return JSON.stringify({w:im?im.naturalWidth:0,h:im?im.naturalHeight:0,
      isOriginal:url?url.indexOf('data:image/jpeg')===0:false,
      stats:window.__assetDrawStats()});
  })()`));
  ok(B.w===948&&B.h===949,'B1 **恢复后 Canvas 绘制源保持 948×949 原分辨率**（实际 ' + B.w + '×' + B.h + '）');
  ok(B.isOriginal===true,'B2 绘制源是原图 dataURL（非缩略图）');
  ok(B.stats.level[Object.keys(B.stats.level)[0]]===3,'B3 素材等级为 3（原图）');

  // ---------- C. 缩略图不污染主缓存 ----------
  const C=JJ(await cdp.eval(`(async function(){
    var S=CanvasState;
    // 往缩略图缓存塞一个 64px
    var c=document.createElement('canvas');c.width=64;c.height=64;
    c.getContext('2d').fillRect(0,0,64,64);
    var th=c.toDataURL('image/png');
    var id=Object.keys(S.assetUrls)[0];
    window.__assetThumbUrls[id]=th;
    S.assetUrls={};S.imgCache={};
    window.restoreThumbs();
    var afterThumbs=Object.keys(S.assetUrls).length;
    window.syncAssetImages();
    await new Promise(function(r){setTimeout(r,800);});
    var url=S.assetUrls[id];var im=S.imgCache[url];
    return JSON.stringify({afterThumbs:afterThumbs,w:im?im.naturalWidth:0});
  })()`));
  ok(C.afterThumbs===0,'C1 restoreThumbs 不写 assetUrls（缩略图不占主槽）');
  ok(C.w===948,'C2 缩略图存在时仍优先高清（' + C.w + '）');

  // ---------- D. 同一图两次导入不同 ID ----------
  const D=JJ(await cdp.eval(`(async function(){
    var f1=await window.__mkJpeg(948,949);
    var f2=await window.__mkJpeg(948,949);
    var a1=await new Promise(function(res){window.importAsset(f1,'custom',res);});
    var a2=await new Promise(function(res){window.importAsset(f2,'custom',res);});
    window.commit(function(){CanvasState.design.assets.push(a1,a2);},'dup');
    var S=CanvasState;S.assetUrls={};S.imgCache={};
    window.syncAssetImages();
    await new Promise(function(r){setTimeout(r,900);});
    var i1=S.imgCache[S.assetUrls[a1.id]],i2=S.imgCache[S.assetUrls[a2.id]];
    return JSON.stringify({diffId:a1.id!==a2.id,w1:i1?i1.naturalWidth:0,w2:i2?i2.naturalWidth:0});
  })()`));
  ok(D.diffId===true,'D1 两个素材 ID 不同');
  ok(D.w1===948&&D.w2===948,'D2 **两个控件都显示高清**（' + D.w1 + ' / ' + D.w2 + '）');

  // ---------- E. 明确降级 ----------
  const E=JJ(await cdp.eval(`(async function(){
    var S=CanvasState;
    var c=document.createElement('canvas');c.width=64;c.height=64;
    c.getContext('2d').fillStyle='#0f0';c.getContext('2d').fillRect(0,0,64,64);
    var th=c.toDataURL('image/png');
    var a={id:'fixOnlyThumb',name:'only-thumb',kind:'custom',path:'',w:64,h:64,bytes:1,data:''};
    window.commit(function(){S.design.assets.push(a);},'degr');
    window.__assetThumbUrls['fixOnlyThumb']=th;
    delete S.assetUrls['fixOnlyThumb'];
    window.syncAssetImages();
    await new Promise(function(r){setTimeout(r,600);});
    var url=S.assetUrls['fixOnlyThumb'];var im=url?S.imgCache[url]:null;
    var st=window.__assetDrawStats();
    return JSON.stringify({w:im?im.naturalWidth:0,level:st.level['fixOnlyThumb'],
      degraded:st.degraded.indexOf('fixOnlyThumb')>=0});
  })()`));
  ok(E.w===64,'E1 无原图时用缩略图（64）');
  ok(E.level===1&&E.degraded===true,'E2 明确标记为降级（level=1 + degraded）');

  // ---------- F. 旧草稿兼容诊断 ----------
  const F=JJ(await cdp.eval(`(function(){return JSON.stringify(window.__assetCompatReport());})()`));
  ok(typeof F.legacyCount==='number','F1 __assetCompatReport 可用');
  ok(F.legacyCount>=1,'F2 旧草稿降级素材被计入 legacyCount（' + F.legacyCount + '）');

  // ---------- G. Undo/Redo ----------
  const G=JJ(await cdp.eval(`(function(){
    var S=CanvasState,u=window.__undoStack;
    var before=S.design.assets.length;
    window.doUndo();var und=S.design.assets.length;
    window.doRedo();var red=S.design.assets.length;
    return JSON.stringify({before:before,und:und,red:red});
  })()`));
  ok(G.und!==G.before,'G1 撤销会回退素材');
  ok(G.red===G.before,'G2 重做恢复素材');

  // ---------- H. 超大图不内联 ----------
  const H=JJ(await cdp.eval(`(async function(){
    var f=await window.__mkJpeg(4000,4000);
    var a=await new Promise(function(res){window.importAsset(f,'custom',res);});
    return JSON.stringify({fileSize:f.size,dataLen:a.data?a.data.length:0,
      skipped:a.dataSkipped||'',w:a.w,h:a.h});
  })()`));
  ok(H.dataLen===0||H.dataLen<=4*1024*1024,'H1 超过上限的图不内联（data 长度 ' + H.dataLen + '）');
  ok(H.w===4000&&H.h===4000,'H2 超大图仍记录真实尺寸');
  if(H.dataLen===0) ok(H.skipped==='too-large','H3 明确标记 dataSkipped=too-large');

  // ---------- 兼容：内置素材仍正常 ----------
  const I=JJ(await cdp.eval(`(function(){
    var R=ICAR.registry.Control;
    var n=R.byLegacyKey('lamp_tpms').build();
    return JSON.stringify({built:!!n,type:n&&n.type});
  })()`));
  ok(I.built===true,'I1 内置图片控件仍可创建（' + I.type + '）');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
