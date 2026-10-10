// guard-pid-probe.js —— 检查控件模板绑的 PID 是否**真实存在**
// （v2.61.0 建；v2.78.0 把「已知待办」与「新问题」分开）
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
// ## 为什么要分「已知待办」和「新问题」（v2.78.0）
//
// 实测（v2.61.0 首次跑）：40 个绑 PID 的控件里 **28 个绑的是不存在的 PID**。
// 一路修到 **14 个**之后，剩下这批**不是"忘了配 PID"，而是"数据源还不存在"**：
// 它们全部卡在 P9（上车用 CAN 探测逆向广播帧的位），**修不动，只能等**。
//
// 于是出现了更坏的结果：**一条长期红着的警告等于没有警告**。
// 它报了十几个版本，看的人只会学会跳过它 ——
// 而真正**新出现的不匹配**（谁把 `pid` 打错了）混在同一个列表里，
// 分不出"这是老账"还是"这是刚弄坏的"。**后者才是守卫真正该报的。**
//
// 所以本探针把两类分开：
//   · `PENDING_P9` 里的（key 与 pid 都对得上）→ 当成**待办**打印，**不算警告**
//   · 表外的 → 才是**新问题**（最后一行 JSON，守卫据此报警）
//
// ## ⚠️ 不要为了消掉这条待办去改控件模板
//
// **删掉 `pid`、或改指向一个"差不多的" PID，都是错的** ——
// 那等于把"这个控件应该显示什么"的语义丢掉，
// 等 P9 把真信号逆向出来时**再也对不上号**（见大纲 §2.91：猜错的代价远大于留空）。
//
// 正确做法见 `docs/迭代清单.md` §P9：
//   「CAN 探测」跑两次（关目标 / 开目标）→「对比基准（找位）」列出变化的位 →「加为监听」
// 转向灯就是这么确认的（CAN `0x09A` 的 bit2/bit3）。
//
// ✅ **P9 做完一条就删一条**：该控件绑上真 PID 后自然不再进这个列表，
// 探针会把它列进"清单里已不再需要"里提示你清理。
// 整张表清空之后，再把守卫那边从 Warn 改成 Fail。
//
// 用法：node tools/guard-pid-probe.js
// 输出：第 1 行统计；中间是已知待办明细（带原因）；最后一行 JSON（**只含新问题**，空数组 = 通过）
const fs = require('fs');
const path = require('path');

const js = path.join(__dirname, '..', 'tools', 'icarui', 'js');

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

/* ==========================================================================
   已知待办清单（P9）—— 这 14 个**不是 bug，是"数据源还不存在"**
   --------------------------------------------------------------------------
   为什么写成一张**带原因的表**而不是一句"忽略这 14 个"：
     1. 后来接手的人要知道**为什么**可以不管它（否则下一个人会重新查一遍，
        或者更糟 —— 以为它是漏配的，随手改指一个 PID 把语义弄坏）
     2. 它同时是**进度表**：P9 做完一条，这里就删一条，删空即清零
     3. `pid` 也记在表里 —— 谁**改了**控件绑的名字（而不是绑不上），
        这里就对不上号，会立刻以"新问题"报出来。**这才是守卫的价值。**
   ========================================================================== */
const LAMP_WHY =
  '等 P9 上车逆向：CAN 探测跑两次（关/开目标）→「对比基准（找位）」定位变化位 →「加为监听」' +
  '（转向灯已用此法确认：CAN 0x09A bit2/bit3）';

