// ============================================================================
// 生成器不变式守卫（v2.87.0）
//
// ## 为什么单开一个套件
//
// v2.86.0 体检出的 9 个坏素材，根因**全在生成器/绘图原语**里，而且全是
// **静默**的：
//
//   1. `Canvas.rect()` 收到**负宽高** → `for (py = y0; py < y1; py++)` 直接空转，
//      一声不响什么都不画。四个角标里只有 `corner-br` 因为"负负得正"画出来了。
//   2. `c.fill()` 回调的 alpha 按 **0..1** 写，而约定是 **0..255** → 归零 → 整张全透明。
//   3. `gen-assets.js` 的拉丝金属用了 `Math.random()` → **重新生成不幂等**
//      （实测连跑两次，359 个素材里只有它字节不同）。
//
// 前两类靠"看像素"能查出来（`verify-assets-wiring.js` 已经这么做了），
// 但**根因还在**：下次有人写 `rect(x, y, -w, -h)` 或 `[r,g,b,1]`，
// 产物又是一张坏图，而**只有产物**会被发现。
//
// 所以这个套件直接盯**原语与生成器本身**：
//
//   · `rect()` 负宽高**不许静默空转**（归一化后必须画出与正值调用**逐字节相同**的图）
//   · `fill()` 的 alpha 约定是 0..255 —— 写成 0..1 时**必须大声警告**
//   · 生成器源码里**不许有 `Math.random()`**（幂等的前提）
//   · 生成器**连跑两次，全部产物逐字节相同**（真跑，不是静态检查）
//
// ## 为什么真跑两次生成器（约 12 秒）
//
// "幂等"这件事只有**跑**才证明得了。静态扫 `Math.random` 挡不住
// `Date.now()`、`process.hrtime`、遍历顺序不稳定、外部状态…… 实测那次的
// 症状正是"359 个文件里只有 1 个不同" —— 只跑一次永远发现不了。
//
// ⚠️ 两次都写进 `%TEMP%`（`ICARUI_ASSETS_OUT` 环境变量），**绝不写进真素材目录**：
// 否则每跑一次测试就把工作区改脏，而且会盖掉别人正在看的图。
//
// ## 不依赖浏览器
//
// 这个套件不需要 Edge —— 纯 Node + png.js。所以它比别的套件快得多，
// 也不受"Edge 起不来"影响（那种情况下它仍然会跑）。
// ============================================================================
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { decodePng, opaquePixels } = require('./_common');

