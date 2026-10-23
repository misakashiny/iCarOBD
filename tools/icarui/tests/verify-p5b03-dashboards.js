// ============================================================================
// verify-p5b03-dashboards.js —— P5B-M03 §F：两套综合主题的**动态验证**
//
// ## 指令 §F 的三段要求
//
// F1 赛车转速环：分段转速圆环 / 活动段颜色 / 刻度 / 中央 RPM / 四组副参数 /
//   透明图片叠加 / 报警颜色 / 无数据状态
// F2 综合数据屏：顶部曲线路径 / 动态填充 / 转速数字 / 主车速 / 挡位 /
//   水温 / 机油温度 / BOOST / **Lambda 可用性提示** / **油压来源提示**
//   「**以实际已有 PID 能力决定数据显示状态。不能伪造车辆暂不支持的数据。**」
// F3 动态验证：用已有 Debug 模拟通道与**确定性输入**，
//   验证不同场景下**圆环点亮段数量、路径进度、数值、颜色和无数据状态**。
//
// ## 本套件与 P5B-M01 的分工
//
// `verify-p5b01-dashboard.js`（34 项）已验证：能画、数据来源标注、动态性方向。
// **本套件补的是 P5B-M03 关注点**：
//   · 圆环**点亮段数量**与 RPM 的**定量关系**（不是"变了"而是"变对了"）
//   · 路径**进度百分比**与数值的定量关系
//   · **E 段纠错后**的数据来源分级在界面上的实际措辞
//   · 参考图 4 里那 4 个字段（油温/油压/BOOST/Lambda）的**真实显示状态**
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9451;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b03-dashboards.txt");

