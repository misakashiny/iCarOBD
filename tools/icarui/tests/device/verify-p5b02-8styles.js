// P5B-M02 §F：八样式主题 Android 渲染验证 + 截图留证
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const SHOT = path.join(ROOT, "docs", "02_验证记录", "screenshots");
const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const sh = (c) => execFileSync(ADB, ["-s", "emulator-5554", "shell", c], { encoding: "utf8", maxBuffer: 1 << 26 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

(async () => {
  const out = [];
  const log = (s) => { console.log(s); out.push(s); };

  log("=== P5B-M02 §F：八样式主题 Android 渲染验证 ===");
  log("");
  log("## 前两轮为什么没跑通");
  log("");
  log("P5B-M01 尝试过但失败：主题文件**成功写入** settings.designJson，回读校验 gauge 数=8，");
  log("但 App 截图**一点没变**（24860 B，颜色数 198）。");
  log("");
  log("**P5B-M02 §F 查明的真因**（Store.kt:655 `activeCanvas()`）：");
  log("  App 渲染的不是 `settings.designJson`，而是");
  log("  `settings.canvases[activeCanvasId].designJson` —— **画布自己那份**。");
  log("  上次只改了顶层实时字段，画布里的没动 → 渲染仍用旧画布。");
  log("");
  log("## 修法");
  log("  同时写两处：settings.designJson（顶层实时字段）+ activeCanvas.designJson（画布）。");
  log("");

  // ---------------------------------------------------------------- 验证 8 档可见
  log("=== F1. 8 档标签在 Android 上全部可见 ===");
  sh("uiautomator dump /sdcard/_f1.xml");
  const xml = sh("cat /sdcard/_f1.xml");
  const texts = [...xml.matchAll(/text="([^"]{1,30})"/g)].map((m) => m[1]).filter((t) => t.trim());
  const WANT = ["0 圆盘", "1 数字", "2 条形", "3 折线", "4 双叠", "5 四联", "6 子双", "7 G力"];
  let found = 0;
  WANT.forEach((k) => {
    const has = texts.includes(k);
    if (has) found++;
    ok(has, "F1 可见「" + k + "」");
  });
  log("  → " + found + "/8 可见");
  ok(texts.includes("P5B-M01 八档样式对比"), "F1 页面标题显示主题名（证明主题真的加载了）");

  // ---------------------------------------------------------------- F2 截图证据
  log("");
  log("=== F2. 截图留证 ===");
  sh("screencap -p /sdcard/_f2.png");
  const dst = path.join(SHOT, "p5b02-android-8styles.png");
  execFileSync(ADB, ["-s", "emulator-5554", "pull", "/sdcard/_f2.png", dst], { encoding: "utf8" });
  const sz = fs.statSync(dst).size;
  ok(sz > 100000, "F2 截图已保存（" + sz + " B，对比 P5B-M01 失败的 24860 B 明显有内容）");

  // ---------------------------------------------------------------- F3 像素对比
  log("");
  log("=== F3. 像素统计（对比 P5B-M01 的失败截图）===");
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${dst.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap $img
$colors = @{}
for($y=0; $y -lt $bmp.Height; $y+=8){
  for($x=0; $x -lt $bmp.Width; $x+=8){
    $c = $bmp.GetPixel($x,$y)
    $key = "$($c.R),$($c.G),$($c.B)"
    if($colors.ContainsKey($key)){ $colors[$key]++ } else { $colors[$key]=1 }
  }
}
Write-Output ("尺寸=" + $img.Width + "x" + $img.Height + "  颜色数=" + $colors.Count)
$bmp.Dispose(); $img.Dispose()
`;
  const pf = path.join(require("os").tmpdir(), "f3.ps1");
  fs.writeFileSync(pf, "\uFEFF" + ps, "utf8");
  const stat = execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", pf], { encoding: "utf8" }).trim();
  log("  " + stat);
  const colorCount = +(stat.match(/颜色数=(\d+)/) || [])[1];
  ok(colorCount > 250, "F3 颜色数 " + colorCount + " > P5B-M01 时的 198（画面确实丰富）");

  // ---------------------------------------------------------------- F4 底部导航可见
  log("");
  log("=== F4. 主题已生效的其他旁证 ===");
  // ⚠️ 不能断言"底部导航可见" —— 仪表盘页会**主动收起导航**（P5A-M06 查明的沉浸式设计，
//    applySystemStatusBar("dash") → setRailVisible(false)）。所以这里改成断言
//    "画面是仪表盘页"：既没有导航、也没有连接页的控件，且标题是主题名。
    ok(!/扫描设备|初始化 ELM327|1\. 选择设备/.test(texts.join("")),
       "F4 当前不是连接页（是仪表盘页，导航被沉浸式收起属预期）");
  const pid = sh("pidof com.icar.obd").trim();
  ok(pid !== "", "F4 App 进程存活（pid=" + pid + "）");
  const crash = sh("logcat -d -b crash").trim();
  ok(!/FATAL EXCEPTION/.test(crash), "F4 crash buffer 无 FATAL");

  log("");
  log("=== 汇总 ===");
  log("通过=" + pass + " 失败=" + fail);
  log("PASS=" + pass + " FAIL=" + fail);
  log("");
  log("⚠️ 层级：Android 模拟器。不代表真机（尤其车载宽屏）表现。");
  fs.writeFileSync(path.join(SHOT, "p5b02-8styles-result.txt"), out.join("\n"), "utf8");

  console.log("\nPASS=" + pass + " FAIL=" + fail);
  process.exitCode = fail ? 1 : 0;
})();
