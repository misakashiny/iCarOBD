// 验证：预览的**弹簧指针** / 数据化盘面 / 弧进度（stroke-dashoffset）/ 数字鼓（v2.81.0）
//
// ## 这个套件为什么分两半
//
// `js/spring.js` 是**纯函数**（不碰 DOM），所以一半断言直接在 **Node** 里跑：
// 弹簧的稳定性 / 过冲 / 收敛、盘面重建、dashoffset 换算、数字鼓步长
// 全是"给定输入必然得到某个输出"的东西 —— 用像素指纹去测它们既脆又慢。
//
// 另一半必须在浏览器里：绘制层的接线（真的调了 setLineDash 吗？
// 指针真的读弹簧而不是真值吗？让位标志真的生效吗？）。
//
// ⚠️ 不要在 `cdp.eval` 的模板串里写反引号 —— 外层就是模板串，
// 套两层转义会变成"看得见却查不出来"的语法错误（大纲 §2.49）。
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PAGE = path.join(__dirname, '..', 'index.html');
const URL_PAGE = require('url').pathToFileURL(PAGE).href;
const PORT = 9263;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, m + (Math.abs(a - b) <= tol ? '' : `（实际 ${a}，期望 ${b}±${tol}）`));
const r3 = v => Math.round(v * 1000) / 1000;

// ============================================================================
// 第一部分：纯函数（不需要浏览器）
// ============================================================================

global.window = {};
require(path.join(__dirname, '..', 'js', 'spring.js'));
const W = global.window;

/** 从 0 起步、跑 steps 步，返回终点与峰值（峰值 = 过冲的证据） */
function runSpring(k, c, steps, dt, target) {
  const s = new W.Spring({ k: k, c: c, x: 0 });
  let peak = -Infinity;
  for (let i = 0; i < steps; i++) { s.step(target, dt); peak = Math.max(peak, s.x); }
  return { x: s.x, peak: peak, steps: s.steps };
}