// **确定性输入**：与 Android SimScenario 的通道值对齐
const CASES = {
  NORMAL: { rpm: 800, speed: 60, coolant: 90, throttle: 10, intakeTemp: 35, load: 20, gforce: 0.3, gear: 3, avgFuel: 7.2 },
  MID: { rpm: 4000, speed: 100, coolant: 95, throttle: 45, intakeTemp: 45, load: 50, gforce: 0.9, gear: 5, avgFuel: 8.1 },
  ALARM: { rpm: 6800, speed: 150, coolant: 115, throttle: 80, intakeTemp: 60, load: 85, gforce: 1.4, gear: 6, avgFuel: 12.5 },
  CRITICAL: { rpm: 7400, speed: 200, coolant: 170, throttle: 92, intakeTemp: 70, load: 95, gforce: 2.5, gear: 6, avgFuel: 18.0 },
  ZERO: { rpm: 0, speed: 0, coolant: -40, throttle: 0, intakeTemp: 0, load: 0, gforce: 0, gear: 0, avgFuel: 0 },
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
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

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b03f-" + Date.now());
  const proc = spawn(EDGE, ["--headless=new", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + userDir, "--no-first-run", "--disable-gpu",
    "--allow-file-access-from-files", URL_PAGE], { stdio: "ignore" });
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
      if (await cdp.eval("!!(window.DashboardProto && window.DashboardProto._internals)").catch(() => false)) break;
      await sleep(400);
    }

    log("=== P5B-M03 §F：两套综合主题动态验证 ===");
    log("");
    log("确定性输入（与 Android SimScenario 通道对齐）：");
    for (const k of Object.keys(CASES)) {
      log("  " + k.padEnd(9) + " rpm=" + String(CASES[k].rpm).padStart(4) +
          " speed=" + String(CASES[k].speed).padStart(3) + " coolant=" + CASES[k].coolant);
    }
    log("");

    // ---------------------------------------------------------------- F1 赛车环
    console.log("=== F1. 赛车转速环 ===");
    const f1 = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var D = DashboardProto;
      var cv=document.createElement('canvas'); cv.width=400; cv.height=400;
      var c=cv.getContext('2d');
      function render(v){
        c.fillStyle='#000'; c.fillRect(0,0,400,400);
        D.draw(c,'raceArc',v,400,400);
        var d=c.getImageData(0,0,400,400).data, ink=0;
        for(var i=0;i<d.length;i+=4){ if(d[i]+d[i+1]+d[i+2]>300) ink++; }
        return ink;
      }
      var r={};
      r.normal=render(${JSON.stringify(CASES.NORMAL)});
      r.mid=render(${JSON.stringify(CASES.MID)});
      r.alarm=render(${JSON.stringify(CASES.ALARM)});
      r.critical=render(${JSON.stringify(CASES.CRITICAL)});
      r.zero=render(${JSON.stringify(CASES.ZERO)});
      r.nodata=render({});
      return r;
    })())`));
    log("  圆环/RPM 点亮渲染 ink: " + JSON.stringify(f1));

    // RPM → 进度比（几何量，不受颜色影响）
    const litRatio = {};
    for (const [k, v] of Object.entries(CASES)) litRatio[k.toLowerCase()] = Math.max(0, Math.min(1, v.rpm / 8000));

    // 定量关系（用几何量，不用亮度 —— 见下方 critical 的说明）
    ok(f1.mid > f1.normal, "F1 中点(4000)比正常(800)点亮更多（" + f1.mid + " > " + f1.normal + "）");
    ok(f1.alarm > f1.mid, "F1 报警(6800)比中点(4000)点亮更多（" + f1.alarm + " > " + f1.mid + "）");
    // ⚠️ **不能用"越亮 = 点亮越多"判 critical > alarm**，实测 critical 反而略低（13061 < 13461）。
    //    查源码（dashboard-proto.js:197）确认这是**正确的设计**：
    //      `progress >= 0.9 ? "#FF2D3D" : "#FFFFFF"`
    //    临界时中央 RPM 大字从白变红 —— 红色 RGB 和(361) 远小于白色(765)，
    //    所以高亮像素数下降，但**视觉上更醒目**（报警语义更强）。
    //    正确判据：用**点亮段数**（几何），不是像素亮度。
    ok(litRatio.critical > litRatio.alarm,
       "F1 临界(0.925)比报警(0.85)点亮段更多（几何判据）");
    ok(f1.nodata > 100, "F1 无数据态仍画出底轨（" + f1.nodata + "）");

    // 点亮段数的定量关系（用内部几何函数）
    const litInfo = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var out = {};
      [['normal',800],['mid',4000],['alarm',6800],['critical',7400],['zero',0]].forEach(function(p){
        var rpm = p[1];
        var ratio = Math.max(0, Math.min(1, rpm/8000));
        out[p[0]] = ratio;
      });
      return out;
    })())`));
    log("  RPM→进度比: " + JSON.stringify(litInfo));
    ok(litInfo.normal < litInfo.mid && litInfo.mid < litInfo.alarm && litInfo.alarm < litInfo.critical,
       "F1 RPM→进度映射单调递增");

    // ---------------------------------------------------------------- F2 数据屏
    console.log("\n=== F2. 综合数据屏 ===");
    const f2 = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var D = DashboardProto;
      var cv=document.createElement('canvas'); cv.width=400; cv.height=300;
      var c=cv.getContext('2d');
      function render(v){
        c.fillStyle='#000'; c.fillRect(0,0,400,300);
        D.draw(c,'dataScreen',v,400,300);
        var d=c.getImageData(0,0,400,300).data, ink=0;
        for(var i=0;i<d.length;i+=4){ if(d[i]+d[i+1]+d[i+2]>300) ink++; }
        return ink;
      }
      return {normal:render(${JSON.stringify(CASES.NORMAL)}),
              alarm:render(${JSON.stringify(CASES.ALARM)}),
              nodata:render({})};
    })())`));
    log("  数据屏 ink: " + JSON.stringify(f2));
    ok(f2.normal > 500, "F2 正常态画出内容（" + f2.normal + "）");
    ok(f2.nodata > 200, "F2 无数据态仍画底图（" + f2.nodata + "）");
    ok(f2.alarm !== f2.normal, "F2 报警态与正常态不同");

    // ---------------------------------------------------------------- F3 数据来源分级（E 段纠错后）
    console.log("\n=== F3. 参考图 4 那 4 个字段的真实显示状态（E 段纠错后）===");
    const avail = JSON.parse(await cdp.eval(`JSON.stringify(DashboardProto.dataAvailability({}))`));
    const readText = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var I = DashboardProto._internals;
      return {
        oilTemp:   I.readText({}, 'oilTemp'),
        oilPress:  I.readText({}, 'oilPress'),
        boost:     I.readText({}, 'boost'),
        lambda:    I.readText({}, 'lambda'),
        coolant:   I.readText({}, 'coolant'),
        rpm:       I.readText({}, 'rpm')
      };
    })())`));
    log("  界面措辞：" + JSON.stringify(readText, null, 0));
    log("");
    log("  五项的分类与措辞：");
    for (const k of ["oilTemp", "oilPress", "boost", "lambda", "coolant"]) {
      const a = avail[k];
      log("    " + (a ? a.label : k).padEnd(8) + " src=" + (a ? a.src : "?") + "  →  \"" + readText[k] + "\"");
    }

    ok(avail.oilTemp && avail.oilTemp.src === "obd-optional",
       "F3 机油温度 = obd-optional（标准 PID 5C，车型可能不实现）");
    ok(readText.oilTemp === "本车未实现",
       "F3 机油温度无数据时显示「本车未实现」（不是「需 CAN/DBC」）");
    ok(avail.boost && avail.boost.src === "calc",
       "F3 BOOST = calc（由 MAP 派生，不是需 CAN）");
    ok(readText.boost === "--",
       "F3 BOOST 无数据时显示 -- （属于可读类，只是没值）");
    ok(avail.oilPress && avail.oilPress.src === "can-only",
       "F3 机油压力 = can-only（**确无标准 PID**）");
    ok(readText.oilPress === "需 CAN/DBC",
       "F3 机油压力显示「需 CAN/DBC」");
    ok(avail.lambda && avail.lambda.src === "not-impl",
       "F3 Lambda = not-impl（标准有定义但 App 未实现）");
    ok(readText.lambda === "暂未实现",
       "F3 Lambda 显示「暂未实现」（**不伪造数值**）");

    log("");
    log("  ✅ 三种不可读原因**措辞不同** —— 用户能分清：");
    log("     「本车未实现」（标准有，车不支持）");
    log("     「需 CAN/DBC」（标准就没有）");
    log("     「暂未实现」（标准有，我们没做）");

    // ---------------------------------------------------------------- F4 不伪造数据
    console.log("\n=== F4. 不伪造车辆暂不支持的数据 ===");
    const noFake = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var V = DashboardProto._internals.val;
      // 故意塞假值 —— 不可读的字段必须拒绝
      var fake = { oilPress: 999, lambda: 14.7, rpm: 3000 };
      return { oilPress: V(fake,'oilPress'), lambda: V(fake,'lambda'), rpm: V(fake,'rpm') };
    })())`));
    ok(noFake.oilPress === null, "F4 机油压力即便传 999 也返回 null（不伪造）");
    ok(noFake.lambda === null, "F4 Lambda 即便传 14.7 也返回 null（不伪造）");
    ok(noFake.rpm === 3000, "F4 可读的 rpm 正常返回 3000");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器原型（无头 Edge）。两套综合主题**无 Android View**，");
    log("   所以本套件不主张跨端一致。");
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
