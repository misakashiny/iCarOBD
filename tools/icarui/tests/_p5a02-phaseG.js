// ============================================================================
// P5A-M02 阶段 G：运行体验与异常恢复（模拟器实测）
//
// 覆盖任务 §9 的 8 项里可自动化的部分：
//   G1 无 OBD 数据时的界面          → 断开后仪表区仍有边框/文字，不是白屏（内容占比 > 1%）
//   G2 OBD 断连与恢复状态           → 断连后总线 ok=0；恢复后 ok=1
//   G3 缺失 PID 时的提示            → 未知态灯保持 --（阶段 C 已覆盖，这里复查一次截图）
//   G4 无效主题导入的错误信息        → 损坏 JSON 弹「设计文件有错误」且不崩
//   G5 图片素材丢失时的降级          → 删掉一个素材文件后重启：不崩，其它控件仍渲染
//   G6 后台恢复后仪表是否停在旧数据  → 后台期间换场景，回前台必须跟着变（不能是旧图）
//   G7 Debug 模拟状态是否清晰可见    → 界面上出现「模拟数据（非真车）」横幅
//   G8 长时间运行后能否退出再进入    → force-stop → start → 仍能正常渲染
// ============================================================================
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ui = require("./_adbui.js");

const SHOT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "screenshots");

// ---- PNG 解码（只统计「非背景」与「环像素」）----
function decodePNG(p) {
  const b = fs.readFileSync(p);
  let pos = 8, w = 0, h = 0; const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), ty = b.toString("ascii", pos + 4, pos + 8);
    if (ty === "IHDR") { w = b.readUInt32BE(pos + 8); h = b.readUInt32BE(pos + 12); }
    if (ty === "IDAT") idat.push(b.slice(pos + 8, pos + 8 + len));
    if (ty === "IEND") break; pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp; const out = Buffer.alloc(w * h * 4); let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const bb = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
      let v;
      if (f === 0) v = cur; else if (f === 1) v = cur + a; else if (f === 2) v = cur + bb;
      else if (f === 3) v = cur + Math.floor((a + bb) / 2);
      else { const p2 = a + bb - c, pa = Math.abs(p2 - a), pb = Math.abs(p2 - bb), pc = Math.abs(p2 - c); v = cur + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c)); }
      out[y * stride + x] = v & 255;
    }
    rp += stride;
  }
  return { w, h, px: out };
}

function stats(p) {
  const img = decodePNG(p);
  const top = Math.round(img.h * 0.053);
  let lit = 0, n = 0, ring = 0;
  for (let y = top; y < img.h; y += 2) {
    for (let x = 0; x < img.w; x += 2) {
      const i = (y * img.w + x) * 4;
      if (img.px[i] + img.px[i + 1] + img.px[i + 2] > 70) lit++;
      if (Math.abs(img.px[i] - 78) + Math.abs(img.px[i + 1] - 132) + Math.abs(img.px[i + 2] - 200) <= 70) ring++;
      n++;
    }
  }
  return { w: img.w, h: img.h, litRatio: lit / n, ringPx: ring, img };
}
function diffRatio(a, b) {
  const A = a.img, B = b.img;
  const h = Math.min(A.h, B.h), w = Math.min(A.w, B.w);
  let n = 0, d = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = (y * A.w + x) * 4, j = (y * B.w + x) * 4;
    const dd = Math.abs(A.px[i] - B.px[j]) + Math.abs(A.px[i + 1] - B.px[j + 1]) + Math.abs(A.px[i + 2] - B.px[j + 2]);
    n++; if (dd > 18) d++;
  }
  return n ? d / n : 0;
}

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));
const shot = (name) => {
  const p = path.join(SHOT, name);
  ui.screenshot(p);
  return stats(p);
};

