// ============================================================================
// 排版一致性（v2.44.0）
//
// ## 为什么要有这个套件
//
// 我不看图，排版问题只能**量化**才看得见。这个套件把"看着乱"翻译成数值：
//
//   行高有几种？  →  同一块面板里不该出现 5 种行高
//   控件高有几种？→  输入框 / 下拉 / 滑块 / 颜色块应当同高
//   圆角有几种？  →  应当收敛成少数几档（有变量管着）
//   命中区多小？  →  图标按钮不该小于 16px
//   文字被切了？  →  该有省略号
//
// 这些都是**改 CSS 时最容易悄悄改坏**的东西（不会报错、不会让别的测试红）。
// ============================================================================
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const URL_PAGE = require('url').pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const PORT = 9390;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));

const PROBE = `(() => {
  const vis = el => { const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden')return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; };
  const tally = a => { const h={}; a.forEach(v=>{h[v]=(h[v]||0)+1;}); return Object.entries(h).sort((x,y)=>y[1]-x[1]); };
  const R = {};
  const props = document.getElementById('props');

  // 属性面板：行高 / 控件高
  const rows = Array.from(props.querySelectorAll('.prow')).filter(vis);
  R.rowHeights = tally(rows.map(e => Math.round(e.getBoundingClientRect().height)));
  const ins = Array.from(props.querySelectorAll('.prow input, .prow select')).filter(vis);
  R.inputHeights = tally(ins.map(e => Math.round(e.getBoundingClientRect().height)));
  const txt = Array.from(props.querySelectorAll('.prow input[type=text], .prow input[type=number], .prow input:not([type]), .prow select')).filter(vis);
  R.textCtlHeights = [...new Set(txt.map(e => Math.round(e.getBoundingClientRect().height)))];
  // 标签列
  // ⚠️ 只统计**行标签**（左列那个）。.chk 也是 label，但它是勾选框的容器，
  // 宽度本来就该弹性（.chk 的 flex 是 1 1 auto）—— 把它算进来会误判。
  const lb = Array.from(props.querySelectorAll('.prow > label')).filter(e => vis(e) && !e.classList.contains('chk'));
  R.labelClip = lb.filter(e => e.scrollWidth > e.clientWidth + 1).length;
  R.labelWidths = [...new Set(lb.map(e => Math.round(e.getBoundingClientRect().width)))];
  // 溢出
  R.propOverflow = 0;
  props.querySelectorAll('*').forEach(el => {
    if (!vis(el)) return; const p = el.parentElement; if (!p || !vis(p)) return;
    const a = el.getBoundingClientRect(), b = p.getBoundingClientRect();
    if (Math.max(0, a.right-b.right) + Math.max(0, b.left-a.left) > 4) R.propOverflow++;
  });
  // 面板内字号 / 圆角
  const fs={}, rd={};
  props.querySelectorAll('*').forEach(el=>{ if(!vis(el))return; const cs=getComputedStyle(el);
    fs[cs.fontSize]=(fs[cs.fontSize]||0)+1;
    if(cs.borderRadius&&cs.borderRadius!=='0px') rd[cs.borderRadius]=(rd[cs.borderRadius]||0)+1; });
  R.propFontSizes = Object.keys(fs);
  R.propRadii = Object.keys(rd);

  // 全局：命中区过小的图标按钮
  R.smallIconBtns = [];
  document.querySelectorAll('.tbtn, .pbBtn, .pbCaret, .pcaret').forEach(el=>{
    if(!vis(el))return; const r=el.getBoundingClientRect();
    if (r.width < 16 || r.height < 16) R.smallIconBtns.push({ c:(typeof el.className==='string'?el.className.split(/\\s+/)[0]:''), w:Math.round(r.width), h:Math.round(r.height), t:el.textContent.trim() });
  });
  // 同一类按钮宽度是否一致
  const tbtnW = [...new Set(Array.from(document.querySelectorAll('.tbtn')).filter(vis).map(e=>Math.round(e.getBoundingClientRect().width)))];
  R.tbtnWidths = tbtnW;

  // 全局字号 / 圆角
  const gfs={}, grd={};
  document.querySelectorAll('*').forEach(el=>{ if(!vis(el))return; const cs=getComputedStyle(el);
    gfs[cs.fontSize]=(gfs[cs.fontSize]||0)+1;
    if(cs.borderRadius&&cs.borderRadius!=='0px'&&!cs.borderRadius.includes(' ')) grd[cs.borderRadius]=(grd[cs.borderRadius]||0)+1; });
  R.globalFontSizes = Object.keys(gfs);
  R.globalRadii = Object.entries(grd).filter(([k,v])=>v>=3).map(([k])=>k);

  // 素材名有省略号
  const nm = Array.from(document.querySelectorAll('.atName'));
  R.atName = { n: nm.length, ellipsis: nm.length?getComputedStyle(nm[0]).textOverflow:'?', nowrap: nm.length?getComputedStyle(nm[0]).whiteSpace:'?' };
  R.thumbW = [...new Set(Array.from(document.querySelectorAll('.assetThumb')).map(e=>Math.round(e.getBoundingClientRect().width)))];
  R.chipW = [...new Set(Array.from(document.querySelectorAll('.ctrlChip')).map(e=>Math.round(e.getBoundingClientRect().width)))];

  // ---- (C) 工具栏 / 页签 / 徽章 的高度一致性 ----
  //
  // ⚠️ 这三处原来都"靠内容推高度"，而 line-height: normal 下
  // **不同字体面的固有行高不同** —— .icon 带 font-weight:600（semibold），
  // 比常规体高 1px，于是同一排按钮 28px / 29px 混着。
  const hbtn = Array.from(document.querySelectorAll("header button")).filter(vis);
  R.toolbarBtnHeights = [...new Set(hbtn.map(e => Math.round(e.getBoundingClientRect().height)))];
  R.toolbarBtnCount = hbtn.length;
  const ver = Array.from(document.querySelectorAll("header .ver")).filter(vis);
  R.verHeights = [...new Set(ver.map(e => Math.round(e.getBoundingClientRect().height)))];
  const tabs = Array.from(document.querySelectorAll("#pageTabs .pgTab, #pageTabs .pgAdd")).filter(vis);
  R.tabHeights = [...new Set(tabs.map(e => Math.round(e.getBoundingClientRect().height)))];
  R.tabCount = tabs.length;

  // ---- (B) 素材格子的内容不能溢出格子本身 ----
  //
  // 注意：要用**每个格子自己的** rect 去比 —— 拿第一个格子的 rect 去比所有格子，
  // 不同行 y 不同，会得到一堆假溢出（我第一版就是这么错的）。
  R.thumbOverflow = 0;
  Array.from(document.querySelectorAll(".assetThumb")).slice(0, 80).forEach(th => {
    const tr = th.getBoundingClientRect();
    Array.from(th.children).forEach(c => {
      const a = c.getBoundingClientRect();
      if (a.bottom > tr.bottom + 1 || a.right > tr.right + 1) R.thumbOverflow++;
    });
  });

  R.docScrollX = document.documentElement.scrollWidth > document.documentElement.clientWidth + 2;
  return JSON.stringify(R);
})()`;

