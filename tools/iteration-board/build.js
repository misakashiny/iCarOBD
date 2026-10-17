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

const data = {
  generated: new Date().toISOString(), summary, sources,
  milestones, releases, recentWork,
  gitStatus: git(['status', '--short']), diffStat: git(['diff', '--stat']),
  commits: git(['log', '-8', '--date=short', '--pretty=format:%h | %ad | %s'])
};
const payload = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const template = read('tools/iteration-board/template.html');
if (template.split('/* SNAPSHOT_DATA */').length !== 2) throw new Error('模板数据占位符必须唯一');
fs.writeFileSync(path.join(__dirname, 'index.html'), template.replace('/* SNAPSHOT_DATA */', () => payload));
console.log('迭代看板已更新：' + path.join(__dirname, 'index.html'));
console.log('任务 ' + summary.taskId + ' · ' + summary.review + ' · 原文 ' + files.length + ' 份');
