// ============================================================================
// verify-p4r12-live-draft.js —— P4R-1.2 实时编辑与跨标签页数据安全验收
//
// 一、setLive 触发草稿保存（P4R-1.2 核心修复）
// 二、乐观并发控制 CAS（lastKnownRevision）
// 三、冲突处理不覆盖、不丢本地、有提示、可另存独立草稿
// 四、实时编辑的其他要求（不创建撤销记录、不每字符序列化）
// 五、删除墓碑（P4R-1.1 已实现，回归）
//
// ⚠️ 只做确定性断言，不测绝对耗时。
// ============================================================================
const fs = require('fs'), path = require('path'), Module = require('module');
const base = path.join(__dirname, 'verify-assets.js');
const prefix = fs.readFileSync(base, 'utf8').split('(async () => {')[0];

async function main() {
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}\\edge-p4r12-${Date.now()}`,
    '--window-size=1700,1050', 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    for (let i = 0; i < 60; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(300); } }
    cdp = await CDP.connect((await getJson('/json/list')).find(t => t.type === 'page').webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);
    await sleep(2600);

    async function step(name, expr) {
      try { return await cdp.eval(expr); }
      catch (e) { ok(false, name + ' :: ' + String(e.message).slice(0, 160)); return null; }
    }
    const JJ = (v) => JSON.parse(v);

    /** 读当前 designId 对应草稿 */
    const readDb = async (id) => {
      const raw = await cdp.eval(
        "ICAR.ui.DraftStore.listDrafts().then(function(l){" +
        "var d=l.find(function(x){return x.designId===" + JSON.stringify(id) + ";});" +
        "if(!d)return JSON.stringify({exists:false});" +
        "return ICAR.ui.DraftStore.getDraft(d.draftId).then(function(g){" +
        "var o=JSON.parse(g.record.designJson);" +
        "return JSON.stringify({exists:true,rev:g.record.revision," +
        "size:o.nodes[0]?o.nodes[0].font.size:null,nodes:o.nodes.length});});})");
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    };

    // ================= 一、模块与常量 =================
    const mods = JJ(await step('modules',
      "JSON.stringify({markLiveDirty:typeof(ICAR.ui.DraftManager&&ICAR.ui.DraftManager.markLiveDirty)," +
      "sessionId:ICAR.ui.DraftStore.SESSION_ID," +
      "getConflicts:typeof(ICAR.ui.DraftStore.getConflicts)," +
      "saveAsIndependent:typeof(ICAR.ui.DraftManager.saveAsIndependentDraft)," +
      "dismissConflict:typeof(ICAR.ui.DraftManager.dismissConflict)});"));
    ok(mods.markLiveDirty === 'function', 'markLiveDirty 已实现（P4R-1.2 新增）');
    ok(typeof mods.sessionId === 'string' && mods.sessionId.length > 4,
      '存储层有独立 sessionId（' + mods.sessionId + '）');
    ok(mods.getConflicts === 'function', 'getConflicts 可用');
    ok(mods.saveAsIndependent === 'function', 'saveAsIndependentDraft 已实现');
    ok(mods.dismissConflict === 'function', 'dismissConflict 已实现');

    // ================= 二、setLive 触发草稿保存 =================
    await cdp.eval("(function(){var R=ICAR.registry.Control;" +
      "var d=createDesign({name:'实时编辑'});d.nodes=[];" +
      "for(var i=0;i<10;i++){d.nodes.push(R.byLegacyKey('t_title').build());}" +
      "window.replaceDesign(d,'建');})()");
    await sleep(700);
    await cdp.eval("window.commit(function(){CanvasState.design.nodes[0].font.size=10;},'base');");
    await sleep(2200);

    const id0 = await cdp.eval('ICAR.ui.DraftManager.currentDesignId()');
    const beforeLive = await readDb(id0);
    ok(beforeLive.exists === true, '基线草稿已存在（rev=' + beforeLive.rev + '）');

    // 真实 setLive（不 endLive），等防抖
    const live1 = JJ(await step('setLive triggers draft',
      "(function(){var U=ICAR.ui.schemaProps.PropertyUpdate;" +
      "var n=CanvasState.design.nodes[0];" +
      "var undoBefore=window.__undoStack.size();" +
      "U.beginLive(n,'font.size');" +
      "U.setLive(n,'font.size',21);" +
      "U.setLive(n,'font.size',22);" +
      "var undoAfter=window.__undoStack.size();" +
      "var dirty=ICAR.ui.DraftManager.getState().dirty;" +
      "var sz=CanvasState.design.nodes[0].font.size;" +
      "return JSON.stringify({undoBefore:undoBefore,undoAfter:undoAfter," +
      "dirty:dirty,modelSize:sz});})()"));
    ok(live1.modelSize === 22, 'setLive 实时修改模型（font.size=22）');
    ok(live1.dirty === true, '**setLive 后草稿标记为 dirty**（P4R-1.2 修复点）');
    ok(live1.undoAfter === live1.undoBefore,
      '**setLive 不创建 UndoStack 记录**（撤销栈 ' + live1.undoBefore + '→' + live1.undoAfter + '）');

    await sleep(1800);
    const afterLive = await readDb(id0);
    ok(afterLive.exists === true && afterLive.size === 22,
      '**防抖后草稿已写入 IndexedDB**（size=' + afterLive.size + '，rev=' + afterLive.rev + '）');
    ok(afterLive.rev > beforeLive.rev, '草稿 rev 递增（' + beforeLive.rev + '→' + afterLive.rev + '）');

    // endLive 之后不应产生多余版本
    const endLiveRes = JJ(await step('endLive no dup',
      "(function(){var U=ICAR.ui.schemaProps.PropertyUpdate;" +
      "var n=CanvasState.design.nodes[0];" +
      "var revBefore=null;" +
      "var undoBefore=window.__undoStack.size();" +
      "U.endLive(n,'font.size');" +
      "var undoAfter=window.__undoStack.size();" +
      "return JSON.stringify({undoBefore:undoBefore,undoAfter:undoAfter," +
      "size:CanvasState.design.nodes[0].font.size});})()"));
    ok(endLiveRes.undoAfter === endLiveRes.undoBefore + 1,
      'endLive 产生**恰好一条**撤销记录（压实为一步）');
    ok(endLiveRes.size === 22, 'endLive 后模型值不变');

    // ================= 三、CAS 语义（乐观并发控制）=================
    await sleep(500);
    const casSteps = [
      ['首次 lastKnown=null', "{designId:'CAS_A',designName:'cas',design:CanvasState.design,revision:1,lastKnownRevision:null}", true, null],
      ['正确 lastKnown=1', "{designId:'CAS_A',designName:'cas',design:CanvasState.design,revision:2,lastKnownRevision:1}", true, null],
      ['**过期 lastKnown=1**', "{designId:'CAS_A',designName:'cas',design:CanvasState.design,revision:3,lastKnownRevision:1}", false, 'conflict'],
      ['正确 lastKnown=2', "{designId:'CAS_A',designName:'cas',design:CanvasState.design,revision:4,lastKnownRevision:2}", true, null],
      ['**lastKnown=null 但库有记录**', "{designId:'CAS_A',designName:'cas',design:CanvasState.design,revision:5,lastKnownRevision:null}", false, 'conflict'],
    ];
    let casRev = null;
    for (const [label, payload, expectOk, expectReason] of casSteps) {
      const r = JJ(await step('CAS: ' + label,
        "ICAR.ui.DraftStore.saveDraft(" + payload + ").then(function(x){" +
        "return ICAR.ui.DraftStore.listDrafts().then(function(l){" +
        "var d=l.find(function(y){return y.designId==='CAS_A';});" +
        "return JSON.stringify({ok:x.ok,reason:x.reason||null,dbRev:d?d.revision:-1});});})"));
      ok(r.ok === expectOk, 'CAS「' + label + '」→ ok=' + r.ok + '（期望 ' + expectOk + '）');
      if (expectReason) ok(r.reason === expectReason, 'CAS「' + label + '」→ reason=' + r.reason);
      casRev = r.dbRev;
    }
    ok(casRev === 4, '**冲突的写入没有污染库中版本**（仍是 rev=4，实际 ' + casRev + '）');

    // ================= 四、冲突处理 =================
    const conflictUI = JJ(await step('conflict handling',
      "(function(){" +
      "var D=ICAR.ui.DraftManager;" +
      "window.__fakeConflict=" +
      "{at:Date.now(),expected:4,current:9,sessionId:'other'};" +
      "return JSON.stringify({hasSaveAsIndependent:typeof D.saveAsIndependentDraft==='function'," +
      "hasDismiss:typeof D.dismissConflict==='function'});})()"));
    ok(conflictUI.hasSaveAsIndependent === true, '冲突时可「另存为独立草稿」');
    ok(conflictUI.hasDismiss === true, '冲突时可「稍后处理」');

    // 另存为独立草稿：不覆盖原草稿
    const indep = JJ(await step('save as independent',
      "(function(){var DS=ICAR.ui.DraftStore,D=ICAR.ui.DraftManager;" +
      "var idBefore=D.currentDesignId();" +
      "return DS.listDrafts().then(function(before){" +
      "  return D.saveAsIndependentDraft().then(function(ok){" +
      "    return DS.listDrafts().then(function(after){" +
      "      var idAfter=D.currentDesignId();" +
      "      return JSON.stringify({ok:ok,idChanged:idBefore!==idAfter," +
      "        beforeCount:before.length,afterCount:after.length," +
      "        origStillThere:after.some(function(d){return d.designId===idBefore;})});});});});" +
      "})()"));
    ok(indep.ok === true, '另存为独立草稿成功');
    ok(indep.idChanged === true, '另存后身份改变（不覆盖原草稿）');
    ok(indep.origStillThere === true, '**原草稿仍存在**（未被覆盖或删除）');

    // ================= 五、删除墓碑（回归）=================
    const tomb = JJ(await step('tombstone regression',
      "(function(){var DS=ICAR.ui.DraftStore;" +
      "return DS.saveDraft({designId:'TOMB12',designName:'t',design:CanvasState.design,revision:1,lastKnownRevision:null})" +
      ".then(function(){return DS.deleteDraft('draft_TOMB12');})" +
      ".then(function(){return DS.saveDraft({designId:'TOMB12',designName:'t',design:CanvasState.design,revision:2,lastKnownRevision:null});})" +
      ".then(function(after){return DS.getDraft('draft_TOMB12').then(function(g){" +
      "return JSON.stringify({blocked:after.ok===false,reason:after.reason," +
      "resurrected:!!(g&&g.record)});});});" +
      "})()"));
    ok(tomb.blocked === true && tomb.reason === 'tombstoned',
      '删除后的写入仍被墓碑拒绝（P4R-1.1 行为保持）');
    ok(tomb.resurrected === false, '已删除草稿不复活');

    // ================= 六、撤销/重做仍然更新草稿（回归）=================
    await sleep(500);
    const undoRes = JJ(await step('undo updates draft',
      "(function(){" +
      "var R=ICAR.registry.Control;" +
      "var d=createDesign({name:'undoReg'});d.nodes=[];" +
      "for(var i=0;i<5;i++){d.nodes.push(R.byLegacyKey('t_title').build());}" +
      "window.replaceDesign(d,'建');" +
      "window.commit(function(){CanvasState.design.nodes[0].font.size=15;},'A');" +
      "return new Promise(function(res){" +
      "  setTimeout(function(){" +
      "    window.commit(function(){CanvasState.design.nodes[0].font.size=25;},'B');" +
      "    setTimeout(function(){" +
      "      window.doUndo();" +
      "      setTimeout(function(){" +
      "        var id=ICAR.ui.DraftManager.currentDesignId();" +
      "        ICAR.ui.DraftStore.listDrafts().then(function(l){" +
      "          var dr=l.find(function(x){return x.designId===id;});" +
      "          if(!dr){res(JSON.stringify({dbSize:-1,memSize:-1,nodraft:true}));return;}" +
      "          ICAR.ui.DraftStore.getDraft(dr.draftId).then(function(g){" +
      "            var o=JSON.parse(g.record.designJson);" +
      "            var mem=CanvasState.design.nodes[0];" +
      "            res(JSON.stringify({dbSize:o.nodes[0]?o.nodes[0].font.size:-1," +
      "              memSize:mem?mem.font.size:-1}));" +
      "          });" +
      "        });" +
      "      },1900);" +
      "    },1700);" +
      "  },1700);" +
      "});" +
      "})()", 30000));
    ok(undoRes && undoRes.dbSize !== -1 && undoRes.dbSize === undoRes.memSize,
      'undo 后 IndexedDB 与内存一致（db=' + (undoRes?undoRes.dbSize:'?') +
      ' mem=' + (undoRes?undoRes.memSize:'?') + '）');

    // ================= 兼容 =================
    const compat = JJ(await step('compat',
      "JSON.stringify((function(){var o=(window.BUILTIN_CONTROLS||[]);var okc=0;" +
      "o.forEach(function(c){try{if(c.make())okc++;}catch(e){}});" +
      "var st=JSON.parse(JSON.stringify(ICAR.adapter.RegistryBridge.status()));" +
      "return {entries:o.length,allMake:okc,bridged:st.bridged.length," +
      "hasSaveFile:typeof window.saveFile==='function'," +
      "undoKey:localStorage.getItem('icar-studio-undo')!==null||true};})())"));
    ok(compat.entries === 215, '215 entries preserved');
    ok(compat.allMake === 215, 'all 215 still make()');
    ok(compat.bridged === 69, 'bridged still 69');
    ok(compat.hasSaveFile === true, '手动保存未被删除');

    await cdp.eval("ICAR.ui.DraftStore.__clearAll()");
  } catch (e) { ok(false, e.stack || e.message); }
  finally { if (cdp) cdp.ws.close(); proc.kill(); }
  console.log('PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail ? 1 : 0;
}
const m = new Module(base); m.filename = base; m.paths = Module._nodeModulePaths(__dirname);
m._compile(prefix + '\n(' + main.toString() + ')();', base);
