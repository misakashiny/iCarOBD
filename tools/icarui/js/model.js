/* ==========================================================================
   model.js —— 节点模型：树操作 / 变换矩阵 / 序列化 / 撤销重做
   --------------------------------------------------------------------------
   设计见 docs/主题设计大纲.md §二。

   三层职责分开：
     1. 树结构（父子、增删、重排）
     2. 变换（x/y/w/h + rotation/scale/alpha + 世界矩阵）
     3. 序列化（v2 读写 + v1 导出）

   ⚠️ 变换的语义必须与 App 侧一致（大纲 §2.3）：
     x/y 相对父节点；rotation 绕**自身中心**；scale 是 w/h 之上的**额外**倍率。
   ========================================================================== */
"use strict";

(function () {
  let seq = 0;

  /** 生成节点 id。带前缀便于肉眼区分，且不依赖时间戳（避免同一毫秒重复） */
  function newId(prefix) {
    seq++;
    return (prefix || "n") + seq.toString(36) + Math.random().toString(36).slice(2, 5);
  }
  window.newId = newId;

  // ================================================================ 节点构造

  /**
   * 建一个节点。默认值刻意"无害"：不透明、不旋转、不缩放、不锁定、可见、z=0。
   */
  function createNode(type, opts) {
    const o = opts || {};
    const base = {
      id: o.id || newId(type === window.NODE_GROUP ? "g" : "n"),
      type: type,
      name: o.name || defaultName(type),
      x: num(o.x, 0), y: num(o.y, 0),
      w: num(o.w, 120), h: num(o.h, 120),
      rotation: num(o.rotation, 0),
      scale: num(o.scale, 1),
      alpha: clampInt(o.alpha === undefined ? 255 : o.alpha, 0, 255),
      z: num(o.z, 0),
      locked: !!o.locked,
      visible: o.visible === undefined ? true : !!o.visible,
      children: [],
    };
    if (type === window.NODE_GAUGE) {
      // ⚠️ **必须把别名解析成 PID id**，并同时保留原样写法 —— 与 `parseNode` 一致。
      //
      // 踩过的坑：第一版这里直接 `pid: o.pid`（存的是别名 `obd.rpm`），
      // 而 `parseNode` 存的是解析后的 `std_0C`。于是**同一个 PID 有两种内部表示**：
      //
      // | | 编辑器预设建的 | 从文件读进来的 |
      // |---|---|---|
      // | `pid` | `obd.rpm` | `std_0C` |
      // | `BUILTIN_PIDS[pid]` | ❌ 查不到 | ✅ 发动机转速 |
      // | 画布标签 | `obd.rpm` | `发动机转速` |
      //
      // 表现就是"预设建的表画布上写着 obd.rpm，导入的表写着发动机转速"。
      // 所以这里统一：`pid` = 解析后的 id（内部只用它做查表），
      // `rawPid` = 用户写的原样（编辑器回显 + 序列化时写回别名）。
      const rawPid = o.rawPid || o.pid || "obd.rpm";
      Object.assign(base, {
        pid: window.resolvePid(rawPid),
        rawPid: rawPid,
        style: num(o.style, 0),
        min: num(o.min, 0),
        max: num(o.max, 100),
        warnLow: o.warnLow === undefined ? null : o.warnLow,
        warnHigh: o.warnHigh === undefined ? null : o.warnHigh,
        extraPids: o.extraPids || [],
        ringStyle: num(o.ringStyle, 0),
        ringSegments: num(o.ringSegments, 40),
        neonPreset: o.neonPreset || null,
        cardStyle: o.cardStyle === undefined ? null : o.cardStyle,
        // 数值 → 文字 映射表（P9 方向 A）。null = 不用映射（读数按量程格式化）。
        // ⚠️ 空表要归一成 null —— 否则 `["",""]` 会让读数变成空字符串
        valueLabels: window.normalizeValueLabels(o.valueLabels),
        // **子部件**：有它就不再走程序化绘制，而是按部件拼装（v2.12.0）。
        // 空数组 = 用 style 的程序化画法（默认），行为完全不变。
        parts: (o.parts && o.parts.length) ? o.parts.map(window.normalizePart) : null,
        // 底框细粒度覆盖（透明度 / 圆角 / 显示）—— null 表示跟随主题
        card: o.card ? {
          show: o.card.show === undefined ? true : !!o.card.show,
          alpha: o.card.alpha === undefined ? null : o.card.alpha,
          radius: o.card.radius === undefined ? null : o.card.radius,
        } : null,
        // 表上的文字（名字 / PID / 量程）也归字体管
        labelFont: window.normalizeFont(o.labelFont),
        showLabel: o.showLabel === undefined ? true : !!o.showLabel,
        showRange: o.showRange === undefined ? true : !!o.showRange,
      });
    } else if (type === window.NODE_IMAGE) {
      // `statePid` 同理：内部查表要用 id，回显用别名
      const rawState = o.rawStatePid || o.statePid || "";
      Object.assign(base, {
        assetId: o.assetId || "",
        statePid: rawState ? window.resolvePid(rawState) : "",
          // 状态阈值。**null = 从 PID 库推断**（默认），显式设了就听显式的 ——
          // 否则用户改不了「多少度算警告」，而不同车/不同传感器的报警线本来就不一样
          stateWarn: (o.stateWarn === undefined || o.stateWarn === null) ? null : o.stateWarn,
          stateCritical: (o.stateCritical === undefined || o.stateCritical === null) ? null : o.stateCritical,
        rawStatePid: rawState,
        states: o.states || null,     // null = 不启用状态系统
      });
    } else if (type === window.NODE_TEXT) {
      Object.assign(base, {
        text: o.text === undefined ? "文字" : o.text,
        // 字体统一收进一个对象 —— 属性面板、编辑器、App 都只处理一个结构
        font: window.normalizeFont(o.font),
      });
    }
    return base;
  }
  window.createNode = createNode;

  function defaultName(type) {
    if (type === window.NODE_GROUP) return "分组";
    if (type === window.NODE_IMAGE) return "图片";
    if (type === window.NODE_TEXT) return "文字";
    return "仪表";
  }

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(num(v, lo)))); }
  window.num = num;

  // ================================================================ 树操作

  /** 深度优先遍历。回调返回 false 可跳过该节点的子树 */
  function walk(nodes, fn, parent) {
    for (const n of nodes) {
      if (fn(n, parent) === false) continue;
      if (n.children && n.children.length) walk(n.children, fn, n);
    }
  }
  window.walk = walk;

  /** 展平成数组（渲染与命中测试都按"后画在上"的顺序） */
  // ================================================================ 多页面

  /** 当前页对象 */
  function currentPage(d) {
    const dd = d || (window.CanvasState && window.CanvasState.design);
    if (!dd || !dd.pages || !dd.pages.length) return null;
    return dd.pages[Math.min(dd.pageIndex || 0, dd.pages.length - 1)];
  }
  window.currentPage = currentPage;

  /**
   * 切到第 i 页。
   *
   * **先把当前数组写回当前页**（虽然它们本来就是同一个引用，但显式写一次
   * 能防止将来有人改了 `design.nodes` 的赋值方式而这里忘了跟）——
   * 然后把 `design.nodes` 换成目标页的数组。
   */
  function switchPage(d, i) {
    const dd = d || (window.CanvasState && window.CanvasState.design);
    if (!dd || !dd.pages) return false;
    const idx = Math.max(0, Math.min(i, dd.pages.length - 1));
    if (idx === dd.pageIndex) return false;
    dd.pages[dd.pageIndex].nodes = dd.nodes;
    dd.pageIndex = idx;
    dd.nodes = dd.pages[idx].nodes;
    return true;
  }
  window.switchPage = switchPage;

  /** 加一页（返回新页的索引） */
  function addPage(d, name) {
    const dd = d || (window.CanvasState && window.CanvasState.design);
    if (!dd) return -1;
    if (!dd.pages) dd.pages = [{ id: "pg0", name: "主页面", nodes: dd.nodes || [] }];
    dd.pages.push({
      id: newId("pg"),
      name: name || ("页面 " + (dd.pages.length + 1)),
      nodes: [],
    });
    return dd.pages.length - 1;
  }
  window.addPage = addPage;

  /** 删一页。**最后一页不能删** —— 没有页面的设计没法编辑 */
  function removePage(d, i) {
    const dd = d || (window.CanvasState && window.CanvasState.design);
    if (!dd || !dd.pages) return false;
    if (dd.pages.length <= 1) return false;
    dd.pages.splice(i, 1);
    if (dd.pageIndex >= dd.pages.length) dd.pageIndex = dd.pages.length - 1;
    dd.nodes = dd.pages[dd.pageIndex].nodes;
    return true;
  }
  window.removePage = removePage;

  function flatten(nodes) {
    const out = [];
    walk(nodes, n => { out.push(n); });
    return out;
  }
  window.flatten = flatten;

  function findNode(nodes, id) {
    let hit = null;
    walk(nodes, n => { if (n.id === id) { hit = n; return false; } });
    return hit;
  }
  window.findNode = findNode;

  function findParent(nodes, id, parent) {
    for (const n of nodes) {
      if (n.id === id) return parent || null;
      if (n.children && n.children.length) {
        const r = findParent(n.children, id, n);
        if (r !== undefined && r !== null) return r;
        // 注意：r 为 null 表示"找到了但父级是根"，要与"没找到"区分
        if (n.children.some(c => c.id === id)) return n;
      }
    }
    return null;
  }
  window.findParent = findParent;

  /** 从根到该节点的路径（含自身），用于控件树展开 */
  function pathTo(nodes, id, acc) {
    const trail = acc || [];
    for (const n of nodes) {
      if (n.id === id) return trail.concat([n]);
      if (n.children && n.children.length) {
        const r = pathTo(n.children, id, trail.concat([n]));
        if (r) return r;
      }
    }
    return null;
  }
  window.pathTo = pathTo;

  /** 同级容器（用于"置顶/置底"与排序） */
  function siblingsOf(nodes, id) {
    const p = findParent(nodes, id);
    return p ? p.children : nodes;
  }
  window.siblingsOf = siblingsOf;

  function addNode(nodes, node, parentId) {
    if (parentId) {
      const p = findNode(nodes, parentId);
      if (p) { p.children.push(node); return node; }
    }
    nodes.push(node);
    return node;
  }
  window.addNode = addNode;

  function removeNodes(nodes, ids) {
    const set = new Set(ids);
    function rec(list) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (set.has(list[i].id)) { list.splice(i, 1); continue; }
        if (list[i].children) rec(list[i].children);
      }
    }
    rec(nodes);
  }
  window.removeNodes = removeNodes;

  /** 改父子关系。拒绝把节点挂到自己的子孙下（会形成环） */
  /** 找某个节点的父节点（根节点返回 null） */
  function findParent(nodes, id) {
    let found = null;
    walk(nodes, (n, parent) => { if (n.id === id) found = parent; });
    return found;
  }
  window.findParent = findParent;

  /**
   * 两个节点是否**同层**（同一个父级）。
   *
   * 界面用它决定"拖到行上/下缘时该不该显示插入提示" ——
   * 跨层拖拽只能"成为子节点"，没有"插到它前面"这回事。
   */
  function canReorderSameLevel(nodes, aId, bId) {
    if (aId === bId) return false;
    const pa = findParent(nodes, aId);
    const pb = findParent(nodes, bId);
    // 都是根节点 → 同层；同一个父节点 → 同层
    return (pa ? pa.id : null) === (pb ? pb.id : null);
  }
  window.canReorderSameLevel = canReorderSameLevel;

  /**
   * **同层重排**：把 `id` 插到 `targetId` 的前面或后面。
   *
   * 与 reparent 的区别：reparent 改的是**父子关系**，这个只改**同一层里的顺序**。
   * 原来拖拽只能改父子关系，用户没法把"第 3 个控件挪到第 1 个" ——
   * 而调整叠放顺序恰恰是最常用的操作之一。
   *
   * @param after true = 插到 target 之后，false = 之前
   */
  function reorderSibling(nodes, id, targetId, after) {
    if (id === targetId) return false;
    const srcParent = findParent(nodes, id);
    const dstParent = findParent(nodes, targetId);
    const srcList = srcParent ? srcParent.children : nodes;
    const dstList = dstParent ? dstParent.children : nodes;
    // **只在同一层里重排** —— 跨层是 reparent 的职责
    if (srcList !== dstList) return false;

    const from = srcList.findIndex(n => n.id === id);
    if (from < 0) return false;
    const moved = srcList.splice(from, 1)[0];
    let to = srcList.findIndex(n => n.id === targetId);
    if (to < 0) { srcList.splice(from, 0, moved); return false; }   // 回滚
    if (after) to += 1;
    srcList.splice(to, 0, moved);
    return true;
  }
  window.reorderSibling = reorderSibling;

  /**
   * 把每一层的 z 归一化成 0..n-1（按当前数组顺序）。
   *
   * **重排之后必须调它** —— 否则"数组顺序变了但 z 没变"，
   * 而画布是按 z 画的，用户会看到"控件树里动了、画布上没动"。
   */
  function normalizeZ(nodes) {
    (nodes || []).forEach((n, i) => {
      n.z = i;
      if (n.children && n.children.length) normalizeZ(n.children);
    });
  }
  window.normalizeZ = normalizeZ;

  function reparent(nodes, id, newParentId) {
    if (id === newParentId) return false;
    const node = findNode(nodes, id);
    if (!node) return false;
    if (newParentId) {
      const target = findNode(nodes, newParentId);
      if (!target) return false;
      // 目标在自己的子树里 → 会成环
      let isDescendant = false;
      walk([node], n => { if (n.id === newParentId) isDescendant = true; });
      if (isDescendant) return false;
    }
    removeNodes(nodes, [id]);
    addNode(nodes, node, newParentId);
    return true;
  }
  window.reparent = reparent;

  /** 同层按 z 升序（小者先画 = 在下）。**渲染与序列化都用这个顺序** */
  function sortByZ(list) {
    return list.slice().sort((a, b) => (num(a.z, 0) - num(b.z, 0)));
  }
  window.sortByZ = sortByZ;

  function bringToFront(nodes, id) {
    const sibs = siblingsOf(nodes, id);
    const maxZ = sibs.reduce((m, n) => Math.max(m, num(n.z, 0)), 0);
    const n = findNode(nodes, id);
    if (n) n.z = maxZ + 1;
  }
  window.bringToFront = bringToFront;

  function sendToBack(nodes, id) {
    const sibs = siblingsOf(nodes, id);
    const minZ = sibs.reduce((m, n) => Math.min(m, num(n.z, 0)), 0);
    const n = findNode(nodes, id);
    if (n) n.z = minZ - 1;
  }
  window.sendToBack = sendToBack;

  /** 深拷贝（撤销快照与"复制"都用） */
  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  window.clone = clone;

  // ================================================================ 打组 / 取消组合

  /**
   * 检查一个节点是否可以安全地移动父级（打组/取消组合的前提）。
   *
   * **为什么需要这个检查**：节点的 x/y 是**相对父节点**的。把节点从一个父级
   * 挪到另一个父级时，如果原父级带旋转或缩放，节点的视觉位置会变。
   * 而"打组不该让东西跳位置"是最基本的预期。
   *
   * 祖先全是纯平移（rotation=0、scale=1）时，换父级是**精确**的：
   * 只差一个平移量。
   */
  function ancestorsArePlain(nodes, id) {
    const chain = pathTo(nodes, id);
    if (!chain) return false;
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i];
      if (Math.abs(num(a.rotation, 0)) > 0.01) return false;
      if (Math.abs(num(a.scale, 1) - 1) > 0.001) return false;
    }
    return true;
  }
  window.ancestorsArePlain = ancestorsArePlain;

  /**
   * 打组的**前提检查**（不改任何东西）。
   *
   * 单独抽出来是为了让调用方"先问能不能，再决定要不要提交" ——
   * 否则失败时会往撤销栈里压一条空操作（用户按撤销会看到"什么都没变"）。
   */
  /**
   * 按子控件的名字拼一个分组名。
   *
   * 2 个 → "转速 + 车速"
   * 3 个 → "转速 + 车速 等 3 项"
   * 再多 → "5 个控件"
   *
   * 名字太长也没意义 —— 控件树一行放不下，反而更难认。
   */
  function autoGroupName(names) {
    const list = names.filter(n => n && n.trim());
    if (!list.length) return "分组";
    if (list.length === 1) return list[0];
    if (list.length === 2) return list[0] + " + " + list[1];
    if (list.length <= 4) return list.slice(0, 2).join(" + ") + " 等 " + list.length + " 项";
    return list.length + " 个控件";
  }
  window.autoGroupName = autoGroupName;

  function groupCheck(nodes, ids) {
    const list = ids.map(id => findNode(nodes, id)).filter(Boolean);
    const unlocked = list.filter(n => !n.locked);
    if (unlocked.length < 2) {
      return { ok: false, reason: "至少要选 2 个未锁定的控件（锁定的不参与打组）" };
    }
    const bad = unlocked.filter(n => !ancestorsArePlain(nodes, n.id));
    if (bad.length) {
      return {
        ok: false,
        reason: "有 " + bad.length + " 个控件在旋转或缩放过的分组里（" +
          bad.map(n => n.name).slice(0, 3).join("、") +
          "）。请先对那个分组「取消组合」，再重新打组。",
      };
    }
    return { ok: true, count: unlocked.length };
  }
  window.groupCheck = groupCheck;

  /**
   * 把一组节点打成一个分组。
   *
   * - 分组的位置/尺寸 = 选中项的**并集包围盒**（0..360 空间）
   * - 组建成时 **rotation=0、scale=1**（纯平移），所以子节点只差一个平移量，
   *   视觉位置**完全不变**
   * - 之后拖动组 = 同时拖动全部子节点（因为子坐标相对组）
   *
   * @return {ok, node, reason} —— 不满足前提时 ok=false 并给原因
   */
  function groupNodes(nodes, ids, opts) {
    const o = opts || {};
    const chk = groupCheck(nodes, ids);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    const list = ids
      .map(id => findNode(nodes, id))
      .filter(n => n && !n.locked);

    // 并集包围盒
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const infos = list.map(n => {
      const wb = worldBounds(nodes, n.id);
      x0 = Math.min(x0, wb.x); y0 = Math.min(y0, wb.y);
      x1 = Math.max(x1, wb.x + wb.w); y1 = Math.max(y1, wb.y + wb.h);
      return { n: n, wb: wb, parent: findParent(nodes, n.id) };
    });
    // 留一点内边距，组框不至于贴着子控件
    const pad = Math.max(2, Math.min(x1 - x0, y1 - y0) * 0.04);
    const gx = x0 - pad, gy = y0 - pad;
    const gw = (x1 - x0) + pad * 2, gh = (y1 - y0) + pad * 2;

    const topZ = nodes.reduce((m, n) => Math.max(m, num(n.z, 0)), 0) + 1;
    // 自动命名：用子控件的名字拼一个有意义的名字，而不是清一色「分组」。
    // 用户在一堆「分组」里根本认不出哪个是哪个。
    const autoName = o.name || autoGroupName(list.map(n => n.name));
    const g = createNode(NODE_GROUP, {
      name: autoName,
      x: gx, y: gy, w: gw, h: gh,
      z: topZ,
    });

    // 摘出来 → 坐标改成相对组（组是纯平移，所以只减一个原点）
    infos.forEach(it => {
      removeNodes(nodes, [it.n.id]);
      it.n.x = it.wb.x - gx;
      it.n.y = it.wb.y - gy;
      g.children.push(it.n);
    });
    nodes.push(g);
    return { ok: true, node: g };
  }
  window.groupNodes = groupNodes;

  /**
   * 取消组合：把组里的子节点还原到组的父级，**保持视觉位置**。
   *
   * ## 位置公式（用"形状重合"推的，别凭直觉改）
   *
   * 记 `R(P,θ)` = 绕点 P 转 θ，`lm = localMatrix(组)`，`X` = 子控件中心
   * （经 `lm` 映射到父空间的位置），`B` = 组中心。
   *
   * - **在组里**：形状 = "S 绕 B 转 φ"（S 是子盒子，φ 是组旋转）
   * - **取消组合后**：形状 = "S' 绕自身中心 X' 转 (r+φ)"
   *
   * 两边旋转角与尺寸都一样，所以只要**中心相同**就重合：
   * `X' = R(B, φ)(X)`，然后 `r' = r + φ`、`scale' = scale · gs`。
   *
   * ## ⚠️ 这个旋转必须在**设备空间**做（踩过一次，差 23.7px）
   *
   * 组的旋转是在**设备空间**施加的（`withDeviceRotation`，与 App 的 `view.rotation` 一致）。
   * 而画布矩阵 `C` 在 `stretch` 模式下**非等比**，所以
   *
   * ```
   * C( 绕 gc 转 φ )  ≠  绕 C(gc) 转 φ        ← 两者不相等！
   * ```
   *
   * 第一版直接在父空间（0..360）绕组中心转，结果**父空间中心算得完全正确、
   * 设备空间却偏 23.7px**（实测 x 对、y 差 23.7）。
   * 正确做法：`父空间 → 设备 → 绕组中心(设备) 转 φ → 转回父空间`。
   *
   * @param C 画布矩阵（`nodeToCanvasMatrix()`）。缺省则退化为"父空间直接转"，
   *          仅在等比缩放下才正确 —— 所以调用方**应该传**
   */
  function ungroupNode(nodes, id, C) {
    const g = findNode(nodes, id);
    if (!g) return { ok: false, reason: "节点不存在" };
    if (g.type !== NODE_GROUP) return { ok: false, reason: "只有分组可以取消组合" };
    if (!g.children.length) {
      removeNodes(nodes, [g.id]);
      return { ok: true, count: 0 };
    }
    const parent = findParent(nodes, id);
    const parentId = parent ? parent.id : null;

    const cm = C || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const cmInv = matInvert(cm);
    const toDev = p => matApply(cm, p.x, p.y);
    const fromDev = p => (cmInv ? matApply(cmInv, p.x, p.y) : p);

    const lm = localMatrix(g);
    const gs = num(g.scale, 1) || 1;
    const gr = num(g.rotation, 0);
    const gcDev = toDev(matApply(lm, g.w / 2, g.h / 2));   // 组中心（**设备空间**）
    const rad = (gr * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);

    const kids = g.children.slice();
    kids.forEach(c => {
      const cl = { x: c.x + c.w / 2, y: c.y + c.h / 2 };   // 子中心（组空间）
      const pParent = matApply(lm, cl.x, cl.y);             // → 父空间（含组的缩放）
      // 父空间 → 设备 → 绕组中心转 gr → 回父空间
      let pDev = toDev(pParent);
      if (gr) {
        const dx = pDev.x - gcDev.x, dy = pDev.y - gcDev.y;
        pDev = { x: gcDev.x + dx * cos - dy * sin, y: gcDev.y + dx * sin + dy * cos };
      }
      const p = fromDev(pDev);
      c.x = p.x - c.w / 2;
      c.y = p.y - c.h / 2;
      c.rotation = ((num(c.rotation, 0) + gr) % 360 + 360) % 360;
      c.scale = num(c.scale, 1) * gs;
    });

    removeNodes(nodes, kids.map(k => k.id));
    removeNodes(nodes, [g.id]);
    kids.forEach(k => addNode(nodes, k, parentId));
    return { ok: true, count: kids.length };
  }
  window.ungroupNode = ungroupNode;

  /** 该节点是不是"可取消组合"的分组 */
  function isGroup(nodes, id) {
    const n = findNode(nodes, id);
    return !!(n && n.type === NODE_GROUP);
  }
  window.isGroup = isGroup;

  /** 复制节点：换新 id、名字加"副本"、位置错开一格 */
  function duplicateNode(nodes, id) {
    const n = findNode(nodes, id);
    if (!n) return null;
    const c = clone(n);
    function reid(node) {
      node.id = newId(node.type === window.NODE_GROUP ? "g" : "n");
      (node.children || []).forEach(reid);
    }
    reid(c);
    c.name = n.name + " 副本";
    c.x = n.x + window.STEP;
    c.y = n.y + window.STEP;
    c.z = num(n.z, 0) + 1;
    addNode(nodes, c, (findParent(nodes, id) || {}).id);
    return c;
  }
  window.duplicateNode = duplicateNode;

  // ================================================================ 变换矩阵

  /**
   * 2D 仿射矩阵 {a,b,c,d,e,f}：  x' = a·x + c·y + e
   *                                 y' = b·x + d·y + f
   *
   * 与 Canvas 的 `setTransform(a,b,c,d,e,f)` 同一套约定，可以直接喂给 ctx。
   */
  function matMul(m1, m2) {
    return {
      a: m1.a * m2.a + m1.c * m2.b,
      b: m1.b * m2.a + m1.d * m2.b,
      c: m1.a * m2.c + m1.c * m2.d,
      d: m1.b * m2.c + m1.d * m2.d,
      e: m1.a * m2.e + m1.c * m2.f + m1.e,
      f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
  }
  window.matMul = matMul;

  function matInvert(m) {
    const det = m.a * m.d - m.b * m.c;
    if (Math.abs(det) < 1e-9) return null;
    return {
      a: m.d / det, b: -m.b / det,
      c: -m.c / det, d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det,
    };
  }
  window.matInvert = matInvert;

  /**
   * 用矩阵变换一个点。
   *
   * ⚠️ **也接受 `(m, {x, y})` 形式**。这个签名被写错过一次：
   * `matApply(inv, canvasPt)` 传了个对象进去，`y` 成了 `undefined` →
   * 结果 `NaN` → **手柄命中永远失败**（画得出来、点不中），而且不报错。
   * 加这层容忍是因为那种 bug 的排查成本远高于这几行代码。
   */
  function matApply(m, x, y) {
    if (x !== null && typeof x === "object") { y = x.y; x = x.x; }
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }
  window.matApply = matApply;

  /**
   * 节点自身的**局部变换**（**不含旋转**）：把本地坐标（0..w, 0..h）映射到父坐标系。
   *
   * ```
   * T(x, y) · T(cx,cy) · S(scale) · T(-cx,-cy)
   * ```
   *
   * ## ⚠️ 为什么这里**不能**包含旋转（这是个真 bug，不是洁癖）
   *
   * 第一版把旋转放在这里，于是整条链是 `画布矩阵 · … · R(θ)`。
   * 而 `stretch` 缩放模式下画布矩阵是**每轴独立**的（16:10 屏上 2.183 × 1.364）。
   * 非等比 × 旋转 = **斜切**，实测后果：
   *
   * | 角度 | 外框 | 内容尺度 |
   * |---|---|---|
   * | 0° | 矩形 | 1.364 |
   * | 15° | **平行四边形**（相邻边点积 cos=-0.237，应为 0） | 1.433 |
   * | 45° | **平行四边形**（对角线差 209px） | **1.820（+33%）** |
   * | 90° | 矩形 | 1.364 |
   *
   * 也就是用户看到的"旋转时外框歪掉、控件还会变大"。
   *
   * **App 侧不是这样**：`view.rotation = θ` 旋转的是**已经排好版的设备盒子**，
   * 得到的是旋转矩形、尺寸恒定。所以旋转必须在**设备空间**施加 ——
   * 见 `canvas.js` 的 `withDeviceRotation()`。
   */
  function localMatrix(n) {
    const cx = n.w / 2, cy = n.h / 2;
    const s = num(n.scale, 1) || 1;
    return {
      a: s, b: 0, c: 0, d: s,
      e: n.x + cx - s * cx,
      f: n.y + cy - s * cy,
    };
  }
  window.localMatrix = localMatrix;

  /**
   * 节点在**画布坐标系（0..360）**里的**盒子**矩阵（累积所有祖先，不含旋转）。
   *
   * 布局用这个；**绘制与命中测试要在设备空间再叠一层旋转**
   * （`canvas.js` 的 `withDeviceRotation`）。
   */
  function worldMatrix(nodes, id) {
    const chain = pathTo(nodes, id);
    if (!chain) return null;
    let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    for (const n of chain) m = matMul(m, localMatrix(n));
    return { m: m, node: chain[chain.length - 1], chain: chain };
  }
  window.worldMatrix = worldMatrix;

  /** 根到该节点的路径（含自身）。绘制时逐层累积要用 */
  function chainOf(nodes, id) { return pathTo(nodes, id); }
  window.chainOf = chainOf;

  /**
   * 世界坐标下的四角（**盒子，不含旋转**）。返回 [左上, 右上, 右下, 左下]。
   *
   * 用于对齐/等距分布/多选外框 —— 这些场景用"未旋转的盒子"更可预测：
   * 旋转一个控件不该改变它在对齐计算里的位置。
   * 画布上**画**出来的选择框用的是设备空间带旋转的版本（见 canvas.js）。
   */
  function worldCorners(nodes, id) {
    const wm = worldMatrix(nodes, id);
    if (!wm) return null;
    const n = wm.node;
    return [
      matApply(wm.m, 0, 0), matApply(wm.m, n.w, 0),
      matApply(wm.m, n.w, n.h), matApply(wm.m, 0, n.h),
    ];
  }
  window.worldCorners = worldCorners;

  /** 世界坐标下的轴对齐包围盒（**盒子，不含旋转**） */
  function worldBounds(nodes, id) {
    const c = worldCorners(nodes, id);
    if (!c) return null;
    const xs = c.map(p => p.x), ys = c.map(p => p.y);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  window.worldBounds = worldBounds;

  // ================================================================ 序列化

  /** 顶层设计对象 */
  function createDesign(opts) {
    const o = opts || {};
    const firstNodes = o.nodes || [];
    return {
      name: o.name || "未命名设计",
      /**
       * **多页面**。
       *
       * ## 关键设计：`nodes` 始终**指向当前页的数组**
       *
       * `design.nodes === design.pages[design.pageIndex].nodes`（同一个引用）。
       * 这样**几千处现有代码**（画布、面板、校验、撤销……）全都不用改 ——
       * 它们照旧读写 `design.nodes`，切页时只换引用。
       *
       * 代价：序列化时必须写 `pages` 而不是 `nodes`（否则只存了当前页）。
       */
      pages: o.pages || [{ id: "pg0", name: "主页面", nodes: firstNodes }],
      pageIndex: o.pageIndex || 0,
      author: o.author || "",
      description: o.description || "",
      themeId: o.themeId || "",
      canvas: {
        unit: window.CANVAS,
        designW: num(o.designW, 2560),
        designH: num(o.designH, 1600),
        scaleMode: num(o.scaleMode, window.SCALE_STRETCH),
      },
      background: o.background || null,   // {path, fit}，v1 兼容字段
      assets: o.assets || [],             // [{id,name,kind,path,w,h,bytes}]
      // 自定义控件库：[{id, name, node}]。node 是一个**模板节点**（含子树），
      // 拖进画布时深拷贝一份、换新 id 即可复用。
      controls: o.controls || [],
      nodes: (o.pages && o.pages[o.pageIndex || 0] ? o.pages[o.pageIndex || 0].nodes : firstNodes),
    };
  }
  window.createDesign = createDesign;

  /** 节点 → JSON（**按 z 排序写出**，让文件顺序 = 绘制顺序，便于人读） */
  function nodeToJson(n) {
    const o = {
      id: n.id,
      type: n.type,
      name: n.name,
      x: r2(n.x), y: r2(n.y), w: r2(n.w), h: r2(n.h),
      rotation: r2(n.rotation),
      scale: r2(n.scale),
      alpha: clampInt(n.alpha, 0, 255),
      z: num(n.z, 0),
    };
    if (n.locked) o.locked = true;
    if (n.visible === false) o.visible = false;
    if (n.type === window.NODE_GAUGE) {
      // ⚠️ 写**语义别名**而不是解析后的 id（`obd.rpm` 而不是 `std_0C`）。
      //
      // 两个理由：
      //  1. 设计文件是给人看的，`obd.rpm` 远比 `std_0C` 可读
      //  2. App 侧 `DesignFile.resolvePid` 认别名，所以两边都能读；
      //     而 App 自己导出时也是写别名（保持一致）
      //
      // 只写 id 的后果：存盘再打开后 PID 下拉框拿 `std_0C` 去匹配选项
      // （选项的值是别名）→ **显示空白**。这是个真实的 UX bug，不是洁癖。
      o.pid = window.ALIAS_OF[n.pid] || n.pid;
      o.style = n.style;
      o.min = r2(n.min); o.max = r2(n.max);
      if (n.warnLow !== null && n.warnLow !== undefined) o.warnLow = r2(n.warnLow);
      if (n.warnHigh !== null && n.warnHigh !== undefined) o.warnHigh = r2(n.warnHigh);
      if (n.extraPids && n.extraPids.length) o.extraPids = n.extraPids.slice();
      if (n.ringStyle) o.ringStyle = n.ringStyle;
      if (n.ringSegments !== 40) o.ringSegments = n.ringSegments;
      if (n.neonPreset) o.neonPreset = n.neonPreset;
      if (n.cardStyle !== null && n.cardStyle !== undefined) o.cardStyle = n.cardStyle;
      // 映射表只在**有**时写出（空 = 不用映射，旧版本读到没有这个字段语义一致）
      if (window.valueLabelsUsable(n.valueLabels)) o.valueLabels = n.valueLabels.slice();
      // 部件只在**有**时写出（没有 = 用 style 的程序化画法）
      if (n.parts && n.parts.length) {
  // ⚠️ **剔除空的 pid / rawPid** —— 不剔的话每个部件都会写两个空字符串，
  // 文件里全是噪音（实测被测试抓到）。
  o.parts = n.parts.map(cleanPart);
}
      // card 只在**有实际覆盖**时写出，避免每个表塞一坨默认值
      if (n.card) {
        const c = {};
        if (typeof n.card.show === "boolean") c.show = n.card.show;
        if (n.card.alpha !== null && n.card.alpha !== undefined) c.alpha = n.card.alpha;
        if (n.card.radius !== null && n.card.radius !== undefined) c.radius = n.card.radius;
        if (Object.keys(c).length) o.card = c;
      }
      // 标签字体只在**非默认**时写出，避免每个仪表都塞一坨默认值
      const lf = window.normalizeFont(n.labelFont);
      if (JSON.stringify(lf) !== JSON.stringify(window.normalizeFont(null))) o.labelFont = lf;
      if (n.showLabel === false) o.showLabel = false;
      if (n.showRange === false) o.showRange = false;
    } else if (n.type === window.NODE_IMAGE) {
      o.assetId = n.assetId;
      // 和 pid 一样：写**语义别名**（`obd.rpm`），读起来比 `std_0C` 清楚，
      // 而且 App 侧 `resolvePid` 认别名
      if (n.statePid) o.statePid = window.ALIAS_OF[n.statePid] || n.statePid;
      if (n.states) o.states = n.states;
      // 阈值只在**显式设过**时写出
      if (n.stateWarn !== null && n.stateWarn !== undefined) o.stateWarn = n.stateWarn;
      if (n.stateCritical !== null && n.stateCritical !== undefined) o.stateCritical = n.stateCritical;
    } else if (n.type === window.NODE_TEXT) {
      o.text = n.text;
      o.font = window.normalizeFont(n.font);
    }
    if (n.children && n.children.length) {
      o.children = sortByZ(n.children).map(nodeToJson);
    }
    return o;
  }
  window.nodeToJson = nodeToJson;

  function r2(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }
  window.r2 = r2;

  /** 设计 → JSON 文本（v2） */
  /**
 * 递归清理一个部件：剔除空的 pid / rawPid / children。
 *
 * 不剔的话文件里全是噪音（每个部件都多几个空字段），而且**嵌套层越深越严重**。
 */
function cleanPart(p) {
  const q = window.normalizePart(p);
  if (!q.pid) { delete q.pid; delete q.rawPid; }
  if (q.children && q.children.length) q.children = q.children.map(cleanPart);
  else delete q.children;
  return q;
}

function toV2Json(d) {
    // ================================================================ 第 4 步：导出也走 `resolveDesign`
    //
    // §4「唯一入口」：**不许各写一份**。v2.49.0 已经踩过这个坑 ——
    // `model.js` 自己拼 `themeColors`、而画布不读它，于是"切主题画布完全不变"。
    // 两处实现迟早分叉，症状是「画布上看到的」和「导出后 App 看到的」不一样。
    //
    // ⚠️ 这里**没有**"文件形态 vs 画布视图"的区别（v2.80.2 起）：
    // v2.80.1 曾经让 `text` 在文件里存 `$$100`、画布上显示 `$100`（`$$` 转义），
    // 那条约定**已按规格 §十二.3 取消** —— 因为 App 侧就是 `tv.text = node.text`，
    // 它不认识 `$$`，于是"工具里 `$100`、平板上 `$$100`"。
    // 现在 `nodes[].text` 是纯字面值，画布 / 导出 / App 三边同一个串。
    const rd = (typeof window.resolveDesign === "function") ? window.resolveDesign(d) : d;
    const root = {
      schema: window.SCHEMA_V2,
      meta: { name: rd.name, author: rd.author, description: rd.description },
      canvas: {
        unit: window.CANVAS,
        designW: rd.canvas.designW,
        designH: rd.canvas.designH,
        scaleMode: rd.canvas.scaleMode,
        note: "每轴 0..360。x/y 是左上角（相对父节点），w/h 是尺寸；rotation 绕自身中心",
      },
    };
    if (rd.themeId) root.theme = rd.themeId;
// **内嵌配色**（P8-5）：把主题的颜色一起写进设计文件，
// 这样换台机器 / 用户删了自建主题，配色也不会丢。
// 字段名与 GaugeTheme.toJson 逐字一致 → App 侧直接 fromJson。
//
// ⚠️ 第 4 步起，这个值由 `resolveDesign` 算（**唯一入口**）：有变量系统时
// 由 `tokens` + `modes` + `activeMode` 推出来，没有时照旧走 `themeColorsOverride`。
// 两条路都必须给出**完整 15 字段**（12 色 + glow + title + description）——
// 那是 `verify-crosslang.js` 逐条核对的跨语言契约（§8.1），也是 T1 等价性的判据。
  if (rd.themeColors) root.themeColors = rd.themeColors;

  // ---- 变量 / 模式 / 绑定（第 4 步，规格 §3）
  //
  // ⚠️ **空的一律不写**。存量文件（绝大多数）没有变量系统，导出结果必须
  // **逐字节不变** —— 那是"对 App 与存量文件零影响"的凭据（T2）。
  // 写空数组的话每个老文件一存盘就多四行噪音，而且"没有变量"和
  // "有变量但都是空的"就分不出来了。
  //
  // 这四段对 App 是**未知顶层键**：`DesignFile.kt` 用 `optJSONObject` / `optJSONArray`
  // 读，未知键返回 null，不报错（§8）。所以写出去是安全的，读不读是 App 的自由。
  if (rd.tokens && rd.tokens.length) {
    root.tokens = rd.tokens.map(function (t) {
      const o = { id: t.id, name: t.name, type: t.type, value: t.value === undefined ? null : t.value };
      if (typeof t.builtin === "string" && t.builtin) o.builtin = t.builtin;
      return o;
    });
  }
  if (rd.modes && rd.modes.length) {
    root.modes = rd.modes.map(function (m) {
      return { id: m.id, name: m.name, values: Object.assign({}, m.values || {}) };
    });
  }
  // `activeMode` 单独判：`modes` 被手改坏（空数组）时也不能把用户写的 activeMode 悄悄抹掉
  if (typeof rd.activeMode === "string" && rd.activeMode) root.activeMode = rd.activeMode;
  const binds = bindingsToJson(rd.bindings);
  if (Object.keys(binds).length) root.bindings = binds;

    if (rd.background && rd.background.path) {
      const bg = { path: rd.background.path, fit: rd.background.fit };
      // 尺寸只在非 0 时写出（0 = 按铺法自动，写出来只是噪音）
      if (rd.background.w) bg.w = rd.background.w;
      if (rd.background.h) bg.h = rd.background.h;
      root.background = bg;
    }
    if (rd.assets && rd.assets.length) {
      root.assets = rd.assets.map(a => ({
        id: a.id, name: a.name, kind: a.kind, path: a.path,
        w: a.w || 0, h: a.h || 0, bytes: a.bytes || 0,
      }));
    }
    if (rd.controls && rd.controls.length) {
      root.controls = rd.controls.map(c => ({
        id: c.id, name: c.name, node: nodeToJson(c.node),
      }));
    }
  // **单页只写 nodes，多页才写 pages**。
  //
  // 为什么不是"两个都写"：解析时 pages 优先，于是用户在 JSON 里改 nodes
  // 会被**静默忽略** —— 实测就踩到了（测试删掉 nodes[0].pid，校验却报通过）。
  // 单页是绝大多数情况（v1 升级来的全是单页），保持和以前**逐字节一致**的输出，
  // 既向后兼容，也不会有"两处真相"。
  const pageList = rd.pages || [{ id: "pg0", name: "主页面", nodes: rd.nodes || [] }];
  if (pageList.length > 1) {
    root.pages = pageList.map((pg, i) => ({
      id: pg.id,
      name: pg.name,
      nodes: sortByZ(i === (rd.pageIndex || 0) ? rd.nodes : pg.nodes).map(nodeToJson),
    }));
  }
    root.nodes = sortByZ(rd.nodes).map(nodeToJson);
    return JSON.stringify(root, null, 2);
  }
  window.toV2Json = toV2Json;

  /**
   * 序列化 `bindings`（第 4 步，§3.4）。
   *
   * 只写**白名单字段 + `$` 引用**这两条判据都成立的条目 —— 与
   * `validate.js` 的 `parseBindings` 同一套判据。
   *
   * 为什么要在这儿再筛一遍（内存里的 `bindings` 解析时已经筛过了）：
   * 写出去的东西会**原样被下一次打开读回来**。如果这里把一条非引用的值
   * （比如 `"font.color": "red"`）写进文件，下次打开就会自己给自己报一条
   * "不是变量引用 —— 已忽略"的警告 —— 自己造的警告最伤，用户根本不知道从哪来的。
   *
   * 顺带把"每个节点一坨空对象"也挡掉（全空 = 不写这个节点）。
   */
  function bindingsToJson(bindings) {
    const out = {};
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return out;
    Object.keys(bindings).forEach(function (nid) {
      const spec = bindings[nid];
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) return;
      const one = {};
      // 按白名单顺序写 → 键序稳定（同一个 design 每次导出逐字节相同）
      window.BINDABLE_FIELD_PATHS.forEach(function (p) {
        if (window.isTokenRef(spec[p])) one[p] = spec[p];
      });
      if (Object.keys(one).length) out[nid] = one;
    });
    return out;
  }

  /**
   * 导出 **v1**（App 当前版本能直接读）。
   *
   * 为什么要它：v2 的图片/状态/分组 App 还读不了。
   * 有这条，工具今天就能用；同时 v2 是向前看的格式。
   *
   * 规则：把 gauge 节点展平（含分组里的），丢掉图片/文字/分组，并**报告丢了多少**。
   * 变换里的 rotation/scale 在 v1 里表达不了 —— 一并报告。
   */
  function toV1Json(d) {
    const lost = { image: 0, text: 0, group: 0, rotation: 0, scale: 0, alpha: 0, locked: 0 };
    const gauges = [];
    walk(d.nodes, n => {
      if (n.type === window.NODE_IMAGE) { lost.image++; return; }
      if (n.type === window.NODE_TEXT) { lost.text++; return; }
      if (n.type === window.NODE_GROUP) { lost.group++; return; }
      if (Math.abs(num(n.rotation, 0)) > 0.01) lost.rotation++;
      if (Math.abs(num(n.scale, 1) - 1) > 0.001) lost.scale++;
      if (clampInt(n.alpha, 0, 255) < 255) lost.alpha++;
      if (n.locked) lost.locked++;
      const b = worldBounds(d.nodes, n.id);
      const g = {
        pid: n.pid, style: n.style, min: n.min, max: n.max,
        x: r2(b ? b.x : n.x), y: r2(b ? b.y : n.y),
        w: r2(n.w), h: r2(n.h),
      };
      if (n.warnLow !== null && n.warnLow !== undefined) g.warnLow = n.warnLow;
      if (n.warnHigh !== null && n.warnHigh !== undefined) g.warnHigh = n.warnHigh;
      if (n.extraPids && n.extraPids.length) g.extraPids = n.extraPids.slice();
      if (n.ringStyle) g.ringStyle = n.ringStyle;
      if (n.ringSegments !== 40) g.ringSegments = n.ringSegments;
      if (n.neonPreset) g.neonPreset = n.neonPreset;
      if (n.cardStyle !== null && n.cardStyle !== undefined) g.cardStyle = n.cardStyle;
      // 映射表跟着走：App 侧 `GaugeItem` 与 schema 版本无关，v1 也能读
      if (window.valueLabelsUsable(n.valueLabels)) g.valueLabels = n.valueLabels.slice();
      gauges.push(g);
    });

    const root = {
      schema: window.SCHEMA_V1,
      meta: { name: d.name, author: d.author, description: d.description },
      canvas: { unit: window.CANVAS, note: "每轴 0..360。x/y 是左上角，w/h 是尺寸" },
    };
    if (d.themeId) root.theme = d.themeId;
    if (d.background && d.background.path) {
      root.background = { path: d.background.path, fit: d.background.fit };
    }
    root.gauges = gauges;
    return { json: JSON.stringify(root, null, 2), lost: lost, count: gauges.length };
  }
  window.toV1Json = toV1Json;

  // ================================================================ 撤销 / 重做

  /**
   * 快照式撤销栈。
   *
   * ## 为什么用快照而不是"命令模式"
   *
   * 命令模式要为每种操作写一个 do/undo 对（拖动、缩放、改属性、加删节点…），
   * 十几处都要正确 —— 漏一个就是"撤销后状态不一致"。
   * 快照只要求"能序列化整棵树"，正确性由序列化保证。
   *
   * 代价是内存：一份快照约等于设计文件的 JSON 大小（几 KB ~ 几十 KB）。
   * 100 步 × 30KB = 3MB，可接受。
   *
   * ## 合并连续操作
   *
   * 拖动会连续产生几十次改动。若每次都压栈，撤销一次只退一个像素。
   * 所以支持 `push(label, {coalesceKey})`：同一个 key 的连续改动**只保留第一次**。
   */
  function UndoStack(limit) {
    this.limit = limit || 100;
    this.stack = [];
    this.index = -1;
    this.lastKey = null;
  }

  UndoStack.prototype.reset = function (state, label) {
    this.stack = [{ state: state, label: label || "初始" }];
    this.index = 0;
    this.lastKey = null;
  };

  UndoStack.prototype.push = function (state, label, coalesceKey) {
    // 合并：同一类连续操作（拖动的每一帧、滑块的每一次 input）只算**一步**。
    //
    // ⚠️ 这里必须**替换栈顶**，不能再 push 一条 —— 第一版写成 push，
    // 结果 150 次拖动产生了 150 条记录，"合并"完全没生效（实测 3/3 → 100/100）。
    // 语义：栈顶保存"这类操作的最新状态"，撤销时回到它**下面**那条（= 操作前）。
    if (coalesceKey && coalesceKey === this.lastKey && this.index >= 0) {
      this.stack[this.index] = { state: state, label: label };
      return;
    }
    this.stack.splice(this.index + 1);
    this.stack.push({ state: state, label: label || "改动" });
    this.index = this.stack.length - 1;
    this.lastKey = coalesceKey || null;
    this.trim();
  };

  /** 结束一次合并序列（鼠标松开时调），下次改动会新起一条 */
  UndoStack.prototype.endCoalesce = function () { this.lastKey = null; };

  UndoStack.prototype.trim = function () {
    while (this.stack.length > this.limit + 1) {
      this.stack.shift();
      this.index--;
    }
    if (this.index < 0) this.index = 0;
  };

  UndoStack.prototype.canUndo = function () { return this.index > 0; };
  UndoStack.prototype.canRedo = function () { return this.index < this.stack.length - 1; };

  UndoStack.prototype.undo = function () {
    if (!this.canUndo()) return null;
    this.index--;
    this.lastKey = null;
    return { state: this.stack[this.index].state, label: this.stack[this.index + 1].label };
  };

  UndoStack.prototype.redo = function () {
    if (!this.canRedo()) return null;
    this.index++;
    this.lastKey = null;
    return { state: this.stack[this.index].state, label: this.stack[this.index].label };
  };

  /** 当前状态（用于显示"可撤销 N 步"） */
  UndoStack.prototype.depth = function () { return this.index; };
  UndoStack.prototype.size = function () { return this.stack.length; };

  window.UndoStack = UndoStack;
})();
