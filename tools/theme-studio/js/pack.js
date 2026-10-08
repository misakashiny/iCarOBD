/* ==========================================================================
   pack.js —— 「设计包（.icarzip）」的**纯逻辑**部分
   --------------------------------------------------------------------------
   ## 这个文件解决什么问题

   设计文件里的素材是**相对路径**（`assets/xx.png`），而 App 侧导入走 SAF
   **单文件** —— 拿不到它旁边的 `assets/` 目录，于是 `designBaseDir` 永远是空
   → **所有素材加载失败** → 由控件（素材图片）拼出来的表盘只剩空卡片。
   用户报的「画布不显示我做好的内容、显示是空的」就是这个
   （见 docs/CHANGELOG.md v1.20.3）。

   修法是工具侧能独立完成的那一半：**导出一个自包含的包**
   （`design.json` + 只打包真正引用到的素材 + `manifest.json`），
   App 侧只要解开这一个文件就能拿到全部素材。

   ## 为什么把"纯逻辑"单独放一个文件

   这里**没有任何 DOM / FileReader / Blob 调用** —— 输入是普通对象，
   输出是普通对象。于是：
     · 浏览器里由 `app.js` 调（负责真的读字节）
     · **Node 里由测试直接调**（不用开浏览器就能测"引用收集对不对"）

   而且 `resolveDesignPackage` 把"读字节"做成**注入的回调**
   （`readBytes`）—— 这样"哪些素材被引用了"与"字节从哪来"是两件事，
   前者可以在 Node 里穷举各种边界（多页面 / 状态 / 子部件 / 背景）。
   ========================================================================== */
