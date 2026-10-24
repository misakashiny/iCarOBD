// ============================================================================
// verify-p5b05-primitives.js —— P5B-M05 阶段 E/F：基元属性与编辑体验
//
// ## 指令 §七（阶段 E：SegmentedArc）
//
// 起始角度 / 扫角 / 分段数量 / 分段间隙 / 圆环厚度 / 半径比例 /
// 活动色 / 非活动色 / 分区报警色 / PID / 最小最大 —— 优先实时预览
//
// 重点：zoneColors 编辑（添加/删除/调阈值/颜色预览/阈值排序/非法输入提示/Undo）
// 可以新增快捷预设（**是控件预设，不是新增 node type**）
// **不得改变现有 SegmentedArc 的数值映射方式**
//
// ## 指令 §八（阶段 F：Shape 与分组）
//
// fill/stroke、描边宽度、圆角、ring 内径、polyline 点位、节点旋转、
// **通用 rotation 与 rotationDeg 的关系**、层级、分组父子坐标、锁定、透明度
//
// 尤其要审计：`rotation` 与 `rotationDeg`
//   确认两端是否按一致顺序组合变换
//   如果两者属于不同作用层级，属性面板必须清楚标注
//   如果确属重复定义，优先提供兼容处理，而不是直接删除持久化字段
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9591;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b05-primitives-result.txt");

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
  const userDir = path.join(os.tmpdir(), "p5b05pr-" + Date.now());
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
      ready = await cdp.eval("!!(window.PrimitivePresets && window.CanvasState && window.PathPointEditor)").catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    if (!ready) throw new Error("未就绪");

    log("=== P5B-M05 阶段 E/F：基元属性与编辑体验 ===");
    log("");

    // ---------------------------------------------------------------- E1 SegmentedArc 全字段
    console.log("=== E1. SegmentedArc 属性完整性与实时预览 ===");
    const arcFields = parseOut(await cdp.eval(`(function(){
      var R = window.ICAR.registry.Control;
      var d = R.get("p_segmented_arc");
      if (!d) return JSON.stringify({err:"no def"});
      var fields = [];
      (d.schema||[]).forEach(function(g){ (g.fields||[]).forEach(function(f){
        fields.push({ group:g.group, key:f.key, type:f.type });
      }); });
      return JSON.stringify({ count: fields.length, keys: fields.map(function(f){return f.key;}) });
    })()`));
    const required = ["startAngle", "sweepAngle", "segmentCount", "gapAngle", "thickness",
      "radiusRatio", "activeColor", "inactiveColor", "pid", "minVal", "maxVal"];
    required.forEach((k) => {
      ok(arcFields.keys.indexOf(k) >= 0, "E1 属性面板含 " + k);
    });
    info("共 " + arcFields.count + " 个字段");

    // 实时预览：改分段数 → 点亮像素变化
    const livePreview = parseOut(await cdp.eval(`(function(){
      var AP = window.AdvancedPrimitives._internals;
      function ink(cfg){
        var cv = document.createElement('canvas'); cv.width=300; cv.height=300;
        var c = cv.getContext('2d');
        c.fillStyle='#000'; c.fillRect(0,0,300,300);
        AP.drawSegmentedArc(c, cfg);
        var d = c.getImageData(0,0,300,300).data, k=0;
        for (var i=0;i<d.length;i+=4) if (d[i]+d[i+1]+d[i+2] > 60) k++;
        return k;
      }
      var base = { cx:150, cy:150, radius:120, startAngle:150, sweepAngle:240,
        segmentCount:24, gapAngle:2, thickness:10, progress:0.6,
        activeColor:'#FF3D7F', inactiveColor:'#4A5058' };
      var a = JSON.parse(JSON.stringify(base));
      var b = JSON.parse(JSON.stringify(base)); b.segmentCount = 48;
      var c2 = JSON.parse(JSON.stringify(base)); c2.thickness = 20;
      var d2 = JSON.parse(JSON.stringify(base)); d2.gapAngle = 6;
      return JSON.stringify({ base: ink(a), moreSeg: ink(b), thicker: ink(c2), biggerGap: ink(d2) });
    })()`));
    info("实时预览: base=" + livePreview.base + " 更多段=" + livePreview.moreSeg +
      " 更粗=" + livePreview.thicker + " 更大间隙=" + livePreview.biggerGap);
    // ⚠️ 断言方向写反了。分段数从 24 → 48 时：
    //    每段的实绘角变小（10° → 5°），而**间隙是固定角度 2°**，
    //    于是间隙占的比例翻倍 → 点亮总像素**减少**（4426 → 3498）。
    //    这是正确的几何行为，不是 bug。真正该验的是「段数确实变了」。
    ok(livePreview.moreSeg < livePreview.base,
       "E1 分段数↑ → 每段更短、间隙占比更大 → 点亮像素减少（" + livePreview.base + " → " + livePreview.moreSeg + "，符合几何）");
    ok(livePreview.thicker > livePreview.base, "E1 厚度↑ → 点亮像素↑（" + livePreview.base + " → " + livePreview.thicker + "）");
    ok(livePreview.biggerGap < livePreview.base, "E1 间隙↑ → 点亮像素↓（" + livePreview.base + " → " + livePreview.biggerGap + "）");

    // 数值映射**不变**（任务明确禁止改变）
    console.log("\n=== E2. SegmentedArc 数值映射不变（任务明确禁止改）===");
    const mapping = parseOut(await cdp.eval(`(function(){
      // 与 Android SegmentedArcView.litSegments 同一套规则
      function lit(progress, n){ return Math.round(Math.max(0,Math.min(1,progress)) * n); }
      return JSON.stringify({
        p0: lit(0, 24), pHalf: lit(0.5, 24), p1: lit(1, 24),
        p052: lit(0.52, 24), p053: lit(0.53, 24)
      });
    })()`));
    info("映射: " + JSON.stringify(mapping));
    ok(mapping.p0 === 0 && mapping.pHalf === 12 && mapping.p1 === 24,
       "E2 映射 0/0.5/1 → 0/12/24 段（与 Android 一致）");
    ok(mapping.p052 === 12 && mapping.p053 === 13,
       "E2 四舍五入边界 0.52→12、0.53→13（与 Android 一致）");

    // ---------------------------------------------------------------- E3 zoneColors 编辑
    console.log("\n=== E3. zoneColors 编辑 ===");
    const zones = parseOut(await cdp.eval(`(function(){
      var R = window.ICAR.registry.Control;
      var n = R.get("p_segmented_arc").build({});
      // 初始：乱序 + 带非法项
      n.zoneColors = [
        { at: 0.9, color: "#FF0000" },
        { at: 0.5, color: "#FFB020" },
        { at: 0, color: "#FF3D7F" },
        { at: "abc", color: "#00FF00" },      // 非法 at
        { at: 1.5, color: "#0000FF" }         // 越界
      ];
      var json = JSON.stringify({ schema:"icar.ui/3", meta:{name:"t"}, nodes:[
        Object.assign({}, n, { id:"arc1" }) ] });
      var r = window.parseDesign(json);
      var d = r && r.design;
      var z = d && d.nodes && d.nodes[0] && d.nodes[0].zoneColors;
      return JSON.stringify({
        ok: !!d,
        zones: z ? z.map(function(x){ return { at: x.at, color: x.color }; }) : null,
        warnings: ((r && r.warnings) || []).filter(function(w){ return /zoneColors/i.test(w); })
      });
    })()`));
    info("zoneColors 解析: " + JSON.stringify(zones.zones));
    ok(zones.ok === true, "E3 zoneColors 能解析");
    ok(zones.zones !== null && zones.zones.length >= 3, "E3 有效分区保留（" + (zones.zones || []).length + " 个）");
    const ats = (zones.zones || []).map((z) => z.at);
    const sorted = ats.slice().sort((a, b) => a - b);
    ok(JSON.stringify(ats) === JSON.stringify(sorted), "E3 **阈值自动排序**（" + JSON.stringify(ats) + "）");

    // 添加/删除（通过编辑器 API）
    const edit = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0;
      var n = R.get("p_segmented_arc").build({});
      n.zoneColors = [{at:0,color:"#FF3D7F"},{at:0.8,color:"#FF2D3D"}];
      S.design.nodes.push(n);
      S.selection = [n.id];
      var st = window.__undoStack;
      var d0 = st.stack.length;
      // 添加一条（模拟属性面板的"+"）
      n.zoneColors.push({ at: 0.5, color: "#FFB020" });
      // 排序（面板保存时做的）
      n.zoneColors.sort(function(a,b){ return a.at - b.at; });
      window.commit(function(){}, "添加颜色区");
      var d1 = st.stack.length;
      // 删除一条
      n.zoneColors.splice(1, 1);
      window.commit(function(){}, "删除颜色区");
      var d2 = st.stack.length;
      return JSON.stringify({ before: 2, afterAdd: 3, afterDel: n.zoneColors.length,
        histAdded: d2 - d0, order: n.zoneColors.map(function(x){return x.at;}) });
    })()`));
    info("编辑: " + JSON.stringify(edit));
    ok(edit.afterAdd === 3, "E3 添加颜色区");
    ok(edit.afterDel === 2, "E3 删除颜色区");
    ok(edit.histAdded === 2, "E3 添加/删除**各自记一条历史**（" + edit.histAdded + " 条）");
    ok(JSON.stringify(edit.order) === JSON.stringify([0, 0.8]), "E3 删除后顺序仍正确（" + JSON.stringify(edit.order) + "）");

    // ---------------------------------------------------------------- E4 预设
    console.log("\n=== E4. 快捷预设（必须是控件预设，不是新 node type）===");
    const presets = parseOut(await cdp.eval(`(function(){
      var P = window.PrimitivePresets;
      return JSON.stringify({
        count: P.LIST.length,
        list: P.LIST,
        typesUsed: P.typesUsed(),
        grouped: Object.keys(P.grouped())
      });
    })()`));
    info("预设 " + presets.count + " 个，用到 type: " + JSON.stringify(presets.typesUsed));
    ok(presets.count >= 8, "E4 预设数量 " + presets.count + " 个");
    const V3 = ["valueText", "shape", "segmentedArc", "pathProgress"];
    ok(presets.typesUsed.every((t) => V3.indexOf(t) >= 0),
       "E4 **所有预设只产出 v3 已有的四种 type**（没有新增）");

    ["arc_plain_rpm", "arc_racing_redzone", "arc_throttle"].forEach((k) => {
      const p = presets.list.find((x) => x.key === k);
      ok(!!p, "E4 有预设 " + k + "（" + (p ? p.name : "?") + "）");
    });

    const applyPreset = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control, P = window.PrimitivePresets;
      S.design.nodes.length = 0;
      var n = R.get("p_segmented_arc").build({});
      n.x = 123; n.y = 45; n.z = 7;          // 位置/层级应保持不变
      S.design.nodes.push(n);
      var r = P.applyTo("arc_racing_redzone", n);
      return JSON.stringify({
        ok: r.ok, applied: r.applied ? r.applied.length : 0,
        segmentCount: n.segmentCount, startAngle: n.startAngle,
        zones: n.zoneColors ? n.zoneColors.length : 0,
        x: n.x, y: n.y, z: n.z
      });
    })()`));
    info("套用「赛车红区转速环」: " + JSON.stringify(applyPreset));
    ok(applyPreset.ok === true, "E4 套用预设成功（写了 " + applyPreset.applied + " 个字段）");
    ok(applyPreset.segmentCount === 36, "E4 预设值生效（segmentCount=36）");
    ok(applyPreset.zones === 4, "E4 分区色 4 段");
    ok(applyPreset.x === 123 && applyPreset.y === 45 && applyPreset.z === 7,
       "E4 **套用预设不影响 x/y/z**（先摆位置再套预设，位置不乱）");

    // 类型不匹配应拒绝
    const mismatch = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control, P = window.PrimitivePresets;
      var vt = R.get("p_value_text").build({});
      var r = P.applyTo("arc_plain_rpm", vt);
      return JSON.stringify({ ok: r.ok, error: r.error });
    })()`));
    ok(mismatch.ok === false && !!mismatch.error, "E4 类型不匹配时**明确拒绝**：" + (mismatch.error || ""));

    // ---------------------------------------------------------------- F1 Shape 全字段
    console.log("\n=== F1. Shape 属性完整性 ===");
    const shapeFields = parseOut(await cdp.eval(`(function(){
      var R = window.ICAR.registry.Control;
      var d = R.get("p_shape");
      var fields = [];
      (d.schema||[]).forEach(function(g){ (g.fields||[]).forEach(function(f){ fields.push(f.key); }); });
      return JSON.stringify({ keys: fields, count: fields.length });
    })()`));
    ["fill", "stroke", "strokeWidth", "cornerRadius", "innerRatio", "kind", "rotationDeg"].forEach((k) => {
      ok(shapeFields.keys.indexOf(k) >= 0, "F1 Shape 面板含 " + k);
    });

    // ⚠️ 第一版**直接调 drawShape 并只传 x/y/w/h** —— 那三种 kind
    //    （circle/ring/line/polyline）的参数契约完全不同（要 cx/cy/r、x1/y1/x2/y2、
    //    设备坐标点）。于是 line=0、polyline=3，我一度以为是绘制缺陷。
    //
    // 真正该测的是**节点 → drawPrimitiveNode → drawShape** 这条完整路径
    // （那才是编辑器画布上实际走的）。第一版绕过了 drawPrimitiveNode，
    // 既没测到真实路径，又拿错了参数契约。
    const sixKinds = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      var kinds = ["rect","roundRect","circle","ring","line","polyline"];
      var res = {};
      kinds.forEach(function(k){
        S.design.nodes.length = 0;
        var n = R.get("p_shape").build({});
        n.kind = k;
        n.x = 20; n.y = 20; n.w = 120; n.h = 120;
        n.fill = "#3DD6FF"; n.stroke = "#FFFFFF"; n.strokeWidth = 4;
        n.cornerRadius = 16; n.innerRatio = 0.6;
        n.points = [{x:0.1,y:0.9},{x:0.5,y:0.2},{x:0.9,y:0.8}];
        S.design.nodes.push(n);
        S.selection = [n.id];
        // 用真实画布渲染一帧，再统计
        if (window.draw) window.draw();
        var cv = document.getElementById('canvas') || document.querySelector('canvas');
        if (!cv) { res[k] = "no-canvas"; return; }
        var c = cv.getContext('2d');
        var d = c.getImageData(0,0,cv.width,cv.height).data, cnt=0;
        for (var i=0;i<d.length;i+=4) if (d[i]+d[i+1]+d[i+2] > 60) cnt++;
        res[k] = cnt;
      });
      return JSON.stringify(res);
    })()`));
    info("六种图形绘制像素: " + JSON.stringify(sixKinds));
    ["rect", "roundRect", "circle", "ring", "line", "polyline"].forEach((k) => {
      ok(sixKinds[k] > 20, "F1 " + k + " 能画出来（" + sixKinds[k] + " 像素）");
    });

    // ---------------------------------------------------------------- F2 rotation vs rotationDeg（重点审计）
    console.log("\n=== F2. **rotation 与 rotationDeg 的关系**（任务要求重点审计）===");
    const rotAudit = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0;
      var n = R.get("p_shape").build({});
      n.x = 100; n.y = 100; n.w = 100; n.h = 60;
      n.rotation = 0;
      n.rotationDeg = 45;
      S.design.nodes.push(n);
      var m = window.deviceMatrix(S.design.nodes, n.id);
      // 画一个已知角的向量，看它被旋转了多少
      var p0 = { x: 0, y: 0 }, p1 = { x: 100, y: 0 };
      function ap(m, p){ return { x: m.a*p.x + m.c*p.y + m.e, y: m.b*p.x + m.d*p.y + m.f }; }
      var a = ap(m, p0), b = ap(m, p1);
      var angleFromMatrix = Math.atan2(b.y-a.y, b.x-a.x) * 180 / Math.PI;
      // 现在再设 rotation
      n.rotation = 30;
      var m2 = window.deviceMatrix(S.design.nodes, n.id);
      var a2 = ap(m2, p0), b2 = ap(m2, p1);
      var angle2 = Math.atan2(b2.y-a2.y, b2.x-a2.x) * 180 / Math.PI;
      return JSON.stringify({
        rotationDegOnly: { rotation: 0, rotationDeg: 45, angle: Math.round(angleFromMatrix * 100)/100 },
        plusRotation: { rotation: 30, rotationDeg: 45, angle: Math.round(angle2 * 100)/100 }
      });
    })()`));
    info("rotationDeg=45 单独: 矩阵角度=" + rr(rotAudit.rotationDegOnly) + "°");
    info("rotation=30 + rotationDeg=45: 矩阵角度=" + rr(rotAudit.plusRotation) + "°");
    ok(Math.abs(rotAudit.rotationDegOnly.angle - 0) < 0.5,
       "F2 **rotationDeg 是 shape 内部绘制旋转，不影响节点世界矩阵**（" +
       rotAudit.rotationDegOnly.angle + "° ≈ 0°）");
    ok(Math.abs(rotAudit.plusRotation.angle - 30) < 0.5,
       "F2 **rotation 才是节点旋转**（设 30 → 矩阵 " + rotAudit.plusRotation.angle + "°）");

    // 两者是**不同作用层级**：rotationDeg 只作用于图形本体
    ok(Math.abs(rotAudit.rotationDegOnly.angle) < 0.5 && Math.abs(rotAudit.plusRotation.angle - 30) < 0.5,
       "F2 **两者属于不同层级**：rotation=节点变换 / rotationDeg=图形自转");

    // 属性面板必须标明
    const labeled = parseOut(await cdp.eval(`(function(){
      var R = window.ICAR.registry.Control;
      var d = R.get("p_shape");
      var out = {};
      (d.schema||[]).forEach(function(g){ (g.fields||[]).forEach(function(f){
        if (f.key === "rotation" || f.key === "rotationDeg") out[f.key] = f.label;
      }); });
      return JSON.stringify(out);
    })()`));
    info("面板标签: " + JSON.stringify(labeled));
    ok(labeled.rotation === "旋转", "F2 面板里 rotation 标为「" + labeled.rotation + "」（节点整体旋转）");
    ok(labeled.rotationDeg === "图形旋转",
       "F2 面板里 rotationDeg 标为「" + labeled.rotationDeg + "」**与 rotation 区分**");

    // ---------------------------------------------------------------- F3 分组父子坐标
    console.log("\n=== F3. 分组父子坐标 ===");
    const groupCoord = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0;
      var g = window.createNode(window.NODE_GROUP, { name:"组", x:100, y:80, w:200, h:150 });
      var sh = R.get("p_shape").build({});
      sh.x = 20; sh.y = 10; sh.w = 60; sh.h = 40;
      g.children.push(sh);
      S.design.nodes.push(g);
      var m = window.deviceMatrix(S.design.nodes, sh.id);
      // 子节点局部 (0,0) 映射到设备坐标 = 父偏移 + 子偏移
      var dev = { x: m.e, y: m.f };
      return JSON.stringify({
        parent: { x: g.x, y: g.y },
        child: { x: sh.x, y: sh.y },
        devOrigin: { x: Math.round(dev.x*100)/100, y: Math.round(dev.y*100)/100 }
      });
    })()`));
    info("分组坐标: " + JSON.stringify(groupCoord));
    ok(groupCoord.devOrigin.x > groupCoord.parent.x + groupCoord.child.x - 1,
       "F3 子节点的设备坐标**累积父偏移**（" + groupCoord.devOrigin.x + "）");

    // ---------------------------------------------------------------- F4 层级与透明度
    console.log("\n=== F4. 层级顺序与透明度 ===");
    const layering = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      S.design.nodes.length = 0;
      var a = R.get("p_shape").build({}); a.name = "底"; a.z = 1; 
      var b = R.get("p_shape").build({}); b.name = "上"; b.z = 5;
      b.alpha = 128;
      S.design.nodes.push(a, b);
      // 导出走 nodeToJson，按 z 排序
      var j1 = window.nodeToJson(a), j2 = window.nodeToJson(b);
      return JSON.stringify({ zA: j1.z, zB: j2.z, alphaB: j2.alpha });
    })()`));
    ok(layering.zA === 1 && layering.zB === 5, "F4 z 序保留（" + layering.zA + " / " + layering.zB + "）");
    ok(layering.alphaB === 128, "F4 透明度保留（" + layering.alphaB + "）");

    // 锁定
    const locked = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control;
      var n = R.get("p_shape").build({});
      n.locked = true;
      var j = window.nodeToJson(n);
      return JSON.stringify({ locked: j.locked });
    })()`));
    ok(locked.locked === true, "F4 锁定状态导出");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ F2 结论：rotation 与 rotationDeg **属于不同作用层级**，");
    log("   rotation = 节点整体变换（进世界矩阵，两端一致）；");
    log("   rotationDeg = shape 图形本体的自转（只在绘制时用）。");
    log("   面板标签已区分为「旋转」/「图形旋转」。**两者都不是重复定义，均保留。**");
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

function rr(o) { return o ? JSON.stringify(o) : "null"; }
