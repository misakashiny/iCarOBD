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
const files = ['03_当前任务.md', '02_开发计划.md', '04_交接状态.md', '01_项目规格.md', 'AGENTS.md', 'README.md', 'tools/iteration-board/README.md', 'tools/icarui/README.md',
  ...fs.readdirSync(path.join(root, 'docs')).filter(n => /^\d\d_.*\.md$/.test(n)).map(n => 'docs/' + n),
  ...fs.readdirSync(path.join(root, 'docs/01_专题')).filter(n => n.endsWith('.md')).map(n => 'docs/01_专题/' + n),
  'docs/02_验证记录/00_验证索引.md', 'docs/03_历史归档/00_归档说明.md'];
for (const d of summary.docs) {
  if (typeof d.file !== 'string' || path.isAbsolute(d.file) || d.file.split(/[\\/]/).includes('..')) throw new Error('非法摘要文件路径');
  if (!files.includes(d.file) && fs.existsSync(path.join(root, d.file))) files.push(d.file);
}
const sources = Object.fromEntries(files.map(file => [file, read(file)]));
const sections = (text, pattern) => [...text.matchAll(/^## (.+)$/gm)].filter(m => pattern.test(m[1])).map((m, i, a) => ({ title: m[1], text: text.slice(m.index, a[i + 1]?.index ?? text.length) }));
const data = {
  generated: new Date().toISOString(), summary, sources,
  milestones: sections(plan, /^\d+\./).map(s => ({ title: s.title, status: s.text.match(/^状态：(.*)$/m)?.[1] ?? '待安排（未标完成）', text: s.text })),
  releases: ['docs/07_版本更新日志.md'].flatMap(file => sections(sources[file], /^\d{4}-\d{2}/).slice(0, 6).map(s => ({ ...s, file }))),
  gitStatus: git(['status', '--short']), diffStat: git(['diff', '--stat']),
  commits: git(['log', '-8', '--date=short', '--pretty=format:%h | %ad | %s'])
};
const payload = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const template = read('tools/iteration-board/template.html');
if (template.split('/* SNAPSHOT_DATA */').length !== 2) throw new Error('模板数据占位符必须唯一');
fs.writeFileSync(path.join(__dirname, 'index.html'), template.replace('/* SNAPSHOT_DATA */', () => payload));
console.log('迭代看板已更新：' + path.join(__dirname, 'index.html'));
console.log('任务 ' + summary.taskId + ' · ' + summary.review + ' · 原文 ' + files.length + ' 份');
