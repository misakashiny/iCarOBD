/* ==========================================================================
   presets.js —— 预设布局 + 「与 App 规则的差异」清单
   ========================================================================== */
"use strict";

(function () {
  function g(alias, x, y, w, h, extra) {
    const pid = window.resolvePid(alias);
    const info = window.BUILTIN_PIDS[pid] || { min: 0, max: 100 };
    const o = {
      pid: alias, x: x, y: y, w: w, h: h,
      min: info.min, max: info.max,
      warnLow: info.warnLow === undefined ? null : info.warnLow,
      warnHigh: info.warnHigh === undefined ? null : info.warnHigh,
    };
    return window.createNode(window.NODE_GAUGE, Object.assign(o, extra || {}));
  }
  function grp(name, x, y, w, h, children, extra) {
    const n = window.createNode(window.NODE_GROUP, Object.assign({
      name: name, x: x, y: y, w: w, h: h, z: 0,
    }, extra || {}));
    (children || []).forEach((c, i) => { c.z = i; n.children.push(c); });
    return n;
  }
  function txt(text, x, y, w, h, size, extra) {
    return window.createNode(window.NODE_TEXT, Object.assign({
      name: text, text: text, x: x, y: y, w: w, h: h,
      fontSize: size || 14, color: "#8FA0B8",
    }, extra || {}));
  }

  window.PRESETS = {
    /** 1 大 4 小 —— 最常用的日常驾驶盘面 */
    "1big4small": function () {
      return [
        g("obd.rpm", 0, 0, 180, 180, { name: "转速", z: 1, ringStyle: 1 }),
        g("obd.speed", 180, 0, 90, 90, { name: "车速", z: 1 }),
        g("obd.coolant", 270, 0, 90, 90, { name: "水温", z: 1 }),
        g("obd.voltage", 180, 90, 90, 90, { name: "电压", z: 1 }),
        g("obd.throttle", 270, 90, 90, 90, { name: "节气门", z: 1 }),
      ];
    },

    /** 2×2 四联 */
    "2x2": function () {
      return [
        g("obd.rpm", 0, 0, 180, 180, { name: "转速", z: 1 }),
        g("obd.speed", 180, 0, 180, 180, { name: "车速", z: 1 }),
        g("obd.coolant", 0, 180, 180, 180, { name: "水温", z: 1 }),
        g("obd.voltage", 180, 180, 180, 180, { name: "电压", z: 1 }),
      ];
    },

    /** 全条形 */
    "allbar": function () {
      const pids = ["obd.rpm", "obd.speed", "obd.coolant", "obd.voltage", "obd.load", "obd.throttle"];
      return pids.map((p, i) => g(p, 0, i * 60, 360, 60, { style: 2, name: p, z: i }));
    },

    /** 赛道：大转速 + 状态灯（演示状态系统与分组） */
    "race": function () {
      return [
        grp("转速组", 0, 0, 240, 240, [
          g("obd.rpm", 0, 0, 240, 240, { name: "转速表盘", ringStyle: 1, neonPreset: "强烈" }),
        ], { z: 1 }),
        g("obd.speed", 240, 0, 120, 120, { style: 1, name: "车速", z: 2 }),
        g("obd.voltage", 240, 120, 120, 120, { style: 1, name: "电压", z: 2 }),
        grp("警告灯", 0, 240, 240, 120, [
          imageNode("发动机故障灯", 10, 20, 40, 40, 0),
          imageNode("机油压力灯", 60, 20, 40, 40, 1),
          imageNode("电池灯", 110, 20, 40, 40, 2),
        ], { z: 3 }),
        g("obd.coolant", 240, 240, 120, 120, { style: 2, name: "水温", z: 2 }),
      ];
    },

    /** 四联表（一个控件显示 4 个值） */
    "quad": function () {
      return [
        g("obd.rpm", 0, 0, 360, 180, {
          style: 5, name: "四联表", z: 1,
          extraPids: ["obd.speed", "obd.coolant", "obd.voltage"],
        }),
      ];
    },

    /** 空盘面：只留一个标题，用来从零开始 */
    "blank": function () {
      return [
        txt("点「添加」或从素材库拖入开始", 20, 160, 320, 40, 18),
      ];
    },
  };

  /** 建一个带状态系统的图片节点（预设里演示用） */
  function imageNode(name, x, y, w, h, z) {
    const n = window.createNode(window.NODE_IMAGE, {
      name: name, x: x, y: y, w: w, h: h, z: z,
      statePid: "obd.coolant",
    });
    n.states = {
      // WCAG 2.3.1：闪烁每秒不超过三次 → 周期下限 400ms（见 window.MIN_BLINK_MS）
      normal: { assetId: "", alpha: 77, blink: false, blinkMs: window.MIN_BLINK_MS },
      warn: { assetId: "", alpha: 255, blink: false, blinkMs: window.MIN_BLINK_MS },
      critical: { assetId: "", alpha: 255, blink: true, blinkMs: window.MIN_BLINK_MS },
    };
    return n;
  }

  // ================================================================ 内置控件库

  /**
   * 素材库里的「控件」——把 8 种仪表样式 + 文字 + 分组都做成**可直接拖进画布**的条目。
   *
   * 用户要求"现在包含的全部控件你都导入到素材库"。这样不用记"圆表是 style 0"，
   * 从库里拖一个就行；也让素材库同时是**控件库**。
   *
   * 每项是 `{ key, name, icon, make() }`；`make()` 返回一个**新节点**。
   */
  window.BUILTIN_CONTROLS = (function () {
    const list = [];
    // 8 种仪表样式各来一个（用转速做样板，量程/单位都是它的）
    window.STYLES.forEach(s => {
      list.push({
        key: "gauge_" + s.v,
        name: s.n,
        icon: "◉",
        make: function () {
          const info = window.BUILTIN_PIDS["std_0C"];
          const n = window.createNode(window.NODE_GAUGE, {
            name: s.n,
            pid: "obd.rpm",
            style: s.v,
            min: info.min, max: info.max,
            warnHigh: info.warnHigh,
            x: 40, y: 40,
            w: s.v === 3 || s.v === 5 ? 200 : 120,
            h: s.v === 3 || s.v === 5 ? 100 : 120,
            z: 99,
          });
          if (s.v === 0) { n.ringStyle = 1; n.ringSegments = 40; }
          return n;
        },
      });
    });
    list.push({
      key: "text", name: "文字", icon: "T",
      make: function () {
        return window.createNode(window.NODE_TEXT, {
          name: "文字", text: "标题", x: 40, y: 40, w: 160, h: 30,
          fontSize: 18, color: "#8FA0B8", z: 99,
        });
      },
    });
          // ---- 常用 PID 的成套仪表（用户不用再去翻 PID 下拉框）
      [
        { key: "g_speed", name: "车速", pid: "obd.speed", style: 1, w: 200, h: 100, icon: "▬" },
        { key: "g_coolant", name: "水温", pid: "obd.coolant", style: 0, w: 120, h: 120, icon: "◉" },
        { key: "g_fuel", name: "油量", pid: "obd.fuel_level", style: 0, w: 120, h: 120, icon: "◉" },
        { key: "g_volt", name: "电压", pid: "obd.voltage", style: 4, w: 150, h: 150, icon: "▣" },
        { key: "g_intake", name: "进气温度", pid: "obd.intake", style: 4, w: 150, h: 150, icon: "▣" },
        { key: "g_boost", name: "涡轮压力", pid: "calc.boost", style: 2, w: 120, h: 120, icon: "◍" },
        { key: "g_load", name: "发动机负荷", pid: "obd.load", style: 2, w: 120, h: 120, icon: "◍" },
        { key: "g_throttle", name: "节气门", pid: "obd.throttle", style: 3, w: 200, h: 100, icon: "▬" },
      ].forEach(function (d) {
        list.push({
          key: d.key, name: d.name, icon: d.icon,
          make: function () {
            const info = window.BUILTIN_PIDS[window.resolvePid(d.pid)] || {};
            return window.createNode(window.NODE_GAUGE, {
              name: d.name, pid: d.pid, style: d.style,
              min: info.min === undefined ? 0 : info.min,
              max: info.max === undefined ? 100 : info.max,
              warnLow: info.warnLow === undefined ? null : info.warnLow,
              warnHigh: info.warnHigh === undefined ? null : info.warnHigh,
              x: 40, y: 40, w: d.w, h: d.h, z: 99,
            });
          },
        });
      });

      // ---- 多段色带样板（v2.87.0 加，**v2.91.0 按用户要求删除**）
      //
      // 这里原来有两个控件：`g_rpmband`（转速红区表）与 `g_fuelband`（油量绿黄红条）。
      // 用户点名要删，已删。**`bands` 能力本身一点没动** ——
      // 它仍然在属性面板的「多段色带（只画分区）」组里，任何仪表都能加分区；
      // 删掉的只是"库里的两个样板"。
      //
      // ⚠️ **删除前查过引用**（`stage/recon-v291.js`，全仓扫 key）：
      // 4 个待删 key 在 `stage/**` 的设计文件里**一个都没有出现**，
      // 只在 `docs/` 与本仓库的测试/守卫里被提到 —— 所以删掉**不会让任何
      // 存量设计悬空**。`docs/` 与本文件下方的说明已同步。
      //
      // ⚠️ 为什么要留这段注释而不是删干净：下一个"库里怎么没有红区样板了"的人
      // 需要知道**这是刻意的**，以及要加回去时该加什么（见上面被删的两条定义，
      // 或者直接在任意仪表上用 `bands` 手配 —— 能力一直在）。

      // ---- 文字：标题 / 标签 / 单位 / 大号数字（做主题最常用的四种）
      [
        { key: "t_title", name: "标题文字", text: "标题", w: 200, h: 34, size: 14, color: "#E8EEF7", weight: 700 },
        { key: "t_label", name: "标签文字", text: "标签", w: 120, h: 20, size: 7, color: "#8FA0B8", weight: 400 },
        { key: "t_unit", name: "单位文字", text: "km/h", w: 60, h: 16, size: 6, color: "#5F6E85", weight: 400 },
        { key: "t_big", name: "大号数字", text: "000", w: 160, h: 60, size: 24, color: "#00D8FF", weight: 900 },
      ].forEach(function (d) {
        list.push({
          key: d.key, name: d.name, icon: "T",
          make: function () {
            return window.createNode(window.NODE_TEXT, {
              name: d.name, text: d.text, x: 40, y: 40, w: d.w, h: d.h, z: 99,
              font: { family: "sans", size: d.size, weight: d.weight,
                      align: "center", color: d.color },
            });
          },
        });
      });

      // ---- 图片类：素材由 make() 自动登记进设计（否则拖出来是紫框大 X）
      [
        { key: "img_ring", name: "圆环底盘", path: "assets/dashboard/ring-thick.png", w: 180, h: 180 },
        { key: "img_dial40", name: "盘面(40格)", path: "assets/dashboard/dial-40.png", w: 180, h: 180 },
        { key: "img_half", name: "半圆盘", path: "assets/dashboard/dial-half.png", w: 200, h: 100 },
        { key: "img_plate", name: "方形底盘", path: "assets/dashboard/plate-square.png", w: 180, h: 180 },
        { key: "img_carbon", name: "碳纤维底", path: "assets/background/carbon.png", w: 360, h: 360 },
        { key: "img_grid", name: "网格底", path: "assets/background/grid.png", w: 360, h: 360 },
        { key: "img_glow", name: "光晕", path: "assets/decor/glow.png", w: 200, h: 200 },
        { key: "img_corners", name: "四角标", path: "assets/decor/frame-corners.png", w: 200, h: 200 },
        { key: "img_lineh", name: "水平线", path: "assets/decor/line-h.png", w: 300, h: 10 },
        { key: "img_trackbar", name: "条底轨", path: "assets/decor/track-bar.png", w: 240, h: 16 },
        { key: "img_trackarc", name: "弧底轨", path: "assets/decor/track-arc.png", w: 200, h: 200 },
        { key: "img_dots", name: "点阵", path: "assets/decor/dots.png", w: 120, h: 120 },
      ].forEach(function (d) {
        list.push({
          key: d.key, name: d.name, icon: "▣",
          make: function () {
            const id = window.ensureBuiltinAsset ? window.ensureBuiltinAsset(d.path) : "";
            return window.createNode(window.NODE_IMAGE, {
              name: d.name, assetId: id, x: 40, y: 40, w: d.w, h: d.h, z: 98,
            });
          },
        });
      });

      // ================================================================ 指示灯（v2.91.0 重做）
      //
      // ## 为什么要重做（实测，不是感觉）
      //
      // 体检脚本 `stage/recon-v291.js` 的实测输出：
      //
      // ```
      // normal 去重：{"assets/warning/lamp-off.png": 19}     ← 19 个灯**全是同一张**
      // warn   去重：{"assets/warning/lamp-warn.png": 19}    ← 19 个灯**全是同一张**
      // critical 去重：19 个里 18 张不同
      // ```
      //
      // 也就是用户说的「**指示灯需要优化、而不是全部都是一个图**」——实测成立。
      // 拖 5 个灯到画布上，平时看到的是 **5 个一模一样的圆**，认不出哪个是哪个；
      // 只有严重态才区分得出来。
      //
      // ## 现在每个灯三态各一张自己的图
      //
      // 新增 57 张（19 类 × 3 态，`assets/warning/lamp-<key>-<off|warn|crit>.png`），
      // 由 `gen-lamps.js` **代码绘制**（192×192，旧灯盘是 64×64 = 9 倍像素）。
      // 版权：形状按 ISO 2575 的**常见语义**自画几何图形，没有下载任何第三方图片。
      //
      // ## ⚠️ 旧的 `lamp-off` / `lamp-warn` / `lamp-crit` **一个字都没动**
      //
      // 它们是**存量设计文件按路径引用**的素材（§2.41「素材路径是设计文件里的契约」）。
      // 改内容 = 改所有存量设计在设备上的样子。所以只**新增**、不改旧的；
      // `img_lampcrit`（严重态灯底）那个控件仍然指向旧的 `lamp-crit.png`。
      //
      // ## 三态的默认 alpha / 闪烁保持原样（行为不变）
      //
      // 只有 `normal` 是半透明（120）、`critical` 闪、周期走 `window.MIN_BLINK_MS`
      // —— 与 v1.20.16 那版逐字一致，改的只是**素材**。
      [
        // key 尾缀 —— 与 `gen-lamps.js` 的 LAMPS 表**逐条对应**（那边是唯一真源）
        { key: "lamp_coolant",   name: "水温灯",   pid: "obd.coolant",     g: "coolant" },
        { key: "lamp_oil",       name: "机油灯",   pid: "tpl_oilPressure", g: "oil" },
        { key: "lamp_batt",      name: "电池灯",   pid: "obd.voltage",     g: "batt" },
        { key: "lamp_brake",     name: "制动灯",   pid: "obd.brakeFluid",  g: "brake" },
        { key: "lamp_pad",       name: "刹车片",   pid: "obd.brakePad",    g: "pad" },
        { key: "lamp_tpms",      name: "胎压灯",   pid: "obd.tpms",        g: "tpms" },
        { key: "lamp_airbag",    name: "气囊灯",   pid: "obd.airbag",      g: "airbag" },
        { key: "lamp_belt",      name: "安全带灯", pid: "obd.seatbelt",    g: "belt" },
        { key: "lamp_abs",       name: "ABS 灯",   pid: "obd.abs",         g: "abs" },
        { key: "lamp_esp",       name: "ESP 灯",   pid: "obd.esp",         g: "esp" },
        { key: "lamp_engine",    name: "发动机灯", pid: "obd.engineFault", g: "engine" },
        { key: "lamp_fuel",      name: "燃油报警", pid: "obd.fuel_level",  g: "fuel" },
        { key: "lamp_door",      name: "车门未关", pid: "obd.door",        g: "door" },
        { key: "lamp_washer",    name: "玻璃水",   pid: "obd.washer",      g: "washer" },
        { key: "lamp_service",   name: "保养提示", pid: "obd.service",     g: "service" },
        { key: "lamp_temp",      name: "水温报警", pid: "obd.coolant",     g: "temp" },
        { key: "lamp_charge",    name: "充电提示", pid: "obd.voltage",     g: "charge" },
        { key: "lamp_lane",      name: "车道辅助", pid: "obd.laneKeep",    g: "lane" },
        { key: "lamp_collision", name: "碰撞预警", pid: "obd.collision",   g: "collision" },
      ].forEach(function (d) {
        // 三张图按**命名约定**拼出来（与 `gen-lamps.js` 的 save() 同名）
        const P = function (suffix) { return "assets/warning/lamp-" + d.g + "-" + suffix + ".png"; };
        list.push({
          key: d.key, name: d.name, icon: "⚠",
          make: function () {
            const E = window.ensureBuiltinAsset || function () { return ""; };
            const off = E(P("off")), warn = E(P("warn")), crit = E(P("crit"));
            const n = window.createNode(window.NODE_IMAGE, {
              name: d.name, assetId: off, x: 40, y: 40, w: 56, h: 56, z: 96,
            });
            // **状态系统**：按 PID 自动切三态图
            //
            // ⚠️ 这里**必须写 `statePid`，不能写 `pid`**（v1.20.16 修）。
            // 原来写的是 `n.pid` / `n.rawPid`，于是它们的灯**永远是暗的**：
            //   1. `NodeTreeRenderer.resolveState()`（ui/dash/NodeTreeRenderer.kt）只读
            //      `node.statePid`，`isBlank()` 就**直接返回 normal**，根本不看 `pid`；
            //   2. `model.js` 的 `nodeToJson` 对 `NODE_IMAGE` **只序列化 `statePid`**，
            //      `pid` / `rawPid` 被丢掉 —— 连设计文件都进不去。
            // 净结果：用户拖一个「胎压灯」出来，它永远显示暗的图，
            // **用户会以为车没问题**。这是这个库里最贵的一条。
            n.rawStatePid = d.pid;
            n.statePid = window.resolvePid(d.pid);
            n.states = {
              normal: { assetId: off, alpha: 120, blink: false, blinkMs: window.MIN_BLINK_MS },
              // WCAG 2.3.1：闪烁**每秒不超过三次**。600ms = 1.7Hz
              warn: { assetId: warn, alpha: 255, blink: true, blinkMs: 600 },
              // 原来是 260ms = 3.8Hz，**超红线**。400ms = 2.5Hz
              critical: { assetId: crit, alpha: 255, blink: true, blinkMs: window.MIN_BLINK_MS },
            };
            return n;
          },
        });
      });

      // ---- **用子部件拼装的仪表**（v2.12.0 的新能力，示范怎么自己拼）
      list.push({
        key: "gauge_parts", name: "拼装圆表", icon: "✦",
        make: function () {
          const E = window.ensureBuiltinAsset || function () { return ""; };
          const n = window.createNode(window.NODE_GAUGE, {
            name: "拼装圆表", pid: "obd.rpm", style: 0,
            min: 0, max: 8000, warnHigh: 6500,
            x: 40, y: 40, w: 200, h: 200, z: 99,
          });
          n.parts = [
            window.normalizePart({ kind: "dial",  assetId: E("assets/dashboard/ring-thick.png"), x: 0, y: 0, w: 200, h: 200 }),
            window.normalizePart({ kind: "ticks", assetId: E("assets/scale/ticks-60.png"), x: 8, y: 8, w: 184, h: 184 }),
            // **两个指针各绑一个 PID**（v2.17.0 多指针表）：
            // 长针 = 转速（仪表自己的 PID），短针 = 车速（绑 obd.speed，用量程 0~240）
            window.normalizePart({ kind: "needle", assetId: E("assets/needle/needle-classic.png"),
              x: 76, y: 4, w: 48, h: 192,
              pivotX: 0.5, pivotY: 0.5, sweepFrom: 135, sweepTo: 405 }),
            window.normalizePart({ kind: "needle", assetId: E("assets/needle/needle-short.png"),
              x: 76, y: 76, w: 48, h: 96,
              pivotX: 0.5, pivotY: 0.5, sweepFrom: 135, sweepTo: 405,
              rawPid: "obd.speed" }),
            window.normalizePart({ kind: "value", x: 60, y: 130, w: 80, h: 40 }),
          ];
          return n;
        },
      });
      list.push({
        key: "gauge_parts_arc", name: "拼装弧形表", icon: "✦",
        make: function () {
          const E = window.ensureBuiltinAsset || function () { return ""; };
          const n = window.createNode(window.NODE_GAUGE, {
            name: "拼装弧形表", pid: "obd.speed", style: 2,
            min: 0, max: 240,
            x: 40, y: 40, w: 200, h: 200, z: 99,
          });
          n.parts = [
            window.normalizePart({ kind: "decor", assetId: E("assets/decor/track-arc.png"), x: 0, y: 0, w: 200, h: 200 }),
            window.normalizePart({ kind: "needle", assetId: E("assets/needle/needle-blade.png"),
              x: 76, y: 4, w: 48, h: 192, pivotX: 0.5, pivotY: 0.5,
              sweepFrom: 135, sweepTo: 405 }),
            window.normalizePart({ kind: "value", x: 60, y: 120, w: 80, h: 44 }),
          ];
          return n;
        },
      });

      list.push({
      key: "group", name: "空分组", icon: "▤",
      make: function () {
        return window.createNode(window.NODE_GROUP, {
          name: "分组", x: 40, y: 40, w: 160, h: 160, z: 99,
        });
      },
    });
    list.push({
      key: "image", name: "图片控件", icon: "▣",
      make: function () {
        return window.createNode(window.NODE_IMAGE, {
          name: "图片", x: 40, y: 40, w: 100, h: 100, z: 99,
        });
      },
    });
  // ---- 容器 / 基础（v2.37.0）
  //
  // 这块原来只有 3 个（text / group / image），是分类分布里最薄的。
  //
  // ⚠️ 加这些**必须同时改 CAT_RULES** —— 那条规则原来是 `^(group|image|text)$`，
  // **精确匹配**，`box_*` 一个都匹配不上，会静默掉进"其它"分类。
  [
    { key: "box_card", name: "卡片容器", w: 320, h: 200, note: "放一组相关读数的底板" },
    { key: "box_row", name: "横向分组", w: 340, h: 100, note: "左右排列的几个控件" },
    { key: "box_col", name: "纵向分组", w: 140, h: 320, note: "上下排列的几个控件" },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "▤",
      make: function () {
        const n = window.createNode(window.NODE_GROUP, {
          name: d.name, x: 40, y: 40, w: d.w, h: d.h, z: 99,
        });
        // 名字里带上用途提示 —— 拖进画布后在控件树里一眼看得出是干嘛的
        n.name = d.name + "（" + d.note + "）";
        return n;
      },
    });
  });

  [
    { key: "box_h1", name: "大标题", text: "仪表盘", size: 30, color: "#CFE0EE", w: 200, h: 44 },
    { key: "box_h2", name: "小标题", text: "分组标题", size: 20, color: "#8FA0B8", w: 160, h: 32 },
    { key: "box_note", name: "小注释", text: "单位 / 说明", size: 12, color: "#5F6E85", w: 140, h: 20 },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "T",
      make: function () {
        return window.createNode(window.NODE_TEXT, {
          name: d.name, text: d.text,
          x: 40, y: 40, w: d.w, h: d.h,
          fontSize: d.size, color: d.color, z: 99,
        });
      },
    });
  });

  // ================================================================ 更多控件（v2.22.0）

  // ---- 常用仪表（第二批）：把车机上真正会看的量都补上
  [
    { key: "g_rpm", name: "转速表", pid: "obd.rpm", style: 0, w: 180, h: 180, icon: "◉" },
    // 平均油耗：派生通道（累计用油 ÷ 累计里程），**不用等车、不用厂家 PID**
    { key: "g_avgfuel", name: "平均油耗", pid: "calc.avg_l100", style: 1, w: 200, h: 100, icon: "▬" },
    { key: "g_instfuel", name: "瞬时油耗", pid: "calc.l100", style: 2, w: 120, h: 120, icon: "◍" },
    // 续航里程：派生通道（油量% × 油箱容量 ÷ 平均油耗 × 100）。
    // 需要在 App「连接」页填**油箱容量**，否则通道不出值（仪表显示 --）
    { key: "g_range", name: "续航里程", pid: "calc.range", style: 1, w: 200, h: 100, icon: "▬" },
    { key: "g_odo", name: "总里程", pid: "obd.odo", style: 1, w: 200, h: 100, icon: "▬" },
    { key: "g_oiltemp", name: "机油温度", pid: "obd.oil_temp", style: 4, w: 150, h: 150, icon: "▣" },
    { key: "g_gearbox", name: "变速箱油温", pid: "tpl_atf", style: 4, w: 150, h: 150, icon: "▣" },
    { key: "g_afr", name: "空燃比", pid: "tpl_afr", style: 4, w: 150, h: 150, icon: "▣" },
    // ⚠️ **`g_speed_d`（数字车速）v2.91.0 已按用户要求删除。**
    //
    // 删除前的引用排查（`stage/recon-v291.js`）：这个 key 只出现在
    // `docs/18-控件库优化建议.md` 与本文件里，**没有任何设计文件引用它**。
    // 与它重复的是「仪表样式」里的 `gauge_1`（数字表）—— 两者 `pid`/`style` 一样，
    // 只有默认尺寸不同（220×110 vs 120×120），而尺寸拖一下就改了。
    //
    // ⚠️ 挡位是**枚举**，不是连续量 —— 见 P9「非数值 PID 模型」方向 A。
    // 值仍然是 0..8 的数（指针/条照常按数值走），**只有读数**查 valueLabels。
    // `min`/`max` 写死在这里：`obd.gear` 目前还不在 PID 库里，
    // 靠 BUILTIN_PIDS 兜底会得到 0~100（那是指针几乎不动的量程）
    { key: "g_gear", name: "挡位", pid: "obd.gear", style: 1, w: 100, h: 100, icon: "▬",
      min: 0, max: 8,
      valueLabels: ["P", "R", "N", "1", "2", "3", "4", "5", "6"] },
    // ⚠️ **`g_soc`（电池电量）v2.91.0 已按用户要求删除。**
    //
    // 它绑的 `obd.soc` **既没有标准 PID、也没有派生通道** ——
    // 一直是 `tools/guard-pid-probe.js` 的 P9 待办里"最没着落"的那一条
    // （原话：「等 P9 在车上确认有没有厂家信号，否则按 P9 验收确认这个控件该删还是该留」）。
    // 用户现在拍板**删**，于是 `PENDING_P9` 里那一条也一起删掉了（否则守卫会报"清单里
    // 这条已经不需要了"）。**能力没丢**：想要电量表用「仪表样式」的任意一个，
    // 把 PID 指到厂家信号即可。
    { key: "g_gforce", name: "G 值", pid: "calc.gforce", style: 7, w: 160, h: 160, icon: "✦" },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: d.icon || "◉",
      make: function () {
        const info = window.BUILTIN_PIDS[window.resolvePid(d.pid)] || {};
        return window.createNode(window.NODE_GAUGE, {
          name: d.name, pid: d.pid, style: d.style,
          // 模板显式给了量程就优先 —— 库里还没有的 PID（挡位这类）必须这样兜，
          // 否则 `info` 查不到 → 0~100，指针几乎不动
          min: d.min !== undefined ? d.min : (info.min !== undefined ? info.min : 0),
          max: d.max !== undefined ? d.max : (info.max !== undefined ? info.max : 100),
          // 枚举的显示映射（P9 方向 A）；没有就是 null = 显示数字
          valueLabels: d.valueLabels || null,
          x: 40, y: 40, w: d.w, h: d.h, z: 10,
        });
      },
    });
  });

  // ---- 文字（第二批）
  [
    { key: "t_warn", name: "警告文字", text: "警告", w: 160, h: 30, size: 12, color: "#FF4D4F", weight: 700 },
    { key: "t_ok", name: "正常文字", text: "正常", w: 140, h: 26, size: 10, color: "#39D98A", weight: 700 },
    { key: "t_small", name: "小标签", text: "RPM", w: 70, h: 14, size: 5, color: "#5F6E85", weight: 400 },
    { key: "t_bigunit", name: "大号单位", text: "km/h", w: 120, h: 30, size: 14, color: "#8FA0B8", weight: 400 },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "T",
      make: function () {
        return window.createNode(window.NODE_TEXT, {
          name: d.name, text: d.text, x: 40, y: 40, w: d.w, h: d.h, z: 99,
          font: { family: "sans", size: d.size, weight: d.weight, align: "center", color: d.color },
        });
      },
    });
  });

  // ---- 图片 / 底盘（第二批）：用 v2.20.0 新加的素材
  [
    { key: "img_oct", name: "八边形盘", path: "assets/dashboard/dial-octagon.png", w: 200, h: 200 },
    { key: "img_capsule", name: "胶囊盘", path: "assets/dashboard/dial-capsule.png", w: 240, h: 140 },
    { key: "img_twin", name: "双联盘", path: "assets/dashboard/dial-twin.png", w: 260, h: 140 },
    { key: "img_triple", name: "三联盘", path: "assets/dashboard/dial-triple.png", w: 260, h: 140 },
    { key: "img_arc270", name: "270° 弧盘", path: "assets/dashboard/dial-270.png", w: 200, h: 200 },
    { key: "img_ticks90", name: "90 格刻度", path: "assets/scale/ticks-90f.png", w: 240, h: 240 },
    { key: "img_seg20", name: "20 段弧", path: "assets/scale/ticks-segment-20.png", w: 240, h: 240 },
    { key: "img_needle", name: "指针素材", path: "assets/needle/needle-classic.png", w: 40, h: 160 },
    { key: "img_cap", name: "轴心盖", path: "assets/needle/needle-cap.png", w: 48, h: 48 },
    { key: "img_frame", name: "面板边框", path: "assets/frame/frame-simple.png", w: 260, h: 200 },
    { key: "img_glowring", name: "发光环", path: "assets/decor/glow-ring.png", w: 200, h: 200 },
    { key: "img_carbonblk", name: "碳纹块", path: "assets/decor/carbon-block.png", w: 140, h: 140 },
    { key: "img_plateblank", name: "空白铭牌", path: "assets/decor/plate-blank.png", w: 140, h: 60 },
    { key: "img_bgmesh", name: "网格背景", path: "assets/background/mesh.png", w: 360, h: 360 },
    { key: "img_bghex", name: "六角背景", path: "assets/background/hex-dark.png", w: 360, h: 360 },
    { key: "img_bgvign", name: "暗角背景", path: "assets/background/vignette.png", w: 360, h: 360 },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "▣",
      make: function () {
        const id = window.ensureBuiltinAsset ? window.ensureBuiltinAsset(d.path) : "";
        return window.createNode(window.NODE_IMAGE, {
          name: d.name, assetId: id, x: 40, y: 40, w: d.w, h: d.h, z: 98,
        });
      },
    });
  });

  // ================================================================ **代码绘制的条形轨道**（v2.91.0）
  //
  // ## 为什么
  //
  // 用户原话：「**条形轨道：想办法以代码绘制、而不是以图片的形式添加、
  // 缩放会导致模糊**」。
  //
  // 下面那一批 `bar_*` 轨道都是 `NODE_IMAGE` + 一张 256×24 的 PNG
  // （`gen-assets-more.js` 的 `genBars`）。拖到 600 宽 = 位图横向拉伸 = 糊。
  //
  // 这一批改成 `trackStyle`（`NODE_IMAGE` 上的一个字段，**不是新节点类型** ——
  // 理由见 schema.js 的 `normalizeTrackStyle` 注释：新类型会撞跨语言守卫）。
  // 绘制全在 `canvas.js` 的 `drawTrackNode` 里用 canvas 原语做，
  // **任意缩放都清晰**，而且跟着设计主题的 `track` / `accent` 走。
  //
  // ## 与 `bar_*` 的关系
  //
  // **两批都留着**：
  //   · `bar_*`（图片）—— 存量设计的观感锚点。设计文件按 `path` 引用它们，
  //     删掉 = 存量设计在设备上**空白**（§2.41）。
  //   · `cd_*`（代码）—— 新做的设计用这一批。
  //
  // ⚠️ 为什么不是"把 `bar_trackh` 改成代码画"：那会让**已经拖过它的设计**
  // 在重新打开后**换一张脸**（图片版有 PNG 的纹理细节，代码版是干净的几何形）。
  // 新增而不是替换，是为了"存量设计看起来一模一样"这条硬约束。
  // 想要代码版的人从库里拖 `cd_*` 即可。
  //
  // ⚠️ key 前缀 `cd_` 必须过 `CAT_RULES`（本文件下方），否则静默掉进「其它」
  // —— 构建守卫会抓（「控件不能掉进『其它』分类」那条）。
  [
    { key: "cd_trackh", name: "代码轨道(水平)", orient: "h", w: 240, h: 16 },
    { key: "cd_trackv", name: "代码轨道(垂直)", orient: "v", w: 16, h: 240 },
    // 渐变：`gloss` = 沿短边明暗（像刻进面板的槽）、`fade` = 沿长边淡出
    { key: "cd_trackgradh", name: "代码渐变轨道(水平)", orient: "h", gradient: "gloss", w: 240, h: 16 },
    { key: "cd_trackgradv", name: "代码渐变轨道(垂直)", orient: "v", gradient: "gloss", w: 16, h: 240 },
    { key: "cd_trackfadeh", name: "代码淡出轨道(水平)", orient: "h", gradient: "fade", w: 240, h: 16 },
    { key: "cd_trackfadev", name: "代码淡出轨道(垂直)", orient: "v", gradient: "fade", w: 16, h: 240 },
    // 内凹：上/左暗、下/右亮 —— 刻进面板里的凹槽
    { key: "cd_trackinseth", name: "代码内凹轨道(水平)", orient: "h", inset: true, w: 240, h: 16 },
    { key: "cd_trackinsetv", name: "代码内凹轨道(垂直)", orient: "v", inset: true, w: 16, h: 240 },
    // 发光：整条发主色光（"这条是活的"）
    { key: "cd_trackglowh", name: "代码发光轨道(水平)", orient: "h", glow: true, w: 240, h: 20 },
    { key: "cd_trackglowv", name: "代码发光轨道(垂直)", orient: "v", glow: true, w: 20, h: 240 },
    // 带刻度：条上直接读数，省掉另摆一排数字
    { key: "cd_trackticksh", name: "代码带刻度轨道(水平)", orient: "h", ticks: 10, w: 240, h: 24 },
    { key: "cd_trackticksv", name: "代码带刻度轨道(垂直)", orient: "v", ticks: 10, w: 24, h: 240 },
    // 分段：粒度不同（5 段像指针式油表、20 段像 LED 电量条）
    { key: "cd_seg5h", name: "代码 5 段条(水平)", orient: "h", segments: 5, w: 240, h: 20 },
    { key: "cd_seg5v", name: "代码 5 段条(垂直)", orient: "v", segments: 5, w: 20, h: 240 },
    { key: "cd_seg10h", name: "代码 10 段条(水平)", orient: "h", segments: 10, w: 240, h: 18 },
    { key: "cd_seg10v", name: "代码 10 段条(垂直)", orient: "v", segments: 10, w: 18, h: 240 },
    { key: "cd_seg20h", name: "代码 20 段条(水平)", orient: "h", segments: 20, w: 240, h: 18 },
    { key: "cd_seg20v", name: "代码 20 段条(垂直)", orient: "v", segments: 20, w: 18, h: 240 },
    // 三段色带：**静态**的绿/黄/红阈值参考（与仪表的 `bands` 不是一回事，见 schema.js）
    { key: "cd_band3h", name: "代码三段色带(水平)", orient: "h", band: true, w: 240, h: 18 },
    { key: "cd_band3v", name: "代码三段色带(垂直)", orient: "v", band: true, w: 18, h: 240 },
    // 填充：轨道 + 一段主色填充（`fill` = 比例，拖进画布后可以改）
    { key: "cd_fillh", name: "代码填充条(水平)", orient: "h", fill: 0.62, w: 240, h: 16 },
    { key: "cd_fillv", name: "代码填充条(垂直)", orient: "v", fill: 0.62, w: 16, h: 240 },
    { key: "cd_fillglowh", name: "代码发光填充条(水平)", orient: "h", glow: true, fill: 0.62, w: 240, h: 18 },
    { key: "cd_fillglowv", name: "代码发光填充条(垂直)", orient: "v", glow: true, fill: 0.62, w: 18, h: 240 },
    // 阈值标记 / 游标：`fill` = 位置。轨道本身是透明的（`color: "transparent"` 不行 ——
    // 只认 #RRGGBB），所以用一个极窄的圆角条 + 主色，当"那条线"用
    { key: "cd_markerh", name: "代码阈值标记(水平)", orient: "h", fill: 1, radius: 2, w: 12, h: 32 },
    { key: "cd_markerv", name: "代码阈值标记(垂直)", orient: "v", fill: 1, radius: 2, w: 32, h: 12 },
    { key: "cd_cursorh", name: "代码发光游标(水平)", orient: "h", glow: true, fill: 1, radius: 2, w: 16, h: 40 },
    { key: "cd_cursorv", name: "代码发光游标(垂直)", orient: "v", glow: true, fill: 1, radius: 2, w: 40, h: 16 },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "▬",
      make: function () {
        // `assetId` 留空 —— `drawTrackNode` 不会去读它（`trackStyle` 非空就整个走代码画）
        const n = window.createNode(window.NODE_IMAGE, {
          name: d.name, assetId: "", x: 40, y: 40, w: d.w, h: d.h, z: 97,
          trackStyle: {
            orient: d.orient,
            radius: d.radius === undefined ? null : d.radius,
            inset: !!d.inset,
            gradient: d.gradient || null,
            glow: !!d.glow,
            segments: d.segments || 0,
            ticks: d.ticks || 0,
            band: !!d.band,
            fill: d.fill === undefined ? null : d.fill,
          },
        });
        return n;
      },
    });
  });

  // ---- 条形轨道（新分类的控件，以前一个都没有）
  [
    { key: "bar_trackh", name: "水平轨道", path: "assets/bar/track-h.png", w: 240, h: 16 },
    { key: "bar_trackv", name: "垂直轨道", path: "assets/bar/track-v.png", w: 16, h: 240 },
    // ---- 渐变轨道（v2.88.0 接进来）
    //
    // ## 为什么 v2.86.0 没接、现在接了
    //
    // v2.86.0 **故意**没接它，理由写在下面「闲置素材接线」那一段：
    // 那时它是**坏的** —— `gen-assets-more.js` 里 `c.fill()` 回调的 alpha 按 0..1 写，
    // 而约定是 0..255 → 渐变层**整层被丢掉**，与普通轨道逐像素**最大差只有 13/255**
    // （肉眼就是同一张图）。接进来等于给用户一个"名字叫渐变、看起来是普通轨道"的控件。
    //
    // v2.87.0 把它修好了（最大差 13 → **255**），所以 v2.88.0 接上。
    //
    // ## 用途（和普通轨道的分工）
    //
    // `track-h/v` 是**纯色**轨道（一整条一个颜色）；渐变轨道带**明暗过渡**，
    // 更像真车上"刻进面板的一根槽"（有高光/阴影的一侧）。
    // 什么时候用：
    //   · 轨道较长时，纯色在两端会显得"平"，渐变让它有纵深；
    //   · 深色夜间配色下，渐变的两端能自然收进背景，不会出现一条突兀的硬边。
    // 与 `track-glow-*`（整条发光）不是一回事：那个是"这条是活的"，
    // 这个是"这条有厚度"。
    //
    // ⚠️ 默认尺寸与 `bar_trackh/v` **逐像素对齐**（240×16 / 16×240），
    // 所以"把普通轨道换成渐变轨道"不会动到布局。
    { key: "bar_trackgradh", name: "渐变轨道(水平)", path: "assets/bar/track-gradient-h.png", w: 240, h: 16 },
    { key: "bar_trackgradv", name: "渐变轨道(垂直)", path: "assets/bar/track-gradient-v.png", w: 16, h: 240 },
    { key: "bar_fillh", name: "水平填充", path: "assets/bar/fill-h.png", w: 240, h: 16 },
    { key: "bar_fillv", name: "垂直填充", path: "assets/bar/fill-v.png", w: 16, h: 240 },
    { key: "bar_seg10h", name: "10 段条", path: "assets/bar/segment-10-h.png", w: 240, h: 18 },
    { key: "bar_seg10v", name: "10 段条(竖)", path: "assets/bar/segment-10-v.png", w: 18, h: 240 },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "▬",
      make: function () {
        const id = window.ensureBuiltinAsset ? window.ensureBuiltinAsset(d.path) : "";
        return window.createNode(window.NODE_IMAGE, {
          name: d.name, assetId: id, x: 40, y: 40, w: d.w, h: d.h, z: 97,
        });
      },
    });
  });

  // ---- 指示灯（第二批）**已并入上面那一张统一表**（v2.91.0）
  //
  // 原来这里是 16 个灯的独立块，与上面 3 个（`lamp_coolant` / `lamp_oil` /
  // `lamp_batt`）**各自写了一遍状态系统**，而且默认值不一样：
  //
  // | | normal.alpha | warn.blink |
  // |---|---|---|
  // | 上面 3 个（v1.20.16 之前就在） | 120（半透明 = "灯没亮"） | false |
  // | 这 16 个（v1.20.16 加的） | 255 | true（600ms） |
  //
  // 同一个"灯没亮"在库里有两套默认值，用户拖出来的观感不一样 —— 那不是设计，
  // 是分两批加的副作用。v2.91.0 合成**一张表**、默认值统一到 16 个那一套
  // （`normal.alpha = 120`、`warn.blink = true @600ms`）。
  //
  // ⚠️ 为什么不留着两套：`normal.alpha` 决定"暗态有多暗"，255 时暗态灯盘
  // 和"灯坏了"分不清；`warn.blink` 决定黄灯闪不闪 —— 两者都该只有一种答案。

  // ---- 数字刻度（v2.23.0，靠 5×7 点阵字库才做得出来）
  [
    { key: "img_digit0", name: "数字 0", path: "assets/scale/digit-0.png", w: 40, h: 56 },
    { key: "img_digit1", name: "数字 1", path: "assets/scale/digit-1.png", w: 40, h: 56 },
    { key: "img_digit2", name: "数字 2", path: "assets/scale/digit-2.png", w: 40, h: 56 },
    { key: "img_digit3", name: "数字 3", path: "assets/scale/digit-3.png", w: 40, h: 56 },
    { key: "img_digit4", name: "数字 4", path: "assets/scale/digit-4.png", w: 40, h: 56 },
    { key: "img_digit5", name: "数字 5", path: "assets/scale/digit-5.png", w: 40, h: 56 },
    { key: "img_digit6", name: "数字 6", path: "assets/scale/digit-6.png", w: 40, h: 56 },
    { key: "img_digit7", name: "数字 7", path: "assets/scale/digit-7.png", w: 40, h: 56 },
    { key: "img_digit8", name: "数字 8", path: "assets/scale/digit-8.png", w: 40, h: 56 },
    { key: "img_digit9", name: "数字 9", path: "assets/scale/digit-9.png", w: 40, h: 56 },
    { key: "img_numsarc9", name: "数字刻度弧", path: "assets/scale/nums-arc-9.png", w: 220, h: 220 },
    { key: "img_numsarc11", name: "数字弧(0~10)", path: "assets/scale/nums-arc-11.png", w: 220, h: 220 },
    { key: "img_numsrow", name: "横向数字行", path: "assets/scale/nums-row-6.png", w: 240, h: 34 },
    { key: "img_numscol", name: "纵向数字列", path: "assets/scale/nums-col-5.png", w: 40, h: 180 },
    { key: "img_unitrpm", name: "单位 RPM", path: "assets/scale/unit-rpm.png", w: 44, h: 20 },
    { key: "img_unitkmh", name: "单位 km/h", path: "assets/scale/unit-kmh.png", w: 70, h: 20 },
    { key: "img_unitc", name: "单位 °C", path: "assets/scale/unit-c.png", w: 34, h: 20 },
    { key: "img_unitv", name: "单位 V", path: "assets/scale/unit-v.png", w: 20, h: 20 },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "1",
      make: function () {
        const id = window.ensureBuiltinAsset ? window.ensureBuiltinAsset(d.path) : "";
        return window.createNode(window.NODE_IMAGE, {
          name: d.name, assetId: id, x: 40, y: 40, w: d.w, h: d.h, z: 97,
        });
      },
    });
  });

  // ================================================================ 闲置素材接线（v2.86.0）
  //
  // ## 依据
  //
  // `docs/控件库优化建议.md` §1.4「素材闲置」与建议 6（P1）。
  // 实测（脚本在 `ensureBuiltinAsset` 这个**唯一收口点**上收集路径）：
  // 359 个素材里只有 75 个被控件库引用，**284 个一个控件都没有**。
  // 这里把其中**确实有用**的接进来，每个都写清用途。
  //
  // ## 什么接了、什么没接（不是"全都塞进去"）
  //
  // 接了（见下面四组）：阈值标记/游标、轨道/填充/分段的**纹理变体**、
  // 单位字与数字符号的**缺口**、色带刻度、12 个常用图标、严重态灯底。
  //
  // 没接，以及为什么：
  //   1. **只差尺寸的变体** —— `bar/track-thin-h/v`（细）、`bar/track-thick-h/v`（粗）。
  //      控件拖进画布后本来就能拉伸改尺寸，为"细/粗"各加一个控件是纯噪音。
  //   2. ~~**已损坏的素材**~~ —— `bar/track-gradient-h/v` **v2.88.0 已接**
  //      （见上方「条形轨道」组）。它当时没接是**对的**：那时 `c.fill()` 的 alpha
  //      按 0..1 写而约定是 0..255，渐变层整层丢了，与 `bar/track-h/v`
  //      逐像素最大差只有 13/255（= 同一张图）。v2.87.0 修好后最大差是 **255**，
  //      于是接进来。**这一条留在原地当"当时为什么不接"的记录**，
  //      顺便说明"没接"不等于"忘了接" —— 判据是素材本身好不好。
  //   3. **刻度纹理的同类变体** —— `ticks-30f/45f/120f`、`ticks-major(-minor)`、
  //      `ticks-arc-outer/inner`、`ticks-radial-glow`、`ticks-dot-arc`、
  //      `ticks-bar(-h/-v)`、`ticks-vertical`、`ticks-corner`、`ticks-dual`、
  //      `ticks-inner`、`ticks-dots`、`ticks-segment-40`、`ticks-segment-20`（已有控件）。
  //      都是"画刻度"的纹理变体，而 style 0/7 的盘面是**程序化生成**的
  //      （`buildDial`，任意格数），这些图只影响观感、不带来新能力。
  //   4. **`turn/` 23 个与 `brand/` 14 个** —— `turn/` 的语义已被「指示灯」那一组
  //      （19 个带 `states` 三态切换的控件）覆盖，再摆一堆静态箭头只会让人分不清
  //      哪个"会亮"；`brand/` 是通用徽标（项目不做真实车标），画面上属于装饰，
  //      素材库面板可以直接拖。
  //   5. **`needle/` 17 个、`dashboard/` 15 个、`frame/` 19 个、`decor/` 37 个、
  //      `background/` 20 个** —— 同 3：同类变体，且 `img_*` 已有代表。
  //
  // ⚠️ **任何素材本来就能直接拖到画布**（素材库面板的提示原文：
  //    "素材从左侧素材库拖到画布即可添加新图片控件"），
  //    所以"接进控件库"买到的其实是**在控件面板里被发现**+**默认尺寸合适**，
  //    不是"不接就用不了"。这正是要挑、不能全塞的原因。
  //
  // ⚠️ 新 key 的前缀必须过 `CAT_RULES`（本文件下方），否则静默掉进「其它」——
  //    构建守卫会抓（tools/check-build-guard.ps1「控件不能掉进其它分类」那条）。

  /**
   * 批量登记「裸图片控件」。
   *
   * 与上面几组用的是同一套 `make()`（`ensureBuiltinAsset(path)` + `createNode(NODE_IMAGE)`），
   * 只是抽成一个函数 —— 这一批有 40+ 条，逐条抄 forEach 容易抄错 `w`/`h`。
   */
  function pushImageControls(icon, rows) {
    rows.forEach(function (d) {
      list.push({
        key: d.key, name: d.name, icon: icon,
        make: function () {
          const id = window.ensureBuiltinAsset ? window.ensureBuiltinAsset(d.path) : "";
          return window.createNode(window.NODE_IMAGE, {
            name: d.name, assetId: id, x: 40, y: 40, w: d.w, h: d.h, z: 97,
          });
        },
      });
    });
  }

  // ---- ① 阈值标记 / 游标（建议 4）
  //
  // 用途：在条形表上**看得见阈值在哪**。条形表（style 2）只在越线后才染红，
  // 开车时看不到"还有多远到红线"；marker 把那条线**先画出来**。
  // `marker-*` 是静态阈值标记（对应 `warnHigh`），
  // `marker-glow-*` 是发光游标（跟着当前值走，做"指针"用）。
  pushImageControls("┃", [
    { key: "bar_markerh", name: "阈值标记(水平)", path: "assets/bar/marker-h.png", w: 12, h: 32 },
    { key: "bar_markerv", name: "阈值标记(垂直)", path: "assets/bar/marker-v.png", w: 32, h: 12 },
    { key: "bar_markerglowh", name: "发光游标(水平)", path: "assets/bar/marker-glow-h.png", w: 16, h: 40 },
    { key: "bar_markerglowv", name: "发光游标(垂直)", path: "assets/bar/marker-glow-v.png", w: 40, h: 16 },
  ]);

  // ---- ② 轨道 / 填充 / 分段的纹理变体
  //
  // 用途：条形表（油量、水温、电量）**只有一种长相**是这类库最常见的问题。
  // 这 16 个各自对应一种真实用法，不是同一张图换名字：
  //   发光轨道   —— 强调"这条是活的"（充电、能量流）
  //   内凹轨道   —— 刻进面板里的凹槽，比平面轨道更像真表
  //   带刻度轨道 —— 条上直接读数，省掉另摆一排数字
  //   发光填充   —— 填充体本身发光，夜间可读
  //   渐变填充   —— 填充带明暗过渡，纯色填充在大屏上偏"塑料"
  //   5 段 / 20 段 —— 分段粒度：5 段像指针式油表，20 段像 LED 电量条
  pushImageControls("▬", [
    { key: "bar_trackglowh", name: "发光轨道(水平)", path: "assets/bar/track-glow-h.png", w: 240, h: 20 },
    { key: "bar_trackglowv", name: "发光轨道(垂直)", path: "assets/bar/track-glow-v.png", w: 20, h: 240 },
    { key: "bar_trackinseth", name: "内凹轨道(水平)", path: "assets/bar/track-inset-h.png", w: 240, h: 16 },
    { key: "bar_trackinsetv", name: "内凹轨道(垂直)", path: "assets/bar/track-inset-v.png", w: 16, h: 240 },
    { key: "bar_trackticksh", name: "带刻度轨道(水平)", path: "assets/bar/track-ticks-h.png", w: 240, h: 24 },
    { key: "bar_trackticksv", name: "带刻度轨道(垂直)", path: "assets/bar/track-ticks-v.png", w: 24, h: 240 },
    { key: "bar_fillglowh", name: "发光填充(水平)", path: "assets/bar/fill-glow-h.png", w: 240, h: 16 },
    { key: "bar_fillglowv", name: "发光填充(垂直)", path: "assets/bar/fill-glow-v.png", w: 16, h: 240 },
    { key: "bar_fillgradh", name: "渐变填充(水平)", path: "assets/bar/fill-gradient-h.png", w: 240, h: 16 },
    { key: "bar_fillgradv", name: "渐变填充(垂直)", path: "assets/bar/fill-gradient-v.png", w: 16, h: 240 },
    { key: "bar_seg5h", name: "5 段条(水平)", path: "assets/bar/segment-5-h.png", w: 240, h: 20 },
    { key: "bar_seg5v", name: "5 段条(垂直)", path: "assets/bar/segment-5-v.png", w: 20, h: 240 },
    { key: "bar_seg20h", name: "20 段条(水平)", path: "assets/bar/segment-20-h.png", w: 240, h: 18 },
    { key: "bar_seg20v", name: "20 段条(垂直)", path: "assets/bar/segment-20-v.png", w: 18, h: 240 },
    // 三段色带（绿/黄/红）：**静态的阈值参考**，铺在轨道底下当分区底色。
    // 与建议 3 的 `bands` 不冲突 —— 那个是按量程算的动态色带（App 侧），
    // 这个是"印在条上的刻度区"，不需要任何数据。
    { key: "bar_band3h", name: "三段色带(水平)", path: "assets/bar/band-3-h.png", w: 240, h: 18 },
    { key: "bar_band3v", name: "三段色带(垂直)", path: "assets/bar/band-3-v.png", w: 18, h: 240 },
  ]);

  // ---- ③ 单位字与数字符号：**补真实的缺口**，不是加变体
  //
  // 单位字素材有 10 种，控件库原来只暴露了 4 种（RPM / km/h / °C / V）——
  // A（电流）、%（电量/负荷）、bar（增压）、L/100km（油耗）、km（续航）、
  // ×1000（转速倍率）六种**没有任何入口**，用户只能手摆文字。
  // 数字块 0~9 都有了，但 `.` / `-` / `%` 三个符号没有 —— 于是
  // **小数、负数、百分比都拼不出来**（这恰好是电压、油耗、电量最常见的三种读数）。
  pushImageControls("1", [
    { key: "img_unita", name: "单位 A", path: "assets/scale/unit-a.png", w: 20, h: 20 },
    { key: "img_unitpct", name: "单位 %", path: "assets/scale/unit-pct.png", w: 20, h: 20 },
    { key: "img_unitbar", name: "单位 bar", path: "assets/scale/unit-bar.png", w: 44, h: 20 },
    { key: "img_unitl100", name: "单位 L/100km", path: "assets/scale/unit-l100.png", w: 92, h: 20 },
    { key: "img_unitkm", name: "单位 km", path: "assets/scale/unit-km.png", w: 32, h: 20 },
    { key: "img_unitx1000", name: "单位 ×1000", path: "assets/scale/unit-x1000.png", w: 68, h: 20 },
    { key: "img_digitdot", name: "小数点块", path: "assets/scale/digit-dot.png", w: 40, h: 56 },
    { key: "img_digitminus", name: "负号块", path: "assets/scale/digit-minus.png", w: 40, h: 56 },
    { key: "img_digitpct", name: "百分号块", path: "assets/scale/digit-pct.png", w: 40, h: 56 },
  ]);

  // ---- ④ 刻度数字的**量程/跳级**变体
  //
  // 用途：`nums-arc-9` 是 0~8、`nums-arc-11` 是 0~10，两个都只适合"每格 1 个单位"。
  // 车上的表几乎不是这样：转速 0~8000 标 0/2/4/6/8，车速标 0/10/20/…/50，
  // 电量标 0/25/50/75/100。这三个数字行 + 两个弧 + 一个列正好覆盖这几种。
  pushImageControls("8", [
    { key: "img_numsarcjump5", name: "数字弧 0/2/4/6/8", path: "assets/scale/nums-arc-jump5.png", w: 220, h: 220 },
    { key: "img_numsarc5", name: "数字弧 0~4(大号)", path: "assets/scale/nums-arc-5.png", w: 220, h: 220 },
    { key: "img_numsroweven", name: "数字行 0/2/4/6/8/10", path: "assets/scale/nums-row-even.png", w: 200, h: 36 },
    { key: "img_numsrowtens", name: "数字行 0/10/…/50", path: "assets/scale/nums-row-tens.png", w: 256, h: 36 },
    { key: "img_numscolpct", name: "数字列 0/25/…/100", path: "assets/scale/nums-col-pct.png", w: 72, h: 190 },
  ]);

  // ---- ⑤ 色带刻度（建议 3 的素材侧）
  //
  // 用途：**画红区**。这两个素材在仓库里躺了很久、一个控件都没有引用
  // （`ticks-band` 是"带色带的刻度环"，`ticks-gradient` 是"渐变刻度环"）。
  // 现在 `bands` 字段还没做（见 CHANGELOG 的评估），在那之前，
  // 想要"转速表有红区"只能靠这两个素材 —— 接进来至少让这件事**现在就能做**。
  pushImageControls("◔", [
    { key: "img_ticksband", name: "色带刻度(红区)", path: "assets/scale/ticks-band.png", w: 240, h: 240 },
    { key: "img_ticksgrad", name: "渐变刻度", path: "assets/scale/ticks-gradient.png", w: 240, h: 240 },
  ]);

  // ---- ⑥ 常用图标（建议 6 的 "icon 类小件"）
  //
  // 48 个图标素材**一个都没进控件库**。这里只挑 12 个：
  // 判据是"车机上会跟一个读数/状态一起出现，而且没有更合适的现成控件"。
  // 例如油量：`lamp_fuel` 是**告警灯**（三态会闪），语义是"该加油了"；
  // 这里要的是**静态油量图标**（配一个 45% 的读数），两者不能互相替代。
  //
  // ⚠️ 剩下 36 个（导航/音乐/电话/空调/GPS/Wi-Fi/蓝牙/USB…）**没接**：
  //    它们是"车机应用图标"，不是仪表元件；要用的话素材库面板直接拖即可。
  pushImageControls("◈", [
    { key: "img_icfuel", name: "图标 油量", path: "assets/icon/fuel.png", w: 44, h: 44 },
    { key: "img_ictemp", name: "图标 温度", path: "assets/icon/temp.png", w: 44, h: 44 },
    { key: "img_icbatt", name: "图标 电池", path: "assets/icon/battery.png", w: 44, h: 44 },
    { key: "img_icoil", name: "图标 机油", path: "assets/icon/oil.png", w: 44, h: 44 },
    { key: "img_icturbo", name: "图标 涡轮", path: "assets/icon/turbo.png", w: 44, h: 44 },
    { key: "img_icgear", name: "图标 变速箱", path: "assets/icon/gear.png", w: 44, h: 44 },
    { key: "img_icodo", name: "图标 里程", path: "assets/icon/odo.png", w: 44, h: 44 },
    { key: "img_icrange", name: "图标 续航", path: "assets/icon/range.png", w: 44, h: 44 },
    { key: "img_icclock", name: "图标 时钟", path: "assets/icon/clock.png", w: 44, h: 44 },
    { key: "img_icgps", name: "图标 GPS", path: "assets/icon/gps.png", w: 44, h: 44 },
    { key: "img_iccheck", name: "图标 正常", path: "assets/icon/check.png", w: 44, h: 44 },
    { key: "img_iccross", name: "图标 故障", path: "assets/icon/cross.png", w: 44, h: 44 },
  ]);

  // ---- ⑦ 严重态灯底（三态灯的第三张底图）
  //
  // 用途：19 个指示灯控件用的底图是 `lamp-off`（暗）与 `lamp-warn`（黄），
  // **`lamp-crit`（红）一个控件都没有**。用户想自己拼一个"严重态"的灯时，
  // 只能拿 `lamp-warn` 凑 —— 但那是黄的，语义不对。
  pushImageControls("⚠", [
    { key: "img_lampcrit", name: "严重态灯底", path: "assets/warning/lamp-crit.png", w: 56, h: 56 },
  ]);

  // ---- ⑧ 告警条底板（建议 5 的素材侧）
  //
  // 用途：`MonitorWarnBar.kt` 在 App 侧会在"轮询暂停"时压一条**非闪烁**的警示条，
  // 但素材库里没有任何横幅素材（`frame/panel-*.png` 都是 256×256 方板，比例不对）。
  // 这块 256×56 的底板配一个图标 + 一段文字，就能在设计器里画出同形的告警条。
  // ⚠️ 底板刻意**不带颜色语义**：三态的颜色交给叠在上面的图标与文字。
  pushImageControls("▭", [
    { key: "img_alertbar", name: "告警条底板", path: "assets/frame/alert-bar.png", w: 260, h: 56 },
  ]);

  // ================================================================ 分类（v2.22.0）
  //
  // 40 → 78 个控件平铺在一个网格里已经很难找了。给每个控件定一个 `cat`，
  // UI 按 `cat` 分组渲染 + 显示组内数量。
  //
      // ---- v2.35.0 新增的拼装表模板 ----
      //
      // 为什么补这块：「拼装表」原来只有 2 个，而 v2.32.0 刚让**子部件能在画布上直接拖**，
      // 模板太少的话这个能力没有用武之地。
      //
      // 下面这四个各自演示一种组合方式（双针双数字 / 三环 / 大数字 / 条形油量），
      // 拖进去之后**每个部件都能单独选中拖动**。

      list.push({
        key: "gauge_parts_dual", name: "拼装双针双数字", icon: "✦",
        make: function () {
          const E = window.ensureBuiltinAsset || function () { return ""; };
          const n = window.createNode(window.NODE_GAUGE, {
            name: "拼装双针双数字", pid: "obd.rpm", style: 0,
            min: 0, max: 8000, warnHigh: 6500,
            x: 40, y: 40, w: 200, h: 200, z: 99,
          });
          n.parts = [
            window.normalizePart({ kind: "dial",  assetId: E("assets/dashboard/ring-thick.png"), x: 0, y: 0, w: 200, h: 200 }),
            window.normalizePart({ kind: "ticks", assetId: E("assets/scale/ticks-60.png"), x: 8, y: 8, w: 184, h: 184 }),
            // 长针跟仪表自己的 PID（转速）
            window.normalizePart({ kind: "needle", assetId: E("assets/needle/needle-classic.png"),
              x: 76, y: 4, w: 48, h: 192,
              pivotX: 0.5, pivotY: 0.5, sweepFrom: 135, sweepTo: 405,
              // 两个针共用一段弧 —— 开着这个就不用填两遍（v2.27.0）
              sweepFollow: true }),
            window.normalizePart({ kind: "needle", assetId: E("assets/needle/needle-short.png"),
              x: 76, y: 76, w: 48, h: 96,
              pivotX: 0.5, pivotY: 0.5, sweepFrom: 135, sweepTo: 405,
              sweepFollow: true, rawPid: "obd.speed" }),
            // **两个数字读数各绑一个 PID**（v2.27.0 起 value 也能绑）
            window.normalizePart({ kind: "value", x: 24, y: 132, w: 64, h: 32 }),
            window.normalizePart({ kind: "value", x: 112, y: 132, w: 64, h: 32, rawPid: "obd.speed" }),
          ];
          return n;
        },
      });

      list.push({
        key: "gauge_parts_triple", name: "拼装三环", icon: "✦",
        make: function () {
          const E = window.ensureBuiltinAsset || function () { return ""; };
          const n = window.createNode(window.NODE_GAUGE, {
            name: "拼装三环", pid: "obd.rpm", style: 0,
            min: 0, max: 8000,
            x: 40, y: 40, w: 200, h: 200, z: 99,
          });
          // 三层同心：底盘 → 刻度 → 外圈光晕。用 dial-triple 当外圈
          n.parts = [
            window.normalizePart({ kind: "dial",  assetId: E("assets/dashboard/dial-triple.png"), x: 0, y: 0, w: 200, h: 200 }),
            window.normalizePart({ kind: "ticks", assetId: E("assets/scale/ticks-90f.png"), x: 14, y: 14, w: 172, h: 172 }),
            window.normalizePart({ kind: "decor", assetId: E("assets/decor/glow-ring.png"), x: -6, y: -6, w: 212, h: 212, alpha: 140 }),
            window.normalizePart({ kind: "needle", assetId: E("assets/needle/needle-blade.png"),
              x: 84, y: 10, w: 32, h: 180,
              pivotX: 0.5, pivotY: 0.5, sweepFrom: 135, sweepTo: 405 }),
            window.normalizePart({ kind: "decor", assetId: E("assets/needle/needle-cap.png"), x: 78, y: 78, w: 44, h: 44 }),
            window.normalizePart({ kind: "value", x: 66, y: 120, w: 68, h: 36 }),
          ];
          return n;
        },
      });

      list.push({
        key: "gauge_parts_bigval", name: "拼装大数字", icon: "✦",
        make: function () {
          const E = window.ensureBuiltinAsset || function () { return ""; };
          const n = window.createNode(window.NODE_GAUGE, {
            name: "拼装大数字", pid: "obd.speed", style: 0,
            min: 0, max: 240,
            x: 40, y: 40, w: 200, h: 200, z: 99,
          });
          // 极端取向：一根细弧 + 一个占满的读数。适合当副表
          n.parts = [
            window.normalizePart({ kind: "dial",  assetId: E("assets/dashboard/dial-270.png"), x: 0, y: 0, w: 200, h: 200 }),
            window.normalizePart({ kind: "ticks", assetId: E("assets/scale/ticks-segment-20.png"), x: 10, y: 10, w: 180, h: 180 }),
            window.normalizePart({ kind: "value", x: 40, y: 74, w: 120, h: 56 }),
            window.normalizePart({ kind: "decor", assetId: E("assets/scale/unit-kmh.png"), x: 78, y: 132, w: 44, h: 20, alpha: 160 }),
          ];
          return n;
        },
      });

      list.push({
        key: "gauge_parts_fuel", name: "拼装条形油量", icon: "✦",
        make: function () {
          const E = window.ensureBuiltinAsset || function () { return ""; };
          const n = window.createNode(window.NODE_GAUGE, {
            name: "拼装条形油量", pid: "obd.fuel_level", style: 0,
            min: 0, max: 100, warnLow: 15,
            x: 40, y: 40, w: 200, h: 60, z: 99,
          });
          // 横向布局：外壳 + 轨道 + 分段填充 + 标签。宽扁形，适合放边角
          n.parts = [
            window.normalizePart({ kind: "dial",  assetId: E("assets/decor/plate-blank.png"), x: 0, y: 0, w: 200, h: 60 }),
            window.normalizePart({ kind: "ticks", assetId: E("assets/bar/track-h.png"), x: 12, y: 16, w: 176, h: 16 }),
            window.normalizePart({ kind: "decor", assetId: E("assets/bar/fill-h.png"), x: 12, y: 16, w: 176, h: 16, alpha: 200 }),
            window.normalizePart({ kind: "value", x: 12, y: 36, w: 176, h: 20 }),
          ];
          return n;
        },
      });

  // 用**规则推导**而不是逐个手写 `cat`：控件是分批 push 的（有的在循环里），
  // 逐个标注容易漏；规则只有一处，看 key 前缀就知道归哪组。
  const CAT_RULES = [
    [/^gauge_parts/, "拼装表"],
    [/^gauge_/, "仪表样式"],
    [/^g_/, "常用仪表"],
    [/^t_/, "文字"],
    [/^lamp_/, "指示灯"],
    // v2.91.0：**代码绘制的条形轨道**单独一组。
    //
    // ⚠️ 必须放在 `/^bar_/` **前面**吗？不需要 —— `cd_` 与 `bar_` 不重叠。
    // 但它必须**存在**：`CAT_RULES` 是前缀匹配，漏了就会静默掉进「其它」，
    // 而构建守卫会报「控件掉进『其它』分类」（那条守卫就是为这个加的）。
    [/^cd_/, "条形轨道(代码)"],
    // v2.86.0：`ticks` / `seg` 补进来。原来只列了 digit/nums/unit，
    // 于是 `img_ticks90`（90 格刻度）、`img_seg20`（20 段弧）掉进了「图片 / 底盘」——
    // 作者本来就打算把"刻度类"分出来（这条规则的存在就是证据），只是前缀枚举漏了。
    // 这是 `docs/控件库优化建议.md` 建议 8 的第 ② 条，顺手落地。
    [/^img_(digit|nums|unit|ticks|seg)/, "数字刻度"],
    // v2.86.0：图标单独一组。12 个 `assets/icon/*` 控件混在 30 多个"底盘/装饰"里
    // 找不出来，而它们的用途完全不同（小尺寸、跟读数走）。
    [/^img_ic/, "图标"],
    [/^img_/, "图片 / 底盘"],
    [/^bar_/, "条形轨道"],
    [/^(group|image|text|box)(_|$)/, "容器 / 基础"],
  ];
  list.forEach(function (c) {
    const hitRule = CAT_RULES.find(function (r) { return r[0].test(c.key); });
    c.cat = hitRule ? hitRule[1] : "其它";
  });
  /** 分类的展示顺序（固定，不随 push 顺序变 —— 否则每次改代码组序都会跳） */
  // ⚠️ v2.91.0：`条形轨道(代码)` 紧挨着 `条形轨道` 放 —— 用户找"条"的时候
  // 两批应该在一起，而不是一个在头一个在尾。
  window.CTRL_CATS = ["仪表样式", "常用仪表", "拼装表", "条形轨道", "条形轨道(代码)",
    "文字", "指示灯", "数字刻度", "图标", "图片 / 底盘", "容器 / 基础", "其它"];

  return list;
})();

  /** 把模板节点实例化到画布：深拷贝 + 换新 id + 错开位置 */
  window.instantiateControl = function (template, at) {
    const c = window.clone(template);
    (function reid(n) {
      n.id = window.newId(n.type === window.NODE_GROUP ? "g" : "n");
      (n.children || []).forEach(reid);
    })(c);
    if (at) { c.x = at.x; c.y = at.y; }
    else { c.x = window.clamp((c.x || 0) + window.STEP, 0, window.CANVAS - c.w); c.y = window.clamp((c.y || 0) + window.STEP, 0, window.CANVAS - c.h); }
    return c;
  };

  // ================================================================ 差异清单

  /**
   * 与 App 规则的差异。**显式列出，不假装一致**。
   *
   * 分三类：一致 / 差异 / 未做。「一致」也要写 —— 那是跨语言比对脚本守着的部分。
   */
  window.DIFF_NOTES = [
    ["一致", "schema / canvas.unit / 缺 pid / min≥max / 未知 pid / 缺 meta 的判定与文案，逐条对齐 DesignFile.kt"],
    ["一致", "PID 别名表（27 条）与内置 PID 量程，抄自 DesignFile.PID_ALIASES 与 BuiltInPids.kt"],
    ["一致", "背景段的 path / fit 判定与「路径不存在只警告不报错」，对齐 DesignFile.parseBackground"],
    ["一致", "卡片外框 CARD_NAMES、霓虹档位名、样式编号 0..7、指针环 0/1"],
    ["一致", "吸附步长 15、最小尺寸 30、移动与缩放的夹取公式，抄自 DashLayout.Drag"],
    ["一致", "v1 设计文件自动升级成 v2 节点树（一对一，不改坐标、不改绘制顺序）"],
    ["差异", "**越界警告只查根节点** —— v2 子节点的 x/y 相对父节点，溢出父级是正常设计（指针伸出表盘）。v1 没有层级，所以那时查所有"],
    ["差异", "**状态判定不带迟滞** —— 指示灯的状态判定**两边都没有迟滞**（App 的 `NodeTreeRenderer.resolveState` 与工具的 `resolveStateName` 逐条同源：阈值来源、危险线的「中点」推断、比较方向都一致）。带迟滞的是**仪表报警的爆闪**（App 走 `AlertPulse`，`HYSTERESIS = 0.03`），工具里是简单比较 —— 所以阈值附近抖动时，预览的爆闪会比真机更「跳」。"],
    ["差异", "JSON 语法错误的**文案**不同：App 用 org.json，本工具用浏览器 JSON.parse。位置信息本工具更精确，但两边不可能逐字相同"],
    ["差异", "**「素材路径不存在」这条警告只有 App 能给** —— 浏览器读不到设备路径（沙箱限制），所以工具只校验 assetId 是否在清单里"],
    ["差异", "背景图与素材**只在工具里预览**，写进 JSON 的只有路径。图片本身要放到设计文件同目录的 assets/ 下"],
    ["一致", "**背景图的 `w`/`h`（尺寸）App 也读** —— `DashCanvasPageFragment.kt:335` 按 `bgW`/`bgH` 换算成像素矩形画（`PositionedBackgroundDrawable`），与工具的「这张底图只占中间一块」一致"],
    ["一致", "**旋转是在「设备空间」施加的**（先排好版、再旋转）—— App 用 `View.setRotation`（`NodeTreeRenderer.kt:206`），语义正好相同；`stretch` 模式下不会得到平行四边形"],
    ["一致", "**分组的旋转/缩放会带着子控件一起转** —— App 把节点放进 `ViewGroup` 并设 `rotation` / `scaleX/Y`（`NodeTreeRenderer.kt:201-208`），变换逐层叠加，与工具的 `withDeviceRotation` 同一套"],
    ["差异", "工具里**吸附可开关**（App 侧也有 dashSnapEnabled，但那是给拖拽编辑器用的）"],
    ["一致", "**App 已能解析 `icar.ui/2`**（节点树 / 字体 / 状态 / 缩放模式），v1 文件自动升级成节点树"],
    ["一致", "**App 侧的 v2 渲染已完成**（v1.11.0 / v1.12.0）：节点树 / 图片 / 分组 / 文字 / 旋转 / 图层顺序 / 缩放模式 / 状态系统 / 子部件 / 多页面都会画（`DashRenderer.kt` 的 `nodeRenderer` + `NodeTreeRenderer.kt`）。见 docs/主题设计大纲.md §七"],
    ["差异", "**App 导出仍写 v1** —— `DesignFile.toJson()` 写的是 `SCHEMA = \"icar.ui/1\"`（`DesignFile.kt:182`）。v2 目前是**只读**格式：App 读得进、画得出，但导出仍走 v1"],
    ["未做", "素材库不预置图片（车标等版权不属于本项目），分类只是标签"],
    ["未做", "控件树的拖拽只能改父子关系，**不能改同层顺序**（顺序请用「上移/下移/置顶/置底」）"],
    ["未做", "撤销栈**会持久化到 localStorage**（v2.7.0 起，刷新页面后还能退），但只保留**最近约 40 步 / 1.2 MB** —— 更早的步骤刷新后会丢"],
    ["未做", "右键菜单是**自绘**的（浏览器原生菜单没法按选中项变内容），所以外观与系统菜单不同"],
  ];

  /**
   * `**加粗**` → `<b>加粗</b>`（v2.83.0，Round 5）。
   *
   * ## 为什么需要它
   *
   * `DIFF_NOTES` 的文案是**按 Markdown 写的**（`**加粗**` 强调关键短语），
   * 但 `renderDiff` 原来用 `textContent` 写入 —— 于是界面上**原样显示星号**：
   *
   * ```
   * 【差异】**越界警告只查根节点** —— v2 子节点的 x/y 相对父节点…
   * ```
   *
   * 用户看到的是排版噪音，不是强调。改成渲染成 `<b>`。
   *
   * ⚠️ **先转义再替换**：这个函数只喂静态文案，但转义不能省 ——
   * 文案里有 `<` `>` 的可能，不转义会被当成标签吃掉。
   */
  function boldify(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  }

  window.renderDiff = function () {
    const box = document.getElementById("diffBox");
    if (!box) return;
    box.innerHTML = "";
    window.DIFF_NOTES.forEach(function (pair) {
      const d = document.createElement("div");
      d.className = "msg " + (pair[0] === "一致" ? "ok" : (pair[0] === "差异" ? "warn" : "err"));
      d.innerHTML = "【" + pair[0] + "】" + boldify(pair[1]);
      box.appendChild(d);
    });
  };
})();
