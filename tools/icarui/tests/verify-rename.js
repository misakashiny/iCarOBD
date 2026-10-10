/* ==========================================================================
   verify-rename.js —— 「工具叫 ICarUI」这件事的守卫（v2.83.0 新建）
   --------------------------------------------------------------------------
   ## 为什么值得一个套件

   改名是**一次性的机械操作**，但它有两个特点让它特别容易烂：

   1. **改一处忘一处是静默的** —— 少改一个 `tools/theme-studio` 路径，
      表现是"某个脚本找不到测试目录"或"某份文档指到不存在的目录"，
      而不是任何一处报错。跑全套也不会红。
   2. **它会被慢慢改回去** —— 后来的人复制粘贴老文档里的路径，
      新文件就又把旧名字带回来了。**没有守卫的话没人会知道。**

   ## 它同时把「app/ 还没同步」这件事变成可见的（v1.20.19 起已同步完）

   改名的范围原本被限定在 `tools/**` + 相关文档，`app/` 明确不动。
   当时 `app/` 里有 8 个文件引用了旧路径 —— 其中
   `app/src/test/.../ThemeStudioSampleTest.kt` 是**功能性的**：
   它按旧目录名找 `sample.json`，找不到就 `assumeTrue` **跳过**（不报错）。
   也就是说改名之后那些用例会**安静地不跑**。

   ⚠️ 当时这份台账把数字记成 **12**，实测是 **14**（`skipped=14`）——
   "记账"这件事本身也会错，只有真跑一次才知道。

   v1.20.19 把 app/ 那 8 个文件全部同步了，并且把 `assumeTrue` 换成**硬失败**：
   找不到样例文件就红。本套件因此从"台账"升级成**零容忍守卫** ——
   `app/` 里再出现任何一处旧路径即失败，不需要谁记得。

   跑法：node tools/icarui/tests/verify-rename.js
   ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const STUDIO = path.join(ROOT, "tools", "icarui");
const OLD_DIR = path.join(ROOT, "tools", "theme-studio");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg); }
}
function eq(a, b, msg) {
  ok(a === b, msg + (a === b ? "" : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));
}
const read = p => fs.readFileSync(p, "utf8");

/** 递归列出某目录下的文本文件（跳过 node_modules/.git/assets 二进制） */
function walk(dir, out) {
  out = out || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "assets") continue;
      walk(full, out);
    } else if (/\.(js|md|html|css|json|ps1)$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 历史日志 —— 旧名字在这里是**历史事实**，允许保留 */
const HISTORY = new Set([
  path.join(STUDIO, "CHANGELOG.md"),
  path.join(ROOT, "docs", "CHANGELOG.md"),
  path.join(ROOT, "docs", "迭代清单.md"),
  // 本文件自己：断言的就是"旧名字不该出现"，字面量必须写出来。
  // （同 check-build-guard.ps1 把自己排除在破折号检查外）
  __filename,
]);

/** **引用**旧路径、而不是**用**旧路径的地方。
    ⚠️ 每加一条都要写清理由 —— 这张表不是"懒得改"的收容所。 */
const QUOTES_OLD_PATH = new Map([
  [path.join(ROOT, "docs", "下一步-全量文档迭代.md"),
    "收尾任务计划书，正文说的是「改名后 tools/theme-studio/ 的引用要全部更新」——" +
    "旧路径在这里是被**清理的对象**，不是过期引用（app/ 那 8 处就是它要清的）"],
]);

// ⚠️ 原来这里有一张 `APP_LEDGER`（app/ 侧 8 个文件的旧引用台账，"台账内放行"）。
// v1.20.19 app/ 全部同步完之后**删掉了** —— 留一张空表就是留一个"以后可以往里塞"的收容所，
// 而第 8 节现在是零容忍：app/ 里出现任何一处旧路径即失败。

console.log("=== 1. 目录改名到位 ===");
ok(fs.existsSync(STUDIO), "tools/icarui/ 存在");
ok(!fs.existsSync(OLD_DIR), "tools/theme-studio/ **不存在**（不能留一个空壳目录，否则两份权威）");

console.log("\n=== 2. 界面标题是 ICarUI ===");
const html = read(path.join(STUDIO, "index.html"));
const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
eq(title, "ICarUI", "<title> 就是 ICarUI");
const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || "";
ok(h1.indexOf("ICarUI") === 0, `<h1> 以 ICarUI 开头（实际 ${JSON.stringify(h1.slice(0, 40))}）`);
ok(!/iCar OBD · 主题制作/.test(html), "index.html 里没有残留的旧标题「iCar OBD · 主题制作」");

console.log("\n=== 3. README / CHANGELOG 的当前称呼 ===");
const readme = read(path.join(STUDIO, "README.md"));
ok(/^# ICarUI\b/.test(readme), "README.md 的一级标题以 ICarUI 开头");
const clog = read(path.join(STUDIO, "CHANGELOG.md"));
ok(/^# ICarUI\b/.test(clog), "CHANGELOG.md 的一级标题以 ICarUI 开头");
ok(clog.indexOf("原称 theme-studio") >= 0, "CHANGELOG 里写明了「原称 theme-studio」（改名可追溯）");

console.log("\n=== 4. tools/ 与 docs/ 里不再有旧路径（历史日志除外）===");
{
  const scopes = [path.join(ROOT, "tools"), path.join(ROOT, "docs")];
  const bad = [];
  scopes.forEach(scope => {
    walk(scope).forEach(f => {
      if (HISTORY.has(f) || QUOTES_OLD_PATH.has(f)) return;
      if (f.indexOf(path.join("tools", "icarui", "assets")) === 0) return;
      const t = read(f);
      if (t.indexOf("theme-studio") < 0) return;
      // ⚠️ **逐行判**，不是"整份文件有就算"。
      //
      // 改名这件事本身要能被追溯 —— 文档里写一句「原称 theme-studio」是**记录**，
      // 不是过期引用。区别很好判：记录那一行会带「原称 / 改名 / 旧名 / 历史」，
      // 而过期引用是「见 `tools/theme-studio/README.md`」这种。
      // 所以规则是：**只有明确写着这是旧名字的那一行才放行**。
      // （整文件放行会让这两份文档变成收容所 —— 以后谁都能往里塞过期路径。）
      const badLines = [];
      t.split(/\r?\n/).forEach((L, i) => {
        if (L.indexOf("theme-studio") < 0) return;
        if (/原称|改名|旧名|历史/.test(L)) return;
        badLines.push(":" + (i + 1) + " " + L.trim().slice(0, 70));
      });
      if (badLines.length) {
        bad.push(path.relative(ROOT, f).replace(/\\/g, "/") + " ×" + badLines.length + "  " + badLines[0]);
      }
    });
  });
  if (bad.length) bad.forEach(b => console.log("       ↳ " + b));
  ok(bad.length === 0, `tools/ + docs/ 里除历史日志与**改名记录行**外没有 theme-studio 字面量（剩 ${bad.length} 个文件）`);
  if (QUOTES_OLD_PATH.size) {
    QUOTES_OLD_PATH.forEach((why, f) =>
      console.log("       ℹ️ 已放行的**引用**：" + path.relative(ROOT, f).replace(/\\/g, "/") + " —— " + why));
  }
}

console.log("\n=== 5. 引用工具路径的脚本都指到新目录 ===");
[
  ["tools/run-browser-tests.ps1", /tools\\icarui\\tests/],
  ["tools/check-build-guard.ps1", /tools\\icarui/],
  ["tools/guard-pid-probe.js", /['"]icarui['"]/],
  ["tools/guard-color-probe.js", /'icarui'/],
  ["tools/icarui/tests/verify-crosslang.js", /"tools",\s*"icarui"/],
].forEach(([rel, re]) => {
  const p = path.join(ROOT, rel);
  ok(fs.existsSync(p), rel + " 存在");
  if (fs.existsSync(p)) ok(re.test(read(p)), rel + " 指向 tools/icarui");
});

console.log("\n=== 6. 改名**没有**动到格式 id 与 App 侧读的字段 ===");
{
  const pack = read(path.join(STUDIO, "js", "pack.js"));
  ok(pack.indexOf("icar.pack/1") >= 0, "设计包格式 id 仍是 icar.pack/1（**格式 id 不是工具名**，改了会让旧包被拒收）");
  const schema = read(path.join(STUDIO, "js", "schema.js"));
  ok(schema.indexOf("icar.ui/1") >= 0 && schema.indexOf("icar.ui/2") >= 0, "设计文件 schema id 仍是 icar.ui/1 + icar.ui/2");
  const kotlin = read(path.join(ROOT, "app/src/main/java/com/icar/obd/data/DesignPack.kt"));
  ok(kotlin.indexOf("icar.pack/1") >= 0, "App 侧 DesignPack.kt 里的 icar.pack/1 未被动过");
}

console.log("\n=== 7. 零安装形态没被破坏 ===");
ok(!fs.existsSync(path.join(STUDIO, "package.json")), "icarui 目录下没有 package.json");
ok(!fs.existsSync(path.join(STUDIO, "node_modules")), "icarui 目录下没有 node_modules");
{
  const srcs = [];
  const re = /<script[^>]*src="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  ok(srcs.length > 0, `index.html 有 ${srcs.length} 个 <script src>`);
  ok(srcs.every(s => fs.existsSync(path.join(STUDIO, s))), "每个 <script src> 都在磁盘上（改名后相对路径没断）");
  ok(srcs.every(s => !/^https?:|^\/\//i.test(s)), "没有一个外部脚本");
  const links = [];
  const re2 = /<link[^>]*href="([^"]+)"/g;
  while ((m = re2.exec(html))) links.push(m[1]);
  ok(links.every(s => fs.existsSync(path.join(STUDIO, s))), "每个 <link href> 都在磁盘上（css/studio.css 没断）");
}

console.log("\n=== 8. app/ 侧旧路径台账（本次范围外，只记账不修）===");
{
  const appDir = path.join(ROOT, "app");
  const found = [];
  if (fs.existsSync(appDir)) {
    const walkAll = d => {
      const out = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "build" && e.name !== ".gradle") out.push(...walkAll(full)); }
        else if (/\.(kt|java|xml|gradle|kts)$/i.test(e.name)) out.push(full);
      }
      return out;
    };
    walkAll(appDir).forEach(f => {
      if (read(f).indexOf("theme-studio") >= 0) found.push(path.relative(ROOT, f).replace(/\\/g, "/"));
    });
  }
  // ⚠️ 这里原来是「台账内放行、只拦新出现的」。台账（8 个文件）在 v1.20.19 清零，
  //    所以现在**一处都不许有** —— 改名这件事从此不需要人记着。
  if (found.length) found.forEach(f => console.log("       ↳ " + f));
  ok(found.length === 0, `app/ 里没有旧路径引用（剩 ${found.length} 个）`);

  // 顺手守住"那个静默跳过的坑"已经补上：找不到样例必须**失败**，不能再 Assume 跳过。
  // 这条不是多余的 —— 路径被改回去时，Assume 版本的失效形态是"套件全绿、用例不跑"。
  const sampleTest = path.join(appDir, "src/test/java/com/icar/obd/data/ThemeStudioSampleTest.kt");
  ok(fs.existsSync(sampleTest), "ThemeStudioSampleTest.kt 还在（这个类守的是跨语言契约）");
  if (fs.existsSync(sampleTest)) {
    const t = read(sampleTest);
    ok(t.indexOf("tools/icarui/sample.json") >= 0, "ThemeStudioSampleTest 按 tools/icarui/sample.json 找样例");
    // ⚠️ 判的是**代码**，不是整份文件：这个类的注释里**故意**写着
    //    「原来用 Assume 跳过、后来改成硬失败」—— 那是历史记录，不是用法。
    //    直接对全文 indexOf 会把注释也算成用法（第一版就这么误报了一次）。
    const codeOnly = t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    ok(codeOnly.indexOf("assumeTrue") < 0 && codeOnly.indexOf("org.junit.Assume") < 0,
      "ThemeStudioSampleTest 的**代码**里没有 Assume 静默跳过（找不到样例文件必须失败）");
  }
}

console.log("\n" + "=".repeat(60));
console.log("PASS=" + pass + "  FAIL=" + fail);
process.exit(fail === 0 ? 0 : 1);
