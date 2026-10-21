// ============================================================================
// verify-p4f04-text-container-schema.js —— P4F-04 文字与容器 Schema 属性补齐
//
// text 族 5 → 7（补 w/h）；container 族 6 → 7（补 scale）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4f04s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. 12 个 text 控件 ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var ts=Reg.all().filter(function(d){return d.render&&d.render.mode==='text';});
    var out={total:ts.length,ok:0,ed:null,bad:[]};
    ts.forEach(function(d){
      var r=SP.resolve(d.build());
      if(r&&r.family==='text'){out.ok++;out.ed=r.editable;}
      else out.bad.push(d.key);
    });
    return JSON.stringify(out);
  })()`));
  ok(A.total===12,'A1 Registry 中 text 控件共 12 条');
  ok(A.ok===12,'A2 **12/12 全部识别为 text 族**');
  ok(A.ed&&A.ed.length===7,'A3 **可编辑字段 5 → 7**');
  const TEXP=['text','font.size','font.weight','font.color','font.align','w','h'];
  ok(JSON.stringify(A.ed)===JSON.stringify(TEXP),'A4 text 字段清单精确');

  // ---------- B. 4 个 container 控件 ----------
  const B=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var cs=Reg.all().filter(function(d){return d.render&&d.render.mode==='container';});
    var out={total:cs.length,ok:0,ed:null,bad:[]};
    cs.forEach(function(d){
      var r=SP.resolve(d.build());
      if(r&&r.family==='container'){out.ok++;out.ed=r.editable;}
      else out.bad.push(d.key);
    });
    return JSON.stringify(out);
  })()`));
  ok(B.total===4,'B1 Registry 中 container 控件共 4 条');
  ok(B.ok===4,'B2 **4/4 全部识别为 container 族**');
  ok(B.ed&&B.ed.length===7,'B3 **可编辑字段 6 → 7**');
  const CEXP=['w','h','rotation','scale','alpha','locked','visible'];
  ok(JSON.stringify(B.ed)===JSON.stringify(CEXP),'B4 container 字段清单精确');

  // ---------- C. 文字 w/h 编辑 ----------
  const C=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'t'});d.nodes=[Reg.byLegacyKey('t_label').build()];window.replaceDesign(d,'建');
    var b={w:S.design.nodes[0].w,h:S.design.nodes[0].h};
    window.commit(function(){A.set(S.design.nodes[0],'w',200);A.set(S.design.nodes[0],'h',60);},'改');
    var n=S.design.nodes[0];
    return JSON.stringify({bw:b.w,bh:b.h,w:n.w,h:n.h});
  })()`));
  ok(C.w===200,'C1 文字宽度可编辑');
  ok(C.h===60,'C2 文字高度可编辑');
  ok(C.bw!==C.w||C.bh!==C.h,'C3 确实发生了改变');

  // ---------- D. 容器 scale 编辑 ----------
  const D=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'c'});d.nodes=[Reg.get('group').build()];window.replaceDesign(d,'建');
    var before=S.design.nodes[0].scale;
    window.commit(function(){A.set(S.design.nodes[0],'scale',1.5);},'改');
    return JSON.stringify({before:before,after:S.design.nodes[0].scale});
  })()`));
  ok(D.before===1,'D1 容器默认 scale = 1');
  ok(D.after===1.5,'D2 容器缩放可编辑');

  // ---------- E. 范围与非法输入 ----------
  const E=JJ(await cdp.eval(`(function(){
    var f={};ICAR.registry.Control.get('group').schema.forEach(function(x){f[x.key]=x;});
    var ft={};ICAR.registry.Control.byLegacyKey('t_label').schema.forEach(function(x){ft[x.key]=x;});
    var V=ICAR.ui.schemaProps.PropertyValidator;
    var res=[];
    [['scale',0],['scale',0.05],['scale',10],['scale','abc'],['w',0],['w',1],['h','']].forEach(function(c){
      try{var r=V.coerce({key:c[0],type:'number',min:c[0]==='scale'?0.05:1},c[1]);res.push({k:c[0],v:String(c[1]),ok:r.ok});}
      catch(e){res.push({k:c[0],threw:true});}
    });
    return JSON.stringify({scaleMin:f.scale.min,textWMin:ft.w.min,textHMin:ft.h.min,res:res});
  })()`));
  ok(E.scaleMin===0.05,'E1 **scale 下限 0.05**（与旧面板 Math.max(0.05,…) 一致）');
  ok(E.textWMin===1&&E.textHMin===1,'E2 文字 w/h 下限为 1');
  ok(E.res.every(function(r){return !r.threw;}),'E3 非法输入不抛异常');
  ok(E.res.filter(function(r){return r.k==='scale'&&r.v==='0';})[0].ok===false,'E4 scale=0 被拒绝');

  // ---------- F. 画布重绘 ----------
  const F=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'r'});d.nodes=[Reg.byLegacyKey('t_label').build()];window.replaceDesign(d,'建');
    var cnt=0,orig=window.draw;
    window.draw=function(){cnt++;return orig.apply(this,arguments);};
    window.commit(function(){A.set(S.design.nodes[0],'w',222);},'触发');
    window.draw=orig;
    return JSON.stringify({drawCalls:cnt});
  })()`));
  ok(F.drawCalls>0,'F1 属性变更触发画布重绘（'+F.drawCalls+' 次）');

  // ---------- G. 子节点布局不受影响 ----------
  const G=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var c=Reg.get('group').build();
    var ch=window.createNode(window.NODE_IMAGE,{name:'子',assetId:'x',w:20,h:20});
    ch.x=10;ch.y=10;c.children=[ch];
    var d=createDesign({name:'g'});d.nodes=[c];window.replaceDesign(d,'建');
    var b={x:S.design.nodes[0].children[0].x,y:S.design.nodes[0].children[0].y};
    window.commit(function(){A.set(S.design.nodes[0],'scale',2);},'放大');
    var a={x:S.design.nodes[0].children[0].x,y:S.design.nodes[0].children[0].y};
    return JSON.stringify({b:b,a:a,same:(b.x===a.x&&b.y===a.y),
      scale:S.design.nodes[0].scale,childCount:S.design.nodes[0].children.length});
  })()`));
  ok(G.same===true,'G1 **容器缩放不改子节点坐标**（绝对坐标语义不变）');
  ok(G.childCount===1,'G2 子节点数量不变');
  ok(G.scale===2,'G3 缩放确实生效');

  // ---------- H. Undo / Redo ----------
  const H=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'u'});d.nodes=[Reg.byLegacyKey('t_label').build()];window.replaceDesign(d,'建');
    var v0=S.design.nodes[0].w;
    window.commit(function(){A.set(S.design.nodes[0],'w',300);},'改');
    var v1=S.design.nodes[0].w;
    window.doUndo();var u1=S.design.nodes[0].w;
    window.doRedo();var r1=S.design.nodes[0].w;
    return JSON.stringify({v0:v0,v1:v1,u1:u1,r1:r1});
  })()`));
  ok(H.u1===H.v0,'H1 撤销文字宽度回到原值');
  ok(H.r1===H.v1,'H2 重做回到改后值');

  // ---------- I. 导出 → 重导入 ----------
  const I=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'rt'});
    d.nodes=[Reg.byLegacyKey('t_label').build(),Reg.get('group').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var t=S.design.nodes[0],c=S.design.nodes[1];
      A.set(t,'w',180);A.set(t,'h',50);A.set(c,'scale',1.8);
    },'设');
    var tn=S.design.nodes[0],cn=S.design.nodes[1];
    var before={tw:tn.w,th:tn.h,cs:cn.scale};
    var parsed=window.parseDesign(window.toV2Json(S.design));
    var ok2=parsed&&parsed.design&&parsed.design.nodes;
    var a=ok2?parsed.design.nodes[0]:null,b=ok2?parsed.design.nodes[1]:null;
    var same=a?JSON.stringify(before)===JSON.stringify({tw:a.w,th:a.h,cs:b.scale}):false;
    return JSON.stringify({errors:parsed&&parsed.errors?parsed.errors.length:-1,same:same});
  })()`));
  ok(I.errors===0,'I1 导出无错误');
  ok(I.same===true,'I2 **w/h/scale 往返完全一致**');

  // ---------- J. 旧面板无回归 ----------
  const J=JJ(await cdp.eval(`(function(){
    return JSON.stringify({setNodeNum:typeof window.setNodeNum,
      setNodeNumLive:typeof window.setNodeNumLive,
      localMatrix:typeof window.localMatrix,
      registry:ICAR.registry.Control.all().length});
  })()`));
  ok(J.setNodeNum==='function','J1 旧面板 setNodeNum 仍在（scale 归 1/下限 0.05 逻辑在此）');
  ok(J.localMatrix==='function','J2 localMatrix 仍在（唯一矩阵源，未改动）');
  ok(J.registry===69,'J3 Registry 仍 69 条');

  // ---------- K. 其它族无回归 ----------
  const K=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    function fam(n){var r=SP.resolve(n);return r&&r.family?r.family:'null';}
    return JSON.stringify({
      image:fam(plain),
      lamp:fam(Reg.byLegacyKey('lamp_tpms').build()),
      gauge:fam(Reg.byLegacyKey('g_speed').build()),
      track:fam(Reg.all().filter(function(d){return d.render&&d.render.mode==='track';})[0].build())});
  })()`));
  ok(K.image==='image','K1 普通图片仍归 image 族');
  ok(K.lamp==='imageState','K2 状态灯仍归 imageState');
  ok(K.gauge==='gauge','K3 仪表仍归 gauge');
  ok(K.track==='track','K4 轨道仍归 track');

  // ---------- L. 无重复字段定义 ----------
  const L=JJ(await cdp.eval(`(function(){
    var f={};ICAR.registry.Control.get('group').schema.forEach(function(x){f[x.key]=(f[x.key]||0)+1;});
    var ft={};ICAR.registry.Control.byLegacyKey('t_label').schema.forEach(function(x){ft[x.key]=(ft[x.key]||0)+1;});
    var dupC=Object.keys(f).filter(function(k){return f[k]>1;});
    var dupT=Object.keys(ft).filter(function(k){return ft[k]>1;});
    return JSON.stringify({dupContainer:dupC,dupText:dupT,
      containerFields:Object.keys(f).length,textFields:Object.keys(ft).length});
  })()`));
  ok(L.dupContainer.length===0,'L1 container schema 无重复字段定义');
  ok(L.dupText.length===0,'L2 text schema 无重复字段定义');
  ok(L.containerFields===7,'L3 container schema 共 7 字段');
  ok(L.textFields===7,'L4 text schema 共 7 字段');

  // ---------- M. 自动测量不存在（审计结论） ----------
  const M=JJ(await cdp.eval(`(function(){
    return JSON.stringify({measureText:typeof window.measureText,
      autoSizeText:typeof window.autoSizeText,
      fitText:typeof window.fitText});
  })()`));
  ok(M.measureText==='undefined'&&M.autoSizeText==='undefined'&&M.fitText==='undefined',
    'M1 **确认无文字自动测量逻辑**（改 w/h 不会破坏既有布局）');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
