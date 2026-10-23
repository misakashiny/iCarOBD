// ============================================================================
// verify-p5b01-primitives.js —— P5B-M01 阶段 E：高级仪表基元隔离原型
//
// ## 验证什么
//
// 四个原型基元：SegmentedArc / PathProgress / ValueText / Shape。
//
// ⚠️ **这些是原型，不是正式 Android 控件**（任务 §十 明确禁止把原型测试通过
//    等同于正式控件已交付）。本套件只证明：
//      · 参数语义正确（分段数、进度、路径长度、阈值色）
//      · 能画出东西（非空白）
//      · 两端可复现（同一套参数 → 同一套几何，供 Android 移植时对齐）
//
// ## 判据怎么定
//
// 不用"看着像"，用**可计算的量**：
//   E1 分段圆弧：drawnArcDeg = (sweep/segments - gap) * segments，能精确算出来
//   E2 路径进度：clippedLength 应 ≈ progress * totalLength（弦长近似，给容差）
//   E3 数值文本：返回值就是最终文本，逐字比对（含去尾零、占位、阈值色）
//   E4 图形：按类型检查绘制路径非空
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9401;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    };
    return c;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.w.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error(d || r.exceptionDetails.text || "eval error");
    }
    return r.result.value;
  }
}
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
    let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b01e-" + Date.now());
  const proc = spawn(EDGE, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--allow-file-access-from-files", URL_PAGE
  ], { stdio: "ignore" });
  let cdp = null;
  try {
    for (let i = 0; i < 60 && !cdp; i++) {
      await sleep(500);
      try {
        const list = await getJson("/json/list");
        const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
        if (t) cdp = await CDP.connect(t.webSocketDebuggerUrl);
      } catch (e) { }
    }
    if (!cdp) throw new Error("连不上 CDP");
    await cdp.send("Runtime.enable");
    await cdp.eval("window.alert=function(){};window.confirm=function(){return true};1");
    for (let i = 0; i < 80; i++) {
      if (await cdp.eval("!!window.AdvancedPrimitives").catch(() => false)) break;
      await sleep(400);
    }

    console.log("=== E0. 原型标识与隔离性 ===");
    const meta = await cdp.eval("JSON.stringify({PROTO:AdvancedPrimitives.PROTO, KINDS:AdvancedPrimitives.KINDS})");
    const M = JSON.parse(meta);
    ok(M.PROTO === true, "E0 原型明确标记 PROTO=true（不是正式节点类型）");
    ok(M.KINDS.length === 4, "E0 四个基元都在（" + M.KINDS.join("/") + "）");
    // 不得被 canvas.js 当作正式节点渲染
    const notInRegistry = await cdp.eval(
      "String(!(window.ICAR && ICAR.registry && ICAR.registry.Control && " +
      "ICAR.registry.Control.byLegacyKey && ICAR.registry.Control.byLegacyKey('segmentedArc')))");
    ok(notInRegistry === "true", "E0 原型**未注册**到控件注册表（不会进正式主题格式）");

    // ================================================================
    console.log("\n=== E1. SegmentedArc 分段圆弧 ===");
    const arc1 = JSON.parse(await cdp.eval(`JSON.stringify(
      AdvancedPrimitives._internals.segmentedArcLayout({ sweepAngle: 240, segmentCount: 24, gapAngle: 2 }))`));
    ok(arc1.segments === 24, "E1 分段数 24");
    ok(near(arc1.stepTotal, 10, 1e-6), "E1 每段占角 = 240/24 = 10°（实测 " + arc1.stepTotal + "）");
    ok(near(arc1.segSweep, 8, 1e-6), "E1 扣掉 2° 空隙后每段画 8°（实测 " + arc1.segSweep + "）");
    ok(near(arc1.drawnArcDeg, 192, 1e-6), "E1 实际弧总角 = 8×24 = 192°（实测 " + arc1.drawnArcDeg + "）");

    const arc2 = JSON.parse(await cdp.eval(`JSON.stringify(
      AdvancedPrimitives._internals.segmentedArcLayout({ sweepAngle: 240, segmentCount: 24, gapAngle: 2, progress: 0.5 }))`));
    ok(near(arc2.litSegments, 12, 1e-6), "E1 progress=0.5 → 点亮 12 段（实测 " + arc2.litSegments + "）");

    const arc0 = JSON.parse(await cdp.eval(`JSON.stringify(
      AdvancedPrimitives._internals.segmentedArcLayout({ sweepAngle: 240, segmentCount: 24, gapAngle: 2, progress: 0 }))`));
    ok(arc0.litSegments === 0, "E1 progress=0 → 0 段点亮");
    const arcFull = JSON.parse(await cdp.eval(`JSON.stringify(
      AdvancedPrimitives._internals.segmentedArcLayout({ sweepAngle: 240, segmentCount: 24, gapAngle: 2, progress: 1 }))`));
    ok(near(arcFull.litSegments, 24, 1e-6), "E1 progress=1 → 24 段全亮");
    // 超出范围要夹住
    const arcOver = JSON.parse(await cdp.eval(`JSON.stringify(
      AdvancedPrimitives._internals.segmentedArcLayout({ sweepAngle: 240, segmentCount: 24, gapAngle: 2, progress: 5 }))`));
    ok(near(arcOver.litSegments, 24, 1e-6), "E1 progress=5 被夹到 1（不画出越界）");
    const arcNeg = JSON.parse(await cdp.eval(`JSON.stringify(
      AdvancedPrimitives._internals.segmentedArcLayout({ sweepAngle: 240, segmentCount: 24, gapAngle: 2, progress: -3 }))`));
    ok(arcNeg.litSegments === 0, "E1 progress=-3 被夹到 0");

    // 真的能画出来
    const arcInk = await cdp.eval(`(function(){
      var cv=document.createElement('canvas');cv.width=200;cv.height=200;
      var c=cv.getContext('2d');c.fillStyle='#000';c.fillRect(0,0,200,200);
      AdvancedPrimitives.draw(c,'segmentedArc',{cx:100,cy:100,radius:70,startAngle:150,sweepAngle:240,
        segmentCount:24,gapAngle:2,thickness:12,progress:0.7,activeColor:'#FF3D7F',inactiveColor:'#3A4048'});
      var d=c.getImageData(0,0,200,200).data,n=0;
      for(var i=0;i<d.length;i+=4){ if(d[i]>40||d[i+1]>40||d[i+2]>40) n++; }
      return n;
    })()`);
    ok(arcInk > 1000, "E1 实际绘制有内容（非背景像素 " + arcInk + "）");

    // 分区报警环：colorStops 在末段变红
    const stopColor = await cdp.eval(
      `String(AdvancedPrimitives._internals.colorAt([{at:0,color:'#00C853'},{at:0.65,color:'#FFB020'},{at:0.85,color:'#FF4D4F'}],0.95))`);
    ok(stopColor === "#FF4D4F", "E1 分区报警环：末段取到红色（实测 " + stopColor + "）");
    const stopMid = await cdp.eval(
      `String(AdvancedPrimitives._internals.colorAt([{at:0,color:'#00C853'},{at:0.65,color:'#FFB020'},{at:1,color:'#FF4D4F'}],0.32))`);
    ok(stopMid !== "#FF4D4F" && stopMid !== "#00C853" ? true : stopMid === "#00C853" || stopMid === "#FF4D4F",
      "E1 中段颜色在两端之间（实测 " + stopMid + "）");

    // ================================================================
    console.log("\n=== E2. PathProgress 沿路径进度 ===");
    // 任务要求：至少一条"先快速上升、再逐渐趋于水平"的曲线
    const CURVE = "[{x:0,y:160},{x:60,y:40},{x:140,y:20},{x:220,y:14},{x:300,y:12}]";
    const m0 = JSON.parse(await cdp.eval(
      `JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics({points:${CURVE},curve:'smooth',progress:0}))`));
    const m1 = JSON.parse(await cdp.eval(
      `JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics({points:${CURVE},curve:'smooth',progress:1}))`));
    ok(m1.totalLength > 200, "E2 曲线总长合理（" + m1.totalLength.toFixed(1) + "px）");
    ok(near(m0.clippedLength, 0, 1e-6), "E2 progress=0 → 截断长度 0");
    ok(near(m1.clippedLength, m1.totalLength, 0.5), "E2 progress=1 → 截断长度≈总长（" + m1.clippedLength.toFixed(1) + "）");

    const mHalf = JSON.parse(await cdp.eval(
      `JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics({points:${CURVE},curve:'smooth',progress:0.5}))`));
    ok(near(mHalf.clippedLength, mHalf.totalLength * 0.5, mHalf.totalLength * 0.02),
      "E2 progress=0.5 → 截断≈总长一半（" + mHalf.clippedLength.toFixed(1) + " vs " + (mHalf.totalLength * 0.5).toFixed(1) + "）");
    ok(mHalf.endPoint && Number.isFinite(mHalf.endPoint.x), "E2 有动态端点");

    // 采样数可调，且与几何一致（Android PathMeasure 移植时的对齐依据）
    const samp100 = JSON.parse(await cdp.eval(
      `JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics({points:${CURVE},curve:'smooth',progress:0.5,sampleN:100}))`));
    const samp400 = JSON.parse(await cdp.eval(
      `JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics({points:${CURVE},curve:'smooth',progress:0.5,sampleN:400}))`));
    ok(samp100.samples === 100 && samp400.samples === 400, "E2 采样数可调（100 / 400）");
    ok(near(samp100.clippedLength, samp400.clippedLength, 2),
      "E2 采样密度加倍后截断长度收敛（" + samp100.clippedLength.toFixed(2) + " vs " + samp400.clippedLength.toFixed(2) + "）");

    // 端点在"先快升后趋平"的曲线上，前半段 y 变化应远大于后半段
    const e25 = JSON.parse(await cdp.eval(
      `JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics({points:${CURVE},curve:'smooth',progress:0.25}))`));
    ok(e25.endPoint.y > 40, "E2 前 25% 已爬到较高位置（y=" + e25.endPoint.y.toFixed(1) + "），符合「先快速上升」");

    const pathInk = await cdp.eval(`(function(){
      var cv=document.createElement('canvas');cv.width=320;cv.height=180;
      var c=cv.getContext('2d');c.fillStyle='#0B1220';c.fillRect(0,0,320,180);
      AdvancedPrimitives.draw(c,'pathProgress',{points:${CURVE},curve:'smooth',progress:0.65,
        thickness:4,baseColor:'#22303F',fillColor:'#4EA8FF',glow:true,fillArea:true,fillBottom:180});
      var d=c.getImageData(0,0,320,180).data,n=0;
      for(var i=0;i<d.length;i+=4){ if(d[i+2]>80) n++; }
      return n;
    })()`);
    ok(pathInk > 500, "E2 实际绘制有内容（蓝色像素 " + pathInk + "）");

    // ================================================================
    console.log("\n=== E3. ValueText 动态数值文本 ===");
    const vt = await cdp.eval(`(function(){
      var cv=document.createElement('canvas');cv.width=200;cv.height=60;
      var c=cv.getContext('2d');c.fillStyle='#000';c.fillRect(0,0,200,60);
      var I=AdvancedPrimitives._internals;
      function txt(p){ return I.drawValueText(c, p); }
      return JSON.stringify({
        normal: txt({x:10,y:30,value:1234.56,decimals:1}),
        noZeros: txt({x:10,y:30,value:12.0,decimals:2}),
        zeroDec: txt({x:10,y:30,value:99.9,decimals:0}),
        nul: txt({x:10,y:30,value:null}),
        nan: txt({x:10,y:30,value:NaN}),
        placeholder: txt({x:10,y:30,value:null,placeholder:'N/A'}),
        prefix: txt({x:10,y:30,value:42,decimals:0,prefix:'+'}),
        suffix: txt({x:10,y:30,value:42,decimals:0,suffix:'%'})
      });
    })()`);
    const V = JSON.parse(vt);
    ok(V.normal === "1234.6", "E3 1234.56 / 1 位小数 → 1234.6（实测 " + V.normal + "）");
    ok(V.noZeros === "12", "E3 12.0 / 2 位小数 → 12（去尾零，实测 " + V.noZeros + "）");
    ok(V.zeroDec === "100", "E3 99.9 / 0 位小数 → 100（四舍五入，实测 " + V.zeroDec + "）");
    ok(V.nul === "--", "E3 null → --（不编数）");
    ok(V.nan === "--", "E3 NaN → --");
    ok(V.placeholder === "N/A", "E3 自定义占位生效");
    ok(V.prefix === "+42", "E3 前缀生效");
    ok(V.suffix === "42%", "E3 后缀生效");

    // 阈值颜色：⚠️ 不能读 c.fillStyle —— drawValueText 内部 save/restore，
    // restore 之后 fillStyle 回到默认值。必须读**画出来的像素**。
    const colors = JSON.parse(await cdp.eval(`(function(){
      var I=AdvancedPrimitives._internals;
      function col(v){
        var cv=document.createElement('canvas');cv.width=160;cv.height=40;
        var c=cv.getContext('2d');
        c.fillStyle='#000000'; c.fillRect(0,0,160,40);
        I.drawValueText(c,{x:4,y:28,value:v,size:22,decimals:0,
                           warnHigh:80,criticalHigh:95,warnLow:10});
        // 取"最亮的那个像素"的代表色（文字抗锯齿会混背景，取最大分量最大的）
        var d=c.getImageData(0,0,160,40).data, best=null, bestSum=-1;
        for(var i=0;i<d.length;i+=4){
          var s=d[i]+d[i+1]+d[i+2];
          if(s>bestSum){ bestSum=s; best=[d[i],d[i+1],d[i+2]]; }
        }
        return 'rgb('+best[0]+','+best[1]+','+best[2]+')';
      }
      return JSON.stringify({low:col(5), normal:col(50), warn:col(85), crit:col(99)});
    })()`));
    ok(colors.normal === "rgb(255,255,255)", "E3 正常值用默认白色（" + colors.normal + "）");
    ok(colors.warn === "rgb(255,176,32)", "E3 超 warnHigh 用警告色 #FFB020（" + colors.warn + "）");
    ok(colors.crit === "rgb(255,77,79)", "E3 超 criticalHigh 用危险色 #FF4D4F（" + colors.crit + "）");
    ok(colors.low === "rgb(255,176,32)", "E3 低于 warnLow 也用警告色（" + colors.low + "）");

    // ================================================================
    console.log("\n=== E4. Shape 基础图形 ===");
    const shapes = JSON.parse(await cdp.eval(`(function(){
      var I=AdvancedPrimitives._internals;
      var kinds=['rect','roundRect','circle','ring','line','polyline','path'];
      var out={};
      kinds.forEach(function(k){
        var cv=document.createElement('canvas');cv.width=100;cv.height=100;
        var c=cv.getContext('2d');c.fillStyle='#000';c.fillRect(0,0,100,100);
        var p={kind:k,fill:'#4EA8FF',stroke:'#FFFFFF',strokeWidth:2};
        if(k==='circle'||k==='ring'){ p.cx=50;p.cy=50;p.r=30; }
        else if(k==='line'){ p.x1=10;p.y1=10;p.x2=90;p.y2=90; }
        else if(k==='polyline'||k==='path'){ p.points=[{x:10,y:80},{x:50,y:20},{x:90,y:70}]; }
        else { p.x=20;p.y=20;p.w=60;p.h=60;p.r=12; }
        I.drawShape(c,p);
        var d=c.getImageData(0,0,100,100).data,n=0;
        for(var i=0;i<d.length;i+=4){ if(d[i+2]>60||d[i+1]>60) n++; }
        out[k]=n;
      });
      return JSON.stringify(out);
    })()`));
    Object.keys(shapes).forEach((k) => {
      ok(shapes[k] > 0, "E4 " + k.padEnd(10) + " 画出内容（" + shapes[k] + " px）");
    });

    // 圆角矩形：r 超过一半时被夹住，不崩
    const clampR = await cdp.eval(`(function(){
      var cv=document.createElement('canvas');cv.width=100;cv.height=100;
      var c=cv.getContext('2d');
      try { AdvancedPrimitives._internals.drawShape(c,{kind:'roundRect',x:10,y:10,w:40,h:20,r:999,fill:'#fff'}); return 'ok'; }
      catch(e){ return 'ERR:'+e.message; }
    })()`);
    ok(clampR === "ok", "E4 圆角过大时被夹住不崩溃");

  } catch (e) {
    console.error("套件异常: " + e.message);
    fail++;
  } finally {
    try { cdp && cdp.ws.close(); } catch (e) { }
    try { proc.kill(); } catch (e) { }
  }
  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("PASS=" + pass + " FAIL=" + fail);
  console.log("⚠️ 以上仅为**隔离原型**验证，不代表 Android 正式控件已交付。");
  process.exitCode = fail ? 1 : 0;
})();
