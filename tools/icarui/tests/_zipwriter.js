// ============================================================================
// 最小 ZIP 写入器（仅内部使用，零依赖）
//
// 为什么不直接用 Compress-Archive：
//   1. PowerShell 只认 .zip 扩展名，.icarzip 直接被拒
//   2. .NET CreateFromDirectory 生成的条目名是**反斜杠**（assets\x.png），
//      而 manifest 里写的是正斜杠（assets/x.png）—— 对不上会导致
//      DesignPack 校验「manifest 声明的素材不在包里」而整包拒收
//
// 这里显式指定条目名，保证与 manifest 逐字一致。
// ============================================================================
const zlib = require("zlib");

function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** 当前时间转 DOS 时间/日期（ZIP 头要求） */
function dosDateTime(d) {
  const year = d.getFullYear() < 1980 ? 1980 : d.getFullYear();
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() / 2) & 0x1F);
  const date = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

/**
 * @param {Array<{name:string, data:Buffer}>} entries 条目名必须是正斜杠
 * @returns {Buffer} zip 字节
 */
function buildZip(entries) {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  entries.forEach(function (e) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = e.data;
    const crc = crc32(raw);
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    // 压缩反而更大时用 store（method 0）
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const method = useDeflate ? 8 : 0;

    // ---- local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x0800, 6);      // flag: UTF-8 名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    // ---- central directory header
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);          // version made by
    ch.writeUInt16LE(20, 6);          // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);          // extra
    ch.writeUInt16LE(0, 32);          // comment
    ch.writeUInt16LE(0, 34);          // disk
    ch.writeUInt16LE(0, 36);          // internal attrs
    ch.writeUInt32LE(0, 38);          // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  });

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

module.exports = { buildZip, crc32 };
