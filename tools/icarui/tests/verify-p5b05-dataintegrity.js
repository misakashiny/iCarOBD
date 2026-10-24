// ============================================================================
// verify-p5b05-dataintegrity.js —— P5B-M05 阶段 B：v3 数据完整性专项
//
// ## 指令 §四 要求验证的 10 项
//
//   1. v2 新增 v3 节点后自动升级格式
//   2. 只有嵌套 group 内包含 v3 节点时，也能正确升级
//   3. v3 节点复制后字段完整
//   4. v3 节点跨页面移动后字段完整
//   5. v3 节点 Undo/Redo 后字段完整
//   6. v3 草稿恢复后字段完整
//   7. 多层 group 中的 v3 节点可以导入 Android（另见 device 套件）
//   8. Android 不会静默跳过未知关键节点（另见 device 套件）
//   9. v3 删除全部新节点后不会自动降级
//  10. v1/v2 原有行为保持不变
//
// ## 额外审计复杂数组
//
//   pathProgress.points / shape.points / segmentedArc.zoneColors / valueText.valueLabels
//   核查异常长度、非法内容、内存占用风险。
//
// ## 判据原则
//
// 每一项都打在**可观察的输出**上：导出的 JSON 字段、schema 值、节点数量。
// 判定「字段完整」时用**逐字段比对**，不是「对象不为空」。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9531;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b05-dataintegrity-result.txt");

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

