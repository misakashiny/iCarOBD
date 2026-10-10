/* ==========================================================================
   verify-tokens2.js —— 第 5 步：**画布走 `resolveDesign`**（画布与导出一致）

   ## 为什么要有这一套（而不是塞进 verify-tokens.js）
   `verify-tokens.js` 在 `vm` 沙箱里跑纯逻辑（没有 DOM、没有 canvas）——
   而第 5 步改的是 `canvas.js` 的 `draw()`：**绑定到底有没有画到屏幕上**。
   那只能用真浏览器、真画布。

   ## 判据为什么用"逐像素相同"而不是"读某个像素的颜色"
   要证的是「绑定在屏幕上生效」，最硬的写法是：

       带 bindings 的设计（nodes 里还是旧值）  vs  把绑定算好的字面值直接写进 nodes
                       ↓ 两者画出来的画面必须**逐像素完全相同**

   这比"读一个像素看看是不是红色"强得多 —— 后者只验了一个点，
   而前者验了整张画布（文字的抗锯齿、圆角、透明度全都算进去）。
   而且它顺带就是"画布与导出一致"的证据：导出写的就是那套字面值。

   ## ⚠️ 每条正向断言都配一条**反向断言**
   "两张图一样"和"两次都画了空白"长得一模一样。所以每条相等断言后面都跟着
   一条"改掉那个字面值 → 指纹必须变"（见大纲 §2.101「反向验证本身也会假通过」）。
   ========================================================================== */
"use strict";

const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const path = require("path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = path.join(__dirname, "..", "index.html");
const URL_PAGE = require("url").pathToFileURL(PAGE).href;
const PORT = 9296;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 等页面**真的就绪**（而不是硬等固定毫秒）—— 与 verify-theme.js 同一套判据 */
async function waitReady(cdp, timeoutMs) {
  const t0 = Date.now();
  const limit = timeoutMs || 20000;
  while (Date.now() - t0 < limit) {
    try {
      const ok = await cdp.eval("!!(window.CanvasState && (window.BUILTIN_ASSETS||[]).length > 0 && document.getElementById('cv') && document.getElementById('cv').width > 0 && window.BUILTIN_DATA_DONE !== false)");
      if (ok) return true;
    } catch (e) { /* 页面还没起来，继续等 */ }
    await sleep(200);
  }
  return false;
}
const getJson = p => new Promise((res, rej) => {
  http.get({ host: "127.0.0.1", port: PORT, path: p }, r => {
    let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on("error", rej);
});
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); this.events = []; }
  static async connect(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
      else if (m.method) c.events.push(m);
    };
    return c;
  }
  send(m, p, timeoutMs) {
    const id = ++this.id;
    const LIMIT = timeoutMs || 12000;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (this.w.has(id)) { this.w.delete(id); rej(new Error("CDP 超时（" + LIMIT + "ms）: " + m)); }
      }, LIMIT);
      this.w.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
      try { this.ws.send(JSON.stringify({ id, method: m, params: p })); }
      catch (e) { clearTimeout(timer); this.w.delete(id); rej(e); }
    });
  }
  async eval(e) {
    const TRANSIENT = /-32000|navigated or closed|Target closed|Session closed/i;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await this.send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + ((r.exceptionDetails.exception || {}).description || ""));
        return r.result.value;
      } catch (err) {
        lastErr = err;
        if (!TRANSIENT.test(String(err && err.message))) throw err;
        try { await waitReady(this, 2000); } catch (e2) { /* 等不到就按原节奏重试 */ }
        await new Promise(res => setTimeout(res, 350 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
}
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? "" : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));

/**
 * 注入到页面里的辅助函数（**只注入一次**）。
 *
 * ⚠️ 不要在 `cdp.eval` 的模板串里写反引号 —— 外层就是模板串，套两层转义
 * 会变成"看得见却查不出来"的语法错误（大纲 §2.49 那条教训）。
 */
