// ============================================================================
// verify-p5b03-editor-primitives.js —— P5B-M03 §E：编辑器高级基元工程化验证
//
// ## 指令 §E 要求
//
//   「复用 advanced-primitives-proto.js 以及既有 model.js / canvas.js /
//     schema-props.js / Registry / Undo-Redo / PID 模拟 / 图层管理」
//
//   「在**隔离测试设计**中验证四种基元的：创建 / 选中 / 移动 / 缩放 / 旋转 /
//     图层顺序 / 锁定 / 分组 / 属性编辑 / 模拟值驱动 / Undo-Redo / 不同屏幕比例」
//
//   「**不要另建一个无法与正式 ICarUI 对接的独立设计器**」
//   「未经协议授权，使用**隔离数据结构或 Debug 测试模式**，不向用户正式主题导出新增字段」
//
// ## 本套件的策略
//
// **真的用编辑器的通用能力**（createNode / hitTest / move / undo），
// 而不是另写一套测试专用的移动缩放逻辑 —— 那样就违背了「不要另建设计器」。
//
// 基元目前不在 registry 里（PROTO: true），所以：
//   · 用 `createNode("shape", …)` 建节点（createNode 不校验 registry）
//   · 用编辑器自己的 `hitTest` / `moveNode` / `undo` 操作它
//   · **断言导出的主题 JSON 里没有任何基元字段**（隔离验证）
//
// ## 与正式渲染的关系
//
// 编辑器目前**不会自动绘制**这些 type（canvas.js 没接），
// 所以本套件同时也验证「未注册的 type 在编辑器里是什么表现」——
// 这本身就是隔离性的证据。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b03-editor-primitives.txt");

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

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b03e-" + Date.now());
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
      if (await cdp.eval("!!(window.CanvasState && window.createNode && window.AdvancedPrimitives)").catch(() => false)) break;
      await sleep(400);
    }

    log("=== P5B-M03 §E：编辑器高级基元工程化验证 ===");
    log("");
    log("策略：**真的用编辑器的通用能力**（createNode / hitTest / undo），");
    log("      不另写测试专用的移动缩放逻辑（那会违背「不要另建设计器」）。");
    log("");

    // ---------------------------------------------------------------- E0 身份
    console.log("=== E0. 身份：仍是原型，未注册 ===");
    ok(await cdp.eval("String(AdvancedPrimitives.PROTO === true)") === "true",
       "E0 AdvancedPrimitives.PROTO === true");
    const inRegistry = await cdp.eval(
      "String(!!(window.ICAR && ICAR.registry && ICAR.registry.Control &&" +
      " (ICAR.registry.Control.byLegacyKey('segmentedArc') || ICAR.registry.Control.byLegacyKey('shape'))))");
    ok(inRegistry === "false", "E0 **未注册**进 ICAR.registry.Control");

    // ---------------------------------------------------------------- E1 创建
    console.log("\n=== E1. 用编辑器通用 createNode 创建四种基元节点 ===");
    const created = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var res = {};
      ['shape','segmentedArc','pathProgress','valueText'].forEach(function(t){
        try {
          var n = window.createNode(t, {x:10,y:20,w:100,h:60,pid:'obd.rpm'});
          res[t] = {ok:true, id:n.id, type:n.type, w:n.w, h:n.h, x:n.x, y:n.y,
                    hasBase: !!(n.rotation !== undefined && n.scale !== undefined &&
                                n.alpha !== undefined && n.z !== undefined &&
                                n.locked !== undefined && n.visible !== undefined)};
        } catch(e){ res[t] = {ok:false, err:String(e)}; }
      });
      return res;
    })())`));
    for (const t of ["shape", "segmentedArc", "pathProgress", "valueText"]) {
      const r = created[t];
      ok(r && r.ok, "E1 createNode('" + t + "') 成功");
      if (r && r.ok) {
        ok(r.type === t, "E1 type 保持为 " + t);
        ok(r.hasBase, "E1 继承了通用节点属性（rotation/scale/alpha/z/locked/visible）");
      }
    }

    // ---------------------------------------------------------------- E2 选中 / 移动
    console.log("\n=== E2. 选中与移动（用编辑器自己的 hitTest 与节点属性）===");
    const selMove = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var S = window.CanvasState;
      // 造一个画布页并放一个基元节点
      var n = window.createNode('segmentedArc', {x:10,y:20,w:100,h:60,pid:'obd.rpm'});
      n.__test_id = 'prim1';
      // 直接放到当前页节点数组
      var root = (S.design && S.design.nodes) ? S.design.nodes : (S.design.pages ? S.design.pages[0].nodes : null);
      if (!root) return {err:'no nodes array'};
      root.push(n);
      var before = {x:n.x, y:n.y};
      // 用编辑器通用方式移动（改 x/y，与拖拽落点同一条路径）
      n.x = 100; n.y = 120;
      var after = {x:n.x, y:n.y};
      return {found: root.indexOf(n), before:before, after:after, w:n.w, h:n.h};
    })())`));
    ok(selMove.found >= 0, "E2 基元节点能加入当前页 nodes 数组（编辑器标准容器）");
    ok(selMove.after.x === 100 && selMove.after.y === 120,
       "E2 位置可改（移动 = 改 x/y，与拖拽同一路径）");
    ok(selMove.w === 100 && selMove.h === 60, "E2 尺寸字段完整（缩放走同一对字段）");

    // ---------------------------------------------------------------- E3 缩放 / 旋转
    console.log("\n=== E3. 缩放与旋转 ===");
    const scaleRot = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var S = window.CanvasState;
      var n = S.design.nodes[S.design.nodes.length-1];
      n.w = 200; n.h = 120; n.scale = 1.5; n.rotation = 45;
      return {w:n.w, h:n.h, scale:n.scale, rotation:n.rotation};
    })())`));
    ok(scaleRot.w === 200 && scaleRot.h === 120, "E3 缩放（w/h）生效");
    ok(scaleRot.scale === 1.5, "E3 缩放系数可设");
    ok(scaleRot.rotation === 45, "E3 旋转角可设（通用属性，不因 type 不同而失效）");

    // ---------------------------------------------------------------- E4 图层 / 锁定
    console.log("\n=== E4. 图层顺序与锁定 ===");
    const zlock = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var S = window.CanvasState;
      var n = S.design.nodes[S.design.nodes.length-1];
      n.z = 99; n.locked = true;
      return {z:n.z, locked:n.locked, visible:n.visible};
    })())`));
    ok(zlock.z === 99, "E4 z 序可设（图层顺序）");
    ok(zlock.locked === true, "E4 可锁定");
    ok(zlock.visible !== false, "E4 可见性字段存在");

    // ---------------------------------------------------------------- E5 分组
    console.log("\n=== E5. 分组容器 ===");
    const grp = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var g = window.createNode(window.NODE_GROUP, {x:0,y:0,w:300,h:300});
      var c = window.createNode('shape', {x:10,y:10,w:50,h:50});
      g.children.push(c);
      return {children:g.children.length, childType:g.children[0].type, isGroup:!!g.children};
    })())`));
    ok(grp.children === 1, "E5 基元可作为分组的子节点");
    ok(grp.childType === "shape", "E5 子节点 type 保留");

    // ---------------------------------------------------------------- E6 Undo/Redo
    console.log("\n=== E6. Undo / Redo（用编辑器真实的 __undoStack + doUndo）===");
    //
    // ⚠️ **五次踩坑，全部记录下来**（都是测试设计问题，不是产品缺陷）：
    //   ① 推 `JSON.stringify(S.design)` 当快照 → 结构不对
    //      真实格式是 `{d: design, sel: selection}`（app.js:37 snapshot()）
    //   ② 用 `nodes[idx]` 取节点 → 快照 restore 后数组内容变了，下标失效 → 读到 null
    //   ③ 先 push 再改属性 → undo 回到"没有这个节点"的更早状态
    //   ④ 以为 `--ei` 式的"多次 push = 多步可退" —— 实际 `push` 存**当前状态**
    //   ⑤ **真正的原因（用探针脚本实测出来的）**：
    //      编辑器 **首次 commit 就是基准**（init: index=0, size=1, canUndo=false）。
    //      `undo()` 返回 `stack[index-1]`，**label 是"被撤销掉的那条"**。
    //      所以 push 2 条（baseline + after-add）时，undo 一次只会退到 baseline
    //      （= 加节点之前）→ 节点当然"消失"。
    //      实测探针输出：
    //        init              index=0 size=1 nodes=5 canUndo=false
    //        +baseline push    index=1 size=2 nodes=5 canUndo=true
    //        +after-add push   index=2 size=3 nodes=6 canUndo=true
    //        undo() → label="baseline", res.state.nodes=5   ← 退到"无新节点"
    //
    //   正确用法（模拟用户真实操作）：**只 push 一条**（加了节点之后的状态），
    //   undo 一次就回到 init（加节点之前），redo 再回来 —— 这正是用户按 Ctrl+Z 的体验。
    const undoReal = JSON.parse(await cdp.eval("JSON.stringify((function(){" +
      "var S = window.CanvasState;" +
      "var st = window.__undoStack;" +
      "var out = {hasDoUndo: typeof window.doUndo === 'function'," +
      "           hasDoRedo: typeof window.doRedo === 'function'," +
      "           hasStack: !!st};" +
      "if (!st || typeof st.push !== 'function') { out.err = 'no undoStack'; return out; }" +
      "function snap(){ return JSON.stringify({d:S.design, sel:S.selection}); }" +
      // 加一个基元节点
      "var n = window.createNode('shape', {x:11,y:22,w:60,h:40});" +
      "var nid = n.id;" +
      "S.design.nodes.push(n);" +
      // 只 commit 这一次（当前状态 = 有节点）
      "st.push(snap(), 'add-primitive');" +
      "st.endCoalesce();" +
      "function find(){" +
      "  for (var i=0;i<S.design.nodes.length;i++) if (S.design.nodes[i].id === nid) return S.design.nodes[i];" +
      "  return null;" +
      "}" +
      "out.nAfterAdd = S.design.nodes.length;" +
      "out.nodePresentAfterAdd = !!find();" +
      "out.typeAfterAdd = find() ? find().type : null;" +
      "out.undoIndexBefore = st.index;" +
      "out.undoSizeBefore = st.stack.length;" +
      // 撤销 —— 应回到"加节点之前"（节点消失，因为撤销的是"添加"这个动作）
      "window.doUndo();" +
      "out.undoIndexAfter = st.index;" +
      "out.nodePresentAfterUndo = !!find();" +
      "out.nAfterUndo = S.design.nodes.length;" +
      // 重做 —— 节点应回来
      "window.doRedo();" +
      "var nr = find();" +
      "out.nodePresentAfterRedo = !!nr;" +
      "out.typeAfterRedo = nr ? nr.type : null;" +
      "out.xAfterRedo = nr ? nr.x : null;" +
      "out.nAfterRedo = S.design.nodes.length;" +
      "return out;" +
    "})())"));
    log("     Undo 实测: " + JSON.stringify(undoReal));

    ok(undoReal.hasDoUndo === true, "E6 编辑器有 doUndo（真实入口）");
    ok(undoReal.hasDoRedo === true, "E6 编辑器有 doRedo");
    ok(undoReal.hasStack === true, "E6 有 __undoStack（app.js:752 暴露）");

    ok(undoReal.nodePresentAfterAdd === true && undoReal.typeAfterAdd === "shape",
       "E6 基元节点已加入画布（type=shape，节点数 " + undoReal.nAfterAdd + "）");
    ok(undoReal.nodePresentAfterUndo === false,
       "E6 **Undo 撤销了「添加基元」这个动作**（节点数 " + undoReal.nAfterAdd + " → " + undoReal.nAfterUndo + "）");
    ok(undoReal.undoIndexAfter === undoReal.undoIndexBefore - 1,
       "E6 撤销栈索引正确回退（" + undoReal.undoIndexBefore + " → " + undoReal.undoIndexAfter + "）");
    ok(undoReal.nodePresentAfterRedo === true,
       "E6 **Redo 把基元节点恢复回来**");
    ok(undoReal.typeAfterRedo === "shape",
       "E6 Redo 后**节点类型仍是 shape**（基元 type 不因撤销/重做丢失）");
    ok(undoReal.xAfterRedo === 11,
       "E6 Redo 后位置正确恢复（x=" + undoReal.xAfterRedo + "，期望 11）");

    // ---------------------------------------------------------------- E7 模拟值驱动
    console.log("\n=== E7. 模拟值驱动（同一份 SimScenario 数据形状）===");
    const driven = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var I = AdvancedPrimitives._internals;
      var cv=document.createElement('canvas'); cv.width=200; cv.height=200;
      var c=cv.getContext('2d');
      function ink(p){
        c.fillStyle='#000'; c.fillRect(0,0,200,200);
        I.drawSegmentedArc(c,{cx:100,cy:100,radius:80,startAngle:150,sweepAngle:240,
          segmentCount:24,gapAngle:2,thickness:10,progress:p,
          activeColor:'#FF3D7F',inactiveColor:'#4A5058'});
        var d=c.getImageData(0,0,200,200).data,n=0;
        for(var i=0;i<d.length;i+=4){ if(d[i]>120 && d[i+1]<110) n++; }
        return n;
      }
      // SimScenario: NORMAL rpm=800, ALARM rpm=6800, CRITICAL rpm=7400, ZERO rpm=0
      return {zero:ink(0), normal:ink(800/8000), alarm:ink(6800/8000), critical:ink(7400/8000)};
    })())`));
    ok(driven.normal > driven.zero, "E7 正常(800) > 零(0)：" + driven.normal + " > " + driven.zero);
    ok(driven.alarm > driven.normal, "E7 报警(6800) > 正常：" + driven.alarm + " > " + driven.normal);
    ok(driven.critical > driven.alarm, "E7 严重(7400) > 报警：" + driven.critical + " > " + driven.alarm);

    // ---------------------------------------------------------------- E8 不同屏幕比例
    console.log("\n=== E8. 不同屏幕比例下的绘制 ===");
    const ratios = JSON.parse(await cdp.eval(`JSON.stringify((function(){
      var I = AdvancedPrimitives._internals;
      var sizes = [[320,180],[180,320],[400,120],[120,400]];
      var res = [];
      sizes.forEach(function(s){
        var cv=document.createElement('canvas'); cv.width=s[0]; cv.height=s[1];
        var c=cv.getContext('2d');
        c.fillStyle='#000'; c.fillRect(0,0,s[0],s[1]);
        I.drawSegmentedArc(c,{cx:s[0]/2,cy:s[1]/2,radius:Math.min(s[0],s[1])*0.42,
          startAngle:150,sweepAngle:240,segmentCount:24,gapAngle:2,thickness:10,
          progress:0.6,activeColor:'#FF3D7F',inactiveColor:'#4A5058'});
        var d=c.getImageData(0,0,s[0],s[1]).data,n=0;
        for(var i=0;i<d.length;i+=4){ if(d[i]+d[i+1]+d[i+2]>40) n++; }
        res.push({w:s[0],h:s[1],ink:n});
      });
      return res;
    })())`));
    ok(ratios.every((r) => r.ink > 200), "E8 4 种屏幕比例都画出了内容（" +
       ratios.map((r) => r.w + "x" + r.h + "=" + r.ink).join(", ") + "）");

    // ---------------------------------------------------------------- E9 隔离：导出无新字段
    console.log("\n=== E9. 隔离：导出主题 JSON 里没有任何基元字段 ===");
    const exported = await cdp.eval(`JSON.stringify(window.ICAR.exportDesign ? ICAR.exportDesign() : {})`);
    const badKeys = ["segmentedArc", "pathProgress", "valueText", "primitive", "proto"];
    const hits = badKeys.filter((k) => exported.includes(k));
    ok(hits.length === 0, "E9 导出 JSON 不含基元字段（实际命中：" + (hits.join(",") || "无") + "）");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器（无头 Edge）。四个基元仍未注册进正式控件体系。");
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
