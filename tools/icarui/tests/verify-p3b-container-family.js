// ============================================================================
// verify-p3b-container-family.js —— P3B 容器控件族迁移验收
//
// 一、4 个容器控件全部由 Control Registry 接管（累计 bridged 16）
// 二、与独立 Golden 基准 4/4 一致（基准在替换前抓取）
// 三、容器行为：空容器 / 加子节点 / 嵌套 / 位置 / 缩放旋转 / 图层 /
//     锁定可见性 / 撤销重做 / 保存重载
// 四、Catalog 三级来源统计：declared 8 / derived 16 / probe 191
// 五、vehicleStatus：静态控件用 n/a，有数据需求用 unverified
// 六、其余 211 条不受影响
//
// ⚠️ 本套件采用**分步 eval**（每步一次 cdp.eval）。
//    原因：一整段大 eval 里某个断言抛异常会让整个表达式中断，
//    错误只报 "Cannot read properties of undefined" 不指位置，排查成本极高。
//    分步后每一步独立成败、错误消息带步骤名。
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p3b`,
    '--window-size=1700,1050', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    cdp = await CDP.connect((await getJson('/json/list')).find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);
    await sleep(1500);

    const golden = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, 'fixtures', 'p3b-container-golden.json'), 'utf8'));
    const KEYS = Object.keys(golden);

    async function step(name, expr) {
      try {
        return await cdp.eval(expr);
      } catch (e) {
        ok(false, name + ' :: ' + String(e.message).slice(0, 160));
        return null;
      }
    }
    const J = (v) => JSON.stringify(v);
    const JJ = (v) => JSON.parse(v);

    // ---------------- 一、接管 ----------------
    const bridge = JJ(await step('bridge status', 'JSON.stringify(ICAR.adapter.RegistryBridge.status())'));
    // P3B 完成时是 16；P3C-1 又接管了 6 个仪表 → 22。
    // 这里只断言"至少包含本阶段该有的 16 条"，总数由最新阶段的套件守。
    ok(bridge.bridged.length >= 16, 'at least 16 bridged (got ' + bridge.bridged.length + ')');
    ok(KEYS.every(k => bridge.bridged.indexOf(k) >= 0), 'all 4 container keys bridged');
    ok(bridge.fallback.length === 0, 'no fallback');
    ok(bridge.total === 215, 'library still 215 entries');

    for (const k of KEYS) {
      const owned = await step('owns ' + k, 'String(ICAR.registry.Control.byLegacyKey(' + J(k) + ')!==undefined)');
      ok(owned === 'true', 'Registry owns ' + k);
    }

    const fam = JJ(await step('family', 'JSON.stringify(ICAR.registry.containerFamily)'));
    ok(fam.total === 4, 'container family declares 4');
    ok(fam.registered === 4, '4 registered by container-family');

    // ---------------- 二、定义完整 ----------------
    for (const k of KEYS) {
      const o = JJ(await step('def ' + k,
        'JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey(' + J(k) +
        ');return {n:!!d.name,c:!!d.category,rm:d.render&&d.render.mode,sc:Array.isArray(d.schema),sl:Array.isArray(d.slots),v:typeof d.validate};})())'));
      ok(o.n && o.c && o.rm === 'container' && o.sc && o.sl && o.v === 'function', 'full def for ' + k);
    }
    const allGroup = await step('node types',
      "String(['group','box_card','box_row','box_col'].every(function(k){return ICAR.registry.Control.build(k).type==='group';}))");
    ok(allGroup === 'true', 'all 4 build() produce group nodes');

    // ---------------- 三、与 Golden 一致 ----------------
    for (const k of KEYS) {
      const cur = JJ(await step('golden ' + k,
        'JSON.stringify((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) +
        ';});var n=window.nodeToJson(c.make());delete n.id;return n;})())'));
      ok(J(cur) === J(golden[k]), 'Golden match: ' + k);
    }

    // ---------------- 四、容器行为 ----------------
    const empty = JJ(await step('empty container',
      "JSON.stringify((function(){var g=ICAR.registry.Control.build('group');return {ch:(g.children||[]).length,w:g.w,h:g.h,ser:window.nodeToJson(g).children===undefined};})())"));
    ok(empty.ch === 0, 'empty container has no children');
    ok(empty.w > 0 && empty.h > 0, 'empty container has positive size');
    ok(empty.ser === true, 'empty children not serialized (model.js design)');

    const textChild = JJ(await step('text child',
      "JSON.stringify((function(){var g=ICAR.registry.Control.build('group');g.children=[window.createNode(window.NODE_TEXT,{name:'t',text:'X',x:0,y:0,w:50,h:20,z:1})];var j=window.nodeToJson(g);return {has:!!j.children,n:j.children?j.children.length:0,t:j.children?j.children[0].type:null,txt:j.children?j.children[0].text:null};})())"));
    ok(textChild.has && textChild.n === 1, 'container accepts text child');
    ok(textChild.t === 'text', 'child serialized as text');
    ok(textChild.txt === 'X', 'child text preserved');

    const imgChild = JJ(await step('image child',
      "JSON.stringify((function(){var g=ICAR.registry.Control.build('group');g.children=[window.createNode(window.NODE_IMAGE,{name:'i',x:0,y:0,w:30,h:30,z:1})];var j=window.nodeToJson(g);return {has:!!j.children,t:j.children?j.children[0].type:null};})())"));
    ok(imgChild.has && imgChild.t === 'image', 'container accepts image child');

    const nested = JJ(await step('nested',
      "JSON.stringify((function(){var R=ICAR.registry.Control;var o=R.build('box_card');var i2=R.build('box_row');i2.children=[window.createNode(window.NODE_TEXT,{name:'l',text:'L',x:0,y:0,w:10,h:10,z:1})];o.children=[i2];var j=window.nodeToJson(o);return {n:j.children?j.children.length:0,t:j.children?j.children[0].type:null,gc:(j.children&&j.children[0].children)?j.children[0].children[0].type:null};})())"));
    ok(nested.n === 1 && nested.t === 'group', 'nested: outer contains group');
    ok(nested.gc === 'text', 'nested: inner contains text');

    const moved = await step('parent move',
      "String((function(){var R=ICAR.registry.Control;var o=R.build('box_card');var i2=R.build('box_row');o.children=[i2];var px=i2.x,py=i2.y;o.x=200;o.y=150;return i2.x===px&&i2.y===py;})())");
    ok(moved === 'true', 'child local coords unaffected by parent move');

    const scaled = JJ(await step('scale rotation',
      "JSON.stringify((function(){var s=ICAR.registry.Control.build('box_col');s.scale=1.5;s.rotation=45;var j=window.nodeToJson(s);return {sc:j.scale,rot:j.rotation};})())"));
    ok(scaled.sc === 1.5, 'container scale persisted');
    ok(scaled.rot === 45, 'container rotation persisted');

    const layers = JJ(await step('layer z',
      "JSON.stringify((function(){var R=ICAR.registry.Control;var a=R.build('group'),b=R.build('box_card'),c=R.build('box_row');a.z=1;b.z=2;c.z=3;return [a.z,b.z,c.z];})())"));
    ok(J(layers) === '[1,2,3]', 'layer z assignable independently');

    const locked = JJ(await step('lock visible',
      "JSON.stringify((function(){var l=ICAR.registry.Control.build('group');l.locked=true;l.visible=false;var j=window.nodeToJson(l);return {lk:j.locked,vi:j.visible};})())"));
    ok(locked.lk === true, 'container locked persisted');
    ok(locked.vi === false, 'container visible=false persisted');

    const vDef = await step('validate default',
      "String(ICAR.registry.Control.validate(ICAR.registry.Control.build('group')).length===0)");
    ok(vDef === 'true', 'validate passes for default container');
    const vZero = await step('validate zero',
      "String((function(){var z=ICAR.registry.Control.build('group');z.w=0;return ICAR.registry.Control.validate(z).some(function(i){return i.code==='zero-size';});})())");
    ok(vZero === 'true', 'validate catches zero size');

    const rt = JJ(await step('roundtrip',
      "JSON.stringify((function(){var R=ICAR.registry.Control;var o=R.build('box_card');var i2=R.build('box_row');i2.children=[window.createNode(window.NODE_TEXT,{name:'l',text:'L',x:0,y:0,w:10,h:10,z:1})];o.children=[i2];var d=createDesign({name:'p3b'});d.nodes=[o];var b=parseDesign(toV2Json(d));var n0=b.design.nodes[0];var c0=n0.children?n0.children[0]:null;return {err:b.errors.length,n:b.design.nodes.length,ch:n0.children?n0.children.length:0,gc:(c0&&c0.children)?c0.children.length:0};})())"));
    ok(rt.err === 0, 'saved design parses clean');
    ok(rt.n === 1, 'reload keeps node count');
    ok(rt.ch === 1, 'reload keeps nested children');
    ok(rt.gc === 1, 'reload keeps grandchild');

    const ur = JJ(await step('undo redo',
      "JSON.stringify((function(){var R=ICAR.registry.Control,S=CanvasState;S.design=createDesign({name:'u'});S.design.nodes=[];if(window.refreshAll)window.refreshAll();var n0=S.design.nodes.length;window.commit(function(){S.design.nodes.push(R.build('box_card'));},'add');var a=S.design.nodes.length;window.doUndo();var b=S.design.nodes.length;window.doRedo();var c=S.design.nodes.length;return {n0:n0,a:a,b:b,c:c};})())"));
    ok(ur.a === ur.n0 + 1, 'add container increases node count');
    ok(ur.b !== ur.a, 'undo changes node count');
    ok(ur.c === ur.a, 'redo restores node count');

    // ---------------- 五、Catalog 三级来源 ----------------
    const src = JJ(await step('bySource', 'JSON.stringify(ICAR.registry.Catalog.stats().bySource)'));
    ok(src.declared === 8, 'declared 8 (got ' + src.declared + ')');
    // P3B 时 derived=16/probe=191；P3C-1 后为 22/185。
    // 断言"三级来源都存在且合计 215"，具体数字由 verify-p3c1 守。
    ok(src.derived >= 16, 'derived at least 16 (got ' + src.derived + ')');
    ok(src.probe > 0, 'probe still present (got ' + src.probe + ')');
    ok(src.declared + src.derived + src.probe === 215, 'three sources sum to 215');

    // ---------------- 六、vehicleStatus 语义 ----------------
    const dcvs = JJ(await step('dcvs',
      "JSON.stringify((function(){var m={};ICAR.registry.Catalog.all().forEach(function(e){var k=e.dataCapability+'/'+e.vehicleStatus;m[k]=(m[k]||0)+1;});return m;})())"));
    ok(!dcvs['none/unverified'], 'static controls never marked unverified');
    ok(dcvs['none/n/a'] > 0, 'static controls marked n/a');
    ok(!Object.keys(dcvs).some(k => /\/supported$|\/unsupported$/.test(k)), 'nothing supported/unsupported without evidence');
    ok(dcvs['bound/unverified'] > 0, 'bound controls are unverified');
    for (const k of KEYS) {
      const vs = await step('vs ' + k, 'String(ICAR.registry.Catalog.get(' + J(k) + ').vehicleStatus)');
      ok(vs === 'n/a', k + ' (container) is n/a');
    }
    const legacy = await step('legacy field',
      "String(ICAR.registry.Catalog.get('t_label').vehicleAvailability!==undefined)");
    ok(legacy === 'true', 'legacy vehicleAvailability field kept');

    // ---------------- 七、一致性 ----------------
    const cons = await step('consistency', 'String(ICAR.registry.Catalog.checkConsistency().ok)');
    ok(cons === 'true', 'checkConsistency passes');
    const cov = await step('coverage', 'String(ICAR.registry.Catalog.verifyCoverage().ok)');
    ok(cov === 'true', 'coverage 215/215');

    // ---------------- 八、其余 211 条不受影响 ----------------
    const others = JJ(await step('others make',
      'JSON.stringify((function(){var K=' + J(KEYS) +
      ';var others=(window.BUILTIN_CONTROLS||[]).filter(function(c){return K.indexOf(c.key)<0;});var okc=0,errs=[];others.forEach(function(c){try{if(c.make())okc++;else errs.push(c.key);}catch(e){errs.push(c.key);}});return {total:others.length,ok:okc,errs:errs.slice(0,5)};})())'));
    ok(others.total === 211, '211 non-container entries');
    ok(others.ok === 211, 'all 211 others still make() (fail=' + others.errs.length + ')');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
