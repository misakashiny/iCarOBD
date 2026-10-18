/* ==========================================================================
   js/ui/schema-props.js —— Schema 驱动的属性编辑核心（P4A）
   ==========================================================================

   ## 设计目标

   不改写 `panels.js`，而是建立一套**可独立运行、可增量接入**的框架，
   先只接管 `cd_*` 轨道，验证稳定后再推广。

   ## 五个职责（任务第三部分要求）

   | 组件 | 职责 |
   |---|---|
   | `SchemaResolver` | 根据**节点能力**查找属性声明 |
   | `SchemaRenderer` | 根据 Schema 生成表单 DOM |
   | `PropertyAccessor` | 点号路径读写（`trackStyle.orient`）|
   | `PropertyValidator` | 类型 / 范围 / 枚举校验 |
   | `PropertyUpdate` | 统一变更事务（含撤销重做）|

   ## ⚠️ 识别的硬约束（任务第二部分第 3 条）

   **禁止把 `node.__controlKey` 作为唯一识别条件。**

   实测确认：`__controlKey` **不会进入序列化**（`nodeToJson` 白名单里没有它），
   保存 → 重载 / 导入旧文件后**必然丢失**。

   所以识别一律用**持久化字段**：

   ```js
   type === "image" && trackStyle != null   → 代码轨道
   ```

   这条判断对「新建」「保存重载」「历史导入」三种来源**都成立**。

   ⚠️ 本阶段**不修改 `icar.ui/2`** —— 不新增持久化字段来存控件来源。

   ## 与 Registry 的关系

   **Registry 不依赖本文件**。本文件单向读 `ICAR.registry.Control` 的 `schema`，
   反过来 Registry 完全不知道属性面板存在。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("schema-props.js 必须在 core/namespace.js 之后加载");

  // ============================================================ 一、PropertyAccessor

  /**
   * 点号路径读写。
   *
   * `get(node, "trackStyle.orient")` → `node.trackStyle?.orient`
   * `set(node, "trackStyle.orient", "v")` → 写回去（中间层不存在时**不**自动创建对象，
   * 避免把一条没有 trackStyle 的图片节点意外变成轨道）
   */
  /**
   * 状态灯的 **statePid 双字段同步**（P4D-01）。
   *
   * ## 为什么必须同步
   *
   * 状态灯有两个绑定字段，语义不同（见 lamp-family.js 文件头）：
   *   · `node.rawStatePid` —— 用户写的**别名**（`obd.coolant`），回显用
   *   · `node.statePid`    —— 解析后的**通道 id**（`std_05`），App 端判定用
   *
   * 而 `nodeToJson()` 对 NODE_IMAGE **只序列化 statePid**，且写的是**别名**
   * （`ALIAS_OF[id]`）。所以：
   *
   *   · 只改 rawStatePid → statePid 仍是旧通道 → **App 侧仍按旧数据判定**
   *   · 只改 statePid 成别名 → 内部查表拿到别名而非 id → 取不到值
   *
   * 历史事故（lamp-family.js:12-24 记录）：写错字段导致灯**永远是暗的**，
   * 用户以为车没问题。所以这里是**数据契约问题**，不是 UI 细节。
   *
   * ## 返回
   *   true  = 已按语义规范化
   *   false = 不是状态灯，调用方按普通路径写
   */
  function normalizeStateLampBinding(node, path, value) {
    if (!node || path !== "statePid") return false;
    const st = node.states;
    if (!st || typeof st !== "object") return false;   // 不是状态灯
    const alias = String(value == null ? "" : value);
    const resolved = typeof window.resolvePid === "function" ? window.resolvePid(alias) : null;
    // 无论能否解析，别名都要如实保留（用户可能先写别名再修正）
    node.rawStatePid = alias;
    // 解析不出来就保持原 statePid，不写字面别名（否则内部查表拿不到 id）
    if (resolved) node.statePid = resolved;
    return true;
  }

  /**
   * 仪表 **pid 双字段同步**（P4E-02 批次 A）。
   *
   * ## 根因（P4E-01 R1 审计证据）
   *
   * 仪表与状态灯一样有两个绑定字段：
   *   · `node.rawPid` —— 用户写的**别名**（`obd.speed`），下拉回显用
   *   · `node.pid`    —— 解析后的**通道 id**（`std_0D`），渲染/查表用
   *
   * 而 `nodeToJson()` 写的是 `ALIAS_OF[n.pid] || n.pid`，直接反查别名表。
   * 所以若有人只写 `node.pid = 'obd.rpm'`（别名）：
   *
   *   改前: pid=std_0D  rawPid=obd.speed
   *   写入 'obd.rpm' 后: pid=obd.rpm（**别名进了通道位**）、rawPid 仍是 obd.speed
   *   重载后: pid=obd.rpm, rawPid=obd.rpm  ← **两个字段同时错**
   *
   * 旧面板走 `assignControlBinding()`（data-bindings.js:36）**是正确的**：
   *   `n.rawPid = raw; n.pid = resolvePid(raw);`
   * 这里把同样的语义搬到 PropertyAccessor 入口，让两条路径行为一致。
   *
   * ## 关于"无效 PID"与"自定义 PID"（任务要求不得静默误绑定）
   *
   * `resolvePid(name) = PID_ALIASES[name] || name` —— **永远不返回空**。
   * 所以无法靠返回值判断"这是不是合法 PID"。规则：
   *
   *   · 空串 → 两边都清空（未绑定），与原面板「未绑定」语义一致
   *   · 已知 id/别名 → 正常解析
   *   · 未知值 → **原样保留**在两边（自定义 PID 是旧面板支持的合法用法，
   *     不能未经评审就禁掉；App 端没有任何数据源时会显示 `--`）
   *
   * 唯一"看起来奇怪"的情况是未知值进了 pid 通道位 —— 但这与旧面板
   * `assignControlBinding` 的行为**完全相同**，属于既有契约，本批次不改。
   *
   * @returns true=已按仪表语义处理；false=不是仪表，调用方走普通路径
   */
  function normalizeGaugePidBinding(node, path, value) {
    if (!node || path !== "pid") return false;
    if (node.type !== "gauge") return false;          // 只接管仪表
    const raw = String(value == null ? "" : value).trim();
    if (!raw) {
      // 未绑定：两边都清空（与 bindingPidOptions 的「未绑定」一致）
      node.rawPid = "";
      node.pid = "";
      return true;
    }
    const resolved = typeof window.resolvePid === "function" ? window.resolvePid(raw) : raw;
    node.rawPid = raw;
    node.pid = resolved || raw;
    return true;
  }

  const PropertyAccessor = {
    get(obj, path) {
      if (!obj || !path) return undefined;
      const parts = String(path).split(".");
      let cur = obj;
      for (let i = 0; i < parts.length; i++) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    },

    /**
     * 写入。返回 `true` 表示真的改了（值有变化）。
     *
     * ⚠️ 中间层必须是已存在的对象 —— 不存在就拒绝写并返回 false。
     *    否则"给一张普通图片节点加个 trackStyle.orient"会把它变成半残轨道。
     */
    set(obj, path, value) {
      if (!obj || !path) return false;
      // P4D-01：状态灯的 statePid 有双字段语义，交给专用规范化
      if (normalizeStateLampBinding(obj, path, value)) {
        return true;   // 已处理（是否真的变化由调用方 commit 决定）
      }
      // P4E-02：仪表的 pid 同样是双字段语义
      if (normalizeGaugePidBinding(obj, path, value)) {
        return true;
      }
      const parts = String(path).split(".");
      let cur = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur[parts[i]];
        if (cur === null || typeof cur !== "object") return false;
      }
      const leaf = parts[parts.length - 1];
      const old = cur[leaf];
      if (sameValue(old, value)) return false;   // 无变化 → 不写、不 commit
      cur[leaf] = value;
      return true;
    },
  };

  /** 值相等判断（NaN 视为相等；null 与 undefined 视为不同 —— 语义上要分清） */
  function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return a !== a && b !== b;
    return false;
  }

  // ============================================================ 二、PropertyValidator

  /**
   * 按 Schema 声明校验并**归一**一个值。
   *
   * @returns {{ok:boolean, value:*, error:string|null}}
   */
  const PropertyValidator = {
    /**
     * @param {Object} field  schema 字段声明
     * @param {*} raw         用户输入（可能是字符串，例如 input.value）
     */
    coerce(field, raw) {
      const t = field.type;

      if (t === "boolean") {
        if (typeof raw === "boolean") return { ok: true, value: raw, error: null };
        if (raw === "true") return { ok: true, value: true, error: null };
        if (raw === "false") return { ok: true, value: false, error: null };
        return { ok: false, value: false, error: "需要布尔值" };
      }

      if (t === "number") {
        // ⚠️ 空字符串 → null（表示"不设"），不能变成 0，也不能变成 NaN
        if (raw === "" || raw === null || raw === undefined) {
          if (field.nullable) return { ok: true, value: null, error: null };
          return { ok: false, value: null, error: "不能为空" };
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, value: null, error: "不是数字：" + raw };
        if (field.min !== undefined && n < field.min) {
          return { ok: false, value: n, error: "不能小于 " + field.min };
        }
        if (field.max !== undefined && n > field.max) {
          return { ok: false, value: n, error: "不能大于 " + field.max };
        }
        return { ok: true, value: n, error: null };
      }

      // ---- 颜色（P4B）----
      //
      // 支持两种合法形态（与项目既有约定一致）：
      //   ① `#RRGGBB` 字面色 —— `window.isHexColor`
      //   ② `$变量名` 引用串 —— `normalizeFont` 会**原样保留**它，
      //      由 validate.js 去报"bindings 里没有对应条目"的硬错误。
      //      面板这里**不能**把它当非法值拒掉，否则用户就改不回引用了。
      if (t === "color") {
        const s = raw === null || raw === undefined ? "" : String(raw).trim();
        if (s === "") {
          // 空 = 不设颜色（回落默认）。允许，但明确告诉调用方这是"清空"
          return { ok: true, value: null, error: null };
        }
        const isRef = /^\$[A-Za-z_][\w-]*$/.test(s);        // 变量引用
        const isHex6 = /^#[0-9a-fA-F]{6}$/.test(s);
        const isHex3 = /^#[0-9a-fA-F]{3}$/.test(s);
        if (isRef) return { ok: true, value: s, error: null };
        if (isHex6) return { ok: true, value: s.toUpperCase(), error: null };
        if (isHex3) {
          // #abc → #AABBCC（展开成 6 位，与 isHexColor 的存储约定一致）
          const r = s[1], g = s[2], b = s[3];
          return { ok: true, value: ("#" + r + r + g + g + b + b).toUpperCase(), error: null };
        }
        return {
          ok: false, value: s,
          error: "颜色需要 #RRGGBB、#RGB 或 $变量名（当前：" + s + "）",
        };
      }
      if (t === "enum") {
        const vals = field.values || [];
        // ⚠️⚠️ **null 必须按"真 null"比较**，不能转成字符串 "null"。
        //    gradient 的合法值就是 [null, "gloss", "fade"]，
        //    若把字符串 "null" 当成 null，模型里就会出现 `gradient: "null"` 这种脏值。
        if (raw === null && vals.indexOf(null) >= 0) return { ok: true, value: null, error: null };
        if (vals.indexOf(raw) >= 0) return { ok: true, value: raw, error: null };
        // 数字枚举：用户从 <select> 拿到的是字符串，转回数字
        const n = Number(raw);
        if (String(raw) !== "null" && vals.indexOf(n) >= 0) return { ok: true, value: n, error: null };
        return { ok: false, value: raw, error: "不在可选值内：" + String(raw) };
      }

      if (t === "string") {
        return { ok: true, value: raw === null || raw === undefined ? "" : String(raw), error: null };
      }

      // 未知类型：原样通过（不阻断）
      return { ok: true, value: raw, error: null };
    },
  };

  // ============================================================ 三、SchemaResolver

  /**
   * 根据**节点能力**查找属性 Schema。
   *
   * ## 单一事实源（P4A.1 修正）
   *
   * P4A 初版这里内置了一份 TRACK_SCHEMA，同时 resolve 又会优先读 Registry 的定义
   * —— 于是同一族有**两套字段表**：
   *
   *   新建节点（有 __controlKey） 读 Registry 的 schema[]
   *   重载节点（无 __controlKey） 读内置 TRACK_SCHEMA
   *
   * 两份已经产生偏差（内置那份多了 nullable 标记）。
   * 这正是任务第三部分要消除的"重复维护独立配置"。
   *
   * ## 现在怎么做的
   *
   * **只保留 Registry 一处定义。** 持久化能力（type + trackStyle）只用来判断
   * "这是哪一族"，具体字段表一律回 Registry 取。
   * 这样新增字段时只改 Registry 一处，面板自动跟上。
   */
  /**
   * 按**持久化能力**判断是不是文字控件。
   *
   * 文字节点没有别的特征字段，`type === "text"` 就足够 ——
   * 且它在 `nodeToJson` 白名单里，保存重载不会丢。
   */
  function isTextNode(node) {
    return !!node && node.type === "text";
  }

  /**
   * 从一个 Registry 定义里挑出**代表该族**的那条，用于取 schema。
   *
   * ⚠️⚠️ **不能随便挑一条就假设全族一致**（P4B 实测教训）：
   *
   *   12 个文字控件里有 **2 种 schema 签名**：
   *     · `t_label`（P1A 单独注册）      → font.size max = **200**
   *     · 其余 11 条（text-family.js）   → font.size max = **400**
   *
   * 渲染侧 `normalizeFont()` 对字号**只有下限 size > 0，没有上限**，
   * 所以两者都能正常渲染；差异只存在于 Schema 声明层。
   *
   * **分派规则**（明确写死，不做隐式假设）：
   *
   *   1. 节点带 `__controlKey` 且该 key 在 Registry 里 → **用该 key 自己的 schema**
   *   2. 否则（保存重载后 `__controlKey` 必然丢失）→ 取 Registry 里
   *      **最宽松**的文字族 schema（`text-family` 那份，max=400）
   *
   * 选"最宽松"的理由：字号在渲染侧本来就不受限，用宽的那份不会拒绝
   * 用户本来就能设的值；反之用 t_label 的 200 会**凭空限制**其余 11 条。
   *
   * 已知后果（如实记录）：重载后的 `t_label` 字号上限会从 200 变成 400。
   * 这**不影响渲染、不影响存量设计**，只是校验放宽。
   */
  function textSchemaFor(node) {
    const Reg = ICAR.registry && ICAR.registry.Control;
    if (!Reg || !Reg.all) return null;

    // ① 精确定位：新建的节点带 __controlKey
    const key = node && node.__controlKey;
    if (key && Reg.get) {
      const own = Reg.get(key);
      if (own && own.schema && own.schema.length) return own;
    }

    // ② 回退：挑最宽松的文字族定义（font.size.max 最大者）
    const all = Reg.all();
    let best = null;
    let bestMax = -1;
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      if (!d || !d.schema || !d.render) continue;
      if (d.render.mode !== "text") continue;
      const f = d.schema.find(function (x) { return x.key === "font.size"; });
      const mx = f && f.max !== undefined ? f.max : 0;
      if (mx > bestMax) { bestMax = mx; best = d; }
    }
    return best;
  }
  /**
   * 按**持久化能力**判断是不是容器节点（P4C）。
   *
   * ## 识别范围审计（P4C 第二部分）
   *
   * `node.type === "group"` 是**节点能力**，不等于"来源是四个基础容器 key"。
   * 全库实测 215 条里有 **19 条**产 group：
   *
   * | 来源 | 条数 | 子节点 | 说明 |
   * |---|---|---|---|
   * | `derived`（Registry 接管）| **4** | 0 | group / box_card / box_row / box_col |
   * | `probe`（旧工厂）| **15** | **2** | 全部 `next_*` 组合预设 |
   *
   * 另有**运行时产生**的 group：
   *   · 用户手动"组合"（`model.js:489` 的 `groupNodes`）
   *   · 历史设计文件里的 group
   *   · 嵌套 group
   *
   * ## 为什么六个属性对所有 group 都安全
   *
   * `w` / `h` / `rotation` / `alpha` / `locked` / `visible` **全都是
   * `createNode()` 的通用基础字段**（见 `model.js` 的 `base` 对象），
   * 任何节点类型都有，不是容器专有：
   *
   *   w: num(o.w, 120), h: num(o.h, 120),
   *   rotation: num(o.rotation, 0), alpha: clampInt(...), locked, visible,
   *
   * 所以它们对 **group / next_* / 手动组合 / 历史 group** 语义完全一致，
   * 不存在"某类 group 不能改 alpha"这种情况。
   *
   * ⚠️ 因此**不需要**按 key 分派，也**不需要**持久化控件来源字段
   *    （任务明确禁止新增）。`type === "group"` 一个判据就够。
   */
  function isContainerNode(node) {
    return !!node && node.type === "group";
  }
  const SchemaResolver = {
    /** 持久化能力：代码轨道 = image + 有 trackStyle */
    isTrack(node) {
      return !!node && node.type === "image" && node.trackStyle !== null &&
        typeof node.trackStyle === "object";
    },

    /** 持久化能力：容器节点（group） */
    isContainer(node) { return isContainerNode(node); },

    /** 持久化能力：文字节点 */
    isText(node) { return isTextNode(node); },

    /**
     * 持久化能力：**仪表**（P4E-02 批次 B）。
     *
     * ## 为什么不能只看 __controlKey
     *
     * 与状态灯同理：`__controlKey` 不进 `nodeToJson` 白名单，重载后必丢。
     * 必须用**持久化字段特征**：
     *
     *   · type === "gauge"
     *   · 没有 states（那是状态灯，虽然状态灯是 image 类型，这里双保险）
     *   · 没有 trackStyle（那是条形轨道）
     *
     * `type === "gauge"` 本身就是持久化字段（JSON 里有 type），
     * 已足够唯一；后两条是防误判的冗余判据。
     */
    isGauge(node) {
      if (!node || node.type !== "gauge") return false;
      if (node.states && typeof node.states === "object") return false;
      if (node.trackStyle !== null && typeof node.trackStyle === "object") return false;
      return true;
    },

    /**
     * 持久化能力：**状态灯**（P4D-01）。
     *
     * ## 为什么不能只看 __controlKey
     *
     * `__controlKey` **不进序列化**（nodeToJson 白名单里没有），
     * 所以保存重载后必然丢失。必须用**持久化字段特征**判断：
     *
     *   · type === "image"
     *   · 有 states 对象，且含 normal / warn / critical 三态
     *   · 没有 trackStyle（那是条形轨道，另一族）
     *
     * 这三条同时成立就是状态灯。实测 19 个灯 build 出来全部满足，
     * 而普通图片节点没有 states → 不会误判。
     */
    isStateLamp(node) {
      if (!node || node.type !== "image") return false;
      if (node.trackStyle !== null && typeof node.trackStyle === "object") return false;
      const st = node.states;
      if (!st || typeof st !== "object" || Array.isArray(st)) return false;
      return !!(st.normal || st.warn || st.critical);
    },

    /** 持久化能力：普通图片（含 bar_* 图片轨道） */
    isPlainImage(node) {
      return !!node && node.type === "image" && (node.trackStyle === null || node.trackStyle === undefined);
    },

    /**
     * 从 Registry 里找**代表定义**（同族任一条即可，它们的 schema 相同）。
     * 不依赖 __controlKey —— 只按持久化能力挑一条定义。
     */
    _representative(family) {
      const Reg = ICAR.registry && ICAR.registry.Control;
      if (!Reg || !Reg.all) return null;
      const all = Reg.all();
      for (let i = 0; i < all.length; i++) {
        const d = all[i];
        if (!d || !d.schema || !d.render) continue;
        if (family === "track" && d.render.mode === "track") return d;
      }
      return null;
    },

    resolve(node) {
      // ---- 容器族（P4C）----
      if (isContainerNode(node)) {
        const def = containerSchemaFor(node);
        if (!def) {
          return {
            family: "container", editable: [], fields: [],
            error: "Control Registry 中没有容器族的定义（注册未执行？）",
          };
        }
        return { family: "container", editable: EDITABLE.container.slice(), fields: def.schema };
      }

      // ---- 仪表族（P4E-02 批次 B）----
      if (this.isGauge(node)) {
        const def = gaugeSchemaFor(node);
        if (!def) {
          return {
            family: "gauge", editable: [], fields: [],
            error: "Control Registry 中没有仪表族的定义（注册未执行？）",
          };
        }
        return { family: "gauge", editable: EDITABLE.gauge.slice(), fields: def.schema };
      }

      // ---- 文字族（P4B）----
      if (isTextNode(node)) {
        const def = textSchemaFor(node);
        if (!def) {
          return {
            family: "text", editable: [], fields: [],
            error: "Control Registry 中没有文字族的定义（注册未执行？）",
          };
        }
        return { family: "text", editable: EDITABLE.text.slice(), fields: def.schema };
      }

      // ---- 状态灯族（P4D-01）----
      if (this.isStateLamp(node)) {
        const def = stateLampSchemaFor(node);
        if (!def) {
          return {
            family: "imageState", editable: [], fields: [],
            error: "Control Registry 中没有状态灯族的定义（注册未执行？）",
          };
        }
        return { family: "imageState", editable: EDITABLE.imageState.slice(), fields: def.schema };
      }

      if (!this.isTrack(node)) return null;

      const rep = this._representative("track");
      if (!rep) {
        return {
          family: "track",
          editable: [],
          fields: [],
          error: "Control Registry 中没有轨道族的定义（注册未执行？）",
        };
      }
      return {
        family: "track",
        editable: EDITABLE.track.slice(),
        fields: rep.schema,
      };
    },
  };

  /**
   * 取容器族的**代表定义**（四个 key 的 schema 实测 distinctSignatures === 1）。
   *
   * ⚠️ 仍然从 Registry 取，**不在 UI 层复制一份 CONTAINER_SCHEMA**
   *    （P4A.1 消除 Schema 双源的教训）。
   */
  function containerSchemaFor(node) {
    const Reg = ICAR.registry && ICAR.registry.Control;
    if (!Reg || !Reg.all) return null;

    // ① 精确定位：新建节点带 __controlKey
    const key = node && node.__controlKey;
    if (key && Reg.get) {
      const own = Reg.get(key);
      if (own && own.schema && own.render && own.render.mode === "container") return own;
    }

    // ② 回退：Registry 里任一 container 定义（四个 key 的 schema 已实测一致）
    const all = Reg.all();
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      if (d && d.schema && d.render && d.render.mode === "container") return d;
    }
    return null;
  }

  /**
   * 取仪表族的**代表定义**（P4E-02 批次 B）。
   *
   * 6 个仪表 schema 实测完全一致（12 字段），任取一条即可。
   * 仍然从 Registry 取，**不在 UI 层复制 schema**（P4A.1 消除双源的教训）。
   */
  function gaugeSchemaFor(node) {
    const Reg = ICAR.registry && ICAR.registry.Control;
    if (!Reg || !Reg.all) return null;

    // ① 新建节点带 __controlKey → 精确
    const key = node && node.__controlKey;
    if (key && Reg.get) {
      const own = Reg.get(key);
      if (own && own.schema && own.render && own.render.mode === "gauge") return own;
    }
    // ② 回退：任一 gauge 模式定义（6 条已实测 schema 一致）
    const all = Reg.all();
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      if (d && d.schema && d.render && d.render.mode === "gauge") return d;
    }
    return null;
  }

  /**
   * 取状态灯族的**代表定义**（P4D-01）。
   *
   * 19 个灯 schema 实测完全一致（审计：distinctSignatures === 1），
   * 所以任取一条即可。仍然从 Registry 取，不在 UI 层复制 schema
   * （P4A.1 消除 Schema 双源的教训）。
   */
  function stateLampSchemaFor(node) {
    const Reg = ICAR.registry && ICAR.registry.Control;
    if (!Reg || !Reg.all) return null;

    // ① 新建节点带 __controlKey → 精确
    const key = node && node.__controlKey;
    if (key && Reg.get) {
      const own = Reg.get(key);
      if (own && own.schema && own.render && own.render.mode === "state") return own;
    }
    // ② 回退：任一 state 模式定义（19 条已实测 schema 一致）
    const all = Reg.all();
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      if (d && d.schema && d.render && d.render.mode === "state") return d;
    }
    return null;
  }

  /**
   * 各族的"本阶段开放编辑字段"。
   * 只存路径清单，不碰字段定义（label/type/range 全部来自 Registry）。
   * 推广到新族时只需在此加一行。
   */
  const EDITABLE = {
    track: ["trackStyle.orient", "trackStyle.segments", "trackStyle.glow", "trackStyle.fill"],
    // P4B：文字族第一批只开这 5 个；w/h/rotation/alpha 等仍走旧面板
    text: ["text", "font.size", "font.weight", "font.color", "font.align"],
    // P4C：容器族开 6 个通用变换/图层字段。
    // ⚠️ schema 里还有 scale（第 7 个字段），本阶段**不开放编辑**（按任务只开 6 个）。
    container: ["w", "h", "rotation", "alpha", "locked", "visible"],
    /**
     * P4D-01：状态灯族（19 条）开放字段。
     *
     * ## 为什么是这 9 个
     *
     * Schema 定义里有 11 个字段，但：
     *  · `statePid`   用户改的是**绑定别名**，改完必须同时刷新 statePid/rawStatePid
     *  · `stateWarn` / `stateCritical` 阈值，null = 从 PID 库推断
     *  · 三态素材 3 个 assetId —— 用户可换图
     *  · `states.normal.alpha` / `states.warn.blink` / `states.critical.blink`
     *  · `w` / `h` 尺寸
     *
     * ⚠️ `states.*.blinkMs` **刻意不开放**：WCAG 2.3.1 要求闪烁 ≤3Hz，
     *    开放后用户可把它调到红线以下（历史教训见 schema.js:1313）。
     */
    /**
     * P4E-02 批次 B：仪表族（6 条）第一批**只开 8 个字段**。
     *
     * ⚠️ 刻意**不开放**这 4 个（P4E-01 审计 R3）：
     *    `label` / `unit` / `font.size` / `font.color`
     * 它们在 Registry schema 里声明了，但 `nodeToJson()` **不写**、
     * `parseNode()` **不读** —— 开放出来就是"改了保存不住"的静默失效。
     *
     * 外观类（card*、neonPreset、ringStyle/ringSegments）也不在本批
     * —— 它们不在 schema 的 12 字段内，属扩范围，留给后续批次评审。
     */
    gauge: ["pid", "style", "min", "max", "warnLow", "warnHigh", "w", "h"],
    imageState: [
      "statePid", "stateWarn", "stateCritical",
      "states.normal.assetId", "states.warn.assetId", "states.critical.assetId",
      "states.normal.alpha", "states.warn.blink", "states.critical.blink",
      "w", "h",
    ],
  };
  // ============================================================ 四、PropertyUpdate

  /**
   * 属性变更事务。
   *
   * 关键点（任务第六部分）：
   * - **无变化不 commit**（`Accessor.set` 返回 false 时直接跳过）
   * - **连续拖动合并成一次撤销**：用 `commitQuiet` 节流 ——
   *   拖动过程中只改模型 + 重绘，不压栈；松手（或停止 N ms）时才压一次
   */
  let liveEdit = null;   // { nodeId, startValue, path, timer }

  const PropertyUpdate = {
    /**
     * 开始一次"实时编辑"（滑块拖动 / 连续输入）。
     *
     * 首次调用会记住**拖动前的值**；期间不断调用 `setLive`；
     * 最后 `endLive()` 提交**一次**撤销记录。
     */
    beginLive(node, path) {
      if (liveEdit && liveEdit.nodeId === node.id && liveEdit.path === path) return;
      if (liveEdit) this.endLive();          // 上一段没收尾的先收掉
      liveEdit = {
        nodeId: node.id,
        path: path,
        startValue: clone(PropertyAccessor.get(node, path)),
        lastValue: clone(PropertyAccessor.get(node, path)),
      };
    },

    /** 拖动中：只改模型 + 重绘，**不压撤销栈** */
    setLive(node, path, value) {
      if (!liveEdit) this.beginLive(node, path);
      const changed = PropertyAccessor.set(node, path, value);
      if (!changed) return false;
      liveEdit.lastValue = clone(value);
      if (window.requestDraw) window.requestDraw();
      else if (window.draw) window.draw();
      // P4R-1.2：实时编辑期间也要让草稿系统知道"有未保存改动"。
      //
      // ## 为什么要在这里
      //
      // 原来 markDirty 只挂在 commit 上，而 setLive **不走 commit**
      // （它只改模型 + 重绘，撤销记录由 endLive 压实）——
      // 实测「持续打字 8 秒，草稿写盘 0 次」。
      //
      // ## 为什么用 markLiveDirty 而不是 markDirty
      //
      // markLiveDirty **只标脏 + 起定时器，不创建 UndoStack 记录**，
      // 撤销栈语义完全不变（一次拖动仍只有一条记录）。
      //
      // ## 为什么不会每个字符都序列化
      //
      // 它内部只在"这次是从 clean 变 dirty"时才起定时器，
      // 序列化发生在防抖(1200ms)/最长间隔(5000ms)到期后。
      if (window.ICAR && window.ICAR.ui && window.ICAR.ui.DraftManager) {
        try { window.ICAR.ui.DraftManager.markLiveDirty(); } catch (e) {}
      }
      return true;
    },

    /**
     * 收尾：把"开始值 → 结束值"作为**一次**事务提交。
     *
     * 若值与开始时相同，**不产生撤销记录**。
     */
    endLive(node, path) {
      if (!liveEdit) return false;
      const start = liveEdit.startValue;
      const end = clone(PropertyAccessor.get(node, path));
      const nodeId = liveEdit.nodeId;
      const p = liveEdit.path;
      liveEdit = null;

      if (sameValue(start, end)) return false;   // 拖了一圈回原点 → 不留记录

      // 先把值还原成"拖之前"，再走 commit 应用最终值 ——
      // 这样撤销栈里记的是"一次从 A 到 B 的变更"
      if (typeof window.commit === "function") {
        PropertyAccessor.set(node, p, start);
        window.commit(function () {
          const n = findNodeById(nodeId);
          if (n) PropertyAccessor.set(n, p, end);
        }, "改属性：" + p);
      }
      return true;
    },

    /**
     * 放弃当前 live 事务（Escape / 切换节点 / 节点被删）。
     *
     * 与 endLive 的区别：**不压实、不产生撤销记录**。
     * 若已经把值写进模型，由调用方负责还原（schema-panel 的 cancelEditing 会做）。
     */
    abortLive() {
      liveEdit = null;
    },

    /** 单次离散修改（下拉框 / 复选框）：直接一次事务 */
    setOnce(node, path, value) {
      if (!node) return false;
      const old = PropertyAccessor.get(node, path);
      if (sameValue(old, value)) return false;   // 无变化不 commit
      const nodeId = node.id;
      const changed = PropertyAccessor.set(node, path, value);
      if (!changed) return false;
      if (typeof window.commit === "function") {
        PropertyAccessor.set(node, path, old);
        window.commit(function () {
          const n = findNodeById(nodeId);
          if (n) PropertyAccessor.set(n, path, value);
        }, "改属性：" + path);
      }
      if (window.requestDraw) window.requestDraw();
      else if (window.draw) window.draw();
      return true;
    },
  };

  function clone(v) { return v === null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)); }

  function findNodeById(id) {
    const S = window.CanvasState;
    if (!S || !S.design) return null;
    let found = null;
    (function walk(list) {
      (list || []).forEach(function (n) {
        if (n.id === id) { found = n; return; }
        if (n.children && n.children.length) walk(n.children);
      });
    })(S.design.nodes);
    return found;
  }

  // ============================================================ 五、SchemaRenderer

  /**
   * 生成表单 DOM（**只读模式**只出值不出控件）。
   *
   * 设计取向：整个面板只建一次 DOM（`mount`），后续只**原位更新值**，
   * 不销毁重建 —— 这是解决原 panels.js 全量重建问题的核心。
   */
  const SchemaRenderer = {
    /** 建一次 DOM 骨架 */
    mount(container, schema, opts) {
      const o = opts || {};
      container.innerHTML = "";
      const root = document.createElement("div");
      root.className = "schemaProps";
      root.setAttribute("data-mode", o.readonly ? "readonly" : "edit");

      const inputs = {};
      const groups = {};
      (schema.fields || []).forEach(function (f) {
        const gname = f.group || "常规";
        if (!groups[gname]) {
          const g = document.createElement("div");
          g.className = "spGroup";
          const gt = document.createElement("div");
          gt.className = "spGroupTitle";
          gt.textContent = gname;
          g.appendChild(gt);
          root.appendChild(g);
          groups[gname] = g;
        }
        const row = document.createElement("div");
        row.className = "spRow";
        row.setAttribute("data-path", f.key);

        const lab = document.createElement("label");
        lab.className = "spLabel";
        lab.textContent = f.label;
        row.appendChild(lab);

        const editable = !o.readonly && (schema.editable || []).indexOf(f.key) >= 0;
        let el;
        if (editable) {
          el = buildControl(f);
        } else {
          el = document.createElement("span");
          el.className = "spValue";
        }
        el.setAttribute("data-path", f.key);
        row.appendChild(el);
        groups[gname].appendChild(row);
        inputs[f.key] = { el: el, field: f, editable: editable, row: row };
      });

      container.appendChild(root);
      return { root: root, inputs: inputs };
    },

    /**
     * **原位更新值**（不重建 DOM）。
     *
     * @param {Object} view     mount() 的返回值
     * @param {Object} node     当前节点
     * @param {boolean} skipPath 跳过这个路径（正在编辑的输入框，避免光标跳动）
     */
    update(view, node, skipPath) {
      Object.keys(view.inputs).forEach(function (path) {
        if (path === skipPath) return;
        const it = view.inputs[path];
        const v = PropertyAccessor.get(node, path);
        const f = it.field;
        if (it.editable) {
          const el = it.el;
          if (f.type === "boolean") {
            if (el.checked !== !!v) el.checked = !!v;
          } else if (f.type === "enum") {
            // null 的显示文案
            const s = v === null ? "__null__" : String(v);
            if (el.value !== s) el.value = s;
          } else if (f.type === "color") {
            const s = v === null || v === undefined ? "" : String(v);
            const pk = el.querySelector && el.querySelector('[data-role="picker"]');
            const tx = el.querySelector && el.querySelector('[data-role="text"]');
            if (tx && tx.value !== s) tx.value = s;
            if (pk && /^#[0-9a-fA-F]{6}$/.test(s)) {
              const lower = s.toLowerCase();
              if (pk.value !== lower) pk.value = lower;
            }
          } else {
            const s = v === null || v === undefined ? "" : String(v);
            // ⚠️ 正在输入的框不要改值（会打断光标）—— 由调用方传 skipPath
            if (el.value !== s) el.value = s;
          }
        } else {
          it.el.textContent = formatValue(v);
        }
      });
    },
  };

  function formatValue(v) {
    if (v === null) return "null";
    if (v === undefined) return "无值";
    if (typeof v === "boolean") return v ? "是" : "否";
    return String(v);
  }

  function buildControl(f) {
    let el;
    if (f.type === "boolean") {
      el = document.createElement("input");
      el.type = "checkbox";
      return el;
    }
    // ---- 颜色：色板 + 文本框（P4B）----
    //
    // 只用 `input[type=color]` 不够：它只认 `#RRGGBB`，会把 `$变量引用` 那种
    // 合法值直接抹掉。所以做成**色板 + 文本框**两个控件：
    //   · 色板点选 → 写 #RRGGBB
    //   · 文本框   → 可以手写 #RGB / #RRGGBB / $变量名
    if (f.type === "color") {
      const wrap = document.createElement("span");
      wrap.className = "spColorWrap";
      const picker = document.createElement("input");
      picker.type = "color";
      picker.setAttribute("data-path", f.key);
      picker.setAttribute("data-role", "picker");
      const txt = document.createElement("input");
      txt.type = "text";
      txt.setAttribute("data-path", f.key);
      txt.setAttribute("data-role", "text");
      txt.placeholder = "#RRGGBB / $变量";
      wrap.appendChild(picker);
      wrap.appendChild(txt);
      return wrap;
    }
    if (f.type === "enum") {
      el = document.createElement("select");
      (f.values || []).forEach(function (v) {
        const opt = document.createElement("option");
        opt.value = v === null ? "__null__" : String(v);
        opt.textContent = v === null ? "（无）" : String(v);
        el.appendChild(opt);
      });
      return el;
    }
    el = document.createElement("input");
    el.type = "text";         // 不用 number —— 会吞掉空值语义
    el.inputMode = "decimal";
    return el;
  }

  // ============================================================ 导出

  ICAR.ui = ICAR.ui || {};
  ICAR.ui.schemaProps = {
    SchemaResolver: SchemaResolver,
    SchemaRenderer: SchemaRenderer,
    PropertyAccessor: PropertyAccessor,
    PropertyValidator: PropertyValidator,
    PropertyUpdate: PropertyUpdate,
    /** 测试用 */
    __findNodeById: findNodeById,
    __getLiveEdit: function () { return liveEdit; },
  };
})();
