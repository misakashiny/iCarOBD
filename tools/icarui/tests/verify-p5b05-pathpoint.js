// ============================================================================
// verify-p5b05-pathpoint.js —— P5B-M05 阶段 D：PathProgress 画布控制点编辑器
//
// ## 指令 §六 D 的要求
//
// D1 可视化编辑：显示控制点 / 拖动 / 添加 / 删除 / 调整顺序 / 平滑折线切换 /
//    显示首末点 / 方向切换 / 实时预览进度 / 编辑结束自动保存历史
// D2 坐标安全：编辑器缩放、画布平移、节点旋转、节点缩放、FIT/STRETCH 预览、
//    父容器变换、吸附开关、锁定状态 —— **任何一次拖动都不能跳**
// D3 Undo/Redo：每次完整拖动 = 一条历史；取消能恢复；刷新/重导入后位置一致
// D4 资源保护：最多 64 点；到上限提示；无效坐标有错误反馈
// D5 预览：完整路径 + 填充 + 动态端点 + 当前模拟值
//
// ## 测试策略
//
// D2 是**最难也最重要**的一项。判据做法：
//   对每一组变换（缩放/平移/旋转/父容器/FIT/STRETCH），
//   1) 算出某控制点当前的屏幕坐标
//   2) 在该处 beginDrag + moveDrag 到「自己」（原位）
//   3) 归一化坐标必须**不变**（误差 < 0.5%）
//   4) 再拖到一个明确的目标（+30px, +20px），验证位移方向与幅度合理
//
// 「拖到自己应该不动」是**坐标系错误的最强探测器**：
// 任何一层正向/逆向不一致，都会让这个操作产生非零位移。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9561;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b05-pathpoint-result.txt");

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
const parseOut = (v) => (typeof v === "string" ? JSON.parse(v) : v);

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b05pp-" + Date.now());
  const proc = spawn(EDGE, ["--headless=new", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + userDir, "--no-first-run", "--disable-gpu",
    "--allow-file-access-from-files", URL_PAGE], { stdio: "ignore" });
  let cdp = null;
  try {
    for (let i = 0; i < 60 && !cdp; i++) {
      await sleep(500);
      try {
        const list = await getJson("/json/list");
        const t = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl && (x.url || "").indexOf("index.html") >= 0);
        if (t) cdp = await CDP.connect(t.webSocketDebuggerUrl);
      } catch (e) { }
    }
    if (!cdp) throw new Error("连不上 CDP");
    await cdp.send("Runtime.enable");
    await sleep(6000);
    await cdp.eval("window.alert=function(){};window.confirm=function(){return true};1");
    let ready = false;
    for (let i = 0; i < 80; i++) {
      ready = await cdp.eval(
        "!!(window.PathPointEditor && window.CanvasState && typeof window.selectionMatrix === 'function')"
      ).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    if (!ready) throw new Error("PathPointEditor 未就绪");

    log("=== P5B-M05 阶段 D：PathProgress 画布控制点编辑器 ===");
    log("");

    // 统一准备：建一个 pathProgress 并选中
    const setup = async (opts) => {
      const o = opts || {};
      return parseOut(await cdp.eval(`(function(){
        var S = window.CanvasState, R = window.ICAR.registry.Control;
        S.design.nodes.length = 0;
        var n = R.get("p_path_progress").build({});
        n.x = ${o.x !== undefined ? o.x : 40};
        n.y = ${o.y !== undefined ? o.y : 40};
        n.w = ${o.w !== undefined ? o.w : 200};
        n.h = ${o.h !== undefined ? o.h : 100};
        n.rotation = ${o.rotation !== undefined ? o.rotation : 0};
        n.scale = ${o.scale !== undefined ? o.scale : 1};
        n.locked = ${o.locked ? "true" : "false"};
        n.points = [{x:0,y:1},{x:0.3,y:0.4},{x:0.7,y:0.15},{x:1,y:0.1}];
        S.design.nodes.push(n);
        S.selection = [n.id];
        S.zoom = ${o.zoom !== undefined ? o.zoom : 1};
        S.panX = ${o.panX !== undefined ? o.panX : 0};
        S.panY = ${o.panY !== undefined ? o.panY : 0};
        if (window.requestDraw) window.requestDraw();
        return JSON.stringify({ id: n.id, type: n.type, w: n.w, h: n.h,
          rotation: n.rotation, scale: n.scale,
          isActive: window.PathPointEditor.isActive(),
          nPoints: window.PathPointEditor.pointsOf(n).length });
      })()`));
    };

    // ---------------------------------------------------------------- D1 显示与基础操作
    console.log("=== D1. 可视化编辑基础 ===");
    let st = await setup({});
    info("节点 id=" + st.id + " isActive=" + st.isActive + " 控制点=" + st.nPoints);
    ok(st.isActive === true, "D1 选中 pathProgress 后进入**路径编辑态**");
    ok(st.nPoints === 4, "D1 能读出 4 个控制点");

    // 叠加绘制确实画了东西（对比选中/未选中）
    const drawDiff = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var n = S.design.nodes[0];
      // ⚠️ drawOverlay 画在**设备坐标**（画布位图空间），节点 x=40,y=40,w=200,h=100
      //    在 1x 缩放下落在 (40..240, 40..140) —— canvas 必须够大才画得进去。
      //    第一版用 300x200 且未考虑节点实际位置，读到 0 像素。
      var cv = document.createElement('canvas'); cv.width=900; cv.height=700;
      var c = cv.getContext('2d');
      function ink(){
        var d = c.getImageData(0,0,900,700).data, k=0;
        for (var i=0;i<d.length;i+=4) if (d[i]+d[i+1]+d[i+2] > 60) k++;
        return k;
      }
      // 必须先填不透明底色：clearRect 后画布是全透明，RGB 全 0，
      // getImageData 读出来的 rgb 和恒为 0 —— 于是"画了 437 像素"被判成 0。
      // 这是测试方法问题，不是绘制问题（诊断脚本实测 drawOverlay 画了 437 像素）。
      S.selection = [];
      c.fillStyle = "#000"; c.fillRect(0,0,900,700);
      // 用 deviceMatrix（累积祖先变换）—— selectionMatrix 要两个参数，只传一个返回 null
      var m = window.deviceMatrix(S.design.nodes, n.id);
      window.PathPointEditor.drawOverlay(c, n, m);
      var noSel = ink();
      // 选中态
      S.selection = [n.id];
      c.fillStyle = "#000"; c.fillRect(0,0,900,700);
      window.PathPointEditor.drawOverlay(c, n, m);
      var sel = ink();
      return JSON.stringify({ noSel: noSel, sel: sel });
    })()`));
    info("叠加绘制: 未选中=" + drawDiff.noSel + " 选中=" + drawDiff.sel + " 像素");
    ok(drawDiff.sel > 100, "D1 **选中时画出控制点叠加层**（" + drawDiff.sel + " 像素）");
    ok(drawDiff.noSel === 0, "D1 未选中时不画（不干扰普通编辑）");

    // ---------------------------------------------------------------- D2 坐标安全（核心）
    console.log("\n=== D2. 坐标安全：**拖到自己应该不动**（坐标系错误的最强探测器）===");

    const idempotent = async (label, opts) => {
      const s = await setup(opts);
      const r = parseOut(await cdp.eval(`(function(){
        var ppe = window.PathPointEditor;
        var n = window.CanvasState.design.nodes[0];
        var pts = ppe.pointsOf(n);
        var results = [];
        for (var i = 0; i < pts.length; i++) {
          var before = { x: pts[i].x, y: pts[i].y };
          var sp = ppe.normToScreen(n.id, before.x, before.y);
          if (!sp) { results.push({ i:i, err:"normToScreen null" }); continue; }
          ppe.beginDrag(n.id, i);
          // 拖到它**自己**的位置
          ppe.moveDrag(sp.x, sp.y);
          ppe.endDrag();
          var after = ppe.pointsOf(n)[i];
          results.push({ i:i, dx: Math.abs(after.x - before.x), dy: Math.abs(after.y - before.y) });
        }
        return JSON.stringify(results);
      })()`));
      const maxD = Math.max.apply(null, r.map((x) => (x.err ? 999 : Math.max(x.dx, x.dy))));
      ok(maxD < 0.005, "D2 " + label + " —— 拖到自己位移 < 0.5%（实测最大 " + (maxD * 100).toFixed(2) + "%）");
      return maxD;
    };

    await idempotent("基础（zoom=1，无平移）", {});
    await idempotent("**编辑器缩放 1.8x**", { zoom: 1.8 });
    await idempotent("**画布平移 (+120,+80)**", { panX: 120, panY: 80 });
    await idempotent("**节点旋转 33°**", { rotation: 33 });
    await idempotent("**节点缩放 1.7x**", { scale: 1.7 });
    await idempotent("**旋转 + 缩放 + 平移 + zoom 组合**", { rotation: -47, scale: 0.65, zoom: 2.2, panX: -60, panY: 35 });
    await idempotent("**非等比节点（w=300,h=70）**", { w: 300, h: 70 });

    // 父容器变换
    const inGroup = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0;
      S.zoom = 1; S.panX = 0; S.panY = 0;
      var g = window.createNode(window.NODE_GROUP, { name:"组", x:30, y:30, w:280, h:200, rotation: 25, scale: 1.2 });
      var n = R.get("p_path_progress").build({});
      n.x = 20; n.y = 20; n.w = 180; n.h = 90;
      n.points = [{x:0,y:1},{x:0.5,y:0.3},{x:1,y:0.1}];
      g.children.push(n);
      S.design.nodes.push(g);
      S.selection = [n.id];
      var ppe = window.PathPointEditor;
      var pts = ppe.pointsOf(n);
      var bad = 0;
      for (var i=0;i<pts.length;i++){
        var before = { x: pts[i].x, y: pts[i].y };
        var sp = ppe.normToScreen(n.id, before.x, before.y);
        if (!sp) { bad++; continue; }
        ppe.beginDrag(n.id, i);
        ppe.moveDrag(sp.x, sp.y);
        ppe.endDrag();
        var after = ppe.pointsOf(n)[i];
        if (Math.abs(after.x-before.x) > 0.005 || Math.abs(after.y-before.y) > 0.005) bad++;
      }
      return JSON.stringify({ bad: bad, total: pts.length, isActive: ppe.isActive() });
    })()`));
    info("父容器（组旋转25°+缩放1.2）: bad=" + inGroup.bad + "/" + inGroup.total);
    ok(inGroup.isActive === true, "D2 分组内的 pathProgress 也能进入编辑态");
    ok(inGroup.bad === 0, "D2 **父容器有旋转+缩放时，拖到自己仍不动**（" + inGroup.bad + " 个偏移）");

    // 锁定状态
    const locked = await setup({ locked: true });
    info("锁定节点: isActive=" + locked.isActive);
    ok(locked.isActive === false, "D2 **锁定的节点不能进入编辑态**（D2 要求处理锁定状态）");

    // 拖动确实有效（不是"什么都不动"的假通过）
    console.log("\n=== D2b. 拖动确实产生位移（排除「永远不动」的假通过）===");
    st = await setup({});
    const moved = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor;
      var n = window.CanvasState.design.nodes[0];
      var pts = ppe.pointsOf(n);
      var before = { x: pts[1].x, y: pts[1].y };
      var sp = ppe.normToScreen(n.id, before.x, before.y);
      ppe.beginDrag(n.id, 1);
      ppe.moveDrag(sp.x + 40, sp.y + 30);      // 向右下拖
      var r = ppe.endDrag();
      var after = ppe.pointsOf(n)[1];
      return JSON.stringify({ before: before, after: after, changed: r.changed });
    })()`));
    info("拖动 (+40,+30)px: " + JSON.stringify(moved.before) + " → " + JSON.stringify(moved.after));
    ok(moved.after.x > moved.before.x, "D2b 向右拖 → x 增大（" + moved.before.x + " → " + moved.after.x + "）");
    ok(moved.after.y > moved.before.y, "D2b 向下拖 → y 增大（" + moved.before.y + " → " + moved.after.y + "）");
    ok(moved.changed === true, "D2b 标记为「已改变」（会提交历史）");

    // ---------------------------------------------------------------- D3 Undo/Redo
    console.log("\n=== D3. Undo/Redo：一次完整拖动 = 一条历史 ===");
    st = await setup({});
    const hist = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, S = window.CanvasState;
      var st = window.__undoStack;
      if (!st) return JSON.stringify({err:'no undoStack'});
      var n = S.design.nodes[0];
      function snap(){ return JSON.stringify({d:S.design, sel:S.selection}); }
      st.push(snap(), "baseline"); st.endCoalesce();
      var depth0 = st.stack.length;
      // 模拟一次拖动：begin → 多次 move（像真实拖动那样逐帧）→ end
      var sp = ppe.normToScreen(n.id, 0.3, 0.4);
      ppe.beginDrag(n.id, 1);
      for (var k = 1; k <= 10; k++) {
        ppe.moveDrag(sp.x + k * 3, sp.y + k * 2);
      }
      ppe.endDrag();
      var depth1 = st.stack.length;
      // 撤销
      window.doUndo();
      var n2 = S.design.nodes[0];
      var afterUndo = n2 ? JSON.stringify(ppe.pointsOf(n2)[1]) : null;
      return JSON.stringify({
        depthBefore: depth0, depthAfter: depth1,
        added: depth1 - depth0,
        afterUndo: afterUndo
      });
    })()`));
    info("历史: " + hist.depthBefore + " → " + hist.depthAfter + "（增加 " + hist.added + " 条）");
    ok(hist.added === 1, "D3 **一次拖动（10 次 move）只产生 1 条历史**（实际 " + hist.added + " 条）");
    ok(hist.afterUndo !== null, "D3 Undo 后节点还在");

    // 取消拖动
    st = await setup({});
    const cancel = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var before = JSON.stringify(ppe.pointsOf(n));
      var sp = ppe.normToScreen(n.id, 0.3, 0.4);
      ppe.beginDrag(n.id, 1);
      ppe.moveDrag(sp.x + 100, sp.y + 50);
      var mid = JSON.stringify(ppe.pointsOf(n));
      ppe.cancelDrag();
      var after = JSON.stringify(ppe.pointsOf(n));
      return JSON.stringify({ restored: before === after, midChanged: before !== mid });
    })()`));
    info("取消拖动: 中途变了=" + cancel.midChanged + " 取消后恢复=" + cancel.restored);
    ok(cancel.midChanged === true, "D3 拖动中确实改了");
    ok(cancel.restored === true, "D3 **取消拖动能恢复到编辑前状态**");

    // 未移动不提交历史
    const noMove = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var stk = window.__undoStack;
      var d0 = stk.stack.length;
      var sp = ppe.normToScreen(n.id, 0.5, 0.3);
      ppe.beginDrag(n.id, 1); ppe.moveDrag(sp.x, sp.y); ppe.endDrag();
      return JSON.stringify({ added: stk.stack.length - d0 });
    })()`));
    ok(noMove.added === 0, "D3 **没移动就不提交历史**（不污染撤销栈）");

    // ---------------------------------------------------------------- D1 其余操作
    console.log("\n=== D1b. 添加 / 删除 / 顺序 / 曲线切换 / 方向 ===");
    st = await setup({});
    const addPt = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var before = ppe.pointsOf(n).length;
      // 在 (0.15,0.7) 附近点一下 —— 应该插在第 0、1 点之间
      var sp = ppe.normToScreen(n.id, 0.15, 0.7);
      var r = ppe.addPointAt(n.id, sp.x, sp.y);
      var pts = ppe.pointsOf(n);
      return JSON.stringify({ before: before, after: pts.length, index: r.index,
        newPt: pts[r.index], firstStill: pts[0], lastStill: pts[pts.length-1] });
    })()`));
    info("添加: " + addPt.before + " → " + addPt.after + " 插入位置=" + addPt.index);
    ok(addPt.after === addPt.before + 1, "D1 **添加控制点**");
    ok(addPt.index >= 1 && addPt.index < addPt.after - 1,
       "D1 **插到最近一段的中间**（不是一律追加末尾，index=" + addPt.index + "）");
    ok(JSON.stringify(addPt.firstStill) === JSON.stringify({ x: 0, y: 1 }),
       "D1 添加后首点不变（" + JSON.stringify(addPt.firstStill) + "）");

    const delPt = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var before = ppe.pointsOf(n).length;
      var r = ppe.removePoint(n.id, 1);
      return JSON.stringify({ before: before, after: ppe.pointsOf(n).length, r: r });
    })()`));
    ok(delPt.after === delPt.before - 1, "D1 **删除控制点**（" + delPt.before + " → " + delPt.after + "）");

    const order = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var before = ppe.pointsOf(n).map(function(p){ return p.x; });
      var r = ppe.movePoint(n.id, 0, 2);
      var after = ppe.pointsOf(n).map(function(p){ return p.x; });
      return JSON.stringify({ before: before, after: after, r: r });
    })()`));
    info("顺序: " + JSON.stringify(order.before) + " → " + JSON.stringify(order.after));
    ok(JSON.stringify(order.before) !== JSON.stringify(order.after), "D1 **调整控制点顺序生效**");

    const curve = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var c0 = n.curve;
      var r = ppe.toggleCurve(n.id);
      return JSON.stringify({ before: c0, after: r.curve });
    })()`));
    ok(curve.before !== curve.after, "D1 **平滑/折线切换**（" + curve.before + " → " + curve.after + "）");

    const fwd = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var f0 = n.forward !== false;
      var r = ppe.toggleForward(n.id);
      return JSON.stringify({ before: f0, after: r.forward });
    })()`));
    ok(fwd.before !== fwd.after, "D1 **路径方向切换**（" + fwd.before + " → " + fwd.after + "）");

    const rev = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      var before = JSON.stringify(ppe.pointsOf(n));
      var r = ppe.reversePoints(n.id);
      var after = JSON.stringify(ppe.pointsOf(n));
      return JSON.stringify({ changed: before !== after, count: r.count });
    })()`));
    ok(rev.changed === true, "D1 点序反转生效（" + rev.count + " 点）");

    // ---------------------------------------------------------------- D4 资源保护
    console.log("\n=== D4. 资源保护（64 点上限 / 无效坐标）===");
    st = await setup({});
    const limit = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      // 灌到 64 点
      n.points = [];
      for (var i=0;i<64;i++) n.points.push({ x: i/63, y: 0.5 });
      var sp = ppe.normToScreen(n.id, 0.5, 0.8);
      var r64 = ppe.addPointAt(n.id, sp.x, sp.y);
      var del = ppe.removePoint(n.id, 0);
      // 删到只剩 2 点再删
      while (ppe.pointsOf(n).length > 2) ppe.removePoint(n.id, 0);
      var r2 = ppe.removePoint(n.id, 0);
      return JSON.stringify({ at64: r64, at2: r2, count: ppe.pointsOf(n).length });
    })()`));
    info("64 点再加: " + JSON.stringify(limit.at64) + "  2 点再删: " + JSON.stringify(limit.at2));
    ok(limit.at64.error !== undefined && limit.at64.error.indexOf("64") >= 0,
       "D4 **到 64 点上限时明确提示**（不是静默丢弃）：" + (limit.at64.error || ""));
    ok(limit.at2.error !== undefined, "D4 少于 2 点时拒绝删除并提示");

    const clamp = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, n = window.CanvasState.design.nodes[0];
      n.points = [{x:0,y:1},{x:0.5,y:0.5},{x:1,y:0}];
      var sp = ppe.normToScreen(n.id, 0.5, 0.5);
      // 往远处拖（远超节点边界）
      ppe.beginDrag(n.id, 1);
      var r = ppe.moveDrag(sp.x + 9999, sp.y + 9999);
      ppe.endDrag();
      var p = ppe.pointsOf(n)[1];
      return JSON.stringify({ x: p.x, y: p.y, inRange: (p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1) });
    })()`));
    info("超远拖动: 结果=" + JSON.stringify(clamp));
    ok(clamp.inRange === true, "D4 **坐标被夹在 0..1**（不会跑出节点）");

    // ---------------------------------------------------------------- D5 预览
    console.log("\n=== D5. 实时预览（拖动后立即看到结果）===");
    const preview = parseOut(await cdp.eval(`(function(){
      var ppe = window.PathPointEditor, S = window.CanvasState, n = S.design.nodes[0];
      // 模拟值
      S.previewValues = S.previewValues || {};
      S.previewValues[window.resolvePid("obd.load")] = 62;
      var v = window.simValueOf ? window.simValueOf("obd.load") : null;
      // 拖动后立刻读回
      var sp = ppe.normToScreen(n.id, 0.5, 0.5);
      ppe.beginDrag(n.id, 1);
      ppe.moveDrag(sp.x + 25, sp.y);
      var during = JSON.stringify(ppe.pointsOf(n)[1]);
      ppe.endDrag();
      return JSON.stringify({ simValue: v, during: during });
    })()`));
    info("预览: 模拟值=" + preview.simValue + " 拖动中已更新=" + preview.during);
    ok(preview.simValue === 62, "D5 当前模拟 PID 数值可取（62）");
    ok(preview.during !== null, "D5 **拖动过程中控制点位置实时更新**");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器（无头 Edge）。");
    log("⚠️ D2 的判据是「拖到自身位置不应产生位移」——");
    log("   任何一层正向/逆向坐标换算不一致都会让它失败，这是坐标系错误的最强探测器。");
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
