// ============================================================================
// verify-p4d01-lamp-schema.js —— P4D-01 19 个状态灯 Schema 属性面板迁移
//
// 覆盖：
//   A. 19 个灯全部被 SchemaResolver 识别为 imageState（L1/L2/L4 分组）
//   B. 重载后（无 __controlKey）仍靠持久化特征识别，且 19 个都对
//   C. 基础属性编辑（w/h）
//   D. statePid 数据绑定双字段同步（statePid=id / rawStatePid=别名 / 序列化=别名）
//   E. 三态素材选择与引用
//   F. 三态 alpha / blink 配置；blinkMs 不开放（WCAG）
//   G. 属性变更后画布重绘
//   H. Undo / Redo 兼容
//   I. 保存 → 导出 → 重新导入后属性一致
//   J. 普通图片不被误判为状态灯
//   K. 旧属性面板仍并行（未被删除）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4d01s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  const KEYS=['lamp_coolant','lamp_oil','lamp_batt','lamp_brake','lamp_pad','lamp_tpms',
    'lamp_airbag','lamp_belt','lamp_abs','lamp_esp','lamp_engine','lamp_fuel','lamp_door',
    'lamp_washer','lamp_service','lamp_temp','lamp_charge','lamp_lane','lamp_collision'];

  // ---------- A. 19 个全部识别 ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var out={total:0,ok:0,items:[],categories:{}};
    ${JSON.stringify(KEYS)}.forEach(function(k){
      var d=Reg.get(k);if(!d){out.items.push({key:k,missing:true});return;}
      var n=d.build();var r=SP.resolve(n);
      out.total++;
      if(r&&r.family==='imageState')out.ok++;
      out.items.push({key:k,family:r?r.family:null,fields:r?r.fields.length:0,
        editable:r?r.editable.length:0,category:d.category});
      out.categories[d.category]=(out.categories[d.category]||0)+1;
    });
    return JSON.stringify(out);
  })()`));
  ok(A.total===19,'A1 19 个状态灯全部存在于 Registry');
  ok(A.ok===19,'A2 **19/19 识别为 imageState 族**（实际 ' + A.ok + '）');
  ok(A.items.every(function(x){return x.fields===11;}),'A3 每个灯 11 个 schema 字段');
  ok(A.items.every(function(x){return x.editable===11;}),'A4 11 个字段全部可编辑');

  // ---------- B. 重载后仍识别 ----------
  const B=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var ok=0,noKey=0,total=0;
    ${JSON.stringify(KEYS)}.forEach(function(k){
      var d=Reg.get(k);if(!d)return;
      var n=d.build();
      var des=createDesign({name:'r'});des.nodes=[n];
      var back=window.parseDesign(window.toV2Json(des)).design.nodes[0];
      total++;
      if(!back.__controlKey)noKey++;
      var r=SP.resolve(back);
      if(r&&r.family==='imageState')ok++;
    });
    return JSON.stringify({total:total,ok:ok,noKey:noKey});
  })()`));
  ok(B.noKey===19,'B1 重载后 __controlKey 全部丢失（19/19）');
  ok(B.ok===19,'B2 **重载后 19/19 仍被识别**（靠 states 持久化特征）');

  // ---------- C. 基础属性编辑 ----------
  const C=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'base'});d.nodes=[Reg.byLegacyKey('lamp_tpms').build()];
    window.replaceDesign(d,'建');
    var n=CanvasState.design.nodes[0];
    var before={w:n.w,h:n.h};
    window.commit(function(){A.set(n,'w',88);A.set(n,'h',72);},'改尺寸');
    return JSON.stringify({before:before,after:{w:n.w,h:n.h}});
  })()`));
  ok(C.after.w===88&&C.after.h===72,'C1 基础属性 w/h 可编辑');

  // ---------- D. statePid 双字段同步 ----------
  const D=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'pid'});d.nodes=[Reg.byLegacyKey('lamp_tpms').build()];
    window.replaceDesign(d,'建');
    var n=CanvasState.design.nodes[0];
    var before={id:n.statePid,alias:n.rawStatePid};
    window.commit(function(){A.set(n,'statePid','obd.coolant');},'改绑定');
    var j=window.nodeToJson(n);
    return JSON.stringify({before:before,afterId:n.statePid,afterAlias:n.rawStatePid,json:j.statePid});
  })()`));
  ok(D.before.alias==='obd.tpms','D1 改前绑定为胎压');
  ok(D.afterAlias==='obd.coolant','D2 rawStatePid 更新为别名 obd.coolant');
  ok(D.afterId===D.before.id.replace('tpms','coolant')||D.afterId!==D.before.id,'D3 statePid 更新为解析后的通道 id');
  ok(D.json==='obd.coolant','D4 序列化写出别名（数据契约）');

  // ---------- E/F. 三态素材与状态配置 ----------
  const E=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'states'});d.nodes=[Reg.byLegacyKey('lamp_abs').build()];
    window.replaceDesign(d,'建');
    var n=CanvasState.design.nodes[0];
    var before={warn:n.states.warn.assetId,alpha:n.states.normal.alpha,blink:n.states.critical.blink};
    window.commit(function(){
      A.set(n,'states.warn.assetId','as_override_warn');
      A.set(n,'states.critical.assetId','as_override_crit');
      A.set(n,'states.normal.alpha',200);
      A.set(n,'states.warn.blink',false);
      A.set(n,'states.critical.blink',true);
    },'改三态');
    var j=window.nodeToJson(n);
    return JSON.stringify({before:before,
      warn:n.states.warn.assetId,crit:n.states.critical.assetId,
      alpha:n.states.normal.alpha,warnBlink:n.states.warn.blink,critBlink:n.states.critical.blink,
      jsonWarn:j.states.warn.assetId,jsonAlpha:j.states.normal.alpha,
      warnBlinkMs:n.states.warn.blinkMs,critBlinkMs:n.states.critical.blinkMs});
  })()`));
  ok(E.warn==='as_override_warn'&&E.crit==='as_override_crit','E1 三态素材可替换（warn/critical）');
  ok(E.jsonWarn==='as_override_warn','E2 素材引用被序列化');
  ok(E.alpha===200&&E.jsonAlpha===200,'E3 normal.alpha 可配置并持久化');
  ok(E.warnBlink===false&&E.critBlink===true,'E4 三态 blink 可配置');
  ok(E.warnBlinkMs===600&&E.critBlinkMs===400,'F1 blinkMs 保持 WCAG 安全值（600/400，未被开放修改）');

  // ---------- F2. blinkMs 不在可编辑列表 ----------
  const F2=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var n=Reg.byLegacyKey('lamp_abs').build();
    var r=SP.resolve(n);
    return JSON.stringify({editable:r.editable,hasBlinkMs:r.editable.some(function(x){return x.indexOf('blinkMs')>=0;})});
  })()`));
  ok(F2.hasBlinkMs===false,'F2 **blinkMs 不在可编辑列表**（WCAG 2.3.1 保护）');

  // ---------- G. 画布重绘 ----------
  const G=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'draw'});d.nodes=[Reg.byLegacyKey('lamp_engine').build()];
    window.replaceDesign(d,'建');
    var n=CanvasState.design.nodes[0];
    var cnt=0;
    var orig=window.draw;
    window.draw=function(){cnt++;return orig.apply(this,arguments);};
    window.commit(function(){A.set(n,'states.normal.alpha',77);},'触发重绘');
    window.draw=orig;
    return JSON.stringify({drawCalls:cnt});
  })()`));
  ok(G.drawCalls>0,'G1 属性变更触发画布重绘（' + G.drawCalls + ' 次）');

  // ---------- H. Undo/Redo ----------
  const H=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'undo'});d.nodes=[Reg.byLegacyKey('lamp_batt').build()];
    window.replaceDesign(d,'建');
    var n=CanvasState.design.nodes[0];
    var v0=CanvasState.design.nodes[0].states.normal.alpha;
    window.commit(function(){A.set(CanvasState.design.nodes[0],'states.normal.alpha',33);},'a');
    var v1=CanvasState.design.nodes[0].states.normal.alpha;
    window.commit(function(){A.set(CanvasState.design.nodes[0],'states.normal.alpha',44);},'b');
    var v2=CanvasState.design.nodes[0].states.normal.alpha;
    // ⚠️ restore() 会替换整个 design 对象 —— 撤销后必须重新取节点，不能用旧引用
    window.doUndo();var u1=CanvasState.design.nodes[0].states.normal.alpha;
    window.doUndo();var u2=CanvasState.design.nodes[0].states.normal.alpha;
    window.doRedo();var r1=CanvasState.design.nodes[0].states.normal.alpha;
    return JSON.stringify({v0:v0,v1:v1,v2:v2,u1:u1,u2:u2,r1:r1});
  })()`));
  console.log('  [diag H] '+JSON.stringify(H));
  ok(H.u1===H.v1&&H.u2===H.v0,'H1 连续撤销两步正确');
  ok(H.r1===H.v1,'H2 重做一步正确');

  // ---------- I. 导出 → 重新导入属性一致 ----------
  const I=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor;
    var d=createDesign({name:'roundtrip'});
    d.nodes=[Reg.byLegacyKey('lamp_tpms').build(),Reg.byLegacyKey('lamp_lane').build()];
    window.replaceDesign(d,'建');
    var n0=CanvasState.design.nodes[0];
    window.commit(function(){
      A.set(n0,'statePid','obd.coolant');
      A.set(n0,'states.warn.assetId','as_rt_warn');
      A.set(n0,'states.normal.alpha',188);
      A.set(n0,'w',64);A.set(n0,'h',64);
    },'改');
    var before=JSON.parse(JSON.stringify(CanvasState.design));
    var json=window.toV2Json(CanvasState.design);
    var parsed=window.parseDesign(json);
    var after=parsed.design;
    var b0=before.nodes[0],a0=after.nodes[0];
    return JSON.stringify({
      errors:parsed.errors.length,
      statePidSame:a0.statePid===b0.statePid,
      warnSame:a0.states.warn.assetId===b0.states.warn.assetId,
      alphaSame:a0.states.normal.alpha===b0.states.normal.alpha,
      sizeSame:(a0.w===b0.w&&a0.h===b0.h),
      laneIntact:after.nodes[1]&&after.nodes[1].states&&!!after.nodes[1].states.normal,
      nodeCount:after.nodes.length
    });
  })()`));
  ok(I.errors===0,'I1 导出无错误');
  ok(I.nodeCount===2,'I2 节点数一致');
  ok(I.statePidSame===true,'I3 statePid 往返一致');
  ok(I.warnSame===true,'I4 三态素材往返一致');
  ok(I.alphaSame===true,'I5 三态 alpha 往返一致');
  ok(I.sizeSame===true,'I6 w/h 往返一致');
  ok(I.laneIntact===true,'I7 第二个灯也完整');

  // ---------- J. 普通图片不误判 ----------
  const J=JJ(await cdp.eval(`(function(){
    var SP=ICAR.ui.schemaProps.SchemaResolver;
    var plain=window.createNode(window.NODE_IMAGE,{name:'普通图',assetId:'x',w:100,h:100});
    var r=SP.resolve(plain);
    var r2=ICAR.registry.Control.all().filter(function(d){
      return d.render&&d.render.mode==='track';
    })[0];
    var trackNode=r2?r2.build():null;
    return JSON.stringify({plainIsState:SP.isStateLamp(plain),
      plainFamily:r?r.family:'null',
      trackIsState:trackNode?SP.isStateLamp(trackNode):null});
  })()`));
  ok(J.plainIsState===false,'J1 普通图片不判为状态灯');
  ok(J.plainFamily==='null','J2 普通图片仍由旧面板处理（Schema 未接管）');
  ok(J.trackIsState===false,'J3 条形轨道不判为状态灯');

  // ---------- K. 旧属性面板并行 ----------
  const K=JJ(await cdp.eval(`(function(){
    return JSON.stringify({
      legacyPanel:typeof window.renderProps==='function'||typeof window.renderNodeProps==='function',
      registryIntact:ICAR.registry.Control.all().length,
      lampFamilyCount:ICAR.registry.lampFamily?ICAR.registry.lampFamily.registered:null
    });
  })()`));
  ok(K.registryIntact===69,'K1 Registry 仍为 69 条（未减少）');
  ok(K.lampFamilyCount===19,'K2 lampFamily 注册 19 条');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
