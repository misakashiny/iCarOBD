/* ==========================================================================
   js/registry/datasource-registry.js —— 数据源注册表与可用性判定（P1A）
   ==========================================================================

   ## 它解决什么

   P0.5 核验发现（见 `docs/01_专题/31_...` 勘误）：
   **19 个状态灯里只有 6 个在 App 侧真有数据源**，
   其中 1 个只到「工具认识、App 不认识」，12 个**两边都没有实现**。

   但旧代码里它们长得一模一样：能拖、能绑、能存盘。
   用户没法分辨「车没故障」和「这条路根本不通」。

   本 Registry 把「能不能用」变成一个**显式、可查询**的事实。

   ## 四层语义（来自 P0.5 核验要求）

   | 层级 | 含义 | 判定依据 |
   |---|---|---|
   | `L1` | App 已实现数据源 | 别名可解析 + App 有对应 PID 实现（非厂家模板） |
   | `L2` | App 仅识别别名，语义未验证 | 别名可解析，但是厂家模板（`tpl_*`）或无实现 |
   | `L3` | 车辆能否实际提供未确认 | 有实现但缺真车证据 |
   | `L4` | 工具和 App 都未实现 | 别名在两边都不存在 |

   ⚠️ **「别名可解析」不等于「设备上可用」** —— 这是 P0.5 明确要求区分的一条。
   所以本文件**不猜测**，只按可获得的证据分层，并在注释里写清每层的证据来源。
   ========================================================================== */
"use strict";

(function () {
  const ICAR = window.ICAR;
  if (!ICAR) throw new Error("datasource-registry.js 必须在 core/namespace.js 之后加载");

  /** 四层语义常量（导出给测试与 UI 用） */
  const TIER = Object.freeze({
    L1: "L1", // App 已实现数据源
    L2: "L2", // App 仅识别别名/厂家模板，语义未验证
    L3: "L3", // 实现存在但车辆可得性未确认
    L4: "L4", // 工具与 App 都未实现
  });

  /**
   * App 侧**确实实现了数据源**的别名（P0.5 从 `app/.../data/BuiltInPids.kt`
   * 与 `DesignFile.kt` 的别名表逐条比对得出，25 个 std + 9 个 calc）。
   *
   * ⚠️ 这份表是 **P1A 的静态快照**，不是运行时探测。
   * 它回答的是「App 有没有这条通道」，**不回答**「这辆车有没有这个数据」。
   * 后者需要真车证据（见 `TIER.L3` 说明）。
   */
  const APP_IMPLEMENTED_ALIASES = new Set([
    // 标准 OBD-II（Mode 01）—— App 内置 25 条
    "obd.rpm", "obd.speed", "obd.coolant", "obd.load", "obd.intake",
    "obd.maf", "obd.stft", "obd.ltft", "obd.fuel_rate", "obd.fuelPressure",
    "obd.railPressure", "obd.o2voltage", "obd.map", "obd.fuel_level",
    "obd.ambient", "obd.oil_temp", "obd.baro", "obd.timing_advance",
    "obd.throttle", "obd.pedal_d", "obd.run_time", "obd.mil_distance",
    "obd.voltage", "obd.engineFault", "obd.odo",
    // 派生量（calc_*）—— App `VehicleBus.Derived`
    "calc.l100", "calc.fuel_hourly", "calc.boost", "calc.trip",
    "calc.gforce", "calc.gx", "calc.gy", "calc.avg_l100", "calc.range",
    // CAN 监听（App 只有转向灯左右）
    "can.turn_left", "can.turn_right",
  ]);

  /**
   * 厂家模板前缀：工具认识、App **不认**。
   * 证据：`app/.../data/BuiltInPids.kt` 里 `tpl_*` 是 `MANUFACTURER_TEMPLATES`，
   * 且 `DesignFile.kt` 的别名表**没有** `tpl_` 映射。
   */
  const TEMPLATE_PREFIX = "tpl_";

  /**
   * 覆盖层：显式声明的能力（用于未来接入真实数据源时登记）。
   * key = 别名或通道 id，value = { tier, reason }
   */
  const overrides = new Map();

  /**
   * 判定一个数据源的可用性。
   *
   * @param {string} raw 绑定值（可能是别名 `obd.tpms`，也可能是通道 id `std_05`）
   * @returns {{usable:boolean, tier:string, resolved:string, reason:string}}
   */
  function resolveDataSource(raw) {
    const name = String(raw == null ? "" : raw).trim();
    if (!name) {
      return { usable: false, tier: TIER.L4, resolved: "", reason: "未绑定数据源" };
    }

    if (overrides.has(name)) {
      const o = overrides.get(name);
      return { usable: o.tier === TIER.L1, tier: o.tier, resolved: name, reason: o.reason || "" };
    }

    // 解析别名 → 通道 id（与 schema.js 的 resolvePid 同源，但本文件不强依赖它）
    const resolver = window.resolvePid;
    const resolved = typeof resolver === "function" ? resolver(name) : name;

    const isTemplate = String(resolved).indexOf(TEMPLATE_PREFIX) === 0;

    if (isTemplate) {
      return {
        usable: false,
        tier: TIER.L2,
        resolved: resolved,
        reason: "厂家模板通道，App 未实现该数据源",
      };
    }

    // 已解析成 App 认识的标准通道？
    const aliasKnown = APP_IMPLEMENTED_ALIASES.has(name);
    const idKnown = APP_IMPLEMENTED_ALIASES.has(resolved);
    // 已经是 std_/calc_/mon_ 形态也视为 App 侧通道（DesignFile 的 id 直通路径）
    const idShaped = /^(std_[0-9A-Fa-f]+|calc_[a-z0-9_]+|mon_[a-z_]+)$/.test(resolved);

    if (aliasKnown || idKnown || idShaped) {
      return {
        usable: true,
        tier: TIER.L1,
        resolved: resolved,
        reason: "",
      };
    }

    // 别名没被解析（resolvePid 原样返回）→ 两边都没有
    return {
      usable: false,
      tier: TIER.L4,
      resolved: resolved,
      reason: "工具与 App 都未实现该数据源",
    };
  }

  const Registry = {
    TIER: TIER,

    /** 显式声明某个数据源的能力（未来接入真实数据源时用） */
    declare(raw, tier, reason) {
      if (!Object.prototype.hasOwnProperty.call(TIER, String(tier).toUpperCase())) {
        throw new Error("DataSourceRegistry.declare: 非法层级 `" + tier + "`");
      }
      overrides.set(String(raw), { tier: String(tier).toUpperCase(), reason: reason || "" });
    },

    /** 查询可用性 */
    resolve: resolveDataSource,

    /** 便捷判定 */
    isUsable(raw) {
      return resolveDataSource(raw).usable;
    },

    /** App 侧已实现的别名快照（只读） */
    implementedAliases() {
      return Array.from(APP_IMPLEMENTED_ALIASES);
    },

    /** 测试用 */
    __reset() {
      overrides.clear();
    },
  };

  window.ICAR.registry.DataSource = ICAR.register("registry", "DataSource", Registry);
  ICAR.register("core", "resolveDataSource", resolveDataSource);
  if (window.DataSourceRegistry === undefined) window.DataSourceRegistry = Registry;
})();
