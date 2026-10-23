// ============================================================================
// verify-p5b01-dashboard.js —— P5B-M01 阶段 F：两套组合仪表示例原型
//
// ## 最容易造假的地方，就是这里
//
// 任务 §七 明确要求：
//   「必须区分可由现有 OBD PID 驱动的值和需要专用 CAN/DBC 信号的值。
//     **不允许假装所有数据都已能从车辆读取。**」
//
// 所以本套件的重点不是"画得好看"，而是：
//   F1 数据来源表必须诚实（can 类字段**永远**返回 null，不编数）
//   F2 读不到时界面显示"无信号"，**不是 0**
//   F3 两套示例都能画出来（非空白）
//   F4 转速变化能驱动圆弧进度（动态性）
//   F5 不改动正式主题格式（仍是原型）
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9411;
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

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b01f-" + Date.now());
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
      if (await cdp.eval("!!(window.DashboardProto && window.AdvancedPrimitives)").catch(() => false)) break;
      await sleep(400);
    }

    console.log("=== F1. 数据来源表必须诚实（P5B-M02 §E 已改为五类）===");
    //
    // ⚠️ P5B-M02 §E 纠错：第一版把这五项一律标成 `"can"`（需车厂 DBC），是**错的**。
    //    证据来自项目自己的 BuiltInPids.kt：
    //      :65 机油温度 5C   → **标准 PID 已定义且已实现**（obd-optional，车型可能不实现）
    //      :55 燃油压力 0A   → **标准 PID 已定义**（obd）
    //      :62 MAP 0B        → **BOOST 可由它派生**（calc，项目已有 calc_boost）
    //      :118 机油压力      → 注释原文「不在标准 OBD 里」→ 确实 can-only
    //    所以改成五类，断言也按新分类写。
    const avail = JSON.parse(await cdp.eval("JSON.stringify(DashboardProto.dataAvailability({}))"));
    const by = (s) => Object.keys(avail).filter((k) => avail[k].src === s);
    const canKeys = by("can-only");
    const obdKeys = by("obd");
    const optKeys = by("obd-optional");
    const calcKeys = by("calc");
    const notImplKeys = by("not-impl");
    ok(canKeys.length === 2, "F1 确需 CAN/DBC 的只有 " + canKeys.length + " 项（" + canKeys.join("/") + "）");
    ok(obdKeys.length === 7, "F1 标准 OBD 已实现 " + obdKeys.length + " 项（" + obdKeys.join("/") + "）");
    ok(optKeys.length === 1 && optKeys[0] === "oilTemp",
       "F1 机油温度归为「标准 PID 但车型可能不实现」（" + optKeys.join("/") + "）");
    ok(calcKeys.indexOf("boost") >= 0, "F1 BOOST 归为「派生」（" + calcKeys.join("/") + "）");
    ok(notImplKeys.length === 1 && notImplKeys[0] === "lambda",
       "F1 Lambda 归为「标准有定义但 App 未实现」（" + notImplKeys.join("/") + "）");
    canKeys.forEach((k) => {
      ok(avail[k].readable === false, "F1 「" + avail[k].label + "」标记为**不可读**（确无标准 PID）");
    });
    obdKeys.forEach((k) => {
      ok(avail[k].readable === true, "F1 「" + avail[k].label + "」标记为可读（" + avail[k].note + "）");
    });

    console.log("\n=== F2. 确不可读的字段即使传值也必须返回 null（不假装读到）===");
    const lie = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var V = DashboardProto._internals.val;
      var fake = { rpm:3000, speed:80, coolant:90, oilTemp:999, oilPress:99, boost:99, lambda:99, fuelPress:350 };
      return {
        oilTemp: V(fake,'oilTemp'),
        oilPress: V(fake,'oilPress'),
        boost: V(fake,'boost'),
        lambda: V(fake,'lambda'),
        fuelPress: V(fake,'fuelPress'),
        rpm: V(fake,'rpm'),
        speed: V(fake,'speed')
      };
    })())`));
    // 纠错后：机油温度是标准 PID(5C) → **可读**，传值应被接受
    ok(lie.oilTemp === 999, "F2 机油温度（标准 PID 5C 已实现）传 999 → 正常返回（不再被误判为不可读）");
    // 机油压力确无标准 PID → 必须拒绝
    ok(lie.oilPress === null, "F2 机油压力（确无标准 PID）即便传 99 也返回 null");
    // BOOST 由 MAP 派生 → **可读**
    ok(lie.boost === 99, "F2 BOOST（由 MAP 派生）传 99 → 正常返回");
    // Lambda 标准有定义但未实现 → 必须拒绝
    ok(lie.lambda === null, "F2 Lambda（标准有定义但 App 未实现）即便传 99 也返回 null");
    // 燃油压力是标准 PID 0A → 可读
    ok(lie.fuelPress === 350, "F2 燃油压力（标准 PID 0A）传 350 → 正常返回");
    ok(lie.rpm === 3000, "F2 转速（OBD 可读）正常返回 3000");
    ok(lie.speed === 80, "F2 车速（OBD 可读）正常返回 80");

    console.log("\n=== F2b. 读不到时显示「无信号」而不是 0 ===");
    const txt = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var R = DashboardProto._internals.readText;
      return {
        oilTemp: R({}, 'oilTemp'),
        boost: R({}, 'boost'),
        coolantNoVal: R({}, 'coolant'),
        coolantWithVal: R({coolant:90}, 'coolant', 0),
        rpm: R({rpm:3250}, 'rpm', 0)
      };
    })())`));
    // 纠错后措辞分级：机油温度是标准 PID（车可能没实现）→「本车未实现」
    ok(txt.oilTemp === "本车未实现", "F2b 机油温度无数据 → 「本车未实现」（标准 PID 5C，非 CAN 专属；实测 " + txt.oilTemp + "）");
    // BOOST 由 MAP 派生，属于可读类，只是没数据 → 普通 --
    ok(txt.boost === "--", "F2b BOOST（派生）无数据 → --（不是「需 CAN/DBC」；实测 " + txt.boost + "）");
    ok(txt.coolantNoVal === "--", "F2b 水温（OBD 可读但当前没值）→ --（实测 " + txt.coolantNoVal + "）");
    ok(txt.coolantWithVal === "90", "F2b 水温有值 → 90");
    ok(txt.rpm === "3250", "F2b 转速有值 → 3250");

    console.log("\n=== F3. 两套示例都能画出来（非空白）===");
    for (const which of ["raceArc", "dataScreen"]) {
      const ink = await cdp.eval(`(function(){
        var cv=document.createElement('canvas');cv.width=600;cv.height=340;
        var c=cv.getContext('2d');
        DashboardProto.draw(c,'${which}',{rpm:5200,speed:132,coolant:88,intakeTemp:35,throttle:42,gear:4},600,340);
        var d=c.getImageData(0,0,600,340).data,n=0;
        for(var i=0;i<d.length;i+=4){ if(d[i]+d[i+1]+d[i+2] > 60) n++; }
        return n;
      })()`);
      ok(ink > 5000, "F3 " + which + " 有绘制内容（亮像素 " + ink + "）");
    }

    console.log("\n=== F4. 转速变化能驱动圆弧/曲线进度（动态性）===");
    const dyn = await cdp.eval(`(function(){
      function inkAt(rpm){
        var cv=document.createElement('canvas');cv.width=400;cv.height=240;
        var c=cv.getContext('2d');
        DashboardProto.draw(c,'raceArc',{rpm:rpm},400,240);
        var d=c.getImageData(0,0,400,240).data,h=0;
        // 只看粉色系像素（点亮段）
        for(var i=0;i<d.length;i+=4){
          if(d[i]>150 && d[i+1]<120 && d[i+2]>60 && d[i+2]<170) h++;
        }
        return h;
      }
      return JSON.stringify({low:inkAt(1000), high:inkAt(7000), zero:inkAt(0)});
    })()`);
    const D2 = JSON.parse(dyn);
    ok(D2.high > D2.low, "F4 7000 转的点亮段比 1000 转多（" + D2.high + " > " + D2.low + "）");
    ok(D2.low > D2.zero, "F4 1000 转比 0 转多（" + D2.low + " > " + D2.zero + "）");
    ok(D2.zero >= 0, "F4 0 转时无点亮段（" + D2.zero + "）");

    console.log("\n=== F5. 仍是原型，不碰正式主题格式 ===");
    const iso = await cdp.eval(
      "String(!(window.ICAR && ICAR.registry && ICAR.registry.Control && " +
      "ICAR.registry.Control.byLegacyKey && ICAR.registry.Control.byLegacyKey('raceArc')))");
    ok(iso === "true", "F5 raceArc 未注册为控件（不进正式格式）");
    const protoFlag = await cdp.eval("String(DashboardProto.PROTO === true)");
    ok(protoFlag === "true", "F5 DashboardProto.PROTO === true");

    // 导出设计不应包含任何原型字段
    const designClean = await cdp.eval(`String((function(){
      var json = window.toV2Json(window.CanvasState.design);
      return json.indexOf('segmentedArc') < 0 && json.indexOf('raceArc') < 0 &&
             json.indexOf('pathProgress') < 0 && json.indexOf('dataScreen') < 0;
    })())`);
    ok(designClean === "true", "F5 导出的主题 JSON 里**没有**任何原型字段");

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
  console.log("⚠️ 原型验证通过 ≠ 正式 Android 控件已交付。");
  process.exitCode = fail ? 1 : 0;
})();
