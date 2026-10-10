// ============================================================================
// check-doc-links.js —— `docs/**/*.md` 相对链接**死链守卫**（v2.85.0）
//
// ## 为什么需要它
//
// `docs/` 下有近 400 条相对链接（"见 X.md" / "见 tools/xxx.js"）。
// 文档一改名、目录一挪（`tools/theme-studio/` → `tools/icarui/` 就发生过），
// 链接就指向空气 —— 而**没有任何东西会报错**：Markdown 渲染成一段死文字，
// 读者点下去是 404，作者永远不知道。
//
// 上一轮体检是用**临时脚本**扫的，扫完脚本就没了 —— 于是下一轮照样会烂。
// 这个文件就是把它变成**常驻守卫**。
//
// ## 查什么、不查什么（这是本脚本最重要的设计决定）
//
// 两类候选，**解析基准不同** —— 这一点搞错就会大面积假红：
//
// ### A 类 · Markdown 链接 `[文字](目标)`  →  **只按所在文件目录解析**
//
//   这是 Markdown 的语义：`docs/archive/x.md` 里写 `(主题格式参考.md)`
//   指的就是 `docs/archive/主题格式参考.md`，**不是**仓库根的 `主题格式参考.md`。
//   所以 A 类**不做多基准兜底** —— 兜底会把"相对路径写错"这种真 bug 洗成绿的。
//
// ### B 类 · 反引号里的路径 `` `tools/xxx.js` ``  →  **多基准兜底**
//
//   散文里提到路径时，"相对谁"是**真的有歧义**：`docs/FILE_MAP.md` 里写
//   `` `tools/run-tests.ps1` `` 指的是仓库根（对的），
//   而 `` `../tools/icarui/index.html` `` 指的是文档目录。
//   所以 B 类按 **{所在目录, 仓库根, docs/}** 依次试，**任意一个存在即算有效**。
//   只在"三个基准全都找不到"时才报红 —— 那才是真失效。
//
//   ⚠️ B 类还必须是**像路径的东西**才查（见 isWorthCheckingBacktick）：
//   反引号在这个仓库里绝大多数是**代码/类名/通用文件名**（`org.json` 是 Java 包名、
//   `dash.json` 是"随便一个设计文件"、`lamp-off.png` 是素材举例）。
//   把裸文件名一律当路径查 → 实测 **1667 条假红**，守卫当场变成噪声源。
//   所以只认**明确的路径形态**：`./x`、`../x`、`docs/ tools/ app/ gradle/` 开头。
//
// ## 豁免机制（历史文档不许改）
//
// `docs/archive/` 是**历史归档**，`docs/CHANGELOG.md` / `迭代清单.md` 里的
// **带版本号叙述**也是事实记录 —— 按 `docs/README.md` 附录 B 的维护约定 §4/§5，
// **改它 = 改历史**。那些失效链接是**刻意保留**的。
//
// 豁免**不按目录或文件名整体放过**，而是逐条写在
// `tools/doc-link-allowlist.json` 里，**每条必须写理由**，且按
// **(文件, 链接原文)** 精确匹配 —— 所以：
//   · 同一个文件里**新增**一条指向别的死目标的链接 → **照样红**；
//   · 豁免条目一旦不再命中（有人把链接修好了）→ 只**警告**，不红。
//
// ## 守卫自己不许静默跳过
//
// 这个仓库刚立的规矩：**解析不到就是错**。所以下面这些都算**失败**：
//   · `docs/` 不存在 / 一份 .md 都没扫到
//   · 豁免清单读不到、JSON 坏了、条目缺 `reason`
//   · 候选链接数低于 `minMarkdownLinks` / `minBacktickPaths`
//     —— 这是**解析器金丝雀**：正则写坏了会扫出 0 条，
//     而"0 条失效"看起来是完美的绿。数字对不上就报错。
//
// ## 用法
//
//   node tools/check-doc-links.js              # 查（有问题 → 退出码 1）
//   node tools/check-doc-links.js --verbose    # 连豁免命中/每文件统计一起打
//
// 退出码：0 = 全绿；1 = 有失效链接 **或** 守卫自身出错。
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const ALLOWLIST_PATH = path.join(__dirname, 'doc-link-allowlist.json');

const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 收集 docs/ 下全部 .md（递归，排序保证输出稳定）。 */
function collectMarkdown(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectMarkdown(p));
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

/** 仓库相对路径，一律用 `/` 分隔（跨平台输出稳定，也是豁免清单里的键）。 */
const relPosix = p => path.relative(ROOT, p).split(path.sep).join('/');

