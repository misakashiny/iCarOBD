/* ==========================================================================
   zip.js —— 极简 ZIP 写入器（**只做 store，不压缩**）+ CRC32 + 读回校验
   --------------------------------------------------------------------------
   ## 为什么要自己写

   工具是"**双击 index.html 就能用**"的零安装形态（README 里写明不许引入需要
   构建的依赖）。所以不能引 JSZip / fflate 这类库 —— 引了就得带 vendor 目录、
   还得跟着升级。本文件与 `png.js` 是同一个套路：**格式本身很简单，自己写**。

   ## 为什么"不压缩"是够的

   包里的东西是 **PNG/JPEG** —— 它们**本身已经压过了**，再 deflate 一遍
   收益常常是负数（大图的 IDAT 已经接近熵极限）。而 store（method=0）
   只要写本地文件头 + 原始字节 + 中央目录 + EOCD，不需要 deflate 实现。
   `design.json` / `manifest.json` 是文本，不压会大一点（几 KB 量级），
   对"设计包"这个用途可以忽略。

   > 代价要说清楚：**包会比"压缩过的 zip"大一些**（就是里面图片的原始大小之和）。
   > 换来的是**零依赖 + 可读性**（出问题时能一眼看懂每个字节）。

   ## ⚠️ 三个写 ZIP 时最容易踩的坑（都已在代码里规避）

   1. **CRC32 必须按"无符号"做移位**：JS 的 `>>>` 才是逻辑右移。
      写成 `>>` 的话最高位会被符号位带进来，CRC 从第一个字节起就错，
      而**解压软件只会说"文件损坏"**，不会告诉你是哪一步错的。
   2. **UTF-8 文件名要置通用位 11**（`0x0800`）。中文素材名（`背景/carbon.png`）
      不置这一位时，Windows 资源管理器会用本地代码页去猜 → 乱码。
      Android 的 ZipInputStream 认这一位（不认也只会当字节串，不影响我们按名取）。
   3. **中央目录里的偏移是"本地头起点"的偏移**，不是"数据"的偏移。
      写错的话 zip 结构仍然"看起来合法"，但解压出来的内容是错的。

   ## 读回校验

   本文件**同时提供读取**（`readZip`），因为任务要求"导出后用测试框架把 zip
   读回来自检"。校验必须**独立于写入路径**才有意义 —— 所以 `readZip` 是
   重新按偏移解析中央目录的，**不读写入时的中间变量**。
   ========================================================================== */
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- CRC32

  /**
   * CRC32 查表（多项式 0xEDB88320，与 ZIP / PNG 用的是同一条）。
   *
   * 与 `png.js` 里那份是同一个算法 —— **刻意各留一份**：png.js 是给
   * Node 侧生成素材用的（CommonJS），本文件要能在浏览器里跑。
   * 为了不引入"构建/打包"而复制 20 行，比搞一个共享模块更符合本工具的形态。
   */
  const CRC_TABLE = (function () {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  /**
   * @param {Uint8Array|Array<number>} buf
   * @returns {number} 无符号 32 位 CRC
   */
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------------------------------------------------------------- 字节工具

  const _enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  /**
   * 字符串 → UTF-8 字节。
   *
   * ⚠️ **不用 `unescape(encodeURIComponent(s))`**（老写法）—— 它在遇到
   * 落单的代理项（半个 emoji）时会抛 URIError，而素材名来自用户文件系统，
   * 什么字节都可能有。TextEncoder 对落单代理项写成 U+FFFD，不抛异常。
   * 两种运行环境（浏览器 / Node ≥ 11）都有 TextEncoder。
   */
  function utf8(s) {
    if (_enc) return _enc.encode(String(s));
    const out = [];
    const str = String(s);
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          c = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
          i++;
          out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        } else out.push(0xEF, 0xBF, 0xBD);
      } else if (c >= 0xD800 && c <= 0xDFFF) out.push(0xEF, 0xBF, 0xBD);
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  /** UTF-8 字节 → 字符串（读回校验时把文件名还原出来比对） */
  function fromUtf8(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    // 先按 latin1 拼成串，再交给 decodeURIComponent 解 UTF-8。
    // 落单字节会被 %XX 保留（不会抛），所以这里能容忍坏数据。
    try {
      return decodeURIComponent(s.replace(/[^\x00-\x7F]/g, ch =>
        "%" + ch.charCodeAt(0).toString(16).padStart(2, "0")));
    } catch (e) {
      return s;   // 解不开就退回原始字节串（校验时会被报出来，比抛异常好）
    }
  }

  /** 把各种"字节来源"统一成 Uint8Array */
  function toBytes(v) {
    if (v == null) return new Uint8Array(0);
    if (v instanceof Uint8Array) return v;
    if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(v)) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (typeof v === "string") return utf8(v);
    if (Array.isArray(v)) return new Uint8Array(v);
    throw new Error("buildZip: 不认识的数据类型（" + Object.prototype.toString.call(v) + "）");
  }

  // ---------------------------------------------------------------- 写入

  /** ZIP 结构里用到的几个常量（写清楚，免得看数字猜） */
  const SIG_LOCAL = 0x04034b50;      // 本地文件头
  const SIG_CENTRAL = 0x02014b50;    // 中央目录项
  const SIG_EOCD = 0x06054b50;       // 中央目录结束记录
  const VERSION_STORE = 10;          // 1.0 = 只用 store
  const VERSION_MADE_BY = 20;        // 2.0（MS-DOS 属性位 + 无扩展）
  const FLAG_UTF8 = 0x0800;          // 通用位 11：文件名是 UTF-8
  const METHOD_STORE = 0;
  /**
   * 固定时间戳：**刻意不写"当前时间"**。
   *
   * 理由：同一个设计导出两次应该**逐字节相同**（测试要能直接比字节，
   * 用户也能用哈希判断"这个包是不是我刚导出的那份"）。
   * 写当前时间的话每次导出都不一样，那种比对就没法做了。
   *
   * 值 = 1980-01-01 00:00:00（DOS 时间的最小合法值，ZIP 的纪元）。
   */
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1;     // 年偏移 0（1980）、月 1、日 1

  /** 小端写入工具（ZIP 全是小端） */
  function w16(buf, off, v) { buf[off] = v & 0xFF; buf[off + 1] = (v >>> 8) & 0xFF; }
  function w32(buf, off, v) {
    buf[off] = v & 0xFF; buf[off + 1] = (v >>> 8) & 0xFF;
    buf[off + 2] = (v >>> 16) & 0xFF; buf[off + 3] = (v >>> 24) & 0xFF;
  }

  /**
   * 归一化条目名。
   *
   * - 反斜杠一律转成正斜杠（ZIP 规范只认 `/`；Windows 的 `\` 会让
   *   Android 侧解压出一个**名字里带反斜杠的文件**，等于素材丢了）
   * - 去掉开头的 `/`（绝对路径在 zip 里没有意义，还会被某些解压器拒绝）
   * - 拒绝 `..`：**zip slip**（解压时用 `../` 覆盖到目录外）是解压端的安全问题，
   *   写入端就不该产出这种名字
   */
  function normalizeName(name) {
    let n = String(name == null ? "" : name).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!n) throw new Error("buildZip: 条目名不能为空");
    if (n.split("/").some(seg => seg === "..")) {
      throw new Error("buildZip: 条目名不允许含 `..`（zip slip）：" + name);
    }
    return n;
  }

  /**
   * 打包。
   *
   * @param {Array<{name:string, data:Uint8Array|string|ArrayBuffer}>} entries
   *        顺序即 zip 里的顺序（**调用方负责排序**，这样输出可复现）
   * @returns {{bytes: Uint8Array, entries: Array<{name,size,crc,offset}>}}
   *         `entries` 是写入时的账本，**只给调用方打印用**；
   *         校验必须走 `readZip`（独立解析），不许拿它当证据。
   */
  function buildZip(entries) {
    if (!entries || !entries.length) throw new Error("buildZip: 至少要有一个条目");
    if (entries.length > 0xFFFF) throw new Error("buildZip: 条目数超过 65535（需要 zip64，本工具不做）");

    const seen = Object.create(null);
    const parts = [];
    const ledger = [];
    let offset = 0;

    for (const e of entries) {
      const name = normalizeName(e.name);
      if (seen[name]) throw new Error("buildZip: 条目名重复：" + name);
      seen[name] = 1;

      const data = toBytes(e.data);
      const nameBytes = utf8(name);
      const crc = crc32(data);

      const head = new Uint8Array(30);
      w32(head, 0, SIG_LOCAL);
      w16(head, 4, VERSION_STORE);
      w16(head, 6, FLAG_UTF8);
      w16(head, 8, METHOD_STORE);
      w16(head, 10, DOS_TIME);
      w16(head, 12, DOS_DATE);
      w32(head, 14, crc);
      w32(head, 18, data.length);        // 压缩后大小 = 原大小（store）
      w32(head, 22, data.length);        // 原大小
      w16(head, 26, nameBytes.length);
      w16(head, 28, 0);                  // 扩展区长度

      parts.push(head, nameBytes, data);
      ledger.push({ name: name, size: data.length, crc: crc, offset: offset });
      offset += head.length + nameBytes.length + data.length;
    }

    // ---- 中央目录
    const cdStart = offset;
    for (const it of ledger) {
      const nameBytes = utf8(it.name);
      const rec = new Uint8Array(46);
      w32(rec, 0, SIG_CENTRAL);
      w16(rec, 4, VERSION_MADE_BY);      // 制作版本
      w16(rec, 6, VERSION_STORE);        // 解压所需版本
      w16(rec, 8, FLAG_UTF8);
      w16(rec, 10, METHOD_STORE);
      w16(rec, 12, DOS_TIME);
      w16(rec, 14, DOS_DATE);
      w32(rec, 16, it.crc);
      w32(rec, 20, it.size);
      w32(rec, 24, it.size);
      w16(rec, 28, nameBytes.length);
      w16(rec, 30, 0);                   // 扩展区
      w16(rec, 32, 0);                   // 注释
      w16(rec, 34, 0);                   // 起始磁盘号
      w16(rec, 36, 0);                   // 内部属性
      w32(rec, 38, 0);                   // 外部属性（不用 DOS 属性位）
      w32(rec, 42, it.offset);           // ⚠️ 本地头起点，不是数据起点
      parts.push(rec, nameBytes);
      offset += rec.length + nameBytes.length;
    }
    const cdSize = offset - cdStart;

    // ---- EOCD
    const eocd = new Uint8Array(22);
    w32(eocd, 0, SIG_EOCD);
    w16(eocd, 4, 0);                     // 本磁盘号
    w16(eocd, 6, 0);                     // 中央目录起始磁盘号
    w16(eocd, 8, ledger.length);         // 本磁盘条目数
    w16(eocd, 10, ledger.length);        // 总条目数
    w32(eocd, 12, cdSize);
    w32(eocd, 16, cdStart);
    w16(eocd, 20, 0);                    // 注释长度
    parts.push(eocd);

    return { bytes: concat(parts), entries: ledger };
  }

  function concat(list) {
    let total = 0;
    for (const p of list) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of list) { out.set(p, off); off += p.length; }
    return out;
  }

  // ---------------------------------------------------------------- 读回

  /**
   * 解析一份 zip 的**中央目录**，并把每个条目的数据切片拿出来。
   *
   * 这是给自检用的：它**只依赖 EOCD 里的 cdStart / 条目数**去定位中央目录，
   * 再按每条记录里的 `offset` 去读本地头 —— 也就是说，任何"写入时把偏移
   * 算错了"的 bug 都会在这里暴露（而不是被写入时的账本掩盖）。
   *
   * @returns {{entries: Array<{name,size,crc,data,method,flags}>, comment:string}}
   * @throws 结构不对时抛错（消息里带**具体哪个字段不对**，便于定位）
   */
  function readZip(bytes) {
    const b = toBytes(bytes);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

    // ---- 从尾部找 EOCD（注释最长 65535，所以最多回看 22+65535）
    let eocd = -1;
    const minPos = Math.max(0, b.length - (22 + 0xFFFF));
    for (let i = b.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("readZip: 找不到 EOCD（不是 zip，或尾部被截断）");

    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdStart = dv.getUint32(eocd + 16, true);
    const commentLen = dv.getUint16(eocd + 20, true);
    if (cdStart + cdSize > b.length) {
      throw new Error("readZip: 中央目录越界（cdStart=" + cdStart + " cdSize=" + cdSize +
        " 文件长=" + b.length + "）");
    }

    const entries = [];
    let p = cdStart;
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error("readZip: 第 " + i + " 个中央目录项签名不对（偏移 " + p + "）");
      }
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = fromUtf8(b.subarray(p + 46, p + 46 + nlen));

      // 本地头：只用来定位数据起点（并顺手核对它的 nameLen/extraLen 一致）
      if (dv.getUint32(lho, true) !== SIG_LOCAL) {
        throw new Error("readZip: 条目 `" + name + "` 的本地头签名不对（偏移 " + lho + "）");
      }
      const lnlen = dv.getUint16(lho + 26, true);
      const lelen = dv.getUint16(lho + 28, true);
      if (lnlen !== nlen) {
        throw new Error("readZip: 条目 `" + name + "` 本地头与中央目录的文件名长度不一致（" +
          lnlen + " vs " + nlen + "）");
      }
      const dataStart = lho + 30 + lnlen + lelen;
      if (dataStart + csize > b.length) {
        throw new Error("readZip: 条目 `" + name + "` 的数据越界");
      }
      const data = b.subarray(dataStart, dataStart + csize);
      entries.push({
        name: name, size: usize, csize: csize, crc: crc >>> 0,
        method: method, flags: flags, data: data,
        /** 本地头起点（中央目录里记的那个偏移）。自检要比对它 */
        offset: lho,
        /** 数据段起点（= 本地头 + 30 + 文件名 + 扩展区） */
        dataOffset: dataStart,
      });
      p += 46 + nlen + elen + clen;
    }

    return { entries: entries, comment: fromUtf8(b.subarray(eocd + 22, eocd + 22 + commentLen)) };
  }

  /**
   * 逐条校验（条目数 / 字节数 / CRC 三项）。
   *
   * @param {Uint8Array} zipBytes
   * @param {Array<{name:string, size:number, crc:number}>} expected 期望清单
   * @returns {{ok:boolean, problems:string[], entries:Array}}
   */
  function verifyZip(zipBytes, expected) {
    const problems = [];
    let parsed;
    try { parsed = readZip(zipBytes); }
    catch (e) { return { ok: false, problems: ["解析失败：" + e.message], entries: [] }; }

    const got = Object.create(null);
    parsed.entries.forEach(e => { got[e.name] = e; });

    if (expected && parsed.entries.length !== expected.length) {
      problems.push("条目数不对：实际 " + parsed.entries.length + "，期望 " + expected.length);
    }
    (expected || []).forEach(x => {
      const e = got[x.name];
      if (!e) { problems.push("缺少条目：" + x.name); return; }
      if (e.size !== x.size) problems.push(x.name + " 字节数不对：实际 " + e.size + "，期望 " + x.size);
      if (e.crc !== (x.crc >>> 0)) {
        problems.push(x.name + " CRC 不对：实际 " + e.crc.toString(16) + "，期望 " + (x.crc >>> 0).toString(16));
      }
      // ⚠️ **CRC 要用读出来的字节重新算一遍**，不能只比中央目录里那个数 ——
      // 否则"写入时 CRC 算错、中央目录与本地头都写了同一个错值"这种情况测不出来。
      const real = crc32(e.data);
      if (real !== e.crc) {
        problems.push(x.name + " 数据与 CRC 对不上（重新算得 " + real.toString(16) +
          "，记录的是 " + e.crc.toString(16) + "）");
      }
      if (e.method !== METHOD_STORE) problems.push(x.name + " 不是 store（method=" + e.method + "）");
      if (!(e.flags & FLAG_UTF8)) problems.push(x.name + " 没置 UTF-8 位（中文名会乱码）");
    });

    // 反向：zip 里多出来的条目（只报"包里有、清单里没有"）
    if (expected) {
      const want = Object.create(null);
      expected.forEach(x => { want[x.name] = 1; });
      parsed.entries.forEach(e => { if (!want[e.name]) problems.push("多出条目：" + e.name); });
    }
    return { ok: problems.length === 0, problems: problems, entries: parsed.entries };
  }

  const api = {
    crc32: crc32,
    utf8: utf8,
    fromUtf8: fromUtf8,
    buildZip: buildZip,
    readZip: readZip,
    verifyZip: verifyZip,
  };

  root.ZipKit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
