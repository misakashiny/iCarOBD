// ============================================================================
// ADB UI 自动化辅助（P5A-M02 内部使用）
//
// 只做三件事：dump 界面树 → 按文本找控件 → 点它。
// 之所以抽出来：阶段 C/D/E 都要「滑到设置页 → 导入 → 回画布 → 截图」，
// 各写一份必然各自漂移（M01 就在 BACK 键上踩过：退出对话框把 App 踢到后台）。
// ============================================================================
const { execFileSync } = require("child_process");

const ADB = process.env.ADB_PATH || "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const DEV = process.env.ADB_DEVICE || "emulator-5554";

function sh(args, timeout) {
  try {
    return execFileSync(ADB, ["-s", DEV].concat(args), {
      encoding: "utf8",
      timeout: timeout || 90000,
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 解析当前界面：返回 [{text, cx, cy, x0,y0,x1,y1, cls, id, desc}] */
function dumpUI() {
  sh(["shell", "uiautomator", "dump", "/sdcard/_p5a02.xml"]);
  const xml = sh(["shell", "cat", "/sdcard/_p5a02.xml"]);
  const items = [];
  // 依次匹配属性块；text 可能为空（用 content-desc 兜底）
  const nodeRe = /<node\b([^>]*)\/?>/g;
  let m;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const get = (k) => {
      const r = new RegExp(k + '="([^"]*)"').exec(attrs);
      return r ? r[1] : "";
    };
    const text = get("text");
    const desc = get("content-desc");
    const label = text || desc;
    if (!label) continue;
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(attrs);
    if (!b) continue;
    const x0 = +b[1], y0 = +b[2], x1 = +b[3], y1 = +b[4];
    items.push({
      text, desc, label,
      cls: get("class"),
      id: get("resource-id"),
      x0, y0, x1, y1,
      cx: Math.round((x0 + x1) / 2),
      cy: Math.round((y0 + y1) / 2)
    });
  }
  return items;
}

/** 按文本子串找（优先精确匹配，其次包含） */
function find(items, substr, opts) {
  const exact = items.filter((i) => i.label === substr);
  if (exact.length) return exact[0];
  const part = items.filter((i) => i.label.indexOf(substr) >= 0);
  if (!part.length) return null;
  if (opts && opts.last) return part[part.length - 1];
  return part[0];
}
function findAll(items, substr) {
  return items.filter((i) => i.label.indexOf(substr) >= 0);
}
const tap = (x, y) => sh(["shell", "input", "tap", String(x), String(y)]);
const back = () => sh(["shell", "input", "keyevent", "KEYCODE_BACK"]);
// ⚠️ P5A-M03 实测：1000→100 这种"贴边"的滑动在这个 App 里**不稳定**（常常不翻页），
//    900→150 + 250ms 才稳定触发 pager 翻页。改这里之前请先跑一遍翻页用例。
const swipeL = (y) => sh(["shell", "input", "swipe", "900", String(y || 1200), "150", String(y || 1200), "250"]);
const swipeR = (y) => sh(["shell", "input", "swipe", "150", String(y || 1200), "900", String(y || 1200), "250"]);

/** 前台 Activity（简名）；不在 App 返回 null */
function foreground() {
  const d = sh(["shell", "dumpsys", "activity", "activities"]);
  const m = /topResumedActivity=[^\n]*?com\.icar\.obd\/([^\s}]+)/.exec(d);
  return m ? m[1] : null;
}
const appAlive = () => sh(["shell", "ps", "-A"]).indexOf("com.icar.obd") >= 0;
function appPid() {
  const ps = sh(["shell", "ps", "-A"]);
  const m = /^\S+\s+(\d+).*com\.icar\.obd/m.exec(ps);
  return m ? +m[1] : null;
}
function fatalLogs() {
  return sh(["logcat", "-d", "-s", "AndroidRuntime:E"])
    .split("\n").filter((x) => /FATAL/.test(x));
}
function clearLog() { sh(["logcat", "-c"]); }
function logTag(tag) { return sh(["logcat", "-d", "-s", tag + ":I", tag + ":W"]); }

/** 拉起 App（已在前台则无害） */
async function launchApp(waitMs) {
  sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await sleep(waitMs || 8000);
}

/** 关掉可能残留的对话框 */
async function dismissDialogs() {
  for (let k = 0; k < 3; k++) {
    const items = dumpUI();
    const b = find(items, "取消") || find(items, "确定") || find(items, "知道了");
    if (!b) return;
    tap(b.cx, b.cy);
    await sleep(1200);
  }
}

/** 滑到设置页（含「导入画布」的那页），返回该页 items */
async function gotoSettings() {
  let items = dumpUI();
  for (let i = 0; i < 6; i++) {
    if (find(items, "导入画布")) return items;
    swipeL(1200);
    await sleep(700);
    items = dumpUI();
  }
  return items;
}

/** 回到画布页（第 1 页） */
async function gotoCanvas() {
  for (let i = 0; i < 6; i++) {
    const items = dumpUI();
    if (!find(items, "导入画布")) return items;
    swipeR(1200);
    await sleep(700);
  }
  return dumpUI();
}

/**
 * 导入设计包 / 设计文件。
 * @param fileName SAF 里的文件名（如 state-lamps.icarzip）
 * @param confirmText 确认按钮文本（默认「导入」）
 * @returns {{ok:boolean, dialog:string, detail:string}}
 */
async function importFile(fileName, confirmText) {
  await launchApp();
  await dismissDialogs();
  let items = await gotoSettings();
  const imp = find(items, "导入画布");
  if (!imp) return { ok: false, dialog: "", detail: "找不到「导入画布」按钮" };
  tap(imp.cx, imp.cy);
  await sleep(4500);

  // SAF：先看当前目录，必要时点「下载」
  items = dumpUI();
  let f = find(items, fileName);
  if (!f) {
    const dl = find(items, "下载");
    if (dl) { tap(dl.cx, dl.cy); await sleep(3500); items = dumpUI(); f = find(items, fileName); }
  }
  if (!f) {
    // 滚动找
    for (let k = 0; k < 4 && !f; k++) {
      sh(["shell", "input", "swipe", "540", "1800", "540", "900", "300"]);
      await sleep(1500);
      items = dumpUI();
      f = find(items, fileName);
    }
  }
  if (!f) {
    const vis = items.filter((i) => /\.(json|icarzip)$/.test(i.label)).map((i) => i.label);
    back();
    await sleep(1500);
    return { ok: false, dialog: "", detail: "SAF 里找不到 " + fileName + "（可见: " + vis.join(", ") + "）" };
  }
  tap(f.cx, f.cy);
  await sleep(4500);

  items = dumpUI();
  // ⚠️ 标题有两种：单文件是「导入设计文件」，设计包是「导入设计包」。
  //    不要只认一种 —— M01 就在这里误判成"解析失败"直接把对话框取消了。
  const titleItem = items.find((i) => /导入设计(文件|包)/.test(i.label));
  const hasDialog = !!titleItem || (!!find(items, "取消") && items.filter((i) => i.label === "导入").length > 0);
  const bodyItem = items.find((i) => /设计：|错误|无法|不支持|语法|提示|⚠/.test(i.label));
  const detail = bodyItem ? bodyItem.label.replace(/&#10;/g, " | ") : "";

  if (hasDialog) {
    const btn = find(items, confirmText || "导入", { last: true });
    if (!btn) {
      back();
      await sleep(1200);
      return { ok: false, dialog: "yes", detail: detail + "（找不到确认按钮）" };
    }
    tap(btn.cx, btn.cy);
    await sleep(5000);
    return { ok: true, dialog: "yes", title: titleItem ? titleItem.label : "", detail };
  }

  // 没有确认框 = 解析失败，把错误文本带走
  const err = items.find((i) => /错误|无法|不支持|语法|失败|损坏/.test(i.label));
  const okBtn = find(items, "确定") || find(items, "知道了") || find(items, "好");
  if (okBtn) { tap(okBtn.cx, okBtn.cy); await sleep(1200); }
  else { back(); await sleep(1200); }
  return { ok: false, dialog: "no", detail: err ? err.label : detail };
}

/** 截图并 pull 到本地 */
function screenshot(localPath) {
  sh(["shell", "screencap", "-p", "/sdcard/_p5a02.png"]);
  sh(["pull", "/sdcard/_p5a02.png", localPath]);
  try { return require("fs").statSync(localPath).size; } catch (e) { return 0; }
}

module.exports = {
  ADB, DEV, sh, sleep,
  dumpUI, find, findAll, tap, back, swipeL, swipeR,
  foreground, appAlive, appPid, fatalLogs, clearLog, logTag,
  launchApp, dismissDialogs, gotoSettings, gotoCanvas, importFile, screenshot
};
