// ============================================================================
// verify-p4e04-gauge-appearance.js —— P4E-04 仪表高级外观属性 Schema 迁移
//
// 迁移字段：cardStyle / card.show / card.alpha / card.radius /
//           neonPreset / ringStyle / ringSegments
// 专项：extraPids=[] 的真实行为（修正 P4E-03 矛盾描述）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4e04s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 const KEYS=['g_speed','g_coolant','g_fuel','g_volt','g_load','g_throttle'];
 const TARGETS=['cardStyle','card.show','card.alpha','card.radius','neonPreset','ringStyle','ringSegments'];
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. 字段已登记 ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var r=SP.resolve(Reg.byLegacyKey('g_speed').build());
    var t=${JSON.stringify(TARGETS)};
    return JSON.stringify({fields:r.fields.length,editable:r.editable.length,
      declared:t.filter(function(x){return r.editable.indexOf(x)>=0;}),
      missing:t.filter(function(x){return r.editable.indexOf(x)<0;})});
  })()`));
  ok(A.missing.length===0,'A1 **7 个外观字段全部已登记并可编辑**');
  // P4F-M01 演进：再补登记 bands / parts -> 23 字段
  ok(A.fields===23,'A2 gauge schema 由 14 扩展为 23 字段（P4E-04 +7 / P4F-M01 +2）');
  ok(A.editable===19,'A3 可编辑字段 10 → 19（P4F-M01）');

  // ---------- B. 枚举取值范围 ----------
  const B=JJ(await cdp.eval(`(function(){
    var f={};ICAR.registry.Control.get('g_speed').schema.forEach(function(x){f[x.key]=x;});
    return JSON.stringify({
      cardStyle:f.cardStyle.values,neon:f.neonPreset.values,ring:f.ringStyle.values,
      alpha:[f['card.alpha'].min,f['card.alpha'].max],
      radius:[f['card.radius'].min,f['card.radius'].max]});
  })()`));
  ok(JSON.stringify(B.cardStyle)==='[0,1,2,3]','B1 cardStyle 取值 0..3（4 档）');
  ok(JSON.stringify(B.neon)==='[null,"关闭","克制","标准","强烈","夸张"]','B2 neonPreset 5 档 + null');
  ok(JSON.stringify(B.ring)==='[0,1]','B3 ringStyle 0/1');
  ok(JSON.stringify(B.alpha)==='[0,255]','B4 card.alpha 范围 0..255（与旧面板一致）');
  ok(JSON.stringify(B.radius)==='[0,120]','B5 card.radius 范围 0..120（与旧面板一致）');

  // ---------- C. card.* 自动建对象 ----------
  const C=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'c'});d.nodes=[Reg.byLegacyKey('g_coolant').build()];
    window.replaceDesign(d,'建');
    var out={init:JSON.stringify(S.design.nodes[0].card)};
    window.commit(function(){A.set(S.design.nodes[0],'card.alpha',200);},'a');
    out.afterAlpha=JSON.stringify(S.design.nodes[0].card);
    window.commit(function(){A.set(S.design.nodes[0],'card.show',true);
      A.set(S.design.nodes[0],'card.alpha',null);},'reset');
    out.afterReset=JSON.stringify(S.design.nodes[0].card);
    return JSON.stringify(out);
  })()`));
  ok(C.init==='null','C1 全新仪表 card 默认为 null（跟随主题）');
  ok(C.afterAlpha!=='null','C2 **card.alpha 在默认 null 时也能写入**（自动建对象）');
  ok(C.afterReset==='null','C3 全部还原默认后 card 变回 null（tidyCard 语义）');

  // ---------- D. 7 字段设置 + 往返 ----------
  const D=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'all'});d.nodes=[Reg.byLegacyKey('g_throttle').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'cardStyle',2);A.set(n,'card.show',true);A.set(n,'card.alpha',180);
      A.set(n,'card.radius',10);A.set(n,'neonPreset','强烈');
      A.set(n,'ringStyle',1);A.set(n,'ringSegments',60);
    },'全设');
    var n=S.design.nodes[0];
    var b={cardStyle:n.cardStyle,card:JSON.parse(JSON.stringify(n.card)),
      neonPreset:n.neonPreset,ringStyle:n.ringStyle,ringSegments:n.ringSegments};
    var parsed=window.parseDesign(window.toV2Json(S.design));
    var x=parsed.design.nodes[0];
    var a={cardStyle:x.cardStyle,card:x.card,neonPreset:x.neonPreset,
      ringStyle:x.ringStyle,ringSegments:x.ringSegments};
    return JSON.stringify({same:JSON.stringify(b)===JSON.stringify(a),errors:parsed.errors.length,back:a});
  })()`));
  ok(D.same===true,'D1 **7 字段设置后往返一致**');
  ok(D.errors===0,'D2 导出无错误');

  // ---------- E. Undo / Redo ----------
  const E=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'u'});d.nodes=[Reg.byLegacyKey('g_load').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(S.design.nodes[0],'neonPreset','夸张');},'a');
    var v1=S.design.nodes[0].neonPreset;
    window.commit(function(){A.set(S.design.nodes[0],'ringStyle',1);},'b');
    var v2=S.design.nodes[0].ringStyle;
    window.doUndo();var u1=S.design.nodes[0].ringStyle;
    window.doUndo();var u2=S.design.nodes[0].neonPreset;
    window.doRedo();var rd=S.design.nodes[0].neonPreset;
    return JSON.stringify({v1:v1,v2:v2,u1:u1,u2:u2,rd:rd});
  })()`));
  ok(E.u1===0,'E1 撤销指针环回到 0');
  ok(E.u2===null,'E2 撤销霓虹回到 null');
  ok(E.rd==='夸张','E3 重做回到改后值');

  // ---------- F. 6 个仪表样式适用性 ----------
  const F=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var out=[];
    ${JSON.stringify(KEYS)}.forEach(function(k){
      var d=Reg.get(k);if(!d)return;
      var n=d.build();var r=SP.resolve(n);
      var allEd=${JSON.stringify(TARGETS)}.every(function(t){return r.editable.indexOf(t)>=0;});
      out.push({key:k,style:n.style,editable:r.editable.length,allAppearanceEditable:allEd});
    });
    return JSON.stringify(out);
  })()`));
  ok(F.length===6,'F1 6 个仪表都在');
  ok(F.every(function(x){return x.allAppearanceEditable;}),'F2 **6/6 仪表 7 个外观字段都可用**');
  ok(F.every(function(x){return x.editable===19;}),'F3 6/6 可编辑字段均为 19');
  const styles=F.map(function(x){return x.style;});
  // ⚠️ 实测：6 个仪表的 style 并非两两不同 —— g_coolant 与 g_fuel 都是 0（圆表）。
  //
  // ⚠️ P4E-05 收紧：原文是 `new Set(styles).size >= 4` —— 那是**弱断言**
  //    （某个仪表默认 style 被改错、档位从 4 掉到 3，它仍然会通过）。
  //    默认 style 是 Registry 里的**固定值**，应当精确断言。
  ok(JSON.stringify(styles)==='[1,0,0,4,2,3]',
    'F4 6 个仪表默认 style 精确为 [1,0,0,4,2,3]（实测 '+JSON.stringify(styles)+'）');

  // ---------- G. 【专项】extraPids = [] 真实行为 ----------
  const G=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,V=ICAR.ui.schemaProps.PropertyValidator,S=CanvasState;
    var d=createDesign({name:'ep'});d.nodes=[Reg.byLegacyKey('g_speed').build()];
    window.replaceDesign(d,'建');
    var out={};
    out.init=JSON.stringify(S.design.nodes[0].extraPids);
    window.commit(function(){A.set(S.design.nodes[0],'extraPids',['obd.rpm','obd.coolant']);},'set');
    out.afterSet=JSON.stringify(window.nodeToJson(S.design.nodes[0]).extraPids);
    var c=V.coerce({key:'extraPids',type:'list'},'');
    window.commit(function(){A.set(S.design.nodes[0],'extraPids',c.value);},'clear');
    var j=window.nodeToJson(S.design.nodes[0]);
    out.cleared=JSON.stringify(S.design.nodes[0].extraPids);
    out.jsonHasKey=('extraPids' in j);
    window.doUndo();out.undo=JSON.stringify(S.design.nodes[0].extraPids);
    window.doRedo();out.redo=JSON.stringify(S.design.nodes[0].extraPids);
    return JSON.stringify(out);
  })()`));
  ok(G.cleared==='[]','G1 清空后内存为 []');
  ok(G.jsonHasKey===false,'G2 **空数组时序列化省略 extraPids 键**');
  ok(G.undo==='["obd.rpm","obd.coolant"]','G3 清空后可撤销');
  ok(G.redo==='[]','G4 重做回到空数组');

  // ---------- H. 【专项】清空后导出→重导入 ----------
  const H=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'rt'});d.nodes=[Reg.byLegacyKey('g_fuel').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(S.design.nodes[0],'extraPids',['obd.rpm']);},'a');
    window.commit(function(){A.set(S.design.nodes[0],'extraPids',[]);},'b');
    var json=window.toV2Json(S.design);
    var back=window.parseDesign(json).design.nodes[0];
    return JSON.stringify({rawHasKey:json.indexOf('"extraPids"')>=0,
      isArray:Array.isArray(back.extraPids),len:back.extraPids.length});
  })()`));
  ok(H.rawHasKey===false,'H1 导出 JSON 中不含 extraPids 键');
  ok(H.isArray===true&&H.len===0,'H2 **重导入后恢复为空数组 []**（parseNode 的 || [] 兜底）');

  // ---------- I. 数据绑定无回归（P4E-02/03） ----------
  const I=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'bind'});d.nodes=[Reg.byLegacyKey('g_speed').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'pid','obd.rpm');
      A.set(n,'valueLabels',['P','R']);
      A.set(n,'extraPids',['obd.coolant']);
    },'bind');
    var n=S.design.nodes[0],j=window.nodeToJson(n);
    return JSON.stringify({pid:n.pid,rawPid:n.rawPid,jsonPid:j.pid,
      vl:n.valueLabels,ep:n.extraPids});
  })()`));
  ok(I.pid==='std_0C','I1 主 PID 双字段仍正确');
  ok(I.jsonPid==='obd.rpm','I2 序列化仍为别名');
  ok(JSON.stringify(I.vl)==='["P","R"]','I3 valueLabels 无回归');
  ok(JSON.stringify(I.ep)==='["obd.coolant"]','I4 extraPids 无回归');

  // ---------- J. 旧面板函数仍在 ----------
  const J=JJ(await cdp.eval(`(function(){
    return JSON.stringify({setNodeCard:typeof window.setNodeCard,
      setCardFlag:typeof window.setCardFlag,setCardNumLive:typeof window.setCardNumLive,
      resetCard:typeof window.resetCard,setNodeNeon:typeof window.setNodeNeon,
      resolveCard:typeof window.resolveCard});
  })()`));
  ok(J.setNodeCard==='function','J1 旧面板 setNodeCard 仍在');
  ok(J.setCardFlag==='function','J2 旧面板 setCardFlag 仍在');
  ok(J.setCardNumLive==='function','J3 旧面板 setCardNumLive 仍在');
  ok(J.resetCard==='function','J4 旧面板 resetCard 仍在');
  ok(J.setNodeNeon==='function','J5 旧面板 setNodeNeon 仍在');
  ok(J.resolveCard==='function','J6 resolveCard 仍在');

  // ---------- K. 其它族无回归 ----------
  const K=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var lamp=0,track=0,text=0,cont=0,gauge=0;
    Reg.all().forEach(function(d){
      var r=SP.resolve(d.build());if(!r)return;
      if(/^lamp_/.test(d.key)&&r.family==='imageState')lamp++;
      if(d.render&&d.render.mode==='track'&&r.family==='track')track++;
      if(d.render&&d.render.mode==='text'&&r.family==='text')text++;
      if(d.render&&d.render.mode==='container'&&r.family==='container')cont++;
      if(d.render&&d.render.mode==='gauge'&&r.family==='gauge')gauge++;
    });
    return JSON.stringify({lamp:lamp,track:track,text:text,cont:cont,gauge:gauge,registry:Reg.all().length});
  })()`));
  ok(K.lamp===19,'K1 状态灯 19/19 无回归');
  ok(K.track===28,'K2 轨道 28/28 无回归');
  ok(K.text===12,'K3 文字 12/12 无回归');
  ok(K.cont===4,'K4 容器 4/4 无回归');
  ok(K.gauge===6,'K5 仪表 6/6');
  ok(K.registry===73,'K6 Registry 为 73 条（P5B-M04 授权 +4；此前 69）');

  // ---------- L. 普通图片不误判 ----------
  const L=JJ(await cdp.eval(`(function(){
    var SP=ICAR.ui.schemaProps.SchemaResolver;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    return JSON.stringify({isGauge:SP.isGauge(plain),fam:(SP.resolve(plain)||{}).family||'null'});
  })()`));
  ok(L.isGauge===false,'L1 普通图片不判为仪表');
  // P4F-03: plain image now resolves to the new image family.
  ok(L.fam==='image','L2 plain image belongs to image family (not gauge)');
 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
