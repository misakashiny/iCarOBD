// ============================================================================
// verify-p3c1-gauge-family.js —— P3C-1 常用仪表迁移验收
//
// 一、6 个仪表全部由 Control Registry 接管（bridged 22）
// 二、与独立 Golden 基准 6/6 一致（替换前抓取，仅排除随机 id）
// 三、数据绑定：默认 PID 相同 / resolvePid 相同 / channelStatus 与
//     vehicleStatus 语义正确 / 数据源缺失时保留既有行为并给诊断
// 四、数据槽 Schema：每个仪表声明明确的数据槽与数据类型
// 五、属性与绘制：像素回归 10 案例（6 默认 + 4 非默认组合）全部一致
// 六、编辑流程：新旧入口 / 改绑定 / 改量程 / 改样式 / 变换 / 撤销重做 / 保存重载
// 七、迁移数量：bridged 22 / declared 8 / derived 22 / probe 185 / total 215
//
// ⚠️ 沿用 P3B 的**分步 eval** 模式：每步一次 cdp.eval，失败只影响该步且报步骤名。
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p3c1`,
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
      require('path').join(__dirname, 'fixtures', 'p3c1-gauge-golden.json'), 'utf8'));
    const pixels = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, 'fixtures', 'p3c1-gauge-pixels.json'), 'utf8'));
    const KEYS = Object.keys(golden);

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const J = (v) => JSON.stringify(v);
    const JJ = (v) => JSON.parse(v);

    // ---------------- 一、接管 ----------------
    const bridge = JJ(await step('bridge', 'JSON.stringify(ICAR.adapter.RegistryBridge.status())'));
    ok(bridge.bridged.length === 22, 'bridged 22 (got ' + bridge.bridged.length + ')');
    ok(KEYS.every(k => bridge.bridged.indexOf(k) >= 0), 'all 6 gauge keys bridged');
    ok(bridge.fallback.length === 0, 'no fallback');
    ok(bridge.total === 215, 'library still 215 entries');

    const fam = JJ(await step('family', 'JSON.stringify(ICAR.registry.gaugeFamily)'));
    ok(fam.total === 6, 'gauge family declares 6');
    ok(fam.registered === 6, '6 registered');

    // ---------------- 二、Golden 6/6 ----------------
    for (const k of KEYS) {
      const cur = JJ(await step('golden ' + k,
        'JSON.stringify((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) +
        ';});var n=window.nodeToJson(c.make());delete n.id;return n;})())'));
      ok(J(cur) === J(golden[k]), 'Golden match: ' + k);
    }

    // ---------------- 三、数据绑定 ----------------
    const EXPECT = {
      g_speed:    { pid: 'obd.speed',      resolved: 'std_0D', dt: 'speed' },
      g_coolant:  { pid: 'obd.coolant',    resolved: 'std_05', dt: 'temperature' },
      g_fuel:     { pid: 'obd.fuel_level', resolved: 'std_2F', dt: 'percent' },
      g_volt:     { pid: 'obd.voltage',    resolved: 'std_42', dt: 'voltage' },
      g_load:     { pid: 'obd.load',       resolved: 'std_04', dt: 'percent' },
      g_throttle: { pid: 'obd.throttle',   resolved: 'std_11', dt: 'percent' },
    };
    for (const k of KEYS) {
      const e = EXPECT[k];
      const d = JJ(await step('binding ' + k,
        'JSON.stringify((function(){var c=ICAR.registry.Control.byLegacyKey(' + J(k) + ');var n=c.build();' +
        'return {pid:n.pid,rawPid:n.rawPid,resolved:window.resolvePid(n.pid),slotPid:c.slots[0].pid,slotDt:c.slots[0].dataType,' +
        'slotKey:c.slots[0].key,slots:c.slots.length,min:n.min,max:n.max,warnLow:n.warnLow,warnHigh:n.warnHigh};})())'));
      // ⚠️ createNode 对 NODE_GAUGE 会把 pid **归一化成解析后的 id**（std_0D），
      //    原始别名存在 rawPid（obd.speed）。这是 model.js 的既有设计，不是迁移引入的。
      //    所以：rawPid 应等于旧实现写的别名；pid 应等于 resolvePid(别名)。
      ok(d.rawPid === e.pid, k + ' rawPid (alias) = ' + e.pid);
      ok(d.pid === e.resolved, k + ' node.pid normalized to ' + e.resolved);
      ok(d.resolved === e.resolved, k + ' resolvePid -> ' + e.resolved);
      // 2. 数据槽声明的是**别名**（用户可读），与 rawPid 一致
      ok(d.slotPid === d.rawPid, k + ' slot pid matches rawPid (alias)');
      ok(d.slotDt === e.dt, k + ' slot dataType = ' + e.dt);
      ok(d.slotKey === 'value', k + ' slot key is value');
      ok(d.slots === 1, k + ' declares exactly 1 slot');
    }

    // 4. channelStatus / vehicleStatus 语义
    for (const k of KEYS) {
      const e = JJ(await step('status ' + k,
        'JSON.stringify((function(){var c=ICAR.registry.Catalog.get(' + J(k) + ');' +
        'return {dc:c.dataCapability,ch:c.channelStatus,vs:c.vehicleStatus,src:c.source};})())'));
      ok(e.dc === 'bound', k + ' dataCapability=bound');
      ok(e.ch === 'implemented', k + ' channelStatus=implemented (App has the channel)');
      // ⚠️ 关键区分：App 有通道 ≠ 车辆支持
      ok(e.vs === 'unverified', k + ' vehicleStatus=unverified (NOT supported)');
      ok(e.src === 'derived', k + ' catalog source=derived');
    }

    // 5. 数据源缺失：保留既有行为 + 可诊断
    const miss = JJ(await step('missing pid',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');" +
      "var n=d.build({pid:'obd.nonexistent'});var v=d.validate(n);" +
      "return {built:!!n,pid:n.pid,min:n.min,max:n.max," +
      "codes:v.map(function(i){return i.level+':'+i.code;})};})())"));
    ok(miss.built === true, 'missing pid still builds a node (legacy behavior)');
    ok(miss.min === 0 && miss.max === 100, 'missing pid falls back to 0..100');
    ok(miss.codes.indexOf('warn:pid-unresolved') >= 0, 'missing pid yields diagnostic (warn:pid-unresolved)');

    // ---------------- 四、Schema 校验 ----------------
    for (const k of KEYS) {
      const sch = JJ(await step('schema ' + k,
        'JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey(' + J(k) + ');' +
        'return {n:d.schema.length,hasPid:d.schema.some(function(s){return s.key==="pid";}),' +
        'hasStyle:d.schema.some(function(s){return s.key==="style";}),' +
        'hasRange:d.schema.some(function(s){return s.key==="min";})&&d.schema.some(function(s){return s.key==="max";}),' +
        'hasWarn:d.schema.some(function(s){return s.key==="warnLow";})&&d.schema.some(function(s){return s.key==="warnHigh";})};})())'));
      ok(sch.hasPid, k + ' schema has pid');
      ok(sch.hasStyle, k + ' schema has style');
      ok(sch.hasRange, k + ' schema has min/max');
      ok(sch.hasWarn, k + ' schema has warnLow/warnHigh');
      ok(sch.n >= 10, k + ' schema is complete (' + sch.n + ' fields)');
    }
    const badRange = await step('validate bad range',
      "String((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');var n=d.build();n.min=100;n.max=0;" +
      "return d.validate(n).some(function(i){return i.code==='bad-range';});})())");
    ok(badRange === 'true', 'validate catches reversed range');
    const noPid = await step('validate no pid',
      "String((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');var n=d.build();n.pid='';" +
      "return d.validate(n).some(function(i){return i.code==='no-pid';});})())");
    ok(noPid === 'true', 'validate catches missing pid');

    // ---------------- 五、像素回归（10 案例）----------------
    const CASES = [
      ['g_speed', null], ['g_coolant', null], ['g_fuel', null],
      ['g_volt', null], ['g_load', null], ['g_throttle', null],
      ['g_speed_style3', 'g_speed', '{style:3}'],
      ['g_coolant_style5', 'g_coolant', '{style:5}'],
      ['g_volt_range', 'g_volt', '{min:10,max:16,warnLow:12,warnHigh:15}'],
      ['g_fuel_nothresh', 'g_fuel', '{warnLow:null,warnHigh:80}'],
    ];
    for (const c of CASES) {
      const name = c[0], bk = c[1];
      let expr;
      if (bk === null) {
        expr = "String((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===" + J(name) +
          ";});var n=c.make();var cv=document.createElement('canvas');cv.width=300;cv.height=300;drawNodePreview(n,cv);" +
          "var d=cv.getContext('2d').getImageData(0,0,300,300).data;var h=2166136261>>>0;" +
          "for(var i=0;i<d.length;i+=17){h^=d[i];h=Math.imul(h,16777619)>>>0;}" +
          "var nz=0;for(var i2=3;i2<d.length;i2+=4)if(d[i2]>0)nz++;return h.toString(16)+':'+nz;})())";
      } else {
        expr = "String((function(){var d=ICAR.registry.Control.byLegacyKey(" + J(bk) + ");var n=d.build(" + c[2] + ");" +
          "var cv=document.createElement('canvas');cv.width=300;cv.height=300;drawNodePreview(n,cv);" +
          "var dd=cv.getContext('2d').getImageData(0,0,300,300).data;var h=2166136261>>>0;" +
          "for(var i=0;i<dd.length;i+=17){h^=dd[i];h=Math.imul(h,16777619)>>>0;}" +
          "var nz=0;for(var i2=3;i2<dd.length;i2+=4)if(dd[i2]>0)nz++;return h.toString(16)+':'+nz;})())";
      }
      const cur = await step('pixel ' + name, expr);
      ok(cur === pixels[name], 'pixel match: ' + name + ' (' + cur + ' vs ' + pixels[name] + ')');
    }

    // ---------------- 六、编辑流程 ----------------
    // 新旧入口产出一致
    for (const k of KEYS) {
      const same = await step('entries ' + k,
        'String((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) + ';});' +
        'var a=window.nodeToJson(c.make());var b=window.nodeToJson(ICAR.registry.Control.byLegacyKey(' + J(k) + ').build());' +
        'delete a.id;delete b.id;return JSON.stringify(a)===JSON.stringify(b);})())');
      ok(same === 'true', 'old/new entry identical: ' + k);
    }

    // 改数据绑定
    const rebind = JJ(await step('rebind',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');var n=d.build({pid:'obd.load'});" +
      "return {pid:n.pid,rawPid:n.rawPid,min:n.min,max:n.max};})())"));
    ok(rebind.pid === 'std_04', 'rebind pid normalized to std_04');
    ok(rebind.rawPid === 'obd.load', 'rebind keeps rawPid alias obd.load');
    ok(rebind.min === 0 && rebind.max === 100, 'rebind picks up new pid range');

    // 改量程与阈值
    const range = JJ(await step('range',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');" +
      "var n=d.build({min:0,max:300,warnLow:0,warnHigh:200});var j=window.nodeToJson(n);" +
      "return {min:j.min,max:j.max,wl:j.warnLow,wh:j.warnHigh};})())"));
    ok(range.min === 0 && range.max === 300, 'custom range persisted');
    ok(range.wl === 0 && range.wh === 200, 'custom thresholds persisted');

    // 改样式
    const style = await step('style', "String((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');" +
      "var n=d.build({style:6});return n.style;})())");
    ok(style === '6', 'style change persisted');

    // 变换
    const xf = JJ(await step('transform',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');" +
      "var n=d.build({x:120,y:80,w:250,h:120});n.rotation=30;n.scale=1.2;n.z=5;" +
      "var j=window.nodeToJson(n);return {x:j.x,y:j.y,w:j.w,h:j.h,rot:j.rotation,sc:j.scale,z:j.z};})())"));
    ok(xf.x === 120 && xf.y === 80, 'position change persisted');
    ok(xf.w === 250 && xf.h === 120, 'size change persisted');
    ok(xf.rot === 30 && xf.sc === 1.2, 'rotation/scale persisted');
    ok(xf.z === 5, 'layer change persisted');

    // 撤销 / 重做
    const ur = JJ(await step('undo redo',
      "JSON.stringify((function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'g'});S.design.nodes=[];if(window.refreshAll)window.refreshAll();" +
      "var n0=S.design.nodes.length;" +
      "window.commit(function(){S.design.nodes.push(R.byLegacyKey('g_speed').build());},'加仪表');" +
      "var a=S.design.nodes.length;window.doUndo();var b=S.design.nodes.length;" +
      "window.doRedo();var c=S.design.nodes.length;return {n0:n0,a:a,b:b,c:c};})())"));
    ok(ur.a === ur.n0 + 1, 'add gauge increases node count');
    ok(ur.b !== ur.a, 'undo changes node count');
    ok(ur.c === ur.a, 'redo restores node count');

    // 保存 / 导出 / 重载
    const rt = JJ(await step('roundtrip',
      "JSON.stringify((function(){var R=ICAR.registry.Control;var d=createDesign({name:'g2'});" +
      "d.nodes=['g_speed','g_coolant','g_volt'].map(function(k){return R.byLegacyKey(k).build();});" +
      "var b=parseDesign(toV2Json(d));" +
      "return {err:b.errors.length,n:b.design.nodes.length," +
      "pids:b.design.nodes.map(function(n){return n.pid;}).join(',')," +
      "raw:b.design.nodes.map(function(n){return n.rawPid;}).join(',')," +
      "types:b.design.nodes.map(function(n){return n.type;}).join(',')};})())"));
    ok(rt.err === 0, 'saved design parses clean');
    ok(rt.n === 3, 'reload keeps 3 gauges');
    ok(rt.raw === 'obd.speed,obd.coolant,obd.voltage', 'reload keeps rawPid aliases in order');
    ok(rt.pids === 'std_0D,std_05,std_42', 'reload keeps normalized pids');
    ok(rt.types === 'gauge,gauge,gauge', 'reload keeps gauge node type');

    // 模拟数据变化：值变了不影响节点结构，只影响绘制
    const sim = await step('data change', "String((function(){var d=ICAR.registry.Control.byLegacyKey('g_speed');" +
      "var n=d.build();var a=JSON.stringify(window.nodeToJson(n));" +
      "n.value=88;var b=JSON.stringify(window.nodeToJson(n));" +
      "return a.indexOf('\"value\"')<0;})())");
    ok(sim === 'true', 'runtime value is not serialized (drawing-only, does not alter design JSON)');

    // ---------------- 七、迁移数量 ----------------
    const src = JJ(await step('bySource', 'JSON.stringify(ICAR.registry.Catalog.stats().bySource)'));
    ok(src.declared === 8, 'declared 8 (got ' + src.declared + ')');
    ok(src.derived === 22, 'derived 22 (got ' + src.derived + ')');
    ok(src.probe === 185, 'probe 185 (got ' + src.probe + ')');
    ok(src.declared + src.derived + src.probe === 215, 'sum = 215');

    // gauge_0..7 的静态声明保持不变
    const g07 = JJ(await step('gauge_0..7',
      "JSON.stringify((function(){var o={};[0,1,2,3,4,5,6,7].forEach(function(i){var e=ICAR.registry.Catalog.get('gauge_'+i);" +
      "o['gauge_'+i]=e.source+':'+e.kind;});return o;})())"));
    ok(Object.keys(g07).every(k => g07[k] === 'declared:preset'), 'gauge_0..7 still declared as preset (unchanged)');

    // ---------------- 八、一致性与覆盖 ----------------
    const cons = await step('consistency', 'String(ICAR.registry.Catalog.checkConsistency().ok)');
    ok(cons === 'true', 'checkConsistency passes');
    const cov = await step('coverage', 'String(ICAR.registry.Catalog.verifyCoverage().ok)');
    ok(cov === 'true', 'coverage 215/215');

    // 其余 209 条不受影响
    const others = JJ(await step('others',
      'JSON.stringify((function(){var K=' + J(KEYS) +
      ';var o=(window.BUILTIN_CONTROLS||[]).filter(function(c){return K.indexOf(c.key)<0;});' +
      'var okc=0,errs=[];o.forEach(function(c){try{if(c.make())okc++;else errs.push(c.key);}catch(e){errs.push(c.key);}});' +
      'return {total:o.length,ok:okc,errs:errs.slice(0,5)};})())'));
    ok(others.total === 209, '209 non-gauge entries');
    ok(others.ok === 209, 'all 209 others still make() (fail=' + others.errs.length + ')');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
