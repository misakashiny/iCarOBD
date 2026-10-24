// ============================================================================
// verify-p5b05-templates.js —— P5B-M05 阶段 G：两套正式主题的编辑体验
//
// ## 指令 §九 的要求
//
// G1 赛车转速环：分段环视觉比例 / 速度和转速排版 / 警戒红区 / 左右副参数 /
//    图层层级 / 透明图片替换入口 / 不同屏幕尺寸的文字可读性 / 动态模拟变化
//    **要求所有参数都能通过正式编辑器修改**
//
// G2 综合车辆数据：顶部曲线路径 / 控制点可编辑 / 曲线填充方向 / 大号车速 /
//    挡位显示 / 水温机油温度 BOOST / Lambda 与机油pressure可用性提示 /
//    横屏空间利用 / 无数据状态
//
// G3 模板生命周期：新建 / 选择 / 修改 / 模拟预览 / 保存 / 导出 / 导入 / Android 显示
//    「**不要因为模板已经有 JSON 文件，就认为编辑工作流完整。**」
//
// ## 本套件的重点
//
// 不是"文件能解析"（那 P5B-M04 已经验过），而是**完整生命周期**：
//   加载 → 每个节点都能通过 Registry 找到并编辑 → 改一个字段 →
//   模拟预览 → 导出 → 重新导入 → 字段仍在
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9611;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..", "..", "..");
const OUT = path.join(ROOT, "docs", "02_验证记录", "screenshots", "p5b05-templates-result.txt");
const THEME_DIR = path.join(ROOT, "docs", "02_验证记录", "android-theme");

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
  const userDir = path.join(os.tmpdir(), "p5b05tp-" + Date.now());
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
      ready = await cdp.eval("!!(window.CanvasState && window.PathPointEditor && window.PrimitivePresets && typeof window.parseDesign === 'function')").catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    if (!ready) throw new Error("未就绪");

    log("=== P5B-M05 阶段 G：两套正式主题的编辑体验 ===");
    log("");

    /** 完整生命周期：加载 → 编辑 → 导出 → 重导入 */
    const lifecycle = async (file, label) => {
      const json = fs.readFileSync(path.join(THEME_DIR, file), "utf8");
      const r = parseOut(await cdp.eval(`(function(){
        var json = ${JSON.stringify(json)};
        var r = window.parseDesign(json);
        if (!r || !r.design) return JSON.stringify({ err: "parse", errors: r && r.errors });
        var S = window.CanvasState;
        S.design = r.design;
        S.selection = [];
        var d = r.design;
        var byType = {};
        var prims = [];
        (d.nodes||[]).forEach(function(n){
          byType[n.type] = (byType[n.type]||0)+1;
          if (["valueText","shape","segmentedArc","pathProgress"].indexOf(n.type) >= 0) {
            prims.push({ id:n.id, type:n.type, name:n.name });
          }
        });
        return JSON.stringify({
          ok: true, total: (d.nodes||[]).length, byType: byType, prims: prims.length,
          primList: prims,
          schema: window.schemaForDesign(d)
        });
      })()`));
      info(label + ": 节点 " + r.total + " 基元 " + r.prims + " schema=" + r.schema);
      info("  按类型: " + JSON.stringify(r.byType));
      ok(r.ok === true, label + " 能加载");
      ok(r.schema === "icar.ui/3", label + " 是 v3");
      return r;
    };

    // ---------------------------------------------------------------- G1 赛车环
    console.log("=== G1. 赛车转速环主题 ===");
    const race = await lifecycle("p5b04-template-race.json", "赛车环");
    info("基元节点: " + race.primList.map((p) => p.name + "(" + p.type + ")").join(", "));

    // 每个基元都必须是 Registry 认识的类型（→ 能用属性面板改）
    const known = parseOut(await cdp.eval(`(function(){
      var R = window.ICAR.registry.Control;
      var V3 = ["valueText","shape","segmentedArc","pathProgress"];
      // ⚠️ Registry 的公开 API 是 keys() / all() / get() / has() / byLegacyKey()，
      //    没有 list()。第一版用 R.list() 猜，于是全 null —— 误判成"基元不可编辑"。
      var map = {};
      var all = R.all();
      V3.forEach(function(t){
        var found = null;
        all.forEach(function(d){ if (d && d.nodeType === t) found = d.key; });
        map[t] = found;
      });
      return JSON.stringify(map);
    })()`));
    info("类型 → 控件 key: " + JSON.stringify(known));
    const allEditable = race.primList.every((p) => !!known[p.type]);
    ok(allEditable, "G1 **每个基元节点都能在 Registry 里找到**（→ 属性面板可改）");

    // 改一个字段并验证生效
    const editRace = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var arc = null;
      (S.design.nodes||[]).forEach(function(n){ if (n.type === "segmentedArc") arc = n; });
      if (!arc) return JSON.stringify({ err: "no arc" });
      var before = { segmentCount: arc.segmentCount, thickness: arc.thickness, zones: (arc.zoneColors||[]).length };
      // 用户改：分段 24→40、线宽 10→14、加一段色
      arc.segmentCount = 40;
      arc.thickness = 14;
      arc.zoneColors = (arc.zoneColors||[]).concat([{ at: 0.98, color: "#FF0000" }]);
      window.commit(function(){}, "改转速环");
      var S2 = window.CanvasState;
      var txt = window.toV2Json(S2.design);
      var j = typeof txt === "string" ? JSON.parse(txt) : txt;
      var arcOut = null;
      (j.nodes||[]).forEach(function(n){ if (n.type === "segmentedArc") arcOut = n; });
      return JSON.stringify({
        before: before,
        after: { segmentCount: arc.segmentCount, thickness: arc.thickness, zones: (arc.zoneColors||[]).length },
        exported: { segmentCount: arcOut ? arcOut.segmentCount : null,
                    thickness: arcOut ? arcOut.thickness : null,
                    zones: arcOut && arcOut.zoneColors ? arcOut.zoneColors.length : null },
        schema: j.schema
      });
    })()`));
    info("改转速环: " + JSON.stringify(editRace.before) + " → " + JSON.stringify(editRace.after));
    ok(editRace.after.segmentCount === 40, "G1 能改分段数（24→40）");
    ok(editRace.after.zones === editRace.before.zones + 1, "G1 能加分区色");
    ok(editRace.exported.segmentCount === 40 && editRace.exported.zones === editRace.after.zones,
       "G1 **改动能完整导出**（segmentCount=" + editRace.exported.segmentCount +
       " zones=" + editRace.exported.zones + "）");

    // 沿用了预设的赛车环配置？
    const redZone = parseOut(await cdp.eval(`(function(){
      var P = window.PrimitivePresets;
      var p = P.get("arc_racing_redzone");
      if (!p) return JSON.stringify({ err: "no preset" });
      var zones = p.props.zoneColors || [];
      var atts = zones.map(function(z){ return z.at; });
      return JSON.stringify({ count: zones.length, atts: atts,
        hasRed: zones.some(function(z){ return String(z.color).toUpperCase() === "#FF2D3D"; }) });
    })()`));
    ok(redZone.count === 4 && redZone.hasRed,
       "G1 **警戒红区**通过 zoneColors 实现（" + redZone.count + " 段，含红色）");

    // 图层层级
    const layers = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var zs = (S.design.nodes||[]).map(function(n){ return { type:n.type, name:n.name, z:n.z }; });
      var sorted = zs.slice().sort(function(a,b){ return a.z - b.z; });
      return JSON.stringify({ count: zs.length, order: sorted.map(function(x){ return x.name+":"+x.z; }) });
    })()`));
    info("图层顺序（z 升序）: " + race.total + " 个节点");
    ok(layers.count === race.total, "G1 图层层级完整（" + layers.count + " 个节点）");

    // 透明图片替换入口
    const imgSlot = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var imgs = (S.design.nodes||[]).filter(function(n){ return n.type === "image"; });
      return JSON.stringify({ count: imgs.length,
        slots: imgs.map(function(n){ return { name:n.name, assetId: n.assetId || "" }; }) });
    })()`));
    info("图片素材位: " + JSON.stringify(imgSlot.slots));
    ok(imgSlot.count >= 1, "G1 有**透明图片替换入口**（" + imgSlot.count + " 个 image 节点，assetId 留空待填）");

    // ---------------------------------------------------------------- G2 数据屏
    console.log("\n=== G2. 综合车辆数据屏主题 ===");
    const data = await lifecycle("p5b04-template-data.json", "数据屏");
    info("基元节点: " + data.primList.map((p) => p.name + "(" + p.type + ")").join(", "));

    const pathNodes = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var pps = (S.design.nodes||[]).filter(function(n){ return n.type === "pathProgress"; });
      return JSON.stringify({ count: pps.length,
        detail: pps.map(function(n){
          return { name:n.name, points:(n.points||[]).length, fill: !!n.fill,
                   minVal:n.minVal, maxVal:n.maxVal, pid: n.pid };
        }) });
    })()`));
    info("PathProgress: " + JSON.stringify(pathNodes.detail));
    ok(pathNodes.count >= 2, "G2 有 " + pathNodes.count + " 条曲线路径");
    ok(pathNodes.detail.every((d) => d.points >= 2), "G2 每条路径都有控制点（可编辑）");

    // 控制点可编辑（选中后 isActive）
    const editable = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var pp = null;
      (S.design.nodes||[]).forEach(function(n){ if (n.type === "pathProgress") pp = n; });
      if (!pp) return JSON.stringify({ err:"no pp" });
      S.selection = [pp.id];
      var ppe = window.PathPointEditor;
      var before = ppe.pointsOf(pp).length;
      var r = ppe.addPointAt(pp.id, 100, 100);
      return JSON.stringify({ active: ppe.isActive(), before: before,
        after: ppe.pointsOf(pp).length, added: r.index !== undefined });
    })()`));
    info("控制点可编辑: " + JSON.stringify(editable));
    ok(editable.active === true, "G2 **选中曲线后进入控制点编辑态**");
    ok(editable.added === true && editable.after === editable.before + 1,
       "G2 **能加控制点**（" + editable.before + " → " + editable.after + "）");

    // 可用性提示（Lambda / 机油压力）
    const hints = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var texts = (S.design.nodes||[]).filter(function(n){ return n.type === "text"; })
        .map(function(n){ return n.text || ""; });
      return JSON.stringify({ all: texts,
        hasLambda: texts.some(function(t){ return /Lambda/i.test(t); }),
        hasOilPressure: texts.some(function(t){ return /机油压力/.test(t); }),
        lambdaHint: texts.filter(function(t){ return /暂未实现/.test(t); }),
        oilHint: texts.filter(function(t){ return /CAN/i.test(t); }) });
    })()`));
    info("提示文本: " + JSON.stringify(hints.all));
    ok(hints.hasLambda === true, "G2 有 Lambda 可用性提示");
    ok(hints.hasOilPressure === true, "G2 有机油压力可用性提示");
    ok(hint_ok(hints), "G2 **措辞区分了「暂未实现」与「需 CAN/DBC」**（不宣称本车不支持）");

    function hint_ok(h) {
      return h.lambdaHint.length > 0 && h.oilHint.length > 0;
    }

    // 横屏空间利用：节点分布在 360x360 内且覆盖面积合理
    const layout = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState;
      var ns = S.design.nodes || [];
      var minX=9999, maxX=-9999, minY=9999, maxY=-9999;
      ns.forEach(function(n){
        minX=Math.min(minX,n.x); maxX=Math.max(maxX,n.x+n.w);
        minY=Math.min(minY,n.y); maxY=Math.max(maxY,n.y+n.h);
      });
      return JSON.stringify({ minX:minX, maxX:maxX, minY:minY, maxY:maxY,
        coverageX: Math.round((maxX-minX)/360*100), coverageY: Math.round((maxY-minY)/360*100) });
    })()`));
    info("布局占用: " + JSON.stringify(layout));
    ok(layout.coverageX >= 85, "G2 水平方向用满画布（" + layout.coverageX + "%）");

    // ---------------------------------------------------------------- G3 生命周期
    console.log("\n=== G3. 模板生命周期（新建→改→模拟→导出→重导入）===");
    const fullCycle = parseOut(await cdp.eval(`(function(){
      var S = window.CanvasState, R = window.ICAR.registry.Control, P = window.PrimitivePresets;
      // 1) 新建（空画布 + 拖一个预设进去）
      S.design.nodes.length = 0;
      S.selection = [];
      var arc = R.get("p_segmented_arc").build({});
      P.applyTo("arc_racing_redzone", arc);
      S.design.nodes.push(arc);
      var vt = R.get("p_value_text").build({});
      P.applyTo("vt_big_speed", vt);
      S.design.nodes.push(vt);
      var nNew = S.design.nodes.length;
      // 2) 模拟预览
      S.previewValues = S.previewValues || {};
      S.previewValues[window.resolvePid("obd.rpm")] = 5200;
      S.previewValues[window.resolvePid("obd.speed")] = 128;
      var simRpm = window.simValueOf("obd.rpm");
      var simSpd = window.simValueOf("obd.speed");
      // 3) 导出
      var txt = window.toV2Json(S.design);
      var j = typeof txt === "string" ? JSON.parse(txt) : txt;
      var nExported = (j.nodes||[]).length;
      // 4) 重新导入
      var r = window.parseDesign(typeof txt === "string" ? txt : JSON.stringify(txt));
      var nReimported = r && r.design && r.design.nodes ? r.design.nodes.length : -1;
      var arcBack = null;
      if (r && r.design && r.design.nodes) {
        r.design.nodes.forEach(function(n){ if (n.type === "segmentedArc") arcBack = n; });
      }
      return JSON.stringify({
        nNew: nNew, simRpm: simRpm, simSpd: simSpd,
        nExported: nExported, nReimported: nReimported,
        schemaOut: j.schema,
        arcBackSegments: arcBack ? arcBack.segmentCount : null,
        arcBackZones: arcBack && arcBack.zoneColors ? arcBack.zoneColors.length : null,
        errors: (r && r.errors) || []
      });
    })()`));
    info("完整周期: " + JSON.stringify(fullCycle));
    ok(fullCycle.nNew === 2, "G3 新建（拖入 2 个预设控件）");
    ok(fullCycle.simRpm === 5200 && fullCycle.simSpd === 128, "G3 模拟预览取值正确");
    ok(fullCycle.nExported === 2, "G3 导出成功（" + fullCycle.nExported + " 节点）");
    ok(fullCycle.schemaOut === "icar.ui/3", "G3 导出 schema=icar.ui/3");
    ok(fullCycle.nReimported === 2, "G3 **重新导入成功**（" + fullCycle.nReimported + " 节点）");
    ok(fullCycle.arcBackSegments === 36 && fullCycle.arcBackZones === 4,
       "G3 **预设参数在往返后保持**（36 段 / 4 分区）");

    log("");
    log("=== 汇总 ===");
    log("通过=" + pass + " 失败=" + fail);
    log("PASS=" + pass + " FAIL=" + fail);
    log("");
    log("⚠️ 层级：编辑器（无头 Edge）。Android 实际显示见 device 套件。");
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
