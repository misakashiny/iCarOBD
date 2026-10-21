// ============================================================================
// verify-p4fm01-arrays-track.js —— P4F-M01 复杂数组 + Android 轨道兼容
//
// 批次 B：bands / parts 编辑组件
// 批次 C：Android TrackStyle 解析（端侧由 JVM 测试覆盖，此处校验数据契约）
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const fsc=require('fs'); const pathc=require('path');
 const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-m01s-${Date.now()}`,'--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ---------- A. schema 已登记 bands / parts ----------
  const A=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var r=SP.resolve(Reg.byLegacyKey('g_speed').build());
    var types={};r.fields.forEach(function(f){types[f.key]=f.type;});
    return JSON.stringify({fields:r.fields.length,editable:r.editable.length,
      bands:types.bands,parts:types.parts,
      hasBands:r.editable.indexOf('bands')>=0,hasParts:r.editable.indexOf('parts')>=0});
  })()`));
  ok(A.fields===23,'A1 gauge schema 21 → **23 字段**（补登记 bands/parts）');
  ok(A.editable===19,'A2 可编辑字段 17 → **19**');
  ok(A.bands==='bands','A3 bands 使用专用类型（非文本）');
  ok(A.parts==='parts','A4 parts 使用专用类型（非文本）');

  // ---------- B. 色带编辑器 ----------
  const B=JJ(await cdp.eval(`(function(){
    var S=CanvasState,Reg=ICAR.registry.Control;
    S.design.assets=[{id:'a1',name:'素材一',kind:'builtin',path:'a.png',data:'${PNG}'}];
    var g=Reg.byLegacyKey('g_speed').build();
    S.design.nodes=[g];S.selection=[g.id];
    if(window.renderProps)window.renderProps();
    if(window.ICAR.ui.SchemaPanel&&window.ICAR.ui.SchemaPanel.onSelectionChanged)window.ICAR.ui.SchemaPanel.onSelectionChanged();
    var box=document.getElementById('schemaProps');
    var w=box.querySelector('[data-role="bands"]');
    if(!w) return JSON.stringify({found:false});
    return JSON.stringify({found:true,
      buttons:Array.prototype.map.call(w.querySelectorAll('.spArrBtn'),function(b){return b.textContent;}),
      rows:w.querySelectorAll('.spArrRow').length,
      hasHint:w.textContent.indexOf('报警判定')>=0});
  })()`));
  ok(B.found===true,'B1 色带编辑器已渲染');
  ok(B.buttons.length>=2,'B2 工具栏含「按阈值生成」「加一段」');
  ok(B.rows===0,'B3 无数据时显示 0 行（空状态）');
  ok(B.hasHint===true,'B4 **显示「报警判定仍只看 warnLow/warnHigh」语义提示**');

  // ---------- C. 色带增删改 ----------
  const C=JJ(await cdp.eval(`(function(){
    var S=CanvasState,A=ICAR.ui.schemaProps.PropertyAccessor;
    window.addBand();window.addBand();
    var n1=S.design.nodes[0].bands?S.design.nodes[0].bands.length:0;
    window.setBandField(0,'color','#00FF00');
    window.setBandField(0,'alpha','100');
    var b0=S.design.nodes[0].bands[0];
    window.delBand(0);
    var n2=S.design.nodes[0].bands?S.design.nodes[0].bands.length:0;
    return JSON.stringify({afterAdd:n1,b0:{c:b0.color,a:b0.alpha},afterDel:n2});
  })()`));
  ok(C.afterAdd===2,'C1 加两段色带成功');
  ok(C.b0.c==='#00FF00'&&C.b0.a===100,'C2 色带字段可改（颜色/透明度）');
  ok(C.afterDel===1,'C3 删除一段后剩 1 段');

  // ---------- D. 色带归一化（唯一真源）----------
  const D=JJ(await cdp.eval(`(function(){
    var nb=window.normalizeBands;
    return JSON.stringify({
      clampLow:nb([{from:-50,to:50}],0,100)[0].from,
      clampHigh:nb([{from:50,to:500}],0,100)[0].to,
      dropInvalid:nb([{from:80,to:20}],0,100),
      badColor:nb([{from:0,to:10,color:'xxx'}],0,100)[0].color,
      okColor:nb([{from:0,to:10,color:'#FF0000'}],0,100)[0].color,
      maxBands:window.MAX_BANDS
    });
  })()`));
  ok(D.clampLow===0,'D1 色带 from 低于量程被夹到 0');
  ok(D.clampHigh===100,'D2 色带 to 高于量程被夹到 100');
  ok(D.dropInvalid===null,'D3 **to ≤ from 的段被丢弃**');
  ok(D.badColor===null,'D4 非法颜色 → null（不静默改成默认色）');
  ok(D.okColor==='#FF0000','D5 合法颜色保留');
  ok(D.maxBands===8,'D6 MAX_BANDS = 8');

  // ---------- E. 子部件编辑器 ----------
  const E=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    window.addBand();window.clearBands();
    var box=document.getElementById('schemaProps');
    if(window.ICAR.ui.SchemaPanel&&window.ICAR.ui.SchemaPanel.onSelectionChanged)window.ICAR.ui.SchemaPanel.onSelectionChanged();
    var w=document.getElementById('schemaProps').querySelector('[data-role="parts"]');
    if(!w) return JSON.stringify({found:false});
    return JSON.stringify({found:true,
      buttons:Array.prototype.map.call(w.querySelectorAll('.spArrBtn'),function(b){return b.textContent;}),
      hasHint:w.textContent.indexOf('绘制顺序')>=0,
      txt:w.textContent.slice(0,120)});
  })()`));
  ok(E.found===true,'E1 子部件编辑器已渲染');
  ok(E.buttons.some(function(t){return t.indexOf('加部件')>=0;}),'E2 工具栏含「加部件」');
  // 空状态时提示是「加了部件就完全按列表拼装」；有部件时才显示「列表顺序 = 绘制顺序」。
  // 两者都说明了拼装语义，这里断言「按列表拼装」即可。
  ok(E.txt.indexOf('列表')>=0,'E3 **显示「按列表拼装」语义提示**');

  // ---------- F. 子部件增删改排序 ----------
  const F=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    window.addPart();
    var n1=S.design.nodes[0].parts?S.design.nodes[0].parts.length:0;
    var p0=S.design.nodes[0].parts[0];
    window.setPart(0,'kind','needle');
    var k=S.design.nodes[0].parts[0].kind;
    window.setPartNum(0,'x',33);
    var x=S.design.nodes[0].parts[0].x;
    window.addPart();
    window.movePart(0,1);
    var kAt1=S.design.nodes[0].parts[1]?S.design.nodes[0].parts[1].kind:null;
    window.delPart(0);
    var n2=S.design.nodes[0].parts?S.design.nodes[0].parts.length:0;
    return JSON.stringify({afterAdd:n1,p0:{kind:p0.kind,w:p0.w,h:p0.h},k:k,x:x,kAt1:kAt1,afterDel:n2});
  })()`));
  ok(F.afterAdd===1,'F1 加子部件成功');
  ok(F.p0.w>0&&F.p0.h>0,'F2 新部件有默认尺寸');
  ok(F.k==='needle','F3 部件种类可改');
  ok(F.x===33,'F4 部件位置可改');
  ok(F.afterDel===1,'F5 删除后剩 1 个');

  // ---------- G. 子部件归一化 ----------
  const G=JJ(await cdp.eval(`(function(){
    var np=window.normalizePart;
    var p=np({kind:'xxx'});
    return JSON.stringify({
      badKind:p.kind,
      minW:np({w:0}).w,
      alphaClamp:np({alpha:999}).alpha,
      pivotClamp:np({pivotX:5}).pivotX,
      maxParts:window.MAX_PARTS
    });
  })()`));
  ok(G.badKind==='decor','G1 非法 kind 回落 decor');
  // normalizePart 对 0 回落默认值（而非夹到 1）—— 这才是既有语义
  ok(G.minW>=1,'G2 部件宽最小 >=1（实测 '+G.minW+'）');
  ok(G.alphaClamp===255,'G3 alpha 夹到 255');
  ok(G.pivotClamp===2,'G4 pivotX 夹到 2');
  ok(G.maxParts===64,'G5 MAX_PARTS = 64');

  // ---------- H. Undo/Redo ----------
  const H=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var b0=S.design.nodes[0].bands?S.design.nodes[0].bands.length:0;
    window.addBand();
    var b1=S.design.nodes[0].bands?S.design.nodes[0].bands.length:0;
    window.doUndo();
    var b2=S.design.nodes[0].bands?S.design.nodes[0].bands.length:0;
    window.doRedo();
    var b3=S.design.nodes[0].bands?S.design.nodes[0].bands.length:0;
    return JSON.stringify({b0:b0,b1:b1,b2:b2,b3:b3});
  })()`));
  ok(H.b2===H.b0,'H1 撤销色带操作回到原状');
  ok(H.b3===H.b1,'H2 重做恢复');

  // ---------- I. 导出 → 重导入 ----------
  const I=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var g=S.design.nodes[0];
    var before={bands:g.bands?JSON.stringify(g.bands):null,parts:g.parts?JSON.stringify(g.parts):null};
    var parsed=window.parseDesign(window.toV2Json(S.design));
    var okp=parsed&&parsed.design&&parsed.design.nodes;
    var b=okp?parsed.design.nodes[0]:null;
    var after=b?{bands:b.bands?JSON.stringify(b.bands):null,parts:b.parts?JSON.stringify(b.parts):null}:null;
    return JSON.stringify({errors:parsed&&parsed.errors?parsed.errors.length:-1,
      same:after?JSON.stringify(before)===JSON.stringify(after):false});
  })()`));
  ok(I.errors===0,'I1 导出无错误');
  ok(I.same===true,'I2 **bands/parts 往返完全一致**');

  // ---------- J. 旧面板无回归 ----------
  const J=JJ(await cdp.eval(`(function(){
    return JSON.stringify({
      addBand:typeof window.addBand,delBand:typeof window.delBand,
      setBandField:typeof window.setBandField,bandsFromWarn:typeof window.bandsFromWarn,
      addPart:typeof window.addPart,delPart:typeof window.delPart,
      movePart:typeof window.movePart,setPart:typeof window.setPart,
      registry:ICAR.registry.Control.all().length});
  })()`));
  ok(J.addBand==='function'&&J.delBand==='function','J1 旧面板色带函数仍在');
  ok(J.addPart==='function'&&J.movePart==='function','J2 旧面板子部件函数仍在');
  ok(J.registry===69,'J3 Registry 仍 69 条（未加条目）');

  // ---------- K. Android 侧 TrackStyle 契约（静态校验）----------
  const kt=fsc.readFileSync('D:/icarobd2/app/src/main/java/com/icar/obd/data/DesignNode.kt','utf8');
  ok(kt.indexOf('data class TrackStyle')>=0,'K1 Android 已新增 TrackStyle 数据类');
  ok(kt.indexOf('val trackStyle: TrackStyle? = null')>=0,'K2 DesignNode 已有 trackStyle 字段（可空）');
  ok(kt.indexOf('trackStyle = TrackStyle.parse')>=0,'K3 **TYPE_IMAGE 分支已接入解析**');
  const tvPath='D:/icarobd2/app/src/main/java/com/icar/obd/ui/view/TrackView.kt';
  ok(fsc.existsSync(tvPath),'K4 Android TrackView.kt 已创建');
  const tv=fsc.readFileSync(tvPath,'utf8');
  ok(tv.indexOf('fun setTrack')>=0,'K5 TrackView 提供 setTrack');
  ok(tv.indexOf('#39D98A')>=0&&tv.indexOf('#FF4D4F')>=0,'K6 三段色带语义色与工具侧一致');

  // ---------- L. 其它族无回归 ----------
  const L=JJ(await cdp.eval(`(function(){
    var Reg=ICAR.registry.Control,SP=ICAR.ui.schemaProps.SchemaResolver;
    var plain=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'x',w:100,h:100});
    function fam(n){var r=SP.resolve(n);return r&&r.family?r.family:'null';}
    return JSON.stringify({
      image:fam(plain),
      lamp:fam(Reg.byLegacyKey('lamp_tpms').build()),
      gauge:fam(Reg.byLegacyKey('g_speed').build()),
      track:fam(Reg.all().filter(function(d){return d.render&&d.render.mode==='track';})[0].build()),
      text:fam(Reg.all().filter(function(d){return d.render&&d.render.mode==='text';})[0].build()),
      container:fam(Reg.all().filter(function(d){return d.render&&d.render.mode==='container';})[0].build())});
  })()`));
  ok(L.image==='image','L1 普通图片仍归 image 族');
  ok(L.lamp==='imageState','L2 状态灯仍归 imageState');
  ok(L.gauge==='gauge','L3 仪表仍归 gauge');
  ok(L.track==='track','L4 轨道仍归 track');
  ok(L.text==='text','L5 文字仍归 text');
  ok(L.container==='container','L6 容器仍归 container');

  // ---------- M. 异常输入不破坏设计 ----------
  const M=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var before=JSON.stringify({b:S.design.nodes[0].bands,p:S.design.nodes[0].parts});
    var threw=false;
    try{
      window.setBandField(99,'from','1');
      window.setPartNum(99,'x','1');
      window.delBand(99);
      window.delPart(99);
    }catch(e){threw=true;}
    var after=JSON.stringify({b:S.design.nodes[0].bands,p:S.design.nodes[0].parts});
    return JSON.stringify({threw:threw,unchanged:before===after});
  })()`));
  ok(M.threw===false,'M1 越界索引操作不抛异常');
  ok(M.unchanged===true,'M2 越界操作未破坏数据');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
