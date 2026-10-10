/* ==========================================================================
   spring.js —— 弹簧积分 / 表盘几何 / 数字鼓 / 弧进度
   --------------------------------------------------------------------------
   **纯函数与纯状态，不碰 DOM**（唯一的例外 `applyArcProgress(ctx,…)`，
   它只往传入的 2D context 上写两个属性）。

   为什么单独一个文件（v2.81.0）：

   这一套东西（弹簧、盘面几何、数字鼓步长）以前**不存在** ——
   预览里的指针是"值 → 角度"的直接映射，实时模拟每帧把值换掉，
   指针就跟着硬跳。参考实现（一个独立的宝马风格仪表盘）给了三条做法，
   它们都有同一个特征：**是"算出来的状态"，不是"排好的动画"**。

     1. 指针 = 真弹簧积分（半隐式欧拉），不是补间
     2. 表盘是 buildDial() 算出来的（极坐标生成刻度），量程/单位变了要**重建盘面**
     3. 进度弧用 stroke-dashoffset（画一次路径，进度只改一个标量）
     4. 数字鼓按"行"位移，行数一变步长就变（yPercent 口径的经典坑）

   把这些抽成**没有 DOM 依赖**的纯函数，是为了能在 Node 里直接断言 ——
   弹簧的稳定性/过冲/收敛、盘面重建、dashoffset 换算、数字鼓步长
   全是"给定输入必然得到某个输出"的东西，用像素指纹去测它们既脆又慢。

   ⚠️ 本文件**不能**引入任何需要构建的依赖（npm/ES module）——
   工具的零安装形态（双击 index.html 就能用）是硬约束。
   ========================================================================== */
"use strict";

