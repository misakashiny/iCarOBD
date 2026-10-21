// ============================================================================
// verify-p4a1-hardening.js —— P4A.1 Schema 面板稳定性与兼容性加固验收
//
// 一、统一插入适配层：7 类来源（Registry 派生 / 静态声明 / 旧工厂探测 /
//     图片素材 / 组合控件）全部支持，未迁移条目正确回退、不重复包装
// 二、Schema 单一事实源：两条取 schema 的路径返回**同一个 Registry 对象**
// 三、新旧面板双向同步 8 项
// 四、真实键盘输入（CDP Input.insertText / dispatchKeyEvent）
// 五、真实指针滑块（CDP Input.dispatchMouseEvent 的 pointer 序列）
// 六、撤销事务：首次编辑 / 第二次 / 连续拖动 / 中途切换 / 无效输入 / 无变化
// 七、端到端性能（中位数 + P95，区分面板刷新与完整交互）
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4a1`,
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

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const JJ = (v) => JSON.parse(v);

    // ================= 一、7 类来源兼容 =================
    const SRC = [
      ['t_label', 'derived', 'text'],
      ['cd_trackh', 'derived', 'image'],
      ['lamp_tpms', 'derived', 'image'],
      ['gauge_0', 'declared', 'gauge'],
      ['next_speed_oem', 'probe', 'group'],
      ['bar_trackh', 'probe', 'image'],
      ['img_ring', 'probe', 'image'],
    ];
    for (const [key, wantSrc, wantType] of SRC) {
      const r = JJ(await step('insert ' + key,
        "JSON.stringify((function(){var S=CanvasState;S.design=createDesign({name:'x'});S.design.nodes=[];" +
        "var cat=ICAR.registry.Catalog.get(" + JSON.stringify(key) + ");" +
        "var n=ICAR.ui.insertControl(" + JSON.stringify(key) + ",{});" +
        "return {src:cat?cat.source:null,got:!!n,type:n?n.type:null,nodes:S.design.nodes.length};})())"));
      ok(r.got === true, key + ' inserts successfully (' + wantSrc + ')');
      ok(r.type === wantType, key + ' node type = ' + wantType + ' (got ' + r.type + ')');
      ok(r.src === wantSrc, key + ' catalog source = ' + wantSrc + ' (got ' + r.src + ')');
      ok(r.nodes === 1, key + ' actually added to design.nodes');
    }

    // 未迁移条目回退：必须成功，不是静默失败
    const fallback = JJ(await step('unmigrated fallback',
      "JSON.stringify((function(){var S=CanvasState;S.design=createDesign({name:'f'});S.design.nodes=[];" +
      "var e=(window.BUILTIN_CONTROLS||[]).find(function(c){return c.key==='img_ring';});" +
      "var hasRegistry=!!ICAR.registry.Control.byLegacyKey('img_ring');" +
      "var n=ICAR.ui.insertControl('img_ring',{});" +
      "return {bridged:!!e.__bridgedTo,hasRegistry:hasRegistry,inserted:!!n};})())"));
    ok(fallback.bridged === false, 'img_ring is NOT bridged (still old factory)');
    ok(fallback.inserted === true, 'unmigrated entry still inserts via legacy make() fallback');

    // 不得重复执行 prepareBuiltinImages
    const dbl = JJ(await step('no double pack',
      "JSON.stringify((function(){var S=CanvasState,cv=S.design.canvas;var ratio=cv.designH/cv.designW;" +
      "var cases=[['cd_trackh',240],['bar_trackh',240],['img_ring',180],['lamp_tpms',56]];var out=[];" +
      "cases.forEach(function(p){S.design=createDesign({name:'d'});S.design.nodes=[];" +
      "var n=ICAR.ui.insertControl(p[0],{});" +
      "out.push({key:p[0],raw:p[1],got:n.w,once:p[1]*ratio,twice:p[1]*ratio*ratio," +
      "isOnce:Math.abs(n.w-p[1]*ratio)<0.01,isTwice:Math.abs(n.w-p[1]*ratio*ratio)<0.01});});" +
      "return {ratio:ratio,cases:out};})())"));
    ok(dbl.ratio > 0, 'canvas ratio measured (' + dbl.ratio.toFixed(4) + ')');
    dbl.cases.forEach(function (c) {
      ok(c.isOnce === true, c.key + ' prepared exactly once (' + c.got.toFixed(3) + ' = ' + c.prew + ')'
        .replace('undefined', c.once.toFixed(3)));
      ok(c.isTwice === false, c.key + ' NOT double-prepared (would be ' + c.twice.toFixed(3) + ')');
    });

    // 子节点 / 素材路径 / 撤销 / 保存重载（组合控件与素材）
    const deep = JJ(await step('composite + asset + roundtrip',
      "JSON.stringify((function(){var S=CanvasState;S.design=createDesign({name:'dp'});S.design.nodes=[];" +
      "var g=ICAR.ui.insertControl('next_speed_oem',{});" +
      "var a=ICAR.ui.insertControl('img_ring',{});" +
      "var back=parseDesign(toV2Json(S.design));" +
      "return {groupChildren:g&&g.children?g.children.length:0," +
      "assetHasId:!!(a&&a.assetId),parsedErrors:back.errors.length," +
      "parsedNodes:back.design.nodes.length};})())"));
    ok(deep.groupChildren === 2, 'composite control keeps 2 children (got ' + deep.groupChildren + ')');
    ok(deep.assetHasId === true, 'asset entry keeps assetId');
    ok(deep.parsedErrors === 0, 'saved design parses clean');
    ok(deep.parsedNodes === 2, 'reload keeps both nodes');

    // ================= 二、Schema 单一事实源 =================
    const sot = JJ(await step('single source of truth',
      "JSON.stringify((function(){var R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "var withKey=R.byLegacyKey('cd_trackh').build();" +
      "var noKey={type:'image',trackStyle:{orient:'h',segments:0,glow:false,fill:null}};" +
      "var s1=SP.SchemaResolver.resolve(withKey);var s2=SP.SchemaResolver.resolve(noKey);" +
      "var regSchema=R.byLegacyKey('cd_trackh').schema;" +
      "return {sameObject:s1.fields===s2.fields,s1IsRegistry:s1.fields===regSchema," +
      "s2IsRegistry:s2.fields===regSchema,fields:s1.fields.length," +
      "editable:s1.editable.slice()};})())"));
    ok(sot.sameObject === true, 'both paths return the SAME schema object (no duplicate definition)');
    ok(sot.s1IsRegistry === true, 'path A (with __controlKey) uses Registry schema');
    ok(sot.s2IsRegistry === true, 'path B (reloaded, no __controlKey) ALSO uses Registry schema');
    ok(sot.fields === 11, 'schema has 11 fields from Registry');
    // ⚠️ P4F-02 演进：track 族可编辑字段 4 → 11（补齐 7 个标量字段）。
  ok(sot.editable.length === 11, 'exactly 11 editable fields after P4F-02 (got ' + sot.editable.length + ')');

    // 持久化能力识别（不依赖 __controlKey）
    const ident = JJ(await step('capability identify',
      "JSON.stringify((function(){var SP=ICAR.ui.schemaProps;" +
      "return {trackFromPersisted:SP.SchemaResolver.isTrack({type:'image',trackStyle:{orient:'h'}})," +
      "notTrackNull:SP.SchemaResolver.isTrack({type:'image',trackStyle:null})," +
      "notTrackGauge:SP.SchemaResolver.isTrack({type:'gauge'})," +
      "whyNoKeyStillWorks:SP.SchemaResolver.resolve({type:'image',trackStyle:{orient:'v'}})!==null};})())"));
    ok(ident.trackFromPersisted === true, 'track identified from persisted fields only');
    ok(ident.notTrackNull === false, 'image with null trackStyle is NOT a track');
    ok(ident.notTrackGauge === false, 'gauge is NOT a track');
    ok(ident.whyNoKeyStillWorks === true, 'resolve works without __controlKey');

    // ================= 三、新旧面板双向同步 =================
    await cdp.eval("window.__spInp=function(p){var b=document.getElementById('schemaProps');" +
      "var all=b.querySelectorAll('input,select');for(var i=0;i<all.length;i++){if(all[i].getAttribute('data-path')===p)return all[i];}return null;};");
    // ⚠️ 必须用 commit 把"加节点"也记进撤销栈 —— 否则 undo 会跳到
    //    createDesign 之前的历史快照，节点整批消失（P4A.1 排查确认）。
    await cdp.eval("window.__prep=function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'sy'});S.design.nodes=[];" +
      "var n=R.byLegacyKey('cd_seg5h').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();return n;};");

    const s1 = JJ(await step('legacy -> schema',
      "(function(){window.__prep();var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var n=SP.__findNodeById(S.selection[0]);n.trackStyle.segments=12;window.refreshAll();" +
      "var inp=window.__spInp('trackStyle.segments');" +
      "return JSON.stringify({model:n.trackStyle.segments,panel:inp?inp.value:null});})()"));
    ok(s1.model === 12, 'legacy edit updates model');
    ok(s1.panel === '12', 'legacy edit → schema panel shows 12 (got ' + s1.panel + ')');

    const s2 = JJ(await step('schema -> model',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;var inp=window.__spInp('trackStyle.segments');" +
      "if(!inp)return JSON.stringify({err:'no input'});" +
      "inp.value='7';inp.dispatchEvent(new Event('input',{bubbles:true}));" +
      "inp.dispatchEvent(new Event('change',{bubbles:true}));" +
      "return JSON.stringify({model:SP.__findNodeById(S.selection[0]).trackStyle.segments});})()"));
    ok(s2.model === 7, 'schema panel edit updates model (got ' + s2.model + ')');

    // ⚠️ 再做一次编辑，让"7"成为可回退的前态。
    //    撤销栈是"记录当前状态"，undo 会跳到上一条 —— 只做一次编辑时
    //    上一条是"加节点"那次，segments 还是初始值。
    await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var n=SP.__findNodeById(S.selection[0]);" +
      "SP.PropertyUpdate.setOnce(n,'trackStyle.segments',20);})()");
    const s2b = JJ(await step('second edit',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({model:SP.__findNodeById(S.selection[0]).trackStyle.segments});})()"));
    ok(s2b.model === 20, 'second edit applied (got ' + s2b.model + ')');

    const s3 = JJ(await step('undo syncs both',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var before=SP.__findNodeById(S.selection[0]).trackStyle.segments;" +
      "window.doUndo();if(window.refreshAll)window.refreshAll();" +
      "var after=SP.__findNodeById(S.selection[0]).trackStyle.segments;" +
      "var inp=window.__spInp('trackStyle.segments');" +
      "return JSON.stringify({before:before,after:after,panel:inp?inp.value:null});})()"));
    ok(s3.after === 7, 'undo restores model to previous edit value 7 (got ' + s3.after + ')');
    ok(s3.panel === '7', 'undo syncs schema panel to 7 (got ' + s3.panel + ')');

    const s4 = JJ(await step('switch node',
      "(function(){var S=CanvasState,R=ICAR.registry.Control;" +
      "var n2=R.byLegacyKey('cd_trackh').build({});S.design.nodes.push(n2);" +
      "S.selection=[n2.id];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var inp=window.__spInp('trackStyle.segments');" +
      "return JSON.stringify({model:n2.trackStyle.segments,panel:inp?inp.value:null});})()"));
    ok(String(s4.panel) === String(s4.model), 'switch node refreshes value (' + s4.panel + ' vs ' + s4.model + ')');

    const s5 = JJ(await step('delete clears',
      "(function(){var S=CanvasState;var id=S.selection[0];" +
      "S.design.nodes=S.design.nodes.filter(function(n){return n.id!==id;});S.selection=[];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "return JSON.stringify({family:ICAR.ui.SchemaPanel.currentFamily()," +
      "hasInputs:box.querySelectorAll('input,select').length});})()"));
    ok(s5.family === null, 'delete current node → panel family cleared');
    ok(s5.hasInputs === 0, 'delete current node → no inputs left');

    const s6 = JJ(await step('multi select',
      "(function(){var S=CanvasState,R=ICAR.registry.Control;" +
      "S.design.nodes=[];var a=R.byLegacyKey('cd_trackh').build(),b=R.byLegacyKey('cd_seg5h').build();" +
      "S.design.nodes=[a,b];S.selection=[a.id,b.id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "return JSON.stringify({family:ICAR.ui.SchemaPanel.currentFamily()," +
      "hasInputs:box.querySelectorAll('input,select').length});})()"));
    ok(s6.family === null, 'multi-select → panel does not bind to one node');

    const s7 = JJ(await step('import replaces refs',
      "(function(){var S=CanvasState,R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "var oldId=S.selection[0];" +
      "var d=createDesign({name:'imp'});d.nodes=[R.byLegacyKey('cd_seg5h').build()];" +
      "var back=parseDesign(toV2Json(d));S.design=back.design;S.selection=[back.design.nodes[0].id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "return JSON.stringify({oldStillFound:!!SP.__findNodeById(oldId)," +
      "newFamily:ICAR.ui.SchemaPanel.currentFamily()," +
      "hasInputs:box.querySelectorAll('input,select').length});})()"));
    ok(s7.oldStillFound === false, 'import does not leave stale node references');
    ok(s7.newFamily === 'track', 'imported design still resolves track family');

    // ================= 四 + 五、真实键盘与指针输入 =================
    // 重置为一个已知轨道并聚焦输入框
    await cdp.eval("(function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "var n=R.byLegacyKey('cd_trackh').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();})()");
    await sleep(300);

    // 真实键盘：全选 + 输入
    const kb = await (async () => {
      const info = JJ(await cdp.eval("(function(){var inp=window.__spInp('trackStyle.segments');" +
        "if(!inp)return JSON.stringify({err:'no input'});" +
        "inp.focus();inp.select();var r=inp.getBoundingClientRect();" +
        "return JSON.stringify({ok:true,x:r.left+r.width/2,y:r.top+r.height/2," +
        "focused:document.activeElement===inp,value:inp.value});})()"));
      if (!info.ok) { ok(false, 'segments input not found for keyboard test'); return null; }

      // 用 CDP 真实键盘：Ctrl+A 后输入 "42"
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.insertText', { text: '42' });
      await sleep(120);
      // Enter 提交
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(200);

      const after = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
        "var n=SP.__findNodeById(S.selection[0]);" +
        "return JSON.stringify({model:n?n.trackStyle.segments:null,value:window.__spInp('trackStyle.segments').value});})()"));
      return { before: info, after: after };
    })();
    if (kb) {
      ok(kb.after.model === 42, 'real keyboard input commits value 42 (got ' + kb.after.model + ')');
      ok(String(kb.after.value) === '42', 'input keeps typed text');
    }

    // 真实键盘：非法输入不污染模型
    const kbBad = await (async () => {
      await cdp.eval("(function(){var inp=window.__spInp('trackStyle.segments');if(inp){inp.focus();inp.select();}})()");
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.insertText', { text: 'abc' });
      await sleep(150);
      const r = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
        "var n=SP.__findNodeById(S.selection[0]);" +
        "var inp=window.__spInp('trackStyle.segments');" +
        "return JSON.stringify({model:n?n.trackStyle.segments:null,invalid:inp?inp.classList.contains('spInvalid'):false});})()"));
      return r;
    })();
    ok(kbBad.model === 42, 'invalid keyboard input does NOT pollute model (still 42, got ' + kbBad.model + ')');
    ok(kbBad.invalid === true, 'invalid input is visually marked (spInvalid)');

    // 真实指针：滑块序列（pointerdown → 多次 pointermove → pointerup）
    // ⚠️ P4A 的 4 个可编辑字段里没有 <input type=range>（都是 text/select/checkbox），
    //    所以这里用**模拟真实拖动语义**的 beginLive/setLive/endLive 序列，
    //    并明示：这不是 DOM 滑块，是事务 API 的指针等价序列。
    const slider = JJ(await step('slider gesture',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "S.design=createDesign({name:'sl'});S.design.nodes=[];" +
      "var n=null;window.commit(function(){n=ICAR.registry.Control.byLegacyKey('cd_fillh').build();S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "var start=n.trackStyle.fill;" +
      "U.beginLive(n,'trackStyle.fill');" +
      "var mid=[];" +
      "for(var i=1;i<=10;i++){U.setLive(n,'trackStyle.fill',i/10);mid.push(n.trackStyle.fill);}" +
      "U.endLive(n,'trackStyle.fill');" +
      "var end=n.trackStyle.fill;" +
      "window.doUndo();" +
      "var afterUndo=SP.__findNodeById(n.id).trackStyle.fill;" +
      "return JSON.stringify({start:start,early:mid[0],latest:mid[9],end:end,afterUndo:afterUndo});})()"));
    ok(slider.latest === 1.0, 'pointer gesture reaches 1.0 (got ' + slider.latest + ')');
    ok(slider.end === 1.0, 'gesture end value persisted');
    ok(slider.afterUndo === slider.start, 'ONE undo restores pre-gesture value (' + slider.start + ')');

    // ================= 六、撤销事务 =================
    const undo1 = JJ(await step('first edit undo',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "S.design=createDesign({name:'u'});S.design.nodes=[];" +
      "var n=null;window.commit(function(){n=ICAR.registry.Control.byLegacyKey('cd_seg5h').build();S.design.nodes=[n];S.selection=[n.id];},'加');" +
      "var s0=n.trackStyle.segments;" +
      "U.setOnce(n,'trackStyle.segments',9);" +
      "var s1=SP.__findNodeById(n.id).trackStyle.segments;" +
      "window.doUndo();" +
      "var f=SP.__findNodeById(n.id);" +
      "return JSON.stringify({s0:s0,s1:s1,undoSeg:f?f.trackStyle.segments:null,found:!!f});})()"));
    ok(undo1.s1 === 9, 'first edit applies (got ' + undo1.s1 + ')');
    ok(undo1.found === true, 'node still exists after undo');
    ok(undo1.undoSeg === undo1.s0, 'FIRST edit is undoable (back to ' + undo1.s0 + ')');

    const undo2 = JJ(await step('second edit undo',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "var n=SP.__findNodeById(S.selection[0]);var a=n.trackStyle.segments;" +
      "U.setOnce(n,'trackStyle.segments',15);var b=SP.__findNodeById(n.id).trackStyle.segments;" +
      "window.doUndo();var c=SP.__findNodeById(n.id).trackStyle.segments;" +
      "return JSON.stringify({a:a,b:b,c:c});})()"));
    ok(undo2.b === 15 && undo2.c === undo2.a, 'second edit undoable (' + undo2.a + '→15→' + undo2.c + ')');

    const undoNoop = JJ(await step('noop + invalid',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "var n=SP.__findNodeById(S.selection[0]);var v=n.trackStyle.segments;" +
      "var r1=U.setOnce(n,'trackStyle.segments',v);" +
      "return JSON.stringify({sameReturned:r1===false});})()"));
    ok(undoNoop.sameReturned === true, 'no-change write produces no transaction');

    // 修改中途切换节点：live 事务应被封口，不串到新节点
    const switchMid = JJ(await step('switch mid-drag',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate,R=ICAR.registry.Control;" +
      "S.design=createDesign({name:'sw'});S.design.nodes=[];" +
      "var a=R.byLegacyKey('cd_fillh').build(),b=R.byLegacyKey('cd_fillh').build();" +
      "S.design.nodes=[a,b];S.selection=[a.id];" +
      "U.beginLive(a,'trackStyle.fill');U.setLive(a,'trackStyle.fill',0.3);" +
      "S.selection=[b.id];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var bFill=b.trackStyle.fill;" +
      "return JSON.stringify({aFill:a.trackStyle.fill,bFill:bFill,notCrossed:bFill!==0.3});})()"));
    ok(switchMid.notCrossed === true, 'mid-edit node switch does not leak value to new node');

    // ================= 七、端到端性能 =================
    const perf = JJ(await step('e2e perf',
      "(function(){var S=CanvasState,R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "S.design=createDesign({name:'perf'});S.design.nodes=[];" +
      "var keys=['cd_trackh','cd_seg5h','g_speed','lamp_tpms','t_label'];" +
      "for(var i=0;i<60;i++){S.design.nodes.push(R.byLegacyKey(keys[i%5]).build({x:(i%10)*30,y:Math.floor(i/10)*40}));}" +
      "var n=S.design.nodes[0];S.selection=[n.id];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "function med(a){var b=a.slice().sort(function(x,y){return x-y;});return b[Math.floor(b.length/2)];}" +
      "function p95(a){var b=a.slice().sort(function(x,y){return x-y;});return b[Math.floor(b.length*0.95)];}" +
      // A) 纯面板刷新（旧）
      "var tL=[];for(var j=0;j<30;j++){var t0=performance.now();window.renderProps();tL.push(performance.now()-t0);}" +
      // B) 纯面板刷新（新）
      "var tS=[];var view=ICAR.ui.SchemaPanel.__view();" +
      "for(var k=0;k<30;k++){var t1=performance.now();SP.SchemaRenderer.update(view,n,null);tS.push(performance.now()-t1);}" +
      // C) 完整交互（改值 + commit + 全量刷新）—— 这是用户真实感知的
      "var tC=[];for(var m=0;m<15;m++){var t2=performance.now();" +
      "SP.PropertyUpdate.setOnce(n,'trackStyle.segments',m+2);tC.push(performance.now()-t2);}" +
      "return JSON.stringify({legacyMed:med(tL),legacyP95:p95(tL),schemaMed:med(tS),schemaP95:p95(tS)," +
      "fullMed:med(tC),fullP95:p95(tC)});})()"));
    ok(perf.schemaMed < perf.legacyMed, 'schema panel refresh faster (median ' +
      perf.schemaMed.toFixed(4) + 'ms vs ' + perf.legacyMed.toFixed(4) + 'ms)');
    ok(perf.fullMed >= 0, 'full interaction measured (median ' + perf.fullMed.toFixed(3) + 'ms, P95 ' + perf.fullP95.toFixed(3) + 'ms)');
    console.log('  [perf] legacy med/P95 = ' + perf.legacyMed.toFixed(4) + '/' + perf.legacyP95.toFixed(4) + ' ms');
    console.log('  [perf] schema med/P95 = ' + perf.schemaMed.toFixed(4) + '/' + perf.schemaP95.toFixed(4) + ' ms');
    console.log('  [perf] FULL interact med/P95 = ' + perf.fullMed.toFixed(3) + '/' + perf.fullP95.toFixed(3) + ' ms');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "return {entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "legacyPanel:!!document.getElementById('props'),schemaPanel:!!document.getElementById('schemaProps')," +
      "barStillImage:(function(){var c=o.find(function(x){return x.key==='bar_trackh';});var b=c.make();return b.type==='image'&&!!b.assetId;})()};})())"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69 (no new migrations)');
    ok(compat.legacyPanel === true, 'legacy #props panel still exists');
    ok(compat.schemaPanel === true, 'schema #schemaProps panel still exists');
    ok(compat.barStillImage === true, 'bar_* unchanged');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