const STUDIO = path.join(__dirname, '..');
const GEN = path.join(STUDIO, 'gen-assets.js');
const PNG = require(path.join(STUDIO, 'png.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✅ ' + m)) : (fail++, console.log('  ❌ ' + m)); };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`));
const md5 = b => crypto.createHash('md5').update(b).digest('hex');

(async () => {

  // ---------- 1) `Canvas.rect()`：负宽高不许静默空转 ----------
  console.log('=== 1. rect() 负宽高（v2.87.0 修的根因之一）===');

  const drawRect = (x, y, w, h) => {
    const c = new PNG.Canvas(32, 32);
    c.rect(x, y, w, h, '#00D8FF', 0.9);
    return c.toPng();
  };

  // 先证明"以前那种写法"现在是**画得出来**的
  const negNeg = drawRect(24, 24, -16, -16);          // 负负 —— 以前恰好能画
  const posPos = drawRect(8, 8, 16, 16);              // 归一化后的等价写法
  eq(opaquePixels(negNeg), 256, 'rect(24,24,-16,-16) 覆盖 16×16 = 256 个像素（归一化后落在 x8..24 / y8..24）');
  eq(md5(negNeg), md5(posPos),
    '**负宽高与归一化后的正宽高画出的图逐字节相同**（"静默空转"变成不可能）');

  // 三种"只有一个负"的组合 —— 以前**全部空转**（四个角标里三个就是这种）
  [['宽负高正', 24, 8, -16, 16], ['宽正高负', 8, 24, 16, -16], ['宽高都负', 24, 24, -16, -16]]
    .forEach(([name, x, y, w, h]) => {
      const buf = drawRect(x, y, w, h);
      eq(opaquePixels(buf), 256, `rect(${x},${y},${w},${h})（${name}）**不再静默空转**（256 个像素）`);
    });

  // 正值调用的行为**不许变**（归一化只该影响负值）
  eq(opaquePixels(drawRect(4, 4, 10, 20)), 200, '正宽高调用照旧：rect(4,4,10,20) = 10×20 = 200 个像素');
  const zero = drawRect(4, 4, 0, 0);
  eq(opaquePixels(zero), 0, '宽高为 0 仍然是"什么都不画"（0 不是负，不该被归一化成别的尺寸）');

  // ---------- 2) `fill()` 的 alpha 约定是 0..255 ----------
  console.log('\n=== 2. fill() 的 alpha 约定（v2.87.0 修的根因之二）===');

  const fillAlpha = (a) => {
    const c = new PNG.Canvas(8, 8);
    c.fill(() => [0, 216, 255, a]);
    const img = decodePng(c.toPng());
    return img.rgba[3];
  };

  eq(fillAlpha(255), 255, '`fill` 返回 alpha=255 → 输出 **完全不透明**（255）');
  // ⚠️ 这条钉的是**历史行为**，不是理想行为：
  // `fill()` 把 alpha 又当倍率传给了 `_blend`，而 `_blend` 自己还会 `/255` ——
  // 同一个 alpha 除了两遍 → 有效不透明度 = (a/255)²。
  // 128 → (128/255)² = 0.252 → 输出 64（不是 128）。
  //
  // 为什么不去改成线性：改了会动到 `decor/underline.png` 的渐隐曲线，
  // 而那张图**不在 v2.87.0"已证明是坏的"名单里**（CHANGELOG 有记录）。
  // 如果哪天真的改成线性，**这条断言会红** —— 那正是提醒你"underline.png 要一起处理"。
  eq(fillAlpha(128), 64,
    '`fill` 返回 alpha=128 → 输出 64（**历史行为：alpha 被除了两遍 = 平方**；改线性会连带 underline.png，见 CHANGELOG）');

  // 0..1 的写法（v2.86.0 那 6 处）必须**大声警告**，不许再静默归零
  const captureWarn = (fn) => {
    const orig = console.warn, got = [];
    console.warn = m => got.push(String(m));
    try { fn(); } finally { console.warn = orig; }
    return got;
  };
  const w1 = captureWarn(() => {
    const c = new PNG.Canvas(8, 8);
    c.fill(() => [0, 216, 255, 0.5]);              // ← 按 0..1 写 = v2.86.0 的错法
  });
  eq(w1.length, 1, '**`fill` 回调按 0..1 写 alpha 时会警告**（下次不会再静默出全透明图）');
  ok(w1.length > 0 && /0\.\.255/.test(w1[0]), '  警告文本里写明了约定是 0..255');
  const w2 = captureWarn(() => {
    const c = new PNG.Canvas(8, 8);
    c.fill((x) => [0, 216, 255, 0.9 * (1 - x / 8) * 255]);   // 合法的淡出（最大 229）
  });
  eq(w2.length, 0, '**合法地淡到接近 0 的渐变不会误报**（判据是"整层最大 alpha"，不是逐像素）');

  // ---------- 3) `color()` 把越界 alpha 夹住 ----------
  console.log('\n=== 3. color() 的 alpha 越界夹取 ===');
  eq(PNG.color([1, 2, 3, 300])[3], 255, 'alpha=300 被夹到 255（否则 `sa>1` 会变成"越描越黑"）');
  eq(PNG.color([1, 2, 3, -5])[3], 0, 'alpha=-5 被夹到 0');
  eq(PNG.color([1, 2, 3])[3], 255, '三元素颜色默认不透明');
  eq(PNG.color('#00D8FF')[3], 255, '`#RRGGBB` 默认不透明');

  // ---------- 4) 生成器源码：不许有 Math.random ----------
  console.log('\n=== 4. 生成器源码里的随机源 ===');
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  ['gen-assets.js', 'gen-assets-more.js'].forEach(f => {
    const src = stripComments(fs.readFileSync(path.join(STUDIO, f), 'utf8'));
    const hits = (src.match(/Math\.random/g) || []).length;
    eq(hits, 0, `**${f} 里没有 \`Math.random\`**（有它 = 重新生成不幂等）`);
  });

  // ---------- 5) 真跑两次生成器：全部产物逐字节相同 ----------
  console.log('\n=== 5. 生成器幂等（真跑两次，逐字节比对）===');

  const runGen = (outDir, logFile) => new Promise((resolve, reject) => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    // 输出重定向到**文件**而不是管道：沙箱下 `stdio:'pipe'` 抓子进程输出会 EPERM，
    // 而 `'ignore'` 又拿不到警告文本 —— 用 fd 是最稳的第三条路。
    const fd = fs.openSync(logFile, 'w');
    const t0 = Date.now();
    const p = spawn(process.execPath, [GEN], {
      cwd: STUDIO,
      env: Object.assign({}, process.env, { ICARUI_ASSETS_OUT: outDir }),
      stdio: ['ignore', fd, fd],
    });
    p.on('error', e => { fs.closeSync(fd); reject(e); });
    p.on('exit', code => {
      fs.closeSync(fd);
      resolve({ code: code, ms: Date.now() - t0, log: fs.readFileSync(logFile, 'utf8') });
    });
  });

  const walk = (dir) => {
    const out = [];
    (function rec(d) {
      fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
        const f = path.join(d, e.name);
        if (e.isDirectory()) rec(f); else out.push(f);
      });
    })(dir);
    return out.sort();
  };

  const A = path.join(os.tmpdir(), 'icarui-gen-a');
  const B = path.join(os.tmpdir(), 'icarui-gen-b');
  const rA = await runGen(A, path.join(os.tmpdir(), 'icarui-gen-a.log'));
  const rB = await runGen(B, path.join(os.tmpdir(), 'icarui-gen-b.log'));
  console.log(`    · 第一次 ${(rA.ms / 1000).toFixed(1)}s（退出码 ${rA.code}），第二次 ${(rB.ms / 1000).toFixed(1)}s（退出码 ${rB.code}）`);
  eq(rA.code, 0, '第一次生成器退出码 0');
  eq(rB.code, 0, '第二次生成器退出码 0');

  const fA = walk(A).map(f => path.relative(A, f));
  const fB = walk(B).map(f => path.relative(B, f));
  eq(fA.length, fB.length, `两次产出的文件数相同（${fA.length} 个）`);
  eq(fA.join('|'), fB.join('|'), '两次产出的文件清单（路径）相同');

  const differs = [];
  fA.forEach(rel => {
    const a = fs.readFileSync(path.join(A, rel));
    const b = fs.readFileSync(path.join(B, rel));
    if (!a.equals(b)) differs.push(rel + `（${a.length}B vs ${b.length}B）`);
  });
  differs.slice(0, 5).forEach(x => console.log('       ⚠️ ' + x));
  eq(differs.length, 0,
    `**两次生成的 ${fA.length} 个文件逐字节相同**（幂等；修前 brushed-metal.png 会不同）` +
    (differs.length ? '：' + differs.slice(0, 5).join(' | ') : ''));

  const pngCount = fA.filter(f => f.endsWith('.png')).length;
  console.log('    · 其中 PNG ' + pngCount + ' 个，清单文件 ' + (fA.length - pngCount) + ' 个');
  ok(pngCount >= 350, `素材规模够大才有意义（${pngCount} 个 PNG ≥ 350）`);
  ok(fA.indexOf(path.join('builtin.js')) >= 0 && fA.indexOf(path.join('builtin-index.js')) >= 0,
    '清单文件（builtin.js / builtin-index.js）也在逐字节比对的范围内');

  // 生成器**不许**打出 alpha 警告 —— 打出来就说明又有人按 0..1 写了 alpha
  const warnA = (rA.log.match(/png\.js fill\(\)/g) || []).length;
  const warnB = (rB.log.match(/png\.js fill\(\)/g) || []).length;
  eq(warnA + warnB, 0,
    '**两次生成都没有 "fill() alpha 单位写错" 的警告**（有警告 = 又有素材会渲染成全透明）');

  // 顺手报一下"磁盘上的素材"与"新生成的一份"差多少（**不断言**，只做提示）
  //
  // 不断言的理由：`assets/custom/` 这类**不是生成器产出**的文件本来就该不一样，
  // 而且有人可能手改过素材（那是另一件事，不该由这个套件来判）。
  const real = path.join(STUDIO, 'assets');
  let same = 0, diff = 0, missing = 0;
  fA.filter(f => f.endsWith('.png')).forEach(rel => {
    const r = path.join(real, rel);
    if (!fs.existsSync(r)) { missing++; return; }
    fs.readFileSync(r).equals(fs.readFileSync(path.join(A, rel))) ? same++ : diff++;
  });
  console.log(`    · 参考：磁盘上 ${same} 个与"刚生成的那份"一致、${diff} 个不同、${missing} 个不在本次产出里`);
  // 上面这行**故意不作为判据**：`assets/custom/` 里的东西本来就不是生成器产出的，
  // 而且"有人手改过素材"是另一件事（该由 review 去问），不该由这个套件来判。

  // 清理
  [A, B].forEach(d => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } });
  [path.join(os.tmpdir(), 'icarui-gen-a.log'), path.join(os.tmpdir(), 'icarui-gen-b.log')]
    .forEach(f => { try { fs.rmSync(f, { force: true }); } catch (e) { } });

  console.log('\n' + '='.repeat(60));
  console.log('PASS=' + pass + '  FAIL=' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('  ❌ 执行失败: ' + (e && e.stack ? e.stack : e));
  console.log('\n' + '='.repeat(60));
  console.log('PASS=' + pass + '  FAIL=' + (fail + 1));
  process.exit(1);
});
