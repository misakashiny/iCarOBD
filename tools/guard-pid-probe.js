// guard-pid-probe.js —— 检查控件模板绑的 PID 是否**真实存在**（v2.61.0）
//
// ## 为什么需要这条
//
// 所有仪表控件的 `make()` 都是这个模式：
//
//     const info = window.BUILTIN_PIDS[window.resolvePid(d.pid)] || {};
//     min: info.min !== undefined ? info.min : 0,
//     max: info.max !== undefined ? info.max : 100,
//
// **查不到就用 0~100 兜底。** 于是"挡位显示"（`obd.gear`）变成了
// "一个 0~100 的数字表" —— 没有报错、没有警告，控件能加能拖能显示，
// 只是**语义完全不对**。用户得先知道"这里应该是挡位"才看得出来。
//
// 实测：`g_gear` 绑 `obd.gear`、`g_gearbox` 绑 `obd.gearTemp`，
// 两个都**既不在 BUILTIN_PIDS 也不在 PID_ALIASES** 里。
//
// 用法：node tools/guard-pid-probe.js
// 输出：第一行统计；最后一行 JSON（有问题的条目；空数组 = 通过）
const fs = require('fs');
const path = require('path');

const js = path.join(__dirname, '..', 'tools', 'theme-studio', 'js');
const root = path.join(__dirname, '..', 'tools', 'theme-studio');

global.window = global;
try {
  require(path.join(js, 'schema.js'));
  require(path.join(js, 'presets.js'));
} catch (e) {
  console.log('(加载 schema/presets 失败)');
  console.log('[]');
  process.exit(0);
}

const PIDS = window.BUILTIN_PIDS || {};
const ALIASES = window.PID_ALIASES || {};
// ⚠️ **必须解析到真实 PID**（v2.66.0 修）。
//
// 原来写的是 `!!(PIDS[k] || ALIASES[k])` —— 只要**别名存在**就算通过，
// **不管它指向的 PID 是否真实存在**。
//
// 实测踩到：加了 `obd.oilPressure -> tpl_oilPressure` 的别名，
// 但 `tpl_oilPressure` 这个 PID **根本没定义** —— 探针却报"修好了"。
// **这是假阴性，比不检查更糟。**
//
// 现在多走一层：别名 -> 目标 -> 目标必须是个真 PID。
const resolve = k => (PIDS[k] ? k : (ALIASES[k] || k));
const known = k => !!PIDS[resolve(k)];

// 从 presets.js 源码里抠 `key: "x" ... pid: "y"`
// 用源码而不是 BUILTIN_CONTROLS，因为 pid 写在模板字面量里、不在导出对象上
let src = '';
try { src = fs.readFileSync(path.join(js, 'presets.js'), 'utf8'); } catch (e) {}

const re = /key:\s*"([A-Za-z0-9_]+)"[^}]*?pid:\s*"([^"]+)"/g;
const found = [];
let m;
while ((m = re.exec(src))) found.push({ key: m[1], pid: m[2] });

const bad = found.filter(f => !known(f.pid)).map(f => {
  const c = (window.BUILTIN_CONTROLS || []).find(x => x.key === f.key);
  return { key: f.key, name: c ? c.name : '(控件表里没有)', pid: f.pid };
});

console.log('控件模板里绑 PID 的 ' + found.length + ' 个；' +
  'PID 不存在的 ' + bad.length + ' 个' +
  (bad.length ? '（' + bad.map(b => b.key + '→' + b.pid).join(', ') + '）' : ''));
console.log(JSON.stringify(bad));