/** 目标是"外部/锚点/绝对路径"吗 —— 那些不归本守卫管。 */
function isRelativeTarget(t) {
  if (!t) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t)) return false; // http: mailto: file: …
  if (t.startsWith('#')) return false;                    // 页内锚点
  if (t.startsWith('/') || t.startsWith('\\')) return false; // 绝对路径
  return true;
}

const EXT_RE = /\.(md|markdown|json|js|mjs|cjs|kt|kts|xml|ps1|sh|bat|png|jpg|jpeg|gif|svg|webp|txt|csv|html|css|jar|gradle|py|yml|yaml|properties)\b/i;
/** 路径里出现这些字符 → 不是一条具体路径（通配、占位、命令行、表格）。 */
const NOT_A_PATH_RE = /[\s*?<>{}[\]|]/;

/**
 * 反引号内容值不值得当路径查。
 *
 * 判据（三条同时满足）：
 *   1. 形态明确 —— `./x` / `../x` / `docs|tools|app|gradle/` 开头；
 *      **裸文件名一律不查**（`dash.json` / `org.json` / `lamp-off.png` 这类
 *      是举例、类名、包名，不是路径引用 —— 查它们实测 1600+ 条假红）。
 *   2. 像个文件 —— 带已知扩展名。
 *   3. 没有通配/占位/空格 —— `{schema,model}.js`、`app/src/.../X.kt`、
 *      `java -jar x.jar design.json` 都不是一条可解析的路径。
 */
function isWorthCheckingBacktick(t) {
  if (!isRelativeTarget(t)) return false;
  if (NOT_A_PATH_RE.test(t)) return false;
  if (t.includes('...')) return false;
  if (!EXT_RE.test(t)) return false;
  return t.startsWith('./') || t.startsWith('../') || /^(docs|tools|app|gradle)\//.test(t);
}

/** 去掉行号后缀：`docs/CHANGELOG.md:48-51` → `docs/CHANGELOG.md`。 */
const stripLineRef = t => t.replace(/[:：]\d+([-,]\d+)*$/, '');

/** 去掉句尾的中文标点（`…ps1。` 这种）。 */
const stripTrailingPunct = t => t.replace(/[。，、；！？）】」』]+$/, '');

/** 目标 → 用于存在性判断的路径字符串。 */
function toPathString(raw) {
  let t = raw.trim();
  t = t.replace(/^<|>$/g, '');       // Markdown 的 <path with space> 写法
  t = stripLineRef(t);
  t = stripTrailingPunct(t);
  try { t = decodeURIComponent(t); } catch (e) { /* 不是合法转义就按原样用 */ }
  return t;
}

// ---------------------------------------------------------------------------
// 提取
// ---------------------------------------------------------------------------