(async () => {
  const proc = spawn(EDGE, ['--headless=new','--disable-gpu','--no-first-run',`--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-layout`,'--window-size=1680,1050','about:blank'],{stdio:'ignore'});
  try {
    for (let i=0;i<40;i++){ try{ await getJson('/json/version'); break; }catch(e){ await sleep(250); } }
    const t = (await getJson('/json/list')).find(x=>x.type==='page');
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
    let id=0; const w=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}};
    const send=(m,p)=>new Promise(res=>{const i=++id;w.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}));});
    const ev=async(x)=>{const r=await send('Runtime.evaluate',{expression:x,returnByValue:true,awaitPromise:true});
      if(r.result&&r.result.exceptionDetails)return 'ERR: '+r.result.exceptionDetails.text;
      return r.result&&r.result.result?r.result.result.value:'?';};
    await send('Runtime.enable');
    await send('Page.navigate',{url:URL_PAGE});
    for(let i=0;i<80;i++){ if(await ev("!!(window.CanvasState && Array.isArray(window.BUILTIN_ASSETS) && window.BUILTIN_ASSETS.length>0)")===true) break; await sleep(300); }
    await sleep(600);
    await require('./_common').stubDialogs({ eval: ev });
    // 造一个内容最满的仪表：parts + 各种字段
    await ev(`(()=>{const S=window.CanvasState; window.renderAssets=function(){};
      const n = window.createNode(window.NODE_GAUGE,{name:'排版体检',pid:'obd.rpm',style:0,min:0,max:8000,warnHigh:6500,x:40,y:40,w:200,h:200});
      n.parts=[window.normalizePart({kind:'dial',x:0,y:0,w:200,h:200}),
               window.normalizePart({kind:'needle',x:76,y:4,w:48,h:192,pivotX:0.5,pivotY:0.5,sweepFrom:135,sweepTo:405,sweepFollow:true}),
               window.normalizePart({kind:'value',x:60,y:130,w:80,h:40})];
      S.design.nodes=[n]; S.selection=[n.id];
      if(window.onSelectionChanged)window.onSelectionChanged();
      if(window.renderProps)window.renderProps();
      document.querySelectorAll('#props .pcaret').forEach(c=>{ const b=c.parentElement&&c.parentElement.nextElementSibling; if(b&&b.classList&&b.classList.contains('panelBody')&&!b.offsetHeight) c.click(); });
      if(window.renderProps)window.renderProps();
      return 1;})()`);
    await sleep(800);
    const raw = await ev(PROBE);
    if (typeof raw === 'string' && raw.startsWith('ERR')) { console.log('  ❌ ' + raw); fail++; }
    else {
      const R = JSON.parse(raw);

      console.log('\n=== 1. 属性面板的行高 ===');
      console.log('    · ' + JSON.stringify(R.rowHeights));
      const kinds = R.rowHeights.length;
      ok(kinds <= 3, '**行高种类 ≤ 3**（实测 ' + kinds + ' 种：' + R.rowHeights.map(([h,n])=>h+'px×'+n).join(', ') + '）');
      ok(R.rowHeights.every(([h]) => +h <= 40), '没有异常高的行（最高 ' + Math.max(...R.rowHeights.map(([h])=>+h)) + 'px）');

      console.log('\n=== 2. 属性面板的控件高度 ===');
      console.log('    · 全部: ' + JSON.stringify(R.inputHeights));
      console.log('    · 文本框/数字/下拉: ' + JSON.stringify(R.textCtlHeights));
      eq(R.textCtlHeights.length, 1, '**文本框/数字/下拉 高度完全一致**（' + JSON.stringify(R.textCtlHeights) + '）');
      ok(R.inputHeights.every(([h]) => +h <= 28), '没有异常高的控件');

      console.log('\n=== 3. 属性面板的标签列 ===');
      console.log('    · 宽度: ' + JSON.stringify(R.labelWidths));
      eq(R.labelWidths.length, 1, '标签列宽度统一（' + R.labelWidths.join('/') + 'px）');
      eq(R.labelClip, 0, '**没有被挤压的标签**');
      eq(R.propOverflow, 0, '**属性面板内零溢出**');

      console.log('\n=== 4. 面板内的字号与圆角 ===');
      console.log('    · 字号: ' + JSON.stringify(R.propFontSizes));
      console.log('    · 圆角: ' + JSON.stringify(R.propRadii));
      ok(R.propFontSizes.length <= 5, '面板内字号种类 ≤ 5（实测 ' + R.propFontSizes.length + '）');
      ok(!R.propFontSizes.includes('13.3333px'), '**没有继承浏览器默认字号的元素**（13.3333px）');
      ok(R.propRadii.length <= 4, '面板内圆角种类 ≤ 4（实测 ' + R.propRadii.length + '）');

      console.log('\n=== 5. 图标按钮的命中区与一致性 ===');
      console.log('    · 过小的: ' + (R.smallIconBtns.length ? JSON.stringify(R.smallIconBtns.slice(0,6)) : '无'));
      console.log('    · .tbtn 宽度种类: ' + JSON.stringify(R.tbtnWidths));
      eq(R.smallIconBtns.length, 0, '**没有 <16px 的图标按钮**');
      ok(R.tbtnWidths.length <= 2, '.tbtn 宽度种类 ≤ 2（实测 ' + R.tbtnWidths.length + '：' + R.tbtnWidths.join('/') + '）');

      console.log('\n=== 6. 全局字号与圆角 ===');
      console.log('    · 字号: ' + JSON.stringify(R.globalFontSizes));
      console.log('    · 圆角(≥3次): ' + JSON.stringify(R.globalRadii));
      ok(R.globalFontSizes.length <= 8, '全局字号种类 ≤ 8（实测 ' + R.globalFontSizes.length + '）');
      ok(R.globalRadii.length <= 4, '**全局圆角收敛到 ≤ 4 档**（实测 ' + R.globalRadii.length + '：' + R.globalRadii.join('/') + '）');

      console.log('\n=== 7. 素材库 / 控件库 ===');
      console.log('    · 缩略图宽度: ' + JSON.stringify(R.thumbW) + '   芯片宽度: ' + JSON.stringify(R.chipW));
      console.log('    · .atName: ' + JSON.stringify(R.atName));
      eq(R.thumbW.length, 1, '素材缩略图宽度统一');
      eq(R.chipW.length, 1, '控件芯片宽度统一');
      eq(R.atName.ellipsis, 'ellipsis', '**素材名有省略号**（长名字不会溢出）');
      eq(R.atName.nowrap, 'nowrap', '素材名不换行');

      console.log('\n=== 8. 工具栏 / 页签 的高度一致性 ===');
      console.log("    · 工具栏按钮 " + R.toolbarBtnCount + " 个，高度 " + JSON.stringify(R.toolbarBtnHeights));
      console.log("    · .ver 徽章高度 " + JSON.stringify(R.verHeights));
      console.log("    · 页签高度 " + JSON.stringify(R.tabHeights) + "（" + R.tabCount + " 个）");
      eq(R.toolbarBtnHeights.length, 1, "**工具栏按钮高度完全一致**（" + R.toolbarBtnHeights.join("/") + "px，" + R.toolbarBtnCount + " 个）");
      eq(R.verHeights.length, 1, "`.ver` 徽章高度一致（" + R.verHeights.join("/") + "px）");
      eq(R.tabHeights.length, 1, "**页签高度一致**（" + R.tabHeights.join("/") + "px）");

      console.log('\n=== 9. 素材格子不溢出 ===');
      console.log("    · 溢出次数 " + R.thumbOverflow);
      eq(R.thumbOverflow, 0, "**素材格子的内容不溢出格子**");

      console.log('\n=== 10. 搜索的过滤与噪音 ===');
      {
        const countVis = `(() => { const vis = el => { if(!el) return false; const s=getComputedStyle(el); if(s.display==="none"||s.visibility==="hidden") return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; };
          return JSON.stringify({ thumbs: Array.from(document.querySelectorAll(".assetThumb")).filter(vis).length,
            chips: Array.from(document.querySelectorAll(".ctrlChip")).filter(vis).length,
            kinds: Array.from(document.querySelectorAll(".akind")).filter(vis).length }); })()`;
        const base = JSON.parse(await ev(countVis));
        // 搜一个只有少数命中的词
        await ev(`(() => { const se=document.getElementById("assetSearch");
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
          set.call(se,"圆表"); se.dispatchEvent(new Event("input",{bubbles:true})); return 1; })()`);
        await sleep(500);
        const filtered = JSON.parse(await ev(countVis));
        // 清空
        await ev(`(() => { const se=document.getElementById("assetSearch");
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
          set.call(se,""); se.dispatchEvent(new Event("input",{bubbles:true})); return 1; })()`);
        await sleep(500);
        const restored = JSON.parse(await ev(countVis));
        console.log("    · 搜前 " + JSON.stringify(base) + " → 搜「圆表」" + JSON.stringify(filtered) + " → 清空 " + JSON.stringify(restored));
        ok(filtered.thumbs < base.thumbs && filtered.chips < base.chips, "**搜索真的在过滤**（素材 " + base.thumbs + "→" + filtered.thumbs + "，控件 " + base.chips + "→" + filtered.chips + "）");
        ok(filtered.kinds < base.kinds, "**搜索时隐藏没命中的分类**（" + base.kinds + "→" + filtered.kinds + " 个分类头）");
        eq(restored.thumbs, base.thumbs, "清空搜索后素材恢复（" + restored.thumbs + "）");
        eq(restored.chips, base.chips, "清空搜索后控件恢复（" + restored.chips + "）");
      }

      console.log('\n=== 11. 搜索支持拼音 ===');
      {
        const cnt = `(() => { const vis = el => { if(!el) return false; const s=getComputedStyle(el); if(s.display==="none") return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; };
          return JSON.stringify({ t: Array.from(document.querySelectorAll(".assetThumb")).filter(vis).length,
            c: Array.from(document.querySelectorAll(".ctrlChip")).filter(vis).length }); })()`;
        const type = q => `(() => { const se=document.getElementById("assetSearch");
          const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
          set.call(se, ${JSON.stringify(q)}); se.dispatchEvent(new Event("input",{bubbles:true})); return 1; })()`;
        const search = async q => { await ev(type(q)); await sleep(450); return JSON.parse(await ev(cnt)); };

        ok(await ev("typeof window.matchPinyin === \"function\""), "**`window.matchPinyin` 已加载**（js/pinyin.js）");
        const cn = await search("碳纤维");
        const full = await search("tanxianwei");
        const ini = await search("txw");
        const blank = await search("");
        console.log("    · 碳纤维 " + JSON.stringify(cn) + " / tanxianwei " + JSON.stringify(full) + " / txw " + JSON.stringify(ini));
        ok(cn.t > 0 && cn.t < 50, "中文能搜到（" + cn.t + " 个素材）");
        eq(full.t, cn.t, "**全拼与中文结果一致**（" + full.t + "）");
        eq(ini.t, cn.t, "**首字母与中文结果一致**（" + ini.t + "）");
        eq(blank.t, 355, "清空后恢复全部素材");

        // 反例：不存在的拼音不该命中
        const none = await search("zzzzz");
        eq(none.t, 0, "不存在的拼音搜不到东西");
        await ev(type("")); await sleep(400);
      }

      console.log('\n=== 12. 界面设置（缩放） ===');
      {
        // 用表头 h1 的宽度当尺子 —— 它会等比缩放
        const ruler = `(() => { const h=document.querySelector("header h1"); const r=h?h.getBoundingClientRect():null;
          return r ? Math.round(r.width*100)/100 : null; })()`;
        const zoomNow = `(() => (window.SETTINGS||{}).zoom)()`;

        const btnExists = await ev(`!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("设置"))`);
        ok(btnExists, "**顶栏有「⚙ 设置」按钮**");

        const base = await ev(ruler);
        eq(await ev(zoomNow), 1, "默认缩放是 1.0");

        await ev(`window.setUiZoom(1.15); 1`); await sleep(400);
        const big = await ev(ruler);
        await ev(`window.setUiZoom(0.85); 1`); await sleep(400);
        const small = await ev(ruler);
        console.log("    · h1 宽: 100% " + base + " / 115% " + big + " / 85% " + small);
        ok(big > base * 1.1, "**放大到 115% 真的变大了**（" + base + " → " + big + "）");
        ok(small < base * 0.9, "**缩小到 85% 真的变小了**（" + base + " → " + small + "）");
        ok(Math.abs(small - big) > 20, "两档之间有可见差距（" + Math.round(big - small) + "px）");

        // 越界拒绝
        await ev(`window.setUiZoom(5); 1`);
        eq(await ev(zoomNow), 0.85, "越界值（5）被拒绝，仍是 0.85");
        await ev(`window.setUiZoom(0.1); 1`);
        eq(await ev(zoomNow), 0.85, "越界值（0.1）被拒绝");

        // 持久化 + 恢复默认
        const stored = await ev(`localStorage.getItem("icar-studio-ui")`);
        ok(stored && stored.includes("0.85"), "**缩放写进了 localStorage**（" + stored + "）");
        await ev(`window.resetSettings(); 1`); await sleep(300);
        eq(await ev(zoomNow), 1, "**恢复默认回到 1.0**");
        eq(await ev(`localStorage.getItem("icar-studio-ui")`), null, "恢复默认把存储也清了");
        const back = await ev(ruler);
        ok(Math.abs(back - base) < 1, "恢复后尺子回到原值（" + back + " vs " + base + "）");
      }

      console.log('\n=== 13. 切主题 → 画布真的变色 ===');
      {
        // ⚠️ 这条是用户报的 bug：「切换主题时、控件里的跟随主题选项、其他并没有刷新」。
        //
        // 根因是 `canvas.js` **从来没读过 GAUGE_THEMES**（只有 model.js 序列化时读），
        // 画布用的是工具自己的 UI 配色。
        //
        // 判定用「画布指纹」—— 不能只看"变了没"，还要看**变成主题的色了吗**。
        const fp = `(() => {
          const cv = document.getElementById("cv");
          const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
          let h = 0; const colors = {};
          for (let i = 0; i < d.length; i += 97) {
            for (let c = 0; c < 4; c++) h = (h * 31 + d[i + c]) % 2147483647;
            if (d[i + 3] > 200) { const k = d[i]+","+d[i+1]+","+d[i+2]; colors[k] = (colors[k]||0)+1; }
          }
          const top = Object.entries(colors).sort((x,y)=>y[1]-x[1]).slice(0,6).map(x=>x[0]);
          return JSON.stringify({ h: h, top: top });
        })()`;

        ok(await ev(`typeof window.currentTheme === "function"`), "**`window.currentTheme()` 存在**");

        // 造一个走 drawGaugeNode 的圆表（card/track/value 都会上色）
        await ev(`(() => {
          const S = window.CanvasState;
          window.renderAssets = function(){};
          const n = window.createNode(window.NODE_GAUGE, { name:"主题验证", pid:"obd.rpm", style:0,
            min:0, max:8000, cardStyle:0, x:60, y:60, w:260, h:260 });
          S.design.nodes = [n]; S.selection = [];
          S.design.themeColorsOverride = null;
          S.design.themeId = "neon"; if (window.draw) window.draw(); return 1; })()`);
        await sleep(400);
        const neon = JSON.parse(await ev(fp));

        await ev(`(() => { window.CanvasState.design.themeId = "ice"; window.draw(); return 1; })()`);
        await sleep(400);
        const ice = JSON.parse(await ev(fp));

        await ev(`(() => { window.CanvasState.design.themeId = "amber"; window.draw(); return 1; })()`);
        await sleep(400);
        const amber = JSON.parse(await ev(fp));

        console.log("    · neon 主色 " + JSON.stringify(neon.top.slice(0,3)));
        console.log("    · ice  主色 " + JSON.stringify(ice.top.slice(0,3)));
        console.log("    · amber 主色 " + JSON.stringify(amber.top.slice(0,3)));
        ok(neon.h !== ice.h, "**切 neon → ice，画布指纹变了**");
        ok(ice.h !== amber.h, "**切 ice → amber，画布指纹也变了**");
        ok(neon.h !== amber.h, "neon 与 amber 也不同");

        // 主题主色应当真的出现在画面上
        const has = (top, hex) => {
          const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
          return top.some(s => { const p = s.split(",").map(Number); return Math.abs(p[0]-r)<=6 && Math.abs(p[1]-g)<=6 && Math.abs(p[2]-b)<=6; });
        };
        ok(has(neon.top, "#FF8A00"), "**neon 的主色 #FF8A00 出现在画布上**");
        ok(has(ice.top, "#28D7FF"), "**ice 的主色 #28D7FF 出现在画布上**");
        ok(has(amber.top, "#E3A83B"), "**amber 的主色 #E3A83B 出现在画布上**");

        // 画布**底色**也要跟主题（它占的面积最大，"主题没生效"的观感一半来自它）
        ok(has(neon.top, "#080A0E"), "**neon 的画布底色 #080A0E 生效**");
        ok(has(ice.top, "#071018"), "**ice 的画布底色 #071018 生效**");
        ok(has(amber.top, "#0B0B09"), "**amber 的画布底色 #0B0B09 生效**");
        // 反过来：不该还是工具的 --cvIn（#05070A）刷满整块
        const cvInStill = neon.top[0] === "5,7,10" && ice.top[0] === "5,7,10" && amber.top[0] === "5,7,10";
        ok(!cvInStill, "**画布底色不再固定为工具的 #05070A**");

        // 清干净，别影响后面的用例
        await ev(`(() => { const S=window.CanvasState; S.design.nodes=[]; S.design.themeId=""; S.design.themeColorsOverride=null;
          if (window.draw) window.draw(); return 1; })()`);
        await sleep(300);
      }

      console.log('\n=== 14. 文档不出现横向滚动 ===');
      ok(!R.docScrollX, '**没有横向滚动条**');
    }
    await ws.close();
  } catch(e){ console.log('  ❌ 执行失败: ' + e.message); fail++; }
  finally { proc.kill(); }
  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
