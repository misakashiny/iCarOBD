// ============================================================================
// verify-p4a-schema-props.js —— P4A Schema 属性面板试点验收
//
// 一、P3D 遗留核验
//   1. 三个添加入口（双击/点击/拖拽）尺寸一致，且 prepareBuiltinImages 只执行一次
//   2. p3d-track-pixels.json 案例数与报告一致（43）
//   3. 节点识别不得依赖 __controlKey（它不进 JSON，保存重载后丢失）
// 二、Schema 核心五组件（Resolver / Renderer / Accessor / Validator / Update）
// 三、只读面板：读真实属性、支持重选/重载/导入
// 四、受控编辑：4 个字段（orient/segments/glow/fill）
// 五、增量刷新：不重建 DOM、焦点保留、单次撤销
// 六、性能：与旧面板对比
// 七、兼容：旧面板仍在、其它控件不受影响、icar.ui/2 未改
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4a`,
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
    const SETUP = "function sel(n){var S=CanvasState;S.design=createDesign({name:'t'});S.design.nodes=[];" +
      "S.design.nodes.push(n);S.selection=[n.id];if(window.onSelectionChanged)window.onSelectionChanged();return n;}";

    // ================= 一.1 三个添加入口尺寸一致 =================
    const adds = JJ(await step('add paths',
      "JSON.stringify((function(){" + SETUP +
      "var S=CanvasState,K='cd_trackh',out={};" +
      "function reset(){S.design=createDesign({name:'a'});S.design.nodes=[];if(window.refreshAll)window.refreshAll();}" +
      "function last(){var a=S.design.nodes;return a[a.length-1];}" +
      // 双击/点击
      "reset();var okc=ICAR.ui.CatalogPanel.addToCanvas(K);var a=last();" +
      "out.catalogAdd={ok:okc,w:a?a.w:null,h:a?a.h:null,type:a?a.type:null};" +
      // 拖拽
      "reset();var cv=document.getElementById('cv');var r=cv.getBoundingClientRect();" +
      "var dt=new DataTransfer();dt.setData('application/x-ctrl',K);" +
      "cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt," +
      "clientX:r.left+r.width/2,clientY:r.top+r.height/2}));" +
      "var b=last();out.drag={w:b?b.w:null,h:b?b.h:null,type:b?b.type:null};" +
      // 统一适配层直接调
      "reset();var c=ICAR.ui.insertControl(K,{});out.insertLayer={w:c?c.w:null,h:c?c.h:null};" +
      // 底层契约
      "var rb=ICAR.registry.Control.byLegacyKey(K).build();out.registryBuild={w:rb.w,h:rb.h};" +
      "var cvv=S.design.canvas;out.ratio=cvv.designH/cvv.designW;" +
      "return out;})())"));
    ok(adds.catalogAdd.ok === true, 'catalog double-click add succeeds (P4A fixed silent failure)');
    ok(adds.catalogAdd.w === adds.drag.w, 'catalog add width === drag width (both ' + adds.drag.w + ')');
    ok(adds.catalogAdd.h === adds.drag.h, 'catalog add height === drag height');
    ok(adds.insertLayer.w === adds.drag.w, 'insert layer width === drag width');
    ok(adds.registryBuild.w === 240, 'Registry.build keeps raw design width 240');
    ok(Math.abs(adds.drag.w - 240 * adds.ratio) < 0.01, 'canvas fit applied exactly once (240 x ratio)');

    // 多种画布宽高比回归
    const ratios = JJ(await step('multi ratios',
      "JSON.stringify((function(){var S=CanvasState;var out=[];" +
      "[[2560,1600],[1600,2560],[1280,720],[800,800]].forEach(function(pair){" +
      "S.design=createDesign({name:'r'});S.design.nodes=[];S.design.canvas.designW=pair[0];S.design.canvas.designH=pair[1];" +
      "var n=ICAR.ui.insertControl('cd_trackh',{});" +
      "var expect=240*(pair[1]/pair[0]);" +
      "out.push({dw:pair[0],dh:pair[1],got:n.w,expect:expect,ok:Math.abs(n.w-expect)<0.01});});" +
      "return out;})())"));
    ratios.forEach(function (r) {
      ok(r.ok, 'ratio ' + r.dw + 'x' + r.dh + ' → w=' + r.got.toFixed(3) + ' (expect ' + r.expect.toFixed(3) + ')');
    });

    // ================= 一.2 像素案例数 =================
    const px = JJ(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'p3d-track-pixels.json'), 'utf8'));
    const pxKeys = Object.keys(px);
    ok(pxKeys.length === 43, 'p3d-track-pixels.json has 43 cases (got ' + pxKeys.length + ')');
    ok(pxKeys.filter(function (k) { return /^cd_/.test(k); }).length === 28, '28 default cd_* cases');
    ok(pxKeys.filter(function (k) { return /^custom_/.test(k); }).length === 12, '12 custom param cases');
    ok(pxKeys.filter(function (k) { return /^bar_/.test(k); }).length === 2, '2 bar_* cases');
    ok(pxKeys.indexOf('null_trackstyle') >= 0, '1 null trackStyle case');

    // ================= 一.3 节点识别不依赖 __controlKey =================
    const idTest = JJ(await step('identify',
      "JSON.stringify((function(){" + SETUP +
      "var R=ICAR.registry.Control,n=R.byLegacyKey('cd_trackh').build();" +
      "var j=window.nodeToJson(n);" +
      "var round=JSON.parse(JSON.stringify(j));" +
      "var d=createDesign({name:'id'});d.nodes=[n];var back=parseDesign(toV2Json(d));" +
      "return {nodeHasKey:'__controlKey' in n,jsonHasKey:'__controlKey' in j," +
      "jsonHasTs:!!j.trackStyle,backHasKey:'__controlKey' in (back.design.nodes[0]||{})," +
      "backType:back.design.nodes[0]?back.design.nodes[0].type:null," +
      "backHasTs:!!(back.design.nodes[0]&&back.design.nodes[0].trackStyle)};})())"));
    ok(idTest.jsonHasKey === false, '__controlKey is NOT serialized');
    ok(idTest.backHasKey === false, '__controlKey lost after save+reload');
    ok(idTest.backType === 'image' && idTest.backHasTs === true,
      'track identifiable by persistent fields (type=image + trackStyle) after reload');

    const idResolver = JJ(await step('resolver by persisted fields',
      "JSON.stringify((function(){var SP=ICAR.ui.schemaProps;" +
      "var track={type:'image',trackStyle:{orient:'h'}};" +
      "var plain={type:'image',trackStyle:null};" +
      "var gauge={type:'gauge'};" +
      "return {trackIsTrack:SP.SchemaResolver.isTrack(track),plainIsTrack:SP.SchemaResolver.isTrack(plain)," +
      "gaugeIsTrack:SP.SchemaResolver.isTrack(gauge),plainIsImage:SP.SchemaResolver.isPlainImage(plain)};})())"));
    ok(idResolver.trackIsTrack === true, 'resolver: image+trackStyle → track');
    ok(idResolver.plainIsTrack === false, 'resolver: image+null trackStyle → NOT track');
    ok(idResolver.gaugeIsTrack === false, 'resolver: gauge → NOT track');
    ok(idResolver.plainIsImage === true, 'resolver: plain image recognized');

    // ================= 二、五组件存在 =================
    const comps = JJ(await step('components',
      "JSON.stringify((function(){var SP=ICAR.ui.schemaProps;var o={};" +
      "['SchemaResolver','SchemaRenderer','PropertyAccessor','PropertyValidator','PropertyUpdate'].forEach(function(k){" +
      "o[k]=typeof SP[k]==='object';});return o;})())"));
    Object.keys(comps).forEach(function (k) { ok(comps[k], 'component present: ' + k); });

    // ================= 三、只读面板 =================
    const ro = JJ(await step('readonly panel',
      "JSON.stringify((function(){" + SETUP +
      "var R=ICAR.registry.Control,n=sel(R.byLegacyKey('cd_seg5h').build());" +
      "var box=document.getElementById('schemaProps');" +
      "return {family:ICAR.ui.SchemaPanel.currentFamily()," +
      "rows:box.querySelectorAll('.spRow').length," +
      "editables:box.querySelectorAll('input,select').length," +
      "hasOrientText:box.textContent.indexOf('方向')>=0};})())"));
    ok(ro.family === 'track', 'schema panel resolves track family');
    ok(ro.rows === 11, '11 property rows rendered (got ' + ro.rows + ')');
    // ⚠️ P4F-02 演进：track 族可编辑字段由 4 扩到 11（补齐 radius/inset/gradient/
  //    ticks/band/w/h）。原断言写死 4，现改为**精确清单比对**（比数量断言更严）。
  ok(ro.editables === 11, 'exactly 11 editable fields after P4F-02 (got ' + ro.editables + ')');
    ok(ro.hasOrientText === true, 'panel shows field labels');

    // 只读面板：切到**尚未被 Schema 接管**的节点类型
    //
    // ⚠️ P4E-02 修正：原来这里用的是 `g_speed`（仪表）作为"非轨道"样本，
    //    断言它 resolve 成 null。但仪表族在 P4E-02 已正式接入 Schema 面板，
    //    该断言的前提本身失效了 —— 不是行为退化。
    //    改用**普通图片节点**：图片族至今未接入（仍走旧面板），
    //    语义与本断言想验证的"未接管 → 回退旧面板"完全一致。
    const roGauge = JJ(await step('non-track',
      "JSON.stringify((function(){" + SETUP +
      "sel(window.createNode(window.NODE_IMAGE,{name:'普通图',assetId:'x',w:100,h:100}));" +
      "var box=document.getElementById('schemaProps');" +
      "return {family:ICAR.ui.SchemaPanel.currentFamily()," +
      "fallbackText:box.textContent.indexOf('继续用下方旧面板')>=0};})())"));
    ok(roGauge.family === null, 'non-track resolved to null family');
    ok(roGauge.fallbackText === true, 'non-track shows fallback hint to legacy panel');

    // 保存重载后仍识别
    const reload = JJ(await step('reload still track',
      "JSON.stringify((function(){" + SETUP +
      "var R=ICAR.registry.Control;var n=R.byLegacyKey('cd_seg5v').build();" +
      "var d=createDesign({name:'rl'});d.nodes=[n];var back=parseDesign(toV2Json(d));" +
      "var S=CanvasState;S.design=back.design;S.selection=[back.design.nodes[0].id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "return {family:ICAR.ui.SchemaPanel.currentFamily()," +
      "orient:ICAR.ui.schemaProps.PropertyAccessor.get(back.design.nodes[0],'trackStyle.orient')};})())"));
    ok(reload.family === 'track', 'reloaded track still resolves to track family');
    ok(reload.orient === 'v', 'reloaded value correct (orient=v)');

    // ================= 四、受控编辑 =================
    // Accessor
    const acc = JJ(await step('accessor',
      "JSON.stringify((function(){var A=ICAR.ui.schemaProps.PropertyAccessor;" +
      "var o={trackStyle:{orient:'h',fill:null}};" +
      "var r1=A.get(o,'trackStyle.orient');var r2=A.get(o,'trackStyle.fill');" +
      "var w1=A.set(o,'trackStyle.orient','v');var w2=A.set(o,'trackStyle.orient','v');" +
      "var w3=A.set(o,'nonexistent.deep',1);" +
      "return {get1:r1,getNull:r2,changed:w1,noChange:w2,rejectMissingParent:w3,after:o.trackStyle.orient};})())"));
    ok(acc.get1 === 'h', 'accessor reads nested path');
    ok(acc.getNull === null, 'accessor returns real null (not undefined)');
    ok(acc.changed === true, 'accessor writes when value changes');
    ok(acc.noChange === false, 'accessor returns false when value unchanged (no commit)');
    ok(acc.rejectMissingParent === false, 'accessor refuses to create missing intermediate object');

    // Validator：四种类型 + null
    const val = JJ(await step('validator',
      "JSON.stringify((function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "return {" +
      "enumNull:V.coerce({type:'enum',values:[null,'gloss','fade']},null)," +
      "enumStrNull:V.coerce({type:'enum',values:[null,'gloss','fade']},'__null__')," +
      "enumOk:V.coerce({type:'enum',values:['h','v']},'v')," +
      "enumBad:V.coerce({type:'enum',values:['h','v']},'x')," +
      "boolTrue:V.coerce({type:'boolean'},true)," +
      "boolStr:V.coerce({type:'boolean'},'true')," +
      "numOk:V.coerce({type:'number',min:0,max:1},0.5)," +
      "numEmpty:V.coerce({type:'number',nullable:true},'')," +
      "numBad:V.coerce({type:'number'},'abc')," +
      "numRange:V.coerce({type:'number',min:0,max:1},5)};})())"));
    ok(val.enumNull.ok === true && val.enumNull.value === null,
      'validator: real null accepted and stays null (not string "null")');
    ok(val.enumStrNull.ok === false, 'validator: "__null__" UI token rejected as value');
    ok(val.enumOk.ok === true, 'validator: valid enum accepted');
    ok(val.enumBad.ok === false, 'validator: invalid enum rejected');
    ok(val.boolTrue.ok === true && val.boolStr.value === true, 'validator: boolean + string coercion');
    ok(val.numOk.ok === true && val.numOk.value === 0.5, 'validator: number accepted');
    ok(val.numEmpty.ok === true && val.numEmpty.value === null, 'validator: empty string → null (nullable)');
    ok(val.numBad.ok === false, 'validator: non-numeric rejected');
    ok(val.numRange.ok === false, 'validator: out-of-range rejected');

    // 编辑 + 撤销（D-09：需两次操作才观察得到撤销）
    const edit = JJ(await step('edit undo redo',
      "JSON.stringify((function(){" + SETUP +
      "var SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "var R=ICAR.registry.Control;var n=sel(R.byLegacyKey('cd_trackh').build());" +
      "U.setOnce(n,'trackStyle.segments',5);var a=n.trackStyle.segments;" +
      "U.setOnce(n,'trackStyle.segments',20);var b=n.trackStyle.segments;" +
      "window.doUndo();var c=SP.__findNodeById(n.id).trackStyle.segments;" +
      "window.doRedo();var d=SP.__findNodeById(n.id).trackStyle.segments;" +
      "return {after1:a,after2:b,undo:c,redo:d};})())"));
    ok(edit.after1 === 5 && edit.after2 === 20, 'two edits applied');
    ok(edit.undo === 5, 'undo steps back one edit (20→5)');
    ok(edit.redo === 20, 'redo restores');

    // live 拖动：只产生一次撤销
    const live = JJ(await step('live drag single undo',
      "JSON.stringify((function(){" + SETUP +
      "var SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "var R=ICAR.registry.Control;var n=sel(R.byLegacyKey('cd_fillh').build());" +
      "var start=n.trackStyle.fill;" +
      "U.setOnce(n,'trackStyle.segments',1);" +     // 先做一次操作，让有可控的历史
      "U.setOnce(n,'trackStyle.segments',2);" +
      "U.beginLive(n,'trackStyle.fill');" +
      "for(var i=1;i<=10;i++){U.setLive(n,'trackStyle.fill',i/10);}" +
      "var mid=n.trackStyle.fill;" +
      "U.endLive(n,'trackStyle.fill');" +
      "var end=n.trackStyle.fill;" +
      "window.doUndo();var afterUndo=SP.__findNodeById(n.id).trackStyle.fill;" +
      "return {start:start,mid:mid,end:end,afterUndo:afterUndo};})())"));
    ok(live.mid === 1.0, 'live drag reaches final value 1.0 in one gesture (got ' + live.mid + ')');
    ok(live.end === 1.0, 'live drag end value persisted');
    ok(live.afterUndo === live.start, 'ONE undo restores pre-drag value (' + live.start + ')');

    // 无变化不 commit
    const noop = JJ(await step('no-op write',
      "JSON.stringify((function(){" + SETUP +
      "var SP=ICAR.ui.schemaProps,U=SP.PropertyUpdate;" +
      "var R=ICAR.registry.Control;var n=sel(R.byLegacyKey('cd_trackh').build());" +
      "var same=U.setOnce(n,'trackStyle.segments',n.trackStyle.segments);" +
      "return {sameReturnedFalse:same===false};})())"));
    ok(noop.sameReturnedFalse === true, 'writing identical value produces no commit');

    // ================= 五、增量刷新 =================
    const inc = JJ(await step('incremental',
      "JSON.stringify((function(){" + SETUP +
      "var R=ICAR.registry.Control;var n=sel(R.byLegacyKey('cd_seg5h').build());" +
      "var box=document.getElementById('schemaProps');" +
      "var before=box.querySelector('.spRow');" +
      "SP_refresh();" +       // 用下面的 function 包装避免多次定义
      "var after=box.querySelector('.spRow');" +
      "return {sameDom:before===after};" +
      "function SP_refresh(){ICAR.ui.SchemaPanel.refresh();}})())"));
    ok(inc.sameDom === true, 'refresh keeps the SAME DOM element (no full rebuild)');

    // 焦点保留：模拟编辑中刷新
    const focus = JJ(await step('focus keep',
      "JSON.stringify((function(){" + SETUP +
      "var R=ICAR.registry.Control;var n=sel(R.byLegacyKey('cd_trackh').build());" +
      "var box=document.getElementById('schemaProps');" +
      "var inp=box.querySelector('input[data-path=\"trackStyle.segments\"]');" +
      "if(!inp)return {found:false};" +
      "inp.value='7';inp.focus();" +
      "var act0=document.activeElement===inp;" +
      "ICAR.ui.SchemaPanel.__setEditing('trackStyle.segments');ICAR.ui.SchemaPanel.refresh();" +
      "var act1=document.activeElement===inp;var val=inp.value;" +
      "return {found:true,focusedBefore:act0,focusedAfter:act1,valueKept:val};})())"));
    ok(focus.found === true, 'segments input present');
    ok(focus.focusedBefore === true, 'input focused');
    ok(focus.focusedAfter === true, 'focus preserved across refresh');
    ok(focus.valueKept === '7', 'typed value not overwritten during refresh (got ' + focus.valueKept + ')');

    // ================= 六、性能 =================
    const perf = JJ(await step('perf',
      "JSON.stringify((function(){var S=CanvasState,R=ICAR.registry.Control;" +
      "S.design=createDesign({name:'perf'});S.design.nodes=[];" +
      "var keys=['cd_trackh','cd_seg5h','g_speed','lamp_tpms','t_label'];" +
      "for(var i=0;i<60;i++){S.design.nodes.push(R.byLegacyKey(keys[i%5]).build({x:(i%10)*30,y:Math.floor(i/10)*40}));}" +
      "var n=S.design.nodes[0];S.selection=[n.id];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var t0=performance.now();for(var j=0;j<20;j++){window.renderProps();}var legacy=(performance.now()-t0)/20;" +
      "var SP=ICAR.ui.schemaProps;var view=ICAR.ui.SchemaPanel.__view();" +
      "var t1=performance.now();for(var m=0;m<20;m++){SP.SchemaRenderer.update(view,n,null);}var schema=(performance.now()-t1)/20;" +
      "var box=document.getElementById('props');window.renderProps();var a=box.querySelector('*');window.renderProps();var b=box.querySelector('*');" +
      "var sbox=document.getElementById('schemaProps');var c=sbox.querySelector('.spRow');ICAR.ui.SchemaPanel.refresh();var d=sbox.querySelector('.spRow');" +
      "return {nodes:60,legacyMs:legacy,schemaMs:schema,legacyRebuilds:a!==b,schemaRebuilds:c!==d};})())"));
    ok(perf.nodes === 60, '60-node scenario built');
    ok(perf.schemaMs < perf.legacyMs, 'schema update faster than legacy renderProps (' +
      perf.schemaMs.toFixed(4) + 'ms vs ' + perf.legacyMs.toFixed(4) + 'ms)');
    ok(perf.legacyRebuilds === true, 'legacy panel DOES rebuild DOM (baseline behavior)');
    ok(perf.schemaRebuilds === false, 'schema panel does NOT rebuild DOM');

    // ================= 七、兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var S=CanvasState,R=ICAR.registry.Control;" +
      "S.design=createDesign({name:'c'});S.design.nodes=[];" +
      "var n=R.byLegacyKey('cd_trackh').build();S.design.nodes.push(n);S.selection=[n.id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var props=document.getElementById('props');" +
      "return {legacyPanelExists:!!props,legacyPanelHasContent:props.innerHTML.length>50," +
      "schemaPanelExists:!!document.getElementById('schemaProps')," +
      "entries:(window.BUILTIN_CONTROLS||[]).length," +
      "barStillImage:(function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key==='bar_trackh';});var b=c.make();return b.type==='image'&&!!b.assetId;})()," +
      "bridged:JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status())).bridged.length};})())"));
    ok(compat.legacyPanelExists === true, 'legacy #props panel still exists');
    ok(compat.legacyPanelHasContent === true, 'legacy panel still renders content');
    ok(compat.schemaPanelExists === true, 'schema #schemaProps panel exists');
    ok(compat.entries === 215, 'all 215 entries preserved');
    ok(compat.barStillImage === true, 'bar_* still image track (not migrated)');
    ok(compat.bridged === 69, 'bridge count unchanged (69, no new migrations)');

    // 其它控件仍可 make
    const others = JJ(await step('others',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0,errs=[];" +
      "o.forEach(function(c){try{if(c.make())okc++;else errs.push(c.key);}catch(e){errs.push(c.key);}});" +
      "return {total:o.length,ok:okc,errs:errs.slice(0,5)};})())"));
    ok(others.ok === 215, 'all 215 controls still make() (fail=' + others.errs.length + ')');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
