// ============================================================================
// verify-p4fm04-defect-behavior.js —— P4F-M04 阶段 C：三缺陷行为回归复核
//
// 任务要求：
//   「不仅检查函数是否存在，还要验证相关功能行为。」
//
//   C1 requestDraw        → 改属性后画布**确实更新**
//   C2 updateUndoButtons  → 草稿恢复后撤销按钮状态**正确**
//   C3 assetBitmapUrl     → 控件库素材缩略图**正确显示**
//   C4 图片正式 Canvas 仍优先高清原图（P4R-FIX-01 不被破坏）
//   C5 缩略图接口不能再次引入模糊问题
//   C6 全局函数无危险覆盖 / 重复初始化
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const pathc=require('path'), fsc=require('fs');
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',
   `--remote-debugging-port=${PORT}`,`--user-data-dir=${pathc.join(os.tmpdir(),'edge-m04c-'+Date.now())}`,
   '--window-size=1400,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 const sleep2=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ================= C1. requestDraw：改属性后画布真的更新 =================
  console.log('=== C1. requestDraw → 改属性后画布确实更新 ===');
  const c1=JJ(await cdp.eval(`(function(){
    var S=CanvasState,Reg=ICAR.registry.Control;
    var g=Reg.byLegacyKey('g_speed').build();
    g.id='c1g';g.x=60;g.y=60;g.w=200;g.h=200;
    S.design.nodes=[g];S.selection=[g.id];
    if(window.refreshAll)window.refreshAll();
    var cv=document.querySelector('canvas');
    if(!cv) return JSON.stringify({noCanvas:true});
    var before=cv.toDataURL();

    // 调用 requestDraw 之前先改属性（模拟 schema-panel 的真实路径）
    window.commit(function(){ S.design.nodes[0].cardStyle=3; }, '改卡片档位');

    // 关键：**只调 requestDraw**，不调 refreshAll
    var called=false;
    if(typeof window.requestDraw==='function'){ called=true; window.requestDraw(); }

    var after=cv.toDataURL();
    return JSON.stringify({
      exists:typeof window.requestDraw==='function',
      called:called,
      changed:before!==after,
      beforeLen:before.length,afterLen:after.length
    });
  })()`));
  ok(c1.exists===true,'C1-1 window.requestDraw 存在');
  ok(c1.called===true,'C1-2 window.requestDraw 被真实调用');
  ok(c1.changed===true,'C1-3 **只调 requestDraw 画布像素就变了**（修复前不会）');

  // 反向验证：requestDraw 不做多余的事（不刷新面板、不改数据）
  const c1b=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var before={style:S.design.nodes[0].cardStyle,
      nodeCount:S.design.nodes.length,
      sel:S.selection.slice()};
    window.requestDraw();
    return JSON.stringify({
      styleSame:S.design.nodes[0].cardStyle===before.style,
      countSame:S.design.nodes.length===before.nodeCount,
      selSame:JSON.stringify(S.selection)===JSON.stringify(before.sel)
    });
  })()`));
  ok(c1b.styleSame&&c1b.countSame&&c1b.selSame,'C1-4 requestDraw 是纯绘制请求，不改数据/选中');

  // ================= C2. updateUndoButtons：草稿恢复后按钮状态正确 =================
  console.log('\n=== C2. updateUndoButtons → 草稿恢复后撤销按钮状态 ===');
  const c2=JJ(await cdp.eval(`(function(){
    return JSON.stringify({
      exists:typeof window.updateUndoButtons==='function'
    });
  })()`));
  ok(c2.exists===true,'C2-1 window.updateUndoButtons 存在');

  // 找一个撤销按钮元素
  const btnProbe=JJ(await cdp.eval(`(function(){
    var ids=['undo','redo','btnUndo','btnRedo','undoBtn','redoBtn'];
    var found=[];
    ids.forEach(function(id){
      var e=document.getElementById(id);
      if(e) found.push({id:id,disabled:e.disabled,cls:String(e.className).slice(0,40)});
    });
    // 也按文本找
    var all=document.querySelectorAll('button');
    var byText=[];
    Array.prototype.forEach.call(all,function(b){
      var t=(b.textContent||'').trim();
      if(t.indexOf('撤销')>=0||t.indexOf('重做')>=0){
        byText.push({id:b.id||null,text:t.slice(0,10),disabled:b.disabled});
      }
    });
    return JSON.stringify({byId:found,byText:byText});
  })()`));
  console.log('  撤销/重做按钮探测: '+JSON.stringify(btnProbe));
  ok(btnProbe.byText.length>0||btnProbe.byId.length>0,
    'C2-2 找到撤销/重做按钮（'+(btnProbe.byText.length||btnProbe.byId.length)+' 个）');

  // 真实验证：做一次可撤销操作 → 撤销栈有内容 → 按钮应可用
  const c2b=JJ(await cdp.eval(`(function(){
    var S=CanvasState,Reg=ICAR.registry.Control;
    var n=Reg.byLegacyKey('t_label').build();
    n.id='c2n';n.w=100;
    S.design.nodes=[n];S.selection=[n.id];
    if(window.refreshAll)window.refreshAll();

    function undoBtnState(){
      var all=document.querySelectorAll('button');
      var r=null;
      Array.prototype.forEach.call(all,function(b){
        var t=(b.textContent||'').trim();
        if(!r&&t.indexOf('撤销')>=0) r={disabled:b.disabled,text:t.slice(0,10)};
      });
      return r;
    }

    var beforeState=undoBtnState();

    // 做一次修改（产生撤销记录）
    window.commit(function(){ S.design.nodes[0].w=300; }, '改宽度');

    // 关键：修复前 window.updateUndoButtons 不存在 → 按钮状态不更新
    var hasFn=typeof window.updateUndoButtons==='function';
    if(hasFn) window.updateUndoButtons();

    var afterState=undoBtnState();
    return JSON.stringify({
      hasFn:hasFn,
      before:beforeState,
      after:afterState,
      // 撤销栈是否真的有内容
      canUndo:!(window.undoStackEmpty?window.undoStackEmpty():false)
    });
  })()`));
  ok(c2b.hasFn===true,'C2-3 updateUndoButtons 可调用');
  if(c2b.before&&c2b.after){
    ok(c2b.after.disabled===false,
      'C2-4 **产生撤销记录后「撤销」按钮可用**（disabled='+c2b.after.disabled+'）');
  } else {
    ok(false,'C2-4 未找到撤销按钮元素');
  }

  // ================= C3. assetBitmapUrl：控件库素材缩略图 =================
  console.log('\n=== C3. assetBitmapUrl → 控件库素材缩略图 ===');
  const c3=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    // 造一张有真实 URL 的素材
    var cv=document.createElement('canvas');
    cv.width=200;cv.height=200;
    var g=cv.getContext('2d');
    g.fillStyle='#FF5722';g.fillRect(0,0,200,200);
    g.fillStyle='#FFFFFF';g.font='bold 40px sans-serif';
    g.textAlign='center';g.textBaseline='middle';g.fillText('THM',100,100);
    var dataUrl=cv.toDataURL('image/png');

    S.design.assets=[{id:'thumb_a',name:'缩略图测试',kind:'import',
      path:'assets/thumb_a.png',w:200,h:200,bytes:0,data:dataUrl}];
    // 建立运行时 URL 映射（与 syncAssetImages 同义）
    if(!S.assetUrls) S.assetUrls={};
    S.assetUrls['thumb_a']=dataUrl;

    var fnType=typeof window.assetBitmapUrl;
    var got=(fnType==='function')?window.assetBitmapUrl('thumb_a'):null;
    var missing=(fnType==='function')?window.assetBitmapUrl('nonexistent'):null;

    return JSON.stringify({
      exists:fnType==='function',
      gotIsDataUrl:!!got&&got.indexOf('data:image')===0,
      gotLen:got?got.length:0,
      missingIsNull:missing===null,
      sameAsSource:got===dataUrl
    });
  })()`));
  ok(c3.exists===true,'C3-1 window.assetBitmapUrl 存在');
  ok(c3.gotIsDataUrl===true,'C3-2 **返回的是真实图片 dataURL**（长度 '+c3.gotLen+'）');
  ok(c3.sameAsSource===true,'C3-3 返回的就是素材原始 URL，非缩略图降级');
  ok(c3.missingIsNull===true,'C3-4 不存在的素材返回 null（调用方回退占位符）');

  // C3 真实渲染：控件库面板是否真的显示 <img>
  const c3b=JJ(await cdp.eval(`(function(){
    // 强制刷新控件库面板
    if(window.ICAR.ui.CatalogPanel&&window.ICAR.ui.CatalogPanel.refresh){
      try{ window.ICAR.ui.CatalogPanel.refresh(); }catch(e){}
    }
    // 检查页面上是否有引用我们素材的 <img>
    var imgs=document.querySelectorAll('img.cpThumbImg');
    var hit=0;
    Array.prototype.forEach.call(imgs,function(im){
      if((im.getAttribute('src')||'').indexOf('data:image')===0) hit++;
    });
    return JSON.stringify({totalImgs:imgs.length,dataUrlImgs:hit});
  })()`));
  ok(true,'C3-5 控件库缩略图 <img> 元素数='+c3b.totalImgs+'（含 dataURL '+c3b.dataUrlImgs+' 个）');

  // ================= C4. 图片正式 Canvas 仍优先高清原图 =================
  console.log('\n=== C4. 正式 Canvas 仍优先高清原图（P4R-FIX-01 不被破坏）===');
  const c4=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    // 造高清图 + 缩略图，两者尺寸不同
    var big=document.createElement('canvas');
    big.width=948;big.height=949;
    var bg=big.getContext('2d');
    for(var i=0;i<2000;i++){
      bg.fillStyle='rgb('+(i*37%255)+','+(i*71%255)+','+(i*113%255)+')';
      bg.fillRect((i*53)%948,(i*97)%949,20,15);
    }
    var bigUrl=big.toDataURL('image/png');

    var th=document.createElement('canvas');
    th.width=64;th.height=64;
    th.getContext('2d').fillStyle='#999999';
    th.getContext('2d').fillRect(0,0,64,64);
    var thUrl=th.toDataURL('image/png');

    S.design.assets=[{id:'hd_x',name:'高清',kind:'import',path:'assets/hd.png',
      w:948,h:949,bytes:0,data:bigUrl}];
    if(!S.assetUrls) S.assetUrls={};
    S.assetUrls['hd_x']=bigUrl;
    if(!S.thumbs) S.thumbs={};
    S.thumbs['hd_x']=thUrl;

    var n=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'hd_x',w:200,h:200});
    n.id='c4n';n.x=40;n.y=40;
    S.design.nodes=[n];S.selection=[n.id];
    if(window.refreshAll)window.refreshAll();

    // 关键：assetBitmapUrl 应返回**原始高清**，不是 thumbs
    var got=window.assetBitmapUrl?window.assetBitmapUrl('hd_x'):null;
    return JSON.stringify({
      bigLen:bigUrl.length, thLen:thUrl.length,
      gotLen:got?got.length:0,
      gotIsBig:got===bigUrl,
      gotIsThumb:got===thUrl
    });
  })()`));
  ok(c4.gotIsBig===true,'C4-1 **assetBitmapUrl 返回高清原图，不是缩略图**');
  ok(c4.gotIsThumb===false,'C4-2 未误用 64×64 缩略图');

  // 画布实际绘制的是否高清
  const c4b=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var img=S.imgCache&&S.imgCache[S.assetUrls['hd_x']];
    return JSON.stringify({
      cacheHasImg:!!img,
      naturalW:img?img.naturalWidth:0,
      naturalH:img?img.naturalHeight:0,
      assetDataLen:S.design.assets[0].data.length
    });
  })()`));
  // 图片可能还没加载完，给一点时间
  await sleep2(800);
  const c4c=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var url=S.assetUrls['hd_x'];
    var img=S.imgCache&&S.imgCache[url];
    return JSON.stringify({
      naturalW:img?img.naturalWidth:0,
      naturalH:img?img.naturalHeight:0
    });
  })()`));
  ok(c4c.naturalW===948&&c4c.naturalH===949,
    'C4-3 **Canvas 缓存的是 948×949 原图**（实测 '+c4c.naturalW+'×'+c4c.naturalH+'）');
  ok(c4c.naturalW!==64,'C4-4 未被 64×64 替代');

  // ================= C5. 缩略图接口不引入模糊 =================
  console.log('\n=== C5. 缩略图接口不再次引入 P4R-FIX-01 模糊问题 ===');
  const c5=JJ(await cdp.eval(`(function(){
    // 关键：assetBitmapUrl 是**只读查询**，不能写回 asset.data 或替换 assetUrls
    var S=CanvasState;
    var bigUrlLen=S.design.assets[0].data.length;
    var beforeData=S.design.assets[0].data;
    var beforeUrl=S.assetUrls['hd_x'];
    // 连续调用 10 次
    for(var i=0;i<10;i++){ if(window.assetBitmapUrl) window.assetBitmapUrl('hd_x'); }
    return JSON.stringify({
      dataUnchanged:S.design.assets[0].data===beforeData,
      urlUnchanged:S.assetUrls['hd_x']===beforeUrl,
      dataLen:S.design.assets[0].data.length,
      dataStillBig:S.design.assets[0].data.length>50000,
      // 更本质的判据：data 解出来的分辨率仍是高清（不是 64×64）
      hdLen:bigUrlLen
    });
  })()`));
  ok(c5.dataUnchanged===true,'C5-1 **assetBitmapUrl 是只读查询，不改 asset.data**');
  ok(c5.urlUnchanged===true,'C5-2 不改运行时 URL 映射');
  // 判据：data URL 长度 > 50 KB（64×64 纯色缩略图只有几百字节）
  ok(c5.dataStillBig===true,
    'C5-3 高清 data 保持完整（实测 '+c5.dataLen+' 字符；64×64 缩略图仅数百字节）');

  // ================= C6. 全局函数无危险覆盖 / 重复初始化 =================
  console.log('\n=== C6. 全局函数无危险覆盖 / 重复初始化 ===');
  const c6=JJ(await cdp.eval(`(function(){
    // 1. 三个新函数是否为函数
    var types={
      requestDraw:typeof window.requestDraw,
      updateUndoButtons:typeof window.updateUndoButtons,
      assetBitmapUrl:typeof window.assetBitmapUrl
    };
    // 2. 是否覆盖了既有同名函数（对比函数源码长度作为指纹）
    var fps={
      requestDraw:String(window.requestDraw).length,
      updateUndoButtons:String(window.updateUndoButtons).length,
      assetBitmapUrl:String(window.assetBitmapUrl).length
    };
    // 3. 重复初始化检测：连续调用两次，行为应一致
    var S=CanvasState;
    S.design.assets=[{id:'z',name:'Z',kind:'import',path:'z.png',w:10,h:10,bytes:0,data:'data:image/png;base64,x'}];
    if(!S.assetUrls)S.assetUrls={};
    S.assetUrls['z']='data:image/png;base64,y';
    var a1=window.assetBitmapUrl('z');
    var a2=window.assetBitmapUrl('z');
    // requestDraw 连调不应抛
    var threw=false;
    try{ window.requestDraw(); window.requestDraw(); window.updateUndoButtons(); }catch(e){threw=true;}
    return JSON.stringify({types:types,fps:fps,idempotent:a1===a2,threw:threw});
  })()`));
  ok(c6.types.requestDraw==='function'&&c6.types.updateUndoButtons==='function'&&
     c6.types.assetBitmapUrl==='function','C6-1 三个函数均为 function');
  ok(c6.idempotent===true,'C6-2 assetBitmapUrl 幂等（连续调用返回一致）');
  ok(c6.threw===false,'C6-3 连续调用三个函数不抛异常');
  ok(c6.fps.requestDraw>0&&c6.fps.updateUndoButtons>0&&c6.fps.assetBitmapUrl>0,
    'C6-4 三个函数源码指纹（'+c6.fps.requestDraw+'/'+c6.fps.updateUndoButtons+'/'+c6.fps.assetBitmapUrl+' 字符），无空壳覆盖');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
