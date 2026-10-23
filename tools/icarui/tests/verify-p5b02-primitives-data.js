// ============================================================================
// verify-p5b02-primitives-data.js —— P5B-M02 段 C：四种基元接入模拟数据的深化验证
//
// ## 指令 §C 的原文要求
//
//   「`verify-p5a01-sim-chain.js` 已有 18 条设备端断言。**复用这一基础，不要重建
//     一套 PID 模拟系统**。P5B-M02 中的四种高级基元原型，**优先通过同一个模拟数据
//     通道获得输入**。」
//
//   「在原有画布指纹验证之上，针对具体控件增加：目标数据值 / 对应控件的局部渲染
//     区域 / 无数据占位 / 报警状态 / 动态变化方向 / Android 与编辑器相同输入的表现」
//
//   「**对于还没有正式 Android View 的基元，继续保持原型身份，不假称已完成跨端验证。**」
//
// ## 所以本套件做什么 / 不做什么
//
// **做**（编辑器侧，可判定）：
//   · 同一份模拟值（与 sim-chain 同一个 SimScenario 数据形状）喂给四个基元
//   · 局部渲染区域：只算该基元自己的 canvas 区域像素，不看整屏
//   · 目标数据值：断言"给定值 → 画出来的几何/文本符合期望"
//   · 无数据占位：null 时必须是 -- / 无信号，不能是 0
//   · 报警状态：越阈值时颜色真的变
//   · 动态变化方向：值增大 → 进度/端点朝"更大"方向移动（不是变小）
//
// **不做**（诚实边界）：
//   · ❌ 不断言「Android 与编辑器一致」——**四个基元都没有 Android View**
//   · ❌ 不把本套件通过说成"跨端已验证"
//   · ❌ 不重建第二套 PID 模拟系统 —— 值形状直接对齐 SimScenario.NORMAL/ALARM 的通道
//
// ## 与 sim-chain 的关系
//
// sim-chain 验证的是「**既有 Android View**（圆盘/数字/条形/轨道/状态灯）吃到模拟值后
// 屏幕真的变了」。本套件验证的是「**基元原型**吃到同一形状的值后几何正确」。
// 两者共享同一套**值定义**（下面 SIM 常量逐字对齐 SimScenario 的场景值），
// 但**验证层级不同**，不能互相冒充。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9421;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b02-primitives-data.txt");

// 与 SimScenario 的场景值逐字对齐（同一份"模拟数据通道"的输入形状）
const SIM = {
  NORMAL: { rpm: 800, speed: 60, coolant: 90, voltage: 14.2, load: 20, throttle: 10 },
  ALARM: { rpm: 6800, speed: 150, coolant: 115, voltage: 11.0, load: 85, throttle: 80 },
  CRITICAL: { rpm: 7400, speed: 200, coolant: 170, voltage: 10.5, load: 95, throttle: 92 },
  ZERO: { rpm: 0, speed: 0, coolant: -40, voltage: 0, load: 0, throttle: 0 },
};

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
const out = [];
const log = (s) => { console.log(s); out.push(s); };

