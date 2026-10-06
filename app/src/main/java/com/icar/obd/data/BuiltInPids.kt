package com.icar.obd.data

/**
 * 内置 PID 库。
 *
 * 分三类：
 *  1) Mode 01 标准 OBD —— 任何车都支持，直接可用
 *  2) 派生通道（mode=CALC）—— 由其它 PID 实时算出来
 *  3) 厂家 PID 模板（mode 22）—— 标记为「未验证」，默认关闭，
 *     等你用内置扫描器在阿特兹上确认后改一下 PID 号与公式即可
 *
 * 厂家 PID 的 PID 号是猜不得的。这里只给「公式骨架 + 用法说明」，
 * 真正的 PID 号请用 PID 扫描器扫出来再填。
 */
object BuiltInPids {

    // ---- 标准 Mode 01 ----
    private fun std(
        pid: String, name: String, formula: String, unit: String,
        min: Float, max: Float, warnLow: Float? = null, warnHigh: Float? = null,
        enabled: Boolean = true, interval: Int = 0, group: String = "标准 OBD",
        note: String = ""
    ) = PidDefinition(
        id = "std_$pid", name = name, mode = "01", pid = pid, formula = formula, unit = unit,
        minVal = min, maxVal = max, warnLow = warnLow, warnHigh = warnHigh,
        enabled = enabled, builtIn = true, intervalMs = interval, group = group, note = note
    )

    /** 派生通道：mode=CALC，pid 作为 key，由 DerivedChannels 计算 */
    private fun calc(
        key: String, name: String, unit: String, min: Float, max: Float,
        warnHigh: Float? = null, group: String = "派生"
    ) = PidDefinition(
        id = key, name = name, mode = "CALC", pid = key, formula = "A", unit = unit,
        minVal = min, maxVal = max, warnHigh = warnHigh,
        enabled = true, builtIn = true, group = group, note = "由其它通道实时计算"
    )

