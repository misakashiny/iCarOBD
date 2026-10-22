// ============================================================================
// verify-p5a03-scale.js —— P5A-M03 阶段 C：FIT/STRETCH 选择、导出与比例预览
//
// ## 背景（阶段 A 实证）
//
// `canvas.scaleMode` **本来就已经是完整支持的字段**（UI 下拉 3 档 + 读写 + 导出 + 画布变换）。
// P5A-M02 报告里"导出未暴露 scaleMode"那句是**错的** —— 本轮更正并在本套件里钉住。
//
// 本轮真正补的是：
//   ① 把后果**算出来**（形变系数 / 留白 / 裁切），与 Android `computeViewport()` 同口径
//   ② 三种屏幕比例预览按钮，**只改 designW/H，不动节点**
//   ③ 保住既有契约：默认仍是 STRETCH；切换模式不改节点数据；保存/草稿/导出一致
//
// 对照真值：P5A-M02 在模拟器上实测的形变系数（手机 0.475、平板 1.690、车载 2.254），
// 本套件要求前端公式算出的值与之吻合（±3%），否则说明两端口径分叉了。
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9351;
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
  const userDir = path.join(os.tmpdir(), "p5a03-scale-" + Date.now());
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
      if (await cdp.eval("!!(window.CanvasState && window.scaleModeStats && window.SCREEN_PRESETS)").catch(() => false)) break;
      await sleep(400);
    }

    console.log("=== C1. 默认仍是 STRETCH（不得擅自改默认）===");
    const c1 = await cdp.eval(`(function(){
      const d = window.CanvasState.design;
      return { mode: d.canvas.scaleMode, stretch: window.SCALE_STRETCH };
    })()`);
    ok(c1.mode === c1.stretch, "C1 新建设计 scaleMode=" + c1.mode + "（STRETCH=" + c1.stretch + "）");

    console.log("\n=== C2. 前端公式与 Android computeViewport 同口径（对 M02 实测真值）===");
    // 设计分辨率 360×360 相当于 Android 的 CANVAS 单位；屏幕取 M02 用的三档
    const c2 = await cdp.eval(`(function(){
      // 直接用 Android 的公式复算：kx = sw/dw, ky = sh/dh（stretch）
      // M02 实测形变系数：手机 0.475 / 平板 1.690 / 车载 2.254（顶层已扣状态栏）
      // 这里用**同样的屏幕与画布高**验证公式本身
      const cases = [
        { name:"手机竖屏", sw:1080, sh:2273, want:0.475 },
        { name:"平板横屏", sw:1600, sh:947,  want:1.690 },
        { name:"车载宽屏", sw:1280, sh:568,  want:2.254 }
      ];
      return cases.map(function(c){
        const s = window.scaleModeStats(0, 360, 360, c.sw, c.sh);
        return { name:c.name, got:+s.distort.toFixed(3), want:c.want,
                 dev:+Math.abs(s.distort-c.want).toFixed(4) };
      });
    })()`);
    c2.forEach(function (r) {
      ok(r.dev / r.want < 0.03,
        "C2 " + r.name.padEnd(6) + " 公式 " + r.got + " vs 实测 " + r.want + "（偏差 " + (r.dev / r.want * 100).toFixed(1) + "%）");
    });

    console.log("\n=== C3. FIT 不变形 + 算出留白；FILL 不变形 + 算出裁切 ===");
    const c3 = await cdp.eval(`(function(){
      const fit = window.scaleModeStats(1, 360, 360, 1080, 2273);
      const fill = window.scaleModeStats(2, 360, 360, 1080, 2273);
      return {
        fitDistort: fit.distort, fitPadY: fit.padY, fitPadX: fit.padX,
        fillDistort: fill.distort, fillCropX: fill.cropX, fillCropY: fill.cropY
      };
    })()`);
    ok(c3.fitDistort === 1, "C3 FIT 形变系数 = 1（等比不变形）");
    ok(c3.fitPadY > 0 || c3.fitPadX > 0, "C3 FIT 留边 " + Math.round(c3.fitPadX) + "×" + Math.round(c3.fitPadY) + "px（非 0）");
    ok(c3.fillDistort === 1, "C3 FILL 形变系数 = 1（等比不变形）");
    // 裁切可能发生在 X 或 Y（取决于哪一轴先铺满），判两者之和
    const fillCrop = c3.fillCropX + c3.fillCropY;
    ok(fillCrop > 0, "C3 FILL 裁掉 " + Math.round(fillCrop) + "px（X " +
      Math.round(c3.fillCropX) + " / Y " + Math.round(c3.fillCropY) + "，和 > 0）");

    console.log("\n=== C4. 比例预览按钮：只改 designW/H，**节点数据一个字节不动** ===");
    const c4 = await cdp.eval(`(function(){
      const g = window.createNode(window.NODE_GAUGE, { pid:"obd.rpm", x:11, y:22, w:133, h:144 });
      window.commit(function(){ window.CanvasState.design.nodes.push(g); }, "加表");
      const before = { x:g.x, y:g.y, w:g.w, h:g.h, min:g.min, max:g.max };
      const beforeDW = window.CanvasState.design.canvas.designW;
      const beforeDH = window.CanvasState.design.canvas.designH;
      window.applyScreenPreset("carwide");
      function find(id){ let o=null; window.walk(window.CanvasState.design.nodes,n=>{ if(n.id===id) o=n; }); return o; }
      const a = find(g.id);
      return {
        before: before, after: { x:a.x, y:a.y, w:a.w, h:a.h, min:a.min, max:a.max },
        dw: [beforeDW, window.CanvasState.design.canvas.designW],
        dh: [beforeDH, window.CanvasState.design.canvas.designH]
      };
    })()`);
    ok(c4.dw[1] === 1280 && c4.dh[1] === 600, "C4 画布尺寸变为 1280×600（" + c4.dw[0] + "×" + c4.dh[0] + " → " + c4.dw[1] + "×" + c4.dh[1] + "）");
    ok(JSON.stringify(c4.before) === JSON.stringify(c4.after),
      "C4 节点 x/y/w/h/min/max **完全未变**（" + JSON.stringify(c4.after) + "）");

    console.log("\n=== C5. 切换缩放模式不改节点数据 ===");
    const c5 = await cdp.eval(`(function(){
      const g = window.CanvasState.design.nodes.find(n => n.type === window.NODE_GAUGE);
      const before = JSON.stringify({ x:g.x,y:g.y,w:g.w,h:g.h,min:g.min,max:g.max,parts:g.parts });
      const sm = document.getElementById("scaleMode");
      sm.value = "1"; window.canvasChanged();
      const mid = JSON.stringify({ x:g.x,y:g.y,w:g.w,h:g.h,min:g.min,max:g.max,parts:g.parts });
      const mode1 = window.CanvasState.design.canvas.scaleMode;
      sm.value = "0"; window.canvasChanged();
      const mode0 = window.CanvasState.design.canvas.scaleMode;
      return { same: before === mid, mode1: mode1, mode0: mode0 };
    })()`);
    ok(c5.same, "C5 切到 FIT 后节点数据未变");
    ok(c5.mode1 === 1 && c5.mode0 === 0, "C5 scaleMode 能写入并读回（1 → 0）");

    console.log("\n=== C6. 导出 / 解析 / 草稿 保留 scaleMode ===");
    const c6 = await cdp.eval(`(function(){
      const d = window.CanvasState.design;
      d.canvas.scaleMode = 1;
      const json = window.toV2Json ? window.toV2Json(d) : JSON.stringify(d);
      const text = typeof json === "string" ? json : JSON.stringify(json);
      const hasField = text.indexOf('"scaleMode"') >= 0;
      const parsed = window.parseDesign(text);
      return { hasField: hasField, back: parsed.design.canvas.scaleMode, errors: parsed.errors.length };
    })()`);
    ok(c6.hasField, "C6 导出 JSON 含 scaleMode 字段");
    ok(c6.back === 1 && c6.errors === 0, "C6 解析回来 scaleMode=" + c6.back + "，0 错误");

    console.log("\n=== C7. 提示面板：有内容、结论分级正确 ===");
    const c7 = await cdp.eval(`(function(){
      window.CanvasState.design.canvas.designW = 360;
      window.CanvasState.design.canvas.designH = 360;
      window.CanvasState.design.canvas.scaleMode = 0;
      const t0 = window.scaleModeTable();
      const box = document.getElementById("scaleHint");
      window.refreshScaleHint();
      const txt0 = box ? box.textContent : "";
      window.CanvasState.design.canvas.scaleMode = 1;
      const t1 = window.scaleModeTable();
      // ② 设计比例 = 手机竖屏(1080×2400) 时应判 ok
      window.CanvasState.design.canvas.designW = 1080;
      window.CanvasState.design.canvas.designH = 2400;
      const t2 = window.scaleModeTable();
      const phoneRow = t2.rows.find(r => r.id === "phone");
      return {
        stretchLevels: t0.rows.map(r => r.level),
        fitLevels: t1.rows.map(r => r.level),
        fitNoDistort: t1.rows.filter(r => r.text.indexOf("不变形") >= 0).length,
        fitRows: t1.rows.length,
        matchedOk: phoneRow && phoneRow.level === "ok",
        matchedDetail: phoneRow ? (phoneRow.level + " / " + phoneRow.text) : "无",
        textLen: txt0.length,
        hasPhone: txt0.indexOf("手机竖屏") >= 0,
        hasTablet: txt0.indexOf("平板横屏") >= 0,
        hasCar: txt0.indexOf("车载宽屏") >= 0
      };
    })()`);
    ok(c7.textLen > 40, "C7 提示面板有文字（" + c7.textLen + " 字符）");
    ok(c7.hasPhone && c7.hasTablet && c7.hasCar, "C7 三档屏幕都列出（手机/平板/车载）");
    ok(c7.stretchLevels.filter(l => l === "bad").length >= 2,
      "C7 STRETCH 下至少 2 档判为「明显变形」（" + c7.stretchLevels.join("/") + "）");
    // ⚠️ 不能要求"FIT 下多数 ok"：正方形设计(360×360)在 20:9 屏上选 FIT 会留**很大黑边**，
    //    判 bad 是**正确**结论。这里钉的是"FIT 一律不变形"这条硬事实。
    ok(c7.fitNoDistort === c7.fitRows,
      "C7 FIT 下 " + c7.fitNoDistort + "/" + c7.fitRows + " 档文案含「不变形」（形变系数恒为 1）");
    ok(c7.matchedOk, "C7 设计比例与某档屏幕一致时该档判 ok（无留边）——" + c7.matchedDetail);

    console.log("\n=== C8. 旧设计（无 canvas 段）仍按 STRETCH 解析 ===");
    const c8 = await cdp.eval(`(function(){
      const legacy = { schema:"icar.ui/2", meta:{name:"老"}, pages:[{id:"p0",name:"m",nodes:[]}], assets:[] };
      const r = window.parseDesign(JSON.stringify(legacy));
      return { mode: (r.design.canvas||{}).scaleMode, errors: r.errors.length };
    })()`);
    ok(c8.errors === 0 && (c8.mode === 0 || c8.mode === undefined),
      "C8 无 canvas 段的老设计 → scaleMode=" + c8.mode + "（STRETCH），0 错误");

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
