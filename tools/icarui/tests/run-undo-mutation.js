/* ============================================================================
   run-undo-mutation.js —— 撤销恢复的**反向验证入口**（T5-R 引入；T5-R2 扩成
   "每个保护点独立关闭"，仍未发版）

   ## 为什么需要它（以及它不是什么）

   T5-A 的反向验证入口原本只在规划方的 `stage/t5a-mutation/run-mutation.js` 里
   —— 而 `stage/` 是 **gitignore** 的。也就是说：**另一个用户从干净检出复现不了
   那条命令**，"反向验证"实际上只有原作者机器上跑过一次。
   R3 验收要求把它变成**纳入仓库的可复现入口**，所以有了这个脚本。

   ⚠️ 它**不是**测试框架、也**不是** `verify-*.js` 套件：
   `run-browser-tests.ps1` 只收 `verify-*.js`，所以这份文件不会被当成一个套件
   自动跑（也就不会给断言基线添乱）。它只做一件事：**在一个临时副本里把
   某一处"数据保护"改回缺陷形态，再跑仓库当前那套断言，看它是否真的会红。**

   ## 模式

   | 命令 | 做什么 | 期望退出码 |
   |---|---|---|
   | `--current` | 原样跑（对照组） | **0**（全绿） |
   | `--head` | 用 `git show HEAD:…` 取**已提交的** app.js / model.js 覆盖副本再跑 | **非 0（预期红）** |
   | `--mutate=<名>` | **只**关掉某一个保护点（见下表） | **非 0（预期红）** |
   | （默认 `mutate`） | 一次关掉两处历史缺陷（T5-A 形态） | **非 0（预期红）** |

   ## ⚠️ T5-R2：为什么要"每个保护点独立关闭"

   规划方指出：默认模式的 16 条红**主要来自"缺 canvas 旧形态兼容"（4）和
   "整栈清空"（12）**，它不能冒充"游标 / 边界 / 事务回滚 / 校验这四处新增断言
   各自有效"。所以现在每个保护点**单独**有一个变异名，每次只关一处，
   其余保护**全部保留**：

   | `--mutate=` | 关掉哪一处保护 | 应当变红的断言类别 |
   |---|---|---|
   | `cursor` | `_relocate` 退回"删除前的数值下标"算法 | R1 游标：**游标不是当前记录对象**、下标/计数错位 |
   | `endpoint` | `undo()`/`redo()` 到端点时退回 `return null` | R1 边界：栈底/栈顶**清空有效历史**、误报"都坏了" |
   | `rollback` | `restore()` 去掉元数据表单与 dirty 提示条的还原 | R2 事务：**mName 停在 TARGET**、提示条内容变 |
   | `bar-events` | 提示条复原退回"序列化 HTML 再解析" | R2 事件：**按钮 onclick 丢成 null**、真实点击无效 |
   | `canvas-rollback` | 失败收尾里不按实际设计重画画布 | R3 像素：**画布停在候选那一帧** |
   | `anchor` | `anchorCurrent()` 直接返回 null（不补当前设计锚点） | R1 锚点：当前坏记录被摘后**游标不代表实际当前**、好历史不可达 |
   | `validate` | `validate-try` + `validate-budget` 两个一起关（组合名） | 下面两类一起红 |
   | `validate-budget` | 预算被改得**过低**（512→4 / 200000→1） | ⚠️ **"预算过低误拒合法设计"**，不是"取消预算"——见下面 §预算两刀 |
   | `budget-off` | 真正**取消**两层预算（改成 `Infinity`） | R2 校验：**深输入不再被拒绝**（判据放行） |
   | `validate-try` | 只把判据/解析移出 `restore` 的事务 `try` | ⚠️ **见下面的"够不到的一层"** |

   ## ⚠️ 预算有两刀，含义**相反**，不能混为一谈（T5-R3 纠正）

   规划方指出旧说明写反了：`validate-budget` 把 `NODE_DEPTH_LIMIT` 512→**4**、
   `NODE_SCAN_LIMIT` 200000→**1**，这是**把预算改得极低 = 误拒合法设计**，
   **不是**"关掉预算/有界检查失效"。它那 38 条红主要来自"既有好设计/合法 10 层
   被误拒"，只能证明"有界检查真的在挡东西、而且是明确拒绝不是静默放过"。

   真正"放宽/取消预算"是另一刀 **`budget-off`**（改成 `Infinity`）：那时
   **深/超量输入不再被拒绝**，必须命中 `verify-bugfix.js` 的
   "10000 层判据安全返回 false / 深快照被拒绝"那一类行为红 —— 那才叫
   "有界保护被独立关闭后真的会红"。两刀分开命名、分开报告。

   每一处都必须"命中"（找不到锚点 = 基础设施错误 3），否则就是"改了个无关的地方
   却以为变异成功了"。

   ## ⚠️ 够不到的一层：`snapshotProblem` 自己抛异常**没法用数据触发**

   `validate-try` 关掉的是"判据**自己**抛异常时 `restore` 兜住它"这一层。
   这一层**反向验证不出红**，原因是**结构性**的、不是断言没写：

   - 快照是**字符串**，`JSON.parse` 出来的必然是**纯数据** —— 纯数据上放不出
     "会抛的取值器"；
   - 判据已经改成**迭代 + 两层显式预算**，深/海量快照会被**安全拒绝**
     而不是爆栈 —— 所以连"引擎爆栈"这条现实路径也被预算挡在前面了。

   也就是说："判据抛"在真机输入下**不可确定性复现**。
   因此 `--mutate=validate-try` 会给出 **退出码 4 + 明确说明**，
   而不是假装它"预期红"。

   这一层是**纵深防御**（评审当初实测过 `nodeProblem` 递归爆栈；现在改成
   迭代 + 预算，并由 `verify-bugfix.js` 的"深快照判据安全返回 boolean /
   `restore` 返回 false / 合法深度不被误伤"守着）。
   **不声称它被独立反向验证覆盖** —— 报告与文档里都按这个口径写。

   ## 退出码约定（R3 验收明确要求区分）

   ```
   0   对照组通过（只有 --current 该出 0）
   1   套件按预期**失败**（变异/HEAD 模式下的"红"）
   2   用法错误
   3   基础设施错误：找不到文件 / git 失败 / 变异没命中 / 子进程**启动失败** /
       子进程被**信号**杀掉 / `status === null`（超时） / 套件崩了（没打印 PASS=/FAIL=）
       —— **这些绝不算"变异成功"**
   4   意外通过：变异以后套件仍然全绿 → 说明这套断言**没抓住**那处保护
   ```

   ## 🔴 基础设施错误必须先判（T5-R2 修正）

   `run.error`（spawn 失败）、`run.signal`（被信号杀）、`status === null`（超时）
   这三类**即使 stdout 里已经有部分 `PASS=`/`FAIL=`**（比如跑到一半超时），
   也必须归"基础设施错误"，**不得进入"预期红"**。
   旧写法只看最后一条摘要行的 `FAIL>0 && status!==0`，于是"十分钟超时被 SIGTERM"
   这种会把半截输出里的 `FAIL=12` 当成"变异成功"。
   现在：**先查 error/signal/status===null，再谈摘要**。

   ## 临时副本的清理（如实）

   脚本**没有**自动清理代码：每次都会在系统 temp 下**新建**一个隔离目录
   （`icarui-undo-mut-*`），不递归删除任何已有证据。需要清理时手工删。

   ## 用法

   ```
   node tools/icarui/tests/run-undo-mutation.js --current      # 对照组，期望 0
   node tools/icarui/tests/run-undo-mutation.js --mutate=cursor
   node tools/icarui/tests/run-undo-mutation.js --mutate=endpoint
   node tools/icarui/tests/run-undo-mutation.js --mutate=rollback
   node tools/icarui/tests/run-undo-mutation.js --mutate=bar-events
   node tools/icarui/tests/run-undo-mutation.js --mutate=canvas-rollback
   node tools/icarui/tests/run-undo-mutation.js --mutate=anchor
   node tools/icarui/tests/run-undo-mutation.js --mutate=validate
   node tools/icarui/tests/run-undo-mutation.js --mutate=validate-budget
   node tools/icarui/tests/run-undo-mutation.js --mutate=budget-off
   node tools/icarui/tests/run-undo-mutation.js                # 默认（两处历史缺陷）
   node tools/icarui/tests/run-undo-mutation.js --head         # 只作历史辅助
   ```
   ========================================================================== */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TESTS_DIR = __dirname;                       // tools/icarui/tests
