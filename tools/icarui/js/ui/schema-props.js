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
  const SchemaResolver = {
    /** 持久化能力：代码轨道 = image + 有 trackStyle */
    isTrack(node) {
      return !!node && node.type === "image" && node.trackStyle !== null &&
        typeof node.trackStyle === "object";
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
   * 各族的"本阶段开放编辑字段"。
   * 只存路径清单，不碰字段定义（label/type/range 全部来自 Registry）。
   * 推广到新族时只需在此加一行。
   */
  const EDITABLE = {
    track: ["trackStyle.orient", "trackStyle.segments", "trackStyle.glow", "trackStyle.fill"],
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