(function (root) {
  "use strict";

  /**
   * 包格式版本。
   *
   * ⚠️ **它与 `icar.ui/2` 不是一回事**：
   *   `icar.ui/2` 是**设计文件**的格式（App 的 DesignFile 解析它）
   *   `icar.pack/1` 是**包**的格式（解压后按 manifest 校验素材）
   *
   * 分开是因为它们的演进节奏不同 —— 设计文件格式要 App 跟着改，
   * 而包格式只影响"导入"这一步。合成一个版本号会让两者互相绑架。
   */
  const PACK_FORMAT = "icar.pack/1";

  /** 包内固定条目名 */
  const DESIGN_ENTRY = "design.json";
  const MANIFEST_ENTRY = "manifest.json";

  /** 引用来源的分类（写进清单，便于人排查"这个素材是谁在用的"） */
  const REF_NODE = "node";           // 图片节点 / 状态
  const REF_PART = "part";           // 拼装表的子部件
  const REF_BACKGROUND = "background"; // 背景图

  // ---------------------------------------------------------------- 引用收集

  /**
   * 收集一份设计里**真正引用到**的素材路径。
   *
   * ## 为什么不是"把 assets[] 全打包"
   *
   * `assets[]` 是**素材清单**，它会留着用户试过又删掉的图（设计里已经不引用了）。
   * 全打包的后果：一个 5 个表的盘面可能带出 300 多个文件、几十 MB，
   * 而设备上真正要用的只有 12 个。用户看到包那么大只会以为工具坏了。
   *
   * ## 收集哪些地方（**一个都不能漏**）
   *
   * | 位置 | 为什么容易漏 |
   * |---|---|
   * | `nodes[].assetId` | 图片节点，最明显 |
   * | `nodes[].states.*.assetId` | **状态系统**：三态图是**三个**不同素材，漏了就只有常态能显示 |
   * | `nodes[].parts[].assetId` | **拼装表**：表盘/刻度/指针全是素材 |
   * | `parts[].children[].assetId` | 子部件是递归的 |
   * | `background.path` | 背景图**不在 assets[] 里**（它只写路径），最容易被整个忘掉 |
   * | 全部页面 | `pages[]` 的每一页，不只是当前页 |
   *
   * @param {object} design 工具内部的设计对象（不是 JSON 文本）
   * @param {function(string):object|null} findAssetById assetId → asset 对象
   * @param {function(string):object|null} findAssetByPath path → asset 对象
   * @returns {Array<{path,assetId,refs:string[]}>} 按 path 排序去重
   */
  function collectAssetRefs(design, findAssetById, findAssetByPath) {
    const d = design || {};
    const byId = findAssetById || function () { return null; };
    const byPath = findAssetByPath || function () { return null; };

    /** path → { path, assetId, refs:Set } */
    const found = new Map();

    function addPath(path, assetId, ref) {
      const p = normPath(path);
      if (!p) return;
      let e = found.get(p);
      if (!e) { e = { path: p, assetId: "", refs: [] }; found.set(p, e); }
      if (!e.assetId && assetId) e.assetId = assetId;
      if (e.refs.indexOf(ref) < 0) e.refs.push(ref);
    }

    /** assetId → 路径；查不到就返回空（校验器会另外报"引用的素材不在清单里"） */
    function addAssetId(assetId, ref) {
      const id = String(assetId || "");
      if (!id) return;
      const a = byId(id);
      if (!a) return;                 // 不在清单里 —— 由 validate.js 报，这里不重复报
      addPath(a.path, id, ref);
    }

    function walkNodes(nodes) {
      (nodes || []).forEach(function (n) {
        if (!n || typeof n !== "object") return;
        addAssetId(n.assetId, REF_NODE);
        // 状态系统：normal / warn / critical 各是一张图
        if (n.states && typeof n.states === "object") {
          Object.keys(n.states).forEach(function (k) {
            const st = n.states[k];
            if (st && typeof st === "object") addAssetId(st.assetId, REF_NODE);
          });
        }
        if (Array.isArray(n.parts)) walkParts(n.parts);
        if (Array.isArray(n.children)) walkNodes(n.children);
      });
    }

    function walkParts(parts) {
      (parts || []).forEach(function (p) {
        if (!p || typeof p !== "object") return;
        addAssetId(p.assetId, REF_PART);
        if (Array.isArray(p.children)) walkParts(p.children);
      });
    }

    // ⚠️ **每一页都要走**。只走 `design.nodes` 的话，非当前页用到的素材
    // 不会进包 —— 症状是"翻到第二页全是空卡片"，而且**第一页完全正常**，
    // 极难联想到是打包漏了。
    const pages = Array.isArray(d.pages) && d.pages.length
      ? d.pages.map(function (pg) { return pg && pg.nodes; })
      : [];
    if (pages.length) pages.forEach(walkNodes);
    // `design.nodes` 与当前页是**同一个数组引用**（model.js 的设计），
    // 所以这里不会重复收集；但为防将来有人解开这个引用，仍然走一遍
    // （addPath 会去重）。
    walkNodes(d.nodes);

    // 背景图：只有 path，**没有 assetId**
    if (d.background && d.background.path) {
      const bp = normPath(d.background.path);
      const a = byPath(bp);
      addPath(bp, a ? a.id : "", REF_BACKGROUND);
    }

    const out = [];
    found.forEach(function (e) {
      out.push({ path: e.path, assetId: e.assetId, refs: e.refs.sort() });
    });
    out.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
    return out;
  }

  /**
   * 路径归一化。
   *
   * 统一成正斜杠、去掉 `./` 前缀 —— 否则 `assets/a.png` 与 `./assets/a.png`
   * 会被当成两个素材，包里出现两份同样的图（还各占一条清单）。
   * **不做**大小写折叠：Linux/Android 是大小写敏感的，折叠会把两个真实
   * 不同的文件合并成一个（那更糟）。
   */
  function normPath(p) {
    return String(p == null ? "" : p)
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/{2,}/g, "/");
  }

  // ---------------------------------------------------------------- 打包

  /**
   * 组装设计包的全部内容（**除字节读取外的所有决定都在这里**）。
   *
   * @param {object} args
   *   @param {object}   args.design      工具内部设计对象
   *   @param {string}   args.designJson  已经序列化好的 design.json 文本
   *   @param {string}   args.now         ISO 时间串（**注入**，便于测试固定）
   *   @param {function} args.readBytes   async (ref) => {bytes:Uint8Array, size, crc, missing?}
   *                                      ref = {path, assetId, refs}
   *   @param {function} args.crc32       (bytes) => number（来自 zip.js，避免重复实现）
   * @returns {Promise<{entries:Array, manifest:object, missing:Array, refs:Array}>}
   *   `entries` 顺序**固定**：design.json → 素材（按路径）→ manifest.json。
   *   固定顺序是为了让"同一个设计导出两次"的内容可复现（除时间戳外逐字节相同）。
   */
  async function buildPackage(args) {
    const design = args.design || {};
    const crc32 = args.crc32;
    if (typeof crc32 !== "function") throw new Error("buildPackage: 需要传入 crc32");

    const list = Array.isArray(design.assets) ? design.assets : [];
    const byId = function (id) { return list.find(function (a) { return a.id === id; }) || null; };
    const byPath = function (p) { return list.find(function (a) { return normPath(a.path) === normPath(p); }) || null; };

    const refs = collectAssetRefs(design, byId, byPath);

    // design.json 放在**第一个**：解压出来先看到它，符合直觉
    const entries = [{ name: DESIGN_ENTRY, data: args.designJson }];

    const manifestAssets = [];
    const missing = [];

    for (const ref of refs) {
      // 包内路径 = 设计里写的相对路径（`assets/xx.png`）——
      // 这样解压后目录结构与设计文件里的引用**天然一致**，
      // App 侧只要把 designBaseDir 指到解压目录就能按原样解析。
      let got = null;
      try { got = await args.readBytes(ref); }
      catch (e) { got = { missing: (e && e.message) || String(e) }; }

      if (!got || !got.bytes || got.missing) {
        // ⚠️ **不静默跳过**。"素材没进包"必须在导出时就说出来 ——
        // 否则用户把包推到设备上才发现少了几张图，而那时已经离原因很远了。
        missing.push({ path: ref.path, reason: (got && got.missing) || "读不到字节" });
        continue;
      }
      const bytes = got.bytes;
      const crc = crc32(bytes);
      entries.push({ name: ref.path, data: bytes });
      manifestAssets.push({
        path: ref.path,
        assetId: ref.assetId || "",
        refs: ref.refs,
        bytes: bytes.length,
        crc32: crc >>> 0,
        w: got.w || 0,
        h: got.h || 0,
      });
    }

    const meta = design.meta || {};
    const canvas = design.canvas || {};
    const manifest = {
      format: PACK_FORMAT,
      // 设计文件自己的格式版本 —— 解压端要拿它判断"这份 design.json 我认不认"
      designSchema: root.SCHEMA_V2 || "icar.ui/2",
      design: {
        name: design.name || meta.name || "未命名设计",
        author: design.author || meta.author || "",
        description: design.description || meta.description || "",
        theme: design.themeId || "",
        designW: canvas.designW || 0,
        designH: canvas.designH || 0,
        scaleMode: canvas.scaleMode || 0,
      },
      // ⚠️ 导出时间**不参与**可复现性承诺（zip 条目时间戳固定为 1980），
      // 它只是给人看的："这个包是什么时候导的"
      exportedAt: args.now || "",
      entry: DESIGN_ENTRY,
      assets: manifestAssets,
      // 没进包的素材也如实写进清单 —— 解压端/用户都能一眼看到"缺了什么"
      missing: missing,
      counts: {
        assets: manifestAssets.length,
        missing: missing.length,
        entries: entries.length + 1,   // + manifest.json 自己
      },
    };

    entries.push({ name: MANIFEST_ENTRY, data: JSON.stringify(manifest, null, 2) });
    return { entries: entries, manifest: manifest, missing: missing, refs: refs };
  }

  /**
   * 包文件名：`<设计名>.icarzip`
   *
   * ## 为什么用 `.icarzip` 而不是 `.zip`
   *
   * 它**就是** zip（同目录下双击也能解压），但换个扩展名有两个好处：
   *   1. 用户一眼知道"这是给 App 导入的包"，不是随便一个压缩包
   *   2. 将来若真要换成非 zip 的容器，扩展名已经区分开了，不会与普通 zip 混
   *
   * 文件名要过一遍非法字符清洗 —— Windows 上 `\ / : * ? " < > |` 不能进文件名，
   * 而设计名是用户随便填的。
   */
  function packageFileName(designName) {
    const base = String(designName || "design")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/[\r\n\t]/g, " ")
      .trim() || "design";
    return base + ".icarzip";
  }

  const api = {
    PACK_FORMAT: PACK_FORMAT,
    DESIGN_ENTRY: DESIGN_ENTRY,
    MANIFEST_ENTRY: MANIFEST_ENTRY,
    REF_NODE: REF_NODE,
    REF_PART: REF_PART,
    REF_BACKGROUND: REF_BACKGROUND,
    collectAssetRefs: collectAssetRefs,
    buildPackage: buildPackage,
    packageFileName: packageFileName,
    normPath: normPath,
  };

  root.PackKit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