const TOOL_DIR = path.resolve(TESTS_DIR, "..");    // tools/icarui
const REPO_ROOT = path.resolve(TOOL_DIR, "..", "..");
const SUITE = "verify-bugfix.js";

const EXIT_OK = 0;
const EXIT_SUITE_RED = 1;
const EXIT_USAGE = 2;
const EXIT_INFRA = 3;
const EXIT_UNEXPECTED_GREEN = 4;

function die(code, msg) {
  console.log("❌ " + msg);
  process.exit(code);
}

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
let mode = "mutate";
let mutation = null;                               // --mutate=<名>
if (argv.indexOf("--current") >= 0) mode = "current";
if (argv.indexOf("--head") >= 0) mode = "head";
for (const a of argv) {
  if (a === "--current" || a === "--head") continue;
  if (a.indexOf("--mutate=") === 0) { mode = "mutate"; mutation = a.slice("--mutate=".length); continue; }
  die(EXIT_USAGE, "不认识的参数：" + a +
    "\n  用法：node run-undo-mutation.js [--current|--head|--mutate=<cursor|endpoint|rollback|bar-events|canvas-rollback|anchor|validate|validate-budget|budget-off|validate-try>]");
}
if (argv.indexOf("--current") >= 0 && argv.indexOf("--head") >= 0) {
  die(EXIT_USAGE, "--current 与 --head 不能同时用（一个是「不改」，一个是「换成 HEAD」）");
}
if (mutation !== null && argv.indexOf("--current") >= 0) {
  die(EXIT_USAGE, "--current 与 --mutate= 不能同时用（一个不改、一个改）");
}

