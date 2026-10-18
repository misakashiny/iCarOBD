// ============================================================================
// verify-p4p1a-assets-refresh.js —— P4P-1A 素材库按需刷新验收
//
// 一、签名机制：普通属性编辑时素材 DOM 重建次数必须为 0
// 二、素材变化的 12 类场景**必须**触发重建（不得漏刷）
// 三、DOM 与交互状态保留（滚动/焦点/筛选/折叠/缩略图/拖拽/点击）
// 四、搜索、分类、折叠、拖拽回归
// 五、素材增删改 + 撤销重做
// 六、异常兜底（签名计算失败时强制刷新）
//
// ⚠️ 本套件**不测绝对耗时**（那是独立性能脚本的事）——
//    避免机器负载造成 CI 不稳定失败（任务第十部分要求）。
//    这里只测"重建次数"这个确定性指标。
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4p1a`,
    '--window-size=1700,1050', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    cdp = await CDP.connect((await getJson('/json/list')).find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);
    await sleep(2000);

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const JJ = (v) => JSON.parse(v);

    // 辅助：重置统计并建立 60 控件设计
    await cdp.eval("window.__prep=function(n){" +
      "var R=ICAR.registry.Control,S=CanvasState;" +
      "S.design=createDesign({name:'p'});S.design.nodes=[];" +
      "var ks=['t_title','cd_trackh','g_speed','lamp_tpms','lamp_coolant'];" +
      "for(var i=0;i<n;i++){var c=(window.BUILTIN_CONTROLS||[]).find(function(x){return x.key===ks[i%5];});" +
      "var nd=c.make();nd.x=(i%12)*25;nd.y=Math.floor(i/12)*25;S.design.nodes.push(nd);}" +
      "window.refreshAll();" +
      "var st=window.__assetsRenderStats;st.rebuilt=0;st.skipped=0;return n;};" +
      "window.__st=function(){return JSON.parse(JSON.stringify(window.__assetsRenderStats));};");

    // ================= 一、模块存在 =================
    const mods = JJ(await step('modules',
      "JSON.stringify({sig:typeof (ICAR.ui&&ICAR.ui.AssetsSignature)," +
      "stats:typeof window.__assetsRenderStats," +
      "compute:typeof(ICAR.ui&&ICAR.ui.AssetsSignature&&ICAR.ui.AssetsSignature.compute)," +
      "needRebuild:typeof(ICAR.ui&&ICAR.ui.AssetsSignature&&ICAR.ui.AssetsSignature.needRebuild)});"));
    ok(mods.sig === 'object', 'AssetsSignature module loaded');
    ok(mods.stats === 'object', '__assetsRenderStats diagnostic exposed');
    ok(mods.compute === 'function', 'compute() exposed');
    ok(mods.needRebuild === 'function', 'needRebuild() exposed');

    // ================= 二、普通属性编辑：0 次重建 =================
    await cdp.eval("window.__prep(60);");
    await sleep(100);
    const edits = JJ(await step('normal edits skip',
      "(function(){" +
      "var S=CanvasState;" +
      "var targets=[" +
      "  function(n){n.text='edt';}," +
      "  function(n){n.font=Object.assign({},n.font,{size:12});}," +
      "  function(n){n.font=Object.assign({},n.font,{color:'#FF0000'});}," +
      "  function(n){n.alpha=180;}," +
      "  function(n){n.locked=true;}," +
      "  function(n){n.visible=false;}," +
      "  function(n){n.x=90;}," +
      "  function(n){n.rotation=30;}" +
      "];" +
      "targets.forEach(function(fn,i){" +
      "  var nd=S.design.nodes[i];" +
      "  window.commit(function(){fn(nd);},'edit'+i);" +
      "});" +
      "var st=window.__st();" +
      "return JSON.stringify({rebuilt:st.rebuilt,skipped:st.skipped});})()"));
    ok(edits.rebuilt === 0, '8 kinds of property edit → 0 assets DOM rebuilds (got ' + edits.rebuilt + ')');
    ok(edits.skipped >= 8, 'all 8 edits skipped assets rebuild (skipped=' + edits.skipped + ')');

    // 轨道 fill / 容器尺寸
    const trackEdit = JJ(await step('track + container edit',
      "(function(){var S=CanvasState;" +
      "var st0=window.__assetsRenderStats.rebuilt;" +
      "var t=S.design.nodes.find(function(n){return n.trackStyle;});" +
      "if(t)window.commit(function(){t.trackStyle.fill=0.3;},'f');" +
      "var g=ICAR.registry.Control.byLegacyKey('group').build();" +
      "window.commit(function(){S.design.nodes.push(g);},'addg');" +
      "var st1=window.__assetsRenderStats.rebuilt;" +
      "window.commit(function(){g.w=300;g.h=200;},'size');" +
      "var st2=window.__assetsRenderStats.rebuilt;" +
      "return JSON.stringify({trackDelta:st1-st0,containerDelta:st2-st1});})()"));
    ok(trackEdit.trackDelta === 0, 'track fill edit does not rebuild assets (delta=' + trackEdit.trackDelta + ')');
    ok(trackEdit.containerDelta === 0, 'container size edit does not rebuild assets (delta=' + trackEdit.containerDelta + ')');

    // ================= 三、素材变化必须重建（12 类）=================
    const changes = [
      ['新增素材', "S.design.assets.push({id:'n1',name:'N1',kind:'custom',path:'n1.png',data:'',w:1,h:1});window.refreshAll();"],
      ['删除素材', "S.design.assets.pop();window.refreshAll();"],
      ['删除+新增（长度不变）', "S.design.assets.push({id:'x1',name:'X1',kind:'custom',path:'x.png',data:'',w:1,h:1});window.refreshAll();" +
        "S.design.assets.pop();S.design.assets.push({id:'x2',name:'X2',kind:'custom',path:'y.png',data:'',w:1,h:1});window.refreshAll();"],
      ['素材重命名', "S.design.assets[0].name='改过';window.refreshAll();"],
      ['修改素材分类', "S.design.assets[0].kind='dial';window.refreshAll();"],
      ['修改素材路径', "S.design.assets[0].path='zzz.png';window.refreshAll();"],
      ['修改素材预览数据', "S.design.assets[0].data='data:image/png;base64,QQ==';window.refreshAll();"],
      ['内置素材列表变化', "(function(){var o=window.BUILTIN_ASSETS;window.BUILTIN_ASSETS=o.slice(0,10);window.refreshAll();window.BUILTIN_ASSETS=o;window.refreshAll();})();"],
      ['内置控件列表变化', "(function(){var o=window.BUILTIN_CONTROLS;window.BUILTIN_CONTROLS=o.slice(0,5);window.refreshAll();window.BUILTIN_CONTROLS=o;window.refreshAll();})();"],
      ['自定义控件变化', "S.design.controls=S.design.controls||[];S.design.controls.push({id:'c1',name:'CC'});window.refreshAll();"],
      // 导入新设计：直接换成全新的 design 对象（模拟 importDesign 的效果）
      ['导入新设计', "S.design=createDesign({name:'imported'});S.design.nodes=[];S.design.assets=[{id:'imp1',name:'IMP',kind:'custom',path:'i.png',data:'',w:1,h:1}];window.refreshAll();"],
      ['搜索条件变化', "window.setAssetQuery('track');window.setAssetQuery('');"],
    ];
    for (const [label, code] of changes) {
      const r = JJ(await step('change: ' + label,
        "(function(){var S=CanvasState;var b=window.__assetsRenderStats.rebuilt;" +
        "try{" + code + "}catch(e){return JSON.stringify({err:e.message});}" +
        "var a=window.__assetsRenderStats?window.__assetsRenderStats.rebuilt:b;" +
        "return JSON.stringify({delta:a-b});})()"));
      if (r.err) ok(false, label + ' threw: ' + r.err);
      else ok(r.delta > 0, label + ' MUST rebuild assets (delta=' + r.delta + ')');
    }

    // 撤销/重做导致素材变化
    const undoAsset = JJ(await step('undo asset change',
      "(function(){var S=CanvasState;" +
      "if(!S.design.assets)S.design.assets=[];" +
      // ⚠️ D-09：UndoStack 首次 commit 是基准，必须至少两次才能观察到撤销
      "window.commit(function(){},'base1');" +
      "window.commit(function(){},'base2');" +
      "var n0=S.design.assets.length;" +
      "window.commit(function(){S.design.assets.push({id:'u1',name:'U1',kind:'custom',path:'u.png',data:'',w:1,h:1});},'addasset');" +
      "var n1=(S.design.assets||[]).length;" +
      "window.__assetsRenderStats.rebuilt=0;" +
      "window.doUndo();" +
      "var n2=(S.design.assets||[]).length;" +
      "var rb1=window.__assetsRenderStats.rebuilt;" +
      "window.__assetsRenderStats.rebuilt=0;" +
      "window.doRedo();" +
      "var n3=(S.design.assets||[]).length;" +
      "var rb2=window.__assetsRenderStats.rebuilt;" +
      "return JSON.stringify({n0:n0,n1:n1,n2:n2,n3:n3,undoRebuilt:rb1,redoRebuilt:rb2});})()"));
    ok(undoAsset.n1 === undoAsset.n0 + 1, 'commit added one asset');
    ok(undoAsset.n2 === undoAsset.n0, 'undo removed the asset');
    ok(undoAsset.n3 === undoAsset.n0 + 1, 'redo restored the asset');
    ok(undoAsset.undoRebuilt > 0, 'undo of asset change rebuilds assets (got ' + undoAsset.undoRebuilt + ')');
    ok(undoAsset.redoRebuilt > 0, 'redo of asset change rebuilds assets (got ' + undoAsset.redoRebuilt + ')');

    // ================= 四、DOM 与交互状态保留 =================
    await cdp.eval("window.__prep(20);");
    await sleep(100);
    const domKeep = JJ(await step('dom preserved',
      "(function(){" +
      "var S=CanvasState;" +
      "var box=document.getElementById('assets');" +
      "var body=document.getElementById('assetsBody');" +
      "var firstThumb=box.querySelector('.assetThumb');" +
      "var searchInput=document.getElementById('assetSearch');" +
      "if(body)body.scrollTop=120;" +
      "if(searchInput){searchInput.value='';}" +
      "var scrollBefore=body?body.scrollTop:0;" +
      "window.commit(function(){S.design.nodes[0].alpha=100;},'e');" +
      "var firstThumbAfter=box.querySelector('.assetThumb');" +
      "var searchAfter=document.getElementById('assetSearch');" +
      "var scrollAfter=body?body.scrollTop:0;" +
      "return JSON.stringify({" +
      "sameThumb:firstThumb===firstThumbAfter," +
      "sameSearchInput:searchInput===searchAfter," +
      "scrollBefore:scrollBefore,scrollAfter:scrollAfter," +
      "thumbs:box.querySelectorAll('.assetThumb').length});})()"));
    ok(domKeep.sameThumb === true, 'same thumbnail DOM element preserved (not rebuilt)');
    ok(domKeep.sameSearchInput === true, 'same search input DOM element preserved');
    ok(domKeep.scrollBefore === domKeep.scrollAfter, 'scroll position preserved (' +
      domKeep.scrollBefore + ' → ' + domKeep.scrollAfter + ')');
    ok(domKeep.thumbs > 0, 'asset thumbnails still rendered (' + domKeep.thumbs + ')');

    // 折叠状态保留
    const collapseKeep = JJ(await step('collapse preserved on normal edit',
      "(function(){var S=CanvasState;" +
      "window.togglePanelCollapse('assets');" +   // 收起
      "var box=document.getElementById('assets');" +
      "var collapsed1=box.classList.contains('collapsed');" +
      "window.commit(function(){S.design.nodes[0].alpha=90;},'e');" +
      "var collapsed2=box.classList.contains('collapsed');" +
      "window.togglePanelCollapse('assets');" +   // 展开（复原）
      "return JSON.stringify({before:collapsed1,after:collapsed2,kept:collapsed1===collapsed2});})()"));
    ok(collapseKeep.kept === true, 'collapse state preserved across normal edit');

    // 分类折叠状态
    const kindCollapse = JJ(await step('kind collapse force rebuild',
      "(function(){var S=CanvasState;var b=window.__assetsRenderStats.rebuilt;" +
      "window.assetsExpandAll(false);" +
      "var a=window.__assetsRenderStats.rebuilt;" +
      "var box=document.getElementById('assets');" +
      "var openFolders=box.querySelectorAll('.afolder.open, .assetFolder.open, details[open]').length;" +
      "window.assetsExpandAll(true);" +
      "return JSON.stringify({delta:a-b,openFolders:openFolders});})()"));
    ok(kindCollapse.delta > 0, 'assetsExpandAll forces rebuild (delta=' + kindCollapse.delta + ')');

    // ================= 五、搜索/分类/拖拽回归 =================
    await cdp.eval("window.__prep(10);");
    await sleep(100);
    const search = JJ(await step('search works',
      "(function(){" +
      "window.setAssetQuery('track');" +
      "var box=document.getElementById('assets');" +
      "var n1=box.querySelectorAll('.assetThumb').length;" +
      "window.setAssetQuery('');" +
      "var n2=box.querySelectorAll('.assetThumb').length;" +
      "return JSON.stringify({filtered:n1,all:n2,searchWorks:n1<n2});})()"));
    ok(search.searchWorks === true, 'search narrows asset list (' + search.filtered + ' < ' + search.all + ')');
    ok(search.all > 0, 'clearing search restores list (' + search.all + ')');

    const drag = JJ(await step('drag data preserved',
      "(function(){var box=document.getElementById('assets');" +
      "var draggable=box.querySelectorAll('[draggable=\"true\"]').length;" +
      "var withDragstart=box.querySelectorAll('[ondragstart]').length;" +
      "var withClick=box.querySelectorAll('.assetThumb[onclick], .ctrlChip[onclick]').length;" +
      "return JSON.stringify({draggable:draggable,withDragstart:withDragstart,withClick:withClick});})()"));
    ok(drag.draggable > 0, 'draggable elements present (' + drag.draggable + ')');
    ok(drag.withDragstart > 0, 'dragstart handlers present (' + drag.withDragstart + ')');
    ok(drag.withClick > 0, 'click handlers present (' + drag.withClick + ')');

    // ================= 六、异常兜底 =================
    const fallback = JJ(await step('signature error fallback',
      "(function(){var SIG=ICAR.ui.AssetsSignature;" +
      "var orig=SIG.compute;" +
      "SIG.compute=function(){throw new Error('SIG_FAIL');};" +
      "var b=window.__assetsRenderStats.rebuilt;" +
      "window.refreshAll();" +
      "var a=window.__assetsRenderStats.rebuilt;" +
      "SIG.compute=orig;" +
      "window.refreshAll();" +
      "return JSON.stringify({forced:a-b});})()"));
    ok(fallback.forced > 0, 'signature exception forces rebuild (never silently skips) (got ' + fallback.forced + ')');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "return {entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "legacyPanel:!!document.getElementById('props')," +
      "assetsPanel:!!document.getElementById('assets')," +
      "builtinAssets:(window.BUILTIN_ASSETS||[]).length};})())"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69');
    ok(compat.legacyPanel === true, 'legacy #props panel exists');
    ok(compat.assetsPanel === true, '#assets panel exists');
    ok(compat.builtinAssets === 416, '416 built-in assets intact (got ' + compat.builtinAssets + ')');

  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
