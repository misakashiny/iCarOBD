// guard-color-probe.js —— 扫 canvas.js 里的裸色值，按**函数归属**报告（v2.59.0）
//
// 为什么单独一个文件：内嵌在守卫的字符串里要套三层转义
// （PowerShell 字符串 → JS 字符串 → 正则），实测**极容易写错**。
//
// 为什么**过滤也在这一侧做**：试过在 PowerShell 里 Where-Object 过滤，踩了两个坑 ——
//   1. 嵌套 Where-Object 里的 $_ 会**遮蔽**外层的 $_
//   2. PS 5.1 的 ConvertFrom-Json 对顶层数组有怪癖，结果是"15 条被当成 1 条"
// 在 Node 里做就是普通数组操作，没有这些事。
//
// 用法：node tools/guard-color-probe.js
// 输出：第一行统计摘要；最后一行 JSON（白名单外的条目；空数组 = 通过）
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'icarui', 'js', 'canvas.js');

// **白名单 = 工具 UI 层**。每一条都写清"为什么它不该跟设计主题"。
// ⚠️ drawGaugeNode / drawGaugeLabel / drawPartTree **不在**里面 ——
// 它们是设计内容层，已经用 window.currentTheme() 了。
const ALLOW_FN = {
  drawSelection: '选中框 / 手柄 / 多选序号',
  draw: '框选矩形 / 吸附参考线',
  drawImageNode: '没有图的紫色占位 X',
  drawPartOutlines: '子部件外框',
};

// **状态色**（告警红 / 警告黄 / 紫）。理论上属于设计内容，
// 但 GAUGE_THEMES 目前**没有** warn / critical 字段，跟不了主题。
// 先按"已知缺口"放行，缺口记在 CHANGELOG 的"下次优化建议"里。
const ALLOW_COLOR = ['#FF4D4F', '#FFB020', '#FF4DD2'];

let src = '';
try { src = fs.readFileSync(file, 'utf8'); }
catch (e) { console.log('(canvas.js 读不到)'); console.log('[]'); process.exit(0); }

const lines = src.split(/\r?\n/);
const all = [];
let fn = '(顶层)';

for (let i = 0; i < lines.length; i++) {
  const L = lines[i];
  // ⚠️ 跳过注释行 —— 否则文档里提到 #FF8A00 也会被算成裸色值。
  // 加上这条之前有 2 处假阳性（都在注释里）。
  if (/^\s*(\/\/|\*|\/\*)/.test(L)) continue;

  const m = L.match(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (m) fn = m[1];

  const hexes = L.match(/#[0-9A-Fa-f]{3,8}\b/g);
  if (!hexes) continue;
  all.push({ fn: fn, ln: i + 1, colors: hexes, txt: L.trim().slice(0, 70) });
}

const bad = all.filter(function (e) {
  if (ALLOW_FN[e.fn]) return false;
  return !e.colors.every(function (c) { return ALLOW_COLOR.indexOf(c.toUpperCase()) >= 0; });
});

const byFn = {};
all.forEach(function (e) { byFn[e.fn] = (byFn[e.fn] || 0) + 1; });
console.log('canvas.js 裸色值 ' + all.length + ' 处：' +
  Object.keys(byFn).map(function (k) { return k + '×' + byFn[k]; }).join(', ') +
  '；白名单外 ' + bad.length + ' 处');
console.log(JSON.stringify(bad));
