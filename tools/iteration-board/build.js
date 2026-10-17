'use strict';
// Read-only source snapshot. No network, dependencies or business-code edits.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
const git = args => execFileSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const status = read('04_交接状态.md');
const task = read('03_当前任务.md');
const plan = read('02_开发计划.md');
const block = status.match(/```iteration-summary\s*\n([\s\S]*?)\n```/);
if (!block) throw new Error('04_交接状态.md 缺少 iteration-summary 摘要；请按 tools/iteration-board/README.md 更新。');
const summary = JSON.parse(block[1]);
for (const field of ['taskId', 'title', 'review', 'before', 'after', 'remaining']) {
  if (typeof summary[field] !== 'string' || !summary[field].trim()) throw new Error('摘要字段缺失：' + field);
}
if (!Array.isArray(summary.verification) || !Array.isArray(summary.docs)) throw new Error('verification/docs 必须为数组');
const taskHeading = task.match(/^## (T[^\s：:]+)[：:]/m);
if (!taskHeading || taskHeading[1] !== summary.taskId) throw new Error('摘要 taskId 与 03_当前任务.md 不一致，拒绝生成过期摘要');

// ---- 文档清单（T-Mgr-P002-BOARD-01 修正）----
// `docs/` 下有 28 份 **旧路径跳转页**（`00-README.md` 这类连字符命名），
// 内容只有一句"文档已迁移"，每份约 500 B。
// 原来它们全被收进"文档与证据"，把真正的正文挤出列表 ——
// 用户要翻很久才能找到要看的文档。
// 现在按内容识别并排除（判据：文件名含连字符 且 正文只提到"已迁移/已整理"）。
const isRedirectStub = (file, text) => {
  if (!/-/.test(path.basename(file))) return false;
  return text.length < 1200 && /文档已迁移|文档已整理/.test(text);
};
const docFiles = [
  ...fs.readdirSync(path.join(root, 'docs')).filter(n => /^\d\d_.*\.md$/.test(n)).map(n => 'docs/' + n),
  ...fs.readdirSync(path.join(root, 'docs/01_专题')).filter(n => n.endsWith('.md')).map(n => 'docs/01_专题/' + n),
  // ⚠️ 验证记录目录原来只收索引，导致最近几轮的验证报告在"文档与证据"里**找不到** ——
  // 而那正是用户最想查的东西（"这轮到底验了什么"）。这里递归收全部 .md。
  ...fs.readdirSync(path.join(root, 'docs/02_验证记录'))
    .filter(n => n.endsWith('.md'))
    .map(n => 'docs/02_验证记录/' + n),
  'docs/03_历史归档/00_归档说明.md',
].filter(f => {
  const full = path.join(root, f);
  if (!fs.existsSync(full)) return true;
  return !isRedirectStub(f, read(f));
});
// 问题清单必须进快照 —— 「后续计划」要从它读待办表
if (!docFiles.includes('docs/03_开发进度与问题清单.md')) docFiles.push('docs/03_开发进度与问题清单.md');
const files = ['03_当前任务.md', '02_开发计划.md', '04_交接状态.md', '01_项目规格.md', 'AGENTS.md', 'README.md', 'tools/iteration-board/README.md', 'tools/icarui/README.md',
  ...docFiles];
for (const d of summary.docs) {
  if (typeof d.file !== 'string' || path.isAbsolute(d.file) || d.file.split(/[\\/]/).includes('..')) throw new Error('非法摘要文件路径');
  if (!files.includes(d.file) && fs.existsSync(path.join(root, d.file))) files.push(d.file);
}
const sources = Object.fromEntries(files.map(file => [file, read(file)]));
const sections = (text, pattern) => [...text.matchAll(/^## (.+)$/gm)].filter(m => pattern.test(m[1])).map((m, i, a) => ({ title: m[1], text: text.slice(m.index, a[i + 1]?.index ?? text.length) }));

// ---- 里程碑（T-Mgr-P002-BOARD-01 修正）----
// 原来用 `/^\d+\./` 抓二级标题，结果把「1. 当前任务索引」「2. 暂缓任务」
// 这类**章节名**当成了计划项，用户看到的"后续计划"全是元数据噪音。
// 现在只认**带状态行**的标题 —— 「状态：…」是计划项的标志，
// 章节名没有状态行，自然被排除。
const milestoneSections = sections(plan, /^[\d.]+\s*/).filter(s => /^状态[：:]/m.test(s.text));
const milestones = milestoneSections.map(s => ({
  title: s.title,
  status: s.text.match(/^状态[：:](.*)$/m)?.[1]?.trim() ?? '待安排',
  text: s.text,
}));

// ---- 版本条目（修正）----
// 原来标题取的是 `## 2026-10`，7 条全叫「2026-10」，页面上无法区分。
// 现在取**下一行的条目标题**（如「App · v1.20.22」），拿不到才退回原标题。
const releases = ['docs/07_版本更新日志.md'].flatMap(file =>
  [...sources[file].matchAll(/^## (\d{4}-\d{2}[^\n]*)\n([\s\S]*?)(?=^## |\s*$)/gm)]
    .slice(0, 6)
    .map(m => {
      const body = m[2] || '';
      // 顶部第一个非空行如果是标题（### 或 **…**），拿来当条目标题
      const inner = body.match(/^\s*(?:###\s*(.+?)\s*$|\*\*(.+?)\*\*\s*$)/m);
      const title = (inner?.[1] || inner?.[2] || m[1]).trim();
      return { title, date: m[1].trim(), text: m[0], file };
    })
);

// ---- 最近几轮（新增）----
// overview 只显示「当前这一张卡」，用户看不到前几轮做了什么。
// 这里从 Git 提交里取最近若干条 `feat|fix|docs(...)` 的**任务级**提交，
// 让"这个项目最近在忙什么"一眼可见。
const recentWork = git(['log', '-20', '--date=short', '--pretty=format:%h | %ad | %s'])
  .split('\n')
  .filter(Boolean)
  .filter(l => /(feat|fix|perf)(\(|:)|^[0-9a-f]{7,} \| \d{4}-\d{2}-\d{2} \| (docs:|chore:)/.test(l))
  .slice(0, 6)
  .map(line => {
    const [hash, date, ...rest] = line.split(' | ');
    return { hash, date, subject: rest.join(' | ') };
  });

// ---- 待办清单（T-Mgr-P002-BOARD-02 新增）----
// 用户问"接下来做什么"时，`02_开发计划.md` 只是索引（当前任务/暂缓/候选/历史），
// **真正的待办表在 docs/03_开发进度与问题清单.md**。这里把它读进来，按优先级分组。
//
// 表格形如：`| App-A2 / P1 | 未完成内容 | 下一步/阻塞 |`
// 优先级取 ID 里 `/` 之后那段（`P0`/`P1`/`P2`/`P3`/`P1-P2`/`后置`）。

// ⚠️⚠️ **白话说人话映射**（T-Mgr-P002-BOARD-03）
//
// 用户原话：「后续计划都说的这么高深、看不太懂」。看板直接把问题清单里的
// 开发术语（`Session 重连代际`、`015E 合法 0`、`LVGL` …）呈现出来，
// 而这些**本来就是用户自己提的需求**，只是被写成了黑话。
//
// 约定：
//  1. **只在本文件里做映射，绝不修改 docs/03 原文** —— 原文是问题唯一权威。
//  2. 每项给 `plain`（一句人话）+ 可选的 `origin`（用户原话）+ `impact`（对用户的影响）。
//  3. **拿不准的一律标「原意待确认」，不编一个听起来合理的解释。**
//  4. 映射按 ID 前缀匹配；新增待办若没配映射，看板**照原样显示并标注「未翻译」**，
//     不会静默丢失 —— 缺翻译是可发现的，不是隐形的。
const PLAIN_TODO = {
  'App-A1-M-P': {
    plain: '车上的转向灯/广播信号，停止监听后屏幕上可能还停在最后一个值',
    impact: '平板上已装新包、本地测试通过，但没接真车实测过。',
  },
  'UI-HUD-01': {
    plain: '仪表动效与导出已完成，还差全局开关',
    impact: '你已能在 PC 工具里编辑动画并在设备上看到；还缺「默认关闭」的安全开关。',
  },
  'App-A1其余': {
    plain: '断线重连后，仪表读数可能不刷新、或刷出旧值',
    impact: '开车途中蓝牙断了再接上，可能出现数值卡住。',
  },
  'App-A2': {
    plain: '油耗、进气量这类读数可能算得不准',
    impact: '仪表上显示的油耗/空燃比数字，可信度还没保证。',
  },
  'App-A3/A4': {
    plain: '同时开扫描和监听时，可能出现抢占或收尾不干净',
    impact: '属安全类缺口；正常单任务使用不受影响。',
  },
  'App-A5': {
    plain: '多画布素材已修：每套画布各记自己的素材目录',
    impact: '原来给画布1 导入素材后切到画布2，画布2 的素材会全部消失；现在各自独立。仍没做"把素材打包进设计文件"那条路，真机多画布切换也还没实测。',
  },
  'App-A6': {
    plain: '导入特别大的设计包时，可能卡住或只导入一半',
    impact: '正常大小的设计没问题；超大包才有风险。',
  },
  'App-A7': {
    plain: 'App 切到后台、或规则/日志长时间跑之后的生命周期问题',
    impact: '长时间开车时才可能遇到。',
  },
  'T11-I、T7与排版': {
    plain: '小卡片上的标题字和数字叠在一起了；部分控件缩放不准',
    origin: '你在 2026-10-11 提过「小卡片标题重叠」',
    impact: '这是能直接看见的排版问题。',
  },
  'App-A8/LVGL': {
    plain: '清理一段已经放弃的旧渲染代码，顺带拆几个大文件',
    impact: '纯内部维护，你看不出差别；好处是以后改起来不容易出错。',
  },
  '真车与SPP': {
    plain: '你 10-11 提的三件事：挡位显示格式、指示灯都是一张图、G 力值仪表',
    origin: '原话：「挡位显示的格式不行」「指示灯…而不是全部都是一个图」「G 力值仪表样式不一样」',
    impact: '这些还没做；挡位现在显示 P R N 1 2 3…（缺 D），19 个警示灯共用同一张警告图。',
  },
};

/** 按 ID 前缀找映射；先精确匹配，再前缀匹配 */
function plainOf(id) {
  const code = id.split('/')[0].trim();
  if (PLAIN_TODO[code]) return { ...PLAIN_TODO[code], translated: true };
  // 前缀兜底：`App-A3/A4` 这类带斜杠的 ID 会被 split 拆坏，用原文再试一次
  for (const k of Object.keys(PLAIN_TODO)) {
    if (id.startsWith(k)) return { ...PLAIN_TODO[k], translated: true };
  }
  return { translated: false };
}
const prioRank = s => {
  const t = String(s || '').toUpperCase();
  if (t.includes('P0')) return 0;
  if (t.includes('P1')) return 1;
  if (t.includes('P2')) return 2;
  if (t.includes('P3')) return 3;
  return 9; // 后置 / 无标注
};
const prioLabel = s => {
  const t = String(s || '');
  if (/P0/i.test(t)) return 'P0 · 最要紧';
  if (/P1/i.test(t)) return 'P1 · 接下来该做的';
  if (/P2/i.test(t)) return 'P2 · 有空再做';
  if (/P3/i.test(t)) return 'P3 · 内部整理';
  return '后置 · 需要额外条件';
};
const todos = (() => {
  const text = sources['docs/03_开发进度与问题清单.md'] || '';
  // 只扫「BUG与后续优先级」这一节之后的表格行
  const idx = text.indexOf('## BUG与后续优先级');
  const scope = idx >= 0 ? text.slice(idx) : text;
  const out = [];
  for (const line of scope.split('\n')) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (!m) continue;
    const id = m[1].trim();
    // 跳过表头与分隔行
    if (/^-+$/.test(id) || id === 'ID/优先级') continue;
    const [, idPart, prioPart = ''] = id.split('/');
    const plain = plainOf(id);
    out.push({
      id,
      code: (idPart || id).trim(),
      priority: (prioPart || '').trim(),
      rank: prioRank(prioPart || id),
      group: prioLabel(prioPart || id),
      pending: m[2].trim(),
      next: m[3].trim(),
      // 白话层（只用于看板显示）
      plain: plain.plain || '',
      origin: plain.origin || '',
      impact: plain.impact || '',
      translated: !!plain.translated,
      // 显式跳过（纯内部改动、用户无感）—— 不算"缺白话"，但页面会标出来
      skip: !!plain.skip,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
})();

// ---- 强制：每条待办必须有白话说明（T-Mgr-P002-BOARD-04）----
//
// ## 为什么这里要 throw 而不是警告
//
// 用户原话：「后续更新的话会更新白话吗」。答案是"靠自觉"—— 那就等于会漏。
// 事实：`PLAIN_TODO` 原本只在 README 里提了一句，不在 AGENTS.md 里，
// **换一个 AI 接手基本必漏**，然后看板又悄悄退回一堆黑话。
//
// 所以这里跟既有做法保持一致：像"摘要 taskId 不一致就拒绝生成"那样，
// **忘了补白话就直接让生成失败**，并一次列出全部缺项 + 怎么补。
// 失败是显性的、可修的；静默退化才是最难发现的。
//
// 唯一例外：用户明确说"这条不用白话"时，在 PLAIN_TODO 里写 `{ skip: true }`。
const missingPlain = todos.filter(t => !t.translated && !t.skip);
if (missingPlain.length) {
  const lines = missingPlain.map(t => '  - ' + t.id + '   （' + t.pending.slice(0, 40) + '…）');
  throw new Error(
    [
      '有 ' + missingPlain.length + ' 条待办缺少白话说明，拒绝生成看板。',
      '',
      '缺少的：',
      ...lines,
      '',
      '怎么补：打开 tools/iteration-board/build.js，在 PLAIN_TODO 里按 ID 加一条：',
      "  '你的ID': { plain: '一句人话：这是什么 + 对用户有什么影响',",
      "              impact: '可选：不修会怎样',",
      "              origin: '可选：用户原话（若这条是用户提的）' },",
      '',
      '确属无需白话（纯内部、用户无感）的，写 { skip: true } 显式跳过。',
      '⚠️ 不要为了让它跑过而编一句听起来合理的解释 —— 拿不准就写「原意待确认」。',
    ].join('\n')
  );
}

// ---- 构建与设备信息（新增）----
// 用户关心的"现在装的是哪个包"，看板此前完全没有。
const build = (() => {
  const apk = path.join(root, 'app/build/outputs/apk/debug/app-debug.apk');
  const gradle = read('app/build.gradle.kts');
  const versionName = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1] || '';
  const versionCode = gradle.match(/versionCode\s*=\s*(\d+)/)?.[1] || '';
  if (!fs.existsSync(apk)) {
    return { exists: false, versionName, versionCode };
  }
  const st = fs.statSync(apk);
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
  return {
    exists: true, versionName, versionCode,
    bytes: st.size, mtime: st.mtime.toISOString(), sha256: sha,
    // APK 是否比最后一次提交更新 —— 提醒"改了代码但没重装"
    newerThanHead: st.mtime > new Date(Number(git(['log', '-1', '--format=%ct']).trim()) * 1000),
  };
})();

// ---- 文档分类（新增）----
// 47 份文档平铺一堆，用户找不到重点。按用途分段。
const docGroup = (file) => {
  if (!file.includes('/')) return '协作文件（根目录）';
  if (file.startsWith('docs/01_专题')) return '现行规范与专题';
  if (file.startsWith('docs/02_验证记录')) return '验证记录';
  if (file.startsWith('docs/03_历史归档')) return '历史归档（仅供参考）';
  if (file.startsWith('docs/')) return '项目文档';
  if (file.startsWith('tools/')) return '工具文档';
  return '其他';
};

const data = {
  generated: new Date().toISOString(), summary, sources,
  milestones, releases, recentWork, todos, build,
  docGroups: Object.fromEntries(files.map(f => [f, docGroup(f)])),
  gitStatus: git(['status', '--short']), diffStat: git(['diff', '--stat']),
  commits: git(['log', '-8', '--date=short', '--pretty=format:%h | %ad | %s'])
};
// 清理 < 转义问题：JSON.stringify 已保证合法，这里只防御 U+2028/2029
const payload = JSON.stringify(data).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const template = read('tools/iteration-board/template.html');
if (template.split('/* SNAPSHOT_DATA */').length !== 2) throw new Error('模板数据占位符必须唯一');
fs.writeFileSync(path.join(__dirname, 'index.html'), template.replace('/* SNAPSHOT_DATA */', () => payload));
console.log('迭代看板已更新：' + path.join(__dirname, 'index.html'));
console.log('任务 ' + summary.taskId + ' · ' + summary.review + ' · 原文 ' + files.length + ' 份');
