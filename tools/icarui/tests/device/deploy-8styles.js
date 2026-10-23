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
const { execFileSync } = require("child_process");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const SERIAL = "emulator-5554";
const PKG = "com.icar.obd";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const THEME = path.join(ROOT, "docs", "02_验证记录", "android-theme", "p5b01-8styles.json");

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
/** 把文本写进 App 私有目录（base64 走管道，避开所有转义/权限坑） */
function writeInto(relPath, text) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  asApp("echo " + b64 + " | base64 -d > " + relPath);
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
  settings.designBaseDir = "/data/user/0/" + PKG + "/" + dir;
  settings.designJson = designText;
  writeInto("files/config/settings.json", JSON.stringify(settings, null, 2));

  // ---- 校验写进去的内容真的是完整 JSON
  const back = asApp("cat files/config/settings.json");
  let okJson = false, gaugeCount = 0;
  try {
    const j = JSON.parse(back.replace(/^\uFEFF/, ""));
    const dj = JSON.parse(j.designJson);
    gaugeCount = (dj.pages[0].nodes || []).filter((n) => n.type === "gauge").length;
    okJson = gaugeCount === 8;
  } catch (e) { /* 留给下面报错 */ }
  console.log("  回读校验：designJson 可解析=" + okJson + "  gauge 数=" + gaugeCount);

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
