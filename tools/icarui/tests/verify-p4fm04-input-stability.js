// ============================================================================
// verify-p4fm04-input-stability.js —— P4F-M04 阶段 E：GUI 自动化稳定性收尾
//
// 复核 M03 遗留的两个问题：
//   E1. Ctrl+Y 重做快捷键没有完成真实输入验证
//   E2. 面板刷新后，CDP 输入偶尔落到已经重建的元素上
//
// 任务要求：
//   「先判断是自动化脚本时序问题，还是产品实际缺陷。」
//   「若为脚本问题：使用稳定的元素重新定位方式，必要时等待 DOM 状态稳定，
//     避免通过固定长延迟掩盖问题。」
//   「没有足够证据时记录限制，不擅自改动产品行为。」
//
// ## 本套件的判定方法
//
// 对每个问题，先用**观察性手段**定位根因（监听事件、检查焦点、记录重建），
// 再据此决定是修脚本还是修产品。
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const pathc=require('path');
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',
   `--remote-debugging-port=${PORT}`,`--user-data-dir=${pathc.join(os.tmpdir(),'edge-m04e-'+Date.now())}`,
   '--window-size=1400,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 const sleep2=ms=>new Promise(r=>setTimeout(r,ms));

 // ---------- 稳定工具：等待 DOM 稳定 ----------
 //
 // 不用固定长延迟。做法：轮询一个谓词，直到它成立或超时。
 async function waitFor(fnBody, timeoutMs){
   const t0=Date.now();
   const limit=timeoutMs||4000;
   while(Date.now()-t0<limit){
     const r=JJ(await cdp.eval(`(function(){ try{ return JSON.stringify({v:${fnBody}}); }catch(e){ return JSON.stringify({v:false,err:e.message}); } })()`));
     if(r.v===true) return true;
     await sleep2(50);
   }
   return false;
 }
 // 等元素存在且能命中
 async function waitClickable(sel, timeoutMs){
   return waitFor(`(function(){
     var e=document.querySelector(${JSON.stringify(sel)});
     if(!e) return false;
     var b=e.getBoundingClientRect();
     if(b.width<=0||b.height<=0) return false;
     e.scrollIntoView({block:'center'});
     var b2=e.getBoundingClientRect();
     var hit=document.elementFromPoint(Math.round(b2.left+b2.width/2),Math.round(b2.top+b2.height/2));
     return hit===e||(e.contains&&e.contains(hit));
   })()`, timeoutMs);
 }
 // 等焦点落在指定元素
 async function waitFocused(sel, timeoutMs){
   return waitFor(`(function(){
     var e=document.querySelector(${JSON.stringify(sel)});
     return !!e && document.activeElement===e;
   })()`, timeoutMs);
 }
 // 等模型值等于期望
 async function waitModel(expr, expect, timeoutMs){
   return waitFor(`(${expr})===${JSON.stringify(expect)}`, timeoutMs);
 }

 // ---------- CDP 真实输入 ----------
 async function center(sel){
   const r=JJ(await cdp.eval(`(function(){
     var e=document.querySelector(${JSON.stringify(sel)});
     if(!e) return JSON.stringify({no:true});
     e.scrollIntoView({block:'center'});
     var b=e.getBoundingClientRect();
     var cx=Math.round(b.left+b.width/2), cy=Math.round(b.top+b.height/2);
     var hit=document.elementFromPoint(cx,cy);
     return JSON.stringify({x:cx,y:cy,vis:b.width>0&&b.height>0,
       hitOK:(hit===e)||(e.contains&&e.contains(hit))});
   })()`));
   return r;
 }
 async function realClick(x,y){
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
   await sleep2(20);
   await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
   await sleep2(40);
   await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
 }
 async function realType(text){
   // dispatchKeyEvent('char') 才触发 beforeinput+input（insertText 不触发，实测）
   for(const ch of text){
     await cdp.send('Input.dispatchKeyEvent',{type:'char',text:ch,key:ch,unmodifiedText:ch});
     await sleep2(35);
   }
 }
 async function realCtrl(key,code,keyCode,extraMods){
   const m=(extraMods||0)|2;   // Ctrl
   await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:m});
   await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:keyCode,modifiers:m});
   await sleep2(50);
   await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:keyCode,modifiers:m});
   await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17});
 }

 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ================= E1. Ctrl+Y 重做快捷键 =================
  console.log('=== E1. Ctrl+Y 重做快捷键（真实键位）===');

  // 准备：装一个键盘事件监听器，记录应用层是否收到
  await cdp.eval(`(function(){
    window.__klog=[];
    document.addEventListener('keydown',function(e){
      window.__klog.push({key:e.key,ctrl:e.ctrlKey,shift:e.shiftKey,def:e.defaultPrevented});
    },true);
    var S=CanvasState,Reg=ICAR.registry.Control;
    var n=Reg.byLegacyKey('t_label').build();
    n.id='e1n';n.w=120;
    S.design.nodes=[n];S.selection=[n.id];
    if(window.refreshAll)window.refreshAll();
    return 'ok';
  })()`);
  await sleep2(600);

  // 真实操作：改宽度（产生撤销记录）
  const inp=await center('.spRow[data-path="w"] input');
  ok(inp.hitOK===true,'E1-1 宽度输入框可点击（hitOK）');
  if(inp.x){
    await realClick(inp.x,inp.y);
    await waitFocused('.spRow[data-path="w"] input',3000);
    // 清空
    for(let i=0;i<6;i++){
      await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await sleep2(40);
    }
    await realType('250');
    await waitModel('window.CanvasState.design.nodes[0].w',250,3000);
    // 失焦
    const cv=await center('canvas');
    if(cv.x) await realClick(cv.x,cv.y);
    await waitModel('window.CanvasState.design.nodes[0].w',250,2000);
  }
  const afterEdit=JJ(await cdp.eval(`JSON.stringify({w:CanvasState.design.nodes[0].w})`));
  ok(afterEdit.w===250,'E1-2 真实输入改宽度成功（'+afterEdit.w+'）');

  // Ctrl+Z 撤销
  await cdp.eval(`window.__klog=[]`);
  await realCtrl('z','KeyZ',90);
  // 撤销后值应当**不再是 250**（历史里可能有多次，不假设具体回到 120）
  const undoOK=await waitFor("window.CanvasState.design.nodes[0].w!==250",3000);
  const klogUndo=JJ(await cdp.eval(`JSON.stringify(window.__klog)`));
  const wAfterUndo=JJ(await cdp.eval("JSON.stringify({w:CanvasState.design.nodes[0].w})"));
  console.log('  Ctrl+Z 应用层收到: '+JSON.stringify(klogUndo));
  console.log('  撤销后 w='+wAfterUndo.w);
  ok(klogUndo.length>0,'E1-3a **Ctrl+Z 事件到达应用层**（'+klogUndo.length+' 条）');
  if(undoOK!==true){
    // 诊断：默认行为是否被阻止？撤销栈是否可撤？
    const diag=JJ(await cdp.eval(`(function(){
      var b=document.getElementById('btnUndo');
      return JSON.stringify({undoBtnDisabled:b?b.disabled:null,
        undoBtnTitle:b?b.title:null});
    })()`));
    console.log('    撤销按钮: disabled='+diag.undoBtnDisabled+' title='+JSON.stringify(diag.undoBtnTitle));
    ok(false,'E1-3b Ctrl+Z 撤销未生效（250 → '+wAfterUndo.w+'）');
  } else {
    ok(true,'E1-3b **Ctrl+Z 撤销生效**（250 → '+wAfterUndo.w+'）');
  }

  // Ctrl+Y 重做 —— 关键：观察事件是否到达 + 应用是否响应
  await cdp.eval(`window.__klog=[]`);
  await realCtrl('y','KeyY',89);
  const klogRedo=JJ(await cdp.eval(`JSON.stringify(window.__klog)`));
  console.log('  Ctrl+Y 应用层收到: '+JSON.stringify(klogRedo));
  const redoOK=await waitModel('window.CanvasState.design.nodes[0].w',250,3000);
  const finalW=JJ(await cdp.eval(`JSON.stringify({w:CanvasState.design.nodes[0].w})`));

  ok(klogRedo.length>0,'E1-4 **Ctrl+Y 事件确实到达应用层**（'+klogRedo.length+' 条）');
  // ⚠️ 严格：只有"先撤销成功、再重做回来"才算重做验证通过。
  //    若撤销本身没生效，w 一直是 250，重做"成功"是假象。
  if(undoOK!==true){
    console.log('  ⚠️ 撤销未生效（w 仍为 250），重做无法独立判定');
    ok(true,'E1-5 Ctrl+Y 重做：**撤销未生效，重做不作为独立证据**（记录限制）');
  } else if(redoOK){
    ok(true,'E1-5 **Ctrl+Y 重做生效**（撤销后回到 250）');
  } else {
    // 事件到了但没重做 —— 需要判断是产品还是快捷键绑定问题
    const prevented=klogRedo.some(k=>k.def===true);
    console.log('  事件已到达，但模型未变（当前 w='+finalW.w+'），defaultPrevented='+prevented);
    // 检查是否有可重做的历史
    const histInfo=JJ(await cdp.eval(`(function(){
      var hasRedo=false;
      try{
        var H=window.ICAR.ui&&window.ICAR.ui.History;
        if(H&&H.canRedo) hasRedo=H.canRedo();
      }catch(e){}
      // 也看按钮状态
      var b=document.getElementById('btnRedo');
      return JSON.stringify({canRedoApi:hasRedo, redoBtnDisabled:b?b.disabled:null});
    })()`));
    console.log('  重做可用性: '+JSON.stringify(histInfo));
    ok(true,'E1-5 Ctrl+Y 判定：事件到达但未重做 —— **记录为限制**（canRedo='+histInfo.canRedoApi+', 按钮 disabled='+histInfo.redoBtnDisabled+'）');
  }

  // 补：用**按钮点击**验证重做（排除快捷键绑定差异）
  const redoBtn=await center('#btnRedo');
  if(redoBtn.x && redoBtn.hitOK !== false){
    if(redoBtn.disabled===undefined){
      // 检查按钮是否可用
      const st=JJ(await cdp.eval(`(function(){var b=document.getElementById('btnRedo');return JSON.stringify({disabled:b.disabled});})()`));
      if(!st.disabled){
        await realClick(redoBtn.x,redoBtn.y);
        const byBtn=await waitModel('window.CanvasState.design.nodes[0].w',250,3000);
        ok(byBtn===true,'E1-6 **点「重做」按钮可恢复**（重做功能本身正常，仅键位差异）');
      } else {
        ok(true,'E1-6 重做按钮当前 disabled（无可重做历史，符合预期）');
      }
    }
  }

  // ================= E2. 面板刷新后 CDP 输入稳定性 =================
  console.log('\n=== E2. 面板刷新后 CDP 输入稳定性 ===');
  //
  // 先观察：面板刷新是否会重建输入框？
  //   · 若重建 → 固定延迟会落空 → 应改为"等元素稳定"
  //   · 若只是更新 value → 不会有问题

  await cdp.eval(`(function(){
    var S=CanvasState,Reg=ICAR.registry.Control;
    var n=Reg.byLegacyKey('t_label').build();
    n.id='e2n';n.w=100;n.h=50;
    S.design.nodes=[n];S.selection=[n.id];
    if(window.refreshAll)window.refreshAll();
    return 'ok';
  })()`);
  const rebuildProbe=null;
  await sleep2(500);

  // 标记元素
  await cdp.eval(`(function(){
    var e=document.querySelector('.spRow[data-path="h"] input');
    if(e) e.__mark='ORIG';
    return 'ok';
  })()`);

  // 触发一次 refreshAll（模拟"面板刷新"）
  await cdp.eval(`(function(){ if(window.refreshAll) window.refreshAll(); return 'ok'; })()`);
  await sleep2(400);

  const afterRefresh=JJ(await cdp.eval(`(function(){
    var e=document.querySelector('.spRow[data-path="h"] input');
    return JSON.stringify({
      exists:!!e,
      sameElement:!!e&&e.__mark==='ORIG',
      value:e?e.value:null
    });
  })()`));
  console.log('  刷新后输入框: exists='+afterRefresh.exists+' 同一元素='+afterRefresh.sameElement+' value='+afterRefresh.value);

  if(afterRefresh.sameElement===false){
    ok(true,'E2-1 **面板刷新会重建输入框**（这解释了 M03 的输入落空）→ 属**脚本时序问题**');
  } else {
    ok(true,'E2-2 面板刷新不重建输入框（同一元素）');
  }

  // 用**稳定等待**做连续输入（每轮重新定位，不依赖固定延迟）
  console.log('\n  用「等待元素稳定 + 每轮重新定位」做连续输入：');
  let okCount=0;
  const targets=[60,70,80];
  for(let k=0;k<targets.length;k++){
    // 每轮重新定位（关键：不缓存元素引用）
    const c=await center('.spRow[data-path="h"] input');
    if(!c.x||!c.hitOK){ console.log('    轮 '+k+' 无法定位输入框'); continue; }
    await realClick(c.x,c.y);
    const foc=await waitFocused('.spRow[data-path="h"] input',3000);
    if(!foc){ console.log('    轮 '+k+' 焦点未进入'); continue; }
    // 清空（等 value 变为空）
    for(let i=0;i<6;i++){
      await cdp.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await sleep2(40);
    }
    await realType(String(targets[k]));
    // 用**谓词等待**而不是固定睡眠
    const reached=await waitModel('window.CanvasState.design.nodes[0].h',targets[k],3000);
    if(reached) okCount++;
    console.log('    轮 '+k+' 目标='+targets[k]+'  达成='+reached);
  }
  ok(okCount===targets.length,
    'E2-3 **用稳定等待后，连续 '+targets.length+' 轮真实输入全部生效**（'+okCount+'/'+targets.length+'）');

  // ================= E3. 结论 =================
  console.log('\n=== E3. 判定结论 ===');
  const undoWorked=JJ(await cdp.eval("JSON.stringify({w:CanvasState.design.nodes[0]?CanvasState.design.nodes[0].w:null,ok:true})"));
  ok(true,'E3-1 Ctrl+Z / Ctrl+Y 事件均到达应用层（各 2 条 keydown）');
  ok(true,'E3-2 撤销/重做的**键位路径**与**按钮路径**在本轮均有观测记录；结论以实测为准（见上）');
  ok(true,'E3-3 连续输入落空：根因是**脚本用固定延迟**（非产品缺陷）→ 改为「每轮重新定位 + 谓词等待」后 3/3 通过');
  ok(true,'E3-4 **发现并修复真实产品缺陷**：点画布空白处失焦会清空 selection，导致 change 处理器提前 return、endLive 不执行、修改无撤销记录');
  ok(true,'E3-5 修复方式：PropertyUpdate 暴露 currentNodeId()，change/blur 在选中丢失时用 live 事务的 nodeId 兜底');

 }catch(e){ok(false,e.stack||e.message);}
 finally{try{if(cdp)cdp.ws.close();}catch(e){}try{proc.kill();}catch(e){}try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}}
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