(function () {
  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ================================================================ 1. 弹簧

  /**
   * 默认参数（参考实现实测好用的那一组）。
   *
   * | 量 | 值 | 为什么 |
   * |---|---|---|
   * | `k` | 150 | 劲度系数。越大越"硬"，到位越快 |
   * | `c` | 19  | 阻尼系数。越小越晃 |
   * | `maxDt` | 0.05 | **单步上限**，见下面 `step()` 的注释 |
   *
   * 阻尼比 `ζ = c / (2√k) ≈ 0.776` —— **轻微欠阻尼**：
   * 到位时会过冲约 2% 再回正。这一点点过冲就是"像真针"的来源；
   * ζ ≥ 1（临界/过阻尼）会变成"黏糊糊地滑过去"，一眼假。
   */
  const SPRING_DEFAULTS = { k: 150, c: 19, maxDt: 0.05 };
  window.SPRING_DEFAULTS = SPRING_DEFAULTS;

  /**
   * 一根弹簧（半隐式欧拉 / symplectic Euler）。
   *
   * ```js
   * const a = (target - x) * k - v * c;   // 虎克力 - 阻尼力
   * v += a * dt;  x += v * dt;            // 先更新速度，再用**新速度**更新位置
   * ```
   *
   * ## 为什么不用补间（tween）
   *
   * 实时数据每 16ms 变一次。补间是"从 A 到 B 的一段动画"，
   * 目标一直在变，于是补间**永远追不上**：每一帧都要重排一段新动画，
   * 旧的那段被打断（GSAP 里就是 `overwrite`），结果是**累积延迟 + 互相打断**。
   * 弹簧是**状态**：目标怎么跳，它都只是"被拉了一下"，天然平滑。
   *
   * ## 稳定性（纯显式积分的死穴）
   *
   * 显式积分在 `k·dt² ≥ 4` 或 `c·dt ≥ 2` 时**发散**（数值爆炸）。
   * 默认参数下 `k·dt² = 150 × 0.05² = 0.375`、`c·dt = 0.95` —— 安全区很宽。
   * 但 `dt` 不能信：**切走标签页再切回来，`dt` 可能是好几秒**
   * （浏览器把 rAF 停了），那时 `k·dt²` 直接上千 → 指针飞到屏幕外。
   * 所以 `step()` 里**夹住 dt**（`maxDt`），而不是在外面自觉。
   */
  function Spring(opts) {
    const o = opts || {};
    this.k = Math.max(0.0001, num(o.k, SPRING_DEFAULTS.k));
    this.c = Math.max(0, num(o.c, SPRING_DEFAULTS.c));
    this.x = num(o.x, 0);
    this.v = num(o.v, 0);
    this.target = num(o.target, this.x);
    /** 累计积分步数（测试与"是否已经静止"判断用） */
    this.steps = 0;
  }

  /**
   * 推进一步，返回新位置。
   *
   * @param target 目标值。传 null/undefined/NaN 就沿用上一次的目标
   *   （实时数据偶尔缺一个采样时不该把指针拉回 0）
   * @param dt     秒。非法值直接返回当前位置（不动比乱动好）
   */
  Spring.prototype.step = function (target, dt) {
    if (target !== null && target !== undefined) {
      const t = Number(target);
      if (Number.isFinite(t)) this.target = t;
    }
    const raw = Number(dt);
    if (!Number.isFinite(raw) || raw <= 0) return this.x;
    const h = raw > SPRING_DEFAULTS.maxDt ? SPRING_DEFAULTS.maxDt : raw;
    const a = (this.target - this.x) * this.k - this.v * this.c;
    this.v += a * h;
    this.x += this.v * h;
    this.steps++;
    return this.x;
  };

  /** 直接把状态摆到某处（切换数据源/停止模拟时用，**不要**用它做动画） */
  Spring.prototype.reset = function (x, v) {
    this.x = num(x, 0);
    this.v = num(v, 0);
    this.target = this.x;
    this.steps = 0;
    return this;
  };

  /** 离目标还有多远（收敛判断） */
  Spring.prototype.error = function () { return this.target - this.x; };
  Spring.prototype.params = function (k, c) {
    if (k !== undefined && k !== null && Number.isFinite(Number(k))) this.k = Math.max(0.0001, Number(k));
    if (c !== undefined && c !== null && Number.isFinite(Number(c))) this.c = Math.max(0, Number(c));
    return { k: this.k, c: this.c };
  };
  window.Spring = Spring;

  /**
   * 参数体检 —— **纯函数**，测试直接调它，不用跑一个浏览器动画。
   *
   * @returns {{hooke:number, damp:number, stable:boolean, zeta:number,
   *            overshoot:boolean, settleSteps:number}}
   *
   * `hooke` / `damp` 是两个**显式积分的发散判据**：
   *   `k·dt² < 4` 且 `c·dt < 2` 才稳定（推导见任意数值分析教材的
   *   阻尼振子显式欧拉稳定域）。默认参数下是 0.375 / 0.95，余量很大。
   *
   * `zeta` 是阻尼比：< 1 欠阻尼（会过冲，**要的就是这个**）、
   * = 1 临界、> 1 过阻尼（黏）。
   *
   * `settleSteps` 是"几步之内收敛到 1% 以内"的粗估：
   * 包络按 `e^(-ζω t)` 衰减，ω = √k，取到 1% 需要 `t ≈ 4.6/(ζ√k)`。
   */
  window.springCheck = function (k, c, dt) {
    const K = Math.max(0.0001, num(k, SPRING_DEFAULTS.k));
    const C = Math.max(0, num(c, SPRING_DEFAULTS.c));
    const H = num(dt, 1 / 60);
    const hooke = K * H * H;
    const damp = C * H;
    const zeta = C / (2 * Math.sqrt(K));
    const tSettle = zeta > 0 ? 4.6 / (zeta * Math.sqrt(K)) : Infinity;
    return {
      k: K, c: C, dt: H,
      hooke: hooke,
      damp: damp,
      stable: hooke < 4 && damp < 2,
      zeta: zeta,
      overshoot: zeta < 1,
      settleSteps: Number.isFinite(tSettle) ? Math.ceil(tSettle / H) : Infinity,
    };
  };

  // ================================================================ 2. 弹簧池

  /**
   * 一堆按 key 分开的弹簧（一个 PID 一根）。
   *
   * 为什么要分开：两根针共用一根弹簧的话，改其中一根的目标会**互相拖拽**；
   * 而且"哪根针在动"这件事必须各自独立。
   */
  function SpringBank(opts) {
    this.opts = {
      k: num((opts || {}).k, SPRING_DEFAULTS.k),
      c: num((opts || {}).c, SPRING_DEFAULTS.c),
    };
    this.map = Object.create(null);
    /** ⚠️ 只有 active 为真时绘制层才用弹簧值 —— 否则一律用真值 */
    this.active = false;
  }

  SpringBank.prototype.get = function (key) {
    const k = String(key);
    let s = this.map[k];
    if (!s) { s = this.map[k] = new Spring({ k: this.opts.k, c: this.opts.c }); }
    return s;
  };
  SpringBank.prototype.has = function (key) {
    return Object.prototype.hasOwnProperty.call(this.map, String(key));
  };
  /** 当前位置；没有这根弹簧就返回 fallback（**不创建**） */
  SpringBank.prototype.peek = function (key, fallback) {
    const s = this.map[String(key)];
    return s ? s.x : fallback;
  };
  SpringBank.prototype.size = function () { return Object.keys(this.map).length; };

  /**
   * 推进所有弹簧。`targets` 是 `{key: 目标值}`。
   *
   * **只推进 targets 里有的** —— 数据源消失的 PID 不该继续动
   * （它的弹簧停在原地，等下一帧真的又有值了再接着走）。
   *
   * @returns 位置表 `{key: x}`
   */
  SpringBank.prototype.step = function (targets, dt) {
    const out = {};
    const t = targets || {};
    Object.keys(t).forEach((key) => {
      const s = this.get(key);
      s.step(t[key], dt);
      out[key] = s.x;
    });
    return out;
  };

  /** 把某一根**立刻**摆到目标值（不做动画）。切换数据源时用 */
  SpringBank.prototype.snap = function (key, value) {
    const s = this.get(key);
    s.reset(value, 0);
    return s.x;
  };

  SpringBank.prototype.clear = function () {
    this.map = Object.create(null);
  };

  /** 改所有弹簧的参数（设置面板里的 k / c） */
  SpringBank.prototype.params = function (k, c) {
    if (k !== undefined && k !== null && Number.isFinite(Number(k))) this.opts.k = Math.max(0.0001, Number(k));
    if (c !== undefined && c !== null && Number.isFinite(Number(c))) this.opts.c = Math.max(0, Number(c));
    Object.keys(this.map).forEach((key) => {
      this.map[key].k = this.opts.k;
      this.map[key].c = this.opts.c;
    });
    return { k: this.opts.k, c: this.opts.c };
  };
  window.SpringBank = SpringBank;

  // ================================================================ 3. 让位仲裁

  /**
   * **属性让位标志**：同一时刻只允许一个系统写"会动的东西"。
   *
   * 参考实现踩过的坑：只有一个 rAF 主循环负责实时数据、GSAP 时间线负责
   * 作者编排的动画，**两者写同一个 `rotation`** —— 主循环每帧覆写，
   * 把开机自检的扫表完全压掉了（动画在跑，但一帧都看不见）。
   *
   * 工具里目前**没有** GSAP（也不打算为这个引一个要构建的依赖），
   * 但同一个坑换身衣服还在：`draw()` 被十几个地方调用，
   * 谁都可能想"让指针动一下"。所以这里先把**契约**定下来：
   *
   *   - 主循环每帧先问 `allows("sim")`，**不让位就不写**
   *   - 补间/自检动画开始前 `claim("tween", 毫秒)`，结束后 `release("tween")`
   *   - 带超时：claim 的一方崩了（忘了 release），标志会自己过期，
   *     不会把实时数据**永久**锁死
   */
  function AnimArbiter() {
    this.owner = null;
    this.until = 0;
    this.reason = "";
  }

  AnimArbiter.prototype.claim = function (who, ms, reason) {
    this.owner = String(who);
    this.until = Date.now() + Math.max(0, num(ms, 0));
    this.reason = String(reason || "");
    return this.owner;
  };
  AnimArbiter.prototype.release = function (who) {
    if (who === undefined || who === null || String(who) === this.owner) {
      this.owner = null;
      this.until = 0;
      this.reason = "";
    }
    return this.owner;
  };
  /** 当前真正的所有者（过期的自动清掉） */
  AnimArbiter.prototype.ownerNow = function (now) {
    const t = num(now, Date.now());
    if (this.owner && t >= this.until) { this.owner = null; this.reason = ""; }
    return this.owner;
  };
  /** `who` 现在能不能写。没人占用 = 能；被自己占用 = 能 */
  AnimArbiter.prototype.allows = function (who, now) {
    const o = this.ownerNow(now);
    return !o || o === String(who);
  };
  window.AnimArbiter = AnimArbiter;

  // ================================================================ 4. 表盘几何

  /**
   * 表盘的默认几何（参考实现的那一组）。
   *
   * `start = 135°`、`sweep = 270°` → 缺口在**正下方**。
   * canvas 的角度 0° 在 3 点钟方向、顺时针为正，所以 135° 在左下、
   * 405°(=45°) 在右下 —— 正是汽车仪表的样子。
   */
  const DIAL_DEFAULT = {
    cx: 200, cy: 200, r: 150,
    start: 135, sweep: 270,
    min: 0, max: 100,
    /** `null` = **自动**选刻度步长（见 `dialAutoMajorStep`）；给数字就是"均匀分这么多大格" */
    major: null,
    /** 自动模式的目标大格数（8 格在 270° 弧上不挤也不空） */
    majorTarget: 8,
    minor: 4,
    redlineFrom: null, redlineTo: null,
    redlines: null,
    unit: "",
  };
  window.DIAL_DEFAULT = DIAL_DEFAULT;

  /** 刻度数字怎么显示：最多一位小数，整数就不带小数点 */
  function fmtTick(v) {
    const r = Math.round(v * 10) / 10;
    return String(r);
  }
  window.dialTickText = fmtTick;

  /**
   * **好读的步长族**：`1 / 2 / 2.5 / 5 × 10^n`，围绕 `span/target` 取前后各一个数量级。
   *
   * 为什么是这四档：仪表上的刻度值就是这几种 ——
   * 0/1000/2000…（步长 1000）、0/20/40…（步长 20）、0/2.5/5…（步长 2.5）。
   * 步长 3 或 7 会得到 "0, 3, 6, 9" 这种谁都不用的刻度。
   */
  window.dialNiceStepCands = function (span, target) {
    const s = Math.abs(num(span, 0));
    const t = Math.max(1, num(target, 8));
    if (!(s > 0)) return [1];
    const raw = s / t;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const out = [];
    for (let d = -1; d <= 1; d++) {
      [1, 2, 2.5, 5].forEach(function (m) { out.push(m * mag * Math.pow(10, d)); });
    }
    return out;
  };

  /**
   * **自动选大格步长**（盘面"算出来"的关键一步）。
   *
   * 判据（分数越小越好，都是"相对误差"量级的小数）：
   *
   * | 项 | 权重 | 为什么 |
   * |---|---|---|
   * | 离理想步长 `span/8` 的相对距离 | — | 刻度太稀/太密都不好看 |
   * | `span / step` 不是整数 | +0.25 | 量程刚好被整除 → 最后一个刻度**正好落在 max** |
   * | 步长不是整数 | +0.25 | 0/2/4… 比 0/2.5/5… 更好读（量程允许时优先前者） |
   * | `min` 不是步长的整数倍 | +0.30 | 否则第一个刻度会落在 **min 以下**（-25, 0, 25… 出现在 -40 起步的表上） |
   *
   * 只在 `大格数 ∈ [2.5, 16]` 的候选里挑 —— 2 格太稀、20 格在 270° 的弧上挤成一团。
   *
   * 实测四个真实量程的结果：
   *   `0~8000`（转速）→ 1000，9 个刻度，正好到 8000
   *   `0~260`（车速） → 20，14 个刻度，正好到 260
   *   `-40~215`（水温）→ 20，-40 起步（最后一个是 200，215 处留白 —— 真表也这样）
   *   `0~20`（电压）  → 2，11 个刻度，正好到 20
   */
  window.dialAutoMajorStep = function (min, max, target) {
    const lo = num(min, 0), hi = num(max, 100);
    const span = hi - lo;
    if (!(span > 0)) return 1;
    const ideal = span / Math.max(1, num(target, 8));
    let best = null;
    window.dialNiceStepCands(span, target).forEach(function (step) {
      const count = span / step;
      if (!(count >= 2.5 && count <= 16)) return;
      const near = (a, b) => Math.abs(a - b) < 1e-9;
      const exact = near(count, Math.round(count));
      const intStep = near(step, Math.round(step));
      const aligned = near(lo / step, Math.round(lo / step));
      let score = Math.abs(step - ideal) / ideal;
      if (!exact) score += 0.25;
      if (!intStep) score += 0.25;
      if (!aligned) score += 0.30;
      // 同分时选"大格数更接近 8"的那个
      const tie = Math.abs(count - 8);
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && tie < best.tie)) {
        best = { step: step, count: count, score: score, tie: tie };
      }
    });
    if (!best) {
      // 兜底：均匀分 8 格（量程异常小/大时走到这儿）
      return span / 8;
    }
    return best.step;
  };

  /**
   * 大格的值序列。
   *
   * @param major `null` → 自动步长（**刻度从 min 起按步长走，走到 max 为止**）；
   *   给数字 → 均匀分成这么多格（老口径，最后一格必定落在 max）
   */
  window.dialMajorValues = function (min, max, major, target) {
    const lo = num(min, 0), hi = num(max, 100);
    const span = hi - lo;
    if (!(span > 0)) return [];
    if (major !== null && major !== undefined && Number.isFinite(Number(major))) {
      const M = Math.round(clamp(Number(major), 1, 60));
      const out = [];
      for (let i = 0; i <= M; i++) out.push(lo + span * i / M);
      return out;
    }
    const step = window.dialAutoMajorStep(lo, hi, target);
    const first = Math.ceil(lo / step - 1e-9) * step;
    const out = [];
    for (let v = first; v <= hi + 1e-9 && out.length < 40; v += step) {
      // 消掉浮点毛刺（0.30000000000000004 → 0.3）
      out.push(Math.round(v * 1e6) / 1e6);
    }
    if (out.length < 2) return [lo, hi];
    return out;
  };

  /** 大格之间的步长（自动模式下就是选出来的那个 step） */
  window.dialMajorStep = function (min, max, major, target) {
    const vals = window.dialMajorValues(min, max, major, target);
    return vals.length > 1 ? (vals[1] - vals[0]) : 0;
  };


  /**
   * **盘面签名** —— "这块盘面长什么样"的唯一指纹。
   *
   * 量程 / 单位 / 红区 / 半径 / 角度范围**任何一个变了，签名就变**，
   * 绘制层据此**重建盘面**。
   *
   * 为什么必须显式做这件事（参考实现踩过的坑）：页脚写着"能量回收 %"，
   * 而盘面还标到 300 —— 因为它只改了 `max` 这个数，
   * 盘面（红区 + 刻度 + 数字）是**上一次**生成好留在那儿的。
   * 刻度是"算出来的"，不是"画上去的"：算它的输入变了就必须重算。
   */
  window.dialSig = function (opts) {
    const o = Object.assign({}, DIAL_DEFAULT, opts || {});
    const rl = window.dialRedlines(o).map(z => z.from + "-" + z.to).join(",");
    // ⚠️ `major` 为 null 是"自动"这个**模式**本身，不能落成数字 0 ——
    //    它一变，刻度步长就变，盘面必须重建。
    const majorTag = (o.major === null || o.major === undefined) ? "auto" : String(num(o.major, 8));
    return [
      "v1",
      "min" + num(o.min, 0), "max" + num(o.max, 100),
      "M" + majorTag, "m" + num(o.minor, 4), "T" + num(o.majorTarget, 8),
      "r" + num(o.r, 150), "a" + num(o.start, 135) + "x" + num(o.sweep, 270),
      "c" + num(o.cx, 200) + "," + num(o.cy, 200),
      "u" + String(o.unit || ""),
      "R" + rl,
    ].join("|");
  };

  /**
   * 红区归一化：`redlines` 数组优先，否则用 `redlineFrom`/`redlineTo` 拼一个。
   * 一律夹到 `[min, max]`，夹完为空（from ≥ to）的直接丢掉。
   */
  window.dialRedlines = function (opts) {
    const o = Object.assign({}, DIAL_DEFAULT, opts || {});
    const min = num(o.min, 0), max = num(o.max, 100);
    let list = Array.isArray(o.redlines) ? o.redlines.slice() : [];
    if (!list.length && o.redlineFrom !== null && o.redlineFrom !== undefined) {
      list = [{ from: o.redlineFrom, to: (o.redlineTo === null || o.redlineTo === undefined) ? max : o.redlineTo }];
    }
    return list.map(function (z) {
      const a = clamp(num(z && z.from, min), min, max);
      const b = clamp(num(z && z.to, max), min, max);
      return { from: a, to: b };
    }).filter(z => z.to > z.from);
  };

  /**
   * **算出一块表盘**（参考实现的 `buildDial`）。
   *
   * 极坐标生成刻度与数字 —— 不依赖任何素材图，
   * 所以"量程 0~8000 的转速表"和"0~20 的电压表"是同一段代码。
   *
   * @returns 盘面对象：`{sig, min, max, …, val2ang, ticks, labels, redlines, arc}`
   *   - `ticks`  每一根刻度线（大格 + 小格），含 `ang` 与两个端点坐标
   *   - `labels` 只含大格的数字（画文字用）
   *   - `arc`    整段弧的长度（`r·θ`，画进度弧时当 dasharray 用）
   */
  window.buildDial = function (opts) {
    const o = Object.assign({}, DIAL_DEFAULT, opts || {});
    const cx = num(o.cx, DIAL_DEFAULT.cx);
    const cy = num(o.cy, DIAL_DEFAULT.cy);
    const r = Math.max(1, num(o.r, DIAL_DEFAULT.r));
    const start = num(o.start, DIAL_DEFAULT.start);
    const sweep = num(o.sweep, DIAL_DEFAULT.sweep);
    const min = num(o.min, DIAL_DEFAULT.min);
    const max = num(o.max, DIAL_DEFAULT.max);
    const span = max - min;
    // 小格数夹一下：手改文件写出 minor=1e9 会直接把浏览器冻住
    const K = Math.round(clamp(num(o.minor, DIAL_DEFAULT.minor), 1, 20));
    // 大格：`major` 给了数字就是均匀分这么多格，没给就自动选步长（见 dialAutoMajorStep）
    const majorValues = window.dialMajorValues(min, max, o.major, num(o.majorTarget, 8));
    const majorStep = majorValues.length > 1 ? (majorValues[1] - majorValues[0]) : 0;

    /**
     * 值 → 角度。**夹到 [0,1]**：
     * 超出量程的值（比如瞬时超压）不该让指针跑到表盘外面去。
     */
    const val2ang = function (v) {
      const t = span > 0 ? clamp((num(v, min) - min) / span, 0, 1) : 0;
      return start + sweep * t;
    };

    const ticks = [];
    const labels = [];
    for (let i = 0; i < majorValues.length; i++) {
      const v = majorValues[i];
      const ang = val2ang(v);
      ticks.push({ value: v, ang: ang, major: true, label: fmtTick(v) });
      labels.push({ value: v, ang: ang, text: fmtTick(v) });
      // 大格之间的小格（最后一段不补 —— 后面没有下一根大格）
      if (i < majorValues.length - 1 && majorStep > 0) {
        for (let j = 1; j < K; j++) {
          const vv = v + majorStep * j / K;
          ticks.push({ value: vv, ang: val2ang(vv), major: false, label: null });
        }
      }
    }

    const redlines = window.dialRedlines(o).map(function (z) {
      return { from: z.from, to: z.to, angFrom: val2ang(z.from), angTo: val2ang(z.to) };
    });

    return {
      sig: window.dialSig(o),
      cx: cx, cy: cy, r: r, start: start, sweep: sweep,
      min: min, max: max, span: span,
      /** 大格**数量**（自动模式下是选出来的，不是填的） */
      major: majorValues.length,
      /** 大格之间的步长（值） */
      majorStep: majorStep,
      minor: K,
      unit: String(o.unit || ""),
      val2ang: val2ang,
      ticks: ticks,
      labels: labels,
      redlines: redlines,
      // 整段弧长（角度制 → 弧度）：进度弧的 dasharray 就是它
      arc: { angFrom: start, angTo: start + sweep, len: r * sweep * Math.PI / 180 },
    };
  };

  /**
   * 刻度数字**隔几个画一个**（1 = 全画，2 = 隔一个，3 = 隔两个）。
   *
   * 为什么必须做：自动选步长会给出 13~14 个大格（车速 0~260 步长 20），
   * 在 270° 的弧上，靠里的那圈数字**会挤在一起糊成一片**。
   * 真表遇到这种情况就是隔一个标一个。
   *
   * 判据是**弦长**（两个相邻数字的直线距离）够不够放下一个数字：
   * 数字宽度按 `0.62 × 字号 × 位数` 估（等宽数字的保守值），
   * 放不下就隔一个，再放不下就隔两个。
   *
   * @param face     `buildDial()` 的结果
   * @param fontPx   数字的字号
   * @param labelR   数字所在的半径（弦长按这个半径算）
   */
  window.dialLabelStride = function (face, fontPx, labelR) {
    const n = face && face.labels ? face.labels.length : 0;
    if (n < 2) return 1;
    let maxLen = 1;
    face.labels.forEach(function (l) { maxLen = Math.max(maxLen, String(l.text).length); });
    const w = Math.max(1, num(fontPx, 10)) * 0.62 * maxLen;
    const dAng = Math.abs(num(face.sweep, 270)) / (n - 1) * Math.PI / 180;
    const chord = 2 * Math.max(1, num(labelR, 50)) * Math.sin(dAng / 2);
    if (chord >= w * 1.25) return 1;
    if (chord * 2 >= w * 1.25) return 2;
    return 3;
  };

  // ================================================================ 5. 弧进度

  /**
   * 进度弧的 **stroke-dashoffset** 换算（参考实现的做法）。
   *
   * 思路：路径**只画一次**（整段弧），进度只改一个标量 ——
   * 而不是"按比例重画一段更短的弧"。后者每帧都在重新走一遍路径构造，
   * 而且弧的两端（lineCap / 抗锯齿）每帧都在抖。
   *
   * ```js
   * // SVG 里：
   * prog.style.strokeDasharray  = len;          // 虚线段长 = 整条路径长
   * prog.style.strokeDashoffset = len;          // 1 = 空
   * //                       → 0 = 满（dashoffset 归零，虚线正好盖满）
   * ```
   *
   * ⚠️ **canvas 没有 `getTotalLength()`** —— 圆弧是解析可算的，
   * 长度就是 `r · θ`（θ 用弧度）。所以这里由调用方传 `len`，
   * 换算本身与"长度怎么来的"无关。
   *
   * canvas 的对应物是 `setLineDash([len])` + `lineDashOffset`，
   * 语义与 SVG 完全一致（奇数长度的 dash 数组会重复一遍 → `[len]` = `[len, len]`）。
   *
   * @returns {{dasharray:number, dashoffset:number, ratio:number}}
   */
  window.arcDash = function (len, ratio) {
    const L = Math.max(0, num(len, 0));
    const t = clamp(num(ratio, 0), 0, 1);
    return { dasharray: L, dashoffset: L * (1 - t), ratio: t };
  };

  /**
   * 把弧进度**写进一个 2D context**（设置完由调用方 `stroke()` 再还原）。
   *
   * ⚠️ 用**当前变换空间**的单位 —— 画布上节点会被缩放，
   * 所以 `len` 必须与 `arc()` 用的半径同一个坐标系（都是节点单位），
   * 否则虚线密度对不上（症状是"进度条变成一排小点"）。
   */
  window.applyArcProgress = function (c, len, ratio) {
    const d = window.arcDash(len, ratio);
    if (c && typeof c.setLineDash === "function") {
      // dasharray 为 0 时 canvas 会忽略整条虚线设置 → 给个极小值
      c.setLineDash([Math.max(0.01, d.dasharray)]);
      c.lineDashOffset = d.dashoffset;
    }
    return d;
  };

  /** 还原（每个进度弧画完必须调，否则后面所有线都变虚线） */
  window.clearArcProgress = function (c) {
    if (c && typeof c.setLineDash === "function") {
      c.setLineDash([]);
      c.lineDashOffset = 0;
    }
  };

  // ================================================================ 6. 数字鼓

  /**
   * 数字鼓的**一位**：给定"这一位滚到哪儿了"，算条带该位移多少像素。
   *
   * ## 三个坑（都写在这儿，因为它们是同一个函数的三条边）
   *
   * ### 坑 1：`yPercent` 是**相对条带自身高度**的百分比
   *
   * 条带里有 `rows` 行数字，所以**一行 = `100 / rows` %**。
   * 10 行时一行 10%，20 行时一行 **5%** ——
   * 参考实现把 10 行改成 20 行时忘了改这步，
   * 于是"所有数字显示成 2 倍"（位移百分比翻倍）。
   *
   * 本函数的对策：**位置一律用像素算**（`offsetPx`），
   * 百分比（`stepPct`）只作为"要和百分比体系对接时"的输出，
   * 且**每次按当前 rows 重算** —— 缓存它就是在缓存坑。
   *
   * ### 坑 2：从 DOM 读当前位置，不要缓存
   *
   * 缓存的位置在补间被打断时**失真**（参考实现症状："重播后锁死 888"）。
   * 本函数**无状态**：同样的输入永远给同样的输出，调用方每帧重新问一次。
   *
   * ### 坑 3：**只向前滚**，不依赖 `onComplete` 回位
   *
   * 9 → 0 是**继续往前滚**（里程表就是这样），不是倒着滑回去。
   * 而且位置只由值决定 —— 不靠"动画播完了再复位"这种时序假设，
   * 所以中途改值/打断都不会留下错位的条带。
   *
   * @param value 条带位置（可以带小数：`3.4` = 第 3 行往下滚了 40%）
   * @param opts  `{rows, rowH}` —— rows 是条带里的行数，rowH 是一行多高（px）
   */
  window.drumSlot = function (value, opts) {
    const o = opts || {};
    const rows = Math.max(2, Math.round(num(o.rows, 10)));
    const rowH = Math.max(0.01, num(o.rowH, 10));
    const stripH = rowH * rows;              // 条带自身高度
    const v = num(value, 0);
    // **只向前滚**：取模而不是取绝对值 —— 9→10 落回第 0 行继续往前
    const wrapped = ((v % rows) + rows) % rows;
    const whole = Math.floor(wrapped);
    const frac = wrapped - whole;
    const offsetPx = -wrapped * rowH;        // 条带往上移这么多（负 = 往上）
    const frac2 = frac;
    return {
      rows: rows, rowH: rowH, stripH: stripH, value: v,
      wrapped: wrapped, whole: whole, frac: frac,
      digit: whole % rows,
      nextDigit: (whole + 1) % rows,
      /** **条带**的位移（负 = 往上） */
      offsetPx: offsetPx,
      /**
       * 第 `row` 行数字画在哪儿（相对基准线的偏移）。
       *
       * ⚠️ 这是"条带位移"换算成"某一行在哪儿"的唯一入口 ——
       * 直接拿 `offsetPx` 当某位数字的 y 是**错的**：
       * `offsetPx` 是**条带**的位置，第 row 行还要加上 `row·rowH`。
       * （这是数字鼓实现里最容易错的一处，所以在这儿给成函数。）
       */
      rowDy: function (row) { return num(row, 0) * rowH + offsetPx; },
      /** 当前这一位的偏移（基准线 + 它就对了） */
      digitDy: -frac2 * rowH,
      /** 下一位数字的偏移（它正从下面滚进来） */
      nextDigitDy: (1 - frac2) * rowH,
      stepPx: rowH,                          // 一步（一个数字）= 一行
      stepPct: 100 / rows,                   // ⚠️ yPercent 口径：一行 = 100/rows %
      offsetPct: (wrapped / rows) * 100,     // ⚠️ 同上，当前位置的百分比口径
      /**
       * 把一个**百分比口径**的位移按**当前**条带高度解析成像素。
       *
       * yPercent / translateY(%) 就是这么解析的 —— 相对**当前**元素高度。
       * 所以"上次按 10 行算出来的 30%"贴到"现在 20 行的条带"上会变成 2 倍。
       * 测试直接断言这个差值，它就是参考实现"数字显示成 2 倍"的成因。
       */
      pctToPx: function (pct) { return (num(pct, 0) / 100) * stripH; },
    };
  };

  /**
   * 一个**多位数**的鼓：整数部分定每一位的数字，**只有最低位**跟着小数滚。
   *
   * 这就是里程表的行为：12.4 显示 "12"，最后一位"2"正滚到 40% 的位置；
   * 12.9 时"2"滚到 90%，再往前就是 13.0（"2"滚出、"3"滚入）。
   *
   * @param opts `{rowH, digits}` —— digits 是显示几位（不足补 0）
   */
  window.drumDigits = function (value, opts) {
    const o = opts || {};
    const rows = 10;                          // 十进制一位 = 10 行（0..9）
    const rowH = Math.max(0.01, num(o.rowH, 10));
    const digits = Math.round(clamp(num(o.digits, 3), 1, 12));
    const v = Math.max(0, num(value, 0));
    const intPart = Math.floor(v);
    const frac = v - intPart;
    const text = String(intPart).padStart(digits, "0").slice(-digits);
    const slots = [];
    for (let i = 0; i < digits; i++) {
      const d = Number(text.charAt(i));
      const digit = Number.isFinite(d) ? d : 0;
      const isLast = (i === digits - 1);
      const p = isLast ? frac : 0;            // 只有最低位滚
      const slot = window.drumSlot(digit + p, { rows: rows, rowH: rowH });
      slot.index = i;
      slot.digit = digit;
      slot.frac = p;
      slots.push(slot);
    }
    return { digits: digits, rows: rows, rowH: rowH, value: v, text: text, slots: slots };
  };
})();