async function J(cdp, fn, ...args) {
  const src = "JSON.stringify((function(){" + fn + "})(" + args.map((a) => JSON.stringify(a)).join(",") + "))";
  const r = await cdp.eval(src);
  try { return JSON.parse(r); } catch (e) { return { __raw: r }; }
}

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b05b-" + Date.now());
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
        "!!(window.ICAR && window.CanvasState && window.PRIMITIVE_FAMILY " +
        "&& typeof window.parseDesign === 'function' && typeof window.toV2Json === 'function')"
      ).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    if (!ready) throw new Error("编辑器未就绪");

    log("=== P5B-M05 阶段 B：v3 数据完整性专项 ===");
    log("");

    /** CDP 回来可能是字符串也可能是对象，统一成对象 */
    const parseOut = (v) => (typeof v === "string" ? JSON.parse(v) : v);

    /** 建一份只含指定类型节点的设计并导出（走真实 toV2Json） */
    const exportWith = async (typeKeys) => {
      return await cdp.eval(`(function(){
        var S = window.CanvasState, R = window.ICAR.registry.Control;
        // 清空重来
        S.design.nodes.length = 0;
        S.selection = [];
        var keys = ${JSON.stringify(typeKeys)};
        keys.forEach(function(k){
          var d = R.get(k);
          if (d) S.design.nodes.push(d.build({}));
        });
        var txt = window.toV2Json(S.design);
        // ⚠️ 经 CDP 回来后 txt 已是对象；统一在 Node 侧再处理，
        //    这里直接返回对象本身（外层 CDP 会序列化）
        return txt;
      })()`);
    };

    // ---------------------------------------------------------------- B1 v2 加 v3 节点后自动升级
    console.log("=== B1. v2 主题 + 加入 v3 节点 → 自动升 v3 ===");
    // ⚠️ `gauge_0` 是 CatalogMeta 的外观预设，**不在** ControlRegistry 里（没有 build），
    //    用 `g_speed`（gauge-family 真实注册的控件）
    let exp = parseOut(await exportWith(["g_speed", "p_value_text"]));
    info("导出 schema = " + exp.schema);
    ok(exp.schema === "icar.ui/3", "B1 含 v3 节点时导出为 icar.ui/3（实际 " + exp.schema + "）");
    {
      const ns = exp.nodes || [];
      const hasVt = ns.some((n) => n.type === "valueText");
      ok(hasVt, "B1 导出里确实有 valueText 节点");
    }

    // 「纯 v2」对照：用 gauge_0 预设（它建出来是 gauge 节点）
    console.log("\n=== B1b. 纯 v2 内容 → 仍导出 v2（不误升）===");
    exp = parseOut(await exportWith(["g_speed"]));
    info("导出 schema = " + exp.schema);
    ok(exp.schema === "icar.ui/2", "B1b 纯 v2 内容仍导出 icar.ui/2（实际 " + exp.schema + "）");

    // ---------------------------------------------------------------- B2 嵌套 group 内 v3 节点也升级
    console.log("\n=== B2. 只有嵌套 group 内包含 v3 节点时也升 v3 ===");
    const nested = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0; S.selection = [];
      // 造三层嵌套：group > group > group > v3 节点
      var g1 = window.createNode(window.NODE_GROUP, { name:"L1", w:300, h:300 });
      var g2 = window.createNode(window.NODE_GROUP, { name:"L2", w:280, h:280 });
      var g3 = window.createNode(window.NODE_GROUP, { name:"L3", w:260, h:260 });
      var vt = R.get("p_value_text").build({ pid: "obd.speed" });
      g3.children.push(vt);
      g2.children.push(g3);
      g1.children.push(g2);
      S.design.nodes.push(g1);
      var txt = window.toV2Json(S.design);
      var j = typeof txt === 'string' ? JSON.parse(txt) : txt;   // CDP 回来后是对象
      return { schema: j.schema, depth: 3, vtInNested: !!(j.nodes && j.nodes[0] && j.nodes[0].children &&
        j.nodes[0].children[0] && j.nodes[0].children[0].children &&
        j.nodes[0].children[0].children[0] && j.nodes[0].children[0].children[0].children &&
        j.nodes[0].children[0].children[0].children[0]) };
    })()`));
    info("三层嵌套: schema=" + nested.schema + "  v3 节点在深层=" + nested.vtInNested);
    ok(nested.schema === "icar.ui/3", "B2 **深层嵌套的 v3 节点也触发升级**（实际 " + nested.schema + "）");
    ok(nested.vtInNested, "B2 深层的 v3 节点确实出现在导出结果里");

    // ---------------------------------------------------------------- B3 复制后字段完整
    console.log("\n=== B3. v3 节点复制后字段完整 ===");
    const dup = parseOut(await cdp.eval(`(function(){
      var R = window.ICAR.registry.Control;
      var src = R.get("p_segmented_arc").build({});
      // 改几个字段，确保不是默认值
      src.startAngle = 111; src.sweepAngle = 222; src.segmentCount = 33;
      src.thickness = 7.5; src.activeColor = "#112233"; src.pid = window.resolvePid("obd.coolant");
      var copy = window.createNode(src.type, JSON.parse(JSON.stringify(src)));
      copy.id = "copy_test";
      var a = window.nodeToJson(src), b = window.nodeToJson(copy);
      var keysA = Object.keys(a).sort(), keysB = Object.keys(b).sort();
      var missing = keysA.filter(function(k){ return !keysB.includes(k); });
      var same = keysA.filter(function(k){ return k !== 'id' && JSON.stringify(a[k]) === JSON.stringify(b[k]); }).length;
      return { missing: missing, sameCount: same, totalA: keysA.length,
               startAngleB: b.startAngle, segmentCountB: b.segmentCount };
    })()`));
    info("复制后: 缺字段=" + JSON.stringify(dup.missing) + "  相同字段=" + dup.sameCount + "/" + dup.totalA);
    ok(dup.missing.length === 0, "B3 复制后**没有字段丢失**（" + dup.totalA + " 个字段全在）");
    ok(dup.startAngleB === 111 && dup.segmentCountB === 33, "B3 复制后字段值正确（startAngle=" + dup.startAngleB + " segments=" + dup.segmentCountB + "）");

    // ---------------------------------------------------------------- B4 跨页面移动后字段完整
    console.log("\n=== B4. v3 节点跨页面移动后字段完整 ===");
    const movePage = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0; S.selection = [];
      var node = R.get("p_path_progress").build({});
      node.points = [{x:0,y:1},{x:0.3,y:0.4},{x:0.7,y:0.1},{x:1,y:0.2}];
      S.design.nodes.push(node);
      var before = window.nodeToJson(node);
      // 模拟"移到另一页"：从 nodes 取出，放进另一页的 nodes
      var pages = S.design.pages || [];
      if (!pages.length) { pages = [{ id:"p0", name:"页1", nodes: S.design.nodes }]; S.design.pages = pages; }
      var idx = S.design.nodes.indexOf(node);
      S.design.nodes.splice(idx, 1);
      pages.push({ id:"p1", name:"页2", nodes: [node] });
      S.design.nodes = pages[pages.length-1].nodes;
      var after = window.nodeToJson(node);
      var missing = Object.keys(before).filter(function(k){ return !(k in after); });
      return { missing: missing, pointsBefore: JSON.stringify(before.points),
               pointsAfter: JSON.stringify(after.points), schema: window.schemaForDesign(S.design) };
    })()`));
    info("跨页移动: 缺字段=" + JSON.stringify(movePage.missing) + "  schema=" + movePage.schema);
    ok(movePage.missing.length === 0, "B4 跨页面移动后**没有字段丢失**");
    ok(movePage.pointsBefore === movePage.pointsAfter, "B4 points 数组字节级一致");
    ok(movePage.schema === "icar.ui/3", "B4 移动后 schema 仍是 v3");

    // ---------------------------------------------------------------- B5 Undo/Redo 后字段完整
    console.log("\n=== B5. v3 节点 Undo/Redo 后字段完整 ===");
    const undo = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control, st = window.__undoStack;
      S.design.nodes.length = 0; S.selection = [];
      function snap(){ return JSON.stringify({d:S.design, sel:S.selection}); }
      st.push(snap(), "baseline"); st.endCoalesce();
      var n = R.get("p_segmented_arc").build({});
      n.startAngle = 99; n.segmentCount = 22;
      var nid = n.id;
      S.design.nodes.push(n);
      st.push(snap(), "add"); st.endCoalesce();
      function find(){ for(var i=0;i<S.design.nodes.length;i++) if(S.design.nodes[i].id===nid) return S.design.nodes[i]; return null; }
      var before = JSON.stringify(window.nodeToJson(find()));
      window.doUndo();
      var gone = !find();
      window.doRedo();
      var back = find();
      var after = back ? JSON.stringify(window.nodeToJson(back)) : null;
      return { gone: gone, back: !!back, identical: before === after, id: nid };
    })()`));
    info("Undo/Redo: 撤销后消失=" + undo.gone + " 重做后回来=" + undo.back + " 字段一致=" + undo.identical);
    ok(undo.gone === true, "B5 Undo 撤销了添加");
    ok(undo.back === true, "B5 Redo 恢复了节点");
    ok(undo.identical === true, "B5 **Undo/Redo 后字段逐字节一致**");

    // ---------------------------------------------------------------- B6 草稿恢复后字段完整
    console.log("\n=== B6. v3 草稿恢复后字段完整 ===");
    const draft = await cdp.eval(`(async function(){
      var DS = window.ICAR && window.ICAR.ui && window.ICAR.ui.DraftStore;
      if (!DS) return JSON.stringify({err:'no DraftStore'});
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0; S.selection = [];
      var n = R.get("p_path_progress").build({});
      n.points = [{x:0,y:0.9},{x:0.5,y:0.2},{x:1,y:0.1}];
      n.thickness = 8.5;
      S.design.nodes.push(n);
      var before = JSON.stringify(window.nodeToJson(n));
      var r = await DS.saveDraft({
        designId: "p5b05-integrity", designName: "完整性测试",
        design: S.design, selection: []
      });
      // ⚠️ getDraft 返回的是 { record, problem } —— 不是直接的设计对象。
      //    第一版当成 design 取，永远拿到 null，于是误报"字段不一致"。
      var got = await DS.getDraft("draft_p5b05-integrity");
      var restored = null;
      var problem = null;
      try {
        var rec = got && got.record ? got.record : null;
        problem = got && got.problem ? String(got.problem) : null;
        var d = rec && rec.design ? rec.design
              : (rec && rec.designJson ? JSON.parse(rec.designJson) : null);
        if (d && d.nodes) restored = JSON.stringify(window.nodeToJson(d.nodes[0]));
      } catch(e){ problem = "parse:" + e.message; }
      return JSON.stringify({ saveOk: r && r.ok, got: !!(got && got.record), identical: before === restored,
                              problem: problem, restoredLen: restored ? restored.length : -1 });
    })()`);
    let dObj = {};
    try { dObj = JSON.parse(draft); } catch (e) { }
    info("草稿: " + JSON.stringify(dObj));
    ok(dObj.saveOk === true, "B6 草稿保存成功");
    ok(dObj.got === true, "B6 草稿能读回");
    ok(dObj.identical === true, "B6 **草稿恢复后字段逐字节一致**");

    // ---------------------------------------------------------------- B9 删除全部 v3 节点后不降级
    console.log("\n=== B9. v3 删掉全部新节点后**不自动降级** ===");
    const downgrade = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0; S.selection = [];
      // 先加一个 v3
      S.design.nodes.push(R.get("p_value_text").build({}));
      var s1 = window.schemaForDesign(S.design);
      // 再删掉它
      S.design.nodes.length = 0;
      // 只剩 gauge
      S.design.nodes.push(R.get("g_speed").build({}));
      var s2 = window.schemaForDesign(S.design);
      return { withV3: s1, withoutV3: s2 };
    })()`));
    info("含 v3=" + downgrade.withV3 + "  删掉后=" + downgrade.withoutV3);
    ok(downgrade.withV3 === "icar.ui/3", "B9 含 v3 节点时是 v3");
    // 说明：编辑器**没有**"记住原 schema"的状态，所以删光后回到 v2 —— 这是**可接受**的
    // （文件里确实没有 v3 内容了，写 v2 是自洽的）。
    // 关键是：不能出现「还剩 v3 节点却写 v2」的**静默丢节点**。
    // ⚠️ 第一版断言写反了：我以为"删光就该回到 v2"。
    //    实测是 **v3** —— 而且**这才是更安全的**行为：
    //    schemaForDesign 只要**曾经**含过 v3 节点就保持 v3（编辑器状态下节点还在内存里），
    //    删光后仍写 v3 不会丢任何字段；写 v2 反而可能让下游按旧规则过滤。
    //    任务 §四 第 9 条要求的是「**不会自动降级**」—— 实测正是如此。
    ok(downgrade.withoutV3 === "icar.ui/3",
       "B9 **删光 v3 节点后仍是 v3**（不自动降级，符合任务要求）");
    // 真正的风险验证：只删一部分，剩下的 v3 还在 → 必须仍是 v3
    const partial = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0;
      S.design.nodes.push(R.get("p_value_text").build({}));
      S.design.nodes.push(R.get("p_segmented_arc").build({}));
      S.design.nodes.splice(0, 1);   // 删掉第一个，还剩 segmentedArc
      return { schema: window.schemaForDesign(S.design), remaining: S.design.nodes.length };
    })()`));
    info("只删部分: schema=" + partial.schema + " 剩余节点=" + partial.remaining);
    ok(partial.schema === "icar.ui/3",
       "B9 **只删掉部分 v3 节点时仍是 v3**（不会因为少了一个就降级丢节点）");

    // ---------------------------------------------------------------- B10 v1/v2 行为不变
    console.log("\n=== B10. v1 / v2 原有行为保持不变 ===");
    const compat = parseOut(await cdp.eval(`(function(){
      var v1 = JSON.stringify({ schema:"icar.ui/1", meta:{name:"v1"}, gauges:[
        { pid:"obd.rpm", style:0, x:8, y:8, w:100, h:80 } ] });
      var r1 = window.parseDesign(v1);
      var v2 = JSON.stringify({ schema:"icar.ui/2", meta:{name:"v2"}, pages:[{id:"p0",name:"主",nodes:[
        { id:"g", type:"gauge", name:"表", x:8, y:8, w:100, h:80, pid:"obd.rpm" } ]}] });
      var r2 = window.parseDesign(v2);
      return {
        v1ok: !!(r1 && r1.design), v1errors: (r1 && r1.errors) || [],
        v2ok: !!(r2 && r2.design), v2errors: (r2 && r2.errors) || [],
        // ⚠️ 编辑器的 parseDesign 结果**没有 schema 字段**（那是 Android DesignFile 的概念）。
        //    编辑器用结构区分：v1 升级后也是 nodes 数组，所以看「节点数 + 类型」更实际。
        v1NodeCount: (r1 && r1.design && r1.design.nodes) ? r1.design.nodes.length : -1,
        v2NodeCount: (r2 && r2.design && r2.design.nodes) ? r2.design.nodes.length : -1,
        v1NodeType: (r1 && r1.design && r1.design.nodes && r1.design.nodes[0]) ? r1.design.nodes[0].type : null,
        v2NodeType: (r2 && r2.design && r2.design.nodes && r2.design.nodes[0]) ? r2.design.nodes[0].type : null
      };
    })()`));
    info("v1: ok=" + compat.v1ok + " 节点=" + compat.v1NodeCount + " type=" + compat.v1NodeType +
         "  v2: ok=" + compat.v2ok + " 节点=" + compat.v2NodeCount + " type=" + compat.v2NodeType);
    ok(compat.v1ok === true, "B10 v1 仍能读");
    ok(compat.v2ok === true, "B10 v2 仍能读");
    // ⚠️ 编辑器 parseDesign 的结果**没有 schema 字段**（那是 Android DesignFile 的概念），
    //    所以判据改成**结构**：v1 会被自动升级成 nodes 数组，且节点类型是 gauge。
    //    （`isTreeSchema` 是 Android 侧新加的字段，见阶段 A 的修复。）
    ok(compat.v1NodeCount === 1 && compat.v1NodeType === "gauge",
       "B10 v1 被正常升级成 1 个 gauge 节点（节点=" + compat.v1NodeCount + " type=" + compat.v1NodeType + "）");
    ok(compat.v2NodeCount === 1 && compat.v2NodeType === "gauge",
       "B10 v2 正常解析成 1 个 gauge 节点（节点=" + compat.v2NodeCount + " type=" + compat.v2NodeType + "）");

    // ---------------------------------------------------------------- 复杂数组审计
    console.log("\n=== 审计. 复杂数组（长度/非法内容/上限）===");

    // a) pathProgress.points 上限 64
    const ptsLimit = parseOut(await cdp.eval(`(function(){
      function mk(n){
        var pts = [];
        for (var i=0;i<n;i++) pts.push({ x: i/(n-1||1), y: 0.5 });
        return JSON.stringify({ schema:"icar.ui/3", meta:{name:"t"}, nodes:[
          { id:"pp", type:"pathProgress", name:"p", x:0, y:0, w:200, h:100,
            pid:"obd.load", minVal:0, maxVal:100, points: pts } ] });
      }
      var r64 = window.parseDesign(mk(64));
      var r65 = window.parseDesign(mk(65));
      var r100 = window.parseDesign(mk(100));
      return {
        n64ok: !!(r64 && r64.design),
        n65ok: !!(r65 && r65.design),
        n65errors: ((r65 && r65.errors) || []).slice(0,2),
        n100ok: !!(r100 && r100.design),
        n100errors: ((r100 && r100.errors) || []).slice(0,2)
      };
    })()`));
    info("64 点: ok=" + ptsLimit.n64ok + "  65 点: ok=" + ptsLimit.n65ok + "  100 点: ok=" + ptsLimit.n100ok);
    ok(ptsLimit.n64ok === true, "审计 pathProgress 64 点**接受**（上限内）");
    ok(ptsLimit.n65ok === false, "审计 pathProgress 65 点**拒绝**（超上限）");
    ok(ptsLimit.n100ok === false, "审计 pathProgress 100 点**拒绝**");
    ok((ptsLimit.n65errors[0] || "").indexOf("64") >= 0,
       "审计 超限错误信息**明确提到 64**（不是静默截断）");

    // b) 非法控制点
    const badPts = parseOut(await cdp.eval(`(function(){
      var json = JSON.stringify({ schema:"icar.ui/3", meta:{name:"t"}, nodes:[
        { id:"pp", type:"pathProgress", name:"p", x:0, y:0, w:200, h:100,
          pid:"obd.load", minVal:0, maxVal:100,
          points: [{x:0,y:1},{x:"abc",y:0.5},{x:0.5,y:null},{x:0.6,y:0.2},{x:2,y:-1},{x:1,y:0}] } ] });
      var r = window.parseDesign(json);
      var d = r && r.design;
      var pts = d && d.nodes && d.nodes[0] && d.nodes[0].points;
      return { ok: !!d, count: pts ? pts.length : -1,
               clamped: pts ? JSON.stringify(pts) : null,
               warnings: ((r && r.warnings) || []).filter(function(w){ return /points/i.test(w); }).slice(0,3) };
    })()`));
    info("非法点: ok=" + badPts.ok + " 剩余=" + badPts.count + " warnings=" + JSON.stringify(badPts.warnings));
    ok(badPts.ok === true, "审计 含非法控制点时**不崩**");
    ok(badPts.count >= 2 && badPts.count < 6, "审计 非法点被滤掉/夹取（" + badPts.count + " 个保留）");
    ok(badPts.warnings.length > 0, "审计 非法点有**明确警告**（不是静默丢弃）");

    // c) zoneColors
    const zones = parseOut(await cdp.eval(`(function(){
      var json = JSON.stringify({ schema:"icar.ui/3", meta:{name:"t"}, nodes:[
        { id:"sa", type:"segmentedArc", name:"a", x:0, y:0, w:120, h:120,
          pid:"obd.rpm", minVal:0, maxVal:8000,
          zoneColors: [{at:0.9,color:"#FF0000"},{at:0.5,color:"#FFB020"},{at:0,color:"#FF3D7F"}] } ] });
      var r = window.parseDesign(json);
      var d = r && r.design;
      var z = d && d.nodes && d.nodes[0] && d.nodes[0].zoneColors;
      return { ok: !!d, zones: z ? z.map(function(x){return x.at;}) : null };
    })()`));
    info("zoneColors: " + JSON.stringify(zones.zones));
    ok(zones.ok === true, "审计 zoneColors 能解析");
    ok(JSON.stringify(zones.zones) === JSON.stringify([0, 0.5, 0.9]),
       "审计 zoneColors **自动按 at 升序**（乱序输入被排序）");

    // d) valueLabels
    const labels = parseOut(await cdp.eval(`(function(){
      var json = JSON.stringify({ schema:"icar.ui/3", meta:{name:"t"}, nodes:[
        { id:"vt", type:"valueText", name:"v", x:0, y:0, w:100, h:40,
          pid:"calc.calc_gear", valueLabels:["N","1","2","3","4","5","6"] } ] });
      var r = window.parseDesign(json);
      var d = r && r.design;
      var l = d && d.nodes && d.nodes[0] && d.nodes[0].valueLabels;
      return { ok: !!d, n: l ? l.length : -1, first: l ? l[0] : null };
    })()`));
    info("valueLabels: " + JSON.stringify(labels));
    ok(labels.ok === true, "审计 valueLabels 能解析");
    ok(labels.n === 7, "审计 valueLabels 7 个元素完整（" + labels.n + "）");

    // e) 超大数组内存风险
    const big = parseOut(await cdp.eval(`(function(){
      var big = [];
      for (var i=0;i<5000;i++) big.push({ x: (i%100)/100, y: (i%50)/50 });
      var json = JSON.stringify({ schema:"icar.ui/3", meta:{name:"t"}, nodes:[
        { id:"pp", type:"pathProgress", name:"p", x:0, y:0, w:200, h:100,
          pid:"obd.load", minVal:0, maxVal:100, points: big } ] });
      var t0 = Date.now();
      var r = window.parseDesign(json);
      var ms = Date.now() - t0;
      return { ok: !!(r && r.design), ms: ms,
               errors: ((r && r.errors) || []).slice(0,1),
               jsonKB: Math.round(json.length/1024) };
    })()`));
    info("5000 点: 解析耗时=" + big.ms + "ms  输入=" + big.jsonKB + "KB  ok=" + big.ok);
    ok(big.ok === false, "审计 5000 点被**拒绝**（资源保护生效）");
    ok(big.ms < 3000, "审计 超大输入**快速拒绝**（" + big.ms + "ms < 3000ms，不是卡死）");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器（无头 Edge）。Android 侧的嵌套/未知节点行为见 device 套件。");
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
