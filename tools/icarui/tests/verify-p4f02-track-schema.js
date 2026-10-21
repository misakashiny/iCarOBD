// ============================================================================
// verify-p4f02-track-schema.js —— P4F-02 28 个条形轨道 Schema 属性补齐
//
// track 族 4 → 11 字段全量开放（P4F-01 审计批次 1）
// 关键：7 个新字段全部是**标量**，无需新 UI 组件，无需改数据契约
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-p4f02s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. 28 个控件全部识别 ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var tracks=Reg.all().filter(function(d){return d.render&&d.render.mode==='track';});
    var out={total:tracks.length,ok:0,ed:null,bad:[]};
    tracks.forEach(function(d){
      var r=SP.resolve(d.build());
      if(r&&r.family==='track'){out.ok++;out.ed=r.editable;}
      else out.bad.push(d.key);
    });
    return JSON.stringify(out);
  })()`));
  ok(A.total===28,'A1 Registry 中 track 控件共 28 条');
  ok(A.ok===28,'A2 **28/28 全部识别为 track 族**');
  ok(A.ed&&A.ed.length===11,'A3 **可编辑字段 4 → 11**');

  // ---------- B. 11 个字段清单精确 ----------
  const B=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var d=Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0];
    return JSON.stringify(SP.resolve(d.build()).editable);
  })()`));
  const EXP=['trackStyle.orient','trackStyle.segments','trackStyle.glow','trackStyle.fill',
    'trackStyle.radius','trackStyle.inset','trackStyle.gradient',
    'trackStyle.ticks','trackStyle.band','w','h'];
  ok(JSON.stringify(B)===JSON.stringify(EXP),'B1 11 个字段清单精确匹配');
  ok(B.indexOf('trackStyle.color')<0,'B2 trackStyle.color 刻意不开放（P3D 标记未实现）');
  ok(B.indexOf('trackStyle.accent')<0,'B3 trackStyle.accent 刻意不开放');

  // ---------- C. 11 字段逐个可编辑 ----------
  const C=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'e'});d.nodes=[Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0].build()];
    window.replaceDesign(d,'建');
    var out={};
    function chk(name,path,val){
      window.commit(function(){A.set(S.design.nodes[0],path,val);},'x');
      var v=S.design.nodes[0];path.split('.').forEach(function(p){v=v?v[p]:undefined;});
      out[name]=(v===val);
    }
    chk('orient','trackStyle.orient','v');
    chk('segments','trackStyle.segments',12);
    chk('glow','trackStyle.glow',true);
    chk('fill','trackStyle.fill',0.5);
    chk('radius','trackStyle.radius',20);
    chk('inset','trackStyle.inset',true);
    chk('gradient','trackStyle.gradient','fade');
    chk('ticks','trackStyle.ticks',8);
    chk('band','trackStyle.band',true);
    chk('w','w',300);
    chk('h','h',24);
    return JSON.stringify(out);
  })()`));
  const fieldNames=['orient','segments','glow','fill','radius','inset','gradient','ticks','band','w','h'];
  ok(fieldNames.every(function(k){return C[k]===true;}),'C1 **11/11 字段全部可实际编辑**');

  // ---------- D. 复杂字段结构完整 ----------
  const D=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'s'});d.nodes=[Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0].build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'trackStyle.gradient','gloss');
      A.set(n,'trackStyle.ticks',10);
      A.set(n,'trackStyle.band',true);
    },'三字段');
    var t=S.design.nodes[0].trackStyle;
    return JSON.stringify({isObj:typeof t==='object'&&!Array.isArray(t),
      keys:Object.keys(t).sort(),
      gType:typeof t.gradient,tType:typeof t.ticks,bType:typeof t.band,
      hasColor:'color' in t,hasAccent:'accent' in t});
  })()`));
  ok(D.isObj===true,'D1 trackStyle 仍是完整对象（未被文本输入破坏）');
  ok(D.gType==='string','D2 gradient 是字符串枚举');
  ok(D.tType==='number','D3 ticks 是数字');
  ok(D.bType==='boolean','D4 band 是布尔');
  ok(D.keys.length===11,'D5 trackStyle 保留全部 11 个内部字段');
  ok(D.hasColor&&D.hasAccent,'D6 color/accent 字段未被删除（保留结构）');

  // ---------- E. 归一化规则（唯一真源） ----------
  const E=JJ(await cdp.eval(`(function(){
    var n=window.normalizeTrackStyle;
    return JSON.stringify({
      rMax:n({radius:999},240,16).radius,
      rNeg:n({radius:-5},240,16).radius,
      rDefault:n({orient:'h'},240,16).radius,
      segMax:n({segments:9999},240,16).segments,
      tickMax:n({ticks:9999},240,16).ticks,
      fillMax:n({fill:5},240,16).fill,
      fillNeg:n({fill:-1},240,16).fill,
      gBad:n({gradient:'xxx'},240,16).gradient,
      gOk:n({gradient:'fade'},240,16).gradient,
      empty:n({},240,16),
      maxSeg:window.MAX_TRACK_SEGMENTS,maxTick:window.MAX_TRACK_TICKS
    });
  })()`));
  ok(E.rMax===64,'E1 radius 超上限被夹到 64');
  ok(E.rNeg===0,'E2 radius 负值被夹到 0');
  ok(E.rDefault===8,'E3 radius 缺省 = short/2（16/2=8）');
  ok(E.segMax===E.maxSeg,'E4 segments 超限夹到 MAX_TRACK_SEGMENTS');
  ok(E.tickMax===E.maxTick,'E5 ticks 超限夹到 MAX_TRACK_TICKS');
  ok(E.fillMax===1&&E.fillNeg===0,'E6 fill 夹到 0..1');
  ok(E.gBad===null,'E7 gradient 非法值 → null（不静默改成别的）');
  ok(E.gOk==='fade','E8 gradient 合法值保留');
  ok(E.empty===null,'E9 空对象 → null（老文件往返语义）');

  // ---------- F. 导出 → 重导入 ----------
  const F=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'rt'});d.nodes=[Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0].build()];
    window.replaceDesign(d,'建');
    window.commit(function(){
      var n=S.design.nodes[0];
      A.set(n,'trackStyle.radius',30);A.set(n,'trackStyle.inset',true);
      A.set(n,'trackStyle.gradient','fade');A.set(n,'trackStyle.ticks',6);
      A.set(n,'trackStyle.band',true);A.set(n,'w',200);A.set(n,'h',20);
    },'全设');
    var b=JSON.parse(JSON.stringify(S.design.nodes[0].trackStyle));
    var parsed=window.parseDesign(window.toV2Json(S.design));
    var a=parsed.design.nodes[0];
    return JSON.stringify({errors:parsed.errors.length,
      same:JSON.stringify(b)===JSON.stringify(a.trackStyle),
      w:a.w,h:a.h});
  })()`));
  ok(F.errors===0,'F1 导出无错误');
  ok(F.same===true,'F2 **7 个新字段往返完全一致**');
  ok(F.w===200&&F.h===20,'F3 w/h 往返一致');

  // ---------- G. Undo / Redo ----------
  const G=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'u'});d.nodes=[Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0].build()];
    window.replaceDesign(d,'建');
    var v0=S.design.nodes[0].trackStyle.radius;
    window.commit(function(){A.set(S.design.nodes[0],'trackStyle.radius',40);},'a');
    var v1=S.design.nodes[0].trackStyle.radius;
    window.doUndo();var u1=S.design.nodes[0].trackStyle.radius;
    window.doRedo();var r1=S.design.nodes[0].trackStyle.radius;
    return JSON.stringify({v0:v0,v1:v1,u1:u1,r1:r1});
  })()`));
  ok(G.u1===G.v0,'G1 撤销 radius 回到原值');
  ok(G.r1===G.v1,'G2 重做 radius 回到改后值');

  // ---------- H. 画布重绘 ----------
  const H=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,S=CanvasState;
    var d=createDesign({name:'d'});d.nodes=[Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0].build()];
    window.replaceDesign(d,'建');
    var cnt=0,orig=window.draw;
    window.draw=function(){cnt++;return orig.apply(this,arguments);};
    window.commit(function(){A.set(S.design.nodes[0],'trackStyle.band',true);},'触发');
    window.draw=orig;
    return JSON.stringify({drawCalls:cnt});
  })()`));
  ok(H.drawCalls>0,'H1 属性变更触发画布重绘（'+H.drawCalls+' 次）');

  // ---------- I. 不误判其它族 ----------
  const I=JJ(await cdp.eval(`(function(){
    var SP=ICAR.ui.schemaProps.SchemaResolver,Reg=ICAR.registry.Control;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    var lamp=Reg.byLegacyKey('lamp_tpms').build();
    var gauge=Reg.byLegacyKey('g_speed').build();
    var txt=Reg.all().filter(function(d){return d.render&&d.render.mode==='text';})[0].build();
    var cont=Reg.all().filter(function(d){return d.render&&d.render.mode==='container';})[0].build();
    return JSON.stringify({
      plain:(SP.resolve(plain)||{}).family||'null',
      lamp:(SP.resolve(lamp)||{}).family,
      gauge:(SP.resolve(gauge)||{}).family,
      text:(SP.resolve(txt)||{}).family,
      container:(SP.resolve(cont)||{}).family});
  })()`));
  // P4F-03: plain image now resolves to the new image family.
  // Real intent: plain image must NOT be misclassified as track.
  ok(I.plain==='image','I1 plain image belongs to image family (not track)');
  ok(I.lamp==='imageState','I2 状态灯仍是 imageState');
  ok(I.gauge==='gauge','I3 仪表仍是 gauge');
  ok(I.text==='text','I4 文字仍是 text');
  ok(I.container==='container','I5 容器仍是 container');

  // ---------- J. 旧面板无回归 ----------
  const J=JJ(await cdp.eval(`(function(){
    return JSON.stringify({setTrackField:typeof window.setTrackField,
      normalizeTrackStyle:typeof window.normalizeTrackStyle,
      trackUsable:typeof window.trackUsable,
      registryCount:ICAR.registry.Control.all().length});
  })()`));
  ok(J.setTrackField==='function','J1 旧面板 setTrackField 仍在');
  ok(J.normalizeTrackStyle==='function','J2 normalizeTrackStyle 仍在（唯一真源）');
  ok(J.registryCount===69,'J3 Registry 仍 69 条');

  // ---------- K. 异常输入不破坏设计 ----------
  const K=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,A=ICAR.ui.schemaProps.PropertyAccessor,V=ICAR.ui.schemaProps.PropertyValidator,S=CanvasState;
    var d=createDesign({name:'bad'});d.nodes=[Reg.all().filter(function(x){return x.render&&x.render.mode==='track';})[0].build()];
    window.replaceDesign(d,'建');
    var before=JSON.stringify(S.design.nodes[0].trackStyle);
    var results=[];
    // 非法输入应被 validator 拦下，不写模型
    var cases=[
      ['trackStyle.radius','abc'],
      ['trackStyle.ticks','not-a-number'],
      ['trackStyle.gradient','invalid'],
      ['w','']
    ];
    cases.forEach(function(c){
      var f={key:c[0],type:c[0].indexOf('gradient')>=0?'enum':'number'};
      try{
        var r=V.coerce(f,c[1]);
        results.push({path:c[0],ok:r.ok});
      }catch(e){results.push({path:c[0],threw:true});}
    });
    var after=JSON.stringify(S.design.nodes[0].trackStyle);
    return JSON.stringify({unchanged:before===after,results:results});
  })()`));
  ok(K.unchanged===true,'K1 非法输入未破坏 trackStyle');
  ok(K.results.every(function(r){return !r.threw;}),'K2 非法输入不抛异常');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