// ---------------------------------------------------------------- 1. 校验目标路径
//
// ⚠️ R3 验收要求"明确校验目标路径"。这里拒绝三种情况：
//   ① 不是在一个看起来像本仓库 tools/icarui 的目录里；
//   ② 关键文件缺任何一个；
//   ③ 临时目录落在工作区**之内**（那就不是"副本"了）。
const required = [
  path.join(TOOL_DIR, "index.html"),
  path.join(TOOL_DIR, "js", "app.js"),
  path.join(TOOL_DIR, "js", "model.js"),
  path.join(TESTS_DIR, SUITE),
];
for (const f of required) {
  if (!fs.existsSync(f)) die(EXIT_INFRA, "目标路径不存在：" + f);
}
if (path.basename(TOOL_DIR) !== "icarui") {
  die(EXIT_INFRA, "目标路径不像工具的根目录（期望 .../tools/icarui）：" + TOOL_DIR);
}
if (!fs.existsSync(path.join(REPO_ROOT, ".git"))) {
  die(EXIT_INFRA, "找不到仓库根（期望 " + REPO_ROOT + " 下有 .git）");
}

console.log("目标路径校验通过：");
console.log("  工具目录 " + TOOL_DIR);
console.log("  仓库根   " + REPO_ROOT);
console.log("  套件     " + path.join("tools", "icarui", "tests", SUITE));
console.log("  模式     " + mode + (mutation ? "（只关：" + mutation + "）" : ""));

// ---------------------------------------------------------------- 2. 新临时副本
//
// ⚠️ **绝不在工作区里改文件、绝不递归删除已有证据、绝不回退工作区**
//    （R3 验收明确禁止）。所以整份 `tools/icarui/` 复制到系统临时目录，
//    只在副本里动刀；**每次新建一个隔离目录**，不删旧的。
//    ⚠️ 本脚本**没有**自动清理代码 —— 别在文档里说"跑完就删"。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "icarui-undo-mut-"));
if (!tmpRoot.startsWith(os.tmpdir())) die(EXIT_INFRA, "临时目录不在系统 temp 下：" + tmpRoot);
const copy = path.join(tmpRoot, "icarui");
copyTree(TOOL_DIR, copy);
console.log("临时副本（**保留**，本脚本不自动清理）：" + copy);

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.lstatSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else if (st.isFile()) fs.copyFileSync(s, d);
  }
}

function read(p) { return fs.readFileSync(p, "utf8"); }
function write(p, s) { fs.writeFileSync(p, s, "utf8"); }

/** 在副本里做一次"必须命中"的文本替换；没命中就是基础设施错误 */
function mustReplace(file, oldText, newText, what) {
  const s = read(file);
  if (s.indexOf(oldText) < 0) {
    die(EXIT_INFRA, "变异【" + what + "】没命中：" + path.relative(copy, file) +
      " 里找不到锚点（源码改过？）");
  }
  if (s.split(oldText).length - 1 !== 1) {
    die(EXIT_INFRA, "变异【" + what + "】锚点不唯一：" + path.relative(copy, file));
  }
  write(file, s.replace(oldText, newText));
}

// ---------------------------------------------------------------- 3. 造"缺陷形态"
const 描述 = [];
const APP = path.join(copy, "js", "app.js");
const MODEL = path.join(copy, "js", "model.js");

