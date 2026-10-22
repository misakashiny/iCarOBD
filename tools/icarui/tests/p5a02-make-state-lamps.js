// ============================================================================
// P5A-M02 阶段 C：生成状态灯三态测试素材 + 设计包（.icarzip）
//
// 为什么需要设计包：单文件 JSON 导入拿不到素材目录（designBaseDir 为空），
// 素材必然加载失败。`.icarzip` = design.json + manifest.json + assets/**，
// 解压目录直接当 designBaseDir，素材才能解析（见 DesignPack.kt 文件头）。
//
// 产物（全部为**测试专用**，不写入用户主题库）：
//   docs/02_验证记录/android-theme/state-lamps/
//     src/assets/{normal,warn,critical}.png   64×64 合成图
//     src/design.json                          测试主题
//     src/manifest.json                        包清单（bytes + crc32）
//     state-lamps.icarzip                      设计包
//
// 素材刻意做成三种**高对比**外观：绿/黄/红 + 不同白色标记，
// 这样像素差异判定不会被抗锯齿干扰。
// ============================================================================
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.join(__dirname, "..", "..", "..", "docs", "02_验证记录", "android-theme", "state-lamps");
const SRC = path.join(OUT, "src");
const ASSETS = path.join(SRC, "assets");

const SIZE = 64;

// ---------------------------------------------------------------- PNG 编码

function crc32(buf) {
  return zlib.crc32 ? zlib.crc32(buf) : crc32Fallback(buf);
}
function crc32Fallback(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素画布 */
function makeCanvas() {
  return { px: Buffer.alloc(SIZE * SIZE * 4, 0) };
}
function setPx(cv, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  cv.px[i] = r; cv.px[i + 1] = g; cv.px[i + 2] = b; cv.px[i + 3] = a;
}
function fillRect(cv, x0, y0, x1, y1, r, g, b) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) setPx(cv, x, y, r, g, b);
}

function encodePNG(cv) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 每行前加 filter 字节 0
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;
    cv.px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- 三态素材

/**
 * normal：绿色 + 深绿粗边框 + 中心实心圆
 * warn：  黄色 + 深黄边框 + 白色横杠（"警示横条"）
 * critical：红色 + 深红边框 + 白色叉（"严重"）+ 四角白点
 */
function makeNormal() {
  const cv = makeCanvas();
  fillRect(cv, 0, 0, SIZE, SIZE, 34, 197, 94);            // #22C55E 绿
  // 深绿边框 5px
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (x < 5 || y < 5 || x >= SIZE - 5 || y >= SIZE - 5) setPx(cv, x, y, 21, 128, 61);
  }
  // 中心实心圆 r=14
  const c = SIZE / 2 - 0.5;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const dx = x - c, dy = y - c;
    if (dx * dx + dy * dy <= 14 * 14) setPx(cv, x, y, 240, 253, 244);   // 近白
  }
  return cv;
}

function makeWarn() {
  const cv = makeCanvas();
  fillRect(cv, 0, 0, SIZE, SIZE, 245, 158, 11);           // #F59E0B 黄
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (x < 5 || y < 5 || x >= SIZE - 5 || y >= SIZE - 5) setPx(cv, x, y, 180, 83, 9);
  }
  // 白色横杠（三条）
  [18, 30, 42].forEach(function (yy) { fillRect(cv, 14, yy, SIZE - 14, yy + 5, 255, 255, 255); });
  return cv;
}

function makeCritical() {
  const cv = makeCanvas();
  fillRect(cv, 0, 0, SIZE, SIZE, 239, 68, 68);            // #EF4444 红
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    if (x < 5 || y < 5 || x >= SIZE - 5 || y >= SIZE - 5) setPx(cv, x, y, 153, 27, 27);
  }
  // 白色叉（两条对角线，粗 6）
  for (let t = 0; t < SIZE; t++) {
    for (let w = -3; w <= 3; w++) {
      setPx(cv, 12 + t + w, 12 + t, 255, 255, 255);
      setPx(cv, SIZE - 13 - t + w, 12 + t, 255, 255, 255);
    }
  }
  return cv;
}

// ---------------------------------------------------------------- 设计文件

const ASSET_DEFS = [
  { id: "a_normal", name: "灯-正常", file: "normal.png" },
  { id: "a_warn", name: "灯-警告", file: "warn.png" },
  { id: "a_critical", name: "灯-严重", file: "critical.png" }
];

/** 一个三态灯 */
function lamp(id, name, x, y, w, h, pid, extra) {
  const o = {
    id, type: "image", name, x, y, w, h,
    assetId: "a_normal",
    statePid: pid,
    states: {
      normal: { assetId: "a_normal" },
      warn: { assetId: "a_warn" },
      // blink=false：自动化截图要可复现，闪烁单独测
      critical: { assetId: "a_critical" }
    }
  };
  if (extra) Object.assign(o, extra);
  return o;
}