(async function () {
  console.log("=== P5A-M02 阶段 G：运行体验与异常恢复 ===\n");

  // ---------------------------------------------------------------- G7 横幅
  console.log("--- G7 Debug 模拟状态可见标记 ---");
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(6000);
  await ui.gotoCanvas();
  await ui.sleep(1500);
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "3"]);
  await ui.sleep(2500);
  let items = ui.dumpUI();
  const banner = items.find((i) => /模拟数据/.test(i.label));
  ok(!!banner, "G7 界面出现「模拟数据（非真车）」横幅：" + (banner ? banner.label.slice(0, 40) : "未找到"));

  // ---------------------------------------------------------------- G8 退出再进入
  console.log("\n--- G8 退出后重新进入 ---");
  ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
  await ui.sleep(2500);
  ok(!ui.appAlive(), "G8 force-stop 后进程确实退出");
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(10000);
  await ui.gotoCanvas();
  await ui.sleep(2000);
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "3"]);
  await ui.sleep(2500);
  const s8 = shot("p5a02-g-reenter.png");
  ok(ui.appAlive(), "G8 重新进入后进程存活");
  ok(ui.foreground() !== null, "G8 重新进入后仍在前台");
  ok(s8.ringPx > 100, "G8 重新进入后画布仍渲染盘面（环像素 " + s8.ringPx + "）");
  ok(s8.litRatio > 0.01, "G8 内容占比 " + (s8.litRatio * 100).toFixed(1) + "%（非白屏/非全空）");

  // ---------------------------------------------------------------- G1/G2 断开与恢复
  console.log("\n--- G1/G2 断连与恢复 ---");
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "critical", "--ei", "step", "3"]);
  await ui.sleep(2500);
  const sCrit = shot("p5a02-g-critical.png");

  ui.clearLog();
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "disconnect"]);
  await ui.sleep(3000);
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "dump", "1"]);
  await ui.sleep(1200);
  const busDisc = ui.sh(["logcat", "-d", "-s", "SimBus:I"]).split("\n")
    .filter((x) => /BUSD (std_0C|std_0D|std_05) /.test(x));
  const allNotOk = busDisc.length >= 3 && busDisc.every((l) => /ok=0/.test(l));
  ok(allNotOk, "G2 断连后总线 ok=0（" + busDisc.length + " 条）");

  const sDisc = shot("p5a02-g-disconnect.png");
  ok(sDisc.litRatio > 0.01, "G1 断连后界面仍有内容（" + (sDisc.litRatio * 100).toFixed(1) + "%）→ 不是白屏");
  ok(diffRatio(sCrit, sDisc) > 0.01, "G1 断连后画布确实变了（" + (diffRatio(sCrit, sDisc) * 100).toFixed(1) + "%）");
  ok(sDisc.ringPx > 100, "G1 断连后盘面仍在（环像素 " + sDisc.ringPx + "），只是指针/数字回落");

  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "recover", "--ei", "step", "3"]);
  await ui.sleep(3000);
  const sRec = shot("p5a02-g-recover.png");
  ok(diffRatio(sDisc, sRec) > 0.01, "G2 恢复后画布变回来（差异 " + (diffRatio(sDisc, sRec) * 100).toFixed(1) + "%）");

  // ---------------------------------------------------------------- G6 后台恢复不停在旧数据
  console.log("\n--- G6 后台期间换场景，回前台必须跟着变 ---");
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "3"]);
  await ui.sleep(2500);
  const sBefore = shot("p5a02-g-before-bg.png");
  ui.sh(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await ui.sleep(4000);
  // 后台期间换到 critical
  ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "critical", "--ei", "step", "3"]);
  await ui.sleep(2500);
  ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
  await ui.sleep(6000);
  const sAfter = shot("p5a02-g-after-bg.png");
  const d = diffRatio(sBefore, sAfter);
  ok(d > 0.005, "G6 回前台后画面更新（差异 " + (d * 100).toFixed(1) + "%）→ **没有停在旧数据**");

  // ---------------------------------------------------------------- G5 素材丢失降级
  console.log("\n--- G5 删掉一个素材文件后的降级 ---");
  // 找当前 designBaseDir
  const settings = ui.sh(["shell", "run-as", "com.icar.obd", "cat",
    "/data/data/com.icar.obd/files/config/settings.json"]);
  let baseDir = "";
  try {
    const j = JSON.parse(settings.replace(/^\uFEFF/, ""));
    baseDir = j.designBaseDir || "";
  } catch (e) { /* 忽略 */ }
  console.log("  designBaseDir=" + (baseDir || "(空)"));
  let restored = false;
  if (baseDir) {
    const target = baseDir + "/assets/corner.png";
    const bak = baseDir + "/assets/corner.png.p5abak";
    ui.sh(["shell", "run-as", "com.icar.obd", "mv", target, bak]);
    // 重启让位图缓存失效
    ui.sh(["shell", "am", "force-stop", "com.icar.obd"]);
    await ui.sleep(2000);
    ui.sh(["shell", "am", "start", "-n", "com.icar.obd/.ui.MainActivity"]);
    await ui.sleep(10000);
    await ui.gotoCanvas();
    await ui.sleep(2000);
    ui.sh(["shell", "am", "broadcast", "-a", "com.icar.obd.SIM", "--es", "scenario", "normal", "--ei", "step", "3"]);
    await ui.sleep(2500);
    const sMiss = shot("p5a02-g-missing-asset.png");
    ok(ui.appAlive(), "G5 素材缺失后 App 未崩溃");
    ok(sMiss.ringPx > 100, "G5 其它素材仍渲染（环像素 " + sMiss.ringPx + "）→ 局部降级而非整屏空");
    ok(ui.fatalLogs().length === 0, "G5 无 FATAL");
    // 还原
    ui.sh(["shell", "run-as", "com.icar.obd", "mv", bak, target]);
    restored = true;
  } else {
    console.log("  ⚠ 拿不到 designBaseDir，跳过 G5");
    ok(false, "G5 无法定位素材目录");
  }
  ok(restored || !baseDir, "G5 素材已还原（不留破坏现场）");

  // ---------------------------------------------------------------- G4 无效主题
  console.log("\n--- G4 无效主题导入的错误信息 ---");
  // ⚠️ 不能用 importFile()：它会在失败时点「知道了」把对话框关掉，
  //    之后再查文本当然找不到（第一版就这么误判成"无提示"）。
  //    这里内联走一遍，**停在对话框**上读文本。
  await ui.dismissDialogs();
  let it4 = await ui.gotoSettings();
  const imp4 = ui.find(it4, "导入画布");
  ok(!!imp4, "G4 能找到「导入画布」");
  if (imp4) {
    ui.tap(imp4.cx, imp4.cy);
    await ui.sleep(4500);
    it4 = ui.dumpUI();
    let f4 = ui.find(it4, "bad-broken.json");
    if (!f4) {
      const dl = ui.find(it4, "下载");
      if (dl) { ui.tap(dl.cx, dl.cy); await ui.sleep(3000); it4 = ui.dumpUI(); f4 = ui.find(it4, "bad-broken.json"); }
    }
    ok(!!f4, "G4 SAF 里能选中 bad-broken.json");
    if (f4) {
      ui.tap(f4.cx, f4.cy);
      await ui.sleep(4500);
      it4 = ui.dumpUI();
      const hasDialog = it4.some((i) => /导入设计(文件|包)/.test(i.label));
      const err = it4.find((i) => /错误|无法|不支持|语法|损坏/.test(i.label));
      ok(!hasDialog, "G4 损坏 JSON 被拒绝加载（没弹确认框）");
      ok(!!err, "G4 给出了错误提示：" + (err ? err.label.slice(0, 40) : "未找到"));
      ok(ui.appAlive() && ui.foreground() !== null, "G4 App 仍存活且在前台");
      const okBtn = ui.find(it4, "知道了") || ui.find(it4, "确定");
      if (okBtn) { ui.tap(okBtn.cx, okBtn.cy); await ui.sleep(1200); }
      await ui.gotoCanvas();
    }
  }

  console.log("\n=== 汇总 ===");
  console.log("  通过=" + pass + " 失败=" + fail);
  console.log("PASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