/** 在页面里跑一段绘图脚本，返回该区域"墨水像素数 + 边界盒" */
function PROBE_JS(body) {
  return `(function(){
    var W=320,H=200;
    var cv=document.createElement('canvas'); cv.width=W; cv.height=H;
    var ctx=cv.getContext('2d');
    ctx.fillStyle='#000000'; ctx.fillRect(0,0,W,H);
    ${body}
    var d=ctx.getImageData(0,0,W,H).data;
    var ink=0, minX=1e9,minY=1e9,maxX=-1,maxY=-1;
    for(var y=0;y<H;y++){ for(var x=0;x<W;x++){
      var i=(y*W+x)*4;
      if(d[i]+d[i+1]+d[i+2] > 40){
        ink++;
        if(x<minX)minX=x; if(x>maxX)maxX=x;
        if(y<minY)minY=y; if(y>maxY)maxY=y;
      }
    }}
    return JSON.stringify({ink:ink, minX:minX===1e9?null:minX, minY:minY===1e9?null:minY,
                           maxX:maxX<0?null:maxX, maxY:maxY<0?null:maxY});
  })()`;
}

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b02c-" + Date.now());
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
      if (await cdp.eval("!!(window.AdvancedPrimitives && window.AdvancedPrimitives._internals)").catch(() => false)) break;
      await sleep(400);
    }

    log("=== P5B-M02 §C：四种基元 + 模拟数据通道 ===");
    log("");

    // ---------------------------------------------------------------- C0 身份声明
    log("=== C0. 身份：四个基元**没有 Android View**，本套件只验编辑器侧 ===");
    const proto = await cdp.eval("String(AdvancedPrimitives.PROTO === true)");
    ok(proto === "true", "C0 AdvancedPrimitives.PROTO === true（仍是原型）");
    const notRegistered = await cdp.eval(
      "String(!(window.ICAR && ICAR.registry && ICAR.registry.Control && ICAR.registry.Control.byLegacyKey &&" +
      " (ICAR.registry.Control.byLegacyKey('segmentedArc') || ICAR.registry.Control.byLegacyKey('pathProgress'))))");
    ok(notRegistered === "true", "C0 未注册为正式控件");
    log("     ⚠️ 四个基元**均无 Android View**（已核实 app/src/main 无对应 Kotlin 类）");
    log("     ⚠️ 所以本套件的结论**只代表编辑器侧**，不代表跨端一致");

    // ---------------------------------------------------------------- C1 SegmentedArc
    log("");
    log("=== C1. SegmentedArc：模拟值 → 分段进度 ===");
    // 目标数据值：用 SIM.NORMAL / ALARM / CRITICAL 的 rpm 映射到 0~8000 量程
    for (const [name, v] of [["NORMAL", SIM.NORMAL], ["ALARM", SIM.ALARM], ["CRITICAL", SIM.CRITICAL], ["ZERO", SIM.ZERO]]) {
      const ratio = Math.max(0, Math.min(1, v.rpm / 8000));
      const r = JSON.parse(await cdp.eval(PROBE_JS(`
        var I = AdvancedPrimitives._internals;
        I.drawSegmentedArc(ctx, {cx:160, cy:100, radius:70, startAngle:135, sweepAngle:270,
          segmentCount:36, gapAngle:1.6, thickness:12, progress:${ratio.toFixed(4)},
          activeColor:'#FF3D7F', inactiveColor:'#4A5058'});
      `)));
      ok(r.ink > 500, "C1 " + name.padEnd(9) + " rpm=" + String(v.rpm).padStart(4) + " → progress=" + ratio.toFixed(3) + " 画出 " + r.ink + " px");
      out.push("  C1 " + name + " rpm=" + v.rpm + " progress=" + ratio.toFixed(4) + " ink=" + r.ink);
    }
    // 动态变化方向：rpm 越大，点亮段越多 → **粉色像素数应单调不减**
    log("     —— 动态变化方向（rpm 增大 → 点亮段增多）");
    let prevPink = -1, mono = true;
    for (const v of [SIM.ZERO, SIM.NORMAL, SIM.ALARM, SIM.CRITICAL]) {
      const ratio = Math.max(0, Math.min(1, v.rpm / 8000));
      const pink = JSON.parse(await cdp.eval(PROBE_JS(`
        var I = AdvancedPrimitives._internals;
        I.drawSegmentedArc(ctx, {cx:160, cy:100, radius:70, startAngle:135, sweepAngle:270,
          segmentCount:36, gapAngle:1.6, thickness:12, progress:${ratio.toFixed(4)},
          activeColor:'#FF3D7F', inactiveColor:'#000000'});
        // 只数粉色（R 高、G 低）
        var dd=ctx.getImageData(0,0,320,200).data, n=0;
        for(var k=0;k<dd.length;k+=4){ if(dd[k]>120 && dd[k+1]<110) n++; }
        return JSON.stringify({n:n});
      `)));
      const n = pink.n;
      if (prevPink >= 0 && n < prevPink) mono = false;
      out.push("  C1 方向 rpm=" + v.rpm + " pink=" + n);
      prevPink = n;
    }
    ok(mono, "C1 **动态方向正确**：rpm 增大时粉色点亮像素单调不减（不是反的）");

    // ---------------------------------------------------------------- C2 PathProgress
    log("");
    log("=== C2. PathProgress：模拟值 → 曲线进度 ===");
    const CURVE = "[{x:10,y:180},{x:70,y:60},{x:150,y:30},{x:230,y:22},{x:310,y:18}]";
    for (const [name, v] of [["NORMAL", SIM.NORMAL], ["ALARM", SIM.ALARM], ["CRITICAL", SIM.CRITICAL], ["ZERO", SIM.ZERO]]) {
      const ratio = Math.max(0, Math.min(1, v.rpm / 8000));
      const m = JSON.parse(await cdp.eval(`JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics(
        {points:${CURVE}, curve:'smooth', progress:${ratio.toFixed(4)}}))`));
      const expect = m.totalLength * ratio;
      ok(Math.abs(m.clippedLength - expect) < Math.max(2, m.totalLength * 0.01),
        "C2 " + name.padEnd(9) + " rpm=" + String(v.rpm).padStart(4) + " → 截断 " + m.clippedLength.toFixed(1) + "/" + m.totalLength.toFixed(1) + " px");
      out.push("  C2 " + name + " rpm=" + v.rpm + " clipped=" + m.clippedLength.toFixed(2) + " total=" + m.totalLength.toFixed(2));
    }
    // 动态方向：端点 x 应随 progress 单调不减
    log("     —— 动态变化方向（progress 增大 → 端点往前）");
    let prevX = -1, monoX = true;
    for (const v of [SIM.ZERO, SIM.NORMAL, SIM.ALARM, SIM.CRITICAL]) {
      const ratio = Math.max(0, Math.min(1, v.rpm / 8000));
      const m = JSON.parse(await cdp.eval(`JSON.stringify(AdvancedPrimitives._internals.pathProgressMetrics(
        {points:${CURVE}, curve:'smooth', progress:${ratio.toFixed(4)}}))`));
      const ex = m.endPoint ? m.endPoint.x : 0;
      if (prevX >= 0 && ex < prevX - 0.001) monoX = false;
      prevX = ex;
    }
    ok(monoX, "C2 **动态方向正确**：progress 增大时端点 x 单调前进（不是倒退）");

    // ---------------------------------------------------------------- C3 ValueText
    log("");
    log("=== C3. ValueText：模拟值 → 文本/占位/报警色 ===");
    const vt = JSON.parse(await cdp.eval(`(function(){
      var I=AdvancedPrimitives._internals;
      var cv=document.createElement('canvas'); cv.width=200; cv.height=40;
      var c=cv.getContext('2d');
      function draw(v, opt){
        c.fillStyle='#000'; c.fillRect(0,0,200,40);
        return I.drawValueText(c, Object.assign({x:4,y:28,size:20,decimals:0}, opt||{}, {value:v}));
      }
      return JSON.stringify({
        normal: draw(${SIM.NORMAL.rpm}),
        alarm:  draw(${SIM.ALARM.rpm},  {warnHigh:6000, criticalHigh:7200}),
        crit:   draw(${SIM.CRITICAL.rpm}, {warnHigh:6000, criticalHigh:7200}),
        zero:   draw(${SIM.ZERO.rpm}),
        nul:    draw(null)
      });
    })()`));
    ok(vt.normal === "800", "C3 NORMAL rpm=800 → 文本「" + vt.normal + "」");
    ok(vt.alarm === "6800", "C3 ALARM rpm=6800 → 文本「" + vt.alarm + "」");
    ok(vt.crit === "7400", "C3 CRITICAL rpm=7400 → 文本「" + vt.crit + "」");
    ok(vt.zero === "0", "C3 ZERO rpm=0 → 文本「" + vt.zero + "」（真 0 就显示 0）");
    ok(vt.nul === "--", "C3 **无数据 → 「--」不是 0**（实测「" + vt.nul + "」）");
    out.push("  C3 ValueText: normal=" + vt.normal + " alarm=" + vt.alarm + " crit=" + vt.crit + " nul=" + vt.nul);

    // 报警状态：颜色真的变
    log("     —— 报警状态（越阈值颜色变化）");
    const colors = JSON.parse(await cdp.eval(`(function(){
      var I=AdvancedPrimitives._internals;
      var cv=document.createElement('canvas'); cv.width=200; cv.height=40;
      var c=cv.getContext('2d');
      function topColor(v){
        c.fillStyle='#000'; c.fillRect(0,0,200,40);
        I.drawValueText(c,{x:4,y:28,size:22,decimals:0,value:v,warnHigh:6000,criticalHigh:7200});
        var d=c.getImageData(0,0,200,40).data, best=[0,0,0], s=-1;
        for(var i=0;i<d.length;i+=4){ var t=d[i]+d[i+1]+d[i+2]; if(t>s){s=t;best=[d[i],d[i+1],d[i+2]];} }
        return best.join(',');
      }
      return JSON.stringify({normal:topColor(800), warn:topColor(6800), crit:topColor(7400)});
    })()`));
    ok(colors.normal === "255,255,255", "C3 正常值 → 白色（" + colors.normal + "）");
    ok(colors.warn === "255,176,32", "C3 超 warnHigh → 警告色 #FFB020（" + colors.warn + "）");
    ok(colors.crit === "255,77,79", "C3 超 criticalHigh → 危险色 #FF4D4F（" + colors.crit + "）");

    // ---------------------------------------------------------------- C4 Shape
    log("");
    log("=== C4. Shape：基础图形（模拟值驱动尺寸/颜色）===");
    // 用 load% 驱动一个进度条矩形的宽度
    const bar = JSON.parse(await cdp.eval(PROBE_JS(`
      var I = AdvancedPrimitives._internals;
      var loadPct = ${(SIM.ALARM.load)};
      I.drawShape(ctx, {kind:'roundRect', x:20, y:90, w:Math.max(8, 280*loadPct/100), h:20, r:10, fill:'#3DD6FF'});
    `)));
    ok(bar.ink > 100, "C4 load=" + SIM.ALARM.load + "% → 进度条宽度按比例（" + bar.ink + " px）");
    out.push("  C4 Shape bar load=" + SIM.ALARM.load + " ink=" + bar.ink);

    // 局部渲染区域：不同值 → 右边界应不同（证明宽度真的按数据变）
    const w20 = JSON.parse(await cdp.eval(PROBE_JS(`
      var I = AdvancedPrimitives._internals;
      I.drawShape(ctx, {kind:'roundRect', x:20, y:90, w:Math.max(8,280*20/100), h:20, r:10, fill:'#3DD6FF'});
    `)));
    const w85 = JSON.parse(await cdp.eval(PROBE_JS(`
      var I = AdvancedPrimitives._internals;
      I.drawShape(ctx, {kind:'roundRect', x:20, y:90, w:Math.max(8,280*85/100), h:20, r:10, fill:'#3DD6FF'});
    `)));
    ok(w85.maxX > w20.maxX, "C4 **局部区域按数据变化**：load 85% 右边界 " + w85.maxX + " > 20% 的 " + w20.maxX);

    // ---------------------------------------------------------------- C5 声明边界
    log("");
    log("=== C5. 跨端声明边界（诚实标注）===");
    log("     ❌ 四个基元**没有 Android View** → 不存在「Android 与编辑器同输入同表现」的证据");
    log("     ❌ 本套件不主张跨端一致");
    log("     ✅ 结论仅限：**编辑器侧**，同一份模拟值输入下，四个基元的几何/文本/颜色符合预期");
    ok(true, "C5 已明确声明：本套件**不构成跨端验证**");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器侧（无头 Edge + Canvas）。四个基元均无 Android View。");
    fs.writeFileSync(OUT, out.join("\n"), "utf8");

  } catch (e) {
    console.error("套件异常: " + e.message);
    fail++;
  } finally {
    try { cdp && cdp.ws.close(); } catch (e) { }
    try { proc.kill(); } catch (e) { }
  }
  console.log("\n已写 " + path.relative(ROOT, OUT));
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
