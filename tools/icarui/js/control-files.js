/* Self-contained tool control files; the App design schema is unchanged. */
"use strict";
(function () {
  const MAX_BYTES = 32 * 1024 * 1024;
  function sourceRatio(canvas) {
    if (!canvas || !Number.isFinite(canvas.designW) || !Number.isFinite(canvas.designH) ||
        canvas.designW <= 0 || canvas.designH <= 0 || canvas.designW > 32768 || canvas.designH > 32768 || ![0, 1, 2].includes(canvas.scaleMode)) {
      throw new Error("控件文件的来源画布尺寸无效");
    }
    return canvas.scaleMode === 0 ? canvas.designW / canvas.designH : 1;
  }
  function bitmap(asset) {
    const path = String(asset.path || "").replace(/\\/g, "/");
    if (!path || path.length > 1024 || /^(?:\/|[a-z]+:)/i.test(path) || path.split("/").some(p => p.trim() === ".." || !p) || /[\x00-\x1f]/.test(path)) {
      throw new Error("素材路径不安全");
    }
    const data = String(asset.data || "");
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
    if (!m || m[2].length > 12 * 1024 * 1024) throw new Error("控件素材必须是完整的PNG/JPEG/WebP位图，单张不超过8MB");
    const bytes = atob(m[2]);
    const png = bytes.slice(0, 8) === "\x89PNG\r\n\x1a\n";
    const jpeg = bytes.charCodeAt(0) === 255 && bytes.charCodeAt(1) === 216;
    const webp = bytes.slice(0, 4) === "RIFF" && bytes.slice(8, 12) === "WEBP";
    if (bytes.length > 8 * 1024 * 1024 || !(m[1] === "png" ? png : m[1] === "jpeg" ? jpeg : webp)) throw new Error("控件素材内容与位图类型不一致");
    return { asset: { id: String(asset.id || ""), name: String(asset.name || "素材"), kind: String(asset.kind || "custom"),
      path, data, w: Number(asset.w) || 0, h: Number(asset.h) || 0 }, size: bytes.length };
  }
  // Include state images and nested gauge parts, not just the first visible image.
  function visit(value, fn, depth, budget) {
    budget = budget || { count: 0 };
    if (++budget.count > 65536) throw new Error("控件结构过大");
    if (!value || typeof value !== "object") return;
    if (depth > 64) throw new Error("控件嵌套过深");
    if (Array.isArray(value)) { value.forEach(v => visit(v, fn, depth + 1, budget)); return; }
    fn(value);
    Object.values(value).forEach(v => visit(v, fn, depth + 1, budget));
  }
  function checkFields(node) {
    visit(node, o => {
      for (const key of ["name", "label", "id", "assetId", "pid", "rawPid", "statePid", "rawStatePid"]) {
        if (typeof o[key] === "string" && o[key].length > 256) throw new Error("控件名称或标识过长，请缩短后再导入");
      }
      if (typeof o.text === "string" && o.text.length > 4096) throw new Error("控件文字过长，请拆分文字");
      if (o.type === "image" && !o.assetId) throw new Error("控件图片还没选择素材");
    }, 0);
  }
  window.makeControlFile = function (node, design) {
    sourceRatio(design.canvas);
    checkFields(node);
    const list = design.assets || [], ids = new Set();
    visit(node, o => { if (o.assetId) ids.add(o.assetId); }, 0);
    const assets = [], originals = window.NEXT_LIBRARY ? window.NEXT_LIBRARY.assets : [];
    let size = 0;
    ids.forEach(id => {
      const a = list.find(a => a.id === id);
      if (!a) throw new Error("控件引用的素材不存在，请先补齐图片");
      const built = originals.concat(window.BUILTIN_ASSETS || []).find(b => b.path === a.path);
      const checked = bitmap({ ...a, data: a.data || (built && built.data) });
      size += checked.size; assets.push(checked.asset);
    });
    if (size > MAX_BYTES || assets.length > 128) throw new Error("控件素材过多或超过32MB");
    return { schema: window.SCHEMA_V2, kind: "icar.control/2", name: node.name,
      canvas: { designW: design.canvas.designW, designH: design.canvas.designH, scaleMode: design.canvas.scaleMode },
      node: window.nodeToJson(node), assets };
  };
  function fontScale(font, k) {
    if (!font) return;
    for (const key of ["size", "letterSpacing"]) if (Number.isFinite(font[key])) font[key] *= k;
  }
  function partScale(part, k) {
    for (const key of ["x", "y", "w", "h"]) if (Number.isFinite(part[key])) part[key] *= k;
    fontScale(part.font, k);
    (part.children || []).forEach(p => partScale(p, k));
  }
  function migrate(node, xScale, nativeScale) {
    const cx = (node.x + node.w / 2) * xScale, cy = node.y + node.h / 2;
    if (node.type === "image" || node.type === "group") node.w *= xScale;
    else {
      node.w *= nativeScale; node.h *= nativeScale;
      fontScale(node.font, nativeScale); fontScale(node.labelFont, nativeScale);
      (node.parts || []).forEach(p => partScale(p, nativeScale));
    }
    node.x = cx - node.w / 2; node.y = cy - node.h / 2;
    (node.children || []).forEach(n => migrate(n, xScale, nativeScale));
  }
  window.prepareControlFile = async function (payload, design) {
    if (!payload || !payload.node || ![undefined, "icar.control/1", "icar.control/2"].includes(payload.kind)) throw new Error("不是支持的控件文件");
    const modern = payload.kind === "icar.control/2";
    checkFields(payload.node);
    if (typeof payload.name === "string" && payload.name.length > 256) throw new Error("控件名称过长");
    if (modern) sourceRatio(payload.canvas);
    const rawAssets = modern ? payload.assets : [];
    if (modern && (!Array.isArray(rawAssets) || rawAssets.length > 128)) throw new Error("控件素材清单无效");
    const incoming = [], ids = new Set(); let total = 0;
    (rawAssets || []).forEach(a => {
      const checked = bitmap(a); total += checked.size;
      if (!checked.asset.id || ids.has(checked.asset.id)) throw new Error("素材ID为空或重复");
      ids.add(checked.asset.id); incoming.push(checked.asset);
    });
    if (total > MAX_BYTES) throw new Error("控件素材超过32MB");
    let pixels = 0;
    for (const a of incoming) {
      await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = async () => {
          if (!image.naturalWidth || image.naturalWidth > 8192 || image.naturalHeight > 8192 ||
              image.naturalWidth * image.naturalHeight > 16777216) { reject(new Error("素材尺寸无效或过大")); return; }
          pixels += image.naturalWidth * image.naturalHeight;
          if (pixels > 33554432) { reject(new Error("控件图片像素合计过大，请先缩小图片再导入")); return; }
          try { await image.decode(); }
          catch (e) { reject(new Error("控件图片无法解码")); return; }
          a.w = image.naturalWidth; a.h = image.naturalHeight; resolve();
        };
        image.onerror = () => reject(new Error("控件图片无法解码")); image.src = a.data;
      });
    }
    const available = modern ? incoming : (design.assets || []);
    visit(payload.node, o => { if (o.assetId && !available.some(a => a.id === o.assetId)) throw new Error("控件文件缺少图片，请从原设计重新导出完整控件"); }, 0);
    const probe = window.parseDesign(JSON.stringify({ schema: window.SCHEMA_V2,
      canvas: { unit: 360, ...design.canvas }, assets: available,
      controls: [{ id: "probe", name: payload.name || "导入的控件", node: payload.node }],
      nodes: [{ id:"control_probe",type:"gauge",pid:"obd.rpm",min:0,max:8000,w:10,h:10,x:0,y:0 }] }));
    if (probe.errors.length) throw new Error(probe.errors[0]);
    const control = probe.design.controls[0], remap = new Map();
    const occupied = new Set((design.assets || []).map(a => a.id));
    incoming.forEach(a => {
      let id, attempts = 0;
      do {
        id = window.newId("as");
        if (++attempts > 32) throw new Error("无法分配唯一素材编号，请重试");
      } while (occupied.has(id));
      occupied.add(id); remap.set(a.id, id); a.id = id;
      const collision = (design.assets || []).concat(incoming.filter(b => b !== a))
        .some(b => b.path === a.path && b.data !== a.data);
      if (collision) a.path = "assets/imported-controls/" + id + "." + /^data:image\/(\w+)/.exec(a.data)[1];
    });
    visit(control.node, o => { if (o.assetId && remap.has(o.assetId)) o.assetId = remap.get(o.assetId); }, 0);
    if (modern) {
      const from = sourceRatio(payload.canvas), to = sourceRatio(design.canvas);
      migrate(control.node, from / to, Math.min(from, 1) / Math.min(to, 1));
    }
    return { control, assets: incoming };
  };
})();