    val STANDARD: List<PidDefinition> = listOf(
        std("0C", "发动机转速", "((A*256)+B)/4", "rpm", 0f, 8000f, warnHigh = 6500f, interval = 0,
            note = "最基础的通道，所有车都支持"),
        std("0D", "车速", "A", "km/h", 0f, 260f, warnHigh = 120f),
        std("05", "冷却液温度", "A-40", "℃", -40f, 215f, warnLow = 60f, warnHigh = 105f,
            note = "阿特兹正常工作约 85~95℃"),
        std("42", "控制模块电压", "((A*256)+B)/1000", "V", 0f, 20f, warnLow = 11.8f, warnHigh = 15.2f,
            note = "怠速约 13.5~14.5V，低于 11.8V 说明电瓶/发电机有问题"),
        std("04", "发动机负荷", "A*100/255", "%", 0f, 100f),
        std("11", "节气门开度", "A*100/255", "%", 0f, 100f),
        std("0F", "进气温度", "A-40", "℃", -40f, 215f, warnHigh = 70f),
        std("10", "空气流量 MAF", "((A*256)+B)/100", "g/s", 0f, 655f),
        std("06", "短期燃油修正 STFT", "(A-128)*100/128", "%", -100f, 100f, warnLow = -15f, warnHigh = 15f),
        std("07", "长期燃油修正 LTFT", "(A-128)*100/128", "%", -100f, 100f, warnLow = -15f, warnHigh = 15f),
        std("5E", "燃油消耗率", "((A*256)+B)*0.05", "L/h", 0f, 100f,
            note = "不是所有车都支持；不支持时可用派生通道「瞬时油耗」"),
        std("0A", "燃油压力", "A*3", "kPa", 0f, 765f,
            note = "燃油泵供油压力"),
        std("22", "燃油轨压力", "((A*256)+B)*0.079", "kPa", 0f, 5178f,
            note = "相对进气歧管的轨压"),
        std("14", "氧传感器电压", "A/200", "V", 0f, 1.275f, warnLow = 0.1f, warnHigh = 0.9f,
            note = "**只有窄域氧传感器**才用这条。马自达（ND3 实测）B1S1 是**宽域**，" +
                "`0114` 根本不在支持位图里 —— 别指望它有值"),
        std("0B", "进气歧管压力 MAP", "A", "kPa", 0f, 255f),
        std("2F", "燃油液位", "A*100/255", "%", 0f, 100f, warnLow = 15f),
        std("46", "环境温度", "A-40", "℃", -40f, 215f),
        std("5C", "机油温度", "A-40", "℃", -40f, 215f, warnHigh = 130f),
        std("33", "大气压力", "A", "kPa", 0f, 255f),
        std("0E", "点火提前角", "(A-128)/2", "°", -64f, 63f),
        std("49", "油门踏板位置 D", "A*100/255", "%", 0f, 100f),
        std("1F", "启动后运行时间", "(A*256)+B", "s", 0f, 65535f),
        std("21", "故障灯后里程", "(A*256)+B", "km", 0f, 65535f),
        // 故障灯（MIL）状态：**标准 PID，不用扫描器实测**。
        // 字节 A 的 bit7 = 故障灯亮/灭，低 7 位 = 故障码条数（见 `bits(A,0,7)`）。
        //
        // ⚠️ 它是**布尔**，不是连续量 —— 这是「非数值 PID 模型」（P9 方向 A）里
        // **不需要映射表**的那一类：`min=0, max=1, warnHigh=0.5` 就够，
        // 值 1 会走成 critical，指示灯直接亮起（用既有的三态图，零新代码）。
        std("01", "故障灯状态 MIL", "bit(A,7)", "", 0f, 1f, warnHigh = 0.5f,
            note = "0=正常 1=故障灯亮；标准 PID，不需要实测厂家地址"),
        // 总里程：**标准 PID（SAE J1979-2 的 A1~C0 段）**，不是厂家地址。
        //
        // 这一点很关键 —— 我们一直以为"总里程要厂家 Mode 22"，其实它在标准段里。
        // 一个独立验证过的马自达项目把这条读数与**真实里程表**对过
        // （drewid74/2024-nd3-mazda-obdii，原话 "drift matched real"）。
        //
        // ⚠️ 那台是 MX-5 ND3；**阿特兹是否支持 `01 A6` 要实测** ——
        // 不支持时读到 NO DATA，会按既有机制进冷却，不会出错。
        // 查支持位图请走 `01 A0`（A6 在 A1~C0 段里，`01 00` 的位图看不到它）。
        std("A6", "总里程", "((A*16777216)+(B*65536)+(C*256)+D)/10", "km", 0f, 999999f,
            note = "标准 PID；公式经第三方马自达项目与真实里程表核对。部分车不支持"),
    )

    val DERIVED: List<PidDefinition> = listOf(
        calc("calc_l100", "瞬时油耗", "L/100km", 0f, 40f, warnHigh = 15f),
        calc("calc_lh", "燃油流量", "L/h", 0f, 60f),
        calc("calc_boost", "增压压力", "kPa", -100f, 300f),
        calc("calc_km", "本次里程", "km", 0f, 9999f),
        // 平均油耗 = 累计用油 ÷ 累计里程。**不用等车、不用厂家 PID** ——
        // 油量由 `calc_lh` 对时间积分得到，里程由 `calc_km` 提供（都在本项目内）。
        calc("calc_avg_l100", "平均油耗", "L/100km", 0f, 40f, warnHigh = 15f),
        // 续航里程 = 油量% × 油箱容量 ÷ 平均油耗 × 100。
        // **只差一个"油箱容量"设置**，不需要任何厂家 PID（见 Store.Settings.tankCapacityL）。
        // 上限 1200km：满油 + 高速工况也就这个量级，再大就是配置填错了
        calc("calc_range", "续航里程", "km", 0f, 1200f),
        // G 值三兄弟：数据源是平板加速度计（首选）或车速差分（回退），
        // 由 data/GForceSource 写入 VehicleBus。见 HANDOVER「G力值」一节。
        calc("calc_gforce", "综合G值", "G", 0f, 2f),
        calc("calc_gx", "横向G值", "G", -2f, 2f),
        calc("calc_gy", "纵向G值", "G", -2f, 2f),
    )

