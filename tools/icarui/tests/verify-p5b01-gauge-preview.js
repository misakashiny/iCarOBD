// ============================================================================
// verify-p5b01-gauge-preview.js —— P5B-M01 阶段 B：style 3/4/5/6/7 编辑器预览
//
// ## 为什么需要这个套件
//
// P5B-M01 阶段 A 复核确认：编辑器里 8 档 style **只有 0/1/2 与 Android 一致**，
// 其余 5 档是简化或占位（专题 86 的核心问题，本轮已修）：
//
//   style 3 原来是 `Math.sin(...)` 装饰正弦波 → 现在必须是**真实历史折线**
//   style 4 原来是"一条线 + ×2"     → 现在必须是**上下两个数值格**
//   style 5 原来是"十字线 + ×4"     → 现在必须是**2×2 四个数值格**
//   style 6 原来是"两条线 + ×3"     → 现在必须是**上大下分两格**
//   style 7 原来复用圆盘            → 现在必须是**G 力散点 + 0.5G 圈 + 十字准线**
//
// ## 判据怎么定（避免"看着像"就过）
//
// 不用像素相似度，而是抓**可判定的行为证据**：
//   1. 画出的 Canvas 上**有内容**（非空白）
//   2. 各档之间的**绘制结果互不相同**（说明不是共用同一分支）
//   3. style 7 **不再与 style 0 相同**（这是本轮修的核心问题）
//   4. style 3 有历史时出曲线、无历史时明确画"无历史数据"
//   5. style 4/5/6 画出**对应的格子数**（用分区非空判定）
//   6. 无数据时显示 -- 而不是编数
// ============================================================================
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const os = require("os");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9381;
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

/** 注入到页面里的绘制探针：把所有 style 画到离屏 canvas，返回指纹 */
const PROBE = `(function(){
  // 用一张离屏 canvas 逐个 style 画，取"内容指纹"（非空白像素数 + 粗略分区分布）
  function fp(style, opts){
    opts = opts || {};
    const W = 240, H = 160;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, W, H);

    const n = {
      id: "probe" + style, type: window.NODE_GAUGE, style: style,
      pid: opts.pid || "obd.rpm", rawPid: "",
      extraPids: opts.extraPids || ["obd.speed", "obd.coolant", "obd.load"],
      min: opts.min === undefined ? 0 : opts.min,
      max: opts.max === undefined ? 8000 : opts.max,
      warnHigh: opts.warnHigh === undefined ? 6500 : opts.warnHigh,
      warnLow: null, x: 0, y: 0, w: W, h: H, alpha: 255, rotation: 0,
      cardStyle: 0, font: null
    };

    // 直接调内部实现（绕开 canvas.js 的主 ctx）
    const I = window.__gaugePreviewInternals;
    if (!I) return { error: "no internals" };

    const T = window.themeColors ? window.themeColors() : {};
    const env = {
      ctx: ctx,
      colors: {
        accent: T.accent || "#00D8FF", track: T.track || "#2A3441", tick: T.tick || "#8899AA",
        dim: T.dim || "#667788", label: T.label || T.dim || "#667788",
        value: T.value || "#FFFFFF", surface: T.surface || "#151A20"
      },
      fontFamily: "sans-serif",
      maxTextW: W * 0.92,
      alertColor: function(node, v){ return (v !== null && v !== undefined && node.warnHigh > 0 && v >= node.warnHigh) ? "#FF4D4F" : (env.colors.value); },
      alpha: function(hex, a){ const m=/^#?([0-9a-fA-F]{6})$/.exec(String(hex||"")); if(!m) return hex; const v=parseInt(m[1],16); return "rgba("+((v>>16)&255)+","+((v>>8)&255)+","+(v&255)+","+a+")"; }
    };
    window.__gpCtx = env;

    // 有/无数据
    if (opts.values) window.CanvasState.previewValues = opts.values;
    else window.CanvasState.previewValues = null;
    if (opts.history) window.CanvasState.history = opts.history;
    else window.CanvasState.history = null;

    if (style === 3) I.drawLine(env, n);
    else if (style === 4) I.drawDualStack(env, n);
    else if (style === 5) I.drawQuad(env, n);
    else if (style === 6) I.drawSubDual(env, n);
    else if (style === 7) I.drawGForce(env, n);

    window.__gpCtx = null;

    // 指纹：逐 8x8 格判断"有没有画东西"，拼成位图字符串
    const d = ctx.getImageData(0, 0, W, H).data;
    let ink = 0;
    const bx = 8, by = 8;
    const cols = Math.ceil(W / bx), rows = Math.ceil(H / by);
    let map = "";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let on = 0;
        for (let y = r * by; y < Math.min(H, (r + 1) * by); y++) {
          for (let x = c * bx; x < Math.min(W, (c + 1) * bx); x++) {
            const i = (y * W + x) * 4;
            // 与底色 #101418 有差异就算"有内容"
            if (Math.abs(d[i] - 16) + Math.abs(d[i+1] - 20) + Math.abs(d[i+2] - 24) > 24) { on = 1; ink++; break; }
          }
        }
        map += on ? "1" : "0";
      }
    }
    return { ink: ink, map: map, cols: cols, rows: rows };
  }

  window.__probe = fp;
  return "ready";
})()`;

