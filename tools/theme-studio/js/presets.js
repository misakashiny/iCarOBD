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
      normal: { assetId: "", alpha: 77, blink: false, blinkMs: 200 },
      warn: { assetId: "", alpha: 255, blink: false, blinkMs: 200 },
      critical: { assetId: "", alpha: 255, blink: true, blinkMs: 200 },
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

      // ---- 警告灯：带**状态系统**，按 PID 自动切三态图
      [
        { key: "lamp_coolant", name: "水温灯", pid: "obd.coolant",
          normal: "assets/warning/lamp-off.png", warn: "assets/warning/lamp-warn.png",
          crit: "assets/warning/coolant-warn.png" },
        { key: "lamp_oil", name: "机油灯", pid: "tpl_oilPressure",
          normal: "assets/warning/lamp-off.png", warn: "assets/warning/lamp-warn.png",
          crit: "assets/warning/oil-warn.png" },
        { key: "lamp_batt", name: "电池灯", pid: "obd.voltage",
          normal: "assets/warning/lamp-off.png", warn: "assets/warning/lamp-warn.png",
          crit: "assets/warning/battery-warn.png" },
      ].forEach(function (d) {
        list.push({
          key: d.key, name: d.name, icon: "⚠",
          make: function () {
            const E = window.ensureBuiltinAsset || function () { return ""; };
            return window.createNode(window.NODE_IMAGE, {
              name: d.name, x: 40, y: 40, w: 56, h: 56, z: 99,
              assetId: E(d.normal),
              statePid: d.pid,
              states: {
                normal:   { assetId: E(d.normal), alpha: 120, blink: false, blinkMs: 200 },
                warn:     { assetId: E(d.warn),   alpha: 255, blink: false, blinkMs: 200 },
                critical: { assetId: E(d.crit),   alpha: 255, blink: true,  blinkMs: 220 },
              },
            });
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
    { key: "g_speed_d", name: "数字车速", pid: "obd.speed", style: 1, w: 220, h: 110, icon: "▬" },
    // ⚠️ 挡位是**枚举**，不是连续量 —— 见 P9「非数值 PID 模型」方向 A。
    // 值仍然是 0..8 的数（指针/条照常按数值走），**只有读数**查 valueLabels。
    // `min`/`max` 写死在这里：`obd.gear` 目前还不在 PID 库里，
    // 靠 BUILTIN_PIDS 兜底会得到 0~100（那是指针几乎不动的量程）
    { key: "g_gear", name: "挡位", pid: "obd.gear", style: 1, w: 100, h: 100, icon: "▬",
      min: 0, max: 8,
      valueLabels: ["P", "R", "N", "1", "2", "3", "4", "5", "6"] },
    { key: "g_soc", name: "电池电量", pid: "obd.soc", style: 2, w: 120, h: 120, icon: "◍" },
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

  // ---- 条形轨道（新分类的控件，以前一个都没有）
  [
    { key: "bar_trackh", name: "水平轨道", path: "assets/bar/track-h.png", w: 240, h: 16 },
    { key: "bar_trackv", name: "垂直轨道", path: "assets/bar/track-v.png", w: 16, h: 240 },
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

  // ---- 指示灯（第二批）：ISO 2575 的常见条目
  [
    { key: "lamp_brake", name: "制动灯", pid: "obd.brakeFluid", crit: "assets/warning/brake.png" },
    { key: "lamp_pad", name: "刹车片", pid: "obd.brakePad", crit: "assets/warning/brake-pad.png" },
    { key: "lamp_tpms", name: "胎压灯", pid: "obd.tpms", crit: "assets/warning/tpms.png" },
    { key: "lamp_airbag", name: "气囊灯", pid: "obd.airbag", crit: "assets/warning/airbag.png" },
    { key: "lamp_belt", name: "安全带灯", pid: "obd.seatbelt", crit: "assets/warning/seatbelt.png" },
    { key: "lamp_abs", name: "ABS 灯", pid: "obd.abs", crit: "assets/warning/abs-warn.png" },
    { key: "lamp_esp", name: "ESP 灯", pid: "obd.esp", crit: "assets/warning/esp-warn.png" },
    { key: "lamp_engine", name: "发动机灯", pid: "obd.engineFault", crit: "assets/warning/engine.png" },
    { key: "lamp_fuel", name: "燃油报警", pid: "obd.fuel_level", crit: "assets/warning/fuel-low.png" },
    { key: "lamp_door", name: "车门未关", pid: "obd.door", crit: "assets/warning/door-warn.png" },
    { key: "lamp_washer", name: "玻璃水", pid: "obd.washer", crit: "assets/warning/washer.png" },
    { key: "lamp_service", name: "保养提示", pid: "obd.service", crit: "assets/warning/service.png" },
    { key: "lamp_temp", name: "水温报警", pid: "obd.coolant", crit: "assets/warning/coolant-warn.png" },
    { key: "lamp_charge", name: "充电提示", pid: "obd.voltage", crit: "assets/warning/charge-cable.png" },
    { key: "lamp_lane", name: "车道辅助", pid: "obd.laneKeep", crit: "assets/warning/lane-keep.png" },
    { key: "lamp_collision", name: "碰撞预警", pid: "obd.collision", crit: "assets/warning/collision.png" },
  ].forEach(function (d) {
    list.push({
      key: d.key, name: d.name, icon: "⚠",
      make: function () {
        const off = window.ensureBuiltinAsset("assets/warning/lamp-off.png");
        const warn = window.ensureBuiltinAsset("assets/warning/lamp-warn.png");
        const crit = window.ensureBuiltinAsset(d.crit);
        const n = window.createNode(window.NODE_IMAGE, {
          name: d.name, assetId: off, x: 40, y: 40, w: 56, h: 56, z: 96,
        });
        // **状态系统**：按 PID 自动切三态图（与既有指示灯同一个套路）
        n.pid = window.resolvePid(d.pid);
        n.rawPid = d.pid;
        n.states = {
          normal: { assetId: off, alpha: 255, blink: false, blinkMs: 200 },
          warn: { assetId: warn, alpha: 255, blink: true, blinkMs: 600 },
          critical: { assetId: crit, alpha: 255, blink: true, blinkMs: 260 },
        };
        return n;
      },
    });
  });

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
    [/^img_(digit|nums|unit)/, "数字刻度"],
    [/^img_/, "图片 / 底盘"],
    [/^bar_/, "条形轨道"],
    [/^(group|image|text|box)(_|$)/, "容器 / 基础"],
  ];
  list.forEach(function (c) {
    const hitRule = CAT_RULES.find(function (r) { return r[0].test(c.key); });
    c.cat = hitRule ? hitRule[1] : "其它";
  });
  /** 分类的展示顺序（固定，不随 push 顺序变 —— 否则每次改代码组序都会跳） */
  window.CTRL_CATS = ["仪表样式", "常用仪表", "拼装表", "条形轨道", "文字", "指示灯", "数字刻度", "图片 / 底盘", "容器 / 基础", "其它"];

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
    ["差异", "**状态判定不带迟滞** —— App 用 AlertPulse 的迟滞（避免阈值附近乱闪），工具里只做简单比较（预览不需要迟滞，而且迟滞会让「改阈值立刻看到效果」变难）"],
    ["差异", "JSON 语法错误的**文案**不同：App 用 org.json，本工具用浏览器 JSON.parse。位置信息本工具更精确，但两边不可能逐字相同"],
    ["差异", "**「素材路径不存在」这条警告只有 App 能给** —— 浏览器读不到设备路径（沙箱限制），所以工具只校验 assetId 是否在清单里"],
    ["差异", "背景图与素材**只在工具里预览**，写进 JSON 的只有路径。图片本身要放到设计文件同目录的 assets/ 下"],
    ["差异", "**背景图的 `w`/`h`（尺寸）只有工具在用** —— App 的 `DesignFile.Background` 目前只读 `path` 与 `fit`，会忽略这两个字段。要等「阶段 2」"],
    ["差异", "**旋转是在「设备空间」施加的**（先排好版、再旋转），与 App 的 `view.rotation` 同一语义。阶段 2 实现 App 侧渲染时**必须照做**，否则 `stretch` 模式下会得到平行四边形（实测 45° 时对角线差 209px、内容放大 1.82 倍）"],
    ["差异", "**分组的旋转会带着子控件一起转**（逐层在设备空间旋转）。App 侧要等阶段 2 支持 `ViewGroup` 变换"],
    ["差异", "工具里**吸附可开关**（App 侧也有 dashSnapEnabled，但那是给拖拽编辑器用的）"],
    ["一致", "**App 已能解析 `icar.ui/2`**（节点树 / 字体 / 状态 / 缩放模式），v1 文件自动升级成节点树"],
    ["未做", "**App 侧的 v2 渲染还没做** —— 图片 / 分组 / 文字 / 旋转 / 图层顺序 / 状态系统目前**解析了但不绘制**，画布上只画仪表。见 docs/主题设计大纲.md §七"],
    ["差异", "**App 导出仍写 v1** —— 因为 v2 渲染没做完，导出 v2 会产出「App 自己读得进但画不出来」的文件"],
    ["未做", "素材库不预置图片（车标等版权不属于本项目），分类只是标签"],
    ["未做", "控件树的拖拽只能改父子关系，**不能改同层顺序**（顺序请用「上移/下移/置顶/置底」）"],
    ["未做", "撤销栈存在内存里，**刷新页面会丢**"],
    ["未做", "右键菜单是**自绘**的（浏览器原生菜单没法按选中项变内容），所以外观与系统菜单不同"],
  ];

  window.renderDiff = function () {
    const box = document.getElementById("diffBox");
    if (!box) return;
    box.innerHTML = "";
    window.DIFF_NOTES.forEach(function (pair) {
      const d = document.createElement("div");
      d.className = "msg " + (pair[0] === "一致" ? "ok" : (pair[0] === "差异" ? "warn" : "err"));
      d.textContent = "【" + pair[0] + "】" + pair[1];
      box.appendChild(d);
    });
  };
})();
