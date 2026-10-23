// P5B-M01 阶段 D：验证 box_h1/h2/note 的 font.size 在创建后是否被错误归一化成 6
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9391;
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
  const userDir = path.join(os.tmpdir(), "p5b01d-" + Date.now());
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
    await cdp.eval("window.alert=function(){};window.confirm=function(){return true};window.prompt=function(){return null};1");
    for (let i = 0; i < 80; i++) {
      const ready = await cdp.eval("!!(window.CanvasState && window.CanvasState.design && window.normalizeFont && window.PRESETS)").catch(() => false);
      if (ready) break;
      await sleep(400);
    }

    console.log("=== D1. FONT_DEFAULT 是 6（这是画布单位的设计值，不是 bug）===");
    const fd = await cdp.eval("JSON.stringify(window.FONT_DEFAULT)");
    const fontDefault = JSON.parse(fd);
    ok(fontDefault.size === 6, "D1 FONT_DEFAULT.size = " + fontDefault.size + "（画布 360 单位下的合理默认）");

    console.log("\n=== D2. 四个文字预设自带明确 size ===");
    const presets = await cdp.eval(`JSON.stringify(
      ["box_h1","box_h2","box_note"].map(function(k){
        var p = (window.PRESETS_TEXT || []).find(function(x){return x.key===k;});
        return { key: k, found: !!p, size: p ? p.size : null };
      }))`);
    console.log("    " + presets);

    console.log("\n=== D3. 真实创建：createNode(NODE_TEXT) 的 font.size 实际是多少 ===");
    const created = await cdp.eval(`JSON.stringify((function(){
      const out = [];
      ["box_h1","box_h2","box_note"].forEach(function(k){
        const n = window.createNode(window.NODE_TEXT, { text: "测试" });
        out.push({ key: k, size: n.font ? n.font.size : null });
      });
      // 显式传 size 时是否被尊重
      const n2 = window.createNode(window.NODE_TEXT, { text: "测试", font: { size: 30 } });
      out.push({ key: "explicit30", size: n2.font ? n2.font.size : null });
      return out;
    })())`);
    console.log("    " + created);
    const parsed = JSON.parse(created);
    const explicit = parsed.find((x) => x.key === "explicit30");
    ok(explicit && explicit.size === 30, "D3 显式 font.size=30 **被正确保留**（实际 " + (explicit ? explicit.size : "?") + "）—— 说明 normalizeFont 没有把用户显式值改小");

    console.log("\n=== D4. 预设定义里带了 size，但 createNode 不读它 → 这是不是缺陷？ ===");
    // PRESETS 里的 box_h1 是"控件库预设"，其 size 只有在走预设创建路径时才该生效
    const viaPreset = await cdp.eval(`JSON.stringify((function(){
      var list = window.PRESETS["blank"] ? null : null;
      // 走控件库路径：BUILTIN_CONTROLS 里如果有 box_h1，用它的 make()
      var c = (window.BUILTIN_CONTROLS||[]).find(function(x){return x.key==="box_h1";});
      if (!c) return { available: false };
      var n = c.make();
      return { available: true, size: n.font ? n.font.size : null, text: n.text };
    })())`);
    console.log("    " + viaPreset);
    const vp = JSON.parse(viaPreset);
    if (vp.available) {
      ok(vp.size !== 6, "D4 走控件库创建 box_h1 时字号不是 6（实际 " + vp.size + "）");
    } else {
      console.log("    ⏭ BOX 系列不在 BUILTIN_CONTROLS 里（属 text 预设），跳过该路径");
    }

    console.log("\n=== D5. 用户显式字体永远优先（不能被归一化吃掉）===");
    const prio = await cdp.eval(`JSON.stringify([
      { label: "size 12",  got: window.normalizeFont({ size: 12 }).size,  want: 12 },
      { label: "size 30",  got: window.normalizeFont({ size: 30 }).size,  want: 30 },
      { label: "size 0.5", got: window.normalizeFont({ size: 0.5 }).size, want: 0.5 },
      { label: "size 0",   got: window.normalizeFont({ size: 0 }).size,   want: 6 },
      { label: "size -3",  got: window.normalizeFont({ size: -3 }).size,  want: 6 },
      { label: "size NaN", got: window.normalizeFont({ size: "x" }).size, want: 6 }
    ])`);
    const prioArr = JSON.parse(prio);
    prioArr.forEach((p) => {
      ok(p.got === p.want, "D5 " + p.label.padEnd(10) + " → " + p.got + "（期望 " + p.want + "）");
    });

    console.log("\n=== D6. 保存/导入往返不改变字号 ===");
    const roundTrip = await cdp.eval(`JSON.stringify((function(){
      var n = window.createNode(window.NODE_TEXT, { text: "标题", font: { size: 30, family: "sans", weight: 700 } });
      var design = window.CanvasState.design;
      var before = n.font.size;
      // ⚠️ 第一版忘了把节点放进 design 就导出 → walk 找不到 → after=null（假失败）
      // ⚠️ 必须 push 到 design.nodes（= 当前页 nodes 的引用），
      //    不是 pages[0].nodes —— 当前 pageIndex 可能不是 0，导出只取当前页。
      design.nodes.push(n);
      // 序列化 → 解析 → 再取
      var json = window.toV2Json(design);
      var back = window.parseDesign(json);
      if (!back.design) return { err: "解析失败", errors: back.errors };
      var found = null;
      window.walk(back.design.nodes, function(x){ if (x.type === window.NODE_TEXT && x.text === "标题") found = x; });
      return { before: before, after: found ? found.font.size : null, weight: found ? found.font.weight : null,
               nodeCount: (back.design.nodes || []).length };
    })())`);
    console.log("    " + roundTrip);
    const rt = JSON.parse(roundTrip);
    ok(!rt.err && rt.before === rt.after, "D6 保存→导入后字号一致（" + rt.before + " → " + rt.after + "）");
    ok(rt.weight === 700, "D6 字重也保留（" + rt.weight + "）");

    console.log("\n=== D7. Undo/Redo 后字号不丢 ===");
    const undoTest = await cdp.eval(`JSON.stringify((function(){
      var design = window.CanvasState.design;
      var n = window.createNode(window.NODE_TEXT, { text: "撤销测试", fontSize: 30 });
      window.commit(function(){ design.nodes.push(n); }, "加文字");
      function find(id){ var o=null; window.walk(window.CanvasState.design.nodes, function(x){ if(x.id===id) o=x; }); return o; }
      var added = find(n.id);
      var afterAdd = added ? added.font.size : null;
      window.doUndo();
      var afterUndo = find(n.id);
      window.doRedo();
      var afterRedo = find(n.id);
      return { afterAdd: afterAdd,
               afterUndo: afterUndo ? afterUndo.font.size : null,
               afterRedo: afterRedo ? afterRedo.font.size : null,
               undoRemoved: afterUndo === null };
    })())`);
    console.log("    " + undoTest);
    const ut = JSON.parse(undoTest);
    ok(ut.afterAdd === 30, "D7 创建后字号 30");
    ok(ut.undoRemoved, "D7 Undo 移除了该节点");
    ok(ut.afterRedo === 30, "D7 Redo 恢复后字号仍是 30（实际 " + ut.afterRedo + "）");

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