// Markdown 行内链接：`[文字](目标)` / `[文字](目标 "标题")` / `[文字](<目标>)`
const MD_LINK_RE = /\[[^\]]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
// 反引号行内代码（单反引号，不跨行）
const BACKTICK_RE = /`([^`\n]+)`/g;
// 围栏代码块的开合标记
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * 把行内代码（反引号里）**替换成等长空格**。
 *
 * ## 为什么必须这么做（这是实测踩出来的）
 *
 * 本文件自己的文档里就写着例子：`` `[x](path)` ``。
 * 不遮掉的话，那个**例子**会被当成一条真链接去解析 → `docs/path` 不存在 → 假红。
 * （第一次跑就中了：`docs/FILE_MAP.md` 里描述守卫用法的那一行。）
 *
 * 真正的 Markdown 也**不会**在代码 span 里生成链接 —— 所以这不是"给守卫开后门"，
 * 而是把解析对齐到 Markdown 语义。等长替换是为了让后面的列号/上下文不变。
 */
const maskInlineCode = line => line.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));

/**
 * 扫一份文档，返回候选数组。
 *
 * @returns {{kind:'md'|'backtick', line:number, raw:string, target:string,
 *            bases:string[], hit:string|null}[]}
 *   `bases` = 依次尝试的基准目录；`hit` = 第一个存在的绝对路径（null = 全都没找到）。
 */
function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const dir = path.dirname(file);
  const lines = text.split(/\r?\n/);
  const found = [];
  let inFence = false;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    // 围栏代码块：``` 开 / ``` 合。块内的内容**不是** Markdown。
    if (FENCE_RE.test(line)) { inFence = !inFence; return; }

    let m;

    // A 类只在**非围栏**行上找，且先遮掉行内代码 —— 见 maskInlineCode 的说明。
    if (!inFence) {
      const masked = maskInlineCode(line);
      MD_LINK_RE.lastIndex = 0;
      while ((m = MD_LINK_RE.exec(masked)) !== null) {
        // ⚠️ 从 masked 上取**位置**，从原行上取**原文** —— masked 是等长替换，
        //    所以下标一一对应；但原文里那一段是反引号包裹的，不该当链接，
        //    而 maskInlineCode 已经把它们变成空格，MD_LINK_RE 匹配不到。
        const raw = m[1].trim();
        if (!isRelativeTarget(raw.replace(/^<|>$/g, ''))) continue;
        const target = toPathString(raw);
        if (!target) continue;
        // A 类：**只按所在目录**（Markdown 语义）—— 不做多基准兜底。
        found.push({ kind: 'md', line: lineNo, raw, target, bases: [dir] });
      }
    }

    // B 类：反引号路径照常扫（围栏内也扫 —— 目录树、命令示例里的路径同样是真路径，
    // 而且实测没有假红）。
    BACKTICK_RE.lastIndex = 0;
    while ((m = BACKTICK_RE.exec(line)) !== null) {
      const raw = m[1].trim();
      if (!isWorthCheckingBacktick(raw)) continue;
      const target = toPathString(raw);
      if (!target) continue;
      // B 类：散文里的路径有歧义 → 多基准兜底。
      found.push({
        kind: 'backtick', line: lineNo, raw, target,
        bases: [dir, ROOT, DOCS_DIR],
      });
    }
  });

  for (const c of found) {
    c.hit = null;
    for (const b of c.bases) {
      const abs = path.resolve(b, c.target);
      if (fs.existsSync(abs)) { c.hit = abs; break; }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 豁免清单
// ---------------------------------------------------------------------------

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    throw new Error(
      '找不到豁免清单：' + relPosix(ALLOWLIST_PATH) + '\n' +
      '     它必须存在（哪怕内容只有 {"version":1,"allow":[]}）。\n' +
      '     守卫**不会**因为清单缺失就放行 —— 缺清单 = 无法判断哪些是刻意保留的 = 失败。'
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    throw new Error('读不了豁免清单 ' + relPosix(ALLOWLIST_PATH) + '：' + e.message);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('豁免清单 JSON 解析失败（' + relPosix(ALLOWLIST_PATH) + '）：' + e.message);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.allow)) {
    throw new Error('豁免清单结构不对：顶层必须是对象且含数组字段 `allow`。');
  }
  data.allow.forEach((e, i) => {
    const at = 'allow[' + i + ']';
    if (!e || typeof e !== 'object') throw new Error('豁免清单 ' + at + ' 不是对象。');
    if (!e.file || typeof e.file !== 'string') throw new Error('豁免清单 ' + at + ' 缺 `file`。');
    if (!e.link || typeof e.link !== 'string') throw new Error('豁免清单 ' + at + ' 缺 `link`（链接原文）。');
    if (!e.reason || typeof e.reason !== 'string' || !e.reason.trim()) {
      throw new Error('豁免清单 ' + at + '（' + e.file + ' → ' + e.link + '）缺 `reason`。' +
        ' 豁免**必须写明理由** —— 没理由的豁免等于没有守卫。');
    }
  });
  return data;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const problems = [];

  // ---- 前置：守卫自己不许静默跳过
  if (!fs.existsSync(DOCS_DIR) || !fs.statSync(DOCS_DIR).isDirectory()) {
    console.log('❌ 找不到 docs/ 目录：' + DOCS_DIR);
    console.log('   守卫无法工作 —— 按失败处理（解析不到就是错）。');
    process.exit(1);
  }

  let allowData;
  try {
    allowData = loadAllowlist();
  } catch (e) {
    console.log('❌ 豁免清单有问题：' + e.message);
    process.exit(1);
  }

  const files = collectMarkdown(DOCS_DIR);
  if (files.length === 0) {
    console.log('❌ docs/ 下一份 .md 都没扫到：' + DOCS_DIR);
    console.log('   按失败处理（解析不到就是错）。');
    process.exit(1);
  }

  const allowMap = new Map();
  for (const e of allowData.allow) {
    allowMap.set(e.file + '\u0000' + e.link, { ...e, used: 0, lines: [] });
  }

  // ---- 扫描
  const perFile = [];
  let nMd = 0, nBacktick = 0, nDead = 0, nAllowed = 0;
  const dead = [];

  for (const f of files) {
    const rel = relPosix(f);
    let cands;
    try {
      cands = scanFile(f);
    } catch (e) {
      // 读不到 / 解码失败 → 失败，不是跳过。
      console.log('❌ 读不了 ' + rel + '：' + e.message);
      problems.push(rel);
      continue;
    }
    perFile.push({ rel, total: cands.length });

    for (const c of cands) {
      if (c.kind === 'md') nMd++; else nBacktick++;
      if (c.hit) continue;

      const key = rel + '\u0000' + c.raw;
      const a = allowMap.get(key);
      if (a) {
        a.used++;
        a.lines.push(c.line);
        nAllowed++;
        continue;
      }
      nDead++;
      dead.push({ rel, ...c });
    }
  }

  // ---- 解析器金丝雀：扫出来的数量对不上 = 正则坏了
  const minMd = Number(allowData.minMarkdownLinks);
  const minBt = Number(allowData.minBacktickPaths);
  if (!Number.isFinite(minMd) || !Number.isFinite(minBt)) {
    console.log('❌ 豁免清单缺 `minMarkdownLinks` / `minBacktickPaths`（解析器金丝雀阈值）。');
    process.exit(1);
  }
  if (nMd < minMd) {
    console.log('❌ 解析器金丝雀：只扫出 ' + nMd + ' 条 Markdown 链接，低于下限 ' + minMd + '。');
    console.log('   多半是提取正则被改坏了 —— "扫不到"必须报错，不能当成"没有失效链接"。');
    problems.push('markdown-link-canary');
  }
  if (nBacktick < minBt) {
    console.log('❌ 解析器金丝雀：只扫出 ' + nBacktick + ' 条反引号路径，低于下限 ' + minBt + '。');
    problems.push('backtick-canary');
  }

  // ---- 输出
  console.log('');
  console.log('===== 文档死链守卫（docs/**/*.md）=====');
  console.log('  扫描 ' + files.length + ' 份文档 · 候选 ' + (nMd + nBacktick) + ' 条' +
    '（Markdown 链接 ' + nMd + ' / 反引号路径 ' + nBacktick + '）');

  if (VERBOSE) {
    for (const p of perFile) {
      console.log('    · ' + p.rel + '  ' + p.total + ' 条');
    }
  }

  if (dead.length > 0) {
    console.log('');
    for (const d of dead) {
      // 基准可能重复（docs/ 下的文件，"所在目录"与"docs/"是同一个）—— 去重后再打。
      const abs = [...new Set(d.bases.map(b => path.resolve(b, d.target)))];
      console.log('  ❌ ' + d.rel + ':' + d.line);
      console.log('     链接：' + d.raw);
      console.log('     解析到' + (abs.length > 1 ? '（依次试过）' : '') + '：' + abs.join('  /  '));
    }
    console.log('');
    console.log('  失效 ' + dead.length + ' 条 —— **红**。');
    console.log('  修法：把链接改成真实存在的路径；');
    console.log('  若这条失效是**刻意保留的历史记录**，写进 ' + relPosix(ALLOWLIST_PATH) +
      '（必须带 reason）。');
  }

  if (VERBOSE && nAllowed > 0) {
    console.log('');
    console.log('  —— 已豁免（' + nAllowed + ' 处命中）——');
    for (const a of allowMap.values()) {
      if (a.used === 0) continue;
      console.log('    · ' + a.file + ' → ' + a.link + '  （' + a.used + ' 处：行 ' + a.lines.join(', ') + '）');
      console.log('      理由：' + a.reason);
    }
  }

  // 豁免条目失效（链接被修好了 / 文档被删了）→ 只警告，不红。
  const stale = [...allowMap.values()].filter(a => a.used === 0);
  if (stale.length > 0) {
    console.log('');
    console.log('  ⚠️  ' + stale.length + ' 条豁免已不再命中（可以从清单里删掉）：');
    for (const a of stale) console.log('       ' + a.file + ' → ' + a.link);
  }

  console.log('');
  if (dead.length > 0 || problems.length > 0) {
    console.log('  失效 ' + dead.length + ' 条 / 已豁免 ' + nAllowed + ' 条 / 守卫自身问题 ' +
      problems.length + ' 条 —— 不通过 ❌');
    process.exit(1);
  }
  console.log('  失效 0 条 / 已豁免 ' + nAllowed + ' 条 —— 全部通过 ✅');
  process.exit(0);
}

main();