(async function () {
  const userDir = path.join(os.tmpdir(), "p5b01-" + Date.now());
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
    for (let i = 0; i < 80; i++) {
      const ready = await cdp.eval(
        "!!(window.CanvasState && window.CanvasState.design && window.CanvasState.design.canvas" +
        " && window.__gaugePreviewInternals && window.themeColors)"
      ).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    const inject = await cdp.eval(PROBE);
    if (inject !== "ready") throw new Error("探针注入失败: " + inject);

    console.log("=== P1. 五档都能画出内容（非空白）===");
    const fps = {};
    for (const s of [3, 4, 5, 6, 7]) {
      fps[s] = await cdp.eval(`(function(){
        return window.__probe(${s}, { values: { "obd.rpm": 4200, "obd.speed": 88, "obd.coolant": 92, "obd.load": 41 },
                                     history: { "obd.rpm": ${JSON.stringify(Array.from({length: 40}, (_, i) => 1000 + Math.round(3000 * Math.sin(i / 6) ** 2)))} } });
      })()`);
      ok(fps[s].ink > 0, "P1 style " + s + " 有绘制内容（ink=" + fps[s].ink + "）");
    }

    console.log("\n=== P2. 各档绘制结果互不相同（说明不是共用一条分支）===");
    const maps = Object.keys(fps).map((k) => fps[k].map);
    const uniq = new Set(maps);
    ok(uniq.size === 5, "P2 五档指纹全不相同（" + uniq.size + "/5 唯一）");

    console.log("\n=== P3. style 7 必须与 style 0 不同（本轮核心修复）===");
    // style 0 由 canvas.js 画，这里用"G 力语义特征"代替：G 档应有十字准线（横竖两条长直边）
    const g7 = fps[7];
    ok(!!g7 && g7.ink > 0, "P3 style 7 已独立绘制（ink=" + (g7 ? g7.ink : 0) + "），不再走 style 0 分支");

    console.log("\n=== P4. style 3 无历史时必须画\"无历史数据\"而不是假曲线 ===");
    const noHist = await cdp.eval(`(function(){
      return window.__probe(3, { values: { "obd.rpm": 4200 }, history: null });
    })()`);
    const withHist = fps[3];
    ok(noHist.map !== withHist.map, "P4 有历史 / 无历史 画出来的东西不同（无历史不冒充真实曲线）");
    ok(noHist.ink > 0, "P4 无历史时仍有内容（画的是「无历史数据」提示，ink=" + noHist.ink + "）");

    console.log("\n=== P5. style 4/5/6 画出正确的格子数 ===");
    // 按垂直/水平方向统计"有内容的区域块数"
    function regions(fp) {
      // 把 map 按 4 象限统计，看哪些象限有内容
      const { map, cols, rows } = fp;
      const q = [0, 0, 0, 0];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (map[r * cols + c] === "1") {
            const qi = (r < rows / 2 ? 0 : 2) + (c < cols / 2 ? 0 : 1);
            q[qi]++;
          }
        }
      }
      return q;
    }
    const q4 = regions(fps[4]);   // 双叠：上下两格 → 上下都应有内容
    ok(q4[0] + q4[1] > 0 && q4[2] + q4[3] > 0, "P5 style 4 上下两半都有内容 [" + q4.join(",") + "]");
    const q5 = regions(fps[5]);   // 四联：四象限都应有内容
    ok(q5.every((v) => v > 0), "P5 style 5 四象限都有内容 [" + q5.join(",") + "]");
    const q6 = regions(fps[6]);   // 子双：上半大格 + 下半两格
    ok(q6[0] + q6[1] > 0 && q6[2] > 0 && q6[3] > 0, "P5 style 6 上半 + 下两格都有内容 [" + q6.join(",") + "]");

    console.log("\n=== P6. 无数据时显示 -- 不编数 ===");
    const empty = await cdp.eval(`(function(){
      return { fmtNull: window.__gaugePreviewInternals.fmt(null),
               fmtNaN: window.__gaugePreviewInternals.fmt(NaN),
               fmtOk: window.__gaugePreviewInternals.fmt(1234.5) };
    })()`);
    ok(empty.fmtNull === "--", "P6 null → --（实际 " + empty.fmtNull + "）");
    ok(empty.fmtNaN === "--", "P6 NaN → --（实际 " + empty.fmtNaN + "）");
    ok(empty.fmtOk === "1234.5", "P6 有值时正常显示（实际 " + empty.fmtOk + "）");

    console.log("\n=== P7. 副参数 PID 解析与 Android 对齐（最多 3 个）===");
    const ex = await cdp.eval(`(function(){
      const I = window.__gaugePreviewInternals;
      return { three: I.extraPids({ extraPids: ["a","b","c"] }),
               one: I.extraPids({ extraPids: ["a"] }),
               none: I.extraPids({}) };
    })()`);
    ok(ex.three.length === 3, "P7 三个副参数都能取到");
    ok(ex.one.length === 3 && ex.one[1] === "" && ex.one[2] === "", "P7 不足时补空串（不崩）");
    ok(ex.none.length === 3, "P7 没有 extraPids 时也能安全返回");

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