(async () => {

  console.log('\n=== 1. 弹簧：稳定性判据（纯函数）===');
  {
    const chk = W.springCheck(150, 19, 1 / 60);
    console.log('    · ' + JSON.stringify({
      hooke: r3(chk.hooke), damp: r3(chk.damp), zeta: r3(chk.zeta),
      stable: chk.stable, overshoot: chk.overshoot, settleSteps: chk.settleSteps,
    }));
    ok(chk.stable, '**默认参数稳定**（k·dt² < 4 且 c·dt < 2）');
    ok(chk.hooke < 4, 'k·dt² = ' + r3(chk.hooke) + ' < 4');
    ok(chk.damp < 2, 'c·dt = ' + r3(chk.damp) + ' < 2');
    near(chk.zeta, 0.776, 0.02, '阻尼比 ζ = c/(2√k) ≈ 0.776（**轻微欠阻尼** —— 这就是"像真针"的来源）');
    ok(chk.overshoot, 'ζ < 1 → 会过冲再回正（不是临界/过阻尼）');
    // 参考实现给的 dt 上限：0.05
    const atMax = W.springCheck(150, 19, 0.05);
    ok(atMax.stable, 'dt 取上限 0.05 仍然稳定（k·dt²=' + r3(atMax.hooke) + '、c·dt=' + r3(atMax.damp) + '）');
    // 发散边界：这两个必须被判成**不稳定**，否则判据本身没在干活
    const bad1 = W.springCheck(2000, 19, 0.05);
    ok(!bad1.stable, 'k=2000、dt=0.05 → k·dt²=' + r3(bad1.hooke) + ' ≥ 4 → **判为不稳定**');
    const bad2 = W.springCheck(150, 100, 0.05);
    ok(!bad2.stable, 'c=100、dt=0.05 → c·dt=' + r3(bad2.damp) + ' ≥ 2 → **判为不稳定**');
    ok(!W.springCheck(150, 100, 1 / 60).overshoot, 'ζ > 1 时不再过冲（过阻尼）');
  }

  console.log('\n=== 2. 弹簧：过冲 / 收敛 / dt 夹取（纯函数）===');
  {
    const d = runSpring(150, 19, 200, 1 / 60, 100);
    console.log('    · 默认参数 200 步后 x=' + r3(d.x) + '，峰值=' + r3(d.peak));
    ok(d.peak > 100.2, '**有轻微过冲**（峰值 ' + r3(d.peak) + ' > 100）—— 到位时"顶一下再回正"');
    ok(d.peak < 104, '过冲不过头（峰值 < 104，约 ' + r3((d.peak - 100)) + '%）');
    near(d.x, 100, 0.01, '**收敛**：200 步（约 3.3 秒）后误差 < 0.01');

    const over = runSpring(150, 100, 200, 1 / 60, 100);
    ok(over.peak <= 100.0001, '过阻尼（c=100）**不过冲**：峰值 ' + r3(over.peak) + ' ≤ 100');
    const under = runSpring(150, 5, 200, 1 / 60, 100);
    ok(under.peak > 130, '欠阻尼（c=5）**大幅过冲**：峰值 ' + r3(under.peak) + '（参数确实在起作用）');

    // dt 夹取：传 10 秒必须与传 0.05 秒等价（否则切回标签页时 k·dt² 直接发散）
    const a = new W.Spring({ x: 0 }), b = new W.Spring({ x: 0 });
    a.step(100, 10); b.step(100, 0.05);
    eq(a.x, b.x, '**dt 被夹到 0.05**：step(target, 10) 与 step(target, 0.05) 结果相同');
    eq(a.v, b.v, '速度也相同（夹取发生在积分之前）');
    const c1 = new W.Spring({ x: 5 });
    eq(c1.step(100, 0), 5, 'dt = 0 → 不动（非法 dt 不动比乱动好）');
    eq(c1.step(100, NaN), 5, 'dt = NaN → 不动');
    c1.step(100, 1 / 60);
    c1.step(null, 1 / 60);
    eq(c1.target, 100, 'target 传 null → **沿用上一次目标**（缺一个采样不该把指针拉回 0）');
  }

  console.log('\n=== 3. 弹簧池：一根 PID 一根弹簧（纯函数）===');
  {
    const bank = new W.SpringBank();
    bank.active = true;
    bank.snap('std_0C', 0);
    bank.snap('std_0D', 100);
    bank.step({ 'std_0C': 8000 }, 1 / 60);
    ok(bank.peek('std_0C') > 0 && bank.peek('std_0C') < 8000, '**只推进 targets 里有的**：std_0C 朝目标动了（' + r3(bank.peek('std_0C')) + '，一步不可能到位）');
    eq(bank.peek('std_0D'), 100, '没进 targets 的 std_0D **原地不动**');
    eq(bank.peek('nope', 42), 42, 'peek 一个不存在的 key 返回 fallback，**且不创建**');
    eq(bank.has('nope'), false, 'peek 不会偷偷建弹簧');
    eq(bank.size(), 2, '池里 2 根弹簧');
    bank.params(300, 5);
    eq(bank.get('std_0C').k, 300, '改参数**对已有的弹簧也生效**（不用重建）');
    eq(bank.get('std_0C').c, 5, '阻尼也跟着改');
    bank.clear();
    eq(bank.size(), 0, 'clear 清空');
  }

  console.log('\n=== 4. 让位仲裁：同一时刻只有一个系统能写（纯函数）===');
  {
    const ar = new W.AnimArbiter();
    ok(ar.allows('sim'), '没人占用时，实时数据可以写');
    ar.claim('tween', 5000, 'boot-sweep');
    ok(!ar.allows('sim'), '**补间占用时，实时数据让位**（这就是参考实现那个坑的解药）');
    ok(ar.allows('tween'), '占用者自己可以写');
    eq(ar.ownerNow(), 'tween', 'owner = tween');
    ar.release('sim');
    eq(ar.ownerNow(), 'tween', '**别人不能替它交还**（防止误放行）');
    ar.release('tween');
    ok(ar.allows('sim'), '交还后实时数据恢复');
    const ar2 = new W.AnimArbiter();
    ar2.claim('tween', 30);
    eq(ar2.ownerNow(Date.now() + 100), null, '**超时自动过期** —— claim 的一方崩了也不会把实时数据永久锁死');
    ok(ar2.allows('sim'), '过期后实时数据自动恢复');
  }

  console.log('\n=== 5. 弧进度：stroke-dashoffset 换算（纯函数）===');
  {
    const d0 = W.arcDash(100, 0), d1 = W.arcDash(100, 1), dh = W.arcDash(100, 0.25);
    eq(d0.dasharray, 100, 'dasharray = 整条路径长度');
    eq(d0.dashoffset, 100, '**进度 0 → dashoffset = len（1 = 空）**');
    eq(d1.dashoffset, 0, '**进度 1 → dashoffset = 0（0 = 满）**');
    eq(dh.dashoffset, 75, '进度 0.25 → dashoffset = 75（线性）');
    eq(W.arcDash(100, 2).dashoffset, 0, '进度 > 1 夹到 1（不会画出负的 dashoffset）');
    eq(W.arcDash(100, -1).dashoffset, 100, '进度 < 0 夹到 0');
    // canvas 侧的接线（用假 ctx，纯逻辑）
    const fake = { lineDashOffset: 0, setLineDash(a) { this.dash = a; } };
    W.applyArcProgress(fake, 235.6, 0.5);
    eq(fake.dash.length, 1, 'setLineDash 传**单元素**数组（canvas 里等价于 [len, len]）');
    near(fake.dash[0], 235.6, 0.01, 'dash 段长 = 弧长');
    near(fake.lineDashOffset, 117.8, 0.01, 'lineDashOffset = len × (1 - 进度)');
    W.clearArcProgress(fake);
    eq(fake.dash.length, 0, 'clearArcProgress 还原成实线（**不还原的话后面所有线都变虚线**）');
    eq(fake.lineDashOffset, 0, 'lineDashOffset 也归零');
  }

  console.log('\n=== 6. 表盘几何：刻度是"算"出来的（纯函数）===');
  {
    const rpm = W.buildDial({ min: 0, max: 8000, r: 150, cx: 200, cy: 200 });
    eq(rpm.majorStep, 1000, '0~8000（转速）→ 大格步长 1000');
    eq(rpm.labels.length, 9, '0~8000 → 9 个数字（0…8000，**正好落在 max**）');
    eq(rpm.labels[rpm.labels.length - 1].text, '8000', '最后一个数字 = 8000');
    eq(rpm.ticks.length, 33, '刻度线 = 9 大格 + 8×3 小格 = 33 根');
    near(rpm.arc.len, 150 * 270 * Math.PI / 180, 1e-6, '整段弧长 = r·θ（画进度弧时当 dasharray 用）');

    const speed = W.buildDial({ min: 0, max: 260 });
    eq(speed.majorStep, 20, '0~260（车速）→ 步长 20（不是 25/50 —— 那些会给出 0/25/50… 这种没人用的刻度）');
    eq(speed.labels.length, 14, '0~260 → 14 个数字，正好到 260');
    const cool = W.buildDial({ min: -40, max: 215 });
    eq(cool.majorStep, 20, '-40~215（水温）→ 步长 20');
    eq(cool.labels[0].text, '-40', '第一个数字 = -40（**min 对齐**：否则会标出 -25 这种 min 以下的数）');
    const volt = W.buildDial({ min: 0, max: 20 });
    eq(volt.majorStep, 2, '0~20（电压）→ 步长 2（整数优先于 2.5）');

    eq(r3(rpm.val2ang(8000)), 405, 'val2ang(max) = 405°（缺口在正下方）');
    eq(r3(rpm.val2ang(4000)), 270, 'val2ang(中点) = 270°');
    eq(r3(rpm.val2ang(-999)), 135, '**超出量程的值夹到端点**（指针不跑出表盘）');
    eq(r3(rpm.val2ang(1e9)), 405, '超上限同理');

    // 显式给大格数（老口径）仍然支持
    const exp = W.buildDial({ min: 0, max: 100, major: 4, minor: 4 });
    eq(exp.labels.map(l => l.text).join(','), '0,25,50,75,100', '显式 major=4 → 均匀 5 个数字（最后一格必定落在 max）');

    // 红区：单段（参考实现的 redlineFrom）与两段（水温：两端都不正常）
    const one = W.buildDial({ min: 0, max: 8000, redlineFrom: 6500 });
    eq(one.redlines.length, 1, 'redlineFrom → 1 段红区');
    near(one.redlines[0].angFrom, 354.375, 0.01, '红区起点角度 = val2ang(6500)');
    near(one.redlines[0].angTo, 405, 0.01, '红区默认到 max');
    const two = W.buildDial({ min: -40, max: 215, redlines: [{ from: -40, to: 60 }, { from: 105, to: 215 }] });
    eq(two.redlines.length, 2, '两段红区（水温：低于 60 与高于 105 都不正常）');
    eq(W.buildDial({ min: 0, max: 100, redlineFrom: 200 }).redlines.length, 0, '红区完全在量程外 → 丢掉（不画半截）');

    // 退化输入：不许抛，也不许画出 0 根刻度就崩
    const deg = W.buildDial({ min: 5, max: 5 });
    eq(deg.ticks.length, 0, 'min == max → 0 根刻度（不除零、不抛）');
    eq(deg.val2ang(7), 135, 'min == max → val2ang 返回起点角度');
    eq(W.buildDial({ min: 0, max: 100, major: 1e9 }).labels.length, 61, 'major 手填成 1e9 → 夹到 60 格（否则浏览器冻死）');
  }

  console.log('\n=== 7. 盘面签名：量程 / 单位 / 红区一变就必须重建（纯函数）===');
  {
    const base = { min: 0, max: 100 };
    eq(W.dialSig(base), W.dialSig({ min: 0, max: 100 }), '同样的输入 → 同样的签名');
    ok(W.dialSig(base) !== W.dialSig({ min: 0, max: 101 }), '**改量程 → 签名变**（盘面必须重建）');
    ok(W.dialSig(base) !== W.dialSig({ min: 0, max: 100, unit: '℃' }), '**改单位 → 签名变**（参考实现踩过的坑：页脚写"能量回收 %"而盘面还标到 300）');
    ok(W.dialSig(base) !== W.dialSig({ min: 0, max: 100, redlineFrom: 80 }), '改红区 → 签名变');
    ok(W.dialSig(base) !== W.dialSig({ min: 0, max: 100, majorTarget: 6 }), '改刻度密度 → 签名变');
    ok(W.dialSig(base) !== W.dialSig({ min: 0, max: 100, r: 90 }), '改半径 → 签名变');
    ok(W.dialSig({ min: 0, max: 100, major: null }) !== W.dialSig({ min: 0, max: 100, major: 8 }),
      '**"自动"与"显式 8 格"是两种模式** → 签名必须不同（不能把 null 落成 0/8）');
  }

  console.log('\n=== 8. 刻度数字的疏密：挤了就隔一个（纯函数）===');
  {
    const speed = W.buildDial({ min: 0, max: 260, r: 72 });
    const rpm = W.buildDial({ min: 0, max: 8000, r: 72 });
    eq(W.dialLabelStride(speed, 6, 45), 1, '14 个数字但字号小（6px）→ 全画');
    eq(W.dialLabelStride(speed, 12, 45), 2, '**14 个数字 + 12px 字号 → 隔一个画一个**（不然在 270° 弧上糊成一片）');
    eq(W.dialLabelStride(rpm, 12, 45), 2, '转速表 9 个数字（4 位数）也偏挤 → 隔一个');
    eq(W.dialLabelStride(W.buildDial({ min: 0, max: 100, major: 2 }), 10, 60), 1, '只有 3 个数字 → 全画');
  }

  console.log('\n=== 9. 数字鼓：三个坑（纯函数）===');
  {
    // 坑 1：yPercent 是相对**条带自身高度**的百分比 —— 行数一变步长就变
    const d10 = W.drumSlot(3, { rows: 10, rowH: 20 });
    const d20 = W.drumSlot(3, { rows: 20, rowH: 20 });
    eq(d10.stepPct, 10, '10 行时一行 = 10%');
    eq(d20.stepPct, 5, '**20 行时一行 = 5%**（行数一变步长就变 —— 参考实现改成 20 行时忘了这步）');
    eq(d10.offsetPx, -60, '10 行：位移 60px（**像素口径**）');
    eq(d20.offsetPx, -60, '**20 行：位移还是 60px** —— 像素口径与行数无关，位置仍然对');
    eq(d20.pctToPx(d10.offsetPct), 120, '把"10 行时算出的 30%"贴到 20 行的条带上 → 变成 120px（**2 倍** —— 这就是"数字显示成 2 倍"的成因）');
    eq(d20.offsetPct, 15, '20 行时正确百分比是 15%，不是 30%');

    // 坑 3：只向前滚，不依赖 onComplete 回位
    const n99 = W.drumSlot(9.9, { rows: 10, rowH: 20 });
    eq(n99.digit, 9, '9.9 → 当前位是 9');
    eq(n99.nextDigit, 0, '9.9 → 下一位是 0（**继续前滚**，不是倒着滑回去）');
    near(n99.digitDy, -18, 0.001, '9.9 → 当前位已滚上去 90%');
    near(n99.nextDigitDy, 2, 0.001, '9.9 → 下一位刚从下面进来');
    const n101 = W.drumSlot(10.1, { rows: 10, rowH: 20 });
    near(n101.wrapped, 0.1, 1e-9, '10.1 → 取模回 0.1（**位置只由值决定**，不需要"动画播完再复位"）');
    eq(n101.digit, 0, '10.1 → 当前位是 0');
    eq(W.drumSlot(-1.5, { rows: 10, rowH: 20 }).wrapped, 8.5, '负值也能取模到条带内（不会算出负位移）');

    // 多位：只有最低位跟着小数滚
    const dd = W.drumDigits(12.4, { rowH: 20, digits: 3 });
    eq(dd.text, '012', '12.4 按 3 位补零（画的时候前导零不画，但**格子位置固定**）');
    near(dd.slots[0].digitDy, 0, 1e-9, '高位数字不滚（dy = 0）');
    near(dd.slots[1].digitDy, 0, 1e-9, '十位也不滚');
    near(dd.slots[2].digitDy, -8, 1e-9, '**最低位跟着小数滚**：12.4 → 滚了 0.4 行 = 8px');
    eq(dd.slots[2].digit, 2, '最低位当前数字 = 2');
    eq(dd.slots[2].nextDigit, 3, '最低位的下一位 = 3（正从下面滚进来）');
    // 坑 2：位置**每帧现算**（纯函数 = 无状态），同一个输入永远同一个输出
    eq(W.drumDigits(12.4, { rowH: 20, digits: 3 }).slots[2].digitDy,
      dd.slots[2].digitDy, '同样输入 → 同样输出（**无缓存**，所以"补间被打断后锁死 888"不可能发生）');
  }

  console.log('\n=== 10. 零安装形态：不许引入需要构建的依赖 ===');
  {
    const dir = path.join(__dirname, '..');
    const src = fs.readFileSync(path.join(dir, 'js', 'spring.js'), 'utf8');
    ok(!/\brequire\s*\(/.test(src), 'spring.js 里没有 require()');
    ok(!/^\s*import\s/m.test(src), 'spring.js 里没有 import 语句');
    ok(!/import\s*\(/.test(src), 'spring.js 里没有动态 import()');
    ok(!/fetch\s*\(/.test(src), 'spring.js 里没有 fetch（file:// 下会被 CORS 挡住）');
    ok(!/XMLHttpRequest/.test(src), 'spring.js 里没有 XHR');
    ok(!/export\s+(default|const|function)/.test(src), 'spring.js 不是 ES module（经典 script 才能双击即用）');
    ok(!fs.existsSync(path.join(dir, 'package.json')), 'icarui 目录下**没有 package.json**（零安装）');
    ok(!fs.existsSync(path.join(dir, 'node_modules')), 'icarui 目录下**没有 node_modules**');
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    // ⚠️ 只认 **script 标签里的 src**，不要在整份 HTML 里 indexOf ——
    //    注释里也会提到 `js/app.js`（"数据由 js/app.js 陆续注入"），
    //    用 indexOf 会命中注释，得到"spring.js 在 app.js 之后"的假结论（实测踩过）。
    const srcs = [];
    const re = /<script[^>]*src="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) srcs.push(m[1]);
    const iSpring = srcs.indexOf('js/spring.js');
    const iCanvas = srcs.indexOf('js/canvas.js');
    const iApp = srcs.indexOf('js/app.js');
    ok(iSpring >= 0 && iSpring < iCanvas && iSpring < iApp,
      'index.html 的 script 标签里 spring.js **在 canvas.js / app.js 之前**加载（两边都要用它）');
    ok(srcs.every(s => !/^https?:|^\/\//i.test(s)), 'index.html 里**没有一个外部脚本**（全走本地相对路径，file:// 下没有 404 兜底）');
    ok(srcs.every(s => fs.existsSync(path.join(dir, s))), '每个 <script src> 都真的在磁盘上（共 ' + srcs.length + ' 个）');
    ok(!srcs.some(s => /gsap/i.test(s)), '**没有引入 GSAP**（弹簧自己写，10 行的事；注释里提到 GSAP 不算）');
  }

  // ==========================================================================
  // 第二部分：浏览器里的接线
  // ==========================================================================

  const getJson = p => new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  class CDP {
    constructor(ws) { this.ws = ws; this.id = 0; this.w = new Map(); this.events = []; }
    static async connect(u) {
      const ws = new WebSocket(u);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      const c = new CDP(ws);
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (m.id && c.w.has(m.id)) { const { res, rej } = c.w.get(m.id); c.w.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
        else if (m.method) c.events.push(m);
      };
      return c;
    }
    send(m, p, timeoutMs) {
      const id = ++this.id;
      const LIMIT = timeoutMs || 12000;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          if (this.w.has(id)) { this.w.delete(id); rej(new Error('CDP 超时（' + LIMIT + 'ms）: ' + m)); }
        }, LIMIT);
        this.w.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
        try { this.ws.send(JSON.stringify({ id, method: m, params: p })); }
        catch (e) { clearTimeout(timer); this.w.delete(id); rej(e); }
      });
    }
    async eval(e) {
      const TRANSIENT = /-32000|navigated or closed|Target closed|Session closed/i;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + ((r.exceptionDetails.exception || {}).description || ''));
          return r.result.value;
        } catch (err) {
          lastErr = err;
          if (!TRANSIENT.test(String(err && err.message))) throw err;
          await sleep(350 * (attempt + 1));
        }
      }
      throw lastErr;
    }
  }

  async function waitReady(cdp, timeoutMs) {
    const t0 = Date.now();
    const limit = timeoutMs || 20000;
    while (Date.now() - t0 < limit) {
      try {
        const r = await cdp.eval("!!(window.CanvasState && (window.BUILTIN_ASSETS||[]).length > 0 && document.getElementById('cv') && document.getElementById('cv').width > 0 && window.BUILTIN_DATA_DONE !== false)");
        if (r) return true;
      } catch (e) { /* 页面还没起来 */ }
      await sleep(200);
    }
    return false;
  }

  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${os.tmpdir()}\\edge-spring`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await getJson('/json/version'); break; } catch (e) { await sleep(250); } }
    const t = (await getJson('/json/list')).find(x => x.type === 'page');
    const cdp = await CDP.connect(t.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL_PAGE });
    await waitReady(cdp);
    await require('./_common').stubDialogs(cdp);

    const errs = cdp.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
    console.log('\n=== 11. 页面加载（浏览器）===');
    errs.slice(0, 5).forEach(e => console.log('    ⚠️ ' + (e.params.exceptionDetails ?
      e.params.exceptionDetails.text : e.params.entry.text).split('\n')[0]));
    ok(errs.length === 0, `无 JS 错误（${errs.length} 条）`);
    eq(await cdp.eval('typeof window.Spring'), 'function', 'window.Spring 在页面里可用');
    eq(await cdp.eval('typeof window.buildDial'), 'function', 'window.buildDial 可用');
    eq(await cdp.eval('typeof window.drumSlot'), 'function', 'window.drumSlot 可用');
    eq(await cdp.eval('!!(window.CanvasState.simSprings && window.CanvasState.anim)'),
      true, 'CanvasState 上已经装好弹簧池与让位仲裁（渲染层要读它们）');
    eq(await cdp.eval('(window.SETTINGS||{}).springK'), 150, '界面设置里的默认 k = 150');
    eq(await cdp.eval('(window.SETTINGS||{}).springC'), 19, '界面设置里的默认 c = 19');

    // ---------- 12) 盘面缓存 / 重建 ----------
    console.log('\n=== 12. 盘面：缓存命中与"量程变了就重建"（浏览器）===');
    {
      const r = await cdp.eval(`(() => {
        const o = { min: 0, max: 8000, r: 100, cx: 0, cy: 0 };
        const a = window.dialFaceFor(o);
        const b = window.dialFaceFor({ min: 0, max: 8000, r: 100, cx: 0, cy: 0 });
        const c = window.dialFaceFor({ min: 0, max: 8000, r: 100, cx: 0, cy: 0, unit: 'rpm' });
        const d = window.dialFaceFor({ min: 0, max: 260, r: 100, cx: 0, cy: 0 });
        window.dialCacheClear();
        for (let i = 0; i < 60; i++) window.dialFaceFor({ min: 0, max: 100 + i, r: 100, cx: 0, cy: 0 });
        const sizeAfter60 = window.dialCacheSize();
        window.dialCacheClear();
        return JSON.stringify({
          同签名同一个对象: a === b,
          改单位是新的: a !== c,
          改量程是新的: a !== d,
          原盘面未被改写: a.labels[a.labels.length - 1].text,
          新盘面: d.labels[d.labels.length - 1].text,
          原签名: a.sig, 新签名: d.sig,
          sizeAfter60: sizeAfter60,
        });
      })()`);
      const D = JSON.parse(r);
      ok(D.同签名同一个对象, '**同签名 → 同一个盘面对象**（缓存命中，不每帧重算 33 根刻度）');
      ok(D.改单位是新的, '**改单位 → 新的盘面**');
      ok(D.改量程是新的, '**改量程 → 新的盘面**');
      eq(D.原盘面未被改写, '8000', '旧盘面**没有被就地改写**（否则"改回去"会看到串味的刻度）');
      eq(D.新盘面, '260', '新盘面按 260 重新算');
      ok(D.原签名 !== D.新签名, '签名不同：' + D.原签名 + ' ≠ ' + D.新签名);
      ok(D.sizeAfter60 <= 32, `缓存**有上限**：连造 60 个不同签名后 size=${D.sizeAfter60} ≤ 32（拖数字输入框时每敲一键就是一个新签名）`);
    }

    // ---------- 13) 弧进度真的走了 setLineDash / lineDashOffset ----------
    console.log('\n=== 13. 弧进度：路径恒定 + 进度走 dashoffset（浏览器）===');
    {
      const r = await cdp.eval(`(() => {
        const S = window.CanvasState;
        S.selection = []; S.showGrid = false; S.showPid = false; S.previewValues = null;
        S.simSprings.active = false; S.simSprings.clear();
        const n = window.createNode(window.NODE_GAUGE, { name: '弧表', pid: 'obd.rpm', min: 0, max: 8000, x: 20, y: 20, w: 200, h: 200 });
        n.style = 0;
        S.design.nodes = [n];
        const cv = document.getElementById('cv');
        const c2 = cv.getContext('2d');
        const origArc = c2.arc.bind(c2);
        const origDash = c2.setLineDash.bind(c2);
        let arcs = [], dashes = [], offsets = [];
        c2.arc = function (x, y, rr, a0, a1) { arcs.push([Math.round(rr * 100) / 100, Math.round(a0 * 1000) / 1000, Math.round(a1 * 1000) / 1000]); return origArc.apply(null, arguments); };
        c2.setLineDash = function (a) { dashes.push(a.slice()); return origDash.apply(null, arguments); };
        // 进度弧那一次 stroke 前后的 lineDashOffset（用属性读写探针）
        let probe = [];
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c2), 'lineDashOffset');
        Object.defineProperty(c2, 'lineDashOffset', {
          get() { return desc.get.call(c2); },
          set(v) { probe.push(Math.round(v * 100) / 100); desc.set.call(c2, v); },
        });
        S.previewValues = { std_0C: 2000 }; window.draw();
        const half = { arcs: arcs.slice(), dashes: dashes.slice(), probe: probe.slice(), after: c2.getLineDash().length };
        arcs = []; dashes = []; probe = [];
        S.previewValues = { std_0C: 6000 }; window.draw();
        const full = { arcs: arcs.slice(), dashes: dashes.slice(), probe: probe.slice(), after: c2.getLineDash().length };
        c2.arc = origArc; c2.setLineDash = origDash;
        delete c2.lineDashOffset;
        return JSON.stringify({ half: half, full: full });
      })()`);
      const D = JSON.parse(r);
      const h = D.half, f = D.full;
      console.log('    · 进度 0.25 时：setLineDash=' + JSON.stringify(h.dashes) + '，lineDashOffset 写入=' + JSON.stringify(h.probe));
      console.log('    · 进度 0.75 时：setLineDash=' + JSON.stringify(f.dashes) + '，lineDashOffset 写入=' + JSON.stringify(f.probe));
      ok(h.dashes.length >= 1, '**绘制时真的调了 setLineDash**（进度弧走 dashoffset，不是"重画一段短弧"）');
      near(h.dashes[0][0], 200 * 0.36 * 270 * Math.PI / 180, 0.5, 'dasharray = 整段弧长 r·θ');
      ok(h.probe.indexOf(0) >= 0, '画完**还原 lineDashOffset = 0**（不还原后面所有线都会变虚线）');
      eq(h.after, 0, 'draw() 结束后 getLineDash() 是空的 —— 全局状态没被污染');
      eq(f.after, 0, '第二次 draw() 同样干净');

      // 关键：两次不同的值，**进度弧的路径端点完全一样**（只是 dashoffset 不同）
      const arcSet = a => a.filter(x => Math.abs(x[0] - 200 * 0.36) < 0.01).map(x => x[1] + '~' + x[2]).sort().join('|');
      eq(arcSet(h.arcs), arcSet(f.arcs), '**两次绘制的弧路径完全相同**（进度只改标量，不重画路径）');
      const off25 = h.probe.filter(v => v > 0)[0];
      const off75 = f.probe.filter(v => v > 0)[0];
      near(off25, 200 * 0.36 * 270 * Math.PI / 180 * 0.75, 1, '进度 0.25 → lineDashOffset = len × 0.75');
      near(off75, 200 * 0.36 * 270 * Math.PI / 180 * 0.25, 1, '进度 0.75 → lineDashOffset = len × 0.25');
    }

    // ---------- 14) 指针走弹簧（不硬跳）+ 让位 ----------
    console.log('\n=== 14. 指针：弹簧位置 + 让位仲裁（浏览器）===');
    {
      const r = await cdp.eval(`(() => {
        const S = window.CanvasState;
        const out = {};
        S.simSprings.active = false; S.simSprings.clear();
        S.anim.release();
        S.tweenValues = null;
        out.未开模拟 = window.needleValue('std_0C', 8000);
        // 模拟开着：弹簧在 min，真值已经跳到 max
        S.simSprings.active = true;
        S.simSprings.clear();
        S.simSprings.snap('std_0C', 0);
        out.刚开模拟 = window.needleValue('std_0C', 8000);
        // 推 1 秒（60 帧）
        for (let i = 0; i < 60; i++) S.simSprings.step({ std_0C: 8000 }, 1 / 60);
        out.一秒后 = window.needleValue('std_0C', 8000);
        // 补间占用 → 实时数据让位
        S.anim.claim('tween', 5000, 'test');
        S.tweenValues = { std_0C: 1234 };
        out.补间期间 = window.needleValue('std_0C', 8000);
        S.anim.release('tween'); S.tweenValues = null;
        out.交还后 = window.needleValue('std_0C', 8000);
        S.simSprings.active = false; S.simSprings.clear();
        return JSON.stringify(out);
      })()`);
      const D = JSON.parse(r);
      console.log('    · ' + r);
      eq(D.未开模拟, 8000, '模拟关着 → 指针用**真值**（摆位置时指针必须立刻到位）');
      ok(D.刚开模拟 < 100, '**模拟开着但弹簧刚起步 → 指针还在 0 附近，不是 8000**（这就是"不硬跳"）');
      ok(Math.abs(D.一秒后 - 8000) < 80, '推 1 秒后弹簧到位（' + r3(D.一秒后) + ' ≈ 8000）');
      eq(D.补间期间, 1234, '**让位标志被 tween 占着 → 指针读补间值**（不是实时数据）');
      ok(Math.abs(D.交还后 - 8000) < 80, '交还后立刻回到实时数据（弹簧位置 ' + r3(D.交还后) + '）');
    }

    // ---------- 15) 唯一的 rAF 主循环 + 自检扫表（端到端） ----------
    console.log('\n=== 15. 主循环与自检扫表：两套系统不抢同一个属性（端到端）===');
    {
      await cdp.eval(`window.toggleSim(); 1`);
      await sleep(350);
      const mid = JSON.parse(await cdp.eval(`(() => {
        const S = window.CanvasState;
        return JSON.stringify({
          模拟开着: S.simSprings.active,
          有真值: Object.keys(S.previewValues || {}).length > 0,
          弹簧根数: S.simSprings.size(),
          让位: S.anim.allows('sim'),
        });
      })()`));
      console.log('    · 模拟中 ' + JSON.stringify(mid));
      ok(mid.模拟开着, '实时模拟已开始（弹簧池 active）');
      ok(mid.有真值, '真值表已填充（读数 / 状态灯用）');
      ok(mid.弹簧根数 >= 1, '弹簧池里有 ' + mid.弹簧根数 + ' 根弹簧（按 PID 分）');
      ok(mid.让位, '没人占用时实时数据可以写');

      // 扫表：占用让位标志，同时真值仍在更新
      await cdp.eval(`window.playBootSweep(600); 1`);
      await sleep(250);
      const during = JSON.parse(await cdp.eval(`(() => {
        const S = window.CanvasState;
        const tv = S.tweenValues || {};
        const keys = Object.keys(tv);
        return JSON.stringify({
          owner: S.anim.ownerNow(),
          让位给实时数据: S.anim.allows('sim'),
          补间值个数: keys.length,
          指针读补间: keys.length ? window.needleValue(keys[0], 999999) === tv[keys[0]] : false,
          真值仍在更新: Object.keys(S.previewValues || {}).length > 0,
        });
      })()`));
      console.log('    · 扫表中 ' + JSON.stringify(during));
      eq(during.owner, 'tween', '扫表期间 owner = tween');
      ok(!during.让位给实时数据, '**实时数据让位**（不写指针角度）—— 参考实现就是这里把扫表压掉的');
      ok(during.补间值个数 >= 1, '补间写入了 ' + during.补间值个数 + ' 个 PID 的值');
      ok(during.指针读补间, '**指针读的是补间值**，不是实时数据（两套系统不抢同一属性）');
      ok(during.真值仍在更新, '同时真值照常更新（读数 / 状态灯不受影响）');

      await sleep(700);
      const after = JSON.parse(await cdp.eval(`(() => {
        const S = window.CanvasState;
        return JSON.stringify({
          owner: S.anim.ownerNow(),
          tweenValues: S.tweenValues,
          让位: S.anim.allows('sim'),
          弹簧还在: S.simSprings.size() > 0,
        });
      })()`));
      console.log('    · 扫表结束 ' + JSON.stringify(after));
      eq(after.owner, null, '扫完**自动交还**（不需要用户干预）');
      eq(after.tweenValues, null, '补间值清空');
      ok(after.让位, '交还后实时数据恢复写入');
      ok(after.弹簧还在, '弹簧池还在（交还后接着走，不用重建）');

      await cdp.eval(`window.toggleSim(); 1`);
      await sleep(150);
      eq(await cdp.eval('window.CanvasState.simSprings.active'), false, '关掉模拟 → 弹簧池停用');
      eq(await cdp.eval('window.CanvasState.previewValues'), null, '关掉模拟 → 真值清空');
    }

    // ---------- 16) 数字鼓真的在画（浏览器） ----------
    console.log('\n=== 16. 数字鼓：绘制层的接线（浏览器）===');
    {
      const r = await cdp.eval(`(() => {
        const S = window.CanvasState;
        S.selection = []; S.showGrid = false; S.showPid = false;
        S.simSprings.active = false; S.simSprings.clear();
        S.anim.release(); S.tweenValues = null;
        const n = window.createNode(window.NODE_GAUGE, { name: '数字表', pid: 'obd.rpm', min: 0, max: 8000, x: 20, y: 20, w: 200, h: 200 });
        n.style = 1;
        S.design.nodes = [n];
        const cv = document.getElementById('cv');
        const c2 = cv.getContext('2d');
        const orig = c2.fillText.bind(c2);
        let texts = [];
        c2.fillText = function (t, x, y) { texts.push([String(t), Math.round(x * 10) / 10, Math.round(y * 100) / 100]); return orig.apply(null, arguments); };
        S.previewValues = { std_0C: 12.4 };
        window.draw();
        const drum = texts.slice();
        texts = [];
        S.previewValues = null;
        window.draw();
        const blank = texts.slice();
        // 底框档位标签（v2.81.0 修的存量 bug：resolveCard 返回**对象**，
        // 被当成档位数字去查 CARD_NAMES，于是印出 "数字 · undefined"）
        n.cardStyle = 2;
        texts = [];
        window.draw();
        const tag2 = texts.slice().map(t => t[0]);
        n.cardStyle = null;
        c2.fillText = orig;
        return JSON.stringify({ drum: drum, blank: blank, tag2: tag2, fs: Math.max(8, Math.min(200 * 0.44, 200 * 0.30)) });
      })()`);
      const D = JSON.parse(r);
      console.log('    · 数字鼓画出的文字：' + JSON.stringify(D.drum));
      const fsNum = D.fs;
      const rowH = fsNum * 1.16;
      const digitCalls = D.drum.filter(t => /^[0-9]$/.test(t[0]));
      eq(digitCalls.length, 4, '**画了 4 次单个数字**（两位 × 当前位 + 下一位 = 2×2，不是一次 fillText 画整个数）');
      // ⚠️ 每位数字都画"当前位 + 下一位"，所以同一个字符会出现两次（两个格子）。
      //    要比 y 就得先锁定**最右边那一格**（最低位），否则会拿十位的"下一位"来比。
      const maxX = Math.max.apply(null, digitCalls.map(t => t[1]));
      const units = digitCalls.filter(t => t[1] === maxX);
      const two = units.filter(t => t[0] === '2');
      ok(two.length === 1, '最低位那一格画了数字 2');
      near(two[0][2], 100 - 0.4 * rowH, 0.05, '**最低位的 y = 中心 - 0.4 行**（跟着小数滚；直接画文本会正好落在 100）');
      const three = units.filter(t => t[0] === '3');
      ok(three.length === 1, '最低位那一格画了数字 3（**下一位正从下面滚进来**）');
      near(three[0][2], 100 + 0.6 * rowH, 0.05, '下一位的 y = 中心 + 0.6 行');
      ok(!digitCalls.some(t => t[0] === '0'), '**前导零不画**（12.4 显示 "12"，不是 "012"）');
      eq(D.blank.filter(t => t[0] === '123').length, 1, '没有数据时仍然画占位 "123"（老行为不变）');
      const tag = D.blank.map(t => t[0]).filter(t => /^数字/.test(t));
      eq(tag.length, 1, '右下角有样式标签');
      eq(tag[0], '数字', '标签是 "数字"（**不是 "数字 · undefined"** —— v2.81.0 修：resolveCard 返回的是对象，不是档位数字）');
      ok(D.tag2.some(t => t === '数字 · 完全透明卡片'), 'cardStyle=2 时标签是 "数字 · 完全透明卡片"（档位名真的查到了）');
    }

    // ---------- 17) 盘面 / 红区 / 进度弧真的落到像素上了 ----------
    console.log('\n=== 17. 像素级：刻度 / 红区 / 进度弧（浏览器）===');
    {
      const r = await cdp.eval(`(() => {
        const S = window.CanvasState;
        S.selection = []; S.showGrid = false; S.showPid = false;
        S.simSprings.active = false; S.simSprings.clear();
        S.anim.release(); S.tweenValues = null;
        S.design.nodes = [];
        const n = window.createNode(window.NODE_GAUGE, { pid: 'obd.rpm', min: 0, max: 8000, x: 20, y: 20, w: 200, h: 200 });
        n.style = 0; n.warnHigh = 6500;
        S.design.nodes.push(n);
        S.previewValues = { std_0C: 5230 };   // 比值 0.654 → 进度弧画到 311.6°
        window.draw();
        const cv = document.getElementById('cv');
        const c2 = cv.getContext('2d');
        // 节点局部 → 画布位图：与 drawNode 用的**同一个** uniformMatrix
        const m0 = window.nodeToCanvasMatrix();
        const um = window.uniformMatrix({ a: m0.a, b: 0, c: 0, d: m0.d, e: m0.a * n.x + m0.e, f: m0.d * n.y + m0.f }, n.w, n.h);
        const X = (lx) => um.a * lx + um.c * 100 + um.e;
        const Y = (ly) => um.b * 100 + um.d * ly + um.f;
        // 在小邻域里取**最亮**的像素（抗锯齿边缘也能取到本体色）
        const probe = (lx, ly, k) => {
          const px = Math.round(X(lx)), py = Math.round(Y(ly));
          const d = c2.getImageData(px - k, py - k, k * 2 + 1, k * 2 + 1).data;
          let best = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] + d[i + 1] + d[i + 2] > best[0] + best[1] + best[2]) best = [d[i], d[i + 1], d[i + 2]];
          }
          return best;
        };
        const R = Math.min(n.w, n.h) * 0.36;
        const pt = (ang, rr) => [n.w / 2 + Math.cos(ang * Math.PI / 180) * rr, n.h / 2 + Math.sin(ang * Math.PI / 180) * rr];
        const T = window.currentTheme();
        const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
        return JSON.stringify({
          accent: hex(T.accent), tick: hex(T.tick || T.dim),
          红区: probe.apply(null, pt(40, R).concat([3])),
          红区起点: probe.apply(null, pt(357, R).concat([3])),
          填充段: probe.apply(null, pt(300, R).concat([3])),
          未填充段: probe.apply(null, pt(340, R).concat([3])),
          大格: probe.apply(null, pt(270, R * 0.85).concat([3])),
          大格之间: probe.apply(null, pt(292.5, R * 0.85).concat([3])),
          刻度数字: probe.apply(null, pt(270, R * 0.62).concat([4])),
          圆心: probe.apply(null, pt(270, 10).concat([3])),
        });
      })()`);
      const D = JSON.parse(r);
      const isRed = c => c[0] > 200 && c[1] < 120 && c[2] < 120;
      const sum = c => c[0] + c[1] + c[2];
      const same = (a, b, tol) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
      console.log('    · 主题 accent=' + JSON.stringify(D.accent) + ' tick=' + JSON.stringify(D.tick));
      console.log('    · 红区=' + JSON.stringify(D.红区) + ' 填充=' + JSON.stringify(D.填充段) +
        ' 未填充=' + JSON.stringify(D.未填充段) + ' 大格=' + JSON.stringify(D.大格) + ' 格间=' + JSON.stringify(D.大格之间));
      ok(isRed(D.红区), '**红区画出来了**：6500~8000 那一段的像素是红的 ' + JSON.stringify(D.红区));
      ok(isRed(D.红区起点), '红区起点（val2ang(6500) = 354.4°）附近也是红的');
      ok(same(D.填充段, D.accent, 24), '**进度弧（dashoffset 那一段）用的是主题 accent 色** ' + JSON.stringify(D.填充段) + ' ≈ ' + JSON.stringify(D.accent));
      ok(!same(D.未填充段, D.accent, 24), '**超出进度的部分还是轨道色**（0.654 的进度只填到 311.6°，340° 处不该是 accent）');
      ok(!isRed(D.未填充段), '未填充段也不是红的（红区只画在 6500 以上那一段）');
      ok(sum(D.大格) > sum(D.大格之间) + 100, '**大格刻度真的画出来了**：4000 正上方比两根刻度之间亮得多（' + sum(D.大格) + ' vs ' + sum(D.大格之间) + '）');
      ok(sum(D.刻度数字) > sum(D.圆心) + 100, '**刻度数字画在弧内侧**（0.62R 处比圆心亮 —— 圆心是卡片底色）');
    }

    // ---------- 18) 设置面板：调参不丢焦点 + 体检文案跟着走 ----------
    console.log('\n=== 18. 设置面板：改弹簧参数（浏览器）===');
    {
      const r = await cdp.eval(`(() => {
        const box = document.getElementById('settingsBox');
        window.openSettings();
        const inputs = box.querySelectorAll('input[type=number]');
        const kIn = inputs[0];
        const cIn = inputs[1];
        const before = {
          输入框个数: inputs.length,
          k值: kIn.value, c值: cIn.value,
          体检文案: (document.getElementById('springHintBox') || {}).textContent || '',
        };
        kIn.focus();
        kIn.value = '300';
        kIn.dispatchEvent(new Event('input', { bubbles: true }));
        // ⚠️ 这一条是**焦点**断言：如果 setSpringParams 里重画了整个对话框，
        //    这个 input 会被销毁 → activeElement 变 body → 用户每敲一个数字就掉焦点
        const after = {
          k生效: window.SETTINGS.springK,
          还是同一个元素: document.activeElement === kIn,
          体检变了: (document.getElementById('springHintBox') || {}).textContent || '',
        };
        // 非法值不生效（不夹取）
        kIn.value = '1';
        kIn.dispatchEvent(new Event('input', { bubbles: true }));
        const bad = window.SETTINGS.springK;
        // 阻尼
        cIn.value = '60';
        cIn.dispatchEvent(new Event('input', { bubbles: true }));
        const over = {
          c生效: window.SETTINGS.springC,
          体检: (document.getElementById('springHintBox') || {}).textContent || '',
        };
        // 复位
        window.setSpringParams(150, 19);
        const dlg = document.getElementById('settingsDlg');
        if (dlg && dlg.close) dlg.close();
        return JSON.stringify({ before: before, after: after, badK: bad, over: over, reset: [window.SETTINGS.springK, window.SETTINGS.springC] });
      })()`);
      const D = JSON.parse(r);
      console.log('    · ' + r);
      eq(D.before.输入框个数, 2, '设置面板里有 2 个数字输入框（k / c）');
      eq(D.before.k值, '150', '默认 k = 150');
      eq(D.before.c值, '19', '默认 c = 19');
      ok(/0\.042/.test(D.before.体检文案), '体检文案给出 k·dt² = 0.042（< 4 稳定）');
      eq(D.after.k生效, 300, '改 k → 设置生效');
      ok(D.after.还是同一个元素, '**改参数不会重建对话框**（否则用户每敲一个数字就丢焦点）');
      ok(D.after.体检变了 !== D.before.体检文案, '体检文案实时跟着变（k=300 → k·dt² 变大）');
      eq(D.badK, 300, '**非法值不生效也不夹取**（填 "1" 时保持上一次的 300 —— 不吞掉用户正在输入的数字）');
      eq(D.over.c生效, 60, '改阻尼 c → 生效');
      ok(/过阻尼|接近临界/.test(D.over.体检), 'c=60（ζ>1）时体检文案改口为"过阻尼/接近临界"：' + D.over.体检.slice(0, 40) + '…');
      eq(D.reset.join(','), '150,19', '复位回默认（k=150 / c=19）');
    }

    await cdp.ws.close();
  } catch (e) {
    console.log('  ❌ 执行失败: ' + e.message);
    fail++;
  } finally { proc.kill(); }

  console.log('\n' + '='.repeat(58));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