const HELPERS = `
window.__mkDesign = function (root) {
  const r = window.parseDesign(JSON.stringify(root));
  if (r.errors.length) return { errors: r.errors, warnings: r.warnings };
  window.CanvasState.design = r.design;
  window.CanvasState.selection = [];
  window.CanvasState.snapLines = null;
  window.CanvasState.showGrid = false;
  window.CanvasState.bgImage = null;
  window.applyCanvasSize();
  return { errors: [], warnings: r.warnings };
};
window.__fp = function () {
  const S = window.CanvasState;
  S.selection = []; S.snapLines = null; S.showGrid = false; S.bgImage = null;
  window.draw();
  return document.getElementById("cv").toDataURL();
};
window.__px = function (x, y) {
  const cv = document.getElementById("cv");
  const d = cv.getContext("2d").getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};
window.__hex = function (rgb) {
  const h = n => ("0" + n.toString(16)).slice(-2);
  return "#" + h(rgb[0]) + h(rgb[1]) + h(rgb[2]);
};
1`;

/** 一份最小但合法的设计：一个文字节点 + 一个仪表节点（都带可绑字段） */
const BASE = `
function base() {
  return {
    schema: "icar.ui/2",
    meta: { name: "画布绑定" },
    canvas: { unit: 360, designW: 2560, designH: 1600, scaleMode: 0 },
    theme: "neon",
    nodes: [
      { id: "t1", type: "text", name: "标题", x: 20, y: 20, w: 220, h: 60,
        text: "转速", font: { family: "sans", size: 24, weight: 700, align: "center", color: "#123456" } },
      { id: "g1", type: "gauge", name: "表", x: 40, y: 120, w: 220, h: 220,
        pid: "obd.rpm", style: 0, min: 0, max: 8000,
        card: { show: true, alpha: 200, radius: 12 }, labelFont: { color: "#D8BFA0" } }
    ]
  };
}
`;

