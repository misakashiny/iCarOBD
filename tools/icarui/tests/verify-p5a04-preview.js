// ============================================================================
// verify-p5a04-preview.js —— P5A-M04 阶段 B：比例预览**数据安全**验证
//
// ## 为什么要有这个套件
//
// P5A-M03 的「比例预览」按钮直接调 `canvasChanged()`，那会写
// `S.design.canvas.designW/H` → **改到正式主题**、进 undo 栈、进草稿、影响导出。
// 用户只想"看看车载宽屏长什么样"，却把主题的设计尺寸改了 —— 数据安全隐患。
//
// P5A-M04 改为**临时预览**：只设 `S.previewAspect`（不写设计数据），
// `applyCanvasSize()` 读它改画布**显示比例**。
//
// 本套件逐条钉住任务 §4 的 6 个问题：
//   B1 是否改变真实主题尺寸？            → 否（且导出 JSON 逐字节相同）
//   B2 是否自动保存到草稿？              → 否（localStorage 零改动、undo 栈不变）
//   B3 是否影响导出的设计文件？          → 否（预览中/退出后导出完全一致）
//   B4 是否影响节点位置/尺寸/布局？      → 否（全部节点字段零变化）
//   B5 是否能恢复？                      → 有显式「恢复正式尺寸」；且它根本不进历史
//   B6 用户能否识别"这是临时预览"？      → 提示面板显示「👁 预览中…未修改主题设计尺寸」
//
// 说明：`scaleMode` 本身的读写/导出能力由 `verify-p5a03-scale.js`（20 断言）覆盖，
// 本套件不重复。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9361;
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
  const userDir = path.join(os.tmpdir(), "p5a04-prev-" + Date.now());
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
        " && window.applyScreenPreset && window.SCALE_MODES)"
      ).catch(() => false);
      if (ready) break;
      await sleep(400);
    }

    // ---------------------------------------------------------------- B1
    console.log("=== B1. 点预览**不改变**真实主题设计尺寸 ===");
    const b1 = await cdp.eval(`(function(){
      const d = window.CanvasState.design;
      const before = { w: d.canvas.designW, h: d.canvas.designH, mode: d.canvas.scaleMode };
      const jsonBefore = JSON.stringify(window.toV2Json(d));
      window.applyScreenPreset("carwide");
      const after = { w: d.canvas.designW, h: d.canvas.designH, mode: d.canvas.scaleMode };
      const jsonAfter = JSON.stringify(window.toV2Json(d));
      return { before: before, after: after, jsonSame: jsonBefore === jsonAfter,
               previewAspect: window.CanvasState.previewAspect };
    })()`);
    ok(b1.before.w === b1.after.w && b1.before.h === b1.after.h,
      "B1 设计尺寸未变：" + b1.before.w + "×" + b1.before.h + " → " + b1.after.w + "×" + b1.after.h);
    ok(b1.before.mode === b1.after.mode, "B1 缩放模式也未变（" + b1.after.mode + "）");
    ok(b1.jsonSame, "B1 导出 JSON **逐字节相同**");
    ok(Math.abs(b1.previewAspect - 1280 / 600) < 1e-6,
      "B1 预览状态已生效 previewAspect=" + (b1.previewAspect || 0).toFixed(4));

    // ---------------------------------------------------------------- B3
    console.log("\n=== B3. 预览中导出与退出后**完全一致** ===");
    const b3 = await cdp.eval(`(function(){
      const jsonPreview = JSON.stringify(window.toV2Json(window.CanvasState.design));
      window.clearScreenPreset();
      const jsonClear = JSON.stringify(window.toV2Json(window.CanvasState.design));
      return { same: jsonPreview === jsonClear, previewCleared: window.CanvasState.previewAspect };
    })()`);
    ok(b3.same, "B3 预览中 / 退出后 导出的 JSON 完全相同");
    ok(!b3.previewCleared, "B3 「恢复正式尺寸」能清掉预览状态");

    // ---------------------------------------------------------------- B2
    console.log("\n=== B2. 预览**不写草稿、不进 undo** ===");
    const b2 = await cdp.eval(`(function(){
      const before = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        before[k] = localStorage.getItem(k);
      }
      const undoBefore = (function(){ try { return JSON.stringify(window.CanvasState.undo || null); } catch(e){ return "?"; } })();
      window.applyScreenPreset("tablet");
      window.clearScreenPreset();
      const changed = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (before[k] !== localStorage.getItem(k)) changed.push(k);
      }
      for (const k of Object.keys(before)) if (localStorage.getItem(k) === null) changed.push(k + "(deleted)");
      const undoAfter = (function(){ try { return JSON.stringify(window.CanvasState.undo || null); } catch(e){ return "?"; } })();
      return { changed: changed, undoSame: undoBefore === undoAfter };
    })()`);
    ok(b2.changed.length === 0, "B2 localStorage 无任何键被改（" +
      (b2.changed.length ? b2.changed.join(",") : "0 个") + "）");
    ok(b2.undoSame, "B2 undo 栈未变化（预览不进历史）");

    // ---------------------------------------------------------------- B4
    console.log("\n=== B4. 预览**不改变节点**位置/尺寸/量程 ===");
    const b4 = await cdp.eval(`(function(){
      const d = window.CanvasState.design;
      const snap = function(){
        const out = [];
        window.walk(d.nodes, function(n){
          out.push([n.id, n.type, n.x, n.y, n.w, n.h, n.min, n.max,
                    n.parts ? n.parts.length : -1, n.rotation, n.alpha]);
        });
        out.sort(function(a,b){ return a[0] < b[0] ? -1 : 1; });
        return JSON.stringify(out);
      };
      const before = snap();
      window.applyScreenPreset("phone");
      const mid1 = snap();
      window.applyScreenPreset("carwide");
      const mid2 = snap();
      window.clearScreenPreset();
      const after = snap();
      let count = 0;
      window.walk(d.nodes, function(){ count++; });
      return { same: (before === mid1) && (before === mid2) && (before === after), nodeCount: count };
    })()`);
    ok(b4.same, "B4 " + b4.nodeCount + " 个节点在 手机/车载/恢复 三次切换中**完全未变**");

    // ---------------------------------------------------------------- B6
    console.log("\n=== B6. 界面明确标出「预览中 / 未修改主题设计尺寸」===");
    const b6 = await cdp.eval(`(function(){
      window.applyScreenPreset("carwide");
      const box = document.getElementById("scaleHint");
      const txtPreview = box ? box.textContent : "";
      window.clearScreenPreset();
      const txtNormal = box ? box.textContent : "";
      return { preview: txtPreview, normal: txtNormal,
               hasPreviewWord: txtPreview.indexOf("预览中") >= 0,
               hasNoModify: txtPreview.indexOf("未修改") >= 0,
               normalNoPreview: txtNormal.indexOf("预览中") < 0 };
    })()`);
    ok(b6.hasPreviewWord, "B6 预览时提示含「预览中」");
    ok(b6.hasNoModify, "B6 预览时提示含「未修改」");
    ok(b6.normalNoPreview, "B6 退出后不再显示「预览中」");
    console.log("    预览态文案：" + (b6.preview.split("\n")[0] || "").slice(0, 72));

    // ---------------------------------------------------------------- B5
    console.log("\n=== B5. 可恢复性 ===");
    const b5 = await cdp.eval(`(function(){
      window.applyScreenPreset("tablet");
      const inPreview = !!window.CanvasState.previewAspect;
      window.clearScreenPreset();
      const cleared = !window.CanvasState.previewAspect;
      return { inPreview: inPreview, cleared: cleared };
    })()`);
    ok(b5.inPreview && b5.cleared, "B5 预览可进入也可退出（不需要 Undo：它根本不进历史）");

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
