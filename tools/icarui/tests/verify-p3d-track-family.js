// ============================================================================
// verify-p3d-track-family.js —— P3D 代码轨道族迁移验收
//
// 一、28 条 cd_* 全部由 Control Registry 接管（bridged 69）
// 二、与独立 Golden 28/28 一致（替换前抓取）
// 三、参数化架构：9 个参数 × 28 条 key，共享工厂 buildTrack
// 四、NODE_IMAGE 包装链：28/28 都是 NODE_IMAGE；尺寸语义已厘清；顺序守卫生效
// 五、trackStyle 语义：null 旧行为 / 代码轨道分支 / 各参数默认值
// 六、像素回归 43 案例（28 默认 + 12 自定义 + 2 bar_* + 1 null）
// 七、浏览器交互：新旧入口 / 真实拖拽 / 变换 / 撤销重做 / 保存重载
// 八、迁移数量：bridged 69 / declared 8 / derived 69 / probe 138 / total 215
// 九、bar_* 完全不受影响
//
// ⚠️ 沿用分步 eval（每步一次 cdp.eval）。
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p3d`,
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
      require('path').join(__dirname, 'fixtures', 'p3d-track-golden.json'), 'utf8'));
    const pixels = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, 'fixtures', 'p3d-track-pixels.json'), 'utf8'));
    const KEYS = Object.keys(golden);

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const J = (v) => JSON.stringify(v);
    const JJ = (v) => JSON.parse(v);
    const HASH = "function hash(n){var cv=document.createElement('canvas');cv.width=320;cv.height=320;drawNodePreview(n,cv);" +
      "var d=cv.getContext('2d').getImageData(0,0,320,320).data;var h=2166136261>>>0;" +
      "for(var i=0;i<d.length;i+=17){h^=d[i];h=Math.imul(h,16777619)>>>0;}" +
      "var nz=0;for(var i2=3;i2<d.length;i2+=4)if(d[i2]>0)nz++;return h.toString(16)+':'+nz;}";
    const MK = "function mk(k,patch){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});" +
      "var n=c.make();if(patch)Object.assign(n.trackStyle,patch);return n;}";

    // ---------------- 一、接管 ----------------
    const bridge = JJ(await step('bridge', 'JSON.stringify(ICAR.adapter.RegistryBridge.status())'));
    ok(bridge.bridged.length === 69, 'bridged 69 (got ' + bridge.bridged.length + ')');
    ok(KEYS.every(k => bridge.bridged.indexOf(k) >= 0), 'all 28 track keys bridged');
    ok(KEYS.length === 28, '28 track keys in golden');
    ok(bridge.fallback.length === 0, 'no fallback');
    ok(bridge.total === 215, 'library still 215');

    const fam = JJ(await step('family', 'JSON.stringify(ICAR.registry.trackFamily)'));
    ok(fam.total === 28, 'track family declares 28');
    ok(fam.registered === 28, '28 registered');

    // ---------------- 二、Golden 28/28 ----------------
    let gm = 0;
    for (const k of KEYS) {
      const cur = JJ(await step('golden ' + k,
        'JSON.stringify((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) +
        ';});var n=window.nodeToJson(c.make());delete n.id;return n;})())'));
      if (J(cur) === J(golden[k])) gm++;
      else ok(false, 'Golden mismatch: ' + k);
    }
    ok(gm === 28, 'Golden 28/28 (got ' + gm + '/28)');

    // ---------------- 三、参数化架构 ----------------
    const params = JJ(await step('params',
      'JSON.stringify((function(){var K=' + J(KEYS) + ';var o={orient:{},gradient:{},segments:{},ticks:{},band:{},glow:{},inset:{},fill:{}};' +
      'K.forEach(function(k){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});var ts=c.make().trackStyle;' +
      'o.orient[ts.orient]=(o.orient[ts.orient]||0)+1;' +
      'o.gradient[String(ts.gradient)]=(o.gradient[String(ts.gradient)]||0)+1;' +
      'o.segments[ts.segments]=(o.segments[ts.segments]||0)+1;' +
      'o.ticks[ts.ticks]=(o.ticks[ts.ticks]||0)+1;' +
      'o.band[ts.band]=(o.band[ts.band]||0)+1;o.glow[ts.glow]=(o.glow[ts.glow]||0)+1;' +
      'o.inset[ts.inset]=(o.inset[ts.inset]||0)+1;o.fill[String(ts.fill)]=(o.fill[String(ts.fill)]||0)+1;});' +
      'return o;})())'));
    ok(params.orient.h === 14 && params.orient.v === 14, 'orient: 14 h + 14 v');
    ok(params.gradient.gloss === 2 && params.gradient.fade === 2, 'gradient: 2 gloss + 2 fade');
    ok(params.segments['5'] === 2 && params.segments['10'] === 2 && params.segments['20'] === 2, 'segments: 5/10/20 each x2');
    ok(params.ticks['10'] === 2, 'ticks: 10 x2');
    ok(params.band.true === 2, 'band: 2');
    ok(params.inset.true === 2, 'inset: 2');

    // 共享工厂：所有 28 条都产 NODE_IMAGE
    const allImg = await step('all image',
      "String(" + J(KEYS) + ".every(function(k){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});return c.make().type===window.NODE_IMAGE;}))");
    ok(allImg === 'true', 'all 28 produce NODE_IMAGE');
    // assetId 必须留空（否则走图片分支）
    const allEmpty = await step('assetId empty',
      "String(" + J(KEYS) + ".every(function(k){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});return c.make().assetId==='';}))");
    ok(allEmpty === 'true', 'all 28 have empty assetId (code-drawn branch)');
    // z 必须是 97（不是 99）
    const allZ = await step('z 97',
      "String(" + J(KEYS) + ".every(function(k){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});return c.make().z===97;}))");
    ok(allZ === 'true', 'all 28 have z=97 (legacy value)');

    // ---------------- 四、NODE_IMAGE 包装链 ----------------
    // 旧入口（make）= 已包装；Registry.build = 原始尺寸
    const sem = JJ(await step('size semantics',
      "JSON.stringify((function(){var cv=CanvasState.design.canvas;var ratio=cv.designH/cv.designW;" +
      "var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key==='cd_trackh';});" +
      "var viaMake=c.make();var viaBuild=ICAR.registry.Control.byLegacyKey('cd_trackh').build();" +
      "return {ratio:ratio,makeW:viaMake.w,buildW:viaBuild.w,rawW:240," +
      "packedOnce:Math.abs(viaMake.w-240*ratio)<0.01,raw:viaBuild.w===240};})())"));
    ok(sem.makeW === 240 * sem.ratio, 'legacy make() width = 240 x ratio (packed once)');
    ok(sem.buildW === 240, 'Registry.build() returns raw design width 240');
    ok(sem.ratio > 0 && sem.ratio < 1, 'canvas ratio is applied (' + sem.ratio.toFixed(4) + ')');

    // 关键：包装只发生一次（不能是 ratio²）
    const notDouble = await step('not double packed',
      "String(Math.abs((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key==='cd_trackh';});" +
      "var cv=CanvasState.design.canvas;var r=cv.designH/cv.designW;return c.make().w-240*r;})())<0.01)");
    ok(notDouble === 'true', 'prepareBuiltinImages applied exactly once (not squared)');

    // 顺序守卫必须通过
    const guard = await step('order guard', 'String(window.__ICAR_ORDER_GUARD_FAILED)');
    ok(guard === 'null', 'startup order guard passed (no failure recorded)');

    // ---------------- 五、trackStyle 语义 ----------------
    const tsNull = JJ(await step('trackStyle null',
      "JSON.stringify((function(){var e=window.ensureBuiltinAsset('assets/bar/track-h.png');" +
      "var n=window.createNode(window.NODE_IMAGE,{name:'t',assetId:e,x:40,y:40,w:150,h:16,z:97});" +
      "return {ts:n.trackStyle,usable:window.trackUsable(n.trackStyle)};})())"));
    ok(tsNull.ts === null, 'trackStyle defaults to null (legacy image behavior)');
    ok(tsNull.usable === false, 'trackUsable(null) is false (falls back to image)');

    // 各参数默认值（抽查 3 条）
    const defaults = JJ(await step('track defaults',
      "JSON.stringify((function(){function g(k){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});return c.make().trackStyle;}" +
      "return {trackh:g('cd_trackh'),seg5:g('cd_seg5h'),cursor:g('cd_cursorh')};})())"));
    ok(defaults.trackh.radius === 8, 'cd_trackh default radius=8 (computed from short side)');
    ok(defaults.trackh.segments === 0 && defaults.trackh.ticks === 0, 'cd_trackh no segments/ticks');
    ok(defaults.seg5.segments === 5, 'cd_seg5h segments=5');
    ok(defaults.cursor.glow === true && defaults.cursor.radius === 2 && defaults.cursor.fill === 1,
      'cd_cursorh glow+radius2+fill1');

    // 校验器
    const val = JJ(await step('validate',
      // ⚠️ 不能用 build({orient:'x'}) 造坏值 —— createNode 里 normalizeTrackStyle()
      //    会把非法 orient 归一成 'h'（既有防护，好事）。要绕过它只能建好后直接改字段。
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('cd_trackh');" +
      "var good=d.validate(d.build());var bad=d.build();bad.trackStyle.orient='x';" +
      "return {good:good.map(function(i){return i.code;}),bad:d.validate(bad).map(function(i){return i.code;})};})())"));
    ok(val.good.length === 0, 'validate passes for default track');
    ok(val.bad.indexOf('bad-orient') >= 0, 'validate catches bad orient');

    // ---------------- 六、像素回归 43 案例 ----------------
    let px = 0;
    for (const name of Object.keys(pixels)) {
      let expr;
      if (name.indexOf('custom_') === 0) {
        const m = { custom_h_fill: ["cd_fillh", "{fill:0.3}"], custom_v_fill: ["cd_fillv", "{fill:0.85}"],
          custom_seg3: ["cd_seg5h", "{segments:3}"], custom_seg16: ["cd_seg10h", "{segments:16}"],
          custom_gloss: ["cd_trackgradh", "{gradient:'gloss'}"], custom_fade: ["cd_trackh", "{gradient:'fade'}"],
          custom_glow_on: ["cd_trackh", "{glow:true}"], custom_ticks4: ["cd_trackticksh", "{ticks:4}"],
          custom_ticks20: ["cd_trackticksh", "{ticks:20}"], custom_band_off: ["cd_band3h", "{band:false}"],
          custom_inset_off: ["cd_trackinseth", "{inset:false}"], custom_radius0: ["cd_trackh", "{radius:0}"] }[name];
        expr = "(function(){" + HASH + MK + "return hash(mk(" + J(m[0]) + "," + m[1] + "));})()";
      } else if (name === 'null_trackstyle') {
        expr = "(function(){" + HASH + "var e=window.ensureBuiltinAsset('assets/bar/track-h.png');" +
          "var n=window.createNode(window.NODE_IMAGE,{name:'t',assetId:e,x:40,y:40,w:150,h:16,z:97});" +
          "n.trackStyle=null;return hash(n);})()";
      } else {
        expr = "(function(){" + HASH + MK + "return hash(mk(" + J(name) + "));})()";
      }
      const cur = await step('pixel ' + name, expr);
      if (cur === pixels[name]) px++;
      else ok(false, 'pixel mismatch: ' + name + ' (' + cur + ' vs ' + pixels[name] + ')');
    }
    ok(px === 43, 'pixel match 43/43 (got ' + px + '/43)');

    // ---------------- 七、浏览器交互 ----------------
    // 新旧入口一致（同一路径：make 已包装，build+包装等价）
    let same = 0;
    for (const k of KEYS) {
      const s = await step('entries ' + k,
        'String((function(){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===' + J(k) + ';});' +
        'var a=window.nodeToJson(c.make());delete a.id;' +
        'var rn=ICAR.registry.Control.byLegacyKey(' + J(k) + ').build();' +
        'if(typeof window.prepareBuiltinImages==="function")window.prepareBuiltinImages(rn,false);' +
        'var b=window.nodeToJson(rn);delete b.id;' +
        'return JSON.stringify(a)===JSON.stringify(b);})())');
      if (s === 'true') same++;
    }
    ok(same === 28, 'old/new entry identical 28/28 (got ' + same + ')');

    // 变换
    const xf = JJ(await step('transform',
      "JSON.stringify((function(){var d=ICAR.registry.Control.byLegacyKey('cd_trackh');" +
      "var n=d.build({x:60,y:90,w:300,h:20});n.rotation=10;n.alpha=180;n.scale=1.3;n.z=3;" +
      "var j=window.nodeToJson(n);return {x:j.x,y:j.y,w:j.w,h:j.h,rot:j.rotation,al:j.alpha,sc:j.scale,z:j.z};})())"));
    ok(xf.x === 60 && xf.y === 90, 'position persisted');
    ok(xf.w === 300 && xf.h === 20, 'size persisted');
    ok(xf.rot === 10 && xf.al === 180 && xf.sc === 1.3, 'rotation/alpha/scale persisted');
    ok(xf.z === 3, 'layer persisted');

    // 真实拖拽（dragstart → dragover → drop 全链路）
    const drag = JJ(await step('drag chain',
      "JSON.stringify((function(){var S=CanvasState;S.design=createDesign({name:'trk'});S.design.nodes=[];" +
      "if(window.refreshAll)window.refreshAll();var n0=S.design.nodes.length;" +
      "var cv=document.getElementById('cv');var r=cv.getBoundingClientRect();" +
      "var dt=new DataTransfer();" +
      "dt.setData('application/x-ctrl','cd_seg5h');" +
      "var over=cv.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt," +
      "clientX:r.left+r.width/2,clientY:r.top+r.height/2}));" +
      "cv.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt," +
      "clientX:r.left+r.width/2,clientY:r.top+r.height/2}));" +
      "var n=S.design.nodes.length;var last=S.design.nodes[n-1];" +
      "return {before:n0,after:n,type:last?last.type:null," +
      "ts:last&&last.trackStyle?last.trackStyle.segments:null,assetId:last?last.assetId:null};})())"));
    ok(drag.after === drag.before + 1, 'real dragover+drop creates track node');
    ok(drag.type === 'image', 'dropped node is image type');
    ok(drag.ts === 5, 'dropped track keeps segments=5');
    ok(drag.assetId === '', 'dropped track has empty assetId');

    // 撤销 / 重做
    const ur = JJ(await step('undo redo',
      // ⚠️ UndoStack 的**首次 commit 是基准**：一次 commit 后 undo 会回到"有 1 个节点"，
      //    看起来像没退。要观察到变化必须 commit 两次（实测：一次 a=1,b=1；两次 a=2,b=1）。
      "JSON.stringify((function(){var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'u'});S.design.nodes=[];if(window.refreshAll)window.refreshAll();" +
      "var n0=S.design.nodes.length;" +
      "window.commit(function(){S.design.nodes.push(R.byLegacyKey('cd_trackh').build());},'加轨道1');" +
      "window.commit(function(){S.design.nodes.push(R.byLegacyKey('cd_seg5h').build());},'加轨道2');" +
      "var a=S.design.nodes.length;window.doUndo();var b=S.design.nodes.length;" +
      "window.doRedo();var c=S.design.nodes.length;return {n0:n0,a:a,b:b,c:c};})())"));
    ok(ur.a === ur.n0 + 2, 'two commits add two tracks');
    // ⚠️ undo 后的节点数不一定是 0 —— UndoStack 恢复到快照，n0 之前可能有历史。
    //    判据只要求"发生了变化"，再加一条"redo 能回到撤销前"。
    ok(ur.b === ur.a - 1, 'undo steps back exactly one node');
    ok(ur.c === ur.a, 'redo restores node count');

    // 保存 / 导出 / 重载
    const rt = JJ(await step('roundtrip',
      "JSON.stringify((function(){var R=ICAR.registry.Control;var d=createDesign({name:'t2'});" +
      "d.nodes=['cd_trackh','cd_seg5v','cd_cursorh'].map(function(k){return R.byLegacyKey(k).build();});" +
      "var b=parseDesign(toV2Json(d));" +
      "return {err:b.errors.length,n:b.design.nodes.length," +
      "orient:b.design.nodes.map(function(n){return n.trackStyle.orient;}).join(',')," +
      "seg:b.design.nodes.map(function(n){return n.trackStyle.segments;}).join(','),types:b.design.nodes.map(function(n){return n.type;}).join(',')};})())"));
    ok(rt.err === 0, 'saved design parses clean');
    ok(rt.n === 3, 'reload keeps 3 tracks');
    ok(rt.orient === 'h,v,h', 'reload keeps orient in order');
    ok(rt.seg === '0,5,0', 'reload keeps segments');
    ok(rt.types === 'image,image,image', 'reload keeps image type');

    // 切换分类不改变设计
    const tab = await step('tab no change',
      "String((function(){var S=CanvasState;var before=JSON.stringify(S.design.nodes);" +
      "var P=ICAR.ui.CatalogPanel;if(P){P.setTab('asset');P.setTab('control');}" +
      "return before===JSON.stringify(S.design.nodes);})())");
    ok(tab === 'true', 'switching catalog tabs does not modify design');

    // ---------------- 八、迁移数量 ----------------
    const src = JJ(await step('bySource', 'JSON.stringify(ICAR.registry.Catalog.stats().bySource)'));
    ok(src.declared === 8, 'declared 8 (got ' + src.declared + ')');
    ok(src.derived === 69, 'derived 69 (got ' + src.derived + ')');
    ok(src.probe === 138, 'probe 138 (got ' + src.probe + ')');
    ok(src.declared + src.derived + src.probe === 215, 'sum = 215');

    const cons = await step('consistency', 'String(ICAR.registry.Catalog.checkConsistency().ok)');
    ok(cons === 'true', 'checkConsistency passes');
    const cov = await step('coverage', 'String(ICAR.registry.Catalog.verifyCoverage().ok)');
    ok(cov === 'true', 'coverage 215/215');

    // ---------------- 九、bar_* 不受影响 ----------------
    const bars = JJ(await step('bar_*',
      "JSON.stringify((function(){var out={};['bar_trackh','bar_trackv'].forEach(function(k){" +
      "var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===k;});" +
      "var n=c.make();out[k]={type:n.type,assetId:n.assetId,ts:n.trackStyle,w:n.w};});" +
      "return out;})())"));
    for (const k of Object.keys(bars)) {
      ok(bars[k].type === 'image', k + ' is still image');
      ok(!!bars[k].assetId, k + ' still has assetId (image track, not migrated)');
      ok(bars[k].ts === null, k + ' still has null trackStyle');
    }
    const barBridged = await step('bar not bridged',
      "String(JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status())).bridged.indexOf('bar_trackh')<0)");
    ok(barBridged === 'true', 'bar_* NOT bridged (out of scope)');

    // 其余 187 条不受影响（215 - 28）
    const others = JJ(await step('others',
      'JSON.stringify((function(){var K=' + J(KEYS) +
      ';var o=(window.BUILTIN_CONTROLS||[]).filter(function(c){return K.indexOf(c.key)<0;});' +
      'var okc=0,errs=[];o.forEach(function(c){try{if(c.make())okc++;else errs.push(c.key);}catch(e){errs.push(c.key);}});' +
      'return {total:o.length,ok:okc,errs:errs.slice(0,5)};})())'));
    ok(others.total === 187, '187 non-track entries');
    ok(others.ok === 187, 'all 187 others still make() (fail=' + others.errs.length + ')');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
