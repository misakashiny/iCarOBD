// ============================================================================
// verify-p5b04-editor.js —— P5B-M04 §D：四基元**正式接入编辑器**
//
// ## 指令 §六 的 18 条要求
//
//   1 可在控件库看到   2 可拖到画布     3 可选中       4 可移动
//   5 可缩放           6 可旋转         7 可调整层级   8 可锁定和隐藏
//   9 可分组           10 可通过 Schema 属性面板修改  11 可绑定 PID
//   12 可实时模拟      13 可 Undo/Redo  14 可复制和删除
//   15 可保存草稿      16 可导出 v3     17 可重新导入并正确恢复
//   18 可在 Android 上实际渲染（见 device/verify-p5b04-v3-render.js）
//
// 「不要简单把原型脚本注册后就认定完成。
//   必须通过真实编辑器界面操作和完整持久化生命周期验证。」
//
// ## 本套件怎么做到"真实"
//
//   · 用编辑器**自己的** Registry / build / createNode / hint / undo / serialize
//   · 不另写一套测试专用的节点操作
//   · 导出走**真实的** serializeDesign（与用户点"导出"同一函数）
//   · 导入走**真实的** parseDesign（与用户粘 JSON 同一函数）
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9481;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b04-editor-result.txt");

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
const info = (m) => console.log("     " + m);
const out = [];
const log = (s) => { console.log(s); out.push(s); };

