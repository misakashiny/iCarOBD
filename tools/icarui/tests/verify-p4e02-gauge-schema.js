// ============================================================================
// verify-p4e02-gauge-schema.js —— P4E-02 仪表 PID 规范化与基础 Schema 接入
//
// 批次 A：PID 双字段写入规范化（rawPid=别名 / pid=通道 id / 序列化=别名）
// 批次 B：6 个仪表接入 Schema 面板，第一批只开 8 个字段
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4e02s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 const KEYS=['g_speed','g_coolant','g_fuel','g_volt','g_load','g_throttle'];
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. 6 个仪表全部接入 ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver,out=[];
    ${JSON.stringify(KEYS)}.forEach(function(k){
      var d=Reg.get(k);if(!d){out.push({key:k,missing:true});return;}
      var r=SP.resolve(d.build());
      out.push({key:k,family:r?r.family:null,fields:r?r.fields.length:0,editable:r?r.editable:null});
    });
    return JSON.stringify(out);
  })()`));
  ok(A.length===6,'A1 6 个仪表控件全部存在');
  ok(A.every(x=>x.family==='gauge'),'A2 **6/6 识别为 gauge 族**');
  ok(A.every(x=>x.fields===21),'A3 每个仪表 21 个 schema 字段（P4E-03 +2 / P4E-04 +7）');
  // ⚠️ P4E-03 演进：gauge schema 由 12 字段扩展为 14 ——
  //    P4E-03 为 valueLabels / extraPids **补登记**了 schema 声明
  //    （两个字段本来就在 model.js 白名单和 Android 契约里，只是没进 Registry schema）。
  //    可编辑字段由 8 个扩展为 10 个（新增的正是这两个）。
  //    这不是 P4E-02 契约被破坏，而是后续任务按计划扩大开放范围。
  const BASE=['pid','style','min','max','warnLow','warnHigh','w','h'];
  const EXP=BASE.concat(['valueLabels','extraPids',
    'cardStyle','card.show','card.alpha','card.radius',
    'neonPreset','ringStyle','ringSegments']);
  ok(JSON.stringify(A[0].editable)===JSON.stringify(EXP),'A4 可编辑字段恰为 17 个：'+EXP.join(','));

  // ---------- B. 重载后识别 ----------
  const B=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver,ok=0,noKey=0;
    ${JSON.stringify(KEYS)}.forEach(function(k){
      var d=Reg.get(k);if(!d)return;
      var des=createDesign({name:'r'});des.nodes=[d.build()];
      var back=window.parseDesign(window.toV2Json(des)).design.nodes[0];
      if(!back.__controlKey)noKey++;
      var r=SP.resolve(back);if(r&&r.family==='gauge')ok++;
    });
    return JSON.stringify({ok:ok,noKey:noKey});
  })()`));
  ok(B.noKey===6,'B1 重载后 __controlKey 全部丢失（6/6）');
  ok(B.ok===6,'B2 **重载后 6/6 仍识别**（靠 type 持久化特征）');

  // ---------- C. PID 双字段：合法别名 ----------
  const C=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'p'});d.nodes=[Reg.byLegacyKey('g_speed').build()];
    window.replaceDesign(d,'建');
    var b0=CanvasState.design.nodes[0];
    var before={pid:b0.pid,raw:b0.rawPid};
    window.commit(function(){A.set(CanvasState.design.nodes[0],'pid','obd.rpm');},'改');
    var n=CanvasState.design.nodes[0];
    return JSON.stringify({before:before,pid:n.pid,raw:n.rawPid,json:window.nodeToJson(n).pid});
  })()`));
  ok(C.before.pid==='std_0D'&&C.before.raw==='obd.speed','C1 改前 pid=内部 id / rawPid=别名');
  ok(C.pid==='std_0C','C2 **写别名后 pid 解析为通道 id**（'+C.pid+'）');
  ok(C.raw==='obd.rpm','C3 rawPid 保留用户写法');
  ok(C.json==='obd.rpm','C4 **序列化写别名**（数据契约）');

  // ---------- D. PID 双字段：直接写通道 id ----------
  const D=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'pid'});d.nodes=[Reg.byLegacyKey('g_speed').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(CanvasState.design.nodes[0],'pid','std_0C');},'写id');
    var n=CanvasState.design.nodes[0];
    return JSON.stringify({pid:n.pid,raw:n.rawPid,json:window.nodeToJson(n).pid});
  })()`));
  ok(D.pid==='std_0C','D1 写 id 幂等');
  ok(D.json==='obd.rpm','D2 序列化仍转换为别名');

  // ---------- E. 空 PID（未绑定） ----------
  const E=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'empty'});d.nodes=[Reg.byLegacyKey('g_speed').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(CanvasState.design.nodes[0],'pid','');},'清空');
    var n=CanvasState.design.nodes[0];
    return JSON.stringify({pid:n.pid,raw:n.rawPid});
  })()`));
  ok(E.pid===''&&E.raw==='','E1 **空 PID 两边清空 = 未绑定**');

  // ---------- F. 合法自定义 PID ----------
  const F=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'custom'});d.nodes=[Reg.byLegacyKey('g_load').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(CanvasState.design.nodes[0],'pid','tpl_oilPressure');},'自定义');
    var n=CanvasState.design.nodes[0];
    return JSON.stringify({pid:n.pid,raw:n.rawPid,json:window.nodeToJson(n).pid});
  })()`));
  ok(F.raw==='tpl_oilPressure','F1 **无别名的自定义 PID 仍可用**（rawPid）');
  ok(F.json==='tpl_oilPressure','F2 序列化保留自定义 PID');

  // ---------- G. 未知 PID（不静默丢失，可恢复） ----------
  const G=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'unknown'});d.nodes=[Reg.byLegacyKey('g_load').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(CanvasState.design.nodes[0],'pid','xx.unknown');},'未知');
    var n=CanvasState.design.nodes[0];
    var snap=n.pid+'|'+n.rawPid;
    var json=window.nodeToJson(n).pid;
    window.commit(function(){A.set(CanvasState.design.nodes[0],'pid','obd.rpm');},'恢复');
    var n2=CanvasState.design.nodes[0];
    return JSON.stringify({snap:snap,json:json,recPid:n2.pid,recRaw:n2.rawPid});
  })()`));
  ok(G.snap==='xx.unknown|xx.unknown','G1 未知 PID 原样保留（与旧面板一致，不静默改写）');
  ok(G.json==='xx.unknown','G2 未知 PID 序列化不丢失');
  ok(G.recPid==='std_0C'&&G.recRaw==='obd.rpm','G3 改回合法值可恢复');

  // ---------- H. 基础属性编辑 ----------
  const H=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'base'});d.nodes=[Reg.byLegacyKey('g_coolant').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=CanvasState.design.nodes[0];
      A.set(n,'style',2);A.set(n,'min',-10);A.set(n,'max',120);
      A.set(n,'warnLow',5);A.set(n,'warnHigh',95);A.set(n,'w',180);A.set(n,'h',180);
    },'批量');
    var n=CanvasState.design.nodes[0],j=window.nodeToJson(n);
    return JSON.stringify({mem:[n.style,n.min,n.max,n.warnLow,n.warnHigh,n.w,n.h],
      json:[j.style,j.min,j.max,j.warnLow,j.warnHigh,j.w,j.h]});
  })()`));
  ok(JSON.stringify(H.mem)===JSON.stringify([2,-10,120,5,95,180,180]),'H1 基础属性内存值正确');
  ok(JSON.stringify(H.mem)===JSON.stringify(H.json),'H2 基础属性序列化一致');

  // ---------- I. Undo / Redo ----------
  const I=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'undo'});d.nodes=[Reg.byLegacyKey('g_volt').build()];
    window.replaceDesign(d,'建');
    var v0=CanvasState.design.nodes[0].max;
    window.commit(function(){A.set(CanvasState.design.nodes[0],'max',50);},'a');
    var v1=CanvasState.design.nodes[0].max;
    window.commit(function(){A.set(CanvasState.design.nodes[0],'max',60);},'b');
    var v2=CanvasState.design.nodes[0].max;
    window.doUndo();var u1=CanvasState.design.nodes[0].max;
    window.doUndo();var u2=CanvasState.design.nodes[0].max;
    window.doRedo();var r1=CanvasState.design.nodes[0].max;
    return JSON.stringify({v0:v0,v1:v1,v2:v2,u1:u1,u2:u2,r1:r1});
  })()`));
  ok(I.u1===I.v1&&I.u2===I.v0,'I1 连续撤销两步正确');
  ok(I.r1===I.v1,'I2 重做正确');

  // ---------- J. 导出 → 重导入 ----------
  const J=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'rt'});
    d.nodes=[Reg.byLegacyKey('g_speed').build(),Reg.byLegacyKey('g_throttle').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=CanvasState.design.nodes[0];
      A.set(n,'pid','obd.rpm');A.set(n,'style',4);A.set(n,'min',0);A.set(n,'max',7000);
      A.set(n,'warnHigh',6500);A.set(n,'w',200);A.set(n,'h',200);
    },'改');
    var b=JSON.parse(JSON.stringify(CanvasState.design)).nodes[0];
    var parsed=window.parseDesign(window.toV2Json(CanvasState.design));
    var a=parsed.design.nodes[0];
    return JSON.stringify({errors:parsed.errors.length,
      same:a.pid===b.pid&&a.style===b.style&&a.min===b.min&&a.max===b.max&&
        a.warnHigh===b.warnHigh&&a.w===b.w&&a.h===b.h,
      second:!!(parsed.design.nodes[1]&&parsed.design.nodes[1].type==='gauge'),
      backPid:a.pid,backRaw:a.rawPid});
  })()`));
  ok(J.errors===0,'J1 导出无错误');
  ok(J.same===true,'J2 8 字段往返一致');
  ok(J.second===true,'J3 第二个仪表完整');
  ok(J.backRaw==='obd.rpm','J4 重导入后 rawPid 为别名（下拉框可回显）');

  // ---------- K. 不误判 ----------
  const K=JJ(await cdp.eval(`(function(){
    var SP=ICAR.ui.schemaProps.SchemaResolver,Reg=ICAR.registry.Control;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    var track=Reg.all().filter(function(d){return d.render&&d.render.mode==='track';})[0].build();
    var lamp=Reg.byLegacyKey('lamp_tpms').build();
    var txt=Reg.all().filter(function(d){return d.render&&d.render.mode==='text';})[0].build();
    return JSON.stringify({plain:SP.isGauge(plain),track:SP.isGauge(track),
      lamp:SP.isGauge(lamp),text:SP.isGauge(txt),
      plainFam:(SP.resolve(plain)||{}).family||'null'});
  })()`));
  ok(K.plain===false,'K1 普通图片不判为仪表');
  ok(K.track===false,'K2 条形轨道不判为仪表');
  ok(K.lamp===false,'K3 状态灯不判为仪表');
  ok(K.text===false,'K4 文字控件不判为仪表');
  ok(K.plainFam==='null','K5 普通图片仍走旧面板');

  // ---------- L. 既有族无回归 ----------
  const L=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var lampOk=0,trackOk=0,textOk=0,contOk=0;
    Reg.all().forEach(function(d){
      var r=SP.resolve(d.build());if(!r)return;
      if(/^lamp_/.test(d.key)&&r.family==='imageState')lampOk++;
      if(d.render&&d.render.mode==='track'&&r.family==='track')trackOk++;
      if(d.render&&d.render.mode==='text'&&r.family==='text')textOk++;
      if(d.render&&d.render.mode==='container'&&r.family==='container')contOk++;
    });
    return JSON.stringify({lampOk:lampOk,trackOk:trackOk,textOk:textOk,contOk:contOk,
      registry:Reg.all().length});
  })()`));
  ok(L.lampOk===19,'L1 状态灯 19/19 识别无回归');
  ok(L.trackOk===28,'L2 轨道 28/28 识别无回归');
  ok(L.textOk===12,'L3 文字 12/12 识别无回归');
  ok(L.contOk===4,'L4 容器 4/4 识别无回归');
  ok(L.registry===69,'L5 Registry 仍 69 条');

  // ---------- M. 状态灯 statePid 未受批次 A 影响 ----------
  const M=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'lamp'});d.nodes=[Reg.byLegacyKey('lamp_tpms').build()];
    window.replaceDesign(d,'建');
    window.commit(function(){A.set(CanvasState.design.nodes[0],'statePid','obd.coolant');},'改');
    var n=CanvasState.design.nodes[0];
    return JSON.stringify({sp:n.statePid,raw:n.rawStatePid,json:window.nodeToJson(n).statePid});
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