if (mode === "head") {
  // 用已提交的版本覆盖副本（**不动工作区**：`git show` 只读）
  for (const rel of ["js/app.js", "js/model.js"]) {
    const r = spawnSync("git", ["show", "HEAD:tools/icarui/" + rel], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error) die(EXIT_INFRA, "git show 起不来：" + (r.error.message || r.error));
    if (r.status !== 0) die(EXIT_INFRA, "git show 失败（HEAD:tools/icarui/" + rel + "）：" + (r.stderr || "").trim());
    if (!r.stdout || r.stdout.length < 1000) die(EXIT_INFRA, "git show 出来的内容太小，不正常：" + rel);
    write(path.join(copy, rel), r.stdout);
  }
  描述.push("副本里的 app.js / model.js 已换成 HEAD（工作区一个字节没动）");
} else if (mode === "mutate") {
  const 全部 = ["cursor", "endpoint", "rollback", "bar-events", "canvas-rollback",
    "anchor", "validate", "validate-try", "validate-budget", "budget-off"];
  if (mutation !== null && 全部.indexOf(mutation) < 0) {
    die(EXIT_USAGE, "不认识的变异名：" + mutation + "（可选：" + 全部.join(" / ") + "）");
  }
  const 做 = function (名) { return mutation === null || mutation === 名; };

  // ---- 保护点 ①：游标按**当前记录对象**重定位（R1 核心）----
  //
  // 缺陷形态 = "用删除前的数值下标夹一下就算了"。规划方实测：
  // `[坏, CURRENT, FUTURE]` index=1 撤销后栈变 `[CURRENT, FUTURE]`，
  // 夹取把 index 留在 1 → **指向 FUTURE**，而设计还是 CURRENT。
  if (mutation !== null && 做("cursor")) {
    mustReplace(MODEL,
      "    const same = this.stack.indexOf(curRec);\n" +
      "    if (same >= 0) return same;                    // ① 当前记录还在 → 就是它",
      "    // MUTATION（cursor）：不认当前记录对象，退回\"删除前的数值下标夹一下\"\n" +
      "    const same = Math.min(curAt, this.stack.length - 1);\n" +
      "    if (same >= 0) return same;",
      "cursor");
    描述.push("变异【cursor】：`_relocate` 不认当前记录对象，退回数值下标夹取（R1 游标缺陷形态）");
  }

  // ---- 保护点 ②′：**为"实际当前设计"补锚点**（T5-R3 R1 核心）----
  //
  // 缺陷形态 = `anchorCurrent()` 直接返回 null（不补锚点）。
  // 后果：当前记录**自己坏了**、被摘掉之后，栈里没有任何一条记录代表画布上
  // 真正那份设计 —— `_relocate` 就近硬指一条**不是当前**的记录：
  // `canRedo/canUndo` 与实际相反，反方向的好历史**看着还在、实际不可达**。
  // 规划方实测的两例：`[坏BEFORE, 坏CURRENT, FUTURE]` 撤销、
  // `[EARLIER, 坏CURRENT, 坏AFTER]` 重做。
  if (mutation !== null && 做("anchor")) {
    mustReplace(MODEL,
      "    if (typeof state !== \"string\" || !state) return null;",
      "    // MUTATION（anchor）：不给\"实际当前设计\"补锚点（T5-R2 的缺陷形态）\n" +
      "    return null;\n" +
      "    if (typeof state !== \"string\" || !state) return null;",
      "anchor");
    描述.push("变异【anchor】：`anchorCurrent()` 直接返回 null（当前坏记录被摘后游标不代表实际当前）");
  }

  // ---- 保护点 ②″：正常端点**无害无操作**（不清空有效历史）----
  //
  // 缺陷形态 = 到栈底/栈顶时 `return null` → 调用方 `afterFailedStep(null)` →
  // 缺省 `usableLeft=0` 被判成"整个栈都坏了" → `undo.reset(snapshot())` 清栈。
  if (mutation !== null && 做("endpoint")) {
    mustReplace(MODEL,
      "    const usable = typeof isUsable === \"function\" ? isUsable : function () { return true; };\n" +
      "    if (!this.canUndo()) {\n" +
      "      // ⚠️ 真的全坏（连一条可用的都没有）才让 `usableLeft = 0` —— 那才是\n" +
      "      //    \"整个栈都坏了\"该走重建基准的路径。正常到栈底时它 > 0。\n" +
      "      return { ok: false, removed: 0, sizeBefore: this.stack.length, usableLeft: this._countUsable(usable) };\n" +
      "    }\n" +
      "    return this._step(-1, isUsable, curState, curLabel);",
      "    // MUTATION（endpoint）：到栈底退回 `return null`（T5-R 的缺陷形态）\n" +
      "    if (!this.canUndo()) return null;\n" +
      "    return this._step(-1, isUsable, curState, curLabel);",
      "endpoint-undo");
    mustReplace(MODEL,
      "    const usable = typeof isUsable === \"function\" ? isUsable : function () { return true; };\n" +
      "    if (!this.canRedo()) {\n" +
      "      return { ok: false, removed: 0, sizeBefore: this.stack.length, usableLeft: this._countUsable(usable) };\n" +
      "    }\n" +
      "    return this._step(1, isUsable, curState, curLabel);",
      "    // MUTATION（endpoint）：到栈顶退回 `return null`（T5-R 的缺陷形态）\n" +
      "    if (!this.canRedo()) return null;\n" +
      "    return this._step(1, isUsable, curState, curLabel);",
      "endpoint-redo");
    描述.push("变异【endpoint】：`undo()`/`redo()` 到端点退回 `return null`（正常端点清栈的缺陷形态）");
  }

  // ---- 保护点 ③：失败现场**整份回滚**（元数据表单 + dirty 提示条）----
  //
  // 缺陷形态 = 只把 design/selection 与 JSON 文本放回去，**不管元数据表单**、
  // 也**不管 dirty 提示条**。规划方实测：`mName` 仍显示 TARGET、
  // dirty 提示从"1 个错误"变成"0 个错误"。
  if (mutation !== null && 做("rollback")) {
    mustReplace(APP,
      "      try { if (area && prevJsonText !== null) area.value = prevJsonText; } catch (e2) { }\n" +
      "      // 元数据表单逐字段还原（⚠️ 不依赖任何会抛的东西：`el()` 本身不抛）\n" +
      "      for (let i = 0; i < prevForm.length; i++) {\n" +
      "        try {\n" +
      "          const e2 = el(prevForm[i].id);\n" +
      "          if (e2 && prevForm[i].v !== null) e2.value = prevForm[i].v;\n" +
      "        } catch (e3) { }\n" +
      "      }\n" +
      "      restoreDirtyState(dirtyState);   // dirty 标志 + 提示条**整段**内容一起复原",
      "      try { if (area && prevJsonText !== null) area.value = prevJsonText; } catch (e2) { }\n" +
      "      // MUTATION（rollback）：不还原元数据表单、不还原 dirty 提示条（缺陷形态）",
      "rollback");
    描述.push("变异【rollback】：`restore()` 失败时不还原元数据表单与 dirty 提示条（R2 事务缺陷形态）");
  }

  // ---- 保护点 ③′：提示条复原**连事件一起**（T5-R3 R2 核心）----
  //
  // 缺陷形态 = 退回"把原来那批节点的 outerHTML 拼成字符串、再 `innerHTML` 解析"。
  // 后果（规划方实测）：HTML 逐字节相同，但"放弃 JSON 改动"按钮的 `onclick`
  // 是**JS 属性**、不在 HTML 里 → 变成 `null` → 真实点击**什么都不发生**
  // （dirty 仍 true、草稿没被换掉、提示条不消失）。**HTML 相同 ≠ 交互相同。**
  if (mutation !== null && 做("bar-events")) {
    mustReplace(APP,
      "        while (bar.firstChild) bar.removeChild(bar.firstChild);\n" +
      "        for (let i = 0; i < st.barNodes.length; i++) bar.appendChild(st.barNodes[i]);",
      "        // MUTATION（bar-events）：序列化 HTML 再解析 —— 事件是 JS 属性，丢了\n" +
      "        let h = \"\";\n" +
      "        for (let i = 0; i < st.barNodes.length; i++) h += st.barNodes[i].outerHTML || \"\";\n" +
      "        bar.innerHTML = h;",
      "bar-events");
    描述.push("变异【bar-events】：提示条复原退回 `innerHTML` 序列化（按钮 onclick 丢成 null 的缺陷形态）");
  }

  // ---- 保护点 ③″：失败收尾**按实际设计重画画布**（T5-R3 R3 核心）----
  //
  // 缺陷形态 = 收尾里不重画（T5-R2 的行为：把"整套失效重画"留给下一次成功刷新）。
  // 后果（规划方实测）：候选在**真实 `draw` 内部**抛，而 `draw` 是**先画了候选**
  // 再抛的 —— 模型回滚了，**画布却停在候选那一帧**，而且不会自己好。
  if (mutation !== null && 做("canvas-rollback")) {
    mustReplace(APP,
      "        if (typeof window.draw === \"function\") { window.draw(); 画布已重画 = true; }",
      "        // MUTATION（canvas-rollback）：收尾不重画（画布停在候选那一帧）\n" +
      "        if (false && typeof window.draw === \"function\") { window.draw(); 画布已重画 = true; }",
      "canvas-rollback");
    描述.push("变异【canvas-rollback】：失败收尾不按实际设计重画画布（像素不回滚的缺陷形态）");
  }

  // ---- 保护点 ④：判据/解析都在**事务 try 之内**（异常必须变成 false）----
  //
  // 缺陷形态 = `restore` 的事务 `try` 去掉、`catch` 改成重新抛出。
  // 后果：判据/解析抛异常时**直接冒到调用方**，`restore` 连 `false` 都不返回。
  // ⚠️ 这一刀**不动**有界预算（那是 `validate-budget` 的分工）。
  if (mutation !== null && (做("validate") || 做("validate-try"))) {
    const file = APP;
    let s = read(file);
    const 一刀 = function (oldText, newText, what) {
      if (s.indexOf(oldText) < 0) {
        die(EXIT_INFRA, "变异【validate-try】" + what + " 没命中：" + path.relative(copy, file) + " 里找不到锚点（源码改过？）");
      }
      s = s.replace(oldText, newText);
    };
    一刀("    let o = null;\n    let cand = null;\n    try {\n",
      "    let o = null;\n    let cand = null;\n    // MUTATION（validate-try）：事务 try 去掉（判据/解析异常不再被兜住）\n    {\n",
      "第①刀 try");
    一刀("    } catch (e) {\n      console.warn(\"快照无法解析/校验，已拒绝恢复：\", e && e.message);\n      return false;\n    }",
      "    }\n    // MUTATION（validate-try）：catch 改成重新抛出",
      "第②刀 catch");
    write(file, s);
    描述.push("变异【validate-try】：`restore` 的判据/解析移出事务 try 且不再兜异常");
  }

  // ---- 保护点 ⑤a：校验**有界**（预算被改得极低 → 合法设计被明确拒绝）----
  //
  // ⚠️⚠️ **这一刀的含义是"预算过低误拒合法设计"，不是"关掉预算"**（T5-R3 纠正）。
  //    缺陷形态 = 两层显式预算被压到几乎为 0（深度 4、节点 1）。
  //    后果：**合法设计也**被判"无法验证"而拒绝 —— 证明有界检查**真的在挡**，
  //    而且挡的方式是"明确拒绝"，不是"静默放过半个设计"。
  //    它**不能**证明"取消预算后深输入会被放行"——那是下面 `budget-off` 的分工。
  if (mutation !== null && (做("validate") || 做("validate-budget"))) {
    const file = APP;
    let s = read(file);
    const 一刀 = function (oldText, newText, what) {
      if (s.indexOf(oldText) < 0) {
        die(EXIT_INFRA, "变异【validate-budget】" + what + " 没命中：" + path.relative(copy, file) + " 里找不到锚点（源码改过？）");
      }
      s = s.replace(oldText, newText);
    };
    一刀("  const NODE_DEPTH_LIMIT = 512;",
      "  const NODE_DEPTH_LIMIT = 4;      // MUTATION（validate-budget）：预算被改得**过低**（不是取消）",
      "深度预算");
    一刀("  const NODE_SCAN_LIMIT = 200000;",
      "  const NODE_SCAN_LIMIT = 1;       // MUTATION（validate-budget）：预算被改得**过低**（不是取消）",
      "节点预算");
    write(file, s);
    描述.push("变异【validate-budget】：两层预算被改得**过低**（512→4 / 200000→1）→ 合法设计被误拒（**不是**「取消预算」）");
  }

  // ---- 保护点 ⑤b：**真正取消**两层预算（T5-R3 新增；与 ⑤a 含义相反）----
  //
  // 缺陷形态 = `NODE_DEPTH_LIMIT` / `NODE_SCAN_LIMIT` 改成 `Infinity`
  //（= 规划方那份"真正放宽/取消预算"的临时副本方法，现在纳入仓库可复现入口）。
  // 后果：深/超量输入**不再被拒绝** —— `isUsableSnapshot(10000 层)` 会放行（判据
  // 返回 true），"深输入必须被安全拒绝"那条行为断言必须变红。
  if (mutation !== null && 做("budget-off")) {
    const file = APP;
    let s = read(file);
    const 一刀 = function (oldText, newText, what) {
      if (s.indexOf(oldText) < 0) {
        die(EXIT_INFRA, "变异【budget-off】" + what + " 没命中：" + path.relative(copy, file) + " 里找不到锚点（源码改过？）");
      }
      s = s.replace(oldText, newText);
    };
    一刀("  const NODE_DEPTH_LIMIT = 512;",
      "  const NODE_DEPTH_LIMIT = Infinity;   // MUTATION（budget-off）：**真正取消**深度预算",
      "深度预算");
    一刀("  const NODE_SCAN_LIMIT = 200000;",
      "  const NODE_SCAN_LIMIT = Infinity;    // MUTATION（budget-off）：**真正取消**节点预算",
      "节点预算");
    write(file, s);
    描述.push("变异【budget-off】：两层预算**真正取消**（改成 Infinity）→ 深/超量输入不再被拒绝");
  }

  if (mode === "mutate" && mutation === null) {
    // 默认模式（历史形态）：一次关两处 —— 保持"当前 0、默认 1"的既有约定。
    // ⚠️ 它**不**用来证明游标/边界/事务/校验四处新增断言各自有效，
    //    那是 `--mutate=<名>` 的分工（R3 验收明确要求）。
    const appPath = APP;
    let app = read(appPath);
    let model = read(MODEL);
    // ① 准备阶段不再做候选归一化（缺 canvas / 只有 nodes 的旧形态照原样赋值）
    const appOld = "      cand = normalizeSnapshotDesign(o.d);";
    const appNew = "      cand = o.d;            // MUTATION: 不做候选归一化（T5-A 的缺陷形态）";
    if (app.indexOf(appOld) < 0) die(EXIT_INFRA, "默认变异 ① 没命中：app.js 里找不到候选归一化调用（源码改过？）");
    app = app.replace(appOld, appNew);
    // ② 应用阶段**整体不设防**：任何一处抛都直接返回 true（= 半套状态、还报成功）
    //
    // ⚠️ T5-R2 把 `restore` 拆成了"判据/解析"与"准备"两个 try，
    //    应用阶段那一层原来只有 `catch`。这里把它换成 `catch { }`，
    //    等价于 T5-A 的"异常冒出去/当成做完了"这一类缺陷形态。
    const applyOld = "    } catch (e) {\n" +
      "      // 走到这里说明\"判据没拦住、后面才炸\"。回滚到进函数那一刻的状态：";
    const applyNew = "    } catch (e) {\n" +
      "      // MUTATION: 应用阶段不设防（T5-A 的缺陷形态）—— 直接当成功\n" +
      "      if (true) { } else {";
    if (app.indexOf(applyOld) < 0) die(EXIT_INFRA, "默认变异 ①b 没命中：app.js 里找不到应用阶段的 catch");
    app = app.replace(applyOld, applyNew);
    const applyTailOld = "      console.warn(\"快照恢复失败，已回滚到恢复前的状态：\", e && e.message);\n" +
      "    } finally {\n" +
      "      suppressJsonSync = prevSuppress;   // ⚠️ 临时标志必须归位（异常路径也一样）\n" +
      "    }\n" +
      "    return ok;";
    const applyTailNew = "      console.warn(\"快照恢复失败（MUTATION：未回滚）：\", e && e.message);\n" +
      "      }\n" +
      "    } finally {\n" +
      "      suppressJsonSync = prevSuppress;\n" +
      "    }\n" +
      "    return ok;";
    if (app.indexOf(applyTailOld) < 0) die(EXIT_INFRA, "默认变异 ①c 没命中：app.js 里找不到应用阶段 catch 的收尾");
    app = app.replace(applyTailOld, applyTailNew);
    write(appPath, app);
    const mAnchor = "    this.lastKey = null;\n    return { ok: false, removed: removed, sizeBefore: sizeBefore, usableLeft: this._countUsable(usable),\n             anchorAt: anchorAt, curRemoved: curRemoved, anchor: anchor };\n  };";
    const mNew = "    this.lastKey = null;\n    // MUTATION: 端点没有可用目标 → 整栈清空（T5-A 的缺陷形态）\n    this.stack.splice(0, this.stack.length);\n    this.index = -1;\n    return { ok: false, removed: removed, sizeBefore: sizeBefore, usableLeft: 0,\n             anchorAt: anchorAt, curRemoved: curRemoved, anchor: anchor };\n  };";
    if (model.indexOf("本方向确实走不到可用记录") < 0) die(EXIT_INFRA, "默认变异 ② 没命中：model.js 里找不到失败分支");
    if (model.indexOf(mAnchor) < 0) die(EXIT_INFRA, "默认变异 ② 没命中：model.js 里找不到失败分支的 return");
    model = model.replace(mAnchor, mNew);
    write(MODEL, model);
    描述.push("默认变异 ①：restore 不做候选归一化 + 应用阶段不设防（T5-A 形态；**不能**冒充事务回滚已覆盖）");
    描述.push("默认变异 ②：`_step` 在\"本方向没有可用目标\"时整栈清空（T5-A 形态）");
  }
}

