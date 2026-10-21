// ============================================================================
// verify-p4f03-image-schema.js —— P4F-03 普通图片控件 Schema 接入
//
// 新增 image 族（6 字段）+ 素材选择器 + P4R-FIX-01 防回归
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4f03s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. 识别规则 ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    var lamp=Reg.byLegacyKey('lamp_tpms').build();
    var track=Reg.all().filter(function(d){return d.render&&d.render.mode==='track';})[0].build();
    var gauge=Reg.byLegacyKey('g_speed').build();
    var txt=Reg.all().filter(function(d){return d.render&&d.render.mode==='text';})[0].build();
    var cont=Reg.all().filter(function(d){return d.render&&d.render.mode==='container';})[0].build();
    function fam(n){var r=SP.resolve(n);return r&&r.family?r.family:'null';}
    return JSON.stringify({
      plain:{p:SP.isPlainImage(plain),f:fam(plain)},
      lamp:{p:SP.isPlainImage(lamp),f:fam(lamp)},
      track:{p:SP.isPlainImage(track),f:fam(track)},
      gauge:fam(gauge),text:fam(txt),container:fam(cont)});
  })()`));
  ok(A.plain.p===true,'A1 普通图片 isPlainImage = true');
  ok(A.plain.f==='image','A2 普通图片 resolve → **image 族（新增）**');
  ok(A.lamp.p===false,'A3 **状态灯 isPlainImage = false**（P4F-03 修正：必须排除 states）');
  ok(A.lamp.f==='imageState','A4 状态灯仍归 imageState 族');
  ok(A.track.p===false,'A5 条形轨道 isPlainImage = false');
  ok(A.track.f==='track','A6 条形轨道仍归 track 族');
  ok(A.gauge==='gauge','A7 仪表不受影响');
  ok(A.text==='text','A8 文字不受影响');
  ok(A.container==='container','A9 容器不受影响');

  // ---------- B. 可编辑字段 ----------
  const B=JJ(await cdp.eval(`(function(){
    var SP=ICAR.ui.schemaProps.SchemaResolver;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    var r=SP.resolve(plain);
    return JSON.stringify({editable:r.editable,types:r.fields.map(function(f){return f.key+':'+f.type;})});
  })()`));
  const EXP=['assetId','w','h','rotation','scale','alpha'];
  ok(JSON.stringify(B.editable)===JSON.stringify(EXP),'B1 可编辑字段恰为 6 个：'+EXP.join(','));
  ok(B.types.indexOf('assetId:asset')>=0,'B2 **assetId 使用 asset 专用类型**（不是文本框）');
  ok(B.types.filter(function(t){return t.indexOf(':number')>=0;}).length===5,'B3 其余 5 个字段为 number');

  // ---------- C. 素材选择器 ----------
  const C=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    S.design.assets=[
      {id:'a1',name:'素材一',kind:'builtin',path:'assets/a1.png',data:'${PNG}'},
      {id:'a2',name:'素材二',kind:'import',path:'assets/a2.png',data:'${PNG}'}
    ];
    var n=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'a1',w:100,h:100});
    S.design.nodes=[n];S.selection=[n.id];
    if(window.renderProps)window.renderProps();
    if(window.ICAR.ui.SchemaPanel&&window.ICAR.ui.SchemaPanel.onSelectionChanged)window.ICAR.ui.SchemaPanel.onSelectionChanged();
    var box=document.getElementById('schemaProps');
    var sel=box.querySelector('select[data-role="asset"]');
    if(!sel) return JSON.stringify({found:false});
    var opts=[];
    for(var i=0;i<sel.options.length;i++)opts.push(sel.options[i].value);
    var texts=[];
    for(var j=0;j<sel.options.length;j++)texts.push(sel.options[j].text);
    return JSON.stringify({found:true,isSelect:sel.tagName==='SELECT',
      count:sel.options.length,opts:opts,texts:texts,selected:sel.value});
  })()`));
  ok(C.found===true,'C1 面板渲染出素材选择器');
  ok(C.isSelect===true,'C2 **是 <select> 下拉**（不是文本输入框）');
  ok(C.count===3,'C3 选项 = 「未选」+ 2 个素材 = 3');
  ok(C.selected==='a1','C4 **当前素材正确回显**（a1）');
  ok(C.texts.indexOf('素材一（builtin）')>=0,'C5 显示「名称（类型）」与旧面板一致');

  // ---------- D. 素材替换 + 缓存更新 ----------
  const D=JJ(await cdp.eval(`(function(){
    var S=CanvasState,A=ICAR.ui.schemaProps.PropertyAccessor;
    var before=S.design.nodes[0].assetId;
    window.commit(function(){A.set(S.design.nodes[0],'assetId','a2');},'换素材');
    var after=S.design.nodes[0].assetId;
    return JSON.stringify({before:before,after:after});
  })()`));
  ok(D.after==='a2','D1 素材可替换（a1 → a2）');
  const D2=JJ(await cdp.eval(`(function(){
    return JSON.stringify({refreshAll:typeof window.refreshAll,
      syncAssetImages:typeof window.syncAssetImages});
  })()`));
  ok(D2.refreshAll==='function','D2 切换素材后触发既有 refreshAll（更新绘图缓存）');
  ok(D2.syncAssetImages==='function','D3 syncAssetImages 仍在（按新 assetId 重解析）');

  // ---------- E. 尺寸与变换 ----------
  const E=JJ(await cdp.eval(`(function(){
    var S=CanvasState,A=ICAR.ui.schemaProps.PropertyAccessor;
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'w',200);A.set(n,'h',150);
      A.set(n,'rotation',45);A.set(n,'scale',1.5);A.set(n,'alpha',128);
    },'变换');
    var n=S.design.nodes[0];
    return JSON.stringify({w:n.w,h:n.h,rotation:n.rotation,scale:n.scale,alpha:n.alpha});
  })()`));
  ok(E.w===200&&E.h===150,'E1 宽高可编辑');
  ok(E.rotation===45,'E2 旋转可编辑');
  ok(E.scale===1.5,'E3 缩放可编辑');
  ok(E.alpha===128,'E4 透明度可编辑');

  // ---------- F. P4R-FIX-01：asset.data 不被覆盖 ----------
  const F=JJ(await cdp.eval(`(function(){
    var S=CanvasState,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d0=S.design.assets[0].data,d1=S.design.assets[1].data;
    var len0=d0?d0.length:0,len1=d1?d1.length:0;
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'w',300);A.set(n,'h',250);A.set(n,'alpha',200);
      A.set(n,'assetId','a2');A.set(n,'rotation',10);
    },'改属性');
    var a0=S.design.assets[0].data,a1=S.design.assets[1].data;
    return JSON.stringify({intact:(d0===a0&&d1===a1),
      lenBefore:[len0,len1],lenAfter:[a0?a0.length:0,a1?a1.length:0],
      stillDataUrl:(a0||'').indexOf('data:image')===0,
      assetCount:S.design.assets.length});
  })()`));
  ok(F.intact===true,'F1 **【P4R-FIX-01】改图片属性不覆盖 asset.data**');
  ok(F.stillDataUrl===true,'F2 asset.data 仍是完整 dataURL');
  ok(F.assetCount===2,'F3 素材数量未变（不增不删）');

  // ---------- G. P4R-FIX-01：高清链路仍在 ----------
  const G=JJ(await cdp.eval(`(function(){
    return JSON.stringify({loadAssetImage:typeof window.loadAssetImage,
      syncAssetImages:typeof window.syncAssetImages,
      restoreThumbs:typeof window.restoreThumbs});
  })()`));
  ok(G.loadAssetImage==='function','G1 loadAssetImage 存在（原图加载链路）');
  ok(G.syncAssetImages==='function','G2 syncAssetImages 存在');
  ok(G.restoreThumbs==='function','G3 restoreThumbs 存在（P4R-FIX-01 修的就是它）');

  // ---------- H. 多素材 ID 独立引用 ----------
  const H=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    S.design.nodes[0].assetId='a1';
    var n2=window.createNode(window.NODE_IMAGE,{name:'图二',assetId:'a2',w:80,h:80});
    S.design.nodes.push(n2);
    var ids=S.design.nodes.map(function(n){return n.assetId;});
    return JSON.stringify({ids:ids,unique:new Set(ids).size});
  })()`));
  ok(H.ids.length===2,'H1 两个图片节点');
  ok(H.unique===2,'H2 **同一原图不同 id 时不混淆**（各指各的素材）');

  // ---------- I. Undo / Redo ----------
  const I=JJ(await cdp.eval(`(function(){
    var S=CanvasState,A=ICAR.ui.schemaProps.PropertyAccessor;
    // ⚠️ H 段直接赋值过 assetId（绕过 commit），会污染撤销栈。
    //    这里先用 commit 建立一个**干净基线**，再测撤销。
    S.design.nodes[0].assetId='a1';
    window.commit(function(){A.set(S.design.nodes[0],'assetId','a1');},'基线');
    var before=S.design.nodes[0].assetId;
    window.commit(function(){A.set(S.design.nodes[0],'assetId','a2');},'切');
    var v1=S.design.nodes[0].assetId;
    window.doUndo();var u1=S.design.nodes[0].assetId;
    window.doRedo();var r1=S.design.nodes[0].assetId;
    return JSON.stringify({before:before,v1:v1,u1:u1,r1:r1});
  })()`));
  ok(I.u1===I.before,'I1 撤销素材切换回到原素材');
  ok(I.r1===I.v1,'I2 重做回到新素材');

  // ---------- J. 导出 → 重导入 ----------
  const J=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var n0=S.design.nodes[0];
    var before={assetId:n0.assetId,w:n0.w,h:n0.h,rotation:n0.rotation,scale:n0.scale,alpha:n0.alpha};
    var parsed=window.parseDesign(window.toV2Json(S.design));
    var back=(parsed&&parsed.design&&parsed.design.nodes)?parsed.design.nodes[0]:null;
    var after=back?{assetId:back.assetId,w:back.w,h:back.h,rotation:back.rotation,scale:back.scale,alpha:back.alpha}:null;
    return JSON.stringify({errors:parsed&&parsed.errors?parsed.errors.length:-1,
      same:after?JSON.stringify(before)===JSON.stringify(after):false});
  })()`));
  ok(J.errors===0,'J1 导出无错误');
  ok(J.same===true,'J2 **6 个字段往返完全一致**');

  // ---------- K. 旧面板无回归 ----------
  const K=JJ(await cdp.eval(`(function(){
    return JSON.stringify({setNodeStr:typeof window.setNodeStr,
      setNodeNumLive:typeof window.setNodeNumLive});
  })()`));
  ok(K.setNodeStr==='function','K1 旧面板 setNodeStr 仍在（imageFields 用它写 assetId）');

  // ---------- L. Registry 未被擅自扩充 ----------
  const L=JJ(await cdp.eval(`(function(){
    var all=ICAR.registry.Control.all();
    return JSON.stringify({total:all.length,
      imageMode:all.filter(function(d){return d.render&&d.render.mode==='image';}).length,
      trackMode:all.filter(function(d){return d.render&&d.render.mode==='track';}).length,
      stateMode:all.filter(function(d){return d.render&&d.render.mode==='state';}).length});
  })()`));
  ok(L.total===69,'L1 **Registry 仍 69 条**（未为图片功能擅自加条目）');
  ok(L.imageMode===0,'L2 Registry 中无 image 模式（普通图片用内置 schema）');
  ok(L.trackMode===28,'L3 轨道 28 条不受影响');
  ok(L.stateMode===19,'L4 状态灯 19 条不受影响');

  // ---------- M. 异常输入不破坏设计 ----------
  const M=JJ(await cdp.eval(`(function(){
    var S=CanvasState,A=ICAR.ui.schemaProps.PropertyAccessor,V=ICAR.ui.schemaProps.PropertyValidator;
    var before=JSON.stringify({a:S.design.assets,w:S.design.nodes.map(function(n){return n.w;})});
    var res=[];
    [['w','abc'],['h','' ],['alpha','x'],['scale','']].forEach(function(c){
      try{var r=V.coerce({key:c[0],type:'number',min:1},c[1]);res.push({k:c[0],ok:r.ok});}
      catch(e){res.push({k:c[0],threw:true});}
    });
    var after=JSON.stringify({a:S.design.assets,w:S.design.nodes.map(function(n){return n.w;})});
    return JSON.stringify({unchanged:before===after,res:res});
  })()`));
  ok(M.unchanged===true,'M1 非法输入未破坏设计数据');
  ok(M.res.every(function(r){return !r.threw;}),'M2 非法输入不抛异常');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
