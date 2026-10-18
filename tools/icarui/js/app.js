/* ==========================================================================
   app.js —— 装配与启动
   --------------------------------------------------------------------------
   职责：
     - 全局状态（design / selection / snap / 模拟）
     - 撤销集成：所有改动走 window.commit()，自动压栈 + 刷新
     - 文件读写（打开 / 保存 v2 / 导出 v1）
     - 校验结果显示
     - JSON 双向同步
     - 实时数据模拟
   ========================================================================== */
"use strict";

(function () {
  const S = window.CanvasState;
  const undo = new window.UndoStack(100);
  let batch = null;          // {label, depth} —— 批量改动只压一次栈
  let suppressJsonSync = false;

  /**
   * 最近一次 `restore()` **失败收尾**里，"画布有没有按实际设计重画成功"（T5-R3）。
   *
   * ⚠️ 为什么要记它：`restore()` 只返回 `false`，而"失败"有两种收尾质量 ——
   *   · 画布已经按回滚后的实际设计重画过 → 界面自洽；
   *   · 重画**自己也抛**了（持续异常）→ 画面可能还停在候选那一帧。
   * 两种都**不向调用方抛**，但**绝不能都算"已复原"**。这里如实记下来，
   * 并由只读钩子 `window.__lastRestoreFinish()` 暴露给套件直接断言
   * （与 `__jsonSyncFlags` 同一个理由：状态必须能被测，不能靠观感猜）。
   */
  let lastRestoreFinish = null;

  function el(id) { return document.getElementById(id); }

  // ================================================================ 撤销集成

  /** 当前状态快照（只序列化设计本身，不含界面状态） */
  function snapshot() {
    return JSON.stringify({
      d: S.design,
      sel: S.selection,
    });
  }

  /**
   * 快照的**最低结构校验**（T5-A 引入；T5-R 返工补全，未发版）。返回错误原因，可用则返回 `null`。
   *
   * ## 为什么"解析成功"不等于"快照可用"
   *
   * `JSON.parse` 只保证是合法 JSON。`"null"`、`"[1,2]"`、`"{}"`、
   * `{"d":null}` 全都解析成功，但没有一个能当快照用。旧代码在这里只查了
   * `o.d` 是不是对象 —— 于是**结构坏了但 JSON 合法**的那些（`d` 里没有
   * `nodes`、`pages` 不是数组、`sel` 不是数组）一路放行，
   * 赋值给 `S.design` 之后才在 `refreshAll()` / `draw()` 里炸掉。
   *
   * ## 为什么加载和 restore 必须用**同一个**判据
   *
   * 两处判据不一致 = 加载时留下的"好"记录，撤销到它时仍然会失败。
   * 所以 `loadUndoStack` 与 `restore` 都走这一个函数。
   *
   * ## ⚠️ T5-R 返工：判据要覆盖**恢复路径真的会读到的**最低结构
   *
   * T5-A 第一版只查 `nodes`/`pages` 是数组、`sel` 是字符串数组，
   * 于是下面四类**数组层面看着"结构有效"**的快照被判可用，`restore` 一路
   * 走到 `syncJson()` / `toV2Json()` / `draw()` 才抛（规划方在真实 `file:` 页面实测）：
   *
   * | 快照 | 第一版 | 真实读取点 |
   * |---|---|---|
   * | 缺 `canvas` | 判**可用** ✗ | `syncJson()` 读 `S.design.canvas.designW` |
   * | `nodes=[null]` | 判**可用** ✗ | `nodeToJson` / `draw` 读 `n.id`、`n.type` |
   * | `pages=[null]` | 判**可用** ✗ | `currentPage()` / 页签读 `pg.nodes` |
   * | `assets` 是对象 | 判**可用** ✗ | `toV2Json` 遍历 `rd.assets` |
   *
   * 所以判据改成**按"后面每一步真的会用到"的结构逐项查**：
   *
   *  · `d` 是对象，且 `d.nodes` 是数组、**里面每一项都是节点对象**（不是 null/字符串/数字）；
   *  · `d.pages` 要么没有、要么是数组，且**每一项都是带 `nodes` 数组的页对象**
   *    （`pageIndex` 越界**不**硬拒：现有代码本来就容错，见 `currentPage()`）；
   *  · 节点**有 `children` 字段时**必须是数组（旧节点没有这个字段 = 叶节点，仍然合法）；
   *  · `d.canvas` **要么没有、要么是对象**（T5-A 第一版在这里放行了"`canvas` 是
   *    数字/字符串"——那不可能来自任何一版快照，直接拒）。**缺 `canvas` 仍然接受**：
   *    它是有依据的旧形态（旧快照可以只有 `nodes`），由 `restore()` 用
   *    `normalizeSnapshotDesign()` 做**纯候选归一化**把缺省值补上 —— 不靠
   *    "反正有默认值"这种没验证过的说法（T5-A 正是这么放行的，实测 `designW` 直接抛）；
   *  · `d.assets` 要么没有、要么是数组（`toV2Json` 直接 `.map`）；
   *  · `sel` 要么没有、要么是数组且元素是字符串 —— 指向已删除节点的
   *    id 仍然合法，`findNode` 自己会返回 null，不该因此判快照坏了。
   *
   * ⚠️ **不查**每个节点的字段形状（`name`/`x`/`pid`/部件…）。理由有两条：
   *  1. 那是"旧快照可能只有一部分字段"的正常情形，硬拒就是验收禁止的**误伤**；
   *  2. 那一类坏记录由 `restore()` 的**失败回滚**兜住（见下面的说明），
   *     不需要把判据写成"半个 schema 校验器"。
   *
   * ⚠️ 判据只**接受 / 拒绝**，**不做归一化**：恢复路径上不许"修一修再赋值"，
   * 否则"失败后 design/selection/JSON/dirty 一个字节都不变"这条就没有保证
   * （改了一半再失败，已经不是原值了）。
   */
  function snapshotProblem(snap) {
    // ⚠️⚠️ 整个判据**绝不许抛**（T5-R2 修正）。
    //
    // 规划方实测：可解析的 10000 层 `children` 让 `nodeProblem` 递归爆栈，
    // 而 `snapshotProblem` 当时在 `restore()` 的事务 `try` **之外** ——
    // `restore` 抛 `Maximum call stack size exceeded` 而不是返回 `false`。
    // 更糟的是它还被 `UndoStack._usable` 用（`_step` 的扫描里），
    // 所以"判据抛异常"会污染撤销栈的走法本身。
    //
    // 现在两道保险：`nodeProblem` 改成迭代 + 显式预算（不再爆栈），
    // 这里再包一层 `try/catch` 把任何意外都变成"这条快照不可用"。
    try {
      if (typeof snap !== "string" || !snap) return "不是字符串";
      let o = null;
      try {
        o = JSON.parse(snap);
      } catch (e) {
        return "不是合法 JSON";        // 截断、半截字符串
      }
      if (!o || typeof o !== "object" || Array.isArray(o)) return "不是一个快照对象";
      if (!o.d || typeof o.d !== "object" || Array.isArray(o.d)) return "缺少设计（d）";
      if (!Array.isArray(o.d.nodes)) return "设计的节点表（d.nodes）不是数组";
      if (o.d.nodes.length > NODE_SCAN_LIMIT) {
        return "设计的节点表（d.nodes）有 " + o.d.nodes.length + " 项，超过 " + NODE_SCAN_LIMIT + " 无法验证";
      }
      for (let i = 0; i < o.d.nodes.length; i++) {
        const bad = nodeProblem(o.d.nodes[i]);
        if (bad) return "设计的节点表（d.nodes）第 " + i + " 项" + bad;
      }
      if (o.d.pages != null) {
        if (!Array.isArray(o.d.pages)) return "设计的页表（d.pages）不是数组";
        for (let i = 0; i < o.d.pages.length; i++) {
          const pg = o.d.pages[i];
          // ⚠️ 页对象必须有 `nodes` 数组：`currentPage()` 直接读 `pg.nodes`，
          // `pages=[null]` / `pages=[{id}]` 都过不了这一关。
          if (!pg || typeof pg !== "object" || Array.isArray(pg)) {
            return "设计的页表（d.pages）第 " + i + " 项不是页对象";
          }
          if (!Array.isArray(pg.nodes)) {
            return "设计的页表（d.pages）第 " + i + " 项的 nodes 不是数组";
          }
          // ⚠️⚠️ 页里的节点**也要逐个过一遍**（T5-R2 补的缺口）。
          //
          // 原来这里只查"`pg.nodes` 是数组"，**不查里面每一项** —— 而恢复路径
          // 真的会读它们（`resolveDesign()` / `currentPage()` / `draw()`）。
          // 实测反例：坏节点藏在 `pages[0].nodes` 里时判据放行、后面才炸。
          if (pg.nodes.length > NODE_SCAN_LIMIT) {
            return "设计的页表（d.pages）第 " + i + " 项的 nodes 有 " + pg.nodes.length + " 项，超过 " + NODE_SCAN_LIMIT + " 无法验证";
          }
          for (let j = 0; j < pg.nodes.length; j++) {
            const badPg = nodeProblem(pg.nodes[j]);
            if (badPg) return "设计的页表（d.pages）第 " + i + " 项的 nodes 第 " + j + " 项" + badPg;
          }
        }
      }
      // ⚠️ `canvas` **要么没有、要么是对象**（T5-R 返工）。
      //
      // 明确**不据此硬拒**：缺 `canvas` 是**有依据的旧形态**（旧快照可以只有
      // `nodes`），验收禁止"对旧合法快照的无依据硬拒绝"。
      // 但 T5-A 放行它的**理由**（"现有代码按默认值走"）是错的 —— 规划方实测
      // `toV2Json()` / `syncJson()` 直接读 `design.canvas.designW`，缺了就是
      // `TypeError`。所以现在改成：**判据继续接受，`restore()` 里先做纯候选
      // 归一化**（见 `normalizeSnapshotDesign`）把缺省补上，再走后面的同步/刷新。
      // 拒绝的只有"有 `canvas` 但根本不是对象"——那不可能来自任何一版快照。
      if (o.d.canvas != null && (typeof o.d.canvas !== "object" || Array.isArray(o.d.canvas))) {
        return "画布（d.canvas）不是对象";
      }
      if (o.d.assets != null && !Array.isArray(o.d.assets)) return "素材表（d.assets）不是数组";
      if (o.sel != null) {
        if (!Array.isArray(o.sel)) return "选区（sel）不是数组";
        for (let i = 0; i < o.sel.length; i++) {
          if (typeof o.sel[i] !== "string") return "选区（sel）里有非字符串项";
        }
      }
      return null;
    } catch (e) {
      // 判据自己出意外（爆栈/内存/宿主环境的怪东西）→ 一律当"这条不可用"。
      // ⚠️ **这不是"护栈静默丢合法节点"**：走到这里说明判据根本没法给出
      //    可信结论，说"可用"才是拿用户的设计去赌。
      return "判据本身无法完成校验（" + String((e && e.message) || e) + "）";
    }
  }

  /**
   * 一个节点"最低限度是不是节点"（只看恢复路径**必然直接读**的两样）：
   * 是对象、`children`（有的话）是数组。返回错误原因，可用则返回 `null`。
   *
   * ⚠️ 刻意**不查** `id` / `type` / 名字 / 坐标 —— 那属于"旧快照字段不全"，
   * 现有代码对它们本来就容错（`nodeToJson` 有 `num()` 缺省值），硬拒会误伤。
   *
   * ## ⚠️⚠️ 必须**迭代**遍历，不能递归（T5-R2 修正）
   *
   * 规划方实测：**可解析**的 10000 层 `children` JSON 在这两个函数里抛
   * `Maximum call stack size exceeded`，而且发生在事务 `try` **之外**
   * —— `restore()` 抛异常而不是返回 `false`。
   *
   * 现在用显式数组当工作栈（深度优先），配**两层显式预算**：
   *  · `NODE_SCAN_LIMIT`：最多检查多少个节点；
   *  · `NODE_DEPTH_LIMIT`：`children` 最多多少层。
   *
   * 超预算 = **拒绝**（返回一个说明文案），不是"检查一半就当通过"。
   * ⚠️ 这**不是**"为了护栈静默丢合法节点"：没超预算的节点**一个都不放过**，
   * 全部逐个查（`pages[].nodes` 与 `children` 两条实际读取路径都覆盖）；
   * 只有"这份 JSON 大到/深到根本没法验证"时才拒绝 —— 那时说"可用"才是撒谎。
   */
  const NODE_SCAN_LIMIT = 200000;
  const NODE_DEPTH_LIMIT = 512;

  function nodeProblem(n) {
    // 工作栈里每项是 { node, depth, path }；`path` 用于把错误定位成人看得懂的路径
    const work = [{ node: n, depth: 1, path: "" }];
    let scanned = 0;
    while (work.length) {
      const it = work.pop();
      const cur = it.node;
      if (++scanned > NODE_SCAN_LIMIT) {
        return "（节点太多，超过 " + NODE_SCAN_LIMIT + " 个，无法验证）";
      }
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return it.path + "不是节点对象";
      if (cur.children != null) {
        if (!Array.isArray(cur.children)) return it.path + "的 children 不是数组";
        if (it.depth >= NODE_DEPTH_LIMIT) {
          return it.path + "的嵌套深度超过 " + NODE_DEPTH_LIMIT + " 层，无法验证";
        }
        // ⚠️ 倒着压栈，弹出顺序才与原来的递归一致（错误定位到**第一条**坏节点）
        for (let i = cur.children.length - 1; i >= 0; i--) {
          work.push({ node: cur.children[i], depth: it.depth + 1, path: it.path + "的 children 第 " + i + " 项" });
        }
      }
    }
    return null;
  }

  /** 这条快照能不能用（`UndoStack.undo/redo` 与 `loadUndoStack` 共用的判据） */
  function isUsableSnapshot(snap) { return snapshotProblem(snap) === null; }

  /**
   * 把一份**已经通过判据**的快照设计归一化成"恢复路径读得动"的候选（T5-R）。
   *
   * ## 为什么需要它，以及它**不是**什么
   *
   * 判据里刻意接受了"缺 `canvas` / 缺 `assets` / 只有 `nodes`"这些**有依据的旧形态**
   * （验收禁止对旧合法快照的无依据硬拒绝）。但恢复路径**真的会直接读**这些字段：
   * `toV2Json()` / `syncJson()` 读 `design.canvas.designW`、`toV2Json` 读 `assets.map`。
   * T5-A 只写了一句"现有代码按默认值走"就放行了 —— 那句话说错了，实测直接抛。
   *
   * 所以这里把缺省值**显式补齐**，补齐的只是"缺了就没法同步/绘制"的那几样：
   *
   * ```
   * canvas:   { unit, designW: 2560, designH: 1600, scaleMode: STRETCH }
   * assets:   []        controls: []       pages: [{id:'pg0', name:'主页面', nodes}]
   * pageIndex: 0
   * ```
   *
   * ## ⚠️ 三条约束（都来自验收）
   *
   *  1. **纯候选**：只读 `design`、返回一个**新对象**，不改调用方给的那份
   *     （`Object.assign({}, design)` 只是浅拷贝一层，其余字段仍是原引用 ——
   *     这一步不改它们，只补缺失的顶层字段）；
   *  2. **只在缺失时补**：有值的字段（`canvas`、`pages`…）**原样保留引用**，
   *     不做任何"修一修"；
   *  3. 归一化**只在 `restore()` 内部**用于赋值与同步 —— 判据本身**不做归一化**，
   *     `isUsableSnapshot()` 的语义仍然是"接受 / 拒绝"。
   */
  function normalizeSnapshotDesign(design) {
    const d = Object.assign({}, design);      // 浅拷贝：其余字段保持原引用
    if (!d.canvas || typeof d.canvas !== "object" || Array.isArray(d.canvas)) {
      d.canvas = {
        unit: window.CANVAS,
        designW: 2560,
        designH: 1600,
        scaleMode: window.SCALE_STRETCH,
      };
    }
    if (!Array.isArray(d.assets)) d.assets = [];
    if (!Array.isArray(d.controls)) d.controls = [];
    // 页表：老快照可能没有 `pages`（只有 `nodes`）→ 补一个页，`nodes` 用**同一个引用**
    // （`design.nodes === design.pages[pageIndex].nodes` 这条别名必须成立）。
    // ⚠️ 已经有 `pages` 时**不动 `nodes`**：`nodes` 才是内存里"活着的那份"
    //    （见 `resolveDesign` 的说明），把它换成 `pages[pi].nodes` 会把当前页
    //    的内容换成页表里那份**已经落后**的副本 —— 实测症状是"撤销后画布上
    //    新加的控件全部消失"（套件 (a1)/(a2)/连续坏 三处同时报红）。
    if (!Array.isArray(d.pages) || !d.pages.length) {
      d.pages = [{ id: "pg0", name: "主页面", nodes: d.nodes }];
      d.pageIndex = 0;
    } else if (typeof d.pageIndex !== "number" || !d.pages[d.pageIndex]) {
      d.pageIndex = 0;
    }
    return d;
  }

  /**
   * 从快照恢复。**返回是否成功** —— 调用方要据此决定提示什么。
   *
   * 为什么要防御（v2.37.0）：撤销栈会**持久化到 localStorage**，
   * 而那里的内容可能被截断或写坏（配额、隐私模式、外部改动）。
   * 原来这里裸调 `JSON.parse` —— 一坏就抛，**撤销按钮静默失灵**：
   * 点了没反应、没有 toast、界面上什么都没有，只有 console 里一行红字。
   *
   * "静默失灵"是这类问题里最糟的形态：用户会以为是"撤销坏了"，
   * 而不是"这一条记录坏了"。
   *
   * ## ⚠️ 校验必须**全部做完再赋值**（T5-A）
   *
   * 旧代码的赋值在 `refreshAll()` **之前**。只要刷新那一侧抛一次
   * （设计结构坏到 `draw()` 都不认），`S.design` 已经被换成坏快照了，
   * 而 `restore` 因为异常冒出去**没返回 false** —— 留下的是"半套状态"：
   * 画布是坏的、撤销栈的索引却已经动了。现在校验先跑完，赋值是最后一步，
   * 失败路径上 `S.design` / `S.selection` **一个字节都没动**。
   *
   * ## ⚠️ T5-R 返工：光"先校验后赋值"不是**事务**
   *
   * 规划方在真实 `file:` 页面实测：判据放行、赋值之后才在 `syncJson()` /
   * `toV2Json()` 里抛的四类快照（缺 `canvas`、`nodes=[null]`、`pages=[null]`、
   * `assets` 是对象），**design 已经被换掉、dirty 已经被清掉、JSON 草稿被覆盖**，
   * 而异常冒出去 —— `restore` 连 `false` 都没返回。
   * 也就是说 T5-A 声称的"失败路径 design/selection 一个字节都不动"
   * 只对**判据自己拦住**的那些成立，对"判据没拦住、后面才炸"的一类不成立。
   *
   * 现在按**失败回滚**做实：
   *
   *  1. `prepareDesign()` 把"同步 JSON 要用的那个文本"**先算好**放到
   *     `pendingJson`（写 DOM 是后面的事）。这一步抛 = 还没动任何状态，直接 false；
   *  2. 捕获 `design` / `selection` 的**引用**、`jsonArea` 的**原文**、
   *     `jsonDirty` 与 dirty 提示条的当前状态；
   *  3. 赋值 + `syncJson()` + `refreshAll()` + `updateUndoButtons()`
   *     **整体** `try/catch`；任何一处抛异常 → 回滚上面全部（含临时标志
   *     `suppressJsonSync` 归位、dirty 状态与 dirty 提示条复原）→ 返回 `false`；
   *  4. `pendingJson` 没算出来时**绝不写 JSON 文本域** —— 未应用的 JSON 草稿
   *     一个字节都不会被覆盖。
   *
   * ⚠️ `syncJson()` 在 `jsonDirty` 为真时**自己会提前 return**（那是 T6 的
   * 「正常撤销时的 JSON 交互方案」，本卡不做）；这里只保证"失败不丢草稿"。
   */
  function restore(snap) {
    if (typeof S === "undefined" || !S) return false;   // 没装配好就没有可恢复的状态
    // ⚠️ 每次进来先清掉上一次的收尾记录（T5-R3）：`null` = 这一次没有走失败收尾
    //    （成功恢复、或判据/准备阶段就干净失败），不是"画布重画失败"。
    lastRestoreFinish = null;

    // ⚠️⚠️ 判据与解析**必须在 try 之内**（T5-R2 修正）。
    //
    // 规划方实测：可解析的 10000 层 `children` 让 `snapshotProblem`/`nodeProblem`
    // 递归爆栈，而这两句当时在事务之外 —— `restore()` **抛异常**而不是返回
    // `false`，调用方（`doUndo`/`doRedo`）直接被异常打断。
    // 验收要求"`restore` 对解析/判据/准备异常均 `false` 且不抛"。
    //
    // 现在拆成**两层**（与验收逐条对应）：
    //  ① 判据 + `JSON.parse`（可能爆栈 / 可能被宿主环境里的 getter 弄抛）；
    //  ② 归一化 + `toV2Json` 准备（`prepareDesign` 那一层）。
    // 两层都在 `restore` 内部、都由 `try/catch` 兜住并返回 `false`。
    let o = null;
    let cand = null;
    try {
      if (snapshotProblem(snap) !== null) return false;   // 先校验，再赋值
      o = JSON.parse(snap);
    } catch (e) {
      console.warn("快照无法解析/校验，已拒绝恢复：", e && e.message);
      return false;
    }

    // ---- 第 1 步：准备（**纯计算，不碰任何状态**）
    //
    //  `cand` 是**纯候选**：缺 `canvas`/`assets`/`pages` 的旧快照在这里补齐缺省
    //  （见 `normalizeSnapshotDesign`），判据本身只接受/拒绝、不做归一化。
    //  抛异常 = 这份设计连"同步 JSON"都过不去 → 直接失败，design 一个字节没动。
    let pendingJson = null;
    try {
      cand = normalizeSnapshotDesign(o.d);
      pendingJson = window.toV2Json(cand);
    } catch (e) {
      console.warn("快照无法同步到 JSON 文本域，已拒绝恢复：", e && e.message);
      return false;
    }

    // ---- 第 2 步：回滚现场（全部是"取值"，不改任何东西）
    //
    // ⚠️ T5-R2：这里不只是 design/selection/JSON 文本，还包括**已经写进
    //    元数据表单的值**与**dirty 提示条的整段内容**。
    //    规划方实测的反例：让真实 `window.draw` 抛一次之后，design/selection
    //    引用与草稿/dirty 标志确实回滚了，但 **`mName` 仍显示 TARGET**、
    //    **dirty 提示从"1 个错误"变成"0 个错误"**（`areaDirty` 只是个布尔，
    //    没有把"几个错误"存下来）。现在整份现场一起存、一起还原。
    const prevDesign = S.design;        // 只存引用：回滚要把**同一个对象**放回去
    const prevSelection = S.selection;
    const area = el("jsonArea");
    const prevJsonText = area ? area.value : null;
    const dirtyState = captureDirtyState();
    // 元数据表单里**与本次恢复有关**的那几个值的原文（回滚要逐字段还原）
    const FORM_IDS = ["mName", "mAuthor", "mDesc", "mTheme", "dW", "dH",
      "scaleMode", "bgPath", "bgFit", "bgW", "bgH"];
    const prevForm = FORM_IDS.map(function (id) {
      const e = el(id);
      return { id: id, v: e ? e.value : null };
    });

    // ---- 第 3 步：应用（失败要能整体回滚）
    //
    // ⚠️ `suppressJsonSync` 的归位用**最外层 finally**（T5-R2）：原来只在
    //    `syncPreparedJson` 外面那一层 finally 里归位，`refreshAll()` 抛出去
    //    时仍然能归位 —— 但回滚路径本身再抛就漏了。现在无论哪条路出去都归位。
    const prevSuppress = suppressJsonSync;
    let ok = false;
    suppressJsonSync = true;
    try {
      S.design = cand;
      S.selection = o.sel || [];
      setJsonDirty(false);        // 撤销/重做整体替换设计，文本域跟着走
      syncPreparedJson(pendingJson);
      refreshAll();
      // ⚠️ 必须刷新撤销按钮 —— 第一版漏了这句，撤销后计数一直是旧值
      // （实测：连按撤销，界面上的"100 / 100"纹丝不动，看着像撤销没生效）
      updateUndoButtons();
      ok = true;
    } catch (e) {
      // 走到这里说明"判据没拦住、后面才炸"。回滚到进函数那一刻的状态：
      S.design = prevDesign;
      S.selection = prevSelection;
      // ⚠️ **每一处还原都各自容错**（T5-R2）。验收明确要求
      //    "异常收尾本身不得再抛" —— 而"失败的原因"完全可能出在这些
      //    DOM 写操作自己身上（规划方注入的正是"写元数据表单时抛"）。
      //    第一版把还原写成裸赋值，于是回滚路径**又抛了一次**，
      //    异常从 `restore` 冒出去、连 `false` 都没返回。
      //    真实世界对应：某个 DOM 节点被宿主禁用/只读时，
      //    还原一个字段失败不该让**其余字段**和 design 都留着坏值。
      try { if (area && prevJsonText !== null) area.value = prevJsonText; } catch (e2) { }
      // 元数据表单逐字段还原（⚠️ 不依赖任何会抛的东西：`el()` 本身不抛）
      for (let i = 0; i < prevForm.length; i++) {
        try {
          const e2 = el(prevForm[i].id);
          if (e2 && prevForm[i].v !== null) e2.value = prevForm[i].v;
        } catch (e3) { }
      }
      restoreDirtyState(dirtyState);   // dirty 标志 + 提示条**整段**内容一起复原
      // ⚠️ 页签/树/属性可能在 `refreshAll()` 里**已经刷新过一半** ——
      //    现在让它们重新从**实际设计**（prevDesign）渲染一遍，界面与实际一致。
      try { if (window.renderPageTabs) window.renderPageTabs(); } catch (e2) { }
      try { if (window.renderPanels) window.renderPanels(); } catch (e2) { }
      try { if (window.renderTree) window.renderTree(); } catch (e2) { }
      try { if (window.renderProps) window.renderProps(); } catch (e2) { }
      // ⚠️⚠️ T5-R3：**画布也必须回到实际设计**（像素回滚，不再留给"下一次刷新"）。
      //
      // 规划方实测的反例：候选快照在**真实 `draw()` 内部**抛 —— 而 `draw` 是
      // **先画了候选**（空节点/目标页）**再抛**的。上面的还原把 `S.design` 放回去了，
      // 但画布上留下的是**候选那一帧**：`restore` 返回 false、实际设计是 CURRENT，
      // 画面却停在 TARGET，而且**自己不会好**（T5-R2 的注释把"整套失效重画"留给了
      // 下一次成功的 `refreshAll()`）。规划方用诊断脚本手动 `draw(CURRENT)` 才让
      // 像素和原来一致 —— 那正说明**产品没有完成像素回滚**。
      //
      // 现在按**已经回滚好的实际设计**（`S.design === prevDesign`）重画，并且
      // **有界、容错**：
      //   · **只重画 1 次**，不重试轰炸 —— 异常收尾的代价必须可预期；
      //   · 重画**再抛也吞掉**："异常收尾本身不得再抛"是硬要求（持续异常那一类）；
      //   · 失败**不谎报成功**：结果写进 `lastRestoreFinish`（只读钩子）并打印，
      //     "重画也失败了"与"画布已复原"是两件事。
      //
      // ⚠️ 这不是"诊断脚本手动重画冒充产品回滚"：重画就在**产品自己的收尾路径**里，
      //    用户在真实 `file:` 页面上按 Ctrl+Z 就会走到这一段（下面的套件也是走
      //    `restoreSnapshot` / `doUndo` 这些真实入口，不额外手动补画）。
      let 画布已重画 = false;
      let 画布错误 = null;
      try {
        if (typeof window.draw === "function") { window.draw(); 画布已重画 = true; }
        else 画布错误 = "没有可用的 window.draw";
      } catch (e2) {
        画布错误 = (e2 && e2.message) ? String(e2.message) : String(e2);
      }
      lastRestoreFinish = { canvas: 画布已重画, error: 画布错误 };
      if (!画布已重画) {
        console.warn("快照恢复失败后重画画布也失败了（画面可能未复原）：", 画布错误);
      }
      console.warn("快照恢复失败，已回滚到恢复前的状态：", e && e.message);
    } finally {
      suppressJsonSync = prevSuppress;   // ⚠️ 临时标志必须归位（异常路径也一样）
    }
    if (ok) cancelJsonTimer();
    return ok;
  }

  /**
   * 把 `prepareDesign()` 算好的文本写进 JSON 文本域 —— **只写文本，不重算**。
   *
   * 单独一个函数是为了让"算"和"写"分开：算的那一步在状态没动之前，
   * 失败就是干净失败；写 DOM 的那一步失败也已经可以整体回滚。
   */
  function syncPreparedJson(text) {
    const a = el("jsonArea");
    if (a) a.value = text;
    const d = S.design || {};
    setVal("mName", d.name);
    setVal("mAuthor", d.author);
    setVal("mDesc", d.description);
    setVal("mTheme", d.themeId);
    // ⚠️ `canvas` 可能没有（旧快照）—— 走与 `toV2Json` 同一组缺省值，
    // 不许在这里裸读 `d.canvas.designW`（那正是 T5-A 四例里"缺 canvas 抛错"的原因）。
    const cv = (d.canvas && typeof d.canvas === "object") ? d.canvas : {};
    setVal("dW", num(cv.designW, 2560));
    setVal("dH", num(cv.designH, 1600));
    setVal("scaleMode", String(num(cv.scaleMode, window.SCALE_STRETCH)));
    setVal("bgPath", d.background ? d.background.path : "");
    setVal("bgFit", String(d.background ? d.background.fit : 0));
    // 尺寸留空显示（0 = 自动）
    const bw = d.background && d.background.w ? d.background.w : "";
    const bh = d.background && d.background.h ? d.background.h : "";
    setVal("bgW", bw);
    setVal("bgH", bh);
  }

  /**
   * **所有改动都必须走这里** —— 它负责压栈、刷新界面、同步 JSON。
   *
   * @param fn           改动函数（直接改 S.design）
   * @param label        撤销菜单里显示的名字
   * @param coalesceKey  同一个 key 的连续改动会合并成一步（拖动/滑块用）
   */
  /**
   * 撤销栈持久化（v2.7.0）。
   *
   * 原来栈只在内存里 —— **刷新页面就全丢**，改了半天的设计一刷新没法回退。
   *
   * ## 为什么只存最近 N 步
   * 每步是一个设计快照（几十 KB），localStorage 通常只有 5 MB。
   * 存 20 步够用，再多就会**静默写失败**（QuotaExceededError），
   * 那比"只能退 20 步"糟糕得多。
   */
  const UNDO_KEY = "icar-studio-undo";
  /** 步数硬上限（再多也没人退那么远） */
  const UNDO_MAX = 40;
  /** 字节预算。localStorage 通常 5 MB，留足余量给别的键 */
  const UNDO_BUDGET = 1200 * 1024;

  /**
   * 存撤销栈。
   *
   * ## 为什么是"按字节"而不是"按步数"
   * 步数上限写死成 20 是拍脑袋的：一个只有 3 个控件的设计和 200 个控件的设计，
   * 单步快照能差两个数量级。所以**从最新往回留，直到超出字节预算为止**，
   * 步数上限只作为兜底（防止快照极小但步数极多）。
   *
   * 实测：20 步 × 200 控件的设计 ≈ 1.2 MB —— 正好卡在预算线上。
   */
  function saveUndoStack() {
    if (!undo) return;
    try {
      const name = S.design ? S.design.name : "";
      const out = [];
      let bytes = 0;
      // 从栈顶往回走，装得下就留
      for (let i = undo.index; i >= 0 && out.length < UNDO_MAX; i--) {
        const entry = undo.stack[i];
        const one = JSON.stringify(entry);
        // +2 是数组的逗号与括号
        if (bytes + one.length + 2 > UNDO_BUDGET && out.length > 0) break;
        out.unshift(entry);
        bytes += one.length + 2;
      }
      if (!out.length) return;
      const payload = { stack: out, index: out.length - 1, designName: name };
      localStorage.setItem(UNDO_KEY, JSON.stringify(payload));
    } catch (e) {
      // 配额满了不是致命错误 —— 只是这次没存上。**不要**弹窗打断用户。
      // 顺手清掉旧数据：留着只会让下一次也失败
      try { localStorage.removeItem(UNDO_KEY); } catch (e2) {}
      console.warn("撤销栈持久化失败（多半是 localStorage 配额），已清掉旧数据：", e.message);
    }
  }

  /** 启动时恢复撤销栈。**只在设计名一致时恢复** —— 否则会"撤销"到别的设计去 */
  function loadUndoStack() {
    try {
      const raw = localStorage.getItem(UNDO_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.stack) || !o.stack.length) return null;
      if (!S.design || o.designName !== S.design.name) return null;
      // ⚠️ **丢掉坏的条目**（v2.37.0；判据在 **T5-A 任务内**换成与 restore 一致的
      // `isUsableSnapshot`；该批改动**尚未发版**）。
      //
      // 只判断"是不是数组"不够 —— 里面的 `state` 可能是被截断的字符串。
      // 不在这里滤掉的话，坏的那条会一直躺在栈里，**每次撤销到它都要再撞一次**
      // （`restore` 会返回 false，用户看到"这一步的记录坏了"，但下次还是会撞）。
      //
      // 在**加载时**一次清干净，比每次运行时分摊处理更简单，也更诚实：
      // 那些条目本来就是坏的，留着没有任何价值。
      //
      // ⚠️ 判据（T5-A 起）**同时管住"合法 JSON 但结构坏了"**这一类：
      // 原来这里只 `JSON.parse` 一下就算过，那种记录加载时留着、
      // 撤销到时才失败 —— 与"加载和 restore 用一致的最低结构校验"相悖。
      // 用同一个函数也保证了两边**不会各自漂移**。
      const good = o.stack.filter(function (it) {
        return !!(it && isUsableSnapshot(it.state));
      });
      if (good.length !== o.stack.length) {
        console.warn("撤销栈里有 " + (o.stack.length - good.length) + " 条坏记录，已丢弃");
      }
      if (!good.length) return null;
      // ⚠️ 索引必须跟着过滤后的栈重算（T5-A）：旧代码把 `o.index` 原样带出去，
      // 而它指的是**过滤前**的位置。栈短了之后这个索引可能越界，
      // 也可能让"可撤销步数"与实际条数对不上。
      // 持久化时写的一直是 `index = 栈顶`（见 saveUndoStack），所以这里就是栈顶。
      o.stack = good;
      o.index = good.length - 1;
      return o;
    } catch (e) { return null; }
  }
  window.loadUndoStack = loadUndoStack;
  window.saveUndoStack = saveUndoStack;

  /**
   * 上一次**落盘**用的合并键。见 `commit` 里的说明。
   *
   * `null` = 下一步无论如何都要落盘。
   */
  let lastPersistKey = null;

  /** 强制落盘并允许下一步重新落盘（拖动/滚轮手势结束时调） */
  function flushUndoStack() {
    lastPersistKey = null;
    saveUndoStack();
  }
  window.flushUndoStack = flushUndoStack;

  window.commit = function (fn, label, coalesceKey) {
    fn();
    const key = batch ? batch.label : coalesceKey;
    undo.push(snapshot(), label, key);
    // ⚠️ **合并序列里只落盘第一步**（v2.83.0，Round 4）。
    //
    // 原来每次 commit 都调 `saveUndoStack()`。而它是**同步**的：
    // 实测（60 个控件、栈里 32 步）—— **13.2 ms / 次**，写 **1.18 MB** 到 localStorage。
    // 滚轮缩放、拖动滑块这类"一类连续操作"每帧都会 commit，
    // 于是每一次滚轮事件要花 13ms 干一件**中间态根本没价值**的事
    // （下一步会把栈顶覆盖掉，写下去的立刻作废）。
    //
    // 判据用 `coalesceKey`：键**变了**说明上一类操作已经结束，那时才落盘。
    // 手势收尾（`onDragEnd` / `endBatch`）会调 `flushUndoStack()` 补最后一次。
    // 所以"每一步逻辑操作都持久化"这条保证**没有被削弱** ——
    // 只是不再为同一步里的每一帧重复写盘。
    if (!key || key !== lastPersistKey) {
      lastPersistKey = key || null;
      saveUndoStack();
    }
    if (!batch) {
      syncJson();
      refreshAll();
      updateUndoButtons();
    } else {
      updateUndoButtons();
    }
  };

  /** 批量改动：一段操作只压一次栈（比如导入多个素材） */
  window.beginBatch = function (label) {
    if (batch) { batch.depth++; return; }
    batch = { label: label || "批量改动", depth: 1 };
    undo.push(snapshot(), batch.label);
  };
  window.endBatch = function () {
    if (!batch) return;
    batch.depth--;
    if (batch.depth <= 0) {
      batch = null;
      flushUndoStack();          // 批量的最终状态必须落盘
      syncJson();
      refreshAll();
      updateUndoButtons();
    }
  };

  function updateUndoButtons() {
    const u = el("btnUndo"), r = el("btnRedo");
    if (u) {
      u.disabled = !undo.canUndo();
      u.title = undo.canUndo() ? "撤销（Ctrl+Z）—— 可退 " + undo.depth() + " 步" : "没有可撤销的操作";
    }
    if (r) {
      r.disabled = !undo.canRedo();
      // ⚠️ 这个按钮的**文案是「返回」但功能是重做**（用户要求改的文案）。
      // 所以 tooltip 必须把功能说清楚，否则光看字面会以为是"上一步"。
      r.title = undo.canRedo()
        ? "重做（Ctrl+Y）—— 把刚撤销的操作再做一遍"
        : "没有可重做的操作";
    }
    const c = el("undoCount");
    if (c) c.textContent = undo.depth() + " / " + (undo.size() - 1);
  }

  // 测试钩子（v2.37.0）。和 `window.loadUndoStack` / `window.saveUndoStack`
  // 同一个理由：**"坏数据不能让撤销静默失灵"这件事必须能被测**，
  // 而 `restore` 在闭包里，从外面碰不到。
  window.restoreSnapshot = restore;

  // 测试钩子（T5-A；T5-R 沿用）。补三个口子，因为这一卡要验的是**判据与走法本身**：
  //  · `isUsableSnapshot` —— "解析成功≠快照可用"的判据必须能被逐条钉住
  //    （否则只能在 restore 的副作用里间接猜）；
  //  · `__undoStack` —— 撤销栈是闭包里的局部变量，没有它就**造不出"运行中
  //    栈里躺着坏记录"**这个场景，只能靠真实坏 localStorage 碰运气；
  //  · `__commitState` —— `commit` 把新快照压栈后，需要把它**原样换掉**才能
  //    模拟"这条记录写坏了"。直接改 `state` 会破坏"每条记录都是真实快照"的前提，
  //    换掉才能让其余记录保持真实。
  window.isUsableSnapshot = isUsableSnapshot;
  window.__undoStack = undo;
  window.__commitState = function () { return snapshot(); };
  // ⚠️ T5-R2 新增：`suppressJsonSync` 是闭包里的临时标志。验收要求
  //    "`suppressJsonSync` 归位"，而它是**状态**、不是界面观感 ——
  //    从外面只能靠"再敲一次 JSON 会不会被静默吞掉"间接猜。
  //    这里给一个只读的取样口子，让"归位"能被**直接**断言。
  window.__jsonSyncFlags = function () {
    return { suppress: suppressJsonSync, dirty: jsonDirty, dirtyErrors: jsonDirtyErrors };
  };
  // ⚠️ T5-R3 新增：失败收尾里"画布重画"的结果。它是**状态**（重画成功/重画也抛了），
  //    从外面只能靠像素间接猜"有没有重画过"（持续异常那一例里像素可能本来就是对的），
  //    所以给一个只读取样口子，让"有界重画 + 如实记录失败"能被**直接**断言。
  window.__lastRestoreFinish = function () { return lastRestoreFinish; };

  window.doUndo = function () {
    if (undo.canUndo() && !confirmJsonReplace("撤销")) return;
    // ⚠️ 把"这条快照能不能用"交给 `UndoStack`（T5-A）：
    // 它会在往回走的路上把坏记录**就地摘掉**，而不是只把索引挪一格。
    // 只挪索引的话，坏记录永远躺在栈里 —— 用户每次撤销/重做都要再撞它一次。
    //
    // ⚠️⚠️ **`.undo()` 与 `.redo()` 永远返回对象，不再返回 `null`**（T5-R2）。
    // 旧写法在"已经到栈底/栈顶"时返回 `null`，这里走 `afterFailedStep(null)`，
    // 而缺省 `usableLeft = 0` 被判成"**整个栈都坏了**" → `undo.reset(...)`：
    // 规划方实测一个**全好的栈**在栈底按 Ctrl+Z（或栈顶按 Ctrl+Y）
    // 就被清成 `[初始]`、`0 / 0`、toast 误报"记录都坏了"，反方向历史全丢。
    // 按钮变灰挡不住真实快捷键（`bindKeys`）。
    //
    // ⚠️ 还要先把**当前记录对象**抓下来（T5-R2）：`_step` 成功后 `undo.index`
    // 已经指向目标，`restore` 再失败时我们靠这个对象把游标放回**实际当前**那条
    // （否则摘掉 TARGET 之后 `index` 会留在 FUTURE 上 —— 规划方 redo 方向的反例）。
    //
    // ⚠️⚠️ T5-R3：还要把**实际当前设计的快照**一起交给 `UndoStack`。
    //    当前记录**自己坏了**（规划方 R1 的第一类反例）时，`_step` 会把那条
    //    坏记录摘掉 —— 摘完之后栈里就**没有任何一条记录代表画布上真正那份设计**。
    //    光靠"就近找一条可用记录"会让游标与实际当前相反（`canRedo=false`，
    //    反方向的 FUTURE 不可达）。锚点材料就是这里抓的 `snapshot()`：
    //    它是**画布此刻的真实设计**，与那条坏记录无关。
    const curRec = undo.stack[undo.index] || null;
    const curState = snapshot();
    const r = undo.undo(isUsableSnapshot, curState, "当前设计");
    // ⚠️⚠️ **失败不是 `null`，而是一个带 `ok:false` 的对象**（T5-R）。
    // 只判 `!r` 会把失败当成功：`r.state` 是 `undefined`，`restore(undefined)`
    // 返回 false，于是走 `afterRestoreFailed` —— 提示变成"这一步的记录无法恢复"
    // 而不是"整个栈都坏了"，索引/计数也不再归位（套件实测 `-1 / -1`）。
    if (!r || !r.ok) return afterFailedStep("撤销", r);
    // ⚠️ **不许假设 `restore` 必然成功**（T5-R）：判据过了也可能在后面抛
    // （规划方实测的四类快照）。失败就必须看得见，而且**不能**报"已撤销"。
    if (!restore(r.state)) return afterRestoreFailed("撤销", r, curRec);
    // 跳过几条坏记录要说出来 —— 用户会看到"按一下退了好几步"
    toast(r.removed > 0
      ? "已撤销：" + r.label + "（跳过 " + r.removed + " 条坏记录）"
      : "已撤销：" + r.label);
  };
  window.doRedo = function () {
    if (undo.canRedo() && !confirmJsonReplace("重做")) return;
    const curRec = undo.stack[undo.index] || null;   // 同上：失败时按它重定位
    const curState = snapshot();                     // 同上：补锚点用的"实际当前设计"
    const r = undo.redo(isUsableSnapshot, curState, "当前设计");
    if (!r || !r.ok) return afterFailedStep("重做", r);   // 同上：失败是对象，不是 null
    if (!restore(r.state)) return afterRestoreFailed("重做", r, curRec);
    toast(r.removed > 0
      ? "已重做：" + r.label + "（跳过 " + r.removed + " 条坏记录）"
      : "已重做：" + r.label);
  };

  /**
   * 撤销/重做**没走到任何可用记录**之后的收尾（T5-A；T5-R 区分两种情形；
   * T5-R2 把"正常端点"与"混合栈"彻底分开）。
   *
   * 三种情形，都要"看得见"，都不能"点了没反应"：
   *  1. **正常到栈底/栈顶** —— 一步都没走成、也**没摘任何记录**
   *     （`removed === 0` 且 `usableLeft > 0`）。按索引刷新按钮即可，
   *     不用提示（按钮本来就是灰的，再弹一句是噪音），**绝不重建基准**；
   *  2. **本方向没有可用的记录**（T5-R 新增，规划方 R2 的反例）——
   *     例如 `[坏, current, 好redo]` 撤销、`[好undo, current, 坏]` 重做。
   *     这一路**只摘了坏记录**（`removed > 0`），反方向的好记录与当前设计
   *     都原样保留；用户会看到"这个方向没有可用的记录了"，
   *     而不是被误报成"记录都坏了"；
   *  3. **整个栈都坏了** —— `usableLeft === 0`。此时 `_step` 已经清空栈
   *     （或栈本来就一条可用的都没有），用**当前设计**重新起一个基准：
   *     当前设计一个字节都没改，起基准只是让索引重新有落点
   *     （否则 `depth()` 会读到 -1，按钮文案会显示 "-1 / -1" 这种明显的坏值）。
   *
   * ⚠️ 情形 1 与 2 的**按钮/计数**可能都是 `0 / 0`，区分它们的可见信号是
   * **提示文案**（以及"反方向是否还能走"）与**是否摘了记录**。
   * 规划方明确要求"不能把混合栈称为全坏"，反过来也一样：
   * **正常的栈底/栈顶不许被当成全坏**。
   */
  function afterFailedStep(what, r) {
    const info = r || { removed: 0, sizeBefore: 0, usableLeft: 0 };
    const usableLeft = (typeof info.usableLeft === "number") ? info.usableLeft : 0;
    const removed = (typeof info.removed === "number") ? info.removed : 0;
    if (usableLeft > 0) {
      updateUndoButtons();
      // 情形 2：摘掉了坏记录 = "这个方向没有可用的记录了"（反方向的还在）
      if (removed > 0) {
        toast("已没有可以" + what + "的记录了（已清掉 " + removed + " 条坏记录，其他记录保留）");
      }
      // 情形 1：一条都没摘 = 正常走到端点，**无操作、不提示、不清栈**
      return;
    }
    // 情形 3：整个栈都坏了
    undo.reset(snapshot(), "初始");        // 当前设计原样成为新基准
    updateUndoButtons();
    toast(what + "栈里的记录都坏了，已清空（当前设计未改动）");
  }

  /**
   * `_step` 走到了可用记录、但 `restore` 仍然失败之后的收尾（T5-R）。
   *
   * 规划方要求："不能先推进索引再把坏设计/错误成功提示留给用户"。
   * 所以这里做两件事：
   *  1. **如实提示失败**（不报"已撤销"）；
   *  2. 那条记录已经被判据判为可用 —— 它没能恢复说明是**判据与恢复路径不一致**
   *     （判据漏了某个后面真的会读到的结构）。把它**当成坏记录就地摘掉**，
   *     这样用户不会反复撞同一条；同时按当前设计/栈状态刷新按钮与计数。
   *
   * ⚠️ 只摘**这一条**（`stack.indexOf` 认对象），好记录一条不动。
   * ⚠️ 顺序：**先把栈收拾干净（必要时 reset 起新基准），再刷按钮与计数** ——
   *    反过来的话 `undoCount` 会停在 `-1 / -1` 这种坏值上（`_step` 失败路径
   *    会把空栈的 `index` 置 -1）。
   *
   * ## ⚠️⚠️ 摘掉 TARGET 之后游标必须回到**实际当前记录**（T5-R2 修正）
   *
   * 旧写法只是"把数值下标夹回栈长以内"（`if (undo.index >= len) index = len-1`）。
   * 规划方实测反例：栈 `[CURRENT, TARGET, FUTURE]`、`index=1`，令 TARGET 在
   * 真实 `draw` 阶段失败 → 摘掉 TARGET 后栈变 `[CURRENT, FUTURE]`，
   * 而**夹取把 `index` 留在了 1 → 指向 FUTURE**；实际设计仍是 CURRENT，
   * 于是 `canRedo=false`、计数 `1 / 1` —— 与 R1 的第一个反例同一个病。
   * （undo 方向那一次"恰好"夹到 0，所以不能据此认为这条路是对的。）
   *
   * 现在：把**进 `restore` 之前的当前记录对象**（`curRec`）传进来，
   * 用与 `_step` **同一份实现**（`UndoStack._relocate`）重定位 ——
   * 当前记录还在就落在它上面；它自己被摘掉才按锚点就近取可用记录。
   *
   * ## ⚠️⚠️ T5-R3：当前记录**自己被摘掉**时，补的是"实际当前设计"的锚点
   *
   * T5-R2 这里同样是"就近取可用记录"。规划方实测的第四类反例：栈
   * `[坏BEFORE, 坏CURRENT, TARGET(判据可用), FUTURE]`、`index=1`、实际设计 CURRENT，
   * 重做 → `_step` 摘掉两条坏的、走到 TARGET；`restore(TARGET)` 失败 →
   * 摘掉 TARGET 之后只剩 `[FUTURE]`，就近兜底把 `index` 放在 0
   * （`canRedo=false`）—— **实际设计还是 CURRENT**，FUTURE 不可达。
   * 所以这里跟 `_step` 走**同一条路**：
   *  ① 当前记录还在栈里 → 就是它（对象身份）；
   *  ② 它是坏的、已被摘掉 → **用 `snapshot()` 给实际当前设计补一条有效锚点**，
   *     位置取 `_step` 算好的 `anchorAt`（目标被摘掉时跟着左移一格）；
   *  ③ 补不出来才退回 `_relocate` 的就近兜底；一条可用记录都没有才 `reset`。
   *
   * ⚠️ 界面一致性：这一步发生在 `restore` 已经回滚完模型之后，
   *    **不能再跑一遍完整刷新**（那会重画、还可能再抛）。这里只做
   *    `updateUndoButtons()` + 如实提示 —— 与规划方"按钮/计数/lastKey/提示一致，
   *    失败不报成功"的要求对应。
   */
  function afterRestoreFailed(what, r, curRec) {
    const at = undo.stack.indexOf(r && r.target);
    if (at >= 0) undo.stack.splice(at, 1);
    if (undo.stack.length === 0) {
      // 一条记录都不剩 → 用当前设计重建基准（当前设计一个字节都没动）
      undo.reset(snapshot(), "初始");
    } else {
      let idx = curRec ? undo.stack.indexOf(curRec) : -1;     // ① 当前记录还在 → 就是它
      if (idx < 0 && r && r.curRemoved && typeof r.anchorAt === "number" &&
          undo._countUsable(isUsableSnapshot) > 0) {
        // ② 当前记录**自己被摘掉了**（它本来就是坏的）→ 为实际当前设计补锚点。
        //    ⚠️ 与 `_step` 同一条判据：**别的方向一条可用记录都不剩**时不是"混合栈"，
        //       不补锚点，让下面 `_relocate` 返回 -1 走"整栈真坏 → 重建基准"。
        let anchorAt = r.anchorAt;
        if (at >= 0 && at < anchorAt) anchorAt--;             // 目标被摘掉，锚点跟着左移
        const rec = undo.anchorCurrent(anchorAt, snapshot(), "当前设计", isUsableSnapshot);
        if (rec) idx = undo.stack.indexOf(rec);
      }
      if (idx < 0) {
        // ③ 兜底：按**保存的当前记录对象**重定位（`curAt` 用摘除后仍能定位锚点：
        //    当前条自己被摘掉时 `min(cur, 栈长)` 就是它原来的位置附近）
        idx = undo._relocate(curRec, at >= 0 ? at : undo.stack.length, isUsableSnapshot);
      }
      if (idx < 0) undo.reset(snapshot(), "初始");
      else undo.index = idx;
    }
    undo.lastKey = null;
    updateUndoButtons();
    toast("这一步的记录无法恢复，已摘掉（当前设计未改动）");
  }

  // ================================================================ 多页面（页签）

  /**
   * 渲染页签条。
   *
   * **只有一页时也显示** —— 否则用户根本发现不了"能加页"。
   * 但单页时不显示删除按钮（删不了）。
   */
  function renderPageTabs() {
    const box = el("pageTabs");
    if (!box || !S.design) return;
    const pages = S.design.pages || [];
    const cur = S.design.pageIndex || 0;
    let h = "";
    pages.forEach((pg, i) => {
      h += '<span class="pgTab' + (i === cur ? " pgCur" : "") + '"' +
        ' onclick="switchToPage(' + i + ')"' +
        ' ondblclick="renamePage(' + i + ')"' +
        ' title="' + window.esc(pg.name) + '（双击重命名）">' +
        window.esc(pg.name) +
        (pages.length > 1
          ? '<span class="pgDel" onclick="event.stopPropagation();delPage(' + i + ')" title="删除这一页">✕</span>'
          : "") +
        '</span>';
    });
    h += '<span class="pgAdd" onclick="addNewPage()" title="新建一页">＋</span>';
    h += '<span class="pgHint">' + pages.length + ' 页 · 每页有各自的一组控件</span>';
    box.innerHTML = h;
  }
  window.renderPageTabs = renderPageTabs;

  /**
   * 切到第 i 页。
   *
   * **必须先压一次撤销栈**：`design.nodes` 会换成另一页的数组，
   * 如果不记这一步，用户切页后按撤销会"撤销到上一页的改动"，
   * 而画布看起来没变 —— 非常困惑。
   */
  window.switchToPage = function (i) {
    if (!S.design) return;
    const from = S.design.pageIndex || 0;
    if (i === from) return;
    // 清掉选择：选中的节点 id 属于旧页，带到新页会指向不存在的东西
    S.selection = [];
    S.drillPath = [];
    window.commit(() => {
      window.switchPage(S.design, i);
    }, "切到「" + (S.design.pages[i] || {}).name + "」");
    if (window.updateBreadcrumb) window.updateBreadcrumb();
    window.toast("已切到「" + (S.design.pages[i] || {}).name + "」");
  };

  window.addNewPage = function () {
    if (!S.design) return;
    const name = prompt("新页面的名字", "页面 " + ((S.design.pages || []).length + 1));
    if (name === null) return;
    let idx = -1;
    // ⚠️ 「新建页面」是**一个**用户动作，但底下有两次 commit（加页 + 切页）。
    //
    // 不合成一步的后果（v2.83.0 实测）：按一次撤销，**新页面还在** ——
    // 只是把当前页切回了原来那页。用户看到的是"撤销没反应"，得按两次才退干净。
    //
    // `beginBatch` 给这一段一个统一的 coalesceKey，`UndoStack.push` 遇到
    // 相同的 key 会**替换栈顶**而不是再压一条 → 两次 commit 合成一步。
    window.beginBatch("新建页面：" + name);
    try {
      window.commit(() => {
        idx = window.addPage(S.design, (name || "").trim() || undefined);
      }, "新建页面：" + name);
      if (idx >= 0) window.switchToPage(idx);
    } finally {
      window.endBatch();
    }
    window.toast("已新建「" + (S.design.pages[idx] || {}).name + "」");
  };

  window.delPage = function (i) {
    if (!S.design) return;
    const pages = S.design.pages || [];
    if (pages.length <= 1) { window.toast("只剩一页了，删不了"); return; }
    const pg = pages[i];
    const n = window.flatten(pg.nodes).length;
    if (!confirm("删除页面「" + pg.name + "」？\n这一页上有 " + n + " 个控件，会一起删掉。\n（可以用撤销找回来）")) return;
    window.commit(() => {
      window.removePage(S.design, i);
    }, "删除页面：" + pg.name);
    S.selection = [];
    S.drillPath = [];
    window.toast("已删除「" + pg.name + "」");
  };

  window.renamePage = function (i) {
    if (!S.design) return;
    const pg = (S.design.pages || [])[i];
    if (!pg) return;
    const name = prompt("页面名字", pg.name);
    if (name === null) return;
    window.commit(() => { pg.name = (name || "").trim() || pg.name; }, "重命名页面");
  };

  function refreshAll() {
    // 画布绘制前同步素材位图 —— 内置素材只有 path，不挂上去画布会画大 X
    if (window.syncAssetImages) window.syncAssetImages();
    renderPageTabs();
    // ⚠️ `S.suppressPanelRender` 是**滚轮缩放**期间的开关（v2.83.0，Round 4）：
    // 滚轮一次事件只有 w/h 变，而 `renderPanels()` 要重建整个素材库 + 控件树 +
    // 控制库（实测 60 个控件时 8.8ms，占一次滚轮事件 17.8ms 的一半）。
    // 缩放期间跳过，收尾时 canvas.js 的 wheelEndTimer 会补一次完整刷新。
    if (!S.suppressPanelRender && window.renderPanels) window.renderPanels();
    if (window.draw) window.draw();
    // 装饰动画预览（T-UI-HUD-01）：设计一变就重新判断要不要跑时钟。
    // 放在最后 —— 它内部会再 draw 一次，前面那次负责静态内容立刻可见。
    if (window.__ensureAnimPreview) window.__ensureAnimPreview();
  }
  window.refreshAll = refreshAll;
  // 供 refreshAll 内部调用（定义在后面，用 window 挂接避免前后顺序耦合）
  window.__ensureAnimPreview = ensureAnimPreview;

  window.onSelectionChanged = function () {
  // 换了选中对象 → 部件选择失效（v2.32.0）
  S.selectedPart = -1;
    if (window.renderTree) window.renderTree();
    if (window.renderProps) window.renderProps();
    if (window.draw) window.draw();
  };
  window.onNodeChanged = function () { };
  window.onDragEnd = function () {
    // 拖动结束：结束合并，并把最终状态压成一步
    undo.endCoalesce();
    // ⚠️ 合并序列里只在第一步落过盘，中间态是被覆盖掉的 ——
    // 手势结束时必须把**最终**状态补写一次（v2.83.0，Round 4）
    flushUndoStack();
    syncJson();
    if (window.renderProps) window.renderProps();
    updateUndoButtons();
  };

  // ================================================================ 属性写入

  function sel() {
    if (S.selection.length !== 1) return null;
    return window.findNode(S.design.nodes, S.selection[0]);
  }

  /**
   * **等比缩放锁**开关（v2.21.0）。默认开。
   *
   * 关掉之后拖角手柄可以自由拉伸 —— 图片会变形，所以默认不开。
   * 想临时自由拉伸不用关它，**按住 Alt** 就行。
   */
  /**
   * **主题配色编辑器**（v2.31.0）。
   *
   * 只改**颜色**（12 个字段）—— 圆角、缓动、发光开关那些影响的是"手感"，
   * 混在一起做一个界面会让它变成一锅粥。
   *
   * 改动存进 `design.themeColorsOverride`（只存**差异**）：
   *   · 换主题时，只调过的那几个字段保留，其余跟着新主题走
   *   · 序列化时"内置主题打底 + 覆盖"，所以设计文件里始终是**完整**配色
   */
  // ================================================================ 界面设置（v2.54.0）

  const SET_KEY = "icar-studio-ui";

  /** 界面设置的默认值。**只放"工具本身"的偏好，不放设计数据。** */
  const SET_DEFAULTS = {
    zoom: 1,
    /**
     * 指针弹簧参数（v2.81.0）。默认取 `SPRING_DEFAULTS`（k=150 / c=19）——
     * 阻尼比 ζ≈0.78 轻微欠阻尼，到位时过冲约 2% 再回正，这是"像真针"的来源。
     *
     * ⚠️ 放在**界面设置**而不是设计文件里：它是**预览的手感**，
     * 与"主题长什么样"无关。写进设计文件会让同一份设计在不同人的机器上手感不同。
     */
    springK: window.SPRING_DEFAULTS.k,
    springC: window.SPRING_DEFAULTS.c,
  };

  /**
   * 界面缩放的预设。
   *
   * 为什么只有三档而不是一根滑杆：**离散值更容易回到"标准"**。
   * 滑杆一旦拖过，用户很难凭感觉拖回 100%。
   */
  const ZOOM_PRESETS = [
    { v: 0.85, n: "紧凑", note: "屏幕小、想多放点东西" },
    { v: 1.00, n: "标准", note: "默认" },
    { v: 1.15, n: "宽松", note: "屏幕大、离得远" },
  ];

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SET_KEY);
      if (!raw) return Object.assign({}, SET_DEFAULTS);
      const o = JSON.parse(raw);
      const z = Number(o && o.zoom);
      const k = Number(o && o.springK);
      const c = Number(o && o.springC);
      return {
        zoom: (z >= 0.5 && z <= 2) ? z : SET_DEFAULTS.zoom,
        // k / c 的合法区间：k 太小指针软得看不出在动，太大就退化成"硬跳"（等于没弹簧）；
        // c 太大变成过阻尼 —— "黏糊糊地滑过去"，一眼假
        springK: (k >= 10 && k <= 2000) ? k : SET_DEFAULTS.springK,
        springC: (c >= 0 && c <= 200) ? c : SET_DEFAULTS.springC,
      };
    } catch (e) { return Object.assign({}, SET_DEFAULTS); }
  }

  function saveSettings(s) {
    try { localStorage.setItem(SET_KEY, JSON.stringify(s)); } catch (e) {}
  }

  /** 把缩放**应用到 DOM**。只改一个 CSS 变量，别的地方都不用动。 */
  function applySettings(s) {
    document.documentElement.style.setProperty("--ui-zoom", String(s.zoom));
    const b = document.body;
    if (b) b.style.zoom = String(s.zoom);
    // 缩放后画布容器尺寸变了，要重算 —— 否则画布还是原来的大小
    if (window.applyCanvasSize) setTimeout(window.applyCanvasSize, 0);
  }

  window.SETTINGS = loadSettings();
  applySettings(window.SETTINGS);
  applySpringParams();

  /**
   * 把界面设置里的弹簧参数灌进弹簧池。
   *
   * ⚠️ 弹簧池在 `canvas.js` 里就建好了（渲染层要读它），所以这里只是**改参数**。
   * 改完立刻对新旧弹簧都生效（`SpringBank.params` 会遍历已有的那些）。
   */
  function applySpringParams() {
    const b = window.CanvasState && window.CanvasState.simSprings;
    if (b && b.params) b.params(window.SETTINGS.springK, window.SETTINGS.springC);
  }

  /**
   * 改弹簧参数（设置面板用）。`k` / `c` 任一为空就只改另一个。
   *
   * 参数**非法时不改**（不夹取）：输入框里打了一半的 "1" 不该被悄悄改成 10，
   * 那会让人以为"我输入的数字被吞了"。
   */
  window.setSpringParams = function (k, c) {
    const kk = (k === undefined || k === null || k === "") ? null : Number(k);
    const cc = (c === undefined || c === null || c === "") ? null : Number(c);
    if (kk !== null && Number.isFinite(kk) && kk >= 10 && kk <= 2000) window.SETTINGS.springK = kk;
    if (cc !== null && Number.isFinite(cc) && cc >= 0 && cc <= 200) window.SETTINGS.springC = cc;
    saveSettings(window.SETTINGS);
    applySpringParams();
    // ⚠️ **不要在这里调 `openSettings()`**：它重写整个 `settingsBox` 的 innerHTML，
    //    而用户正在这个框里打字 —— 输入元素被销毁重建，**每敲一个数字就丢焦点**
    //    （实测：敲第二下就没反应了）。只更新那一行体检文案。
    const hint = document.getElementById("springHintBox");
    if (hint) hint.innerHTML = springHintText();
  };

  /** 弹簧体检文案（对话框里那一行 + 调参时实时更新） */
  function springHintText() {
    const chk = window.springCheck(window.SETTINGS.springK, window.SETTINGS.springC, 1 / 60);
    return 'k·dt² = <b>' + chk.hooke.toFixed(3) + '</b>（&lt; 4 稳定）· ' +
      'c·dt = <b>' + chk.damp.toFixed(3) + '</b>（&lt; 2 稳定）· ' +
      '阻尼比 ζ = <b>' + chk.zeta.toFixed(3) + '</b> → ' +
      (chk.zeta < 0.9 ? '欠阻尼（会过冲，像真针）'
        : (chk.zeta <= 1.1 ? '接近临界（过冲很小）' : '过阻尼（黏，不像真针）'));
  }

  window.setUiZoom = function (v) {
    const z = Number(v);
    if (!(z >= 0.5 && z <= 2)) return;
    window.SETTINGS.zoom = z;
    saveSettings(window.SETTINGS);
    applySettings(window.SETTINGS);
    window.openSettings();   // 重画对话框，让选中态跟上
  };

  window.resetSettings = function () {
    window.SETTINGS = Object.assign({}, SET_DEFAULTS);
    try { localStorage.removeItem(SET_KEY); } catch (e) {}
    applySettings(window.SETTINGS);
    applySpringParams();          // 弹簧参数也要跟着回默认（k=150 / c=19）
    window.openSettings();
    if (window.toast) window.toast("界面设置已恢复默认");
  };

  window.openSettings = function () {
    const box = document.getElementById("settingsBox");
    if (!box) return;
    const cur = window.SETTINGS.zoom;
    const btn = ZOOM_PRESETS.map(p => {
      const on = Math.abs(p.v - cur) < 0.001;
      return '<button class="' + (on ? "primary" : "") + '" title="' + window.esc(p.note) + '"' +
        ' onclick="setUiZoom(' + p.v + ')">' + window.esc(p.n) + (on ? " ✓" : "") + '</button>';
    }).join("");
    // 弹簧体检：把当前 k / c 的稳定性与阻尼比**明说**出来 ——
    // 用户调参时最需要知道的就是"这组参数会不会发散 / 是不是过阻尼"
    const springHint = springHintText();
    box.innerHTML =
      '<div class="setRow"><label>界面缩放</label><div class="setPresets">' + btn + '</div></div>' +
      '<div class="setHint">' +
      '当前 <b>' + Math.round(cur * 100) + '%</b>。' +
      '这是<b>工具本身</b>的偏好（本机生效），<b>不会写进设计文件</b> —— ' +
      '否则同一份设计在不同人的机器上会长得不一样。' +
      '</div>' +
      '<div class="setRow"><label>指针弹簧 k</label>' +
      '<input type="number" step="10" min="10" max="2000" value="' + window.SETTINGS.springK + '"' +
      ' oninput="setSpringParams(this.value,null)" title="劲度系数：越大越硬、到位越快">' +
      '<label style="flex:0 0 66px">阻尼 c</label>' +
      '<input type="number" step="1" min="0" max="200" value="' + window.SETTINGS.springC + '"' +
      ' oninput="setSpringParams(null,this.value)" title="阻尼系数：越小越晃">' +
      '</div>' +
      '<div class="setHint" id="springHintBox">' + springHint + '</div>' +
      '<div class="setHint">' +
      '指针在<b>实时模拟</b>下走真弹簧（不是"值 → 角度"直接映射）—— ' +
      '实时数据每 16ms 变一次，补间永远追不上，弹簧是<b>状态</b>不是动画。' +
      '</div>' +
      '<div class="setRow"><label>自检扫表</label><div class="setPresets">' +
      '<button onclick="playBootSweep()" title="所有指针 0 → 满 → 回位。它同时验证了让位仲裁：扫表期间实时数据不写指针角度">▶ 试一次（1.6 秒）</button>' +
      '</div></div>' +
      '<div class="setFoot"><button onclick="resetSettings()">恢复默认</button></div>';
    const dlg = document.getElementById("settingsDlg");
    if (dlg && !dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); }
  };

  window.openThemeColors = function () {
    const d = S.design;
    const base = window.GAUGE_THEMES[d.themeId] || window.GAUGE_THEMES.neon;
    const ov = d.themeColorsOverride || {};
    const rows = window.THEME_COLOR_FIELDS.map(function (f) {
      const val = ov[f.k] !== undefined ? ov[f.k] : base[f.k];
      const overridden = ov[f.k] !== undefined;
      return '<div class="tcRow">' +
        '<label>' + esc(f.n) + '</label>' +
        // ⚠️ 用 type=color 而不是文本框：用户不该被要求手打 #RRGGBB，
        // 而且色轮能直接看出"这个色偏暗还是偏亮"
        '<input type="color" value="' + esc(String(val).slice(0, 7)) + '"' +
        ' oninput="setThemeColor(\'' + f.k + '\',this.value)">' +
        '<span class="tcVal">' + esc(String(val)) + '</span>' +
        (overridden ? '<button class="mini" onclick="setThemeColor(\'' + f.k + '\',null)" title="恢复主题默认">↺</button>' : "") +
        "</div>";
    }).join("");
    const box = el("themeColorsBox");
    if (!box) return;
    box.innerHTML = '<div class="tcHead">当前主题：' + esc(base.title || d.themeId || "（未指定）") +
      '　<span class="hint inline">只改颜色；改动只存差异，换主题时没改过的会跟着新主题走</span></div>' +
      '<div class="tcGrid">' + rows + '</div>' +
      '<div class="tcFoot">' +
      '<button class="mini" onclick="resetThemeColors()">全部恢复主题默认</button>' +
      '</div>';
    const dlg = el("themeColorsDlg");
    if (dlg && dlg.showModal) dlg.showModal(); else if (dlg) dlg.setAttribute("open", "");
  };

  /** 改一个颜色（v = null 表示恢复主题默认） */
  window.setThemeColor = function (k, v) {
    const d = S.design;
    window.commit(function () {
      const ov = Object.assign({}, d.themeColorsOverride || {});
      if (v === null || v === undefined) delete ov[k];
      else ov[k] = String(v);
      d.themeColorsOverride = Object.keys(ov).length ? ov : null;
    }, "改主题色", "themeColor");   // 第三参是合并键：拖色轮会产生几十次，合成一步
    window.draw();
  };

  window.resetThemeColors = function () {
    window.commit(function () { S.design.themeColorsOverride = null; }, "恢复主题配色");
    window.openThemeColors();
    window.draw();
  };

  window.setAspectLock = function (on) {
    S.aspectLock = !!on;
    // 立刻落盘 —— 等下一个操作再存的话，用户关掉就关页面会丢（v2.26.0）
    if (window.savePanelState) window.savePanelState();
    window.renderProps();
    toast(on ? "等比缩放：开（按住 Alt 可临时自由拉伸）" : "等比缩放：关（可自由拉伸）");
  };

  /**
   * 把选中节点**恢复成素材的原始宽高比**。
   *
   * 保持**宽度不变**（按当前 w 推出 h）—— 直接改成素材尺寸的话，
   * 用户精心调好的大小会被重置，那是另一种"我明明没让它变"的意外。
   */
  window.fitNodeAspect = function () {
    const n = sel();
    if (!n || n.type !== window.NODE_IMAGE || !n.assetId) return;
    const a = (S.design.assets || []).find(x => x.id === n.assetId);
    const nat = a ? window.naturalSizeOf(a, n.assetId) : null;
    if (!nat) { toast("这个素材没有记录原始尺寸"); return; }
    const ar = window.imageNodeAspect(nat);
    window.commit(() => {
      n.h = Math.max(1, Math.round(n.w / ar * 100) / 100);
    }, "恢复素材比例");
    toast("已恢复素材比例（" + Math.round(n.w) + "×" + Math.round(n.h) + "）");
  };

  window.setNodeNum = function (k, v) {
    const n = sel(); if (!n) return;
    const num = Number(v);
    window.commit(() => {
      n[k] = Number.isFinite(num) ? num : 0;
      if (k === "w" || k === "h") n[k] = Math.max(1, n[k]);
      if (k === "scale") n[k] = Math.max(0.05, n[k]);
      if (k === "alpha") n[k] = Math.max(0, Math.min(255, Math.round(n[k])));
    }, "改 " + k, "num:" + k);
  };

  // ================================================================ 拖动滑块：实时预览（v2.91.0）
  //
  // ## 修的是什么（实测复现）
  //
  // 用户报「**属性的透明度不能实时拖动、只能点击操作**」。根因是这一条链：
  //
  //   <input type=range oninput=setNodeNum('alpha',v)>
  //     → commit() → refreshAll()
  //       → renderPanels()  … 重建素材库 / 控件树 / 控件库
  //       → draw()
  //   … 而 **`renderProps()` 也在别处被调**，它做的是 `box.innerHTML = out.join("")`
  //   —— 把 `#props` 的**整个 DOM 换掉**，正在被拖的那个 `<input type=range>`
  //   连**同一个节点都不是了**。浏览器于是立刻结束指针捕获，
  //   拖动在**第一个 input 事件之后**就断了：表现就是"只能点一下、拖不动"。
  //
  // 数字框（`type=number`）没有这个问题，因为它不靠指针捕获 —— 这就是
  // "能点击不能拖动"这个现象的由来。
  //
  // ## 修法：拖动期间**不重建任何面板**
  //
  // 与滚轮缩放**同一套思路**（见 canvas.js 的 `S.suppressPanelRender` 注释：
  // 一次滚轮事件 17.8ms，其中 `renderPanels` 占 8.78ms，而它一个字都不会变）：
  // 手势期间只改数据 + 重画画布，收手时补一次完整刷新。
  //
  // ⚠️ **不能只靠 `suppressPanelRender`**：那只挡住 `refreshAll()` 里的
  // `renderPanels()`，`renderProps()` 仍会被调（`onDragEnd` / 别处），
  // 而它才是真正替换掉滑块 DOM 的那一步。所以这里显式跳过
  // `refreshAll` 里的 `draw()` 之外的**全部**刷新，只留 `draw()`。
  //
  // 撤销仍然是**一步**：`commit(..., "num:alpha")` 的合并键没变，
  // 手势期间的几十次 input 只会替换栈顶（见 model.js `UndoStack.push`）。

  /** 手势进行中？供测试断言（`window.__liveEdit`） */
  let liveEdit = false;
  window.__liveEdit = function () { return liveEdit; };

  /** 开始一次"拖动即预览"的手势。重复调用无害（第一次生效） */
  window.beginLiveEdit = function () {
    if (liveEdit) return;
    liveEdit = true;
    S.suppressPanelRender = true;
  };

  /**
   * 收手：恢复面板重建 + 补一次完整刷新 + 把最终状态落盘。
   *
   * 必须幂等 —— `change` 事件在"点一下"时也会触发（那次没有 `input`），
   * 没开过手势就直接返回，不做多余的重建。
   */
  window.endLiveEdit = function () {
    if (!liveEdit) return;
    liveEdit = false;
    S.suppressPanelRender = false;
    if (window.onDragEnd) window.onDragEnd();   // 结束合并 + flushUndoStack + renderProps
    if (window.refreshAll) window.refreshAll(); // 补齐手势期间跳过的那次完整刷新
  };

  /**
   * 通用：手势期间改一个数字字段。
   *
   * `apply()` 负责写值（含夹取）。`label` / `key` 用来生成撤销步骤
   * （`key` 是合并键 —— 手势期间的几十次 input 只会替换栈顶）。
   * 收手由 `endLiveEdit()`（绑在 `onchange` 上）负责。
   *
   * ⚠️ **顺序是这条修复的关键**（v2.91.0 实测踩到过一次）：
   * `beginLiveEdit()` 必须在 `commit()` **之前**。第一版写在之后，于是
   * **第一次 input 仍然会重建面板**（`commit` → `refreshAll` → `renderPanels`
   * → `renderProps` → `innerHTML`），滑块在拖动的**第一帧**就被换掉了 ——
   * 症状与修之前一模一样，而"后续帧都不重建"是白搭。
   *
   * 反过来（先置标志再改数据）没有副作用：`commit` 的快照是在 `apply()`
   * **之后**拍的，所以撤销栈里存的仍然是"改完之后"的状态。
   */
  function liveNum(label, key, apply) {
    window.beginLiveEdit();
    window.commit(function () { apply(); }, label, key);
  }

  /** 属性面板的 `x/y/w/h/rotation/scale/alpha` —— 滑块与数字框共用 */
  window.setNodeNumLive = function (k, v) {
    const n = sel(); if (!n) return;
    const num = Number(v);
    liveNum("改 " + k, "num:" + k, function () {
      n[k] = Number.isFinite(num) ? num : 0;
      if (k === "w" || k === "h") n[k] = Math.max(1, n[k]);
      if (k === "scale") n[k] = Math.max(0.05, n[k]);
      if (k === "alpha") n[k] = Math.max(0, Math.min(255, Math.round(n[k])));
    });
  };
  window.setNodeStr = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n[k] = String(v); }, "改 " + k, "str:" + k);
  };

  /**
   * 改字体字段。**文字控件改 `n.font`，仪表改 `n.labelFont`** ——
   * 同一个 UI，两个目标，靠节点类型决定改哪个。
   *
   * 为什么不让调用方传目标：属性面板与控件编辑器都只有"字体"这一组，
   * 让它们各自判断类型会重复；集中在这里只判断一次。
   */
  // ================================================================ 子部件

  /** 当前选中的仪表节点（部件只对仪表有意义） */
  function gaugeSel() {
    const n = sel();
    if (!n || n.type !== window.NODE_GAUGE) { window.toast("子部件只能加在仪表上"); return null; }
    return n;
  }
  function ensureParts(n) { if (!n.parts) n.parts = []; return n.parts; }

  window.togglePart = function (i) {
    collapsed["part:" + i] = !collapsed["part:" + i];
    saveCollapsed();
    window.renderPanels();
  };

  /**
   * 加一个部件。
   *
   * 默认尺寸取控件自身的 80% —— 直接给 120 的话，小表上会盖住整个表。
   */
  window.addPart = function () {
    const n = gaugeSel(); if (!n) return;
    window.commit(() => {
      ensureParts(n).push(window.normalizePart({
        kind: "dial",
        w: Math.round(n.w * 0.8), h: Math.round(n.h * 0.8),
        x: Math.round(n.w * 0.1), y: Math.round(n.h * 0.1),
      }));
    }, "加子部件");
    window.toast("已加部件 —— 记得选素材，否则这一层画不出来");
  };

  window.delPart = function (i) {
    const n = gaugeSel(); if (!n || !n.parts) return;
    window.commit(() => { n.parts.splice(i, 1); if (!n.parts.length) n.parts = null; }, "删子部件");
  };

  /**
   * 上移 / 下移一个部件。
   *
   * **数组顺序 = 绘制顺序**（先画的在下），所以"上移"= 画得更早 = 更靠下层。
   * 这一点和控件树的直觉相反，title 里写清楚了。
   */
  window.movePart = function (i, dir) {
    const n = gaugeSel(); if (!n || !n.parts) return;
    const j = i + dir;
    if (j < 0 || j >= n.parts.length) return;
    window.commit(() => {
      const a = n.parts[i];
      n.parts[i] = n.parts[j];
      n.parts[j] = a;
    }, dir < 0 ? "部件上移" : "部件下移");
  };

  window.setPart = function (i, k, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    window.commit(() => {
      const patch = {}; patch[k] = v;
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], patch));
    }, "改部件 " + k);
  };

  /**
   * 给指针部件绑一个 PID（多指针表）。
   *
   * 空串 = **跟随仪表节点自己的 PID**（单指针表的老行为，完全不变）。
   */
  /**
   * 给部件设一个**布尔**字段（v2.27.0，目前用于 `sweepFollow`）。
   *
   * ⚠️ 部件下标由面板在渲染时写进 `window.__partEditIndex` ——
   * `setPartPid` 是内联在 onclick 里带下标的，而这个勾选框走的是 onchange，
   * 下标没地方传。用一个"当前编辑目标"变量最省事，也确实够用（一次只编辑一个部件）。
   */
  window.setPartBool = function (k, v) {
    const n = gaugeSel();
    const i = window.__partEditIndex;
    if (!n || !n.parts || i === null || i === undefined || !n.parts[i]) return;
    const patch = {};
    patch[k] = !!v;
    window.commit(() => {
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], patch));
    }, "部件 " + k);
  };

  window.setPartPid = function (i, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    const raw = String(v || "").trim();
    window.commit(() => {
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], {
        rawPid: raw,
        pid: raw ? window.resolvePid(raw) : "",
      }));
    }, "部件绑定 PID");
  };

  window.setPartNum = function (i, k, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    const s = String(v).trim();
    const x = s === "" ? 0 : Number(s);
    if (!Number.isFinite(x)) return;
    window.commit(() => {
      const patch = {}; patch[k] = x;
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], patch));
    }, "改部件 " + k);
  };

  /** 一键把扫描范围设成经典表盘的 135° → 405°（即 -225° → 45°，扫过 270°） */
  window.setPartSweep = function (i, from, to) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    window.commit(() => {
      n.parts[i] = window.normalizePart(Object.assign({}, n.parts[i], { sweepFrom: from, sweepTo: to }));
    }, "部件扫描范围");
  };

  /**
   * **开关子部件的持续装饰动画**（T-UI-HUD-01）。
   *
   * 关掉时写 `null`（不是删字段）—— 与 App 侧 `PartAnim?` 的语义一致，
   * 也让序列化结果稳定（不会因为"有没有这个键"产生 diff 噪音）。
   */
  window.setPartAnim = function (i, on) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    window.commit(() => {
      const base = n.parts[i];
      base.anim = on ? window.normalizePartAnim(base.anim || window.PART_ANIM_DEFAULT) : null;
      n.parts[i] = window.normalizePart(base);
    }, on ? "启用装饰动画" : "关闭装饰动画");
  };

  /**
   * 改装饰动画的一个字段。**归一化统一走 `normalizePartAnim`** ——
   * 周期下限、未知 kind 回落都在那里，工具与 App 两侧同一套判定。
   */
  window.setPartAnimField = function (i, k, v) {
    const n = gaugeSel(); if (!n || !n.parts || !n.parts[i]) return;
    const cur = n.parts[i].anim;
    if (!cur) return;
    const patch = {};
    if (k === "kind") {
      patch[k] = String(v || "");
    } else {
      const s = String(v).trim();
      const x = s === "" ? NaN : Number(s);
      if (!Number.isFinite(x)) return;
      patch[k] = x;
    }
    window.commit(() => {
      n.parts[i] = window.normalizePart(
        Object.assign({}, n.parts[i], { anim: window.normalizePartAnim(Object.assign({}, cur, patch)) })
      );
    }, "改动画 " + k);
  };

  window.clearParts = function () {
    const n = gaugeSel(); if (!n || !n.parts) return;
    if (!confirm("清空全部子部件？\n清空后会回到用「样式」程序化绘制。")) return;
    window.commit(() => { n.parts = null; }, "清空子部件");
    window.toast("已清空 —— 回到样式画法");
  };

  /**
   * 状态阈值。**空串 = 清掉覆盖，回到"按 PID 库推断"** ——
   * 用一个空值表达"跟随默认"比让用户填一个魔法数字清楚得多。
   */
  window.setStateThreshold = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    window.commit(() => {
      if (s === "") { n[k] = null; return; }
      const x = Number(s);
      n[k] = Number.isFinite(x) ? x : null;
    }, "状态" + (k === "stateWarn" ? "警告" : "严重") + "阈值");
  };

  window.setNodeFont = function (k, v) {
    const n = sel(); if (!n) return;
    const key = n.type === window.NODE_TEXT ? "font" : "labelFont";
    const patch = {};
    patch[k] = v;
    window.commit(() => {
      n[key] = window.normalizeFont(Object.assign({}, n[key], patch));
    }, "改字体 " + k, "font:" + k);
  };

  /**
   * 底框覆盖的写入。
   *
   * `card` 只在**真的覆盖了**才有值 —— 全空就置 null，
   * 这样序列化时不会写出一个没意义的 `{}`。
   */
  function ensureCard(n) {
    if (!n.card) n.card = { show: true, alpha: null, radius: null };
    return n.card;
  }
  function tidyCard(n) {
    const c = n.card;
    if (!c) return;
    const hasShow = typeof c.show === "boolean" && c.show !== true;
    const hasAlpha = c.alpha !== null && c.alpha !== undefined;
    const hasRadius = c.radius !== null && c.radius !== undefined;
    if (!hasShow && !hasAlpha && !hasRadius) n.card = null;
  }
  window.setCardFlag = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { ensureCard(n)[k] = !!v; tidyCard(n); }, "底框 " + k, "card:" + k);
  };
  window.setCardNum = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    window.commit(() => {
      const c = ensureCard(n);
      if (s === "") { c[k] = null; }
      else {
        const x = Number(s);
        c[k] = Number.isFinite(x) ? Math.max(0, Math.min(k === "alpha" ? 255 : 120, Math.round(x))) : null;
      }
      tidyCard(n);
    }, "底框 " + k, "card:" + k);
  };

  /**
   * 底框 `alpha` / `radius` 的**拖动即预览**版（v2.91.0）。
   *
   * ⚠️ 为什么单开一个：`setCardNum` 里那句 `window.commit(..., "card:"+k)`
   * 会连带重建属性面板 —— 而底框的 alpha 就是一个 `<input type=range>`，
   * 于是**与「不透明度」完全同一个毛病**（拖一下就断）。用户报的是
   * 「其它同类滑块一起查」，这一处就是查出来的那个。
   *
   * 语义与 `setCardNum` 逐字一致（空串 = null = 跟随主题；alpha 夹 0..255、
   * radius 夹 0..120），只是手势期间不重建面板。
   */
  window.setCardNumLive = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    liveNum("底框 " + k, "card:" + k, function () {
      const c = ensureCard(n);
      if (s === "") { c[k] = null; }
      else {
        const x = Number(s);
        c[k] = Number.isFinite(x) ? Math.max(0, Math.min(k === "alpha" ? 255 : 120, Math.round(x))) : null;
      }
      tidyCard(n);
    });
  };
  window.resetCard = function () {
    const n = sel(); if (!n) return;
    window.commit(() => { n.card = null; }, "底框恢复跟随主题");
    window.toast("底框已恢复为跟随主题");
  };

  /** 仪表标签的显示开关（名字 / 量程） */
  window.setNodeFontFlag = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n[k] = !!v; }, (v ? "显示 " : "隐藏 ") + k);
  };
  window.setNodeBool = function (k, v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n[k] = !!v; }, (v ? "开启 " : "关闭 ") + k);
  };
  window.setNodeNullable = function (k, v) {
    const n = sel(); if (!n) return;
    const s = String(v).trim();
    const num = s === "" ? null : Number(s);
    window.commit(() => { n[k] = (num === null || !Number.isFinite(num)) ? null : num; },
      "改 " + k, "null:" + k);
  };
  window.setNodePid = function (v) {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    window.commit(() => window.assignControlBinding(n, v), "改数据源");
  };
  window.setControlBinding = function (id, value) {
    const root = sel(); if (!root || root.type !== window.NODE_GROUP) return;
    const n = window.controlDataBindings(root).find(n => n.id === id);
    if (!n) return;
    window.commit(() => window.assignControlBinding(n, value), "改控件数据源");
  };
  /** 状态系统的驱动 PID：内部存**解析后的 id**，原样写法留在 rawStatePid（与 pid 一致） */
  window.setNodeStatePid = function (v) {
    const n = sel(); if (!n) return;
    const raw = String(v || "").trim();
    window.commit(() => {
      n.rawStatePid = raw;
      n.statePid = raw ? window.resolvePid(raw) : "";
    }, "改状态驱动 PID", "statepid");
  };

  // ================================================================ 代码绘制的条形轨道（v2.91.0）
  //
  // 与 `setBandField` 同一个套路：**所有写入都过 `normalizeTrackStyle`**
  // （唯一入口）—— 这样"内存里合法、文件里非法"的状态不存在，
  // 而且 `null`（= 老行为，贴图）与"一个对象"的语义只有一处定义。

  /** 当前选中的图片节点（轨道只对图片有意义） */
  function imageSel() {
    const n = sel();
    if (!n || n.type !== window.NODE_IMAGE) { window.toast("代码轨道只能加在图片控件上"); return null; }
    return n;
  }

  /** 把一个字段写进 `trackStyle`（值来自面板） */
  window.setTrackField = function (k, v) {
    const n = imageSel(); if (!n) return;
    window.commit(function () {
      const cur = Object.assign({}, n.trackStyle || {});
      if (k === "orient" || k === "gradient") {
        cur[k] = (v === "" || v === undefined || v === null) ? null : String(v);
      } else if (k === "color" || k === "accent") {
        // 空串 = 跟随主题（写 null，不是写 ""）
        cur[k] = (String(v).trim() === "") ? null : String(v);
      } else if (k === "radius" || k === "segments" || k === "ticks" || k === "fill") {
        cur[k] = (String(v).trim() === "") ? null : Number(v);
      } else {
        cur[k] = !!v;
      }
      // ⚠️ `normalizeTrackStyle` 会把非法值夹住；`null` 只在**一个字段都没写**时返回，
      // 而这里 `cur` 至少有 `orient` 或用户改的那一项，所以不会变回 null。
      n.trackStyle = window.normalizeTrackStyle(cur, n.w, n.h);
    }, "改轨道 " + k, "track:" + k);
  };

  /** 开/关「代码绘制」（关 = 回到贴图，`trackStyle = null`） */
  window.toggleTrackStyle = function (on) {
    const n = imageSel(); if (!n) return;
    window.commit(function () {
      if (!on) { n.trackStyle = null; return; }
      // 默认一条最普通的水平轨道 —— 与 `cd_trackh` 那个控件同形
      n.trackStyle = window.normalizeTrackStyle({ orient: "h" }, n.w, n.h);
    }, on ? "改成代码绘制轨道" : "轨道恢复贴图");
    if (on) window.toast("已改成代码绘制 —— 缩放不再模糊（颜色跟随设计主题）");
    else window.toast("已恢复成贴图（`trackStyle` 已清空 = 完全旧行为）");
  };

  window.setNodeCard = function (v) {    const n = sel(); if (!n) return;
    const i = Number(v);
    window.commit(() => { n.cardStyle = (!Number.isFinite(i) || i <= 0) ? null : i; }, "改卡片外框");
  };
  window.setNodeNeon = function (v) {
    const n = sel(); if (!n) return;
    window.commit(() => { n.neonPreset = v || null; }, "改霓虹档位");
  };
  window.setNodeExtras = function (v) {
    const n = sel(); if (!n) return;
    window.commit(() => {
      n.extraPids = String(v).split(",").map(s => s.trim()).filter(Boolean);
    }, "改副参数", "extras");
  };
  /**
   * 数值 → 文字 映射表（P9「非数值 PID 模型」方向 A）。
   *
   * **逗号分隔**，索引 = `round(value)`。与「副参数」同一个套路
   * （属性面板有"行高 ≤ 40px"的排版约束，多行 textarea 会把它顶红）。
   *
   * 代价：**名字里不能有逗号**。挡位这类枚举本来也没有，先这样；
   * 真需要的话要换成弹窗编辑，而不是把面板的行高破掉。
   *
   * 空表归一成 `null`（= 不用映射）—— 否则 `["",""]` 会让读数变成空字符串。
   */
  window.setNodeValueLabels = function (v) {
    const n = sel(); if (!n) return;
    const arr = String(v).split(",").map(s => s.trim());
    window.commit(() => {
      n.valueLabels = window.normalizeValueLabels(arr);
    }, "改数值映射", "vlabels");
  };

  // ================================================================ 多段色带（v2.87.0）

  /**
   * 色带编辑的**唯一写入口**。所有改动都过 `normalizeBands`。
   *
   * ## 为什么必须过归一化（而不是直接改数组）
   *
   * 属性面板允许用户敲任何数字。不过归一化的话，内存里会出现
   * `{from: 9000, to: 200}`（量程外 + 反向）这种"文件里非法"的状态 ——
   * 而**存盘再读回来它会被夹/被丢**，用户看到的是
   * "我明明设了这段，重新打开就没了"。同一个东西有两个形状，
   * 正是本项目反复吃亏的那类问题。
   *
   * ## ⚠️ 三条不许破的约束
   *
   *  1. `bands` **只**决定画出来的分区；`warnLow`/`warnHigh` 继续管**报警判定**。
   *     这里**绝不碰**这两个字段 —— 否则"给转速表加个红区参考"会
   *     **静默改变存量设计的安全语义**。
   *  2. 空 → `null`（不是 `[]`）：与 `valueLabels` 同套路，
   *     保证"内存里的形状"和"文件里的形状"一致（序列化只在非空时写）。
   *  3. 改完要 `commit`（进撤销栈 + 重画），不能直接赋值。
   */
  function bandsOf(n) {
    return Array.isArray(n.bands) ? n.bands : [];
  }
  function commitBands(n, next, label) {
    window.commit(() => {
      n.bands = window.normalizeBands(next, n.min, n.max);
    }, label, "bands");
  }
  function cloneBands(n) {
    return bandsOf(n).map(z => ({ from: z.from, to: z.to, color: z.color, alpha: z.alpha }));
  }

  /**
   * 改一段的某个字段。
   *
   * ⚠️ 面板上用的是 `onchange`（不是 `oninput`）：`commit` 会 `refreshAll()` →
   * **重建整个属性面板**，`oninput` 每敲一个键都会把输入框连同焦点一起换掉，
   * 数字根本敲不完（`from` 敲 "6000" 会在敲第一个 6 之后就失焦）。
   */
  window.setBandField = function (i, k, v) {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    const list = cloneBands(n);
    if (!list[i]) return;
    const s = String(v === undefined || v === null ? "" : v).trim();
    if (k === "color") {
      list[i].color = window.isHexColor(s) ? s : null;
    } else if (k === "alpha") {
      list[i].alpha = s === "" ? null : Number(s);
    } else if (k === "from" || k === "to") {
      if (s === "" || !Number.isFinite(Number(s))) return;   // 敲空/敲字母 → 当次不改（别把段丢了）
      list[i][k] = Number(s);
    } else {
      return;
    }
    commitBands(n, list, "改色带");
  };

  /** 加一段：接着上一段的终点往后 20% 量程（空表时就是量程最后 20%） */
  window.addBand = function () {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    const list = cloneBands(n);
    if (list.length >= window.MAX_BANDS) {
      alert("最多 " + window.MAX_BANDS + " 段色带。");
      return;
    }
    const span = n.max - n.min;
    if (!(span > 0)) { alert("量程非法（min ≥ max），先修量程。"); return; }
    const step = span * 0.2;
    const last = list.length ? list[list.length - 1].to : n.max;
    const from = Math.max(n.min, Math.min(last, n.max - step));
    commitBands(n, list.concat([{ from: from, to: Math.min(n.max, from + step), color: null, alpha: null }]),
      "加一段色带");
  };

  window.delBand = function (i) {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    const list = cloneBands(n);
    if (i < 0 || i >= list.length) return;
    list.splice(i, 1);
    commitBands(n, list, "删一段色带");
  };

  window.clearBands = function () {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    if (!bandsOf(n).length) return;
    commitBands(n, [], "清空色带");
  };

  /**
   * **按 `warnLow` / `warnHigh` 生成色带**（面板上的按钮）。
   *
   * ## 为什么这个按钮值得有
   *
   * `warnLow`/`warnHigh` 是**两个标量**，只能表达"低于 X"和"高于 Y"两段，
   * 而且颜色写死。用户想说"油量绿→黄→红"就必须有色带。
   * 这个按钮是**从旧世界到新世界的桥**：把现在画出来的红区变成可编辑的色带。
   *
   * ## ⚠️ 它**逐像素不改画面**
   *
   * 生成的段用的就是老路径的几何（`min→warnLow`、`warnHigh→max`），
   * `color`/`alpha` 都留 `null`（绘制时回落到同一个 `#FF4D4F` + 不透明）。
   * 所以点一下之后画面**一模一样**，只是那两段变得可编辑了 ——
   * 这是"转换"而不是"改设计"。
   *
   * ## ⚠️ 它**不改** `warnLow`/`warnHigh`
   *
   * 报警判定还在它们身上。用户删掉色带之后，红区会**自动回到** `warnLow`/`warnHigh`
   * 描述的样子 —— 因为那才是"报警"的权威来源。
   */
  window.bandsFromWarn = function () {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    const out = [];
    if (n.warnLow !== null && n.warnLow !== undefined) out.push({ from: n.min, to: n.warnLow, color: null, alpha: null });
    if (n.warnHigh !== null && n.warnHigh !== undefined) out.push({ from: n.warnHigh, to: n.max, color: null, alpha: null });
    if (!out.length) {
      alert("这个表没有 warnLow / warnHigh，没有可转换的红区。\n" +
        "可以先在上面填一个阈值，或者直接点「+ 加一段」。");
      return;
    }
    commitBands(n, out, "按阈值生成色带");
  };
  window.applyPidDefaults = function () {
    const n = sel(); if (!n || n.type !== window.NODE_GAUGE) return;
    const info = window.BUILTIN_PIDS[n.pid];
    if (!info) { alert("PID `" + n.pid + "` 不在内置库里，无法回填。请手动填量程。"); return; }
    window.commit(() => {
      n.min = info.min; n.max = info.max;
      n.warnLow = info.warnLow === undefined ? null : info.warnLow;
      n.warnHigh = info.warnHigh === undefined ? null : info.warnHigh;
    }, "回填量程");
  };

  window.toggleLock = function () {
    const n = sel(); if (!n) return;
    window.commit(() => { n.locked = !n.locked; }, n.locked ? "解锁" : "锁定");
  };
  window.toggleVisible = function () {
    const n = sel(); if (!n) return;
    window.commit(() => { n.visible = !n.visible; }, n.visible ? "隐藏" : "显示");
  };
  window.lockSel = function (v) {
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (n) n.locked = !!v;
      });
    }, v ? "全部锁定" : "全部解锁");
  };

  window.dupSelected = function () {
    if (!S.selection.length) return;
    const made = [];
    window.commit(() => {
      S.selection.forEach(id => {
        const c = window.duplicateNode(S.design.nodes, id);
        if (c) made.push(c.id);
      });
      S.selection = made;
    }, "复制控件");
  };

  window.delSelected = function () {
    if (!S.selection.length) return;
    const n = S.selection.length;
    window.commit(() => {
      window.removeNodes(S.design.nodes, S.selection);
      S.selection = [];
    }, "删除 " + n + " 个控件");
  };

  // ---- 打组 / 取消组合

  /** 把选中的控件打成一个分组。打完之后拖动分组 = 同时拖动全部子控件 */
  window.groupSelected = function () {
    // 先问"能不能"，再决定要不要提交 —— 否则失败也会往撤销栈里压一条空操作
    const chk = window.groupCheck(S.design.nodes, S.selection);
    if (!chk.ok) { toast(chk.reason); return; }
    let made = null;
    window.commit(() => {
      const r = window.groupNodes(S.design.nodes, S.selection, { name: "分组" });
      if (r.ok) { made = r.node; S.selection = [r.node.id]; }
    }, "打组");
    if (made) {
      toast("已打组（" + made.children.length + " 个控件）。拖动分组会一起移动；右键可「取消组合」");
    }
  };

  /** 取消组合：子控件回到分组的父级，视觉位置不变 */
  window.ungroupSelected = function () {
    const groups = S.selection.filter(id => window.isGroup(S.design.nodes, id));
    if (!groups.length) { toast("选中的不是分组（只有分组可以取消组合）"); return; }
    let total = 0;
    window.commit(() => {
      // ⚠️ 必须把**画布矩阵**传进去：组的旋转是在设备空间施加的，
      // 而画布矩阵在 stretch 模式下非等比 —— 在父空间直接转会偏（实测 23.7px）
      const C = window.nodeToCanvasMatrix();
      groups.forEach(id => {
        const r = window.ungroupNode(S.design.nodes, id, C);
        if (r.ok) total += r.count;
      });
      S.selection = [];
    }, "取消组合");
    toast("已取消组合，还原 " + total + " 个控件");
  };

  /** 图层命令：置顶 / 置底 / 上移 / 下移 */
  window.layerCmd = function (cmd) {
    if (!S.selection.length) return;
    window.commit(() => {
      S.selection.forEach(id => {
        const n = window.findNode(S.design.nodes, id);
        if (!n) return;
        const sibs = window.siblingsOf(S.design.nodes, id);
        if (cmd === "front") { window.bringToFront(S.design.nodes, id); }
        else if (cmd === "back") { window.sendToBack(S.design.nodes, id); }
        else if (cmd === "up" || cmd === "down") {
          // ⚠️ 先把同层 z **归一化**成 0..n-1，再交换相邻两个。
          //
          // 直接交换 z 是错的：预设/新建的节点 z 常常**全都一样**
          // （`1big4small` 预设里所有根节点都是 z=1），交换两个相等值等于没动 ——
          // 用户看到的就是"上移/下移点了没反应"。实测确认过。
          const sorted = window.sortByZ(sibs);
          sorted.forEach((x, k) => { x.z = k; });
          const i = sorted.findIndex(x => x.id === id);
          if (i < 0) return;
          const j = cmd === "up" ? i + 1 : i - 1;
          if (j >= 0 && j < sorted.length) {
            const t = sorted[i].z;
            sorted[i].z = sorted[j].z;
            sorted[j].z = t;
          }
        }
      });
    }, "图层：" + cmd);
  };

  // ---- 多选：对齐与分布

  function boundsOf(id) { return window.worldBounds(S.design.nodes, id); }

  window.alignSel = function (mode) {
    if (S.selection.length < 2) return;
    window.commit(() => {
      const bs = S.selection.map(id => ({ id: id, b: boundsOf(id) })).filter(x => x.b);
      if (!bs.length) return;
      const minX = Math.min(...bs.map(x => x.b.x));
      const maxX = Math.max(...bs.map(x => x.b.x + x.b.w));
      const minY = Math.min(...bs.map(x => x.b.y));
      const maxY = Math.max(...bs.map(x => x.b.y + x.b.h));
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      bs.forEach(x => {
        const n = window.findNode(S.design.nodes, x.id);
        if (!n) return;
        if (mode === "left") n.x += minX - x.b.x;
        else if (mode === "right") n.x += maxX - (x.b.x + x.b.w);
        else if (mode === "hcenter") n.x += cx - (x.b.x + x.b.w / 2);
        else if (mode === "top") n.y += minY - x.b.y;
        else if (mode === "bottom") n.y += maxY - (x.b.y + x.b.h);
        else if (mode === "vcenter") n.y += cy - (x.b.y + x.b.h / 2);
      });
    }, "对齐：" + mode);
  };

  window.distributeSel = function (axis) {
    if (S.selection.length < 3) { toast("等距分布至少要选 3 个"); return; }
    window.commit(() => {
      const bs = S.selection.map(id => ({ id: id, b: boundsOf(id) })).filter(x => x.b);
      if (axis === "h") {
        bs.sort((p, q) => p.b.x - q.b.x);
        const first = bs[0].b, last = bs[bs.length - 1].b;
        const total = (last.x + last.w) - first.x;
        const used = bs.reduce((s, x) => s + x.b.w, 0);
        const gap = (total - used) / (bs.length - 1);
        let cur = first.x;
        bs.forEach(x => {
          const n = window.findNode(S.design.nodes, x.id);
          if (n) n.x += cur - x.b.x;
          cur += x.b.w + gap;
        });
      } else {
        bs.sort((p, q) => p.b.y - q.b.y);
        const first = bs[0].b, last = bs[bs.length - 1].b;
        const total = (last.y + last.h) - first.y;
        const used = bs.reduce((s, x) => s + x.b.h, 0);
        const gap = (total - used) / (bs.length - 1);
        let cur = first.y;
        bs.forEach(x => {
          const n = window.findNode(S.design.nodes, x.id);
          if (n) n.y += cur - x.b.y;
          cur += x.b.h + gap;
        });
      }
    }, "等距分布");
  };

  // ---- 状态系统

  window.toggleStates = function (on) {
    const n = sel(); if (!n) return;
    window.commit(() => {
      if (on) {
        // ⚠️ 默认值走**单一真源** `window.defaultStates()`（schema.js）。
        // 原来这里把 normal/warn/critical 三条字面量写了一遍，`editor.js` 里
        // 又写了一遍，`setState` 的兜底还写了第三遍（那一遍 critical 的 blink 是错的）。
        // 加第四个状态时只改一处就会漏 —— 漏掉的那侧"永远不亮"且不报错。
        n.states = window.defaultStates(n.assetId);
        if (!n.statePid) n.statePid = "obd.rpm";
      } else {
        n.states = null;
      }
    }, on ? "启用状态系统" : "关闭状态系统");
  };

  window.setState = function (state, key, v) {
    const n = sel(); if (!n || !n.states) return;
    window.commit(() => {
      // 懒创建也走单一真源 —— 否则 critical 会拿到 `blink:false`
      // （与"启用状态系统"那条路径创建出来的不一样：同一个状态两种默认值）
      if (!n.states[state]) n.states[state] = window.defaultStates(n.assetId)[state];
      const st = n.states[state];
      if (key === "blink") st.blink = !!v;
      else if (key === "assetId") st.assetId = String(v);
      else if (key === "alpha") st.alpha = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
      // WCAG 2.3.1：闪烁每秒不超过三次 → 周期下限 400ms（见 window.MIN_BLINK_MS）
      else if (key === "blinkMs") st.blinkMs = Math.max(window.MIN_BLINK_MS, Math.round(Number(v) || window.MIN_BLINK_MS));
    }, "改状态 " + state, "state:" + state + ":" + key);
  };

  // ================================================================ 顶栏：吸附 / 网格 / 缩放

  window.toggleSnap = function () {
    S.snap = !S.snap;
    const b = el("btnSnap");
    if (b) {
      b.textContent = S.snap ? "网格吸附 开" : "网格吸附 关";
      b.classList.toggle("on", S.snap);
      b.classList.toggle("off", !S.snap);
    }
    toast(S.snap ? "网格吸附已开启（对齐到 " + window.STEP + " 单位网格）"
      : "网格吸附已关闭（可停在任意坐标，边界仍会夹住）");
  }

  /**
   * **对象吸附**开关（v2.20.0）。
   *
   * 与网格吸附是两件事：
   *   · 网格吸附把坐标吸到 15 单位的格子上 —— 对齐的是"格子"
   *   · 对象吸附把边/中心吸到画布或别的节点上 —— 对齐的是"邻居"
   *
   * 两者可以同时开：网格先落位，对象再微调。也可以只开一个。
   */
  window.toggleSnapObj = function () {
    S.snapGuides = S.snapGuides === false;   // 默认 true，所以判 false 而不是真值
    const b = el("btnSnapObj");
    if (!b) return;
    const on = S.snapGuides !== false;
    b.textContent = on ? "对象吸附 开" : "对象吸附 关";
    b.classList.toggle("on", on);
    b.classList.toggle("off", !on);
    if (!on) { S.snapLines = null; window.draw(); }
    toast(on ? "对象吸附已开启（对齐到画布与其它控件）"
             : "对象吸附已关闭（不再显示对齐参考线）");
  };;
  window.toggleGrid = function () {
    S.showGrid = !S.showGrid;
    const b = el("btnGrid");
    if (b) { b.classList.toggle("on", S.showGrid); }
    window.draw();
  };

  /**
   * 画布上的控件是否显示 **PID id**。
   *
   * 为什么要有这个开关：做主题时"这个表绑的是哪个 PID"经常要看一眼，
   * 但摆位置时那行字又挡视线。所以做成可切换，默认**关**（画面干净）。
   * 控件名字（友好名）不受影响，始终显示。
   */
  window.togglePidLabel = function () {
    S.showPid = !S.showPid;
    try { localStorage.setItem("studio.showPid", S.showPid ? "1" : "0"); } catch (e) { }
    const b = el("btnPid");
    if (b) {
      // ⚠️ 文案要写**当前状态**，不能写成动作，否则会读反。
      // 第一版写"🏷 PID 隐 / 🏷 PID 显"，用户以为"点了会隐藏"——
      // 实际它表示"现在处于隐藏/显示状态"。
      // 现在：`数据标识 关`（不显示）/ `数据标识 开`（显示），并配 title 说明。
      b.textContent = S.showPid ? "数据标识 开" : "数据标识 关";
      b.title = S.showPid
        ? "当前：画布上显示 PID 别名（如 obd.coolant）。点击关闭"
        : "当前：画布上不显示 PID。点击开启（做主题时用来确认绑的是哪个 PID）";
      b.classList.toggle("on", S.showPid);
    }
    window.draw();
  };

  // ================================================================ 界面主题（暗黑 / 白色）

  /**
   * 切换暗黑 / 白色主题。
   *
   * 配色全在 `css/studio.css` 的 CSS 变量里，这里只切 `<html data-theme>`；
   * **画布的底色也从变量读**（`--cvOut/--cvIn/...`）—— 不然切了主题画布还是黑的。
   */
  window.toggleTheme = function (force, silent) {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = force || (cur === "dark" ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("studio.theme", next); } catch (e) { }
    const b = el("btnTheme");
    if (b) b.textContent = next === "dark" ? "深色界面" : "浅色界面";
    // 画布要重画（底色变了）
    window.draw();
    if (!silent) toast(next === "dark" ? "已切换为深色界面" : "已切换为浅色界面");
  };

  /** 画布用色：从 CSS 变量读，这样切主题时画布跟着变 */
  function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return (v && v.trim()) || fallback;
    } catch (e) { return fallback; }
  }
  window.readCanvasColors = function () {
    return {
      out: cssVar("--cvOut", "#020407"),
      in: cssVar("--cvIn", "#05070A"),
      grid: cssVar("--cvGrid", "rgba(20,28,38,0.9)"),
      gridAxis: cssVar("--cvGridAxis", "rgba(30,44,60,0.95)"),
      card: cssVar("--cvCard", "rgba(28,36,48,0.75)"),
      cardLine: cssVar("--cvCardLine", "#2A3547"),
      track: cssVar("--cvTrack", "#263143"),
      // 代码绘制的轨道（v2.91.0）的**兜底色**：设计没主题时用工具 UI 的主色。
      // ⚠️ 这两个是给 `drawTrackNode` 的 `themeColors()` 兜底用的 ——
      // 正常路径（设计带主题）拿到的是 `themeColors().track / .accent`，
      // 也就是**跟设计主题**。写在这里而不是硬编码在 canvas.js 里，
      // 是因为构建守卫有一条「canvas.js 不许有裸色值」（那正是 v2.59.0 加的）。
      accent: cssVar("--accent", "#00D8FF"),
      text: cssVar("--cvText", "#8FA0B8"),
      textDim: cssVar("--cvTextDim", "#5F6E85"),
      textFaint: cssVar("--cvTextFaint", "#3A4A5E"),
      value: cssVar("--cvValue", "#FFFFFF"),
    };
  };

  // ================================================================ 折叠面板

  /**
   * 设计信息 / 背景图 / 预设布局 / **JSON 与差异**（v2.91.0 加） 的折叠。
   *
   * 折叠状态存 localStorage —— 用户调好一次布局，下次打开还是他要的样子。
   */
  window.togglePanel = function (name) {
    const body = el("body-" + name);
    const caret = el("caret-" + name);
    if (!body) return;
    const open = body.style.display === "none";
    body.style.display = open ? "" : "none";
    if (caret) caret.textContent = open ? "▾" : "▸";
    try { localStorage.setItem("studio.panel." + name, open ? "1" : "0"); } catch (e) { }
    // ⚠️ **JSON 面板不重算画布尺寸**（v2.91.0）。
    //
    // 其余三个面板改的是**右栏**高度，而画布在**中栏**（`main` 是三栏 grid，
    // 列宽写死 `320px / 1fr / 420px`）—— 右栏怎么变都挤不到画布。
    // 但 `applyCanvasSize()` 是按 `wrap.clientWidth/Height` 重算的，
    // 万一将来布局改成"右栏能挤压中栏"，这里就会**在展开 JSON 时把画布缩小**。
    // 这是本项目的**老坑**（见 studio.css 里 `flex: 0 0 auto` 那段注释：
    // 位图比例与 CSS 尺寸不一致 → 坐标换算全错、旋转手柄点不中）。
    // 所以对 JSON 面板走**保尺寸**的那条路：收/展前后画布尺寸必须一模一样。
    if (name === "json") applyCanvasSizePreserving();
    else setTimeout(() => window.applyCanvasSize(), 0);
  };

  /**
   * 重算画布尺寸，但**尺寸不许变**。
   *
   * 收/展面板是**布局**操作，不该动画布 —— 尺寸变了就是回归（老坑）。
   * 做法：先把当前 CSS 尺寸记下来，调一次 `applyCanvasSize()`，
   * 若算出来的尺寸**与原来不同**，就改回去并记一条警告（供测试断言）。
   */
  function applyCanvasSizePreserving() {
    const cv = document.getElementById("cv");
    if (!cv) return;
    const before = { w: cv.style.width, h: cv.style.height, bw: cv.width, bh: cv.height };
    if (window.applyCanvasSize) window.applyCanvasSize();
    const after = { w: cv.style.width, h: cv.style.height, bw: cv.width, bh: cv.height };
    const changed = before.w !== after.w || before.h !== after.h ||
      before.bw !== after.bw || before.bh !== after.bh;
    window.__panelCanvasResize = window.__panelCanvasResize || [];
    window.__panelCanvasResize.push({ before: before, after: after, changed: changed });
    if (changed) {
      cv.style.width = before.w; cv.style.height = before.h;
      cv.width = before.bw; cv.height = before.bh;
      if (window.draw) window.draw();
      if (window.console && console.warn) {
        console.warn("切换面板把画布尺寸改了：" + JSON.stringify(before) + " → " + JSON.stringify(after) +
          "（已还原；这是回归，见 togglePanel 的注释）");
      }
    }
  }
  window.applyCanvasSizePreserving = applyCanvasSizePreserving;

  /**
   * 恢复各面板的折叠状态。
   *
   * ⚠️ 默认值是**逐个写死**的，不是"一律展开"：
   *   · `preset`（预设布局）默认收起 —— 用一次就不再动
   *   · `json`（JSON 与差异）默认收起（v2.91.0，用户要求「JSON页面默认隐藏」）
   *   · `info` / `bg` 默认展开 —— 新建设计时最常改的就是这两块
   */
  function restorePanels() {
    ["preset", "info", "bg", "json"].forEach(name => {
      let open;
      try {
        const saved = localStorage.getItem("studio.panel." + name);
        const defOpen = (name !== "preset" && name !== "json");
        open = saved === null ? defOpen : saved === "1";
      } catch (e) { open = (name !== "preset" && name !== "json"); }
      const body = el("body-" + name);
      const caret = el("caret-" + name);
      if (body) {
        body.style.display = open ? "" : "none";
        // `body-json` 是**列向 flex**（页签 + 文本域），展开时要恢复 display:flex ——
        // 置空会让它回到 CSS 的 `display:block`，页签与文本域就摞不紧了。
        if (name === "json") body.style.display = open ? "flex" : "none";
      }
      if (caret) caret.textContent = open ? "▾" : "▸";
    });
  }

  // ================================================================ 新建

  /** 清空重来。**会先问一次** —— 没保存的设计丢了很恼火 */
  window.newDesign = function () {
    const n = window.flatten(S.design.nodes).length;
    if ((n > 0 || jsonDirty) && !confirmJsonReplace("新建", "新建会清空当前 " + n + " 个控件（未保存的改动会丢）。")) return;
    const d = blankDesign();
    d.nodes = window.PRESETS["blank"]();
    if (!replaceDesign(d, "新建设计")) return;
    S.bgImage = null;
    window.applyCanvasSize();
    toast("已新建空白设计");
  };

  // ================================================================ 校验显示

  let lastErrors = [], lastWarnings = [];

  /**
   * 渲染校验结果。
   *
   * @param errPos 若有 JSON **语法**错误，它的结构化位置 {line, col, pos}。
   *   有位置时，第一条错误会变成**可点击的"跳到第 N 行"** ——
   *   用户不用自己数行号。
   */
  /**
   * 校验结果**一次最多渲染几条**（v2.83.0，Round 2）。
   *
   * ## 为什么要设上限
   *
   * `parts` 没有条数上限（`nodes` 有 200 的上限），而**每个没选素材的部件**
   * 都会产生一条警告。实测：一份 820 KB 的 JSON 带 20000 个部件 →
   * `validateText` 返回 **20000 条警告** → 这里 append 20000 个 DOM 行。
   * 再大一个数量级（20 万部件）就是几秒的白屏 + 几十 MB 的 DOM。
   * 而这发生在**每次敲键盘**之后（`jsonEdited` 350ms 防抖）。
   *
   * ## 为什么不静默截断
   *
   * 截断必须**说出来** —— 否则用户会以为"警告就这几条"，
   * 把面板上没显示的问题当成不存在。所以超额时补一行"…还有 N 条（共 M 条）"。
   * 这也是本仓库的一贯规矩：宁可啰嗦，不可静默。
   */
  const MSG_RENDER_MAX = 200;

  function renderMessages(errors, warnings, errPos) {
    const box = el("msgs");
    if (!box) return;
    box.innerHTML = "";
    if (!errors.length && !warnings.length) {
      box.innerHTML = '<div class="msg ok">校验通过：没有硬错误，也没有警告。</div>';
      return;
    }
    /** 渲染一类消息，超额时补一行说明。`jumpFirst` 只给第一条错误加"跳到出错行" */
    function render(list, kind, jumpFirst) {
      const n = Math.min(list.length, MSG_RENDER_MAX);
      for (let i = 0; i < n; i++) {
        // 只在**第一条**错误上加跳转（语法错误就一条，其余是结构校验）
        const jump = (jumpFirst && i === 0 && errPos) ? errPos : null;
        box.appendChild(msg(kind, list[i], jump));
      }
      if (list.length > n) {
        const d = document.createElement("div");
        d.className = "msgMore";
        d.textContent = "…还有 " + (list.length - n) + " 条" +
          (kind === "err" ? "错误" : "警告") + "（共 " + list.length + " 条）—— 先修前面的，后面多半会跟着消失";
        box.appendChild(d);
      }
    }
    render(errors, "err", true);
    render(warnings, "warn", false);
  }

  /**
   * 一条消息。
   *
   * @param jump 有值时把这条做成可点击的 —— 点一下光标就跳到出错行并选中它。
   */
  function msg(kind, text, jump) {
    const d = document.createElement("div");
    d.className = "msg " + kind;
    if (!jump) { d.textContent = text; return d; }
    d.classList.add("jumpable");
    d.title = "点击跳到第 " + jump.line + " 行";
    const span = document.createElement("span");
    span.textContent = text;
    d.appendChild(span);
    const btn = document.createElement("button");
    btn.className = "jumpBtn";
    btn.textContent = "跳到第 " + jump.line + " 行 ↗";
    btn.onclick = () => window.gotoJsonError();
    d.appendChild(btn);
    return d;
  }

  /** 最近一次 JSON 语法错误的位置（用于"跳到出错处"） */
  let jsonErrPos = null;

  function validateNow() {
    const text = getVal("jsonArea");
    const r = window.validateText(text);
    lastErrors = r.errors;
    lastWarnings = r.warnings;

    // 单独跑一次严格解析拿**结构化位置** —— validateText 只给文案，
    // 而界面要把光标跳过去、并高亮那一行
    const strict = window.parseJsonStrict(text);
    jsonErrPos = strict.ok ? null : (strict.pos === undefined ? null
      : { pos: strict.pos, line: strict.line, col: strict.col });

    renderMessages(r.errors, r.warnings, jsonErrPos);
    const b = el("btnSave");
    if (b) b.classList.toggle("bad", r.errors.length > 0);
    return r;
  }

  /**
   * 把光标跳到 JSON 的出错处，并选中那一行。
   *
   * 为什么要"选中整行"而不只是放个光标：JSON 的报错位置常指向
   * **上一个 token 的结尾**（少个逗号 / 多括号），只放光标用户看不出来。
   * 选中整行能让人一眼定位。
   */
  window.gotoJsonError = function () {
    const area = el("jsonArea");
    if (!area || !jsonErrPos) return;
    const text = area.value;
    const pos = Math.min(jsonErrPos.pos, text.length);
    const lineStart = text.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
    let lineEnd = text.indexOf("\n", pos);
    if (lineEnd < 0) lineEnd = text.length;
    area.focus();
    area.setSelectionRange(lineStart, lineEnd);
    // 滚动到可见（textarea 没有 scrollIntoView(line)，按行高估算）
    const lh = parseFloat(getComputedStyle(area).lineHeight) || 16;
    const target = (jsonErrPos.line - 1) * lh - area.clientHeight / 3;
    area.scrollTop = Math.max(0, target);
  };
  window.validateNow = validateNow;

  // ================================================================ JSON 双向同步

  /**
   * 同步"设计对象 → JSON 文本 / 表单"。
   *
   * ⚠️ **`jsonDirty` 为真时直接跳过**，绝不覆盖文本域。
   *
   * 这是踩过的坑：用户在 JSON 里删了个字段 → 解析失败 → 工具保留上一次成功的设计
   * （画布不变），但**下一次画布改动会调 `syncJson()` 把文本域冲掉** ——
   * 用户的编辑就这么无声无息地没了。实测确认过（删掉 `nodes[0].pid` 后再拖一下，
   * `pid` 又回来了）。
   *
   * 所以：文本域有错未生效时，它是"用户的"，谁都不许动。
   */
  let jsonDirty = false;

  /**
   * 最近一次"JSON 有错未生效"的**错误条数**（T5-R2）。
   *
   * 为什么要单独存：dirty 提示条的文案是
   * `"⚠️ JSON 有 N 个错误…"`。失败回滚时如果不能把 `N` 还原，
   * 用户看到的就是"**1 个错误变成 0 个错误**"这种前后矛盾的界面
   * （规划方实测的反例）。`setJsonDirty(dirty, errors)` 在 `dirty` 为真时
   * 一定带着 `errors`，这里就把 `errors.length` 记下来。
   */
  let jsonDirtyErrors = 0;
  let jsonPending = false;

  /**
   * 把"dirty 现场"整份**原样**抓下来（T5-R2；T5-R3 补**事件**）。
   *
   * ⚠️ 只记一个布尔是不够的：规划方实测"`mName` 仍是 TARGET、
   * dirty 提示从 1 个错误变 0 个错误"就是因为它只留了 `areaDirty`。
   * 这里连**提示条的可见性与内容**一起抓 —— 复原是"逐字节还原原现场"，
   * 不是"照着当前状态重新渲染一个看起来差不多的"。
   *
   * ## ⚠️⚠️ T5-R3：**HTML 相同 ≠ 交互相同**
   *
   * T5-R2 抓的是 `bar.innerHTML`（字符串），复原时 `bar.innerHTML = 那个字符串`。
   * 而"放弃 JSON 改动"那个按钮的点击处理是**JS 属性**（`btn.onclick = function…`），
   * **不在 `innerHTML` 里** —— 重新解析出来的新节点 `onclick` 是 `null`。
   * 规划方实测：真实 `draw` 失败一次之后，点那个按钮**什么都不发生**
   * （dirty 还是 true、草稿没被换掉、提示条不消失），而 HTML 逐字节相同。
   *
   * 所以现在抓的是**原来那批 DOM 节点本身**（`childNodes`）：
   * 复原时把它们**放回**提示条即可 —— 事件监听/属性全都跟着节点走，
   * 不解析任何 HTML、不执行任何脚本（`innerHTML` 那条路彻底不用了）。
   *
   * ⚠️ `restore()` 应用阶段会先 `setJsonDirty(false)`，那一步做的是
   *    `bar.innerHTML = ""` —— 节点只是**脱离文档**，JS 对象与事件都还在，
   *    所以"抓住引用 → 事后放回"是成立的（这正是 T5-R2 丢掉东西的地方）。
   */
  function captureDirtyState() {
    const area = el("jsonArea");
    const bar = el("jsonDirtyBar");
    return {
      dirty: jsonDirty,
      errors: jsonDirtyErrors,
      pending: jsonPending,
      areaHasDirty: !!(area && area.classList.contains("dirty")),
      barExisted: !!bar,
      barDisplay: bar ? bar.style.display : null,
      // ⚠️ 抓**节点本身**（不是 innerHTML 字符串）：事件是 JS 属性，序列化不了
      barNodes: bar ? Array.prototype.slice.call(bar.childNodes) : null,
    };
  }

  /**
   * 把 `captureDirtyState()` 抓下来的现场**原样放回去**（T5-R2；T5-R3 连事件）。
   *
   * ⚠️ 全程**不许抛**：这是异常收尾路径（"异常收尾本身不得再抛"）。
   * 有没有提示条、`style`/节点可不可写，都容错。
   *
   * ⚠️ 复原方式：`bar.innerHTML = ""` 清空之后，把**抓下来的那几个节点**
   *    `appendChild` 回去（顺序不变）。不重新解析 HTML、不执行脚本，
   *    `onclick` / 监听器 / 文本与属性全都是原来那一个。
   */
  function restoreDirtyState(st) {
    if (!st) return;
    jsonDirty = st.dirty;
    jsonDirtyErrors = st.errors;
    jsonPending = !!st.pending;
    try {
      const area = el("jsonArea");
      if (area) area.classList.toggle("dirty", st.areaHasDirty);
      const bar = el("jsonDirtyBar");
      if (!bar) return;
      if (st.barExisted && st.barNodes) {
        // 先清空（把"应用阶段可能建/写进去的东西"去掉），再放回**原节点**
        while (bar.firstChild) bar.removeChild(bar.firstChild);
        for (let i = 0; i < st.barNodes.length; i++) bar.appendChild(st.barNodes[i]);
        if (st.barDisplay !== null) bar.style.display = st.barDisplay;
      } else if (!st.barExisted) {
        // 抓现场时**根本没有**提示条 → 恢复成"没有"（哪怕应用阶段把它建出来了）
        while (bar.firstChild) bar.removeChild(bar.firstChild);
        bar.style.display = "none";
      }
    } catch (e) { }
  }

  function syncJson() {
    if (!S.design) return;
    if (jsonDirty) return;                 // ← 关键：别冲掉用户正在改的文本
    suppressJsonSync = true;
    setVal("jsonArea", window.toV2Json(S.design));
    setVal("mName", S.design.name);
    setVal("mAuthor", S.design.author);
    setVal("mDesc", S.design.description);
    setVal("mTheme", S.design.themeId);
    setVal("dW", S.design.canvas.designW);
    setVal("dH", S.design.canvas.designH);
    setVal("scaleMode", String(S.design.canvas.scaleMode));
    setVal("bgPath", S.design.background ? S.design.background.path : "");
    setVal("bgFit", String(S.design.background ? S.design.background.fit : 0));
    // 尺寸留空显示（0 = 自动）
    const bw = S.design.background && S.design.background.w ? S.design.background.w : "";
    const bh = S.design.background && S.design.background.h ? S.design.background.h : "";
    setVal("bgW", bw);
    setVal("bgH", bh);
    suppressJsonSync = false;
  }

  /** JSON 文本域有错未生效时，给个**看得见**的提示 + 一个"放弃改动"的出口 */
  function setJsonDirty(dirty, errors, pending) {
    jsonDirty = dirty;
    jsonPending = !!(dirty && pending);
    // ⚠️ T5-R2：错误条数单独存一份 —— 失败回滚要按**原条数**重建提示条，
    //    否则就是规划方实测的"1 个错误变成 0 个错误"。
    jsonDirtyErrors = (dirty && errors) ? errors.length : 0;
    const area = el("jsonArea");
    if (area) area.classList.toggle("dirty", dirty);
    let bar = el("jsonDirtyBar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "jsonDirtyBar";
      bar.className = "jsonDirtyBar";
      const pane = el("paneJson");
      if (pane) pane.insertBefore(bar, pane.firstChild);
    }
    if (!bar) return;
    if (!dirty) { bar.style.display = "none"; bar.innerHTML = ""; return; }
    bar.style.display = "";
    bar.innerHTML = "";
    const msg = document.createElement("span");
    msg.textContent = jsonPending
      ? "JSON 草稿等待校验，尚未应用。画布可以继续编辑，两边暂未同步；合法草稿会自动替换画布，画布改动不会写回草稿。"
      : "⚠️ JSON 有 " + jsonDirtyErrors + " 个错误，草稿尚未应用。画布可以继续编辑，两边暂未同步；修好后会自动替换画布，画布改动不会写回草稿。";
    const btn = document.createElement("button");
    btn.textContent = "放弃 JSON 改动，回到画布状态";
    btn.onclick = function () {
      window.discardJsonEdit();
      toast("已放弃 JSON 改动，文本已回到画布当前状态");
    };
    bar.appendChild(msg);
    bar.appendChild(btn);
  }
  window.discardJsonEdit = function () {
    cancelJsonTimer();
    setJsonDirty(false);
    syncJson();
    validateNow();
  };

  /**
   * 安全地写一个 DOM 值。
   *
   * ⚠️ 为什么要它：第一版 `init()` 里直接 `el("bgFit").appendChild(...)`，
   * 而 HTML 里恰好漏了那个元素 → **抛异常 → init 中断 → design 一直是 null →
   * 所有面板全空**。一个缺失的 id 不该让整个工具瘫掉。
   * 现在所有可选的 DOM 访问都过这里，缺元素只会静默跳过。
   */
  function setVal(id, v) {
    const e = el(id);
    if (e) e.value = v;
  }

  /** 安全地读一个 DOM 值（缺元素返回空串，不抛） */
  function getVal(id) {
    const e = el(id);
    return e ? String(e.value) : "";
  }
  window.syncJson = syncJson;

  let jsonTimer = null;
  let jsonEditRevision = 0;
  function cancelJsonTimer() {
    clearTimeout(jsonTimer);
    jsonTimer = null;
    jsonEditRevision++;
  }

  // 确认只授予替换许可；恢复失败时仍由 restore 保留原草稿。
  function confirmJsonReplace(action, message) {
    if (!jsonDirty && !message) return true;
    const draftNote = jsonDirty
      ? "\nJSON 草稿尚未应用，继续会放弃草稿；无法通过撤销找回这段草稿。"
      : "";
    return confirm((message || action + "会替换当前画布。") + draftNote + "\n\n继续？");
  }

  function replaceDesign(design, label) {
    let candidate;
    try { candidate = JSON.stringify({ d: design, sel: [] }); }
    catch (e) { toast("设计无法读取，当前设计和 JSON 草稿已保留"); return false; }
    if (!restore(candidate)) {
      toast("设计无法恢复，当前设计和 JSON 草稿已保留");
      return false;
    }
    undo.push(snapshot(), label);
    lastPersistKey = null;
    saveUndoStack();
    updateUndoButtons();
    return true;
  }

  window.jsonEdited = function () {
    if (suppressJsonSync) return;
    cancelJsonTimer();
    const revision = jsonEditRevision;
    const text = getVal("jsonArea");
    setJsonDirty(true, null, true);
    jsonTimer = setTimeout(() => {
      if (revision !== jsonEditRevision || getVal("jsonArea") !== text) return;
      jsonTimer = null;
      const r = window.validateText(text);
      if (r.errors.length || !r.design) {
        // 解析失败：**保留当前设计**（画布不动），把文本域标记成"有错未生效"，
        // 并且从此不再覆盖它（见 syncJson 的 jsonDirty）
        setJsonDirty(true, r.errors);
        validateNow();
        return;
      }
      setJsonDirty(false);
      // ⚠️ **替换设计必须压一步撤销**（v2.83.0，Round 5）。
      //
      // 原来这里是裸赋值 `S.design = r.design` —— 于是"文本域 → 画布"这条路
      // **整个不进撤销栈**。两处后果都实测过：
      //  1. 「打开」一份设计文件后按撤销，回到的**不是打开前**，而是撤销栈里的
      //     **上一步**（实测：打开前是 A{x:33}，打开 B，撤销后变成一个无关的旧状态，
      //     用户辛苦做的 A **直接丢了**）。
      //  2. 在 JSON 文本域里改了一大段、画布同步了，撤销也退不回来。
      //
      // 合并键用 `json`：连续敲键盘/连续同步只算**一步**，撤销一次就回到编辑之前。
      window.commit(() => {
        S.design = r.design;
        if (S.selection.some(id => !window.findNode(S.design.nodes, id))) S.selection = [];
        window.restoreThumbs();
        window.applyCanvasSize();
      }, "同步 JSON 文本到画布", "json");
      validateNow();
      updateUndoButtons();
    }, 350);
  };

  window.metaChanged = function () {
    window.commit(() => {
      S.design.name = getVal("mName");
      S.design.author = getVal("mAuthor");
      S.design.description = getVal("mDesc");
      S.design.themeId = getVal("mTheme");
    }, "改设计信息", "meta");
  };

  window.canvasChanged = function () {
    window.commit(() => {
      const w = Math.max(160, Math.round(Number(getVal("dW")) || 2560));
      const h = Math.max(120, Math.round(Number(getVal("dH")) || 1600));
      S.design.canvas.designW = w;
      S.design.canvas.designH = h;
      S.design.canvas.scaleMode = Number(getVal("scaleMode")) || 0;
    }, "改设计分辨率");
    window.applyCanvasSize();
  };

  // ---- 背景图（v1 兼容字段：只写路径，图片本身放 assets/）

  window.bgChanged = function () {
    if (suppressJsonSync) return;
    window.commit(() => {
      const p = getVal("bgPath").trim();
      const fit = Number(getVal("bgFit")) || 0;
      if (!p) { S.design.background = null; return; }
      // 尺寸留空 = 交给铺法自动决定（写 0）
      const w = Math.max(0, Math.round(Number(getVal("bgW")) || 0));
      const h = Math.max(0, Math.round(Number(getVal("bgH")) || 0));
      S.design.background = { path: p, fit: fit, w: w, h: h };
    }, "改背景图", "bg");
  };

  window.clearBg = function () {
    window.commit(() => { S.design.background = null; }, "清除背景");
    S.bgImage = null;
    window.draw();
  };

  /**
   * 选一张本机图片**只用于预览**。
   *
   * ⚠️ 浏览器读不到设备路径，所以这里**不会**改 `bgPath` ——
   * 写进设计文件的路径必须由用户手填（与 App 的 `assets/` 约定一致）。
   * 这条差异在「与 App 规则的差异」页里显式列出。
   */
  window.pickBgImage = function () {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = "image/*";
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = () => {
        S.bgImage = img;
        if (!getVal("bgPath").trim()) {
          setVal("bgPath", "assets/" + f.name.replace(/[\\/:*?"<>|]/g, "_"));
          window.bgChanged();
        }
        window.draw();
        toast("背景预览已加载（写出的路径是 " + getVal("bgPath") + "）");
      };
      img.src = url;
    };
    inp.click();
  };

  // ================================================================ 实时数据模拟（+ 弹簧）

  /**
   * 实时数据模拟：给所有用到的 PID 生成正弦波形，驱动预览动起来。
   *
   * 为什么要它：做主题时"数值变了会怎样"（指针扫过、条形增长、状态灯切换）
   * 是最需要看的部分，但真车不在手边。没有它就只能靠想象。
   *
   * 波形与 `DashboardBenchmark` 同思路：正弦（处处连续，不会突然跳变），
   * 每条错开相位，避免所有表同时到峰值。
   *
   * ## 全工具**唯一**的实时数据 rAF 主循环（v2.81.0）
   *
   * ⚠️ 只有这一个循环负责**实时数据**；补间（自检扫表）走另一条路
   * （`playBootSweep`）。两者写同一个属性（指针角度）时靠 `S.anim` 让位 ——
   * 见下面 `allows("sim")` 那一句。
   *
   * 参考实现踩过的坑：主循环每帧覆写 `rotation`，把开机自检的扫表**完全压掉**
   * （动画在跑，但一帧都看不见）。所以顺序必须是
   * **先问让位标志、再决定这一帧推不推弹簧**，而不是"先推再被覆盖"。
   *
   * ## 为什么指针走弹簧而不是直接映射真值
   *
   * 真值每 16ms 换一次，直接映射就是**硬跳**（而且正弦采样不匀时还会抖）。
   * 弹簧是**状态**不是动画：目标怎么跳，它都只是"被拉了一下"。
   * 补间做不到这件事 —— 目标一直在变，补间永远追不上，还会互相 overwrite。
   */
  let simRunning = false;
  let simStart = 0;
  let simRaf = null;
  let simLast = 0;

  function collectPids() {
    return window.collectDesignPids(S.design.nodes);
  }

  /** 第 t 秒时的**真值**表 `{pid: value}`（正弦） */
  function simTargets(t) {
    const pids = collectPids();
    const vals = {};
    pids.forEach((pid, i) => {
      const info = window.BUILTIN_PIDS[pid];
      const min = info ? info.min : 0;
      const max = info ? info.max : 100;
      const period = 4 + (i % 4) * 1.5;                 // 4~8.5 秒一圈
      const phase = (t / period) + i / Math.max(1, pids.length);
      const n = (Math.sin(phase * 2 * Math.PI) + 1) / 2; // 0..1
      vals[pid] = min + (max - min) * n;
    });
    return vals;
  }

  function simStep() {
    if (!simRunning) return;
    const now = performance.now();
    const t = (now - simStart) / 1000;
    // ⚠️ dt 用**真实帧间隔**（弹簧是物理积分，不是按帧数走），
    //    并且**在 `spring.step` 里夹上限**：切走标签页再切回来时 dt 可能是好几秒，
    //    不夹的话 `k·dt²` 直接发散（指针飞到屏幕外）。
    const dt = simLast ? (now - simLast) / 1000 : 1 / 60;
    simLast = now;
    const vals = simTargets(t);
    S.previewValues = vals;                       // 真值：读数 / 条形 / 状态灯 / 阈值
    // **让位**：被补间（自检扫表）占着就**不推弹簧** —— 不写"指针角度"这个属性
    if (!S.anim || S.anim.allows("sim")) {
      S.simSprings.step(vals, dt);                // 弹簧位置：指针 / 进度弧 / 数字鼓
    }
    S.simPhase = t;
    window.draw();
    simRaf = requestAnimationFrame(simStep);
  }

  window.toggleSim = function () {
    simRunning = !simRunning;
    const b = el("btnSim");
    if (simRunning) {
      simStart = performance.now();
      simLast = 0;
      const vals = simTargets(0);
      S.previewValues = vals;
      S.simSprings.active = true;
      // 弹簧**从当前真值起步**，不是从 0 起步 ——
      // 否则一开模拟所有指针都从零扫过去，看着像"开机自检"，
      // 而那恰好会掩盖我们真正想看的观感（正弦追针）
      S.simSprings.clear();
      Object.keys(vals).forEach(k => S.simSprings.snap(k, vals[k]));
      simStep();
      if (b) { b.textContent = "⏸ 停止模拟"; b.classList.add("on"); }
      toast("模拟预览已开始：正在使用示例数据，不是车辆实时数据");
    } else {
      if (simRaf) cancelAnimationFrame(simRaf);
      S.previewValues = null;
      S.simPhase = 0;
      S.simSprings.active = false;
      S.simSprings.clear();
      window.draw();
      if (b) { b.textContent = "▶ 模拟预览"; b.classList.remove("on"); }
    }
  };

  /** 模拟的速度：让波形跑快一点，便于快速看到状态切换 */
  window.setSimSpeed = function () { /* 预留 */ };

  // ================================================================ 补间（作者编排的动画）

  /**
   * **把指针交给补间**（v2.81.0）。
   *
   * 这是"让位标志"的写入口：`holdMs` 内实时数据不写指针角度，
   * 指针读 `vals`（`{pid: value}`）。不传 `vals` 就是**交还**。
   *
   * 为什么要有超时：调 `claim` 的一方要是崩了（忘了 release），
   * 标志会自己过期，不会把实时数据**永久**锁死 —— 那种 bug 的表现是
   * "实时模拟开着但指针不动"，极难定位。
   */
  window.setTweenValues = function (vals, holdMs) {
    S.tweenValues = vals || null;
    if (S.tweenValues) S.anim.claim("tween", holdMs === undefined ? 400 : holdMs, "setTweenValues");
    else S.anim.release("tween");
    window.draw();
  };

  let sweepRaf = null;

  /**
   * **开机自检扫表**：所有指针 0 → 满 → 回位。
   *
   * 它同时是"让位仲裁"的**活例子**：扫表期间实时数据让位，
   * 扫完交还。参考实现正是这里出的问题 —— 主循环每帧覆写角度，
   * 扫表在跑却一帧都看不见。
   */
  window.playBootSweep = function (ms) {
    const dur = Math.max(300, Number(ms) || 1600);
    if (sweepRaf) cancelAnimationFrame(sweepRaf);
    const pids = collectPids();
    if (!pids.length) { toast("画布上没有绑 PID 的仪表，扫表无从谈起"); return; }
    const t0 = performance.now();
    S.anim.claim("tween", dur + 400, "boot-sweep");
    const step = function () {
      const p = Math.min(1, (performance.now() - t0) / dur);
      // 0 → 1 → 0 的三角波：前 60% 扫满，后 40% 回位
      const k = p < 0.6 ? (p / 0.6) : (1 - (p - 0.6) / 0.4);
      const vals = {};
      pids.forEach(function (pid) {
        const info = window.BUILTIN_PIDS[pid];
        const min = info ? info.min : 0;
        const max = info ? info.max : 100;
        vals[pid] = min + (max - min) * k;
      });
      S.tweenValues = vals;
      window.draw();
      if (p < 1) {
        sweepRaf = requestAnimationFrame(step);
      } else {
        sweepRaf = null;
        S.tweenValues = null;
        S.anim.release("tween");     // **交还**给实时数据
        window.draw();
      }
    };
    step();
  };

  // ================================================================ 装饰动画预览（T-UI-HUD-01）

  /**
   * **装饰动画的预览时钟**。
   *
   * ## 为什么要有它
   *
   * `GaugePart.anim` 是**时间驱动**的（永不收敛）。工具的画布原本只在
   * "有东西变了"时才重绘，所以静态预览里那些扫描光带/呼吸光晕**根本不会动** ——
   * 用户设了动画却完全看不到效果，以为没生效。
   *
   * 这个循环每帧把 `S.__animMs` 推进并重绘一次。
   *
   * ## 三条不破坏现有行为的设计
   *
   * 1. **只在真的存在 anim 部件时才跑** —— 没有动画的设计零开销，
   *    不会让整个工具一直 60fps 空转。
   * 2. **与 `S.anim` 让位仲裁并存**：用独立的 `raf`，不抢 `tween` 的名字；
   *    扫表/实时数据演示期间动画照常（它们动的是**数值**，动画动的是**装饰**，
   *    两者互不覆盖）。
   * 3. **可暂停**：`S.__animPaused` 打开时不推进时间，画布保持静止当前帧 ——
   *    编辑静态布局时不该被动画干扰。
   */
  let animPrevRaf = null;

  /** 当前设计里是否存在带 anim 的子部件（含嵌套）。没有就不启动循环 */
  function hasAnyAnim(nodes) {
    let found = false;
    (function walk(list) {
      if (found || !list) return;
      list.forEach(function (n) {
        if (found) return;
        if (n.parts) {
          (function wp(ps) {
            if (found || !ps) return;
            ps.forEach(function (p) {
              if (found) return;
              if (p.anim) { found = true; return; }
              wp(p.children);
            });
          })(n.parts);
        }
        walk(n.children);
      });
    })(nodes || (S.design && S.design.nodes) || []);
    return found;
  }

  function ensureAnimPreview() {
    const need = !S.__animPaused && hasAnyAnim(S.design && S.design.nodes);
    if (need && !animPrevRaf) {
      S.__animMs = S.__animMs || 0;
      const step = function () {
        if (S.__animPaused || !hasAnyAnim(S.design && S.design.nodes)) {
          animPrevRaf = null;
          S.__animMs = 0;          // 归零：停下时回到静态相位，不动 = 老行为
          window.draw();
          return;
        }
        S.__animMs = performance.now();
        window.draw();
        animPrevRaf = requestAnimationFrame(step);
      };
      animPrevRaf = requestAnimationFrame(step);
    } else if (!need && animPrevRaf) {
      cancelAnimationFrame(animPrevRaf);
      animPrevRaf = null;
      S.__animMs = 0;
    }
  }

  /** 暂停/恢复动画预览（编辑静态布局时用） */
  window.toggleAnimPreview = function (paused) {
    S.__animPaused = !!paused;
    ensureAnimPreview();
    window.draw();
  };

  // ================================================================ 文件读写

  window.pickFile = function () {
    const inp = document.createElement("input");    inp.type = "file";
    inp.accept = ".json,application/json";
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        // ⚠️ 「打开」是**危险操作**：它会把当前设计整个换掉（v2.83.0，Round 5）。
        // 原来这里一声不吭就替换了 —— 用户选错文件时**没有任何提示**。
        // 先验证文件，再确认替换；成功才记设计历史，草稿不能靠设计撤销找回。
        const candidate = window.validateText(String(r.result));
        if (candidate.errors.length || !candidate.design) {
          toast("文件校验失败，当前设计和 JSON 草稿已保留");
          return;
        }
        const cur = window.flatten(S.design.nodes).length;
        if ((cur > 0 || jsonDirty) && !confirmJsonReplace("打开文件",
          "打开文件会替换当前设计（" + cur + " 个控件）。画布改动可用撤销找回。")) return;
        if (!replaceDesign(candidate.design, "打开设计文件")) return;
        window.applyCanvasSize();
        validateNow();
      };
      r.onerror = () => toast("文件读取失败，当前设计和 JSON 草稿已保留");
      r.readAsText(f, "utf-8");
    };
    inp.click();
  };

  function download(filename, text) {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  window.saveFile = function () {
    const r = validateNow();
    if (r.errors.length) {
      if (!confirm("还有 " + r.errors.length + " 个硬错误，App 会拒绝加载。仍然保存？")) return;
    }
    const assetNote = (S.design.assets || []).length
      ? "\n\n⚠️ 别忘了把素材图片放到设计文件同目录的 assets/ 下：\n" +
      (S.design.assets || []).slice(0, 8).map(a => "  " + a.path).join("\n") +
      ((S.design.assets || []).length > 8 ? "\n  …" : "")
      : "";
    download((S.design.name || "design") + ".json", getVal("jsonArea"));
    toast("已保存 v2 设计文件（含控件树 / 图片 / 状态）" + assetNote);
  };

  /**
   * 导出当前画布为 **PNG 预览图**。
   *
   * 用途：发给别人看 / 存进设计文档 / 做对比。
   *
   * ⚠️ 导出前会**临时关掉选择框与网格** —— 那些是编辑辅助，不该出现在成品图里。
   */
  window.exportPng = function () {
    const cv = document.getElementById("cv");
    if (!cv) return;
    const sel = S.selection, grid = S.showGrid, marquee = S.marquee;
    S.selection = []; S.showGrid = false; S.marquee = null;
    window.draw();
    try {
      const name = (S.design.name || "design").replace(/[\\/:*?"<>|]/g, "_");
      // ⚠️ **必须兜住 SecurityError**：`file://` 下如果画布上画过
      // 「按路径加载」的图，画布会被**污染**，toDataURL 直接抛异常。
      // 内置素材已经内嵌 data URL 规避了，但用户导入的素材、
      // 或将来别的加载方式仍可能触发 —— 兜住并**说清楚原因**，
      // 比留一个控制台报错强得多。
      const url = cv.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = name + "-预览.png";
      a.click();
      toast("已导出 PNG 预览（" + cv.width + "×" + cv.height + "）");
      } catch (err) {
        if (err && err.name === "SecurityError") {
          toast("导出失败：画布被本地图片「污染」了。请把素材导入（用分类上的 ＋），不要引用本地路径");
        } else {
          toast("导出失败：" + (err && err.message ? err.message : err));
        }
        console.warn("导出 PNG 失败：", err);
    } finally {
      // 无论成功失败都要把编辑状态还原，否则用户会以为选择框"丢了"
      S.selection = sel; S.showGrid = grid; S.marquee = marquee;
      window.draw();
    }
  };

  // ================================================================ 设计包（.icarzip）

  /**
   * 把 `assets/xx.png` 这类相对路径 → 包内条目名。
   *
   * ⚠️ 与 `PackKit.normPath` 保持一致（那边是纯逻辑，这里是读字节的入口）。
   * 只在这里做一次归一化，避免"引用收集用 A 规则、写条目用 B 规则"。
   */
  function packEntryName(p) {
    return window.PackKit.normPath(p).replace(/^\/+/, "");
  }

  /** data URL / 裸 base64 → Uint8Array。解不开返回 null（**不抛**，由调用方报"读不到"） */
  function dataUrlToBytes(s) {
    if (typeof s !== "string" || !s) return null;
    const comma = s.indexOf(",");
    const isDataUrl = /^data:/i.test(s);
    if (isDataUrl && comma < 0) return null;
    const b64 = isDataUrl ? s.slice(comma + 1) : s;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
      return out;
    } catch (e) {
      return null;   // 不是 base64（比如是个普通路径串）—— 交给调用方报缺失
    }
  }

  /**
   * 读一个素材的**原始字节**。
   *
   * ## 三个来源，按可靠性排序
   *
   * 1. `rawFile` —— 用户导入时的 `File`（**唯一能拿到用户自己图片字节的途径**）
   * 2. `data`   —— 内置素材的 base64（内嵌在 `assets/builtin-data-*.js` 里）
   * 3. 内置清单里同路径的条目 —— 有些素材是 `ensureBuiltinAsset()` 登记的，
   *    它的 `data` 要等懒加载完才填上，这里再查一次清单更稳
   *
   * 读不到就**明确返回原因**（而不是给个空字节）—— 空字节会进包、CRC 也对，
   * 但设备上就是一张坏图，那种失败方式最难查。
   */
  async function readAssetBytes(ref) {
    const d = S.design || {};
    const list = d.assets || [];
    const norm = window.PackKit.normPath;
    const a = (ref.assetId ? list.find(x => x.id === ref.assetId) : null)
      || list.find(x => norm(x.path) === norm(ref.path))
      || null;

    const sizeOf = function (b) {
      return { bytes: b, w: (a && a.w) || 0, h: (a && a.h) || 0 };
    };

    if (a && a.rawFile && typeof a.rawFile.arrayBuffer === "function") {
      const buf = await a.rawFile.arrayBuffer();
      return sizeOf(new Uint8Array(buf));
    }

    let bytes = a ? dataUrlToBytes(a.data) : null;
    if (bytes) return sizeOf(bytes);

    const b = (window.BUILTIN_ASSETS || []).concat(window.NEXT_LIBRARY ? window.NEXT_LIBRARY.assets : [])
      .find(x => norm(x.path) === norm(ref.path));
    bytes = b ? dataUrlToBytes(b.data) : null;
    if (bytes) return { bytes: bytes, w: (b && b.w) || (a && a.w) || 0, h: (b && b.h) || (a && a.h) || 0 };

    return {
      missing: a
        ? ("工具里只有它的缩略图（" + (a.name || ref.path) +
           "）—— 字节来自你导入时选的文件，重开工具后就不再持有。请重新导入一次再导包")
        : "设计文件里引用了它，但 assets 清单里没有这个素材（请先在素材库里导入）",
    };
  }

  /** 二进制下载。与文本版的 download() 分开 —— Blob 类型不同，别混用 */
  function downloadBytes(filename, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /**
   * **导出设计包（.icarzip）** —— 把设计文件与它引用到的素材打成一个文件。
   *
   * ## 它治的是什么病
   *
   * 设计文件里的素材是**相对路径**，而 App 侧导入走 SAF **单文件** ——
   * 拿不到旁边的 `assets/`，于是 `designBaseDir` 永远为空 →
   * **所有素材加载失败** → 控件拼出来的表盘只剩空卡片
   * （用户报的"画布不显示我做好的内容、显示是空的"，见 docs/CHANGELOG v1.20.3）。
   *
   * 有了包，App 侧只要**解开这一个文件**就能拿到全部素材。
   *
   * ## ⚠️ 端到端**还没通**
   *
   * **App 侧的导入这一轮没做**（那是 app 模块，本轮由另一个 agent 在改）。
   * 现在导出的包只有工具自己读得回来（自检套件 `verify-pack`）。
   * 这一点在 README 与 CHANGELOG 里都写明了 —— 不要以为已经能用。
   *
   * ## 导出前先自检
   *
   * 包**造出来之后立刻用 `ZipKit.verifyZip` 读回来**核一遍（条目数 / 字节数 / CRC）。
   * 为什么要"自己验自己"：zip 的偏移或 CRC 写错了，**用户是解压时才知道**，
   * 而那时他已经在设备前面了。这里多花几毫秒，能挡掉整类"包是坏的"。
   * 顺带把结果放在 `window.__lastPackReport` 上 —— 自检套件读它。
   */
  window.exportPackage = async function () {
    if (!window.ZipKit || !window.PackKit) {
      toast("设计包模块没加载（js/zip.js、js/pack.js）—— 请确认 index.html 是最新的");
      return;
    }
    const r = validateNow();
    if (r.errors.length) {
      if (!confirm("还有 " + r.errors.length + " 个硬错误，App 会拒绝加载。仍然导出设计包？")) return;
    }

    const designJson = window.toV2Json(S.design);
    const built = await window.PackKit.buildPackage({
      design: S.design,
      designJson: designJson,
      now: new Date().toISOString(),
      crc32: window.ZipKit.crc32,
      readBytes: readAssetBytes,
    });

    // 条目名必须是设计里的相对路径 —— 这样解压后的目录结构
    // 与 design.json 里的引用**天然一致**
    const entries = built.entries.map(e => ({ name: packEntryName(e.name), data: e.data }));

    let zip = null;
    try {
      zip = window.ZipKit.buildZip(entries);
    } catch (e) {
      toast("打包失败：" + ((e && e.message) || e));
      return;
    }

    // ---- 导出后自检（读回来核 条目数 / 字节数 / CRC）
    const expect = built.entries.map(e => ({
      name: packEntryName(e.name),
      size: (typeof e.data === "string" ? window.ZipKit.utf8(e.data) : e.data).length,
      crc: window.ZipKit.crc32(typeof e.data === "string" ? window.ZipKit.utf8(e.data) : e.data),
    }));
    const check = window.ZipKit.verifyZip(zip.bytes, expect);

    window.__lastPackReport = {
      ok: check.ok,
      problems: check.problems,
      counts: {
        entries: check.entries.length,
        assets: built.manifest.assets.length,
        missing: built.manifest.missing.length,
      },
      names: check.entries.map(e => e.name),
      zipBytes: zip.bytes.length,
      manifest: built.manifest,
    };
    /**
     * 最近一次导出的 zip 字节（base64）。
     *
     * ⚠️ **只给自检套件用**，不是产品功能 —— `verify-pack.js` 要拿**真正
     * 走完整条导出路径**的那份字节去 Node 侧独立解析。测试里"照着重造一份"
     * 是不算数的：那样测的是重造的那份，而不是用户拿到的那份。
     *
     * 大包会在内存里多留一份 base64（约 1.33 倍），可接受 —— 只在点过
     * 「📦 设计包」之后才有。
     */
    window.__lastPackB64 = (function () {
      let s = "";
      const CH = 0x8000;   // 分块，避免 apply 参数过多
      for (let i = 0; i < zip.bytes.length; i += CH) {
        s += String.fromCharCode.apply(null, zip.bytes.subarray(i, i + CH));
      }
      return btoa(s);
    })();

    const name = window.PackKit.packageFileName(S.design.name);
    downloadBytes(name, zip.bytes, "application/zip");

    if (!check.ok) {
      // 自检不过**照样把包给用户**（他可能想自己看看），但必须**明说它有问题**
      alert("设计包已导出，但自检没通过（请把这个截图发出来）：\n\n" +
        check.problems.slice(0, 8).join("\n"));
      return;
    }

    const miss = built.manifest.missing;
    toast("已导出 " + name + "：" + built.manifest.assets.length + " 个素材 · " +
      check.entries.length + " 个条目 · " + Math.round(zip.bytes.length / 1024) + " KB" +
      (miss.length ? " · ⚠️ " + miss.length + " 个素材没进包" : "") +
      "（App 侧导入待做）");
    if (miss.length) {
      alert("有 " + miss.length + " 个被引用的素材没能进包：\n\n" +
        miss.slice(0, 6).map(m => "· " + m.path + "\n  " + m.reason).join("\n") +
        (miss.length > 6 ? "\n…" : ""));
    }
  };

  /** 导出 v1：App 当前版本能直接读（丢掉图片/文字/分组/旋转） */
  window.exportV1 = function () {
    const r = validateNow();
    if (r.errors.length) { alert("还有硬错误，先修好再导出。"); return; }
    const out = window.toV1Json(S.design);
    if (out.count === 0) { alert("没有可导出的仪表节点（v1 只支持仪表）。"); return; }
    const lost = out.lost;
    const lostList = [];
    if (lost.image) lostList.push(lost.image + " 个图片控件");
    if (lost.text) lostList.push(lost.text + " 个文字控件");
    if (lost.group) lostList.push(lost.group + " 个分组");
    if (lost.rotation) lostList.push(lost.rotation + " 个旋转");
    if (lost.scale) lostList.push(lost.scale + " 个缩放");
    if (lost.alpha) lostList.push(lost.alpha + " 个非全不透明");
    const warn = lostList.length
      ? "\n\n⚠️ v1 表达不了以下内容，会被丢掉：\n  " + lostList.join("\n  ")
      : "";
    if (!confirm("导出 v1（" + out.count + " 个仪表）。\n\n" +
      "v1 是 App 当前版本能直接读的格式，但没有图片/状态/分组/变换。" + warn +
      "\n\n继续？")) return;
    download((S.design.name || "design") + "-v1.json", out.json);
    toast("已导出 v1（" + out.count + " 个仪表）");
  };

  // ================================================================ 预设布局

  window.applyPreset = function (name) {
    const P = window.PRESETS || {};
    const fn = P[name];
    if (!fn) return;
    const cur = window.flatten(S.design.nodes).length;
    if ((cur || jsonDirty) && !confirmJsonReplace("套用预设", "会替换当前全部 " + cur + " 个控件。")) return;
    const assets = S.design.assets;
    const candidate = Object.assign({}, S.design);
    candidate.nodes = fn();
    if (!replaceDesign(candidate, "套用预设：" + name)) return;
    // 套用预设只换控件；保留导入图片的 File 等内存数据，快照不能序列化它们。
    S.design.assets = assets;
    window.applyCanvasSize();
  };

  // ================================================================ 提示

  let toastTimer = null;
  function toast(text) {
    const t = el("toast");
    if (!t) return;
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }
  window.toast = toast;

  // ================================================================ 启动

  function blankDesign() {
    const d = window.createDesign({ name: "未命名设计" });
    d.nodes = window.PRESETS["1big4small"]();
    return d;
  }

  function init() {
    // 面板折叠状态与高度是**持久的** —— 用户调过一次就该记住
    if (window.loadPanelState) window.loadPanelState();
    // 分类顺序与自定义分类也要读回 —— 不读的话每次打开都回到出厂顺序
    if (window.loadAssetKinds) window.loadAssetKinds();
    // ⚠️ **先建 design**，再做界面接线。这样即使接线里某个元素缺失抛异常，
    // 画布与面板仍然有数据可用（第一版顺序反了，一个缺 id 就让整个工具瘫掉）。
    S.design = blankDesign();
    undo.reset(snapshot(), "初始");

    // 界面接线：每块独立 try/catch，互不牵连
    const steps = [
      ["界面主题", function () {
        let saved = "dark";
        try { saved = localStorage.getItem("studio.theme") || "dark"; } catch (e) { }
        window.toggleTheme(saved, true);   // 启动时静默恢复，不弹提示
      }],
      ["面板折叠状态", function () { restorePanels(); }],
      ["PID 标签开关", function () {
        let on = false;
        try { on = localStorage.getItem("studio.showPid") === "1"; } catch (e) { }
        S.showPid = false;                       // 先置 false，让 toggle 真的翻转
        if (on) window.togglePidLabel();
        else {
          const b = el("btnPid");
          if (b) b.textContent = "数据标识 关";
        }
      }],
      ["下拉框", function () {
        const sm = el("scaleMode");
        if (sm && !sm.options.length) {
          window.SCALE_MODES.forEach(m => {
            const o = document.createElement("option");
            o.value = String(m.v); o.textContent = m.n; o.title = m.d;
            sm.appendChild(o);
          });
        }
        const bf = el("bgFit");
        if (bf && !bf.options.length) {
          window.FIT_NAMES.forEach((n, i) => {
            const o = document.createElement("option");
            o.value = String(i); o.textContent = i + " · " + n;
            bf.appendChild(o);
          });
        }
      }],
      ["同步 JSON", function () { syncJson(); }],
      ["素材缩略图", function () { window.restoreThumbs(); }],
      ["画布尺寸", function () { window.applyCanvasSize(); }],
      ["面板", function () { refreshAll(); }],
      ["校验", function () { validateNow(); }],
      ["撤销按钮", function () { updateUndoButtons(); }],
      ["差异清单", function () { window.renderDiff && window.renderDiff(); }],
      ["键盘快捷键", function () { bindKeys(); }],
    ];
    const failed = [];
    steps.forEach(function (pair) {
      try { pair[1](); } catch (e) {
        failed.push(pair[0] + "：" + e.message);
        console.error("[studio] 初始化步骤失败 —— " + pair[0], e);
      }
    });
    if (failed.length) {
      toast("有 " + failed.length + " 个初始化步骤失败：\n" + failed.join("\n"));
    }

    const sb = el("btnSnap");
    if (sb) sb.classList.add("on");
    toast("提示：Ctrl+Z 撤销 · Ctrl+D 复制 · Ctrl+A 全选 · 方向键微调 · Shift 加选");
  }

  function bindKeys() {
    document.addEventListener("keydown", ev => {
      const tag = (ev.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      if (ctrl && ev.key.toLowerCase() === "z" && !ev.shiftKey) { ev.preventDefault(); window.doUndo(); return; }
      if (ctrl && (ev.key.toLowerCase() === "y" || (ev.key.toLowerCase() === "z" && ev.shiftKey))) {
        ev.preventDefault(); window.doRedo(); return;
      }
      if (ctrl && ev.key.toLowerCase() === "d") { ev.preventDefault(); window.dupSelected(); return; }
      if (ctrl && ev.key.toLowerCase() === "g") {
        ev.preventDefault();
        if (ev.shiftKey) window.ungroupSelected(); else window.groupSelected();
        return;
      }
      if (ctrl && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        S.selection = window.flatten(S.design.nodes).map(n => n.id);
        window.onSelectionChanged();
        return;
      }
      // F2：打开控件编辑器（和右键「编辑控件…」同一个入口）
      if (ev.key === "F2" && S.selection.length === 1) {
        ev.preventDefault();
        window.openControlEditor(S.selection[0]);
        return;
      }
      if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); window.delSelected(); return; }
      if (ev.key === "Escape") {
        // 模态框开着就先关它，别把选择也清了
        const m = document.getElementById("ctrlEditor");
        if (m && m.classList.contains("show")) { window.closeControlEditor(); return; }
        // 在分组里 → 先退出一层（而不是直接清选择）。这是"进入/退出"最自然的按键
        if (window.drillExit && window.drillExit()) return;
        S.selection = [];
        window.onSelectionChanged();
        return;
      }
      // 方向键微调（Shift = 1 单位）
      if (ev.key.indexOf("Arrow") === 0 && S.selection.length) {
        ev.preventDefault();
        const step = ev.shiftKey ? 1 : window.STEP;
        const dx = ev.key === "ArrowLeft" ? -step : ev.key === "ArrowRight" ? step : 0;
        const dy = ev.key === "ArrowUp" ? -step : ev.key === "ArrowDown" ? step : 0;
        window.commit(() => {
          S.selection.forEach(id => {
            const n = window.findNode(S.design.nodes, id);
            if (!n || n.locked) return;
            n.x = window.clamp(n.x + dx, 0, Math.max(0, window.CANVAS - n.w));
            n.y = window.clamp(n.y + dy, 0, Math.max(0, window.CANVAS - n.h));
          });
        }, "微调", "nudge");
        window.draw();
      }
    });
  }

  /* P2B：应用就绪 → 显式触发 Catalog 构建（首选路径，替代盲轮询）。
   ⚠️ 不能重写 init —— 它是函数声明（function init(){}），赋值会被忽略（实测导致 init 不跑）。
   所以用包装函数：跑完 init 再通知 Catalog。 */
function bootAfterInit() {
  try {
    init();
  } finally {
    window.__ICAR_APP_READY = true;
    var C = window.ICAR && window.ICAR.registry && window.ICAR.registry.Catalog;
    if (C && typeof C.onAppReady === "function") {
      try { C.onAppReady(); } catch (e) { /* 诊断留在 Catalog.diagnose() */ }
    }
  }
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootAfterInit);
else bootAfterInit();

  // ================================================================ 素材数据懒加载（v2.30.0）
  //
  // ## 为什么
  //
  // `builtin-index.js` 只有 **36 KB**（元数据），11 个分类的数据文件合计 **~700 KB**。
  // 静态全加载意味着**首屏要等那 700 KB 解析完**才能在素材库里看到任何东西。
  //
  // 现在：索引先到 → 界面立刻能渲染出全部分类与缩略图位置；
  // 数据在首屏之后按分类一个个注入，每到一个就刷新一次。
  //
  // ## 串行 + 空闲时加载
  //
  // 并行注入 11 个脚本会瞬间占满主线程（每个都要解析 base64）。
  // 串行 + `requestIdleCallback` 让它在浏览器空闲时慢慢来，不卡交互。
  //
  // ## 测试怎么等
  //
  // 全部加载完会置 `window.BUILTIN_DATA_DONE = true`，
  // 各测试套件的 `waitReady()` 会等这个标志 —— 否则它们会拿到没有 data 的素材，
  // 然后在"缩略图能不能解码"这类断言上失败。
  //
  // ## 失败也不卡住
  //
  // 某个文件 404 / 解析失败 → **跳过它继续下一个**，最后照样置 DONE。
  // 那些素材的 path 仍然有效（App 侧照样能读），只是工具里没有内嵌预览。
  window.BUILTIN_DATA_DONE = false;
  (function loadAssetData() {
    const KINDS = ["background", "dashboard", "needle", "scale", "icon",
                   "turn", "warning", "brand", "decor", "bar", "frame"];
    let idx = 0;
    function next() {
      if (idx >= KINDS.length) { window.BUILTIN_DATA_DONE = true; return; }
      const kind = KINDS[idx++];
      const s = document.createElement("script");
      s.src = "assets/builtin-data-" + kind + ".js";
      s.onload = function () {
        try { window.syncAssetImages && window.syncAssetImages(); } catch (e) {}
        try { window.renderAssets && window.renderAssets(); } catch (e) {}
        next();
      };
      s.onerror = function () { next(); };   // 跳过，继续
      document.head.appendChild(s);
    }
    if (window.requestIdleCallback) window.requestIdleCallback(function () { next(); }, { timeout: 1500 });
    else setTimeout(next, 200);
  })();
})();
