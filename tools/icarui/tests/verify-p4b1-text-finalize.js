// ============================================================================
// verify-p4b1-text-finalize.js —— P4B.1 文字属性面板质量收尾验收
//
// 一、12 条文字 Schema 一致性（统一 font.size.max）
// 二、保存前后校验规则一致
// 三、Schema 异常诊断（__ICAR_SCHEMA_ERROR + 控制台 + 恢复清理 + 旧面板可用）
// 四、Tab / Shift+Tab / 失焦提交（真实 CDP 键盘）
// 五、composition 边界（组合中失焦 / 切节点 / compositionend+input 连发 / 混合输入）
// 六、提交事务（20 字符 / 撤销重做 / 保存重载）
//
// 测试强度分级：
//   [真实] = CDP Input.dispatchKeyEvent / Input.insertText
//   [派发] = DOM dispatchEvent
//   [API]  = 直接调用内部 API
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const TEXT_KEYS = ['text', 't_title', 't_label', 't_unit', 't_big', 't_small',
    't_warn', 't_ok', 't_bigunit', 'box_h1', 'box_h2', 'box_note'];

  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4b1`,
    '--window-size=1700,1050', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    cdp = await CDP.connect((await getJson('/json/list')).find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);
    await sleep(1800);

    // 控制台消息收集（Runtime.consoleAPICalled 通道）
    const consoleMsgs = [];
    cdp.ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Runtime.consoleAPICalled') {
          const text = (m.params.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || '')).join(' ');
          consoleMsgs.push({ type: m.params.type, text: text });
        }
      } catch (e) { /* ignore */ }
    });

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const JJ = (v) => JSON.parse(v);

    await cdp.eval("window.__spInp=function(p,role){var b=document.getElementById('schemaProps');" +
      "var all=b.querySelectorAll('input,select');for(var i=0;i<all.length;i++){" +
      "var dp=all[i].getAttribute('data-path'),dr=all[i].getAttribute('data-role');" +
      "if(dp===p&&(role?dr===role:dr!=='picker'))return all[i];}return null;};");
    await cdp.eval("window.__prepText=function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "var n=R.byLegacyKey('t_title').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();return n.id;};");

    // ================= 一、12 条 Schema 一致性 =================
    const sig = JJ(await step('schema consistency',
      "(function(){var R=ICAR.registry.Control;" +
      "var K=" + JSON.stringify(TEXT_KEYS) + ";" +
      "var sigs={},maxes={};" +
      "K.forEach(function(k){var d=R.byLegacyKey(k);sigs[k]=JSON.stringify(d.schema);" +
      "var f=d.schema.filter(function(x){return x.key==='font.size';})[0];maxes[k]=f?f.max:null;});" +
      "var uniq={};Object.keys(sigs).forEach(function(k){uniq[sigs[k]]=(uniq[sigs[k]]||0)+1;});" +
      "var maxVals={};Object.keys(maxes).forEach(function(k){maxVals[maxes[k]]=(maxVals[maxes[k]]||0)+1;});" +
      "return JSON.stringify({distinctSignatures:Object.keys(uniq).length,counts:Object.keys(uniq).map(function(s){return uniq[s];}),maxVals:maxVals});})()"));
    ok(sig.distinctSignatures === 1, 'all 12 text schemas are now IDENTICAL (got ' +
      sig.distinctSignatures + ' distinct signatures)');
    ok(JSON.stringify(sig.maxVals) === '{"400":12}', 'all 12 use font.size.max = 400 (got ' + JSON.stringify(sig.maxVals) + ')');

    // 默认值未被改动
    const defaults = JJ(await step('defaults unchanged',
      "(function(){var R=ICAR.registry.Control;var out={};" +
      "['t_label','text','box_h1','t_bigunit','t_big'].forEach(function(k){" +
      "var n=R.byLegacyKey(k).build();" +
      "out[k]={size:n.font.size,weight:n.font.weight,color:n.font.color,align:n.font.align,txt:n.text,w:n.w,h:n.h};});" +
      "return JSON.stringify(out);})()"));
    ok(defaults.t_label.size === 7 && defaults.t_label.weight === 400 &&
      defaults.t_label.color === '#8FA0B8' && defaults.t_label.align === 'center',
      't_label defaults unchanged (size7/weight400/#8FA0B8/center)');
    // ⚠️ P5B-M01 阶段 D **有意改变**：box_h1 / text 的预设 fontSize 曾被静默丢弃
    // （回落成 6）。已在 model.js createNode 的 NODE_TEXT 分支加扁平字段兼容 →
    // 现在按预设声明值 30 / 18。断言方向反转，不是放宽门槛。
    // 详见 verify-p4b-text-props 第七节的完整说明。
    ok(defaults.text.size === 18, 'text default size = 18 (preset literal; was 6 before P5B-M01)');
    ok(defaults.box_h1.size === 30, 'box_h1 default size = 30 (preset literal; was 6 before P5B-M01)');
    ok(defaults.t_bigunit.weight === 400, 't_bigunit default weight unchanged (400, D-02 kept)');
    ok(defaults.t_big.size === 24 && defaults.t_big.weight === 900, 't_big defaults unchanged');

    // ================= 二、保存前后校验规则一致 =================
    const roundtripSame = JJ(await step('validation same before/after save',
      "(function(){var R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "var n=R.byLegacyKey('t_label').build();" +
      "var s1=SP.SchemaResolver.resolve(n);" +
      "var d=createDesign({name:'x'});d.nodes=[n];var back=parseDesign(toV2Json(d));" +
      "var rel=back.design.nodes[0];" +
      "var s2=SP.SchemaResolver.resolve(rel);" +
      "var f1=s1.fields.filter(function(x){return x.key==='font.size';})[0];" +
      "var f2=s2.fields.filter(function(x){return x.key==='font.size';})[0];" +
      "var V=SP.PropertyValidator;" +
      "return JSON.stringify({beforeMax:f1.max,afterMax:f2.max," +
      "reject600Before:!V.coerce(f1,'600').ok,reject600After:!V.coerce(f2,'600').ok," +
      "accept300Before:V.coerce(f1,'300').ok,accept300After:V.coerce(f2,'300').ok," +
      "accept400Before:V.coerce(f1,'400').ok,accept400After:V.coerce(f2,'400').ok});})()"));
    ok(roundtripSame.beforeMax === roundtripSame.afterMax,
      'font.size.max identical before/after save (' + roundtripSame.beforeMax + ')');
    ok(roundtripSame.reject600Before === roundtripSame.reject600After,
      '600 rejected consistently before/after save');
    ok(roundtripSame.accept300Before === roundtripSame.accept300After,
      '300 accepted consistently before/after save');
    ok(roundtripSame.accept400Before === roundtripSame.accept400After,
      '400 accepted consistently before/after save');
    ok(roundtripSame.reject600Before === true, '600 still rejected (max=400 enforced)');

    // ================= 三、Schema 异常诊断 =================
    await cdp.eval("window.__prepText();");
    await sleep(300);
    const diagBefore = await step('diag clean', "String(window.__ICAR_SCHEMA_ERROR)");
    ok(diagBefore === 'null', 'no error state before injection');

    consoleMsgs.length = 0;
    const diag = JJ(await step('diag injected',
      "(function(){var SP=ICAR.ui.schemaProps;var orig=SP.SchemaRenderer.update;" +
      "SP.SchemaRenderer.update=function(){throw new Error('SIMULATED_SCHEMA_FAILURE');};" +
      "var props=document.getElementById('props');" +
      "var legacyLenBefore=props?props.innerHTML.length:0;" +
      "try{window.refreshAll();}catch(e){}" +
      "SP.SchemaRenderer.update=orig;" +
      "var err=window.__ICAR_SCHEMA_ERROR;" +
      "var legacyLenAfter=props?props.innerHTML.length:0;" +
      "return JSON.stringify({msg:err?err.message:null,where:err?err.where:null," +
      "hasStack:err?!!err.stack:false,count:window.__ICAR_SCHEMA_ERROR_COUNT," +
      "legacyUsable:legacyLenAfter>50,legacyUnchanged:legacyLenBefore===legacyLenAfter});})()"));
    await sleep(300);
    ok(diag.msg === 'SIMULATED_SCHEMA_FAILURE', '__ICAR_SCHEMA_ERROR records the message');
    ok(diag.where === 'refreshAll', '__ICAR_SCHEMA_ERROR records where (got ' + diag.where + ')');
    ok(diag.hasStack === true, '__ICAR_SCHEMA_ERROR includes stack');
    ok(diag.count >= 1, 'error count recorded (got ' + diag.count + ')');
    ok(diag.legacyUsable === true, 'legacy #props panel still usable after schema failure');
    const consErr = consoleMsgs.filter(c => c.type === 'error' &&
      (c.text.indexOf('Schema 面板') >= 0 || c.text.indexOf('SIMULATED_SCHEMA_FAILURE') >= 0));
    ok(consErr.length >= 1, 'error printed to console (' + consErr.length + ' entries)');

    // 恢复后清理
    const recovered = JJ(await step('diag recovered',
      "(function(){window.refreshAll();" +
      "return JSON.stringify({err:String(window.__ICAR_SCHEMA_ERROR)," +
      "count:String(window.__ICAR_SCHEMA_ERROR_COUNT)});})()"));
    ok(recovered.err === 'null', 'error state cleared after successful recovery');
    ok(recovered.count === '0', 'error count reset after recovery');

    // ================= 四、Tab / Shift+Tab / 失焦提交 =================
    await cdp.eval("window.__prepText();");
    await sleep(250);
    const focusHelper = "(function(){var a=document.activeElement;" +
      "return JSON.stringify({path:a?a.getAttribute('data-path'):null," +
      "role:a?a.getAttribute('data-role'):null,tag:a?a.tagName:null});})()";

    // 控件顺序：text → font.size → font.weight → font.color(picker) → font.color(text) → font.align
    const orderList = JJ(await step('focus order',
      "(function(){var b=document.getElementById('schemaProps');var all=b.querySelectorAll('input,select');" +
      "var out=[];for(var i=0;i<all.length;i++){out.push(all[i].getAttribute('data-path')+'/'+(all[i].getAttribute('data-role')||'-'));}" +
      "return JSON.stringify({order:out});})()"));
    // P4F-04: text family gained w/h -> 2 more focusable controls (6 -> 8).
  ok(orderList.order.length === 8, 'text panel has 8 focusable controls after P4F-04 (got ' + orderList.order.length + ')');

    await cdp.eval("(function(){var e=window.__spInp('text');if(e)e.focus();})()");
    await sleep(100);
    const f0 = JJ(await cdp.eval(focusHelper));
    ok(f0.path === 'text', '[真实] focus starts on text field');

    // Tab 前进
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(150);
    const f1 = JJ(await cdp.eval(focusHelper));
    ok(f1.path === 'font.size', '[真实] Tab moves focus text → font.size (got ' + f1.path + ')');

    // Tab 再前进
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(150);
    const f2 = JJ(await cdp.eval(focusHelper));
    ok(f2.path === 'font.weight', '[真实] Tab again → font.weight (got ' + f2.path + ')');

    // Shift+Tab 返回
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(150);
    const f3 = JJ(await cdp.eval(focusHelper));
    ok(f3.path === 'font.size', '[真实] Shift+Tab returns to font.size (got ' + f3.path + ')');

    // ArrowLeft/Right 保留光标行为
    await cdp.eval("(function(){var e=window.__spInp('text');if(e){e.focus();e.value='ABCDE';e.setSelectionRange(5,5);}})()");
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await sleep(100);
    const caret = JJ(await cdp.eval("(function(){var e=window.__spInp('text');" +
      "return JSON.stringify({s:e?e.selectionStart:null,e2:e?e.selectionEnd:null});})()"));
    ok(caret.s === 4, '[真实] ArrowLeft moves caret (got ' + caret.s + ')');

    // Shift+ArrowRight 选区
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(100);
    const selection = JJ(await cdp.eval("(function(){var e=window.__spInp('text');" +
      "return JSON.stringify({s:e?e.selectionStart:null,e2:e?e.selectionEnd:null});})()"));
    ok(selection.e2 > selection.s, '[真实] Shift+ArrowRight creates selection');

    // Tab 触发失焦提交
    const tabCommit = JJ(await step('tab blur commit',
      "(function(){var S=CanvasState;var e=window.__spInp('text');" +
      "e.value='TAB_COMMITTED';e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "return JSON.stringify({modelBefore:S.design.nodes[0].text});})()"));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(250);
    const afterTabBlur = JJ(await cdp.eval("(function(){var S=CanvasState;" +
      "return JSON.stringify({model:S.design.nodes[0].text,focus:document.activeElement?" +
      "document.activeElement.getAttribute('data-path'):null});})()"));
    ok(afterTabBlur.model === 'TAB_COMMITTED', '[真实] Tab causes blur-commit (got ' + afterTabBlur.model + ')');
    ok(afterTabBlur.focus === 'font.size', '[真实] focus moved on after commit');

    // 点击其他控件触发 blur
    await cdp.eval("(function(){var e=window.__spInp('text');if(e){e.focus();e.select();}})()");
    await sleep(100);
    await cdp.send('Input.insertText', { text: 'CLICK_BLUR' });
    await sleep(150);
    await cdp.eval("(function(){var t=window.__spInp('font.size');if(t)t.focus();})()");
    await sleep(250);
    const afterClickBlur = JJ(await cdp.eval("(function(){var S=CanvasState;" +
      "return JSON.stringify({model:S.design.nodes[0].text});})()"));
    ok(afterClickBlur.model === 'CLICK_BLUR', '[真实] focusing another control commits the text (got ' + afterClickBlur.model + ')');

    // 非法输入失焦不污染模型
    const beforeBad = JJ(await cdp.eval("(function(){var S=CanvasState;" +
      "return JSON.stringify({size:S.design.nodes[0].font.size});})()"));
    await cdp.eval("(function(){var e=window.__spInp('font.size');if(e){e.focus();e.select();}})()");
    await sleep(80);
    await cdp.send('Input.insertText', { text: 'abc' });
    await sleep(150);
    await cdp.eval("(function(){var e=window.__spInp('text');if(e)e.focus();})()");
    await sleep(250);
    const afterBad = JJ(await cdp.eval("(function(){var S=CanvasState;" +
      "return JSON.stringify({size:S.design.nodes[0].font.size});})()"));
    ok(afterBad.size === beforeBad.size,
      '[真实] invalid input on blur does NOT pollute model (still ' + beforeBad.size + ')');

    // Escape 取消
    await cdp.eval("(function(){var S=CanvasState;S.design.nodes[0].text='ESC_BASE';window.refreshAll();" +
      "var e=window.__spInp('text');if(e){e.blur();}})()");
    await sleep(150);
    await cdp.eval("(function(){var e=window.__spInp('text');if(e){e.focus();e.select();}})()");
    await sleep(100);
    await cdp.send('Input.insertText', { text: 'SHOULD_BE_CANCELLED' });
    await sleep(150);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
    const afterEscape = JJ(await cdp.eval("(function(){var S=CanvasState;" +
      "return JSON.stringify({model:S.design.nodes[0].text});})()"));
    ok(afterEscape.model === 'ESC_BASE', '[真实] Escape cancels uncommitted edit (got ' + afterEscape.model + ')');

    // ================= 五、composition 边界 =================
    // 5.1 composition 中失焦
    const compBlur = JJ(await step('composition + blur',
      "(function(){var S=CanvasState;S.design.nodes[0].text='COMPBASE';window.refreshAll();" +
      "var n=S.design.nodes[0];var e=window.__spInp('text');if(!e)return JSON.stringify({err:'no input'});" +
      "e.focus();e.select();" +
      "e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));" +
      "e.value='zhong';" +
      "e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "var during=n.text;" +
      "e.blur();" +
      "var afterBlur=n.text;" +
      "return JSON.stringify({during:during,afterBlur:afterBlur});})()"));
    ok(compBlur.during === 'COMPBASE', '[派发] composition期间失焦前模型未变');
    ok(compBlur.afterBlur === 'COMPBASE', '[派发] composition中失焦不提交半成品（got ' + compBlur.afterBlur + '）');

    // 5.2 composition 中切换节点
    const compSwitch = JJ(await step('composition + switch node',
      "(function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design.nodes[0].text='SWBASE';window.refreshAll();" +
      "var n1=S.design.nodes[0];" +
      "var n2=R.byLegacyKey('t_title').build();S.design.nodes.push(n2);" +
      "S.selection=[n1.id];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var e=window.__spInp('text');if(!e)return JSON.stringify({err:'no input'});" +
      "e.focus();e.select();" +
      "e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));" +
      "e.value='qiye';" +
      "e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "S.selection=[n2.id];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "return JSON.stringify({n1Text:n1.text,n2Text:n2.text});})()"));
    ok(compSwitch.n1Text === 'SWBASE', '[派发] composition中切节点：原节点不被写入半成品');
    ok(compSwitch.n2Text !== 'qiye', '[派发] composition中切节点：新节点不串值（got ' + compSwitch.n2Text + '）');

    // 5.3 compositionend 与 input 连发（不重复提交）
    const compSeq = JJ(await step('compositionend + input',
      "(function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'cs'});" +
      "var n=R.byLegacyKey('t_title').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "n.text='SEQ_BASE';window.refreshAll();" +
      "var e=window.__spInp('text');if(!e)return JSON.stringify({err:'no input'});" +
      "e.focus();e.select();" +
      "e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));" +
      "e.value='zhongwen';" +
      "e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'zhongwen'}));" +
      "var afterEnd=n.text;" +
      "e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "var afterInput=n.text;" +
      "return JSON.stringify({afterEnd:afterEnd,afterInput:afterInput,same:afterEnd===afterInput});})()"));
    ok(compSeq.afterEnd === 'zhongwen', '[派发] compositionend 提交最终文字');
    ok(compSeq.same === true, '[派发] compositionend 后紧接 input 不重复提交（值稳定）');

    // 5.4 中英混合输入 + 一次撤销
    const mixed = JJ(await step('mixed input single undo',
      "(function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'mx'});" +
      "var n=R.byLegacyKey('t_title').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "n.text='ORIGINAL';window.refreshAll();" +
      "var e=window.__spInp('text');if(!e)return JSON.stringify({err:'no input'});" +
      "e.focus();e.select();" +
      "var U=ICAR.ui.schemaProps.PropertyUpdate;" +
      "U.beginLive(n,'text');" +
      "U.setLive(n,'text','中文abc123');" +
      "U.setLive(n,'text','中文abc123XYZ');" +
      "var mid=n.text;" +
      "U.endLive(n,'text');" +
      "var end=ICAR.ui.schemaProps.__findNodeById(n.id).text;" +
      "window.doUndo();" +
      "var undone=ICAR.ui.schemaProps.__findNodeById(n.id).text;" +
      "return JSON.stringify({mid:mid,end:end,undone:undone,original:'ORIGINAL'});})()"));
    ok(mixed.end === '中文abc123XYZ', '[API] mixed CN/EN/digits applied');
    ok(mixed.undone === 'ORIGINAL', '[API] one undo restores the whole pre-edit string');

    // ================= 六、提交事务（20 字符）=================
    const tx = JJ(await step('20 char transaction',
      "(function(){var R=ICAR.registry.Control,S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "S.design=createDesign({name:'tx'});" +
      "var n=R.byLegacyKey('t_title').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      // ⚠️ 必须用 commit 把 BEFORE20 记进撤销栈，否则 undo 会跳到加节点之前的快照。
      "window.commit(function(){n.text='BEFORE20';},'set base');" +
      "var cnt={refreshAll:0,renderProps:0};" +
      "var oRA=window.refreshAll,oRP=window.renderProps;" +
      "window.refreshAll=function(){cnt.refreshAll++;return oRA.apply(this,arguments);};" +
      "window.renderProps=function(){cnt.renderProps++;return oRP.apply(this,arguments);};" +
      "var e=window.__spInp('text');if(!e)return JSON.stringify({err:'no input'});" +
      "e.focus();e.select();" +
      "var U=SP.PropertyUpdate;U.beginLive(n,'text');" +
      "var s='';" +
      "for(var i=0;i<20;i++){s+=String.fromCharCode(97+(i%26));U.setLive(n,'text',s);}" +
      "var during={refreshAll:cnt.refreshAll,renderProps:cnt.renderProps,text:n.text};" +
      "U.endLive(n,'text');" +
      "window.refreshAll=oRA;window.renderProps=oRP;" +
      "var end=SP.__findNodeById(n.id).text;" +
      "window.doUndo();var undone=SP.__findNodeById(n.id).text;" +
      "window.doRedo();var redone=SP.__findNodeById(n.id).text;" +
      "return JSON.stringify({during:during,end:end,undone:undone,redone:redone,len:end.length});})()"));
    ok(tx.during.refreshAll === 0, 'during 20-char input refreshAll NOT called (got ' + tx.during.refreshAll + ')');
    ok(tx.during.renderProps === 0, 'during 20-char input renderProps NOT called (got ' + tx.during.renderProps + ')');
    ok(tx.during.text.length === 20, 'canvas model updates live during typing (len ' + tx.during.text.length + ')');
    ok(tx.len === 20, 'Enter/blur commits full 20-char string');
    ok(tx.undone === 'BEFORE20', 'one undo restores the FULL pre-edit string (got ' + tx.undone + ')');
    ok(tx.redone === tx.end, 'one redo restores the full string');

    // 保存重载后内容完整
    const saveLoad = JJ(await step('save reload content',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var back=parseDesign(toV2Json(S.design));" +
      "return JSON.stringify({text:back.design.nodes[0].text,len:back.design.nodes[0].text.length});})()"));
    ok(saveLoad.len === 20, 'saved+reloaded text content is complete (len ' + saveLoad.len + ')');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "(function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "var SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "trackPanel:!!SP.SchemaResolver.resolve({type:'image',trackStyle:{orient:'h'}})," +
      "textPanel:!!SP.SchemaResolver.resolve({type:'text'})," +
      "legacyPanel:!!document.getElementById('props')," +
      "schemaPanel:!!document.getElementById('schemaProps')});})()"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69');
    ok(compat.trackPanel === true, 'track schema panel still works');
    ok(compat.textPanel === true, 'text schema panel works');
    ok(compat.legacyPanel === true, 'legacy #props panel exists');
    ok(compat.schemaPanel === true, 'schema #schemaProps panel exists');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