if (mode !== "current") {
  // 变异自检：还要确认"保护符号确实消失/存在"，避免改了个无关的地方却以为变异成功了
  const appNow = read(APP);
  const modelNow = read(MODEL);
  if (mode === "mutate" && mutation === null &&
      (appNow.indexOf("MUTATION") < 0 || modelNow.indexOf("MUTATION") < 0)) {
    die(EXIT_INFRA, "变异自检失败：副本里找不到 MUTATION 标记");
  }
  if (mode === "mutate" && mutation !== null) {
    // ⚠️ `validate` 是"两半一起关"的组合名，其余都是单一保护点。
    const 标记 = (mutation === "validate") ? ["validate-try", "validate-budget"] : [mutation];    for (const mk of 标记) {
      if (appNow.indexOf("MUTATION（" + mk + "）") < 0 && modelNow.indexOf("MUTATION（" + mk + "）") < 0) {
        die(EXIT_INFRA, "变异自检失败：副本里找不到 MUTATION（" + mk + "）标记");
      }
    }
  }
  if (mode === "head" && appNow.indexOf("isUsableSnapshot") >= 0 &&
      appNow.indexOf("normalizeSnapshotDesign") < 0) {
    console.log("  （HEAD 里已有 isUsableSnapshot，符合 T5-A 的形态）");
  }
  try { new Function(appNow); new Function(modelNow); }
  catch (e) { die(EXIT_INFRA, "变异后的副本**语法就不对**（不是\"预期红\"）：" + (e && e.message)); }
}
for (const line of 描述) console.log("  · " + line);

