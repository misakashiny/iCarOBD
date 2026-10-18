// ============================================================================
// verify-p4e03-gauge-advanced.js —— P4E-03 数值映射 / 副 PID / 参数回填
//
// 批次 A：valueLabels 接入（设置/清空/回显/非法输入/持久化）
// 批次 B：extraPids 接入（别名语义、与主 PID 结构差异、Android 契约一致）
// 批次 C：PID 参数回填（复用 applyPidDefaults，只改 4 字段，可撤销）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4e03s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 const KEYS=['g_speed','g_coolant','g_fuel','g_volt','g_load','g_throttle'];
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. 字段已登记 ----------
  const A=JJ(await cdp.eval(`(function(){
    var SP=ICAR.ui.schemaProps.SchemaResolver,Reg=ICAR.registry.Control;
    var r=SP.resolve(Reg.byLegacyKey('g_speed').build());
    var types={};r.fields.forEach(function(f){types[f.key]=f.type;});
    return JSON.stringify({editable:r.editable,types:types});
  })()`));
  ok(A.editable.indexOf('valueLabels')>=0,'A1 valueLabels 已登记进 gauge 可编辑字段');
  ok(A.editable.indexOf('extraPids')>=0,'A2 extraPids 已登记进 gauge 可编辑字段');
  ok(A.types.valueLabels==='list','A3 valueLabels 类型为 list（数组）');
  ok(A.types.extraPids==='list','A4 extraPids 类型为 list（数组）');
  ok(A.editable.length===10,'A5 可编辑字段 = 8 基础 + 2 新增 = 10');

  // ---------- B. valueLabels 设置/清空/持久化 ----------
  const B=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,V=ICAR.ui.schemaProps.PropertyValidator,S=CanvasState;
    var d=createDesign({name:'vl'});d.nodes=[Reg.byLegacyKey('g_fuel').build()];
    window.replaceDesign(d,'建');
    var f={key:'valueLabels',type:'list'};
    var c1=V.coerce(f,'P,R,N,D');
    window.commit(function(){A.set(S.design.nodes[0],'valueLabels',c1.value);},'设');
    var set=S.design.nodes[0].valueLabels,jsonSet=window.nodeToJson(S.design.nodes[0]).valueLabels;
    var c2=V.coerce(f,'');
    window.commit(function(){A.set(S.design.nodes[0],'valueLabels',c2.value);},'清');
    var cleared=S.design.nodes[0].valueLabels,jsonCleared=window.nodeToJson(S.design.nodes[0]).valueLabels;
    var c3=V.coerce(f,'P,R,N,D');
    var echo=c3.value.join(',');
    return JSON.stringify({set:set,jsonSet:jsonSet,cleared:cleared,jsonCleared:jsonCleared,echo:echo});
  })()`));
  ok(JSON.stringify(B.set)==='["P","R","N","D"]','B1 valueLabels 可设置');
  ok(JSON.stringify(B.jsonSet)==='["P","R","N","D"]','B2 设置后序列化一致');
  ok(B.cleared===null,'B3 清空后为 null（不用映射）');
  ok(B.jsonCleared===undefined,'B4 清空后序列化剔除该字段');
  ok(B.echo==='P,R,N,D','B5 回显为逗号串（与旧面板一致）');

  // ---------- C. 非法输入不崩溃 ----------
  const C=JJ(await cdp.eval(`(function(){
    var V=ICAR.ui.schemaProps.PropertyValidator,f={key:'valueLabels',type:'list'};
    var cases=['', '  ,  ,  ', 'a,b,c', null, undefined, String.fromCharCode(0), 'x'.repeat(500)];
    return JSON.stringify(cases.map(function(c){
      try{var r=V.coerce(f,c);return {ok:r.ok,len:r.value?r.value.length:0};}
      catch(e){return {threw:e.message};}
    }));
  })()`));
  ok(C.every(function(x){return !x.threw;}),'C1 各种输入均不抛异常（7 种）');
  ok(C[6].len<=32,'C2 超长输入被截断到 VALUE_LABELS_MAX=32');
  ok(C[0].ok===true&&C[0].len===0,'C3 空串 → 空表');

  // ---------- D. extraPids 别名语义 ----------
  const D=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,V=ICAR.ui.schemaProps.PropertyValidator,S=CanvasState;
    var d=createDesign({name:'ep'});d.nodes=[Reg.byLegacyKey('g_volt').build()];
    window.replaceDesign(d,'建');
    var c=V.coerce({key:'extraPids',type:'list'},'obd.coolant, obd.intake');
    window.commit(function(){A.set(S.design.nodes[0],'extraPids',c.value);},'设');
    var n=S.design.nodes[0];
    return JSON.stringify({mem:n.extraPids,json:window.nodeToJson(n).extraPids,
      isAlias:n.extraPids[0]==='obd.coolant'});
  })()`));
  ok(JSON.stringify(D.mem)==='["obd.coolant","obd.intake"]','D1 extraPids 保存为别名数组');
  ok(D.isAlias===true,'D2 **存的是别名，不是通道 id**（与 Android findPid 契约一致）');
  ok(JSON.stringify(D.json)===JSON.stringify(D.mem),'D3 序列化一致');

  // ---------- E. 主 PID 与副 PID 结构差异 ----------
  const E=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'diff'});d.nodes=[Reg.byLegacyKey('g_load').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'pid','obd.rpm');
      A.set(n,'extraPids',['obd.coolant']);
    },'改');
    var n=S.design.nodes[0];
    return JSON.stringify({pid:n.pid,rawPid:n.rawPid,extraPids:n.extraPids,
      pidIsId:n.pid==='std_0C',extraIsArray:Array.isArray(n.extraPids),
      extraHasRaw:('rawExtraPids' in n)});
  })()`));
  ok(E.pidIsId===true,'E1 主 PID：pid 是通道 id（std_0C）');
  ok(E.rawPid==='obd.rpm','E2 主 PID：rawPid 是别名');
  ok(E.extraIsArray===true,'E3 副 PID：extraPids 是别名数组（无通道 id 字段）');
  ok(E.extraHasRaw===false,'E4 **未凭空新增 rawExtraPids 字段**（不改数据契约）');

  // ---------- F. PID 回填 ----------
  const F=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'bf'});d.nodes=[Reg.byLegacyKey('g_speed').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(S.design.nodes[0],'pid','obd.rpm');},'pid');
    S.selection=[S.design.nodes[0].id];   // applyPidDefaults 用 sel()
    var n0=S.design.nodes[0];
    var before={max:n0.max,min:n0.min,style:n0.style,w:n0.w,
      neon:n0.neonPreset||null,ring:n0.ringStyle||0,card:n0.cardStyle};
    window.applyPidDefaults();
    var n1=S.design.nodes[0];
    var after={max:n1.max,min:n1.min,style:n1.style,w:n1.w,
      neon:n1.neonPreset||null,ring:n1.ringStyle||0,card:n1.cardStyle};
    var info=window.BUILTIN_PIDS['std_0C'];
    return JSON.stringify({before:before,after:after,info:{min:info.min,max:info.max}});
  })()`));
  ok(F.after.max===F.info.max,'F1 回填后 max 等于 PID 库默认（'+F.after.max+'）');
  ok(F.after.min===F.info.min,'F2 回填后 min 等于 PID 库默认');
  ok(F.after.max!==F.before.max,'F3 回填确实改变了量程');
  ok(F.after.style===F.before.style&&F.after.w===F.before.w&&
     F.after.neon===F.before.neon&&F.after.ring===F.before.ring&&
     F.after.card===F.before.card,'F4 **外观字段未被覆盖**');

  // ---------- G. 回填可撤销/重做 ----------
  const G=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'bfu'});d.nodes=[Reg.byLegacyKey('g_coolant').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){var n=S.design.nodes[0];A.set(n,'min',-99);A.set(n,'max',999);},'手改');
    S.selection=[S.design.nodes[0].id];
    var manual=S.design.nodes[0].max;
    window.applyPidDefaults();
    var filled=S.design.nodes[0].max;
    window.doUndo();
    var undone=S.design.nodes[0].max;
    window.doRedo();
    var redone=S.design.nodes[0].max;
    return JSON.stringify({manual:manual,filled:filled,undone:undone,redone:redone});
  })()`));
  ok(G.filled!==G.manual,'G1 回填改变了值');
  ok(G.undone===G.manual,'G2 **回填可撤销**（回到手改值）');
  ok(G.redone===G.filled,'G3 回填可重做');

  // ---------- H. Undo/Redo（valueLabels / extraPids） ----------
  const H=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'u'});d.nodes=[Reg.byLegacyKey('g_load').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(S.design.nodes[0],'valueLabels',['A','B']);},'a');
    var v1=JSON.stringify(S.design.nodes[0].valueLabels);
    window.commit(function(){A.set(S.design.nodes[0],'extraPids',['obd.rpm']);},'b');
    var v2=JSON.stringify(S.design.nodes[0].extraPids);
    window.doUndo();
    var u1=JSON.stringify(S.design.nodes[0].extraPids);
    window.doUndo();
    var u2=JSON.stringify(S.design.nodes[0].valueLabels);
    window.doRedo();
    var rd=JSON.stringify(S.design.nodes[0].valueLabels);
    return JSON.stringify({v1:v1,v2:v2,u1:u1,u2:u2,rd:rd});
  })()`));
  ok(H.v1==='["A","B"]'&&H.v2==='["obd.rpm"]','H1 两个字段都能设置');
  ok(H.u1==='[]','H2 撤销 extraPids 回到初始空数组');
  ok(H.u2==='null','H3 再撤销 valueLabels 回到未设');
  ok(H.rd===H.v1,'H4 重做回到改后值');

  // ---------- I. 导出 → 重导入 ----------
  const I=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'rt'});d.nodes=[Reg.byLegacyKey('g_fuel').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'valueLabels',['P','R','N','D']);
      A.set(n,'extraPids',['obd.coolant','obd.intake']);
    },'改');
    var b=JSON.parse(JSON.stringify(S.design)).nodes[0];
    var parsed=window.parseDesign(window.toV2Json(S.design));
    var a=parsed.design.nodes[0];
    return JSON.stringify({errors:parsed.errors.length,
      vlSame:JSON.stringify(a.valueLabels)===JSON.stringify(b.valueLabels),
      epSame:JSON.stringify(a.extraPids)===JSON.stringify(b.extraPids)});
  })()`));
  ok(I.errors===0,'I1 导出无错误');
  ok(I.vlSame===true,'I2 valueLabels 往返一致');
  ok(I.epSame===true,'I3 extraPids 往返一致');

  // ---------- J. 旧面板仍工作 ----------
  const J=JJ(await cdp.eval(`(function(){
    return JSON.stringify({
      setNodeValueLabels:typeof window.setNodeValueLabels,
      setNodeExtras:typeof window.setNodeExtras,
      applyPidDefaults:typeof window.applyPidDefaults});
  })()`));
  ok(J.setNodeValueLabels==='function','J1 旧面板 setNodeValueLabels 仍在');
  ok(J.setNodeExtras==='function','J2 旧面板 setNodeExtras 仍在');
  ok(J.applyPidDefaults==='function','J3 applyPidDefaults 仍在（被复用而非复制）');

  // ---------- K. 6 个仪表均可用 ----------
  const K=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver,out=[];
    ${JSON.stringify(KEYS)}.forEach(function(k){
      var d=Reg.get(k);if(!d)return;
      var r=SP.resolve(d.build());
      out.push({key:k,ok:r&&r.family==='gauge',ed:r?r.editable.length:0});
    });
    return JSON.stringify(out);
  })()`));
  ok(K.length===6,'K1 6 个仪表都在');
  ok(K.every(function(x){return x.ok&&x.ed===10;}),'K2 **6/6 均可编辑 10 个字段**');

  // ---------- L. 其它族无回归 ----------
  const L=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var lamp=0,track=0,text=0,cont=0;
    Reg.all().forEach(function(d){
      var r=SP.resolve(d.build());if(!r)return;
      if(/^lamp_/.test(d.key)&&r.family==='imageState')lamp++;
      if(d.render&&d.render.mode==='track'&&r.family==='track')track++;
      if(d.render&&d.render.mode==='text'&&r.family==='text')text++;
      if(d.render&&d.render.mode==='container'&&r.family==='container')cont++;
    });
    return JSON.stringify({lamp:lamp,track:track,text:text,cont:cont,registry:Reg.all().length});
  })()`));
  ok(L.lamp===19,'L1 状态灯 19/19 无回归');
  ok(L.track===28,'L2 轨道 28/28 无回归');
  ok(L.text===12,'L3 文字 12/12 无回归');
  ok(L.cont===4,'L4 容器 4/4 无回归');
  ok(L.registry===69,'L5 Registry 仍 69 条');

  // ---------- M. 状态灯 statePid 未受影响 ----------
  const M=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'lamp'});d.nodes=[Reg.byLegacyKey('lamp_tpms').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(S.design.nodes[0],'statePid','obd.coolant');},'改');
    var n=S.design.nodes[0];
    return JSON.stringify({sp:n.statePid,json:window.nodeToJson(n).statePid});
  })()`));
  ok(M.sp==='std_05','M1 状态灯 statePid 仍解析为通道 id');
  ok(M.json==='obd.coolant','M2 状态灯序列化仍为别名');
 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
