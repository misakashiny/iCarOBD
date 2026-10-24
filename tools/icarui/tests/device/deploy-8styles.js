// ============================================================================
// deploy-8styles.js —— 把 8 档样式主题部署成 App 当前主题（P5B-M01 阶段 C）
//
// ## 为什么这么做
//
// App 的设计文件存在 `files/design/<ts>/design.json`，当前生效的那份同时
// 缓存在 `files/config/settings.json` 的 `designJson` 字段里。
// 走 SAF 文件选择器导入不稳定（系统 UI 不好自动点），所以直接写文件：
//   1. 建新时间戳目录，写 design.json + manifest.json
//   2. 备份 settings.json → settings.json.p5b01bak
//   3. 改 designBaseDir / designJson 指向新主题
//   4. 重启 App
//
// ⚠️ 操作前**备份**；跑完可 `node deploy-8styles.js restore` 还原，
//    不破坏用户已存的主题。
//
// ## 这里踩过的坑（写下来省得下次再试）
//
//   1. `run-as ... cp /sdcard/...` → `cp: bad ...: Permission denied`
//      （SELinux：run-as 的 uid 没有 sdcard 读权限）
//   2. `execFileSync(adb, ['-s',S,'shell','run-as',P,'sh','-c','echo x > f'])`
//      → 参数被 adb 逐层拆分，重定向落到错的地方 → `No such file`
//   3. `/data/user/0/...` 是符号链接，run-as 下 open 会被拒
//
//   ✅ 可行方式：**把整条 shell 命令作为单个字符串**传给 adb shell
//      `adb shell "run-as P sh -c '... > 相对路径'"`
//      相对路径基于 run-as 的 cwd（= /data/user/0/<pkg>）
// ============================================================================
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
// P5B-M04：可由命令行指定主题文件（默认仍是 8 档测试主题）
//   node deploy-8styles.js v3-full.json
const THEME_NAME = process.argv[2] && process.argv[2] !== "restore"
  ? process.argv[2] : "p5b01-8styles.json";
const THEME = path.join(ROOT, "docs", "02_验证记录", "android-theme", THEME_NAME);