// ---------------------------------------------------------------- 4. 跑套件（透传真实退出码）
const suitePath = path.join(copy, "tests", SUITE);
console.log("\n===== 跑副本里的 " + SUITE + " =====");
const run = spawnSync(process.execPath, [suitePath], {
  cwd: copy,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
  timeout: 10 * 60 * 1000,
});
const stdout = run.stdout || "";
const stderr = run.stderr || "";
const suiteExit = (run.status === null) ? null : run.status;

// 只打印摘要行 + 失败条目，避免刷屏（完整日志留在上面那次输出里）
const lines = stdout.split(/\r?\n/);
const summary = lines.filter(l => /^PASS=\d+\s+FAIL=\d+/.test(l));
const fails = lines.filter(l => l.indexOf("❌") >= 0);
console.log("  套件内层退出码 status=" + (suiteExit === null ? "null(被信号杀掉/超时)" : suiteExit));
console.log("  信号 signal=" + (run.signal === null || run.signal === undefined ? "无" : run.signal));
console.log("  启动错误 error=" + (run.error ? (run.error.message || String(run.error)) : "无"));
if (summary.length) console.log("  " + summary[summary.length - 1].trim());
fails.slice(0, 40).forEach(l => console.log("  " + l.trim()));
if (fails.length > 40) console.log("  …… 还有 " + (fails.length - 40) + " 条失败未列出");

