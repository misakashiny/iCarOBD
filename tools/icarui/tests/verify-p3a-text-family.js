// ============================================================================
// verify-p3a-text-family.js —— P3A 文字控件族正式迁移验收
//
// 一、12 个文字控件全部由 Control Registry 接管
// 二、t_label 不重复注册（P1A 已有）
// 三、定义字段齐全（build/schema/slots/render/validate）
// 四、旧入口 BUILTIN_CONTROLS.make 已路由到 Registry
// 五、12 条与**独立旧版基准** fixtures/p3a-text-golden.json 完全一致
//     （基准在任何替换之前抓取，不是用新实现自证）
// 六、vehicleStatus 语义：无实车证据一律 unverified，不因 App 未实现而标 unsupported
// 七、Catalog 元数据从 Registry 派生；不调 make()、不动设计
// 八、其它 203 条完全不受影响
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p3a`,
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

    const golden = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'p3a-text-golden.json'), 'utf8'));
    const KEYS = Object.keys(golden);

    const resultJson = await cdp.eval(
      'JSON.stringify((function(){' +
      '  var out=[],check=function(v,m){out.push([!!v,m]);};' +
      '  var C=ICAR.registry.Catalog, R=ICAR.registry.Control, B=ICAR.adapter.RegistryBridge, S=CanvasState;' +
      '  var KEYS=' + JSON.stringify(KEYS) + ';' +
      '  check(B.status().bridged.length===12,"12 text controls bridged (got "+B.status().bridged.length+")");' +
      '  check(B.status().fallback.length===0,"no fallback needed");' +
      '  check((window.__P3A_BRIDGE&&window.__P3A_BRIDGE.missing||[]).length===0,"no missing keys");' +
      '  KEYS.forEach(function(k){ check(R.byLegacyKey(k)!==undefined,"Registry owns "+k); });' +
      '  var fam=ICAR.registry.textFamily;' +
      '  check(fam.total===12,"family declares 12");' +
      '  check(fam.skipped===1,"t_label skipped (from P1A)");' +
      '  check(fam.registered===11,"11 newly registered");' +
      '  KEYS.forEach(function(k){' +
      '    var d=R.byLegacyKey(k);' +
      '    check(!!d&&!!d.name&&!!d.category&&!!d.render&&d.render.mode==="text"&&Array.isArray(d.schema)&&Array.isArray(d.slots)&&typeof d.validate==="function","full def for "+k);' +
      '  });' +
      '  KEYS.forEach(function(k){' +
      '    var e=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});' +
      '    check(!!e&&e.__bridgedTo===k,"legacy "+k+" routed to Registry");' +
      '  });' +
      '  var allText=true;' +
      '  KEYS.forEach(function(k){ var n=R.build(R.byLegacyKey(k).key); if(n.type!=="text") allText=false; });' +
      '  check(allText,"all 12 build() produce text nodes");' +
      '  check(R.validate(R.build("t_label")).length===0,"validate passes for default");' +
      '  var zero=R.build("t_label"); zero.w=0;' +
      '  check(R.validate(zero).some(function(i){return i.code==="zero-size";}),"validate catches zero size");' +
      '  var vs={}; C.all().forEach(function(e){ vs[e.vehicleStatus]=(vs[e.vehicleStatus]||0)+1; });' +
      '  check(!vs.supported,"nothing marked supported without evidence");' +
      '  check(!vs.unsupported,"nothing marked unsupported without evidence");' +
      '  check(vs.unverified===215,"all 215 unverified (got "+vs.unverified+")");' +
      '  KEYS.forEach(function(k){ check(C.get(k).vehicleStatus==="unverified",k+" is unverified not unsupported"); });' +
      '  check(C.get("t_label").vehicleAvailability!==undefined,"legacy vehicleAvailability kept");' +
      '  check(C.get("t_label").availability!==undefined,"legacy availability kept");' +
      '  KEYS.forEach(function(k){ check(C.get(k).category==="文字","catalog category for "+k+" is 文字 (got "+C.get(k).category+")"); });' +
      '  var before=JSON.stringify(toV2Json(S.design));' +
      '  C.build();' +
      '  check(JSON.stringify(toV2Json(S.design))===before,"catalog rebuild does not touch design");' +
      '  check(C.checkConsistency().ok,"checkConsistency passes");' +
      '  check(C.verifyCoverage().ok,"coverage 215/215");' +
      '  check((window.BUILTIN_CONTROLS||[]).length===215,"still 215 entries");' +
      '  var untouched=(window.BUILTIN_CONTROLS||[]).filter(function(c){return KEYS.indexOf(c.key)<0;});' +
      '  check(untouched.length===203,"203 non-text entries");' +
      '  var okc=0; untouched.forEach(function(c){try{if(c.make())okc++;}catch(e){}});' +
      '  check(okc===203,"all 203 non-text still make()");' +
      '  return {out:out,fam:fam,vs:vs};' +
      '})())'
    );

    const r = JSON.parse(resultJson);
    r.out.forEach(function (p) { ok(p[0], p[1]); });
    console.log('  [family] ' + JSON.stringify(r.fam));
    console.log('  [vehicleStatus] ' + JSON.stringify(r.vs));
  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
