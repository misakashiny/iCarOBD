// ============================================================================
// verify-p4fm02-ui-panel.js —— P4F-M02 阶段 B1：属性面板真实 UI 自动化
//
// 核心要求（任务明确）：
//   「不能只通过检查源代码中存在某个函数或字段就判定 GUI 可用。」
//
// 本套件通过 CDP 在**真实 DOM** 上操作：
//   · 真实点击按钮（.click() 触发 addEventListener）
//   · 真实修改 input 并派发 change 事件
//   · 真实读取 rendered DOM 的值与选项
//   · 真实检查画布像素变化
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const fsc=require('fs');
 const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',
   `--remote-debugging-port=${PORT}`,`--user-data-dir=${os.tmpdir()}\\edge-m02ui-${Date.now()}`,
   '--window-size=1700,1050','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // 通用：选中一个节点并刷新面板
  const setupNode = async (js) => {
    return JJ(await cdp.eval(`(function(){
      var S=CanvasState;
      ${js}
      if(window.renderProps)window.renderProps();
      if(window.ICAR.ui.SchemaPanel&&window.ICAR.ui.SchemaPanel.onSelectionChanged){
        window.ICAR.ui.SchemaPanel.onSelectionChanged();
      }
      return JSON.stringify({ok:true});
    })()`));
  };

  // ================= 一、普通图片：真实 UI 编辑素材 =================
  console.log('=== B1-1. 普通图片：真实 UI 操作 ===');
  await setupNode(`
    S.design.assets=[
      {id:'a1',name:'素材甲',kind:'builtin',path:'a1.png',data:'${PNG}'},
      {id:'a2',name:'素材乙',kind:'import',path:'a2.png',data:'${PNG}'}
    ];
    var n=window.createNode(window.NODE_IMAGE,{name:'图',assetId:'a1',w:100,h:100});
    S.design.nodes=[n];S.selection=[n.id];
  `);
  const img1=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var sel=box.querySelector('select[data-role="asset"]');
    var wIn=box.querySelector('.spRow[data-path="w"] input');
    var hIn=box.querySelector('.spRow[data-path="h"] input');
    return JSON.stringify({
      family:window.ICAR.ui.SchemaPanel.currentFamily(),
      hasAssetSel:!!sel,
      assetOptions:sel?Array.prototype.map.call(sel.options,function(o){return o.value;}):[],
      assetSelected:sel?sel.value:null,
      wValue:wIn?wIn.value:null,
      hValue:hIn?hIn.value:null
    });
  })()`));
  ok(img1.family==='image','B1-1a 普通图片面板显示 image 族');
  ok(img1.hasAssetSel===true,'B1-1b 真实渲染出素材 <select>');
  ok(img1.assetOptions.length===3,'B1-1c 下拉含「未选」+2 素材 = 3 项');
  ok(img1.assetSelected==='a1','B1-1d 当前素材 a1 正确回显');
  ok(img1.wValue==='100'&&img1.hValue==='100','B1-1e 宽高正确回显（100/100）');

  // 真实修改：派发 change 事件
  const img2=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var sel=box.querySelector('select[data-role="asset"]');
    sel.value='a2';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({assetId:CanvasState.design.nodes[0].assetId});
  })()`));
  ok(img2.assetId==='a2','B1-1f **真实 change 事件后素材切换生效**');

  const img3=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var wIn=box.querySelector('.spRow[data-path="w"] input');
    wIn.value='150';
    wIn.dispatchEvent(new Event('input',{bubbles:true}));
    wIn.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({w:CanvasState.design.nodes[0].w});
  })()`));
  ok(img3.w===150,'B1-1g **真实输入事件后宽度改为 150**');

  // ================= 二、状态灯 =================
  console.log('\n=== B1-2. 状态灯 ===');
  await setupNode(`
    var n=ICAR.registry.Control.byLegacyKey('lamp_tpms').build();
    S.design.nodes=[n];S.selection=[n.id];
  `);
  const lamp1=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var rows=box.querySelectorAll('.spRow');
    var paths=Array.prototype.map.call(rows,function(r){return r.getAttribute('data-path');});
    return JSON.stringify({family:window.ICAR.ui.SchemaPanel.currentFamily(),
      rows:rows.length,paths:paths.slice(0,12),
      hasStatePid:paths.indexOf('statePid')>=0});
  })()`));
  ok(lamp1.family==='imageState','B1-2a 状态灯面板显示 imageState 族');
  ok(lamp1.rows===11,'B1-2b **真实渲染 11 行属性**');
  ok(lamp1.hasStatePid===true,'B1-2c 含 statePid 行');

  // ================= 三、条形轨道 =================
  console.log('\n=== B1-3. 条形轨道 ===');
  await setupNode(`
    var d=ICAR.registry.Control.all().filter(function(x){return x.render&&x.render.mode==='track';})[0];
    var n=d.build();S.design.nodes=[n];S.selection=[n.id];
  `);
  const trk1=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var rows=box.querySelectorAll('.spRow');
    return JSON.stringify({family:window.ICAR.ui.SchemaPanel.currentFamily(),
      rows:rows.length,
      hasRadius:!!box.querySelector('.spRow[data-path="trackStyle.radius"] input'),
      hasTicks:!!box.querySelector('.spRow[data-path="trackStyle.ticks"] input'),
      hasGradient:!!box.querySelector('.spRow[data-path="trackStyle.gradient"] select')});
  })()`));
  ok(trk1.family==='track','B1-3a 轨道面板显示 track 族');
  ok(trk1.rows===11,'B1-3b **真实渲染 11 行**');
  ok(trk1.hasRadius&&trk1.hasTicks&&trk1.hasGradient,'B1-3c 圆角/刻度/渐变控件真实存在');

  // 真实修改 radius
  const trk2=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var i=box.querySelector('.spRow[data-path="trackStyle.radius"] input');
    i.value='20';i.dispatchEvent(new Event('input',{bubbles:true}));
    i.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({radius:CanvasState.design.nodes[0].trackStyle.radius});
  })()`));
  ok(trk2.radius===20,'B1-3d **真实输入后圆角改为 20**');

  // ================= 四、文字 =================
  console.log('\n=== B1-4. 文字 ===');
  await setupNode(`
    var n=ICAR.registry.Control.byLegacyKey('t_label').build();
    S.design.nodes=[n];S.selection=[n.id];
  `);
  const txt1=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    return JSON.stringify({family:window.ICAR.ui.SchemaPanel.currentFamily(),
      rows:box.querySelectorAll('.spRow').length,
      hasW:!!box.querySelector('.spRow[data-path="w"] input'),
      hasFontSize:!!box.querySelector('.spRow[data-path="font.size"] input')});
  })()`));
  ok(txt1.family==='text','B1-4a 文字面板显示 text 族');
  ok(txt1.rows===7,'B1-4b **真实渲染 7 行**');
  ok(txt1.hasW&&txt1.hasFontSize,'B1-4c 含宽度与字号');

  const txt2=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var t=box.querySelector('.spRow[data-path="text"] input');
    t.value='测试文字';t.dispatchEvent(new Event('input',{bubbles:true}));
    t.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({text:CanvasState.design.nodes[0].text});
  })()`));
  ok(txt2.text==='测试文字','B1-4d **真实输入后文字内容变更**');

  // ================= 五、容器 =================
  console.log('\n=== B1-5. 容器 ===');
  await setupNode(`
    var n=ICAR.registry.Control.get('group').build();
    S.design.nodes=[n];S.selection=[n.id];
  `);
  const ctr1=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    return JSON.stringify({family:window.ICAR.ui.SchemaPanel.currentFamily(),
      rows:box.querySelectorAll('.spRow').length,
      hasScale:!!box.querySelector('.spRow[data-path="scale"] input')});
  })()`));
  ok(ctr1.family==='container','B1-5a 容器面板显示 container 族');
  ok(ctr1.rows===7,'B1-5b **真实渲染 7 行**');
  ok(ctr1.hasScale===true,'B1-5c 含 scale 控件');

  const ctr2=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    var i=box.querySelector('.spRow[data-path="scale"] input');
    i.value='1.5';i.dispatchEvent(new Event('input',{bubbles:true}));
    i.dispatchEvent(new Event('change',{bubbles:true}));
    return JSON.stringify({scale:CanvasState.design.nodes[0].scale});
  })()`));
  ok(ctr2.scale===1.5,'B1-5d **真实输入后缩放改为 1.5**');

  // ================= 六、仪表 =================
  console.log('\n=== B1-6. 仪表 ===');
  await setupNode(`
    var n=ICAR.registry.Control.byLegacyKey('g_speed').build();
    S.design.nodes=[n];S.selection=[n.id];
  `);
  const gau1=JJ(await cdp.eval(`(function(){
    var box=document.getElementById('schemaProps');
    return JSON.stringify({family:window.ICAR.ui.SchemaPanel.currentFamily(),
      rows:box.querySelectorAll('.spRow').length,
      hasBands:!!box.querySelector('[data-role="bands"]'),
      hasParts:!!box.querySelector('[data-role="parts"]'),
      hasPid:!!box.querySelector('.spRow[data-path="pid"]'),
      editableInputs:box.querySelectorAll('.spRow input, .spRow select').length,
      arrayWraps:box.querySelectorAll('.spArrayWrap').length});
  })()`));
  ok(gau1.family==='gauge','B1-6a 仪表面板显示 gauge 族');
  // 面板渲染**全部 23 个 schema 字段**（19 可编辑 + 4 只读）。
  // 只读字段（label/unit/font.size/font.color）也显示一行，只是没有 input —— 这是既有设计。
  ok(gau1.rows===23,'B1-6b **真实渲染 23 行**（19 可编辑 + 4 只读）');
  // 17 个标量 input/select + 2 个数组容器（bands/parts）= 19 个可编辑入口
  ok(gau1.editableInputs+gau1.arrayWraps===19,'B1-6d **可编辑入口共 19**（标量 '+gau1.editableInputs+' + 数组 '+gau1.arrayWraps+'）');
  ok(gau1.hasBands&&gau1.hasParts,'B1-6c 色带与子部件编辑器真实存在');

  // ================= 七、画布真实更新 =================
  console.log('\n=== B1-7. 画布真实更新 ===');
  const canvas1=JJ(await cdp.eval(`(function(){
    // 取画布像素签名（前 2000 字节）
    var cv=document.querySelector('canvas');
    if(!cv) return JSON.stringify({noCanvas:true});
    var before=cv.toDataURL().slice(0,4000);
    // 改一个肉眼可见的属性
    var S=CanvasState;
    window.commit(function(){S.design.nodes[0].cardStyle=3;},'改卡片');
    if(window.draw)window.draw();
    var after=cv.toDataURL().slice(0,4000);
    return JSON.stringify({hasCanvas:true,changed:before!==after});
  })()`));
  ok(canvas1.hasCanvas===true,'B1-7a 画布存在');
  ok(canvas1.changed===true,'B1-7b **属性变更后画布像素真实变化**');

  // ================= 八、保存并重新解析 =================
  console.log('\n=== B1-8. 保存 → 重新解析 ===');
  const save1=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var json=window.toV2Json(S.design);
    var parsed=window.parseDesign(json);
    var okp=parsed&&parsed.design&&parsed.design.nodes;
    return JSON.stringify({errors:parsed&&parsed.errors?parsed.errors.length:-1,
      nodeCount:okp?parsed.design.nodes.length:0});
  })()`));
  ok(save1.errors===0,'B1-8a 导出无错误');
  ok(save1.nodeCount===1,'B1-8b 重新解析得到 1 个节点');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