    /**
     * 厂家 PID 模板（默认关闭）。
     * 这些是「结构示例」，PID 号必须与你的车对得上才有意义。
     * 找到真实 PID 后：复制一条 → 改 PID 号/公式 → 用编辑器测试 → 启用。
     */
    val MANUFACTURER_TEMPLATES: List<PidDefinition> = listOf(
        PidDefinition(
            id = "tpl_oilPressure", name = "示例-机油压力", protocol = "CAN", mode = "22", pid = "2400",
            formula = "((A*256)+B)*0.01", unit = "Bar", minVal = 0f, maxVal = 10f,
            warnLow = 0.8f,
            enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "机油压力不在标准 OBD 里。PID 号 2400 为占位示例，请用扫描器确认。"
        ),
        PidDefinition(
            id = "tpl_afr", name = "示例-空燃比 AFR", protocol = "CAN", mode = "22", pid = "2500",
            formula = "((A*256)+B)*0.001", unit = ":1", minVal = 10f, maxVal = 20f,
            warnLow = 11f,
            enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "宽域 AFR 不在标准 OBD 里（窄域氧传感器只能推浓/稀）。PID 号 2500 为占位示例。"
        ),
        PidDefinition(
            id = "tpl_atf", name = "示例-变速箱油温 ATF", protocol = "CAN", mode = "22", pid = "1234",
            formula = "((A*256)+B)*0.1-40", unit = "℃", minVal = -40f, maxVal = 180f,
            warnHigh = 120f, enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "PID 号 1234 为占位示例。请用 PID 扫描器在阿特兹上扫 Mode 22 找到真实 PID 后修改。"
        ),
        // ============ 转向灯：2026-10-06 实车确认 ============
        //
        // 这两个条目原本是**占位模板**（mode 22 / pid 2201/2202，全错），
        // 现在换成实测结果：CAN `0x09A` 第 3 字节（`A B C…` 里的 `C`）的 bit2 / bit3。
        //
        // ⚠️ `0x09A` 是**周期广播帧**（约 2.1~2.6 Hz），不是请求/应答的 PID ——
        // 所以 `source = "monitor"`，不进轮询；要更新它必须到「CAN 探测」页
        // **开启常驻监听**。开着的时候轮询会暂停（ELM327 半双工，`ATMA` 期间独占）。
        //
        // 证据链见 `stage/oncar-evidence/turn-signal-09A.md`：
        //   关灯 `00 00 00 00 88 00 03 00` / 左转 `00 00 04 …` / 右转 `00 00 08 …`
        PidDefinition(
            id = "mon_turn_left", name = "左转向灯", protocol = "CAN", mode = "MON", pid = "09A",
            source = "monitor", header = "09A",
            formula = "bit(C,2)", unit = "", minVal = 0f, maxVal = 1f,
            enabled = true, builtIn = true, group = "监听型(实车确认)",
            note = "实车确认：CAN 0x09A 第 3 字节 bit2。这是**广播帧**，需开启常驻监听才更新。"
        ),
        PidDefinition(
            id = "mon_turn_right", name = "右转向灯", protocol = "CAN", mode = "MON", pid = "09A",
            source = "monitor", header = "09A",
            formula = "bit(C,3)", unit = "", minVal = 0f, maxVal = 1f,
            enabled = true, builtIn = true, group = "监听型(实车确认)",
            note = "同左转向，取 bit3。双闪预计两位同时置位（0x0C）——未实测。"
        ),

        PidDefinition(
            id = "tpl_steer_angle", name = "示例-方向盘转角", protocol = "CAN", mode = "22", pid = "2300",
            formula = "signed(A)*256+B", unit = "°", minVal = -720f, maxVal = 720f,
            enabled = false, builtIn = true, group = "厂家模板(未验证)",
            note = "占位示例，需实测确认字节序与符号位。"
        ),
    )

    fun all(): List<PidDefinition> = STANDARD + DERIVED + MANUFACTURER_TEMPLATES
}
