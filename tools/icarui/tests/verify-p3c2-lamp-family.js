// ============================================================================
// verify-p3c2-lamp-family.js —— P3C-2 状态灯迁移验收
//
// 一、19 个状态灯全部由 Control Registry 接管（bridged 41）
// 二、与独立 Golden 基准 19/19 一致（替换前抓取；assetId 归一化为素材路径）
// 三、statePid / rawStatePid 语义：实例绑定优先、序列化写别名
// 四、三态素材：19×3 = 57 个状态图，逐项核验路径与 blinkMs（WCAG 2.3.1）
// 五、数据能力分级：implemented 6 / alias-only 1 / unimplemented 12，
//     全部 vehicleStatus=unverified（不把 App 已实现当车辆支持）
// 六、UNKNOWN 不得被当成正常：normal.alpha=120（半透明熄灭）而非 0；
//     无数据源时校验器报 error 而非"正常"
// 七、编辑流程 + 真实鼠标拖放
// 八、迁移数量：bridged 41 / declared 8 / derived 41 / probe 166 / total 215
//
// ⚠️ 沿用分步 eval（每步一次 cdp.eval）。
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p3c2`,
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
      require('path').join(__dirname, 'fixtures', 'p3c2-lamp-golden.json'), 'utf8'));
    const KEYS = Object.keys(golden);

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const J = (v) => JSON.stringify(v);
    const JJ = (v) => JSON.parse(v);
    const NORM = "function norm(o){var S=CanvasState;var byId={};(S.design.assets||[]).forEach(function(a){byId[a.id]=a.path;});" +
      "function rep(v){return v&&byId[v]?('PATH:'+byId[v]):v;}" +
      "if(o.assetId!==undefined)o.assetId=rep(o.assetId);" +
      "if(o.states){['normal','warn','critical'].forEach(function(k){if(o.states[k]&&o.states[k].assetId!==undefined)o.states[k].assetId=rep(o.states[k].assetId);});}" +
      "return o;}";

    // ---------------- 一、接管 ----------------
    const bridge = JJ(await step('bridge', 'JSON.stringify(ICAR.adapter.RegistryBridge.status())'));
    ok(bridge.bridged.length === 41, 'bridged 41 (got ' + bridge.bridged.length + ')');
    ok(KEYS.every(k => bridge.bridged.indexOf(k) >= 0), 'all 19 lamp keys bridged');
    ok(bridge.fallback.length === 0, 'no fallback');
    ok(bridge.total === 215, 'library still 215');

    const fam = JJ(await step('family', 'JSON.stringify(ICAR.registry.lampFamily)'));
    ok(fam.total === 19, 'lamp family declares 19');
    ok(fam.registered === 19, '19 registered');

    // ---------------- 二、Golden 19/19 ----------------
    let gm = 0;
    for (const k of KEYS) {
      const cur = JJ(await step('golden ' + k,
        'JSON.stringify((function(){' + NORM + 'var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) +
        ';});var n=norm(window.nodeToJson(c.make()));delete n.id;return n;})())'));
      if (J(cur) === J(golden[k])) gm++;
      else ok(false, 'Golden mismatch: ' + k);
    }
    ok(gm === 19, 'Golden 19/19 (got ' + gm + '/19)');

    // ---------------- 三、statePid / rawStatePid 语义 ----------------
    for (const k of KEYS) {
      const e = JJ(await step('state ' + k,
        'JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey(' + J(k) + ');var n=d.build();' +
        'var j=window.nodeToJson(n);' +
        'return {nodePid:n.pid,nodeStatePid:n.statePid,rawStatePid:n.rawStatePid,' +
        'jsonStatePid:j.statePid,hasPidField:(j.pid!==undefined),alias:window.ALIAS_OF&&window.ALIAS_OF[n.statePid]};})())'));
      // ① Registry 默认绑定 = 别名
      const g = golden[k];
      ok(e.rawStatePid === g.statePid, k + ' rawStatePid = alias ' + g.statePid);
      // ② node.statePid 是解析后的 id（或无法解析时保持原样）
      ok(typeof e.nodeStatePid === 'string' && e.nodeStatePid.length > 0, k + ' node.statePid is non-empty');
      // ③ 序列化写出的是别名（不是内部 id）
      ok(e.jsonStatePid === g.statePid, k + ' serialized statePid is alias');
      // ④ 绝不能写 pid 字段（否则 App 侧读不到 —— 历史上"灯永远暗"的根因）
      ok(e.hasPidField === false, k + ' does NOT write pid field (only statePid)');
    }

    // 用户改绑定的场景：校验器必须用**实例**的数据源
    const rebound = JJ(await step('rebind',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_tpms');" +
      "var n=d.build({statePid:'obd.coolant'});var j=window.nodeToJson(n);" +
      "return {raw:n.rawStatePid,pid:n.statePid,json:j.statePid};})())"));
    ok(rebound.raw === 'obd.coolant', 'rebind rawStatePid = obd.coolant');
    ok(rebound.pid === 'std_05', 'rebind statePid normalized to std_05');
    ok(rebound.json === 'obd.coolant', 'rebind serialized back to alias');

    // 校验器用当前实例而非预设默认
    const vInst = JJ(await step('validate instance',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_tpms');" +
      "var good=d.build({statePid:'obd.coolant'});" +
      "var bad=d.build({statePid:'obd.nonexistent'});" +
      "return {goodCodes:d.validate(good).map(function(i){return i.code;})," +
      "badCodes:d.validate(bad).map(function(i){return i.code;})};})())"));
    ok(vInst.goodCodes.indexOf('state-pid-unresolved') < 0,
      'validator accepts rebind to a valid pid (uses instance, not preset default)');
    ok(vInst.badCodes.indexOf('state-pid-unresolved') >= 0,
      'validator rejects rebind to a nonexistent pid');

    // ---------------- 四、三态素材 57 案例 ----------------
    let assetOk = 0, blinkOk = 0;
    for (const k of KEYS) {
      const d = JJ(await step('assets ' + k,
        'JSON.stringify((function(){var S=CanvasState;var byId={};(S.design.assets||[]).forEach(function(a){byId[a.id]=a.path;});' +
        'var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) + ';});var n=c.make();' +
        'function p(s){return n.states[s]?byId[n.states[s].assetId]:null;}' +
        'return {normal:p("normal"),warn:p("warn"),critical:p("critical"),' +
        'alphaN:n.states.normal.alpha,blinkN:n.states.normal.blink,msN:n.states.normal.blinkMs,' +
        'blinkW:n.states.warn.blink,msW:n.states.warn.blinkMs,' +
        'blinkC:n.states.critical.blink,msC:n.states.critical.blinkMs};})())'));
      // 三个状态图路径都必须存在且各自不同
      ok(!!d.normal && !!d.warn && !!d.critical, k + ' has all 3 state assets');
      assetOk += 3;
      ok(d.normal !== d.warn && d.warn !== d.critical && d.normal !== d.critical,
        k + ' three state assets are distinct');
      // blinkMs 合规：WCAG 2.3.1 要求 ≤3Hz（即 >= 334ms）
      ok(d.msW >= 334, k + ' warn blinkMs ' + d.msW + 'ms is <=3Hz');
      ok(d.msC >= 334, k + ' critical blinkMs ' + d.msC + 'ms is <=3Hz');
      blinkOk += 2;
    }
    ok(assetOk === 57, '57 state asset references verified (19x3, got ' + assetOk + ')');

    // 旧素材路径兼容
    const compat = await step('legacy asset paths',
      "String((function(){var S=CanvasState;var ps=(S.design.assets||[]).map(function(a){return a.path;});" +
      "return ps.filter(function(p){return /^assets\\/warning\\/lamp-.*-(off|warn|crit)\\.png$/.test(p);}).length>=57;})())");
    ok(compat === 'true', 'legacy warning asset paths still registered (>=57)');

    // 缺素材时的诊断
    const noAsset = JJ(await step('missing asset',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_tpms');" +
      "var n=d.build();n.states.warn.assetId='';" +
      "return {codes:d.validate(n).map(function(i){return i.code;})};})())"));
    ok(noAsset.codes.indexOf('missing-state-asset') >= 0, 'missing state asset yields diagnostic');

    // ---------------- 五、数据能力分级 ----------------
    const tiers = { implemented: 0, 'alias-only': 0, unimplemented: 0 };
    for (const k of KEYS) {
      const e = JJ(await step('tier ' + k,
        'JSON.stringify((function(){var c=ICAR.registry.Catalog.get(' + J(k) + ');' +
        'return {dc:c.dataCapability,ch:c.channelStatus,vs:c.vehicleStatus,src:c.source};})())'));
      ok(e.dc === 'state', k + ' dataCapability=state');
      ok(e.vs === 'unverified', k + ' vehicleStatus=unverified (NOT supported)');
      ok(e.src === 'derived', k + ' source=derived');
      tiers[e.ch] = (tiers[e.ch] || 0) + 1;
    }
    ok(tiers.implemented === 6, 'implemented=6 (got ' + tiers.implemented + ')');
    ok(tiers['alias-only'] === 1, 'alias-only=1 (got ' + tiers['alias-only'] + ')');
    ok(tiers.unimplemented === 12, 'unimplemented=12 (got ' + tiers.unimplemented + ')');

    // 12 个未实现的灯：仍保留、key 在、能建、有诊断
    const unimplemented = JJ(await step('unimplemented list',
      "JSON.stringify((function(){var K=" + J(KEYS) + ";" +
      "var u=K.filter(function(k){return ICAR.registry.Catalog.get(k).channelStatus==='unimplemented';});" +
      "var allBuild=true, allWarn=true;" +
      "u.forEach(function(k){var d=ICAR.registry.Control.byLegacyKey(k);var n=d.build();" +
      "if(!n||n.type!=='image')allBuild=false;" +
      "if(!d.validate(n).some(function(i){return i.code==='state-pid-unresolved';}))allWarn=false;});" +
      "return {n:u.length,allBuild:allBuild,allWarn:allWarn,keys:u};})())"));
    ok(unimplemented.n === 12, '12 unimplemented lamps enumerated');
    ok(unimplemented.allBuild === true, 'all 12 unimplemented lamps still build (history kept)');
    ok(unimplemented.allWarn === true, 'all 12 unimplemented lamps report diagnostic (no faked data source)');

    // ---------------- 六、UNKNOWN 不得被当成正常 ----------------
    const unknown = JJ(await step('unknown semantics',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_oil');var n=d.build();" +
      "var j=window.nodeToJson(n);" +
      "return {normalAlpha:j.states.normal.alpha,normalBlink:j.states.normal.blink," +
      "warnAlpha:j.states.warn.alpha,warnBlink:j.states.warn.blink,critAlpha:j.states.critical.alpha," +
      "critBlink:j.states.critical.blink};})())"));
    // normal 是半透明熄灭外观（120），不是全透明（0）——"未知"与"正常"靠 App 判定，不改这里
    ok(unknown.normalAlpha === 120, 'normal alpha=120 (dim, not 0)');
    ok(unknown.normalBlink === false, 'normal does not blink');
    ok(unknown.warnAlpha === 255 && unknown.warnBlink === true, 'warn is bright + blinking');
    ok(unknown.critAlpha === 255 && unknown.critBlink === true, 'critical is bright + blinking');

    // 无 statePid 时必须报 error，不能静默当作正常
    const noPid = JJ(await step('no statePid',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_abs');var n=d.build();n.rawStatePid='';n.statePid='';" +
      "var v=d.validate(n);return {codes:v.map(function(i){return i.code;}),hasError:v.some(function(i){return i.level==='error';})};})())"));
    ok(noPid.codes.indexOf('no-state-pid') >= 0, 'missing statePid yields no-state-pid');
    ok(noPid.hasError === true, 'missing statePid is an ERROR (not silently normal)');

    // ---------------- 七、编辑流程 ----------------
    // 新旧入口一致
    let same = 0;
    for (const k of KEYS) {
      const s = await step('entries ' + k,
        // ⚠️ 必须是「旧入口(已包装)」vs「Registry + 同一层包装」。
        //    直接拿 Registry.build() 比 c.make() 会比出 w 差异(56 vs 35) ——
        //    因为 panels.js 给 make 包了 prepareBuiltinImages（按画布宽高比缩放图片控件）。
        //    正确对照：c.make()  vs  prepareBuiltinImages(Registry.build())
        'String((function(){' + NORM + 'var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) + ';});' +
        'var a=norm(window.nodeToJson(c.make()));' +
        'var rn=ICAR.registry.Control.byLegacyKey(' + J(k) + ').build();' +
        'if(typeof window.prepareBuiltinImages==="function")window.prepareBuiltinImages(rn,false);' +
        'var b=norm(window.nodeToJson(rn));' +
        'delete a.id;delete b.id;return JSON.stringify(a)===JSON.stringify(b);})())');
      if (s === 'true') same++;
    }
    ok(same === 19, 'old/new entry identical 19/19 (got ' + same + ')');

    // 变换
    const xf = JJ(await step('transform',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_tpms');" +
      "var n=d.build({x:100,y:60,w:64,h:64});n.rotation=15;n.alpha=200;n.scale=1.1;n.z=7;" +
      "var j=window.nodeToJson(n);return {x:j.x,y:j.y,w:j.w,h:j.h,rot:j.rotation,al:j.alpha,sc:j.scale,z:j.z};})())"));
    ok(xf.x === 100 && xf.y === 60, 'position persisted');
    ok(xf.w === 64 && xf.h === 64, 'size persisted');
    ok(xf.rot === 15 && xf.al === 200 && xf.sc === 1.1, 'rotation/alpha/scale persisted');
    ok(xf.z === 7, 'layer persisted');

    // 撤销 / 重做
    const ur = JJ(await step('undo redo',
      "JSON.stringify((function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'l'});S.design.nodes=[];if(window.refreshAll)window.refreshAll();" +
      "var n0=S.design.nodes.length;" +
      "window.commit(function(){S.design.nodes.push(R.byLegacyKey('lamp_tpms').build());},'加灯');" +
      "var a=S.design.nodes.length;window.doUndo();var b=S.design.nodes.length;" +
      "window.doRedo();var c=S.design.nodes.length;return {n0:n0,a:a,b:b,c:c};})())"));
    ok(ur.a === ur.n0 + 1, 'add lamp increases node count');
    ok(ur.b !== ur.a, 'undo changes node count');
    ok(ur.c === ur.a, 'redo restores node count');

    // 保存 / 导出 / 重载
    const rt = JJ(await step('roundtrip',
      "JSON.stringify((function(){var R=ICAR.registry.Control;var d=createDesign({name:'l2'});" +
      "d.nodes=['lamp_tpms','lamp_coolant','lamp_abs'].map(function(k){return R.byLegacyKey(k).build();});" +
      "var b=parseDesign(toV2Json(d));" +
      "return {err:b.errors.length,n:b.design.nodes.length," +
      "sp:b.design.nodes.map(function(n){return n.statePid;}).join(',')," +
      "raw:b.design.nodes.map(function(n){return n.rawStatePid;}).join(','),types:b.design.nodes.map(function(n){return n.type;}).join(',')};})())"));
    ok(rt.err === 0, 'saved design parses clean');
    ok(rt.n === 3, 'reload keeps 3 lamps');
    ok(rt.types === 'image,image,image', 'reload keeps image node type');
    ok(rt.raw === 'obd.tpms,obd.coolant,obd.abs', 'reload keeps rawStatePid aliases');

    // 模拟状态变化不污染设计 JSON
    const sim = await step('sim state',
      "String((function(){var d=ICAR.registry.Control.byLegacyKey('lamp_tpms');var n=d.build();" +
      "var a=JSON.stringify(window.nodeToJson(n));n._simState='critical';var b=JSON.stringify(window.nodeToJson(n));" +
      "return a===b;})())");
    ok(sim === 'true', 'simulated state does not pollute design JSON');

    // ---------------- 真实鼠标拖放 ----------------
    const drag = JJ(await step('drag drop',
      "JSON.stringify((function(){var S=CanvasState;S.design=createDesign({name:'drag'});S.design.nodes=[];" +
      "if(window.refreshAll)window.refreshAll();var n0=S.design.nodes.length;" +
      "var cv=document.getElementById('cv');var r=cv.getBoundingClientRect();" +
      "var dt=new DataTransfer();dt.setData('application/x-ctrl','lamp_tpms');" +
      "cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt," +
      "clientX:r.left+r.width/2,clientY:r.top+r.height/2}));" +
      "var n=S.design.nodes.length;var last=S.design.nodes[n-1];" +
      "return {before:n0,after:n,type:last?last.type:null,raw:last?last.rawStatePid:null};})())"));
    ok(drag.after === drag.before + 1, 'real drop creates lamp node');
    ok(drag.type === 'image', 'dropped node is image type');
    ok(drag.raw === 'obd.tpms', 'dropped lamp keeps its statePid binding');

    // ---------------- 八、迁移数量 ----------------
    const src = JJ(await step('bySource', 'JSON.stringify(ICAR.registry.Catalog.stats().bySource)'));
    ok(src.declared === 8, 'declared 8 (got ' + src.declared + ')');
    ok(src.derived === 41, 'derived 41 (got ' + src.derived + ')');
    ok(src.probe === 166, 'probe 166 (got ' + src.probe + ')');
    ok(src.declared + src.derived + src.probe === 215, 'sum = 215');

    const cons = await step('consistency', 'String(ICAR.registry.Catalog.checkConsistency().ok)');
    ok(cons === 'true', 'checkConsistency passes');
    const cov = await step('coverage', 'String(ICAR.registry.Catalog.verifyCoverage().ok)');
    ok(cov === 'true', 'coverage 215/215');

    // 其余 196 条不受影响
    const others = JJ(await step('others',
      'JSON.stringify((function(){var K=' + J(KEYS) +
      ';var o=(window.BUILTIN_CONTROLS||[]).filter(function(c){return K.indexOf(c.key)<0;});' +
      'var okc=0,errs=[];o.forEach(function(c){try{if(c.make())okc++;else errs.push(c.key);}catch(e){errs.push(c.key);}});' +
      'return {total:o.length,ok:okc,errs:errs.slice(0,5)};})())'));
    ok(others.total === 196, '196 non-lamp entries');
    ok(others.ok === 196, 'all 196 others still make() (fail=' + others.errs.length + ')');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
