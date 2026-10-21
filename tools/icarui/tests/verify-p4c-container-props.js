// ============================================================================
// verify-p4c-container-props.js —— P4C 容器属性面板 Schema 迁移验收
//
// 一、group 识别范围（4 容器 / 15 next_* / 手动组合 / 历史导入 / 嵌套）
// 二、四个容器 Schema 签名审计（distinctSignatures === 1）
// 三、六个字段编辑与校验（w/h/rotation/alpha/locked/visible）
// 四、父子关系回归（7 类场景 × 9 项）
// 五、新旧面板同步
// 六、输入与撤销事务（真实 CDP 键盘）
// 七、异常诊断不重复计数
// 八、性能（DOM 重建 / commit 次数 / 焦点）
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4c`,
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
    const inp = (p) => 'window.__spInp(' + JSON.stringify(p) + ')';

    await cdp.eval("window.__spInp=function(p){var b=document.getElementById('schemaProps');" +
      "var all=b.querySelectorAll('input,select');for(var i=0;i<all.length;i++){" +
      "if(all[i].getAttribute('data-path')===p)return all[i];}return null;};");
    await cdp.eval("window.__prepC=function(key){var R=ICAR.registry.Control,S=CanvasState;" +
      "var n=R.byLegacyKey(key).build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();return n;};");

    // ================= 一、group 识别范围 =================
    const scope = JJ(await step('group scope',
      "(function(){var R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "var out={fourKeys:{},nextCount:0,manual:null,nested:null};" +
      "['group','box_card','box_row','box_col'].forEach(function(k){" +
      "var n=R.byLegacyKey(k).build();var s=SP.SchemaResolver.resolve(n);" +
      "out.fourKeys[k]={isContainer:SP.SchemaResolver.isContainer(n),family:s?s.family:null,editable:s?s.editable.length:0};});" +
      "var nk=(window.BUILTIN_CONTROLS||[]).filter(function(c){return /^next_/.test(c.key);});" +
      "var allGroup=true,allResolve=true;" +
      "nk.forEach(function(c){var n=c.make();" +
      "if(n.type!=='group')allGroup=false;" +
      "if(!SP.SchemaResolver.resolve(n))allResolve=false;});" +
      "out.nextCount=nk.length;out.nextAllGroup=allGroup;out.nextAllResolve=allResolve;" +
      "if(typeof window.groupNodes==='function'){" +
      "  var S=CanvasState;S.design=createDesign({name:'m'});" +
      "  var a=R.byLegacyKey('t_title').build(),b=R.byLegacyKey('t_label').build();" +
      "  S.design.nodes=[a,b];S.selection=[a.id,b.id];" +
      "  try{window.groupNodes();}catch(e){}" +
      "  var g=S.design.nodes[0];" +
      "  out.manual={type:g?g.type:null,resolved:g?!!SP.SchemaResolver.resolve(g):null};" +
      "}" +
      "var g1=R.byLegacyKey('group').build(),g2=R.byLegacyKey('group').build();" +
      "g1.children=[g2];out.nested=!!SP.SchemaResolver.resolve(g2);" +
      "out.textNotContainer=!SP.SchemaResolver.isContainer(R.byLegacyKey('t_title').build());" +
      "out.gaugeNotContainer=!SP.SchemaResolver.isContainer(R.byLegacyKey('g_speed').build());" +
      "return JSON.stringify(out);})()"));
    ['group', 'box_card', 'box_row', 'box_col'].forEach(function (k) {
      ok(scope.fourKeys[k].isContainer === true, k + ' identified as container');
      ok(scope.fourKeys[k].family === 'container', k + ' resolves to container family');
      // P4F-04 演进：container 族补齐 scale → 可编辑字段 6 → 7
      ok(scope.fourKeys[k].editable === 7, k + ' has exactly 7 editable fields after P4F-04');
    });
    ok(scope.nextCount === 15, '15 next_* presets found (got ' + scope.nextCount + ')');
    ok(scope.nextAllGroup === true, 'all 15 next_* produce group nodes');
    ok(scope.nextAllResolve === true, 'all 15 next_* resolve to container family');
    ok(scope.manual === null || scope.manual.resolved === true,
      'manually created group resolves to container');
    ok(scope.nested === true, 'nested inner group resolves to container');
    ok(scope.textNotContainer === true, 'text node NOT identified as container');
    ok(scope.gaugeNotContainer === true, 'gauge node NOT identified as container');

    // ================= 二、Schema 签名审计 =================
    const sig = JJ(await step('schema audit',
      "(function(){var R=ICAR.registry.Control;" +
      "var K=['group','box_card','box_row','box_col'];var sigs={},vals={};" +
      "K.forEach(function(k){var d=R.byLegacyKey(k);sigs[k]=JSON.stringify(d.schema);" +
      "var n=d.build();" +
      "vals[k]={w:n.w,h:n.h,rotation:n.rotation,alpha:n.alpha,locked:n.locked,visible:n.visible};});" +
      "var uniq={};Object.keys(sigs).forEach(function(k){uniq[sigs[k]]=(uniq[sigs[k]]||0)+1;});" +
      "var fields=R.byLegacyKey('group').schema.map(function(f){return f.key;});" +
      "return JSON.stringify({distinctSignatures:Object.keys(uniq).length," +
      "counts:Object.keys(uniq).map(function(s){return uniq[s];}),fields:fields,defaults:vals});})()"));
    ok(sig.distinctSignatures === 1, 'all 4 container schemas are IDENTICAL (got ' +
      sig.distinctSignatures + ' distinct)');
    ok(sig.fields.length === 7, 'schema has 7 fields (got ' + sig.fields.length + ')');
    // P4F-04：scale 已由「声明但不可编辑」变为**可编辑**
    ok(sig.fields.indexOf('scale') >= 0, 'schema includes scale (editable since P4F-04)');
    ok(sig.defaults.group.w === 160 && sig.defaults.box_card.w === 320 &&
      sig.defaults.box_row.w === 340 && sig.defaults.box_col.w === 140,
      'container default sizes unchanged (160/320/340/140)');
    ok(sig.defaults.group.alpha === 255 && sig.defaults.group.visible === true &&
      sig.defaults.group.locked === false, 'container default alpha/locked/visible unchanged');

    // ================= 三、六字段编辑与校验 =================
    // w/h
    const wh = JJ(await step('w/h validation',
      "(function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "var f={type:'number',min:1};" +
      "return JSON.stringify({ok:V.coerce(f,'200'),nan:V.coerce(f,'NaN')," +
      "inf:V.coerce(f,'Infinity'),neg:V.coerce(f,'-5'),zero:V.coerce(f,'0'),abc:V.coerce(f,'abc')});})()"));
    ok(wh.ok.ok === true && wh.ok.value === 200, 'w/h accepts valid number');
    ok(wh.nan.ok === false, 'w/h rejects NaN');
    ok(wh.inf.ok === false, 'w/h rejects Infinity');
    ok(wh.neg.ok === false, 'w/h rejects negative (min=1)');
    ok(wh.zero.ok === false, 'w/h rejects 0');
    ok(wh.abc.ok === false, 'w/h rejects non-numeric');

    // rotation：无范围限制，各值原样保留
    const rot = JJ(await step('rotation values',
      "(function(){var R=ICAR.registry.Control;var out={};" +
      "[-45,0,45,360,450].forEach(function(v){" +
      "var d=createDesign({name:'r'});var n=R.byLegacyKey('group').build();n.rotation=v;" +
      "d.nodes=[n];var back=parseDesign(toV2Json(d));" +
      "out[v]={set:n.rotation,reloaded:back.design.nodes[0]?back.design.nodes[0].rotation:null};});" +
      "return JSON.stringify(out);})()"));
    [-45, 0, 45, 360, 450].forEach(function (v) {
      ok(rot[v].set === v && rot[v].reloaded === v,
        'rotation ' + v + ' preserved (set=' + rot[v].set + ', reloaded=' + rot[v].reloaded + ')');
    });

    // alpha 0~255，255 不得被换算成 1
    const alpha = JJ(await step('alpha values',
      "(function(){var R=ICAR.registry.Control;var out={};" +
      "[0,128,255].forEach(function(v){" +
      "var d=createDesign({name:'a'});var n=R.byLegacyKey('group').build();n.alpha=v;" +
      "d.nodes=[n];var back=parseDesign(toV2Json(d));" +
      "out[v]={set:n.alpha,reloaded:back.design.nodes[0]?back.design.nodes[0].alpha:null};});" +
      "var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "var f={type:'number',min:0,max:255};" +
      "return JSON.stringify({vals:out,over:V.coerce(f,'256'),neg:V.coerce(f,'-1')});})()"));
    ok(alpha.vals[255].reloaded === 255, 'alpha 255 stays 255 (NOT converted to 1)');
    ok(alpha.vals[0].reloaded === 0, 'alpha 0 stays 0');
    ok(alpha.vals[128].reloaded === 128, 'alpha 128 preserved');
    ok(alpha.over.ok === false, 'alpha rejects 256 (max=255)');
    ok(alpha.neg.ok === false, 'alpha rejects -1');

    // locked / visible：boolean，可恢复
        const lv = JJ(await step('locked/visible',
      "(function(){var R=ICAR.registry.Control;" +
      "var d=createDesign({name:'l'});var n=R.byLegacyKey('group').build();" +
      "n.locked=true;n.visible=false;d.nodes=[n];" +
      "var back=parseDesign(toV2Json(d));var rel=back.design.nodes[0];" +
      "var lockedRel=rel.locked, visibleRel=rel.visible;" +
      "rel.locked=false;rel.visible=true;" +
      "var back2=parseDesign(toV2Json(back.design));" +
      "return JSON.stringify({lockedRel:lockedRel,visibleRel:visibleRel," +
      "nodeStillPresent:back.design.nodes.length===1," +
      "unlockedAfter:back2.design.nodes[0].locked," +
      "shownAfter:back2.design.nodes[0].visible});})()"));
ok(lv.nodeStillPresent === true, 'hidden/locked node still present in design (not deleted)');
    ok(lv.lockedRel === true && lv.visibleRel === false,
      'locked=true / visible=false survive save+reload');
    ok(lv.nodeStillPresent === true, 'hidden+locked node is NOT deleted from design');

    // ================= 四、父子关系回归（7 场景）=================
    const scenarios = JJ(await step('parent child regression',
      "(function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "function buildScenario(name,children){" +
      "  S.design=createDesign({name:'sc'});" +
      "  var g=R.byLegacyKey('group').build({w:160,h:160});" +
      "  g.children=children;" +
      "  S.design.nodes=[g];S.selection=[g.id];" +
      "  return g;" +
      "}" +
      "var out={};" +
      "var g1=buildScenario('empty',[]);out.empty={children:g1.children.length};" +
      "var g2=buildScenario('text',[R.byLegacyKey('t_title').build({x:10,y:20})]);" +
      "var t2=g2.children[0];var tx0=t2.x,ty0=t2.y;" +
      "g2.w=400;g2.h=300;g2.rotation=45;g2.alpha=128;" +
      "out.withText={childLocalUnchanged:t2.x===tx0&&t2.y===ty0," +
      "  parentW:g2.w,parentRot:g2.rotation,parentAlpha:g2.alpha};" +
      "var imgC=(window.BUILTIN_CONTROLS||[]).find(function(c){return c.key==='img_ring';});" +
      "var g3=buildScenario('image',[imgC.make()]);" +
      "out.withImage={childType:g3.children[0].type,count:g3.children.length};" +
      "var g4=buildScenario('gauge',[R.byLegacyKey('g_speed').build()]);" +
      "out.withGauge={childType:g4.children[0].type};" +
      "var inner=R.byLegacyKey('group').build({w:80,h:80});" +
      // ⚠️ container-family.build() 只接受 name/x/y/w/h/z（P4C 实测），
      //    rotation 必须建好后赋值 —— 这也是 Schema 面板的编辑方式。
      "inner.rotation=10;" +
      "var outer=buildScenario('nested',[inner]);" +
      "outer.w=500;outer.alpha=64;" +
      "out.nested={innerW:inner.w,innerRot:inner.rotation,outerW:outer.w,outerAlpha:outer.alpha," +
      "  innerUnchanged:inner.w===80&&inner.rotation===10};" +
      "var nc=(window.BUILTIN_CONTROLS||[]).find(function(c){return c.key==='next_speed_oem';});" +
      "var nn=nc.make();S.design=createDesign({name:'nx'});S.design.nodes=[nn];" +
      "var kid=nn.children[0];var kx0=kid.x,ky0=kid.y;" +
      "nn.w=300;nn.h=200;nn.rotation=30;nn.alpha=200;" +
      "out.nextPreset={children:nn.children.length,childLocalUnchanged:kid.x===kx0&&kid.y===ky0," +
      "  parentW:nn.w,parentRot:nn.rotation};" +
      "var imp=createDesign({name:'imp'});" +
      "var gi=R.byLegacyKey('box_card').build();" +
      "gi.children=[R.byLegacyKey('box_row').build()];" +
      "gi.children[0].children=[R.byLegacyKey('t_label').build()];" +
      "gi.w=333;gi.rotation=-45;gi.alpha=77;gi.locked=true;gi.visible=false;" +
      "imp.nodes=[gi];" +
      "var back=parseDesign(toV2Json(imp));" +
      "var r0=back.design.nodes[0];" +
      "out.imported={err:back.errors.length,w:r0.w,rot:r0.rotation,alpha:r0.alpha," +
      "  locked:r0.locked,visible:r0.visible," +
      "  depth1:r0.children?r0.children.length:0," +
      "  depth2:(r0.children&&r0.children[0].children)?r0.children[0].children.length:0};" +
      "return JSON.stringify(out);})()"));
    ok(scenarios.empty.children === 0, 'scenario: empty container');
    ok(scenarios.withText.childLocalUnchanged === true,
      'scenario: parent size/rotation/alpha change does NOT alter child local coords');
    ok(scenarios.withText.parentW === 400 && scenarios.withText.parentRot === 45 &&
      scenarios.withText.parentAlpha === 128, 'scenario: parent props applied');
    ok(scenarios.withImage.childType === 'image', 'scenario: container with image');
    ok(scenarios.withGauge.childType === 'gauge', 'scenario: container with gauge');
    ok(scenarios.nested.innerUnchanged === true,
      'scenario: nested group inner props unaffected by outer changes');
    ok(scenarios.nextPreset.children === 2 && scenarios.nextPreset.childLocalUnchanged === true,
      'scenario: next_* preset children preserved and unaffected');
    ok(scenarios.imported.err === 0, 'scenario: imported nested design parses clean');
    ok(scenarios.imported.w === 333 && scenarios.imported.rot === -45 &&
      scenarios.imported.alpha === 77, 'scenario: imported container props preserved');
    ok(scenarios.imported.locked === true && scenarios.imported.visible === false,
      'scenario: imported locked/visible preserved');
    ok(scenarios.imported.depth1 === 1 && scenarios.imported.depth2 === 1,
      'scenario: imported nesting depth preserved (2 levels)');

    // ================= 五、新旧面板同步 =================
    await cdp.eval("window.__prepC('box_card');");
    await sleep(300);
    const sync1 = JJ(await step('legacy -> schema',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var n=SP.__findNodeById(S.selection[0]);n.w=555;window.refreshAll();" +
      "var e=window.__spInp('w');" +
      "return JSON.stringify({model:n.w,panel:e?e.value:null});})()"));
    ok(sync1.panel === '555', 'legacy edit → schema panel shows 555 (got ' + sync1.panel + ')');

    const sync2 = JJ(await step('schema -> model',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;var e=window.__spInp('w');" +
      "e.value='222';e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "e.dispatchEvent(new Event('change',{bubbles:true}));" +
      "return JSON.stringify({model:SP.__findNodeById(S.selection[0]).w});})()"));
    ok(sync2.model === 222, 'schema panel edit updates model (got ' + sync2.model + ')');

    const sync3 = JJ(await step('undo sync',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "window.doUndo();if(window.refreshAll)window.refreshAll();" +
      "var e=window.__spInp('w');" +
      "return JSON.stringify({model:SP.__findNodeById(S.selection[0]).w,panel:e?e.value:null});})()"));
    ok(String(sync3.panel) === String(sync3.model), 'undo keeps panel and model in sync');

    const sync4 = JJ(await step('no/multi select',
      "(function(){var S=CanvasState;" +
      "S.selection=[];if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var f1=ICAR.ui.SchemaPanel.currentFamily();" +
      "S.selection=[S.design.nodes[0].id,S.design.nodes[0].id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "return JSON.stringify({none:f1,multi:ICAR.ui.SchemaPanel.currentFamily()});})()"));
    ok(sync4.none === null, 'no selection → family null');
    ok(sync4.multi === null, 'multi selection → family null');

    const sync5 = JJ(await step('delete node',
      "(function(){var S=CanvasState;S.design.nodes=[];S.selection=[];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "return JSON.stringify({family:ICAR.ui.SchemaPanel.currentFamily()," +
      "inputs:box.querySelectorAll('input,select').length});})()"));
    ok(sync5.family === null, 'delete node → panel cleared');
    ok(sync5.inputs === 0, 'delete node → no stale inputs (no dangling refs)');

    // ================= 六、真实键盘与撤销事务 =================
    await cdp.eval("window.__prepC('group');");
    await sleep(250);

    // Enter 提交
    await cdp.eval("(function(){var e=" + inp('w') + ";if(e){e.focus();e.select();}})()");
    await sleep(80);
    await cdp.send('Input.insertText', { text: '250' });
    await sleep(100);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(220);
    const enterOk = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({model:SP.__findNodeById(S.selection[0]).w});})()"));
    ok(enterOk.model === 250, '[真实] Enter commits w=250 (got ' + enterOk.model + ')');

    // Tab 焦点
    await cdp.eval("(function(){var e=" + inp('w') + ";if(e)e.focus();})()");
    await sleep(80);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(150);
    const tabPath = await cdp.eval("(function(){var a=document.activeElement;" +
      "return a?a.getAttribute('data-path'):null;})()");
    ok(tabPath === 'h', '[真实] Tab moves w → h (got ' + tabPath + ')');

    // Escape 取消
    await cdp.eval("(function(){var e=" + inp('alpha') + ";if(e){e.focus();e.select();}})()");
    await sleep(80);
    const alphaBefore = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({a:SP.__findNodeById(S.selection[0]).alpha});})()"));
    await cdp.send('Input.insertText', { text: '99' });
    await sleep(120);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
    const alphaAfter = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({a:SP.__findNodeById(S.selection[0]).alpha});})()"));
    ok(alphaAfter.a === alphaBefore.a, '[真实] Escape restores alpha to ' + alphaBefore.a + ' (got ' + alphaAfter.a + ')');

    // 非法数值失焦不污染
    const badBefore = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({h:SP.__findNodeById(S.selection[0]).h});})()"));
    await cdp.eval("(function(){var e=" + inp('h') + ";if(e){e.focus();e.select();}})()");
    await sleep(80);
    await cdp.send('Input.insertText', { text: 'abc' });
    await sleep(120);
    await cdp.eval("(function(){var e=" + inp('w') + ";if(e)e.focus();})()");
    await sleep(200);
    const badAfter = JJ(await cdp.eval("(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({h:SP.__findNodeById(S.selection[0]).h});})()"));
    ok(badAfter.h === badBefore.h, '[真实] invalid h on blur does NOT pollute model');

    // Checkbox 只提交一次 + 无变化不产生撤销
    const checkbox = JJ(await step('checkbox single commit',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var n=SP.__findNodeById(S.selection[0]);" +
      "var commits=0;var oc=window.commit;" +
      "window.commit=function(){commits++;return oc.apply(this,arguments);};" +
      "SP.PropertyUpdate.setOnce(n,'locked',true);" +
      "var c1=commits;" +
      "SP.PropertyUpdate.setOnce(n,'locked',true);" +
      "var c2=commits;" +
      "window.commit=oc;" +
      "return JSON.stringify({firstToggle:c1,secondNoop:c2-c1,locked:n.locked});})()"));
    ok(checkbox.firstToggle === 1, 'checkbox toggle produces exactly 1 commit (got ' + checkbox.firstToggle + ')');
    ok(checkbox.secondNoop === 0, 'setting same value again produces 0 commits (got ' + checkbox.secondNoop + ')');
    ok(checkbox.locked === true, 'locked applied');

    // 连续修改 + 单次撤销
    const undoSingle = JJ(await step('single undo restores',
      "(function(){var R=ICAR.registry.Control,S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "S.design=createDesign({name:'u'});" +
      "var n=R.byLegacyKey('group').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "window.commit(function(){n.w=160;},'base');" +
      "var w0=n.w;" +
      "var U=SP.PropertyUpdate;U.beginLive(n,'w');" +
      "for(var i=1;i<=10;i++){U.setLive(n,'w',160+i*10);}" +
      "var w1=n.w;" +
      "U.endLive(n,'w');" +
      "window.doUndo();" +
      "var w2=SP.__findNodeById(n.id).w;" +
      "return JSON.stringify({w0:w0,w1:w1,w2:w2});})()"));
    ok(undoSingle.w1 === 260, 'live editing reaches 260 (got ' + undoSingle.w1 + ')');
    ok(undoSingle.w2 === undoSingle.w0, 'ONE undo restores pre-edit w (' + undoSingle.w0 + ')');

    // 锁定/隐藏后仍能恢复
    const recover = JJ(await step('locked hidden recoverable',
      "(function(){var R=ICAR.registry.Control,S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "S.design=createDesign({name:'r'});" +
      "var n=R.byLegacyKey('group').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "n.locked=true;n.visible=false;window.refreshAll();" +
      "var stillThere=S.design.nodes.length===1;" +
      "SP.PropertyUpdate.setOnce(n,'locked',false);" +
      "SP.PropertyUpdate.setOnce(n,'visible',true);" +
      "return JSON.stringify({stillThere:stillThere,lockedNow:n.locked,visibleNow:n.visible});})()"));
    ok(recover.stillThere === true, 'locked+hidden node still exists (not deleted)');
    ok(recover.lockedNow === false, 'can unlock via schema field');
    ok(recover.visibleNow === true, 'can show via schema field');

    // ================= 七、异常诊断不重复计数 =================
    const diag = JJ(await step('no duplicate counting',
      "(function(){var SP=ICAR.ui.schemaProps;" +
      "window.__ICAR_SCHEMA_ERROR=null;window.__ICAR_SCHEMA_ERROR_COUNT=0;" +
      "var orig=SP.SchemaRenderer.update;" +
      "SP.SchemaRenderer.update=function(){throw new Error('DUP_COUNT_TEST');};" +
      "var S=CanvasState;var R=ICAR.registry.Control;" +
      "S.design=createDesign({name:'d'});" +
      "var n=R.byLegacyKey('group').build();" +
      "S.design.nodes=[n];S.selection=[n.id];" +
      "try{window.refreshAll();}catch(e){}" +
      "SP.SchemaRenderer.update=orig;" +
      "var c=window.__ICAR_SCHEMA_ERROR_COUNT;" +
      "var err=window.__ICAR_SCHEMA_ERROR;" +
      "window.__ICAR_SCHEMA_ERROR=null;window.__ICAR_SCHEMA_ERROR_COUNT=0;" +
      "return JSON.stringify({count:c,msg:err?err.message:null,hasStack:err?!!err.stack:false});})()"));
    ok(diag.count === 1, 'ONE logical failure counted exactly ONCE (got ' + diag.count + ')');
    ok(diag.msg === 'DUP_COUNT_TEST', 'original error message preserved');
    ok(diag.hasStack === true, 'original stack preserved');

    // ================= 八、性能 =================
    const perf = JJ(await step('container perf',
      "(function(){var R=ICAR.registry.Control,S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "S.design=createDesign({name:'p'});S.design.nodes=[];" +
      "var g=R.byLegacyKey('group').build();" +
      "for(var i=0;i<20;i++){g.children.push(R.byLegacyKey('t_label').build({x:i*5,y:i*3}));}" +
      "window.commit(function(){S.design.nodes=[g];S.selection=[g.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "var before=box.querySelector('.spRow');" +
      "ICAR.ui.SchemaPanel.refresh();" +
      "var after=box.querySelector('.spRow');" +
      "var commits=0;var oc=window.commit;" +
      "window.commit=function(){commits++;return oc.apply(this,arguments);};" +
      "SP.PropertyUpdate.setOnce(g,'alpha',g.alpha);" +
      "SP.PropertyUpdate.setOnce(g,'alpha',g.alpha);" +
      "var noopCommits=commits;" +
      "window.commit=oc;" +
      "var t=[];for(var j=0;j<10;j++){var t0=performance.now();window.refreshAll();t.push(performance.now()-t0);}" +
      "t.sort(function(a,b){return a-b;});" +
      "return JSON.stringify({sameDom:before===after,children:g.children.length," +
      "noopCommits:noopCommits,refreshMed:t[5],refreshMax:t[9]});})()"));
    ok(perf.sameDom === true, 'container property change does NOT rebuild schema DOM');
    ok(perf.children === 20, '20 children in perf scenario');
    ok(perf.noopCommits === 0, 'repeated same-value assignment produces 0 commits');
    console.log('  [perf] refreshAll with 20 children: med=' + perf.refreshMed.toFixed(2) +
      'ms max=' + perf.refreshMax.toFixed(2) + 'ms');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "(function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "var SP=ICAR.ui.schemaProps;" +
      "return JSON.stringify({entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "track:!!SP.SchemaResolver.resolve({type:'image',trackStyle:{orient:'h'}})," +
      "text:!!SP.SchemaResolver.resolve({type:'text'})," +
      "container:!!SP.SchemaResolver.resolve({type:'group'})," +
      "legacyPanel:!!document.getElementById('props')," +
      "autoLayout:typeof window.autoLayout," +
      "clipChildren:typeof window.clipChildren});})()"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69 (no new migrations)');
    ok(compat.track === true, 'track panel still works');
    ok(compat.text === true, 'text panel still works');
    ok(compat.container === true, 'container panel works');
    ok(compat.legacyPanel === true, 'legacy #props panel exists');
    ok(compat.autoLayout === 'undefined', 'no auto-layout introduced (P3B constraint kept)');
    ok(compat.clipChildren === 'undefined', 'no child clipping introduced (P3B constraint kept)');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
