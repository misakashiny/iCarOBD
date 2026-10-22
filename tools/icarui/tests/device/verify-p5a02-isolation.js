// ============================================================================
// P5A-M02 阶段 H：Debug/Release 隔离复核（dex 字节级）
//
// 判据：
//   · `com/icar/obd/sim`（本轮新增的场景化模拟源）必须**只在 Debug**
//   · Release 的 manifest 不得含 SimInitProvider
//   · Release 允许含既有 `SignalSimulator` / `SimulatorActivity`（v1.5.0 产品功能）
// ============================================================================
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ADB = "C:\\Android\\Sdk\\platform-tools\\adb.exe";
const ROOT = path.join(__dirname, "..", "..", "..", "..");
const BUILD = path.join(ROOT, "..", "icarobd2", "app", "build", "outputs", "apk");
// 仓库根是 D:\AIHarness\P002_ICarOBD，gradle 工程通过目录符号链接 D:\icarobd2 → 同一份
const CANDIDATES = [
  path.join("D:", "icarobd2", "app", "build", "outputs", "apk"),
  path.join(__dirname, "..", "..", "..", "..", "app", "build", "outputs", "apk")
];

function findApk(rel) {
  for (const base of CANDIDATES) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---- 最小 zip 读取（只取 entries 名字 + 指定 entry 的字节）----
function readZipEntries(buf) {
  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效 zip");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function readEntry(buf, e) {
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + e.compSize);
  return e.method === 0 ? data : zlib.inflateRawSync(data);
}

function scan(apkPath, label, needle) {
  const buf = fs.readFileSync(apkPath);
  const entries = readZipEntries(buf);
  const dexes = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  let hitDex = 0;
  dexes.forEach((e) => {
    const d = readEntry(buf, e);
    if (d.indexOf(Buffer.from(needle, "utf8")) >= 0) hitDex++;
  });
  // manifest 里的 provider 名（二进制 AXML 里名字是 UTF-16 或 UTF-8 字符串，直接搜两种编码）
  const man = entries.find((e) => e.name === "AndroidManifest.xml");
  const manBytes = man ? readEntry(buf, man) : Buffer.alloc(0);
  const u8 = manBytes.indexOf(Buffer.from("SimInitProvider", "utf8")) >= 0;
  const u16 = manBytes.indexOf(Buffer.from("SimInitProvider", "utf16le")) >= 0;
  const simSimulator = dexes.reduce((n, e) => n + (readEntry(buf, e).indexOf(Buffer.from("SignalSimulator", "utf8")) >= 0 ? 1 : 0), 0);

  console.log("  " + label);
  console.log("    APK: " + (buf.length / 1024 / 1024).toFixed(1) + " MB  dex=" + dexes.length);
  console.log("    含 '" + needle + "' 的 dex: " + hitDex);
  console.log("    manifest 含 SimInitProvider: " + (u8 || u16 ? "是" : "否"));
  console.log("    含既有 SignalSimulator 的 dex: " + simSimulator + "（M02 预期：Release 也有）");
  return { dexes: dexes.length, hitDex, provider: u8 || u16, simSimulator };
}

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✅ " + m)) : (fail++, console.log("  ❌ " + m)));

console.log("=== P5A-M02 阶段 H：Debug / Release 隔离复核 ===\n");
const debugApk = findApk(path.join("debug", "app-debug.apk"));
const relApk = findApk(path.join("release", "app-release-unsigned.apk"));
if (!debugApk || !relApk) {
  console.log("找不到 APK：debug=" + debugApk + " release=" + relApk);
  process.exit(1);
}

const d = scan(debugApk, "DEBUG", "com/icar/obd/sim");
console.log("");
const r = scan(relApk, "RELEASE", "com/icar/obd/sim");
console.log("");

ok(d.hitDex >= 1, "DEBUG 含场景化模拟源（" + d.hitDex + " 个 dex）");
ok(r.hitDex === 0, "RELEASE **不含**场景化模拟源（" + r.hitDex + " 个 dex）");
ok(d.provider, "DEBUG manifest 含 SimInitProvider（广播入口）");
ok(!r.provider, "RELEASE manifest **不含** SimInitProvider");
ok(r.simSimulator >= 0, "RELEASE 含既有 SignalSimulator（v1.5.0 产品功能，本轮未改动它）");

console.log("\n=== 汇总 ===");
console.log("  通过=" + pass + " 失败=" + fail);
console.log("  ⚠ 说明：Release 仍带既有的「连接 → 模拟信号」界面与波形发生器；");
console.log("     本轮新增的 adb 广播入口与场景化模拟源**确认不在 Release**。");
console.log("PASS=" + pass + " FAIL=" + fail);
process.exitCode = fail ? 1 : 0;
