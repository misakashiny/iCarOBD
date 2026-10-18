// ============================================================================
// P4R-2A 隔离原型：撤销历史与草稿的一致性锚点
//
// ⚠️ 本文件是**隔离原型**，不接入正式启动流程。
//    window.ICAR.ui.UndoAnchor 只供测试与后续 P4R-2B 评估使用。
//
// ## 要解决的核心问题
//
// 草稿存的是 `designJson`（`JSON.stringify(design)`），
// 历史存的是 `snapshot()` 的 `{d, sel}` —— **两者格式不同**，
// 不能直接比较 JSON 字符串来判断"是不是同一份设计"。
//
// 所以这里定义**基于设计语义**的锚点：
//   · 只取设计内容（`d`），**不含 selection**
//   · 用与 draft-store 相同的 FNV-1a 校验和
//   · 附加 designId 与 draftRevision
// ============================================================================
(function () {
  "use strict";

  const ICAR = (window.ICAR = window.ICAR || {});
  const ui = (ICAR.ui = ICAR.ui || {});

  /** 历史格式版本（与 localStorage 旧格式区分） */
  const HISTORY_SCHEMA = 2;

  /**
   * 对完整设计语义递归排序后计算原型锚点；selection 不属于 design，因此自然排除。
   * 不能只选一组已知顶层字段，否则 controls、canvas 或将来的字段可能漏进比较。
   */
  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      return "[" + value.map(function (v) {
        return v === undefined ? "null" : stableStringify(v);
      }).join(",") + "]";
    }
    return "{" + Object.keys(value).sort().filter(function (k) {
      return value[k] !== undefined && typeof value[k] !== "function";
    }).map(function (k) {
      return JSON.stringify(k) + ":" + stableStringify(value[k]);
    }).join(",") + "}";
  }

  function designDigest(design) {
    if (!design || typeof design !== "object" || Array.isArray(design)) return null;
    try { return fnv1a(stableStringify(design)); }
    catch (e) { return null; }
  }

  /** 从 snapshot() 的字符串里取出设计内容并算 digest */
  function digestOfSnapshot(snapshotStr) {
    if (typeof snapshotStr !== "string") return null;
    try {
      const o = JSON.parse(snapshotStr);
      if (!o || typeof o !== "object") return null;
      return designDigest(o.d);
    } catch (e) {
      return null;
    }
  }

  /** FNV-1a（与 draft-store 一致，保证两边可比） */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  /**
   * 构建一份带锚点的历史包。
   *
   * @param {object} p
   *   designId       当前设计身份（**不是名字**）
   *   draftRevision  这份历史对应的草稿版本
   *   stack          UndoStack 的 stack（只取 state 字符串）
   *   index          当前 index
   *   label          可选说明
   */
  function build(p) {
    p = p || {};
    const stack = (p.stack || []).map(function (it) {
      return {
        state: it.state,
        label: it.label,
        digest: digestOfSnapshot(it.state),
      };
    });
    const index = Number.isInteger(p.index) ? p.index : stack.length - 1;
    return {
      schema: HISTORY_SCHEMA,
      designId: p.designId,
      draftRevision: p.draftRevision,
      index: index,
      // 当前记录的设计摘要 —— 恢复时用来确认"这份历史确实对应当前设计"
      currentDigest: stack.length && index >= 0 && index < stack.length
        ? stack[index].digest
        : null,
      buildAt: Date.now(),
      sessionId: (ui.DraftStore && ui.DraftStore.SESSION_ID) || null,
      stack: stack,
    };
  }

  /**
   * 校验一份历史包能否安全用于当前设计。
   *
   * ## 返回
   *   `{ ok:true }` —— 可以加载
   *   `{ ok:false, reason, detail }` —— **必须拒绝**，调用方应保持设计、
   *     把撤销基准重置为"恢复后的设计"（任务第九部分的安全优先级：
   *     恢复设计成功 比 恢复完整历史 更重要）
   *
   * ## 判据（全部必须满足）
   *   1. schema 版本匹配
   *   2. designId **严格相等**（禁止用 design.name 匹配）
   *   3. draftRevision 与当前草稿版本一致
   *   4. 当前记录的 digest 与**实际恢复后的设计** digest 一致
   */
  function validate(bundle, ctx) {
    if (!bundle || typeof bundle !== "object") {
      return { ok: false, reason: "empty" };
    }
    // ⚠️ P4R-2B：正式记录用 `historyFormatVersion`（与草稿 schemaVersion 区分），
    //    原型用的是 `schema`。两者都接受，缺一即拒绝 —— 早期只认 `schema`
    //    导致所有正式历史被判 schema-mismatch、永远恢复不了（实测踩过）。
    const ver = (typeof bundle.historyFormatVersion === "number")
      ? bundle.historyFormatVersion
      : bundle.schema;
    if (ver !== HISTORY_SCHEMA) {
      return { ok: false, reason: "schema-mismatch", detail: ver };
    }
    if (!Array.isArray(bundle.stack) || !bundle.stack.length) {
      return { ok: false, reason: "no-stack" };
    }
    // 先验证整条历史链，不能只验证当前 index：否则 redo 分支可能指向
    // 另一份设计或损坏快照，加载后将来 redo 时才跨设计恢复。
    for (let i = 0; i < bundle.stack.length; i++) {
      const entry = bundle.stack[i];
      if (!entry || typeof entry.state !== "string") {
        return { ok: false, reason: "bad-record", detail: { index: i } };
      }
      const observedDigest = digestOfSnapshot(entry.state);
      if (!observedDigest || entry.digest !== observedDigest) {
        return { ok: false, reason: "record-digest-mismatch", detail: { index: i } };
      }
    }
    // ① 身份必须是 designId，且严格相等
    if (!ctx || !ctx.designId) {
      return { ok: false, reason: "no-context-designId" };
    }
    if (bundle.designId !== ctx.designId) {
      return { ok: false, reason: "designId-mismatch",
        detail: { want: ctx.designId, got: bundle.designId } };
    }
    // ② 草稿版本必须存在且一致。
    //    没有草稿版本不能证明历史属于当前设计；安全策略是拒绝，
    //    保留设计并由调用方建立新基准，而不是猜测关联。
    if (typeof ctx.draftRevision !== "number" ||
        typeof bundle.draftRevision !== "number" ||
        bundle.draftRevision !== ctx.draftRevision) {
      return { ok: false, reason: "revision-mismatch",
        detail: { want: ctx.draftRevision, got: bundle.draftRevision } };
    }
    // ③ index 必须是栈内的整数，不能把越界历史悄悄夹到栈顶。
    if (!Number.isInteger(bundle.index) ||
        bundle.index < 0 || bundle.index >= bundle.stack.length) {
      return { ok: false, reason: "index-mismatch" };
    }
    // ④ 当前记录必须与"实际恢复后的设计"一致
    const idx = bundle.index;
    const rec = bundle.stack[idx];
    if (!rec || typeof rec.state !== "string") {
      return { ok: false, reason: "bad-current-record" };
    }
    const actual = designDigest(ctx.design);
    if (!actual) {
      return { ok: false, reason: "no-actual-digest" };
    }
    if (rec.digest !== actual) {
      return { ok: false, reason: "current-mismatch",
        detail: { want: rec.digest, got: actual } };
    }
    return { ok: true, index: idx, usable: bundle.stack.length };
  }

  /**
   * 过滤掉坏记录（state 不是可用快照的）。
   *
   * ⚠️ 与 `loadUndoStack` 同一条原则：坏记录**加载时清掉**，
   * 不要留到"撤销到它才失败"。
   */
  function filterUsable(bundle, isUsable) {
    const good = [];
    (bundle.stack || []).forEach(function (it) {
      if (it && typeof it.state === "string" && (!isUsable || isUsable(it.state))) {
        good.push(it);
      }
    });
    return good;
  }

  ui.UndoAnchor = {
    HISTORY_SCHEMA: HISTORY_SCHEMA,
    designDigest: designDigest,
    digestOfSnapshot: digestOfSnapshot,
    fnv1a: fnv1a,
    build: build,
    validate: validate,
    filterUsable: filterUsable,
  };
})();