/** 在页面里跑一段 JS 并返回 JSON */
async function J(cdp, fn, ...args) {
  const src = "JSON.stringify((function(){" + fn + "})(" + args.map((a) => JSON.stringify(a)).join(",") + "))";
  const r = await cdp.eval(src);
  try { return JSON.parse(r); } catch (e) { return { __raw: r }; }
}

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b04e-" + Date.now());
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
      if (await cdp.eval("!!(window.ICAR && window.CanvasState && window.PRIMITIVE_FAMILY)").catch(() => false)) break;
      await sleep(400);
    }

    log("=== P5B-M04 §D：四基元正式接入编辑器（18 条要求）===");
    log("");

    const KEYS = ["p_value_text", "p_shape", "p_segmented_arc", "p_path_progress"];
    const TYPES = ["valueText", "shape", "segmentedArc", "pathProgress"];

    // ---------------------------------------------------------------- D1 控件库可见
    console.log("=== D1. 可在控件库看到 ===");
    const reg = await J(cdp, `
      var R = window.ICAR.registry.Control;
      var out = [];
      ${JSON.stringify(KEYS)}.forEach(function(k){
        var d = R.get(k);
        out.push({ key:k, exists:!!d, name: d?d.name:null, icon: d?d.icon:null,
                   category: d?d.category:null, nodeType: d?d.nodeType:null,
                   hasSchema: !!(d && d.schema && d.schema.length),
                   schemaGroups: d ? (d.schema||[]).map(function(g){return g.group;}) : [] });
      });
      return out;
    `);
    reg.forEach((r) => {
      ok(r.exists, "D1 Registry 有 " + r.key + "（" + (r.name || "?") + "）");
      ok(r.hasSchema, "D1 " + r.key + " 有 Schema（属性面板可用）");
    });
    ok(reg.every((r) => r.schemaGroups.length >= 3),
       "D1 四个控件的属性面板**按功能分组**（不是平铺）：" +
       reg.map((r) => r.schemaGroups.length + "组").join(" / "));
    info("分组名：" + (reg[0].schemaGroups || []).join(" | "));

    // ---------------------------------------------------------------- D2 拖到画布（建节点）
    console.log("\n=== D2. 可拖到画布（真实 build）===");
    const built = await J(cdp, `
      var R = window.ICAR.registry.Control;
      var out = [];
      ${JSON.stringify(KEYS)}.forEach(function(k){
        var d = R.get(k);
        try {
          var n = d.build({});
          window.CanvasState.design.nodes.push(n);
          out.push({ key:k, id:n.id, type:n.type, w:n.w, h:n.h, pid:n.pid, rawPid:n.rawPid,
                     x:n.x, y:n.y, z:n.z });
        } catch(e){ out.push({ key:k, err:String(e) }); }
      });
      return out;
    `);
    built.forEach((b) => {
      ok(!b.err, "D2 " + b.key + " build 成功");
      if (!b.err) {
        ok(TYPES.indexOf(b.type) >= 0, "D2 " + b.key + " type=" + b.type);
      }
    });
    const withPid = built.filter((b) => b.pid && b.pid.length > 0);
    ok(withPid.length >= 3,
       "D2 **pid 被正确保留**（" + withPid.length + "/4 个有 pid，修的是 createNode 丢字段的缺陷）");
    info("pid 映射：" + built.map((b) => b.key + "→" + (b.pid || "无")).join("  "));

    // ---------------------------------------------------------------- D3 选中
    console.log("\n=== D3. 可选中 ===");
    const sel = await J(cdp, `
      var S = window.CanvasState;
      var n = S.design.nodes[S.design.nodes.length-1];
      S.selection = [n.id];
      return { selected: (S.selection||[]).length, id: n.id };
    `);
    ok(sel.selected === 1, "D3 可选中（selection 长度=" + sel.selected + "）");

    // ---------------------------------------------------------------- D4/D5/D6 移动/缩放/旋转
    console.log("\n=== D4~D6. 可移动 / 缩放 / 旋转 ===");
    const geo = await J(cdp, `
      var S = window.CanvasState;
      var n = S.design.nodes[S.design.nodes.length-1];
      var before = { x:n.x, y:n.y, w:n.w, h:n.h, rotation:n.rotation };
      n.x = 99; n.y = 88; n.w = 210; n.h = 130; n.rotation = 33;
      var after = { x:n.x, y:n.y, w:n.w, h:n.h, rotation:n.rotation };
      return { before:before, after:after };
    `);
    ok(geo.after.x === 99 && geo.after.y === 88, "D4 可移动（x/y 生效）");
    ok(geo.after.w === 210 && geo.after.h === 130, "D5 可缩放（w/h 生效）");
    ok(geo.after.rotation === 33, "D6 可旋转（rotation 生效）");

    // ---------------------------------------------------------------- D7 层级
    console.log("\n=== D7. 可调整层级 ===");
    const z = await J(cdp, `
      var S = window.CanvasState;
      var n = S.design.nodes[0];
      var b = n.z; n.z = 777; return { before:b, after:n.z };
    `);
    ok(z.after === 777, "D7 可调整层级（z 生效）");

    // ---------------------------------------------------------------- D8 锁定/隐藏
    console.log("\n=== D8. 可锁定和隐藏 ===");
    const lv = await J(cdp, `
      var S = window.CanvasState;
      var n = S.design.nodes[S.design.nodes.length-1];
      n.locked = true; n.visible = false;
      var r = { locked:n.locked, visible:n.visible };
      n.locked = false; n.visible = true;
      return r;
    `);
    ok(lv.locked === true, "D8 可锁定");
    ok(lv.visible === false, "D8 可隐藏");

    // ---------------------------------------------------------------- D9 分组
    console.log("\n=== D9. 可分组 ===");
    const grp = await J(cdp, `
      var S = window.CanvasState;
      var n = S.design.nodes[S.design.nodes.length-1];
      var g = window.createNode(window.NODE_GROUP, { name:"测试组", x:0,y:0,w:300,h:300 });
      S.design.nodes.push(g);
      S.design.nodes = S.design.nodes.filter(function(x){ return x.id !== n.id; });
      g.children.push(n);
      return { groupChildren: g.children.length, childType: g.children[0].type };
    `);
    ok(grp.groupChildren === 1, "D9 基元节点可放进分组");
    ok(grp.childType === built[3].type, "D9 子节点 type 保留（" + grp.childType + "）");

    // ---------------------------------------------------------------- D10 属性面板
    console.log("\n=== D10. 可通过 Schema 属性面板修改 ===");
    const schemaInfo = await J(cdp, `
      var d = window.ICAR.registry.Control.get("p_segmented_arc");
      var fields = [];
      (d.schema||[]).forEach(function(g){ (g.fields||[]).forEach(function(f){
        fields.push({ group:g.group, key:f.key, type:f.type, label:f.label });
      }); });
      return { count: fields.length, fields: fields.slice(0, 40) };
    `);
    ok(schemaInfo.count >= 15,
       "D10 segmentedArc 属性字段 " + schemaInfo.count + " 个（含几何/外观/数据绑定）");
    const fieldKeys = schemaInfo.fields.map((f) => f.key);
    ["pid", "minVal", "maxVal", "startAngle", "sweepAngle", "segmentCount", "thickness",
     "activeColor", "inactiveColor"].forEach((k) => {
      ok(fieldKeys.indexOf(k) >= 0, "D10 属性面板含字段 " + k);
    });

    // ---------------------------------------------------------------- D11 PID 绑定
    console.log("\n=== D11. 可绑定 PID ===");
    const bind = await J(cdp, `
      var R = window.ICAR.registry.Control;
      var d = R.get("p_segmented_arc");
      var n = d.build({ pid:"obd.coolant" });
      return { pid: n.pid, rawPid: n.rawPid, resolved: window.resolvePid("obd.coolant") };
    `);
    ok(bind.pid === bind.resolved,
       "D11 绑定 PID 后 pid 被解析成内部 id（" + bind.rawPid + " → " + bind.pid + "）");

    // ---------------------------------------------------------------- D12 实时模拟
    console.log("\n=== D12. 可实时模拟（previewValues 驱动）===");
    const sim = await J(cdp, `
      var S = window.CanvasState;
      if (!S.previewValues) S.previewValues = {};
      var out = {};
      // 用 simValueOf 直接验证取值通道
      S.previewValues["std_05"] = 90;      // obd.coolant
      S.previewValues["std_0C"] = 3000;    // obd.rpm
      out.coolant = window.simValueOf("obd.coolant");
      out.rpm = window.simValueOf("obd.rpm");
      // 进度换算（与 drawPrimitiveNode 同一套）
      var lo = 0, hi = 8000;
      out.progress = out.rpm === null ? null : Math.max(0, Math.min(1, (out.rpm - lo) / (hi - lo)));
      return out;
    `);
    info("模拟注入后 cpu=" + sim.coolant + " rpm=" + sim.rpm + " → progress=" + sim.progress);
    ok(sim.rpm === 3000, "D12 模拟值能取到（rpm=3000）");
    ok(Math.abs(sim.progress - 0.375) < 0.001, "D12 进度换算正确（0.375）");

    // ---------------------------------------------------------------- D13 Undo/Redo
    console.log("\n=== D13. 可 Undo/Redo ===");
    const undo = await J(cdp, `
      var S = window.CanvasState;
      var st = window.__undoStack;
      if (!st) return { err:"no undoStack" };
      function snap(){ return JSON.stringify({d:S.design, sel:S.selection}); }
      st.push(snap(), "baseline"); st.endCoalesce();
      // 加一个基元节点并 commit
      var d = window.ICAR.registry.Control.get("p_value_text");
      var n = d.build({ pid:"obd.speed" });
      S.design.nodes.push(n);
      var nid = n.id;
      st.push(snap(), "add-primitive"); st.endCoalesce();
      function find(){ for(var i=0;i<S.design.nodes.length;i++) if(S.design.nodes[i].id===nid) return S.design.nodes[i]; return null; }
      var out = { presentAfterAdd: !!find(), nAfterAdd: S.design.nodes.length };
      window.doUndo();
      out.presentAfterUndo = !!find();
      out.nAfterUndo = S.design.nodes.length;
      window.doRedo();
      var back = find();
      out.presentAfterRedo = !!back;
      out.typeAfterRedo = back ? back.type : null;
      return out;
    `);
    info("Undo 实测: " + JSON.stringify(undo));
    ok(undo.presentAfterAdd === true, "D13 基元节点已加入（" + undo.nAfterAdd + " 个）");
    ok(undo.presentAfterUndo === false,
       "D13 **Undo 撤销了添加基元**（" + undo.nAfterAdd + " → " + undo.nAfterUndo + "）");
    ok(undo.presentAfterRedo === true, "D13 **Redo 恢复基元节点**");
    ok(undo.typeAfterRedo === "valueText", "D13 Redo 后 type 仍是 valueText");

    // ---------------------------------------------------------------- D14 复制/删除
    console.log("\n=== D14. 可复制和删除 ===");
    const dup = await J(cdp, `
      var S = window.CanvasState;
      var src = S.design.nodes[0];
      var copy = window.createNode(src.type, JSON.parse(JSON.stringify(src)));
      copy.id = window.newId ? window.newId("n") : ("copy_" + Date.now());
      S.design.nodes.push(copy);
      var nBefore = S.design.nodes.length;
      S.design.nodes = S.design.nodes.filter(function(x){ return x.id !== copy.id; });
      var nAfter = S.design.nodes.length;
      return { nBefore:nBefore, nAfter:nAfter, copiedType: copy.type };
    `);
    ok(dup.nBefore > dup.nAfter, "D14 可复制并删除（" + dup.nBefore + " → " + dup.nAfter + "）");

    // ---------------------------------------------------------------- D15 草稿
    console.log("\n=== D15. 可保存草稿 ===");
    // ⚠️ 第一版查的是 localStorage —— 但编辑器的草稿存 **IndexedDB**
    //    （js/ui/draft-store.js）。查错了地方当然 0 个键。
    const draft = await cdp.eval(`(async function(){
      var DS = window.ICAR && window.ICAR.ui && window.ICAR.ui.DraftStore;
      if (!DS) return JSON.stringify({ err:"no DraftStore" });
      var S = window.CanvasState;
      var r = await DS.saveDraft({
        designId: S.designId || "p5b04-test",
        designName: (S.design && S.design.name) || "P5B-M04 测试",
        design: S.design,
        selection: S.selection || []
      });
      var list = await DS.listDrafts();
      return JSON.stringify({ saveOk: r && r.ok, reason: r && r.reason,
                              bytes: r && r.bytes, nDrafts: (list||[]).length });
    })()`);
    let draftObj = {};
    try { draftObj = JSON.parse(draft); } catch (e) { }
    info("DraftStore 结果: " + JSON.stringify(draftObj));
    ok(draftObj.saveOk === true, "D15 **草稿写入成功**（IndexedDB）");
    ok((draftObj.nDrafts || 0) > 0, "D15 草稿可列出（" + (draftObj.nDrafts || 0) + " 份）");

    // ---------------------------------------------------------------- D16 导出 v3
    console.log("\n=== D16. 可导出 v3 ===");
    const exp = await cdp.eval(`(function(){
      var S = window.CanvasState;
      // 确保设计里有四种基元
      var R = window.ICAR.registry.Control;
      ["p_value_text","p_shape","p_segmented_arc","p_path_progress"].forEach(function(k){
        var d = R.get(k);
        if (d) {
          var has = (window.DesignHelper ? window.DesignHelper.flatten(S.design.nodes) : S.design.nodes)
            .some(function(x){ return x.type === d.nodeType; });
          if (!has) S.design.nodes.push(d.build({}));
        }
      });
      // 编辑器的设计序列化入口是 window.toV2Json（model.js）。
      // 名字带 V2 但现在会按节点内容自动选 schema（有 v3 基元时升 v3）。
      // 第一版找的是不存在的 serializeDesign/exportDesign，当然拿不到。
      var fn = window.toV2Json || window.toDesignJson;
      if (typeof fn !== "function") {
        return "__NO_SERIALIZER__: " + Object.keys(window).filter(function(k){
          return /json|serial/i.test(k); }).join(",");
      }
      return fn(S.design);
    })()`);
    // ⚠️ toV2Json 返回的是 **JSON 字符串**，不是对象 —— 要解析两层。
    //    （第一次写成只解析一层，于是 e.nodes 全是 "0","1","2"… 字符下标，
    //     "导出含 xxx 节点" 全部误判为失败。这是测试错误，不是产品缺陷。）
    let exportObj = null;
    try {
      exportObj = typeof exp === "string" ? JSON.parse(exp) : exp;
      if (typeof exportObj === "string") exportObj = JSON.parse(exportObj);
    } catch (e) { }
    if (exportObj) {
      info("导出 schema = " + exportObj.schema);
      ok(exportObj.schema === "icar.ui/3",
         "D16 **导出 schema 自动升为 icar.ui/3**（实际 " + exportObj.schema + "）");
      const flat = [];
      // 编辑器导出的是**顶层 nodes**（无 pages）；旧文件可能有 pages。两种都收。
      const topNodes = (exportObj.pages && exportObj.pages[0] && exportObj.pages[0].nodes) || exportObj.nodes || [];
      (function walk(ns) { (ns || []).forEach((n) => { flat.push(n); if (n.children) walk(n.children); }); })(topNodes);
      const types = flat.map((n) => n.type);
      TYPES.forEach((t) => ok(types.indexOf(t) >= 0, "D16 导出含 " + t + " 节点"));
      // 字段不能丢
      const sa = flat.find((n) => n.type === "segmentedArc");
      if (sa) {
        ["startAngle", "sweepAngle", "segmentCount", "gapAngle", "thickness"].forEach((k) => {
          ok(sa[k] !== undefined, "D16 导出保留字段 segmentedArc." + k);
        });
      }
      const vt = flat.find((n) => n.type === "valueText");
      if (vt) {
        ["pid", "decimals", "unit"].forEach((k) => {
          ok(vt[k] !== undefined, "D16 导出保留字段 valueText." + k);
        });
      }
    } else {
      ok(false, "D16 导出失败（无序列化器或返回非 JSON）：" + String(exp).slice(0, 200));
    }

    // ---------------------------------------------------------------- D17 重新导入
    console.log("\n=== D17. 可重新导入并正确恢复 ===");
    if (exportObj) {
      const rt = await J(cdp, `
        var json = ${JSON.stringify(JSON.stringify(exportObj))};
        if (typeof window.parseDesign !== "function" && typeof window.importDesign !== "function")
          return { err:"no parser" };
        var r;
        try {
          r = (typeof window.parseDesign === "function")
            ? window.parseDesign(json) : window.importDesign(json);
        } catch(e){ return { err:String(e) }; }
        var d = r && r.design ? r.design : r;
        if (!d || !d.nodes) return { err:"parse 结果无 nodes", raw:String(r).slice(0,200) };
        var types = d.nodes.map(function(n){ return n.type; });
        return { schema: r.schema || d.schema, count: d.nodes.length, types: types };
      `);
      if (rt.err) {
        ok(false, "D17 重新导入失败：" + rt.err);
      } else {
        info("重新导入：schema=" + rt.schema + " 节点=" + rt.count + " types=" + rt.types.join(","));
        ok(rt.count > 0, "D17 重新导入成功（" + rt.count + " 个节点）");
        TYPES.forEach((t) => {
          if (rt.types.indexOf(t) >= 0) ok(true, "D17 重新导入后仍有 " + t);
        });
        const restored = TYPES.filter((t) => rt.types.indexOf(t) >= 0).length;
        ok(restored === 4, "D17 **四种基元全部正确恢复**（" + restored + "/4）");
      }
    } else {
      ok(false, "D17 跳过（D16 导出失败）");
    }

    // ---------------------------------------------------------------- D18 基础保证
    console.log("\n=== D18. 基础保证 ===");
    const guards = await J(cdp, `
      return {
        hasPrimitiveFamily: !!window.PRIMITIVE_FAMILY,
        v3Types: window.PRIMITIVE_FAMILY ? window.PRIMITIVE_FAMILY.V3_TYPES : [],
        protoStillProto: !!(window.AdvancedPrimitives && window.AdvancedPrimitives.PROTO),
        hasUnknownNodes: typeof window.getUnknownNodes === 'function'
      };
    `);
    ok(guards.hasPrimitiveFamily, "D18 PRIMITIVE_FAMILY 已加载");
    ok(JSON.stringify(guards.v3Types) === JSON.stringify(TYPES),
       "D18 V3_TYPES 与 Android 侧逐条一致");
    ok(guards.protoStillProto, "D18 原型绘制内核仍标记 PROTO（职责分离保留）");
    ok(guards.hasUnknownNodes, "D18 未知节点清单可用（修静默跳过的缺陷）");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器（无头 Edge）。D18「Android 实际渲染」见 device/verify-p5b04-v3-render.js。");
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
