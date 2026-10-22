// P5A-M03 阶段 A：实证探针（不写结论，只取事实）
//   A1 createNode 无 min/max 时的默认量程
//   A2 改 PID 是否覆盖用户自定义 min/max
//   A3 canvas.scaleMode 的读写/导出链路
//   A4 状态灯 select 是否只有高值判定（Android 侧已审代码，这里只看编辑器字段）
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9333;
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
    const id = ++this.id; const p = { id, method, params: params || {} };
    return new Promise((res, rej) => { this.w.set(id, { res, rej }); this.ws.send(JSON.stringify(p)); });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
}
const getJson = (p) => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => {
    let d = ""; r.on("data", (c) => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});

(async function () {
  const userDir = path.join(require("os").tmpdir(), "p5a03-probe-" + Date.now());
  const proc = spawn(EDGE, [
    "--headless=new", "--remote-debugging-port=" + PORT, "--user-data-dir=" + userDir,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--allow-file-access-from-files", URL_PAGE
  ], { stdio: "ignore" });
  let cdp = null;
  try {
    for (let i = 0; i < 60 && !cdp; i++) {
      await sleep(500);
      try {
        const list = await getJson("/json/list");
        const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
        if (t) cdp = await CDP.connect(t.webSocketDebuggerUrl);
      } catch (e) { /* 端口还没开 */ }
    }
    if (!cdp) throw new Error("连不上 CDP");
    await cdp.send("Runtime.enable");
    // 关掉原生弹窗，避免阻塞
    await cdp.eval("window.alert=function(){};window.confirm=function(){return true};1");
    for (let i = 0; i < 40; i++) {
      const ok = await cdp.eval("!!(window.CanvasState && window.createNode && window.BUILTIN_PIDS)").catch(() => false);
      if (ok) break;
      await sleep(400);
    }

    console.log("=== A1: createNode 不传 min/max 时的默认值 ===");
    console.log(JSON.stringify(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", name: "探针" });
      const info = window.BUILTIN_PIDS[window.resolvePid("obd.rpm")] || {};
      return { nodeMin: n.min, nodeMax: n.max, pidMin: info.min, pidMax: info.max, pid: n.pid };
    })()`), null, 2));

    console.log("\n=== A2: 改 PID 是否覆盖用户自定义 min/max ===");
    console.log(JSON.stringify(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", name: "探针2", min: 999, max: 7777 });
      const before = { min: n.min, max: n.max };
      window.assignControlBinding(n, "obd.speed");     // 相当于面板里换 PID
      return { before: before, after: { min: n.min, max: n.max },
               note: "用户原来的 999~7777 是否被覆盖" };
    })()`), null, 2));

    console.log("\n=== A3: canvas.scaleMode 链路 ===");
    console.log(JSON.stringify(await cdp.eval(`(function(){
      const d = window.CanvasState.design;
      const ui = document.getElementById("scaleMode");
      return {
        designScaleMode: d.canvas && d.canvas.scaleMode,
        uiDropdownExists: !!ui,
        uiOptionCount: ui ? ui.options.length : 0,
        uiOptions: ui ? Array.from(ui.options).map(o => o.value + ":" + o.textContent) : [],
        scaleModesConst: (window.SCALE_MODES||[]).map(m => m.v + ":" + m.n),
        hasScaleModeRoundTrip: typeof window.SCALE_MODES !== "undefined"
      };
    })()`), null, 2));

    console.log("\n=== A4: 状态灯字段（编辑器侧有无低值方向表达）===");
    console.log(JSON.stringify(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_IMAGE, { name: "灯" });
      return {
        hasStateWarn: "stateWarn" in n,
        hasStateCritical: "stateCritical" in n,
        keysMatchLow: Object.keys(n).filter(k => /low|warnLow|dir|below/i.test(k))
      };
    })()`), null, 2));

    console.log("\n=== A5: 拼装表（parts）节点的量程与部件 pid ===");
    console.log(JSON.stringify(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", name: "拼装" });
      n.parts = [ window.normalizePart({ kind:"needle", assetId:"x", x:0,y:0,w:100,h:10 }) ];
      return { nodeMin:n.min, nodeMax:n.max, partPid: n.parts[0].pid || "(空=用节点量程)" };
    })()`), null, 2));

  } catch (e) {
    console.error("探针失败: " + e.message);
    process.exitCode = 1;
  } finally {
    try { cdp && cdp.ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }
})();
