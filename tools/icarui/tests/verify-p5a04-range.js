// ============================================================================
// verify-p5a04-range.js —— P5A-M04 阶段 C：PID 量程保护
//
// ## 核心原则（任务原文）
//
//   「只有能明确证明量程来自自动派生，才允许自动跟随 PID。
//     不能仅靠数值相等就绝对判定用户未手动设置。」
//
// P5A-M03 的实现正是靠 `min/max === PID 定义` 推断"派生" —— 违反这条。
// P5A-M04 改为**编辑期来源标记** `n.__rangeAuto = {pid,min,max}`：
//   · 只有"自动填的入口"会打标记（createNode / 预设 / 换PID跟随 / 回填按钮）
//   · 用户手改 min/max（走 setNodeNum）→ 立即清除标记
//   · 换 PID 时三条同时成立才跟随：① 有标记 ② 标记 pid==旧 pid ③ 标记值==当前值
//   · 标记**不进设计文件**，草稿/导出/重新导入后消失 → 那就不再跟随（保守）
//
// ## 覆盖任务 §5 的 9 条
//
//   C1 新建仪表自动填写 PID 量程
//   C2 用户手填的量程与 PID 默认**不同** → 不被覆盖
//   C3 用户手填的量程**恰好等于** PID 默认 → **也不被覆盖**（M03 会误判成派生）
//   C4 原 PID 是自定义 PID
//   C5 新 PID 是自定义 PID
//   C6 用户主动点「回填量程」→ 跟随并重新成为派生
//   C7 Undo/Redo
//   C8 保存草稿 / 重新导入后：**不再自动跟随**（标记丢失，保守）
//   C9 旧主题手填量程不被静默覆盖
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9371;
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
  const userDir = path.join(os.tmpdir(), "p5a04-range-" + Date.now());
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
    // 等 design 真的就位（全量顺序跑时页面可能刚起、design 还是 null）
    for (let i = 0; i < 80; i++) {
      const ready = await cdp.eval(
        "!!(window.CanvasState && window.CanvasState.design && window.CanvasState.design.canvas" +
        " && window.createNode && window.markRangeAuto)"
      ).catch(() => false);
      if (ready) break;
      await sleep(400);
    }

    // ---------------------------------------------------------------- C1
    console.log("=== C1. 新建仪表自动填写 PID 量程 ===");
    const c1 = await cdp.eval(`(function(){
      const out = {};
      ["obd.rpm","obd.speed","obd.coolant"].forEach(function(a){
        const n = window.createNode(window.NODE_GAUGE, { pid: a });
        const d = window.BUILTIN_PIDS[window.resolvePid(a)];
        out[a] = { got: [n.min, n.max], want: [d.min, d.max],
                   eq: n.min === d.min && n.max === d.max,
                   marked: !!n.__rangeAuto };
      });
      return out;
    })()`);
    Object.keys(c1).forEach((k) => {
      ok(c1[k].eq && c1[k].marked, "C1 " + k.padEnd(11) + "量程 " + JSON.stringify(c1[k].got) +
        " = PID " + JSON.stringify(c1[k].want) + "，且已标记为派生");
    });

    // ---------------------------------------------------------------- C2
    console.log("\n=== C2. 手填量程（与 PID 不同）→ 换 PID 不被覆盖 ===");
    const c2 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm", min: 999, max: 7777 });
      // 手填的（createNode 显式给了 min/max）→ 不该有派生标记
      const markedAfterCreate = !!n.__rangeAuto;
      window.assignControlBinding(n, "obd.speed");
      return { markedAfterCreate: markedAfterCreate, min: n.min, max: n.max };
    })()`);
    ok(!c2.markedAfterCreate, "C2 显式给 min/max 的表**没有**派生标记");
    ok(c2.min === 999 && c2.max === 7777, "C2 手填 999~7777 换 PID 后仍为 " + c2.min + "~" + c2.max);

    // ---------------------------------------------------------------- C3（M03 的核心漏洞）
    console.log("\n=== C3. 用户手填量程**恰好等于** PID 默认 → 仍不被覆盖（M03 会误判）===");
    const c3 = await cdp.eval(`(function(){
      // ⚠️ 必须走**真实用户路径**：先建表（量程自动派生、有标记），
      //    然后用手改把值改成"恰好等于 PID 默认"（0~8000 本来就是默认，这里演示改成 0~8000
      //    以外的值再改回来，确保经过 setNodeNum → 标记被清）。
      //
      // 不能直接 createNode({min:0,max:8000})：预设/内置控件就是这么写的
      // （presets.js / next-controls.js 显式传 info.min/max），那条路径**应该**是可跟随的，
      // 否则既有契约 verify-data-bindings 的 "source range follows binding" 就断了。
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm" });   // 0~8000，有标记
      window.CanvasState.design.nodes.push(n);
      window.CanvasState.selection = [n.id];
      const markedOnCreate = !!n.__rangeAuto;
      // 用户手改两个值（经过 setNodeNum → clearRangeAuto）
      window.setNodeNum("min", 0);
      window.setNodeNum("max", 8000);
      const markedAfterEdit = !!n.__rangeAuto;
      window.assignControlBinding(n, "obd.speed");
      return { markedOnCreate: markedOnCreate, markedAfterEdit: markedAfterEdit,
               min: n.min, max: n.max,
               speedRange: [window.BUILTIN_PIDS["std_0D"].min, window.BUILTIN_PIDS["std_0D"].max] };
    })()`);
    ok(c3.markedOnCreate, "C3 新建时是派生（有标记）");
    ok(!c3.markedAfterEdit, "C3 用户手改 min/max 后标记被清除");
    ok(c3.min === 0 && c3.max === 8000,
      "C3 手填的 0~8000（恰好等于转速 PID 默认）换车速后**保留**（车速是 " +
      JSON.stringify(c3.speedRange) + " → 若被覆盖会变 0~260）");

    // ---------------------------------------------------------------- C4
    console.log("\n=== C4. 原 PID 是自定义（不在内置库）===");
    const c4 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid:"my_custom_xyz" });
      const marked = !!n.__rangeAuto;      // 自定义 PID 没有定义 → createNode 仍会打标记（值 0~100）
      const before = [n.min, n.max];
      window.assignControlBinding(n, "obd.coolant");
      const d = window.BUILTIN_PIDS[window.resolvePid("obd.coolant")];
      return { marked: marked, before: before, after: [n.min, n.max], want: [d.min, d.max] };
    })()`);
    ok(c4.marked, "C4 自定义 PID 新建时按回落 0~100 并标记");
    ok(c4.after[0] === c4.want[0] && c4.after[1] === c4.want[1],
      "C4 从自定义 PID 换到内置 PID → 跟随为 " + JSON.stringify(c4.after));

    // ---------------------------------------------------------------- C5
    console.log("\n=== C5. 新 PID 是自定义（无定义可用）===");
    const c5 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm" });   // 0~8000，有标记
      window.assignControlBinding(n, "another_custom_pid");
      return { min: n.min, max: n.max, marked: !!n.__rangeAuto };
    })()`);
    ok(c5.min === 0 && c5.max === 8000,
      "C5 换到自定义 PID 时**保留原量程** " + c5.min + "~" + c5.max + "（自定义无定义，不乱改）");

    // ---------------------------------------------------------------- C6
    console.log("\n=== C6. 主动点「回填量程」→ 跟随并重新成为派生 ===");
    const c6 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm", min: 1, max: 2 });  // 手填怪值
      window.CanvasState.design.nodes.push(n);
      window.CanvasState.selection = [n.id];
      const before = [n.min, n.max];
      window.applyPidDefaults();
      const after = [n.min, n.max];
      const d = window.BUILTIN_PIDS["std_0C"];
      return { before: before, after: after, want: [d.min, d.max], marked: !!n.__rangeAuto };
    })()`);
    ok(c6.after[0] === c6.want[0] && c6.after[1] === c6.want[1],
      "C6 回填按钮把 " + JSON.stringify(c6.before) + " 改成 " + JSON.stringify(c6.after));
    ok(c6.marked, "C6 回填后重新成为派生（之后换 PID 会跟随）");

    // ---------------------------------------------------------------- C7
    console.log("\n=== C7. Undo / Redo ===");
    const c7 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm" });
      window.commit(function(){ window.CanvasState.design.nodes.push(n); }, "加表");
      window.CanvasState.selection = [n.id];
      window.commit(function(){ n.min = 100; n.max = 200; }, "改量程");
      const changed = n.min === 100 && n.max === 200;
      function find(id){ let o=null; window.walk(window.CanvasState.design.nodes, x=>{ if(x.id===id) o=x; }); return o; }
      window.doUndo();
      const u = find(n.id);
      const afterUndo = !!u && u.min === 0 && u.max === 8000;
      window.doRedo();
      const r = find(n.id);
      const afterRedo = !!r && r.min === 100 && r.max === 200;
      return { changed: changed, afterUndo: afterUndo, afterRedo: afterRedo,
               undoVal: u ? [u.min, u.max] : null, redoVal: r ? [r.min, r.max] : null };
    })()`);
    ok(c7.changed && c7.afterUndo && c7.afterRedo,
      "C7 Undo 回到 " + JSON.stringify(c7.undoVal) + "，Redo 回到 " + JSON.stringify(c7.redoVal));

    // ---------------------------------------------------------------- C8
    console.log("\n=== C8. 导出→重新导入后**不再自动跟随**（标记不进文件，保守）===");
    const c8 = await cdp.eval(`(function(){
      const n = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm" });
      window.commit(function(){ window.CanvasState.design.nodes.push(n); }, "加表");
      // ⚠️ toV2Json 返回**已经是字符串**，再 JSON.stringify 会双重编码 → 解析必失败
      //    （第一版就是这么错的，报"解析失败"却看不出原因）。
      const text = window.toV2Json(window.CanvasState.design);
      const hasAutoField = text.indexOf("__rangeAuto") >= 0;
      const parsed = window.parseDesign(text);
      if (!parsed.design) return { err: "解析失败", errors: parsed.errors };
      // 找到刚导出的那块表
      let back = null;
      window.walk(parsed.design.nodes, x => { if (x.type === window.NODE_GAUGE && x.pid === "std_0C") back = x; });
      if (!back) return { err: "重新导入后找不到该表" };
      const markedAfterReload = !!back.__rangeAuto;
      window.assignControlBinding(back, "obd.speed");
      return { hasAutoField: hasAutoField, markedAfterReload: markedAfterReload,
               min: back.min, max: back.max };
    })()`);
    ok(!c8.err, "C8 导出/解析无错（" + (c8.err || "ok") + "）");
    ok(!c8.hasAutoField, "C8 导出 JSON **不含** __rangeAuto（不污染设计文件）");
    ok(!c8.markedAfterReload, "C8 重新导入后**没有**派生标记");
    ok(c8.min === 0 && c8.max === 8000,
      "C8 因此换 PID 时**保留**原量程 " + c8.min + "~" + c8.max + "（保守，不猜）");

    // ---------------------------------------------------------------- C9
    console.log("\n=== C9. 旧主题（无标记）手填量程不被静默覆盖 ===");
    const c9 = await cdp.eval(`(function(){
      // 构造一个"旧主题"节点：直接是普通对象，没有 __rangeAuto
      const old = { id:"old1", type: window.NODE_GAUGE, name:"旧表", pid:"std_0C", rawPid:"obd.rpm",
                    min: 1234, max: 5678, warnLow:null, warnHigh:6500, parts: null };
      window.assignControlBinding(old, "obd.speed");
      return { min: old.min, max: old.max };
    })()`);
    ok(c9.min === 1234 && c9.max === 5678,
      "C9 旧主题手填 1234~5678 换 PID 后仍为 " + c9.min + "~" + c9.max);

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
  process.exitCode = fail ? 1 : 0;
})();