// ---------------------------------------------------------------- 5. 判定
//
// 🔴 **基础设施错误必须先判**（T5-R2）：`error` / `signal` / `status === null`
//    这三类即使 stdout 里已经有部分 `PASS=`/`FAIL=`（跑一半超时），
//    也**绝不算"变异成功"**。旧写法只看最后一条摘要，会把它们误判成预期红。
console.log("\n===== 判定 =====");
if (run.error) {
  die(EXIT_INFRA, "子进程**起不来**（spawn error）：" + (run.error.message || run.error) +
    " —— 这是基础设施错误，不是「变异成功」");
}
if (run.signal) {
  die(EXIT_INFRA, "子进程被**信号**杀掉（signal=" + run.signal + "）" +
    (summary.length ? "，虽然 stdout 里已有 " + summary[summary.length - 1].trim() + " —— 仍归基础设施错误" : "") +
    " —— 不是「变异成功」");
}
if (suiteExit === null) {
  die(EXIT_INFRA, "子进程没有正常退出（status=null，通常是**超时**）" +
    (summary.length ? "，虽然 stdout 里已有 " + summary[summary.length - 1].trim() + " —— 仍归基础设施错误" : "") +
    " —— 不是「变异成功」");
}
if (!summary.length) {
  die(EXIT_INFRA, "套件没有打印 PASS=/FAIL= —— 它崩了（不是\"变异成功\"）\n" +
    (stderr.split(/\r?\n/).slice(-8).join("\n") || "（stderr 为空）"));
}
const m = summary[summary.length - 1].match(/^PASS=(\d+)\s+FAIL=(\d+)/);
const nPass = parseInt(m[1], 10), nFail = parseInt(m[2], 10);