function buildDesign() {
  const nodes = [
    // 参考仪表（证明同屏还有别的控件在动）
    {
      id: "g_speed", type: "gauge", name: "车速", pid: "obd.speed",
      x: 130, y: 10, w: 100, h: 80,
      label: "车速", unit: "km/h", cardStyle: 0, neonPreset: 0, ringStyle: 0, ringSegments: 1
    },

    // ---- 第一排：三个灯，绑不同 PID，验证「多灯同时更新」 ----
    lamp("l_coolant", "水温灯", 20, 110, 70, 60, "obd.coolant"),
    lamp("l_speed", "车速灯", 145, 110, 70, 60, "obd.speed"),
    // 低值报警灯：电压 warnLow=11.8 —— **App 当前状态灯只判高值**，预期不变色（登记为缺口）
    lamp("l_volt_low", "低电压灯", 270, 110, 70, 60, "obd.voltage"),

    // ---- 第二排：PID 不存在（未知态）+ 另外两个灯 ----
    lamp("l_nopid", "无此PID灯", 20, 190, 70, 60, "no_such_pid_p5a02"),
    lamp("l_rpm", "转速灯", 145, 190, 70, 60, "obd.rpm"),
    lamp("l_load", "负荷灯", 270, 190, 70, 60, "obd.load")
  ];

  return {
    schema: "icar.ui/2",
    meta: {
      name: "P5A-M02 状态灯三态测试",
      author: "P5A-M02 自动化",
      description: "三态状态灯（合成素材）+ 低值报警缺口 + PID 不存在未知态"
    },
    name: "P5A-M02 状态灯三态测试",
    author: "P5A-M02 自动化",
    description: "三态状态灯（合成素材）+ 低值报警缺口 + PID 不存在未知态",
    themeId: "",
    pages: [{ id: "pg0", name: "主页面", nodes }],
    pageIndex: 0,
    assets: ASSET_DEFS.map(function (a) {
      return { id: a.id, name: a.name, kind: "custom", path: "assets/" + a.file, w: SIZE, h: SIZE };
    }),
    canvases: []
  };
}

// ---------------------------------------------------------------- 主流程

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });

  const imgs = {
    normal: makeNormal(),
    warn: makeWarn(),
    critical: makeCritical()
  };

  const pngBytes = {};
  ASSET_DEFS.forEach(function (a) {
    const buf = encodePNG(imgs[a.id.replace("a_", "")]);
    const p = path.join(ASSETS, a.file);
    fs.writeFileSync(p, buf);
    pngBytes[a.file] = buf;
    console.log("  " + a.file.padEnd(14) + buf.length + " bytes  crc32=" +
      crc32(buf).toString(16).padStart(8, "0"));
  });

  const design = buildDesign();
  fs.writeFileSync(path.join(SRC, "design.json"), JSON.stringify(design, null, 2), "utf8");

  // ---- manifest：refs = 引用这些素材的节点 id ----
  const refs = { "a_normal": [], "a_warn": [], "a_critical": [] };
  design.pages[0].nodes.forEach(function (n) {
    refs["a_normal"].push(n.id);      // 每个灯都以 normal 作为初始 assetId
    if (n.states) {
      Object.keys(n.states).forEach(function (k) {
        const aid = n.states[k].assetId;
        if (aid && refs[aid] && refs[aid].indexOf(n.id) < 0) refs[aid].push(n.id);
      });
    }
  });

  const manifest = {
    format: "icar.pack/1",
    designSchema: "icar.ui/2",
    designName: design.name,
    exportedAt: new Date().toISOString(),
    design: { name: design.name, schema: "icar.ui/2" },
    assets: ASSET_DEFS.map(function (a) {
      const buf = pngBytes[a.file];
      return {
        path: "assets/" + a.file,
        assetId: a.id,
        refs: refs[a.id],
        bytes: buf.length,
        crc32: crc32(buf),
        w: SIZE,
        h: SIZE
      };
    }),
    missing: []
  };
  fs.writeFileSync(path.join(SRC, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log("");
  console.log("设计节点: " + design.pages[0].nodes.length +
    "（1 仪表 + " + (design.pages[0].nodes.length - 1) + " 状态灯）");
  console.log("素材: " + design.assets.length);

  // ---- 打成 .icarzip（条目名必须正斜杠，且与 manifest 逐字一致）----
  const { buildZip } = require("./_zipwriter.js");
  const entries = [
    { name: "design.json", data: fs.readFileSync(path.join(SRC, "design.json")) },
    { name: "manifest.json", data: fs.readFileSync(path.join(SRC, "manifest.json")) }
  ].concat(ASSET_DEFS.map(function (a) {
    return { name: "assets/" + a.file, data: fs.readFileSync(path.join(ASSETS, a.file)) };
  }));
  const zipBuf = buildZip(entries);
  const zipPath = path.join(OUT, "state-lamps.icarzip");
  fs.writeFileSync(zipPath, zipBuf);
  console.log("设计包: " + zipBuf.length + " bytes → " + path.relative(process.cwd(), zipPath));

  console.log("输出目录: " + path.relative(process.cwd(), SRC));
}

main();
