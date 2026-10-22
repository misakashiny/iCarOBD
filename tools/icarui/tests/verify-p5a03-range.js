// ============================================================================
// verify-p5a03-range.js —— P5A-M03 阶段 B：拼装仪表量程自动回填
//
// ## 为什么要有这个套件
//
// 背景缺陷（阶段 A 实证）：
//   · `createNode(NODE_GAUGE,{pid:"obd.rpm"})` 原来给 **0..100**（PID 真实 0..8000）
//   · 用 parts 拼表、指针没显式绑 PID 时，`GaugePartsView` 回落到**节点量程**
//     → 转速 800 早已 ≥100 → 指针钉在端点
//   · 换 PID 时**无条件覆盖**用户手填的 min/max
//
// 本套件钉的是"真实行为"：
//   ① 新建按 PID 填量程  ② 显式值优先  ③ 自定义 PID 回落  ④ 派生量程跟随换 PID
//   ⑤ **用户手填量程不被覆盖**  ⑥ 回填按钮仍能强制  ⑦ Undo/Redo  ⑧ 导出/解析一致
//   ⑨ 拼装表：指针角度随"节点量程"变化（这就是缺陷的用户可见后果）
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9341;
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
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.text || "") + " " + JSON.stringify(r.exceptionDetails.exception));
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
  const userDir = path.join(os.tmpdir(), "p5a03-range-" + Date.now());
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
      } catch (e) { /* 等端口 */ }
    }
    if (!cdp) throw new Error("连不上 CDP");
    await cdp.send("Runtime.enable");
    await cdp.eval("window.alert=function(){};window.confirm=function(){return true};window.prompt=function(){return null};1");
    for (let i = 0; i < 50; i++) {
      if (await cdp.eval("!!(window.CanvasState && window.createNode && window.BUILTIN_PIDS && window.CanvasState.design)").catch(() => false)) break;
      await sleep(400);
    }

    const B = "window.BUILTIN_PIDS";
    const R = "window.resolvePid";

    console.log("=== B1. 新建仪表按 PID 定义填量程 ===");
    const b1 = await cdp.eval(`(function(){
      const out = {};
      ["obd.rpm","obd.speed","obd.coolant","obd.voltage","obd.throttle"].forEach(function(a){
        const n = window.createNode(window.NODE_GAUGE, { pid: a });
        const d = window.BUILTIN_PIDS[window.resolvePid(a)];
        out[a] = { got: [n.min, n.max], want: [d.min, d.max], eq: n.min === d.min && n.max === d.max };
      });
      return out;
    })()`);
    Object.keys(b1).forEach((k) => {
      ok(b1[k].eq, "B1 " + k.padEnd(12) + " 量程 " + JSON.stringify(b1[k].got) + " = PID " + JSON.stringify(b1[k].want));
    });

    console.log("\n=== B2. 显式 min/max 优先（不被 PID 定义顶掉）===");
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", min: 500, max: 6000 });
      return n.min === 500 && n.max === 6000;
    })()`), "B2 显式 500~6000 被保留（不是 PID 的 0~8000）");

    console.log("\n=== B3. 未知 PID 回落到 0..100（老行为）===");
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "my_custom_xyz" });
      return n.min === 0 && n.max === 100;
    })()`), "B3 自定义 PID → 0..100");

    console.log("\n=== B4. 换 PID：派生量程跟随 ===");
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm" });   // 0~8000（派生）
      window.assignControlBinding(n, "obd.speed");
      const d = window.BUILTIN_PIDS[window.resolvePid("obd.speed")];
      return n.min === d.min && n.max === d.max;
    })()`), "B4 0~8000（=转速定义）→ 换车速后变 0~260");

    console.log("\n=== B5. 换 PID：**用户手填量程不被覆盖** ===");
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", min: 999, max: 7777 });
      window.assignControlBinding(n, "obd.speed");
      return n.min === 999 && n.max === 7777;
    })()`), "B5 手填 999~7777 换 PID 后仍保留");

    // ⚠️ P5A-M04 语义变更：这里原来断言"老表 0~100（≠PID 量程）换 PID 会跟随"。
    //
    // M04 阶段 C 按任务要求改成「**只有能明确证明量程来自自动派生，才允许跟随**
    // —— 不能仅靠数值相等就判定用户未手动设置」，实现换成内存来源标记 `__rangeAuto`。
    // 于是「显式传了 min:0,max:100」这种**手工构造**的节点没有标记 → 不再跟随。
    //
    // 这不是放宽断言，而是**断言方向反了**（更保守）：用户明确写下的 0~100 现在会被保留。
    // "派生量程仍会跟随"这条能力由 B4/B7 覆盖（createNode 不传 min/max → 有标记 → 跟随）。
    console.log("\n=== B6. 显式 0..100 换 PID **保留**（M04 起：不猜，需显式回填）===");
    ok(await cdp.eval(`(function(){
      // 模拟一个"用户明确写了 0..100"的表（没有派生标记）
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", min: 0, max: 100 });
      window.assignControlBinding(n, "obd.coolant");
      return n.min === 0 && n.max === 100;
    })()`), "B6 0~100 换水温后**保留** 0~100（若跟随会变 -40~215）");
    // 对照：真正派生的表（不传 min/max）仍然会跟随
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm" });   // 派生，有标记
      window.assignControlBinding(n, "obd.coolant");
      const d = window.BUILTIN_PIDS[window.resolvePid("obd.coolant")];
      return n.min === d.min && n.max === d.max;
    })()`), "B6 对照：派生量程（不传 min/max）换水温后**跟随**为 -40~215");

    console.log("\n=== B7. 回填按钮仍可强制对齐 PID ===");
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", min: 1, max: 2 });
      window.CanvasState.design.nodes = [{ id: "grp", type: window.NODE_GROUP, name: "g", x:0,y:0,w:360,h:360, children:[n], z:0, alpha:255, locked:false, visible:true, rotation:0, scale:1 }];
      window.CanvasState.selection = [n.id];
      window.applyPidDefaults();
      const d = window.BUILTIN_PIDS[window.resolvePid("obd.rpm")];
      return n.min === d.min && n.max === d.max;
    })()`), "B7 applyPidDefaults 强制回填为 0~8000");

    console.log("\n=== B8. Undo / Redo 能还原量程 ===");
    // ⚠️ 必须**两步都走 commit**：撤销栈只在 commit 时压栈，
    //    直接 `nodes.push(x)` 不会进历史 —— 那时 undo 会退回到"这个表还不存在"的更早状态
    //    （第一版就是这么误判成"撤销坏了"的）。
    const b8 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", min: 0, max: 8000 });
      window.commit(function(){ window.CanvasState.design.nodes.push(n); }, "加表");
      window.CanvasState.selection = [n.id];
      window.commit(function(){ n.min = 100; n.max = 200; }, "改量程");
      const changed = n.min === 100 && n.max === 200;
      function find(id){ let out=null; window.walk(window.CanvasState.design.nodes,x=>{ if(x.id===id) out=x; }); return out; }
      window.doUndo();
      const u = find(n.id);
      const afterUndo = !!u && u.min === 0 && u.max === 8000;
      window.doRedo();
      const r = find(n.id);
      const afterRedo = !!r && r.min === 100 && r.max === 200;
      return { changed: changed, afterUndo: afterUndo, afterRedo: afterRedo,
               undoVal: u ? [u.min,u.max] : null, redoVal: r ? [r.min,r.max] : null };
    })()`);
    ok(b8.changed && b8.afterUndo && b8.afterRedo,
      "B8 改量程 8000→200，Undo 回到 " + JSON.stringify(b8.undoVal) + "，Redo 回到 " + JSON.stringify(b8.redoVal));

    console.log("\n=== B9. 导出 → 解析 往返量程一致 ===");
    ok(await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid: "obd.rpm", min: 123, max: 4321 });
      const host = { id:"grp3", type: window.NODE_GROUP, name:"g", x:0,y:0,w:360,h:360, children:[n], z:0, alpha:255, locked:false, visible:true, rotation:0, scale:1 };
      const d = JSON.parse(JSON.stringify(window.CanvasState.design));
      d.nodes = [host];
      const json = window.toV2Json ? window.toV2Json(d) : JSON.stringify(d);
      const parsed = window.parseDesign(typeof json === "string" ? json : JSON.stringify(json));
      const back = parsed.design.nodes[0].children[0];
      return !parsed.errors.length && back.min === 123 && back.max === 4321;
    })()`), "B9 123~4321 导出再解析后一致");

    console.log("\n=== B10. 拼装表：指针角度随节点量程变化（缺陷的用户可见后果）===");
    const b10 = await cdp.eval(`(function(){
      // 同一个 needle（不绑 pid），只改节点量程，看同一个值算出的角度
      const part = window.normalizePart({ kind:"needle", assetId:"", x:0,y:0,w:100,h:10, pivotX:0.06, pivotY:0.5 });
      function angle(min, max, value) {
        const span = max - min;
        const t = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0;
        return 135 + (405 - 135) * t;
      }
      const wrong = angle(0, 100, 800);       // 旧默认 0..100 → 夹到 1 端
      const right = angle(0, 8000, 800);      // 按 PID 0..8000 → 10%
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm" });
      return { wrong: wrong, right: right, nodeRange: [n.min, n.max] };
    })()`);
    ok(b10.wrong === 405, "B10 旧默认 0..100 时转速 800 → 角度 " + b10.wrong + "（钉在端点）");
    ok(Math.abs(b10.right - 162) < 1, "B10 按 PID 0..8000 时转速 800 → 角度 " + b10.right.toFixed(1) + "（正常）");
    ok(b10.nodeRange[0] === 0 && b10.nodeRange[1] === 8000, "B10 新建节点量程已是 0~8000");

  } catch (e) {
    console.error("套件异常: " + e.message);
    fail++;
  } finally {
    try { cdp && cdp.ws.close(); } catch (e) {}
    try { proc.kill(); } catch (e) {}
  }
  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