if (mode === "current") {
  if (nFail === 0 && suiteExit === 0) {
    console.log("✅ 对照组：当前代码全部通过（PASS=" + nPass + " FAIL=0，外层退出码 0）");
    process.exit(EXIT_OK);
  }
  die(EXIT_INFRA,
    "对照组就该全绿，结果 FAIL=" + nFail + " / 套件退出码 " + suiteExit + " —— 先修当前代码，再谈反向验证");
}

if (nFail > 0 && suiteExit !== 0) {
  console.log("✅ 预期红：" + (mutation ? "只关【" + mutation + "】之后 " : "变异/HEAD 形态下 ") +
    nFail + " 条断言失败（PASS=" + nPass + "），" +
    "套件内层退出码 " + suiteExit + " —— **这个非 0 就是套件真实的退出码**（不是打印出来的数字）。");
  console.log("   命中的行为断言见上面的 ❌ 列表；若只有\u201c缺钩子\u201d一类，说明这套断言还没抓住真实行为。");
  process.exit(EXIT_SUITE_RED);
}
if (nFail === 0 && suiteExit === 0) {
  if (mutation === "validate-try") {
    // ⚠️ 这一处是**结构性造不出红**，不是"断言没写"。见文件头「够不到的一层」。
    console.log("⚠️ 只关【validate-try】之后套件全绿（PASS=" + nPass + "）—— 这是**预期**的：");
    console.log("   该保护是「判据自身抛异常时 restore 兜住它」这一层纵深防御，而快照是字符串、");
    console.log("   JSON.parse 出来的必然是纯数据（放不出会抛的取值器）；判据又已改迭代+预算，");
    console.log("   深/海量输入会被**安全拒绝**而不是爆栈 —— 所以**真机输入下不可确定性复现**。");
    console.log("   它由「深快照安全返回 boolean / restore 返回 false / 合法深度不误伤」间接守着；");
    console.log("   **不声称被独立反向验证覆盖**。退出码 4 = 如实报告\"没造出红\"，不是失败。");
    process.exit(EXIT_UNEXPECTED_GREEN);
  }
  die(EXIT_UNEXPECTED_GREEN, (mutation ? "只关【" + mutation + "】" : "变异") +
    "之后套件**仍然全绿**（PASS=" + nPass + "）—— 这套断言没抓住那处保护，反向验证不成立");
}
die(EXIT_INFRA, "状态自相矛盾：FAIL=" + nFail + " 但退出码 " + suiteExit + "（套件自己算错了？）");
