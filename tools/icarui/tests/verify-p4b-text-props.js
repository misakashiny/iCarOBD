// ============================================================================
// verify-p4b-text-props.js —— P4B 文字属性面板迁移验收
//
// 一、12 个文字控件全部可识别（持久化字段 type === "text"，不依赖 __controlKey）
// 二、Schema 分派规则：t_label 与其余 11 条的 font.size.max 不同，按节点自己的
//     定义取；重载后回退到最宽松的定义
// 三、5 个字段安全编辑（text / font.size / font.weight / font.color / font.align）
// 四、真实键盘输入（CDP Input.*）：Tab / Arrow / Shift+Arrow / 删除 / Ctrl+A /
//     中英文数字 / Enter / Escape / 失焦 / 非法输入
// 五、中文输入法 composition 事件（组合期间不提交）
// 六、新旧面板同步
// 七、历史字体问题（D-01/D-02/D-03）只读不修
// 八、文字族像素基准（P3B 的 12 条）
//
// ⚠️ 测试强度分级（任务第三部分要求明确区分）：
//   [真实] = CDP Input.dispatchKeyEvent / Input.insertText
//   [派发] = DOM dispatchEvent 程序派发
//   [API]  = 直接调用内部 API
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const TEXT_KEYS = ['text', 't_title', 't_label', 't_unit', 't_big', 't_small',
    't_warn', 't_ok', 't_bigunit', 'box_h1', 'box_h2', 'box_note'];
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4b`,
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
      "if(all[i].getAttribute('data-path')===p&&all[i].getAttribute('data-role')!=='picker')return all[i];}return null;};");

    // ================= 一、12 个文字控件全部可识别 =================
    for (const k of TEXT_KEYS) {
      const r = JJ(await step('identify ' + k,
        "JSON.stringify((function(){var R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
        "var n=R.byLegacyKey(" + JSON.stringify(k) + ").build();" +
        "var s=SP.SchemaResolver.resolve(n);" +
        "return {isText:SP.SchemaResolver.isText(n),family:s?s.family:null," +
        "fields:s?s.fields.length:0,editable:s?s.editable.length:0};})())"));
      ok(r.isText === true, k + ' identified as text (persisted type === "text")');
      ok(r.family === 'text', k + ' resolves to text family');
      ok(r.fields === 7, k + ' schema has 7 fields (got ' + r.fields + ')');
      // P4F-04 演进：text 族补齐 w/h → 可编辑字段 5 → 7
      ok(r.editable === 7, k + ' exactly 7 editable fields after P4F-04 (got ' + r.editable + ')');
    }

    // 不依赖 __controlKey：重载后仍识别
    const reloadId = JJ(await step('identify after reload',
      "JSON.stringify((function(){var R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "var n=R.byLegacyKey('t_title').build();" +
      "var d=createDesign({name:'r'});d.nodes=[n];var back=parseDesign(toV2Json(d));" +
      "var rel=back.design.nodes[0];var s=SP.SchemaResolver.resolve(rel);" +
      "return {hasCtrlKey:!!rel.__controlKey,family:s?s.family:null,type:rel.type};})())"));
    ok(reloadId.hasCtrlKey === false, '__controlKey lost after reload');
    ok(reloadId.family === 'text', 'reloaded text still identified via type only');

    // ================= 二、Schema 分派规则 =================
    const dispatch = JJ(await step('schema dispatch',
      "JSON.stringify((function(){var R=ICAR.registry.Control,SP=ICAR.ui.schemaProps;" +
      "function maxOf(k){var n=R.byLegacyKey(k).build();var s=SP.SchemaResolver.resolve(n);" +
      "var f=s.fields.filter(function(x){return x.key==='font.size';})[0];return f?f.max:null;}" +
      "var tl=maxOf('t_label'),tt=maxOf('t_title');" +
      "var relText=R.byLegacyKey('t_label').build();" +
      "var d=createDesign({name:'x'});d.nodes=[relText];var back=parseDesign(toV2Json(d));" +
      "var srel=SP.SchemaResolver.resolve(back.design.nodes[0]);" +
      "var frel=srel.fields.filter(function(x){return x.key==='font.size';})[0];" +
      "return {tLabelMax:tl,tTitleMax:tt,reloadedTLabelMax:frel?frel.max:null};})())"));
    // ⚠️ P4B.1 统一了文字族字号上限：t_label 从 P1A 试点遗留的 200 改为 400
    //    （审计依据：旧属性面板 panels.js:980 的输入框只有 min="1"、无 max；
    //     normalizeFont 也只判 size > 0。200 是 P1A 占位值，从未生效。）
    //    所以现在三处应当**全部一致**为 400。
    ok(dispatch.tLabelMax === 400, 't_label font.size.max = 400 (P4B.1 unified, was 200)');
    ok(dispatch.tTitleMax === 400, 'other 11 use text-family schema (max=400)');
    ok(dispatch.reloadedTLabelMax === 400, 'reloaded t_label also 400 (consistent before/after save)');

    // 内容一致性：P4B.1 统一后 12 条 schema **结构完全相同**
    // （对象仍各自独立 —— t_label 由 t_label.js 定义，其余由 text-family.js 的工厂产出，
    //  所以这里比内容而不是比引用）
    const sameSig = await step('schema signatures equal',
      "String((function(){var R=ICAR.registry.Control;" +
      "return JSON.stringify(R.byLegacyKey('t_label').schema)===JSON.stringify(R.byLegacyKey('t_title').schema);})())");
    ok(sameSig === 'true', 't_label and t_title schema CONTENT is identical (P4B.1 unified)');

    // ================= 三、5 个字段安全编辑 =================
    // text：允许空字符串
    const emptyText = JJ(await step('text empty',
      "JSON.stringify((function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "return {empty:V.coerce({type:'string'},''),nullv:V.coerce({type:'string'},null)};})())"));
    ok(emptyText.empty.ok === true && emptyText.empty.value === '',
      'text allows empty string');

    // font.size：范围与非法值
    const sizeV = JJ(await step('font.size validation',
      "JSON.stringify((function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "var f={type:'number',min:1,max:400};" +
      "return {ok:V.coerce(f,'24'),nan:V.coerce(f,'NaN'),inf:V.coerce(f,'Infinity')," +
      "neg:V.coerce(f,'-5'),zero:V.coerce(f,'0'),over:V.coerce(f,'9999'),abc:V.coerce(f,'abc')};})())"));
    ok(sizeV.ok.ok === true && sizeV.ok.value === 24, 'font.size accepts valid number');
    ok(sizeV.nan.ok === false, 'font.size rejects NaN');
    ok(sizeV.inf.ok === false, 'font.size rejects Infinity');
    ok(sizeV.neg.ok === false, 'font.size rejects negative');
    ok(sizeV.zero.ok === false, 'font.size rejects 0 (min=1)');
    ok(sizeV.over.ok === false, 'font.size rejects above max');
    ok(sizeV.abc.ok === false, 'font.size rejects non-numeric');

    // font.weight：严格用 Registry 枚举 [400,500,600,700,900]
    const weightV = JJ(await step('font.weight enum',
      "JSON.stringify((function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "var R=ICAR.registry.Control;var def=R.byLegacyKey('t_title');" +
      "var f=def.schema.filter(function(x){return x.key==='font.weight';})[0];" +
      "return {values:f.values,ok400:V.coerce(f,'400'),ok900:V.coerce(f,'900')," +
      "bad300:V.coerce(f,'300'),bad800:V.coerce(f,'800'),bad750:V.coerce(f,'750')};})())"));
    ok(JSON.stringify(weightV.values) === '[400,500,600,700,900]',
      'font.weight enum comes from Registry: [400,500,600,700,900]');
    ok(weightV.ok400.ok === true && weightV.ok400.value === 400, 'font.weight accepts 400 (as number)');
    ok(weightV.ok900.ok === true, 'font.weight accepts 900');
    ok(weightV.bad300.ok === false, 'font.weight rejects 300 (not in Registry enum)');
    ok(weightV.bad800.ok === false, 'font.weight rejects 800 (not in Registry enum)');
    ok(weightV.bad750.ok === false, 'font.weight rejects 750');

    // font.color：三种合法形态
    const colorV = JJ(await step('font.color validation',
      "JSON.stringify((function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "var f={type:'color'};" +
      "return {hex6:V.coerce(f,'#8FA0B8'),hex3:V.coerce(f,'#abc'),ref:V.coerce(f,'$accent')," +
      "empty:V.coerce(f,''),bad:V.coerce(f,'red'),bad2:V.coerce(f,'#GGGGGG')};})())"));
    ok(colorV.hex6.ok === true && colorV.hex6.value === '#8FA0B8', 'color accepts #RRGGBB');
    ok(colorV.hex3.ok === true && colorV.hex3.value === '#AABBCC', 'color expands #RGB to #AABBCC');
    ok(colorV.ref.ok === true && colorV.ref.value === '$accent', 'color accepts $variable reference (kept as-is)');
    ok(colorV.empty.ok === true && colorV.empty.value === null, 'color empty → null');
    ok(colorV.bad.ok === false, 'color rejects "red"');
    ok(colorV.bad2.ok === false, 'color rejects "#GGGGGG"');

    // font.align：枚举来自 Registry
    const alignV = JJ(await step('font.align enum',
      "JSON.stringify((function(){var V=ICAR.ui.schemaProps.PropertyValidator;" +
      "var R=ICAR.registry.Control;var f=R.byLegacyKey('t_title').schema" +
      ".filter(function(x){return x.key==='font.align';})[0];" +
      "return {values:f.values,left:V.coerce(f,'left'),center:V.coerce(f,'center')," +
      "right:V.coerce(f,'right'),justify:V.coerce(f,'justify')};})())"));
    ok(JSON.stringify(alignV.values) === '["left","center","right"]',
      'font.align enum from Registry (left/center/right)');
    ok(alignV.left.ok && alignV.center.ok && alignV.right.ok, 'all 3 align values accepted');
    ok(alignV.justify.ok === false, 'unsupported align rejected');

    // ================= 四、真实键盘输入 =================
    // 准备一个文字节点并聚焦 text 输入框
    await cdp.eval("window.__prepT=function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "var n=R.byLegacyKey('t_title').build();" +
      "window.commit(function(){S.design.nodes=[n];S.selection=[n.id];},'prep');" +
      "if(window.onSelectionChanged)window.onSelectionChanged();return n.id;};");
    await cdp.eval("window.__prepT();");
    await sleep(300);

    // 4.1 Ctrl+A 全选 + 输入英文数字
    const kb1 = await (async () => {
      await cdp.eval("(function(){var e=" + inp('text') + ";if(e){e.focus();e.select();}})()");
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await cdp.send('Input.insertText', { text: 'Hello123' });
      await sleep(150);
      return JJ(await cdp.eval("(function(){var S=CanvasState;" +
        "var n=S.design.nodes[0];var e=" + inp('text') + ";" +
        "return JSON.stringify({model:n.text,input:e?e.value:null," +
        "selStart:e?e.selectionStart:null,selEnd:e?e.selectionEnd:null});})()"));
    })();
    ok(kb1.model === 'Hello123', '[真实] English+digits typed → model = Hello123 (got ' + kb1.model + ')');
    ok(kb1.selStart === 8, '[真实] caret at end after typing (got ' + kb1.selStart + ')');

    // 4.2 ArrowLeft 移动光标
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    await sleep(80);
    const caret = JJ(await cdp.eval("(function(){var e=" + inp('text') + ";" +
      "return JSON.stringify({start:e?e.selectionStart:null,end:e?e.selectionEnd:null});})()"));
    ok(caret.start === 7 && caret.end === 7, '[真实] ArrowLeft moves caret 8→7 (got ' + caret.start + ')');

    // 4.3 Shift+ArrowRight 选择部分文字
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 8, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 8, key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await sleep(80);
    const sel = JJ(await cdp.eval("(function(){var e=" + inp('text') + ";" +
      "return JSON.stringify({start:e?e.selectionStart:null,end:e?e.selectionEnd:null," +
      "sel:e?e.value.slice(e.selectionStart,e.selectionEnd):null});})()"));
    ok(sel.end > sel.start, '[真实] Shift+ArrowRight creates a selection (' + sel.start + '→' + sel.end + ')');

    // 4.4 删除所选文字
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(150);
    const del = JJ(await cdp.eval("(function(){var S=CanvasState;var n=S.design.nodes[0];" +
      "return JSON.stringify({model:n.text});})()"));
    ok(del.model === 'Hello12', '[真实] deleting selection removes one char (got ' + del.model + ')');

    // 4.5 Enter 提交
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(200);
    const enter = JJ(await cdp.eval("(function(){var S=CanvasState;var n=S.design.nodes[0];" +
      "return JSON.stringify({model:n.text});})()"));
    ok(enter.model === 'Hello12', '[真实] Enter commits without changing value');

    // 4.6 Escape 取消（自包含）
    const preEsc = JJ(await step('escape prep',
      "(function(){var S=CanvasState;var n=S.design.nodes[0];n.text='BASELINE';" +
      "if(window.refreshAll)window.refreshAll();" +
      "var e=window.__spInp('text');if(e){e.blur();}" +
      "return JSON.stringify({model:n.text});})()"));
    ok(preEsc.model === 'BASELINE', '[真实] escape baseline set');
    await sleep(100);
    await cdp.eval("(function(){var e=" + inp('text') + ";if(e){e.focus();e.select();}})()");
    await sleep(100);
    await cdp.send('Input.insertText', { text: 'WILL_BE_CANCELLED' });
    await sleep(180);
    const beforeEsc = JJ(await cdp.eval("(function(){var S=CanvasState;" +
      "return JSON.stringify({model:S.design.nodes[0].text});})()"));
    ok(beforeEsc.model === 'WILL_BE_CANCELLED', '[真实] typed before Escape (got ' + beforeEsc.model + ')');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
    const afterEsc = JJ(await cdp.eval("(function(){var S=CanvasState;var e=" + inp('text') + ";" +
      "return JSON.stringify({model:S.design.nodes[0].text,input:e?e.value:null});})()"));
    ok(afterEsc.model === 'BASELINE',
      '[真实] Escape reverts model to pre-edit value BASELINE (got ' + afterEsc.model + ')');

    // ================= 五、中文输入法 composition =================
    const imePrep = JJ(await step('ime prep',
      "(function(){var S=CanvasState;var n=S.design.nodes[0];n.text='DIFFTEST';" +
      "if(window.refreshAll)window.refreshAll();" +
      "var e=window.__spInp('text');if(e){e.value='DIFFTEST';}" +
      "return JSON.stringify({model:n.text,hasInput:!!e});})()"));
    ok(imePrep.model === 'DIFFTEST', '[派发] IME baseline set');
    await sleep(150);
    const IME_EXPR = "(function(){" +
      "var S=CanvasState;" +
      "var e=window.__spInp('text');" +
      "if(!e)return JSON.stringify({err:'no input'});" +
      "var before=S.design.nodes[0].text;" +
      "e.focus();e.select();" +
      "e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));" +
      "e.value='zhongwen';" +
      "e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "var during=S.design.nodes[0].text;" +
      "e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'zhongwen'}));" +
      "var after=S.design.nodes[0].text;" +
      "var comp=ICAR.ui.SchemaPanel.__composing();" +
      "return JSON.stringify({before:before,duringComposition:during," +
      "afterComposition:after,composing:comp,nodeCount:S.design.nodes.length});" +
      "})()";
    const imeRaw = await cdp.eval(IME_EXPR);
    const ime = imeRaw ? JSON.parse(imeRaw) : null;
    ok(ime !== null, '[派发] IME probe returned a result');
    if (ime) {
      ok(ime.nodeCount === 1, '[派发] IME test has exactly one text node (got ' + ime.nodeCount + ')');
      ok(ime.duringComposition === 'DIFFTEST',
        '[派发] during IME composition model NOT updated (still DIFFTEST, got ' + ime.duringComposition + ')');
      ok(ime.afterComposition !== 'DIFFTEST',
        '[派发] after compositionend model updates (got ' + ime.afterComposition + ')');
      ok(ime.composing === null, '[派发] composing flag cleared (got ' + ime.composing + ')');
    }

    // ================= 六、新旧面板同步 =================
    // 旧面板改 → 新面板同步
    const sync1 = JJ(await step('legacy -> schema',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;var n=S.design.nodes[0];" +
      "n.font.size=24;window.refreshAll();" +
      "var e=" + inp('font.size') + ";" +
      "return JSON.stringify({model:n.font.size,panel:e?e.value:null});})()"));
    ok(sync1.panel === '24', 'legacy edit → schema panel shows 24 (got ' + sync1.panel + ')');

    // 新面板改 → 模型同步
    const sync2 = JJ(await step('schema -> model',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;var e=" + inp('font.size') + ";" +
      "e.value='18';e.dispatchEvent(new Event('input',{bubbles:true}));" +
      "e.dispatchEvent(new Event('change',{bubbles:true}));" +
      "return JSON.stringify({model:S.design.nodes[0].font.size});})()"));
    ok(sync2.model === 18, 'schema panel edit updates model (got ' + sync2.model + ')');

    // 撤销同步
    const sync3 = JJ(await step('undo sync',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "window.doUndo();if(window.refreshAll)window.refreshAll();" +
      "var e=" + inp('font.size') + ";" +
      "return JSON.stringify({model:S.design.nodes[0].font.size,panel:e?e.value:null});})()"));
    ok(String(sync3.panel) === String(sync3.model), 'undo keeps panel and model in sync');

    // 保存重载后仍可编辑
    const roundtrip = JJ(await step('roundtrip',
      "(function(){var S=CanvasState,SP=ICAR.ui.schemaProps;" +
      "var back=parseDesign(toV2Json(S.design));" +
      "S.design=back.design;S.selection=[back.design.nodes[0].id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "return JSON.stringify({family:ICAR.ui.SchemaPanel.currentFamily()," +
      "inputs:box.querySelectorAll('input,select').length});})()"));
    ok(roundtrip.family === 'text', 'after save+reload still resolves text family');
    ok(roundtrip.inputs >= 5, 'after reload the 5 fields are editable again');

    // 多选 / 无选择
    const noSel = JJ(await step('no / multi select',
      "(function(){var S=CanvasState;S.selection=[];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "var box=document.getElementById('schemaProps');" +
      "var f1=ICAR.ui.SchemaPanel.currentFamily();" +
      "S.selection=[S.design.nodes[0].id,S.design.nodes[0].id];" +
      "if(window.onSelectionChanged)window.onSelectionChanged();" +
      "return JSON.stringify({noneFamily:f1,multiFamily:ICAR.ui.SchemaPanel.currentFamily()});})()"));
    ok(noSel.noneFamily === null, 'no selection → family null');
    ok(noSel.multiFamily === null, 'multi selection → family null');

    // ================= 七、历史字体技术债（P5B-M01 已还清）=================
    //
    // ⚠️ **这一节的行为在 P5B-M01 阶段 D 被有意改变**，不是放宽断言：
    //
    //   原来（P4B 时期）：box_h1/h2/note 源码字面写 size 30/20/12，但
    //   `presets.js` 传的是**扁平的 `fontSize`**，而 `createNode` 只读嵌套的 `o.font`
    //   → `normalizeFont(undefined)` 回落到 `FONT_DEFAULT.size = 6`。
    //   当时判定为"历史技术债，只读不修"，所以断言写死 `size === 6`。
    //
    //   P5B-M01 任务明确要求：「确认其默认 font 对象是否被错误归一化。**如属真实缺陷：
    //   修复创建路径。保证用户显式字体优先。**」
    //   → 已在 `model.js createNode` 的 NODE_TEXT 分支加扁平字段兼容。
    //
    //   所以现在断言**方向反转**：必须是预设声明的 30/20/12，不再是 6。
    //   `text` 本身没有预设字号（源码没给），仍应回落 6 —— 这条保持不变。
    const debt = JJ(await step('legacy font state',
      "JSON.stringify((function(){var R=ICAR.registry.Control;" +
      "function fontOf(k){var n=R.byLegacyKey(k).build();return {size:n.font.size,weight:n.font.weight};}" +
      "return {box_h1:fontOf('box_h1'),box_h2:fontOf('box_h2'),box_note:fontOf('box_note')," +
      "t_bigunit:fontOf('t_bigunit'),text:fontOf('text')};})())"));
    // D-01（P5B-M01 修复后）：box_* 应按预设声明取 30 / 20 / 12
    ok(debt.box_h1.size === 30, 'D-01 box_h1 size=30（预设声明值，P5B-M01 修复前是 6）');
    ok(debt.box_h2.size === 20, 'D-01 box_h2 size=20（预设声明值）');
    ok(debt.box_note.size === 12, 'D-01 box_note size=12（预设声明值）');
    ok(debt.t_bigunit.weight === 400, 'D-02 t_bigunit weight 仍为 400（未被本轮波及）');
    // `text` 预设源码也写了 `fontSize: 18` —— 修复后同样从 6 变成 18（与 box_* 同源问题）
    ok(debt.text.size === 18, 'D-03 text size=18（预设声明值，P5B-M01 修复前是 6）');

    // ================= 八、文字族像素基准 =================
    const pixBase = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, 'fixtures', 'p3b-text-pixel-hashes.json'), 'utf8'));
    const HASH = "function hash(n){var cv=document.createElement('canvas');cv.width=240;cv.height=240;" +
      "drawNodePreview(n,cv);var d=cv.getContext('2d').getImageData(0,0,240,240).data;" +
      "var h=2166136261>>>0;for(var i=0;i<d.length;i+=17){h^=d[i];h=Math.imul(h,16777619)>>>0;}" +
      "var nz=0;for(var i2=3;i2<d.length;i2+=4)if(d[i2]>0)nz++;return h.toString(16)+':'+nz;}";
    let pixOk = 0;
    for (const k of Object.keys(pixBase)) {
      const cur = await step('pixel ' + k,
        "(function(){" + HASH + "var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===" +
        JSON.stringify(k) + ";});return hash(c.make());})()");
      if (cur === pixBase[k]) pixOk++;
      else ok(false, 'pixel mismatch ' + k + ': ' + cur + ' vs ' + pixBase[k]);
    }
    ok(pixOk === 12, 'all 12 text controls pixel-identical to P3B baseline (got ' + pixOk + '/12)');

    // 改属性后重绘正常（字形变化）
    const redraw = JJ(await step('redraw after edit',
      "JSON.stringify((function(){var R=ICAR.registry.Control;" +
      HASH +
      "var n=R.byLegacyKey('t_big').build();var h0=hash(n);" +
      "n.font.size=40;var h1=hash(n);" +
      // ⚠️ t_big 默认 weight 已经是 900（粗），要改成 400 才看得出差别。
      //    渲染侧 fontShort 的判据是 weight >= 700 才算粗。
      "n.font.weight=400;var h2=hash(n);" +
      "n.font.color='#FF0000';var h3=hash(n);" +
      "n.font.align='left';var h4=hash(n);" +
      "n.text='AAA';var h5=hash(n);" +
      "return {sizeChanged:h0!==h1,weightChanged:h1!==h2,colorChanged:h2!==h3," +
      "alignChanged:h3!==h4,textChanged:h4!==h5};})())"));
    ok(redraw.sizeChanged === true, 'changing font.size actually redraws differently');
    ok(redraw.weightChanged === true, 'changing font.weight actually redraws differently');
    ok(redraw.colorChanged === true, 'changing font.color actually redraws differently');
    ok(redraw.alignChanged === true, 'changing font.align actually redraws differently');
    ok(redraw.textChanged === true, 'changing text actually redraws differently');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "return {entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "trackStillWorks:!!ICAR.ui.schemaProps.SchemaResolver.resolve({type:'image',trackStyle:{orient:'h'}})};})())"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69 (no new migrations)');
    ok(compat.trackStillWorks === true, 'track family still resolves (no regression)');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