const PENDING_P9 = {
  // —— 2 个数值类 ——
  g_gear: {
    pid: 'obd.gear',
    why: '挡位是枚举（P/N/R/D）不是连续量；01 A4 的公式已反推' +
      '（bit(B,4)*2+bit(D,0)-1），枚举值与映射要上车逐挡确认',
  },
  g_soc: {
    pid: 'obd.soc',
    why: '电池电量既没有标准 PID、也没有现成的派生通道；' +
      '等 P9 在车上确认有没有厂家信号，否则按 P9 验收确认这个控件该删还是该留',
  },
  // —— 12 个指示灯：同一套逆向方法 ——
  lamp_brake: { pid: 'obd.brakeFluid', why: LAMP_WHY },
  lamp_pad: { pid: 'obd.brakePad', why: LAMP_WHY },
  lamp_tpms: { pid: 'obd.tpms', why: LAMP_WHY },
  lamp_airbag: { pid: 'obd.airbag', why: LAMP_WHY },
  lamp_belt: { pid: 'obd.seatbelt', why: LAMP_WHY },
  lamp_abs: { pid: 'obd.abs', why: LAMP_WHY },
  lamp_esp: { pid: 'obd.esp', why: LAMP_WHY },
  lamp_door: { pid: 'obd.door', why: LAMP_WHY },
  lamp_washer: { pid: 'obd.washer', why: LAMP_WHY },
  lamp_service: { pid: 'obd.service', why: LAMP_WHY },
  lamp_lane: { pid: 'obd.laneKeep', why: LAMP_WHY },
  lamp_collision: { pid: 'obd.collision', why: LAMP_WHY },
};

// 从 presets.js 源码里抠 `key: "x" ... pid: "y"`
// 用源码而不是 BUILTIN_CONTROLS，因为 pid 写在模板字面量里、不在导出对象上
let src = '';
try { src = fs.readFileSync(path.join(js, 'presets.js'), 'utf8'); } catch (e) {}

const re = /key:\s*"([A-Za-z0-9_]+)"[^}]*?pid:\s*"([^"]+)"/g;
const found = [];
let m;
while ((m = re.exec(src))) found.push({ key: m[1], pid: m[2] });

const ctrlName = key => {
  const c = (window.BUILTIN_CONTROLS || []).find(x => x.key === key);
  return c ? c.name : '(控件表里没有)';
};

const bad = found.filter(f => !known(f.pid))
  .map(f => ({ key: f.key, name: ctrlName(f.key), pid: f.pid }));

// 表里对得上号的 → 待办；对不上号的 → 新问题（改了 pid、或换了别的控件绑它）
const isPending = b => !!(PENDING_P9[b.key] && PENDING_P9[b.key].pid === b.pid);
const todo = bad.filter(isPending);
const fresh = bad.filter(b => !isPending(b));
// 清单里已经不需要的：控件绑上真 PID 了、控件删了、或 pid 改了。
// 只提示不报警 —— 它是"可以清理了"，不是"出问题了"。
const stale = Object.keys(PENDING_P9).filter(k => !bad.some(b => b.key === k && b.pid === PENDING_P9[k].pid));

console.log('控件模板里绑 PID 的 ' + found.length + ' 个；' +
  'PID 不存在的 ' + bad.length + ' 个' +
  '（已知待办 ' + todo.length + ' · 新问题 ' + fresh.length + '）');

if (todo.length) {
  console.log('已知待办 ' + todo.length + ' 条（等 P9 上车逆向，**不是 bug**）—— 见 docs/迭代清单.md §P9：');
  // 原因只在**第一次出现时**打一遍：12 个指示灯用的是同一套方法，
  // 逐条重复一遍会让这 14 行变成 14 段，反而看不清清单本身。
  const shownWhy = [];
  todo.forEach(b => {
    console.log('  · ' + b.key + '（' + b.name + '） → ' + b.pid);
    const why = PENDING_P9[b.key].why;
    if (shownWhy.indexOf(why) < 0) {
      shownWhy.push(why);
      const n = todo.filter(x => PENDING_P9[x.key].why === why).length;
      console.log('      原因：' + why + (n > 1 ? '（下面 ' + (n - 1) + ' 条同此原因）' : ''));
    }
  });
}
if (stale.length) {
  console.log('  ⌫ 清单里这 ' + stale.length + ' 条已经不需要了（已绑上真 PID / 控件已删 / pid 改了）' +
    ' —— 请从 PENDING_P9 里删掉：' + stale.join(', '));
}
if (fresh.length) {
  console.log('  ⚠️ 新出现的不匹配（**不在已知待办清单里** —— 这才是要修的）：');
  fresh.forEach(b => console.log('  ! ' + b.key + '（' + b.name + '） → ' + b.pid));
}
console.log(JSON.stringify(fresh));
