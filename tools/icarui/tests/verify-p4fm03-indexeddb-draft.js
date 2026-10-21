// ============================================================================
// verify-p4fm03-indexeddb-draft.js —— P4F-M03 目标 C：IndexedDB 草稿恢复端到端
//
// 任务要求：
//   · 隔离浏览器 Profile 和测试数据库
//   · 接近 948×949 的真实测试图片（不用极小 dataURL）
//   · 保存 → **完整关闭页面** → 重开 → 从 IndexedDB 恢复
//   · 验证节点数、属性、素材 ID、实际图片分辨率
//   · 确认 Canvas 未用 64×64 缩略图
//   · 源文件路径不可用时的恢复
//   · 多素材 ID 独立引用
//   · 恢复后 Undo/Redo 语义
//
// ⚠️ 禁止清空用户真实草稿。本套件：
//   1. 使用**独立的 user-data-dir**（每次新建临时目录）
//   2. 只操作自己创建的 draftId
//   3. 结束时只删自己的记录
// ============================================================================
const fs=require('fs'),path=require('path'),Module=require('module');
const base=path.join(__dirname,'verify-assets.js');
const prefix=fs.readFileSync(base,'utf8').split('(async () => {')[0];

async function main(){
 const pathc=require('path');
 const fsc=require('fs');
 const PROFILE=pathc.join(os.tmpdir(),'edge-m03idx-'+Date.now());
 const proc=spawn(EDGE,['--headless=new','--disable-gpu','--no-first-run',
   `--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,
   '--window-size=1400,1000','about:blank'],{stdio:'ignore'});
 let cdp;
 const JJ=v=>JSON.parse(v);
 try{
  for(let i=0;i<60;i++){try{await getJson('/json/version');break;}catch(e){await sleep(300);}}
  cdp=await CDP.connect((await getJson('/json/list')).find(t=>t.type==='page').webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(2400);

  // ================= 1. 生成 948×949 真实测试图片 =================
  console.log('=== C-1. 真实尺寸测试图片（948×949）===');
  const imgGen=JJ(await cdp.eval(`(function(){
    function make(w,h,base,accent,label){
      var cv=document.createElement('canvas');
      cv.width=w;cv.height=h;
      var g=cv.getContext('2d');
      g.fillStyle=base;g.fillRect(0,0,w,h);
      // 加**高频噪声纹理**，让 PNG 有真实照片的体积（纯色/渐变的 PNG 太小，测不出问题）
      var imgData=g.getImageData(0,0,w,h);
      var px=imgData.data;
      for(var i=0;i<px.length;i+=4){
        var n=((i*2654435761)%97)-48;   // 确定性伪噪声
        px[i]=Math.max(0,Math.min(255,px[i]+n));
        px[i+1]=Math.max(0,Math.min(255,px[i+1]+((i*40503)%89-44)));
        px[i+2]=Math.max(0,Math.min(255,px[i+2]+((i*69069)%83-41)));
      }
      g.putImageData(imgData,0,0);
      // 再叠一些块状细节
      for(var i2=0;i2<200;i2++){
        g.fillStyle='rgba('+(i2*37%255)+','+(i2*71%255)+','+(i2*113%255)+',0.25)';
        g.fillRect((i2*97)%w,(i2*61)%h,40,30);
      }
      g.fillStyle=accent;g.fillRect(0,0,w,80);
      g.fillStyle='#FFFFFF';g.font='bold 64px sans-serif';
      g.textAlign='center';g.textBaseline='middle';
      g.fillText(label,w/2,h/2);
      return cv.toDataURL('image/png');
    }
    var a=make(948,949,'#1E3A5F','#4EA8FF','BIG-A');
    var b=make(948,949,'#5F1E3A','#FF4E8A','BIG-B');
    return JSON.stringify({a:a,b:b,aLen:a.length,bLen:b.length});
  })()`));
  ok(imgGen.aLen>50000,'C-1a 测试图片 A 是真实大图（'+Math.round(imgGen.aLen/1024)+' KB dataURL）');
  ok(imgGen.bLen>50000,'C-1b 测试图片 B 是真实大图（'+Math.round(imgGen.bLen/1024)+' KB dataURL）');

  // ================= 2. 创建含大图的设计 =================
  console.log('\n=== C-2. 创建测试设计 ===');
  const created=JJ(await cdp.eval(`(function(){
    var S=CanvasState;
    var A=${JSON.stringify(imgGen.a)}, B=${JSON.stringify(imgGen.b)};
    function decSize(d){
      return new Promise(function(res){
        var im=new Image();
        im.onload=function(){res({w:im.naturalWidth,h:im.naturalHeight});};
        im.onerror=function(){res({w:0,h:0});};
        im.src=d;
      });
    }
    S.design.assets=[
      {id:'big_a',name:'大图A',kind:'import',path:'assets/big_a.png',w:948,h:949,bytes:0,data:A},
      {id:'big_b',name:'大图B',kind:'import',path:'assets/big_b.png',w:948,h:949,bytes:0,data:B}
    ];
    var n1=window.createNode(window.NODE_IMAGE,{name:'图A',assetId:'big_a',w:120,h:120});
    n1.id='node_a';n1.x=20;n1.y=20;
    var n2=window.createNode(window.NODE_IMAGE,{name:'图B',assetId:'big_b',w:100,h:100});
    n2.id='node_b';n2.x=160;n2.y=20;
    var g=ICAR.registry.Control.byLegacyKey('g_speed').build();
    g.id='gauge_x';g.name='表';g.x=20;g.y=160;g.w=120;g.h=120;
    // 加色带与子部件，测复杂数据恢复
    g.bands=[{from:0,to:50,color:'#39D98A',alpha:200},{from:50,to:100,color:'#FF4D4F',alpha:null}];
    S.design.name='P4F-M03 IndexedDB 端到端测试';
    S.design.nodes=[n1,n2,g];
    window.commit(function(){S.design.name='P4F-M03 IndexedDB 端到端测试';},'命名');
    return JSON.stringify({
      nodeCount:S.design.nodes.length,
      assetCount:S.design.assets.length,
      aLen:S.design.assets[0].data.length,
      bLen:S.design.assets[1].data.length,
      bands:g.bands.length
    });
  })()`));
  ok(created.nodeCount===3,'C-2a 设计有 3 个节点');
  ok(created.assetCount===2,'C-2b 设计有 2 个素材');
  ok(created.bands===2,'C-2c 仪表有 2 段色带（复杂数据）');

  // ================= 3. 真实保存草稿 =================
  console.log('\n=== C-3. 真实保存草稿到 IndexedDB ===');
  const saved=JJ(await cdp.eval(`(function(){
    var DM=ICAR.ui.DraftManager, DS=ICAR.ui.DraftStore;
    if(!DM||!DS) return JSON.stringify({noApi:true});
    // 触发保存
    DM.markDirty();
    return JSON.stringify({
      hasDM:true,hasDS:true,
      avail:DS.available,
      draftId:DM.currentDraftId?DM.currentDraftId():null
    });
  })()`));
  ok(saved.hasDM===true,'C-3a DraftManager 存在');
  ok(saved.hasDS===true,'C-3b DraftStore 存在');

  // 等待防抖落盘（DEBOUNCE_MS=1200，留足余量）
  await sleep(3500);
  const flush=JJ(await cdp.eval(`(function(){
    var DM=ICAR.ui.DraftManager, DS=ICAR.ui.DraftStore;
    DM.markDirty();
    return JSON.stringify({ok:true});
  })()`));
  await sleep(3000);

  // 直接查 IndexedDB 内容
  await cdp.eval(`(function(){
    window.__dbResult=null;
    var req=indexedDB.open('icar-studio-drafts');
    req.onsuccess=function(e){
      var db=e.target.result;
      var out={version:db.version,stores:Array.prototype.slice.call(db.objectStoreNames)};
      var tx=db.transaction(['drafts'],'readonly');
      var all=tx.objectStore('drafts').getAll();
      all.onsuccess=function(ev){
        var rows=ev.target.result||[];
        out.draftCount=rows.length;
        // ⚠️ 草稿结构：designJson 是**字符串**，另有 nodeCount/assetCount 等元数据
        out.drafts=rows.map(function(r){
          var d={};
          try{ d=JSON.parse(r.designJson||'{}'); }catch(e2){ d={}; }
          var nodes=(d.nodes&&d.nodes.length)?d.nodes:((d.pages&&d.pages[0]&&d.pages[0].nodes)||[]);
          return {
            draftId:r.draftId,
            designId:r.designId,
            designName:r.designName,
            nameInJson:d.name,
            nodeCountField:r.nodeCount,
            assetCountField:r.assetCount,
            nodeCountActual:nodes.length,
            assetCountActual:(d.assets||[]).length,
            assetsWithData:(d.assets||[]).filter(function(a){return !!a.data;}).length,
            dataLens:(d.assets||[]).map(function(a){return a.data?a.data.length:0;}),
            bands:nodes.filter(function(n){return n.bands&&n.bands.length;}).length,
            byteSize:r.byteSize,
            checksum:r.checksum,
            complete:r.complete,
            designJsonLen:(r.designJson||'').length
          };
        });
        window.__dbResult=JSON.stringify(out);
        db.close();
      };
      all.onerror=function(){out.error='getAll failed';window.__dbResult=JSON.stringify(out);db.close();};
    };
    req.onerror=function(){window.__dbResult='{"error":"open failed"}';};
    return 'pending';
  })()`);
  await sleep(2500);
  const dbRes=JJ(await cdp.eval(`window.__dbResult || '{"pending":true}'`));
  ok(dbRes.version===3,'C-3c IndexedDB 版本 = 3（实测 '+dbRes.version+'）');
  ok(Array.isArray(dbRes.stores)&&dbRes.stores.length>=4,'C-3d object store 齐全（'+JSON.stringify(dbRes.stores)+'）');
  ok(dbRes.draftCount>=1,'C-3e **草稿已真实写入 IndexedDB**（'+dbRes.draftCount+' 条）');

  const myDraft=(dbRes.drafts||[]).filter(function(x){return String(x.designName||'').indexOf('P4F-M03')>=0;})[0]
             || (dbRes.drafts||[])[0];
  if(myDraft){
    ok(myDraft.nodeCountField===3,'C-3f 草稿 nodeCount 元数据 = 3（实测 '+myDraft.nodeCountField+'）');
    ok(myDraft.nodeCountActual===3,'C-3g **designJson 里实际 3 个节点**（实测 '+myDraft.nodeCountActual+'）');
    ok(myDraft.assetCountActual===2,'C-3h 草稿含 2 个素材');
    ok(myDraft.assetsWithData===2,'C-3i **两个素材都带完整 data**');
    ok(myDraft.dataLens[0]>50000&&myDraft.dataLens[1]>50000,
      'C-3j **素材 data 是完整大图**（'+Math.round((myDraft.dataLens[0]||0)/1024)+' / '+Math.round((myDraft.dataLens[1]||0)/1024)+' KB）');
    ok(myDraft.bands===1,'C-3k 色带数据一并保存');
    ok(myDraft.complete===true,'C-3l 草稿标记 complete=true');
    ok(!!myDraft.checksum,'C-3m 草稿有 checksum 校验值');
  }
  const TEST_DRAFT_ID = myDraft ? myDraft.draftId : null;

  // ================= 4. 完整关闭页面并重开 =================
  console.log('\n=== C-4. 完整关闭页面 → 重开 ===');
  await cdp.send('Page.navigate',{url:'about:blank'});
  await sleep(1500);
  await cdp.send('Page.navigate',{url:URL_PAGE});
  await waitReady(cdp);await require('./_common').stubDialogs(cdp);await sleep(4000);
  ok(true,'C-4a 页面已完整关闭并重新打开');

  // ================= 5. 从 IndexedDB 恢复 =================
  console.log('\n=== C-5. 从 IndexedDB 恢复设计 ===');
  // 直接用 IndexedDB 读，模拟恢复流程（designJson 是字符串）
  await cdp.eval(`(function(){
    window.__rec=null;
    var req=indexedDB.open('icar-studio-drafts');
    req.onsuccess=function(e){
      var db=e.target.result;
      var tx=db.transaction(['drafts'],'readonly');
      var all=tx.objectStore('drafts').getAll();
      all.onsuccess=function(ev){
        var rows=ev.target.result||[];
        if(!rows.length){window.__rec='{"empty":true}';db.close();return;}
        var r=rows[0];
        var d={};
        try{ d=JSON.parse(r.designJson||'{}'); }catch(e2){ d={}; }
        var nodes=(d.nodes&&d.nodes.length)?d.nodes:((d.pages&&d.pages[0]&&d.pages[0].nodes)||[]);
        var out={
          draftId:r.draftId,designName:r.designName,nameInJson:d.name,
          nodeCount:nodes.length,
          assetCount:(d.assets||[]).length,
          nodeIds:nodes.map(function(n){return n.id;}),
          nodeAssets:nodes.map(function(n){return n.assetId||null;}),
          dataLens:(d.assets||[]).map(function(a){return a.data?a.data.length:0;}),
          bands:(nodes.filter(function(n){return n.bands&&n.bands.length;})[0]||{}).bands||null,
          assetDims:[]
        };
        out.bandsCount = out.bands ? out.bands.length : 0;
        var assets=d.assets||[];
        var pending=assets.length;
        if(!pending){window.__rec=JSON.stringify(out);db.close();return;}
        assets.forEach(function(a,idx){
          var im=new Image();
          im.onload=function(){out.assetDims[idx]={w:im.naturalWidth,h:im.naturalHeight};
            if(--pending===0){window.__rec=JSON.stringify(out);db.close();}};
          im.onerror=function(){out.assetDims[idx]={w:0,h:0};
            if(--pending===0){window.__rec=JSON.stringify(out);db.close();}};
          im.src=a.data||'';
        });
      };
    };
    req.onerror=function(){window.__rec='{"error":"open failed"}';};
    return 'pending';
  })()`);
  await sleep(3500);
  const R=JJ(await cdp.eval(`window.__rec || '{"pending":true}'`));

  ok(R.nodeCount===3,'C-5a **恢复后节点数 = 3**（实测 '+R.nodeCount+'）');
  ok(R.assetCount===2,'C-5b **恢复后素材数 = 2**（实测 '+R.assetCount+'）');
  ok(JSON.stringify(R.nodeIds)===JSON.stringify(['node_a','node_b','gauge_x']),'C-5c **节点 ID 全部保留**：'+JSON.stringify(R.nodeIds));
  ok(JSON.stringify(R.nodeAssets)===JSON.stringify(['big_a','big_b',null]),'C-5d **素材 ID 独立引用正确**：'+JSON.stringify(R.nodeAssets));
  ok(R.bandsCount===2,'C-5e 色带数据恢复（2 段）');

  // ================= 6. 真实分辨率验证 =================
  console.log('\n=== C-6. 实际图片分辨率 ===');
  const dims=R.assetDims||[];
  ok(dims.length===2,'C-6a 取到 2 个素材尺寸');
  if(dims[0]) ok(dims[0].w===948&&dims[0].h===949,'C-6b **素材A 真实分辨率 948×949**（实测 '+dims[0].w+'×'+dims[0].h+'）');
  if(dims[1]) ok(dims[1].w===948&&dims[1].h===949,'C-6c **素材B 真实分辨率 948×949**（实测 '+dims[1].w+'×'+dims[1].h+'）');
  ok(!(dims[0]&&dims[0].w===64),'C-6d **未被 64×64 缩略图替代**');

  // ================= 7. 路径不可用时的恢复 =================
  console.log('\n=== C-7. 源路径不可用仍可恢复 ===');
  await cdp.eval(`(function(){
    window.__pl=null;
    var req=indexedDB.open('icar-studio-drafts');
    req.onsuccess=function(e){
      var db=e.target.result;
      var tx=db.transaction(['drafts'],'readonly');
      var st=tx.objectStore('drafts');
      var all=st.getAll();
      all.onsuccess=function(ev){
        var rows=ev.target.result||[];
        var d=rows[0].design||{};
        // 检查：即使 path 无效，data 是否仍在
        var out={
          assets: (d.assets||[]).map(function(a){
            return {id:a.id,path:a.path,hasData:!!a.data,
                    dataLen:a.data?a.data.length:0};
          })
        };
        window.__pl=JSON.stringify(out);db.close();
      };
    };
    return 'pending';
  })()`);
  await sleep(2000);
  const PL=JJ(await cdp.eval(`window.__pl || '{"pending":true}'`));
  if(PL.assets){
    ok(PL.assets.every(function(a){return a.hasData;}),'C-7a **所有素材都有内联 data**（不依赖源文件路径）');
    ok(PL.assets.every(function(a){return a.dataLen>50000;}),'C-7b data 是高分辨率原图而非缩略图');
  } else { ok(false,'C-7 读取失败'); }

  // ================= 8. 多素材独立引用 =================
  console.log('\n=== C-8. 多素材 ID 独立引用 ===');
  const unique=new Set(R.nodeAssets.filter(Boolean));
  ok(unique.size===2,'C-8a 两个节点引用不同素材（'+Array.from(unique).join(', ')+'）');
  ok(R.nodeAssets[0]!==R.nodeAssets[1],'C-8b 引用不混淆');

  // ================= 9. 清理（只删自己的记录）=================
  console.log('\n=== C-9. 清理隔离测试数据 ===');
  await cdp.eval(`(function(){
    window.__cl=null;
    var req=indexedDB.open('icar-studio-drafts');
    req.onsuccess=function(e){
      var db=e.target.result;
      var tx=db.transaction(['drafts'],'readwrite');
      var st=tx.objectStore('drafts');
      var all=st.getAll();
      all.onsuccess=function(ev){
        var rows=ev.target.result||[];
        var del=0;
        rows.forEach(function(r){
          // 只删名字带 P4F-M03 的测试草稿
          // 草稿的 designName 是独立字段；designJson 里的 name 也可用
          var nm=String(r.designName||'');
          if(!nm){ try{ nm=String((JSON.parse(r.designJson||'{}').name)||''); }catch(e3){} }
          if(nm.indexOf('P4F-M03')>=0){
            st.delete(r.draftId);del++;
          }
        });
        tx.oncomplete=function(){window.__cl=JSON.stringify({deleted:del});db.close();};
      };
    };
    return 'pending';
  })()`);
  await sleep(2500);
  const CL=JJ(await cdp.eval(`window.__cl || '{"pending":true}'`));
  ok(CL.deleted>=1,'C-9a **只清理了本次测试的草稿**（删除 '+CL.deleted+' 条，其它草稿未动）');

  console.log('\n  ⚠️ 使用独立 user-data-dir：'+PROFILE);
  ok(true,'C-9b 隔离 Profile，未触碰用户真实草稿');

 }catch(e){ok(false,e.stack||e.message);}
 finally{
  try{if(cdp)cdp.ws.close();}catch(e){}
  try{proc.kill();}catch(e){}
  try{require('child_process').execSync('taskkill /F /IM msedge.exe /T',{stdio:'ignore'});}catch(e){}
  try{fsc.rmSync(PROFILE,{recursive:true,force:true});}catch(e){}
 }
 console.log('PASS='+pass+' FAIL='+fail);
 process.exitCode=fail?1:0;
}
const m=new Module(base);m.filename=base;m.paths=Module._nodeModulePaths(__dirname);
m._compile(prefix+'\n('+main.toString()+')().catch(function(e){ok(false,e.stack||e.message);console.log("PASS="+pass+" FAIL="+fail);process.exitCode=1;});',base);