(async () => {
  const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-tokens2`, "--window-size=1680,1050", "about:blank"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson("/json/version"); break; } catch (e) { await sleep(250); } }
    const t = (await getJson("/json/list")).find(x => x.type === "page");
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable"); await cdp.send("Log.enable");
    await cdp.send("Page.navigate", { url: URL_PAGE });
    await waitReady(cdp);
    await require("./_common").stubDialogs(cdp);
    await cdp.eval(HELPERS);

    const errs = cdp.events.filter(e => e.method === "Runtime.exceptionThrown" ||
      (e.method === "Log.entryAdded" && e.params.entry.level === "error"));
    console.log("\n=== 0. JS 错误 ===");
    errs.slice(0, 4).forEach(e => console.log("    ⚠️ " + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split("\n")[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);

    // ============================================================ 1) draw() 走唯一入口
    console.log("\n=== 1. `draw()` 必须走 `resolveDesign`（§4 唯一入口） ===");
    {
      const r = await cdp.eval(`(() => {
        const orig = window.resolveDesign;
        let calls = 0, lastDesign = null;
        window.resolveDesign = function (d, o) { calls++; lastDesign = d; return orig(d, o); };
        try { window.draw(); } finally { window.resolveDesign = orig; }
        return JSON.stringify({ calls: calls, 是同一个design: lastDesign === window.CanvasState.design });
      })()`);
      const R = JSON.parse(r);
      ok(R.calls >= 1, "第 5 步 `draw()` 调用了 `resolveDesign`（实际 " + R.calls + " 次）");
      eq(R.是同一个design, true, "第 5 步 解析的是 `S.design` 本身（不是别的副本）");
    }

    // ============================================================ 2) 模式 → 画布背景（精确像素）
    console.log("\n=== 2. 模式解析出来的配色必须画到画布上（精确像素） ===");
    {
      const r = await cdp.eval(`(() => {
        ${BASE}
        const mk = (modeValues, active) => {
          const root = base();
          root.tokens = [
            { id: "tk_background", name: "background", type: "color", value: "#080A0E", builtin: "background" },
            { id: "tk_accent", name: "accent", type: "color", value: "#FF8A00", builtin: "accent" }
          ];
          root.modes = [
            { id: "m_red", name: "红", values: { tk_background: "#FF0000" } },
            { id: "m_empty", name: "空", values: {} }
          ];
          root.activeMode = active;
          return root;
        };
        const out = {};
        // ① 模式把背景改成纯红
        const a = window.__mkDesign(mk(null, "m_red"));
        out.aErr = a.errors.length;
        out.aWarn = a.warnings.length;
        out.aPx = window.__px(3, 3);
        out.aResolved = window.resolveDesign(window.CanvasState.design).themeColors.background;
        out.aExported = JSON.parse(window.toV2Json(window.CanvasState.design)).themeColors.background;
        // ② 切到空模式 → 回落 token.value（= neon 的背景）
        const b = window.__mkDesign(mk(null, "m_empty"));
        out.bErr = b.errors.length;
        out.bPx = window.__px(3, 3);
        out.bResolved = window.resolveDesign(window.CanvasState.design).themeColors.background;
        out.bExported = JSON.parse(window.toV2Json(window.CanvasState.design)).themeColors.background;
        return JSON.stringify(out);
      })()`);
      const R = JSON.parse(r);
      eq(R.aErr, 0, "第 5 步 模式样本：0 错误");
      eq(R.aWarn, 0, "第 5 步 模式样本：0 警告");
      eq(R.aResolved, "#FF0000", "第 5 步 解析视图里 themeColors.background = 模式给的 #FF0000");
      eq(R.aExported, "#FF0000", "第 5 步 导出里同样是 #FF0000（画布与导出同一份来源）");
      eq(R.aPx[3], 255, "第 5 步 画布该点是不透明的（不是没画）");
      eq(R.aPx[0] + "," + R.aPx[1] + "," + R.aPx[2], "255,0,0",
        "第 5 步 **画布背景就是模式给的 #FF0000**（切模式立刻反映到屏幕上）");
      eq(R.bResolved, "#080A0E", "第 5 步 切到空模式 → 回落 token.value（neon 背景）");
      eq(R.bPx[0] + "," + R.bPx[1] + "," + R.bPx[2], "8,10,14", "第 5 步 画布跟着回落（反向：不是「画什么都红」）");
    }

    // ============================================================ 3) 绑定 == 字面值（逐像素）
    console.log("\n=== 3. 绑定后的画面与「把字面值直接写进 nodes」逐像素相同 ===");
    {
      const r = await cdp.eval(`(() => {
        ${BASE}
        const tokens = [
          { id: "tk_accent", name: "accent", type: "color", value: "#FF0000", builtin: "accent" },
          { id: "tk_t", name: "title", type: "string", value: "绑定文本" },
          { id: "tk_r", name: "radius", type: "number", value: 40 }
        ];
        const modes = [{ id: "m_neon", name: "霓虹赛道", values: {} }];
        const out = {};
        // ① font.color
        const A1 = base(); A1.tokens = tokens; A1.modes = modes; A1.activeMode = "m_neon";
        A1.bindings = { t1: { "font.color": "$accent" } };          // nodes 里还是旧的 #123456
        const B1 = base(); B1.tokens = tokens; B1.modes = modes; B1.activeMode = "m_neon";
        B1.nodes[0].font.color = "#FF0000";                          // 字面值（= 绑定算出来的）
        const C1 = base(); C1.tokens = tokens; C1.modes = modes; C1.activeMode = "m_neon";
        C1.nodes[0].font.color = "#00FF00";                          // 反向：换个颜色
        out.a1 = window.__mkDesign(A1).errors.length; out.fpA1 = window.__fp();
        out.b1 = window.__mkDesign(B1).errors.length; out.fpB1 = window.__fp();
        out.c1 = window.__mkDesign(C1).errors.length; out.fpC1 = window.__fp();
        // ② text（绑定来的字符串）
        const A2 = base(); A2.tokens = tokens; A2.modes = modes; A2.activeMode = "m_neon";
        A2.bindings = { t1: { "text": "$title" } };                  // nodes 里还是"转速"
        const B2 = base(); B2.tokens = tokens; B2.modes = modes; B2.activeMode = "m_neon";
        B2.nodes[0].text = "绑定文本";
        const C2 = base(); C2.tokens = tokens; C2.modes = modes; C2.activeMode = "m_neon";
        C2.nodes[0].text = "别的文本";
        out.a2 = window.__mkDesign(A2).errors.length; out.fpA2 = window.__fp();
        out.b2 = window.__mkDesign(B2).errors.length; out.fpB2 = window.__fp();
        out.c2 = window.__mkDesign(C2).errors.length; out.fpC2 = window.__fp();
        // ③ card.radius（数字绑定）
        const A3 = base(); A3.tokens = tokens; A3.modes = modes; A3.activeMode = "m_neon";
        A3.bindings = { g1: { "card.radius": "$radius" } };          // nodes 里还是 12
        const B3 = base(); B3.tokens = tokens; B3.modes = modes; B3.activeMode = "m_neon";
        B3.nodes[1].card.radius = 40;
        const C3 = base(); C3.tokens = tokens; C3.modes = modes; C3.activeMode = "m_neon";
        C3.nodes[1].card.radius = 4;
        out.a3 = window.__mkDesign(A3).errors.length; out.fpA3 = window.__fp();
        out.b3 = window.__mkDesign(B3).errors.length; out.fpB3 = window.__fp();
        out.c3 = window.__mkDesign(C3).errors.length; out.fpC3 = window.__fp();
        return JSON.stringify(out);
      })()`);
      const R = JSON.parse(r);
      eq(R.a1 + R.b1 + R.c1 + R.a2 + R.b2 + R.c2 + R.a3 + R.b3 + R.c3, 0, "第 5 步 三个样本都合法（0 错误）");
      eq(R.fpA1 === R.fpB1, true, "第 5 步 `font.color` 绑定：画面与「字面值直接写 nodes」**逐像素相同**");
      ok(R.fpA1 !== R.fpC1, "第 5 步（反向）换个颜色画面就不同 —— 证明上面的「相同」不是空白对空白");
      eq(R.fpA2 === R.fpB2, true, "第 5 步 `text` 绑定：画面与字面值相同（绑定来的字符串真的画出来了）");
      ok(R.fpA2 !== R.fpC2, "第 5 步（反向）换段文字画面就不同");
      eq(R.fpA3 === R.fpB3, true, "第 5 步 `card.radius` 绑定：画面与字面值相同");
      ok(R.fpA3 !== R.fpC3, "第 5 步（反向）换个圆角画面就不同");
    }

    // ============================================================ 4) 画布 vs 导出
    console.log("\n=== 4. 画布与导出一致（导出写的字面值 = 画布画的那个值） ===");
    {
      const r = await cdp.eval(`(() => {
        ${BASE}
        const root = base();
        root.tokens = [
          { id: "tk_accent", name: "accent", type: "color", value: "#FF0000", builtin: "accent" },
          { id: "tk_t", name: "title", type: "string", value: "$100" },
          { id: "tk_r", name: "radius", type: "number", value: 40 }
        ];
        root.modes = [{ id: "m_neon", name: "霓虹赛道", values: {} }];
        root.activeMode = "m_neon";
        root.bindings = { t1: { "font.color": "$accent", "text": "$title" }, g1: { "card.radius": "$radius" } };
        const mk = window.__mkDesign(root);
        const view = window.resolveDesign(window.CanvasState.design);
        const out = JSON.parse(window.toV2Json(window.CanvasState.design));
        return JSON.stringify({
          err: mk.errors.length, warn: mk.warnings.length,
          viewColor: view.nodes[0].font.color, outColor: out.nodes[0].font.color,
          viewText: view.nodes[0].text, outText: out.nodes[0].text,
          viewRadius: view.nodes[1].card.radius, outRadius: out.nodes[1].card.radius,
          outHasDollar: JSON.stringify(out.nodes).indexOf("$accent") >= 0
        });
      })()`);
      const R = JSON.parse(r);
      eq(R.err, 0, "第 5 步 一致样本：0 错误");
      eq(R.warn, 3, "第 5 步 一致样本：恰好 3 条**漂移警告**（样本里 nodes 存的是旧值 —— 漂移只警告，不拦文件）");
      eq(R.outColor, R.viewColor, "第 5 步 导出的 `font.color` = 画布用的那个值（" + R.viewColor + "）");
      eq(R.outColor, "#FF0000", "第 5 步 而且它就是绑定算出来的 #FF0000");
      eq(R.outText, R.viewText, "第 5 步 导出的 `text` = 画布显示的那个串（绑定来的）");
      eq(R.outText, "$100", "第 5 步 绑定来的 `$100` 写进文件仍是 `$100`（App 原样显示 → 设备上也是 $100）");
      eq(R.outRadius, R.viewRadius, "第 5 步 导出的 `card.radius` = 画布用的那个值");
      eq(R.outRadius, 40, "第 5 步 数字绑定落盘正确（40）");
      eq(R.outHasDollar, false, "第 5 步 导出的 `nodes` 里没有 `$accent` 这种引用串（App 会静默回落）");
    }

    // ============================================================ 5) `text` 是纯字面值
    console.log("\n=== 5. `text` 是纯字面值：画布 / 文件 / App 三边同一个串（`$$` 转义已取消） ===");
    {
      const r = await cdp.eval(`(() => {
        ${BASE}
        const root = base();
        root.nodes[0].text = "$$100";
        const mk = window.__mkDesign(root);
        const view = window.resolveDesign(window.CanvasState.design);
        const out = JSON.parse(window.toV2Json(window.CanvasState.design));
        return JSON.stringify({
          err: mk.errors.length, warn: mk.warnings.length,
          viewText: view.nodes[0].text, outText: out.nodes[0].text,
          raw: window.CanvasState.design.nodes[0].text
        });
      })()`);
      const R = JSON.parse(r);
      eq(R.err, 0, "第 5 步 `$$100` 样本：0 错误（不拦文件）");
      eq(R.warn, 1, "第 5 步 `$$100` 样本：1 条警告（它以 `$` 开头，看起来像引用 —— 取消转义要付的代价）");
      eq(R.raw, "$$100", "第 5 步 内存里就是文件原样（`$$100`）");
      eq(R.viewText, "$$100", "第 5 步 **画布显示 `$$100`**（没有哪一层会把它变成 `$100`）");
      eq(R.outText, "$$100", "第 5 步 **文件里也是 `$$100`**（逐字节稳定）");
    }
    {
      // 对照：绑定来的 `$` 开头字符串 —— 画布、文件、设备三边都是 `$100`
      const r = await cdp.eval(`(() => {
        ${BASE}
        const root = base();
        root.tokens = [{ id: "tk_t", name: "title", type: "string", value: "$100" }];
        root.bindings = { t1: { "text": "$title" } };
        root.nodes[0].text = "$100";                 // 与绑定推出来的一致（健康文件）
        const mk = window.__mkDesign(root);
        const view = window.resolveDesign(window.CanvasState.design);
        const out = JSON.parse(window.toV2Json(window.CanvasState.design));
        const again = JSON.parse(window.toV2Json(window.parseDesign(JSON.stringify(out)).design));
        return JSON.stringify({
          err: mk.errors.length, warn: mk.warnings.length,
          viewText: view.nodes[0].text, outText: out.nodes[0].text,
          againText: again.nodes[0].text,
          逐字节稳定: JSON.stringify(again) === JSON.stringify(out)
        });
      })()`);
      const R = JSON.parse(r);
      eq(R.err, 0, "第 5 步 绑定 `$100`：0 错误");
      eq(R.warn, 0, "第 5 步 绑定 `$100`：0 警告（绑定声明了这条引用）");
      eq(R.viewText, "$100", "第 5 步 画布显示 `$100`");
      eq(R.outText, "$100", "第 5 步 文件里也是 `$100` —— **设备上就是 `$100`**（App 原样渲染）");
      eq(R.againText, "$100", "第 5 步 再打开一次仍然是 `$100`（不会「每存一次退一步」）");
      eq(R.逐字节稳定, true, "第 5 步 文件 → 内存 → 文件 逐字节稳定");
    }

    await cdp.ws.close();
  } catch (e) {
    console.log("  ❌ 执行失败: " + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log("\n" + "=".repeat(58));
  console.log("PASS=" + pass + "  FAIL=" + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