/** 普通 adb 调用（无 shell 引号问题） */
function adb(args) {
  return execFileSync(ADB, ["-s", SERIAL].concat(args), {
    encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
}
/** 整条 shell 命令字符串（★ 关键：不要拆成多个 argv） */
function shell(cmd) {
  return execFileSync(ADB, ["-s", SERIAL, "shell", cmd], {
    encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
}
/** 以 run-as 身份执行一段 sh 脚本（整条字符串） */
function asApp(script) {
  return shell("run-as " + PKG + " sh -c '" + script.replace(/'/g, "'\\''") + "'");
}
/**
 * 把文本写进 App 私有目录。
 *
 * ## ⚠️ P5B-M04 修的真实缺陷：`ENAMETOOLONG`
 *
 * 原来是 `asApp("echo " + base64 + " | base64 -d > " + relPath)` ——
 * 整份 base64 作为**一个命令行参数**传给 adb。主题超过几十 KB 时，
 * Windows 命令行长度上限（约 32K）被突破，实测报：
 *
 *     Error: spawnSync adb.exe ENAMETOOLONG
 *     spawnargs: [..., "run-as com.icar.obd sh -c 'echo ewogIC...'"]
 *
 * 症状是"部署脚本崩了"，而 8 档小主题（~15KB）不会触发 —— 所以一直没暴露。
 * 但 v3 模板（40 个 Shape / 20 节点）一上就炸。
 *
 * ## 修法：走 `adb push` + `cat` 拼接
 *
 * push 是文件传输，不受命令行长度限制。分块 push 后 `cat` 拼成目标文件，
 * 再用 `mv` 原子替换 —— 避免 App 在写入过程中读到半个文件。
 */
function writeInto(relPath, text) {
  const buf = Buffer.from(text, "utf8");
  const REMOTE_DIR = "/data/local/tmp/_p5b04_push";

  shell("rm -rf " + REMOTE_DIR + " && mkdir -p " + REMOTE_DIR);

  // 分块 push（每块 64KB，远低于任何上限）
  const CHUNK = 64 * 1024;
  const nChunks = Math.max(1, Math.ceil(buf.length / CHUNK));
  const localDir = path.join(os.tmpdir(), "p5b04_push_" + Date.now());
  fs.mkdirSync(localDir, { recursive: true });

  const parts = [];
  for (let i = 0; i < nChunks; i++) {
    const slice = buf.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
    const lp = path.join(localDir, "part" + i);
    fs.writeFileSync(lp, slice);
    const rp = REMOTE_DIR + "/part" + i;
    adb(["push", lp, rp]);
    parts.push(rp);
  }

  // cat 拼接 → 目标路径（先写到 .tmp 再 mv，原子替换）
  const tmpRel = relPath + ".p5b04tmp";
  asApp("cat " + parts.join(" ") + " > " + tmpRel + " && mv " + tmpRel + " " + relPath);
  shell("rm -rf " + REMOTE_DIR);
  try { fs.rmSync(localDir, { recursive: true, force: true }); } catch (e) { }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mode = process.argv[2] || "deploy";

  if (mode === "restore") {
    asApp("cp files/config/settings.json.p5b01bak files/config/settings.json");
    shell("am force-stop " + PKG);
    await sleep(1200);
    shell("am start -n " + PKG + "/.ui.MainActivity");
    console.log("已从备份恢复 settings.json 并重启 App");
    return;
  }

  const design = JSON.parse(fs.readFileSync(THEME, "utf8"));
  const designText = JSON.stringify(design, null, 2);
  const ts = Date.now();

  // ---- 读现有 settings（去 BOM）
  const raw = asApp("cat files/config/settings.json");
  const settings = JSON.parse(raw.replace(/^\uFEFF/, ""));
  const prevDir = settings.designBaseDir || "";

  // ---- 备份（只备一次，别把备份覆盖成测试内容）
  try {
    asApp("ls files/config/settings.json.p5b01bak");
    console.log("  备份已存在，保留原备份");
  } catch (e) {
    asApp("cp files/config/settings.json files/config/settings.json.p5b01bak");
    console.log("  已备份 settings.json → settings.json.p5b01bak");
  }

  // ---- 建目录 + 写 design.json / manifest.json
  const dir = "files/design/" + ts;
  asApp("mkdir -p " + dir);
  writeInto(dir + "/design.json", designText);
  writeInto(dir + "/manifest.json", JSON.stringify({
    format: "icar.pack/1",
    designSchema: "icar.ui/2",
    designName: design.meta.name,
    exportedAt: new Date().toISOString(),
    design: { name: design.meta.name, schema: "icar.ui/2" },
    assets: [],
    missing: [],
  }, null, 2));

  const chk = asApp("ls -l " + dir);
  console.log("  主题目录 " + dir + "：\n    " + chk.trim().split("\n").join("\n    "));

  // ---- 改 settings
  //
  // ⚠️ **P5B-M02 §F 查明上次失败的真因**：
  //    `settings.designJson` 只是**顶层实时字段**，而 App 渲染用的是
  //    `Store.activeCanvas()` → `settings.canvases[activeCanvasId].designJson`。
  //    上次只改了顶层的 designJson，画布里的那份没动 → **渲染仍用旧画布**，
  //    所以"写入成功但截图不变"。
  //
  //    正确做法：**两处都改**（顶层实时字段 + activeCanvas 里的那份）。
  //    见 Store.kt:655 activeCanvas() 与 :675 snapshotToActiveCanvas()。
  settings.designBaseDir = "/data/user/0/" + PKG + "/" + dir;
  settings.designJson = designText;

  let painted = 0;
  if (Array.isArray(settings.canvases)) {
    const idx = settings.canvases.findIndex((c) => c && c.id === settings.activeCanvasId);
    const target = idx >= 0 ? settings.canvases[idx] : (settings.canvases[0] || null);
    if (target) {
      target.designJson = designText;      // ← 关键：画布自己那份
      target.type = 2;                     // TYPE_CUSTOM
      target.name = design.meta.name;
      if (idx < 0) settings.activeCanvasId = target.id;
      painted = 1;
      console.log("  已写入 activeCanvas（" + (target.name || target.id) + "）的 designJson");
    }
  }
  if (!painted) {
    // 没有 canvases（老配置）→ 造一个
    settings.canvases = [{
      id: "p5b02-8styles",
      name: design.meta.name,
      type: 2,
      designJson: designText,
      gauges: [],
    }];
    settings.activeCanvasId = "p5b02-8styles";
    painted = 1;
    console.log("  配置里没有 canvases → 新建一套并设为 active");
  }
  settings.dashType = 2;                   // 0 普通 / 1 性能 / 2 自定义

  writeInto("files/config/settings.json", JSON.stringify(settings, null, 2));

  // ---- 校验写进去的内容真的是完整 JSON
  //
  // ⚠️ P5B-M04：原来是写死 `gaugeCount === 8`（只适合 8 档测试主题）。
  //    改成**通用校验**：比 schema 与节点数是否与源文件一致，
  //    并对 v3 主题额外核对四种基元节点数量。
  const back = asApp("cat files/config/settings.json");
  let okJson = false, gaugeCount = 0;
  let detail = "";
  try {
    const j = JSON.parse(back.replace(/^\uFEFF/, ""));
    const dj = JSON.parse(j.designJson);
    // 两种形态都支持：编辑器导出的是**顶层 nodes**，旧文件可能是 pages[0].nodes
    const nodes = (dj.pages && dj.pages[0] && dj.pages[0].nodes) || dj.nodes || [];
    const srcNodes = (design.pages && design.pages[0] && design.pages[0].nodes) || design.nodes || [];

    gaugeCount = nodes.filter((n) => n.type === "gauge").length;

    const V3_TYPES = ["valueText", "shape", "segmentedArc", "pathProgress"];
    const primCount = nodes.filter((n) => V3_TYPES.includes(n.type)).length;
    const srcPrim = srcNodes.filter((n) => V3_TYPES.includes(n.type)).length;

    okJson = dj.schema === design.schema && nodes.length === srcNodes.length;
    if (srcPrim > 0) okJson = okJson && primCount === srcPrim;

    detail = "  schema=" + dj.schema + "  节点=" + nodes.length + "/" + srcNodes.length;
    if (srcPrim > 0) detail += "  基元=" + primCount + "/" + srcPrim;
  } catch (e) {
    detail = "  （解析失败：" + e.message + "）";
  }
  console.log("  回读校验：一致=" + okJson + "  gauge 数=" + gaugeCount + detail);

  // ---- 重启 App
  shell("am force-stop " + PKG);
  await sleep(1500);
  shell("am start -n " + PKG + "/.ui.MainActivity");
  await sleep(10000);

  console.log("\n部署完成");
  console.log("  新主题目录: " + dir);
  console.log("  原主题目录: " + prevDir);
  console.log("  还原:       node " + path.relative(ROOT, __filename) + " restore");
  if (!okJson) process.exitCode = 1;
})();
