// ============================================================================
// 测试套件的公共前置（v2.35.0）
//
// 文件名以 `_` 开头 —— `run-browser-tests.ps1` 匹配的是 `verify-*.js`，
// 所以这个文件不会被当成一个套件去跑。
// ============================================================================

/**
 * **把三个原生弹窗 stub 掉**。
 *
 * ## 为什么必须在"任何可能触发它的操作之前"调用
 *
 * `window.alert()` 在 headless Chrome 里会**阻塞整个渲染进程** ——
 * CDP 的 `Runtime.evaluate` 于是永远等不到响应，表现成"求值超时"。
 *
 * 而且**症状离原因很远**：v2.34.0 那次，报错是"第 3 节的第一个求值超时"，
 * 而那个求值只是读个 `.length`，看起来跟弹窗毫无关系。
 *
 * 真正的原因链条：
 *
 * ```
 * 重名测试 → addAssetKind() → 命中"已经有这个分类了" → window.alert(...)
 *                                                          ↓
 *                                               渲染进程卡死 → CDP 超时
 * ```
 *
 * ## 教训
 *
 * **stub 要放在"任何可能触发它的操作之前"，不是"用到之前"。**
 * 前者一次搞定，后者迟早漏一个 —— 我当时就是只在后面某个用例里 stub 了
 * `alert`，而重名那条先执行、先卡死了。
 *
 * @param {object} cdp 已连接的 CDP 客户端（要有 `eval`）
 */
async function stubDialogs(cdp) {
  await cdp.eval(
    'window.__DIALOGS_STUBBED = 1;' +
    // alert：什么都不做（它返回值没意义）
    'window.alert = function () {};' +
    // confirm：默认"确定"。要测"取消"的用例自己临时覆盖。
    'window.confirm = function () { return true; };' +
    // prompt：默认"取消"（返回 null）。要输入的用例自己临时覆盖。
    'window.prompt = function () { return null; };' +
    '1'
  );
}

/**
 * **极简 PNG 解码器**（8 位、非隔行、colorType 0/2/3/4/6）。
 *
 * ## 为什么测试里需要一个解码器
 *
 * 素材的"坏了"有一类是**像素级**的，页面里看不出来：
 * 图能加载、尺寸正确、`naturalWidth > 0`、清单里也在 —— 但**整张图全透明**，
 * 画到深色底上什么都不显示。`verify-asset-audit.js` 的"预览不是空白"那条
 * 靠一张 `OVERLAY` 白名单把 `vignette` 放过去了，于是**真实存在的空图被漏掉**
 * （实测：7 个素材 0 个不透明像素，其中 `assets/background/vignette.png`
 * 正被控件 `img_bgvign` 引用）。
 *
 * 所以这里要一个**不看名字、只看像素**的判据：数一数有多少个 `alpha > 0`。
 *
 * 只在 Node 侧用（读磁盘上的 PNG），不进浏览器 —— 359 个素材逐个 `Image` 解码
 * 会把渲染进程占住几十秒（`verify-cats.js` 记过这个坑）。
 *
 * @returns {{w:number,h:number,rgba:Buffer}|null} 解不出来返回 null
 */
function decodePng(buf) {
  const zlib = require('zlib');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let plte = null, trns = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  // 生成器只写 8 位非隔行（png.js 的 encodePng），其余形态一律不认 —— 返回 null
  if (interlace !== 0 || bitDepth !== 8) return null;
  const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!CH || !idat.length) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return null; }
  const bpp = CH, stride = w * bpp, out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * bpp, d = i * 4;
    if (colorType === 6) { rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3]; }
    else if (colorType === 2) { rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = 255; }
    else if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = 255; }
    else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]; rgba[d + 3] = out[s + 1]; }
    else if (colorType === 3) {
      const p = out[s] * 3;
      rgba[d] = plte[p]; rgba[d + 1] = plte[p + 1]; rgba[d + 2] = plte[p + 2];
      rgba[d + 3] = (trns && out[s] < trns.length) ? trns[out[s]] : 255;
    }
  }
  return { w: w, h: h, rgba: rgba };
}

/** 一张 PNG 里有多少个 `alpha > 0` 的像素。解不出来返回 -1（**不等于 0**，别混） */
function opaquePixels(buf) {
  const img = decodePng(buf);
  if (!img) return -1;
  let n = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] > 0) n++;
  return n;
}

module.exports = { stubDialogs, decodePng, opaquePixels };
